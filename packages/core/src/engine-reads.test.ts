import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { SessionConfig } from '@github/copilot-sdk';
import type { ServerEvent } from '@cockpit/protocol';
import { Intents } from '@cockpit/protocol';
import { errorWithCode } from '../test-support/errors.ts';
import {
  type McpState,
  type NativeSchedule,
  type Rpc,
  activeState,
  deferred,
  event,
  harness,
  mcpState,
  nativeCallDelta,
  nativeCalls,
  protectedWork,
  queued,
  schedule,
  task,
  timestamp,
  unavailableSession,
} from '../test-support/engine-harness.ts';

test('native plan descriptions normalize only null to absence and preserve the complete mixed plan', async t => {
  const h = harness(t);
  const s = await h.load();
  const descriptions = [null, undefined, '', 'Actual description', null, '  '] as const;
  const rows = descriptions.map((description, index) => {
    const row = { id: `todo-${index}`, title: `Title ${index}`, status: index === 3 ? 'done' : 'pending' };
    if (description !== undefined) Reflect.set(row, 'description', description);
    return row;
  });
  const original = structuredClone(rows);
  s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows }));
  t.mock.method(s.rpc.plan, 'read', async () => ({ exists: true, content: '# Native plan', path: '/fixture/plan.md' }));
  const before = nativeCalls(s);
  const result = await h.engine.getPlan(s.id);
  const wire = Intents['session/plan'].result.parse(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(wire, {
    planMarkdown: '# Native plan',
    todos: rows.map(({ id, title, status }, index) => ({
      id, title, status, ...(descriptions[index] == null ? {} : { description: descriptions[index] }),
    })),
  });
  assert.equal('changedFiles' in result, false, 'plan reads do not reconstruct file changes from chat');
  assert.deepEqual(rows, original, 'native row objects are never rewritten');
  assert.deepEqual(nativeCallDelta(s, before), { 'plan.read': 1, 'plan.readSqlTodos': 1 });
});

for (const description of [0, false, {}, []]) {
  test(`native plan invalid description remains rejected by the result contract: ${JSON.stringify(description)}`, async t => {
    const h = harness(t);
    const s = await h.load();
    const row = { id: 'todo', title: 'Title', status: 'pending' };
    Reflect.set(row, 'description', description);
    s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows: [row] }));
    const result = await h.engine.getPlan(s.id);
    const parsed = Intents['session/plan'].result.safeParse(result);
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.deepEqual(parsed.error.issues[0]?.path, ['todos', 0, 'description']);
    assert.equal(result.todos.length, 1, 'invalid rows are not filtered away');
  });
}


for (const order of ['older-first', 'newer-first'] as const) {
  test(`request-owned metadata snapshots settle ${order} without caching their readbacks`, async t => {
    const h = harness(t);
    const s = await h.load();
    const older = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
    const newer = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
    s.rpc.model.getCurrent.mock.mockImplementationOnce(() => older.promise);
    const first = h.engine.getMeta(s.id);
    await nextTurn();
    s.rpc.model.getCurrent.mock.mockImplementationOnce(() => newer.promise);
    const second = h.engine.getMeta(s.id);
    await nextTurn();
    if (order === 'older-first') {
      older.resolve({ modelId: 'old-snapshot' });
      assert.equal((await first)?.currentModelId, 'old-snapshot');
      newer.resolve({ modelId: 'new-snapshot' });
    } else {
      newer.resolve({ modelId: 'new-snapshot' });
      assert.equal((await second)?.currentModelId, 'new-snapshot');
      older.resolve({ modelId: 'old-snapshot' });
    }
    assert.equal((await first)?.currentModelId, 'old-snapshot');
    assert.equal((await second)?.currentModelId, 'new-snapshot');
    s.state.model.modelId = 'current-native';
    assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'current-native');
    assert.equal(s.rpc.model.switchTo.mock.callCount(), 0);
  });
}

