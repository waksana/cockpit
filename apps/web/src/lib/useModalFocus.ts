import { useEffect, type RefObject } from 'react';

export function useModalFocus(ref: RefObject<HTMLElement | null>, includeNotices = false): void {
  useEffect(() => {
    const previous = document.activeElement;
    const shell = document.querySelector<HTMLElement>('.cockpit-shell');
    const wasInert = shell?.inert;
    if (shell) shell.inert = true;
    const available = (element: HTMLElement) => element.isConnected && element.getClientRects().length > 0
      && !element.closest('[inert]') && !element.matches(':disabled');
    const controls = () => Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
      ) ?? [],
    ).concat(includeNotices ? Array.from(document.querySelectorAll<HTMLElement>('.ux-error-notifications button:not(:disabled)')) : [])
      .filter(available);
    const focusFirst = () => (controls()[0] ?? ref.current)?.focus();
    focusFirst();
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)
        && !(includeNotices && event.target instanceof Element && event.target.closest('.ux-error-notifications'))) focusFirst();
    };
    const observer = new MutationObserver(() => {
      const focused = document.activeElement;
      if (focused === document.body || (focused instanceof HTMLElement && !available(focused))) focusFirst();
    });
    if (ref.current) observer?.observe(ref.current, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    observer?.observe(document.body, { childList: true, subtree: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !ref.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const available = controls();
      const index = available.findIndex(control => control === document.activeElement);
      const next = index < 0 ? (event.shiftKey ? available.length - 1 : 0)
        : (index + (event.shiftKey ? -1 : 1) + available.length) % available.length;
      (available[next] ?? ref.current).focus();
    };
    document.addEventListener('focusin', keepFocus);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('focusin', keepFocus);
      window.removeEventListener('keydown', onKey, true);
      observer?.disconnect();
      if (shell) shell.inert = wasInert ?? false;
      if (previous instanceof HTMLElement && available(previous)) previous.focus();
      else {
        Array.from(document.querySelectorAll<HTMLElement>('.chat-topbar-more, .cockpit-shell button:not(:disabled)'))
          .find(available)?.focus();
      }
    };
  }, [ref, includeNotices]);
}
