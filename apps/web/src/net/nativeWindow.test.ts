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
  assert.equal(window.snapshot().messages[0].toolCalls?.[0].output, 'result');
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
  const tool = window.snapshot().messages[0].toolCalls?.[0];
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
