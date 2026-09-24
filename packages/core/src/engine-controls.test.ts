import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { SessionEvent } from '@github/copilot-sdk';
import type { ExitPlanModeAction } from '@cockpit/protocol';
import { coreCapabilities } from './engine.ts';
import { errorWithCode } from '../test-support/errors.ts';
import {
  assertSameControlFacts,
  assistant,
  chat,
  deferred,
  event,
  harness,
  promptly,
  protectedWork,
  queued,
  serverChatEvents,
  unavailableSession,
  visibleError,
} from '../test-support/engine-harness.ts';

test('cancellation coalesces, blocks concurrent operations, and does not equate abort with idle', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.processing = true;
  const abort = deferred();
  s.sdk.abort.mock.mockImplementation(() => abort.promise);
  const first = h.engine.cancel(s.id);
  const second = h.engine.cancel(s.id);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.cancelling, true);
  for (const operation of [() => h.engine.setMode(s.id, 'plan'), () => h.engine.unload(s.id), () => h.engine.stop()]) {
    await assert.rejects(operation(), protectedWork);
  }
  abort.resolve();
  await Promise.all([first, second]);
  assert.equal(s.sdk.abort.mock.callCount(), 1);
  assert.equal(s.rpc.queue.clear.mock.callCount(), 1);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  assert.equal((await h.engine.getMeta(s.id))?.error, undefined);
  assert.equal((await h.engine.getMeta(s.id))?.cancelling, false);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.state.processing = false;
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  assert.equal((await h.engine.getMeta(s.id))?.error, undefined);
});

test('queue-clear failure neither invokes abort nor hides pending native queue items', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.queue.items = [queued('still-queued', 'keep pending')];
  s.emit(event('pending_messages.modified', {}));
  await nextTurn();
  s.rpc.queue.clear.mock.mockImplementation(async () => { throw new Error('clear refused'); });
  await assert.rejects(h.engine.cancel(s.id), /clear refused/);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  assert.deepEqual((await h.engine.getMeta(s.id))?.queue, [{ id: 'still-queued', text: 'keep pending', canSteer: true }]);
  assert.equal((await h.engine.getMeta(s.id))?.cancelling, false);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  visibleError(h, s.id, /clear refused/);
});

test('interrupt coalesces without cancel or replay and preserves accepted queue identities', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.processing = true;
  s.sdk.send.mock.mockImplementationOnce(async () => 'accepted-a', 0);
  s.sdk.send.mock.mockImplementationOnce(async () => 'accepted-b', 1);
  await h.engine.prompt(s.id, 'A');
  await h.engine.prompt(s.id, 'B');
  s.state.queue.items = [queued('a', 'A'), queued('b', 'B')];
  const result = deferred<{ interrupted: boolean }>();
  s.rpc.interruptMainTurn.mock.mockImplementation(() => result.promise);
  const pending = h.engine.interrupt(s.id);
  const repeated = h.engine.interrupt(s.id);
  await nextTurn();
  await assert.rejects(h.engine.cancel(s.id), errorWithCode('SESSION_BUSY'));
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  result.resolve({ interrupted: true });
  assert.deepEqual(await pending, { ok: true, interrupted: true });
  assert.deepEqual(await repeated, { ok: true, interrupted: true });
  assert.deepEqual(s.rpc.interruptMainTurn.mock.calls[0]!.arguments, [{ flushQueued: true }]);
  assert.equal(s.rpc.interruptMainTurn.mock.callCount(), 1);
  assert.equal(s.rpc.queue.clear.mock.callCount(), 0);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  assert.equal(s.sdk.send.mock.callCount(), 2);
  assert.deepEqual((await h.engine.getMeta(s.id))?.queue, [{ id: 'a', text: 'A', canSteer: true }, { id: 'b', text: 'B', canSteer: true }]);
  s.state.processing = false;
  s.state.queue.items = [];
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running', 'accepted IDs remain protected before their user events');
  for (const id of ['a', 'b']) s.emit(event('user.message', { content: id, messageId: `accepted-${id}` }));
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
});

