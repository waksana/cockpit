import { after, afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  Intents, SessionMeta, Snapshot, ServerEvent, UploadedFile, attachmentPrompt, unreadSessionCount,
  type IntentBody, type IntentName, type PushDelivery, type PushStatus, type PushSubscriptionJson,
} from '@cockpit/protocol';
import type { ServerEngine, ServerPush, ModuleIntentHandlers } from './index.ts';
import { isIntentName } from './capabilities.ts';
import { readNativeChat } from '../../../packages/core/src/native-chat.ts';
import { Engine } from '../../../packages/core/src/engine.ts';
import type { InternalSessionStart } from '../../../packages/core/src/engine.ts';
import { SessionStartCoordinator } from '../../../packages/core/src/modules/session-start.ts';

const uploadDir = relative(process.cwd(), fileURLToPath(
  new URL(`../.cockpit-intents-${process.pid}-${randomUUID()}`, import.meta.url),
));
process.env.COCKPIT_NO_BOOT = '1';
process.env.LOG_LEVEL = 'silent';
process.env.COCKPIT_SERVE_WEB = '0';
process.env.COCKPIT_MAX_SSE_CLIENTS = '2';
process.env.COCKPIT_UPLOAD_DIR = uploadDir;
delete process.env.AZURE_SPEECH_KEY;
delete process.env.AZURE_SPEECH_REGION;
const { app, setTestDependencies, broadcastFrame, onEngineEvent, sessionBusy, createSessionStarts } = await import('./index.ts');

const calls: { method: string; args: unknown[] }[] = [];
const pngFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=', 'base64');
function record<T>(method: string, args: unknown[], result: T): T {
  calls.push({ method, args });
  return result;
}
const busySession = SessionMeta.parse({
  sessionId: 's', title: 'test', cwd: '/fixture', lastActivity: 0,
  status: 'running', error: null, loaded: true, queue: [], ask: null,
});
let sessions = [busySession];
const historyPage = {
  sessionId: 's',
  source: 'persisted' as const, direction: 'backward' as const,
  events: [{ id: 'event', type: 'assistant.message', data: { messageId: 'm', content: 'history' }, timestamp: 1 }],
  cursor: 'native-next', cursorStatus: 'ok' as const, hasMore: true, read: { rpc: 1, events: 1 },
};
const snapshot = () => ({
  type: 'snapshot' as const, agentStatus: 'up' as const, models: [],
  vapidPublicKey: null, sessions, permissionPolicy: 'allow-all' as const,
});
const projectedSnapshot = (raw: Snapshot = snapshot()): Snapshot => ({
  ...raw, unreadCount: raw.unreadCount ?? unreadSessionCount(raw.sessions),
});
function attentionSessions(): SessionMeta[] {
  return [
    { sessionId: 'ready-unread', attention: 'ready', attnId: 4, seenId: 3 },
    { sessionId: 'choice-unread', attention: 'choice', attnId: 6, seenId: 5 },
    { sessionId: 'choice-seen', attention: 'choice', attnId: 7, seenId: 7 },
    { sessionId: 'ready-seen', attention: 'ready', attnId: 8, seenId: 8 },
    { sessionId: 'legacy-choice', attention: 'choice' },
    { sessionId: 'legacy-ready', attention: 'ready' },
    { sessionId: 'no-attention', attention: null, attnId: 9, seenId: 1 },
  ].map((meta) => SessionMeta.parse({ ...busySession, ...meta }));
}
const engine: ServerEngine & { attentionCount(): number } = {
  stop: async () => { throw new Error('integration fixtures must never stop a real runtime'); },
  login: async () => 'test-only',
  snapshot: async () => record('snapshot', [], snapshot()),
  busyCount: async () => sessions.filter(sessionBusy).length,
  attentionCount: () => record('attentionCount', [], 0),
  newSession: async (...args) => record('newSession', args, 'created'),
  forkSession: async (...args) => record('forkSession', args, { sessionId: 'forked' }),
  chat: async (query, signal) => {
    assert.ok(signal instanceof AbortSignal);
    return record('chat', [query], { ...historyPage, source: query.source, direction: query.direction });
  },
  prompt: async (...args) => record('prompt', args, { ok: true, queued: true }),
  cancel: (...args) => record('cancel', args, undefined),
  interrupt: async (...args) => record('interrupt', args, { ok: true as const, interrupted: true }),
  setModel: async (...args) => record('setModel', args, undefined),
  rename: async (...args) => record('rename', args, 'renamed'),
  autoName: async (...args) => record('autoName', args, { ok: true as const, applied: true, title: 'Short topic' }),
  compact: async (...args) => record('compact', args, undefined),
  rewind: async (...args) => record('rewind', args, undefined),
  setMode: async (...args) => record('setMode', args, undefined),
  deleteSession: async (...args) => record('deleteSession', args, undefined),
  deletionPlan: async (...args) => record('deletionPlan', args, { sessionId: args[0], planId: 'a'.repeat(64), modules: [] }),
  sessionModules: async (...args) => record('sessionModules', args, null),
  applySessionModules: async (...args) => record('applySessionModules', args, {
    sessionId: args[0], selections: args[1].map(selection => ({ ...selection, version: selection.version ?? '1.0.0' })),
    phase: 'applied' as const, operationId: args[2],
  }),
  unload: (...args) => record('unload', args, undefined),
  load: async (...args) => record('load', args, undefined),
  reload: async (...args) => record('reload', args, undefined),
  pin: async (...args) => record('pin', args, true),
  getPlan: async (...args) => record('getPlan', args, { planMarkdown: null, todos: [] }),
  getUsage: async (...args) => record('getUsage', args, {
    sessionId: 's', sampledAt: 1, context: null,
    usage: { sessionStartTime: '2026-09-09T00:00:00Z', totalUserRequests: 0,
      lastCallInputTokens: 0, lastCallOutputTokens: 0, modelMetrics: {} },
  }),
  getPanels: async (...args) => record('getPanels', args, {
    skills: [], mcpServers: [], tasks: [], instructionSources: [], schedules: [],
  }),
  getPanel: async (...args) => record('getPanel', args, []),
  getResources: async (...args) => record('getResources', args, busySession),
  status: async (...args) => record('sessionStatus', args, sessions),
  respondAsk: (...args) => record('respondAsk', args, undefined),
  respondPlan: (...args) => record('respondPlan', args, undefined),
  planSupersede: async (...args) => record('planSupersede', args, undefined),
  respondElicitation: (...args) => record('respondElicitation', args, undefined),
  removeQueued: (...args) => record('removeQueued', args, undefined),
  refreshList: async (...args) => record('refreshList', args, undefined),
  listLive: (...args) => record('listLive', args, []),
  getMeta: (...args) => record('getMeta', args, busySession),
  markSeen: (...args) => record('markSeen', args, undefined),
  listGlobalMcp: (...args) => record('listGlobalMcp', args, []),
  setMcpDefault: async (...args) => record('setMcpDefault', args, undefined),
  refreshMcp: async (...args) => record('refreshMcp', args, undefined),
  reloadSessionMcp: async (...args) => record('reloadSessionMcp', args, { reconnected: 2 }),
  listSessionMcp: async (...args) => record('listSessionMcp', args, { loaded: false, servers: [] }),
  toggleSessionMcp: async (...args) => record('toggleSessionMcp', args, {
    ok: true, applied: true, sessionId: 's', name: 'tools', enabled: true,
    status: 'connected' as const,
    operation: { id: 'op', desiredEnabled: true, state: 'succeeded' as const, startedAt: 0, status: 'connected' as const },
  }),
  listGlobalSkills: async (...args) => record('listGlobalSkills', args, []),
  setGlobalSkill: async (...args) => record('setGlobalSkill', args, undefined),
  readSkillBody: async (...args) => record('readSkillBody', args, { name: 'skill', body: 'manual skill' }),
  refreshSkills: async (...args) => record('refreshSkills', args, undefined),
  listSessionSkills: async (...args) => record('listSessionSkills', args, []),
  toggleSessionSkill: async (...args) => record('toggleSessionSkill', args, undefined),
  addSchedule: async (...args) => record('addSchedule', args, {
    entry: { id: 1, prompt: 'remind', recurring: true, nextRunAt: 10, intervalMs: 30_000 },
  }),
  stopSchedule: async (...args) => record('stopSchedule', args, true),
  listSchedules: async (...args) => record('listSchedules', args, []),
  listDir: (...args) => record('listDir', args, { path: '/fixture', parent: '/', entries: [] }),
};
const ecdh = createECDH('prime256v1');
ecdh.setPrivateKey(Buffer.alloc(32, 1));
const subscription: PushSubscriptionJson = {
  endpoint: 'https://push.example/sub',
  keys: {
    p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'),
    auth: Buffer.alloc(16, 2).toString('base64url'),
  },
};
const subscriptions = new Map<string, PushSubscriptionJson>();
const fakeDeliveries: { endpoint: string; delivery: PushDelivery }[] = [];
const fakePush: ServerPush = {
  subscribe: (...args: [PushSubscriptionJson]) => {
    subscriptions.set(args[0].endpoint, args[0]);
    return record('subscribe', args, undefined);
  },
  status: (...args: [endpoint?: string]): PushStatus => {
    const [endpoint] = args;
    const lastDelivery = (endpoint === undefined
      ? fakeDeliveries.at(-1)
      : fakeDeliveries.findLast((item) => item.endpoint === endpoint))?.delivery;
    return record('status', args, {
      configured: true, subscriptionCount: subscriptions.size, publicKey: subscription.keys.p256dh,
      ...(endpoint === undefined ? {} : { registered: subscriptions.has(endpoint) }),
      ...(lastDelivery === undefined ? {} : { lastDelivery }),
    });
  },
  test: async (...args: [endpoint: string, confirm: boolean]): Promise<PushDelivery> => {
    const [endpoint, confirm] = args;
    if (confirm !== true || !subscriptions.has(endpoint)) {
      return record('test', args, { status: 'failed', at: 10, error: 'Subscription is not registered' });
    }
    const delivery: PushDelivery = { status: 'accepted', at: 11 };
    fakeDeliveries.push({ endpoint, delivery });
    return record('test', args, delivery);
  },
  unsubscribe: (...args: [endpoint: string]) => {
    subscriptions.delete(args[0]);
    return record('unsubscribe', args, undefined);
  },
  sendAttention: async (...args: unknown[]) => {
    record('sendAttention', args, undefined);
    throw new Error('tests must not send notifications');
  },
};
const moduleFixture = {
  id: 'assistant' as const, name: 'Assistant', description: 'Test-only module',
  installed: [{ version: '1.0.0', digest: 'a'.repeat(64) }], selectedVersion: '1.0.0',
  roles: [], service: { ownership: 'none' as const, status: 'stopped' as const },
};
const moduleConfigFixture = { moduleId: 'assistant' as const, revision: 0, configVersion: 1, values: {} };
const initializeConfigFixture = { moduleId: 'task' as const, operationId: 'module-initialize-1', version: '1.2.3',
  digest: 'a'.repeat(64), gatewayUrl: 'https://cockpit.test', confirm: true as const };
const initializingConfigFixture = { moduleId: initializeConfigFixture.moduleId, operationId: initializeConfigFixture.operationId,
  version: initializeConfigFixture.version, digest: initializeConfigFixture.digest, gatewayUrl: initializeConfigFixture.gatewayUrl,
  phase: 'preparing' as const, updatedAt: 1 };
const localInstallFixture = { moduleId: 'assistant' as const, version: '1.0.0', digest: 'c'.repeat(64), operationId: 'local-install-1' };
const serviceCommandFixture = { moduleId: 'task' as const, action: 'start' as const,
  operationId: 'service-start-0001', version: '1.2.0', digest: 'b'.repeat(64) };
const serviceJobFixture = { schemaVersion: 1 as const,
  command: { id: 'task' as const, action: 'start' as const, operationId: 'service-start-0001', version: '1.2.0', digest: 'b'.repeat(64) },
  phase: 'accepted' as const, step: 'queued' as const, acceptedAt: '2026-09-11T10:00:00Z', updatedAt: '2026-09-11T10:00:00Z' };
const fakeModules: ModuleIntentHandlers = {
  'modules/list': async body => record('modules/list', [body], { modules: [moduleFixture] }),
  'modules/install': async body => record('modules/install', [body], { module: moduleFixture }),
  'modules/install/local': async body => record('modules/install/local', [body], {
    moduleId: body.moduleId, version: body.version, operationId: body.operationId, sha256: body.digest,
    source: 'local', state: 'succeeded', updatedAt: 1, installedDigest: body.digest,
  }),
  'modules/uninstall': async body => record('modules/uninstall', [body], { ok: true }),
  'modules/config/get': async body => record('modules/config/get', [body], moduleConfigFixture),
  'modules/config/set': async body => record('modules/config/set', [body], body),
  'modules/config/initialize': async body => record('modules/config/initialize', [body], { operation: initializingConfigFixture }),
  'modules/config/initialization': async body => record('modules/config/initialization', [body], { operation: initializingConfigFixture }),
  'modules/service': async body => record('modules/service', [body], { job: serviceJobFixture }),
  'modules/service/job': async body => record('modules/service/job', [body], { job: serviceJobFixture }),
  'modules/service/status': async body => record('modules/service/status', [body],
    { id: body.moduleId, status: 'stopped', owned: false, recoveryRequired: false }),
  'modules/wechat/unbind': async body => record('modules/wechat/unbind', [body], { ok: true }),
  'modules/wechat/unbind/get': async body => record('modules/wechat/unbind/get', [body], {
    operation: { operationId: body.operationId, sessionId: 's', state: 'succeeded' },
  }),
  'modules/updates/check': async body => record('modules/updates/check', [body], {
    schemaVersion: 1, channel: 'stable', sequence: 1,
    issuedAt: '2026-09-11T00:00:00.000Z', expiresAt: '2026-09-12T00:00:00.000Z', targets: [],
  }),
  'modules/updates/status': async body => record('modules/updates/status', [body], { operations: [] }),
  'modules/updates/get': async body => record('modules/updates/get', [body], { operation: null }),
  'modules/updates/install': async body => record('modules/updates/install', [body], {
    ...body, state: 'unknown', updatedAt: 1,
  }),
  'modules/updates/reconcile': async body => record('modules/updates/reconcile', [body], {
    moduleId: body.moduleId, operationId: body.operationId, version: '1.0.0', sha256: 'a'.repeat(64),
    state: 'failed', updatedAt: 1, error: 'Verified target is not installed',
  }),
};
const fakeStarts: Pick<SessionStartCoordinator, 'start' | 'get'> = {
  start: async body => record('sessionStart', [body], {
    operationId: body.operationId, sessionId: '11111111-1111-4111-8111-111111111111', state: 'accepted' as const,
  }),
  get: operationId => record('sessionStartGet', [operationId], null),
};
setTestDependencies({ engine, push: fakePush, modules: fakeModules, starts: fakeStarts });

