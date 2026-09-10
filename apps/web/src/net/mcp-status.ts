// Shared MCP connection-status vocabulary. MCP connection state is per-session
// (each session owns its McpHost). `hint` is a static explanation for a not-OK
// state that carries no server-supplied error string.
import type { McpServerStatus } from '@cockpit/protocol';

export const MCP_STATUS: Record<McpServerStatus, { label: string; tone: string; hint?: string }> = {
  connected: { label: '已连接', tone: 'ok' },
  failed: { label: '失败', tone: 'err' },
  'needs-auth': { label: '待授权', tone: 'warn', hint: '需要授权后才能使用' },
  pending: { label: '连接中', tone: 'pending' },
  stopped: { label: '已停止', tone: 'off', hint: '服务器已停止；仅在策略允许时可按需重新启动，受限策略隔离时不能重启' },
  not_configured: { label: '未配置', tone: 'warn', hint: '本会话未配置此服务器' },
  disabled: { label: '已关闭', tone: 'off' },
  unloaded: { label: '未加载', tone: 'off', hint: '会话未加载；查看状态不会唤醒会话' },
};

export function mcpStatusOf(status: McpServerStatus): { label: string; tone: string; hint?: string } {
  return MCP_STATUS[status];
}
