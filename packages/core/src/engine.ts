import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  CopilotSession, SessionConfig, SessionMetadata, SessionEvent,
  ExitPlanModeResult, ElicitationResult,
} from '@github/copilot-sdk';
import type {
  AgentStatus, Attention, ChatMessage, DirListing, ExitPlanModeAction, HistoryDetails, HistoryPage, HistoryResume,
  McpServerGlobal, McpServerSession, McpServerStatus, McpToggleOperation, McpToggleResult,
  ModelOption, ScheduleEntry, ServerEvent, SessionMeta, SessionPanels,
  SessionBrief, SessionPlan, Snapshot, SubagentHistoryPage, TodoItem, IntentResult, ToolImageRead,
} from '@cockpit/protocol';
import { SessionUsage, summarizeMessage, unreadSessionCount } from '@cockpit/protocol';
import { OfficialRuntime, sessionModelOptions } from './runtime.ts';
import { normalizeEvent, type SdkEvent, type RuntimeAttachment } from './sdk-types.ts';
import { cleanSessionTitle, foldEvent, isFoldContentVisible, newFoldState, type FoldState } from './fold.ts';
import { engineSessionBusy } from './lifecycle.ts';
import { nextAttention, notificationSummary } from './attention.ts';
import { SessionHistoryReader, pageHistory } from './history-reader.ts';
import { Prefs } from './prefs.ts';
import { describeMcpServer, redactMcpConfig } from './mcp-config.ts';
import { autoNameQuestion, generatedTitle } from './auto-name.ts';
import { validateForkHistory } from './fork.ts';
import { readToolImage } from './tool-image.ts';

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
interface DraftSettings {
  model: Pick<SessionConfig, 'model' | 'reasoningEffort' | 'contextTier'>;
  name: string | null;
  mode: Awaited<ReturnType<CopilotSession['rpc']['mode']['get']>>;
}
type ResourceValues = {
  model: Awaited<ReturnType<CopilotSession['rpc']['model']['getCurrent']>>;
  models: Awaited<ReturnType<CopilotSession['rpc']['model']['list']>>;
  todos: Awaited<ReturnType<CopilotSession['rpc']['plan']['readSqlTodos']>>;
  schedule: Awaited<ReturnType<CopilotSession['rpc']['schedule']['list']>>;
  mcp: Awaited<ReturnType<CopilotSession['rpc']['mcp']['list']>>;
};
type Resource = keyof ResourceValues;
interface State {
  meta: LiveMeta;
  sdk: CopilotSession | null;
  fold: FoldState;
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
  nativeMcpPending: number;
  sends: number;
  accepted: Set<string>;
  tasks: Set<string>;
  decisions: Map<string, Decision>;
  eventOwner?: { closed?: WeakSet<CopilotSession> };
  buffered?: SessionEvent[];
  eventIds: Set<string>;
  userMessageIds: Set<string>;
  revision: number;
  sync?: Promise<void>;
  syncAgain: boolean;
  resourceSync?: Promise<void>;
  resourceReads: Partial<Record<Resource, object>>;
  dirtyResources: Set<Resource>;
  steering: number;
  local: boolean;
  unsubmitted?: boolean;
  draftSettings?: DraftSettings;
  draftRestorePending?: boolean;
  settingsGate: Promise<unknown>;
  scheduleGate: Promise<unknown>;
  finalReply?: ChatMessage;
  pendingReply?: { eventId: string; body: string };
  namingReply?: boolean;
  autoNameSeen?: boolean;
  autoNamePending?: boolean;
  naming?: Promise<IntentResult<'session/auto-name'>>;
}

const activeTask = (status: string) => !['idle', 'completed', 'failed', 'cancelled'].includes(status);
const planActions = new Set<string>(['exit_only', 'interactive', 'autopilot', 'autopilot_fleet']);
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const unsupported = (what: string): never => { throw new Error(`${what} is unsupported by this public SDK adapter; nothing was changed`); };
const namingBusyError = () => Object.assign(new Error('Session must be idle before automatic naming'), {
  statusCode: 409, code: 'SESSION_BUSY',
});

const activeScope = { details: 'summary' } as const;
const submittedEvents = new Set(['user.message', 'assistant.turn_start', 'tool.execution_start', 'session.schedule_created']);
// Keep typed display history from every agent: legacy nested task requests can
// be the only parent link for later lifecycles. Summary folding discards child
// content, while old root tools and requested-file provenance remain addressable.
const activeEventTypes: [string, ...string[]] = [
  'session.start', 'session.title_changed', 'session.model_change', 'session.error', 'session.warning',
  'user.message', 'user_input.requested', 'skill.invoked',
  'assistant.turn_start', 'assistant.turn_end', 'assistant.idle', 'session.idle', 'abort',
  'assistant.reasoning', 'assistant.reasoning_delta', 'assistant.message_start',
  'assistant.message_delta', 'assistant.message', 'tool.execution_start', 'tool.execution_complete',
  'subagent.started', 'subagent.completed', 'subagent.failed', 'subagent.configured',
  'session.schedule_created',
];

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

function stateFor(id: string, cwd: string, title = basename(cwd) || id.slice(0, 8)): State {
  return {
    meta: { sessionId: id, cwd, title, lastActivity: Date.now(), status: 'unloaded', error: null,
      loaded: false, queue: [], ask: null, planRequest: null, elicitation: null },
    sdk: null, fold: newFoldState(), closing: false, operations: 0, mcpOperations: 0, nativeMcpPending: 0, sends: 0,
    accepted: new Set(), tasks: new Set(), decisions: new Map(), eventIds: new Set(), userMessageIds: new Set(),
    revision: 0, turnEpoch: 0, syncAgain: false, steering: 0, local: false,
    settingsGate: Promise.resolve(), scheduleGate: Promise.resolve(),
    resourceReads: {}, dirtyResources: new Set(),
  };
}

export class Engine {
  private readonly runtime: EngineRuntime;
  private readonly prefs: Prefs;
  private readonly historyReader: SessionHistoryReader;
  private readonly sessions = new Map<string, State>();
  private readonly trashedMeta = new Map<string, LiveMeta>();
  private readonly removing = new Set<string>();
  private readonly bus = new EventEmitter().setMaxListeners(0);
  private models: ModelOption[] = [];
  private agentStatus: AgentStatus = 'starting';
  private birthGate: Promise<unknown> = Promise.resolve();
  private births = 0;
  private lifecycle = false;
  private started = false;
  private stopped = false;
  private startPromise?: Promise<void>;
  private poll?: ReturnType<typeof setInterval>;
  private refreshPromise?: Promise<void>;
  private fatalError?: Error;
  login = '';
  vapidPublicKey: string | null = null;
  log: (message: string, data?: Record<string, unknown>) => void = () => {};

