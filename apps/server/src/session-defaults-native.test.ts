import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { SessionRole } from '@cockpit/protocol';

test('isolated native HTTP and module creation use durable host defaults without changing existing sessions', {
  skip: process.env.COCKPIT_NATIVE_MODEL_SMOKE !== '1', timeout: 60_000,
}, async t => {
  const before = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), 'cockpit-defaults-native-'));
  const dirs: Record<string, string> = {};
  for (const name of ['home', 'copilot', 'cockpit', 'work', 'tmp', 'cache', 'config', 'run']) {
    dirs[name] = join(root, name);
    await mkdir(dirs[name]!);
  }
  let engine: import('@cockpit/core').Engine | undefined;
  let app: typeof import('./index.ts')['app'] | undefined;
  let requests = 0;
  const provider = createServer(async (req, res) => {
    requests++;
    for await (const _chunk of req) { /* Drain the synthetic request. */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [{ delta: { role: 'assistant', content: 'Synthetic response' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' }]) {
      res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: 'gpt-4.1', choices: [{ index: 0, ...choice }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      HOME: dirs.home, COPILOT_HOME: dirs.copilot, COCKPIT_HOME: dirs.cockpit,
      XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.copilot,
      XDG_RUNTIME_DIR: dirs.run, TMPDIR: dirs.tmp, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
      COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'),
      COCKPIT_NO_BOOT: '1', COCKPIT_SERVE_WEB: '0', LOG_LEVEL: 'silent', COCKPIT_PORT: '0',
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    const { Engine, OfficialRuntime } = await import('@cockpit/core');
    const { HostSessionDefaults } = await import('./session-defaults.ts');
    const host = await import('./index.ts');
    app = host.app;
    const runtime = new OfficialRuntime({
      clientOptions: {
        mode: 'empty', baseDirectory: dirs.copilot, workingDirectory: dirs.work,
        builtinPluginDirectories: [], useLoggedInUser: false, enableRemoteSessions: false, logLevel: 'error',
        onListModels: () => ['gpt-6-astra', 'gpt-4.1'].map(id => ({
          id, name: id, capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 128000 } },
        })),
      },
      sessionConfig: {
        provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
        configDirectory: dirs.copilot, skipCustomInstructions: true, enableFileHooks: false,
        enableHostGitOperations: false, enableSessionStore: false, enableSkills: false,
        skillDirectories: [], pluginDirectories: [], instructionDirectories: [], customAgents: [],
        enableManagedSettings: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
        enableSessionTelemetry: false, remoteSession: 'off', availableTools: [],
      },
    });
    const createNative = runtime.createSession.bind(runtime);
    const created: import('@cockpit/core').RuntimeSession[] = [];
    t.mock.method(runtime, 'createSession', async (config: Parameters<typeof runtime.createSession>[0]) => {
      const sdk = await createNative(config);
      created.push(sdk);
      return sdk;
    });
    const configPath = join(dirs.cockpit!, 'config.json');
    const hostConfig = { schemaVersion: 1, revision: 3, values: { releaseSequence: 23, releaseMetadataDigest: 'synthetic-digest' } };
    await writeFile(configPath, JSON.stringify(hostConfig));
    const store = new HostSessionDefaults();
    engine = new Engine({ runtime, sessionDefaults: store });
    const roles: SessionRole[] = [{ moduleId: 'fixture', moduleName: 'Fixture', roleId: 'node', name: 'Node' }];
    const savedRoles = new Map<string, SessionRole[]>();
    engine.setRoleProvider({
      list: () => roles, read: id => savedRoles.get(id) ?? [],
      save: (id, selected) => { savedRoles.set(id, selected); },
      assemble: async () => ({ roles, fingerprint: 'fixture', skills: [], config: {} }),
    });
    await engine.start();
    host.setTestDependencies({ engine });
    const post = async (name: string, payload: object) => {
      const response = await host.app.inject({ method: 'POST', url: `/intent/${name}`, payload });
      assert.equal(response.statusCode, 200, response.body);
      return response;
    };
    assert.equal((await post('settings/session-defaults', {})).json().modelId, 'gpt-6-astra');
    const first: string = (await post('session/new', { cwd: dirs.work })).json().sessionId;
    assert.equal((await engine.getMeta(first))?.currentModelId, 'gpt-6-astra');
    assert.equal(requests, 0, 'creation never sends a hidden prompt');
    await created[0]!.sendAndWait({ prompt: 'Synthetic fixture for persisted model inheritance.' });
    await post('settings/session-defaults-set', { modelId: 'gpt-4.1' });
    assert.deepEqual(await new HostSessionDefaults().read(), { modelId: 'gpt-4.1' });
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      ...hostConfig, revision: 4, values: { ...hostConfig.values, sessionDefaults: { modelId: 'gpt-4.1' } },
    });
    const second: string = (await post('session/new', { cwd: dirs.work })).json().sessionId;
    const moduleSession = await host.callModuleIntent('session/new', {
      cwd: dirs.work!, roles: [{ moduleId: 'fixture', roleId: 'node' }],
    });
    for (const id of [second, moduleSession.sessionId]) {
      assert.equal((await engine.getMeta(id))?.currentModelId, 'gpt-4.1');
    }
    assert.equal((await engine.getMeta(first))?.currentModelId, 'gpt-6-astra');
    await engine.reload(first);
    assert.equal((await engine.getMeta(first))?.currentModelId, 'gpt-6-astra');
    await engine.unload(first);
    await engine.load(first);
    assert.equal((await engine.getMeta(first))?.currentModelId, 'gpt-6-astra');
    const fork = await engine.forkSession(first);
    await engine.load(fork.sessionId);
    assert.equal((await engine.getMeta(fork.sessionId))?.currentModelId, 'gpt-6-astra');
    await engine.setModel(first, 'gpt-4.1');
    assert.equal((await engine.getMeta(first))?.currentModelId, 'gpt-4.1');
    assert.equal(requests, 1, 'only the explicit synthetic prompt invokes the local provider');
  } finally {
    try { await engine?.stop(); }
    finally {
      await app?.close();
      provider.closeAllConnections();
      if (provider.listening) await new Promise<void>(resolve => provider.close(() => resolve()));
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, before);
      await rm(root, { recursive: true, force: true });
    }
  }
});
