import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertIntentSuccess, backendJson, CockpitError, intent, protocolIntent } from '../cockpit.js';
import { fail, ok, intentJson, type ToolResult } from '../shared.js';

const IntentName = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/);
const Summary = z.object({ name: IntentName, description: z.string() });
const Detail = Summary.extend({
  inputSchema: z.record(z.unknown()),
  resultSchema: z.record(z.unknown()),
});
const Listing = z.object({
  intents: z.array(Summary).max(100),
  transports: z.array(z.object({ method: z.string(), path: z.string() })),
  runtime: z.record(z.unknown()).optional(),
});

async function capability(name: string) {
  const detail = Detail.parse(await backendJson(`/capabilities?${new URLSearchParams({ name })}`));
  if (detail.name !== name) throw new CockpitError('Backend returned a different intent capability', 'protocol');
  return detail;
}

// The backend owns publication and body/result validation. Explicit discovery is
// independent of invocation, so calls need no preflight or local intent catalog.
export async function invokePublishedIntent(name: string, body: Record<string, unknown>): Promise<unknown> {
  IntentName.parse(name);
  const result = await intent(name, body);
  return name === 'session/resources-prepare' ? result : assertIntentSuccess(result, name);
}

export function registerFoundationTools(server: McpServer): void {
  server.registerTool('cockpit_capabilities', {
    title: 'Discover the Cockpit API',
    description: 'List published intent names and transports, or supply name to read one authoritative JSON input/result schema. '
      + 'Use prefix/limit/offset for bounded name listings, then cockpit_call_intent to invoke any published intent.',
    inputSchema: {
      name: IntentName.optional(),
      prefix: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ name, prefix, limit, offset }): Promise<ToolResult> => {
    try {
      if (name !== undefined) {
        if (prefix !== undefined || limit !== undefined || offset !== undefined) {
          return fail('Use name alone for detail, or prefix/limit/offset for a listing.');
        }
        return ok(JSON.stringify(await capability(name), null, 2));
      }
      const query = new URLSearchParams({ limit: String(limit ?? 50), offset: String(offset ?? 0) });
      if (prefix !== undefined) query.set('prefix', prefix);
      const result = Listing.parse(await backendJson(`/capabilities?${query}`));
      return ok(JSON.stringify(result, null, 2));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });

  server.registerTool('cockpit_call_intent', {
    title: 'Invoke a published Cockpit intent',
    description: 'Call any intent published by cockpit_capabilities using its exact API body (camelCase keys). '
      + 'Sends one POST without a capability preflight; the authoritative backend rejects unknown or retired names and validates '
      + 'the body and result. Session compact/rewind/delete use native safeguards; host system/shutdown requires confirm:true. '
      + 'prompt accepts text and optional SDK-native attachments; no managed upload or file-reference resolution is provided. '
      + 'session/rewind with rollbackFiles:true '
      + 'requests native file rollback; conflicts fail explicitly. permissionPolicy stays allow-all; modes are interaction settings. '
      + 'May mutate or delete data; use cockpit_capabilities when the API schema is unknown. No automatic retries, including on timeout. '
      + 'Returns the complete JSON result. Known native failures/partial failures set MCP isError without removing native details; '
      + 'queued and needs-action outcomes are not failures, and unknown status is not proof of application. '
      + 'Prefer paginated semantic reads for large transcripts.',
    inputSchema: {
      name: IntentName,
      body: z.record(z.unknown()).default({}),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ name, body }): Promise<ToolResult> => {
    try {
      return intentJson(name, await invokePublishedIntent(name, body));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });

  server.registerTool('cockpit_get_snapshot', {
    title: 'Read the authoritative runtime snapshot',
    description: 'Read runtime/snapshot: agentStatus, models, sessions and required '
      + 'permissionPolicy:"allow-all". This is the always-auto-approve policy, distinct from interactive/plan/autopilot '
      + 'interaction modes. No permissions are mutated or approval dialogs introduced. Returns complete JSON.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (): Promise<ToolResult> => {
    try {
      const snapshot = await protocolIntent('runtime/snapshot');
      if (snapshot.type !== 'snapshot' || snapshot.permissionPolicy !== 'allow-all') {
        throw new CockpitError('Backend returned an invalid snapshot or permissionPolicy (expected allow-all).', 'protocol');
      }
      return ok(JSON.stringify(snapshot, null, 2));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });

  server.registerTool('cockpit_service_status', {
    title: 'Read Cockpit service health or status',
    description: 'Read backend health or detailed status, including native busy sessions, in-flight requests and graceful shutdown state. Shutdown does not restart the service.',
    inputSchema: { operation: z.enum(['health', 'status']).default('status') },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ operation }): Promise<ToolResult> => {
    try {
      return ok(JSON.stringify(await backendJson(operation === 'health' ? '/health' : '/status'), null, 2));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });

}
