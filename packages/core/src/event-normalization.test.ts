import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent } from '@github/copilot-sdk';
import type { ChatMessage } from '@cockpit/protocol';
import { normalizeEvent, type SdkEvent } from './sdk-types.ts';
import { foldEvent, newFoldState } from './fold.ts';

const timestamp = '2026-09-07T14:20:00.919Z';
let sequence = 0;
function native<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  envelope: Partial<Pick<SessionEvent, 'id' | 'timestamp' | 'parentId' | 'agentId' | 'ephemeral'>> = {},
): SessionEvent {
  return { type, data, id: `event-${++sequence}`, timestamp, parentId: null, ...envelope } as SessionEvent;
}

function fold(events: Array<SessionEvent | SdkEvent>) {
  const state = newFoldState();
  const client = new Map<string, ChatMessage>();
  for (const event of events) {
    const result = foldEvent(state, normalizeEvent(event));
    for (const id of result.removed ?? []) {
      assert.equal(state.byId.has(id), false, `removed ID ${id} no longer exists`);
      client.delete(id);
    }
    for (const id of result.changed) {
      const index = state.byId.get(id);
      assert.notEqual(index, undefined, `changed ID ${id} exists`);
      client.set(id, structuredClone(state.messages[index!])!);
    }
  }
  return { state, client: new Map(state.messages.map(message => [message.id, client.get(message.id)!])) };
}

const started = (toolCallId: string, agentId: string, parentId?: string) => native('subagent.started', {
  toolCallId, agentName: 'explore', agentDisplayName: agentId, agentDescription: 'Inspect synthetic data',
  agentType: 'explore', executionMode: 'background', model: 'test-model', ...(parentId ? { parentId } : {}),
}, { agentId });

test('normalization preserves native envelopes, payloads and opaque IDs without mutation', () => {
  const event = native('assistant.message', {
    messageId: 'assistant-anchor', content: 'answer', parentToolCallId: 'spawn-call',
    reasoningText: 'thought', reasoningOpaque: 'opaque',
    reasoningBlocks: { provider: 'test', blocks: [{ type: 'thinking', text: 'thought' }] },
    toolRequests: [{ toolCallId: 'tool', name: 'view', arguments: { path: '/synthetic/input' } }],
  }, { id: 'journal-event', parentId: 'previous-journal-event', agentId: 'registry-agent' });
  Object.freeze(event.data);
  Object.freeze(event);
  const normalized = normalizeEvent(event);
  assert.deepEqual(normalized, event);
  assert.equal(normalized.id, 'journal-event');
  assert.equal(normalized.data.messageId, 'assistant-anchor');
  assert.equal(normalized.parentId, 'previous-journal-event');
  assert.equal(normalized.agentId, 'registry-agent');
  assert.equal(normalized.data.parentToolCallId, 'spawn-call');
  assert.equal(normalized.timestamp, timestamp);
  assert.deepEqual(normalizeEvent(normalized), normalized);
});

