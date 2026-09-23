import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionMeta, SessionProjection } from '@cockpit/protocol';
import { ChatMessage } from '@cockpit/protocol/validation';
import { createCockpitStore } from '../net/store';
import { groupTranscript } from '../lib/transcriptRows';
import { installWorkspaceFixture, workspaceSessionId, workspaceSessions } from './workspace-fixtures';
import { cockpitApi } from '../net/api';

test('workspace scene has realistic contract-valid input, nested work and both old and latest tool groups', () => {
  const sessions = workspaceSessions(1_789_441_200_000);
  assert.ok(sessions.length > 1);
  for (const session of sessions) {
    SessionMeta.parse(session);
    session.messages.forEach(message => ChatMessage.parse(message));
    assert.match(session.cwd, /^\/workspace\//);
  }
  const session = sessions[0];
  assert.equal(session.sessionId, workspaceSessionId);
  const rows = groupTranscript(session.messages);
  assert.ok(rows.filter(row => row.kind === 'process').length >= 2);
  assert.equal(rows.at(-1)?.kind, 'process');
  assert.ok(session.messages.filter(message => message.role === 'user').length >= 2);
  const agent = session.messages.find(message => message.subtype === 'subagent');
  assert.ok(agent?.subMessages?.length);
  assert.ok(session.availableModels?.some(model => model.supportsLongContext));
});

test('workspace App lifecycle, settings and sends use only local synthetic state', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('The workspace fixture must not use HTTP'); });
  const store = createCockpitStore();
  installWorkspaceFixture(store, 1_789_441_200_000);
  const stop = store.getState().init();
  t.after(stop);
  assert.equal(store.getState().snapshotReady, true);
  SessionProjection.parse(await store.getState().getResources(workspaceSessionId, ['model', 'models']));
  const secondId = store.getState().sessions[1].sessionId;
  store.getState().setActiveId(secondId);
  assert.equal(store.getState().activeId, secondId);
  await cockpitApi.setModel(workspaceSessionId, 'gpt-5.4-mini', { reasoningEffort: 'medium' });
  const active = () => store.getState().sessions.find(session => session.sessionId === workspaceSessionId)!;
  assert.equal(active().currentModelId, 'gpt-5.4-mini');
  await store.getState().sendDraft({ intent: 'prompt', body: { sessionId: workspaceSessionId, text: 'Synthetic user input' } });
  assert.equal(active().messages.at(-1)?.content, 'Synthetic user input');
  await store.getState().cancel(workspaceSessionId);
  assert.equal(active().status, 'idle');
  await assert.rejects(store.getState().getResources('not-a-fixture', ['model']), /Unknown synthetic session/);
  await assert.rejects(store.getState().newSession('/workspace/unused'), /未连接/);
  assert.equal(fetch.mock.callCount(), 0);
});
