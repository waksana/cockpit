import type { ChatSession } from '../../net/types';
import { useKeyedAction } from '../../lib/useKeyedResource';

// Stop/interrupt availability for the input card head. Shared controls
// (`hasControlAction`) replace these actions entirely.
export function useThreadExecution(session: ChatSession, { readOnly, hasControlAction, hasInterrupt, hasCancel, connected, snapshotReady }: {
  readOnly: boolean; hasControlAction: boolean; hasInterrupt: boolean; hasCancel: boolean;
  connected: boolean; snapshotReady: boolean;
}) {
  const interruptAction = useKeyedAction(`interrupt:${session.sessionId}`);
  const stopAction = useKeyedAction(`stop:${session.sessionId}`);
  const canInterrupt = hasInterrupt && session.loaded && session.status === 'running'
    && !session.loading && !session.closing && !session.cancelling && !session.compacting
    && session.nativeProcessing !== false && session.activity?.abortable !== false;
  const queueCount = session.activity
    ? session.activity.queue.pendingCount + session.activity.queue.steeringCount
    : session.queue?.length ?? 0;
  const showStop = !readOnly && !hasControlAction && session.status === 'running' && !session.compacting;
  const stopPending = !!session.cancelling || stopAction.busy;
  const notAbortable = connected && snapshotReady && session.loaded && session.activity?.abortable === false && queueCount === 0
    && !session.ask && !session.planRequest && !session.elicitation;
  const stopDisabled = !connected || !session.loaded || session.loading || session.closing
    || !snapshotReady || (!stopPending && (!!session.activeOperations || interruptAction.busy || notAbortable)) || !hasCancel;
  const showInterrupt = !readOnly && !hasControlAction && queueCount > 0 && canInterrupt;
  const interruptResult = readOnly ? null : interruptAction.error
    ? `打断未确认：${interruptAction.error}。请核对会话状态，不要直接重试。`
    : null;
  return { interruptAction, stopAction, queueCount, showStop, showInterrupt, stopPending, stopDisabled, notAbortable, interruptResult };
}

export type ThreadExecution = ReturnType<typeof useThreadExecution>;
