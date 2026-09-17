import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { useCockpit } from '../net/store';
import { useUp } from '../lib/nav';
import { SESSION_PANEL_LABELS, type SessionPanel } from '../lib/routeOwnership';
import { PanelPageShell } from './SessionPanelKit';
import type { SessionInfoPanelProps } from './SessionInfoPanel';

const SessionInfoPanel = lazy(() => import('./SessionInfoPanel').then((m) => ({ default: m.SessionInfoPanel })));
const SessionMcp = lazy(() => import('./Manage').then((m) => ({ default: m.SessionMcp })));
const SessionSkills = lazy(() => import('./Manage').then((m) => ({ default: m.SessionSkills })));

export function SessionDetails({ sessionId, panel }: { sessionId: string; panel: SessionPanel }) {
  const session = useCockpit((s) => s.sessions.find((item) => item.sessionId === sessionId));
  const setModel = useCockpit((s) => s.setModel);
  const up = useUp();
  const frame = useRef<HTMLElement | null>(null);
  const onClose = useCallback(() => up(), [up]);
  const onSetModel = useCallback<SessionInfoPanelProps['onSetModel']>(
    (model, options) => setModel(sessionId, model, options), [setModel, sessionId],
  );
  useEffect(() => {
    frame.current?.focus();
  }, [panel]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector(':modal')) return;
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || window.matchMedia('(min-width: 1200px)').matches) return;
      const controls = Array.from(frame.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
      ) ?? []).concat(Array.from(document.querySelectorAll<HTMLButtonElement>(
        '.ux-error-notifications button:not(:disabled)',
      ))).filter(element => element.getClientRects().length && !element.closest('[inert]'));
      const current = controls.indexOf(document.activeElement as HTMLElement);
      if (current < 0 || (event.shiftKey ? current === 0 : current === controls.length - 1)) {
        event.preventDefault();
        (controls[event.shiftKey ? controls.length - 1 : 0] ?? frame.current)?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!session) return null;
  const title = `${SESSION_PANEL_LABELS[panel]} · ${session.title}`;
  return (
    <>
      <div className="info-panel-scrim" data-open="true" onClick={onClose} aria-hidden="true" />
      <aside ref={frame} tabIndex={-1} className="info-panel" data-open="true" aria-label={title}>
        <Suspense fallback={<PanelPageShell title={panel === 'info' ? '会话设置' : `本会话 ${SESSION_PANEL_LABELS[panel]}`} onClose={onClose} loading />}>
          {panel === 'info'
            ? <SessionInfoPanel session={session} open onClose={onClose}
                onSetModel={onSetModel} />
            : panel === 'mcp'
              ? <SessionMcp session={session} onClose={onClose} />
              : <SessionSkills session={session} onClose={onClose} />}
        </Suspense>
      </aside>
    </>
  );
}
