import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeChatRead, NativeChatPage, NativeChatEvent } from '@cockpit/protocol';
import { NativeWindow } from './nativeWindow';

const query = (extra: Partial<NativeChatRead> = {}): NativeChatRead => ({
  sessionId: 'fixture', source: 'live', direction: 'backward', max: 64, waitMs: 0,
  agentScope: 'primary', bootstrap: false, ...extra,
});
const event = (id: string, type = 'assistant.message', data: Record<string, unknown> = {}): NativeChatEvent => ({
  id, type, timestamp: 1, data: { messageId: id, content: id, ...data },
});
const page = (events: NativeChatEvent[], q: NativeChatRead, extra: Partial<NativeChatPage> = {}): NativeChatPage => ({
  sessionId: q.sessionId, source: q.source, direction: q.direction,
  events, cursor: 'next', cursorStatus: 'ok', hasMore: false,
  read: { rpc: 1, events: events.length }, ...extra,
});
const accept = (window: NativeWindow, events: NativeChatEvent[], extra: Partial<NativeChatRead> = {},
  result: Partial<NativeChatPage> = {}) => {
  const q = query(extra);
  return window.accept(page(events, q, result), q);
};
const forward = { direction: 'forward' as const, cursor: 'forward', includeEphemeral: true };
const ephemeral = (id: string, type: string, data: Record<string, unknown>): NativeChatEvent =>
  ({ ...event(id, type, data), ephemeral: true });

test('native backward pages prepend in append order, not UUID or timestamp order', () => {
  const window = new NativeWindow();
  accept(window, [event('a'), event('z')], {}, { hasMore: true, cursor: 'older-one' });
  accept(window, [event('y'), event('b')], { cursor: 'older-one' }, { cursor: 'older-two' });
  assert.deepEqual(window.snapshot().messages.map(m => m.id), ['y', 'b', 'a', 'z']);
  assert.equal(window.older?.cursor, 'older-two');
});

test('bootstrap overlap can span forward pages without appending older events after the latest page', () => {
  const window = new NativeWindow();
  accept(window, [event('c'), event('d')], { bootstrap: true }, { liveCursor: 'tail-before-read', hasMore: true });
  accept(window, [event('a'), event('b')], forward, { hasMore: true, cursor: 'catchup-one' });
  window.disconnect();
  accept(window, [event('c'), event('d'), event('e')], forward);
  assert.deepEqual(window.snapshot().messages.map(m => m.id), ['c', 'd', 'e']);
  assert.equal(window.retainedEventCount, 3);
});

test('a disconnected catchup retains its bounded received pages alongside its advancing cursor', () => {
  const window = new NativeWindow();
  accept(window, [event('a')]);
  accept(window, [event('b')], forward, { hasMore: true });
  window.disconnect();
  accept(window, [event('c')], forward);
  assert.deepEqual(window.snapshot().messages.map(m => m.id), ['a', 'b', 'c']);
});

test('ordinary reconnect publishes each durable page instead of waiting for the entire gap', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [event('a')], { bootstrap: true }, { liveCursor: 'initial' });
  accept(window, [], forward);
  window.disconnect();
  accept(window, [event('b')], forward, { hasMore: true, cursor: 'gap-one' });
  assert.deepEqual(window.snapshot().messages.map(message => message.id), ['a', 'b']);
  window.disconnect();
  accept(window, [event('c')], forward);
  assert.deepEqual(window.snapshot().messages.map(message => message.id), ['a', 'b', 'c']);
});

test('partial C is retained across a gap, suffix deltas are withheld, and complete C replaces it', () => {
  const window = new NativeWindow();
  accept(window, [event('a')]);
  accept(window, [], forward);
  accept(window, [
    ephemeral('start', 'assistant.message_start', { messageId: 'c' }),
    ephemeral('delta-1', 'assistant.message_delta', { messageId: 'c', deltaContent: 'first' }),
  ], forward);
  window.disconnect();
  accept(window, [], forward);
  accept(window, [ephemeral('delta-2', 'assistant.message_delta', { messageId: 'c', deltaContent: 'last' })], forward);
  assert.equal(window.snapshot().messages.at(-1)?.content, 'first');
  assert.equal(window.partial, true);
  accept(window, [event('complete', 'assistant.message', { messageId: 'c', content: 'first middle last' })], forward);
  assert.equal(window.snapshot().messages.at(-1)?.content, 'first middle last');
  assert.equal(window.partial, false);
});

test('prepend retains active streaming scratch and later deltas never replay the whole character log', () => {
  const window = new NativeWindow();
  accept(window, [event('a')], {}, { hasMore: true });
  accept(window, [], forward);
  accept(window, [
    ephemeral('start', 'assistant.message_start', { messageId: 'c' }),
    ephemeral('first', 'assistant.message_delta', { messageId: 'c', deltaContent: 'first' }),
  ], forward);
  accept(window, [event('older')], { cursor: 'older' });
  accept(window, [ephemeral('last', 'assistant.message_delta', { messageId: 'c', deltaContent: ' last' })], forward);
  assert.equal(window.snapshot().messages.at(-1)?.content, 'first last');
  for (let i = 0; i < 400; i++) {
    accept(window, [ephemeral(`d${i}`, 'assistant.message_delta', { messageId: 'c', deltaContent: '.' })], forward);
  }
  assert.ok(window.retainedEventCount <= 258);
});

test('expired and crossed response identities retain the readable view instead of silently replacing it', () => {
  const window = new NativeWindow();
  accept(window, [event('a')]);
  assert.throws(() => accept(window, [], forward, { cursorStatus: 'expired' }), /失效/);
  assert.equal(window.snapshot().messages[0].id, 'a');
  assert.equal(window.invalid, true);
  assert.throws(() => accept(window, [], {}, { sessionId: 'other' }), /不匹配/);
});

