import type { SessionMeta } from '@cockpit/protocol';
import type { IconName } from '../components/Icon';
import type { SessionActivityDisplay } from '@cockpit/module-api';

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
  needsDecision: boolean;
}, connected: boolean): ActivityIndicator[] {
  if (session.loaded === false || session.status === 'unloaded') {
    return [];
  }
  if (!connected) return [{ key: 'offline', icon: 'unknown', label: '活动待同步', text: '待同步' }];
  const items: ActivityIndicator[] = [];
  if (session.status === 'error') items.push({ key: 'error', icon: 'error', label: '会话出错', text: '出错' });
  else if (session.activityDisplay?.error) items.push({
    key: 'read-error', icon: 'error', label: `活动状态读取失败：${session.activityDisplay.error}`, text: '读取失败',
  });
  if (session.needsDecision) items.push({ key: 'decision', icon: 'decision', label: '等待你的回答或确认' });
  const previous = !session.activity ? session.activityDisplay?.previous : undefined;
  const activity = session.activity ?? previous?.activity;
  if (!activity) {
    if (!items.length) items.push(session.activityRefreshing
      ? { key: 'refreshing', icon: 'loading', label: '正在刷新活动状态' }
      : { key: 'unknown', icon: 'loading', label: '等待活动状态，不代表模型正在生成' });
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
    key: 'unknown-tasks', icon: 'loading', label: `${activity.tasks.unknown} 项任务的原生状态未知`,
  });
  if (activity.hasActiveWork && !activity.processing
    && !activity.tasks.activeAgents && !activity.tasks.activeShells
    && !pendingCount && !steeringCount && !inFlightSteeringCount && !activity.mcp.pendingConnectionCount) {
    items.push({ key: 'other', icon: 'loading', label: '存在无法进一步分类的原生活动' });
  }
  if (!items.length && (previous?.status ?? session.status) === 'running') {
    items.push({ key: 'other', icon: 'loading', label: '综合状态仍忙碌，采样未提供具体活动原因' });
  }
  const concrete = items.filter(item => item.icon !== 'loading');
  const shown = concrete.length ? concrete : items.length ? [{ ...items[0], label: items.map(item => item.label).join('；') }] : [];
  return previous ? shown.map(item => ['decision', 'error', 'read-error'].includes(item.key) ? item : {
    ...item, label: `上次采样，等待更新：${item.label}`,
  }) : shown;
}
