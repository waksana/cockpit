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
import { NetClient } from './client';
import type { ConnState } from './client';
import { isTransportError } from './client';
import type {
  AgentStatus, ChatMessage, ChatSession, ModelOption, SessionMeta, ServerEvent,
} from './types';
import { ensureNotificationPermission, notificationPermission, notify } from '../lib/notify';
import { subscribeToPush, pushSupported, isStandalone, clearOsNotifications } from '../lib/push';
import { setBadge } from '../lib/badge';

const HISTORY_PAGE = 30;

// Is the tab in the foreground? Used to decide whether opening/holding a session
// counts as "seeing" its raised attention (it does only when visible).
const isVisible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';

function metaToSession(m: SessionMeta, prev?: ChatSession): ChatSession {
  return {
    ...m,
    messages: prev?.messages ?? [],
    materialized: prev?.materialized ?? false,
    hasMore: prev?.hasMore ?? false,
    loadingHistory: prev?.loadingHistory ?? false,
  };
}

interface CockpitState {
  connState: ConnState;
  agentStatus: AgentStatus;
  sessions: ChatSession[];
  activeId: string | null;
  globalModels: ModelOption[];
  // Notification permission state (per-device, GLOBAL — one grant covers all
  // sessions; never per-session). `notifSupported` is false outside an installed
  // PWA on iOS, where Web Push is unavailable.
  notifPermission: NotificationPermission;
  notifSupported: boolean;
  // lifecycle
  init: () => () => void;
  // intents
  setActiveId: (id: string | null) => void;
  newSession: (cwd: string) => Promise<string | null>;
  loadMore: (sessionId: string) => void;
  sendPrompt: (sessionId: string, text: string) => boolean;
  cancel: (sessionId: string) => void;
  setModel: (sessionId: string, modelId: string, opts?: { reasoningEffort?: string; contextTier?: 'default' | 'long_context' }) => void;
  deleteSession: (sessionId: string) => void;
  restoreSession: (sessionId: string) => Promise<void>;
  trashList: () => Promise<import('@cockpit/protocol').TrashEntry[]>;
  unloadSession: (sessionId: string) => void;
  reloadSession: (sessionId: string) => void;
  pinSession: (sessionId: string, pinned: boolean) => void;
  renameSession: (sessionId: string, name: string) => void;
  compactSession: (sessionId: string) => void;
  rewindSession: (sessionId: string, toMsgId: string, rollbackFiles?: boolean) => void;
  setMode: (sessionId: string, mode: 'interactive' | 'plan' | 'autopilot') => void;
  getPlan: (sessionId: string) => Promise<import('./types').SessionPlan>;
  getPanels: (sessionId: string) => Promise<import('./types').SessionPanels>;
  scheduleList: (sessionId: string) => Promise<import('@cockpit/protocol').ScheduleEntry[]>;
  hookList: (ownerSession?: string) => Promise<import('@cockpit/protocol').HookEntry[]>;
  flowList: () => Promise<import('@cockpit/protocol').Flow[]>;
  flowScheduleList: () => Promise<import('@cockpit/protocol').FlowScheduleEntry[]>;
  // MCP + Skills management
  mcpGlobal: () => Promise<import('@cockpit/protocol').McpServerGlobal[]>;
  mcpSetDefault: (name: string, on: boolean) => Promise<void>;
  mcpRefresh: () => Promise<void>;
  mcpSession: (sessionId: string) => Promise<import('@cockpit/protocol').McpServerSession[]>;
  mcpToggleSession: (sessionId: string, name: string, on: boolean) => Promise<void>;
  skillsGlobal: () => Promise<import('@cockpit/protocol').SkillGlobal[]>;
  skillsRead: (name: string) => Promise<{ name: string; description?: string; source?: string; userInvocable?: boolean; body?: string }>;
  // Read-only, paginated preview of a TRASHED session (rendered as a non-interactive
  // Thread). `preview` is a synthetic ChatSession kept OUT of `sessions` so it never
  // appears in the sidebar; pagination reads from disk via the `session/peek` intent.
  preview: ChatSession | null;
  openPreview: (sessionId: string) => void;
  loadMorePreview: () => void;
  closePreview: () => void;
  skillsSession: (sessionId: string) => Promise<import('@cockpit/protocol').SkillSession[]>;
  skillsToggleSession: (sessionId: string, name: string, enabled: boolean) => Promise<void>;
  listDir: (path?: string) => Promise<import('@cockpit/protocol').DirListing>;
  respondAsk: (sessionId: string, requestId: string, answer: string, wasFreeform: boolean) => void;
  respondPlan: (sessionId: string, requestId: string, action: import('@cockpit/protocol').ExitPlanModeAction) => void;
  planSupersede: (sessionId: string, requestId: string, message: string) => void;
  respondElicitation: (sessionId: string, requestId: string, action: 'accept' | 'decline' | 'cancel') => void;
  removeQueued: (sessionId: string, itemId: string) => void;
  refreshList: () => void;
  getDraft: (sessionId: string) => string;
  setDraft: (sessionId: string, text: string) => void;
  // Mint a short-lived Azure Speech token (key stays server-side). enabled:false
  // means no Azure resource is configured → voice falls back to the Web Speech API.
  speechToken: () => Promise<{ enabled: boolean; token?: string; region?: string }>;
  // Request notification permission + subscribe to push. MUST be called from a
  // user gesture (iOS only honors a gesture-initiated permission request — calling
  // it on load/snapshot silently fails, which is why notifications never armed).
  enableNotifications: () => Promise<void>;
}

