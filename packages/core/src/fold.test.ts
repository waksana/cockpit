// Fixture-based unit tests for the fold — the single most intricate code and the
// shared replay/live seam. Run: `node --import tsx --test src/fold.test.ts`.
//
// The fold MUST produce identical results whether events arrive live (one by one,
// emitting on changed ids) or via replay (all at once). Several tests assert that
// equivalence directly, plus the specific regressions found in review (H1, M2, M3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFoldState, foldEvent, resetTurn, cleanSessionTitle } from './fold.ts';
import { normalizeEvent, type SdkEvent } from './sdk-types.ts';

type Ev = Omit<SdkEvent, 'data'> & { data?: SdkEvent['data'] };

// Replay: fold all events into a fresh state (mirrors loadSession getEvents()).
function replay(events: Ev[]) {
  const st = newFoldState();
  for (const ev of events) foldEvent(st, normalizeEvent({ ...ev, data: ev.data ?? {} }));
  return st;
}

// Live: fold events one by one, applying upserts to a client-side mirror keyed by
// id (mirrors engine.onLive → msg/upsert → store). Returns the client's view.
// `engineIntercepts` lists event types the engine handles WITHOUT calling fold
// (e.g. assistant.turn_start) — they are skipped here, matching production.
function live(events: Ev[], engineIntercepts: string[] = []) {
  const st = newFoldState();
  const client = new Map<string, unknown>();
  for (const ev of events) {
    if (engineIntercepts.includes(ev.type)) continue;
    const res = foldEvent(st, normalizeEvent({ ...ev, data: ev.data ?? {} }));
    for (const id of res.removed ?? []) client.delete(id);
    for (const id of res.changed) {
      const idx = st.byId.get(id);
      if (idx !== undefined) client.set(id, structuredClone(st.messages[idx]));
    }
  }
  return { st, client: new Map(st.messages.map(message => [message.id, client.get(message.id)])) };
}

const tStart = (i = 0): Ev => ({ type: 'assistant.turn_start', data: {}, id: `ts-${i}` });
const userMsg = (content: string, id: string): Ev => ({ type: 'user.message', data: { content }, id });
const asstMsg = (messageId: string, content: string, extra: Record<string, unknown> = {}): Ev =>
  ({ type: 'assistant.message', data: { messageId, content, ...extra }, id: messageId, parentId: 'ts-0' });

test('child execution evidence distinguishes cancellation and later activity without inferring a task outcome', () => {
  const state = newFoldState();
  const apply = (type: string, data: Record<string, unknown> = {}, agentId?: string) =>
    foldEvent(state, { type, data, agentId });
  apply('subagent.started', { toolCallId: 'spawn', agentId: 'child' });
  const info = () => state.messages[0].subagent!;
  assert.equal(info().status, 'running', 'only a real start establishes started evidence');
  apply('subagent.completed', { toolCallId: 'spawn' });
  assert.equal(info().status, 'completed');
  for (const type of ['assistant.turn_end', 'session.idle', 'abort']) apply(type);
  apply('assistant.message_delta', { messageId: 'late', deltaContent: 'late fragment' }, 'child');
  assert.equal(info().status, 'completed', 'parent boundaries and unqualified fragments are not a new child execution');
  const changed = apply('assistant.turn_start', { turnId: '0' }, 'child');
  assert.equal(info().status, 'activity');
  assert.deepEqual(changed.changed, ['subagent-spawn']);
  apply('assistant.message', { messageId: 'tool-owner', content: '', toolRequests: [{ toolCallId: 'view', name: 'view' }] }, 'child');
  apply('tool.execution_complete', { toolCallId: 'view', success: false, error: { message: 'Missing input' } }, 'child');
  assert.equal(info().status, 'activity', 'a child tool failure does not fail the child');
  apply('subagent.failed', { toolCallId: 'spawn', error: 'Execution failed' });
  assert.equal(info().status, 'failed');
  apply('user.message', { content: 'Continue', source: 'agent-parent' }, 'child');
  assert.equal(info().status, 'activity');
  assert.equal(info().error, undefined, 'old execution error does not describe the follow-up');
  apply('subagent.completed', { toolCallId: 'spawn', cancelled: true });
  assert.equal(info().status, 'cancelled');
  assert.equal(info().error, undefined);
});

