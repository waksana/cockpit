import type { SessionMeta } from '../net/types';

// These are presentation hints, not proof of native safety. The reload endpoint
// checks fresh native work (including steering) and owns the lifecycle transition.
export function sessionReloadBlockReason(
  session: SessionMeta | undefined, connected: boolean, pending = false,
): string | undefined {
  if (pending) return '重新加载会话请求尚未结束';
  if (!connected) return '会话连接尚未就绪';
  if (!session) return '目标会话已不存在';
  if (session.status === 'running' || session.nativeProcessing
    || session.loading || session.closing || session.cancelling || session.compacting
    || session.ask || session.planRequest || session.elicitation
    || (session.activeSubagents ?? 0) > 0 || (session.activeOperations ?? 0) > 0
    || (session.activeMcpOperations ?? 0) > 0 || (session.queue?.length ?? 0) > 0) {
    return '会话仍有工作、待决交互或生命周期操作，请等待其结束';
  }
}
