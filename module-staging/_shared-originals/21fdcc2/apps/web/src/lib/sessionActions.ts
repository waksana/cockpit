import type { SessionMeta } from '../net/types';
import type { MenuItem } from '../components/ContextMenu';
import type { SessionPanel } from './routeOwnership';

export interface SessionActionHandlers {
  openPanel: (sessionId: string, panel: SessionPanel) => void;
  fork: (sessionId: string) => void;
  pin: (sessionId: string, pinned: boolean) => void;
  delete: (sessionId: string) => void;
}

export function sessionActionItems(
  session: SessionMeta,
  connected: boolean,
  handlers: SessionActionHandlers,
): MenuItem[] {
  const sessionId = session.sessionId;
  return [
    { id: 'info', label: '会话设置', icon: 'file', onClick: () => handlers.openPanel(sessionId, 'info') },
    { id: 'mcp', label: '本会话 MCP', icon: 'mcp', onClick: () => handlers.openPanel(sessionId, 'mcp') },
    { id: 'skills', label: '本会话 Skills', icon: 'skills', onClick: () => handlers.openPanel(sessionId, 'skills') },
    { id: 'plan', label: '计划与任务', icon: 'mode_plan', separatorBefore: true, onClick: () => handlers.openPanel(sessionId, 'plan') },
    { id: 'context', label: '上下文资料', icon: 'folder', onClick: () => handlers.openPanel(sessionId, 'context') },
    { id: 'schedules', label: '定时任务', icon: 'schedule', onClick: () => handlers.openPanel(sessionId, 'schedules') },
    { id: 'runtime', label: '运行维护', icon: 'reload', onClick: () => handlers.openPanel(sessionId, 'runtime') },
    {
      id: 'fork',
      label: '分叉为独立会话',
      separatorBefore: true,
      icon: 'newchat',
      disabled: !connected || !session.loaded || !!(session.autoNaming || session.status === 'running'
        || session.nativeProcessing || session.loading || session.closing || session.cancelling
        || session.compacting || session.ask || session.planRequest || session.elicitation)
        || !!session.queue?.length || !!session.activeSubagents || !!session.scheduleCount,
      onClick: () => handlers.fork(sessionId),
    },
    {
      id: 'pin',
      label: session.pinned ? '取消置顶' : '置顶',
      icon: session.pinned ? 'unpin' : 'pin',
      disabled: !connected,
      onClick: () => handlers.pin(sessionId, !session.pinned),
    },
    {
      id: 'delete',
      label: '永久删除会话',
      separatorBefore: true,
      icon: 'delete',
      destructive: true,
      disabled: !connected,
      onClick: () => handlers.delete(sessionId),
    },
  ];
}
