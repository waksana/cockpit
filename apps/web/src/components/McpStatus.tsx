// The MCP connection-status pill. Shared by the per-session MCP management page
// and the session info panel; the status vocabulary lives in net/mcp-status.ts.
import { mcpStatusOf } from '../net/mcp-status';
import type { McpServerStatus } from '@cockpit/protocol';

export function McpStatusPill({ status }: { status: McpServerStatus }) {
  const s = mcpStatusOf(status);
  return <span className="mcp-status" data-tone={s.tone}>{s.label}</span>;
}
