import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import type { CopilotClient, CopilotSession, SessionConfig, SessionEvent, SessionMetadata } from '@github/copilot-sdk';
import type { ExitPlanModeAction, ModelOption, ServerEvent } from '@cockpit/protocol';
import { Intents, NativeChatRead, unreadSessionCount } from '@cockpit/protocol';
import { Engine, coreCapabilities, type EngineRuntime } from './engine.ts';
import { sessionMetaBusy } from '../test-support/lifecycle.ts';
import { CHAT_EVENT_TYPES } from './native-chat.ts';
import { validateForkHistory } from './fork.ts';
import type { RoleProvider } from './roles.ts';

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
      getCurrentMetadata: t.mock.fn(async () => ({ tools: [
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

function harness(t: TestContext, options: {
  mcpServers?: McpDefinitions;
  prefs?: Record<string, unknown>;
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
  const engine = new Engine({ runtime: runtime as unknown as EngineRuntime });
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
type Harness = ReturnType<typeof harness>;

async function roleAdditionFixture(t: TestContext) {
  const h = harness(t);
  const catalog = ['executor', 'owner'].map(roleId => ({
    moduleId: 'fixture', moduleName: 'Fixture', roleId, name: roleId,
  }));
  const saved = new Map<string, typeof catalog>();
  const provider: RoleProvider = {
    list: () => catalog, read: id => saved.get(id) ?? [],
    save: (id, roles) => { saved.set(id, roles); },
    assemble: async (id, choices) => {
      const roles = catalog.filter(role => choices.some(choice => choice.moduleId === role.moduleId && choice.roleId === role.roleId));
      if (roles.length !== choices.length) throw new Error('Unknown role selection');
      return { roles, fingerprint: roles.map(role => role.roleId).join('+'), skills: [],
        config: { systemMessage: { mode: 'append' as const, content: `Roles for ${id}: ${roles.map(role => role.roleId).join(',')}` } } };
    },
  };
  h.engine.setRoleProvider(provider);
  const id = await h.engine.newSession(h.cwd);
  const native = h.natives.get(id)!;
  native.state.events.push(user('synthetic-history'));
  return { ...h, id, native, catalog, saved, provider };
}

test('role addition only saves metadata; explicit reload applies the union to the same session', async t => {
  const h = await roleAdditionFixture(t);
  const before = structuredClone(h.native.state.events);
  const config = h.configs.get(h.id);
  const assemble = t.mock.method(h.provider, 'assemble');
  const first = await h.engine.addRoles(h.id, [h.catalog[0]!]);
  assert.equal(first.status, 'saved', JSON.stringify(first));
  assert.equal(first.rolesNeedReload, true);
  assert.deepEqual(first.appliedRoles, []);
  const second = await h.engine.addRoles(h.id, [h.catalog[1]!, h.catalog[1]!]);
  assert.equal(second.status, 'saved');
  assert.deepEqual(second.roles, h.catalog);
  assert.equal(assemble.mock.callCount(), 0, 'composition is deferred to normal loading');
  assert.equal(h.configs.get(h.id), config);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.native.sdk.send.mock.callCount(), 0);
  assert.equal(h.native.sdk.abort.mock.callCount(), 0);
  assert.deepEqual(h.native.state.events, before);
  assert.equal((await h.engine.getMeta(h.id))?.cwd, h.cwd);
  for (const meta of [(await h.engine.getMeta(h.id))!, (await h.engine.listLive())[0]!]) {
    assert.deepEqual(meta.roles, h.catalog);
    assert.deepEqual(meta.appliedRoles, []);
    assert.equal(meta.rolesNeedReload, true);
  }
  const duplicate = await h.engine.addRoles(h.id, h.catalog);
  assert.equal(duplicate.status, 'unchanged');
  assert.equal(duplicate.rolesNeedReload, true);
  assert.equal((await h.engine.roleReadiness(h.id)).ready, false);
  await h.engine.reload(h.id);
  const applied = (await h.engine.getMeta(h.id))!;
  assert.equal(applied.sessionId, h.id);
  assert.deepEqual(applied.appliedRoles, h.catalog);
  assert.equal(applied.rolesNeedReload, false);
  assert.equal((await h.engine.roleReadiness(h.id)).ready, true);
  assert.equal(h.runtime.closeSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.deepEqual(h.native.state.events, before);
  await h.engine.unload(h.id);
  const unloaded = await h.engine.addRoles(h.id, h.catalog);
  assert.equal(unloaded.status, 'unchanged');
  assert.equal(unloaded.loaded, false);
  assert.equal(unloaded.rolesNeedReload, false);
  assert.deepEqual(unloaded.appliedRoles, []);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1, 'saving does not load');
  await h.engine.load(h.id);
  assert.deepEqual((await h.engine.getMeta(h.id))?.appliedRoles, h.catalog);
});

for (const activity of ['main', 'subagent', 'shell', 'queue', 'steering', 'mcp', 'ask', 'plan', 'schedule'] as const) {
  test(`role addition saves during ${activity} without touching native work`, async t => {
    const h = await roleAdditionFixture(t);
    let answer: Promise<unknown> | undefined;
    switch (activity) {
      case 'main': h.native.state.processing = true; break;
      case 'subagent': h.native.state.tasks = [task()]; break;
      case 'shell': h.native.state.activeWork = true; break;
      case 'queue': h.native.state.queue.items = [queued('pending', 'synthetic queued work')]; break;
      case 'steering': h.native.state.queue.inFlightSteeringCount = 1; break;
      case 'mcp': h.native.state.mcp.host!.pendingConnections = ['fixture']; break;
      case 'ask': answer = Promise.resolve(h.configs.get(h.id)!.onUserInputRequest!({ question: 'synthetic question', choices: ['yes'], allowFreeform: true }, { sessionId: h.id })); break;
      case 'plan': answer = Promise.resolve(h.configs.get(h.id)!.onExitPlanModeRequest!({ summary: 'synthetic plan', actions: ['interactive'], recommendedAction: 'interactive' }, { sessionId: h.id })); break;
      case 'schedule': h.native.state.schedules = [schedule()]; break;
    }
    const before = structuredClone(h.native.state);
    const result = await h.engine.addRoles(h.id, [h.catalog[1]!]);
    assert.equal(result.status, 'saved');
    assert.equal(result.rolesNeedReload, true);
    assert.deepEqual(h.saved.get(h.id), [h.catalog[1]]);
    assert.deepEqual(h.native.state, before);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.equal(h.native.sdk.abort.mock.callCount(), 0);
    assert.equal(h.native.sdk.send.mock.callCount(), 0);
    assert.equal(h.native.rpc.skills.list.mock.callCount(), 0);
    assert.equal(h.native.rpc.tools.getCurrentMetadata.mock.callCount(), 0);
    if (activity === 'ask') await h.engine.respondAsk(h.id, (await h.engine.getMeta(h.id))!.ask!.requestId, 'yes', false);
    if (activity === 'plan') await h.engine.respondPlan(h.id, (await h.engine.getMeta(h.id))!.planRequest!.requestId, 'interactive');
    await answer;
  });
}

test('role save accepts empty history and runtime-only resources without reconfiguring them', async t => {
  const h = await roleAdditionFixture(t);
  h.native.state.events = [];
  h.native.state.schedules = [schedule()];
  h.native.state.mcp = mcpState([{ name: 'ephemeral-only', status: 'stopped' }]);
  h.native.state.skills = [{ name: 'ephemeral-only', path: '/synthetic/unknown/SKILL.md', enabled: true } as Skill];
  const before = structuredClone(h.native.state);
  assert.equal((await h.engine.addRoles(h.id, [h.catalog[0]!])).status, 'saved');
  assert.deepEqual(h.native.state, before);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('role save validates catalog and total role limit, not deferred resource composition', async t => {
  const h = await roleAdditionFixture(t);
  await assert.rejects(h.engine.addRoles(h.id, []), /At least one/);
  await assert.rejects(h.engine.addRoles(h.id, [{ moduleId: 'missing', roleId: 'missing' }]), /Unknown module role/);
  assert.equal(h.saved.size, 0);
  const all = Array.from({ length: 65 }, (_, index) => ({ moduleId: 'fixture', moduleName: 'Fixture', roleId: `role-${index}`, name: `Role ${index}` }));
  t.mock.method(h.provider, 'list', () => all);
  assert.equal((await h.engine.addRoles(h.id, all.slice(0, 64))).status, 'saved');
  await assert.rejects(h.engine.addRoles(h.id, all.slice(64)), /at most 64/);
  assert.equal(h.saved.get(h.id)?.length, 64);
  t.mock.method(h.provider, 'assemble', async () => { throw new Error('synthetic unavailable role resource'); });
  await assert.rejects(h.engine.reload(h.id), /synthetic unavailable role resource/);
  assert.equal(h.saved.get(h.id)?.length, 64);
  assert.equal((await h.engine.getMeta(h.id))?.loaded, false);
});

for (const written of [false, true]) {
  test(`role persistence failure afterWrite=${written} returns uncertainty without native effects`, async t => {
    const h = await roleAdditionFixture(t);
    const save = t.mock.method(h.provider, 'save', (id, roles) => {
      if (written) h.saved.set(id, roles);
      throw new Error('synthetic write acknowledgement failure');
    });
    const result = await h.engine.addRoles(h.id, [h.catalog[0]!]);
    assert.equal(result.status, 'uncertain');
    assert.match(result.error!, /synthetic/);
    assert.match(result.recovery!, /No reload, rollback or retry/);
    assert.equal(save.mock.callCount(), 1);
    assert.equal(h.runtime.createSession.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    assert.deepEqual(result.roles, written ? [h.catalog[0]] : []);
    assert.deepEqual(result.appliedRoles, []);
    assert.equal(result.rolesNeedReload, written);
  });
}

test('role save never returns a success-shaped snapshot when persistence readback is unavailable', async t => {
  const h = await roleAdditionFixture(t);
  const read = h.provider.read;
  let written = false;
  t.mock.method(h.provider, 'save', (id, roles) => { h.saved.set(id, roles); written = true; });
  t.mock.method(h.provider, 'read', id => {
    if (written) throw new Error('synthetic unreadable persisted selection');
    return read(id);
  });
  await assert.rejects(h.engine.addRoles(h.id, [h.catalog[0]!]), /persistence outcome and saved selection are unconfirmed/);
  assert.deepEqual(h.saved.get(h.id), [h.catalog[0]]);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
});

test('role readiness observes a role saved while native capability reads are in flight', async t => {
  const h = await roleAdditionFixture(t);
  await h.engine.addRoles(h.id, [h.catalog[0]!]);
  await h.engine.reload(h.id);
  const held = deferred<{ skills: Skill[] }>();
  h.native.rpc.skills.list.mock.mockImplementationOnce(() => held.promise);
  const checking = h.engine.roleReadiness(h.id);
  await nextTurn();
  await h.engine.addRoles(h.id, [h.catalog[1]!]);
  held.resolve({ skills: [] });
  const result = await checking;
  assert.equal(result.ready, false);
  assert.equal(result.rolesNeedReload, true);
  assert.deepEqual(result.roles, h.catalog);
  assert.deepEqual(result.appliedRoles, [h.catalog[0]]);
});

test('concurrent role saves union without losing selections and do not reload an unloaded session', async t => {
  const h = await roleAdditionFixture(t);
  await h.engine.unload(h.id);
  const results = await Promise.all(h.catalog.map(role => h.engine.addRoles(h.id, [role])));
  assert.ok(results.every(result => result.status === 'saved' && !result.loaded && !result.rolesNeedReload));
  assert.deepEqual(h.saved.get(h.id), h.catalog);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  await h.engine.load(h.id);
  assert.deepEqual((await h.engine.getMeta(h.id))?.appliedRoles, h.catalog);
});

test('role save refuses an in-flight resume but does not reserve the running turn', async t => {
  const h = await roleAdditionFixture(t);
  const held = deferred<CopilotSession>();
  h.runtime.resumeSession.mock.mockImplementationOnce(() => held.promise);
  const reloading = h.engine.reload(h.id);
  await nextTurn();
  await assert.rejects(h.engine.addRoles(h.id, [h.catalog[0]!]), /loading|transition/i);
  assert.equal(h.saved.size, 0);
  h.runtime.isSessionLive.mock.mockImplementation(async () => true);
  held.resolve(h.native.sdk as unknown as CopilotSession);
  await reloading;
  h.native.state.processing = true;
  assert.equal((await h.engine.addRoles(h.id, [h.catalog[0]!])).status, 'saved');
  await assert.rejects(h.engine.reload(h.id), protectedWork);
  assert.equal((await h.engine.getMeta(h.id))?.rolesNeedReload, true);
});

test('role creation, identity, cold resume and readiness preserve native unrelated config', async t => {
  const h = harness(t);
  const role = { moduleId: 'fixture', roleId: 'executor', name: 'Executor', moduleName: 'Fixture' };
  const saved = new Map<string, typeof role[]>();
  let version = 1;
  const provider: RoleProvider = {
    list: () => [role], read: id => saved.get(id) ?? [], save: (id, roles) => { saved.set(id, roles); },
    assemble: async (id, roles) => ({
      roles: roles.map(() => role), fingerprint: `fixture-v${version}`,
      config: {
        systemMessage: { mode: 'append', content: `Module fixture/executor v${version}\nNative session ID: ${id}` },
        skillDirectories: ['/fixture/skills'],
        mcpServers: { module_fixture__tools: { type: 'http', url: 'http://127.0.0.1/mcp', tools: ['read'] } },
      }, skills: [{ name: 'executor', path: '/fixture/skills/executor/SKILL.md' }],
    }),
  };
  h.engine.setRoleProvider(provider);
  h.userSettings.settings.disabledSkills!.value = ['unrelated'];
  h.discoveredSkills.push({ name: 'executor', path: '/fixture/skills/executor/SKILL.md', description: '', source: 'custom' } as ServerSkill);
  const id = await h.engine.newSession(h.cwd, [role]);
  const config = h.configs.get(id)!;
  assert.deepEqual(config.disabledSkills, ['unrelated']);
  assert.match(JSON.stringify(config.systemMessage), new RegExp(id));
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 0);
  assert.deepEqual((await h.engine.getMeta(id))!.roles, [role]);
  const native = h.natives.get(id)!;
  const assemble = t.mock.method(provider, 'assemble');
  const reads = [
    () => h.engine.getResources(id, ['identity']),
    () => h.engine.getMeta(id),
    () => h.engine.listLive(),
    () => h.engine.snapshot(),
    () => h.engine.status(),
  ];
  for (const read of reads) {
    const beforeMcp = native.rpc.mcp.list.mock.callCount();
    const result = await read();
    assert.doesNotMatch(JSON.stringify(result), /roleReadiness/);
    assert.equal(native.rpc.skills.list.mock.callCount(), 0);
    assert.equal(native.rpc.tools.getCurrentMetadata.mock.callCount(), 0);
    assert.equal(assemble.mock.callCount(), 0);
    assert.equal(native.rpc.mcp.list.mock.callCount() - beforeMcp, read === reads[0] ? 0 : 1,
      'ordinary reads only inspect MCP host activity for existing control/lifecycle safety');
  }
  assert.equal((await h.engine.roleReadiness(id)).ready, false);
  native.state.skills = [{ name: 'executor', description: '', source: 'custom', path: '/fixture/skills/executor/SKILL.md', enabled: true } as Skill];
  native.state.mcp = mcpState([{ name: 'module_fixture__tools', status: 'connected' }]);
  assert.equal((await h.engine.roleReadiness(id, [role])).ready, true);
  native.state.processing = true;
  native.state.tasks = [task()];
  native.state.queue.items = [queued('pending', 'Unrelated pending content')];
  assert.equal((await h.engine.roleReadiness(id)).ready, true, 'capabilities are independent of turn/queue/subagent activity');
  native.state.processing = false;
  native.state.tasks = [];
  native.state.queue.items = [];
  assert.match((await h.engine.roleReadiness(id, [{ ...role, roleId: 'unselected' }])).reasons.join(), /Role not selected/);
  native.state.skills[0]!.enabled = false;
  assert.match((await h.engine.roleReadiness(id)).reasons.join(), /disabled/);
  native.state.skills[0]!.enabled = true;
  native.state.mcp.host!.disabledServers = ['module_fixture__tools'];
  assert.match((await h.engine.roleReadiness(id)).reasons.join(), /not connected/);
  version = 2;
  assert.match((await h.engine.roleReadiness(id)).reasons.join(), /resources differ/);
  await h.engine.unload(id);
  assert.deepEqual((await h.engine.listLive())[0]!.roles, [role]);
  assert.equal((await h.engine.roleReadiness(id)).loaded, false);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0, 'explicit readiness never loads an unloaded session');
  assert.match((await h.engine.roleReadiness('missing-session')).reasons.join(), /does not exist/);
  const cold = new Engine({ runtime: h.runtime as unknown as EngineRuntime });
  cold.setRoleProvider(provider);
  assert.deepEqual((await cold.getMeta(id))!.roles, [role]);
  await cold.load(id);
  assert.match(JSON.stringify(h.configs.get(id)!.systemMessage), /executor v2/);
  assert.notDeepEqual(h.configs.get(id)!.systemMessage, config.systemMessage, 'cold resume uses current role resources');
  assert.deepEqual(h.configs.get(id)!.mcpServers, config.mcpServers);
  native.state.mcp.host!.disabledServers = [];
  native.rpc.tools.getCurrentMetadata.mock.mockImplementation(async () => ({ tools: [] }));
  assert.match((await cold.roleReadiness(id)).reasons.join(), /not currently offered/);
  assert.equal(native.rpc.tools.initializeAndValidate.mock.callCount(), 2, 'readiness never repairs tools');
});

for (const stage of ['assembly', 'capability read'] as const) {
  test(`explicit readiness does not report a closed handle ready during ${stage}`, async t => {
    const h = harness(t);
    const roles = [{ moduleId: 'fixture', roleId: 'owner', moduleName: 'Fixture', name: 'Owner' }];
    const saved = new Map<string, typeof roles>();
    const assembly = { roles, skills: [], config: {}, fingerprint: 'fixture' };
    const provider: RoleProvider = {
      list: () => roles, read: id => saved.get(id) ?? [], save: (id, value) => { saved.set(id, value); },
      assemble: async () => assembly,
    };
    h.engine.setRoleProvider(provider);
    const id = await h.engine.newSession(h.cwd, roles);
    const native = h.natives.get(id)!;
    const held = deferred<typeof assembly>();
    const tools = deferred<{ tools: [] }>();
    if (stage === 'assembly') t.mock.method(provider, 'assemble', () => held.promise);
    else native.rpc.tools.getCurrentMetadata.mock.mockImplementationOnce(() => tools.promise);
    const reading = h.engine.roleReadiness(id);
    await nextTurn();
    h.runtime.expire(id, true);
    held.resolve(assembly);
    tools.resolve({ tools: [] });
    const result = await reading;
    assert.equal(result.ready, false);
    assert.equal(result.loaded, false);
    assert.match(result.reasons.join(), /closed|changed/);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  });
}

test('role conflicts and failed native acknowledgement preserve attribution without a hidden retry', async t => {
  const h = harness(t);
  const roles = [{ moduleId: 'board', roleId: 'owner', moduleName: 'Board', name: 'Owner' }];
  const stored = new Map<string, typeof roles>();
  const provider: RoleProvider = {
    list: () => roles, read: id => stored.get(id) ?? [], save: (id, value) => { stored.set(id, value); },
    assemble: async () => ({ roles, config: {}, skills: [], fingerprint: 'v1' }),
  };
  h.engine.setRoleProvider(provider);
  h.runtime.createSession.mock.mockImplementationOnce(async () => { throw new Error('RPC disconnected after submission'); });
  let identity = '';
  await assert.rejects(h.engine.newSession(h.cwd, roles), (error: unknown) => {
    const value = error as { code: string; sessionId: string };
    identity = value.sessionId;
    return value.code === 'SESSION_CREATION_UNCERTAIN' && typeof identity === 'string';
  });
  assert.deepEqual(stored.get(identity), roles);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  t.mock.method(provider, 'assemble', async () => { throw new Error('Conflicting role resources'); });
  await assert.rejects(h.engine.newSession(h.cwd, roles), /Conflicting/);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
});

test('MCP-only roles reject discovered native config collisions on create and cold resume', async t => {
  const h = harness(t);
  const roles = [{ moduleId: 'fixture', roleId: 'mcp-only', moduleName: 'Fixture', name: 'MCP only' }];
  const saved = new Map<string, typeof roles>();
  const config = { type: 'http' as const, url: 'http://127.0.0.1/role', tools: ['read'] };
  const native = { type: 'http' as const, url: 'http://127.0.0.1/native', tools: ['unrelated'] };
  h.engine.setRoleProvider({
    list: () => roles, read: id => saved.get(id) ?? [], save: (id, value) => { saved.set(id, value); },
    assemble: async () => ({ roles, skills: [], fingerprint: 'mcp-only', config: { mcpServers: { module_fixture__tools: config } } }),
  });
  h.mcpDefinitions.module_fixture__tools = native;
  await assert.rejects(h.engine.newSession(h.cwd, roles), /Role MCP conflicts with native configuration/);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.deepEqual(h.mcpDefinitions.module_fixture__tools, native);
  h.mcpDefinitions.module_fixture__tools = config;
  await assert.rejects(h.engine.newSession(h.cwd, roles), /Role MCP conflicts with native configuration/);
  delete h.mcpDefinitions.module_fixture__tools;
  h.discoveredMcp.push({ name: 'module_fixture__tools', source: 'workspace', enabled: true });
  await assert.rejects(h.engine.newSession(h.cwd, roles), /Role MCP conflicts with native configuration/);
  h.discoveredMcp.length = 0;
  delete h.mcpDefinitions.module_fixture__tools;
  const id = await h.engine.newSession(h.cwd, roles);
  await h.engine.unload(id);
  h.mcpDefinitions.module_fixture__tools = native;
  await assert.rejects(h.engine.load(id), /Role MCP conflicts with native configuration/);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.deepEqual(saved.get(id), roles);
  assert.deepEqual(h.mcpDefinitions.module_fixture__tools, native);
  assert.equal(h.runtime.rpc.skills.discover.mock.callCount(), 0, 'MCP validation does not depend on role skills');
});

for (const provenRoles of [false, true]) {
test(`session provenance with known roles=${provenRoles} uses assembled identity and native path, never prefixes`, async t => {
  const h = harness(t);
  const module = { id: 'fixture', name: 'Fixture module',
    ...(provenRoles ? { roles: [{ id: 'worker', name: 'Worker' }] } : {}) };
  const role = { moduleId: module.id, moduleName: module.name, roleId: 'worker', name: 'Worker' };
  const saved = new Map<string, typeof role[]>();
  let path = '/fixture/v1/worker/SKILL.md';
  const provider: RoleProvider = {
    list: () => [role], read: id => saved.get(id) ?? [], save: (id, roles) => { saved.set(id, roles); },
    assemble: async () => ({
      roles: [role], fingerprint: path, skills: [{ name: 'fixture-worker', path, module }],
      mcpSources: { 'fixture-tools': module },
      config: { skillDirectories: [path.slice(0, path.lastIndexOf('/'))],
        mcpServers: { 'fixture-tools': { type: 'http', url: 'http://127.0.0.1/mcp', tools: ['read'] } } },
    }),
  };
  h.engine.setRoleProvider(provider);
  h.discoveredSkills.push({ name: 'fixture-worker', path, description: '', source: 'custom' } as ServerSkill);
  const id = await h.engine.newSession(h.cwd, [role]);
  const native = h.natives.get(id)!;
  native.state.skills = [
    { name: 'fixture-worker', description: 'Native description', path, source: 'custom', enabled: false } as Skill,
    { name: 'module_fixture__unrelated', description: '', path: '/native/SKILL.md', source: 'custom', enabled: true } as Skill,
  ];
  const before = structuredClone(native.state.skills);
  const assemble = t.mock.method(provider, 'assemble');
  const skills = await h.engine.listSessionSkills(id);
  assert.deepEqual(skills[0], {
    name: 'fixture-worker', description: 'Native description', source: 'custom', enabled: false, module,
  });
  assert.equal(Object.hasOwn(skills[1]!, 'module'), false);
  assert.deepEqual(native.state.skills, before, 'projection does not mutate SDK objects');
  assert.equal(assemble.mock.callCount(), 0, 'resource reads do not assemble or calculate readiness');
  await h.engine.refreshSkills();
  assert.deepEqual((await h.engine.listSessionSkills(id))[0]!.module, module);
  native.state.skills[0]!.path = '/replacement/SKILL.md';
  await h.engine.refreshSkills();
  assert.equal(Object.hasOwn((await h.engine.listSessionSkills(id))[0]!, 'module'), false);
  native.state.skills[0]!.path = path;
  native.state.mcp = mcpState([{ name: 'fixture-tools', source: 'user', status: 'failed', error: 'Native error' }]);
  assert.deepEqual((await h.engine.listSessionMcp(id)).servers, [{
    name: 'fixture-tools', detail: 'user', enabled: true, status: 'failed', error: 'Native error', module,
  }], 'MCP module is role configuration provenance, independent of native source and connection state');
  native.state.mcp = mcpState([
    { name: 'module_fixture__unrelated', source: 'custom', status: 'connected' },
    { name: 'constructor', source: 'custom', status: 'connected' },
  ]);
  assert.ok((await h.engine.listSessionMcp(id)).servers.every(server => !Object.hasOwn(server, 'module')),
    'neither lookalike names nor inherited object properties declare module configuration');
  native.state.mcp = mcpState([{ name: 'fixture-tools', source: 'user', status: 'connected' }]);
  await h.engine.reloadSessionMcp(id);
  assert.deepEqual((await h.engine.listSessionMcp(id)).servers[0]!.module, module,
    'role configuration declaration remains, without claiming to verify a same-name native replacement');
  assert.doesNotMatch(JSON.stringify(await h.engine.getResources(id, ['identity'])), /roleReadiness/);
  await h.engine.unload(id);
  assert.deepEqual(await h.engine.listSessionMcp(id), { loaded: false, servers: [] });
  await assert.rejects(h.engine.listSessionSkills(id), unavailableSession);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  path = '/fixture/v2/worker/SKILL.md';
  h.discoveredSkills[0]!.path = path;
  await h.engine.load(id);
  assert.deepEqual((await h.engine.listSessionMcp(id)).servers[0]!.module, module,
    'cold resume rebuilds the role configuration source');
  assert.equal(Object.hasOwn((await h.engine.listSessionSkills(id))[0]!, 'module'), false,
    'cold resume assembly must not label a native skill retaining the old path');
  native.state.skills[0]!.path = path;
  assert.deepEqual((await h.engine.listSessionSkills(id))[0]!.module, module);
  native.state.skills[0]!.name = 'same-path-different-name';
  assert.equal((await h.engine.listSessionSkills(id))[0]!.module, undefined);
  native.state.skills[0]!.name = 'fixture-worker';
  delete native.state.skills[0]!.path;
  assert.equal((await h.engine.listSessionSkills(id))[0]!.module, undefined);
});
}

async function roleProvenanceFixture(t: TestContext) {
  const h = await roleAdditionFixture(t);
  const path = '/synthetic/shared/SKILL.md';
  const assemble = h.provider.assemble.bind(h.provider);
  h.provider.assemble = async (id, selections) => {
    const value = await assemble(id, selections);
    const module = { id: 'fixture', name: 'Fixture',
      roles: value.roles.map(role => ({ id: role.roleId, name: role.name })) };
    return { ...value, skills: [{ name: 'shared-skill', path, module }],
      mcpSources: { 'shared-tools': module }, config: { ...value.config,
        skillDirectories: ['/synthetic/shared'],
        mcpServers: { 'shared-tools': { type: 'http', url: 'http://127.0.0.1/mcp', tools: ['read'] } },
      } };
  };
  h.discoveredSkills.push({ name: 'shared-skill', path } as ServerSkill);
  assert.equal((await h.engine.addRoles(h.id, [h.catalog[0]!])).status, 'saved');
  await h.engine.reload(h.id);
  h.native.state.skills = [{ name: 'shared-skill', path, source: 'custom', enabled: true } as Skill];
  h.native.state.mcp = mcpState([{ name: 'shared-tools', status: 'connected' }]);
  const sources = async () => {
    const mcp = await h.engine.listSessionMcp(h.id);
    if (!mcp.loaded) {
      assert.deepEqual(mcp.servers, []);
      await assert.rejects(h.engine.listSessionSkills(h.id), unavailableSession);
      return [];
    }
    const skills = await h.engine.listSessionSkills(h.id);
    assert.equal(mcp.servers.length, 1);
    assert.equal(skills.length, 1);
    assert.deepEqual(mcp.servers[0]!.module, skills[0]!.module);
    return mcp.servers[0]!.module?.roles?.map(role => role.id);
  };
  assert.deepEqual(await sources(), ['executor']);
  return { ...h, sources };
}

for (const phase of ['close', 'assemble', 'resume', 'initialize', 'success'] as const) {
  test(`resource contributors follow applied handles across explicit role reload ${phase}`, async t => {
    const h = await roleProvenanceFixture(t);
    const result = await h.engine.addRoles(h.id, [h.catalog[1]!]);
    assert.equal(result.status, 'saved');
    assert.equal(result.rolesNeedReload, true);
    assert.deepEqual(result.roles, h.catalog);
    assert.deepEqual(result.appliedRoles, [h.catalog[0]]);
    assert.deepEqual(await h.sources(), ['executor'], 'saved roles are not resource contributors until loaded');
    if (phase === 'close') h.runtime.closeSession.mock.mockImplementationOnce(async () => { throw new Error('synthetic close unknown'); });
    if (phase === 'assemble') t.mock.method(h.provider, 'assemble', async () => { throw new Error('synthetic assembly failure'); });
    if (phase === 'resume') h.runtime.resumeSession.mock.mockImplementationOnce(async () => { throw new Error('synthetic resume unknown'); });
    if (phase === 'initialize') {
      h.native.rpc.tools.initializeAndValidate.mock.mockImplementationOnce(async () => { throw new Error('synthetic initialization failure'); });
    }
    if (phase === 'success') await h.engine.reload(h.id);
    else await assert.rejects(h.engine.reload(h.id), /synthetic/);
    assert.deepEqual(await h.sources(), phase === 'resume' || phase === 'assemble' ? [] : phase === 'close'
      ? ['executor'] : ['executor', 'owner']);
    if (phase === 'success') {
      assert.equal((await h.engine.addRoles(h.id, h.catalog)).status, 'unchanged');
      await h.engine.unload(h.id);
      assert.deepEqual(await h.sources(), []);
      await h.engine.load(h.id);
      assert.deepEqual(await h.sources(), ['executor', 'owner']);
    }
  });
}

for (const written of [false, true]) {
  test(`uncertain role save afterWrite=${written} preserves previous resource contributors`, async t => {
    const h = await roleProvenanceFixture(t);
    t.mock.method(h.provider, 'save', (id, roles) => {
      if (written) h.saved.set(id, roles);
      throw new Error('synthetic persistence acknowledgement failure');
    });
    const result = await h.engine.addRoles(h.id, [h.catalog[1]!]);
    assert.equal(result.status, 'uncertain');
    assert.deepEqual(result.roles, written ? h.catalog : [h.catalog[0]]);
    assert.deepEqual(await h.sources(), ['executor']);
  });
}

test('pending role resume never exposes selected contributors before a handle returns', async t => {
  const h = await roleProvenanceFixture(t);
  const held = deferred<CopilotSession>();
  h.runtime.resumeSession.mock.mockImplementationOnce(() => held.promise);
  await h.engine.addRoles(h.id, [h.catalog[1]!]);
  const loading = h.engine.reload(h.id);
  await nextTurn();
  assert.deepEqual(h.saved.get(h.id), h.catalog);
  assert.deepEqual(await h.sources(), []);
  h.runtime.isSessionLive.mock.mockImplementation(async () => true);
  held.resolve(h.native.sdk as unknown as CopilotSession);
  await loading;
  assert.deepEqual(await h.sources(), ['executor', 'owner']);
});

test('readonly native observer sees live deltas without web/history reads and isolates failures', async t => {
  const h = harness(t);
  const session = await h.load();
  const observations: import('./engine.ts').NativeObservation[] = [];
  const logs: string[] = [];
  h.engine.log = message => { logs.push(message); };
  const beforeEvents = h.events.length;
  const off = h.engine.onNativeEvent(value => { observations.push(value); });
  h.engine.onNativeEvent(() => { throw new Error('synthetic observer failure'); });
  h.engine.onNativeEvent(async () => { throw new Error('synthetic asynchronous observer failure'); });
  h.engine.onNativeEvent(() => new Promise(() => {}));
  const reads = session.rpc.eventLog.read.mock.callCount();
  const passive = h.runtime.rpc.sessions.readPersistedEvents.mock.callCount();
  session.emit(event('assistant.message_start', { messageId: 'observed-message' }));
  session.emit(event('assistant.message_delta', { messageId: 'observed-message', deltaContent: 'synthetic delta' }));
  await nextTurn();
  assert.deepEqual(observations.map(value => value.event.type), ['assistant.message_start', 'assistant.message_delta']);
  assert.ok(observations.every(value => value.sessionId === session.id && value.cwd === h.cwd));
  assert.ok(Object.isFrozen(observations[0]));
  assert.ok(Object.isFrozen(observations[0]!.event.data));
  assert.equal(h.events.length, beforeEvents, 'Deltas and observer failures cannot patch native control metadata');
  assert.equal(logs.length, 4);
  assert.equal(session.rpc.eventLog.read.mock.callCount(), reads);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), passive);
  assert.equal(await h.engine.busyCount(), 0, 'Unsettled observers must never retain native work');
  off();
  session.emit(event('assistant.message_delta', { messageId: 'observed-message', deltaContent: 'later' }));
  assert.equal(observations.length, 2);
});

test('readonly native observer filters before payload traversal and shares one immutable clone', async t => {
  const h = harness(t);
  const session = await h.load();
  const workspacePath = '/synthetic-native-workspaces/filtered';
  let workspaceReads = 0;
  Object.defineProperty(session.sdk, 'workspacePath', {
    get() { workspaceReads++; return workspacePath; },
  });
  const first: import('./engine.ts').NativeObservation[] = [];
  const second: import('./engine.ts').NativeObservation[] = [];
  const types = ['assistant.message_delta'];
  const offFirst = h.engine.onNativeEvent(value => { first.push(value); }, { types });
  const offSecond = h.engine.onNativeEvent(value => { second.push(value); }, { types });
  h.engine.onNativeEvent(() => assert.fail('Empty event filter must never receive an event'), { types: [] });
  types.push('tool.execution_complete');
  let payloadReads = 0;
  const payload = Object.defineProperty({}, 'largeResult', {
    enumerable: true, get() { payloadReads++; return { text: 'synthetic payload' }; },
  });
  const unused = event('tool.execution_complete', {
    toolCallId: 'synthetic-tool', success: true, result: { content: 'unused tool result' },
  });
  Object.assign(unused.data.result!, { payload });
  // Invoke the captured SDK callback directly: the fixture's journal helper
  // intentionally clones events itself and would traverse this getter first.
  const notify = h.configs.get(session.id)!.onEvent!;
  notify(unused);
  assert.equal(payloadReads, 0, 'Uninterested observers must not traverse unused tool results');
  assert.equal(workspaceReads, 0, 'Uninterested observers must not read workspace metadata');
  assert.equal(first.length, 0);
  assert.equal(second.length, 0);
  const cwd = join(h.cwd, 'filtered-native-context');
  notify(event('session.context_changed', { cwd }));
  assert.equal(first.length, 0, 'Filtered context events still update cwd without delivery');
  assert.equal(workspaceReads, 0);
  const delta = event('assistant.message_delta', { messageId: 'filtered-message', deltaContent: 'synthetic delta' });
  Object.assign(delta.data, { payload });
  notify(delta);
  assert.equal(payloadReads, 1, 'Only one payload clone is built for multiple interested observers');
  assert.equal(workspaceReads, 1, 'Only one workspace read is needed for multiple interested observers');
  assert.equal(first[0], second[0]);
  assert.equal(first[0]?.cwd, cwd);
  assert.equal(first[0]?.workspacePath, workspacePath);
  assert.ok(Object.isFrozen(first[0]));
  assert.ok(Object.isFrozen(first[0]!.event.data.payload));
  offFirst();
  offSecond();
  notify(delta);
  assert.equal(payloadReads, 1, 'An empty filter alone does not justify cloning');
  assert.equal(workspaceReads, 1);
  assert.equal(session.rpc.eventLog.read.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
});

test('readonly native observer redacts internal binary, preserves native payload and rejects stale owners', async t => {
  const h = harness(t);
  const session = await h.load();
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const native = {
    ...event('tool.execution_complete', { toolCallId: 'tool-id', success: true }),
    data: {
      toolCallId: 'tool-id', success: true,
      result: { content: 'text retained', binaryResultsForLlm: [{ data: 'do-not-observe-image-bytes' }], buffer: Buffer.from('binary') },
    },
  } as unknown as SessionEvent;
  session.emit(native);
  const result = observations[0]!.event.data.result as Record<string, unknown>;
  assert.equal(result.content, 'text retained');
  assert.equal(Object.hasOwn(result, 'binaryResultsForLlm'), false);
  assert.equal(result.buffer, undefined);
  assert.ok((native.data as { result: Record<string, unknown> }).result.binaryResultsForLlm, 'Native event must not be mutated');
  const previous = h.configs.get(session.id)!.onEvent!;
  await h.engine.unload(session.id);
  const before = observations.length;
  previous(event('assistant.message_delta', { messageId: 'old-owner', deltaContent: 'stale' }));
  assert.equal(observations.length, before);
  assert.equal(await h.engine.busyCount(), 0);
});

test('readonly native observer derives cwd from native create/resume metadata, never HOME', async t => {
  const h = harness(t);
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const id = await h.engine.newSession(h.cwd);
  h.natives.get(id)!.emit(event('assistant.message_delta', { messageId: 'created', deltaContent: 'created' }));
  assert.equal(observations.at(-1)?.cwd, h.cwd);
  const seeded = await h.seed();
  seeded.state.cwd = '';
  h.rows.find(row => row.sessionId === seeded.id)!.context = undefined;
  await h.engine.load(seeded.id);
  seeded.emit(event('assistant.message_delta', { messageId: 'resumed', deltaContent: 'no known directory' }));
  assert.equal(observations.at(-1)?.cwd, null);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
});

test('readonly native observer reads current SDK workspace independently of HOME, cwd and metadata', async t => {
  const h = harness(t);
  const session = await h.load();
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const calls = nativeCalls(session);
  for (const workspacePath of ['/synthetic-native-workspaces/custom-root', '/different-sdk-root/session', undefined]) {
    session.sdk.workspacePath = workspacePath;
    session.emit(event('assistant.message_delta', { messageId: 'workspace', deltaContent: 'current context' }));
    const observation = observations.at(-1)!;
    assert.equal(observation.cwd, h.cwd);
    assert.equal(observation.workspacePath, workspacePath ?? null);
    assert.equal(Object.hasOwn(observation, 'workspacePath'), true);
    assert.ok(Object.isFrozen(observation));
  }
  assert.equal(observations[0]!.workspacePath, '/synthetic-native-workspaces/custom-root', 'Earlier snapshots cannot change');
  assert.deepEqual(nativeCalls(session), calls, 'Workspace context reads only the public SDK property, not an RPC');
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
});

test('readonly native observer reports invalid or throwing SDK workspace as unknown without affecting native control', async t => {
  const h = harness(t);
  const session = await h.load();
  const observations: import('./engine.ts').NativeObservation[] = [];
  const reports: Array<{ message: string; data?: Record<string, unknown> }> = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  h.engine.log = (message, data) => { reports.push({ message, data }); };
  const calls = nativeCalls(session);
  const invalid = ['', 'relative/path', '/invalid\0path', 123, {}];
  for (const workspacePath of invalid) {
    Object.defineProperty(session.sdk, 'workspacePath', { configurable: true, value: workspacePath });
    session.emit(event('assistant.message_delta', { messageId: 'invalid-workspace', deltaContent: 'still observed' }));
    const observation = observations.at(-1)!;
    assert.equal(observation.cwd, h.cwd);
    assert.equal(observation.workspacePath, undefined);
    assert.equal(Object.hasOwn(observation, 'workspacePath'), false);
  }
  assert.deepEqual(reports, invalid.map(() => ({
    message: 'native observer failed', data: { sessionId: session.id, error: 'Invalid native workspace path' },
  })));
  Object.defineProperty(session.sdk, 'workspacePath', {
    get() { throw new Error('Synthetic workspace getter failure'); },
  });
  h.engine.log = (message, data) => {
    reports.push({ message, data });
    throw new Error('Synthetic observer reporter failure');
  };
  const epoch = activeState(h, session.id).turnEpoch as number;
  assert.doesNotThrow(() => session.emit(event('assistant.turn_start', { turnId: 'workspace-failure' })));
  assert.equal(activeState(h, session.id).turnEpoch, epoch + 1, 'Observer metadata failure cannot prevent native control delivery');
  assert.equal(observations.length, invalid.length + 1);
  assert.equal(Object.hasOwn(observations.at(-1)!, 'workspacePath'), false);
  assert.deepEqual(reports.at(-1), {
    message: 'native observer failed', data: { sessionId: session.id, error: 'Synthetic workspace getter failure' },
  });
  assert.deepEqual(nativeCalls(session), calls);
});

test('readonly native observer uses the new resumed SDK workspace and never a stale handle', async t => {
  const h = harness(t);
  const session = await h.load();
  session.sdk.workspacePath = '/synthetic-native-workspaces/old-handle';
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const delta = () => event('assistant.message_delta', { messageId: 'workspace-owner', deltaContent: 'context' });
  session.emit(delta());
  const previous = h.configs.get(session.id)!.onEvent!;
  const resumed = fakeSession(t, session.id);
  resumed.state.cwd = h.cwd;
  resumed.sdk.workspacePath = '/different-sdk-root/resumed-handle';
  const resume = h.runtime.resumeSession;
  t.mock.method(h.runtime, 'resumeSession', async (id, config) => {
    h.natives.set(id, resumed);
    h.journals.set(id, resumed.state.events);
    previous(delta());
    config.onEvent!(delta());
    return resume(id, config);
  });
  await h.engine.reload(session.id);
  assert.equal(observations.length, 2, 'An old callback cannot observe during a new allocation');
  assert.equal(observations[0]!.workspacePath, '/synthetic-native-workspaces/old-handle');
  assert.equal(Object.hasOwn(observations[1]!, 'workspacePath'), false, 'Early resume must not borrow the prior workspace');
  previous(delta());
  assert.equal(observations.length, 2, 'An old callback cannot observe a newly bound handle');
  resumed.emit(delta());
  assert.equal(observations.at(-1)?.workspacePath, resumed.sdk.workspacePath);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
});

test('readonly native observer updates cwd before root context delivery without child contamination or RPC', async t => {
  const h = harness(t);
  const session = await h.load();
  session.sdk.workspacePath = '/synthetic-native-workspaces/context-independent';
  const firstCwd = join(h.cwd, 'first-native-context');
  session.emit(event('session.context_changed', { cwd: firstCwd }));
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const metadataReads = session.rpc.metadata.snapshot.mock.callCount();
  const persistedReads = h.runtime.rpc.sessions.readPersistedEvents.mock.callCount();
  const liveReads = session.rpc.eventLog.read.mock.callCount();
  session.emit(event('assistant.message_delta', { messageId: 'context', deltaContent: 'after unobserved change' }));
  assert.equal(observations.at(-1)?.cwd, firstCwd);
  const nextCwd = join(h.cwd, 'next-native-context');
  session.emit(event('session.context_changed', { cwd: nextCwd }));
  assert.equal(observations.at(-1)?.event.type, 'session.context_changed');
  assert.equal(observations.at(-1)?.cwd, nextCwd, 'The context-change observation itself must see the new native cwd');
  for (const childFields of [
    { agentId: 'child' }, { parentToolCallId: 'parent-tool' },
  ]) {
    session.emit({ ...event('session.context_changed', { cwd: join(h.cwd, 'child') }), ...childFields } as SessionEvent);
    session.emit(event('session.context_changed', { cwd: join(h.cwd, 'child'), ...childFields }));
    assert.equal(observations.at(-1)?.cwd, nextCwd);
  }
  const reports: string[] = [];
  h.engine.log = message => { reports.push(message); };
  for (const cwd of ['', 'relative/path', '/invalid\0path', 123]) {
    session.emit(event('session.context_changed', { cwd } as { cwd: string }));
    assert.equal(observations.at(-1)?.cwd, nextCwd);
  }
  assert.equal(reports.length, 4);
  session.emit(event('assistant.message_delta', { messageId: 'context', deltaContent: 'after root change' }));
  assert.equal(observations.at(-1)?.cwd, nextCwd);
  assert.ok(observations.every(value => value.workspacePath === session.sdk.workspacePath), 'Root and child cwd changes cannot alter the SDK workspace');
  assert.equal(session.rpc.metadata.snapshot.mock.callCount(), metadataReads);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), persistedReads);
  assert.equal(session.rpc.eventLog.read.mock.callCount(), liveReads);
});

test('readonly native observer retains a context change that races loading metadata', async t => {
  const h = harness(t);
  const session = await h.seed();
  const stale = await session.rpc.metadata.snapshot();
  const pendingMetadata = deferred<typeof stale>();
  t.mock.method(session.rpc.metadata, 'snapshot', () => pendingMetadata.promise);
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const loading = h.engine.load(session.id);
  await nextTurn();
  const currentCwd = join(h.cwd, 'current-native-context');
  session.emit(event('session.context_changed', { cwd: currentCwd }));
  pendingMetadata.resolve(stale);
  await loading;
  session.emit(event('assistant.message_delta', { messageId: 'context', deltaContent: 'after loading metadata' }));
  assert.equal(observations.at(-1)?.cwd, currentCwd);
});

test('readonly native observer retains a newer cwd when concurrent initial metadata arrives late', async t => {
  const h = harness(t);
  const session = await h.seed();
  const stale = structuredClone(h.rows.find(row => row.sessionId === session.id)!);
  const pendingMetadata = deferred<SessionMetadata | undefined>();
  h.runtime.getSessionMetadata.mock.mockImplementationOnce(() => pendingMetadata.promise);
  const observations: import('./engine.ts').NativeObservation[] = [];
  h.engine.onNativeEvent(value => { observations.push(value); });
  const pendingLoad = h.engine.load(session.id);
  await nextTurn();
  await h.engine.load(session.id);
  const currentCwd = join(h.cwd, 'newer-native-context');
  session.emit(event('session.context_changed', { cwd: currentCwd }));
  assert.equal(observations.at(-1)?.cwd, currentCwd);
  pendingMetadata.resolve(stale);
  await pendingLoad;
  session.emit(event('assistant.message_delta', { messageId: 'context', deltaContent: 'after concurrent initial metadata' }));
  assert.equal(observations.at(-1)?.cwd, currentCwd);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(session.sdk.send.mock.callCount(), 0);
});

test('native creation returns the actual ID without product roles or a hidden first message', async t => {
  const h = harness(t);
  const id = await h.engine.newSession(h.cwd);
  const config = h.configs.get(id)!;
  assert.equal(config.sessionId, id);
  assert.equal(config.workingDirectory, h.cwd);
  assert.equal(config.enableConfigDiscovery, true);
  for (const key of ['systemMessage', 'skillDirectories', 'mcpServers']) assert.equal(Object.hasOwn(config, key), false);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 0);
  await h.engine.prompt(id, 'The actual first user message');
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 1);
});

test('creation readback failure retains only the actual acknowledged native ID and never sends', async t => {
  const h = harness(t), create = h.runtime.createSession;
  t.mock.method(h.runtime, 'createSession', async config => {
    const sdk = await create(config);
    h.natives.get(sdk.sessionId)!.rpc.metadata.snapshot.mock.mockImplementationOnce(async () => {
      throw new Error('Synthetic native metadata failure');
    });
    return sdk;
  });
  let createdId = '';
  await assert.rejects(h.engine.newSession(h.cwd), error => {
    assert.ok(error instanceof Error && 'sessionId' in error && typeof error.sessionId === 'string');
    createdId = error.sessionId;
    assert.match(error.message, /was created.*metadata failure/);
    return true;
  });
  assert.ok(h.natives.has(createdId));
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.natives.get(createdId)!.sdk.send.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(createdId))?.sessionId, createdId);
});

