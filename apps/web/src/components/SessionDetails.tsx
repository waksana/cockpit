import { lazy, Suspense, useCallback } from 'react';
import { useCockpit } from '../net/store';
import { cockpitApi } from '../net/api';
import { useUp } from '../lib/nav';
import { SESSION_PANEL_LABELS, type SessionPanel } from '../lib/routeOwnership';
import { PanelPageShell } from './PanelPage';
import { InspectorPane } from './Shell';
import { UxErrorNotifications } from './UxErrorNotifications';
import type { SessionInfoPanelProps } from './SessionInfoPanel';

const SessionInfoPanel = lazy(() => import('./SessionInfoPanel').then((m) => ({ default: m.SessionInfoPanel })));
const SessionMcp = lazy(() => import('./Manage').then((m) => ({ default: m.SessionMcp })));
const SessionSkills = lazy(() => import('./Manage').then((m) => ({ default: m.SessionSkills })));

export function SessionDetails({ sessionId, panel }: { sessionId: string; panel: SessionPanel }) {
  const session = useCockpit((s) => s.sessions.find((item) => item.sessionId === sessionId));
  const up = useUp();
  const onClose = useCallback(() => up(), [up]);
  const onSetModel = useCallback<SessionInfoPanelProps['onSetModel']>(
    (model, options) => cockpitApi.setModel(sessionId, model, options), [sessionId],
  );
  if (!session) return null;
  const title = `${SESSION_PANEL_LABELS[panel]} · ${session.title}`;
  return (
    <InspectorPane ariaLabel={title} onClose={onClose} modalFooter={<UxErrorNotifications withinDialog />}>
        <Suspense fallback={<PanelPageShell title={panel === 'info' ? '会话设置' : `本会话 ${SESSION_PANEL_LABELS[panel]}`} onClose={onClose} loading />}>
          {panel === 'info'
            ? <SessionInfoPanel session={session} open onClose={onClose}
                onSetModel={onSetModel} />
            : panel === 'mcp'
              ? <SessionMcp session={session} onClose={onClose} />
              : <SessionSkills session={session} onClose={onClose} />}
        </Suspense>
    </InspectorPane>
  );
}
