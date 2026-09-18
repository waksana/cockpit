// App root. Wires the native session store to the responsive master-detail shell.
// Desktop: sidebar + chat side-by-side. Mobile: list ↔ detail two-level nav.

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, Routes, Route, useNavigate, useLocation, useParams } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { useCockpit } from './net/store';
import { useUp, recordLocation } from './lib/nav';
import { createSessionMetadataSelector } from './lib/sessionSelectors';
import {
  detailsNavigation, focusedSessionId, sessionNavigation,
  sessionRoute, SESSION_PANELS, type SessionPanel,
} from './lib/routeOwnership';
import { Shell, MasterPane, DetailPane } from './components/Shell';
import { Sidebar } from './components/Sidebar';
import { ConnectedThread } from './components/ConnectedThread';
import { NewSessionFab } from './components/NewSessionFab';
import { Icon } from './components/Icon';
import { ChatHeader } from './components/ChatHeader';
import { AnchoredMenu } from './components/AnchoredMenu';
import { DirectoryModal } from './components/Dialog';
import { GlobalNavigation } from './components/GlobalNavigation';
import { sessionActionItems, type SessionActionHandlers } from './lib/sessionActions';
import { SessionDetails } from './components/SessionDetails';
import { SessionDeleteDialog } from './components/SessionDeleteDialog';
import { StateNotice } from './components/StateNotice';
import { ManagementShell } from './components/ManagementShell';
import { moduleRuntime } from './lib/moduleRuntime';
import { observeModuleView } from './lib/moduleView';

const ManageWorkspace = lazy(() => import('./components/ManageWorkspace').then((m) => ({ default: m.ManageWorkspace })));
const DirPicker = lazy(() => import('./components/DirPicker').then((m) => ({ default: m.DirPicker })));

function ManagementRoute() {
  const { pathname } = useLocation();
  const { item } = useParams();
  const section = pathname.startsWith('/skills') ? 'skills' : 'mcp';
  return <Suspense fallback={
    <ManagementShell section={section} item={item ?? null}
      master={<StateNotice kind="loading" placement="pane">加载页面…</StateNotice>}
      detail={<StateNotice kind="loading" placement="pane">加载页面…</StateNotice>} />
  }><ManageWorkspace section={section} /></Suspense>;
}

const PHONE_QUERY = '(max-width: 599px)';
const phoneSnapshot = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
const serverPhoneSnapshot = () => false;
function subscribePhone(listener: () => void) {
  const query = window.matchMedia?.(PHONE_QUERY);
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}

