import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { RoleProvider } from './roles.ts';
import { errorWithCode } from '../test-support/errors.ts';
import {
  type DiscoveredMcp,
  type McpState,
  type ServerSkill,
  deferred,
  event,
  harness,
  mcpState,
  protectedWork,
  unavailableSession,
  visibleError,
} from '../test-support/engine-harness.ts';

test('global MCP inventory combines native user definitions and native enabled state without sessions or legacy defaults', async t => {
  const h = harness(t, {
    mcpServers: {
      fixture: { url: 'https://username:password@example.invalid/mcp?token=private-token',
        headers: { Authorization: 'private-header' } },
    },
    prefs: { mcpDefaultOn: [], mcpBySession: { untouched: ['other'] } },
  });
  h.discoveredMcp.push({ name: 'workspace-only', source: 'workspace', enabled: true });
  const before = readFileSync(h.prefsFile, 'utf8');
  const servers = await h.engine.listGlobalMcp();
  assert.deepEqual(servers.map(({ name, defaultOn }) => ({ name, defaultOn })), [{ name: 'fixture', defaultOn: true }]);
  assert.deepEqual(servers[0]!.connection, { method: 'http', target: 'example.invalid' });
  assert.ok(!/username|password|private-token|private-header/.test(JSON.stringify(servers)));
  assert.deepEqual(h.runtime.rpc.mcp.discover.mock.calls[0]!.arguments, [{ workingDirectory: homedir() }]);
  await h.engine.setMcpDefault('fixture', false);
  assert.equal((await h.engine.listGlobalMcp())[0]!.defaultOn, false);
  await h.engine.setMcpDefault('fixture', true);
  assert.deepEqual(h.runtime.rpc.mcp.config.disable.mock.calls[0]!.arguments, [{ names: ['fixture'] }]);
  assert.deepEqual(h.runtime.rpc.mcp.config.enable.mock.calls[0]!.arguments, [{ names: ['fixture'] }]);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), before);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('global MCP connection metadata follows current native config without adding entries or changing legacy detail', async t => {
  const h = harness(t, { mcpServers: {
    remote: { type: 'sse', url: 'https://events.invalid:8443/mcp?token=fixture-token' },
    local: { type: 'local', command: '/opt/tools/node', args: ['server.js', '--token', 'fixture-token', 'x'.repeat(4000)] },
  } });
  const servers = await h.engine.listGlobalMcp();
  assert.deepEqual(servers.map(({ name, connection }) => ({ name, connection })), [
    { name: 'remote', connection: { method: 'sse', target: 'events.invalid' } },
    { name: 'local', connection: { method: 'stdio', target: 'node' } },
  ]);
  assert.ok(servers[0]!.detail.includes('/mcp?token='));
  assert.ok(servers[1]!.detail.includes('server.js'));
  assert.ok(servers[1]!.detail.includes('x'.repeat(4000)));
  assert.ok(!JSON.stringify(servers).includes('fixture-token'));
  h.mcpDefinitions.remote = { command: 'replacement', args: ['--quiet'] };
  assert.deepEqual((await h.engine.listGlobalMcp())[0]!.connection, { method: 'stdio', target: 'replacement' });
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('global provenance annotates only native inventory identities and preserves detail, redaction and defaults', async t => {
  const h = harness(t, { mcpServers: {
    native: { type: 'http', url: 'http://127.0.0.1/module', headers: { Authorization: 'private-header' } },
    'module_fixture__lookalike': { command: 'unrelated' },
  } });
  const path = join(h.cwd, 'SKILL.md');
  writeFileSync(path, '# Native body');
  const module = { id: 'fixture', name: 'Fixture' };
  const provider: RoleProvider = {
    list: () => { throw new Error('Global catalog must not list roles'); },
    read: () => { throw new Error('Global catalog must not read session selections'); },
    save: () => { throw new Error('Global catalog must not save roles'); },
    assemble: async () => { throw new Error('Global catalog must not assemble roles'); },
    globalMcpSources: config => 'url' in config && config.url === 'http://127.0.0.1/module' ? [module] : [],
    globalSkillSources: async value => value === path ? [module] : undefined,
  };
  h.engine.setRoleProvider(provider);
  h.discoveredMcp[0]!.enabled = false;
  h.discoveredMcp.push({ name: 'role-only', source: 'workspace', enabled: true });
  h.discoveredSkills.push(
    { name: 'native', description: 'Native description', source: 'custom', path, userInvocable: false } as ServerSkill,
    { name: 'module_fixture__lookalike', source: 'custom', path: '/unrelated/SKILL.md' } as ServerSkill,
    { name: 'pathless', source: 'custom' } as ServerSkill,
  );
  h.userSettings.settings.disabledSkills!.value = ['native'];
  const original = structuredClone(h.discoveredSkills);
  const mcp = await h.engine.listGlobalMcp();
  assert.deepEqual(mcp.map(server => [server.name, server.defaultOn, server.modules]), [
    ['native', false, [module]], ['module_fixture__lookalike', true, undefined],
  ]);
  assert.ok(!JSON.stringify(mcp).includes('private-header'));
  assert.equal(Object.hasOwn(mcp[1]!, 'modules'), false);
  const skills = await h.engine.listGlobalSkills(h.cwd);
  assert.deepEqual(skills[0], {
    name: 'native', description: 'Native description', source: 'custom', userInvocable: false, enabled: false, modules: [module],
  });
  assert.deepEqual(await h.engine.readSkillBody('native', h.cwd), { ...skills[0], body: '# Native body' });
  assert.ok(skills.slice(1).every(skill => !Object.hasOwn(skill, 'modules')));
  assert.deepEqual(h.discoveredSkills, original);
  h.discoveredSkills[0]!.path = '/replacement/SKILL.md';
  assert.equal(Object.hasOwn((await h.engine.listGlobalSkills(h.cwd))[0]!, 'modules'), false);
  h.mcpDefinitions.native = { type: 'http', url: 'http://127.0.0.1/replacement' };
  assert.equal(Object.hasOwn((await h.engine.listGlobalMcp())[0]!, 'modules'), false);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.skills.config.setSkillDisabled.mock.callCount(), 0);
});

for (const failure of ['unknown', 'ignored', 'shadowed', 'missing-enabled', 'readback'] as const) {
  test(`global MCP ${failure} state cannot silently confirm a configuration mutation`, async t => {
    const h = harness(t, { mcpServers: { fixture: { command: 'native-fixture' } } });
    if (failure === 'shadowed') h.discoveredMcp[0]!.source = 'workspace';
    if (failure === 'missing-enabled') delete (h.discoveredMcp[0] as Partial<DiscoveredMcp>).enabled;
    if (failure === 'ignored') h.runtime.rpc.mcp.config.disable.mock.mockImplementationOnce(async () => {});
    if (failure === 'readback') h.runtime.rpc.mcp.discover.mock.mockImplementationOnce(async () => {
      throw new Error('native discover readback failed');
    }, 1);
    const bytes = readFileSync(h.prefsFile, 'utf8');
    await assert.rejects(h.engine.setMcpDefault(failure === 'unknown' ? 'unknown' : 'fixture', false),
      /Unknown|unconfirmed|did not confirm|readback failed/);
    assert.equal(readFileSync(h.prefsFile, 'utf8'), bytes);
    assert.equal(h.runtime.rpc.mcp.config.disable.mock.callCount(), failure === 'ignored' || failure === 'readback' ? 1 : 0);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
  });
}

test('session MCP inventory uses resident workspace/plugin truth and never borrows global definitions', async t => {
  const h = harness(t, { mcpServers: { global: { command: 'must-not-be-displayed' } } });
  const s = await h.load();
  s.state.mcp = mcpState([
    { name: 'workspace', source: 'workspace', status: 'connected' },
    { name: 'plugin', source: 'plugin', sourcePlugin: 'native-plugin', status: 'disabled' },
  ], ['plugin']);
  assert.deepEqual(await h.engine.listSessionMcp(s.id), { loaded: true, servers: [
    { name: 'workspace', detail: 'workspace', enabled: true, status: 'connected', error: undefined },
    { name: 'plugin', detail: 'native-plugin', enabled: false, status: 'disabled', error: undefined },
  ] });
  s.rpc.mcp.disable.mock.mockImplementationOnce(async () => {
    s.state.mcp.host!.disabledServers.push('workspace');
    s.state.mcp.servers[0]!.status = 'disabled';
  });
  assert.equal((await h.engine.toggleSessionMcp(s.id, 'workspace', false)).ok, true);
  assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.discover.mock.callCount(), 0);
  delete s.state.mcp.host;
  await assert.rejects(h.engine.listSessionMcp(s.id), /unconfirmed/);
  h.runtime.expire(s.id);
  const resumes = h.runtime.resumeSession.mock.callCount();
  assert.deepEqual(await h.engine.listSessionMcp(s.id), { loaded: false, servers: [] });
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
});

