// cockpit server — thin transport over the authoritative Engine.
//  - GET  /events           SSE stream: control snapshot, then metadata updates
//  - POST /chat/stream      SSE native chat pages from an explicit live cursor
//  - POST /intent/:name     validated intent dispatch (typed result)
//  - GET  /capabilities     bounded intent listing or one generated schema pair
//  - GET  /health
//  - GET  /status           native activity and graceful shutdown state
//  - POST /intent/system/shutdown  request graceful exit, never self-restart
//
// Binds 127.0.0.1 only; TLS + cookie auth are handled by the upstream reverse
// proxy (nginx). The Engine owns control state; chat remains native and is read
// through request-local adapters. This file routes intents, metadata events and
// connection-local native chat streams.

import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, OfficialRuntime } from '@cockpit/core';
import { Intents, type IntentBody, type IntentName, type IntentResult, type ServerEvent, type Snapshot } from '@cockpit/protocol';
import { isIntentName, registerCapabilities } from './capabilities.ts';
import { GracefulShutdown } from './shutdown.ts';
import { registerChatStream } from './chat-stream.ts';
import { serviceIdentity } from './identity.ts';
import { ModuleHost } from './module-host.ts';
import { guardModuleHostStartup, type ModuleStartupGuard } from './module-lifetime.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.COCKPIT_PORT ?? 8771);

const SERVE_WEB = process.env.COCKPIT_SERVE_WEB !== '0' && process.env.COCKPIT_SERVE_WEB !== 'false';
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
  | 'prompt' | 'cancel' | 'interrupt' | 'control' | 'setModel' | 'rename' | 'compact' | 'rewind' | 'setMode'
  | 'deleteSession' | 'unload' | 'load'
  | 'reload' | 'initializeSessionTools' | 'prepareSessionResources' | 'getPlan' | 'getUsage' | 'getPanels' | 'getPanel' | 'getResources' | 'respondAsk' | 'respondPlan'
  | 'planSupersede' | 'respondElicitation' | 'removeQueued' | 'refreshList'
  | 'listLive' | 'getMeta' | 'listGlobalMcp' | 'setMcpDefault'
  | 'refreshMcp' | 'reloadSessionMcp' | 'listSessionMcp' | 'toggleSessionMcp'
  | 'listGlobalSkills' | 'setGlobalSkill' | 'readSkillBody' | 'listSessionSkills' | 'toggleSessionSkill' | 'refreshSkills'
  | 'addSchedule' | 'stopSchedule' | 'listSchedules' | 'listDir'
  | 'listRoles' | 'roleReadiness' | 'addRoles'
>;
let engine: ServerEngine;
let moduleHost: ModuleHost | undefined;
let moduleStartupGuard: ModuleStartupGuard | undefined;

// No SDK construction, preferences, listeners, or production dependency override.
export function setTestDependencies(deps: { engine: ServerEngine; shutdown?: GracefulShutdown }): void {
  if (process.env.COCKPIT_NO_BOOT !== '1') throw new Error('test dependencies require COCKPIT_NO_BOOT=1');
  shutdown.dispose();
  engine = deps.engine;
  shutdown = deps.shutdown ?? createShutdown();
}

// --- SSE fan-out -----------------------------------------------------------
const clients = new Set<FastifyReply>();
// Only the in-flight initial snapshot owns these bounded delivery frames.
const openingClients = new Map<FastifyReply, { frames: string[]; bytes: number }>();

// Bound each viewer's queued control frames; a stalled browser must not retain
// unbounded heap. Chat cursors belong to separate browser-owned reads.
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

async function closeTransport(): Promise<void> {
  moduleHost?.close();
  for (const client of clients) client.raw.destroy();
  clients.clear();
  for (const reply of openingClients.keys()) reply.raw.destroy();
  openingClients.clear();
  await app.close();
}

function createShutdown(): GracefulShutdown {
  return new GracefulShutdown({
    busyCount: () => engine.busyCount(),
    stopNative: () => engine.stop(),
    closeTransport,
    exit: code => {
      if (process.env.COCKPIT_NO_BOOT === '1') throw new Error(`A test app must inject its shutdown exit (${code})`);
      process.exit(code);
    },
    report: (err, stage) => app.log.error({ err }, `${stage} did not complete cleanly`),
  });
}
let shutdown = createShutdown();

app.addHook('onRequest', async (_req, reply) => {
  const state = shutdown.snapshot();
  if (!['running', 'waiting'].includes(state.phase)) {
    return reply.code(503).send({ code: 'SERVICE_CLOSING', error: 'Cockpit is closing or its shutdown failed', shutdown: state });
  }
});

function awaitingChoice(s: { ask?: unknown; planRequest?: unknown; elicitation?: unknown }): boolean {
  return !!(s.ask || s.planRequest || s.elicitation);
}

