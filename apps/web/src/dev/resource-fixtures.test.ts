import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Intents, SessionMeta, McpServerSession, SkillSession } from '@cockpit/protocol';
import { createCockpitStore } from '../net/store';
import { installResourceFixture } from './resource-fixtures';
import { workspaceSessionId } from './workspace-fixtures';

test('resource scene exercises actual names and explicit provenance without HTTP', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Fixture must not use HTTP'); });
  const store = createCockpitStore();
  installResourceFixture(store);
  const state = store.getState();
  const roles = await state.listRoles();
  Intents['roles/list'].result.parse({ roles });
  const mcp = await state.mcpSession(workspaceSessionId);
  mcp.forEach(server => McpServerSession.parse(server));
  const skills = await state.skillsSession(workspaceSessionId);
  skills.forEach(skill => SkillSession.parse(skill));
  assert.equal(mcp[0].module?.name, 'Task');
  assert.deepEqual(mcp[0].module?.roles?.map(role => role.id), ['executor', 'owner']);
  assert.equal(mcp[1].module, undefined);
  assert.equal(mcp[2].module?.roles, undefined);
  assert.deepEqual(skills[0].module?.roles?.map(role => role.id), ['owner']);
  assert.deepEqual(skills[1].module?.roles?.map(role => role.id), ['executor']);
  assert.equal(skills[2].module, undefined);
  assert.deepEqual(skills[3].module, mcp[0].module);
  await state.mcpToggleSession(workspaceSessionId, mcp[0].name, false);
  assert.equal((await state.mcpSession(workspaceSessionId))[0].enabled, false);
  await state.skillsToggleSession(workspaceSessionId, skills[0].name, false);
  assert.equal((await state.skillsSession(workspaceSessionId))[0].enabled, false);
  const directory = await state.listDir();
  const id = await state.newSession(directory.path, roles.map(({ moduleId, roleId }) => ({ moduleId, roleId })));
  const created = store.getState().sessions.find(session => session.sessionId === id);
  SessionMeta.parse(created);
  assert.deepEqual(created?.roles?.map(role => role.roleId), ['owner', 'executor', 'reviewer']);
  const original = store.getState().sessions.find(session => session.sessionId === workspaceSessionId)!;
  const added = await state.addRoles(workspaceSessionId, [roles[2]]);
  Intents['roles/add'].result.parse(added);
  assert.equal(added.status, 'saved');
  assert.equal(added.rolesNeedReload, true);
  assert.deepEqual(added.appliedRoles, original.appliedRoles);
  assert.equal(added.sessionId, workspaceSessionId);
  const updated = store.getState().sessions.find(session => session.sessionId === workspaceSessionId)!;
  assert.deepEqual(updated.messages, original.messages);
  assert.equal(updated.cwd, original.cwd);
  assert.deepEqual(updated.roles?.slice(0, 2), original.roles);
  assert.equal((await state.roleReadiness(workspaceSessionId)).ready, false);
  const refreshed = await state.refreshRoles(workspaceSessionId);
  assert.deepEqual(refreshed.roles, updated.roles);
  assert.deepEqual(refreshed.appliedRoles, original.appliedRoles);
  assert.equal(refreshed.rolesNeedReload, true);
  assert.equal((await state.addRoles(workspaceSessionId, [roles[2]])).status, 'unchanged');
  await assert.rejects(state.newSession('/workspace', [{ moduleId: 'unknown', roleId: 'owner' }]), /Unknown synthetic role/);
  await assert.rejects(state.mcpToggleSession(workspaceSessionId, 'task', true), /Unknown synthetic MCP/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('resource role saving allows busy work and never loads an unloaded fixture', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Fixture must not use HTTP'); });
  for (const loaded of [true, false]) {
    const store = createCockpitStore();
    installResourceFixture(store);
    store.setState(state => ({ sessions: state.sessions.map(session => session.sessionId === workspaceSessionId
      ? { ...session, loaded, status: loaded ? 'running' : 'unloaded', scheduleCount: 1,
        activeSubagents: 1, queue: [{ id: 'queued', text: 'Fixture' }],
        ask: { requestId: 'ask', question: 'Continue?' }, appliedRoles: loaded ? session.appliedRoles : [] }
      : session) }));
    const state = store.getState();
    const roles = await state.listRoles();
    const result = await state.addRoles(workspaceSessionId, [roles[2]]);
    Intents['roles/add'].result.parse(result);
    assert.equal(result.status, 'saved');
    assert.equal(result.loaded, loaded);
    assert.equal(result.rolesNeedReload, loaded);
    const updated = store.getState().sessions.find(session => session.sessionId === workspaceSessionId)!;
    assert.equal(updated.loaded, loaded);
    assert.equal(updated.scheduleCount, 1);
    assert.equal(updated.ask?.requestId, 'ask');
    assert.equal(updated.queue?.length, 1);
    assert.equal((await state.roleReadiness(workspaceSessionId)).rolesNeedReload, loaded);
    assert.equal((await state.refreshRoles(workspaceSessionId)).loaded, loaded);
  }
  assert.equal(fetch.mock.callCount(), 0);
});
