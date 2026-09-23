import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Intents } from '@cockpit/protocol';
import type { RoleProvider } from './roles.ts';
import { errorWithCode } from '../test-support/errors.ts';
import {
  type Rpc,
  type Skill,
  deferred,
  harness,
  mcpState,
  protectedWork,
  queued,
  task,
  unavailableSession,
} from '../test-support/engine-harness.ts';

async function preparationFixture(t: TestContext) {
  const h = harness(t);
  const s = await h.load();
  s.state.skills = ['optional', 'unrelated'].map(name =>
    ({ name, path: `/fixture/${name}/SKILL.md`, description: '', source: 'custom', enabled: false } as Skill));
  s.state.mcp = mcpState([
    { name: 'module_fixture__tools', status: 'disabled' }, { name: 'unrelated', status: 'disabled' },
  ], ['module_fixture__tools', 'unrelated']);
  s.rpc.mcp.enable.mock.mockImplementation(async ({ serverName }) => {
    s.state.mcp.servers.find(server => server.name === serverName)!.status = 'connected';
    s.state.mcp.host!.disabledServers = s.state.mcp.host!.disabledServers.filter(name => name !== serverName);
  });
  const input = { sessionId: s.id, skills: ['optional'], mcpServers: [{ name: 'module_fixture__tools', tools: ['read'] }] };
  return { h, s, input };
}

test('resource preparation enables only explicit selections and returns exact raw offered tools', async t => {
  const { h, s, input } = await preparationFixture(t);
  s.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(async () => ({ tools: null }));
  const receipt = await h.engine.prepareSessionResources(input);
  assert.deepEqual(receipt, {
    sessionId: s.id, ok: true, skills: [{ name: 'optional', effect: 'enabled', enabled: true }],
    mcpServers: [{ name: 'module_fixture__tools', effect: 'enabled', enabled: true, status: 'connected', tools: ['read'] }],
    tools: 'initialized',
  });
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 1);
  assert.equal(s.state.skills[1]!.enabled, false);
  assert.equal(s.state.mcp.servers[1]!.status, 'disabled');
  assert.deepEqual(s.state.mcp.host!.disabledServers, ['unrelated']);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  const again = await h.engine.prepareSessionResources(input);
  assert.equal(again.ok, true);
  assert.equal(again.skills[0]!.effect, 'unchanged');
  assert.equal(again.mcpServers[0]!.effect, 'unchanged');
  assert.equal(again.tools, 'unchanged');
  assert.equal(s.rpc.skills.enable.mock.callCount(), 1);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 1);
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 1);
});

test('empty preparation only ensures metadata, treating initialized empty tools as valid', async t => {
  const { h, s } = await preparationFixture(t);
  s.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [] }));
  assert.deepEqual(await h.engine.prepareSessionResources({ sessionId: s.id }), {
    sessionId: s.id, ok: true, skills: [], mcpServers: [], tools: 'unchanged',
  });
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 0);
  assert.equal(s.rpc.skills.list.mock.callCount(), 0);
  assert.equal(s.rpc.skills.enable.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
  s.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(async () => ({ tools: null }));
  assert.equal((await h.engine.prepareSessionResources({ sessionId: s.id, skills: [], mcpServers: [] })).tools, 'initialized');
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 1);
});

