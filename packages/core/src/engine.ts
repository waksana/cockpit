import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { SessionConfig, SessionMetadata } from '@github/copilot-sdk';
import type {
  DirListing, ExitPlanModeAction, IntentResult, McpServerGlobal, McpServerSession, McpToggleResult, MetaResource,
  NativeChatPage, PanelItem, PanelSection, ResourcePreparationResult, RoleAdditionResult, RoleReadiness, RoleSelection,
  ScheduleEntry, ServerEvent, SessionBrief, SessionControlAction, SessionControlResult, SessionMeta, SessionPanels,
  SessionPlan, SessionProjection, SessionResourcesPrepare, SessionUsage, SkillSession, Snapshot,
} from '@cockpit/protocol';
import { NativeChatRead, NativeRewindResult } from '@cockpit/protocol';
import { OfficialRuntime } from './runtime.ts';
import type { RuntimeAttachment } from './sdk-types.ts';
import { readNativeChat } from './native-chat.ts';
import { validateForkHistory } from './fork.ts';
import type { RoleProvider } from './roles.ts';
import {
  CockpitError, SessionUnloadedError, busy, conflict, engineStopped, invalid, sessionNotFound, transition, unavailable,
} from './errors.ts';
import { messageOf, settled } from './async.ts';
import { SessionHandle } from './session-handle.ts';
import { SessionKernel, type EngineRuntime } from './kernel.ts';
import { DecisionBroker } from './decisions.ts';
import { RoleService } from './role-service.ts';
import { SkillsService } from './skills-service.ts';
import { McpService } from './mcp-service.ts';
import { ScheduleService } from './schedule-service.ts';
import { ResourceReader, completeMeta, summaryResources } from './resource-reader.ts';
import { NativeEvents, type NativeObservation } from './native-events.ts';
import { SessionConfigurator } from './session-config.ts';
import { ResourcePreparation } from './resource-preparation.ts';
import { SessionControlService } from './session-controls.ts';
import { SessionSettings } from './session-settings.ts';
import { listDir } from './list-dir.ts';

export { boundedMap } from './async.ts';
export type { EngineRuntime } from './kernel.ts';
export type { NativeObservation } from './native-events.ts';

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

/**
 * Public native-session facade. Engine owns host and session lifecycle
 * (start/stop, create/resume/fork, unload/reload/rewind/delete, chat reads)
 * and delegates the remaining intents to services that share one
 * SessionKernel for admission, leases and change publication.
 */
export class Engine {
  private readonly k: SessionKernel;
  private readonly sessions: Map<string, SessionHandle>;
  private readonly decisions: DecisionBroker;
  private readonly roleService: RoleService;
  private readonly skills: SkillsService;
  private readonly mcp: McpService;
  private readonly schedules: ScheduleService;
  private readonly reader: ResourceReader;
  private readonly events: NativeEvents;
  private readonly configurator: SessionConfigurator;
  private readonly preparation: ResourcePreparation;
  private readonly controls: SessionControlService;
  private readonly settings: SessionSettings;

  constructor(options: { runtime?: EngineRuntime } = {}) {
    this.k = new SessionKernel(options.runtime ?? new OfficialRuntime(), {
      ensureLoaded: (st, create, cwd) => this.ensureLoaded(st, create, cwd),
    });
    this.sessions = this.k.sessions;
    this.decisions = new DecisionBroker(this.k);
    this.roleService = new RoleService(this.k);
    this.skills = new SkillsService(this.k);
    this.mcp = new McpService(this.k);
    this.schedules = new ScheduleService(this.k);
    this.reader = new ResourceReader(this.k, this.roleService, this.mcp);
    this.events = new NativeEvents(this.k, this.decisions);
    this.configurator = new SessionConfigurator(this.k, this.roleService, this.skills, this.decisions);
    this.preparation = new ResourcePreparation(this.k, this.roleService, this.mcp);
    this.controls = new SessionControlService(this.k, this.decisions, this.reader);
    this.settings = new SessionSettings(this.k);
  }

