// cockpit server — thin transport over the authoritative Engine.
//  - GET  /events           SSE stream: control snapshot, then metadata updates
//  - POST /chat/stream      SSE native chat pages from an explicit live cursor
//  - POST /intent/:name     validated intent dispatch (typed result)
//  - GET  /capabilities     bounded intent listing or one generated schema pair
//  - GET  /health
//  - GET  /status           per-session status (ops; used by graceful-restart)
//  - POST /admin/restart     arm graceful self-restart (exits when all idle)
//
// Binds 127.0.0.1 only; TLS + cookie auth are handled by the upstream reverse
// proxy (nginx). The Engine owns control state; chat remains native and is read
// through request-local adapters. This file routes intents, metadata events and
// connection-local native chat streams.

import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, OfficialRuntime, sessionMetaBusy } from '@cockpit/core';
import { Intents, ConsumerOperationId, type IntentBody, type IntentName, type IntentResult, type ServerEvent, type SessionMeta, type Snapshot } from '@cockpit/protocol';
import { isIntentName, registerCapabilities } from './capabilities.ts';
import { drainForRestart } from './shutdown.ts';
import { registerChatStream } from './chat-stream.ts';
import { deliveryIdentity } from './delivery-identity.ts';
import { createConsumerControl, type ConsumerControl } from './consumer-control.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.COCKPIT_PORT ?? 8771);

// Optional single-process web serving (no reverse proxy). The canonical Linux
// deploy fronts this with nginx serving apps/web/dist, so this stays OFF (env
// unset) — behavior is unchanged there. For a local/loopback deploy with no nginx
// (e.g. a Windows box) set COCKPIT_SERVE_WEB=1 and the server serves the built SPA
// itself, so http://127.0.0.1:<port> alone serves both the page and the API.
const SERVE_WEB = process.env.COCKPIT_SERVE_WEB === '1' || process.env.COCKPIT_SERVE_WEB === 'true';
// Built SPA dir. Defaults to apps/web/dist relative to this file (works under tsx
// from source); override with COCKPIT_WEB_DIR for a packaged layout.
const WEB_DIR = process.env.COCKPIT_WEB_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

export const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  forceCloseConnections: true,
});
registerCapabilities(app);
// The engine is constructed in boot() (guarded) so importing this module for
// unit tests (COCKPIT_NO_BOOT=1) builds the Fastify app + hooks WITHOUT reading the
// native configuration or binding the port. Definite-assignment: always set before
// any request handler that derefs them can run (boot() runs at module entry).
export type ServerEngine = Pick<Engine,
  | 'login' | 'snapshot' | 'status' | 'busyCount' | 'newSession' | 'forkSession' | 'chat' | 'stop'
  | 'prompt' | 'cancel' | 'interrupt' | 'setModel' | 'rename' | 'compact' | 'rewind' | 'setMode'
  | 'deleteSession' | 'unload' | 'load'
  | 'reload' | 'getPlan' | 'getUsage' | 'getPanels' | 'getPanel' | 'getResources' | 'respondAsk' | 'respondPlan'
  | 'planSupersede' | 'respondElicitation' | 'removeQueued' | 'refreshList'
  | 'listLive' | 'getMeta' | 'listGlobalMcp' | 'setMcpDefault'
  | 'refreshMcp' | 'reloadSessionMcp' | 'listSessionMcp' | 'toggleSessionMcp'
  | 'listGlobalSkills' | 'setGlobalSkill' | 'readSkillBody' | 'listSessionSkills' | 'toggleSessionSkill' | 'refreshSkills'
  | 'addSchedule' | 'stopSchedule' | 'listSchedules' | 'listDir'
>;
let engine: ServerEngine;
let consumerControl: ConsumerControl | undefined;

// No SDK construction, preferences, listeners, or production dependency override.
export function setTestDependencies(deps: { engine: ServerEngine; consumer?: ConsumerControl }): void {
  if (process.env.COCKPIT_NO_BOOT !== '1') throw new Error('test dependencies require COCKPIT_NO_BOOT=1');
  engine = deps.engine;
  consumerControl = deps.consumer;
}

