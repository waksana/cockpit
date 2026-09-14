import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askAnswerOf, toolArgsOf, toolOutputOf } from '@cockpit/protocol/chat';
import { displayEvent } from './displayEvent';

test('browser retention drops large raw tool payloads but preserves the existing exact output cap', () => {
  const raw = 'tool output '.repeat(100_000);
  const source = { id: 'complete', type: 'tool.execution_complete', data: {
    toolCallId: 'tool', success: true, result: { content: raw, detailedContent: raw },
    toolTelemetry: { unused: raw },
  } };
  const retained = displayEvent(source);
  assert.equal(retained.display?.toolOutput, toolOutputOf(source.data.result));
  assert.match(retained.display!.toolOutput!, /1200000 字符/);
  assert.ok(JSON.stringify(retained).length < 4000);
  assert.equal(source.data.result.content, raw, 'native response is not mutated');
  assert.equal('result' in retained.data, false);
});

test('tool argument projection drops hidden task prompts without changing visible tool arguments', () => {
  const args = { command: 'long command '.repeat(10_000) };
  const retained = displayEvent({ id: 'message', type: 'assistant.message', data: { toolRequests: [
    { toolCallId: 'bash', name: 'bash', arguments: args },
    { toolCallId: 'task', name: 'task', arguments: {
      prompt: 'private task context '.repeat(100_000), description: 'Research', agent_type: 'explore',
    } },
  ] } });
  assert.equal(retained.display?.toolArgs, undefined);
  assert.equal((retained.data.toolRequests as { name: string }[]).some(request => request.name === 'bash'), false);
  assert.ok(JSON.stringify(retained).length < 8000);
  assert.ok(!JSON.stringify(retained.data).includes('private task context'));
  const start = displayEvent({ id: 'start', type: 'tool.execution_start', data: {
    toolCallId: 'bash', toolName: 'bash', arguments: args,
  } });
  assert.equal(start.display?.toolArgs, toolArgsOf('bash', args));
  assert.ok(JSON.stringify(start).length < 4000);
  assert.equal(start.data.arguments, undefined);
});

test('ask replies retain the whole accepted answer and never manufacture one from failed or dismissed results', () => {
  const answer = 'long user answer '.repeat(2000);
  for (const data of [
    { result: { content: `User selected: ${answer}` } },
    { result: { detailedContent: `User responded: ${answer}` } },
    { result: { content: `User selected: ${answer}` }, success: false },
    { result: { content: `User selected: ${answer}`, dismissed: true } },
    { result: { content: `User selected: ${answer}` }, toolTelemetry: { properties: { outcome: 'cancelled' } } },
  ]) {
    assert.equal(displayEvent({ id: 'answer', type: 'tool.execution_complete', data }).display?.askAnswer, askAnswerOf(data));
  }
});

test('skill context injections retain an event identity without hidden prompt bytes', () => {
  const retained = displayEvent({ id: 'skill', type: 'user.message',
    data: { source: 'skill-review', content: 'hidden context '.repeat(100_000) } });
  assert.deepEqual(retained.data, { source: 'skill-review' });
  assert.equal(retained.id, 'skill');
});
