import type { ViewportGeometry, ViewportSource } from '../lib/visualViewport';

// Synthetic geometry only. It never claims to open an OS keyboard and never
// overwrites window.visualViewport. The production observer consumes this source.
export function createViewportFixture() {
  let geometry: ViewportGeometry | null = null;
  const listeners = new Set<() => void>();
  const source: ViewportSource = {
    read: () => geometry ?? {
      layoutHeight: document.documentElement.clientHeight,
      height: window.visualViewport?.height ?? innerHeight,
      offsetTop: window.visualViewport?.offsetTop ?? 0, scale: window.visualViewport?.scale ?? 1,
    },
    subscribe: update => {
      listeners.add(update);
      window.addEventListener('resize', update);
      window.visualViewport?.addEventListener('resize', update);
      window.visualViewport?.addEventListener('scroll', update);
      return () => {
        listeners.delete(update);
        window.removeEventListener('resize', update);
        window.visualViewport?.removeEventListener('resize', update);
        window.visualViewport?.removeEventListener('scroll', update);
      };
    },
  };
  return {
    source,
    set(value: ViewportGeometry | null) {
      geometry = value;
      listeners.forEach(update => update());
    },
  };
}
