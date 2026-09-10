// The per-session MCP connection-status pill.
import { mcpStatusOf } from '../net/mcp-status';
import type { McpServerStatus } from '@cockpit/protocol';

export function McpStatusPill({ status }: { status: McpServerStatus }) {
  const s = mcpStatusOf(status);
  return <span className="mcp-status" data-tone={s.tone} title={s.hint}>{s.label}</span>;
}
