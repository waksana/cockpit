import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { deferred, event, harness, nativeCalls, queued, task, type Harness } from '../test-support/engine-harness.ts';

function capture(h: Harness) {
  const logs: Record<string, unknown>[] = [];
  h.engine.log = (message, data) => {
    if (message === 'session.diagnostic') logs.push(structuredClone(data!));
  };
  return logs;
}

test('ask cancellation ACK retains the old target while new turn/decision proceeds; full cancel is distinct', async t => {
  const h = harness(t);
  const s = await h.load();
  const logs = capture(h);
  s.state.processing = true;
  s.state.queue.items = [queued('queued', 'private queued prompt')];
  s.state.tasks = [task()];
  s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'old-interaction' }));
  const ask = h.configs.get(s.id)!.onUserInputRequest!;
  const old = ask({ question: 'private question', allowFreeform: true }, { sessionId: s.id });
  const rejected = assert.rejects(Promise.resolve(old), /interrupted/);
  const requestId = (await h.engine.getMeta(s.id))!.ask!.requestId;
  const token = (await h.engine.getResources(s.id, ['controls']))!.controls!.token;
  const ack = deferred<{ interrupted: boolean }>();
  s.rpc.interruptMainTurn.mock.mockImplementation(() => ack.promise);
  const pending = h.engine.control(s.id, token, { type: 'cancel-decision', kind: 'ask', requestId });
  await nextTurn();
  s.emit(event('abort', { reason: 'user_abort' }));
  await rejected;
  s.emit(event('user.message', { content: 'private new prompt', interactionId: 'new-interaction' }));
  s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'new-interaction' }));
  const next = ask({ question: 'private new question', allowFreeform: true }, { sessionId: s.id });
  const newId = (await h.engine.getMeta(s.id))!.ask!.requestId;
  ack.resolve({ interrupted: true });
  assert.equal((await pending).ok, true);
  assert.equal((await h.engine.getMeta(s.id))!.ask!.requestId, newId);
  await h.engine.respondAsk(s.id, newId, 'private answer', true);
  await next;

  const start = logs.find(row => row.event === 'native.start' && row.action === 'cancel-decision')!;
  const end = logs.find(row => row.event === 'native.ack' && row.operationId === start.operationId)!;
  assert.ok(start.operationId);
  assert.equal(start.method, 'session.interruptMainTurn');
  assert.equal(start.requestId, requestId);
  assert.equal(start.decisionKind, 'ask');
  assert.equal(end.targetEpoch, start.targetEpoch);
  assert.equal(end.targetInteractionId, start.targetInteractionId);
  assert.notEqual(end.targetEpoch, end.epoch);
  assert.notEqual(end.targetInteractionId, end.interactionId);
  assert.deepEqual(end.acknowledgement, { interrupted: true });
  assert.ok(logs.some(row => row.event === 'decision.settlement' && row.requestId === requestId && row.outcome === 'rejected'));
  assert.ok(logs.some(row => row.event === 'decision.settlement' && row.requestId === newId && row.outcome === 'answered'));
  assert.equal(s.rpc.queue.clear.mock.callCount(), 0);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  assert.equal(s.state.queue.items.length, 1);
  assert.equal(s.state.tasks[0]!.status, 'running');
  await h.engine.cancel(s.id);
  const cancel = logs.find(row => row.event === 'operation.start' && row.action === 'cancel')!;
  assert.notEqual(cancel.operationId, start.operationId);
  assert.deepEqual(logs.filter(row => row.operationId === cancel.operationId && row.event === 'native.start')
    .map(row => row.method), ['queue.clear', 'session.abort']);
  assert.equal(JSON.stringify(logs).includes('private'), false);
  assert.equal(JSON.stringify(logs).includes(token), false);
});

