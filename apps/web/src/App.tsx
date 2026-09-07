// App root. Wires the ACP store to the responsive master-detail shell.
// Desktop: sidebar + chat side-by-side. Mobile: list ↔ detail two-level nav.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useCockpit } from './net/store';
import { useUp, recordLocation } from './lib/nav';
import { Shell, MasterPane, DetailPane } from './components/Shell';
import { Sidebar } from './components/Sidebar';
import { Thread } from './components/Thread';
import { SessionInfoPanel } from './components/SessionInfoPanel';
import { NewSessionFab } from './components/NewSessionFab';
import { Icon, type IconName } from './components/Icon';
import { type MenuItem } from './components/ContextMenu';
import { AnchoredMenu } from './components/AnchoredMenu';
import { ModeMenu, type SessionMode } from './components/ModeMenu';
import { SessionMcp, SessionSkills } from './components/Manage';
import { SessionAutomation, SessionContext } from './components/SessionPages';
import { ManageWorkspace } from './components/ManageWorkspace';
import { Dialog, type DialogProps } from './components/Dialog';
import { DirPicker } from './components/DirPicker';
import { uploadFile, buildAttachmentMessage } from './lib/upload';

const MODE_LABELS: Record<string, string> = { interactive: '交互', plan: '计划', autopilot: '自动' };
const MODE_ICONS: Record<string, IconName> = {
  interactive: 'mode_interactive', plan: 'mode_plan', autopilot: 'mode_autopilot',
};

const DEFAULT_CWD = '/home/honglai';

// The per-session sub-pages that render into the info-panel slot (kebab → page),
// each addressed as /session/:id/<page> and sharing the same URL/back mechanism.
// The info panel itself (/info) is handled separately.
type SessionPage = 'mcp' | 'skills' | 'automation' | 'context';
const SESSION_PAGES: SessionPage[] = ['mcp', 'skills', 'automation', 'context'];
const SESSION_PAGE_LABELS: Record<SessionPage, string> = {
  mcp: 'MCP 服务器', skills: 'Skills', automation: '自动化', context: '上下文',
};