beforeEach(() => {
  setTestDependencies({ engine, push: fakePush, modules: fakeModules, starts: fakeStarts });
  sessions = [busySession];
  calls.length = 0;
  subscriptions.clear();
  fakeDeliveries.length = 0;
});
afterEach(async () => {
  // Even skills/refresh only ever sees a busy fake session, so it cannot exit.
  try { await app.inject({ method: 'POST', url: '/admin/restart', payload: { pending: false } }); }
  finally { rmSync(uploadDir, { recursive: true, force: true }); }
});
after(async () => {
  try { await app.close(); }
  finally { rmSync(uploadDir, { recursive: true, force: true }); }
});

type Case = { body: unknown; method: string | null; args: unknown[] };
const cases = {
  'runtime/snapshot': { body: {}, method: 'snapshot', args: [] },
  'session/new': { body: { cwd: '/fixture' }, method: 'newSession', args: ['/fixture', undefined] },
  'session/start': { body: { operationId: 'first-real-message', cwd: '/fixture', text: 'First user message' }, method: 'sessionStart',
    args: [{ operationId: 'first-real-message', cwd: '/fixture', text: 'First user message' }] },
  'session/start/get': { body: { operationId: 'first-real-message' }, method: 'sessionStartGet', args: ['first-real-message'] },
  'session/modules/get': { body: { sessionId: 's' }, method: 'sessionModules', args: ['s'] },
  'session/modules/apply': {
    body: { sessionId: 's', selections: [], operationId: 'apply-modules-1' },
    method: 'applySessionModules', args: ['s', [], 'apply-modules-1'],
  },
  'modules/list': { body: {}, method: 'modules/list', args: [{}] },
  'modules/install': { body: { moduleId: 'assistant' }, method: 'modules/install', args: [{ moduleId: 'assistant' }] },
  'modules/uninstall': { body: { moduleId: 'assistant', confirm: true }, method: 'modules/uninstall',
    args: [{ moduleId: 'assistant', confirm: true }] },
  'modules/config/get': { body: { moduleId: 'assistant' }, method: 'modules/config/get', args: [{ moduleId: 'assistant' }] },
  'modules/config/set': { body: moduleConfigFixture, method: 'modules/config/set', args: [moduleConfigFixture] },
  'modules/install/local': { body: localInstallFixture, method: 'modules/install/local', args: [localInstallFixture] },
  'modules/config/initialize': { body: initializeConfigFixture, method: 'modules/config/initialize', args: [initializeConfigFixture] },
  'modules/config/initialization': { body: { operationId: 'module-initialize-1' }, method: 'modules/config/initialization',
    args: [{ operationId: 'module-initialize-1' }] },
  'modules/service': { body: serviceCommandFixture, method: 'modules/service', args: [serviceCommandFixture] },
  'modules/service/job': { body: { operationId: 'service-start-0001' }, method: 'modules/service/job',
    args: [{ operationId: 'service-start-0001' }] },
  'modules/service/status': { body: { moduleId: 'task' }, method: 'modules/service/status', args: [{ moduleId: 'task' }] },
  'modules/wechat/unbind': { body: { sessionId: 's', operationId: 'unbind-session-1', confirm: true },
    method: 'modules/wechat/unbind', args: [{ sessionId: 's', operationId: 'unbind-session-1', confirm: true }] },
  'modules/wechat/unbind/get': { body: { operationId: 'unbind-session-1' },
    method: 'modules/wechat/unbind/get', args: [{ operationId: 'unbind-session-1' }] },
  'modules/updates/check': { body: {}, method: 'modules/updates/check', args: [{}] },
  'modules/updates/status': { body: {}, method: 'modules/updates/status', args: [{}] },
  'modules/updates/get': { body: { operationId: 'install-module-1' }, method: 'modules/updates/get', args: [{ operationId: 'install-module-1' }] },
  'modules/updates/reconcile': { body: { moduleId: 'assistant', operationId: 'install-module-1', confirm: true },
    method: 'modules/updates/reconcile', args: [{ moduleId: 'assistant', operationId: 'install-module-1', confirm: true }] },
  'modules/updates/install': { body: { moduleId: 'assistant', version: '1.0.0', sha256: 'a'.repeat(64), operationId: 'install-module-1' },
    method: 'modules/updates/install',
    args: [{ moduleId: 'assistant', version: '1.0.0', sha256: 'a'.repeat(64), operationId: 'install-module-1' }] },
  'session/fork': { body: { sessionId: 's', toEventId: 'user-event', name: 'Child' }, method: 'forkSession', args: ['s', 'user-event', 'Child'] },
  'session/chat': {
    body: Intents['session/chat'].body.parse({ sessionId: 's', cursor: 'native-before', max: 12 }),
    method: 'chat', args: [Intents['session/chat'].body.parse({ sessionId: 's', cursor: 'native-before', max: 12 })],
  },
  prompt: { body: { sessionId: 's', text: 'hello', mode: 'enqueue' }, method: 'prompt', args: ['s', 'hello', 'enqueue'] },
  cancel: { body: { sessionId: 's' }, method: 'cancel', args: ['s'] },
  'session/interrupt': { body: { sessionId: 's' }, method: 'interrupt', args: ['s'] },
  setModel: { body: { sessionId: 's', modelId: 'model', reasoningEffort: 'high', contextTier: 'long_context' }, method: 'setModel', args: ['s', 'model', 'high', 'long_context'] },
  'session/rename': { body: { sessionId: 's', name: 'renamed' }, method: 'rename', args: ['s', 'renamed'] },
  'session/auto-name': { body: { sessionId: 's' }, method: 'autoName', args: ['s'] },
  'session/compact': { body: { sessionId: 's', customInstructions: 'keep context' }, method: 'compact', args: ['s', 'keep context'] },
  'session/rewind': { body: { sessionId: 's', toMsgId: 'm', rollbackFiles: true }, method: 'rewind', args: ['s', 'm', true] },
  setMode: { body: { sessionId: 's', mode: 'plan' }, method: 'setMode', args: ['s', 'plan'] },
  'session/delete/preview': { body: { sessionId: 's' }, method: 'deletionPlan', args: ['s'] },
  'session/delete': { body: { sessionId: 's', confirm: true }, method: 'deleteSession', args: ['s', true, undefined] },
  'session/purge': { body: { sessionId: 's', confirm: true }, method: 'deleteSession', args: ['s', true, undefined] },
  'session/unload': { body: { sessionId: 's' }, method: 'unload', args: ['s'] },
  'session/load': { body: { sessionId: 's' }, method: 'load', args: ['s'] },
  'session/reload': { body: { sessionId: 's' }, method: 'reload', args: ['s'] },
  'session/pin': { body: { sessionId: 's', pinned: true }, method: 'pin', args: ['s', true] },
  'session/plan': { body: { sessionId: 's' }, method: 'getPlan', args: ['s'] },
  'session/usage': { body: { sessionId: 's' }, method: 'getUsage', args: ['s'] },
  'session/panels': { body: { sessionId: 's' }, method: 'getPanels', args: ['s'] },
  'session/panel': { body: { sessionId: 's', section: 'tasks' }, method: 'getPanel', args: ['s', 'tasks'] },
  'session/resources': { body: { sessionId: 's', resources: ['control'] }, method: 'getResources', args: ['s', ['control']] },
  respondAsk: { body: { sessionId: 's', requestId: 'r', answer: 'yes', wasFreeform: true }, method: 'respondAsk', args: ['s', 'r', 'yes', true] },
  respondPlan: { body: { sessionId: 's', requestId: 'r', action: 'interactive' }, method: 'respondPlan', args: ['s', 'r', 'interactive'] },
  planSupersede: { body: { sessionId: 's', requestId: 'r', message: 'instead' }, method: 'planSupersede', args: ['s', 'r', 'instead'] },
  respondElicitation: { body: { sessionId: 's', requestId: 'r', action: 'decline' }, method: 'respondElicitation', args: ['s', 'r', 'decline'] },
  'queue/remove': { body: { sessionId: 's', itemId: 'q' }, method: 'removeQueued', args: ['s', 'q'] },
  'session/refresh': { body: {}, method: 'refreshList', args: [] },
  'session/list': { body: {}, method: 'listLive', args: [] },
  'session/get': { body: { sessionId: 's' }, method: 'getMeta', args: ['s'] },
  'push/subscribe': { body: { subscription }, method: 'subscribe', args: [subscription] },
  'push/status': { body: {}, method: 'status', args: [undefined] },
  'push/test': { body: { endpoint: subscription.endpoint, confirm: true }, method: 'test', args: [subscription.endpoint, true] },
  'push/unsubscribe': { body: { endpoint: subscription.endpoint }, method: 'unsubscribe', args: [subscription.endpoint] },
  'inbox/seen': { body: { sessionId: 's' }, method: 'markSeen', args: ['s'] },
  'speech/token': { body: {}, method: null, args: [] },
  'mcp/global': { body: {}, method: 'listGlobalMcp', args: [] },
  'mcp/global-default': { body: { name: 'tools', on: true }, method: 'setMcpDefault', args: ['tools', true] },
  'mcp/refresh': { body: {}, method: 'refreshMcp', args: [] },
  'mcp/reload-session': { body: { sessionId: 's' }, method: 'reloadSessionMcp', args: ['s'] },
  'mcp/session': { body: { sessionId: 's' }, method: 'listSessionMcp', args: ['s'] },
  'mcp/session-toggle': { body: { sessionId: 's', name: 'tools', on: true }, method: 'toggleSessionMcp', args: ['s', 'tools', true] },
  'skills/global': { body: {}, method: 'listGlobalSkills', args: [undefined] },
  'skills/global-toggle': { body: { name: 'skill', enabled: true, cwd: '/fixture/project' }, method: 'setGlobalSkill', args: ['skill', true, '/fixture/project'] },
  'skills/read': { body: { name: 'skill', cwd: '/fixture/project' }, method: 'readSkillBody', args: ['skill', '/fixture/project'] },
  'skills/session': { body: { sessionId: 's' }, method: 'listSessionSkills', args: ['s'] },
  'skills/session-toggle': { body: { sessionId: 's', name: 'skill', enabled: true }, method: 'toggleSessionSkill', args: ['s', 'skill', true] },
  'skills/refresh': { body: {}, method: 'refreshSkills', args: [] },
  'schedule/add': { body: { sessionId: 's', prompt: 'remind', interval: '30s', recurring: true }, method: 'addSchedule', args: ['s', { prompt: 'remind', interval: '30s', recurring: true }] },
  'schedule/stop': { body: { sessionId: 's', id: 1 }, method: 'stopSchedule', args: ['s', 1] },
  'schedule/list': { body: { sessionId: 's' }, method: 'listSchedules', args: ['s'] },
  'fs/listDir': { body: { path: '/fixture' }, method: 'listDir', args: ['/fixture'] },
} satisfies { [K in Exclude<IntentName, `files/${string}`>]: Case & { body: IntentBody<K> } };

test('dispatch fixtures cover exactly the authoritative Intents, without retired handlers', () => {
  assert.deepEqual([...Object.keys(cases), 'files/list', 'files/get', 'files/associate'].sort(), Object.keys(Intents).sort());
  assert.equal(app.server.listening, false);
});

for (const [name, fixture] of Object.entries(cases)) {
  test(`dispatch ${name}: parses once, routes exact arguments, and validates the protocol result`, async (t) => {
    assert.ok(isIntentName(name));
    assert.equal(Intents[name].body.safeParse(fixture.body).success, true);
    if (name === 'push/test') subscriptions.set(subscription.endpoint, subscription);
    const inputParse = t.mock.method(Intents[name].body, 'safeParse');
    const outputParse = t.mock.method(Intents[name].result, 'safeParse');
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: fixture.body });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(inputParse.mock.callCount(), 1, 'request is parsed once');
    assert.deepEqual(inputParse.mock.calls[0]?.arguments, [fixture.body]);
    assert.equal(outputParse.mock.callCount(), 1, 'result is validated once');
    const parsed = Intents[name].result.safeParse(response.json());
    assert.equal(parsed.success, true, JSON.stringify(parsed));
    const effects = name === 'skills/refresh' ? calls.filter(({ method }) => method !== 'snapshot') : calls;
    assert.deepEqual(effects, fixture.method ? [{ method: fixture.method, args: fixture.args }] : []);
    if (name === 'runtime/snapshot') assert.deepEqual(response.json(), projectedSnapshot());
    if (name === 'session/chat') assert.deepEqual(response.json(), historyPage);
    if (name === 'session/load') assert.deepEqual(response.json(), { ok: true, sessionId: 's' });
    if (name === 'session/chat') {
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    if (name === 'skills/refresh') assert.deepEqual(response.json(), { ok: true, willRestartWhenIdle: false });
    if (name === 'speech/token') assert.deepEqual(response.json(), { enabled: false });
  });
}