for (const filtered of [false, true]) {
  test(`confirmed MCP activation rebuilds non-null stale metadata once, preserving native filtering: ${filtered}`, async t => {
    const { h, s, input } = await preparationFixture(t);
    let initialized = false;
    s.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: initialized
      ? [{ name: 'wire-read', description: '', mcpServerName: 'module_fixture__tools', mcpToolName: 'read' }]
      : [] }));
    s.rpc.tools.initializeAndValidate.mock.mockImplementation(async () => { initialized = true; return {}; });
    const selection = { sessionId: s.id, mcpServers: [{ name: input.mcpServers[0]!.name,
      tools: filtered ? ['read', 'filtered'] : ['read'] }] };
    const receipt = await h.engine.prepareSessionResources(selection);
    assert.equal(receipt.ok, !filtered);
    assert.equal(receipt.tools, 'initialized');
    assert.equal(receipt.mcpServers[0]!.effect, 'enabled');
    assert.deepEqual(receipt.mcpServers[0]!.tools, ['read']);
    if (filtered) assert.match(receipt.error!, /not currently offered/);
    assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 1);
    assert.equal(s.rpc.tools.getCurrentMetadata.mock.callCount(), 2);
    assert.equal(s.rpc.skills.enable.mock.callCount(), 0);
    assert.equal(s.state.mcp.servers[1]!.status, 'disabled');
    const unchanged = await h.engine.prepareSessionResources(selection);
    assert.equal(unchanged.ok, !filtered);
    assert.equal(unchanged.tools, 'unchanged');
    assert.equal(unchanged.mcpServers[0]!.effect, 'unchanged');
    assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 1, 'unchanged filtered tools do not justify another rebuild');
  });
}

test('already enabled MCP with a non-null empty table fails without speculative initialization', async t => {
  const { h, s, input } = await preparationFixture(t);
  s.state.mcp.servers[0]!.status = 'connected';
  s.state.mcp.host!.disabledServers = ['unrelated'];
  s.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [] }));
  const receipt = await h.engine.prepareSessionResources({ sessionId: s.id, mcpServers: input.mcpServers });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.tools, 'unchanged');
  assert.equal(receipt.mcpServers[0]!.effect, 'unchanged');
  assert.deepEqual(receipt.mcpServers[0]!.tools, []);
  assert.match(receipt.error!, /not currently offered/);
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
});

test('all requested identities are prevalidated before any activation', async t => {
  const { h, s, input } = await preparationFixture(t);
  for (const selection of [
    { ...input, skills: ['optional', 'unknown'] },
    { ...input, mcpServers: [...input.mcpServers, { name: 'unknown', tools: ['read'] }] },
  ]) {
    const receipt = await h.engine.prepareSessionResources(selection);
    assert.equal(receipt.ok, false);
    assert.match(receipt.error!, /unknown|unconfirmed/);
    assert.equal(receipt.tools, 'not_attempted');
  }
  for (const selection of [
    { ...input, skills: ['optional', 'optional'] },
    { ...input, mcpServers: [...input.mcpServers, ...input.mcpServers] },
    { ...input, mcpServers: [{ name: 'module_fixture__tools', tools: ['*'] }] },
  ]) await assert.rejects(h.engine.prepareSessionResources(selection));
  assert.equal(s.rpc.skills.enable.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 0);
});

for (const stale of ['saved roles', 'assembly fingerprint', 'assembly failure'] as const) {
  test(`resource preparation rejects stale ${stale} after passive inspection without native mutations`, async t => {
    const h = harness(t);
    const role = { moduleId: 'fixture', roleId: 'executor', moduleName: 'Fixture', name: 'Executor' };
    let saved = [role];
    let fingerprint = 'v1';
    let failed = false;
    const provider: RoleProvider = {
      list: () => [role], read: () => saved, save: (_id, values) => { saved = values; },
      assemble: async (_id, choices) => {
        if (failed) throw new Error('current assembly unavailable');
        return { roles: saved.filter(value => choices.some(choice => choice.roleId === value.roleId)),
          config: {}, skills: [], fingerprint };
      },
    };
    h.engine.setRoleProvider(provider);
    const id = await h.engine.newSession(h.cwd, [role]);
    const s = h.natives.get(id)!;
    s.state.skills = [{ name: 'optional', path: '/fixture/SKILL.md', description: '', source: 'custom', enabled: false } as Skill];
    s.state.mcp = mcpState([{ name: 'module_fixture__tools', status: 'disabled' }], ['module_fixture__tools']);
    assert.equal((await h.engine.roleReadiness(id, [role])).ready, true, 'earlier passive observation is not admission');
    const initializations = s.rpc.tools.initializeAndValidate.mock.callCount();
    if (stale === 'saved roles') saved = [...saved, { ...role, roleId: 'owner', name: 'Owner' }];
    else if (stale === 'assembly fingerprint') fingerprint = 'v2';
    else failed = true;
    const receipt = await h.engine.prepareSessionResources({ sessionId: id, skills: ['optional'],
      mcpServers: [{ name: 'module_fixture__tools', tools: ['read'] }] });
    assert.equal(receipt.ok, false);
    assert.match(receipt.error!, /roles differ|role resources differ|assembly unavailable/);
    assert.deepEqual(receipt.skills, [{ name: 'optional', effect: 'not_attempted', enabled: null }]);
    assert.deepEqual(receipt.mcpServers, [{ name: 'module_fixture__tools', effect: 'not_attempted', enabled: null, status: null, tools: null }]);
    assert.equal(receipt.tools, 'not_attempted');
    assert.equal(s.rpc.skills.enable.mock.callCount(), 0);
    assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
    assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), initializations);
  });
}

