// Shared dismiss wiring for floating menus: closes on outside pointer, scroll,
// resize, or Escape. Deferred one tick so the opening click doesn't immediately
// dismiss it.
import { useEffect } from 'react';

export function useMenuDismiss(onClose: () => void) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', close);
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
}
