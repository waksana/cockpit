import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { CopilotSession, SessionConfig, SessionEvent, SessionMetadata } from '@github/copilot-sdk';
import { Engine, type EngineRuntime } from './engine.ts';

type Rpc = CopilotSession['rpc'];
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-native-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const native = {
    title: 'first name', cwd: root, model: 'first-model', mode: 'interactive' as 'interactive' | 'plan',
    busy: false, pendingMcp: [] as string[],
    queue: [] as Awaited<ReturnType<Rpc['queue']['pendingItems']>>['items'],
    todos: [] as Awaited<ReturnType<Rpc['plan']['readSqlTodos']>>['rows'],
    schedules: [] as Awaited<ReturnType<Rpc['schedule']['list']>>['entries'],
    models: [{ id: 'first-model', name: 'First model' }],
    events: [] as SessionEvent[],
    listed: true, live: false,
  };
  const row = (): SessionMetadata => ({
    sessionId: 'native-id', summary: native.title, context: { workingDirectory: native.cwd },
    startTime: new Date('2026-09-01'), modifiedTime: new Date('2026-09-10'), isRemote: false,
  });
  let config: SessionConfig | undefined;
  const rpc = {
    metadata: {
      snapshot: t.mock.fn(async () => ({
        sessionId: 'native-id', startTime: '2026-09-01T00:00:00Z', modifiedTime: '2026-09-10T00:00:00Z',
        workingDirectory: native.cwd, currentMode: native.mode, isRemote: false,
        alreadyInUse: false, workspacePath: null, sessionLimits: null,
      })),
      activity: t.mock.fn(async () => ({ hasActiveWork: native.busy, abortable: native.busy })),
      isProcessing: t.mock.fn(async () => ({ processing: native.busy })),
    },
    name: { get: t.mock.fn(async () => ({ name: native.title })) },
    model: {
      getCurrent: t.mock.fn(async () => ({ modelId: native.model })),
      list: t.mock.fn(async () => ({ list: structuredClone(native.models) })),
    },
    mode: { get: t.mock.fn(async () => native.mode) },
    tasks: { list: t.mock.fn(async () => ({ tasks: [] })) },
    queue: { pendingItems: t.mock.fn(async () => ({
      items: structuredClone(native.queue), steeringMessages: [], inFlightSteeringCount: 0,
    })) },
    schedule: { list: t.mock.fn(async () => ({ entries: structuredClone(native.schedules) })) },
    plan: {
      read: t.mock.fn(async () => ({ exists: false, content: null, path: null })),
      readSqlTodos: t.mock.fn(async () => ({ rows: structuredClone(native.todos) })),
    },
    mcp: { list: t.mock.fn(async () => ({
      servers: [], host: { pendingConnections: [...native.pendingMcp], clients: [], disabledServers: [],
        mcp3pEnabled: true, filteredServers: [], needsAuthServers: {}, failedServers: {} },
    })) },
    eventLog: { read: t.mock.fn(async (params: Parameters<Rpc['eventLog']['read']>[0]) => {
      const events = native.events.filter(event => !params.types || params.types === '*' || params.types.includes(event.type));
      const max = params.max ?? 200;
      return { events: params.direction === 'backward' ? events.slice(-max) : events.slice(0, max),
        cursor: 'tail', cursorStatus: 'ok' as const, hasMore: events.length > max };
    }) },
    ui: { ephemeralQuery: t.mock.fn(async () => ({ answer: '' })) },
    workspaces: { getWorkspace: t.mock.fn(async () => ({ workspace: null })) },
  } satisfies { [K in keyof Rpc]?: Partial<Rpc[K]> };
  const sdk = { sessionId: 'native-id', rpc } as unknown as CopilotSession;
  const runtime = {
    start: async () => {},
    stop: async () => { assert.equal(native.live, false); },
    models: t.mock.fn(async () => native.models.map(model => ({ modelId: model.id, name: model.name }))),
    getAuthStatus: t.mock.fn(async () => ({ isAuthenticated: false })),
    listSessions: t.mock.fn(async () => native.listed ? [row()] : []),
    getSessionMetadata: t.mock.fn(async () => native.listed ? row() : undefined),
    isSessionLive: t.mock.fn(async () => native.live),
    onSessionClosed: () => () => {},
    onFatal: () => () => {},
    closeSession: t.mock.fn(async () => { native.live = false; }),
    deleteSession: t.mock.fn(async () => { native.listed = false; }),
    resumeSession: t.mock.fn(async (_id: string, options: SessionConfig) => { config = options; native.live = true; return sdk; }),
    createSession: t.mock.fn(async () => { throw new Error('Unexpected create'); }),
    rpc: {
      user: { settings: { get: async () => ({ settings: { disabledSkills: { value: [] } } }) } },
    },
  } as unknown as EngineRuntime;
  const engine = new Engine({ runtime });
  const retained = () => (engine as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions;
  return { engine, native, rpc, runtime, retained, config: () => config };
}

