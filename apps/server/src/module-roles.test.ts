import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ModuleHost } from './module-host.ts';
import { installLocalModule, manifestSchema } from './module-install.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';
import { ModuleRoles } from './module-roles.ts';
import { chmod, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('global provenance verifies loaded module endpoints and file digests without inferring declaring roles', async t => {
  const f = await moduleFixture(t);
  const entries = moduleEntries('global', undefined, { roles: [
    { id: 'first', name: 'First', skillDirectories: ['skills'],
      mcpServers: { declared: { type: 'http', path: '/mcp', tools: ['read'] } } },
    { id: 'second', name: 'Second', skillDirectories: ['skills'],
      mcpServers: { another: { type: 'http', path: '/mcp', tools: ['write'] } } },
  ] });
  entries.push({ path: 'skills/shared/SKILL.md', content: '---\nname: native-name\n---\nNative body' });
  const installed = await installLocalModule(await f.package(entries), { trustLocalCode: true, enable: true });
  let active = true;
  const provider = new ModuleRoles(f.hostRoot, 'http://127.0.0.1:12345', () => active ? [installed] : []);
  const module = { id: 'global', name: 'Fixture global' };
  const url = `http://127.0.0.1:12345/_modules/global/${installed.digest}/api/mcp`;
  const config = { type: 'http', url, tools: ['unrelated'], headers: { Authorization: 'native-secret' } };
  assert.deepEqual(provider.globalMcpSources(config), [module]);
  for (const invalid of [
    { ...config, type: 'stdio' }, { command: 'global' }, { ...config, url: `${url}/other` },
    { ...config, url: url.replace(installed.digest, 'old-digest') },
    { ...config, url: url.replace(':12345', ':23456') }, { ...config, url: `${url}?unverified=1` },
  ]) assert.equal(provider.globalMcpSources(invalid), undefined);
  const path = join(installed.root, 'skills/shared/SKILL.md');
  assert.deepEqual(await provider.globalSkillSources(path), [module]);
  const alias = join(f.root, 'SKILL.md');
  await symlink(path, alias);
  assert.deepEqual(await provider.globalSkillSources(alias), [module], 'canonical installed identity, not path spelling');
  const cyclic = join(f.root, 'cyclic-skill');
  await symlink(cyclic, cyclic);
  await assert.rejects(provider.globalSkillSources(cyclic), /ELOOP/, 'operational read failures must remain explicit');
  assert.equal(await provider.globalSkillSources(join(installed.root, 'backend.mjs')), undefined);
  assert.equal(await provider.globalSkillSources(join(installed.root, 'missing/SKILL.md')), undefined);
  const unrelated = join(f.root, 'unrelated.md');
  await writeFile(unrelated, '---\nname: native-name\n---\nNative body');
  assert.equal(await provider.globalSkillSources(unrelated), undefined, 'matching bytes outside installation do not prove ownership');
  await chmod(path, 0o600);
  await writeFile(path, '---\nname: native-name\n---\nChanged');
  assert.equal(await provider.globalSkillSources(path), undefined, 'inventory identity requires matching bytes');
  active = false;
  assert.equal(provider.globalMcpSources(config), undefined, 'unloaded versions are not attributed');
  assert.equal(await provider.globalSkillSources(alias), undefined);
});

test('module roles union shared HTTP tools, label raw instructions and persist identities across hosts', async t => {
  const f = await moduleFixture(t);
  const entries = moduleEntries('board', undefined, { roles: [
    { id: 'owner', name: 'Owner', instructions: 'roles/owner.md', skillDirectories: ['skills/owner'],
      mcpServers: { 'board-tools': { type: 'http', path: '/mcp', tools: ['read', 'create'] } } },
    { id: 'executor', name: 'Executor', instructions: 'roles/executor.md', skillDirectories: ['skills/executor'],
      mcpServers: { 'board-tools': { type: 'http', path: '/mcp', tools: ['read', 'report'] } } },
  ] });
  entries.push(
    { path: 'roles/owner.md', content: 'RAW owner guidance\nkeep this unchanged' },
    { path: 'roles/executor.md', content: 'RAW executor guidance' },
    { path: 'skills/owner/SKILL.md', content: '---\nname: owner\n---\nOwner skill' },
    { path: 'skills/executor/SKILL.md', content: '---\nname: executor\n---\nExecutor skill' },
  );
  const installed = await installLocalModule(await f.package(entries), { trustLocalCode: true, enable: true });
  const app = Fastify();
  t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer, origin: 'http://127.0.0.1:12345' });
  await host.register(app);
  assert.equal(host.roles.list().length, 2);
  const owner = { moduleId: 'board', roleId: 'owner' };
  const executor = { moduleId: 'board', roleId: 'executor' };
  const value = await host.roles.assemble('native-id', [owner, executor, owner]);
  assert.equal(value.roles.length, 2);
  assert.equal(value.config.skillDirectories!.length, 2);
  assert.deepEqual(value.config.mcpServers, { 'board-tools': {
    type: 'http', url: `http://127.0.0.1:12345/_modules/board/${installed.digest}/api/mcp`,
    headers: { 'X-Cockpit-Module-Digest': installed.digest }, tools: ['create', 'read', 'report'],
  } });
  assert.deepEqual(value.mcpSources, { 'board-tools': { id: 'board', name: 'Fixture board',
    roles: [{ id: 'executor', name: 'Executor' }, { id: 'owner', name: 'Owner' }] } });
  assert.deepEqual(value.skills.map(skill => skill.module), [
    { id: 'board', name: 'Fixture board', roles: [{ id: 'executor', name: 'Executor' }] },
    { id: 'board', name: 'Fixture board', roles: [{ id: 'owner', name: 'Owner' }] },
  ]);
  assert.deepEqual(value.config.systemMessage, { mode: 'append', content:
    '## Module board / role executor (Executor)\nNative session ID: native-id\nRAW executor guidance\n\n'
    + '## Module board / role owner (Owner)\nNative session ID: native-id\nRAW owner guidance\nkeep this unchanged' });
  assert.deepEqual((await host.roles.assemble('native-id', [executor, owner])).config, value.config);
  const single = await host.roles.assemble('native-id', [owner]);
  assert.equal(single.skills.length, 1);
  assert.deepEqual(single.mcpSources?.['board-tools']?.roles, [{ id: 'owner', name: 'Owner' }]);
  host.roles.save('native-id', value.roles);
  const replacement = new ModuleHost({ observer: f.observer });
  assert.deepEqual(await replacement.roles.read('native-id'), value.roles);
  assert.deepEqual(await host.roles.assemble('empty', []), { roles: [], config: {}, skills: [], mcpSources: {},
    fingerprint: (await host.roles.assemble('empty', [])).fingerprint });
  host.close();
  assert.deepEqual(await host.roles.read('native-id'), value.roles);
  await assert.rejects(host.roles.assemble('native-id', [owner]), /unavailable/);
});