test('session/load preserves empty loaded sessions and busy native work without closing or sending', async t => {
  const h = harness(t), id = await h.engine.newSession(h.cwd);
  await h.engine.load(id);
  const native = h.natives.get(id)!;
  native.state.processing = true;
  native.state.queue.items = [queued('already-pending', 'Keep existing native work')];
  await h.engine.load(id);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(native.sdk.send.mock.callCount(), 0);
  assert.equal(native.state.processing, true);
  assert.equal(native.state.queue.items[0]?.id, 'already-pending');
});

test('session/load coalesces native cold loading and protects its in-flight work', async t => {
  const h = harness(t), session = await h.seed();
  const ready = deferred<void>(), entered = deferred<void>();
  const resume = h.runtime.resumeSession;
  t.mock.method(h.runtime, 'resumeSession', async (...args: Parameters<typeof resume>) => {
    entered.resolve();
    await ready.promise;
    return resume(...args);
  });
  const first = h.engine.load(session.id), second = h.engine.load(session.id);
  await entered.promise;
  assert.ok(await h.engine.busyCount() > 0);
  await assert.rejects(h.engine.unload(session.id), /progress/);
  await assert.rejects(h.engine.stop(), protectedWork);
  ready.resolve();
  await Promise.all([first, second]);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 1);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(session.sdk.send.mock.callCount(), 0);
});