test('resource preparation holds the transition while checking the current role assembly', async t => {
  const h = harness(t);
  const role = { moduleId: 'fixture', roleId: 'executor', moduleName: 'Fixture', name: 'Executor' };
  const provider: RoleProvider = {
    list: () => [role], read: () => [role], save: () => {},
    assemble: async () => ({ roles: [role], config: {}, skills: [], fingerprint: 'v1' }),
  };
  h.engine.setRoleProvider(provider);
  const id = await h.engine.newSession(h.cwd, [role]);
  const held = deferred();
  t.mock.method(provider, 'assemble', async () => {
    await held.promise;
    return { roles: [role], config: {}, skills: [], fingerprint: 'v1' };
  });
  const preparing = h.engine.prepareSessionResources({ sessionId: id });
  await nextTurn();
  await assert.rejects(h.engine.addRoles(id, [role]), protectedWork);
  await assert.rejects(h.engine.prompt(id, 'must not run'), protectedWork);
  await assert.rejects(h.engine.reload(id), protectedWork);
  held.resolve();
  assert.equal((await preparing).ok, true);
});

for (const state of ['failed', 'needs-auth', 'stopped', 'pending', 'not_configured', 'filtered', 'policy-disabled'] as const) {
  test(`resource preparation does not start connectors or enable skills for ${state} MCP`, async t => {
    const { h, s, input } = await preparationFixture(t);
    if (state === 'filtered') s.state.mcp.host!.filteredServers = ['module_fixture__tools'];
    else if (state === 'policy-disabled') s.state.mcp.host!.mcp3pEnabled = false;
    else s.state.mcp.servers[0]!.status = state;
    const receipt = await h.engine.prepareSessionResources(input);
    assert.equal(receipt.ok, false);
    assert.match(receipt.error!, /MCP/);
    assert.equal(receipt.tools, 'not_attempted');
    assert.equal(s.rpc.skills.enable.mock.callCount(), 0);
    assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
    assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 0);
  });
}

test('native malformed selected skill state rejects without side effects', async t => {
  const { h, s, input } = await preparationFixture(t);
  const malformed = structuredClone(s.state.skills);
  Reflect.deleteProperty(malformed[0]!, 'enabled');
  s.rpc.skills.list.mock.mockImplementation(async () => ({ skills: malformed }));
  const receipt = await h.engine.prepareSessionResources(input);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error!, /unconfirmed/);
  assert.equal(s.rpc.skills.enable.mock.callCount(), 0);
});

test('resource preparation records an uncertain skill mutation without attempting later MCP work', async t => {
  const { h, s, input } = await preparationFixture(t);
  s.rpc.skills.enable.mock.mockImplementation(async () => { throw new Error('native skill enable failed'); });
  const receipt = await h.engine.prepareSessionResources(input);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error!, /native skill enable failed/);
  assert.deepEqual(receipt.skills, [{ name: 'optional', effect: 'unconfirmed', enabled: null }]);
  assert.equal(receipt.mcpServers[0]!.effect, 'not_attempted');
  assert.equal(s.rpc.skills.enable.mock.callCount(), 1);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
});

