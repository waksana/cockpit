import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolSet, type SessionConfig } from '@github/copilot-sdk';
import { ToolScope } from '@cockpit/protocol';
import type { RoleProvider } from './roles.ts';
import { assertScopeServerIdentities, assertScopeToolMetadata, nativeToolScope, toolScopeHook } from './tool-scope.ts';
import { harness, mcpState } from '../test-support/engine-harness.ts';

test('scope selections are explicit, strict and source-qualified, including empty', () => {
  assert.deepEqual(nativeToolScope({ builtins: [], mcpServers: [] }).toArray(), []);
  assert.deepEqual(nativeToolScope({
    builtins: ['view'], mcpServers: [{ name: 'module_fixture__tools', tools: ['read'] }],
  }).toArray(), ['builtin:view', 'mcp:module_fixture__tools-read']);
  for (const value of [
    { builtins: ['*'], mcpServers: [] }, { builtins: ['view', 'view'], mcpServers: [] },
    { builtins: ['builtin:view'], mcpServers: [] }, { builtins: [], mcpServers: [{ name: 'x', tools: ['*'] }] },
    { builtins: [], mcpServers: [{ name: 'x', tools: ['read', 'read'] }] },
    { builtins: [], mcpServers: [{ name: 'x', tools: [] }, { name: 'x', tools: [] }] },
    { builtins: [], mcpServers: [], arbitrary: true },
    { builtins: [], mcpServers: [{ name: 'x', tools: ['read-thing'] }] },
    { builtins: [], mcpServers: [{ name: 'x', tools: ['read.thing'] }] },
  ]) assert.equal(ToolScope.safeParse(value).success, false);
});

test('ambiguous MCP wire namespaces fail instead of admitting an unrelated tool', () => {
  const scope = { builtins: [], mcpServers: [{ name: 'alpha-beta', tools: ['read'] }] };
  assert.doesNotThrow(() => assertScopeServerIdentities(scope, ['alpha-beta', 'unrelated']));
  assert.throws(() => assertScopeServerIdentities(scope, ['alpha-beta', 'alpha']), /Conflicting.*namespace/);
  assert.throws(() => assertScopeServerIdentities(scope, ['unrelated']), /not configured/);
  for (const name of ['alpha.beta', 'alpha beta', 'alpha/beta']) {
    assert.throws(() => assertScopeServerIdentities(scope, ['alpha-beta', name]), /Unsupported MCP namespace/);
  }
  assert.throws(() => assertScopeServerIdentities({ builtins: [], mcpServers: [
    { name: 'alpha', tools: ['beta-read'] }, { name: 'alpha-beta', tools: ['read'] },
  ] }, ['alpha', 'alpha-beta']), /Conflicting/);
});

test('Engine reapplies persisted scope across unload/reload and reads actual native metadata passively', async t => {
  const h = harness(t);
  const saved = new Map<string, ToolScope>();
  const provider: RoleProvider = {
    list: () => [], read: () => [], save: () => {},
    readToolScope: async id => saved.get(id),
    saveToolScope: (id, value) => { saved.set(id, value); },
    assemble: async () => ({ roles: [], config: {}, skills: [], fingerprint: 'empty' }),
  };
  h.engine.setRoleProvider(provider);
  const create = h.runtime.createSession.bind(h.runtime);
  t.mock.method(h.runtime, 'createSession', async (config: SessionConfig) => {
    const sdk = await create(config);
    h.natives.get(sdk.sessionId)!.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [] }));
    return sdk;
  });
  const scope = { builtins: [], mcpServers: [] };
  const id = await h.engine.newSession(h.cwd, [], scope);
  const filters = () => {
    const tools = h.configs.get(id)!.availableTools;
    assert.ok(tools instanceof ToolSet);
    return tools.toArray();
  };
  assert.deepEqual(filters(), []);
  const native = h.natives.get(id)!;
  native.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [] }));
  const events = h.events.length;
  assert.deepEqual(await h.engine.getSessionToolScope(id), {
    sessionId: id, loaded: true, configured: scope, applied: scope, tools: [],
  });
  assert.equal(h.events.length, events, 'passive scope reads emit no mutation frames');
  await assert.rejects(h.engine.forkSession(id), /tool-scoped session/);
  await h.engine.unload(id);
  const resumes = h.runtime.resumeSession.mock.callCount();
  assert.deepEqual(await h.engine.getSessionToolScope(id), {
    sessionId: id, loaded: false, configured: scope, applied: null, tools: null,
  });
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  await h.engine.load(id);
  assert.deepEqual(filters(), []);
  await h.engine.reload(id);
  assert.deepEqual(filters(), []);
  native.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: null }));
  assert.equal((await h.engine.getSessionToolScope(id)).tools, null);
  const unscoped = await h.engine.newSession(h.cwd);
  assert.equal(h.configs.get(unscoped)!.availableTools, undefined);
  assert.equal((await h.engine.getSessionToolScope(unscoped)).configured, null);
});