// --- SSE fan-out -----------------------------------------------------------
const clients = new Set<FastifyReply>();
// Only the in-flight initial snapshot owns these bounded delivery frames.
const openingClients = new Map<FastifyReply, { frames: string[]; bytes: number }>();

// Per-connection SSE backpressure ceiling. Node's ServerResponse keeps buffering in
// HEAP when the peer's TCP receive window stalls (sleeping phone, backgrounded tab,
// lossy link): write() returns false but never throws, and 'close' won't fire for a
// half-open socket for minutes. That buffer is invisible to the heap watchdog (which
// only evicts *sessions*), so one stalled client can OOM the process or trip the
// watchdog into evicting healthy sessions as collateral. We bound it: once a
// connection's unflushed buffer exceeds SSE_HWM we drop the connection. Safe and
// self-healing — the client auto-reconnects (`retry: 2000`) and re-pulls a full
// control snapshot on connect. Chat cursors belong to separate browser reads.
const SSE_HWM = Number(process.env.COCKPIT_SSE_HWM ?? 8 * 1024 * 1024); // 8 MB
// Hard cap on concurrent SSE streams. Single-user, so generous; it just keeps the
// `clients` set from growing unbounded under a direct-boundary breach (no auth).
const MAX_SSE_CLIENTS = Number(process.env.COCKPIT_MAX_SSE_CLIENTS ?? 64);

// Structural shape of an SSE client (FastifyReply satisfies it via reply.raw, the
// Node ServerResponse). Kept minimal so tests can pass fakes.
type SseRaw = { writableLength: number; write(chunk: string): boolean; destroy(): void };
type SseClient = { raw: SseRaw };

// Write one frame to one connection, dropping it (delete + destroy) if it is over
// the high-water-mark or if the write throws (closed socket). Returns false when the
// client was dropped. Exported for tests.
export function sseWrite<T extends SseClient>(conns: Set<T>, reply: T, frame: string, hwm = SSE_HWM): boolean {
  const raw = reply.raw;
  if (raw.writableLength + Buffer.byteLength(frame) > hwm) {
    conns.delete(reply);
    try { raw.destroy(); } catch { /* already torn down */ }
    app.log.warn({ writableLength: raw.writableLength, hwm }, 'SSE client over high-water-mark — dropped');
    return false;
  }
  try { raw.write(frame); return true; }
  catch {
    conns.delete(reply);
    try { raw.destroy(); } catch { /* already torn down */ }
    return false;
  }
}

// Fan one frame out to every connected client, dropping slow/closed ones. Deleting
// the current element mid-iteration is safe for a Set. Exported for tests.
export function broadcastFrame<T extends SseClient>(conns: Set<T>, frame: string, hwm = SSE_HWM): void {
  for (const reply of conns) sseWrite(conns, reply, frame, hwm);
}

function sseSend(reply: FastifyReply, ev: ServerEvent): boolean {
  return sseWrite(clients, reply, `data: ${JSON.stringify(ev)}\n\n`);
}

// Graceful self-restart: an in-memory "restart pending" flag. A turn (the in-memory
// model+tool loop) can't survive a process restart — only history persists — so we
// never restart mid-turn. Instead, set the flag, and the moment the LAST running
// session goes idle we exit(0); systemd (Restart=always) brings us back. Browsers
// retain their cursors and read native history on demand. This lets an agent deploy
// without interrupting any work, including its own turn.
let restartPending = false;
let restarting = false;

app.addHook('onRequest', async (_req, reply) => {
  if (restarting) return reply.code(503).header('Retry-After', '3').send({ error: 'Cockpit is restarting' });
});

// A session blocks a graceful restart if it is BUSY: either a turn is in flight
// (status==='running') OR it is paused waiting on a user decision (ask_user / plan
// confirm / elicitation). The waiting case matters because those request events are
// EPHEMERAL — never written to events.jsonl — and the in-memory turn that issued
// them cannot survive a restart, so restarting mid-wait silently drops the question
// and the user's answer would have no live turn to resume. Both are unrecoverable,
// so we never restart while either holds.
function awaitingChoice(s: { ask?: unknown; planRequest?: unknown; elicitation?: unknown }): boolean {
  return !!(s.ask || s.planRequest || s.elicitation);
}

