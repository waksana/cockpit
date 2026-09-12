// Browser-owned native chat windows plus the server's control projection.
// SSE supplies metadata/decisions; bounded HTTP reads feed only the visible chat.
// Loaded pages, cursors and drafts are local. Attention counters remain server
// truth shared across devices. init() owns this tab's transport lifecycle.

import { create } from 'zustand';
import { isSessionUnloadedError, isTransportError, NetClient, SessionUnloadedError } from './client';
import type { ConnState } from './client';
import type {
  AgentStatus, Attachment, ChatSession, ModelOption, ServerEvent,
} from './types';
import { MetaResource, SessionResource, type SessionMeta } from '@cockpit/protocol';
import type { IntentBody, IntentResult, NativeChatRead, NativeChatPage, PanelSection, PanelItem, SessionProjection, IntentName } from '@cockpit/protocol';
import { invalidateWindow, metaToSession } from './sessionWindow';
import { applyProjection, cleanProjection } from './sessionResources';
import { NativeWindow, NATIVE_PAGE, type ChatPosition } from './nativeWindow';
import { readMessageHistory } from './messageHistory';
import { notify } from '../lib/notify';
import { clearOsNotifications } from '../lib/push';
import { setBadge } from '../lib/badge';
import { createNotificationSettings, type NotificationSettingsState } from '../lib/notificationSettings';
import { currentInboxRevision, isUnreadAttention, mergeAttentionPatch, patchedUnreadCount, unreadSessionCount } from '../lib/inboxProjection';
import { describeReason, reportUxError } from '../lib/errorReporter';

// Is the tab in the foreground? Used to decide whether opening/holding a session
// counts as "seeing" its raised attention (it does only when visible).
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
  // Notification permission state (per-device, GLOBAL — one grant covers all
  // sessions; never per-session). `notifSupported` is false outside an installed
  // PWA on iOS, where Web Push is unavailable.
  notifPermission: NotificationPermission;
  notifSupported: boolean;
  notifReady: boolean;
  notifications: NotificationSettingsState;
  unreadCount: number;
  inboxRevision?: number;
  // lifecycle
  init: () => () => void;
  // intents
  setActiveId: (id: string | null) => void;
  observeAttention: (sessionId: string, attnId: number, visible: boolean) => void;
  newSession: (cwd: string) => Promise<string>;
  consumerIntent: <K extends Extract<IntentName, `system/consumer/${string}`>>
    (name: K, body: IntentBody<K>, signal?: AbortSignal) => Promise<IntentResult<K>>;
  forkSession: (sessionId: string) => Promise<string>;
  loadMore: (sessionId: string) => void;
  retryHistory: (sessionId: string) => void;
  sendPrompt: (sessionId: string, text: string, attachment?: Attachment, attachments?: Attachment[]) => Promise<boolean>;
  filesList: (body: IntentBody<'files/list'>, signal?: AbortSignal) => Promise<IntentResult<'files/list'>>;
  filesGet: (url: string, signal?: AbortSignal) => Promise<IntentResult<'files/get'>>;
  cancel: (sessionId: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<{ ok: true; interrupted: boolean }>;
  setModel: (sessionId: string, modelId: string, opts?: { reasoningEffort?: string; contextTier?: 'default' | 'long_context' }) => Promise<void>;
  deleteSession: (sessionId: string, confirm: true) => Promise<void>;
  unloadSession: (sessionId: string) => Promise<void>;
  reloadSession: (sessionId: string) => Promise<void>;
  pinSession: (sessionId: string, pinned: boolean) => Promise<void>;
  compactSession: (sessionId: string) => Promise<void>;
  rewindSession: (sessionId: string, toMsgId: string, rollbackFiles?: boolean) => Promise<void>;
  setMode: (sessionId: string, mode: 'interactive' | 'plan' | 'autopilot') => Promise<void>;
  getPlan: (sessionId: string) => Promise<import('./types').SessionPlan>;
  getUsage: (sessionId: string, signal?: AbortSignal) => Promise<IntentResult<'session/usage'>>;
  getPanels: (sessionId: string) => Promise<import('./types').SessionPanels>;
  getPanel: (sessionId: string, section: PanelSection, signal?: AbortSignal) => Promise<PanelItem[]>;
  getResources: (sessionId: string, resources: MetaResource[], signal?: AbortSignal) => Promise<SessionProjection>;
  scheduleList: (sessionId: string) => Promise<import('@cockpit/protocol').ScheduleEntry[]>;
  scheduleAdd: (sessionId: string, input: Omit<IntentBody<'schedule/add'>, 'sessionId'>) => Promise<IntentResult<'schedule/add'>>;
  scheduleStop: (sessionId: string, id: number) => Promise<IntentResult<'schedule/stop'>>;
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
  // Mint a short-lived Azure Speech token (key stays server-side). enabled:false
  // means no Azure resource is configured → voice falls back to the Web Speech API.
  speechToken: () => Promise<{ enabled: boolean; token?: string; region?: string }>;
  // Request notification permission + subscribe to push. MUST be called from a
  // user gesture (iOS only honors a gesture-initiated permission request — calling
  // it on load/snapshot silently fails, which is why notifications never armed).
  enableNotifications: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  disableNotifications: () => Promise<void>;
  testNotifications: (confirm: true) => Promise<void>;
}

