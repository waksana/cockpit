import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { CopilotClient, CopilotSession, SessionConfig, SessionEvent, SessionMetadata } from '@github/copilot-sdk';
import type { ExitPlanModeAction, ModelOption, ServerEvent } from '@cockpit/protocol';
import { Intents, NativeChatRead, unreadSessionCount } from '@cockpit/protocol';
import { Engine, coreCapabilities, sessionMetaBusy, type EngineRuntime } from './engine.ts';
import { CHAT_EVENT_TYPES } from './native-chat.ts';
import type { CockpitPrefs } from './prefs.ts';
import { bundledSkillsDirectory } from './paths.ts';

type Rpc = CopilotSession['rpc'];
type Queue = Awaited<ReturnType<Rpc['queue']['pendingItems']>>;
type NativeTask = Awaited<ReturnType<Rpc['tasks']['list']>>['tasks'][number];
type NativeSchedule = Awaited<ReturnType<Rpc['schedule']['list']>>['entries'][number];
type RewindResult = Awaited<ReturnType<Rpc['history']['rewind']>>;
type McpState = Awaited<ReturnType<Rpc['mcp']['list']>>;
type Skill = Awaited<ReturnType<Rpc['skills']['list']>>['skills'][number];
type DiscoverSkills = CopilotClient['rpc']['skills']['discover'];
type ServerSkill = Awaited<ReturnType<DiscoverSkills>>['skills'][number];
type GlobalMcp = CopilotClient['rpc']['mcp'];
type McpDefinitions = Awaited<ReturnType<GlobalMcp['config']['list']>>['servers'];
type DiscoveredMcp = Awaited<ReturnType<GlobalMcp['discover']>>['servers'][number];
type UserSettings = Awaited<ReturnType<CopilotClient['rpc']['user']['settings']['get']>>;
type PersistedRead = CopilotClient['rpc']['sessions']['readPersistedEvents'];
type Mode = Parameters<Rpc['mode']['set']>[0]['mode'];
type PortRpc = { [K in keyof Rpc]?: Partial<Rpc[K]> };
const timestamp = '2026-09-07T12:00:00.000Z';
const protectedWork = /protected|progress|transition|settling/i;
const unavailableSession = /unloaded|unavailable|not loaded|not live|expired|closed/i;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function event<T extends SessionEvent['type']>(
  type: T, data: Extract<SessionEvent, { type: T }>['data'], id: string = randomUUID(),
): Extract<SessionEvent, { type: T }> {
  return { type, data, id, timestamp, parentId: null } as Extract<SessionEvent, { type: T }>;
}

const user = (id: string, content = 'native user message') => event('user.message', { content }, id);
const assistant = (eventId: string, messageId: string, content = 'native answer') =>
  event('assistant.message', { messageId, content }, eventId);
const schedule = (id = 7, recurring = true, prompt = 'check build'): NativeSchedule => ({
  id, recurring, prompt, intervalMs: 60_000, nextRunAt: '2026-09-07T12:01:00.000Z',
});
const task = (status: Extract<NativeTask, { type: 'agent' }>['status'] = 'running'): NativeTask => ({
  type: 'agent', id: 'task-registry-id', toolCallId: 'spawn-tool-call',
  description: 'background inspection', agentType: 'explore', prompt: 'inspect fixture',
  status, startedAt: timestamp,
});
const queued = (id: string, displayText: string): Queue['items'][number] => ({
  id, messageId: `accepted-${id}`, kind: 'message', agentMode: 'interactive', displayText,
});
function mcpState(servers: McpState['servers'] = [], disabledServers: string[] = []): McpState {
  return {
    servers,
    host: {
      mcp3pEnabled: true, disabledServers, filteredServers: [],
      clients: servers.filter(server => server.status === 'connected').map(server => server.name),
      pendingConnections: [], needsAuthServers: {},
      failedServers: Object.fromEntries(servers.filter(server => server.status === 'failed')
        .map(server => [server.name, { message: server.error ?? 'connection failed', timestamp: Date.parse(timestamp) }])),
    },
  };
}

function fakeSession(t: TestContext, sessionId: string) {
  const listeners = new Set<(event: SessionEvent) => void>();
  const cursors = new Map<string, { boundary: number; anchor?: string; direction: 'forward' | 'backward' }>();
  const state = {
    events: [] as SessionEvent[],
    processing: false,
    activeWork: false,
    queue: { items: [], steeringMessages: [], inFlightSteeringCount: 0 } as Queue,
    tasks: [] as NativeTask[],
    schedules: [] as NativeSchedule[],
    model: { modelId: 'native-model', reasoningEffort: 'medium', contextTier: 'default' } as Awaited<ReturnType<Rpc['model']['getCurrent']>>,
    mode: 'interactive' as Mode,
    name: null as string | null,
    cwd: '',
    userNamed: true,
    skills: [] as Skill[],
    mcp: mcpState(),
  };
  const rpc = {
    interruptMainTurn: t.mock.fn(async (_options: Parameters<Rpc['interruptMainTurn']>[0]) => ({ interrupted: state.processing })),
    eventLog: {
      tail: t.mock.fn(async (): Promise<Awaited<ReturnType<Rpc['eventLog']['tail']>>> => {
        const durable = state.events.filter(event => !event.ephemeral);
        const cursor = randomUUID();
        cursors.set(cursor, { boundary: durable.length, anchor: durable.at(-1)?.id, direction: 'forward' });
        return { cursor };
      }),
      read: t.mock.fn(async ({
        cursor, direction = 'forward', max = 200, types = '*', agentScope = 'all', agentIds, includeEphemeral = true,
      }: Parameters<Rpc['eventLog']['read']>[0]): Promise<Awaited<ReturnType<Rpc['eventLog']['read']>>> => {
        assert.ok(max >= 1 && max <= 1000);
        const durable = state.events.filter(event => !event.ephemeral);
        const prior = cursor ? cursors.get(cursor) : undefined;
        if (cursor && (!prior || (prior.anchor && durable[prior.boundary - 1]?.id !== prior.anchor))) {
          return { events: [], cursor: randomUUID(), hasMore: false, cursorStatus: 'expired' };
        }
        direction = prior?.direction ?? direction;
        const source = direction === 'backward' || !includeEphemeral ? durable : state.events;
        const boundary = prior?.boundary ?? (direction === 'backward' ? source.length : 0);
        const selected = source.map((event, index) => ({ event, index })).filter(({ event, index }) => {
          const data = event.data as Record<string, unknown>;
          const primary = event.type.startsWith('subagent.')
            || (!event.agentId && !data.agentId && !data.parentToolCallId);
          return (direction === 'backward' ? index < boundary : index >= boundary)
            && (types === '*' || types.includes(event.type)) && (agentScope === 'all' || primary)
            && (!agentIds || agentIds.includes(String(event.agentId ?? data.agentId ?? data.parentToolCallId)));
        });
        const batch = direction === 'backward' ? selected.slice(-max) : selected.slice(0, max);
        const next = direction === 'backward' ? batch[0]?.index ?? 0
          : batch.at(-1) ? batch.at(-1)!.index + 1 : source.length;
        const token = randomUUID();
        cursors.set(token, { boundary: next, anchor: source[next - 1]?.id, direction });
        return { events: structuredClone(batch.map(({ event }) => event)), cursor: token,
          hasMore: selected.length > batch.length, cursorStatus: 'ok' };
      }),
    },
    metadata: {
      snapshot: t.mock.fn(async (): Promise<Awaited<ReturnType<Rpc['metadata']['snapshot']>>> => ({
        sessionId, summary: state.name ?? 'indexed title', workingDirectory: state.cwd,
        startTime: timestamp, modifiedTime: timestamp, currentMode: state.mode, isRemote: false,
        alreadyInUse: false, workspacePath: null, sessionLimits: null,
      })),
      isProcessing: t.mock.fn(async () => ({ processing: state.processing })),
      activity: t.mock.fn(async () => ({ hasActiveWork: state.processing || state.activeWork, abortable: state.processing || state.activeWork })),
    },
    queue: {
      pendingItems: t.mock.fn(async (): Promise<Queue> => structuredClone(state.queue)),
      removeAt: t.mock.fn(async ({ id }: { id: string }) => {
        const index = state.queue.items.findIndex(item => item.id === id);
        if (index < 0) return { removed: false };
        state.queue.items.splice(index, 1);
        return { removed: true };
      }),
      clear: t.mock.fn(async () => { state.queue.items = []; state.queue.steeringMessages = []; }),
    },
    tasks: { list: t.mock.fn(async () => ({ tasks: structuredClone(state.tasks) })) },
    schedule: {
      list: t.mock.fn(async () => ({ entries: structuredClone(state.schedules) })),
      stop: t.mock.fn(async ({ id }: { id: number }) => {
        const entry = state.schedules.find(entry => entry.id === id);
        state.schedules = state.schedules.filter(entry => entry.id !== id);
        return { entry };
      }),
    },
    model: {
      list: t.mock.fn(async (): Promise<Awaited<ReturnType<Rpc['model']['list']>>> => ({ list: [] })),
      getCurrent: t.mock.fn(async () => structuredClone(state.model)),
      switchTo: t.mock.fn(async (options: Parameters<Rpc['model']['switchTo']>[0]) => {
        state.model = { ...state.model, modelId: options.modelId,
          reasoningEffort: options.reasoningEffort, contextTier: options.contextTier };
        return { modelId: state.model.modelId };
      }),
    },
    mode: {
      get: t.mock.fn(async () => state.mode),
      set: t.mock.fn(async ({ mode }: Parameters<Rpc['mode']['set']>[0]) => {
        state.mode = mode;
        return { status: 'applied', modelChanged: false };
      }),
    },
    name: {
      get: t.mock.fn(async () => ({ name: state.name })),
      set: t.mock.fn(async ({ name }: { name: string }) => { state.name = name; state.userNamed = true; }),
      setAuto: t.mock.fn(async ({ summary }: Parameters<Rpc['name']['setAuto']>[0]) => {
        if (state.userNamed || state.name === summary) return { applied: false };
        state.name = summary;
        return { applied: true };
      }),
    },
    workspaces: { getWorkspace: t.mock.fn(async (): Promise<Awaited<ReturnType<Rpc['workspaces']['getWorkspace']>>> =>
      ({ workspace: { id: sessionId, name: state.name ?? undefined, user_named: state.userNamed } })) },
    ui: { ephemeralQuery: t.mock.fn(async (_options: Parameters<Rpc['ui']['ephemeralQuery']>[0]) => ({ answer: 'Native session naming' })) },
    history: {
      clearContext: t.mock.fn(async (_options: Parameters<Rpc['history']['clearContext']>[0]) => ({ messagesCleared: 2 })),
      compact: t.mock.fn(async (_options: Parameters<Rpc['history']['compact']>[0]) => ({
        success: true, tokensRemoved: 100, messagesRemoved: 2,
      })),
      rewind: t.mock.fn(async (_options: Parameters<Rpc['history']['rewind']>[0]): Promise<RewindResult> => ({
        outcome: 'success', eventsRemoved: 0, restoredFiles: [], skippedFiles: [],
      })),
    },
    skills: {
      list: t.mock.fn(async () => ({ skills: structuredClone(state.skills) })),
      reload: t.mock.fn(async (): Promise<Awaited<ReturnType<Rpc['skills']['reload']>>> => ({ warnings: [], errors: [] })),
      enable: t.mock.fn(async ({ name }: { name: string }) => {
        const skill = state.skills.find(skill => skill.name === name);
        if (skill) skill.enabled = true;
      }),
      disable: t.mock.fn(async ({ name }: { name: string }) => {
        const skill = state.skills.find(skill => skill.name === name);
        if (skill) skill.enabled = false;
      }),
    },
    permissions: { pendingRequests: t.mock.fn(async () => ({ items: [] })) },
    mcp: {
      list: t.mock.fn(async () => structuredClone(state.mcp)),
      enable: t.mock.fn(async (_options: Parameters<Rpc['mcp']['enable']>[0]) => {}),
      disable: t.mock.fn(async (_options: Parameters<Rpc['mcp']['disable']>[0]) => {}),
      reload: t.mock.fn(async () => {}),
    },
    commands: {
      invoke: t.mock.fn(async (_options: Parameters<Rpc['commands']['invoke']>[0]) => ({
        kind: 'completed' as const,
      })),
    },
    plan: {
      read: t.mock.fn(async () => ({ exists: false, content: null, path: null })),
      readSqlTodos: t.mock.fn(async () => ({ rows: [] as Array<Record<string, string>> })),
    },
    instructions: { getSources: t.mock.fn(async () => ({ sources: [] })) },
  } satisfies PortRpc;
  const sdk = {
    sessionId, rpc,
    on: t.mock.fn((handler: (event: SessionEvent) => void) => {
      assert.equal(typeof handler, 'function', 'subscribe through the public on(handler) overload');
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    }),
    getEvents: t.mock.fn(async () => structuredClone(state.events)),
    send: t.mock.fn(async (_options: Parameters<CopilotSession['send']>[0]): Promise<string> => randomUUID()),
    abort: t.mock.fn(async () => {}),
  };
  return {
    sdk, rpc, state, listeners,
    emit(native: SessionEvent) {
      state.events.push(structuredClone(native));
      for (const handler of [...listeners]) handler(native);
    },
  };
}

function harness(t: TestContext, options: {
  mcpServers?: McpDefinitions;
  prefs?: Partial<CockpitPrefs> & Record<string, unknown>;
} = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const relativeRoot = `.engine-test-${randomUUID()}`;
  mkdirSync(relativeRoot);
  const cwd = resolve(relativeRoot);
  const prefsFile = join(relativeRoot, 'prefs.json');
  writeFileSync(prefsFile, JSON.stringify(options.prefs ?? {}));
  const natives = new Map<string, ReturnType<typeof fakeSession>>();
  const attached = new Set<string>();
  const configs = new Map<string, SessionConfig>();
  const rows: SessionMetadata[] = [];
  const journals = new Map<string, SessionEvent[]>();
  const trace: string[] = [];
  const events: ServerEvent[] = [];
  const fatalListeners = new Set<(error: Error) => void>();
  const closedListeners = new Set<(sdk: CopilotSession) => void>();
  const discoveredSkills: ServerSkill[] = [];
  const userSettings: UserSettings = { settings: { disabledSkills: { value: [], default: [], isDefault: true } } };
  const mcpDefinitions = options.mcpServers ?? {};
  const discoveredMcp: DiscoveredMcp[] = Object.keys(mcpDefinitions).map(name => ({ name, source: 'user', enabled: true }));
  let failure: Error | undefined;
  const runtime = {
    get failure() { return failure; },
    onFatal: t.mock.fn((handler: (error: Error) => void) => {
      fatalListeners.add(handler);
      return () => { fatalListeners.delete(handler); };
    }),
    onSessionClosed: t.mock.fn((handler: (sdk: CopilotSession) => void) => {
      closedListeners.add(handler);
      return () => { closedListeners.delete(handler); };
    }),
    isSessionLive: t.mock.fn(async (sdk: CopilotSession) => {
      if (failure) throw failure;
      if (!attached.has(sdk.sessionId)) natives.get(sdk.sessionId)?.listeners.clear();
      return attached.has(sdk.sessionId);
    }),
    emitFatal(error: Error) {
      if (failure) return;
      failure = error;
      for (const native of natives.values()) native.listeners.clear();
      for (const handler of [...fatalListeners]) handler(error);
    },
    expire(id: string, notify = false) {
      const native = natives.get(id);
      assert.ok(native);
      attached.delete(id);
      if (notify) native.listeners.clear();
      if (notify) for (const handler of [...closedListeners]) handler(native.sdk as unknown as CopilotSession);
    },
    start: t.mock.fn(async () => { trace.push('start'); }),
    stop: t.mock.fn(async () => {
      if (!failure) assert.equal(attached.size, 0, 'healthy stop must follow successful closure of every handle');
      attached.clear();
      trace.push('stop');
    }),
    models: t.mock.fn(async (): Promise<ModelOption[]> => []),
    getAuthStatus: t.mock.fn(async (): ReturnType<CopilotClient['getAuthStatus']> => ({ isAuthenticated: false })),
    listSessions: t.mock.fn(async () => structuredClone(rows)),
    getSessionMetadata: t.mock.fn(async (id: string): Promise<SessionMetadata | undefined> => rows.find(row => row.sessionId === id)),
    deleteSession: t.mock.fn(async (id: string) => {
      assert.ok(!attached.has(id), 'native deletion must follow safe closure');
      trace.push(`delete:${id}`);
      const index = rows.findIndex(row => row.sessionId === id);
      if (index >= 0) rows.splice(index, 1);
      journals.delete(id);
    }),
    createSession: t.mock.fn(async (config: SessionConfig) => {
      assert.ok(config.sessionId);
      const native = fakeSession(t, config.sessionId);
      native.state.cwd = config.workingDirectory ?? cwd;
      natives.set(config.sessionId, native);
      if (!rows.some(row => row.sessionId === config.sessionId)) {
        rows.push({
          sessionId: config.sessionId, isRemote: false, startTime: new Date(timestamp),
          modifiedTime: new Date(timestamp), context: { workingDirectory: native.state.cwd },
        });
      }
      journals.set(config.sessionId, native.state.events);
      configs.set(config.sessionId, config);
      attached.add(config.sessionId);
      if (config.onEvent) native.sdk.on(config.onEvent);
      trace.push(`create:${config.sessionId}`);
      return native.sdk as unknown as CopilotSession;
    }),
    resumeSession: t.mock.fn(async (id: string, config: SessionConfig) => {
      const native = natives.get(id);
      assert.ok(native, 'only an explicitly seeded fake session may be resumed');
      configs.set(id, config);
      attached.add(id);
      if (config.onEvent) native.sdk.on(config.onEvent);
      trace.push(`resume:${id}`);
      return native.sdk as unknown as CopilotSession;
    }),
    closeSession: t.mock.fn(async (sdk: CopilotSession) => {
      assert.ok(attached.has(sdk.sessionId));
      trace.push(`close:${sdk.sessionId}`);
      attached.delete(sdk.sessionId);
      natives.get(sdk.sessionId)?.listeners.clear();
    }),
    get liveCount() { return attached.size; },
    rpc: {
      user: {
        settings: { get: t.mock.fn(async () => structuredClone(userSettings)) },
      },
      mcp: {
        config: {
          list: t.mock.fn(async () => ({ servers: structuredClone(mcpDefinitions) })),
          enable: t.mock.fn(async ({ names }: { names: string[] }) => {
            for (const server of discoveredMcp) if (names.includes(server.name)) server.enabled = true;
          }),
          disable: t.mock.fn(async ({ names }: { names: string[] }) => {
            for (const server of discoveredMcp) if (names.includes(server.name)) server.enabled = false;
          }),
          reload: t.mock.fn(async () => {}),
        },
        discover: t.mock.fn(async (_params: Parameters<GlobalMcp['discover']>[0]) => ({ servers: structuredClone(discoveredMcp) })),
      },
      skills: {
        config: {
          setSkillDisabled: t.mock.fn(async ({ name, disabled }: { name: string; disabled: boolean }) => {
            const current = userSettings.settings.disabledSkills!.value as string[];
            userSettings.settings.disabledSkills!.value = disabled ? [...new Set([...current, name])] : current.filter(skill => skill !== name);
          }),
        },
        discover: t.mock.fn(async (_params: Parameters<DiscoverSkills>[0]): Promise<Awaited<ReturnType<DiscoverSkills>>> =>
          ({ skills: structuredClone(discoveredSkills) })),
      },
      sessions: {
        fork: t.mock.fn(async ({ sessionId, toEventId, name }: Parameters<CopilotClient['rpc']['sessions']['fork']>[0]):
          Promise<Awaited<ReturnType<CopilotClient['rpc']['sessions']['fork']>>> => {
          assert.ok(natives.has(sessionId));
          const id = randomUUID();
          const native = fakeSession(t, id);
          const events = natives.get(sessionId)!.state.events;
          const end = toEventId ? events.findIndex(event => event.id === toEventId) : events.length;
          native.state.events = structuredClone(events.slice(0, end));
          native.state.cwd = natives.get(sessionId)!.state.cwd;
          rows.push({
            sessionId: id, summary: name, isRemote: false, startTime: new Date(timestamp),
            modifiedTime: new Date(timestamp), context: { workingDirectory: native.state.cwd },
          });
          natives.set(id, native);
          journals.set(id, native.state.events);
          return { sessionId: id, name };
        }),
        readPersistedEvents: t.mock.fn(async ({
          sessionId, direction = 'forward', cursor, max = 100,
        }: Parameters<PersistedRead>[0]): Promise<Awaited<ReturnType<PersistedRead>>> => {
          const journal = journals.get(sessionId);
          assert.ok(journal, 'passive reads must use a seeded in-memory journal, never real history');
          const revision = createHash('sha256').update(JSON.stringify(journal)).digest('hex');
          const [priorRevision, offset] = cursor?.split(':') ?? [];
          const expired = !!cursor && priorRevision !== revision;
          const boundary = cursor && !expired ? Number(offset) : direction === 'backward' ? journal.length : 0;
          assert.ok(Number.isSafeInteger(boundary) && boundary >= 0 && boundary <= journal.length);
          const start = direction === 'backward' ? Math.max(0, boundary - max) : boundary;
          const end = direction === 'backward' ? boundary : Math.min(journal.length, boundary + max);
          return {
            events: structuredClone(journal.slice(start, end)),
            cursor: `${revision}:${direction === 'backward' ? start : end}`,
            hasMore: direction === 'backward' ? start > 0 : end < journal.length,
            cursorStatus: expired ? 'expired' : 'ok',
          };
        }),
      },
    },
  };
  // The SDK class contains private transport fields. Only this boundary casts;
  // every exercised public method above is structural and independently observable.
  const engine = new Engine({ runtime: runtime as unknown as EngineRuntime, prefsFile });
  const off = engine.onEvent(value => events.push(structuredClone(value)));
  t.after(async () => {
    await nextTurn();
    off();
    rmSync(relativeRoot, { recursive: true, force: true });
  });
  return {
    engine, runtime, events, natives, attached, configs, rows, journals, trace, cwd, prefsFile, discoveredSkills, discoveredMcp, mcpDefinitions, userSettings,
    prefs: () => JSON.parse(readFileSync(prefsFile, 'utf8')) as Partial<CockpitPrefs> & Record<string, unknown> & {
      scheduledSessions?: Record<string, number>; mcpDefaultOn?: string[];
      mcpBySession?: Record<string, string[]>; skillsDisabledBySession?: Record<string, string[]>;
    },
    async seed(id: string = randomUUID(), summary = 'indexed title') {
      const native = fakeSession(t, id);
      native.state.cwd = cwd;
      natives.set(id, native);
      journals.set(id, []);
      rows.push({
        sessionId: id, summary, isRemote: false, startTime: new Date(timestamp),
        modifiedTime: new Date('2026-09-07T12:00:30.000Z'), context: { workingDirectory: cwd },
      });
      await engine.refreshList();
      return { id, ...native };
    },
    async load(id: string = randomUUID()) {
      const session = await this.seed(id);
      await engine.reload(id);
      return session;
    },
  };
}
type Harness = ReturnType<typeof harness>;

test('self clear gates host mutations until native tool completion and rejects stale bindings after reload', async t => {
  const h = harness(t);
  const s = await h.load();
  const file = join(h.cwd, 'handoff.txt');
  writeFileSync(file, 'Synthetic persisted continuation');
  const config = h.configs.get(s.id)!;
  const tool = config.tools!.find(tool => tool.name === 'self_clear_context')!;
  const call = { sessionId: s.id, toolCallId: 'clear-call', toolName: tool.name, arguments: {} };
  const args = { prompt: `Read ${file} and continue only this synthetic goal.`, handoffFiles: [file] };
  s.emit(event('assistant.message', {
    messageId: 'message', content: '', toolRequests: [{ name: tool.name, toolCallId: call.toolCallId }],
  }));
  s.emit(event('tool.execution_start', { toolName: tool.name, toolCallId: call.toolCallId }));
  s.emit(event('external_tool.requested', { sessionId: s.id, toolName: tool.name, toolCallId: call.toolCallId, requestId: 'request' }));
  const entered = deferred();
  const release = deferred();
  s.rpc.history.clearContext.mock.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { messagesCleared: 2 };
  });
  const running = Promise.resolve(tool.handler!(args, call));
  await entered.promise;
  for (const action of [
    () => h.engine.prompt(s.id, 'must not enter'),
    () => h.engine.compact(s.id),
    () => h.engine.cancel(s.id),
    () => h.engine.reload(s.id),
    () => h.engine.setMode(s.id, 'plan'),
  ]) await assert.rejects(action(), /context clear is in progress/);
  assert.equal((await h.engine.getMeta(s.id))?.sessionId, s.id, 'Read-only status remains available');
  release.resolve();
  await running;
  await assert.rejects(h.engine.prompt(s.id, 'not before completion'), /context clear is in progress/);
  s.emit(event('tool.execution_complete', { toolCallId: call.toolCallId, success: true }));
  s.emit(event('session.idle', {}));
  await h.engine.reload(s.id);
  assert.notEqual(h.configs.get(s.id)!.tools![0], tool);
  await assert.rejects(Promise.resolve(tool.handler!(args, call)), /bound main session/);
  assert.equal(s.rpc.history.clearContext.mock.callCount(), 1);
});

test('startup never polls native catalogs and models and login are fresh on every request', async t => {
  const h = harness(t);
  await h.engine.start();
  assert.equal(h.runtime.listSessions.mock.callCount(), 0);
  assert.equal(h.runtime.models.mock.callCount(), 0);
  assert.equal(h.runtime.getAuthStatus.mock.callCount(), 0);
  let label = 'first';
  h.runtime.models.mock.mockImplementation(async () => [{ modelId: label, name: label }]);
  h.runtime.getAuthStatus.mock.mockImplementation(async () => ({ isAuthenticated: true, login: label }));
  assert.equal((await h.engine.snapshot()).models[0]?.modelId, 'first');
  assert.equal(await h.engine.login(), 'first');
  label = 'second';
  assert.equal((await h.engine.snapshot()).models[0]?.modelId, 'second');
  assert.equal(await h.engine.login(), 'second');
  assert.equal(h.runtime.models.mock.callCount(), 2);
  assert.equal(h.runtime.getAuthStatus.mock.callCount(), 2);
  const lists = h.runtime.listSessions.mock.callCount();
  t.mock.timers.tick(24_000);
  await nextTurn();
  assert.equal(h.runtime.listSessions.mock.callCount(), lists);
  assert.equal(h.runtime.models.mock.callCount(), 2);
  await h.engine.stop();
});

test('session organization does not resolve or expose project metadata', async t => {
  const h = harness(t);
  const s = await h.seed();
  const original = (await h.engine.getMeta(s.id))!;
  assert.equal('project' in original, false);
  assert.equal('project' in (await h.engine.snapshot()).sessions.find(row => row.sessionId === s.id)!, false);
  assert.equal('project' in (await h.engine.listLive()).find(row => row.sessionId === s.id)!, false);
  assert.equal(h.events.some(event => event.type === 'session/patch' && 'project' in event), false);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.cwd, h.cwd);

  await h.engine.reload(s.id);
  s.state.processing = true;
  h.rows[0]!.context = { workingDirectory: '/' };
  await h.engine.refreshList();
  assert.equal('project' in (await h.engine.getMeta(s.id))!, false);
  assert.equal((await h.engine.getMeta(s.id))?.cwd, h.cwd, 'list refresh never rewrites runtime cwd');
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);

  h.rows.push({
    sessionId: 'unknown-project', summary: 'legacy', isRemote: false,
    startTime: new Date(timestamp), modifiedTime: new Date(timestamp),
  });
  await h.engine.refreshList();
  assert.equal('project' in (await h.engine.getMeta('unknown-project'))!, false);
  await h.engine.deleteSession('unknown-project', true);
  assert.equal(await h.engine.getMeta('unknown-project'), null);
});

test('list refresh publishes changed indexed rows so activity order updates without reconnecting', async t => {
  const h = harness(t);
  const s = await h.seed();
  await h.engine.start();
  h.rows[0]!.summary = 'updated elsewhere';
  h.rows[0]!.modifiedTime = new Date('2026-09-09T12:00:00Z');
  h.events.length = 0;
  await h.engine.refreshList();
  assert.ok(h.events.some(event => event.type === 'snapshot' && event.sessions.some(row => row.sessionId === s.id
    && row.title === 'updated elsewhere' && row.lastActivity === Date.parse('2026-09-09T12:00:00Z'))));
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('fork registers a distinct unloaded child, with an exclusive native boundary and no side effects', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = [user('first'), assistant('reply', 'reply-id'), user('second')];
  const before = structuredClone(s.state.events);
  const result = await h.engine.forkSession(s.id, 'second', 'Independent');
  assert.notEqual(result.sessionId, s.id);
  assert.deepEqual(h.runtime.rpc.sessions.fork.mock.calls[0]!.arguments, [{ sessionId: s.id, toEventId: 'second', name: 'Independent' }]);
  assert.deepEqual(s.state.events, before);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(result.sessionId))!.loaded, false);
  assert.equal((await h.engine.getMeta(result.sessionId))!.cwd, h.cwd);
  assert.equal('project' in (await h.engine.getMeta(result.sessionId))!, false);
  assert.equal((await h.engine.getMeta(result.sessionId))!.title, 'Independent');
  assert.equal((await h.engine.getMeta(result.sessionId))!.queue, undefined);
  assert.equal((await h.engine.getMeta(s.id))!.closing, false);
  assert.ok(h.events.some(event => event.type === 'session/added' && event.session.sessionId === result.sessionId));
  assert.deepEqual(h.journals.get(result.sessionId), before.slice(0, 2));
});

test('fork locks the source while dispatching and never retries uncertain creation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = [user('first'), assistant('reply', 'reply-id')];
  const gate = deferred<{ sessionId: string }>();
  h.runtime.rpc.sessions.fork.mock.mockImplementation(() => gate.promise);
  const pending = h.engine.forkSession(s.id);
  while (!h.runtime.rpc.sessions.fork.mock.callCount()) await nextTurn();
  await assert.rejects(h.engine.prompt(s.id, 'must not send'), /transition/);
  await assert.rejects(h.engine.forkSession(s.id), /transition/);
  await assert.rejects(h.engine.unload(s.id), /transition/);
  gate.reject(new Error('acknowledgement lost'));
  await assert.rejects(pending, /uncertain.*Do not retry blindly.*acknowledgement lost/);
  assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 1);
  assert.equal((await h.engine.getMeta(s.id))!.closing, false);
});

