import { after, afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, parse, relative } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  Intents, SessionMeta, Snapshot, ServerEvent,
  type IntentBody, type IntentName,
} from '@cockpit/protocol';
import type { ServerEngine } from './index.ts';
import { isIntentName } from './capabilities.ts';
import { readNativeChat } from '../../../packages/core/src/native-chat.ts';
import { Engine } from '../../../packages/core/src/engine.ts';
import { sessionMetaBusy } from '../../../packages/core/test-support/lifecycle.ts';
import { GracefulShutdown } from './shutdown.ts';

process.env.COCKPIT_NO_BOOT = '1';
process.env.LOG_LEVEL = 'silent';
process.env.COCKPIT_SERVE_WEB = '0';
process.env.COCKPIT_MAX_SSE_CLIENTS = '2';
const { app, setTestDependencies, broadcastFrame, onEngineEvent } = await import('./index.ts');

const calls: { method: string; args: unknown[] }[] = [];
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
  sessions, permissionPolicy: 'allow-all' as const,
});
const projectedSnapshot = (raw: Snapshot = snapshot()): Snapshot => raw;
const engine: ServerEngine = {
  stop: async () => { throw new Error('integration fixtures must never stop a real runtime'); },
  login: async () => 'test-only',
  snapshot: async () => record('snapshot', [], snapshot()),
  busyCount: async () => sessions.filter(sessionMetaBusy).length,
  newSession: async (...args) => record('newSession', args, 'created'),
  listRoles: (...args) => record('listRoles', args, []),
  addRoles: async (...args) => record('addRoles', args, {
    sessionId: 's', status: 'saved' as const, roles: [], appliedRoles: [], loaded: true, rolesNeedReload: false,
  }),
  roleReadiness: async (...args) => record('roleReadiness', args, { sessionId: 's', loaded: false, ready: false, roles: [], reasons: ['unloaded'] }),
  initializeSessionTools: async (...args) => record('initializeSessionTools', args, undefined),
  prepareSessionResources: async (...args) => record('prepareSessionResources', args, {
    sessionId: 's', ok: true, skills: [], mcpServers: [], tools: 'unchanged' as const,
  }),
  forkSession: async (...args) => record('forkSession', args, { sessionId: 'forked' }),
  chat: async (query, signal) => {
    assert.ok(signal instanceof AbortSignal);
    return record('chat', [query], { ...historyPage, source: query.source, direction: query.direction });
  },
  prompt: async (...args) => record('prompt', args, { ok: true, queued: true }),
  cancel: (...args) => record('cancel', args, undefined),
  interrupt: async (...args) => record('interrupt', args, { ok: true as const, interrupted: true }),
  control: async (...args) => record('control', args, { ok: true, outcomes: [] }),
  setModel: async (...args) => record('setModel', args, { status: 'applied', modelId: args[1] }),
  rename: async (...args) => record('rename', args, 'renamed'),
  compact: async (...args) => record('compact', args, { success: true, tokensRemoved: 10, messagesRemoved: 2 }),
  rewind: async (...args) => record('rewind', args, { outcome: 'success' as const, eventsRemoved: 2, restoredFiles: [], skippedFiles: [] }),
  setMode: async (...args) => record('setMode', args, { status: 'applied', modelChanged: false }),
  deleteSession: async (...args) => record('deleteSession', args, undefined),
  unload: (...args) => record('unload', args, undefined),
  load: async (...args) => record('load', args, undefined),
  reload: async (...args) => record('reload', args, undefined),
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
setTestDependencies({ engine });

beforeEach(() => {
  setTestDependencies({ engine });
  sessions = [busySession];
  calls.length = 0;
});
afterEach(() => { setTestDependencies({ engine }); });

test('global resource HTTP list and detail preserve verified module metadata without adding provenance', async () => {
  const module = { id: 'fixture', name: 'Fixture' };
  const servers = [
    { name: 'native', detail: 'http://fixture/mcp', defaultOn: false, modules: [module] },
    { name: 'module_fixture__lookalike', detail: 'native', defaultOn: true },
  ];
  const skills = [
    { name: 'native', source: 'custom', enabled: false, modules: [module] },
    { name: 'module_fixture__lookalike', source: 'custom', enabled: true },
  ];
  setTestDependencies({ engine: {
    ...engine, listGlobalMcp: async () => servers, listGlobalSkills: async () => skills,
    readSkillBody: async name => ({ ...skills.find(skill => skill.name === name)!, body: '# Native' }),
  } });
  for (const [name, payload, expected] of [
    ['mcp/global', {}, { servers }],
    ['skills/global', {}, { skills }],
    ...skills.map(skill => ['skills/read', { name: skill.name }, { ...skill, body: '# Native' }]),
  ] as const) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), expected);
  }
});
after(() => app.close());