test('separate prompt rejects empty content and a missing native acceptance without recreating', async t => {
  const h = harness(t), id = await h.engine.newSession(h.cwd);
  await assert.rejects(h.engine.prompt(id, ' '), /empty/);
  h.natives.get(id)!.sdk.send.mock.mockImplementation(async () => '');
  await assert.rejects(h.engine.prompt(id, 'Only once'), /receipt is missing/);
  assert.equal(h.runtime.createSession.mock.callCount(), 1);
  assert.equal(h.natives.get(id)!.sdk.send.mock.callCount(), 1);
});

test('session/load rejects unknown targets and mismatched native resume identities without substituting another session', async t => {
  const h = harness(t);
  await assert.rejects(h.engine.load('unknown-original'), /Unknown session/);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  const target = await h.seed(), other = await h.seed();
  const wrong = await h.runtime.resumeSession(other.id, {});
  t.mock.method(h.runtime, 'resumeSession', async () => wrong);
  await assert.rejects(h.engine.load(target.id), /Native resume returned a different session ID/);
  assert.equal(target.sdk.send.mock.callCount(), 0);
  assert.equal(other.sdk.send.mock.callCount(), 0);
  assert.equal(h.attached.has(target.id), false);
  assert.equal(h.attached.has(other.id), true);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
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
  await h.engine.deleteSession('unknown-project');
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
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 2);
  const reads = s.rpc.eventLog.read.mock.calls;
  assert.deepEqual(reads[1]!.arguments[0], {
    ...reads[0]!.arguments[0], cursor: (await reads[0]!.result!).cursor,
  }, 'Keep the same all-agent durable filter and pass the native cursor back unchanged');
  await assert.rejects(h.engine.forkSession(s.id), /schedule/);
  assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 1);
});