test('session/load surfaces readiness failure without reload, prompt or replacement fallback', async t => {
  const load = t.mock.method(engine, 'load', async () => {
    throw Object.assign(new Error('Readiness remains unconfirmed'), { statusCode: 409, code: 'LOAD_UNCONFIRMED' });
  });
  const response = await app.inject({ method: 'POST', url: '/intent/session/load', payload: { sessionId: 's' } });
  assert.equal(response.statusCode, 409);
  assert.notEqual(response.json().ok, true);
  assert.equal(load.mock.callCount(), 1);
  assert.deepEqual(load.mock.calls[0]?.arguments, ['s']);
  assert.deepEqual(calls, []);
});

function directoryFixture(t: TestContext) {
  const root = join(process.cwd(), `.cockpit-directories-${randomUUID()}`);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const list = t.mock.method(engine, 'listDir', Engine.prototype.listDir);
  const request = (path?: string) => app.inject({
    method: 'POST', url: '/intent/fs/listDir', payload: path === undefined ? {} : { path },
  });
  return { root, home, list, request };
}

test('directory listing keeps default home, tilde, relative paths, sorting and parent navigation', async t => {
  const { home, list, request } = directoryFixture(t);
  mkdirSync(join(home, 'project'));
  mkdirSync(join(home, 'alpha'));
  mkdirSync(join(home, '.hidden'));
  writeFileSync(join(home, 'a.txt'), '');
  for (const path of [undefined, home, '~', relative(process.cwd(), home), `  ${home}  `]) {
    const response = await request(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      path: home, parent: dirname(home),
      entries: [{ name: 'alpha', isDir: true }, { name: 'project', isDir: true }, { name: 'a.txt', isDir: false }],
    });
  }
  const project = await request('~/project');
  assert.deepEqual(project.json(), { path: join(home, 'project'), parent: home, entries: [] });
  const parent = await request(project.json().parent);
  assert.equal(parent.json().path, home);
  const root = await request(parse(home).root);
  assert.equal(root.statusCode, 200, root.body);
  assert.equal(root.json().parent, null);
  assert.equal(list.mock.callCount(), 8);
  assert.deepEqual(calls, [], 'browsing must not touch native sessions or other engine methods');
});

test('directory errors retain the requested path and filesystem code without falling back to home', async t => {
  const { home, list, request } = directoryFixture(t);
  const file = join(home, 'file.txt');
  writeFileSync(file, '');
  for (const [path, status, code] of [
    [join(home, 'missing'), 404, 'ENOENT'],
    ['~/missing', 404, 'ENOENT'],
    [file, 400, 'ENOTDIR'],
    [join(file, 'child'), 400, 'ENOTDIR'],
    ['', 400, 'INVALID_DIRECTORY_PATH'],
    ['   ', 400, 'INVALID_DIRECTORY_PATH'],
  ] as const) {
    const response = await request(path);
    assert.equal(response.statusCode, status, response.body);
    const body = response.json();
    assert.equal(body.code, code);
    assert.equal(typeof body.error, 'string');
    if (path.trim()) assert.ok(body.error.includes(path.replace('~', home)), body.error);
    else assert.match(body.error, /must not be empty/);
    assert.equal('path' in body, false);
    assert.equal('entries' in body, false);
  }
  assert.equal(list.mock.callCount(), 6, 'one listing attempt per request');
  assert.deepEqual(calls, []);
});

for (const mode of [0o000, 0o400]) {
  test(`directory listing rejects denied read/search access (${mode.toString(8)})`, {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  }, async t => {
    const { home, request } = directoryFixture(t);
    const denied = join(home, 'denied');
    mkdirSync(denied);
    writeFileSync(join(denied, 'child.txt'), '');
    chmodSync(denied, mode);
    try {
      const response = await request(denied);
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().code, 'EACCES');
      assert.ok(response.json().error.includes(denied));
      assert.equal('entries' in response.json(), false);
    } finally { chmodSync(denied, 0o700); }
    assert.equal((await request(denied)).statusCode, 200);
  });
}

test('directory symlinks preserve valid navigation and surface broken or looping targets', {
  skip: process.platform === 'win32',
}, async t => {
  const { home, request } = directoryFixture(t);
  mkdirSync(join(home, 'project'));
  symlinkSync('project', join(home, 'alias'));
  symlinkSync('missing', join(home, 'broken'));
  symlinkSync('loop', join(home, 'loop'));
  const valid = await request(join(home, 'alias'));
  assert.equal(valid.statusCode, 200, valid.body);
  assert.deepEqual(valid.json(), { path: join(home, 'alias'), parent: home, entries: [] });
  for (const [name, status, code] of [['broken', 404, 'ENOENT'], ['loop', 500, 'ELOOP']] as const) {
    const response = await request(join(home, name));
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.json().code, code);
    assert.ok(response.json().error.includes(join(home, name)));
    assert.equal('entries' in response.json(), false);
  }
});

test('all intent bodies reject explicit null, arrays, strings, numbers, and booleans before side effects', async () => {
  for (const name of Object.keys(Intents)) {
    for (const body of [null, [], 'invalid', 42, false]) {
      calls.length = 0;
      const response = await app.inject({
        method: 'POST', url: `/intent/${name}`,
        headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body),
      });
      assert.equal(response.statusCode, 400, `${name}: ${JSON.stringify(body)}: ${response.body}`);
      assert.equal(response.json().code, 'INVALID_INTENT_BODY');
      assert.deepEqual(calls, [], name);
    }
  }
});

test('an absent body is normalized to {} and still validated for every intent', async () => {
  for (const [name, intent] of Object.entries(Intents)) {
    calls.length = 0;
    const response = await app.inject({ method: 'POST', url: `/intent/${name}` });
    assert.equal(response.statusCode, intent.body.safeParse({}).success ? 200 : 400, `${name}: ${response.body}`);
    if (!intent.body.safeParse({}).success) assert.deepEqual(calls, [], name);
  }
});

test('bad fields, enums, and protocol refinements are rejected before dispatch', async () => {
  const invalid: [string, unknown][] = [
    ['session/new', { cwd: 1 }],
    ['prompt', { sessionId: 's', text: 'hello', mode: 'other' }],
    ['setModel', { sessionId: 's', modelId: 'm', contextTier: 'unknown' }],
    ['setMode', { sessionId: 's', mode: 'unknown' }],
    ['respondAsk', { sessionId: 's', requestId: 'r', answer: 'yes', wasFreeform: 'true' }],
    ['respondPlan', { sessionId: 's', requestId: 'r', action: 'unknown' }],
    ['respondElicitation', { sessionId: 's', requestId: 'r', action: 'unknown' }],
    ['mcp/session-toggle', { sessionId: 's', name: 'tools', on: 'true' }],
    ['skills/session-toggle', { sessionId: 's', name: 'skill', enabled: 'true' }],
    ['schedule/add', { sessionId: 's', prompt: 'hello' }],
    ['schedule/add', { sessionId: 's', prompt: 'hello', interval: '30s', cron: '* * * * *' }],
    ['schedule/add', { sessionId: 's', prompt: '', at: 12 }],
    ['schedule/stop', { sessionId: 's', id: '1' }],
    ['push/subscribe', { subscription: { endpoint: 'http://push.example/sub' } }],
  ];
  for (const [name, body] of invalid) {
    const response = await app.inject({
      method: 'POST', url: `/intent/${name}`,
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body),
    });
    assert.equal(response.statusCode, 400, `${name}: ${response.body}`);
    assert.equal(response.json().code, 'INVALID_INTENT_BODY');
    assert.deepEqual(calls, [], name);
  }
});

test('native chat rejects unsupported selectors and invalid page sizes before engine dispatch', async () => {
  const invalid: [IntentName, unknown][] = [
    ['session/chat', { sessionId: 's', beforeMsgId: 'b', afterMsgId: 'a' }],
    ['session/chat', { sessionId: 's', agentIds: ['child'] }],
    ['skills/global', { cwd: '' }],
    ['skills/global', { cwd: null }],
    ...(['session/chat'] as const).flatMap((name) => [
      ...['', null, 1].map((cursor) => [name, { sessionId: 's', cursor }] as [IntentName, unknown]),
      ...[0, -1, 257, 1.5, '1', null].map((max) => [name, { sessionId: 's', max }] as [IntentName, unknown]),
    ]),
  ];
  for (const [name, payload] of invalid) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload });
    assert.equal(response.statusCode, 400, `${name}: ${response.body}`);
    assert.equal(response.json().code, 'INVALID_INTENT_BODY');
    assert.deepEqual(calls, []);
  }
});

test('native chat forwards the exact cursor and native event count', async () => {
  for (const max of [undefined, 1, 256]) {
    for (const cursor of [undefined, 'native-position']) {
      calls.length = 0;
      const body = { sessionId: 's', cursor, max };
      const response = await app.inject({
        method: 'POST', url: '/intent/session/chat', payload: body,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), historyPage);
      assert.deepEqual(calls, [{ method: 'chat', args: [Intents['session/chat'].body.parse(JSON.parse(JSON.stringify(body)))] }]);
    }
  }
});