type Case = { body: unknown; method: string | null; args: unknown[] };
const cases = {
  'system/shutdown': { body: { confirm: true }, method: null, args: [] },
  'system/status': { body: {}, method: 'sessionStatus', args: [] },
  'runtime/snapshot': { body: {}, method: 'snapshot', args: [] },
  'session/new': { body: { cwd: '/fixture' }, method: 'newSession', args: ['/fixture'] },
  'roles/list': { body: {}, method: 'listRoles', args: [] },
  'roles/add': { body: { sessionId: 's', roles: [{ moduleId: 'fixture', roleId: 'owner' }] },
    method: 'addRoles', args: ['s', [{ moduleId: 'fixture', roleId: 'owner' }]] },
  'roles/readiness': { body: { sessionId: 's' }, method: 'roleReadiness', args: ['s', undefined] },
  'session/tools-initialize': { body: { sessionId: 's' }, method: 'initializeSessionTools', args: ['s'] },
  'session/resources-prepare': { body: { sessionId: 's', skills: ['optional'], mcpServers: [{ name: 'tools', tools: ['read'] }] },
    method: 'prepareSessionResources', args: [{ sessionId: 's', skills: ['optional'], mcpServers: [{ name: 'tools', tools: ['read'] }] }] },
  'session/fork': { body: { sessionId: 's', toEventId: 'user-event', name: 'Child' }, method: 'forkSession', args: ['s', 'user-event', 'Child'] },
  'session/chat': {
    body: Intents['session/chat'].body.parse({ sessionId: 's', cursor: 'native-before', max: 12 }),
    method: 'chat', args: [Intents['session/chat'].body.parse({ sessionId: 's', cursor: 'native-before', max: 12 })],
  },
  prompt: { body: { sessionId: 's', text: 'hello', mode: 'enqueue' }, method: 'prompt', args: ['s', 'hello', 'enqueue'] },
  cancel: { body: { sessionId: 's' }, method: 'cancel', args: ['s'] },
  'session/interrupt': { body: { sessionId: 's' }, method: 'interrupt', args: ['s'] },
  'session/control': { body: { sessionId: 's', token: 'handle', action: { type: 'stop-all' } },
    method: 'control', args: ['s', 'handle', { type: 'stop-all' }] },
  setModel: { body: { sessionId: 's', modelId: 'model', reasoningEffort: 'high', contextTier: 'long_context' }, method: 'setModel', args: ['s', 'model', 'high', 'long_context'] },
  'session/rename': { body: { sessionId: 's', name: 'renamed' }, method: 'rename', args: ['s', 'renamed'] },
  'session/compact': { body: { sessionId: 's', customInstructions: 'keep context' }, method: 'compact', args: ['s', 'keep context'] },
  'session/rewind': { body: { sessionId: 's', toMsgId: 'm', rollbackFiles: true }, method: 'rewind', args: ['s', 'm', true] },
  setMode: { body: { sessionId: 's', mode: 'plan' }, method: 'setMode', args: ['s', 'plan'] },
  'session/delete': { body: { sessionId: 's' }, method: 'deleteSession', args: ['s'] },
  'session/unload': { body: { sessionId: 's' }, method: 'unload', args: ['s'] },
  'session/load': { body: { sessionId: 's' }, method: 'load', args: ['s'] },
  'session/reload': { body: { sessionId: 's' }, method: 'reload', args: ['s'] },
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
} satisfies { [K in IntentName]: Case & { body: IntentBody<K> } };

