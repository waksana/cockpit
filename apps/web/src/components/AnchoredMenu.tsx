// Button-anchored dropdown — pinned to its trigger button's LIVE bounding rect,
// not to coordinates passed at click time (which can go stale on a layout shift).
// Rendered `fixed` because the pane layout deliberately clips overflow, so a CSS
// `absolute` child of the topbar would be cut off. The trigger's right edge is
// pinned via the CSS `right` property and the menu grows leftward + downward —
// so it is STRUCTURALLY impossible for the menu to spill past the viewport's
// right edge (the trigger is always on-screen). TG-style.

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { MenuItemButton, type MenuItem } from './ContextMenu';
import { useMenuDismiss } from '../lib/useMenuDismiss';

export function AnchoredMenu({ triggerRef, items, onClose, align = 'right' }: {
  triggerRef: RefObject<HTMLElement | null>;
  items: MenuItem[];
  onClose: () => void;
  align?: 'left' | 'right';
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Pin one edge to the trigger (via `right` or `left` = distance from that
  // viewport edge), top just below the trigger. Read the trigger's LIVE rect so
  // the position is always correct regardless of prior layout shifts. Anchoring an
  // edge to the on-screen trigger makes overflow on that side structurally
  // impossible.
  const [style, setStyle] = useState<{ left?: number; right?: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const gap = 4;
    const pad = 8;
    const top = r.bottom + gap;
    const maxHeight = window.innerHeight - r.bottom - gap - pad;
    if (align === 'left') setStyle({ left: Math.max(pad, r.left), top, maxHeight });
    else setStyle({ right: Math.max(pad, window.innerWidth - r.right), top, maxHeight });
  }, [triggerRef, items, align]);

  useMenuDismiss(onClose);

  return (
    <div
      ref={ref}
      className="btn-menu active"
      role="menu"
      style={{
        ...(style?.right != null ? { right: style.right, left: 'auto' } : {}),
        ...(style?.left != null ? { left: style.left, right: 'auto' } : {}),
        top: style?.top ?? 0,
        maxHeight: style?.maxHeight,
        overflowY: 'auto',
        visibility: style ? 'visible' : 'hidden',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it) => <MenuItemButton key={it.label} item={it} onClose={onClose} />)}
    </div>
  );
}
