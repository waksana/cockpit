import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { SessionEvent } from '@github/copilot-sdk';
import { validateForkHistory } from './fork.ts';
import { errorWithCode } from '../test-support/errors.ts';
import {
  type Rpc,
  assistant,
  deferred,
  event,
  fakeSession,
  harness,
  queued,
  schedule,
  task,
  user,
} from '../test-support/engine-harness.ts';

test('fork registers a distinct unloaded child, with an exclusive native boundary and no side effects', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = [user('first'), assistant('reply', 'reply-id'), user('second')];
  const before = structuredClone(s.state.events);
  const result = await h.engine.forkSession(s.id, 'second', 'Independent');
  assert.notEqual(result.sessionId, s.id);
  assert.deepEqual(h.runtime.rpc.sessions.fork.mock.calls[0]!.arguments, [{ sessionId: s.id, toEventId: 'second', name: 'Independent' }]);
  assert.deepEqual(s.state.events, before);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(result.sessionId))!.loaded, false);
  assert.equal((await h.engine.getMeta(result.sessionId))!.cwd, h.cwd);
  assert.equal('project' in (await h.engine.getMeta(result.sessionId))!, false);
  assert.equal((await h.engine.getMeta(result.sessionId))!.title, 'Independent');
  assert.equal((await h.engine.getMeta(result.sessionId))!.queue, undefined);
  assert.equal((await h.engine.getMeta(s.id))!.closing, false);
  assert.ok(h.events.some(event => event.type === 'session/added' && event.session.sessionId === result.sessionId));
  assert.deepEqual(h.journals.get(result.sessionId), before.slice(0, 2));
});

test('fork locks the source while dispatching and never retries uncertain creation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = [user('first'), assistant('reply', 'reply-id')];
  const gate = deferred<{ sessionId: string }>();
  h.runtime.rpc.sessions.fork.mock.mockImplementation(() => gate.promise);
  const pending = h.engine.forkSession(s.id);
  while (!h.runtime.rpc.sessions.fork.mock.callCount()) await nextTurn();
  await assert.rejects(h.engine.prompt(s.id, 'must not send'), errorWithCode('SESSION_TRANSITION'));
  await assert.rejects(h.engine.forkSession(s.id), errorWithCode('SESSION_TRANSITION'));
  await assert.rejects(h.engine.unload(s.id), errorWithCode('SESSION_TRANSITION'));
  gate.reject(new Error('acknowledgement lost'));
  await assert.rejects(pending, /uncertain.*Do not retry blindly.*acknowledgement lost/);
  assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 1);
  assert.equal((await h.engine.getMeta(s.id))!.closing, false);
});

for (const condition of ['missing', 'assistant', 'nested', 'turn', 'tool', 'schedule', 'empty', 'expired'] as const) {
  test(`fork validates ${condition} history before native mutation`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.events = [user('first'), assistant('reply', 'reply-id')];
    let boundary: string | undefined = 'boundary';
    if (condition === 'assistant') boundary = 'reply';
    else if (condition === 'empty') boundary = 'first';
    else if (condition !== 'missing') {
      if (condition === 'turn') s.state.events.push(event('assistant.turn_start', { turnId: 'turn' }));
      if (condition === 'tool') s.state.events.push(event('tool.execution_start', { toolCallId: 'tool', toolName: 'view' }));
      if (condition === 'schedule') s.state.events.push(event('session.schedule_created', { id: 1, prompt: 'old timer', recurring: true, intervalMs: 60_000 }));
      const next = user('boundary');
      if (condition === 'nested') next.agentId = 'subagent';
      s.state.events.push(next);
    }
    if (condition === 'expired') s.rpc.eventLog.read.mock.mockImplementation(async () => ({
      events: [], cursor: 'expired', hasMore: false, cursorStatus: 'expired',
    }));
    await assert.rejects(h.engine.forkSession(s.id, boundary), condition === 'expired' ? /cursor expired/ : errorWithCode('INVALID_REQUEST'));
    assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 0);
  });
}

