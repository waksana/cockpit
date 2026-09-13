import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { Intents, type IntentBody, type IntentName } from '@cockpit/protocol';

test('connected MCP uses native fork and graceful shutdown waits for an actual native turn', {
  skip: process.env.COCKPIT_NATIVE_FORK !== '1', timeout: 60_000,
}, async () => {
  const root = resolve(`.cockpit-mcp-native-fork-${randomUUID()}`);
  mkdirSync(root);
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home);
  mkdirSync(work);
  const env = {
    HOME: home, COPILOT_HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    XDG_STATE_HOME: home, TMPDIR: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CEILING_DIRECTORIES: root, COCKPIT_NO_BOOT: '1', LOG_LEVEL: 'silent',
    COCKPIT_SERVE_WEB: '0',
  };
  const prompts: string[] = [];
  let releaseHeld: (() => void) | undefined;
  const providerErrors: string[] = [];
  const provider = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.ok(!req.headers.authorization || req.headers.authorization.trim() === 'Bearer');
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      const prompt = JSON.stringify(body.messages.findLast((message: { role: string }) => message.role === 'user').content);
      assert.match(prompt, /MCP_FORK_FIXTURE_/);
      prompts.push(prompt);
      const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({
        id: 'mcp-fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const finish = () => res.end(chunk({ role: 'assistant', content: `Synthetic reply ${prompt}` }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      if (prompt.includes('MCP_FORK_FIXTURE_HELD')) releaseHeld = finish;
      else finish();
    } catch (error) {
      providerErrors.push(String(error));
      res.writeHead(500).end('Synthetic provider rejected request');
    }
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(work);
  const { OfficialRuntime } = await import('../../../packages/core/src/runtime.ts');
  const { Engine, sessionMetaBusy } = await import('../../../packages/core/src/engine.ts');
  const { app, setTestDependencies } = await import('../../server/src/index.ts');
  const { GracefulShutdown } = await import('../../server/src/shutdown.ts');
  let published = false;
  // A single, already-connected MCP process must observe later publication.
  app.addHook('onRequest', async (request, reply) => {
    if (!published && (request.url === '/capabilities?name=session%2Ffork' || request.url === '/intent/session/fork')) {
      return reply.code(404).send({ error: 'session/fork not published yet' });
    }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const runtime = new OfficialRuntime({
    clientOptions: {
      mode: 'empty', baseDirectory: home, workingDirectory: work, useLoggedInUser: false,
      enableRemoteSessions: false, builtinPluginDirectories: [], onListModels: () => [], logLevel: 'error',
    },
    sessionConfig: {
      model: 'gpt-4.1',
      provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
      workingDirectory: work, configDirectory: home, streaming: true,
      skipCustomInstructions: true, enableFileHooks: false, enableHostGitOperations: false,
      enableSessionStore: false, enableSkills: false, enableManagedSettings: false,
      skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
      enableSessionTelemetry: false, remoteSession: 'off',
      availableTools: [], skillDirectories: [], pluginDirectories: [], instructionDirectories: [],
    },
  });
  const engine = new Engine({ runtime });
  let shutdownCompleted = false, completeShutdown!: () => void;
  const closed = new Promise<void>(resolve => { completeShutdown = resolve; });
  const shutdownErrors: unknown[] = [];
  const shutdown = new GracefulShutdown({
    busyCount: () => engine.busyCount(), stopNative: () => engine.stop(), closeTransport: () => app.close(),
    exit: code => { assert.equal(code, 0); shutdownCompleted = true; completeShutdown(); },
    report: error => { shutdownErrors.push(error); }, delayMs: 20,
  });
  const offActivity = engine.onActivitySettled(() => shutdown.notify());
  const offEvent = engine.onEvent(() => shutdown.notify());
  setTestDependencies({ engine, shutdown });
  const client = new Client({ name: 'already-connected-discussion-fixture', version: '1' });
  let transport: StdioClientTransport | undefined;
  const responseSchema = z.object({
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })).nonempty(),
    isError: z.boolean().optional(),
  });
  const invoke = async (name: string, args: Record<string, unknown>) =>
    responseSchema.parse(await client.callTool({ name, arguments: args }));
  const intent = async <K extends IntentName>(name: K, body: IntentBody<K>): Promise<unknown> => {
    const result = await invoke('cockpit_call_intent', { name, body });
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const history = async (sessionId: string) => {
    const page = Intents['session/chat'].result.parse(await intent('session/chat', {
      sessionId, source: 'persisted', direction: 'backward', max: 256,
    }));
    assert.equal(page.hasMore, false, 'This small isolated fixture fits one native page');
    assert.equal(page.read.rpc, 1);
    return page.events;
  };
  const idle = async (id: string) => {
    let stable = 0;
    const deadline = Date.now() + 10_000;
    while (stable < 2 && Date.now() < deadline) {
      const meta = (await engine.getMeta(id))!;
      stable = meta.status === 'idle' && !sessionMetaBusy(meta) ? stable + 1 : 0;
      await sleep(20);
    }
    assert.equal(stable, 2, 'All native work must settle before a fork or teardown');
  };
  try {
    await engine.start();
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)),
        fileURLToPath(new URL('../dist/index.js', import.meta.url))],
      env: { ...env, COCKPIT_URL: url }, stderr: 'pipe',
    });
    await client.connect(transport);
    const initialTools = await client.listTools();
    const initial = await invoke('cockpit_capabilities', { name: 'session/fork' });
    assert.equal(initial.isError, true);

    const source = Intents['session/new'].result.parse(await intent('session/new', { cwd: work }));
    await intent('session/rename', { sessionId: source.sessionId, name: 'MCP fixture source' });
    const send = async (id: string, text: string) => {
      const result = await invoke('cockpit_send_prompt', { session_id: id, text });
      assert.ok(!result.isError, result.content[0].text);
      await idle(id);
    };
    await send(source.sessionId, 'MCP_FORK_FIXTURE_FIRST');
    await send(source.sessionId, 'MCP_FORK_FIXTURE_SECOND');
    const before = await history(source.sessionId);
    const boundary = before.find(event => event.type === 'user.message' && event.data.content === 'MCP_FORK_FIXTURE_SECOND')!;
    assert.ok(boundary);

    published = true;
    const discovery = await invoke('cockpit_capabilities', { name: 'session/fork' });
    assert.ok(!discovery.isError, discovery.content[0].text);
    assert.equal(JSON.parse(discovery.content[0].text).name, 'session/fork');
    assert.deepEqual(await client.listTools(), initialTools, 'No new tool, reconnect, or session restore is needed');
    const child = Intents['session/fork'].result.parse(await intent('session/fork', {
      sessionId: source.sessionId, toEventId: boundary.id, name: 'MCP fixture child',
    }));
    assert.notEqual(child.sessionId, source.sessionId);
    const listing = Intents['session/list'].result.parse(await intent('session/list', {}));
    assert.ok(listing.sessions.some(session => session.sessionId === child.sessionId));
    assert.equal((await engine.getMeta(child.sessionId))!.loaded, false);
    const inherited = await history(child.sessionId);
    assert.deepEqual(inherited.filter(event => event.type === 'user.message').map(event => event.data.content), ['MCP_FORK_FIXTURE_FIRST']);
    assert.equal(prompts.length, 2, 'Discovery, fork, listing and history must not dispatch old work');
    await intent('session/rename', { sessionId: child.sessionId, name: 'MCP fixture child' });
    await send(child.sessionId, 'MCP_FORK_FIXTURE_CHILD');
    await send(source.sessionId, 'MCP_FORK_FIXTURE_PARENT');
    const childHistory = await history(child.sessionId);
    const parentHistory = await history(source.sessionId);
    assert.ok(childHistory.some(event => event.data.content === 'MCP_FORK_FIXTURE_CHILD'));
    assert.ok(!childHistory.some(event => typeof event.data.content === 'string' && event.data.content.includes('MCP_FORK_FIXTURE_PARENT')));
    assert.ok(parentHistory.some(event => event.data.content === 'MCP_FORK_FIXTURE_PARENT'));
    assert.ok(!parentHistory.some(event => typeof event.data.content === 'string' && event.data.content.includes('MCP_FORK_FIXTURE_CHILD')));
    assert.equal(prompts.length, 4);
    assert.deepEqual(providerErrors, []);

    const heldSend = await invoke('cockpit_send_prompt', {
      session_id: source.sessionId, text: 'MCP_FORK_FIXTURE_HELD',
    });
    assert.ok(!heldSend.isError, heldSend.content[0].text);
    const deadline = Date.now() + 10_000;
    while (!releaseHeld && Date.now() < deadline) await sleep(20);
    assert.ok(releaseHeld, 'The synthetic native turn must actually be running');
    const receipt = Intents['system/shutdown'].result.parse(await intent('system/shutdown', { confirm: true }));
    assert.equal(receipt.shutdown.phase, 'waiting');
    assert.equal(shutdownCompleted, false);
    assert.ok(runtime.liveCount > 0);
    const refused = await invoke('cockpit_send_prompt', {
      session_id: child.sessionId, text: 'MCP_FORK_FIXTURE_REFUSED',
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /shutdown|independent work/i);
    assert.equal(prompts.length, 5, 'Rejected new work never reaches the native provider');
    const status = Intents['system/status'].result.parse(await intent('system/status', {}));
    assert.equal(status.shutdown.phase, 'waiting');
    assert.ok(status.busy > 0);
    releaseHeld();
    releaseHeld = undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Graceful shutdown did not finish after native completion')), 10_000);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
    assert.equal(shutdownCompleted, true, 'Native completion must let the host exit without a supervising callback');
    assert.equal(runtime.liveCount, 0);
    assert.equal(app.server.listening, false);
    assert.deepEqual(shutdownErrors, []);
    assert.deepEqual(providerErrors, []);
  } finally {
    releaseHeld?.();
    offEvent();
    offActivity();
    shutdown.dispose();
    await client.close();
    await transport?.close();
    await app.close();
    try {
      if (!shutdownCompleted) {
        for (const row of (await engine.listLive())) {
          if (row.loaded) { await engine.cancel(row.sessionId); await idle(row.sessionId); }
        }
        await engine.stop();
      }
    } finally {
      provider.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
      process.chdir(previousCwd);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
