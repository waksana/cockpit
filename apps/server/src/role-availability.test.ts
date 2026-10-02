import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoleAvailability, roleCompatibilityReasons } from '@cockpit/protocol';
import { ModuleRoles } from './module-roles.ts';
import { ModuleHost } from './module-host.ts';
import { installLocalModule } from './module-install.ts';
import { moduleEntries, moduleFixture } from './test-support/module-fixture.ts';
import { RoleAssignments, type AssignmentHandler } from './role-assignments.ts';
import Fastify from 'fastify';

test('structural compatibility permits neutral bindings without weakening exclusive assembly or saved checks', async t => {
  const f = await moduleFixture(t);
  const entries = moduleEntries('structural', undefined, { instructions: 'global.md', roles: [
    { id: 'assistant', name: 'Assistant', resourcePolicy: 'exclusive', instructions: 'assistant.md' },
    { id: 'second', name: 'Second exclusive', resourcePolicy: 'exclusive' },
    { id: 'binding', name: 'Binding', skillDirectories: [], mcpServers: {} },
    { id: 'node', name: 'Node', instructions: 'node.md', skillDirectories: ['skills'],
      mcpServers: { fixture: { type: 'http', path: '/mcp', tools: ['read'] } } },
  ] });
  entries.push({ path: 'global.md', content: 'GLOBAL MUST BE EXCLUDED' },
    { path: 'assistant.md', content: 'Assistant instructions' }, { path: 'node.md', content: '' },
    { path: 'skills/test/SKILL.md', content: '---\nname: test\ndescription: Fixture\n---\nFixture' });
  const installation = await installLocalModule(await f.package(entries), { trustLocalCode: true });
  const provider = new ModuleRoles(f.hostRoot, 'http://localhost', () => [installation]);
  const [assistant, second, binding, node] = ['assistant', 'second', 'binding', 'node']
    .map(id => provider.list().find(role => role.roleId === id)!);
  const standalone = await provider.assemble('target', [assistant!]);
  const assembly = await provider.assemble('target', [assistant!, binding!]);
  assert.equal(assembly.resourcePolicy, 'exclusive');
  assert.deepEqual(assembly.config, standalone.config, 'neutral bindings inject no model instructions');
  assert.equal(assembly.fingerprint, standalone.fingerprint);
  assert.doesNotMatch((await provider.sessionInstructions('target', assembly))!.content, /GLOBAL|Binding/);
  provider.save('target', assembly.roles);
  assert.equal((await provider.read('target')).length, 2);
  const result = await provider.availability({ operation: 'add', sessionId: 'target',
    roles: [assistant!, node!, second!, binding!], previousRoles: assembly.roles });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reasons.length, 3);
  assert.deepEqual(result.reasons.find(reason => reason.capabilities.includes('instructions'))?.capabilities, ['instructions', 'skills', 'mcp']);
  assert.throws(() => provider.save('target', [assistant!, node!]), /conflicts with/);
  await assert.rejects(provider.assemble('target', [assistant!, second!]), /exclusive/);
  assert.deepEqual(roleCompatibilityReasons([binding!, node!], provider.list()), [], 'ordinary roles do not inherently conflict');
  assert.equal((await provider.read('target')).length, 2);
});

