import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { errorWithCode } from '../test-support/errors.ts';

test('native state: isolated public reads, no cached metadata and explicit unloaded values', {
  skip: process.env.COCKPIT_NATIVE_STATE_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(process.cwd(), '.cockpit-state-native-'));
  const dirs = Object.fromEntries(['home', 'state', 'work', 'tmp', 'config', 'cache', 'run'].map(name => {
    const dir = join(root, name);
    mkdirSync(dir);
    return [name, dir];
  }));
  const env = {
    HOME: dirs.home!, USERPROFILE: dirs.home!, COCKPIT_HOME: dirs.state!,
    XDG_CONFIG_HOME: dirs.config!, XDG_CACHE_HOME: dirs.cache!, XDG_STATE_HOME: dirs.state!,
    XDG_RUNTIME_DIR: dirs.run!, TMPDIR: dirs.tmp!, TMP: dirs.tmp!, TEMP: dirs.tmp!,
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', COPILOT_DISABLE_KEYTAR: '1',
    COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'),
  };
  let engine: import('./engine.ts').Engine | undefined;
  let stopped = false;
  const provider = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text) as { model: string; stream?: boolean;
      messages: { role: string; content?: unknown; tool_calls?: unknown[] }[];
      tools?: { function: { name: string } }[] };
    assert.ok(req.headers.authorization === undefined || req.headers.authorization.trim() === 'Bearer');
    const answer = 'Synthetic native state reply';
    const completion = { id: 'fixture', created: 1, model: request.model };
    const lastUser = request.messages.findLastIndex(message => message.role === 'user');
    const background = JSON.stringify(request.messages[lastUser]?.content).includes('SYNTHETIC_ACTIVITY_SHELL')
      && !request.messages.slice(lastUser + 1).some(message => message.role === 'tool' || message.tool_calls?.length);
    const bash = request.tools?.find(tool => tool.function.name === 'bash' || tool.function.name.endsWith('__bash'));
    if (background) assert.ok(bash, 'Native bash tool is advertised by the isolated runtime');
    const toolCall = background ? {
      id: 'synthetic-shell-call', type: 'function',
      function: { name: bash!.function.name, arguments: JSON.stringify({
        command: '/usr/bin/sleep 3', mode: 'async', description: 'Synthetic activity shell',
      }) },
    } : undefined;
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [{ delta: { role: 'assistant', ...(toolCall
        ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: answer }) }, finish_reason: null },
      { delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }]) {
        res.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...completion, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: toolCall ? null : answer,
          ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
  });
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    process.chdir(dirs.work!);
    const { RuntimeConnection } = await import('@github/copilot-sdk');
    const { OfficialRuntime } = await import('./runtime.ts');
    const { Engine } = await import('./engine.ts');
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    const runtime = new OfficialRuntime({
      clientOptions: {
        connection: RuntimeConnection.forStdio({ env }), mode: 'empty', baseDirectory: dirs.state,
        workingDirectory: dirs.work, builtinPluginDirectories: [], useLoggedInUser: false,
        enableRemoteSessions: false, logLevel: 'error', onListModels: () => [],
      },
      sessionConfig: {
        model: 'gpt-4.1',
        provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
        configDirectory: dirs.state, skipCustomInstructions: true, enableFileHooks: false,
        enableHostGitOperations: false, enableSessionStore: false, enableSkills: false,
        skillDirectories: [], pluginDirectories: [], instructionDirectories: [], customAgents: [],
        enableManagedSettings: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
        enableSessionTelemetry: false, remoteSession: 'off', enableExperimentalMode: true, availableTools: ['bash'],
      },
    });
    engine = new Engine({ runtime });
    await engine.start();
    assert.deepEqual((await engine.snapshot()).sessions, []);
    const id = await engine.newSession(dirs.work!);
    const retained = () => (engine as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions;
    assert.equal(retained().size, 1);
    await engine.rename(id, 'Native request title A');
    assert.equal((await engine.getMeta(id))?.title, 'Native request title A');
    await engine.rename(id, 'Native request title B');
    assert.equal((await engine.getMeta(id))?.title, 'Native request title B');
    await engine.prompt(id, 'Synthetic native state fixture');
    const deadline = Date.now() + 15_000;
    while (await engine.busyCount()) {
      assert.ok(Date.now() < deadline, 'Native reply must settle');
      await sleep(20);
    }
    const sdk = retained().get(id)!.sdk as import('@github/copilot-sdk').CopilotSession;
    await engine.prompt(id, 'SYNTHETIC_ACTIVITY_SHELL');
    const activityDeadline = Date.now() + 15_000;
    let shellSummary: import('@cockpit/protocol').SessionActivity | null | undefined;
    while (!shellSummary || shellSummary.processing || shellSummary.tasks.activeShells !== 1) {
      assert.ok(Date.now() < activityDeadline, 'A running shell must be visible after the main turn ends');
      shellSummary = (await engine.getResources(id, ['control']))!.activity;
      await sleep(20);
    }
    const nativeTasks = (await sdk.rpc.tasks.list()).tasks;
    const shell = nativeTasks.find(task => task.type === 'shell');
    assert.ok(shell);
    assert.equal(shell.status, 'running');
    assert.equal(shellSummary.tasks.activeAgents, 0);
    assert.equal(shellSummary.tasks.unknown, 0);
    assert.equal(shellSummary.processing, false);
    assert.doesNotMatch(JSON.stringify(shellSummary), /Synthetic activity shell|sleep 3/);
    assert.equal((await engine.listLive())[0]!.activity!.tasks.activeShells, 1);
    await assert.rejects(engine.unload(id), /protected|progress|settling/i);
    while (await engine.busyCount()) {
      assert.ok(Date.now() < activityDeadline, 'Synthetic background shell must finish');
      await sleep(20);
    }
    const finishedTasks = (await sdk.rpc.tasks.list()).tasks;
    assert.equal(finishedTasks.find(task => task.id === shell.id)?.status, 'completed');
    assert.ok(finishedTasks.every(task => ['idle', 'completed', 'failed', 'cancelled'].includes(task.status)));
    assert.deepEqual((await engine.getResources(id, ['control']))!.activity!.tasks,
      { activeAgents: 0, activeShells: 0, unknown: 0 });
    await engine.setMode(id, 'plan');
    assert.equal((await engine.getMeta(id))?.currentMode, 'plan');
    const scheduled = await engine.addSchedule(id, { interval: '1h', prompt: 'synthetic fixture', recurring: false });
    assert.ok(scheduled.entry);
    assert.equal((await engine.getMeta(id))?.scheduleCount, 1);
    for (const forbidden of ['meta', 'tasks', 'nativeMcpPending', 'resourceReads', 'resourceSync', 'dirtyResources']) {
      assert.equal(forbidden in retained().get(id)!, false);
    }
    await engine.unload(id);
    assert.equal(retained().size, 0);
    const unloaded = await engine.getMeta(id);
    assert.equal(unloaded?.loaded, false);
    assert.equal(unloaded?.activity, null);
    assert.equal(unloaded?.title, 'Native request title B');
    assert.equal('pinned' in unloaded!, false);
    for (const key of ['currentModelId', 'currentMode', 'availableModels', 'queue', 'scheduleCount', 'todo']) {
      assert.equal(key in unloaded!, false, key);
    }
    assert.equal(runtime.liveCount, 0);
    await assert.rejects(engine.listSchedules(id), errorWithCode('SESSION_UNLOADED'));
    assert.equal(runtime.liveCount, 0);
    assert.equal(retained().size, 0);
    await engine.stop();
    stopped = true;
  } finally {
    if (engine && !stopped) await engine.stop();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