async function emitReply(h: ReturnType<typeof fixture>, id: string) {
  const events: SessionEvent[] = [
    { type: 'assistant.turn_start', id: `${id}-start`, timestamp: '2026-09-10T00:00:00Z', parentId: null, data: { turnId: id } },
    { type: 'assistant.message', id: `${id}-message`, timestamp: '2026-09-10T00:00:00Z', parentId: null,
      data: { messageId: id, content: 'Completed response' } },
    { type: 'assistant.turn_end', id: `${id}-end`, timestamp: '2026-09-10T00:00:00Z', parentId: null, data: { turnId: id } },
  ];
  h.native.events.push(...events);
  for (const event of events) h.config()!.onEvent!(event);
  await nextTurn();
  await nextTurn();
}

test('native reply events do not trigger naming, notification work or metadata reads', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  const reads = h.rpc.metadata.snapshot.mock.callCount();
  const controls = h.rpc.metadata.activity.mock.callCount();
  await emitReply(h, 'first');
  assert.equal(h.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  assert.equal(h.rpc.metadata.snapshot.mock.callCount(), reads);
  assert.equal(h.rpc.metadata.activity.mock.callCount(), controls);
  assert.equal('prefs' in h.engine, false);
  assert.equal(h.config()?.tools, undefined);
  await h.engine.unload('native-id');
  await h.engine.stop();
});

test('native removal wakes the host lifecycle after its final ownership guard releases', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  const counts: number[] = [];
  const check = () => { void h.engine.busyCount().then(count => counts.push(count)); };
  const offEvent = h.engine.onEvent(check);
  const offSettled = h.engine.onActivitySettled(check);
  await h.engine.deleteSession('native-id', true);
  await nextTurn();
  assert.ok(counts.includes(1));
  assert.equal(counts.at(-1), 0);
  offEvent();
  offSettled();
  await h.engine.stop();
});

test('native reads retain no unloaded rows, model catalog, or resource responses', async t => {
  const h = fixture(t);
  await h.engine.start();
  assert.equal(h.retained().size, 0);
  const first = await h.engine.snapshot();
  assert.equal(first.sessions[0]?.title, 'first name');
  assert.equal(first.sessions[0]?.queue, undefined);
  h.native.title = 'second name';
  h.native.models = [{ id: 'second-model', name: 'Second model' }];
  const second = await h.engine.snapshot();
  assert.equal(second.sessions[0]?.title, 'second name');
  assert.equal(second.models[0]?.modelId, 'second-model');
  assert.equal(h.retained().size, 0);
  assert.equal('models' in h.engine, false);
  assert.equal('trashedMeta' in h.engine, false);
  assert.equal('poll' in h.engine, false);
  await h.engine.stop();
});

test('an unacknowledged creation is not published from an early native index entry', async t => {
  const h = fixture(t);
  await h.engine.start();
  const row = (await h.runtime.getSessionMetadata('native-id'))!;
  let id = '';
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(h.runtime, 'createSession', async (config: SessionConfig) => {
    id = config.sessionId!;
    await hold;
    throw new Error('Synthetic creation failure');
  });
  t.mock.method(h.runtime, 'listSessions', async () => [row, { ...row, sessionId: id }]);
  const creation = h.engine.newSession(h.native.cwd);
  await nextTurn();
  assert.ok(id);
  assert.deepEqual((await h.engine.snapshot()).sessions.map(session => session.sessionId), ['native-id']);
  await assert.rejects(h.engine.getMeta(id), { code: 'SESSION_TRANSITION' });
  assert.equal(h.retained().has(id), false);
  assert.ok(await h.engine.busyCount());
  finish();
  await assert.rejects(creation, /Synthetic creation failure/);
  assert.equal(await h.engine.busyCount(), 0);
  await h.engine.stop();
});

test('native resource values stay unavailable during loading while real host contacts remain visible', async t => {
  const h = fixture(t);
  await h.engine.start();
  const resume = h.runtime.resumeSession.bind(h.runtime);
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(h.runtime, 'resumeSession', async (id: string, options: SessionConfig) => {
    await hold;
    return resume(id, options);
  });
  const loading = h.engine.reload('native-id');
  await nextTurn();
  const meta = await h.engine.getMeta('native-id');
  assert.equal(meta?.loading, true);
  assert.equal(meta?.loaded, false);
  assert.equal(meta?.queue, undefined);
  assert.equal(meta?.currentModelId, undefined);
  assert.equal((await h.engine.snapshot()).sessions[0]?.loading, true);
  finish();
  await loading;
  await h.engine.unload('native-id');
  await h.engine.stop();
});

