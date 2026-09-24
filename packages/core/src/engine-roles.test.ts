import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { CopilotSession } from '@github/copilot-sdk';
import { Engine, type EngineRuntime } from './engine.ts';
import type { RoleProvider } from './roles.ts';
import {
  type McpState,
  type ServerSkill,
  type Skill,
  deferred,
  harness,
  mcpState,
  protectedWork,
  queued,
  schedule,
  task,
  unavailableSession,
  user,
} from '../test-support/engine-harness.ts';

async function roleAdditionFixture(t: TestContext) {
  const h = harness(t);
  const catalog = ['executor', 'owner'].map(roleId => ({
    moduleId: 'fixture', moduleName: 'Fixture', roleId, name: roleId,
  }));
  const saved = new Map<string, typeof catalog>();
  const provider: RoleProvider = {
    list: () => catalog, read: id => saved.get(id) ?? [],
    save: (id, roles) => { saved.set(id, roles); },
    assemble: async (id, choices) => {
      const roles = catalog.filter(role => choices.some(choice => choice.moduleId === role.moduleId && choice.roleId === role.roleId));
      if (roles.length !== choices.length) throw new Error('Unknown role selection');
      return { roles, fingerprint: roles.map(role => role.roleId).join('+'), skills: [],
        config: { systemMessage: { mode: 'append' as const, content: `Roles for ${id}: ${roles.map(role => role.roleId).join(',')}` } } };
    },
  };
  h.engine.setRoleProvider(provider);
  const id = await h.engine.newSession(h.cwd);
  const native = h.natives.get(id)!;
  native.state.events.push(user('synthetic-history'));
  return { ...h, id, native, catalog, saved, provider };
}

test('concurrent role additions with asynchronous reads keep every saved role', async t => {
  const h = await roleAdditionFixture(t);
  t.mock.method(h.provider, 'read', async (id: string) => { await nextTurn(); return h.saved.get(id) ?? []; });
  const results = await Promise.all(h.catalog.map(role => h.engine.addRoles(h.id, [role])));
  assert.deepEqual(results.map(result => result.status), ['saved', 'saved']);
  assert.deepEqual(h.saved.get(h.id)?.map(role => role.roleId).sort(), ['executor', 'owner']);
});

test('role addition only saves metadata; explicit reload applies the union to the same session', async t => {
  const h = await roleAdditionFixture(t);
  const before = structuredClone(h.native.state.events);
  const config = h.configs.get(h.id);
  const assemble = t.mock.method(h.provider, 'assemble');
  const first = await h.engine.addRoles(h.id, [h.catalog[0]!]);
  assert.equal(first.status, 'saved', JSON.stringify(first));
  assert.equal(first.rolesNeedReload, true);
  assert.deepEqual(first.appliedRoles, []);
  const second = await h.engine.addRoles(h.id, [h.catalog[1]!, h.catalog[1]!]);
  assert.equal(second.status, 'saved');
  assert.deepEqual(second.roles, h.catalog);
  assert.equal(assemble.mock.callCount(), 0, 'composition is deferred to normal loading');
  assert.equal(h.configs.get(h.id), config);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.native.sdk.send.mock.callCount(), 0);
  assert.equal(h.native.sdk.abort.mock.callCount(), 0);
  assert.deepEqual(h.native.state.events, before);
  assert.equal((await h.engine.getMeta(h.id))?.cwd, h.cwd);
  for (const meta of [(await h.engine.getMeta(h.id))!, (await h.engine.listLive())[0]!]) {
    assert.deepEqual(meta.roles, h.catalog);
    assert.deepEqual(meta.appliedRoles, []);
    assert.equal(meta.rolesNeedReload, true);
  }
  const duplicate = await h.engine.addRoles(h.id, h.catalog);
  assert.equal(duplicate.status, 'unchanged');
  assert.equal(duplicate.rolesNeedReload, true);
  assert.equal((await h.engine.roleReadiness(h.id)).ready, false);
  await h.engine.reload(h.id);
  const applied = (await h.engine.getMeta(h.id))!;
  assert.equal(applied.sessionId, h.id);
  assert.deepEqual(applied.appliedRoles, h.catalog);
  assert.equal(applied.rolesNeedReload, false);
  assert.equal((await h.engine.roleReadiness(h.id)).ready, true);
  assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.deepEqual(h.native.state.events, before);
  await h.engine.unload(h.id);
  const unloaded = await h.engine.addRoles(h.id, h.catalog);
  assert.equal(unloaded.status, 'unchanged');
  assert.equal(unloaded.loaded, false);
  assert.equal(unloaded.rolesNeedReload, false);
  assert.deepEqual(unloaded.appliedRoles, []);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1, 'saving does not load');
  await h.engine.load(h.id);
  assert.deepEqual((await h.engine.getMeta(h.id))?.appliedRoles, h.catalog);
});

