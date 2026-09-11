import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  CopilotSession, SessionConfig, SessionMetadata, SessionEvent,
  ExitPlanModeResult, ElicitationResult,
} from '@github/copilot-sdk';
import type {
  AgentStatus, Attention, DirListing, ExitPlanModeAction,
  McpServerGlobal, McpServerSession, McpToggleOperation, McpToggleResult,
  ModelOption, ScheduleEntry, ServerEvent, SessionMeta, SessionPanels,
  SessionBrief, SessionPlan, Snapshot, TodoItem, IntentResult, NativeChatPage,
  MetaResource, SessionResource, SessionProjection, PanelSection, PanelItem,
} from '@cockpit/protocol';
import { NativeChatRead, SessionUsage, MetaResource as MetaResources } from '@cockpit/protocol';
import { OfficialRuntime, sessionModelOptions } from './runtime.ts';
import { normalizeEvent, type RuntimeAttachment } from './sdk-types.ts';
import { cleanSessionTitle, extractParts } from './fold.ts';
import { engineSessionBusy } from './lifecycle.ts';
import { nextAttention, notificationSummary } from './attention.ts';
import { readNativeChat } from './native-chat.ts';
import { Prefs } from './prefs.ts';
import { describeMcpServer, redactMcpConfig } from './mcp-config.ts';
import { autoNameQuestion, firstNamingReply, generatedTitle } from './auto-name.ts';
import { validateForkHistory } from './fork.ts';
import { createContextReset } from './context-reset.ts';
import { bundledSkillsDirectory } from './paths.ts';

export { sessionMetaBusy, engineSessionBusy } from './lifecycle.ts';
export type EngineRuntime = Pick<OfficialRuntime,
  'start' | 'models' | 'listSessions' | 'createSession' | 'resumeSession' |
  'closeSession' | 'deleteSession' | 'getAuthStatus' | 'stop' | 'rpc' | 'liveCount' |
  'isSessionLive' | 'onSessionClosed' | 'onFatal' | 'failure' | 'getSessionMetadata'>;

// Parent transports can expose these limits without inventing runtime support.
export const coreCapabilities = {
  forkSession: {
    native: true, source: 'loaded-idle', boundary: 'before-root-user-event',
    schedules: false, workspaceIsolation: false, childLoaded: false,
  },
  purgeSession: true,
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
  value: NonNullable<SessionMeta[DecisionKind]>;
  answer: (value: unknown) => void;
  reject: (error: Error) => void;
  validate?: (value: unknown) => void;
}
type ResourceValues = {
  model: Awaited<ReturnType<CopilotSession['rpc']['model']['getCurrent']>>;
  models: Awaited<ReturnType<CopilotSession['rpc']['model']['list']>>;
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
  id: string;
  sdk: CopilotSession | null;
  contextReset?: ReturnType<typeof createContextReset>;
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
  decisions: Map<string, Decision>;
  eventOwner?: { closed?: WeakSet<CopilotSession> };
  sendReceipts: Set<string>;
  revision: number;
  sync?: Promise<void>;
  syncAgain: boolean;
  scheduleGate: Promise<void>;
  resourceWrites: Map<SessionResource, number>;
  pendingInvalidations: Set<SessionResource>;
  modelGate: Promise<void>;
  replyNotification?: string;
  pendingReply?: { eventId: string; body: string };
  namingReply?: boolean;
  namingAttempted?: boolean;
  namingDeferred?: boolean;
  autoNamePending?: string | false;
  naming?: Promise<IntentResult<'session/auto-name'>>;
}

const activeTask = (status: string) => !['idle', 'completed', 'failed', 'cancelled'].includes(status);
const planActions = new Set<string>(['exit_only', 'interactive', 'autopilot', 'autopilot_fleet']);
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const unsupported = (what: string): never => { throw new Error(`${what} is unsupported by this public SDK adapter; nothing was changed`); };
const namingBusyError = () => Object.assign(new Error('Session must be idle before automatic naming'), {
  statusCode: 409, code: 'SESSION_BUSY',
});

const controlEvents = new Set([
  'user.message', 'assistant.turn_start', 'assistant.turn_end', 'assistant.message', 'abort',
  'tool.execution_start', 'tool.execution_complete',
  'subagent.started', 'subagent.completed', 'subagent.failed',
]);

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
    accepted: new Set(), decisions: new Map(), sendReceipts: new Set(),
    revision: 0, turnEpoch: 0, syncAgain: false,
    scheduleGate: Promise.resolve(),
    resourceWrites: new Map(), pendingInvalidations: new Set(),
    modelGate: Promise.resolve(),
  };
}

export class Engine {
  private readonly runtime: EngineRuntime;
  private readonly prefs: Prefs;
  private readonly sessions = new Map<string, State>();
  private readonly creating = new Set<string>();
  private readonly removing = new Set<string>();
  private readonly bus = new EventEmitter().setMaxListeners(0);
  private agentStatus: AgentStatus = 'starting';
  private birthGate: Promise<void> = Promise.resolve();
  private births = 0;
  private lifecycle = false;
  private started = false;
  private stopped = false;
  private startPromise?: Promise<void>;
  private fatalError?: Error;
  vapidPublicKey: string | null = null;
  log: (message: string, data?: Record<string, unknown>) => void = () => {};

  constructor(options: { runtime?: EngineRuntime; prefsFile?: string } = {}) {
    this.runtime = options.runtime ?? new OfficialRuntime();
    this.prefs = new Prefs(options.prefsFile);
    this.prefs.reconcileInboxChoices();
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
    this.agentStatus = 'restarting';
    for (const st of this.sessions.values()) this.detach(st, error);
    this.emit({ type: 'agent/status', status: 'restarting' });
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

  onActivitySettled(handler: () => void): () => void {
    this.bus.on('activity-settled', handler);
    return () => this.bus.off('activity-settled', handler);
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
      this.agentStatus = 'restarting';
      this.emit({ type: 'agent/status', status: 'restarting' });
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
      models, vapidPublicKey: this.vapidPublicKey, sessions,
      ...this.inboxCounts(),
    };
  }