test('static subagent cards ignore lifecycle and outer task completion updates', () => {
  const window = new NativeWindow();
  accept(window, [
    event('parent', 'assistant.message', { toolRequests: [{ toolCallId: 'task-one', name: 'task', arguments: { description: 'Research' } }] }),
    event('started', 'subagent.started', { toolCallId: 'task-one', agentId: 'child', agentDisplayName: 'Researcher' }),
  ]);
  const card = window.snapshot().messages.at(-1);
  accept(window, [
    event('done', 'subagent.completed', { toolCallId: 'task-one', totalToolCalls: 500 }),
    event('tool-done', 'tool.execution_complete', { toolCallId: 'task-one', success: true, result: { content: 'Task finished' } }),
  ], forward);
  assert.deepEqual(window.snapshot().messages.at(-1), card);
  assert.equal(card?.subagent?.agentId, 'child');
});

test('ordinary tools require their actual owning message, which older paging can supply', () => {
  const window = new NativeWindow();
  accept(window, [
    event('result', 'tool.execution_complete', { toolCallId: 'tool', success: true, result: { content: 'result' } }),
    event('newer'),
  ], {}, { hasMore: true });
  assert.equal(window.snapshot().messages.at(-1)?.toolCalls, undefined);
  assert.equal(window.unresolved, true);
  accept(window, [
    event('owner', 'assistant.message', { toolRequests: [{ toolCallId: 'tool', name: 'bash' }] }),
  ], { cursor: 'older' });
  assert.equal(window.snapshot().messages.find(message => message.id === 'tool-tool')?.toolCalls?.[0].output, 'result');
  assert.equal(window.unresolved, false);
});

test('explicitly owned child tool events do not create a missing boundary in the primary view', () => {
  const window = new NativeWindow();
  accept(window, [
    { ...event('child-result', 'tool.execution_complete', {
      toolCallId: 'child-tool', parentToolCallId: 'spawn', success: true, result: { content: 'hidden' },
    }), agentId: 'child', parentToolCallId: 'spawn' },
    event('primary-message'),
  ], {}, { hasMore: true });
  assert.deepEqual(window.snapshot().messages.map(message => message.id), ['primary-message']);
  assert.equal(window.unresolved, false);
});

test('filtered child views normalize their own envelope without needing an ancestor replay', () => {
  const window = new NativeWindow(['child']);
  accept(window, [{ ...event('child-message'), agentId: 'child' }], { agentIds: ['child'], agentScope: undefined });
  assert.equal(window.snapshot().messages[0]?.id, 'child-message');
});

const all = { agentScope: 'all' as const };
const liveAll = { ...forward, ...all };
const owned = (agentId: string, value: NativeChatEvent): NativeChatEvent => ({ ...value, agentId });
const spawn = (toolCallId: string, agentId: string) => event(`started-${toolCallId}`, 'subagent.started', {
  toolCallId, agentId, agentDisplayName: agentId,
});
const taskMessage = (id: string, toolCallId: string) => event(id, 'assistant.message', {
  toolRequests: [{ toolCallId, name: 'task', arguments: { prompt: 'Synthetic task' } }],
});

test('one all-agent window contains child history, live results and lifecycle without a second child read', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [
    taskMessage('root-task', 'spawn'), spawn('spawn', 'child'),
    owned('child', event('child-old')),
  ], { ...all, bootstrap: true }, { liveCursor: 'initial-tail', hasMore: true });
  accept(window, [owned('child', event('child-old')), owned('child', event('child-new'))], liveAll);
  accept(window, [event('child-done', 'subagent.completed', { toolCallId: 'spawn' })], liveAll);
  const card = window.snapshot().messages.find(message => message.subagent)!;
  assert.deepEqual(card.subMessages?.map(message => message.id), ['child-old', 'child-new']);
  assert.equal(card.subagent?.status, 'completed');
  assert.equal(card.subagent?.prompt, undefined, 'task arguments are not retained as another copy of the child conversation');
  assert.equal(window.unresolved, false);
});

test('child streaming scratch survives older prepend, and a missing suffix waits for the final message', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [taskMessage('root-task', 'spawn'), spawn('spawn', 'child'), owned('child', event('stable'))], all);
  accept(window, [], liveAll);
  accept(window, [
    owned('child', ephemeral('start', 'assistant.message_start', { messageId: 'shared' })),
    owned('child', ephemeral('delta', 'assistant.message_delta', { messageId: 'shared', deltaContent: 'prefix' })),
    event('root-final', 'assistant.message', { messageId: 'shared', content: 'Root identity is independent' }),
  ], liveAll);
  const stable = window.snapshot().messages.find(message => message.subagent)?.subMessages?.[0];
  accept(window, [owned('child', ephemeral('more', 'assistant.message_delta', { messageId: 'shared', deltaContent: ' middle' }))], liveAll);
  assert.equal(window.snapshot().messages.find(message => message.subagent)?.subMessages?.[0], stable);
  accept(window, [event('older-root')], { ...all, cursor: 'older' });
  const childMessages = () => window.snapshot().messages.find(message => message.subagent)!.subMessages!;
  assert.equal(childMessages().at(-1)?.content, 'prefix middle');
  window.disconnect();
  accept(window, [], liveAll);
  accept(window, [owned('child', ephemeral('lost-prefix', 'assistant.message_delta', { messageId: 'shared', deltaContent: ' suffix' }))], liveAll);
  assert.equal(childMessages().at(-1)?.content, 'prefix middle');
  const final = owned('child', event('child-final', 'assistant.message', { messageId: 'shared', content: 'prefix middle missed suffix' }));
  accept(window, [final, final], liveAll);
  assert.equal(childMessages().at(-1)?.content, 'prefix middle missed suffix');
  assert.equal(childMessages().filter(message => message.id === 'shared').length, 1);
  assert.equal(window.snapshot().messages.find(message => message.id === 'shared')?.content, 'Root identity is independent');
  assert.equal(window.partial, false);
});

