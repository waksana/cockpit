// Browser-owned native chat windows plus the server's control projection.
// SSE supplies metadata/decisions; bounded HTTP reads feed only the visible chat.
// Loaded pages, cursors and drafts are local. init() owns this tab's transport lifecycle.

import { create } from 'zustand';
import { isSessionUnloadedError, isTransportError, NetClient, OWNED, SessionUnloadedError, type IntentOptions } from './client';
import type { ConnState } from './client';
import type {
  ChatSession, ModelOption, ServerEvent,
} from './types';
import { MetaResource, SessionResource, type SessionMeta } from '@cockpit/protocol';
import type { NativeChatRead, NativeChatPage, SessionProjection } from '@cockpit/protocol';
import { invalidateWindow, metaToSession } from './sessionWindow';
import { applyProjection, cleanProjection } from './sessionResources';
import { NativeWindow, NATIVE_PAGE, type ChatPosition } from './nativeWindow';
import { readMessageHistory } from './messageHistory';
import { describeReason, reportUxError } from '../lib/errorReporter';
import { OperationNotSent, OperationRejected, OperationUnconfirmed, operationErrorState, recordOperationFailure, reportOrphanedOperation } from '../lib/operationErrors';
import { copy } from '../lib/copy';
import { sessionReloadBlockReason } from '../lib/sessionReload';
import { sessionSettingsBlockReason, type SessionSettingsAction, type SessionSettingsOperation } from '../lib/sessionSettingsActions';
import type { NativeDraftRequest } from '../lib/draft';
import { observeDraftDecisions, retireDraftSession } from '../lib/draftSelection';
import type { DraftReference, DraftSendBlockReason, ModuleEventPayload } from '@cockpit/module-api';

// Background tabs release their native chat read.
type MutationOwner = 'caller' | 'chat' | 'global';
const isVisible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';