export const createCockpitStore = () => create<CockpitState>((set, get) => {
  let client: NetClient | null = null;
  const notifications = createNotificationSettings((state) => set({
    notifications: state, notifReady: state.ready,
    notifPermission: state.permission, notifSupported: state.supported,
  }));
  const seenRequests = new Map<string, number>();
  const summaryResources: MetaResource[] = ['identity', 'control', 'model', 'mode', 'schedule'];
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
          const attention = full && existing ? mergeAttentionPatch(existing, full) : full;
          const sessions = full
            ? existing ? st.sessions.map(s => s.sessionId === sessionId
              ? metaToSession({ ...full,
                ...(full.error === undefined && s.error !== undefined ? { error: s.error } : {}),
                ...(full.autoNameError === undefined && s.autoNameError !== undefined ? { autoNameError: s.autoNameError } : {}),
                ...(full.loaded && full.compacting === undefined && s.compacting !== undefined ? { compacting: s.compacting } : {}),
                ...(full.loaded && full.intent === undefined && s.intent !== undefined ? { intent: s.intent } : {}),
                attention: attention!.attention,
                attnId: attention!.attnId, seenId: attention!.seenId }, s) : s) : [metaToSession(full), ...st.sessions]
            : st.sessions.filter(s => s.sessionId !== sessionId);
          return { sessions, unreadCount: patchedUnreadCount(st.unreadCount, st.sessions, sessions) };
        });
        if (sessionId === get().activeId && wasLoaded !== meta?.loaded) {
          if (!meta?.loaded) cancelLive(sessionId);
          maybeMaterialize();
        }
        seenActiveIfVisible();
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
  let observedAttention: { sessionId: string; attnId: number } | null = null;
  let historyRequest: { sessionId: string; generation: number; controller: AbortController } | null = null;
  let liveRequest: { sessionId: string; controller: AbortController } | null = null;
  let liveSessionId: string | null = null;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const windows = new Map<string, NativeWindow>();
  const mutationRequests = new Map<string, { released: boolean }>();
  const historyRecoveryErrors = new Map<string, string>();
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
      mutationRequests.delete(id);
      historyRecoveryErrors.delete(id);
      seenRequests.delete(id);
      if (observedAttention?.sessionId === id) observedAttention = null;
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
    changesHistory = false,
  ): Promise<void> => {
    const generation = get().connectionGeneration;
    const origin = sid ? `会话 ${get().sessions.find((s) => s.sessionId === sid)?.title ?? sid} (${sid})：` : '';
    let reportedByTransport = false;
    const request = { released: false };
    if (changesHistory && sid) {
      cancelHistory(sid);
      historyRecoveryErrors.delete(sid);
      mutationRequests.set(sid, request);
      cancelLive(sid);
    }
    const current = () => generation === get().connectionGeneration
      && (!changesHistory || mutationRequests.get(sid!) === request);
    const promise = (async () => {
      const result = await send(connectedClient()).catch((error) => {
        reportedByTransport = !isSessionUnloadedError(error);
        throw error;
      });
      if (!result.ok || result.applied === false) throw new Error(result.error || '服务器未确认操作');
      if (changesHistory && sid && current()) {
        mutationRequests.delete(sid);
        windows.get(sid)?.invalidate();
        patchLocal(sid, s => ({ ...invalidateWindow(s), error: '原生历史已变更；当前画面已保留，请重新同步。' }));
      }
    })();
    void promise.catch((error) => {
      const message = `${origin}${operation}失败：${describeReason(error, false)}`;
      // HTTP/transport/schema errors have one request-owned global notice.
      // Offline and negative acknowledgements originate here instead.
      if (!reportedByTransport) reportUxError(message, { deduplicate: false });
      if (sid && get().sessions.some(s => s.sessionId === sid)
        && generation === get().connectionGeneration && (current() || request.released)) {
        const owns = current();
        if (changesHistory) {
          if (owns) mutationRequests.delete(sid);
          historyRecoveryErrors.set(sid, message);
        }
        patchLocal(sid, (s) => ({ ...s, error: message, ...(changesHistory && owns ? { loadingHistory: false } : {}) }));
        if (changesHistory && owns && get().activeId === sid) maybeMaterialize();
      }
    });
    return promise;
  };

  const scheduleMutation = <T extends { ok: boolean; error?: string },>(
    sid: string, fallback: string, send: (net: NetClient) => Promise<T>,
  ): Promise<T> => {
    const generation = get().connectionGeneration;
    const origin = `会话 ${get().sessions.find((s) => s.sessionId === sid)?.title ?? sid} (${sid})`;
    let reportedByTransport = false;
    const promise = read(net => send(net).catch((error) => {
      reportedByTransport = !isSessionUnloadedError(error);
      throw error;
    })).then((result) => {
      if (!result.ok) throw new Error(result.error?.trim() ? result.error : fallback);
      return result;
    });
    void promise.catch((error) => {
      const message = `${origin}：计划任务操作失败：${describeReason(error, false)}`;
      if (!reportedByTransport) reportUxError(message, { deduplicate: false });
      if (generation === get().connectionGeneration) patchLocal(sid, (s) => ({ ...s, error: message }));
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

  // Tell the server "I'm looking at the active session now" when the tab is in the
  // foreground and that session actually has attention raised. The server then
  // clears a 'ready' on sight and demotes a 'choice'. Guarded so we never POST when
  // there's nothing to see; markSeen is idempotent server-side anyway.
  const seenActiveIfVisible = () => {
    if (!isVisible() || !client?.isOpen || !snapshotReady) return;
    const { activeId, sessions } = get();
    if (!activeId) return;
    const s = sessions.find((x) => x.sessionId === activeId);
    if (!s || !isUnreadAttention(s)) return;
    const observed = s.attnId ?? 0;
    if (observedAttention?.sessionId !== activeId || observedAttention.attnId !== observed) return;
    if (s.attention === 'ready' && (!s.materialized || s.historyStale || !s.messages.length)) return;
    if (seenRequests.get(activeId) === observed) return;
    const generation = get().connectionGeneration;
    seenRequests.set(activeId, observed);
    void client.inboxSeen(activeId, observed).finally(() => {
      if (generation === get().connectionGeneration && seenRequests.get(activeId) === observed) {
        seenRequests.delete(activeId);
      }
    }).catch(() => {});
  };

  const syncInbox = (removed: readonly string[] = [], removalRevision?: number, completeSnapshot = false) => {
    if (!snapshotReady) return;
    const state = get();
    void setBadge(state.unreadCount, state.inboxRevision, state.sessions, {
      removedSessions: removed, removalRevision, completeSnapshot,
    });
    void clearOsNotifications(state.sessions, removed);
  };

  // Fire the OS/browser notification for a session whose attention the Engine just
  // raised. The kind/body come from the authoritative `session/notify` event — the
  // client never decides *whether* a session needs attention, only renders the
  // alert (and only while hidden, handled inside notify()). Clicking focuses the
  // app and opens that session. Tag is keyed by session so an escalation
  // (ready → choice) replaces the session's banner instead of stacking.
  const fireAttention = (
    sessionId: string, title: string, kind: 'ready' | 'choice', body: string,
    attnId?: number, inboxRevision?: number,
  ) =>
    notify({
      title,
      body,
      kind,
      tag: sessionId,
      sessionId,
      attnId,
      inboxRevision,
      onClick: () => window.dispatchEvent(new CustomEvent('cockpit:open-session', { detail: { sessionId } })),
    });

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
      || get().activeId !== sid || !snapshotReady || get().connState !== 'open' || mutationRequests.has(sid)) return;
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
        error: s.error === historyRecoveryErrors.get(sid) || (s.error && s.error !== errorAtStart) ? s.error : null,
      }));
      historyRequest = null;
      historyRecoveryErrors.delete(sid);
      streamLive(sid);
    }).catch((error) => {
      if (!current()) return;
      historyRequest = null;
      patchLocal(sid, (s) => ({
        ...s, loadingHistory: false, historyStale: window.invalid,
        historyError: describeReason(error, false),
        ...(s.error !== historyRecoveryErrors.get(sid) ? { error: `加载失败：${describeReason(error, false)}` } : {}),
      }));
    });
  };

  const maybeMaterialize = () => {
    const { activeId, connState, sessions } = get();
    if (!snapshotReady || !activeId || connState !== 'open' || !client || !isVisible()) return;
    const s = sessions.find((x) => x.sessionId === activeId);
    const window = windows.get(activeId);
    if (!s || window?.invalid || s.loadingHistory || mutationRequests.has(activeId)) return;
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
    mutationRequests.clear();
    historyRecoveryErrors.clear();
    nativeReadRefresh = null;
    seenRequests.clear();
    notifications.disconnect();
    set((st) => ({
      connectionGeneration: st.connectionGeneration + 1,
      sessions: st.sessions.map(s => ({ ...s, loadingHistory: false })),
      notifReady: false,
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
          return { sessions, unreadCount: ev.unreadCount ?? unreadSessionCount(sessions), inboxRevision: ev.inboxRevision };
        });
        if (typeof window !== 'undefined' && get().connState === 'open' && client) notifications.connect(client);
        syncInbox([], ev.inboxRevision, true);
        const active = get().sessions.find(s => s.sessionId === get().activeId);
        if (active?.loaded && active.queue === undefined) refreshMeta(active.sessionId, ['queue']);
        maybeMaterialize();
        // If we (re)connected straight into a session that already has attention
        // raised and the tab is in front, that counts as seeing it — clears a
        // 'ready' on cold deep-link, demotes a seen 'choice'.
        seenActiveIfVisible();
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
          return { sessions, unreadCount: patchedUnreadCount(st.unreadCount, st.sessions, sessions) };
        });
        syncInbox();
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
          const current = currentInboxRevision(st.inboxRevision, ev.inboxRevision);
          return {
            sessions,
            inboxRevision: current ? ev.inboxRevision ?? st.inboxRevision : st.inboxRevision,
            unreadCount: current && ev.unreadCount !== undefined ? ev.unreadCount
              : patchedUnreadCount(st.unreadCount, st.sessions, sessions),
          };
        });
        syncInbox([ev.sessionId], ev.inboxRevision);
        return;
      case 'session/patch': {
        const activeId = get().activeId;
        const { type, inboxRevision, unreadCount, ...patch } = ev;
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
              return metaToSession(mergeAttentionPatch({
                sessionId: s.sessionId, title: s.title, cwd: s.cwd, createdAt: s.createdAt,
                lastActivity: s.lastActivity, lastActivitySource: s.lastActivitySource,
                pinned: s.pinned, attention: s.attention, attnId: s.attnId, seenId: s.seenId,
                loaded: false, status: 'unloaded', ask: null,
              }, patch), s);
            }
            return mergeAttentionPatch(s, patch);
          });
          const current = currentInboxRevision(st.inboxRevision, inboxRevision);
          return {
            sessions,
            inboxRevision: current ? inboxRevision ?? st.inboxRevision : st.inboxRevision,
            unreadCount: current && unreadCount !== undefined ? unreadCount
              : patchedUnreadCount(st.unreadCount, st.sessions, sessions),
          };
        });
        if ('attention' in ev || 'attnId' in ev || 'seenId' in ev) syncInbox();
        // The sidebar dot + app-icon badge derive purely from the server's
        // attention/attnId/seenId we just merged — there is no per-device flag to
        // set, so a missed-while-offline raise or a remote handle can't leave a
        // stale dot. But if attention was just raised on the session you're already
        // looking at (tab visible), that IS seeing it: tell the server so a 'ready'
        // clears on sight and a 'choice' demotes. When hidden we leave it raised so
        // the OS notification (session/notify) still fires.
        if ((ev.attention != null || ev.attnId !== undefined) && ev.sessionId === activeId) seenActiveIfVisible();
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
      case 'session/notify': {
        const state = get();
        const row = state.sessions.find((s) => s.sessionId === ev.sessionId);
        if (!currentInboxRevision(state.inboxRevision, ev.inboxRevision)
          || (ev.attnId !== undefined && row
            && (ev.attnId < (row.attnId ?? 0) || ev.attnId <= (row.seenId ?? 0)))) return;
        set((st) => {
          // A versioned notify can precede its metadata patch. Project the
          // observed waterline now so that patch cannot double-count it later.
          const sessions = st.sessions.map((s) =>
            s.sessionId === ev.sessionId && ev.attnId !== undefined && ev.attnId > (s.attnId ?? 0)
              ? mergeAttentionPatch(s, { attention: ev.attention, attnId: ev.attnId }) : s);
          return {
            sessions, inboxRevision: ev.inboxRevision ?? st.inboxRevision,
            unreadCount: ev.unreadCount ?? patchedUnreadCount(st.unreadCount, st.sessions, sessions),
          };
        });
        syncInbox();
        if (!get().notifications.disabled && !get().notifications.deliveryOwned) {
          fireAttention(ev.sessionId, ev.title, ev.attention, ev.body, ev.attnId, ev.inboxRevision);
        }
        seenActiveIfVisible();
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
      if (typeof window !== 'undefined' && client) notifications.connect(client);
      syncInbox();
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
    notifPermission: notifications.state().permission,
    notifSupported: notifications.state().supported,
    notifReady: false,
    notifications: notifications.state(),
    unreadCount: 0,
    inboxRevision: undefined,

    init() {
      client?.disconnect();
      const net = new NetClient({ onEvent, onStateChange, sessionTitle: sid => get().sessions.find(s => s.sessionId === sid)?.title });
      client = net;
      net.connect();
      // Bringing the tab to the front counts as seeing the active session's raised
      // attention (clears a 'ready', demotes a 'choice') — covers "alert arrived
      // while I was on this session but had it backgrounded, then I came back".
      const onVisible = () => {
        if (isVisible()) { seenActiveIfVisible(); syncInbox(); maybeMaterialize(); }
        else { cancelHistory(); cancelLive(); }
      };
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') window.addEventListener('online', onVisible);
      // One-time cleanup: pin is now backend-authoritative (session/pin), so the
      // legacy per-device localStorage pin list is obsolete — drop it if present.
      try { localStorage.removeItem('cockpit:pinned'); } catch { /* ignore */ }
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

    enableNotifications: notifications.enable,
    refreshNotifications: notifications.refresh,
    disableNotifications: notifications.disable,
    testNotifications: notifications.sendTest,

    setActiveId(id) {
      const previous = get().activeId;
      if (id !== previous) {
        observedAttention = null;
        cancelHistory();
        cancelLive();
        if (previous) {
          const mutation = mutationRequests.get(previous);
          if (mutation) mutation.released = true;
          mutationRequests.delete(previous);
          historyRecoveryErrors.delete(previous);
          seenRequests.delete(previous);
        }
        set({ activeId: id });
        const active = get().sessions.find(s => s.sessionId === id);
        if (active?.loaded && active.queue === undefined && snapshotReady) refreshMeta(active.sessionId, ['queue']);
      }
      if (id) seenActiveIfVisible();
      maybeMaterialize();
    },
    observeAttention(sessionId, attnId, visible) {
      if (sessionId !== get().activeId) return;
      if (visible) observedAttention = { sessionId, attnId };
      else if (observedAttention?.sessionId === sessionId && observedAttention.attnId === attnId) observedAttention = null;
      if (visible) seenActiveIfVisible();
    },

    consumerIntent(name, body, signal) { return read(net => net.intent(name, body, signal)); },
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

    forkSession(sessionId) {
      return read(net => net.forkSession(sessionId)).then(result => result.sessionId);
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
      if (!s || s.loadingHistory || mutationRequests.has(sid)) return;
      if (s.historyError && !s.historyStale) {
        requestHistory(sid, !!windows.get(sid)?.older);
        return;
      }
      cancelLive(sid);
      if (s.historyStale || !windows.get(sid)?.materialized) windows.set(sid, new NativeWindow(undefined, true));
      if (windows.get(sid)?.live && !s.historyStale) streamLive(sid);
      else requestHistory(sid);
    },

    sendPrompt(sid, text, attachment, attachments) {
      return acknowledged(sid, (net) => net.prompt(sid, text, attachment, undefined, attachments));
    },
    filesList(body, signal) { return read(net => net.intent('files/list', body, signal)); },
    filesGet(url, signal) { return read(net => net.intent('files/get', { url }, signal)); },

    cancel(sid) { return mutation(sid, '取消', (net) => net.cancel(sid)); },
    interrupt(sid) { return nativeRead(sid, (net) => net.interrupt(sid)); },
    setModel(sid, modelId, opts) { return mutation(sid, '切换模型', (net) => net.setModel(sid, modelId, opts)); },
    deleteSession(sid, confirm) { return mutation(sid, '永久删除会话', (net) => net.deleteSession(sid, confirm)); },
    unloadSession(sid) { return mutation(sid, '卸载会话', (net) => net.unloadSession(sid)); },
    reloadSession(sid) { return mutation(sid, '重载会话', (net) => net.reloadSession(sid)); },
    pinSession(sid, pinned) { return mutation(sid, '置顶会话', (net) => net.pinSession(sid, pinned)); },
    compactSession(sid) { return mutation(sid, '压缩会话', (net) => net.compactSession(sid)); },
    rewindSession(sid, toMsgId, rollbackFiles) {
      return mutation(sid, '回退会话', (net) => net.rewindSession(sid, toMsgId, rollbackFiles), true);
    },
    setMode(sid, mode) { return mutation(sid, '切换模式', (net) => net.setMode(sid, mode)); },
    respondAsk(sid, requestId, answer, wasFreeform) { return acknowledged(sid, (net) => net.respondAsk(sid, requestId, answer, wasFreeform)); },
    respondPlan(sid, requestId, action) { return acknowledged(sid, (net) => net.respondPlan(sid, requestId, action)); },
    planSupersede(sid, requestId, message) { return acknowledged(sid, (net) => net.planSupersede(sid, requestId, message)); },
    respondElicitation(sid, requestId, action) { return acknowledged(sid, (net) => net.respondElicitation(sid, requestId, action)); },
    removeQueued(sid, itemId) { return mutation(sid, '移除排队消息', (net) => net.removeQueued(sid, itemId)); },
    refreshList() { return mutation(null, '刷新会话列表', (net) => net.refresh()); },
    getPlan(sid) { return nativeRead(sid, (net) => net.getPlan(sid)); },
    getUsage(sid, signal) { return nativeRead(sid, (net) => net.getUsage(sid, signal)); },
    getPanels(sid) { return nativeRead(sid, (net) => net.getPanels(sid)); },
    getPanel(sid, section, signal) { return nativeRead(sid, net => net.intent('session/panel', { sessionId: sid, section }, signal)).then(r => r.items); },
    getResources(sid, resources, signal) {
      return nativeRead(sid, net => net.getResources(sid, resources, signal)).then(({ meta }) => {
        if (!meta?.loaded) throw new SessionUnloadedError();
        return meta;
      });
    },
    scheduleList(sid) { return nativeRead(sid, (net) => net.scheduleList(sid)).then((r) => r.entries); },
    scheduleAdd(sid, input) { return scheduleMutation(sid, '未能添加定时任务，请核对后再试。', (net) => net.scheduleAdd(sid, input)); },
    scheduleStop(sid, id) { return scheduleMutation(sid, '未能停止定时任务，请刷新列表后核对。', (net) => net.scheduleStop(sid, id)); },
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

    speechToken() {
      return read((net) => net.speechToken());
    },
  };
});

export const useCockpit = createCockpitStore();