test('resource invalidations publish hints without reading or retaining native projections', async t => {
  const h = harness(t);
  const s = await h.load();
  const before = nativeCalls(s);
  h.events.length = 0;
  for (let i = 0; i < 20; i++) s.emit(event('session.model_change', { newModel: 'event-hint' }));
  s.emit(event('session.todos_changed', {}));
  s.emit(event('session.schedule_rearmed', { id: 7, nextRunAt: Date.parse(timestamp) }));
  await nextTurn();
  assert.deepEqual(nativeCalls(s), before);
  assert.ok(h.events.some(value => value.type === 'session/invalidated' && value.sessionId === s.id));
  s.state.model.modelId = 'current-native';
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'current-native');
  const state = activeState(h, s.id);
  for (const key of ['meta', 'tasks', 'nativeMcpPending', 'resourceReads', 'dirtyResources', 'resourceSync', 'steering', 'autoNameSeen']) {
    assert.equal(key in state, false, key + ' is not resident');
  }
});

test('held metadata requests do not block independent resource or session reads', async t => {
  const h = harness(t);
  const a = await h.load();
  const b = await h.load();
  const held = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
  a.rpc.model.getCurrent.mock.mockImplementationOnce(() => held.promise);
  const reading = h.engine.getMeta(a.id);
  await nextTurn();
  a.state.schedules = [schedule()];
  b.state.model.modelId = 'other-session';
  assert.equal((await h.engine.listSchedules(a.id)).length, 1);
  assert.equal((await h.engine.getMeta(b.id))?.currentModelId, 'other-session');
  held.resolve({ modelId: 'released' });
  assert.equal((await reading)?.currentModelId, 'released');
});

for (const outcome of ['success', 'failure'] as const) {
  test(`late metadata ${outcome} after closure cannot affect a replacement handle`, async t => {
    const h = harness(t);
    const s = await h.load();
    const held = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
    s.rpc.model.getCurrent.mock.mockImplementationOnce(() => held.promise);
    const reading = h.engine.getMeta(s.id);
    const rejected = assert.rejects(reading, /closed/);
    await nextTurn();
    h.runtime.expire(s.id, true);
    await rejected;
    s.state.model.modelId = 'replacement';
    await h.engine.reload(s.id);
    if (outcome === 'failure') held.reject(new Error('retired read failure'));
    else held.resolve({ modelId: 'retired snapshot' });
    await nextTurn();
    const meta = (await h.engine.getMeta(s.id))!;
    assert.equal(meta.currentModelId, 'replacement');
    assert.equal(meta.error, undefined);
  });
}

test('a failed independent read cannot discard a completed native model acknowledgement', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
  s.rpc.model.getCurrent.mock.mockImplementationOnce(() => held.promise);
  const rejected = assert.rejects(h.engine.getResources(s.id, ['model']), /own read failure/);
  assert.deepEqual(await h.engine.setModel(s.id, 'command'), { modelId: 'command' });
  await nextTurn();
  s.state.model.modelId = 'later-native';
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'later-native');
  held.reject(new Error('own read failure'));
  await rejected;
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'later-native');
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 1);
});

test('plan and schedule callers own their results without caching stale readbacks', async t => {
  const h = harness(t);
  const s = await h.load();
  const todos = deferred<Awaited<ReturnType<typeof s.rpc.plan.readSqlTodos>>>();
  const schedules = deferred<Awaited<ReturnType<Rpc['schedule']['list']>>>();
  s.rpc.plan.readSqlTodos.mock.mockImplementationOnce(() => todos.promise);
  s.rpc.schedule.list.mock.mockImplementationOnce(() => schedules.promise);
  const plan = h.engine.getPlan(s.id);
  const listing = h.engine.listSchedules(s.id);
  await nextTurn();
  s.state.schedules = [schedule(1), schedule(2)];
  s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows: [{ id: 'new', title: 'new todo', status: 'done' }] }));
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 2);
  todos.resolve({ rows: [] });
  schedules.resolve({ entries: [] });
  assert.deepEqual((await plan).todos, []);
  assert.deepEqual(await listing, []);
  assert.deepEqual((await h.engine.getMeta(s.id))?.todo, { total: 1, done: 1, intent: null });
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 2);
});

