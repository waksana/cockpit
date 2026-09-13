import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { CopilotClient, CopilotSession, SessionConfig, SessionEvent } from '@github/copilot-sdk';

interface Completion {
  model: string;
  messages: { role: string; content?: unknown; tool_calls?: { function: { name: string } }[] }[];
  tools?: { function: { name: string; parameters: unknown } }[];
}

test('native module roles: append, skills and MCP survive terminal reset and pinned cold resume', {
  skip: process.env.COCKPIT_NATIVE_MODULE_SMOKE !== '1', timeout: 120_000,
}, async () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'cockpit-module-native-'));
  const dirs = Object.fromEntries(['home', 'state', 'work', 'config', 'cache', 'scratch', 'run', 'modules']
    .map(name => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { mode: 0o700 });
  const env = {
    HOME: dirs.home!, USERPROFILE: dirs.home!, COPILOT_HOME: dirs.state!,
    XDG_CONFIG_HOME: dirs.config!, XDG_STATE_HOME: dirs.state!, XDG_CACHE_HOME: dirs.cache!,
    XDG_RUNTIME_DIR: dirs.run!, TMPDIR: dirs.scratch!, TMP: dirs.scratch!, TEMP: dirs.scratch!,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'), GIT_CEILING_DIRECTORIES: root,
  };
  const projectInstructions = '# Synthetic project\nPreserve PROJECT_INSTRUCTIONS_319.\n';
  writeFileSync(join(dirs.work!, 'AGENTS.md'), projectInstructions);
  const handoff = join(dirs.work!, 'handoff.txt');
  writeFileSync(handoff, 'SYNTHETIC_MODULE_HANDOFF');
  for (const version of ['v1', 'v2']) {
    const release = join(dirs.modules!, version);
    const skill = join(release, 'skills', 'module-fixture');
    mkdirSync(join(skill, 'references'), { recursive: true });
    mkdirSync(join(release, 'instructions'));
    writeFileSync(join(release, 'instructions', 'AGENTS.md'), `MODULE_DIRECTORY_${version}\nMODULE_ROLE_${version}\n`);
    writeFileSync(join(skill, 'SKILL.md'),
      `---\nname: module-fixture\ndescription: Synthetic module role fixture.\n---\nMODULE_SKILL_${version}\nRead [reference](references/detail.md) from this version directory.\n`);
    writeFileSync(join(skill, 'references', 'detail.md'), `MODULE_REFERENCE_${version}\n`);
  }
  const auxiliary = join(dirs.modules!, 'auxiliary', 'assistant-fixture');
  mkdirSync(auxiliary, { recursive: true });
  writeFileSync(join(dirs.modules!, 'auxiliary', 'role.md'), 'ASSISTANT_ROLE\n');
  writeFileSync(join(auxiliary, 'SKILL.md'),
    '---\nname: assistant-fixture\ndescription: Second independently selected role.\n---\nASSISTANT_SKILL\n');
  const requests: Completion[] = [];
  const events: SessionEvent[] = [];
  const errors: Error[] = [];
  let client: CopilotClient | undefined;
  let session: CopilotSession | undefined;
  let version = 'v1';
  const provider = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.ok(!req.headers.authorization || req.headers.authorization.trim() === 'Bearer');
      let text = '';
      for await (const chunk of req) text += chunk;
      const request = JSON.parse(text) as Completion;
      requests.push(request);
      assert.ok(requests.length <= 40, 'Synthetic provider exceeded its finite tool sequence');
      const lastUser = request.messages.findLastIndex(message => message.role === 'user'
        && !JSON.stringify(message.content).includes('<skill-context'));
      const prompt = JSON.stringify(request.messages[lastUser]?.content);
      const after = request.messages.slice(lastUser + 1);
      const called = after.flatMap(message => message.tool_calls?.map(call => call.function.name) ?? []);
      const mcp = request.tools?.find(tool => tool.function.name.endsWith('module_version'))?.function.name;
      let call: { name: string; arguments: string } | undefined;
      if (prompt.includes('MODULE_REMOVED')) {
        assert.equal(mcp, undefined, 'Removed module MCP must not remain callable');
      } else if (prompt.includes('MODULE_RESET_START')) {
        if (!called.includes('view')) {
          call = { name: 'view', arguments: JSON.stringify({ path: handoff }) };
        } else {
          assert.ok(!called.includes('self_clear_context'), 'Never retry a terminal reset');
          call = { name: 'self_clear_context', arguments: JSON.stringify({
            prompt: 'MODULE_RESET_SEED: inspect the selected module, not the old business prompt.',
            handoffFiles: [handoff],
          }) };
        }
      } else if (!called.includes('skill')) {
        call = { name: 'skill', arguments: JSON.stringify({ skill: 'module-fixture' }) };
      } else if (!called.includes('view')) {
        assert.ok(JSON.stringify(after).includes(`MODULE_SKILL_${version}`), 'Native skill tool must read selected body');
        call = { name: 'view', arguments: JSON.stringify({
          path: join(dirs.modules!, version, 'skills/module-fixture/references/detail.md'),
        }) };
      } else if (mcp && !called.includes(mcp)) {
        assert.ok(JSON.stringify(after).includes(`MODULE_REFERENCE_${version}`), 'Native file tool must read matching reference');
        call = { name: mcp, arguments: '{}' };
      } else {
        assert.ok(mcp, 'Session-scoped MCP tool must be usable by the native runtime');
        assert.ok(JSON.stringify(after).includes(`MCP_${version}`), 'Actual MCP process response must match selected version');
      }
      if (call) assert.ok(request.tools?.some(tool => tool.function.name === call.name), `Missing native tool: ${call.name}`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: `module-${requests.length}`, object: 'chat.completion.chunk',
          created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.write(chunk({ role: 'assistant', ...(call ? {
        tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: call }],
      } : { content: `MODULE_DONE_${version}` }) }));
      res.write(chunk({}, call ? 'tool_calls' : 'stop'));
      res.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      res.writeHead(400).end('{"error":{"message":"isolated module fixture rejected request"}}');
    }
  });
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    process.chdir(dirs.work!);
    const { CopilotClient, RuntimeConnection, approveAll } = await import('@github/copilot-sdk');
    const { OfficialRuntime } = await import('./runtime.ts');
    const { createContextReset } = await import('./context-reset.ts');
    const { NativeRoleEnvironment } = await import('./modules/role-environment.ts');
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    const startRuntime = () => new OfficialRuntime({
      clientOptions: { connection: RuntimeConnection.forStdio({ env }), mode: 'empty',
        baseDirectory: dirs.state, workingDirectory: dirs.work, builtinPluginDirectories: [],
        useLoggedInUser: false, enableRemoteSessions: false, onListModels: () => [], logLevel: 'error' },
      clientFactory: options => { client = new CopilotClient(options); return client; },
    });
    let runtime = startRuntime();
    await runtime.start();
    const roles = () => [{
      selection: { moduleId: 'assistant' as const, roleId: 'assistant', version: '1.0.0' },
      release: join(dirs.modules!, 'auxiliary'), instructions: join(dirs.modules!, 'auxiliary', 'role.md'),
      skillDirectories: [join(dirs.modules!, 'auxiliary')], mcpServers: {},
    }, {
      selection: { moduleId: 'task' as const, roleId: 'commander', version: version === 'v1' ? '1.0.0' : '2.0.0' },
      release: join(dirs.modules!, version), instructions: join(dirs.modules!, version, 'instructions/AGENTS.md'),
      skillDirectories: [join(dirs.modules!, version, 'skills')],
      mcpServers: { 'module-fixture': { type: 'local' as const, command: process.execPath,
        args: [fileURLToPath(new URL('./module-role-mcp.fixture.mjs', import.meta.url)), version], tools: ['*'] } },
    }];
    const configuration = async (): Promise<SessionConfig> => {
      const reset = createContextReset({ session: () => session ?? null, assertReady: () => {} });
      return {
        model: 'gpt-4.1', provider: { type: 'openai', wireApi: 'completions',
          baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
        workingDirectory: dirs.work, configDirectory: dirs.state,
        enableConfigDiscovery: true, skipCustomInstructions: false, enableFileHooks: false,
        enableHostGitOperations: false, enableSessionStore: false, enableSkills: true,
        pluginDirectories: [], customAgents: [], enableManagedSettings: false,
        skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory', enableSessionTelemetry: false,
        remoteSession: 'off', streaming: true,
        availableTools: ['builtin:view', 'builtin:skill', 'custom:self_clear_context', 'mcp:*'],
        instructionDirectories: [join(dirs.modules!, version, 'instructions')],
        ...await new NativeRoleEnvironment(runtime).configuration(roles(), dirs.work!),
        tools: [reset.tool],
        onEvent: event => { events.push(event); reset.observe(event); },
      };
    };
    const idle = async () => {
      for (let i = 0; i < 400; i++) {
        assert.deepEqual(errors, []);
        const [activity, processing] = await Promise.all([
          session!.rpc.metadata.activity(), session!.rpc.metadata.isProcessing(),
        ]);
        if (!activity.hasActiveWork && !processing.processing) return;
        await sleep(25);
      }
      assert.fail('Native module fixture did not become idle');
    };
    const inspect = async () => {
      await new NativeRoleEnvironment(runtime).assertConnected(session!, roles());
      const skills = await session!.rpc.skills.list();
      assert.ok(skills.skills.some(skill => skill.name === 'module-fixture' && skill.enabled));
      assert.ok(skills.skills.some(skill => skill.name === 'assistant-fixture' && skill.enabled));
      for (let i = 0; i < 100; i++) {
        const mcp = await session!.rpc.mcp.list();
        if (mcp.servers.some(server => server.name === 'module-fixture' && server.status === 'connected')) return;
        await sleep(30);
      }
      assert.fail('Native session-scoped MCP did not connect');
    };
    const empty = await runtime.createSession(await configuration());
    await runtime.rpc.sessions.save({ sessionId: empty.sessionId });
    const emptyPersisted = Boolean(await runtime.getSessionMetadata(empty.sessionId));
    await runtime.closeSession(empty);
    let emptyResume: string;
    try {
      const resumedEmpty = await runtime.resumeSession(empty.sessionId, await configuration());
      emptyResume = resumedEmpty.sessionId === empty.sessionId ? 'same-id' : 'different-id';
      await runtime.closeSession(resumedEmpty);
    } catch (error) {
      emptyResume = error instanceof Error ? error.message : String(error);
    }
    console.log(JSON.stringify({ nativeEmptyModuleSession: { emptyPersisted, emptyResume } }));
    const firstConfiguration = await configuration();
    const deferred = await runtime.createSession({ ...firstConfiguration,
      systemMessage: { mode: 'append', content: '' }, skillDirectories: [], mcpServers: {} });
    assert.equal(requests.length, 0, 'Declaring role instructions and skills must not send an initialization prompt');
    assert.ok(!(await deferred.rpc.mcp.list()).servers.some(server => server.name === 'module-fixture'));
    const activated = await client!.resumeSession(deferred.sessionId, { ...firstConfiguration, onPermissionRequest: approveAll });
    await new NativeRoleEnvironment(runtime).assertConnected(activated, roles());
    await activated.sendAndWait({ prompt: 'MODULE_FIRST: activate all declared modules only for this real message.' }, 20_000);
    await runtime.closeSession(deferred);
    session = await runtime.createSession(await configuration());
    const id = session.sessionId;
    await inspect();
    await session.sendAndWait({ prompt: 'MODULE_FIRST: inspect the selected role.' }, 20_000);
    await idle();
    const first = JSON.stringify(requests[0]!.messages);
    assert.ok(first.includes('MODULE_ROLE_v1'), 'Append role must reach model request');
    assert.ok(first.includes('ASSISTANT_ROLE'), 'Multiple selected role fragments must compose');
    assert.ok(first.includes('PROJECT_INSTRUCTIONS_319'), 'User project instructions must survive append mode');
    assert.ok(first.includes('modules/v1/instructions/AGENTS.md'), 'Explicit instruction directory must be discoverable');
    await session.send({ prompt: 'MODULE_RESET_START OLD_BUSINESS_MARKER: synthetic only.' });
    for (let i = 0; i < 400 && !events.some(event =>
      event.type === 'assistant.message' && event.data.content === 'MODULE_DONE_v1'
      && events.some(prior => prior.type === 'session.context_cleared' && prior.timestamp < event.timestamp)); i++) {
      assert.deepEqual(errors, []);
      await sleep(25);
    }
    await idle();
    assert.equal(events.filter(event => event.type === 'session.context_cleared').length, 1);
    const seed = requests.find(request => JSON.stringify(request.messages).includes('MODULE_RESET_SEED'));
    assert.ok(seed);
    assert.ok(JSON.stringify(seed.messages).includes('MODULE_ROLE_v1'), 'Native terminal reset must retain append role');
    assert.ok(!JSON.stringify(seed.messages).includes('OLD_BUSINESS_MARKER'), 'Reset must not replay old user prompt');
    await runtime.closeSession(session);
    await runtime.stop();
    runtime = startRuntime();
    await runtime.start();
    session = await runtime.resumeSession(id, await configuration());
    await inspect();
    await session.sendAndWait({ prompt: 'MODULE_COLD: reuse bound v1, not installed latest.' }, 20_000);
    await idle();
    assert.ok(JSON.stringify(requests.at(-1)!.messages).includes('MODULE_ROLE_v1'));
    await runtime.closeSession(session);
    version = 'v2';
    session = await runtime.resumeSession(id, await configuration());
    await inspect();
    await session.sendAndWait({ prompt: 'MODULE_APPLY: explicitly apply v2; reuse existing files and tasks.' }, 20_000);
    await idle();
    const appliedSystem = JSON.stringify(requests.at(-1)!.messages.filter(message => message.role === 'system'));
    assert.ok(appliedSystem.includes('MODULE_ROLE_v2'), 'Cold resume must apply new append role');
    assert.ok(!appliedSystem.includes('MODULE_ROLE_v1'), 'Old system role must not accumulate');
    assert.ok(appliedSystem.includes('PROJECT_INSTRUCTIONS_319'));
    // A resident resume is not a reliable application boundary; observe it separately.
    const resident = await client!.resumeSession(id, { ...await configuration(), onPermissionRequest: approveAll,
      systemMessage: { mode: 'append', content: 'RESIDENT_REPLACEMENT_MARKER' } });
    await resident.sendAndWait({ prompt: 'MODULE_RESIDENT: inspect without assuming config replacement.' }, 20_000);
    await idle();
    const residentReplaced = JSON.stringify(requests.at(-1)!.messages.filter(message => message.role === 'system'))
      .includes('RESIDENT_REPLACEMENT_MARKER');
    const duplicateSkills = await runtime.rpc.skills.discover({
      projectPaths: [dirs.work!],
      skillDirectories: [join(dirs.modules!, 'v1', 'skills'), join(dirs.modules!, 'v2', 'skills')],
    });
    assert.ok(duplicateSkills.skills.some(skill => skill.name === 'module-fixture'));
    const duplicatePaths = duplicateSkills.skills.filter(skill => skill.name === 'module-fixture').map(skill => skill.path);
    await assert.rejects(new NativeRoleEnvironment(runtime).configuration([...roles(), roles()[1]!], dirs.work!), /skills conflict/);
    await runtime.closeSession(session);
    session = await runtime.resumeSession(id, { ...await configuration(),
      ...await new NativeRoleEnvironment(runtime).configuration([], dirs.work!), instructionDirectories: [] });
    assert.ok(!(await session.rpc.skills.list()).skills.some(skill => skill.name === 'module-fixture'));
    assert.ok(!(await session.rpc.mcp.list()).servers.some(server => server.name === 'module-fixture'));
    await session.sendAndWait({ prompt: 'MODULE_REMOVED: normal project instructions only.' }, 20_000);
    await idle();
    const removedSystem = JSON.stringify(requests.at(-1)!.messages.filter(message => message.role === 'system'));
    assert.ok(!removedSystem.includes('RESIDENT_REPLACEMENT_MARKER') && !removedSystem.includes('MODULE_ROLE_'));
    assert.ok(removedSystem.includes('PROJECT_INSTRUCTIONS_319'));
    assert.deepEqual(errors, []);
    assert.equal(readFileSync(join(dirs.work!, 'AGENTS.md'), 'utf8'), projectInstructions);
    assert.deepEqual(readdirSync(dirs.work!).sort(), ['AGENTS.md', 'handoff.txt']);
    assert.ok(!readdirSync(dirs.home!).includes('.copilot'), 'No fallback to user-level Copilot installation');
    console.log(JSON.stringify({ nativeModuleGate: {
      runtime: await client!.getStatus(), appendAndProjectInstructions: true,
      terminalResetRoleRetained: true, coldPinnedVersion: true, explicitNewVersion: true,
      realSkillBodyAndReference: true, realStdioMcp: true, userWorkspaceUnchanged: true,
      residentReplaced, duplicateSkillDiscoveryCount: duplicatePaths.length, productRoleComposer: true,
      removedRoleCleared: true, deferredMcpWithoutInitializationPrompt: true,
    } }));
    await runtime.closeSession(session);
    session = undefined;
    await runtime.stop();
  } catch (error) {
    console.error(JSON.stringify({ errors: errors.map(error => error.message),
      requests: requests.slice(-3).map(request => ({ tools: request.tools?.map(tool => tool.function.name),
        messages: request.messages.slice(-3).map(message => ({
          role: message.role, calls: message.tool_calls, content: JSON.stringify(message.content).slice(-1200),
        })) })),
      events: events.slice(-5).map(event => ({ type: event.type,
        ...(event.type === 'session.error' ? { data: event.data } : {}) })) }));
    throw error;
  } finally {
    // This client owns only synthetic sessions in the test's private native home.
    if (client) await client.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
