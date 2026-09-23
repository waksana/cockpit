import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { errorWithCode } from '../test-support/errors.ts';
import {
  type NativeTask,
  type Rpc,
  connectionEvent,
  deferred,
  event,
  fakeSession,
  harness,
  nativeCallDelta,
  nativeCalls,
  protectedWork,
  queued,
  task,
  timestamp,
  unavailableSession,
} from '../test-support/engine-harness.ts';

test('native activity is freshly confirmed and resource events never schedule background reads', async t => {
  const h = harness(t);
  const s = await h.load();
  const before = nativeCalls(s);
  for (let i = 0; i < 20; i++) s.emit(event('session.todos_changed', {}));
  await nextTurn();
  assert.deepEqual(nativeCalls(s), before);
  for (const busy of [true, false]) {
    s.state.activeWork = busy;
    const meta = (await h.engine.getMeta(s.id))!;
    assert.equal(meta.nativeProcessing, busy);
    assert.equal(meta.status, busy ? 'running' : 'idle');
  }
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('failed metadata request is not retained or retried and a later request reads native truth', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.metadata.activity.mock.mockImplementationOnce(async () => { throw new Error('activity unavailable'); });
  await assert.rejects(h.engine.getMeta(s.id), /activity unavailable/);
  const calls = nativeCalls(s);
  await nextTurn();
  assert.deepEqual(nativeCalls(s), calls);
  const meta = (await h.engine.getMeta(s.id))!;
  assert.equal(meta.status, 'idle');
  assert.equal(meta.error, undefined);
  assert.equal(Object.hasOwn(meta, 'error'), false, 'native metadata has no public current-error getter');
});

for (const malformed of [
  'missing-processing', 'nonboolean-processing', 'missing-activity', 'nonboolean-activity',
  'missing-steering-count', 'negative-steering-count', 'fractional-steering-count',
] as const) {
  test(`native control fails closed for ${malformed} without remembering or retrying the malformed response`, async t => {
    const h = harness(t);
    const s = await h.load();
    if (malformed.endsWith('processing')) {
      s.rpc.metadata.isProcessing.mock.mockImplementation(async () => {
        const value = { processing: false };
        if (malformed === 'missing-processing') Reflect.deleteProperty(value, 'processing');
        else Reflect.set(value, 'processing', 'false');
        return value;
      });
    } else if (malformed.endsWith('activity')) {
      s.rpc.metadata.activity.mock.mockImplementation(async () => {
        const value = { hasActiveWork: false, abortable: false };
        if (malformed === 'missing-activity') Reflect.deleteProperty(value, 'hasActiveWork');
        else Reflect.set(value, 'hasActiveWork', 'false');
        return value;
      });
    } else if (malformed === 'missing-steering-count') {
      Reflect.deleteProperty(s.state.queue, 'inFlightSteeringCount');
    } else s.state.queue.inFlightSteeringCount = malformed === 'negative-steering-count' ? -1 : 0.5;
    await assert.rejects(h.engine.getMeta(s.id), /activity state is incomplete/);
    await assert.rejects(h.engine.unload(s.id), /activity state is incomplete/);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    const calls = nativeCalls(s);
    await nextTurn();
    assert.deepEqual(nativeCalls(s), calls, 'malformed native responses cannot trigger background retries');
    s.rpc.metadata.isProcessing.mock.restore();
    s.rpc.metadata.activity.mock.restore();
    s.state.queue.inFlightSteeringCount = 0;
    assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
    await h.engine.unload(s.id);
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  });
}

for (const operation of ['unload', 'stop'] as const) {
  test(`native ${operation} confirmation invalidated by a live event fails closed without polling`, async t => {
    const h = harness(t);
    const s = await h.load();
    const activity = deferred<Awaited<ReturnType<Rpc['metadata']['activity']>>>();
    s.rpc.metadata.activity.mock.mockImplementationOnce(() => activity.promise);
    const transition = operation === 'unload' ? h.engine.unload(s.id) : h.engine.stop();
    const rejected = assert.rejects(transition, protectedWork);
    await nextTurn();
    s.emit(event('session.title_changed', { title: 'Changed during confirmation' }));
    activity.resolve({ hasActiveWork: false, abortable: false });
    await rejected;
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    const calls = nativeCalls(s);
    await nextTurn();
    assert.deepEqual(nativeCalls(s), calls);
    assert.equal((await h.engine.getMeta(s.id))?.nativeProcessing, false);
  });
}


const usageMetrics = {
  sessionStartTime: timestamp, currentModel: 'native-model', totalUserRequests: 3,
  totalPremiumRequestCost: 1, totalApiDurationMs: 120,
  lastCallInputTokens: 800, lastCallOutputTokens: 90,
  codeChanges: { linesAdded: 0, linesRemoved: 0, filesModifiedCount: 0, filesModified: [] },
  modelMetrics: { 'native-model': {
    requests: { count: 3, cost: 1 },
    usage: { inputTokens: 2100, outputTokens: 180, cacheReadTokens: 500, cacheWriteTokens: 100 },
  } },
};
const usageContext = {
  totalTokens: 1000, modelId: 'native-model', modelSource: 'selected', promptTokenLimit: 10000,
  limit: 12000, bufferTokens: 2500, compactionThreshold: 8000,
  categories: { systemPrompt: 100, customInstructions: 100, systemTools: 100, mcpTools: 100, messages: 600, freeSpace: 8500, buffer: 2500 },
  entries: [{ kind: 'system', id: 'private-source', label: 'not exposed', tokens: 100 }],
  compactions: { count: 2 },
};
function installUsage(s: ReturnType<typeof fakeSession>, context: unknown = { contextAttribution: usageContext }, metrics: unknown = usageMetrics) {
  let calls = 0;
  Reflect.set(s.rpc.metadata, 'getContextAttribution', async () => { calls++; return context; });
  Reflect.set(s.rpc, 'usage', { getMetrics: async () => { calls++; return metrics; } });
  return () => calls;
}

test('control activity exposes private counts using exactly the existing five control reads', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.mcp.host!.pendingConnections = ['tools'];
  const before = nativeCalls(s);
  h.events.length = 0;
  const first = (await h.engine.getResources(s.id, ['control']))!.activity!;
  assert.deepEqual(first, {
    sampledAt: first.sampledAt, processing: false, hasActiveWork: false, abortable: false,
    tasks: { activeAgents: 0, activeShells: 0, unknown: 0 },
    queue: { pendingCount: 0, steeringCount: 0, inFlightSteeringCount: 0 },
    mcp: { pendingConnectionCount: 1 },
  });
  assert.ok(first.sampledAt > 0 && first.sampledAt <= Date.now());
  assert.deepEqual(nativeCallDelta(s, before), {
    'metadata.isProcessing': 1, 'metadata.activity': 1, 'queue.pendingItems': 1, 'tasks.list': 1, 'mcp.list': 1,
  });
  assert.ok(h.events.every(e => e.type === 'session/patch'
    && Object.keys(e).every(key => ['type', 'sessionId', 'activeOperations'].includes(key))));
  const legacy = (await h.engine.getMeta(s.id))!;
  assert.equal(legacy.status, 'running');
  assert.equal(legacy.nativeProcessing, true, 'existing compatibility semantics are unchanged');

  s.state.processing = true;
  s.state.tasks = [
    task('idle'),
    { type: 'shell', id: 'shell', description: 'Build', status: 'running', command: 'private-command',
      attachmentMode: 'attached', startedAt: timestamp },
  ];
  s.state.queue = { items: [queued('q', 'private-message')], steeringMessages: ['private-steering'], inFlightSteeringCount: 1 };
  const answer = h.configs.get(s.id)!.onUserInputRequest!({ question: 'Synthetic decision', choices: ['yes'] }, { sessionId: s.id });
  const beforeCombined = nativeCalls(s);
  const projection = (await h.engine.getResources(s.id, ['control', 'queue']))!;
  const current = projection.activity!;
  assert.equal(s.rpc.queue.pendingItems.mock.callCount() - beforeCombined['queue.pendingItems']!, 1);
  assert.equal(projection.ask!.question, 'Synthetic decision');
  assert.equal(current.processing, true);
  assert.equal(current.hasActiveWork, true);
  assert.equal(current.abortable, true);
  assert.deepEqual(current.tasks, { activeAgents: 0, activeShells: 1, unknown: 0 });
  assert.deepEqual(current.queue, { pendingCount: 1, steeringCount: 1, inFlightSteeringCount: 1 });
  assert.doesNotMatch(JSON.stringify(current), /private-|inspect fixture|startedAt|toolCallId|Build|background inspection|tools/);
  h.engine.respondAsk(s.id, projection.ask!.requestId, 'yes', false);
  await answer;
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('native activity preserves unexplained native work without claiming a running turn', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.activeWork = true;
  s.rpc.metadata.activity.mock.mockImplementation(async () => ({ hasActiveWork: true, abortable: false }));
  const result = (await h.engine.getResources(s.id, ['control']))!.activity!;
  assert.equal(result.processing, false);
  assert.equal(result.hasActiveWork, true);
  assert.equal(result.abortable, false);
  assert.deepEqual(result.tasks, { activeAgents: 0, activeShells: 0, unknown: 0 });
  assert.equal(result.mcp.pendingConnectionCount, 0);
});

test('native activity unloaded/unknown reads do not resume, create or register sessions', async t => {
  const h = harness(t);
  const s = await h.seed();
  const before = nativeCalls(s);
  assert.equal((await h.engine.getResources(s.id, ['control']))!.activity, null);
  assert.equal('activity' in (await h.engine.getResources(s.id, ['identity']))!, false);
  assert.equal(await h.engine.getResources('unknown', ['control']), null);
  assert.deepEqual(nativeCallDelta(s, before), {});
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(await h.engine.getMeta('unknown'), null);
});

test('native activity malformed or failed reads fail explicitly and release the read lease', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.metadata.activity.mock.mockImplementationOnce(async () => {
    const invalid = { hasActiveWork: false, abortable: false };
    Reflect.deleteProperty(invalid, 'abortable');
    return invalid;
  });
  await assert.rejects(h.engine.getResources(s.id, ['control']), /abortable/);
  s.rpc.tasks.list.mock.mockImplementationOnce(async () => { throw new Error('native task read failed'); });
  await assert.rejects(h.engine.getResources(s.id, ['control']), /native task read failed/);
  assert.ok(h.events.some(e => e.type === 'session/patch' && e.activity === null));
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('native activity reserves its read before a liveness probe and cannot race unload', async t => {
  const h = harness(t);
  const s = await h.load();
  const alive = deferred<boolean>();
  h.runtime.isSessionLive.mock.mockImplementationOnce(() => alive.promise);
  const reading = h.engine.getResources(s.id, ['control']);
  await nextTurn();
  const rejected = assert.rejects(h.engine.unload(s.id), errorWithCode('SESSION_BUSY'));
  alive.resolve(true);
  await rejected;
  await reading;
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
});

test('native activity rejects a response from a detached session', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<{ tasks: NativeTask[] }>();
  s.rpc.tasks.list.mock.mockImplementationOnce(() => held.promise);
  const rejected = assert.rejects(h.engine.getResources(s.id, ['control']), /closed/);
  await nextTurn();
  h.attached.delete(s.id);
  s.emit(connectionEvent('disconnected'));
  await rejected;
  held.resolve({ tasks: [] });
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
});

test('activity separates known task types and statuses while retaining conservative safety counts', async t => {
  const h = harness(t);
  const s = await h.load();
  const shell: NativeTask = { type: 'shell', id: 'shell', description: 'private', status: 'running',
    command: 'private', attachmentMode: 'attached', startedAt: timestamp };
  for (const status of ['running', 'idle', 'completed', 'failed', 'cancelled', 'future-status']) {
    s.state.tasks = [task('running'), structuredClone(shell)];
    for (const item of s.state.tasks) Reflect.set(item, 'status', status);
    const meta = (await h.engine.getResources(s.id, ['control']))!;
    assert.deepEqual(meta.activity!.tasks, {
      activeAgents: Number(status === 'running'), activeShells: Number(status === 'running'),
      unknown: status === 'future-status' ? 2 : 0,
    });
    assert.equal(meta.activeSubagents, ['running', 'future-status'].includes(status) ? 2 : 0);
    assert.equal(meta.nativeProcessing, ['running', 'future-status'].includes(status));
  }
  Reflect.set(s.state.tasks[0]!, 'type', 'client');
  Reflect.set(s.state.tasks[0]!, 'status', 'running');
  assert.deepEqual((await h.engine.getResources(s.id, ['control']))!.activity!.tasks,
    { activeAgents: 0, activeShells: 0, unknown: 2 });
});

test('activity follows list and snapshot control samples without leaking into unrelated projections', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.tasks = [{ type: 'shell', id: 'shell', description: 'private build', status: 'running',
    command: 'private-command', attachmentMode: 'attached', startedAt: timestamp }];
  s.emit(event('assistant.turn_end', { turnId: 'turn' }));
  const before = nativeCalls(s);
  assert.equal('activity' in (await h.engine.getResources(s.id, ['identity']))!, false);
  assert.equal(s.rpc.metadata.activity.mock.callCount(), before['metadata.activity']);
  for (const read of [() => h.engine.listLive(), async () => (await h.engine.snapshot()).sessions]) {
    const calls = nativeCalls(s);
    const [summary] = await read();
    assert.equal(summary!.activity!.processing, false);
    assert.equal(summary!.activity!.tasks.activeShells, 1);
    assert.equal(summary!.activity!.tasks.activeAgents, 0);
    assert.equal(s.rpc.metadata.activity.mock.callCount() - calls['metadata.activity']!, 1);
    assert.equal(s.rpc.tasks.list.mock.callCount() - calls['tasks.list']!, 1);
    assert.doesNotMatch(JSON.stringify(summary), /private build|private-command/);
  }
});

