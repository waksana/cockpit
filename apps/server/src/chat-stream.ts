import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { NativeChatStreamRequest, type NativeChatRead, type NativeChatPage, type NativeChatStreamEvent } from '@cockpit/protocol';

type ChatRead = (query: NativeChatRead, signal?: AbortSignal) => Promise<NativeChatPage>;
type StreamRaw = Pick<ServerResponse, 'write' | 'once' | 'off' | 'destroy' | 'destroyed' | 'writableEnded'>;
const CHUNK_CHARACTERS = 16 * 1024;
const DRAIN_TIMEOUT_MS = 15_000;
const MAX_STREAMS = 64;

function waitForDrain(raw: StreamRaw, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      raw.off('drain', drained);
      raw.off('close', closed);
      raw.off('error', failed);
      signal.removeEventListener('abort', closed);
    };
    const drained = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => failed(new Error('Chat stream closed'));
    const timer = setTimeout(() => {
      failed(new Error('Chat stream consumer stalled'));
      raw.destroy();
    }, timeoutMs);
    timer.unref();
    raw.once('drain', drained);
    raw.once('close', closed);
    raw.once('error', failed);
    signal.addEventListener('abort', closed, { once: true });
    if (signal.aborted || raw.destroyed || raw.writableEnded) closed();
  });
}

// One transient serialization, not a replay buffer. Chunking permits large native
// messages while bounding the bytes queued in Node before waiting for the peer.
export async function writeChatStreamFrame(
  raw: StreamRaw, frame: string, signal: AbortSignal, timeoutMs = DRAIN_TIMEOUT_MS,
): Promise<void> {
  try {
    for (let offset = 0; offset < frame.length;) {
      signal.throwIfAborted();
      if (raw.destroyed || raw.writableEnded) throw new Error('Chat stream closed');
      let end = Math.min(offset + CHUNK_CHARACTERS, frame.length);
      const last = frame.charCodeAt(end - 1);
      if (end < frame.length && last >= 0xd800 && last <= 0xdbff) end--;
      const writable = raw.write(frame.slice(offset, end));
      offset = end;
      if (!writable) await waitForDrain(raw, signal, timeoutMs);
    }
  } catch (error) {
    raw.destroy();
    throw error;
  }
}

function errorFrame(error: unknown): NativeChatStreamEvent {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
  return {
    type: 'error', error: error instanceof Error ? error.message : String(error),
    ...(code === undefined ? {} : { code }),
  };
}

export function registerChatStream(
  app: FastifyInstance,
  getRead: () => ChatRead,
  options: { maxStreams?: number; drainTimeoutMs?: number } = {},
): void {
  const streams = new Map<AbortController, ServerResponse>();
  let closing = false;
  const closeStreams = async () => {
    closing = true;
    for (const [controller, raw] of streams) {
      controller.abort();
      raw.destroy();
    }
  };
  // preClose also works when the app does not force-close HTTP connections.
  app.addHook('preClose', closeStreams);
  app.addHook('onClose', closeStreams);

  app.post('/chat/stream', async (request, reply) => {
    const parsed = NativeChatStreamRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid native chat stream request', issues: parsed.error.issues });
    if (closing || streams.size >= (options.maxStreams ?? MAX_STREAMS)) {
      return reply.code(503).header('Retry-After', '5').send({ error: 'too many chat streams' });
    }
    const controller = new AbortController();
    const { signal } = controller;
    const raw = reply.raw;
    const abort = () => controller.abort();
    streams.set(controller, raw);
    raw.once('close', abort);
    raw.once('error', abort);
    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.flushHeaders();
    const send = (event: NativeChatStreamEvent) =>
      writeChatStreamFrame(raw, `data: ${JSON.stringify(event)}\n\n`, signal, options.drainTimeoutMs);
    let first = true;
    let catchingUp = true;
    let cursor = parsed.data.cursor;
    try {
      while (!signal.aborted) {
        const page = await getRead()({
          ...parsed.data,
          source: 'live', direction: 'forward', bootstrap: false,
          cursor: cursor || undefined,
          includeEphemeral: !catchingUp, waitMs: catchingUp ? 0 : 30_000,
        }, signal);
        // The native RPC can finish after disconnect; it must not trigger another
        // read, serialization, or write once this connection has been cancelled.
        if (signal.aborted) break;
        if (first || page.cursorStatus === 'expired' || page.cursor !== cursor || page.events.length) {
          await send({ type: 'page', page });
        } else {
          await writeChatStreamFrame(raw, ': keepalive\n\n', signal, options.drainTimeoutMs);
        }
        if (page.cursorStatus === 'expired') break;
        cursor = page.cursor;
        first = false;
        if (!page.hasMore) catchingUp = false;
      }
    } catch (error) {
      if (!signal.aborted && !raw.destroyed && !raw.writableEnded) {
        try { await send(errorFrame(error)); }
        catch { raw.destroy(); }
      }
    } finally {
      controller.abort();
      streams.delete(controller);
      raw.off('close', abort);
      raw.off('error', abort);
      if (!raw.destroyed && !raw.writableEnded) raw.end();
    }
  });
}
