// The per-session MCP connection-status pill.
import { mcpStatusOf } from '../net/mcp-status';
import type { McpServerStatus } from '@cockpit/protocol';
import { Badge } from './UI';

export function McpStatusPill({ status, appearance = 'subtle' }: { status: McpServerStatus; appearance?: 'subtle' | 'text' }) {
  const s = mcpStatusOf(status);
  const tone = s.tone === 'ok' || s.tone === 'err' || s.tone === 'warn' || s.tone === 'pending' || s.tone === 'off'
    ? s.tone : 'neutral';
  return <Badge className="mcp-status" tone={tone} appearance={appearance} title={s.hint}>{s.label}</Badge>;
}