for (const condition of ['missing', 'assistant', 'nested', 'turn', 'tool', 'schedule', 'empty', 'expired'] as const) {
  test(`fork validates ${condition} history before native mutation`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.events = [user('first'), assistant('reply', 'reply-id')];
    let boundary: string | undefined = 'boundary';
    if (condition === 'assistant') boundary = 'reply';
    else if (condition === 'empty') boundary = 'first';
    else if (condition !== 'missing') {
      if (condition === 'turn') s.state.events.push(event('assistant.turn_start', { turnId: 'turn' }));
      if (condition === 'tool') s.state.events.push(event('tool.execution_start', { toolCallId: 'tool', toolName: 'view' }));
      if (condition === 'schedule') s.state.events.push(event('session.schedule_created', { id: 1, prompt: 'old timer', recurring: true, intervalMs: 60_000 }));
      const next = user('boundary');
      if (condition === 'nested') next.agentId = 'subagent';
      s.state.events.push(next);
    }
    if (condition === 'expired') s.rpc.eventLog.read.mock.mockImplementation(async () => ({
      events: [], cursor: 'expired', hasMore: false, cursorStatus: 'expired',
    }));
    await assert.rejects(h.engine.forkSession(s.id, boundary), /boundary|root user|schedule|history|cursor/i);
    assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 0);
  });
}

test('fork scans beyond one native page and permits a boundary before a stopped schedule', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = Array.from({ length: 1005 }, (_, i) => user(`user-${i}`));
  s.state.events.push(event('session.schedule_created', { id: 1, prompt: 'old timer', recurring: true, intervalMs: 60_000 }));
  await h.engine.forkSession(s.id, 'user-1004');
  assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 1);
  await assert.rejects(h.engine.forkSession(s.id), /schedule/);
  assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 1);
});

for (const condition of ['running', 'task', 'queue', 'steering', 'timer', 'unloaded'] as const) {
  test(`fork refuses ${condition} source without mutation or implicit resume`, async t => {
    const h = harness(t);
    const s = condition === 'unloaded' ? await h.seed() : await h.load();
    s.state.events = [user('first'), assistant('reply', 'reply-id')];
    if (condition === 'running') s.state.processing = true;
    if (condition === 'task') s.state.tasks = [task()];
    if (condition === 'queue') s.state.queue.items = [queued('queued', 'old task')];
    if (condition === 'steering') s.state.queue.inFlightSteeringCount = 1;
    if (condition === 'timer') s.state.schedules = [schedule()];
    await assert.rejects(h.engine.forkSession(s.id), /protected|unloaded|timers/i);
    assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 0);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), condition === 'unloaded' ? 0 : 1);
  });
}


test('native activity is freshly confirmed and resource events never schedule background reads', async t => {
  const h = harness(t);
  const s = await h.load();
  const before = nativeCalls(s);
  for (let i = 0; i < 20; i++) s.emit(event('session.todos_changed', {}));
  await nextTurn();
  assert.deepEqual(nativeCalls(s), before);
  for (const busy of [true, false]) {
    s.state.activeWork = busy;
    const meta = (await h.engine.getMeta(s.id))!;
    assert.equal(meta.nativeProcessing, busy);
    assert.equal(meta.status, busy ? 'running' : 'idle');
  }
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('failed metadata request is not retained or retried and a later request reads native truth', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.metadata.activity.mock.mockImplementationOnce(async () => { throw new Error('activity unavailable'); });
  await assert.rejects(h.engine.getMeta(s.id), /activity unavailable/);
  const calls = nativeCalls(s);
  await nextTurn();
  assert.deepEqual(nativeCalls(s), calls);
  const meta = (await h.engine.getMeta(s.id))!;
  assert.equal(meta.status, 'idle');
  assert.equal(meta.error, undefined);
  assert.equal(Object.hasOwn(meta, 'error'), false, 'native metadata has no public current-error getter');
});

for (const malformed of [
  'missing-processing', 'nonboolean-processing', 'missing-activity', 'nonboolean-activity',
  'missing-steering-count', 'negative-steering-count', 'fractional-steering-count',
] as const) {
  test(`native control fails closed for ${malformed} without remembering or retrying the malformed response`, async t => {
    const h = harness(t);
    const s = await h.load();
    if (malformed.endsWith('processing')) {
      s.rpc.metadata.isProcessing.mock.mockImplementation(async () => {
        const value = { processing: false };
        if (malformed === 'missing-processing') Reflect.deleteProperty(value, 'processing');
        else Reflect.set(value, 'processing', 'false');
        return value;
      });
    } else if (malformed.endsWith('activity')) {
      s.rpc.metadata.activity.mock.mockImplementation(async () => {
        const value = { hasActiveWork: false, abortable: false };
        if (malformed === 'missing-activity') Reflect.deleteProperty(value, 'hasActiveWork');
        else Reflect.set(value, 'hasActiveWork', 'false');
        return value;
      });
    } else if (malformed === 'missing-steering-count') {
      Reflect.deleteProperty(s.state.queue, 'inFlightSteeringCount');
    } else s.state.queue.inFlightSteeringCount = malformed === 'negative-steering-count' ? -1 : 0.5;
    await assert.rejects(h.engine.getMeta(s.id), /activity state is incomplete/);
    await assert.rejects(h.engine.unload(s.id), /activity state is incomplete/);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    const calls = nativeCalls(s);
    await nextTurn();
    assert.deepEqual(nativeCalls(s), calls, 'malformed native responses cannot trigger background retries');
    s.rpc.metadata.isProcessing.mock.restore();
    s.rpc.metadata.activity.mock.restore();
    s.state.queue.inFlightSteeringCount = 0;
    assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
    await h.engine.unload(s.id);
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  });
}

for (const operation of ['unload', 'stop'] as const) {
  test(`native ${operation} confirmation invalidated by a live event fails closed without polling`, async t => {
    const h = harness(t);
    const s = await h.load();
    const activity = deferred<Awaited<ReturnType<Rpc['metadata']['activity']>>>();
    s.rpc.metadata.activity.mock.mockImplementationOnce(() => activity.promise);
    const transition = operation === 'unload' ? h.engine.unload(s.id) : h.engine.stop();
    const rejected = assert.rejects(transition, protectedWork);
    await nextTurn();
    s.emit(event('session.title_changed', { title: 'Changed during confirmation' }));
    activity.resolve({ hasActiveWork: false, abortable: false });
    await rejected;
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    const calls = nativeCalls(s);
    await nextTurn();
    assert.deepEqual(nativeCalls(s), calls);
    assert.equal((await h.engine.getMeta(s.id))?.nativeProcessing, false);
  });
}


const usageMetrics = {
  sessionStartTime: timestamp, currentModel: 'native-model', totalUserRequests: 3,
  totalPremiumRequestCost: 1, totalApiDurationMs: 120,
  lastCallInputTokens: 800, lastCallOutputTokens: 90,
  codeChanges: { linesAdded: 0, linesRemoved: 0, filesModifiedCount: 0, filesModified: [] },
  modelMetrics: { 'native-model': {
    requests: { count: 3, cost: 1 },
    usage: { inputTokens: 2100, outputTokens: 180, cacheReadTokens: 500, cacheWriteTokens: 100 },
  } },
};
const usageContext = {
  totalTokens: 1000, modelId: 'native-model', modelSource: 'selected', promptTokenLimit: 10000,
  limit: 12000, bufferTokens: 2500, compactionThreshold: 8000,
  categories: { systemPrompt: 100, customInstructions: 100, systemTools: 100, mcpTools: 100, messages: 600, freeSpace: 8500, buffer: 2500 },
  entries: [{ kind: 'system', id: 'private-source', label: 'not exposed', tokens: 100 }],
  compactions: { count: 2 },
};
function installUsage(s: ReturnType<typeof fakeSession>, context: unknown = { contextAttribution: usageContext }, metrics: unknown = usageMetrics) {
  let calls = 0;
  Reflect.set(s.rpc.metadata, 'getContextAttribution', async () => { calls++; return context; });
  Reflect.set(s.rpc, 'usage', { getMetrics: async () => { calls++; return metrics; } });
  return () => calls;
}

test('native usage reads exactly two native snapshots, preserves scope, strips sources and never invokes inference', async t => {
  const h = harness(t);
  const s = await h.load();
  const before = nativeCalls(s);
  const calls = installUsage(s);
  const loaded = h.runtime.resumeSession.mock.callCount();
  const result = await h.engine.getUsage(s.id);
  assert.equal(calls(), 2);
  assert.equal(result.context?.totalTokens, 1000);
  assert.equal(result.context?.promptTokenLimit, 10000);
  assert.equal(result.usage.lastCallInputTokens, 800);
  assert.equal(result.usage.modelMetrics['native-model']?.usage.inputTokens, 2100);
  assert.equal(result.usage.modelMetrics['native-model']?.usage.reasoningTokens, undefined);
  assert.ok(!JSON.stringify(result).includes('private-source'));
  assert.equal(h.runtime.resumeSession.mock.callCount(), loaded);
  assert.equal(s.sdk.send.mock.callCount(), before.send);
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), before['ui.ephemeralQuery']);
  assert.equal(s.rpc.history.compact.mock.callCount(), before['history.compact']);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
});

for (const context of [{ contextAttribution: null }, {}]) {
  test(`native usage uninitialized context stays unavailable: ${JSON.stringify(context)}`, async t => {
    const h = harness(t);
    const s = await h.load();
    installUsage(s, context);
    assert.equal((await h.engine.getUsage(s.id)).context, null);
  });
}

test('native usage unloaded and unknown reads never resume/create/register a session', async t => {
  const h = harness(t);
  const s = await h.seed();
  const calls = installUsage(s);
  for (const id of [s.id, 'unknown']) await assert.rejects(h.engine.getUsage(id), unavailableSession);
  assert.equal(calls(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta('unknown')), null);
});

test('native usage unsupported, invalid and failed reads remain explicit rather than fake zero', async t => {
  const h = harness(t);
  const s = await h.load();
  await assert.rejects(h.engine.getUsage(s.id), /APIs are unavailable/);
  installUsage(s, { contextAttribution: usageContext }, { ...usageMetrics, lastCallInputTokens: -1 });
  await assert.rejects(h.engine.getUsage(s.id), /greater than or equal/);
  installUsage(s);
  Reflect.set(s.rpc, 'usage', { getMetrics: async () => { throw new Error('native usage failed'); } });
  await assert.rejects(h.engine.getUsage(s.id), /native usage failed/);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('native usage old response is rejected after detach while another session reads independently', async t => {
  const h = harness(t);
  const a = await h.load();
  const b = await h.load();
  const held = deferred<typeof usageMetrics>();
  installUsage(a);
  installUsage(b);
  Reflect.set(a.rpc, 'usage', { getMetrics: () => held.promise });
  const reading = h.engine.getUsage(a.id);
  const rejection = assert.rejects(reading, /closed/);
  await nextTurn();
  assert.equal((await h.engine.getUsage(b.id)).sessionId, b.id);
  h.attached.delete(a.id);
  a.emit(connectionEvent('disconnected'));
  await rejection;
  held.resolve(usageMetrics);
  await nextTurn();
  assert.equal((await h.engine.getMeta(a.id))?.loaded, false);
});

test('native usage reserves work before a held liveness probe so unload cannot begin', async t => {
  const h = harness(t);
  const s = await h.load();
  const calls = installUsage(s);
  const alive = deferred<boolean>();
  h.runtime.isSessionLive.mock.mockImplementationOnce(() => alive.promise);
  const reading = h.engine.getUsage(s.id);
  await nextTurn();
  const closing = h.engine.unload(s.id);
  const rejected = assert.rejects(closing, /operation.*progress|protected/i);
  alive.resolve(true);
  await rejected;
  await reading;
  assert.equal(calls(), 2);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
});

for (const transition of ['unload', 'stop'] as const) {
  test(`native usage cannot join an already claimed ${transition} lifecycle`, async t => {
    const h = harness(t);
    const s = await h.load();
    const calls = installUsage(s);
    const alive = deferred<boolean>();
    h.runtime.isSessionLive.mock.mockImplementationOnce(() => alive.promise);
    const closing = transition === 'unload' ? h.engine.unload(s.id) : h.engine.stop();
    await nextTurn();
    const reading = h.engine.getUsage(s.id);
    const rejected = assert.rejects(reading, /lifecycle|transition|progress/i);
    alive.resolve(true);
    await rejected;
    await closing;
    assert.equal(calls(), 0);
  });
}

test('native plan descriptions normalize only null to absence and preserve the complete mixed plan', async t => {
  const h = harness(t);
  const s = await h.load();
  const descriptions = [null, undefined, '', 'Actual description', null, '  '] as const;
  const rows = descriptions.map((description, index) => {
    const row = { id: `todo-${index}`, title: `Title ${index}`, status: index === 3 ? 'done' : 'pending' };
    if (description !== undefined) Reflect.set(row, 'description', description);
    return row;
  });
  const original = structuredClone(rows);
  s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows }));
  t.mock.method(s.rpc.plan, 'read', async () => ({ exists: true, content: '# Native plan', path: '/fixture/plan.md' }));
  const before = nativeCalls(s);
  const result = await h.engine.getPlan(s.id);
  const wire = Intents['session/plan'].result.parse(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(wire, {
    planMarkdown: '# Native plan',
    todos: rows.map(({ id, title, status }, index) => ({
      id, title, status, ...(descriptions[index] == null ? {} : { description: descriptions[index] }),
    })),
  });
  assert.equal('changedFiles' in result, false, 'plan reads do not reconstruct file changes from chat');
  assert.deepEqual(rows, original, 'native row objects are never rewritten');
  assert.deepEqual(nativeCallDelta(s, before), { 'plan.read': 1, 'plan.readSqlTodos': 1 });
});

for (const description of [0, false, {}, []]) {
  test(`native plan invalid description remains rejected by the result contract: ${JSON.stringify(description)}`, async t => {
    const h = harness(t);
    const s = await h.load();
    const row = { id: 'todo', title: 'Title', status: 'pending' };
    Reflect.set(row, 'description', description);
    s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows: [row] }));
    const result = await h.engine.getPlan(s.id);
    const parsed = Intents['session/plan'].result.safeParse(result);
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.deepEqual(parsed.error.issues[0]?.path, ['todos', 0, 'description']);
    assert.equal(result.todos.length, 1, 'invalid rows are not filtered away');
  });
}


for (const order of ['older-first', 'newer-first'] as const) {
  test(`request-owned metadata snapshots settle ${order} without caching their readbacks`, async t => {
    const h = harness(t);
    const s = await h.load();
    const older = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
    const newer = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
    s.rpc.model.getCurrent.mock.mockImplementationOnce(() => older.promise);
    const first = h.engine.getMeta(s.id);
    await nextTurn();
    s.rpc.model.getCurrent.mock.mockImplementationOnce(() => newer.promise);
    const second = h.engine.getMeta(s.id);
    await nextTurn();
    if (order === 'older-first') {
      older.resolve({ modelId: 'old-snapshot' });
      assert.equal((await first)?.currentModelId, 'old-snapshot');
      newer.resolve({ modelId: 'new-snapshot' });
    } else {
      newer.resolve({ modelId: 'new-snapshot' });
      assert.equal((await second)?.currentModelId, 'new-snapshot');
      older.resolve({ modelId: 'old-snapshot' });
    }
    assert.equal((await first)?.currentModelId, 'old-snapshot');
    assert.equal((await second)?.currentModelId, 'new-snapshot');
    s.state.model.modelId = 'current-native';
    assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'current-native');
    assert.equal(s.rpc.model.switchTo.mock.callCount(), 0);
  });
}

test('resource invalidations publish hints without reading or retaining native projections', async t => {
  const h = harness(t);
  const s = await h.load();
  const before = nativeCalls(s);
  h.events.length = 0;
  for (let i = 0; i < 20; i++) s.emit(event('session.model_change', { newModel: 'event-hint' }));
  s.emit(event('session.todos_changed', {}));
  s.emit(event('session.schedule_rearmed', { id: 7, nextRunAt: Date.parse(timestamp) }));
  await nextTurn();
  assert.deepEqual(nativeCalls(s), before);
  assert.ok(h.events.some(value => value.type === 'session/invalidated' && value.sessionId === s.id));
  s.state.model.modelId = 'current-native';
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'current-native');
  const state = activeState(h, s.id);
  for (const key of ['meta', 'tasks', 'nativeMcpPending', 'resourceReads', 'dirtyResources', 'resourceSync', 'steering', 'autoNameSeen']) {
    assert.equal(key in state, false, key + ' is not resident');
  }
});

test('held metadata requests do not block independent resource or session reads', async t => {
  const h = harness(t);
  const a = await h.load();
  const b = await h.load();
  const held = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
  a.rpc.model.getCurrent.mock.mockImplementationOnce(() => held.promise);
  const reading = h.engine.getMeta(a.id);
  await nextTurn();
  a.state.schedules = [schedule()];
  b.state.model.modelId = 'other-session';
  assert.equal((await h.engine.listSchedules(a.id)).length, 1);
  assert.equal((await h.engine.getMeta(b.id))?.currentModelId, 'other-session');
  held.resolve({ modelId: 'released' });
  assert.equal((await reading)?.currentModelId, 'released');
});

for (const outcome of ['success', 'failure'] as const) {
  test(`late metadata ${outcome} after closure cannot affect a replacement handle`, async t => {
    const h = harness(t);
    const s = await h.load();
    const held = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
    s.rpc.model.getCurrent.mock.mockImplementationOnce(() => held.promise);
    const reading = h.engine.getMeta(s.id);
    const rejected = assert.rejects(reading, /closed/);
    await nextTurn();
    h.runtime.expire(s.id, true);
    await rejected;
    s.state.model.modelId = 'replacement';
    await h.engine.reload(s.id);
    if (outcome === 'failure') held.reject(new Error('retired read failure'));
    else held.resolve({ modelId: 'retired snapshot' });
    await nextTurn();
    const meta = (await h.engine.getMeta(s.id))!;
    assert.equal(meta.currentModelId, 'replacement');
    assert.equal(meta.error, undefined);
  });
}

test('setter readback failure rejects only its own command without rolling back native current metadata', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
  s.rpc.model.getCurrent.mock.mockImplementationOnce(() => held.promise);
  const rejected = assert.rejects(h.engine.setModel(s.id, 'command'), /own read failure/);
  await nextTurn();
  s.state.model.modelId = 'later-native';
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'later-native');
  held.reject(new Error('own read failure'));
  await rejected;
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'later-native');
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 1);
});

test('plan and schedule callers own their results without caching stale readbacks', async t => {
  const h = harness(t);
  const s = await h.load();
  const todos = deferred<Awaited<ReturnType<typeof s.rpc.plan.readSqlTodos>>>();
  const schedules = deferred<Awaited<ReturnType<Rpc['schedule']['list']>>>();
  s.rpc.plan.readSqlTodos.mock.mockImplementationOnce(() => todos.promise);
  s.rpc.schedule.list.mock.mockImplementationOnce(() => schedules.promise);
  const plan = h.engine.getPlan(s.id);
  const listing = h.engine.listSchedules(s.id);
  await nextTurn();
  s.state.schedules = [schedule(1), schedule(2)];
  s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows: [{ id: 'new', title: 'new todo', status: 'done' }] }));
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 2);
  todos.resolve({ rows: [] });
  schedules.resolve({ entries: [] });
  assert.deepEqual((await plan).todos, []);
  assert.deepEqual(await listing, []);
  assert.deepEqual((await h.engine.getMeta(s.id))?.todo, { total: 1, done: 1, intent: null });
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 2);
});

test('schedule mutations do not retry and subsequent reads never use old response projections', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.schedules = [schedule(1), schedule(2)];
  const old = deferred<Awaited<ReturnType<Rpc['schedule']['list']>>>();
  s.rpc.schedule.list.mock.mockImplementationOnce(() => old.promise);
  const listing = h.engine.listSchedules(s.id);
  await nextTurn();
  assert.equal(await h.engine.stopSchedule(s.id, 1), true);
  old.resolve({ entries: [] });
  assert.deepEqual(await listing, []);
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
});

test('MCP mutation readback cannot erase native pending work from later safety checks', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'connected' }]);
  const readback = deferred<McpState>();
  s.rpc.mcp.list.mock.mockImplementationOnce(() => readback.promise, s.rpc.mcp.list.mock.callCount() + 1);
  const toggling = h.engine.toggleSessionMcp(s.id, 'fixture', true);
  await nextTurn();
  s.state.mcp.host!.pendingConnections = ['native-connector'];
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 2);
  readback.resolve(mcpState([{ name: 'fixture', status: 'connected' }]));
  assert.equal((await toggling).ok, true);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 1);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('failed native MCP safety reads prevent closure without remembering a fake pending count', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.mcp.list.mock.mockImplementation(async () => { throw new Error('MCP unavailable'); });
  await assert.rejects(h.engine.stop(), /MCP unavailable/);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.stop.mock.callCount(), 0);
  await assert.rejects(h.engine.getMeta(s.id), /MCP unavailable/);
  const calls = nativeCalls(s);
  await nextTurn();
  assert.deepEqual(nativeCalls(s), calls);
});


function activeState(h: Harness, id: string) {
  return (h.engine as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions.get(id)!;
}

function nativeCalls(s: ReturnType<typeof fakeSession>): Record<string, number> {
  return {
    getEvents: s.sdk.getEvents.mock.callCount(),
    send: s.sdk.send.mock.callCount(),
    abort: s.sdk.abort.mock.callCount(),
    ...Object.fromEntries(Object.entries(s.rpc).flatMap(([group, methods]) =>
      Object.entries(methods).map(([name, method]) => [`${group}.${name}`, method.mock.callCount()]))),
  };
}

function nativeCallDelta(s: ReturnType<typeof fakeSession>, before: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(nativeCalls(s))
    .map(([name, count]) => [name, count - (before[name] ?? 0)] as const).filter(([, count]) => count));
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const outcome = promise.then(value => ({ value }), error => ({ error })).then(result => {
    settled = true;
    return result;
  });
  await nextTurn();
  assert.ok(settled, 'operation must settle without waiting for dead native work');
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}

function visibleError(h: Harness, id: string, pattern: RegExp) {
  assert.ok(h.events.some(event => event.type === 'session/patch' && event.sessionId === id
    && typeof event.error === 'string' && pattern.test(event.error)), 'operation failure must be emitted, not cached');
}

function serverChatEvents(h: Harness) {
  return h.events.filter(event => ['msg/upsert', 'session/reset', 'session/history-page'].includes(event.type));
}

function chat(h: Harness, sessionId: string, query: Partial<NativeChatRead> = {}) {
  return h.engine.chat(NativeChatRead.parse({ sessionId, ...query }));
}

test('Engine exposes no recycle or recycleIdle API', t => {
  const h = harness(t);
  assert.equal('recycle' in h.engine, false);
  assert.equal('recycleIdle' in h.engine, false);
});

const readOnlyMethods = ['getPlan', 'getPanels', 'listSchedules', 'listSessionSkills'] as const;
for (const method of readOnlyMethods) {
  for (const availability of ['unloaded', 'expired', 'unconfirmed'] as const) {
    test(`${method} rejects ${availability} sessions without native reads, resume, or creation`, async t => {
      const h = harness(t);
      const s = availability === 'unloaded' ? await h.seed() : await h.load();
      const resumes = h.runtime.resumeSession.mock.callCount();
      const before = nativeCalls(s);
      const probes = h.runtime.isSessionLive.mock.callCount();
      if (availability === 'expired') h.runtime.expire(s.id);
      if (availability === 'unconfirmed') {
        h.runtime.isSessionLive.mock.mockImplementationOnce(async () => { throw new Error('native attach unavailable'); });
      }
      await assert.rejects(h.engine[method](s.id), availability === 'unconfirmed'
        ? unavailableSession
        : { statusCode: 409, code: 'SESSION_UNLOADED' });
      assert.deepEqual(nativeCalls(s), before);
      assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
      assert.equal(h.runtime.createSession.mock.callCount(), 0);
      assert.equal(h.runtime.closeSession.mock.callCount(), 0);
      assert.equal(h.runtime.isSessionLive.mock.callCount(), probes + (availability === 'unloaded' ? 0 : 1));
      if (availability !== 'unconfirmed') {
        assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
        assert.equal((await h.engine.getMeta(s.id))?.error, undefined, 'an unloaded detail read is not a session execution failure');
      }
    });
  }

  test(`${method} checks a loaded handle passively before its requested native read`, async t => {
    const h = harness(t);
    const s = await h.load();
    const confirmation = deferred<boolean>();
    const probes = h.runtime.isSessionLive.mock.callCount();
    const before = nativeCalls(s);
    h.runtime.isSessionLive.mock.mockImplementationOnce(async () => {
      const live = await confirmation.promise;
      if (!live) s.listeners.clear();
      return live;
    });
    const reading = h.engine[method](s.id);
    await nextTurn();
    assert.equal(h.runtime.isSessionLive.mock.callCount(), probes + 1);
    assert.deepEqual(h.runtime.isSessionLive.mock.calls.at(-1)!.arguments, [s.sdk]);
    assert.deepEqual(nativeCalls(s), before, 'no native read may race ahead of attach confirmation');
    confirmation.resolve(true);
    await reading;
    assert.notDeepEqual(nativeCalls(s), before, 'the requested read should run after confirmation');
    assert.equal(s.rpc.metadata.isProcessing.mock.callCount(), before['metadata.isProcessing']);
    assert.equal(s.rpc.metadata.activity.mock.callCount(), before['metadata.activity']);
    assert.equal(s.sdk.getEvents.mock.callCount(), before.getEvents);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
  });
}

test('listSessionMcp never invents unloaded enablement from global or legacy settings', async t => {
  const h = harness(t, {
    mcpServers: { fixture: { command: 'never-executed', args: [] } }, prefs: { mcpDefaultOn: ['fixture'] },
  });
  const s = await h.seed();
  const result = await h.engine.listSessionMcp(s.id);
  assert.equal(result.loaded, false);
  assert.deepEqual(result.servers, []);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.list.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.discover.mock.callCount(), 0);
});

for (const action of ['unload', 'stop'] as const) {
  test(`future native schedules permit ${action} and stay paused until explicit resume`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.schedules = [{ ...schedule(), nextRunAt: new Date(Date.now() + 86_400_000).toISOString() }];
    await h.engine.listSchedules(s.id);
    const schedules = structuredClone(s.state.schedules);
    assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
    if (action === 'unload') await h.engine.unload(s.id);
    else await h.engine.stop();
    if (action === 'unload') assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
    else await assert.rejects(h.engine.getMeta(s.id), /transition/);
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
    assert.equal(s.sdk.abort.mock.callCount(), 0);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
    assert.deepEqual(s.state.schedules, schedules);
    assert.equal(h.prefs().scheduledSessions, undefined);
    await h.engine.start();
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
    assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, undefined);
    await h.engine.reload(s.id);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 2);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
    assert.deepEqual(s.state.schedules, schedules);
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
    await h.engine.stop();
    assert.equal(h.prefs().scheduledSessions, undefined);
  });
}

test('startup leaves legacy scheduled sessions unloaded with unknown counts and no native reads', async t => {
  const h = harness(t, { prefs: { scheduledSessions: { scheduled: 1 } } });
  const scheduled = await h.seed('scheduled');
  const history = await h.seed('history-only');
  scheduled.state.schedules = [schedule(42)];
  await h.engine.start();
  const before = nativeCalls(scheduled);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(scheduled.id))?.loaded, false);
  assert.equal((await h.engine.getMeta(scheduled.id))?.scheduleCount, undefined);
  assert.equal((await h.engine.getMeta(history.id))?.scheduleCount, undefined);
  assert.equal((await h.engine.getMeta(history.id))?.loaded, false);
  assert.equal(scheduled.rpc.commands.invoke.mock.callCount(), 0);
  assert.equal(scheduled.rpc.schedule.stop.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(8000);
    await nextTurn();
  }
  await h.engine.stop();
  assert.deepEqual(nativeCalls(scheduled), before);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.deepEqual(scheduled.state.schedules, [schedule(42)]);
  assert.equal(h.prefs().scheduledSessions, undefined, 'retiring stale local counts never cancels native schedules');
});

test('native expiry retains schedules without local persistence or startup resumption', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.schedules = [schedule(19)];
  await h.engine.listSchedules(s.id);
  const before = nativeCalls(s);
  h.runtime.expire(s.id, true);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(h.prefs().scheduledSessions, undefined);
  assert.deepEqual(s.state.schedules, [schedule(19)]);
  await h.engine.stop();
  await h.engine.start();
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, undefined);
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  await h.engine.stop();
});

for (const work of ['idle', 'native work', 'choices', 'unresolved send'] as const) {
  test(`idle time never polls session lists, liveness, or resources with ${work}`, async t => {
    const h = harness(t);
    const s = await h.load();
    const unloaded = await h.seed();
    await h.engine.start();
    const acceptance = deferred<string>();
    let sending: Promise<unknown> | undefined;
    let answer: ReturnType<NonNullable<SessionConfig['onUserInputRequest']>> | undefined;
    if (work === 'native work') {
      s.state.processing = true;
      s.state.activeWork = true;
      s.state.tasks = [task()];
      s.state.queue.items = [queued('native-pending', 'pending work')];
      s.state.schedules = [schedule()];
      s.emit(event('pending_messages.modified', {}));
    } else if (work === 'choices') {
      answer = h.configs.get(s.id)!.onUserInputRequest!({ question: 'Still waiting?' }, { sessionId: s.id });
    } else if (work === 'unresolved send') {
      s.sdk.send.mock.mockImplementation(() => acceptance.promise);
      sending = h.engine.prompt(s.id, 'pending acceptance');
    }
    await nextTurn();
    const before = nativeCalls(s);
    const listCalls = h.runtime.listSessions.mock.callCount();
    const probes = h.runtime.isSessionLive.mock.callCount();
    t.mock.timers.tick(7999);
    await nextTurn();
    assert.equal(h.runtime.listSessions.mock.callCount(), listCalls);
    assert.equal(h.runtime.isSessionLive.mock.callCount(), probes);
    for (const milliseconds of [1, 8000, 8000]) {
      t.mock.timers.tick(milliseconds);
      await nextTurn();
      assert.deepEqual(nativeCalls(s), before, 'no automatic native polling is permitted');
    }
    assert.equal(h.runtime.listSessions.mock.callCount(), listCalls);
    assert.equal(h.runtime.isSessionLive.mock.callCount(), probes);
    for (const call of h.runtime.isSessionLive.mock.calls.slice(probes)) assert.equal(call.arguments[0], s.sdk);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(unloaded.sdk.getEvents.mock.callCount(), 0);
    if (answer) {
      assert.ok((await h.engine.getMeta(s.id))?.ask);
      await h.engine.respondAsk(s.id, (await h.engine.getMeta(s.id))!.ask!.requestId, 'done', true);
      await answer;
    }
    if (sending) {
      acceptance.resolve('accepted-pending');
      await sending;
      s.emit(event('user.message', { content: 'pending acceptance', messageId: 'accepted-pending' }));
    }
    s.state.processing = false;
    s.state.activeWork = false;
    s.state.tasks = [];
    s.state.queue.items = [];
    s.emit(event('session.idle', {}));
    await nextTurn();
    await h.engine.stop();
  });
}

