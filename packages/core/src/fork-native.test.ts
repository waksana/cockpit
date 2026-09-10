import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SessionConfig } from '@github/copilot-sdk';

test('native fork: isolated history boundaries and independent continuation', {
  skip: process.env.COCKPIT_NATIVE_FORK !== '1', timeout: 90_000,
}, async t => {
  const root = resolve(`.cockpit-native-fork-${randomUUID()}`);
  mkdirSync(root);
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home);
  mkdirSync(work);
  const skillDirectory = join(root, 'skills');
  mkdirSync(join(skillDirectory, 'fixture-skill'), { recursive: true });
  writeFileSync(join(skillDirectory, 'fixture-skill', 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: Synthetic fixture only\n---\nNever execute anything.\n');
  const mcpFile = join(root, 'fixture-mcp.cjs');
  writeFileSync(mcpFile, `
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : request.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`);
  const env = {
    HOME: home, COPILOT_HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    XDG_STATE_HOME: home, TMPDIR: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CEILING_DIRECTORIES: root,
  };
  const requests: string[] = [];
  const errors: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.ok(!req.headers.authorization || req.headers.authorization.trim() === 'Bearer');
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      const marker = JSON.stringify(body.messages.findLast((m: { role: string }) => m.role === 'user').content);
      assert.match(marker, /FORK_FIXTURE_/);
      requests.push(marker);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
      res.end(chunk({ role: 'assistant', content: `Fixture reply ${marker}` })
        + chunk({}, 'stop') + 'data: [DONE]\n\n');
    } catch (error) {
      errors.push(String(error));
      res.writeHead(500).end('fixture failed');
    }
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(work);
  const { CopilotClient, RuntimeConnection, approveAll } = await import('@github/copilot-sdk');
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ env }), mode: 'empty', baseDirectory: home,
    workingDirectory: work, builtinPluginDirectories: [], useLoggedInUser: false,
    enableRemoteSessions: false, onListModels: () => [], logLevel: 'error',
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config: SessionConfig = {
      model: 'gpt-4.1',
      provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
      workingDirectory: work, configDirectory: home, streaming: true,
      skipCustomInstructions: true, enableConfigDiscovery: false, enableFileHooks: false,
      enableHostGitOperations: false, enableSessionStore: false, enableSkills: true,
      enableManagedSettings: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
      enableSessionTelemetry: false, remoteSession: 'off', manageScheduleEnabled: true,
      availableTools: ['sql', 'bash'], skillDirectories: [skillDirectory], pluginDirectories: [], instructionDirectories: [],
      mcpServers: { fixture: { command: process.execPath, args: [mcpFile], tools: ['*'] } },
      onPermissionRequest: approveAll,
    };
    await client.start();
    assert.equal((await client.getStatus()).version, '1.0.83');
    const parent = await client.createSession(config);
    await parent.sendAndWait({ prompt: 'FORK_FIXTURE_FIRST' }, 15_000);
    await parent.sendAndWait({ prompt: 'FORK_FIXTURE_SECOND' }, 15_000);
    await parent.rpc.mode.set({ mode: 'plan' });
    await parent.rpc.skills.disable({ name: 'fixture-skill' });
    await parent.rpc.mcp.disable({ serverName: 'fixture' });
    await parent.rpc.plan.update({ content: 'FORK_FIXTURE_OLD_PLAN: historical, do not execute' });
    await parent.rpc.tools.execute({ name: 'sql', arguments: {
      description: 'Synthetic fork todo', query: "INSERT INTO todos (id, title, status) VALUES ('fixture', 'FORK_FIXTURE_OLD_TODO', 'pending')",
    } });
    assert.equal((await parent.rpc.plan.readSqlTodos()).rows.length, 1);
    await parent.rpc.queue.setDrainPaused({ paused: true });
    await parent.rpc.queue.insertAt({ position: 0, message: { prompt: 'FORK_FIXTURE_OLD_QUEUE' } });
    await parent.rpc.commands.invoke({ name: 'every', input: '1h FORK_FIXTURE_SCHEDULE' });
    const original = await parent.getEvents();
    const boundary = original.find(event => event.type === 'user.message'
      && event.data.content === 'FORK_FIXTURE_SECOND')!;
    assert.ok(boundary);
    const beforeFork = await parent.getEvents();
    const full = await client.rpc.sessions.fork({ sessionId: parent.sessionId, name: 'Fixture full' });
    const partial = await client.rpc.sessions.fork({ sessionId: parent.sessionId, toEventId: boundary.id, name: 'Fixture boundary' });
    t.diagnostic(JSON.stringify({ full, partial, parentId: parent.sessionId }));
    assert.notEqual(full.sessionId, parent.sessionId);
    assert.notEqual(partial.sessionId, full.sessionId);
    const parentAfterFork = await parent.getEvents();
    assert.deepEqual(parentAfterFork.slice(0, beforeFork.length), beforeFork);
    assert.ok(parentAfterFork.slice(beforeFork.length).every(event =>
      event.type === 'session.info' && event.data.infoType === 'fork'));
    const resumeConfig = { ...config, model: undefined, workingDirectory: undefined };
    const child = await client.resumeSession(full.sessionId, resumeConfig);
    const branch = await client.resumeSession(partial.sessionId, resumeConfig);
    const userPrompts = async (session: typeof parent) => (await session.getEvents())
      .filter(event => event.type === 'user.message').map(event => event.data.content);
    assert.deepEqual(await userPrompts(child), ['FORK_FIXTURE_FIRST', 'FORK_FIXTURE_SECOND']);
    assert.deepEqual(await userPrompts(branch), ['FORK_FIXTURE_FIRST']);
    t.diagnostic(JSON.stringify({
      model: await child.rpc.model.getCurrent(), mode: await child.rpc.mode.get(),
      metadata: await client.getSessionMetadata(child.sessionId),
      skills: await child.rpc.skills.list(), mcp: await child.rpc.mcp.list(),
      tasks: await child.rpc.tasks.list(), queue: await child.rpc.queue.pendingItems(),
      schedules: await child.rpc.schedule.list(), parentSchedules: await parent.rpc.schedule.list(),
      plan: await child.rpc.plan.read(), todos: await child.rpc.plan.readSqlTodos(),
      parentSkills: await parent.rpc.skills.list(),
      parentMcp: await parent.rpc.mcp.list(),
    }));
    assert.equal((await child.rpc.model.getCurrent()).modelId, 'gpt-4.1');
    assert.equal(await child.rpc.mode.get(), 'plan');
    assert.equal(await branch.rpc.mode.get(), 'interactive');
    assert.equal((await client.getSessionMetadata(child.sessionId))!.context!.workingDirectory, work);
    assert.equal((await child.rpc.schedule.list()).entries.length, 1);
    assert.equal((await branch.rpc.schedule.list()).entries.length, 0);
    assert.equal((await child.rpc.queue.pendingItems()).items.length, 0);
    assert.equal((await parent.rpc.queue.pendingItems()).items.length, 1);
    assert.equal((await child.rpc.skills.list()).skills.find(skill => skill.name === 'fixture-skill')!.enabled, true);
    assert.equal((await parent.rpc.skills.list()).skills.find(skill => skill.name === 'fixture-skill')!.enabled, false);
    assert.equal((await parent.rpc.mcp.list()).host!.disabledServers.includes('fixture'), true);
    assert.equal((await child.rpc.mcp.list()).host!.disabledServers.includes('fixture'), false);
    assert.equal((await child.rpc.plan.read()).content, 'FORK_FIXTURE_OLD_PLAN: historical, do not execute');
    assert.deepEqual((await child.rpc.tasks.list()).tasks, []);
    assert.deepEqual((await child.rpc.plan.readSqlTodos()).rows, []);
    assert.equal((await branch.rpc.plan.read()).content, 'FORK_FIXTURE_OLD_PLAN: historical, do not execute');
    await parent.rpc.queue.clear();
    await parent.rpc.queue.setDrainPaused({ paused: false });
    await sleep(50);
    assert.equal(requests.length, 2, 'Fork/resume must not execute inherited prompts or queue');
    await child.sendAndWait({ prompt: 'FORK_FIXTURE_CHILD' }, 15_000);
    await parent.sendAndWait({ prompt: 'FORK_FIXTURE_PARENT' }, 15_000);
    assert.deepEqual(await userPrompts(parent), ['FORK_FIXTURE_FIRST', 'FORK_FIXTURE_SECOND', 'FORK_FIXTURE_PARENT']);
    assert.deepEqual(await userPrompts(child), ['FORK_FIXTURE_FIRST', 'FORK_FIXTURE_SECOND', 'FORK_FIXTURE_CHILD']);
    assert.deepEqual(await userPrompts(branch), ['FORK_FIXTURE_FIRST']);
    assert.equal(requests.length, 4);
    assert.deepEqual(errors, []);
    await parent.rpc.tools.execute({ name: 'bash', arguments: {
      command: '/usr/bin/sleep 30', mode: 'async', description: 'Synthetic local fork task',
    } });
    const parentTasks = await parent.rpc.tasks.list();
    assert.ok(parentTasks.tasks.length > 0);
    try {
      const taskFork = await client.rpc.sessions.fork({ sessionId: parent.sessionId, name: 'Fixture active task' });
      const taskChild = await client.resumeSession(taskFork.sessionId, resumeConfig);
      assert.deepEqual((await taskChild.rpc.tasks.list()).tasks, []);
      assert.deepEqual(await parent.rpc.tasks.list(), parentTasks);
      assert.equal(requests.length, 4);
    } finally {
      for (const task of parentTasks.tasks) await parent.rpc.tasks.cancel({ id: task.id });
    }
    await client.stop();

    const { OfficialRuntime } = await import('./runtime.ts');
    const { Engine, sessionMetaBusy } = await import('./engine.ts');
    let engineClient: InstanceType<typeof CopilotClient> | undefined;
    const runtime = new OfficialRuntime({
      clientFactory: options => { engineClient = new CopilotClient(options); return engineClient; },
      clientOptions: {
        connection: RuntimeConnection.forStdio({ env }), mode: 'empty', baseDirectory: home,
        workingDirectory: work, builtinPluginDirectories: [], useLoggedInUser: false,
        enableRemoteSessions: false, onListModels: () => [], logLevel: 'error',
      },
      sessionConfig: { ...config, enableConfigDiscovery: false },
    });
    const engine = new Engine({ runtime, prefsFile: join(root, 'prefs.json') });
    const idle = async (id: string) => {
      let stable = 0;
      const deadline = Date.now() + 10_000;
      while (stable < 2 && Date.now() < deadline) {
        const meta = (await engine.getMeta(id))!;
        stable = meta.status === 'idle' && !sessionMetaBusy(meta) && !meta.autoNaming ? stable + 1 : 0;
        await sleep(20);
      }
      assert.equal(stable, 2, 'Fixture must wait for native work and automatic-name preflight, not only idle paint');
    };
    try {
      await engine.start();
      const sourceId = await engine.newSession(work);
      await engine.rename(sourceId, 'Engine fixture source');
      const send = async (id: string, prompt: string) => {
        await engine.prompt(id, prompt);
        await idle(id);
      };
      await send(sourceId, 'FORK_FIXTURE_ENGINE_FIRST');
      await send(sourceId, 'FORK_FIXTURE_ENGINE_SECOND');
      const history = await engine.history(sourceId);
      const second = history.messages.find(message => message.role === 'user' && message.content === 'FORK_FIXTURE_ENGINE_SECOND')!;
      assert.ok(second);
      const branchResult = await engine.forkSession(sourceId, second.id, 'Engine boundary');
      const fullResult = await engine.forkSession(sourceId);
      assert.equal((await engine.getMeta(fullResult.sessionId))!.loaded, false);
      assert.equal((await engine.getMeta(branchResult.sessionId))!.loaded, false);
      assert.equal((await engine.history(branchResult.sessionId)).messages.filter(message => message.role === 'user').length, 1);
      await engine.reload(fullResult.sessionId);
      await engine.rename(fullResult.sessionId, 'Engine fixture child');
      assert.deepEqual(await engine.listSchedules(fullResult.sessionId), []);
      await send(fullResult.sessionId, 'FORK_FIXTURE_ENGINE_CHILD');
      await send(sourceId, 'FORK_FIXTURE_ENGINE_PARENT');
      assert.ok(!(await engine.history(sourceId)).messages.some(message => message.content.includes('ENGINE_CHILD')));
      assert.ok(!(await engine.history(fullResult.sessionId)).messages.some(message => message.content.includes('ENGINE_PARENT')));
      const rows = await runtime.listSessions();
      assert.ok(rows.some(row => row.sessionId === fullResult.sessionId));
      await engine.addSchedule(sourceId, { interval: '1h', prompt: 'FORK_FIXTURE_ENGINE_TIMER' });
      await idle(sourceId);
      await assert.rejects(engine.forkSession(sourceId), /timers|schedule/);
      for (const entry of await engine.listSchedules(sourceId)) await engine.stopSchedule(sourceId, entry.id);
      await idle(sourceId);
      await assert.rejects(engine.forkSession(sourceId), /schedule/);
      await engine.unload(sourceId);
      await assert.rejects(engine.forkSession(sourceId), /unloaded/);
      assert.equal(requests.length, 8);
    } catch (error) {
      t.diagnostic(error instanceof Error ? error.stack! : String(error));
      throw error;
    } finally {
      try {
        for (const row of (await engine.listLive())) {
          if (row.loaded) { await engine.cancel(row.sessionId); await idle(row.sessionId); }
        }
        await engine.stop();
      } finally {
        // Test-only last resort: stop only the explicitly owned isolated client.
        await engineClient?.stop();
      }
    }
  } finally {
    await client.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