test('dispatch fixtures cover exactly the authoritative Intents, without retired handlers', () => {
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(Intents).sort());
  assert.equal(app.server.listening, false);
});

test('session/control routes every native action and preserves partial outcomes without wrapping success', async t => {
  const partial = { ok: false, outcomes: [
    { operation: 'tasks.cancel', targetId: 'a', state: 'accepted' as const, result: { cancelled: true } },
    { operation: 'tasks.cancel', targetId: 'b', state: 'unconfirmed' as const, error: 'native unavailable' },
  ] };
  t.mock.method(engine, 'control', async (...args) => record('control', args, partial));
  const actions: IntentBody<'session/control'>['action'][] = [
    { type: 'stop-all' }, { type: 'stop-task', id: 'a' },
    { type: 'clear-tasks', kind: 'agent', ids: ['a', 'b'] },
    { type: 'clear-tasks', kind: 'shell', ids: ['shell'] },
    { type: 'clear-queue' }, { type: 'remove', id: 'queue' }, { type: 'steer', id: 'queue' },
    ...(['ask', 'plan', 'elicitation'] as const).map(kind => ({ type: 'cancel-decision' as const, kind, requestId: 'request' })),
  ];
  for (const action of actions) {
    calls.length = 0;
    const response = await app.inject({ method: 'POST', url: '/intent/session/control',
      payload: { sessionId: 's', token: 'native-handle', action } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), partial);
    assert.deepEqual(calls, [{ method: 'control', args: ['s', 'native-handle', action] }]);
  }
});

test('session/control rejects malformed scope, stale ownership and duplicate targets', async t => {
  for (const action of [
    { type: 'stop-all', force: true }, { type: 'stop-task', name: 'display name' },
    { type: 'clear-tasks', kind: 'agent', ids: ['a', 'a'] },
    { type: 'clear-tasks', kind: 'agent', ids: [] },
    { type: 'cancel-decision', kind: 'ask' },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/intent/session/control',
      payload: { sessionId: 's', token: 'native-handle', action } });
    assert.equal(response.statusCode, 400);
  }
  assert.deepEqual(calls, []);
  const control = t.mock.method(engine, 'control', async () => {
    throw Object.assign(new Error('Controls refer to an old handle'), { statusCode: 409, code: 'STALE_SESSION_CONTROLS' });
  });
  const response = await app.inject({ method: 'POST', url: '/intent/session/control', payload: cases['session/control'].body });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'STALE_SESSION_CONTROLS');
  assert.equal(control.mock.callCount(), 1);
});

for (const [name, fixture] of Object.entries(cases)) {
  test(`dispatch ${name}: parses once, routes exact arguments, and validates the protocol result`, async (t) => {
    assert.ok(isIntentName(name));
    assert.equal(Intents[name].body.safeParse(fixture.body).success, true);
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
    if (name === 'skills/refresh') assert.deepEqual(response.json(), { ok: true });
  });
}

test('retired independent activity intent is absent from HTTP and capabilities', async () => {
  const response = await app.inject({ method: 'POST', url: '/intent/session/activity', payload: { sessionId: 's' } });
  assert.equal(response.statusCode, 404);
  assert.equal(isIntentName('session/activity'), false);
  const capabilities = await app.inject({ method: 'GET', url: '/capabilities' });
  assert.equal(capabilities.statusCode, 200);
  assert.doesNotMatch(capabilities.body, /session\/activity/);
  assert.deepEqual(calls, []);
});