test('fork structural reads preserve wildcard safety decisions across page and agent boundaries', async t => {
  const start = event('assistant.turn_start', { turnId: 'turn' });
  const end = event('assistant.turn_end', { turnId: 'turn' });
  const abort = event('abort', { reason: 'user_initiated' });
  const toolStart = event('tool.execution_start', { toolCallId: 'tool', toolName: 'view', arguments: { path: '/fixture' } });
  const toolEnd = event('tool.execution_complete', { toolCallId: 'tool', success: true, result: { content: 'fixture result' } });
  const agentData = { toolCallId: 'spawn', agentName: 'explore', agentDisplayName: 'Fixture' };
  const agentStart = event('subagent.started', { ...agentData, agentDescription: 'Fixture only' });
  const agentEnd = event('subagent.completed', agentData);
  const timer = event('session.schedule_created', { id: 1, prompt: 'fixture timer', selfPaced: true });
  const nested = (entry: SessionEvent): SessionEvent => ({ ...entry, agentId: 'child' });
  const boundary = user('boundary');
  const cases: { name: string; prefix: SessionEvent[]; allowed: boolean; boundary?: SessionEvent }[] = [
    { name: 'settled turn', prefix: [start, end], allowed: true },
    { name: 'unfinished turn', prefix: [start], allowed: false },
    { name: 'root abort settles turn', prefix: [start, abort], allowed: true },
    { name: 'child abort cannot settle root turn', prefix: [start, nested(abort)], allowed: false },
    { name: 'child turn end cannot settle root turn', prefix: [start, nested(end)], allowed: false },
    { name: 'completed tool', prefix: [toolStart, toolEnd], allowed: true },
    { name: 'unfinished tool survives root abort', prefix: [toolStart, abort], allowed: false },
    { name: 'nested unfinished tool', prefix: [nested(toolStart)], allowed: false },
    { name: 'nested completed tool', prefix: [nested(toolStart), nested(toolEnd)], allowed: true },
    { name: 'unfinished subagent', prefix: [agentStart], allowed: false },
    { name: 'completed subagent', prefix: [agentStart, agentEnd], allowed: true },
    { name: 'failed subagent', prefix: [agentStart, event('subagent.failed', { ...agentData, error: 'fixture' })], allowed: true },
    { name: 'cancelled subagent', prefix: [agentStart, event('subagent.completed', { ...agentData, cancelled: true })], allowed: true },
    { name: 'root abort cannot settle subagent', prefix: [agentStart, abort], allowed: false },
    { name: 'child abort cannot settle subagent', prefix: [agentStart, nested(abort)], allowed: false },
    { name: 'subagent completion cannot settle child tool', prefix: [agentStart, nested(toolStart), agentEnd], allowed: false },
    { name: 'nested spawn', prefix: [nested(agentStart)], allowed: false },
    { name: 'historical self-paced schedule', prefix: [timer], allowed: false },
    { name: 'stopped schedule', prefix: [timer, event('session.schedule_cancelled', { id: 1 })], allowed: false },
    { name: 'rearmed schedule', prefix: [timer, event('session.schedule_rearmed', { id: 1, nextRunAt: 1 })], allowed: false },
    { name: 'nested schedule', prefix: [nested(timer)], allowed: false },
    { name: 'exclusive settled boundary', prefix: [], allowed: true },
    { name: 'nested user boundary', prefix: [], boundary: nested(boundary), allowed: false },
    { name: 'legacy agent user boundary', prefix: [], boundary: { ...boundary, data: { ...boundary.data, agentId: 'child' } }, allowed: false },
    { name: 'legacy parent tool user boundary', prefix: [], boundary: { ...boundary, data: { ...boundary.data, parentToolCallId: 'spawn' } }, allowed: false },
    { name: 'non-user structural boundary', prefix: [], boundary: { ...start, id: boundary.id }, allowed: false },
    { name: 'filtered assistant boundary', prefix: [], boundary: assistant(boundary.id, 'reply'), allowed: false },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const s = fakeSession(t, randomUUID());
      s.state.events = [user('first'), ...scenario.prefix.flatMap(entry => [
        assistant(randomUUID(), randomUUID()), entry,
      ]), scenario.boundary ?? boundary, start, timer];
      for (const wildcard of [true, false]) {
        // Force small native pages so pending state must survive continuation.
        const read: Rpc['eventLog']['read'] = options => s.rpc.eventLog.read({
          ...options, max: 2, ...(wildcard ? { types: '*' } : {}),
        });
        if (scenario.allowed) await validateForkHistory(read, boundary.id);
        else await assert.rejects(validateForkHistory(read, boundary.id), /unfinished|schedule|root user|not found/);
      }
    });
  }
  for (const marker of ['agentId', 'parentToolCallId'] as const) {
    const s = fakeSession(t, randomUUID());
    s.state.events = [{ ...user('nested-only'), data: { content: 'child', [marker]: 'child' } }];
    await assert.rejects(validateForkHistory(s.rpc.eventLog.read), /existing conversation history/);
  }
});

test('fork excludes unrelated bodies without turning required events into ID-only reads', async t => {
  const s = fakeSession(t, randomUUID());
  const largeBody = 'x'.repeat(1024);
  s.state.events = [
    user('first', largeBody),
    ...Array.from({ length: 9999 }, (_, i) => assistant(`reply-${i}`, `message-${i}`, largeBody)),
  ];
  const counts: { calls: number; events: number; bytes: number }[] = [];
  for (const wildcard of [true, false]) {
    const count = { calls: 0, events: 0, bytes: 0 };
    await validateForkHistory(async options => {
      const { cursor, ...filter } = options;
      assert.deepEqual(filter, {
        direction: 'forward', max: 1000, agentScope: 'all', includeEphemeral: false,
        types: ['user.message', 'assistant.turn_start', 'assistant.turn_end', 'abort',
          'tool.execution_start', 'tool.execution_complete',
          'subagent.started', 'subagent.completed', 'subagent.failed', 'session.schedule_created'],
      });
      const page = await s.rpc.eventLog.read({ ...options, ...(wildcard ? { types: '*' } : {}) });
      count.calls++;
      count.events += page.events.length;
      count.bytes += Buffer.byteLength(JSON.stringify(page.events));
      if (!wildcard) assert.equal(page.events[0]?.type === 'user.message' && page.events[0].data.content, largeBody);
      return page;
    });
    counts.push(count);
  }
  assert.deepEqual(counts.map(({ calls, events }) => ({ calls, events })), [
    { calls: 10, events: 10000 }, { calls: 1, events: 1 },
  ]);
  assert.ok(counts[1]!.bytes < counts[0]!.bytes / 1000);
  t.diagnostic(`Synthetic fork eventLog.read counts (wildcard, structural): ${JSON.stringify(counts)}`);
});

for (const condition of ['expired', 'stalled', 'missing-cursor', 'read-failure'] as const) {
  test(`fork fails closed without retry on a ${condition} continuation`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.rpc.eventLog.read.mock.mockImplementation(async options => {
      if (!options.cursor) return {
        events: [user('first')], cursor: 'opaque-native-cursor', hasMore: true, cursorStatus: 'ok',
      };
      assert.equal(options.cursor, 'opaque-native-cursor');
      if (condition === 'read-failure') throw new Error('fixture read failed');
      return { events: [], cursor: condition === 'missing-cursor' ? '' : 'opaque-native-cursor',
        hasMore: true, cursorStatus: condition === 'expired' ? 'expired' : 'ok' };
    });
    await assert.rejects(h.engine.forkSession(s.id), /cursor|fixture read failed/);
    assert.equal(s.rpc.eventLog.read.mock.callCount(), 2);
    assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 0);
    assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
  });
}

test('fork does not retry or publish a child when native creation returns unverifiable metadata', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.events = [user('first')];
  h.runtime.rpc.sessions.fork.mock.mockImplementation(async () => ({ sessionId: 'unverifiable-child' }));
  await assert.rejects(h.engine.forkSession(s.id), /metadata is unavailable; do not retry/);
  assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 1);
  assert.ok(!h.events.some(event => event.type === 'session/added' && event.session.sessionId === 'unverifiable-child'));
});