test('nested child deltas update their ancestors without cloning an unrelated child message', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [
    taskMessage('outer-task', 'outer'), spawn('outer', 'outer-agent'),
    owned('outer-agent', event('unrelated')),
    owned('outer-agent', taskMessage('inner-task', 'inner')), spawn('inner', 'inner-agent'),
  ], all);
  accept(window, [], liveAll);
  const outerMessages = () => window.snapshot().messages.find(message => message.subagent?.toolCallId === 'outer')!.subMessages!;
  const unrelated = outerMessages()[0];
  accept(window, [
    owned('inner-agent', ephemeral('nested-start', 'assistant.message_start', { messageId: 'nested' })),
    owned('inner-agent', ephemeral('nested-text', 'assistant.message_delta', { messageId: 'nested', deltaContent: 'Nested text' })),
  ], liveAll);
  assert.equal(outerMessages()[0], unrelated);
  assert.equal(outerMessages().find(message => message.subagent?.toolCallId === 'inner')?.subMessages?.[0].content, 'Nested text');
  accept(window, [event('older-root')], { ...all, cursor: 'older' });
  assert.equal(outerMessages().find(message => message.subagent?.toolCallId === 'inner')?.subMessages?.[0].content, 'Nested text');
});

test('legacy data.agentId remains child ownership when persisted history and live scopes agree', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [taskMessage('root-task', 'spawn'), spawn('spawn', 'child'),
    event('legacy', 'assistant.message', { agentId: 'child', content: 'Child, not root' })], { source: 'persisted', agentScope: undefined });
  assert.equal(window.snapshot().messages.some(message => message.id === 'legacy'), false);
  assert.equal(window.snapshot().messages.find(message => message.subagent)?.subMessages?.[0].id, 'legacy');
});

test('empty and duplicate live pages advance cursor without replacing the message view', () => {
  const window = new NativeWindow(undefined, true);
  const value = event('one');
  accept(window, [value], all);
  const before = window.snapshot().messages;
  accept(window, [], liveAll, { cursor: 'empty-cursor' });
  accept(window, [value], liveAll, { cursor: 'duplicate-cursor' });
  assert.equal(window.snapshot().messages, before);
  assert.equal(window.live?.cursor, 'duplicate-cursor');
});

test('passive metadata and unused tool argument deltas advance position without retaining display copies', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [event('displayed'), event('configuration', 'session.start', { irrelevant: 'large native metadata' })], {
    source: 'persisted', agentScope: undefined,
  });
  assert.equal(window.retainedEventCount, 1);
  accept(window, [], liveAll);
  accept(window, [ephemeral('arguments', 'assistant.tool_call_delta', { delta: 'not rendered' })], liveAll);
  assert.equal(window.retainedEventCount, 1);
});

test('resolving an older child owner also resolves the interrupted message identity', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [event('root')], all, { hasMore: true });
  accept(window, [], liveAll);
  accept(window, [owned('child', ephemeral('start', 'assistant.message_start', { messageId: 'interrupted' }))], liveAll);
  assert.equal(window.unresolved, true);
  window.disconnect();
  accept(window, [taskMessage('root-task', 'spawn'), spawn('spawn', 'child')], { ...all, cursor: 'older' });
  accept(window, [owned('child', event('final', 'assistant.message', { messageId: 'interrupted', content: 'Recovered final' }))], liveAll);
  assert.equal(window.partial, false);
  assert.equal(window.unresolved, false);
  assert.equal(window.snapshot().messages.find(message => message.subagent)?.subMessages?.[0].content, 'Recovered final');
});

test('a new native agent alias uses its known legacy owner without an unnecessary older scan', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [taskMessage('root-task', 'spawn'), spawn('spawn', 'legacy-child')], all);
  accept(window, [], liveAll);
  accept(window, [{ ...owned('new-native-alias', event('alias-message')), parentToolCallId: 'spawn' }], liveAll);
  assert.equal(window.unresolved, false);
  assert.equal(window.snapshot().messages.find(message => message.subagent)?.subMessages?.[0].id, 'alias-message');
});

test('a durable reasoning boundary survives the initial backward read until its message arrives', () => {
  const window = new NativeWindow();
  accept(window, [event('thought', 'assistant.reasoning', { reasoningId: 'r', content: 'Reasoning' })]);
  accept(window, [event('answer')], forward);
  assert.equal(window.snapshot().messages[0]?.thought, 'Reasoning');
});

test('retained output is not capped twice when older paging supplies its owner', () => {
  const window = new NativeWindow();
  const output = 'x'.repeat(100_000);
  accept(window, [event('result', 'tool.execution_complete', {
    toolCallId: 'tool', result: { content: output },
  })], {}, { hasMore: true });
  accept(window, [event('owner', 'assistant.message', {
    toolRequests: [{ toolCallId: 'tool', name: 'bash', arguments: { command: 'echo test' } }],
  })], { cursor: 'older' });
  const tool = window.snapshot().messages.find(message => message.id === 'tool-tool')?.toolCalls?.[0];
  assert.equal(tool?.args, '$ echo test');
  assert.match(tool?.output ?? '', /已截断，共 100000 字符/);
});

test('a retained ask answer can be owned by a subsequently loaded older message', () => {
  const window = new NativeWindow();
  const answer = 'answer '.repeat(1000).trim();
  accept(window, [event('result', 'tool.execution_complete', {
    toolCallId: 'ask', success: true, result: { content: `User responded: ${answer}` },
  })], {}, { hasMore: true });
  accept(window, [event('owner', 'assistant.message', {
    toolRequests: [{ toolCallId: 'ask', name: 'ask_user' }],
  })], { cursor: 'older' });
  assert.equal(window.snapshot().messages.find(message => message.id === 'reply-ask')?.content, answer);
});

