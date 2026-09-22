import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { SessionMeta, SessionProjection } from '@cockpit/protocol';
import { ChatMessage } from '@cockpit/protocol/validation';
import { createCockpitStore } from '../net/store';
import { installFullWebFixture } from './full-web-fixtures';
import { workspaceSessionId } from './workspace-fixtures';

test('full Web preview uses the actual App and only replaces its store data source', () => {
  const source = readFileSync(new URL('./activity-design-review.tsx', import.meta.url), 'utf8');
  const full = source.slice(source.indexOf('if (import.meta.env.COCKPIT_CONTROL_DESIGN_REVIEW)'), source.indexOf('} else {'));
  assert.match(full, /import\('\.\.\/App'\)/);
  assert.match(full, /<App \/>/);
  assert.doesNotMatch(full, /ControlDesignLab|ActivityDesignLab|chat-lab\.scss|composerControls/);
});

test('full Web fixtures have valid varied data and local settings without any HTTP', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('No fixture may use HTTP'); });
  const store = createCockpitStore();
  const id = installFullWebFixture(store, 'tool-loading');
  assert.equal(id, 'control-design-tool-loading');
  for (const session of store.getState().sessions) {
    SessionMeta.parse(session);
    session.messages.forEach(message => ChatMessage.parse(message));
    SessionProjection.parse(await store.getState().getResources(session.sessionId, ['identity', 'control', 'model']));
  }
  assert.ok(store.getState().sessions.some(session => !session.loaded));
  assert.ok(store.getState().sessions.some(session => session.ask));
  assert.ok(store.getState().sessions.some(session => session.planRequest));
  assert.ok(store.getState().sessions.some(session => session.elicitation));
  await store.getState().setModel(id, 'gpt-5.4-mini');
  assert.equal(store.getState().resourceRevisions[id]?.model, 1);
  assert.equal((await store.getState().getResources(id, ['model'])).currentModelId, 'gpt-5.4-mini');
  await store.getState().cancel(id);
  const session = store.getState().sessions.find(session => session.sessionId === id)!;
  assert.equal(session.currentModelId, 'gpt-5.4-mini');
  assert.equal(session.messages.at(-1)?.toolCalls?.[0].status, 'failed');
  const first = (await store.getState().mcpSession(id))[0];
  await store.getState().mcpToggleSession(id, first.name, false);
  assert.equal((await store.getState().mcpSession(id))[0].enabled, false);
  assert.equal((await store.getState().mcpSession(workspaceSessionId))[0].enabled, true);
  assert.equal(fetch.mock.callCount(), 0);
});

test('full Web prompt, queue and decisions mutate only the addressed synthetic session', async () => {
  const store = createCockpitStore();
  installFullWebFixture(store);
  await store.getState().sendDraft({ intent: 'prompt', body: { sessionId: workspaceSessionId, text: '只修改合成数据' } });
  const current = () => store.getState().sessions.find(value => value.sessionId === workspaceSessionId)!;
  assert.equal(current().queue?.at(-1)?.text, '只修改合成数据');
  await store.getState().removeQueued(workspaceSessionId, current().queue!.at(-1)!.id);
  assert.equal(current().queue?.length, 2);
  await store.getState().cancel(workspaceSessionId);
  assert.equal(current().activity?.processing, false);
  assert.equal(current().activity?.tasks.activeShells, 2, 'classic abort does not claim all background work ended');
  assert.equal(current().queue?.length, 0);
  const id = 'control-design-ask';
  const ask = store.getState().sessions.find(value => value.sessionId === id)!.ask!;
  assert.equal(await store.getState().respondAsk(id, ask.requestId, '采用', false), true);
  assert.equal(store.getState().sessions.find(value => value.sessionId === id)!.ask, null);
  await assert.rejects(store.getState().respondAsk(id, ask.requestId, '旧回答', true), /原问题已结束/);
});

