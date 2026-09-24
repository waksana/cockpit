import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { SessionEvent, SessionMetadata } from '@github/copilot-sdk';
import { type EngineRuntime } from './engine.ts';
import {
  activeState,
  deferred,
  event,
  fakeSession,
  harness,
  nativeCalls,
} from '../test-support/engine-harness.ts';

test('readonly native observer sees live deltas without web/history reads and isolates failures', async t => {
  const h = harness(t);
  const session = await h.load();
  const observations: import('./engine.ts').NativeObservation[] = [];
  const logs: string[] = [];
  h.engine.log = message => { logs.push(message); };
  const beforeEvents = h.events.length;
  const off = h.engine.onNativeEvent(value => { observations.push(value); });
  h.engine.onNativeEvent(() => { throw new Error('synthetic observer failure'); });
  h.engine.onNativeEvent(async () => { throw new Error('synthetic asynchronous observer failure'); });
  h.engine.onNativeEvent(() => new Promise(() => {}));
  const reads = session.rpc.eventLog.read.mock.callCount();
  const passive = h.runtime.rpc.sessions.readPersistedEvents.mock.callCount();
  session.emit(event('assistant.message_start', { messageId: 'observed-message' }));
  session.emit(event('assistant.message_delta', { messageId: 'observed-message', deltaContent: 'synthetic delta' }));
  await nextTurn();
  assert.deepEqual(observations.map(value => value.event.type), ['assistant.message_start', 'assistant.message_delta']);
  assert.ok(observations.every(value => value.sessionId === session.id && value.cwd === h.cwd));
  assert.ok(Object.isFrozen(observations[0]));
  assert.ok(Object.isFrozen(observations[0]!.event.data));
  assert.equal(h.events.length, beforeEvents, 'Deltas and observer failures cannot patch native control metadata');
  assert.equal(logs.length, 4);
  assert.equal(session.rpc.eventLog.read.mock.callCount(), reads);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), passive);
  assert.equal(await h.engine.busyCount(), 0, 'Unsettled observers must never retain native work');
  off();
  session.emit(event('assistant.message_delta', { messageId: 'observed-message', deltaContent: 'later' }));
  assert.equal(observations.length, 2);
});