for (const condition of ['running', 'task', 'queue', 'steering', 'timer', 'closed', 'fatal'] as const) {
  test(`fork freshly refuses ${condition} introduced during the history scan`, async t => {
    const h = harness(t);
    const s = await h.load();
    const gate = deferred<Awaited<ReturnType<Rpc['eventLog']['read']>>>();
    s.rpc.eventLog.read.mock.mockImplementationOnce(() => gate.promise);
    const pending = h.engine.forkSession(s.id);
    const rejected = assert.rejects(pending, /protected|timers|closed|fixture fatal/);
    while (!s.rpc.eventLog.read.mock.callCount()) await nextTurn();
    await assert.rejects(h.engine.prompt(s.id, 'must not send'), /transition/);
    await assert.rejects(h.engine.unload(s.id), /transition/);
    if (condition === 'running') s.state.processing = true;
    if (condition === 'task') s.state.tasks = [task()];
    if (condition === 'queue') s.state.queue.items = [queued('queued', 'new work')];
    if (condition === 'steering') s.state.queue.inFlightSteeringCount = 1;
    if (condition === 'timer') s.state.schedules = [schedule()];
    if (condition === 'closed') h.runtime.expire(s.id, true);
    if (condition === 'fatal') h.runtime.emitFatal(new Error('fixture fatal'));
    gate.resolve({ events: [user('first')], cursor: 'tail', hasMore: false, cursorStatus: 'ok' });
    await rejected;
    assert.equal(h.runtime.rpc.sessions.fork.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 1, 'Never resume to complete a preflight');
    assert.equal(s.sdk.abort.mock.callCount(), 0);
  });
}

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

test('a failed independent read cannot discard a completed native model acknowledgement', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<Awaited<ReturnType<Rpc['model']['getCurrent']>>>();
  s.rpc.model.getCurrent.mock.mockImplementationOnce(() => held.promise);
  const rejected = assert.rejects(h.engine.getResources(s.id, ['model']), /own read failure/);
  assert.deepEqual(await h.engine.setModel(s.id, 'command'), { modelId: 'command' });
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

test('resource reads count the real Engine paths without a native cache or list metadata refetch', async t => {
  const h = harness(t);
  const s = await h.load();
  await nextTurn();
  s.state.model.reasoningEffort = 'high';
  s.state.model.contextTier = 'long_context';
  s.state.mode = 'plan';
  s.state.name = 'Live title';
  const row = (await h.runtime.getSessionMetadata(s.id))!;
  row.modifiedTime = new Date('2026-09-10T12:00:00Z');
  const measure = async (run: () => Promise<unknown>) => {
    const before = nativeCalls(s);
    const live = h.runtime.isSessionLive.mock.callCount();
    const metadata = h.runtime.getSessionMetadata.mock.callCount();
    const lists = h.runtime.listSessions.mock.callCount();
    const models = h.runtime.models.mock.callCount();
    const value = await run();
    const native = nativeCallDelta(s, before);
    return { value, native, metadata: h.runtime.getSessionMetadata.mock.callCount() - metadata,
      count: Object.values(native).reduce((sum, n) => sum + n, 0)
        + h.runtime.isSessionLive.mock.callCount() - live
        + h.runtime.getSessionMetadata.mock.callCount() - metadata
        + h.runtime.listSessions.mock.callCount() - lists
        + h.runtime.models.mock.callCount() - models };
  };
  const full = await measure(() => h.engine.getMeta(s.id));
  assert.equal(full.count, 13, 'previous full getter: 14; metadata.snapshot replaces mode.get');
  assert.equal(full.native['mode.get'], undefined);
  const meta = (await h.engine.getMeta(s.id))!;
  assert.equal(meta.currentMode, 'plan');
  assert.equal(meta.currentReasoningEffort, 'high');
  assert.equal(meta.currentContextTier, 'long_context');
  assert.equal(meta.lastActivity, row.modifiedTime.getTime());
  const list = await measure(() => h.engine.listLive());
  assert.equal(list.count, 10, 'previous brief path: 15');
  assert.equal(list.metadata, 0, 'reuse this request list record, not another single-ID metadata read');
  for (const read of ['model.list', 'plan.readSqlTodos', 'schedule.list', 'mode.get']) assert.equal(list.native[read], undefined, read);
  assert.equal((await h.engine.listLive())[0]?.title, 'Live title');
  const snapshot = await measure(() => h.engine.snapshot());
  assert.equal(snapshot.count, 12, 'previous snapshot path: 16');
  const status = await measure(async () => ({ sessions: await h.engine.status(), busy: await h.engine.busyCount() }));
  assert.equal(status.count, 15, 'previous status path: 22; fresh safety confirmation is retained');
  const scheduleRead = await measure(() => h.engine.getResources(s.id, ['schedule']));
  assert.equal(scheduleRead.count, 2, 'attach and one schedule.list, no identity/control/model fanout');
  assert.deepEqual(scheduleRead.native, { 'schedule.list': 1 });
  const queueRead = await measure(() => h.engine.getResources(s.id, ['queue']));
  assert.deepEqual(queueRead.native, { 'queue.pendingItems': 1 });
  const together = await measure(() => h.engine.getResources(s.id, ['control', 'queue', 'queue']));
  assert.equal(together.native['queue.pendingItems'], 1, 'one request reuses the required control queue read');
  s.state.model.modelId = 'changed-between-requests';
  assert.equal((await h.engine.getResources(s.id, ['model']))?.currentModelId, 'changed-between-requests');
});

test('narrow status retains queue-only, steering-only, task-only and MCP-only busy states and teardown protection', async t => {
  const h = harness(t);
  const s = await h.load();
  for (const change of [
    () => { s.state.queue.items = [queued('q', 'not a turn')]; },
    () => { s.state.queue.steeringMessages = ['pending steering']; },
    () => { s.state.queue.inFlightSteeringCount = 1; },
    () => { s.state.tasks = [task()]; },
    () => { s.state.mcp.host!.pendingConnections = ['tools']; },
  ]) {
    change();
    assert.equal((await h.engine.listLive())[0]?.status, 'running');
    assert.equal((await h.engine.status())[0]?.status, 'running');
    await assert.rejects(h.engine.unload(s.id), protectedWork);
    s.state.queue = { items: [], steeringMessages: [], inFlightSteeringCount: 0 };
    s.state.tasks = [];
    s.state.mcp = mcpState();
  }
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('panel reads emit only lease patches and targeted panel reads use only their native resource', async t => {
  const h = harness(t);
  const s = await h.load();
  h.events.length = 0;
  const before = nativeCalls(s);
  await h.engine.getPanel(s.id, 'tasks');
  await h.engine.getPanel(s.id, 'instructionSources');
  assert.deepEqual(nativeCallDelta(s, before), { 'tasks.list': 1, 'instructions.getSources': 1 });
  assert.equal(h.events.filter(e => e.type === 'session/invalidated').length, 0);
  assert.ok(h.events.some(e => e.type === 'session/patch' && e.activeOperations === 1));
  h.events.length = 0;
  await h.engine.getPanels(s.id);
  await h.engine.getPlan(s.id);
  await h.engine.listSessionMcp(s.id);
  assert.equal(h.events.filter(e => e.type === 'session/invalidated').length, 0);
  s.emit(event('session.todos_changed', {}));
  assert.deepEqual(h.events.filter(e => e.type === 'session/invalidated').map(e => e.resources), [['todo', 'plan']]);
  h.events.length = 0;
  const beforeEvents = nativeCalls(s);
  s.emit(event('session.tools_updated', { model: 'gpt-test' }));
  s.emit(event('session.usage_checkpoint', { totalNanoAiu: 10 }));
  assert.deepEqual(h.events.filter(e => e.type === 'session/invalidated').map(e => e.resources), [['usage'], ['usage']]);
  assert.deepEqual(nativeCallDelta(s, beforeEvents), {}, 'resource notifications do not collect native state');
});

test('overlapping metadata and panel leases publish their final zero without resource invalidation', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<{ entries: NativeSchedule[] }>();
  s.rpc.schedule.list.mock.mockImplementationOnce(() => held.promise);
  h.events.length = 0;
  const metadata = h.engine.getResources(s.id, ['schedule']);
  await nextTurn();
  await h.engine.getPanel(s.id, 'tasks');
  held.resolve({ entries: [] });
  assert.equal((await metadata)?.activeOperations, 0);
  assert.deepEqual(h.events.filter(e => e.type === 'session/patch' && e.activeOperations !== undefined)
    .map(e => e.activeOperations), [1, 2, 1, 0]);
  assert.equal(h.events.filter(e => e.type === 'session/invalidated').length, 0);
});
test('native mutation events and readback invalidate the changed resource once, without suppressing control', async t => {
  const h = harness(t);
  const s = await h.load();
  const ack = deferred<void>();
  s.state.skills = [{ name: 'fixture', source: 'user', enabled: false, description: '', userInvocable: true }];
  s.rpc.skills.enable.mock.mockImplementation(async () => {
    s.state.skills[0]!.enabled = true;
    s.emit(event('session.skills_loaded', { skills: [] }));
    s.emit(event('pending_messages.modified', {}));
    await ack.promise;
  });
  h.events.length = 0;
  const mutation = h.engine.toggleSessionSkill(s.id, 'fixture', true);
  await nextTurn();
  assert.ok(h.events.some(e => e.type === 'session/invalidated' && e.resources?.includes('control')));
  assert.ok(!h.events.some(e => e.type === 'session/invalidated' && e.resources?.includes('skills')));
  ack.resolve();
  await mutation;
  assert.equal(h.events.filter(e => e.type === 'session/invalidated' && e.resources?.includes('skills')).length, 1);
});

test('session and MCP list projections consume selected records, not repeated same-array find', async t => {
  const h = harness(t);
  const s = await h.load();
  const rows = await h.runtime.listSessions();
  rows.find = () => assert.fail('list projection must use a request-owned index');
  h.runtime.listSessions.mock.mockImplementation(async () => rows);
  await h.engine.listLive();
  const mcp = mcpState(Array.from({ length: 200 }, (_, i) => ({ name: `server-${i}`, status: 'connected' })));
  mcp.servers.find = () => assert.fail('MCP projection already has this record');
  s.rpc.mcp.list.mock.mockImplementation(async () => mcp);
  const before = nativeCalls(s);
  assert.equal((await h.engine.listSessionMcp(s.id)).servers.length, 200);
  assert.equal((await h.engine.getPanels(s.id)).mcpServers.length, 200);
  assert.equal(nativeCallDelta(s, before)['mcp.list'], 2, 'one necessary native list for each request');
});

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
  assert.deepEqual(h.prefs().scheduledSessions, { scheduled: 1 }, 'inert old records are not rewritten or replayed');
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
  assert.equal(h.events.filter(event => String(event.type) === 'session/notify').length, 0);
  await h.engine.reload(s.id);
  eligibility.resolve(metadata);
  await nextTurn();
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  assert.equal(h.events.filter(event => String(event.type) === 'session/notify').length, 0);
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
    assert.deepEqual((await chat(h, s.id)).events, history.events);
    assert.ok(!h.events.some(event => event.type === 'session/removed'));
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

test('model changes return the native acknowledgement without current-state or unused inventory readback', async t => {
  const h = harness(t);
  const s = await h.load();
  const lists = s.rpc.model.list.mock.callCount();
  const currents = s.rpc.model.getCurrent.mock.callCount();
  s.rpc.model.list.mock.mockImplementation(async () => { throw new Error('unrelated inventory unavailable'); });
  await h.engine.setModel(s.id, 'new-model');
  assert.equal(s.state.model.modelId, 'new-model');
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 1);
  assert.equal(s.rpc.model.getCurrent.mock.callCount() - currents, 0, 'native result must not depend on stale or failed readback');
  assert.equal(s.rpc.model.list.mock.callCount(), lists, 'successful mutation has no unused inventory dependency');
});

test('model option validation reads its inventory once before switching, never again after success', async t => {
  const h = harness(t);
  const s = await h.load();
  let lists = 0;
  s.rpc.model.list.mock.mockImplementation(async () => {
    if (++lists > 1) throw new Error('inventory must not be reread after mutation');
    return { list: [{ id: 'validated-model', supportedReasoningEfforts: ['high'] }] };
  });
  await h.engine.setModel(s.id, 'validated-model', 'high');
  assert.equal(lists, 1);
  assert.equal(s.state.model.reasoningEffort, 'high');
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 1);
});

for (const failCurrent of [false, true]) {
  test(`mode-selected model returns native outcome without readback (unavailable=${failCurrent})`, async t => {
    const h = harness(t);
    const s = await h.load();
    const lists = s.rpc.model.list.mock.callCount();
    const currents = s.rpc.model.getCurrent.mock.callCount();
    s.rpc.mode.set.mock.mockImplementationOnce(async ({ mode }) => {
      s.state.mode = mode;
      s.state.model.modelId = 'mode-selected';
      return { status: 'applied', modelChanged: true };
    });
    s.rpc.model.list.mock.mockImplementation(async () => { throw new Error('unrelated inventory unavailable'); });
    if (failCurrent) s.rpc.model.getCurrent.mock.mockImplementation(async () => { throw new Error('required current read failed'); });
    s.rpc.mode.get.mock.mockImplementation(async () => { throw new Error('mode read unavailable'); });
    assert.deepEqual(await h.engine.setMode(s.id, 'plan'), { status: 'applied', modelChanged: true });
    assert.equal(s.rpc.model.getCurrent.mock.callCount() - currents, 0);
    assert.equal(s.rpc.model.list.mock.callCount(), lists);
    assert.equal(s.rpc.mode.set.mock.callCount(), 1, 'never replay an applied change after read failure');
  });
}

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
    const savedPreferences = readFileSync(h.prefsFile, 'utf8');
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
    assert.ok(h.events.some(event => event.type === 'agent/status' && event.status === 'failed'));
    assert.equal(readFileSync(h.prefsFile, 'utf8'), savedPreferences);
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
  const replacement = new Engine({ runtime: h.runtime as unknown as EngineRuntime });
  await assert.rejects(replacement.start(), /fatal before replacement engine/);
  await assert.rejects(replacement.newSession(h.cwd), /fatal before replacement engine/);
  assert.equal(replacement.failure, fatal);
  assert.equal(h.runtime.start.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  await promptly(replacement.stop());
});

