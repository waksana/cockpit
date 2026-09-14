import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '@cockpit/protocol';
import { hasNewTranscriptContent } from './transcriptActivity';

const message: ChatMessage = { id: 'reply', role: 'assistant', content: 'Start', timestamp: 1 };

test('same-message text, reasoning and recorded tool updates are new content', () => {
  assert.equal(hasNewTranscriptContent([message], [{ ...message, content: 'Start and continue' }]), true);
  assert.equal(hasNewTranscriptContent([message], [{ ...message, thought: 'Thinking' }]), true);
  const tool: ChatMessage = { ...message, toolCalls: [{ toolCallId: 'call', title: 'Tool', status: 'in_progress' }] };
  assert.equal(hasNewTranscriptContent([tool], [{ ...tool, toolCalls: [{ ...tool.toolCalls![0], status: 'completed', output: 'Done' }] }]), true);
});

test('older prefixes, duplicate pages and metadata enrichment are not new content', () => {
  const earlier = { ...message, id: 'earlier', timestamp: 0 };
  assert.equal(hasNewTranscriptContent([message], [earlier, { ...message }]), false);
  assert.equal(hasNewTranscriptContent([message], [{ ...message }]), false);
  assert.equal(hasNewTranscriptContent([], [message]), false);
  assert.equal(hasNewTranscriptContent([message], [message, { ...message, id: 'new' }]), true);
});

test('nested replies follow the same activity rule without counting older child history', () => {
  const parent = { ...message, subMessages: [message] };
  assert.equal(hasNewTranscriptContent([parent], [{ ...parent, subMessages: [{ ...message, content: 'New text' }] }]), true);
  assert.equal(hasNewTranscriptContent([parent], [{ ...parent, subMessages: [{ ...message, id: 'older' }, message] }]), false);
});