test('activity summary survives existing HTTP lists, control projections and snapshots', async t => {
  const activity = {
    sampledAt: 1, processing: false, hasActiveWork: true, abortable: true,
    tasks: { activeAgents: 0, activeShells: 1, unknown: 0 },
    queue: { pendingCount: 1, steeringCount: 2, inFlightSteeringCount: 1 },
    mcp: { pendingConnectionCount: 1 },
  };
  sessions = [{ ...busySession, activity }];
  t.mock.method(engine, 'listLive', async () => sessions);
  t.mock.method(engine, 'getResources', async (_id, resources) => ({
    sessionId: 's', loaded: true, ...(resources.includes('control') ? { activity } : {}),
  }));
  for (const name of ['session/list', 'runtime/snapshot']) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: {} });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().sessions[0].activity, activity);
  }
  for (const resource of ['control', 'identity']) {
    const response = await app.inject({ method: 'POST', url: '/intent/session/resources',
      payload: { sessionId: 's', resources: [resource] } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().meta.activity, resource === 'control' ? activity : undefined);
  }
  const viewer = await openViewer();
  try {
    const invalidated: ServerEvent = { type: 'session/patch', sessionId: 's', activity: null };
    onEngineEvent(invalidated);
    await nextTurn();
    assert.equal(viewer.frames.at(-1), `data: ${JSON.stringify(invalidated)}`);
  } finally { viewer.close(); }
  t.mock.method(engine, 'getResources', async () => { throw new Error('synthetic read failed'); });
  const failed = await app.inject({ method: 'POST', url: '/intent/session/resources',
    payload: { sessionId: 's', resources: ['control'] } });
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().meta, undefined);
});

test('resource HTTP responses preserve contributing roles, module-only and non-module sources', async t => {
  const module = { id: 'fixture', name: 'Fixture',
    roles: [{ id: 'executor', name: 'Executor' }, { id: 'owner', name: 'Owner' }] };
  const sources = [module, { id: 'legacy', name: 'Module only' }, undefined];
  const servers = sources.map((module, index) => ({
    name: `native-${index}`, detail: 'native', enabled: false, status: 'disabled' as const, ...(module ? { module } : {}),
  }));
  const skills = sources.map((module, index) => ({
    name: `skill-${index}`, source: 'custom', enabled: true, ...(module ? { module } : {}),
  }));
  t.mock.method(engine, 'listSessionMcp', async () => ({ loaded: true, servers }));
  t.mock.method(engine, 'listSessionSkills', async () => skills);
  for (const [name, expected] of [['mcp/session', { loaded: true, servers }], ['skills/session', { skills }]] as const) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: { sessionId: 's' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), expected);
  }
  assert.deepEqual(calls, [], 'no extra readiness, assembly or session calls');
});

test('resource preparation preserves partial effects and validates input before guarded work', async t => {
  const partial = Intents['session/resources-prepare'].result.parse({
    sessionId: 's', ok: false, skills: [{ name: 'optional', effect: 'enabled', enabled: true }],
    mcpServers: [{ name: 'tools', effect: 'unconfirmed', enabled: null, status: null, tools: null }],
    tools: 'not_attempted', error: 'Native readback failed',
  });
  const prepare = t.mock.method(engine, 'prepareSessionResources', async () => partial);
  const response = await app.inject({ method: 'POST', url: '/intent/session/resources-prepare',
    payload: cases['session/resources-prepare'].body });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), partial);
  for (const body of [
    { sessionId: 's', skills: ['optional', 'optional'] },
    { sessionId: 's', mcpServers: [{ name: 'tools', tools: ['*'] }] },
    { sessionId: 's', reload: true },
  ]) assert.equal((await app.inject({ method: 'POST', url: '/intent/session/resources-prepare', payload: body })).statusCode, 400);
  assert.equal(prepare.mock.callCount(), 1);
});

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
  const filesystemRoot = parse(home).root;
  const readdir = t.mock.method(fs, 'readdirSync', (path: fs.PathLike) => {
    assert.equal(path, filesystemRoot);
    return [];
  });
  const access = t.mock.method(fs, 'accessSync', (path: fs.PathLike) => {
    assert.equal(path, filesystemRoot);
  });
  syncBuiltinESMExports();
  try {
    const root = await request(filesystemRoot);
    assert.equal(root.statusCode, 200, root.body);
    assert.deepEqual(root.json(), { path: filesystemRoot, parent: null, entries: [] });
  } finally {
    readdir.mock.restore();
    access.mock.restore();
    syncBuiltinESMExports();
  }
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
  } });
  t.after(() => setTestDependencies({ engine }));
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