for (const activity of ['main', 'subagent', 'shell', 'queue', 'steering', 'mcp', 'ask', 'plan', 'schedule'] as const) {
  test(`role addition saves during ${activity} without touching native work`, async t => {
    const h = await roleAdditionFixture(t);
    let answer: Promise<unknown> | undefined;
    switch (activity) {
      case 'main': h.native.state.processing = true; break;
      case 'subagent': h.native.state.tasks = [task()]; break;
      case 'shell': h.native.state.activeWork = true; break;
      case 'queue': h.native.state.queue.items = [queued('pending', 'synthetic queued work')]; break;
      case 'steering':
        h.native.state.queue.steeringMessages = ['consumed steering'];
        h.native.state.queue.inFlightSteeringCount = 1;
        break;
      case 'mcp': h.native.state.mcp.host!.pendingConnections = ['fixture']; break;
      case 'ask': answer = Promise.resolve(h.configs.get(h.id)!.onUserInputRequest!({ question: 'synthetic question', choices: ['yes'], allowFreeform: true }, { sessionId: h.id })); break;
      case 'plan': answer = Promise.resolve(h.configs.get(h.id)!.onExitPlanModeRequest!({ summary: 'synthetic plan', actions: ['interactive'], recommendedAction: 'interactive' }, { sessionId: h.id })); break;
      case 'schedule': h.native.state.schedules = [schedule()]; break;
    }
    const before = structuredClone(h.native.state);
    const result = await h.engine.addRoles(h.id, [h.catalog[1]!]);
    assert.equal(result.status, 'saved');
    assert.equal(result.rolesNeedReload, true);
    assert.deepEqual(h.saved.get(h.id), [h.catalog[1]]);
    assert.deepEqual(h.native.state, before);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(h.native.sdk.abort.mock.callCount(), 0);
    assert.equal(h.native.sdk.send.mock.callCount(), 0);
    assert.equal(h.native.rpc.skills.list.mock.callCount(), 0);
    assert.equal(h.native.rpc.tools.getCurrentMetadata.mock.callCount(), 0);
    if (activity === 'ask') await h.engine.respondAsk(h.id, (await h.engine.getMeta(h.id))!.ask!.requestId, 'yes', false);
    if (activity === 'plan') await h.engine.respondPlan(h.id, (await h.engine.getMeta(h.id))!.planRequest!.requestId, 'interactive');
    await answer;
  });
}