test('fatal runtime failure rejects a hung native model switch and permits stop before it settles', async t => {

  const h = harness(t);
  const s = await h.load();
  await h.engine.start();
  const readback = deferred<Awaited<ReturnType<Rpc['model']['switchTo']>>>();
  s.rpc.model.switchTo.mock.mockImplementation(() => readback.promise);
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
    assert.equal(snapshot.sessions[0]!.queue, undefined, 'snapshot omits unselected queue bodies');
    snapshot.sessions.length = 0;
    assert.deepEqual((await h.engine.snapshot()), before);
    const meta = (await h.engine.getMeta(s.id))!;
    const beforeMeta = structuredClone(meta);
    meta.queue!.push({ id: 'caller-meta-queue', text: 'not native either' });
    assert.deepEqual((await h.engine.getMeta(s.id)), beforeMeta);
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
  assert.ok(!h.events.some(event => String(event.type) === 'session/notify'));
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
test(`live replies remain in native history during initialization (initialization failure: ${failedInit})`, async t => {
  const h = harness(t);
  const s = await h.seed();
  const metadata = await s.rpc.metadata.snapshot();
  const mode = deferred<typeof metadata>();
  s.rpc.metadata.snapshot.mock.mockImplementationOnce(() => mode.promise);
  const loading = h.engine.reload(s.id);
  const outcome = failedInit ? assert.rejects(loading, /initial mode unavailable/) : loading;
  await nextTurn();
  assert.equal(s.sdk.on.mock.callCount(), 1);
  assert.equal(s.listeners.size, 1);
  s.emit(event('assistant.turn_start', { turnId: 'overlap' }));
  s.emit(assistant('native-event-id', 'canonical-message-id', 'streamed once'));
  s.emit(event('assistant.turn_end', { turnId: 'overlap' }));
  if (failedInit) mode.reject(new Error('initial mode unavailable'));
  else mode.resolve(metadata);
  await outcome;
  await nextTurn();
  assert.equal(h.events.filter(event => String(event.type) === 'session/notify').length, 0);
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
    s.sdk.workspacePath = `/synthetic-native-workspaces/early-${operation}`;
    const observations: import('./engine.ts').NativeObservation[] = [];
    h.engine.onNativeEvent(value => { observations.push(value); }, { types: ['assistant.message_delta'] });
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
    assert.equal(observations.length, 1, 'Early observations are delivered immediately, not buffered');
    assert.equal(Object.hasOwn(observations[0]!, 'workspacePath'), false);
    const lateCallback = [...s.listeners][0]!;
    opened.resolve(s.sdk as unknown as CopilotSession);
    await loading;
    await nextTurn();
    s.emit(event('assistant.message_delta', { messageId: 'bound-answer', deltaContent: 'after SDK return' }));
    assert.equal(observations.at(-1)?.workspacePath, s.sdk.workspacePath);
    assert.equal(s.sdk.on.mock.callCount(), 1, 'Engine must not add a second late subscription');
    assert.equal(s.sdk.getEvents.mock.callCount(), 0);
    assert.equal((await chat(h, s.id, { source: 'live' })).events.find(event => event.id === 'early-final')?.data.content, 'final once');
    assert.equal('fold' in activeState(h, s.id), false);
    assert.equal(serverChatEvents(h).length, 0, 'early display events stay in native history, not SSE');
    assert.equal(h.events.filter(value => String(value.type) === 'session/notify').length, 0);
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
  assert.equal(h.events.filter(value => String(value.type) === 'session/notify').length, 0);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 0);
  assert.equal(s.listeners.size, 0);
});

test('failed initialization metadata preserves native reply history and user acknowledgements', async t => {
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
  assert.equal(h.events.filter(value => String(value.type) === 'session/notify').length, 0);
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
    assert.ok(!h.events.some(event => String(event.type) === 'session/notify'));
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
  native.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'confirmed-model', name: 'Fixture', supportedReasoningEfforts: ['high'], supportedContextTiers: ['default', 'long_context'],
  }] }));
  await h.engine.setModel(id, 'confirmed-model', 'high', 'long_context');
  h.trace.length = 0;
  await h.engine.stop();
  await h.engine.start();
  assert.deepEqual(h.trace, [`close:${id}`, 'stop', 'start']);
  h.rows[0]!.summary = 'current indexed title';
  await h.engine.refreshList();
  const unloaded = (await h.engine.getMeta(id))!;
  assert.equal(unloaded.title, 'current indexed title');
  assert.equal('pinned' in unloaded, false);
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
    assert.equal(h.events.filter(event => event.type === 'agent/status').at(-1)?.status, 'failed');
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

test('in-flight model operations protect otherwise idle sessions until native switch acknowledgement settles', async t => {

  const h = harness(t);
  const s = await h.load();
  const readback = deferred<Awaited<ReturnType<Rpc['model']['switchTo']>>>();
  s.rpc.model.switchTo.mock.mockImplementation(() => readback.promise);
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

test('structured unsuccessful compaction retains its result without fabricating a history reset or retaining progress', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.history.compact.mock.mockImplementation(async () => ({ success: false, tokensRemoved: 0, messagesRemoved: 0 }));
  h.events.length = 0;
  assert.deepEqual(await h.engine.compact(s.id, 'retain decisions'), { success: false, tokensRemoved: 0, messagesRemoved: 0 });
  assert.deepEqual(s.rpc.history.compact.mock.calls[0]!.arguments, [{ customInstructions: 'retain decisions' }]);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  assert.equal((await h.engine.getMeta(s.id))?.loaded, true);
  assert.equal(serverChatEvents(h).length, 0);
  assert.ok(!h.events.some(event => event.type === 'chat/invalidated'));
  assert.equal(s.sdk.send.mock.callCount(), 0);
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
    () => h.engine.prompt(s.id, 'not sent'), () => h.engine.reload(s.id), () => h.engine.deleteSession(s.id),
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

test('interrupt late ACK and old interaction events preserve the queued native turn', async t => {
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
  assert.equal((await h.engine.getMeta(s.id))?.status, 'idle');
  assert.equal(s.state.events.find(event => event.type === 'assistant.message' && event.data.messageId === 'new-answer')?.data.content, 'A finished');
  assert.equal(s.rpc.ui.ephemeralQuery.mock.callCount(), 0);
  assert.equal(s.sdk.send.mock.callCount(), 0);
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
    await assert.rejects(h.engine[action](s.id), /native close failed/);
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
    assert.ok(h.events.some(event => event.type === 'session/patch' && event.sessionId === s.id && event.title === 'callback still attached'));
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
    s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
      id: 'unconfirmed-model', supportedReasoningEfforts: ['high'], billing: { token_prices: { long_context: {} } },
    }] }));
    const before = (await h.engine.getMeta(s.id))!;
    const fail = async () => { throw new Error(`model ${stage} rejected`); };
    if (stage === 'mutation') s.rpc.model.switchTo.mock.mockImplementation(fail);
    else s.rpc.model.getCurrent.mock.mockImplementation(fail);
    h.events.length = 0;
    if (stage === 'mutation') await assert.rejects(h.engine.setModel(s.id, 'unconfirmed-model', 'high', 'long_context'), /model .* rejected/);
    else assert.deepEqual(await h.engine.setModel(s.id, 'unconfirmed-model', 'high', 'long_context'), { modelId: 'unconfirmed-model' });
    if (stage === 'readback') await assert.rejects(h.engine.getMeta(s.id), /model readback rejected/);
    else {
      const after = (await h.engine.getMeta(s.id))!;
      assert.equal(after.currentModelId, before.currentModelId);
      assert.equal(after.currentReasoningEffort, before.currentReasoningEffort);
      assert.equal(after.currentContextTier, before.currentContextTier);
    }
    assert.ok(!h.events.some(event => event.type === 'session/patch' && event.currentModelId === 'unconfirmed-model'));
    if (stage === 'mutation') visibleError(h, s.id, /model .* rejected/);
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
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'alias', supportedReasoningEfforts: ['high'], billing: { token_prices: { long_context: {} } },
  }] }));
  assert.deepEqual(await h.engine.setModel(s.id, 'alias', 'high', 'long_context'), { modelId: 'alias' });
  assert.deepEqual(s.rpc.model.switchTo.mock.calls[0]!.arguments, [{ modelId: 'alias', deferIfModelChangeQueued: true, reasoningEffort: 'high', contextTier: 'long_context' }]);
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'normalized-model');
  assert.equal((await h.engine.getMeta(s.id))?.currentReasoningEffort, 'low');
  assert.equal((await h.engine.getMeta(s.id))?.currentContextTier, 'default');
  s.rpc.mode.get.mock.mockImplementation(async () => 'interactive');
  s.rpc.mode.set.mock.mockImplementation(async () => {
    s.state.mode = 'interactive';
    return { status: 'applied', modelChanged: false };
  });
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
    const summary = (await h.engine.snapshot()).sessions.find(session => session.sessionId === s.id)!;
    const { queue: _queue, availableModels: _models, todo: _todo, ...summaryMeta } = meta;
    assert.deepEqual(summary, summaryMeta);
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
    assert.deepEqual(await h.engine.rewind(s.id, 'keep', true), {
      outcome: mutated ? 'checkpoint-cleanup-failed' : 'truncation-failed',
      restoredFiles: [], skippedFiles: [], ...(mutated ? { eventsRemoved: 1 } : {}),
      error: mutated ? 'checkpoint cleanup failed' : 'unknown event',
    });
    assert.deepEqual(s.rpc.history.rewind.mock.calls[0]!.arguments, [{ eventId: 'keep', mode: 'conversation-and-files' }]);
    const invalidations = h.events.filter(event => event.type === 'chat/invalidated');
    assert.deepEqual(invalidations, mutated ? [{ type: 'chat/invalidated', sessionId: s.id, reason: 'rewind' }] : []);
    assert.equal(serverChatEvents(h).length, 0);
    assert.equal(s.rpc.eventLog.read.mock.callCount(), reads, 'mutation never replays chat on the server');
    if (mutated) {
      assert.deepEqual((await chat(h, s.id, { source: 'live' })).events.map(event => event.id), ['keep']);
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
  assert.deepEqual(await h.engine.rewind(s.id, 'unchanged-conversation', true), {
    outcome: 'rollback-incomplete', restoredFiles: [join(h.cwd, 'native-restored-file')],
    skippedFiles: [], error: 'rollback could not restore one file',
  });
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
  { interval: '1m', prompt: '\ncheck build\n' }, { interval: '1m', prompt: 'check build\r' },
  { interval: '1m', unknown: 'value' },
  { interval: '1m', cron: undefined }, { interval: '1m', tz: undefined }, { interval: '1m', displayPrompt: undefined },
] satisfies Array<Partial<Parameters<Engine['addSchedule']>[1]> & Record<string, unknown>>;
for (const options of invalidSchedules) {
  test(`invalid schedule is rejected before resume or command invocation: ${JSON.stringify(options)}`, async t => {
    const h = harness(t);
    const s = await h.seed();
    t.mock.method(Date, 'now', () => Date.parse(timestamp));
    const before = readFileSync(h.prefsFile, 'utf8');
    await assert.rejects(h.engine.addSchedule(s.id, { prompt: 'check build', ...options }), /unknown|unsupported|required|plain|delay/i);
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
  assert.equal(result.possiblyCreated, true);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  assert.equal((await h.engine.getMeta(s.id))?.scheduleCount, 1);
});

for (const recurring of [false, true]) {
  test(`schedule ${recurring ? 'every' : 'after'} normalizes surrounding whitespace once and preserves a created ID with a warning`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.rpc.commands.invoke.mock.mockImplementation(async ({ input }) => {
      assert.equal(input, '60s check build');
      s.state.schedules = [schedule(92, recurring)];
      return { kind: 'agent-prompt', prompt: 'must not be sent', displayPrompt: 'must not be sent' };
    });
    const result = await h.engine.addSchedule(s.id, { prompt: '  check build  ', interval: '1m', recurring });
    assert.equal(result.entry?.id, 92);
    assert.equal(result.entry?.prompt, 'check build');
    assert.match(result.error!, /created.*unexpected command outcome/);
    assert.equal(result.possiblyCreated, undefined, 'a matching native entry establishes creation');
    assert.equal(s.rpc.commands.invoke.mock.callCount(), 1);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
}

for (const failure of ['acknowledgement', 'readback'] as const) {
  test(`schedule ${failure} failure reports possible creation without replay`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.rpc.commands.invoke.mock.mockImplementation(async () => {
      s.state.schedules = [schedule(93)];
      if (failure === 'acknowledgement') throw new Error('response lost');
      s.rpc.schedule.list.mock.mockImplementation(async () => { throw new Error('readback lost'); });
      return { kind: 'completed' };
    });
    const result = await h.engine.addSchedule(s.id, { prompt: ' check build ', interval: '1m' });
    assert.equal(result.possiblyCreated, true);
    assert.match(result.error!, /may have been created/);
    assert.match(result.error!, /Do not retry automatically/);
    assert.equal(s.state.schedules[0]?.id, 93, 'a response failure must not imply that native creation failed');
    assert.equal(s.rpc.commands.invoke.mock.callCount(), 1);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });
}

test('fatal after schedule dispatch reports possible creation without late readback or retry', async t => {
  const h = harness(t);
  const s = await h.load();
  const command = deferred<Awaited<ReturnType<Rpc['commands']['invoke']>>>();
  s.rpc.commands.invoke.mock.mockImplementation(() => command.promise);
  const creating = h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m' });
  await nextTurn();
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 1);
  const reads = s.rpc.schedule.list.mock.callCount();
  h.runtime.emitFatal(new Error('native connection lost after dispatch'));
  const result = await promptly(creating);
  assert.equal(result.possiblyCreated, true);
  assert.match(result.error!, /may have been created.*native connection lost after dispatch/);
  command.resolve({ kind: 'completed' });
  await nextTurn();
  assert.equal(s.rpc.schedule.list.mock.callCount(), reads);
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 1);
  assert.equal(s.sdk.send.mock.callCount(), 0);
  await h.engine.stop();
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

test('schedule list and panel projections preserve self-paced meaning and ordinary timing metadata', async t => {
  const h = harness(t);
  const s = await h.load();
  const nextRunAt = '2026-09-07T12:01:00.000Z';
  s.state.schedules = [
    { id: 1, prompt: 'choose the next run', displayPrompt: '/review', recurring: true, selfPaced: true, nextRunAt },
    { ...schedule(2), selfPaced: false },
    schedule(3, false),
    { id: 4, prompt: 'calendar', recurring: true, cron: '0 9 * * *', tz: 'Asia/Shanghai', nextRunAt },
    { id: 5, prompt: 'once', recurring: false, at: Date.parse(nextRunAt), nextRunAt },
  ];
  const before = s.rpc.schedule.list.mock.callCount();
  const entries = await h.engine.listSchedules(s.id);
  assert.deepEqual(Intents['schedule/list'].result.parse(JSON.parse(JSON.stringify({ entries }))), {
    entries: s.state.schedules.map(entry => ({ ...entry, nextRunAt: Date.parse(entry.nextRunAt) })),
  });
  assert.equal(entries[0]!.intervalMs, undefined);
  assert.equal(entries[0]!.at, undefined);
  assert.equal(s.rpc.schedule.list.mock.callCount(), before + 1);
  const panels = Intents['session/panels'].result.parse(await h.engine.getPanels(s.id));
  assert.deepEqual(panels.schedules, s.state.schedules.map(entry => ({
    label: entry.displayPrompt || entry.prompt,
    sublabel: entry.selfPaced ? `Self-paced (model-controlled) · next ${nextRunAt}` : nextRunAt,
  })));
  assert.equal(s.rpc.schedule.list.mock.callCount(), before + 2);
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 0);
});

