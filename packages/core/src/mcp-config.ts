// Global MCP config reader. MCP servers are DEFINED globally in
// ~/.copilot/mcp-config.json (`{ "mcpServers": { "<name>": { command|url, ... } } }`).
// Cockpit reads this to know what servers exist; per-session connection + status
// is separate (each session spawns its own McpHost from the same config).
//
// IMPORTANT (verified empirically): the SDK does NOT auto-read this file — cockpit
// must pass the parsed `mcpServers` record into getSession/createSession for a
// session to see any servers. Without that, session.mcp.list() is empty.

import { readFileSync } from 'node:fs';
import { copilotPath } from './paths.ts';

export type McpServerConfig = Record<string, unknown>;
export type McpServersRecord = Record<string, McpServerConfig>;

const MCP_CONFIG_FILE = copilotPath('mcp-config.json');

// Read and parse the global mcpServers record. Best-effort: returns {} on any
// error (missing file, malformed JSON, unexpected shape). `file` is injectable
// for tests; defaults to ~/.copilot/mcp-config.json.
export function readGlobalMcpServers(file: string = MCP_CONFIG_FILE): McpServersRecord {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { mcpServers?: unknown };
    const servers = raw.mcpServers;
    if (servers && typeof servers === 'object') return servers as McpServersRecord;
    return {};
  } catch { return {}; }
}

// Normalize a global mcpServers record into the shape the @github/copilot SDK's
// MCP host actually accepts before connecting. Two defaults the SDK requires but
// the raw ~/.copilot/mcp-config.json entries omit:
//
//  • `tools`: the SDK's `validateServerConfig` REJECTS any server without a
//    `tools` field ("No tools specified for server ...") and then silently skips
//    it — the host keeps it in config but never dials it, so its status reports
//    `not_configured` ("未就绪") forever. The full CLI defaults to including all
//    tools; we mirror that with `tools: '*'`.
//  • `args`: a local (command) server is only valid when `args` is an array
//    (`isValidLocalServerConfig`). Command-only entries (e.g. a wrapper script)
//    omit it, so default to `[]`.
//
// Verified empirically against @github/copilot 1.0.63: with these defaults a
// session's servers connect (`connected`); without them they stay
// `not_configured`. Returns a fresh record; never mutates the input or the
// raw config used for display.
export function normalizeMcpServersForSdk(record: McpServersRecord): McpServersRecord {
  const out: McpServersRecord = {};
  for (const [name, cfg] of Object.entries(record)) {
    const next: Record<string, unknown> = { ...cfg };
    if (next.tools === undefined) next.tools = '*';
    const type = typeof next.type === 'string' ? next.type.toLowerCase() : undefined;
    const isLocal = type === undefined || type === 'local' || type === 'stdio';
    if (isLocal && typeof next.command === 'string' && !Array.isArray(next.args)) {
      next.args = [];
    }
    out[name] = next;
  }
  return out;
}

// A one-line human summary of how a server connects (command or url + transport),
// for display in the management UI.
export function describeMcpServer(cfg: McpServerConfig): string {
  const command = typeof cfg.command === 'string' ? cfg.command : undefined;
  const url = typeof cfg.url === 'string' ? cfg.url : undefined;
  if (url) return url;
  if (command) {
    const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [];
    return [command, ...args].join(' ');
  }
  return 'custom';
}
