// Lifecycle tools: create, soft-delete (trash), unload, and reload sessions.
// (Rename, pin, restore, and purge already live in index.ts.)
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, protocolIntent as intent } from '../cockpit.js';
import { ok, fail, type ToolResult } from '../shared.js';

export function registerLifecycleTools(server: McpServer): void {
  // ── cockpit_new_session ──────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_new_session',
    {
      title: 'Create a new session',
      description:
        'Create a new Copilot session rooted at a working directory (its cwd, which sets the ' +
        'project identity and which AGENTS.md/skills apply). Returns the new session id. ' +
        'Native idle cleanup may unload it later; a prompt or explicit reload resumes it. ' +
        'Reading history does not load a runtime. Use cockpit_list_dir to pick a cwd.',
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute working directory for the new session'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cwd }): Promise<ToolResult> => {
      try {
        const res = await intent('session/new', {
          cwd,
        });
        return ok(
          `Created session ${res.sessionId} (cwd: ${cwd}).`,
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
        'permanent delete — that is cockpit_purge_session and requires explicit confirmation. ' +
        'Use this to declutter; purge is a separate, gated step.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id to trash'),
        reason: z.string().optional().describe('Optional reason recorded on the trash entry'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, reason }): Promise<ToolResult> => {
      try {
        await intent('session/delete', {
          sessionId: session_id,
          ...(reason ? { reason } : {}),
        });
        return ok(`Moved ${session_id} to trash (restorable with cockpit_restore_session).`);
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
        'disk. A prompt or explicit reload resumes it; reading history does not. UI pinning does ' +
        'not keep it loaded. Native schedules pause while unloaded. Does not work mid-turn.',
      inputSchema: { session_id: z.string().min(1).describe('The session id to unload') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }): Promise<ToolResult> => {
      try {
        await intent('session/unload', { sessionId: session_id });
        return ok(`Unloaded ${session_id}; history is preserved. A prompt or explicit reload resumes it.`);
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
        'Explicitly resume an unloaded session, or close and resume an idle loaded one. Native ' +
        'relative schedule delays restart on resume. Use after an out-of-band change, or to recover a session showing ' +
        'a stale state. Fails on a running session (cannot reload mid-turn).',
      inputSchema: { session_id: z.string().min(1).describe('The session id to reload') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }): Promise<ToolResult> => {
      try {
        await intent('session/reload', { sessionId: session_id });
        return ok(`Reloaded ${session_id}.`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
