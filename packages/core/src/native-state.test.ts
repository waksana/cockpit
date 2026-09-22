import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { CopilotSession, SessionConfig, SessionEvent, SessionMetadata } from '@github/copilot-sdk';
import { Engine, type EngineRuntime } from './engine.ts';

type Rpc = CopilotSession['rpc'];
const runningAgent = (id: string): Awaited<ReturnType<Rpc['tasks']['list']>>['tasks'][number] => ({
  id, type: 'agent', status: 'running', toolCallId: id, description: `Description ${id}`,
  displayName: `Display ${id}`, startedAt: '2026-09-22T00:00:00Z', agentType: 'test', prompt: 'private prompt',
});
const queuedMessage = (id: string, messageId = id): Awaited<ReturnType<Rpc['queue']['pendingItems']>>['items'][number] => ({
  id, messageId, kind: 'message', displayText: `Message ${messageId}`, agentMode: 'interactive',
});

async function controlsFixture(t: TestContext) {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  const controls = async () => (await h.engine.getResources('native-id', ['controls']))!.controls!;
  const token = (await controls()).token;
  t.after(async () => {
    h.native.tasks = [];
    h.native.queue = [];
    h.native.steering = [];
    h.native.inFlight = 0;
    h.native.busy = false;
    await h.engine.cancel('native-id');
    await h.engine.unload('native-id');
    await h.engine.stop();
  });
  return { ...h, controls, token };
}

test('controls never resume unloaded handles and rotate their token on reload', async t => {
  const h = await controlsFixture(t);
  await h.engine.unload('native-id');
  const resumes = h.runtime.resumeSession as unknown as ReturnType<TestContext['mock']['fn']>;
  const count = resumes.mock.callCount();
  assert.equal((await h.engine.getResources('native-id', ['controls']))?.controls, null);
  await assert.rejects(h.engine.control('native-id', h.token, { type: 'stop-all' }), { code: 'SESSION_UNLOADED' });
  assert.equal(resumes.mock.callCount(), count);
  await h.engine.reload('native-id');
  assert.notEqual((await h.controls()).token, h.token);
  await assert.rejects(h.engine.control('native-id', h.token, { type: 'clear-queue' }), { code: 'STALE_SESSION_CONTROLS' });
  assert.equal(h.rpc.queue.clear.mock.callCount(), 0);
});

test('controls share native reads, filter active known tasks and expose only unconsumed steering', async t => {
  const h = await controlsFixture(t);
  h.native.tasks = [runningAgent('agent'), { ...runningAgent('idle'), status: 'idle' },
    { ...runningAgent('done'), status: 'completed' },
    { id: 'shell', type: 'shell', status: 'running', description: '', command: 'echo safe',
      attachmentMode: 'attached', startedAt: '2026-09-22T00:00:00Z' },
    { ...runningAgent('unknown'), type: 'future' } as unknown as typeof h.native.tasks[number]];
  h.native.queue = [queuedMessage('batch', 'first'), queuedMessage('batch', 'second'),
    { id: 'command', kind: 'command', displayText: '/model', agentMode: 'interactive' }];
  h.native.steering = ['consumed', 'waiting'];
  h.native.inFlight = 1;
  const before = [h.rpc.tasks.list, h.rpc.queue.pendingItems, h.rpc.metadata.isProcessing, h.rpc.metadata.activity]
    .map(mock => mock.mock.callCount());
  const meta = (await h.engine.getResources('native-id', ['control', 'controls', 'queue']))!;
  assert.deepEqual([h.rpc.tasks.list, h.rpc.queue.pendingItems, h.rpc.metadata.isProcessing, h.rpc.metadata.activity]
    .map((mock, index) => mock.mock.callCount() - before[index]!), [1, 1, 1, 1]);
  assert.equal(meta.controls?.main, false);
  assert.equal(meta.controls?.compaction, null);
  assert.deepEqual(meta.controls?.tasks, [
    { id: 'agent', kind: 'agent', title: 'Display agent', status: 'running' },
    { id: 'shell', kind: 'shell', title: 'echo safe', status: 'running' },
  ]);
  assert.deepEqual(meta.controls?.steering.map(item => item.text), ['waiting']);
  assert.deepEqual(meta.queue, [
    { id: 'batch', text: 'Message first\nMessage second', canSteer: false },
    { id: 'command', text: '/model', canSteer: false },
  ]);
  assert.equal(meta.activity?.queue.pendingCount, 2);
  const snapshot = await h.engine.snapshot();
  assert.equal(snapshot.sessions[0]?.controls, undefined);
  assert.ok(!JSON.stringify(snapshot).includes('Display agent'));
  assert.ok(!JSON.stringify(meta.controls).includes('private prompt'));
});

