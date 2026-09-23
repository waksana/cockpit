import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  CopilotSession, SessionConfig, SessionMetadata, SessionEvent,
  ExitPlanModeResult, ElicitationResult,
} from '@github/copilot-sdk';
import type {
  AgentStatus, DirListing, ExitPlanModeAction,
  McpServerGlobal, McpServerSession, McpToggleOperation, McpToggleResult,
  ModelOption, ScheduleEntry, ServerEvent, SessionMeta, SessionPanels,
  SessionBrief, SessionPlan, Snapshot, TodoItem, IntentResult, NativeChatPage,
  MetaResource, SessionResource, SessionProjection, PanelSection, PanelItem, NativeChatEvent,
  RoleSelection, RoleReadiness, RoleAdditionResult, SkillSession, ResourcePreparationResult,
  SessionControls, SessionControlAction, SessionControlResult, QueuedItem,
} from '@cockpit/protocol';
import { NativeChatRead, SessionActivity, SessionUsage, MetaResource as MetaResources, cleanSessionTitle, SessionResourcesPrepare, RESOURCE_PREPARATION_ERROR_LIMIT, SKILL_NOT_FOUND } from '@cockpit/protocol';
import { NativeModelSwitchResult, NativeModeSetResult, NativeCompactResult, NativeRewindResult } from '@cockpit/protocol';
import { OfficialRuntime, sessionModelOptions } from './runtime.ts';
import { normalizeEvent, type RuntimeAttachment } from './sdk-types.ts';
import { readNativeChat } from './native-chat.ts';
import { describeMcpServer, mcpConnection, redactMcpConfig } from './mcp-config.ts';
import { validateForkHistory } from './fork.ts';
import type { RoleProvider, RoleAssembly } from './roles.ts';

export type EngineRuntime = Pick<OfficialRuntime,
  'start' | 'models' | 'listSessions' | 'createSession' | 'resumeSession' |
  'closeSession' | 'deleteSession' | 'getAuthStatus' | 'stop' | 'rpc' |
  'isSessionLive' | 'onSessionClosed' | 'onFatal' | 'failure' | 'getSessionMetadata'>;

export interface NativeObservation {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly workspacePath?: string | null;
  readonly event: NativeChatEvent;
}

// Parent transports can expose these limits without inventing runtime support.
export const coreCapabilities = {
  forkSession: {
    native: true, source: 'loaded-idle', boundary: 'before-root-user-event',
    schedules: false, workspaceIsolation: false, childLoaded: false,
  },
  deleteSession: true,
  mcpReload: 'native-session-connections',
  planSupersede: 'pending-plan-feedback',
  elicitationAccept: 'unstructured-only',
  schedule: {
    intervalPattern: '^[1-9]\\d*(s|m|h|d)$', minSeconds: 1, maxSeconds: 86400,
    at: true, recurring: true, recurringAt: false, cron: false, tz: false, displayPrompt: false,
    prompt: 'single-line; no command flags or leading slash',
  },
} as const;

type LiveMeta = SessionMeta & { activeOperations?: number; nativeProcessing?: boolean };
type UserInputResponse = Awaited<ReturnType<NonNullable<SessionConfig['onUserInputRequest']>>>;
type DecisionKind = 'ask' | 'planRequest' | 'elicitation';
interface Decision {
  kind: DecisionKind;
  epoch: number;
  interactionId?: string;
  value: NonNullable<SessionMeta[DecisionKind]>;
  answer: (value: unknown) => void;
  reject: (error: Error) => void;
  validate?: (value: unknown) => void;
}
type ResourceValues = {
  todos: Awaited<ReturnType<CopilotSession['rpc']['plan']['readSqlTodos']>>;
  schedule: Awaited<ReturnType<CopilotSession['rpc']['schedule']['list']>>;
  mcp: Awaited<ReturnType<CopilotSession['rpc']['mcp']['list']>>;
};
type Resource = keyof ResourceValues;
const summaryResources: MetaResource[] = ['identity', 'control', 'model', 'mode', 'schedule'];

function completeMeta(meta: SessionProjection): SessionMeta {
  const { title, cwd, lastActivity, status, ask } = meta;
  if (title === undefined || cwd === undefined || lastActivity === undefined || status === undefined || ask === undefined) {
    throw new Error('Identity and control resources are required for a complete session summary');
  }
  return { ...meta, title, cwd, lastActivity, status, ask };
}
interface State {
  roleAssembly?: RoleAssembly;
  creationSubmitted?: boolean;
  id: string;
  observedCwd?: string | null;
  sdk: CopilotSession | null;
  controlToken?: string;
  controlGate: Promise<void>;
  observedCompaction: boolean;
  manualCompactions: number;
  load?: Promise<void>;
  closing: boolean;
  cancelling?: Promise<void>;
  interrupting?: Promise<IntentResult<'session/interrupt'>>;
  interruptTurn?: { epoch: number; interactionId?: string; decisions: Map<string, Decision> };
  turnEpoch: number;
  interruptedEpoch?: number;
  interactionId?: string;
  operations: number;
  mcpOperations: number;
  sends: number;
  accepted: Set<string>;
  steeringAccepted: Set<string>;
  decisions: Map<string, Decision>;
  eventOwner?: { closed?: WeakSet<CopilotSession>; contextChanged?: boolean };
  sendReceipts: Set<string>;
  revision: number;
  activityRevision: number;
  scheduleGate: Promise<void>;
  resourceWrites: Map<SessionResource, number>;
  pendingInvalidations: Set<SessionResource>;
  modelGate: Promise<void>;
}

const activeTask = (status: string) => !['idle', 'completed', 'failed', 'cancelled'].includes(status);
const planActions = new Set<string>(['exit_only', 'interactive', 'autopilot', 'autopilot_fleet']);
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const unsupported = (what: string): never => { throw new Error(`${what} is unsupported by this public SDK adapter; nothing was changed`); };

const controlEvents = new Set([
  'user.message', 'assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'abort',
  'tool.execution_start', 'tool.execution_complete',
  'subagent.started', 'subagent.completed', 'subagent.failed',
]);

class SkillNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = SKILL_NOT_FOUND;

  constructor() {
    super('Unknown skill in this working directory');
  }
}

class SessionUnloadedError extends Error {
  readonly statusCode = 409;
  readonly code = 'SESSION_UNLOADED';

  constructor() {
    super('Native session data is unavailable while unloaded; explicitly resume the session first');
  }
}

