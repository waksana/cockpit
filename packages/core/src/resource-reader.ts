import type { CopilotSession, SessionMetadata } from '@github/copilot-sdk';
import type {
  MetaResource, PanelItem, PanelSection, QueuedItem, SessionBrief, SessionControls, SessionMeta, SessionPanels,
  SessionPlan, SessionProjection, TodoItem,
} from '@cockpit/protocol';
import { MetaResource as MetaResources, SessionUsage, cleanSessionTitle } from '@cockpit/protocol';
import { sessionModelOptions } from './runtime.ts';
import { CockpitError, SessionUnloadedError, transition } from './errors.ts';
import { boundedMap, readConcurrency, settled } from './async.ts';
import { activeTask, type NativeControl, type SessionKernel } from './kernel.ts';
import type { SessionHandle } from './session-handle.ts';
import type { RoleService } from './role-service.ts';
import type { McpService } from './mcp-service.ts';

export const summaryResources: MetaResource[] = ['identity', 'control', 'model', 'mode', 'schedule'];

export function completeMeta(meta: SessionProjection): SessionMeta {
  const { title, cwd, lastActivity, status, ask } = meta;
  if (title === undefined || cwd === undefined || lastActivity === undefined || status === undefined || ask === undefined) {
    throw new Error('Identity and control resources are required for a complete session summary');
  }
  return { ...meta, title, cwd, lastActivity, status, ask };
}

/**
 * Read-only session projections. Reads hold a read lease on loaded handles,
 * never load or register sessions, and publish no activeOperations frames.
 */
export class ResourceReader {
  private readonly k: SessionKernel;
  private readonly roleService: RoleService;
  private readonly mcp: McpService;

  constructor(k: SessionKernel, roleService: RoleService, mcp: McpService) {
    this.k = k;
    this.roleService = roleService;
    this.mcp = mcp;
  }

  private async listedMeta(row: SessionMetadata): Promise<SessionMeta> {
    return {
      ...this.roleService.roleState(undefined, await this.roleService.savedRoles(row.sessionId)),
      sessionId: row.sessionId, title: cleanSessionTitle(row.summary) || row.sessionId.slice(0, 8),
      cwd: row.context?.workingDirectory ?? '',
      createdAt: row.startTime.getTime(), lastActivity: row.modifiedTime.getTime(), lastActivitySource: 'native-persisted',
      loaded: false, status: 'unloaded', ask: null,
      planRequest: null, elicitation: null, decisions: [],
    };
  }

  async readSessions(resources: MetaResource[] = summaryResources): Promise<SessionMeta[]> {
    this.k.assertReadable();
    const rows = await this.k.untilFatal(() => this.k.runtime.listSessions());
    const byId = new Map(rows.map(row => [row.sessionId, row]));
    const ids = new Set(rows.filter(row => !this.k.creating.has(row.sessionId) || this.k.sessions.get(row.sessionId)?.sdk).map(row => row.sessionId));
    for (const id of this.k.sessions.keys()) ids.add(id);
    // Bound concurrent native reads independently of the size of the session index.
    const metas = await boundedMap([...ids], readConcurrency, async id => {
      const st = this.k.sessions.get(id);
      const row = byId.get(id);
      const meta = st ? await this.getResources(id, resources, row) : row ? {
        ...await this.listedMeta(row), ...(resources.includes('control') ? { activity: null } : {}),
      } : await this.getResources(id, resources);
      return meta ? completeMeta(meta) : null;
    });
    return metas.filter(meta => meta !== null);
  }

  async getMeta(id: string): Promise<SessionMeta | null> {
    const meta = await this.getResources(id, MetaResources.options, undefined, { nameProvenance: true });
    return meta ? completeMeta(meta) : null;
  }