for (const oldKind of ['ask', 'plan'] as const) {
  test(`interrupt cleans only old ${oldKind} while queued A immediately raises a new ask before ACK`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.processing = true;
    s.emit(event('user.message', { content: 'old', interactionId: 'old' }));
    s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'old' }));
    const config = h.configs.get(s.id)!;
    const old = oldKind === 'ask'
      ? config.onUserInputRequest!({ question: 'Old?', choices: ['yes'] }, { sessionId: s.id })
      : config.onExitPlanModeRequest!({ summary: 'Old plan', actions: ['interactive'], recommendedAction: 'interactive' }, { sessionId: s.id });
    const oldRejected = assert.rejects(Promise.resolve(old), /interrupted/);
    const ack = deferred<{ interrupted: boolean }>();
    s.rpc.interruptMainTurn.mock.mockImplementation(() => ack.promise);
    const pending = h.engine.interrupt(s.id);
    await nextTurn();
    s.emit(event('abort', { reason: 'user_abort' }));
    await oldRejected;
    s.emit(event('user.message', { content: 'A', interactionId: 'new' }));
    s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'new' }));
    const next = config.onUserInputRequest!({ question: 'New A?', choices: ['yes'] }, { sessionId: s.id });
    const requestId = (await h.engine.getMeta(s.id))!.ask!.requestId;
    ack.resolve({ interrupted: true });
    await pending;
    assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, requestId);
    await h.engine.respondAsk(s.id, requestId, 'yes', false);
    assert.deepEqual(await next, { answer: 'yes', wasFreeform: false });
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
}

test('interrupt late ACK and old interaction events preserve the queued native turn', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.processing = true;
  s.emit(event('user.message', { content: 'old', interactionId: 'old' }));
  const ack = deferred<{ interrupted: boolean }>();
  s.rpc.interruptMainTurn.mock.mockImplementation(() => ack.promise);
  const pending = h.engine.interrupt(s.id);
  await nextTurn();
  s.emit(event('abort', { reason: 'user_abort' }));
  s.emit(event('user.message', { content: 'A', interactionId: 'new' }));
  s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'new' }));
  s.emit(event('assistant.message', { messageId: 'new-answer', content: 'A finished', interactionId: 'new' }));
  s.emit(event('assistant.turn_end', { turnId: '0' }));
  s.emit(event('assistant.message', { messageId: 'late-old', content: 'old cancelled', interactionId: 'old' }));
  s.emit(event('assistant.turn_end', { turnId: '0' }));
  ack.resolve({ interrupted: true });
  await pending;
  s.state.processing = false;
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  const newAnswer = s.state.events.find((item): item is Extract<SessionEvent, { type: 'assistant.message' }> =>
    item.type === 'assistant.message' && item.data.messageId === 'new-answer');
  assert.equal(newAnswer?.data.content, 'A finished');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('interrupt false and failure leave existing decisions intact and never resume unloaded sessions', async t => {
  const h = harness(t);
  const s = await h.load();
  const decision = h.configs.get(s.id)!.onUserInputRequest!({ question: 'Keep?', choices: ['yes'] }, { sessionId: s.id });
  const requestId = (await h.engine.getMeta(s.id))!.ask!.requestId;
  assert.deepEqual(await h.engine.interrupt(s.id), { ok: true, interrupted: false });
  assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, requestId);
  s.rpc.interruptMainTurn.mock.mockImplementationOnce(async () => { throw new Error('interrupt transport failed; outcome unknown'); });
  await assert.rejects(h.engine.interrupt(s.id), /outcome unknown/);
  assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, requestId);
  await h.engine.respondAsk(s.id, requestId, 'yes', false);
  await decision;
  await h.engine.unload(s.id);
  const resumes = h.runtime.resumeSession.mock.callCount();
  await assert.rejects(h.engine.interrupt(s.id), unavailableSession);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(s.rpc.interruptMainTurn.mock.callCount(), 2);
});