test('unknown message history routes return 404 without dispatch', async () => {
  for (const name of ['session/history', 'session/peek', 'session/subagent-history']) {
    calls.length = 0;
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: { sessionId: 's' } });
    assert.equal(response.statusCode, 404, response.body);
    assert.match(response.json().error, /unknown intent/);
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

test('runtime/snapshot makes one query and exposes the required permission policy', async () => {
  const response = await app.inject({ method: 'POST', url: '/intent/runtime/snapshot' });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(Snapshot.parse(response.json()), projectedSnapshot());
  assert.equal(response.json().permissionPolicy, 'allow-all');
  assert.deepEqual(calls, [{ method: 'snapshot', args: [] }]);
});

test('schema-invalid engine results are 500 INVALID_INTENT_RESULT, not request errors', async (t) => {
  const invalid = [
    ['prompt', 'prompt', { ok: 'yes' }],
    ['session/chat', 'chat', undefined],
    ['session/list', 'listLive', [{ ...busySession, status: 'not-a-status' }]],
    ['mcp/session-toggle', 'toggleSessionMcp', { ok: false, error: 'missing operation' }],
    ['session/resources-prepare', 'prepareSessionResources', { ok: true, sessionId: 's' }],
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

test('native operation envelopes retain queued, follow-up and partially applied outcomes', async t => {
  const model = { status: 'queued', deferred: true, modelId: 'native', message: 'Queued natively',
    warning: 'Native warning', deprecationWarnings: ['Native deprecation'], nativeExtension: 1 };
  const mode = { status: 'applied', modelChanged: true, deferImplementation: true, armInteractiveContinuation: true,
    confirmation: { targetModelDisplayName: 'Native model', currentTokens: 20, targetLimit: 10 } };
  const compact = { success: false, tokensRemoved: 100, messagesRemoved: 2, summaryContent: 'Partial native summary' };
  const rewind = { outcome: 'snapshot-prune-failed', eventsRemoved: 3, restoredFiles: ['/fixture/restored'],
    skippedFiles: [{ path: '/fixture/kept', reason: 'native-conflict' }], error: 'Native cleanup failed' };
  t.mock.method(engine, 'setModel', async () => model);
  t.mock.method(engine, 'setMode', async () => mode);
  t.mock.method(engine, 'compact', async () => compact);
  t.mock.method(engine, 'rewind', async () => rewind);
  for (const [name, result] of [
    ['setModel', model], ['setMode', mode], ['session/compact', compact], ['session/rewind', rewind],
  ] as const) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: cases[name].body });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true, result });
  }
  assert.deepEqual(calls, [], 'no metadata readback or host follow-up is dispatched');
});

test('model refusal, persistence failures and unknown outcomes remain returned native results', async t => {
  for (const result of [
    {}, { status: 'future-native-status' }, { status: 'rejected', message: 'Native refusal' },
    { status: 'applied', persistenceError: 'Native persistence failed', modelState: {
      modelId: 'native', reasoningEffort: 'high', contextTier: 'long_context',
    } },
  ]) {
    t.mock.method(engine, 'setModel', async () => result);
    const response = await app.inject({ method: 'POST', url: '/intent/setModel', payload: cases.setModel.body });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true, result });
  }
});

test('schedule creation uncertainty and known IDs with warnings are not discarded by dispatch', async t => {
  for (const result of [
    { possiblyCreated: true, error: 'Native acknowledgement unknown; a schedule may have been created' },
    { entry: { id: 9, prompt: 'remind', recurring: true, intervalMs: 30_000, nextRunAt: 1 },
      error: 'Native schedule created with unexpected command outcome' },
  ]) {
    t.mock.method(engine, 'addSchedule', async () => result);
    const response = await app.inject({ method: 'POST', url: '/intent/schedule/add', payload: cases['schedule/add'].body });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: false, ...result });
  }
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

