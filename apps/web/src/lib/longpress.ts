// Long-press + right-click → context-menu primitive. One unified gesture layer
// (replaces ad-hoc per-component handlers). Touch: a press held LONG_PRESS_MS
// without moving opens the menu at the touch point; because the app root sets
// user-select:none, the press never selects text or pops the iOS loupe. Mouse:
// contextmenu (right-click) opens at the cursor. A small move budget cancels
// the long-press so scrolling/swiping still works.

import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
  onContextMenu: (e: ReactPointerEvent | React.MouseEvent) => void;
}

// `open(x, y, trigger)` is called with viewport coords when the gesture fires.
// `firedRef` (optional) is set true while a long-press just opened the menu, so
// the consumer can suppress the subsequent click/tap.
export function useLongPress(
  open: (x: number, y: number, trigger?: HTMLElement) => void,
  firedRef?: { current: boolean },
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return; // desktop uses contextmenu
    start.current = { x: e.clientX, y: e.clientY };
    if (firedRef) firedRef.current = false;
    clear();
    const { clientX, clientY } = e;
    const trigger = e.currentTarget as HTMLElement;
    timer.current = setTimeout(() => {
      if (firedRef) firedRef.current = true;
      open(clientX, clientY, trigger);
    }, LONG_PRESS_MS);
  }, [open, firedRef, clear]);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!start.current) return;
    const dx = Math.abs(e.clientX - start.current.x);
    const dy = Math.abs(e.clientY - start.current.y);
    if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) clear();
  }, [clear]);

  const onPointerUp = useCallback(() => { clear(); start.current = null; }, [clear]);
  const onPointerCancel = useCallback(() => { clear(); start.current = null; }, [clear]);

  const onContextMenu = useCallback((e: ReactPointerEvent | React.MouseEvent) => {
    e.preventDefault();
    open(e.clientX, e.clientY, e.currentTarget as HTMLElement);
  }, [open]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenu };
}