  constructor(options: { runtime?: EngineRuntime; prefsFile?: string } = {}) {
    this.runtime = options.runtime ?? new OfficialRuntime();
    this.prefs = new Prefs(options.prefsFile);
    this.prefs.reconcileInboxChoices();
    this.historyReader = new SessionHistoryReader({
      readPersistedEvents: params => this.runtime.rpc.sessions.readPersistedEvents(params),
    });
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
    clearInterval(this.poll);
    this.poll = undefined;
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

  private emit(event: ServerEvent): void { this.bus.emit('event', event); }

  start(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.lifecycle) return Promise.reject(new Error('Engine lifecycle transition is in progress'));
    if (this.started) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.untilFatal(async () => {
      await this.untilFatal(() => this.runtime.start());
      this.models = await this.untilFatal(() => this.runtime.models());
      this.login = (await this.untilFatal(() => this.runtime.getAuthStatus())).login ?? '';
      await this.untilFatal(() => this.refreshList());
      this.assertAvailable();
      this.started = true;
      this.stopped = false;
      this.agentStatus = 'up';
      this.emit({ type: 'agent/status', status: 'up' });
      this.startPolling();
    }).catch(error => {
      this.started = false;
      clearInterval(this.poll);
      this.poll = undefined;
      this.agentStatus = 'restarting';
      this.emit({ type: 'agent/status', status: 'restarting' });
      throw error;
    }).finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private startPolling(): void {
    clearInterval(this.poll);
    this.poll = setInterval(() => {
      if (this.lifecycle || !this.started || this.failure) return;
      void this.refreshList().catch(error => this.log('session list refresh failed', { error: messageOf(error) }));
      for (const st of this.sessions.values()) if (st.sdk && !st.closing) this.probe(st);
    }, 8000);
    this.poll.unref();
  }

  snapshot(): Snapshot {
    return structuredClone({
      type: 'snapshot', permissionPolicy: 'allow-all', agentStatus: this.agentStatus,
      models: this.models, vapidPublicKey: this.vapidPublicKey,
      sessions: [...this.sessions.values()].map(st => st.meta),
      ...this.inboxCounts(),
    });
  }

  getMeta(id: string): SessionMeta | null { return structuredClone(this.sessions.get(id)?.meta ?? null); }
  listLive(): SessionBrief[] {
    return [...this.sessions.values()].map(({ meta }) => ({
      sessionId: meta.sessionId, title: meta.title, cwd: meta.cwd, status: meta.status,
      loaded: meta.loaded, lastActivity: meta.lastActivity, currentModelId: meta.currentModelId,
    }));
  }
  private inboxCounts() {
    const inbox = this.prefs.inbox;
    return { inboxRevision: inbox.revision, unreadCount: unreadSessionCount(Object.values(inbox.sessions)) };
  }
  attentionCount(): number { return this.inboxCounts().unreadCount; }
  markSeen(id: string, observedId?: number): void {
    const st = this.sessions.get(id);
    if (!st) return;
    try {
      if (this.prefs.markSeen(id, observedId)) this.publishInbox(st);
    } catch (error) {
      this.inboxError(st, error);
      throw error;
    }
  }

  refreshList(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const list = await this.untilFatal(() => this.runtime.listSessions());
      this.assertAvailable();
      for (const row of list) {
        if (this.prefs.isTrashed(row.sessionId) || this.removing.has(row.sessionId)) continue;
        const existing = this.sessions.get(row.sessionId);
        if (existing) {
          // Native indexing can lag creation/unload; an absent row is never proof of deletion.
          if (!existing.sdk && !existing.local && !existing.load && !existing.closing) this.updateListed(existing, row);
          continue;
        }
        const st = stateFor(row.sessionId, row.context?.workingDirectory ?? homedir());
        this.updateListed(st, row);
        Object.assign(st.meta, this.inboxFields(row.sessionId));
        this.sessions.set(row.sessionId, st);
        if (this.agentStatus === 'up') this.emit({ type: 'session/added', session: structuredClone(st.meta) });
      }
    })().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  private updateListed(st: State, row: SessionMetadata): void {
    const fields = {
      title: cleanSessionTitle(row.summary) || st.meta.title,
      createdAt: row.startTime.getTime(), lastActivity: row.modifiedTime.getTime(),
      pinned: this.prefs.isPinned(row.sessionId),
    };
    const changed = (['title', 'createdAt', 'lastActivity', 'pinned'] as const)
      .some(key => st.meta[key] !== fields[key]);
    if (changed && this.agentStatus === 'up' && this.sessions.get(row.sessionId) === st) this.patch(st, fields);
    else Object.assign(st.meta, fields);
  }

  private state(id: string): State {
    this.assertAvailable();
    if (this.stopped) throw new Error('Engine is stopped; start it before performing session operations');
    if (this.lifecycle) throw new Error('Engine lifecycle transition is in progress');
    if (this.removing.has(id)) throw new Error('Session removal is in progress');
    const st = this.sessions.get(id);
    if (!st) throw new Error('Unknown session');
    if (st.closing) throw new Error('Session transition is in progress');
    return st;
  }

  private async config(st: State): Promise<SessionConfig> {
    return {
      sessionId: st.meta.sessionId, workingDirectory: st.meta.cwd, streaming: true,
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

  private projectDecisions(st: State): void {
    const decisions = [...st.decisions.values()];
    this.patch(st, {
      ask: decisions.find(d => d.kind === 'ask')?.value as SessionMeta['ask'] ?? null,
      planRequest: decisions.find(d => d.kind === 'planRequest')?.value as SessionMeta['planRequest'] ?? null,
      elicitation: decisions.find(d => d.kind === 'elicitation')?.value as SessionMeta['elicitation'] ?? null,
    });
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
    this.birthGate = result.catch(() => {});
    return result.finally(() => { this.births--; });
  }

  async newSession(cwd: string): Promise<string> {
    this.assertAvailable();
    if (this.stopped) throw new Error('Engine is stopped; start it before creating sessions');
    if (this.lifecycle) throw new Error('Engine lifecycle transition is in progress');
    const directory = resolve(cwd || homedir());
    if (!statSync(directory).isDirectory()) throw new Error('Working directory must be a directory');
    const id = randomUUID();
    const st = stateFor(id, directory);
    st.local = true;
    st.unsubmitted = true;
    this.sessions.set(id, st);
    this.emit({ type: 'session/added', session: structuredClone(st.meta) });
    await this.ensureLoaded(st, true);
    return id;
  }

  async forkSession(id: string, toEventId?: string, name?: string): Promise<{ sessionId: string }> {
    const st = this.state(id);
    st.closing = true;
    this.patch(st, { closing: true });
    try {
      await this.checkIdle(st);
      const sdk = st.sdk;
      if (!sdk) throw new SessionUnloadedError();
      if (st.meta.scheduleCount) throw new Error('Source has active schedules; fork requires an idle source without timers');
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
        const child = stateFor(result.sessionId, st.meta.cwd);
        if (result.name) child.meta.title = result.name;
        this.sessions.set(result.sessionId, child);
        this.emit({ type: 'session/added', session: structuredClone(child.meta) });
        return { sessionId: result.sessionId };
      });
    } finally {
      st.closing = false;
      this.patch(st, { closing: false });
    }
  }

  private async absentDraft(st?: State): Promise<boolean> {
    if (!st?.local || !st.unsubmitted) return false;
    const metadata = await this.untilFatal(() => this.runtime.getSessionMetadata(st.meta.sessionId));
    if (metadata) {
      st.unsubmitted = false;
      st.draftSettings = undefined;
      return false;
    }
    // A send or native event can settle during the passive lookup.
    return st.unsubmitted === true && this.sessions.get(st.meta.sessionId) === st;
  }

  private draftModel(model: Awaited<ReturnType<CopilotSession['rpc']['model']['getCurrent']>>): DraftSettings['model'] {
    const effort = model.reasoningEffort;
    if (effort !== undefined && effort !== 'low' && effort !== 'medium'
      && effort !== 'high' && effort !== 'xhigh' && effort !== 'max') {
      throw new Error(`Native reasoning effort cannot be restored through SDK creation: ${effort}`);
    }
    return { model: model.modelId, reasoningEffort: effort, contextTier: model.contextTier };
  }

  private async ensureLoaded(st: State, create = false): Promise<void> {
    this.assertAvailable();
    if (st.closing || this.lifecycle) return Promise.reject(new Error('Session lifecycle transition is in progress'));
    if (st.load) return st.load;
    if (st.sdk && await this.liveSession(st)) {
      if (st.draftRestorePending) throw new Error('Native draft initialization is incomplete; explicitly reload before continuing');
      return;
    }
    this.assertAvailable();
    if (st.closing || this.lifecycle) throw new Error('Session lifecycle transition is in progress');
    if (st.load) return st.load;
    this.patch(st, { loading: true });
    st.load = this.untilFatal(() => this.birth(async () => {
      this.assertAvailable();
      // Native cleanup discards configured empty sessions. Recreate only our own
      // never-submitted draft, after an authoritative passive absence check.
      if (!create) create = await this.absentDraft(st);
      const draft = create && st.unsubmitted ? st.draftSettings : undefined;
      const owner: NonNullable<State['eventOwner']> = {};
      st.eventOwner = owner;
      st.buffered = [];
      const config: SessionConfig = { ...await this.config(st), ...draft?.model, onEvent: event => {
        if (st.eventOwner !== owner || this.failure) return;
        if (submittedEvents.has(event.type)) {
          st.unsubmitted = false;
          st.draftSettings = undefined;
        }
        if (st.buffered) st.buffered.push(event);
        else {
          try { this.onLive(st, event); }
          catch (error) {
            this.patch(st, { error: `Native event could not be applied: ${messageOf(error)}` });
            this.log('native event failed', { sessionId: st.meta.sessionId, error: messageOf(error) });
          }
        }
      } };
      const sdk = await this.untilFatal(() => create
        ? this.runtime.createSession(config)
        : this.runtime.resumeSession(st.meta.sessionId, config));
      this.assertAvailable();
      if (st.eventOwner !== owner) throw new Error('Native session closed while loading; explicitly resume to continue');
      st.sdk = sdk;
      if (owner.closed?.has(sdk)) {
        this.detach(st);
        throw new Error('Native session closed while loading; explicitly resume to continue');
      }
      delete owner.closed;
      st.draftRestorePending = create && st.unsubmitted === true;
      await this.withSession(st, sdk, () => this.replay(st));
      if (draft && st.unsubmitted) {
        // SDK 1.0.13 has no name/mode creation fields. Initialize only this new,
        // confirmed-absent draft; never replay settings onto a resumed session.
        if (draft.name) await this.withSession(st, sdk, () => sdk.rpc.name.set({ name: draft.name! }));
        await this.applyMode(st, sdk, draft.mode);
      }
      const [model, mode, name] = await this.withSession(st, sdk, () => settled([
        this.readResource(st, sdk, 'model'), sdk.rpc.mode.get(), sdk.rpc.name.get(), this.readResource(st, sdk, 'models'),
      ] as const));
      this.assertAvailable();
      if (st.sdk !== sdk) throw new Error('Native session closed while loading; explicitly resume to continue');
      if (draft && (name.name !== draft.name || mode !== draft.mode
        || model.modelId !== draft.model.model
        || (model.reasoningEffort ?? null) !== (draft.model.reasoningEffort ?? null)
        || (model.contextTier ?? null) !== (draft.model.contextTier ?? null))) {
        throw new Error('Native draft settings were not restored; no prompt was sent');
      }
      if (st.unsubmitted) st.draftSettings = { model: this.draftModel(model), name: name.name, mode };
      st.draftRestorePending = false;
      this.patch(st, {
        loaded: true, error: null, status: 'idle',
        currentMode: mode, ...(name.name ? { title: name.name } : {}),
      }, true);
      // Rewinding all conversation can leave a native title behind. Do not
      // treat that cold, already-named workspace as a brand-new conversation.
      if (name.name && !st.unsubmitted && !st.fold.messages.some(message => message.role === 'user' || message.role === 'assistant')) {
        st.autoNameSeen = true;
      }
      st.local = true;
      await this.untilFatal(() => this.syncNative(st));
    })).catch(error => {
      if (!st.sdk) {
        st.eventOwner = undefined;
        st.buffered = undefined;
      }
      this.patch(st, { loaded: !!st.sdk, status: 'error', error: messageOf(error) });
      throw error;
    }).finally(() => {
      st.load = undefined;
      this.patch(st, { loading: false });
      if (st.pendingReply) this.scheduleSync(st);
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
      if (!this.failure) this.log('session liveness check failed', { sessionId: st.meta.sessionId, error: messageOf(error) });
    });
  }

