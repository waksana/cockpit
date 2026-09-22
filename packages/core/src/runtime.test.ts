import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { RuntimeConnection, approveAll, type CopilotClientOptions, type CopilotSession, type GetAuthStatusResponse, type ModelInfo, type SessionConfig, type SessionEvent } from '@github/copilot-sdk';
import { OfficialRuntime, sessionModelOptions, type RuntimeClient } from './runtime.ts';

function fixture(options: { clientOptions?: CopilotClientOptions; sessionConfig?: Partial<SessionConfig>; child?: boolean } = {}) {
  const clients: RuntimeClient[] = [];
  const configs: SessionConfig[] = [];
  const connections: CopilotClientOptions[] = [];
  const trace: string[] = [];
  let stopErrors: Error[] = [];
  let closeError: Error | undefined;
  let detachError: Error | undefined;
  let attached = true;
  const listeners = new Map<string, (event: SessionEvent) => void>();
  const child = Object.assign(new EventEmitter(), { spawnargs: ['copilot-runtime', '--headless', '--no-auto-update'] });
  const runtime = new OfficialRuntime({
    clientOptions: options.clientOptions,
    sessionConfig: options.sessionConfig,
    clientFactory: config => {
      connections.push(config);
      const instance = clients.length;
      const session = (id: string) => ({
        sessionId: id,
        disconnect: async () => { trace.push(`detach:${id}`); if (detachError) throw detachError; },
        on: (handler: (event: SessionEvent) => void) => {
          listeners.set(id, handler);
          return () => { listeners.delete(id); };
        },
      }) as unknown as CopilotSession;
      const client = {
        start: async () => {
          trace.push(`start:${instance}`);
          if (options.child) { channel('child_process').publish({ process: child }); child.emit('spawn'); }
        },
        getStatus: async () => ({ version: '1.0.83', protocolVersion: 3 }),
        getAuthStatus: async () => { trace.push('auth'); return { isAuthenticated: false }; },
        stop: async () => {
          trace.push(`stop:${instance}`);
          if (options.child) { child.emit('exit', 0, null); child.emit('close'); }
          return stopErrors;
        },
        listModels: async () => [],
        listSessions: async () => [],
        getSessionMetadata: async () => undefined,
        createSession: async (config: SessionConfig) => { configs.push(config); return session(config.sessionId ?? `s${configs.length}`); },
        resumeSession: async (id: string, config: SessionConfig) => { configs.push(config); return session(id); },
        deleteSession: async (id: string) => { trace.push(`delete:${id}`); },
        rpc: { sessions: {
          open: async ({ kind, sessionId }: { kind: string; sessionId: string }) => {
            assert.equal(kind, 'attach', 'Liveness must never resume a native session');
            trace.push(`attach:${sessionId}`);
            return { status: attached ? 'resumed' : 'not_found', ...(attached ? { sessionId } : {}) };
          },
          close: async ({ sessionId }: { sessionId: string }) => {
            trace.push(`close:${sessionId}`);
            if (closeError) throw closeError;
            return {};
          },
        } },
      } as unknown as RuntimeClient;
      clients.push(client);
      return client;
    },
  });
  return {
    runtime, clients, configs, connections, trace, child, listeners,
    attached(value: boolean) { attached = value; },
    stopErrors(errors: Error[]) { stopErrors = errors; },
    closeError(error?: Error) { closeError = error; },
    detachError(error?: Error) { detachError = error; },
  };
}