test('session MCP source, server metadata and global name collisions cannot establish current transport', async t => {
  const h = harness(t, { mcpServers: { collision: { type: 'http', url: 'https://global.invalid/mcp' } } });
  const s = await h.load();
  s.state.mcp = mcpState([
    { name: 'collision', source: 'builtin', status: 'connected', serverMetadata: { instructions: 'Use HTTP tools.' } },
    { name: 'source-http', source: 'plugin', sourcePlugin: 'http', status: 'connected' },
    { name: 'source-local', source: 'custom' as McpState['servers'][number]['source'], status: 'connected' },
  ]);
  const reads = s.rpc.mcp.list.mock.callCount();
  const inventory = await h.engine.listSessionMcp(s.id);
  assert.deepEqual(inventory.servers.map(({ detail }) => detail), ['builtin', 'http', 'custom']);
  assert.ok(inventory.servers.every(server => !Object.hasOwn(server, 'connection')));
  assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.discover.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.list.mock.callCount(), reads + 1);
});

test('unknown native MCP names reject before mutation without stranding later valid toggles', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'known', status: 'connected' }]);
  await assert.rejects(h.engine.toggleSessionMcp(s.id, 'missing', false), /Unknown native MCP server/);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
  s.rpc.mcp.disable.mock.mockImplementationOnce(async () => {
    s.state.mcp = mcpState([{ name: 'known', status: 'disabled' }], ['known']);
  });
  assert.equal((await h.engine.toggleSessionMcp(s.id, 'known', false)).ok, true);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 1);
  assert.equal(h.prefs().mcpBySession, undefined);
});