test('existing child message, reasoning and tool events supersede old terminal evidence', () => {
  for (const [type, data] of [
    ['assistant.message', { messageId: 'followup', content: 'New reply' }],
    ['assistant.reasoning', { reasoningId: 'thought', content: 'New reasoning' }],
    ['assistant.turn_end', { turnId: '0' }],
    ['tool.execution_start', { toolCallId: 'tool', toolName: 'view' }],
  ] as const) {
    const events: Ev[] = [
      { type: 'subagent.started', timestamp: '2026-09-11T12:00:00Z', data: { toolCallId: 'spawn', agentId: 'child' } },
      { type: 'subagent.completed', timestamp: '2026-09-11T12:00:01Z', data: { toolCallId: 'spawn' } },
      { type, timestamp: '2026-09-11T12:00:02Z', agentId: 'child', data },
    ];
    const state = replay(events);
    assert.equal(state.messages[0].subagent?.status, 'activity', type);
    assert.deepEqual([...live(events).client.values()], state.messages);
  }
});

test('user + assistant message fold', () => {
  const evs = [tStart(), userMsg('hi', 'u1'), asstMsg('a1', 'hello')];
  const st = replay(evs);
  assert.equal(st.messages.length, 2);
  assert.equal(st.messages[0].role, 'user');
  assert.equal(st.messages[1].content, 'hello');
});

test('dedicated hidden tools index their starts, never ordinary assistant request rows', () => {
  for (const name of ['skill', 'exit_plan_mode', 'task']) {
    const state = newFoldState();
    const owner = asstMsg('hidden-owner', '', { toolRequests: [{ toolCallId: 'hidden', name }] });
    foldEvent(state, normalizeEvent({ ...owner, data: owner.data ?? {} }), { strictOwnership: true });
    assert.equal(state.toolMsg.get('hidden'), undefined);
    assert.equal(state.messages.length, 0);
    for (const type of ['tool.execution_start', 'tool.execution_complete']) {
      const result = foldEvent(state, normalizeEvent({
        type, data: { toolCallId: 'hidden', toolName: name, success: true },
      }), { strictOwnership: true });
      assert.notEqual(result.missingOwner, true);
      assert.deepEqual(result.changed, []);
    }
    assert.equal(state.toolMsg.get('hidden'), '');
    assert.equal(state.messages.length, 0);
  }
});

test('history summary folding keeps canonical lifecycle metadata without hydrating child messages', () => {
  const state = newFoldState();
  const events: Ev[] = [
    userMsg('Root', 'u'),
    asstMsg('spawn', '', { toolRequests: [
      { toolCallId: 'outer', name: 'task', arguments: { prompt: 'Private spawn', description: 'Task' } },
    ] }),
    { type: 'subagent.started', data: { toolCallId: 'outer', agentId: 'native-child' } },
    { ...asstMsg('child', 'Private child', { reasoningText: 'Private thought', toolRequests: [
      { toolCallId: 'inner', name: 'task', arguments: { prompt: 'Private nested spawn' } },
    ] }), agentId: 'native-child' },
    { type: 'subagent.started', agentId: 'nested-agent', data: { toolCallId: 'inner' } },
    { ...asstMsg('nested', 'Private nested child'), agentId: 'nested-agent' },
    { type: 'subagent.completed', data: { toolCallId: 'outer', totalToolCalls: 9 } },
  ];
  for (const event of events) {
    foldEvent(state, normalizeEvent({ ...event, data: event.data ?? {} }), { scope: { details: 'summary' } });
  }
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1]?.subMessages, undefined);
  assert.equal(state.messages[1]?.subagent?.prompt, undefined);
  assert.equal(state.messages[1]?.subagent?.toolCount, 9);
  assert.equal(state.messages[1]?.subagent?.status, 'completed');
  const child = state.subFolds.get('outer')!;
  assert.ok(child.agentIds.has('native-child'));
  assert.deepEqual(child.messages.map(message => message.id), ['subagent-inner']);
  assert.deepEqual(child.subFolds.get('inner')!.messages, []);
  assert.ok(!JSON.stringify([...state.pendingTask.values(), ...child.pendingTask.values()]).includes('Private'));
});

