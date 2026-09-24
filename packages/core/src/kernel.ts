import { EventEmitter } from 'node:events';
import type { CopilotSession } from '@github/copilot-sdk';
import type { AgentStatus, ServerEvent, SessionMeta, SessionResource } from '@cockpit/protocol';
import { SessionActivity } from '@cockpit/protocol';
import type { OfficialRuntime } from './runtime.ts';
import type { RoleProvider } from './roles.ts';
import { SessionUnloadedError, busy, engineStopped, sessionNotFound, transition } from './errors.ts';
import { messageOf, settled } from './async.ts';
import { SessionHandle } from './session-handle.ts';

export type EngineRuntime = Pick<OfficialRuntime,
  'start' | 'models' | 'listSessions' | 'createSession' | 'resumeSession' |
  'closeSession' | 'deleteSession' | 'getAuthStatus' | 'stop' | 'rpc' |
  'isSessionLive' | 'onSessionClosed' | 'onFatal' | 'failure' | 'getSessionMetadata'>;

type LiveMeta = SessionMeta & { activeOperations?: number; nativeProcessing?: boolean };
export type ResourceValues = {
  todos: Awaited<ReturnType<CopilotSession['rpc']['plan']['readSqlTodos']>>;
  schedule: Awaited<ReturnType<CopilotSession['rpc']['schedule']['list']>>;
  mcp: Awaited<ReturnType<CopilotSession['rpc']['mcp']['list']>>;
};
type Resource = keyof ResourceValues;
export type NativeControl = Awaited<ReturnType<SessionKernel['readControl']>>;

export const activeTask = (status: string) => !['idle', 'completed', 'failed', 'cancelled'].includes(status);

export interface KernelHooks {
  ensureLoaded(st: SessionHandle, create?: boolean, cwd?: string): Promise<void>;
}

/**
 * Shared Engine state and gates: fatal/lifecycle admission, the session handle
 * registry, native-call guards, operation/transition leases, idle checks and
 * change publication. Services receive this kernel instead of the Engine.
 */
export class SessionKernel {
  readonly runtime: EngineRuntime;
  readonly sessions = new Map<string, SessionHandle>();
  readonly creating = new Set<string>();
  readonly removing = new Set<string>();
  readonly bus = new EventEmitter().setMaxListeners(0);
  roles?: RoleProvider;
  agentStatus: AgentStatus = 'starting';
  birthGate: Promise<void> = Promise.resolve();
  births = 0;
  lifecycle = false;
  started = false;
  stopped = false;
  startPromise?: Promise<void>;
  fatalError?: Error;
  log: (message: string, data?: Record<string, unknown>) => void = () => {};
  private readonly hooks: KernelHooks;

  constructor(runtime: EngineRuntime, hooks: KernelHooks) {
    this.runtime = runtime;
    this.hooks = hooks;
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

  fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.started = false;
    this.agentStatus = 'failed';
    for (const st of this.sessions.values()) this.detach(st, error);
    this.emit({ type: 'agent/status', status: 'failed' });
    this.bus.emit('fatal', error);
  }

  assertAvailable(): void {
    if (this.failure) {
      this.fail(this.failure);
      throw this.failure;
    }
  }