test('HTTP paging uses exactly one native event page and keeps older cursors stable across appends', async t => {
  type Read = Parameters<typeof readNativeChat>[1]['persisted'];
  type Events = Awaited<ReturnType<Read>>['events'];
  const events: Events = Array.from({ length: 901 }, (_, i) => ({
    type: 'user.message', id: `u${i}`, timestamp: '2026-09-09T00:00:00Z', parentId: null, data: { content: `Message ${i}` },
  }));
  const cursors = new Map<string, string | undefined>();
  let sequence = 0;
  let nativeReads = 0;
  const readPersistedEvents: Read = async params => {
    nativeReads++;
    assert.equal(params.direction, 'backward');
    const located = params.cursor ? cursors.get(params.cursor) : undefined;
    const index = located ? events.findIndex(event => event.id === located) : -1;
    const expired = !!params.cursor && (!cursors.has(params.cursor) || (!!located && index < 0));
    const end = !params.cursor || expired ? events.length : Math.max(0, index);
    const start = Math.max(0, end - params.max!);
    const batch = events.slice(start, end);
    const cursor = `native-${++sequence}`;
    cursors.set(cursor, batch[0]?.id);
    return { events: batch, cursor, hasMore: start > 0, cursorStatus: expired ? 'expired' : 'ok' };
  };
  setTestDependencies({ engine: {
    ...engine, chat: (query, signal) => readNativeChat(query, { persisted: readPersistedEvents }, signal),
  }, push: fakePush });
  t.after(() => setTestDependencies({ engine, push: fakePush }));
  const request = async (cursor?: string) => {
    const start = nativeReads;
    const response = await app.inject({
      method: 'POST', url: '/intent/session/chat',
      payload: { sessionId: 's', cursor, max: 64 },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(nativeReads - start, 1);
    return Intents['session/chat'].result.parse(response.json());
  };
  const base = await request();
  assert.equal(base.events.length, 64);
  events.push(...Array.from({ length: 99 }, (_, i) => ({
    type: 'user.message' as const, id: `u${901 + i}`, timestamp: '2026-09-09T00:00:00Z', parentId: null,
    data: { content: `Gap ${i}` },
  })));
  const older = await request(base.cursor);
  assert.deepEqual(older.events.map(event => event.id), Array.from({ length: 64 }, (_, i) => `u${773 + i}`));
  assert.deepEqual(calls, [], 'the passive contract never loads a runtime, sends a model prompt or marks seen');
});

test('skills/global forwards explicit cwd without selecting a session or querying the snapshot', async () => {
  const response = await app.inject({
    method: 'POST', url: '/intent/skills/global', payload: { cwd: '/fixture/project' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { skills: [] });
  assert.deepEqual(calls, [{ method: 'listGlobalSkills', args: ['/fixture/project'] }]);
});

test('retired message history routes return an explicit migration error without dispatch', async () => {
  for (const name of ['session/history', 'session/peek', 'session/subagent-history']) {
    calls.length = 0;
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: { sessionId: 's' } });
    assert.equal(response.statusCode, 410, response.body);
    assert.equal(response.json().code, 'CHAT_PROTOCOL_CHANGED');
    assert.deepEqual(calls, []);
  }
});

test('native global configuration changes await the SDK result and propagate failures', async (t) => {
  for (const [name, method, body] of [
    ['mcp/global-default', 'setMcpDefault', { name: 'tools', on: false }],
    ['skills/global-toggle', 'setGlobalSkill', { name: 'skill', enabled: false }],
  ] as const) {
    await t.test(name, async (t) => {
      const pending = deferred<void>();
      const entered = deferred<void>();
      let completed = false;
      t.mock.method(engine, method, () => { entered.resolve(); return pending.promise; });
      const response = app.inject({ method: 'POST', url: `/intent/${name}`, payload: body })
        .then((result) => { completed = true; return result; });
      await entered.promise;
      assert.equal(completed, false, 'native configuration must not be acknowledged before it settles');
      pending.reject(Object.assign(new Error('Native configuration write failed'), { statusCode: 409 }));
      const result = await response;
      assert.equal(result.statusCode, 409);
      assert.equal(result.json().error, 'Native configuration write failed');
      assert.deepEqual(calls, []);
    });
  }
});

test('automatic naming waits for native completion and preserves a protected manual title', async (t) => {
  const pending = deferred<Awaited<ReturnType<ServerEngine['autoName']>>>();
  const entered = deferred<void>();
  let complete = false;
  t.mock.method(engine, 'autoName', () => { entered.resolve(); return pending.promise; });
  const response = app.inject({
    method: 'POST', url: '/intent/session/auto-name', payload: { sessionId: 's' },
  }).then(result => { complete = true; return result; });
  await entered.promise;
  assert.equal(complete, false);
  pending.resolve({ ok: true, applied: false, title: 'Manual title', reason: 'user-named' });
  const result = await response;
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { ok: true, applied: false, title: 'Manual title', reason: 'user-named' });
  assert.deepEqual(calls, [], 'transport must never add a prompt or create a naming session');
});

test('runtime/snapshot makes one query and exposes the required permission policy', async () => {
  const response = await app.inject({ method: 'POST', url: '/intent/runtime/snapshot' });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(Snapshot.parse(response.json()), projectedSnapshot());
  assert.equal(response.json().permissionPolicy, 'allow-all');
  assert.deepEqual(calls, [{ method: 'snapshot', args: [] }]);
});

test('push lifecycle is passive except confirmed fake delivery to an existing subscription', async (t) => {
  sessions = attentionSessions();
  const originalSnapshot = structuredClone(snapshot());
  const viewer = await openViewer();
  t.after(viewer.close);
  const initialFrames = [...viewer.frames];
  const endpoint = subscription.endpoint;
  const unknown = 'https://push.example/unknown';
  const globalStatus = {
    configured: true, subscriptionCount: 0, publicKey: subscription.keys.p256dh,
  };
  async function request(name: 'push/subscribe' | 'push/status' | 'push/test' | 'push/unsubscribe',
    payload: object, expected: unknown, method: string, args: unknown[]) {
    calls.length = 0;
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), expected);
    assert.deepEqual(calls, [{ method, args }], 'push lifecycle must never call the engine');
    await nextTurn();
    assert.deepEqual(viewer.frames, initialFrames, 'push lifecycle must not publish chat or inbox events');
    assert.deepEqual(snapshot(), originalSnapshot);
  }
  await request('push/status', {}, globalStatus, 'status', [undefined]);
  await request('push/status', { endpoint }, { ...globalStatus, registered: false }, 'status', [endpoint]);
  assert.equal(subscriptions.size, 0);
  assert.deepEqual(fakeDeliveries, []);
  await request('push/test', { endpoint, confirm: true },
    { status: 'failed', at: 10, error: 'Subscription is not registered' }, 'test', [endpoint, true]);
  assert.equal(subscriptions.size, 0, 'test cannot register a missing endpoint');
  assert.deepEqual(fakeDeliveries, []);
  await request('push/subscribe', { subscription }, { ok: true }, 'subscribe', [subscription]);
  await request('push/subscribe', { subscription }, { ok: true }, 'subscribe', [subscription]);
  assert.deepEqual([...subscriptions.values()], [subscription], 'registration is keyed by endpoint');
  const registeredStatus = { ...globalStatus, subscriptionCount: 1 };
  await request('push/status', {}, registeredStatus, 'status', [undefined]);
  await request('push/status', { endpoint }, { ...registeredStatus, registered: true }, 'status', [endpoint]);
  assert.deepEqual(fakeDeliveries, [], 'registration and status do not test delivery');
  await request('push/test', { endpoint: unknown, confirm: true },
    { status: 'failed', at: 10, error: 'Subscription is not registered' }, 'test', [unknown, true]);
  assert.deepEqual(fakeDeliveries, [], 'another registered endpoint must not be used as a fallback');
  const delivery: PushDelivery = { status: 'accepted', at: 11 };
  await request('push/test', { endpoint, confirm: true }, delivery, 'test', [endpoint, true]);
  assert.deepEqual(fakeDeliveries, [{ endpoint, delivery }], 'only a fake service acceptance is recorded');
  await request('push/status', {}, { ...registeredStatus, lastDelivery: delivery }, 'status', [undefined]);
  await request('push/status', { endpoint },
    { ...registeredStatus, registered: true, lastDelivery: delivery }, 'status', [endpoint]);
  await request('push/status', { endpoint: unknown },
    { ...registeredStatus, registered: false }, 'status', [unknown]);
  await request('push/unsubscribe', { endpoint: unknown }, { ok: true }, 'unsubscribe', [unknown]);
  assert.equal(subscriptions.size, 1, 'removing an unknown endpoint keeps existing registrations');
  await request('push/unsubscribe', { endpoint }, { ok: true }, 'unsubscribe', [endpoint]);
  await request('push/unsubscribe', { endpoint }, { ok: true }, 'unsubscribe', [endpoint]);
  assert.equal(subscriptions.size, 0);
  await request('push/status', { endpoint },
    { ...globalStatus, registered: false, lastDelivery: delivery }, 'status', [endpoint]);
  await request('push/test', { endpoint, confirm: true },
    { status: 'failed', at: 10, error: 'Subscription is not registered' }, 'test', [endpoint, true]);
  assert.deepEqual(fakeDeliveries, [{ endpoint, delivery }], 'status/unsubscribe never send or replay a delivery');
  assert.equal(app.server.listening, false);
});

test('push/test requires exactly confirm:true before invoking the fake manager', async () => {
  subscriptions.set(subscription.endpoint, subscription);
  for (const confirm of [undefined, false, 'true', 'false', 1, 0, null, [], {}]) {
    const response = await app.inject({
      method: 'POST', url: '/intent/push/test', payload: { endpoint: subscription.endpoint, confirm },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, 'INVALID_INTENT_BODY');
    assert.deepEqual(calls, []);
    assert.deepEqual(fakeDeliveries, []);
    assert.deepEqual([...subscriptions.values()], [subscription]);
  }
});

test('push endpoints and malformed subscription crypto are rejected before fake dispatch', async () => {
  const { p256dh, auth } = subscription.keys;
  assert.equal(Buffer.from(p256dh, 'base64url').length, 65);
  assert.equal(Buffer.from(p256dh, 'base64url')[0], 4);
  assert.equal(Buffer.from(auth, 'base64url').length, 16);
  const invalidSubscriptions = [
    {}, { ...subscription, keys: undefined }, { ...subscription, keys: null },
    ...[
      {}, { p256dh }, { auth }, { p256dh: 42, auth }, { p256dh, auth: 42 },
      { p256dh: 'key', auth }, { p256dh, auth: 'auth' },
      { p256dh: `${p256dh}=`, auth }, { p256dh, auth: `${auth}==` },
      { p256dh: `${p256dh.slice(0, -1)}B`, auth },
      { p256dh, auth: `${auth.slice(0, -1)}B` },
      { p256dh: `+${p256dh.slice(1)}`, auth },
      { p256dh, auth: `/${auth.slice(1)}` },
      { p256dh: ecdh.getPublicKey(undefined, 'compressed').toString('base64url'), auth },
      { p256dh, auth: Buffer.alloc(15).toString('base64url') },
      { p256dh, auth: Buffer.alloc(17).toString('base64url') },
    ].map((keys) => ({ ...subscription, keys })),
  ];
  const invalid: [IntentName, object][] = invalidSubscriptions.map((value) =>
    ['push/subscribe', { subscription: value }]);
  for (const endpoint of [null, 42, '', 'http://push.example/sub', 'https://user:pass@push.example/sub',
    'https://push.example/sub#fragment', 'https://127.0.0.1/sub', ' https://push.example/sub']) {
    invalid.push(['push/subscribe', { subscription: { ...subscription, endpoint } }]);
    for (const name of ['push/status', 'push/test', 'push/unsubscribe'] as const) {
      invalid.push([name, { endpoint, ...(name === 'push/test' ? { confirm: true } : {}) }]);
    }
  }
  for (const [name, payload] of invalid) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload });
    assert.equal(response.statusCode, 400, `${name}: ${JSON.stringify(payload)}: ${response.body}`);
    assert.equal(response.json().code, 'INVALID_INTENT_BODY');
    assert.deepEqual(calls, []);
  }
  assert.equal(subscriptions.size, 0);
  assert.deepEqual(fakeDeliveries, []);
});

test('push status and delivery typed failures pass through without engine calls', async (t) => {
  for (const status of ['accepted', 'failed', 'expired'] as const) {
    await t.test(status, async (t) => {
      const delivery: PushDelivery = { status, at: 123, ...(status === 'accepted' ? {} : { error: 'Safe failure' }) };
      const result: PushStatus = {
        configured: false, registered: false, subscriptionCount: 0, publicKey: null,
        error: 'Push is not configured', lastDelivery: delivery,
      };
      t.mock.method(fakePush, 'status', (...args: unknown[]) => record('status', args, result));
      t.mock.method(fakePush, 'test', async (...args: unknown[]) => record('test', args, delivery));
      for (const [name, expected, method, args] of [
        ['push/status', result, 'status', [undefined]],
        ['push/test', delivery, 'test', [subscription.endpoint, true]],
      ] as const) {
        calls.length = 0;
        const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: cases[name].body });
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), expected);
        assert.deepEqual(calls, [{ method, args }]);
      }
      assert.deepEqual(fakeDeliveries, []);
    });
  }
});

test('inbox/seen delegates the observed waterline to the synchronous product-state owner', async (t) => {
  for (const [label, currentId, observedId, shouldMark] of [
    ['stale', 7, 6, false], ['future', 7, 8, false], ['current', 7, 7, true],
    ['zero is stale', 7, 0, false], ['zero is current', 0, 0, true],
    ['omitted acknowledges current', 7, undefined, true],
    ['legacy zero', undefined, 0, true], ['legacy future', undefined, 1, false],
    ['legacy omitted', undefined, undefined, true],
    ['null meta zero', null, 0, true], ['null meta future', null, 1, false],
    ['null meta omitted', null, undefined, true],
  ] as const) {
    await t.test(label, async (t) => {
      void currentId;
      void shouldMark;
      t.mock.method(engine, 'getMeta', () => { throw new Error('Seen must not depend on a native metadata read'); });
      calls.length = 0;
      const response = await app.inject({
        method: 'POST', url: '/intent/inbox/seen', payload: { sessionId: 's', attnId: observedId },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { ok: true });
      assert.deepEqual(calls, [
        { method: 'markSeen', args: observedId === undefined ? ['s'] : ['s', observedId] },
      ]);
      assert.deepEqual(fakeDeliveries, []);
    });
  }
});

test('inbox/seen rejects invalid observed counters before reading or mutating metadata', async () => {
  for (const attnId of [null, -1, 1.5, '0', false, Number.MAX_SAFE_INTEGER + 1]) {
    const response = await app.inject({
      method: 'POST', url: '/intent/inbox/seen', payload: { sessionId: 's', attnId },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, 'INVALID_INTENT_BODY');
    assert.deepEqual(calls, []);
  }
});

test('inbox/seen performs one synchronous product-state action without a native preflight', async (t) => {
  let meta = { ...busySession, attention: 'ready' as const, attnId: 7, seenId: 6 };
  const order: string[] = [];
  t.mock.method(engine, 'getMeta', () => { throw new Error('Unexpected native metadata read'); });
  t.mock.method(engine, 'markSeen', (...args: unknown[]) => {
    order.push('markSeen');
    assert.equal(args[1], meta.attnId);
    meta = { ...meta, seenId: meta.attnId };
    queueMicrotask(() => {
      order.push('new attention');
      meta = { ...meta, attnId: 8 };
    });
    return record('markSeen', args, undefined);
  });
  const response = await app.inject({
    method: 'POST', url: '/intent/inbox/seen', payload: { sessionId: 's', attnId: 7 },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true });
  assert.deepEqual(order, ['markSeen', 'new attention']);
  assert.deepEqual(calls, [{ method: 'markSeen', args: ['s', 7] }]);
  assert.equal(meta.seenId, 7);
  assert.equal(meta.attnId, 8);
  assert.equal(unreadSessionCount([meta]), 1, 'the newly queued attention remains unread');
});

test('schema-invalid engine results are 500 INVALID_INTENT_RESULT, not request errors', async (t) => {
  const invalid = [
    ['prompt', 'prompt', { ok: 'yes' }],
    ['session/chat', 'chat', undefined],
    ['session/list', 'listLive', [{ ...busySession, status: 'not-a-status' }]],
    ['mcp/session-toggle', 'toggleSessionMcp', { ok: false, error: 'missing operation' }],
    ['runtime/snapshot', 'snapshot', { ...snapshot(), permissionPolicy: undefined }],
  ] as const;
  for (const [name, method, result] of invalid) {
    await t.test(name, async (t) => {
      const stub = t.mock.method(engine, method, () => result);
      const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: cases[name].body });
      assert.equal(response.statusCode, 500, response.body);
      assert.equal(response.json().code, 'INVALID_INTENT_RESULT');
      assert.match(response.json().error, new RegExp(`Invalid result for ${name}`));
      assert.equal(stub.mock.callCount(), 1);
    });

  }
});