test('send entry/receipt and failures are bounded and do not log payloads, opaque IDs or errors', async t => {
  const h = harness(t);
  const s = await h.load('private-session-name');
  const logs = capture(h);
  const secret = 'private-content-' + 'x'.repeat(40_000);
  s.sdk.send.mock.mockImplementation(async () => secret);
  await h.engine.prompt(s.id, secret, 'enqueue', [{ type: 'blob', mimeType: 'text/plain', data: secret, displayName: secret }]);
  s.emit(event('user.message', { content: secret, messageId: secret, interactionId: secret }, secret));
  const receipt = logs.find(row => row.event === 'native.ack' && row.method === 'session.send')!;
  const consumed = logs.find(row => row.nativeEvent === 'user.message')!;
  assert.equal(receipt.messageId, consumed.messageId);
  assert.match(String(receipt.messageId), /^sha256:[0-9a-f]{24}$/);
  s.rpc.queue.clear.mock.mockImplementation(async () => { throw new Error(secret); });
  await assert.rejects(h.engine.cancel(s.id), error => error instanceof Error && error.message === secret);
  const failure = logs.find(row => row.event === 'native.error')!;
  assert.equal(failure.method, 'queue.clear');
  assert.equal(failure.outcome, 'unconfirmed');
  assert.ok(logs.some(row => row.event === 'operation.end' && row.operationId === failure.operationId && row.outcome === 'threw'));
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  assert.equal(s.sdk.send.mock.callCount(), 1);
  for (const row of logs) {
    const json = JSON.stringify(row);
    assert.equal(json.includes('private'), false);
    assert.ok(json.length < 3000, `diagnostic row exceeded bound: ${json.length}`);
  }
});

test('interrupt dispatch binds the admitted target after liveness, not the earlier operation entry', async t => {
  const h = harness(t);
  const s = await h.load();
  const logs = capture(h);
  s.state.processing = true;
  s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'old' }));
  const live = deferred<boolean>();
  h.runtime.isSessionLive.mock.mockImplementationOnce(() => live.promise);
  const ack = deferred<{ interrupted: boolean }>();
  s.rpc.interruptMainTurn.mock.mockImplementationOnce(() => ack.promise);
  const pending = h.engine.interrupt(s.id);
  await nextTurn();
  s.emit(event('user.message', { content: 'private admitted prompt', interactionId: 'admitted' }));
  s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'admitted' }));
  live.resolve(true);
  await nextTurn();
  const start = logs.find(row => row.event === 'native.start')!;
  assert.notEqual(start.entryEpoch, start.targetEpoch);
  assert.notEqual(start.entryInteractionId, start.targetInteractionId);
  assert.equal(start.targetEpoch, start.epoch);
  assert.equal(start.targetInteractionId, start.interactionId);
  s.emit(event('user.message', { content: 'private subsequent prompt', interactionId: 'subsequent' }));
  s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'subsequent' }));
  ack.resolve({ interrupted: true });
  await pending;
  const end = logs.find(row => row.event === 'native.ack')!;
  assert.equal(end.targetEpoch, start.targetEpoch);
  assert.equal(end.targetInteractionId, start.targetInteractionId);
  assert.notEqual(end.targetEpoch, end.epoch);
  assert.notEqual(end.targetInteractionId, end.interactionId);
});

test('cold send diagnostics identify the actual loaded SDK handle without inventing an entry handle', async t => {
  const h = harness(t);
  const s = await h.seed();
  const logs = capture(h);
  await h.engine.prompt(s.id, 'private cold prompt');
  const entry = logs.find(row => row.event === 'operation.start')!;
  const start = logs.find(row => row.event === 'native.start')!;
  const end = logs.find(row => row.event === 'native.ack')!;
  assert.equal(entry.entryHandleId, null);
  assert.ok(start.targetHandleId);
  assert.equal(start.targetHandleId, start.handleId);
  assert.equal(end.targetHandleId, start.targetHandleId);
  assert.equal(s.sdk.send.mock.callCount(), 1);
});

test('existing reads produce one non-atomic count-only sample per diagnostic burst, never poll or infer a drain', async t => {
  const h = harness(t);
  const s = await h.load();
  const logs = capture(h);
  const before = nativeCalls(s);
  s.state.tasks = [task()];
  s.state.queue.items = [queued('queued', 'private queue body')];
  s.rpc.metadata.activity.mock.mockImplementation(async () => ({ hasActiveWork: true, abortable: false }));
  s.emit(event('subagent.completed', { toolCallId: 'spawn-tool-call', agentName: 'private name',
    agentDisplayName: 'private description', cancelled: true }));
  s.emit(event('assistant.turn_end', { turnId: '0' }));
  for (let i = 0; i < 100; i++) s.emit(event('assistant.message_delta', { messageId: 'stream', deltaContent: 'private delta' }));
  await nextTurn();
  assert.deepEqual(nativeCalls(s), before, 'callbacks add no native reads');
  assert.equal(logs.length, 2, 'no stream logging');
  const afterSequence = logs.at(-1)!.sequence;
  await h.engine.getMeta(s.id);
  const samples = logs.filter(row => row.event === 'native.sample');
  assert.equal(samples.length, 1);
  assert.equal(samples[0]!.afterSequence, afterSequence);
  assert.partialDeepStrictEqual(samples[0]!, {
    sameHandle: true, native: { processing: false, hasActiveWork: true, abortable: false,
      tasks: { activeAgents: 1, activeShells: 0, unknown: 0 },
      queue: { pendingCount: 1, steeringCount: 0, inFlightSteeringCount: 0 },
      atomic: false, sameRevision: true, turnActive: 'unavailable', pendingSendAdmission: 'unavailable',
      operationGateOwners: 'unavailable', backgroundNotificationOwners: 'unavailable',
      deferredIdle: 'unavailable', queueDrain: 'unavailable' },
  });
  await h.engine.getMeta(s.id);
  assert.equal(logs.filter(row => row.event === 'native.sample').length, 1);
  assert.equal(JSON.stringify(logs).includes('private'), false);
  assert.equal(logs[0]!.native, 'unavailable');
  assert.equal(logs[0]!.queueDrain, 'unavailable');
  assert.equal(logs[0]!.cancelled, true);
  assert.ok(logs[0]!.toolCallId);
});

