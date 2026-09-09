import type { ChatMessage } from '../net/types';

export function canSkipMessageLayout(message: ChatMessage, live: boolean): boolean {
  return !live && message.subtype !== 'subagent'
    && (message.toolCalls?.every(tool => tool.status === 'completed' || tool.status === 'failed') ?? true);
}

export function createMessageLayout() {
  const supported = typeof CSS !== 'undefined' && typeof ResizeObserver !== 'undefined'
    && CSS.supports('content-visibility', 'auto')
    && CSS.supports('contain-intrinsic-block-size', 'auto 1px');
  const rows = new Map<Element, { node: HTMLElement; width?: number }>();
  const pending = new Map<Element, { width: number; height: number }>();
  let observer: ResizeObserver | undefined;
  let frame: number | undefined;
  const reset = (node: HTMLElement) => {
    node.removeAttribute('data-measured-layout');
    node.style.removeProperty('--message-height');
  };
  const cancelFrame = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const commit = () => {
    frame = undefined;
    for (const [target, { width, height }] of pending) {
      const current = rows.get(target);
      if (!current) continue;
      if (width <= 0 || height <= 0) {
        current.width = undefined;
        reset(current.node);
        continue;
      }
      const reflow = current.width !== undefined && Math.abs(current.width - width) >= 1;
      current.width = width;
      if (reflow) {
        reset(current.node);
        continue;
      }
      current.node.style.setProperty('--message-height', `${height}px`);
      current.node.setAttribute('data-measured-layout', '');
    }
    pending.clear();
  };
  return {
    observe(node: HTMLElement) {
      if (!supported) return () => {};
      reset(node);
      const row: { node: HTMLElement; width?: number } = { node };
      rows.set(node, row);
      observer ??= new ResizeObserver(entries => {
        for (const entry of entries) {
          if (!rows.has(entry.target)) continue;
          const { width, height } = entry.contentRect;
          pending.set(entry.target, { width, height });
        }
        // Enabling containment can resize observed boxes. Commit outside RO delivery,
        // so same-depth notifications are not deferred as a ResizeObserver loop error.
        if (pending.size && frame === undefined) frame = requestAnimationFrame(commit);
      });
      observer.observe(node);
      return () => {
        if (rows.get(node) !== row) return;
        observer?.unobserve(node);
        rows.delete(node);
        pending.delete(node);
        if (!pending.size) cancelFrame();
        reset(node);
      };
    },
    dispose() {
      observer?.disconnect();
      observer = undefined;
      cancelFrame();
      pending.clear();
      for (const { node } of rows.values()) reset(node);
      rows.clear();
    },
  };
}