test('native usage HTTP preserves unavailable context, validates counters and exposes cold failure', async t => {
  const response = await app.inject({ method: 'POST', url: '/intent/session/usage', payload: { sessionId: 's' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().context, null);
  assert.deepEqual(Intents['session/usage'].result.parse(response.json()), response.json());
  const stub = t.mock.method(engine, 'getUsage', async () => {
    throw Object.assign(new Error('Usage needs loaded runtime'), { statusCode: 409, code: 'SESSION_UNLOADED' });
  });
  const cold = await app.inject({ method: 'POST', url: '/intent/session/usage', payload: { sessionId: 's' } });
  assert.equal(cold.statusCode, 409);
  assert.equal(cold.json().code, 'SESSION_UNLOADED');
  stub.mock.restore();
  t.mock.method(engine, 'getUsage', async () => ({ ...response.json(), usage: { ...response.json().usage, lastCallOutputTokens: -1 } }));
  const invalid = await app.inject({ method: 'POST', url: '/intent/session/usage', payload: { sessionId: 's' } });
  assert.equal(invalid.statusCode, 500);
  assert.equal(invalid.json().code, 'INVALID_INTENT_RESULT');
});

test('session plan HTTP preserves descriptions and narrative without deriving a changed-file list', async t => {
  const plan = {
    planMarkdown: '# Preserved plan',
    todos: [
      { id: 'missing', title: 'No description', status: 'pending' as const },
      { id: 'normalized', title: 'Normalized native null', description: undefined, status: 'blocked' as const },
      { id: 'empty', title: 'Empty description', description: '', status: 'done' as const },
      { id: 'text', title: 'Actual description', description: 'Keep text', status: 'in_progress' as const },
    ],
  };
  t.mock.method(engine, 'getPlan', async () => plan);
  const response = await app.inject({ method: 'POST', url: '/intent/session/plan', payload: { sessionId: 's' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), JSON.parse(JSON.stringify(plan)));
  assert.deepEqual(Intents['session/plan'].result.parse(response.json()), response.json());
  assert.equal('changedFiles' in response.json(), false);
});

for (const description of [null, 0, false, {}, []]) {
  test(`session plan HTTP keeps strict description validation: ${JSON.stringify(description)}`, async t => {
    const row = { id: 'todo', title: 'Todo', status: 'pending' as const };
    Reflect.set(row, 'description', description);
    t.mock.method(engine, 'getPlan', async () => ({ planMarkdown: null, todos: [row] }));
    const response = await app.inject({ method: 'POST', url: '/intent/session/plan', payload: { sessionId: 's' } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().code, 'INVALID_INTENT_RESULT');
    assert.match(response.json().error, /description/);
  });
}

test('schedule list dispatch retains self-paced entries without ordinary cadence fields', async t => {
  const entries = [
    { id: 1, prompt: 'model controlled', recurring: true, selfPaced: true, nextRunAt: 123 },
    { id: 2, prompt: 'fixed', recurring: true, selfPaced: false, intervalMs: 60000, nextRunAt: 123 },
    { id: 3, prompt: 'once', recurring: false, at: 123, nextRunAt: 123 },
  ];
  const listing = t.mock.method(engine, 'listSchedules', async () => entries);
  const response = await app.inject({ method: 'POST', url: '/intent/schedule/list', payload: { sessionId: 's' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { entries });
  assert.equal(listing.mock.callCount(), 1);
});

for (const outcome of ['success', 'not-found', 'failure'] as const) {
  test(`schedule stop dispatch preserves ${outcome} without requesting a list`, async t => {
    const stopping = t.mock.method(engine, 'stopSchedule', async () => {
      if (outcome === 'failure') throw new Error('native stop refused');
      return outcome === 'success';
    });
    const listing = t.mock.method(engine, 'listSchedules', async () => { throw new Error('list unavailable'); });
    const response = await app.inject({ method: 'POST', url: '/intent/schedule/stop', payload: { sessionId: 's', id: 7 } });
    assert.equal(response.statusCode, outcome === 'failure' ? 500 : 200, response.body);
    if (outcome === 'failure') assert.match(response.body, /native stop refused/);
    else assert.deepEqual(response.json(), { ok: outcome === 'success' });
    assert.equal(stopping.mock.callCount(), 1);
    assert.deepEqual(stopping.mock.calls[0]!.arguments, ['s', 7]);
    assert.equal(listing.mock.callCount(), 0);
  });
}

test('valid structured operation failures remain typed 200 responses without losing details', async (t) => {
  const failure = {
    ok: false, applied: false, sessionId: 's', name: 'tools', enabled: false,
    status: 'failed' as const, error: 'connection refused',
    operation: {
      id: 'failed-op', desiredEnabled: true, state: 'failed' as const,
      startedAt: 1, status: 'failed' as const, error: 'connection refused',
    },
  };
  t.mock.method(engine, 'toggleSessionMcp', async () => failure);
  t.mock.method(engine, 'addSchedule', async () => ({ error: 'invalid interval' }));
  for (const [name, expected] of [
    ['mcp/session-toggle', failure],
    ['schedule/add', { ok: false, error: 'invalid interval' }],
  ] as const) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: cases[name].body });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), expected);
  }
});

test('result validation returns parsed data rather than leaking unknown engine fields', async (t) => {
  t.mock.method(engine, 'prompt', async () => ({ ok: true, queued: false, internal: 'not public' }));
  const response = await app.inject({ method: 'POST', url: '/intent/prompt', payload: cases.prompt.body });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, queued: false });
});

test('engine exceptions default to 500 and honor only valid statusCode and string code', async (t) => {
  const zodFailure = Intents.prompt.body.safeParse({});
  assert.equal(zodFailure.success, false);
  assert.ok(!zodFailure.success);
  for (const [error, status, code] of [
    [new Error('engine exploded'), 500, undefined],
    [zodFailure.error, 500, undefined],
    [Object.assign(new Error('busy'), { statusCode: 409, code: 'SESSION_BUSY' }), 409, 'SESSION_BUSY'],
    [Object.assign(new Error('gone'), { statusCode: 404, code: 'SESSION_NOT_FOUND' }), 404, 'SESSION_NOT_FOUND'],
    ...[200, 399, 600, 409.5, '409', NaN].map((statusCode) =>
      [Object.assign(new Error('bad status'), { statusCode, code: 123 }), 500, undefined] as const),
  ] as const) {
    await t.test(`${error.name}: status ${status}, code ${String(code)}`, async (t) => {
      t.mock.method(engine, 'prompt', async () => { throw error; });
      const response = await app.inject({ method: 'POST', url: '/intent/prompt', payload: cases.prompt.body });
      assert.equal(response.statusCode, status, response.body);
      assert.deepEqual(response.json(), { error: error.message, ...(code ? { code } : {}) });
    });
  }
});

test('a missing engine capability is an error, never a successful no-op', async (t) => {
  const original = Object.getOwnPropertyDescriptor(engine, 'cancel')!;
  t.after(() => Object.defineProperty(engine, 'cancel', original));
  Reflect.deleteProperty(engine, 'cancel');
  const response = await app.inject({ method: 'POST', url: '/intent/cancel', payload: cases.cancel.body });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(typeof response.json().error, 'string');
  assert.notEqual(response.json().ok, true);
  assert.deepEqual(calls, []);
});

test('unloaded native details return a conflict without loading a session', async (t) => {
  for (const [name, method] of [
    ['session/plan', 'getPlan'], ['session/panels', 'getPanels'],
    ['schedule/list', 'listSchedules'], ['skills/session', 'listSessionSkills'],
  ] as const) {
    await t.test(name, async (t) => {
      calls.length = 0;
      t.mock.method(engine, method, async () => {
        throw Object.assign(new Error('Explicitly resume the session first'), {
          statusCode: 409, code: 'SESSION_UNLOADED',
        });
      });
      const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: { sessionId: 's' } });
      assert.equal(response.statusCode, 409, response.body);
      assert.deepEqual(response.json(), { error: 'Explicitly resume the session first', code: 'SESSION_UNLOADED' });
      assert.deepEqual(calls, []);
    });
  }
});

test('unsupported file rollback propagates the engine rejection without a successful mutation response', async (t) => {
  let mutated = false;
  t.mock.method(engine, 'rewind', async (_sessionId, _toMsgId, rollbackFiles) => {
    if (rollbackFiles) throw new Error('Native file rollback is unsupported');
    mutated = true;
  });
  const response = await app.inject({
    method: 'POST', url: '/intent/session/rewind',
    payload: { sessionId: 's', toMsgId: 'm', rollbackFiles: true },
  });
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(response.json(), { error: 'Native file rollback is unsupported' });
  assert.equal(mutated, false);
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const interrupted of [false, true]) {
  test(`session/interrupt returns native interrupted:${interrupted} without disguising it as idle`, async t => {
    t.mock.method(engine, 'interrupt', async () => ({ ok: true as const, interrupted }));
    const response = await app.inject({ method: 'POST', url: '/intent/session/interrupt', payload: { sessionId: 's' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, interrupted });
    const capability = await app.inject({ method: 'GET', url: '/capabilities?name=session%2Finterrupt' });
    assert.match(capability.json().description, /Background work survives/);
  });
}

for (const name of ['cancel', 'session/unload', 'respondAsk', 'respondPlan', 'respondElicitation', 'queue/remove'] as const) {
  for (const reject of [false, true]) {
    test(`${name} awaits delayed ${reject ? 'rejection without false success' : 'completion before success'}`, { timeout: 3000 }, async (t) => {
      const fixture = cases[name];
      const entered = deferred();
      const pending = deferred();
      t.mock.method(engine, fixture.method, async (...args: unknown[]) => {
        record(fixture.method, args, undefined);
        entered.resolve();
        await pending.promise;
      });
      let finished = false;
      const responsePromise = app.inject({ method: 'POST', url: `/intent/${name}`, payload: fixture.body })
        .then((response) => { finished = true; return response; });
      try {
        await entered.promise;
        await nextTurn();
        assert.equal(finished, false, 'the operation is still pending');
        assert.deepEqual(calls, [{ method: fixture.method, args: fixture.args }]);
        if (reject) pending.reject(Object.assign(new Error('delayed failure'), { statusCode: 409, code: 'DECISION_STALE' }));
        else pending.resolve();
        const response = await responsePromise;
        assert.equal(response.statusCode, reject ? 409 : 200, response.body);
        assert.deepEqual(response.json(), reject
          ? { error: 'delayed failure', code: 'DECISION_STALE' } : { ok: true });
      } finally {
        pending.resolve();
        await responsePromise;
      }

    });
  }
}

test('session/interrupt awaits native outcome and propagates uncertain failure without a retry', { timeout: 3000 }, async t => {
  const entered = deferred();
  const pending = deferred<{ ok: true; interrupted: boolean }>();
  const interrupt = t.mock.method(engine, 'interrupt', () => { entered.resolve(); return pending.promise; });
  let settled = false;
  const response = app.inject({ method: 'POST', url: '/intent/session/interrupt', payload: { sessionId: 's' } })
    .then(value => { settled = true; return value; });
  await entered.promise;
  await nextTurn();
  assert.equal(settled, false);
  pending.reject(new Error('Native transport timed out; outcome unknown'));
  const result = await response;
  assert.equal(result.statusCode, 500);
  assert.match(result.json().error, /outcome unknown/);
  assert.equal(interrupt.mock.callCount(), 1);
});

for (const name of ['session/delete', 'session/purge']) {
  test(`${name} forwards explicit module unbind approval without an implicit retry`, async () => {
    const unbind = { planId: 'a'.repeat(64), operationId: 'unbind-delete-1' };
    const response = await app.inject({
      method: 'POST', url: `/intent/${name}`, payload: { sessionId: 's', confirm: true, unbind },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [{ method: 'deleteSession', args: ['s', true, unbind] }]);
  });
  test(`${name} requires protocol confirm:true and never reaches the engine otherwise`, async () => {
    for (const confirm of [undefined, false, 'true', 1, null]) {
      calls.length = 0;
      const response = await app.inject({
        method: 'POST', url: `/intent/${name}`, payload: { sessionId: 's', confirm },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(calls, []);
    }
  });
}

test('old soft-delete requests cannot silently become permanent deletion', async () => {
  for (const body of [{ sessionId: 's' }, { sessionId: 's', reason: 'declutter' }]) {
    const response = await app.inject({ method: 'POST', url: '/intent/session/delete', payload: body });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /confirm/);
    assert.deepEqual(calls, []);
  }
});

test('session/new does not pass an obsolete worker label as module selection', async () => {
  const body = { cwd: '/fixture', spawnedBy: 'obsolete' };
  const response = await app.inject({ method: 'POST', url: '/intent/session/new', payload: body });
  if (Intents['session/new'].body.safeParse(body).success) {
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls, [{ method: 'newSession', args: ['/fixture', undefined] }]);
  } else {
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(calls, []);
  }
});

test('unknown, inherited, and retired intent paths are 404 without engine calls', async () => {
  for (const name of [
    'unknown', 'constructor', '__proto__', 'toString',
    'hook/add', 'hook/list', 'hook/stop', 'hook/unknown',
    'flow/add', 'flow/list', 'flow/remove', 'flow/write-gate', 'flow/run', 'flow/unknown',
    'flow-schedule/add', 'flow-schedule/list', 'flow-schedule/stop', 'flow-schedule/unknown',
    'session/set-spawned-by', 'session/restore', 'session/trash-list',
  ]) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: {} });
    assert.equal(response.statusCode, 404, `${name}: ${response.body}`);
    assert.deepEqual(calls, [], name);
  }
});

