// Global-config tools: the cross-session catalog views a person sees in the
// hamburger MCP/Skills pages — the global MCP server list (with default-on state),
// the global skill list, the default-on toggle, and an MCP-config refresh.
// (Per-session enable/disable already lives in index.ts.)
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, intent } from '../cockpit.js';
import {
  ResponseFormat,
  ok,
  fail,
  capped,
  cappedJson,
  shrinkList,
  type ToolResult,
  type McpServerGlobal,
  type SkillGlobal,
} from '../shared.js';

export function registerGlobalTools(server: McpServer): void {
  // ── cockpit_list_global_mcp ──────────────────────────────────────────────────
  server.registerTool(
    'cockpit_list_global_mcp',
    {
      title: 'List globally-configured MCP servers',
      description:
        'List every MCP server defined globally in ~/.copilot/mcp-config.json, with its command/url ' +
        'summary and whether it is default-on for new sessions. This is the catalog; per-session ' +
        'enablement is separate (cockpit_list_session_mcp / cockpit_set_session_mcp).',
      inputSchema: { response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const { servers } = await intent<{ servers: McpServerGlobal[] }>('mcp/global');
        const structured = { servers, count: servers.length };
        if (response_format === 'json')
          return ok(cappedJson(structured, shrinkList(servers, 'servers', { keep: ['name', 'defaultOn'], clip: ['detail'] })), structured);
        if (!servers.length) return ok('# Global MCP servers\n\n_None configured._', structured);
        const lines = servers.map((s) => `- ${s.defaultOn ? '🟢' : '⚪'} ${s.name}${s.defaultOn ? ' (default-on)' : ''}\n    ${s.detail ?? ''}`);
        return ok(capped(`# Global MCP servers (${servers.length})\n${lines.join('\n')}`), structured);
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
        'Set whether a globally-configured MCP server is enabled BY DEFAULT for new sessions. ' +
        'Does not change sessions that already have an explicit per-session choice. Get exact names ' +
        'from cockpit_list_global_mcp.',
      inputSchema: {
        name: z.string().min(1).describe('The MCP server name (from cockpit_list_global_mcp)'),
        on: z.boolean().describe('true = default-on for new sessions, false = default-off'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, on }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('mcp/global-default', { name, on });
        return ok(`Set ${name} default-on=${on}.`, { ok: res.ok });
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
        'Re-read ~/.copilot/mcp-config.json and hot-apply it to ALL loaded sessions: connect newly ' +
        'added servers, drop removed ones, and re-spawn stdio servers (so a server whose CODE ' +
        'changed is reloaded). Use after editing the global MCP config or rebuilding a server. To ' +
        'reload just one session, use cockpit_reload_session_mcp.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('mcp/refresh');
        return ok('Reloaded MCP config + reconnected servers across all loaded sessions.', { ok: res.ok });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_reload_session_mcp ───────────────────────────────────────────────
  server.registerTool(
    'cockpit_reload_session_mcp',
    {
      title: 'Restart one session\'s MCP servers',
      description:
        "Reconnect a single session's enabled MCP servers — for a stdio server this RE-SPAWNS its " +
        'process, so it picks up new server code without restarting the whole cockpit backend. Use ' +
        'this after rebuilding an MCP server (e.g. the cockpit MCP itself) to load the new tools ' +
        'into a specific session. Loads the session first if it is unloaded. Reconnecting the ' +
        "calling session's own MCP is safe — this returns from the backend, not the MCP process.",
      inputSchema: {
        session_id: z.string().min(1).describe('The session id whose MCP servers to reconnect'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean; reconnected: number }>('mcp/reload-session', { sessionId: session_id });
        return ok(`Reconnected ${res.reconnected} MCP server(s) on ${session_id} (stdio processes re-spawned).`, {
          ok: res.ok,
          reconnected: res.reconnected,
        });
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
        'description and source. Per-session enable/disable is separate ' +
        '(cockpit_list_session_skills / cockpit_set_session_skill). After adding/removing skills on ' +
        'disk, use cockpit_refresh_skills so the catalog re-scans.',
      inputSchema: { response_format: ResponseFormat.describe("'markdown' (human) or 'json' (machine)") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const { skills } = await intent<{ skills: SkillGlobal[] }>('skills/global');
        const structured = { skills, count: skills.length };
        if (response_format === 'json')
          return ok(cappedJson(structured, shrinkList(skills, 'skills', { keep: ['name', 'source'], clip: ['description'] })), structured);
        if (!skills.length) return ok('# Skills\n\n_None found._', structured);
        const lines = skills.map((s) => `- ${s.name}${s.source ? ` (${s.source})` : ''}${s.description ? `\n    ${s.description.slice(0, 140)}` : ''}`);
        return ok(capped(`# Skills (${skills.length})\n${lines.join('\n')}`), structured);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