test('samples crossing a new turn remain labelled non-atomic and keep their read epoch', async t => {
  const h = harness(t);
  const s = await h.load();
  const logs = capture(h);
  s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'old' }));
  const held = deferred<{ hasActiveWork: boolean; abortable: boolean }>();
  s.rpc.metadata.activity.mock.mockImplementationOnce(() => held.promise);
  const read = h.engine.getMeta(s.id);
  await nextTurn();
  s.emit(event('user.message', { content: 'private new prompt', interactionId: 'new' }));
  s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'new' }));
  held.resolve({ hasActiveWork: true, abortable: false });
  await read;
  const sample = logs.find(row => row.event === 'native.sample')!;
  assert.notEqual(sample.readEpoch, sample.epoch);
  assert.notEqual(sample.readInteractionId, sample.interactionId);
  assert.partialDeepStrictEqual(sample, { native: { atomic: false, sameRevision: false } });
  await h.engine.getMeta(s.id);
  assert.equal(logs.filter(row => row.event === 'native.sample').length, 2, 'new callback retains its own sample request');
});

test('failed samples and partial control outcomes never disguise native uncertainty or expose errors', async t => {
  const h = harness(t);
  const s = await h.load();
  const logs = capture(h);
  s.emit(event('assistant.turn_end', { turnId: '0' }));
  s.rpc.metadata.activity.mock.mockImplementationOnce(async () => { throw new Error('private error'); });
  await assert.rejects(h.engine.getMeta(s.id), /private error/);
  assert.partialDeepStrictEqual(logs.find(row => row.event === 'native.sample')!, {
    native: 'unavailable', nativeUnavailableReason: 'read-failed',
  });
  const token = (await h.engine.getResources(s.id, ['controls']))!.controls!.token;
  s.rpc.queue.clear.mock.mockImplementation(async () => { throw new Error('private control error'); });
  const result = await h.engine.control(s.id, token, { type: 'clear-queue' });
  assert.equal(result.ok, false);
  assert.ok(logs.some(row => row.event === 'control.step' && row.outcome === 'unconfirmed'));
  assert.partialDeepStrictEqual(logs.find(row => row.event === 'operation.end')!, { acknowledgement: { ok: false } });
  assert.equal(JSON.stringify(logs).includes('private'), false);
});

test('throwing diagnostic logger cannot change send, cancellation, decision settlement or native rejection', async t => {
  const h = harness(t);
  const s = await h.load();
  const warning = t.mock.method(process, 'emitWarning', () => {});
  h.engine.log = () => { throw new Error('private logger failure'); };
  s.state.processing = true;
  await h.engine.prompt(s.id, 'private input');
  const ask = h.configs.get(s.id)!.onUserInputRequest!({ question: 'private question' }, { sessionId: s.id });
  const rejected = assert.rejects(Promise.resolve(ask), /cancelled/);
  await h.engine.cancel(s.id);
  await rejected;
  assert.equal(s.sdk.send.mock.callCount(), 1);
  assert.equal(s.rpc.queue.clear.mock.callCount(), 1);
  assert.equal(s.sdk.abort.mock.callCount(), 1);
  const failure = new Error('private native failure');
  s.rpc.queue.clear.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(h.engine.cancel(s.id), error => error === failure);
  assert.equal(s.sdk.abort.mock.callCount(), 1);
  assert.equal(warning.mock.callCount(), 1, 'logger failures warn once per engine, without the error');
  assert.equal(JSON.stringify(warning.mock.calls[0]!.arguments).includes('private'), false);
});