test('schedule mutations do not retry and subsequent reads never use old response projections', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.schedules = [schedule(1), schedule(2)];
  const old = deferred<Awaited<ReturnType<Rpc['schedule']['list']>>>();
  s.rpc.schedule.list.mock.mockImplementationOnce(() => old.promise);
  const listing = h.engine.listSchedules(s.id);
  await nextTurn();
  assert.equal(await h.engine.stopSchedule(s.id, 1), true);
  old.resolve({ entries: [] });
  assert.deepEqual(await listing, []);
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
});

test('MCP mutation readback cannot erase native pending work from later safety checks', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'connected' }]);
  const readback = deferred<McpState>();
  s.rpc.mcp.list.mock.mockImplementationOnce(() => readback.promise, s.rpc.mcp.list.mock.callCount() + 1);
  const toggling = h.engine.toggleSessionMcp(s.id, 'fixture', true);
  await nextTurn();
  s.state.mcp.host!.pendingConnections = ['native-connector'];
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 2);
  readback.resolve(mcpState([{ name: 'fixture', status: 'connected' }]));
  assert.equal((await toggling).ok, true);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 1);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('failed native MCP safety reads prevent closure without remembering a fake pending count', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.mcp.list.mock.mockImplementation(async () => { throw new Error('MCP unavailable'); });
  await assert.rejects(h.engine.stop(), /MCP unavailable/);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.stop.mock.callCount(), 0);
  await assert.rejects(h.engine.getMeta(s.id), /MCP unavailable/);
  const calls = nativeCalls(s);
  await nextTurn();
  assert.deepEqual(nativeCalls(s), calls);
});


test('resource reads count the real Engine paths without a native cache or list metadata refetch', async t => {
  const h = harness(t);
  const s = await h.load();
  await nextTurn();
  s.state.model.reasoningEffort = 'high';
  s.state.model.contextTier = 'long_context';
  s.state.mode = 'plan';
  s.state.name = 'Live title';
  const row = (await h.runtime.getSessionMetadata(s.id))!;
  row.modifiedTime = new Date('2026-09-10T12:00:00Z');
  const measure = async (run: () => Promise<unknown>) => {
    const before = nativeCalls(s);
    const live = h.runtime.isSessionLive.mock.callCount();
    const metadata = h.runtime.getSessionMetadata.mock.callCount();
    const lists = h.runtime.listSessions.mock.callCount();
    const models = h.runtime.models.mock.callCount();
    const value = await run();
    const native = nativeCallDelta(s, before);
    return { value, native, metadata: h.runtime.getSessionMetadata.mock.callCount() - metadata,
      count: Object.values(native).reduce((sum, n) => sum + n, 0)
        + h.runtime.isSessionLive.mock.callCount() - live
        + h.runtime.getSessionMetadata.mock.callCount() - metadata
        + h.runtime.listSessions.mock.callCount() - lists
        + h.runtime.models.mock.callCount() - models };
  };
  const full = await measure(() => h.engine.getMeta(s.id));
  assert.equal(full.count, 14, 'previous full getter: 13; plus one workspace name-provenance read');
  assert.equal(full.native['workspaces.getWorkspace'], 1);
  assert.equal(full.native['mode.get'], undefined);
  const meta = (await h.engine.getMeta(s.id))!;
  assert.equal(meta.currentMode, 'plan');
  assert.equal(meta.currentReasoningEffort, 'high');
  assert.equal(meta.currentContextTier, 'long_context');
  assert.equal(meta.lastActivity, row.modifiedTime.getTime());
  const list = await measure(() => h.engine.listLive());
  assert.equal(list.count, 10, 'previous brief path: 15');
  assert.equal(list.metadata, 0, 'reuse this request list record, not another single-ID metadata read');
  for (const read of ['model.list', 'plan.readSqlTodos', 'schedule.list', 'mode.get', 'workspaces.getWorkspace']) assert.equal(list.native[read], undefined, read);
  assert.equal((await h.engine.listLive())[0]?.title, 'Live title');
  const snapshot = await measure(() => h.engine.snapshot());
  assert.equal(snapshot.count, 12, 'previous snapshot path: 16');
  const status = await measure(async () => ({ sessions: await h.engine.status(), busy: await h.engine.busyCount() }));
  assert.equal(status.count, 15, 'previous status path: 22; fresh safety confirmation is retained');
  const scheduleRead = await measure(() => h.engine.getResources(s.id, ['schedule']));
  assert.equal(scheduleRead.count, 2, 'attach and one schedule.list, no identity/control/model fanout');
  assert.deepEqual(scheduleRead.native, { 'schedule.list': 1 });
  const queueRead = await measure(() => h.engine.getResources(s.id, ['queue']));
  assert.deepEqual(queueRead.native, { 'queue.pendingItems': 1 });
  const together = await measure(() => h.engine.getResources(s.id, ['control', 'queue', 'queue']));
  assert.equal(together.native['queue.pendingItems'], 1, 'one request reuses the required control queue read');
  s.state.model.modelId = 'changed-between-requests';
  assert.equal((await h.engine.getResources(s.id, ['model']))?.currentModelId, 'changed-between-requests');
});