for (const found of [true, false]) {
  test(`native schedule stop ${found ? 'success' : 'not-found'} needs no list, even when listing is broken`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.schedules = found ? [schedule()] : [];
    const before = s.rpc.schedule.list.mock.callCount();
    const listFailure = new Error('schedule list unavailable');
    s.rpc.schedule.list.mock.mockImplementation(async () => { throw listFailure; });
    assert.equal(await h.engine.stopSchedule(s.id, 7), found);
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
    assert.deepEqual(s.rpc.schedule.stop.mock.calls[0]!.arguments, [{ id: 7 }]);
    assert.equal(s.rpc.schedule.list.mock.callCount(), before);
    assert.deepEqual(s.state.schedules, []);
    await assert.rejects(h.engine.listSchedules(s.id), error => error === listFailure);
    assert.equal(s.rpc.schedule.list.mock.callCount(), before + 1);
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 1, 'a subsequent list failure must not retry stop');
  });
}

test('schedule stop stays serialized behind creation and protects lifecycle until the native mutation settles', async t => {
  const h = harness(t);
  const s = await h.load();
  const command = deferred();
  s.rpc.commands.invoke.mock.mockImplementation(async () => {
    await command.promise;
    s.state.schedules = [schedule()];
    return { kind: 'completed' };
  });
  const before = s.rpc.schedule.list.mock.callCount();
  const adding = h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m' });
  await nextTurn();
  const stopping = h.engine.stopSchedule(s.id, 7);
  await nextTurn();
  assert.equal(s.rpc.commands.invoke.mock.callCount(), 1);
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
  assert.equal(s.rpc.schedule.list.mock.callCount(), before + 1);
  for (const operation of [() => h.engine.unload(s.id), () => h.engine.cancel(s.id), () => h.engine.stop()]) {
    await assert.rejects(operation(), protectedWork);
  }
  command.resolve();
  assert.equal((await adding).entry?.id, 7);
  assert.equal(await stopping, true);
  assert.equal(s.rpc.schedule.list.mock.callCount(), before + 2, 'only creation needs before/after identity reads');
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
  assert.deepEqual(s.state.schedules, []);
  assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
  await h.engine.unload(s.id);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`pending schedule stop ${outcome} protects lifecycle and releases the next serialized mutation`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.schedules = [schedule()];
    const stopped = deferred<Awaited<ReturnType<typeof s.rpc.schedule.stop>>>();
    s.rpc.schedule.stop.mock.mockImplementationOnce(() => stopped.promise);
    const first = h.engine.stopSchedule(s.id, 7);
    const firstResult = outcome === 'failure' ? assert.rejects(first, /stop refused/) : first;
    await nextTurn();
    const second = h.engine.stopSchedule(s.id, 7);
    await nextTurn();
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
    for (const operation of [() => h.engine.unload(s.id), () => h.engine.cancel(s.id), () => h.engine.stop()]) {
      await assert.rejects(operation(), protectedWork);
    }
    if (outcome === 'failure') stopped.reject(new Error('stop refused'));
    else {
      s.state.schedules = [];
      stopped.resolve({ entry: schedule() });
    }
    assert.equal(await firstResult, outcome === 'success' ? true : undefined);
    assert.equal(await second, outcome === 'failure');
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 2);
    assert.equal((await h.engine.getMeta(s.id))?.activeOperations, 0);
    await h.engine.unload(s.id);
  });
}

test('fatal runtime failure rejects pending and queued schedule stops without retry or late list read', async t => {
  const h = harness(t);
  const s = await h.load();
  await h.engine.start();
  const stopped = deferred<Awaited<ReturnType<typeof s.rpc.schedule.stop>>>();
  s.rpc.schedule.stop.mock.mockImplementationOnce(() => stopped.promise);
  const first = assert.rejects(h.engine.stopSchedule(s.id, 7), /fatal during schedule stop/);
  await nextTurn();
  const second = assert.rejects(h.engine.stopSchedule(s.id, 8), /fatal during schedule stop/);
  await nextTurn();
  assert.equal(s.rpc.schedule.stop.mock.callCount(), 1);
  const before = nativeCalls(s);
  h.runtime.emitFatal(new Error('fatal during schedule stop'));
  await promptly(Promise.all([first, second]));
  await promptly(h.engine.stop());
  stopped.resolve({ entry: schedule() });
  await nextTurn();
  assert.deepEqual(nativeCalls(s), before);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
});

test('native schedule stop rejection preserves the schedule without persisting local policy and permits unload', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.schedules = [schedule()];
  await h.engine.listSchedules(s.id);
  const before = s.rpc.schedule.list.mock.callCount();
  const failure = new Error('schedule stop refused');
  s.rpc.schedule.stop.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(h.engine.stopSchedule(s.id, 7), error => error === failure);
  assert.equal(s.rpc.schedule.list.mock.callCount(), before);
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

const nativeMcpStatuses = {
  connected: true, failed: true, 'needs-auth': true, pending: true,
  disabled: false, stopped: true, not_configured: false,
} satisfies Record<McpState['servers'][number]['status'], boolean>;

for (const [status, configuredEnabled] of Object.entries(nativeMcpStatuses)) {
  for (const explicitlyDisabled of [false, true]) {
    test(`MCP ${status}, host disabled=${explicitlyDisabled}: list, panels and toggle share native state`, async t => {
      const h = harness(t);
      const s = await h.load();
      const server: McpState['servers'][number] = { name: 'fixture', status: 'connected', source: 'workspace' };
      Reflect.set(server, 'status', status);
      s.state.mcp = mcpState([server], explicitlyDisabled ? ['fixture'] : []);
      if (status === 'stopped') {
        s.state.mcp.host!.mcp3pEnabled = false;
        s.state.mcp.host!.filteredServers = ['fixture'];
      }
      const enabled = configuredEnabled && !explicitlyDisabled;
      const inventory = await h.engine.listSessionMcp(s.id);
      assert.deepEqual(inventory.servers, [{
        name: 'fixture', detail: 'workspace', status, enabled, error: undefined,
      }]);
      assert.deepEqual((await h.engine.getPanels(s.id)).mcpServers, [{ label: 'fixture', sublabel: status, enabled }]);
      assert.equal(s.rpc.mcp.enable.mock.callCount(), 0, 'reading must not initiate authentication or connection work');
      assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
      assert.equal(s.rpc.mcp.reload.mock.callCount(), 0);
      for (const desiredEnabled of [true, false]) {
        const result = await h.engine.toggleSessionMcp(s.id, 'fixture', desiredEnabled);
        assert.equal(result.enabled, enabled);
        assert.equal(result.status, status);
        assert.equal(result.operation.status, status);
        const applied = enabled === desiredEnabled && status !== 'not_configured'
          && (!desiredEnabled || status === 'connected');
        assert.equal(result.ok, applied);
        assert.equal(result.applied, applied);
        assert.deepEqual((await h.engine.listSessionMcp(s.id)).servers, inventory.servers);
        assert.deepEqual((await h.engine.getPanels(s.id)).mcpServers, [{ label: 'fixture', sublabel: status, enabled }]);
      }
      assert.equal(s.rpc.mcp.reload.mock.callCount(), 0);
      assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 0);
      assert.equal(h.prefs().mcpBySession, undefined);
    });
  }
}

for (const status of ['future-status', 'needs_auth', 'unloaded', undefined, null]) {
  test(`MCP unknown native status ${String(status)} fails read and mutation preflight explicitly`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
    Reflect.set(s.state.mcp.servers[0]!, 'status', status);
    for (const read of [() => h.engine.listSessionMcp(s.id), () => h.engine.getPanels(s.id)]) {
      await assert.rejects(read(), /Native MCP state is unconfirmed for fixture: unknown status/);
    }
    await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', true), /unconfirmed.*unknown status/);
    assert.equal(s.rpc.mcp.enable.mock.callCount(), 0);
    assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
    assert.equal(s.rpc.mcp.reload.mock.callCount(), 0);
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
  });
}

for (const rejected of [false, true]) {
  for (const missing of ['status', 'server', 'host'] as const) {
    test(`MCP ${rejected ? 'rejected' : 'acknowledged'} mutation with unconfirmed ${missing} readback cannot return success`, async t => {
      const h = harness(t);
      const s = await h.load();
      s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
      s.rpc.mcp.enable.mock.mockImplementation(async () => {
        if (missing === 'status') Reflect.set(s.state.mcp.servers[0]!, 'status', 'future-status');
        if (missing === 'server') s.state.mcp.servers = [];
        if (missing === 'host') delete s.state.mcp.host;
        if (s.state.mcp.host) s.state.mcp.host.pendingConnections = ['fixture'];
        if (rejected) throw new Error('native enable rejected');
      });
      await assert.rejects(h.engine.toggleSessionMcp(s.id, 'fixture', true), /MCP state is unknown.*unconfirmed/);
      assert.equal(s.rpc.mcp.enable.mock.callCount(), 1);
      assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
      await assert.rejects(h.engine.unload(s.id), /protected|MCP|unconfirmed/i);
      assert.equal(h.runtime.closeSession.mock.callCount(), 0);
      s.state.mcp = mcpState([{ name: 'fixture', status: 'disabled' }], ['fixture']);
      await h.engine.unload(s.id);
      assert.equal(h.runtime.closeSession.mock.callCount(), 1);
    });
  }
}

for (const status of [...Object.keys(nativeMcpStatuses), 'future-status']) {
  test(`MCP reload confirms ${status} with the same status adapter and keeps lifecycle protection`, async t => {
    const h = harness(t);
    const s = await h.load();
    s.state.mcp = mcpState([{ name: 'fixture', status: 'connected' }]);
    Reflect.set(s.state.mcp.servers[0]!, 'status', status);
    if (status === 'not_configured') s.state.mcp.host!.disabledServers = ['fixture'];
    const resumes = h.runtime.resumeSession.mock.callCount();
    if (status === 'connected' || status === 'disabled') {
      assert.deepEqual(await h.engine.reloadSessionMcp(s.id), { reconnected: status === 'connected' ? 1 : 0 });
    } else {
      await assert.rejects(h.engine.reloadSessionMcp(s.id), /MCP connections not confirmed|MCP state is unconfirmed/);
    }
    assert.equal(s.rpc.mcp.reload.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
    assert.equal((await h.engine.getMeta(s.id))?.activeMcpOperations, 0);
  });
}

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
    assert.equal(result.status, 'failed', 'host disablement must not replace the native connection status');
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
      [[{ projectPaths: [resolve(directory)] }]]);
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
  assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls[0]!.arguments, [{ projectPaths: [h.cwd] }]);
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
    assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls[0]!.arguments, [{ projectPaths: [resolve(homedir())] }]);
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
  assert.deepEqual(h.runtime.rpc.skills.discover.mock.calls[0]!.arguments, [{ projectPaths: [h.cwd] }]);
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
    [[{ projectPaths: [resolve(homedir())] }]]);
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
    assert.deepEqual(h.events, []);
    assert.deepEqual((await h.engine.snapshot()), snapshot);
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
  assert.deepEqual(h.events, []);
  assert.deepEqual((await h.engine.getMeta(s.id)), before);
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

test('a failed live chat read reconciles silent native unload once without resuming or aborting the model', async t => {
  const h = harness(t);
  const s = await h.load();
  const probes = h.runtime.isSessionLive.mock.callCount();
  const resumes = h.runtime.resumeSession.mock.callCount();
  h.runtime.expire(s.id, false);
  s.rpc.eventLog.read.mock.mockImplementationOnce(async () => { throw new Error('native session no longer exists'); });
  await assert.rejects(chat(h, s.id, { source: 'live', cursor: 'native-boundary' }), {
    code: 'SESSION_UNLOADED', statusCode: 409,
  });
  assert.equal(h.runtime.isSessionLive.mock.callCount(), probes + 1);
  assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
  assert.equal(s.rpc.eventLog.read.mock.callCount(), 1);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0);
  assert.equal(activeState(h, s.id), undefined);
});

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
    assert.equal(sessionMetaBusy((await h.engine.getMeta(s.id))!), false, 'the diagnostic snapshot remains idle');
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

test('legacy preferences remain untouched and cannot hide or decorate native sessions', async t => {
  const h = harness(t, { prefs: {
    trashed: { legacy: { at: '2026-09-01', reason: 'old soft deletion' } },
    trashedMeta: { legacy: { title: 'obsolete' } },
    pinnedSessions: ['legacy'],
    inbox: { revision: 1, counter: 1, sessions: {
      legacy: { attention: 'ready', attnId: 1, seenId: 0, eventId: 'legacy-reply' },
    } },
    workerMetadata: { legacy: { opaque: true } },
  } });
  const original = readFileSync(h.prefsFile, 'utf8');
  await h.seed('legacy');
  const meta = (await h.engine.getMeta('legacy'))!;
  assert.equal(meta.loaded, false);
  assert.equal(meta.title, 'indexed title');
  assert.equal('pinned' in meta, false);
  assert.equal('attention' in meta, false);
  assert.equal((await h.engine.listLive()).some(row => row.sessionId === 'legacy'), true);
  assert.equal(activeState(h, 'legacy'), undefined);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), original);
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
  assert.equal((await h.engine.rewind(s.id, 'boundary', true)).outcome, 'files-rolled-back');
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
  assert.deepEqual(h.prefs(), legacy, 'retired choices remain inert rather than being rewritten or replayed');
  assert.equal(s.rpc.skills.disable.mock.callCount(), 0);
  assert.equal(s.rpc.mcp.disable.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.config.list.mock.callCount(), 0);
  assert.equal(h.runtime.rpc.mcp.config.disable.mock.callCount(), 0);
  h.userSettings.settings.disabledSkills!.value = ['changed-natively'];
  await h.engine.unload(s.id);
  await h.engine.reload(s.id);
  assert.deepEqual(h.configs.get(s.id)!.disabledSkills, ['changed-natively'], 'cold resume reads current native global choices');
  assert.deepEqual(h.prefs(), legacy);
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
      await assert.rejects(h.engine.deleteSession(s.id), protectedWork);
      assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
      s.state.activeWork = false;
    }
    await h.engine.deleteSession(s.id);
    assert.equal((await h.engine.getMeta(s.id)), null);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 1);
    assert.equal(h.runtime.closeSession.mock.callCount(), loaded ? 1 : 0);
    assert.equal(h.runtime.resumeSession.mock.callCount(), resumes);
    assert.equal(s.rpc.schedule.list.mock.callCount(), reads, 'teardown checks work, not future timers');
    assert.equal(s.rpc.schedule.stop.mock.callCount(), 0);
    assert.equal(s.sdk.abort.mock.callCount(), 0);
    assert.deepEqual(h.prefs().scheduledSessions, { 'legacy-scheduled': 999 });
  });
}

