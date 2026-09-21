import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import type { RoleProvider } from './roles.ts';
import type { SessionRole } from '@cockpit/protocol';

test('native roles: selected skills, HTTP tool union, appended instructions and cold resume', {
  skip: process.env.COCKPIT_NATIVE_ROLES !== '1', timeout: 90_000,
}, async () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const root = resolve(`.native-role-${randomUUID()}`);
  const dirs = Object.fromEntries(['home', 'state', 'work', 'scratch', 'config', 'cache', 'run', 'skills'].map(name => {
    const directory = join(root, name); mkdirSync(directory, { recursive: true }); return [name, directory];
  }));
  const env = {
    HOME: dirs.home!, USERPROFILE: dirs.home!, COCKPIT_HOME: dirs.state!,
    XDG_CONFIG_HOME: dirs.config!, XDG_CACHE_HOME: dirs.cache!, XDG_STATE_HOME: dirs.state!,
    XDG_RUNTIME_DIR: dirs.run!, TMPDIR: dirs.scratch!, TMP: dirs.scratch!, TEMP: dirs.scratch!,
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', COPILOT_DISABLE_KEYTAR: '1',
    COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'),
  };
  const selected: SessionRole[] = ['owner', 'executor'].map(roleId => ({ moduleId: 'fixture', moduleName: 'Fixture', roleId, name: roleId }));
  const skills = selected.map(role => {
    const directory = join(dirs.skills!, role.roleId); mkdirSync(directory);
    const path = join(directory, 'SKILL.md');
    writeFileSync(path, `---\nname: fixture-${role.roleId}\ndescription: Synthetic role fixture\n---\nNo external work.\n`);
    return { name: `fixture-${role.roleId}`, path };
  });
  const metadata = new Map<string, SessionRole[]>();
  const captured: unknown[] = [];
  let mcpCalls = 0;
  const mcp = createServer(async (request, response) => {
    assert.equal(request.headers['x-cockpit-module-digest'], 'synthetic-digest');
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    if (!('id' in message)) { response.writeHead(202); response.end(); return; }
    mcpCalls++;
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
      : message.method === 'tools/list'
        ? { tools: ['read', 'create', 'report', 'not-selected'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }
        : { content: [{ type: 'text', text: 'synthetic' }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  const provider = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    captured.push(message);
    assert.ok(request.headers.authorization === undefined || request.headers.authorization.trim() === 'Bearer');
    const completion = { id: 'fixture', created: 1, model: message.model };
    if (message.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (choice: Record<string, unknown>) => {
        response.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] })}\n\n`);
      };
      emit({ delta: { role: 'assistant', content: 'Synthetic role reply' }, finish_reason: null });
      emit({ delta: {}, finish_reason: 'stop' }); response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...completion, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic role reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
  });
  const listen = async (server: Server) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  let runtime: import('./runtime.ts').OfficialRuntime | undefined;
  let engine: import('./engine.ts').Engine | undefined;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env); process.chdir(dirs.work!);
    const mcpUrl = await listen(mcp);
    const providerUrl = await listen(provider);
    const { RuntimeConnection, ToolSet } = await import('@github/copilot-sdk');
    const { OfficialRuntime } = await import('./runtime.ts');
    const { Engine } = await import('./engine.ts');
    runtime = new OfficialRuntime({
      clientOptions: {
        connection: RuntimeConnection.forStdio({ env }), mode: 'empty', baseDirectory: dirs.state,
        workingDirectory: dirs.work, builtinPluginDirectories: [], useLoggedInUser: false,
        enableRemoteSessions: false, logLevel: 'error', onListModels: () => [],
      },
      sessionConfig: {
        model: 'gpt-4.1', provider: { type: 'openai', wireApi: 'completions', baseUrl: `${providerUrl}/v1`, modelId: 'gpt-4.1' },
        configDirectory: dirs.state, enableFileHooks: false, enableHostGitOperations: false,
        enableSessionStore: false, enableSkills: true, pluginDirectories: [], instructionDirectories: [], customAgents: [],
        enableManagedSettings: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
        enableSessionTelemetry: false, remoteSession: 'off', enableExperimentalMode: true,
        availableTools: new ToolSet().addMcp('*'),
      },
    });
    engine = new Engine({ runtime });
    const roles: RoleProvider = {
      list: () => selected, read: id => metadata.get(id) ?? [], save: (id, values) => { metadata.set(id, values); },
      assemble: async (id, choices) => ({ roles: selected.filter(role => choices.some(choice => choice.roleId === role.roleId)),
        skills: skills.filter(skill => choices.some(choice => skill.name === `fixture-${choice.roleId}`)),
        fingerprint: choices.map(choice => choice.roleId).sort().join('+'),
        config: { skillDirectories: choices.map(role => join(dirs.skills!, role.roleId)),
          systemMessage: { mode: 'append', content: `Synthetic role source ${choices.map(role => `fixture/${role.roleId}`).join('+')}. Native session ID: ${id}.` },
          mcpServers: { module_fixture__tools: { type: 'http', url: `${mcpUrl}/mcp`,
            headers: { 'X-Cockpit-Module-Digest': 'synthetic-digest' },
            tools: ['read', ...choices.map(role => role.roleId === 'owner' ? 'create' : 'report')] } } },
      }),
    };
    engine.setRoleProvider(roles); await engine.start();
    const id = await engine.newSession(dirs.work!, selected);
    const readiness = await engine.roleReadiness(id);
    assert.equal(readiness.ready, true, JSON.stringify(readiness));
    assert.ok(mcpCalls >= 2);
    assert.equal(captured.length, 0, 'role creation never sends a startup prompt');
    await engine.prompt(id, 'Synthetic role test message');
    const deadline = Date.now() + 20_000;
    while (await engine.busyCount()) { assert.ok(Date.now() < deadline); await setTimeout(20); }
    assert.match(JSON.stringify(captured), new RegExp(`Native session ID: ${id}`));
    assert.doesNotMatch(JSON.stringify((captured[0] as { tools: unknown }).tools), /not-selected/);
    await engine.unload(id);
    assert.deepEqual((await engine.getMeta(id))!.roles, selected);
    assert.equal((await engine.roleReadiness(id)).loaded, false);
    await engine.load(id);
    assert.equal((await engine.roleReadiness(id)).ready, true);
    await runtime.rpc.mcp.config.add({ name: 'synthetic-unrelated', config: {
      type: 'http', url: `${mcpUrl}/mcp`, tools: ['read'],
      headers: { 'X-Cockpit-Module-Digest': 'synthetic-digest' },
    } });
    await runtime.rpc.mcp.config.disable({ names: ['synthetic-unrelated'] });
    const existing = await engine.newSession(dirs.work!);
    await engine.rename(existing, 'Synthetic existing responsibility');
    const emptySaved = await engine.addRoles(existing, [selected[1]!]);
    assert.equal(emptySaved.status, 'saved');
    assert.equal(emptySaved.rolesNeedReload, true);
    assert.deepEqual(emptySaved.appliedRoles, []);
    await engine.prompt(existing, 'Synthetic prior user history');
    while (await engine.busyCount()) { assert.ok(Date.now() < deadline); await setTimeout(20); }
    assert.doesNotMatch(JSON.stringify(captured.at(-1)), /fixture\/executor/, 'saving does not change the live system prompt');
    await engine.toggleSessionMcp(existing, 'synthetic-unrelated', true);
    const before = captured.length;
    const first = await engine.addRoles(existing, [selected[1]!]);
    assert.equal(first.status, 'unchanged', JSON.stringify(first));
    assert.equal(first.rolesNeedReload, true);
    assert.equal(first.sessionId, existing);
    assert.equal((await engine.listSessionMcp(existing)).servers.find(server => server.name === 'synthetic-unrelated')?.enabled, true,
      'metadata-only saves leave temporary native settings untouched');
    assert.equal(captured.length, before, 'adding roles sends no hidden prompt');
    assert.equal((await engine.getMeta(existing))?.title, 'Synthetic existing responsibility');
    assert.equal((await engine.getMeta(existing))?.cwd, dirs.work);
    assert.equal((await engine.roleReadiness(existing)).ready, false);
    await engine.reload(existing);
    assert.equal((await engine.getMeta(existing))?.rolesNeedReload, false);
    assert.deepEqual((await engine.getMeta(existing))?.appliedRoles, [selected[1]]);
    assert.equal((await engine.listSessionMcp(existing)).servers.find(server => server.name === 'synthetic-unrelated')?.enabled, false,
      'ordinary reload follows the global default, not a temporary-switch mirror');
    await engine.toggleSessionSkill(existing, 'fixture-executor', false);
    await engine.toggleSessionMcp(existing, 'module_fixture__tools', false);
    const second = await engine.addRoles(existing, [selected[0]!]);
    assert.equal(second.status, 'saved', JSON.stringify(second));
    assert.equal(second.rolesNeedReload, true);
    assert.deepEqual(second.appliedRoles, [selected[1]]);
    assert.equal((await engine.listSessionSkills(existing)).find(skill => skill.name === 'fixture-executor')?.enabled, false);
    assert.equal((await engine.listSessionMcp(existing)).servers.find(server => server.name === 'module_fixture__tools')?.enabled, false);
    await engine.reload(existing);
    const duplicate = await engine.addRoles(existing, selected);
    assert.equal(duplicate.status, 'unchanged', JSON.stringify(duplicate));
    assert.equal(duplicate.rolesNeedReload, false);
    await engine.prompt(existing, 'Synthetic after role addition');
    while (await engine.busyCount()) { assert.ok(Date.now() < deadline); await setTimeout(20); }
    const enabled = await engine.roleReadiness(existing);
    assert.equal(enabled.ready, true, JSON.stringify(enabled));
    const after = JSON.stringify(captured.at(-1));
    assert.match(after, /Synthetic prior user history/);
    assert.match(after, /fixture\/owner/);
    assert.match(after, /fixture\/executor/);
    assert.doesNotMatch(JSON.stringify((captured.at(-1) as { tools: unknown }).tools), /not-selected/);
    await engine.unload(existing);
    const resumed = await engine.addRoles(existing, selected);
    assert.equal(resumed.status, 'unchanged', JSON.stringify(resumed));
    assert.equal(resumed.loaded, false);
    assert.deepEqual(resumed.appliedRoles, []);
    assert.equal((await engine.roleReadiness(existing)).loaded, false);
    const ownerOnly = await engine.newSession(dirs.work!);
    await engine.prompt(ownerOnly, 'Synthetic owner-only prior history');
    while (await engine.busyCount()) { assert.ok(Date.now() < deadline); await setTimeout(20); }
    await engine.unload(ownerOnly);
    const ownerAdded = await engine.addRoles(ownerOnly, [selected[0]!]);
    assert.equal(ownerAdded.sessionId, ownerOnly);
    assert.equal(ownerAdded.status, 'saved', JSON.stringify(ownerAdded));
    assert.deepEqual(ownerAdded.roles, [selected[0]]);
    assert.equal(ownerAdded.loaded, false);
    assert.equal(ownerAdded.rolesNeedReload, false);
    await engine.prompt(ownerOnly, 'Synthetic owner-only capability probe');
    while (await engine.busyCount()) { assert.ok(Date.now() < deadline); await setTimeout(20); }
    assert.match(JSON.stringify(captured.at(-1)), /Synthetic owner-only prior history/);
    assert.doesNotMatch(JSON.stringify((captured.at(-1) as { tools: unknown }).tools), /report|not-selected/);
    await engine.stop();
  } finally {
    if (engine) await engine.stop();
    else await runtime?.stop();
    mcp.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([mcp, provider].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
