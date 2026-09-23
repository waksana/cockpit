import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { CopilotSession, SessionConfig } from '@github/copilot-sdk';
import { errorWithCode } from '../test-support/errors.ts';
import {
  type Rpc,
  activeState,
  assertSameControlFacts,
  assistant,
  chat,
  deferred,
  event,
  harness,
  protectedWork,
  queued,
  serverChatEvents,
  user,
  visibleError,
} from '../test-support/engine-harness.ts';

test('send acceptance does not invent a message, complete a turn, or permit teardown', async t => {
  const h = harness(t);
  const s = await h.load();
  const acceptance = deferred<string>();
  s.sdk.send.mock.mockImplementation(() => acceptance.promise);
  h.events.length = 0;
  const result = h.engine.prompt(s.id, 'queued instruction');
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  assert.equal(serverChatEvents(h).length, 0);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  acceptance.resolve('native-accepted-id');
  assert.deepEqual(await result, { ok: true });
  await nextTurn();
  assert.deepEqual(s.sdk.send.mock.calls[0]!.arguments, [{ prompt: 'queued instruction', mode: 'enqueue', attachments: undefined }]);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  assert.ok(!h.events.some(event => String(event.type) === 'session/notify'));
  for (const operation of [() => h.engine.unload(s.id), () => h.engine.stop()]) {
    await assert.rejects(operation(), protectedWork);
  }
  s.state.processing = true;
  s.emit(event('user.message', { content: 'queued instruction', messageId: 'native-accepted-id' }, 'native-user-event'));
  assert.equal(serverChatEvents(h).length, 0);
  assert.deepEqual((await chat(h, s.id, { source: 'live' })).events.map(event => event.id), ['native-user-event']);
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running', 'idle event cannot override native processing');
  s.state.processing = false;
  s.emit(assistant('answer-event', 'answer-message'));
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal((await chat(h, s.id, { source: 'live' })).events.find(event => event.id === 'answer-event')?.data.messageId, 'answer-message');
  await h.engine.unload(s.id);
  assert.equal(h.runtime.closeSession.mock.callCount(), 1);
});

for (const separateEventId of [false, true]) {
  test(`a user event before send resolves consumes its native acceptance (${separateEventId ? 'separate event and message IDs' : 'matching event ID'})`, async t => {
    const h = harness(t);
    const s = await h.load();
    const eventId = separateEventId ? 'different-event-id' : 'accepted-before-return';
    s.sdk.send.mock.mockImplementation(async () => {
      s.emit(event('user.message', { content: 'native user message', messageId: 'accepted-before-return' }, eventId));
      return 'accepted-before-return';
    });
    await h.engine.prompt(s.id, 'native synchronous acceptance');
    s.emit(event('session.idle', {}));
    await nextTurn();
    assert.equal(serverChatEvents(h).length, 0);
    assert.equal((await chat(h, s.id, { source: 'live' })).events.filter(event => event.id === eventId).length, 1);
    assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
    await h.engine.unload(s.id);
  });
}

test('send rejection surfaces native failure without an optimistic user message', async t => {
  const h = harness(t);
  const s = await h.load();
  s.sdk.send.mock.mockImplementation(async () => { throw new Error('native send rejected'); });
  await assert.rejects(h.engine.prompt(s.id, 'not accepted'), /native send rejected/);
  await nextTurn();
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  visibleError(h, s.id, /native send rejected/);
});

test('attachment-only sends preserve file descriptors without reading the attachment', async t => {
  const h = harness(t);
  const s = await h.load();
  const path = join(h.cwd, 'not-created.pdf');
  await h.engine.prompt(s.id, '', 'immediate', [{ type: 'file', path, displayName: 'spec.pdf' }]);
  assert.deepEqual(s.sdk.send.mock.calls[0]!.arguments, [{
    prompt: '', mode: 'immediate', attachments: [{ type: 'file', path, displayName: 'spec.pdf' }],
  }]);
  assert.equal(serverChatEvents(h).length, 0);
  await h.engine.cancel(s.id);
  await assert.rejects(h.engine.prompt(s.id, '  '), errorWithCode('INVALID_REQUEST'));
  assert.equal(s.sdk.send.mock.callCount(), 1);
});

