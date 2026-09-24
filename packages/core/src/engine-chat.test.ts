import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { SessionEvent } from '@github/copilot-sdk';
import { sessionMetaBusy } from '../test-support/lifecycle.ts';
import { CHAT_EVENT_TYPES } from './native-chat.ts';
import {
  type Rpc,
  activeState,
  assertSameControlFacts,
  assistant,
  chat,
  deferred,
  event,
  harness,
  nativeCallDelta,
  nativeCalls,
  promptly,
  protectedWork,
  queued,
  serverChatEvents,
  timestamp,
  user,
} from '../test-support/engine-harness.ts';

function journal(sessionId: string, cwd: string): SessionEvent[] {
  return [
    event('session.start', { sessionId, version: 1, producer: 'structural-fixture', copilotVersion: 'test',
      startTime: timestamp, context: { cwd } }),
    user('history-user', 'history question'),
    assistant('history-answer-event', 'history-answer', 'history answer'),
    event('session.title_changed', { title: 'persisted title' }),
    user('latest-user', 'latest question'),
    assistant('latest-answer-event', 'latest-answer', 'latest answer'),
  ];
}

function nestedJournal(): SessionEvent[] {
  const scoped = (native: SessionEvent, agentId: string) => ({ ...native, agentId });
  const start = (toolCallId: string) => event('subagent.started', {
    toolCallId, agentName: 'explore', agentDisplayName: toolCallId, agentDescription: `${toolCallId} task`,
  });
  const complete = (toolCallId: string) => event('subagent.completed', {
    toolCallId, agentName: 'explore', agentDisplayName: toolCallId,
  });
  return [
    user('nested-root', 'Inspect nested work'),
    event('assistant.message', { messageId: 'outer-spawn', content: '', toolRequests: [
      { toolCallId: 'outer', name: 'task', arguments: { prompt: 'outer private prompt' } },
    ] }),
    scoped(start('outer'), 'outer-agent'),
    scoped(assistant('outer-intro-event', 'outer-intro', 'outer progress'), 'outer-agent'),
    scoped(event('assistant.message', { messageId: 'inner-spawn', content: '', toolRequests: [
      { toolCallId: 'inner', name: 'task', arguments: { prompt: 'inner private prompt' } },
    ] }), 'outer-agent'),
    scoped(start('inner'), 'inner-agent'),
    scoped(assistant('inner-answer-event', 'inner-answer', 'deep child answer'), 'inner-agent'),
    scoped(complete('inner'), 'inner-agent'),
    scoped(assistant('outer-answer-event', 'outer-answer', 'outer final answer'), 'outer-agent'),
    scoped(complete('outer'), 'outer-agent'),
    assistant('root-answer-event', 'root-answer', 'root final answer'),
  ];
}

for (const availability of ['loaded', 'unloaded', 'legacy-trashed'] as const) {
  test(`native chat reads one passive page for ${availability} sessions without changing runtime or metadata`, async t => {
    const id = 'native-chat-session';
    const h = harness(t, { prefs: availability === 'legacy-trashed' ? { trashed: { [id]: { at: 1 } } } : {} });
    const s = await h.seed(id);
    const journal = nestedJournal();
    h.journals.set(s.id, journal);
    if (availability === 'loaded') await h.engine.reload(s.id);
    const snapshot = (await h.engine.snapshot());
    const before = nativeCalls(s);
    const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
    const resumes = h.runtime.resumeSession.mock.callCount();
    const probes = h.runtime.isSessionLive.mock.callCount();
    const prefs = readFileSync(h.prefsFile, 'utf8');
    h.events.length = 0;
    const page = await chat(h, s.id, { max: 3 });
    assert.deepEqual(page.events, journal.slice(-3));
    assert.equal(page.hasMore, true);
    assert.equal('title' in page, false);
    assert.equal('cwd' in page, false);
    assert.deepEqual(page.read, { rpc: 1, events: 3 });
    assert.deepEqual(h.runtime.rpc.sessions.readPersistedEvents.mock.calls.map(call => call.arguments), [[{
      sessionId: s.id, direction: 'backward', cursor: undefined, max: 3,
    }]]);
    assert.deepEqual(nativeCalls(s), before);
    assert.equal(h.runtime.isSessionLive.mock.callCount(), probes);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads + (availability === 'loaded' ? 0 : 1),
      'only an unanchored unloaded read verifies native existence');
    assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs);
    assert.deepEqual(h.events, []);
    assertSameControlFacts((await h.engine.snapshot()), snapshot);
  });
}