test('native deletion retains idle guards without an extra confirmation or modifying external preferences', async t => {
  const h = harness(t, { prefs: { preserved: 'external capability data' } });
  const original = readFileSync(h.prefsFile, 'utf8');
  const s = await h.load();
  await finishReply(s, '可删除的测试回复', 'delete');
  assert.equal(Intents['session/delete'].body.safeParse({ sessionId: s.id }).success, true);
  s.state.processing = true;
  await assert.rejects(h.engine.deleteSession(s.id), protectedWork);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  assert.equal(h.runtime.closeSession.mock.callCount(), 0);
  s.state.processing = false;
  await finishReply(s, '工作完成，可以删除', 'delete-after-work');
  h.runtime.closeSession.mock.mockImplementationOnce(async () => { throw new Error('close failed'); });
  await assert.rejects(h.engine.deleteSession(s.id), /close failed/);
  assert.equal(h.runtime.deleteSession.mock.callCount(), 0);
  h.runtime.deleteSession.mock.mockImplementationOnce(async () => { throw new Error('native delete failed'); });
  await assert.rejects(h.engine.deleteSession(s.id), /native delete failed/);
  await h.engine.deleteSession(s.id);
  assert.equal((await h.engine.getMeta(s.id)), null);
  assert.equal(activeState(h, s.id), undefined);
  assert.equal(readFileSync(h.prefsFile, 'utf8'), original);
  assert.ok(h.trace.indexOf(`close:${s.id}`) < h.trace.indexOf(`delete:${s.id}`));
  const removed = h.events.findLast(event => event.type === 'session/removed');
  assert.deepEqual(removed, { type: 'session/removed', sessionId: s.id });
  const deleting = await h.load();
  await h.engine.unload(deleting.id);
  const deletion = deferred();
  h.runtime.deleteSession.mock.mockImplementationOnce(() => deletion.promise);
  const removing = h.engine.deleteSession(deleting.id);
  await nextTurn();
  await assert.rejects(h.engine.stop(), protectedWork);
  deletion.resolve();
  await removing;
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
  assert.deepEqual(h.prefs().mcpDefaultOn, ['fixture'], 'retired records cannot override native configuration and are not rewritten');
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
  assert.equal(coreCapabilities.deleteSession, true);
  assert.equal('purgeSession' in coreCapabilities, false);
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

test('thin native session models expose fresh capabilities and complete selections do not backfill omitted options', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{ id: 'native-model', name: 'Native' }] }));
  h.runtime.models.mock.mockImplementation(async () => [{
    modelId: 'native-model', name: 'Global', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'low', supportsLongContext: true,
  }, { modelId: 'not-allowed', name: 'Not allowed' }]);
  s.state.model = { modelId: 'native-model' };
  const before = (await h.engine.getMeta(s.id))!;
  assert.equal(before.currentReasoningEffort, null);
  assert.equal(before.currentContextTier, null);
  assert.deepEqual(before.availableModels, [{
    modelId: 'native-model', name: 'Native', supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'low', supportsLongContext: true,
  }]);
  const catalogReads = h.runtime.models.mock.callCount();
  const snapshot = await h.engine.snapshot();
  assert.equal(h.runtime.models.mock.callCount() - catalogReads, 1, 'One catalog belongs to this snapshot request, not a retained cache');
  assert.equal(snapshot.sessions.find(row => row.sessionId === s.id)?.availableModels, undefined,
    'Summary snapshots do not request model option lists');
  const listReads = s.rpc.model.list.mock.callCount();
  const catalogsBeforeNarrowRead = h.runtime.models.mock.callCount();
  await h.engine.getResources(s.id, ['control']);
  assert.equal(s.rpc.model.list.mock.callCount(), listReads);
  assert.equal(h.runtime.models.mock.callCount(), catalogsBeforeNarrowRead);
  assert.deepEqual((await h.engine.getResources(s.id, ['models']))?.availableModels, before.availableModels);
  await h.engine.setModel(s.id, 'native-model', 'high', 'long_context');
  const after = (await h.engine.getMeta(s.id))!;
  assert.equal(after.currentReasoningEffort, 'high');
  assert.equal(after.currentContextTier, 'long_context');
  await h.engine.setModel(s.id, 'native-model', 'low');
  assert.deepEqual(s.rpc.model.switchTo.mock.calls[1]!.arguments, [{
    modelId: 'native-model', deferIfModelChangeQueued: true, reasoningEffort: 'low',
  }]);
  await h.engine.setModel(s.id, 'native-model', undefined, 'default');
  assert.deepEqual(s.rpc.model.switchTo.mock.calls[2]!.arguments, [{
    modelId: 'native-model', deferIfModelChangeQueued: true, contextTier: 'default',
  }]);
  s.state.model.contextTier = 'long_context';
  await assert.rejects(h.engine.setModel(s.id, 'native-model', 'invented'), /does not list reasoning/);
  await assert.rejects(h.engine.setModel(s.id, 'not-allowed', undefined, 'long_context'), /does not list long-context/);
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 3);
  h.runtime.models.mock.mockImplementation(async () => [{
    modelId: 'native-model', name: 'Global', supportedReasoningEfforts: [], supportsLongContext: false,
  }]);
  const changed = (await h.engine.getMeta(s.id))!;
  assert.deepEqual(changed.availableModels?.[0]?.supportedReasoningEfforts, []);
  assert.equal(changed.availableModels?.[0]?.supportsLongContext, false);
  assert.equal(changed.currentContextTier, 'long_context', 'readback is not rewritten from capability changes');
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('a deferred model change leaves current options native-owned without a false readback failure', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'native-model', supportedReasoningEfforts: ['high'], supportsLongContext: true,
  }] }));
  s.rpc.model.switchTo.mock.mockImplementation(async () => ({ modelId: 'native-model', status: 'deferred', deferred: true }));
  await h.engine.setModel(s.id, 'native-model', 'high', 'long_context');
  const current = (await h.engine.getMeta(s.id))!;
  assert.equal(current.currentReasoningEffort, 'medium');
  assert.equal(current.currentContextTier, 'default');
});

test('provider context tiers without pricing drive both metadata and model-setting validation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'provider/model', supportedContextTiers: ['default', 'long_context'],
  }, { id: 'provider/basic', supportedContextTiers: ['default'] }] }));
  const meta = (await h.engine.getMeta(s.id))!;
  assert.equal(meta.availableModels?.find(row => row.modelId === 'provider/model')?.supportsLongContext, true);
  assert.equal(meta.availableModels?.find(row => row.modelId === 'provider/basic')?.supportsLongContext, false);
  await h.engine.setModel(s.id, 'provider/model', undefined, 'long_context');
  assert.equal((await h.engine.getMeta(s.id))?.currentContextTier, 'long_context');
  await assert.rejects(h.engine.setModel(s.id, 'provider/basic', undefined, 'long_context'), /does not list long-context/);
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 1);
  assert.equal(s.sdk.send.mock.callCount(), 0);
});

test('user model choices join the native FIFO even when the turn ended before queued changes drain', async t => {
  for (const status of ['queued', 'deferred'] as const) {
    await t.test(status, async t => {
      const h = harness(t);
      const s = await h.load();
      type Switch = Parameters<Rpc['model']['switchTo']>[0];
      const queue: Switch[] = [{ modelId: 'older-A' }];
      const apply = (options: Switch) => {
        s.state.model = { modelId: options.modelId, reasoningEffort: options.reasoningEffort, contextTier: options.contextTier };
      };
      // Public switchTo contract: without the opt-in an idle switch applies
      // immediately, allowing the already queued A to overwrite the newer B.
      s.rpc.model.switchTo.mock.mockImplementation(async options => {
        if (options.deferIfModelChangeQueued && queue.length) {
          queue.push(options);
          return { modelId: options.modelId, status, deferred: status === 'deferred' };
        }
        apply(options);
        return { modelId: options.modelId, status: 'applied' };
      });
      await h.engine.setModel(s.id, 'newer-B');
      assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'native-model', 'Accepted is not applied');
      assert.deepEqual(queue.map(item => item.modelId), ['older-A', 'newer-B']);
      apply(queue.shift()!);
      assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'older-A');
      apply(queue.shift()!);
      assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'newer-B');
      assert.equal(s.rpc.model.switchTo.mock.callCount(), 1, 'The host does not replay or drain native choices');
      assert.equal(s.sdk.send.mock.callCount(), 0);
    });
  }
});

test('concurrent complete model selections serialize acknowledgements without backfilling current options', async t => {
  const h = harness(t);
  const s = await h.load();
  const held = deferred<void>();
  const started = deferred<void>();
  s.rpc.model.list.mock.mockImplementation(async () => {
    started.resolve();
    await held.promise;
    return { list: [{
      id: 'native-model', supportedReasoningEfforts: ['low', 'high'], supportsLongContext: true,
    }] };
  });
  const effort = h.engine.setModel(s.id, 'native-model', 'high', 'default');
  await started.promise;
  const tier = h.engine.setModel(s.id, 'native-model', 'high', 'long_context');
  await nextTurn();
  assert.equal(s.rpc.model.switchTo.mock.callCount(), 0);
  held.resolve();
  await Promise.all([effort, tier]);
  const current = (await h.engine.getMeta(s.id))!;
  assert.equal(current.currentReasoningEffort, 'high');
  assert.equal(current.currentContextTier, 'long_context');
});

test('queued native full configs never copy stale current settings and omitted fields remain omitted', async t => {
  const h = harness(t);
  const s = await h.load();
  s.state.model = { modelId: 'native-model', reasoningEffort: 'low', contextTier: 'default' };
  s.rpc.model.list.mock.mockImplementation(async () => ({ list: [{
    id: 'native-model', supportedReasoningEfforts: ['low', 'high'], supportsLongContext: true,
  }] }));
  const queue: Parameters<Rpc['model']['switchTo']>[0][] = [];
  s.rpc.model.switchTo.mock.mockImplementation(async options => {
    queue.push(options);
    return { deferred: true };
  });
  const currents = s.rpc.model.getCurrent.mock.callCount();
  for (const result of await Promise.all([
    h.engine.setModel(s.id, 'native-model', 'high', 'default'),
    h.engine.setModel(s.id, 'native-model', 'high', 'long_context'),
  ])) assert.deepEqual(result, { deferred: true });
  assert.deepEqual(queue, [
    { modelId: 'native-model', reasoningEffort: 'high', contextTier: 'default', deferIfModelChangeQueued: true },
    { modelId: 'native-model', reasoningEffort: 'high', contextTier: 'long_context', deferIfModelChangeQueued: true },
  ]);
  assert.equal(s.rpc.model.getCurrent.mock.callCount(), currents);
  for (const options of queue) s.state.model = {
    modelId: options.modelId, reasoningEffort: options.reasoningEffort, contextTier: options.contextTier,
  };
  assert.equal((await h.engine.getMeta(s.id))?.currentReasoningEffort, 'high');
  assert.equal((await h.engine.getMeta(s.id))?.currentContextTier, 'long_context');
  await h.engine.setModel(s.id, 'native-model', undefined, 'default');
  await h.engine.setModel(s.id, 'native-model');
  assert.deepEqual(queue.slice(2), [
    { modelId: 'native-model', contextTier: 'default', deferIfModelChangeQueued: true },
    { modelId: 'native-model', deferIfModelChangeQueued: true },
  ]);
  assert.equal(s.sdk.send.mock.callCount(), 0);
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

  const results = await Promise.all([
    h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1m' }),
    h.engine.addSchedule(s.id, { prompt: 'check build', interval: '1h' }),
  ]);
  assert.deepEqual(results.map(result => [result.entry?.id, result.entry?.intervalMs]), [[1, 60_000], [2, 3_600_000]]);
});

test('structured native model and mode refusals retain their full outcomes without host continuation', async t => {
  const h = harness(t);
  const s = await h.load();
  s.rpc.model.switchTo.mock.mockImplementation(async () => ({
    modelId: 'native-model', status: 'rejected', message: 'model is unavailable',
  }));
  assert.deepEqual(await h.engine.setModel(s.id, 'unavailable'), {
    modelId: 'native-model', status: 'rejected', message: 'model is unavailable',
  });

  test('all native model outcomes survive failed readbacks without fabricated application or retry', async t => {
    const h = harness(t);
    const s = await h.load();
    const outcomes: Awaited<ReturnType<Rpc['model']['switchTo']>>[] = [
      {}, { modelId: 'native-model' }, { status: 'future-outcome' },
      { status: 'applied', modelId: 'native-model', modelState: {
        modelId: 'native-model', reasoningEffort: 'high', contextTier: 'long_context',
      }, persistenceError: 'setting could not be written', warning: 'native warning',
      message: 'Applied in memory only', deprecationWarnings: ['native deprecation'] },
      { status: 'unchanged' }, { status: 'queued' }, { status: 'deferred', deferred: true },
      { status: 'confirmation_required', confirmation: {
        targetModelDisplayName: 'Small native model', currentTokens: 200, targetLimit: 100,
      } },
    ];
    const reads = s.rpc.model.getCurrent.mock.callCount();
    s.rpc.model.getCurrent.mock.mockImplementation(async () => { throw new Error('readback unavailable'); });
    for (const outcome of outcomes) {
      s.rpc.model.switchTo.mock.mockImplementationOnce(async () => outcome);
      assert.deepEqual(await h.engine.setModel(s.id, 'native-model'), outcome);
    }
    assert.equal(s.rpc.model.getCurrent.mock.callCount(), reads);
    assert.equal(s.rpc.model.switchTo.mock.callCount(), outcomes.length);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });

  test('mode follow-up flags, confirmation and warnings survive without readback or automatic host actions', async t => {
    const h = harness(t);
    const s = await h.load();
    const outcome: Awaited<ReturnType<Rpc['mode']['set']>> = {
      status: 'applied', modelChanged: true, deferImplementation: true, armInteractiveContinuation: true,
      confirmation: { targetModelDisplayName: 'Native plan model', currentTokens: 200, targetLimit: 100 },
      message: 'Native host action required', warning: 'Native warning', deprecationWarnings: ['native deprecation'],
    };
    s.rpc.mode.set.mock.mockImplementationOnce(async () => outcome);
    s.rpc.mode.get.mock.mockImplementation(async () => { throw new Error('mode readback unavailable'); });
    s.rpc.model.getCurrent.mock.mockImplementation(async () => { throw new Error('model readback unavailable'); });
    assert.deepEqual(await h.engine.setMode(s.id, 'plan'), outcome);
    assert.equal(s.rpc.mode.set.mock.callCount(), 1);
    assert.equal(s.sdk.send.mock.callCount(), 0);
  });

  test('native deletion never loads missing sessions', async t => {
    const h = harness(t);
    const s = await h.seed();
    await h.engine.deleteSession(s.id);
    assert.deepEqual(h.runtime.deleteSession.mock.calls[0]!.arguments, [s.id]);
    assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
    await assert.rejects(h.engine.deleteSession('missing-owned-fixture'), /Unknown session/);
    assert.equal(h.runtime.deleteSession.mock.callCount(), 1);
  });
  assert.equal((await h.engine.getMeta(s.id))?.currentModelId, 'native-model');
  s.rpc.mode.set.mock.mockImplementation(async () => ({
    status: 'cancelled', modelChanged: false, deferImplementation: true,
  }));
  assert.deepEqual(await h.engine.setMode(s.id, 'plan'), {
    status: 'cancelled', modelChanged: false, deferImplementation: true,
  });
  assert.equal(s.sdk.send.mock.callCount(), 0);
});
