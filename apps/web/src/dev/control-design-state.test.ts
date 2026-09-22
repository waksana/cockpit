import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionMeta } from '@cockpit/protocol';
import { ChatMessage } from '@cockpit/protocol/validation';
import { applyControlAction, canSteer, controlDesignState, controlScenes, controlSession } from './control-design-state';

test('all control design scenes are valid synthetic sessions and retain independent agent cards', () => {
  for (const [scene] of controlScenes) {
    const state = controlDesignState(scene);
    const session = controlSession(state);
    SessionMeta.parse(session);
    session.messages.forEach(message => ChatMessage.parse(message));
    assert.equal(session.messages.filter(message => message.subtype === 'subagent').length,
      state.tasks.filter(task => task.kind === 'agent').length);
    assert.equal(session.messages.some(message => message.toolCalls?.some(tool => tool.name === 'task')), false);
  }
});

test('stopping main preserves tasks, queued messages and transcript', () => {
  const initial = controlDesignState('mixed');
  const stopped = applyControlAction(initial, { type: 'stop-main' });
  assert.equal(stopped.main, false);
  assert.strictEqual(stopped.tasks, initial.tasks);
  assert.strictEqual(stopped.queue, initial.queue);
  assert.strictEqual(stopped.session.messages, initial.session.messages);
  assert.equal(controlSession(stopped).status, 'running');
});

test('targeted cancellation leaves peers and prior output intact and updates the separate agent card', () => {
  const initial = controlDesignState('mixed');
  const shell = applyControlAction(initial, { type: 'stop-task', id: 'preview-build' });
  assert.equal(shell.tasks.filter(task => task.status === 'running').length, 2);
  assert.deepEqual(shell.session.messages, initial.session.messages);
  const agent = applyControlAction(shell, { type: 'stop-task', id: 'preview-agent' });
  assert.equal(agent.session.messages.find(message => message.subagent)?.subagent?.status, 'cancelled');
  assert.equal(agent.session.messages.length, initial.session.messages.length);
  assert.throws(() => applyControlAction(agent, { type: 'stop-task', id: 'preview-agent' }), /任务已不在运行/);
});

test('immediate send preserves logical identity and creates history only after consumption', () => {
  const initial = controlDesignState('mixed');
  const item = initial.queue[0];
  const accepted = applyControlAction(initial, { type: 'steer', id: item.id });
  assert.equal(accepted.events.length, 0);
  assert.strictEqual(accepted.session.messages, initial.session.messages);
  assert.equal(accepted.queue.length, 1);
  assert.strictEqual(accepted.steering[0], item);
  assert.throws(() => applyControlAction(accepted, { type: 'steer', id: item.id }), /已不在待发送队列/);
  const consumed = applyControlAction(accepted, { type: 'consume' });
  assert.equal(consumed.steering.length, 0);
  assert.deepEqual(consumed.events[0].data, { content: item.text, messageId: item.id, delivery: 'steering' });
  assert.equal(consumed.session.messages.at(-1)?.role, 'user');
  assert.equal(consumed.session.messages.at(-1)?.content, item.text);
  assert.equal(consumed.main, true);
  assert.equal(applyControlAction(consumed, { type: 'consume' }).events.length, 1);
});

test('queue clearing never clears history or cancels the main turn or tasks', () => {
  const initial = controlDesignState('mixed');
  const consumed = applyControlAction(applyControlAction(initial, { type: 'steer', id: initial.queue[0].id }), { type: 'consume' });
  const cleared = applyControlAction(consumed, { type: 'clear-queue' });
  assert.equal(cleared.queue.length, 0);
  assert.strictEqual(cleared.session, consumed.session);
  assert.strictEqual(cleared.tasks, consumed.tasks);
  assert.strictEqual(cleared.events, consumed.events);
  assert.equal(cleared.main, true);
});

test('background work and native decisions do not enable steering', () => {
  for (const scene of ['background', 'ask'] as const) {
    const state = controlDesignState(scene);
    assert.equal(canSteer(state), false);
    assert.throws(() => applyControlAction(state, { type: 'steer', id: state.queue[0].id }), /没有可接收/);
    assert.equal(state.queue.length, 2);
  }
  for (const scene of ['manual', 'auto', 'idle', 'plan', 'elicitation'] as const) assert.equal(canSteer(controlDesignState(scene)), false);
});

test('only manual compaction offers cancellation', () => {
  assert.equal(applyControlAction(controlDesignState('manual'), { type: 'cancel-compaction' }).compaction, null);
  assert.throws(() => applyControlAction(controlDesignState('auto'), { type: 'cancel-compaction' }), /不是可取消/);
});

test('a late answer cannot restart a stopped turn or answer a replacement decision', () => {
  const initial = controlDesignState('ask');
  const answer = { type: 'answer' as const, id: 'answer', kind: 'ask' as const,
    requestId: initial.session.ask!.requestId, text: '继续' };
  const stopped = applyControlAction(initial, { type: 'stop-main' });
  assert.throws(() => applyControlAction(stopped, answer), /原问题已结束/);
  assert.equal(stopped.main, false);
  assert.strictEqual(stopped.session.messages, initial.session.messages);
  const replacement = { ...initial, session: { ...initial.session, ask: { ...initial.session.ask!, requestId: 'new' } } };
  assert.throws(() => applyControlAction(replacement, answer), /原问题已结束/);
  assert.equal(applyControlAction(initial, answer).session.ask, null);
});

test('new prompts queue during a main turn and start one when only background tasks remain', () => {
  const main = applyControlAction(controlDesignState('main'), { type: 'send', id: 'new', text: '合成输入' });
  assert.equal(main.queue[0].text, '合成输入');
  assert.equal(main.events.length, 0);
  const background = applyControlAction(controlDesignState('background'), { type: 'send', id: 'new', text: '合成输入' });
  assert.equal(background.events[0].data.delivery, 'idle');
  assert.equal(background.tasks.length, 3);
  assert.equal(background.main, true);
});
