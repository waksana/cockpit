// cockpit server — thin transport over the authoritative Engine.
//  - GET  /events           SSE stream: full snapshot on connect, then live events
//  - POST /intent/:name     validated intent dispatch (typed result)
//  - GET  /health
//  - GET  /status           per-session status (ops; used by graceful-restart)
//  - POST /admin/restart     arm graceful self-restart (exits when all idle)
//  - POST /upload            save a file to the fixed upload folder
//  - GET  /uploads/:name     serve a stored upload (path-traversal guarded)
//
// Binds 127.0.0.1 only; TLS + cookie auth are handled by the upstream reverse
// proxy (nginx). The Engine owns all state; this file just fans events to SSE
// clients and routes intents in. No domain logic here.

import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, sessionMetaBusy } from '@cockpit/core';
import { Intents, type IntentName, type ServerEvent, type SessionMeta } from '@cockpit/protocol';
import { PushManager } from './push.ts';
import { getSpeechToken } from './speech.ts';
import { saveUpload, resolveUpload, openUpload, mimeForStored } from './uploads.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.COCKPIT_PORT ?? 8771);
const UPLOAD_BODY_LIMIT = 25 * 1024 * 1024; // 25MB

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

export const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
// Raw binary parser for uploads: the browser POSTs a File as octet-stream with
// the name + mime in the query string, so req.body is the file's Buffer.
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT },
  (_req, body, done) => done(null, body));
// engine/push are constructed in boot() (guarded) so importing this module for
// unit tests (COCKPIT_NO_BOOT=1) builds the Fastify app + hooks WITHOUT reading the
// real ~/.copilot prefs or binding the port. Definite-assignment: always set before
// any request handler that derefs them can run (boot() runs at module entry).
let engine!: Engine;
let push!: PushManager;

// --- SSE fan-out -----------------------------------------------------------
const clients = new Set<FastifyReply>();

// Per-connection SSE backpressure ceiling. Node's ServerResponse keeps buffering in
// HEAP when the peer's TCP receive window stalls (sleeping phone, backgrounded tab,
// lossy link): write() returns false but never throws, and 'close' won't fire for a
// half-open socket for minutes. That buffer is invisible to the heap watchdog (which
// only evicts *sessions*), so one stalled client can OOM the process or trip the
// watchdog into evicting healthy sessions as collateral. We bound it: once a
// connection's unflushed buffer exceeds SSE_HWM we drop the connection. Safe and
// self-healing — the client auto-reconnects (`retry: 2000`) and re-pulls a full
// snapshot on connect, so there is no resume cursor to lose.
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
  if (raw.writableLength > hwm) {
    conns.delete(reply);
    try { raw.destroy(); } catch { /* already torn down */ }
    app.log.warn({ writableLength: raw.writableLength, hwm }, 'SSE client over high-water-mark — dropped');
    return false;
  }
  try { raw.write(frame); return true; }
  catch { conns.delete(reply); return false; }
}

// Fan one frame out to every connected client, dropping slow/closed ones. Deleting
// the current element mid-iteration is safe for a Set. Exported for tests.
export function broadcastFrame<T extends SseClient>(conns: Set<T>, frame: string, hwm = SSE_HWM): void {
  for (const reply of conns) sseWrite(conns, reply, frame, hwm);
}

function sseSend(reply: FastifyReply, ev: ServerEvent): void {
  sseWrite(clients, reply, `data: ${JSON.stringify(ev)}\n\n`);
}

// Graceful self-restart: an in-memory "restart pending" flag. A turn (the in-memory
// model+tool loop) can't survive a process restart — only history persists — so we
// never restart mid-turn. Instead, set the flag, and the moment the LAST running
// session goes idle we exit(0); systemd (Restart=always) brings us back, replaying
// each session's history from disk. Lets an agent deploy its own backend changes
// without interrupting any work, including its own turn.
let restartPending = false;

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

function busyCount(): number {
  return engine.snapshot().sessions.filter(sessionBusy).length;
}

let gracefulExitTimer: ReturnType<typeof setTimeout> | null = null;

function maybeGracefulExit(): void {
  if (!restartPending) {
    if (gracefulExitTimer) clearTimeout(gracefulExitTimer);
    gracefulExitTimer = null;
    return;
  }
  const n = busyCount();
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
    if (!restartPending || busyCount() > 0) {
      maybeGracefulExit();
      return;
    }
    process.exit(0);
  }, 500);
}

