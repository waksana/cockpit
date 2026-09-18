import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '../net/types';
import { EMPTY_CHAT_WINDOW, ModuleChatWindow, type WindowSource } from './moduleChatWindow';

function message(id: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `row-${id}`, role: 'assistant', content: id, timestamp: 100,
    origin: { sessionId: 'A', messageId: id }, ...patch };
}
function session(patch: Partial<WindowSource> = {}): WindowSource {
  return { sessionId: 'A', messages: [], materialized: true, hasMore: false, loadingHistory: false,
    historyStale: false, ...patch };
}

test('current-window projection is lazy, immutable, ordered and reuses unchanged message metadata', () => {
  const view = new ModuleChatWindow();
  assert.equal(view.getSnapshot(), EMPTY_CHAT_WINDOW);
  let reads = 0;
  const first: ChatMessage = { ...message('first', { timestamp: 900 }), get content() { reads++; return 'First text'; } };
  const second = message('second', { timestamp: 1, streaming: true });
  const source = session({ messages: [first, second], hasMore: true });
  assert.equal(view.update('A', source, true), true);
  assert.equal(reads, 0, 'no body projection before a consumer reads');
  const snapshot = view.getSnapshot();
  assert.equal(view.getSnapshot(), snapshot);
  assert.equal(reads, 1);
  assert.deepEqual(snapshot.messages.map(row => [row.origin?.messageId, row.complete]), [['first', true], ['second', false]]);
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.hasMore, true, 'loaded window is not represented as all history');
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.messages));
  assert.ok(Object.isFrozen(snapshot.messages[0]) && Object.isFrozen(snapshot.messages[0].origin));
  assert.throws(() => Object.assign(snapshot.messages[0], { text: 'corrupted' }), TypeError);
  assert.equal(first.content, 'First text');
  assert.equal(view.update('A', { ...source }, true), false);
  assert.equal(view.getSnapshot(), snapshot);
  assert.equal(view.update('A', { ...source, messages: [first, { ...second, streaming: false, content: 'Final text' }] }, true), true);
  assert.equal(view.getSnapshot().messages[0], snapshot.messages[0]);
  assert.equal(view.getSnapshot().messages[1].complete, true);
  assert.equal(view.getSnapshot().messages[1].text, 'Final text');
});

test('nested agents retain source hierarchy and native ownership; unknown identities stay unknown', () => {
  const view = new ModuleChatWindow();
  const child = message('child', { origin: { sessionId: 'A', messageId: 'child', agentId: 'agent' } });
  view.update('A', session({ messages: [
    message('card', { subtype: 'subagent', subMessages: [child] }),
    message('unattributed', { origin: undefined, incomplete: 'Missing parent' }),
    message('skill', { subtype: 'skill' }),
  ], partialHistory: true }), true);
  const snapshot = view.getSnapshot();
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.messages.length, 3);
  assert.equal(snapshot.messages[0].subtype, 'subagent');
  assert.deepEqual(snapshot.messages[0].children[0].origin, child.origin);
  assert.ok(Object.isFrozen(snapshot.messages[0].children));
  assert.equal(snapshot.messages[1].origin, null);
  assert.equal(snapshot.messages[1].complete, false);
  assert.equal(snapshot.messages[2].subtype, 'skill');
});

test('unavailable, loading, empty, stale and failed windows are distinct and never borrow another session', () => {
  const view = new ModuleChatWindow();
  view.update('A', undefined, true);
  assert.equal(view.getSnapshot().status, 'unavailable');
  view.update('A', session({ materialized: false, loadingHistory: true }), true);
  assert.equal(view.getSnapshot().status, 'loading');
  view.update('A', session(), true);
  assert.equal(view.getSnapshot().status, 'ready');
  assert.deepEqual(view.getSnapshot().messages, []);
  const populated = session({ messages: [message('kept')] });
  view.update('A', populated, false);
  assert.equal(view.getSnapshot().status, 'stale');
  assert.equal(view.getSnapshot().messages[0].text, 'kept');
  view.update('A', { ...populated, historyStale: true }, true);
  assert.equal(view.getSnapshot().status, 'stale');
  view.update('A', { ...populated, historyError: 'Synthetic read failed' }, true);
  assert.equal(view.getSnapshot().status, 'error');
  assert.equal(view.getSnapshot().error, 'Synthetic read failed');
  view.update('B', populated, true);
  assert.equal(view.getSnapshot().sessionId, 'B');
  assert.equal(view.getSnapshot().status, 'unavailable');
  assert.deepEqual(view.getSnapshot().messages, []);
  view.update(null, undefined, false);
  assert.deepEqual(view.getSnapshot(), EMPTY_CHAT_WINDOW);
});