test('loaded metadata is reread, no fields or getter results are saved in contacts', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  const first = await h.engine.getMeta('native-id');
  assert.equal(first?.currentModelId, 'first-model');
  h.native.title = 'changed without an event';
  h.native.model = 'changed-model';
  h.native.mode = 'plan';
  h.native.todos = [{ id: 'todo', title: 'Working', status: 'in_progress' }];
  h.native.schedules = [{ id: 1, prompt: 'future', recurring: false, intervalMs: 1000, nextRunAt: '2026-09-10T12:00:00Z' }];
  h.native.queue = [{ id: 'queue-id', messageId: 'message-id', displayText: 'queued', kind: 'message', agentMode: 'interactive' }];
  const second = await h.engine.getMeta('native-id');
  assert.equal(second?.title, h.native.title);
  assert.equal(second?.currentModelId, 'changed-model');
  assert.equal(second?.currentMode, 'plan');
  assert.equal(second?.todo?.intent, 'Working');
  assert.equal(second?.queue?.[0]?.id, 'queue-id');
  assert.equal(second?.scheduleCount, 1);
  const contact = h.retained().get('native-id')!;
  for (const key of ['meta', 'tasks', 'steering', 'nativeMcpPending', 'resourceReads', 'dirtyResources', 'resourceSync']) {
    assert.equal(key in contact, false, key);
  }
  for (const value of Object.values(contact)) {
    assert.notEqual(value, second);
    assert.notEqual(value, second?.queue);
    assert.notEqual(value, second?.availableModels);
  }
  h.native.queue = [];
  await h.engine.unload('native-id');
  assert.equal(h.retained().size, 0);
  const unloaded = await h.engine.getMeta('native-id');
  assert.equal(unloaded?.loaded, false);
  assert.equal(unloaded?.queue, undefined);
  assert.equal(unloaded?.currentMode, undefined);
  assert.equal(unloaded?.scheduleCount, undefined);
  await h.engine.stop();
});

test('passive unloaded reads never resume, including failed resource reads', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.getMeta('native-id');
  await h.engine.listLive();
  await assert.rejects(h.engine.getPlan('native-id'), /unloaded/i);
  await assert.rejects(h.engine.reloadSessionMcp('native-id'), /unloaded/i);
  await assert.rejects(h.engine.respondAsk('native-id', 'old-request', 'answer', true), /no longer pending/);
  assert.deepEqual(await h.engine.listSessionMcp('native-id'), { loaded: false, servers: [] });
  assert.equal(h.native.live, false);
  assert.equal(h.retained().size, 0);
  await h.engine.stop();
});

test('native resource failure is not cached, fabricated, or retried', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  await h.engine.getMeta('native-id');
  h.rpc.model.getCurrent.mock.mockImplementationOnce(async () => { throw new Error('read unavailable'); });
  const calls = h.rpc.model.getCurrent.mock.callCount();
  await assert.rejects(h.engine.getMeta('native-id'), /read unavailable/);
  assert.equal(h.rpc.model.getCurrent.mock.callCount(), calls + 1);
  h.native.model = 'after-error';
  assert.equal((await h.engine.getMeta('native-id'))?.currentModelId, 'after-error');
  await h.engine.unload('native-id');
  await h.engine.stop();
});

test('safety is read from native even without events and failures prevent closure', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  h.native.pendingMcp = ['connecting'];
  assert.equal(await h.engine.busyCount(), 1);
  await assert.rejects(h.engine.unload('native-id'), /protected/);
  h.native.pendingMcp = [];
  h.native.busy = true;
  await assert.rejects(h.engine.stop(), /protected/);
  h.native.busy = false;
  h.rpc.metadata.activity.mock.mockImplementationOnce(async () => { throw new Error('safety unavailable'); });
  await assert.rejects(h.engine.unload('native-id'), /safety unavailable/);
  assert.equal(h.native.live, true);
  await h.engine.unload('native-id');
  await h.engine.stop();
});