test('fork scans beyond one native page and permits a boundary before a stopped schedule', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = Array.from({ length: 1005 }, (_, i) => user(`user-${i}`));
  s.state.events.push(event('session.schedule_created', { id: 1, prompt: 'old timer', recurring: true, intervalMs: 60_000 }));
  await h.engine.forkSession(s.id, 'user-1004');
  assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 1);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 2);
  const reads = s.rpc.eventLog.read.mock.calls;
  assert.deepEqual(reads[1]!.arguments[0], {
    ...reads[0]!.arguments[0], cursor: (await reads[0]!.result!).cursor,
  }, 'Keep the same all-agent durable filter and pass the native cursor back unchanged');
  await assert.rejects(h.engine.forkSession(s.id), errorWithCode('INVALID_REQUEST'));
  assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 1);
});

test('fork structural reads preserve wildcard safety decisions across page and agent boundaries', async t => {
  const start = event('assistant.turn_start', { turnId: 'turn' });
  const end = event('assistant.turn_end', { turnId: 'turn' });
  const abort = event('abort', { reason: 'user_initiated' });
  const toolStart = event('tool.execution_start', { toolCallId: 'tool', toolName: 'view', arguments: { path: '/fixture' } });
  const toolEnd = event('tool.execution_complete', { toolCallId: 'tool', success: true, result: { content: 'fixture result' } });
  const agentData = { toolCallId: 'spawn', agentName: 'explore', agentDisplayName: 'Fixture' };
  const agentStart = event('subagent.started', { ...agentData, agentDescription: 'Fixture only' });
  const agentEnd = event('subagent.completed', agentData);
  const timer = event('session.schedule_created', { id: 1, prompt: 'fixture timer', selfPaced: true });
  const nested = (entry: SessionEvent): SessionEvent => ({ ...entry, agentId: 'child' });
  const boundary = user('boundary');
  const cases: { name: string; prefix: SessionEvent[]; allowed: boolean; boundary?: SessionEvent }[] = [
    { name: 'settled turn', prefix: [start, end], allowed: true },
    { name: 'unfinished turn', prefix: [start], allowed: false },
    { name: 'root abort settles turn', prefix: [start, abort], allowed: true },
    { name: 'child abort cannot settle root turn', prefix: [start, nested(abort)], allowed: false },
    { name: 'child turn end cannot settle root turn', prefix: [start, nested(end)], allowed: false },
    { name: 'completed tool', prefix: [toolStart, toolEnd], allowed: true },
    { name: 'unfinished tool survives root abort', prefix: [toolStart, abort], allowed: false },
    { name: 'nested unfinished tool', prefix: [nested(toolStart)], allowed: false },
    { name: 'nested completed tool', prefix: [nested(toolStart), nested(toolEnd)], allowed: true },
    { name: 'unfinished subagent', prefix: [agentStart], allowed: false },
    { name: 'completed subagent', prefix: [agentStart, agentEnd], allowed: true },
    { name: 'failed subagent', prefix: [agentStart, event('subagent.failed', { ...agentData, error: 'fixture' })], allowed: true },
    { name: 'cancelled subagent', prefix: [agentStart, event('subagent.completed', { ...agentData, cancelled: true })], allowed: true },
    { name: 'root abort cannot settle subagent', prefix: [agentStart, abort], allowed: false },
    { name: 'child abort cannot settle subagent', prefix: [agentStart, nested(abort)], allowed: false },
    { name: 'subagent completion cannot settle child tool', prefix: [agentStart, nested(toolStart), agentEnd], allowed: false },
    { name: 'nested spawn', prefix: [nested(agentStart)], allowed: false },
    { name: 'historical self-paced schedule', prefix: [timer], allowed: false },
    { name: 'stopped schedule', prefix: [timer, event('session.schedule_cancelled', { id: 1 })], allowed: false },
    { name: 'rearmed schedule', prefix: [timer, event('session.schedule_rearmed', { id: 1, nextRunAt: 1 })], allowed: false },
    { name: 'nested schedule', prefix: [nested(timer)], allowed: false },
    { name: 'exclusive settled boundary', prefix: [], allowed: true },
    { name: 'nested user boundary', prefix: [], boundary: nested(boundary), allowed: false },
    { name: 'legacy agent user boundary', prefix: [], boundary: { ...boundary, agentId: 'child' }, allowed: false },
    { name: 'legacy parent tool user boundary', prefix: [], boundary: { ...boundary, data: { ...boundary.data, parentToolCallId: 'spawn' } } as unknown as SessionEvent, allowed: false },
    { name: 'non-user structural boundary', prefix: [], boundary: { ...start, id: boundary.id }, allowed: false },
    { name: 'filtered assistant boundary', prefix: [], boundary: assistant(boundary.id, 'reply'), allowed: false },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const s = fakeSession(t, randomUUID());
      s.state.events = [user('first'), ...scenario.prefix.flatMap(entry => [
        assistant(randomUUID(), randomUUID()), entry,
      ]), scenario.boundary ?? boundary, start, timer];
      for (const wildcard of [true, false]) {
        // Force small native pages so pending state must survive continuation.
        const read: Rpc['eventLog']['read'] = options => s.rpc.eventLog.read({
          ...options, max: 2, ...(wildcard ? { types: '*' } : {}),
        });
        if (scenario.allowed) await validateForkHistory(read, boundary.id);
        else await assert.rejects(validateForkHistory(read, boundary.id), /unfinished|schedule|root user|not found/);
      }
    });
  }
  for (const marker of ['agentId', 'parentToolCallId'] as const) {
    const s = fakeSession(t, randomUUID());
    s.state.events = [{ ...user('nested-only'), data: { content: 'child', [marker]: 'child' } }];
    await assert.rejects(validateForkHistory(s.rpc.eventLog.read), /existing conversation history/);
  }
});

