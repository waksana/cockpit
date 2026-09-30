import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Engine, OfficialRuntime } from '@cockpit/core';
import { MCP_INVOCATION_META_KEY, type ToolScope } from '@cockpit/protocol';
import { ModuleRoles } from './module-roles.ts';
import { installLocalModule } from './module-install.ts';
import { archive, moduleEntries, removeFixture } from './test-support/module-fixture.ts';
import { memorySessionDefaults, fixtureModelCatalog } from '../../../packages/core/test-support/session-defaults.ts';
import { assertScopeToolMetadata, toolScopeHook } from '../../../packages/core/src/tool-scope.ts';
type CopilotSession = Awaited<ReturnType<OfficialRuntime['createSession']>>;

test('native immutable tool scope: direct calls, MCP/model changes, role reload and durable Host restart', {
  skip: process.env.COCKPIT_NATIVE_TOOL_SCOPE !== '1', timeout: 90_000,
}, async t => {
  const before = { ...process.env };
  const previousCwd = process.cwd();
  const root = resolve(`.native-tool-scope-${randomUUID()}`);
  const dirs = Object.fromEntries(['home', 'copilot', 'cockpit', 'work', 'scratch', 'cache', 'config', 'run'].map(name => {
    const path = join(root, name); mkdirSync(path, { recursive: true }); return [name, path];
  }));
  const env = {
    HOME: dirs.home!, USERPROFILE: dirs.home!, COPILOT_HOME: dirs.copilot!, COCKPIT_HOME: dirs.cockpit!,
    XDG_CONFIG_HOME: dirs.config!, XDG_CACHE_HOME: dirs.cache!, XDG_STATE_HOME: dirs.copilot!,
    XDG_RUNTIME_DIR: dirs.run!, TMPDIR: dirs.scratch!, TMP: dirs.scratch!, TEMP: dirs.scratch!,
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', COPILOT_DISABLE_KEYTAR: '1',
    COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'), COCKPIT_PORT: '0',
  };
  const calls: Array<{ path: string; name: string; meta?: Record<string, unknown> }> = [];
  const prompts: Array<{ tools?: Array<{ function: { name: string } }>; messages: unknown[] }> = [];
  const mcp = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    if (!('id' in message)) { response.writeHead(202); response.end(); return; }
    if (message.method === 'tools/call') calls.push({ path: request.url!, name: message.params.name, meta: message.params._meta });
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
      : message.method === 'tools/list'
        ? { tools: ['read', 'hidden', 'read.thing', 'read-thing', 'read_thing']
          .map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }
        : { content: [{ type: 'text', text: 'Synthetic selected tool' }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  const provider = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    prompts.push(message);
    const latest = JSON.stringify(message.messages.at(-1));
    const requested = latest.includes('Synthetic scoped model tool call') ? {
      name: 'fixture-service-read', arguments: '{}',
    } : latest.includes('Synthetic forbidden scope tool call') ? {
      name: 'bash', arguments: JSON.stringify({ command: `echo synthetic > ${JSON.stringify(join(dirs.work!, 'forbidden-marker'))}` }),
    } : undefined;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [{
      delta: requested ? { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-model-tool',
        type: 'function', function: requested }] } : { role: 'assistant', content: 'Synthetic response' },
      finish_reason: null,
    }, { delta: {}, finish_reason: requested ? 'tool_calls' : 'stop' }]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: 'gpt-4.1', choices: [{ index: 0, ...choice }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  const execute = async (sdk: CopilotSession, name: string, toolCallId?: string) => {
    const result = await sdk.rpc.tools.execute({ name, arguments: {}, ...(toolCallId ? { toolCallId } : {}) });
    assert.ok(typeof result === 'object' && result !== null, 'Expected structured native tool result');
    return result;
  };
  const listen = async (server: Server) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  let engine: Engine | undefined;
  const probes: Array<{ runtime: OfficialRuntime; sdk: CopilotSession }> = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env); process.chdir(dirs.work!);
    const mcpUrl = await listen(mcp), providerUrl = await listen(provider);
    const entries = moduleEntries('fixture', undefined, { roles: [
      { id: 'foreground', name: 'Foreground', instructions: 'foreground.md',
        mcpServers: { 'fixture-service': { type: 'http', path: '/mcp', tools: ['read'] } } },
      { id: 'extra', name: 'Extra', mcpServers: { extra: { type: 'http', path: '/extra', tools: ['*'] } } },
    ] });
    entries.push({ path: 'foreground.md', content: 'Synthetic foreground instructions remain appended without a Skill/view tool.' });
    const packagePath = join(root, 'fixture.tgz');
    writeFileSync(packagePath, archive(entries));
    const installed = await installLocalModule(packagePath, { trustLocalCode: true, hostRoot: dirs.cockpit });
    const handles = new Map<string, CopilotSession>();
    const createEngine = () => {
      const runtime = new OfficialRuntime({
        clientOptions: {
          mode: 'empty', baseDirectory: dirs.copilot,
          workingDirectory: dirs.work, builtinPluginDirectories: [], useLoggedInUser: false,
          enableRemoteSessions: false, logLevel: 'error', onListModels: fixtureModelCatalog,
        },
        sessionConfig: {
          provider: { type: 'openai', wireApi: 'completions', baseUrl: `${providerUrl}/v1`, modelId: 'gpt-4.1' },
          configDirectory: dirs.copilot, enableFileHooks: false, enableHostGitOperations: false,
          enableSessionStore: false, enableSkills: false, skillDirectories: [], pluginDirectories: [],
          instructionDirectories: [], customAgents: [], enableManagedSettings: false,
          skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
          enableSessionTelemetry: false, remoteSession: 'off', enableExperimentalMode: true,
          availableTools: ['builtin:view', 'mcp:*'],
        },
      });
      const create = runtime.createSession.bind(runtime), resume = runtime.resumeSession.bind(runtime);
      t.mock.method(runtime, 'createSession', async (...args: Parameters<typeof create>) => {
        const sdk = await create(...args); handles.set(sdk.sessionId, sdk); return sdk;
      });
      t.mock.method(runtime, 'resumeSession', async (...args: Parameters<typeof resume>) => {
        const sdk = await resume(...args); handles.set(sdk.sessionId, sdk); return sdk;
      });
      const value = new Engine({ runtime, sessionDefaults: memorySessionDefaults('gpt-4.1') });
      value.setRoleProvider(new ModuleRoles(dirs.cockpit!, mcpUrl, () => [installed]));
      return { runtime, engine: value };
    };
    let current = createEngine(); engine = current.engine;
    await engine.start();
    await current.runtime.rpc.mcp.config.add({ name: 'unrelated', config: { type: 'http', url: `${mcpUrl}/global`, tools: ['*'] } });
    await current.runtime.rpc.mcp.config.disable({ names: ['unrelated'] });
    const scope: ToolScope = { builtins: [], mcpServers: [{ name: 'fixture-service', tools: ['read'] }] };
    const id = await engine.newSession(dirs.work!, [{ moduleId: 'fixture', roleId: 'foreground' }], scope);
    const check = async () => {
      const result = await engine!.getSessionToolScope(id);
      assert.deepEqual(result.configured, scope); assert.deepEqual(result.applied, scope);
      assert.deepEqual(result.tools, [{
        name: 'fixture-service-read', namespacedName: 'fixture-service/read',
        mcpServerName: 'fixture-service', mcpToolName: 'read',
      }]);
      for (const name of ['bash', 'view', 'task', 'fixture-service-hidden', 'unrelated-read', 'extra-read']) {
        const call = await execute(handles.get(id)!, name);
        assert.equal(call.resultType, 'denied', name);
        assert.match(call.error!, /not currently offered/);
      }
    };
    await check();
    assert.equal(prompts.length, 0, 'scope setup never sends a hidden prompt');
    const allowed = await execute(handles.get(id)!, 'fixture-service-read', 'synthetic-scoped-call');
    assert.equal(allowed.resultType, 'success'); assert.equal(calls.length, 1); assert.equal(calls[0]!.name, 'read');
    assert.deepEqual(calls[0]!.meta?.[MCP_INVOCATION_META_KEY], {
      sessionId: id, runtimeSessionId: id, subagent: false, toolCallId: 'synthetic-scoped-call',
    }, 'native scope hook preserves module Actor attribution');
    await engine.toggleSessionMcp(id, 'unrelated', true);
    await engine.initializeSessionTools(id); await check();
    await engine.setModel(id, 'gpt-4.1', undefined, 'default');
    await handles.get(id)!.sendAndWait({ prompt: 'Synthetic model-specific tool initialization.' });
    await check();
    assert.deepEqual(prompts.at(-1)!.tools!.map(tool => tool.function.name), ['fixture-service-read']);
    await engine.reloadSessionMcp(id); await engine.initializeSessionTools(id); await check();
    await engine.setModel(id, 'gpt-4.1', undefined, 'default');
    assert.equal((await engine.getSessionToolScope(id)).tools, null);
    await engine.initializeSessionTools(id); await check();
    const blockedPreparation = await engine.prepareSessionResources({ sessionId: id, mcpServers: [{ name: 'unrelated', tools: ['read'] }] });
    assert.equal(blockedPreparation.ok, false, 'resource preparation cannot widen tool scope');
    await check();
    await handles.get(id)!.sendAndWait({ prompt: 'Synthetic persisted scope fixture.' });
    assert.deepEqual(prompts.at(-1)!.tools!.map(tool => tool.function.name), ['fixture-service-read']);
    assert.match(JSON.stringify(prompts.at(-1)!.messages), /Synthetic foreground instructions/);
    await handles.get(id)!.sendAndWait({ prompt: 'Synthetic scoped model tool call.' });
    assert.equal(calls.length, 2, 'a real model-originated selected call reaches only the role MCP');
    assert.deepEqual(calls.at(-1)!.meta?.[MCP_INVOCATION_META_KEY], {
      sessionId: id, runtimeSessionId: id, subagent: false, toolCallId: 'synthetic-model-tool',
    });
    await handles.get(id)!.sendAndWait({ prompt: 'Synthetic forbidden scope tool call.' });
    assert.equal(calls.length, 2);
    assert.equal(existsSync(join(dirs.work!, 'forbidden-marker')), false, 'a forged model builtin request cannot execute a shell');
    await assert.rejects(engine.forkSession(id), /tool-scoped session/);
    await engine.addRoles(id, [{ moduleId: 'fixture', roleId: 'extra' }]);
    await check();
    await engine.reload(id); await check();
    await engine.unload(id);
    assert.deepEqual(await engine.getSessionToolScope(id), {
      sessionId: id, loaded: false, configured: scope, applied: null, tools: null,
    });
    await engine.load(id); await check();
    const intersected = await engine.newSession(dirs.work!, [{ moduleId: 'fixture', roleId: 'foreground' }],
      { builtins: [], mcpServers: [{ name: 'fixture-service', tools: ['read', 'hidden'] }] });
    assert.deepEqual((await engine.getSessionToolScope(intersected)).tools?.map(tool => tool.mcpToolName), ['read']);
    assert.equal((await execute(handles.get(intersected)!, 'fixture-service-hidden')).resultType,
      'denied', 'scope does not enlarge the role raw-tool subset');
    const createCount = handles.size;
    await assert.rejects(engine.newSession(dirs.work!, [{ moduleId: 'fixture', roleId: 'foreground' }],
      { builtins: [], mcpServers: [{ name: 'fixture-service', tools: ['read-thing'] }] }), /ASCII letters/);
    assert.equal(handles.size, createCount, 'ambiguous raw selection fails before native creation');
    const empty = await engine.newSession(dirs.work!, [], { builtins: [], mcpServers: [] });
    assert.deepEqual((await engine.getSessionToolScope(empty)).tools, []);
    await handles.get(empty)!.sendAndWait({ prompt: 'Synthetic persisted empty scope fixture.' });
    assert.equal(prompts.at(-1)!.tools?.length ?? 0, 0);
    const unscoped = await engine.newSession(dirs.work!);
    await engine.initializeSessionTools(unscoped);
    assert.ok((await engine.getSessionToolScope(unscoped)).tools!.some(tool => tool.name === 'view'));
    assert.equal((await engine.getSessionToolScope(unscoped)).configured, null);
    assert.equal((await engine.snapshot()).permissionPolicy, 'allow-all');
    const workerScope: ToolScope = { builtins: ['view'], mcpServers: [{ name: 'unrelated', tools: ['read_thing'] }] };
    const worker = await engine.newSession(dirs.work!, [], workerScope);
    await engine.toggleSessionMcp(worker, 'unrelated', true);
    await engine.initializeSessionTools(worker);
    const workerTools = (await handles.get(worker)!.rpc.tools.getCurrentMetadata()).tools;
    assertScopeToolMetadata(workerScope, workerTools);
    assert.deepEqual(workerTools?.map(tool => tool.name).sort(), ['unrelated-read_thing', 'view']);
    assert.equal((await execute(handles.get(worker)!, 'unrelated-read_thing')).resultType,
      'success', 'underscore raw names stay exact even beside dot/hyphen aliases');
    assert.equal(calls.at(-1)!.name, 'read_thing');
    const unsafeRawScope: ToolScope = { builtins: [], mcpServers: [{ name: 'raw-fixture', tools: ['read-thing'] }] };
    const guarded: CopilotSession = await current.runtime.createSession({
      model: 'gpt-4.1', availableTools: ['mcp:raw-fixture-read-thing'],
      mcpServers: { 'raw-fixture': { type: 'http', url: `${mcpUrl}/raw`, tools: ['*'] } },
      hooks: { onPreToolUse: toolScopeHook(unsafeRawScope, () => guarded) },
    });
    probes.push({ runtime: current.runtime, sdk: guarded });
    await guarded.rpc.tools.initializeAndValidate();
    assert.equal((await guarded.rpc.tools.getCurrentMetadata()).tools?.[0]?.mcpToolName, 'read.thing');
    const beforeDenied = calls.length;
    const denied = await execute(guarded, 'raw-fixture-read-thing');
    assert.equal(denied.resultType, 'denied', 'public pre-tool deny prevents a normalized raw alias from executing');
    assert.match(denied.error!, /Tool scope violation/);
    assert.equal(calls.length, beforeDenied);
    await current.runtime.closeSession(guarded); probes.length = 0;
    await engine.stop();
    current = createEngine(); engine = current.engine;
    await engine.start();
    assert.deepEqual((await engine.getSessionToolScope(id)).configured, scope);
    await engine.load(id); await check();
    await engine.load(empty);
    assert.deepEqual((await engine.getSessionToolScope(empty)).tools, []);
    assert.equal(calls.length, 3, 'only two selected direct calls and one selected model call reach MCP');
    const foreground = [{ moduleId: 'fixture', roleId: 'foreground' }];
    assert.equal((await engine.roleReadiness(id, foreground)).ready, true);
    assert.equal((await engine.getMeta(id))?.roles?.length, 2);
    assert.equal((await engine.getMeta(id))?.appliedRoles?.length, 2);
    await current.runtime.rpc.mcp.config.add({ name: 'fixture.service',
      config: { type: 'http', url: `${mcpUrl}/alias`, tools: ['read'] } });
    const configuredBefore = await current.runtime.rpc.mcp.config.list();
    await assert.rejects(engine.newSession(dirs.work!, [{ moduleId: 'fixture', roleId: 'foreground' }], scope),
      /Unsupported MCP namespace/);
    await assert.rejects(engine.initializeSessionTools(id), /Unsupported MCP namespace/);
    await assert.rejects(engine.reloadSessionMcp(id), /Unsupported MCP namespace/);
    const unready = await engine.roleReadiness(id, foreground);
    assert.equal(unready.ready, false);
    assert.match(unready.reasons.join('; '), /Unsupported MCP namespace/);
    assert.deepEqual(await current.runtime.rpc.mcp.config.list(), configuredBefore, 'scope validation never mutates global configuration');
    const sdk = handles.get(id)!;
    await sdk.rpc.mcp.reload(); await sdk.rpc.tools.initializeAndValidate();
    assert.equal((await sdk.rpc.tools.getCurrentMetadata()).tools?.[0]?.mcpServerName, 'fixture.service');
    const wrongServer = await execute(sdk, 'fixture-service-read');
    assert.equal(wrongServer.resultType, 'denied');
    assert.match(wrongServer.error!, /Tool scope violation/);
    assert.equal(calls.length, 3, 'even a direct native reload cannot call the aliased server');
    await sdk.rpc.mcp.disable({ serverName: 'fixture.service' });
    const disabledState = await sdk.rpc.mcp.list();
    await assert.rejects(engine.toggleSessionMcp(id, 'fixture.service', true), /Unsupported MCP namespace/);
    assert.deepEqual(await sdk.rpc.mcp.list(), disabledState, 'unsupported namespace fails before enable mutation');
    await engine.unload(id);
    await assert.rejects(engine.load(id), /Unsupported MCP namespace/);
    assert.equal((await engine.getSessionToolScope(id)).loaded, false);
    assert.deepEqual((await engine.getSessionToolScope(id)).configured, scope);
  } finally {
    try {
      for (const { runtime, sdk } of probes) await runtime.closeSession(sdk);
      await engine?.stop();
    }
    finally {
      for (const server of [mcp, provider]) {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      }
      process.chdir(previousCwd);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, before);
      await removeFixture(root);
    }
  }
});