  private async replay(st: State): Promise<void> {
    const sdk = st.sdk!;
    const previous = { fold: st.fold, eventIds: st.eventIds, userMessageIds: st.userMessageIds };
    st.buffered ??= [];
    try {
      const read = (direction: 'forward' | 'backward', max: number, cursor?: string) =>
        this.withSession(st, sdk, () => sdk.rpc.eventLog.read({
          direction, max, cursor, types: activeEventTypes, agentScope: 'all', includeEphemeral: false,
        }));
      const validate = (page: Awaited<ReturnType<typeof read>>) => {
        if (page.cursorStatus !== 'ok') throw new Error(`Native display history cursor ${page.cursorStatus}`);
        if (typeof page.cursor !== 'string') throw new Error('Native display history returned a missing cursor');
      };
      // One durable tail fence prevents continuous new work from extending the
      // replay. Its later events (including ephemerals) already have onEvent.
      const tail = await read('backward', 1);
      validate(tail);
      if (tail.events.length > 1 || (!tail.events.length && tail.hasMore)) {
        throw new Error('Native display history returned an invalid tail');
      }
      const lastId = tail.events[0]?.id;
      if (tail.events.length && !lastId) throw new Error('Native display history returned a missing event ID');
      st.fold = newFoldState();
      st.eventIds = new Set();
      st.userMessageIds = new Set();
      if (!lastId) return;
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const page = await read('forward', 200, cursor);
        validate(page);
        if (cursors.has(page.cursor)) throw new Error('Native display history cursor did not advance');
        cursors.add(page.cursor);
        if (!page.events.length || page.events.length > 200) throw new Error('Native display history returned an invalid page before its captured tail');
        for (const event of page.events) {
          if (!event.id || st.eventIds.has(event.id)) throw new Error('Native display history returned duplicate or missing event IDs');
          this.fold(st, event, false);
          // An event received during initialization is live even if it also
          // landed before the durable fence. flushBuffered owns those effects.
          if (!st.buffered?.some(buffered => buffered.id === event.id)) this.observeNamingReply(st, event, false);
          if (event.id === lastId) return;
        }
        if (!page.hasMore) throw new Error('Native display history changed before its captured tail was reached');
        cursor = page.cursor;
      }
    } catch (error) {
      if (st.sdk === sdk) Object.assign(st, previous);
      throw error;
    } finally {
      if (st.sdk === sdk) this.flushBuffered(st);
    }
  }

  private flushBuffered(st: State): void {
    const buffered = st.buffered ?? [];
    st.buffered = undefined;
    const applied = new Set<string>();
    const finalized = new Set<string>();
    const finalizedReasoning = new Set<string>();
    // Ephemerals are absent from durable reads. Do not append their old deltas
    // onto an authoritative final message already folded from that read.
    for (let i = buffered.length - 1; i >= 0; i--) {
      const event = buffered[i]!;
      const owner = event.agentId ?? String((event.data as Record<string, unknown>).parentToolCallId ?? '');
      const reasoning = event.type === 'assistant.reasoning' || event.type === 'assistant.reasoning_delta'
        ? JSON.stringify([owner, event.data.reasoningId]) : undefined;
      if (event.type === 'assistant.message' && st.eventIds.has(event.id)) finalized.add(owner);
      if (event.type === 'assistant.reasoning' && st.eventIds.has(event.id)) finalizedReasoning.add(reasoning!);
      if (event.ephemeral && (finalized.has(owner)
        || (event.type === 'assistant.reasoning_delta' && finalizedReasoning.has(reasoning!)))
        && ['assistant.message_start', 'assistant.message_delta', 'assistant.reasoning', 'assistant.reasoning_delta'].includes(event.type)) {
        applied.add(event.id);
        if (!owner) st.eventIds.add(event.id);
      }
    }
    for (const event of buffered) {
      if (applied.has(event.id)) continue;
      applied.add(event.id);
      // Fold overlap once, but keep its live lifecycle and attention effects.
      this.onLive(st, event, true);
    }
  }

  private fold(st: State, native: SessionEvent, live: boolean): SdkEvent | null {
    if (st.eventIds.has(native.id)) return null;
    const event = normalizeEvent(native);
    const visible = isFoldContentVisible(st.fold, event, activeScope);
    if ((visible && activeEventTypes.includes(native.type)) || event.type.startsWith('subagent.')) {
      st.eventIds.add(native.id);
    }
    if (submittedEvents.has(native.type)) {
      st.unsubmitted = false;
      st.draftSettings = undefined;
    }
    if (event.type === 'user.message' && visible) {
      if (live) st.userMessageIds.add(native.id);
      st.accepted.delete(native.id);
      if (typeof event.data.messageId === 'string') {
        if (live) st.userMessageIds.add(event.data.messageId);
        st.accepted.delete(event.data.messageId);
      }
    }
    const result = foldEvent(st.fold, event, { scope: activeScope });
    if (live) {
      for (const id of result.changed) {
        const index = st.fold.byId.get(id);
        const message = index === undefined ? undefined : st.fold.messages[index];
        if (message) this.emit({ type: 'msg/upsert', sessionId: st.meta.sessionId, message: structuredClone(summarizeMessage(message)) });
      }
      if (result.changed.length) this.patch(st, { lastActivity: Date.now() });
      if (result.metaChanged && st.fold.currentModelId) {
        delete st.resourceReads.model;
        this.patch(st, { currentModelId: st.fold.currentModelId });
      }
    }
    return event;
  }

  private onLive(st: State, native: SessionEvent, buffered = false): void {
    if (!st.sdk || this.failure) return;
    const event = this.fold(st, native, true) ?? (buffered ? normalizeEvent(native) : null);
    if (!event) return;
    st.revision++;
    const data = event.data;
    const root = !event.agentId && !event.parentToolCallId;
    if (root && event.type !== 'user.message' && typeof data.interactionId === 'string'
      && st.interactionId && data.interactionId !== st.interactionId
      && (event.type.startsWith('assistant.') || event.type === 'session.error')) return;
    if (root && (event.type === 'user.message' || event.type === 'assistant.turn_start')) {
      st.turnEpoch++;
      st.interactionId = typeof data.interactionId === 'string' ? data.interactionId : undefined;
    }
    // Late lifecycle effects from an interrupted interaction must not erase the
    // queued turn's reply/decision state; its transcript remains native history.
    if (root && event.type.startsWith('assistant.') && st.interruptedEpoch === st.turnEpoch) return;
    this.observeNamingReply(st, native, true);
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
    if (event.type === 'tool.execution_start' && data.toolName === 'task' && typeof data.toolCallId === 'string') {
      st.tasks.add(data.toolCallId);
      this.patch(st, { activeSubagents: st.tasks.size });
    }
    if (native.type === 'tool.execution_complete' && st.tasks.delete(native.data.toolCallId)) {
      this.scheduleSync(st);
    }
    if (event.type === 'tool.execution_start' && data.toolName === 'report_intent') {
      const args = data.arguments as { intent?: string } | undefined;
      if (typeof args?.intent === 'string') this.patch(st, { intent: args.intent });
    }
    if (!event.agentId && !event.parentToolCallId && event.type === 'assistant.turn_start') {
      st.finalReply = undefined;
      st.pendingReply = undefined;
      this.patch(st, { status: 'running', nativeProcessing: true, error: null });
    }
    if (!event.agentId && !event.parentToolCallId && event.type === 'assistant.message') {
      const index = typeof data.messageId === 'string' ? st.fold.byId.get(data.messageId) : undefined;
      const reply = index === undefined ? undefined : st.fold.messages[index];
      if (reply && !reply.subtype && (reply.content.trim() || reply.attachment)) st.finalReply = structuredClone(reply);
    }
    if (!event.agentId && !event.parentToolCallId && event.type === 'assistant.turn_end') {
      if (st.finalReply && !st.cancelling) {
        const fallback = st.finalReply.attachment
          ? notificationSummary(`附件：${st.finalReply.attachment.name}`, '收到新附件') : '回复已完成';
        st.pendingReply = { eventId: native.id, body: notificationSummary(st.finalReply.content, fallback) };
      }
      this.scheduleSync(st);
    }
    if (event.type === 'session.error') {
      st.finalReply = undefined;
      st.pendingReply = undefined;
      this.patch(st, { status: 'error', error: String(data.message ?? 'Native turn failed') });
    }
    if (event.type === 'session.title_changed' && typeof data.title === 'string') this.patch(st, { title: cleanSessionTitle(data.title) });
    if (event.type === 'session.mode_changed' && ['interactive', 'plan', 'autopilot'].includes(String(data.newMode))) {
      this.patch(st, { currentMode: data.newMode as SessionMeta['currentMode'] });
    }
    if (event.type === 'session.compaction_start') this.patch(st, { compacting: true });
    if (event.type === 'session.compaction_complete') this.patch(st, { compacting: false });
    switch (native.type) {
      case 'session.idle':
      case 'session.error':
      case 'pending_messages.modified':
      case 'session.background_tasks_changed':
      case 'session.compaction_complete':
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed':
        this.scheduleSync(st);
        break;
      case 'session.schedule_created':
      case 'session.schedule_cancelled':
      case 'session.schedule_rearmed':
        this.scheduleResourceRead(st, 'schedule');
        break;
      case 'session.todos_changed':
        this.scheduleResourceRead(st, 'todos');
        break;
      case 'session.model_change':
        this.scheduleResourceRead(st, 'model');
        break;
      case 'session.mcp_servers_loaded':
      case 'session.mcp_server_removed':
        this.scheduleResourceRead(st, 'mcp');
        break;
      case 'session.mcp_server_status_changed':
        if (native.data.status === 'pending') {
          st.nativeMcpPending = Math.max(1, st.nativeMcpPending);
          this.patchMcpPending(st);
        }
        this.scheduleResourceRead(st, 'mcp');
        break;
    }
  }

  private scheduleSync(st: State): void {
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
        await this.syncNative(st, false);
      } while (st.sync === sync && st.syncAgain && st.sdk === sdk && !st.closing && !this.lifecycle && !this.failure);
    }).catch(error => {
      if (st.sync === sync && st.sdk === sdk && !this.failure) {
        this.patch(st, { nativeProcessing: true, error: `Native state could not be confirmed: ${messageOf(error)}` });
      }
    }).finally(() => {
      if (st.sync !== sync) return;
      st.sync = undefined;
      // A load can settle after the loop exits but before this promise releases
      // ownership. Do not lose the final buffered reply's requested readback.
      if (st.syncAgain) this.scheduleSync(st);
    });
    st.sync = sync;
  }

  private patchMcpPending(st: State): void {
    this.patch(st, { activeMcpOperations: st.mcpOperations + st.nativeMcpPending });
  }

  private async readResource<K extends Resource>(
    st: State, sdk: CopilotSession, resource: K, validate?: (value: ResourceValues[K]) => void,
  ): Promise<ResourceValues[K]> {
    this.assertAvailable();
    if (st.sdk !== sdk) throw new Error('Native session closed during resource read');
    const ticket = {};
    st.resourceReads[resource] = ticket;
    st.dirtyResources.delete(resource);
    const current = () => st.sdk === sdk && st.resourceReads[resource] === ticket && !this.failure;
    const readers: { [R in Resource]: () => Promise<ResourceValues[R]> } = {
      model: () => sdk.rpc.model.getCurrent(), models: () => sdk.rpc.model.list(),
      todos: () => sdk.rpc.plan.readSqlTodos(), schedule: () => sdk.rpc.schedule.list(), mcp: () => sdk.rpc.mcp.list(),
    };
    const projections: { [R in Resource]: (value: ResourceValues[R]) => Partial<LiveMeta> } = {
      model: model => ({ currentModelId: model.modelId, currentReasoningEffort: model.reasoningEffort ?? null,
        currentContextTier: model.contextTier ?? null }),
      models: models => ({ availableModels: sessionModelOptions(models.list) }),
      todos: todos => ({ todo: this.todoSummary(todos) }),
      schedule: schedules => ({ scheduleCount: schedules.entries.length }),
      mcp: mcp => {
        st.nativeMcpPending = mcp.host?.pendingConnections.length ?? 0;
        return { activeMcpOperations: st.mcpOperations + st.nativeMcpPending };
      },
    };
    try {
      const value = await this.withSession(st, sdk, readers[resource]);
      validate?.(value);
      // A superseded read still belongs to its caller; only projection is retired.
      if (current()) this.patch(st, projections[resource](value));
      return value;
    } catch (error) {
      if (current()) {
        if (resource === 'mcp') { st.nativeMcpPending = Math.max(1, st.nativeMcpPending); this.patchMcpPending(st); }
        this.patch(st, { error: `Native ${resource} state could not be confirmed: ${messageOf(error)}` });
      }
      throw error;
    }
  }

  private scheduleResourceRead(st: State, resource: Resource): void {
    delete st.resourceReads[resource];
    if (st.closing || this.lifecycle || !st.sdk || this.failure) return;
    st.dirtyResources.add(resource);
    if (st.resourceSync) return;
    const sdk = st.sdk;
    let reading!: Promise<void>;
    reading = Promise.resolve().then(async () => {
      while (st.resourceSync === reading && st.sdk === sdk && !this.failure && st.dirtyResources.size) {
        const resources = [...st.dirtyResources];
        st.dirtyResources.clear();
        // Failures are reported by readResource and never enqueue a retry.
        await settled(resources.map(resource => this.readResource(st, sdk, resource).catch(() => {})));
      }
    }).finally(() => {
      if (st.resourceSync === reading) {
        st.resourceSync = undefined;
        // An event may arrive after the last loop check but before this release.
        const dirty = st.dirtyResources.values().next().value;
        if (dirty) this.scheduleResourceRead(st, dirty);
        this.maybeAutoName(st);
      }
    });
    st.resourceSync = reading;
  }

  private todoSummary(plan: Awaited<ReturnType<CopilotSession['rpc']['plan']['readSqlTodos']>>): SessionMeta['todo'] {
    const todos = plan.rows.filter(row => row.id && row.title);
    return todos.length ? { done: todos.filter(todo => todo.status === 'done').length,
      total: todos.length, intent: todos.find(todo => todo.status === 'in_progress')?.title ?? null } : null;
  }

  private async syncNative(st: State, full = true, confirmMcp = false): Promise<void> {
    const sdk = await this.liveSession(st);
    if (!sdk) return;
    const revision = st.revision;
    const [processing, activity, queue, tasks, schedules] = await this.withSession(st, sdk, () => settled([
      full ? sdk.rpc.metadata.isProcessing() : Promise.resolve(undefined),
      sdk.rpc.metadata.activity(), sdk.rpc.queue.pendingItems(), sdk.rpc.tasks.list(),
      full ? this.readResource(st, sdk, 'schedule') : Promise.resolve(undefined),
      full || confirmMcp || st.meta.activeMcpOperations ? this.readResource(st, sdk, 'mcp') : Promise.resolve(undefined),
      full ? this.readResource(st, sdk, 'model') : Promise.resolve(undefined),
      full ? this.readResource(st, sdk, 'todos') : Promise.resolve(undefined),
    ] as const));
    if (st.sdk !== sdk) return;
    if (revision !== st.revision) {
      st.syncAgain = true;
      this.patch(st, { nativeProcessing: true });
      // Standalone full reads have no drain to consume syncAgain.
      if (full) this.scheduleSync(st);
      return;
    }
    const active = tasks.tasks.filter(task => activeTask(task.status));
    st.tasks = new Set(active.map(task => task.type === 'agent' ? task.toolCallId : task.id));
    st.steering = Math.max(0, queue.steeringMessages.length - (queue.inFlightSteeringCount ?? 0));
    const busy = !!processing?.processing || activity.hasActiveWork || st.tasks.size > 0 ||
      queue.items.length > 0 || st.steering > 0 || st.sends > 0 || st.accepted.size > 0;
    if (busy || schedules?.entries.length) {
      st.unsubmitted = false;
      st.draftSettings = undefined;
    }
    this.patch(st, {
      nativeProcessing: busy, activeSubagents: st.tasks.size,
      queue: queue.items.map(item => ({ id: item.id, text: item.displayText })),
      // A confirmed reply can outlive a failed initialization/read RPC. A real
      // turn failure clears pendingReply in onLive instead.
      status: st.meta.status === 'error' && !st.pendingReply ? 'error' : busy ? 'running' : 'idle',
      ...(!busy ? { intent: null } : {}),
    }, !!st.cancelling || !!st.load);
    if (!busy && !st.cancelling && !st.load && st.pendingReply) {
      const attention = nextAttention({ ...st.meta, choicePending: st.decisions.size > 0, attention: st.meta.attention ?? null },
        { status: st.meta.status, choicePending: st.decisions.size > 0, replyReady: true });
      if (attention === 'ready' && this.commitAttention(st, attention, st.pendingReply.eventId, st.pendingReply.body)) {
        st.pendingReply = undefined;
      }
    }
    this.maybeAutoName(st);
  }

  private observeNamingReply(st: State, native: SessionEvent, live: boolean): void {
    if (st.autoNameSeen || native.ephemeral) return;
    const event = normalizeEvent(native);
    if (event.agentId || event.parentToolCallId || !isFoldContentVisible(st.fold, event, activeScope)) return;
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
      if (live) st.autoNamePending = true;
      else st.autoNameSeen = true;
    }
  }

  private maybeAutoName(st: State): void {
    if (!st.autoNamePending || st.autoNameSeen || st.naming || !st.sdk
      || this.failure || this.lifecycle || st.meta.status !== 'idle' || this.busy(st)) return;
    void this.nameSession(st, true).catch(error => {
      this.log('automatic session naming failed', { sessionId: st.meta.sessionId, error: messageOf(error) });
    });
  }

  autoName(id: string): Promise<IntentResult<'session/auto-name'>> {
    const st = this.sessions.get(id);
    if (st && (st.closing || this.lifecycle || this.removing.has(id))) return Promise.reject(namingBusyError());
    return this.nameSession(this.state(id));
  }

  private nameSession(st: State, automatic = false): Promise<IntentResult<'session/auto-name'>> {
    if (st.naming) return st.naming;
    if (this.busy(st)) return Promise.reject(namingBusyError());
    if (st.unsubmitted) return Promise.resolve({ ok: true, applied: false, title: null, reason: 'no-context' });
    st.operations++;
    this.patch(st, { activeOperations: st.operations, autoNaming: true, autoNameError: null });
    let naming!: NonNullable<State['naming']>;
    naming = Promise.resolve().then(async (): Promise<IntentResult<'session/auto-name'>> => {
      await this.ensureLoaded(st);
      const sdk = st.sdk!;
      return this.withSession(st, sdk, async () => {
        await this.syncNative(st, false, true);
        const idle = () => st.sdk === sdk && !this.failure && !this.busy(st, false, 1);
        if (!idle()) throw namingBusyError();
        const workspace = (await sdk.rpc.workspaces.getWorkspace()).workspace;
        if (st.sdk !== sdk || this.failure) throw new Error('Native session closed during naming');
        if (workspace?.user_named) {
          if (automatic) st.autoNameSeen = true;
          if (workspace.name) this.patch(st, { title: workspace.name });
          return { ok: true, applied: false, title: workspace.name ?? null, reason: 'user-named' };
        }
        if (!st.fold.messages.some(message => !message.subtype && ['user', 'assistant'].includes(message.role)
          && (message.content.trim() || message.attachment))) {
          if (automatic) st.autoNameSeen = true;
          return { ok: true, applied: false, title: workspace?.name ?? null, reason: 'no-context' };
        }
        if (!idle()) throw namingBusyError();
        // Only native history and this volatile guard own one-shot eligibility.
        // Never retry a model query, including a rejected or uncertain one.
        st.autoNameSeen = true;
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
      if (automatic && !st.autoNameSeen && error?.code === 'SESSION_BUSY') {
        // Work discovered by the authoritative preflight is not an attempt.
        // Its next natural idle event may release this same pending reply.
        return { ok: true, applied: false, title: null, reason: 'not-applied' } as const;
      }
      if (automatic) st.autoNameSeen = true;
      this.patch(st, { autoNameError: messageOf(error) });
      throw error;
    }).finally(() => {
      st.operations--;
      if (st.naming === naming) st.naming = undefined;
      this.patch(st, { activeOperations: st.operations, autoNaming: false });
      this.maybeAutoName(st);
    });
    st.naming = naming;
    return naming;
  }

  private async operation<T>(
    id: string, work: (sdk: CopilotSession, st: State) => Promise<T>, kind: 'work' | 'settings' | 'read' = 'work',
  ): Promise<T> {
    const st = this.state(id);
    if (st.cancelling) throw new Error('Session cancellation is in progress');
    st.operations++;
    this.patch(st, { activeOperations: st.operations });
    try {
      if (kind === 'read') {
        if (!await this.liveSession(st)) throw new SessionUnloadedError();
      } else await this.ensureLoaded(st);
      this.assertAvailable();
      const sdk = st.sdk;
      if (!sdk) throw new Error('Native session is unavailable; explicitly resume to continue');
      if (kind === 'work') {
        // Disallow recreation before dispatch, even if delivery is never acknowledged.
        st.unsubmitted = false;
        st.draftSettings = undefined;
      }
      const run = () => this.withSession(st, sdk, () => work(sdk, st));
      if (kind !== 'settings' || !st.unsubmitted) return await run();
      // Keep each confirmed setting and its readback together, so an older
      // overlapping request cannot overwrite a newer draft preference.
      const next = st.settingsGate.then(run);
      st.settingsGate = next.catch(() => {});
      return await next;
    } catch (error) {
      if (!(error instanceof SessionUnloadedError)) this.patch(st, { error: messageOf(error) });
      throw error;
    } finally {
      st.operations--;
      this.patch(st, { activeOperations: st.operations });
      this.maybeAutoName(st);
    }
  }

  async prompt(id: string, text: string, mode: 'enqueue' | 'immediate' = 'enqueue', attachments?: RuntimeAttachment[]): Promise<{ ok: boolean; queued?: boolean }> {
    if (!text.trim() && !attachments?.length) throw new Error('Prompt must not be empty');
    return this.operation(id, async (sdk, st) => {
      const queued = st.meta.status === 'running' && mode === 'enqueue';
      st.sends++;
      st.finalReply = undefined;
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
        if (!st.userMessageIds.has(accepted)) st.accepted.add(accepted);
        return { ok: true, ...(queued ? { queued: true } : {}) };
      } catch (error) {
        this.patch(st, { status: 'error', error: messageOf(error) });
        throw error;
      } finally {
        st.sends--;
        this.scheduleSync(st);
      }
    });
  }

  cancel(id: string): Promise<void> {
    const st = this.state(id);
    if (st.cancelling) return st.cancelling;
    if (st.load || st.operations) return Promise.reject(new Error('Session operation is still in progress'));
    this.patch(st, { cancelling: true, error: null });
    st.cancelling = this.untilFatal(async () => {
      const sdk = await this.liveSession(st);
      if (!sdk) return;
      await this.withSession(st, sdk, () => sdk.rpc.queue.clear());
      await this.withSession(st, sdk, () => sdk.abort());
      st.finalReply = undefined;
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
    st.finalReply = undefined;
    st.pendingReply = undefined;
    st.namingReply = false;
    st.autoNamePending = false;
  }

  interrupt(id: string): Promise<IntentResult<'session/interrupt'>> {
    const st = this.state(id);
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
    }, 'read').finally(() => {
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
    });
  }

  private busy(st: State, ownTransition = false, ownOperations = 0): boolean {
    return engineSessionBusy({ ...st.meta, closing: ownTransition ? false : st.closing,
      activeOperations: st.operations - ownOperations }, st.tasks.size)
      || st.operations > ownOperations || !!st.load || st.decisions.size > 0 || st.accepted.size > 0 || st.steering > 0 || !!st.pendingReply;
  }

  private async checkIdle(st: State): Promise<void> {
    await this.liveSession(st);
    if (st.load || st.operations || st.cancelling || st.decisions.size || st.sends || st.accepted.size) throw new Error('Session has protected work');
    if (st.sync) await st.sync;
    if (st.resourceSync) await st.resourceSync;
    await this.syncNative(st);
    if (!st.sdk) this.commitClosedReply(st);
    if (this.busy(st, true)) throw new Error('Session has protected work (turn, task, queue, decision, or operation)');
  }

  private async close(st: State): Promise<void> {
    if (!st.sdk) return;
    const sdk = st.sdk;
    await this.untilFatal(() => this.runtime.closeSession(sdk));
    if (st.sdk === sdk) this.detach(st);
  }

  private detach(st: State, error?: Error): void {
    const sdk = st.sdk;
    if (!error && st.buffered) {
      this.flushBuffered(st);
    }
    st.eventOwner = undefined;
    st.sdk = null;
    st.interruptTurn = undefined;
    st.interruptedEpoch = undefined;
    st.interactionId = undefined;
    st.buffered = undefined;
    st.sync = undefined;
    st.syncAgain = false;
    st.resourceSync = undefined;
    st.resourceReads = {};
    st.dirtyResources.clear();
    st.nativeMcpPending = 0;
    if (sdk) this.bus.emit('closed', sdk);
    st.fold = newFoldState();
    st.finalReply = undefined;
    st.namingReply = false;
    st.autoNamePending = false;
    st.eventIds.clear();
    st.userMessageIds.clear();
    st.tasks.clear();
    st.accepted.clear();
    st.steering = 0;
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
  }

  private commitClosedReply(st: State): void {
    if (!st.cancelling && st.pendingReply
      && this.commitAttention(st, 'ready', st.pendingReply.eventId, st.pendingReply.body)) st.pendingReply = undefined;
  }

  private async transition<T>(st: State, work: () => Promise<T>): Promise<T> {
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
      if (this.sessions.get(st.meta.sessionId) === st) this.patch(st, { closing: false });
      if (st.syncAgain) this.scheduleSync(st);
    }
  }

  async unload(id: string): Promise<void> {
    const st = this.state(id);
    await this.transition(st, () => this.close(st));
  }
  async reload(id: string): Promise<void> {
    const st = this.state(id);
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
    if (this.lifecycle || this.births || this.startPromise || this.removing.size) throw new Error('Engine lifecycle operation is in progress');
    const all = [...this.sessions.values()];
    if (all.some(st => st.closing || st.load || st.operations || st.cancelling)) throw new Error('Session operation is in progress');
    this.lifecycle = true;
    for (const st of all) { st.closing = true; this.patch(st, { closing: true }); }
    try {
      for (const st of all) await this.checkIdle(st);
      for (const st of all) { await this.checkIdle(st); await this.close(st); }
      await this.runtime.stop();
      clearInterval(this.poll);
      this.poll = undefined;
      this.started = false;
      this.stopped = true;
      this.agentStatus = 'restarting';
      this.emit({ type: 'agent/status', status: 'restarting' });
    } finally {
      for (const st of all) { st.closing = false; this.patch(st, { closing: false }); }
      this.lifecycle = false;
      for (const st of all) if (st.syncAgain) this.scheduleSync(st);
    }
  }

  async setModel(id: string, modelId: string, reasoningEffort?: string, contextTier?: 'default' | 'long_context'): Promise<void> {
    await this.operation(id, async (sdk, st) => {
      delete st.resourceReads.model;
      delete st.resourceReads.models;
      const result = await this.withSession(st, sdk, () => sdk.rpc.model.switchTo({ modelId, reasoningEffort, contextTier }));
      const current = await this.readResource(st, sdk, 'model');
      await this.readResource(st, sdk, 'models');
      if (result.persistenceError || result.confirmation
        || (result.status !== undefined && !['applied', 'unchanged', 'deferred', 'queued'].includes(result.status))) {
        throw new Error(`Native model change ${result.status ?? 'not applied'}: ${result.persistenceError ?? result.message ?? 'confirmation or additional host action required'}`);
      }
      if (st.unsubmitted && st.draftSettings) st.draftSettings.model = this.draftModel(current);
      if (result.deferred) this.scheduleSync(st);
    }, 'settings');
  }
  private async applyMode(st: State, sdk: CopilotSession, mode: DraftSettings['mode']): Promise<void> {
    const result = await this.withSession(st, sdk, () => sdk.rpc.mode.set({ mode }));
    if (!['applied', 'unchanged'].includes(result.status) || result.confirmation
      || result.deferImplementation || result.armInteractiveContinuation) {
      throw new Error(`Native mode change ${result.status}: ${result.message ?? 'additional host action required; no continuation was sent'}`);
    }
  }
  async setMode(id: string, mode: 'interactive' | 'plan' | 'autopilot'): Promise<void> {
    await this.operation(id, async (sdk, st) => {
      await this.applyMode(st, sdk, mode);
      const currentMode = await this.withSession(st, sdk, () => sdk.rpc.mode.get());
      this.patch(st, { currentMode });
      if (st.unsubmitted && st.draftSettings) {
        st.draftSettings.mode = currentMode;
        st.draftSettings.model = this.draftModel(await this.readResource(st, sdk, 'model'));
      }
    }, 'settings');
  }
  async rename(id: string, name: string): Promise<string> {
    if (!name.trim()) throw new Error('Session name must not be empty');
    return this.operation(id, async (sdk, st) => {
      await this.withSession(st, sdk, () => sdk.rpc.name.set({ name: name.trim() }));
      const title = (await this.withSession(st, sdk, () => sdk.rpc.name.get())).name;
      if (!title) throw new Error('Native rename was not confirmed');
      this.patch(st, { title });
      if (st.unsubmitted && st.draftSettings) st.draftSettings.name = title;
      return title;
    }, 'settings');
  }
  async compact(id: string, customInstructions?: string): Promise<void> {
    await this.operation(id, async (sdk, st) => {
      this.patch(st, { compacting: true });
      try {
        const result = await this.withSession(st, sdk, () => sdk.rpc.history.compact({ customInstructions }));
        if (!result.success) throw new Error('Native compaction was unsuccessful');
      }
      finally { this.patch(st, { compacting: false }); }
    });
  }
  async rewind(id: string, toMsgId: string, rollbackFiles = false): Promise<void> {
    const st = this.state(id);
    await this.ensureLoaded(st);
    st.unsubmitted = false;
    await this.transition(st, async () => {
      const sdk = st.sdk;
      if (!sdk) throw new Error('Native session is unavailable; explicitly resume to rewind');
      const result = await this.withSession(st, sdk, () => sdk.rpc.history.rewind({
        eventId: toMsgId, mode: rollbackFiles ? 'conversation-and-files' : 'conversation',
      }));
      const mutated = (result.eventsRemoved ?? 0) > 0 || result.outcome === 'rollback-incomplete'
        || (result.outcome !== 'files-rolled-back' && result.restoredFiles.length > 0);
      if (mutated) {
        this.historyReader.clear(id);
        await this.replay(st);
        this.emit({ type: 'session/reset', page: pageHistory(id, st.fold.messages.map(summarizeMessage)) });
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
    // Protect these reads from close without invoking work/naming on completion.
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
    }
  }

  async getPlan(id: string): Promise<SessionPlan> {
    return this.operation(id, async (sdk, st) => {
      const [plan, result] = await this.withSession(st, sdk, () => settled([sdk.rpc.plan.read(), this.readResource(st, sdk, 'todos')] as const));
      const todos: TodoItem[] = result.rows.filter(row => row.id && row.title).map(row => ({
        id: row.id!, title: row.title!, description: row.description ?? undefined,
        status: ['pending', 'in_progress', 'done', 'blocked'].includes(row.status ?? '') ? row.status as TodoItem['status'] : 'pending',
      }));
      return { planMarkdown: plan.content ?? null, todos,
        changedFiles: [...st.fold.changedFiles].map(([path, operation]) => ({ path, operation })) };
    }, 'read');
  }

  async getPanels(id: string): Promise<SessionPanels> {
    return this.operation(id, async (sdk, st) => {
      const [skills, mcp, tasks, instructions, schedules] = await this.withSession(st, sdk, () => settled([
        sdk.rpc.skills.list(), sdk.rpc.mcp.list(), sdk.rpc.tasks.list(),
        sdk.rpc.instructions.getSources(), sdk.rpc.schedule.list(),
      ] as const));
      return {
        skills: skills.skills.map(s => ({ label: s.name, sublabel: s.source, enabled: s.enabled })),
        mcpServers: mcp.servers.map(s => ({ label: s.name, sublabel: s.status, enabled: this.mcpEnabled(mcp, s.name) })),
        tasks: tasks.tasks.map(t => ({ label: t.description || t.id, sublabel: t.status })),
        instructionSources: instructions.sources.map(s => ({ label: s.label, sublabel: s.sourcePath })),
        schedules: schedules.entries.map(s => ({ label: s.displayPrompt || s.prompt, sublabel: s.nextRunAt })),
      };
    }, 'read');
  }

  async listGlobalMcp(): Promise<McpServerGlobal[]> {
    const [definitions, discovered] = await this.untilFatal(() => settled([
      this.runtime.rpc.mcp.config.list(), this.runtime.rpc.mcp.discover({ workingDirectory: homedir() }),
    ] as const));
    return Object.entries(definitions.servers).map(([name, config]) => {
      const server = discovered.servers.find(server => server.name === name && server.source === 'user');
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
    const st = this.state(id);
    if (!st.sdk) return { loaded: false, servers: [] };
    try {
      return await this.operation(id, async (sdk, st) => {
        const result = await this.withSession(st, sdk, () => sdk.rpc.mcp.list());
        return { loaded: true, servers: result.servers.map(server => ({
          name: server.name, detail: server.sourcePlugin ?? server.source ?? 'native',
          status: this.mcpStatus(server.status), error: server.error,
          enabled: this.mcpEnabled(result, server.name),
        })) };
      }, 'read');
    } catch (error) {
      if (error instanceof SessionUnloadedError) return { loaded: false, servers: [] };
      throw error;
    }
  }
  private mcpEnabled(result: Awaited<ReturnType<CopilotSession['rpc']['mcp']['list']>>, name: string): boolean {
    const server = result.servers.find(server => server.name === name);
    if (!server || !result.host) throw new Error(`Native MCP state is unconfirmed for ${name}`);
    return server.status !== 'disabled' && !result.host.disabledServers.includes(name);
  }
  private mcpStatus(status: string): McpServerStatus {
    return ['connected', 'failed', 'pending', 'needs_auth', 'disabled', 'not_configured', 'unloaded'].includes(status)
      ? status as McpServerStatus : 'not_configured';
  }
  async toggleSessionMcp(id: string, name: string, enabled: boolean): Promise<McpToggleResult> {
    if (this.state(id).meta.activeMcpOperations) throw new Error('MCP mutation is already in progress');
    return this.operation(id, async (sdk, st) => {
      if (st.meta.activeMcpOperations) throw new Error('MCP mutation is already in progress');
      const operation: McpToggleOperation = { id: randomUUID(), desiredEnabled: enabled,
        state: 'running', startedAt: Date.now(), status: 'pending' };
      st.mcpOperations++;
      delete st.resourceReads.mcp;
      this.patchMcpPending(st);
      let applied = false;
      let submitted = false;
      try {
        const before = await this.withSession(st, sdk, () => sdk.rpc.mcp.list());
        if (!before.servers.some(server => server.name === name)) throw new Error(`Unknown native MCP server: ${name}`);
        this.mcpEnabled(before, name);
        submitted = true;
        await this.withSession(st, sdk, () => sdk.rpc.mcp[enabled ? 'enable' : 'disable']({ serverName: name }));
        const result = await this.readResource(st, sdk, 'mcp', value => { this.mcpEnabled(value, name); });
        const server = result.servers.find(server => server.name === name);
        const actualEnabled = this.mcpEnabled(result, name);
        operation.status = !actualEnabled ? 'disabled' : this.mcpStatus(server?.status ?? 'not_configured');
        applied = actualEnabled === enabled && (!enabled || operation.status === 'connected');
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
        try { result = await this.readResource(st, sdk, 'mcp', value => { this.mcpEnabled(value, name); }); }
        catch (readError) {
          this.assertAvailable();
          throw new Error(`${operation.error}; MCP state is unknown: ${messageOf(readError)}`);
        }
        const server = result.servers.find(server => server.name === name);
        const actualEnabled = this.mcpEnabled(result, name);
        operation.status = !actualEnabled ? 'disabled' : this.mcpStatus(server?.status ?? 'not_configured');
        if (result.host?.pendingConnections.length) operation.state = 'settling';
        return { ok: false, applied, sessionId: id, name,
          enabled: actualEnabled, status: operation.status, error: operation.error, operation };
      } finally {
        operation.completedAt = Date.now();
        st.mcpOperations--;
        this.patchMcpPending(st);
      }
    }, 'settings');
  }
  async refreshMcp(): Promise<void> {
    await this.untilFatal(() => this.runtime.rpc.mcp.config.reload());
    await this.listGlobalMcp();
  }
  async reloadSessionMcp(id: string): Promise<{ reconnected: number }> {
    const st = this.state(id);
    if (!st.sdk) throw new SessionUnloadedError();
    return this.transition(st, async () => {
      const sdk = st.sdk;
      if (!sdk) throw new SessionUnloadedError();
      await this.untilFatal(() => this.runtime.rpc.mcp.config.reload());
      st.mcpOperations++;
      delete st.resourceReads.mcp;
      st.nativeMcpPending = Math.max(1, st.nativeMcpPending);
      this.patchMcpPending(st);
      try {
        // Native reload also reapplies global MCP choices; session overrides
        // are intentionally not restored by Cockpit.
        await this.withSession(st, sdk, () => sdk.rpc.mcp.reload());
        const result = await this.readResource(st, sdk, 'mcp');
        const failed = result.servers.filter(server => this.mcpEnabled(result, server.name) && server.status !== 'connected');
        if (failed.length || result.host?.pendingConnections.length) throw new Error(`MCP connections not confirmed: ${failed.map(server => server.name).join(', ') || 'pending'}`);
        return { reconnected: result.servers.filter(server => server.status === 'connected').length };
      } finally {
        st.mcpOperations--;
        this.patchMcpPending(st);
      }
    });
  }

  private async discoverSkills(cwd?: string) {
    const result = await this.untilFatal(() => this.runtime.rpc.skills.discover({ projectPaths: [resolve(cwd || homedir())] }));
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
    }, 'settings');
  }

  async refreshSkills(): Promise<void> {
    this.assertAvailable();
    const loaded = [...this.sessions.values()].filter(st => st.sdk);
    if (!loaded.length) {
      await this.discoverSkills();
      return;
    }
    for (const st of loaded) {
      await this.operation(st.meta.sessionId, async sdk => {
        const result = await sdk.rpc.skills.reload();
        const diagnostics = [...result.errors, ...result.warnings];
        if (diagnostics.length) throw new Error(`Native skill reload diagnostics: ${diagnostics.join('; ')}`);
      }, 'read');
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
    return this.operation(id, (sdk, st) => this.scheduleMutation(st, async () => {
      if (options.at !== undefined) {
        seconds = Math.ceil((options.at - Date.now()) / 1000);
        if (seconds < 1) throw new Error('Absolute schedule time passed while waiting for the runtime');
      }
      const before = new Set((await this.withSession(st, sdk, () => sdk.rpc.schedule.list())).entries.map(entry => entry.id));
      delete st.resourceReads.schedule;
      const result = await this.withSession(st, sdk, () => sdk.rpc.commands.invoke({ name: recurring ? 'every' : 'after', input: `${seconds}s ${options.prompt}` }));
      const entries = (await this.readResource(st, sdk, 'schedule')).entries;
      const created = entries.find(entry => !before.has(entry.id) && entry.prompt === options.prompt
        && entry.recurring === recurring && entry.intervalMs === seconds * 1000);
      if (!created) return { error: `Native schedule was not confirmed (${result.kind}); no model fallback was sent` };
      const entry = this.scheduleEntry(created);
      if (result.kind !== 'text' && result.kind !== 'completed') return { entry, error: `Native schedule created with unexpected command outcome: ${result.kind}` };
      return { entry };
    }));
  }
  private scheduleMutation<T>(st: State, work: () => Promise<T>): Promise<T> {
    const next = st.scheduleGate.then(work);
    st.scheduleGate = next.catch(() => {});
    return next;
  }
  private scheduleEntry(raw: Awaited<ReturnType<CopilotSession['rpc']['schedule']['list']>>['entries'][number]): ScheduleEntry {
    const nextRunAt = Date.parse(raw.nextRunAt);
    if (!Number.isFinite(nextRunAt)) throw new Error('Native schedule contains an invalid nextRunAt');
    return { id: raw.id, prompt: raw.prompt, recurring: raw.recurring, nextRunAt,
      intervalMs: raw.intervalMs, cron: raw.cron, tz: raw.tz, at: raw.at, displayPrompt: raw.displayPrompt };
  }
  async listSchedules(id: string): Promise<ScheduleEntry[]> {
    return this.operation(id, async (sdk, st) => {
      const entries = (await this.readResource(st, sdk, 'schedule')).entries;
      return entries.map(entry => this.scheduleEntry(entry));
    }, 'read');
  }
  async stopSchedule(id: string, scheduleId: number): Promise<boolean> {
    return this.operation(id, (sdk, st) => this.scheduleMutation(st, async () => {
      delete st.resourceReads.schedule;
      const result = await this.withSession(st, sdk, () => sdk.rpc.schedule.stop({ id: scheduleId }));
      await this.readResource(st, sdk, 'schedule');
      return !!result.entry;
    }));
  }

  async respondAsk(id: string, requestId: string, answer: string, wasFreeform: boolean): Promise<void> {
    this.answer(this.state(id), requestId, 'ask', { answer, wasFreeform });
  }
  async respondPlan(id: string, requestId: string, action: ExitPlanModeAction): Promise<void> {
    this.answer(this.state(id), requestId, 'planRequest', { approved: true, selectedAction: action });
  }
  async respondElicitation(id: string, requestId: string, action: 'accept' | 'decline' | 'cancel'): Promise<void> {
    this.answer(this.state(id), requestId, 'elicitation', { action });
  }
  async planSupersede(id: string, requestId: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error('Plan feedback must not be empty');
    this.answer(this.state(id), requestId, 'planRequest', { approved: false, feedback: message });
  }

  async pin(id: string, pinned: boolean): Promise<boolean> {
    const st = this.state(id);
    this.prefs.setPinned(id, pinned);
    this.patch(st, { pinned });
    return pinned;
  }
  async deleteSession(id: string, reason?: string): Promise<void> {
    const st = this.state(id);
    this.removing.add(id);
    try {
      await this.transition(st, async () => {
        await this.close(st);
        this.prefs.trashSession(id, reason);
        Object.assign(st.meta, this.inboxFields(id));
        this.trashedMeta.set(id, structuredClone(st.meta));
        this.sessions.delete(id);
        this.historyReader.clear(id);
        this.emit({ type: 'session/removed', sessionId: id, ...this.inboxCounts() });
      });
    } finally { this.removing.delete(id); }
  }
  async restoreSession(id: string): Promise<boolean> {
    this.assertAvailable();
    if (this.removing.has(id) || this.lifecycle) throw new Error('Session lifecycle transition is in progress');
    if (!this.prefs.isTrashed(id)) return false;
    this.prefs.restoreSession(id);
    const meta = this.trashedMeta.get(id);
    if (meta) {
      const st = stateFor(id, meta.cwd, meta.title);
      Object.assign(st.meta, meta, this.inboxFields(id), { closing: false });
      st.local = true;
      this.sessions.set(id, st);
      this.trashedMeta.delete(id);
      this.emit({ type: 'session/added', session: structuredClone(st.meta) });
    }
    await this.refreshList();
    return true;
  }
  async listTrash() {
    const rows = new Map((await this.untilFatal(() => this.runtime.listSessions())).map(row => [row.sessionId, row]));
    return this.prefs.trashedEntries().map(mark => ({
      ...mark, title: this.trashedMeta.get(mark.sessionId)?.title || rows.get(mark.sessionId)?.summary || mark.sessionId.slice(0, 8),
      cwd: this.trashedMeta.get(mark.sessionId)?.cwd ?? rows.get(mark.sessionId)?.context?.workingDirectory ?? homedir(),
    }));
  }
  async purgeSession(id: string): Promise<void> {
    this.assertAvailable();
    if (this.stopped || this.lifecycle || this.startPromise || this.removing.has(id)) throw new Error('Session lifecycle transition is in progress');
    const st = this.sessions.get(id) ?? (this.prefs.isTrashed(id) ? stateFor(id, this.trashedMeta.get(id)?.cwd ?? homedir()) : undefined);
    if (!st) throw new Error('Unknown session');
    this.removing.add(id);
    try {
      await this.transition(st, async () => {
        await this.close(st);
        // The API's confirm:true gate precedes this operation. Native deletion is
        // authoritative; never remove files or preferences to simulate success.
        await this.untilFatal(() => this.runtime.deleteSession(id));
        this.historyReader.clear(id);
        try { this.prefs.forgetSession(id); }
        catch (error) { throw new Error(`Native history deleted; preferences cleanup failed: ${messageOf(error)}`); }
        this.sessions.delete(id);
        this.trashedMeta.delete(id);
        this.emit({ type: 'session/removed', sessionId: id, ...this.inboxCounts() });
      });
    } finally { this.removing.delete(id); }
  }

  toolImage(request: ToolImageRead, signal?: AbortSignal) {
    return this.untilFatal(() =>
      readToolImage(params => this.runtime.rpc.sessions.readPersistedEvents(params), request, signal));
  }

  history(id: string, beforeMsgId?: string, limit = 30, afterMsgId?: string, details: HistoryDetails = 'full'): Promise<HistoryPage> {
    return this.untilFatal(async () => await this.absentDraft(this.sessions.get(id))
      ? pageHistory(id, [], beforeMsgId, limit, afterMsgId)
      : this.historyReader.read(id, beforeMsgId, limit, afterMsgId, details));
  }
  resumeHistory(id: string, resume: HistoryResume, limit = 30, details: HistoryDetails = 'full'): Promise<HistoryPage> {
    return this.untilFatal(async () => await this.absentDraft(this.sessions.get(id))
      ? resume.token
        ? { sessionId: id, messages: [], hasMore: false, resume: { status: 'unavailable', reason: 'locator' } }
        : { ...pageHistory(id, [], undefined, limit), resume: { status: 'ready' } }
      : this.historyReader.readResume(id, resume, limit, details));
  }
  subagentHistory(
    id: string, toolCallId: string, beforeMsgId?: string, limit = 30, afterMsgId?: string,
    details: HistoryDetails = 'summary',
  ): Promise<SubagentHistoryPage> {
    return this.untilFatal(() => this.historyReader.readSubagent(id, toolCallId, beforeMsgId, limit, afterMsgId, details));
  }
  async peekSession(id: string, beforeMsgId?: string, limit = 30, details: HistoryDetails = 'full'): Promise<{
    sessionId: string; title: string; cwd: string; messages: ChatMessage[]; hasMore: boolean;
  }> {
    const meta = this.sessions.get(id)?.meta;
    const page = await this.untilFatal(async () => await this.absentDraft(this.sessions.get(id))
      ? { ...pageHistory(id, [], beforeMsgId, limit), title: meta!.title, cwd: meta!.cwd }
      : this.historyReader.readWithMetadata(id, beforeMsgId, limit, undefined, details));
    return { sessionId: id, title: meta?.title ?? page.title, cwd: meta?.cwd ?? page.cwd,
      messages: page.messages, hasMore: page.hasMore };
  }

  listDir(path?: string): DirListing {
    let target = path?.trim() || homedir();
    if (target === '~' || target.startsWith('~/')) target = join(homedir(), target.slice(1));
    target = resolve(target);
    let names: string[];
    try { names = readdirSync(target); }
    catch { target = homedir(); names = readdirSync(target); }
    const entries = names.filter(name => !name.startsWith('.')).flatMap(name => {
      try { return [{ name, isDir: statSync(join(target, name)).isDirectory() }]; }
      catch { return []; }
    }).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return { path: target, parent: dirname(target) === target ? null : dirname(target), entries };
  }

  private patch(st: State, fields: Partial<LiveMeta>, silent = false): void {
    const previous = { status: st.meta.status, choicePending: !!(st.meta.ask || st.meta.planRequest || st.meta.elicitation),
      attention: st.meta.attention ?? null };
    for (const key of ['currentReasoningEffort', 'currentContextTier', 'currentMode'] as const) {
      if (key in fields && fields[key] === undefined) fields[key] = null;
    }
    Object.assign(st.meta, fields);
    const attention = nextAttention(previous, { status: st.meta.status,
      choicePending: st.decisions.size > 0, silent });
    this.emit({ type: 'session/patch', ...structuredClone(fields), sessionId: st.meta.sessionId });
    if (attention === 'choice') {
      const request = st.meta.ask ?? st.meta.planRequest ?? st.meta.elicitation;
      if (request) this.commitAttention(st, attention, request.requestId,
        notificationSummary(st.meta.ask?.question || st.meta.planRequest?.summary || st.meta.elicitation?.message || '', '请确认下一步'));
    } else if (attention !== previous.attention) {
      this.commitAttention(st, attention);
    }
  }

  private inboxFields(id: string) {
    const entry = this.prefs.inbox.sessions[id];
    return { attention: entry?.attention ?? null, attnId: entry?.attnId ?? 0, seenId: entry?.seenId ?? 0 };
  }

  private publishInbox(st: State) {
    const fields = { ...this.inboxFields(st.meta.sessionId),
      ...(st.meta.error?.startsWith('Inbox save failed;') ? { error: null } : {}) };
    Object.assign(st.meta, fields);
    const projection = { ...fields, ...this.inboxCounts() };
    this.emit({ type: 'session/patch', sessionId: st.meta.sessionId, ...projection });
    return projection;
  }

  private inboxError(st: State, error: unknown): void {
    st.meta.error = `Inbox save failed; unread state was not committed: ${messageOf(error)}`;
    this.emit({ type: 'session/patch', sessionId: st.meta.sessionId, error: st.meta.error });
    this.log('inbox save failed', { sessionId: st.meta.sessionId, error: messageOf(error) });
  }

  private commitAttention(st: State, attention: Attention | null, eventId?: string, body?: string): boolean {
    try {
      if (this.prefs.setAttention(st.meta.sessionId, attention, eventId)) {
        const { attnId, inboxRevision, unreadCount } = this.publishInbox(st);
        if (attention) this.emit({ type: 'session/notify', sessionId: st.meta.sessionId,
          title: st.meta.title, attention, body: body ?? '请查看新消息', attnId, inboxRevision, unreadCount });
      }
      return true;
    } catch (error) {
      this.inboxError(st, error);
      return false;
    }
  }
}
