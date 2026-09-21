import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RoleSelection } from '@cockpit/protocol';
import { protocolIntent as intent } from '../cockpit.js';
import { ResponseFormat, cappedJson, fail, ok, intentJson } from '../shared.js';

export function registerRoleTools(server: McpServer): void {
  server.registerTool('cockpit_list_roles', {
    title: 'List module roles', description: 'Discover module roles for creation or metadata-only addition to existing sessions. Multiple roles from one module are allowed.',
    inputSchema: { response_format: ResponseFormat },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ response_format }) => {
    try {
      const result = await intent('roles/list', {});
      return ok(response_format === 'json' ? cappedJson(result)
        : result.roles.map(role => `- ${role.moduleId}/${role.roleId}: ${role.name}${role.description ? ` — ${role.description}` : ''}`).join('\n') || 'No module roles available.');
    } catch (error) { return fail(String(error)); }
  });
  server.registerTool('cockpit_add_roles', {
    title: 'Add session roles',
    description: 'Append saved module roles only, including while main/subagent/shell work, queues, questions or schedules are active. Never removes roles, stops, reloads, resumes, sends a prompt or retries; unloaded sessions stay unloaded. Native load/close/delete conflicts may reject. Validates selected catalog IDs and the 64-role limit; composition and resource validation occur on ordinary explicit reload or next cold load, when new roles apply under native/global defaults without retaining temporary switches or session-only resources specially. Returns saved/unchanged/uncertain, saved roles, appliedRoles, loaded and rolesNeedReload; saved is not applied or ready. No phase/readiness response; readiness is a separate passive check. Inspect uncertain persistence before explicit recovery; no rollback. Does not change Task responsibility or global configuration.',
    inputSchema: { session_id: z.string().min(1), roles: z.array(RoleSelection).min(1).max(64) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ session_id, roles }) => {
    try { return intentJson('roles/add', await intent('roles/add', { sessionId: session_id, roles })); }
    catch (error) { return fail(String(error)); }
  });
  server.registerTool('cockpit_role_readiness', {
    title: 'Check session role readiness', description: 'Explicitly check current role assembly, native skills, MCP connections and tool visibility. A separate passive check: does not load, apply saved roles or repair sessions. Capability readiness is independent of busy turns, pending messages and subagents. Persisted role labels and rolesNeedReload are not readiness.',
    inputSchema: { session_id: z.string().min(1), roles: z.array(RoleSelection).max(64).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ session_id, roles }) => {
    try { return ok(cappedJson(await intent('roles/readiness', { sessionId: session_id, roles }))); }
    catch (error) { return fail(String(error)); }
  });
}
