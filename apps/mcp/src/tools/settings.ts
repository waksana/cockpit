// Session-settings tools: change how a session runs — its model/reasoning/context
// tier, its agent mode, and the two history-altering operations (compact, rewind).
// The two destructive ones require confirm=true.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, intent } from '../cockpit.js';
import { ok, fail, type ToolResult } from '../shared.js';

export function registerSettingsTools(server: McpServer): void {
  // ── cockpit_set_model ────────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_set_model',
    {
      title: 'Set a session model',
      description:
        "Change a session's model (and optionally reasoning effort + context tier). Get the valid " +
        'model ids from cockpit_get_session → availableModels. reasoning_effort is model-specific ' +
        '(e.g. low/medium/high/xhigh, only where supported); context_tier is default or long_context.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        model_id: z.string().min(1).describe('The model id (from cockpit_get_session → availableModels[].id)'),
        reasoning_effort: z.string().optional().describe('Optional reasoning effort, where the model supports it'),
        context_tier: z.enum(['default', 'long_context']).optional().describe('Optional context window tier'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, model_id, reasoning_effort, context_tier }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('setModel', {
          sessionId: session_id,
          modelId: model_id,
          ...(reasoning_effort ? { reasoningEffort: reasoning_effort } : {}),
          ...(context_tier ? { contextTier: context_tier } : {}),
        });
        return ok(`Set ${session_id} model to ${model_id}.`, { ok: res.ok });
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
        "Change a session's agent mode: interactive (asks before acting), plan (plans first, no " +
        'edits until approved), or autopilot (acts autonomously). Mirrors the mode picker in the UI.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        mode: z.enum(['interactive', 'plan', 'autopilot']).describe('The agent mode to set'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, mode }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('setMode', { sessionId: session_id, mode });
        return ok(`Set ${session_id} mode to ${mode}.`, { ok: res.ok });
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
        'This rewrites history into a summary and CANNOT be undone, so it requires confirm=true. ' +
        'Optionally pass custom_instructions to steer what the summary preserves.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        custom_instructions: z.string().optional().describe('Optional guidance for what the summary should keep'),
        confirm: z.boolean().default(false).describe('Must be true — compaction is irreversible'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, custom_instructions, confirm }): Promise<ToolResult> => {
      if (!confirm) return fail('Compaction is irreversible. Re-call with confirm=true to proceed.');
      try {
        const res = await intent<{ ok: boolean }>('session/compact', {
          sessionId: session_id,
          ...(custom_instructions ? { customInstructions: custom_instructions } : {}),
        });
        return ok(`Compacted ${session_id}.`, { ok: res.ok });
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
        'Roll a session back to an earlier message, discarding everything after it (the rewind ' +
        'operation). Get the target message id from cockpit_read_session. Optionally also roll back ' +
        'file edits made after that point with rollback_files=true. This DISCARDS later history and ' +
        'cannot be undone, so it requires confirm=true.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        to_msg_id: z.string().min(1).describe('The message id to rewind to (from cockpit_read_session)'),
        rollback_files: z.boolean().default(false).describe('Also revert file edits made after that message'),
        confirm: z.boolean().default(false).describe('Must be true — rewind discards later history irreversibly'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, to_msg_id, rollback_files, confirm }): Promise<ToolResult> => {
      if (!confirm) return fail('Rewind discards later history irreversibly. Re-call with confirm=true to proceed.');
      try {
        const res = await intent<{ ok: boolean }>('session/rewind', {
          sessionId: session_id,
          toMsgId: to_msg_id,
          ...(rollback_files ? { rollbackFiles: true } : {}),
        });
        return ok(`Rewound ${session_id} to ${to_msg_id}${rollback_files ? ' (files rolled back)' : ''}.`, { ok: res.ok });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