test('role save accepts empty history and runtime-only resources without reconfiguring them', async t => {
  const h = await roleAdditionFixture(t);
  h.native.state.events = [];
  h.native.state.schedules = [schedule()];
  h.native.state.mcp = mcpState([{ name: 'ephemeral-only', status: 'stopped' }]);
  h.native.state.skills = [{ name: 'ephemeral-only', path: '/synthetic/unknown/SKILL.md', enabled: true } as Skill];
  const before = structuredClone(h.native.state);
  assert.equal((await h.engine.addRoles(h.id, [h.catalog[0]!])).status, 'saved');
  assert.deepEqual(h.native.state, before);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('role save validates catalog and total role limit, not deferred resource composition', async t => {
  const h = await roleAdditionFixture(t);
  await assert.rejects(h.engine.addRoles(h.id, []), /At least one/);
  await assert.rejects(h.engine.addRoles(h.id, [{ moduleId: 'missing', roleId: 'missing' }]), /Unknown module role/);
  assert.equal(h.saved.size, 0);
  const all = Array.from({ length: 65 }, (_, index) => ({ moduleId: 'fixture', moduleName: 'Fixture', roleId: `role-${index}`, name: `Role ${index}` }));
  t.mock.method(h.provider, 'list', () => all);
  assert.equal((await h.engine.addRoles(h.id, all.slice(0, 64))).status, 'saved');
  await assert.rejects(h.engine.addRoles(h.id, all.slice(64)), /at most 64/);
  assert.equal(h.saved.get(h.id)?.length, 64);
  t.mock.method(h.provider, 'assemble', async () => { throw new Error('synthetic unavailable role resource'); });
  await assert.rejects(h.engine.reload(h.id), /synthetic unavailable role resource/);
  assert.equal(h.saved.get(h.id)?.length, 64);
  assert.equal((await h.engine.getMeta(h.id))?.loaded, false);
});

for (const written of [false, true]) {
  test(`role persistence failure afterWrite=${written} returns uncertainty without native effects`, async t => {
    const h = await roleAdditionFixture(t);
    const save = t.mock.method(h.provider, 'save', (id: Parameters<RoleProvider['save']>[0], roles: Parameters<RoleProvider['save']>[1]) => {
      if (written) h.saved.set(id, roles);
      throw new Error('synthetic write acknowledgement failure');
    });
    const result = await h.engine.addRoles(h.id, [h.catalog[0]!]);
    assert.equal(result.status, 'uncertain');
    assert.match(result.error!, /synthetic/);
    assert.match(result.recovery!, /No reload, rollback or retry/);
    assert.equal(save.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.deepEqual(result.roles, written ? [h.catalog[0]] : []);
    assert.deepEqual(result.appliedRoles, []);
    assert.equal(result.rolesNeedReload, written);
  });
}

test('role save never returns a success-shaped snapshot when persistence readback is unavailable', async t => {
  const h = await roleAdditionFixture(t);
  const read = h.provider.read;
  let written = false;
  t.mock.method(h.provider, 'save', (id: Parameters<RoleProvider['save']>[0], roles: Parameters<RoleProvider['save']>[1]) => { h.saved.set(id, roles); written = true; });
  t.mock.method(h.provider, 'read', (id: Parameters<RoleProvider['read']>[0]) => {
    if (written) throw new Error('synthetic unreadable persisted selection');
    return read(id);
  });
  await assert.rejects(h.engine.addRoles(h.id, [h.catalog[0]!]), /persistence outcome and saved selection are unconfirmed/);
  assert.deepEqual(h.saved.get(h.id), [h.catalog[0]]);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('role readiness observes a role saved while native capability reads are in flight', async t => {
  const h = await roleAdditionFixture(t);
  await h.engine.addRoles(h.id, [h.catalog[0]!]);
  await h.engine.reload(h.id);
  const held = deferred<{ skills: Skill[] }>();
  h.native.rpc.skills.list.mock.mockImplementationOnce(() => held.promise);
  const checking = h.engine.roleReadiness(h.id);
  await nextTurn();
  await h.engine.addRoles(h.id, [h.catalog[1]!]);
  held.resolve({ skills: [] });
  const result = await checking;
  assert.equal(result.ready, false);
  assert.equal(result.rolesNeedReload, true);
  assert.deepEqual(result.roles, h.catalog);
  assert.deepEqual(result.appliedRoles, [h.catalog[0]]);
});

test('concurrent role saves union without losing selections and do not reload an unloaded session', async t => {
  const h = await roleAdditionFixture(t);
  await h.engine.unload(h.id);
  const results = await Promise.all(h.catalog.map(role => h.engine.addRoles(h.id, [role])));
  assert.ok(results.every(result => result.status === 'saved' && !result.loaded && !result.rolesNeedReload));
  assert.deepEqual(h.saved.get(h.id), h.catalog);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  await h.engine.load(h.id);
  assert.deepEqual((await h.engine.getMeta(h.id))?.appliedRoles, h.catalog);
});

test('role save refuses an in-flight resume but does not reserve the running turn', async t => {
  const h = await roleAdditionFixture(t);
  const held = deferred<CopilotSession>();
  h.runtime.resumeSession.mock.mockImplementationOnce(() => held.promise);
  const reloading = h.engine.reload(h.id);
  await nextTurn();
  await assert.rejects(h.engine.addRoles(h.id, [h.catalog[0]!]), /loading|transition/i);
  assert.equal(h.saved.size, 0);
  h.runtime.isSessionLive.mock.mockImplementation(async () => true);
  held.resolve(h.native.sdk as unknown as CopilotSession);
  await reloading;
  h.native.state.processing = true;
  assert.equal((await h.engine.addRoles(h.id, [h.catalog[0]!])).status, 'saved');
  await assert.rejects(h.engine.reload(h.id), protectedWork);
  assert.equal((await h.engine.getMeta(h.id))?.rolesNeedReload, true);
});

test('role creation, identity, cold resume and readiness preserve native unrelated config', async t => {
  const h = harness(t);
  const role = { moduleId: 'fixture', roleId: 'executor', name: 'Executor', moduleName: 'Fixture' };
  const saved = new Map<string, typeof role[]>();
  let version = 1;
  const provider: RoleProvider = {
    list: () => [role], read: id => saved.get(id) ?? [], save: (id, roles) => { saved.set(id, roles); },
    assemble: async (id, roles) => ({
      roles: roles.map(() => role), fingerprint: `fixture-v${version}`,
      config: {
        systemMessage: { mode: 'append', content: `Module fixture/executor v${version}\nNative session ID: ${id}` },
        skillDirectories: ['/fixture/skills'],
        mcpServers: { module_fixture__tools: { type: 'http', url: 'http://127.0.0.1/mcp', tools: ['read'] } },
      }, skills: [{ name: 'executor', path: '/fixture/skills/executor/SKILL.md' }],
    }),
  };
  h.engine.setRoleProvider(provider);
  h.userSettings.settings.disabledSkills!.value = ['unrelated'];
  h.discoveredSkills.push({ name: 'executor', path: '/fixture/skills/executor/SKILL.md', description: '', source: 'custom' } as ServerSkill);
  const id = await h.engine.newSession(h.cwd, [role]);
  const config = h.configs.get(id)!;
  assert.deepEqual(config.disabledSkills, ['unrelated']);
  assert.match(JSON.stringify(config.systemMessage), new RegExp(id));
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 0);
  assert.deepEqual((await h.engine.getMeta(id))!.roles, [role]);
  const native = h.natives.get(id)!;
  const assemble = t.mock.method(provider, 'assemble');
  const reads = [
    () => h.engine.getResources(id, ['identity']),
    () => h.engine.getMeta(id),
    () => h.engine.listLive(),
    () => h.engine.snapshot(),
    () => h.engine.status(),
  ];
  for (const read of reads) {
    const beforeMcp = native.rpc.mcp.list.mock.callCount();
    const result = await read();
    assert.doesNotMatch(JSON.stringify(result), /roleReadiness/);
    assert.equal(native.rpc.skills.list.mock.callCount(), 0);
    assert.equal(native.rpc.tools.getCurrentMetadata.mock.callCount(), 0);
    assert.equal(assemble.mock.callCount(), 0);
    assert.equal(native.rpc.mcp.list.mock.callCount() - beforeMcp, read === reads[0] ? 0 : 1,
      'ordinary reads only inspect MCP host activity for existing control/lifecycle safety');
  }
  assert.equal((await h.engine.roleReadiness(id)).ready, false);
  native.state.skills = [{ name: 'executor', description: '', source: 'custom', path: '/fixture/skills/executor/SKILL.md', enabled: true } as Skill];
  native.state.mcp = mcpState([{ name: 'module_fixture__tools', status: 'connected' }]);
  assert.equal((await h.engine.roleReadiness(id, [role])).ready, true);
  native.state.processing = true;
  native.state.tasks = [task()];
  native.state.queue.items = [queued('pending', 'Unrelated pending content')];
  assert.equal((await h.engine.roleReadiness(id)).ready, true, 'capabilities are independent of turn/queue/subagent activity');
  native.state.processing = false;
  native.state.tasks = [];
  native.state.queue.items = [];
  assert.match((await h.engine.roleReadiness(id, [{ ...role, roleId: 'unselected' }])).reasons.join(), /Role not selected/);
  native.state.skills[0]!.enabled = false;
  assert.match((await h.engine.roleReadiness(id)).reasons.join(), /disabled/);
  native.state.skills[0]!.enabled = true;
  native.state.mcp.host!.disabledServers = ['module_fixture__tools'];
  assert.match((await h.engine.roleReadiness(id)).reasons.join(), /not connected/);
  version = 2;
  assert.match((await h.engine.roleReadiness(id)).reasons.join(), /resources differ/);
  await h.engine.unload(id);
  assert.deepEqual((await h.engine.listLive())[0]!.roles, [role]);
  assert.equal((await h.engine.roleReadiness(id)).loaded, false);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0, 'explicit readiness never loads an unloaded session');
  assert.match((await h.engine.roleReadiness('missing-session')).reasons.join(), /does not exist/);
  const cold = new Engine({ runtime: h.runtime as unknown as EngineRuntime });
  cold.setRoleProvider(provider);
  assert.deepEqual((await cold.getMeta(id))!.roles, [role]);
  await cold.load(id);
  assert.match(JSON.stringify(h.configs.get(id)!.systemMessage), /executor v2/);
  assert.notDeepEqual(h.configs.get(id)!.systemMessage, config.systemMessage, 'cold resume uses current role resources');
  assert.deepEqual(h.configs.get(id)!.mcpServers, config.mcpServers);
  native.state.mcp.host!.disabledServers = [];
  native.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: null }));
  const uninitialized = await cold.roleReadiness(id);
  assert.equal(uninitialized.ready, false);
  assert.match(uninitialized.reasons.join(), /uninitialized.*session\/tools-initialize/);
  assert.doesNotMatch(uninitialized.reasons.join(), /not currently offered/);
  native.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [] }));
  assert.match((await cold.roleReadiness(id)).reasons.join(), /not currently offered/);
  assert.equal(native.rpc.tools.initializeAndValidate.mock.callCount(), 2, 'readiness never repairs tools');
  native.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => { throw new Error('metadata unavailable'); });
  assert.match((await cold.roleReadiness(id)).reasons.join(), /Readiness unconfirmed: metadata unavailable/);
});
test('role conflicts and failed native acknowledgement preserve attribution without a hidden retry', async t => {
  const h = harness(t);
  const roles = [{ moduleId: 'board', roleId: 'owner', moduleName: 'Board', name: 'Owner' }];
  const stored = new Map<string, typeof roles>();
  const provider: RoleProvider = {
    list: () => roles, read: id => stored.get(id) ?? [], save: (id, value) => { stored.set(id, value); },
    assemble: async () => ({ roles, config: {}, skills: [], fingerprint: 'v1' }),
  };
  h.engine.setRoleProvider(provider);
  h.runtime.createSession.mock.mockImplementationOnce(async () => { throw new Error('RPC disconnected after submission'); });
  let identity = '';
  await assert.rejects(h.engine.newSession(h.cwd, roles), (error: unknown) => {
    const value = error as { code: string; sessionId: string };
    identity = value.sessionId;
    return value.code === 'SESSION_CREATION_UNCERTAIN' && typeof identity === 'string';
  });
  assert.deepEqual(stored.get(identity), roles);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  t.mock.method(provider, 'assemble', async () => { throw new Error('Conflicting role resources'); });
  await assert.rejects(h.engine.newSession(h.cwd, roles), /Conflicting/);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
});

