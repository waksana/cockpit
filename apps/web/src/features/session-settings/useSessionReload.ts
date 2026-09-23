import { useCockpit } from '../../net/store';
import { sessionReloadBlockReason } from '../../lib/sessionReload';

export function useSessionReload(sessionId: string) {
  const session = useCockpit(state => state.sessions.find(row => row.sessionId === sessionId));
  const connected = useCockpit(state => state.connState === 'open' && state.snapshotReady);
  const pending = useCockpit(state => state.reloadingSessionIds.includes(sessionId));
  const settingsPending = useCockpit(state => state.sessionSettingsOperations[sessionId]?.pending);
  const blockedReason = sessionReloadBlockReason(session, connected, pending || settingsPending);
  const reload = () => {
    // The store rechecks fresh state and owns pending/errors beyond this page.
    void useCockpit.getState().reloadSession(sessionId).catch(() => {});
  };
  return { pending, blockedReason, reload };
}
