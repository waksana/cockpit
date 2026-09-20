import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RoleSelection } from '@cockpit/protocol';
import { protocolIntent as intent } from '../cockpit.js';
import { ResponseFormat, cappedJson, fail, ok } from '../shared.js';

export function registerRoleTools(server: McpServer): void {
  server.registerTool('cockpit_list_roles', {
    title: 'List module roles', description: 'Discover creation-time module roles. Multiple roles from one module are allowed. No live role additions.',
    inputSchema: { response_format: ResponseFormat },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ response_format }) => {
    try {
      const result = await intent('roles/list', {});
      return ok(response_format === 'json' ? cappedJson(result)
        : result.roles.map(role => `- ${role.moduleId}/${role.roleId}: ${role.name}${role.description ? ` — ${role.description}` : ''}`).join('\n') || 'No module roles available.');
    } catch (error) { return fail(String(error)); }
  });
  server.registerTool('cockpit_role_readiness', {
    title: 'Check session role readiness', description: 'Explicitly check current role assembly, native skills, MCP connections and tool visibility. Does not load or repair sessions. Capability readiness is independent of busy turns, pending messages and subagents. Persisted role labels are not readiness.',
    inputSchema: { session_id: z.string().min(1), roles: z.array(RoleSelection).max(64).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ session_id, roles }) => {
    try { return ok(cappedJson(await intent('roles/readiness', { sessionId: session_id, roles }))); }
    catch (error) { return fail(String(error)); }
  });
}