test('scoped load, MCP enable, reload and preparation reject namespace conflicts before connection effects', async t => {
  const h = harness(t);
  const saved = new Map<string, ToolScope>();
  h.engine.setRoleProvider({
    list: () => [], read: () => [], save: () => {},
    readToolScope: async id => saved.get(id),
    saveToolScope: (id, scope) => { saved.set(id, scope); },
    assemble: async () => ({ roles: [], skills: [], fingerprint: 'fixture', config: {} }),
  });
  h.mcpDefinitions['alpha-beta'] = { type: 'http', url: 'http://127.0.0.1:1/mcp', tools: ['read'] };
  const create = h.runtime.createSession.bind(h.runtime);
  t.mock.method(h.runtime, 'createSession', async (config: SessionConfig) => {
    const sdk = await create(config);
    h.natives.get(sdk.sessionId)!.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [
      { name: 'alpha-beta-read', description: '', mcpServerName: 'alpha-beta', mcpToolName: 'read' },
    ] }));
    return sdk;
  });
  const scope = { builtins: [], mcpServers: [{ name: 'alpha-beta', tools: ['read'] }] };
  const id = await h.engine.newSession(h.cwd, [], scope);
  const native = h.natives.get(id)!;
  native.state.mcp = mcpState([
    { name: 'alpha-beta', status: 'connected' }, { name: 'alpha', status: 'disabled' },
  ], ['alpha']);
  h.mcpDefinitions.alpha = { type: 'http', url: 'http://127.0.0.1:1/mcp', tools: ['beta-read'] };
  await assert.rejects(h.engine.toggleSessionMcp(id, 'alpha', true), /Conflicting.*namespace/);
  assert.equal(native.rpc.mcp.enable.mock.callCount(), 0);
  await assert.rejects(h.engine.reloadSessionMcp(id), /Conflicting.*namespace/);
  assert.equal(native.rpc.mcp.reload.mock.callCount(), 0);
  const prepared = await h.engine.prepareSessionResources({ sessionId: id, mcpServers: [{ name: 'alpha' }] });
  assert.equal(prepared.ok, false);
  assert.match(prepared.error!, /Conflicting.*namespace/);
  assert.equal(native.rpc.mcp.enable.mock.callCount(), 0);
  await h.engine.unload(id);
  await assert.rejects(h.engine.load(id), /Conflicting.*namespace/);
});

test('metadata must prove exact raw pairs; one bad descriptor invalidates the entire scope', () => {
  const scope = { builtins: [], mcpServers: [{ name: 'alpha-beta', tools: ['read_thing'] }] };
  const valid = { name: 'alpha-beta-read_thing', description: '',
    mcpServerName: 'alpha-beta', mcpToolName: 'read_thing', namespacedName: 'alpha-beta/read_thing' };
  assert.doesNotThrow(() => assertScopeToolMetadata(scope, [valid]));
  for (const tools of [
    null, [valid, { name: 'view', description: '' }], [valid, valid],
    [{ ...valid, mcpServerName: 'alpha.beta' }], [{ ...valid, mcpToolName: 'read.thing' }],
    [{ ...valid, namespacedName: 'other/read_thing' }],
  ]) assert.throws(() => assertScopeToolMetadata(scope, tools), /Tool scope/);
});

