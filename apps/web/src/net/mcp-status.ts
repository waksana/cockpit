// Shared MCP connection-status vocabulary. MCP connection state is per-session
// (each session owns its McpHost), so it is surfaced on both the per-session MCP
// management page and the session info panel — one source of truth keeps their
// labels/tones identical. `hint` is a static, actionable explanation for a not-OK
// state that carries no server-supplied error string.
import type { McpServerStatus } from '@cockpit/protocol';

export const MCP_STATUS: Record<McpServerStatus, { label: string; tone: string; hint?: string }> = {
  connected: { label: '已连接', tone: 'ok' },
  failed: { label: '失败', tone: 'err' },
  'needs-auth': { label: '待授权', tone: 'warn', hint: '需要授权后才能使用' },
  pending: { label: '连接中', tone: 'pending' },
  not_configured: { label: '未配置', tone: 'warn', hint: '服务器配置无效或不完整' },
  disabled: { label: '已关闭', tone: 'off' },
  unloaded: { label: '未加载', tone: 'off', hint: '会话未加载；查看状态不会唤醒会话' },
};

export function mcpStatusOf(status: McpServerStatus): { label: string; tone: string; hint?: string } {
  return MCP_STATUS[status];
}
