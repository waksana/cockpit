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
import { menuFocusTarget } from '../lib/menuFocus';
import type { ModuleMenuTarget } from '@cockpit/module-api';
import { useRegisteredMenu } from './useRegisteredMenu';

export function AnchoredMenu({ triggerRef, items: nativeItems, onClose, align = 'right', label, moduleTarget }: {
  triggerRef: RefObject<HTMLElement | null>;
  items: MenuItem[];
  onClose: () => void;
  align?: 'left' | 'right';
  label?: string;
  moduleTarget?: ModuleMenuTarget;
}) {
  const items = useRegisteredMenu(nativeItems, moduleTarget);
  const ref = useRef<HTMLDivElement | null>(null);
  const focusInitialized = useRef(false);
  const focusedItem = useRef<HTMLButtonElement | null>(null);
  // Pin one edge to the trigger (via `right` or `left` = distance from that
  // viewport edge), top just below the trigger. Read the trigger's LIVE rect so
  // the position is always correct regardless of prior layout shifts. Anchoring an
  // edge to the on-screen trigger makes overflow on that side structurally
  // impossible.
  const [style, setStyle] = useState<{ left?: number; right?: number; top: number; maxHeight: number; maxWidth: number } | null>(null);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const gap = 4;
    const pad = 8;
    const top = r.bottom + gap;
    const maxHeight = window.innerHeight - r.bottom - gap - pad;
    const inset = Math.max(pad, align === 'left' ? r.left : window.innerWidth - r.right);
    const next = {
      left: align === 'left' ? inset : undefined, right: align === 'right' ? inset : undefined,
      top, maxHeight, maxWidth: window.innerWidth - inset - pad,
    };
    setStyle(previous => previous?.left === next.left && previous?.right === next.right
      && previous?.top === next.top && previous?.maxHeight === next.maxHeight
      && previous?.maxWidth === next.maxWidth ? previous : next);
  }, [triggerRef, items, align]);
  const visible = style !== null;
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!visible || !menu) return;
    const enabled = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    const target = menuFocusTarget(focusInitialized.current, focusedItem.current, enabled);
    focusInitialized.current = true;
    if (target !== undefined) {
      focusedItem.current = target;
      (target ?? menu).focus();
    }
  }, [visible, items]);

  const close = (restoreFocus = true) => {
    onClose();
    if (restoreFocus) triggerRef.current?.focus();
  };
  useMenuDismiss(close);

  return (
    <div
      ref={ref}
      className="btn-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{
        ...(style?.right != null ? { right: style.right, left: 'auto' } : {}),
        ...(style?.left != null ? { left: style.left, right: 'auto' } : {}),
        top: style?.top ?? 0,
        maxHeight: style?.maxHeight,
        maxWidth: style?.maxWidth,
        overflowY: 'auto',
        visibility: style ? 'visible' : 'hidden',
      }}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLButtonElement && event.target.getAttribute('role') === 'menuitem') {
          focusedItem.current = event.target;
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
        buttons[next].scrollIntoView({ block: 'nearest' });
      }}
    >
      {label && <div className="btn-menu-caption" aria-hidden="true">{label}</div>}
      {items.map((it) => <MenuItemButton key={it.id ?? it.label} item={it} onClose={close} />)}
    </div>
  );
}
