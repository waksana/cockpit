import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { CopilotClient, CopilotSession, GetAuthStatusResponse, SessionConfig, SessionEvent, SessionMetadata } from '@github/copilot-sdk';
import { NativeChatRead } from '@cockpit/protocol';
import type { Engine, EngineRuntime, NativeObservation } from './engine.ts';
import { CHAT_EVENT_TYPES } from './native-chat.ts';

type PersistedPage = Awaited<ReturnType<CopilotClient['rpc']['sessions']['readPersistedEvents']>>;
const draftModels = ['confirmed-model', 'unconfirmed-model', 'first-model', 'last-model'].map(id => ({
  id, name: id, supportedReasoningEfforts: ['low', 'high'],
  supportedContextTiers: ['default', 'long_context'] as const,
}));

async function draftFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const root = `.runtime-draft-${randomUUID()}`;
  mkdirSync(root);
  const cwd = resolve(root);
  const prefsFile = join(root, 'prefs.json');
  const { Engine } = await import('./engine.ts');
  type Rpc = CopilotSession['rpc'];
  const live = new Map<string, CopilotSession>();
  const closed = new Set<(sdk: CopilotSession) => void>();
  const rows = new Map<string, SessionMetadata>();
  const journals = new Map<string, SessionEvent[]>();
  const makeSession = (id: string, config: SessionConfig = {}) => {
    const state = {
      name: null as string | null, mode: 'interactive' as Awaited<ReturnType<Rpc['mode']['get']>>,
      model: { modelId: config.model ?? 'default-model', reasoningEffort: config.reasoningEffort,
        contextTier: config.contextTier } as Awaited<ReturnType<Rpc['model']['getCurrent']>>,
      skill: !config.disabledSkills?.includes('fixture-skill'),
      mcp: true,
      events: [] as SessionEvent[],
    };
    const rpc = {
      eventLog: {
        read: async ({ direction = 'forward', max = 200, types = '*', agentScope = 'all' }:
          Parameters<Rpc['eventLog']['read']>[0]): Promise<Awaited<ReturnType<Rpc['eventLog']['read']>>> => {
          const events = state.events.filter(event => !event.ephemeral
            && (types === '*' || types.includes(event.type))
            && (agentScope === 'all' || !event.agentId || event.type.startsWith('subagent.')));
          assert.ok(events.length <= max, 'Draft fixture must never require pagination');
          return { events, cursor: `${direction}-draft-boundary`, hasMore: false, cursorStatus: 'ok' };
        },
      },
      name: {
        get: async () => ({ name: state.name }),
        set: t.mock.fn(async ({ name }: { name: string }) => { state.name = name.trim(); }),
      },
      mode: {
        get: async () => state.mode,
        set: t.mock.fn(async ({ mode }: Parameters<Rpc['mode']['set']>[0]) => {
          state.mode = mode;
          return { status: 'applied' as const, modelChanged: false };
        }),
      },
      model: {
        getCurrent: async () => ({ ...state.model }),
        list: async () => ({ list: draftModels.map(model => ({ ...model, supportedContextTiers: [...model.supportedContextTiers] })) }),
        switchTo: t.mock.fn(async (options: Parameters<Rpc['model']['switchTo']>[0]) => {
          state.model = { modelId: options.modelId, reasoningEffort: options.reasoningEffort, contextTier: options.contextTier };
          return { modelId: options.modelId };
        }),
      },
      metadata: {
        snapshot: async (): Promise<Awaited<ReturnType<Rpc['metadata']['snapshot']>>> => ({
          sessionId: id, summary: state.name ?? '', workingDirectory: cwd,
          startTime: '2026-09-08T00:00:00.000Z', modifiedTime: '2026-09-08T00:00:00.000Z',
          currentMode: state.mode, isRemote: false, alreadyInUse: false, workspacePath: null, sessionLimits: null,
        }),
        isProcessing: async () => ({ processing: false }),
        activity: async () => ({ hasActiveWork: false, abortable: false }) },
      queue: { pendingItems: async () => ({ items: [], steeringMessages: [], inFlightSteeringCount: 0 }) },
      tasks: { list: async () => ({ tasks: [] }) },
      plan: { readSqlTodos: async () => ({ rows: [] }) },
      schedule: { list: async () => ({ entries: [] }) },
      skills: {
        list: async () => ({ skills: [{ name: 'fixture-skill', description: 'fixture', source: 'project',
          enabled: state.skill, userInvocable: true }] }),
        disable: async () => { state.skill = false; }, enable: async () => { state.skill = true; },
      },
      mcp: {
        list: async () => ({
          servers: [{ name: 'fixture-mcp', status: state.mcp ? 'connected' : 'disabled' }],
          host: { mcp3pEnabled: true, disabledServers: state.mcp ? [] : ['fixture-mcp'],
            filteredServers: [], clients: state.mcp ? ['fixture-mcp'] : [],
            pendingConnections: [], needsAuthServers: {}, failedServers: {} },
        }),
        enable: async () => { state.mcp = true; }, disable: async () => { state.mcp = false; },
      },
      history: { compact: t.mock.fn(async (_options: Parameters<Rpc['history']['compact']>[0]) =>
        ({ success: true, tokensRemoved: 0, messagesRemoved: 0 })) },
      commands: { invoke: t.mock.fn(async (_options: Parameters<Rpc['commands']['invoke']>[0]) => ({ kind: 'completed' as const })) },
    } satisfies { [K in keyof Rpc]?: Partial<Rpc[K]> };
    const sdk = {
      sessionId: id, rpc, on: () => () => {}, getEvents: async () => structuredClone(state.events),
      send: t.mock.fn(async (_options: Parameters<CopilotSession['send']>[0]) => 'accepted-without-event'),
    };
    return { state, rpc, sdk: sdk as unknown as CopilotSession, send: sdk.send };
  };
  const natives = new Map<string, ReturnType<typeof makeSession>>();
  const saved = new Map<string, ReturnType<typeof makeSession>>();
  const expire = (id: string) => {
    const sdk = live.get(id);
    live.delete(id);
    if (sdk) for (const listener of closed) listener(sdk);
  };
  const runtime = {
    start: async () => {}, stop: async () => {}, models: async () => [],
    getAuthStatus: async () => ({ isAuthenticated: false }),
    onFatal: () => () => {}, failure: undefined,
    onSessionClosed: (handler: (sdk: CopilotSession) => void) => { closed.add(handler); return () => { closed.delete(handler); }; },
    isSessionLive: async (sdk: CopilotSession) => live.get(sdk.sessionId) === sdk,
    get liveCount() { return live.size; },
    listSessions: async () => [...rows.values()],
    getSessionMetadata: t.mock.fn(async (id: string) => rows.get(id)),
    createSession: t.mock.fn(async (config: SessionConfig) => {
      assert.ok(config.sessionId);
      assert.ok(!live.has(config.sessionId), 'Only one allocation may own an ID');
      const native = makeSession(config.sessionId, config);
      natives.set(config.sessionId, native);
      live.set(config.sessionId, native.sdk);
      return native.sdk;
    }),
    resumeSession: t.mock.fn(async (id: string, _config: SessionConfig) => {
      const native = saved.get(id);
      if (!native) throw new Error('Native session missing');
      natives.set(id, native);
      live.set(id, native.sdk);
      return native.sdk;
    }),
    closeSession: async (sdk: CopilotSession) => { expire(sdk.sessionId); },
    deleteSession: async () => { assert.fail('Missing-session handling must not delete native history'); },
    rpc: {
      user: { settings: { get: async () => ({ settings: { disabledSkills: { value: null, default: null, isDefault: true } } }) } },
      sessions: {
      save: t.mock.fn(async () => { assert.fail('Missing-session handling must not save a blank session'); }),
      readPersistedEvents: t.mock.fn(async ({
        sessionId, cursor, direction = 'forward', max = 100,
      }: Parameters<CopilotClient['rpc']['sessions']['readPersistedEvents']>[0]): Promise<PersistedPage> => {
        const events = journals.get(sessionId);
        if (!events) throw new Error('Native journal missing');
        const boundary = cursor ? Number(cursor) : direction === 'backward' ? events.length : 0;
        assert.ok(Number.isSafeInteger(boundary) && boundary >= 0 && boundary <= events.length);
        const start = direction === 'backward' ? Math.max(0, boundary - max) : boundary;
        const end = direction === 'backward' ? boundary : Math.min(events.length, boundary + max);
        return { events: structuredClone(events.slice(start, end)),
          cursor: String(direction === 'backward' ? start : end),
          hasMore: direction === 'backward' ? start > 0 : end < events.length, cursorStatus: 'ok' };
      }),
    } },
  };
  const engine = new Engine({ runtime: runtime as unknown as EngineRuntime });
  t.after(async () => {
    try {
      for (const id of live.keys()) expire(id);
      await engine.stop();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  await engine.start();
  return { engine, runtime, cwd, prefsFile, natives, makeSession, saved, rows, journals, expire,
    chat: (sessionId: string, direction: 'forward' | 'backward' = 'backward') =>
      engine.chat(NativeChatRead.parse({ sessionId, direction, max: 2 })),
  };
}

const draftSettings = {
  rename: (engine: Engine, id: string) => engine.rename(id, '  Confirmed draft  '),
  model: (engine: Engine, id: string) => engine.setModel(id, 'confirmed-model', 'high', 'long_context'),
  mode: (engine: Engine, id: string) => engine.setMode(id, 'plan'),
  skill: (engine: Engine, id: string) => engine.toggleSessionSkill(id, 'fixture-skill', false),
  MCP: async (engine: Engine, id: string) => assert.equal((await engine.toggleSessionMcp(id, 'fixture-mcp', true)).ok, true),
};

async function draftProjection(engine: Engine, id: string) {
  const meta = (await engine.getMeta(id))!;
  return { title: meta.title, model: meta.currentModelId, reasoning: meta.currentReasoningEffort,
    context: meta.currentContextTier, mode: meta.currentMode };
}

async function bounded<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Native smoke timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function nativeChat(engine: Engine, sessionId: string, query: Partial<NativeChatRead> = {}) {
  return bounded(engine.chat(NativeChatRead.parse({ sessionId, ...query })));
}

async function eventually(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate()) && Date.now() < deadline) await sleep(25);
  assert.ok(await predicate(), label);
}

function runtimeChildren(): number[] {
  return [...new Set(readdirSync(`/proc/${process.pid}/task`).flatMap((tid) => {
    try {
      return readFileSync(`/proc/${process.pid}/task/${tid}/children`, 'utf8').trim().split(/\s+/)
        .filter(Boolean).map(Number).filter((pid) => readlinkSync(`/proc/${pid}/exe`).endsWith('/copilot-runtime'));
    } catch { return []; }
  }))];
}

function rssKiB(pid: number) {
  try { return Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0); }
  catch { return 0; }
}