test('work events invalidate without polling or eager native activity reads', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.start();
  const before = s.rpc.metadata.activity.mock.callCount();
  s.state.processing = true;
  s.emit(event('assistant.turn_start', { turnId: 'native-work' }));
  s.emit(event('pending_messages.modified', {}));
  await nextTurn();
  assert.equal(s.rpc.metadata.activity.mock.callCount(), before);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  const synced = nativeCalls(s);
  t.mock.timers.tick(8000);
  await nextTurn();
  assert.deepEqual(nativeCalls(s), synced);
  s.state.processing = false;
  s.emit(event('session.idle', {}));
  await nextTurn();
  await h.engine.stop();
});

test('routine tool completions perform zero native reads without clearing running work', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.processing = true;
  s.emit(event('assistant.turn_start', { turnId: 'many-tools' }));
  const before = nativeCalls(s);
  const probes = h.runtime.isSessionLive.mock.callCount();
  for (let i = 0; i < 20; i++) {
    s.emit(event('tool.execution_start', { toolCallId: `tool-${i}`, toolName: 'view', arguments: { path: 'fixture' } }));
    s.emit(event('tool.execution_complete', { toolCallId: `tool-${i}`, success: true }));
    await nextTurn();
  }
  assert.deepEqual(nativeCallDelta(s, before), {});
  assert.equal(h.runtime.isSessionLive.mock.callCount(), probes);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.state.processing = false;
  s.emit(event('session.idle', {}));
  await nextTurn();
  await h.engine.unload(s.id);
});

test('reply notification reads only current control and remains quiescent after completion', async t => {

  const h = harness(t);
  const s = await h.load();
  await finishReply(s, 'Previously completed reply', 'before-boundary');
  const before = nativeCalls(s);
  s.emit(event('assistant.turn_start', { turnId: 'boundary' }));
  s.emit(assistant('boundary-answer', 'boundary-message', 'native completed reply'));
  s.emit(event('assistant.turn_end', { turnId: 'boundary' }));
  s.emit(event('session.idle', {}));
  s.emit(event('pending_messages.modified', {}));
  s.emit(event('session.background_tasks_changed', {}));
  await nextTurn();
  const delta = nativeCallDelta(s, before);
  for (const key of ['metadata.snapshot', 'model.getCurrent', 'mode.get', 'plan.readSqlTodos', 'schedule.list']) {
    assert.equal(delta[key], undefined, 'notifications need current control, not resource projections');
  }
  assert.ok(s.rpc.metadata.activity.mock.callCount() > before['metadata.activity']!);
  const settled = nativeCalls(s);
  await nextTurn();
  assert.deepEqual(nativeCalls(s), settled, 'notification control reads are finite');
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  assert.equal(h.engine.attentionCount(), 1);
});

test('a new turn after a metadata request is reflected by the next request and safety guard', async t => {

  const h = harness(t);
  const s = await h.load();
  const activity = deferred<Awaited<ReturnType<Rpc['metadata']['activity']>>>();
  s.rpc.metadata.activity.mock.mockImplementationOnce(() => activity.promise);
  const reading = h.engine.getMeta(s.id);
  await nextTurn();
  s.state.processing = true;
  s.emit(event('assistant.turn_start', { turnId: 'newer-turn' }));
  activity.resolve({ hasActiveWork: false, abortable: false });
  await reading;
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  assert.equal(h.engine.attentionCount(), 0);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
});

test('task lifecycle reads native status and treats idle agents as idle, not protected work', async t => {
  const h = harness(t);
  const s = await h.load();
  const before = nativeCalls(s);
  s.state.tasks = [task()];
  s.emit(event('session.background_tasks_changed', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.activeSubagents, 1);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  s.state.tasks = [task('idle')];
  s.emit(event('session.background_tasks_changed', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.activeSubagents, 0);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  assert.equal(s.rpc.tasks.list.mock.callCount() - before['tasks.list']!, 4, 'each metadata request rereads tasks');
  await h.engine.stop();
});

test('task-tool completion confirms the remaining native registry instead of trusting tool completion as idle', async t => {
  const h = harness(t);
  const s = await h.load();
  s.emit(event('tool.execution_start', { toolCallId: 'spawn-tool-call', toolName: 'task', arguments: {} }));
  s.state.tasks = [task()];
  const before = nativeCalls(s);
  s.emit(event('tool.execution_complete', { toolCallId: 'spawn-tool-call', success: true }));
  await nextTurn();
  assert.deepEqual(nativeCallDelta(s, before), {}, 'tool completion only invalidates');
  assert.equal((await h.engine.getMeta(s.id))?.activeSubagents, 1);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  s.state.tasks = [task('idle')];
  s.emit(event('session.background_tasks_changed', {}));
  await nextTurn();
  await h.engine.unload(s.id);
});

test('resource events invalidate without native reads and fresh MCP state still protects close', async t => {
  const h = harness(t);
  const s = await h.load();
  let before = nativeCalls(s);
  s.state.schedules = [schedule(101)];
  s.emit(event('session.schedule_created', { id: 101, prompt: 'check build', recurring: true, intervalMs: 60_000 }));
  await nextTurn();
  assert.deepEqual(nativeCallDelta(s, before), {}, 'resource events only invalidate');
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
  before = nativeCalls(s);
  s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows: [{ id: '1', title: 'work', status: 'done' }] }));
  s.emit(event('session.todos_changed', {}));
  await nextTurn();
  assert.deepEqual(nativeCallDelta(s, before), {}, 'resource events only invalidate');
  assert.deepEqual((await h.engine.getMeta(s.id))?.todo, { done: 1, total: 1, intent: null });
  before = nativeCalls(s);
  s.state.model.modelId = 'native-new-model';
  s.emit(event('session.model_change', { newModel: 'native-new-model' }));
  await nextTurn();
  assert.deepEqual(nativeCallDelta(s, before), {}, 'resource events only invalidate');
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'native-new-model');
  before = nativeCalls(s);
  s.state.mcp.host!.pendingConnections = ['native-connector'];
  s.emit(event('session.mcp_server_status_changed', { serverName: 'native-connector', status: 'pending' }));
  await nextTurn();
  assert.deepEqual(nativeCallDelta(s, before), {}, 'resource events only invalidate');
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.state.mcp.host!.pendingConnections = [];
  s.emit(event('session.mcp_server_status_changed', { serverName: 'native-connector', status: 'connected' }));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
  await h.engine.unload(s.id);
});

test('failed resource requests do not fabricate work, while unreadable MCP state protects close', async t => {

  const h = harness(t);
  const s = await h.load();
  s.rpc.plan.readSqlTodos.mock.mockImplementationOnce(async () => { throw new Error('todo read unavailable'); });
  await assert.rejects(h.engine.getMeta(s.id), /todo read unavailable/);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  s.rpc.mcp.list.mock.mockImplementation(async () => { throw new Error('MCP read unavailable'); });
  await assert.rejects(h.engine.getMeta(s.id), /MCP read unavailable/);
  await assert.rejects(h.engine.unload(s.id), /MCP read unavailable/);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.rpc.mcp.list.mock.mockImplementation(async () => mcpState());
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
  await h.engine.unload(s.id);
});

test('native pending MCP state protects mutation and held current-state checks delay closure', async t => {

  const h = harness(t);
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'pending' }]);
  s.state.mcp.host!.pendingConnections = ['fixture'];
  s.emit(event('session.mcp_server_status_changed', { serverName: 'fixture', status: 'pending' }));
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
  await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', true), protectedWork);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
  const readback = deferred<McpState>();
  s.rpc.mcp.list.mock.mockImplementationOnce(() => readback.promise);
  const unloading = h.engine.unload(s.id);
  await nextTurn();
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  readback.resolve(mcpState([{ name: 'fixture', status: 'connected' }]));
  await unloading;
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
});

test('native closure rejects a held control request before resume and ignores its late rejection', async t => {

  const h = harness(t);
  const s = await h.load();
  const held = deferred<Awaited<ReturnType<typeof s.rpc.metadata.activity>>>();
  s.rpc.metadata.activity.mock.mockImplementationOnce(() => held.promise);
  const reading = h.engine.getMeta(s.id);
  const rejected = assert.rejects(reading, /closed/);
  await nextTurn();
  h.runtime.expire(s.id, true);
  await promptly(rejected);
  await promptly(h.engine.reload(s.id));
  const meta = await h.engine.getMeta(s.id);
  held.reject(new Error('late old wrapper failure'));
  await nextTurn();
  assert.deepEqual(await h.engine.getMeta(s.id), meta);
  await promptly(h.engine.stop());
});

test('native closure releases hung resource reads and ignores their late failures after resume', async t => {

  const h = harness(t);
  const s = await h.load();
  const held = deferred<Awaited<ReturnType<typeof s.rpc.plan.readSqlTodos>>>();
  s.rpc.plan.readSqlTodos.mock.mockImplementationOnce(() => held.promise);
  const reading = h.engine.getMeta(s.id);
  const rejected = assert.rejects(reading, /closed/);
  await nextTurn();
  h.runtime.expire(s.id, true);
  await promptly(rejected);
  await promptly(h.engine.reload(s.id));
  const meta = await h.engine.getMeta(s.id);
  held.reject(new Error('late old resource failure'));
  await nextTurn();
  assert.deepEqual(await h.engine.getMeta(s.id), meta);
  await promptly(h.engine.stop());
});

test('routine closure preserves early live replies even when initialization metadata never settles', async t => {
  const h = harness(t);
  const s = await h.seed();
  const metadata = await s.rpc.metadata.snapshot();
  const eligibility = deferred<typeof metadata>();
  s.rpc.metadata.snapshot.mock.mockImplementationOnce(() => eligibility.promise);
  const loading = assert.rejects(h.engine.reload(s.id), /closed/);
  await nextTurn();
  s.emit(user('buffered-user', 'question before expiry'));
  s.emit(event('assistant.turn_start', { turnId: 'buffered-turn' }));
  s.emit(assistant('buffered-answer-event', 'buffered-answer', 'completed before expiry'));
  s.emit(event('assistant.turn_end', { turnId: 'buffered-turn' }, 'buffered-end'));
  h.runtime.expire(s.id, true);
  await promptly(loading);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal(h.engine.attentionCount(), 1);
  assert.equal(h.events.filter(event => event.type === 'session/notify').length, 1);
  await h.engine.reload(s.id);
  eligibility.resolve(metadata);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  assert.equal(h.engine.attentionCount(), 1);
  assert.equal(h.events.filter(event => event.type === 'session/notify').length, 1);
  await h.engine.stop();
});

test('native closure during an MCP mutation cannot restore phantom pending connections', async t => {
  const h = harness(t, { mcpServers: { fixture: { command: 'never-executed' } } });
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
  const enable = deferred();
  s.rpc.mcp.enable.mock.mockImplementationOnce(() => enable.promise);
  const changing = assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', true), /closed/);
  await nextTurn();
  const before = s.rpc.mcp.list.mock.callCount();
  h.runtime.expire(s.id, true);
  await promptly(changing);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, undefined);
  enable.resolve();
  await nextTurn();
  assert.equal(s.rpc.mcp.list.mock.callCount(), before);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, undefined);
  await h.engine.unload(s.id);
  await h.engine.stop();
});

test('an inbox write can be retried after native closure without any native state reads', async t => {
  const h = harness(t);
  const s = await h.load();
  mkdirSync(`${h.prefsFile}.tmp`);
  await finishReply(s, 'ready before expiry', 'closed-inbox');
  h.runtime.expire(s.id, true);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal(h.engine.attentionCount(), 0);
  const before = nativeCalls(s);
  rmSync(`${h.prefsFile}.tmp`, { recursive: true });
  await h.engine.unload(s.id);
  assert.equal(h.engine.attentionCount(), 1);
  assert.equal(h.events.filter(event => event.type === 'session/notify').length, 1);
  assert.deepEqual(nativeCalls(s), before);
  await h.engine.stop();
});

for (const source of ['runtime callback', 'passive poll'] as const) {
  test(`${source} drops an expired live projection without resuming, deleting history, or consuming inbox`, async t => {
    const h = harness(t);
    const s = await h.load();
    await h.engine.start();
    await finishReply(s, 'persist this unread reply', 'native-expiry');
    h.journals.set(s.id, structuredClone(s.state.events));
    const history = await chat(h, s.id);
    const attention = h.prefs().inbox;
    const before = nativeCalls(s);
    h.events.length = 0;
    h.runtime.expire(s.id, source === 'runtime callback');
    if (source === 'passive poll') t.mock.timers.tick(8000);
    await nextTurn();
    assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
    assert.equal((await h.engine.getMeta(s.id))?.status, 'unloaded');
    assert.equal(s.listeners.size, 0);
    assert.deepEqual(nativeCalls(s), before);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
    assert.deepEqual(h.prefs().inbox, attention);
    assert.equal(h.engine.attentionCount(), 1);
    assert.deepEqual((await chat(h, s.id)).events, history.events);
    assert.ok(!h.events.some(event => event.type === 'session/removed' || event.type === 'session/notify'));
    assert.ok(h.events.some(event => event.type === 'session/patch' && event.sessionId === s.id && event.loaded === false));
    await h.engine.stop();
  });
}

function connectionEvent(state: 'disconnected' | 'reconnecting'): SessionEvent {
  // The native event name is not included in this SDK's generated SessionEvent union.
  return { type: 'session.connection_state_changed', data: { state },
    id: randomUUID(), timestamp, parentId: null } as unknown as SessionEvent;
}

const closureSignals = [
  ['session.shutdown', () => event('session.shutdown', {
    shutdownType: 'routine', sessionStartTime: Date.parse(timestamp), totalApiDurationMs: 0,
    modelMetrics: {}, codeChanges: { filesModified: [], linesAdded: 0, linesRemoved: 0 },
  })],
  ['session.connection_state_changed disconnected', () => connectionEvent('disconnected')],
  ['session.connection_state_changed reconnecting', () => connectionEvent('reconnecting')],
] as const;
for (const [name, signal] of closureSignals) {
  for (const alive of [false, true]) {
    test(`${name} confirms attachment and ${alive ? 'keeps a live handle' : 'drops an expired handle'}`, async t => {
      const h = harness(t);
      const s = await h.load();
      const confirmation = deferred<boolean>();
      const probes = h.runtime.isSessionLive.mock.callCount();
      const before = nativeCalls(s);
      if (!alive) h.runtime.expire(s.id);
      h.runtime.isSessionLive.mock.mockImplementationOnce(async () => {
        const live = await confirmation.promise;
        if (!live) s.listeners.clear();
        return live;
      });
      s.emit(signal());
      await nextTurn();
      assert.equal(h.runtime.isSessionLive.mock.callCount(), probes + 1);
      assert.ok(activeState(h, s.id), 'a signal alone does not detach the handle before confirmation');
      assert.deepEqual(nativeCalls(s), before);
      confirmation.resolve(alive);
      await nextTurn();
      assert.deepEqual(nativeCalls(s), before, 'closure signal checks liveness, not resources');
      assert.equal((await h.engine.getMeta(s.id))?.loaded, alive);
      assert.equal(s.listeners.size, alive ? 1 : 0);
      assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
      assert.equal(h.runtime.createSession.mock.callCount(), 0);
      assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    });
  }
}

test('missing shutdown is recovered by prompt preflight, with one resume followed by one send', async t => {
  const h = harness(t);
  const s = await h.load();
  h.runtime.expire(s.id);
  const probes = h.runtime.isSessionLive.mock.callCount();
  h.trace.length = 0;
  s.sdk.send.mock.mockImplementation(async () => {
    assert.ok(h.attached.has(s.id), 'send must follow the confirmed resume');
    h.trace.push(`send:${s.id}`);
    return 'accepted-after-expiry';
  });
  await h.engine.prompt(s.id, 'explicit new prompt');
  assert.ok(h.runtime.isSessionLive.mock.callCount() > probes);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 2);
  assert.equal(s.sdk.send.mock.callCount(), 1);
  assert.deepEqual(h.trace, [`resume:${s.id}`, `send:${s.id}`]);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
});

test('new session stays private until native creation succeeds, including concurrent list refresh', async t => {
  const h = harness(t);
  const allocation = deferred();
  const create = h.runtime.createSession;
  let id!: string;
  t.mock.method(h.runtime, 'createSession', async (config: SessionConfig) => {
    id = config.sessionId!;
    h.rows.push({ sessionId: id, startTime: new Date(timestamp), modifiedTime: new Date(timestamp), isRemote: false });
    await allocation.promise;
    return create(config);
  });
  const creating = h.engine.newSession(h.cwd);
  await nextTurn();
  assert.ok(id);
  await assert.rejects(h.engine.getMeta(id), /awaiting acknowledgement/);
  assert.deepEqual((await h.engine.snapshot()).sessions, []);
  assert.ok(!h.events.some(value => value.type.startsWith('session/')));
  await h.engine.refreshList();
  await assert.rejects(h.engine.getMeta(id), /awaiting acknowledgement/);
  await assert.rejects(h.engine.stop(), protectedWork);
  allocation.resolve();
  assert.equal(await creating, id);
  assert.equal((await h.engine.getMeta(id))?.loaded, true);
  assert.equal(h.events.filter(value => value.type === 'session/added').length, 1);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
});

test('native absence leaves no unloaded state while preserving files and product preferences', async t => {

  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  await h.engine.pin(id, true);
  const draftFile = join(h.cwd, 'composer-draft.txt');
  writeFileSync(draftFile, 'unsent user text');
  const prefs = readFileSync(h.prefsFile, 'utf8');
  h.rows.length = 0;
  await h.engine.refreshList();
  assert.ok(await h.engine.getMeta(id), 'an actual live handle can read native metadata without an index row');
  h.runtime.expire(id, true);
  await h.engine.refreshList();
  assert.equal(await h.engine.getMeta(id), null);
  assert.deepEqual((await h.engine.snapshot()).sessions, []);
  assert.equal(activeState(h, id), undefined, 'unloaded projections are not retained');
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(readFileSync(draftFile, 'utf8'), 'unsent user text');
  assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs);
});

test('absence lookup cannot remove a session resumed while metadata was in flight', async t => {

  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  h.runtime.expire(id, true);
  const metadata = deferred<SessionMetadata | undefined>();
  h.runtime.getSessionMetadata.mock.mockImplementationOnce(() => metadata.promise);
  const reading = h.engine.getMeta(id);
  await nextTurn();
  await h.engine.reload(id);
  metadata.resolve(undefined);
  assert.equal(await reading, null, 'a passive caller owns its native lookup response');
  assert.equal((await h.engine.getMeta(id))?.loaded, true);
  assert.ok(!h.events.some(value => value.type === 'session/removed'));
});

test('native mode changes still read back a changed model without draft settings', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const native = h.natives.get(id)!;
  native.rpc.mode.set.mock.mockImplementationOnce(async ({ mode }) => {
    native.state.mode = mode;
    native.state.model.modelId = 'mode-selected-model';
    return { status: 'applied', modelChanged: true };
  });
  await h.engine.setMode(id, 'plan');
  assert.equal((await h.engine.getMeta(id))?.currentMode, 'plan');
  assert.equal((await h.engine.getMeta(id))?.currentModelId, 'mode-selected-model');
  assert.equal(native.sdk.send.mock.callCount(), 0);
});

test('expired empty session rejects native absence without recreating or sending', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const original = h.natives.get(id)!;
  h.runtime.expire(id, true);
  h.runtime.resumeSession.mock.mockImplementationOnce(async () => { throw new Error('native session missing'); });
  await assert.rejects(h.engine.prompt(id, 'first explicit prompt'), /native session missing/);
  assert.ok(h.runtime.getSessionMetadata.mock.callCount() > 0, 'metadata comes from the public native lookup');
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(original.sdk.send.mock.callCount(), 0);
  visibleError(h, id, /native session missing/);
  assert.equal((await h.engine.getMeta(id))?.error, undefined);
});

test('metadata lookup failure propagates without speculative recreation or remembered errors', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  h.runtime.expire(id, true);
  h.runtime.getSessionMetadata.mock.mockImplementationOnce(async () => { throw new Error('metadata unavailable'); });
  await assert.rejects(h.engine.getMeta(id), /metadata unavailable/);
  assert.ok((await h.engine.getMeta(id)));
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 0);
});

test('persisted local draft is resumed, never recreated', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  h.runtime.getSessionMetadata.mock.mockImplementationOnce(async () => ({
    sessionId: id, startTime: new Date(timestamp), modifiedTime: new Date(timestamp), isRemote: false,
  }));
  h.runtime.expire(id);
  await h.engine.prompt(id, 'first explicit prompt');
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

test('any attempted mutation permanently prevents empty-draft recreation, even with no acceptance event', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const original = h.natives.get(id)!;
  original.sdk.send.mock.mockImplementationOnce(async () => { throw new Error('delivery unknown'); });
  await assert.rejects(h.engine.prompt(id, 'uncertain send'), /delivery unknown/);
  h.runtime.expire(id);
  h.runtime.resumeSession.mock.mockImplementationOnce(async () => { throw new Error('native session missing'); });
  await assert.rejects(h.engine.prompt(id, 'new explicit prompt'), /native session missing/);
  assert.ok(h.runtime.getSessionMetadata.mock.callCount() > 0, 'metadata comes from the public native lookup');
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(original.sdk.send.mock.callCount(), 1);
});

