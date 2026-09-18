import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

// Ref cleanup runs before removal; the layout effect waits until replacement
// controls exist. Unmounting the owner never schedules a later focus operation.
export function useRemovedControlFocus(ownerKey: string, containerRef: RefObject<HTMLElement | null>) {
  const pending = useRef<{ ownerKey: string; element: HTMLElement; nearby: HTMLElement[] } | null>(null);
  const controlRef = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    return () => {
      if (element.ownerDocument.activeElement !== element) return;
      const controls = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('.chat-queue-remove') ?? []);
      const index = controls.indexOf(element);
      pending.current = { ownerKey, element,
        nearby: index < 0 ? [] : [...controls.slice(index + 1), ...controls.slice(0, index).reverse()] };
    };
  }, [ownerKey, containerRef]);
  useLayoutEffect(() => {
    const previous = pending.current;
    pending.current = null;
    const container = containerRef.current;
    if (!previous || previous.ownerKey !== ownerKey || previous.element.isConnected || !container) return;
    const document = container.ownerDocument;
    if (document.activeElement !== document.body) return;
    const available = (element: HTMLElement | null): element is HTMLElement => !!element && element.isConnected
      && element.getClientRects().length > 0 && !element.closest('[inert]') && !element.matches(':disabled');
    const next = [
      ...previous.nearby,
      container.querySelector<HTMLElement>('.chat-input-message'),
      container.querySelector<HTMLElement>('.chat-execution-head'),
    ].find(available);
    next?.focus();
  });
  return controlRef;
}