test('streaming deltas accumulate into one message', () => {
  const evs: Ev[] = [
    tStart(),
    { type: 'assistant.message_start', data: { messageId: 'a1' } },
    { type: 'assistant.message_delta', data: { messageId: 'a1', deltaContent: 'foo' } },
    { type: 'assistant.message_delta', data: { messageId: 'a1', deltaContent: 'bar' } },
    asstMsg('a1', 'foobar'),
  ];
  const st = replay(evs);
  assert.equal(st.messages.length, 1);
  assert.equal(st.messages[0].content, 'foobar');
});

test('response-local body and thought retain their position beside independent tool starts', () => {
  const st = newFoldState();
  const apply = (type: string, data: Record<string, unknown>) => foldEvent(st, { type, data, timestamp: 1, parentId: 'turn' });
  apply('tool.execution_start', { toolCallId: 't1', toolName: 'view' });
  foldEvent(st, { type: 'assistant.turn_start', id: 'turn', data: {} });
  apply('assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Partial' });
  apply('assistant.message_start', { messageId: 'm' });
  assert.deepEqual(st.messages.map(item => item.id), ['tool-t1', 'm']);
  apply('assistant.message_delta', { messageId: 'm', deltaContent: 'Draft' });
  assert.equal(st.messages[1].thought, 'Partial');
  apply('assistant.message', { messageId: 'm', content: 'Answer', reasoningText: 'Complete' });
  apply('tool.execution_start', { toolCallId: 't2', toolName: 'view' });
  apply('assistant.message', { messageId: 'm', content: 'Updated', reasoningText: 'Different intact snapshot' });
  apply('tool.execution_complete', { toolCallId: 't2', success: true, result: { content: 'Output' } });
  assert.deepEqual(st.messages.map(item => item.id), ['tool-t1', 'm', 'tool-t2']);
  assert.equal(st.messages[2]?.toolCalls?.[0]?.output, 'Output');
  assert.equal(st.messages[1]?.content, 'Updated');
  assert.equal(st.messages[1]?.thought, 'Different intact snapshot');
});

test('reasoning keeps its own native identity before the following body', () => {
  const evs: Ev[] = [
    tStart(),
    { type: 'assistant.reasoning', data: { reasoningId: 'r1', content: 'thinking…' } },
    asstMsg('a1', 'answer'),
  ];
  const st = replay(evs);
  assert.equal(st.messages.length, 2);
  assert.equal(st.messages[0].thought, 'thinking…');
  assert.equal(st.messages[0].id, 'reasoning-r1');
  assert.equal(st.messages[0].content, '');
  assert.equal(st.messages[1].content, 'answer');
  assert.equal(st.messages[1].thought, undefined);
});

test('equal explicit text never retires or reanchors an existing durable message snapshot', () => {
  const st = newFoldState();
  const events = [
    { type: 'assistant.reasoning', data: { reasoningId: 'r', content: 'A' } },
    asstMsg('m', 'Other body'),
    asstMsg('n', 'Body', { reasoningText: 'B' }),
    { type: 'assistant.reasoning', data: { reasoningId: 'r', content: 'B' } },
    asstMsg('n', 'Body', { reasoningText: 'B' }),
    asstMsg('n', 'Body', { reasoningText: 'C' }),
  ];
  for (const [index, event] of events.entries()) {
    const before = st.messages.map(item => item.id);
    const result = foldEvent(st, normalizeEvent({ ...event, data: event.data ?? {}, id: `unique-${index}`, timestamp: 1 }));
    assert.deepEqual(result.removed ?? [], []);
    assert.deepEqual(st.messages.filter(item => before.includes(item.id)).map(item => item.id), before);
    if (index >= 2) {
      assert.deepEqual(st.messages.map(item => item.id), ['reasoning-r', 'm', 'n']);
      assert.equal(st.messages[2]?.thought, index === 5 ? 'C' : 'B');
    }
  }
});

