// Dismiss on outside interaction, not a scroll event: transcript follow and
// anchor corrections also emit trusted scroll events. Deferred one tick so the
// opening click doesn't immediately dismiss the menu.
import { useEffect } from 'react';

export function useMenuDismiss(onClose: (restoreFocus?: boolean) => void) {
  useEffect(() => {
    const close = () => onClose(false);
    const restore = () => onClose();
    const onScrollIntent = (e: Event) => {
      if (!(e.target instanceof Element) || !e.target.closest('.btn-menu')) onClose();
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && (e.deltaX !== 0 || e.deltaY !== 0)) onScrollIntent(e);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === 'Tab') onClose();
      else if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        onScrollIntent(e);
      }
    };
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', close);
      window.addEventListener('wheel', onWheel, { capture: true, passive: true });
      window.addEventListener('touchmove', onScrollIntent, { capture: true, passive: true });
      window.addEventListener('resize', restore);
      window.addEventListener('keydown', onKey, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('touchmove', onScrollIntent, true);
      window.removeEventListener('resize', restore);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
}