// A session is "busy" (blocks a graceful restart) when a turn is running, it is
// paused on a user choice, it has an in-flight `task` sub-agent, is compacting,
// OR has an MCP mutation still running/settling. This DELEGATES to the engine's shared `sessionMetaBusy` predicate
// (packages/core/src/lifecycle.ts, re-exported from @cockpit/core) so the
// transport's restart gate uses the EXACT same definition of "busy" as the
// engine's own eviction/unload/reload guards — the two can no longer drift. The
// prior local copy duplicated the four busy terms; a future edit could have
// silently dropped one (e.g. lose `compacting`/`activeSubagents`/pending-choice)
// and let the server exit(0) mid-compaction, mid-sub-agent, or mid-question.
export function sessionBusy(s: SessionMeta): boolean {
  return sessionMetaBusy(s);
}

async function busyCount(): Promise<number> {
  return engine.busyCount();
}

let gracefulExitTimer: ReturnType<typeof setTimeout> | null = null;
let nativeExitAttempt: Promise<void> | undefined;

let checkingExit: Promise<void> | undefined;
let exitDirty = false;
export function maybeGracefulExit(): void {
  if (checkingExit) { exitDirty = true; return; }
  exitDirty = false;
  checkingExit = checkGracefulExit().catch(error => {
    app.log.error({ err: error }, 'restart safety state unavailable; not restarting');
  }).finally(() => {
    checkingExit = undefined;
    if (exitDirty) maybeGracefulExit();
  });
}

async function checkGracefulExit(): Promise<void> {
  if (restarting || nativeExitAttempt) return;
  if (!restartPending) {
    if (gracefulExitTimer) clearTimeout(gracefulExitTimer);
    gracefulExitTimer = null;
    return;
  }
  const n = await busyCount();
  if (!restartPending || restarting) return;
  if (n > 0) {
    if (gracefulExitTimer) clearTimeout(gracefulExitTimer);
    gracefulExitTimer = null;
    app.log.info({ busy: n }, 'restart pending — waiting for sessions to go idle (incl. pending choices)');
    return;
  }
  if (gracefulExitTimer) return;
  app.log.info('restart pending and all sessions idle — exiting for systemd to restart');
  // Brief delay so the turn's final SSE frames flush to connected clients first.
  gracefulExitTimer = setTimeout(() => {
    gracefulExitTimer = null;
    nativeExitAttempt = (async () => {
      if (!restartPending || await busyCount() > 0) {
        maybeGracefulExit();
        return;
      }
      if (!restartPending) return;
      restarting = true;
      await drainForRestart(engine);
      for (const client of clients) client.raw.destroy();
      clients.clear();
      await app.close();
      process.exit(0);
    })().catch(error => {
      restarting = false;
      restartPending = false;
      app.log.error({ err: error }, 'graceful restart failed; service was not force-killed');
    }).finally(() => { nativeExitAttempt = undefined; });
  }, 500);
}

async function exitAfterRuntimeFailure(runtime: Engine, error: Error): Promise<void> {
  restartPending = false;
  if (gracefulExitTimer) clearTimeout(gracefulExitTimer);
  gracefulExitTimer = null;
  restarting = true;
  app.log.fatal({ err: error }, 'Copilot runtime died; exiting for supervisor recovery without replaying requests');
  try {
    await drainForRestart(runtime);
  } catch (cleanup) {
    app.log.error({ err: cleanup }, 'dead runtime cleanup failed');
  }
  for (const client of clients) client.raw.destroy();
  clients.clear();
  try {
    await app.close();
  } catch (cleanup) {
    app.log.error({ err: cleanup }, 'transport shutdown after runtime failure failed');
  }
  process.exit(1);
}

