import type { SessionMeta } from '@cockpit/protocol';
import type { IconName } from '../components/Icon';
import type { SessionActivityDisplay } from '@cockpit/module-api/frontend';

export interface ActivityIndicator {
  key: string;
  icon: IconName;
  label: string;
  count?: number;
  text?: string;
}

export function sessionActivityIndicators(session: {
  status: SessionMeta['status'];
  loaded?: boolean;
  activity?: SessionMeta['activity'];
  activityRefreshing?: boolean;
  activityDisplay?: SessionActivityDisplay;
  compacting?: boolean;
  error?: string | null;
  needsDecision: boolean;
}, connected: boolean, showIdle = false): ActivityIndicator[] {
  if (session.loaded === false || session.status === 'unloaded') return [];
  if (!connected) return [{ key: 'overall', icon: 'unknown', label: '总状态：活动待同步', text: '待同步' }];
  const previous = !session.activity ? session.activityDisplay?.previous : undefined;
  const activity = session.activity ?? previous?.activity;
  const items: ActivityIndicator[] = [];
  const retained = (item: ActivityIndicator): ActivityIndicator => previous
    ? { ...item, label: `上次采样，等待更新：${item.label}` } : item;
  const error = session.error || (session.status === 'error' ? '会话出错' : session.activityDisplay?.error);
  const busy = session.needsDecision || session.compacting || (previous?.status ?? session.status) === 'running'
    || activity && (activity.processing || activity.hasActiveWork || activity.tasks.activeAgents
      || activity.tasks.activeShells || activity.tasks.unknown || activity.queue.pendingCount
      || activity.queue.steeringCount || activity.queue.inFlightSteeringCount || activity.mcp.pendingConnectionCount);
  if (error) items.push({ key: 'overall', icon: 'error',
    label: session.error ? `总状态：会话出错，${error}` : session.status === 'error'
      ? '总状态：会话出错' : `总状态：活动状态读取失败：${error}` });
  else if (session.needsDecision) items.push({ key: 'overall', icon: 'decision', label: '总状态：等待你回答或确认' });
  else if (!activity) items.push({ key: 'overall', icon: 'loading', label: session.activityRefreshing
    ? '总状态：正在刷新活动状态' : '总状态：等待活动状态，不代表模型正在生成' });
  else if (busy) {
    const overall: ActivityIndicator = { key: 'overall', icon: 'loading',
      label: `总状态：会话有活动，不代表模型正在生成${activity.tasks.unknown ? `；${activity.tasks.unknown} 项任务状态未知` : ''}` };
    items.push(session.compacting ? overall : retained(overall));
  } else if (showIdle) items.push(retained({ key: 'overall', icon: 'radiooff', label: '总状态：空闲' }));
  if (session.compacting) items.push({ key: 'compaction', icon: 'compress', label: '正在压缩上下文' });
  if (!activity) return items;
  if (activity.tasks.activeAgents) items.push(retained({
    key: 'agent', icon: 'agent', count: activity.tasks.activeAgents, label: `活动 agent ${activity.tasks.activeAgents}`,
  }));
  if (activity.tasks.activeShells) items.push(retained({
    key: 'shell', icon: 'shell', count: activity.tasks.activeShells, label: `后台 shell ${activity.tasks.activeShells}`,
  }));
  const { pendingCount, steeringCount, inFlightSteeringCount } = activity.queue;
  const waitingCount = pendingCount + Math.max(0, steeringCount - inFlightSteeringCount);
  if (waitingCount) items.push(retained({
    key: 'queue', icon: 'queue', count: waitingCount,
    label: `待处理项 ${pendingCount}，steering ${steeringCount}（其中 ${inFlightSteeringCount} 已纳入回合，不重复计数）`,
  }));
  if (activity.mcp.pendingConnectionCount) items.push(retained({
    key: 'mcp', icon: 'mcp', count: activity.mcp.pendingConnectionCount,
    label: `MCP 等待连接 ${activity.mcp.pendingConnectionCount}`,
  }));
  return items;
}
