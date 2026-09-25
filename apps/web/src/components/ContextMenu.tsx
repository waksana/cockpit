// Pointer-anchored context menu — appears at an arbitrary (x,y) pointer location
// (right-click / long-press on session rows). Rendered fixed; flips
// left/up near the viewport edges. For BUTTON-anchored dropdowns (kebab, etc.)
// use AnchoredMenu instead — it pins to the trigger's live rect so it can never
// drift off-screen.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { useMenuDismiss } from '../lib/useMenuDismiss';
import type { ModuleMenuTarget } from '@cockpit/module-api/frontend';
import { useRegisteredMenu } from './useRegisteredMenu';
import { menuFocusTarget } from '../lib/menuFocus';

export interface MenuItem {
  id?: string;
  label: string;
  icon?: IconName;
  iconContent?: ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function MenuItemButton({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  return (
    <>
      {item.separatorBefore && <div className="btn-menu-separator" role="separator" />}
      <button
        type="button"
        role="menuitem"
        className={`btn-menu-item ck-button${item.destructive ? ' ck-danger' : ''}`}
        disabled={item.disabled}
        onClick={() => {
          if (item.disabled) return;
          try { item.onClick(); } finally { onClose(); }
        }}
      >
        {(item.icon || item.iconContent) && <span className="btn-menu-item-icon" aria-hidden="true">
          {item.icon ? <Icon name={item.icon} size={24} /> : item.iconContent}
        </span>}
        <span className="btn-menu-item-text">{item.label}</span>
      </button>
    </>
  );
}

export function ContextMenu({ x, y, items: nativeItems, onClose, label, moduleTarget }: {
  x: number; y: number; items: MenuItem[]; onClose: (restoreFocus?: boolean) => void; label?: string;
  moduleTarget?: ModuleMenuTarget;
}) {
  const items = useRegisteredMenu(nativeItems, moduleTarget);
  const ref = useRef<HTMLDivElement | null>(null);
  const focusInitialized = useRef(false);
  const focusedItem = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const enabled = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    const target = menuFocusTarget(focusInitialized.current, focusedItem.current, enabled);
    focusInitialized.current = true;
    if (target !== undefined) {
      focusedItem.current = target;
      (target ?? menu).focus();
    }
  }, [items]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    const overflowX = x + width + pad > window.innerWidth;
    const overflowY = y + height + pad > window.innerHeight;
    const left = overflowX ? Math.max(pad, x - width) : x;
    const top = overflowY ? Math.max(pad, y - height) : y;
    setPos(previous => previous.left === left && previous.top === top ? previous : { left, top });
  }, [x, y, items, label]);

  useMenuDismiss(onClose);

  return (
    <div
      ref={ref}
      className="btn-menu"
      role="menu"
      tabIndex={-1}
      aria-label={label}
      style={{ left: pos.left, top: pos.top, maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' }}
      onPointerDown={(e) => e.stopPropagation()}
      onFocusCapture={event => {
        if (event.target instanceof HTMLButtonElement && event.target.getAttribute('role') === 'menuitem') {
          focusedItem.current = event.target;
        }
      }}
      onKeyDown={event => {
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
      {items.map((it) => <MenuItemButton key={it.id ?? it.label} item={it} onClose={onClose} />)}
    </div>
  );
}
