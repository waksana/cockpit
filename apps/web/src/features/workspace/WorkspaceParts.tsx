import { lazy, Suspense, type ComponentProps, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { SessionMeta } from '../../net/types';
import type { MenuItem } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { Button, IconButton } from '../../components/Button';
import { PaneHeader } from '../../components/PaneHeader';
import { GlobalNavigation } from '../../components/GlobalNavigation';
import { ConnectedThread } from '../../components/ConnectedThread';
import { RegionErrorBoundary } from '../../components/ErrorBoundary';
import { StateNotice } from '../../components/StateNotice';
import { AnchoredMenu } from '../../components/AnchoredMenu';
import { DirectoryModal } from '../../components/Dialog';
import { SessionDeleteDialog } from '../../components/SessionDeleteDialog';

const DirPicker = lazy(() => import('../../components/DirPicker').then((m) => ({ default: m.DirPicker })));

// Session list header: global navigation and the session search field.
export function SessionSearchHeader({ navigationKey, connected, query, onQuery }: {
  navigationKey: string; connected: boolean; query: string; onQuery: (query: string) => void;
}) {
  return (
    <PaneHeader className="sidebar-header" leading={<GlobalNavigation key={navigationKey} />}
      title={<div className="input-search">
        {connected ? (
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
          onChange={(e) => onQuery(e.target.value)}
          placeholder={connected ? '搜索会话或目录…' : '正在连接服务器…'}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="搜索会话"
        />
        {query && (
          <IconButton className="input-search-clear" icon="close" iconSize={20} label="清除" onClick={() => onQuery('')} />
        )}
      </div>} />
  );
}

// The detail pane body: the chat, or why there is none.
export function WorkspaceDetail({ active, syncing, notFound }: {
  active: SessionMeta | null; syncing: boolean; notFound: boolean;
}) {
  const navigate = useNavigate();
  return active ? (
    <RegionErrorBoundary key={active.sessionId} label="对话" className="pane-error">
      <ConnectedThread sessionId={active.sessionId} />
    </RegionErrorBoundary>
  ) : syncing ? (
    <StateNotice kind="loading" placement="pane">正在同步会话…</StateNotice>
  ) : notFound ? (
    <StateNotice kind="empty" placement="pane">
      <div>
        <p>这个会话不存在,或已被删除。</p>
        <Button variant="primary" onClick={() => void navigate('/')}>返回列表</Button>
      </div>
    </StateNotice>
  ) : (
    <StateNotice kind="empty" placement="pane">
      <p>选择一个会话，或新建会话。</p>
    </StateNotice>
  );
}

// Session menu, delete confirmation and the new-session directory picker.
export function WorkspaceOverlays({ active, kebabRef, detailMenuOpen, menuItems, deleteTarget, dirPicker,
  onCloseMenu, onCancelDelete, onDeleted, onCancelDirPicker, newSession, selectSession }: {
  active: SessionMeta | null; kebabRef: RefObject<HTMLButtonElement | null>; detailMenuOpen: boolean;
  menuItems: (session: SessionMeta) => MenuItem[];
  deleteTarget: { sessionId: string; name: string } | null; dirPicker: boolean;
  onCloseMenu: () => void; onCancelDelete: () => void; onDeleted: (sessionId: string) => void; onCancelDirPicker: () => void;
  newSession: ComponentProps<typeof DirPicker>['onCreate']; selectSession: (id: string) => void;
}) {
  const location = useLocation();
  return <>
    {detailMenuOpen && active && (
      <AnchoredMenu triggerRef={kebabRef} items={menuItems(active)} label={active.title}
        moduleTarget={{ menu: 'session', sessionId: active.sessionId }}
        onClose={onCloseMenu} />
    )}
    {deleteTarget && <SessionDeleteDialog key={`${location.key}:${deleteTarget.sessionId}`}
      sessionId={deleteTarget.sessionId} name={deleteTarget.name}
      onCancel={onCancelDelete}
      onSuccess={() => onDeleted(deleteTarget.sessionId)} />}
    {dirPicker && (
      <Suspense fallback={
        <DirectoryModal onCancel={onCancelDirPicker}>
            <StateNotice kind="loading" placement="pane">加载目录选择器…</StateNotice>
            <Button onClick={onCancelDirPicker}>取消</Button>
        </DirectoryModal>
      }>
        <DirPicker key={location.key} onCreate={newSession}
          onCreated={selectSession} onCancel={onCancelDirPicker} />
      </Suspense>
    )}
  </>;
}