test('the origin gate protects valid intents, including bodyless mutations', async () => {
  for (const name of ['session/new', 'skills/refresh', 'mcp/refresh', 'session/purge']) {
    const response = await app.inject({
      method: 'POST', url: `/intent/${name}`,
      headers: { origin: 'https://untrusted.example', host: '127.0.0.1:8771' },
      payload: { cwd: '/fixture', sessionId: 's', confirm: true },
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(calls, []);
  }
});

async function upload(name: string, mime: string, bytes = Buffer.from('fixture bytes')) {
  const query = new URLSearchParams({ name, mime });
  const response = await app.inject({
    method: 'POST', url: `/upload?${query}`,
    headers: { 'content-type': 'application/octet-stream' }, payload: bytes,
  });
  assert.equal(response.statusCode, 200, response.body);
  const file = UploadedFile.parse(response.json());
  assert.equal(relative(process.cwd(), file.path), join(uploadDir, basename(file.path)));
  return file;
}

function firstMessageServerFixture(t: TestContext) {
  const root = join(process.cwd(), `.session-start-server-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userRoot = join(root, 'u'), received: InternalSessionStart[] = [];
  const effects = { creates: 0, sends: 0 };
  let paused: Promise<unknown> | undefined, failSend = false;
  const started = deferred();
  const native = { async startSession(input: InternalSessionStart): Promise<{ ok: true }> {
    received.push(input);
    await input.beforeCreate?.(input.sessionId);
    effects.creates++;
    writeFileSync(join(root, `${input.sessionId}.created`), 'one native creation');
    started.resolve();
    if (paused) await paused;
    effects.sends++;
    if (failSend) throw new Error('First message acceptance was lost');
    return { ok: true };
  } };
  const starts = createSessionStarts(native, userRoot);
  setTestDependencies({ engine, push: fakePush, modules: fakeModules, starts });
  return { root, userRoot, native, starts, received, effects, started,
    pause(value: Promise<unknown>) { paused = value; }, fail() { failSend = true; } };
}

test('session/start validates real content and retained files before any planned/native identity', async t => {
  const f = firstMessageServerFixture(t);
  for (const body of [
    { text: '' }, { text: ' \n ' }, { text: '', parts: [{ type: 'text', text: '\t ' }] },
    { text: 'real', sessionId: randomUUID() },
    { text: '', attachment: { kind: 'file', name: 'secret', url: 'file:///etc/passwd' } },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/intent/session/start',
      payload: { operationId: 'invalid-first-message', cwd: f.root, ...body } });
    assert.equal(response.statusCode, 400, response.body);
  }
  const missing = await app.inject({ method: 'POST', url: '/intent/session/start',
    payload: { operationId: 'missing-first-file', cwd: f.root, text: '', attachment: { kind: 'file', name: 'missing', url: '/uploads/missing.txt' } } });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.deepEqual(f.effects, { creates: 0, sends: 0 });
  assert.equal(existsSync(f.userRoot), false);
  const read = await app.inject({ method: 'POST', url: '/intent/session/start/get', payload: { operationId: 'missing-first-file' } });
  assert.deepEqual(read.json(), { operation: null });
  assert.equal(existsSync(f.userRoot), false);
});

test('session/start resolves authoritative attachment metadata, associates planned identity, and sends exactly once', async t => {
  const f = firstMessageServerFixture(t);
  const file = await upload('authoritative-first-image.png', 'image/png', pngFixture);
  const body = { operationId: 'first-image-operation', cwd: f.root, modules: [{ moduleId: 'assistant', roleId: 'assistant' }], text: '',
    parts: [{ type: 'text', text: 'Before\n' }, { type: 'file', attachment: { kind: 'file', name: 'forged.txt',
      url: file.url, path: '/etc/passwd', mime: 'text/plain', size: 1 } }, { type: 'text', text: '\nAfter' }] };
  const first = await app.inject({ method: 'POST', url: '/intent/session/start', payload: body });
  assert.equal(first.statusCode, 200, first.body);
  const operation = first.json().operation;
  assert.equal(operation.state, 'accepted');
  assert.equal(f.received[0]?.sessionId, operation.sessionId);
  assert.deepEqual(f.received[0]?.attachments, [{ type: 'file', path: file.path, displayName: file.name }]);
  assert.ok(f.received[0]?.text.startsWith('Before\n<cockpit-attachment'));
  assert.ok(f.received[0]?.text.endsWith('\nAfter'));
  assert.ok(f.received[0]?.text.includes('kind="image"'));
  assert.equal(f.received[0]?.text.includes('forged.txt'), false);
  const details = await app.inject({ method: 'POST', url: '/intent/files/get', payload: { url: file.url } });
  assert.ok(details.json().sessions.includes(operation.sessionId));
  assert.deepEqual((await app.inject({ method: 'POST', url: '/intent/session/start', payload: body })).json(), first.json());
  assert.deepEqual((await app.inject({ method: 'POST', url: '/intent/session/start/get', payload: { operationId: body.operationId } })).json(), first.json());
  assert.deepEqual(f.effects, { creates: 1, sends: 1 });
  const changed = await app.inject({ method: 'POST', url: '/intent/session/start',
    payload: { ...body, parts: [{ type: 'text', text: 'different request' }] } });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().code, 'SESSION_START_CONFLICT');
  assert.deepEqual(f.effects, { creates: 1, sends: 1 });
});

test('session/start supports file-only and attachment-array forms without manufacturing first-message text', async t => {
  const f = firstMessageServerFixture(t);
  const file = await upload('file-only.txt', 'text/plain');
  for (const [operationId, content] of [
    ['single-first-file', { attachment: file }],
    ['array-first-file', { attachments: [file] }],
  ] as const) {
    const response = await app.inject({ method: 'POST', url: '/intent/session/start', payload: {
      operationId, cwd: f.root, text: '', ...content,
    } });
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.deepEqual(f.effects, { creates: 2, sends: 2 });
  assert.ok(f.received.every(input => input.text.startsWith('<cockpit-attachment')));
  assert.ok(f.received.every(input => input.attachments?.length === 1));
});

test('session/start corrupted managed original fails before claim rather than creating an empty native session', async t => {
  const f = firstMessageServerFixture(t);
  const file = await upload('corrupt-first.txt', 'text/plain');
  writeFileSync(file.path, 'tampered original');
  const response = await app.inject({ method: 'POST', url: '/intent/session/start', payload: {
    operationId: 'corrupt-first-file', cwd: f.root, text: '', attachment: file,
  } });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(existsSync(f.userRoot), false);
  assert.deepEqual(f.effects, { creates: 0, sends: 0 });
});

test('session/start failure returns inspectable unknown operation and retains artifacts without retry', async t => {
  const f = firstMessageServerFixture(t);
  const file = await upload('retained-first.txt', 'text/plain');
  const body = { operationId: 'lost-first-acceptance', cwd: f.root, text: 'private first-message content', attachment: file };
  f.fail();
  const response = await app.inject({ method: 'POST', url: '/intent/session/start', payload: body });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'SESSION_START_UNKNOWN');
  assert.equal(response.json().operation.state, 'unknown');
  assert.equal(response.json().sessionId, response.json().operation.sessionId);
  const result = await app.inject({ method: 'POST', url: '/intent/session/start/get', payload: { operationId: body.operationId } });
  assert.deepEqual(result.json(), { operation: response.json().operation });
  const duplicate = await app.inject({ method: 'POST', url: '/intent/session/start', payload: body });
  assert.deepEqual(duplicate.json(), result.json());
  assert.deepEqual(f.effects, { creates: 1, sends: 1 });
  const stored = await app.inject({ method: 'POST', url: '/intent/files/get', payload: { url: file.url } });
  assert.ok(stored.json().sessions.includes(response.json().sessionId));
  assert.equal(readFileSync(join(f.userRoot, 'session-starts', `${body.operationId}.json`), 'utf8').includes(body.text), false);
});

test('session/start remains server lifecycle busy through preparation and duplicate readback is non-dispatching', async t => {
  const f = firstMessageServerFixture(t), pending = deferred();
  f.pause(pending.promise);
  t.mock.method(engine, 'busyCount', async () => 0);
  const body = { operationId: 'busy-first-message', cwd: f.root, text: 'Real first input' };
  const first = app.inject({ method: 'POST', url: '/intent/session/start', payload: body });
  await f.started.promise;
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/admin/lifecycle' })).json().busy, 1);
    const duplicate = await app.inject({ method: 'POST', url: '/intent/session/start', payload: body });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().operation.state, 'creating');
    assert.deepEqual(f.effects, { creates: 1, sends: 0 });
  } finally { pending.resolve(); }
  assert.equal((await first).json().operation.state, 'accepted');
  assert.equal((await app.inject({ method: 'GET', url: '/admin/lifecycle' })).json().busy, 0);
  assert.deepEqual(f.effects, { creates: 1, sends: 1 });
});

test('managed files preserve originals, source identity, session associations and safe seek downloads', async () => {
  const bytes = Buffer.concat([Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'), Buffer.alloc(160, 7)]);
  const query = new URLSearchParams({ name: 'movie original.mp4', mime: 'video/mp4',
    source: 'weixin', sessionId: 's', sourceId: 'fixture-message:item-0' });
  const send = (payload = bytes) => app.inject({ method: 'POST', url: `/upload?${query}`,
    headers: { 'content-type': 'application/octet-stream' }, payload });
  const first = await send();
  assert.equal(first.statusCode, 200, first.body);
  const file = UploadedFile.parse(first.json());
  assert.equal(file.mime, 'video/mp4');
  assert.equal(file.kind, 'file');
  assert.equal(file.source, 'weixin');
  assert.equal(file.sha256?.length, 64);
  assert.deepEqual((await send()).json(), file, 'identical source retry returns original retained identity');
  assert.equal((await send(Buffer.from('different bytes'))).statusCode, 409);
  const get = await app.inject({ method: 'POST', url: '/intent/files/get', payload: { url: file.url } });
  assert.deepEqual(get.json(), { ...file, sessions: ['s'] });
  const list = await app.inject({ method: 'POST', url: '/intent/files/list', payload: { sessionId: 's', query: 'movie', limit: 1 } });
  assert.deepEqual(list.json().files, [file]);
  assert.equal((await app.inject({ method: 'POST', url: '/intent/files/associate',
    payload: { url: file.url, sessionId: 'another' } })).statusCode, 200);
  const related = await app.inject({ method: 'POST', url: '/intent/files/list', payload: { sessionId: 'another' } });
  assert.deepEqual(related.json().files, [file]);
  const details = await app.inject({ method: 'POST', url: '/intent/files/get', payload: { url: file.url } });
  assert.deepEqual(details.json().sessions, ['another', 's']);
  const deletion = await app.inject({ method: 'POST', url: '/intent/session/delete',
    payload: { sessionId: 's', confirm: true } });
  assert.deepEqual(deletion.json(), { ok: true });
  onEngineEvent({ type: 'session/removed', sessionId: 's' });
  assert.deepEqual((await app.inject({ method: 'POST', url: '/intent/files/get',
    payload: { url: file.url } })).json(), details.json(), 'session deletion retains file metadata and associations');
  assert.deepEqual((await app.inject({ method: 'POST', url: '/intent/files/list',
    payload: { sessionId: 's' } })).json().files, [file]);
  for (const [range, start, end] of [['bytes=10-29', 10, 29], ['bytes=-5', bytes.length - 5, bytes.length - 1],
    ['bytes=12-', 12, bytes.length - 1]] as const) {
    const response = await app.inject({ method: 'GET', url: file.url, headers: { range } });
    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(response.rawPayload, bytes.subarray(start, end + 1));
  }
  for (const range of ['bytes=99999-', 'bytes=2-1', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=-']) {
    assert.equal((await app.inject({ method: 'GET', url: file.url, headers: { range } })).statusCode, 416);
  }
  const download = await app.inject({ method: 'GET', url: `${file.url}?download=1` });
  assert.deepEqual(download.rawPayload, bytes);
  assert.match(String(download.headers['content-disposition']), /attachment; filename\*=UTF-8''movie%20original.mp4/);
  const head = await app.inject({ method: 'HEAD', url: file.url });
  assert.equal(head.headers['content-length'], String(bytes.length));
  assert.equal(head.rawPayload.length, 0);
});

test('an uploaded original remains reusable for ordered cross-session attachment delivery', async () => {
  const file = await upload('kept.png', 'image/png', pngFixture);
  assert.equal(file.mime, 'image/png');
  assert.deepEqual(readFileSync(file.path), pngFixture);
  calls.length = 0;
  const again = await app.inject({ method: 'POST', url: '/intent/files/get', payload: { url: file.url } });
  assert.deepEqual(again.json(), { ...file, sessions: [] });
  assert.deepEqual(calls, [], 'retained source remains usable without loading or re-reading native history');
  const parts = [{ type: 'text', text: 'Before\n' }, { type: 'file', attachment: file },
    { type: 'text', text: '\nBetween\n' }, { type: 'file', attachment: file }, { type: 'text', text: '\nAfter' }];
  const sent = await app.inject({ method: 'POST', url: '/intent/prompt', payload: { sessionId: 'another', text: '', parts } });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.deepEqual(calls[0]?.args[3], [
    { type: 'file', path: file.path, displayName: file.name }, { type: 'file', path: file.path, displayName: file.name },
  ]);
  const prompt = String(calls[0]?.args[1]);
  assert.match(prompt, /^Before\n<cockpit-attachment version="2"/);
  assert.ok(prompt.indexOf('Between') > prompt.indexOf('<cockpit-attachment'));
  assert.ok(prompt.endsWith('\nAfter'));
  assert.equal((await app.inject({ method: 'POST', url: '/intent/prompt',
    payload: { sessionId: 's', text: '', parts, attachment: file } })).statusCode, 400);
});

test('repeated display of one uploaded image does not store another copy or read native history', async () => {
  const file = await upload('published-once.png', 'image/png', pngFixture);
  const before = readdirSync(uploadDir).sort();
  calls.length = 0;
  for (let i = 0; i < 2; i++) {
    const displayed = await app.inject({ method: 'GET', url: file.url });
    assert.equal(displayed.statusCode, 200);
    assert.deepEqual(displayed.rawPayload, pngFixture);
  }
  assert.deepEqual(readdirSync(uploadDir).sort(), before);
  assert.deepEqual(calls, [], 'display does not query native history or publish another file');
});

test('retired native image lookups fail explicitly without reading history or collecting files', async () => {
  const before = existsSync(uploadDir) ? readdirSync(uploadDir).sort() : [];
  for (const name of ['session/tool-image', 'files/from-tool-image']) {
    assert.equal(isIntentName(name), false);
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`,
      payload: { sessionId: 's', image: { eventId: 'event', toolCallId: 'tool', part: 0 } } });
    assert.equal(response.statusCode, 410);
    assert.equal(response.json().code, 'NATIVE_IMAGE_LOOKUP_RETIRED');
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(existsSync(uploadDir) ? readdirSync(uploadDir).sort() : [], before);
});

