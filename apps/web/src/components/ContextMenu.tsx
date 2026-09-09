// Pointer-anchored context menu — appears at an arbitrary (x,y) pointer location
// (right-click / long-press on session rows + messages). Rendered fixed; flips
// left/up near the viewport edges. For BUTTON-anchored dropdowns (kebab, etc.)
// use AnchoredMenu instead — it pins to the trigger's live rect so it can never
// drift off-screen.

import { useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { useMenuDismiss } from '../lib/useMenuDismiss';

export interface MenuItem {
  id?: string;
  label: string;
  icon?: IconName;
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
        className={`btn-menu-item rp${item.destructive ? ' danger' : ''}`}
        disabled={item.disabled}
        onClick={() => { item.onClick(); onClose(); }}
      >
        {item.icon && <span className="btn-menu-item-icon"><Icon name={item.icon} size={22} /></span>}
        <span className="btn-menu-item-text">{item.label}</span>
      </button>
    </>
  );
}

export function ContextMenu({ x, y, items, onClose, label }: {
  x: number; y: number; items: MenuItem[]; onClose: () => void; label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    const overflowX = x + width + pad > window.innerWidth;
    const overflowY = y + height + pad > window.innerHeight;
    const left = overflowX ? Math.max(pad, x - width) : x;
    const top = overflowY ? Math.max(pad, y - height) : y;
    setPos({ left, top });
  }, [x, y, items, label]);

  useMenuDismiss(onClose);

  return (
    <div
      ref={ref}
      className="btn-menu active"
      role="menu"
      aria-label={label}
      style={{ left: pos.left, top: pos.top, maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {label && <div className="btn-menu-caption" aria-hidden="true">{label}</div>}
      {items.map((it) => <MenuItemButton key={it.id ?? it.label} item={it} onClose={onClose} />)}
    </div>
  );
}