test('atomic native items converge across every history split and duplicated forward chunk', () => {
  const history = [
    event('zz-user', 'user.message', { content: 'Question' }),
    event('zz-thought', 'assistant.reasoning', { reasoningId: 'first', content: 'First thought' }),
    event('aa-body', 'assistant.message', {
      messageId: 'body', content: 'Before tools', reasoningText: 'First thought',
      toolRequests: [
        { toolCallId: 'view', name: 'view', arguments: { path: '/synthetic/input' } },
        { toolCallId: 'bash', name: 'bash', arguments: { command: 'echo synthetic' } },
      ],
    }),
    event('zy-thought', 'assistant.reasoning', { reasoningId: 'second', content: 'After tools' }),
    event('ab-thought', 'assistant.reasoning', { reasoningId: 'third', content: 'Another block' }),
    event('z-start', 'tool.execution_start', { toolCallId: 'view' }),
    event('a-result', 'tool.execution_complete', { toolCallId: 'view', result: { content: 'Output' } }),
    event('end-body', 'assistant.message', {
      messageId: 'after', content: 'After reasoning', reasoningText: 'After tools\n\nAnother block',
    }),
    event('ask-owner', 'assistant.message', {
      content: '', toolRequests: [{ toolCallId: 'ask', name: 'ask_user' }],
    }),
    event('ask-result', 'tool.execution_complete', { toolCallId: 'ask', result: { content: 'User selected: yes' } }),
    taskMessage('task', 'spawn'), spawn('spawn', 'child'),
    owned('child', event('child-thought', 'assistant.reasoning', { reasoningId: 'child-r', content: 'Child thinking' })),
    owned('child', event('child-body')),
    event('child-done', 'subagent.completed', { toolCallId: 'spawn' }),
    owned('child', event('child-followup')),
  ];
  const baseline = new NativeWindow(undefined, true);
  accept(baseline, history, all);
  const expected = baseline.snapshot().messages;
  assert.deepEqual(expected.map(message => message.id), [
    'zz-user', 'reasoning-first', 'body', 'tool-view', 'tool-bash',
    'reasoning-second', 'reasoning-third', 'after', 'tool-ask', 'reply-ask', 'task', 'subagent-spawn',
  ]);
  assert.equal(expected[3].toolCalls?.[0].status, 'completed');
  assert.equal(expected[3].toolCalls?.[0].output, 'Output');
  assert.equal(expected.at(-1)?.subagent?.status, 'activity');
  for (const message of [...expected, ...expected.at(-1)?.subMessages ?? []]) {
    if (message.thought || message.toolCalls) assert.equal(message.content, '');
    if (message.toolCalls) {
      assert.equal(message.toolCalls.length, 1);
      assert.equal(message.thought, undefined);
    }
  }
  for (let size = 1; size <= history.length; size++) {
    const backward = new NativeWindow(undefined, true);
    for (let end = history.length; end > 0; end -= size) {
      accept(backward, history.slice(Math.max(0, end - size), end), all);
    }
    assert.deepEqual(backward.snapshot().messages, expected, `backward size ${size}`);
    assert.equal(backward.unresolved, false);
    const live = new NativeWindow(undefined, true);
    accept(live, [], liveAll);
    for (let start = 0; start < history.length; start += size) {
      const chunk = history.slice(start, start + size);
      accept(live, chunk.flatMap(value => [value, value]), liveAll);
    }
    assert.deepEqual(live.snapshot().messages, expected, `forward size ${size}`);
  }
});

test('bundled reasoning, body and tool requests use a deterministic local order', () => {
  const window = new NativeWindow(undefined, true);
  const bundled = event('bundle', 'assistant.message', {
    messageId: 'body', content: 'Body', reasoningText: 'Bundled thought',
    toolRequests: [{ toolCallId: 'second', name: 'view' }, { toolCallId: 'first', name: 'bash' }],
  });
  accept(window, [bundled], all);
  assert.deepEqual(window.snapshot().messages.map(message => message.id), [
    'reasoning-message-body', 'body', 'tool-second', 'tool-first',
  ]);
  const body = window.snapshot().messages[1];
  accept(window, [event('complete', 'tool.execution_complete', {
    toolCallId: 'second', result: { content: 'Result' },
  })], liveAll);
  assert.equal(window.snapshot().messages[1], body);
  assert.equal(window.snapshot().messages[2].toolCalls?.[0].status, 'completed');
});

test('older explicit reasoning removes only its redundant bundled fallback and preserves body anchors', () => {
  const window = new NativeWindow(undefined, true);
  const final = event('final', 'assistant.message', { messageId: 'body', content: 'Body', reasoningText: 'Thought' });
  accept(window, [final], all);
  accept(window, [event('reason', 'assistant.reasoning', { reasoningId: 'r', content: 'Thought' })], all);
  assert.deepEqual(window.snapshot().messages.map(message => message.id), ['reasoning-r', 'body']);
  assert.equal(window.snapshot().messages[1].thought, undefined);
});

test('reasoning streams are independent, suppress disconnected suffixes, and converge to durable records', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [], liveAll);
  const start = ephemeral('start', 'assistant.message_start', { messageId: 'body' });
  accept(window, [
    ephemeral('r-prefix', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Partial' }),
    start,
    ephemeral('body-prefix', 'assistant.message_delta', { messageId: 'body', deltaContent: 'Partial body' }),
  ], liveAll);
  assert.deepEqual(window.snapshot().messages.map(message => message.id), ['reasoning-r', 'body']);
  accept(window, [event('older-user', 'user.message', { content: 'Older' })], all);
  window.disconnect();
  accept(window, [], liveAll);
  accept(window, [
    ephemeral('r-suffix', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: ' lost suffix' }),
    ephemeral('body-suffix', 'assistant.message_delta', { messageId: 'body', deltaContent: ' lost suffix' }),
  ], liveAll);
  assert.equal(window.snapshot().messages[1].thought, 'Partial');
  assert.equal(window.snapshot().messages[2].content, 'Partial body');
  const durable = [
    event('final-r', 'assistant.reasoning', { reasoningId: 'r', content: 'Complete thought' }),
    event('final-body', 'assistant.message', { messageId: 'body', content: 'Complete body', reasoningText: 'Complete thought' }),
  ];
  accept(window, durable, liveAll);
  assert.equal(window.partial, false);
  const replay = new NativeWindow(undefined, true);
  accept(replay, [event('older-user', 'user.message', { content: 'Older' }), ...durable], all);
  assert.deepEqual(window.snapshot().messages, replay.snapshot().messages);
  const before = window.snapshot().messages;
  accept(window, [
    ...durable,
    ephemeral('late-r', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Not appended' }),
  ], liveAll);
  assert.equal(window.snapshot().messages, before);
});

