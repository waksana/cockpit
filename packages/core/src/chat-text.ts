import { createHash } from 'node:crypto';
import {
  ChatTextRead, ChatTextPosition, type ChatTextMessage, type ChatTextPage,
  NativeChatRead, type NativeChatEvent, type NativeChatPage,
} from '@cockpit/protocol';
import { conflict, invalid } from './errors.ts';

const PAGE_EVENTS = 16;
type Anchor = { id: string; version: string };
type Checkpoint = Extract<ChatTextPosition, { kind: 'checkpoint' }>;
type Position = Extract<ChatTextPosition, { kind: 'page' }>;

function identity(query: ChatTextRead, format = 2): string {
  return createHash('sha256').update(JSON.stringify([
    `text-v${format}-primary`, query.sessionId, query.source, query.direction, query.since,
  ])).digest('hex');
}

function encode(position: Position | Checkpoint): string {
  if (position.kind === 'page' && (position.native?.length ?? 0) > 16384) {
    throw conflict('TEXT_CURSOR_TOO_LARGE: unsupported native cursor size.');
  }
  const body = Buffer.from(JSON.stringify(position)).toString('base64url');
  return `ct2.${body}`;
}

function decode(cursor: string, query: ChatTextRead): Position | Checkpoint {
  const legacy = !cursor.startsWith('ct2.');
  const [legacyBody, legacySignature, extra] = cursor.split('.');
  if (legacy && (!legacyBody || !legacySignature || extra || !/^[A-Za-z0-9_-]{43}$/.test(legacySignature))) {
    throw invalid('TEXT_POSITION_FORMAT: unsupported position format. No read was performed.');
  }
  const body = legacy ? legacyBody! : cursor.slice(4);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw invalid('TEXT_CURSOR_INVALID: malformed position encoding.');
  const decoded = Buffer.from(body, 'base64url');
  if (decoded.toString('base64url') !== body) throw invalid('TEXT_CURSOR_INVALID: noncanonical position encoding.');
  let json: unknown;
  try { json = JSON.parse(decoded.toString('utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw invalid('TEXT_CURSOR_INVALID: malformed position JSON.');
  }
  // Legacy signatures cannot survive their original host. Import their payload
  // only as caller-owned coordinates, under the same native validation as v2.
  if (legacy && json && typeof json === 'object' && !Array.isArray(json) && !('format' in json)) {
    json = { ...json, format: 2 };
  }
  const parsed = ChatTextPosition.safeParse(json);
  if (!parsed.success) throw invalid('TEXT_CURSOR_INVALID: invalid or incompatible position schema.');
  const position = parsed.data;
  if (position.query !== identity(query, legacy ? 1 : 2)) {
    throw invalid('Text cursor belongs to another session/source/direction/view.');
  }
  return { ...position, query: identity(query) };
}

function anchor(event: NativeChatEvent): Anchor {
  if (event.id.length > 256) throw conflict('TEXT_METADATA_TOO_LARGE: native event ID exceeds checkpoint bound.');
  return { id: event.id, version: createHash('sha256').update(JSON.stringify(event)).digest('hex') };
}

function version(page: NativeChatPage): string {
  return createHash('sha256').update(JSON.stringify([page.events, page.cursor, page.hasMore])).digest('hex');
}

function metadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
}

function message(event: NativeChatEvent): ChatTextMessage | undefined {
  if (event.ephemeral || event.agentId || event.parentToolCallId || event.data.agentId || event.data.parentToolCallId
    || !['user.message', 'assistant.message'].includes(event.type)) return;
  const data = event.data;
  if (typeof data.content !== 'string' || !data.content.trim()) return;
  const messageId = typeof data.messageId === 'string' ? data.messageId : undefined;
  if (event.id.length > 256 || (messageId?.length ?? 0) > 256
    || (typeof event.timestamp === 'string' && event.timestamp.length > 128)) {
    throw conflict('TEXT_METADATA_TOO_LARGE: native identity cannot be represented safely; use the raw event reader.');
  }
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  return {
    eventId: event.id, ...(messageId !== undefined ? { messageId } : {}),
    role: event.type === 'user.message' ? 'user' : 'assistant',
    ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
    content: data.content, offset: 0, nextOffset: null, totalCharacters: data.content.length,
    attachments: attachments.slice(0, 4).map((item: unknown) => {
      const record = item && typeof item === 'object' ? item : {};
      const safe: ChatTextMessage['attachments'][number] = { omittedFields: false };
      for (const field of ['type', 'displayName', 'path', 'mimeType'] as const) {
        if (field in record) {
          const value = metadata(Reflect.get(record, field));
          if (value !== undefined) safe[field] = value;
          else safe.omittedFields = true;
        }
      }
      if (Object.keys(record).some(field => !['type', 'displayName', 'path', 'mimeType'].includes(field))) {
        safe.omittedFields = true;
      }
      return safe;
    }),
    omittedAttachments: Math.max(0, attachments.length - 4),
  };
}

function bytes(page: ChatTextPage): number {
  return Buffer.byteLength(JSON.stringify(page), 'utf8');
}

function boundary(text: string, end: number): number {
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}

export async function readChatText(
  input: ChatTextRead,
  read: (query: NativeChatRead) => Promise<NativeChatPage>,
): Promise<ChatTextPage> {
  const query = ChatTextRead.parse(input);
  const saved = query.cursor ? decode(query.cursor, query) : undefined;
  if (saved?.kind === 'checkpoint') throw invalid('Use checkpoint as since, not cursor.');
  const since = query.since ? decode(query.since, { ...query, since: undefined }) : undefined;
  if (since?.kind === 'page') throw invalid('Use a returned checkpoint as since, not a page cursor.');
  let position: Position = saved
    ?? { format: 2, kind: 'page', query: identity(query), index: 0, offset: 0, ...(since ? { until: since.anchor } : {}) };
  if (saved && JSON.stringify(saved.until) !== JSON.stringify(since?.anchor)) {
    throw invalid('TEXT_CURSOR_INVALID: page boundary differs from since.');
  }
  const result: ChatTextPage = {
    sessionId: query.sessionId, source: query.source, direction: query.direction, view: 'text',
    order: query.direction === 'backward' ? 'newest-first' : 'oldest-first',
    messages: [], cursor: '', hasMore: false, scanLimited: false, read: { rpc: 0, pages: 0, events: 0 },
  };
  for (let count = 0; count < query.scanPages; count++) {
    const page = await read(NativeChatRead.parse({
      sessionId: query.sessionId, source: query.source, direction: query.direction,
      cursor: position.native || undefined, max: PAGE_EVENTS,
      bootstrap: query.bootstrap && count === 0,
      ...(query.source === 'live' ? {
        types: ['user.message', 'assistant.message'], agentScope: 'primary', includeEphemeral: false,
      } : {}),
    }));
    result.read.rpc += page.read.rpc;
    result.read.pages++;
    result.read.events += page.read.events;
    if (page.cursorStatus !== 'ok') {
      throw conflict('TEXT_CURSOR_EXPIRED: native cursor expired. For an incremental range, explicitly repeat the original since without cursor and deduplicate eventId/offset fragments; do not advance since. No fallback was read.');
    }
    const fingerprint = version(page);
    if (position.version && position.version !== fingerprint) {
      throw conflict('TEXT_PAGE_CHANGED: partial native page changed. Explicitly repeat the original since without cursor and deduplicate eventId/offset fragments; do not advance since. For an initial historical read, explicitly reselect the range. No fallback was read.');
    }
    if (page.liveCursor !== undefined) {
      result.liveCursor = encode({
        format: 2, kind: 'page', query: identity({ ...query, direction: 'forward' }), native: page.liveCursor, index: 0, offset: 0,
      });
    }
    const events = query.direction === 'backward' ? [...page.events].reverse() : page.events;
    if (position.index > events.length) throw invalid('TEXT_CURSOR_INVALID: index exceeds the native page.');
    if (position.offset) {
      const target = events[position.index];
      const item = target && message(target);
      if (!item || position.offset >= item.content.length || boundary(item.content, position.offset) !== position.offset) {
        throw invalid('TEXT_CURSOR_INVALID: offset is outside the native body or divides a surrogate pair.');
      }
    }
    if (query.direction === 'backward' && position.head === undefined) {
      position.head = events[0] ? anchor(events[0]) : null;
    }
    const pageEnd: Position = { ...position, native: page.cursor, version: undefined, index: 0, offset: 0 };
    const pageEndCursor = encode(pageEnd);
    for (let index = position.index; index < events.length; index++) {
      if (position.until && events[index]!.id === position.until.id) {
        if (anchor(events[index]!).version !== position.until.version) {
          throw conflict('TEXT_CHECKPOINT_CHANGED: checkpoint event changed; explicitly resynchronize.');
        }
        result.cursor = encode({ ...position, version: fingerprint, index, offset: 0 });
        result.hasMore = false;
        return complete(result, query, position);
      }
      const item = message(events[index]!);
      if (!item) continue;
      const offset = index === position.index ? position.offset : 0;
      const remaining: Position = { ...position, version: fingerprint, index, offset };
      result.cursor = encode(remaining);
      result.hasMore = true;
      if (result.messages.length === query.max) return finish(result, query);
      // Measure the complete returned JSON, including the cursor and escaped text.
      const fragment = (end: number) => ({
        ...item, content: item.content.slice(offset, end), offset,
        nextOffset: end < item.content.length ? end : null,
      });
      const continuation = (end: number): Position => end < item.content.length
        ? { ...remaining, offset: end }
        : { ...remaining, index: index + 1, offset: 0 };
      let low = offset;
      let high = Math.min(item.content.length, offset + query.maxBytes);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const end = boundary(item.content, mid);
        const partialCursor = encode(continuation(end));
        const candidate = {
          ...result, cursor: partialCursor.length >= pageEndCursor.length ? partialCursor : pageEndCursor,
          messages: [...result.messages, fragment(end)],
          ...(query.direction === 'backward' ? { checkpoint: checkpoint(query, position) } : {}),
        };
        if (bytes(candidate) <= query.maxBytes - 64) low = mid;
        else high = mid - 1;
      }
      const end = boundary(item.content, low);
      if (end <= offset) {
        if (result.messages.length) return finish(result, query);
        throw invalid('TEXT_BUDGET_TOO_SMALL: cursor and metadata exceed maxBytes; increase maxBytes or use the raw event reader.');
      }
      result.messages.push(fragment(end));
      result.cursor = encode(continuation(end));
      if (end < item.content.length) return finish(result, query);
    }
    position = pageEnd;
    result.cursor = pageEndCursor;
    result.hasMore = page.hasMore;
    if (!page.hasMore && position.until) {
      throw conflict('TEXT_CHECKPOINT_MISSING: checkpoint was not found before history ended; explicitly resynchronize.');
    }
    if (!page.hasMore || result.messages.length === query.max) {
      return !query.since || !page.hasMore ? complete(result, query, position) : finish(result, query);
    }
  }
  result.scanLimited = true;
  return query.since ? finish(result, query) : complete(result, query, position);
}

function complete(result: ChatTextPage, query: ChatTextRead, position: Position): ChatTextPage {
  if (query.direction === 'backward') {
    result.checkpoint = checkpoint(query, position);
  }
  return finish(result, query);
}

function checkpoint(query: ChatTextRead, position: Position): string {
  return encode({
    format: 2, kind: 'checkpoint', query: identity({ ...query, since: undefined }), anchor: position.head ?? null,
  });
}

function finish(result: ChatTextPage, query: ChatTextRead): ChatTextPage {
  if (bytes(result) > query.maxBytes || result.cursor.length > 32768 || (result.liveCursor?.length ?? 0) > 32768) {
    throw invalid('TEXT_BUDGET_TOO_SMALL: native cursor exceeds maxBytes; increase maxBytes or use the raw event reader.');
  }
  return result;
}