export function maybeGracefulExit(): void { shutdown.notify(); }

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

const ALLOWED_ORIGIN_HOSTS = new Set<string>(
  (process.env.COCKPIT_ALLOWED_ORIGINS ?? '').split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .map(origin => {
      const host = originToHost(origin);
      if (host === null) throw new Error('Invalid COCKPIT_ALLOWED_ORIGINS entry');
      return host;
    }),
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
  return { ok: true, login: await engine.login(), instanceId: serviceIdentity.instanceId };
});
app.get('/version', async (_req, reply) => {
  reply.header('Cache-Control', 'no-store');
  return serviceIdentity;
});

async function serviceStatus(): Promise<IntentResult<'system/status'>> {
  const metas = await engine.status();
  const sessions = metas.map((s) => ({
    sessionId: s.sessionId, status: s.status, title: s.title,
    awaitingChoice: awaitingChoice(s) || undefined,
    activeSubagents: s.activeSubagents || undefined,
  }));
  const running = metas.filter((s) => s.status === 'running').length;
  return { running, busy: await engine.busyCount(), inFlightRequests: shutdown.inFlightRequests,
    shutdown: shutdown.snapshot(), sessions };
}
app.get('/status', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return Intents['system/status'].result.parse(await serviceStatus());
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
  'system/shutdown': () => ({ ok: true, shutdown: shutdown.request() }),
  'system/status': serviceStatus,
  'runtime/snapshot': async () => engine.snapshot(),
  'session/new': async (b) => ({ sessionId: await (b.roles ? engine.newSession(b.cwd, b.roles) : engine.newSession(b.cwd)) }),
  'roles/list': async () => ({ roles: engine.listRoles() }),
  'roles/add': b => engine.addRoles(b.sessionId, b.roles),
  'roles/readiness': b => engine.roleReadiness(b.sessionId, b.roles),
  'session/tools-initialize': async b => {
    await engine.initializeSessionTools(b.sessionId);
    return { ok: true };
  },
  'session/resources-prepare': b => engine.prepareSessionResources(b),
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
  'session/control': async (b) => await engine.control(b.sessionId, b.token, b.action),
  setModel: async (b) => {
    const result = await engine.setModel(b.sessionId, b.modelId, b.reasoningEffort, b.contextTier);
    return { ok: true, result };
  },
  'session/rename': async (b) => ({ ok: true, title: await engine.rename(b.sessionId, b.name) }),
  'session/compact': async (b) => {
    const result = await engine.compact(b.sessionId, b.customInstructions);
    return { ok: true, result };
  },
  'session/rewind': async (b) => {
    const result = await engine.rewind(b.sessionId, b.toMsgId, b.rollbackFiles);
    return { ok: true, result };
  },
  setMode: async (b) => {
    const result = await engine.setMode(b.sessionId, b.mode);
    return { ok: true, result };
  },
  'session/delete': async (b) => {
    await engine.deleteSession(b.sessionId);
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
    return { ok: true };
  },
  'schedule/add': async ({ sessionId, ...options }) => {
    const res = await engine.addSchedule(sessionId, options);
    return { ok: !res.error, ...res };
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

async function dispatch<K extends IntentName>(name: K, body: unknown, signal?: AbortSignal): Promise<IntentResult<K>> {
  const input = Intents[name].body.safeParse(body === undefined ? {} : body);
  if (!input.success) throw new IntentBoundaryError(input.error.message, 400, 'INVALID_INTENT_BODY');
  // Zod's indexed schema union loses the key/value correlation; the mapped
  // handlers retain it. Assertions restore that correlation after validation.
  const result = await handlers[name](input.data as IntentBody<K>, signal);
  const output = Intents[name].result.safeParse(result);
  if (!output.success) {
    throw new IntentBoundaryError(`Invalid result for ${name}: ${output.error.message}`, 500, 'INVALID_INTENT_RESULT');
  }
  return output.data as IntentResult<K>;
}

function errorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'statusCode' in error
    && typeof error.statusCode === 'number' && Number.isInteger(error.statusCode)
    && error.statusCode >= 400 && error.statusCode <= 599) return error.statusCode;
  return 500;
}

const readIntents = new Set<IntentName>([
  'roles/list', 'roles/readiness',
  'system/status', 'runtime/snapshot', 'session/chat', 'session/list', 'session/get', 'session/refresh',
  'session/resources', 'session/usage', 'session/plan', 'session/panels', 'session/panel',
  'mcp/global', 'mcp/session', 'skills/global', 'skills/read', 'skills/session',
  'schedule/list', 'fs/listDir',
]);
const settlementIntents = new Set<IntentName>([
  'system/shutdown', 'cancel', 'session/interrupt', 'session/control', 'respondAsk', 'respondPlan',
  'planSupersede', 'respondElicitation', 'queue/remove', 'schedule/stop', 'session/unload',
]);

