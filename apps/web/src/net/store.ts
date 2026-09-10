// Pure-projection store (Zustand). The cockpit server is the SINGLE owner of
// all session state; this store holds NO domain logic. It mirrors the server's
// SSE event stream and sends intents back via POST. Always-YOLO: the server
// auto-approves permissions, so there is no permission UI here.
//
// Migrated from a Context+useState store to Zustand: the projection logic is
// unchanged; only the state container differs. The single client lifecycle is
// driven by `init()` (called once from <App> in an effect).
//
// Client-local state (per-device, not server truth): browser notification
// plumbing and per-session unsent drafts (localStorage). The "needs you" signal
// (sidebar dot + app-icon badge) is NOT client-local — it derives purely from the
// server's attention/attnId/seenId, so it can never drift between devices.

import { create } from 'zustand';
import { isSessionUnloadedError, NetClient, SessionUnloadedError } from './client';
import type { ConnState } from './client';
import type {
  AgentStatus, Attachment, ChatMessage, ChatSession, ModelOption, ServerEvent,
} from './types';
import type { IntentBody, IntentResult } from '@cockpit/protocol';
import { applyHistoryPage, applyResumedHistory, HISTORY_PAGE, HistoryRangeError, invalidateWindow, metaToSession, releaseWindow, retainLatestWindow } from './sessionWindow';
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
  forkSession: (sessionId: string) => Promise<string>;
  loadMore: (sessionId: string) => void;
  retryHistory: (sessionId: string) => void;
  subagentHistory: (sessionId: string, toolCallId: string,
    opts?: { beforeMsgId?: string; afterMsgId?: string; limit?: number },
    signal?: AbortSignal) => Promise<import('@cockpit/protocol').SubagentHistoryPage>;
  sendPrompt: (sessionId: string, text: string, attachment?: Attachment, attachments?: Attachment[]) => Promise<boolean>;
  filesList: (body: IntentBody<'files/list'>, signal?: AbortSignal) => Promise<IntentResult<'files/list'>>;
  filesGet: (url: string, signal?: AbortSignal) => Promise<IntentResult<'files/get'>>;
  retainToolImage: (body: IntentBody<'files/from-tool-image'>) => Promise<IntentResult<'files/from-tool-image'>>;
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
  // Read-only, paginated preview of a TRASHED session (rendered as a non-interactive
  // Thread). `preview` is a synthetic ChatSession kept OUT of `sessions` so it never
  // appears in the sidebar; pagination reads from disk via the `session/peek` intent.
  preview: ChatSession | null;
  openPreview: (sessionId: string) => void;
  refreshPreview: (sessionId: string) => void;
  retryPreview: (expected: ChatSession) => void;
  loadMorePreview: () => void;
  closePreview: () => void;
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
  const metaRequests = new Map<string, { dirty: boolean; controller: AbortController }>();
  const refreshMeta = (sessionId: string) => {
    const session = get().sessions.find(row => row.sessionId === sessionId);
    // A closing transition refuses new native reads. Its settling event will
    // invalidate again; keep the current frontend view in the meantime.
    if (session?.closing) return;
    const pending = metaRequests.get(sessionId);
    if (pending) { pending.dirty = true; return; }
    const request = { dirty: true, controller: new AbortController() };
    const net = client;
    const generation = get().connectionGeneration;
    if (!net?.isOpen) return;
    metaRequests.set(sessionId, request);
    void Promise.resolve().then(async () => {
      do {
        request.dirty = false;
        const { meta } = await net.getSession(sessionId, request.controller.signal);
        if (client !== net || get().connectionGeneration !== generation || metaRequests.get(sessionId) !== request) return;
        if (request.dirty) continue;
        set(st => {
          const existing = st.sessions.find(s => s.sessionId === sessionId);
          const attention = meta && existing ? mergeAttentionPatch(existing, meta) : meta;
          const sessions = meta
            ? existing ? st.sessions.map(s => s.sessionId === sessionId
              ? metaToSession({ ...meta,
                ...(meta.error === undefined && s.error !== undefined ? { error: s.error } : {}),
                ...(meta.autoNameError === undefined && s.autoNameError !== undefined ? { autoNameError: s.autoNameError } : {}),
                attention: attention!.attention,
                attnId: attention!.attnId, seenId: attention!.seenId }, s) : s) : [metaToSession(meta), ...st.sessions]
            : st.sessions.filter(s => s.sessionId !== sessionId);
          return { sessions, unreadCount: patchedUnreadCount(st.unreadCount, st.sessions, sessions) };
        });
        seenActiveIfVisible();
      } while (request.dirty);
    }).catch(error => {
      if (!request.controller.signal.aborted && client === net && get().connectionGeneration === generation) {
        reportUxError('读取会话状态失败', error);
      }
    }).finally(() => {
      if (metaRequests.get(sessionId) !== request) return;
      metaRequests.delete(sessionId);
      if (request.dirty && !request.controller.signal.aborted && client === net && get().connectionGeneration === generation) {
        refreshMeta(sessionId);
      }
    });
  };
  const patchLocal = (sid: string, fn: (s: ChatSession) => ChatSession) =>
    set((st) => ({ sessions: st.sessions.map((s) => (s.sessionId === sid ? fn(s) : s)) }));
  let snapshotReady = false;
  let observedAttention: { sessionId: string; attnId: number } | null = null;
  let historyRequest: { sessionId: string; generation: number; streamed: Map<string, ChatMessage>; controller: AbortController } | null = null;
  const mutationRequests = new Map<string, { released: boolean }>();
  const historyRecoveryErrors = new Map<string, string>();
  let recentWindows: string[] = [];
  const visitWindow = (sid: string) => {
    recentWindows = [...recentWindows.filter(id => id !== sid), sid];
    const evicted = recentWindows.splice(0, Math.max(0, recentWindows.length - 3));
    if (evicted.length) set(st => ({
      sessions: st.sessions.map(s => evicted.includes(s.sessionId) ? releaseWindow(s) : s),
    }));
  };
  let previewRequest: AbortController | null = null;
  let nativeReadRefresh: { pending: boolean } | null = null;
  const cancelHistory = (sid?: string) => {
    if (!historyRequest || (sid !== undefined && historyRequest.sessionId !== sid)) return;
    const request = historyRequest;
    historyRequest = null;
    request.streamed.clear();
    request.controller.abort();
  };
  const cancelPreview = () => {
    const request = previewRequest;
    previewRequest = null;
    request?.abort();
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
      patchLocal(sid, (s) => ({ ...invalidateWindow(s), liveMessageIds: undefined, loadingHistory: get().activeId === sid }));
      if (get().preview?.sessionId === sid) {
        cancelPreview();
        set((st) => ({ preview: st.preview ? invalidateWindow(st.preview) : null }));
      }
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
        patchLocal(sid, (s) => ({ ...s, loadingHistory: false }));
        maybeMaterialize();
      }
    })();
    void promise.catch((error) => {
      const message = `${origin}${operation}失败：${describeReason(error, false)}`;
      // HTTP/transport/schema errors have one request-owned global notice.
      // Offline and negative acknowledgements originate here instead.
      if (!reportedByTransport) reportUxError(message, { deduplicate: false });
      if (sid && generation === get().connectionGeneration && (current() || request.released)) {
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

  const requestHistory = (sid: string, opts: NonNullable<Parameters<NetClient['history']>[1]>) => {
    if (get().activeId !== sid) return;
    cancelHistory();
    const request = { sessionId: sid, generation: get().connectionGeneration,
      streamed: new Map<string, ChatMessage>(), controller: new AbortController() };
    historyRequest = request;
    const initial = get().sessions.find((s) => s.sessionId === sid);
    const errorAtStart = initial?.error;
    patchLocal(sid, (s) => ({ ...s, loadingHistory: true }));
    const current = () => historyRequest === request && get().activeId === sid
      && request.generation === get().connectionGeneration;
    void read(async (net) => {
      let page = await net.history(sid, opts, request.controller.signal);
      const staged: ChatMessage[] = [];
      let token = opts.resume?.token;
      while (opts.resume && current()) {
        if (page.sessionId !== sid) throw new Error('History sessionId mismatch');
        if (!page.resume) throw new Error('History response is missing explicit resume status');
        if (page.resume.status === 'unavailable') break;
        staged.push(...page.messages);
        if (page.resume.status === 'ready') { page = { ...page, messages: staged }; break; }
        if (page.resume.token === token) throw new Error('History continuation did not advance');
        token = page.resume.token;
        page = await net.history(sid, { resume: { token }, limit: HISTORY_PAGE }, request.controller.signal);
      }
      return page;
    }).then((page) => {
      if (!current()) return;
      if (page.sessionId !== sid) throw new Error('History sessionId mismatch');
      if (page.resume?.status === 'unavailable') {
        throw new HistoryRangeError('历史同步中断，请重新读取最新历史');
      }
      if (!opts.resume && page.append && (!opts.afterMsgId || !page.messages.some((m) => m.id === opts.afterMsgId))) {
        throw new Error('History response is missing the requested cursor');
      }
      patchLocal(sid, (s) => ({
        ...(opts.resume?.token ? applyResumedHistory(s, page, request.streamed) : applyHistoryPage(s, {
          ...page,
          // An absent cursor returns a replacement, never a mutation SSE broadcast.
          latest: page.latest || (!opts.beforeMsgId && !page.append),
        }, request.streamed)),
        // Recovering history does not make the rejected mutation successful.
        ...(s.error === historyRecoveryErrors.get(sid) || (s.error && s.error !== errorAtStart) ? { error: s.error } : {}),
      }));
      historyRequest = null;
      historyRecoveryErrors.delete(sid);
    }).catch((error) => {
      if (!current()) return;
      historyRequest = null;
      const raw = describeReason(error, false);
      const message = /corrupt/i.test(raw) ? '会话文件有损坏行(可能写入时被中断),稍后重试或联系维护' : `加载失败: ${raw}`;
      patchLocal(sid, (s) => ({
        ...s, loadingHistory: false,
        ...(error instanceof HistoryRangeError && { resumeToken: undefined, resumeAfter: undefined, liveMessageIds: undefined }),
        // Retain a failed mutation's diagnostic through history retries, too.
        ...(s.error !== historyRecoveryErrors.get(sid) ? { error: message } : {}),
      }));
    });
  };

  // Only the still-mounted reading window uses continuation on reconnect.
  // Departed windows discard that checkpoint and always fetch a fresh latest page.
  const maybeMaterialize = () => {
    const { activeId, connState, sessions } = get();
    if (!snapshotReady || !activeId || connState !== 'open' || !client) return;
    const s = sessions.find((x) => x.sessionId === activeId);
    if (!s) return;
    if (!recentWindows.includes(activeId)) visitWindow(activeId);
    if ((!s.historyStale && s.materialized) || s.loadingHistory || mutationRequests.has(activeId)) return;
    requestHistory(activeId, { resume: { token: s.resumeToken }, limit: HISTORY_PAGE });
  };

  const requestPreview = (sid: string, beforeMsgId?: string) => {
    cancelPreview();
    const request = new AbortController();
    const generation = get().connectionGeneration;
    previewRequest = request;
    set((st) => ({ preview: st.preview ? {
      ...(beforeMsgId ? st.preview : { ...invalidateWindow(st.preview), error: null }),
      loadingHistory: true,
    } : null }));
    const current = () => previewRequest === request && generation === get().connectionGeneration
      && get().preview?.sessionId === sid;
    void read((net) => net.peek(sid, { ...(beforeMsgId ? { beforeMsgId } : {}), limit: HISTORY_PAGE }, request.signal)).then((page) => {
      if (!current()) return;
      if (page.sessionId !== sid) throw new Error('Preview sessionId mismatch');
      set((st) => ({ preview: st.preview ? {
        ...applyHistoryPage(st.preview, { ...page, latest: !beforeMsgId }),
        title: page.title || st.preview.title, cwd: page.cwd, error: null,
      } : null }));
      previewRequest = null;
    }).catch((error) => {
      if (!current()) return;
      previewRequest = null;
      set((st) => ({ preview: st.preview ? {
        ...st.preview, loadingHistory: false, error: `预览加载失败：${describeReason(error, false)}`,
      } : null }));
    });
  };

  const invalidateRequests = (discardLive = false) => {
    for (const request of metaRequests.values()) request.controller.abort();
    metaRequests.clear();
    snapshotReady = false;
    cancelHistory();
    mutationRequests.clear();
    historyRecoveryErrors.clear();
    cancelPreview();
    nativeReadRefresh = null;
    seenRequests.clear();
    notifications.disconnect();
    set((st) => ({
      connectionGeneration: st.connectionGeneration + 1,
      sessions: st.sessions.map(s => invalidateWindow(discardLive ? { ...s, liveMessageIds: undefined } : s)),
      preview: st.preview ? { ...invalidateWindow(st.preview), error: null } : null,
      notifReady: false,
    }));
  };

  const onEvent = (ev: ServerEvent) => {
    switch (ev.type) {
      case 'snapshot': {
        invalidateRequests();
        snapshotReady = true;
        set({ agentStatus: ev.agentStatus, permissionPolicy: ev.permissionPolicy, globalModels: ev.models });
        set((st) => {
          const byId = new Map(st.sessions.map((s) => [s.sessionId, s]));
          const sessions = ev.sessions.map((m) => invalidateWindow(metaToSession(m, byId.get(m.sessionId))));
          return { sessions, unreadCount: ev.unreadCount ?? unreadSessionCount(sessions), inboxRevision: ev.inboxRevision };
        });
        if (typeof window !== 'undefined' && get().connState === 'open' && client) notifications.connect(client);
        syncInbox([], ev.inboxRevision, true);
        maybeMaterialize();
        const preview = get().preview;
        if (preview && get().connState === 'open') requestPreview(preview.sessionId);
        // If we (re)connected straight into a session that already has attention
        // raised and the tab is in front, that counts as seeing it — clears a
        // 'ready' on cold deep-link, demotes a seen 'choice'.
        seenActiveIfVisible();
        return;
      }
      case 'agent/status':
        set({ agentStatus: ev.status });
        return;
      case 'session/invalidated':
        refreshMeta(ev.sessionId);
        return;
      case 'session/added':
        set((st) => {
          if (st.sessions.some((s) => s.sessionId === ev.session.sessionId)) return st;
          const sessions = [metaToSession(ev.session), ...st.sessions];
          return { sessions, unreadCount: patchedUnreadCount(st.unreadCount, st.sessions, sessions) };
        });
        syncInbox();
        maybeMaterialize();
        return;
      case 'session/removed':
        metaRequests.get(ev.sessionId)?.controller.abort();
        metaRequests.delete(ev.sessionId);
        // Drop the row. We deliberately DON'T clear activeId here: the URL is the
        // source of truth for what's focused, so a remote delete just makes the
        // active session vanish from `sessions`, and the page derives a NotFound
        // pane from (routeId set, no matching session). A LOCAL delete navigates
        // back to the list itself (App.doDelete), so it never hits NotFound.
        cancelHistory(ev.sessionId);
        mutationRequests.delete(ev.sessionId);
        historyRecoveryErrors.delete(ev.sessionId);
        recentWindows = recentWindows.filter(id => id !== ev.sessionId);
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
        set((st) => {
          const sessions = st.sessions.map((s) => {
            if (s.sessionId !== ev.sessionId) return s;
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
        return;
      }
      case 'session/reset': {
        const p = ev.page;
        cancelHistory(p.sessionId);
        mutationRequests.delete(p.sessionId);
        historyRecoveryErrors.delete(p.sessionId);
        set((st) => ({
          sessions: st.sessions.map((s) => s.sessionId !== p.sessionId ? s
            : st.activeId !== p.sessionId ? releaseWindow(s)
              : applyHistoryPage({ ...s, liveMessageIds: undefined }, { ...p, latest: true, append: false })),
        }));
        if (get().preview?.sessionId === p.sessionId) {
          cancelPreview();
          set((st) => ({ preview: st.preview ? { ...applyHistoryPage(st.preview, { ...p, latest: true, append: false }), error: null } : null }));
        }
        return;
      }
      case 'msg/upsert': {
        if (historyRequest?.sessionId === ev.sessionId) historyRequest.streamed.set(ev.message.id, ev.message);
        set((st) => ({
          sessions: st.sessions.map((s) => {
            if (s.sessionId !== ev.sessionId) return s;
            if (st.activeId !== ev.sessionId) return s.materialized ? invalidateWindow(s) : s;
            if (!s.materialized && !s.loadingHistory && s.messages.length === 0) return s;
            const idx = s.messages.findIndex((m) => m.id === ev.message.id);
            let messages: ChatMessage[];
            if (idx >= 0) { messages = s.messages.slice(); messages[idx] = ev.message; }
            else messages = [...s.messages, ev.message];
            // Pure projection: we do NOT synthesize `lastActivity` here. The engine
            // owns that value and forwards it (throttled) as a bare `session/patch
            // {lastActivity}`, which the patch reducer applies to every device —
            // unlike this reducer, that path is materialization-agnostic, so all
            // devices reorder/timestamp identically. Streaming replies during a
            // turn never raise the "needs you" signal either — that's the
            // authoritative `attention` field (session/patch), which appears once
            // when the session actually needs the user, not per reply.
            return { ...s, messages, liveMessageIds: [...new Set([...(s.liveMessageIds ?? []), ev.message.id])] };
          }),
        }));
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
    // A missed reset cannot be distinguished from an undurable live-only tail.
    // Keep the readable rows, but do not overlay their unverified provenance
    // onto authoritative history after a connection gap.
    if (state === 'connecting') invalidateRequests(true);
    set({ connState: state });
    if (state === 'open' && snapshotReady) {
      maybeMaterialize();
      const preview = get().preview;
      if (preview?.historyStale && !preview.loadingHistory) requestPreview(preview.sessionId);
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
    preview: null,
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
      const onVisible = () => { if (isVisible()) { seenActiveIfVisible(); syncInbox(); } };
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
        invalidateRequests(true);
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
        if (previous) {
          const mutation = mutationRequests.get(previous);
          if (mutation) mutation.released = true;
          mutationRequests.delete(previous);
          historyRecoveryErrors.delete(previous);
          seenRequests.delete(previous);
        }
        set((st) => ({
          activeId: id,
          sessions: st.sessions.map((s) => s.sessionId === previous ? retainLatestWindow(s) : s),
        }));
        if (id && get().sessions.some(s => s.sessionId === id)) visitWindow(id);
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
      if (get().activeId !== sid || !snapshotReady || get().connState !== 'open' || !client) return;
      const s = get().sessions.find((x) => x.sessionId === sid);
      if (!s || s.historyStale || !s.hasMore || s.loadingHistory || s.messages.length === 0) return;
      const oldest = s.messages[0]!.id;
      requestHistory(sid, { beforeMsgId: oldest, limit: HISTORY_PAGE });
    },

    retryHistory(sid) {
      if (get().activeId !== sid || !snapshotReady || get().connState !== 'open' || !client) return;
      const s = get().sessions.find((x) => x.sessionId === sid);
      if (!s || s.loadingHistory || mutationRequests.has(sid) || (!s.historyStale && s.materialized)) return;
      requestHistory(sid, {
        resume: {}, limit: HISTORY_PAGE,
      });
    },

    sendPrompt(sid, text, attachment, attachments) {
      return acknowledged(sid, (net) => net.prompt(sid, text, attachment, undefined, attachments));
    },
    filesList(body, signal) { return read(net => net.intent('files/list', body, signal)); },
    filesGet(url, signal) { return read(net => net.intent('files/get', { url }, signal)); },
    retainToolImage(body) { return read(net => net.intent('files/from-tool-image', body)); },
    subagentHistory(sid, toolCallId, opts, signal) {
      return read((net) => net.subagentHistory(sid, toolCallId, opts, signal));
    },

    cancel(sid) { return mutation(sid, '取消', (net) => net.cancel(sid)); },
    interrupt(sid) { return nativeRead(sid, (net) => net.interrupt(sid)); },
    setModel(sid, modelId, opts) { return mutation(sid, '切换模型', (net) => net.setModel(sid, modelId, opts)); },
    deleteSession(sid, confirm) { return mutation(sid, '永久删除会话', (net) => net.deleteSession(sid, confirm)); },
    unloadSession(sid) { return mutation(sid, '卸载会话', (net) => net.unloadSession(sid)); },
    reloadSession(sid) { return mutation(sid, '重载会话', (net) => net.reloadSession(sid), true); },
    pinSession(sid, pinned) { return mutation(sid, '置顶会话', (net) => net.pinSession(sid, pinned)); },
    compactSession(sid) { return mutation(sid, '压缩会话', (net) => net.compactSession(sid), true); },
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
    openPreview(sid) {
      const previous = get().preview;
      if (previous?.sessionId === sid) {
        if (get().connState === 'open' && !previous.loadingHistory && (previous.historyStale || previous.error)) requestPreview(sid);
        return;
      }
      const stub: ChatSession = {
        sessionId: sid, title: sid.slice(0, 8), cwd: '', lastActivity: Date.now(),
        status: 'idle', error: null, loaded: true, queue: [], ask: null,
        messages: [], materialized: false, historyStale: true, hasMore: false, loadingHistory: false,
      };
      set({ preview: stub });
      if (get().connState === 'open') requestPreview(sid);
    },
    refreshPreview(sid) {
      if (get().connState === 'open' && get().preview?.sessionId === sid) requestPreview(sid);
    },
    retryPreview(expected) {
      const p = get().preview;
      // The accepted window itself is the retry ticket; refresh/reset/reconnect replace it.
      if (p !== expected || !p?.error || p.loadingHistory || get().connState !== 'open') return;
      requestPreview(p.sessionId, p.materialized && !p.historyStale ? p.messages[0]?.id : undefined);
    },
    loadMorePreview() {
      const p = get().preview;
      if (!p || !p.hasMore || p.loadingHistory || p.historyStale || p.error || get().connState !== 'open') return;
      const before = p.messages[0]?.id;
      if (!before) return;
      requestPreview(p.sessionId, before);
    },
    closePreview() { cancelPreview(); set({ preview: null }); },
    skillsSession(sid) { return nativeRead(sid, (net) => net.skillsSession(sid)).then((r) => r.skills); },
    skillsToggleSession(sid, name, enabled) { return mutation(sid, `切换技能 ${name}`, (net) => net.skillsToggleSession(sid, name, enabled)); },
    listDir(path) { return read((net) => net.listDir(path)); },

    speechToken() {
      return read((net) => net.speechToken());
    },
  };
});

export const useCockpit = createCockpitStore();