test('readonly native observer filters before payload traversal and shares one immutable clone', async t => {
  const h = harness(t);
  const session = await h.load();
  const workspacePath = '/synthetic-native-workspaces/filtered';
  let workspaceReads = 0;
  Object.defineProperty(session.sdk, 'workspacePath', {
    get() { workspaceReads++; return workspacePath; },
  });
  const first: import('./engine.ts').NativeObservation[] = [];
  const second: import('./engine.ts').NativeObservation[] = [];
  const types = ['assistant.message_delta'];
  const offFirst = h.engine.onNativeEvent(value => { first.push(value); }, { types });
  const offSecond = h.engine.onNativeEvent(value => { second.push(value); }, { types });
  h.engine.onNativeEvent(() => assert.fail('Empty event filter must never receive an event'), { types: [] });
  types.push('tool.execution_complete');
  let payloadReads = 0;
  const payload = Object.defineProperty({}, 'largeResult', {
    enumerable: true, get() { payloadReads++; return { text: 'synthetic payload' }; },
  });
  const unused = event('tool.execution_complete', {
    toolCallId: 'synthetic-tool', success: true, result: { content: 'unused tool result' },
  });
  Object.assign(unused.data.result!, { payload });
  // Invoke the captured SDK callback directly: the fixture's journal helper
  // intentionally clones events itself and would traverse this getter first.
  const notify = h.configs.get(session.id)!.onEvent!;
  notify(unused);
  assert.equal(payloadReads, 0, 'Uninterested observers must not traverse unused tool results');
  assert.equal(workspaceReads, 0, 'Uninterested observers must not read workspace metadata');
  assert.equal(first.length, 0);
  assert.equal(second.length, 0);
  const cwd = join(h.cwd, 'filtered-native-context');
  notify(event('session.context_changed', { cwd }));
  assert.equal(first.length, 0, 'Filtered context events still update cwd without delivery');
  assert.equal(workspaceReads, 0);
  const delta = event('assistant.message_delta', { messageId: 'filtered-message', deltaContent: 'synthetic delta' });
  Object.assign(delta.data, { payload });
  notify(delta);
  assert.equal(payloadReads, 1, 'Only one payload clone is built for multiple interested observers');
  assert.equal(workspaceReads, 1, 'Only one workspace read is needed for multiple interested observers');
  assert.equal(first[0], second[0]);
  assert.equal(first[0]?.cwd, cwd);
  assert.equal(first[0]?.workspacePath, workspacePath);
  assert.ok(Object.isFrozen(first[0]));
  assert.ok(Object.isFrozen(first[0]!.event.data.payload));
  offFirst();
  offSecond();
  notify(delta);
  assert.equal(payloadReads, 1, 'An empty filter alone does not justify cloning');
  assert.equal(workspaceReads, 1);
  assert.equal(session.rpc.eventLog.read.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
});

test('readonly native observer redacts internal binary, preserves native payload and rejects stale owners', async t => {
  const h = harness(t);
  const session = await h.load();
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const native = {
    ...event('tool.execution_complete', { toolCallId: 'tool-id', success: true }),
    data: {
      toolCallId: 'tool-id', success: true,
      result: { content: 'text retained', binaryResultsForLlm: [{ data: 'do-not-observe-image-bytes' }], buffer: Buffer.from('binary') },
    },
  } as unknown as SessionEvent;
  session.emit(native);
  const result = observations[0]!.event.data.result as Record<string, unknown>;
  assert.equal(result.content, 'text retained');
  assert.equal(Object.hasOwn(result, 'binaryResultsForLlm'), false);
  assert.equal(result.buffer, undefined);
  assert.ok((native.data as { result: Record<string, unknown> }).result.binaryResultsForLlm, 'Native event must not be mutated');
  const previous = h.configs.get(session.id)!.onEvent!;
  await h.engine.unload(session.id);
  const before = observations.length;
  previous(event('assistant.message_delta', { messageId: 'old-owner', deltaContent: 'stale' }));
  assert.equal(observations.length, before);
  assert.equal(await h.engine.busyCount(), 0);
});

test('readonly native observer derives cwd from native create/resume metadata, never HOME', async t => {
  const h = harness(t);
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const id = await h.engine.newSession(h.cwd);
  h.natives.get(id)!.emit(event('assistant.message_delta', { messageId: 'created', deltaContent: 'created' }));
  assert.equal(observations.at(-1)?.cwd, h.cwd);
  const seeded = await h.seed();
  seeded.state.cwd = '';
  h.rows.find(row => row.sessionId === seeded.id)!.context = undefined;
  await h.engine.load(seeded.id);
  seeded.emit(event('assistant.message_delta', { messageId: 'resumed', deltaContent: 'no known directory' }));
  assert.equal(observations.at(-1)?.cwd, null);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

test('readonly native observer reads current SDK workspace independently of HOME, cwd and metadata', async t => {
  const h = harness(t);
  const session = await h.load();
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const calls = nativeCalls(session);
  for (const workspacePath of ['/synthetic-native-workspaces/custom-root', '/different-sdk-root/session', undefined]) {
    session.sdk.workspacePath = workspacePath;
    session.emit(event('assistant.message_delta', { messageId: 'workspace', deltaContent: 'current context' }));
    const observation = observations.at(-1)!;
    assert.equal(observation.cwd, h.cwd);
    assert.equal(observation.workspacePath, workspacePath ?? null);
    assert.equal(Object.hasOwn(observation, 'workspacePath'), true);
    assert.ok(Object.isFrozen(observation));
  }
  assert.equal(observations[0]!.workspacePath, '/synthetic-native-workspaces/custom-root', 'Earlier snapshots cannot change');
  assert.deepEqual(nativeCalls(session), calls, 'Workspace context reads only the public SDK property, not an RPC');
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
});

test('readonly native observer reports invalid or throwing SDK workspace as unknown without affecting native control', async t => {
  const h = harness(t);
  const session = await h.load();
  const observations: import('./engine.ts').NativeObservation[] = [];
  const reports: Array<{ message: string; data?: Record<string, unknown> }> = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  h.engine.log = (message, data) => { reports.push({ message, data }); };
  const calls = nativeCalls(session);
  const invalid = ['', 'relative/path', '/invalid\0path', 123, {}];
  for (const workspacePath of invalid) {
    Object.defineProperty(session.sdk, 'workspacePath', { configurable: true, value: workspacePath });
    session.emit(event('assistant.message_delta', { messageId: 'invalid-workspace', deltaContent: 'still observed' }));
    const observation = observations.at(-1)!;
    assert.equal(observation.cwd, h.cwd);
    assert.equal(observation.workspacePath, undefined);
    assert.equal(Object.hasOwn(observation, 'workspacePath'), false);
  }
  assert.deepEqual(reports, invalid.map(() => ({
    message: 'native observer failed', data: { sessionId: session.id, error: 'Invalid native workspace path' },
  })));
  Object.defineProperty(session.sdk, 'workspacePath', {
    get() { throw new Error('Synthetic workspace getter failure'); },
  });
  h.engine.log = (message, data) => {
    (reports as Array<{ message: string; data?: Record<string, unknown> }>).push({ message, ...(data === undefined ? {} : { data }) });
    throw new Error('Synthetic observer reporter failure');
  };
  const epoch = activeState(h, session.id).turnEpoch as number;
  assert.doesNotThrow(() => session.emit(event('assistant.turn_start', { turnId: 'workspace-failure' })));
  assert.equal(activeState(h, session.id).turnEpoch, epoch + 1, 'Observer metadata failure cannot prevent native control delivery');
  assert.equal(observations.length, invalid.length + 1);
  assert.equal(Object.hasOwn(observations.at(-1)!, 'workspacePath'), false);
  assert.deepEqual(reports.at(-1), {
    message: 'native observer failed', data: { sessionId: session.id, error: 'Synthetic workspace getter failure' },
  });
  assert.deepEqual(nativeCalls(session), calls);
});

test('readonly native observer uses the new resumed SDK workspace and never a stale handle', async t => {
  const h = harness(t);
  const session = await h.load();
  session.sdk.workspacePath = '/synthetic-native-workspaces/old-handle';
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const delta = () => event('assistant.message_delta', { messageId: 'workspace-owner', deltaContent: 'context' });
  session.emit(delta());
  const previous = h.configs.get(session.id)!.onEvent!;
  const resumed = fakeSession(t, session.id);
  resumed.state.cwd = h.cwd;
  resumed.sdk.workspacePath = '/different-sdk-root/resumed-handle';
  const resume = h.runtime.resumeSession;
  t.mock.method(h.runtime, 'resumeSession', async (id: Parameters<EngineRuntime['resumeSession']>[0], config: Parameters<EngineRuntime['resumeSession']>[1]) => {
    h.natives.set(id, resumed);
    h.journals.set(id, resumed.state.events);
    previous(delta());
    config.onEvent!(delta());
    return resume(id, config);
  });
  await h.engine.reload(session.id);
  assert.equal(observations.length, 2, 'An old callback cannot observe during a new allocation');
  assert.equal(observations[0]!.workspacePath, '/synthetic-native-workspaces/old-handle');
  assert.equal(Object.hasOwn(observations[1]!, 'workspacePath'), false, 'Early resume must not borrow the prior workspace');
  previous(delta());
  assert.equal(observations.length, 2, 'An old callback cannot observe a newly bound handle');
  resumed.emit(delta());
  assert.equal(observations.at(-1)?.workspacePath, resumed.sdk.workspacePath);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
});

test('readonly native observer updates cwd before root context delivery without child contamination or RPC', async t => {
  const h = harness(t);
  const session = await h.load();
  session.sdk.workspacePath = '/synthetic-native-workspaces/context-independent';
  const firstCwd = join(h.cwd, 'first-native-context');
  session.emit(event('session.context_changed', { cwd: firstCwd }));
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const metadataReads = session.rpc.metadata.snapshot.mock.callCount();
  const persistedReads = h.runtime.rpc.sessions.readPersistedEvents.mock.callCount();
  const liveReads = session.rpc.eventLog.read.mock.callCount();
  session.emit(event('assistant.message_delta', { messageId: 'context', deltaContent: 'after unobserved change' }));
  assert.equal(observations.at(-1)?.cwd, firstCwd);
  const nextCwd = join(h.cwd, 'next-native-context');
  session.emit(event('session.context_changed', { cwd: nextCwd }));
  assert.equal(observations.at(-1)?.event.type, 'session.context_changed');
  assert.equal(observations.at(-1)?.cwd, nextCwd, 'The context-change observation itself must see the new native cwd');
  for (const childFields of [
    { agentId: 'child' }, { parentToolCallId: 'parent-tool' },
  ]) {
    session.emit({ ...event('session.context_changed', { cwd: join(h.cwd, 'child') }), ...childFields } as SessionEvent);
    session.emit(event('session.context_changed', { cwd: join(h.cwd, 'child'), ...childFields }));
    assert.equal(observations.at(-1)?.cwd, nextCwd);
  }
  const reports: string[] = [];
  h.engine.log = message => { reports.push(message); };
  for (const cwd of ['', 'relative/path', '/invalid\0path', 123]) {
    session.emit(event('session.context_changed', { cwd } as { cwd: string }));
    assert.equal(observations.at(-1)?.cwd, nextCwd);
  }
  assert.equal(reports.length, 4);
  session.emit(event('assistant.message_delta', { messageId: 'context', deltaContent: 'after root change' }));
  assert.equal(observations.at(-1)?.cwd, nextCwd);
  assert.ok(observations.every(value => value.workspacePath === session.sdk.workspacePath), 'Root and child cwd changes cannot alter the SDK workspace');
  assert.equal(session.rpc.metadata.snapshot.mock.callCount(), metadataReads);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), persistedReads);
  assert.equal(session.rpc.eventLog.read.mock.callCount(), liveReads);
});

test('readonly native observer retains a context change that races loading metadata', async t => {
  const h = harness(t);
  const session = await h.seed();
  const stale = await session.rpc.metadata.snapshot();
  const pendingMetadata = deferred<typeof stale>();
  t.mock.method(session.rpc.metadata, 'snapshot', () => pendingMetadata.promise);
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const loading = h.engine.load(session.id);
  await nextTurn();
  const currentCwd = join(h.cwd, 'current-native-context');
  session.emit(event('session.context_changed', { cwd: currentCwd }));
  pendingMetadata.resolve(stale);
  await loading;
  session.emit(event('assistant.message_delta', { messageId: 'context', deltaContent: 'after loading metadata' }));
  assert.equal(observations.at(-1)?.cwd, currentCwd);
});

test('readonly native observer retains a newer cwd when concurrent initial metadata arrives late', async t => {
  const h = harness(t);
  const session = await h.seed();
  const stale = structuredClone(h.rows.find(row => row.sessionId === session.id)!);
  const pendingMetadata = deferred<SessionMetadata | undefined>();
  h.runtime.getSessionMetadata.mock.mockImplementationOnce(() => pendingMetadata.promise);
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const pendingLoad = h.engine.load(session.id);
  await nextTurn();
  await h.engine.load(session.id);
  const currentCwd = join(h.cwd, 'newer-native-context');
  session.emit(event('session.context_changed', { cwd: currentCwd }));
  assert.equal(observations.at(-1)?.cwd, currentCwd);
  pendingMetadata.resolve(stale);
  await pendingLoad;
  session.emit(event('assistant.message_delta', { messageId: 'context', deltaContent: 'after concurrent initial metadata' }));
  assert.equal(observations.at(-1)?.cwd, currentCwd);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(session.sdk.send.mock.callCount(), 0);
});