// --- H1: cancel mid-stream must not merge the next turn into the cancelled one ---
test('H1: cancelled turn does not absorb the next turn (live == replay)', () => {
  // Turn 1 starts streaming but is CANCELLED (no final assistant.message), then
  // turn 2 runs to completion. The FIXED engine folds turn_start on live (it no
  // longer intercepts it), so live must reach the same result as replay.
  const evs: Ev[] = [
    tStart(0),
    { type: 'assistant.message_start', data: { messageId: 'a1' } },
    { type: 'assistant.message_delta', data: { messageId: 'a1', deltaContent: 'partial…' } },
    // (cancel happens here — no final assistant.message for a1)
    tStart(1),
    asstMsg('a2', 'second turn answer'),
  ];
  const replayed = replay(evs);
  const { st: liveSt } = live(evs); // fixed engine folds turn_start (no intercept)

  // Replay yields TWO messages (cancelled partial + the real second turn).
  assert.equal(replayed.messages.length, 2, 'replay: two separate turns');
  assert.deepEqual(replayed.messages.map(message => [message.id, message.content]), [
    ['a1', 'partial…'], ['a2', 'second turn answer'],
  ]);

  // Live MUST match replay — the second turn must be its own message, not merged
  // into the cancelled a1 bubble.
  assert.equal(liveSt.messages.length, replayed.messages.length, 'live must equal replay');
  const liveSecond = liveSt.messages.find((m) => m.content === 'second turn answer');
  assert.ok(liveSecond, 'second turn is its own message in live');
  assert.notEqual(liveSt.messages[0].content, 'partial…second turn answer', 'not merged into cancelled bubble');
});

// --- H1b: explicit cancel via resetTurn (mirrors engine.cancel) also separates turns ---
test('H1b: resetTurn after a cancelled stream separates the next turn', () => {
  const st = newFoldState();
  for (const ev of [
    tStart(0),
    { type: 'assistant.message_start', data: { messageId: 'a1' } } as Ev,
    { type: 'assistant.message_delta', data: { messageId: 'a1', deltaContent: 'partial…' } } as Ev,
  ]) foldEvent(st, ev as never);
  // engine.cancel() calls resetTurn(st.fold)
  resetTurn(st);
  // next turn arrives WITHOUT a turn_start (e.g. immediate new prompt after cancel)
  foldEvent(st, asstMsg('a2', 'after cancel') as never);
  assert.equal(st.messages.length, 2, 'cancelled partial + new turn are separate');
  assert.deepEqual(st.messages.map(message => [message.id, message.content]), [
    ['a1', 'partial…'], ['a2', 'after cancel'],
  ]);
});

// --- M2: multiple reasoning blocks in one turn must not be lost ---
test('M2: multiple reasoning segments are preserved', () => {
  const evs: Ev[] = [
    tStart(),
    { type: 'assistant.reasoning', data: { reasoningId: 'r1', content: 'first thought' } },
    { type: 'assistant.reasoning', data: { reasoningId: 'r2', content: 'second thought' } },
    asstMsg('a1', 'answer'),
  ];
  const st = replay(evs);
  assert.equal(st.messages.length, 3);
  // Both reasoning segments should survive (not just the last).
  assert.match(st.messages[0].thought ?? '', /first thought/);
  assert.match(st.messages[1].thought ?? '', /second thought/);
  assert.deepEqual(st.messages.map(message => message.id), ['reasoning-r1', 'reasoning-r2', 'a1']);
});

// ── D1: streaming reasoning survives reload (live == replay) ──────────────────
// Real native full reasoning is ephemeral and follows its durable message.

// The live store projection in first-upsert (insertion) order.
function liveProjection(events: Ev[]) {
  return [...live(events).client.values()] as Array<Record<string, unknown>>;
}