test('unavailable prompt preflight rejects without speculatively resuming or sending', async t => {
  const h = harness(t);
  const s = await h.load();
  const before = nativeCalls(s);
  h.runtime.isSessionLive.mock.mockImplementationOnce(async () => { throw new Error('native attach unavailable'); });
  await assert.rejects(h.engine.prompt(s.id, 'do not guess delivery'), /native attach unavailable/);
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

for (const accepted of [false, true]) {
  test(`send rejection after ${accepted ? 'native acceptance' : 'uncertain delivery'} never retries; the next prompt may resume`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.sdk.send.mock.mockImplementationOnce(async () => {
      if (accepted) s.emit(event('user.message', { content: 'first prompt', messageId: 'native-accepted' }));
      h.runtime.expire(s.id);
      throw new Error('session closed after send; delivery uncertain');
    });
    await assert.rejects(h.engine.prompt(s.id, 'first prompt'), /delivery uncertain/);
    await nextTurn();
    assert.equal(s.sdk.send.mock.callCount(), 1);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(serverChatEvents(h).length, 0);
    h.journals.set(s.id, structuredClone(s.state.events));
    assert.equal((await chat(h, s.id)).events.filter(event => event.type === 'user.message').length, accepted ? 1 : 0);
    await h.engine.prompt(s.id, 'second explicit prompt');
    assert.equal(h.runtime.resumeSession.mock.callCount(), 2);
    assert.equal(s.sdk.send.mock.callCount(), 2);
    assert.equal(s.sdk.send.mock.calls[1]!.arguments[0]!.prompt, 'second explicit prompt');
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  });
}

for (const accepted of [false, true]) {
  test(`fatal runtime failure abandons ${accepted ? 'accepted' : 'hung'} sends and choices without dead metadata or close RPCs`, async t => {
    const h = harness(t);
    const sending = await h.load();
    const deciding = await h.load();
    const unread = await h.load();
    await h.engine.start();
    await finishReply(unread, 'keep the unread reply', 'fatal-history');
    h.journals.set(unread.id, structuredClone(unread.state.events));
    const savedAttention = h.prefs().inbox!.sessions[unread.id];
    const reports: Error[] = [];
    const off = h.engine.onFatal((error: Error) => reports.push(error));
    const removed = t.mock.fn();
    const removeHandler = h.engine.onFatal(removed);
    removeHandler();
    t.after(off);
    assert.equal(h.engine.failure, undefined);
    const deadSend = deferred<string>();
    if (!accepted) sending.sdk.send.mock.mockImplementation(() => deadSend.promise);
    const prompt = h.engine.prompt(sending.id, 'accepted or hung native work');
    const rejected: Promise<unknown>[] = [];
    if (accepted) await prompt;
    else rejected.push(assert.rejects(prompt, /fatal native disconnect/));
    const config = h.configs.get(deciding.id)!;
    const choices = [
      config.onUserInputRequest!({ question: 'pending ask' }, { sessionId: deciding.id }),
      config.onExitPlanModeRequest!({ summary: 'pending plan', actions: ['interactive'], recommendedAction: 'interactive' }, { sessionId: deciding.id }),
      config.onElicitationRequest!({ sessionId: deciding.id, message: 'pending elicitation' }),
    ];
    rejected.push(...choices.map(choice => assert.rejects(Promise.resolve(choice), /fatal native disconnect/)));
    const rejections = Promise.all(rejected);
    void rejections.catch(() => {});
    await nextTurn();
    assert.equal(sending.sdk.send.mock.callCount(), 1);
    const sessions = [sending, deciding, unread];
    const before = sessions.map(nativeCalls);
    const probes = h.runtime.isSessionLive.mock.callCount();
    const lists = h.runtime.listSessions.mock.callCount();
    const fatal = new Error('fatal native disconnect');
    h.runtime.emitFatal(fatal);
    await promptly(rejections);
    assert.equal(h.engine.failure, fatal);
    assert.deepEqual(reports, [fatal]);
    assert.equal(removed.mock.callCount(), 0);
    await assert.rejects(h.engine.snapshot(), /fatal native disconnect/);
    for (const s of sessions) {
      await assert.rejects(h.engine.getMeta(s.id), /fatal native disconnect/);
      assert.equal(s.listeners.size, 0);
    }
    assert.ok(h.events.some(event => event.type === 'agent/status' && event.status === 'restarting'));
    assert.deepEqual(h.prefs().inbox!.sessions[unread.id], savedAttention);
    t.mock.timers.tick(24_000);
    await nextTurn();
    assert.equal(h.runtime.listSessions.mock.callCount(), lists);
    assert.equal(h.runtime.isSessionLive.mock.callCount(), probes);
    for (const operation of [
      () => h.engine.start(), () => h.engine.newSession(h.cwd),
      () => h.engine.prompt(sending.id, 'must never send'), () => h.engine.reload(sending.id),
      () => h.engine.setModel(sending.id, 'must not mutate'), () => h.engine.cancel(sending.id),
      () => h.engine.getPlan(sending.id), () => h.engine.getPanels(sending.id),
      () => h.engine.listSchedules(sending.id), () => h.engine.listSessionSkills(sending.id),
      () => h.engine.listGlobalSkills(h.cwd), () => h.engine.refreshSkills(),
    ]) await assert.rejects(async () => operation(), /fatal native disconnect/);
    await promptly(h.engine.stop());
    assert.equal(h.runtime.stop.mock.callCount(), 1);
    assert.equal(h.runtime.start.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
    assert.equal(h.attached.size, 0, 'fatal stop cleans up outstanding wrappers without close');
    assert.deepEqual(sessions.map(nativeCalls), before);
    assert.equal(h.engine.failure, fatal);
    await assert.rejects(h.engine.start(), /fatal native disconnect/);
    deadSend.resolve('late-native-acceptance');
    await nextTurn();
    await assert.rejects(h.engine.snapshot(), /fatal native disconnect/);
    await assert.rejects(h.engine.getMeta(sending.id), /fatal native disconnect/);
    assert.deepEqual(sessions.map(nativeCalls), before, 'late native completion cannot restart synchronization');
  });
}

test('a new Engine cannot reuse a runtime whose failure is already terminal', async t => {
  const h = harness(t);
  const fatal = new Error('fatal before replacement engine');
  h.runtime.emitFatal(fatal);
  const replacement = new Engine({ runtime: h.runtime as unknown as EngineRuntime, prefsFile: h.prefsFile });
  await assert.rejects(replacement.start(), /fatal before replacement engine/);
  await assert.rejects(replacement.newSession(h.cwd), /fatal before replacement engine/);
  assert.equal(replacement.failure, fatal);
  assert.equal(h.runtime.start.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  await promptly(replacement.stop());
});

test('fatal runtime failure rejects a hung native model readback and permits stop before it settles', async t => {

  const h = harness(t);
  const s = await h.load();
  await h.engine.start();
  const readback = deferred<typeof s.state.model>();
  s.rpc.model.getCurrent.mock.mockImplementationOnce(() => readback.promise);
  const changing = assert.rejects(h.engine.setModel(s.id, 'pending-model'), /fatal during model readback/);
  await nextTurn();
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 1);
  const before = nativeCalls(s);
  h.runtime.emitFatal(new Error('fatal during model readback'));
  await promptly(changing);
  await promptly(h.engine.stop());
  await assert.rejects(h.engine.getMeta(s.id), /fatal during model readback/);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.stop.mock.callCount(), 1);
  assert.deepEqual(nativeCalls(s), before);
  readback.resolve(structuredClone(s.state.model));
  await nextTurn();
  await assert.rejects(h.engine.snapshot(), /fatal during model readback/);
  assert.deepEqual(nativeCalls(s), before);
});

test('fatal while startup is hung rejects start and permits cleanup without waiting or restarting', async t => {
  const h = harness(t);
  const startup = deferred<void>();
  h.runtime.start.mock.mockImplementation(() => startup.promise);
  const starting = assert.rejects(h.engine.start(), /fatal startup while pending/);
  void starting.catch(() => {});
  await nextTurn();
  const fatal = new Error('fatal startup while pending');
  h.runtime.emitFatal(fatal);
  await promptly(starting);
  await promptly(h.engine.stop());
  assert.equal(h.engine.failure, fatal);
  await assert.rejects(h.engine.snapshot(), /fatal startup/);
  await assert.rejects(h.engine.start(), /fatal startup while pending/);
  assert.equal(h.runtime.start.mock.callCount(), 1);
  startup.resolve();
  await nextTurn();
  t.mock.timers.tick(8000);
  await nextTurn();
  assert.equal(h.runtime.listSessions.mock.callCount(), 0);
  assert.ok(!h.events.some(event => event.type === 'agent/status' && event.status === 'up'));
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('snapshots read fresh native models and sessions and return independent mutable copies', async t => {
  const h = harness(t);
  const s = await h.load();
  const models: ModelOption[] = [{
    modelId: 'available-model', name: 'Available model', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'low', supportsLongContext: true,
  }];
  h.runtime.models.mock.mockImplementation(async () => structuredClone(models));
  try {
    await h.engine.start();
    const snapshot = (await h.engine.snapshot());
    assert.equal(snapshot instanceof Promise, false);
    assert.equal(snapshot.agentStatus, 'up');
    assert.deepEqual(snapshot.models, models);
    const before = structuredClone(snapshot);
    snapshot.models[0]!.name = 'caller mutation';
    snapshot.models[0]!.supportedReasoningEfforts!.push('invented');
    snapshot.models.length = 0;
    snapshot.sessions[0]!.title = 'caller title';
    snapshot.sessions[0]!.queue!.push({ id: 'caller-queue', text: 'not native' });
    snapshot.sessions.length = 0;
    assert.deepEqual((await h.engine.snapshot()), before);
    const meta = (await h.engine.getMeta(s.id))!;
    meta.queue!.push({ id: 'caller-meta-queue', text: 'not native either' });
    assert.deepEqual((await h.engine.getMeta(s.id)), before.sessions[0]);
    assert.equal(h.runtime.models.mock.callCount(), 3, 'seed refresh plus two explicit snapshots fetch native models');
    models[0]!.name = 'Updated native catalog';
    assert.equal((await h.engine.snapshot()).models[0]!.name, 'Updated native catalog');
  } finally {
    await h.engine.stop();
  }
});

test('send acceptance does not invent a message, complete a turn, or permit teardown', async t => {
  const h = harness(t);
  const s = await h.load();
  const acceptance = deferred<string>();
  s.sdk.send.mock.mockImplementation(() => acceptance.promise);
  h.events.length = 0;
  const result = h.engine.prompt(s.id, 'queued instruction');
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  assert.equal(serverChatEvents(h).length, 0);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  acceptance.resolve('native-accepted-id');
  assert.deepEqual(await result, { ok: true });
  await nextTurn();
  assert.deepEqual(s.sdk.send.mock.calls[0]!.arguments, [{ prompt: 'queued instruction', mode: 'enqueue', attachments: undefined }]);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  assert.ok(!h.events.some(event => event.type === 'session/notify' && event.attention === 'ready'));
  for (const operation of [() => h.engine.unload(s.id), () => h.engine.stop()]) {
    await assert.rejects(operation(), protectedWork);
  }
  s.state.processing = true;
  s.emit(event('user.message', { content: 'queued instruction', messageId: 'native-accepted-id' }, 'native-user-event'));
  assert.equal(serverChatEvents(h).length, 0);
  assert.deepEqual((await chat(h, s.id, { source: 'live' })).events.map(event => event.id), ['native-user-event']);
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running', 'idle event cannot override native processing');
  s.state.processing = false;
  s.emit(assistant('answer-event', 'answer-message'));
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal((await chat(h, s.id, { source: 'live' })).events.find(event => event.id === 'answer-event')?.data.messageId, 'answer-message');
  await h.engine.unload(s.id);
  assert.equal(h.runtime.closeSession.mock.callCount(), 1);
});

for (const separateEventId of [false, true]) {
  test(`a user event before send resolves consumes its native acceptance (${separateEventId ? 'separate event and message IDs' : 'matching event ID'})`, async t => {
    const h = harness(t);
    const s = await h.load();
    const eventId = separateEventId ? 'different-event-id' : 'accepted-before-return';
    s.sdk.send.mock.mockImplementation(async () => {
      s.emit(event('user.message', { content: 'native user message', messageId: 'accepted-before-return' }, eventId));
      return 'accepted-before-return';
    });
    await h.engine.prompt(s.id, 'native synchronous acceptance');
    s.emit(event('session.idle', {}));
    await nextTurn();
    assert.equal(serverChatEvents(h).length, 0);
    assert.equal((await chat(h, s.id, { source: 'live' })).events.filter(event => event.id === eventId).length, 1);
    assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
    await h.engine.unload(s.id);
  });
}

test('send rejection surfaces native failure without an optimistic user message', async t => {
  const h = harness(t);
  const s = await h.load();
  s.sdk.send.mock.mockImplementation(async () => { throw new Error('native send rejected'); });
  await assert.rejects(h.engine.prompt(s.id, 'not accepted'), /native send rejected/);
  await nextTurn();
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  visibleError(h, s.id, /native send rejected/);
});

test('attachment-only sends preserve file descriptors without reading the attachment', async t => {
  const h = harness(t);
  const s = await h.load();
  const path = join(h.cwd, 'not-created.pdf');
  await h.engine.prompt(s.id, '', 'immediate', [{ type: 'file', path, displayName: 'spec.pdf' }]);
  assert.deepEqual(s.sdk.send.mock.calls[0]!.arguments, [{
    prompt: '', mode: 'immediate', attachments: [{ type: 'file', path, displayName: 'spec.pdf' }],
  }]);
  assert.equal(serverChatEvents(h).length, 0);
  await h.engine.cancel(s.id);
  await assert.rejects(h.engine.prompt(s.id, '  '), /empty/);
  assert.equal(s.sdk.send.mock.callCount(), 1);
});

test('native queue IDs survive duplicate text and reordering; removal targets an ID, not an index', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.queue.items = [queued('queue-a', 'duplicate'), queued('queue-b', 'duplicate')];
  s.emit(event('pending_messages.modified', {}));
  await nextTurn();
  assert.deepEqual((await h.engine.getMeta(s.id))?.queue, [{ id: 'queue-a', text: 'duplicate' }, { id: 'queue-b', text: 'duplicate' }]);
  s.state.queue.items.reverse();
  s.emit(event('pending_messages.modified', {}));
  await nextTurn();
  assert.deepEqual((await h.engine.getMeta(s.id))?.queue?.map(item => item.id), ['queue-b', 'queue-a']);
  await h.engine.removeQueued(s.id, 'queue-a');
  assert.deepEqual(s.rpc.queue.removeAt.mock.calls[0]!.arguments, [{ id: 'queue-a' }]);
  assert.deepEqual((await h.engine.getMeta(s.id))?.queue, [{ id: 'queue-b', text: 'duplicate' }]);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

for (const failure of ['not-removed', 'rpc-rejected'] as const) {
  test(`queue removal ${failure} retains the visible native queue and reports failure`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.queue.items = [queued('stable-id', 'keep me')];
    s.emit(event('pending_messages.modified', {}));
    await nextTurn();
    const before = (await h.engine.getMeta(s.id))!.queue;
    s.rpc.queue.removeAt.mock.mockImplementation(async () => {
      if (failure === 'rpc-rejected') throw new Error('queue removal rejected');
      return { removed: false };
    });
    await assert.rejects(h.engine.removeQueued(s.id, 'stable-id'), /addressable|queue removal rejected/);
    assert.deepEqual((await h.engine.getMeta(s.id))?.queue, before);
    visibleError(h, s.id, /addressable|queue removal rejected/);
    await assert.rejects(h.engine.unload(s.id), protectedWork);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  });
}

test('removing one queue entry cannot discard another accepted but not yet journaled send', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.queue.items = [queued('older-queue-id', 'older')];
  s.sdk.send.mock.mockImplementation(async () => 'unobserved-acceptance');
  await h.engine.prompt(s.id, 'not in the queue snapshot yet');
  await h.engine.removeQueued(s.id, 'older-queue-id');
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

for (const failedInit of [false, true]) {
test(`live reply attention survives in-flight native initialization (initialization failure: ${failedInit})`, async t => {
  const h = harness(t);
  const s = await h.seed();
  const mode = deferred<Mode>();
  s.rpc.mode.get.mock.mockImplementationOnce(() => mode.promise);
  const loading = h.engine.reload(s.id);
  const outcome = failedInit ? assert.rejects(loading, /initial mode unavailable/) : loading;
  await nextTurn();
  assert.equal(s.sdk.on.mock.callCount(), 1);
  assert.equal(s.listeners.size, 1);
  s.emit(event('assistant.turn_start', { turnId: 'overlap' }));
  s.emit(assistant('native-event-id', 'canonical-message-id', 'streamed once'));
  s.emit(event('assistant.turn_end', { turnId: 'overlap' }));
  if (failedInit) mode.reject(new Error('initial mode unavailable'));
  else mode.resolve('interactive');
  await outcome;
  await nextTurn();
  assert.equal(h.engine.attentionCount(), 1, 'early live completion still becomes unread');
  assert.equal(h.events.filter(event => event.type === 'session/notify').length, 1);
  s.emit(assistant('native-event-id', 'canonical-message-id', 'streamed once'));
  assert.equal(serverChatEvents(h).length, 0);
  s.emit(assistant('second-event-id', 'canonical-message-id', 'confirmed final'));
  const page = await chat(h, s.id, { source: 'live' });
  assert.equal(page.events.find(event => event.id === 'second-event-id')?.data.content, 'confirmed final');
  assert.equal(serverChatEvents(h).length, 0);
  const lateCallback = [...s.listeners][0]!;
  await h.engine.unload(s.id);
  assert.equal(s.listeners.size, 0);
  const meta = (await h.engine.getMeta(s.id));
  lateCallback(event('assistant.turn_start', { turnId: 'detached-turn' }));
  assert.deepEqual((await h.engine.getMeta(s.id)), meta);
  assert.equal(serverChatEvents(h).length, 0);
});
}

for (const operation of ['create', 'resume'] as const) {
  test(`native early onEvent captures ${operation} work before returning its handle`, async t => {
    const h = harness(t);
    const s = await h.seed();
    const opened = deferred<CopilotSession>();
    const allocate = async (config: SessionConfig) => {
      assert.ok(config.onEvent);
      s.sdk.on(config.onEvent);
      const sdk = await opened.promise;
      h.attached.add(s.id);
      return sdk;
    };
    if (operation === 'create') {
      h.runtime.createSession.mock.mockImplementation(async config => {
        s.sdk.sessionId = config.sessionId!;
        s.id = config.sessionId!;
        h.natives.set(s.id, s);
        return allocate(config);
      });
    } else h.runtime.resumeSession.mock.mockImplementation(async (_id, config) => allocate(config));
    const loading = operation === 'create' ? h.engine.newSession(h.cwd) : h.engine.reload(s.id);
    await nextTurn();
    s.emit(user('early-user'));
    s.emit(event('assistant.turn_start', { turnId: 'early-turn' }));
    s.emit({ ...event('assistant.message_delta', { messageId: 'early-answer', deltaContent: 'final once' }), ephemeral: true });
    s.emit(assistant('early-final', 'early-answer', 'final once'));
    s.emit(event('assistant.turn_end', { turnId: 'early-turn' }, 'early-end'));
    const lateCallback = [...s.listeners][0]!;
    opened.resolve(s.sdk as unknown as CopilotSession);
    await loading;
    await nextTurn();
    assert.equal(s.sdk.on.mock.callCount(), 1, 'Engine must not add a second late subscription');
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
    assert.equal((await chat(h, s.id, { source: 'live' })).events.find(event => event.id === 'early-final')?.data.content, 'final once');
    assert.equal('fold' in activeState(h, s.id), false);
    assert.equal(serverChatEvents(h).length, 0, 'early display events stay in native history, not SSE');
    assert.equal(h.events.filter(value => value.type === 'session/notify').length, 1);
    await h.engine.unload(s.id);
    const meta = (await h.engine.getMeta(s.id));
    lateCallback(event('assistant.turn_start', { turnId: 'stale-turn' }));
    lateCallback(assistant('old-handle-event', 'old-handle-message'));
    assert.deepEqual((await h.engine.getMeta(s.id)), meta, 'a late old callback cannot revive control state');
    assert.equal(serverChatEvents(h).length, 0);
  });
}

test('failed early allocation discards its callback and never reclassifies received work as an empty draft', async t => {
  const h = harness(t);
  let oldCallback!: NonNullable<SessionConfig['onEvent']>;
  let id!: string;
  h.runtime.createSession.mock.mockImplementationOnce(async config => {
    id = config.sessionId!;
    oldCallback = config.onEvent!;
    oldCallback(user('accepted-before-create-failure'));
    throw new Error('create acknowledgement lost');
  });
  await assert.rejects(h.engine.newSession(h.cwd), /acknowledgement lost/);
  oldCallback(assistant('late-failed-create', 'late-failed-create'));
  await assert.rejects(h.engine.prompt(id, 'must not recreate'), /Unknown session/);
  assert.equal((await h.engine.getMeta(id)), null);
  assert.ok(!h.events.some(value => 'sessionId' in value && value.sessionId === id));
  assert.ok(!h.events.some(value => value.type === 'session/added'));
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(serverChatEvents(h).length, 0);
});

test('native closure before resume returns preserves the buffered reply without installing the closed handle', async t => {
  const h = harness(t);
  const s = await h.seed();
  h.runtime.resumeSession.mock.mockImplementationOnce(async (_id, config) => {
    assert.ok(config.onEvent);
    s.sdk.on(config.onEvent);
    s.emit(event('assistant.turn_start', { turnId: 'closed-before-return' }));
    s.emit(assistant('closed-before-return-final', 'closed-before-return-final', 'finished before native close'));
    s.emit(event('assistant.turn_end', { turnId: 'closed-before-return' }, 'closed-before-return-end'));
    h.runtime.expire(s.id, true);
    return s.sdk as unknown as CopilotSession;
  });
  await assert.rejects(h.engine.reload(s.id), /closed while loading/);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal(h.events.filter(value => value.type === 'session/notify').length, 1);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 0);
  assert.equal(s.listeners.size, 0);
});

test('failed initialization metadata preserves early reply attention and native user acknowledgements', async t => {
  const h = harness(t);
  const s = await h.seed();
  const reading = deferred<Awaited<ReturnType<Rpc['metadata']['snapshot']>>>();
  s.rpc.metadata.snapshot.mock.mockImplementationOnce(() => reading.promise);
  const loading = assert.rejects(h.engine.reload(s.id), /initial metadata read failed/);
  await nextTurn();
  s.emit(user('read-failed-user'));
  s.emit(event('assistant.turn_start', { turnId: 'read-failed-turn' }));
  s.emit({ ...event('assistant.message_delta', { messageId: 'read-failed-answer', deltaContent: 'partial' }), ephemeral: true });
  s.emit(assistant('read-failed-final', 'read-failed-answer', 'final answer'));
  s.emit(event('assistant.turn_end', { turnId: 'read-failed-turn' }, 'read-failed-end'));
  reading.reject(new Error('initial metadata read failed'));
  await loading;
  await nextTurn();
  assert.equal((await chat(h, s.id, { source: 'live' })).events.find(event => event.id === 'read-failed-final')?.data.content, 'final answer');
  assert.equal(h.events.filter(value => value.type === 'session/notify').length, 1);
  s.sdk.send.mock.mockImplementationOnce(async () => {
    s.emit(user('read-failed-accepted'));
    return 'read-failed-accepted';
  });
  await h.engine.prompt(s.id, 'acknowledged after initialization failure');
  s.emit(event('session.idle', {}));
  await nextTurn();
  await h.engine.unload(s.id);
  assert.equal(h.runtime.closeSession.mock.callCount(), 1, 'native acknowledgement releases send protection');
  assert.equal(serverChatEvents(h).length, 0);
});

const nativeBusyCases = [
  ['metadata.isProcessing', (s: ReturnType<typeof fakeSession>) => { s.state.processing = true; }],
  ['metadata.activity', (s: ReturnType<typeof fakeSession>) => { s.state.activeWork = true; }],
  ['background task', (s: ReturnType<typeof fakeSession>) => { s.state.tasks = [task()]; }],
  ['idle agent with native active work', (s: ReturnType<typeof fakeSession>) => {
    s.state.tasks = [task('idle')];
    s.state.activeWork = true;
  }],
  ['queued message', (s: ReturnType<typeof fakeSession>) => {
    s.state.queue.items = [queued('pending', 'native pending')];
  }],
  ['steering message', (s: ReturnType<typeof fakeSession>) => { s.state.queue.steeringMessages = ['native steer']; }],
] as const;
for (const [name, makeBusy] of nativeBusyCases) {
  test(`${name} protects an apparently idle session from native teardown`, async t => {
    const h = harness(t);
    const s = await h.load();
    assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
    makeBusy(s);
    await assert.rejects(h.engine.unload(s.id), protectedWork);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
    assert.ok(s.rpc.metadata.isProcessing.mock.callCount() >= 2);
    assert.equal((await h.engine.getMeta(s.id))?.closing, false);
  });
}

for (const action of ['unload', 'stop'] as const) {
  test(`native MCP pending connections prevent ${action} without a Cockpit mutation`, async t => {
    const h = harness(t);
    const s = await h.load();
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
    s.state.mcp.host!.pendingConnections = ['native-connector'];
    const teardown = () => action === 'unload' ? h.engine.unload(s.id) : h.engine[action]();
    await assert.rejects(teardown(), protectedWork);
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
    assert.equal((await h.engine.getMeta(s.id))?.closing, false);
    assert.equal(s.listeners.size, 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    assert.equal(h.runtime.start.mock.callCount(), 0);
    assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
    assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
    s.state.mcp.host!.pendingConnections = [];
    await teardown();
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
    if (action === 'stop') await assert.rejects(h.engine.getMeta(s.id), /transition/);
    else {
      assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, undefined);
      assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
    }
  });

  test(`${action} cannot use delayed native validation to overwrite a newer live turn`, async t => {
    const h = harness(t);
    const s = await h.load();
    const validating = deferred();
    const readback = deferred<McpState>();
    const staleIdleMcp = structuredClone(s.state.mcp);
    s.rpc.mcp.list.mock.mockImplementationOnce(() => {
      validating.resolve();
      return readback.promise;
    });
    const teardown = () => action === 'unload' ? h.engine.unload(s.id) : h.engine[action]();
    const rejected = assert.rejects(teardown(), protectedWork);
    await validating.promise;
    await assert.rejects(h.engine.getMeta(s.id), /transition/);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    s.state.processing = true;
    s.emit(event('assistant.turn_start', { turnId: 'new-live-turn' }));
    await assert.rejects(h.engine.getMeta(s.id), /transition/);
    h.events.length = 0;
    readback.resolve(staleIdleMcp);
    await rejected;
    assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
    assert.equal((await h.engine.getMeta(s.id))?.closing, false);
    assert.equal(s.listeners.size, 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    assert.equal(h.runtime.start.mock.callCount(), 0);
    assert.ok(!h.events.some(event => event.type === 'session/patch' && event.status === 'idle'));
    assert.ok(!h.events.some(event => event.type === 'session/notify' && event.attention === 'ready'));
    s.state.processing = false;
    s.emit(event('session.idle', {}));
    await nextTurn();
    await teardown();
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  });
}

for (const action of ['stop'] as const) {
  for (const failure of ['busy', 'rpc-error'] as const) {
    test(`${action} validates the entire cohort before closing anything (${failure})`, async t => {
      const h = harness(t);
      const first = await h.load();
      const second = await h.load();
      if (failure === 'busy') second.state.processing = true;
      else second.rpc.metadata.isProcessing.mock.mockImplementation(async () => { throw new Error('processing unavailable'); });
      await assert.rejects(h.engine[action](), /protected|processing unavailable/);
      assert.equal(h.runtime.closeSession.mock.callCount(), 0);
      assert.equal(h.runtime.stop.mock.callCount(), 0);
      assert.equal(h.runtime.start.mock.callCount(), 0);
      if (failure === 'rpc-error') {
        await assert.rejects(h.engine.getMeta(second.id), /processing unavailable/);
        second.rpc.metadata.isProcessing.mock.mockImplementation(async () => ({ processing: false }));
      }
      for (const s of [first, second]) {
        assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
        assert.equal((await h.engine.getMeta(s.id))?.closing, false);
        assert.equal(s.listeners.size, 1);
      }
      await h.engine.pin(first.id, true);
    });
  }
}

test('native validation failure waits for sibling RPCs before releasing the lifecycle gate', async t => {
  const h = harness(t);
  const s = await h.load();
  const pendingTasks = deferred<{ tasks: NativeTask[] }>();
  s.rpc.tasks.list.mock.mockImplementation(() => pendingTasks.promise);
  s.rpc.metadata.isProcessing.mock.mockImplementation(async () => { throw new Error('processing lookup failed'); });
  const stopped = assert.rejects(h.engine.stop(), /processing lookup failed/);
  await nextTurn();
  await assert.rejects(h.engine.getMeta(s.id), /transition/);
  await assert.rejects(h.engine.prompt(s.id, 'must not cross validation'), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  pendingTasks.resolve({ tasks: [] });
  await stopped;
  s.rpc.metadata.isProcessing.mock.mockImplementation(async () => ({ processing: false }));
  assert.equal((await h.engine.getMeta(s.id))?.closing, false);
});

test('explicit stop/start closes handles and rereads native indexed metadata without a fallback cache', async t => {

  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const native = h.natives.get(id)!;
  await h.engine.rename(id, 'confirmed local title');
  await h.engine.setModel(id, 'confirmed-model', 'high', 'long_context');
  await h.engine.pin(id, true);
  h.trace.length = 0;
  await h.engine.stop();
  await h.engine.start();
  assert.deepEqual(h.trace, [`close:${id}`, 'stop', 'start']);
  h.rows[0]!.summary = 'current indexed title';
  await h.engine.refreshList();
  const unloaded = (await h.engine.getMeta(id))!;
  assert.equal(unloaded.title, 'current indexed title');
  assert.equal(unloaded.pinned, true);
  assert.equal(unloaded.currentModelId, undefined);
  assert.equal(unloaded.loaded, false);
  assert.equal(activeState(h, id), undefined);
  assert.equal(native.listeners.size, 0);
  await h.engine.reload(id);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal((await h.engine.getMeta(id))?.title, 'confirmed local title');
  assert.equal((await h.engine.getMeta(id))?.currentModelId, 'confirmed-model');
});

for (const stage of ['start', 'models'] as const) {
  test(`fatal startup during ${stage} stays restarting and cannot restart the same engine`, async t => {
    const h = harness(t);
    const fatal = new Error(`fatal startup ${stage}`);
    const reported: Error[] = [];
    const off = h.engine.onFatal((error: Error) => reported.push(error));
    t.after(off);
    h.runtime[stage].mock.mockImplementationOnce(async () => {
      h.runtime.emitFatal(fatal);
      throw fatal;
    });
    if (stage === 'start') await assert.rejects(h.engine.start(), /fatal startup/);
    else {
      await h.engine.start();
      await assert.rejects(h.engine.snapshot(), /fatal startup/);
    }
    assert.equal(h.engine.failure, fatal);
    assert.deepEqual(reported, [fatal]);
    await assert.rejects(h.engine.snapshot(), /fatal startup/);
    assert.equal(h.events.filter(event => event.type === 'agent/status').at(-1)?.status, 'restarting');
    await assert.rejects(h.engine.start(), /fatal startup/);
    await assert.rejects(h.engine.newSession(h.cwd), /fatal startup/);
    assert.equal(h.runtime.start.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    await h.engine.stop();
    await assert.rejects(h.engine.start(), /fatal startup/);
    const listsAfterStop = h.runtime.listSessions.mock.callCount();
    t.mock.timers.tick(8000);
    await nextTurn();
    assert.equal(h.runtime.listSessions.mock.callCount(), listsAfterStop);
    assert.equal(h.runtime.start.mock.callCount(), 1, 'fatal recovery requires a new runtime and engine');
  });
}

test('idle and completed background tasks do not prevent a clean stop', async t => {
  const h = harness(t);
  const a = await h.load();
  const b = await h.load();
  a.state.tasks = [task('completed'), { ...task('failed'), id: 'failed-id' },
    { ...task('cancelled'), id: 'cancelled-id' }, { ...task('idle'), id: 'idle-id' }];
  a.rpc.metadata.activity.mock.mockImplementation(async () => ({ hasActiveWork: false, abortable: true }));
  await h.engine.stop();
  assert.equal(h.runtime.closeSession.mock.callCount(), 2);
  assert.equal(h.runtime.stop.mock.callCount(), 1);
  await assert.rejects(h.engine.getMeta(a.id), /transition/);
  await assert.rejects(h.engine.getMeta(b.id), /transition/);
});

for (const action of ['create', 'resume'] as const) {
  for (const protectedCohort of [false, true]) {
  test(`capacity-like ${action} failure does not retry or touch ${protectedCohort ? 'busy' : 'idle'} peers`, async t => {
    const h = harness(t);
    const a = await h.load();
    const b = await h.load();
    b.state.processing = protectedCohort;
    const incoming = await h.seed();
    const resumes = h.runtime.resumeSession.mock.callCount();
    const peerCounters = [nativeCalls(a), nativeCalls(b)];
    const error = new Error('Runtime session capacity reached; safely recycle idle sessions first');
    h.runtime[action === 'create' ? 'createSession' : 'resumeSession'].mock.mockImplementationOnce(async () => { throw error; });
    h.trace.length = 0;
    await assert.rejects(action === 'create' ? h.engine.newSession(h.cwd) : h.engine.reload(incoming.id), /capacity/);
    assert.equal(h.runtime.createSession.mock.callCount(), action === 'create' ? 1 : 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes + (action === 'resume' ? 1 : 0));
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    assert.equal(h.runtime.start.mock.callCount(), 0);
    assert.deepEqual(h.trace, []);
    assert.deepEqual([nativeCalls(a), nativeCalls(b)], peerCounters);
    assert.equal((await h.engine.getMeta(a.id))?.loaded, true);
    assert.equal((await h.engine.getMeta(b.id))?.loaded, true);
    assert.equal((await h.engine.getMeta(incoming.id))?.loaded, false);
    assert.equal(h.runtime.liveCount, 2);
  });
  }
}

test('unload forgets live metadata and later resume reads native settings again', async t => {

  const h = harness(t);
  const s = await h.load();
  await h.engine.rename(s.id, 'new native title');
  await h.engine.setModel(s.id, 'new native model');
  await h.engine.unload(s.id);
  h.rows[0]!.summary = 'indexed title changed elsewhere';
  await h.engine.refreshList();
  const after = (await h.engine.getMeta(s.id))!;
  assert.equal(after.title, 'indexed title changed elsewhere');
  assert.equal(after.currentModelId, undefined);
  assert.equal(after.cwd, h.cwd);
  assert.equal(activeState(h, s.id), undefined);
  await h.engine.reload(s.id);
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'new native model');
});

for (const action of ['stop'] as const) {
  test(`${action} never stops the runtime after a close failure and retains its handles`, async t => {
    const h = harness(t);
    const a = await h.load();
    const b = await h.load();
    h.runtime.closeSession.mock.mockImplementation(async () => { throw new Error('close not acknowledged'); });
    await assert.rejects(h.engine[action](), /close not acknowledged/);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    assert.equal(h.runtime.start.mock.callCount(), 0);
    assert.equal(h.attached.size, 2);
    for (const s of [a, b]) {
      assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
      assert.equal((await h.engine.getMeta(s.id))?.closing, false);
      assert.equal(s.listeners.size, 1);
    }
  });
}

test('explicit reload blocks unload, cancel, and stop until resume completes', async t => {
  const h = harness(t);
  const s = await h.seed();
  const opened = deferred<CopilotSession>();
  h.runtime.resumeSession.mock.mockImplementation(async (id, config) => {
    if (config.onEvent) s.sdk.on(config.onEvent);
    const sdk = await opened.promise;
    h.configs.set(id, config);
    h.attached.add(id);
    return sdk;
  });
  const loading = h.engine.reload(s.id);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.loading, true);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  for (const operation of [() => h.engine.unload(s.id), () => h.engine.cancel(s.id), () => h.engine.stop()]) {
    await assert.rejects(async () => operation(), protectedWork);
  }
  opened.resolve(s.sdk as unknown as CopilotSession);
  await loading;
  assert.equal((await h.engine.getMeta(s.id))?.loading, false);
  assert.equal(s.sdk.on.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('in-flight model operations protect otherwise idle sessions until native read-back settles', async t => {

  const h = harness(t);
  const s = await h.load();
  const readback = deferred<typeof s.state.model>();
  s.rpc.model.getCurrent.mock.mockImplementationOnce(() => readback.promise);
  const changing = h.engine.setModel(s.id, 'next-model');
  await nextTurn();
  assert.ok((await h.engine.getMeta(s.id))!.activeOperations! > 0);
  for (const operation of [() => h.engine.unload(s.id), () => h.engine.cancel(s.id), () => h.engine.stop()]) {
    await assert.rejects(operation(), protectedWork);
  }
  s.state.model.modelId = 'confirmed-next-model';
  readback.resolve(structuredClone(s.state.model));
  await changing;
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'confirmed-next-model');
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  await h.engine.unload(s.id);
});

test('manual compaction protects the session until the RPC settles and clears its progress flag on rejection', async t => {
  const h = harness(t);
  const s = await h.load();
  const compact = deferred<Awaited<ReturnType<Rpc['history']['compact']>>>();
  s.rpc.history.compact.mock.mockImplementation(() => compact.promise);
  const outcome = assert.rejects(h.engine.compact(s.id, 'retain decisions'), /compaction refused/);
  await nextTurn();
  assert.ok((await h.engine.getMeta(s.id))!.activeOperations! > 0);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  await assert.rejects(h.engine.stop(), protectedWork);
  compact.reject(new Error('compaction refused'));
  await outcome;
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  assert.deepEqual(s.rpc.history.compact.mock.calls[0]!.arguments, [{ customInstructions: 'retain decisions' }]);
  visibleError(h, s.id, /compaction refused/);
  await h.engine.unload(s.id);
});

test('structured unsuccessful compaction rejects without fabricating a history reset or retaining progress', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.history.compact.mock.mockImplementation(async () => ({ success: false, tokensRemoved: 0, messagesRemoved: 0 }));
  h.events.length = 0;
  await assert.rejects(h.engine.compact(s.id, 'retain decisions'), /compaction.*unsuccessful/i);
  assert.deepEqual(s.rpc.history.compact.mock.calls[0]!.arguments, [{ customInstructions: 'retain decisions' }]);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  assert.equal(serverChatEvents(h).length, 0);
  assert.ok(!h.events.some(event => event.type === 'chat/invalidated'));
  assert.equal(s.sdk.send.mock.callCount(), 0);
  visibleError(h, s.id, /compaction.*unsuccessful/i);
  await h.engine.unload(s.id);
});

test('closing blocks new operations and competing transitions until close is acknowledged', async t => {
  const h = harness(t);
  const s = await h.load();
  const close = deferred();
  h.runtime.closeSession.mock.mockImplementation(async sdk => { await close.promise; h.attached.delete(sdk.sessionId); });
  const unloading = h.engine.unload(s.id);
  await nextTurn();
  await assert.rejects(h.engine.getMeta(s.id), /transition/);
  for (const operation of [
    () => h.engine.prompt(s.id, 'not sent'), () => h.engine.reload(s.id), () => h.engine.deleteSession(s.id, true),
    () => h.engine.cancel(s.id), () => h.engine.stop(),
  ]) await assert.rejects(async () => operation(), protectedWork);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  await assert.rejects(h.engine.getMeta(s.id), /transition/);
  close.resolve();
  await unloading;
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal((await h.engine.getMeta(s.id))?.closing, undefined);
});

test('cancellation coalesces, blocks concurrent operations, and does not equate abort with idle', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.processing = true;
  const abort = deferred();
  s.sdk.abort.mock.mockImplementation(() => abort.promise);
  const first = h.engine.cancel(s.id);
  const second = h.engine.cancel(s.id);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.cancelling, true);
  for (const operation of [() => h.engine.setMode(s.id, 'plan'), () => h.engine.unload(s.id), () => h.engine.stop()]) {
    await assert.rejects(operation(), protectedWork);
  }
  abort.resolve();
  await Promise.all([first, second]);
  assert.equal(s.sdk.abort.mock.callCount(), 1);
  assert.equal(s.rpc.queue.clear.mock.callCount(), 1);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running');
  assert.equal((await h.engine.getMeta(s.id))?.error, undefined);
  assert.equal((await h.engine.getMeta(s.id))?.cancelling, false);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.state.processing = false;
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  assert.equal((await h.engine.getMeta(s.id))?.error, undefined);
});

test('queue-clear failure neither invokes abort nor hides pending native queue items', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.queue.items = [queued('still-queued', 'keep pending')];
  s.emit(event('pending_messages.modified', {}));
  await nextTurn();
  s.rpc.queue.clear.mock.mockImplementation(async () => { throw new Error('clear refused'); });
  await assert.rejects(h.engine.cancel(s.id), /clear refused/);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  assert.deepEqual((await h.engine.getMeta(s.id))?.queue, [{ id: 'still-queued', text: 'keep pending' }]);
  assert.equal((await h.engine.getMeta(s.id))?.cancelling, false);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  visibleError(h, s.id, /clear refused/);
});

test('interrupt coalesces without cancel or replay and preserves accepted queue identities', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.processing = true;
  s.sdk.send.mock.mockImplementationOnce(async () => 'accepted-a', 0);
  s.sdk.send.mock.mockImplementationOnce(async () => 'accepted-b', 1);
  await h.engine.prompt(s.id, 'A');
  await h.engine.prompt(s.id, 'B');
  s.state.queue.items = [queued('a', 'A'), queued('b', 'B')];
  const result = deferred<{ interrupted: boolean }>();
  s.rpc.interruptMainTurn.mock.mockImplementation(() => result.promise);
  const pending = h.engine.interrupt(s.id);
  const repeated = h.engine.interrupt(s.id);
  await nextTurn();
  await assert.rejects(h.engine.cancel(s.id), /progress/);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  result.resolve({ interrupted: true });
  assert.deepEqual(await pending, { ok: true, interrupted: true });
  assert.deepEqual(await repeated, { ok: true, interrupted: true });
  assert.deepEqual(s.rpc.interruptMainTurn.mock.calls[0]!.arguments, [{ flushQueued: true }]);
  assert.equal(s.rpc.interruptMainTurn.mock.callCount(), 1);
  assert.equal(s.rpc.queue.clear.mock.callCount(), 0);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  assert.equal(s.sdk.send.mock.callCount(), 2);
  assert.deepEqual((await h.engine.getMeta(s.id))?.queue, [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]);
  s.state.processing = false;
  s.state.queue.items = [];
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'running', 'accepted IDs remain protected before their user events');
  for (const id of ['a', 'b']) s.emit(event('user.message', { content: id, messageId: `accepted-${id}` }));
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
});