export function onEngineEvent(ev: ServerEvent): void {
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  broadcastFrame(clients, frame);
  for (const [reply, pending] of openingClients) {
    pending.bytes += Buffer.byteLength(frame);
    if (pending.bytes > SSE_HWM) {
      openingClients.delete(reply);
      reply.raw.destroy();
    } else pending.frames.push(frame);
  }
  if (ev.type === 'session/patch' || ev.type === 'session/removed' || ev.type === 'session/invalidated') {
    // Re-check the graceful-restart gate on ANY session change. The gate exits
    // only when every session is non-busy (idle, no pending choice, no in-flight
    // sub-agent/MCP operation, not compacting — see sessionBusy). Several of those busy
    // conditions clear WITHOUT a status change: a manual /compact finishing
    // (compacting:false), a background sub-agent finishing (activeSubagents:0),
    // or a busy session being removed all leave `status` untouched. A narrow
    // "running → idle" trigger would miss them and hang the restart forever, so
    // we re-check broadly — maybeGracefulExit short-circuits when no restart is
    // pending and is a cheap busyCount otherwise.
    maybeGracefulExit();
  }
}

// --- Origin / CSRF defense -------------------------------------------------
// The process has NO in-process auth: it trusts nginx's passkey gate and
// binds loopback only. That leaves a CSRF gap (dr-server-security N1): a
// cross-origin browser POST that is a CORS "simple request" (text/plain or
// bodiless — NO preflight) carries the operator's ambient cookie and reaches every
// bodiless side-effecting intent (skills/refresh, mcp/refresh, session/refresh, …)
// and /admin/*. SameSite=Lax narrows but does not fully close this; we reject it at
// the boundary instead.
//
// Rule (the standard Origin-header CSRF defense — no nginx change needed):
//   - No Origin AND no Referer → ALLOW. A forged cross-origin browser request
//     ALWAYS carries one of them; their ABSENCE means a non-browser caller (the
//     cockpit MCP / curl over loopback, server-to-server) with no ambient cookie —
//     structurally not a CSRF.
//   - Origin/Referer present → must resolve to a trusted host: the request's own
//     Host (standard same-origin check), a loopback host, or the configured/known
//     public-origin allowlist. Anything else → REJECT (403).
// Only mutating methods are gated; GET/HEAD/OPTIONS (SSE, /health,
// /status, preflight) stay open — a CSRF attacker can't read a cross-origin
// response anyway, and a preflight the no-CORS server fails already blocks the
// follow-up request.

const DEFAULT_ALLOWED_ORIGINS = ['https://cockpit.rbym47.com'];
const ALLOWED_ORIGIN_HOSTS = new Set<string>(
  [...DEFAULT_ALLOWED_ORIGINS, ...(process.env.COCKPIT_ALLOWED_ORIGINS ?? '').split(',')]
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .map(originToHost)
    .filter((h): h is string => h !== null),
);

function originToHost(value: string): string | null {
  try { return new URL(value).host.toLowerCase(); } catch { return null; }
}

function isLoopbackHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Decide whether a mutating request is same-origin / trusted. Exported for tests.
export function isAllowedOrigin(headers: {
  origin?: string | string[] | undefined;
  referer?: string | string[] | undefined;
  host?: string | string[] | undefined;
}): boolean {
  const origin = firstHeader(headers.origin);
  const referer = firstHeader(headers.referer);
  // Prefer Origin (sent on every browser state-changing request). The literal
  // "null" (sandboxed/opaque origin) is NOT trusted: it fails the URL parse below
  // and is rejected, rather than falling through to the no-origin allow path.
  const source = origin !== undefined && origin.length > 0 ? origin : referer;
  if (source === undefined || source.length === 0) return true; // non-browser caller
  const host = originToHost(source);
  if (host === null) return false; // malformed / opaque ("null") → reject
  const reqHost = firstHeader(headers.host)?.toLowerCase();
  if (reqHost && host === reqHost) return true;  // same-origin (Origin host == Host)
  if (isLoopbackHost(host)) return true;          // local dev / loopback
  return ALLOWED_ORIGIN_HOSTS.has(host);          // configured/known public origin
}