  get log() { return this.k.log; }

  set log(log: SessionKernel['log']) { this.k.log = log; }

  get failure(): Error | undefined { return this.k.failure; }

  setRoleProvider(roles: RoleProvider): void {
    if (this.k.started || this.sessions.size) throw new Error('Roles must be configured before native startup');
    this.k.roles = roles;
  }

  onFatal(handler: (error: Error) => void): () => void { return this.k.onFatal(handler); }

  onEvent(handler: (event: ServerEvent) => void): () => void {
    this.k.bus.on('event', handler);
    return () => this.k.bus.off('event', handler);
  }

  /** Live notifications only; optional types are matched before copying event payloads. */
  onNativeEvent(handler: (event: NativeObservation) => void | Promise<void>, options?: { types: readonly string[] }): () => void {
    return this.events.onNativeEvent(handler, options);
  }

  onActivitySettled(handler: () => void): () => void {
    this.k.bus.on('activity-settled', handler);
    return () => { this.k.bus.off('activity-settled', handler); };
  }

  start(): Promise<void> {
    if (this.k.failure) return Promise.reject(this.k.failure);
    if (this.k.lifecycle) return Promise.reject(transition('Engine lifecycle transition is in progress'));
    if (this.k.started) return Promise.resolve();
    if (this.k.startPromise) return this.k.startPromise;
    this.k.startPromise = this.k.untilFatal(async () => {
      await this.k.untilFatal(() => this.k.runtime.start());
      this.k.assertAvailable();
      this.k.started = true;
      this.k.stopped = false;
      this.k.agentStatus = 'up';
      this.k.emit({ type: 'agent/status', status: 'up' });
    }).catch(error => {
      this.k.started = false;
      this.k.agentStatus = 'failed';
      this.k.emit({ type: 'agent/status', status: 'failed' });
      throw error;
    }).finally(() => { this.k.startPromise = undefined; this.k.bus.emit('activity-settled'); });
    return this.k.startPromise;
  }

  async login(): Promise<string> {
    this.k.assertReadable();
    return (await this.k.untilFatal(() => this.k.runtime.getAuthStatus())).login ?? '';
  }

  async snapshot(): Promise<Snapshot> {
    this.k.assertReadable();
    const [models, sessions] = await settled([this.k.runtime.models(), this.reader.readSessions()] as const);
    return {
      type: 'snapshot', permissionPolicy: 'allow-all', agentStatus: this.k.agentStatus,
      models, sessions,
    };
  }

  async refreshList(): Promise<void> {
    this.k.emit(await this.snapshot());
  }

  async newSession(cwd: string, roles: RoleSelection[] = []): Promise<string> {
    this.k.assertAvailable();
    if (this.k.stopped) throw engineStopped('Engine is stopped; start it before creating sessions');
    if (this.k.lifecycle) throw transition('Engine lifecycle transition is in progress');
    const directory = resolve(cwd || homedir());
    if (!statSync(directory).isDirectory()) throw invalid('Working directory must be a directory');
    const id = randomUUID();
    if (this.k.creating.has(id) || this.sessions.has(id)) throw conflict('Session identity already has an active handle or creation');
    const st = new SessionHandle(id);
    if (roles.length) {
      if (!this.k.roles) throw unavailable('Module roles are unavailable');
      const assembly = await this.k.roles.assemble(id, roles);
      this.k.roles.save(id, assembly.roles);
    }
    this.k.creating.add(id);
    try {
      await this.ensureLoaded(st, true, directory);
      return id;
    } catch (error) {
      if (st.sdk?.sessionId === id) {
        throw new CockpitError('SESSION_CREATION_INCOMPLETE', `Native session ${id} was created, but readiness readback failed: ${messageOf(error)}. Inspect this session; do not create a replacement automatically.`,
          { cause: error, sessionId: id });
      }
      if (st.creationSubmitted) throw new CockpitError('SESSION_CREATION_UNCERTAIN',
        `Native session creation ${id} is uncertain: ${messageOf(error)}. Inspect this identity; do not retry blindly.`, { cause: error, sessionId: id });
      throw error;
    } finally {
      this.k.creating.delete(id);
      this.k.bus.emit('activity-settled');
    }
  }