for (const signal of ['abort', 'new-interaction'] as const) {
  test(`interrupt unknown outcome retains cleanup ownership until native ${signal}`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.processing = true;
    s.emit(event('user.message', { content: 'old', interactionId: 'old' }));
    s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'old' }));
    const old = h.configs.get(s.id)!.onUserInputRequest!({ question: 'Old?', choices: ['yes'] }, { sessionId: s.id });
    const rejected = assert.rejects(Promise.resolve(old), /interrupted/);
    const requestId = (await h.engine.getMeta(s.id))!.ask!.requestId;
    s.rpc.interruptMainTurn.mock.mockImplementation(async () => { throw new Error('Native request timed out; outcome unknown'); });
    await assert.rejects(h.engine.interrupt(s.id), /outcome unknown/);
    assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, requestId, 'Failure alone does not prove interruption');
    if (signal === 'abort') s.emit(event('abort', { reason: 'user_abort' }));
    s.emit(event('user.message', { content: 'A', interactionId: 'next' }));
    s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'next' }));
    await rejected;
    const next = h.configs.get(s.id)!.onUserInputRequest!({ question: 'New?', choices: ['yes'] }, { sessionId: s.id });
    assert.equal((await h.engine.getMeta(s.id))?.ask?.question, 'New?');
    await h.engine.respondAsk(s.id, (await h.engine.getMeta(s.id))!.ask!.requestId, 'yes', false);
    await next;
    assert.equal(s.rpc.interruptMainTurn.mock.callCount(), 1, 'No automatic retry on timeout');
  });
}

test('interrupt closure rejects promptly and ignores a late native acknowledgement', async t => {
  const h = harness(t);
  const s = await h.load();
  const ack = deferred<{ interrupted: boolean }>();
  s.rpc.interruptMainTurn.mock.mockImplementation(() => ack.promise);
  const outcome = assert.rejects(h.engine.interrupt(s.id), /closed/);
  await nextTurn();
  h.runtime.expire(s.id, true);
  await promptly(outcome);
  await h.engine.reload(s.id);
  const before = (await h.engine.getMeta(s.id));
  ack.resolve({ interrupted: true });
  await nextTurn();
  assertSameControlFacts((await h.engine.getMeta(s.id)), before);
});

for (const action of ['unload', 'reload', 'deleteSession'] as const) {
  test(`${action} close failure retains the attached handle, subscription, and metadata`, async t => {
    const h = harness(t);
    const s = await h.load();
    await h.engine.rename(s.id, 'keep title');
    h.runtime.closeSession.mock.mockImplementation(async () => { throw new Error('native close failed'); });
    await assert.rejects(h.engine[action](s.id), /native close failed/);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
    assert.equal((await h.engine.getMeta(s.id))?.closing, false);
    assert.equal((await h.engine.getMeta(s.id))?.title, 'keep title');
    assert.equal(h.attached.size, 1);
    assert.equal(s.listeners.size, 1);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal('trashed' in h.prefs(), false);
    assert.ok(!h.events.some(event => event.type === 'session/removed'));
    visibleError(h, s.id, /native close failed/);
    s.state.name = 'callback still attached';
    h.events.length = 0;
    s.emit(event('session.title_changed', { title: s.state.name }));
    assert.ok(h.events.some(event => event.type === 'session/patch' && event.sessionId === s.id && event.title === 'callback still attached'));
    assert.equal((await h.engine.getMeta(s.id))?.title, 'callback still attached');
    s.emit(assistant('still-attached-event', 'still-attached-message'));
    assert.equal((await chat(h, s.id, { source: 'live' })).events.find(event => event.id === 'still-attached-event')?.data.messageId, 'still-attached-message');
    assert.equal(serverChatEvents(h).length, 0);
  });
}