app.addHook('onRequest', async (req, reply) => {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return; // non-mutating
  if (isAllowedOrigin(req.headers)) return;
  req.log.warn({ origin: req.headers.origin, referer: req.headers.referer, url: req.url },
    'rejected cross-origin mutating request');
  reply.code(403).send({ error: 'cross-origin request rejected' });
  return reply;
});

registerChatStream(app, () => (query, signal) => engine.chat(query, signal));

app.get('/health', async (_req, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { ok: true, login: await engine.login(), instanceId: deliveryIdentity.instanceId };
});
app.get('/version', async (_req, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!deliveryIdentity.sha) return reply.code(503).send({ error: 'Source-mode process has no immutable delivery identity' });
  return deliveryIdentity;
});

// Lightweight status for ops tooling (e.g. graceful-restart): per-session status
// without opening an SSE stream. `running` counts turns in flight; `busy` also
// counts sessions paused on a pending user choice (which likewise block a restart).
app.get('/admin/lifecycle', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  const busy = await busyCount();
  const consumer = await consumerControl?.status();
  return { restartPending: restartPending || Boolean(consumer?.available && consumer.activeOperationId), busy,
    reason: busy > 0 ? 'native-busy' : null, ...(consumer ? { consumer } : {}) };
});

app.get('/status', async () => {
  const metas = await engine.status();
  const sessions = metas.map((s) => ({
    sessionId: s.sessionId, status: s.status, title: s.title,
    awaitingChoice: awaitingChoice(s) || undefined,
    activeSubagents: s.activeSubagents || undefined,
  }));
  const running = metas.filter((s) => s.status === 'running').length;
  const busy = await busyCount();
  const consumer = await consumerControl?.status();
  return { running, busy, restartPending: restartPending || Boolean(consumer?.available && consumer.activeOperationId), sessions,
    ...(consumer ? { consumer } : {}) };
});

// Graceful restart control. POST {pending:true} (default) arms the flag; if nothing
// is busy it restarts immediately, otherwise it restarts when the last turn ends AND
// no session is awaiting a user choice. POST {pending:false} disarms. Ops-only
// (loopback + nginx auth), not a typed intent.
app.post('/admin/restart', async (req, reply) => {
  if (consumerControl) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if ('pending' in body && body.pending === false) {
      const current = await consumerControl.status();
      if (restartPending || (current.available && current.activeOperationId)) {
        return reply.code(409).send({ error: 'Consumer restart cannot be cancelled here; inspect the original launcher operation' });
      }
      return { restartPending: false, authority: 'consumer', operation: null };
    }
    if (Object.keys(body).some(key => !['pending', 'operationId'].includes(key))
      || ('pending' in body && body.pending !== true)) {
      return reply.code(400).send({ error: 'Consumer restart accepts only pending:true and a stable operationId' });
    }
    const parsed = ConsumerOperationId.safeParse('operationId' in body ? body.operationId : undefined);
    if (!parsed.success) return reply.code(400).send({ error: 'Consumer lifecycle requires a stable operationId' });
    return { authority: 'consumer', operation: await consumerControl.restart(parsed.data) };
  }
  const pending = (req.body as { pending?: boolean } | null)?.pending ?? true;
  restartPending = pending;
  const n = await busyCount();
  maybeGracefulExit();
  return { restartPending: pending, busy: n, willRestartWhenIdle: pending && n > 0 };
});