for (const oldKind of ['ask', 'plan'] as const) {
  test(`interrupt cleans only old ${oldKind} while queued A immediately raises a new ask before ACK`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.processing = true;
    s.emit(event('user.message', { content: 'old', interactionId: 'old' }));
    s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'old' }));
    const config = h.configs.get(s.id)!;
    const old = oldKind === 'ask'
      ? config.onUserInputRequest!({ question: 'Old?', choices: ['yes'] }, { sessionId: s.id })
      : config.onExitPlanModeRequest!({ summary: 'Old plan', actions: ['interactive'], recommendedAction: 'interactive' }, { sessionId: s.id });
    const oldRejected = assert.rejects(Promise.resolve(old), /interrupted/);
    const ack = deferred<{ interrupted: boolean }>();
    s.rpc.interruptMainTurn.mock.mockImplementation(() => ack.promise);
    const pending = h.engine.interrupt(s.id);
    await nextTurn();
    s.emit(event('abort', { reason: 'user_abort' }));
    await oldRejected;
    s.emit(event('user.message', { content: 'A', interactionId: 'new' }));
    s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'new' }));
    const next = config.onUserInputRequest!({ question: 'New A?', choices: ['yes'] }, { sessionId: s.id });
    const requestId = (await h.engine.getMeta(s.id))!.ask!.requestId;
    ack.resolve({ interrupted: true });
    await pending;
    assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, requestId);
    await h.engine.respondAsk(s.id, requestId, 'yes', false);
    assert.deepEqual(await next, { answer: 'yes', wasFreeform: false });
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
}

test('interrupt late ACK and old interaction events cannot erase queued reply or name it as cancelled', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.processing = true;
  s.emit(event('user.message', { content: 'old', interactionId: 'old' }));
  const ack = deferred<{ interrupted: boolean }>();
  s.rpc.interruptMainTurn.mock.mockImplementation(() => ack.promise);
  const pending = h.engine.interrupt(s.id);
  await nextTurn();
  s.emit(event('abort', { reason: 'user_abort' }));
  s.emit(event('user.message', { content: 'A', interactionId: 'new' }));
  s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'new' }));
  s.emit(event('assistant.message', { messageId: 'new-answer', content: 'A finished', interactionId: 'new' }));
  s.emit(event('assistant.turn_end', { turnId: '0' }));
  s.emit(event('assistant.message', { messageId: 'late-old', content: 'old cancelled', interactionId: 'old' }));
  s.emit(event('assistant.turn_end', { turnId: '0' }));
  ack.resolve({ interrupted: true });
  await pending;
  s.state.processing = false;
  s.emit(event('session.idle', {}));
  await nextTurn();
  const notices = h.events.filter(event => event.type === 'session/notify');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.body, 'A finished');
});

test('interrupt false and failure leave existing decisions intact and never resume unloaded sessions', async t => {
  const h = harness(t);
  const s = await h.load();
  const decision = h.configs.get(s.id)!.onUserInputRequest!({ question: 'Keep?', choices: ['yes'] }, { sessionId: s.id });
  const requestId = (await h.engine.getMeta(s.id))!.ask!.requestId;
  assert.deepEqual(await h.engine.interrupt(s.id), { ok: true, interrupted: false });
  assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, requestId);
  s.rpc.interruptMainTurn.mock.mockImplementationOnce(async () => { throw new Error('interrupt transport failed; outcome unknown'); });
  await assert.rejects(h.engine.interrupt(s.id), /outcome unknown/);
  assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, requestId);
  await h.engine.respondAsk(s.id, requestId, 'yes', false);
  await decision;
  await h.engine.unload(s.id);
  const resumes = h.runtime.resumeSession.mock.callCount();
  await assert.rejects(h.engine.interrupt(s.id), unavailableSession);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(s.rpc.interruptMainTurn.mock.callCount(), 2);
});

for (const signal of ['abort', 'new-interaction'] as const) {
  test(`interrupt unknown outcome retains cleanup ownership until native ${signal}`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.processing = true;
    s.emit(event('user.message', { content: 'old', interactionId: 'old' }));
    s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'old' }));
    const old = h.configs.get(s.id)!.onUserInputRequest!({ question: 'Old?', choices: ['yes'] }, { sessionId: s.id });
    const rejected = assert.rejects(Promise.resolve(old), /interrupted/);
    const requestId = (await h.engine.getMeta(s.id))!.ask!.requestId;
    s.rpc.interruptMainTurn.mock.mockImplementation(async () => { throw new Error('Native request timed out; outcome unknown'); });
    await assert.rejects(h.engine.interrupt(s.id), /outcome unknown/);
    assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, requestId, 'Failure alone does not prove interruption');
    if (signal === 'abort') s.emit(event('abort', { reason: 'user_abort' }));
    s.emit(event('user.message', { content: 'A', interactionId: 'next' }));
    s.emit(event('assistant.turn_start', { turnId: '0', interactionId: 'next' }));
    await rejected;
    const next = h.configs.get(s.id)!.onUserInputRequest!({ question: 'New?', choices: ['yes'] }, { sessionId: s.id });
    assert.equal((await h.engine.getMeta(s.id))?.ask?.question, 'New?');
    await h.engine.respondAsk(s.id, (await h.engine.getMeta(s.id))!.ask!.requestId, 'yes', false);
    await next;
    assert.equal(s.rpc.interruptMainTurn.mock.callCount(), 1, 'No automatic retry on timeout');
  });
}

test('interrupt closure rejects promptly and ignores a late native acknowledgement', async t => {
  const h = harness(t);
  const s = await h.load();
  const ack = deferred<{ interrupted: boolean }>();
  s.rpc.interruptMainTurn.mock.mockImplementation(() => ack.promise);
  const outcome = assert.rejects(h.engine.interrupt(s.id), /closed/);
  await nextTurn();
  h.runtime.expire(s.id, true);
  await promptly(outcome);
  await h.engine.reload(s.id);
  const before = (await h.engine.getMeta(s.id));
  ack.resolve({ interrupted: true });
  await nextTurn();
  assert.deepEqual((await h.engine.getMeta(s.id)), before);
});

for (const action of ['unload', 'reload', 'deleteSession'] as const) {
  test(`${action} close failure retains the attached handle, subscription, and metadata`, async t => {
    const h = harness(t);
    const s = await h.load();
    await h.engine.rename(s.id, 'keep title');
    h.runtime.closeSession.mock.mockImplementation(async () => { throw new Error('native close failed'); });
    await assert.rejects(action === 'deleteSession' ? h.engine.deleteSession(s.id, true) : h.engine[action](s.id), /native close failed/);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
    assert.equal((await h.engine.getMeta(s.id))?.closing, false);
    assert.equal((await h.engine.getMeta(s.id))?.title, 'keep title');
    assert.equal(h.attached.size, 1);
    assert.equal(s.listeners.size, 1);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal('trashed' in h.prefs(), false);
    assert.ok(!h.events.some(event => event.type === 'session/removed'));
    visibleError(h, s.id, /native close failed/);
    s.state.name = 'callback still attached';
    h.events.length = 0;
    s.emit(event('session.title_changed', { title: s.state.name }));
    assert.ok(h.events.some(event => event.type === 'session/invalidated' && event.sessionId === s.id));
    assert.equal((await h.engine.getMeta(s.id))?.title, 'callback still attached');
    s.emit(assistant('still-attached-event', 'still-attached-message'));
    assert.equal((await chat(h, s.id, { source: 'live' })).events.find(event => event.id === 'still-attached-event')?.data.messageId, 'still-attached-message');
    assert.equal(serverChatEvents(h).length, 0);
  });
}

test('public user-input callbacks return an actual pending promise and validate stale/invalid answers', async t => {
  const h = harness(t);
  const s = await h.load();
  const config = h.configs.get(s.id)!;
  const answer = config.onUserInputRequest!({ question: 'Choose', choices: ['yes', 'no'], allowFreeform: false }, { sessionId: s.id });
  assert.ok(answer instanceof Promise);
  let settled = false;
  void answer.then(() => { settled = true; });
  const id = (await h.engine.getMeta(s.id))!.ask!.requestId;
  await assert.rejects(h.engine.respondAsk(s.id, 'stale-id', 'yes', false), /no longer pending/);
  await assert.rejects(h.engine.respondAsk(s.id, id, 'other', false), /offered choice/);
  await assert.rejects(h.engine.respondAsk(s.id, id, 'free text', true), /Freeform/);
  await assert.rejects(h.engine.respondPlan(s.id, id, 'interactive'), /no longer pending/);
  await nextTurn();
  assert.equal(settled, false);
  assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, id);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  await h.engine.respondAsk(s.id, id, 'yes', false);
  assert.deepEqual(await answer, { answer: 'yes', wasFreeform: false });
  assert.equal((await h.engine.getMeta(s.id))?.ask, null);
  await assert.rejects(h.engine.respondAsk(s.id, id, 'yes', false), /no longer pending/);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('multiple native input callbacks retain independent promises and reveal the next pending request', async t => {
  const h = harness(t);
  const s = await h.load();
  const config = h.configs.get(s.id)!;
  const first = config.onUserInputRequest!({ question: 'First?' }, { sessionId: s.id });
  const firstId = (await h.engine.getMeta(s.id))!.ask!.requestId;
  const second = config.onUserInputRequest!({ question: 'Second?' }, { sessionId: s.id });
  assert.equal((await h.engine.getMeta(s.id))?.ask?.question, 'First?');
  await h.engine.respondAsk(s.id, firstId, 'first answer', true);
  assert.deepEqual(await first, { answer: 'first answer', wasFreeform: true });
  const secondId = (await h.engine.getMeta(s.id))!.ask!.requestId;
  assert.notEqual(secondId, firstId);
  assert.equal((await h.engine.getMeta(s.id))?.ask?.question, 'Second?');
  await h.engine.respondAsk(s.id, secondId, 'second answer', true);
  assert.deepEqual(await second, { answer: 'second answer', wasFreeform: true });
});

test('plan callback rejects unoffered actions without resolving, then returns the exact native answer', async t => {
  const h = harness(t);
  const s = await h.load();
  const result = h.configs.get(s.id)!.onExitPlanModeRequest!({
    summary: 'Native plan', actions: ['exit_only', 'interactive'], recommendedAction: 'interactive',
  }, { sessionId: s.id });
  assert.ok(result instanceof Promise);
  let settled = false;
  void result.then(() => { settled = true; }, () => { settled = true; });
  const id = (await h.engine.getMeta(s.id))!.planRequest!.requestId;
  await assert.rejects(h.engine.respondPlan(s.id, id, 'autopilot'), /not offered/);
  await assert.rejects(h.engine.planSupersede(s.id, 'stale', 'replacement'), /no longer pending/);
  await assert.rejects(h.engine.planSupersede(s.id, id, ' \n '), /empty/);
  await nextTurn();
  assert.equal(settled, false, 'invalid feedback must leave the real callback pending');
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  assert.equal(s.rpc.mode.set.mock.callCount(), 0);
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 0);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  await h.engine.respondPlan(s.id, id, 'interactive');
  assert.deepEqual(await result, { approved: true, selectedAction: 'interactive' });
  assert.equal((await h.engine.getMeta(s.id))?.planRequest, null);
  await assert.rejects(h.engine.respondPlan(s.id, id, 'interactive'), /no longer pending/);
});

test('a native plan action outside the supported protocol cannot be accepted through a forged action', async t => {
  const h = harness(t);
  const s = await h.load();
  const result = h.configs.get(s.id)!.onExitPlanModeRequest!({
    summary: 'Native plan', actions: ['interactive', 'future-action'], recommendedAction: 'future-action',
  }, { sessionId: s.id });
  const id = (await h.engine.getMeta(s.id))!.planRequest!.requestId;
  assert.deepEqual((await h.engine.getMeta(s.id))?.planRequest?.actions, ['interactive']);
  await assert.rejects(h.engine.respondPlan(s.id, id, 'future-action' as ExitPlanModeAction), /unsupported|offered|action/i);
  assert.equal((await h.engine.getMeta(s.id))?.planRequest?.requestId, id);
  await h.engine.respondPlan(s.id, id, 'interactive');
  assert.deepEqual(await result, { approved: true, selectedAction: 'interactive' });
});

for (const mode of ['form', 'url'] as const) {
  test(`${mode} elicitation cannot fake structured acceptance; decline resolves the real callback`, async t => {
    const h = harness(t);
    const s = await h.load();
    const result = h.configs.get(s.id)!.onElicitationRequest!({
      sessionId: s.id, message: 'Provide account details', mode,
      ...(mode === 'form'
        ? { requestedSchema: { type: 'object' as const, properties: { label: { type: 'string' as const } }, required: ['label'] } }
        : { url: 'https://example.invalid/never-opened' }),
    });
    assert.ok(result instanceof Promise);
    let settled = false;
    void result.then(() => { settled = true; });
    const id = (await h.engine.getMeta(s.id))!.elicitation!.requestId;
    assert.deepEqual((await h.engine.getMeta(s.id))!.elicitation, {
      requestId: id, message: 'Provide account details', actions: ['decline', 'cancel'],
    });
    await assert.rejects(h.engine.respondElicitation(s.id, 'stale', 'decline'), /no longer pending/);
    await assert.rejects(h.engine.respondElicitation(s.id, id, 'accept'), /unsupported/);
    await nextTurn();
    assert.equal(settled, false);
    assert.equal((await h.engine.getMeta(s.id))?.elicitation?.requestId, id);
    await h.engine.respondElicitation(s.id, id, 'decline');
    assert.deepEqual(await result, { action: 'decline' });
    assert.equal((await h.engine.getMeta(s.id))?.elicitation, null);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
}

test('failed abort keeps native decisions pending; successful cancellation rejects their real promises', async t => {
  const h = harness(t);
  const s = await h.load();
  const pending = h.configs.get(s.id)!.onUserInputRequest!({ question: 'Still waiting?' }, { sessionId: s.id });
  let settled = false;
  void Promise.resolve(pending).then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(Promise.resolve(pending), /Native request cancelled/);
  const requestId = (await h.engine.getMeta(s.id))!.ask!.requestId;
  s.sdk.abort.mock.mockImplementationOnce(async () => { throw new Error('abort refused'); });
  await assert.rejects(h.engine.cancel(s.id), /abort refused/);
  await nextTurn();
  assert.equal(settled, false, 'failed abort must not settle the real native callback');
  assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, requestId);
  await h.engine.cancel(s.id);
  await rejection;
  assert.equal((await h.engine.getMeta(s.id))?.ask, null);
  await assert.rejects(h.engine.respondAsk(s.id, requestId, 'too late', true), /no longer pending/);
});

for (const stage of ['mutation', 'readback'] as const) {
  test(`model ${stage} failure never publishes the requested model or options`, async t => {
    const h = harness(t);
    const s = await h.load();
    const before = (await h.engine.getMeta(s.id))!;
    const fail = async () => { throw new Error(`model ${stage} rejected`); };
    if (stage === 'mutation') s.rpc.model.switchTo.mock.mockImplementation(fail);
    else s.rpc.model.getCurrent.mock.mockImplementation(fail);
    h.events.length = 0;
    await assert.rejects(h.engine.setModel(s.id, 'unconfirmed-model', 'high', 'long_context'), /model .* rejected/);
    if (stage === 'readback') await assert.rejects(h.engine.getMeta(s.id), /model readback rejected/);
    else {
      const after = (await h.engine.getMeta(s.id))!;
      assert.equal(after.currentModelId, before.currentModelId);
      assert.equal(after.currentReasoningEffort, before.currentReasoningEffort);
      assert.equal(after.currentContextTier, before.currentContextTier);
    }
    assert.ok(!h.events.some(event => event.type === 'session/patch' && event.currentModelId === 'unconfirmed-model'));
    visibleError(h, s.id, /model .* rejected/);
    s.rpc.model.getCurrent.mock.mockImplementation(async () => structuredClone(s.state.model));
    assert.equal((await h.engine.getMeta(s.id))?.currentModelId,
      stage === 'readback' ? 'unconfirmed-model' : before.currentModelId, 'later reads report actual native state');
    assert.equal(s.rpc.model.switchTo.mock.callCount(), 1, 'readback failure never retries a mutation');
  });

  test(`name ${stage} failure never publishes an optimistic title`, async t => {
    const h = harness(t);
    const s = await h.load();
    const before = (await h.engine.getMeta(s.id))!.title;
    const fail = async () => { throw new Error(`name ${stage} rejected`); };
    if (stage === 'mutation') s.rpc.name.set.mock.mockImplementation(fail);
    else s.rpc.name.get.mock.mockImplementation(fail);
    h.events.length = 0;
    await assert.rejects(h.engine.rename(s.id, 'unconfirmed title'), /name .* rejected/);
    if (stage === 'readback') await assert.rejects(h.engine.getMeta(s.id), /name readback rejected/);
    else assert.equal((await h.engine.getMeta(s.id))?.title, before);
    assert.ok(!h.events.some(event => event.type === 'session/patch' && event.title === 'unconfirmed title'));
    visibleError(h, s.id, /name .* rejected/);
    s.rpc.name.get.mock.mockImplementation(async () => ({ name: s.state.name }));
    assert.equal((await h.engine.getMeta(s.id))?.title, stage === 'readback' ? 'unconfirmed title' : before);
    assert.equal(s.rpc.name.set.mock.callCount(), 1);
  });
}

test('model, mode, and name success publish authoritative native read-back rather than requested values', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.model.getCurrent.mock.mockImplementation(async () => ({ modelId: 'normalized-model', reasoningEffort: 'low', contextTier: 'default' }));
  await h.engine.setModel(s.id, 'alias', 'high', 'long_context');
  assert.deepEqual(s.rpc.model.switchTo.mock.calls[0]!.arguments, [{ modelId: 'alias', reasoningEffort: 'high', contextTier: 'long_context' }]);
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'normalized-model');
  assert.equal((await h.engine.getMeta(s.id))?.currentReasoningEffort, 'low');
  assert.equal((await h.engine.getMeta(s.id))?.currentContextTier, 'default');
  s.rpc.mode.get.mock.mockImplementation(async () => 'interactive');
  await h.engine.setMode(s.id, 'plan');
  assert.equal((await h.engine.getMeta(s.id))?.currentMode, 'interactive');
  s.rpc.name.get.mock.mockImplementation(async () => ({ name: 'normalized title' }));
  assert.equal(await h.engine.rename(s.id, '  requested title  '), 'normalized title');
  assert.deepEqual(s.rpc.name.set.mock.calls[0]!.arguments, [{ name: 'requested title' }]);
  assert.equal((await h.engine.getMeta(s.id))?.title, 'normalized title');
});

for (const cleared of [false, true]) {
  test(`native model-change events ${cleared ? 'clear nullable' : 'refresh selected'} effort and context tier`, async t => {
    const h = harness(t);
    const s = await h.load();
    const reasoningEffort = cleared ? null : 'high';
    const contextTier = cleared ? null : 'long_context';
    s.state.model = {
      modelId: 'event-selected-model',
      reasoningEffort: reasoningEffort ?? undefined, contextTier: contextTier ?? undefined,
    };
    h.events.length = 0;
    s.emit(event('session.model_change', {
      previousModel: 'native-model', newModel: 'event-selected-model', reasoningEffort, contextTier,
    }));
    await nextTurn();
    const meta = (await h.engine.getMeta(s.id))!;
    assert.equal(meta.currentModelId, 'event-selected-model');
    assert.equal(meta.currentReasoningEffort, reasoningEffort);
    assert.equal(meta.currentContextTier, contextTier);
    assert.deepEqual((await h.engine.snapshot()).sessions.find(session => session.sessionId === s.id), meta);
    assert.ok(h.events.some(event => event.type === 'session/invalidated' && event.sessionId === s.id));
    assert.equal(s.rpc.model.switchTo.mock.callCount(), 0);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
}

test('native mode-change events publish the public scalar mode without a local mode mutation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.mode = 'plan';
  s.emit(event('session.mode_changed', { previousMode: 'interactive', newMode: 'plan' }));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.currentMode, 'plan');
  assert.equal((await h.engine.snapshot()).sessions.find(session => session.sessionId === s.id)?.currentMode, 'plan');
  assert.equal(s.rpc.mode.set.mock.callCount(), 0);
});

for (const mutated of [false, true]) {
  test(`structured rewind failure ${mutated ? 'invalidates a real partial mutation' : 'does not invent an invalidation'}`, async t => {
    const h = harness(t);
    const s = await h.seed();
    s.state.events = [user('keep'), assistant('drop-event', 'drop-message')];
    await h.engine.reload(s.id);
    s.rpc.history.rewind.mock.mockImplementation(async () => {
      if (mutated) s.state.events = [user('keep')];
      return {
        outcome: mutated ? 'checkpoint-cleanup-failed' : 'truncation-failed',
        restoredFiles: [], skippedFiles: [], ...(mutated ? { eventsRemoved: 1 } : {}),
        error: mutated ? 'checkpoint cleanup failed' : 'unknown event',
      };
    });
    const reads = s.rpc.eventLog.read.mock.callCount();
    await assert.rejects(h.engine.rewind(s.id, 'keep', true), /Rewind .*checkpoint cleanup failed|Rewind .*unknown event/);
    assert.deepEqual(s.rpc.history.rewind.mock.calls[0]!.arguments, [{ eventId: 'keep', mode: 'conversation-and-files' }]);
    const invalidations = h.events.filter(event => event.type === 'chat/invalidated');
    assert.deepEqual(invalidations, mutated ? [{ type: 'chat/invalidated', sessionId: s.id, reason: 'rewind' }] : []);
    assert.equal(serverChatEvents(h).length, 0);
    assert.equal(s.rpc.eventLog.read.mock.callCount(), reads, 'mutation never replays chat on the server');
    if (mutated) {
      assert.deepEqual((await chat(h, s.id, { source: 'live' })).events.map(event => event.id), ['keep']);
      visibleError(h, s.id, /partially applied/);
    }
    assert.equal((await h.engine.getMeta(s.id))?.closing, false);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  });
}

test('rewind with zero removed events and no restored files emits no chat invalidation', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.rewind(s.id, 'already-at-target');
  assert.equal(h.events.filter(event => event.type === 'chat/invalidated').length, 0);
  assert.equal(serverChatEvents(h).length, 0);
  assert.deepEqual(s.rpc.history.rewind.mock.calls[0]!.arguments, [{ eventId: 'already-at-target', mode: 'conversation' }]);
});

test('incomplete file rollback is reported as a real partial mutation without inventing conversation truncation', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.events = [user('unchanged-conversation')];
  await h.engine.reload(s.id);
  s.rpc.history.rewind.mock.mockImplementation(async () => ({
    outcome: 'rollback-incomplete', restoredFiles: [join(h.cwd, 'native-restored-file')],
    skippedFiles: [], error: 'rollback could not restore one file',
  }));
  const reads = s.rpc.eventLog.read.mock.callCount();
  await assert.rejects(h.engine.rewind(s.id, 'unchanged-conversation', true), /rollback-incomplete \(partially applied\)/);
  assert.deepEqual(h.events.filter(event => event.type === 'chat/invalidated'), [
    { type: 'chat/invalidated', sessionId: s.id, reason: 'rewind' },
  ]);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), reads);
  assert.deepEqual((await chat(h, s.id, { source: 'live' })).events.map(event => event.id), ['unchanged-conversation']);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
});

test('rewind RPC rejection leaves the native session attached and emits no chat invalidation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.history.rewind.mock.mockImplementation(async () => { throw new Error('rewind transport failed'); });
  await assert.rejects(h.engine.rewind(s.id, 'target'), /rewind transport failed/);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 0);
  assert.equal(h.events.filter(event => event.type === 'chat/invalidated').length, 0);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  visibleError(h, s.id, /rewind transport failed/);
});

test('successful rewind invalidates chat without replay; subsequent native reads see the truncation', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.events = [user('keep-user'), assistant('removed-event', 'removed-answer')];
  h.journals.set(s.id, [...s.state.events]);
  await h.engine.reload(s.id);
  const previous = await chat(h, s.id);
  assert.deepEqual(previous.events.map(event => event.id), ['keep-user', 'removed-event']);
  s.rpc.history.rewind.mock.mockImplementation(async () => {
    s.state.events = [user('keep-user')];
    h.journals.set(s.id, [...s.state.events]);
    return { outcome: 'success', eventsRemoved: 1, restoredFiles: [], skippedFiles: [] };
  });
  const reads = s.rpc.eventLog.read.mock.callCount();
  const persistedReads = h.runtime.rpc.sessions.readPersistedEvents.mock.callCount();
  await h.engine.rewind(s.id, 'removed-event');
  assert.deepEqual(h.events.filter(event => event.type === 'chat/invalidated'), [
    { type: 'chat/invalidated', sessionId: s.id, reason: 'rewind' },
  ]);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), reads);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), persistedReads);
  assert.equal((await chat(h, s.id, { cursor: previous.cursor })).cursorStatus, 'expired');
  assert.deepEqual((await chat(h, s.id)).events.map(event => event.id), ['keep-user']);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

const invalidSchedules = [
  { interval: '1m', cron: '* * * * *' }, { interval: '1m', tz: 'UTC' },
  { interval: '1m', displayPrompt: 'label' }, { at: Date.parse(timestamp), recurring: true },
  { cron: '* * * * *' }, { interval: '1m', tz: '' }, { interval: '1m', displayPrompt: '' },
  {}, { interval: '0s' }, { interval: '-1s' }, { interval: '0.5s' },
  { interval: '86401s' }, { interval: '1441m' }, { interval: '25h' },
  { at: Date.parse(timestamp) - 1 }, { at: Date.parse(timestamp) },
  { at: Date.parse(timestamp) + 86_400_001 }, { at: Number.NaN }, { at: Number.POSITIVE_INFINITY },
  { interval: '1m', at: Date.parse(timestamp) }, { interval: 'tomorrow' },
  { interval: '1m', prompt: 'hello --model other' }, { interval: '1m', prompt: '/dangerous-command' },
  { interval: '1m', prompt: 'line one\nline two' }, { interval: '1m', prompt: '  ' },
] satisfies Array<Partial<Parameters<Engine['addSchedule']>[1]>>;
for (const options of invalidSchedules) {
  test(`invalid schedule is rejected before resume or command invocation: ${JSON.stringify(options)}`, async t => {
    const h = harness(t);
    const s = await h.seed();
    t.mock.method(Date, 'now', () => Date.parse(timestamp));
    const before = readFileSync(h.prefsFile, 'utf8');
    await assert.rejects(h.engine.addSchedule(s.id, { prompt: 'check build', ...options }), /unsupported|required|plain|delay/i);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(s.rpc.commands.invoke.mock.callCount(), 0);
    assert.equal(s.rpc.schedule.list.mock.callCount(), 0);
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
    assert.equal(s.sdk.send.mock.callCount(), 0);
    assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
    assert.equal(h.prefs().scheduledSessions?.[s.id], undefined);
    assert.equal(readFileSync(h.prefsFile, 'utf8'), before);
  });
}