test('D1: streaming reasoning survives reload — thought rebuilt from reasoningText', () => {
  const reasoningText = 'Let me think hard.';
  // Live: reasoning streams before the message, then the final message lands.
  const liveEvs: Ev[] = [
    tStart(),
    { type: 'assistant.reasoning_delta', parentId: 'ts-0', data: { reasoningId: 'r1', deltaContent: 'Let me think ' } },
    { type: 'assistant.message_start', parentId: 'ts-0', data: { messageId: 'a1' } },
    { type: 'assistant.message_delta', data: { messageId: 'a1', deltaContent: 'The answer.' } },
    asstMsg('a1', 'The answer.', { reasoningText }),
    { type: 'assistant.reasoning', parentId: 'a1', ephemeral: true, data: { reasoningId: 'r1', content: reasoningText } },
  ];
  // Replay: getEvents() has only turn_start + the final message (with reasoningText).
  const replayEvs: Ev[] = [tStart(), asstMsg('a1', 'The answer.', { reasoningText })];

  const replayed = replay(replayEvs);
  assert.equal(replayed.messages.length, 1);
  // The headline assertion — fails today, passes with the reasoningText fallback.
  assert.equal(replayed.messages[0].thought, reasoningText);
  assert.equal(replayed.messages[0].id, 'a1');
  assert.equal(replayed.messages[0].content, 'The answer.');

  // Live carries the same thought, accumulated from the streamed reasoning.
  const liveMsgs = liveProjection(liveEvs);
  assert.equal(liveMsgs.length, 1);
  assert.equal(liveMsgs[0].thought, reasoningText);
  assert.equal(liveMsgs[0].content, 'The answer.');

  // Live and replay share the canonical anchor, not only visible text.
  assert.equal(liveMsgs[0].id, replayed.messages[0].id);
  assert.equal(liveMsgs[0].thought, replayed.messages[0].thought);
  assert.equal(liveMsgs[0].content, replayed.messages[0].content);
});

test('D1: pure streaming (no reasoning) reloads identically — regression lock', () => {
  const evs: Ev[] = [
    tStart(),
    { type: 'assistant.message_start', data: { messageId: 'a1' } },
    { type: 'assistant.message_delta', data: { messageId: 'a1', deltaContent: 'Hel' } },
    { type: 'assistant.message_delta', data: { messageId: 'a1', deltaContent: 'lo' } },
    asstMsg('a1', 'Hello'),
  ];
  const replayEvs: Ev[] = [tStart(), asstMsg('a1', 'Hello')];

  const replayed = replay(replayEvs);
  const liveMsgs = liveProjection(evs);

  assert.equal(replayed.messages.length, 1);
  assert.equal(liveMsgs.length, 1);
  // No reasoning anywhere → no thought on either side, content matches.
  assert.equal(replayed.messages[0].content, 'Hello');
  assert.equal(liveMsgs[0].content, 'Hello');
  assert.equal(replayed.messages[0].thought, undefined);
  assert.equal(liveMsgs[0].thought, undefined);
  // Same id here (no reasoning placeholder), so the whole projection matches.
  assert.equal(liveMsgs[0].id, replayed.messages[0].id);
});

test('D1: multi-segment reasoning reload — combined reasoningText rebuilds the thought', () => {
  const combined = 'first thought\n\nsecond thought';
  const liveEvs: Ev[] = [
    tStart(),
    { type: 'assistant.reasoning_delta', parentId: 'ts-0', data: { reasoningId: 'r1', deltaContent: 'first thought' } },
    { type: 'assistant.reasoning_delta', parentId: 'ts-0', data: { reasoningId: 'r1', deltaContent: '\n\nsecond thought' } },
    asstMsg('a1', 'done', { reasoningText: combined }),
  ];
  // Replay: only the final message, carrying the SDK's combined reasoningText.
  const replayEvs: Ev[] = [tStart(), asstMsg('a1', 'done', { reasoningText: combined })];

  const replayed = replay(replayEvs);
  assert.equal(replayed.messages.length, 1);
  // Both segments present after reload.
  assert.match(replayed.messages[0].thought ?? '', /first thought/);
  assert.match(replayed.messages[0].thought ?? '', /second thought/);

  const liveMsgs = liveProjection(liveEvs);
  assert.equal(liveMsgs.length, 1);
  assert.match(String(liveMsgs[0].thought ?? ''), /first thought/);
  assert.match(String(liveMsgs[0].thought ?? ''), /second thought/);
  // live == replay on the rebuilt thought.
  assert.equal(liveMsgs[0].thought, replayed.messages[0].thought);
});