test('activated module preflight receives absent creation identity and saved target roles, aggregates safe failures', async t => {
  const f = await moduleFixture(t);
  for (const id of ['denial', 'broken']) {
    await installLocalModule(await f.package(moduleEntries(id, `
      export function activate(context) {
        if (context.host.roleAvailabilityVersion !== 1) throw new Error('Missing availability');
        return { routes: [], roleAssignments: { availability: async (input, signal) => {
          if (context.moduleId === 'broken') throw new Error('PRIVATE CREDENTIAL MUST NOT LEAK');
          if (input.operation === 'create' && input.sessionId !== undefined) throw new Error('Unexpected identity');
          if (input.operation === 'add') {
            const found = await context.host.call('session/get', { sessionId: input.sessionId });
            if (!found.meta || found.meta.loaded) throw new Error('Expected unloaded target');
          }
          return { reasons: ['occupied', 'configuration'].map(code => ({
            code, message: code, status: 'denied', roles: input.roles.filter(r => r.moduleId === context.moduleId), capabilities: []
          })) };
        } } };
      }
    `, { roles: [{ id: 'binding', name: 'Binding' }] })), { trustLocalCode: true, enable: true });
  }
  const app = Fastify();
  t.after(() => app.close());
  const calls: string[] = [];
  const host = new ModuleHost({ observer: f.observer, host: { call: async name => {
    calls.push(name);
    return { meta: { sessionId: 'unloaded', loaded: false } } as never;
  } } });
  await host.register(app);
  assert.deepEqual(host.bootstrap().errors, []);
  const roles = host.roles.list();
  for (const input of [
    { operation: 'create' as const, roles, previousRoles: [] },
    { operation: 'add' as const, sessionId: 'unloaded', roles, previousRoles: roles },
  ]) {
    const result = RoleAvailability.parse(await host.roles.availability(input));
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.reasons.map(reason => reason.code).sort(), ['ROLE_CHECK_ERROR', 'configuration', 'occupied']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE CREDENTIAL/);
  }
  assert.deepEqual(calls, ['session/get'], 'no load, prompt or send');
});

test('one timed-out module preserves all structural and other module reasons, aborts and never saves', async t => {
  const f = await moduleFixture(t);
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let observed: AbortSignal | undefined;
  const roles = [{ moduleId: 'hung', roleId: 'binding' }, { moduleId: 'denied', roleId: 'binding' }];
  const handlers: AssignmentHandler[] = [
    { moduleId: 'hung', signal: new AbortController().signal,
      hooks: { availability: (_input, signal) => { observed = signal; entered(); return new Promise(() => {}); } } },
    { moduleId: 'denied', signal: new AbortController().signal,
      hooks: { availability: input => ({ reasons: [{ status: 'denied', code: 'OCCUPIED', message: 'Occupied',
        roles: input.roles, capabilities: [] }] }) } },
  ];
  const service = new RoleAssignments(f.hostRoot, () => handlers, async () => []);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const check = service.availability({ operation: 'create', roles, previousRoles: [] });
  await waiting;
  t.mock.timers.tick(30_000);
  const result = await check;
  assert.equal(observed?.aborted, true);
  assert.deepEqual(result.reasons.map(reason => reason.status), ['unknown', 'denied']);
  assert.equal(result.status, 'unavailable');
});

test('preflight is not a reservation: concurrent saves recheck availability and permits inside existing locks', async t => {
  const f = await moduleFixture(t);
  const role = { moduleId: 'binding', roleId: 'service' };
  const saved = new Map<string, typeof role[]>();
  let binding: string | undefined;
  let permits = 0;
  const service = new RoleAssignments(f.hostRoot, () => [{
    moduleId: 'binding', signal: new AbortController().signal, hooks: {
      availability: input => ({ reasons: binding && input.sessionId !== binding
        ? [{ code: 'OCCUPIED', message: 'Another session owns the binding', status: 'denied', roles: [role], capabilities: [] }] : [] }),
      permit: () => { permits++; return { allowed: true }; },
      saved: input => { binding = input.sessionId; },
    },
  }], async id => saved.get(id) ?? []);
  assert.equal((await service.availability({ operation: 'create', roles: [role], previousRoles: [] })).status, 'available');
  const results = await Promise.allSettled(['first', 'second'].map(sessionId => service.run({
    operation: 'create', sessionId, roles: [role], previousRoles: [],
  }, async () => { saved.set(sessionId, [role]); return sessionId; })));
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(saved.size, 1);
  assert.equal(permits, 2, 'all permits are queried even when another reason rejects');
  assert.equal((await service.availability({
    operation: 'add', sessionId: 'first', roles: [role], previousRoles: [role],
  })).status, 'available', 'the same target is not occupied by someone else');
});