test('real decision contacts survive reads and release only after response', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  const answer = h.config()!.onUserInputRequest!({ question: 'choose', choices: ['yes'], allowFreeform: false }, { sessionId: 'native-id' });
  const meta = await h.engine.getMeta('native-id');
  assert.ok(meta?.ask);
  assert.equal(await h.engine.busyCount(), 1);
  await assert.rejects(h.engine.unload('native-id'), /protected/);
  await assert.rejects(h.engine.respondAsk('native-id', meta.ask.requestId, 'no', false), /offered/);
  assert.equal((await h.engine.getMeta('native-id'))?.ask?.requestId, meta.ask.requestId);
  await h.engine.respondAsk('native-id', meta.ask.requestId, 'yes', false);
  assert.deepEqual(await answer, { answer: 'yes', wasFreeform: false });
  assert.equal((await h.engine.getMeta('native-id'))?.ask, null);
  await h.engine.unload('native-id');
  await h.engine.stop();
});

test('a decision arriving during the safety read cannot be missed by teardown', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  let answer: ReturnType<NonNullable<SessionConfig['onUserInputRequest']>> | undefined;
  h.rpc.metadata.activity.mock.mockImplementationOnce(async () => {
    answer = h.config()!.onUserInputRequest!({ question: 'racing question', allowFreeform: true }, { sessionId: 'native-id' });
    // Closing rejects new decision callbacks rather than losing one. Observe the
    // rejected callback just as the native SDK does.
    void Promise.resolve(answer).catch(() => {});
    return { hasActiveWork: false, abortable: false };
  });
  // A lifecycle transition refuses a new callback; it never leaves an
  // unanswerable retained decision or a native metadata replica.
  await h.engine.unload('native-id');
  assert.ok(answer);
  await assert.rejects(Promise.resolve(answer), /closing/);
  assert.equal(h.retained().size, 0);
  await h.engine.stop();
});

test('a new native event racing the safety read prevents an idle confirmation', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  h.rpc.metadata.activity.mock.mockImplementationOnce(async () => {
    h.config()!.onEvent!({ type: 'assistant.turn_start', id: 'new-turn', timestamp: '2026-09-10T00:00:00Z',
      parentId: null, data: { turnId: 'new-turn' } });
    return { hasActiveWork: false, abortable: false };
  });
  await assert.rejects(h.engine.unload('native-id'), /protected/);
  assert.equal(h.native.live, true);
  await h.engine.unload('native-id');
  await h.engine.stop();
});

test('fork and metadata reads cannot enter another operation closing lock', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(h.runtime, 'closeSession', async () => { await hold; h.native.live = false; });
  const unloading = h.engine.unload('native-id');
  await nextTurn();
  await assert.rejects(h.engine.forkSession('native-id'), /transition|progress/i);
  await assert.rejects(h.engine.getMeta('native-id'), { code: 'SESSION_TRANSITION' });
  assert.equal(h.retained().get('native-id')?.closing, true);
  release();
  await unloading;
  assert.equal(h.retained().size, 0);
  await h.engine.stop();
});

test('metadata rechecks lifecycle admission after its asynchronous liveness probe', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  let probe!: (live: boolean) => void;
  const heldProbe = new Promise<boolean>(resolve => { probe = resolve; });
  t.mock.method(h.runtime, 'isSessionLive', async () => h.native.live)
    .mock.mockImplementationOnce(() => heldProbe);
  let close!: () => void;
  const heldClose = new Promise<void>(resolve => { close = resolve; });
  t.mock.method(h.runtime, 'closeSession', async () => { await heldClose; h.native.live = false; });
  const reading = h.engine.getMeta('native-id');
  const unloading = h.engine.unload('native-id');
  await nextTurn();
  const reads = h.rpc.metadata.snapshot.mock.callCount();
  probe(true);
  await assert.rejects(reading, { code: 'SESSION_TRANSITION' });
  assert.equal(h.rpc.metadata.snapshot.mock.callCount(), reads);
  close();
  await unloading;
  await h.engine.stop();
});

test('resource reads that lose admission cannot obstruct a closing operation', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  const unloading = h.engine.unload('native-id');
  const reading = h.engine.getPlan('native-id');
  await assert.rejects(reading, /lifecycle transition/);
  await unloading;
  assert.equal(h.rpc.plan.read.mock.callCount(), 0);
  await h.engine.stop();
  await assert.rejects(h.engine.snapshot(), { code: 'SESSION_TRANSITION' });
});

test('resource events invalidate consumers without background resource projections', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  const calls = h.rpc.model.getCurrent.mock.callCount();
  const events: string[] = [];
  h.engine.onEvent(event => events.push(event.type));
  h.config()!.onEvent!({ type: 'session.model_change', id: 'changed', timestamp: '2026-09-10T00:00:00Z',
    parentId: null, data: { newModel: 'changed' } });
  await nextTurn();
  assert.equal(h.rpc.model.getCurrent.mock.callCount(), calls);
  assert.ok(events.includes('session/invalidated'));
  await h.engine.unload('native-id');
  await h.engine.stop();
});
