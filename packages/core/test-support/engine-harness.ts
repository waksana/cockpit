// Shared fakes and fixtures for the Engine test suites.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { CopilotClient, CopilotSession, SessionConfig, SessionEvent, SessionMetadata } from '@github/copilot-sdk';
import type { ModelOption, ServerEvent } from '@cockpit/protocol';
import { INITIAL_SESSION_MODEL, NativeChatRead } from '@cockpit/protocol';
import type { SessionDefaultsStore } from '../src/session-defaults.ts';
import { Engine, type EngineRuntime } from '../src/engine.ts';
import { errorWithCode } from './errors.ts';

export type Rpc = CopilotSession['rpc'];
export type Queue = Awaited<ReturnType<Rpc['queue']['pendingItems']>>;
export type NativeTask = Awaited<ReturnType<Rpc['tasks']['list']>>['tasks'][number];
export type NativeSchedule = Awaited<ReturnType<Rpc['schedule']['list']>>['entries'][number];
export type RewindResult = Awaited<ReturnType<Rpc['history']['rewind']>>;
export type McpState = Awaited<ReturnType<Rpc['mcp']['list']>>;
export type Skill = Awaited<ReturnType<Rpc['skills']['list']>>['skills'][number];
export type DiscoverSkills = CopilotClient['rpc']['skills']['discover'];
export type ServerSkill = Awaited<ReturnType<DiscoverSkills>>['skills'][number];
export type GlobalMcp = CopilotClient['rpc']['mcp'];
export type McpDefinitions = Awaited<ReturnType<GlobalMcp['config']['list']>>['servers'];
export type DiscoveredMcp = Awaited<ReturnType<GlobalMcp['discover']>>['servers'][number];
export type UserSettings = Awaited<ReturnType<CopilotClient['rpc']['user']['settings']['get']>>;
export type PersistedRead = CopilotClient['rpc']['sessions']['readPersistedEvents'];
export type Mode = Parameters<Rpc['mode']['set']>[0]['mode'];
export type PortRpc = { [K in keyof Rpc]?: Partial<Rpc[K]> };
export const timestamp = '2026-09-07T12:00:00.000Z';
export const protectedWork = errorWithCode('SESSION_BUSY', 'SESSION_TRANSITION');
export const unavailableSession = /unloaded|unavailable|not loaded|not live|expired|closed/i;

export function assertSameControlFacts(actual: unknown, expected: unknown, message?: string) {
  const facts = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === 'sampledAt' ? 0 : item));
  assert.deepEqual(facts(actual), facts(expected), message);
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function event<T extends SessionEvent['type']>(
  type: T, data: Extract<SessionEvent, { type: T }>['data'], id: string = randomUUID(),
): Extract<SessionEvent, { type: T }> {
  return { type, data, id, timestamp, parentId: null } as Extract<SessionEvent, { type: T }>;
}

export const user = (id: string, content = 'native user message') => event('user.message', { content }, id);
export const assistant = (eventId: string, messageId: string, content = 'native answer') =>
  event('assistant.message', { messageId, content }, eventId);