test('native invalidations clear sampled activity without eager reads and mid-read events cannot restore stale facts', async t => {
  const h = harness(t);
  const s = await h.load();
  for (const type of ['session.background_tasks_changed', 'pending_messages.modified', 'assistant.turn_end',
    'session.mcp_server_status_changed', 'session.compaction_start'] as const) {
    h.events.length = 0;
    const before = nativeCalls(s);
    s.emit(event(type, {}));
    assert.ok(h.events.some(e => e.type === 'session/patch' && e.activity === null), type);
    assert.deepEqual(nativeCallDelta(s, before), {});
  }
  const held = deferred<{ tasks: NativeTask[] }>();
  s.rpc.tasks.list.mock.mockImplementationOnce(() => held.promise);
  const reading = h.engine.getResources(s.id, ['control']);
  await nextTurn();
  s.emit(event('session.background_tasks_changed', {}));
  held.resolve({ tasks: [] });
  assert.equal((await reading)!.activity, null);
  assert.notEqual((await h.engine.getResources(s.id, ['control']))!.activity, null);
});

test('unrelated native invalidations do not discard an in-flight activity sample', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<{ tasks: NativeTask[] }>();
  s.rpc.tasks.list.mock.mockImplementationOnce(() => held.promise);
  const reading = h.engine.getResources(s.id, ['control']);
  await nextTurn();
  h.events.length = 0;
  s.emit(event('session.todos_changed', {}));
  held.resolve({ tasks: [] });
  assert.notEqual((await reading)!.activity, null);
  assert.ok(h.events.some(e => e.type === 'session/invalidated' && e.resources?.includes('todo')));
  assert.ok(!h.events.some(e => e.type === 'session/invalidated' && e.resources?.includes('control')));
});

