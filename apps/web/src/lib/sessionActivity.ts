import type { SessionMeta } from '@cockpit/protocol';
import type { IconName } from '../components/Icon';

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
  needsDecision: boolean;
}, connected: boolean): ActivityIndicator[] {
  if (session.loaded === false || session.status === 'unloaded') {
    return [];
  }
  if (!connected) return [{ key: 'offline', icon: 'unknown', label: '活动待同步', text: '待同步' }];
  const items: ActivityIndicator[] = [];
  if (session.status === 'error') items.push({ key: 'error', icon: 'error', label: '会话出错', text: '出错' });
  if (session.needsDecision) items.push({ key: 'decision', icon: 'decision', label: '等待你的回答或确认' });
  const activity = session.activity;
  if (!activity) {
    items.push(session.activityRefreshing
      ? { key: 'refreshing', icon: 'loading', label: '正在刷新活动状态' }
      : { key: 'unknown', icon: 'unknown', label: '当前活动未知', text: '未知' });
    return items;
  }
  if (activity.processing) items.push({
    key: 'processing', icon: 'loading', label: '原生处理中（主回合或后台接续，不代表模型正在生成）',
  });
  if (activity.tasks.activeShells) items.push({
    key: 'shell', icon: 'shell', count: activity.tasks.activeShells, label: `后台 shell ${activity.tasks.activeShells}`,
  });
  if (activity.tasks.activeAgents) items.push({
    key: 'agent', icon: 'agent', count: activity.tasks.activeAgents, label: `活动 agent ${activity.tasks.activeAgents}`,
  });
  const { pendingCount, steeringCount, inFlightSteeringCount } = activity.queue;
  if (pendingCount + steeringCount || inFlightSteeringCount) items.push({
    key: 'queue', icon: 'queue', count: pendingCount + steeringCount,
    label: `待处理项 ${pendingCount}，steering ${steeringCount}（其中 ${inFlightSteeringCount} 已纳入回合，不重复计数）`,
  });
  if (activity.mcp.pendingConnectionCount) items.push({
    key: 'mcp', icon: 'mcp', count: activity.mcp.pendingConnectionCount,
    label: `MCP 等待连接 ${activity.mcp.pendingConnectionCount}`,
  });
  if (activity.tasks.unknown) items.push({
    key: 'unknown-tasks', icon: 'unknown', label: `${activity.tasks.unknown} 项任务的原生状态未知`, text: '任务未知',
  });
  if (activity.hasActiveWork && !activity.processing
    && !activity.tasks.activeAgents && !activity.tasks.activeShells
    && !pendingCount && !steeringCount && !inFlightSteeringCount && !activity.mcp.pendingConnectionCount) {
    items.push({ key: 'other', icon: 'unknown', label: '存在无法进一步分类的原生活动', text: '未分类' });
  }
  if (!items.length && session.status === 'running') {
    items.push({ key: 'other', icon: 'unknown', label: '综合状态仍忙碌，采样未提供具体活动原因', text: '未分类' });
  }
  return items;
}