  private listedMeta(row: SessionMetadata): SessionMeta {
    return {
      sessionId: row.sessionId, title: cleanSessionTitle(row.summary) || row.sessionId.slice(0, 8),
      cwd: row.context?.workingDirectory ?? '',
      createdAt: row.startTime.getTime(), lastActivity: row.modifiedTime.getTime(), lastActivitySource: 'native-persisted',
      loaded: false, status: 'unloaded', ask: null,
      planRequest: null, elicitation: null,
      pinned: this.prefs.isPinned(row.sessionId), ...this.inboxFields(row.sessionId),
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
      const meta = st ? await this.getResources(id, resources, row) : row ? this.listedMeta(row) : await this.getResources(id, resources);
      if (meta) result.push(completeMeta(meta));
    }
    return result;
  }

  async getMeta(id: string): Promise<SessionMeta | null> {
    const meta = await this.getResources(id, MetaResources.options);
    return meta ? completeMeta(meta) : null;
  }

  async getResources(id: string, resources: readonly MetaResource[], listedRow?: SessionMetadata): Promise<SessionProjection | null> {
    this.assertAvailable();
    const st = this.sessions.get(id);
    if (this.creating.has(id) && !st?.sdk) throw Object.assign(
      new Error('Native session creation is still awaiting acknowledgement'), { statusCode: 409, code: 'SESSION_TRANSITION' },
    );
    this.assertReadable(st);
    const sdk = st && await this.liveSession(st);
    this.assertReadable(st);
    if (!st || !sdk) {
      const row = listedRow ?? await this.untilFatal(() => this.runtime.getSessionMetadata(id));
      return row ? {
        ...this.listedMeta(row),
        ...(st ? { loading: !!st.load, closing: st.closing, cancelling: !!st.cancelling,
          activeOperations: st.operations, activeMcpOperations: st.mcpOperations,
          autoNaming: !!st.naming, ...this.decisionFields(st) } : {}),
      } : null;
    }
    st.operations++;
    this.patch(st, { activeOperations: st.operations });
    try {
      const wants = new Set(resources);
      const [metadata, name, model, models, mode, todos, schedules, control, queue, row] = await this.withSession(st, sdk, () => settled([
        wants.has('identity') ? sdk.rpc.metadata.snapshot() : Promise.resolve(undefined),
        wants.has('identity') ? sdk.rpc.name.get() : Promise.resolve(undefined),
        wants.has('model') ? sdk.rpc.model.getCurrent() : Promise.resolve(undefined),
        wants.has('models') ? sdk.rpc.model.list() : Promise.resolve(undefined),
        wants.has('mode') && !wants.has('identity') ? sdk.rpc.mode.get() : Promise.resolve(undefined),
        wants.has('todo') ? sdk.rpc.plan.readSqlTodos() : Promise.resolve(undefined),
        wants.has('schedule') ? sdk.rpc.schedule.list() : Promise.resolve(undefined),
        wants.has('control') ? this.readControl(st, sdk) : Promise.resolve(undefined),
        wants.has('queue') && !wants.has('control') ? sdk.rpc.queue.pendingItems() : Promise.resolve(undefined),
        wants.has('identity') ? listedRow ? Promise.resolve(listedRow) : this.runtime.getSessionMetadata(id) : Promise.resolve(undefined),
      ] as const));
      const nativeModels = models ? sessionModelOptions(models.list) : undefined;
      const needsCatalog = nativeModels?.some(option => option.supportedReasoningEfforts === undefined
        || option.defaultReasoningEffort === undefined || option.supportsLongContext === undefined);
      const availableModels = models && needsCatalog
        ? sessionModelOptions(models.list, await this.withSession(st, sdk, () => this.runtime.models())) : nativeModels;
      return {
        sessionId: id, loaded: true,
        ...(metadata ? {
          title: cleanSessionTitle(name?.name ?? metadata.summary) || id.slice(0, 8), cwd: metadata.workingDirectory,
          createdAt: Date.parse(metadata.startTime),
          lastActivity: row?.modifiedTime.getTime() ?? Date.parse(metadata.modifiedTime),
          lastActivitySource: row ? 'native-persisted' as const : 'native-construction' as const,
        } : {}),
        ...(control ? {
          status: control.busy || st.sends > 0 || st.accepted.size > 0 ? 'running' as const : 'idle' as const,
          nativeProcessing: control.busy,
          ...(!control.busy && !st.sends && !st.accepted.size ? { intent: null } : {}),
          activeSubagents: control.tasks.tasks.filter(task => activeTask(task.status)).length,
          activeMcpOperations: st.mcpOperations + control.mcpHost.pendingConnections.length,
        } : {}),
        ...(model ? { currentModelId: model.modelId, currentReasoningEffort: model.reasoningEffort ?? null,
          currentContextTier: model.contextTier ?? null } : {}),
        ...(wants.has('mode') ? { currentMode: metadata?.currentMode ?? mode } : {}),
        ...(models ? { availableModels } : {}),
        ...(wants.has('queue') ? { queue: (control?.queue ?? queue)!.items.map(item => ({ id: item.id, text: item.displayText })) } : {}),
        ...(todos ? { todo: this.todoSummary(todos) } : {}),
        ...(schedules ? { scheduleCount: schedules.entries.length } : {}),
        activeOperations: Math.max(0, st.operations - 1),
        loading: !!st.load, closing: st.closing, cancelling: !!st.cancelling, autoNaming: !!st.naming,
        ...this.decisionFields(st), pinned: this.prefs.isPinned(id), ...this.inboxFields(id),
      };
    } finally {
      st.operations--;
      this.patch(st, { activeOperations: st.operations });
      this.release(st);
    }
  }