// Module-local singletons (not reactive state).
let client: NetClient | null = null;
let pushDone = false;
let vapidKey: string | null = null;

export const useCockpit = create<CockpitState>((set, get) => {
  const patchLocal = (sid: string, fn: (s: ChatSession) => ChatSession) =>
    set((st) => ({ sessions: st.sessions.map((s) => (s.sessionId === sid ? fn(s) : s)) }));

  // Tell the server "I'm looking at the active session now" when the tab is in the
  // foreground and that session actually has attention raised. The server then
  // clears a 'ready' on sight and demotes a 'choice'. Guarded so we never POST when
  // there's nothing to see; markSeen is idempotent server-side anyway.
  const seenActiveIfVisible = () => {
    if (!isVisible()) return;
    const { activeId, sessions } = get();
    if (!activeId) return;
    const s = sessions.find((x) => x.sessionId === activeId);
    if (s && s.attention != null) client?.inboxSeen(activeId).catch(() => {});
  };

  // Fire the OS/browser notification for a session whose attention the Engine just
  // raised. The kind/body come from the authoritative `session/notify` event — the
  // client never decides *whether* a session needs attention, only renders the
  // alert (and only while hidden, handled inside notify()). Clicking focuses the
  // app and opens that session. Tag is keyed by session so an escalation
  // (ready → choice) replaces the session's banner instead of stacking.
  const fireAttention = (sessionId: string, title: string, kind: 'ready' | 'choice', body: string) =>
    notify({
      title,
      body,
      kind,
      tag: sessionId,
      sessionId,
      onClick: () => get().setActiveId(sessionId),
    });

  // Materialize the active session's window once known + connected. On a
  // (re)connect snapshot we RECONCILE: if we already have a window, resume from
  // our newest message id (a DURABLE cursor — re-folding events.jsonl is
  // deterministic, so it survives a server restart) and append only the tail that
  // arrived while disconnected, preserving the paginated scrollback + scroll. Cold
  // / first open fetches the latest window. If the cursor is gone (history was
  // compacted/rewound while away) the server answers with a full session/reset.
  const maybeMaterialize = (force = false) => {
    const { activeId, connState, sessions } = get();
    if (!activeId || connState !== 'open' || !client) return;
    const s = sessions.find((x) => x.sessionId === activeId);
    if (!s) return;
    if (!force && (s.materialized || s.loadingHistory)) return;
    const resumeFrom = force && s.materialized && s.messages.length > 0
      ? s.messages[s.messages.length - 1]!.id : undefined;
    patchLocal(activeId, (x) => ({ ...x, loadingHistory: true }));
    const req = resumeFrom ? { afterMsgId: resumeFrom } : { limit: HISTORY_PAGE };
    client.history(activeId, req).catch((e) => {
      // A transport blip (tab backgrounded, server restart 502) is not a load
      // failure to surface — the reconnect snapshot re-materializes this window
      // automatically, and the connection state already tells the user we're
      // reconnecting. Just clear the spinner; don't flash a sticky error.
      if (isTransportError(e)) {
        patchLocal(activeId, (x) => ({ ...x, loadingHistory: false }));
        return;
      }
      const raw = e instanceof Error ? e.message : String(e);
      const msg = /corrupt/i.test(raw) ? '会话文件有损坏行(可能写入时被中断),稍后重试或联系维护' : `加载失败: ${raw}`;
      patchLocal(activeId, (x) => ({ ...x, loadingHistory: false, error: msg }));
    });
  };

  const onEvent = (ev: ServerEvent) => {
    switch (ev.type) {
      case 'snapshot': {
        set({ agentStatus: ev.agentStatus });
        if (ev.models?.length) set({ globalModels: ev.models });
        if (ev.vapidPublicKey) {
          vapidKey = ev.vapidPublicKey;
          // Self-heal only: if permission was ALREADY granted (in a prior gesture),
          // (re)subscribe across reconnects. NEVER request permission here — a
          // non-gesture request is silently ineffective on iOS. The grant itself
          // happens in enableNotifications(), from a user tap.
          if (!pushDone && notificationPermission() === 'granted') {
            pushDone = true;
            void (async () => {
              const sub = await subscribeToPush(ev.vapidPublicKey!);
              if (sub) client?.subscribePush(sub).catch(() => {});
              else pushDone = false;
            })();
          }
        }
        set((st) => {
          const byId = new Map(st.sessions.map((s) => [s.sessionId, s]));
          return { sessions: ev.sessions.map((m) => metaToSession(m, byId.get(m.sessionId))) };
        });
        maybeMaterialize(true);
        // If we (re)connected straight into a session that already has attention
        // raised and the tab is in front, that counts as seeing it — clears a
        // 'ready' on cold deep-link, demotes a seen 'choice'.
        seenActiveIfVisible();
        return;
      }
      case 'agent/status':
        set({ agentStatus: ev.status });
        return;
      case 'session/added':
        set((st) => (st.sessions.some((s) => s.sessionId === ev.session.sessionId)
          ? st : { sessions: [metaToSession(ev.session), ...st.sessions] }));
        return;
      case 'session/removed':
        // Drop the row. We deliberately DON'T clear activeId here: the URL is the
        // source of truth for what's focused, so a remote delete just makes the
        // active session vanish from `sessions`, and the page derives a NotFound
        // pane from (routeId set, no matching session). A LOCAL delete navigates
        // back to the list itself (App.doDelete), so it never hits NotFound.
        set((st) => ({ sessions: st.sessions.filter((s) => s.sessionId !== ev.sessionId) }));
        return;
      case 'session/patch': {
        const activeId = get().activeId;
        set((st) => ({
          sessions: st.sessions.map((s) => {
            if (s.sessionId !== ev.sessionId) return s;
            // Apply exactly the fields present on the patch (mirrors the engine's
            // spread). `sessionId` stays in `patch` (same value, harmless); only
            // the `type` discriminator is dropped. No per-field list to maintain.
            const { type, ...patch } = ev;
            void type;
            return { ...s, ...patch };
          }),
        }));
        // The sidebar dot + app-icon badge derive purely from the server's
        // attention/attnId/seenId we just merged — there is no per-device flag to
        // set, so a missed-while-offline raise or a remote handle can't leave a
        // stale dot. But if attention was just raised on the session you're already
        // looking at (tab visible), that IS seeing it: tell the server so a 'ready'
        // clears on sight and a 'choice' demotes. When hidden we leave it raised so
        // the OS notification (session/notify) still fires.
        if (ev.attention != null && ev.sessionId === activeId) seenActiveIfVisible();
        return;
      }
      case 'session/history-page': {
        const p = ev.page;
        set((st) => ({
          sessions: st.sessions.map((s) => {
            if (s.sessionId !== p.sessionId) return s;
            // Reconnect resume: upsert-merge the tail by id (the cursor message may
            // have grown mid-stream → replace it; genuinely-new messages append),
            // keeping older scrollback + hasMore untouched. No scroll reset.
            if (p.append) {
              const tailIds = new Set(p.messages.map((m) => m.id));
              const kept = s.messages.filter((m) => !tailIds.has(m.id));
              return { ...s, messages: [...kept, ...p.messages], materialized: true, loadingHistory: false, error: null };
            }
            if (p.latest) return { ...s, messages: p.messages, hasMore: p.hasMore, materialized: true, loadingHistory: false, error: null };
            const have = new Set(s.messages.map((m) => m.id));
            const older = p.messages.filter((m) => !have.has(m.id));
            return { ...s, messages: [...older, ...s.messages], hasMore: p.hasMore, loadingHistory: false };
          }),
        }));
        return;
      }
      case 'session/reset': {
        const p = ev.page;
        set((st) => ({
          sessions: st.sessions.map((s) => (
            s.sessionId !== p.sessionId || !s.materialized ? s
              : { ...s, messages: p.messages, hasMore: p.hasMore, loadingHistory: false }
          )),
        }));
        return;
      }
      case 'msg/upsert': {
        set((st) => ({
          sessions: st.sessions.map((s) => {
            if (s.sessionId !== ev.sessionId) return s;
            if (!s.materialized) return s;
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
            return { ...s, messages };
          }),
        }));
        return;
      }
      case 'session/notify': {
        // The Engine raised this session's attention. Fire the OS/page alert
        // (notify() is a no-op while the tab is visible). For the session you're
        // already viewing, suppress it — you can see the prompt, and the active+
        // visible case is auto-marked seen by the session/patch handler.
        if (ev.sessionId !== get().activeId) {
          fireAttention(ev.sessionId, ev.title, ev.attention, ev.body);
        }
        return;
      }
      default:
        return;
    }
  };

  const onStateChange = (state: ConnState) => {
    set({ connState: state });
    if (state === 'open') maybeMaterialize();
  };

  return {
    connState: 'connecting',
    agentStatus: 'starting',
    sessions: [],
    activeId: null,
    globalModels: [],
    preview: null,
    notifPermission: notificationPermission(),
    notifSupported: pushSupported() && isStandalone(),

    init() {
      client = new NetClient({ onEvent, onStateChange });
      client.connect();
      // NOTE: do NOT request notification permission here — it isn't a user
      // gesture, so iOS ignores it. Enabling happens via enableNotifications()
      // from the hamburger menu tap. We only reflect the current grant state.
      set({ notifPermission: notificationPermission(), notifSupported: pushSupported() && isStandalone() });
      // Bringing the tab to the front counts as seeing the active session's raised
      // attention (clears a 'ready', demotes a 'choice') — covers "alert arrived
      // while I was on this session but had it backgrounded, then I came back".
      // It also clears this device's lingering OS notification banners: once you're
      // looking at the app, the in-app dots/badge are authoritative, so the popups
      // are redundant noise.
      const onVisible = () => { if (isVisible()) { seenActiveIfVisible(); void clearOsNotifications(); } };
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
      // Initial load doesn't fire visibilitychange, so wipe any banners left from a
      // previous (backgrounded) session right away when we open already-visible.
      if (isVisible()) void clearOsNotifications();
      // One-time cleanup: pin is now backend-authoritative (session/pin), so the
      // legacy per-device localStorage pin list is obsolete — drop it if present.
      try { localStorage.removeItem('cockpit:pinned'); } catch { /* ignore */ }
      return () => {
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
        client?.disconnect(); client = null;
      };
    },

    async enableNotifications() {
      const granted = await ensureNotificationPermission();
      set({ notifPermission: notificationPermission() });
      if (!granted || !vapidKey) return;
      const sub = await subscribeToPush(vapidKey);
      if (sub) { pushDone = true; client?.subscribePush(sub).catch(() => {}); }
    },

    setActiveId(id) {
      set({ activeId: id });
      // Opening a session = seeing it. The server clears a 'ready' on sight and
      // demotes a 'choice'; the dot/badge then update for every device from server
      // truth. (seenActiveIfVisible guards on attention != null + tab visible.)
      if (id) seenActiveIfVisible();
      maybeMaterialize();
    },

    async newSession(cwd) {
      if (!client) return null;
      try {
        const res = await client.newSession(cwd);
        get().setActiveId(res.sessionId);
        return res.sessionId;
      } catch (e) {
        console.error('[cockpit] 新建 session 失败:', e instanceof Error ? e.message : String(e));
        return null;
      }
    },

    loadMore(sid) {
      if (!client) return;
      const s = get().sessions.find((x) => x.sessionId === sid);
      if (!s || !s.hasMore || s.loadingHistory || s.messages.length === 0) return;
      const oldest = s.messages[0]!.id;
      patchLocal(sid, (x) => ({ ...x, loadingHistory: true }));
      client.history(sid, { beforeMsgId: oldest, limit: HISTORY_PAGE }).catch(() => {
        patchLocal(sid, (x) => ({ ...x, loadingHistory: false }));
      });
    },

    sendPrompt(sid, text) {
      if (!client || !client.isOpen) {
        patchLocal(sid, (s) => ({ ...s, error: '未连接，消息未发送，请稍候重试' }));
        return false;
      }
      client.prompt(sid, text).catch((e) => {
        patchLocal(sid, (s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      });
      return true;
    },

    cancel(sid) { client?.cancel(sid).catch(() => {}); },
    setModel(sid, modelId, opts) { client?.setModel(sid, modelId, opts).catch(() => {}); },
    deleteSession(sid) {
      // Soft delete (→ trash): the caller confirms first, then we fire the intent.
      // The row disappears when the server's `session/removed` event arrives.
      // (For the focused session the caller navigates back to the list — see
      // App.doDelete; the URL stays the source of truth.) Restorable from trash.
      client?.deleteSession(sid).catch((e) => {
        console.error('[cockpit] 移入垃圾桶失败:', e instanceof Error ? e.message : String(e));
      });
    },
    restoreSession(sid) {
      // The restored session re-appears via the server's `session/added` event.
      return client ? client.restoreSession(sid).then(() => {}) : Promise.resolve();
    },
    trashList() { return client ? client.trashList().then((r) => r.entries) : Promise.resolve([]); },
    unloadSession(sid) { client?.unloadSession(sid).catch(() => {}); },
    reloadSession(sid) {
      patchLocal(sid, (s) => ({ ...s, loadingHistory: true, error: null }));
      client?.reloadSession(sid).catch((e) => {
        patchLocal(sid, (s) => ({ ...s, loadingHistory: false, error: e instanceof Error ? e.message : String(e) }));
      });
    },
    // Pin = keep-loaded (server-authoritative; the `pinned` field arrives back via
    // session/patch — no optimistic insert). Fire-and-forget like the other toggles.
    pinSession(sid, pinned) { client?.pinSession(sid, pinned).catch(() => {}); },
    renameSession(sid, name) { client?.renameSession(sid, name).catch(() => {}); },
    compactSession(sid) { client?.compactSession(sid).catch(() => {}); },
    rewindSession(sid, toMsgId, rollbackFiles) {
      patchLocal(sid, (s) => ({ ...s, loadingHistory: true }));
      client?.rewindSession(sid, toMsgId, rollbackFiles).catch(() => {});
    },
    setMode(sid, mode) { client?.setMode(sid, mode).catch(() => {}); },
    respondAsk(sid, requestId, answer, wasFreeform) { client?.respondAsk(sid, requestId, answer, wasFreeform).catch(() => {}); },
    respondPlan(sid, requestId, action) { client?.respondPlan(sid, requestId, action).catch(() => {}); },
    planSupersede(sid, requestId, message) { client?.planSupersede(sid, requestId, message).catch(() => {}); },
    respondElicitation(sid, requestId, action) { client?.respondElicitation(sid, requestId, action).catch(() => {}); },
    removeQueued(sid, itemId) { client?.removeQueued(sid, itemId).catch(() => {}); },
    refreshList() { client?.refresh().catch(() => {}); },
    getPlan(sid) {
      if (!client) return Promise.resolve({ planMarkdown: null, todos: [] });
      return client.getPlan(sid);
    },
    getPanels(sid) {
      if (!client) return Promise.resolve({ skills: [], mcpServers: [], tasks: [], instructionSources: [], schedules: [] });
      return client.getPanels(sid);
    },
    scheduleList(sid) { return client ? client.scheduleList(sid).then((r) => r.entries) : Promise.resolve([]); },
    hookList(owner) { return client ? client.hookList(owner).then((r) => r.entries) : Promise.resolve([]); },
    flowList() { return client ? client.flowList().then((r) => r.flows) : Promise.resolve([]); },
    flowScheduleList() { return client ? client.flowScheduleList().then((r) => r.entries) : Promise.resolve([]); },
    mcpGlobal() { return client ? client.mcpGlobal().then((r) => r.servers) : Promise.resolve([]); },
    mcpSetDefault(name, on) { return client ? client.mcpSetDefault(name, on).then(() => {}) : Promise.resolve(); },
    mcpRefresh() { return client ? client.mcpRefresh().then(() => {}) : Promise.resolve(); },
    mcpSession(sid) { return client ? client.mcpSession(sid).then((r) => r.servers) : Promise.resolve([]); },
    mcpToggleSession(sid, name, on) { return client ? client.mcpToggleSession(sid, name, on).then(() => {}) : Promise.resolve(); },
    skillsGlobal() { return client ? client.skillsGlobal().then((r) => r.skills) : Promise.resolve([]); },
    skillsRead(name) { return client ? client.skillsRead(name) : Promise.resolve({ name }); },
    openPreview(sid) {
      if (!client) return;
      // Already showing this one (or its first page is loading) — don't refetch.
      if (get().preview?.sessionId === sid) return;
      const stub: ChatSession = {
        sessionId: sid, title: sid.slice(0, 8), cwd: '', lastActivity: Date.now(),
        status: 'idle', error: null, loaded: true, queue: [], ask: null,
        messages: [], materialized: true, hasMore: false, loadingHistory: true,
      };
      set({ preview: stub });
      client.peek(sid).then((r) => {
        // A newer openPreview/closePreview may have superseded this fetch.
        if (get().preview?.sessionId !== sid) return;
        set({ preview: { ...stub, title: r.title || stub.title, cwd: r.cwd, messages: r.messages, hasMore: r.hasMore, loadingHistory: false } });
      }).catch((e) => {
        if (get().preview?.sessionId !== sid) return;
        set({ preview: { ...stub, loadingHistory: false, error: e instanceof Error ? e.message : String(e) } });
      });
    },
    loadMorePreview() {
      const p = get().preview;
      if (!client || !p || !p.hasMore || p.loadingHistory) return;
      const before = p.messages[0]?.id;
      if (!before) return;
      set({ preview: { ...p, loadingHistory: true } });
      client.peek(p.sessionId, { beforeMsgId: before }).then((r) => {
        const cur = get().preview;
        if (!cur || cur.sessionId !== p.sessionId) return;
        // Prepend the older page, de-duping by id against what we already hold.
        const have = new Set(cur.messages.map((m) => m.id));
        const older = r.messages.filter((m) => !have.has(m.id));
        set({ preview: { ...cur, messages: [...older, ...cur.messages], hasMore: r.hasMore, loadingHistory: false } });
      }).catch(() => {
        const cur = get().preview;
        if (cur && cur.sessionId === p.sessionId) set({ preview: { ...cur, loadingHistory: false } });
      });
    },
    closePreview() { if (get().preview) set({ preview: null }); },
    skillsSession(sid) { return client ? client.skillsSession(sid).then((r) => r.skills) : Promise.resolve([]); },
    skillsToggleSession(sid, name, enabled) { return client ? client.skillsToggleSession(sid, name, enabled).then(() => {}) : Promise.resolve(); },
    listDir(path) { return client ? client.listDir(path) : Promise.resolve({ path: path ?? '/', parent: null, entries: [] }); },

    getDraft(sid) {
      try { return localStorage.getItem(`cockpit:draft:${sid}`) ?? ''; } catch { return ''; }
    },
    setDraft(sid, text) {
      try {
        if (text) localStorage.setItem(`cockpit:draft:${sid}`, text);
        else localStorage.removeItem(`cockpit:draft:${sid}`);
      } catch { /* ignore */ }
    },
    speechToken() {
      return client ? client.speechToken() : Promise.resolve({ enabled: false });
    },
  };
});

// App-icon badge ← authoritative attention count (how many sessions await me).
// = (readies not yet seen) + (choices not yet answered): a 'ready' is cleared to
// null by the server the moment it's seen, so this count can't degrade into "every
// session you've talked to". Foreground sync: recompute whenever the projection
// changes; the SW keeps it in sync while closed. setBadge no-ops where unsupported.
let lastBadge = -1;
useCockpit.subscribe((state) => {
  let n = 0;
  for (const s of state.sessions) if (s.attention != null) n++;
  if (n !== lastBadge) { lastBadge = n; setBadge(n); }
});
