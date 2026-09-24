import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { detailsNavigation, type SessionPanel } from '../../lib/routeOwnership';

// Opens a session's detail panel by URL and, when a docked panel closes,
// returns focus to the control that opened it (or the chat's overflow button).
export function useSessionDetails(routeId: string | null, panel: SessionPanel | null) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const kebabRef = useRef<HTMLButtonElement | null>(null);
  const [panelTrigger, setPanelTrigger] = useState<{ sessionId: string; element: HTMLElement | null } | null>(null);
  const previousPanel = useRef<{ sessionId: string | null; open: boolean }>({ sessionId: null, open: false });
  useEffect(() => {
    if (!panel && previousPanel.current.open && previousPanel.current.sessionId === routeId) {
      const trigger = panelTrigger?.sessionId === routeId ? panelTrigger.element : null;
      const valid = trigger?.isConnected && trigger.getClientRects().length && !trigger.closest('[inert]');
      // Native modals already restore their invoker. Only repair a removed
      // docked-panel control; never pull focus away from an ongoing chat edit.
      if (document.activeElement === document.body) (valid ? trigger : kebabRef.current)?.focus();
    }
    previousPanel.current = { sessionId: routeId, open: panel !== null };
  }, [panel, routeId, panelTrigger]);
  const openDetails = useCallback((id: string, nextPanel: SessionPanel = 'info') => {
    const focused = document.activeElement;
    const element = focused instanceof HTMLElement && !focused.closest('[role="menu"]')
      ? focused
      : focused?.closest('.chatlist')
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-session-id]')).find(row => row.dataset.sessionId === id) ?? null
        : document.querySelector<HTMLElement>('.chat-topbar-more');
    setPanelTrigger({ sessionId: id, element });
    const destination = detailsNavigation(pathname, id, nextPanel);
    void navigate(destination.to, { replace: destination.replace });
  }, [pathname, navigate]);
  return { kebabRef, openDetails };
}
