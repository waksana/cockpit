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
  let holdReplies = false;
  const heldReplies = new Set<() => void>();
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
      const finish = () => {
        heldReplies.delete(finish);
        emit({ delta: {}, finish_reason: 'stop' }); response.end('data: [DONE]\n\n');
      };
      if (holdReplies) {
        heldReplies.add(finish); response.once('close', () => heldReplies.delete(finish));
      } else finish();
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
      assemble: async id => ({ roles: selected, skills, fingerprint: 'synthetic',
        config: { skillDirectories: selected.map(role => join(dirs.skills!, role.roleId)),
          systemMessage: { mode: 'append', content: `Synthetic role source fixture/owner+executor. Native session ID: ${id}.` },
          mcpServers: { module_fixture__tools: { type: 'http', url: `${mcpUrl}/mcp`,
            headers: { 'X-Cockpit-Module-Digest': 'synthetic-digest' }, tools: ['read', 'create', 'report'] } } },
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
    holdReplies = true;
    const before = captured.length;
    await engine.prompt(id, 'Synthetic queue primary');
    const queueDeadline = Date.now() + 20_000;
    while (captured.length === before) { assert.ok(Date.now() < queueDeadline); await setTimeout(10); }
    await engine.prompt(id, 'Synthetic queued A');
    await engine.prompt(id, 'Synthetic queued B');
    const started = await engine.advanceQueue({ action: 'start', sessionId: id });
    assert.ok(started.operation);
    let operation = started.operation;
    while (operation.state === 'running') {
      assert.ok(Date.now() < queueDeadline, JSON.stringify(operation));
      await setTimeout(10);
      operation = (await engine.advanceQueue({ action: 'get', sessionId: id })).operation!;
    }
    assert.equal(operation.state, 'completed', JSON.stringify(operation));
    assert.ok(operation.interrupts >= 1);
    assert.equal((await engine.getMeta(id))!.queue!.length, 0);
    assert.equal(await engine.busyCount(), 1, 'the admitted tail continues rather than requiring idle');
    holdReplies = false;
    for (const finish of heldReplies) finish();
    while (await engine.busyCount()) {
      for (const finish of heldReplies) finish();
      assert.ok(Date.now() < queueDeadline); await setTimeout(10);
    }
    await engine.stop();
  } finally {
    await runtime?.stop().catch(() => {});
    mcp.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([mcp, provider].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