  async getResources(
    id: string, resources: readonly MetaResource[], listedRow?: SessionMetadata, { nameProvenance = false } = {},
  ): Promise<SessionProjection | null> {
    this.k.assertAvailable();
    const st = this.k.sessions.get(id);
    if (this.k.creating.has(id) && !st?.sdk) throw transition('Native session creation is still awaiting acknowledgement');
    this.k.assertReadable(st);
    if (st) {
      st.operations++;
      st.readLeases++;
    }
    try {
      const sdk = st && await this.k.liveSession(st);
      this.k.assertReadable(st);
      if (!st || !sdk) {
        const row = listedRow ?? await this.k.untilFatal(() => this.k.runtime.getSessionMetadata(id));
        return row ? {
          ...await this.listedMeta(row),
          ...(resources.includes('control') ? { activity: null } : {}),
          ...(resources.includes('controls') ? { controls: null } : {}),
          ...(st ? { loading: !!st.load, closing: st.closing, cancelling: !!st.cancelling,
            activeOperations: st.activeOperations(), activeMcpOperations: st.mcpOperations,
            ...st.decisionFields() } : {}),
        } : null;
      }
      const activityRevision = st.activityRevision;
      const wants = new Set(resources);
      const readsControl = wants.has('control') || wants.has('controls');
      const [metadata, name, workspace, model, models, mode, todos, schedules, control, queue, row] = await this.k.withSession(st, sdk, () => settled([
        wants.has('identity') ? sdk.rpc.metadata.snapshot() : Promise.resolve(undefined),
        wants.has('identity') ? sdk.rpc.name.get() : Promise.resolve(undefined),
        // Full session/get only; optional, so its failure must not hide the rest of identity.
        wants.has('identity') && nameProvenance ? (async () => (await sdk.rpc.workspaces.getWorkspace()).workspace)().catch(() => undefined) : Promise.resolve(undefined),
        wants.has('model') ? sdk.rpc.model.getCurrent() : Promise.resolve(undefined),
        wants.has('models') ? sdk.rpc.model.list() : Promise.resolve(undefined),
        wants.has('mode') && !wants.has('identity') ? sdk.rpc.mode.get() : Promise.resolve(undefined),
        wants.has('todo') ? sdk.rpc.plan.readSqlTodos() : Promise.resolve(undefined),
        wants.has('schedule') ? sdk.rpc.schedule.list() : Promise.resolve(undefined),
        readsControl ? this.k.readControl(st, sdk) : Promise.resolve(undefined),
        wants.has('queue') && !readsControl ? sdk.rpc.queue.pendingItems() : Promise.resolve(undefined),
        wants.has('identity') ? listedRow ? Promise.resolve(listedRow) : this.k.runtime.getSessionMetadata(id) : Promise.resolve(undefined),
      ] as const));
      const nativeModels = models ? sessionModelOptions(models.list) : undefined;
      const needsCatalog = nativeModels?.some(option => option.supportedReasoningEfforts === undefined
        || option.defaultReasoningEffort === undefined || option.supportsLongContext === undefined);
      const availableModels = models && needsCatalog
        ? sessionModelOptions(models.list, await this.k.withSession(st, sdk, () => this.k.runtime.models())) : nativeModels;
      return {
        sessionId: id, loaded: true,
        ...(wants.has('identity') ? this.roleService.roleState(st, await this.roleService.savedRoles(id)) : {}),
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
        activeOperations: st.activeOperations(),
        loading: !!st.load, closing: st.closing, cancelling: !!st.cancelling,
        ...st.decisionFields(),
      };
    } catch (error) {
      if (st && resources.includes('control')) this.k.patch(st, { activity: null });
      if (st && resources.includes('controls')) this.k.patch(st, { controls: null });
      throw error;
    } finally {
      if (st) {
        st.operations--;
        st.readLeases--;
        this.k.release(st);
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

  private todoSummary(plan: Awaited<ReturnType<CopilotSession['rpc']['plan']['readSqlTodos']>>): SessionMeta['todo'] {
    const todos = plan.rows.filter(row => row.id && row.title);
    return todos.length ? { done: todos.filter(todo => todo.status === 'done').length,
      total: todos.length, intent: todos.find(todo => todo.status === 'in_progress')?.title ?? null } : null;
  }

  queueProjection(queue: Awaited<ReturnType<CopilotSession['rpc']['queue']['pendingItems']>>): QueuedItem[] {
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

  private controlProjection(st: SessionHandle, control: NativeControl): SessionControls {
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

  async getUsage(id: string): Promise<SessionUsage> {
    this.k.assertAvailable();
    const st = this.k.sessions.get(id);
    if (!st?.sdk) throw new SessionUnloadedError();
    if (st.closing || this.k.lifecycle) throw transition('Session lifecycle transition is in progress');
    // Protect these reads from close without loading or creating new work.
    st.operations++;
    this.k.patch(st, { activeOperations: st.activeOperations() });
    try {
      const sdk = await this.k.liveSession(st);
      if (!sdk) throw new SessionUnloadedError();
      if (typeof sdk.rpc.metadata.getContextAttribution !== 'function' || typeof sdk.rpc.usage?.getMetrics !== 'function') {
        throw new CockpitError('UNSUPPORTED', 'Native usage/context read APIs are unavailable in this SDK');
      }
      const [context, usage] = await this.k.withSession(st, sdk, () => settled([
        sdk.rpc.metadata.getContextAttribution(), sdk.rpc.usage.getMetrics(),
      ] as const));
      return SessionUsage.parse({ sessionId: id, sampledAt: Date.now(), context: context.contextAttribution ?? null, usage });
    } finally {
      st.operations--;
      this.k.patch(st, { activeOperations: st.activeOperations() });
      this.k.release(st);
    }
  }

  async getPlan(id: string): Promise<SessionPlan> {
    return this.k.operation(id, async (sdk, st) => {
      const [plan, result] = await this.k.withSession(st, sdk, () => settled([sdk.rpc.plan.read(), this.k.readResource(st, sdk, 'todos')] as const));
      const todos: TodoItem[] = result.rows.filter(row => row.id && row.title).map(row => ({
        id: row.id!, title: row.title!, description: row.description ?? undefined,
        status: ['pending', 'in_progress', 'done', 'blocked'].includes(row.status ?? '') ? row.status as TodoItem['status'] : 'pending',
      }));
      return { planMarkdown: plan.content ?? null, todos };
    }, 'read');
  }

  async getPanels(id: string): Promise<SessionPanels> {
    return this.k.operation(id, async (sdk, st) => {
      const [skills, mcpServers, tasks, instructionSources, schedules] = await settled([
        this.readPanel(st, sdk, 'skills'), this.readPanel(st, sdk, 'mcpServers'),
        this.readPanel(st, sdk, 'tasks'), this.readPanel(st, sdk, 'instructionSources'), this.readPanel(st, sdk, 'schedules'),
      ] as const);
      return { skills, mcpServers, tasks, instructionSources, schedules };
    }, 'read');
  }

  async getPanel(id: string, section: PanelSection): Promise<PanelItem[]> {
    return this.k.operation(id, (sdk, st) => this.readPanel(st, sdk, section), 'read');
  }

  private readPanel(st: SessionHandle, sdk: CopilotSession, section: PanelSection): Promise<PanelItem[]> {
    return this.k.withSession(st, sdk, async () => {
      switch (section) {
        case 'skills': return (await sdk.rpc.skills.list()).skills.map(s => ({ label: s.name, sublabel: s.source, enabled: s.enabled }));
        case 'mcpServers': {
          const mcp = await sdk.rpc.mcp.list();
          const disabled = new Set(mcp.host?.disabledServers);
          return mcp.servers.map(s => {
            const { status, enabled } = this.mcp.mcpServerState(mcp, s.name, s, disabled);
            return { label: s.name, sublabel: status, enabled };
          });
        }
        case 'tasks': return (await sdk.rpc.tasks.list()).tasks.map(t => ({ label: t.description || t.id, sublabel: t.status }));
        case 'instructionSources': return [
          ...(await sdk.rpc.instructions.getSources()).sources.map(s => ({ label: s.label, sublabel: s.sourcePath })),
          ...(st.instructionSources ?? []).map(source => ({ ...source })),
        ];
        case 'schedules': return (await sdk.rpc.schedule.list()).entries.map(s => ({ label: s.displayPrompt || s.prompt,
          sublabel: s.selfPaced ? `Self-paced (model-controlled) · next ${s.nextRunAt}` : s.nextRunAt }));
      }
    });
  }
}