test('explicit stdio and official approveAll are enforced at both create and resume', async () => {
  const f = fixture();
  await Promise.all([f.runtime.start(), f.runtime.start()]);
  assert.equal(f.clients.length, 1);
  assert.equal(f.connections[0]?.connection?.kind, 'stdio');
  assert.equal(f.connections[0]?.mode, 'copilot-cli');
  assert.equal(f.connections[0]?.useLoggedInUser, true);
  assert.equal(f.connections[0]?.sessionIdleTimeoutSeconds, 1800);
  const a = await f.runtime.createSession({ onPermissionRequest: () => ({ kind: 'denied-interactively-by-user' }) });
  const b = await f.runtime.resumeSession('persisted', {});
  assert.equal(f.configs.length, 2);
  for (const config of f.configs) {
    assert.equal(config.onPermissionRequest, approveAll);
    assert.equal(config.enableFileChangeTracking, true);
    assert.equal(config.includeSubAgentStreamingEvents, true);
  }
  await assert.rejects(f.runtime.stop(), /live sessions/);
  await f.runtime.closeSession(a);
  assert.equal(f.runtime.liveCount, 1);
  assert.ok(!f.trace.some(row => row.startsWith('stop:')));
  await f.runtime.closeSession(b);
  await f.runtime.stop();
  assert.equal(f.runtime.liveCount, 0);
  assert.ok(f.trace.indexOf(`close:${a.sessionId}`) < f.trace.indexOf(`detach:${a.sessionId}`));
});

