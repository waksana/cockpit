// Explicit recovery for session pages whose native data requires a loaded session.
import { useId } from 'react';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { Button } from './Button';
import { OperationErrorResult } from './OperationResult';

export function SessionResume({ sessionId, required, onResumed }: {
  sessionId: string; required: boolean; onResumed?: () => void;
}) {
  const session = useCockpit((s) => s.sessions.find((item) => item.sessionId === sessionId));
  const loadSession = useCockpit((s) => s.loadSession);
  const action = useKeyedAction(`resume:${sessionId}`);
  const settingsPending = useCockpit(s => s.sessionSettingsOperations[sessionId]?.pending);
  const reloadPending = useCockpit(s => s.reloadingSessionIds.includes(sessionId));
  const descriptionId = useId();
  if (!required || reloadPending) return null;
  const resume = () => action.run(async () => {
    const current = useCockpit.getState().sessions.find((item) => item.sessionId === sessionId);
    if (!current || current.closing || current.status === 'running' || current.compacting
      || useCockpit.getState().sessionSettingsOperations[sessionId]?.pending
      || useCockpit.getState().reloadingSessionIds.includes(sessionId)) {
      throw new Error('会话仍有操作尚未结束，请等待后再恢复。');
    }
    await loadSession(sessionId);
  }, onResumed);
  return (
    <div className="session-resume ck-surface" role="group" aria-label="会话未加载">
      <p id={descriptionId} className="session-resume-message" role="status">会话未加载。恢复后可查看这些设置；聊天历史仍可直接查看。</p>
      <Button className="session-resume-action"
        disabled={!action.connected || !session || session.closing || session.status === 'running' || session.compacting || action.busy || settingsPending}
        aria-busy={action.busy}
        aria-describedby={descriptionId}
        onClick={() => { void resume(); }}>{action.busy ? '恢复中…' : '恢复会话'}</Button>
      {action.error && <OperationErrorResult label="恢复会话" error={action.error} cause={action.errorCause} />}
    </div>
  );
}