test('native queue IDs survive duplicate text and reordering; removal targets an ID, not an index', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.queue.items = [queued('queue-a', 'duplicate'), queued('queue-b', 'duplicate')];
  s.emit(event('pending_messages.modified', {}));
  await nextTurn();
  assert.deepEqual((await h.engine.getMeta(s.id))?.queue, [{ id: 'queue-a', text: 'duplicate', canSteer: true }, { id: 'queue-b', text: 'duplicate', canSteer: true }]);
  s.state.queue.items.reverse();
  s.emit(event('pending_messages.modified', {}));
  await nextTurn();
  assert.deepEqual((await h.engine.getMeta(s.id))?.queue?.map(item => item.id), ['queue-b', 'queue-a']);
  await h.engine.removeQueued(s.id, 'queue-a');
  assert.deepEqual(s.rpc.queue.removeAt.mock.calls[0]!.arguments, [{ id: 'queue-a' }]);
  assert.deepEqual((await h.engine.getMeta(s.id))?.queue, [{ id: 'queue-b', text: 'duplicate', canSteer: true }]);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

for (const failure of ['not-removed', 'rpc-rejected'] as const) {
  test(`queue removal ${failure} retains the visible native queue and reports failure`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.queue.items = [queued('stable-id', 'keep me')];
    s.emit(event('pending_messages.modified', {}));
    await nextTurn();
    const before = (await h.engine.getMeta(s.id))!.queue;
    s.rpc.queue.removeAt.mock.mockImplementation(async () => {
      if (failure === 'rpc-rejected') throw new Error('queue removal rejected');
      return { removed: false };
    });
    await assert.rejects(h.engine.removeQueued(s.id, 'stable-id'), /addressable|queue removal rejected/);
    assert.deepEqual((await h.engine.getMeta(s.id))?.queue, before);
    visibleError(h, s.id, /addressable|queue removal rejected/);
    await assert.rejects(h.engine.unload(s.id), protectedWork);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  });
}

test('removing one queue entry cannot discard another accepted but not yet journaled send', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.queue.items = [queued('older-queue-id', 'older')];
  s.sdk.send.mock.mockImplementation(async () => 'unobserved-acceptance');
  await h.engine.prompt(s.id, 'not in the queue snapshot yet');
  await h.engine.removeQueued(s.id, 'older-queue-id');
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

for (const failedInit of [false, true]) {
test(`live replies remain in native history during initialization (initialization failure: ${failedInit})`, async t => {
  const h = harness(t);
  const s = await h.seed();
  const metadata = await s.rpc.metadata.snapshot();
  const mode = deferred<typeof metadata>();
  s.rpc.metadata.snapshot.mock.mockImplementationOnce(() => mode.promise);
  const loading = h.engine.reload(s.id);
  const outcome = failedInit ? assert.rejects(loading, /initial mode unavailable/) : loading;
  await nextTurn();
  assert.equal(s.sdk.on.mock.callCount(), 1);
  assert.equal(s.listeners.size, 1);
  s.emit(event('assistant.turn_start', { turnId: 'overlap' }));
  s.emit(assistant('native-event-id', 'canonical-message-id', 'streamed once'));
  s.emit(event('assistant.turn_end', { turnId: 'overlap' }));
  if (failedInit) mode.reject(new Error('initial mode unavailable'));
  else mode.resolve(metadata);
  await outcome;
  await nextTurn();
  assert.equal(h.events.filter(event => String(event.type) === 'session/notify').length, 0);
  s.emit(assistant('native-event-id', 'canonical-message-id', 'streamed once'));
  assert.equal(serverChatEvents(h).length, 0);
  s.emit(assistant('second-event-id', 'canonical-message-id', 'confirmed final'));
  const page = await chat(h, s.id, { source: 'live' });
  assert.equal(page.events.find(event => event.id === 'second-event-id')?.data.content, 'confirmed final');
  assert.equal(serverChatEvents(h).length, 0);
  const lateCallback = [...s.listeners][0]!;
  await h.engine.unload(s.id);
  assert.equal(s.listeners.size, 0);
  const meta = (await h.engine.getMeta(s.id));
  lateCallback(event('assistant.turn_start', { turnId: 'detached-turn' }));
  assertSameControlFacts((await h.engine.getMeta(s.id)), meta);
  assert.equal(serverChatEvents(h).length, 0);
});
}

for (const operation of ['create', 'resume'] as const) {
  test(`native early onEvent captures ${operation} work before returning its handle`, async t => {
    const h = harness(t);
    const s = await h.seed();
    s.sdk.workspacePath = `/synthetic-native-workspaces/early-${operation}`;
    const observations: import('./engine.ts').NativeObservation[] = [];
    h.engine.onNativeEvent(value => { observations.push(value); }, { types: ['assistant.message_delta'] });
    const opened = deferred<CopilotSession>();
    const allocate = async (config: SessionConfig) => {
      assert.ok(config.onEvent);
      s.sdk.on(config.onEvent);
      const sdk = await opened.promise;
      h.attached.add(s.id);
      return sdk;
    };
    if (operation === 'create') {
      h.runtime.createSession.mock.mockImplementation(async config => {
        s.sdk.sessionId = config.sessionId!;
        s.id = config.sessionId!;
        h.natives.set(s.id, s);
        return allocate(config);
      });
    } else h.runtime.resumeSession.mock.mockImplementation(async (_id, config) => allocate(config));
    const loading = operation === 'create' ? h.engine.newSession(h.cwd) : h.engine.reload(s.id);
    await nextTurn();
    s.emit(user('early-user'));
    s.emit(event('assistant.turn_start', { turnId: 'early-turn' }));
    s.emit({ ...event('assistant.message_delta', { messageId: 'early-answer', deltaContent: 'final once' }), ephemeral: true });
    s.emit(assistant('early-final', 'early-answer', 'final once'));
    s.emit(event('assistant.turn_end', { turnId: 'early-turn' }, 'early-end'));
    assert.equal(observations.length, 1, 'Early observations are delivered immediately, not buffered');
    assert.equal(Object.hasOwn(observations[0]!, 'workspacePath'), false);
    const lateCallback = [...s.listeners][0]!;
    opened.resolve(s.sdk as unknown as CopilotSession);
    await loading;
    await nextTurn();
    s.emit(event('assistant.message_delta', { messageId: 'bound-answer', deltaContent: 'after SDK return' }));
    assert.equal(observations.at(-1)?.workspacePath, s.sdk.workspacePath);
    assert.equal(s.sdk.on.mock.callCount(), 1, 'Engine must not add a second late subscription');
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
    assert.equal((await chat(h, s.id, { source: 'live' })).events.find(event => event.id === 'early-final')?.data.content, 'final once');
    assert.equal('fold' in activeState(h, s.id), false);
    assert.equal(serverChatEvents(h).length, 0, 'early display events stay in native history, not SSE');
    assert.equal(h.events.filter(value => String(value.type) === 'session/notify').length, 0);
    await h.engine.unload(s.id);
    const meta = (await h.engine.getMeta(s.id));
    lateCallback(event('assistant.turn_start', { turnId: 'stale-turn' }));
    lateCallback(assistant('old-handle-event', 'old-handle-message'));
    assertSameControlFacts((await h.engine.getMeta(s.id)), meta, 'a late old callback cannot revive control state');
    assert.equal(serverChatEvents(h).length, 0);
  });
}

test('failed early allocation discards its callback and never reclassifies received work as an empty draft', async t => {
  const h = harness(t);
  let oldCallback!: NonNullable<SessionConfig['onEvent']>;
  let id!: string;
  h.runtime.createSession.mock.mockImplementationOnce(async config => {
    id = config.sessionId!;
    oldCallback = config.onEvent!;
    oldCallback(user('accepted-before-create-failure'));
    throw new Error('create acknowledgement lost');
  });
  await assert.rejects(h.engine.newSession(h.cwd), /acknowledgement lost/);
  oldCallback(assistant('late-failed-create', 'late-failed-create'));
  await assert.rejects(h.engine.prompt(id, 'must not recreate'), errorWithCode('SESSION_NOT_FOUND'));
  assert.equal((await h.engine.getMeta(id)), null);
  assert.ok(!h.events.some(value => 'sessionId' in value && value.sessionId === id));
  assert.ok(!h.events.some(value => value.type === 'session/added'));
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(serverChatEvents(h).length, 0);
});

test('native closure before resume returns preserves the buffered reply without installing the closed handle', async t => {
  const h = harness(t);
  const s = await h.seed();
  h.runtime.resumeSession.mock.mockImplementationOnce(async (_id, config) => {
    assert.ok(config.onEvent);
    s.sdk.on(config.onEvent);
    s.emit(event('assistant.turn_start', { turnId: 'closed-before-return' }));
    s.emit(assistant('closed-before-return-final', 'closed-before-return-final', 'finished before native close'));
    s.emit(event('assistant.turn_end', { turnId: 'closed-before-return' }, 'closed-before-return-end'));
    h.runtime.expire(s.id, true);
    return s.sdk as unknown as CopilotSession;
  });
  await assert.rejects(h.engine.reload(s.id), /closed while loading/);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal(h.events.filter(value => String(value.type) === 'session/notify').length, 0);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 0);
  assert.equal(s.listeners.size, 0);
});