  async forkSession(id: string, toEventId?: string, name?: string): Promise<{ sessionId: string }> {
    const st = await this.k.state(id);
    return this.k.transition(st, async () => {
      const sdk = st.sdk;
      if (!sdk) throw new SessionUnloadedError();
      await this.k.withSession(st, sdk, () => validateForkHistory(sdk.rpc.eventLog.read, toEventId));
      // Recheck native activity after the scan; no parent abort, resume or save.
      await this.k.checkIdle(st);
      if (st.sdk !== sdk) throw new SessionUnloadedError();
      const [queue, schedules] = await this.k.withSession(st, sdk, () => settled([
        sdk.rpc.queue.pendingItems(), sdk.rpc.schedule.list(),
      ] as const));
      if (queue.items.length || queue.steeringMessages.length || queue.inFlightSteeringCount) {
        throw busy('Source has protected queued or steering work');
      }
      if (schedules.entries.length) throw busy('Source has active schedules; fork requires an idle source without timers');
      return await this.k.birth(async () => {
        let result: Awaited<ReturnType<typeof this.k.runtime.rpc.sessions.fork>>;
        try {
          result = await this.k.untilFatal(() => this.k.runtime.rpc.sessions.fork({ sessionId: id, toEventId, name }));
        } catch (error) {
          throw new Error(`Native fork failed; creation may be uncertain. Do not retry blindly; inspect the session list and source fork records. ${messageOf(error)}`, { cause: error });
        }
        const child = await this.reader.getMeta(result.sessionId);
        if (!child) throw new Error(`Native fork returned ${result.sessionId}, but its metadata is unavailable; do not retry`);
        this.k.emit({ type: 'session/added', session: child });
        return { sessionId: result.sessionId };
      });
    });
  }

  private async ensureLoaded(st: SessionHandle, create = false, cwd?: string): Promise<void> {
    this.k.assertAdmission(st);
    if (st.load) return st.load;
    if (!create) this.sessions.set(st.id, st);
    if (st.sdk && await this.k.liveSession(st)) return;
    this.k.assertAdmission(st);
    if (st.load) return st.load;
    this.k.patch(st, { loading: true });
    st.load = this.k.untilFatal(() => this.k.birth(async () => {
      this.k.assertAvailable();
      const owner: NonNullable<SessionHandle['eventOwner']> = {};
      st.eventOwner = owner;
      if (create) st.observedCwd = cwd ?? null;
      const assembled = await this.configurator.config(st, cwd);
      const config: SessionConfig = { ...assembled.config, onEvent: event => {
        if (st.eventOwner !== owner || this.k.failure) return;
        assembled.subagents?.observe(event);
        this.events.observeNative(st, event);
        try { this.events.onLive(st, event); }
        catch (error) {
          this.k.patch(st, { error: `Native control event could not be applied: ${messageOf(error)}` });
          this.log('native control event failed', { sessionId: st.id, error: messageOf(error) });
        }
      } };
      if (create) st.creationSubmitted = true;
      const sdk = await this.k.untilFatal(() => create
        ? this.k.runtime.createSession(config)
        : this.k.runtime.resumeSession(st.id, config));
      this.k.assertAvailable();
      if (sdk.sessionId !== st.id) {
        const action = create ? 'creation' : 'resume';
        throw new Error(`Native ${action} returned a different session ID; ${action} is unconfirmed`);
      }
      if (st.eventOwner !== owner) throw new Error('Native session closed while loading; explicitly resume to continue');
      st.sdk = sdk;
      st.controlToken = randomUUID();
      st.roleAssembly = assembled.assembly;
      st.instructionSources = assembled.instructions?.sources;
      this.sessions.set(sdk.sessionId, st);
      if (owner.closed?.has(sdk) || (create && !await this.k.liveSession(st))) {
        this.k.detach(st);
        throw new Error('Native session closed while loading; explicitly resume to continue');
      }
      delete owner.closed;
      if (st.roleAssembly) await this.k.withSession(st, sdk, () => sdk.rpc.tools.initializeAndValidate());
      const meta = await this.reader.getResources(st.id, summaryResources);
      if (!meta) throw new Error('Native session metadata is unavailable after loading');
      if (!owner.contextChanged) st.observedCwd = meta.cwd || null;
      this.k.emit({ type: 'session/added', session: completeMeta({ ...meta, error: null }) });
    })).catch(error => {
      if (!st.sdk) {
        st.eventOwner = undefined;
      }
      this.k.patch(st, { loaded: !!st.sdk, status: 'error', error: messageOf(error) });
      throw error;
    }).finally(() => {
      st.load = undefined;
      this.k.patch(st, { loading: false });
      this.k.release(st);
    });
    return st.load;
  }