test('unlisted native chat confirms existence without registering or returning metadata', async t => {
  const h = harness(t);
  const id = 'unlisted-native-session';
  h.rows.push({
    sessionId: id, summary: 'native metadata title', isRemote: false,
    startTime: new Date(timestamp), modifiedTime: new Date(timestamp), context: { workingDirectory: h.cwd },
  });
  h.journals.set(id, journal(id, join(h.cwd, 'old-transcript-directory')));
  const page = await chat(h, id, { max: 1 });
  assert.equal('title' in page, false);
  assert.equal('cwd' in page, false);
  assert.equal(page.events.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(h.runtime.getSessionMetadata.mock.callCount(), 1);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 1);
  assert.equal(activeState(h, id), undefined);
  assert.equal(h.runtime.listSessions.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.deepEqual(h.events, []);
});

test('unknown native metadata rejects chat instead of guessing from a journal or fabricating an empty draft', async t => {
  const h = harness(t);
  h.journals.set('missing-native-session', nestedJournal());
  await assert.rejects(chat(h, 'missing-native-session'), { statusCode: 404 });
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.deepEqual((await h.engine.snapshot()).sessions, []);
  assert.deepEqual(h.events, []);
});

test('passive native chat leaves live and indexed metadata to the separate session getter', async t => {
  const h = harness(t);
  const s = await h.load();
  h.journals.set(s.id, journal(s.id, join(h.cwd, 'stale-cwd')));
  await h.engine.rename(s.id, 'confirmed live title');
  h.rows[0]!.summary = 'stale list title';
  await h.engine.refreshList();
  const before = (await h.engine.getMeta(s.id));
  assert.equal(before?.title, 'confirmed live title');
  assert.equal(before?.cwd, h.cwd);
  const reads = nativeCalls(s);
  h.events.length = 0;
  const page = await chat(h, s.id, { max: 1 });
  assert.equal('title' in page, false);
  assert.equal('cwd' in page, false);
  assert.deepEqual(nativeCalls(s), reads);
  assert.deepEqual(h.events, []);
  assertSameControlFacts((await h.engine.getMeta(s.id)), before);
});

for (const direction of ['forward', 'backward'] as const) {
  test(`native ${direction} event cursors select exactly one page and returned data is request-isolated`, async t => {
    const h = harness(t);
    const s = await h.seed();
    const journal = nestedJournal();
    h.journals.set(s.id, journal);
    const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
    const first = await chat(h, s.id, { direction, max: 2 });
    assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads + 1);
    const expected = direction === 'forward' ? journal.slice(2, 4) : journal.slice(-4, -2);
    const second = await chat(h, s.id, { direction, max: 2, cursor: first.cursor });
    assert.deepEqual(second.events, expected);
    assert.deepEqual(h.runtime.rpc.sessions.readPersistedEvents.mock.calls[1]!.arguments, [{
      sessionId: s.id, direction, max: 2, cursor: first.cursor,
    }]);
    second.events[0]!.data.content = 'caller mutation';
    second.events.splice(1);
    const again = await chat(h, s.id, { direction, max: 2, cursor: first.cursor });
    assert.deepEqual(again.events, expected);
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 3, 'no shared response or full-history cache');
    assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads + 1,
      'known native cursors avoid additional metadata RPCs');
    assert.deepEqual(again.read, { rpc: 1, events: 2 });
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
    assert.equal(s.sdk.on.mock.callCount(), 0);
  });
}

