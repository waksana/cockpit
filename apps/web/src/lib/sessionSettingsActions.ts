import type { NativeCompactResult, SessionMeta } from '@cockpit/protocol';
import { sessionReloadBlockReason } from './sessionReload';

export type SessionSettingsAction = 'unload' | 'compact' | 'fork';
export type SessionSettingsOutcome =
  | { action: 'unload'; present: boolean; loaded: boolean }
  | { action: 'compact'; result: NativeCompactResult }
  | { action: 'fork'; sessionId: string };
export interface SessionSettingsOperation {
  action: SessionSettingsAction;
  pending: boolean;
  outcome?: SessionSettingsOutcome;
  error?: string;
  refreshError?: string;
}

export function sessionSettingsBlockReason(session: SessionMeta | undefined, connected: boolean, pending = false) {
  if (pending) return '会话操作请求尚未结束';
  const reason = sessionReloadBlockReason(session, connected);
  if (reason) return reason;
  if (!session?.loaded) return '请先显式恢复会话';
  const activity = session.activity;
  if (!activity) return '原生活动状态尚未确认，请刷新会话状态';
  if (activity.processing || activity.hasActiveWork || activity.tasks.activeAgents
    || activity.tasks.activeShells || activity.tasks.unknown || activity.queue.pendingCount
    || activity.queue.steeringCount || activity.queue.inFlightSteeringCount || activity.mcp.pendingConnectionCount) {
    return '会话仍有后台工作、排队消息或连接操作，请等待其结束';
  }
}