test('declared image MIME cannot turn arbitrary bytes into a preview', async () => {
  const file = await upload('pretend.png', 'image/png', Buffer.from('<script>alert(1)</script>'));
  assert.equal(file.mime, 'application/octet-stream');
  assert.equal(file.kind, 'file');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://invalid.example/x"/></svg>');
  const original = await upload('drawing.svg', 'image/svg+xml', svg);
  assert.equal(original.mime, 'image/svg+xml');
  const served = await app.inject({ method: 'GET', url: original.url });
  assert.deepEqual(served.rawPayload, svg, 'original SVG is not renamed or silently rasterized');
  assert.match(String(served.headers['content-security-policy']), /sandbox; default-src 'none'/);
});

test('uploads round-trip literal percent names and authoritative MIME regardless of extension', async () => {
  for (const [name, mime, kind] of [
    ['100% ready%2F%25.png', 'image/png', 'image'],
    ['extensionless', 'image/png', 'image'],
    ['photo.txt', 'image/webp', 'image'],
    ['document.png', 'application/octet-stream', 'file'],
  ] as const) {
    const bytes = mime === 'image/png' ? pngFixture : mime === 'image/webp'
      ? Buffer.from('524946461a000000574542505650384c0d0000002f00000000071011118888fe0700', 'hex')
      : Buffer.from(`inert fixture for ${name}`);
    const file = await upload(name, mime, bytes);
    assert.equal(file.name, name, 'Fastify query decoding happens exactly once');
    assert.equal(file.mime, mime);
    assert.equal(file.kind, kind);
    assert.equal(file.size, bytes.length);
    const served = await app.inject({ method: 'GET', url: file.url });
    assert.equal(served.statusCode, 200, served.body);
    assert.deepEqual(served.rawPayload, bytes);
    assert.equal(served.headers['content-type'], mime);
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.match(String(served.headers['content-security-policy']), /(?:^|;)\s*sandbox(?:;|$)/);
    assert.match(String(served.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(served.headers['cache-control'], 'private, max-age=31536000, immutable');

    for (const caption of ['', 'Caption with 中文 and\nnewlines']) {
      calls.length = 0;
      const response = await app.inject({
        method: 'POST', url: '/intent/prompt',
        payload: {
          sessionId: 's', text: caption, mode: 'immediate',
          attachment: {
            ...file, kind: kind === 'image' ? 'file' : 'image', name: 'forged.exe',
            mime: 'application/x-forged', size: 99999, path: '/forged/outside-project',
            storedName: 'forged-stored-name',
          },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { ok: true, queued: true });
      assert.deepEqual(calls, [{
        method: 'prompt',
        args: ['s', attachmentPrompt(file, caption), 'immediate', [
          { type: 'file', path: file.path, displayName: name },
        ]],
      }]);
      assert.ok(!String(calls[0]?.args[1]).includes('forged'));
    }
  }
  assert.equal(app.server.listening, false);
});

test('upload defaults are schema-validated and text-only prompts still pass exactly three arguments', async (t) => {
  const parse = t.mock.method(UploadedFile, 'parse');
  const response = await app.inject({
    method: 'POST', url: '/upload', headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('default fixture'),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(parse.mock.callCount(), 1, 'upload response must pass the authoritative schema');
  assert.equal(response.json().name, 'file');
  assert.equal(response.json().mime, 'application/octet-stream');
  assert.equal(response.json().kind, 'file');
  const prompt = await app.inject({
    method: 'POST', url: '/intent/prompt', payload: { sessionId: 's', text: 'text only' },
  });
  assert.equal(prompt.statusCode, 200, prompt.body);
  assert.deepEqual(calls, [{ method: 'prompt', args: ['s', 'text only', undefined] }]);
});

test('unsafe attachment URLs and malformed attachments are rejected before any engine call', async () => {
  const attachment = { kind: 'file', name: 'fixture', url: '/uploads/missing.txt' };
  for (const url of [
    'https://example.invalid/file', '//example.invalid/file', 'file:///etc/passwd',
    '/etc/passwd', '/uploads/', '/uploads/../secret', '/uploads/a..txt',
    '/uploads/sub/file', '/uploads/sub\\file', '/uploads/%2e%2e%2fsecret',
    '/uploads/%252e%252e%252fsecret', '/uploads/%66ile.txt',
    '/uploads/file.txt?download=1', '/uploads/file.txt#preview',
    '/uploads/file.txt\n', '/uploads/file.txt\0', '/uploads/.hidden',
  ]) {
    const response = await app.inject({
      method: 'POST', url: '/intent/prompt',
      payload: { sessionId: 's', text: '', attachment: { ...attachment, url } },
    });
    assert.equal(response.statusCode, 400, `${JSON.stringify(url)}: ${response.body}`);
    assert.equal(response.json().code, 'INVALID_INTENT_BODY');
    assert.deepEqual(calls, []);
  }
  for (const value of [null, [], [attachment], { ...attachment, mime: 42 }, { ...attachment, kind: 'video' }]) {
    const response = await app.inject({
      method: 'POST', url: '/intent/prompt', payload: { sessionId: 's', text: '', attachment: value },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, 'INVALID_INTENT_BODY');
    assert.deepEqual(calls, []);
  }
  const missing = await app.inject({
    method: 'POST', url: '/intent/prompt', payload: { sessionId: 's', text: '', attachment },
  });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.match(missing.json().error, /not found/i);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(uploadDir), false, 'invalid attachments must not create upload storage');
});

test('upload rejects unknown/repeated queries and invalid MIME before writing any files', async () => {
  const queries = [
    'name=a&name=b', 'name=a&name=a', 'mime=image/png&mime=image/png',
    'mime=image/png&mime=text/plain', 'name=a&path=elsewhere', 'extra=value',
    'name[]=a', 'mime[]=image/png',
    ...['invalid', 'image/', '/png', 'image/png\r\nX-Injected: yes', 'text/plain\n',
      'image/png;broken', 'image/png; charset="unterminated', 'x'.repeat(513)]
      .map((mime) => new URLSearchParams({ name: 'fixture', mime }).toString()),
  ];
  for (const query of queries) {
    const response = await app.inject({
      method: 'POST', url: `/upload?${query}`,
      headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('fixture'),
    });
    assert.equal(response.statusCode, 400, `${query}: ${response.body}`);
    assert.equal(typeof response.json().error, 'string');
    assert.equal(existsSync(uploadDir), false);
    assert.deepEqual(calls, []);
  }
  const empty = await app.inject({
    method: 'POST', url: '/upload?name=empty',
    headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(0),
  });
  assert.equal(empty.statusCode, 400, empty.body);
  assert.equal(existsSync(uploadDir), false);
});

test('missing, malformed, and mismatched upload sidecars fail serving and attachment dispatch explicitly', async () => {
  for (const corrupt of ['missing', 'json', 'mime', 'size', 'storedName', 'version', 'name'] as const) {
    const file = await upload('authoritative.png', 'image/png');
    const sidecar = join(uploadDir, '.metadata', `${basename(file.path)}.json`);
    const original = readFileSync(sidecar, 'utf8');
    const metadata = JSON.parse(original);
    if (corrupt === 'missing') rmSync(sidecar);
    else if (corrupt === 'json') writeFileSync(sidecar, '{invalid json');
    else {
      const changes = {
        mime: 'image/png\r\nbad: header', size: file.size + 1,
        storedName: 'other-file.png', version: 2, name: 'bad\nname',
      };
      writeFileSync(sidecar, JSON.stringify({ ...metadata, [corrupt]: changes[corrupt] }));
    }
    const served = await app.inject({ method: 'GET', url: file.url });
    assert.equal(served.statusCode, 500, `${corrupt}: ${served.body}`);
    assert.match(served.json().message, /metadata/i);
    const prompt = await app.inject({
      method: 'POST', url: '/intent/prompt', payload: { sessionId: 's', text: '', attachment: file },
    });
    assert.equal(prompt.statusCode, 500, `${corrupt}: ${prompt.body}`);
    assert.match(prompt.json().error, /metadata/i);
    assert.notEqual(prompt.json().code, 'INVALID_INTENT_BODY');
    assert.notEqual(prompt.json().code, 'INVALID_INTENT_RESULT');
    assert.deepEqual(calls, [], corrupt);
  }
  assert.ok(readdirSync(uploadDir).length > 0);
});

test('health/status and restart use only injected state and retain every busy safeguard', async () => {
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.json().ok, true);
  assert.equal(health.json().login, 'test-only');
  assert.match(health.json().instanceId, /^[a-f0-9-]{36}$/);
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal((await app.inject({ method: 'GET', url: '/version' })).statusCode, 503,
    'Source mode must not invent immutable runtime provenance');
  for (const state of [
    { status: 'running' }, { status: 'idle', activeSubagents: 1 },
    { status: 'idle', activeMcpOperations: 1 }, { status: 'idle', compacting: true },
    { status: 'idle', ask: { requestId: 'r', question: 'choose' } },
    { status: 'idle', planRequest: { requestId: 'r', summary: 'plan' } },
    { status: 'idle', elicitation: { requestId: 'r', message: 'choose' } },
  ]) {
    sessions = [SessionMeta.parse({ ...busySession, ...state })];
    const status = await app.inject({ method: 'GET', url: '/status' });
    assert.equal(status.json().busy, 1);
    const restart = await app.inject({ method: 'POST', url: '/admin/restart', payload: { pending: true } });
    assert.deepEqual(restart.json(), { restartPending: true, busy: 1, willRestartWhenIdle: true });
    const disarm = await app.inject({ method: 'POST', url: '/admin/restart', payload: { pending: false } });
    assert.deepEqual(disarm.json(), { restartPending: false, busy: 1, willRestartWhenIdle: false });
  }
});

test('status reads its projection and fresh safety, not the UI snapshot or global models', async () => {
  const status = await app.inject({ method: 'GET', url: '/status' });
  assert.equal(status.statusCode, 200);
  assert.ok(calls.some(call => call.method === 'sessionStatus'));
  assert.ok(!calls.some(call => ['snapshot', 'getMeta'].includes(call.method)));
  assert.equal(status.json().busy, 1);
});
async function openViewer(expected: Snapshot = projectedSnapshot()) {
  const connection = await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
  const frames: string[] = [];
  let pending = '';
  let closed = false;
  const stream = connection.stream();
  stream.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    let end: number;
    while ((end = pending.indexOf('\n\n')) >= 0) {
      frames.push(pending.slice(0, end));
      pending = pending.slice(end + 2);
    }
  });
  function close(): void {
    if (closed) return;
    closed = true;
    connection.raw.res.req.emit('close');
    connection.raw.res.end();
    stream.destroy();
  }
  try {
    await nextTurn();
    assert.equal(connection.statusCode, 200);
    assert.match(String(connection.headers['content-type']), /text\/event-stream/);
    assert.equal(connection.headers['x-accel-buffering'], 'no');
    assert.equal(connection.headers['cache-control'], 'no-cache, no-transform');
    assert.deepEqual(frames, ['retry: 2000', `data: ${JSON.stringify(expected)}`]);
    Snapshot.parse(JSON.parse(frames[1]!.slice(6)));
    return { connection, frames, close };
  } catch (error) {
    close();
    throw error;
  }
}

test('snapshot intents, initial SSE, and engine events project unread counts without inventing revisions', async (t) => {
  for (const counters of [{}, { unreadCount: 0 }, { unreadCount: 0, inboxRevision: 0 },
    { unreadCount: 9, inboxRevision: 31 }, { inboxRevision: 32 }]) {
    await t.test(JSON.stringify(counters), async (t) => {
      sessions = attentionSessions();
      assert.equal(unreadSessionCount(sessions), 2, 'seen choices and legacy absent IDs are not unread');
      const raw: Snapshot = { ...snapshot(), ...counters };
      const original = structuredClone(raw);
      const expected = projectedSnapshot(raw);
      assert.equal(expected.unreadCount, counters.unreadCount ?? 2);
      t.mock.method(engine, 'snapshot', () => record('snapshot', [], raw));
      t.mock.method(engine, 'attentionCount', () => { throw new Error('must derive unread from snapshot'); });
      calls.length = 0;
      const response = await app.inject({ method: 'POST', url: '/intent/runtime/snapshot', payload: {} });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), expected);
      assert.deepEqual(calls, [{ method: 'snapshot', args: [] }]);
      const viewer = await openViewer(expected);
      t.after(viewer.close);
      assert.deepEqual(calls, [{ method: 'snapshot', args: [] }, { method: 'snapshot', args: [] }]);
      const eventSnapshot: Snapshot = { ...raw, sessions: [...raw.sessions].reverse() };
      calls.length = 0;
      onEngineEvent(eventSnapshot);
      await nextTurn();
      assert.deepEqual(viewer.frames, [
        'retry: 2000', `data: ${JSON.stringify(expected)}`,
        `data: ${JSON.stringify(projectedSnapshot(eventSnapshot))}`,
      ]);
      assert.deepEqual(calls, [], 'snapshot events project their own sessions without re-querying the engine');
      assert.deepEqual(raw, original, 'projection does not mutate the engine snapshot');
      assert.equal(Object.hasOwn(eventSnapshot, 'unreadCount'), Object.hasOwn(counters, 'unreadCount'));
      if (!Object.hasOwn(counters, 'inboxRevision')) {
        assert.equal(Object.hasOwn(response.json(), 'inboxRevision'), false);
        for (const frame of viewer.frames.slice(1)) {
          assert.equal(Object.hasOwn(JSON.parse(frame.slice(6)), 'inboxRevision'), false);
        }
      }
    });
  }
});

type NotifyEvent = Extract<ServerEvent, { type: 'session/notify' }>;
test('session/notify uses committed event counters without a native snapshot or metadata read', async (t) => {
  const scenarios: {
    label: string;
    attention: NotifyEvent['attention'];
    event: Partial<Pick<NotifyEvent, 'attnId' | 'inboxRevision' | 'unreadCount'>>;
    snapshot: Partial<Pick<Snapshot, 'unreadCount' | 'inboxRevision'>>;
    metaId?: number;
    expected: { badge: number; attnId?: number; inboxRevision?: number };
  }[] = [
    {
      label: 'ready prefers event IDs and event unread over snapshot unread',
      attention: 'ready', event: { attnId: 20, inboxRevision: 21, unreadCount: 99 },
      snapshot: { unreadCount: 3, inboxRevision: 11 }, metaId: 10,
      expected: { badge: 99, attnId: 20, inboxRevision: 21 },
    },
    {
      label: 'choice preserves explicit event zero IDs and explicit snapshot zero unread',
      attention: 'choice', event: { attnId: 0, inboxRevision: 0, unreadCount: 0 },
      snapshot: { unreadCount: 0, inboxRevision: 11 }, metaId: 10,
      expected: { badge: 0, attnId: 0, inboxRevision: 0 },
    },
    {
      label: 'choice falls back to engine metadata, snapshot revision and derived unread',
      attention: 'choice', event: {}, snapshot: { inboxRevision: 11 }, metaId: 10,
      expected: { badge: 2, attnId: 10, inboxRevision: 11 },
    },
    {
      label: 'ready falls back independently for revision without querying metadata',
      attention: 'ready', event: { attnId: 20 }, snapshot: { inboxRevision: 0 }, metaId: 10,
      expected: { badge: 2, attnId: 20, inboxRevision: 0 },
    },
    {
      label: 'choice falls back independently for metadata and preserves event revision',
      attention: 'choice', event: { inboxRevision: 0 }, snapshot: { inboxRevision: 11 }, metaId: 0,
      expected: { badge: 2, attnId: 0, inboxRevision: 0 },
    },
    {
      label: 'legacy missing counters remain undefined',
      attention: 'ready', event: {}, snapshot: {},
      expected: { badge: 2, attnId: undefined, inboxRevision: undefined },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.label, async (t) => {
      sessions = attentionSessions();
      const raw: Snapshot = { ...snapshot(), ...scenario.snapshot };
      t.mock.method(engine, 'snapshot', () => record('snapshot', [], raw));
      t.mock.method(engine, 'attentionCount', () => { throw new Error('attentionCount is not an unread badge'); });
      t.mock.method(engine, 'getMeta', (...args: unknown[]) =>
        record('getMeta', args, { ...busySession, attnId: scenario.metaId }));
      const viewer = await openViewer(projectedSnapshot(raw));
      t.after(viewer.close);
      const ev: NotifyEvent = {
        type: 'session/notify', sessionId: 's', title: 'Fixture title',
        attention: scenario.attention, body: 'Fixture notification body', ...scenario.event,
      };
      const writes = t.mock.method(viewer.connection.raw.res, 'write');
      t.mock.method(fakePush, 'sendAttention', async (...args: unknown[]) => {
        assert.equal(writes.mock.callCount(), 1, 'notification is broadcast before attempting push');
        assert.equal(writes.mock.calls[0]?.arguments[0], `data: ${JSON.stringify(ev)}\n\n`);
        return record('sendAttention', args, undefined);
      });
      calls.length = 0;
      assert.equal(onEngineEvent(ev), undefined);
      await nextTurn();
      const complete = scenario.event.attnId !== undefined && scenario.event.inboxRevision !== undefined
        && scenario.event.unreadCount !== undefined;
      assert.deepEqual(calls, complete ? [{
          method: 'sendAttention', args: [ev.title, 's', ev.attention, ev.body, scenario.expected.badge, {
            attnId: scenario.expected.attnId, inboxRevision: scenario.expected.inboxRevision,
          }],
      }] : [], 'incomplete legacy events cannot invent a committed waterline by later reads');
      assert.deepEqual(viewer.frames, [
        'retry: 2000', `data: ${JSON.stringify(projectedSnapshot(raw))}`, `data: ${JSON.stringify(ev)}`,
      ]);
      assert.deepEqual(fakeDeliveries, []);
    });
  }
});

for (const mode of ['async rejection', 'synchronous throw'] as const) {
  test(`notification push ${mode} is redacted and does not interrupt SSE or chat`, async (t) => {
    const viewer = await openViewer();
    t.after(viewer.close);
    const error = Object.assign(new Error('private SDK error https://push.example/private-token'), {
      endpoint: 'https://push.example/private-token', body: 'private transport body',
      status: 'unsafe status', at: 'unsafe timestamp', error: 'private nested error',
    });
    const warn = t.mock.method(app.log, 'warn', () => {});
    const pending = deferred();
    t.mock.method(fakePush, 'sendAttention', (...args: unknown[]) => {
      record('sendAttention', args, undefined);
      if (mode === 'synchronous throw') throw error;
      return pending.promise;
    });
    const ev: NotifyEvent = {
      type: 'session/notify', sessionId: 's', title: 'private notification title',
      attention: 'choice', body: 'private notification body', attnId: 0, inboxRevision: 0, unreadCount: 0,
    };
    const reset = ServerEvent.parse({
      type: 'chat/invalidated', sessionId: 's', reason: 'rewind',
    });
    calls.length = 0;
    const before = Date.now();
    try {
      assert.doesNotThrow(() => onEngineEvent(ev));
      assert.doesNotThrow(() => onEngineEvent(reset));
      const chat = await app.inject({ method: 'POST', url: '/intent/prompt', payload: cases.prompt.body });
      assert.equal(chat.statusCode, 200, chat.body);
      assert.deepEqual(chat.json(), { ok: true, queued: true }, 'chat stays responsive even while push is pending');
      if (mode === 'async rejection') {
        assert.equal(warn.mock.callCount(), 0);
        pending.reject(error);
      }
      await nextTurn();
      assert.equal(warn.mock.callCount(), 1);
      const [fields] = warn.mock.calls[0]!.arguments as unknown as [Record<string, unknown>];
      assert.deepEqual(Object.keys(fields).sort(), ['at', 'error', 'status']);
      assert.deepEqual(fields, { status: 'failed', at: fields.at, error: 'Push notification failed' });
      assert.equal(typeof fields.at, 'number');
      assert.ok(Number.isFinite(fields.at));
      assert.ok((fields.at as number) >= before && (fields.at as number) <= Date.now());
      assert.doesNotMatch(JSON.stringify(warn.mock.calls[0]!.arguments),
        /private|push\.example|SDK error|unsafe|transport body/);
      assert.deepEqual(viewer.frames, [
        'retry: 2000', `data: ${JSON.stringify(projectedSnapshot())}`,
        `data: ${JSON.stringify(ev)}`, `data: ${JSON.stringify(reset)}`,
      ]);
      assert.doesNotThrow(() => onEngineEvent(reset));
      await nextTurn();
      assert.equal(viewer.frames.at(-1), `data: ${JSON.stringify(reset)}`);
      assert.equal(viewer.frames.length, 5, 'the SSE client remains attached after failure');
      assert.equal(viewer.connection.raw.res.destroyed, false);
      assert.deepEqual(calls, [
        { method: 'sendAttention', args: [ev.title, 's', 'choice', ev.body, 0, { attnId: 0, inboxRevision: 0 }] },
        { method: 'prompt', args: ['s', 'hello', 'enqueue'] },
      ]);
      assert.deepEqual(fakeDeliveries, []);
      assert.equal(app.server.listening, false);
    } finally {
      pending.resolve();
    }
  });
}

test('SSE sends exact snapshot/retry/ping frames on reconnect and enforces the connection cap', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const opened: Awaited<ReturnType<typeof openViewer>>[] = [];
  t.after(() => { for (const viewer of opened) viewer.close(); });
  try {
    const first = await openViewer();
    opened.push(first);
    const second = await openViewer();
    opened.push(second);
    assert.deepEqual(calls, [{ method: 'snapshot', args: [] }, { method: 'snapshot', args: [] }]);
    t.mock.timers.tick(25000);
    await nextTurn();
    const initialFrames = ['retry: 2000', `data: ${JSON.stringify(projectedSnapshot())}`, ': ping'];
    assert.deepEqual(first.frames, initialFrames);
    assert.deepEqual(second.frames, initialFrames);
    const blocked = await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    try {
      assert.equal(blocked.statusCode, 503);
      assert.equal(blocked.headers['retry-after'], '5');
    } finally {
      blocked.raw.res.req.emit('close');
      blocked.raw.res.end();
      blocked.stream().destroy();
    }
    assert.equal(calls.length, 2, 'refused connections do not query the engine');
    first.close();
    opened.splice(opened.indexOf(first), 1);
    sessions = [SessionMeta.parse({ ...busySession, title: 'fresh snapshot', queue: [{ id: 'q', text: 'queued' }] })];
    const reconnected = await openViewer();
    opened.push(reconnected);
    assert.equal(calls.length, 3, 'reconnect queries exactly one fresh snapshot');
    assert.deepEqual(second.frames, initialFrames, 'a reconnect does not rebroadcast its snapshot');
    t.mock.timers.tick(25000);
    await nextTurn();
    assert.deepEqual(reconnected.frames, ['retry: 2000', `data: ${JSON.stringify(projectedSnapshot())}`, ': ping']);
    assert.deepEqual(second.frames, [...initialFrames, ': ping']);
    assert.deepEqual(first.frames, initialFrames, 'closed viewers receive no later pings');
    assert.equal(app.server.listening, false);
  } finally {
    for (const viewer of opened) viewer.close();
  }
});

