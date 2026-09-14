// Session-settings tools: change how a session runs — its model/reasoning/context
// tier, its agent mode, model-context compaction, and conversation rewind.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, protocolIntent as intent } from '../cockpit.js';
import { intentJson, fail, type ToolResult } from '../shared.js';

export function registerSettingsTools(server: McpServer): void {
  // ── cockpit_set_model ────────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_set_model',
    {
      title: 'Set a session model',
      description:
        "Set a session's intended complete model configuration. Omitted reasoning effort/context tier use native semantics; " +
        'they are not promised to preserve current settings. Use a known model id directly; if unknown, read ' +
        'cockpit_get_session with response_format:"json" → availableModels. reasoning_effort is model-specific ' +
        '(e.g. low/medium/high/xhigh, only where supported); context_tier is default or long_context. ' +
        'Returns the native status, deferred state, modelState, confirmation, persistenceError and warnings unchanged. ' +
        'deferred:true takes precedence over an applied status or message: the change is still queued. ' +
        'Explicit native failure or persistence failure sets MCP isError while retaining the JSON; queued and needs-action outcomes are not failures. ' +
        'Missing/unknown status does not establish application. ' +
        'A successful response need not mean the change was applied. One send, with no preflight, retry or automatic follow-up prompt.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        model_id: z.string().min(1).describe('The model id (from cockpit_get_session with response_format:"json" → availableModels[].modelId)'),
        reasoning_effort: z.string().optional().describe('Intended reasoning effort where supported; omission follows native semantics, with no preserve/reset promise'),
        context_tier: z.enum(['default', 'long_context']).optional().describe('Intended context tier; omission follows native semantics, with no preserve/reset promise'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, model_id, reasoning_effort, context_tier }): Promise<ToolResult> => {
      try {
        const result = await intent('setModel', {
          sessionId: session_id,
          modelId: model_id,
          ...(reasoning_effort !== undefined ? { reasoningEffort: reasoning_effort } : {}),
          ...(context_tier !== undefined ? { contextTier: context_tier } : {}),
        });
        return intentJson('setModel', result);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_set_mode ─────────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_set_mode',
    {
      title: 'Set a session agent mode',
      description:
        "Change a session's interaction mode: interactive, plan (plans first), or autopilot " +
        '(acts autonomously). These are interaction modes, NOT permission controls: permissionPolicy ' +
        'stays allow-all (always auto-approve). This tool cannot change permissions or add approval dialogs. ' +
        'Returns the native outcome, including status, confirmation and warnings; acceptance is not a claim of application. ' +
        'Explicit native failure sets MCP isError without removing the JSON. Needs-action is not failure; unknown status is not success. ' +
        'No preflight, retry or automatic follow-up prompt.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        mode: z.enum(['interactive', 'plan', 'autopilot']).describe('The agent mode to set'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, mode }): Promise<ToolResult> => {
      try {
        return intentJson('setMode', await intent('setMode', { sessionId: session_id, mode }));
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_compact_session ──────────────────────────────────────────────────
  server.registerTool(
    'cockpit_compact_session',
    {
      title: 'Compact a session context',
      description:
        "Summarize and compact a session's context to free up the window (the /compact operation). " +
        'This summarizes model-facing context, not the retained chat event history. Undo is not supported. ' +
        'Optionally pass custom_instructions to steer what the summary preserves. Native busy/decision protections apply; ' +
        'never automatically retry an uncertain result. Returns the native success, removal counts and summary/context details; ' +
        'success:false sets MCP isError while preserving the entire JSON.',
      inputSchema: z.object({
        session_id: z.string().min(1).describe('The session id'),
        custom_instructions: z.string().optional().describe('Optional guidance for what the summary should keep'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, custom_instructions }): Promise<ToolResult> => {
      try {
        const result = await intent('session/compact', {
          sessionId: session_id,
          ...(custom_instructions !== undefined ? { customInstructions: custom_instructions } : {}),
        });
        return intentJson('session/compact', result);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_rewind_session ───────────────────────────────────────────────────
  server.registerTool(
    'cockpit_rewind_session',
    {
      title: 'Rewind a session to a message',
      description:
        'Rewind to before a selected user message, discarding that turn and later history. ' +
        'Get its message id from cockpit_read_session. Set rollback_files=true to request native file rollback; ' +
        'the backend owns support and conflict handling, and failures are returned explicitly. ' +
        'This changes history irreversibly. Native busy/decision protections apply; never automatically retry an uncertain result. ' +
        'Returns the native outcome, restored/skipped files and errors; explicit failures and partial failures set MCP isError ' +
        'while preserving the entire JSON. An error flag does not mean earlier effects were rolled back.',
      inputSchema: z.object({
        session_id: z.string().min(1).describe('The session id'),
        to_msg_id: z.string().min(1).describe('The message id to rewind to (from cockpit_read_session)'),
        rollback_files: z.boolean().default(false).describe('Request native file rollback along with the conversation rewind'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, to_msg_id, rollback_files }): Promise<ToolResult> => {
      try {
        const result = await intent('session/rewind', {
          sessionId: session_id,
          toMsgId: to_msg_id,
          ...(rollback_files ? { rollbackFiles: true } : {}),
        });
        return intentJson('session/rewind', result);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
