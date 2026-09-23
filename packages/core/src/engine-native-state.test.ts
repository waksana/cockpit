import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  type McpState,
  type NativeTask,
  type Rpc,
  activeState,
  assertSameControlFacts,
  assistant,
  chat,
  connectionEvent,
  deferred,
  event,
  finishReply,
  harness,
  mcpState,
  nativeCallDelta,
  nativeCalls,
  promptly,
  protectedWork,
  schedule,
  task,
  timestamp,
  user,
} from '../test-support/engine-harness.ts';

test('work events invalidate without polling or eager native activity reads', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.start();
  const before = s.rpc.metadata.activity.mock.callCount();
  s.state.processing = true;
  s.emit(event('assistant.turn_start', { turnId: 'native-work' }));
  s.emit(event('pending_messages.modified', {}));
  await nextTurn();
  assert.equal(s.rpc.metadata.activity.mock.callCount(), before);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  const synced = nativeCalls(s);
  t.mock.timers.tick(8000);
  await nextTurn();
  assert.deepEqual(nativeCalls(s), synced);
  s.state.processing = false;
  s.emit(event('session.idle', {}));
  await nextTurn();
  await h.engine.stop();
});

test('routine tool completions perform zero native reads without clearing running work', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.processing = true;
  s.emit(event('assistant.turn_start', { turnId: 'many-tools' }));
  const before = nativeCalls(s);
  const probes = h.runtime.isSessionLive.mock.callCount();
  for (let i = 0; i < 20; i++) {
    s.emit(event('tool.execution_start', { toolCallId: `tool-${i}`, toolName: 'view', arguments: { path: 'fixture' } }));
    s.emit(event('tool.execution_complete', { toolCallId: `tool-${i}`, success: true }));
    await nextTurn();
  }
  assert.deepEqual(nativeCallDelta(s, before), {});
  assert.equal(h.runtime.isSessionLive.mock.callCount(), probes);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.state.processing = false;
  s.emit(event('session.idle', {}));
  await nextTurn();
  await h.engine.unload(s.id);
});

test('a new turn after a metadata request is reflected by the next request and safety guard', async t => {

  const h = harness(t);
  const s = await h.load();
  const activity = deferred<Awaited<ReturnType<Rpc['metadata']['activity']>>>();
  s.rpc.metadata.activity.mock.mockImplementationOnce(() => activity.promise);
  const reading = h.engine.getMeta(s.id);
  await nextTurn();
  s.state.processing = true;
  s.emit(event('assistant.turn_start', { turnId: 'newer-turn' }));
  activity.resolve({ hasActiveWork: false, abortable: false });
  await reading;
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  await assert.rejects(h.engine.unload(s.id), protectedWork);
});