test('MCP-only roles reject discovered native config collisions on create and cold resume', async t => {
  const h = harness(t);
  const roles = [{ moduleId: 'fixture', roleId: 'mcp-only', moduleName: 'Fixture', name: 'MCP only' }];
  const saved = new Map<string, typeof roles>();
  const config = { type: 'http' as const, url: 'http://127.0.0.1/role', tools: ['read'] };
  const native = { type: 'http' as const, url: 'http://127.0.0.1/native', tools: ['unrelated'] };
  h.engine.setRoleProvider({
    list: () => roles, read: id => saved.get(id) ?? [], save: (id, value) => { saved.set(id, value); },
    assemble: async () => ({ roles, skills: [], fingerprint: 'mcp-only', config: { mcpServers: { module_fixture__tools: config } } }),
  });
  h.mcpDefinitions.module_fixture__tools = native;
  await assert.rejects(h.engine.newSession(h.cwd, roles), /Role MCP conflicts with native configuration/);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.deepEqual(h.mcpDefinitions.module_fixture__tools, native);
  h.mcpDefinitions.module_fixture__tools = config;
  await assert.rejects(h.engine.newSession(h.cwd, roles), /Role MCP conflicts with native configuration/);
  delete h.mcpDefinitions.module_fixture__tools;
  h.discoveredMcp.push({ name: 'module_fixture__tools', source: 'workspace', enabled: true });
  await assert.rejects(h.engine.newSession(h.cwd, roles), /Role MCP conflicts with native configuration/);
  h.discoveredMcp.length = 0;
  delete h.mcpDefinitions.module_fixture__tools;
  const id = await h.engine.newSession(h.cwd, roles);
  await h.engine.unload(id);
  h.mcpDefinitions.module_fixture__tools = native;
  await assert.rejects(h.engine.load(id), /Role MCP conflicts with native configuration/);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.deepEqual(saved.get(id), roles);
  assert.deepEqual(h.mcpDefinitions.module_fixture__tools, native);
  assert.equal(h.runtime.rpc.skills.discover.mock.callCount(), 0, 'MCP validation does not depend on role skills');
});