test('public user-input callbacks return an actual pending promise and validate stale/invalid answers', async t => {
  const h = harness(t);
  const s = await h.load();
  const config = h.configs.get(s.id)!;
  const answer = config.onUserInputRequest!({ question: 'Choose', choices: ['yes', 'no'], allowFreeform: false }, { sessionId: s.id });
  assert.ok(answer instanceof Promise);
  let settled = false;
  void answer.then(() => { settled = true; });
  const id = (await h.engine.getMeta(s.id))!.ask!.requestId;
  await assert.rejects(h.engine.respondAsk(s.id, 'stale-id', 'yes', false), errorWithCode('REQUEST_NOT_PENDING'));
  await assert.rejects(h.engine.respondAsk(s.id, id, 'other', false), /offered choice/);
  await assert.rejects(h.engine.respondAsk(s.id, id, 'free text', true), /Freeform/);
  await assert.rejects(h.engine.respondPlan(s.id, id, 'interactive'), errorWithCode('REQUEST_NOT_PENDING'));
  await nextTurn();
  assert.equal(settled, false);
  assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, id);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  await h.engine.respondAsk(s.id, id, 'yes', false);
  assert.deepEqual(await answer, { answer: 'yes', wasFreeform: false });
  assert.equal((await h.engine.getMeta(s.id))?.ask, null);
  await assert.rejects(h.engine.respondAsk(s.id, id, 'yes', false), errorWithCode('REQUEST_NOT_PENDING'));
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('multiple native input callbacks retain independent promises and reveal the next pending request', async t => {
  const h = harness(t);
  const s = await h.load();
  const config = h.configs.get(s.id)!;
  const first = config.onUserInputRequest!({ question: 'First?' }, { sessionId: s.id });
  const firstId = (await h.engine.getMeta(s.id))!.ask!.requestId;
  const second = config.onUserInputRequest!({ question: 'Second?' }, { sessionId: s.id });
  assert.equal((await h.engine.getMeta(s.id))?.ask?.question, 'First?');
  await h.engine.respondAsk(s.id, firstId, 'first answer', true);
  assert.deepEqual(await first, { answer: 'first answer', wasFreeform: true });
  const secondId = (await h.engine.getMeta(s.id))!.ask!.requestId;
  assert.notEqual(secondId, firstId);
  assert.equal((await h.engine.getMeta(s.id))?.ask?.question, 'Second?');
  await h.engine.respondAsk(s.id, secondId, 'second answer', true);
  assert.deepEqual(await second, { answer: 'second answer', wasFreeform: true });
});

test('meta publishes every pending decision in arrival order alongside the first of each kind', async t => {
  const h = harness(t);
  const s = await h.load();
  const config = h.configs.get(s.id)!;
  void config.onUserInputRequest!({ question: 'First?' }, { sessionId: s.id });
  void config.onExitPlanModeRequest!({ summary: 'Plan', actions: ['interactive'], recommendedAction: 'interactive' }, { sessionId: s.id });
  void config.onUserInputRequest!({ question: 'Second?' }, { sessionId: s.id });
  void config.onElicitationRequest!({ sessionId: s.id, message: 'Confirm', elicitationSource: 'fixture-mcp' });
  const meta = (await h.engine.getMeta(s.id))!;
  assert.deepEqual(meta.decisions?.map(d => d.kind), ['ask', 'plan', 'ask', 'elicitation']);
  assert.deepEqual(meta.decisions?.map(d => d.request.requestId),
    [meta.ask!.requestId, meta.planRequest!.requestId, meta.decisions![2]!.request.requestId, meta.elicitation!.requestId]);
  assert.equal(meta.ask?.question, 'First?');
  assert.equal(meta.elicitation?.source, 'fixture-mcp');
  await h.engine.respondAsk(s.id, meta.ask!.requestId, 'one', true);
  const next = (await h.engine.getMeta(s.id))!;
  assert.deepEqual(next.decisions?.map(d => d.kind), ['plan', 'ask', 'elicitation']);
  assert.equal(next.ask?.question, 'Second?');
});

test('plan callback rejects unoffered actions without resolving, then returns the exact native answer', async t => {
  const h = harness(t);
  const s = await h.load();
  const result = h.configs.get(s.id)!.onExitPlanModeRequest!({
    summary: 'Native plan', actions: ['exit_only', 'interactive'], recommendedAction: 'interactive',
  }, { sessionId: s.id });
  assert.ok(result instanceof Promise);
  let settled = false;
  void result.then(() => { settled = true; }, () => { settled = true; });
  const id = (await h.engine.getMeta(s.id))!.planRequest!.requestId;
  await assert.rejects(h.engine.respondPlan(s.id, id, 'autopilot'), /not offered/);
  await assert.rejects(h.engine.planSupersede(s.id, 'stale', 'replacement'), errorWithCode('REQUEST_NOT_PENDING'));
  await assert.rejects(h.engine.planSupersede(s.id, id, ' \n '), errorWithCode('INVALID_REQUEST'));
  await nextTurn();
  assert.equal(settled, false, 'invalid feedback must leave the real callback pending');
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  assert.equal(s.rpc.mode.set.mock.callCount(), 0);
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 0);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  await h.engine.respondPlan(s.id, id, 'interactive');
  assert.deepEqual(await result, { approved: true, selectedAction: 'interactive' });
  assert.equal((await h.engine.getMeta(s.id))?.planRequest, null);
  await assert.rejects(h.engine.respondPlan(s.id, id, 'interactive'), errorWithCode('REQUEST_NOT_PENDING'));
});