const nativeMcpStatuses = {
  connected: true, failed: true, 'needs-auth': true, pending: true,
  disabled: false, stopped: true, not_configured: false,
} satisfies Record<McpState['servers'][number]['status'], boolean>;

for (const [status, configuredEnabled] of Object.entries(nativeMcpStatuses)) {
  for (const explicitlyDisabled of [false, true]) {
    test(`MCP ${status}, host disabled=${explicitlyDisabled}: list, panels and toggle share native state`, async t => {
      const h = harness(t);
      const s = await h.load();
      const server: McpState['servers'][number] = { name: 'fixture', status: 'connected', source: 'workspace' };
      Reflect.set(server, 'status', status);
      s.state.mcp = mcpState([server], explicitlyDisabled ? ['fixture'] : []);
      if (status === 'stopped') {
        s.state.mcp.host!.mcp3pEnabled = false;
        s.state.mcp.host!.filteredServers = ['fixture'];
      }
      const enabled = configuredEnabled && !explicitlyDisabled;
      const inventory = await h.engine.listSessionMcp(s.id);
      assert.deepEqual(inventory.servers, [{
        name: 'fixture', detail: 'workspace', status, enabled, error: undefined,
      }]);
      assert.deepEqual((await h.engine.getPanels(s.id)).mcpServers, [{ label: 'fixture', sublabel: status, enabled }]);
      assert.equal(s.rpc.mcp.enable.mock.callCount(), 0, 'reading must not initiate authentication or connection work');
      assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
      assert.equal(s.rpc.mcp.reload.mock.callCount(), 0);
      for (const desiredEnabled of [true, false]) {
        const result = await h.engine.toggleSessionMcp(s.id, 'fixture', desiredEnabled);
        assert.equal(result.enabled, enabled);
        assert.equal(result.status, status);
        assert.equal(result.operation.status, status);
        const applied = enabled === desiredEnabled && status !== 'not_configured'
          && (!desiredEnabled || status === 'connected');
        assert.equal(result.ok, applied);
        assert.equal(result.applied, applied);
        assert.deepEqual((await h.engine.listSessionMcp(s.id)).servers, inventory.servers);
        assert.deepEqual((await h.engine.getPanels(s.id)).mcpServers, [{ label: 'fixture', sublabel: status, enabled }]);
      }
      assert.equal(s.rpc.mcp.reload.mock.callCount(), 0);
      assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 0);
      assert.equal(h.prefs().mcpBySession, undefined);
    });
  }
}