test('native runtime: isolated BYOK, history, rollback, idle timeout and schedule persistence', {
  skip: process.env.COCKPIT_NATIVE_SMOKE !== '1',
  timeout: 120_000,
}, async (t) => {
  assert.equal(process.platform, 'linux', 'PID/RSS verification requires Linux /proc');
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const fixture = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.native-smoke-'));
  const dirs = Object.fromEntries(['home', 'state', 'work', 'scratch', 'config', 'cache', 'xdg-state', 'run']
    .map((name) => [name, join(fixture, name)])) as Record<string, string>;
  const checks: string[] = [];
  const samples: { cycle: number; phase: string; hostRssKiB: number; runtimePid: number; runtimeRssKiB: number }[] = [];
  const stops: { pid: number; errors: string[]; exited: boolean }[] = [];
  const owned = new Map<number, string>();
  const ownedShells = new Map<number, string>();
  const sessions = new Set<CopilotSession>();
  const requests: { marker: string; attachmentContent: boolean; closed: boolean }[] = [];
  const mockErrors: string[] = [];
  const held = new Map<string, { response: ServerResponse; release: () => void }>();
  let runtime: import('./runtime.ts').OfficialRuntime | undefined;
  let engine: import('./engine.ts').Engine | undefined;
  let nativeClient: CopilotClient | undefined;
  let answerQuestion: (() => void) | undefined;
  const timeoutEvidence: Record<string, unknown> = {};
  const timeoutChecks: string[] = [];
  const integrationEvidence: Record<string, unknown> = {};
  let created = 0;
  let resumed = 0;
  let passiveEvents = 0;
  let abortSettlement = '';
  let attachmentEvents = 0;
  let authStatus: GetAuthStatusResponse | undefined;
  let deletion: { sessionId: string; persistedHistory: string } | undefined;
  let passed = false;
  const sample = (cycle: number, phase: string, pid: number) => {
    samples.push({ cycle, phase, hostRssKiB: rssKiB(process.pid), runtimePid: pid, runtimeRssKiB: rssKiB(pid) });
  };
  const terminateOwnedRuntime = (pid: number) => {
    assert.notEqual(pid, 1526380);
    assert.ok(owned.has(pid) && runtimeChildren().includes(pid), 'Only a recorded direct native child may be killed');
    assert.equal(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19], owned.get(pid),
      'PID start time must still match the child whose ownership was verified');
    assert.equal(readlinkSync(`/proc/${pid}/cwd`), dirs.work);
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    assert.ok(argv.includes('--headless') && argv.includes('--no-auto-update'));
    process.kill(pid, 'SIGKILL');
  };
  const attachmentToken = 'synthetic-native-attachment-42';
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      assert.ok(req.headers.authorization === undefined || req.headers.authorization.trim() === 'Bearer',
        'Only the SDK empty Bearer header is allowed; no credentials may reach even the mock');
      let text = '';
      for await (const part of req) {
        text += part;
        assert.ok(text.length < 1_000_000, 'Unexpectedly large synthetic request');
      }
      const body = JSON.parse(text) as {
        model: string; stream?: boolean;
        messages: { role: string; content?: unknown; tool_calls?: unknown[] }[];
        tools?: { function: { name: string; parameters?: {
          properties?: Record<string, { enum?: string[] }>; required?: string[];
        } } }[];
      };
      assert.equal(body.model, 'gpt-4.1');
      const lastUser = body.messages.findLastIndex((message) => message.role === 'user');
      const marker = text.includes('SMOKE_FATALCOMPACT') ? 'SMOKE_FATALCOMPACT'
        : JSON.stringify(body.messages[lastUser]?.content).match(/SMOKE_[A-Z]+/)?.[0];
      assert.ok(marker && ['SMOKE_ACCEPTED', 'SMOKE_ATTACHMENT', 'SMOKE_EDIT', 'SMOKE_ABORT',
        'SMOKE_RECOVERY', 'SMOKE_RESUME', 'SMOKE_REPEAT', 'SMOKE_BUSY', 'SMOKE_QUESTION',
        'SMOKE_SCHEDULE', 'SMOKE_SCHEDULED', 'SMOKE_ENGINE', 'SMOKE_ENGINEAGAIN', 'SMOKE_ENGINEFIRST',
        'SMOKE_FATALPREP', 'SMOKE_FATALBUSY', 'SMOKE_FATALQUEUED', 'SMOKE_FATALCOMPACT', 'SMOKE_BACKGROUND'].includes(marker),
      'Only synthetic prompts are allowed');
      const record = { marker, attachmentContent: text.includes(attachmentToken), closed: false };
      requests.push(record);
      res.on('close', () => { record.closed = true; });
      const alreadyCalled = body.messages.slice(lastUser + 1).some((message) =>
        message.role === 'tool' || message.tool_calls?.length);
      const edit = marker === 'SMOKE_EDIT' && !alreadyCalled;
      const view = marker === 'SMOKE_ATTACHMENT' && !alreadyCalled;
      const question = marker === 'SMOKE_QUESTION' && !alreadyCalled;
      const schedule = marker === 'SMOKE_SCHEDULE' && !alreadyCalled;
      const background = marker === 'SMOKE_BACKGROUND' && !alreadyCalled;
      const toolName = edit ? 'edit' : question ? 'ask_user' : schedule ? 'manage_schedule' : background ? 'bash' : 'view';
      const tool = body.tools?.find(({ function: fn }) => fn.name === toolName || fn.name.endsWith(`__${toolName}`));
      if (edit || view || question || schedule || background) assert.ok(tool, `Native ${toolName} tool must be advertised`);
      if (background) {
        const schema = tool!.function.parameters;
        assert.ok(schema?.properties, 'Native bash must advertise its parameter schema');
        const modes = schema.properties.mode?.enum;
        assert.ok(modes?.includes('async'), 'Native bash must advertise asynchronous execution');
        timeoutEvidence.backgroundToolSchema = {
          name: tool!.function.name, properties: Object.keys(schema.properties), required: schema.required,
          modes,
        };
      }
      if (view) assert.ok(JSON.stringify(body.messages).includes(join(dirs.work!, 'attachment.txt')),
        'Native file attachments carry a reference; view must resolve their bytes');
      const toolCall = edit || view || question || schedule || background ? {
        id: `call_smoke_${requests.length}`, type: 'function',
        function: { name: tool!.function.name, arguments: JSON.stringify(edit ? {
          path: join(dirs.work!, 'rewind.txt'), old_str: 'before\n', new_str: 'after\n',
        } : question ? {
          question: 'Synthetic SMOKE_QUESTION?', choices: ['fixture answer'],
        } : schedule ? {
          action: 'create', interval: '1h', prompt: 'SMOKE_SCHEDULED',
        } : background ? {
          command: '/usr/bin/sleep 5', mode: 'async', description: 'Synthetic fixture sleep',
        } : { path: join(dirs.work!, 'attachment.txt') }) },
      } : undefined;
      const answer = `deterministic ${marker} done`;
      const id = `chatcmpl-smoke-${requests.length}`;
      const release = () => {
        res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
        if (body.stream) {
          const chunk = (delta: object, finish_reason: string | null = null) =>
            `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model,
              choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          res.write(chunk({ role: 'assistant', ...(toolCall
            ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: answer }) }));
          res.write(chunk({}, toolCall ? 'tool_calls' : 'stop'));
          res.end('data: [DONE]\n\n');
        } else {
          res.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: toolCall ? null : answer,
              ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        }
      };
      if (['SMOKE_ACCEPTED', 'SMOKE_ABORT', 'SMOKE_BUSY', 'SMOKE_FATALBUSY', 'SMOKE_FATALCOMPACT'].includes(marker)) {
        held.set(marker, { response: res, release });
      }
      else release();
    } catch (error) {
      mockErrors.push(String(error));
      res.writeHead(500).end('{"error":{"message":"synthetic smoke mock rejected request"}}');
    }
  });
  try {
    for (const dir of Object.values(dirs)) mkdirSync(dir, { mode: 0o700 });
    const env = {
      HOME: dirs.home!, COPILOT_HOME: dirs.state!, XDG_CONFIG_HOME: dirs.config!,
      XDG_STATE_HOME: dirs['xdg-state']!, XDG_CACHE_HOME: dirs.cache!, XDG_RUNTIME_DIR: dirs.run!,
      TMPDIR: dirs.scratch!, TMP: dirs.scratch!, TEMP: dirs.scratch!,
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', COPILOT_DISABLE_KEYTAR: '1',
      COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', TSX_DISABLE_CACHE: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config!, 'gitconfig'),
      GIT_CEILING_DIRECTORIES: fixture,
    };
    // Import only after replacing ambient auth, parent-session and configuration context.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    process.chdir(dirs.work!);
    const { CopilotClient, RuntimeConnection, approveAll } = await import('@github/copilot-sdk');
    const { OfficialRuntime } = await import('./runtime.ts');
    await bounded(new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    }));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const sessionConfig: Partial<SessionConfig> = {
      model: 'gpt-4.1',
      provider: { type: 'openai', wireApi: 'completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'gpt-4.1' },
      workingDirectory: dirs.work, configDirectory: dirs.state,
      enableConfigDiscovery: true, skipCustomInstructions: true, enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false, enableHostGitOperations: false, enableSessionStore: false, enableSkills: false,
      skillDirectories: [], pluginDirectories: [], instructionDirectories: [], customAgents: [],
      enableManagedSettings: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
      enableSessionTelemetry: false, remoteSession: 'off', streaming: true,
      enableFileChangeTracking: true, enableExperimentalMode: true, availableTools: ['edit', 'view'],
      systemMessage: { mode: 'replace', content: 'Synthetic fixture only. Use only the supplied fixture paths.' },
    };
    const clientOptions = {
      connection: RuntimeConnection.forStdio({ env }), mode: 'empty' as const,
      baseDirectory: dirs.state, workingDirectory: dirs.work, builtinPluginDirectories: [],
      useLoggedInUser: false, enableRemoteSessions: false, logLevel: 'error' as const,
      // BYOK inventory is host-owned: never ask GitHub for authenticated inventory.
      onListModels: () => [],
    };
    const ownRuntime = () => {
      const pids = runtimeChildren();
      assert.equal(pids.length, 1, 'Exactly one explicit stdio runtime must be owned');
      const pid = pids[0]!;
      assert.notEqual(pid, 1526380);
      owned.set(pid, readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19]!);
      assert.equal(readlinkSync(`/proc/${pid}/cwd`), dirs.work);
      const actualEnv = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
        .filter(Boolean).map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
      for (const [key, value] of Object.entries(env)) assert.equal(actualEnv[key], value, key);
      assert.ok(!Object.keys(actualEnv).some((key) => /TOKEN|SECRET|SESSION|PARENT|PROXY|ENDPOINT|API_KEY/.test(key)));
      return pid;
    };
    runtime = new OfficialRuntime({ clientOptions, sessionConfig });
    const start = async (cycle: number) => {
      await bounded(runtime!.start());
      const pid = ownRuntime();
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      assert.equal(argv[argv.indexOf('--session-idle-timeout') + 1], '1800', 'Default idle option must reach the native binary');
      assert.equal(runtime!.liveCount, 0);
      sample(cycle, 'started', pid);
      return pid;
    };
    const create = async (events: SessionEvent[] = []) => {
      const session = await bounded(runtime!.createSession({ onEvent: (event) => events.push(event) }));
      sessions.add(session);
      created++;
      return session;
    };
    const close = async (session: CopilotSession) => {
      await bounded(runtime!.closeSession(session));
      sessions.delete(session);
      assert.equal((await bounded(runtime!.rpc.sessions.open({ kind: 'attach', sessionId: session.sessionId }))).status, 'not_found');
    };
    const stop = async (cycle: number, pid: number) => {
      sample(cycle, 'closed-before-stop', pid);
      await bounded(runtime!.stop());
      const errors: Error[] = [];
      await eventually(() => !existsSync(`/proc/${pid}`), 'stop acknowledgement must be followed by actual PID exit');
      stops.push({ pid, errors: errors.map((error) => error.message), exited: true });
      assert.deepEqual(errors, []);
      assert.equal(runtime!.liveCount, 0);
      sample(cycle, 'stopped', pid);
    };
    const firstPid = await start(0);
    const defaultArgv = readFileSync(`/proc/${firstPid}/cmdline`, 'utf8').split('\0');
    assert.equal(defaultArgv[defaultArgv.indexOf('--session-idle-timeout') + 1], '1800');
    assert.deepEqual(await bounded(runtime.listSessions()), []);
    assert.deepEqual(await bounded(runtime.models()), []);
    authStatus = await bounded(runtime.getAuthStatus());
    assert.equal(authStatus.isAuthenticated, false);
    assert.equal(authStatus.login, undefined);
    assert.equal(requests.length, 0);
    checks.push('isolated startup, public unauthenticated status and host-owned BYOK inventory');

    writeFileSync(join(dirs.work!, 'attachment.txt'), `${attachmentToken}\n`);
    writeFileSync(join(dirs.work!, 'rewind.txt'), 'before\n');
    const eventsA: SessionEvent[] = [];
    const a = await create(eventsA);
    const b = await create();
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(runtime.liveCount, 2);
    const accepted = await bounded(a.send({ prompt: 'SMOKE_ACCEPTED' }));
    assert.ok(typeof accepted === 'string' && accepted.length > 0);
    await eventually(() => held.has('SMOKE_ACCEPTED'), 'Accepted turn must reach the loopback mock');
    assert.ok(!eventsA.some((event) => event.type === 'session.idle' || event.type === 'assistant.message'));
    held.get('SMOKE_ACCEPTED')!.release();
    await eventually(() => eventsA.some((event) => event.type === 'session.idle'), 'Accepted send must settle through idle');
    assert.ok(eventsA.some((event) => event.type === 'assistant.message' && event.data.content === 'deterministic SMOKE_ACCEPTED done'));
    const attachment = await bounded(b.sendAndWait({ prompt: 'SMOKE_ATTACHMENT',
      attachments: [{ type: 'file', path: join(dirs.work!, 'attachment.txt'), displayName: 'attachment.txt' }],
    }, 10_000));
    assert.equal(attachment?.data.content, 'deterministic SMOKE_ATTACHMENT done');
    assert.ok(requests.some((request) => request.marker === 'SMOKE_ATTACHMENT' && request.attachmentContent));
    const attachmentHistory = await bounded(b.getEvents());
    attachmentEvents = attachmentHistory.filter((event) =>
      event.type === 'user.message' && JSON.stringify(event.data).includes('attachment.txt')).length;
    assert.equal(attachmentEvents, 1, 'Native attachment must be preserved in session events');
    const listed = await bounded(runtime.listSessions());
    assert.ok([a, b].every((session) => listed.some((row) => row.sessionId === session.sessionId)));
    assert.equal((await bounded(a.rpc.model.getCurrent())).modelId, 'gpt-4.1');
    assert.notEqual((await bounded(runtime.rpc.sessions.open({ kind: 'attach', sessionId: b.sessionId }))).status, 'not_found');
    sample(0, 'two-live-sessions', firstPid);
    checks.push('two native sessions, accepted send, file attachment and native BYOK model');

    await bounded(a.sendAndWait('SMOKE_EDIT', 10_000));
    assert.equal(readFileSync(join(dirs.work!, 'rewind.txt'), 'utf8'), 'after\n');
    const editEvent = (await bounded(a.getEvents())).findLast((event) =>
      event.type === 'user.message' && event.data.content.includes('SMOKE_EDIT'));
    assert.ok(editEvent);
    const preview = await bounded(a.rpc.history.previewRewind({ eventId: editEvent.id }));
    assert.ok(preview.available && preview.fileCount === 1);
    const rewind = await bounded(a.rpc.history.rewind({ eventId: editEvent.id, mode: 'conversation-and-files' }));
    assert.equal(rewind.outcome, 'success');
    assert.equal(readFileSync(join(dirs.work!, 'rewind.txt'), 'utf8'), 'before\n');
    assert.ok(!(await bounded(a.getEvents())).some((event) => event.id === editEvent.id));
    checks.push('official approval, native edit and exact file/conversation rollback');

    let settled = false;
    const turn = b.sendAndWait('SMOKE_ABORT', 10_000).then((answer) => {
      settled = true;
      return { status: 'resolved' as const, answer };
    }, (error: unknown) => { settled = true; throw error; });
    void turn.catch(() => {});
    await eventually(() => held.has('SMOKE_ABORT'), 'Abort fixture must be in flight');
    assert.equal(settled, false);
    const queued = await bounded(b.send({ prompt: 'SMOKE_QUEUED', mode: 'enqueue' }));
    assert.ok((await bounded(b.rpc.queue.pendingItems())).items.some((item) => item.messageId === queued));
    await bounded(b.abort());
    const settlement = await bounded(turn, 5_000);
    assert.equal(settlement.answer, undefined);
    abortSettlement = 'resolved undefined';
    assert.equal((await bounded(b.rpc.queue.pendingItems())).items.length, 0);
    held.get('SMOKE_ABORT')!.response.destroy();
    checks.push('abort acknowledgement, queued accepted ID and sendAndWait settlement');

    await close(a);
    assert.equal(runtime.liveCount, 1);
    assert.equal((await bounded(b.sendAndWait('SMOKE_RECOVERY', 10_000)))?.data.content, 'deterministic SMOKE_RECOVERY done');
    assert.deepEqual(runtimeChildren(), [firstPid], 'Closing A must not recycle B');
    await close(b);
    assert.equal(runtime.liveCount, 0);
    await stop(0, firstPid);
    checks.push('safe close preserves peer, adapter checks SDK stop Error[] and runtime actually exits');

    const secondPid = await start(1);
    assert.notEqual(secondPid, firstPid);
    const requestCount = requests.length;
    for (const session of [a, b]) {
      const sessionId = session.sessionId;
      const log = join(dirs.state!, 'session-state', sessionId, 'events.jsonl');
      const before = readFileSync(log);
      const mtime = statSync(log).mtimeMs;
      assert.equal((await bounded(runtime.rpc.sessions.open({ kind: 'attach', sessionId }))).status, 'not_found');
      const first: PersistedPage = await bounded(runtime.rpc.sessions.readPersistedEvents({ sessionId, max: 2, direction: 'backward' }));
      assert.equal(first.events.length, 2);
      assert.ok(first.hasMore && first.cursor);
      const second: PersistedPage = await bounded(runtime.rpc.sessions.readPersistedEvents({
        sessionId, cursor: first.cursor, max: 2, direction: 'backward',
      }));
      assert.equal(second.events.length, 2);
      assert.ok(second.events.every((event) => !first.events.some((previous) => previous.id === event.id)));
      passiveEvents += first.events.length + second.events.length;
      assert.equal((await bounded(runtime.rpc.sessions.open({ kind: 'attach', sessionId }))).status, 'not_found');
      assert.equal(statSync(log).mtimeMs, mtime);
      assert.deepEqual(readFileSync(log), before);
    }
    assert.equal(runtime.liveCount, 0);
    assert.equal(requests.length, requestCount);
    sample(1, 'cold-passive-read', secondPid);
    checks.push('cold cursor paging loads no native sessions, mutates no journals and performs no inference');

    const { Engine } = await import('./engine.ts');
    engine = new Engine({ runtime });
    await bounded(engine.start());
    const snapshot = (await engine.snapshot());
    assert.equal(snapshot.permissionPolicy, 'allow-all');
    assert.deepEqual(snapshot.models, []);
    assert.ok(snapshot.sessions.some(session => session.sessionId === a.sessionId));
    const page = await nativeChat(engine, a.sessionId, { direction: 'forward', max: 256 });
    assert.ok(page.events.some(event => event.type === 'user.message' && event.data.content === 'SMOKE_ACCEPTED'), JSON.stringify(page));
    assert.deepEqual(page.read, { rpc: 1, events: page.events.length });
    assert.equal(runtime.liveCount, 0, 'Engine native chat must remain passive');
    assert.equal(requests.length, requestCount);
    await assert.rejects(bounded(engine.getPlan(a.sessionId)), /unavailable while unloaded/);
    assert.equal(runtime.liveCount, 0);
    assert.equal((await bounded(engine.prompt(a.sessionId, 'SMOKE_RESUME'))).ok, true);
    resumed++;
    assert.equal((await engine.getMeta(a.sessionId))?.currentModelId, 'gpt-4.1');
    assert.equal(runtime.liveCount, 1);
    await bounded(engine.getPlan(a.sessionId));
    await eventually(async () => {
      const meta = await engine!.getMeta(a.sessionId);
      return meta?.status === 'idle' && !meta.activeOperations;
    }, 'Engine native turn must settle');
    const attachmentRequests = requests.length;
    await bounded(engine.prompt(a.sessionId, 'SMOKE_ATTACHMENT', 'enqueue', [
      { type: 'file', path: join(dirs.work!, 'attachment.txt'), displayName: 'native fixture' },
    ]));
    await eventually(async () => {
      const meta = await engine!.getMeta(a.sessionId);
      return meta?.status === 'idle' && !meta.activeOperations;
    }, 'Engine native attachment turn must settle');
    assert.ok(requests.slice(attachmentRequests).some(request => request.attachmentContent),
      'Engine must forward the native file reference; the native view tool reads the synthetic bytes');
    integrationEvidence.nativeAttachment = { type: 'file', nativeViewRead: true, managedFileService: false };
    await bounded(engine.unload(a.sessionId));
    assert.equal('unreadCount' in await engine.snapshot(), false);
    checks.push('real Engine snapshot, passive history, native resume/prompt/state/close');

    await t.test('native request-scoped chat preserves all mixed legacy events through bounded typed pages without server folding', async t => {
      const adapter = runtime!;
      const beforeRequests = requests.length;
      const synthetic = await create();
      const source = (await bounded(synthetic.getEvents())).filter(event => !event.ephemeral);
      await bounded(adapter.rpc.sessions.save({ sessionId: synthetic.sessionId }));
      await close(synthetic);
      let preceding = source.at(-1)?.id ?? null;
      const append = (type: SessionEvent['type'], data: object, agentId?: string) => {
        const native = { type, data, id: randomUUID(), parentId: preceding,
          timestamp: new Date(Date.now() - 86_400_000 + source.length).toISOString(),
          ...(agentId ? { agentId } : {}) } as SessionEvent;
        preceding = native.id;
        source.push(native);
        return native;
      };
      const outer = randomUUID(), inner = randomUUID(), outerAgent = randomUUID(), innerAgent = randomUUID();
      const life = (toolCallId: string) => ({
        toolCallId, agentName: 'fixture', agentDisplayName: 'Synthetic nested fixture', agentDescription: 'No execution',
      });
      append('assistant.message', { messageId: randomUUID(), content: '', toolRequests: [
        { toolCallId: outer, name: 'task', arguments: { prompt: 'Synthetic outer task prompt'.repeat(1000) } },
      ] });
      append('subagent.started', life(outer), outerAgent);
      // No lifecycle parentId: this legacy child request is the ONLY parent link.
      append('assistant.message', { messageId: randomUUID(), content: '', parentToolCallId: outerAgent,
        toolRequests: [{ toolCallId: inner, name: 'task', arguments: { prompt: 'Synthetic inner task prompt'.repeat(1000) } }] });
      append('subagent.started', life(inner), innerAgent);
      const edit = randomUUID();
      append('assistant.message', { messageId: randomUUID(), content: '', toolRequests: [
        { toolCallId: edit, name: 'edit', arguments: { path: 'synthetic-agent-path.ts', old_str: 'a', new_str: 'b' } },
      ] });
      for (let turn = 0; turn < 220; turn++) {
        append('user.message', { content: `Synthetic root turn ${turn}`, parentAgentTaskId: 'telemetry-not-ownership' });
        for (let child = 0; child < 4; child++) {
          append('assistant.message', { messageId: randomUUID(), content: 'Synthetic nested payload '.repeat(200),
            ...(child % 2 ? { parentToolCallId: innerAgent } : {}) }, child % 2 ? undefined : innerAgent);
        }
        append('assistant.message', { messageId: randomUUID(), content: `Synthetic root answer ${turn}` });
        append('hook.end', { hookInvocationId: randomUUID(), hookType: 'postToolUse',
          success: true, output: 'Ignored hook data '.repeat(200) });
      }
      append('tool.execution_complete', { toolCallId: edit, success: true, result: { content: 'synthetic result' } });
      append('subagent.completed', life(inner), innerAgent);
      append('subagent.completed', life(outer), outerAgent);
      const log = join(dirs.state!, 'session-state', synthetic.sessionId, 'events.jsonl');
      writeFileSync(log, source.map(event => JSON.stringify(event)).join('\n') + '\n');
      const proof = new Engine({ runtime: adapter });
      await bounded(proof.refreshList());
      let nativeSnapshot!: () => Promise<SessionEvent[]>;
      const pages: { events: number; bytes: number; direction: string }[] = [];
      const serverChatEvents: string[] = [];
      const off = proof.onEvent(event => {
        if (['msg/upsert', 'session/reset', 'session/history-page'].includes(event.type)) serverChatEvents.push(event.type);
      });
      const resume = adapter.resumeSession.bind(adapter);
      const observing = t.mock.method(adapter, 'resumeSession', async (...[id, config]: Parameters<typeof resume>) => {
        assert.equal(id, synthetic.sessionId);
        assert.equal(typeof config?.onEvent, 'function');
        const sdk = await resume(id, { ...config, continuePendingWork: false });
        nativeSnapshot = sdk.getEvents.bind(sdk);
        t.mock.method(sdk, 'getEvents', async () => assert.fail('Active initialization must not request a full journal'));
        t.mock.method(sdk, 'send', async () => assert.fail('Display initialization must not send'));
        t.mock.method(sdk, 'abort', async () => assert.fail('Display initialization must not abort'));
        const read = sdk.rpc.eventLog.read.bind(sdk.rpc.eventLog);
        t.mock.method(sdk.rpc.eventLog, 'read', async (params: Parameters<typeof read>[0]) => {
          assert.equal(params.agentScope, 'all', 'Only the requested shared native chat window is read');
          assert.equal(params.includeEphemeral, false);
          assert.notEqual(params.types, '*');
          assert.ok(params.max! <= 64);
          const page = await read(params);
          pages.push({ events: page.events.length, bytes: Buffer.byteLength(JSON.stringify(page)), direction: params.direction! });
          return page;
        });
        return sdk;
      });
      try {
        await bounded(proof.reload(synthetic.sessionId));
        const state = (proof as unknown as { sessions: Map<string, Record<string, unknown>> })
          .sessions.get(synthetic.sessionId)!;
        for (const key of ['fold', 'eventIds', 'userMessageIds']) assert.equal(key in state, false);
        assert.equal(pages.length, 0, 'Initialization never prewarms chat');
        const initializationReads = pages.length;
        const raw = await bounded(nativeSnapshot());
        const expected = raw.filter(event => !event.ephemeral && CHAT_EVENT_TYPES.includes(event.type));
        const baselineBytes = Buffer.byteLength(JSON.stringify(raw));
        const collected: Awaited<ReturnType<typeof nativeChat>>['events'] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let request = 0; ; request++) {
          assert.ok(request <= raw.length, 'Native paging must terminate without chasing or restarting history');
          const before: number = pages.length;
          const page = await nativeChat(proof, synthetic.sessionId, {
            source: 'live', direction: 'forward', includeEphemeral: false, max: 64, cursor,
          });
          assert.equal(page.cursorStatus, 'ok');
          assert.equal(pages.length, before + 1, 'Exactly one native read per explicit caller page');
          assert.deepEqual(page.read, { rpc: 1, events: page.events.length });
          assert.ok(page.events.length <= 64);
          for (const event of page.events) {
            assert.equal(seen.has(event.id), false, 'Opaque cursors cannot duplicate an event across pages');
            seen.add(event.id);
          }
          assert.ok(page.events.every(event => CHAT_EVENT_TYPES.includes(event.type)));
          collected.push(...page.events);
          if (!page.hasMore) break;
          assert.notEqual(page.cursor, cursor);
          cursor = page.cursor;
        }
        assert.deepEqual(collected, expected, 'Compare every native display event, including legacy child ownership and payloads');
        const legacySpawn = source.find(event => event.type === 'assistant.message'
          && event.data.parentToolCallId === outerAgent
          && event.data.toolRequests?.some(request => request.toolCallId === inner));
        assert.ok(legacySpawn);
        assert.deepEqual(collected.find(event => event.id === legacySpawn.id), legacySpawn);
        assert.equal(collected.filter(event => event.type === 'assistant.message'
          && (event.agentId === innerAgent || event.data.parentToolCallId === innerAgent)).length, 880);
        assert.equal('changedFiles' in await bounded(proof.getPlan(synthetic.sessionId)), false);
        const chatPages = pages.slice(initializationReads);
        const transferredBytes = chatPages.reduce((sum, page) => sum + page.bytes, 0);
        assert.ok(chatPages.length > 5);
        assert.ok(chatPages.every(page => page.events <= 64 && page.bytes < baselineBytes));
        assert.ok(transferredBytes < baselineBytes, 'Native type filtering excludes hook payloads, not child structure');
        assert.deepEqual(serverChatEvents, []);
        assert.equal('fold' in state, false, 'Explicit reads must not create a persistent Engine projection');
        integrationEvidence.nativeChat = { baselineEvents: raw.length, baselineBytes,
          transferredBytes, chatEvents: collected.length, pages: chatPages, initializationReads,
          completeNativeEventsEqual: true, noServerProjection: true,
          legacyParentlessNestingPreserved: true, modelRequests: requests.length - beforeRequests };
        assert.equal(requests.length, beforeRequests);
      } finally {
        off();
        observing.mock.restore();
        await bounded(proof.unload(synthetic.sessionId));
      }
    });
    assert.ok(integrationEvidence.nativeChat, 'Complete bounded native event paging proof must pass before reporting success');

    const repeat = await create();
    assert.equal((await bounded(repeat.sendAndWait('SMOKE_REPEAT', 10_000)))?.data.content, 'deterministic SMOKE_REPEAT done');
    sample(1, 'engine-resumed-and-repeat', secondPid);
    await assert.rejects(runtime.deleteSession(repeat.sessionId), /live session/);
    await close(repeat);
    assert.ok((await bounded(runtime.listSessions())).some(session => session.sessionId === repeat.sessionId));
    assert.ok((await bounded(runtime.rpc.sessions.readPersistedEvents({ sessionId: repeat.sessionId, max: 2 }))).events.length > 0);
    await bounded(runtime.deleteSession(repeat.sessionId));
    await bounded(runtime.deleteSession(repeat.sessionId));
    assert.ok(!(await bounded(runtime.listSessions())).some(session => session.sessionId === repeat.sessionId));
    const persistedHistory = await bounded(runtime.rpc.sessions.readPersistedEvents({
      sessionId: repeat.sessionId, max: 2,
    })).then(page => {
      assert.deepEqual(page.events, []);
      assert.equal(page.hasMore, false);
      return 'empty';
    }, (error: unknown) => {
      assert.match(String(error), /session.*(?:not found|does not exist)|ENOENT/i);
      return 'unavailable';
    });
    deletion = { sessionId: repeat.sessionId, persistedHistory };
    assert.ok((await bounded(runtime.listSessions())).some(session => session.sessionId === a.sessionId));
    checks.push('public deletion of only the safely closed synthetic repeat session removes listing and persisted history');
    await stop(1, secondPid);
    await bounded(engine.stop());
    assert.deepEqual(mockErrors, []);
    assert.equal(owned.size, 2);
    checks.push('second resume/create/send/close/stop cycle releases all native processes and wrappers');

    nativeClient = new CopilotClient({ ...clientOptions, sessionIdleTimeoutSeconds: 1 });
    const lifecycle: { type: string; sessionId: string; ms: number }[] = [];
    const epoch = Date.now();
    nativeClient.onLifecycle(event => lifecycle.push({ type: event.type, sessionId: event.sessionId, ms: Date.now() - epoch }));
    await bounded(nativeClient.start());
    const nativePid = ownRuntime();
    timeoutEvidence.version = await bounded(nativeClient.getStatus());
    assert.deepEqual(timeoutEvidence.version, { version: '1.0.83', protocolVersion: 3 });
    assert.ok(readFileSync(`/proc/${nativePid}/cmdline`, 'utf8').split('\0')
      .some((arg, i, args) => arg === '--session-idle-timeout' && args[i + 1] === '1'));
    const nativeConfig = { ...sessionConfig, onPermissionRequest: approveAll };
    const attach = (session: CopilotSession) =>
      bounded(nativeClient!.rpc.sessions.open({ kind: 'attach', sessionId: session.sessionId }));
    const assertClosed = async (session: CopilotSession) => {
      assert.equal((await attach(session)).status, 'not_found');
      await assert.rejects(bounded(session.getEvents()), /session.getMessages.*Session not found/);
    };
    const idleEvents: SessionEvent[] = [];
    const idle = await bounded(nativeClient.createSession({
      ...nativeConfig, onEvent: event => idleEvents.push(event),
    }));
    const idleCreated = Date.now();
    // Native shutdown notifications are not guaranteed; attach is a passive probe.
    const idleDeadline = Date.now() + 5_000;
    while ((await attach(idle)).status !== 'not_found' && Date.now() < idleDeadline) await sleep(25);
    const idleShutdown = idleEvents.find(event => event.type === 'session.shutdown');
    if (idleShutdown) assert.equal(idleShutdown.data.shutdownType, 'routine');
    await assertClosed(idle);
    const beforeStaleSend = requests.length;
    await assert.rejects(bounded(idle.send('SMOKE_REPEAT')), /Session not found/);
    assert.equal(requests.length, beforeStaleSend);
    const emptySessionListed = (await bounded(nativeClient.listSessions())).some(row => row.sessionId === idle.sessionId);
    assert.equal(emptySessionListed, false, 'Native listing omits untouched empty sessions');
    const idleLifecycle = lifecycle.filter(event => event.sessionId === idle.sessionId);
    assert.ok(idleLifecycle.some(event => event.type === 'session.created'));
    assert.ok(idleLifecycle.every(event => ['session.created', 'session.updated'].includes(event.type)));
    timeoutEvidence.idle = {
      waitedMs: Date.now() - idleCreated, sessionId: idle.sessionId,
      shutdownType: idleShutdown?.data.shutdownType ?? 'notification omitted', lifecycle: idleLifecycle,
      staleGetEventsAndSend: 'Session not found', emptySessionListed,
    };
    await assert.rejects(bounded(nativeClient.resumeSession(idle.sessionId, nativeConfig)), /Session not found/);
    timeoutChecks.push('1s option reaches native argv; routine shutdown, update-only lifecycle, untouched empty sessions are not resumable');

    const backgroundEvents: SessionEvent[] = [];
    const background = await bounded(nativeClient.createSession({
      ...nativeConfig, availableTools: ['bash'], onEvent: event => backgroundEvents.push(event),
    }));
    await bounded(background.send('SMOKE_BACKGROUND'));
    await eventually(() => backgroundEvents.some(event => event.type === 'assistant.message'
      && event.data.content === 'deterministic SMOKE_BACKGROUND done'), 'Native async tool must return to the model');
    const backgroundResult = backgroundEvents.find(event => event.type === 'tool.execution_complete');
    assert.ok(backgroundResult?.data.success, 'The advertised native bash tool must successfully start work');
    assert.match(backgroundResult.data.result?.content ?? '', /command started in background/);
    const backgroundTasks = (await bounded(background.rpc.tasks.list())).tasks;
    timeoutEvidence.backgroundTasks = backgroundTasks;
    const backgroundTask = backgroundTasks.find(task => task.type === 'shell' && task.command === '/usr/bin/sleep 5');
    assert.ok(backgroundTask && backgroundTask.type === 'shell', 'A real native shell must register in tasks.list');
    assert.equal(backgroundTask.status, 'running');
    assert.equal(backgroundTask.executionMode, 'background');
    assert.equal(backgroundTask.attachmentMode, 'attached', 'Do not detach or install a compensating task manager');
    assert.ok(backgroundTask.pid);
    const shellPid = backgroundTask.pid;
    assert.notEqual(shellPid, 1526380);
    const shellStat = readFileSync(`/proc/${shellPid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    assert.equal(Number(shellStat[1]), nativePid, 'The native shell must be an owned runtime child');
    assert.equal(readlinkSync(`/proc/${shellPid}/cwd`), dirs.work);
    assert.equal(readlinkSync(`/proc/${shellPid}/exe`), '/usr/bin/sleep');
    assert.deepEqual(readFileSync(`/proc/${shellPid}/cmdline`, 'utf8').split('\0').filter(Boolean), ['/usr/bin/sleep', '5']);
    ownedShells.set(shellPid, shellStat[19]!);
    const backgroundObservationStarted = Date.now();
    let closedAt: number | undefined;
    let shellExitedAt: number | undefined;
    // Observe only passive attach and fixture process existence after the one tasks.list.
    while (Date.now() - backgroundObservationStarted < 6_000) {
      if ((await attach(background)).status === 'not_found') closedAt ??= Date.now();
      if (!existsSync(`/proc/${shellPid}`)) shellExitedAt ??= Date.now();
      if (closedAt && shellExitedAt) break;
      await sleep(100);
    }
    assert.ok(shellExitedAt, 'The bounded native sleep must exit without host cancellation');
    assert.ok(closedAt && closedAt < shellExitedAt, 'Native idle cleanup closes the session before its real background shell exits');
    assert.ok(shellExitedAt - Date.parse(backgroundTask.startedAt) >= 4_500,
      'The synthetic 5s process outlives session shutdown instead of being killed at idle expiry');
    await assert.rejects(bounded(background.rpc.tasks.list()), /session.tasks.list.*Session not found/,
      'Task tracking becomes inaccessible after native session cleanup');
    assert.equal(requests.filter(request => request.marker === 'SMOKE_BACKGROUND').length, 2,
      'Only the initial tool call and final model reply may run');
    assert.deepEqual(runtimeChildren(), [nativePid]);
    timeoutEvidence.background = {
      sessionId: background.sessionId, taskId: backgroundTask.id, shellPid,
      outcome: 'session closes while attached background shell continues; task RPC becomes unavailable',
      toolResult: backgroundResult.data.result?.content,
      observationMs: Date.now() - backgroundObservationStarted,
      closedAfterMs: closedAt - backgroundObservationStarted,
      shellExitedAfterMs: shellExitedAt - backgroundObservationStarted,
      shutdownNotifications: backgroundEvents.filter(event => event.type === 'session.shutdown').length,
      sessionScopedPollsDuringObservation: 0,
    };
    timeoutChecks.push('real native async shell is tracked but does not prevent idle close; process outlives session and task RPC becomes unavailable');

    const cases: {
      name: string; session: CopilotSession; events: { type: string; ms: number }[];
      poll?: () => Promise<unknown>; polls: number; error?: string;
    }[] = [];
    const makeCase = async (name: string, config: Partial<SessionConfig> = {}) => {
      const events: { type: string; ms: number }[] = [];
      const session = await bounded(nativeClient!.createSession({
        ...nativeConfig, ...config,
        onEvent: event => events.push({ type: event.type, ms: Date.now() - epoch }),
      }));
      const probe = { name, session, events, polls: 0 } as typeof cases[number];
      cases.push(probe);
      return probe;
    };
    const busy = await makeCase('busy');
    await bounded(busy.session.send('SMOKE_BUSY'));
    await eventually(() => held.has('SMOKE_BUSY'), 'Busy native prompt must reach loopback mock');
    assert.equal((await bounded(busy.session.rpc.metadata.isProcessing())).processing, true);
    const question = await makeCase('question', {
      availableTools: ['ask_user'],
      onUserInputRequest: (request, invocation) => new Promise(resolve => {
        assert.equal(request.question, 'Synthetic SMOKE_QUESTION?');
        assert.equal(invocation.sessionId, question.session.sessionId);
        answerQuestion = () => resolve({ answer: 'fixture answer', wasFreeform: false });
      }),
    });
    await bounded(question.session.send('SMOKE_QUESTION'));
    await eventually(() => !!answerQuestion, 'Native question must reach public input handler');
    assert.equal((await bounded(question.session.rpc.metadata.isProcessing())).processing, true);
    const scheduledEvents: SessionEvent[] = [];
    const scheduled = await bounded(nativeClient.createSession({
      ...nativeConfig, manageScheduleEnabled: true,
      availableTools: ['manage_schedule'], onEvent: event => scheduledEvents.push(event),
    }));
    await bounded(scheduled.sendAndWait('SMOKE_SCHEDULE', 10_000));
    const scheduleToolResult = scheduledEvents.find(event => event.type === 'tool.execution_complete');
    assert.ok(scheduleToolResult && !scheduleToolResult.data.success);
    assert.match(scheduleToolResult.data.error?.message ?? '', /session.schedule.add.*Session not found/);
    assert.deepEqual((await bounded(scheduled.rpc.schedule.list())).entries, []);
    timeoutEvidence.manageScheduleLimitation = scheduleToolResult.data.error?.message;
    const catalog = (await bounded(scheduled.rpc.commands.list())).commands.map(command => command.name);
    assert.ok(catalog.includes('every') && catalog.includes('after'));
    const scheduledRequestCount = () => requests.filter(request => request.marker === 'SMOKE_SCHEDULED').length;
    const beforeCommands = requests.length;
    for (const [name, input] of [['every', '1h SMOKE_SCHEDULED'], ['after', '1h SMOKE_SCHEDULED'], ['after', '10s SMOKE_SCHEDULED']]) {
      const result = await bounded(scheduled.rpc.commands.invoke({ name: name!, input }));
      assert.equal(result.kind, 'text');
      if (result.kind === 'text') assert.match(result.text, /^Scheduled #\d+/);
    }
    assert.equal(requests.length, beforeCommands, 'Duration command parsing must not invoke a model');
    const originalSchedules = (await bounded(scheduled.rpc.schedule.list())).entries;
    assert.equal(originalSchedules.length, 3);
    assert.deepEqual(originalSchedules.map(entry => [entry.id, entry.intervalMs, entry.recurring]),
      [[1, 3_600_000, true], [2, 3_600_000, false], [3, 10_000, false]]);
    assert.equal(scheduledEvents.filter(event => event.type === 'session.schedule_created').length, 3);
    timeoutEvidence.originalSchedules = originalSchedules;
    const pollCases = () => Promise.all(cases.filter(probe => probe.poll && !probe.error).map(async probe => {
      try { await bounded(probe.poll!(), 2_000); probe.polls++; }
      catch (error) { probe.error = String(error); }
    }));
    for (const name of ['untouched', 'getMessages', 'activity', 'isProcessing', 'model', 'schedule', 'attach', 'persisted', 'metadata']) {
      const probe = await makeCase(name);
      const { session } = probe;
      const polls: Record<string, () => Promise<unknown>> = {
        getMessages: () => session.getEvents(),
        activity: () => session.rpc.metadata.activity(),
        isProcessing: () => session.rpc.metadata.isProcessing(),
        model: () => session.rpc.model.getCurrent(),
        schedule: () => session.rpc.schedule.list(),
        attach: () => nativeClient!.rpc.sessions.open({ kind: 'attach', sessionId: session.sessionId }),
        persisted: () => nativeClient!.rpc.sessions.readPersistedEvents({ sessionId: session.sessionId, max: 1 }),
        metadata: () => nativeClient!.getSessionMetadata(session.sessionId),
      };
      probe.poll = polls[name];
      assert.notEqual((await attach(session)).status, 'not_found');
      await pollCases();
      if (probe.poll) assert.ok(probe.polls > 0 && !probe.error, `${name} must succeed while the session is live`);
    }
    const pollingStarted = Date.now();
    while (Date.now() - pollingStarted < 4_000) {
      await pollCases();
      await bounded(nativeClient.getStatus());
      await bounded(nativeClient.listSessions());
      await sleep(150);
    }
    const pollResults = await Promise.all(cases.map(async probe => {
      const status = (await attach(probe.session)).status;
      const shutdown = probe.events.filter(event => event.type === 'session.shutdown');
      return { name: probe.name, polls: probe.polls, error: probe.error, status, shutdown };
    }));
    timeoutEvidence.polls = pollResults;
    const refreshesIdle = new Set(['activity', 'isProcessing', 'model', 'schedule']);
    for (const probe of pollResults) {
      await t.test(`native idle: ${probe.name}`, () => {
        const protectedFromIdle = refreshesIdle.has(probe.name) || ['busy', 'question'].includes(probe.name);
        assert.equal(probe.status === 'not_found', !protectedFromIdle, JSON.stringify(probe));
        assert.ok(probe.shutdown.length <= (protectedFromIdle ? 0 : 1), JSON.stringify(probe));
        if (refreshesIdle.has(probe.name) || ['attach', 'persisted', 'metadata'].includes(probe.name)) {
          assert.ok(probe.polls >= 10 && !probe.error, JSON.stringify(probe));
        }
        if (probe.name === 'getMessages') {
          assert.ok(probe.polls > 0);
          assert.match(probe.error ?? '', /session.getMessages.*Session not found/);
        }
      });
    }
    timeoutChecks.push('getEvents, attach, persisted history and global status/list/metadata do not reset idle',
      'activity, isProcessing, model.getCurrent and schedule.list do reset idle',
      'held inference and unanswered native ask_user survive several idle periods');
    assert.ok(!busy.events.some(event => event.type === 'session.idle'));
    assert.ok(question.events.some(event => event.type === 'user_input.requested'));
    assert.ok(!question.events.some(event => event.type === 'user_input.completed'));
    await assertClosed(scheduled);
    assert.ok((await bounded(nativeClient.listSessions())).some(row => row.sessionId === scheduled.sessionId));
    timeoutEvidence.scheduleShutdown = {
      shutdownNotifications: scheduledEvents.filter(event => event.type === 'session.shutdown').length,
      lifecycleTypes: [...new Set(lifecycle.filter(event => event.sessionId === scheduled.sessionId).map(event => event.type))],
    };
    const coldSchedules = await bounded(nativeClient.rpc.sessions.readPersistedEvents({ sessionId: scheduled.sessionId, max: 1_000 }));
    assert.equal(coldSchedules.events.filter(event => event.type === 'session.schedule_created').length, 3);
    assert.ok(!coldSchedules.events.some(event => event.type === 'session.schedule_cancelled'));
    timeoutChecks.push('future native schedules do not prevent idle close; native schedule events persist');

    const releasedAt = Date.now() - epoch;
    held.get('SMOKE_BUSY')!.release();
    answerQuestion!();
    answerQuestion = undefined;
    await eventually(() => [busy, question].every(probe => probe.events.some(event => event.type === 'session.idle')),
      'Native busy/question sessions must complete normally');
    // Attach is deliberately used only as an observation here, not a keep-alive policy.
    await Promise.all(cases.map(async probe => {
      await eventually(async () => (await attach(probe.session)).status === 'not_found',
        `${probe.name} must expire once observation polling stops`);
      await assertClosed(probe.session);
    }));
    timeoutEvidence.afterRelease = [busy, question].map(probe => {
      const completed = probe.events.find(event => event.type === 'session.idle')!;
      const shutdown = probe.events.find(event => event.type === 'session.shutdown');
      assert.ok(!shutdown || shutdown.ms >= completed.ms);
      return { name: probe.name, releasedAt, idleAt: completed.ms, closedAt: shutdown?.ms };
    });
    timeoutEvidence.closedWithoutShutdownNotification = [
      ...cases.filter(probe => !probe.events.some(event => event.type === 'session.shutdown')).map(probe => probe.name),
      ...(!scheduledEvents.some(event => event.type === 'session.shutdown') ? ['future schedule'] : []),
    ];
    timeoutChecks.push('busy/question complete normally, then expire; stopping test polling permits native cleanup');

    const dueAt = Date.parse(originalSchedules[2]!.nextRunAt);
    await sleep(Math.max(0, dueAt + 250 - Date.now()));
    assert.equal(scheduledRequestCount(), 0, 'A native-closed session does not run its overdue one-shot');
    await assertClosed(scheduled);
    timeoutEvidence.coldSchedule = { dueAt, observedAt: Date.now(), scheduledRequests: scheduledRequestCount() };
    const compareSchedules = (entries: typeof originalSchedules) => {
      assert.deepEqual(entries.map(({ nextRunAt: _, ...entry }) => entry),
        originalSchedules.map(({ nextRunAt: _, ...entry }) => entry));
      for (const entry of entries) {
        assert.ok(Date.parse(entry.nextRunAt) > Date.parse(originalSchedules.find(original => original.id === entry.id)!.nextRunAt),
          'Relative schedules restart their delay on resume, rather than preserving the original deadline');
      }
    };
    const restoredSchedule = await bounded(nativeClient.resumeSession(scheduled.sessionId, {
      ...nativeConfig, manageScheduleEnabled: true,
    }));
    assert.notEqual(restoredSchedule, scheduled);
    assert.deepEqual(await bounded(scheduled.getEvents()), await bounded(restoredSchedule.getEvents()),
      'Public RPC wrappers address the session ID, even when the original wrapper observed shutdown');
    timeoutChecks.push('shutdown wrappers reject native reads/sends, but their ID-based reads work again after native resume');
    const afterNativeClose = (await bounded(restoredSchedule.rpc.schedule.list())).entries;
    compareSchedules(afterNativeClose);
    timeoutEvidence.scheduleAfterNativeClose = afterNativeClose;
    await bounded(nativeClient.rpc.sessions.close({ sessionId: restoredSchedule.sessionId }));
    const explicitlyResumed = await bounded(nativeClient.resumeSession(scheduled.sessionId, {
      ...nativeConfig, manageScheduleEnabled: true,
    }));
    const afterExplicitClose = (await bounded(explicitlyResumed.rpc.schedule.list())).entries;
    compareSchedules(afterExplicitClose);
    timeoutEvidence.scheduleAfterExplicitClose = afterExplicitClose;
    assert.deepEqual(await bounded(nativeClient.stop()), []);
    await eventually(() => !existsSync(`/proc/${nativePid}`), 'Direct SDK native runtime must exit');
    stops.push({ pid: nativePid, errors: [], exited: true });
    nativeClient = undefined;
    nativeClient = new CopilotClient({ ...clientOptions, sessionIdleTimeoutSeconds: 0 });
    await bounded(nativeClient.start());
    const restartedPid = ownRuntime();
    assert.notEqual(restartedPid, nativePid);
    assert.ok(!readFileSync(`/proc/${restartedPid}/cmdline`, 'utf8').split('\0').includes('--session-idle-timeout'));
    assert.equal((await attach(scheduled)).status, 'not_found', 'Starting the runtime does not activate persisted schedules');
    const restartedEvents: SessionEvent[] = [];
    const restartedSchedule = await bounded(nativeClient.resumeSession(scheduled.sessionId, {
      ...nativeConfig, manageScheduleEnabled: true, onEvent: event => restartedEvents.push(event),
    }));
    const afterStopResume = (await bounded(restartedSchedule.rpc.schedule.list())).entries;
    compareSchedules(afterStopResume);
    timeoutEvidence.scheduleAfterStopResume = afterStopResume;
    timeoutChecks.push('native close, explicit close and stop/resume preserve schedule IDs/content but rebase relative deadlines');
    await sleep(3_500);
    assert.notEqual((await attach(restartedSchedule)).status, 'not_found');
    assert.ok(!restartedEvents.some(event => event.type === 'session.shutdown'));
    assert.deepEqual((await bounded(restartedSchedule.rpc.schedule.list())).entries, afterStopResume);
    timeoutChecks.push('zero disables native idle cleanup');
    const resumedDueAt = Date.parse(afterStopResume[2]!.nextRunAt);
    await sleep(Math.max(0, resumedDueAt + 250 - Date.now()));
    await eventually(() => restartedEvents.some(event => event.type === 'session.idle'),
      'Resumed native one-shot must execute and settle through the loopback provider');
    assert.equal(scheduledRequestCount(), 1);
    assert.ok(restartedEvents.some(event => event.type === 'assistant.message'
      && event.data.content === 'deterministic SMOKE_SCHEDULED done'));
    assert.ok(restartedEvents.some(event => event.type === 'session.schedule_cancelled' && event.data.id === 3));
    const remainingSchedules = (await bounded(restartedSchedule.rpc.schedule.list())).entries;
    assert.deepEqual(remainingSchedules, afterStopResume.slice(0, 2));
    timeoutEvidence.liveScheduleFiring = {
      dueAt: resumedDueAt, observedAt: Date.now(), scheduledRequests: scheduledRequestCount(),
      events: restartedEvents.filter(event => event.type.startsWith('session.schedule')).map(event => ({ type: event.type, data: event.data })),
      entries: remainingSchedules,
    };
    timeoutChecks.push('overdue cold one-shot does not fire; resumed live one-shot executes once and removes itself');
    assert.deepEqual(await bounded(nativeClient.stop()), []);
    await eventually(() => !existsSync(`/proc/${restartedPid}`), 'Restarted direct SDK native runtime must exit');
    stops.push({ pid: restartedPid, errors: [], exited: true });
    nativeClient = undefined;
    assert.deepEqual(mockErrors, []);
    assert.equal(owned.size, 4);

    await t.test('OfficialRuntime + Engine: native idle, passive pages, explicit resume and scheduled stop', async (t) => {
      runtime = new OfficialRuntime({ clientOptions: { ...clientOptions, sessionIdleTimeoutSeconds: 1 }, sessionConfig });
      const adapter = runtime;
      engine = new Engine({ runtime: adapter });
      const host = engine;
      const calls: { kind: string; id: string; prompt?: string }[] = [];
      const displayReads: { direction: string; events: number; bytes: number }[] = [];
      const createIds: string[] = [];
      const watched = new Map<string, CopilotSession>();
      const observe = (session: CopilotSession) => {
        watched.set(session.sessionId, session);
        t.mock.method(session, 'getEvents', async () => assert.fail('Engine must not transfer full native history'));
        const read = session.rpc.eventLog.read.bind(session.rpc.eventLog);
        t.mock.method(session.rpc.eventLog, 'read', async (params: Parameters<typeof read>[0]) => {
          assert.equal(params.agentScope, 'all');
          assert.equal(params.includeEphemeral, params.direction === 'forward');
          assert.notEqual(params.types, '*');
          assert.ok(params.max! <= 256);
          const page = await read(params);
          displayReads.push({ direction: params.direction!, events: page.events.length,
            bytes: Buffer.byteLength(JSON.stringify(page)) });
          return page;
        });
        const send = session.send.bind(session);
        t.mock.method(session, 'send', (options: string | Parameters<CopilotSession['send']>[0]) => {
          calls.push({ kind: 'send', id: session.sessionId, prompt: typeof options === 'string' ? options : options.prompt });
          return send(typeof options === 'string' ? { prompt: options } : options);
        });
        return session;
      };
      const createNative = adapter.createSession.bind(adapter);
      const resumeNative = adapter.resumeSession.bind(adapter);
      t.mock.method(adapter, 'createSession', async (config: SessionConfig) => {
        assert.equal(typeof config.onEvent, 'function', 'native create must receive the early event callback');
        const session = await createNative(config);
        createIds.push(session.sessionId);
        return observe(session);
      });
      t.mock.method(adapter, 'resumeSession', async (...args: Parameters<typeof adapter.resumeSession>) => {
        assert.equal(typeof args[1]?.onEvent, 'function', 'native resume must receive the early event callback');
        calls.push({ kind: 'resume', id: args[0] });
        return observe(await resumeNative(...args));
      });
      const list = t.mock.method(adapter, 'listSessions');
      const runtimeFatals: Error[] = [];
      const engineFatals: Error[] = [];
      adapter.onFatal(error => runtimeFatals.push(error));
      host.onFatal(error => engineFatals.push(error));
      await bounded(host.start());
      const observedNative: NativeObservation[] = [];
      const stopObserving = host.onNativeEvent(event => { observedNative.push(event); }, {
        types: ['assistant.message_start', 'assistant.message_delta', 'assistant.message'],
      });
      t.after(stopObserving);
      const passiveRead = t.mock.method(adapter.rpc.sessions, 'readPersistedEvents');
      const save = t.mock.method(adapter.rpc.sessions, 'save', async () => {
        assert.fail('Draft recovery must never force native persistence');
      });
      const pid = ownRuntime();
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      assert.equal(argv[argv.indexOf('--session-idle-timeout') + 1], '1');
      const id = await bounded(host.newSession(dirs.work!));
      assert.equal(displayReads.length, 0, 'Fresh allocation must not prewarm a chat projection');
      const original = watched.get(id)!;
      const activity = t.mock.method(original.rpc.metadata, 'activity');
      const processing = t.mock.method(original.rpc.metadata, 'isProcessing');
      assert.equal((await bounded(host.prompt(id, 'SMOKE_ENGINE'))).ok, true);
      await eventually(async () => (await host.getMeta(id))?.status === 'idle',
        'Engine synthetic native turn must complete');
      assert.ok(observedNative.some(value => value.event.type === 'assistant.message_start'));
      assert.ok(observedNative.some(value => value.event.type === 'assistant.message_delta'
        && value.event.ephemeral === true && typeof value.event.data.deltaContent === 'string'));
      assert.ok(observedNative.some(value => value.event.type === 'assistant.message'
        && value.event.data.content === 'deterministic SMOKE_ENGINE done'));
      assert.ok(observedNative.every(value => value.sessionId === id && value.cwd === dirs.work));
      assert.equal(displayReads.length, 0, 'Native module observations must not start a chat reader');
      stopObserving();
      assert.equal((await host.getMeta(id))?.loaded, true);
      const emptyId = await bounded(host.newSession(dirs.work!));
      const emptyOriginal = watched.get(emptyId)!;
      const emptyRequests = requests.length;
      assert.equal(await bounded(host.rename(emptyId, 'Configured empty draft')), 'Configured empty draft');
      await bounded(host.setModel(emptyId, 'gpt-4.1', undefined, 'default'));
      await bounded(host.setMode(emptyId, 'plan'));
      const confirmed = {
        name: await bounded(emptyOriginal.rpc.name.get()),
        model: await bounded(emptyOriginal.rpc.model.getCurrent()),
        mode: await bounded(emptyOriginal.rpc.mode.get()),
      };
      assert.equal(confirmed.name.name, 'Configured empty draft');
      assert.equal(confirmed.model.modelId, 'gpt-4.1');
      assert.equal(confirmed.mode, 'plan');
      assert.equal(await bounded(adapter.getSessionMetadata(emptyId)), undefined,
        'A configured live blank session still has no persisted native metadata');
      const beforeEmptyRead = passiveRead.mock.callCount();
      const emptyPage = await nativeChat(host, emptyId);
      assert.equal(passiveRead.mock.callCount(), beforeEmptyRead + 1);
      assert.deepEqual(emptyPage.read, { rpc: 1, events: emptyPage.events.length });
      assert.ok(emptyPage.events.every(event => !['user.message', 'assistant.message'].includes(event.type)),
        'An empty conversation may contain native metadata events but no invented messages');
      assert.equal('title' in emptyPage, false);
      assert.equal('cwd' in emptyPage, false);
      assert.equal(requests.length, emptyRequests, 'Initial settings must not trigger inference');
      assert.equal((await host.getMeta(emptyId))?.loaded, true);
      assert.deepEqual(createIds, [id, emptyId]);
      const journal = join(dirs.state!, 'session-state', id, 'events.jsonl');
      const completedAt = Date.now();
      const listedBefore = list.mock.callCount();
      const activityBefore = activity.mock.callCount();
      const processingBefore = processing.mock.callCount();
      // No liveness RPCs or fake native clock: native idle expiry must work without an Engine heartbeat.
      await sleep(9_000);
      assert.equal(list.mock.callCount(), listedBefore, 'Idle Engine must not poll or cache native metadata');
      assert.equal(activity.mock.callCount(), activityBefore, 'Idle Engine must not heartbeat native activity');
      assert.equal(processing.mock.callCount(), processingBefore, 'Idle Engine must not heartbeat native processing');
      assert.equal((await host.getMeta(id))?.loaded, false, 'An explicit metadata request reconciles native idle expiry');
      assert.equal((await host.getMeta(id))?.status, 'unloaded');
      await bounded(host.refreshList());
      assert.equal((await host.getMeta(emptyId)), null, 'Confirmed absent empty sessions leave the list');
      assert.equal((await bounded(adapter.rpc.sessions.open({ kind: 'attach', sessionId: emptyId }))).status, 'not_found');
      assert.equal(await bounded(adapter.getSessionMetadata(emptyId)), undefined,
        'Native idle cleanup must have actually discarded the empty session');
      assert.equal(adapter.liveCount, 0);
      assert.equal(activity.mock.callCount(), activityBefore, 'Expired handle metadata reads must not heartbeat native activity');
      assert.equal(processing.mock.callCount(), processingBefore, 'Expired handle metadata reads must not heartbeat native processing');
      assert.equal((await bounded(adapter.rpc.sessions.open({ kind: 'attach', sessionId: id }))).status, 'not_found');
      assert.deepEqual(calls, [{ kind: 'send', id, prompt: 'SMOKE_ENGINE' }]);
      const beforeRead = readFileSync(journal);
      const beforeMtime = statSync(journal).mtimeMs;
      const beforeRequests = requests.length;
      const beforeHistoryRead = passiveRead.mock.callCount();
      const history = await nativeChat(host, id, { max: 256 });
      assert.equal(passiveRead.mock.callCount(), beforeHistoryRead + 1);
      assert.deepEqual(history.read, { rpc: 1, events: history.events.length });
      assert.ok(history.events.some(event => event.type === 'user.message' && event.data.content === 'SMOKE_ENGINE'));
      assert.ok(history.events.some(event => event.type === 'assistant.message' && event.data.content === 'deterministic SMOKE_ENGINE done'));
      for (const read of [() => host.getPlan(id), () => host.getPanels(id),
        () => host.listSessionSkills(id), () => host.listSchedules(id)]) {
        await assert.rejects(bounded<unknown>(read()), /unavailable while unloaded.*explicitly resume/);
      }
      assert.deepEqual(await bounded(host.listSessionMcp(id)), { loaded: false, servers: [] });
      const beforeMissingRead = passiveRead.mock.callCount();
      await assert.rejects(nativeChat(host, emptyId), { statusCode: 404 });
      await assert.rejects(nativeChat(host, emptyId, { source: 'live' }), { statusCode: 404 });
      assert.equal(passiveRead.mock.callCount(), beforeMissingRead, 'Confirmed native absence is not fabricated empty chat');
      assert.equal(adapter.liveCount, 0);
      assert.deepEqual(createIds, [id, emptyId], 'Passive empty pages must not allocate a session');
      assert.equal(calls.length, 1, 'Neither persisted history nor native-only read pages may resume');
      assert.equal(requests.length, beforeRequests);
      assert.deepEqual(readFileSync(journal), beforeRead);
      assert.equal(statSync(journal).mtimeMs, beforeMtime);

      assert.equal((await bounded(host.prompt(id, 'SMOKE_ENGINEAGAIN'))).ok, true);
      await eventually(async () => (await host.getMeta(id))?.status === 'idle', 'Explicit prompt must finish after native resume');
      assert.deepEqual(calls, [
        { kind: 'send', id, prompt: 'SMOKE_ENGINE' },
        { kind: 'resume', id },
        { kind: 'send', id, prompt: 'SMOKE_ENGINEAGAIN' },
      ], 'Exactly one resume must precede exactly one send; the first prompt must never replay');
      assert.notEqual(watched.get(id), original);
      assert.equal(requests.filter(request => request.marker === 'SMOKE_ENGINEAGAIN').length, 1);
      const resumedHistory = await nativeChat(host, id, { max: 256 });
      for (const marker of ['SMOKE_ENGINE', 'SMOKE_ENGINEAGAIN']) {
        assert.equal(resumedHistory.events.filter(event => event.type === 'user.message' && event.data.content === marker).length, 1);
      }
      assert.deepEqual(runtimeChildren(), [pid], 'Native idle expiry must not recycle the runtime process');
      const schedule = await bounded(host.addSchedule(id, { interval: '1h', prompt: 'SMOKE_SCHEDULED' }));
      assert.ok(schedule.entry && !schedule.error);
      await eventually(async () => await host.busyCount() === 0,
        'Native idle and auxiliary host operations must both settle before manual unload');
      await bounded(host.unload(id));
      assert.equal((await host.getMeta(id))?.loaded, false, 'Manual close must not be blocked by a future schedule');
      assert.equal((await host.getMeta(id))?.scheduleCount, undefined, 'Unloaded metadata must not invent cached schedule state');
      await assert.rejects(host.listSchedules(id), /unavailable while unloaded.*explicitly resume/);
      assert.deepEqual(calls.filter(call => call.id === emptyId), [], 'A configured draft must receive no prompt or failed resume');
      assert.equal(createIds.filter(createdId => createdId === emptyId).length, 1);
      const beforeReloadRequests = requests.length;
      const beforeReloadJournal = readFileSync(journal);
      const beforeReloadMtime = statSync(journal).mtimeMs;
      const prefsPath = join(dirs.state!, 'engine-idle-prefs.json');
      assert.equal(existsSync(prefsPath), false);
      await assert.rejects(bounded(host.reload(emptyId)), /Unknown session/);
      assert.equal(createIds.filter(createdId => createdId === emptyId).length, 1,
        'Explicit reload must never recreate an absent session');
      assert.equal(watched.get(emptyId), emptyOriginal);
      assert.equal(await bounded(adapter.getSessionMetadata(emptyId)), undefined,
        'Reload must not save an absent empty session');
      assert.equal(requests.length, beforeReloadRequests);
      assert.deepEqual(readFileSync(journal), beforeReloadJournal);
      assert.equal(statSync(journal).mtimeMs, beforeReloadMtime);
      assert.equal(existsSync(prefsPath), false,
        'Draft settings must not gain a parallel preference journal');
      assert.deepEqual(calls.filter(call => call.id === emptyId), []);
      await assert.rejects(bounded(host.prompt(emptyId, 'SMOKE_ENGINEFIRST')), /Unknown session/);
      assert.equal(createIds.filter(createdId => createdId === emptyId).length, 1);
      assert.deepEqual(calls.filter(call => call.id === emptyId), []);
      assert.equal(requests.filter(request => request.marker === 'SMOKE_ENGINEFIRST').length, 0);
      assert.equal(requests.length, beforeReloadRequests, 'Missing sessions must not trigger inference');
      assert.equal(save.mock.callCount(), 0);
      assert.deepEqual(runtimeChildren(), [pid], 'An expired session must not recycle the runtime process');
      const scheduledId = await bounded(host.newSession(dirs.work!));
      const stopSchedule = await bounded(host.addSchedule(scheduledId, {
        interval: '1h', recurring: false, prompt: 'SMOKE_SCHEDULED',
      }));
      assert.ok(stopSchedule.entry && !stopSchedule.error);
      assert.equal((await host.getMeta(scheduledId))?.loaded, true);
      assert.equal((await host.getMeta(scheduledId))?.scheduleCount, 1);
      const beforeStopRequests = requests.length;
      await bounded(host.stop(), 5_000);
      await eventually(() => !existsSync(`/proc/${pid}`), 'Engine stop with live and cold future schedules must release its child');
      assert.equal(adapter.liveCount, 0);
      await assert.rejects(host.snapshot(), { code: 'SESSION_TRANSITION' });
      assert.equal(requests.length, beforeStopRequests);
      assert.equal(calls.filter(call => call.kind === 'resume').length, 1, 'Stop must not resume cold scheduled sessions');
      assert.deepEqual(runtimeFatals, []);
      assert.deepEqual(engineFatals, []);
      stops.push({ pid, errors: [], exited: true });
      integrationEvidence.idle = {
        displayReads,
        waitedMs: Date.now() - completedAt, backgroundPolls: 0, explicitListReads: list.mock.callCount() - listedBefore,
        calls, passivePages: passiveRead.mock.callCount(), manualCloseWithSchedule: true, stopWithSchedule: true,
        emptyDraft: { sessionId: emptyId, creates: createIds.filter(createdId => createdId === emptyId).length,
          confirmed, absentReloadRejected: true, saves: save.mock.callCount(),
          sends: calls.filter(call => call.id === emptyId && call.kind === 'send').length,
          resumes: calls.filter(call => call.id === emptyId && call.kind === 'resume').length, sameRuntimePid: pid },
      };
    });
    assert.ok(integrationEvidence.idle, 'Idle integration must finish before replacing its owned runtime');

    await t.test('OfficialRuntime + Engine: confirmed child exit aborts uncertain mutation without replay', async () => {
      runtime = new OfficialRuntime({ clientOptions: { ...clientOptions, sessionIdleTimeoutSeconds: 1 }, sessionConfig });
      const adapter = runtime;
      engine = new Engine({ runtime: adapter });
      const host = engine;
      const runtimeFatals: Error[] = [];
      const engineFatals: Error[] = [];
      const agentStatuses: string[] = [];
      const compactionSignals: boolean[] = [];
      adapter.onFatal(error => runtimeFatals.push(error));
      host.onFatal(error => engineFatals.push(error));
      host.onEvent(event => {
        if (event.type === 'agent/status') agentStatuses.push(event.status);
        if (event.type === 'session/patch' && event.compacting !== undefined) compactionSignals.push(event.compacting);
      });
      await bounded(host.start());
      const pid = ownRuntime();
      const compactId = await bounded(host.newSession(dirs.work!));
      assert.equal((await bounded(host.prompt(compactId, 'SMOKE_FATALPREP'))).ok, true);
      await eventually(async () => {
        const meta = await host.getMeta(compactId);
        return meta?.status === 'idle' && !meta.activeOperations;
      }, 'Compaction fixture must have completed native history');
      const busyId = await bounded(host.newSession(dirs.work!));
      assert.equal((await bounded(host.prompt(busyId, 'SMOKE_FATALBUSY'))).ok, true);
      await eventually(() => held.has('SMOKE_FATALBUSY'), 'Accepted Engine turn must be held by the real loopback provider');
      assert.equal((await host.getMeta(busyId))?.status, 'running');
      assert.deepEqual(await bounded(host.prompt(busyId, 'SMOKE_FATALQUEUED')), { ok: true, queued: true });
      await eventually(async () => !!(await host.getMeta(busyId))?.queue?.length, 'A second accepted send must remain queued before native death');
      let mutationSettled = false;
      const mutation = host.compact(compactId, 'SMOKE_FATALCOMPACT');
      void mutation.then(() => { mutationSettled = true; }, () => { mutationSettled = true; });
      await eventually(() => held.has('SMOKE_FATALCOMPACT'), 'A real compaction mutation must reach held loopback inference');
      assert.equal(mutationSettled, false, 'The compaction acknowledgement must still be outstanding');
      assert.equal(compactionSignals.at(-1), true);
      assert.ok((await host.getMeta(compactId))!.activeOperations! > 0, 'Pending native mutation remains a real host contact');
      const beforeKillRequests = requests.length;
      terminateOwnedRuntime(pid);
      await eventually(() => runtimeFatals.length === 1 && engineFatals.length === 1,
        'Confirmed owned child exit must propagate through runtime.onFatal to Engine.onFatal');
      const failure = runtimeFatals[0]!;
      assert.match(failure.message, /exited unexpectedly.*SIGKILL.*restart required.*uncertain/);
      assert.equal(adapter.failure, failure);
      assert.equal(host.failure, failure);
      assert.equal(engineFatals[0], failure);
      await bounded(Promise.all([
        host.stop(),
        assert.rejects(mutation, error => error === failure),
      ]), 5_000);
      await eventually(() => !existsSync(`/proc/${pid}`), 'Fatal Engine stop must reap its exact owned native child');
      for (const id of [busyId, compactId]) {
        await assert.rejects(host.getMeta(id), error => error === failure,
          'Native fatal errors must surface rather than returning stale control metadata');
      }
      await assert.rejects(host.snapshot(), error => error === failure);
      assert.equal(agentStatuses.at(-1), 'failed');
      assert.equal(adapter.liveCount, 0);
      for (const reuse of [
        () => adapter.start(), () => adapter.createSession({}), () => adapter.resumeSession(busyId, {}),
        () => host.start(), () => host.newSession(dirs.work!),
        () => host.prompt(busyId, 'SMOKE_FATALBUSY'), () => host.compact(compactId, 'SMOKE_FATALCOMPACT'),
      ]) await assert.rejects(bounded<unknown>(reuse()), error => error === failure);
      await bounded(host.stop(), 5_000);
      await eventually(() => requests.filter(request => ['SMOKE_FATALBUSY', 'SMOKE_FATALCOMPACT'].includes(request.marker))
        .every(request => request.closed), 'Native death must release the held inference connections');
      assert.equal(requests.length, beforeKillRequests, 'Neither accepted sends nor uncertain compaction may replay');
      assert.equal(requests.filter(request => request.marker === 'SMOKE_FATALBUSY').length, 1);
      assert.equal(requests.filter(request => request.marker === 'SMOKE_FATALCOMPACT').length, 1);
      assert.equal(requests.filter(request => request.marker === 'SMOKE_FATALQUEUED').length, 0);
      assert.equal(runtimeFatals.length, 1);
      assert.equal(engineFatals.length, 1);
      assert.deepEqual(runtimeChildren(), []);
      stops.push({ pid, errors: [], exited: true });
      integrationEvidence.fatal = {
        pid, runtimeFatals: runtimeFatals.length, engineFatals: engineFatals.length,
        error: failure.message, acceptedTurnAborted: true, queuedSendNotReplayed: true,
        outstandingCompactionRejected: mutationSettled, stopCompleted: true, reuseRefused: true,
      };
    });
    assert.ok(integrationEvidence.fatal, 'Fatal integration must finish before reporting success');
    assert.deepEqual(mockErrors, []);
    assert.equal(owned.size, 6);
    assert.deepEqual(runtimeChildren(), []);
    passed = true;
  } finally {
    const cleanupErrors: string[] = [];
    try {
      for (const { response } of held.values()) response.destroy();
      answerQuestion?.();
      if (nativeClient) {
        try {
          const errors = await bounded(nativeClient.stop(), 10_000);
          cleanupErrors.push(...errors.map(String));
        } catch (error) { cleanupErrors.push(String(error)); }
      }
      for (const [pid, startTime] of ownedShells) {
        if (!existsSync(`/proc/${pid}`)) continue;
        try {
          assert.notEqual(pid, 1526380);
          assert.equal(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19], startTime);
          assert.equal(readlinkSync(`/proc/${pid}/cwd`), dirs.work);
          assert.equal(readlinkSync(`/proc/${pid}/exe`), '/usr/bin/sleep');
          cleanupErrors.push(`Native stop left fixture sleep ${pid} alive; guarded cleanup required`);
          process.kill(pid, 'SIGKILL');
          await eventually(() => !existsSync(`/proc/${pid}`), 'Guarded cleanup must reap its exact fixture sleep');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(String(error));
        }
      }
      if (runtime) {
        for (const session of sessions) {
          try { await bounded(session.abort(), 3_000); await bounded(runtime.closeSession(session), 3_000); }
          catch (error) { cleanupErrors.push(String(error)); }
        }
        if (engine) {
          const attached = (engine as unknown as { sessions: Map<string, { sdk?: CopilotSession }> }).sessions;
          for (const [id, state] of attached) {
            if (!state.sdk || engine.failure) continue;
            try { await bounded(engine.cancel(id), 3_000); await bounded(engine.unload(id), 3_000); }
            catch (error) { cleanupErrors.push(String(error)); }
          }
          try { await bounded(engine.stop(), 10_000); }
          catch (error) { cleanupErrors.push(String(error)); }
        }
        try {
          await bounded(runtime.stop(), 10_000);
        } catch (error) { cleanupErrors.push(String(error)); }
      }
      // Even a failing stop must not leave a fixture child; guard against PID reuse before signalling.
      for (const pid of runtimeChildren()) {
        if (pid === 1526380) continue;
        try {
          const startTime = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19]!;
          if (owned.get(pid) === startTime) {
            cleanupErrors.push(`SDK stop left owned runtime ${pid} alive; guarded fixture cleanup required`);
            terminateOwnedRuntime(pid);
            await eventually(() => !existsSync(`/proc/${pid}`), 'Guarded fixture cleanup must reap its child');
          } else if (!owned.has(pid) && readlinkSync(`/proc/${pid}/cwd`) === dirs.work) {
            cleanupErrors.push(`Unrecorded fixture runtime ${pid} remains; refusing to signal without a start-time ownership record`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(String(error));
        }
      }
    } finally {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } finally {
        process.chdir(originalCwd);
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        try { rmSync(fixture, { recursive: true, force: true }); }
        catch (error) { cleanupErrors.push(String(error)); }
      }
    }
    const evidence = {
      passed: passed && cleanupErrors.length === 0 && !existsSync(fixture),
      checks, timeoutChecks, counts: { checks: checks.length, timeoutChecks: timeoutChecks.length,
        created, resumed, modelRequests: requests.length, passiveEvents, attachmentEvents },
      hostPid: process.pid, samples, stops, abortSettlement, authStatus, deletion, timeoutEvidence, integrationEvidence, mockErrors, cleanupErrors,
      fixtureRemoved: !existsSync(fixture),
      limitations: ['Synthetic BYOK only; authenticated inventory replaced by empty host snapshot',
        'No legacy journal migration', 'RSS samples do not prove host GC or load capacity',
        'Native background coverage is a single synthetic async shell, not background agents or detached external tasks',
        'Uncertain delivery uses a real pending compaction RPC, not a delayed session.send acknowledgement'],
    };
    const evidencePath = process.env.COCKPIT_RUNTIME_EVIDENCE;
    if (evidencePath) {
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify({ latestNativeSmoke: evidence }, null, 2)}\n`);
    }
    t.diagnostic(JSON.stringify(evidence));
    assert.deepEqual(cleanupErrors, []);
    assert.ok(!existsSync(fixture));
  }
});

for (const setting of Object.keys(draftSettings) as (keyof typeof draftSettings)[]) {
  for (const closure of ['native idle', 'manual unload'] as const) {
    test(`empty session: ${setting} never triggers recreation after ${closure}`, async t => {
      const h = await draftFixture(t);
      const id = await h.engine.newSession(h.cwd);
      await draftSettings[setting](h.engine, id);
      const original = h.natives.get(id)!;
      if (closure === 'native idle') h.expire(id);
      else await h.engine.unload(id);
      const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
      await assert.rejects(h.engine.prompt(id, 'first fixture prompt'), /Unknown session/);
      assert.equal(h.natives.get(id), original);
      assert.deepEqual(h.runtime.createSession.mock.calls.map(call => call.arguments[0].sessionId), [id]);
      assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads + 1);
      assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
      assert.equal(original.send.mock.callCount(), 0);
      assert.equal(await h.engine.getMeta(id), null);
      assert.equal(h.runtime.rpc.sessions.save.mock.callCount(), 0);
    });
  }
}

test('empty session: absent native chat surfaces read errors without allocation or empty success', async t => {
  const h = await draftFixture(t);
  const id = await h.engine.newSession(h.cwd);
  for (const setting of Object.values(draftSettings)) await setting(h.engine, id);
  h.expire(id);
  assert.equal(existsSync(h.prefsFile), false, 'native settings do not create Cockpit preferences');
  const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
  await assert.rejects(h.chat(id), { statusCode: 404 });
  await assert.rejects(h.chat(id, 'forward'), { statusCode: 404 });
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0, 'confirmed absence never invents an empty native page');
  assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads + 2);
  assert.equal(h.runtime.liveCount, 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.sessions.save.mock.callCount(), 0);
  assert.equal(existsSync(h.prefsFile), false);
  await assert.rejects(h.engine.reload(id), /Unknown session/);
});

for (const action of ['chat', 'reload'] as const) {
  test(`empty session: ${action} propagates its native transport failure without recovery`, async t => {
    const h = await draftFixture(t);
    const id = await h.engine.newSession(h.cwd);
    h.expire(id);
    h.rows.set(id, { sessionId: id, startTime: new Date(), modifiedTime: new Date(), isRemote: false });
    const failure = new Error('Native transport unavailable');
    if (action === 'reload') h.runtime.resumeSession.mock.mockImplementation(async () => { throw failure; });
    else h.runtime.rpc.sessions.readPersistedEvents.mock.mockImplementation(async () => { throw failure; });
    await assert.rejects(action === 'reload' ? h.engine.reload(id) : h.chat(id), error => error === failure);
    assert.equal(h.runtime.createSession.mock.callCount(), 1);
    assert.equal(h.runtime.resumeSession.mock.callCount(), action === 'reload' ? 1 : 0);
    assert.equal(h.natives.get(id)!.send.mock.callCount(), 0);
    assert.equal(h.runtime.rpc.sessions.save.mock.callCount(), 0);
  });
}

test('empty session: persisted native settings win over prior handle settings on explicit resume', async t => {
  const h = await draftFixture(t);
  const id = await h.engine.newSession(h.cwd);
  for (const setting of ['rename', 'model', 'mode'] as const) await draftSettings[setting](h.engine, id);
  h.expire(id);
  const persisted = h.makeSession(id, { model: 'persisted-model', reasoningEffort: 'low', contextTier: 'default' });
  persisted.state.name = 'Persisted native name';
  persisted.state.mode = 'autopilot';
  h.saved.set(id, persisted);
  h.rows.set(id, { sessionId: id, startTime: new Date(), modifiedTime: new Date(), isRemote: false });
  await h.engine.reload(id);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.deepEqual((await draftProjection(h.engine, id)), {
    title: 'Persisted native name', model: 'persisted-model', reasoning: 'low', context: 'default', mode: 'autopilot',
  });
  const resumedConfig = h.runtime.resumeSession.mock.calls[0]!.arguments[1];
  for (const key of ['model', 'reasoningEffort', 'contextTier'] as const) {
    assert.equal(resumedConfig[key], undefined, `Previous ${key} must never override persisted state`);
  }
  assert.equal(persisted.rpc.name.set.mock.callCount(), 0);
  assert.equal(persisted.rpc.mode.set.mock.callCount(), 0);
  assert.equal(persisted.rpc.model.switchTo.mock.callCount(), 0);
  h.expire(id);
  h.rows.delete(id);
  h.saved.delete(id);
  await assert.rejects(h.engine.reload(id), /Unknown session/);
  assert.equal(h.runtime.createSession.mock.callCount(), 1, 'A previously persisted session never becomes a recreatable draft again');
});

test('native absence: confirmed missing listed sessions are removed without recreation or history deletion', async t => {
  const h = await draftFixture(t);
  const id = 'persisted-history-only';
  h.rows.set(id, { sessionId: id, startTime: new Date(), modifiedTime: new Date(), isRemote: false });
  await h.engine.refreshList();
  await assert.rejects(h.chat(id), /Native journal missing/);
  await assert.rejects(h.engine.prompt(id, 'must not manufacture history'), /Native session missing/);
  assert.ok((await h.engine.getMeta(id)), 'a failed resume alone does not erase existing native metadata');
  h.rows.delete(id);
  await h.engine.refreshList();
  assert.equal((await h.engine.getMeta(id)), null);
  await assert.rejects(h.chat(id), { statusCode: 404 });
  await assert.rejects(h.engine.prompt(id, 'must not recreate after removal'), /Unknown session/);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 1);
  assert.equal(h.runtime.rpc.sessions.save.mock.callCount(), 0);
});

for (const presence of ['missing', 'unindexed', 'unknown'] as const) {
  test(`native absence: ${presence} metadata after empty-session expiry never triggers draft recovery`, async t => {
    const h = await draftFixture(t);
    const id = await h.engine.newSession(h.cwd);
    await draftSettings.rename(h.engine, id);
    const confirmed = await draftProjection(h.engine, id);
    await h.engine.refreshList();
    assert.equal(h.runtime.liveCount, 1, 'an attached session is protected from absent index rows');
    assert.deepEqual((await draftProjection(h.engine, id)), confirmed);
    h.expire(id);
    if (presence === 'unindexed') {
      h.runtime.getSessionMetadata.mock.mockImplementation(async sessionId => ({
        sessionId, summary: 'Persisted native title', startTime: new Date(), modifiedTime: new Date(), isRemote: false,
      }));
    } else if (presence === 'unknown') {
      h.runtime.getSessionMetadata.mock.mockImplementation(async () => { throw new Error('Native metadata unavailable'); });
    }
    const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
    if (presence === 'unknown') await assert.rejects(h.engine.getMeta(id), /Native metadata unavailable/);
    else await h.engine.getMeta(id);
    assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads + 1);
    if (presence === 'missing') {
      assert.equal((await h.engine.getMeta(id)), null);
      assert.deepEqual((await h.engine.snapshot()).sessions, []);
      await assert.rejects(h.engine.reload(id), /Unknown session/);
      await assert.rejects(h.engine.prompt(id, 'must not recreate removed session'), /Unknown session/);
      await assert.rejects(h.chat(id), { statusCode: 404 });
    } else if (presence === 'unindexed') {
      assert.equal((await h.engine.getMeta(id))?.title, 'Persisted native title', 'unindexed metadata is read natively, not restored locally');
      assert.equal((await h.engine.getMeta(id))?.loaded, false);
    }
    assert.equal(h.runtime.createSession.mock.callCount(), 1);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(h.natives.get(id)!.send.mock.callCount(), 0);
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
    assert.equal(h.runtime.rpc.sessions.save.mock.callCount(), 0);
  });
}

for (const direction of ['forward', 'backward'] as const) {
  test(`empty session: ${direction} chat reads native events without restoring old settings`, async t => {
    const h = await draftFixture(t);
    const id = await h.engine.newSession(h.cwd);
    await h.engine.rename(id, 'Stale local title');
    h.expire(id);
    h.rows.set(id, { sessionId: id, startTime: new Date(), modifiedTime: new Date(), isRemote: false });
    h.journals.set(id, [
      { type: 'session.title_changed', data: { title: 'Persisted history title' } },
      { type: 'user.message', data: { content: 'Persisted first prompt' } },
    ].map((event, index) => ({
      ...event, id: `persisted-${index}`, timestamp: '2026-09-08T00:00:00.000Z', parentId: null,
    })) as SessionEvent[]);
    const page = await h.chat(id, direction);
    assert.deepEqual(page.events.map(event => event.id), ['persisted-0', 'persisted-1']);
    assert.equal(page.events[1]?.data.content, 'Persisted first prompt');
    assert.equal('title' in page, false);
    assert.equal('cwd' in page, false);
    assert.deepEqual(page.read, { rpc: 1, events: 2 });
    assert.deepEqual(h.runtime.rpc.sessions.readPersistedEvents.mock.calls[0]!.arguments, [{
      sessionId: id, cursor: undefined, direction, max: 2,
    }]);
    assert.equal(h.runtime.liveCount, 0);
    assert.equal(h.runtime.createSession.mock.callCount(), 1);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    h.rows.delete(id);
    h.journals.delete(id);
    await assert.rejects(h.engine.reload(id), /Unknown session/);
    assert.equal(h.runtime.createSession.mock.callCount(), 1, 'Observed history permanently disqualifies draft recreation');
  });
}

for (const mutation of ['send', 'compact', 'schedule'] as const) {
  test(`draft recovery: unknown ${mutation} dispatch without events never retries or recreates`, async t => {
    const h = await draftFixture(t);
    const id = await h.engine.newSession(h.cwd);
    const native = h.natives.get(id)!;
    const dispatch = mutation === 'send' ? native.send
      : mutation === 'compact' ? native.rpc.history.compact : native.rpc.commands.invoke;
    dispatch.mock.mockImplementation(async () => { throw new Error('Dispatch outcome unknown'); });
    const operation = mutation === 'send' ? h.engine.prompt(id, 'unknown fixture send')
      : mutation === 'compact' ? h.engine.compact(id) : h.engine.addSchedule(id, { interval: '1h', prompt: 'fixture schedule' });
    if (mutation === 'schedule') {
      const outcome = await operation;
      assert.ok(outcome && typeof outcome === 'object' && 'possiblyCreated' in outcome);
      assert.equal(outcome.possiblyCreated, true);
      assert.match(String(outcome.error), /Dispatch outcome unknown/);
    } else await assert.rejects(operation, /Dispatch outcome unknown/);
    assert.equal(dispatch.mock.callCount(), 1);
    assert.deepEqual(native.state.events, []);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0, 'A rejected dispatch is not a resume/retry signal');
    assert.equal(h.runtime.createSession.mock.callCount(), 1);
    h.expire(id);
    await assert.rejects(h.engine.reload(id), /Unknown session/);
    assert.equal(h.runtime.createSession.mock.callCount(), 1);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(dispatch.mock.callCount(), 1);
    assert.equal(h.runtime.rpc.sessions.save.mock.callCount(), 0);
  });
}

for (const setting of ['rename', 'model', 'mode'] as const) {
  test(`native settings: ${setting} result stays separate from an unavailable later projection`, async t => {
    const h = await draftFixture(t);
    const id = await h.engine.newSession(h.cwd);
    await draftSettings[setting](h.engine, id);
    const confirmed = (await draftProjection(h.engine, id));
    const native = h.natives.get(id)!;
    const fail = async (): Promise<never> => { throw new Error('Setting readback unknown'); };
    const readback = setting === 'rename' ? t.mock.method(native.rpc.name, 'get', fail)
      : setting === 'model' ? t.mock.method(native.rpc.model, 'getCurrent', fail)
      : t.mock.method(native.rpc.mode, 'get', fail);
    if (setting === 'rename') {
      await assert.rejects(h.engine.rename(id, 'Unconfirmed name'), /Setting readback unknown/);
    } else {
      const outcome = setting === 'model' ? await h.engine.setModel(id, 'unconfirmed-model', 'low', 'default')
        : await h.engine.setMode(id, 'autopilot');
      assert.deepEqual(outcome, setting === 'model'
        ? { modelId: 'unconfirmed-model' } : { status: 'applied', modelChanged: false });
      assert.equal(readback.mock.callCount(), 0, 'the native result requires no unrelated post-write readback');
    }
    await assert.rejects(setting === 'mode'
      ? h.engine.getResources(id, ['mode']) : h.engine.getMeta(id), /Setting readback unknown/);
    readback.mock.restore();
    assert.notDeepEqual(await draftProjection(h.engine, id), confirmed, 'fresh native state may reflect an uncertain mutation');
    h.expire(id);
    await assert.rejects(h.engine.reload(id), /Unknown session/);
    assert.equal(await h.engine.getMeta(id), null);
    assert.equal(h.natives.get(id), native);
    assert.equal(h.runtime.createSession.mock.callCount(), 1);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    const attempted = setting === 'rename' ? native.rpc.name.set
      : setting === 'model' ? native.rpc.model.switchTo : native.rpc.mode.set;
    assert.equal(attempted.mock.callCount(), 2, 'The uncertain mutation must not be retried on its old wrapper');
  });
}

test('draft recovery: overlapping settings retain the last confirmed native model', async t => {
  const h = await draftFixture(t);
  const id = await h.engine.newSession(h.cwd);
  const native = h.natives.get(id)!;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reading = false;
  t.mock.method(native.rpc.model, 'list', async () => {
    if (!reading) {
      reading = true;
      await held;
    }
    return { list: draftModels.map(model => ({ ...model, supportedContextTiers: [...model.supportedContextTiers] })) };
  });
  const first = h.engine.setModel(id, 'first-model', 'low', 'default');
  try {
    await eventually(() => reading, 'First model readback must reach the held inventory RPC');
    const second = h.engine.setModel(id, 'last-model', 'high', 'long_context');
    await sleep(25);
    release();
    await Promise.all([first, second]);
  } finally { release(); }
  assert.equal(native.state.model.modelId, 'last-model');
  const confirmed = (await draftProjection(h.engine, id));
  assert.equal(confirmed.model, 'last-model');
  h.expire(id);
  await assert.rejects(h.engine.reload(id), /Unknown session/);
  assert.equal(await h.engine.getMeta(id), null, 'closed wrappers do not retain confirmed settings');
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
});

test('draft recovery: pending MCP configuration still rejects a concurrent toggle immediately', async t => {
  const h = await draftFixture(t);
  const id = await h.engine.newSession(h.cwd);
  const native = h.natives.get(id)!;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(native.rpc.mcp, 'enable', async () => {
    await held;
    native.state.mcp = true;
  });
  const toggling = h.engine.toggleSessionMcp(id, 'fixture-mcp', true);
  try {
    await eventually(async () => (await h.engine.getMeta(id))?.activeMcpOperations === 1, 'Native MCP configuration must be pending');
    await assert.rejects(bounded(h.engine.toggleSessionMcp(id, 'fixture-mcp', false), 500), /already in progress/);
  } finally {
    release();
    await toggling;
  }
});

  test('empty session: failed initialization retains the real SDK handle without restoring settings', async t => {
    const h = await draftFixture(t);
    const create = h.runtime.createSession;
    t.mock.method(h.runtime, 'createSession', async (config: SessionConfig) => {
      const sdk = await create(config);
      t.mock.method(sdk.rpc.name, 'get', async () => { throw new Error('Native initialization readback failed'); });
      return sdk;
    });
    await assert.rejects(h.engine.newSession(h.cwd), /Native initialization readback failed/);
    const id = [...h.natives.keys()][0]!;
    const native = h.natives.get(id)!;
    await assert.rejects(h.engine.getMeta(id), /Native initialization readback failed/);
    assert.equal(h.runtime.liveCount, 1);
    assert.equal(native.send.mock.callCount(), 0);
    h.expire(id);
    await assert.rejects(h.engine.reload(id), /Unknown session/);
    assert.equal(h.runtime.createSession.mock.callCount(), 1);
    assert.equal(native.rpc.name.set.mock.callCount(), 0);
  });

test('empty session: a send during a passive native chat read never masks a read error', async t => {
  const h = await draftFixture(t);
  const id = await h.engine.newSession(h.cwd);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reading = false;
  t.mock.method(h.runtime.rpc.sessions, 'readPersistedEvents', async () => {
    reading = true;
    await held;
    throw new Error('Native journal missing');
  });
  const history = h.chat(id);
  const rejection = assert.rejects(history, /Native journal missing/);
  try {
    await eventually(() => reading, 'Passive history read must be in flight');
    await h.engine.prompt(id, 'fixture send with history delivery still unknown');
    release();
    await rejection;
  } finally { release(); }
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});