  async listLive(): Promise<SessionBrief[]> {
    return (await this.readSessions(['identity', 'control', 'model'])).map(meta => ({
      sessionId: meta.sessionId, title: meta.title, cwd: meta.cwd, status: meta.status,
      loaded: meta.loaded, lastActivity: meta.lastActivity, currentModelId: meta.currentModelId,
      lastActivitySource: meta.lastActivitySource,
    }));
  }
  async status(): Promise<SessionMeta[]> {
    return this.readSessions(['identity', 'control']);
  }
  private inboxCounts() {
    return this.prefs.inboxCounts();
  }
  attentionCount(): number { return this.inboxCounts().unreadCount; }
  markSeen(id: string, observedId?: number): void {
    if (observedId !== undefined && observedId !== this.inboxFields(id).attnId) return;
    try {
      if (this.prefs.markSeen(id, observedId)) this.publishInbox(id);
    } catch (error) {
      this.inboxError(id, error);
      throw error;
    }
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
      if (!await this.untilFatal(() => this.runtime.getSessionMetadata(id))) throw new Error('Unknown session');
      this.assertAvailable();
      if (this.stopped || this.lifecycle || this.removing.has(id)) {
        throw new Error('Session lifecycle transition is in progress');
      }
      st = this.sessions.get(id) ?? stateFor(id);
      this.sessions.set(id, st);
    }
    if (st.closing) throw new Error('Session transition is in progress');
    return st;
  }

  private release(st: State): void {
    if (st.namingDeferred && !st.operations) {
      st.namingDeferred = false;
      this.maybeAutoName(st);
    }
    if (!st.sdk && !st.load && !st.closing && !st.operations && !st.cancelling && !st.sync
      && !st.pendingReply && !st.decisions.size && this.sessions.get(st.id) === st) this.sessions.delete(st.id);
    this.bus.emit('activity-settled');
  }

  private assertAdmission(st: State): void {
    this.assertAvailable();
    if (st.contextReset?.busy) throw new Error('Session context clear is in progress; retry this operation after it settles.');
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

  private async config(st: State, cwd?: string): Promise<SessionConfig> {
    return {
      sessionId: st.id, ...(cwd ? { workingDirectory: cwd } : {}), streaming: true,
      enableConfigDiscovery: true,
      // Runtime 1.0.83 discovers skills but does not apply its global disabled
      // list on create/cold resume unless the SDK receives that native value.
      disabledSkills: await this.globalDisabledSkills(),
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
    };
  }

  private decision<T>(st: State, kind: DecisionKind, fields: object, validate?: (value: T) => void): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (st.closing || st.cancelling || this.lifecycle) return Promise.reject(new Error('Session is closing or cancelling'));
    const requestId = randomUUID();
    return new Promise<T>((answer, reject) => {
      st.decisions.set(requestId, {
        kind, value: { ...fields, requestId } as Decision['value'],
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

  async newSession(cwd: string): Promise<string> {
    this.assertAvailable();
    if (this.stopped) throw new Error('Engine is stopped; start it before creating sessions');
    if (this.lifecycle) throw new Error('Engine lifecycle transition is in progress');
    const directory = resolve(cwd || homedir());
    if (!statSync(directory).isDirectory()) throw new Error('Working directory must be a directory');
    const id = randomUUID();
    const st = stateFor(id);
    this.creating.add(id);
    try {
      await this.ensureLoaded(st, true, directory);
      return id;
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
      const reset = createContextReset({
        session: () => st.eventOwner === owner && !this.failure ? st.sdk : null,
        assertReady: () => {
          this.assertAdmission(st);
          if (st.load || st.closing || st.cancelling || st.operations || st.sends || st.accepted.size
            || st.decisions.size || st.mcpOperations) throw new Error('Session has pending host work; finish it before clearing context.');
        },
      });
      st.contextReset = reset;
      const config: SessionConfig = { ...await this.config(st, cwd), tools: [reset.tool], onEvent: event => {
        if (st.eventOwner !== owner || this.failure) return;
        reset.observe(event);
        try { this.onLive(st, event); }
        catch (error) {
          this.patch(st, { error: `Native control event could not be applied: ${messageOf(error)}` });
          this.log('native control event failed', { sessionId: st.id, error: messageOf(error) });
        }
      } };
      const sdk = await this.untilFatal(() => create
        ? this.runtime.createSession(config)
        : this.runtime.resumeSession(st.id, config));
      this.assertAvailable();
      if (st.eventOwner !== owner) throw new Error('Native session closed while loading; explicitly resume to continue');
      st.sdk = sdk;
      this.sessions.set(sdk.sessionId, st);
      if (owner.closed?.has(sdk) || (create && !await this.liveSession(st))) {
        this.detach(st);
        throw new Error('Native session closed while loading; explicitly resume to continue');
      }
      delete owner.closed;
      const meta = await this.getResources(st.id, summaryResources);
      if (!meta) throw new Error('Native session metadata is unavailable after loading');
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
      if (st.pendingReply) this.scheduleSync(st);
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
        if (st.sends) st.sendReceipts.add(id);
      }
      this.patch(st, { lastActivity: Date.now(), lastActivitySource: 'host-event-receipt' });
    }
    if (root && event.type !== 'user.message' && typeof data.interactionId === 'string'
      && st.interactionId && data.interactionId !== st.interactionId
      && (event.type.startsWith('assistant.') || event.type === 'session.error')) return;
    if (root && (event.type === 'user.message' || event.type === 'assistant.turn_start')) {
      st.turnEpoch++;
      st.interruptedEpoch = undefined;
      st.interactionId = typeof data.interactionId === 'string' ? data.interactionId : undefined;
    }
    if (root && event.type === 'session.idle' && !st.interruptTurn) st.interactionId = undefined;
    // Late lifecycle effects from an interrupted interaction must not erase the
    // queued turn's reply/decision state; its transcript remains native history.
    if (root && event.type.startsWith('assistant.') && st.interruptedEpoch === st.turnEpoch) return;
    this.observeNamingReply(st, native);
    if (root && st.interruptTurn && (event.type === 'abort'
      || (event.type === 'assistant.turn_start' && typeof data.interactionId === 'string'
        && st.interruptTurn.interactionId && data.interactionId !== st.interruptTurn.interactionId))) {
      this.clearInterruptedTurn(st, st.interruptTurn);
      st.interruptTurn = undefined;
    }
    if (event.type === 'session.shutdown'
      || (event.type === 'session.connection_state_changed' && ['reconnecting', 'disconnected'].includes(String(data.state)))) {
      this.probe(st);
      return;
    }
    if (native.type === 'tool.execution_complete') {
      this.scheduleSync(st);
    }
    if (root && event.type === 'tool.execution_start' && data.toolName === 'report_intent') {
      const args = data.arguments as { intent?: string } | undefined;
      if (typeof args?.intent === 'string') this.patch(st, { intent: args.intent });
    }
    if (root && event.type === 'assistant.turn_start') {
      st.replyNotification = undefined;
      st.pendingReply = undefined;
      this.patch(st, { status: 'running', nativeProcessing: true, error: null });
      this.invalidate(st, ['control', 'queue']);
    }
    if (root && event.type === 'assistant.message') {
      if (!native.ephemeral && typeof data.content === 'string' && data.content.trim()) {
        const visible = extractParts(data.content, false);
        st.replyNotification = notificationSummary(
          visible ? visible.content || `附件：${visible.attachments?.map(file => file.name).join('、')}` : data.content,
          '回复已完成',
        );
      }
    }
    if (root && event.type === 'assistant.turn_end') {
      if (st.replyNotification && !st.cancelling) {
        st.pendingReply = { eventId: native.id, body: st.replyNotification };
      }
      st.replyNotification = undefined;
      this.scheduleSync(st, ['identity', 'control', 'queue', 'usage']);
    }
    if (event.type === 'session.error') {
      st.replyNotification = undefined;
      st.pendingReply = undefined;
      this.patch(st, { status: 'error', error: String(data.message ?? 'Native turn failed') });
    }
    if (event.type === 'session.title_changed' && typeof data.title === 'string') this.patch(st, { title: cleanSessionTitle(data.title) });
    if (event.type === 'session.mode_changed' && ['interactive', 'plan', 'autopilot'].includes(String(data.newMode))) {
      this.patch(st, { currentMode: data.newMode as SessionMeta['currentMode'] });
    }
    if (event.type === 'session.compaction_start') this.patch(st, { compacting: true });
    if (event.type === 'session.compaction_complete') {
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
    if (!st.pendingReply && !st.autoNamePending) return;
    if (st.closing || this.lifecycle || !st.sdk || this.failure) return;
    st.syncAgain = true;
    if (st.sync) return;
    const sdk = st.sdk;
    let sync!: Promise<void>;
    // Coalesce events delivered in the same turn without a timer or heartbeat.
    sync = Promise.resolve().then(async () => {
      if (st.sync !== sync || st.sdk !== sdk) return;
      do {
        st.syncAgain = false;
        await this.syncNative(st);
      } while (st.sync === sync && st.syncAgain && st.sdk === sdk && !st.closing && !this.lifecycle && !this.failure);
    }).catch(error => {
      if (st.sync === sync && st.sdk === sdk && !this.failure) {
        this.patch(st, { error: `Native state could not be confirmed: ${messageOf(error)}` });
      }
    }).finally(() => {
      if (st.sync !== sync) return;
      st.sync = undefined;
      // A control event can arrive after the loop exits but before ownership
      // releases. Do not lose its requested native state readback.
      if (st.syncAgain) this.scheduleSync(st);
      this.release(st);
    });
    st.sync = sync;
  }

  private patchMcpPending(st: State): void {
    this.invalidate(st, ['control', 'mcp']);
  }

  private async readResource<K extends Resource>(
    st: State, sdk: CopilotSession, resource: K, validate?: (value: ResourceValues[K]) => void,
  ): Promise<ResourceValues[K]> {
    this.assertAvailable();
    if (st.sdk !== sdk) throw new Error('Native session closed during resource read');
    const readers: { [R in Resource]: () => Promise<ResourceValues[R]> } = {
      model: () => sdk.rpc.model.getCurrent(), models: () => sdk.rpc.model.list(),
      todos: () => sdk.rpc.plan.readSqlTodos(), schedule: () => sdk.rpc.schedule.list(), mcp: () => sdk.rpc.mcp.list(),
    };
    const value = await this.withSession(st, sdk, readers[resource]);
    validate?.(value);
    return value;
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
      || !Number.isInteger(queue.inFlightSteeringCount) || queue.inFlightSteeringCount < 0) {
      throw new Error('Native activity state is incomplete; cannot confirm session safety');
    }
    return {
      queue, tasks, mcpHost: mcp.host,
      busy: processing.processing || activity.hasActiveWork || tasks.tasks.some(task => activeTask(task.status))
        || queue.items.length > 0 || queue.steeringMessages.length > 0 || queue.inFlightSteeringCount > 0
        || mcp.host.pendingConnections.length > 0,
    };
  }

  private async syncNative(st: State): Promise<void> {
    const sdk = await this.liveSession(st);
    if (!sdk) return;
    const revision = st.revision;
    const control = await this.readControl(st, sdk);
    if (st.sdk !== sdk) return;
    if (revision !== st.revision) {
      st.syncAgain = true;
      return;
    }
    const busy = control.busy || st.sends > 0 || st.accepted.size > 0;
    if (!busy && !st.cancelling && !st.load && st.pendingReply) {
      const attention = nextAttention({ status: 'idle', choicePending: st.decisions.size > 0, attention: this.inboxFields(st.id).attention },
        { status: 'idle', choicePending: st.decisions.size > 0, replyReady: true });
      if (attention === 'ready' && this.commitAttention(st, attention, st.pendingReply.eventId, st.pendingReply.body)) {
        st.pendingReply = undefined;
      }
    }
    if (!busy) {
      if (!st.interruptTurn) st.interactionId = undefined;
      this.maybeAutoName(st);
    }
  }

  private observeNamingReply(st: State, native: SessionEvent): void {
    if (st.namingAttempted || native.ephemeral) return;
    const event = normalizeEvent(native);
    if (event.agentId || event.parentToolCallId || event.data.parentToolCallId || event.data.agentId) return;
    if (['assistant.turn_start', 'user.message', 'abort', 'session.error'].includes(event.type)) {
      st.namingReply = false;
      st.autoNamePending = false;
    } else if (event.type === 'assistant.message') {
      st.namingReply = typeof event.data.content === 'string' && !!event.data.content.trim()
        && !(Array.isArray(event.data.toolRequests) && event.data.toolRequests.length);
    } else if (event.type === 'tool.execution_start') {
      st.namingReply = false;
      st.autoNamePending = false;
    } else if (event.type === 'assistant.turn_end' && st.namingReply && !st.cancelling) {
      st.autoNamePending = native.id;
      st.namingReply = false;
    }
  }

  private maybeAutoName(st: State): void {
    if (!st.autoNamePending || st.namingAttempted || st.naming || !st.sdk
      || this.failure || this.lifecycle) return;
    if (this.localBusy(st)) {
      if (st.operations) st.namingDeferred = true;
      return;
    }
    st.namingDeferred = false;
    void this.nameSession(st, true).catch(error => {
      this.log('automatic session naming failed', { sessionId: st.id, error: messageOf(error) });
    });
  }

  autoName(id: string): Promise<IntentResult<'session/auto-name'>> {
    const st = this.sessions.get(id);
    if (st && (st.closing || this.lifecycle || this.removing.has(id))) return Promise.reject(namingBusyError());
    if (st?.naming) return st.naming;
    return this.state(id).then(state => this.nameSession(state));
  }

  private nameSession(st: State, automatic = false): Promise<IntentResult<'session/auto-name'>> {
    if (st.naming) return st.naming;
    if (this.stopped || this.lifecycle || this.localBusy(st)) return Promise.reject(namingBusyError());
    st.operations++;
    this.patch(st, { activeOperations: st.operations, autoNaming: true, autoNameError: null });
    let naming!: NonNullable<State['naming']>;
    naming = Promise.resolve().then(async (): Promise<IntentResult<'session/auto-name'>> => {
      await this.ensureLoaded(st);
      const sdk = st.sdk!;
      return this.withSession(st, sdk, async () => {
        const idle = async () => st.sdk === sdk && !this.failure && !await this.busy(st, false, 1);
        if (!await idle()) throw namingBusyError();
        const workspace = (await sdk.rpc.workspaces.getWorkspace()).workspace;
        if (st.sdk !== sdk || this.failure) throw new Error('Native session closed during naming');
        if (workspace?.user_named) {
          if (automatic) st.autoNamePending = false;
          if (workspace.name) this.patch(st, { title: workspace.name });
          return { ok: true, applied: false, title: workspace.name ?? null, reason: 'user-named' };
        }
        // Native prompt-preview titles are also nonempty and not user-named.
        if (automatic) {
          const first = await firstNamingReply(params =>
            this.withSession(st, sdk, () => sdk.rpc.eventLog.read(params)));
          if (st.sdk !== sdk || this.failure) throw new Error('Native session closed during naming');
          if (first !== st.autoNamePending) {
            st.autoNamePending = false;
            return { ok: true, applied: false, title: workspace?.name ?? null, reason: 'not-applied' };
          }
        }
        // Context attribution can be uninitialized on a resumed conversation;
        // it is not proof that native history is empty.
        const context = await sdk.rpc.eventLog.read({
          direction: 'backward', max: 1, types: ['user.message', 'assistant.message'], agentScope: 'primary', includeEphemeral: false,
        });
        if (context.cursorStatus !== 'ok' || context.events.length > 1
          || context.events.some(event => !['user.message', 'assistant.message'].includes(event.type))
          || (!context.events.length && context.hasMore)) {
          throw new Error('Native conversation presence could not be confirmed by the targeted naming query.');
        }
        if (!context.events.length) {
          if (automatic) st.autoNamePending = false;
          return { ok: true, applied: false, title: workspace?.name ?? null, reason: 'no-context' };
        }
        if (!await idle()) throw namingBusyError();
        // This guard records a host attempt, not native title/history state.
        // Never retry a model query, including a rejected or uncertain one.
        st.namingAttempted = true;
        st.autoNamePending = false;
        const title = generatedTitle((await sdk.rpc.ui.ephemeralQuery({ question: autoNameQuestion })).answer);
        // Closing the native handle rejects withSession, but does not cancel its
        // underlying RPC. Never let a late answer mutate that closed handle.
        if (st.sdk !== sdk || this.failure) throw new Error('Native session closed during naming');
        const result = await sdk.rpc.name.setAuto({ summary: title });
        const current = (await sdk.rpc.workspaces.getWorkspace()).workspace;
        if (st.sdk !== sdk || this.failure) throw new Error('Native session closed during naming');
        if (current?.name) this.patch(st, { title: current.name });
        if (current?.user_named) return { ok: true, applied: false, title: current.name ?? null, reason: 'user-named' };
        if (!result.applied) return { ok: true, applied: false, title: current?.name ?? null, reason: 'not-applied' };
        if (current?.name !== title) throw Object.assign(new Error('Native automatic name was not confirmed'), {
          statusCode: 502, code: 'AUTO_NAME_NOT_CONFIRMED',
        });
        return { ok: true, applied: true, title: current.name };
      });
    }).catch(error => {
      if (automatic && !st.namingAttempted && error?.code === 'SESSION_BUSY') {
        // Work discovered by the authoritative preflight is not an attempt.
        // Its next natural idle event may release this same pending reply.
        return { ok: true, applied: false, title: null, reason: 'not-applied' } as const;
      }
      if (automatic) {
        st.namingAttempted = true;
        st.autoNamePending = false;
      }
      this.patch(st, { autoNameError: messageOf(error) });
      throw error;
    }).finally(() => {
      st.operations--;
      if (st.naming === naming) st.naming = undefined;
      this.patch(st, { activeOperations: st.operations, autoNaming: false });
      this.release(st);
    });
    st.naming = naming;
    return naming;
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
    const held = changes.filter(resource => resource !== 'control' && resource !== 'queue');
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
      this.maybeAutoName(st);
      this.release(st);
    }
  }

  async prompt(id: string, text: string, mode: 'enqueue' | 'immediate' = 'enqueue', attachments?: RuntimeAttachment[]): Promise<{ ok: boolean; queued?: boolean }> {
    if (!text.trim() && !attachments?.length) throw new Error('Prompt must not be empty');
    return this.operation(id, async (sdk, st) => {
      const queued = (await this.readControl(st, sdk)).busy && mode === 'enqueue';
      st.sends++;
      st.replyNotification = undefined;
      st.pendingReply = undefined;
      st.namingReply = false;
      st.autoNamePending = false;
      this.patch(st, { status: 'running', error: null });
      try {
        const accepted = await this.withSession(st, sdk, () => sdk.send({
          prompt: text, mode,
          attachments: attachments?.map(file => ({ type: 'file' as const, path: file.path, displayName: file.displayName ?? basename(file.path) })),
        }));
        if (st.sdk !== sdk) throw new Error('Native session closed during send; delivery is uncertain');
        if (!st.sendReceipts.has(accepted)) st.accepted.add(accepted);
        return { ok: true, ...(queued ? { queued: true } : {}) };
      } catch (error) {
        this.patch(st, { status: 'error', error: messageOf(error) });
        throw error;
      } finally {
        st.sends--;
        if (!st.sends) st.sendReceipts.clear();
        this.scheduleSync(st);
      }
    });
  }

  async cancel(id: string): Promise<void> {
    const st = await this.state(id);
    this.assertAdmission(st);
    if (st.cancelling) return st.cancelling;
    if (st.load || st.operations) return Promise.reject(new Error('Session operation is still in progress'));
    this.patch(st, { cancelling: true, error: null });
    st.cancelling = this.untilFatal(async () => {
      const sdk = await this.liveSession(st);
      if (!sdk) {
        st.pendingReply = undefined;
        st.autoNamePending = false;
        return;
      }
      await this.withSession(st, sdk, () => sdk.rpc.queue.clear());
      await this.withSession(st, sdk, () => sdk.abort());
      st.replyNotification = undefined;
      st.pendingReply = undefined;
      st.namingReply = false;
      st.autoNamePending = false;
      for (const decision of st.decisions.values()) decision.reject(new Error('Native request cancelled'));
      st.decisions.clear();
      st.accepted.clear();
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
      this.patch(st, { cancelling: false }, true);
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
    st.replyNotification = undefined;
    st.pendingReply = undefined;
    st.namingReply = false;
    st.autoNamePending = false;
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

  private localBusy(st: State, ownTransition = false, ownOperations = 0): boolean {
    return (!ownTransition && st.closing) || st.operations > ownOperations || !!st.load
      || !!st.cancelling || st.decisions.size > 0 || st.sends > 0 || st.accepted.size > 0 || !!st.pendingReply;
  }

  private async busy(st: State, ownTransition = false, ownOperations = 0): Promise<boolean> {
    if (this.localBusy(st, ownTransition, ownOperations)) return true;
    const revision = st.revision;
    const sdk = await this.liveSession(st);
    const active = !!sdk && (await this.readControl(st, sdk)).busy;
    return active || this.localBusy(st, ownTransition, ownOperations) || st.revision !== revision;
  }

  async busyCount(): Promise<number> {
    if (this.lifecycle || this.births || this.creating.size || this.startPromise || this.removing.size) return 1;
    let count = 0;
    for (const st of this.sessions.values()) if (await this.busy(st)) count++;
    return count;
  }

  private async checkIdle(st: State): Promise<void> {
    await this.liveSession(st);
    if (st.load || st.operations || st.cancelling || st.decisions.size || st.sends || st.accepted.size) throw new Error('Session has protected work');
    if (st.sync) await st.sync;
    if (!st.sdk) this.commitClosedReply(st);
    if (await this.busy(st, true)) throw new Error('Session has protected work (turn, task, queue, decision, or operation)');
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
    st.contextReset = undefined;
    st.interruptTurn = undefined;
    st.interruptedEpoch = undefined;
    st.interactionId = undefined;
    st.sync = undefined;
    st.syncAgain = false;
    if (sdk) this.bus.emit('closed', sdk);
    st.replyNotification = undefined;
    st.namingReply = false;
    st.autoNamePending = false;
    st.sendReceipts.clear();
    st.namingAttempted = undefined;
    st.namingDeferred = false;
    st.accepted.clear();
    for (const decision of st.decisions.values()) decision.reject(error ?? new Error('Native session closed'));
    st.decisions.clear();
    // A routine native close can precede the final event-driven readback.
    if (!error) this.commitClosedReply(st);
    if (error) st.pendingReply = undefined;
    this.patch(st, {
      loaded: false, status: error ? 'error' : 'unloaded', nativeProcessing: false,
      activeSubagents: 0, activeMcpOperations: 0, compacting: false,
      queue: [], ask: null, planRequest: null, elicitation: null, intent: null,
      ...(error ? { error: error.message } : {}),
    }, true);
    this.release(st);
  }

  private commitClosedReply(st: State): void {
    if (!st.cancelling && st.pendingReply
      && this.commitAttention(st, 'ready', st.pendingReply.eventId, st.pendingReply.body)) st.pendingReply = undefined;
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
      if (st.syncAgain) this.scheduleSync(st);
      this.release(st);
    }
  }

  async unload(id: string): Promise<void> {
    const st = await this.state(id);
    await this.transition(st, () => this.close(st));
  }
  async reload(id: string): Promise<void> {
    const st = await this.state(id);
    await this.transition(st, () => this.close(st));
    await this.ensureLoaded(st);
  }

  async stop(): Promise<void> {
    if (this.failure) {
      this.fail(this.failure);
      await this.runtime.stop();
      this.stopped = true;
      return;
    }
    if (this.lifecycle || this.births || this.creating.size || this.startPromise || this.removing.size) throw new Error('Engine lifecycle operation is in progress');
    const all = [...this.sessions.values()];
    if (all.some(st => st.closing || st.load || st.operations || st.cancelling)) throw new Error('Session operation is in progress');
    this.lifecycle = true;
    for (const st of all) { st.closing = true; this.patch(st, { closing: true }); }
    try {
      for (const st of all) await this.checkIdle(st);
      for (const st of all) { await this.checkIdle(st); await this.close(st); }
      await this.runtime.stop();
      this.started = false;
      this.stopped = true;
      this.agentStatus = 'restarting';
      this.emit({ type: 'agent/status', status: 'restarting' });
    } finally {
      for (const st of all) { st.closing = false; this.patch(st, { closing: false }); this.release(st); }
      this.lifecycle = false;
      for (const st of all) if (st.syncAgain) this.scheduleSync(st);
      this.bus.emit('activity-settled');
    }
  }

  async setModel(id: string, modelId: string, reasoningEffort?: string, contextTier?: 'default' | 'long_context'): Promise<void> {
    await this.operation(id, (sdk, st) => this.serializeMutation(st, 'modelGate', async () => {
      const before = await this.readResource(st, sdk, 'model');
      // Native switchTo clears omitted effort/tier options even for the same
      // model. A single-control edit must preserve the other authoritative value.
      const options = {
        modelId,
        deferIfModelChangeQueued: true,
        reasoningEffort: reasoningEffort ?? (before.modelId === modelId ? before.reasoningEffort : undefined),
        contextTier: contextTier ?? (before.modelId === modelId ? before.contextTier : undefined),
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
      const current = await this.readResource(st, sdk, 'model');
      if (result.persistenceError || result.confirmation
        || (result.status !== undefined && !['applied', 'unchanged', 'deferred', 'queued'].includes(result.status))) {
        throw new Error(`Native model change ${result.status ?? 'not applied'}: ${result.persistenceError ?? result.message ?? 'confirmation or additional host action required'}`);
      }
      if (!result.deferred && !['deferred', 'queued'].includes(result.status ?? '')
        && ((options.reasoningEffort !== undefined && current.reasoningEffort !== options.reasoningEffort)
          || (options.contextTier !== undefined && current.contextTier !== options.contextTier))) {
        throw new Error('Native model settings were not confirmed by authoritative readback');
      }
      if (result.deferred) this.scheduleSync(st);
    }), ['model', 'models', 'usage', 'control', 'queue']);
  }
  async setMode(id: string, mode: 'interactive' | 'plan' | 'autopilot'): Promise<void> {
    await this.operation(id, async (sdk, st) => {
      const result = await this.withSession(st, sdk, () => sdk.rpc.mode.set({ mode }));
      if (!['applied', 'unchanged'].includes(result.status) || result.confirmation
        || result.deferImplementation || result.armInteractiveContinuation) {
        throw new Error(`Native mode change ${result.status}: ${result.message ?? 'additional host action required; no continuation was sent'}`);
      }
      const currentMode = await this.withSession(st, sdk, () => sdk.rpc.mode.get());
      this.patch(st, { currentMode });
      if (result.modelChanged) {
        await this.readResource(st, sdk, 'model');
      }
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
  async compact(id: string, customInstructions?: string): Promise<void> {
    await this.operation(id, async (sdk, st) => {
      this.patch(st, { compacting: true });
      try {
        const result = await this.withSession(st, sdk, () => sdk.rpc.history.compact({ customInstructions }));
        if (!result.success) throw new Error('Native compaction was unsuccessful');
      }
      finally { this.patch(st, { compacting: false }); }
    }, ['usage']);
  }
  async rewind(id: string, toMsgId: string, rollbackFiles = false): Promise<void> {
    const st = await this.state(id);
    await this.ensureLoaded(st);
    await this.transition(st, async () => {
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
      if (result.outcome !== 'success') {
        throw new Error(`Rewind ${result.outcome}${mutated ? ' (partially applied)' : ''}: ${result.error ?? 'native operation unavailable'}`);
      }
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
      return { name, detail: describeMcpServer(config), defaultOn: server.enabled, config: redactMcpConfig(config) };
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
        return { loaded: true, servers: result.servers.map(server => ({
          name: server.name, detail: server.sourcePlugin ?? server.source ?? 'native',
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
      projectPaths: [resolve(cwd || homedir())], skillDirectories: [bundledSkillsDirectory],
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
    return skills.map(({ name, description, source, userInvocable, enabled }) => ({ name, description, source, userInvocable, enabled }));
  }
  async readSkillBody(name: string, cwd?: string) {
    const skill = (await this.globalSkills(cwd)).find(skill => skill.name === name);
    if (!skill) throw new Error('Unknown skill in this working directory');
    if (!skill.path) return unsupported('Skill body without a public local path');
    return { name: skill.name, description: skill.description, source: skill.source,
      userInvocable: skill.userInvocable, enabled: skill.enabled, body: readFileSync(skill.path, 'utf8') };
  }
  async setGlobalSkill(name: string, enabled: boolean, cwd?: string): Promise<void> {
    if (!(await this.globalSkills(cwd)).some(skill => skill.name === name)) throw new Error('Unknown skill in this working directory');
    await this.untilFatal(() => this.runtime.rpc.skills.config.setSkillDisabled({ name, disabled: !enabled }));
    const skill = (await this.globalSkills(cwd)).find(skill => skill.name === name);
    if (!skill || skill.enabled !== enabled) throw new Error('Native global skill state did not confirm the requested change');
  }
  async listSessionSkills(id: string) {
    return this.operation(id, async (sdk, st) => (await this.withSession(st, sdk, () => sdk.rpc.skills.list())).skills.map(
      ({ name, description, source, enabled }) => ({ name, description, source, enabled })), 'read');
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
    prompt: string; interval?: string; cron?: string; at?: number; recurring?: boolean; tz?: string; displayPrompt?: string;
  }): Promise<{ entry?: ScheduleEntry; error?: string }> {
    if (options.cron !== undefined || options.tz !== undefined || options.displayPrompt !== undefined) {
      return unsupported('Cron, timezone and displayPrompt schedule options');
    }
    if ((options.interval !== undefined) === (options.at !== undefined)) throw new Error('Exactly one of interval or at is required');
    if (!options.prompt.trim() || /[\r\n]/.test(options.prompt) || /(^|\s)--/.test(options.prompt) || options.prompt.trimStart().startsWith('/')) {
      throw new Error('Schedule prompt must be plain single-line text without command flags');
    }
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
    return this.operation(id, (sdk, st) => this.serializeMutation(st, 'scheduleGate', async () => {
      if (options.at !== undefined) {
        seconds = Math.ceil((options.at - Date.now()) / 1000);
        if (seconds < 1) throw new Error('Absolute schedule time passed while waiting for the runtime');
      }
      const before = new Set((await this.withSession(st, sdk, () => sdk.rpc.schedule.list())).entries.map(entry => entry.id));
      const result = await this.withSession(st, sdk, () => sdk.rpc.commands.invoke({ name: recurring ? 'every' : 'after', input: `${seconds}s ${options.prompt}` }));
      const entries = (await this.readResource(st, sdk, 'schedule')).entries;
      const created = entries.find(entry => !before.has(entry.id) && entry.prompt === options.prompt
        && entry.recurring === recurring && entry.intervalMs === seconds * 1000);
      if (!created) return { error: `Native schedule was not confirmed (${result.kind}); no model fallback was sent` };
      const entry = this.scheduleEntry(created);
      if (result.kind !== 'text' && result.kind !== 'completed') return { entry, error: `Native schedule created with unexpected command outcome: ${result.kind}` };
      return { entry };
    }), ['schedule']);
  }
  private serializeMutation<T>(st: State, gate: 'scheduleGate' | 'modelGate', work: () => Promise<T>): Promise<T> {
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

  async pin(id: string, pinned: boolean): Promise<boolean> {
    const st = await this.state(id);
    try {
      this.prefs.setPinned(id, pinned);
      this.patch(st, { pinned });
      return pinned;
    } finally { this.release(st); }
  }
  async deleteSession(id: string, confirm?: true): Promise<void> {
    if (confirm !== true) throw new Error('Permanent deletion is irreversible; explicit confirm:true is required');
    this.assertAvailable();
    if (this.stopped || this.lifecycle || this.startPromise || this.removing.has(id)) throw new Error('Session lifecycle transition is in progress');
    const productOwned = this.prefs.isPinned(id) || !!this.prefs.inboxEntry(id);
    const st = this.sessions.get(id) ?? (productOwned ? stateFor(id) : await this.state(id));
    this.assertAdmission(st);
    if (this.removing.has(id)) throw new Error('Session removal is in progress');
    this.removing.add(id);
    try {
      await this.transition(st, async () => {
        await this.close(st);
        // The API's confirm:true gate precedes this operation. Native deletion is
        // authoritative; never remove files or preferences to simulate success.
        await this.untilFatal(() => this.runtime.deleteSession(id));
        try { this.prefs.forgetSession(id); }
        catch (error) { throw new Error(`Native history deleted; preferences cleanup failed: ${messageOf(error)}`); }
        this.sessions.delete(id);
        this.emit({ type: 'session/removed', sessionId: id, ...this.inboxCounts() });
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

  private patch(st: State, fields: Partial<LiveMeta>, silent = false): void {
    const previous = { status: '', choicePending: st.decisions.size > 0,
      attention: this.inboxFields(st.id).attention };
    for (const key of ['currentReasoningEffort', 'currentContextTier', 'currentMode'] as const) {
      if (key in fields && fields[key] === undefined) fields[key] = null;
    }
    if (this.sessions.get(st.id) !== st) return;
    const attention = nextAttention(previous, { status: fields.status ?? '',
      choicePending: st.decisions.size > 0, silent });
    this.emit({ type: 'session/patch', ...structuredClone(fields), sessionId: st.id });
    // Patches already carry their changed values. Read leases and attention do
    // not invalidate native resources. A settled lifecycle needs a fresh source.
    if (fields.loaded !== undefined || fields.closing === false) this.invalidate(st);
    if (attention === 'choice') {
      const decisions = this.decisionFields(st);
      const request = decisions.ask ?? decisions.planRequest ?? decisions.elicitation;
      if (request) this.commitAttention(st, attention, request.requestId,
        notificationSummary(decisions.ask?.question || decisions.planRequest?.summary || decisions.elicitation?.message || '', '请确认下一步'));
    } else if (attention !== previous.attention) {
      this.commitAttention(st, attention);
    }
  }

  private inboxFields(id: string) {
    const entry = this.prefs.inboxEntry(id);
    return { attention: entry?.attention ?? null, attnId: entry?.attnId ?? 0, seenId: entry?.seenId ?? 0 };
  }

  private publishInbox(id: string) {
    const fields = this.inboxFields(id);
    const projection = { ...fields, ...this.inboxCounts() };
    this.emit({ type: 'session/patch', sessionId: id, ...projection });
    return projection;
  }

  private inboxError(id: string, error: unknown): void {
    this.emit({ type: 'session/patch', sessionId: id, error: `Inbox save failed; unread state was not committed: ${messageOf(error)}` });
    this.log('inbox save failed', { sessionId: id, error: messageOf(error) });
  }

  private commitAttention(st: State, attention: Attention | null, eventId?: string, body?: string): boolean {
    try {
      if (this.prefs.setAttention(st.id, attention, eventId)) {
        const { attnId, inboxRevision, unreadCount } = this.publishInbox(st.id);
        if (attention) this.emit({ type: 'session/notify', sessionId: st.id,
          title: st.id.slice(0, 8), attention, body: body ?? '请查看新消息', attnId, inboxRevision, unreadCount });
      }
      return true;
    } catch (error) {
      this.inboxError(st.id, error);
      return false;
    }
  }
}