  async busyCount(): Promise<number> {
    if (this.k.lifecycle || this.k.births || this.k.creating.size || this.k.startPromise || this.k.removing.size) return 1;
    let count = 0;
    for (const st of this.sessions.values()) if (await this.k.busy(st)) count++;
    return count;
  }

  async unload(id: string): Promise<void> {
    const st = await this.k.state(id);
    await this.k.transition(st, () => this.k.close(st));
  }

  async load(id: string): Promise<void> {
    const st = await this.k.state(id);
    if (!st.sdk && !st.load && !await this.k.runtime.getSessionMetadata(id)) throw sessionNotFound(`Unknown session: ${id}`);
    await this.k.operation(id, async () => {}, 'work', st);
  }

  async reload(id: string): Promise<void> {
    const st = await this.k.state(id);
    await this.k.transition(st, () => this.k.close(st));
    await this.ensureLoaded(st);
  }

  async stop(): Promise<void> {
    if (this.k.failure) {
      this.k.fail(this.k.failure);
      await this.k.runtime.stop();
      this.k.stopped = true;
      return;
    }
    if (this.k.lifecycle || this.k.births || this.k.creating.size || this.k.startPromise || this.k.removing.size) {
      throw busy('Engine lifecycle operation is in progress');
    }
    const all = [...this.sessions.values()];
    if (all.some(st => st.closing || st.load || st.operations || st.cancelling)) {
      throw busy('Session operation is in progress');
    }
    this.k.lifecycle = true;
    for (const st of all) { st.closing = true; this.k.patch(st, { closing: true }); }
    try {
      for (const st of all) await this.k.checkIdle(st);
      for (const st of all) { await this.k.checkIdle(st); await this.k.close(st); }
      await this.k.runtime.stop();
      this.k.started = false;
      this.k.stopped = true;
      this.k.agentStatus = 'stopping';
      this.k.emit({ type: 'agent/status', status: 'stopping' });
    } finally {
      for (const st of all) { st.closing = false; this.k.patch(st, { closing: false }); this.k.release(st); }
      this.k.lifecycle = false;
      this.k.bus.emit('activity-settled');
    }
  }

  async rewind(id: string, toMsgId: string, rollbackFiles = false) {
    const st = await this.k.state(id);
    await this.ensureLoaded(st);
    return this.k.transition(st, async () => {
      const sdk = st.sdk;
      if (!sdk) throw new Error('Native session is unavailable; explicitly resume to rewind');
      const result = await this.k.withSession(st, sdk, () => sdk.rpc.history.rewind({
        eventId: toMsgId, mode: rollbackFiles ? 'conversation-and-files' : 'conversation',
      }));
      const mutated = (result.eventsRemoved ?? 0) > 0 || result.outcome === 'rollback-incomplete'
        || (result.outcome !== 'files-rolled-back' && result.restoredFiles.length > 0);
      if (mutated) {
        this.k.emit({ type: 'chat/invalidated', sessionId: id, reason: 'rewind' });
      }
      return NativeRewindResult.parse(result);
    });
  }

