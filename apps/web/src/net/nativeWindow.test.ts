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