test('new, load, reload and delete use synthetic models independent of the initial session', async () => {
  const store = createCockpitStore();
  installFullWebFixture(store);
  const unloaded = 'control-design-unloaded';
  await store.getState().sendDraft({ intent: 'prompt', body: { sessionId: unloaded, text: '恢复这个合成会话' } });
  assert.equal(store.getState().sessions.find(value => value.sessionId === unloaded)?.loaded, true);
  assert.equal(store.getState().sessions.find(value => value.sessionId === unloaded)?.messages.at(-1)?.content, '恢复这个合成会话');
  await assert.rejects(store.getState().deleteSession(workspaceSessionId), /仍有活动/);
  const id = await store.getState().newSession('/workspace/cockpit');
  assert.equal(store.getState().sessions.find(value => value.sessionId === id)?.messages.length, 0);
  await store.getState().reloadSession(id);
  await store.getState().deleteSession(id);
  assert.equal(store.getState().sessions.some(value => value.sessionId === id), false);
  await assert.rejects(store.getState().getResources(id, ['model']), /Unknown synthetic session/);
});

test('the full App control source removes confirmed stopped work from the active list immediately', async () => {
  const store = createCockpitStore();
  installFullWebFixture(store);
  const act = store.getState().sessionControlAction!;
  const current = () => store.getState().sessions.find(value => value.sessionId === workspaceSessionId)!;
  await act(workspaceSessionId, { type: 'stop-task', id: 'preview-build' });
  assert.equal(current().controls?.tasks.length, 2);
  assert.equal(current().activity?.tasks.activeShells, 1);
  assert.equal(current().controls?.main, true);
  assert.equal(current().controls?.tasks.length, 2);
  await act(workspaceSessionId, { type: 'stop-all' });
  assert.equal(current().activity?.hasActiveWork, false);
  assert.equal(current().queue?.length, 0);
  assert.equal(current().controls?.tasks.length, 0);
  assert.ok(current().messages.some(message => message.subtype === 'subagent'));
});

test('steering has distinct acceptance and consumption, with stop, session and disposal fencing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createCockpitStore();
  installFullWebFixture(store);
  const dispose = store.getState().init();
  const act = store.getState().sessionControlAction!;
  const current = () => store.getState().sessions.find(value => value.sessionId === workspaceSessionId)!;
  const before = current().messages.length;
  await act(workspaceSessionId, { type: 'steer', id: 'preview-q1' });
  assert.equal(current().controls?.steering.length, 1);
  assert.equal(current().messages.length, before);
  store.getState().setActiveId('control-design-idle');
  t.mock.timers.tick(700);
  assert.equal(current().messages.length, before + 1);
  assert.equal(current().controls?.steering.length, 0);
  assert.equal(current().messages.at(-1)?.content, '先不要提交');
  assert.equal(store.getState().sessions.find(value => value.sessionId === 'control-design-idle')?.messages.length, 2);
  await act(workspaceSessionId, { type: 'steer', id: 'preview-q2' });
  await act(workspaceSessionId, { type: 'stop-all' });
  t.mock.timers.tick(700);
  assert.equal(current().messages.length, before + 1, 'stopped steering never enters history');
  dispose();
  await assert.rejects(act(workspaceSessionId, { type: 'clear-queue' }), /已失效/);
});

test('agent details are task-owned even when their chat message is outside the loaded window', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('No fixture may use HTTP'); });
  const store = createCockpitStore();
  const id = installFullWebFixture(store, 'agent-unloaded');
  assert.equal(id, 'control-design-agent-unloaded');
  const before = store.getState().sessions.find(session => session.sessionId === id)!;
  assert.equal(before.messages.some(message => message.subtype === 'subagent'), false);
  const read = store.getState().readAgentTaskDetails!;
  const signal = new AbortController().signal;
  const detail = await read(id, 'preview-agent', signal);
  assert.equal(detail?.taskId, 'preview-agent');
  assert.equal(detail?.sessionId, id);
  assert.ok(detail?.recentActivity.length);
  assert.strictEqual(store.getState().sessions.find(session => session.sessionId === id)?.messages, before.messages);
  const peer = await read(workspaceSessionId, 'preview-agent', signal);
  assert.notEqual(peer?.description, detail?.description, 'same task IDs in different sessions never alias');
  await store.getState().sessionControlAction!(id, { type: 'stop-task', id: 'preview-agent' });
  assert.equal((await read(id, 'preview-agent', signal))?.status, 'cancelled');
  assert.equal(await read(id, 'missing-agent', signal), null);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(read(workspaceSessionId, 'preview-agent', cancelled.signal), /abort/i);
  assert.equal(fetch.mock.callCount(), 0);
});