test('scoped role resources cannot be replaced by a newly configured same-name global server', async t => {
  const h = harness(t);
  const roles = [{ moduleId: 'fixture', moduleName: 'Fixture', roleId: 'foreground', name: 'Foreground' }];
  const scope = { builtins: [], mcpServers: [{ name: 'service', tools: ['read'] }] };
  const saved = new Map<string, typeof roles>();
  const scopes = new Map<string, ToolScope>();
  h.engine.setRoleProvider({
    list: () => roles, read: id => saved.get(id) ?? [], save: (id, values) => { saved.set(id, values); },
    readToolScope: async id => scopes.get(id), saveToolScope: (id, value) => { scopes.set(id, value); },
    assemble: async () => ({ roles, skills: [], fingerprint: 'service', config: {
      mcpServers: { service: { type: 'http', url: 'http://127.0.0.1:1/owned', tools: ['read'] } },
    } }),
  });
  const create = h.runtime.createSession.bind(h.runtime);
  t.mock.method(h.runtime, 'createSession', async (config: SessionConfig) => {
    const sdk = await create(config);
    const native = h.natives.get(sdk.sessionId)!;
    native.state.mcp = mcpState([{ name: 'service', status: 'connected' }]);
    native.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [
      { name: 'service-read', description: '', mcpServerName: 'service', mcpToolName: 'read' },
    ] }));
    return sdk;
  });
  const id = await h.engine.newSession(h.cwd, roles, scope);
  assert.equal((await h.engine.roleReadiness(id)).ready, true);
  h.mcpDefinitions.service = { type: 'http', url: 'http://127.0.0.1:1/unrelated', tools: ['*'] };
  await assert.rejects(h.engine.initializeSessionTools(id), /Role MCP conflicts/);
  await assert.rejects(h.engine.reloadSessionMcp(id), /Role MCP conflicts/);
  assert.equal(h.natives.get(id)!.rpc.mcp.reload.mock.callCount(), 0);
  assert.equal((await h.engine.roleReadiness(id)).ready, false);
});

test('native denial guard handles missing metadata, wrong raw pair and child origin without calling previous hooks', async t => {
  const h = harness(t);
  const sdk = await h.runtime.createSession({ sessionId: 'synthetic-scope' });
  const native = h.natives.get(sdk.sessionId)!;
  const scope = { builtins: [], mcpServers: [{ name: 'service', tools: ['read'] }] };
  const previous = t.mock.fn(async () => ({ additionalContext: 'existing hook' }));
  const hook = toolScopeHook(scope, () => sdk, previous);
  const input = { sessionId: sdk.sessionId, timestamp: new Date(), workingDirectory: h.cwd,
    toolName: 'service-read', toolArgs: {} };
  const context = { sessionId: sdk.sessionId };
  for (const tools of [null, [{ name: 'service-read', description: '', mcpServerName: 'wrong', mcpToolName: 'read' }]]) {
    native.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools }));
    assert.equal((await hook(input, context))?.permissionDecision, 'deny');
  }
  native.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [
    { name: 'service-read', description: '', mcpServerName: 'service', mcpToolName: 'read' },
  ] }));
  assert.equal((await hook({ ...input, sessionId: 'native-child' }, context))?.permissionDecision, 'deny');
  assert.equal(previous.mock.callCount(), 0);
  assert.deepEqual(await hook(input, context), { additionalContext: 'existing hook' });
  assert.equal(previous.mock.callCount(), 1);
});

test('invalid actual metadata closes newly created scope and retains truthful native creation identity', async t => {
  const h = harness(t);
  const scopes = new Map<string, ToolScope>();
  h.engine.setRoleProvider({
    list: () => [], read: () => [], save: () => {},
    readToolScope: async id => scopes.get(id),
    saveToolScope: (id, scope) => { scopes.set(id, scope); },
    assemble: async () => ({ roles: [], config: {}, skills: [], fingerprint: 'empty' }),
  });
  await assert.rejects(h.engine.newSession(h.cwd, [], { builtins: [], mcpServers: [] }),
    { code: 'SESSION_CREATION_INCOMPLETE' });
  assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  const id = [...scopes.keys()][0]!;
  assert.equal((await h.engine.getSessionToolScope(id)).loaded, false);
  assert.deepEqual((await h.engine.getSessionToolScope(id)).configured, { builtins: [], mcpServers: [] });
});