for (const name of ['session/delete', 'session/compact', 'session/rewind'] as const) {
  test(`${name} rejects retired module unbind approvals without calling any engine method`, async () => {
    const unbind = { planId: 'a'.repeat(64), operationId: 'unbind-delete-1' };
    const response = await app.inject({
      method: 'POST', url: `/intent/${name}`, payload: { ...cases[name].body, unbind },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(calls, []);
  });
  test(`${name} accepts current input and rejects removed confirmation before dispatch`, async () => {
    for (const confirm of [undefined, false, true, 'true', 1, null]) {
      calls.length = 0;
      const response = await app.inject({
        method: 'POST', url: `/intent/${name}`, payload: { ...cases[name].body, confirm },
      });
      const valid = confirm === undefined;
      assert.equal(response.statusCode, valid ? 200 : 400, response.body);
      assert.deepEqual(calls, valid ? [{ method: cases[name].method, args: cases[name].args }] : []);
    }
  });
}

test('retired soft-delete options remain rejected', async () => {
  for (const body of [{ sessionId: 's', reason: 'declutter' }]) {
    const response = await app.inject({ method: 'POST', url: '/intent/session/delete', payload: body });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /reason/);
    assert.deepEqual(calls, []);
  }
});

test('session/new rejects an obsolete worker label before native creation', async () => {
  const body = { cwd: '/fixture', spawnedBy: 'obsolete' };
  const response = await app.inject({ method: 'POST', url: '/intent/session/new', payload: body });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(calls, []);
});

test('unknown, inherited, and retired intent paths are 404 without engine calls', async () => {
  for (const name of [
    'unknown', 'constructor', '__proto__', 'toString', 'session/purge', 'session/advance-queue',
    'hook/add', 'hook/list', 'hook/stop', 'hook/unknown',
    'flow/add', 'flow/list', 'flow/remove', 'flow/write-gate', 'flow/run', 'flow/unknown',
    'flow-schedule/add', 'flow-schedule/list', 'flow-schedule/stop', 'flow-schedule/unknown',
    'session/set-spawned-by', 'session/restore', 'session/trash-list',
    'modules/list', 'modules/install', 'modules/updates/check', 'modules/service', 'modules/config/set',
    'modules/wechat/unbind', 'session/modules/get', 'session/modules/apply',
    'files/list', 'files/get', 'files/associate', 'session/pin', 'session/auto-name',
    'inbox/seen', 'push/subscribe', 'push/status', 'push/test', 'push/unsubscribe',
    'speech/token', 'system/consumer/status', 'system/consumer/restart',
  ]) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: {} });
    assert.equal(response.statusCode, 404, `${name}: ${response.body}`);
    assert.deepEqual(calls, [], name);
  }
});

test('the origin gate protects valid intents, including bodyless mutations', async () => {
  for (const name of ['session/new', 'skills/refresh', 'mcp/refresh', 'session/delete']) {
    const response = await app.inject({
      method: 'POST', url: `/intent/${name}`,
      headers: { origin: 'https://untrusted.example', host: '127.0.0.1:8771' },
      payload: { cwd: '/fixture', sessionId: 's', confirm: true },
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(calls, []);
  }
});

test('retired virtual creation and module deletion previews have no transport or capability', async () => {
  for (const name of ['session/start', 'session/start/get', 'session/delete/preview']) {
    assert.equal(isIntentName(name), false);
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: {} });
    assert.equal(response.statusCode, 404, response.body);
  }
  assert.equal(calls.length, 0);
});

