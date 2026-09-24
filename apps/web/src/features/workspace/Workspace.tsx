// Session workspace: the responsive master-detail shell for every session
// route. The URL is the single source of truth for what's on screen:
//   /                       — session list, no chat
//   /session/:id            — that chat
//   /session/:id/info       — chat + info panel
//   /session/:id/mcp|skills — chat + details
// The global sections (/mcp, /skills and their /:item detail) render a
// separate master-detail <ManageWorkspace/>, not this Workspace.
// These session routes all render the SAME <Workspace/> (no remount).

import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { useCockpit } from '../../net/store';
import { useUp } from '../../lib/nav';
import { createSessionMetadataSelector } from '../../lib/sessionSelectors';
import { sessionNavigation, sessionRoute } from '../../lib/routeOwnership';
import { sessionActionItems, type SessionActionHandlers } from '../../lib/sessionActions';
import { Shell, MasterPane, DetailPane } from '../../components/Shell';
import { Sidebar } from '../../components/Sidebar';
import { NewSessionFab } from '../../components/NewSessionFab';
import { ChatHeader } from '../../components/ChatHeader';
import { SessionDetails } from '../../components/SessionDetails';
import { RegionErrorBoundary } from '../../components/ErrorBoundary';
import { useSessionDetails } from './useSessionDetails';
import { useWorkspaceOverlays } from './useWorkspaceOverlays';
import { SessionSearchHeader, WorkspaceDetail, WorkspaceOverlays } from './WorkspaceParts';

export function Workspace() {
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
  const {
    detailMenuOpen, setDetailMenuOpen, deleteTarget, setDeleteTarget, dirPicker, setDirPicker,
  } = useWorkspaceOverlays(location.key, !!active);
  const { kebabRef, openDetails } = useSessionDetails(routeId, panel);
  const navigate = useNavigate();
  const up = useUp();
  // Every focus/page change navigates.
  const selectSession = (id: string) => {
    const destination = sessionNavigation(location.pathname, id);
    void navigate(destination.to, { replace: destination.replace });
  };

  // The detail pane shows the chat, or — when the URL points at a session that
  // doesn't exist (bad deep-link or one deleted remotely) — a NotFound. Both sit
  // at the detail level on mobile so the message (and its back button) is visible.
  // Opening SSE is not a session list. Reconnect retains the old display until
  // the complete snapshot for this connection has been applied.
  const notFound = !active && routeId != null && snapshotReady;
  const syncing = !active && routeId != null && !snapshotReady;
  const mobileView: 'list' | 'detail' = active || notFound || syncing ? 'detail' : 'list';
  const connected = connState === 'open';

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
    sessionActionItems(session, connected && snapshotReady, menuHandlers)
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
    <Shell ariaLabel="cockpit" master={<MasterPane
        ariaLabel="会话列表"
        mobileVisible={mobileView === 'list'}
        header={<SessionSearchHeader navigationKey={location.key} connected={connected} query={query} onQuery={setQuery} />}
        overlay={
          <NewSessionFab
            disabled={!connected}
            onOpen={() => setDirPicker(true)}
          />
        }
      >
        <RegionErrorBoundary label="会话列表" resetKey={sessions} className="pane-error">
          <Sidebar
            sessions={sessions}
            activeId={routeId}
            query={query}
            snapshotReady={snapshotReady}
            connected={connected}
            onSelect={selectSession}
            getMenuItems={getSessionMenuItems}
          />
        </RegionErrorBoundary>
      </MasterPane>}
      main={<DetailPane ariaLabel="对话" mobileVisible={mobileView === 'detail'} header={detailHeader}>
        <WorkspaceDetail active={active} syncing={syncing} notFound={notFound} />
      </DetailPane>}
      inspector={panel && active && <SessionDetails key={active.sessionId} sessionId={active.sessionId} panel={panel} />}
      overlays={<WorkspaceOverlays active={active} kebabRef={kebabRef} detailMenuOpen={detailMenuOpen}
        menuItems={getSessionMenuItems} deleteTarget={deleteTarget} dirPicker={dirPicker}
        onCloseMenu={() => setDetailMenuOpen(false)} onCancelDelete={() => setDeleteTarget(null)}
        onDeleted={(sessionId) => {
          if (routeId === sessionId) void navigate('/', { replace: true });
        }}
        onCancelDirPicker={() => setDirPicker(false)} newSession={newSession} selectSession={selectSession} />} />
  );
}