test('fork excludes unrelated bodies without turning required events into ID-only reads', async t => {
  const s = fakeSession(t, randomUUID());
  const largeBody = 'x'.repeat(1024);
  s.state.events = [
    user('first', largeBody),
    ...Array.from({ length: 9999 }, (_, i) => assistant(`reply-${i}`, `message-${i}`, largeBody)),
  ];
  const counts: { calls: number; events: number; bytes: number }[] = [];
  for (const wildcard of [true, false]) {
    const count = { calls: 0, events: 0, bytes: 0 };
    await validateForkHistory(async options => {
      const { cursor: _cursor, ...filter } = options;
      assert.deepEqual(filter, {
        direction: 'forward', max: 1000, agentScope: 'all', includeEphemeral: false,
        types: ['user.message', 'assistant.turn_start', 'assistant.turn_end', 'abort',
          'tool.execution_start', 'tool.execution_complete',
          'subagent.started', 'subagent.completed', 'subagent.failed', 'session.schedule_created'],
      });
      const page = await s.rpc.eventLog.read({ ...options, ...(wildcard ? { types: '*' } : {}) });
      count.calls++;
      count.events += page.events.length;
      count.bytes += Buffer.byteLength(JSON.stringify(page.events));
      if (!wildcard) assert.equal(page.events[0]?.type === 'user.message' && page.events[0].data.content, largeBody);
      return page;
    });
    counts.push(count);
  }
  assert.deepEqual(counts.map(({ calls, events }) => ({ calls, events })), [
    { calls: 10, events: 10000 }, { calls: 1, events: 1 },
  ]);
  assert.ok(counts[1]!.bytes < counts[0]!.bytes / 1000);
  t.diagnostic(`Synthetic fork eventLog.read counts (wildcard, structural): ${JSON.stringify(counts)}`);
});