test('live native chat forwards child, event, wait and ephemeral filters without traversing root history', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = nestedJournal();
  const before = nativeCalls(s);
  const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
  const page = await chat(h, s.id, {
    source: 'live', direction: 'forward', max: 1, waitMs: 1000, includeEphemeral: false,
    agentIds: ['inner-agent'], agentScope: 'all', types: ['assistant.message'],
  });
  assert.deepEqual(page.events, [s.state.events.find(event => event.id === 'inner-answer-event')!]);
  assert.deepEqual(page.read, { rpc: 1, events: 1 });
  assert.deepEqual(s.rpc.eventLog.read.mock.calls.at(-1)!.arguments, [{
    cursor: undefined, max: 1, direction: 'forward', waitMs: 1000, includeEphemeral: false,
    types: ['assistant.message'], agentScope: 'all', agentIds: ['inner-agent'],
  }]);
  assert.deepEqual(nativeCallDelta(s, before), { 'eventLog.read': 1 });
  assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(serverChatEvents(h).length, 0);
});

test('native chat bootstrap uses a separate forward tail and performs no replay or interest registration', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = [user('before-bootstrap')];
  const before = nativeCalls(s);
  const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
  const page = await chat(h, s.id, { source: 'live', bootstrap: true, max: 1 });
  assert.ok(page.liveCursor);
  assert.deepEqual(page.read, { rpc: 2, events: 1 });
  assert.deepEqual(nativeCallDelta(s, before), { 'eventLog.tail': 1, 'eventLog.read': 1 });
  s.emit(assistant('after-bootstrap', 'answer', 'new native event'));
  const next = await chat(h, s.id, { source: 'live', direction: 'forward', cursor: page.liveCursor, max: 1 });
  assert.deepEqual(next.events.map(event => event.id), ['after-bootstrap']);
  assert.deepEqual(s.rpc.eventLog.read.mock.calls.at(-1)!.arguments, [{
    cursor: page.liveCursor, max: 1, direction: 'forward', waitMs: 0, includeEphemeral: true,
    types: CHAT_EVENT_TYPES, agentScope: 'all',
  }]);
  assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads,
    'live bootstrap and cursor polls never query separate native metadata');
  assert.equal(serverChatEvents(h).length, 0);
});

for (const availability of ['unloaded', 'closed', 'legacy-trashed'] as const) {
  test(`native live chat rejects ${availability} handles without passive fallback or auto-resume`, async t => {
    const id = 'native-chat-session';
    const h = harness(t, { prefs: availability === 'legacy-trashed' ? { trashed: { [id]: { at: 1 } } } : {} });
    const s = availability === 'closed' ? await h.load(id) : await h.seed(id);
    if (availability === 'closed') h.runtime.expire(s.id, true);
    const before = nativeCalls(s);
    const resumes = h.runtime.resumeSession.mock.callCount();
    await assert.rejects(chat(h, s.id, { source: 'live' }), { code: 'SESSION_UNLOADED', statusCode: 409 });
    assert.deepEqual(nativeCalls(s), before);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
  });
}

for (const source of ['persisted', 'live'] as const) {
  test(`native ${source} chat failures are request-scoped, never retried or replaced with cached data`, async t => {
    const h = harness(t);
    const s = await h.load();
    const read = source === 'live' ? s.rpc.eventLog.read : h.runtime.rpc.sessions.readPersistedEvents;
    const calls = read.mock.callCount();
    read.mock.mockImplementationOnce(async () => { throw new Error('native page unavailable'); });
    const before = (await h.engine.getMeta(s.id));
    await assert.rejects(chat(h, s.id, { source }), /native page unavailable/);
    assert.equal(read.mock.callCount(), calls + 1);
    assertSameControlFacts((await h.engine.getMeta(s.id)), before, 'display read failure does not poison control state');
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
    assert.equal(serverChatEvents(h).length, 0);
    s.state.name = 'control remains responsive';
    s.emit(event('session.title_changed', { title: s.state.name }));
    assert.equal((await h.engine.getMeta(s.id))?.title, 'control remains responsive');
  });
}

test('a failed live chat read reconciles silent native unload once without resuming or aborting the model', async t => {
  const h = harness(t);
  const s = await h.load();
  const probes = h.runtime.isSessionLive.mock.callCount();
  const resumes = h.runtime.resumeSession.mock.callCount();
  h.runtime.expire(s.id, false);
  s.rpc.eventLog.read.mock.mockImplementationOnce(async () => { throw new Error('native session no longer exists'); });
  await assert.rejects(chat(h, s.id, { source: 'live', cursor: 'native-boundary' }), {
    code: 'SESSION_UNLOADED', statusCode: 409,
  });
  assert.equal(h.runtime.isSessionLive.mock.callCount(), probes + 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 1);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
  assert.equal(activeState(h, s.id), undefined);
});