app.get('/events', async (req, reply) => {
  // Connection cap: refuse a new stream past MAX_SSE_CLIENTS. Single-user makes
  // this generous, but with no in-process auth it keeps `clients` from growing
  // unbounded under a direct-boundary breach. The client treats 503 + Retry-After
  // as a transient backoff (and the cap is well above any one operator's devices).
  if (clients.size + openingClients.size >= MAX_SSE_CLIENTS) {
    reply.code(503).header('Retry-After', '5').send({ error: 'too many SSE connections' });
    return;
  }
  const pending = { frames: [] as string[], bytes: 0 };
  openingClients.set(reply, pending);
  req.raw.on('close', () => { openingClients.delete(reply); clients.delete(reply); });
  let snapshot: Snapshot;
  try { snapshot = await engine.snapshot(); }
  catch (error) { openingClients.delete(reply); throw error; }
  if (!openingClients.delete(reply) || reply.raw.destroyed) return;
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  clients.add(reply);
  req.raw.on('close', () => { clients.delete(reply); });
  if (!sseWrite(clients, reply, 'retry: 2000\n\n') || !sseSend(reply, snapshot)) return;
  for (const frame of pending.frames) if (!sseWrite(clients, reply, frame)) return;
  pending.frames.length = 0;
  // keep-alive comment ping so proxies don't time the stream out. Routed through
  // sseWrite so a stalled/zombie connection over the high-water-mark is dropped on
  // the next ping even between turns (its buffered ping bytes are the trigger).
  const ping = setInterval(() => { sseWrite(clients, reply, ': ping\n\n'); }, 25000);
  req.raw.on('close', () => { clearInterval(ping); clients.delete(reply); });
});

// --- intent dispatch -------------------------------------------------------
type IntentHandlers = {
  [K in IntentName]: (body: IntentBody<K>, signal?: AbortSignal) => IntentResult<K> | Promise<IntentResult<K>>;
};

const handlers: IntentHandlers = {
  'runtime/snapshot': async () => engine.snapshot(),
  'session/new': async (b) => ({ sessionId: await engine.newSession(b.cwd) }),
  'session/fork': (b) => engine.forkSession(b.sessionId, b.toEventId, b.name),
  'session/chat': (b, signal) => engine.chat(b, signal),
  prompt: async (b) => b.attachments === undefined
    ? engine.prompt(b.sessionId, b.text, b.mode)
    : engine.prompt(b.sessionId, b.text, b.mode, b.attachments),
  cancel: async (b) => {
    await engine.cancel(b.sessionId);
    return { ok: true };
  },
  'session/interrupt': async (b) => await engine.interrupt(b.sessionId),
  setModel: async (b) => {
    await engine.setModel(b.sessionId, b.modelId, b.reasoningEffort, b.contextTier);
    return { ok: true };
  },
  'session/rename': async (b) => ({ ok: true, title: await engine.rename(b.sessionId, b.name) }),
  'session/compact': async (b) => {
    await engine.compact(b.sessionId, b.customInstructions);
    return { ok: true };
  },
  'session/rewind': async (b) => {
    await engine.rewind(b.sessionId, b.toMsgId, b.rollbackFiles);
    return { ok: true };
  },
  setMode: async (b) => {
    await engine.setMode(b.sessionId, b.mode);
    return { ok: true };
  },
  'session/delete': async (b) => {
    await engine.deleteSession(b.sessionId, b.confirm);
    return { ok: true };
  },
  'session/purge': async (b) => {
    await engine.deleteSession(b.sessionId, b.confirm);
    return { ok: true };
  },
  'session/unload': async (b) => {
    await engine.unload(b.sessionId);
    return { ok: true };
  },
  'session/load': async (b) => {
    await engine.load(b.sessionId);
    return { ok: true, sessionId: b.sessionId };
  },
  'session/reload': async (b) => {
    await engine.reload(b.sessionId);
    return { ok: true };
  },
  'session/usage': async (b) => await engine.getUsage(b.sessionId),
  'session/plan': async (b) => await engine.getPlan(b.sessionId),
  'session/panels': async (b) => await engine.getPanels(b.sessionId),
  'session/panel': async (b) => ({ items: await engine.getPanel(b.sessionId, b.section) }),
  respondAsk: async (b) => {
    await engine.respondAsk(b.sessionId, b.requestId, b.answer, b.wasFreeform);
    return { ok: true };
  },
  respondPlan: async (b) => {
    await engine.respondPlan(b.sessionId, b.requestId, b.action);
    return { ok: true };
  },
  planSupersede: async (b) => {
    await engine.planSupersede(b.sessionId, b.requestId, b.message);
    return { ok: true };
  },
  respondElicitation: async (b) => {
    await engine.respondElicitation(b.sessionId, b.requestId, b.action);
    return { ok: true };
  },
  'queue/remove': async (b) => {
    await engine.removeQueued(b.sessionId, b.itemId);
    return { ok: true };
  },
  'session/refresh': async () => {
    await engine.refreshList();
    return { ok: true };
  },
  'session/list': async () => ({ sessions: await engine.listLive() }),
  'session/get': async (b) => ({ meta: await engine.getMeta(b.sessionId) }),
  'session/resources': async (b) => ({ meta: await engine.getResources(b.sessionId, b.resources) }),
  'mcp/global': async () => ({ servers: await engine.listGlobalMcp() }),
  'mcp/global-default': async (b) => {
    await engine.setMcpDefault(b.name, b.on);
    return { ok: true };
  },
  'mcp/refresh': async () => {
    await engine.refreshMcp();
    return { ok: true };
  },
  'mcp/reload-session': async (b) => ({
    ok: true, reconnected: (await engine.reloadSessionMcp(b.sessionId)).reconnected,
  }),
  'mcp/session': async (b) => await engine.listSessionMcp(b.sessionId),
  'mcp/session-toggle': async (b) => await engine.toggleSessionMcp(b.sessionId, b.name, b.on),
  'skills/global': async (b) => ({ skills: await engine.listGlobalSkills(b.cwd) }),
  'skills/global-toggle': async (b) => {
    await engine.setGlobalSkill(b.name, b.enabled, b.cwd);
    return { ok: true };
  },
  'skills/read': async (b) => await engine.readSkillBody(b.name, b.cwd),
  'skills/session': async (b) => ({ skills: await engine.listSessionSkills(b.sessionId) }),
  'skills/session-toggle': async (b) => {
    await engine.toggleSessionSkill(b.sessionId, b.name, b.enabled);
    return { ok: true };
  },
  'skills/refresh': async () => {
    await engine.refreshSkills();
    return { ok: true, willRestartWhenIdle: false };
  },
  'schedule/add': async ({ sessionId, ...options }) => {
    const res = await engine.addSchedule(sessionId, options);
    return { ok: !res.error, ...(res.entry ? { entry: res.entry } : {}), ...(res.error ? { error: res.error } : {}) };
  },
  'schedule/stop': async (b) => ({ ok: await engine.stopSchedule(b.sessionId, b.id) }),
  'schedule/list': async (b) => ({ entries: await engine.listSchedules(b.sessionId) }),
  'fs/listDir': async (b) => await engine.listDir(b.path),
};

