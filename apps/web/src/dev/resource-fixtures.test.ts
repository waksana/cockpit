import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from 'sass';
import { Intents, SessionMeta, McpServerSession, SkillSession } from '@cockpit/protocol';
import { createCockpitStore } from '../net/store';
import { installResourceFixture } from './resource-fixtures';
import { workspaceSessionId } from './workspace-fixtures';

test('design scenarios cover short authoritative summaries, missing config and real native failures without a backend', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Fixture must not use HTTP'); });
  const store = createCockpitStore();
  installResourceFixture(store, true, { designCases: true });
  const global = await store.getState().mcpGlobal();
  Intents['mcp/global'].result.parse({ servers: global });
  assert.deepEqual(global.find(row => row.name === 'http-long-endpoint')?.connection, { method: 'http', target: 'fixture.example' });
  assert.equal(global.find(row => row.name === 'local-long-command')?.connection?.target, 'node');
  assert.equal(global.find(row => row.name === 'sse-endpoint')?.connection?.method, 'sse');
  assert.equal(global.find(row => row.name === 'custom-transport')?.connection?.method, 'unknown');
  assert.equal(global.find(row => row.name === 'missing-config')?.config, undefined);
  const session = await store.getState().mcpSession(workspaceSessionId);
  assert.ok(session.every(row => !('connection' in row)), 'session transport is not provided, including for same global names');
  assert.deepEqual(session.slice(3).map(row => row.status), ['failed', 'needs-auth', 'stopped', 'not_configured']);
  assert.match(session[3].error!, /^Connection refused by synthetic host\n/);
  const skills = await store.getState().skillsSession(workspaceSessionId);
  assert.ok(['native', 'builtin', 'custom', 'personal-copilot', 'personal-agents', 'project', 'inherited', 'plugin']
    .every(source => skills.some(row => row.source === source)));
  assert.equal(fetch.mock.callCount(), 0);
});

test('the maintained lab compiles shared styles instead of redefining its button controls', () => {
  const css = compile(new URL('./chat-lab.scss', import.meta.url).pathname).css;
  assert.match(css, /@media \(max-width: 599px\)/);
  assert.doesNotMatch(css, /\.lab-toolbar (?:button|:focus-visible)/);
});

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

test('global resource fixtures use native contracts, isolated mutations and explicit empty/error/loading states', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Fixture must not use HTTP'); });
  const store = createCockpitStore();
  installResourceFixture(store);
  const state = store.getState();
  const mcp = await state.mcpGlobal();
  Intents['mcp/global'].result.parse({ servers: mcp });
  assert.deepEqual(mcp[0].modules?.[0].roles?.map(role => role.id), ['executor', 'owner']);
  assert.equal(mcp[1].modules, undefined);
  assert.equal(mcp[2].modules?.[0].roles, undefined);
  await state.mcpSetDefault(mcp[0].name, false);
  assert.equal((await state.mcpGlobal())[0].defaultOn, false);
  assert.equal((await state.mcpSession(workspaceSessionId))[0].enabled, true);
  const skills = await state.skillsGlobal();
  Intents['skills/global'].result.parse({ skills });
  assert.equal(skills.find(skill => skill.name === 'unknown-default')?.enabled, undefined);
  await state.skillsSetGlobal(skills[0].name, false);
  const skill = await state.skillsRead(skills[0].name);
  Intents['skills/read'].result.parse(skill);
  assert.equal(skill.enabled, false);
  assert.ok(skill.body?.includes('Synthetic skill body'));
  assert.equal((await state.skillsSession(workspaceSessionId))[0].enabled, true);
  installResourceFixture(store, false, { empty: true });
  assert.deepEqual(await store.getState().mcpGlobal(), []);
  assert.deepEqual(await store.getState().skillsSession(workspaceSessionId), []);
  installResourceFixture(store, false, { fail: true });
  await assert.rejects(store.getState().mcpGlobal(), /Synthetic resource failure/);
  await assert.rejects(store.getState().getResources(workspaceSessionId, ['models']), /Synthetic resource failure/);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  installResourceFixture(store, false, { beforeRequest: () => gate });
  let settled = false;
  const pending = store.getState().skillsGlobal().then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  assert.ok((await pending).length > 0);
  installResourceFixture(store, false, { failMutations: true });
  assert.ok((await store.getState().mcpGlobal()).length > 0);
  await assert.rejects(store.getState().mcpSetDefault('cockpit-task', false), /Synthetic mutation failure/);
  assert.equal((await store.getState().mcpGlobal())[0].defaultOn, true);
  assert.equal(fetch.mock.callCount(), 0);
});
