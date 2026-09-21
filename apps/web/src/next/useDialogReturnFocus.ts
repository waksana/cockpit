import { useState } from 'react';

export function useDialogReturnFocus() {
  const [opener] = useState(() => {
    if (typeof document === 'undefined') return null;
    const focused = document.activeElement;
    const triggerId = focused?.closest('[role="menu"]')?.getAttribute('aria-labelledby');
    return triggerId ? document.getElementById(triggerId) : focused;
  });
  return (event: Event) => {
    event.preventDefault();
    const focused = document.activeElement;
    if (focused !== document.body && focused instanceof HTMLElement && focused.getClientRects().length > 0) return;
    const available = opener instanceof HTMLElement && opener.isConnected && opener.getClientRects().length > 0
      && !opener.matches(':disabled') && !opener.closest('[inert]');
    const destination = available ? opener : Array.from(document.querySelectorAll<HTMLElement>('.next-main, .next-session-nav'))
      .find(element => element.getClientRects().length > 0);
    destination?.focus();
  };
}