test('a message-only final reconciles interrupted thought fragments to one durable fallback', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [], liveAll);
  accept(window, [
    ephemeral('r-prefix', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Partial' }),
    ephemeral('start', 'assistant.message_start', { messageId: 'body' }),
  ], liveAll);
  window.disconnect();
  const final = event('final', 'assistant.message', { messageId: 'body', content: 'Body', reasoningText: 'Whole thought' });
  accept(window, [final], liveAll);
  const baseline = new NativeWindow(undefined, true);
  accept(baseline, [final], all);
  assert.deepEqual(window.snapshot().messages, baseline.snapshot().messages);
  assert.equal(window.partial, false);
});

test('later reasoning with matching text cannot erase a previous message snapshot without ownership', () => {
  const history = [
    event('body', 'assistant.message', { content: 'Body first', reasoningText: 'Complete thought' }),
    event('reasoning', 'assistant.reasoning', { reasoningId: 'r', content: 'Complete thought' }),
    event('next-reasoning', 'assistant.reasoning', { reasoningId: 'r2', content: 'Different later thought' }),
  ];
  for (const split of [0, 1, 2]) {
    const window = new NativeWindow(undefined, true);
    accept(window, history.slice(split), all);
    if (split) accept(window, history.slice(0, split), all);
    assert.deepEqual(window.snapshot().messages.map(message => message.id), ['reasoning-message-body', 'body', 'reasoning-r', 'reasoning-r2']);
    assert.equal(window.snapshot().messages[0].thought, 'Complete thought');
  }
  const reconnect = new NativeWindow(undefined, true);
  for (const value of history) {
    reconnect.disconnect();
    accept(reconnect, [value], liveAll);
  }
  assert.deepEqual(reconnect.snapshot().messages.map(message => message.id), ['reasoning-message-body', 'body', 'reasoning-r', 'reasoning-r2']);
});

test('differing durable reasoning snapshots and body-only updates never erase recorded thoughts', () => {
  for (const history of [
    [
      event('r', 'assistant.reasoning', { reasoningId: 'r', content: 'A' }),
      event('m', 'assistant.message', { messageId: 'm', content: 'Body', reasoningText: 'B' }),
    ],
    [
      event('m', 'assistant.message', { messageId: 'm', content: 'Initial', reasoningText: 'A' }),
      event('r', 'assistant.reasoning', { reasoningId: 'r', content: 'B' }),
      event('update', 'assistant.message', { messageId: 'm', content: 'Updated' }),
    ],
  ]) {
    const baseline = new NativeWindow(undefined, true);
    accept(baseline, history, all);
    assert.deepEqual(baseline.snapshot().messages.flatMap(item => item.thought ? [item.thought] : []), ['A', 'B']);
    for (let split = 1; split < history.length; split++) {
      const paged = new NativeWindow(undefined, true);
      accept(paged, history.slice(split), all);
      accept(paged, history.slice(0, split), all);
      assert.deepEqual(paged.snapshot().messages, baseline.snapshot().messages, `split ${split}`);
    }
  }
});

test('mixed snapshot and separate reasoning converge without guessing shared ownership from a text suffix', () => {
  const history = [
    event('r1', 'assistant.reasoning', { reasoningId: 'r1', content: 'A' }),
    event('m', 'assistant.message', { messageId: 'm', content: 'Body', reasoningText: 'A\n\nB' }),
    event('r2', 'assistant.reasoning', { reasoningId: 'r2', content: 'B' }),
  ];
  const baseline = new NativeWindow(undefined, true);
  accept(baseline, history, all);
  assert.deepEqual(baseline.snapshot().messages.map(item => [item.id, item.thought]), [
    ['reasoning-r1', 'A'], ['reasoning-message-m', 'A\n\nB'], ['m', undefined], ['reasoning-r2', 'B'],
  ]);
  for (let split = 1; split < history.length; split++) {
    const paged = new NativeWindow(undefined, true);
    accept(paged, history.slice(split), all);
    accept(paged, history.slice(0, split), all);
    paged.disconnect();
    accept(paged, history, liveAll);
    assert.deepEqual(paged.snapshot().messages, baseline.snapshot().messages, `split ${split}`);
  }
});

