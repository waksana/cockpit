import type { SessionMeta } from '../net/types';
import type { MenuItem } from '../components/ContextMenu';
import type { SessionPanel } from './routeOwnership';

export interface SessionActionHandlers {
  openPanel: (sessionId: string, panel: SessionPanel) => void;
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