test('two simultaneous viewers see no query events and receive exactly one mocked mutation reset', { timeout: 5000 }, async (t) => {
  const opened: Awaited<ReturnType<typeof openViewer>>[] = [];
  t.after(() => { for (const viewer of opened) viewer.close(); });
  try {
    opened.push(await openViewer());
    opened.push(await openViewer());
    const initialFrames = ['retry: 2000', `data: ${JSON.stringify(projectedSnapshot())}`];
    for (const name of [
      'runtime/snapshot', 'session/chat', 'session/list', 'session/get',
      'session/plan', 'session/panels', 'mcp/global', 'mcp/session',
      'skills/global', 'skills/read', 'skills/session', 'schedule/list', 'fs/listDir',
    ] as const) {
      calls.length = 0;
      const fixture = cases[name];
      const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: fixture.body });
      assert.equal(response.statusCode, 200, `${name}: ${response.body}`);
      assert.deepEqual(calls, [{ method: fixture.method, args: fixture.args }], name);
      await nextTurn();
      for (const viewer of opened) assert.deepEqual(viewer.frames, initialFrames, `${name} must be requester-only`);
    }

    const reset = ServerEvent.parse({
      type: 'chat/invalidated', sessionId: 's', reason: 'rewind',
    });
    // Simulate the Engine's event callback, using actual injected response streams
    // and the production fan-out rather than constructing an SDK-backed Engine.
    const recipients = new Set(opened.map(({ connection }) => ({ raw: connection.raw.res })));
    t.mock.method(engine, 'rewind', async (...args: unknown[]) => {
      record('rewind', args, undefined);
      broadcastFrame(recipients, `data: ${JSON.stringify(reset)}\n\n`);
    });
    calls.length = 0;
    const response = await app.inject({
      method: 'POST', url: '/intent/session/rewind',
      payload: { sessionId: 's', toMsgId: 'm', rollbackFiles: false },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true });
    assert.deepEqual(calls, [{ method: 'rewind', args: ['s', 'm', false] }]);
    await nextTurn();
    for (const viewer of opened) {
      assert.deepEqual(viewer.frames, [...initialFrames, `data: ${JSON.stringify(reset)}`]);
      assert.deepEqual(viewer.frames.filter((frame) => frame.startsWith('data: '))
        .map((frame) => ServerEvent.parse(JSON.parse(frame.slice(6))).type), ['snapshot', 'chat/invalidated']);
    }
    assert.equal(app.server.listening, false);
  } finally {
    for (const viewer of opened) viewer.close();
  }
});
