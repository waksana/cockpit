import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldEvent, newFoldState } from './chat.ts';

test('steering is one native user message within the current response lifetime', () => {
  const state = newFoldState();
  foldEvent(state, { id: 'turn', type: 'assistant.turn_start', data: {} });
  foldEvent(state, { id: 'start', type: 'assistant.message_start', parentId: 'turn', data: { messageId: 'answer' } });
  foldEvent(state, { id: 'delta1', type: 'assistant.message_delta', parentId: 'turn', data: { messageId: 'answer', deltaContent: 'Before ' } });
  const active = state.activeResponse;
  const steering = { id: 'steered-event', type: 'user.message',
    data: { content: 'Do not commit', messageId: 'original-queued-id', delivery: 'steering' } };
  foldEvent(state, steering);
  assert.equal(state.activeResponse, active);
  foldEvent(state, steering);
  foldEvent(state, { id: 'delta2', type: 'assistant.message_delta', parentId: 'turn', data: { messageId: 'answer', deltaContent: 'after' } });
  assert.equal(state.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(state.messages.find(message => message.id === 'answer')?.content, 'Before after');
  foldEvent(state, { id: 'queued-turn', type: 'user.message', data: { content: 'Next', delivery: 'queued' } });
  assert.equal(state.activeResponse, undefined);
});