class IntentBoundaryError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
  }
}

async function dispatch<K extends IntentName>(name: K, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const input = Intents[name].body.safeParse(body === undefined ? {} : body);
  if (!input.success) throw new IntentBoundaryError(input.error.message, 400, 'INVALID_INTENT_BODY');
  // Zod's indexed schema union loses the key/value correlation; the mapped
  // handlers retain it. This is the only assertion at the transport boundary.
  const result = await handlers[name](input.data as IntentBody<K>, signal);
  const output = Intents[name].result.safeParse(result);
  if (!output.success) {
    throw new IntentBoundaryError(`Invalid result for ${name}: ${output.error.message}`, 500, 'INVALID_INTENT_RESULT');
  }
  return output.data;
}

function errorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'statusCode' in error
    && typeof error.statusCode === 'number' && Number.isInteger(error.statusCode)
    && error.statusCode >= 400 && error.statusCode <= 599) return error.statusCode;
  return 500;
}

app.post('/intent/*', async (req, reply) => {
  const name = (req.params as Record<string, string>)['*'];
  if (name && ['session/history', 'session/peek', 'session/subagent-history'].includes(name)) {
    return reply.code(410).send({
      code: 'CHAT_PROTOCOL_CHANGED',
      error: 'Use session/chat with native source, direction and cursor. Message-ID pagination and server resume checkpoints have been retired.',
    });
  }
  if (name === undefined || !isIntentName(name)) { reply.code(404); return { error: `unknown intent: ${name}` }; }
  const controller = new AbortController();
  const cancel = () => { if (!reply.raw.writableFinished) controller.abort(); };
  if (name === 'session/chat') {
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.raw.on('close', cancel);
  }
  try {
    return await dispatch(name, req.body, controller.signal);
  } catch (e) {
    if (controller.signal.aborted && e === controller.signal.reason) {
      req.log.debug({ intent: name }, 'client disconnected during native read');
      reply.code(499);
      return { code: 'REQUEST_ABORTED', error: 'Client disconnected during native read.' };
    }
    req.log.error({ err: e }, `intent ${name} failed`);
    reply.code(errorStatus(e));
    return {
      error: e instanceof Error ? e.message : String(e),
      ...(e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? { code: e.code } : {}),
      ...(e && typeof e === 'object' && 'sessionId' in e && typeof e.sessionId === 'string' ? { sessionId: e.sessionId } : {}),
    };
  } finally {
    reply.raw.removeListener('close', cancel);
  }
});