test('shared skills retain only actual contributors through overlapping roots, deduplication and cold assembly', async t => {
  const f = await moduleFixture(t);
  const entries = moduleEntries('shared', undefined, { roles: [
    { id: 'owner', name: 'Owner', skillDirectories: ['skills', 'skills/shared'],
      mcpServers: { tools: { type: 'http', path: '/mcp', tools: ['read'] } } },
    { id: 'executor', name: 'Executor', skillDirectories: ['skills/shared'],
      mcpServers: { tools: { type: 'http', path: '/mcp', tools: ['*', 'report'] } } },
    { id: 'observer', name: 'Observer' },
  ] });
  entries.push({ path: 'skills/shared/SKILL.md', content: '---\nname: shared-skill\n---\nShared' });
  const installed = await installLocalModule(await f.package(entries), { trustLocalCode: true, enable: true });
  const provider = new ModuleRoles(f.hostRoot, 'http://127.0.0.1', () => [installed]);
  const selections = ['owner', 'observer', 'executor', 'owner'].map(roleId => ({ moduleId: 'shared', roleId }));
  const value = await provider.assemble('id', selections);
  const source = { id: 'shared', name: 'Fixture shared',
    roles: [{ id: 'executor', name: 'Executor' }, { id: 'owner', name: 'Owner' }] };
  assert.equal(value.skills.length, 1);
  assert.deepEqual(value.skills[0]!.module, source);
  assert.deepEqual(value.mcpSources, { tools: source });
  assert.deepEqual(value.config.mcpServers?.tools?.tools, ['*']);
  assert.deepEqual(await provider.assemble('id', [...selections].reverse()), value);
  provider.save('id', value.roles);
  const cold = new ModuleRoles(f.hostRoot, 'http://127.0.0.1', () => [installed]);
  assert.deepEqual(await cold.assemble('id', await cold.read('id')), value);
  installed.manifest.roles!.find(role => role.id === 'owner')!.name = 'Current Owner';
  assert.deepEqual((await cold.assemble('id', await cold.read('id'))).skills[0]!.module?.roles,
    [{ id: 'executor', name: 'Executor' }, { id: 'owner', name: 'Current Owner' }]);
});

test('unrelated modules cannot claim the same literal MCP name', async t => {
  const f = await moduleFixture(t);
  for (const id of ['first', 'second']) {
    await installLocalModule(await f.package(moduleEntries(id, undefined, { roles: [
      { id: 'worker', name: 'Worker', mcpServers: { 'shared-name': { type: 'http', path: '/mcp', tools: ['read'] } } },
    ] })), { trustLocalCode: true, enable: true });
  }
  const app = Fastify(); t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer }); await host.register(app);
  await assert.rejects(host.roles.assemble('id', [
    { moduleId: 'first', roleId: 'worker' }, { moduleId: 'second', roleId: 'worker' },
  ]), /Conflicting role MCP configuration: shared-name/);
});

