// Session list (master pane) — tweb .chatlist contract. One unified list of
// every session on the box (each maps 1:1 to a Copilot session). Per-row actions
// via right-click (desktop) / long-press (mobile) → context menu.
// Pinned sessions form a top group. Search/filtering is owned by the header
// (App); this component receives the query string read-only.

import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ChatSession, SessionStatus } from '../net/types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Icon';
import { useLongPress } from '../lib/longpress';

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
  onMenu: (x: number, y: number) => void;
}

function SessionRow({ s, active, pinned, actions }: {
  s: ChatSession; active: boolean; pinned: boolean; actions: RowActions;
}) {
  const firedRef = useRef(false);
  const lp = useLongPress(actions.onMenu, firedRef);

  const statusText = STATUS_TEXT[s.status] ?? '';
  const { mono, hue } = cwdChip(s.cwd);
  // A raised attention is "seen" once the per-user seenId catches its attnId. A
  // 'ready' is cleared server-side on sight (so attention==='ready' is always
  // unseen here); a 'choice' lingers, shown demoted once seen, until answered.
  const choiceSeen = (s.seenId ?? 0) >= (s.attnId ?? 0);

  return (
    <li
      className={`chatlist-chat${active ? ' active' : ''}${s.loaded ? '' : ' is-unloaded'}`}
      onClick={() => { if (!firedRef.current) actions.onSelect(); }}
      onContextMenu={lp.onContextMenu}
      onPointerDown={lp.onPointerDown}
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
          ? <span className={`dialog-choice${choiceSeen ? ' is-seen' : ''}`} title="等你回答">选</span>
          : s.attention === 'ready'
          ? <span className="dialog-unread" title="有新结果">新</span>
          : null}
      </span>
    </li>
  );
}

interface SidebarProps {
  sessions: ChatSession[];
  activeId: string | null;
  query: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onReload: (id: string) => void;
  onUnload: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    sessions, activeId, query,
    onSelect, onDelete, onReload, onUnload, onPin,
  } = props;
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // Pin is authoritative server state (s.pinned) — a pinned session is sorted to
  // the top AND kept resident, synced across every device. No localStorage.
  const q = query.trim().toLowerCase();
  const filtered = sessions
    .filter((s) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q))
    .sort((a, b) => b.lastActivity - a.lastActivity);
  // Flow-spawned workers (R1 spawnedBy mark) are KEPT, not deleted (decision F7),
  // so they would flood the list. They live on their OWN page (hamburger → 自动
  // 会话, /workers) and are excluded from the main list entirely — EXCEPT a pinned
  // worker, which the user deliberately kept up top (stays in the pin group).
  const pinnedList = filtered.filter((s) => s.pinned);
  const restList = filtered.filter((s) => !s.pinned && !s.spawnedBy);

  const openMenu = (s: ChatSession) => (x: number, y: number) => {
    const running = s.status === 'running';
    const isPinned = !!s.pinned;
    setMenu({
      x, y,
      items: [
        { label: isPinned ? '取消置顶' : '置顶', icon: isPinned ? 'unpin' : 'pin', onClick: () => onPin(s.sessionId, !isPinned) },
        { label: '重载', icon: 'reload', onClick: () => onReload(s.sessionId), disabled: running },
        ...(s.loaded ? [{ label: '卸载', icon: 'unload' as const, onClick: () => onUnload(s.sessionId), disabled: running }] : []),
        { label: '删除', icon: 'delete' as const, onClick: () => onDelete(s.sessionId), destructive: true },
      ],
    });
  };

  const renderRow = (s: ChatSession) => (
    <SessionRow
      key={s.sessionId}
      s={s}
      active={s.sessionId === activeId}
      pinned={!!s.pinned}
      actions={{ onSelect: () => onSelect(s.sessionId), onMenu: openMenu(s) }}
    />
  );

  return (
    <ul className="chatlist">
      {pinnedList.length > 0 && <li className="chatlist-group-title" aria-hidden="true">置顶</li>}
      {pinnedList.map(renderRow)}
      {pinnedList.length > 0 && restList.length > 0 && (
        <li className="chatlist-group-title" aria-hidden="true">全部</li>
      )}
      {restList.map(renderRow)}
      {filtered.length === 0 && (
        <li className="chatlist-empty">{q ? '没有匹配的会话' : '服务器上没有 session'}</li>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </ul>
  );
}