test('narrow status retains queue-only, steering-only, task-only and MCP-only busy states and teardown protection', async t => {
  const h = harness(t);
  const s = await h.load();
  for (const change of [
    () => { s.state.queue.items = [queued('q', 'not a turn')]; },
    () => { s.state.queue.steeringMessages = ['pending steering']; },
    () => { s.state.queue.steeringMessages = ['consumed steering']; s.state.queue.inFlightSteeringCount = 1; },
    () => { s.state.tasks = [task()]; },
    () => { s.state.mcp.host!.pendingConnections = ['tools']; },
  ]) {
    change();
    assert.equal((await h.engine.listLive())[0]?.status, 'running');
    assert.equal((await h.engine.status())[0]?.status, 'running');
    await assert.rejects(h.engine.unload(s.id), protectedWork);
    s.state.queue = { items: [], steeringMessages: [], inFlightSteeringCount: 0 };
    s.state.tasks = [];
    s.state.mcp = mcpState();
  }
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('panel reads emit only lease patches and targeted panel reads use only their native resource', async t => {
  const h = harness(t);
  const s = await h.load();
  h.events.length = 0;
  const before = nativeCalls(s);
  await h.engine.getPanel(s.id, 'tasks');
  await h.engine.getPanel(s.id, 'instructionSources');
  assert.deepEqual(nativeCallDelta(s, before), { 'tasks.list': 1, 'instructions.getSources': 1 });
  assert.equal(h.events.filter(e => e.type === 'session/invalidated').length, 0);
  assert.ok(h.events.some(e => e.type === 'session/patch' && e.activeOperations === 1));
  h.events.length = 0;
  await h.engine.getPanels(s.id);
  await h.engine.getPlan(s.id);
  await h.engine.listSessionMcp(s.id);
  assert.equal(h.events.filter(e => e.type === 'session/invalidated').length, 0);
  s.emit(event('session.todos_changed', {}));
  assert.deepEqual(h.events.filter(e => e.type === 'session/invalidated').map(e => e.resources), [['todo', 'plan']]);
  h.events.length = 0;
  const beforeEvents = nativeCalls(s);
  s.emit(event('session.tools_updated', { model: 'gpt-test' }));
  s.emit(event('session.usage_checkpoint', { totalNanoAiu: 10 }));
  assert.deepEqual(h.events.filter(e => e.type === 'session/invalidated').map(e => e.resources), [['usage'], ['usage']]);
  assert.deepEqual(nativeCallDelta(s, beforeEvents), {}, 'resource notifications do not collect native state');
});

test('passive metadata reads publish no frames while overlapping panel operations publish their final zero', async t => {
  const h = harness(t);
  const s = await h.load();
  h.events.length = 0;
  await h.engine.getResources(s.id, ['identity', 'control', 'model']);
  await h.engine.getMeta(s.id);
  await h.engine.listLive();
  await h.engine.snapshot();
  assert.deepEqual(h.events.filter(e => e.type === 'session/patch'), []);
  assert.equal((await h.engine.getResources(s.id, ['control']))?.activeOperations, 0);
});
test('overlapping metadata and panel leases publish their final zero without resource invalidation', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<{ entries: NativeSchedule[] }>();
  s.rpc.schedule.list.mock.mockImplementationOnce(() => held.promise);
  h.events.length = 0;
  const metadata = h.engine.getResources(s.id, ['schedule']);
  await nextTurn();
  await h.engine.getPanel(s.id, 'tasks');
  held.resolve({ entries: [] });
  assert.equal((await metadata as { activeOperations: number } | undefined)?.activeOperations, 0);
  assert.deepEqual(h.events
    .filter((e): e is Extract<ServerEvent, { type: 'session/patch' }> & { activeOperations: number } =>
      e.type === 'session/patch' && e.activeOperations !== undefined)
    .map(e => e.activeOperations), [1, 0], 'the read lease is retained but not published');
  assert.equal(h.events.filter(e => e.type === 'session/invalidated').length, 0);
});
test('passive read leases do not block Stop or Interrupt, and still retain the handle', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<{ entries: NativeSchedule[] }>();
  s.rpc.schedule.list.mock.mockImplementation(() => held.promise);
  const metadata = h.engine.getResources(s.id, ['schedule']);
  await nextTurn();
  assert.deepEqual(await h.engine.interrupt(s.id), { ok: true, interrupted: false });
  await h.engine.cancel(s.id);
  assert.equal(s.sdk.abort.mock.callCount(), 1);
  await assert.rejects(h.engine.unload(s.id), /in progress|busy/i);
  held.resolve({ entries: [] });
  await metadata;
});
test('native mutation events and readback invalidate the changed resource once, without suppressing control', async t => {
  const h = harness(t);
  const s = await h.load();
  const ack = deferred<void>();
  s.state.skills = [{ name: 'fixture', source: 'project', enabled: false, description: '', userInvocable: true }];
  s.rpc.skills.enable.mock.mockImplementation(async () => {
    s.state.skills[0]!.enabled = true;
    s.emit(event('session.skills_loaded', { skills: [] }));
    s.emit(event('pending_messages.modified', {}));
    await ack.promise;
  });
  h.events.length = 0;
  const mutation = h.engine.toggleSessionSkill(s.id, 'fixture', true);
  await nextTurn();
  assert.ok(h.events.some(e => e.type === 'session/invalidated' && e.resources?.includes('control')));
  assert.ok(!h.events.some(e => e.type === 'session/invalidated' && e.resources?.includes('skills')));
  ack.resolve();
  await mutation;
  assert.equal(h.events.filter(e => e.type === 'session/invalidated' && e.resources?.includes('skills')).length, 1);
});