function retainResponse(reply: FastifyReply): () => void {
  const release = shutdown.retain();
  let operationDone = false;
  let responseDone = reply.raw.writableFinished || reply.raw.destroyed;
  const finish = () => {
    responseDone = true;
    reply.raw.off('finish', finish);
    reply.raw.off('close', finish);
    if (operationDone) release();
  };
  if (!responseDone) {
    reply.raw.once('finish', finish);
    reply.raw.once('close', finish);
  }
  return () => {
    operationDone = true;
    if (responseDone) release();
  };
}

app.post('/intent/*', async (req, reply) => {
  const name = (req.params as Record<string, string>)['*'];
  if (name === undefined || !isIntentName(name)) { reply.code(404); return { error: `unknown intent: ${name}` }; }
  // Body parsing may have overlapped the transition since onRequest ran.
  const phase = shutdown.snapshot().phase;
  if (!['running', 'waiting'].includes(phase)) {
    return reply.code(503).send({ code: 'SERVICE_CLOSING', error: 'Cockpit is closing', shutdown: shutdown.snapshot() });
  }
  if (phase === 'waiting' && !readIntents.has(name) && !settlementIntents.has(name)) {
    return reply.code(503).send({
      code: 'SERVICE_SHUTTING_DOWN', error: 'Graceful shutdown is pending; new independent work is not accepted',
    });
  }
  const release = readIntents.has(name) ? () => {} : retainResponse(reply);
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
    release();
  }
});

async function main(runtime: Engine): Promise<void> {
  moduleHost = new ModuleHost({
    origin: `http://${HOST}:${PORT}`,
    host: { call: async (name, body) => {
      const state = shutdown.snapshot();
      if (state.phase !== 'running') throw new Error('Host is shutting down');
      const release = shutdown.retain();
      try { return await dispatch(name, body); }
      finally { release(); }
    } },
    observer: runtime,
    onInvalidate: moduleId => onEngineEvent({ type: 'module/invalidated', moduleId }),
    onEvent: (moduleId, payload) => onEngineEvent({ type: 'module/event', moduleId, payload }),
    report: (id, error) => app.log.error({ moduleId: id, err: error }, 'local module failed'),
  });
  await moduleHost.register(app);
  runtime.setRoleProvider(moduleHost.roles);
  await registerStaticWeb();
  await runtime.start();
  app.log.info(`engine up (login=${await runtime.login()})`);
  await app.listen({ host: HOST, port: PORT });
  if (shutdown.snapshot().phase === 'running') moduleHost.ready();
}

// Serve the built SPA (apps/web/dist) from this process when SERVE_WEB is on, so a
// no-reverse-proxy deploy needs no nginx. @fastify/static serves real files (the
// hashed assets); the notFound handler returns index.html for client-side routes
// (e.g. /session/:id) so deep links and refreshes work. The specific API routes
// (/events, /intent/*, /health, …) are more specific than the
// static wildcard and still win; mutating routes keep their Origin/CSRF guard. When
// SERVE_WEB is explicitly off this is a no-op — no static route, no
// notFound handler — so existing behavior is untouched.
export async function registerStaticWeb(): Promise<void> {
  if (!SERVE_WEB) return;
  if (!existsSync(join(WEB_DIR, 'index.html')) || !statSync(join(WEB_DIR, 'index.html')).isFile()) {
    throw new Error(`Web bundle not found: ${WEB_DIR}; build Web or explicitly set COCKPIT_SERVE_WEB=0`);
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
async function boot(): Promise<void> {
  // Held until process exit, including unsuccessful native/transport shutdown.
  moduleStartupGuard = await guardModuleHostStartup();
  if (moduleStartupGuard.fencing === 'unsupported-platform') {
    app.log.warn({ platform: moduleStartupGuard.platform }, 'Module migration fencing unavailable; ordinary startup only, module ID migration disabled');
  }
  const native = new OfficialRuntime();
  const runtime = new Engine({ runtime: native });
  runtime.log = (msg, data) => app.log.warn(data ?? {}, msg);
  engine = runtime;
  const stop = () => {
    try { shutdown.request(); }
    catch (error) { app.log.error({ err: error }, 'shutdown request failed; signal does not force exit'); }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  runtime.onEvent(onEngineEvent);
  runtime.onActivitySettled(maybeGracefulExit);
  runtime.onFatal(error => { shutdown.runtimeFailed(error); });
  main(runtime).catch(error => {
    app.log.error({ err: error }, 'service startup failed');
    shutdown.runtimeFailed(error instanceof Error ? error : new Error(String(error)));
  });
}

if (process.env.COCKPIT_NO_BOOT !== '1') void boot().catch(error => {
  app.log.error({ err: error }, 'service startup refused');
  process.exitCode = 1;
});