test('task lifecycle reads native status and treats idle agents as idle, not protected work', async t => {
  const h = harness(t);
  const s = await h.load();
  const before = nativeCalls(s);
  s.state.tasks = [task()];
  s.emit(event('session.background_tasks_changed', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.activeSubagents, 1);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  s.state.tasks = [task('idle')];
  s.emit(event('session.background_tasks_changed', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.activeSubagents, 0);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  assert.equal(s.rpc.tasks.list.mock.callCount() - before['tasks.list']!, 4, 'each metadata request rereads tasks');
  await h.engine.stop();
});

test('task-tool completion confirms the remaining native registry instead of trusting tool completion as idle', async t => {
  const h = harness(t);
  const s = await h.load();
  s.emit(event('tool.execution_start', { toolCallId: 'spawn-tool-call', toolName: 'task', arguments: {} }));
  s.state.tasks = [task()];
  const before = nativeCalls(s);
  s.emit(event('tool.execution_complete', { toolCallId: 'spawn-tool-call', success: true }));
  await nextTurn();
  assert.deepEqual(nativeCallDelta(s, before), {}, 'tool completion only invalidates');
  assert.equal((await h.engine.getMeta(s.id))?.activeSubagents, 1);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  s.state.tasks = [task('idle')];
  s.emit(event('session.background_tasks_changed', {}));
  await nextTurn();
  await h.engine.unload(s.id);
});

test('resource events invalidate without native reads and fresh MCP state still protects close', async t => {
  const h = harness(t);
  const s = await h.load();
  let before = nativeCalls(s);
  s.state.schedules = [schedule(101)];
  s.emit(event('session.schedule_created', { id: 101, prompt: 'check build', recurring: true, intervalMs: 60_000 }));
  await nextTurn();
  assert.deepEqual(nativeCallDelta(s, before), {}, 'resource events only invalidate');
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
  before = nativeCalls(s);
  s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows: [{ id: '1', title: 'work', status: 'done' }] }));
  s.emit(event('session.todos_changed', {}));
  await nextTurn();
  assert.deepEqual(nativeCallDelta(s, before), {}, 'resource events only invalidate');
  assert.deepEqual((await h.engine.getMeta(s.id))?.todo, { done: 1, total: 1, intent: null });
  before = nativeCalls(s);
  s.state.model.modelId = 'native-new-model';
  s.emit(event('session.model_change', { newModel: 'native-new-model' }));
  await nextTurn();
  assert.deepEqual(nativeCallDelta(s, before), {}, 'resource events only invalidate');
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'native-new-model');
  before = nativeCalls(s);
  s.state.mcp.host!.pendingConnections = ['native-connector'];
  s.emit(event('session.mcp_server_status_changed', { serverName: 'native-connector', status: 'pending' }));
  await nextTurn();
  assert.deepEqual(nativeCallDelta(s, before), {}, 'resource events only invalidate');
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.state.mcp.host!.pendingConnections = [];
  s.emit(event('session.mcp_server_status_changed', { serverName: 'native-connector', status: 'connected' }));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
  await h.engine.unload(s.id);
});

test('failed resource requests do not fabricate work, while unreadable MCP state protects close', async t => {

  const h = harness(t);
  const s = await h.load();
  s.rpc.plan.readSqlTodos.mock.mockImplementationOnce(async () => { throw new Error('todo read unavailable'); });
  await assert.rejects(h.engine.getMeta(s.id), /todo read unavailable/);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  s.rpc.mcp.list.mock.mockImplementation(async () => { throw new Error('MCP read unavailable'); });
  await assert.rejects(h.engine.getMeta(s.id), /MCP read unavailable/);
  await assert.rejects(h.engine.unload(s.id), /MCP read unavailable/);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.rpc.mcp.list.mock.mockImplementation(async () => mcpState());
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
  await h.engine.unload(s.id);
});

test('native pending MCP state protects mutation and held current-state checks delay closure', async t => {

  const h = harness(t);
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'pending' }]);
  s.state.mcp.host!.pendingConnections = ['fixture'];
  s.emit(event('session.mcp_server_status_changed', { serverName: 'fixture', status: 'pending' }));
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
  await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', true), protectedWork);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
  const readback = deferred<McpState>();
  s.rpc.mcp.list.mock.mockImplementationOnce(() => readback.promise);
  const unloading = h.engine.unload(s.id);
  await nextTurn();
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  readback.resolve(mcpState([{ name: 'fixture', status: 'connected' }]));
  await unloading;
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
});

test('native closure rejects a held control request before resume and ignores its late rejection', async t => {

  const h = harness(t);
  const s = await h.load();
  const held = deferred<Awaited<ReturnType<typeof s.rpc.metadata.activity>>>();
  s.rpc.metadata.activity.mock.mockImplementationOnce(() => held.promise);
  const reading = h.engine.getMeta(s.id);
  const rejected = assert.rejects(reading, /closed/);
  await nextTurn();
  h.runtime.expire(s.id, true);
  await promptly(rejected);
  await promptly(h.engine.reload(s.id));
  const meta = await h.engine.getMeta(s.id);
  held.reject(new Error('late old wrapper failure'));
  await nextTurn();
  assertSameControlFacts(await h.engine.getMeta(s.id), meta);
  await promptly(h.engine.stop());
});

