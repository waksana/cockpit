// Session list (master pane) — tweb .chatlist contract. One unified list of
// every session on the box (each maps 1:1 to a Copilot session). Per-row actions
// via right-click (desktop) / long-press (mobile) → context menu.
// Pinned sessions form a top group. Search/filtering is owned by the header
// (App); this component receives the query string read-only.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SessionMeta, SessionStatus } from '../net/types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Icon';
import { useLongPress } from '../lib/longpress';
import { groupSessions } from '../pages/session-list';
import { isUnreadAttention } from '../lib/inboxProjection';
import { menuFocusTarget } from '../lib/menuFocus';

const STATUS_TEXT: Record<SessionStatus, string> = {
  unloaded: '', idle: '', running: '回复中', error: '出错',
};

function cwdBasename(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd;
}
function cwdChip(cwd: string): { mono: string; hue: number } {
  const base = cwdBasename(cwd);
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (hash * 31 + cwd.charCodeAt(i)) >>> 0;
  const cjk = base.match(/[\u4e00-\u9fff]/);
  const mono = cjk ? cjk[0] : (base.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '·');
  return { mono, hue: hash % 360 };
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

function SessionRow({ s, active, pinned, actions }: {
  s: SessionMeta; active: boolean; pinned: boolean; actions: RowActions;
}) {
  const firedRef = useRef(false);
  const lp = useLongPress(actions.onMenu, firedRef);

  const statusText = STATUS_TEXT[s.status] ?? '';
  const { mono, hue } = cwdChip(s.cwd);
  const unread = isUnreadAttention(s);

  return (
    <li
      className={`chatlist-chat${active ? ' active' : ''}${s.loaded ? '' : ' is-unloaded'}`}
      role="button"
      data-session-id={s.sessionId}
      tabIndex={0}
      aria-current={active ? true : undefined}
      aria-haspopup="menu"
      onClick={(e) => { if (e.detail === 0 || !firedRef.current) actions.onSelect(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!e.repeat) actions.onSelect();
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
      <span className="dialog-avatar" style={{ '--chip-h': hue } as CSSProperties} aria-hidden="true">{mono}</span>
      <span className="dialog-title">{s.title}</span>
      <span className="dialog-time">{relTime(s.lastActivity)}</span>
      <span className="dialog-subtitle">{cwdBasename(s.cwd)}</span>
      <span className="dialog-meta">
        {!!s.scheduleCount && s.scheduleCount > 0 && (
          <span className="dialog-schedule" title={`${s.scheduleCount} 个定时任务`}><Icon name="schedule" size={15} /></span>
        )}
        {pinned && <span className="dialog-pinned" title="已置顶"><Icon name="pin" size={15} /></span>}
        {statusText && <span className="dialog-status" data-tone={s.status}>{statusText}</span>}
        {s.attention === 'choice'
          ? <span className={`dialog-choice${unread ? '' : ' is-seen'}`} title={unread ? '未读 · 需要选择' : '已读 · 仍需选择'} aria-label={unread ? '未读，需要选择' : '已读，仍需选择'}>选</span>
          : unread
          ? <span className="dialog-unread" title="有新结果">新</span>
          : null}
      </span>
    </li>
  );
}

interface SidebarProps {
  sessions: SessionMeta[];
  activeId: string | null;
  query: string;
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
    sessions, activeId, query,
    onSelect, getMenuItems,
  } = props;
  const [menu, setMenu] = useState<SessionMenu | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const menuRef = useRef<HTMLLIElement | null>(null);
  const focusInitialized = useRef(false);
  const focusedItem = useRef<HTMLButtonElement | null>(null);
  const menuSession = menu && sessions.find(s => s.sessionId === menu.sessionId);
  const menuItems = useMemo(() => menuSession ? getMenuItems(menuSession) : [], [menuSession, getMenuItems]);
  if (menu && (!menuSession || menu.activeId !== activeId)) setMenu(null);

  // Pin is authoritative server state (s.pinned) — a pinned session is sorted to
  // the top, synced across every device. No localStorage.
  const { pinnedList, restList } = groupSessions(sessions, query);

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const enabled = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    const target = menuFocusTarget(focusInitialized.current, focusedItem.current, enabled);
    if (target !== undefined) (target ?? menuRef.current).focus();
    focusInitialized.current = true;
  }, [menu, menuItems]);

  const closeMenu = () => {
    setMenu(null);
    const trigger = menu?.trigger;
    const row = trigger?.isConnected ? trigger : Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-session-id]') ?? [],
    ).find(element => element.dataset.sessionId === menu?.sessionId);
    row?.focus();
  };

  const openMenu = (s: SessionMeta) => (x: number, y: number, trigger?: HTMLElement) => {
    focusInitialized.current = false;
    focusedItem.current = null;
    setMenu({ x, y, trigger, sessionId: s.sessionId, activeId });
  };

  const renderRow = (s: SessionMeta) => (
    <SessionRow
      key={s.sessionId}
      s={s}
      active={s.sessionId === activeId}
      pinned={!!s.pinned}
      actions={{ onSelect: () => onSelect(s.sessionId), onMenu: openMenu(s) }}
    />
  );

  return (
    <ul ref={listRef} className="chatlist">
      {pinnedList.length > 0 && <li className="chatlist-group-title"><span role="heading" aria-level={2}>置顶</span></li>}
      {pinnedList.map(renderRow)}
      {pinnedList.length > 0 && restList.length > 0 && (
        <li className="chatlist-group-title"><span role="heading" aria-level={2}>全部</span></li>
      )}
      {restList.map(renderRow)}
      {pinnedList.length === 0 && restList.length === 0 && (
        <li className="chatlist-empty">{query.trim() ? '没有匹配的会话' : '服务器上没有 session'}</li>
      )}
      {menu && menuSession && menu.activeId === activeId && (
        <li
          ref={menuRef}
          role="none"
          tabIndex={-1}
          onFocusCapture={(e) => {
            if (e.target instanceof HTMLButtonElement && e.target.getAttribute('role') === 'menuitem') {
              focusedItem.current = e.target;
            }
          }}
          onKeyDown={(e) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault();
            const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
            if (!items.length) return;
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
              : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next].focus();
            items[next].scrollIntoView({ block: 'nearest' });
          }}
        >
          <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} label={menuSession.title} />
        </li>
      )}
    </ul>
  );
}