test('native event reads return expired cursors explicitly without restarting or scanning history', async t => {
  const h = harness(t);
  const s = await h.seed();
  h.journals.set(s.id, [user('before-rewrite')]);
  const page = await chat(h, s.id, { max: 1 });
  h.journals.set(s.id, [user('after-rewrite')]);
  const expired = await chat(h, s.id, { cursor: page.cursor, max: 1 });
  assert.equal(expired.cursorStatus, 'expired');
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 2);
  assert.deepEqual(expired.read, { rpc: 1, events: 1 });
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('loaded initialization keeps only control state and does not prewarm a large display journal', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.events = Array.from({ length: 3000 }, (_, i) => assistant(`event-${i}`, `message-${i}`, 'history payload'));
  await h.engine.reload(s.id);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 0, 'initialization does not read chat or cache naming eligibility');
  const state = activeState(h, s.id);
  for (const key of ['fold', 'eventIds', 'userMessageIds']) assert.equal(key in state, false);
  const page = await chat(h, s.id, { source: 'live', max: 2 });
  assert.deepEqual(page.events.map(event => event.id), ['event-2998', 'event-2999']);
  assert.deepEqual(page.read, { rpc: 1, events: 2 });
  assert.equal(page.hasMore, true);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 1);
  for (const native of nestedJournal()) s.emit(native);
  s.emit({ ...event('assistant.message_delta', { messageId: 'stream', deltaContent: 'native streaming' }), ephemeral: true });
  await nextTurn();
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 1, 'live callbacks never refill a server display cache');
  assert.equal(s.sdk.getEvents.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal(JSON.stringify((await h.engine.snapshot())).includes('history payload'), false);
  assert.equal(JSON.stringify(h.events).includes('native streaming'), false);
  assert.equal('changedFiles' in await h.engine.getPlan(s.id), false);
});

for (const success of [true, false]) {
  test(`compaction completion (${success}) updates progress without invalidating or replaying native chat`, async t => {
    const h = harness(t);
    const s = await h.load();
    const reads = s.rpc.eventLog.read.mock.callCount();
    s.emit(event('session.compaction_start', {}));
    assert.ok(h.events.some(event => event.type === 'session/invalidated' && event.sessionId === s.id));
    s.emit(event('session.compaction_complete', { success }));
    await nextTurn();
    assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
    assert.deepEqual(h.events.filter(event => event.type === 'chat/invalidated'), []);
    assert.equal(s.rpc.eventLog.read.mock.callCount(), reads);
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
    assert.equal(serverChatEvents(h).length, 0);
  });
}