  async deleteSession(id: string): Promise<void> {
    this.k.assertAvailable();
    if (this.k.stopped || this.k.lifecycle || this.k.startPromise || this.k.removing.has(id)) throw transition('Session lifecycle transition is in progress');
    const st = await this.k.state(id);
    this.k.assertAdmission(st);
    if (this.k.removing.has(id)) throw transition('Session removal is in progress');
    this.k.removing.add(id);
    try {
      await this.k.transition(st, async () => {
        // Native deletion is authoritative; never remove files to simulate success.
        await this.k.close(st);
        await this.k.untilFatal(() => this.k.runtime.deleteSession(id));
        this.sessions.delete(id);
        this.k.emit({ type: 'session/removed', sessionId: id });
      });
    } finally { this.k.removing.delete(id); this.k.release(st); }
  }

  chat(query: NativeChatRead, signal?: AbortSignal): Promise<NativeChatPage> {
    return this.k.untilFatal(async () => {
      query = NativeChatRead.parse(query);
      signal?.throwIfAborted();
      if (this.k.lifecycle || this.k.removing.has(query.sessionId)) throw transition('Session lifecycle transition is in progress');
      const st = this.sessions.get(query.sessionId);
      this.k.assertReadable(st);
      if (this.k.creating.has(query.sessionId) && !st?.sdk) throw transition('Native session creation is still awaiting acknowledgement');
      const sdk = st?.sdk;
      if (!sdk && !query.cursor && !await this.k.runtime.getSessionMetadata(query.sessionId)) {
        throw sessionNotFound('Session was not found.');
      }
      const read = () => readNativeChat(query, {
        persisted: params => this.k.runtime.rpc.sessions.readPersistedEvents(params),
        live: sdk?.rpc.eventLog,
      }, signal);
      if (query.source !== 'live' || !st || !sdk) return read();
      try {
        return await this.k.withSession(st, sdk, read);
      } catch (error) {
        // Native idle cleanup can omit shutdown. Reconcile only a failed read,
        // never resume or make every streaming page pay for a liveness probe.
        if (!signal?.aborted && !this.k.failure && st.sdk === sdk && !await this.k.liveSession(st)) {
          throw new CockpitError('SESSION_UNLOADED', 'Native session is unloaded; continue through persisted history or explicitly resume.');
        }
        throw error;
      }
    });
  }

  // Reads
  getMeta(id: string): Promise<SessionMeta | null> { return this.reader.getMeta(id); }

  getResources(
    id: string, resources: readonly MetaResource[], listedRow?: SessionMetadata, options?: { nameProvenance?: boolean },
  ): Promise<SessionProjection | null> {
    return this.reader.getResources(id, resources, listedRow, options);
  }

  listLive(): Promise<SessionBrief[]> { return this.reader.listLive(); }

  status(): Promise<SessionMeta[]> { return this.reader.status(); }

  getUsage(id: string): Promise<SessionUsage> { return this.reader.getUsage(id); }

  getPlan(id: string): Promise<SessionPlan> { return this.reader.getPlan(id); }

  getPanels(id: string): Promise<SessionPanels> { return this.reader.getPanels(id); }

  getPanel(id: string, section: PanelSection): Promise<PanelItem[]> { return this.reader.getPanel(id, section); }

  listDir(path?: string): Promise<DirListing> { return listDir(path); }

  // Turn input and controls
  prompt(id: string, text: string, mode?: 'enqueue' | 'immediate', attachments?: RuntimeAttachment[]): Promise<{ ok: boolean; queued?: boolean }> {
    return this.controls.prompt(id, text, mode, attachments);
  }

  cancel(id: string): Promise<void> { return this.controls.cancel(id); }

  interrupt(id: string): Promise<IntentResult<'session/interrupt'>> { return this.controls.interrupt(id); }

  removeQueued(id: string, itemId: string): Promise<void> { return this.controls.removeQueued(id, itemId); }

  control(id: string, token: string, action: SessionControlAction): Promise<SessionControlResult> {
    return this.controls.control(id, token, action);
  }