for (const seconds of [1, 86_400]) {
  for (const kind of ['interval', 'absolute'] as const) {
    test(`${kind} schedule accepts the inclusive ${seconds}-second bound only with native confirmation`, async t => {
      const h = harness(t);
      const s = await h.load();
      t.mock.method(Date, 'now', () => Date.parse(timestamp));
      s.rpc.commands.invoke.mock.mockImplementation(async () => {
        s.state.schedules = [{ ...schedule(93, false), intervalMs: seconds * 1000 }];
        return { kind: 'completed' };
      });
      const result = await h.engine.addSchedule(s.id, {
        prompt: 'check build', recurring: false,
        ...(kind === 'interval' ? { interval: `${seconds}s` } : { at: Date.parse(timestamp) + seconds * 1000 }),
      });
      assert.equal(result.error, undefined);
      assert.equal(result.entry?.id, 93);
      assert.equal(result.entry?.intervalMs, seconds * 1000);
      assert.deepEqual(s.rpc.commands.invoke.mock.calls[0]!.arguments, [{ name: 'after', input: `${seconds}s check build` }]);
      assert.equal(s.sdk.send.mock.callCount(), 0);
      assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
      assert.equal(h.prefs().scheduledSessions, undefined);
    });
  }
}

for (const recurring of [false, true]) {
  test(`native ${recurring ? 'every' : 'after'} schedule is confirmed by list read-back, using its native ID and time`, async t => {
    const h = harness(t);
    const s = await h.load();
    const timeouts = t.mock.method(globalThis, 'setTimeout');
    const intervals = t.mock.method(globalThis, 'setInterval');
    s.rpc.commands.invoke.mock.mockImplementation(async () => {
      s.state.schedules = [schedule(91, recurring)];
      return { kind: 'completed' };
    });
    const result = await h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m', recurring });
    assert.equal(result.error, undefined);
    assert.deepEqual(s.rpc.commands.invoke.mock.calls[0]!.arguments, [{ name: recurring ? 'every' : 'after', input: '60s check build' }]);
    assert.equal(result.entry?.id, 91);
    assert.equal(result.entry?.nextRunAt, Date.parse('2026-09-07T12:01:00.000Z'));
    assert.equal(result.entry?.recurring, recurring);
    assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
    assert.equal(h.prefs().scheduledSessions, undefined);
    assert.equal(s.sdk.send.mock.callCount(), 0);
    const before = nativeCalls(s);
    t.mock.timers.tick(86_400_000);
    await nextTurn();
    assert.deepEqual(nativeCalls(s), before, 'Cockpit must not run schedules or add a schedule heartbeat');
    assert.equal(await h.engine.stopSchedule(s.id, 91), true);
    assert.deepEqual(s.rpc.schedule.stop.mock.calls[0]!.arguments, [{ id: 91 }]);
    assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 0);
    assert.equal(h.prefs().scheduledSessions?.[s.id], undefined);
    assert.equal(await h.engine.stopSchedule(s.id, 91), false);
    assert.equal(timeouts.mock.callCount(), 0, 'only the native runtime owns schedule timers');
    assert.equal(intervals.mock.callCount(), 0, 'schedule mutations must not install a local scheduler');
    await h.engine.unload(s.id);
  });
}

test('schedule command acknowledgement without a matching new entry is not success or a model fallback', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.schedules = [schedule(11)];
  const result = await h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m' });
  assert.equal(result.entry, undefined);
  assert.match(result.error!, /not confirmed/);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
});

test('absolute schedules use a bounded native after delay and require a real returned entry', async t => {
  const h = harness(t);
  const s = await h.load();
  t.mock.method(Date, 'now', () => Date.parse(timestamp));
  s.rpc.commands.invoke.mock.mockImplementation(async () => {
    s.state.schedules = [schedule(92, false)];
    return { kind: 'completed' };
  });
  const result = await h.engine.addSchedule(s.id, { prompt: 'check build', at: Date.parse(timestamp) + 60_000 });
  assert.deepEqual(s.rpc.commands.invoke.mock.calls[0]!.arguments, [{ name: 'after', input: '60s check build' }]);
  assert.equal(result.entry?.id, 92);
  assert.equal(result.entry?.recurring, false);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('native schedule stop rejection preserves the schedule without persisting local policy and permits unload', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.schedules = [schedule()];
  await h.engine.listSchedules(s.id);
  s.rpc.schedule.stop.mock.mockImplementation(async () => { throw new Error('schedule stop refused'); });
  await assert.rejects(h.engine.stopSchedule(s.id, 7), /schedule stop refused/);
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
  assert.equal(h.prefs().scheduledSessions, undefined);
  await h.engine.unload(s.id);
  assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  assert.deepEqual(s.state.schedules, [schedule()]);
  assert.equal(h.prefs().scheduledSessions, undefined);
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
});

test('global MCP inventory combines native user definitions and native enabled state without sessions or legacy defaults', async t => {
  const h = harness(t, {
    mcpServers: {
      fixture: { url: 'https://username:password@example.invalid/mcp?token=private-token',
        headers: { Authorization: 'private-header' } },
    },
    prefs: { mcpDefaultOn: [], mcpBySession: { untouched: ['other'] } },
  });
  h.discoveredMcp.push({ name: 'workspace-only', source: 'workspace', enabled: true });
  const before = readFileSync(h.prefsFile, 'utf8');
  const servers = await h.engine.listGlobalMcp();
  assert.deepEqual(servers.map(({ name, defaultOn }) => ({ name, defaultOn })), [{ name: 'fixture', defaultOn: true }]);
  assert.ok(!/username|password|private-token|private-header/.test(JSON.stringify(servers)));
  assert.deepEqual(h.runtime.rpc.mcp.discover.mock.calls[0]!.arguments, [{ workingDirectory: homedir() }]);
  await h.engine.setMcpDefault('fixture', false);
  assert.equal((await h.engine.listGlobalMcp())[0]!.defaultOn, false);
  await h.engine.setMcpDefault('fixture', true);
  assert.deepEqual(h.runtime.rpc.mcp.config.disable.mock.calls[0]!.arguments, [{ names: ['fixture'] }]);
  assert.deepEqual(h.runtime.rpc.mcp.config.enable.mock.calls[0]!.arguments, [{ names: ['fixture'] }]);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), before);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

for (const failure of ['unknown', 'ignored', 'shadowed', 'missing-enabled', 'readback'] as const) {
  test(`global MCP ${failure} state cannot silently confirm a configuration mutation`, async t => {
    const h = harness(t, { mcpServers: { fixture: { command: 'native-fixture' } } });
    if (failure === 'shadowed') h.discoveredMcp[0]!.source = 'workspace';
    if (failure === 'missing-enabled') delete (h.discoveredMcp[0] as Partial<DiscoveredMcp>).enabled;
    if (failure === 'ignored') h.runtime.rpc.mcp.config.disable.mock.mockImplementationOnce(async () => {});
    if (failure === 'readback') h.runtime.rpc.mcp.discover.mock.mockImplementationOnce(async () => {
      throw new Error('native discover readback failed');
    }, 1);
    const bytes = readFileSync(h.prefsFile, 'utf8');
    await assert.rejects(h.engine.setMcpDefault(failure === 'unknown' ? 'unknown' : 'fixture', false),
      /Unknown|unconfirmed|did not confirm|readback failed/);
    assert.equal(readFileSync(h.prefsFile, 'utf8'), bytes);
    assert.equal(h.runtime.rpc.mcp.config.disable.mock.callCount(), failure === 'ignored' || failure === 'readback' ? 1 : 0);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
  });
}

test('session MCP inventory uses resident workspace/plugin truth and never borrows global definitions', async t => {
  const h = harness(t, { mcpServers: { global: { command: 'must-not-be-displayed' } } });
  const s = await h.load();
  s.state.mcp = mcpState([
    { name: 'workspace', source: 'workspace', status: 'connected' },
    { name: 'plugin', source: 'plugin', sourcePlugin: 'native-plugin', status: 'disabled' },
  ], ['plugin']);
  assert.deepEqual(await h.engine.listSessionMcp(s.id), { loaded: true, servers: [
    { name: 'workspace', detail: 'workspace', enabled: true, status: 'connected', error: undefined },
    { name: 'plugin', detail: 'native-plugin', enabled: false, status: 'disabled', error: undefined },
  ] });
  s.rpc.mcp.disable.mock.mockImplementationOnce(async () => {
    s.state.mcp.host!.disabledServers.push('workspace');
    s.state.mcp.servers[0]!.status = 'disabled';
  });
  assert.equal((await h.engine.toggleSessionMcp(s.id, 'workspace', false)).ok, true);
  assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.discover.mock.callCount(), 0);
  delete s.state.mcp.host;
  await assert.rejects(h.engine.listSessionMcp(s.id), /unconfirmed/);
  h.runtime.expire(s.id);
  const resumes = h.runtime.resumeSession.mock.callCount();
  assert.deepEqual(await h.engine.listSessionMcp(s.id), { loaded: false, servers: [] });
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
});

test('unknown native MCP names reject before mutation without stranding later valid toggles', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'known', status: 'connected' }]);
  await assert.rejects(h.engine.toggleSessionMcp(s.id, 'missing', false), /Unknown native MCP server/);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
  s.rpc.mcp.disable.mock.mockImplementationOnce(async () => {
    s.state.mcp = mcpState([{ name: 'known', status: 'disabled' }], ['known']);
  });
  assert.equal((await h.engine.toggleSessionMcp(s.id, 'known', false)).ok, true);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 1);
  assert.equal(h.prefs().mcpBySession, undefined);
});

for (const failure of ['rpc', 'unconfirmed-state'] as const) {
  test(`MCP enable ${failure} failure does not persist a successful preference`, async t => {
    const h = harness(t, { mcpServers: { fixture: { command: 'never-executed', args: [] } } });
    const s = await h.load();
    s.state.mcp = mcpState([{ name: 'fixture', status: 'failed', error: 'native connect failed' }],
      failure === 'rpc' ? ['fixture'] : []);
    if (failure === 'rpc') s.rpc.mcp.enable.mock.mockImplementation(async () => { throw new Error('native enable rejected'); });
    const before = readFileSync(h.prefsFile, 'utf8');
    const result = await h.engine.toggleSessionMcp(s.id, 'fixture', true);
    assert.equal(result.ok, false);
    assert.equal(result.applied, false);
    assert.equal(result.operation?.state, 'failed');
    assert.equal(result.enabled, failure !== 'rpc', 'report authoritative enablement, not the requested value');
    assert.equal(result.status, failure === 'rpc' ? 'disabled' : 'failed');
    assert.equal(result.operation?.status, result.status);
    assert.equal(result.operation?.desiredEnabled, true);
    assert.match(result.error!, /native/);
    assert.equal(readFileSync(h.prefsFile, 'utf8'), before);
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
    assert.deepEqual(s.rpc.mcp.enable.mock.calls[0]!.arguments, [{ serverName: 'fixture' }]);
    visibleError(h, s.id, /native/);
  });
}

for (const mutationRejected of [false, true]) {
  test(`MCP unreadable state after ${mutationRejected ? 'rejected' : 'acknowledged'} enable rejects as unknown and stays protected until confirmed`, async t => {
    const h = harness(t, { mcpServers: { fixture: { command: 'never-executed', args: [] } } });
    const s = await h.load();
    s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
    if (mutationRejected) s.rpc.mcp.enable.mock.mockImplementation(async () => { throw new Error('native enable rejected'); });
    s.rpc.mcp.list.mock.mockImplementation(async () => { throw new Error('native MCP readback unavailable'); });
    s.rpc.mcp.list.mock.mockImplementationOnce(async () => structuredClone(s.state.mcp));
    const before = readFileSync(h.prefsFile, 'utf8');
    h.events.length = 0;
    await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', true), /MCP state is unknown.*native MCP readback unavailable/);
    await assert.rejects(h.engine.getMeta(s.id), /native MCP readback unavailable/);
    assert.equal(readFileSync(h.prefsFile, 'utf8'), before);
    visibleError(h, s.id, /MCP state is unknown/);
    await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', false), /native MCP readback unavailable/);
    assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
    for (const teardown of [() => h.engine.unload(s.id), () => h.engine.stop()]) {
      await assert.rejects(teardown(), /protected|MCP readback unavailable/i);
      await assert.rejects(h.engine.getMeta(s.id), /native MCP readback unavailable/);
      assert.ok(h.attached.has(s.id));
    }
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.stop.mock.callCount(), 0);
    assert.equal(h.runtime.start.mock.callCount(), 0);
    s.rpc.mcp.list.mock.mockImplementation(async () => structuredClone(s.state.mcp));
    s.state.mcp.host!.pendingConnections = ['fixture'];
    s.emit(event('session.idle', {}));
    await nextTurn();
    assert.ok((await h.engine.getMeta(s.id))!.activeMcpOperations! > 0, 'readable but pending native connections are not settled');
    await assert.rejects(h.engine.unload(s.id), protectedWork);
    s.state.mcp.host!.pendingConnections = [];
    s.emit(event('session.idle', {}));
    await nextTurn();
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
    assert.equal(h.prefs().mcpBySession?.[s.id], undefined, 'a later read must not persist the rejected request');
    await h.engine.unload(s.id);
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  });
}

test('rejected MCP enable reports settling while the native host still has a pending connector', async t => {
  const h = harness(t, { mcpServers: { fixture: { command: 'never-executed', args: [] } } });
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
  s.rpc.mcp.enable.mock.mockImplementation(async () => {
    s.state.mcp = mcpState([{ name: 'fixture', status: 'pending' }]);
    s.state.mcp.host!.pendingConnections = ['fixture'];
    throw new Error('native connector timed out');
  });
  const before = readFileSync(h.prefsFile, 'utf8');
  const result = await h.engine.toggleSessionMcp(s.id, 'fixture', true);
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.enabled, true);
  assert.equal(result.status, 'pending');
  assert.equal(result.operation?.state, 'settling');
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), before);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('MCP enable confirms native state without persistence and blocks a concurrent mutation or unload', async t => {
  const h = harness(t, { mcpServers: { fixture: { command: 'never-executed', args: [] } } });
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
  const enabled = deferred();
  s.rpc.mcp.enable.mock.mockImplementation(async () => {
    await enabled.promise;
    s.state.mcp = mcpState([{ name: 'fixture', status: 'connected' }]);
  });
  const toggling = h.engine.toggleSessionMcp(s.id, 'fixture', true);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 1);
  assert.equal(h.prefs().mcpBySession?.[s.id], undefined);
  await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', false), /already in progress/);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
  enabled.resolve();
  const result = await toggling;
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.operation?.state, 'succeeded');
  assert.equal(h.prefs().mcpBySession, undefined);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
});

test('skill mutation requires native read-back and never saves a Cockpit preference', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.skills = [{ name: 'fixture', description: 'local fixture', source: 'project', enabled: false, userInvocable: true }];
  s.rpc.skills.enable.mock.mockImplementationOnce(async () => {});
  await assert.rejects(h.engine.toggleSessionSkill(s.id, 'fixture', true), /did not confirm/);
  assert.equal(h.prefs().skillsDisabledBySession?.[s.id], undefined);
  await h.engine.toggleSessionSkill(s.id, 'fixture', true);
  assert.equal(h.prefs().skillsDisabledBySession, undefined);
  assert.deepEqual((await h.engine.listSessionSkills(s.id)).map(skill => [skill.name, skill.enabled]), [['fixture', true]]);
});

test('global skill choices use native discovery and atomic config mutation without borrowing or reloading sessions', async t => {
  const h = harness(t, { prefs: { skillsDisabledBySession: { historical: ['fixture'] } } });
  const s = await h.load();
  s.state.skills = [{ name: 'fixture', description: 'resident', source: 'personal-copilot', enabled: true, userInvocable: true }];
  h.discoveredSkills.push({ name: 'fixture', description: 'native', source: 'personal-copilot', enabled: true, userInvocable: true });
  const before = nativeCalls(s);
  const prefs = readFileSync(h.prefsFile, 'utf8');
  h.userSettings.settings.disabledSkills!.value = ['unrelated'];
  await h.engine.setGlobalSkill('fixture', false, h.cwd);
  assert.equal((await h.engine.listGlobalSkills(h.cwd))[0]!.enabled, false);
  assert.equal(h.discoveredSkills[0]!.enabled, true, 'discovery may retain its earlier enablement metadata');
  assert.deepEqual(h.userSettings.settings.disabledSkills!.value, ['unrelated', 'fixture']);
  await h.engine.setGlobalSkill('fixture', true, h.cwd);
  assert.deepEqual(h.userSettings.settings.disabledSkills!.value, ['unrelated']);
  assert.deepEqual(h.runtime.rpc.skills.config.setSkillDisabled.mock.calls.map(call => call.arguments), [
    [{ name: 'fixture', disabled: true }], [{ name: 'fixture', disabled: false }],
  ]);
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

test('global skill display uses only the native effective disabledSkills value and never exposes unrelated settings', async t => {
  const h = harness(t);
  const path = join(h.cwd, 'SKILL.md');
  writeFileSync(path, 'native skill body');
  h.discoveredSkills.push({ name: 'fixture', description: 'native', source: 'personal-copilot',
    enabled: true, userInvocable: true, path });
  h.userSettings.settings.disabledSkills = { value: ['fixture'], default: [], isDefault: false };
  h.userSettings.settings.credentials = { value: 'private-native-setting', default: null, isDefault: false };
  const list = await h.engine.listGlobalSkills(h.cwd);
  const body = await h.engine.readSkillBody('fixture', h.cwd);
  assert.equal(list[0]!.enabled, false);
  assert.equal(body.enabled, false);
  assert.equal(body.body, 'native skill body');
  assert.ok(!JSON.stringify({ list, body }).includes('private-native-setting'));
  assert.equal(h.runtime.rpc.skills.config.setSkillDisabled.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.user.settings.get.mock.callCount(), 2);
});

test('global skill settings must be readable string arrays, with no discovery or default-value fallback', async t => {
  const h = harness(t);
  h.discoveredSkills.push({ name: 'fixture', description: 'native', source: 'personal-copilot', enabled: true, userInvocable: true });
  h.userSettings.settings.disabledSkills!.value = null;
  assert.equal((await h.engine.listGlobalSkills(h.cwd))[0]!.enabled, true, 'native null is an explicitly unset list');
  for (const value of [false, 'fixture', {}, [false]]) {
    h.userSettings.settings.disabledSkills = { value, default: [], isDefault: false };
    await assert.rejects(h.engine.listGlobalSkills(h.cwd), /disabledSkills must be a string array/);
    await assert.rejects(h.engine.setGlobalSkill('fixture', false, h.cwd), /disabledSkills must be a string array/);
  }
  assert.equal(h.runtime.rpc.skills.config.setSkillDisabled.mock.callCount(), 0);
  h.runtime.rpc.user.settings.get.mock.mockImplementationOnce(async () => { throw new Error('native settings unavailable'); });
  await assert.rejects(h.engine.listGlobalSkills(h.cwd), /native settings unavailable/);
});

test('global skill unknown, ignored, unavailable and malformed discovery never claim success', async t => {
  const h = harness(t);
  await assert.rejects(h.engine.setGlobalSkill('unknown', false, h.cwd), /Unknown skill/);
  assert.equal(h.runtime.rpc.skills.config.setSkillDisabled.mock.callCount(), 0);
  h.discoveredSkills.push({ name: 'fixture', description: 'native', source: 'personal-copilot', enabled: true, userInvocable: true });
  h.runtime.rpc.skills.config.setSkillDisabled.mock.mockImplementationOnce(async () => {});
  await assert.rejects(h.engine.setGlobalSkill('fixture', false, h.cwd), /did not confirm/);
  h.runtime.rpc.skills.discover.mock.mockImplementationOnce(async () => ({ skills: [], errors: ['fixture SKILL.md parse failed'] }));
  await assert.rejects(h.engine.listGlobalSkills(h.cwd), /SKILL.md parse failed/);
  delete h.userSettings.settings.disabledSkills;
  await assert.rejects(h.engine.listGlobalSkills(h.cwd), /unconfirmed/);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('skill reload diagnostics are explicit rather than silently returning partial success', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.skills.reload.mock.mockImplementationOnce(async () => ({ warnings: ['native load warning'], errors: [] }));
  await assert.rejects(h.engine.refreshSkills(), /native load warning/);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

for (const action of ['listGlobalSkills', 'readSkillBody'] as const) {
  test(`${action} discovers the requested cwd without creating or borrowing sessions`, async t => {
    const h = harness(t);
    const unrelated = await h.load();
    unrelated.state.skills = [{
      name: 'fixture', description: 'unrelated project skill', source: 'project', enabled: true, userInvocable: true,
      path: join(h.cwd, 'must-not-read.md'),
    }];
    const before = nativeCalls(unrelated);
    const prefs = readFileSync(h.prefsFile, 'utf8');
    const directory = join('.engine-test-scratch', 'requested-project');
    h.events.length = 0;
    if (action === 'listGlobalSkills') assert.deepEqual(await h.engine.listGlobalSkills(directory), []);
    else await assert.rejects(h.engine.readSkillBody('fixture', directory), /Unknown skill in this working directory/);
    assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls.map(call => call.arguments),
      [[{ projectPaths: [resolve(directory)], skillDirectories: [bundledSkillsDirectory] }]]);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
    assert.deepEqual(nativeCalls(unrelated), before);
    assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs, 'discovery must not leave trash or preferences');
    assert.deepEqual(h.events, []);
    assert.equal((await h.engine.getMeta(unrelated.id))?.loaded, true);
    assert.equal(unrelated.listeners.size, 1);
    assert.deepEqual([...h.attached], [unrelated.id]);
  });
}

test('global skill discovery uses server truth even when a loaded session has the same cwd', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.skills = [{
    name: 'stale-session-skill', description: 'not server discovery', source: 'project', enabled: true, userInvocable: true,
  }];
  h.discoveredSkills.push({
    name: 'fixture', description: 'discovered project skill', source: 'project', userInvocable: true,
    path: join(h.cwd, 'SKILL.md'), enabled: true,
  });
  const before = nativeCalls(s);
  assert.deepEqual(await h.engine.listGlobalSkills(h.cwd), [{
    name: 'fixture', description: 'discovered project skill', source: 'project', userInvocable: true, enabled: true,
  }]);
  assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls[0]!.arguments, [{ projectPaths: [h.cwd], skillDirectories: [bundledSkillsDirectory] }]);
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal('trashed' in h.prefs(), false);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  assert.equal(s.listeners.size, 1);
});

for (const cwd of [undefined, '']) {
  test(`global skill discovery defaults ${cwd === undefined ? 'omitted' : 'empty'} cwd to the home project path`, async t => {
    const h = harness(t);
    assert.deepEqual(await h.engine.listGlobalSkills(cwd), []);
    assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls[0]!.arguments, [{ projectPaths: [resolve(homedir())], skillDirectories: [bundledSkillsDirectory] }]);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
    assert.deepEqual((await h.engine.snapshot()).sessions, []);
  });
}

test('readSkillBody reads the discovered local path rather than a matching session skill', async t => {
  const h = harness(t);
  const s = await h.load();
  const path = join(h.cwd, 'skill-body.txt');
  const body = '---\nname: fixture\n---\nLocal native-discovered skill body.\n';
  writeFileSync(path, body);
  h.discoveredSkills.push({ name: 'fixture', description: 'discovered body', source: 'project', userInvocable: true, enabled: true, path });
  s.state.skills = [{
    name: 'fixture', description: 'wrong body', source: 'project', enabled: true, userInvocable: true,
    path: join(h.cwd, 'must-not-read.txt'),
  }];
  const before = nativeCalls(s);
  assert.deepEqual(await h.engine.readSkillBody('fixture', h.cwd), {
    name: 'fixture', description: 'discovered body', source: 'project', userInvocable: true, enabled: true, body,
  });
  assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls[0]!.arguments, [{ projectPaths: [h.cwd], skillDirectories: [bundledSkillsDirectory] }]);
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
});

test('native global skill discovery failure propagates without a session fallback or trash', async t => {
  const h = harness(t);
  const unrelated = await h.load();
  const before = nativeCalls(unrelated);
  const prefs = readFileSync(h.prefsFile, 'utf8');
  h.runtime.rpc.skills.discover.mock.mockImplementation(async () => { throw new Error('native discovery failed'); });
  await assert.rejects(h.engine.listGlobalSkills(h.cwd), /native discovery failed/);
  await assert.rejects(h.engine.readSkillBody('fixture', h.cwd), /native discovery failed/);
  assert.equal(h.runtime.rpc.skills.discover.mock.callCount(), 2);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.deepEqual(nativeCalls(unrelated), before);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs);
  assert.equal((await h.engine.getMeta(unrelated.id))?.loaded, true);
  assert.deepEqual([...h.attached], [unrelated.id]);
});

test('refreshSkills with no loaded sessions uses native discovery without loading historical sessions', async t => {
  const h = harness(t);
  const s = await h.seed();
  await h.engine.refreshSkills();
  assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls.map(call => call.arguments),
    [[{ projectPaths: [resolve(homedir())], skillDirectories: [bundledSkillsDirectory] }]]);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(s.rpc.skills.reload.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal('trashed' in h.prefs(), false);
});

test('live refreshSkills checks liveness and never resumes an expired or unloaded peer', async t => {
  const h = harness(t);
  const live = await h.load();
  const expired = await h.load();
  const unloaded = await h.seed();
  h.runtime.expire(expired.id);
  const resumes = h.runtime.resumeSession.mock.callCount();
  const expiredCalls = nativeCalls(expired);
  let failure: unknown;
  try { await h.engine.refreshSkills(); }
  catch (error) { failure = error; }
  if (failure) assert.match(String(failure), unavailableSession);
  assert.equal(live.rpc.skills.reload.mock.callCount(), 1);
  assert.deepEqual(nativeCalls(expired), expiredCalls);
  assert.equal(unloaded.rpc.skills.reload.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(expired.id))?.loaded, false);
  assert.equal((await h.engine.getMeta(live.id))?.loaded, true);
});

function journal(sessionId: string, cwd: string): SessionEvent[] {
  return [
    event('session.start', { sessionId, version: 1, producer: 'structural-fixture', copilotVersion: 'test',
      startTime: timestamp, context: { cwd } }),
    user('history-user', 'history question'),
    assistant('history-answer-event', 'history-answer', 'history answer'),
    event('session.title_changed', { title: 'persisted title' }),
    user('latest-user', 'latest question'),
    assistant('latest-answer-event', 'latest-answer', 'latest answer'),
  ];
}

function nestedJournal(): SessionEvent[] {
  const scoped = (native: SessionEvent, agentId: string) => ({ ...native, agentId });
  const start = (toolCallId: string) => event('subagent.started', {
    toolCallId, agentName: 'explore', agentDisplayName: toolCallId, agentDescription: `${toolCallId} task`,
  });
  const complete = (toolCallId: string) => event('subagent.completed', {
    toolCallId, agentName: 'explore', agentDisplayName: toolCallId,
  });
  return [
    user('nested-root', 'Inspect nested work'),
    event('assistant.message', { messageId: 'outer-spawn', content: '', toolRequests: [
      { toolCallId: 'outer', name: 'task', arguments: { prompt: 'outer private prompt' } },
    ] }),
    scoped(start('outer'), 'outer-agent'),
    scoped(assistant('outer-intro-event', 'outer-intro', 'outer progress'), 'outer-agent'),
    scoped(event('assistant.message', { messageId: 'inner-spawn', content: '', toolRequests: [
      { toolCallId: 'inner', name: 'task', arguments: { prompt: 'inner private prompt' } },
    ] }), 'outer-agent'),
    scoped(start('inner'), 'inner-agent'),
    scoped(assistant('inner-answer-event', 'inner-answer', 'deep child answer'), 'inner-agent'),
    scoped(complete('inner'), 'inner-agent'),
    scoped(assistant('outer-answer-event', 'outer-answer', 'outer final answer'), 'outer-agent'),
    scoped(complete('outer'), 'outer-agent'),
    assistant('root-answer-event', 'root-answer', 'root final answer'),
  ];
}

for (const availability of ['loaded', 'unloaded', 'legacy-trashed'] as const) {
  test(`native chat reads one passive page for ${availability} sessions without changing runtime or metadata`, async t => {
    const id = 'native-chat-session';
    const h = harness(t, { prefs: availability === 'legacy-trashed' ? { trashed: { [id]: { at: 1 } } } : {} });
    const s = await h.seed(id);
    const journal = nestedJournal();
    h.journals.set(s.id, journal);
    if (availability === 'loaded') await h.engine.reload(s.id);
    const snapshot = (await h.engine.snapshot());
    const before = nativeCalls(s);
    const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
    const resumes = h.runtime.resumeSession.mock.callCount();
    const probes = h.runtime.isSessionLive.mock.callCount();
    const prefs = readFileSync(h.prefsFile, 'utf8');
    h.events.length = 0;
    const page = await chat(h, s.id, { max: 3 });
    assert.deepEqual(page.events, journal.slice(-3));
    assert.equal(page.hasMore, true);
    assert.equal('title' in page, false);
    assert.equal('cwd' in page, false);
    assert.deepEqual(page.read, { rpc: 1, events: 3 });
    assert.deepEqual(h.runtime.rpc.sessions.readPersistedEvents.mock.calls.map(call => call.arguments), [[{
      sessionId: s.id, direction: 'backward', cursor: undefined, max: 3,
    }]]);
    assert.deepEqual(nativeCalls(s), before);
    assert.equal(h.runtime.isSessionLive.mock.callCount(), probes);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads + (availability === 'loaded' ? 0 : 1),
      'only an unanchored unloaded read verifies native existence');
    assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs);
    assert.deepEqual((await h.engine.snapshot()), snapshot);
    assert.deepEqual(h.events, []);
  });
}