test('resource preparation preserves confirmed earlier changes and uncertain MCP effects without retries', async t => {
  const { h, s, input } = await preparationFixture(t);
  s.rpc.mcp.enable.mock.mockImplementation(async () => {
    s.state.mcp.servers[0]!.status = 'needs-auth';
    s.state.mcp.host!.disabledServers = ['unrelated'];
    throw new Error('native connector rejected');
  });
  const receipt = await h.engine.prepareSessionResources(input);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error!, /native connector rejected/);
  assert.deepEqual(receipt.skills, [{ name: 'optional', effect: 'enabled', enabled: true }]);
  assert.deepEqual(receipt.mcpServers, [{ name: 'module_fixture__tools', effect: 'enabled', enabled: true, status: 'needs-auth', tools: null }]);
  assert.equal(receipt.tools, 'not_attempted');
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 1);
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 0);
});

test('resource preparation keeps unknown MCP readback and confirmed skill effects explicit', async t => {
  const { h, s, input } = await preparationFixture(t);
  s.rpc.mcp.enable.mock.mockImplementation(async () => {
    s.rpc.mcp.list.mock.mockImplementation(async () => { throw new Error('readback unavailable'); });
    throw new Error('connector failed');
  });
  const receipt = await h.engine.prepareSessionResources(input);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error!, /connector failed.*readback unavailable/);
  assert.deepEqual(receipt.mcpServers, [{ name: 'module_fixture__tools', effect: 'unconfirmed', enabled: null, status: null, tools: null }]);
  assert.equal(receipt.skills[0]!.effect, 'enabled');
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 1);
});

test('later read failures do not erase confirmed applied effects or initialized metadata', async t => {
  const { h, s, input } = await preparationFixture(t);
  s.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => {
    s.rpc.skills.list.mock.mockImplementation(async () => { throw new Error('final skill read unavailable'); });
    return { tools: [] };
  });
  const receipt = await h.engine.prepareSessionResources(input);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.skills[0]!.effect, 'enabled');
  assert.equal(receipt.skills[0]!.enabled, true);
  assert.equal(receipt.mcpServers[0]!.effect, 'enabled');
  assert.equal(receipt.mcpServers[0]!.status, 'connected');
  assert.deepEqual(receipt.mcpServers[0]!.tools, []);
  assert.equal(receipt.tools, 'initialized');
  assert.match(receipt.error!, /final skill read unavailable/);
});

for (const failure of ['initialize', 'null-readback', 'empty', 'wire-name', 'other-server'] as const) {
  test(`resource preparation cannot claim tool readiness for ${failure}`, async t => {
    const { h, s, input } = await preparationFixture(t);
    s.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: failure === 'null-readback' ? null
      : failure === 'wire-name' ? [{ name: 'read', description: '', mcpServerName: 'module_fixture__tools', mcpToolName: 'wire-read' }]
      : failure === 'other-server' ? [{ name: 'read', description: '', mcpServerName: 'other', mcpToolName: 'read' }] : [] }));
    if (failure === 'initialize' || failure === 'null-readback') {
      s.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(async () => ({ tools: null }));
    }
    if (failure === 'initialize') {
      s.rpc.tools.initializeAndValidate.mock.mockImplementation(async () => { throw new Error('native init failed'); });
    }
    const receipt = await h.engine.prepareSessionResources(input);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.skills[0]!.effect, 'enabled');
    assert.equal(receipt.mcpServers[0]!.effect, 'enabled');
    assert.match(receipt.error!, /init|offered/);
    const unconfirmed = failure === 'initialize' || failure === 'null-readback';
    assert.equal(receipt.tools, unconfirmed ? 'unconfirmed' : 'initialized');
    assert.deepEqual(receipt.mcpServers[0]!.tools, unconfirmed ? null : []);
    assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 1);
  });
}

