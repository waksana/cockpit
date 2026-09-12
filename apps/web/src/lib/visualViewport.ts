export interface ViewportGeometry {
  layoutHeight: number;
  height: number;
  offsetTop: number;
  scale: number;
}

export function visibleViewport(geometry: ViewportGeometry) {
  const { layoutHeight, height, offsetTop, scale } = geometry;
  if (![layoutHeight, height, offsetTop, scale].every(Number.isFinite)
    || layoutHeight <= 0 || height <= 0 || Math.abs(scale - 1) > 0.001) return null;
  const top = Math.max(0, Math.min(offsetTop, layoutHeight - 1));
  const visibleHeight = Math.min(height, layoutHeight - top);
  return { top, height: visibleHeight, occludedBottom: Math.max(0, layoutHeight - top - visibleHeight) };
}

export interface ViewportSource {
  read(): ViewportGeometry;
  subscribe(update: () => void): () => void;
}

const PROPERTIES = ['--chat-viewport-top', '--chat-viewport-height', '--chat-viewport-occluded-bottom'] as const;

// Only viewport CSS geometry is written here. ThreadScroll remains the sole
// transcript scroll writer; pinch zoom is left to the browser, not a reflow.
export function observeVisualViewport(
  source: ViewportSource,
  style: Pick<CSSStyleDeclaration, 'getPropertyValue' | 'getPropertyPriority' | 'setProperty' | 'removeProperty'>,
  frames: { request(callback: () => void): number; cancel(id: number): void },
) {
  const previous = PROPERTIES.map(name => [style.getPropertyValue(name), style.getPropertyPriority(name)]);
  let frame: number | null = null;
  let disposed = false;
  const update = () => {
    frame = null;
    if (disposed) return;
    const viewport = visibleViewport(source.read());
    if (!viewport) return;
    const values = [viewport.top, viewport.height, viewport.occludedBottom];
    PROPERTIES.forEach((name, index) => {
      const value = `${values[index]}px`;
      if (style.getPropertyValue(name) !== value) style.setProperty(name, value);
    });
  };
  const schedule = () => {
    if (!disposed && frame === null) frame = frames.request(update);
  };
  const unsubscribe = source.subscribe(schedule);
  update();
  return () => {
    disposed = true;
    unsubscribe();
    if (frame !== null) frames.cancel(frame);
    PROPERTIES.forEach((name, index) => {
      const [value, priority] = previous[index];
      if (value) style.setProperty(name, value, priority);
      else style.removeProperty(name);
    });
  };
}

export function browserViewportSource(window: Window): ViewportSource | undefined {
  const viewport = window.visualViewport;
  if (!viewport) return undefined;
  return {
    read: () => ({
      layoutHeight: window.document.documentElement.clientHeight,
      height: viewport.height, offsetTop: viewport.offsetTop, scale: viewport.scale,
    }),
    subscribe: update => {
      viewport.addEventListener('resize', update);
      viewport.addEventListener('scroll', update);
      window.addEventListener('resize', update);
      return () => {
        viewport.removeEventListener('resize', update);
        viewport.removeEventListener('scroll', update);
        window.removeEventListener('resize', update);
      };
    },
  };
}