test('controls invalidation fences old reads and reconnect clears details', async t => {
  const h = await controlsFixture(t);
  const events: unknown[] = [];
  const off = h.engine.onEvent(event => events.push(event));
  t.after(off);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  h.rpc.tasks.list.mock.mockImplementationOnce(async () => {
    await hold;
    return { tasks: [runningAgent('stale')] };
  });
  const read = h.engine.getResources('native-id', ['controls', 'queue']);
  await nextTurn();
  h.config()!.onEvent!({ type: 'session.background_tasks_changed', id: 'change',
    timestamp: '2026-09-22T00:00:00Z', parentId: null, data: {} } as SessionEvent);
  release();
  const stale = await read;
  assert.equal(stale?.controls, null);
  assert.equal(stale?.queue, undefined);
  assert.ok(events.some(event => {
    const e = event as { type: string; resources?: string[] };
    return e.type === 'session/invalidated' && e.resources?.includes('controls');
  }));
  h.config()!.onEvent!({ type: 'session.connection_state_changed', id: 'disconnect',
    timestamp: '2026-09-22T00:00:00Z', parentId: null, data: { state: 'reconnecting' } } as SessionEvent);
  assert.ok(events.some(event => (event as { controls?: unknown }).controls === null));
});

test('controls reject inconsistent native steering subsets and missing canonical queue identities', async t => {
  const h = await controlsFixture(t);
  h.native.steering = ['only-one'];
  h.native.inFlight = 2;
  await assert.rejects(h.controls(), /incomplete or inconsistent/);
  h.native.inFlight = 0;
  h.native.queue = [queuedMessage('')];
  await assert.rejects(h.controls(), /incomplete or inconsistent/);
  await assert.rejects(h.engine.getResources('native-id', ['queue']), /identity.*incomplete/);
});

test('task controls require canonical session IDs and exact type/status', async t => {
  const h = await controlsFixture(t);
  h.native.tasks = [runningAgent('one'), { ...runningAgent('idle'), status: 'idle' }];
  for (const id of ['another-session-id', 'Display one', 'idle']) {
    const result = await h.engine.control('native-id', h.token, { type: 'stop-task', id });
    assert.equal(result.ok, false);
    assert.equal(result.outcomes[0]?.state, 'failed');
  }
  const mismatch = await h.engine.control('native-id', h.token, { type: 'clear-tasks', kind: 'shell', ids: ['one'] });
  assert.equal(mismatch.ok, false);
  assert.equal(h.rpc.tasks.cancel.mock.callCount(), 0);
  assert.equal(h.rpc.tasks.remove.mock.callCount(), 0);
});

