// Global-config tools: the cross-session catalog views a person sees in the
// hamburger MCP/Skills pages — the global MCP server list (with default-on state),
// the global skill list, the default-on toggle, and an MCP-config refresh.
// (Per-session enable/disable already lives in index.ts.)
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, protocolIntent as intent } from '../cockpit.js';
import {
  ResponseFormat,
  ok,
  fail,
  capped,
  cappedJson,
  shrinkList,
  type ToolResult,
} from '../shared.js';

export function registerGlobalTools(server: McpServer): void {
  // ── cockpit_list_global_mcp ──────────────────────────────────────────────────
  server.registerTool(
    'cockpit_list_global_mcp',
    {
      title: 'List globally-configured MCP servers',
      description:
        'List every MCP server defined in the backend selected native configuration root, with its command/url ' +
        'summary and whether it is default-on for new sessions. This is the catalog; per-session ' +
        'enablement is separate (cockpit_list_session_mcp / cockpit_set_session_mcp).',
      inputSchema: { response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const { servers } = await intent('mcp/global');
        const structured = { servers, count: servers.length };
        if (response_format === 'json')
          return ok(cappedJson(structured, shrinkList(servers, 'servers', { keep: ['name', 'defaultOn'], clip: ['detail'] })));
        if (!servers.length) return ok('# Global MCP servers\n\n_None configured._');
        const lines = servers.map((s) => `- ${s.defaultOn ? '🟢' : '⚪'} ${s.name}${s.defaultOn ? ' (default-on)' : ''}\n    ${s.detail ?? ''}`);
        return ok(capped(`# Global MCP servers (${servers.length})\n${lines.join('\n')}`));
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_set_global_mcp_default ───────────────────────────────────────────
  server.registerTool(
    'cockpit_set_global_mcp_default',
    {
      title: 'Set an MCP server default-on',
      description:
        'Write Copilot native user configuration to enable/disable this MCP server for future sessions. ' +
        'Does not change current live connections or store a Cockpit preference. Get exact names ' +
        'from cockpit_list_global_mcp.',
      inputSchema: {
        name: z.string().min(1).describe('The MCP server name (from cockpit_list_global_mcp)'),
        on: z.boolean().describe('true = default-on for new sessions, false = default-off'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, on }): Promise<ToolResult> => {
      try {
        await intent('mcp/global-default', { name, on });
        return ok(`Set ${name} default-on=${on}.`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_refresh_mcp ──────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_refresh_mcp',
    {
      title: 'Reload the MCP config',
      description:
        'Refresh Copilot native MCP configuration discovery without restarting sessions. ' +
        'Use after editing native configuration. To reload one idle ' +
        'session, use cockpit_reload_session_mcp.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (): Promise<ToolResult> => {
      try {
        await intent('mcp/refresh');
        return ok('Refreshed Copilot native MCP configuration; live sessions were not restarted.');
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_reload_session_mcp ───────────────────────────────────────────────
  server.registerTool(
    'cockpit_reload_session_mcp',
    {
      title: 'Reload one session\'s native MCP connections',
      description:
        'Use native MCP reload on a loaded idle session to reread definitions and reconnect servers. ' +
        'Native reload reapplies global defaults; temporary session choices may change. ' +
        'This is native MCP-only reload, not a close/resume. Explicitly load an unloaded target first; ' +
        "do not call it on the currently executing session's own MCP.",
      inputSchema: {
        session_id: z.string().min(1).describe('The session id whose MCP servers to reconnect'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }): Promise<ToolResult> => {
      try {
        const res = await intent('mcp/reload-session', { sessionId: session_id });
        return ok(`MCP reload completed for ${session_id}: ${res.reconnected} connected server(s). Temporary choices follow native defaults.`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_list_global_skills ───────────────────────────────────────────────
  server.registerTool(
    'cockpit_list_global_skills',
    {
      title: 'List all available skills',
      description:
        'List every skill cockpit knows (the global catalog from the skills directory), with its ' +
        'description, source and native global enabled state when available. Use cockpit_call_intent ' +
        'with name:"skills/global-toggle", body:{name,enabled,cwd?} to change Copilot native global configuration. ' +
        'Pass the discovery cwd for a project-only skill; the setting itself remains global. ' +
        'Per-session enable/disable is separate ' +
        '(cockpit_list_session_skills / cockpit_set_session_skill). After adding/removing skills on ' +
        'disk, use cockpit_refresh_skills so the catalog re-scans. Optional cwd selects project skills; ' +
        'when omitted, the backend uses its own home directory (not the MCP client cwd).',
      inputSchema: {
        cwd: z.string().optional().describe('Backend working directory for skill discovery; defaults to server home'),
        response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ cwd, response_format }): Promise<ToolResult> => {
      try {
        const { skills } = await intent('skills/global', cwd === undefined ? {} : { cwd });
        const structured = { skills, count: skills.length };
        if (response_format === 'json')
          return ok(cappedJson(structured, shrinkList(skills, 'skills', { keep: ['name', 'source', 'enabled'], clip: ['description'] })));
        if (!skills.length) return ok('# Skills\n\n_None found._');
        const lines = skills.map((s) => `- ${s.name}${s.enabled === false ? ' (disabled globally)' : ''}${s.source ? ` (${s.source})` : ''}${s.description ? `\n    ${s.description.slice(0, 140)}` : ''}`);
        return ok(capped(`# Skills (${skills.length})\n${lines.join('\n')}`));
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