function Workspace() {
  const location = useLocation();
  const { sessionId: routeId, panel } = sessionRoute(location.pathname);
  const selectMetadata = useMemo(() => createSessionMetadataSelector(), []);
  const sessions = useCockpit(selectMetadata);
  const {
    connState, snapshotReady, newSession,
    globalModels,
  } = useCockpit(useShallow((s) => ({
    connState: s.connState, snapshotReady: s.snapshotReady, newSession: s.newSession,
    globalModels: s.globalModels,
  })));
  const active = useMemo(
    () => sessions.find((s) => s.sessionId === routeId) ?? null,
    [sessions, routeId],
  );
  const [query, setQuery] = useState('');
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLButtonElement | null>(null);
  const [panelTrigger, setPanelTrigger] = useState<{ sessionId: string; element: HTMLElement | null } | null>(null);
  const previousPanel = useRef<{ sessionId: string | null; open: boolean }>({ sessionId: null, open: false });
  useEffect(() => {
    if (!panel && previousPanel.current.open && previousPanel.current.sessionId === routeId) {
      const trigger = panelTrigger?.sessionId === routeId ? panelTrigger.element : null;
      const valid = trigger?.isConnected && trigger.getClientRects().length && !trigger.closest('[inert]');
      (valid ? trigger : kebabRef.current)?.focus();
    }
    previousPanel.current = { sessionId: routeId, open: panel !== null };
  }, [panel, routeId, panelTrigger]);
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; name: string } | null>(null);
  const [dirPicker, setDirPicker] = useState(false);
  const [overlayRoute, setOverlayRoute] = useState(location.key);
  if (overlayRoute !== location.key) {
    setOverlayRoute(location.key);
    setDeleteTarget(null);
    setDirPicker(false);
    setDetailMenuOpen(false);
  }

  // ── URL is the single source of truth for what's on screen ──────────────────
  // The whole UI projects from the path; every focus/page change navigates.
  //   /                       — session list, no chat
  //   /session/:id            — that chat
  //   /session/:id/info       — chat + info panel
  //   /session/:id/mcp|skills — chat + details
  // The global sections (/mcp, /skills and their /:item detail) render a
  // separate master-detail <ManageWorkspace/>, not this Workspace.
  // These session routes all render the SAME <Workspace/> (no remount).
  const navigate = useNavigate();
  const up = useUp();
  const selectSession = (id: string) => {
    const destination = sessionNavigation(location.pathname, id);
    navigate(destination.to, { replace: destination.replace });
  };
  const openDetails = useCallback((id: string, nextPanel: SessionPanel = 'info') => {
    const focused = document.activeElement;
    const element = focused instanceof HTMLElement && !focused.closest('[role="menu"]')
      ? focused
      : focused?.closest('.chatlist')
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-session-id]')).find(row => row.dataset.sessionId === id) ?? null
        : document.querySelector<HTMLElement>('.chat-topbar-more');
    setPanelTrigger({ sessionId: id, element });
    const destination = detailsNavigation(location.pathname, id, nextPanel);
    navigate(destination.to, { replace: destination.replace });
  }, [location.pathname, navigate]);

  // The detail pane shows the chat, or — when the URL points at a session that
  // doesn't exist (bad deep-link or one deleted remotely) — a NotFound. Both sit
  // at the detail level on mobile so the message (and its back button) is visible.
  // Opening SSE is not a session list. Reconnect retains the old display until
  // the complete snapshot for this connection has been applied.
  const notFound = !active && routeId != null && snapshotReady;
  const syncing = !active && routeId != null && !snapshotReady;
  const mobileView: 'list' | 'detail' = active || notFound || syncing ? 'detail' : 'list';

  const doNewSession = () => {
    setDirPicker(true);
  };
  const masterHeader = (
    <header className="sidebar-header">
      <GlobalNavigation key={location.key} />
      <div className="input-search">
        {connState === 'open' ? (
          <span className="input-search-icon"><Icon name="search" size={20} /></span>
        ) : (
          <>
            <Icon name="loading" className="spinner" size={16} />
            <span className="chat-sr-only" role="status">连接中</span>
          </>
        )}
        <input
          type="search"
          className="input-search-input ck-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={connState === 'open' ? '搜索会话或目录…' : '正在连接服务器…'}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="搜索会话"
        />
        {query && (
          <button type="button" className="input-search-clear ck-icon-button" aria-label="清除" onClick={() => setQuery('')}>
            <Icon name="close" size={20} />
          </button>
        )}
      </div>
    </header>
  );

  const doDelete = (sessionId: string) => {
    const s = sessions.find((x) => x.sessionId === sessionId);
    const name = s?.title?.trim() || '该会话';
    setDeleteTarget({ sessionId, name });
  };
  const menuHandlers: SessionActionHandlers = {
    openPanel: openDetails,
    delete: doDelete,
  };
  const getSessionMenuItems = (session: typeof sessions[number]) => (
    sessionActionItems(session, connState === 'open', menuHandlers)
  );

  const modelLabel = active
    ? ((active.availableModels ?? globalModels).find((m) => m.modelId === active.currentModelId)?.name
       ?? active.currentModelId ?? '')
    : '';

  const detailHeader = active ? (
    <ChatHeader title={active.title} modelLabel={modelLabel}
      moreRef={kebabRef} moreOpen={detailMenuOpen}
      onBack={() => up()} onInfo={() => openDetails(active.sessionId)}
      onMore={() => setDetailMenuOpen(true)} />
  ) : undefined;

  return (
    <Shell ariaLabel="cockpit" infoOpen={panel !== null && !!active}>
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
          activeId={routeId}
          query={query}
          snapshotReady={snapshotReady}
          connected={connState === 'open'}
          onSelect={selectSession}
          getMenuItems={getSessionMenuItems}
        />
      </MasterPane>

      <DetailPane ariaLabel="对话" mobileVisible={mobileView === 'detail'} header={detailHeader}>
        {active ? (
          <ConnectedThread
            key={active.sessionId}
            sessionId={active.sessionId}
          />
        ) : syncing ? (
          <StateNotice kind="loading" placement="pane">正在同步会话…</StateNotice>
        ) : notFound ? (
          <div className="detail-empty">
            <div>
              <p>这个会话不存在,或已被删除。</p>
              <button type="button" className="dialog-btn ck-button ck-primary primary rp" onClick={() => navigate('/')}>返回列表</button>
            </div>
          </div>
        ) : (
          <div className="detail-empty">
            <p>选择一个会话，或新建会话。</p>
          </div>
        )}
      </DetailPane>
      {detailMenuOpen && active && (
        <AnchoredMenu triggerRef={kebabRef} items={getSessionMenuItems(active)} label={active.title}
          onClose={() => setDetailMenuOpen(false)} />
      )}
      {deleteTarget && <SessionDeleteDialog key={`${location.key}:${deleteTarget.sessionId}`}
        sessionId={deleteTarget.sessionId} name={deleteTarget.name}
        onCancel={() => setDeleteTarget(null)}
        onSuccess={() => {
          if (routeId === deleteTarget.sessionId) navigate('/', { replace: true });
        }} />}
      {dirPicker && (
        <Suspense fallback={
          <DirectoryModal onCancel={() => setDirPicker(false)}>
              <StateNotice kind="loading" placement="pane">加载目录选择器…</StateNotice>
              <button type="button" className="dialog-btn ck-button rp" onClick={() => setDirPicker(false)}>取消</button>
          </DirectoryModal>
        }>
          <DirPicker key={location.key} onCreate={newSession}
            onCreated={selectSession} onCancel={() => setDirPicker(false)} />
        </Suspense>
      )}
      {panel && active && (
        <SessionDetails key={active.sessionId} sessionId={active.sessionId} panel={panel} />
      )}
    </Shell>
  );
}