test('COCKPIT_HOME never overrides native client or session directories', async t => {
  const previous = process.env.COCKPIT_HOME;
  process.env.COCKPIT_HOME = `${process.cwd()}/.synthetic-runtime-host`;
  t.after(() => { if (previous === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = previous; });
  const f = fixture();
  await f.runtime.start();
  assert.equal(Object.hasOwn(f.connections[0]!, 'baseDirectory'), false);
  const created = await f.runtime.createSession({ sessionId: 'synthetic-root-session' });
  const resumed = await f.runtime.resumeSession('synthetic-existing', {});
  for (const config of f.configs) assert.equal(Object.hasOwn(config, 'configDirectory'), false);
  await f.runtime.closeSession(created);
  await f.runtime.closeSession(resumed);
  await f.runtime.stop();
});

test('explicit SDK directory options remain available for isolated native fixtures', async () => {
  const baseDirectory = `${process.cwd()}/.synthetic-native-home`;
  const configDirectory = `${process.cwd()}/.synthetic-native-config`;
  const f = fixture({ clientOptions: { baseDirectory }, sessionConfig: { configDirectory } });
  const created = await f.runtime.createSession({});
  const resumed = await f.runtime.resumeSession('isolated', {});
  assert.equal(f.connections[0]?.baseDirectory, baseDirectory);
  for (const config of f.configs) assert.equal(config.configDirectory, configDirectory);
  await f.runtime.closeSession(created);
  await f.runtime.closeSession(resumed);
  await f.runtime.stop();
});

test('request-local catalog enrichment preserves membership and explicit capability restrictions', () => {
  const rich = [{ modelId: 'reasoner', name: 'Global', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high', supportsLongContext: true }];
  assert.deepEqual(sessionModelOptions([{ id: 'reasoner', name: 'Session' }], rich), [{ ...rich[0], name: 'Session' }]);
  assert.deepEqual(sessionModelOptions([], rich), []);
  assert.deepEqual(sessionModelOptions([{ id: 'reasoner', supportedReasoningEfforts: [],
    defaultReasoningEffort: '', supportsLongContext: false }], rich), [{
    modelId: 'reasoner', name: 'reasoner', supportedReasoningEfforts: [],
    defaultReasoningEffort: '', supportsLongContext: false,
  }]);
  assert.deepEqual(sessionModelOptions([{ id: 'reasoner', capabilities: { supports: { reasoningEffort: false } },
    billing: { token_prices: {} } }], rich)[0]?.supportedReasoningEfforts, []);
  assert.equal(sessionModelOptions([{ id: 'reasoner', billing: { token_prices: {} } }], rich)[0]?.supportsLongContext, false);
  const other = sessionModelOptions([{ id: 'local/reasoner' }], rich)[0]!;
  assert.equal(other.supportedReasoningEfforts, undefined);
  assert.equal(other.supportsLongContext, undefined);
  for (const value of [null, [1], 'high']) {
    assert.throws(() => sessionModelOptions([{ id: 'reasoner', supportedReasoningEfforts: value }], rich), /reasoning metadata/);
  }
});

test('global model reads use the public uncached RPC on every request', async () => {
  const f = fixture();
  await f.runtime.start();
  let calls = 0;
  Object.assign(f.clients[0]!.rpc, { models: { list: async () => ({
    models: [{ id: `model-${++calls}`, name: 'Fresh' }],
  }) } });
  assert.equal((await f.runtime.models())[0]?.modelId, 'model-1');
  assert.equal((await f.runtime.models())[0]?.modelId, 'model-2');
  await f.runtime.stop();
});

test('native close failure retains ownership; retry does not detach prematurely', async () => {
  const f = fixture();
  const session = await f.runtime.createSession({});
  f.closeError(new Error('flush rejected'));
  await assert.rejects(f.runtime.closeSession(session), /flush rejected/);
  assert.equal(f.runtime.liveCount, 1);
  assert.ok(!f.trace.some(row => row.startsWith('detach:')));
  f.closeError();
  await f.runtime.closeSession(session);
  await f.runtime.stop();
});

test('create and resume preserve explicitly configured native tools and skill directories without bundled extras', async () => {
  const hostTool = { name: 'host_tool', handler: () => 'host' };
  const sessionTool = { name: 'session_tool', handler: () => 'session', isTerminal: true };
  const f = fixture({ sessionConfig: { tools: [hostTool], skillDirectories: ['/host-skills'] } });
  const a = await f.runtime.createSession({ tools: [sessionTool], skillDirectories: ['/session-skills'] });
  const b = await f.runtime.resumeSession('existing', { tools: [sessionTool], skillDirectories: ['/session-skills'] });
  for (const config of f.configs) {
    assert.deepEqual(config.tools, [hostTool, sessionTool]);
    assert.deepEqual(config.skillDirectories, ['/host-skills', '/session-skills']);
  }
  await f.runtime.closeSession(a);
  await f.runtime.closeSession(b);
  await f.runtime.stop();
});

test('detach failure retries detach without repeating successful native close', async () => {
  const f = fixture();
  const session = await f.runtime.createSession({});
  f.detachError(new Error('detach rejected'));
  await assert.rejects(f.runtime.closeSession(session), /detach rejected/);
  assert.equal(f.runtime.liveCount, 1);
  f.detachError();
  await f.runtime.closeSession(session);
  assert.equal(f.trace.filter(row => row.startsWith('close:')).length, 1);
  await f.runtime.stop();
});

test('role MCP and appended instructions merge without replacing unrelated native configuration', async () => {
  const existing = { type: 'http' as const, url: 'http://127.0.0.1/existing', tools: ['native'] };
  const role = { type: 'http' as const, url: 'http://127.0.0.1/role', tools: ['role'] };
  const f = fixture({ sessionConfig: {
    mcpServers: { existing }, systemMessage: { mode: 'append', content: 'Native host appendix' },
  } });
  const a = await f.runtime.createSession({
    mcpServers: { module_fixture__tools: role }, systemMessage: { mode: 'append', content: 'Raw role appendix' },
  });
  const b = await f.runtime.resumeSession('resumed-role', {
    mcpServers: { module_fixture__tools: role }, systemMessage: { mode: 'append', content: 'Raw role appendix' },
  });
  for (const config of f.configs) {
    assert.deepEqual(config.mcpServers, { existing, module_fixture__tools: role });
    assert.deepEqual(config.systemMessage, { mode: 'append', content: 'Native host appendix\n\nRaw role appendix' });
  }
  await assert.rejects(f.runtime.createSession({ mcpServers: { existing: role } }), /Conflicting MCP/);
  await assert.rejects(f.runtime.createSession({ mcpServers: { existing } }), /Conflicting MCP/);
  await f.runtime.closeSession(a); await f.runtime.closeSession(b); await f.runtime.stop();
});

test('shutdown Error[] is not success and prevents silently starting another client', async () => {
  const f = fixture();
  await f.runtime.start();
  f.stopErrors([new Error('owned PID did not exit')]);
  await assert.rejects(f.runtime.stop(), /shutdown did not complete/);
  await assert.rejects(f.runtime.start(), /shutdown did not complete/);
  assert.equal(f.clients.length, 1);
});

test('native SDK alone controls capacity; neither live sessions nor closed wrappers trigger recycling', async () => {
  const f = fixture();
  const sessions = await Promise.all(Array.from({ length: 40 }, () => f.runtime.createSession({})));
  assert.equal(f.runtime.liveCount, 40);
  for (const session of sessions) await f.runtime.closeSession(session);
  for (let i = 0; i < 40; i++) await f.runtime.closeSession(await f.runtime.resumeSession(`persisted-${i}`, {}));
  assert.equal(f.clients.length, 1);
  assert.ok(!f.trace.some(entry => entry.startsWith('stop:')));
  await f.runtime.stop();
});

test('only the actual owned wrapper can close a native session', async () => {
  const f = fixture();
  const session = await f.runtime.createSession({ sessionId: 'same' });
  await assert.rejects(f.runtime.resumeSession('same', {}), /already owned/);
  await assert.rejects(f.runtime.closeSession({ sessionId: 'same' } as CopilotSession), /not owned/);
  assert.equal(f.runtime.liveCount, 1);
  await f.runtime.closeSession(session);
  await f.runtime.stop();
});

test('FFI remains unsupported while the official native idle option is caller-configurable', async () => {
  assert.throws(() => new OfficialRuntime({ clientOptions: { connection: RuntimeConnection.forInProcess() } }), /FFI/);
  for (const sessionIdleTimeoutSeconds of [0, 1, 60, 1800]) {
    const f = fixture({ clientOptions: { sessionIdleTimeoutSeconds } });
    await f.runtime.start();
    assert.equal(f.connections[0]?.sessionIdleTimeoutSeconds, sessionIdleTimeoutSeconds);
    await f.runtime.stop();
  }
});

test('auth connects and preserves public SDK status without requiring a GitHub login', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.getAuthStatus(), { isAuthenticated: false });
  assert.deepEqual(f.trace, ['start:0', 'auth']);
  const status: GetAuthStatusResponse = { isAuthenticated: true, authType: 'api-key', statusMessage: 'BYOK' };
  f.clients[0]!.getAuthStatus = async () => { f.trace.push('auth'); return status; };
  const [actual] = await Promise.all([f.runtime.getAuthStatus(), f.runtime.stop()]);
  assert.equal(actual, status);
  assert.deepEqual(f.trace, ['start:0', 'auth', 'auth', 'stop:0']);
});

test('deletion connects, serializes with ownership, and requires successful native close and detach', async () => {
  const f = fixture();
  await f.runtime.deleteSession('persisted');
  assert.deepEqual(f.trace, ['start:0', 'delete:persisted']);
  const creating = f.runtime.createSession({ sessionId: 'synthetic' });
  const rejected = assert.rejects(f.runtime.deleteSession('synthetic'), /live session.*Engine/);
  const session = await creating;
  await rejected;
  f.closeError(new Error('close failed'));
  await assert.rejects(f.runtime.closeSession(session), /close failed/);
  await assert.rejects(f.runtime.deleteSession(session.sessionId), /live session/);
  f.closeError();
  f.detachError(new Error('detach failed'));
  await assert.rejects(f.runtime.closeSession(session), /detach failed/);
  await assert.rejects(f.runtime.deleteSession(session.sessionId), /live session/);
  assert.ok(!f.trace.includes('delete:synthetic'));
  f.detachError();
  await Promise.all([f.runtime.closeSession(session), f.runtime.deleteSession(session.sessionId)]);
  assert.deepEqual(f.trace.slice(-2), ['detach:synthetic', 'delete:synthetic']);
  assert.equal(f.runtime.liveCount, 0);
  f.clients[0]!.deleteSession = async () => { throw new Error('native deletion failed'); };
  f.clients[0]!.getSessionMetadata = async id => ({
    sessionId: id, startTime: new Date(), modifiedTime: new Date(), isRemote: false,
  });
  await assert.rejects(f.runtime.deleteSession('missing'), /native deletion failed/);
  f.clients[0]!.getSessionMetadata = async () => { throw new Error('lookup failed'); };
  await assert.rejects(f.runtime.deleteSession('missing'), /absence could not be confirmed/);
  f.clients[0]!.getSessionMetadata = async () => undefined;
  await f.runtime.deleteSession('missing');
  await f.runtime.stop();
});

test('missing cleanup notifications are reconciled by passive attach and public disconnect before resume', async () => {
  const f = fixture();
  const session = await f.runtime.createSession({ sessionId: 'idle' });
  const closed: CopilotSession[] = [];
  f.runtime.onSessionClosed(sdk => closed.push(sdk));
  assert.equal(await f.runtime.isSessionLive(session), true);
  f.attached(false);
  assert.equal(await f.runtime.isSessionLive(session), false);
  assert.equal(f.runtime.liveCount, 0);
  assert.deepEqual(closed, [session]);
  assert.ok(!f.trace.includes('close:idle'), 'Native cleanup must not be repeated');
  const resumed = await f.runtime.resumeSession('idle', {});
  assert.notEqual(resumed, session);
  assert.equal(await f.runtime.isSessionLive(session), false, 'Stale wrappers must never address a replacement');
  assert.equal(f.runtime.liveCount, 1);
  await f.runtime.closeSession(resumed);
  await f.runtime.stop();
});

test('shutdown notification only triggers confirmation; it cannot evict a still-live session', async () => {
  const f = fixture();
  const sdk = await f.runtime.createSession({ sessionId: 'idle' });
  const shutdown = { type: 'session.shutdown', data: { shutdownType: 'routine' } } as SessionEvent;
  f.listeners.get('idle')!(shutdown);
  await f.runtime.start();
  assert.equal(f.runtime.liveCount, 1);
  f.attached(false);
  f.listeners.get('idle')!(shutdown);
  await f.runtime.start();
  assert.equal(f.runtime.liveCount, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(await f.runtime.isSessionLive(sdk), false);
  await f.runtime.stop();
});

test('failed native cleanup detach retains ownership for a safe public-API retry', async () => {
  const f = fixture();
  const sdk = await f.runtime.createSession({});
  f.attached(false);
  f.detachError(new Error('detach failed'));
  await assert.rejects(f.runtime.isSessionLive(sdk), /detach failed/);
  assert.equal(f.runtime.liveCount, 1);
  f.detachError();
  await f.runtime.closeSession(sdk);
  assert.ok(!f.trace.some(entry => entry.startsWith('close:')));
  await f.runtime.stop();
});

test('confirmed owned child exit is fatal, releases queued calls and allows stop without session RPCs', async () => {
  const f = fixture({ child: true });
  await f.runtime.createSession({});
  const errors: Error[] = [];
  f.runtime.onFatal(error => errors.push(error));
  f.clients[0]!.createSession = () => new Promise(() => {});
  const hanging = f.runtime.createSession({});
  const rejected = assert.rejects(hanging, /host restart required.*uncertain/);
  await Promise.resolve();
  await Promise.resolve();
  f.child.emit('exit', null, 'SIGKILL');
  f.child.emit('close');
  await rejected;
  assert.equal(errors.length, 1);
  assert.equal(f.runtime.failure, errors[0]);
  assert.equal(f.runtime.liveCount, 0);
  await assert.rejects(f.runtime.start(), /host restart required/);
  await f.runtime.stop();
  assert.ok(!f.trace.some(entry => /^(close|detach):/.test(entry)));
  assert.equal(f.clients.length, 1);
});

test('unrelated child exits and expected native stop are not fatal', async () => {
  const f = fixture({ child: true });
  await f.runtime.start();
  const other = Object.assign(new EventEmitter(), { spawnargs: ['copilot-runtime', '--headless', '--no-auto-update'] });
  channel('child_process').publish({ process: other });
  other.emit('spawn');
  other.emit('exit', 1);
  assert.equal(f.runtime.failure, undefined);
  await f.runtime.stop();
  assert.equal(f.runtime.failure, undefined);
});

test('fatal startup and simultaneous host stops share one native cleanup', async () => {
  const f = fixture({ child: true });
  const start = f.runtime.start();
  const rejected = assert.rejects(start, /host restart required/);
  while (!f.clients.length) await Promise.resolve();
  f.clients[0]!.getStatus = () => new Promise(() => {});
  await Promise.resolve();
  f.child.emit('exit', 1, null);
  const stops = [f.runtime.stop(), f.runtime.stop()];
  f.child.emit('close');
  await rejected;
  await Promise.all(stops);
  assert.equal(f.trace.filter(entry => entry === 'stop:0').length, 1);
});

test('completed runtime calls release fatal listeners rather than retaining an unbounded promise chain', async t => {
  const f = fixture();
  const onFatal = f.runtime.onFatal.bind(f.runtime);
  let listeners = 0;
  t.mock.method(f.runtime, 'onFatal', (handler: (error: Error) => void) => {
    listeners++;
    const off = onFatal(handler);
    return () => { listeners--; off(); };
  });
  const sdk = await f.runtime.createSession({});
  for (let i = 0; i < 200; i++) {
    await f.runtime.isSessionLive(sdk);
    assert.equal(listeners, 0);
  }
  await f.runtime.closeSession(sdk);
  await f.runtime.stop();
  assert.equal(listeners, 0);
});

test('provider model context tiers are explicit capabilities independent of pricing', () => {
  const option = (fields: Record<string, unknown>) => sessionModelOptions(
    [{ id: 'provider/model', ...fields }],
    [{ modelId: 'provider/model', name: 'Global', supportsLongContext: true }],
  )[0]!;
  assert.equal(option({ supportedContextTiers: ['default', 'long_context'] }).supportsLongContext, true);
  assert.equal(option({ supportedContextTiers: ['long_context'], billing: { tokenPrices: {} } }).supportsLongContext, true);
  for (const tiers of [[], ['default'], ['future_tier']]) {
    assert.equal(option({ supportedContextTiers: tiers, billing: { tokenPrices: { longContext: {} } } }).supportsLongContext, false);
  }
  assert.equal(option({ supportedContextTiers: ['long_context'], supportsLongContext: false }).supportsLongContext, false);
  assert.equal(option({ billing: { tokenPrices: { longContext: {} } } }).supportsLongContext, true);
  assert.equal(option({ billing: { token_prices: { long_context: {} } } }).supportsLongContext, true);
  assert.equal(option({ billing: { tokenPrices: {} } }).supportsLongContext, false);
  assert.equal(option({}).supportsLongContext, true, 'Only missing capability metadata can use the same-ID catalog');
  for (const tiers of [null, false, 'long_context', [1]]) {
    assert.throws(() => option({ supportedContextTiers: tiers }), /Invalid context tier metadata/);
  }
});

test('model metadata uses documented billing and preserves provider-qualified selection IDs', () => {
  const info: ModelInfo = {
    id: 'model', name: 'Model', capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 100 } },
    supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
    billing: { tokenPrices: { longContext: {} } },
  };
  const [option] = sessionModelOptions([info]);
  assert.equal(option?.supportsLongContext, true);
  const provider = { ...info, billing: undefined, supportedContextTiers: ['default', 'long_context'] };
  assert.equal(sessionModelOptions([provider])[0]?.supportsLongContext, true, 'Global and session projections recognize the same provider tiers');
  assert.deepEqual(sessionModelOptions([{ ...info, id: 'provider/model' }]), [{ ...option, modelId: 'provider/model' }]);
  assert.deepEqual(sessionModelOptions([{ id: 'hidden', model_picker_enabled: false }]), []);
  assert.throws(() => sessionModelOptions([null]), /invalid model ID/);
});