for (const status of ['future-status', 'needs_auth', 'unloaded', undefined, null]) {
  test(`MCP unknown native status ${String(status)} fails read and mutation preflight explicitly`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
    Reflect.set(s.state.mcp.servers[0]!, 'status', status);
    for (const read of [() => h.engine.listSessionMcp(s.id), () => h.engine.getPanels(s.id)]) {
      await assert.rejects(read(), /Native MCP state is unconfirmed for fixture: unknown status/);
    }
    await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', true), /unconfirmed.*unknown status/);
    assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
    assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
    assert.equal(s.rpc.mcp.reload.mock.callCount(), 0);
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
  });
}

for (const rejected of [false, true]) {
  for (const missing of ['status', 'server', 'host'] as const) {
    test(`MCP ${rejected ? 'rejected' : 'acknowledged'} mutation with unconfirmed ${missing} readback cannot return success`, async t => {
      const h = harness(t);
      const s = await h.load();
      s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
      s.rpc.mcp.enable.mock.mockImplementation(async () => {
        if (missing === 'status') Reflect.set(s.state.mcp.servers[0]!, 'status', 'future-status');
        if (missing === 'server') s.state.mcp.servers = [];
        if (missing === 'host') delete s.state.mcp.host;
        if (s.state.mcp.host) s.state.mcp.host.pendingConnections = ['fixture'];
        if (rejected) throw new Error('native enable rejected');
      });
      await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', true), /MCP state is unknown.*unconfirmed/);
      assert.equal(s.rpc.mcp.enable.mock.callCount(), 1);
      assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
      await assert.rejects(h.engine.unload(s.id), /protected|MCP|unconfirmed/i);
      assert.equal(h.runtime.closeSession.mock.callCount(), 0);
      s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
      await h.engine.unload(s.id);
      assert.equal(h.runtime.closeSession.mock.callCount(), 1);
    });
  }
}

for (const status of [...Object.keys(nativeMcpStatuses), 'future-status']) {
  test(`MCP reload confirms ${status} with the same status adapter and keeps lifecycle protection`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.mcp = mcpState([{ name: 'fixture', status: 'connected' }]);
    Reflect.set(s.state.mcp.servers[0]!, 'status', status);
    if (status === 'not_configured') s.state.mcp.host!.disabledServers = ['fixture'];
    const resumes = h.runtime.resumeSession.mock.callCount();
    if (status === 'connected' || status === 'disabled') {
      assert.deepEqual(await h.engine.reloadSessionMcp(s.id), { reconnected: status === 'connected' ? 1 : 0 });
    } else {
      await assert.rejects(h.engine.reloadSessionMcp(s.id), /MCP connections not confirmed|MCP state is unconfirmed/);
    }
    assert.equal(s.rpc.mcp.reload.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
  });
}

for (const failure of ['rpc', 'unconfirmed-state'] as const) {
  test(`MCP enable ${failure} failure does not persist a successful preference`, async t => {
    const h = harness(t, { mcpServers: { fixture: { command: 'never-executed', args: [] } } });
    const s = await h.load();
    s.state.mcp = mcpState([{ name: 'fixture', status: 'failed', error: 'native connect failed' }],
      failure === 'rpc' ? ['fixture'] : []);
    if (failure === 'rpc') s.rpc.mcp.enable.mock.mockImplementation(async () => { throw new Error('native enable rejected'); });
    const before = readFileSync(h.prefsFile, 'utf8');
    const result = await h.engine.toggleSessionMcp(s.id, 'fixture', true);
    assert.equal(result.ok, false);
    assert.equal(result.applied, false);
    assert.equal(result.operation?.state, 'failed');
    assert.equal(result.enabled, failure !== 'rpc', 'report authoritative enablement, not the requested value');
    assert.equal(result.status, 'failed', 'host disablement must not replace the native connection status');
    assert.equal(result.operation?.status, result.status);
    assert.equal(result.operation?.desiredEnabled, true);
    assert.match(result.error!, /native/);
    assert.equal(readFileSync(h.prefsFile, 'utf8'), before);
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
    assert.deepEqual(s.rpc.mcp.enable.mock.calls[0]!.arguments, [{ serverName: 'fixture' }]);
    visibleError(h, s.id, /native/);
  });
}

