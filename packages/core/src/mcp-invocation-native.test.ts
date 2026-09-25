import assert from 'node:assert/strict';
import { fixtureModelCatalog, memorySessionDefaults } from '../test-support/session-defaults.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { MCP_INVOCATION_META_KEY, type SessionRole } from '@cockpit/protocol';
import type { RoleProvider } from './roles.ts';

test('native module MCP invocation _meta: main agent, subagent and third-party server', {
  skip: process.env.COCKPIT_NATIVE_MCP_META !== '1', timeout: 90_000,
}, async () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const root = resolve(`.native-mcp-meta-${randomUUID()}`);
  const dirs = Object.fromEntries(['home', 'state', 'work', 'scratch', 'config', 'cache', 'run'].map(name => {
    const directory = join(root, name); mkdirSync(directory, { recursive: true }); return [name, directory];
  }));
  const env = {
    HOME: dirs.home!, USERPROFILE: dirs.home!, COPILOT_HOME: dirs.home!, COCKPIT_HOME: dirs.state!,
    XDG_CONFIG_HOME: dirs.config!, XDG_CACHE_HOME: dirs.cache!, XDG_STATE_HOME: dirs.state!,
    XDG_RUNTIME_DIR: dirs.run!, TMPDIR: dirs.scratch!, TMP: dirs.scratch!, TEMP: dirs.scratch!,
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', COPILOT_DISABLE_KEYTAR: '1',
    COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'),
  };
  const calls: { path: string; meta: Record<string, unknown> | undefined }[] = [];
  const mcp = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    if (!('id' in message)) { response.writeHead(202); response.end(); return; }
    if (message.method === 'tools/call') calls.push({ path: request.url!, meta: message.params._meta });
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'probe', description: 'probe', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: 'synthetic' }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  // Main agent: module probe, third-party probe, then a synchronous subagent that
  // calls the module probe once; every other turn simply stops.
  const provider = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { model: string; messages: { role: string; content?: unknown }[]; tools?: { function: { name: string } }[] };
    const names = (body.tools ?? []).map(tool => tool.function.name);
    const lastUser = body.messages.findLastIndex(message => message.role === 'user');
    const results = body.messages.slice(lastUser + 1).filter(message => message.role === 'tool').length;
    const prompt = JSON.stringify(body.messages[lastUser]?.content);
    const moduleProbe = names.find(name => name.startsWith('module_fixture') && name.endsWith('probe'));
    const thirdProbe = names.find(name => name.startsWith('third_party') && name.endsWith('probe'));
    const plan = prompt.includes('SUBAGENT_FIXTURE') ? [moduleProbe && { name: moduleProbe, arguments: '{}' }]
      : prompt.includes('MAIN_FIXTURE') ? [
        moduleProbe && { name: moduleProbe, arguments: '{}' },
        thirdProbe && { name: thirdProbe, arguments: '{}' },
        names.includes('task') && { name: 'task', arguments: JSON.stringify({
          agent_type: 'general-purpose', description: 'fixture', name: 'fixture', prompt: 'SUBAGENT_FIXTURE', mode: 'sync',
        }) },
      ] : [];
    const call = plan[results] || undefined;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (choice: Record<string, unknown>) => response.write(`data: ${JSON.stringify({
      id: 'fixture', created: 1, model: body.model, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }],
    })}\n\n`);
    if (call) {
      emit({ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: call }] }, finish_reason: null });
      emit({ delta: {}, finish_reason: 'tool_calls' });
    } else {
      emit({ delta: { role: 'assistant', content: 'Synthetic reply' }, finish_reason: null });
      emit({ delta: {}, finish_reason: 'stop' });
    }
    response.end('data: [DONE]\n\n');
  });
  const listen = async (server: Server) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  let engine: import('./engine.ts').Engine | undefined;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env); process.chdir(dirs.work!);
    const mcpUrl = await listen(mcp);
    const providerUrl = await listen(provider);
    const { RuntimeConnection, ToolSet } = await import('@github/copilot-sdk');
    const { OfficialRuntime } = await import('./runtime.ts');
    const { Engine } = await import('./engine.ts');
    const runtime = new OfficialRuntime({
      clientOptions: {
        connection: RuntimeConnection.forStdio({ env }), mode: 'empty', baseDirectory: dirs.state,
        workingDirectory: dirs.work, builtinPluginDirectories: [], useLoggedInUser: false,
        enableRemoteSessions: false, logLevel: 'error', onListModels: fixtureModelCatalog,
      },
      sessionConfig: {
        model: 'gpt-4.1', provider: { type: 'openai', wireApi: 'completions', baseUrl: `${providerUrl}/v1`, modelId: 'gpt-4.1' },
        configDirectory: dirs.state, skipCustomInstructions: true, enableFileHooks: false, enableHostGitOperations: false,
        enableSessionStore: false, enableSkills: false, skillDirectories: [], pluginDirectories: [], instructionDirectories: [],
        enableManagedSettings: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
        enableSessionTelemetry: false, remoteSession: 'off',
        availableTools: new ToolSet().addBuiltIn('task').addMcp('*'),
        // Stands in for a user-configured server that is not registered by a module.
        mcpServers: { third_party: { type: 'http', url: `${mcpUrl}/third`, tools: ['*'] } },
      },
    });
    engine = new Engine({ runtime, sessionDefaults: memorySessionDefaults('gpt-4.1') });
    const role: SessionRole = { moduleId: 'fixture', moduleName: 'Fixture', roleId: 'node', name: 'Node' };
    const saved = new Map<string, SessionRole[]>();
    const roles: RoleProvider = {
      list: () => [role], read: id => saved.get(id) ?? [], save: (id, values) => { saved.set(id, values); },
      assemble: async (id, choices) => ({
        roles: choices.map(() => role), fingerprint: 'fixture', skills: [],
        config: {
          systemMessage: { mode: 'append', content: `Synthetic role. Native session ID: ${id}.` },
          mcpServers: { module_fixture: { type: 'http', url: `${mcpUrl}/module`, tools: ['*'] } },
        },
      }),
    };
    engine.setRoleProvider(roles);
    await engine.start();
    const id = await engine.newSession(dirs.work!, [role]);
    await engine.prompt(id, 'MAIN_FIXTURE');
    const deadline = Date.now() + 60_000;
    while (calls.length < 3 || await engine.busyCount()) {
      assert.ok(Date.now() < deadline, `Native turn must settle; MCP calls: ${JSON.stringify(calls)}`);
      await sleep(50);
    }
    assert.equal(calls.length, 3, JSON.stringify(calls));
    const [main, third, sub] = calls;
    assert.equal(main!.path, '/module');
    assert.deepEqual(main!.meta?.[MCP_INVOCATION_META_KEY], { sessionId: id, runtimeSessionId: id, subagent: false });
    assert.ok('progressToken' in main!.meta!, 'native request _meta is preserved');
    assert.equal(third!.path, '/third');
    assert.equal(third!.meta?.[MCP_INVOCATION_META_KEY], undefined, 'third-party servers receive no origin metadata');
    assert.equal(sub!.path, '/module');
    const origin = sub!.meta?.[MCP_INVOCATION_META_KEY] as Record<string, unknown>;
    assert.equal(origin.sessionId, id);
    assert.equal(origin.subagent, true);
    assert.equal(typeof origin.runtimeSessionId, 'string');
    assert.notEqual(origin.runtimeSessionId, id);
    assert.equal(origin.agentName, 'general-purpose');
  } finally {
    await engine?.stop().catch(() => undefined);
    mcp.close(); provider.close();
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