test('session and MCP list projections consume selected records, not repeated same-array find', async t => {
  const h = harness(t);
  const s = await h.load();
  const rows = await h.runtime.listSessions();
  rows.find = () => assert.fail('list projection must use a request-owned index');
  h.runtime.listSessions.mock.mockImplementation(async () => rows);
  await h.engine.listLive();
  const mcp = mcpState(Array.from({ length: 200 }, (_, i) => ({ name: `server-${i}`, status: 'connected' })));
  mcp.servers.find = () => assert.fail('MCP projection already has this record');
  s.rpc.mcp.list.mock.mockImplementation(async () => mcp);
  const before = nativeCalls(s);
  assert.equal((await h.engine.listSessionMcp(s.id)).servers.length, 200);
  assert.equal((await h.engine.getPanels(s.id)).mcpServers.length, 200);
  assert.equal(nativeCallDelta(s, before)['mcp.list'], 2, 'one necessary native list for each request');
});

test('Engine exposes no recycle or recycleIdle API', t => {
  const h = harness(t);
  assert.equal('recycle' in h.engine, false);
  assert.equal('recycleIdle' in h.engine, false);
});

const readOnlyMethods = ['getPlan', 'getPanels', 'listSchedules', 'listSessionSkills'] as const;
for (const method of readOnlyMethods) {
  for (const availability of ['unloaded', 'expired', 'unconfirmed'] as const) {
    test(`${method} rejects ${availability} sessions without native reads, resume, or creation`, async t => {
      const h = harness(t);
      const s = availability === 'unloaded' ? await h.seed() : await h.load();
      const resumes = h.runtime.resumeSession.mock.callCount();
      const before = nativeCalls(s);
      const probes = h.runtime.isSessionLive.mock.callCount();
      if (availability === 'expired') h.runtime.expire(s.id);
      if (availability === 'unconfirmed') {
        h.runtime.isSessionLive.mock.mockImplementationOnce(async () => { throw new Error('native attach unavailable'); });
      }
      await assert.rejects(h.engine[method](s.id), availability === 'unconfirmed'
        ? unavailableSession
        : { statusCode: 409, code: 'SESSION_UNLOADED' });
      assert.deepEqual(nativeCalls(s), before);
      assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
      assert.equal(h.runtime.createSession.mock.callCount(), 0);
      assert.equal(h.runtime.closeSession.mock.callCount(), 0);
      assert.equal(h.runtime.isSessionLive.mock.callCount(), probes + (availability === 'unloaded' ? 0 : 1));
      if (availability !== 'unconfirmed') {
        assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
        assert.equal((await h.engine.getMeta(s.id))?.error, undefined, 'an unloaded detail read is not a session execution failure');
      }
    });
  }

  test(`${method} checks a loaded handle passively before its requested native read`, async t => {
    const h = harness(t);
    const s = await h.load();
    const confirmation = deferred<boolean>();
    const probes = h.runtime.isSessionLive.mock.callCount();
    const before = nativeCalls(s);
    h.runtime.isSessionLive.mock.mockImplementationOnce(async () => {
      const live = await confirmation.promise;
      if (!live) s.listeners.clear();
      return live;
    });
    const reading = h.engine[method](s.id);
    await nextTurn();
    assert.equal(h.runtime.isSessionLive.mock.callCount(), probes + 1);
    assert.deepEqual(h.runtime.isSessionLive.mock.calls.at(-1)!.arguments, [s.sdk]);
    assert.deepEqual(nativeCalls(s), before, 'no native read may race ahead of attach confirmation');
    confirmation.resolve(true);
    await reading;
    assert.notDeepEqual(nativeCalls(s), before, 'the requested read should run after confirmation');
    assert.equal(s.rpc.metadata.isProcessing.mock.callCount(), before['metadata.isProcessing']);
    assert.equal(s.rpc.metadata.activity.mock.callCount(), before['metadata.activity']);
    assert.equal(s.sdk.getEvents.mock.callCount(), before.getEvents);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
  });
}

