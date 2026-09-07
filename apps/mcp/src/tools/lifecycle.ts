// Lifecycle tools: create, soft-delete (trash), unload, and reload sessions.
// (Rename, pin, restore, and purge already live in index.ts.)
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, intent } from '../cockpit.js';
import { ok, fail, type ToolResult } from '../shared.js';

export function registerLifecycleTools(server: McpServer): void {
  // ── cockpit_new_session ──────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_new_session',
    {
      title: 'Create a new session',
      description:
        'Create a new Copilot session rooted at a working directory (its cwd, which sets the ' +
        "project identity and which AGENTS.md/skills apply). Returns the new session id. NOTE: a " +
        'freshly created session is cold — send it a first prompt with cockpit_send_prompt to ' +
        'materialize it before pinning or toggling MCP/skills on it. Use cockpit_list_dir to pick a cwd. ' +
        'When a daemon/orchestrator spawns SUB-WORKER sessions it drives (e.g. a review master ' +
        'dispatching one session per module), pass spawned_by so each child is born as a worker: it ' +
        'gets the R1 mark (a non-trigger-source — its lifecycle fires no welcome/other flow, so you ' +
        'need not pause the welcome hook) AND is folded into the sidebar worker group ("来自 <label>").',
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute working directory for the new session'),
        spawned_by: z
          .string()
          .optional()
          .describe(
            'Optional worker label. Set it when this session is a sub-worker spawned by a ' +
              'daemon/orchestrator: the child is born with the spawnedBy mark — an R1 ' +
              'non-trigger-source (fires no hook/flow) and folded under the sidebar worker ' +
              'group. Use a stable label, e.g. spawned_by:"review-master". Omit for a normal session.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cwd, spawned_by }): Promise<ToolResult> => {
      try {
        const res = await intent<{ sessionId: string }>('session/new', {
          cwd,
          ...(spawned_by ? { spawnedBy: spawned_by } : {}),
        });
        return ok(
          `Created session ${res.sessionId} (cwd: ${cwd})` +
            `${spawned_by ? ` as worker (spawnedBy=${spawned_by})` : ''}. It is cold — send a first ` +
            `prompt to materialize it before pin/MCP/skill config.`,
          { sessionId: res.sessionId },
        );
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_delete_session ───────────────────────────────────────────────────
  server.registerTool(
    'cockpit_delete_session',
    {
      title: 'Move a session to trash',
      description:
        'Soft-delete a session: move it to the trash bin (reversible). It is hidden from the live ' +
        'list but kept on disk and restorable with cockpit_restore_session. This is NOT the ' +
        'permanent delete — that is cockpit_purge_session, which only runs after salvage with the ' +
        "owner's go-ahead. Use this to declutter; purge is a separate, gated step.",
      inputSchema: {
        session_id: z.string().min(1).describe('The session id to trash'),
        reason: z.string().optional().describe('Optional reason recorded on the trash entry'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, reason }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('session/delete', {
          sessionId: session_id,
          ...(reason ? { reason } : {}),
        });
        return ok(`Moved ${session_id} to trash (restorable with cockpit_restore_session).`, { ok: res.ok });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_unload_session ───────────────────────────────────────────────────
  server.registerTool(
    'cockpit_unload_session',
    {
      title: 'Unload a session from memory',
      description:
        'Unload an idle session from memory to free resources. Non-destructive: its history is on ' +
        'disk and it transparently re-materializes on next open/prompt. A pinned session should be ' +
        'unpinned first (pinned sessions are kept resident on purpose). Does not work mid-turn.',
      inputSchema: { session_id: z.string().min(1).describe('The session id to unload') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('session/unload', { sessionId: session_id });
        return ok(`Unloaded ${session_id} (re-materializes on next use).`, { ok: res.ok });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_reload_session ───────────────────────────────────────────────────
  server.registerTool(
    'cockpit_reload_session',
    {
      title: 'Reload a session',
      description:
        'Reload a session from disk: unload then re-materialize it, re-reading its history and ' +
        're-arming its schedules. Use after an out-of-band change, or to recover a session showing ' +
        'a stale state. Fails on a running session (cannot reload mid-turn).',
      inputSchema: { session_id: z.string().min(1).describe('The session id to reload') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('session/reload', { sessionId: session_id });
        return ok(`Reloaded ${session_id}.`, { ok: res.ok });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