  async untilFatal<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    let off = () => {};
    const failure = new Promise<never>((_, reject) => { off = this.onFatal(reject); });
    try { return await Promise.race([work(), failure]); }
    finally { off(); }
  }

  async withSession<T>(st: SessionHandle, sdk: CopilotSession, work: () => Promise<T>): Promise<T> {
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

  emit(event: ServerEvent): void { this.bus.emit('event', event); }

  async state(id: string): Promise<SessionHandle> {
    this.assertAvailable();
    if (this.stopped) throw engineStopped('Engine is stopped; start it before performing session operations');
    if (this.lifecycle) throw transition('Engine lifecycle transition is in progress');
    if (this.removing.has(id)) throw transition('Session removal is in progress');
    let st = this.sessions.get(id);
    if (!st) {
      const metadata = await this.untilFatal(() => this.runtime.getSessionMetadata(id));
      if (!metadata) throw sessionNotFound();
      this.assertAvailable();
      if (this.stopped || this.lifecycle || this.removing.has(id)) {
        throw transition('Session lifecycle transition is in progress');
      }
      st = this.sessions.get(id);
      if (!st) {
        st = new SessionHandle(id);
        st.observedCwd = metadata.context?.workingDirectory || null;
        this.sessions.set(id, st);
      }
    }
    if (st.closing) throw transition('Session transition is in progress');
    return st;
  }

  release(st: SessionHandle): void {
    if (!st.sdk && !st.load && !st.closing && !st.operations && !st.cancelling
      && !st.decisions.size && this.sessions.get(st.id) === st) this.sessions.delete(st.id);
    this.bus.emit('activity-settled');
  }

  assertAdmission(st: SessionHandle): void {
    this.assertAvailable();
    const current = this.sessions.get(st.id);
    if (this.stopped || this.lifecycle || st.closing || (current && current !== st)) {
      throw transition('Session lifecycle transition is in progress or its handle changed');
    }
  }

  assertReadable(st?: SessionHandle): void {
    this.assertAvailable();
    if (this.stopped || this.lifecycle || st?.closing) throw transition('Native session metadata is unavailable during a lifecycle transition');
  }

  async liveSession(st: SessionHandle): Promise<CopilotSession | null> {
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

  probe(st: SessionHandle): void {
    void this.liveSession(st).catch(error => {
      if (!this.failure) this.log('session liveness check failed', { sessionId: st.id, error: messageOf(error) });
    });
  }

  scheduleSync(st: SessionHandle, resources: SessionResource[] = ['control', 'queue']): void {
    this.invalidate(st, resources);
  }

  async readResource<K extends Resource>(
    st: SessionHandle, sdk: CopilotSession, resource: K,
  ): Promise<ResourceValues[K]> {
    this.assertAvailable();
    if (st.sdk !== sdk) throw new Error('Native session closed during resource read');
    const readers: { [R in Resource]: () => Promise<ResourceValues[R]> } = {
      todos: () => sdk.rpc.plan.readSqlTodos(), schedule: () => sdk.rpc.schedule.list(), mcp: () => sdk.rpc.mcp.list(),
    };
    return this.withSession(st, sdk, readers[resource]);
  }

  async readControl(st: SessionHandle, sdk: CopilotSession) {
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

  async syncNative(st: SessionHandle): Promise<void> {
    const sdk = await this.liveSession(st);
    if (!sdk) return;
    const revision = st.revision;
    const control = await this.readControl(st, sdk);
    if (st.sdk !== sdk || revision !== st.revision) return;
    const busy = control.busy || st.sends > 0 || st.accepted.size > 0;
    if (!busy && !st.interruptTurn) st.interactionId = undefined;
  }

  async operation<T>(
    id: string, work: (sdk: CopilotSession, st: SessionHandle) => Promise<T>,
    kind: 'work' | 'read' | SessionResource[] = 'work', owner?: SessionHandle,
    changes: SessionResource[] = Array.isArray(kind) ? kind : [],
  ): Promise<T> {
    const st = owner ?? await this.state(id);
    this.assertAdmission(st);
    if (st.cancelling) throw busy('Session cancellation is in progress');
    st.operations++;
    this.patch(st, { activeOperations: st.activeOperations() });
    // Merge a mutation's native resource event with its readback notification.
    // Control/queue hints still flow immediately while the operation is busy.
    const held = changes.filter(resource => resource !== 'control' && resource !== 'controls' && resource !== 'queue');
    for (const resource of held) st.resourceWrites.set(resource, (st.resourceWrites.get(resource) ?? 0) + 1);
    try {
      if (kind === 'read') {
        if (!await this.liveSession(st)) throw new SessionUnloadedError();
      } else await this.hooks.ensureLoaded(st);
      this.assertAvailable();
      const sdk = st.sdk;
      if (!sdk) throw new Error('Native session is unavailable; explicitly resume to continue');
      return await this.withSession(st, sdk, () => work(sdk, st));
    } catch (error) {
      if (!(error instanceof SessionUnloadedError)) this.patch(st, { error: messageOf(error) });
      throw error;
    } finally {
      st.operations--;
      this.patch(st, { activeOperations: st.activeOperations() });
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

  async busy(st: SessionHandle, ownTransition = false): Promise<boolean> {
    if (st.localBusy(ownTransition)) return true;
    const revision = st.revision;
    const sdk = await this.liveSession(st);
    const active = !!sdk && (await this.readControl(st, sdk)).busy;
    return active || st.localBusy(ownTransition) || st.revision !== revision;
  }

  async checkIdle(st: SessionHandle): Promise<void> {
    await this.liveSession(st);
    if (st.load || st.operations || st.cancelling || st.decisions.size || st.sends || st.accepted.size) {
      throw busy('Session has protected work');
    }
    if (await this.busy(st, true)) {
      throw busy('Session has protected work (turn, task, queue, decision, or operation)');
    }
  }

  async close(st: SessionHandle): Promise<void> {
    if (!st.sdk) return;
    const sdk = st.sdk;
    await this.untilFatal(() => this.runtime.closeSession(sdk));
    if (st.sdk === sdk) this.detach(st);
  }

  detach(st: SessionHandle, error?: Error): void {
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

  async transition<T>(st: SessionHandle, work: () => Promise<T>): Promise<T> {
    this.assertAdmission(st);
    if (st.closing || st.load || st.operations || st.cancelling) throw busy('Session operation is in progress');
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

  birth<T>(work: () => Promise<T>): Promise<T> {
    this.births++;
    const result = this.birthGate.then(work);
    this.birthGate = result.then(() => {}, () => {});
    return result.finally(() => { this.births--; this.bus.emit('activity-settled'); });
  }

  projectDecisions(st: SessionHandle): void {
    this.patch(st, st.decisionFields());
  }

  invalidate(st: SessionHandle, resources?: SessionResource[]): void {
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

  patch(st: SessionHandle, fields: Partial<LiveMeta>): void {
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
