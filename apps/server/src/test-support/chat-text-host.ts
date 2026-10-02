import { Engine, OfficialRuntime } from '@cockpit/core';
import { fixtureModelCatalog, memorySessionDefaults } from '../../../../packages/core/test-support/session-defaults.ts';
import { app, setTestDependencies } from '../index.ts';
import { GracefulShutdown } from '../shutdown.ts';

const runtime = new OfficialRuntime({
  clientOptions: {
    mode: 'empty', baseDirectory: process.env.COPILOT_HOME, workingDirectory: process.cwd(),
    useLoggedInUser: false, enableRemoteSessions: false, builtinPluginDirectories: [],
    onListModels: fixtureModelCatalog, logLevel: 'error',
  },
  sessionConfig: {
    model: 'gpt-4.1',
    provider: { type: 'openai', wireApi: 'completions', baseUrl: process.env.FIXTURE_PROVIDER_URL!, modelId: 'gpt-4.1' },
    workingDirectory: process.cwd(), configDirectory: process.env.COPILOT_HOME, streaming: true,
    skipCustomInstructions: true, enableFileHooks: false, enableHostGitOperations: false,
    enableSessionStore: false, enableSkills: false, enableManagedSettings: false,
    skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
    enableSessionTelemetry: false, remoteSession: 'off', availableTools: [],
    skillDirectories: [], pluginDirectories: [], instructionDirectories: [], customAgents: [],
  },
});
const engine = new Engine({ runtime, sessionDefaults: memorySessionDefaults('gpt-4.1') });
const shutdown = new GracefulShutdown({
  busyCount: () => engine.busyCount(),
  stopNative: beforeClose => engine.stop(beforeClose),
  closeTransport: () => app.close(),
  exit: code => process.exit(code),
  report: (error, stage) => console.error(stage, error),
  delayMs: 20,
});
engine.onActivitySettled(() => shutdown.notify());
engine.onEvent(() => shutdown.notify());
setTestDependencies({ engine, shutdown });
process.on('SIGTERM', () => shutdown.request());
process.on('disconnect', () => shutdown.request());
await engine.start();
const url = await app.listen({ host: '127.0.0.1', port: 0 });
process.send!({ type: 'ready', pid: process.pid, url });