for (const action of ['unload', 'stop'] as const) {
  test(`pending live chat long-poll creates no busy state and cannot block idle ${action}`, async t => {
    const h = harness(t);
    const s = await h.load();
    const state = activeState(h, s.id);
    const beforeRead = (await h.engine.snapshot());
    const read = deferred<Awaited<ReturnType<Rpc['eventLog']['read']>>>();
    let nativeReadSettled = false;
    s.rpc.eventLog.read.mock.mockImplementationOnce(async () => {
      const page = await read.promise;
      nativeReadSettled = true;
      return page;
    });
    const pending = assert.rejects(chat(h, s.id, {
      source: 'live', direction: 'forward', waitMs: 1000,
    }), /closed during operation/);
    await nextTurn();
    assert.equal(s.rpc.eventLog.read.mock.calls.at(-1)!.arguments[0].waitMs, 1000);
    assert.equal(nativeReadSettled, false);
    assert.equal(activeState(h, s.id).operations, 0);
    assertSameControlFacts((await h.engine.snapshot()), beforeRead, 'chat must not publish artificial processing or operations');
    assert.equal(sessionMetaBusy((await h.engine.getMeta(s.id))!), false, 'the diagnostic snapshot remains idle');
    await promptly(action === 'unload' ? h.engine.unload(s.id) : h.engine.stop());
    await promptly(pending);
    assert.equal(nativeReadSettled, false, 'close and chat rejection must not wait for the native poll response');
    assert.equal(h.attached.has(s.id), false);
    assert.equal(activeState(h, s.id), undefined);
    assert.equal(state.operations, 0);
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
    assert.equal(h.runtime.stop.mock.callCount(), action === 'stop' ? 1 : 0);
    if (action === 'stop') assert.ok(h.trace.indexOf(`close:${s.id}`) < h.trace.indexOf('stop'));
    const beforeLateResult = structuredClone(h.events);
    read.resolve({ events: [assistant('late-page', 'late-answer')], cursor: 'late', cursorStatus: 'ok', hasMore: false });
    await nextTurn();
    assert.equal(nativeReadSettled, true);
    assert.deepEqual(h.events, beforeLateResult);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(s.sdk.abort.mock.callCount(), 0);
    assert.equal(s.rpc.queue.clear.mock.callCount(), 0);
    assert.equal(serverChatEvents(h).length, 0);
  });

  for (const work of ['processing', 'queue'] as const) {
    test(`pending live chat long-poll cannot weaken ${work} protection during ${action}`, async t => {
      const h = harness(t);
      const s = await h.load();
      const state = activeState(h, s.id);
      s.state.processing = work === 'processing';
      s.state.queue.items = work === 'queue' ? [queued('protected-queue', 'must remain queued')] : [];
      s.emit(event('pending_messages.modified', {}));
      await nextTurn();
      const queue = structuredClone(s.state.queue);
      const meta = (await h.engine.getMeta(s.id));
      const read = deferred<Awaited<ReturnType<Rpc['eventLog']['read']>>>();
      s.rpc.eventLog.read.mock.mockImplementationOnce(() => read.promise);
      let chatSettled = false;
      const pending = assert.rejects(chat(h, s.id, {
        source: 'live', direction: 'forward', waitMs: 1000,
      }).finally(() => { chatSettled = true; }), /closed during operation/);
      await nextTurn();
      assert.equal(activeState(h, s.id).operations, 0);
      assertSameControlFacts((await h.engine.getMeta(s.id)), meta);
      assert.equal(sessionMetaBusy((await h.engine.getMeta(s.id))!), true);
      await assert.rejects(action === 'unload' ? h.engine.unload(s.id) : h.engine.stop(), protectedWork);
      assert.equal(chatSettled, false, 'refused teardown leaves the existing native read attached');
      assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
      assert.equal((await h.engine.getMeta(s.id))?.closing, false);
      assert.equal(sessionMetaBusy((await h.engine.getMeta(s.id))!), true);
      assert.equal(s.state.processing, work === 'processing');
      assert.deepEqual(s.state.queue, queue);
      assert.deepEqual((await h.engine.getMeta(s.id))?.queue, work === 'queue'
        ? [{ id: 'protected-queue', text: 'must remain queued', canSteer: true }] : []);
      assert.equal(h.runtime.closeSession.mock.callCount(), 0);
      assert.equal(h.runtime.stop.mock.callCount(), 0);
      assert.equal(s.sdk.abort.mock.callCount(), 0);
      assert.equal(s.rpc.queue.clear.mock.callCount(), 0);
      assert.equal(s.rpc.queue.removeAt.mock.callCount(), 0);
      s.state.processing = false;
      s.state.queue.items = [];
      s.emit(event('session.idle', {}));
      await nextTurn();
      assert.equal(sessionMetaBusy((await h.engine.getMeta(s.id))!), false, 'only native work completion releases protection');
      assert.equal(chatSettled, false);
      await promptly(action === 'unload' ? h.engine.unload(s.id) : h.engine.stop());
      await promptly(pending);
      assert.equal(h.runtime.closeSession.mock.callCount(), 1);
      assert.equal(h.runtime.stop.mock.callCount(), action === 'stop' ? 1 : 0);
      const beforeLateResult = structuredClone(h.events);
      read.resolve({ events: [], cursor: 'late', cursorStatus: 'ok', hasMore: false });
      await nextTurn();
      assert.deepEqual(h.events, beforeLateResult);
      assert.equal(activeState(h, s.id), undefined);
      assert.equal(state.operations, 0);
      assert.equal(serverChatEvents(h).length, 0);
    });
  }
}