test('durable ordering wins over transient arrival order without duplicating text or reasoning identities', () => {
  const history = [
    event('body-final', 'assistant.message', { messageId: 'body', content: 'Final body',
      toolRequests: [{ toolCallId: 'after-body', name: 'view' }] }),
    event('thought-final', 'assistant.reasoning', { reasoningId: 'r', content: 'Final thought' }),
  ];
  const cold = new NativeWindow(undefined, true);
  accept(cold, history, all);
  const live = new NativeWindow(undefined, true);
  accept(live, [], liveAll);
  accept(live, [
    ephemeral('r-start', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Partial thought' }),
    ephemeral('body-start', 'assistant.message_start', { messageId: 'body' }),
    ephemeral('body-part', 'assistant.message_delta', { messageId: 'body', deltaContent: 'Partial body' }),
  ], liveAll);
  accept(live, history, liveAll);
  assert.deepEqual(live.snapshot().messages, cold.snapshot().messages);
});

test('later authoritative body records cannot duplicate newly explicit reasoning blocks', () => {
  const window = new NativeWindow(undefined, true);
  const history = [
    event('first', 'assistant.reasoning', { reasoningId: 'first', content: 'First' }),
    event('body-initial', 'assistant.message', { messageId: 'body', content: 'Initial', reasoningText: 'First' }),
    event('second', 'assistant.reasoning', { reasoningId: 'second', content: 'Second' }),
    event('body-final', 'assistant.message', { messageId: 'body', content: 'Final', reasoningText: 'First\n\nSecond' }),
  ];
  accept(window, history, all);
  assert.deepEqual(window.snapshot().messages.map(message => [message.id, message.content, message.thought]), [
    ['reasoning-first', '', 'First'], ['body', 'Final', undefined], ['reasoning-second', '', 'Second'],
  ]);
  for (let split = 1; split < history.length; split++) {
    const paged = new NativeWindow(undefined, true);
    accept(paged, history.slice(split), all);
    accept(paged, history.slice(0, split), all);
    assert.deepEqual(paged.snapshot().messages, window.snapshot().messages, `split ${split}`);
  }
});

test('bootstrap overlap and reconnect preserve atomic request positions and terminal tool output', () => {
  const history = [
    event('zz-reasoning', 'assistant.reasoning', { reasoningId: 'r', content: 'Thought' }),
    event('aa-owner', 'assistant.message', {
      messageId: 'body', content: 'Text', reasoningText: 'Thought',
      toolRequests: [{ toolCallId: 't', name: 'view' }],
    }),
    event('zz-after', 'assistant.reasoning', { reasoningId: 'after', content: 'After request' }),
    event('aa-complete', 'tool.execution_complete', { toolCallId: 't', result: { content: 'Output' } }),
  ];
  const window = new NativeWindow(undefined, true);
  accept(window, history.slice(2), { ...all, bootstrap: true }, { liveCursor: 'tail', hasMore: true });
  accept(window, history.slice(0, 2), liveAll, { hasMore: true });
  accept(window, history.slice(0, 2), all);
  window.disconnect();
  accept(window, history.slice(2), liveAll);
  const baseline = new NativeWindow(undefined, true);
  accept(baseline, history, all);
  assert.deepEqual(window.snapshot().messages, baseline.snapshot().messages);
  const ids = window.snapshot().messages.map(message => message.id);
  accept(window, [event('owner-reasserted', 'assistant.message', {
    messageId: 'body', content: 'Updated text',
    toolRequests: [{ toolCallId: 't', name: 'view' }],
  })], liveAll);
  assert.deepEqual(window.snapshot().messages.map(message => message.id), ids);
  assert.equal(window.snapshot().messages.find(message => message.id === 'tool-t')?.toolCalls?.[0].output, 'Output');
  assert.equal(window.snapshot().messages.find(message => message.id === 'tool-t')?.toolCalls?.[0].status, 'completed');
});

test('empty starts and tool-only finals never anchor the later durable body, in root and child scopes', () => {
  for (const child of [false, true]) for (const priorThought of [false, true]) for (const withDelta of [false, true]) {
    const scope = (value: NativeChatEvent) => child ? owned('child', value) : value;
    const setup = child ? [taskMessage('task', 'spawn'), spawn('spawn', 'child')] : [];
    const tools = (toolCallId: string) => ({ toolRequests: [{ toolCallId, name: 'view' }] });
    const prior = scope(priorThought
      ? event('prior-r', 'assistant.reasoning', { reasoningId: 'r', content: 'Earlier thought' })
      : event('prior-tool', 'assistant.message', { content: '', ...tools('t1') }));
    const first = scope(event('first', 'assistant.message', { messageId: 'm', content: '', ...tools('t2') }));
    const update = scope(event('update', 'assistant.message', { messageId: 'm', content: 'Answer', ...tools('t2') }));
    const live = new NativeWindow(undefined, true);
    accept(live, setup, all);
    accept(live, [], liveAll);
    accept(live, [prior, scope(ephemeral('start', 'assistant.message_start', { messageId: 'm' }))], liveAll);
    const rows = () => child ? live.snapshot().messages.find(item => item.subagent)!.subMessages! : live.snapshot().messages;
    assert.deepEqual(rows().map(item => item.id), [priorThought ? 'reasoning-r' : 'tool-t1']);
    if (withDelta) {
      accept(live, [scope(ephemeral('delta', 'assistant.message_delta', { messageId: 'm', deltaContent: 'Draft' }))], liveAll);
      assert.equal(rows().at(-1)?.provisional, true);
    }
    accept(live, [first], liveAll);
    assert.deepEqual(rows().map(item => item.id), [priorThought ? 'reasoning-r' : 'tool-t1', 'tool-t2']);
    accept(live, [scope(ephemeral('late', 'assistant.message_delta', { messageId: 'm', deltaContent: 'Late draft' }))], liveAll);
    assert.equal(rows().some(item => item.id === 'm'), false);
    live.disconnect();
    assert.equal(live.partial, false, 'tool-only final completed the body stream');
    accept(live, [update], liveAll);
    assert.deepEqual(rows().map(item => item.id), [priorThought ? 'reasoning-r' : 'tool-t1', 'tool-t2', 'm']);
    const cold = new NativeWindow(undefined, true);
    accept(cold, [...setup, prior, first, update], all);
    assert.deepEqual(live.snapshot().messages, cold.snapshot().messages);
    const before = rows().map(item => item.id);
    accept(live, [scope(event('complete', 'tool.execution_complete', {
      toolCallId: 't2', success: true, result: { content: 'Tool output' },
    }))], liveAll);
    assert.deepEqual(rows().map(item => item.id), before);
    assert.equal(rows().find(item => item.id === 'tool-t2')?.toolCalls?.[0].output, 'Tool output');
  }
});

test('whitespace-only first bodies never anchor before tools while confirmed updates preserve original bytes', () => {
  for (const child of [false, true]) for (const withDelta of [false, true]) {
    const scope = (value: NativeChatEvent) => child ? owned('child', value) : value;
    const setup = child ? [taskMessage('task', 'spawn'), spawn('spawn', 'child')] : [];
    const whitespace = ' \n ';
    const content = ' \n Answer \n ';
    const first = scope(event('first', 'assistant.message', {
      messageId: 'm', content: whitespace, toolRequests: [{ toolCallId: 't', name: 'view' }],
    }));
    const body = scope(event('body', 'assistant.message', { messageId: 'm', content }));
    const next = scope(event('next', 'assistant.message', { content: 'Another body' }));
    const blankUpdate = scope(event('blank-update', 'assistant.message', { messageId: 'm', content: whitespace }));
    const restored = scope(event('restored', 'assistant.message', { messageId: 'm', content }));
    const live = new NativeWindow(undefined, true);
    accept(live, setup, all);
    accept(live, [], liveAll);
    const rows = () => child ? live.snapshot().messages.find(item => item.subagent)!.subMessages! : live.snapshot().messages;
    if (withDelta) accept(live, [
      scope(ephemeral('start', 'assistant.message_start', { messageId: 'm' })),
      scope(ephemeral('delta', 'assistant.message_delta', { messageId: 'm', deltaContent: 'Draft' })),
    ], liveAll);
    accept(live, [first], liveAll);
    assert.deepEqual(rows().map(item => item.id), ['tool-t']);
    live.disconnect();
    assert.equal(live.partial, false);
    accept(live, [body, next], liveAll);
    assert.deepEqual(rows().map(item => item.id), ['tool-t', 'm', 'next']);
    assert.equal(rows()[1].content, content);
    accept(live, [blankUpdate], liveAll);
    assert.deepEqual(rows().map(item => item.id), ['tool-t', 'm', 'next']);
    assert.equal(rows()[1].content, whitespace);
    assert.equal(rows()[1].provisional, undefined);
    accept(live, [restored], liveAll);
    assert.deepEqual(rows().map(item => item.id), ['tool-t', 'm', 'next']);
    assert.equal(rows()[1].content, content);
    const journal = [...setup, first, body, next, blankUpdate, restored];
    for (let split = 0; split <= journal.length; split++) {
      const cold = new NativeWindow(undefined, true);
      accept(cold, journal.slice(split), all);
      accept(cold, journal.slice(0, split), all);
      assert.deepEqual(live.snapshot().messages, cold.snapshot().messages);
    }
  }
});

test('later message reasoning retires previously linked streams without touching an equal root identity', () => {
  for (const child of [false, true]) for (const reconnect of [false, true]) {
    const scope = (value: NativeChatEvent) => child ? owned('child', value) : value;
    const window = new NativeWindow(undefined, true);
    accept(window, child ? [taskMessage('task', 'spawn'), spawn('spawn', 'child')] : [], all);
    accept(window, [], liveAll);
    if (child) accept(window, [ephemeral('root-partial', 'assistant.reasoning_delta', {
      reasoningId: 'r', deltaContent: 'Independent root',
    })], liveAll);
    const first = scope(event('first', 'assistant.message', { messageId: 'm', content: 'Body' }));
    const final = scope(event('final', 'assistant.message', {
      messageId: 'm', content: 'Body', reasoningText: 'Complete',
    }));
    accept(window, [
      scope(ephemeral('partial', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Partial' })),
      scope(ephemeral('start', 'assistant.message_start', { messageId: 'm' })),
      first,
    ], liveAll);
    const rows = () => child ? window.snapshot().messages.find(item => item.subagent)!.subMessages! : window.snapshot().messages;
    assert.deepEqual(rows().map(item => [item.id, item.provisional]), [['m', undefined], ['reasoning-r', true]]);
    if (reconnect) {
      window.disconnect();
      assert.equal(window.partial, true);
    }
    accept(window, [final], liveAll);
    assert.deepEqual(rows().map(item => [item.id, item.thought, item.provisional]), [
      ['m', undefined, undefined], ['reasoning-message-m', 'Complete', undefined],
    ]);
    accept(window, [scope(ephemeral('late', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Late suffix' }))], liveAll);
    assert.equal(rows().some(item => item.id === 'reasoning-r'), false);
    if (child) {
      assert.equal(window.snapshot().messages.find(item => item.id === 'reasoning-r')?.thought, 'Independent root');
      accept(window, [event('root-final', 'assistant.reasoning', { reasoningId: 'r', content: 'Whole root' })], liveAll);
    }
    window.disconnect();
    assert.equal(window.partial, false, 'no reconciled stream remains to mark a disconnect partial');
    accept(window, [], liveAll);
    accept(window, [
      scope(event('next', 'assistant.message', { content: 'New completed message' })),
      scope(event('idle', 'session.idle')),
    ], liveAll);
    assert.equal(window.partial, false);
    assert.equal(rows().some(item => item.provisional), false);
    const cold = new NativeWindow(undefined, true);
    accept(cold, [first, final, scope(event('next', 'assistant.message', { content: 'New completed message' })),
      scope(event('idle', 'session.idle'))].map(value => ({ ...value, agentId: undefined })), all);
    assert.deepEqual(rows(), cold.snapshot().messages);
  }
});

test('provisional tails promote in durable append order without reordering any confirmed pair', () => {
  for (const child of [false, true]) for (const thoughtFirst of [false, true]) {
    const scope = (value: NativeChatEvent) => child ? owned('child', value) : value;
    const setup = child ? [taskMessage('task', 'spawn'), spawn('spawn', 'child')] : [];
    const thought = scope(event('thought-final', 'assistant.reasoning', { reasoningId: 'r', content: 'Whole thought' }));
    const body = scope(event('body-final', 'assistant.message', { messageId: 'm', content: 'Whole body' }));
    const sequence = [
      scope(ephemeral('r-delta', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Partial thought' })),
      scope(ephemeral('m-start', 'assistant.message_start', { messageId: 'm' })),
      scope(ephemeral('m-delta', 'assistant.message_delta', { messageId: 'm', deltaContent: 'Partial body' })),
      ...(thoughtFirst ? [thought, body] : [body, thought]),
      scope(event('later', 'assistant.message', { content: 'Later content' })),
      scope(event('body-update', 'assistant.message', { messageId: 'm', content: 'Updated body' })),
    ];
    const live = new NativeWindow(undefined, true);
    accept(live, setup, all);
    accept(live, [], liveAll);
    let confirmed: string[] = [];
    const durable: NativeChatEvent[] = [...setup];
    for (const item of sequence) {
      accept(live, [item], liveAll);
      if (!item.ephemeral) durable.push(item);
      const rows = child ? live.snapshot().messages.find(item => item.subagent)!.subMessages! : live.snapshot().messages;
      const next = rows.filter(row => !row.provisional).map(row => row.id);
      assert.deepEqual(next.filter(id => confirmed.includes(id)), confirmed);
      assert.equal(rows.slice(next.length).every(row => row.provisional), true);
      const cold = new NativeWindow(undefined, true);
      accept(cold, durable, all);
      const expected = child ? cold.snapshot().messages.find(item => item.subagent)!.subMessages! : cold.snapshot().messages;
      assert.deepEqual(rows.filter(row => !row.provisional), expected);
      confirmed = next;
    }
    assert.deepEqual(confirmed, thoughtFirst ? ['reasoning-r', 'm', 'later'] : ['m', 'reasoning-r', 'later']);
    const cold = new NativeWindow(undefined, true);
    accept(cold, durable, all);
    assert.deepEqual(live.snapshot().messages, cold.snapshot().messages);
  }
});

test('new final reasoning follows an already durable body and preserves differing snapshots intact', () => {
  const history = [
    event('first', 'assistant.message', { messageId: 'm', content: 'Body first' }),
    event('other', 'assistant.message', { content: 'Interleaved' }),
    event('final', 'assistant.message', { messageId: 'm', content: 'Body updated', reasoningText: 'Complete\n\nUncut' }),
    event('independent', 'assistant.reasoning', { reasoningId: 'r', content: 'Complete\n\nUncut' }),
  ];
  const live = new NativeWindow(undefined, true);
  accept(live, [], liveAll);
  accept(live, history.slice(0, 2), liveAll);
  const other = live.snapshot().messages[1];
  accept(live, history.slice(2), liveAll);
  assert.equal(live.snapshot().messages[1], other);
  assert.deepEqual(live.snapshot().messages.map(item => [item.id, item.thought]), [
    ['m', undefined], ['other', undefined], ['reasoning-message-m', 'Complete\n\nUncut'], ['reasoning-r', 'Complete\n\nUncut'],
  ]);
  for (let split = 0; split <= history.length; split++) {
    const paged = new NativeWindow(undefined, true);
    accept(paged, history.slice(split), all);
    accept(paged, history.slice(0, split), all);
    assert.deepEqual(paged.snapshot().messages, live.snapshot().messages);
  }
});

test('older reasoning repair keeps unresolved stream links until the later same-message final reconciles them', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [], liveAll);
  const first = event('first', 'assistant.message', { messageId: 'm', content: 'Body' });
  accept(window, [
    ephemeral('partial', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Partial' }),
    ephemeral('start', 'assistant.message_start', { messageId: 'm' }),
    first,
  ], liveAll);
  const older = event('older', 'assistant.reasoning', { reasoningId: 'older', content: 'Earlier independent' });
  accept(window, [older], all);
  const final = event('final', 'assistant.message', { messageId: 'm', content: 'Body', reasoningText: 'Complete' });
  accept(window, [final], liveAll);
  accept(window, [ephemeral('late', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Late' })], liveAll);
  const cold = new NativeWindow(undefined, true);
  accept(cold, [older, first, final], all);
  assert.deepEqual(window.snapshot().messages, cold.snapshot().messages);
  window.disconnect();
  assert.equal(window.partial, false);
});

test('repeated message writes cannot equate an earlier fallback with an independent later equal thought', () => {
  const history = [
    event('initial', 'assistant.message', { messageId: 'm', content: 'Initial body', reasoningText: 'A' }),
    event('later', 'assistant.reasoning', { reasoningId: 'r', content: 'A' }),
    event('intermediate', 'assistant.message', { messageId: 'm', content: 'Intermediate body', reasoningText: 'A' }),
    event('final', 'assistant.message', { messageId: 'm', content: 'Final body', reasoningText: 'A' }),
  ];
  const live = new NativeWindow(undefined, true);
  accept(live, [], liveAll);
  for (const value of history) accept(live, [value], liveAll);
  assert.deepEqual(live.snapshot().messages.map(item => [item.id, item.content, item.thought]), [
    ['reasoning-message-m', '', 'A'], ['m', 'Final body', undefined], ['reasoning-r', '', 'A'],
  ]);
  for (let size = 1; size <= history.length; size++) {
    const cold = new NativeWindow(undefined, true);
    for (let end = history.length; end > 0; end -= size) {
      accept(cold, history.slice(Math.max(0, end - size), end), all);
    }
    assert.deepEqual(cold.snapshot().messages, live.snapshot().messages);
  }
});

test('a later durable thought does not retroactively inherit its provisional link to an earlier body', () => {
  const journal = [
    event('first', 'assistant.message', { messageId: 'm', content: 'Body' }),
    event('thought', 'assistant.reasoning', { reasoningId: 'r', content: 'A' }),
    event('idle', 'session.idle'),
    event('final', 'assistant.message', { messageId: 'm', content: 'Updated body', reasoningText: 'A' }),
  ];
  const live = new NativeWindow(undefined, true);
  accept(live, [], liveAll);
  accept(live, [
    ephemeral('partial', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Partial' }),
    ephemeral('start', 'assistant.message_start', { messageId: 'm' }),
  ], liveAll);
  for (const item of journal) accept(live, [item], liveAll);
  assert.deepEqual(live.snapshot().messages.map(item => [item.id, item.thought]), [
    ['m', undefined], ['reasoning-r', 'A'], ['reasoning-message-m', 'A'],
  ]);
  const cold = new NativeWindow(undefined, true);
  accept(cold, journal, all);
  assert.deepEqual(live.snapshot().messages, cold.snapshot().messages);
});