test('D1: sub-agent streaming reload — inner thought rebuilt inside the card', () => {
  const A = 'taskA';
  const innerThought = 'inner thinking';
  // Live: the inner sub-agent streams reasoning + content before its final message.
  const liveEvs: Ev[] = [
    tStart(),
    { type: 'assistant.message', data: { messageId: 'a1', content: '', toolRequests: [
      { toolCallId: A, name: 'task', arguments: { agent_type: 'explore', prompt: 'do X' } },
    ] }, id: 'a1' },
    { type: 'subagent.started', agentId: A, data: { toolCallId: A, agentName: 'explore', agentDisplayName: 'Explore' } },
    { type: 'assistant.turn_start', agentId: A, id: 'child-turn', data: {} },
    { type: 'assistant.reasoning_delta', agentId: A, parentId: 'child-turn', data: { reasoningId: 'ir1', deltaContent: 'inner ' } },
    { type: 'assistant.message_start', agentId: A, parentId: 'child-turn', data: { messageId: 'sa1' } },
    { type: 'assistant.message_delta', agentId: A, data: { messageId: 'sa1', deltaContent: 'inner ans' } },
    { type: 'assistant.message', agentId: A, parentId: 'child-turn', data: { messageId: 'sa1', content: 'inner ans', reasoningText: innerThought }, id: 'sa1' },
    { type: 'subagent.completed', agentId: A, data: { toolCallId: A, agentDisplayName: 'Explore', totalToolCalls: 0 } },
  ];
  // Replay: no inner reasoning/streaming events — only the final inner message
  // (with reasoningText) nested under the card.
  const replayEvs: Ev[] = [
    tStart(),
    { type: 'assistant.message', data: { messageId: 'a1', content: '', toolRequests: [
      { toolCallId: A, name: 'task', arguments: { agent_type: 'explore', prompt: 'do X' } },
    ] }, id: 'a1' },
    { type: 'subagent.started', agentId: A, data: { toolCallId: A, agentName: 'explore', agentDisplayName: 'Explore' } },
    { type: 'assistant.message', agentId: A, data: { messageId: 'sa1', content: 'inner ans', reasoningText: innerThought }, id: 'sa1' },
    { type: 'subagent.completed', agentId: A, data: { toolCallId: A, agentDisplayName: 'Explore', totalToolCalls: 0 } },
  ];

  const replayed = replay(replayEvs);
  const card = replayed.messages.find((m) => m.subtype === 'subagent');
  assert.ok(card, 'sub-agent card exists on replay');
  const innerReplay = card!.subMessages ?? [];
  assert.equal(innerReplay.length, 1);
  // Fails today (inner thought dropped); passes with the reasoningText fallback.
  assert.equal(innerReplay[0].thought, innerThought);
  assert.equal(innerReplay[0].content, 'inner ans');

  // Live rebuilds the same inner thought from the streamed reasoning.
  const { st: liveSt } = live(liveEvs);
  const liveCard = liveSt.messages.find((m) => m.subtype === 'subagent');
  assert.ok(liveCard, 'sub-agent card exists live');
  const innerLive = liveCard!.subMessages ?? [];
  assert.equal(innerLive.length, 1);
  assert.equal(innerLive[0].thought, innerThought);
  assert.equal(innerLive[0].content, 'inner ans');
  assert.equal(innerLive[0].id, innerReplay[0].id);
});

// --- tool calls ---
test('tool call args + output captured; status transitions', () => {
  const evs: Ev[] = [
    tStart(),
    { type: 'assistant.message', data: { messageId: 'a1', content: '', toolRequests: [
      { toolCallId: 't1', name: 'bash', intentionSummary: 'list files', arguments: { command: 'ls' } },
    ] }, id: 'a1' },
    { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'bash', intentionSummary: 'list files', arguments: { command: 'ls' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 't1', success: true, result: { content: 'file1\nfile2' } } },
  ];
  const st = replay(evs);
  const tc = st.messages[0].toolCalls?.[0];
  assert.ok(tc);
  assert.equal(tc!.title, 'list files');
  assert.equal(tc!.name, 'bash');
  assert.equal(tc!.args, '$ ls');
  assert.equal(tc!.output, 'file1\nfile2');
  assert.equal(tc!.status, 'completed');
});

