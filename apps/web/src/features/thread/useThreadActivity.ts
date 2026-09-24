import type { ChatSession } from '../../net/types';
import { useCockpit } from '../../net/store';
import { sessionActivityIndicators } from '../../lib/sessionActivity';

// The input card's one-line execution summary: current progress first, then
// the session's activity indicators. Only an applied snapshot is current.
export function useThreadActivity(session: ChatSession, { authoritative, actionPending, readOnly }: {
  authoritative: boolean; actionPending: boolean; readOnly: boolean;
}) {
  const activityRefreshing = useCockpit(state => state.activityRefreshingIds.includes(session.sessionId));
  const activityItems = sessionActivityIndicators({
    ...session, activityRefreshing, needsDecision: !!(session.ask || session.planRequest || session.elicitation),
  }, authoritative);
  const executionProgress = authoritative && session.cancelling ? '正在停止…'
    : authoritative && session.compacting ? '正在压缩上下文…'
    : actionPending && !readOnly ? session.ask ? '正在提交回答…' : '正在提交…'
    : authoritative && session.activity?.processing ? session.intent : null;
  const executionLabel = [executionProgress, ...activityItems.map(item => item.label)].filter(Boolean).join(' · ') || '当前无活动';
  return { activityRefreshing, activityItems, executionProgress, executionLabel };
}