test('listSessionMcp never invents unloaded enablement from global or legacy settings', async t => {
  const h = harness(t, {
    mcpServers: { fixture: { command: 'never-executed', args: [] } }, prefs: { mcpDefaultOn: ['fixture'] },
  });
  const s = await h.seed();
  const result = await h.engine.listSessionMcp(s.id);
  assert.equal(result.loaded, false);
  assert.deepEqual(result.servers, []);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.list.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.discover.mock.callCount(), 0);
});

for (const action of ['unload', 'stop'] as const) {
  test(`future native schedules permit ${action} and stay paused until explicit resume`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.schedules = [{ ...schedule(), nextRunAt: new Date(Date.now() + 86_400_000).toISOString() }];
    await h.engine.listSchedules(s.id);
    const schedules = structuredClone(s.state.schedules);
    assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
    if (action === 'unload') await h.engine.unload(s.id);
    else await h.engine.stop();
    if (action === 'unload') assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
    else await assert.rejects(h.engine.getMeta(s.id), errorWithCode('SESSION_TRANSITION'));
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
    assert.equal(s.sdk.abort.mock.callCount(), 0);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
    assert.deepEqual(s.state.schedules, schedules);
    assert.equal(h.prefs().scheduledSessions, undefined);
    await h.engine.start();
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
    assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, undefined);
    await h.engine.reload(s.id);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 2);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
    assert.deepEqual(s.state.schedules, schedules);
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
    await h.engine.stop();
    assert.equal(h.prefs().scheduledSessions, undefined);
  });
}