test('failed initialization metadata preserves native reply history and user acknowledgements', async t => {
  const h = harness(t);
  const s = await h.seed();
  const reading = deferred<Awaited<ReturnType<Rpc['metadata']['snapshot']>>>();
  s.rpc.metadata.snapshot.mock.mockImplementationOnce(() => reading.promise);
  const loading = assert.rejects(h.engine.reload(s.id), /initial metadata read failed/);
  await nextTurn();
  s.emit(user('read-failed-user'));
  s.emit(event('assistant.turn_start', { turnId: 'read-failed-turn' }));
  s.emit({ ...event('assistant.message_delta', { messageId: 'read-failed-answer', deltaContent: 'partial' }), ephemeral: true });
  s.emit(assistant('read-failed-final', 'read-failed-answer', 'final answer'));
  s.emit(event('assistant.turn_end', { turnId: 'read-failed-turn' }, 'read-failed-end'));
  reading.reject(new Error('initial metadata read failed'));
  await loading;
  await nextTurn();
  assert.equal((await chat(h, s.id, { source: 'live' })).events.find(event => event.id === 'read-failed-final')?.data.content, 'final answer');
  assert.equal(h.events.filter(value => String(value.type) === 'session/notify').length, 0);
  s.sdk.send.mock.mockImplementationOnce(async () => {
    s.emit(user('read-failed-accepted'));
    return 'read-failed-accepted';
  });
  await h.engine.prompt(s.id, 'acknowledged after initialization failure');
  s.emit(event('session.idle', {}));
  await nextTurn();
  await h.engine.unload(s.id);
  assert.equal(h.runtime.closeSession.mock.callCount(), 1, 'native acknowledgement releases send protection');
  assert.equal(serverChatEvents(h).length, 0);
});