for (const provenRoles of [false, true]) {
test(`session provenance with known roles=${provenRoles} uses assembled identity and native path, never prefixes`, async t => {
  const h = harness(t);
  const module = { id: 'fixture', name: 'Fixture module',
    ...(provenRoles ? { roles: [{ id: 'worker', name: 'Worker' }] } : {}) };
  const role = { moduleId: module.id, moduleName: module.name, roleId: 'worker', name: 'Worker' };
  const saved = new Map<string, typeof role[]>();
  let path = '/fixture/v1/worker/SKILL.md';
  const provider: RoleProvider = {
    list: () => [role], read: id => saved.get(id) ?? [], save: (id, roles) => { saved.set(id, roles); },
    assemble: async () => ({
      roles: [role], fingerprint: path, skills: [{ name: 'fixture-worker', path, module }],
      mcpSources: { 'fixture-tools': module },
      config: { skillDirectories: [path.slice(0, path.lastIndexOf('/'))],
        mcpServers: { 'fixture-tools': { type: 'http', url: 'http://127.0.0.1/mcp', tools: ['read'] } } },
    }),
  };
  h.engine.setRoleProvider(provider);
  h.discoveredSkills.push({ name: 'fixture-worker', path, description: '', source: 'custom' } as ServerSkill);
  const id = await h.engine.newSession(h.cwd, [role]);
  const native = h.natives.get(id)!;
  native.state.skills = [
    { name: 'fixture-worker', description: 'Native description', path, source: 'custom', enabled: false } as Skill,
    { name: 'module_fixture__unrelated', description: '', path: '/native/SKILL.md', source: 'custom', enabled: true } as Skill,
  ];
  const before = structuredClone(native.state.skills);
  const assemble = t.mock.method(provider, 'assemble');
  const skills = await h.engine.listSessionSkills(id);
  assert.deepEqual(skills[0], {
    name: 'fixture-worker', description: 'Native description', source: 'custom', enabled: false, module,
  });
  assert.equal(Object.hasOwn(skills[1]!, 'module'), false);
  assert.deepEqual(native.state.skills, before, 'projection does not mutate SDK objects');
  assert.equal(assemble.mock.callCount(), 0, 'resource reads do not assemble or calculate readiness');
  await h.engine.refreshSkills();
  assert.deepEqual((await h.engine.listSessionSkills(id))[0]!.module, module);
  native.state.skills[0]!.path = '/replacement/SKILL.md';
  await h.engine.refreshSkills();
  assert.equal(Object.hasOwn((await h.engine.listSessionSkills(id))[0]!, 'module'), false);
  native.state.skills[0]!.path = path;
  native.state.mcp = mcpState([{ name: 'fixture-tools', source: 'user', status: 'failed', error: 'Native error' }]);
  assert.deepEqual((await h.engine.listSessionMcp(id)).servers, [{
    name: 'fixture-tools', detail: 'user', enabled: true, status: 'failed', error: 'Native error', module,
  }], 'MCP module is role configuration provenance, independent of native source and connection state');
  native.state.mcp = mcpState([
    { name: 'module_fixture__unrelated', source: 'custom' as McpState['servers'][number]['source'], status: 'connected' },
    { name: 'constructor', source: 'custom' as McpState['servers'][number]['source'], status: 'connected' },
  ]);
  assert.ok((await h.engine.listSessionMcp(id)).servers.every(server => !Object.hasOwn(server, 'module')),
    'neither lookalike names nor inherited object properties declare module configuration');
  native.state.mcp = mcpState([{ name: 'fixture-tools', source: 'user', status: 'connected' }]);
  await h.engine.reloadSessionMcp(id);
  assert.deepEqual((await h.engine.listSessionMcp(id)).servers[0]!.module, module,
    'role configuration declaration remains, without claiming to verify a same-name native replacement');
  assert.equal(Object.hasOwn((await h.engine.listSessionMcp(id)).servers[0]!, 'connection'), false,
    'assembled HTTP role config cannot establish the transport of a same-name native replacement');
  assert.doesNotMatch(JSON.stringify(await h.engine.getResources(id, ['identity'])), /roleReadiness/);
  await h.engine.unload(id);
  assert.deepEqual(await h.engine.listSessionMcp(id), { loaded: false, servers: [] });
  await assert.rejects(h.engine.listSessionSkills(id), unavailableSession);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  path = '/fixture/v2/worker/SKILL.md';
  h.discoveredSkills[0]!.path = path;
  await h.engine.load(id);
  assert.deepEqual((await h.engine.listSessionMcp(id)).servers[0]!.module, module,
    'cold resume rebuilds the role configuration source');
  assert.equal(Object.hasOwn((await h.engine.listSessionSkills(id))[0]!, 'module'), false,
    'cold resume assembly must not label a native skill retaining the old path');
  native.state.skills[0]!.path = path;
  assert.deepEqual((await h.engine.listSessionSkills(id))[0]!.module, module);
  native.state.skills[0]!.name = 'same-path-different-name';
  assert.equal((await h.engine.listSessionSkills(id))[0]!.module, undefined);
  native.state.skills[0]!.name = 'fixture-worker';
  delete native.state.skills[0]!.path;
  assert.equal((await h.engine.listSessionSkills(id))[0]!.module, undefined);
});
}