async function settled<T extends readonly unknown[]>(work: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  // Teardown cannot race a sibling RPC that is still settling after another fails.
  const results = await Promise.allSettled(work);
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

function stateFor(id: string): State {
  return {
    id, sdk: null, closing: false, operations: 0, mcpOperations: 0, sends: 0,
    accepted: new Set(), steeringAccepted: new Set(), decisions: new Map(), sendReceipts: new Set(),
    revision: 0, activityRevision: 0, turnEpoch: 0,
    scheduleGate: Promise.resolve(),
    resourceWrites: new Map(), pendingInvalidations: new Set(),
    modelGate: Promise.resolve(),
    controlGate: Promise.resolve(), observedCompaction: false, manualCompactions: 0,
  };
}

export class Engine {
  private roles?: RoleProvider;
  setRoleProvider(roles: RoleProvider): void {
    if (this.started || this.sessions.size) throw new Error('Roles must be configured before native startup');
    this.roles = roles;
  }
  listRoles() { return this.roles?.list() ?? []; }

  private roleState(id: string, st?: State, roles = this.roles?.read(id) ?? []) {
    const appliedRoles = st?.sdk ? st.roleAssembly?.roles ?? [] : [];
    const rolesNeedReload = !!st?.sdk && (roles.length !== appliedRoles.length
      || roles.some(role => !appliedRoles.some(applied =>
        applied.moduleId === role.moduleId && applied.roleId === role.roleId)));
    return { roles, appliedRoles, rolesNeedReload };
  }

  async roleReadiness(id: string, requested?: RoleSelection[]): Promise<RoleReadiness> {
    let roles = this.roles?.read(id) ?? [];
    const st = this.sessions.get(id);
    const result: RoleReadiness = { sessionId: id, roles, appliedRoles: [], rolesNeedReload: false, loaded: false, ready: false, reasons: [] };
    try {
      if (!await this.untilFatal(() => this.runtime.getSessionMetadata(id)) && !st?.sdk) {
        result.reasons.push('Session does not exist'); return result;
      }
      const sdk = st && await this.liveSession(st);
      result.loaded = !!sdk;
      roles = this.roles?.read(id) ?? [];
      Object.assign(result, this.roleState(id, st, roles));
      if (!sdk || !st) { result.reasons.push('Session is unloaded'); return result; }
      if (st.closing || st.load) { result.reasons.push('Session is loading or closing'); return result; }
      if (result.rolesNeedReload) {
        result.reasons.push('Saved roles differ from this native handle; explicitly reload when idle to apply them');
        return result;
      }
      const selected = requested ?? roles;
      if (!selected.length) result.reasons.push('No roles selected');
      for (const role of selected) {
        if (!roles.some(value => value.moduleId === role.moduleId && value.roleId === role.roleId)) {
          result.reasons.push(`Role not selected: ${role.moduleId}/${role.roleId}`);
        }
      }
      const applied = st.roleAssembly;
      if (!this.roles || !applied) result.reasons.push('Role assembly was not applied to this native handle');
      if (result.reasons.length) return result;
      const assembly = await this.roles!.assemble(id, roles);
      if (assembly.fingerprint !== applied!.fingerprint) result.reasons.push('Current role resources differ from this native handle');
      const required = await this.roles!.assemble(id, selected);
      const [skills, mcp, tools] = await this.withSession(st, sdk, () => settled([
        sdk.rpc.skills.list(), sdk.rpc.mcp.list(), sdk.rpc.tools.getCurrentMetadata(),
      ] as const));
      if (tools.tools === null) {
        result.reasons.push('Native tool metadata is uninitialized; explicitly call session/tools-initialize when idle, then check readiness again');
      }
      for (const skill of required.skills) {
        const expected = applied!.skills.find(value => value.path === skill.path);
        if (!skills.skills.some(value => value.name === expected?.name && value.enabled && value.path === skill.path)) {
          result.reasons.push(`Role skill is unavailable or disabled: ${expected?.name ?? skill.name}`);
        }
      }
      for (const [name, config] of Object.entries(required.config.mcpServers ?? {})) {
        const server = mcp.servers.find(value => value.name === name);
        if (!server || server.status !== 'connected' || !mcp.host?.mcp3pEnabled
          || mcp.host.disabledServers.includes(name) || mcp.host.filteredServers.includes(name)) {
          result.reasons.push(`Role MCP is not connected: ${name}`);
        }
        if (tools.tools === null) continue;
        const offered = tools.tools.filter(tool => tool.mcpServerName === name);
        for (const tool of config.tools ?? []) {
          if (tool === '*' ? !offered.length : !offered.some(value => value.mcpToolName === tool)) {
            result.reasons.push(`Role MCP tool is not currently offered: ${name}/${tool}`);
          }
        }
      }
      const current = await this.liveSession(st);
      result.loaded = !!current;
      Object.assign(result, this.roleState(id, st));
      if (result.rolesNeedReload) result.reasons.push('Saved roles changed during readiness; reload is required');
      if (current !== sdk || st.closing || st.roleAssembly !== applied) {
        result.reasons.push('Native session changed or is closing');
      }
    } catch (error) {
      result.loaded = !!st?.sdk;
      Object.assign(result, this.roleState(id, st, roles));
      result.reasons.push(`Readiness unconfirmed: ${messageOf(error)}`);
    }
    result.ready = result.reasons.length === 0;
    return result;
  }

  async addRoles(id: string, additions: RoleSelection[]): Promise<RoleAdditionResult> {
    if (!this.roles) throw new Error('Module roles are unavailable');
    if (!additions.length) throw new Error('At least one additional role is required');
    const st = await this.state(id);
    this.assertAdmission(st);
    if (st.load) throw new Error('Session is loading; save roles after the lifecycle transition completes');
    try {
      let selected = this.roles.read(id);
      const catalog = this.roles.list();
      const combined = new Map(selected.map(role => [`${role.moduleId}/${role.roleId}`, role]));
      for (const addition of additions) {
        const role = catalog.find(value => value.moduleId === addition.moduleId && value.roleId === addition.roleId);
        if (!role) throw new Error(`Unknown module role: ${addition.moduleId}/${addition.roleId}`);
        combined.set(`${role.moduleId}/${role.roleId}`, {
          moduleId: role.moduleId, roleId: role.roleId, moduleName: role.moduleName, name: role.name,
        });
      }
      if (combined.size > 64) throw new Error('A session can select at most 64 roles');
      if (combined.size === selected.length) {
        return { sessionId: id, status: 'unchanged', loaded: !!st.sdk, ...this.roleState(id, st, selected) };
      }
      // Persistence is synchronous: concurrent saves cannot interleave this read/union/write.
      try {
        this.roles.save(id, [...combined.values()]);
        selected = this.roles.read(id);
        if (selected.length !== combined.size || selected.some(role => !combined.has(`${role.moduleId}/${role.roleId}`))) {
          throw new Error('Saved role selection did not confirm the requested additions');
        }
      } catch (error) {
        this.invalidate(st, ['identity']);
        try { selected = this.roles.read(id); }
        catch (readError) {
          throw new AggregateError([error, readError],
            'Role persistence outcome and saved selection are unconfirmed; inspect session/get before explicitly retrying. No reload, rollback or retry was performed.');
        }
        return { sessionId: id, status: 'uncertain', loaded: !!st.sdk, ...this.roleState(id, st, selected),
          error: messageOf(error),
          recovery: 'Inspect session/get for saved roles before explicitly retrying. No reload, rollback or retry was performed.' };
      }
      const fields = this.roleState(id, st, selected);
      this.patch(st, fields);
      this.invalidate(st, ['identity']);
      return { sessionId: id, status: 'saved', loaded: !!st.sdk, ...fields };
    } finally {
      this.release(st);
    }
  }
  private readonly runtime: EngineRuntime;
  private readonly sessions = new Map<string, State>();
  private readonly creating = new Set<string>();
  private readonly removing = new Set<string>();
  private readonly bus = new EventEmitter().setMaxListeners(0);
  private readonly nativeObservers = new Map<(event: NativeObservation) => void | Promise<void>, ReadonlySet<string> | undefined>();
  private agentStatus: AgentStatus = 'starting';
  private birthGate: Promise<void> = Promise.resolve();
  private births = 0;
  private lifecycle = false;
  private started = false;
  private stopped = false;
  private startPromise?: Promise<void>;
  private fatalError?: Error;
  log: (message: string, data?: Record<string, unknown>) => void = () => {};

  constructor(options: { runtime?: EngineRuntime } = {}) {
    this.runtime = options.runtime ?? new OfficialRuntime();
    this.runtime.onSessionClosed(sdk => {
      if (this.failure) { this.fail(this.failure); return; }
      const st = this.sessions.get(sdk.sessionId);
      if (st?.sdk === sdk) this.detach(st);
      else if (st?.eventOwner && !st.sdk) {
        (st.eventOwner.closed ??= new WeakSet()).add(sdk);
      }
    });
    this.runtime.onFatal(error => this.fail(error));
    if (this.runtime.failure) this.fail(this.runtime.failure);
  }

  get failure(): Error | undefined { return this.fatalError ?? this.runtime.failure; }

  onFatal(handler: (error: Error) => void): () => void {
    this.bus.on('fatal', handler);
    return () => this.bus.off('fatal', handler);
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.started = false;
    this.agentStatus = 'failed';
    for (const st of this.sessions.values()) this.detach(st, error);
    this.emit({ type: 'agent/status', status: 'failed' });
    this.bus.emit('fatal', error);
  }

  private assertAvailable(): void {
    if (this.failure) {
      this.fail(this.failure);
      throw this.failure;
    }
  }

  private async untilFatal<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    let off = () => {};
    const failure = new Promise<never>((_, reject) => { off = this.onFatal(reject); });
    try { return await Promise.race([work(), failure]); }
    finally { off(); }
  }

  private async withSession<T>(st: State, sdk: CopilotSession, work: () => Promise<T>): Promise<T> {
    return this.untilFatal(async () => {
      if (st.sdk !== sdk) throw new Error('Native session closed during operation; delivery may be uncertain');
      let rejectClosed!: (error: Error) => void;
      const closed = new Promise<never>((_, reject) => { rejectClosed = reject; });
      const onClosed = (session: CopilotSession) => {
        if (session === sdk) rejectClosed(this.failure ?? new Error('Native session closed during operation; delivery may be uncertain'));
      };
      this.bus.on('closed', onClosed);
      try { return await Promise.race([work(), closed]); }
      finally { this.bus.off('closed', onClosed); }
    });
  }

  onEvent(handler: (event: ServerEvent) => void): () => void {
    this.bus.on('event', handler);
    return () => this.bus.off('event', handler);
  }

  /** Live notifications only; optional types are matched before copying event payloads. */
  onNativeEvent(handler: (event: NativeObservation) => void | Promise<void>, options?: { types: readonly string[] }): () => void {
    this.nativeObservers.set(handler, options ? new Set(options.types) : undefined);
    return () => { this.nativeObservers.delete(handler); };
  }

  private observeNative(st: State, native: SessionEvent): void {
    if (native.type === 'session.context_changed') {
      const { data, agentId, parentToolCallId } = normalizeEvent(native);
      if (!agentId && !parentToolCallId && !data.agentId && !data.parentToolCallId) {
        if (typeof data.cwd === 'string' && isAbsolute(data.cwd) && !data.cwd.includes('\0')) {
          st.observedCwd = data.cwd;
          if (st.eventOwner) st.eventOwner.contextChanged = true;
        }
        else {
          try { this.log('native observer ignored invalid working directory', { sessionId: st.id }); }
          catch { /* Observer diagnostics cannot affect native control state. */ }
        }
      }
    }
    let interested = false;
    for (const types of this.nativeObservers.values()) {
      if (!types || types.has(native.type)) { interested = true; break; }
    }
    if (!interested) return;
    const report = (error: unknown) => {
      try { this.log('native observer failed', { sessionId: st.id, error: messageOf(error) }); }
      catch { /* Observers and their reporters cannot affect native control state. */ }
    };
    let workspacePath: string | null | undefined;
    try {
      if (st.sdk) {
        const path = st.sdk.workspacePath;
        if (path == null || (typeof path === 'string' && isAbsolute(path) && !path.includes('\0'))) {
          workspacePath = path ?? null;
        } else report(new Error('Invalid native workspace path'));
      }
    } catch (error) { report(error); }
    try {
      const clean = (value: unknown): unknown => {
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
        if (Array.isArray(value)) return Object.freeze(value.map(clean));
        if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'binaryResultsForLlm').map(([key, item]) => [key, clean(item)]),
        ));
        return value;
      };
      const event = clean(normalizeEvent(native)) as NativeChatEvent;
      const observation = Object.freeze({
        sessionId: st.id, cwd: st.observedCwd ?? null,
        ...(workspacePath !== undefined ? { workspacePath } : {}), event,
      });
      for (const [observer, types] of this.nativeObservers) {
        if (types && !types.has(native.type)) continue;
        try { void Promise.resolve(observer(observation)).catch(report); }
        catch (error) { report(error); }
      }
    } catch (error) { report(error); }
  }

  onActivitySettled(handler: () => void): () => void {
    this.bus.on('activity-settled', handler);
    return () => { this.bus.off('activity-settled', handler); };
  }

  private emit(event: ServerEvent): void { this.bus.emit('event', event); }

  start(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.lifecycle) return Promise.reject(new Error('Engine lifecycle transition is in progress'));
    if (this.started) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.untilFatal(async () => {
      await this.untilFatal(() => this.runtime.start());
      this.assertAvailable();
      this.started = true;
      this.stopped = false;
      this.agentStatus = 'up';
      this.emit({ type: 'agent/status', status: 'up' });
    }).catch(error => {
      this.started = false;
      this.agentStatus = 'failed';
      this.emit({ type: 'agent/status', status: 'failed' });
      throw error;
    }).finally(() => { this.startPromise = undefined; this.bus.emit('activity-settled'); });
    return this.startPromise;
  }

  async login(): Promise<string> {
    this.assertReadable();
    return (await this.untilFatal(() => this.runtime.getAuthStatus())).login ?? '';
  }

  async snapshot(): Promise<Snapshot> {
    this.assertReadable();
    const [models, sessions] = await settled([this.runtime.models(), this.readSessions()] as const);
    return {
      type: 'snapshot', permissionPolicy: 'allow-all', agentStatus: this.agentStatus,
      models, sessions,
    };
  }

  private listedMeta(row: SessionMetadata): SessionMeta {
    return {
      ...this.roleState(row.sessionId),
      sessionId: row.sessionId, title: cleanSessionTitle(row.summary) || row.sessionId.slice(0, 8),
      cwd: row.context?.workingDirectory ?? '',
      createdAt: row.startTime.getTime(), lastActivity: row.modifiedTime.getTime(), lastActivitySource: 'native-persisted',
      loaded: false, status: 'unloaded', ask: null,
      planRequest: null, elicitation: null,
    };
  }

  private async readSessions(resources: MetaResource[] = summaryResources): Promise<SessionMeta[]> {
    this.assertReadable();
    const rows = await this.untilFatal(() => this.runtime.listSessions());
    const byId = new Map(rows.map(row => [row.sessionId, row]));
    const ids = new Set(rows.filter(row => !this.creating.has(row.sessionId) || this.sessions.get(row.sessionId)?.sdk).map(row => row.sessionId));
    for (const id of this.sessions.keys()) ids.add(id);
    const result: SessionMeta[] = [];
    // Bound concurrent native reads independently of the size of the session index.
    for (const id of ids) {
      const st = this.sessions.get(id);
      const row = byId.get(id);
      const meta = st ? await this.getResources(id, resources, row) : row ? {
        ...this.listedMeta(row), ...(resources.includes('control') ? { activity: null } : {}),
      } : await this.getResources(id, resources);
      if (meta) result.push(completeMeta(meta));
    }
    return result;
  }

  async getMeta(id: string): Promise<SessionMeta | null> {
    const meta = await this.getResources(id, MetaResources.options, undefined, { nameProvenance: true });
    return meta ? completeMeta(meta) : null;
  }

  async getResources(
    id: string, resources: readonly MetaResource[], listedRow?: SessionMetadata, { nameProvenance = false } = {},
  ): Promise<SessionProjection | null> {
    this.assertAvailable();
    const st = this.sessions.get(id);
    if (this.creating.has(id) && !st?.sdk) throw Object.assign(
      new Error('Native session creation is still awaiting acknowledgement'), { statusCode: 409, code: 'SESSION_TRANSITION' },
    );
    this.assertReadable(st);
    if (st) {
      st.operations++;
      this.patch(st, { activeOperations: st.operations });
    }
    try {
      const sdk = st && await this.liveSession(st);
      this.assertReadable(st);
      if (!st || !sdk) {
        const row = listedRow ?? await this.untilFatal(() => this.runtime.getSessionMetadata(id));
        return row ? {
          ...this.listedMeta(row),
          ...(resources.includes('control') ? { activity: null } : {}),
          ...(resources.includes('controls') ? { controls: null } : {}),
          ...(st ? { loading: !!st.load, closing: st.closing, cancelling: !!st.cancelling,
            activeOperations: Math.max(0, st.operations - 1), activeMcpOperations: st.mcpOperations,
            ...this.decisionFields(st) } : {}),
        } : null;
      }
      const activityRevision = st.activityRevision;
      const wants = new Set(resources);
      const readsControl = wants.has('control') || wants.has('controls');
      const [metadata, name, workspace, model, models, mode, todos, schedules, control, queue, row] = await this.withSession(st, sdk, () => settled([
        wants.has('identity') ? sdk.rpc.metadata.snapshot() : Promise.resolve(undefined),
        wants.has('identity') ? sdk.rpc.name.get() : Promise.resolve(undefined),
        // Full session/get only; optional, so its failure must not hide the rest of identity.
        wants.has('identity') && nameProvenance ? (async () => (await sdk.rpc.workspaces.getWorkspace()).workspace)().catch(() => undefined) : Promise.resolve(undefined),
        wants.has('model') ? sdk.rpc.model.getCurrent() : Promise.resolve(undefined),
        wants.has('models') ? sdk.rpc.model.list() : Promise.resolve(undefined),
        wants.has('mode') && !wants.has('identity') ? sdk.rpc.mode.get() : Promise.resolve(undefined),
        wants.has('todo') ? sdk.rpc.plan.readSqlTodos() : Promise.resolve(undefined),
        wants.has('schedule') ? sdk.rpc.schedule.list() : Promise.resolve(undefined),
        readsControl ? this.readControl(st, sdk) : Promise.resolve(undefined),
        wants.has('queue') && !readsControl ? sdk.rpc.queue.pendingItems() : Promise.resolve(undefined),
        wants.has('identity') ? listedRow ? Promise.resolve(listedRow) : this.runtime.getSessionMetadata(id) : Promise.resolve(undefined),
      ] as const));
      const nativeModels = models ? sessionModelOptions(models.list) : undefined;
      const needsCatalog = nativeModels?.some(option => option.supportedReasoningEfforts === undefined
        || option.defaultReasoningEffort === undefined || option.supportsLongContext === undefined);
      const availableModels = models && needsCatalog
        ? sessionModelOptions(models.list, await this.withSession(st, sdk, () => this.runtime.models())) : nativeModels;
      return {
        sessionId: id, loaded: true,
        ...(wants.has('identity') ? this.roleState(id, st) : {}),
        ...(metadata ? {
          title: cleanSessionTitle(name?.name ?? metadata.summary) || id.slice(0, 8), cwd: metadata.workingDirectory,
          ...(name && nameProvenance ? { nativeName: name.name ?? null } : {}),
          // Two native reads: emit provenance only when both describe the same name.
          ...(name && typeof workspace?.user_named === 'boolean' && (workspace.name ?? null) === (name.name ?? null)
            ? { nativeNameUserSet: workspace.user_named } : {}),
          createdAt: Date.parse(metadata.startTime),
          lastActivity: row?.modifiedTime.getTime() ?? Date.parse(metadata.modifiedTime),
          lastActivitySource: row ? 'native-persisted' as const : 'native-construction' as const,
        } : {}),
        ...(control && wants.has('control') ? {
          status: control.busy || st.sends > 0 || st.accepted.size > 0 ? 'running' as const : 'idle' as const,
          nativeProcessing: control.busy,
          activity: activityRevision === st.activityRevision ? control.summary : null,
          ...(!control.busy && !st.sends && !st.accepted.size ? { intent: null } : {}),
          activeSubagents: control.tasks.tasks.filter(task => activeTask(task.status)).length,
          activeMcpOperations: st.mcpOperations + control.mcpHost.pendingConnections.length,
        } : {}),
        ...(wants.has('controls') ? { controls: activityRevision === st.activityRevision && st.sdk === sdk
          ? this.controlProjection(st, control!) : null } : {}),
        ...(model ? { currentModelId: model.modelId, currentReasoningEffort: model.reasoningEffort ?? null,
          currentContextTier: model.contextTier ?? null } : {}),
        ...(wants.has('mode') ? { currentMode: metadata?.currentMode ?? mode } : {}),
        ...(models ? { availableModels } : {}),
        ...(wants.has('queue') && activityRevision === st.activityRevision && st.sdk === sdk
          ? { queue: this.queueProjection((control?.queue ?? queue)!) } : {}),
        ...(todos ? { todo: this.todoSummary(todos) } : {}),
        ...(schedules ? { scheduleCount: schedules.entries.length } : {}),
        activeOperations: Math.max(0, st.operations - 1),
        loading: !!st.load, closing: st.closing, cancelling: !!st.cancelling,
        ...this.decisionFields(st),
      };
    } catch (error) {
      if (st && resources.includes('control')) this.patch(st, { activity: null });
      if (st && resources.includes('controls')) this.patch(st, { controls: null });
      throw error;
    } finally {
      if (st) {
        st.operations--;
        this.patch(st, { activeOperations: st.operations });
        this.release(st);
      }
    }
  }

  async listLive(): Promise<SessionBrief[]> {
    return (await this.readSessions(['identity', 'control', 'model'])).map(meta => ({
      sessionId: meta.sessionId, title: meta.title, cwd: meta.cwd, status: meta.status,
      loaded: meta.loaded, lastActivity: meta.lastActivity, currentModelId: meta.currentModelId,
      lastActivitySource: meta.lastActivitySource,
      activity: meta.activity,
      roles: meta.roles, appliedRoles: meta.appliedRoles, rolesNeedReload: meta.rolesNeedReload,
    }));
  }
  async status(): Promise<SessionMeta[]> {
    return this.readSessions(['identity', 'control']);
  }

  async refreshList(): Promise<void> {
    this.emit(await this.snapshot());
  }

  private async state(id: string): Promise<State> {
    this.assertAvailable();
    if (this.stopped) throw new Error('Engine is stopped; start it before performing session operations');
    if (this.lifecycle) throw new Error('Engine lifecycle transition is in progress');
    if (this.removing.has(id)) throw new Error('Session removal is in progress');
    let st = this.sessions.get(id);
    if (!st) {
      const metadata = await this.untilFatal(() => this.runtime.getSessionMetadata(id));
      if (!metadata) throw new Error('Unknown session');
      this.assertAvailable();
      if (this.stopped || this.lifecycle || this.removing.has(id)) {
        throw new Error('Session lifecycle transition is in progress');
      }
      st = this.sessions.get(id);
      if (!st) {
        st = stateFor(id);
        st.observedCwd = metadata.context?.workingDirectory || null;
        this.sessions.set(id, st);
      }
    }
    if (st.closing) throw new Error('Session transition is in progress');
    return st;
  }

  private release(st: State): void {
    if (!st.sdk && !st.load && !st.closing && !st.operations && !st.cancelling
      && !st.decisions.size && this.sessions.get(st.id) === st) this.sessions.delete(st.id);
    this.bus.emit('activity-settled');
  }

  private assertAdmission(st: State): void {
    this.assertAvailable();
    const current = this.sessions.get(st.id);
    if (this.stopped || this.lifecycle || st.closing || (current && current !== st)) {
      throw new Error('Session lifecycle transition is in progress or its handle changed');
    }
  }

  private assertReadable(st?: State): void {
    this.assertAvailable();
    if (this.stopped || this.lifecycle || st?.closing) throw Object.assign(
      new Error('Native session metadata is unavailable during a lifecycle transition'),
      { statusCode: 409, code: 'SESSION_TRANSITION' },
    );
  }

  private async config(st: State, cwd?: string): Promise<{ config: SessionConfig; assembly?: RoleAssembly }> {
    const disabled = await this.globalDisabledSkills();
    const selected = this.roles?.read(st.id) ?? [];
    const assembly = selected.length ? await this.roles!.assemble(st.id, selected) : undefined;
    if (assembly?.skills.length) {
      const existing = await this.discoverSkills(cwd ?? st.observedCwd ?? undefined);
      const names = new Map(existing.skills.map(skill => [skill.name, skill.path]));
      for (const directory of assembly.config.skillDirectories ?? []) {
        const discovered = await this.untilFatal(() => this.runtime.rpc.skills.discover({
          projectPaths: [], skillDirectories: [directory],
        }));
        if (discovered.errors?.length) throw new Error(`Role skill discovery failed: ${discovered.errors.join('; ')}`);
        for (const skill of assembly.skills.filter(skill => skill.path.startsWith(`${directory}/`))) {
          const native = discovered.skills.find(value => value.path === skill.path);
          if (!native) throw new Error(`Role skill was not discovered by native runtime: ${skill.path}`);
          if (names.has(native.name) && names.get(native.name) !== skill.path) {
            throw new Error(`Role skill conflicts with native discovered skill: ${native.name}`);
          }
          names.set(native.name, skill.path);
          skill.name = native.name;
        }
      }
    }
    if (assembly) {
      const [configured, discovered] = await this.untilFatal(() => settled([
        this.runtime.rpc.mcp.config.list(),
        this.runtime.rpc.mcp.discover({ workingDirectory: cwd ?? st.observedCwd ?? undefined }),
      ] as const));
      for (const name of Object.keys(assembly.config.mcpServers ?? {})) {
        if (Object.hasOwn(configured.servers, name) || discovered.servers.some(server => server.name === name)) {
          throw new Error(`Role MCP conflicts with native configuration: ${name}`);
        }
      }
    }
    return { assembly, config: {
      ...assembly?.config,
      sessionId: st.id, ...(cwd ? { workingDirectory: cwd } : {}), streaming: true,
      enableConfigDiscovery: true,
      // Runtime 1.0.83 discovers skills but does not apply its global disabled
      // list on create/cold resume unless the SDK receives that native value.
      disabledSkills: disabled,
      onUserInputRequest: request => this.decision<UserInputResponse>(st, 'ask', request, response => {
        if (response.wasFreeform && request.allowFreeform === false) throw new Error('Freeform answers are not allowed');
        if (!response.wasFreeform && !request.choices?.includes(response.answer)) throw new Error('Answer is not an offered choice');
      }),
      onExitPlanModeRequest: request => this.decision<ExitPlanModeResult>(st, 'planRequest', {
        ...request, actions: request.actions.filter(action => planActions.has(action)),
        recommendedAction: planActions.has(request.recommendedAction) ? request.recommendedAction : undefined,
      }, response => {
        if (response.selectedAction && (!planActions.has(response.selectedAction) || !request.actions.includes(response.selectedAction))) {
          throw new Error('Plan action was not offered or is unsupported');
        }
      }),
      onElicitationRequest: request => this.decision<ElicitationResult>(st, 'elicitation', {
        message: request.message,
        actions: request.mode === 'url' || request.requestedSchema ? ['decline', 'cancel'] : ['accept', 'decline', 'cancel'],
      }, response => {
        if (response.action === 'accept' && (request.mode === 'url' || request.requestedSchema)) {
          throw new Error('Structured/URL elicitation acceptance is unsupported; decline or cancel the real request');
        }
      }),
    } };
  }

  private decision<T>(st: State, kind: DecisionKind, fields: object, validate?: (value: T) => void): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (st.closing || st.cancelling || this.lifecycle) return Promise.reject(new Error('Session is closing or cancelling'));
    const requestId = randomUUID();
    return new Promise<T>((answer, reject) => {
      st.decisions.set(requestId, {
        kind, epoch: st.turnEpoch, interactionId: st.interactionId,
        value: { ...fields, requestId } as Decision['value'],
        answer: value => answer(value as T), reject,
        validate: validate ? value => validate(value as T) : undefined,
      });
      this.projectDecisions(st);
    });
  }

  private decisionFields(st: State) {
    const decisions = [...st.decisions.values()];
    return {
      ask: decisions.find(d => d.kind === 'ask')?.value as SessionMeta['ask'] ?? null,
      planRequest: decisions.find(d => d.kind === 'planRequest')?.value as SessionMeta['planRequest'] ?? null,
      elicitation: decisions.find(d => d.kind === 'elicitation')?.value as SessionMeta['elicitation'] ?? null,
    };
  }

  private projectDecisions(st: State): void {
    this.patch(st, this.decisionFields(st));
  }

  private answer(st: State, requestId: string, kind: DecisionKind, value: unknown): void {
    const pending = st.decisions.get(requestId);
    if (!pending || pending.kind !== kind) throw new Error('Request is no longer pending');
    pending.validate?.(value);
    st.decisions.delete(requestId);
    pending.answer(value);
    this.projectDecisions(st);
  }

  private birth<T>(work: () => Promise<T>): Promise<T> {
    this.births++;
    const result = this.birthGate.then(work);
    this.birthGate = result.then(() => {}, () => {});
    return result.finally(() => { this.births--; this.bus.emit('activity-settled'); });
  }

  async newSession(cwd: string, roles: RoleSelection[] = []): Promise<string> {
    this.assertAvailable();
    if (this.stopped) throw new Error('Engine is stopped; start it before creating sessions');
    if (this.lifecycle) throw new Error('Engine lifecycle transition is in progress');
    const directory = resolve(cwd || homedir());
    if (!statSync(directory).isDirectory()) throw new Error('Working directory must be a directory');
    const id = randomUUID();
    if (this.creating.has(id) || this.sessions.has(id)) throw new Error('Session identity already has an active handle or creation');
    const st = stateFor(id);
    if (roles.length) {
      if (!this.roles) throw new Error('Module roles are unavailable');
      const assembly = await this.roles.assemble(id, roles);
      this.roles.save(id, assembly.roles);
    }
    this.creating.add(id);
    try {
      await this.ensureLoaded(st, true, directory);
      return id;
    } catch (error) {
      if (st.sdk?.sessionId === id) {
        throw Object.assign(new Error(`Native session ${id} was created, but readiness readback failed: ${messageOf(error)}. Inspect this session; do not create a replacement automatically.`, { cause: error }),
          { sessionId: id, code: 'SESSION_CREATION_INCOMPLETE', statusCode: 409 });
      }
      if (st.creationSubmitted) throw Object.assign(
        new Error(`Native session creation ${id} is uncertain: ${messageOf(error)}. Inspect this identity; do not retry blindly.`, { cause: error }),
        { sessionId: id, code: 'SESSION_CREATION_UNCERTAIN', statusCode: 409 },
      );
      throw error;
    } finally {
      this.creating.delete(id);
      this.bus.emit('activity-settled');
    }
  }

  async forkSession(id: string, toEventId?: string, name?: string): Promise<{ sessionId: string }> {
    const st = await this.state(id);
    return this.transition(st, async () => {
      const sdk = st.sdk;
      if (!sdk) throw new SessionUnloadedError();
      await this.withSession(st, sdk, () => validateForkHistory(sdk.rpc.eventLog.read, toEventId));
      // Recheck native activity after the scan; no parent abort, resume or save.
      await this.checkIdle(st);
      if (st.sdk !== sdk) throw new SessionUnloadedError();
      const [queue, schedules] = await this.withSession(st, sdk, () => settled([
        sdk.rpc.queue.pendingItems(), sdk.rpc.schedule.list(),
      ] as const));
      if (queue.items.length || queue.steeringMessages.length || queue.inFlightSteeringCount) {
        throw new Error('Source has protected queued or steering work');
      }
      if (schedules.entries.length) throw new Error('Source has active schedules; fork requires an idle source without timers');
      return await this.birth(async () => {
        let result: Awaited<ReturnType<typeof this.runtime.rpc.sessions.fork>>;
        try {
          result = await this.untilFatal(() => this.runtime.rpc.sessions.fork({ sessionId: id, toEventId, name }));
        } catch (error) {
          throw new Error(`Native fork failed; creation may be uncertain. Do not retry blindly; inspect the session list and source fork records. ${messageOf(error)}`, { cause: error });
        }
        const child = await this.getMeta(result.sessionId);
        if (!child) throw new Error(`Native fork returned ${result.sessionId}, but its metadata is unavailable; do not retry`);
        this.emit({ type: 'session/added', session: child });
        return { sessionId: result.sessionId };
      });
    });
  }

  private async ensureLoaded(st: State, create = false, cwd?: string): Promise<void> {
    this.assertAdmission(st);
    if (st.load) return st.load;
    if (!create) this.sessions.set(st.id, st);
    if (st.sdk && await this.liveSession(st)) return;
    this.assertAdmission(st);
    if (st.load) return st.load;
    this.patch(st, { loading: true });
    st.load = this.untilFatal(() => this.birth(async () => {
      this.assertAvailable();
      const owner: NonNullable<State['eventOwner']> = {};
      st.eventOwner = owner;
      if (create) st.observedCwd = cwd ?? null;
      const assembled = await this.config(st, cwd);
      const config: SessionConfig = { ...assembled.config, onEvent: event => {
        if (st.eventOwner !== owner || this.failure) return;
        this.observeNative(st, event);
        try { this.onLive(st, event); }
        catch (error) {
          this.patch(st, { error: `Native control event could not be applied: ${messageOf(error)}` });
          this.log('native control event failed', { sessionId: st.id, error: messageOf(error) });
        }
      } };
      if (create) st.creationSubmitted = true;
      const sdk = await this.untilFatal(() => create
        ? this.runtime.createSession(config)
        : this.runtime.resumeSession(st.id, config));
      this.assertAvailable();
      if (sdk.sessionId !== st.id) {
        const action = create ? 'creation' : 'resume';
        throw new Error(`Native ${action} returned a different session ID; ${action} is unconfirmed`);
      }
      if (st.eventOwner !== owner) throw new Error('Native session closed while loading; explicitly resume to continue');
      st.sdk = sdk;
      st.controlToken = randomUUID();
      st.roleAssembly = assembled.assembly;
      this.sessions.set(sdk.sessionId, st);
      if (owner.closed?.has(sdk) || (create && !await this.liveSession(st))) {
        this.detach(st);
        throw new Error('Native session closed while loading; explicitly resume to continue');
      }
      delete owner.closed;
      if (st.roleAssembly) await this.withSession(st, sdk, () => sdk.rpc.tools.initializeAndValidate());
      const meta = await this.getResources(st.id, summaryResources);
      if (!meta) throw new Error('Native session metadata is unavailable after loading');
      if (!owner.contextChanged) st.observedCwd = meta.cwd || null;
      this.emit({ type: 'session/added', session: completeMeta({ ...meta, error: null }) });
    })).catch(error => {
      if (!st.sdk) {
        st.eventOwner = undefined;
      }
      this.patch(st, { loaded: !!st.sdk, status: 'error', error: messageOf(error) });
      throw error;
    }).finally(() => {
      st.load = undefined;
      this.patch(st, { loading: false });
      this.release(st);
    });
    return st.load;
  }

  private async liveSession(st: State): Promise<CopilotSession | null> {
    this.assertAvailable();
    const sdk = st.sdk;
    if (!sdk) return null;
    const live = await this.untilFatal(() => this.runtime.isSessionLive(sdk));
    this.assertAvailable();
    if (st.sdk !== sdk) return null;
    if (!live) {
      this.detach(st);
      return null;
    }
    return sdk;
  }

  private probe(st: State): void {
    void this.liveSession(st).catch(error => {
      if (!this.failure) this.log('session liveness check failed', { sessionId: st.id, error: messageOf(error) });
    });
  }

  private onLive(st: State, native: SessionEvent): void {
    if ((!st.sdk && !st.eventOwner) || this.failure
      || (!native.type.startsWith('session.') && native.type !== 'pending_messages.modified' && !controlEvents.has(native.type))) return;
    const event = normalizeEvent(native);
    st.revision++;
    const data = event.data;
    const root = !event.agentId && !event.parentToolCallId && !data.parentToolCallId && !data.agentId;
    if (root && event.type === 'user.message') {
      for (const id of [native.id, data.messageId]) {
        if (typeof id !== 'string') continue;
        st.accepted.delete(id);
        st.steeringAccepted.delete(id);
        if (st.sends) st.sendReceipts.add(id);
      }
      this.patch(st, { lastActivity: Date.now(), lastActivitySource: 'host-event-receipt' });
    }
    if (root && event.type !== 'user.message' && typeof data.interactionId === 'string'
      && st.interactionId && data.interactionId !== st.interactionId
      && (event.type.startsWith('assistant.') || event.type === 'session.error')) return;
    if (root && ((event.type === 'user.message' && data.delivery !== 'steering') || event.type === 'assistant.turn_start')) {
      st.turnEpoch++;
      st.interruptedEpoch = undefined;
      st.interactionId = typeof data.interactionId === 'string' ? data.interactionId : undefined;
    }
    if (root && event.type === 'session.idle' && !st.interruptTurn) st.interactionId = undefined;
    // Late lifecycle effects from an interrupted interaction must not erase the
    // queued turn's reply/decision state; its transcript remains native history.
    if (root && event.type.startsWith('assistant.') && st.interruptedEpoch === st.turnEpoch) return;
    if (root && st.interruptTurn && (event.type === 'abort'
      || (event.type === 'assistant.turn_start' && typeof data.interactionId === 'string'
        && st.interruptTurn.interactionId && data.interactionId !== st.interruptTurn.interactionId))) {
      this.clearInterruptedTurn(st, st.interruptTurn);
      st.interruptTurn = undefined;
    }
    if (event.type === 'session.shutdown'
      || (event.type === 'session.connection_state_changed' && ['reconnecting', 'disconnected'].includes(String(data.state)))) {
      st.activityRevision++;
      this.patch(st, { activity: null, controls: null });
      this.probe(st);
      return;
    }
    if (event.type === 'session.connection_state_changed' && data.state === 'connected') {
      this.invalidate(st, ['control']);
      return;
    }
    if (root && ['user.message', 'abort', 'session.compaction_start'].includes(event.type)) {
      this.invalidate(st, ['control', 'queue']);
    }
    if (native.type === 'tool.execution_complete') {
      this.scheduleSync(st);
    }
    if (root && event.type === 'tool.execution_start' && data.toolName === 'report_intent') {
      const args = data.arguments as { intent?: string } | undefined;
      if (typeof args?.intent === 'string') this.patch(st, { intent: args.intent });
    }
    if (root && event.type === 'assistant.turn_start') {
      this.patch(st, { status: 'running', nativeProcessing: true, error: null });
      this.invalidate(st, ['control', 'queue']);
    }
    if (root && event.type === 'assistant.turn_end') {
      this.scheduleSync(st, ['identity', 'control', 'queue', 'usage']);
    }
    if (event.type === 'session.error') {
      this.patch(st, { status: 'error', error: String(data.message ?? 'Native turn failed') });
    }
    if (event.type === 'session.title_changed' && typeof data.title === 'string') this.patch(st, { title: cleanSessionTitle(data.title) });
    if (event.type === 'session.mode_changed' && ['interactive', 'plan', 'autopilot'].includes(String(data.newMode))) {
      this.patch(st, { currentMode: data.newMode as SessionMeta['currentMode'] });
    }
    if (root && event.type === 'session.compaction_start') {
      st.observedCompaction = true;
      this.patch(st, { compacting: true });
    }
    if (root && event.type === 'session.compaction_complete') {
      st.observedCompaction = false;
      this.patch(st, { compacting: false });
    }
    switch (native.type) {
      case 'session.idle':
      case 'session.error':
      case 'pending_messages.modified':
        this.scheduleSync(st);
        break;
      case 'session.background_tasks_changed':
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed':
        this.scheduleSync(st, ['control', 'tasks']);
        break;
      case 'session.compaction_complete':
        this.scheduleSync(st, ['control', 'usage']);
        break;
      case 'session.context_changed':
        this.invalidate(st, ['identity', 'instructions', 'usage']);
        break;
      case 'session.context_cleared':
        this.invalidate(st, ['identity', 'control', 'queue', 'plan', 'todo', 'tasks', 'instructions', 'usage']);
        break;
      case 'session.plan_changed':
        this.invalidate(st, ['plan']);
        break;
      case 'session.skills_loaded':
        this.invalidate(st, ['skills', 'usage']);
        break;
      case 'session.tools_updated':
        this.invalidate(st, ['usage']);
        break;
      case 'session.schedule_created':
      case 'session.schedule_cancelled':
      case 'session.schedule_rearmed':
        this.invalidate(st, ['schedule']);
        break;
      case 'session.todos_changed':
        this.invalidate(st, ['todo', 'plan']);
        break;
      case 'session.model_change':
        this.invalidate(st, ['model', 'models', 'usage']);
        break;
      case 'session.usage_info':
      case 'session.usage_checkpoint':
        this.invalidate(st, ['usage']);
        break;
      case 'session.mcp_servers_loaded':
      case 'session.mcp_server_removed':
      case 'session.mcp_server_status_changed':
        this.scheduleSync(st, ['control', 'mcp', 'usage']);
        break;
    }
  }

  private scheduleSync(st: State, resources: SessionResource[] = ['control', 'queue']): void {
    this.invalidate(st, resources);
  }

  private patchMcpPending(st: State): void {
    this.invalidate(st, ['control', 'mcp']);
  }

  private async readResource<K extends Resource>(
    st: State, sdk: CopilotSession, resource: K,
  ): Promise<ResourceValues[K]> {
    this.assertAvailable();
    if (st.sdk !== sdk) throw new Error('Native session closed during resource read');
    const readers: { [R in Resource]: () => Promise<ResourceValues[R]> } = {
      todos: () => sdk.rpc.plan.readSqlTodos(), schedule: () => sdk.rpc.schedule.list(), mcp: () => sdk.rpc.mcp.list(),
    };
    return this.withSession(st, sdk, readers[resource]);
  }

  private todoSummary(plan: Awaited<ReturnType<CopilotSession['rpc']['plan']['readSqlTodos']>>): SessionMeta['todo'] {
    const todos = plan.rows.filter(row => row.id && row.title);
    return todos.length ? { done: todos.filter(todo => todo.status === 'done').length,
      total: todos.length, intent: todos.find(todo => todo.status === 'in_progress')?.title ?? null } : null;
  }

  private async readControl(st: State, sdk: CopilotSession) {
    const [processing, activity, queue, tasks, mcp] = await this.withSession(st, sdk, () => settled([
      sdk.rpc.metadata.isProcessing(), sdk.rpc.metadata.activity(), sdk.rpc.queue.pendingItems(),
      sdk.rpc.tasks.list(), sdk.rpc.mcp.list(),
    ] as const));
    if (!mcp.host) throw new Error('Native MCP host state is unavailable; cannot confirm session safety');
    if (typeof processing.processing !== 'boolean' || typeof activity.hasActiveWork !== 'boolean'
      || typeof queue.inFlightSteeringCount !== 'number'
      || !Number.isInteger(queue.inFlightSteeringCount) || queue.inFlightSteeringCount < 0
      || !Array.isArray(queue.steeringMessages)
      || queue.steeringMessages.some(text => typeof text !== 'string')
      || queue.inFlightSteeringCount > queue.steeringMessages.length
      || !Array.isArray(queue.items)
      || queue.items.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.displayText !== 'string')) {
      throw new Error('Native activity state is incomplete or inconsistent; cannot confirm session safety');
    }

    const counts = { activeAgents: 0, activeShells: 0, unknown: 0 };
    for (const task of tasks.tasks) {
      if ((task.type !== 'agent' && task.type !== 'shell')
        || !['running', 'idle', 'completed', 'failed', 'cancelled'].includes(task.status)) counts.unknown++;
      else if (task.status === 'running') {
        if (task.type === 'agent') counts.activeAgents++;
        else counts.activeShells++;
      }
    }
    const summary = SessionActivity.parse({
      sampledAt: Date.now(), processing: processing.processing,
      hasActiveWork: activity.hasActiveWork, abortable: activity.abortable,
      tasks: counts,
      queue: { pendingCount: new Set(queue.items.map(item => item.id)).size, steeringCount: queue.steeringMessages.length,
        inFlightSteeringCount: queue.inFlightSteeringCount },
      mcp: { pendingConnectionCount: mcp.host.pendingConnections.length },
    });
    return {
      processing, activity, queue, tasks, mcpHost: mcp.host, summary,
      busy: processing.processing || activity.hasActiveWork || tasks.tasks.some(task => activeTask(task.status))
        || queue.items.length > 0 || queue.steeringMessages.length > 0 || queue.inFlightSteeringCount > 0
        || mcp.host.pendingConnections.length > 0,
    };
  }

  private queueProjection(queue: Awaited<ReturnType<CopilotSession['rpc']['queue']['pendingItems']>>): QueuedItem[] {
    const groups = new Map<string, typeof queue.items>();
    for (const item of queue.items) {
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.displayText !== 'string') {
        throw new Error('Native queue item identity or display text is incomplete');
      }
      const rows = groups.get(item.id) ?? [];
      rows.push(item);
      groups.set(item.id, rows);
    }
    return [...groups].map(([id, rows]) => ({
      id, text: rows.map(row => row.displayText).join('\n'),
      canSteer: rows.length === 1 && rows.every(row => row.kind === 'message'
        && typeof row.messageId === 'string' && !!row.messageId && row.agentMode !== 'shell'),
    }));
  }

  private controlProjection(st: State, control: Awaited<ReturnType<Engine['readControl']>>): SessionControls {
    return {
      token: st.controlToken!, sampledAt: control.summary.sampledAt,
      main: control.processing.processing,
      compaction: st.manualCompactions ? 'manual' : st.observedCompaction ? 'unknown' : null,
      tasks: control.tasks.tasks.flatMap(task => (
        (task.type === 'agent' || task.type === 'shell') && task.status === 'running'
          ? [{ id: task.id, kind: task.type, status: task.status,
            title: (task.type === 'agent' ? task.displayName : undefined)
              || task.description || (task.type === 'shell' ? task.command : task.id) }]
          : []
      )),
      steering: control.queue.steeringMessages.slice(control.queue.inFlightSteeringCount).map((text, index) => ({
        id: `steering:${control.summary.sampledAt}:${index}`, text,
      })),
    };
  }

  private async syncNative(st: State): Promise<void> {
    const sdk = await this.liveSession(st);
    if (!sdk) return;
    const revision = st.revision;
    const control = await this.readControl(st, sdk);
    if (st.sdk !== sdk || revision !== st.revision) return;
    const busy = control.busy || st.sends > 0 || st.accepted.size > 0;
    if (!busy && !st.interruptTurn) st.interactionId = undefined;
  }

  private async operation<T>(
    id: string, work: (sdk: CopilotSession, st: State) => Promise<T>,
    kind: 'work' | 'read' | SessionResource[] = 'work', owner?: State,
    changes: SessionResource[] = Array.isArray(kind) ? kind : [],
  ): Promise<T> {
    const st = owner ?? await this.state(id);
    this.assertAdmission(st);
    if (st.cancelling) throw new Error('Session cancellation is in progress');
    st.operations++;
    this.patch(st, { activeOperations: st.operations });
    // Merge a mutation's native resource event with its readback notification.
    // Control/queue hints still flow immediately while the operation is busy.
    const held = changes.filter(resource => resource !== 'control' && resource !== 'controls' && resource !== 'queue');
    for (const resource of held) st.resourceWrites.set(resource, (st.resourceWrites.get(resource) ?? 0) + 1);
    try {
      if (kind === 'read') {
        if (!await this.liveSession(st)) throw new SessionUnloadedError();
      } else await this.ensureLoaded(st);
      this.assertAvailable();
      const sdk = st.sdk;
      if (!sdk) throw new Error('Native session is unavailable; explicitly resume to continue');
      return await this.withSession(st, sdk, () => work(sdk, st));
    } catch (error) {
      if (!(error instanceof SessionUnloadedError)) this.patch(st, { error: messageOf(error) });
      throw error;
    } finally {
      st.operations--;
      this.patch(st, { activeOperations: st.operations });
      if (changes.length) this.invalidate(st, changes);
      for (const resource of held) {
        const count = st.resourceWrites.get(resource)! - 1;
        if (count) st.resourceWrites.set(resource, count);
        else st.resourceWrites.delete(resource);
      }
      const ready = [...st.pendingInvalidations].filter(resource => !st.resourceWrites.has(resource));
      for (const resource of ready) st.pendingInvalidations.delete(resource);
      if (ready.length) this.invalidate(st, ready);
      this.release(st);
    }
  }

  async prompt(id: string, text: string, mode: 'enqueue' | 'immediate' = 'enqueue', attachments?: RuntimeAttachment[]): Promise<{ ok: boolean; queued?: boolean }> {
    if (!text.trim() && !attachments?.length) throw new Error('Prompt must not be empty');
    return this.operation(id, (sdk, st) => this.serializeMutation(st, 'controlGate', async () => {
      const before = await this.readControl(st, sdk);
      const queued = before.busy && mode === 'enqueue';
      st.sends++;
      this.patch(st, { status: 'running', error: null });
      try {
        const accepted = await this.withSession(st, sdk, () => sdk.send({
          prompt: text, mode,
          attachments,
        }));
        if (typeof accepted !== 'string' || !accepted) throw new Error('Native message acceptance receipt is missing; delivery is unconfirmed');
        if (st.sdk !== sdk) throw new Error('Native session closed during send; delivery is uncertain');
        if (!st.sendReceipts.has(accepted)) {
          st.accepted.add(accepted);
          if (mode === 'immediate' && before.processing.processing) st.steeringAccepted.add(accepted);
        }
        return { ok: true, ...(queued ? { queued: true } : {}) };
      } catch (error) {
        this.patch(st, { status: 'error', error: messageOf(error) });
        throw error;
      } finally {
        st.sends--;
        if (!st.sends) st.sendReceipts.clear();
        this.scheduleSync(st);
      }
    }));
  }

  async cancel(id: string): Promise<void> {
    const st = await this.state(id);
    this.assertAdmission(st);
    if (st.cancelling) return st.cancelling;
    if (st.load || st.operations) return Promise.reject(new Error('Session operation is still in progress'));
    this.patch(st, { cancelling: true, error: null });
    st.cancelling = this.untilFatal(async () => {
      const sdk = await this.liveSession(st);
      if (!sdk) return;
      await this.withSession(st, sdk, () => sdk.rpc.queue.clear());
      await this.withSession(st, sdk, () => sdk.abort());
      for (const decision of st.decisions.values()) decision.reject(new Error('Native request cancelled'));
      st.decisions.clear();
      st.accepted.clear();
      st.steeringAccepted.clear();
      this.projectDecisions(st);
      await this.syncNative(st);
      // Abort acknowledges cancellation, but native work can take another event
      // cycle to settle. Keep projecting that activity instead of reporting a
      // successful cancellation as an HTTP failure.
    }).catch(error => {
      this.patch(st, { error: messageOf(error) });
      throw error;
    }).finally(() => {
      st.cancelling = undefined;
      this.patch(st, { cancelling: false });
      this.invalidate(st, ['control', 'queue']);
      this.release(st);
    });
    return st.cancelling;
  }

  private clearInterruptedTurn(st: State, target: NonNullable<State['interruptTurn']>): void {
    for (const [id, decision] of target.decisions) {
      if (st.decisions.get(id) !== decision) continue;
      decision.reject(new Error('Native main turn interrupted'));
      st.decisions.delete(id);
    }
    target.decisions.clear();
    this.projectDecisions(st);
    if (st.turnEpoch !== target.epoch) return;
    st.interruptedEpoch = target.epoch;
  }

  async interrupt(id: string): Promise<IntentResult<'session/interrupt'>> {
    const st = await this.state(id);
    if (st.interrupting) return st.interrupting;
    if (st.load || st.operations || st.cancelling) return Promise.reject(new Error('Session operation is still in progress'));
    const pending = this.operation(id, async (sdk) => {
      const target = { epoch: st.turnEpoch, interactionId: st.interactionId, decisions: new Map(st.decisions) };
      st.interruptTurn = target;
      const result = await sdk.rpc.interruptMainTurn({ flushQueued: true });
      if (st.sdk !== sdk || this.failure) throw new Error('Native session closed during interrupt; outcome is uncertain');
      if (result.interrupted) this.clearInterruptedTurn(st, target);
      if (st.interruptTurn === target) st.interruptTurn = undefined;
      await this.syncNative(st);
      return { ok: true as const, interrupted: result.interrupted };
    }, 'read', st, ['control', 'queue']).finally(() => {
      if (st.interrupting === pending) st.interrupting = undefined;
    });
    st.interrupting = pending;
    return pending;
  }

  async removeQueued(id: string, itemId: string): Promise<void> {
    await this.operation(id, async (sdk, st) => {
      const { items } = await this.withSession(st, sdk, () => sdk.rpc.queue.pendingItems());
      const removedIds = items.filter(item => item.id === itemId).flatMap(item => item.messageId ? [item.messageId] : []);
      const result = await this.withSession(st, sdk, () => sdk.rpc.queue.removeAt({ id: itemId }));
      if (!result.removed) throw new Error('Queued item is no longer addressable');
      for (const messageId of removedIds) st.accepted.delete(messageId);
      await this.syncNative(st);
    }, ['control', 'queue']);
  }

  async control(id: string, token: string, action: SessionControlAction): Promise<SessionControlResult> {
    if (action.type === 'clear-tasks') {
      if (!action.ids.length || new Set(action.ids).size !== action.ids.length) {
        throw Object.assign(new Error('Clear tasks requires nonempty unique native task IDs'), { statusCode: 400 });
      }
      action = { ...action, ids: [...action.ids] };
    }
    const st = this.sessions.get(id);
    this.assertAvailable();
    if (!st?.sdk) throw new SessionUnloadedError();
    const sdk = st.sdk;
    const assertOwner = () => {
      this.assertAdmission(st);
      if (st.sdk !== sdk || st.controlToken !== token) throw Object.assign(
        new Error('Session controls belong to a different native handle; refresh before retrying'),
        { statusCode: 409, code: 'STALE_SESSION_CONTROLS' },
      );
      if (st.load || st.cancelling || st.interrupting) throw new Error('Session operation is still in progress');
    };
    assertOwner();
    const admittedTurn = { epoch: st.turnEpoch, interactionId: st.interactionId, decisions: new Map(st.decisions) };
    st.operations++;
    this.patch(st, { activeOperations: st.operations });
    try {
      return await this.serializeMutation(st, 'controlGate', async () => {
        assertOwner();
        if (!await this.liveSession(st)) throw new SessionUnloadedError();
        assertOwner();
        const outcomes: SessionControlResult['outcomes'] = [];
        const acceptedAtDispatch = new Set(st.accepted);
        const forgetReceipt = (receipt: string) => {
          st.accepted.delete(receipt);
          st.steeringAccepted.delete(receipt);
        };
        const assertOriginalTurn = () => {
          if (st.turnEpoch !== admittedTurn.epoch || st.interactionId !== admittedTurn.interactionId) {
            throw new Error('Main turn changed during Stop; the newer turn was not interrupted');
          }
        };
        type Outcome = SessionControlResult['outcomes'][number];
        // Unlike a read race, this lease lasts until the actual RPC settles.
        // Closing a native handle must not release an outstanding control write.
        const native = async <T>(work: () => Promise<T>): Promise<T> => {
          assertOwner();
          return await work();
        };
        const attempt = async (
          operation: string, targetId: string | undefined,
          work: (outcome: Outcome, mutate: <T extends object | void>(work: () => Promise<T>) => Promise<T>) => Promise<void>,
        ) => {
          const outcome: Outcome = { operation, ...(targetId ? { targetId } : {}), state: 'failed' };
          outcomes.push(outcome);
          let dispatched = false;
          try {
            await work(outcome, async work => {
              assertOwner();
              dispatched = true;
              const result = await work();
              if (result && typeof result === 'object') outcome.result = { ...result };
              if (st.sdk !== sdk || this.failure) throw new Error('Native handle closed during control; outcome is uncertain');
              return result;
            });
          } catch (error) {
            outcome.state = dispatched ? 'unconfirmed' : 'failed';
            outcome.error = messageOf(error);
          }
        };
        const taskById = async (taskId: string, kind?: 'agent' | 'shell', allowMissing = false) => {
          const rows = (await native(() => sdk.rpc.tasks.list())).tasks.filter(task => task.id === taskId);
          if (!rows.length && allowMissing) return undefined;
          const task = rows.length === 1 ? rows[0] : undefined;
          if (!task || (task.type !== 'agent' && task.type !== 'shell') || (kind && task.type !== kind)) {
            throw new Error('Task is not an addressable agent/shell in this session');
          }
          if (!['running', 'idle', 'completed', 'failed', 'cancelled'].includes(task.status)) {
            throw new Error('Native task status is unknown');
          }
          return task;
        };
        const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
        const cancelTask = async (taskId: string, kind?: 'agent' | 'shell', allowMissing = false) => {
          await attempt('tasks.cancel', taskId, async (outcome, mutate) => {
            const task = await taskById(taskId, kind, allowMissing);
            if (!task || terminal(task.status)) { outcome.state = 'unchanged'; return; }
            if (task.status !== 'running') throw new Error('Task is not running; idle records are not cancelled');
            const result = await mutate(() => sdk.rpc.tasks.cancel({ id: taskId }));
            if (result.cancelled === true) { outcome.state = 'accepted'; return; }
            if (result.cancelled !== false) throw new Error('Native task cancellation result is incomplete');
            const after = await taskById(taskId, kind, true);
            outcome.state = !after || terminal(after.status) ? 'unchanged' : 'failed';
            if (outcome.state === 'failed') outcome.error = 'Native task cancellation returned false and the task is not terminal';
          });
        };
        const clearQueue = async () => {
          await attempt('queue.clear', undefined, async (outcome, mutate) => {
            const before = await native(() => sdk.rpc.queue.pendingItems());
            const steering = new Set(st.steeringAccepted);
            await mutate(() => sdk.rpc.queue.clear());
            outcome.state = 'accepted';
            // Prompt acceptance shares controlGate, so these receipts belong to
            // the cleared lanes, never to a concurrently accepted newer prompt.
            for (const item of before.items) if (item.messageId) forgetReceipt(item.messageId);
            for (const receipt of steering) forgetReceipt(receipt);
          });
        };
        switch (action.type) {
          case 'stop-task':
            await cancelTask(action.id);
            break;
          case 'clear-tasks':
            for (const taskId of action.ids) {
              await cancelTask(taskId, action.kind);
              await attempt('tasks.remove', taskId, async (outcome, mutate) => {
                const task = await taskById(taskId, action.kind, true);
                if (!task) { outcome.state = 'unchanged'; return; }
                if (!terminal(task.status)) {
                  outcome.state = 'unchanged';
                  outcome.error = 'Task is still non-terminal; its native record was retained';
                  return;
                }
                const result = await mutate(() => sdk.rpc.tasks.remove({ id: taskId }));
                outcome.state = result.removed === true ? 'accepted' : result.removed === false ? 'failed' : 'unconfirmed';
                if (outcome.state !== 'accepted') outcome.error = 'Native task removal was not confirmed';
              });
            }
            break;
          case 'clear-queue':
            await clearQueue();
            break;
          case 'remove':
          case 'steer':
            await attempt(action.type === 'remove' ? 'queue.removeAt' : 'queue.sendNow', action.id, async (outcome, mutate) => {
              const queue = await native(() => sdk.rpc.queue.pendingItems());
              const rows = queue.items.filter(item => item.id === action.id);
              if (!rows.length) throw new Error('Queue item is no longer pending in this session');
              if (action.type === 'steer') {
                if (!this.queueProjection(queue).find(item => item.id === action.id)?.canSteer) {
                  throw new Error('Queue item is not an eligible native message');
                }
                const result = await mutate(() => sdk.rpc.queue.sendNow({ id: action.id }));
                outcome.state = result.steered === true ? 'accepted' : result.steered === false ? 'unchanged' : 'unconfirmed';
                if (result.steered === true) for (const row of rows) {
                  if (row.messageId && st.accepted.has(row.messageId)) st.steeringAccepted.add(row.messageId);
                }
              } else {
                const result = await mutate(() => sdk.rpc.queue.removeAt({ id: action.id }));
                outcome.state = result.removed === true ? 'accepted' : result.removed === false ? 'failed' : 'unconfirmed';
                if (result.removed === true) for (const row of rows) {
                  if (row.messageId) forgetReceipt(row.messageId);
                }
              }
            });
            break;
          case 'cancel-decision':
            await attempt(`decision.${action.kind}`, action.requestId, async (outcome, mutate) => {
              const kind = action.kind === 'plan' ? 'planRequest' : action.kind;
              const decision = st.decisions.get(action.requestId);
              if (!decision || decision.kind !== kind) throw new Error('Request is no longer pending');
              if (kind === 'planRequest') {
                const request = decision.value as NonNullable<SessionMeta['planRequest']>;
                if (!request.actions?.includes('exit_only')) throw new Error('Native plan request does not offer exit_only');
                this.answer(st, action.requestId, kind, { approved: true, selectedAction: 'exit_only' });
                outcome.state = 'accepted';
              } else if (kind === 'elicitation') {
                this.answer(st, action.requestId, kind, { action: 'cancel' });
                outcome.state = 'accepted';
              } else {
                if (decision.epoch !== st.turnEpoch || decision.interactionId !== st.interactionId) {
                  throw new Error('Request no longer belongs to the current main turn');
                }
                const target = { epoch: decision.epoch, interactionId: decision.interactionId,
                  decisions: new Map(st.decisions) };
                st.interruptTurn = target;
                try {
                  const result = await mutate(() => sdk.rpc.interruptMainTurn({ flushQueued: true }));
                  if (result.interrupted === true) {
                    this.clearInterruptedTurn(st, target);
                    outcome.state = 'accepted';
                  } else {
                    outcome.state = result.interrupted === false ? 'unchanged' : 'unconfirmed';
                  }
                } finally {
                  if (st.interruptTurn === target) st.interruptTurn = undefined;
                }
              }
            });
            break;
          case 'stop-all': {
            let taskIds: string[] = [];
            await attempt('tasks.snapshot', undefined, async outcome => {
              assertOriginalTurn();
              taskIds = (await native(() => sdk.rpc.tasks.list())).tasks.filter(task =>
                (task.type === 'agent' || task.type === 'shell') && task.status === 'running').map(task => task.id);
              assertOriginalTurn();
              outcome.state = 'unchanged';
            });
            if (st.turnEpoch !== admittedTurn.epoch || st.interactionId !== admittedTurn.interactionId
              || st.sdk !== sdk || st.controlToken !== token) break;
            const target = admittedTurn;
            await clearQueue();
            await settled([
              attempt('session.abort', undefined, async (outcome, mutate) => {
                assertOriginalTurn();
                st.interruptTurn = target;
                try {
                  const result = await mutate(() => sdk.rpc.abort({}));
                  outcome.state = result.success === true ? 'accepted' : result.success === false ? 'failed' : 'unconfirmed';
                  if (result.success === true) {
                    this.clearInterruptedTurn(st, target);
                    for (const receipt of acceptedAtDispatch) forgetReceipt(receipt);
                  }
                  else outcome.error = result.error || 'Native turn abortion was not confirmed';
                } finally {
                  if (st.interruptTurn === target) st.interruptTurn = undefined;
                }
              }),
              (async () => { for (const taskId of new Set(taskIds)) await cancelTask(taskId, undefined, true); })(),
              attempt('history.abortManualCompaction', undefined, async (outcome, mutate) => {
                assertOriginalTurn();
                const result = await mutate(() => sdk.rpc.history.abortManualCompaction());
                outcome.state = result.aborted === true ? 'accepted' : result.aborted === false ? 'unchanged' : 'unconfirmed';
              }),
              attempt('history.cancelBackgroundCompaction', undefined, async (outcome, mutate) => {
                assertOriginalTurn();
                const result = await mutate(() => sdk.rpc.history.cancelBackgroundCompaction());
                outcome.state = result.cancelled === true ? 'accepted' : result.cancelled === false ? 'unchanged' : 'unconfirmed';
              }),
            ]);
            break;
          }
        }
        return { ok: outcomes.every(outcome => outcome.state === 'accepted' || outcome.state === 'unchanged'), outcomes };
      });
    } finally {
      st.operations--;
      this.patch(st, { activeOperations: st.operations });
      this.invalidate(st, ['control', 'queue', 'tasks']);
      this.release(st);
    }
  }

  private localBusy(st: State, ownTransition = false): boolean {
    return (!ownTransition && st.closing) || st.operations > 0 || !!st.load
      || !!st.cancelling || st.decisions.size > 0 || st.sends > 0 || st.accepted.size > 0;
  }

  private async busy(st: State, ownTransition = false): Promise<boolean> {
    if (this.localBusy(st, ownTransition)) return true;
    const revision = st.revision;
    const sdk = await this.liveSession(st);
    const active = !!sdk && (await this.readControl(st, sdk)).busy;
    return active || this.localBusy(st, ownTransition) || st.revision !== revision;
  }

  async busyCount(): Promise<number> {
    if (this.lifecycle || this.births || this.creating.size || this.startPromise || this.removing.size) return 1;
    let count = 0;
    for (const st of this.sessions.values()) if (await this.busy(st)) count++;
    return count;
  }

  private async checkIdle(st: State): Promise<void> {
    await this.liveSession(st);
    if (st.load || st.operations || st.cancelling || st.decisions.size || st.sends || st.accepted.size) {
      throw Object.assign(new Error('Session has protected work'), { statusCode: 409, code: 'SESSION_BUSY' });
    }
    if (await this.busy(st, true)) {
      throw Object.assign(new Error('Session has protected work (turn, task, queue, decision, or operation)'), {
        statusCode: 409, code: 'SESSION_BUSY',
      });
    }
  }

  private async close(st: State): Promise<void> {
    if (!st.sdk) return;
    const sdk = st.sdk;
    await this.untilFatal(() => this.runtime.closeSession(sdk));
    if (st.sdk === sdk) this.detach(st);
  }

  private detach(st: State, error?: Error): void {
    const sdk = st.sdk;
    st.eventOwner = undefined;
    st.sdk = null;
    st.controlToken = undefined;
    st.observedCompaction = false;
    st.manualCompactions = 0;
    st.interruptTurn = undefined;
    st.interruptedEpoch = undefined;
    st.interactionId = undefined;
    if (sdk) this.bus.emit('closed', sdk);
    st.sendReceipts.clear();
    st.accepted.clear();
    st.steeringAccepted.clear();
    for (const decision of st.decisions.values()) decision.reject(error ?? new Error('Native session closed'));
    st.decisions.clear();
    this.patch(st, {
      loaded: false, status: error ? 'error' : 'unloaded', nativeProcessing: false, activity: null, controls: null,
      appliedRoles: [], rolesNeedReload: false,
      activeSubagents: 0, activeMcpOperations: 0, compacting: false,
      queue: [], ask: null, planRequest: null, elicitation: null, intent: null,
      ...(error ? { error: error.message } : {}),
    });
    this.release(st);
  }

  private async transition<T>(st: State, work: () => Promise<T>): Promise<T> {
    this.assertAdmission(st);
    if (st.closing || st.load || st.operations || st.cancelling) throw new Error('Session operation is in progress');
    st.closing = true;
    this.patch(st, { closing: true });
    try {
      await this.untilFatal(() => this.checkIdle(st));
      return await this.untilFatal(work);
    } catch (error) {
      this.patch(st, { error: messageOf(error) });
      throw error;
    } finally {
      st.closing = false;
      if (this.sessions.get(st.id) === st) this.patch(st, { closing: false });
      this.release(st);
    }
  }

  async unload(id: string): Promise<void> {
    const st = await this.state(id);
    await this.transition(st, () => this.close(st));
  }
  async load(id: string): Promise<void> {
    const st = await this.state(id);
    if (!st.sdk && !st.load && !await this.runtime.getSessionMetadata(id)) throw new Error(`Unknown session: ${id}`);
    await this.operation(id, async () => {}, 'work', st);
  }

  async reload(id: string): Promise<void> {
    const st = await this.state(id);
    await this.transition(st, () => this.close(st));
    await this.ensureLoaded(st);
  }

  async initializeSessionTools(id: string): Promise<void> {
    const st = await this.state(id);
    if (!st.sdk) { this.release(st); throw new SessionUnloadedError(); }
    await this.transition(st, async () => {
      const sdk = st.sdk;
      if (!sdk) throw new SessionUnloadedError();
      await this.initializeTools(st, sdk);
    });
  }

  private async initializeTools(st: State, sdk: CopilotSession) {
    await this.withSession(st, sdk, () => sdk.rpc.tools.initializeAndValidate());
    // Configuration changes can invalidate the native table without removing tools.
    const metadata = await this.withSession(st, sdk, () => sdk.rpc.tools.getCurrentMetadata());
    if (!Array.isArray(metadata.tools)) throw new Error('Native tool initialization is unconfirmed; metadata is unavailable');
    return metadata.tools;
  }

  async prepareSessionResources(input: SessionResourcesPrepare): Promise<ResourcePreparationResult> {
    const selection = SessionResourcesPrepare.parse(input);
    const errorMessage = (error: unknown) => {
      const message = messageOf(error);
      const suffix = '... [truncated]';
      return message.length > RESOURCE_PREPARATION_ERROR_LIMIT
        ? message.slice(0, RESOURCE_PREPARATION_ERROR_LIMIT - suffix.length) + suffix : message;
    };
    const st = await this.state(selection.sessionId);
    if (!st.sdk) { this.release(st); throw new SessionUnloadedError(); }
    const result: ResourcePreparationResult = {
      sessionId: selection.sessionId, ok: false,
      skills: (selection.skills ?? []).map(name => ({ name, effect: 'not_attempted', enabled: null })),
      mcpServers: (selection.mcpServers ?? []).map(({ name }) =>
        ({ name, effect: 'not_attempted', enabled: null, status: null, tools: null })),
      tools: 'not_attempted',
    };
    let entered = false;
    try {
      return await this.transition(st, async () => {
        entered = true;
        const sdk = st.sdk;
        try {
          if (!sdk) throw new SessionUnloadedError();
          const roleState = this.roleState(st.id, st);
          if (roleState.rolesNeedReload) {
            throw new Error('Saved roles differ from this native handle; explicitly reload when idle before resource preparation');
          }
          const applied = st.roleAssembly;
          if (roleState.roles.length || applied) {
            const provider = this.roles;
            if (!provider || !applied) throw new Error('Current role assembly is unconfirmed for resource preparation');
            const current = await this.withSession(st, sdk, () => provider.assemble(st.id, roleState.roles));
            if (current.fingerprint !== applied.fingerprint) {
              throw new Error('Current role resources differ from this native handle; resource preparation was not attempted');
            }
            if (this.roleState(st.id, st).rolesNeedReload || st.roleAssembly !== applied) {
              throw new Error('Roles changed during resource preparation preflight');
            }
          }
          const readSkills = () => this.withSession(st, sdk, () => sdk.rpc.skills.list());
          const readMcp = () => this.withSession(st, sdk, () => sdk.rpc.mcp.list());
          const observeSkill = (value: Awaited<ReturnType<typeof readSkills>>, item: ResourcePreparationResult['skills'][number]) => {
            const matches = value.skills.filter(skill => skill.name === item.name);
            if (matches.length !== 1 || typeof matches[0]!.enabled !== 'boolean') {
              throw new Error(`Native skill is unknown or unconfirmed: ${item.name}`);
            }
            item.enabled = matches[0]!.enabled;
          };
          const observeMcp = (value: ResourceValues['mcp'], item: ResourcePreparationResult['mcpServers'][number]) => {
            const matches = value.servers.filter(server => server.name === item.name);
            if (matches.length !== 1) throw new Error(`Native MCP is unknown or unconfirmed: ${item.name}`);
            Object.assign(item, this.mcpServerState(value, item.name, matches[0]));
            if (typeof value.host?.mcp3pEnabled !== 'boolean'
              || !Array.isArray(value.host.disabledServers) || !Array.isArray(value.host.filteredServers)) {
              throw new Error(`Native MCP host state is unconfirmed: ${item.name}`);
            }
          };
          const requireMcp = (value: ResourceValues['mcp'], item: ResourcePreparationResult['mcpServers'][number], preflight = false) => {
            if (!value.host!.mcp3pEnabled || value.host!.filteredServers.includes(item.name)) {
              throw new Error(`Native MCP is disabled by host policy or filtered: ${item.name}`);
            }
            if (item.status !== 'connected' && !(preflight && item.status === 'disabled')) {
              throw new Error(`Native MCP is ${item.status}: ${item.name}`);
            }
            if (!preflight && item.enabled !== true) throw new Error(`Native MCP enablement is unconfirmed: ${item.name}`);
          };

          // Resolve every selected identity and policy before the first mutation.
          if (result.skills.length) {
            const value = await readSkills();
            for (const item of result.skills) {
              observeSkill(value, item);
              if (item.enabled) item.effect = 'unchanged';
            }
          }
          if (result.mcpServers.length) {
            const value = await readMcp();
            for (const item of result.mcpServers) {
              observeMcp(value, item);
              if (item.enabled) item.effect = 'unchanged';
            }
            for (const item of result.mcpServers) requireMcp(value, item, true);
          }
          for (const item of result.skills) {
            if (item.enabled) continue;
            item.effect = 'unconfirmed'; item.enabled = null;
            await this.withSession(st, sdk, () => sdk.rpc.skills.enable({ name: item.name }));
            observeSkill(await readSkills(), item);
            if (!item.enabled) throw new Error(`Native skill enablement is unconfirmed: ${item.name}`);
            item.effect = 'enabled';
          }
          for (const item of result.mcpServers) {
            if (item.enabled) continue;
            item.effect = 'unconfirmed'; item.enabled = null; item.status = null;
            try {
              await this.withSession(st, sdk, () => sdk.rpc.mcp.enable({ serverName: item.name }));
            } catch (error) {
              // A rejected enable can leave a live connector. Observe once, never retry it.
              try {
                observeMcp(await readMcp(), item);
                if (item.enabled) item.effect = 'enabled';
              } catch (readError) {
                throw new Error(`${messageOf(error)}; MCP readback unconfirmed: ${messageOf(readError)}`);
              }
              throw error;
            }
            const value = await readMcp();
            observeMcp(value, item);
            if (item.enabled) item.effect = 'enabled';
            requireMcp(value, item);
          }
          result.tools = 'unconfirmed';
          const metadata = await this.withSession(st, sdk, () => sdk.rpc.tools.getCurrentMetadata());
          // MCP enable can retain a non-null stale table; a confirmed change needs one rebuild too.
          const initialize = metadata.tools === null || result.skills.some(item => item.effect === 'enabled')
            || result.mcpServers.some(item => item.effect === 'enabled');
          const tools = initialize ? await this.initializeTools(st, sdk) : metadata.tools;
          if (!Array.isArray(tools)) throw new Error('Native tool metadata is unconfirmed');
          result.tools = initialize ? 'initialized' : 'unchanged';
          for (const [index, item] of result.mcpServers.entries()) {
            const requested = selection.mcpServers![index]!.tools;
            const offered = new Set<string>();
            for (const tool of tools.filter(tool => tool.mcpServerName === item.name)) {
              const name = tool.mcpToolName;
              if (typeof name !== 'string' || !name.trim() || name.length > 200) {
                throw new Error(`Native MCP tool identity is unconfirmed: ${item.name}`);
              }
              offered.add(name);
            }
            item.tools = requested?.length ? requested.filter(name => offered.has(name)) : [...offered].slice(0, 1);
          }
          if (result.skills.length) {
            const value = await readSkills();
            for (const item of result.skills) {
              observeSkill(value, item);
              if (!item.enabled) throw new Error(`Native skill is no longer enabled: ${item.name}`);
            }
          }
          if (result.mcpServers.length) {
            const value = await readMcp();
            for (const item of result.mcpServers) observeMcp(value, item);
            for (const [index, item] of result.mcpServers.entries()) {
              requireMcp(value, item);
              const requested = selection.mcpServers![index]!.tools;
              if (!item.tools?.length || (requested?.length && item.tools.length !== requested.length)) {
                throw new Error(`Selected native MCP tools are not currently offered: ${item.name}`);
              }
            }
          }
          result.ok = true;
        } catch (error) {
          result.error = errorMessage(error);
          this.patch(st, { error: result.error });
        } finally {
          this.invalidate(st, ['skills', 'mcp', 'usage']);
        }
        return result;
      });
    } catch (error) {
      if (!entered) throw error;
      result.ok = false;
      result.error = errorMessage(error);
      return result;
    }
  }

  async stop(): Promise<void> {
    if (this.failure) {
      this.fail(this.failure);
      await this.runtime.stop();
      this.stopped = true;
      return;
    }
    if (this.lifecycle || this.births || this.creating.size || this.startPromise || this.removing.size) {
      throw Object.assign(new Error('Engine lifecycle operation is in progress'), { statusCode: 409, code: 'SESSION_BUSY' });
    }
    const all = [...this.sessions.values()];
    if (all.some(st => st.closing || st.load || st.operations || st.cancelling)) {
      throw Object.assign(new Error('Session operation is in progress'), { statusCode: 409, code: 'SESSION_BUSY' });
    }
    this.lifecycle = true;
    for (const st of all) { st.closing = true; this.patch(st, { closing: true }); }
    try {
      for (const st of all) await this.checkIdle(st);
      for (const st of all) { await this.checkIdle(st); await this.close(st); }
      await this.runtime.stop();
      this.started = false;
      this.stopped = true;
      this.agentStatus = 'stopping';
      this.emit({ type: 'agent/status', status: 'stopping' });
    } finally {
      for (const st of all) { st.closing = false; this.patch(st, { closing: false }); this.release(st); }
      this.lifecycle = false;
      this.bus.emit('activity-settled');
    }
  }

  async setModel(id: string, modelId: string, reasoningEffort?: string, contextTier?: 'default' | 'long_context') {
    return this.operation(id, (sdk, st) => this.serializeMutation(st, 'modelGate', async () => {
      const options = {
        modelId,
        deferIfModelChangeQueued: true,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(contextTier !== undefined ? { contextTier } : {}),
      };
      if (reasoningEffort !== undefined || contextTier === 'long_context') {
        const [models, catalog] = await this.withSession(st, sdk, () => settled([
          sdk.rpc.model.list(), this.runtime.models(),
        ] as const));
        const option = sessionModelOptions(models.list, catalog).find(model => model.modelId === modelId);
        if (reasoningEffort !== undefined && !option?.supportedReasoningEfforts?.includes(reasoningEffort)) {
          throw new Error(`Native model ${modelId} does not list reasoning effort ${reasoningEffort}`);
        }
        if (contextTier === 'long_context' && option?.supportsLongContext !== true) {
          throw new Error(`Native model ${modelId} does not list long-context support`);
        }
      }
      const result = await this.withSession(st, sdk, () => sdk.rpc.model.switchTo(options));
      if (result.deferred) this.scheduleSync(st);
      return NativeModelSwitchResult.parse(result);
    }), ['model', 'models', 'usage', 'control', 'queue']);
  }
  async setMode(id: string, mode: 'interactive' | 'plan' | 'autopilot') {
    return this.operation(id, async (sdk, st) => {
      const result = await this.withSession(st, sdk, () => sdk.rpc.mode.set({ mode }));
      return NativeModeSetResult.parse(result);
    }, ['mode', 'model', 'models', 'usage']);
  }
  async rename(id: string, name: string): Promise<string> {
    if (!name.trim()) throw new Error('Session name must not be empty');
    return this.operation(id, async (sdk, st) => {
      await this.withSession(st, sdk, () => sdk.rpc.name.set({ name: name.trim() }));
      const title = (await this.withSession(st, sdk, () => sdk.rpc.name.get())).name;
      if (!title) throw new Error('Native rename was not confirmed');
      this.patch(st, { title });
      return title;
    }, ['identity']);
  }
  async compact(id: string, customInstructions?: string) {
    return this.operation(id, async (sdk, st) => {
      const token = st.controlToken;
      st.manualCompactions++;
      this.patch(st, { compacting: true });
      this.invalidate(st, ['controls']);
      try {
        return NativeCompactResult.parse(await this.withSession(st, sdk, () => sdk.rpc.history.compact({ customInstructions })));
      }
      finally {
        if (st.sdk === sdk && st.controlToken === token) {
          st.manualCompactions = Math.max(0, st.manualCompactions - 1);
          this.patch(st, { compacting: st.manualCompactions > 0 || st.observedCompaction });
        }
      }
    }, ['usage', 'controls']);
  }
  async rewind(id: string, toMsgId: string, rollbackFiles = false) {
    const st = await this.state(id);
    await this.ensureLoaded(st);
    return this.transition(st, async () => {
      const sdk = st.sdk;
      if (!sdk) throw new Error('Native session is unavailable; explicitly resume to rewind');
      const result = await this.withSession(st, sdk, () => sdk.rpc.history.rewind({
        eventId: toMsgId, mode: rollbackFiles ? 'conversation-and-files' : 'conversation',
      }));
      const mutated = (result.eventsRemoved ?? 0) > 0 || result.outcome === 'rollback-incomplete'
        || (result.outcome !== 'files-rolled-back' && result.restoredFiles.length > 0);
      if (mutated) {
        this.emit({ type: 'chat/invalidated', sessionId: id, reason: 'rewind' });
      }
      return NativeRewindResult.parse(result);
    });
  }

  async getUsage(id: string): Promise<SessionUsage> {
    this.assertAvailable();
    const st = this.sessions.get(id);
    if (!st?.sdk) throw new SessionUnloadedError();
    if (st.closing || this.lifecycle) throw new Error('Session lifecycle transition is in progress');
    // Protect these reads from close without loading or creating new work.
    st.operations++;
    this.patch(st, { activeOperations: st.operations });
    try {
      const sdk = await this.liveSession(st);
      if (!sdk) throw new SessionUnloadedError();
      if (typeof sdk.rpc.metadata.getContextAttribution !== 'function' || typeof sdk.rpc.usage?.getMetrics !== 'function') {
        throw new Error('Native usage/context read APIs are unavailable in this SDK');
      }
      const [context, usage] = await this.withSession(st, sdk, () => settled([
        sdk.rpc.metadata.getContextAttribution(), sdk.rpc.usage.getMetrics(),
      ] as const));
      return SessionUsage.parse({ sessionId: id, sampledAt: Date.now(), context: context.contextAttribution ?? null, usage });
    } finally {
      st.operations--;
      this.patch(st, { activeOperations: st.operations });
      this.release(st);
    }
  }

  async getPlan(id: string): Promise<SessionPlan> {
    return this.operation(id, async (sdk, st) => {
      const [plan, result] = await this.withSession(st, sdk, () => settled([sdk.rpc.plan.read(), this.readResource(st, sdk, 'todos')] as const));
      const todos: TodoItem[] = result.rows.filter(row => row.id && row.title).map(row => ({
        id: row.id!, title: row.title!, description: row.description ?? undefined,
        status: ['pending', 'in_progress', 'done', 'blocked'].includes(row.status ?? '') ? row.status as TodoItem['status'] : 'pending',
      }));
      return { planMarkdown: plan.content ?? null, todos };
    }, 'read');
  }

  async getPanels(id: string): Promise<SessionPanels> {
    return this.operation(id, async (sdk, st) => {
      const [skills, mcpServers, tasks, instructionSources, schedules] = await settled([
        this.readPanel(st, sdk, 'skills'), this.readPanel(st, sdk, 'mcpServers'),
        this.readPanel(st, sdk, 'tasks'), this.readPanel(st, sdk, 'instructionSources'), this.readPanel(st, sdk, 'schedules'),
      ] as const);
      return { skills, mcpServers, tasks, instructionSources, schedules };
    }, 'read');
  }

  async getPanel(id: string, section: PanelSection): Promise<PanelItem[]> {
    return this.operation(id, (sdk, st) => this.readPanel(st, sdk, section), 'read');
  }

  private readPanel(st: State, sdk: CopilotSession, section: PanelSection): Promise<PanelItem[]> {
    return this.withSession(st, sdk, async () => {
      switch (section) {
        case 'skills': return (await sdk.rpc.skills.list()).skills.map(s => ({ label: s.name, sublabel: s.source, enabled: s.enabled }));
        case 'mcpServers': {
          const mcp = await sdk.rpc.mcp.list();
          const disabled = new Set(mcp.host?.disabledServers);
          return mcp.servers.map(s => {
            const { status, enabled } = this.mcpServerState(mcp, s.name, s, disabled);
            return { label: s.name, sublabel: status, enabled };
          });
        }
        case 'tasks': return (await sdk.rpc.tasks.list()).tasks.map(t => ({ label: t.description || t.id, sublabel: t.status }));
        case 'instructionSources': return (await sdk.rpc.instructions.getSources()).sources.map(s => ({ label: s.label, sublabel: s.sourcePath }));
        case 'schedules': return (await sdk.rpc.schedule.list()).entries.map(s => ({ label: s.displayPrompt || s.prompt,
          sublabel: s.selfPaced ? `Self-paced (model-controlled) · next ${s.nextRunAt}` : s.nextRunAt }));
      }
    });
  }

  async listGlobalMcp(): Promise<McpServerGlobal[]> {
    const [definitions, discovered] = await this.untilFatal(() => settled([
      this.runtime.rpc.mcp.config.list(), this.runtime.rpc.mcp.discover({ workingDirectory: homedir() }),
    ] as const));
    const byName = new Map(discovered.servers.filter(server => server.source === 'user').map(server => [server.name, server]));
    return Object.entries(definitions.servers).map(([name, config]) => {
      const server = byName.get(name);
      if (!server || typeof server.enabled !== 'boolean') {
        throw new Error(`Native global MCP state is unconfirmed for ${name}`);
      }
      const modules = this.roles?.globalMcpSources?.(config);
      return { name, detail: describeMcpServer(config), connection: mcpConnection(config),
        defaultOn: server.enabled, config: redactMcpConfig(config),
        ...(modules?.length ? { modules } : {}) };
    });
  }
  async setMcpDefault(name: string, on: boolean): Promise<void> {
    if (!(await this.listGlobalMcp()).some(server => server.name === name)) throw new Error('Unknown global MCP server');
    await this.untilFatal(() => this.runtime.rpc.mcp.config[on ? 'enable' : 'disable']({ names: [name] }));
    const server = (await this.listGlobalMcp()).find(server => server.name === name);
    if (!server || server.defaultOn !== on) throw new Error('Native global MCP state did not confirm the requested change');
  }

  async listSessionMcp(id: string): Promise<{ loaded: boolean; servers: McpServerSession[] }> {
    const st = await this.state(id);
    if (!st.sdk) { this.release(st); return { loaded: false, servers: [] }; }
    try {
      return await this.operation(id, async (sdk, st) => {
        const result = await this.withSession(st, sdk, () => sdk.rpc.mcp.list());
        const disabled = new Set(result.host?.disabledServers);
        const sources = st.roleAssembly?.mcpSources;
        return { loaded: true, servers: result.servers.map(server => ({
          name: server.name, detail: server.sourcePlugin ?? server.source ?? 'native',
          ...(sources && Object.hasOwn(sources, server.name) ? { module: sources[server.name] } : {}),
          ...this.mcpServerState(result, server.name, server, disabled), error: server.error,
        })) };
      }, 'read');
    } catch (error) {
      if (error instanceof SessionUnloadedError) return { loaded: false, servers: [] };
      throw error;
    }
  }
  private mcpServerState(
    result: ResourceValues['mcp'], name: string,
    server: ResourceValues['mcp']['servers'][number] | undefined,
    disabled?: ReadonlySet<string>,
  ): Pick<McpServerSession, 'status' | 'enabled'> {
    if (!server || !result.host) throw new Error(`Native MCP state is unconfirmed for ${name}`);
    const status = server.status;
    switch (status) {
      case 'connected':
      case 'failed':
      case 'needs-auth':
      case 'pending':
      case 'disabled':
      case 'stopped':
      case 'not_configured':
        // Enablement is not connectivity: preserve native status even when the
        // host separately records an explicit disable or policy stops a server.
        return { status, enabled: status !== 'disabled' && status !== 'not_configured'
          && !(disabled ? disabled.has(name) : result.host.disabledServers.includes(name)) };
      default: {
        const unexpected: never = status;
        throw new Error(`Native MCP state is unconfirmed for ${name}: unknown status ${JSON.stringify(unexpected)}`);
      }
    }
  }
  async toggleSessionMcp(id: string, name: string, enabled: boolean): Promise<McpToggleResult> {
    return this.operation(id, async (sdk, st) => {
      if (st.mcpOperations) throw new Error('MCP mutation is already in progress');
      const operation: McpToggleOperation = { id: randomUUID(), desiredEnabled: enabled,
        state: 'running', startedAt: Date.now(), status: 'pending' };
      st.mcpOperations++;
      this.patchMcpPending(st);
      let applied = false;
      let submitted = false;
      try {
        const before = await this.withSession(st, sdk, () => sdk.rpc.mcp.list());
        if (before.host?.pendingConnections.length) throw new Error('MCP connections are still settling');
        const previous = before.servers.find(server => server.name === name);
        if (!previous) throw new Error(`Unknown native MCP server: ${name}`);
        this.mcpServerState(before, name, previous);
        submitted = true;
        await this.withSession(st, sdk, () => sdk.rpc.mcp[enabled ? 'enable' : 'disable']({ serverName: name }));
        const result = await this.readResource(st, sdk, 'mcp');
        const server = result.servers.find(server => server.name === name);
        const actual = this.mcpServerState(result, name, server);
        operation.status = actual.status;
        applied = actual.enabled === enabled && actual.status !== 'not_configured'
          && (!enabled || actual.status === 'connected');
        if (!applied) throw new Error(server?.error ?? 'Native MCP state did not confirm the requested change');
        operation.state = 'succeeded';
        return { ok: true, applied, sessionId: id, name, enabled, status: operation.status, operation };
      } catch (error) {
        this.assertAvailable();
        if (!submitted || st.sdk !== sdk) throw error;
        operation.state = 'failed';
        operation.error = messageOf(error);
        this.patch(st, { error: operation.error });
        // Enable may reject while a native connector is still alive. A failed
        // read-back is unknown, not evidence that the connector is disabled.
        let result: Awaited<ReturnType<CopilotSession['rpc']['mcp']['list']>>;
        let actual: Pick<McpServerSession, 'status' | 'enabled'>;
        try {
          result = await this.readResource(st, sdk, 'mcp');
          actual = this.mcpServerState(result, name, result.servers.find(server => server.name === name));
        }
        catch (readError) {
          this.assertAvailable();
          throw new Error(`${operation.error}; MCP state is unknown: ${messageOf(readError)}`);
        }
        operation.status = actual.status;
        if (result.host?.pendingConnections.length) operation.state = 'settling';
        return { ok: false, applied, sessionId: id, name,
          enabled: actual.enabled, status: operation.status, error: operation.error, operation };
      } finally {
        operation.completedAt = Date.now();
        st.mcpOperations--;
        this.patchMcpPending(st);
      }
    });
  }
  async refreshMcp(): Promise<void> {
    await this.untilFatal(() => this.runtime.rpc.mcp.config.reload());
    await this.listGlobalMcp();
  }
  async reloadSessionMcp(id: string): Promise<{ reconnected: number }> {
    const st = await this.state(id);
    if (!st.sdk) { this.release(st); throw new SessionUnloadedError(); }
    return this.transition(st, async () => {
      const sdk = st.sdk;
      if (!sdk) throw new SessionUnloadedError();
      await this.untilFatal(() => this.runtime.rpc.mcp.config.reload());
      st.mcpOperations++;
      this.patchMcpPending(st);
      try {
        // Native reload also reapplies global MCP choices; session overrides
        // are intentionally not restored by Cockpit.
        await this.withSession(st, sdk, () => sdk.rpc.mcp.reload());
        const result = await this.readResource(st, sdk, 'mcp');
        const disabled = new Set(result.host?.disabledServers);
        const failed = result.servers.filter(server => {
          const { status, enabled } = this.mcpServerState(result, server.name, server, disabled);
          return status === 'not_configured' || (enabled && status !== 'connected');
        });
        if (failed.length || result.host?.pendingConnections.length) throw new Error(`MCP connections not confirmed: ${failed.map(server => server.name).join(', ') || 'pending'}`);
        return { reconnected: result.servers.filter(server => server.status === 'connected').length };
      } finally {
        st.mcpOperations--;
        this.patchMcpPending(st);
      }
    });
  }

  private async discoverSkills(cwd?: string) {
    const result = await this.untilFatal(() => this.runtime.rpc.skills.discover({
      projectPaths: [resolve(cwd || homedir())],
    }));
    if (result.errors?.length) throw new Error(`Native skill discovery failed: ${result.errors.join('; ')}`);
    return result;
  }
  private async globalDisabledSkills(): Promise<string[]> {
    const settings = await this.untilFatal(() => this.runtime.rpc.user.settings.get());
    const disabled = settings.settings.disabledSkills?.value;
    if (disabled === null) return [];
    if (!Array.isArray(disabled) || !disabled.every(name => typeof name === 'string')) {
      throw new Error('Native global skill state is unconfirmed: disabledSkills must be a string array');
    }
    return disabled;
  }
  private async globalSkills(cwd?: string) {
    const [result, disabled] = await this.untilFatal(() => settled([
      this.discoverSkills(cwd), this.globalDisabledSkills(),
    ] as const));
    const names = new Set(disabled);
    return result.skills.map(skill => ({ ...skill, enabled: !names.has(skill.name) }));
  }
  async listGlobalSkills(cwd?: string) {
    const skills = await this.globalSkills(cwd);
    return Promise.all(skills.map(async ({ name, description, source, userInvocable, enabled, path }) => {
      const modules = path ? await this.roles?.globalSkillSources?.(path) : undefined;
      return { name, description, source, userInvocable, enabled, ...(modules?.length ? { modules } : {}) };
    }));
  }
  async readSkillBody(name: string, cwd?: string) {
    const skill = (await this.globalSkills(cwd)).find(skill => skill.name === name);
    if (!skill) throw new SkillNotFoundError();
    if (!skill.path) return unsupported('Skill body without a public local path');
    const modules = await this.roles?.globalSkillSources?.(skill.path);
    return { name: skill.name, description: skill.description, source: skill.source,
      userInvocable: skill.userInvocable, enabled: skill.enabled, body: readFileSync(skill.path, 'utf8'),
      ...(modules?.length ? { modules } : {}) };
  }
  async setGlobalSkill(name: string, enabled: boolean, cwd?: string): Promise<void> {
    if (!(await this.globalSkills(cwd)).some(skill => skill.name === name)) throw new Error('Unknown skill in this working directory');
    await this.untilFatal(() => this.runtime.rpc.skills.config.setSkillDisabled({ name, disabled: !enabled }));
    const skill = (await this.globalSkills(cwd)).find(skill => skill.name === name);
    if (!skill || skill.enabled !== enabled) throw new Error('Native global skill state did not confirm the requested change');
  }
  async listSessionSkills(id: string): Promise<SkillSession[]> {
    return this.operation(id, async (sdk, st) => (await this.withSession(st, sdk, () => sdk.rpc.skills.list())).skills.map(
      ({ name, description, source, enabled, path }) => {
        const module = st.roleAssembly?.skills.find(skill => skill.name === name && skill.path === path)?.module;
        return { name, description, source, enabled, ...(module ? { module: { ...module } } : {}) };
      }), 'read');
  }
  async toggleSessionSkill(id: string, name: string, enabled: boolean): Promise<void> {
    await this.operation(id, async (sdk, st) => {
      await this.withSession(st, sdk, () => sdk.rpc.skills[enabled ? 'enable' : 'disable']({ name }));
      const skill = (await this.withSession(st, sdk, () => sdk.rpc.skills.list())).skills.find(skill => skill.name === name);
      if (!skill || skill.enabled !== enabled) throw new Error('Native skill state did not confirm the requested change');
    }, ['skills', 'usage']);
  }

  async refreshSkills(): Promise<void> {
    this.assertAvailable();
    const loaded = [...this.sessions.values()].filter(st => st.sdk);
    if (!loaded.length) {
      await this.discoverSkills();
      return;
    }
    for (const st of loaded) {
      await this.operation(st.id, async sdk => {
        const result = await sdk.rpc.skills.reload();
        const diagnostics = [...result.errors, ...result.warnings];
        if (diagnostics.length) throw new Error(`Native skill reload diagnostics: ${diagnostics.join('; ')}`);
      }, 'read', undefined, ['skills', 'usage']);
    }
  }

  async addSchedule(id: string, options: {
    prompt: string; interval?: string; at?: number; recurring?: boolean;
  }): Promise<{ entry?: ScheduleEntry; error?: string; possiblyCreated?: boolean }> {
    const unknown = Object.keys(options).filter(key => !['prompt', 'interval', 'at', 'recurring'].includes(key));
    if (unknown.length) throw new Error(`Unknown schedule options: ${unknown.join(', ')}`);
    if ((options.interval !== undefined) === (options.at !== undefined)) throw new Error('Exactly one of interval or at is required');
    if (!options.prompt.trim() || /[\r\n]/.test(options.prompt) || /(^|\s)--/.test(options.prompt) || options.prompt.trimStart().startsWith('/')) {
      throw new Error('Schedule prompt must be plain single-line text without command flags');
    }
    const prompt = options.prompt.trim();
    let seconds: number;
    if (options.at !== undefined) {
      if (options.recurring) return unsupported('Recurring absolute schedules');
      seconds = Math.ceil((options.at - Date.now()) / 1000);
    } else {
      const interval = /^([1-9]\d*)(s|m|h|d)$/.exec(options.interval!);
      if (!interval) return unsupported('Non-deterministic schedule interval');
      seconds = Number(interval[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[interval[2]!] ?? 0);
    }
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error('Schedule delay must be between 1 second and 24 hours');
    const recurring = options.at === undefined && (options.recurring ?? true);
    let dispatched = false;
    return this.operation(id, (sdk, st) => this.serializeMutation(st, 'scheduleGate', async () => {
      if (options.at !== undefined) {
        seconds = Math.ceil((options.at - Date.now()) / 1000);
        if (seconds < 1) throw new Error('Absolute schedule time passed while waiting for the runtime');
      }
      const before = new Set((await this.withSession(st, sdk, () => sdk.rpc.schedule.list())).entries.map(entry => entry.id));
      let result: Awaited<ReturnType<CopilotSession['rpc']['commands']['invoke']>>;
      try {
        dispatched = true;
        result = await this.withSession(st, sdk, () => sdk.rpc.commands.invoke({ name: recurring ? 'every' : 'after', input: `${seconds}s ${prompt}` }));
      } catch (error) {
        return { possiblyCreated: true, error: `Native schedule command acknowledgement is unknown; a schedule may have been created: ${messageOf(error)}. Do not retry automatically` };
      }
      let entries: Awaited<ReturnType<CopilotSession['rpc']['schedule']['list']>>['entries'];
      try {
        entries = (await this.readResource(st, sdk, 'schedule')).entries;
      } catch (error) {
        return { possiblyCreated: true, error: `Native schedule readback failed after command acknowledgement (${result.kind}); a schedule may have been created: ${messageOf(error)}. Do not retry automatically` };
      }
      const created = entries.find(entry => !before.has(entry.id) && entry.prompt === prompt
        && entry.recurring === recurring && entry.intervalMs === seconds * 1000);
      if (!created) return { possiblyCreated: true, error: `Native schedule was not confirmed (${result.kind}); a schedule may have been created. No model fallback or automatic retry was sent` };
      const entry = this.scheduleEntry(created);
      if (result.kind !== 'text' && result.kind !== 'completed') return { entry, error: `Native schedule created with unexpected command outcome: ${result.kind}` };
      return { entry };
    }), ['schedule']).catch(error => {
      if (!dispatched) throw error;
      // A fatal/closed-session race can win the enclosing operation before the
      // RPC catch runs. It cannot establish that a dispatched command did nothing.
      return { possiblyCreated: true, error: `Native schedule operation ended after dispatch; a schedule may have been created: ${messageOf(error)}. Do not retry automatically` };
    });
  }
  private serializeMutation<T>(st: State, gate: 'scheduleGate' | 'modelGate' | 'controlGate', work: () => Promise<T>): Promise<T> {
    const next = st[gate].then(work);
    st[gate] = next.then(() => {}, () => {});
    return next;
  }
  private scheduleEntry(raw: Awaited<ReturnType<CopilotSession['rpc']['schedule']['list']>>['entries'][number]): ScheduleEntry {
    const nextRunAt = Date.parse(raw.nextRunAt);
    if (!Number.isFinite(nextRunAt)) throw new Error('Native schedule contains an invalid nextRunAt');
    return { id: raw.id, prompt: raw.prompt, recurring: raw.recurring, nextRunAt,
      selfPaced: raw.selfPaced, intervalMs: raw.intervalMs, cron: raw.cron, tz: raw.tz, at: raw.at, displayPrompt: raw.displayPrompt };
  }
  async listSchedules(id: string): Promise<ScheduleEntry[]> {
    return this.operation(id, async (sdk, st) => {
      const entries = (await this.readResource(st, sdk, 'schedule')).entries;
      return entries.map(entry => this.scheduleEntry(entry));
    }, 'read');
  }
  async stopSchedule(id: string, scheduleId: number): Promise<boolean> {
    return this.operation(id, (sdk, st) => this.serializeMutation(st, 'scheduleGate', async () => {
      const result = await this.withSession(st, sdk, () => sdk.rpc.schedule.stop({ id: scheduleId }));
      return !!result.entry;
    }), ['schedule']);
  }

  async respondAsk(id: string, requestId: string, answer: string, wasFreeform: boolean): Promise<void> {
    this.answerPending(id, requestId, 'ask', { answer, wasFreeform });
  }
  async respondPlan(id: string, requestId: string, action: ExitPlanModeAction): Promise<void> {
    this.answerPending(id, requestId, 'planRequest', { approved: true, selectedAction: action });
  }
  async respondElicitation(id: string, requestId: string, action: 'accept' | 'decline' | 'cancel'): Promise<void> {
    this.answerPending(id, requestId, 'elicitation', { action });
  }
  async planSupersede(id: string, requestId: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error('Plan feedback must not be empty');
    this.answerPending(id, requestId, 'planRequest', { approved: false, feedback: message });
  }
  private answerPending(id: string, requestId: string, kind: DecisionKind, value: unknown): void {
    this.assertAvailable();
    const st = this.sessions.get(id);
    if (!st || st.closing || st.cancelling || this.lifecycle) throw new Error('Request is no longer pending or session is transitioning');
    this.answer(st, requestId, kind, value);
  }
  async deleteSession(id: string): Promise<void> {
    this.assertAvailable();
    if (this.stopped || this.lifecycle || this.startPromise || this.removing.has(id)) throw new Error('Session lifecycle transition is in progress');
    const st = await this.state(id);
    this.assertAdmission(st);
    if (this.removing.has(id)) throw new Error('Session removal is in progress');
    this.removing.add(id);
    try {
      await this.transition(st, async () => {
        // Native deletion is authoritative; never remove files to simulate success.
        await this.close(st);
        await this.untilFatal(() => this.runtime.deleteSession(id));
        this.sessions.delete(id);
        this.emit({ type: 'session/removed', sessionId: id });
      });
    } finally { this.removing.delete(id); this.release(st); }
  }

  chat(query: NativeChatRead, signal?: AbortSignal): Promise<NativeChatPage> {
    return this.untilFatal(async () => {
      query = NativeChatRead.parse(query);
      signal?.throwIfAborted();
      if (this.lifecycle || this.removing.has(query.sessionId)) throw new Error('Session lifecycle transition is in progress');
      const st = this.sessions.get(query.sessionId);
      this.assertReadable(st);
      if (this.creating.has(query.sessionId) && !st?.sdk) throw Object.assign(
        new Error('Native session creation is still awaiting acknowledgement'), { statusCode: 409, code: 'SESSION_TRANSITION' },
      );
      const sdk = st?.sdk;
      if (!sdk && !query.cursor && !await this.runtime.getSessionMetadata(query.sessionId)) {
        throw Object.assign(new Error('Session was not found.'), { statusCode: 404 });
      }
      const read = () => readNativeChat(query, {
        persisted: params => this.runtime.rpc.sessions.readPersistedEvents(params),
        live: sdk?.rpc.eventLog,
      }, signal);
      if (query.source !== 'live' || !st || !sdk) return read();
      try {
        return await this.withSession(st, sdk, read);
      } catch (error) {
        // Native idle cleanup can omit shutdown. Reconcile only a failed read,
        // never resume or make every streaming page pay for a liveness probe.
        if (!signal?.aborted && !this.failure && st.sdk === sdk && !await this.liveSession(st)) {
          throw Object.assign(new Error('Native session is unloaded; continue through persisted history or explicitly resume.'), {
            statusCode: 409, code: 'SESSION_UNLOADED',
          });
        }
        throw error;
      }
    });
  }

  listDir(path?: string): DirListing {
    let target = path === undefined ? homedir() : path.trim();
    if (!target) throw Object.assign(new Error('Directory path must not be empty; omit path to list the home directory.'), {
      statusCode: 400, code: 'INVALID_DIRECTORY_PATH',
    });
    if (target === '~' || target.startsWith('~/')) target = join(homedir(), target.slice(1));
    target = resolve(target);
    let names: string[];
    try {
      names = readdirSync(target);
      // Readable names without search permission would otherwise look like an empty directory.
      accessSync(target, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        const statusCode = error.code === 'ENOENT' ? 404 : error.code === 'ENOTDIR' ? 400
          : error.code === 'EACCES' || error.code === 'EPERM' ? 403 : undefined;
        if (statusCode !== undefined) Object.assign(error, { statusCode });
      }
      throw error;
    }
    const entries = names.filter(name => !name.startsWith('.')).flatMap(name => {
      try { return [{ name, isDir: statSync(join(target, name)).isDirectory() }]; }
      catch { return []; }
    }).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return { path: target, parent: dirname(target) === target ? null : dirname(target), entries };
  }

  private invalidate(st: State, resources?: SessionResource[]): void {
    if (this.sessions.get(st.id) !== st) return;
    if (!resources || resources.some(resource => ['control', 'controls', 'tasks', 'queue', 'mcp'].includes(resource))) {
      st.activityRevision++;
      this.patch(st, { activity: null, controls: null });
      if (resources && !resources.includes('control')) resources = [...resources, 'control'];
      if (resources && !resources.includes('controls')) resources = [...resources, 'controls'];
    }
    if (resources) {
      resources = resources.filter(resource => {
        if (!st.resourceWrites.has(resource)) return true;
        st.pendingInvalidations.add(resource);
        return false;
      });
      if (!resources.length) return;
    }
    this.emit({ type: 'session/invalidated', sessionId: st.id, resources });
  }

  private patch(st: State, fields: Partial<LiveMeta>): void {
    for (const key of ['currentReasoningEffort', 'currentContextTier', 'currentMode'] as const) {
      if (key in fields && fields[key] === undefined) fields[key] = null;
    }
    if (this.sessions.get(st.id) !== st) return;
    this.emit({ type: 'session/patch', ...structuredClone(fields), sessionId: st.id });
    // Patches already carry their changed values. Read leases do
    // not invalidate native resources. A settled lifecycle needs a fresh source.
    if (fields.loaded !== undefined || fields.closing === false) this.invalidate(st);
  }
}