test('ask_user reply surfaces as a user bubble (prefix stripped)', () => {
  const evs: Ev[] = [
    tStart(),
    { type: 'assistant.message', data: { messageId: 'a1', content: '', toolRequests: [
      { toolCallId: 'ask1', name: 'ask_user', arguments: { question: 'Q?' } },
    ] }, id: 'a1' },
    { type: 'tool.execution_start', data: { toolCallId: 'ask1', toolName: 'ask_user', arguments: { question: 'Q?' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'ask1', success: true, result: { content: 'User responded: my answer' } } },
  ];
  const st = replay(evs);
  const reply = st.messages.find((m) => m.subtype === 'ask-reply');
  assert.ok(reply, 'ask-reply message exists');
  assert.equal(reply!.role, 'user');
  assert.equal(reply!.content, 'my answer');
});

test('errors/warnings fold into system messages with level', () => {
  const evs: Ev[] = [
    { type: 'session.warning', data: { message: 'heads up' }, id: 'w1' },
    { type: 'session.error', data: { message: 'boom' }, id: 'e1' },
  ];
  const st = replay(evs);
  assert.equal(st.messages.find((m) => m.id === 'w1')?.level, 'warning');
  assert.equal(st.messages.find((m) => m.id === 'e1')?.level, 'error');
});

// --- sub-agents ---
test('single sub-agent: internal work nests in the card, off the main thread', () => {
  const A = 'taskA';
  const evs: Ev[] = [
    tStart(),
    { type: 'assistant.message', data: { messageId: 'a1', content: '', toolRequests: [
      { toolCallId: A, name: 'task', arguments: { agent_type: 'explore', prompt: 'do X', description: 'sub' } },
    ] }, id: 'a1' },
    { type: 'subagent.started', agentId: A, data: { toolCallId: A, agentName: 'explore', agentDisplayName: 'Explore' } },
    // sub-agent internal work (agentId = A)
    { type: 'assistant.message', agentId: A, data: { messageId: 'sa1', content: 'inner', toolRequests: [
      { toolCallId: 'st1', name: 'bash', intentionSummary: 'inner cmd', arguments: { command: 'echo hi' } },
    ] }, id: 'sa1' },
    { type: 'tool.execution_complete', agentId: A, data: { toolCallId: 'st1', success: true, result: { content: 'hi' } } },
    { type: 'subagent.completed', agentId: A, data: { toolCallId: A, agentDisplayName: 'Explore', totalToolCalls: 1 } },
  ];
  const st = replay(evs);
  // No `task` row in the main thread; one sub-agent card instead.
  const cards = st.messages.filter((m) => m.subtype === 'subagent');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].subagent?.status, 'completed');
  assert.equal(cards[0].subagent?.toolCount, 1);
  assert.equal(cards[0].subagent?.prompt, 'do X');
  // The inner bash tool is inside the card, NOT in the main thread.
  const mainTools = st.messages.filter((m) => m.subtype !== 'subagent').flatMap((m) => m.toolCalls ?? []);
  assert.equal(mainTools.length, 0, 'sub-agent tools not on main thread');
  const innerTools = (cards[0].subMessages ?? []).flatMap((m) => m.toolCalls ?? []);
  assert.equal(innerTools.length, 1, 'inner tool nested in card');
});