async function roleProvenanceFixture(t: TestContext) {
  const h = await roleAdditionFixture(t);
  const path = '/synthetic/shared/SKILL.md';
  const assemble = h.provider.assemble.bind(h.provider);
  h.provider.assemble = async (id, selections) => {
    const value = await assemble(id, selections);
    const module = { id: 'fixture', name: 'Fixture',
      roles: value.roles.map(role => ({ id: role.roleId, name: role.name })) };
    return { ...value, skills: [{ name: 'shared-skill', path, module }],
      mcpSources: { 'shared-tools': module }, config: { ...value.config,
        skillDirectories: ['/synthetic/shared'],
        mcpServers: { 'shared-tools': { type: 'http', url: 'http://127.0.0.1/mcp', tools: ['read'] } },
      } };
  };
  h.discoveredSkills.push({ name: 'shared-skill', path } as ServerSkill);
  assert.equal((await h.engine.addRoles(h.id, [h.catalog[0]!])).status, 'saved');
  await h.engine.reload(h.id);
  h.native.state.skills = [{ name: 'shared-skill', path, source: 'custom', enabled: true } as Skill];
  h.native.state.mcp = mcpState([{ name: 'shared-tools', status: 'connected' }]);
  const sources = async () => {
    const mcp = await h.engine.listSessionMcp(h.id);
    if (!mcp.loaded) {
      assert.deepEqual(mcp.servers, []);
      await assert.rejects(h.engine.listSessionSkills(h.id), unavailableSession);
      return [];
    }
    const skills = await h.engine.listSessionSkills(h.id);
    assert.equal(mcp.servers.length, 1);
    assert.equal(skills.length, 1);
    assert.deepEqual(mcp.servers[0]!.module, skills[0]!.module);
    return mcp.servers[0]!.module?.roles?.map(role => role.id);
  };
  assert.deepEqual(await sources(), ['executor']);
  return { ...h, sources };
}