test('persisted role identities read current installed labels without assembling or migrating identities', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('labels', undefined, { roles: [
    { id: 'worker', name: 'Original worker' },
  ] })), { trustLocalCode: true, enable: true });
  let available = true;
  const roles = new ModuleRoles(f.hostRoot, 'http://127.0.0.1', () => available ? [installed] : []);
  const selection = { moduleId: 'labels', roleId: 'worker', moduleName: 'Stored module', name: 'Stored worker' };
  roles.save('unloaded-session', [selection]);
  installed.manifest.name = 'Current module';
  installed.manifest.roles![0]!.name = 'Current worker';
  assert.deepEqual(await roles.read('unloaded-session'), [{ ...selection, moduleName: 'Current module', name: 'Current worker' }]);
  available = false;
  assert.deepEqual(await roles.read('unloaded-session'), [selection], 'missing identities retain persisted attribution, not readiness');
  await assert.rejects(roles.assemble('unloaded-session', [selection]), /unavailable/);
});

test('conflicting resources and unsafe manifest paths fail instead of overriding', async t => {
  const f = await moduleFixture(t);
  const entries = moduleEntries('conflict', undefined, { roles: [
    { id: 'a', name: 'A', skillDirectories: ['skills/a'], mcpServers: { tools: { type: 'http', path: '/one', tools: ['x'] } } },
    { id: 'b', name: 'B', skillDirectories: ['skills/b'], mcpServers: { tools: { type: 'http', path: '/two', tools: ['y'] } } },
    { id: 'c', name: 'C', mcpServers: { tools: { type: 'http', path: '/two', tools: ['y'] } } },
    { id: 'd', name: 'D', skillDirectories: ['skills/d'] },
  ] });
  entries.push({ path: 'skills/a/SKILL.md', content: '---\nname: duplicate\n---\nA' },
    { path: 'skills/b/SKILL.md', content: '---\nname: duplicate\n---\nB' },
    { path: 'skills/d/SKILL.md', content: '---\nname: duplicate\n---\nA' });
  await installLocalModule(await f.package(entries), { trustLocalCode: true, enable: true });
  const app = Fastify(); t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer }); await host.register(app);
  await assert.rejects(host.roles.assemble('id', [{ moduleId: 'conflict', roleId: 'a' }, { moduleId: 'conflict', roleId: 'b' }]), /Conflicting role skill/);
  await assert.rejects(host.roles.assemble('id', [{ moduleId: 'conflict', roleId: 'a' }, { moduleId: 'conflict', roleId: 'c' }]), /Conflicting role MCP/);
  await assert.rejects(host.roles.assemble('id', [{ moduleId: 'conflict', roleId: 'a' }, { moduleId: 'conflict', roleId: 'd' }]), /Duplicate role skill name in different directories/);
  const manifest = JSON.parse(String(entries[0]!.content));
  manifest.roles[0].instructions = '../outside';
  assert.equal(manifestSchema.safeParse(manifest).success, false);
  manifest.roles[0].instructions = 'safe.md';
  manifest.roles[0].mcpServers.tools.path = '/../../outside';
  assert.equal(manifestSchema.safeParse(manifest).success, false);
});

test('module host bridge is allowlisted, lifecycle bound and preserves public call results', async t => {
  const f = await moduleFixture(t);
  const installed = await installLocalModule(await f.package(moduleEntries('bridge', `
    let ctx;
    export function activate(value) { ctx = value; return { routes: [{method: 'POST', path: '/call',
      handler: async req => ({body: req.body.name === 'capability'
        ? { version: ctx.host.resourcePreparationVersion, frozen: Object.isFrozen(ctx.host) }
        : await ctx.host.call(req.body.name, req.body.body)})}] }; }
  `)), { trustLocalCode: true, enable: true });
  const calls: unknown[] = [];
  const app = Fastify(); t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer, host: { call: async (name, body) => {
    calls.push({ name, body }); return { sessionId: 'actual-native-id' } as never;
  } } });
  await host.register(app);
  const url = `/_modules/bridge/${installed.digest}/api/call`;
  const headers = { 'x-cockpit-module-digest': installed.digest };
  const body = { cwd: '/workspace', roles: [{ moduleId: 'bridge', roleId: 'executor' }] };
  const response = await app.inject({ method: 'POST', url, headers, payload: { name: 'session/new', body } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { sessionId: 'actual-native-id' });
  assert.deepEqual(calls, [{ name: 'session/new', body }]);
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload: { name: 'capability' } })).json(),
    { version: 1, frozen: true });
  const preparation = { sessionId: 'x', skills: ['optional'], mcpServers: [{ name: 'tools', tools: ['read'] }] };
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { name: 'session/resources-prepare', body: preparation } })).statusCode, 200);
  assert.deepEqual(calls[1], { name: 'session/resources-prepare', body: preparation });
  const rename = { sessionId: 'x', name: 'Task title' };
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { name: 'session/rename', body: rename } })).statusCode, 200);
  assert.deepEqual(calls[2], { name: 'session/rename', body: rename });
  for (const name of ['session/delete', 'session/tools-initialize', 'skills/session-toggle', 'mcp/session-toggle', 'arbitrary/intent']) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { name, body: { sessionId: 'x' } } })).statusCode, 500);
  }
  assert.equal(calls.length, 3);
  assert.equal((await app.inject({ method: 'POST', url, payload: { name: 'session/get', body: {} } })).statusCode, 409);
});
