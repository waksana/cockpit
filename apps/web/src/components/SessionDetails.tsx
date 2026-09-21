import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { useCockpit } from '../net/store';
import { useUp } from '../lib/nav';
import { SESSION_PANEL_LABELS, type SessionPanel } from '../lib/routeOwnership';
import { PanelPageShell } from './SessionPanelKit';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useNativeDialog } from '../lib/useNativeDialog';
import { UxErrorNotifications } from './UxErrorNotifications';
import type { SessionInfoPanelProps } from './SessionInfoPanel';

const SessionInfoPanel = lazy(() => import('./SessionInfoPanel').then((m) => ({ default: m.SessionInfoPanel })));
const SessionMcp = lazy(() => import('./Manage').then((m) => ({ default: m.SessionMcp })));
const SessionSkills = lazy(() => import('./Manage').then((m) => ({ default: m.SessionSkills })));

export function SessionDetails({ sessionId, panel }: { sessionId: string; panel: SessionPanel }) {
  const session = useCockpit((s) => s.sessions.find((item) => item.sessionId === sessionId));
  const setModel = useCockpit((s) => s.setModel);
  const up = useUp();
  const frame = useRef<HTMLDialogElement | null>(null);
  const wide = useMediaQuery('(min-width: 1200px)');
  useNativeDialog(frame, !wide);
  const onClose = useCallback(() => up(), [up]);
  const onSetModel = useCallback<SessionInfoPanelProps['onSetModel']>(
    (model, options) => setModel(sessionId, model, options), [setModel, sessionId],
  );
  useEffect(() => {
    if (!wide) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector(':modal')) return;
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, wide]);

  if (!session) return null;
  const title = `${SESSION_PANEL_LABELS[panel]} · ${session.title}`;
  return (
    <dialog ref={frame} className="session-details-dialog host-modal" aria-label={title}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (!wide && event.target === event.currentTarget) onClose(); }}>
      <div className="info-panel" data-open="true" data-dialog-focus>
        <Suspense fallback={<PanelPageShell title={panel === 'info' ? '会话设置' : `本会话 ${SESSION_PANEL_LABELS[panel]}`} onClose={onClose} loading />}>
          {panel === 'info'
            ? <SessionInfoPanel session={session} open onClose={onClose}
                onSetModel={onSetModel} />
            : panel === 'mcp'
              ? <SessionMcp session={session} onClose={onClose} />
              : <SessionSkills session={session} onClose={onClose} />}
        </Suspense>
      </div>
      {!wide && <UxErrorNotifications withinDialog />}
    </dialog>
  );
}