for (const phase of ['close', 'assemble', 'resume', 'initialize', 'success'] as const) {
  test(`resource contributors follow applied handles across explicit role reload ${phase}`, async t => {
    const h = await roleProvenanceFixture(t);
    const result = await h.engine.addRoles(h.id, [h.catalog[1]!]);
    assert.equal(result.status, 'saved');
    assert.equal(result.rolesNeedReload, true);
    assert.deepEqual(result.roles, h.catalog);
    assert.deepEqual(result.appliedRoles, [h.catalog[0]]);
    assert.deepEqual(await h.sources(), ['executor'], 'saved roles are not resource contributors until loaded');
    if (phase === 'close') h.runtime.closeSession.mock.mockImplementationOnce(async () => { throw new Error('synthetic close unknown'); });
    if (phase === 'assemble') t.mock.method(h.provider, 'assemble', async () => { throw new Error('synthetic assembly failure'); });
    if (phase === 'resume') h.runtime.resumeSession.mock.mockImplementationOnce(async () => { throw new Error('synthetic resume unknown'); });
    if (phase === 'initialize') {
      h.native.rpc.tools.initializeAndValidate.mock.mockImplementationOnce(async () => { throw new Error('synthetic initialization failure'); });
    }
    if (phase === 'success') await h.engine.reload(h.id);
    else await assert.rejects(h.engine.reload(h.id), /synthetic/);
    assert.deepEqual(await h.sources(), phase === 'resume' || phase === 'assemble' ? [] : phase === 'close'
      ? ['executor'] : ['executor', 'owner']);
    if (phase === 'success') {
      assert.equal((await h.engine.addRoles(h.id, h.catalog)).status, 'unchanged');
      await h.engine.unload(h.id);
      assert.deepEqual(await h.sources(), []);
      await h.engine.load(h.id);
      assert.deepEqual(await h.sources(), ['executor', 'owner']);
    }
  });
}

