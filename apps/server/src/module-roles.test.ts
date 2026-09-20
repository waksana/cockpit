import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ModuleHost } from './module-host.ts';
import { installLocalModule, manifestSchema } from './module-install.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';

test('module roles union shared HTTP tools, label raw instructions and persist identities across hosts', async t => {
  const f = await moduleFixture(t);
  const entries = moduleEntries('board', undefined, { roles: [
    { id: 'owner', name: 'Owner', instructions: 'roles/owner.md', skillDirectories: ['skills/owner'],
      mcpServers: { tools: { type: 'http', path: '/mcp', tools: ['read', 'create'] } } },
    { id: 'executor', name: 'Executor', instructions: 'roles/executor.md', skillDirectories: ['skills/executor'],
      mcpServers: { tools: { type: 'http', path: '/mcp', tools: ['read', 'report'] } } },
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
  assert.deepEqual(value.config.mcpServers, { module_board__tools: {
    type: 'http', url: `http://127.0.0.1:12345/_modules/board/${installed.digest}/api/mcp`,
    headers: { 'X-Cockpit-Module-Digest': installed.digest }, tools: ['create', 'read', 'report'],
  } });
  assert.deepEqual(value.config.systemMessage, { mode: 'append', content:
    '## Module board / role executor (Executor)\nNative session ID: native-id\nRAW executor guidance\n\n'
    + '## Module board / role owner (Owner)\nNative session ID: native-id\nRAW owner guidance\nkeep this unchanged' });
  assert.deepEqual((await host.roles.assemble('native-id', [executor, owner])).config, value.config);
  assert.equal((await host.roles.assemble('native-id', [owner])).skills.length, 1);
  host.roles.save('native-id', value.roles);
  const replacement = new ModuleHost({ observer: f.observer });
  assert.deepEqual(replacement.roles.read('native-id'), value.roles);
  assert.deepEqual(await host.roles.assemble('empty', []), { roles: [], config: {}, skills: [],
    fingerprint: (await host.roles.assemble('empty', [])).fingerprint });
  host.close();
  assert.deepEqual(host.roles.read('native-id'), value.roles);
  await assert.rejects(host.roles.assemble('native-id', [owner]), /unavailable/);
});

test('conflicting resources and unsafe manifest paths fail instead of overriding', async t => {
  const f = await moduleFixture(t);
  const entries = moduleEntries('conflict', undefined, { roles: [
    { id: 'a', name: 'A', skillDirectories: ['skills/a'], mcpServers: { tools: { type: 'http', path: '/one', tools: ['x'] } } },
    { id: 'b', name: 'B', skillDirectories: ['skills/b'], mcpServers: { tools: { type: 'http', path: '/two', tools: ['y'] } } },
    { id: 'c', name: 'C', mcpServers: { tools: { type: 'http', path: '/two', tools: ['y'] } } },
  ] });
  entries.push({ path: 'skills/a/SKILL.md', content: '---\nname: duplicate\n---\nA' },
    { path: 'skills/b/SKILL.md', content: '---\nname: duplicate\n---\nB' });
  await installLocalModule(await f.package(entries), { trustLocalCode: true, enable: true });
  const app = Fastify(); t.after(() => app.close());
  const host = new ModuleHost({ observer: f.observer }); await host.register(app);
  await assert.rejects(host.roles.assemble('id', [{ moduleId: 'conflict', roleId: 'a' }, { moduleId: 'conflict', roleId: 'b' }]), /Conflicting role skill/);
  await assert.rejects(host.roles.assemble('id', [{ moduleId: 'conflict', roleId: 'a' }, { moduleId: 'conflict', roleId: 'c' }]), /Conflicting role MCP/);
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
      handler: async req => ({body: await ctx.host.call(req.body.name, req.body.body)})}] }; }
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
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { name: 'session/delete', body: { sessionId: 'x' } } })).statusCode, 500);
  assert.equal(calls.length, 1);
  assert.equal((await app.inject({ method: 'POST', url, payload: { name: 'session/get', body: {} } })).statusCode, 409);
});
