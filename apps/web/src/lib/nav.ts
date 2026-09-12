// Hierarchical "Up" navigation on top of react-router. cockpit's routes form a
// strict tree, so every screen's parent is computable from the URL alone. The
// bug this fixes: in-app "back" controls used to PUSH (navigate('/')), so list →
// chat → in-app-back left the stack as [/, /session/x, /] and the system/PWA back
// button then popped INTO the chat ("from home, back dives into a session").
//
// Fix: in-app back/close/scrim go "Up" — pop the real history entry when it is
// already the parent (clean, restores the parent's scroll/forward state), else
// synthesize the parent with replace so we land exactly one level up instead of
// pushing a duplicate. Combined with push-deeper / replace-lateral discipline at
// the navigation sites, the real history stack mirrors the hierarchy, so the
// system Back button == Up for every normal flow. (iOS standalone PWAs have no
// system back button at all, so a deterministic in-app Up matters doubly.)

import { useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

// react-router stores the in-app stack position at window.history.state.idx. We
// mirror "pathname seen at each idx" so useUp() can check the entry directly
// behind the current one. Only the immediately-behind entry (idx-1) is ever read,
// and the content at any idx is re-recorded whenever it changes (push/replace/pop
// all fire a location change), so the map never needs pruning to stay faithful.
const seenByIdx = new Map<number, string>();

function historyIdx(): number {
  if (typeof window === 'undefined') return 0;
  const idx = (window.history.state as { idx?: number } | null)?.idx;
  return typeof idx === 'number' ? idx : 0;
}

// Record the pathname now showing at the current history index. Call on every
// location change (see useHistoryTracker).
export function recordLocation(pathname: string): void {
  seenByIdx.set(historyIdx(), pathname);
}

// The hierarchical parent of a path:
//   /                         → /            (root, no parent)
//   /mcp|skills               → /
//   /mcp|skills/:item         → /section
//   /session/:id              → /
//   /session/:id/:panel       → /session/:id
export function parentOf(pathname: string): string {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/') return '/';
  const seg = clean.split('/').filter(Boolean);
  if (seg[0] === 'session') return seg.length >= 3 ? `/session/${seg[1]}` : '/';
  if (seg[0] === 'mcp' || seg[0] === 'skills') {
    return seg.length >= 2 ? `/${seg[0]}` : '/';
  }
  return '/';
}

// Go one level up. Pass an explicit target to override the computed parent (used
// by the section list header, whose "back" always means "exit to the session
// list" regardless of a selected item). Pops to the destination when the real
// entry behind is already it; otherwise replaces, never pushes.
export function useUp(): (target?: string) => void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return useCallback(
    (target?: string) => {
      const dest = target ?? parentOf(pathname);
      const idx = historyIdx();
      if (idx > 0 && seenByIdx.get(idx - 1) === dest) navigate(-1);
      else navigate(dest, { replace: true });
    },
    [navigate, pathname],
  );
}