test('all native delta shapes survive normalization unchanged', () => {
  const events = [
    native('assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'think' }, { ephemeral: true }),
    native('assistant.message_delta', { messageId: 'm', deltaContent: 'text', parentToolCallId: 'task' }, { ephemeral: true }),
    native('assistant.tool_call_delta', { toolCallId: 't', toolName: 'view', inputDelta: '{"path":' }, { ephemeral: true }),
    native('assistant.streaming_delta', { totalResponseSizeBytes: 42 }, { ephemeral: true }),
    native('tool.execution_partial_result', { toolCallId: 't', partialOutput: 'partial' }, { ephemeral: true }),
    native('tool.execution_progress', { toolCallId: 't', progressMessage: 'working' }, { ephemeral: true }),
  ];
  for (const event of events) assert.deepEqual(normalizeEvent(event), event);
});

test('structured native content is preserved rather than coerced to chat text', () => {
  const event = native('elicitation.completed', {
    requestId: 'elicitation', action: 'accept', content: { confirmed: true, name: 'synthetic' },
  }, { ephemeral: true });
  assert.deepEqual(normalizeEvent(event), event);
  assert.equal(fold([event]).state.messages.length, 0);
});

test('structural old journals retain numeric timestamps and legacy top-level ownership', () => {
  const event: SdkEvent = {
    type: 'assistant.message', data: { messageId: 'old-message', content: 'old' },
    timestamp: 1234, parentToolCallId: 'old-task',
  };
  assert.deepEqual(normalizeEvent(event), event);
  const { state } = fold([
    { type: 'subagent.started', data: { toolCallId: 'old-task' }, timestamp: 1200 }, event,
  ]);
  assert.equal(state.messages[0]?.subMessages?.[0]?.timestamp, 1234);
  assert.equal(state.messages[0]?.subMessages?.[0]?.id, 'old-message');
});

test('native user anchors and original text survive without interpreting module attachment markers', () => {
  const marker = '<cockpit-attachment kind="image" name="a%20b.png" url="/uploads/synthetic.png" size="123"/>';
  const { state } = fold([native('user.message', {
    messageId: 'accepted-send-id', content: `${marker}\nagent guidance`,
    transformedContent: 'do not display', attachments: [{ type: 'file', path: '/synthetic/image', displayName: 'a b.png' }],
  }, { id: 'user-journal-id' })]);
  assert.equal(state.messages[0]?.id, 'user-journal-id');
  assert.equal(state.messages[0]?.timestamp, Date.parse(timestamp));
  assert.equal(state.messages[0]?.content, `${marker}\nagent guidance`);
  assert.equal('attachment' in state.messages[0]!, false);
});

for (const withStart of [true, false]) {
  test(`native reasoning/text live and durable folds have identical IDs and upserts (start=${withStart})`, () => {
    const user = native('user.message', { content: 'question', messageId: 'accepted' }, { id: 'u' });
    const reasoning = native('assistant.reasoning', { reasoningId: 'r', content: 'complete thought' });
    const final = native('assistant.message', {
      messageId: 'answer-id', content: 'answer', reasoningText: 'complete thought',
    }, { id: 'answer-event-id', parentId: 'reasoning-event' });
    const stream = fold([
      user,
      native('assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'complete ' }, { ephemeral: true }),
      reasoning,
      ...(withStart ? [native('assistant.message_start', { messageId: 'answer-id' }, { ephemeral: true })] : []),
      native('assistant.message_delta', { messageId: 'answer-id', deltaContent: 'ans' }, { ephemeral: true }),
      native('assistant.message_delta', { messageId: 'answer-id', deltaContent: 'wer' }, { ephemeral: true }),
      final,
    ]);
    for (const persisted of [[user, reasoning, final]]) {
      const replay = fold(persisted);
      assert.deepEqual(stream.state.messages, replay.state.messages);
      assert.deepEqual([...stream.client.values()], replay.state.messages);
      assert.deepEqual([...stream.client.keys()], ['u', 'reasoning-r', 'answer-id']);
    }
    const fallback = fold([user, final]).state.messages;
    assert.deepEqual(fallback.map(message => message.id), ['u', 'reasoning-message-answer-id', 'answer-id']);
    assert.equal(fallback[1].thought, stream.state.messages[1].thought);
  });
}

test('reasoning publishes its native ID independently before a body starts', () => {
  const state = newFoldState();
  assert.deepEqual(foldEvent(state, normalizeEvent(native('assistant.reasoning_delta', {
    reasoningId: 'r', deltaContent: 'thinking',
  }, { ephemeral: true }))).changed, ['reasoning-r']);
  assert.equal(state.messages.length, 1);
  const result = foldEvent(state, normalizeEvent(native('assistant.message_start', { messageId: 'm' }, { ephemeral: true })));
  assert.deepEqual(result.changed, []);
  assert.equal(state.messages[0]?.thought, 'thinking');
  assert.equal(state.messages[0]?.provisional, true);
  assert.equal(state.messages.length, 1, 'empty start establishes identity, not a display position');
  assert.equal(state.streamingId, 'm');
});

test('message-only final reports durable fallback upserts and removes transient-only thought IDs', () => {
  const final = native('assistant.message', { messageId: 'm', content: 'Body', reasoningText: 'Final thought' });
  const live = fold([
    native('assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Partial' }, { ephemeral: true }),
    native('assistant.message_start', { messageId: 'm' }, { ephemeral: true }),
    final,
  ]);
  const persisted = fold([final]);
  assert.deepEqual(live.state.messages, persisted.state.messages);
  assert.deepEqual([...live.client.values()], persisted.state.messages);
  assert.deepEqual([...live.client.keys()], ['reasoning-message-m', 'm']);
});

test('normalized later message finals report all actually reconciled identities in their owning fold', () => {
  for (const child of [false, true]) {
    const state = newFoldState();
    if (child) foldEvent(state, normalizeEvent(started('spawn', 'child')));
    const envelope = child ? { agentId: 'child' } : {};
    const apply = (event: SessionEvent) => foldEvent(state, normalizeEvent(event));
    apply(native('assistant.reasoning_delta', { reasoningId: 'previous', deltaContent: 'Old partial' }, {
      ...envelope, ephemeral: true,
    }));
    apply(native('assistant.message_start', { messageId: 'm' }, { ...envelope, ephemeral: true }));
    apply(native('assistant.message', { messageId: 'm', content: 'Body' }, envelope));
    apply(native('assistant.reasoning_delta', { reasoningId: 'current', deltaContent: 'Current partial' }, {
      ...envelope, ephemeral: true,
    }));
    const target = child ? state.subFolds.get('spawn')! : state;
    assert.deepEqual(target.reasoningIds, ['reasoning-current']);
    assert.deepEqual(target.messageReasoning.get('m'), ['reasoning-previous']);
    const result = apply(native('assistant.message', {
      messageId: 'm', content: 'Updated body', reasoningText: 'Whole reasoning',
    }, envelope));
    assert.deepEqual(result.removed, ['reasoning-previous', 'reasoning-current']);
    assert.equal(result.reconciled?.[0]?.fold, target);
    assert.deepEqual(result.reconciled?.[0]?.ids, ['reasoning-previous', 'reasoning-current']);
    assert.deepEqual(target.messages.map(item => [item.id, item.provisional]), [
      ['m', undefined], ['reasoning-message-m', undefined],
    ]);
    assert.equal(target.messages[0]?.content, 'Updated body');
    assert.equal(target.messages[1]?.thought, 'Whole reasoning');
  }
});

test('final reasoningText replaces transient fragments without truncating a differing durable snapshot', () => {
  const final = native('assistant.message', { messageId: 'm', content: 'done', reasoningText: 'full first\n\nfull second' });
  const { state } = fold([
    native('assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'partial' }, { ephemeral: true }),
    native('assistant.message_start', { messageId: 'm' }, { ephemeral: true }),
    native('assistant.reasoning', { reasoningId: 'r1', content: 'full first' }),
    native('assistant.reasoning_delta', { reasoningId: 'r2', deltaContent: 'full ' }, { ephemeral: true }),
    native('assistant.reasoning_delta', { reasoningId: 'r2', deltaContent: 'second' }, { ephemeral: true }),
    final,
  ]);
  assert.deepEqual(state.messages.map(message => [message.id, message.content, message.thought]), [
    ['reasoning-r1', '', 'full first'],
    ['reasoning-message-m', '', 'full first\n\nfull second'],
    ['m', 'done', undefined],
  ]);
});

test('standalone reasoning survives a turn boundary and cannot absorb the next answer', () => {
  const reasoning = native('assistant.reasoning', { reasoningId: 'standalone', content: 'no answer needed' });
  const end = native('assistant.turn_end', { turnId: '0' });
  const events = [reasoning, end, native('assistant.message', { messageId: 'next', content: 'new turn' })];
  const { state, client } = fold(events);
  assert.deepEqual([...client.values()], state.messages);
  assert.equal(state.messages[0]?.id, 'reasoning-standalone');
  assert.equal(state.messages[0]?.thought, 'no answer needed');
  assert.equal(state.messages[1]?.id, 'next');
  assert.equal(state.messages[1]?.thought, undefined);
  const streamed = fold([
    native('assistant.reasoning_delta', { reasoningId: 'standalone', deltaContent: 'no answer' }, {
      ephemeral: true, timestamp: '2026-09-07T14:19:00.000Z',
    }),
    ...events,
  ]);
  assert.deepEqual(streamed.state.messages, state.messages, 'standalone timestamp comes from the durable reasoning');
});

test('native multi-segment reasoning deltas retain distinct items without a final reasoningText', () => {
  const { state } = fold([
    native('assistant.reasoning_delta', { reasoningId: 'one', deltaContent: 'first' }, { ephemeral: true }),
    native('assistant.reasoning_delta', { reasoningId: 'two', deltaContent: 'second' }, { ephemeral: true }),
    native('assistant.message', { messageId: 'm', content: 'answer' }),
  ]);
  assert.deepEqual(state.messages.map(message => [message.thought, message.provisional]), [
    [undefined, undefined], ['first', true], ['second', true],
  ]);
  assert.equal(state.messages[0]?.content, 'answer');
});

test('distinct concurrent message IDs are not aliased to an earlier stream', () => {
  const { state } = fold([
    native('assistant.message_start', { messageId: 'first' }, { ephemeral: true }),
    native('assistant.message_delta', { messageId: 'first', deltaContent: 'partial' }, { ephemeral: true }),
    native('assistant.message', { messageId: 'second', content: 'separate' }),
    native('assistant.message', { messageId: 'first', content: 'finished' }),
  ]);
  assert.deepEqual(state.messages.map((m) => [m.id, m.content]), [['second', 'separate'], ['first', 'finished']]);
  assert.equal(state.messages.some(message => message.provisional), false);
});

test('native nested background aliases route deltas, tools and late completion to one outer card', () => {
  const outer = started('outer-call', 'outer-registry');
  const inner = started('inner-call', 'inner-registry', 'outer-registry');
  const innerMessage = native('assistant.message', {
    messageId: 'inner-message', content: 'inner answer', reasoningText: 'inner thought',
    toolRequests: [{ toolCallId: 'view-call', name: 'view', arguments: { path: '/synthetic/input' } }],
  }, { agentId: 'inner-registry' });
  const final = native('subagent.completed', {
    toolCallId: 'inner-call', agentName: 'explore', agentDisplayName: 'inner-registry', totalToolCalls: 1,
  });
  const events = [
    outer, inner,
    native('subagent.configured', { model: 'configured-model', multiTurn: true }, { agentId: 'inner-registry' }),
    native('subagent.completed', { toolCallId: 'outer-call', agentName: 'explore', agentDisplayName: 'outer-registry' }),
    native('assistant.message', { messageId: 'main', content: 'main continues' }),
    innerMessage,
    native('tool.execution_start', { toolCallId: 'view-call', toolName: 'view', parentToolCallId: 'inner-call' }),
    native('tool.execution_complete', { toolCallId: 'view-call', success: true, result: { content: 'output' } }),
    final,
  ];
  const persisted = fold(events);
  const live = fold([
    ...events.slice(0, 5),
    native('assistant.reasoning_delta', { reasoningId: 'ir', deltaContent: 'inner thought' }, { agentId: 'inner-registry', ephemeral: true }),
    native('assistant.message_delta', { messageId: 'inner-message', deltaContent: 'inner answer' }, { agentId: 'inner-registry', ephemeral: true }),
    ...events.slice(5),
  ]);
  assert.deepEqual(live.state.messages, persisted.state.messages);
  assert.deepEqual([...live.client.values()], persisted.state.messages);
  assert.deepEqual(persisted.state.messages.map((m) => m.id), ['subagent-outer-call', 'main']);
  const innerCard = persisted.state.messages[0]?.subMessages?.[0];
  assert.equal(innerCard?.id, 'subagent-inner-call');
  assert.equal(innerCard?.subagent?.status, 'completed');
  assert.equal(innerCard?.subagent?.model, 'configured-model');
  assert.equal(innerCard?.subagent?.toolCount, 1);
  assert.equal(innerCard?.subMessages?.find(message => message.id === 'tool-view-call')?.toolCalls?.[0]?.output, 'output');
});

test('nested task ownership wins when lifecycle envelope names its parent agent', () => {
  const { state } = fold([
    started('outer', 'outer-agent'),
    native('assistant.message', { messageId: 'spawn', content: '', toolRequests: [
      { toolCallId: 'inner', name: 'task', arguments: { prompt: 'nested prompt', agent_type: 'explore' } },
    ] }, { agentId: 'outer-agent' }),
    started('inner', 'outer-agent', 'outer-agent'),
    native('assistant.message', { messageId: 'inner-answer', content: 'nested', parentToolCallId: 'inner' }),
    native('subagent.failed', { toolCallId: 'inner', agentName: 'explore', agentDisplayName: 'Inner', error: 'stopped' }, { agentId: 'outer-agent' }),
  ]);
  assert.equal(state.messages.length, 1);
  const inner = state.messages[0]?.subMessages?.[0];
  assert.equal(inner?.id, 'subagent-inner');
  assert.equal(inner?.subagent?.prompt, 'nested prompt');
  assert.equal(inner?.subagent?.status, 'failed');
  assert.equal(inner?.subMessages?.[0]?.content, 'nested');
});

test('legacy parentToolCallId establishes a separate registry alias recursively', () => {
  const { state } = fold([
    started('task', 'initial-alias'),
    native('assistant.message_delta', { messageId: 'm', deltaContent: 'part', parentToolCallId: 'task' }, { agentId: 'registry', ephemeral: true }),
    native('assistant.message', { messageId: 'm', content: 'complete' }, { agentId: 'registry' }),
  ]);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.subMessages?.[0]?.id, 'm');
  assert.equal(state.messages[0]?.subMessages?.[0]?.content, 'complete');
});

test('unowned agents, nested starts and legacy tool parents never leak into the main thread', () => {
  const { state, client } = fold([
    native('assistant.message', { messageId: 'orphan', content: 'private' }, { agentId: 'missing' }),
    native('assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'private' }, { agentId: 'missing', ephemeral: true }),
    native('assistant.message', { messageId: 'legacy-orphan', content: 'private', parentToolCallId: 'missing' }),
    started('orphan-task', 'orphan-agent', 'missing-parent'),
    native('user.message', { content: 'sub prompt', parentAgentTaskId: 'missing' }, { agentId: 'missing' }),
    native('assistant.message', { messageId: 'main', content: 'public' }, { parentId: 'orphan-journal-event' }),
  ]);
  assert.deepEqual(state.messages.map((m) => m.id), ['main']);
  assert.deepEqual([...client.keys()], ['main']);
});

test('native root users retain their bubble despite parentAgentTaskId execution bookkeeping', () => {
  const { state } = fold([native('user.message', {
    content: 'root user', parentAgentTaskId: 'native-root-turn-task', messageId: 'accepted',
  }, { id: 'root-user' })]);
  assert.equal(state.messages[0]?.id, 'root-user');
  assert.equal(state.messages[0]?.content, 'root user');
});

test('duplicate subagent starts do not erase already folded work or final status', () => {
  const start = started('task', 'registry');
  const { state } = fold([
    start,
    native('assistant.message', { messageId: 'm', content: 'done' }, { agentId: 'registry' }),
    native('subagent.completed', { toolCallId: 'task', agentName: 'explore', agentDisplayName: 'registry', totalToolCalls: 2 }),
    start,
  ]);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.subagent?.status, 'completed');
  assert.equal(state.messages[0]?.subagent?.toolCount, 2);
  assert.equal(state.messages[0]?.subMessages?.[0]?.content, 'done');
});

const ask = native('assistant.message', { messageId: 'ask-message', content: '', toolRequests: [
  { toolCallId: 'ask-call', name: 'ask_user', arguments: { question: 'Choose?', choices: ['yes', 'no'] } },
] });

test('native selected answer renders once from durable completion, not ephemeral callbacks', () => {
  const complete = native('tool.execution_complete', {
    toolCallId: 'ask-call', success: true,
    result: { content: 'User selected: yes', detailedContent: 'User selected: yes' },
    toolTelemetry: { properties: { outcome: 'answered', was_freeform: false } },
  });
  const live = fold([
    ask,
    native('user_input.requested', { requestId: 'request', toolCallId: 'ask-call', question: 'Choose?', choices: ['yes', 'no'] }, { ephemeral: true }),
    native('user_input.completed', { requestId: 'request', answer: 'yes', wasFreeform: false }, { ephemeral: true }),
    complete,
    complete,
  ]);
  const persisted = fold([ask, complete]);
  assert.deepEqual([...live.client.values()], persisted.state.messages);
  assert.equal(live.state.messages.filter((m) => m.subtype === 'ask-reply').length, 1);
  assert.equal(live.state.messages[1]?.id, 'reply-ask-call');
  assert.equal(live.state.messages[1]?.content, 'yes');
  assert.equal(live.state.messages[1]?.timestamp, Date.parse(timestamp));
});

for (const [name, data] of Object.entries({
  failed: { success: false, result: { content: 'User responded: not an answer' } },
  error: { success: true, error: { message: 'failed' }, result: { content: 'User selected: not an answer' } },
  dismissed: { success: true, result: { content: 'User dismissed the question' }, toolTelemetry: { properties: { outcome: 'dismissed' } } },
  cancelled: { success: true, result: { content: 'User responded: not an answer' }, toolTelemetry: { properties: { outcome: 'cancelled' } } },
  plainError: { success: true, result: { content: 'Error: input unavailable' } },
  structuredDismissal: { success: true, result: { content: 'User responded: not an answer', dismissed: true } },
  structuredError: { success: true, result: { content: 'User responded: not an answer', isError: true } },
  empty: { success: true, result: { content: 'User responded:   ' } },
})) {
  test(`ask ${name} result does not impersonate a user answer`, () => {
    const { state } = fold([
      ask,
      native('user_input.completed', { requestId: 'request' }, { ephemeral: true }),
      { type: 'tool.execution_complete', data: { toolCallId: 'ask-call', ...data } },
    ]);
    assert.equal(state.messages.filter((m) => m.role === 'user').length, 0);
  });
}

test('ask freeform preserves multiline text, including words resembling dismissal', () => {
  const { state } = fold([ask, native('tool.execution_complete', {
    toolCallId: 'ask-call', success: true,
    result: { content: '', detailedContent: 'User responded: dismissed\nis the word to use' },
    toolTelemetry: { properties: { outcome: 'answered', was_freeform: true } },
  })]);
  assert.equal(state.messages[1]?.content, 'dismissed\nis the word to use');
});

test('ask tool start can correlate a persisted completion without a preceding assistant request', () => {
  const events = [
    native('tool.execution_start', { toolCallId: 'ask-call', toolName: 'ask_user', arguments: { question: 'Q?' } }),
    native('tool.execution_complete', { toolCallId: 'ask-call', success: true, result: { content: 'User responded: yes' } }),
  ];
  assert.equal(fold(events).state.messages[0]?.content, 'yes');
  assert.equal(fold([events[1]!]).state.messages.length, 0, 'unknown tool output is not a user answer');
});

test('native nested ask replies stay in their owning card, including requested-event correlation', () => {
  const { state, client } = fold([
    started('outer', 'outer-agent'),
    started('inner', 'inner-agent', 'outer-agent'),
    native('user_input.requested', {
      requestId: 'request', toolCallId: 'inner-ask', question: 'Q?',
    }, { agentId: 'inner-agent', ephemeral: true }),
    native('user_input.completed', { requestId: 'request', answer: 'yes' }, { agentId: 'inner-agent', ephemeral: true }),
    native('tool.execution_complete', {
      toolCallId: 'inner-ask', success: true, result: { content: 'User selected: yes' }, parentToolCallId: 'inner',
    }),
  ]);
  assert.deepEqual([...client.values()], state.messages);
  assert.equal(state.messages.length, 1);
  const reply = state.messages[0]?.subMessages?.[0]?.subMessages?.[0];
  assert.equal(reply?.id, 'reply-inner-ask');
  assert.equal(reply?.content, 'yes');
});

test('ephemeral requested/completed events alone never invent a durable answer', () => {
  const { state } = fold([
    native('user_input.requested', { requestId: 'request', question: 'Q?' }, { ephemeral: true }),
    native('user_input.completed', { requestId: 'request', answer: 'yes' }, { ephemeral: true }),
  ]);
  assert.equal(state.messages.length, 0);
});
