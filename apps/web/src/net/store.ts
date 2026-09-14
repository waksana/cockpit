// Browser-owned native chat windows plus the server's control projection.
// SSE supplies metadata/decisions; bounded HTTP reads feed only the visible chat.
// Loaded pages, cursors and drafts are local. init() owns this tab's transport lifecycle.

import { create } from 'zustand';
import { isSessionUnloadedError, isTransportError, NetClient, SessionUnloadedError } from './client';
import type { ConnState } from './client';
import type {
  AgentStatus, NativeAttachment, ChatSession, ModelOption, ServerEvent,
} from './types';
import { MetaResource, SessionResource, type SessionMeta } from '@cockpit/protocol';
import type { IntentResult, NativeChatRead, NativeChatPage, SessionProjection } from '@cockpit/protocol';
import { invalidateWindow, metaToSession } from './sessionWindow';
import { applyProjection, cleanProjection } from './sessionResources';
import { NativeWindow, NATIVE_PAGE, type ChatPosition } from './nativeWindow';
import { readMessageHistory } from './messageHistory';
import { describeReason, reportUxError } from '../lib/errorReporter';

// Background tabs release their native chat read.
const isVisible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';

interface CockpitState {
  connState: ConnState;
  connectionGeneration: number;
  permissionPolicy: 'allow-all';
  agentStatus: AgentStatus;
  sessions: ChatSession[];
  activeId: string | null;
  globalModels: ModelOption[];
  resourceRevisions: Record<string, Partial<Record<SessionResource, number>>>;
  // lifecycle
  init: () => () => void;
  // intents
  setActiveId: (id: string | null) => void;
  newSession: (cwd: string) => Promise<string>;
  loadMore: (sessionId: string) => void;
  retryHistory: (sessionId: string) => void;
  sendPrompt: (sessionId: string, text: string, attachments?: NativeAttachment[]) => Promise<boolean>;
  cancel: (sessionId: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<{ ok: true; interrupted: boolean }>;
  setModel: (sessionId: string, modelId: string, opts?: { reasoningEffort?: string; contextTier?: 'default' | 'long_context' }) => Promise<void>;
  deleteSession: (sessionId: string, confirm: true) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  setMode: (sessionId: string, mode: 'interactive' | 'plan' | 'autopilot') => Promise<void>;
  getResources: (sessionId: string, resources: MetaResource[], signal?: AbortSignal) => Promise<SessionProjection>;
  // MCP + Skills management
  mcpGlobal: () => Promise<import('@cockpit/protocol').McpServerGlobal[]>;
  mcpSetDefault: (name: string, on: boolean) => Promise<void>;
  mcpRefresh: () => Promise<void>;
  mcpSession: (sessionId: string) => Promise<import('@cockpit/protocol').McpServerSession[]>;
  mcpToggleSession: (sessionId: string, name: string, on: boolean) => Promise<void>;
  skillsGlobal: (cwd?: string) => Promise<import('@cockpit/protocol').SkillGlobal[]>;
  skillsRead: (name: string, cwd?: string) => Promise<IntentResult<'skills/read'>>;
  skillsSetGlobal: (name: string, enabled: boolean, cwd?: string) => Promise<void>;
  skillsSession: (sessionId: string) => Promise<import('@cockpit/protocol').SkillSession[]>;
  skillsToggleSession: (sessionId: string, name: string, enabled: boolean) => Promise<void>;
  listDir: (path?: string) => Promise<import('@cockpit/protocol').DirListing>;
  respondAsk: (sessionId: string, requestId: string, answer: string, wasFreeform: boolean) => Promise<boolean>;
  respondPlan: (sessionId: string, requestId: string, action: import('@cockpit/protocol').ExitPlanModeAction) => Promise<boolean>;
  planSupersede: (sessionId: string, requestId: string, message: string) => Promise<boolean>;
  respondElicitation: (sessionId: string, requestId: string, action: 'accept' | 'decline' | 'cancel') => Promise<boolean>;
  removeQueued: (sessionId: string, itemId: string) => Promise<void>;
  refreshList: () => Promise<void>;
}

export const createCockpitStore = () => create<CockpitState>((set, get) => {
  let client: NetClient | null = null;
  const summaryResources: MetaResource[] = ['identity', 'control', 'model', 'mode'];
  const metaRequests = new Map<string, {
    dirty: Set<MetaResource>; stale: Set<MetaResource>; controller: AbortController; patches: Partial<SessionMeta>;
  }>();
  const refreshMeta = (sessionId: string, resources: readonly SessionResource[] = SessionResource.options) => {
    const session = get().sessions.find(row => row.sessionId === sessionId);
    // New rows arrive through added/snapshot with a complete identity, not an
    // invalidation racing the native creation acknowledgement.
    if (!session) return;
    // A closing transition refuses new native reads. Its settling event will
    // invalidate again; keep the current frontend view in the meantime.
    if (session?.closing) return;
    const pending = metaRequests.get(sessionId);
    // Obsolete in-flight fields must be discarded even after their consumer
    // unmounts. Demand decides rereads, not whether an old result is still valid.
    if (pending) for (const resource of resources) {
      const parsed = MetaResource.safeParse(resource);
      if (parsed.success) pending.stale.add(parsed.data);
    }
    const consumed = new Set<SessionResource>(summaryResources);
    if (sessionId === get().activeId) consumed.add('queue');
    const needed = resources.filter((resource): resource is MetaResource =>
      MetaResource.safeParse(resource).success && consumed.has(resource));
    if (!needed.length) return;
    if (pending) { for (const resource of needed) pending.dirty.add(resource); return; }
    const request = { dirty: new Set(needed), stale: new Set<MetaResource>(), controller: new AbortController(), patches: {} as Partial<SessionMeta> };
    const net = client;
    const generation = get().connectionGeneration;
    if (!net?.isOpen) return;
    metaRequests.set(sessionId, request);
    void Promise.resolve().then(async () => {
      do {
        const reading = [...request.dirty].filter(resource => resource !== 'queue' || get().activeId === sessionId);
        request.dirty.clear();
        if (!reading.length) return;
        request.stale.clear();
        request.patches = {};
        const { meta: response } = await net.getResources(sessionId, reading, request.controller.signal);
        if (client !== net || get().connectionGeneration !== generation || metaRequests.get(sessionId) !== request) return;
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
              ? metaToSession({ ...full,
                ...(full.error === undefined && s.error !== undefined ? { error: s.error } : {}),
                ...(full.loaded && full.compacting === undefined && s.compacting !== undefined ? { compacting: s.compacting } : {}),
                ...(full.loaded && full.intent === undefined && s.intent !== undefined ? { intent: s.intent } : {}),
              }, s) : s) : [metaToSession(full), ...st.sessions]
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
      if (!request.controller.signal.aborted && client === net && get().connectionGeneration === generation) {
        reportUxError('读取会话状态失败', error);
      }
    }).finally(() => {
      if (metaRequests.get(sessionId) !== request) return;
      metaRequests.delete(sessionId);
      if (request.dirty.size && !request.controller.signal.aborted && client === net && get().connectionGeneration === generation) {
        refreshMeta(sessionId, [...request.dirty]);
      }
    });
  };
  const patchLocal = (sid: string, fn: (s: ChatSession) => ChatSession) =>
    set((st) => ({ sessions: st.sessions.map((s) => (s.sessionId === sid ? fn(s) : s)) }));
  let snapshotReady = false;
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
    let revisions: CockpitState['resourceRevisions'] | undefined;
    for (const id of ids) {
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
    if (!client?.isOpen) throw new Error('未连接');
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

  // Observe the original promise, not a swallowed replacement: legacy void callers
  // get diagnostics, while awaiting dialogs still receive the rejection.
  const mutation = (
    sid: string | null,
    operation: string,
    send: (net: NetClient) => Promise<{ ok: boolean; applied?: boolean; error?: string }>,
  ): Promise<void> => {
    const generation = get().connectionGeneration;
    const origin = sid ? `会话 ${get().sessions.find((s) => s.sessionId === sid)?.title ?? sid} (${sid})：` : '';
    let reportedByTransport = false;
    const promise = (async () => {
      const result = await send(connectedClient()).catch((error) => {
        reportedByTransport = !isSessionUnloadedError(error);
        throw error;
      });
      if (!result.ok || result.applied === false) throw new Error(result.error || '服务器未确认操作');
    })();
    void promise.catch((error) => {
      const message = `${origin}${operation}失败：${describeReason(error, false)}`;
      // HTTP/transport/schema errors have one request-owned global notice.
      // Offline and negative acknowledgements originate here instead.
      if (!reportedByTransport) reportUxError(message, { deduplicate: false });
      if (sid && get().sessions.some(s => s.sessionId === sid)
        && generation === get().connectionGeneration) {
        patchLocal(sid, (s) => ({ ...s, error: message }));
      }
    });
    return promise;
  };

  const acknowledged = async (sid: string, send: (net: NetClient) => Promise<{ ok: boolean }>): Promise<boolean> => {
    if (!client?.isOpen) {
      patchLocal(sid, (s) => ({ ...s, error: '未连接，消息未发送，草稿已保留' }));
      return false;
    }
    try {
      const result = await send(client);
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
      || get().activeId !== sid || !snapshotReady || get().connState !== 'open') return;
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
      : read(net => net.chat(query, request.controller.signal)).then(page => {
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
    void readMessageHistory(window, query, (next, signal) => read(net => net.chat(next, signal)),
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
    if (!snapshotReady || !activeId || connState !== 'open' || !client || !isVisible()) return;
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
    snapshotReady = false;
    cancelHistory();
    cancelLive();
    for (const window of windows.values()) window.disconnect();
    nativeReadRefresh = null;
    set((st) => ({
      connectionGeneration: st.connectionGeneration + 1,
      sessions: st.sessions.map(s => ({ ...s, loadingHistory: false })),
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
        snapshotReady = true;
        set({ agentStatus: ev.agentStatus, permissionPolicy: ev.permissionPolicy, globalModels: ev.models });
        set((st) => {
          const byId = new Map(st.sessions.map((s) => [s.sessionId, s]));
          const sessions = ev.sessions.map((m) => metaToSession(m, byId.get(m.sessionId)));
          return { sessions, };
        });
        const active = get().sessions.find(s => s.sessionId === get().activeId);
        if (active?.loaded && active.queue === undefined) refreshMeta(active.sessionId, ['queue']);
        maybeMaterialize();
        return;
      }
      case 'agent/status':
        set({ agentStatus: ev.status });
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
            ...(resources.includes('queue') && st.activeId !== ev.sessionId ? {
              sessions: st.sessions.map(s => s.sessionId === ev.sessionId ? { ...s, queue: undefined } : s),
            } : {}),
          };
        });
        refreshMeta(ev.sessionId, resources);
        return;
      }
      case 'session/added':
        metaRequests.get(ev.session.sessionId)?.controller.abort();
        metaRequests.delete(ev.session.sessionId);
        set((st) => {
          const exists = st.sessions.some(s => s.sessionId === ev.session.sessionId);
          const sessions = exists ? st.sessions.map(s => s.sessionId === ev.session.sessionId ? metaToSession(ev.session, s) : s)
            : [metaToSession(ev.session), ...st.sessions];
          return { sessions, };
        });
        if (get().activeId === ev.session.sessionId && ev.session.loaded && ev.session.queue === undefined) {
          refreshMeta(ev.session.sessionId, ['queue']);
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
          } else Object.assign(pending.patches, patch);
        }
        set((st) => {
          const sessions = st.sessions.map((s) => {
            if (s.sessionId !== ev.sessionId) return s;
            if (patch.loaded === false) {
              return metaToSession({
                title: s.title, cwd: s.cwd, createdAt: s.createdAt,
                lastActivity: s.lastActivity, lastActivitySource: s.lastActivitySource,
                loaded: false, status: 'unloaded', ask: null,
                ...patch,
              }, s);
            }
            return { ...s, ...patch };
          });
          return {
            sessions,
          };
        });
        if (ev.sessionId === activeId && 'loaded' in ev) {
          if (!ev.loaded) cancelLive(ev.sessionId);
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
        patchLocal(ev.sessionId, s => ({ ...invalidateWindow(s), error: '原生历史已变更；当前画面已保留，请重新同步。' }));
        return;
      }
      default:
        return;
    }
  };

  const onStateChange = (state: ConnState) => {
    if (state === 'connecting') invalidateRequests();
    set({ connState: state });
    if (state === 'open' && snapshotReady) {
      maybeMaterialize();
    }
  };

  return {
    connState: 'connecting',
    connectionGeneration: 0,
    permissionPolicy: 'allow-all',
    agentStatus: 'starting',
    sessions: [],
    activeId: null,
    globalModels: [],
    resourceRevisions: {},

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
        if (active?.loaded && active.queue === undefined && snapshotReady) refreshMeta(active.sessionId, ['queue']);
      }
      maybeMaterialize();
    },
    newSession(cwd) {
      let reportedByTransport = false;
      const promise = read(net => net.newSession(cwd).catch(error => {
        reportedByTransport = !isSessionUnloadedError(error);
        throw error;
      })).then(result => result.sessionId);
      void promise.catch(error => {
        if (!reportedByTransport) reportUxError(`新建会话失败：${describeReason(error, false)}`, { deduplicate: false });
      });
      return promise;
    },

    loadMore(sid) {
      if (get().activeId !== sid || !isVisible() || !snapshotReady || get().connState !== 'open' || !client) return;
      const s = get().sessions.find((x) => x.sessionId === sid);
      if (!s || s.historyStale || !s.hasMore || s.loadingHistory) return;
      requestHistory(sid, true);
    },

    retryHistory(sid) {
      if (get().activeId !== sid || !snapshotReady || get().connState !== 'open' || !client) return;
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

    sendPrompt(sid, text, attachments) {
      return acknowledged(sid, (net) => net.prompt(sid, text, attachments));
    },

    cancel(sid) { return mutation(sid, '取消', (net) => net.cancel(sid)); },
    interrupt(sid) { return nativeRead(sid, (net) => net.interrupt(sid)); },
    setModel(sid, modelId, opts) { return mutation(sid, '切换模型', (net) => net.setModel(sid, modelId, opts)); },
    deleteSession(sid, confirm) { return mutation(sid, '永久删除会话', (net) => net.deleteSession(sid, confirm)); },
    loadSession(sid) { return mutation(sid, '恢复会话', (net) => net.loadSession(sid)); },
    setMode(sid, mode) { return mutation(sid, '切换模式', (net) => net.setMode(sid, mode)); },
    respondAsk(sid, requestId, answer, wasFreeform) { return acknowledged(sid, (net) => net.respondAsk(sid, requestId, answer, wasFreeform)); },
    respondPlan(sid, requestId, action) { return acknowledged(sid, (net) => net.respondPlan(sid, requestId, action)); },
    planSupersede(sid, requestId, message) { return acknowledged(sid, (net) => net.planSupersede(sid, requestId, message)); },
    respondElicitation(sid, requestId, action) { return acknowledged(sid, (net) => net.respondElicitation(sid, requestId, action)); },
    removeQueued(sid, itemId) { return mutation(sid, '移除排队消息', (net) => net.removeQueued(sid, itemId)); },
    refreshList() { return mutation(null, '刷新会话列表', (net) => net.refresh()); },
    getResources(sid, resources, signal) {
      return nativeRead(sid, net => net.getResources(sid, resources, signal)).then(({ meta }) => {
        if (!meta?.loaded) throw new SessionUnloadedError();
        return meta;
      });
    },
    mcpGlobal() { return read((net) => net.mcpGlobal()).then((r) => r.servers); },
    mcpSetDefault(name, on) { return mutation(null, `设置 Copilot 全局 MCP ${name}`, (net) => net.mcpSetDefault(name, on)); },
    mcpRefresh() { return mutation(null, '刷新 MCP 配置缓存', (net) => net.mcpRefresh()); },
    mcpSession(sid) {
      return nativeRead(sid, async (net) => {
        const result = await net.mcpSession(sid);
        if (!result.loaded) throw new SessionUnloadedError();
        return result.servers;
      });
    },
    mcpToggleSession(sid, name, on) { return mutation(sid, `切换 MCP ${name}`, (net) => net.mcpToggleSession(sid, name, on)); },
    skillsGlobal(cwd) { return read((net) => net.skillsGlobal(cwd)).then((r) => r.skills); },
    skillsRead(name, cwd) { return read((net) => net.skillsRead(name, cwd)); },
    skillsSetGlobal(name, enabled, cwd) { return mutation(null, `设置 Copilot 全局 Skill ${name}`, (net) => net.skillsSetGlobal(name, enabled, cwd)); },
    skillsSession(sid) { return nativeRead(sid, (net) => net.skillsSession(sid)).then((r) => r.skills); },
    skillsToggleSession(sid, name, enabled) { return mutation(sid, `切换技能 ${name}`, (net) => net.skillsToggleSession(sid, name, enabled)); },
    listDir(path) { return read((net) => net.listDir(path)); },
  };
});

export const useCockpit = createCockpitStore();
