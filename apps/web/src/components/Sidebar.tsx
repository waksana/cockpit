// Session list (master pane) — tweb .chatlist contract. One unified list of
// every session on the box (each maps 1:1 to a Copilot session). Per-row actions
// via right-click (desktop) / long-press (mobile) → context menu.
// Search/filtering is owned by the header
// (App); this component receives the query string read-only.

import { useMemo, useRef, useState } from 'react';
import type { ChatSession, SessionMeta } from '../net/types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { useLongPress } from '../lib/longpress';
import { filterSessions } from '../pages/session-list';
import { StateNotice } from './StateNotice';
import { SessionStatus } from './ModuleComponents';
import { RoleBadge } from './ModuleLabel';
import { useCockpit } from '../net/store';

function cwdBasename(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd;
}
function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}分`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}时`;
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

interface RowActions {
  onSelect: () => void;
  onMenu: (x: number, y: number, trigger?: HTMLElement) => void;
}

function SessionRow({ s, active, actions, connected }: {
  s: SessionMeta & Pick<ChatSession, 'activityDisplay'>; active: boolean; actions: RowActions; connected: boolean;
}) {
  const firedRef = useRef(false);
  const activityRefreshing = useCockpit(state => state.activityRefreshingIds.includes(s.sessionId));
  const lp = useLongPress(actions.onMenu, firedRef);

  return (
    <li><button
      type="button"
      className={`chatlist-chat ck-button${active ? ' active' : ''}${s.loaded ? '' : ' is-unloaded'}`}
      data-session-id={s.sessionId}
      tabIndex={0}
      aria-current={active ? true : undefined}
      aria-haspopup="menu"
      onClick={(e) => { if (e.detail === 0 || !firedRef.current) actions.onSelect(); }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.repeat) {
          e.preventDefault();
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          actions.onMenu(rect.left, rect.bottom, e.currentTarget);
        }
      }}
      onContextMenu={lp.onContextMenu}
      onPointerDown={(e) => { firedRef.current = false; lp.onPointerDown(e); }}
      onPointerMove={lp.onPointerMove}
      onPointerUp={lp.onPointerUp}
      onPointerCancel={lp.onPointerCancel}
    >
      <span className="session-row-title" title={s.title}>{s.title}</span>
      <span className="dialog-time">{relTime(s.lastActivity)}</span>
      <span className="session-row-details">
        {!!s.roles?.length && <span className="dialog-roles session-role-badges">
          {s.roles.map(role => <RoleBadge key={`${role.moduleId}/${role.roleId}`} role={role} session={s} connected={connected} />)}
        </span>}
        <span className="dialog-subtitle" title={s.cwd}>{cwdBasename(s.cwd)}</span>
        <SessionStatus sessionId={s.sessionId} status={s.status} loaded={s.loaded} connected={connected}
          compacting={s.compacting} error={s.error}
          activityRefreshing={activityRefreshing}
          activityDisplay={s.activityDisplay}
          activity={s.activity} needsDecision={!!(s.ask || s.planRequest || s.elicitation)} />
      </span>
    </button></li>
  );
}

interface SidebarProps {
  sessions: SessionMeta[];
  activeId: string | null;
  query: string;
  snapshotReady: boolean;
  connected: boolean;
  onSelect: (id: string) => void;
  getMenuItems: (session: SessionMeta) => MenuItem[];
}

interface SessionMenu {
  x: number;
  y: number;
  sessionId: string;
  activeId: string | null;
  trigger?: HTMLElement;
}

export function Sidebar(props: SidebarProps) {
  const {
    sessions, activeId, query, snapshotReady, connected,
    onSelect, getMenuItems,
  } = props;
  const [menu, setMenu] = useState<SessionMenu | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const menuSession = menu && sessions.find(s => s.sessionId === menu.sessionId);
  const menuItems = useMemo(() => menuSession ? getMenuItems(menuSession) : [], [menuSession, getMenuItems]);
  if (menu && (!menuSession || menu.activeId !== activeId)) setMenu(null);

  const visible = filterSessions(sessions, query);

  const closeMenu = (restoreFocus = true) => {
    setMenu(null);
    if (!restoreFocus) return;
    const trigger = menu?.trigger;
    const row = trigger?.isConnected ? trigger : Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-session-id]') ?? [],
    ).find(element => element.dataset.sessionId === menu?.sessionId);
    row?.focus();
  };

  const openMenu = (s: SessionMeta) => (x: number, y: number, trigger?: HTMLElement) => {
    setMenu({ x, y, trigger, sessionId: s.sessionId, activeId });
  };

  const renderRow = (s: SessionMeta) => (
    <SessionRow
      key={s.sessionId}
      s={s}
      connected={connected && snapshotReady}
      active={s.sessionId === activeId}
      actions={{ onSelect: () => onSelect(s.sessionId), onMenu: openMenu(s) }}
    />
  );

  return (
    <ul ref={listRef} className="chatlist" aria-busy={!snapshotReady}>
      {visible.map(renderRow)}
      {visible.length === 0 && (
        <li className="chatlist-empty"><StateNotice kind={!snapshotReady ? connected ? 'loading' : 'info' : 'empty'}>
          {!snapshotReady ? connected ? '正在同步会话…' : '等待连接…' : query.trim() ? '没有匹配的会话' : '服务器上没有 session'}
        </StateNotice></li>
      )}
      {menu && menuSession && menu.activeId === activeId && (
        <li role="none">
          <ContextMenu key={menu.sessionId} x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} label={menuSession.title}
            moduleTarget={{ menu: 'session', sessionId: menu.sessionId }} />
        </li>
      )}
    </ul>
  );
}