test('a native plan action outside the supported protocol cannot be accepted through a forged action', async t => {
  const h = harness(t);
  const s = await h.load();
  const result = h.configs.get(s.id)!.onExitPlanModeRequest!({
    summary: 'Native plan', actions: ['interactive', 'future-action'], recommendedAction: 'future-action',
  }, { sessionId: s.id });
  const id = (await h.engine.getMeta(s.id))!.planRequest!.requestId;
  assert.deepEqual((await h.engine.getMeta(s.id))?.planRequest?.actions, ['interactive']);
  await assert.rejects(h.engine.respondPlan(s.id, id, 'future-action' as ExitPlanModeAction), errorWithCode('INVALID_REQUEST'));
  assert.equal((await h.engine.getMeta(s.id))?.planRequest?.requestId, id);
  await h.engine.respondPlan(s.id, id, 'interactive');
  assert.deepEqual(await result, { approved: true, selectedAction: 'interactive' });
});

for (const mode of ['form', 'url'] as const) {
  test(`${mode} elicitation cannot fake structured acceptance; decline resolves the real callback`, async t => {
    const h = harness(t);
    const s = await h.load();
    const result = h.configs.get(s.id)!.onElicitationRequest!({
      sessionId: s.id, message: 'Provide account details', mode,
      ...(mode === 'form'
        ? { requestedSchema: { type: 'object' as const, properties: { label: { type: 'string' as const } }, required: ['label'] } }
        : { url: 'https://example.invalid/never-opened' }),
    });
    assert.ok(result instanceof Promise);
    let settled = false;
    void result.then(() => { settled = true; });
    const id = (await h.engine.getMeta(s.id))!.elicitation!.requestId;
    assert.deepEqual((await h.engine.getMeta(s.id))!.elicitation, {
      requestId: id, message: 'Provide account details', actions: ['decline', 'cancel'],
    });
    await assert.rejects(h.engine.respondElicitation(s.id, 'stale', 'decline'), errorWithCode('REQUEST_NOT_PENDING'));
    await assert.rejects(h.engine.respondElicitation(s.id, id, 'accept'), errorWithCode('UNSUPPORTED'));
    await nextTurn();
    assert.equal(settled, false);
    assert.equal((await h.engine.getMeta(s.id))?.elicitation?.requestId, id);
    await h.engine.respondElicitation(s.id, id, 'decline');
    assert.deepEqual(await result, { action: 'decline' });
    assert.equal((await h.engine.getMeta(s.id))?.elicitation, null);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
}

test('failed abort keeps native decisions pending; successful cancellation rejects their real promises', async t => {
  const h = harness(t);
  const s = await h.load();
  const pending = h.configs.get(s.id)!.onUserInputRequest!({ question: 'Still waiting?' }, { sessionId: s.id });
  let settled = false;
  void Promise.resolve(pending).then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(Promise.resolve(pending), /Native request cancelled/);
  const requestId = (await h.engine.getMeta(s.id))!.ask!.requestId;
  s.sdk.abort.mock.mockImplementationOnce(async () => { throw new Error('abort refused'); });
  await assert.rejects(h.engine.cancel(s.id), /abort refused/);
  await nextTurn();
  assert.equal(settled, false, 'failed abort must not settle the real native callback');
  assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, requestId);
  await h.engine.cancel(s.id);
  await rejection;
  assert.equal((await h.engine.getMeta(s.id))?.ask, null);
  await assert.rejects(h.engine.respondAsk(s.id, requestId, 'too late', true), errorWithCode('REQUEST_NOT_PENDING'));
});

for (const stage of ['mutation', 'readback'] as const) {
  test(`model ${stage} failure never publishes the requested model or options`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
      id: 'unconfirmed-model', supportedReasoningEfforts: ['high'], billing: { token_prices: { long_context: {} } },
    }] }));
    const before = (await h.engine.getMeta(s.id))!;
    const fail = async () => { throw new Error(`model ${stage} rejected`); };
    if (stage === 'mutation') s.rpc.model.switchTo.mock.mockImplementation(fail);
    else s.rpc.model.getCurrent.mock.mockImplementation(fail);
    h.events.length = 0;
    if (stage === 'mutation') await assert.rejects(h.engine.setModel(s.id, 'unconfirmed-model', 'high', 'long_context'), /model .* rejected/);
    else assert.deepEqual(await h.engine.setModel(s.id, 'unconfirmed-model', 'high', 'long_context'), { modelId: 'unconfirmed-model' });
    if (stage === 'readback') await assert.rejects(h.engine.getMeta(s.id), /model readback rejected/);
    else {
      const after = (await h.engine.getMeta(s.id))!;
      assert.equal(after.currentModelId, before.currentModelId);
      assert.equal(after.currentReasoningEffort, before.currentReasoningEffort);
      assert.equal(after.currentContextTier, before.currentContextTier);
    }
    assert.ok(!h.events.some(event => event.type === 'session/patch' && event.currentModelId === 'unconfirmed-model'));
    if (stage === 'mutation') visibleError(h, s.id, /model .* rejected/);
    s.rpc.model.getCurrent.mock.mockImplementation(async () => structuredClone(s.state.model));
    assert.equal((await h.engine.getMeta(s.id))?.currentModelId,
      stage === 'readback' ? 'unconfirmed-model' : before.currentModelId, 'later reads report actual native state');
    assert.equal(s.rpc.model.switchTo.mock.callCount(), 1, 'readback failure never retries a mutation');
  });

  test(`name ${stage} failure never publishes an optimistic title`, async t => {
    const h = harness(t);
    const s = await h.load();
    const before = (await h.engine.getMeta(s.id))!.title;
    const fail = async () => { throw new Error(`name ${stage} rejected`); };
    if (stage === 'mutation') s.rpc.name.set.mock.mockImplementation(fail);
    else s.rpc.name.get.mock.mockImplementation(fail);
    h.events.length = 0;
    await assert.rejects(h.engine.rename(s.id, 'unconfirmed title'), /name .* rejected/);
    if (stage === 'readback') await assert.rejects(h.engine.getMeta(s.id), /name readback rejected/);
    else assert.equal((await h.engine.getMeta(s.id))?.title, before);
    assert.ok(!h.events.some(event => event.type === 'session/patch' && event.title === 'unconfirmed title'));
    visibleError(h, s.id, /name .* rejected/);
    s.rpc.name.get.mock.mockImplementation(async () => ({ name: s.state.name }));
    assert.equal((await h.engine.getMeta(s.id))?.title, stage === 'readback' ? 'unconfirmed title' : before);
    assert.equal(s.rpc.name.set.mock.callCount(), 1);
  });
}
test('plan feedback resolves the exact native callback without mode changes or another prompt; simple elicitation can accept', async t => {
  const h = harness(t);
  const s = await h.load();
  const config = h.configs.get(s.id)!;
  const plan = config.onExitPlanModeRequest!({
    summary: '## 请确认计划', actions: ['interactive'], recommendedAction: 'interactive',
  }, { sessionId: s.id });
  const requestId = (await h.engine.getMeta(s.id))!.planRequest!.requestId;
  const feedback = '  请保留我的输入\n先修改测试，再执行。  ';
  await h.engine.planSupersede(s.id, requestId, feedback);
  assert.deepEqual(await plan, { approved: false, feedback });
  assert.equal((await h.engine.getMeta(s.id))?.planRequest, null);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(s.rpc.mode.set.mock.callCount(), 0);
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 0);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  const elicitation = config.onElicitationRequest!({ sessionId: s.id, message: '请确认' });
  const id = (await h.engine.getMeta(s.id))!.elicitation!.requestId;
  assert.deepEqual((await h.engine.getMeta(s.id))!.elicitation, { requestId: id, message: '请确认', actions: ['accept', 'decline', 'cancel'] });
  await h.engine.respondElicitation(s.id, id, 'accept');
  assert.deepEqual(await elicitation, { action: 'accept' });
  assert.equal(coreCapabilities.planSupersede, 'pending-plan-feedback');
  assert.equal(coreCapabilities.deleteSession, true);
  assert.equal('purgeSession' in coreCapabilities, false);
  assert.equal(coreCapabilities.elicitationAccept, 'unstructured-only');
  assert.equal(coreCapabilities.schedule.cron, false);
});