test('unspecified or empty MCP tool selections require at least one actual tool and return bounded raw names', async t => {
  const { h, s, input } = await preparationFixture(t);
  for (const tools of [undefined, []]) {
    const receipt = await h.engine.prepareSessionResources({ ...input, mcpServers: [{ name: 'module_fixture__tools', tools }] });
    assert.equal(receipt.ok, true);
    assert.deepEqual(receipt.mcpServers[0]!.tools, ['read']);
  }
  s.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [] }));
  const receipt = await h.engine.prepareSessionResources({ ...input, mcpServers: [{ name: 'module_fixture__tools' }] });
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.mcpServers[0]!.tools, []);
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 1, 'only the initial activation rebuilt; no-op missing tools never justify rebuilding');
});

test('unspecified tools return one witness while explicit selections retain only requested offered names', async t => {
  const { h, s, input } = await preparationFixture(t);
  s.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: Array.from({ length: 300 },
    (_, i) => ({ name: `wire-${i}`, description: '', mcpServerName: 'module_fixture__tools', mcpToolName: `raw-${i}` })) }));
  const receipt = await h.engine.prepareSessionResources({ ...input, mcpServers: [{ name: 'module_fixture__tools' }] });
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.mcpServers[0]!.tools, ['raw-0']);
  const explicit = await h.engine.prepareSessionResources({ ...input,
    mcpServers: [{ name: 'module_fixture__tools', tools: ['raw-2', 'raw-0', 'absent'] }] });
  assert.equal(explicit.ok, false);
  assert.deepEqual(explicit.mcpServers[0]!.tools, ['raw-2', 'raw-0']);
  s.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [
    { name: 'wire', description: '', mcpServerName: 'module_fixture__tools', mcpToolName: 'a'.repeat(201) },
  ] }));
  const malformed = await h.engine.prepareSessionResources({ ...input, mcpServers: [{ name: 'module_fixture__tools' }] });
  assert.equal(malformed.ok, false);
  assert.match(malformed.error!, /tool identity is unconfirmed/);
  assert.equal(malformed.mcpServers[0]!.tools, null);
  assert.equal(malformed.mcpServers[0]!.effect, 'unchanged');
});

test('resource preparation bounds native errors without dropping earlier effect receipts', async t => {
  const { h, s, input } = await preparationFixture(t);
  s.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(async () => ({ tools: null }));
  s.rpc.tools.initializeAndValidate.mock.mockImplementation(async () => {
    throw new Error(`Native initialization rejected: ${'detail '.repeat(1000)}`);
  });
  const receipt = await h.engine.prepareSessionResources(input);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error!.length, 2000);
  assert.match(receipt.error!, /^Native initialization rejected:/);
  assert.match(receipt.error!, /\.\.\. \[truncated\]$/);
  assert.equal(receipt.skills[0]!.effect, 'enabled');
  assert.equal(receipt.mcpServers[0]!.effect, 'enabled');
  assert.equal(receipt.tools, 'unconfirmed');
  assert.deepEqual(Intents['session/resources-prepare'].result.parse(receipt), receipt);
});

test('resource preparation reports native handle closure with earlier confirmed effects and no reload', async t => {
  const { h, s, input } = await preparationFixture(t);
  const held = deferred<Awaited<ReturnType<Rpc['tools']['getCurrentMetadata']>>>();
  s.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(() => held.promise);
  const preparing = h.engine.prepareSessionResources(input);
  await nextTurn();
  h.runtime.expire(s.id, true);
  const receipt = await preparing;
  assert.equal(receipt.ok, false);
  assert.match(receipt.error!, unavailableSession);
  assert.equal(receipt.skills[0]!.effect, 'enabled');
  assert.equal(receipt.mcpServers[0]!.effect, 'enabled');
  assert.equal(receipt.tools, 'unconfirmed');
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  held.resolve({ tools: [] });
});