test('native closure releases hung resource reads and ignores their late failures after resume', async t => {

  const h = harness(t);
  const s = await h.load();
  const held = deferred<Awaited<ReturnType<typeof s.rpc.plan.readSqlTodos>>>();
  s.rpc.plan.readSqlTodos.mock.mockImplementationOnce(() => held.promise);
  const reading = h.engine.getMeta(s.id);
  const rejected = assert.rejects(reading, /closed/);
  await nextTurn();
  h.runtime.expire(s.id, true);
  await promptly(rejected);
  await promptly(h.engine.reload(s.id));
  const meta = await h.engine.getMeta(s.id);
  held.reject(new Error('late old resource failure'));
  await nextTurn();
  assertSameControlFacts(await h.engine.getMeta(s.id), meta);
  await promptly(h.engine.stop());
});

test('routine closure preserves early live replies even when initialization metadata never settles', async t => {
  const h = harness(t);
  const s = await h.seed();
  const metadata = await s.rpc.metadata.snapshot();
  const eligibility = deferred<typeof metadata>();
  s.rpc.metadata.snapshot.mock.mockImplementationOnce(() => eligibility.promise);
  const loading = assert.rejects(h.engine.reload(s.id), /closed/);
  await nextTurn();
  s.emit(user('buffered-user', 'question before expiry'));
  s.emit(event('assistant.turn_start', { turnId: 'buffered-turn' }));
  s.emit(assistant('buffered-answer-event', 'buffered-answer', 'completed before expiry'));
  s.emit(event('assistant.turn_end', { turnId: 'buffered-turn' }, 'buffered-end'));
  h.runtime.expire(s.id, true);
  await promptly(loading);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal(h.events.filter(event => String(event.type) === 'session/notify').length, 0);
  await h.engine.reload(s.id);
  eligibility.resolve(metadata);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  assert.equal(h.events.filter(event => String(event.type) === 'session/notify').length, 0);
  await h.engine.stop();
});

test('native closure during an MCP mutation cannot restore phantom pending connections', async t => {
  const h = harness(t, { mcpServers: { fixture: { command: 'never-executed' } } });
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
  const enable = deferred();
  s.rpc.mcp.enable.mock.mockImplementationOnce(() => enable.promise);
  const changing = assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', true), /closed/);
  await nextTurn();
  const before = s.rpc.mcp.list.mock.callCount();
  h.runtime.expire(s.id, true);
  await promptly(changing);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, undefined);
  enable.resolve();
  await nextTurn();
  assert.equal(s.rpc.mcp.list.mock.callCount(), before);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, undefined);
  await h.engine.unload(s.id);
  await h.engine.stop();
});

for (const source of ['runtime callback', 'passive poll'] as const) {
  test(`${source} drops an expired live projection without resuming, deleting history, or consuming inbox`, async t => {
    const h = harness(t);
    const s = await h.load();
    await h.engine.start();
    await finishReply(s, 'persist this unread reply', 'native-expiry');
    h.journals.set(s.id, structuredClone(s.state.events));
    const history = await chat(h, s.id);
    const attention = h.prefs().inbox;
    const before = nativeCalls(s);
    h.events.length = 0;
    h.runtime.expire(s.id, source === 'runtime callback');
    if (source === 'passive poll') t.mock.timers.tick(8000);
    await nextTurn();
    assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
    assert.equal((await h.engine.getMeta(s.id))?.status, 'unloaded');
    assert.equal(s.listeners.size, 0);
    assert.deepEqual(nativeCalls(s), before);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
    assert.deepEqual(h.prefs().inbox, attention);
    assert.deepEqual((await chat(h, s.id)).events, history.events);
    assert.ok(!h.events.some(event => event.type === 'session/removed'));
    assert.ok(h.events.some(event => event.type === 'session/patch' && event.sessionId === s.id && event.loaded === false));
    await h.engine.stop();
  });
}

