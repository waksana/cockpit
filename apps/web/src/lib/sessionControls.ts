import type { ChatSession } from '../net/types';
import type { ActivityIndicator } from './sessionActivity';

export interface SessionControls {
  main: boolean;
  compaction: 'manual' | 'auto' | null;
  tasks: {
    id: string;
    kind: 'shell' | 'agent';
    title: string;
    status: 'running' | 'cancelled';
    messageId?: string;
  }[];
  steering: { id: string; text: string }[];
}

export type SessionControlAction =
  | { type: 'stop-all' | 'clear-queue' | 'cancel-compaction' | 'prune-tasks' }
  | { type: 'stop-task' | 'remove-task' | 'remove' | 'steer'; id: string };

export function controlIndicators(session: ChatSession, controls: SessionControls, connected: boolean): ActivityIndicator[] {
  if (!connected) return [{ key: 'overall', icon: 'unknown', label: '总状态：待同步' }];
  const decision = !!(session.ask || session.planRequest || session.elicitation);
  const shells = controls.tasks.filter(task => task.kind === 'shell' && task.status === 'running').length;
  const agents = controls.tasks.filter(task => task.kind === 'agent' && task.status === 'running').length;
  const queue = (session.queue?.length ?? 0) + controls.steering.length;
  const active = controls.main || shells > 0 || agents > 0 || controls.compaction || decision || queue > 0;
  const items: ActivityIndicator[] = [{
    key: 'overall', icon: session.error ? 'error' : active ? 'loading' : 'radiooff',
    label: session.error ? `总状态：出错，${session.error}` : active ? '总状态：会话有活动，不代表模型正在生成' : '总状态：空闲',
  }];
  if (decision) items.push({ key: 'decision', icon: 'decision', label: '等待你的回答或确认' });
  if (controls.compaction) items.push({ key: 'compaction', icon: 'compress', label: '正在压缩上下文' });
  if (agents) items.push({ key: 'agent', icon: 'agent', count: agents, label: `活动 agent ${agents}` });
  if (shells) items.push({ key: 'shell', icon: 'shell', count: shells, label: `后台 terminal ${shells}` });
  if (queue) items.push({ key: 'queue', icon: 'queue', count: queue, label: `待处理消息 ${queue}` });
  return items;
}