for (const mutationRejected of [false, true]) {
  test(`MCP unreadable state after ${mutationRejected ? 'rejected' : 'acknowledged'} enable rejects as unknown and stays protected until confirmed`, async t => {
    const h = harness(t, { mcpServers: { fixture: { command: 'never-executed', args: [] } } });
    const s = await h.load();
    s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
    if (mutationRejected) s.rpc.mcp.enable.mock.mockImplementation(async () => { throw new Error('native enable rejected'); });
    s.rpc.mcp.list.mock.mockImplementation(async () => { throw new Error('native MCP readback unavailable'); });
    s.rpc.mcp.list.mock.mockImplementationOnce(async () => structuredClone(s.state.mcp));
    const before = readFileSync(h.prefsFile, 'utf8');
    h.events.length = 0;
    await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', true), /MCP state is unknown.*native MCP readback unavailable/);
    await assert.rejects(h.engine.getMeta(s.id), /native MCP readback unavailable/);
    assert.equal(readFileSync(h.prefsFile, 'utf8'), before);
    visibleError(h, s.id, /MCP state is unknown/);
    await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', false), /native MCP readback unavailable/);
    assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
    for (const teardown of [() => h.engine.unload(s.id), () => h.engine.stop()]) {
      await assert.rejects(teardown(), /protected|MCP readback unavailable/i);
      await assert.rejects(h.engine.getMeta(s.id), /native MCP readback unavailable/);
      assert.ok(h.attached.has(s.id));
    }
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    assert.equal(h.runtime.start.mock.callCount(), 0);
    s.rpc.mcp.list.mock.mockImplementation(async () => structuredClone(s.state.mcp));
    s.state.mcp.host!.pendingConnections = ['fixture'];
    s.emit(event('session.idle', {}));
    await nextTurn();
    assert.ok((await h.engine.getMeta(s.id))!.activeMcpOperations! > 0, 'readable but pending native connections are not settled');
    await assert.rejects(h.engine.unload(s.id), protectedWork);
    s.state.mcp.host!.pendingConnections = [];
    s.emit(event('session.idle', {}));
    await nextTurn();
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
    assert.equal(h.prefs().mcpBySession?.[s.id], undefined, 'a later read must not persist the rejected request');
    await h.engine.unload(s.id);
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  });
}

test('rejected MCP enable reports settling while the native host still has a pending connector', async t => {
  const h = harness(t, { mcpServers: { fixture: { command: 'never-executed', args: [] } } });
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
  s.rpc.mcp.enable.mock.mockImplementation(async () => {
    s.state.mcp = mcpState([{ name: 'fixture', status: 'pending' }]);
    s.state.mcp.host!.pendingConnections = ['fixture'];
    throw new Error('native connector timed out');
  });
  const before = readFileSync(h.prefsFile, 'utf8');
  const result = await h.engine.toggleSessionMcp(s.id, 'fixture', true);
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.enabled, true);
  assert.equal(result.status, 'pending');
  assert.equal(result.operation?.state, 'settling');
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), before);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('MCP enable confirms native state without persistence and blocks a concurrent mutation or unload', async t => {
  const h = harness(t, { mcpServers: { fixture: { command: 'never-executed', args: [] } } });
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
  const enabled = deferred();
  s.rpc.mcp.enable.mock.mockImplementation(async () => {
    await enabled.promise;
    s.state.mcp = mcpState([{ name: 'fixture', status: 'connected' }]);
  });
  const toggling = h.engine.toggleSessionMcp(s.id, 'fixture', true);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
  assert.equal(h.prefs().mcpBySession?.[s.id], undefined);
  await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', false), errorWithCode('SESSION_BUSY'));
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
  enabled.resolve();
  const result = await toggling;
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.operation?.state, 'succeeded');
  assert.equal(h.prefs().mcpBySession, undefined);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
});
test('global MCP refresh invalidates only native definitions and never disrupts loaded sessions', async t => {
  const config = { fixture: { command: 'never-executed', args: ['old'] } };
  const h = harness(t, { mcpServers: config, prefs: { mcpDefaultOn: ['fixture'] } });
  const first = await h.load();
  const second = await h.load();
  for (const s of [first, second]) s.state.mcp = mcpState([{ name: 'fixture', status: 'connected' }]);
  second.state.processing = true;
  const resumes = h.runtime.resumeSession.mock.callCount();
  await h.engine.refreshMcp();
  assert.equal(h.runtime.rpc.mcp.config.reload.mock.callCount(), 1);
  assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 1);
  assert.equal(h.runtime.rpc.mcp.discover.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(first.rpc.mcp.reload.mock.callCount(), 0);
  assert.equal(second.rpc.mcp.reload.mock.callCount(), 0);
  h.runtime.rpc.mcp.config.reload.mock.mockImplementationOnce(async () => { throw new Error('native cache reload failed'); });
  await assert.rejects(h.engine.refreshMcp(), /native cache reload failed/);
  assert.deepEqual(h.prefs().mcpDefaultOn, ['fixture'], 'retired records cannot override native configuration and are not rewritten');
});