export default function App() {
  const location = useLocation();
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot, serverPhoneSnapshot);
  const activeId = useCockpit((s) => s.activeId);
  const setActiveId = useCockpit((s) => s.setActiveId);
  const focusedId = focusedSessionId(location.pathname, phone);
  // Data-layer focus follows visible chat ownership, never the other way around.
  // Global routes and full-page details release the visible chat read.
  useLayoutEffect(() => {
    if (activeId !== focusedId) setActiveId(focusedId);
  }, [activeId, focusedId, setActiveId]);
  useLayoutEffect(() => observeModuleView(moduleRuntime, useCockpit, document), []);
  useEffect(() => { document.title = 'cockpit'; }, []);
  // Single client lifecycle: connect the SSE stream once on mount.
  useEffect(() => useCockpit.getState().init(), []);
  // Track the pathname showing at each history index so useUp() (in lib/nav) can
  // tell when "back" can pop to the real parent vs. must synthesize it. Runs for
  // every navigation across BOTH Workspace and ManageWorkspace.
  useLayoutEffect(() => { recordLocation(location.pathname); }, [location.key, location.pathname]);
  // Session routes share Workspace; global management has its own route shell.
  // Changing a panel preserves Workspace, while visible chat ownership decides
  // whether ConnectedThread is mounted. Neither shell owns native resource data.
  return (
      <Routes>
      <Route path="/" element={<Workspace />} />
      <Route path="/mcp" element={<ManagementRoute />} />
      <Route path="/mcp/:item" element={<ManagementRoute />} />
      <Route path="/skills" element={<ManagementRoute />} />
      <Route path="/skills/:item" element={<ManagementRoute />} />
      <Route path="/session/:sessionId" element={<Workspace />} />
      {SESSION_PANELS.map(panel => (
        <Route key={panel} path={`/session/:sessionId/${panel}`} element={<Workspace />} />
      ))}
      <Route path="*" element={<div className="detail-empty">
        <div><p>页面不存在。</p><Link className="dialog-btn ck-button ck-primary primary rp" to="/">返回列表</Link></div>
      </div>} />
      </Routes>
  );
}