test('native create and prompt are separate one-call operations with no hidden message or identity', async () => {
  const created = await app.inject({ method: 'POST', url: '/intent/session/new',
    payload: { cwd: '/fixture' } });
  assert.equal(created.statusCode, 200, created.body);
  assert.deepEqual(created.json(), { sessionId: 'created' });
  assert.deepEqual(calls, [{ method: 'newSession', args: ['/fixture'] }]);
  const response = await app.inject({ method: 'POST', url: '/intent/prompt',
    payload: { sessionId: created.json().sessionId, text: 'The real first message' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(calls[1], { method: 'prompt', args: ['created', 'The real first message', undefined] });
  assert.equal(calls.length, 2);
});

test('native attachment input passes once without upload, association or content rewriting', async () => {
  const attachments = [
    { type: 'file', path: '/fixture/a.txt', displayName: 'Native file' },
    { type: 'directory', path: '/fixture' },
    { type: 'selection', filePath: '/fixture/a.txt', displayName: 'Native selection', text: 'Selected native text',
      selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } } },
    { type: 'blob', data: 'Zml4dHVyZQ==', mimeType: 'text/plain' },
  ];
  const response = await app.inject({ method: 'POST', url: '/intent/prompt',
    payload: { sessionId: 's', text: 'Native input', mode: 'enqueue', attachments } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, queued: true });
  assert.deepEqual(calls, [{ method: 'prompt', args: ['s', 'Native input', 'enqueue', attachments] }]);
});

test('managed attachment shapes fail before native submission', async () => {
  const attachment = { kind: 'file', name: 'old.txt', url: '/uploads/old.txt' };
  for (const extra of [{ attachment }, { attachments: [attachment] }, { parts: [{ type: 'file', attachment }] }]) {
    const response = await app.inject({ method: 'POST', url: '/intent/prompt',
      payload: { sessionId: 's', text: 'Old input', ...extra } });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(calls, []);
  }
});

test('retired file transports and image lookup names have no adapter or native effects', async () => {
  for (const name of ['session/tool-image', 'files/from-tool-image']) {
    assert.equal(isIntentName(name), false);
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`,
      payload: { sessionId: 's', image: { eventId: 'event', toolCallId: 'tool', part: 0 } } });
    assert.equal(response.statusCode, 404);
    assert.match(response.json().error, /unknown intent/);
  }
  for (const url of ['/uploads/retained.txt', '/system/versions', '/files']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404, url);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/upload', payload: 'retired bytes' })).statusCode, 404);
  assert.deepEqual(calls, []);
});

test('health/status and shutdown use only injected state and retain every native busy safeguard', async () => {
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.json().ok, true);
  assert.equal(health.json().login, 'test-only');
  assert.match(health.json().instanceId, /^[a-f0-9-]{36}$/);
  assert.equal(health.headers['cache-control'], 'no-store');
  const version = await app.inject({ method: 'GET', url: '/version' });
  assert.equal(version.statusCode, 200);
  assert.equal(version.json().sourceSha, null, 'Source mode must not invent a source SHA');
  assert.equal(version.json().instanceId, health.json().instanceId);
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
    const closing = await app.inject({ method: 'POST', url: '/intent/system/shutdown', payload: { confirm: true } });
    assert.equal(closing.statusCode, 200);
    assert.equal(closing.json().ok, true);
    assert.equal(closing.json().shutdown.phase, 'waiting');
    assert.equal('restartPending' in status.json(), false);
  }
});

test('graceful shutdown refuses new work but keeps decisions, queue controls and native reads available', async () => {
  await app.inject({ method: 'POST', url: '/intent/system/shutdown', payload: { confirm: true } });
  calls.length = 0;
  for (const name of ['prompt', 'session/new', 'session/fork', 'session/resources-prepare', 'setModel', 'schedule/add', 'mcp/global-default'] as const) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: cases[name].body });
    assert.equal(response.statusCode, 503, name);
    assert.equal(response.json().code, 'SERVICE_SHUTTING_DOWN');
  }
  assert.deepEqual(calls, []);
  for (const name of ['respondAsk', 'respondPlan', 'respondElicitation', 'queue/remove', 'cancel', 'session/interrupt', 'session/control', 'session/get'] as const) {
    const response = await app.inject({ method: 'POST', url: `/intent/${name}`, payload: cases[name].body });
    assert.equal(response.statusCode, 200, `${name}: ${response.body}`);
  }
});

test('shutdown requires explicit confirmation and has no force, deployment or cancel mode', async () => {
  for (const body of [{}, { confirm: false }, { confirm: true, force: true }, { confirm: true, pending: false }]) {
    const response = await app.inject({ method: 'POST', url: '/intent/system/shutdown', payload: body });
    assert.equal(response.statusCode, 400);
  }
  assert.deepEqual(calls, []);
  const status = await app.inject({ method: 'POST', url: '/intent/system/status', payload: {} });
  assert.equal(status.json().shutdown.phase, 'running');
});

test('old deployment lifecycle endpoints are absent rather than aliases to shutdown', async () => {
  for (const path of ['/admin/restart', '/admin/lifecycle', '/intent/system/consumer/restart', '/intent/system/consumer/status']) {
    const response = await app.inject({ method: path.endsWith('/lifecycle') ? 'GET' : 'POST', url: path,
      ...(path.endsWith('/lifecycle') ? {} : { payload: { pending: true, confirm: true } }) });
    assert.equal(response.statusCode, 404, path);
  }
  assert.deepEqual(calls, []);
});

test('an acknowledged shutdown cannot close around a held global mutation', async t => {
  let finish!: () => void, begin!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const entered = new Promise<void>(resolve => { begin = resolve; });
  const stopped: string[] = [];
  const shutdown = new GracefulShutdown({
    busyCount: async () => 0, stopNative: async () => { stopped.push('native'); },
    closeTransport: async () => { stopped.push('transport'); }, exit: () => { stopped.push('exit'); },
    report: error => { assert.fail(String(error)); }, delayMs: 0,
  });
  t.after(() => shutdown.dispose());
  setTestDependencies({ engine, shutdown });
  t.mock.method(engine, 'setMcpDefault', async () => { begin(); await held; });
  const changing = app.inject({
    method: 'POST', url: '/intent/mcp/global-default', payload: cases['mcp/global-default'].body,
  }).then(response => response);
  try {
    await entered;
    assert.equal(shutdown.inFlightRequests, 1);
    const response = await app.inject({ method: 'POST', url: '/intent/system/shutdown', payload: { confirm: true } });
    assert.equal(response.json().shutdown.phase, 'waiting');
    assert.deepEqual(stopped, []);
  } finally {
    finish();
    assert.equal((await changing).statusCode, 200);
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(stopped, ['native', 'transport', 'exit']);
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

test('module payloads reuse control SSE without native calls, shutdown work or reconnect replay', async t => {
  const first = await openViewer();
  t.after(() => first.close());
  const second = await openViewer();
  t.after(() => second.close());
  const initial = [...first.frames];
  const notify = t.mock.method(GracefulShutdown.prototype, 'notify', () => {});
  calls.length = 0;
  const event = ServerEvent.parse({ type: 'module/event', moduleId: 'fixture', payload: {
    type: 'session/removed', sessionId: 's', values: ['界', null, true],
  } });
  onEngineEvent(event);
  await nextTurn();
  for (const viewer of [first, second]) assert.deepEqual(viewer.frames, [...initial, `data: ${JSON.stringify(event)}`]);
  assert.deepEqual(calls, []);
  assert.equal(notify.mock.callCount(), 0);
  first.close();
  const reconnected = await openViewer();
  t.after(() => reconnected.close());
  assert.deepEqual(reconnected.frames, initial, 'new consumers get no module event history');
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
      return { outcome: 'success', eventsRemoved: 2, restoredFiles: [], skippedFiles: [] };
    });
    calls.length = 0;
    const response = await app.inject({
      method: 'POST', url: '/intent/session/rewind',
      payload: { sessionId: 's', toMsgId: 'm', rollbackFiles: false },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true, result: { outcome: 'success', eventsRemoved: 2, restoredFiles: [], skippedFiles: [] } });
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