// SSE fan-out + notifications + restart-gate re-check on every engine event.
// Registered on the engine in boot() (not here) so importing this module for unit
// tests (COCKPIT_NO_BOOT=1) doesn't require a constructed engine.
function onEngineEvent(ev: ServerEvent): void {
  broadcastFrame(clients, `data: ${JSON.stringify(ev)}\n\n`);
  // Notifications are driven by the Engine's authoritative `session/notify` signal
  // (one source of truth for both channels — see engine.patch).
  if (ev.type === 'session/notify') {
    void push.sendAttention(ev.title, ev.sessionId, ev.attention, ev.body, engine.attentionCount());
  } else if (ev.type === 'session/patch' || ev.type === 'session/removed') {
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
// The process has NO in-process auth: it trusts nginx's basic-auth + cookie and
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
// Only mutating methods are gated; GET/HEAD/OPTIONS (SSE, /uploads, /health,
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

app.get('/health', async () => ({ ok: true, login: engine.login }));

// File upload: raw binary body (octet-stream) + ?name=&mime= query. Saved to the
// fixed upload folder (survives session deletion). Returns metadata for the client
// to render a card + build the agent guidance prompt.
app.post('/upload', { bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
  const q = req.query as { name?: string; mime?: string };
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) { reply.code(400); return { error: 'empty body' }; }
  const name = typeof q.name === 'string' ? decodeURIComponent(q.name) : 'file';
  const mime = typeof q.mime === 'string' ? decodeURIComponent(q.mime) : 'application/octet-stream';
  const r = saveUpload(body, name, mime);
  return { kind: r.kind, name: r.name, url: r.url, path: r.path, size: r.size, mime: r.mime };
});

// Serve a stored upload (path-traversal guarded). Streams through the backend.
// Security: user-uploaded content is served with `X-Content-Type-Options: nosniff`
// (no MIME sniffing) and a `Content-Security-Policy: sandbox` so that a navigated
// upload (e.g. an SVG/HTML file opened in a new tab) runs in a script-less sandbox
// — neutralizing stored-XSS in the cockpit origin. Inline <img> rendering in the
// chat is unaffected (CSP applies to documents, not image subresources).
app.get('/uploads/:name', async (req, reply) => {
  const { name } = req.params as { name: string };
  const found = resolveUpload(name);
  if (!found) { reply.code(404); return { error: 'not found' }; }
  reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  reply.type(mimeForStored(name));
  return reply.send(openUpload(found.path));
});

// Lightweight status for ops tooling (e.g. graceful-restart): per-session status
// without opening an SSE stream. `running` counts turns in flight; `busy` also
// counts sessions paused on a pending user choice (which likewise block a restart).
app.get('/status', async () => {
  const metas = engine.snapshot().sessions;
  const sessions = metas.map((s) => ({
    sessionId: s.sessionId, status: s.status, title: s.title,
    awaitingChoice: awaitingChoice(s) || undefined,
    activeSubagents: s.activeSubagents || undefined,
  }));
  const running = metas.filter((s) => s.status === 'running').length;
  const busy = metas.filter(sessionBusy).length;
  return { running, busy, restartPending, sessions };
});

// Graceful restart control. POST {pending:true} (default) arms the flag; if nothing
// is busy it restarts immediately, otherwise it restarts when the last turn ends AND
// no session is awaiting a user choice. POST {pending:false} disarms. Ops-only
// (loopback + nginx auth), not a typed intent.
app.post('/admin/restart', async (req) => {
  const pending = (req.body as { pending?: boolean } | null)?.pending ?? true;
  restartPending = pending;
  const n = busyCount();
  maybeGracefulExit();
  return { restartPending: pending, busy: n, willRestartWhenIdle: pending && n > 0 };
});

app.get('/events', (req, reply) => {
  // Connection cap: refuse a new stream past MAX_SSE_CLIENTS. Single-user makes
  // this generous, but with no in-process auth it keeps `clients` from growing
  // unbounded under a direct-boundary breach. The client treats 503 + Retry-After
  // as a transient backoff (and the cap is well above any one operator's devices).
  if (clients.size >= MAX_SSE_CLIENTS) {
    reply.code(503).header('Retry-After', '5').send({ error: 'too many SSE connections' });
    return;
  }
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write('retry: 2000\n\n');
  clients.add(reply);
  sseSend(reply, engine.snapshot());
  // keep-alive comment ping so proxies don't time the stream out. Routed through
  // sseWrite so a stalled/zombie connection over the high-water-mark is dropped on
  // the next ping even between turns (its buffered ping bytes are the trigger).
  const ping = setInterval(() => { sseWrite(clients, reply, ': ping\n\n'); }, 25000);
  req.raw.on('close', () => { clearInterval(ping); clients.delete(reply); });
});

// --- intent dispatch -------------------------------------------------------
async function dispatch(name: IntentName, body: unknown): Promise<unknown> {
  switch (name) {
    case 'session/new': {
      const b = Intents['session/new'].body.parse(body);
      return { sessionId: await engine.newSession(b.cwd, b.spawnedBy) };
    }
    case 'session/history': {
      const b = Intents['session/history'].body.parse(body);
      await engine.history(b.sessionId, b.beforeMsgId, b.limit, b.afterMsgId);
      return { ok: true };
    }
    case 'session/peek': {
      const b = Intents['session/peek'].body.parse(body);
      return await engine.peekSession(b.sessionId, b.beforeMsgId, b.limit);
    }
    case 'prompt': {
      const b = Intents.prompt.body.parse(body);
      return await engine.prompt(b.sessionId, b.text, b.mode);
    }
    case 'cancel': {
      const b = Intents.cancel.body.parse(body);
      engine.cancel(b.sessionId);
      return { ok: true };
    }
    case 'setModel': {
      const b = Intents.setModel.body.parse(body);
      await engine.setModel(b.sessionId, b.modelId, b.reasoningEffort, b.contextTier);
      return { ok: true };
    }
    case 'session/rename': {
      const b = Intents['session/rename'].body.parse(body);
      const title = await engine.rename(b.sessionId, b.name);
      return { ok: true, title };
    }
    case 'session/compact': {
      const b = Intents['session/compact'].body.parse(body);
      await engine.compact(b.sessionId, b.customInstructions);
      return { ok: true };
    }
    case 'session/rewind': {
      const b = Intents['session/rewind'].body.parse(body);
      await engine.rewind(b.sessionId, b.toMsgId, b.rollbackFiles);
      return { ok: true };
    }
    case 'setMode': {
      const b = Intents.setMode.body.parse(body);
      await engine.setMode(b.sessionId, b.mode);
      return { ok: true };
    }
    case 'session/delete': {
      const b = Intents['session/delete'].body.parse(body);
      await engine.deleteSession(b.sessionId, b.reason);
      return { ok: true };
    }
    case 'session/restore': {
      const b = Intents['session/restore'].body.parse(body);
      return { ok: await engine.restoreSession(b.sessionId) };
    }
    case 'session/trash-list': {
      return { entries: await engine.listTrash() };
    }
    case 'session/purge': {
      const b = Intents['session/purge'].body.parse(body);
      await engine.purgeSession(b.sessionId);
      return { ok: true };
    }
    case 'session/unload': {
      const b = Intents['session/unload'].body.parse(body);
      engine.unload(b.sessionId);
      return { ok: true };
    }
    case 'session/reload': {
      const b = Intents['session/reload'].body.parse(body);
      await engine.reload(b.sessionId);
      return { ok: true };
    }
    case 'session/pin': {
      const b = Intents['session/pin'].body.parse(body);
      const pinned = await engine.pin(b.sessionId, b.pinned);
      return { ok: true, pinned };
    }
    case 'session/set-spawned-by': {
      const b = Intents['session/set-spawned-by'].body.parse(body);
      const spawnedBy = await engine.setSpawnedBy(b.sessionId, b.spawnedBy);
      return { ok: true, spawnedBy };
    }
    case 'session/plan': {
      const b = Intents['session/plan'].body.parse(body);
      return engine.getPlan(b.sessionId);
    }
    case 'session/panels': {
      const b = Intents['session/panels'].body.parse(body);
      return engine.getPanels(b.sessionId);
    }
    case 'respondAsk': {
      const b = Intents.respondAsk.body.parse(body);
      engine.respondAsk(b.sessionId, b.requestId, b.answer, b.wasFreeform);
      return { ok: true };
    }
    case 'respondPlan': {
      const b = Intents.respondPlan.body.parse(body);
      engine.respondPlan(b.sessionId, b.requestId, b.action);
      return { ok: true };
    }
    case 'planSupersede': {
      const b = Intents.planSupersede.body.parse(body);
      await engine.planSupersede(b.sessionId, b.requestId, b.message);
      return { ok: true };
    }
    case 'respondElicitation': {
      const b = Intents.respondElicitation.body.parse(body);
      engine.respondElicitation(b.sessionId, b.requestId, b.action);
      return { ok: true };
    }
    case 'queue/remove': {
      const b = Intents['queue/remove'].body.parse(body);
      engine.removeQueued(b.sessionId, b.itemId);
      return { ok: true };
    }
    case 'session/refresh': {
      await engine.refreshList();
      return { ok: true };
    }
    case 'session/list': {
      return { sessions: engine.listLive() };
    }
    case 'session/get': {
      const b = Intents['session/get'].body.parse(body);
      return { meta: engine.getMeta(b.sessionId) };
    }
    case 'push/subscribe': {
      const b = Intents['push/subscribe'].body.parse(body);
      push.subscribe(b.subscription);
      return { ok: true };
    }
    case 'inbox/seen': {
      const b = Intents['inbox/seen'].body.parse(body);
      engine.markSeen(b.sessionId);
      return { ok: true };
    }
    case 'speech/token': {
      // Server-level (not engine): exchange the Azure key for a 10-min token so
      // the browser can dictate without ever holding the key. Self-disables when
      // unconfigured → client falls back to the Web Speech API.
      return await getSpeechToken();
    }
    case 'mcp/global': {
      return { servers: engine.listGlobalMcp() };
    }
    case 'mcp/global-default': {
      const b = Intents['mcp/global-default'].body.parse(body);
      engine.setMcpDefault(b.name, b.on);
      return { ok: true };
    }
    case 'mcp/refresh': {
      await engine.refreshMcp();
      return { ok: true };
    }
    case 'mcp/reload-session': {
      const b = Intents['mcp/reload-session'].body.parse(body);
      const r = await engine.reloadSessionMcp(b.sessionId);
      return { ok: true, reconnected: r.reconnected };
    }
    case 'mcp/session': {
      const b = Intents['mcp/session'].body.parse(body);
      return await engine.listSessionMcp(b.sessionId);
    }
    case 'mcp/session-toggle': {
      const b = Intents['mcp/session-toggle'].body.parse(body);
      return await engine.toggleSessionMcp(b.sessionId, b.name, b.on);
    }
    case 'skills/global': {
      return { skills: await engine.listGlobalSkills() };
    }
    case 'skills/read': {
      const b = Intents['skills/read'].body.parse(body);
      return await engine.readSkillBody(b.name);
    }
    case 'skills/session': {
      const b = Intents['skills/session'].body.parse(body);
      return { skills: await engine.listSessionSkills(b.sessionId) };
    }
    case 'skills/session-toggle': {
      const b = Intents['skills/session-toggle'].body.parse(body);
      await engine.toggleSessionSkill(b.sessionId, b.name, b.enabled);
      return { ok: true };
    }
    case 'skills/refresh': {
      // The SDK caches the skill directory scan in a module-level memo with no
      // public invalidation API, so picking up on-disk skill changes requires a
      // fresh process. Arm the graceful self-restart (exits when all sessions are
      // idle; systemd restarts us with a clean scan).
      restartPending = true;
      const willRestartWhenIdle = busyCount() > 0;
      maybeGracefulExit();
      return { ok: true, willRestartWhenIdle };
    }
    case 'schedule/add': {
      const b = Intents['schedule/add'].body.parse(body);
      const res = await engine.addSchedule(b.sessionId, {
        prompt: b.prompt,
        ...(b.interval !== undefined ? { interval: b.interval } : {}),
        ...(b.cron !== undefined ? { cron: b.cron } : {}),
        ...(b.at !== undefined ? { at: b.at } : {}),
        ...(b.recurring !== undefined ? { recurring: b.recurring } : {}),
        ...(b.tz !== undefined ? { tz: b.tz } : {}),
        ...(b.displayPrompt !== undefined ? { displayPrompt: b.displayPrompt } : {}),
      });
      return { ok: !res.error, ...(res.entry ? { entry: res.entry } : {}), ...(res.error ? { error: res.error } : {}) };
    }
    case 'schedule/stop': {
      const b = Intents['schedule/stop'].body.parse(body);
      return { ok: await engine.stopSchedule(b.sessionId, b.id) };
    }
    case 'schedule/list': {
      const b = Intents['schedule/list'].body.parse(body);
      return { entries: await engine.listSchedules(b.sessionId) };
    }
    case 'hook/add': {
      const b = Intents['hook/add'].body.parse(body);
      return engine.addHook({
        ownerSession: b.ownerSession,
        event: b.event,
        ...(b.filter ? { filter: b.filter } : {}),
        ...(b.flowId !== undefined ? { flowId: b.flowId } : {}),
        ...(b.promptTemplate !== undefined ? { promptTemplate: b.promptTemplate } : {}),
        ...(b.once !== undefined ? { once: b.once } : {}),
      });
    }
    case 'hook/stop': {
      const b = Intents['hook/stop'].body.parse(body);
      return { ok: engine.stopHook(b.id) };
    }
    case 'hook/list': {
      const b = Intents['hook/list'].body.parse(body);
      return { entries: engine.listHooks(b.ownerSession) };
    }
    case 'flow/list': {
      return { flows: engine.listFlows() };
    }
    case 'flow/add': {
      const b = Intents['flow/add'].body.parse(body);
      return engine.addFlow(b);
    }
    case 'flow/remove': {
      const b = Intents['flow/remove'].body.parse(body);
      return engine.removeFlow(b.id);
    }
    case 'flow/write-gate': {
      const b = Intents['flow/write-gate'].body.parse(body);
      return engine.writeGate(b.name, b.script);
    }
    case 'flow/run': {
      const b = Intents['flow/run'].body.parse(body);
      return engine.runFlow(b.flowId, b.ctx ?? null);
    }
    case 'flow-schedule/add': {
      const b = Intents['flow-schedule/add'].body.parse(body);
      return engine.addFlowSchedule({
        ...(b.flowId !== undefined ? { flowId: b.flowId } : {}),
        ...(b.target !== undefined ? { target: b.target } : {}),
        ...(b.interval !== undefined ? { interval: b.interval } : {}),
        ...(b.cron !== undefined ? { cron: b.cron } : {}),
        ...(b.at !== undefined ? { at: b.at } : {}),
        ...(b.recurring !== undefined ? { recurring: b.recurring } : {}),
        ...(b.tz !== undefined ? { tz: b.tz } : {}),
        ...(b.label !== undefined ? { label: b.label } : {}),
      });
    }
    case 'flow-schedule/stop': {
      const b = Intents['flow-schedule/stop'].body.parse(body);
      return { ok: engine.stopFlowSchedule(b.id) };
    }
    case 'flow-schedule/list': {
      return { entries: engine.listFlowSchedules() };
    }
    case 'fs/listDir': {
      const b = Intents['fs/listDir'].body.parse(body);
      return engine.listDir(b.path);
    }
    default: {
      const _exhaustive: never = name;
      throw new Error(`unknown intent: ${String(_exhaustive)}`);
    }
  }
}

app.post('/intent/*', async (req, reply) => {
  const name = (req.params as Record<string, string>)['*'] as IntentName;
  if (!Object.hasOwn(Intents, name)) { reply.code(404); return { error: `unknown intent: ${name}` }; }
  try {
    return await dispatch(name, req.body);
  } catch (e) {
    req.log.error({ err: e }, `intent ${name} failed`);
    reply.code(400);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

async function main(): Promise<void> {
  engine.vapidPublicKey = push.publicKey;
  await engine.start();
  app.log.info(`engine up (login=${engine.login}, push=${push.publicKey ? 'on' : 'off'})`);
  await registerStaticWeb();
  await app.listen({ host: HOST, port: PORT });
}

// Serve the built SPA (apps/web/dist) from this process when SERVE_WEB is on, so a
// no-reverse-proxy deploy needs no nginx. @fastify/static serves real files (the
// hashed assets); the notFound handler returns index.html for client-side routes
// (e.g. /session/:id) so deep links and refreshes work. The specific API routes
// (/events, /intent/*, /uploads/:name, /health, …) are more specific than the
// static wildcard and still win; mutating routes keep their Origin/CSRF guard. When
// SERVE_WEB is off (the Linux default) this is a no-op — no static route, no
// notFound handler — so existing behavior is untouched.
async function registerStaticWeb(): Promise<void> {
  if (!SERVE_WEB) return;
  if (!existsSync(WEB_DIR)) {
    app.log.warn(`COCKPIT_SERVE_WEB set but web dir not found: ${WEB_DIR} (run \`pnpm --filter @cockpit/web build\`)`);
    return;
  }
  await app.register(fastifyStatic, { root: WEB_DIR, index: ['index.html'] });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET') return reply.sendFile('index.html'); // SPA deep-link fallback
    reply.code(404).send({ error: 'not found' });
  });
  app.log.info(`serving web SPA from ${WEB_DIR}`);
}

// Boot the Engine + transport. Guarded so importing this module for unit tests
// (COCKPIT_NO_BOOT=1) builds the Fastify app + hooks WITHOUT constructing the
// Engine (which reads the real ~/.copilot prefs) or binding the port. Production
// (`tsx src/index.ts`) runs with the env unset, so it boots normally.
function boot(): void {
  engine = new Engine();
  engine.log = (msg, data) => app.log.warn(data ?? {}, msg);
  push = new PushManager();
  engine.onEvent(onEngineEvent);
  main().catch((e) => { app.log.error(e); process.exit(1); });
}

if (process.env.COCKPIT_NO_BOOT !== '1') boot();
