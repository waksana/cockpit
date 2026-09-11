// Session-settings tools: change how a session runs — its model/reasoning/context
// tier, its agent mode, model-context compaction, and conversation rewind.
// Compaction and rewind retain explicit confirmation.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, protocolIntent as intent } from '../cockpit.js';
import { ok, fail, type ToolResult } from '../shared.js';

export function registerSettingsTools(server: McpServer): void {
  // ── cockpit_set_model ────────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_set_model',
    {
      title: 'Set a session model',
      description:
        "Change a session's model (and optionally reasoning effort + context tier). Get the valid " +
        'model ids from cockpit_get_session with response_format:"json" → availableModels. reasoning_effort is model-specific ' +
        '(e.g. low/medium/high/xhigh, only where supported); context_tier is default or long_context.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        model_id: z.string().min(1).describe('The model id (from cockpit_get_session with response_format:"json" → availableModels[].modelId)'),
        reasoning_effort: z.string().optional().describe('Optional reasoning effort, where the model supports it'),
        context_tier: z.enum(['default', 'long_context']).optional().describe('Optional context window tier'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, model_id, reasoning_effort, context_tier }): Promise<ToolResult> => {
      try {
        await intent('setModel', {
          sessionId: session_id,
          modelId: model_id,
          ...(reasoning_effort !== undefined ? { reasoningEffort: reasoning_effort } : {}),
          ...(context_tier !== undefined ? { contextTier: context_tier } : {}),
        });
        return ok(`Model setting request accepted for ${session_id}. Read cockpit_get_session for authoritative model, effort and context tier; a deferred change is not applied until native queued work completes.`);
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
        'stays allow-all (always auto-approve). This tool cannot change permissions or add approval dialogs.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        mode: z.enum(['interactive', 'plan', 'autopilot']).describe('The agent mode to set'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, mode }): Promise<ToolResult> => {
      try {
        await intent('setMode', { sessionId: session_id, mode });
        return ok(`Set ${session_id} interaction mode to ${mode}. permissionPolicy remains allow-all (always auto-approve).`);
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
        'This summarizes model-facing context, not the retained chat event history. Undo is not supported, so it requires confirm=true. ' +
        'Optionally pass custom_instructions to steer what the summary preserves.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        custom_instructions: z.string().optional().describe('Optional guidance for what the summary should keep'),
        confirm: z.boolean().default(false).describe('Must be true — model-context compaction has no undo'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, custom_instructions, confirm }): Promise<ToolResult> => {
      if (!confirm) return fail('Model-context compaction has no undo; retained chat history is not deleted. Re-call with confirm=true to proceed.');
      try {
        await intent('session/compact', {
          sessionId: session_id,
          ...(custom_instructions ? { customInstructions: custom_instructions } : {}),
        });
        return ok(`Compacted ${session_id}.`);
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
        'This changes history and cannot be undone, so it requires confirm=true.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        to_msg_id: z.string().min(1).describe('The message id to rewind to (from cockpit_read_session)'),
        rollback_files: z.boolean().default(false).describe('Request native file rollback along with the conversation rewind'),
        confirm: z.boolean().default(false).describe('Must be true — rewind discards later history irreversibly'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, to_msg_id, rollback_files, confirm }): Promise<ToolResult> => {
      if (!confirm) return fail('Rewind discards later history irreversibly. Re-call with confirm=true to proceed.');
      try {
        await intent('session/rewind', {
          sessionId: session_id,
          toMsgId: to_msg_id,
          ...(rollback_files ? { rollbackFiles: true } : {}),
        });
        return ok(`Rewound ${session_id} to ${to_msg_id}. ${rollback_files ? 'Native file rollback was requested.' : 'Files were not rolled back.'}`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