test('clear-task groups keep partial results, only remove proven terminal records and exclude new tasks', async t => {
  const h = await controlsFixture(t);
  h.native.tasks = [runningAgent('first'), runningAgent('delayed'), runningAgent('throws'), runningAgent('not-selected')];
  h.rpc.tasks.cancel.mock.mockImplementation(async ({ id }) => {
    if (id === 'throws') throw new Error('native cancel failure');
    if (id === 'first') h.native.tasks.find(task => task.id === id)!.status = 'cancelled';
    return { cancelled: true };
  });
  const result = await h.engine.control('native-id', h.token,
    { type: 'clear-tasks', kind: 'agent', ids: ['first', 'delayed', 'throws'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.outcomes.map(item => [item.operation, item.targetId, item.state]), [
    ['tasks.cancel', 'first', 'accepted'], ['tasks.remove', 'first', 'accepted'],
    ['tasks.cancel', 'delayed', 'accepted'], ['tasks.remove', 'delayed', 'unchanged'],
    ['tasks.cancel', 'throws', 'unconfirmed'], ['tasks.remove', 'throws', 'unchanged'],
  ]);
  assert.deepEqual(result.outcomes[0]?.result, { cancelled: true });
  assert.match(result.outcomes[4]!.error!, /native cancel failure/);
  assert.deepEqual(h.rpc.tasks.remove.mock.calls.map(call => call.arguments[0]), [{ id: 'first' }]);
  assert.deepEqual((await h.controls()).tasks.map(task => task.id), ['delayed', 'throws', 'not-selected']);
});

test('false task cancellation remains failed when active, but terminal readback is unchanged', async t => {
  const h = await controlsFixture(t);
  h.native.tasks = [runningAgent('one')];
  h.rpc.tasks.cancel.mock.mockImplementation(async () => ({ cancelled: false }));
  const failed = await h.engine.control('native-id', h.token, { type: 'stop-task', id: 'one' });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.outcomes[0]?.result, { cancelled: false });
  h.rpc.tasks.cancel.mock.mockImplementation(async () => {
    h.native.tasks[0]!.status = 'completed';
    return { cancelled: false };
  });
  assert.equal((await h.engine.control('native-id', h.token, { type: 'stop-task', id: 'one' })).outcomes[0]?.state, 'unchanged');
});

test('clear tasks accepts the complete displayed group without an arbitrary ID count cap', async t => {
  const h = await controlsFixture(t);
  h.native.tasks = Array.from({ length: 129 }, (_, index) => runningAgent(`agent-${index}`));
  const ids = (await h.controls()).tasks.map(task => task.id);
  const result = await h.engine.control('native-id', h.token, { type: 'clear-tasks', kind: 'agent', ids });
  assert.equal(result.ok, true);
  assert.equal(h.rpc.tasks.cancel.mock.callCount(), ids.length);
  assert.equal(h.rpc.tasks.remove.mock.callCount(), ids.length);
  assert.deepEqual(h.native.tasks, []);
});

test('control writes serialize and retain lifecycle ownership through partial failure and late RPCs', async t => {
  const h = await controlsFixture(t);
  h.native.tasks = [runningAgent('fails'), runningAgent('held')];
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  h.rpc.tasks.cancel.mock.mockImplementation(async ({ id }) => {
    if (id === 'fails') throw new Error('first failed');
    await hold;
    h.native.tasks.find(task => task.id === id)!.status = 'cancelled';
    return { cancelled: true };
  });
  const clearing = h.engine.control('native-id', h.token, { type: 'clear-tasks', kind: 'agent', ids: ['fails', 'held'] });
  await nextTurn();
  const second = h.engine.control('native-id', h.token, { type: 'clear-queue' });
  await nextTurn();
  assert.equal(h.rpc.queue.clear.mock.callCount(), 0);
  assert.equal(await h.engine.busyCount(), 1);
  await assert.rejects(h.engine.unload('native-id'), /progress|protected/);
  await assert.rejects(h.engine.stop(), /progress|protected/);
  release();
  assert.equal((await clearing).ok, false);
  assert.equal((await second).ok, true);
});

test('native handle closure cannot release an outstanding control write lease', async t => {
  const h = await controlsFixture(t);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  h.rpc.queue.clear.mock.mockImplementationOnce(async () => { await hold; });
  const clearing = h.engine.control('native-id', h.token, { type: 'clear-queue' });
  await nextTurn();
  h.closeNative();
  assert.equal(await h.engine.busyCount(), 1);
  await assert.rejects(h.engine.reload('native-id'), /progress|protected/);
  release();
  const result = await clearing;
  assert.equal(result.ok, false);
  assert.equal(result.outcomes[0]?.state, 'unconfirmed');
  assert.match(result.outcomes[0]!.error!, /closed/);
  assert.equal(await h.engine.busyCount(), 0);
});

test('send-now uses only native eligible canonical items and never sends or manufactures history', async t => {
  const h = await controlsFixture(t);
  h.native.queue = [
    queuedMessage('q'),
    { id: 'command', kind: 'command', displayText: 'message-shaped command', agentMode: 'interactive' },
    queuedMessage('batch', 'first'), queuedMessage('batch', 'second'),
    { ...queuedMessage('shell'), agentMode: 'shell' },
  ];
  const send = t.mock.method(h.sdk, 'send', async () => { throw new Error('must not send'); });
  const projection = (await h.engine.getResources('native-id', ['queue']))!.queue!;
  assert.equal(projection.find(item => item.id === 'q')?.canSteer, true);
  assert.equal(projection.find(item => item.id === 'batch')?.canSteer, false);
  assert.equal(projection.find(item => item.id === 'shell')?.canSteer, false);
  for (const id of ['missing', 'command', 'Message q', 'batch', 'shell']) {
    assert.equal((await h.engine.control('native-id', h.token, { type: 'steer', id })).ok, false);
  }
  assert.equal(h.rpc.queue.sendNow.mock.callCount(), 0);
  const notLive = await h.engine.control('native-id', h.token, { type: 'steer', id: 'q' });
  assert.deepEqual(notLive.outcomes[0]?.result, { steered: false });
  assert.equal(notLive.outcomes[0]?.state, 'unchanged');
  assert.equal(h.native.queue.length, 5);
  h.native.busy = true;
  const live = await h.engine.control('native-id', h.token, { type: 'steer', id: 'q' });
  assert.equal(live.outcomes[0]?.state, 'accepted');
  assert.deepEqual(live.outcomes[0]?.result, { steered: true });
  assert.deepEqual((await h.controls()).steering.map(item => item.text), ['Message q']);
  assert.deepEqual(h.native.events, []);
  assert.equal(send.mock.callCount(), 0);
});

test('queue clear reconciles only snapshotted pending message receipts, not in-flight acceptance', async t => {
  const h = await controlsFixture(t);
  const accepted = h.retained().get('native-id')!.accepted as Set<string>;
  accepted.add('first'); accepted.add('second'); accepted.add('in-flight');
  h.native.queue = [queuedMessage('batch', 'first'), queuedMessage('batch', 'second')];
  assert.equal((await h.engine.control('native-id', h.token, { type: 'clear-queue' })).ok, true);
  assert.deepEqual([...accepted], ['in-flight']);
});

test('plan and elicitation cancellation resolve only the actual offered request', async t => {
  const h = await controlsFixture(t);
  const plan = Promise.resolve(h.config()!.onExitPlanModeRequest!({
    summary: 'plan', actions: ['interactive', 'exit_only'], recommendedAction: 'interactive',
  }, { sessionId: 'native-id' }));
  const requestId = (await h.engine.getMeta('native-id'))!.planRequest!.requestId;
  assert.equal((await h.engine.control('native-id', h.token,
    { type: 'cancel-decision', kind: 'ask', requestId })).ok, false);
  assert.equal((await h.engine.control('native-id', h.token,
    { type: 'cancel-decision', kind: 'plan', requestId: 'other' })).ok, false);
  assert.equal((await h.engine.control('native-id', h.token,
    { type: 'cancel-decision', kind: 'plan', requestId })).ok, true);
  assert.deepEqual(await plan, { approved: true, selectedAction: 'exit_only' });
  const elicitation = Promise.resolve(h.config()!.onElicitationRequest!({
    mode: 'form', message: 'Confirm?', requestedSchema: { type: 'object', properties: {} },
  }, { sessionId: 'native-id' }));
  const elicitationId = (await h.engine.getMeta('native-id'))!.elicitation!.requestId;
  await h.engine.control('native-id', h.token, { type: 'cancel-decision', kind: 'elicitation', requestId: elicitationId });
  assert.deepEqual(await elicitation, { action: 'cancel' });
  const unsupported = Promise.resolve(h.config()!.onExitPlanModeRequest!({
    summary: 'plan', actions: ['interactive'], recommendedAction: 'interactive',
  }, { sessionId: 'native-id' }));
  const unsupportedId = (await h.engine.getMeta('native-id'))!.planRequest!.requestId;
  const result = await h.engine.control('native-id', h.token,
    { type: 'cancel-decision', kind: 'plan', requestId: unsupportedId });
  assert.equal(result.ok, false);
  assert.match(result.outcomes[0]!.error!, /does not offer exit_only/);
  await h.engine.respondPlan('native-id', unsupportedId, 'interactive');
  await unsupported;
});

test('ask cancellation preserves queued work and cannot erase a newer decision on late completion', async t => {
  const h = await controlsFixture(t);
  h.native.busy = true;
  h.native.queue = [queuedMessage('queued')];
  h.native.tasks = [runningAgent('background')];
  const answer = Promise.resolve(h.config()!.onUserInputRequest!({ question: 'Old?', allowFreeform: true }, { sessionId: 'native-id' }));
  const rejected = assert.rejects(answer, /interrupted/);
  const requestId = (await h.engine.getMeta('native-id'))!.ask!.requestId;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  h.rpc.interruptMainTurn.mock.mockImplementationOnce(async () => { await hold; return { interrupted: true }; });
  const cancelling = h.engine.control('native-id', h.token, { type: 'cancel-decision', kind: 'ask', requestId });
  await nextTurn();
  h.config()!.onEvent!({ type: 'assistant.turn_start', id: 'new',
    timestamp: '2026-09-22T00:00:00Z', parentId: null, data: { turnId: 'new' } });
  const newAnswer = Promise.resolve(h.config()!.onUserInputRequest!({ question: 'New?', allowFreeform: true }, { sessionId: 'native-id' }));
  const newId = (await h.engine.getMeta('native-id'))!.ask?.requestId;
  release();
  await cancelling;
  await rejected;
  const current = (await h.engine.getMeta('native-id'))!.ask!;
  assert.notEqual(current.requestId, requestId);
  assert.ok(newId);
  assert.deepEqual(h.rpc.interruptMainTurn.mock.calls[0]!.arguments, [{ flushQueued: true }]);
  assert.equal(h.native.queue.length, 1);
  assert.equal(h.native.tasks[0]!.status, 'running');
  await h.engine.respondAsk('native-id', current.requestId, 'yes', true);
  await newAnswer;
});

test('steering delivery acknowledges its receipt without changing main-turn decision ownership', async t => {
  const h = await controlsFixture(t);
  h.native.busy = true;
  h.config()!.onEvent!({
    type: 'assistant.turn_start', id: 'main-start', timestamp: '2026-09-22T00:00:00Z', parentId: null,
    data: { turnId: 'main', interactionId: 'main-interaction' },
  } as SessionEvent);
  const state = h.retained().get('native-id')!;
  const epoch = state.turnEpoch;
  const accepted = state.accepted as Set<string>;
  accepted.add('steering-receipt');
  const answer = Promise.resolve(h.config()!.onUserInputRequest!({ question: 'Continue?', allowFreeform: true }, { sessionId: 'native-id' }));
  const rejected = assert.rejects(answer, /interrupted/);
  const requestId = (await h.engine.getMeta('native-id'))!.ask!.requestId;
  h.config()!.onEvent!({
    type: 'user.message', id: 'steering-event', timestamp: '2026-09-22T00:00:00Z', parentId: null,
    data: { content: 'Additional context', messageId: 'steering-receipt', delivery: 'steering', interactionId: 'steering-interaction' },
  } as SessionEvent);
  assert.equal(accepted.has('steering-receipt'), false);
  assert.equal(state.turnEpoch, epoch);
  assert.equal(state.interactionId, 'main-interaction');
  const result = await h.engine.control('native-id', h.token, { type: 'cancel-decision', kind: 'ask', requestId });
  assert.equal(result.ok, true);
  await rejected;
  assert.equal(state.interruptedEpoch, epoch);
});

test('global Stop can cancel an outstanding manual compaction and reports each partial result', async t => {
  const h = await controlsFixture(t);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  h.rpc.history.compact.mock.mockImplementationOnce(async () => {
    await hold;
    return { success: true, tokensRemoved: 0, messagesRemoved: 0 };
  });
  const compacting = h.engine.compact('native-id');
  await nextTurn();
  assert.equal((await h.controls()).compaction, 'manual');
  h.native.tasks = [runningAgent('background')];
  h.rpc.queue.clear.mock.mockImplementationOnce(async () => { throw new Error('clear failed'); });
  h.rpc.history.abortManualCompaction.mock.mockImplementationOnce(async () => {
    release();
    return { aborted: true };
  });
  h.rpc.history.cancelBackgroundCompaction.mock.mockImplementationOnce(async () => ({ cancelled: true }));
  const result = await h.engine.control('native-id', h.token, { type: 'stop-all' });
  await compacting;
  assert.equal(result.ok, false);
  assert.match(result.outcomes.find(item => item.operation === 'queue.clear')!.error!, /clear failed/);
  assert.equal(result.outcomes.find(item => item.operation === 'tasks.cancel')?.state, 'accepted');
  assert.deepEqual(result.outcomes.find(item => item.operation === 'history.abortManualCompaction')?.result, { aborted: true });
  assert.deepEqual(result.outcomes.find(item => item.operation === 'history.cancelBackgroundCompaction')?.result, { cancelled: true });
  assert.equal((await h.controls()).compaction, null);
});

test('native compaction activity is unknown-kind rather than inferred from a running turn', async t => {
  const h = await controlsFixture(t);
  h.native.busy = true;
  assert.equal((await h.controls()).compaction, null);
  for (const type of ['session.compaction_start', 'session.compaction_complete'] as const) {
    h.config()!.onEvent!({ type, id: type, timestamp: '2026-09-22T00:00:00Z', parentId: null, data: {} } as SessionEvent);
    assert.equal((await h.controls()).compaction, type === 'session.compaction_start' ? 'unknown' : null);
  }
});

test('global Stop preserves an explicit native abort failure instead of treating the void SDK wrapper as success', async t => {
  const h = await controlsFixture(t);
  h.native.busy = true;
  const request = h.config()!.onUserInputRequest!({ question: 'Keep pending?', choices: ['Yes'] }, { sessionId: 'native-id' });
  const rejected = Promise.resolve(request).catch(() => {});
  const askId = (await h.engine.getMeta('native-id'))!.ask!.requestId;
  h.rpc.abort.mock.mockImplementationOnce(async () => ({ success: false, error: 'Native abort refused' }));
  const result = await h.engine.control('native-id', h.token, { type: 'stop-all' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.outcomes.find(value => value.operation === 'session.abort')?.result,
    { success: false, error: 'Native abort refused' });
  assert.equal(result.outcomes.find(value => value.operation === 'session.abort')?.state, 'failed');
  assert.equal((await h.engine.getMeta('native-id'))?.ask?.requestId, askId);
  await h.engine.cancel('native-id');
  await rejected;
});

test('task cancellation and group cleanup accept records that native already removed', async t => {
  const h = await controlsFixture(t);
  h.native.tasks = [runningAgent('finishing')];
  h.rpc.tasks.cancel.mock.mockImplementationOnce(async () => { h.native.tasks = []; return { cancelled: false }; });
  assert.equal((await h.engine.control('native-id', h.token, { type: 'stop-task', id: 'finishing' })).outcomes[0]?.state, 'unchanged');
  h.native.tasks = [runningAgent('self-removed')];
  h.rpc.tasks.cancel.mock.mockImplementationOnce(async () => { h.native.tasks = []; return { cancelled: true }; });
  const group = await h.engine.control('native-id', h.token, { type: 'clear-tasks', kind: 'agent', ids: ['self-removed'] });
  assert.equal(group.ok, true);
  assert.equal(group.outcomes[1]?.state, 'unchanged');
  assert.equal(h.rpc.tasks.remove.mock.callCount(), 0);
  h.native.tasks = [runningAgent('removed-by-abort')];
  h.rpc.abort.mock.mockImplementationOnce(async () => { h.native.tasks = []; return { success: true }; });
  assert.equal((await h.engine.control('native-id', h.token, { type: 'stop-all' })).ok, true);
});

test('subagent compaction events do not overwrite the parent compaction state', async t => {
  const h = await controlsFixture(t);
  const emit = (type: 'session.compaction_start' | 'session.compaction_complete', agentId?: string) =>
    h.config()!.onEvent!({ type, id: `${type}-${agentId ?? 'root'}`, timestamp: '2026-09-22T00:00:00Z', parentId: null,
      ...(agentId ? { agentId } : {}), data: {} } as SessionEvent);
  emit('session.compaction_start', 'child');
  assert.equal((await h.controls()).compaction, null);
  emit('session.compaction_start');
  emit('session.compaction_complete', 'child');
  assert.equal((await h.controls()).compaction, 'unknown');
  emit('session.compaction_complete');
  assert.equal((await h.controls()).compaction, null);
});

for (const action of ['clear-queue', 'stop-all'] as const) {
  for (const delivery of ['enqueue', 'immediate'] as const) {
    test(`${action} reconciles discarded ${delivery} steering receipts without a phantom busy session`, async t => {
      const h = await controlsFixture(t);
      h.native.busy = true;
      t.mock.method(h.sdk, 'send', async () => {
        if (delivery === 'enqueue') h.native.queue.push(queuedMessage('pending', 'receipt'));
        else h.native.steering.push('Pending steering');
        return 'receipt';
      });
      await h.engine.prompt('native-id', 'Pending steering', delivery);
      if (delivery === 'enqueue') await h.engine.control('native-id', h.token, { type: 'steer', id: 'pending' });
      assert.equal((h.retained().get('native-id')!.accepted as Set<string>).has('receipt'), true);
      h.rpc.queue.clear.mock.mockImplementationOnce(async () => { h.native.queue = []; h.native.steering = []; });
      const result = await h.engine.control('native-id', h.token, { type: action });
      assert.equal(result.ok, true);
      h.native.busy = false;
      assert.equal((h.retained().get('native-id')!.accepted as Set<string>).size, 0);
      assert.equal(await h.engine.busyCount(), 0);
      await h.engine.unload('native-id');
    });
  }
}

test('queue clearing cannot discard a prompt accepted after that control operation', async t => {
  const h = await controlsFixture(t);
  h.native.busy = true;
  const send = t.mock.method(h.sdk, 'send', async ({ prompt }) => {
    const id = prompt === 'first' ? 'first' : 'newer';
    h.native.queue.push(queuedMessage(id, id));
    return id;
  });
  await h.engine.prompt('native-id', 'first');
  await h.engine.control('native-id', h.token, { type: 'steer', id: 'first' });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  h.rpc.queue.clear.mock.mockImplementationOnce(async () => {
    await held; h.native.queue = []; h.native.steering = [];
  });
  const clearing = h.engine.control('native-id', h.token, { type: 'clear-queue' });
  await nextTurn();
  const newer = h.engine.prompt('native-id', 'newer');
  await nextTurn();
  assert.equal(send.mock.callCount(), 1, 'new acceptance waits behind the clear, not the model turn');
  release();
  await clearing;
  await newer;
  assert.deepEqual([...(h.retained().get('native-id')!.accepted as Set<string>)], ['newer']);
  assert.deepEqual(h.native.queue.map(item => item.messageId), ['newer']);
});

test('Stop binds the main turn at admission, before its asynchronous task snapshot', async t => {
  const h = await controlsFixture(t);
  h.native.busy = true;
  const start = (name: string) => {
    h.config()!.onEvent!({ type: 'user.message', id: `user-${name}`, timestamp: '2026-09-22T00:00:00Z',
      parentId: null, data: { content: name, interactionId: name } } as SessionEvent);
    h.config()!.onEvent!({ type: 'assistant.turn_start', id: `turn-${name}`, timestamp: '2026-09-22T00:00:00Z',
      parentId: null, data: { turnId: name, interactionId: name } } as SessionEvent);
  };
  start('original');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  h.rpc.tasks.list.mock.mockImplementationOnce(async () => { await held; return { tasks: [] }; });
  const stopping = h.engine.control('native-id', h.token, { type: 'stop-all' });
  await nextTurn();
  start('newer');
  const answer = Promise.resolve(h.config()!.onUserInputRequest!({ question: 'New decision', choices: ['Yes'] }, { sessionId: 'native-id' })).catch(() => {});
  const requestId = (await h.engine.getMeta('native-id'))!.ask!.requestId;
  release();
  const result = await stopping;
  assert.equal(result.ok, false);
  assert.match(result.outcomes[0]?.error ?? '', /Main turn changed/);
  assert.equal(h.rpc.abort.mock.callCount(), 0);
  assert.equal(h.rpc.queue.clear.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta('native-id'))?.ask?.requestId, requestId);
  await h.engine.cancel('native-id');
  await answer;
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-native-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const native = {
    title: 'first name', cwd: root, model: 'first-model', mode: 'interactive' as 'interactive' | 'plan',
    busy: false, pendingMcp: [] as string[],
    queue: [] as Awaited<ReturnType<Rpc['queue']['pendingItems']>>['items'],
    tasks: [] as Awaited<ReturnType<Rpc['tasks']['list']>>['tasks'],
    steering: [] as string[], inFlight: 0,
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
  let onClosed: ((session: CopilotSession) => void) | undefined;
  const rpc = {
    abort: t.mock.fn(async (): Promise<Awaited<ReturnType<Rpc['abort']>>> => { native.busy = false; return { success: true }; }),
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
    tasks: {
      list: t.mock.fn(async () => ({ tasks: structuredClone(native.tasks) })),
      cancel: t.mock.fn(async ({ id }: { id: string }) => {
        const task = native.tasks.find(task => task.id === id);
        if (task?.status !== 'running') return { cancelled: false };
        task.status = 'cancelled';
        return { cancelled: true };
      }),
      remove: t.mock.fn(async ({ id }: { id: string }) => {
        const index = native.tasks.findIndex(task => task.id === id);
        if (index < 0 || !['cancelled', 'completed', 'failed'].includes(native.tasks[index]!.status)) return { removed: false };
        native.tasks.splice(index, 1);
        return { removed: true };
      }),
    },
    queue: {
      pendingItems: t.mock.fn(async () => ({
        items: structuredClone(native.queue), steeringMessages: [...native.steering], inFlightSteeringCount: native.inFlight,
      })),
      clear: t.mock.fn(async () => { native.queue = []; }),
      removeAt: t.mock.fn(async ({ id }: { id: string }) => {
        const removed = native.queue.some(item => item.id === id);
        native.queue = native.queue.filter(item => item.id !== id);
        return { removed };
      }),
      sendNow: t.mock.fn(async ({ id }: { id: string }) => {
        if (!native.busy) return { steered: false };
        const rows = native.queue.filter(item => item.id === id);
        native.queue = native.queue.filter(item => item.id !== id);
        native.steering.push(...rows.map(item => item.displayText));
        return { steered: true };
      }),
    },
    history: {
      abortManualCompaction: t.mock.fn(async () => ({ aborted: false })),
      cancelBackgroundCompaction: t.mock.fn(async () => ({ cancelled: false })),
      compact: t.mock.fn(async () => ({ success: true, tokensRemoved: 0, messagesRemoved: 0 })),
    },
    interruptMainTurn: t.mock.fn(async () => {
      const interrupted = native.busy;
      native.busy = false;
      return { interrupted };
    }),
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
  const sdk = {
    sessionId: 'native-id', rpc,
    abort: t.mock.fn(async () => { native.busy = false; }),
    send: t.mock.fn(async () => 'accepted'),
  } as unknown as CopilotSession;
  const runtime = {
    start: async () => {},
    stop: async () => { assert.equal(native.live, false); },
    models: t.mock.fn(async () => native.models.map(model => ({ modelId: model.id, name: model.name }))),
    getAuthStatus: t.mock.fn(async () => ({ isAuthenticated: false })),
    listSessions: t.mock.fn(async () => native.listed ? [row()] : []),
    getSessionMetadata: t.mock.fn(async () => native.listed ? row() : undefined),
    isSessionLive: t.mock.fn(async () => native.live),
    onSessionClosed: (listener: (session: CopilotSession) => void) => {
      onClosed = listener;
      return () => { onClosed = undefined; };
    },
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
  return { engine, native, rpc, sdk, runtime, retained, config: () => config,
    closeNative: () => { native.live = false; onClosed?.(sdk); } };
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
  await h.engine.deleteSession('native-id');
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

test('metadata reserves its read lease before its asynchronous liveness probe', async t => {
  const h = fixture(t);
  await h.engine.start();
  await h.engine.reload('native-id');
  let probe!: (live: boolean) => void;
  const heldProbe = new Promise<boolean>(resolve => { probe = resolve; });
  t.mock.method(h.runtime, 'isSessionLive', async () => h.native.live)
    .mock.mockImplementationOnce(() => heldProbe);
  const reading = h.engine.getMeta('native-id');
  const unloading = assert.rejects(h.engine.unload('native-id'), /operation.*progress/i);
  await nextTurn();
  const reads = h.rpc.metadata.snapshot.mock.callCount();
  probe(true);
  assert.equal((await reading)!.loaded, true);
  assert.equal(h.rpc.metadata.snapshot.mock.callCount(), reads + 1);
  await unloading;
  await h.engine.unload('native-id');
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
