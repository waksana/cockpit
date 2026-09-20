import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RoleSelection } from '@cockpit/protocol';
import { protocolIntent as intent } from '../cockpit.js';
import { ResponseFormat, cappedJson, fail, ok } from '../shared.js';

export function registerRoleQueueTools(server: McpServer): void {
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
    title: 'Check session role readiness', description: 'Read current selected-role skills and MCP readiness. Does not load or repair sessions. Persisted role labels are not readiness.',
    inputSchema: { session_id: z.string().min(1), roles: z.array(RoleSelection).max(64).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ session_id, roles }) => {
    try { return ok(cappedJson(await intent('roles/readiness', { sessionId: session_id, roles }))); }
    catch (error) { return fail(String(error)); }
  });
  server.registerTool('cockpit_advance_queue', {
    title: 'Advance native queued messages',
    description: 'Start/get/cancel an operation that interrupts only the main turn, preserving the native queue and background tasks. Start returns immediately. One active operation per target; follows newly arriving messages until the latest queued tail is admitted, leaving its turn running. No business timeout, round limit, retry or restart recovery. Cancel stops future interrupts; in-flight interruption can settle. Disconnect is not cancellation. After a lost receipt, get by session_id without operation_id before starting again.',
    inputSchema: {
      action: z.enum(['start', 'get', 'cancel']), session_id: z.string().min(1), operation_id: z.string().min(1).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ action, session_id, operation_id }) => {
    try {
      const result = await intent('session/advance-queue', { action, sessionId: session_id, operationId: operation_id });
      return result.operation?.state === 'failed' ? fail(cappedJson(result)) : ok(cappedJson(result));
    } catch (error) { return fail(String(error)); }
  });
}