for (const condition of ['expired', 'stalled', 'missing-cursor', 'read-failure'] as const) {
  test(`fork fails closed without retry on a ${condition} continuation`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.rpc.eventLog.read.mock.mockImplementation(async options => {
      if (!options.cursor) return {
        events: [user('first')], cursor: 'opaque-native-cursor', hasMore: true, cursorStatus: 'ok',
      };
      assert.equal(options.cursor, 'opaque-native-cursor');
      if (condition === 'read-failure') throw new Error('fixture read failed');
      return { events: [], cursor: condition === 'missing-cursor' ? '' : 'opaque-native-cursor',
        hasMore: true, cursorStatus: condition === 'expired' ? 'expired' : 'ok' };
    });
    await assert.rejects(h.engine.forkSession(s.id), /cursor|fixture read failed/);
    assert.equal(s.rpc.eventLog.read.mock.callCount(), 2);
    assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 0);
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
  });
}

test('fork does not retry or publish a child when native creation returns unverifiable metadata', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = [user('first')];
  h.runtime.rpc.sessions.fork.mock.mockImplementation(async () => ({ sessionId: 'unverifiable-child' }));
  await assert.rejects(h.engine.forkSession(s.id), /metadata is unavailable; do not retry/);
  assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 1);
  assert.ok(!h.events.some(event => event.type === 'session/added' && event.session.sessionId === 'unverifiable-child'));
});

for (const condition of ['running', 'task', 'queue', 'steering', 'timer', 'closed', 'fatal'] as const) {
  test(`fork freshly refuses ${condition} introduced during the history scan`, async t => {
    const h = harness(t);
    const s = await h.load();
    const gate = deferred<Awaited<ReturnType<Rpc['eventLog']['read']>>>();
    s.rpc.eventLog.read.mock.mockImplementationOnce(() => gate.promise);
    const pending = h.engine.forkSession(s.id);
    const rejected = assert.rejects(pending, /protected|timers|closed|fixture fatal/);
    while (!s.rpc.eventLog.read.mock.callCount()) await nextTurn();
    await assert.rejects(h.engine.prompt(s.id, 'must not send'), errorWithCode('SESSION_TRANSITION'));
    await assert.rejects(h.engine.unload(s.id), errorWithCode('SESSION_TRANSITION'));
    if (condition === 'running') s.state.processing = true;
    if (condition === 'task') s.state.tasks = [task()];
    if (condition === 'queue') s.state.queue.items = [queued('queued', 'new work')];
    if (condition === 'steering') {
      s.state.queue.steeringMessages = ['consumed steering'];
      s.state.queue.inFlightSteeringCount = 1;
    }
    if (condition === 'timer') s.state.schedules = [schedule()];
    if (condition === 'closed') h.runtime.expire(s.id, true);
    if (condition === 'fatal') h.runtime.emitFatal(new Error('fixture fatal'));
    gate.resolve({ events: [user('first')], cursor: 'tail', hasMore: false, cursorStatus: 'ok' });
    await rejected;
    assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1, 'Never resume to complete a preflight');
    assert.equal(s.sdk.abort.mock.callCount(), 0);
  });
}

for (const condition of ['running', 'task', 'queue', 'steering', 'timer', 'unloaded'] as const) {
  test(`fork refuses ${condition} source without mutation or implicit resume`, async t => {
    const h = harness(t);
    const s = condition === 'unloaded' ? await h.seed() : await h.load();
    s.state.events = [user('first'), assistant('reply', 'reply-id')];
    if (condition === 'running') s.state.processing = true;
    if (condition === 'task') s.state.tasks = [task()];
    if (condition === 'queue') s.state.queue.items = [queued('queued', 'old task')];
    if (condition === 'steering') {
      s.state.queue.steeringMessages = ['consumed steering'];
      s.state.queue.inFlightSteeringCount = 1;
    }
    if (condition === 'timer') s.state.schedules = [schedule()];
    await assert.rejects(h.engine.forkSession(s.id), errorWithCode(condition === 'unloaded' ? 'SESSION_UNLOADED' : 'SESSION_BUSY'));
    assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 0);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), condition === 'unloaded' ? 0 : 1);
  });
}