test('session MCP reload uses the guarded native connection operation without close or resume', async t => {
  const h = harness(t);
  const first = await h.load();
  first.state.mcp = mcpState([{ name: 'fixture', status: 'connected', source: 'workspace' }]);
  const resumes = h.runtime.resumeSession.mock.callCount();
  const reload = await h.engine.reloadSessionMcp(first.id);
  assert.equal(reload.reconnected, 1);
  assert.equal(first.rpc.mcp.reload.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(h.runtime.rpc.mcp.config.reload.mock.callCount(), 1);
  first.state.processing = true;
  await assert.rejects(h.engine.reloadSessionMcp(first.id), protectedWork);
  assert.equal(first.rpc.mcp.reload.mock.callCount(), 1);
  first.state.processing = false;
  const pending = deferred();
  first.rpc.mcp.reload.mock.mockImplementationOnce(() => pending.promise);
  const changing = h.engine.reloadSessionMcp(first.id);
  await nextTurn();
  await assert.rejects(h.engine.prompt(first.id, 'do not send'), protectedWork);
  await assert.rejects(h.engine.unload(first.id), protectedWork);
  await assert.rejects(h.engine.toggleSessionMcp(first.id, 'fixture', false), protectedWork);
  pending.resolve();
  assert.equal((await changing).reconnected, 1);
  first.state.mcp = mcpState([{ name: 'fixture', status: 'failed' }]);
  await assert.rejects(h.engine.reloadSessionMcp(first.id), /connections not confirmed: fixture/);
  assert.equal((await h.engine.getMeta(first.id))?.loaded, true);
  assert.equal((await h.engine.getMeta(first.id))?.activeMcpOperations, 0);
  await h.engine.unload(first.id);
  await assert.rejects(h.engine.reloadSessionMcp(first.id), unavailableSession);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
});

test('session MCP reload rejects native cache failures before reconnecting or closing anything', async t => {
  const h = harness(t);
  const s = await h.load();
  const resumes = h.runtime.resumeSession.mock.callCount();
  h.runtime.rpc.mcp.config.reload.mock.mockImplementationOnce(async () => { throw new Error('native definition cache unavailable'); });
  await assert.rejects(h.engine.reloadSessionMcp(s.id), /native definition cache unavailable/);
  assert.equal(s.rpc.mcp.reload.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations ?? 0, 0);
  assert.equal((await h.engine.getMeta(s.id))?.closing, false);
});

test('session MCP reload readback accepts native reset to global choices without restoring session overrides', async t => {
  const h = harness(t, { mcpServers: { fixture: { command: 'native-fixture' } } });
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
  const prefs = readFileSync(h.prefsFile, 'utf8');
  const resumes = h.runtime.resumeSession.mock.callCount();
  s.rpc.mcp.reload.mock.mockImplementation(async () => {
    const enabled = h.discoveredMcp[0]!.enabled;
    s.state.mcp = mcpState([{ name: 'fixture', status: enabled ? 'connected' : 'disabled' }], enabled ? [] : ['fixture']);
  });
  assert.equal((await h.engine.listSessionMcp(s.id)).servers[0]!.enabled, false);
  assert.deepEqual(await h.engine.reloadSessionMcp(s.id), { reconnected: 1 });
  assert.equal((await h.engine.listSessionMcp(s.id)).servers[0]!.enabled, true);
  h.discoveredMcp[0]!.enabled = false;
  assert.deepEqual(await h.engine.reloadSessionMcp(s.id), { reconnected: 0 });
  assert.equal((await h.engine.listSessionMcp(s.id)).servers[0]!.enabled, false);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.config.reload.mock.callCount(), 2);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs);
});
