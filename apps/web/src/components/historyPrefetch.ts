export function withinHistoryPrefetch(remaining: number, viewport: number): boolean {
  return viewport > 0 && remaining <= viewport;
}

/** View-owned, event-driven prefetch; the history resource owns request cancellation. */
export function observeHistoryPrefetch(
  viewport: HTMLElement, content: HTMLElement, canRead: () => boolean, read: () => void,
  remaining = () => viewport.scrollTop,
  needsFill = () => false,
) {
  let frame: number | undefined;
  let requested = false;
  let disposed = false;
  const check = () => {
    frame = undefined;
    if (disposed || requested || document.visibilityState !== 'visible' || !canRead()) return;
    const bounds = viewport.getBoundingClientRect();
    const rows = content.getBoundingClientRect();
    if (!needsFill() && (rows.bottom <= bounds.top || rows.top >= bounds.bottom
      || !withinHistoryPrefetch(remaining(), viewport.clientHeight))) return;
    requested = true;
    read();
  };
  const schedule = () => {
    if (disposed || frame !== undefined) return;
    // ResizeObserver runs after RAF; allow its scroll correction a frame before measuring.
    frame = requestAnimationFrame(() => {
      if (!disposed) frame = requestAnimationFrame(() => {
        if (!disposed) frame = requestAnimationFrame(check);
      });
    });
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(viewport);
  observer?.observe(content);
  viewport.addEventListener('scroll', schedule, { passive: true });
  document.addEventListener('visibilitychange', schedule);
  schedule();
  return () => {
    disposed = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    observer?.disconnect();
    viewport.removeEventListener('scroll', schedule);
    document.removeEventListener('visibilitychange', schedule);
  };
}