test('startup leaves legacy scheduled sessions unloaded with unknown counts and no native reads', async t => {
  const h = harness(t, { prefs: { scheduledSessions: { scheduled: 1 } } });
  const scheduled = await h.seed('scheduled');
  const history = await h.seed('history-only');
  scheduled.state.schedules = [schedule(42)];
  await h.engine.start();
  const before = nativeCalls(scheduled);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(scheduled.id))?.loaded, false);
  assert.equal((await h.engine.getMeta(scheduled.id))?.scheduleCount, undefined);
  assert.equal((await h.engine.getMeta(history.id))?.scheduleCount, undefined);
  assert.equal((await h.engine.getMeta(history.id))?.loaded, false);
  assert.equal(scheduled.rpc.commands.invoke.mock.callCount(), 0);
  assert.equal(scheduled.rpc.schedule.stop.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(8000);
    await nextTurn();
  }
  await h.engine.stop();
  assert.deepEqual(nativeCalls(scheduled), before);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.deepEqual(scheduled.state.schedules, [schedule(42)]);
  assert.deepEqual(h.prefs().scheduledSessions, { scheduled: 1 }, 'inert old records are not rewritten or replayed');
});

test('native expiry retains schedules without local persistence or startup resumption', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.schedules = [schedule(19)];
  await h.engine.listSchedules(s.id);
  const before = nativeCalls(s);
  h.runtime.expire(s.id, true);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(h.prefs().scheduledSessions, undefined);
  assert.deepEqual(s.state.schedules, [schedule(19)]);
  await h.engine.stop();
  await h.engine.start();
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, undefined);
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  await h.engine.stop();
});

for (const work of ['idle', 'native work', 'choices', 'unresolved send'] as const) {
  test(`idle time never polls session lists, liveness, or resources with ${work}`, async t => {
    const h = harness(t);
    const s = await h.load();
    const unloaded = await h.seed();
    await h.engine.start();
    const acceptance = deferred<string>();
    let sending: Promise<unknown> | undefined;
    let answer: ReturnType<NonNullable<SessionConfig['onUserInputRequest']>> | undefined;
    if (work === 'native work') {
      s.state.processing = true;
      s.state.activeWork = true;
      s.state.tasks = [task()];
      s.state.queue.items = [queued('native-pending', 'pending work')];
      s.state.schedules = [schedule()];
      s.emit(event('pending_messages.modified', {}));
    } else if (work === 'choices') {
      answer = h.configs.get(s.id)!.onUserInputRequest!({ question: 'Still waiting?' }, { sessionId: s.id });
    } else if (work === 'unresolved send') {
      s.sdk.send.mock.mockImplementation(() => acceptance.promise);
      sending = h.engine.prompt(s.id, 'pending acceptance');
    }
    await nextTurn();
    const before = nativeCalls(s);
    const listCalls = h.runtime.listSessions.mock.callCount();
    const probes = h.runtime.isSessionLive.mock.callCount();
    t.mock.timers.tick(7999);
    await nextTurn();
    assert.equal(h.runtime.listSessions.mock.callCount(), listCalls);
    assert.equal(h.runtime.isSessionLive.mock.callCount(), probes);
    for (const milliseconds of [1, 8000, 8000]) {
      t.mock.timers.tick(milliseconds);
      await nextTurn();
      assert.deepEqual(nativeCalls(s), before, 'no automatic native polling is permitted');
    }
    assert.equal(h.runtime.listSessions.mock.callCount(), listCalls);
    assert.equal(h.runtime.isSessionLive.mock.callCount(), probes);
    for (const call of h.runtime.isSessionLive.mock.calls.slice(probes)) assert.equal(call.arguments[0], s.sdk);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(unloaded.sdk.getEvents.mock.callCount(), 0);
    if (answer) {
      assert.ok((await h.engine.getMeta(s.id))?.ask);
      await h.engine.respondAsk(s.id, (await h.engine.getMeta(s.id))!.ask!.requestId, 'done', true);
      await answer;
    }
    if (sending) {
      acceptance.resolve('accepted-pending');
      await sending;
      s.emit(event('user.message', { content: 'pending acceptance', messageId: 'accepted-pending' }));
    }
    s.state.processing = false;
    s.state.activeWork = false;
    s.state.tasks = [];
    s.state.queue.items = [];
    s.emit(event('session.idle', {}));
    await nextTurn();
    await h.engine.stop();
  });
}