export const schedule = (id = 7, recurring = true, prompt = 'check build'): NativeSchedule => ({
  id, recurring, prompt, intervalMs: 60_000, nextRunAt: '2026-09-07T12:01:00.000Z',
});
export const task = (status: Extract<NativeTask, { type: 'agent' }>['status'] = 'running'): NativeTask => ({
  type: 'agent', id: 'task-registry-id', toolCallId: 'spawn-tool-call',
  description: 'background inspection', agentType: 'explore', prompt: 'inspect fixture',
  status, startedAt: timestamp,
});
export const queued = (id: string, displayText: string): Queue['items'][number] => ({
  id, messageId: `accepted-${id}`, kind: 'message', agentMode: 'interactive', displayText,
});
export function mcpState(servers: McpState['servers'] = [], disabledServers: string[] = []): McpState {
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

export function fakeSession(t: TestContext, sessionId: string) {
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
      switchTo: t.mock.fn(async (options: Parameters<Rpc['model']['switchTo']>[0]): Promise<Awaited<ReturnType<Rpc['model']['switchTo']>>> => {
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
    tools: {
      initializeAndValidate: t.mock.fn(async () => ({})),
      getCurrentMetadata: t.mock.fn(async (): Promise<Awaited<ReturnType<Rpc['tools']['getCurrentMetadata']>>> => ({ tools: [
        { name: 'read', description: '', mcpServerName: 'module_fixture__tools', mcpToolName: 'read' },
      ] })),
    },
    permissions: { pendingRequests: t.mock.fn(async () => ({ items: [] })) },
    mcp: {
      list: t.mock.fn(async () => structuredClone(state.mcp)),
      enable: t.mock.fn(async (_options: Parameters<Rpc['mcp']['enable']>[0]) => {}),
      disable: t.mock.fn(async (_options: Parameters<Rpc['mcp']['disable']>[0]) => {}),
      reload: t.mock.fn(async () => {}),
    },
    commands: {
      invoke: t.mock.fn(async (_options: Parameters<Rpc['commands']['invoke']>[0]): Promise<Awaited<ReturnType<Rpc['commands']['invoke']>>> => ({
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
    workspacePath: undefined as CopilotSession['workspacePath'],
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

export function harness(t: TestContext, options: {
  mcpServers?: McpDefinitions;
  prefs?: Record<string, unknown>;
  sessionDefaults?: SessionDefaultsStore;
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
    models: t.mock.fn(async (): Promise<ModelOption[]> => [{ modelId: INITIAL_SESSION_MODEL, name: 'GPT-6 Astra' }]),
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
      native.state.model.modelId = config.model ?? native.state.model.modelId;
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
  const engine = new Engine({ runtime: runtime as unknown as EngineRuntime, sessionDefaults: options.sessionDefaults });
  const off = engine.onEvent(value => events.push(structuredClone(value)));
  t.after(async () => {
    await nextTurn();
    off();
    rmSync(relativeRoot, { recursive: true, force: true });
  });
  return {
    engine, runtime, events, natives, attached, configs, rows, journals, trace, cwd, prefsFile, discoveredSkills, discoveredMcp, mcpDefinitions, userSettings,
    prefs: () => JSON.parse(readFileSync(prefsFile, 'utf8')) as Record<string, unknown> & {
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
export type Harness = ReturnType<typeof harness>;

export function activeState(h: Harness, id: string) {
  return (h.engine as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions.get(id)!;
}

export function nativeCalls(s: ReturnType<typeof fakeSession>): Record<string, number> {
  return {
    getEvents: s.sdk.getEvents.mock.callCount(),
    send: s.sdk.send.mock.callCount(),
    abort: s.sdk.abort.mock.callCount(),
    ...Object.fromEntries(Object.entries(s.rpc).flatMap(([group, methods]) =>
      Object.entries(methods).map(([name, method]) => [`${group}.${name}`, method.mock.callCount()]))),
  };
}

export function nativeCallDelta(s: ReturnType<typeof fakeSession>, before: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(nativeCalls(s))
    .map(([name, count]) => [name, count - (before[name] ?? 0)] as const).filter(([, count]) => count));
}

export async function promptly<T>(promise: Promise<T>): Promise<T> {
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

export function visibleError(h: Harness, id: string, pattern: RegExp) {
  assert.ok(h.events.some(event => event.type === 'session/patch' && event.sessionId === id
    && typeof event.error === 'string' && pattern.test(event.error)), 'operation failure must be emitted, not cached');
}

export function serverChatEvents(h: Harness) {
  return h.events.filter(event => ['msg/upsert', 'session/reset', 'session/history-page'].includes(event.type));
}

export function chat(h: Harness, sessionId: string, query: Partial<NativeChatRead> = {}) {
  return h.engine.chat(NativeChatRead.parse({ sessionId, ...query }));
}

export function connectionEvent(state: 'disconnected' | 'reconnecting' | 'connected'): SessionEvent {
  // The native event name is not included in this SDK's generated SessionEvent union.
  return { type: 'session.connection_state_changed', data: { state },
    id: randomUUID(), timestamp, parentId: null } as unknown as SessionEvent;
}

export async function finishReply(s: Awaited<ReturnType<Harness['load']>>, content: string, id: string = randomUUID()) {
  s.emit(event('assistant.turn_start', { turnId: id }));
  s.emit(assistant(`message-${id}`, `reply-${id}`, content));
  const end = event('assistant.turn_end', { turnId: id }, `end-${id}`);
  s.emit(end);
  await nextTurn();
  return end;
}