test('native usage reads exactly two native snapshots, preserves scope, strips sources and never invokes inference', async t => {
  const h = harness(t);
  const s = await h.load();
  const before = nativeCalls(s);
  const calls = installUsage(s);
  const loaded = h.runtime.resumeSession.mock.callCount();
  const result = await h.engine.getUsage(s.id);
  assert.equal(calls(), 2);
  assert.equal(result.context?.totalTokens, 1000);
  assert.equal(result.context?.promptTokenLimit, 10000);
  assert.equal(result.usage.lastCallInputTokens, 800);
  assert.equal(result.usage.modelMetrics['native-model']?.usage.inputTokens, 2100);
  assert.equal(result.usage.modelMetrics['native-model']?.usage.reasoningTokens, undefined);
  assert.ok(!JSON.stringify(result).includes('private-source'));
  assert.equal(h.runtime.resumeSession.mock.callCount(), loaded);
  assert.equal(s.sdk.send.mock.callCount(), before.send);
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), before['ui.ephemeralQuery']);
  assert.equal(s.rpc.history.compact.mock.callCount(), before['history.compact']);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
});

for (const context of [{ contextAttribution: null }, {}]) {
  test(`native usage uninitialized context stays unavailable: ${JSON.stringify(context)}`, async t => {
    const h = harness(t);
    const s = await h.load();
    installUsage(s, context);
    assert.equal((await h.engine.getUsage(s.id)).context, null);
  });
}