// --- M3: depth-2 nesting — inner sub-agent nests inside the outer card ---
test('M3: depth-2 sub-agent nests in the outer card (not a top-level sibling)', () => {
  const OUTER = 'taskOuter';
  const INNER = 'taskInner';
  const evs: Ev[] = [
    tStart(),
    { type: 'assistant.message', data: { messageId: 'a1', content: '', toolRequests: [
      { toolCallId: OUTER, name: 'task', arguments: { agent_type: 'general-purpose', prompt: 'outer' } },
    ] }, id: 'a1' },
    { type: 'subagent.started', agentId: OUTER, data: { toolCallId: OUTER, agentDisplayName: 'Outer' } },
    // OUTER spawns INNER (this task call is OUTER's work → agentId = OUTER)
    { type: 'assistant.message', agentId: OUTER, data: { messageId: 'sa1', content: '', toolRequests: [
      { toolCallId: INNER, name: 'task', arguments: { agent_type: 'general-purpose', prompt: 'inner' } },
    ] }, id: 'sa1' },
    // INNER's started carries agentId = INNER (its own id), per real SDK behavior
    { type: 'subagent.started', agentId: INNER, data: { toolCallId: INNER, agentDisplayName: 'Inner' } },
    { type: 'assistant.message', agentId: INNER, data: { messageId: 'ia1', content: 'innermost result' }, id: 'ia1' },
    { type: 'subagent.completed', agentId: INNER, data: { toolCallId: INNER, agentDisplayName: 'Inner', totalToolCalls: 0 } },
    { type: 'subagent.completed', agentId: OUTER, data: { toolCallId: OUTER, agentDisplayName: 'Outer', totalToolCalls: 0 } },
  ];
  const st = replay(evs);
  const topCards = st.messages.filter((m) => m.subtype === 'subagent');
  // Only OUTER is a top-level card; INNER must be nested inside it.
  assert.equal(topCards.length, 1, 'only the outer card is top-level');
  assert.equal(topCards[0].subagent?.displayName, 'Outer');
  const innerCards = (topCards[0].subMessages ?? []).filter((m) => m.subtype === 'subagent');
  assert.equal(innerCards.length, 1, 'inner card nested inside outer');
  assert.equal(innerCards[0].subagent?.displayName, 'Inner');
});

// ── Skill activation (CLI-style pill) ─────────────────────────────────────────

test('skill.invoked folds to a compact skill pill', () => {
  const evs: Ev[] = [
    tStart(),
    userMsg('do a thing', 'u1'),
    { type: 'skill.invoked', data: { name: 'skill-creator', path: '/x/SKILL.md' }, id: 'sk1' },
  ];
  const st = replay(evs);
  const pill = st.messages.find((m) => m.subtype === 'skill');
  assert.ok(pill, 'a skill pill exists');
  assert.equal(pill!.role, 'system');
  assert.equal(pill!.content, 'skill-creator');
});

test('skill-context injection (user.message source=skill-*) is suppressed', () => {
  const evs: Ev[] = [
    tStart(),
    // The SDK injects the whole SKILL.md as a user.message with a skill source.
    { type: 'user.message', data: { content: '<skill-context>…huge…</skill-context>', source: 'skill-skill-creator' }, id: 'inj1' },
    asstMsg('a1', 'ok'),
  ];
  const st = replay(evs);
  // No user bubble for the injection; only the assistant message remains.
  assert.equal(st.messages.filter((m) => m.role === 'user').length, 0);
  assert.equal(st.messages.filter((m) => m.role === 'assistant').length, 1);
});

test('a real user message (no source) is NOT suppressed', () => {
  const st = replay([tStart(), { type: 'user.message', data: { content: 'hello', source: null }, id: 'u1' }]);
  assert.equal(st.messages.filter((m) => m.role === 'user').length, 1);
});

test('a plain user message with no marker keeps its content + no attachment', () => {
  const st = replay([tStart(), userMsg('just text', 'u1')]);
  const m = st.messages.find((x) => x.role === 'user');
  assert.equal(m!.content, 'just text');
  assert.equal('attachment' in m!, false);
});

test('module-owned markers stay original text until a renderer is installed', () => {
  const content = '<cockpit-attachment kind="file" url="/uploads/retained" name="old"/>\nOriginal caption';
  const state = replay([
    { type: 'user.message', id: 'native-user', data: { content } },
    asstMsg('native-assistant', content),
  ]);
  assert.equal(state.messages[0]?.content, content);
  assert.equal(state.messages[1]?.content, content);
  assert.ok(state.messages.every(message => !('attachment' in message) && !('parts' in message)));
});

test('cleanSessionTitle: a normal first message passes through (first line only)', () => {
  assert.equal(cleanSessionTitle('帮我重建账本\n第二行细节'), '帮我重建账本');
});

test('cleanSessionTitle: empty/whitespace → empty (so caller can fall back)', () => {
  assert.equal(cleanSessionTitle(''), '');
  assert.equal(cleanSessionTitle('   \n  '), '');
  assert.equal(cleanSessionTitle(undefined), '');
});