  // Decisions
  respondAsk(id: string, requestId: string, answer: string, wasFreeform: boolean): Promise<void> {
    return this.decisions.respondAsk(id, requestId, answer, wasFreeform);
  }

  respondPlan(id: string, requestId: string, action: ExitPlanModeAction): Promise<void> {
    return this.decisions.respondPlan(id, requestId, action);
  }

  respondElicitation(id: string, requestId: string, action: 'accept' | 'decline' | 'cancel'): Promise<void> {
    return this.decisions.respondElicitation(id, requestId, action);
  }

  planSupersede(id: string, requestId: string, message: string): Promise<void> {
    return this.decisions.planSupersede(id, requestId, message);
  }

  // Session settings
  setModel(id: string, modelId: string, reasoningEffort?: string, contextTier?: 'default' | 'long_context') {
    return this.settings.setModel(id, modelId, reasoningEffort, contextTier);
  }

  setMode(id: string, mode: 'interactive' | 'plan' | 'autopilot') { return this.settings.setMode(id, mode); }

  rename(id: string, name: string): Promise<string> { return this.settings.rename(id, name); }

  compact(id: string, customInstructions?: string) { return this.settings.compact(id, customInstructions); }

  // Roles and resource preparation
  listRoles() { return this.roleService.listRoles(); }
  listRoleResources() { return this.roleService.listRoleResources(); }

  roleReadiness(id: string, requested?: RoleSelection[]): Promise<RoleReadiness> { return this.roleService.roleReadiness(id, requested); }

  addRoles(id: string, additions: RoleSelection[]): Promise<RoleAdditionResult> { return this.roleService.addRoles(id, additions); }

  initializeSessionTools(id: string): Promise<void> { return this.preparation.initializeSessionTools(id); }

  prepareSessionResources(input: SessionResourcesPrepare): Promise<ResourcePreparationResult> {
    return this.preparation.prepareSessionResources(input);
  }

  // Skills
  listGlobalSkills(cwd?: string) { return this.skills.listGlobalSkills(cwd); }

  readSkillBody(name: string, cwd?: string) { return this.skills.readSkillBody(name, cwd); }

  setGlobalSkill(name: string, enabled: boolean, cwd?: string): Promise<void> { return this.skills.setGlobalSkill(name, enabled, cwd); }

  listSessionSkills(id: string): Promise<SkillSession[]> { return this.skills.listSessionSkills(id); }

  toggleSessionSkill(id: string, name: string, enabled: boolean): Promise<void> {
    return this.skills.toggleSessionSkill(id, name, enabled);
  }

  refreshSkills(): Promise<void> { return this.skills.refreshSkills(); }

  // MCP
  listGlobalMcp(): Promise<McpServerGlobal[]> { return this.mcp.listGlobalMcp(); }

  setMcpDefault(name: string, on: boolean): Promise<void> { return this.mcp.setMcpDefault(name, on); }

  listSessionMcp(id: string): Promise<{ loaded: boolean; servers: McpServerSession[] }> { return this.mcp.listSessionMcp(id); }

  toggleSessionMcp(id: string, name: string, enabled: boolean): Promise<McpToggleResult> {
    return this.mcp.toggleSessionMcp(id, name, enabled);
  }

  refreshMcp(): Promise<void> { return this.mcp.refreshMcp(); }

  reloadSessionMcp(id: string): Promise<{ reconnected: number }> { return this.mcp.reloadSessionMcp(id); }

  // Schedules
  addSchedule(id: string, options: {
    prompt: string; interval?: string; at?: number; recurring?: boolean;
  }): Promise<{ entry?: ScheduleEntry; error?: string; possiblyCreated?: boolean }> {
    return this.schedules.addSchedule(id, options);
  }

  listSchedules(id: string): Promise<ScheduleEntry[]> { return this.schedules.listSchedules(id); }

  stopSchedule(id: string, scheduleId: number): Promise<boolean> { return this.schedules.stopSchedule(id, scheduleId); }
}