for (const written of [false, true]) {
  test(`uncertain role save afterWrite=${written} preserves previous resource contributors`, async t => {
    const h = await roleProvenanceFixture(t);
    t.mock.method(h.provider, 'save', (id: Parameters<RoleProvider['save']>[0], roles: Parameters<RoleProvider['save']>[1]) => {
      if (written) h.saved.set(id, roles);
      throw new Error('synthetic persistence acknowledgement failure');
    });
    const result = await h.engine.addRoles(h.id, [h.catalog[1]!]);
    assert.equal(result.status, 'uncertain');
    assert.deepEqual(result.roles, written ? h.catalog : [h.catalog[0]]);
    assert.deepEqual(await h.sources(), ['executor']);
  });
}

test('pending role resume never exposes selected contributors before a handle returns', async t => {
  const h = await roleProvenanceFixture(t);
  const held = deferred<CopilotSession>();
  h.runtime.resumeSession.mock.mockImplementationOnce(() => held.promise);
  await h.engine.addRoles(h.id, [h.catalog[1]!]);
  const loading = h.engine.reload(h.id);
  await nextTurn();
  assert.deepEqual(h.saved.get(h.id), h.catalog);
  assert.deepEqual(await h.sources(), []);
  h.runtime.isSessionLive.mock.mockImplementation(async () => true);
  held.resolve(h.native.sdk as unknown as CopilotSession);
  await loading;
  assert.deepEqual(await h.sources(), ['executor', 'owner']);
});
