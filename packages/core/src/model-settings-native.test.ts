import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorWithCode } from '../test-support/errors.ts';
import { memorySessionDefaults } from '../test-support/session-defaults.ts';

test('native model settings: complete queued selections, omitted native options, schedules and cold readback', {
  skip: process.env.COCKPIT_NATIVE_MODEL_SMOKE !== '1', timeout: 60_000,
}, async t => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const scratch = resolve('node_modules/.converge-core');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'model-native-'));
  const dirs = Object.fromEntries(['home', 'state', 'work', 'tmp', 'config', 'cache', 'run'].map(name => {
    const dir = join(root, name); mkdirSync(dir); return [name, dir];
  }));
  const env = {
    HOME: dirs.home!, USERPROFILE: dirs.home!, COCKPIT_HOME: dirs.state!,
    XDG_CONFIG_HOME: dirs.config!, XDG_CACHE_HOME: dirs.cache!, XDG_STATE_HOME: dirs.state!,
    XDG_RUNTIME_DIR: dirs.run!, TMPDIR: dirs.tmp!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'),
  };
  let engine: import('./engine.ts').Engine | undefined;
  let requests = 0;
  let heldInference: Promise<void> | undefined;
  let releaseInference = () => {};
  let inferenceStarted = () => {};
  const provider = createServer(async (req, res) => {
    requests++;
    let text = '';
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text) as { model: string };
    inferenceStarted();
    await heldInference;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [{ delta: { role: 'assistant', content: 'Local fixture only' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' }]) {
      res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
        created: 1, model: request.model, choices: [{ index: 0, ...choice }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    process.chdir(dirs.work!);
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    const { RuntimeConnection } = await import('@github/copilot-sdk');
    const { OfficialRuntime } = await import('./runtime.ts');
    const { Engine } = await import('./engine.ts');
    const runtime = new OfficialRuntime({
      clientOptions: {
        connection: RuntimeConnection.forStdio({ env }), mode: 'empty', baseDirectory: dirs.state,
        workingDirectory: dirs.work, builtinPluginDirectories: [], useLoggedInUser: false,
        enableRemoteSessions: false, logLevel: 'error',
        onListModels: () => [{
          id: 'local/reasoner', name: 'Fixture reasoner',
          capabilities: { supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 200000 } },
          supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low',
          billing: { tokenPrices: { longContext: { inputPrice: 1, outputPrice: 1 } } },
        }],
      },
      sessionConfig: {
        model: 'local/reasoner',
        providers: [{ name: 'local', baseUrl: `http://127.0.0.1:${address.port}/v1`, type: 'openai' }],
        models: [{ id: 'reasoner', provider: 'local', modelId: 'gpt-6-astra', maxContextWindowTokens: 200000,
          capabilities: { supports: { reasoningEffort: true } } }],
        configDirectory: dirs.state, skipCustomInstructions: true, enableFileHooks: false,
        enableHostGitOperations: false, enableSessionStore: false, enableSkills: false,
        skillDirectories: [], pluginDirectories: [], instructionDirectories: [], customAgents: [],
        enableManagedSettings: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
        enableSessionTelemetry: false, remoteSession: 'off', availableTools: [],
      },
    });
    engine = new Engine({ runtime, sessionDefaults: memorySessionDefaults('local/reasoner') });
    await engine.start();
    assert.deepEqual(await runtime.listSessions(), [], 'synthetic home contains no user sessions');
    const id = await engine.newSession(dirs.work!);
    const initial = (await engine.getMeta(id))!;
    assert.deepEqual(initial.availableModels?.map(m => m.modelId), ['local/reasoner']);
    assert.deepEqual(initial.availableModels?.[0]?.supportedReasoningEfforts, ['low', 'high']);
    assert.equal(initial.availableModels?.[0]?.supportsLongContext, true);
    assert.equal(initial.currentReasoningEffort, null);
    assert.equal(initial.currentContextTier, null);
    const applied = await engine.setModel(id, 'local/reasoner', 'high', 'long_context');
    assert.equal((await engine.getMeta(id))?.currentReasoningEffort, 'high');
    assert.equal((await engine.getMeta(id))?.currentContextTier, 'long_context');
    await engine.setModel(id, 'local/reasoner', 'low');
    assert.equal((await engine.getMeta(id))?.currentContextTier, null);
    assert.equal((await engine.getMeta(id))?.currentReasoningEffort, 'low');
    await engine.setModel(id, 'local/reasoner', 'high', 'long_context');
    await engine.setModel(id, 'local/reasoner', undefined, 'default');
    assert.equal((await engine.getMeta(id))?.currentContextTier, 'default');
    assert.equal((await engine.getMeta(id))?.currentReasoningEffort, 'high', 'omitted effort follows native behavior, without backend backfill');
    await assert.rejects(engine.setModel(id, 'local/reasoner', 'invented'), errorWithCode('INVALID_REQUEST'));
    for (const recurring of [false, true]) {
      const spaced = await engine.addSchedule(id, { prompt: '  Local whitespace fixture  ', interval: '1h', recurring });
      assert.equal(spaced.error, undefined);
      assert.ok(spaced.entry);
      assert.equal(spaced.entry.prompt, 'Local whitespace fixture');
      assert.equal(spaced.entry.recurring, recurring);
      await assert.rejects(engine.addSchedule(id, { prompt: '\nLocal invalid fixture\n', interval: '1h' }), errorWithCode('INVALID_REQUEST'));
      assert.deepEqual((await engine.listSchedules(id)).map(entry => entry.id), [spaced.entry.id]);
      assert.equal(await engine.stopSchedule(id, spaced.entry.id), true);
    }
    assert.equal(requests, 0, 'Model controls alone must not invoke inference');
    await engine.setModel(id, 'local/reasoner', 'low', 'default');
    heldInference = new Promise<void>(resolve => { releaseInference = resolve; });
    const started = new Promise<void>(resolve => { inferenceStarted = resolve; });
    await engine.prompt(id, 'Local model-settings fixture');
    await started;
    const queuedA = await engine.setModel(id, 'local/reasoner', 'high', 'default');
    const queuedB = await engine.setModel(id, 'local/reasoner', 'high', 'long_context');
    assert.equal(queuedA.deferred, true);
    assert.equal(queuedB.deferred, true);
    t.diagnostic(JSON.stringify({ applied, queuedA, queuedB }));
    assert.equal((await engine.getMeta(id))?.currentReasoningEffort, 'low', 'queued acceptance is not application');
    assert.equal((await engine.getMeta(id))?.currentContextTier, 'default');
    releaseInference();
    const deadline = Date.now() + 15_000;
    while (await engine.busyCount()) {
      assert.ok(Date.now() < deadline); await sleep(20);
    }
    assert.equal((await engine.getMeta(id))?.currentReasoningEffort, 'high');
    assert.equal((await engine.getMeta(id))?.currentContextTier, 'long_context');
    assert.ok(requests >= 1 && requests <= 2, 'Only the synthetic exchange and optional native title request use the loopback provider');
    await engine.unload(id);
    assert.equal((await engine.getMeta(id))?.currentReasoningEffort, undefined);
    await engine.reload(id);
    const resumed = (await engine.getMeta(id))!;
    assert.equal(resumed.currentReasoningEffort, 'high');
    assert.equal(resumed.currentContextTier, 'long_context');
    await engine.stop();
    engine = undefined;
  } finally {
    releaseInference();
    if (engine) await engine.stop();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