interface CockpitState {
  connState: ConnState;
  snapshotReady: boolean;
  connectionGeneration: number;
  sessions: ChatSession[];
  activeId: string | null;
  globalModels: ModelOption[];
  resourceRevisions: Record<string, Partial<Record<SessionResource, number>>>;
  activityRefreshingIds: string[];
  reloadingSessionIds: string[];
  // Session-keyed result of the last reload, shown by session operations.
  sessionReloadResults: Record<string, { state: 'done' | 'failed' | 'unknown'; reason?: string }>;
  sessionSettingsOperations: Record<string, SessionSettingsOperation>;
  runSessionSettingsAction: (sessionId: string, action: SessionSettingsAction, customInstructions?: string) => Promise<void>;
  // lifecycle
  init: () => () => void;
  // Throws unless this tab's transport is open; stateless requests live in ./api.
  connectedClient: () => NetClient;
  onModuleInvalidated: (listener: (moduleId: string) => void) => () => void;
  onModuleEvent: (listener: (moduleId: string, payload: ModuleEventPayload) => void) => () => void;
  // intents
  setActiveId: (id: string | null) => void;
  newSession: (cwd: string, roles?: import('@cockpit/protocol').RoleSelection[]) => Promise<string>;
  refreshRoles: (sessionId: string, signal?: AbortSignal) => Promise<SessionProjection>;
  loadMore: (sessionId: string) => void;
  retryHistory: (sessionId: string) => void;
  sendDraft: (request: NativeDraftRequest) => Promise<boolean>;
  canSendDraft: (draft: DraftReference) => DraftSendBlockReason | undefined;
  cancel: (sessionId: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<{ ok: true; interrupted: boolean }>;
  deleteSession: (sessionId: string) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  reloadSession: (sessionId: string) => Promise<void>;
  getResources: (sessionId: string, resources: MetaResource[], signal?: AbortSignal) => Promise<SessionProjection>;
  // Session MCP + Skills
  mcpSession: (sessionId: string) => Promise<import('@cockpit/protocol').McpServerSession[]>;
  mcpToggleSession: (sessionId: string, name: string, on: boolean) => Promise<void>;
  skillsSession: (sessionId: string) => Promise<import('@cockpit/protocol').SkillSession[]>;
  skillsToggleSession: (sessionId: string, name: string, enabled: boolean) => Promise<void>;
  respondAsk: (sessionId: string, requestId: string, answer: string, wasFreeform: boolean) => Promise<boolean>;
  respondPlan: (sessionId: string, requestId: string, action: import('@cockpit/protocol').ExitPlanModeAction) => Promise<boolean>;
  planSupersede: (sessionId: string, requestId: string, message: string) => Promise<boolean>;
  respondElicitation: (sessionId: string, requestId: string, action: 'accept' | 'decline' | 'cancel') => Promise<boolean>;
  removeQueued: (sessionId: string, itemId: string) => Promise<void>;
  refreshList: () => Promise<void>;
  watchControls: (sessionId: string) => () => void;
  refreshControls: (sessionId: string) => void;
  sessionControlAction?: (sessionId: string, action: import('../lib/sessionControls').SessionControlAction) => Promise<void>;
  readAgentTaskDetails?: import('../lib/sessionControls').ReadAgentTaskDetails;
}

export const createCockpitStore = () => create<CockpitState>((set, get) => {
  let client: NetClient | null = null;
  const moduleListeners = new Set<(moduleId: string) => void>();
  const moduleEventListeners = new Set<(moduleId: string, payload: ModuleEventPayload) => void>();
  const summaryResources: MetaResource[] = ['identity', 'control', 'model'];
  const controlConsumers = new Map<string, number>();
  const metaRequests = new Map<string, {
    dirty: Set<MetaResource>; stale: Set<MetaResource>; reading: Set<MetaResource>; controller: AbortController; patches: Partial<SessionMeta>;
  }>();
  const refreshMeta = (sessionId: string, resources: readonly SessionResource[] = SessionResource.options) => {
    const session = get().sessions.find(row => row.sessionId === sessionId);
    // New rows arrive through added/snapshot with a complete identity, not an
    // invalidation racing the native creation acknowledgement.
    if (!session) return;
    // A closing transition refuses new native reads. Its settling event will
    // invalidate again; keep the current frontend view in the meantime.
    if (session?.closing) return;
    if (controlConsumers.has(sessionId) && session.loaded
      && resources.some(resource => ['control', 'controls', 'queue', 'tasks'].includes(resource))) {
      resources = [...new Set([...resources, 'controls' as const])];
    }
    const pending = metaRequests.get(sessionId);
    // Obsolete in-flight fields must be discarded even after their consumer
    // unmounts. Demand decides rereads, not whether an old result is still valid.
    if (pending) for (const resource of resources) {
      const parsed = MetaResource.safeParse(resource);
      if (parsed.success) pending.stale.add(parsed.data);
    }
    const consumed = new Set<SessionResource>(summaryResources);
    if (sessionId === get().activeId) consumed.add('queue');
    if (controlConsumers.has(sessionId)) consumed.add('controls');
    const needed = resources.filter((resource): resource is MetaResource =>
      MetaResource.safeParse(resource).success && consumed.has(resource));
    if (!needed.length) return;
    if (needed.includes('controls')) patchLocal(sessionId, row => ({ ...row, controlsStale: true }));
    if (client?.isOpen && (needed.includes('control') || needed.includes('controls'))) set(st => ({
      activityRefreshingIds: st.activityRefreshingIds.includes(sessionId)
        ? st.activityRefreshingIds : [...st.activityRefreshingIds, sessionId],
    }));
    if (pending) { for (const resource of needed) pending.dirty.add(resource); return; }
    const request = { dirty: new Set(needed), stale: new Set<MetaResource>(), reading: new Set<MetaResource>(),
      controller: new AbortController(), patches: {} as Partial<SessionMeta> };
    const net = client;
    const generation = get().connectionGeneration;
    if (!net?.isOpen) return;
    metaRequests.set(sessionId, request);
    let readingControl = false;
    let readingControls = false;
    let readingOther = false;
    void Promise.resolve().then(async () => {
      do {
        const reading = [...request.dirty].filter(resource => (resource !== 'queue' || get().activeId === sessionId)
          && (resource !== 'controls' || controlConsumers.has(sessionId)));
        request.dirty.clear();
        if (!reading.length) return;
        request.reading = new Set(reading);
        readingControl = reading.includes('control');
        readingControls = reading.includes('controls');
        readingOther = reading.some(resource => resource !== 'control' && resource !== 'controls');
        request.stale.clear();
        request.patches = {};
        const { meta: response } = await net.getResources(sessionId, reading, { signal: request.controller.signal, owned: true });
        if (client !== net || get().connectionGeneration !== generation || metaRequests.get(sessionId) !== request) return;
        if (response && response.sessionId !== sessionId) throw new Error('Session projection returned a different session');
        // A late invalidation only dirties its own dependencies; keep other
        // projected fields, but never publish an obsolete read of that resource.
        const meta = response ? { ...cleanProjection(response, request.stale), ...request.patches } : null;
        const wasLoaded = get().sessions.find(s => s.sessionId === sessionId)?.loaded;
        if (!meta) releaseSessions([sessionId]);
        set(st => {
          const existing = st.sessions.find(s => s.sessionId === sessionId);
          const full = meta ? applyProjection(meta, existing) : null;
          const sessions = full
            ? existing ? st.sessions.map(s => s.sessionId === sessionId
              ? { ...metaToSession({ ...full,
                ...(full.error === undefined && s.error !== undefined ? { error: s.error } : {}),
                ...(full.loaded && full.compacting === undefined && s.compacting !== undefined ? { compacting: s.compacting } : {}),
                ...(full.loaded && full.intent === undefined && s.intent !== undefined ? { intent: s.intent } : {}),
              }, s),
                activityDisplay: full.loaded && (!readingControl || request.stale.has('control')) ? s.activityDisplay : undefined,
                controlsStale: full.loaded && readingControls && !request.stale.has('controls')
                  ? !meta?.controls : s.controlsStale,
                controlsDisplay: full.loaded && (!readingControls || request.stale.has('controls')) ? s.controlsDisplay : undefined,
                controlsError: full.loaded && readingControls && !request.stale.has('controls')
                  ? meta?.controls ? undefined : '活动详情暂不可用。' : s.controlsError,
              } : s) : [metaToSession(full), ...st.sessions]
            : st.sessions.filter(s => s.sessionId !== sessionId);
          return { sessions, };
        });
        if (sessionId === get().activeId && wasLoaded !== meta?.loaded) {
          if (!meta?.loaded) cancelLive(sessionId);
          maybeMaterialize();
        }
        if (!meta) return;
      } while (request.dirty.size);
    }).catch(error => {
      if (!request.controller.signal.aborted && client === net && get().connectionGeneration === generation
        && metaRequests.get(sessionId) === request) {
        if (readingControls && !readingControl && !controlConsumers.has(sessionId)) return;
        const message = describeReason(error, false);
        if (readingControl || readingControls) patchLocal(sessionId, s => ({ ...s, activity: null,
          ...(readingControls ? { controlsStale: true, controlsError: message } : {}), activityDisplay: { error: message } }));
        // Activity and control reads are shown by their row and Thread; other projections have no owner.
        if (readingOther) reportUxError(copy.failed('读取会话状态', message));
      }
    }).finally(() => {
      if (metaRequests.get(sessionId) !== request) return;
      metaRequests.delete(sessionId);
      if (request.dirty.size && !request.controller.signal.aborted && client === net && get().connectionGeneration === generation) {
        refreshMeta(sessionId, [...request.dirty]);
      } else {
        set(st => ({ activityRefreshingIds: st.activityRefreshingIds.filter(id => id !== sessionId) }));
      }
    });
  };
  const patchLocal = (sid: string, fn: (s: ChatSession) => ChatSession) =>
    set((st) => ({ sessions: st.sessions.map((s) => (s.sessionId === sid ? fn(s) : s)) }));
  let historyRequest: { sessionId: string; generation: number; controller: AbortController } | null = null;
  let liveRequest: { sessionId: string; controller: AbortController } | null = null;
  let liveSessionId: string | null = null;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const windows = new Map<string, NativeWindow>();
  let nativeReadRefresh: { pending: boolean } | null = null;
  const cancelHistory = (sid?: string) => {
    if (!historyRequest || (sid !== undefined && historyRequest.sessionId !== sid)) return;
    const request = historyRequest;
    historyRequest = null;
    request.controller.abort();
    patchLocal(request.sessionId, s => ({ ...s, loadingHistory: false }));
  };
  const cancelLive = (sid?: string) => {
    if (sid && liveSessionId !== sid) return;
    clearTimeout(liveTimer);
    liveTimer = undefined;
    const request = liveRequest;
    liveRequest = null;
    request?.controller.abort();
    if (liveSessionId) {
      const window = windows.get(liveSessionId);
      window?.disconnect();
      if (window) patchLocal(liveSessionId, s => ({ ...s, ...window.snapshot(), loadingHistory: s.loadingHistory }));
    }
    liveSessionId = null;
  };

  // Only authoritative absence releases a view; unloading and partial resource
  // responses must preserve its cursor, nested projection and unsent draft.
  const releaseSessions = (ids: readonly string[]) => {
    set(st => ({ activityRefreshingIds: st.activityRefreshingIds.filter(id => !ids.includes(id)) }));
    let revisions: CockpitState['resourceRevisions'] | undefined;
    for (const id of ids) {
      retireDraftSession(id);
      metaRequests.get(id)?.controller.abort();
      metaRequests.delete(id);
      cancelHistory(id);
      cancelLive(id);
      windows.delete(id);
      if (Object.hasOwn(get().resourceRevisions, id)) {
        revisions ??= { ...get().resourceRevisions };
        delete revisions[id];
      }
    }
    if (revisions) set({ resourceRevisions: revisions });
  };

  const connectedClient = () => {
    if (!client?.isOpen) throw new OperationNotSent('未连接');
    return client;
  };
  const read = async <T,>(send: (net: NetClient) => Promise<T>): Promise<T> => send(connectedClient());

  const nativeRead = async <T,>(sid: string, send: (net: NetClient) => Promise<T>): Promise<T> => {
    const net = connectedClient();
    if (get().sessions.find((s) => s.sessionId === sid)?.loaded !== true) throw new SessionUnloadedError();
    const generation = get().connectionGeneration;
    const refresh = nativeReadRefresh;
    const refreshPending = refresh?.pending;
    try {
      return await send(net);
    } catch (error) {
      if (isSessionUnloadedError(error)
        && client === net && generation === get().connectionGeneration
        && !refreshPending && nativeReadRefresh === refresh) {
        // One passive reconciliation per overlapping read batch, even if its ACK
        // arrives before another unloaded result. Only server events change loaded.
        const request = { pending: true };
        nativeReadRefresh = request;
        void get().refreshList().catch(() => {}).finally(() => { request.pending = false; });
      }
      throw error;
    }
  };

  // Observe the original promise, not a swallowed replacement. The owner decides
  // where a failure appears: the calling view, the session's chat, or globally.
  const mutation = (
    sid: string | null,
    operation: string,
    owner: MutationOwner,
    send: (net: NetClient, options: IntentOptions) => Promise<{ ok: boolean; applied?: boolean; error?: string }>,
    beforeSend?: () => void,
  ): Promise<void> => {
    const generation = get().connectionGeneration;
    const origin = sid ? `会话 ${get().sessions.find((s) => s.sessionId === sid)?.title ?? sid} (${sid})：` : '';
    const promise = (async () => {
      beforeSend?.();
      const result = await send(connectedClient(), OWNED);
      if (!result.ok || result.applied === false) throw new OperationRejected(result.error || '服务器未接受操作');
    })();
    void promise.catch((error) => {
      const reason = describeReason(error, false);
      const message = `${origin}${operationErrorState(error) === 'unknown'
        ? `${operation}${copy.unknown(reason)}` : copy.failed(operation, reason)}`;
      if (error instanceof OperationRejected) recordOperationFailure(error, { message, mutation: true, uncertain: false });
      if (owner === 'caller') return;
      if (owner === 'chat' && sid && get().sessions.some(s => s.sessionId === sid)
        && generation === get().connectionGeneration) {
        patchLocal(sid, (s) => ({ ...s, error: message }));
      } else reportUxError(message);
    });
    return promise;
  };

  // Session-keyed results are shown by session settings; once the session or
  // connection is gone nothing can show them, so a mutation outcome goes global.
  const reportIfOrphaned = (sid: string, generation: number, error: unknown) => {
    if (get().connectionGeneration !== generation || !get().sessions.some(s => s.sessionId === sid)) {
      reportOrphanedOperation(error);
    }
  };

  const acknowledged = async (sid: string, send: (net: NetClient, options: IntentOptions) => Promise<{ ok: boolean }>): Promise<boolean> => {
    if (!client?.isOpen) {
      patchLocal(sid, (s) => ({ ...s, error: '未连接，消息未发送，草稿已保留' }));
      return false;
    }
    try {
      const result = await send(client, OWNED);
      if (!result.ok) throw new Error('服务器未确认发送，草稿已保留');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchLocal(sid, (s) => ({ ...s, error: `未确认发送：${message}。草稿已保留，请核对会话后再重试。` }));
      return false;
    }
  };

  const publish = (sid: string, window: NativeWindow) => {
    const snapshot = window.snapshot();
    const current = get().sessions.find(s => s.sessionId === sid);
    if (!current || (current.messages === snapshot.messages && current.materialized === snapshot.materialized
      && current.historyStale === snapshot.historyStale && current.hasMore === snapshot.hasMore
      && current.partialHistory === snapshot.partialHistory && current.incompleteBoundary === snapshot.incompleteBoundary)) return;
    patchLocal(sid, s => ({ ...s, ...snapshot, loadingHistory: s.loadingHistory }));
  };

  const streamLive = (sid: string) => {
    const window = windows.get(sid);
    const session = get().sessions.find(s => s.sessionId === sid);
    if (!window?.live || window.invalid || liveRequest || !session || !isVisible()
      || get().activeId !== sid || !get().snapshotReady || get().connState !== 'open') return;
    const source = session.loaded ? 'live' : 'persisted';
    if (window.live.source !== source) window.disconnect();
    const request = { sessionId: sid, controller: new AbortController() };
    liveSessionId = sid;
    liveRequest = request;
    const query: NativeChatRead = {
      source, cursor: window.live.cursor, sessionId: sid, direction: 'forward', max: 64,
      ...(source === 'live' ? { agentScope: 'all' as const } : {}),
      bootstrap: false, waitMs: 0, includeEphemeral: false,
    };
    const current = () => liveRequest === request && windows.get(sid) === window && get().activeId === sid;
    const receive = (page: NativeChatPage) => {
      if (!current()) return;
      window.accept(page, query);
      publish(sid, window);
      if (window.unresolved && window.hasMore && !historyRequest) {
        cancelLive(sid);
        requestHistory(sid, true);
      }
    };
    const pending = source === 'live'
      ? read(net => net.chatStream({
        sessionId: sid, cursor: window.live!.cursor ?? '', max: 64, agentScope: 'all',
      }, receive, request.controller.signal))
      : read(net => net.chat(query, { signal: request.controller.signal, owned: true })).then(page => {
        if (!current()) return;
        receive(page);
        if (!current()) return;
        liveRequest = null;
        if (page.hasMore) liveTimer = setTimeout(() => { liveTimer = undefined; streamLive(sid); }, 0);
      });
    void pending.catch(error => {
      if (!current()) return;
      liveRequest = null;
      window.disconnect();
      publish(sid, window);
      if (isTransportError(error)) {
        liveTimer = setTimeout(() => { liveTimer = undefined; streamLive(sid); }, 1000);
      } else {
        if (isSessionUnloadedError(error)) refreshMeta(sid);
        patchLocal(sid, s => ({ ...s, error: `聊天同步暂停：${describeReason(error, false)}` }));
      }
    });
  };

  const requestHistory = (sid: string, older = false) => {
    if (get().activeId !== sid) return;
    cancelHistory();
    const request = { sessionId: sid, generation: get().connectionGeneration, controller: new AbortController() };
    historyRequest = request;
    const initial = get().sessions.find((s) => s.sessionId === sid);
    if (!initial) { cancelHistory(sid); return; }
    const window = windows.get(sid) ?? new NativeWindow(undefined, true);
    windows.set(sid, window);
    const errorAtStart = initial?.error;
    let position: ChatPosition = older && window.older ? window.older
      : initial.loaded ? { source: 'live', agentScope: 'all' } : { source: 'persisted' };
    if (!initial.loaded && position.source === 'live') position = { source: 'persisted', cursor: position.cursor };
    const query: NativeChatRead = {
      ...position, sessionId: sid, direction: 'backward', max: NATIVE_PAGE, waitMs: 0,
      bootstrap: !older && position.source === 'live',
    };
    patchLocal(sid, (s) => ({ ...s, loadingHistory: true, historyError: undefined }));
    const current = () => historyRequest === request && get().activeId === sid
      && request.generation === get().connectionGeneration && windows.get(sid) === window;
    void readMessageHistory(window, query, (next, signal) => read(net => net.chat(next, { signal, owned: true })),
      request.controller.signal, current).then(() => {
      if (!current()) return;
      patchLocal(sid, (s) => ({
        ...s, ...window.snapshot(),
        historyError: undefined,
        error: s.error && s.error !== errorAtStart ? s.error : null,
      }));
      historyRequest = null;
      streamLive(sid);
    }).catch((error) => {
      if (!current()) return;
      historyRequest = null;
      patchLocal(sid, (s) => ({
        ...s, loadingHistory: false, historyStale: window.invalid,
        historyError: describeReason(error, false),
        error: `加载失败：${describeReason(error, false)}`,
      }));
    });
  };

  const maybeMaterialize = () => {
    const { activeId, connState, sessions } = get();
    if (!get().snapshotReady || !activeId || connState !== 'open' || !client || !isVisible()) return;
    const s = sessions.find((x) => x.sessionId === activeId);
    const window = windows.get(activeId);
    if (!s || window?.invalid || s.loadingHistory) return;
    if (!window?.materialized || (s.loaded && !window.live)) {
      if (!s.historyError) requestHistory(activeId);
    }
    else streamLive(activeId);
  };

  const invalidateRequests = () => {
    for (const request of metaRequests.values()) request.controller.abort();
    metaRequests.clear();
    set({ snapshotReady: false, activityRefreshingIds: [] });
    cancelHistory();
    cancelLive();
    for (const window of windows.values()) window.disconnect();
    nativeReadRefresh = null;
    set((st) => ({
      connectionGeneration: st.connectionGeneration + 1,
      sessions: st.sessions.map(s => ({ ...s, loadingHistory: false, activityDisplay: undefined, controlsDisplay: undefined, controlsError: undefined,
        controlsStale: s.controls || s.controlsDisplay || s.controlsStale !== undefined ? true : undefined })),
    }));
  };

  const onEvent = (ev: ServerEvent) => {
    switch (ev.type) {
      case 'snapshot': {
        invalidateRequests();
        const present = new Set(ev.sessions.map(session => session.sessionId));
        const known = new Set([...windows.keys(), ...get().sessions.map(session => session.sessionId),
          ...Object.keys(get().resourceRevisions)]);
        releaseSessions([...known].filter(id => !present.has(id)));
        set((st) => {
          const byId = new Map(st.sessions.map((s) => [s.sessionId, s]));
          const sessions = ev.sessions.map((m) => metaToSession(m, byId.get(m.sessionId)));
          return { sessions, snapshotReady: true, globalModels: ev.models };
        });
        const active = get().sessions.find(s => s.sessionId === get().activeId);
        if (active?.loaded && (active.queue === undefined || controlConsumers.has(active.sessionId))) {
          refreshMeta(active.sessionId, [...(active.queue === undefined ? ['queue' as const] : []), ...(controlConsumers.has(active.sessionId) ? ['controls' as const] : [])]);
        }
        maybeMaterialize();
        return;
      }
      case 'agent/status':
        return;
      case 'module/invalidated':
        for (const listener of [...moduleListeners]) if (moduleListeners.has(listener)) listener(ev.moduleId);
        return;
      case 'module/event':
        for (const listener of [...moduleEventListeners]) if (moduleEventListeners.has(listener)) {
          try { listener(ev.moduleId, ev.payload); }
          catch (error) { reportUxError(`模块反馈：${describeReason(error, false)}`); }
        }
        return;
      case 'session/invalidated': {
        // Late invalidations cannot recreate resources for an absent session.
        if (!get().sessions.some(session => session.sessionId === ev.sessionId)) return;
        const resources = ev.resources ?? SessionResource.options;
        set(st => {
          const revisions = { ...st.resourceRevisions[ev.sessionId] };
          for (const resource of resources) revisions[resource] = (revisions[resource] ?? 0) + 1;
          return {
            resourceRevisions: { ...st.resourceRevisions, [ev.sessionId]: revisions },
            ...(resources.includes('controls') || resources.includes('control') || (resources.includes('queue') && st.activeId !== ev.sessionId) ? {
              sessions: st.sessions.map(s => s.sessionId === ev.sessionId ? {
                ...s,
                ...(resources.includes('control') ? {
                  activity: null,
                  activityDisplay: s.loaded && s.activity ? { previous: { status: s.status, activity: s.activity } } : s.activityDisplay,
                } : {}),
                ...(resources.includes('controls') ? {
                  controls: null, controlsDisplay: s.controls ?? s.controlsDisplay, controlsStale: true,
                } : {}),
                ...(resources.includes('queue') && st.activeId !== ev.sessionId ? { queue: undefined } : {}),
              } : s),
            } : {}),
          };
        });
        refreshMeta(ev.sessionId, resources);
        return;
      }
      case 'session/added':
        metaRequests.get(ev.session.sessionId)?.controller.abort();
        metaRequests.delete(ev.session.sessionId);
        set(st => ({ activityRefreshingIds: st.activityRefreshingIds.filter(id => id !== ev.session.sessionId) }));
        set((st) => {
          const exists = st.sessions.some(s => s.sessionId === ev.session.sessionId);
          const sessions = exists ? st.sessions.map(s => s.sessionId === ev.session.sessionId
            ? { ...metaToSession(ev.session, s), activityDisplay: undefined, controlsDisplay: undefined, controlsError: undefined,
              controlsStale: ev.session.controls ? false : undefined } : s)
            : [metaToSession(ev.session), ...st.sessions];
          return { sessions, };
        });
        if (get().activeId === ev.session.sessionId && ev.session.loaded
          && (ev.session.queue === undefined || controlConsumers.has(ev.session.sessionId))) {
          refreshMeta(ev.session.sessionId, [...(ev.session.queue === undefined ? ['queue' as const] : []),
            ...(controlConsumers.has(ev.session.sessionId) ? ['controls' as const] : [])]);
        }
        maybeMaterialize();
        return;
      case 'session/removed':
        releaseSessions([ev.sessionId]);
        // Drop the row. We deliberately DON'T clear activeId here: the URL is the
        // source of truth for what's focused, so a remote delete just makes the
        // active session vanish from `sessions`, and the page derives a NotFound
        // pane from (routeId set, no matching session). A LOCAL delete navigates
        // back to the list itself (App.doDelete), so it never hits NotFound.
        set((st) => {
          const sessions = st.sessions.filter((s) => s.sessionId !== ev.sessionId);
          return {
            sessions,
          };
        });
        return;
      case 'session/patch': {
        const activeId = get().activeId;
        const { type, ...patch } = ev;
        void type;
        const pending = metaRequests.get(ev.sessionId);
        if (pending) {
          if ('loaded' in patch || patch.closing) {
            pending.controller.abort();
            metaRequests.delete(ev.sessionId);
            set(st => ({ activityRefreshingIds: st.activityRefreshingIds.filter(id => id !== ev.sessionId) }));
          } else Object.assign(pending.patches, patch);
        }
        set((st) => {
          const sessions = st.sessions.map((s) => {
            if (s.sessionId !== ev.sessionId) return s;
            if (patch.loaded === false) {
              return metaToSession({
                title: s.title, cwd: s.cwd, createdAt: s.createdAt,
                lastActivity: s.lastActivity, lastActivitySource: s.lastActivitySource,
                roles: s.roles, appliedRoles: [], rolesNeedReload: false,
                loaded: false, status: 'unloaded', ask: null,
                ...patch,
              }, s);
            }
            return { ...s, ...patch,
              controlsDisplay: 'loaded' in patch || patch.closing || patch.controls
                ? undefined : patch.controls === null ? s.controls ?? s.controlsDisplay : s.controlsDisplay,
              controlsStale: patch.controls ? false : patch.controls === null || 'loaded' in patch || patch.closing
                ? true : s.controlsStale,
              activityDisplay: 'loaded' in patch || patch.closing || patch.activity
                ? undefined : patch.activity === null && s.loaded && s.activity
                  ? { previous: { status: s.status, activity: s.activity } } : s.activityDisplay,
            };
          });
          return {
            sessions,
          };
        });
        if (ev.sessionId === activeId && 'loaded' in ev) {
          if (!ev.loaded) cancelLive(ev.sessionId);
          else if (controlConsumers.has(ev.sessionId)) refreshMeta(ev.sessionId, ['queue', 'controls']);
          maybeMaterialize();
        }
        return;
      }
      case 'chat/invalidated': {
        // Compaction does not rewrite chat; older hosts also emitted this on failure.
        if (ev.reason === 'compaction') return;
        cancelHistory(ev.sessionId);
        cancelLive(ev.sessionId);
        windows.get(ev.sessionId)?.invalidate();
        patchLocal(ev.sessionId, s => ({ ...invalidateWindow(s), error: '历史已变更；当前画面已保留，请重新同步。' }));
        return;
      }
      default:
        return;
    }
  };

  const onStateChange = (state: ConnState) => {
    if (state === 'connecting') invalidateRequests();
    set({ connState: state });
    if (state === 'open' && get().snapshotReady) {
      maybeMaterialize();
    }
  };

  return {
    connState: 'connecting',
    snapshotReady: false,
    connectionGeneration: 0,
    sessions: [],
    activeId: null,
    globalModels: [],
    resourceRevisions: {},
    activityRefreshingIds: [],
    onModuleInvalidated(listener) {
      moduleListeners.add(listener);
      return () => { moduleListeners.delete(listener); };
    },
    onModuleEvent(listener) {
      moduleEventListeners.add(listener);
      return () => { moduleEventListeners.delete(listener); };
    },

    connectedClient,
    init() {
      client?.disconnect();
      const net = new NetClient({ onEvent, onStateChange, sessionTitle: sid => get().sessions.find(s => s.sessionId === sid)?.title });
      client = net;
      net.connect();
      const onVisible = () => {
        if (isVisible()) maybeMaterialize();
        else { cancelHistory(); cancelLive(); }
      };
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') window.addEventListener('online', onVisible);
      return () => {
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
        if (typeof window !== 'undefined') window.removeEventListener('online', onVisible);
        net.disconnect();
        if (client !== net) return;
        client = null;
        invalidateRequests();
        set({ connState: 'connecting' });
      };
    },

    setActiveId(id) {
      const previous = get().activeId;
      if (id !== previous) {
        cancelHistory();
        cancelLive();
        set({ activeId: id });
        const active = get().sessions.find(s => s.sessionId === id);
        if (active?.loaded && active.queue === undefined && get().snapshotReady) refreshMeta(active.sessionId, ['queue']);
      }
      maybeMaterialize();
    },
    newSession(cwd, roles) {
      // The directory dialog shows the result; orphaned outcomes use its keyed action.
      const promise = read(net => net.newSession(cwd, roles, OWNED)).then(result => result.sessionId);
      void promise.catch(() => {});
      return promise;
    },

    loadMore(sid) {
      if (get().activeId !== sid || !isVisible() || !get().snapshotReady || get().connState !== 'open' || !client) return;
      const s = get().sessions.find((x) => x.sessionId === sid);
      if (!s || s.historyStale || !s.hasMore || s.loadingHistory) return;
      requestHistory(sid, true);
    },

    retryHistory(sid) {
      if (get().activeId !== sid || !get().snapshotReady || get().connState !== 'open' || !client) return;
      const s = get().sessions.find((x) => x.sessionId === sid);
      if (!s || s.loadingHistory) return;
      if (s.historyError && !s.historyStale) {
        requestHistory(sid, !!windows.get(sid)?.older);
        return;
      }
      cancelLive(sid);
      if (s.historyStale || !windows.get(sid)?.materialized) windows.set(sid, new NativeWindow(undefined, true));
      if (windows.get(sid)?.live && !s.historyStale) streamLive(sid);
      else requestHistory(sid);
    },

    sendDraft(request) {
      return acknowledged(request.body.sessionId, (net, options) => net.sendDraft(request, options));
    },
    canSendDraft(draft) {
      const state = get();
      if (!client?.isOpen || state.connState !== 'open' || !state.snapshotReady) return 'unavailable';
      const session = state.sessions.find(value => value.sessionId === draft.sessionId);
      if (!session || session.loading || session.closing || (session.compacting && session.status !== 'running')) return 'unavailable';
      if (draft.getSnapshot().retired) return 'retired';
      const purpose = draft.purpose;
      if (purpose.kind === 'prompt') return;
      if (purpose.kind === 'elicitation') return 'unsupported';
      if (!session.loaded) return 'unavailable';
      if (purpose.kind === 'ask') {
        if (session.ask?.requestId !== purpose.requestId) return 'decision-changed';
        if (session.ask.allowFreeform === false) return 'unsupported';
      } else if (session.planRequest?.requestId !== purpose.requestId) return 'decision-changed';
    },

    watchControls(sid) {
      controlConsumers.set(sid, (controlConsumers.get(sid) ?? 0) + 1);
      refreshMeta(sid, ['controls']);
      return () => {
        const count = (controlConsumers.get(sid) ?? 1) - 1;
        if (count > 0) controlConsumers.set(sid, count);
        else {
          controlConsumers.delete(sid);
          const request = metaRequests.get(sid);
          request?.stale.add('controls');
          if (request && [...request.reading, ...request.dirty].every(resource => resource === 'controls')) {
            request.controller.abort();
            metaRequests.delete(sid);
            set(state => ({ activityRefreshingIds: state.activityRefreshingIds.filter(id => id !== sid) }));
          }
          patchLocal(sid, row => ({ ...row, controlsStale: true }));
        }
      };
    },
    refreshControls(sid) { refreshMeta(sid, ['control', 'controls', 'queue']); },
    cancel(sid) { return mutation(sid, '停止', 'caller', (net, options) => net.cancel(sid, options)); },
    async sessionControlAction(sid, action) {
      const session = get().sessions.find(row => row.sessionId === sid);
      if (!session?.loaded || !session.controls || session.controlsStale) throw new Error('活动状态尚未同步，请等待刷新后操作。');
      const token = session.controls.token;
      try {
        const result = await nativeRead(sid, net => net.sessionControl(sid, token, action, OWNED));
        if (!result.ok) {
          const details = result.outcomes.filter(outcome => outcome.state === 'failed' || outcome.state === 'unconfirmed')
            .map(outcome => `${outcome.operation}${outcome.targetId ? ` (${outcome.targetId})` : ''}：${outcome.error ?? outcome.state}`);
          const message = details.join('；') || '未收到确认，请核对当前活动状态';
          const error = result.outcomes.some(outcome => outcome.state === 'unconfirmed')
            ? new OperationUnconfirmed(message) : new OperationRejected(message);
          const sentence = error instanceof OperationRejected ? copy.failed('控制操作', message) : `控制操作${copy.unknown(message)}`;
          recordOperationFailure(error, { message: `会话 ${session.title} (${sid})：${sentence}`, mutation: true,
            uncertain: !(error instanceof OperationRejected) });
          throw error;
        }
      } finally {
        refreshMeta(sid, ['control', 'controls', 'queue']);
      }
    },
    interrupt(sid) { return nativeRead(sid, (net) => net.interrupt(sid, OWNED)); },
    reloadingSessionIds: [],
    sessionReloadResults: {},
    sessionSettingsOperations: {},
    async runSessionSettingsAction(sid, action, customInstructions) {
      const state = get();
      const reason = sessionSettingsBlockReason(state.sessions.find(s => s.sessionId === sid),
        state.connState === 'open' && state.snapshotReady,
        state.reloadingSessionIds.includes(sid) || state.sessionSettingsOperations[sid]?.pending);
      if (reason) throw new Error(reason);
      const net = connectedClient();
      const generation = state.connectionGeneration;
      const update = (patch: Partial<SessionSettingsOperation>) => set(st => ({
        sessionSettingsOperations: { ...st.sessionSettingsOperations,
          [sid]: { ...st.sessionSettingsOperations[sid], action, ...patch } },
      }));
      set(st => ({ sessionSettingsOperations: { ...st.sessionSettingsOperations, [sid]: { action, pending: true } } }));
      try {
        if (action === 'compact') {
          const { result } = await net.intent('session/compact', {
            sessionId: sid, ...(customInstructions?.trim() ? { customInstructions } : {}),
          }, OWNED);
          update({ outcome: { action, result } });
        } else if (action === 'fork') {
          const result = await net.intent('session/fork', { sessionId: sid }, OWNED);
          update({ outcome: { action, sessionId: result.sessionId } });
        } else {
          const result = await net.intent('session/unload', { sessionId: sid }, OWNED);
          if (!result.ok) throw new OperationRejected('服务器未接受卸载');
          const { meta } = await net.intent('session/get', { sessionId: sid }, OWNED);
          if (meta && meta.sessionId !== sid) throw new Error('Copilot 返回了其他会话，卸载状态未确认');
          update({ outcome: { action, present: meta !== null, loaded: meta?.loaded === true } });
          // Only a same-connection authoritative read changes presence/loading.
          // Preserve the rendered history and drafts of an unloaded session.
          if (client === net && get().connectionGeneration === generation) {
            if (!meta) releaseSessions([sid]);
            else if (!meta.loaded) cancelLive(sid);
            set(st => ({ sessions: meta
              ? st.sessions.map(row => row.sessionId === sid ? metaToSession(meta, row) : row)
              : st.sessions.filter(row => row.sessionId !== sid) }));
          }
        }
      } catch (error) {
        update({ error: describeReason(error, false), errorState: operationErrorState(error) });
        reportIfOrphaned(sid, generation, error);
        throw error;
      } finally {
        // Reconcile even uncertain mutations, without resuming or replaying them.
        if (client !== net || get().connectionGeneration !== generation || !net.isOpen) {
          update({ refreshError: '连接已变化，请重新核对会话列表与状态' });
        } else {
          try {
            await net.refresh(OWNED);
            refreshMeta(sid);
          } catch (error) {
            update({ refreshError: describeReason(error, false) });
          }
        }
        update({ pending: false });
      }
    },
    reloadSession(sid) {
      let submitted = false;
      const promise = mutation(sid, '重新加载会话', 'caller', (net, options) => net.reloadSession(sid, options), () => {
        const state = get();
        const reason = sessionReloadBlockReason(
          state.sessions.find(s => s.sessionId === sid),
          state.connState === 'open' && state.snapshotReady,
          state.reloadingSessionIds.includes(sid) || state.sessionSettingsOperations[sid]?.pending,
        );
        if (reason) throw new Error(reason);
        submitted = true;
        const results = { ...state.sessionReloadResults };
        delete results[sid];
        set({ reloadingSessionIds: [...state.reloadingSessionIds, sid], sessionReloadResults: results });
      });
      const generation = get().connectionGeneration;
      const settle = (result: CockpitState['sessionReloadResults'][string]) => {
        if (submitted) set(st => ({ reloadingSessionIds: st.reloadingSessionIds.filter(id => id !== sid),
          sessionReloadResults: { ...st.sessionReloadResults, [sid]: result } }));
      };
      return promise.then(() => settle({ state: 'done' }), error => {
        settle({ state: operationErrorState(error), reason: describeReason(error, false) });
        if (submitted) reportIfOrphaned(sid, generation, error);
        throw error;
      });
    },
    deleteSession(sid) { return mutation(sid, '永久删除会话', 'caller', (net, options) => net.deleteSession(sid, options)); },
    loadSession(sid) { return mutation(sid, '恢复会话', 'caller', (net, options) => net.loadSession(sid, options)); },
    respondAsk(sid, requestId, answer, wasFreeform) { return acknowledged(sid, (net, options) => net.respondAsk(sid, requestId, answer, wasFreeform, options)); },
    respondPlan(sid, requestId, action) { return acknowledged(sid, (net, options) => net.respondPlan(sid, requestId, action, options)); },
    planSupersede(sid, requestId, message) { return acknowledged(sid, (net, options) => net.planSupersede(sid, requestId, message, options)); },
    respondElicitation(sid, requestId, action) { return acknowledged(sid, (net, options) => net.respondElicitation(sid, requestId, action, options)); },
    removeQueued(sid, itemId) { return mutation(sid, '移除排队消息', 'chat', (net, options) => net.removeQueued(sid, itemId, options)); },
    refreshList() { return mutation(null, '刷新会话列表', 'global', (net, options) => net.refresh(options)); },
    getResources(sid, resources, signal) {
      return nativeRead(sid, net => net.getResources(sid, resources, { signal, owned: true })).then(({ meta }) => {
        if (!meta?.loaded) throw new SessionUnloadedError();
        return meta;
      });
    },
    mcpSession(sid) {
      return nativeRead(sid, async (net) => {
        const result = await net.mcpSession(sid, OWNED);
        if (!result.loaded) throw new SessionUnloadedError();
        return result.servers;
      });
    },
    mcpToggleSession(sid, name, on) { return mutation(sid, `切换 MCP ${name}`, 'caller', (net, options) => net.mcpToggleSession(sid, name, on, options)); },
    skillsSession(sid) { return nativeRead(sid, (net) => net.skillsSession(sid, OWNED)).then((r) => r.skills); },
    skillsToggleSession(sid, name, enabled) { return mutation(sid, `切换技能 ${name}`, 'caller', (net, options) => net.skillsToggleSession(sid, name, enabled, options)); },
    async refreshRoles(sid, signal) {
      const net = connectedClient();
      const generation = get().connectionGeneration;
      const original = get().sessions.find(row => row.sessionId === sid);
      const revision = get().resourceRevisions[sid]?.identity;
      const { meta } = await net.getResources(sid, ['identity'], { signal, owned: true });
      if (!meta || meta.sessionId !== sid) throw new Error('返回的会话 ID 不匹配或会话已不存在');
      if (!meta.roles || !meta.appliedRoles || meta.rolesNeedReload === undefined) {
        throw new Error('角色保存或应用状态未确认，请重新刷新');
      }
      const current = get().sessions.find(row => row.sessionId === sid);
      // Do not overwrite newer SSE identity or unlock a retry with an obsolete read.
      if (signal?.aborted || client !== net || get().connState !== 'open' || get().connectionGeneration !== generation
        || !original || !current || current.loaded !== meta.loaded || current.loaded !== original.loaded
        || current.roles !== original.roles || current.appliedRoles !== original.appliedRoles
        || get().resourceRevisions[sid]?.identity !== revision) {
        throw new Error('连接或会话角色已变化，请重新刷新');
      }
      const fields = { roles: meta.roles, appliedRoles: meta.appliedRoles, rolesNeedReload: meta.rolesNeedReload };
      const pending = metaRequests.get(sid);
      if (pending) Object.assign(pending.patches, fields);
      patchLocal(sid, row => ({ ...row, ...fields }));
      return meta;
    },
  };
});

export const useCockpit = createCockpitStore();
useCockpit.subscribe(state => observeDraftDecisions(state.sessions, state.snapshotReady && state.connState === 'open'));