test('resource preparation requires loaded idle state and excludes all ordinary mutations throughout the transition', async t => {
  const h = harness(t);
  const s = await h.seed();
  const input = { sessionId: s.id };
  await assert.rejects(h.engine.prepareSessionResources({ sessionId: 'missing' }), errorWithCode('SESSION_NOT_FOUND'));
  await assert.rejects(h.engine.prepareSessionResources(input), unavailableSession);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  await h.engine.load(s.id);
  for (const work of ['main', 'task', 'queue', 'steering', 'mcp'] as const) {
    s.state.processing = work === 'main';
    s.state.tasks = work === 'task' ? [task()] : [];
    s.state.queue.items = work === 'queue' ? [queued('q', 'pending message')] : [];
    s.state.queue.steeringMessages = work === 'steering' ? ['consumed steering'] : [];
    s.state.queue.inFlightSteeringCount = work === 'steering' ? 1 : 0;
    s.state.mcp.host!.pendingConnections = work === 'mcp' ? ['pending'] : [];
    await assert.rejects(h.engine.prepareSessionResources(input), protectedWork);
  }
  s.state.mcp.host!.pendingConnections = [];
  for (const stage of ['preflight', 'mutation', 'initialization', 'readback'] as const) {
    const held = deferred();
    s.state.skills = [{ name: 'selected', path: '/fixture/SKILL.md', description: '', source: 'custom', enabled: false } as Skill];
    if (stage === 'preflight') s.rpc.skills.list.mock.mockImplementationOnce(async () => { await held.promise; return { skills: structuredClone(s.state.skills) }; });
    if (stage === 'mutation') s.rpc.skills.enable.mock.mockImplementationOnce(async () => { await held.promise; s.state.skills[0]!.enabled = true; });
    if (stage === 'initialization') {
      s.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(async () => ({ tools: null }));
      s.rpc.tools.initializeAndValidate.mock.mockImplementationOnce(async () => { await held.promise; return {}; });
    }
    if (stage === 'readback') s.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(async () => { await held.promise; return { tools: [] }; });
    const preparing = h.engine.prepareSessionResources({ ...input, skills: ['selected'] });
    await nextTurn();
    for (const mutate of [
      () => h.engine.prepareSessionResources(input), () => h.engine.initializeSessionTools(s.id),
      () => h.engine.prompt(s.id, 'must not run'), () => h.engine.rename(s.id, 'must not rename'),
      () => h.engine.setModel(s.id, 'model'), () => h.engine.setMode(s.id, 'plan'),
      () => h.engine.toggleSessionSkill(s.id, 'selected', false),
      () => h.engine.toggleSessionMcp(s.id, 'tools', true), () => h.engine.reloadSessionMcp(s.id),
      () => h.engine.unload(s.id), () => h.engine.reload(s.id), () => h.engine.stop(),
    ]) await assert.rejects(mutate(), protectedWork);
    held.resolve();
    assert.equal((await preparing).ok, true);
  }
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
});