test('native usage unloaded and unknown reads never resume/create/register a session', async t => {
  const h = harness(t);
  const s = await h.seed();
  const calls = installUsage(s);
  for (const id of [s.id, 'unknown']) await assert.rejects(h.engine.getUsage(id), unavailableSession);
  assert.equal(calls(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta('unknown')), null);
});

test('native usage unsupported, invalid and failed reads remain explicit rather than fake zero', async t => {
  const h = harness(t);
  const s = await h.load();
  await assert.rejects(h.engine.getUsage(s.id), /APIs are unavailable/);
  installUsage(s, { contextAttribution: usageContext }, { ...usageMetrics, lastCallInputTokens: -1 });
  await assert.rejects(h.engine.getUsage(s.id), /greater than or equal/);
  installUsage(s);
  Reflect.set(s.rpc, 'usage', { getMetrics: async () => { throw new Error('native usage failed'); } });
  await assert.rejects(h.engine.getUsage(s.id), /native usage failed/);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('native usage old response is rejected after detach while another session reads independently', async t => {
  const h = harness(t);
  const a = await h.load();
  const b = await h.load();
  const held = deferred<typeof usageMetrics>();
  installUsage(a);
  installUsage(b);
  Reflect.set(a.rpc, 'usage', { getMetrics: () => held.promise });
  const reading = h.engine.getUsage(a.id);
  const rejection = assert.rejects(reading, /closed/);
  await nextTurn();
  assert.equal((await h.engine.getUsage(b.id)).sessionId, b.id);
  h.attached.delete(a.id);
  a.emit(connectionEvent('disconnected'));
  await rejection;
  held.resolve(usageMetrics);
  await nextTurn();
  assert.equal((await h.engine.getMeta(a.id))?.loaded, false);
});

test('native usage reserves work before a held liveness probe so unload cannot begin', async t => {
  const h = harness(t);
  const s = await h.load();
  const calls = installUsage(s);
  const alive = deferred<boolean>();
  h.runtime.isSessionLive.mock.mockImplementationOnce(() => alive.promise);
  const reading = h.engine.getUsage(s.id);
  await nextTurn();
  const closing = h.engine.unload(s.id);
  const rejected = assert.rejects(closing, errorWithCode('SESSION_BUSY'));
  alive.resolve(true);
  await rejected;
  await reading;
  assert.equal(calls(), 2);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
});

for (const transition of ['unload', 'stop'] as const) {
  test(`native usage cannot join an already claimed ${transition} lifecycle`, async t => {
    const h = harness(t);
    const s = await h.load();
    const calls = installUsage(s);
    const alive = deferred<boolean>();
    h.runtime.isSessionLive.mock.mockImplementationOnce(() => alive.promise);
    const closing = transition === 'unload' ? h.engine.unload(s.id) : h.engine.stop();
    await nextTurn();
    const reading = h.engine.getUsage(s.id);
    const rejected = assert.rejects(reading, /lifecycle|transition|progress/i);
    alive.resolve(true);
    await rejected;
    await closing;
    assert.equal(calls(), 0);
  });
}