test('unlisted native chat confirms existence without registering or returning metadata', async t => {
  const h = harness(t);
  const id = 'unlisted-native-session';
  h.rows.push({
    sessionId: id, summary: 'native metadata title', isRemote: false,
    startTime: new Date(timestamp), modifiedTime: new Date(timestamp), context: { workingDirectory: h.cwd },
  });
  h.journals.set(id, journal(id, join(h.cwd, 'old-transcript-directory')));
  const page = await chat(h, id, { max: 1 });
  assert.equal('title' in page, false);
  assert.equal('cwd' in page, false);
  assert.equal(page.events.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(h.runtime.getSessionMetadata.mock.callCount(), 1);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 1);
  assert.equal(activeState(h, id), undefined);
  assert.equal(h.runtime.listSessions.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.deepEqual(h.events, []);
});

test('unknown native metadata rejects chat instead of guessing from a journal or fabricating an empty draft', async t => {
  const h = harness(t);
  h.journals.set('missing-native-session', nestedJournal());
  await assert.rejects(chat(h, 'missing-native-session'), { statusCode: 404 });
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.deepEqual((await h.engine.snapshot()).sessions, []);
  assert.deepEqual(h.events, []);
});

test('passive native chat leaves live and indexed metadata to the separate session getter', async t => {
  const h = harness(t);
  const s = await h.load();
  h.journals.set(s.id, journal(s.id, join(h.cwd, 'stale-cwd')));
  await h.engine.rename(s.id, 'confirmed live title');
  h.rows[0]!.summary = 'stale list title';
  await h.engine.refreshList();
  const before = (await h.engine.getMeta(s.id));
  assert.equal(before?.title, 'confirmed live title');
  assert.equal(before?.cwd, h.cwd);
  const reads = nativeCalls(s);
  h.events.length = 0;
  const page = await chat(h, s.id, { max: 1 });
  assert.equal('title' in page, false);
  assert.equal('cwd' in page, false);
  assert.deepEqual(nativeCalls(s), reads);
  assert.deepEqual((await h.engine.getMeta(s.id)), before);
  assert.deepEqual(h.events, []);
});

for (const direction of ['forward', 'backward'] as const) {
  test(`native ${direction} event cursors select exactly one page and returned data is request-isolated`, async t => {
    const h = harness(t);
    const s = await h.seed();
    const journal = nestedJournal();
    h.journals.set(s.id, journal);
    const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
    const first = await chat(h, s.id, { direction, max: 2 });
    assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads + 1);
    const expected = direction === 'forward' ? journal.slice(2, 4) : journal.slice(-4, -2);
    const second = await chat(h, s.id, { direction, max: 2, cursor: first.cursor });
    assert.deepEqual(second.events, expected);
    assert.deepEqual(h.runtime.rpc.sessions.readPersistedEvents.mock.calls[1]!.arguments, [{
      sessionId: s.id, direction, max: 2, cursor: first.cursor,
    }]);
    second.events[0]!.data.content = 'caller mutation';
    second.events.splice(1);
    const again = await chat(h, s.id, { direction, max: 2, cursor: first.cursor });
    assert.deepEqual(again.events, expected);
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 3, 'no shared response or full-history cache');
    assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads + 1,
      'known native cursors avoid additional metadata RPCs');
    assert.deepEqual(again.read, { rpc: 1, events: 2 });
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
    assert.equal(s.sdk.on.mock.callCount(), 0);
  });
}

test('live native chat forwards child, event, wait and ephemeral filters without traversing root history', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = nestedJournal();
  const before = nativeCalls(s);
  const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
  const page = await chat(h, s.id, {
    source: 'live', direction: 'forward', max: 1, waitMs: 1000, includeEphemeral: false,
    agentIds: ['inner-agent'], agentScope: 'all', types: ['assistant.message'],
  });
  assert.deepEqual(page.events, [s.state.events.find(event => event.id === 'inner-answer-event')!]);
  assert.deepEqual(page.read, { rpc: 1, events: 1 });
  assert.deepEqual(s.rpc.eventLog.read.mock.calls.at(-1)!.arguments, [{
    cursor: undefined, max: 1, direction: 'forward', waitMs: 1000, includeEphemeral: false,
    types: ['assistant.message'], agentScope: 'all', agentIds: ['inner-agent'],
  }]);
  assert.deepEqual(nativeCallDelta(s, before), { 'eventLog.read': 1 });
  assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(serverChatEvents(h).length, 0);
});

test('native chat bootstrap uses a separate forward tail and performs no replay or interest registration', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = [user('before-bootstrap')];
  const before = nativeCalls(s);
  const metadataReads = h.runtime.getSessionMetadata.mock.callCount();
  const page = await chat(h, s.id, { source: 'live', bootstrap: true, max: 1 });
  assert.ok(page.liveCursor);
  assert.deepEqual(page.read, { rpc: 2, events: 1 });
  assert.deepEqual(nativeCallDelta(s, before), { 'eventLog.tail': 1, 'eventLog.read': 1 });
  s.emit(assistant('after-bootstrap', 'answer', 'new native event'));
  const next = await chat(h, s.id, { source: 'live', direction: 'forward', cursor: page.liveCursor, max: 1 });
  assert.deepEqual(next.events.map(event => event.id), ['after-bootstrap']);
  assert.deepEqual(s.rpc.eventLog.read.mock.calls.at(-1)!.arguments, [{
    cursor: page.liveCursor, max: 1, direction: 'forward', waitMs: 0, includeEphemeral: true,
    types: CHAT_EVENT_TYPES, agentScope: 'all',
  }]);
  assert.equal(h.runtime.getSessionMetadata.mock.callCount(), metadataReads,
    'live bootstrap and cursor polls never query separate native metadata');
  assert.equal(serverChatEvents(h).length, 0);
});

for (const availability of ['unloaded', 'closed', 'legacy-trashed'] as const) {
  test(`native live chat rejects ${availability} handles without passive fallback or auto-resume`, async t => {
    const id = 'native-chat-session';
    const h = harness(t, { prefs: availability === 'legacy-trashed' ? { trashed: { [id]: { at: 1 } } } : {} });
    const s = availability === 'closed' ? await h.load(id) : await h.seed(id);
    if (availability === 'closed') h.runtime.expire(s.id, true);
    const before = nativeCalls(s);
    const resumes = h.runtime.resumeSession.mock.callCount();
    await assert.rejects(chat(h, s.id, { source: 'live' }), { code: 'SESSION_UNLOADED', statusCode: 409 });
    assert.deepEqual(nativeCalls(s), before);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
    assert.equal(h.runtime.createSession.mock.callCount(), 0);
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
  });
}

for (const source of ['persisted', 'live'] as const) {
  test(`native ${source} chat failures are request-scoped, never retried or replaced with cached data`, async t => {
    const h = harness(t);
    const s = await h.load();
    const read = source === 'live' ? s.rpc.eventLog.read : h.runtime.rpc.sessions.readPersistedEvents;
    const calls = read.mock.callCount();
    read.mock.mockImplementationOnce(async () => { throw new Error('native page unavailable'); });
    const before = (await h.engine.getMeta(s.id));
    await assert.rejects(chat(h, s.id, { source }), /native page unavailable/);
    assert.equal(read.mock.callCount(), calls + 1);
    assert.deepEqual((await h.engine.getMeta(s.id)), before, 'display read failure does not poison control state');
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
    assert.equal(serverChatEvents(h).length, 0);
    s.state.name = 'control remains responsive';
    s.emit(event('session.title_changed', { title: s.state.name }));
    assert.equal((await h.engine.getMeta(s.id))?.title, 'control remains responsive');
  });
}

test('native event reads return expired cursors explicitly without restarting or scanning history', async t => {
  const h = harness(t);
  const s = await h.seed();
  h.journals.set(s.id, [user('before-rewrite')]);
  const page = await chat(h, s.id, { max: 1 });
  h.journals.set(s.id, [user('after-rewrite')]);
  const expired = await chat(h, s.id, { cursor: page.cursor, max: 1 });
  assert.equal(expired.cursorStatus, 'expired');
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 2);
  assert.deepEqual(expired.read, { rpc: 1, events: 1 });
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('loaded initialization keeps only control state and does not prewarm a large display journal', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.events = Array.from({ length: 3000 }, (_, i) => assistant(`event-${i}`, `message-${i}`, 'history payload'));
  await h.engine.reload(s.id);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 0, 'initialization does not read chat or cache naming eligibility');
  const state = activeState(h, s.id);
  for (const key of ['fold', 'eventIds', 'userMessageIds']) assert.equal(key in state, false);
  const page = await chat(h, s.id, { source: 'live', max: 2 });
  assert.deepEqual(page.events.map(event => event.id), ['event-2998', 'event-2999']);
  assert.deepEqual(page.read, { rpc: 1, events: 2 });
  assert.equal(page.hasMore, true);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 1);
  for (const native of nestedJournal()) s.emit(native);
  s.emit({ ...event('assistant.message_delta', { messageId: 'stream', deltaContent: 'native streaming' }), ephemeral: true });
  await nextTurn();
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 1, 'live callbacks never refill a server display cache');
  assert.equal(s.sdk.getEvents.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal(JSON.stringify((await h.engine.snapshot())).includes('history payload'), false);
  assert.equal(JSON.stringify(h.events).includes('native streaming'), false);
  assert.equal('changedFiles' in await h.engine.getPlan(s.id), false);
});

for (const success of [true, false]) {
  test(`compaction completion (${success}) updates progress without invalidating or replaying native chat`, async t => {
    const h = harness(t);
    const s = await h.load();
    const reads = s.rpc.eventLog.read.mock.callCount();
    s.emit(event('session.compaction_start', {}));
    assert.ok(h.events.some(event => event.type === 'session/invalidated' && event.sessionId === s.id));
    s.emit(event('session.compaction_complete', { success }));
    await nextTurn();
    assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
    assert.deepEqual(h.events.filter(event => event.type === 'chat/invalidated'), []);
    assert.equal(s.rpc.eventLog.read.mock.callCount(), reads);
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
    assert.equal(serverChatEvents(h).length, 0);
  });
}

for (const action of ['unload', 'stop'] as const) {
  test(`pending live chat long-poll creates no busy state and cannot block idle ${action}`, async t => {
    const h = harness(t);
    const s = await h.load();
    const state = activeState(h, s.id);
    const beforeRead = (await h.engine.snapshot());
    const read = deferred<Awaited<ReturnType<Rpc['eventLog']['read']>>>();
    let nativeReadSettled = false;
    s.rpc.eventLog.read.mock.mockImplementationOnce(async () => {
      const page = await read.promise;
      nativeReadSettled = true;
      return page;
    });
    const pending = assert.rejects(chat(h, s.id, {
      source: 'live', direction: 'forward', waitMs: 1000,
    }), /closed during operation/);
    await nextTurn();
    assert.equal(s.rpc.eventLog.read.mock.calls.at(-1)!.arguments[0].waitMs, 1000);
    assert.equal(nativeReadSettled, false);
    assert.equal(activeState(h, s.id).operations, 0);
    assert.deepEqual((await h.engine.snapshot()), beforeRead, 'chat must not publish artificial processing or operations');
    assert.equal(sessionMetaBusy((await h.engine.getMeta(s.id))!), false, 'the server restart predicate stays idle');
    await promptly(action === 'unload' ? h.engine.unload(s.id) : h.engine.stop());
    await promptly(pending);
    assert.equal(nativeReadSettled, false, 'close and chat rejection must not wait for the native poll response');
    assert.equal(h.attached.has(s.id), false);
    assert.equal(activeState(h, s.id), undefined);
    assert.equal(state.operations, 0);
    assert.equal(h.runtime.closeSession.mock.callCount(), 1);
    assert.equal(h.runtime.stop.mock.callCount(), action === 'stop' ? 1 : 0);
    if (action === 'stop') assert.ok(h.trace.indexOf(`close:${s.id}`) < h.trace.indexOf('stop'));
    const beforeLateResult = structuredClone(h.events);
    read.resolve({ events: [assistant('late-page', 'late-answer')], cursor: 'late', cursorStatus: 'ok', hasMore: false });
    await nextTurn();
    assert.equal(nativeReadSettled, true);
    assert.deepEqual(h.events, beforeLateResult);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
    assert.equal(s.sdk.abort.mock.callCount(), 0);
    assert.equal(s.rpc.queue.clear.mock.callCount(), 0);
    assert.equal(serverChatEvents(h).length, 0);
  });

  for (const work of ['processing', 'queue'] as const) {
    test(`pending live chat long-poll cannot weaken ${work} protection during ${action}`, async t => {
      const h = harness(t);
      const s = await h.load();
      const state = activeState(h, s.id);
      s.state.processing = work === 'processing';
      s.state.queue.items = work === 'queue' ? [queued('protected-queue', 'must remain queued')] : [];
      s.emit(event('pending_messages.modified', {}));
      await nextTurn();
      const queue = structuredClone(s.state.queue);
      const meta = (await h.engine.getMeta(s.id));
      const read = deferred<Awaited<ReturnType<Rpc['eventLog']['read']>>>();
      s.rpc.eventLog.read.mock.mockImplementationOnce(() => read.promise);
      let chatSettled = false;
      const pending = assert.rejects(chat(h, s.id, {
        source: 'live', direction: 'forward', waitMs: 1000,
      }).finally(() => { chatSettled = true; }), /closed during operation/);
      await nextTurn();
      assert.equal(activeState(h, s.id).operations, 0);
      assert.deepEqual((await h.engine.getMeta(s.id)), meta);
      assert.equal(sessionMetaBusy((await h.engine.getMeta(s.id))!), true);
      await assert.rejects(action === 'unload' ? h.engine.unload(s.id) : h.engine.stop(), protectedWork);
      assert.equal(chatSettled, false, 'refused teardown leaves the existing native read attached');
      assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
      assert.equal((await h.engine.getMeta(s.id))?.closing, false);
      assert.equal(sessionMetaBusy((await h.engine.getMeta(s.id))!), true);
      assert.equal(s.state.processing, work === 'processing');
      assert.deepEqual(s.state.queue, queue);
      assert.deepEqual((await h.engine.getMeta(s.id))?.queue, work === 'queue'
        ? [{ id: 'protected-queue', text: 'must remain queued' }] : []);
      assert.equal(h.runtime.closeSession.mock.callCount(), 0);
      assert.equal(h.runtime.stop.mock.callCount(), 0);
      assert.equal(s.sdk.abort.mock.callCount(), 0);
      assert.equal(s.rpc.queue.clear.mock.callCount(), 0);
      assert.equal(s.rpc.queue.removeAt.mock.callCount(), 0);
      s.state.processing = false;
      s.state.queue.items = [];
      s.emit(event('session.idle', {}));
      await nextTurn();
      assert.equal(sessionMetaBusy((await h.engine.getMeta(s.id))!), false, 'only native work completion releases protection');
      assert.equal(chatSettled, false);
      await promptly(action === 'unload' ? h.engine.unload(s.id) : h.engine.stop());
      await promptly(pending);
      assert.equal(h.runtime.closeSession.mock.callCount(), 1);
      assert.equal(h.runtime.stop.mock.callCount(), action === 'stop' ? 1 : 0);
      const beforeLateResult = structuredClone(h.events);
      read.resolve({ events: [], cursor: 'late', cursorStatus: 'ok', hasMore: false });
      await nextTurn();
      assert.deepEqual(h.events, beforeLateResult);
      assert.equal(activeState(h, s.id), undefined);
      assert.equal(state.operations, 0);
      assert.equal(serverChatEvents(h).length, 0);
    });
  }
}

test('stopped engines reject new session work until an explicit start', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.stop();
  await assert.rejects(h.engine.prompt(s.id, 'must not be accepted'), /stopped/);
  await assert.rejects(h.engine.newSession(h.cwd), /stopped/);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  await h.engine.start();
  await h.engine.reload(s.id);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 2);
  await h.engine.stop();
});

test('passive metadata follows native index removal and return without retaining unloaded rows', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.rename(s.id, 'just renamed');
  const metadata = h.rows[0]!;
  await h.engine.unload(s.id);
  h.rows.length = 0;
  await h.engine.refreshList();
  assert.equal((await h.engine.getMeta(s.id)), null);
  assert.equal(activeState(h, s.id), undefined);
  metadata.summary = 'native index returned';
  h.rows.push(metadata);
  assert.equal((await h.engine.getMeta(s.id))?.title, 'native index returned');
  assert.equal((await h.engine.getMeta(s.id))?.cwd, h.cwd);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

test('legacy trash migration unhides native sessions without deletion, resume, lost marks, or metadata replicas', async t => {
  const h = harness(t, { prefs: {
    trashed: { legacy: { at: '2026-09-01', reason: 'old soft deletion' } },
    trashedMeta: { legacy: { title: 'obsolete' } },
    pinnedSessions: ['legacy'],
    inbox: { revision: 1, counter: 1, sessions: {
      legacy: { attention: 'ready', attnId: 1, seenId: 0, eventId: 'legacy-reply' },
    } },
    workerMetadata: { legacy: { opaque: true } },
  } });
  await h.seed('legacy');
  const meta = (await h.engine.getMeta('legacy'))!;
  assert.equal(meta.loaded, false);
  assert.equal(meta.title, 'indexed title');
  assert.equal(meta.pinned, true);
  assert.equal(meta.attention, 'ready');
  assert.equal(h.engine.attentionCount(), 1);
  assert.equal((await h.engine.listLive()).some(row => row.sessionId === 'legacy'), true);
  assert.equal(activeState(h, 'legacy'), undefined);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.prefs().trashed, undefined);
  assert.equal(h.prefs().trashedMeta, undefined);
  assert.deepEqual(h.prefs().workerMetadata, { legacy: { opaque: true } });
  for (const retired of ['listTrash', 'restoreSession', 'purgeSession']) assert.equal(retired in h.engine, false);
});

test('unloaded metadata comes from native persistence rather than the previous live title', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.rename(s.id, 'just renamed');
  const metadata = h.rows[0]!;
  h.runtime.getSessionMetadata.mock.mockImplementation(async () => metadata);
  h.rows.length = 0;
  await h.engine.unload(s.id);
  assert.equal((await h.engine.getMeta(s.id))?.title, metadata.summary);
  assert.equal((await h.engine.getMeta(s.id))?.cwd, h.cwd);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, false);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

test('native todo changes update progress without opening the plan panel', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows: [
    { id: 'one', title: 'Completed work', status: 'done' },
    { id: 'two', title: 'Native current work', status: 'in_progress' },
  ] }));
  s.emit(event('session.todos_changed', {}));
  await nextTurn();
  assert.deepEqual((await h.engine.getMeta(s.id))?.todo, { done: 1, total: 2, intent: 'Native current work' });
  s.rpc.plan.readSqlTodos.mock.mockImplementation(async () => ({ rows: [] }));
  s.emit(event('session.todos_changed', {}));
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.todo, null);
});

test('a completely rolled-back file rewind does not claim a lasting mutation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.history.rewind.mock.mockImplementation(async () => ({
    outcome: 'files-rolled-back', restoredFiles: ['restored-then-reverted.txt'],
    skippedFiles: [], error: 'Restore failed; workspace restored to pre-rewind state',
  }));
  await assert.rejects(h.engine.rewind(s.id, 'boundary', true), /files-rolled-back/);
  assert.equal(serverChatEvents(h).length, 0);
  assert.equal(h.events.filter(event => event.type === 'chat/invalidated').length, 0);
});

test('session creation and resume delegate discovery and selection entirely to Copilot', async t => {
  const legacy = { mcpDefaultOn: [], mcpBySession: { existing: ['other'] },
    skillsDisabledBySession: { existing: ['fixture'] }, skillsAllowlistBySession: { existing: [] } };
  const h = harness(t, { mcpServers: { fixture: { command: 'never-executed', tools: ['*'] } }, prefs: legacy });
  h.userSettings.settings.disabledSkills!.value = ['native-disabled'];
  const s = await h.load();
  const created = await h.engine.newSession(h.cwd);
  for (const id of [s.id, created]) {
    const config = h.configs.get(id)!;
    assert.equal(config.enableConfigDiscovery, true);
    for (const key of ['mcpServers', 'disabledMcpServers']) assert.equal(Object.hasOwn(config, key), false);
    assert.deepEqual(config.disabledSkills, ['native-disabled']);
  }
  assert.deepEqual(h.prefs(), {}, 'retired Cockpit choices are removed rather than replayed into native config');
  assert.equal(s.rpc.skills.disable.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.config.disable.mock.callCount(), 0);
  h.userSettings.settings.disabledSkills!.value = ['changed-natively'];
  await h.engine.unload(s.id);
  await h.engine.reload(s.id);
  assert.deepEqual(h.configs.get(s.id)!.disabledSkills, ['changed-natively'], 'cold resume reads current native global choices');
  assert.deepEqual(h.prefs(), {});
});

test('session allocation refuses unreadable native skill defaults rather than enabling everything', async t => {
  const h = harness(t);
  const s = await h.seed();
  h.runtime.rpc.user.settings.get.mock.mockImplementation(async () => { throw new Error('native skill settings unavailable'); });
  await assert.rejects(h.engine.reload(s.id), /native skill settings unavailable/);
  await assert.rejects(h.engine.newSession(h.cwd), /native skill settings unavailable/);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
});

async function finishReply(s: Awaited<ReturnType<Harness['load']>>, content: string, id: string = randomUUID()) {
  s.emit(event('assistant.turn_start', { turnId: id }));
  s.emit(assistant(`message-${id}`, `reply-${id}`, content));
  const end = event('assistant.turn_end', { turnId: id }, `end-${id}`);
  s.emit(end);
  await nextTurn();
  return end;
}

test('auto naming begins after the first effective reply and unread commit, coalesces clients, and never sends', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.userNamed = false;
  const query = deferred<{ answer: string }>();
  s.rpc.ui.ephemeralQuery.mock.mockImplementationOnce(() => query.promise);
  const end = await finishReply(s, 'Backend naming implementation', 'auto-first');
  const before = structuredClone(s.state.events);
  const inbox = (await h.engine.snapshot());
  assert.equal(inbox.unreadCount, 1, 'Reply notification is not delayed by the auxiliary query');
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  assert.equal((await h.engine.getMeta(s.id))?.autoNaming, true);
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
  const one = h.engine.autoName(s.id), two = h.engine.autoName(s.id);
  for (const listener of s.listeners) listener(end);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  await assert.rejects(h.engine.stop(), protectedWork);
  query.resolve({ answer: '后端首次回复自动命名' });
  assert.deepEqual(await one, { ok: true, applied: true, title: '后端首次回复自动命名' });
  assert.deepEqual(await two, await one);
  assert.equal((await h.engine.getMeta(s.id))?.autoNaming, false);
  assert.equal((await h.engine.snapshot()).inboxRevision, inbox.inboxRevision);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(s.sdk.getEvents.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.liveCount, 1);
  assert.deepEqual(s.state.events.slice(0, before.length), before);
  await finishReply(s, 'Later answer', 'auto-second');
  await h.engine.reload(s.id);
  await finishReply(s, 'Cold resumed answer', 'auto-third');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
  assert.equal((await h.engine.autoName(s.id)).applied, true, 'An explicit later button may regenerate a native automatic title');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 2);
  assert.equal(Object.hasOwn(h.prefs(), 'titles'), false);
  assert.equal(JSON.stringify(h.prefs()).includes('autoName'), false);
});

test('auto naming ignores historical completed replies, even on a new Engine and passive history reads', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.userNamed = false;
  s.state.events.push(user('old-user'), event('assistant.turn_start', { turnId: 'old' }),
    assistant('old-answer', 'old-message'), event('assistant.turn_end', { turnId: 'old' }));
  h.journals.set(s.id, structuredClone(s.state.events));
  await chat(h, s.id);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  await h.engine.reload(s.id);
  await finishReply(s, 'New answer in old session');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  await h.engine.unload(s.id);
  const restored = new Engine({ runtime: h.runtime as unknown as EngineRuntime, prefsFile: h.prefsFile });
  await restored.refreshList();
  await restored.reload(s.id);
  await finishReply(s, 'New process answer');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  await restored.unload(s.id);
  const before = h.runtime.resumeSession.mock.callCount();
  assert.equal((await restored.autoName(s.id)).applied, true);
  assert.equal(h.runtime.resumeSession.mock.callCount(), before + 1, 'Explicit manual naming may load an old native session');
  assert.equal(s.sdk.getEvents.mock.callCount(), 0);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  await restored.unload(s.id);
});

test('automatic naming rereads native eligibility instead of remembering prior completed replies', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.userNamed = false;
  s.state.events = [
    event('assistant.turn_start', { turnId: 'old' }), assistant('old-message', 'old-reply'),
    event('assistant.turn_end', { turnId: 'old' }),
  ];
  await h.engine.reload(s.id);
  await finishReply(s, 'Not eligible for automatic naming yet');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  s.state.name = null;
  s.state.events = [];
  await finishReply(s, 'First effective reply after native history and title changed');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1, 'a prior native read is not a host naming attempt');
  assert.equal(s.state.name, 'Native session naming');
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('automatic first-reply checks read filtered native events in forward order without a cached result', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.userNamed = false;
  s.state.events = [
    { ...assistant('child-answer', 'child-reply'), agentId: 'child' },
    { ...event('assistant.turn_end', { turnId: 'child' }), agentId: 'child' },
    { ...assistant('ephemeral-answer', 'ephemeral-reply'), ephemeral: true },
    { ...event('assistant.turn_end', { turnId: 'ephemeral' }), ephemeral: true },
    event('assistant.turn_start', { turnId: 'failed' }),
    assistant('failed-answer', 'failed-reply'),
    event('session.error', { errorType: 'test', message: 'Failed before completion' }),
  ];
  await h.engine.reload(s.id);
  await finishReply(s, 'First durable completed primary reply', 'eligible');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
  const reads = s.rpc.eventLog.read.mock.calls.filter(({ arguments: [options] }) =>
    options.agentScope === 'primary' && options.includeEphemeral === false && options.direction === 'forward');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0]!.arguments[0], {
    direction: 'forward', max: 1000, agentScope: 'primary', includeEphemeral: false,
    types: ['assistant.turn_start', 'assistant.message', 'assistant.turn_end', 'tool.execution_start',
      'user.message', 'abort', 'session.error'],
  });
  const page = await reads[0]!.result;
  assert.ok(page);
  assert.deepEqual(page.events.map(native => native.type), [
    'assistant.turn_start', 'assistant.message', 'session.error',
    'assistant.turn_start', 'assistant.message', 'assistant.turn_end',
  ]);
  assert.equal(page.events.at(-1)?.id, 'end-eligible');
  assert.equal(page.hasMore, false);
});

test('automatic naming reports exhausted native eligibility budget without inference and still permits manual naming', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.userNamed = false;
  s.state.events = Array.from({ length: 1000 }, (_, index) => user(`prior-context-${index}`));
  await h.engine.reload(s.id);
  await finishReply(s, 'Reply beyond the bounded eligibility page');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  assert.ok(h.events.some(value => value.type === 'session/patch'
    && /exceeds the bounded native query/.test(value.autoNameError ?? '')));
  const reads = s.rpc.eventLog.read.mock.callCount();
  await nextTurn();
  assert.equal(s.rpc.eventLog.read.mock.callCount(), reads, 'budget failure does not trigger a background retry');
  assert.equal((await h.engine.getMeta(s.id))?.autoNameError, undefined);
  assert.equal((await h.engine.autoName(s.id)).applied, true);
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), reads + 1, 'manual naming only checks bounded conversation presence');
  assert.equal(s.rpc.eventLog.read.mock.calls.at(-1)?.arguments[0].max, 1);
});

test('auto naming preserves first live completion buffered before the native create result', async t => {
  const h = harness(t);
  const initialized = deferred<CopilotSession>();
  let native!: ReturnType<typeof fakeSession>;
  h.runtime.createSession.mock.mockImplementationOnce(async config => {
    native = fakeSession(t, config.sessionId!);
    h.natives.set(config.sessionId!, native);
    h.configs.set(config.sessionId!, config);
    h.attached.add(config.sessionId!);
    native.sdk.on(config.onEvent!);
    native.state.userNamed = false;
    native.emit(user('early-user'));
    native.emit(event('assistant.turn_start', { turnId: 'early-turn' }));
    native.emit(assistant('early-answer', 'early-message', 'Early initialization answer'));
    native.emit(event('assistant.turn_end', { turnId: 'early-turn' }));
    return initialized.promise;
  });
  const loading = h.engine.newSession(h.cwd);
  await nextTurn();
  assert.equal(native.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  initialized.resolve(native.sdk as unknown as CopilotSession);
  const id = await loading;
  await nextTurn();
  assert.equal((await h.engine.getMeta(id))?.title, 'Native session naming');
  assert.equal(native.rpc.ui.ephemeralQuery.mock.callCount(), 1);
  assert.equal(h.engine.attentionCount(), 1);
});

test('auto naming defers new native MCP work found in preflight without a model attempt or error', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.userNamed = false;
  s.state.mcp.host!.pendingConnections = ['unannounced-native-connection'];
  await finishReply(s, 'First successful root reply');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.autoNameError, undefined);
  s.state.mcp.host!.pendingConnections = [];
  s.emit(event('session.mcp_server_status_changed', { serverName: 'unannounced-native-connection', status: 'connected' }));
  await nextTurn();
  assert.equal(h.engine.attentionCount(), 1, 'native MCP completion must release the pending reply notification');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
});

test('cold native workspaces rewound to empty may regenerate an automatic title on their next first reply', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.state.userNamed = false;
  s.state.name = 'Existing automatic title';
  await h.engine.reload(s.id);
  await finishReply(s, 'Reply after history was rewound away');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
  assert.equal(s.state.name, 'Native session naming');
});

test('a native first-prompt placeholder is not mistaken for a generated automatic title', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.userNamed = false;
  s.state.name = 'Initial prompt preview';
  await finishReply(s, 'First effective reply');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
  assert.equal(s.state.name, 'Native session naming');
});