function Workspace() {
  const {
    connState, sessions, activeId,
    setActiveId, newSession,
    sendPrompt, cancel, setModel, loadMore,
    getDraft, setDraft, respondAsk, respondPlan, planSupersede, respondElicitation, removeQueued,
    deleteSession, unloadSession, reloadSession,
    renameSession, compactSession, rewindSession, setMode,
    pinSession,
    globalModels,
    notifPermission, notifSupported, enableNotifications,
  } = useCockpit();
  const active = useMemo(
    () => sessions.find((s) => s.sessionId === activeId) ?? null,
    [sessions, activeId],
  );
  const [query, setQuery] = useState('');
  const [detailMenu, setDetailMenu] = useState<{ items: MenuItem[] } | null>(null);
  const kebabRef = useRef<HTMLButtonElement | null>(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeChipRef = useRef<HTMLButtonElement | null>(null);
  const [hamburgerMenu, setHamburgerMenu] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement | null>(null);
  const [dialog, setDialog] = useState<DialogProps | null>(null);
  const [dirPicker, setDirPicker] = useState(false);

  // ── URL is the single source of truth for what's on screen ──────────────────
  // The whole UI projects from the path; every focus/page change navigates.
  //   /                       — session list, no chat
  //   /session/:id            — that chat
  //   /session/:id/info       — chat + info panel
  //   /session/:id/mcp|skills|automation|context — chat + that per-session page
  // The global sections (/mcp, /skills, /trash, /flows and their /:item detail) render a
  // separate master-detail <ManageWorkspace/>, not this Workspace.
  // These session routes all render the SAME <Workspace/> (no remount).
  const navigate = useNavigate();
  const up = useUp();
  // `routeId` is the active session (null on `/`); `panel` is the per-session
  // sub-page. useParams gives the already-decoded segments.
  const { sessionId: routeId = null, panel } = useParams();
  const sessionPath = (id: string, sub?: SessionPage | 'info') => `/session/${id}${sub ? `/${sub}` : ''}`;
  // Per-session pages derive from the :panel segment; the global page derives from
  // the top-level segment when no session is active. Unknown panels fall back to
  // the plain chat, so a stray `/session/:id/foo` just shows the conversation.
  const infoOpen = panel === 'info';
  const sessionPage: SessionPage | null = SESSION_PAGES.includes(panel as SessionPage) ? (panel as SessionPage) : null;
  const didMountRef = useRef(false);

  // URL → store: reflect the route id into the store's focused session (incl.
  // back/forward + deep links). setActiveId also triggers materialization, so the
  // store stays the data-layer's notion of "focused", mirrored from the URL.
  useEffect(() => {
    setActiveId(routeId);
  }, [routeId, setActiveId]);

  // store → URL: the one focus change that ORIGINATES in the store is newSession
  // (it setActiveId's the fresh id); push that into the URL. Clicks/notification
  // taps/page opens already navigate themselves, and remote deletes leave the URL
  // alone (→ NotFound). So this is a no-op whenever the two already agree. We only
  // sync the base session ⇄ id; sub-pages (/info, …) are preserved because routeId
  // still equals activeId then. First run is skipped so a deep-linked `/session/id`
  // isn't clobbered by the store's initial null activeId on mount.
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if ((activeId ?? null) !== routeId) {
      // Opening a session from the list is a drill-down (push). Switching from one
      // session straight to another is lateral (replace) — so back returns to the
      // list, not a chain of previously-viewed sessions.
      const replace = activeId != null && routeId != null;
      navigate(activeId ? sessionPath(activeId) : '/', { replace });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Notification tap → URL. When the app is already open, the service worker
  // posts `open-session` rather than hard-navigating (a WindowClient.navigate
  // would full-reload the SPA and drop the live SSE stream). We turn that into a
  // client-side route change, so a notification tap flows through the same
  // URL→store path as a click. (Cold start with no window open is handled by the
  // SW's own openWindow(`/session/<id>`).)
  useEffect(() => {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; sessionId?: string } | null;
      if (d?.type === 'open-session' && d.sessionId) {
        // Jumping to a session from a notification: replace if we're already in a
        // session (lateral switch), push from the list (drill-down).
        const replace = window.location.pathname.startsWith('/session/');
        navigate(sessionPath(d.sessionId), { replace });
      }
    };
    sw.addEventListener('message', onMsg);
    return () => sw.removeEventListener('message', onMsg);
  }, [navigate]);

  // The detail pane shows the chat, or — when the URL points at a session that
  // doesn't exist (bad deep-link or one deleted remotely) — a NotFound. Both sit
  // at the detail level on mobile so the message (and its back button) is visible.
  // Gated on connState==='open' so a deep-link doesn't flash NotFound before the
  // snapshot (the authoritative session list) has loaded.
  const notFound = !active && routeId != null && connState === 'open';
  const mobileView: 'list' | 'detail' = active || notFound ? 'detail' : 'list';

  async function handleNew(cwd: string) {
    await newSession(cwd);
  }

  // Upload a file then send the attachment message (marker + agent guidance) to the
  // session — the fold turns the marker into a card, the agent reads the guidance.
  async function attachFile(sessionId: string, file: File) {
    try {
      const up = await uploadFile(file);
      sendPrompt(sessionId, buildAttachmentMessage(up));
    } catch (e) {
      setDialog({
        title: '上传失败',
        message: e instanceof Error ? e.message : String(e),
        confirmLabel: '知道了',
        onConfirm: () => setDialog(null),
        onCancel: () => setDialog(null),
      });
    }
  }

  const doNewSession = () => setDirPicker(true);
  // Opening a top-level section (MCP/Skills/Trash): from the list it's a push, but
  // from inside a session it's a lateral reset (replace) so the section sits on the
  // root, not on the chat — keeping back/Up out of "list → dives into a chat".
  const openSection = (s: 'mcp' | 'skills' | 'trash' | 'flows' | 'workers') => navigate(`/${s}`, { replace: routeId != null });

  const masterHeader = (
    <header className="sidebar-header">
      <button
        ref={hamburgerRef}
        type="button" className="btn-icon rp sidebar-hamburger" aria-label="管理 MCP 和 Skills"
        onClick={() => setHamburgerMenu(true)}
      >
        <Icon name="menu" size={24} />
      </button>
      <div className="input-search">
        {connState === 'open' ? (
          <span className="input-search-icon"><Icon name="search" size={20} /></span>
        ) : (
          <span className="spinner" aria-label="连接中" />
        )}
        <input
          type="search"
          className="input-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={connState === 'open' ? '搜索会话或目录…' : '正在连接服务器…'}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="搜索会话"
        />
        {query && (
          <button type="button" className="input-search-clear" aria-label="清除" onClick={() => setQuery('')}>
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
    </header>
  );

  const doRename = () => {
    if (!active) return;
    setDialog({
      title: '重命名会话',
      input: { placeholder: '会话名称', initial: active.title },
      confirmLabel: '保存',
      onConfirm: (name) => { renameSession(active.sessionId, name); setDialog(null); },
      onCancel: () => setDialog(null),
    });
  };

  const doCompact = () => {
    if (!active) return;
    setDialog({
      title: '压缩上下文',
      message: '把当前对话历史压缩成摘要以释放上下文窗口。摘要后较早的细节会被精简。',
      confirmLabel: '压缩',
      onConfirm: () => { compactSession(active.sessionId); setDialog(null); },
      onCancel: () => setDialog(null),
    });
  };

  const doRewind = () => {
    if (!active) return;
    const lastUser = [...active.messages].reverse().find((m) => m.role === 'user' && !m.subtype);
    if (!lastUser) { setDialog({ title: '无法回退', message: '没有可回退的用户消息。', confirmLabel: '知道了', onConfirm: () => setDialog(null), onCancel: () => setDialog(null) }); return; }
    setDialog({
      title: '撤销上一轮',
      message: '将对话回退到上一条你发送的消息之前，撤销其后的所有回复。此操作不可恢复。',
      confirmLabel: '撤销',
      destructive: true,
      onConfirm: () => { rewindSession(active.sessionId, lastUser.id); setDialog(null); },
      onCancel: () => setDialog(null),
    });
  };

  const doDelete = (sessionId: string) => {
    const s = sessions.find((x) => x.sessionId === sessionId);
    const name = s?.title?.trim() || '该会话';
    setDialog({
      title: '移入垃圾桶',
      message: `将「${name}」移入垃圾桶。会话数据会保留，可随时从垃圾桶恢复。`,
      confirmLabel: '移入垃圾桶',
      destructive: true,
      onConfirm: () => {
        deleteSession(sessionId);
        // Local delete of the focused session returns to the list — the URL is
        // the source of truth. Replace so the now-deleted session isn't left in
        // history (a back press would otherwise land on its NotFound). A remote
        // delete has no such navigation and falls through to the NotFound pane.
        if (routeId === sessionId) navigate('/', { replace: true });
        setDialog(null);
      },
      onCancel: () => setDialog(null),
    });
  };

  const openDetailMenu = () => {
    if (!active) return;
    const running = active.status === 'running';
    const busy = running || !!active.compacting;
    const isPinned = !!active.pinned;
    setDetailMenu({
      items: [
        { label: '重命名', icon: 'compose', onClick: doRename },
        { label: 'MCP 服务器', icon: 'mcp', onClick: () => navigate(sessionPath(active.sessionId, 'mcp')) },
        { label: 'Skills', icon: 'skills', onClick: () => navigate(sessionPath(active.sessionId, 'skills')) },
        { label: '自动化', icon: 'schedule', onClick: () => navigate(sessionPath(active.sessionId, 'automation')) },
        { label: '上下文', icon: 'file', onClick: () => navigate(sessionPath(active.sessionId, 'context')) },
        { label: isPinned ? '取消置顶' : '置顶', icon: isPinned ? 'unpin' : 'pin', onClick: () => pinSession(active.sessionId, !isPinned) },
        { label: '压缩上下文', icon: 'unload', onClick: doCompact, disabled: busy },
        { label: '撤销上一轮', icon: 'back', onClick: doRewind, disabled: busy, destructive: true },
        { label: '重载', icon: 'reload', onClick: () => reloadSession(active.sessionId), disabled: busy },
        ...(active.loaded ? [{ label: '卸载', icon: 'unload' as const, onClick: () => unloadSession(active.sessionId), disabled: busy }] : []),
        { label: '删除', icon: 'delete' as const, onClick: () => doDelete(active.sessionId), destructive: true },
      ],
    });
  };

  const modelLabel = active
    ? ((active.availableModels ?? globalModels).find((m) => m.modelId === active.currentModelId)?.name
       ?? active.currentModelId ?? '')
    : '';

  const detailHeader = active ? (
    <header className="chat-topbar">
      <button className="chat-back btn-icon rp lg:hidden" type="button" aria-label="返回" onClick={() => up()}>
        <Icon name="back" size={24} />
      </button>
      <button type="button" className="chat-topbar-content" aria-label="查看会话信息" onClick={() => navigate(sessionPath(active.sessionId, 'info'))}>
        <span className="chat-topbar-title">{active.title}</span>
        {modelLabel && <span className="chat-topbar-subtitle"><span className="chat-topbar-model">{modelLabel}</span></span>}
      </button>
      <button
        ref={modeChipRef}
        className="chat-topbar-mode btn-icon rp" type="button"
        aria-label={`模式：${MODE_LABELS[active.currentMode ?? 'interactive']}，点击切换`}
        data-mode={active.currentMode ?? 'interactive'}
        onClick={() => setModeMenuOpen((v) => !v)}
      >
        <Icon name={MODE_ICONS[active.currentMode ?? 'interactive']} size={24} />
      </button>
      <button
        ref={kebabRef}
        className="chat-topbar-more btn-icon rp" type="button" aria-label="更多操作"
        onClick={openDetailMenu}
      >
        <Icon name="more" size={24} />
      </button>
    </header>
  ) : undefined;

  return (
    <Shell ariaLabel="cockpit" infoOpen={(infoOpen || !!sessionPage) && !!active}>
      <MasterPane
        ariaLabel="会话列表"
        mobileVisible={mobileView === 'list'}
        header={masterHeader}
        overlay={
          <NewSessionFab
            disabled={connState !== 'open'}
            onOpen={doNewSession}
          />
        }
      >
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          query={query}
          onSelect={setActiveId}
          onDelete={doDelete}
          onReload={reloadSession}
          onUnload={unloadSession}
          onPin={pinSession}
        />
      </MasterPane>

      <DetailPane ariaLabel="对话" mobileVisible={mobileView === 'detail'} header={detailHeader}>
        {active ? (
          <Thread
            key={active.sessionId}
            session={active}
            initialDraft={getDraft(active.sessionId)}
            onPersistDraft={(t) => setDraft(active.sessionId, t)}
            onSend={(t) => sendPrompt(active.sessionId, t)}
            onRespondAsk={(rid, ans, ff) => respondAsk(active.sessionId, rid, ans, ff)}
            onRespondPlan={(rid, action) => respondPlan(active.sessionId, rid, action)}
            onPlanSupersede={(rid, message) => planSupersede(active.sessionId, rid, message)}
            onRespondElicitation={(rid, action) => respondElicitation(active.sessionId, rid, action)}
            onRemoveQueued={(itemId) => removeQueued(active.sessionId, itemId)}
            onCancel={() => cancel(active.sessionId)}
            onLoadMore={() => loadMore(active.sessionId)}
            onAttach={(file) => attachFile(active.sessionId, file)}
          />
        ) : notFound ? (
          <div className="detail-empty">
            <div>
              <p>这个会话不存在,或已被删除。</p>
              <button type="button" className="dialog-btn primary rp" onClick={() => navigate('/')}>返回列表</button>
            </div>
          </div>
        ) : (
          <div className="detail-empty">
            <p>选择左侧的一个 session,或点右下角的「新建」开始一个。</p>
          </div>
        )}
      </DetailPane>
      {detailMenu && (
        <AnchoredMenu triggerRef={kebabRef} items={detailMenu.items} onClose={() => setDetailMenu(null)} />
      )}
      {modeMenuOpen && active && (
        <ModeMenu
          triggerRef={modeChipRef}
          current={(active.currentMode ?? 'interactive') as SessionMode}
          running={active.status === 'running'}
          onPick={(mode) => setMode(active.sessionId, mode)}
          onClose={() => setModeMenuOpen(false)}
        />
      )}
      {hamburgerMenu && (
        <AnchoredMenu
          triggerRef={hamburgerRef}
          align="left"
          items={[
            { label: 'MCP 服务器', icon: 'mcp', onClick: () => openSection('mcp') },
            { label: 'Skills', icon: 'skills', onClick: () => openSection('skills') },
            { label: '流程', icon: 'mode_autopilot', onClick: () => openSection('flows') },
            { label: '自动会话', icon: 'newchat', onClick: () => openSection('workers') },
            { label: '垃圾桶', icon: 'delete', onClick: () => openSection('trash') },
            // Notification permission is GLOBAL (per-device). Tapping is the user
            // gesture iOS requires to grant; the label reflects current state.
            ...(notifPermission === 'granted'
              ? [{ label: '通知：已开启', icon: 'check' as const, onClick: () => {}, disabled: true }]
              : !notifSupported
                ? [{ label: '通知：需先添加到主屏', icon: 'reload' as const, onClick: () => {}, disabled: true }]
                : notifPermission === 'denied'
                  ? [{ label: '通知：已被系统拒绝（去设置开启）', icon: 'reload' as const, onClick: () => {}, disabled: true }]
                  : [{ label: '开启通知', icon: 'reload' as const, onClick: () => { void enableNotifications(); } }]),
          ]}
          onClose={() => setHamburgerMenu(false)}
        />
      )}
      {dialog && <Dialog {...dialog} />}
      {dirPicker && (
        <DirPicker
          initialPath={DEFAULT_CWD}
          onPick={(cwd) => { setDirPicker(false); void handleNew(cwd); }}
          onCancel={() => setDirPicker(false)}
        />
      )}
      {sessionPage && active && (
        <>
          <div className="info-panel-scrim" data-open="true" onClick={() => up()} aria-hidden="true" />
          <aside className="info-panel" data-open="true" aria-label={SESSION_PAGE_LABELS[sessionPage]}>
            {sessionPage === 'mcp' ? <SessionMcp sessionId={active.sessionId} onClose={() => up()} />
              : sessionPage === 'skills' ? <SessionSkills sessionId={active.sessionId} onClose={() => up()} />
              : sessionPage === 'automation' ? <SessionAutomation session={active} onClose={() => up()} />
              : <SessionContext session={active} onClose={() => up()} />}
          </aside>
        </>
      )}
      {active && (
        <SessionInfoPanel
          session={active}
          models={globalModels}
          open={infoOpen}
          onClose={() => up()}
          onSetModel={(m, opts) => void setModel(active.sessionId, m, opts)}
        />
      )}
    </Shell>
  );
}

export default function App() {
  useEffect(() => { document.title = 'cockpit'; }, []);
  // Single client lifecycle: connect the SSE stream once on mount.
  useEffect(() => useCockpit.getState().init(), []);
  // Track the pathname showing at each history index so useUp() (in lib/nav) can
  // tell when "back" can pop to the real parent vs. must synthesize it. Runs for
  // every navigation across BOTH Workspace and ManageWorkspace.
  const location = useLocation();
  useEffect(() => { recordLocation(location.pathname); }, [location.key, location.pathname]);
  // Every route renders the SAME <Workspace/> element, so the master-detail shell
  // never remounts as you navigate — React reconciles the same component type at
  // the Routes outlet, only the matched params/path change (Workspace reads them
  // via useParams/useLocation). This keeps the responsive CSS layout, scroll
  // positions, and drafts intact across every navigation. Sessions are namespaced
  // under /session/ so the global pages (/mcp, /skills, /trash) can be top-level
  // without colliding with a session id.
  return (
    <Routes>
      <Route path="/" element={<Workspace />} />
      <Route path="/mcp" element={<ManageWorkspace />} />
      <Route path="/mcp/:item" element={<ManageWorkspace />} />
      <Route path="/skills" element={<ManageWorkspace />} />
      <Route path="/skills/:item" element={<ManageWorkspace />} />
      <Route path="/trash" element={<ManageWorkspace />} />
      <Route path="/trash/:item" element={<ManageWorkspace />} />
      <Route path="/flows" element={<ManageWorkspace />} />
      <Route path="/flows/:item" element={<ManageWorkspace />} />
      <Route path="/workers" element={<ManageWorkspace />} />
      <Route path="/workers/:item" element={<ManageWorkspace />} />
      <Route path="/session/:sessionId" element={<Workspace />} />
      <Route path="/session/:sessionId/:panel" element={<Workspace />} />
    </Routes>
  );
}