test('explicit tool initialization preserves the handle and temporary choices without sending or reloading', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.skills = [{ name: 'temporary', path: '/fixture/SKILL.md', description: '', source: 'custom', enabled: true } as Skill];
  s.state.mcp = mcpState([{ name: 'temporary', status: 'connected' }], ['disabled']);
  const before = structuredClone(s.state);
  await h.engine.initializeSessionTools(s.id);
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 1);
  assert.equal(s.rpc.tools.getCurrentMetadata.mock.callCount(), 1);
  assert.deepEqual(s.state, before);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1, 'only the explicit load resumed');
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('explicit tool initialization rejects unloaded, busy and concurrent work without repairing or retrying', async t => {
  const h = harness(t);
  const s = await h.seed();
  await assert.rejects(h.engine.initializeSessionTools('missing'), errorWithCode('SESSION_NOT_FOUND'));
  await assert.rejects(h.engine.initializeSessionTools(s.id), unavailableSession);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  await h.engine.load(s.id);
  for (const work of ['main', 'task', 'queue', 'steering', 'mcp'] as const) {
    s.state.processing = work === 'main';
    s.state.tasks = work === 'task' ? [task()] : [];
    s.state.queue.items = work === 'queue' ? [queued('q', 'pending message')] : [];
    s.state.queue.steeringMessages = work === 'steering' ? ['consumed steering'] : [];
    s.state.queue.inFlightSteeringCount = work === 'steering' ? 1 : 0;
    s.state.mcp.host!.pendingConnections = work === 'mcp' ? ['pending'] : [];
    await assert.rejects(h.engine.initializeSessionTools(s.id), protectedWork);
  }
  s.state.mcp.host!.pendingConnections = [];
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 0);
  const held = deferred<object>();
  s.rpc.tools.initializeAndValidate.mock.mockImplementationOnce(() => held.promise);
  const initializing = h.engine.initializeSessionTools(s.id);
  await nextTurn();
  await assert.rejects(h.engine.initializeSessionTools(s.id), protectedWork);
  await assert.rejects(h.engine.toggleSessionSkill(s.id, 'temporary', true), protectedWork);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  await assert.rejects(h.engine.stop(), protectedWork);
  held.resolve({});
  await initializing;
  s.rpc.tools.initializeAndValidate.mock.mockImplementationOnce(async () => { throw new Error('native validation failed'); });
  await assert.rejects(h.engine.initializeSessionTools(s.id), /native validation failed/);
  assert.equal(s.rpc.tools.initializeAndValidate.mock.callCount(), 2, 'no retry');
  s.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(async () => ({ tools: null }));
  await assert.rejects(h.engine.initializeSessionTools(s.id), /initialization is unconfirmed/);
  s.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(async () => ({ tools: [] }));
  await h.engine.initializeSessionTools(s.id);
  const skills = deferred<{ skills: Skill[] }>();
  s.rpc.skills.list.mock.mockImplementationOnce(() => skills.promise);
  const reading = h.engine.listSessionSkills(s.id);
  await nextTurn();
  await assert.rejects(h.engine.initializeSessionTools(s.id), protectedWork);
  skills.resolve({ skills: [] });
  await reading;
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
});

for (const stage of ['initialization', 'readback'] as const) {
  test(`explicit tool initialization fails if its native handle closes during ${stage}`, async t => {
    const h = harness(t);
    const s = await h.load();
    const initialized = deferred<object>();
    const metadata = deferred<Awaited<ReturnType<Rpc['tools']['getCurrentMetadata']>>>();
    if (stage === 'initialization') s.rpc.tools.initializeAndValidate.mock.mockImplementationOnce(() => initialized.promise);
    else s.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(() => metadata.promise);
    const work = h.engine.initializeSessionTools(s.id);
    await nextTurn();
    const rejected = assert.rejects(work, unavailableSession);
    h.runtime.expire(s.id, true);
    initialized.resolve({});
    metadata.resolve({ tools: [] });
    await rejected;
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1, 'no repair resume');
    if (stage === 'initialization') assert.equal(s.rpc.tools.getCurrentMetadata.mock.callCount(), 0);
  });
}

for (const stage of ['assembly', 'capability read'] as const) {
  test(`explicit readiness does not report a closed handle ready during ${stage}`, async t => {
    const h = harness(t);
    const roles = [{ moduleId: 'fixture', roleId: 'owner', moduleName: 'Fixture', name: 'Owner' }];
    const saved = new Map<string, typeof roles>();
    const assembly = { roles, skills: [], config: {}, fingerprint: 'fixture' };
    const provider: RoleProvider = {
      list: () => roles, read: id => saved.get(id) ?? [], save: (id, value) => { saved.set(id, value); },
      assemble: async () => assembly,
    };
    h.engine.setRoleProvider(provider);
    const id = await h.engine.newSession(h.cwd, roles);
    const native = h.natives.get(id)!;
    const held = deferred<typeof assembly>();
    const tools = deferred<{ tools: [] }>();
    if (stage === 'assembly') t.mock.method(provider, 'assemble', () => held.promise);
    else native.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(() => tools.promise);
    const reading = h.engine.roleReadiness(id);
    await nextTurn();
    h.runtime.expire(id, true);
    held.resolve(assembly);
    tools.resolve({ tools: [] });
    const result = await reading;
    assert.equal(result.ready, false);
    assert.equal(result.loaded, false);
    assert.match(result.reasons.join(), /closed|changed/);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  });
}