test('queued work and native decisions defer automatic naming until their natural completion', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.userNamed = false;
  s.state.queue.items = [queued('queued-work', 'Next work')];
  await finishReply(s, 'First successful root reply');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  const ask = Promise.resolve(h.configs.get(s.id)!.onUserInputRequest!({ question: 'Choose?' }, { sessionId: s.id }));
  s.state.queue.items = [];
  s.emit(event('pending_messages.modified', {}));
  await nextTurn();
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  await h.engine.respondAsk(s.id, (await h.engine.getMeta(s.id))!.ask!.requestId, 'Answer', true);
  await ask;
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
});

test('auto naming waits for natural native background/MCP/compaction idle and ignores reasoning, child and tool-only turns', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.userNamed = false;
  s.emit(event('assistant.turn_start', { turnId: 'tools' }));
  s.emit(event('assistant.reasoning', { reasoningId: 'reason', content: 'Reasoning is not a reply' }));
  s.emit(event('assistant.message', { messageId: 'tool-message', content: 'Looking at files',
    toolRequests: [{ toolCallId: 'view-file', name: 'view', arguments: { path: 'fixture' } }] }));
  s.emit(event('assistant.turn_end', { turnId: 'tools' }));
  s.emit({ ...assistant('child-event', 'child-message', 'Child answer'), agentId: 'child' });
  s.emit({ ...event('assistant.turn_end', { turnId: 'child' }), agentId: 'child' });
  s.emit({ ...assistant('ephemeral-event', 'ephemeral-message', 'Ephemeral answer'), ephemeral: true });
  s.emit({ ...event('assistant.turn_end', { turnId: 'ephemeral' }), ephemeral: true });
  await nextTurn();
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  s.state.activeWork = true;
  s.state.tasks = [task()];
  s.state.mcp = mcpState();
  s.state.mcp.host!.pendingConnections = ['native-connect'];
  s.emit(event('session.compaction_start', {}));
  s.emit(event('session.mcp_server_status_changed', { serverName: 'native-connect', status: 'pending' }));
  await finishReply(s, '<cockpit-attachment kind="file" name="report.txt" url="/uploads/report.txt"/>', 'real-reply');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  s.state.activeWork = false;
  s.state.tasks = [];
  s.emit(event('session.background_tasks_changed', {}));
  await nextTurn();
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  s.state.mcp.host!.pendingConnections = [];
  s.emit(event('session.mcp_server_status_changed', { serverName: 'native-connect', status: 'connected' }));
  s.emit(event('session.compaction_complete', { success: true }));
  await nextTurn();
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
});

for (const signal of ['session.error', 'abort'] as const) {
  test(`auto naming does not consume eligibility on first ${signal} or retry a failed query`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.userNamed = false;
    s.state.activeWork = true;
    s.emit(event('assistant.turn_start', { turnId: 'failed-turn' }));
    s.emit(assistant('partial-message', 'partial-reply', 'Partial reply before failure'));
    s.emit(signal === 'abort' ? event('abort', { reason: 'user_initiated' }) : event('session.error', { errorType: 'test', message: 'Turn failed' }));
    s.state.activeWork = false;
    s.emit(event('session.idle', {}));
    await nextTurn();
    assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
    s.rpc.ui.ephemeralQuery.mock.mockImplementationOnce(async () => { throw new Error('Auxiliary model failed'); });
    const logged: string[] = [];
    h.engine.log = message => logged.push(message);
    await finishReply(s, 'Actual successful reply');
    assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
    const meta = (await h.engine.getMeta(s.id))!;
    assert.equal(meta.status, 'idle');
    assert.equal(meta.error, undefined);
    assert.equal(meta.autoNaming, false);
    assert.equal(meta.autoNameError, undefined);
    assert.ok(h.events.some(event => event.type === 'session/patch' && event.autoNameError === 'Auxiliary model failed'));
    assert.equal(meta.attention, 'ready');
    assert.equal(s.rpc.name.setAuto.mock.callCount(), 0);
    assert.ok(logged.includes('automatic session naming failed'));
    await finishReply(s, 'Next reply is not a retry');
    assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
  });
}

test('native manual naming wins both preflight and a race during a coalesced query', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.rename(s.id, '用户指定名称');
  s.emit(user('context-user'));
  assert.deepEqual(await h.engine.autoName(s.id), { ok: true, applied: false, title: '用户指定名称', reason: 'user-named' });
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  s.state.userNamed = false;
  const query = deferred<{ answer: string }>();
  s.rpc.ui.ephemeralQuery.mock.mockImplementationOnce(() => query.promise);
  const one = h.engine.autoName(s.id), two = h.engine.autoName(s.id);
  await nextTurn();
  await h.engine.rename(s.id, '用户最终名称');
  query.resolve({ answer: 'Generated title' });
  assert.deepEqual(await one, { ok: true, applied: false, title: '用户最终名称', reason: 'user-named' });
  assert.deepEqual(await two, await one);
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 1);
  assert.equal(s.state.name, '用户最终名称');
});

test('manual naming rejects missing empty sessions and busy work without recreating or queueing', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  h.runtime.expire(id, true);
  h.runtime.resumeSession.mock.mockImplementationOnce(async () => { throw new Error('native session missing'); });
  await assert.rejects(h.engine.autoName(id), /native session missing/);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  const s = await h.load();
  s.state.userNamed = false;
  s.emit(user('manual-user'));
  s.state.activeWork = true;
  await assert.rejects(h.engine.autoName(s.id), { statusCode: 409, code: 'SESSION_BUSY' });
  s.state.activeWork = false;
  s.emit(event('session.idle', {}));
  await nextTurn();
  const ask = Promise.resolve(h.configs.get(s.id)!.onUserInputRequest!({ question: 'Choose?' }, { sessionId: s.id }));
  await assert.rejects(h.engine.autoName(s.id), { statusCode: 409, code: 'SESSION_BUSY' });
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  await h.engine.respondAsk(s.id, (await h.engine.getMeta(s.id))!.ask!.requestId, 'Answer', true);
  await ask;
  assert.equal(s.sdk.send.mock.callCount(), 0);
  const closing = deferred();
  h.runtime.closeSession.mock.mockImplementationOnce(async sdk => {
    await closing.promise;
    h.attached.delete(sdk.sessionId);
    s.listeners.clear();
  });
  const unloaded = h.engine.unload(s.id);
  await nextTurn();
  await assert.rejects(h.engine.autoName(s.id), { statusCode: 409, code: 'SESSION_BUSY' });
  closing.resolve();
  await unloaded;
});

for (const answer of ['', 'x'.repeat(101), '🧪'.repeat(33), 'bad\nname']) {
  test(`invalid generated title (${JSON.stringify(answer.slice(0, 12))}) leaves native title unchanged`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.userNamed = false;
    s.state.name = 'Previous native title';
    s.emit(user('validation-user'));
    s.rpc.ui.ephemeralQuery.mock.mockImplementationOnce(async () => ({ answer }));
    await assert.rejects(h.engine.autoName(s.id), { code: 'AUTO_NAME_INVALID_TITLE' });
    assert.equal(s.rpc.name.setAuto.mock.callCount(), 0);
    assert.equal(s.state.name, 'Previous native title');
    assert.equal((await h.engine.getMeta(s.id))?.error, undefined);
    assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  });
}

test('native automatic naming confirms readback, and reports nonapplication rather than fabricated success', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.userNamed = false;
  s.emit(user('readback-user'));
  s.rpc.name.setAuto.mock.mockImplementationOnce(async () => ({ applied: false }));
  assert.deepEqual(await h.engine.autoName(s.id), { ok: true, applied: false, title: null, reason: 'not-applied' });
  s.rpc.name.setAuto.mock.mockImplementationOnce(async () => ({ applied: true }));
  await assert.rejects(h.engine.autoName(s.id), { code: 'AUTO_NAME_NOT_CONFIRMED' });
  assert.equal((await h.engine.getMeta(s.id))?.title, 'indexed title');
});

test('native closure releases naming protection and a late auxiliary response cannot mutate a closed session', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.userNamed = false;
  s.emit(user('closed-query-user'));
  const query = deferred<{ answer: string }>();
  s.rpc.ui.ephemeralQuery.mock.mockImplementationOnce(() => query.promise);
  const naming = h.engine.autoName(s.id);
  const rejected = assert.rejects(naming, /Native session closed/);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.autoNaming, true);
  h.runtime.expire(s.id, true);
  await rejected;
  assert.equal((await h.engine.getMeta(s.id))?.autoNaming, undefined);
  assert.equal((await h.engine.getMeta(s.id))?.status, 'unloaded');
  await h.engine.unload(s.id);
  query.resolve({ answer: 'Late title' });
  await nextTurn();
  assert.equal(s.rpc.name.setAuto.mock.callCount(), 0);
});

test('a late naming preflight cannot overwrite the authoritative title of a resumed native handle', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.userNamed = false;
  s.emit(user('late-naming-preflight-user'));
  const workspace = deferred<Awaited<ReturnType<Rpc['workspaces']['getWorkspace']>>>();
  s.rpc.workspaces.getWorkspace.mock.mockImplementationOnce(() => workspace.promise);
  const naming = h.engine.autoName(s.id);
  const rejected = assert.rejects(naming, /Native session closed/);
  await nextTurn();
  assert.equal(s.rpc.workspaces.getWorkspace.mock.callCount(), 1);
  h.runtime.expire(s.id, true);
  await rejected;
  const replacement = fakeSession(t, s.id);
  replacement.state.name = 'Current manual title';
  replacement.state.userNamed = true;
  replacement.state.events = [...s.state.events];
  h.natives.set(s.id, replacement);
  await h.engine.reload(s.id);
  workspace.resolve({ workspace: { id: s.id, user_named: true, name: 'Obsolete manual title' } });
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.title, 'Current manual title');
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  assert.equal(replacement.rpc.ui.ephemeralQuery.mock.callCount(), 0);
});

test('startup restores unread replies without SDK sessions and drops only orphaned native choices', async t => {
  const h = harness(t, { prefs: {
    inbox: { revision: 80, counter: 42, sessions: {
      reply: { attention: 'ready', attnId: 41, seenId: 0, eventId: 'end-old' },
      choice: { attention: 'choice', attnId: 42, seenId: 42, eventId: 'old-request' },
    } },
  } });
  await h.seed('reply');
  await h.seed('choice');
  await h.engine.start();
  const snapshot = (await h.engine.snapshot());
  assert.equal(await h.engine.login(), '', 'BYOK does not need a made-up GitHub username');
  assert.equal(snapshot.inboxRevision, 81);
  assert.equal(snapshot.unreadCount, 1);
  assert.equal(unreadSessionCount(snapshot.sessions), 1);
  assert.equal((await h.engine.getMeta('reply'))?.attention, 'ready');
  assert.equal((await h.engine.getMeta('choice'))?.attention, null);
  assert.equal((await h.engine.getMeta('choice'))?.ask, null);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.events.some(event => event.type === 'session/notify'), false);
  await h.engine.reload('reply');
  assert.equal(h.engine.attentionCount(), 1, 'loading does not consume an unread reply');
  await h.engine.stop();
  assert.equal(h.prefs().inbox?.sessions.reply?.attention, 'ready', 'controlled stop keeps unread and native history');
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
});

test('reply notifications use final content or attachment names, once per native turn end, with committed counts', async t => {
  const h = harness(t);
  const s = await h.load();
  h.events.length = 0;
  const off = h.engine.onEvent(event => {
    if (event.type !== 'session/notify') return;
    const inbox = h.prefs().inbox!;
    assert.equal(event.inboxRevision, inbox.revision);
    assert.equal(event.attnId, inbox.sessions[s.id]?.attnId);
    assert.equal(event.unreadCount, unreadSessionCount(Object.values(inbox.sessions)));
    assert.equal(event.unreadCount, h.engine.attentionCount());
  });
  t.after(off);
  s.emit(event('assistant.turn_start', { turnId: 'turn' }));
  s.emit(event('assistant.message_delta', { messageId: 'final', deltaContent: 'fragment' }));
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal(h.engine.attentionCount(), 0, 'idle and streaming fragments alone are not a reply signal');
  s.emit(assistant('final-event', 'final', '## 已完成 **构建**\n[报告](https://example.invalid/?token=hidden)'));
  assert.equal(h.events.some(event => event.type === 'session/notify'), false);
  const end = event('assistant.turn_end', { turnId: 'turn' }, 'native-turn-end');
  s.emit(end);
  s.emit(end);
  s.emit(event('session.idle', {}));
  await nextTurn();
  let notifications = h.events.filter(event => event.type === 'session/notify');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.body, '已完成 构建 报告');
  assert.equal(h.events.some(event => event.type === 'snapshot'), false);
  h.engine.markSeen(s.id);
  await finishReply(s, '<cockpit-attachment kind="file" name="report.txt" url="/uploads/report.txt"/>', 'attachment');
  notifications = h.events.filter(event => event.type === 'session/notify');
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1]?.body, '附件：report.txt');
  assert.equal(h.engine.attentionCount(), 1);
  await finishReply(s, '**password**: demo-private-value {"password":"json-private-value"} 密钥：another-private-value', 'redaction');
  const redacted = h.events.filter(event => event.type === 'session/notify').at(-1)!;
  assert.doesNotMatch(redacted.body, /private-value/);
  assert.match(redacted.body, /已隐藏/);
  assert.ok((await chat(h, s.id, { source: 'live' })).events.some(event =>
    typeof event.data.content === 'string' && event.data.content.includes('demo-private-value')),
  'notification redaction must not alter native conversation content');
  assert.equal(serverChatEvents(h).length, 0);
  await h.engine.unload(s.id);
  assert.equal(h.engine.attentionCount(), 1);
});

test('late seen waterlines cannot consume newer replies and IDs advance across restart without replay notifications', async t => {
  const h = harness(t);
  const s = await h.load();
  await finishReply(s, '第一条回复', 'first');
  const first = (await h.engine.getMeta(s.id))!.attnId!;
  h.engine.markSeen(s.id, first);
  assert.equal(h.engine.attentionCount(), 0);
  const end = await finishReply(s, '第二条回复', 'second');
  const second = (await h.engine.getMeta(s.id))!.attnId!;
  const revision = (await h.engine.snapshot()).inboxRevision!;
  assert.ok(second > first);
  h.engine.markSeen(s.id, first);
  assert.equal((await h.engine.getMeta(s.id))?.attention, 'ready');
  assert.equal((await h.engine.snapshot()).inboxRevision, revision);
  s.emit(end);
  await nextTurn();
  assert.equal((await h.engine.snapshot()).inboxRevision, revision);
  await h.engine.stop();
  const restored = new Engine({ runtime: h.runtime as unknown as EngineRuntime, prefsFile: h.prefsFile });
  const events: ServerEvent[] = [];
  restored.onEvent(event => events.push(event));
  const resumes = h.runtime.resumeSession.mock.callCount();
  await restored.start();
  assert.equal((await restored.snapshot()).inboxRevision, revision);
  assert.equal(restored.attentionCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(events.some(event => event.type === 'session/notify'), false);
  restored.markSeen(s.id, first);
  assert.equal(restored.attentionCount(), 1);
  restored.markSeen(s.id, second);
  await restored.reload(s.id);
  s.emit(end);
  await nextTurn();
  assert.equal(restored.attentionCount(), 0, 'persisted/replayed native event cannot become unread again');
  await finishReply(s, '第三条回复', 'third');
  assert.ok((await restored.getMeta(s.id))!.attnId! > second);
  assert.ok((await restored.snapshot()).inboxRevision! > revision);
  await restored.stop();
});

test('inbox IO failures remain explicit and uncommitted, do not escape SDK callbacks, and retry before close', async t => {
  const h = harness(t);
  const s = await h.load();
  const initial = (await h.engine.snapshot());
  const bytes = readFileSync(h.prefsFile, 'utf8');
  mkdirSync(`${h.prefsFile}.tmp`);
  await finishReply(s, '已完成检查', 'io-failure');
  assert.equal((await h.engine.snapshot()).unreadCount, initial.unreadCount);
  assert.equal((await h.engine.snapshot()).inboxRevision, initial.inboxRevision);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), bytes);
  visibleError(h, s.id, /Inbox save failed.*not committed/);
  assert.equal(h.events.some(event => event.type === 'session/notify'), false);
  await assert.rejects(h.engine.unload(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0, 'uncommitted final reply must not be discarded by teardown');
  rmSync(`${h.prefsFile}.tmp`, { recursive: true });
  s.emit(event('session.idle', {}));
  await nextTurn();
  assert.equal(h.engine.attentionCount(), 1);
  assert.equal(h.events.filter(event => event.type === 'session/notify').length, 1);
  const committed = (await h.engine.snapshot());
  mkdirSync(`${h.prefsFile}.tmp`);
  assert.throws(() => h.engine.markSeen(s.id), { code: 'EISDIR' });
  assert.equal((await h.engine.snapshot()).inboxRevision, committed.inboxRevision);
  assert.equal(h.engine.attentionCount(), 1);
  rmSync(`${h.prefsFile}.tmp`, { recursive: true });
  h.engine.markSeen(s.id);
  assert.equal(h.engine.attentionCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.error, undefined);
});

test('seen choices remain actionable but not unread; the next real pending callback gets a new attention ID', async t => {
  const h = harness(t);
  const s = await h.load();
  const config = h.configs.get(s.id)!;
  const first = config.onUserInputRequest!({ question: '**请选择**下一步' }, { sessionId: s.id });
  const second = config.onUserInputRequest!({ question: '确认继续？' }, { sessionId: s.id });
  const request = (await h.engine.getMeta(s.id))!.ask!.requestId;
  const firstId = (await h.engine.getMeta(s.id))!.attnId!;
  h.engine.markSeen(s.id, firstId);
  assert.equal(h.engine.attentionCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.attention, 'choice');
  assert.equal((await h.engine.getMeta(s.id))?.ask?.requestId, request);
  await assert.rejects(h.engine.reloadSessionMcp(s.id), protectedWork);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  await h.engine.respondAsk(s.id, request, '原样回答', true);
  assert.deepEqual(await first, { answer: '原样回答', wasFreeform: true });
  assert.equal(h.engine.attentionCount(), 1);
  assert.ok((await h.engine.getMeta(s.id))!.attnId! > firstId);
  const notifications = h.events.filter(event => event.type === 'session/notify');
  assert.deepEqual(notifications.map(event => event.body), ['请选择下一步', '确认继续？']);
  await h.engine.respondAsk(s.id, (await h.engine.getMeta(s.id))!.ask!.requestId, '继续', true);
  await second;
  assert.equal(h.engine.attentionCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.attention, null);
});

for (const loaded of [false, true]) {
  test(`confirmed native deletion ignores retired schedule counts and ${loaded ? 'checks and closes live work' : 'does not load paused schedules'}`, async t => {
    const h = harness(t, { prefs: { scheduledSessions: { 'legacy-scheduled': 999 } } });
    const s = await h.seed('legacy-scheduled');
    s.state.schedules = [schedule(78)];
    if (loaded) await h.engine.reload(s.id);
    const reads = s.rpc.schedule.list.mock.callCount();
    const resumes = h.runtime.resumeSession.mock.callCount();
    if (loaded) {
      s.state.activeWork = true;
      await assert.rejects(h.engine.deleteSession(s.id, true), protectedWork);
      assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
      s.state.activeWork = false;
    }
    await h.engine.deleteSession(s.id, true);
    assert.equal((await h.engine.getMeta(s.id)), null);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), loaded ? 1 : 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
    assert.equal(s.rpc.schedule.list.mock.callCount(), reads, 'teardown checks work, not future timers');
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
    assert.equal(s.sdk.abort.mock.callCount(), 0);
    assert.equal(h.prefs().scheduledSessions, undefined);
  });
}

test('native deletion honors confirmation and idle guards, and cleans preferences only after native acknowledgement', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.pin(s.id, true);
  await finishReply(s, '可删除的测试回复', 'purge');
  for (const name of ['session/delete', 'session/purge'] as const) {
    assert.equal(Intents[name].body.safeParse({ sessionId: s.id }).success, false);
    assert.equal(Intents[name].body.safeParse({ sessionId: s.id, confirm: true }).success, true);
  }
  await assert.rejects(h.engine.deleteSession(s.id), /confirm:true/);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.state.processing = true;
  await assert.rejects(h.engine.deleteSession(s.id, true), protectedWork);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.state.processing = false;
  await finishReply(s, '工作完成，可以删除', 'purge-after-work');
  const counter = h.prefs().inbox!.counter;
  h.runtime.closeSession.mock.mockImplementationOnce(async () => { throw new Error('close failed'); });
  await assert.rejects(h.engine.deleteSession(s.id, true), /close failed/);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  h.runtime.deleteSession.mock.mockImplementationOnce(async () => { throw new Error('native delete failed'); });
  await assert.rejects(h.engine.deleteSession(s.id, true), /native delete failed/);
  assert.equal(h.prefs().pinnedSessions?.includes(s.id), true);
  assert.equal(h.engine.attentionCount(), 1);
  mkdirSync(`${h.prefsFile}.tmp`);
  await assert.rejects(h.engine.deleteSession(s.id, true), /Native history deleted; preferences cleanup failed/);
  assert.equal(h.prefs().pinnedSessions?.includes(s.id), true);
  assert.equal(await h.engine.getMeta(s.id), null, 'preferences cannot fabricate deleted native metadata');
  assert.equal(activeState(h, s.id), undefined, 'cleanup retry does not retain an unloaded native replica');
  rmSync(`${h.prefsFile}.tmp`, { recursive: true });
  await h.engine.deleteSession(s.id, true);
  assert.equal((await h.engine.getMeta(s.id)), null);
  assert.equal(h.prefs().pinnedSessions?.includes(s.id), false);
  assert.equal(h.prefs().inbox?.sessions[s.id], undefined);
  assert.equal(h.prefs().inbox?.counter, counter);
  assert.equal(h.engine.attentionCount(), 0);
  assert.ok(h.trace.indexOf(`close:${s.id}`) < h.trace.indexOf(`delete:${s.id}`));
  const removed = h.events.findLast(event => event.type === 'session/removed');
  assert.deepEqual(removed, { type: 'session/removed', sessionId: s.id,
    inboxRevision: (await h.engine.snapshot()).inboxRevision, unreadCount: 0 });
  const deleting = await h.load();
  await h.engine.unload(deleting.id);
  const deletion = deferred();
  h.runtime.deleteSession.mock.mockImplementationOnce(() => deletion.promise);
  const purging = h.engine.deleteSession(deleting.id, true);
  await nextTurn();
  await assert.rejects(h.engine.stop(), protectedWork);
  deletion.resolve();
  await purging;
});

test('global MCP refresh invalidates only native definitions and never disrupts loaded sessions', async t => {
  const config = { fixture: { command: 'never-executed', args: ['old'] } };
  const h = harness(t, { mcpServers: config, prefs: { mcpDefaultOn: ['fixture'] } });
  const first = await h.load();
  const second = await h.load();
  for (const s of [first, second]) s.state.mcp = mcpState([{ name: 'fixture', status: 'connected' }]);
  second.state.processing = true;
  const resumes = h.runtime.resumeSession.mock.callCount();
  await h.engine.refreshMcp();
  assert.equal(h.runtime.rpc.mcp.config.reload.mock.callCount(), 1);
  assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 1);
  assert.equal(h.runtime.rpc.mcp.discover.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(first.rpc.mcp.reload.mock.callCount(), 0);
  assert.equal(second.rpc.mcp.reload.mock.callCount(), 0);
  h.runtime.rpc.mcp.config.reload.mock.mockImplementationOnce(async () => { throw new Error('native cache reload failed'); });
  await assert.rejects(h.engine.refreshMcp(), /native cache reload failed/);
  assert.equal(h.prefs().mcpDefaultOn, undefined, 'retired defaults cannot override the native configuration');
});

test('session MCP reload uses the guarded native connection operation without close or resume', async t => {
  const h = harness(t);
  const first = await h.load();
  first.state.mcp = mcpState([{ name: 'fixture', status: 'connected', source: 'workspace' }]);
  const resumes = h.runtime.resumeSession.mock.callCount();
  const reload = await h.engine.reloadSessionMcp(first.id);
  assert.equal(reload.reconnected, 1);
  assert.equal(first.rpc.mcp.reload.mock.callCount(), 1);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(h.runtime.rpc.mcp.config.reload.mock.callCount(), 1);
  first.state.processing = true;
  await assert.rejects(h.engine.reloadSessionMcp(first.id), protectedWork);
  assert.equal(first.rpc.mcp.reload.mock.callCount(), 1);
  first.state.processing = false;
  const pending = deferred();
  first.rpc.mcp.reload.mock.mockImplementationOnce(() => pending.promise);
  const changing = h.engine.reloadSessionMcp(first.id);
  await nextTurn();
  await assert.rejects(h.engine.prompt(first.id, 'do not send'), protectedWork);
  await assert.rejects(h.engine.unload(first.id), protectedWork);
  await assert.rejects(h.engine.toggleSessionMcp(first.id, 'fixture', false), protectedWork);
  pending.resolve();
  assert.equal((await changing).reconnected, 1);
  first.state.mcp = mcpState([{ name: 'fixture', status: 'failed' }]);
  await assert.rejects(h.engine.reloadSessionMcp(first.id), /connections not confirmed: fixture/);
  assert.equal((await h.engine.getMeta(first.id))?.loaded, true);
  assert.equal((await h.engine.getMeta(first.id))?.activeMcpOperations, 0);
  await h.engine.unload(first.id);
  await assert.rejects(h.engine.reloadSessionMcp(first.id), unavailableSession);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
});

test('session MCP reload rejects native cache failures before reconnecting or closing anything', async t => {
  const h = harness(t);
  const s = await h.load();
  const resumes = h.runtime.resumeSession.mock.callCount();
  h.runtime.rpc.mcp.config.reload.mock.mockImplementationOnce(async () => { throw new Error('native definition cache unavailable'); });
  await assert.rejects(h.engine.reloadSessionMcp(s.id), /native definition cache unavailable/);
  assert.equal(s.rpc.mcp.reload.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations ?? 0, 0);
  assert.equal((await h.engine.getMeta(s.id))?.closing, false);
});

test('session MCP reload readback accepts native reset to global choices without restoring session overrides', async t => {
  const h = harness(t, { mcpServers: { fixture: { command: 'native-fixture' } } });
  const s = await h.load();
  s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
  const prefs = readFileSync(h.prefsFile, 'utf8');
  const resumes = h.runtime.resumeSession.mock.callCount();
  s.rpc.mcp.reload.mock.mockImplementation(async () => {
    const enabled = h.discoveredMcp[0]!.enabled;
    s.state.mcp = mcpState([{ name: 'fixture', status: enabled ? 'connected' : 'disabled' }], enabled ? [] : ['fixture']);
  });
  assert.equal((await h.engine.listSessionMcp(s.id)).servers[0]!.enabled, false);
  assert.deepEqual(await h.engine.reloadSessionMcp(s.id), { reconnected: 1 });
  assert.equal((await h.engine.listSessionMcp(s.id)).servers[0]!.enabled, true);
  h.discoveredMcp[0]!.enabled = false;
  assert.deepEqual(await h.engine.reloadSessionMcp(s.id), { reconnected: 0 });
  assert.equal((await h.engine.listSessionMcp(s.id)).servers[0]!.enabled, false);
  assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.config.reload.mock.callCount(), 2);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), prefs);
});

test('plan feedback resolves the exact native callback without mode changes or another prompt; simple elicitation can accept', async t => {
  const h = harness(t);
  const s = await h.load();
  const config = h.configs.get(s.id)!;
  const plan = config.onExitPlanModeRequest!({
    summary: '## 请确认计划', actions: ['interactive'], recommendedAction: 'interactive',
  }, { sessionId: s.id });
  const requestId = (await h.engine.getMeta(s.id))!.planRequest!.requestId;
  const feedback = '  请保留我的输入\n先修改测试，再执行。  ';
  await h.engine.planSupersede(s.id, requestId, feedback);
  assert.deepEqual(await plan, { approved: false, feedback });
  assert.equal((await h.engine.getMeta(s.id))?.planRequest, null);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal(s.rpc.mode.set.mock.callCount(), 0);
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 0);
  assert.equal(s.sdk.abort.mock.callCount(), 0);
  const elicitation = config.onElicitationRequest!({ sessionId: s.id, message: '请确认' });
  const id = (await h.engine.getMeta(s.id))!.elicitation!.requestId;
  assert.deepEqual((await h.engine.getMeta(s.id))!.elicitation, { requestId: id, message: '请确认', actions: ['accept', 'decline', 'cancel'] });
  await h.engine.respondElicitation(s.id, id, 'accept');
  assert.deepEqual(await elicitation, { action: 'accept' });
  assert.equal(coreCapabilities.planSupersede, 'pending-plan-feedback');
  assert.equal(coreCapabilities.elicitationAccept, 'unstructured-only');
  assert.equal(coreCapabilities.schedule.cron, false);
});

test('loaded sessions publish their native provider-qualified model inventory', async t => {
  const h = harness(t);
  const s = await h.seed();
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'local/native-model', name: 'Local model', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high', billing: { token_prices: { long_context: {} } },
  }] }));
  await h.engine.reload(s.id);
  assert.deepEqual((await h.engine.getMeta(s.id))?.availableModels, [{
    modelId: 'local/native-model', name: 'Local model', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high', supportsLongContext: true,
  }]);
});

test('concurrent identical schedule prompts retain distinct native timing and IDs', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.commands.invoke.mock.mockImplementation(async ({ input }) => {
    await nextTurn();
    const seconds = Number(input!.split('s ')[0]);
    s.state.schedules.push({ ...schedule(s.state.schedules.length + 1), intervalMs: seconds * 1000 });
    return { kind: 'completed' };
  });

  test('structured native model and mode refusals are not converted into successful acknowledgements', async t => {
    const h = harness(t);
    const s = await h.load();
    s.rpc.model.switchTo.mock.mockImplementation(async () => ({
      modelId: 'native-model', status: 'rejected', message: 'model is unavailable',
    }));
    await assert.rejects(h.engine.setModel(s.id, 'unavailable'), /model is unavailable/);
    assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'native-model');
    s.rpc.mode.set.mock.mockImplementation(async () => ({
      status: 'cancelled', modelChanged: false, deferImplementation: true,
    }));
    await assert.rejects(h.engine.setMode(s.id, 'plan'), /cancelled/);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
  const results = await Promise.all([
    h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m' }),
    h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1h' }),
  ]);
  assert.deepEqual(results.map(result => [result.entry?.id, result.entry?.intervalMs]), [[1, 60_000], [2, 3_600_000]]);
});