async function main(runtime: Engine): Promise<void> {
  await runtime.start();
  app.log.info(`engine up (login=${await runtime.login()})`);
  await registerStaticWeb();
  await app.listen({ host: HOST, port: PORT });
  const stop = () => { restartPending = true; maybeGracefulExit(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  if (consumerControl) {
    await consumerControl.connect(() => {
      restartPending = true;
      maybeGracefulExit();
    });
  }
}

// Serve the built SPA (apps/web/dist) from this process when SERVE_WEB is on, so a
// no-reverse-proxy deploy needs no nginx. @fastify/static serves real files (the
// hashed assets); the notFound handler returns index.html for client-side routes
// (e.g. /session/:id) so deep links and refreshes work. The specific API routes
// (/events, /intent/*, /health, …) are more specific than the
// static wildcard and still win; mutating routes keep their Origin/CSRF guard. When
// SERVE_WEB is off (the Linux default) this is a no-op — no static route, no
// notFound handler — so existing behavior is untouched.
export async function registerStaticWeb(): Promise<void> {
  if (!SERVE_WEB) return;
  if (!existsSync(WEB_DIR)) {
    app.log.warn(`COCKPIT_SERVE_WEB set but web dir not found: ${WEB_DIR} (run \`pnpm --filter @cockpit/web build\`)`);
    return;
  }
  if (process.env.COCKPIT_ASSET_DIR) {
    await app.register(fastifyStatic, {
      root: [join(WEB_DIR, 'assets'), process.env.COCKPIT_ASSET_DIR],
      prefix: '/assets/', decorateReply: false,
    });
  }
  await app.register(fastifyStatic, { root: WEB_DIR, index: ['index.html'] });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!;
    const webRoute = /^\/(?:session\/[^/]+(?:\/[^/]+)?|(?:mcp|skills)(?:\/[^/]+)?)?\/?$/.test(path);
    if (req.method === 'GET' && webRoute) return reply.sendFile('index.html');
    reply.code(404).send({ error: 'not found' });
  });
  app.log.info(`serving web SPA from ${WEB_DIR}`);
}

// Boot the Engine + transport. Guarded so importing this module for unit tests
// (COCKPIT_NO_BOOT=1) builds the Fastify app + hooks WITHOUT constructing the
// Engine (which connects the native runtime) or binding the port. Production
// (`tsx src/index.ts`) runs with the env unset, so it boots normally.
function boot(): void {
  consumerControl = createConsumerControl();
  if (consumerControl && (!process.send || !process.connected)) throw new Error('Consumer startup requires its owned launcher IPC channel');
  const native = new OfficialRuntime();
  const runtime = new Engine({ runtime: native });
  runtime.log = (msg, data) => app.log.warn(data ?? {}, msg);
  engine = runtime;
  runtime.onEvent(onEngineEvent);
  runtime.onActivitySettled(maybeGracefulExit);
  runtime.onFatal(error => { void exitAfterRuntimeFailure(runtime, error); });
  main(runtime).catch((e) => { app.log.error(e); process.exit(1); });
}

if (process.env.COCKPIT_NO_BOOT !== '1') boot();
