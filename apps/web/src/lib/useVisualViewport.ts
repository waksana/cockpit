import { useLayoutEffect } from 'react';
import { browserViewportSource, observeVisualViewport, type ViewportSource } from './visualViewport';

// One mounted shell owns these CSS values; leaving the shell releases them.
export function useVisualViewport(source?: ViewportSource) {
  useLayoutEffect(() => {
    const active = source ?? browserViewportSource(window);
    if (!active) return;
    return observeVisualViewport(active, document.documentElement.style, {
      request: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id),
    });
  }, [source]);
}