test('native reconnect invalidates control without polling and fences a pre-disconnect activity sample', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<{ tasks: NativeTask[] }>();
  s.rpc.tasks.list.mock.mockImplementationOnce(() => held.promise);
  const reading = h.engine.getResources(s.id, ['control']);
  await nextTurn();
  const before = nativeCalls(s);
  h.events.length = 0;
  s.emit(connectionEvent('disconnected'));
  await nextTurn();
  assert.ok(h.events.some(e => e.type === 'session/patch' && e.activity === null));
  s.emit(connectionEvent('connected'));
  assert.deepEqual(nativeCallDelta(s, before), {});
  assert.equal(h.events.filter(e => e.type === 'session/invalidated' && e.resources?.includes('control')).length, 1);
  held.resolve({ tasks: [] });
  assert.equal((await reading)!.activity, null);
  assert.notEqual((await h.engine.getResources(s.id, ['control']))!.activity, null);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

const closureSignals = [
  ['session.shutdown', () => event('session.shutdown', {
    shutdownType: 'routine', sessionStartTime: Date.parse(timestamp), totalApiDurationMs: 0,
    modelMetrics: {}, codeChanges: { filesModified: [], linesAdded: 0, linesRemoved: 0 },
  })],
  ['session.connection_state_changed disconnected', () => connectionEvent('disconnected')],
  ['session.connection_state_changed reconnecting', () => connectionEvent('reconnecting')],
] as const;
for (const [name, signal] of closureSignals) {
  for (const alive of [false, true]) {
    test(`${name} confirms attachment and ${alive ? 'keeps a live handle' : 'drops an expired handle'}`, async t => {
      const h = harness(t);
      const s = await h.load();
      const confirmation = deferred<boolean>();
      const probes = h.runtime.isSessionLive.mock.callCount();
      const before = nativeCalls(s);
      if (!alive) h.runtime.expire(s.id);
      h.runtime.isSessionLive.mock.mockImplementationOnce(async () => {
        const live = await confirmation.promise;
        if (!live) s.listeners.clear();
        return live;
      });
      s.emit(signal());
      await nextTurn();
      assert.equal(h.runtime.isSessionLive.mock.callCount(), probes + 1);
      assert.ok(activeState(h, s.id), 'a signal alone does not detach the handle before confirmation');
      assert.deepEqual(nativeCalls(s), before);
      confirmation.resolve(alive);
      await nextTurn();
      assert.deepEqual(nativeCalls(s), before, 'closure signal checks liveness, not resources');
      assert.equal((await h.engine.getMeta(s.id))?.loaded, alive);
      assert.equal(s.listeners.size, alive ? 1 : 0);
      assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
      assert.equal(h.runtime.createSession.mock.callCount(), 0);
      assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    });
  }
}

test('missing shutdown is recovered by prompt preflight, with one resume followed by one send', async t => {
  const h = harness(t);
  const s = await h.load();
  h.runtime.expire(s.id);
  const probes = h.runtime.isSessionLive.mock.callCount();
  h.trace.length = 0;
  s.sdk.send.mock.mockImplementation(async () => {
    assert.ok(h.attached.has(s.id), 'send must follow the confirmed resume');
    h.trace.push(`send:${s.id}`);
    return 'accepted-after-expiry';
  });
  await h.engine.prompt(s.id, 'explicit new prompt');
  assert.ok(h.runtime.isSessionLive.mock.callCount() > probes);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 2);
  assert.equal(s.sdk.send.mock.callCount(), 1);
  assert.deepEqual(h.trace, [`resume:${s.id}`, `send:${s.id}`]);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
});
