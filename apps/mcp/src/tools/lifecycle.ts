// Lifecycle tools: create, permanently delete, unload, and reload sessions.
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
      title: 'Permanently delete a session',
      description:
        'IRREVERSIBLE. Delete a session through the public native Copilot deleteSession API. ' +
        'Only run when permanent deletion is intended, with explicit confirm:true. ' +
        'Managed files, associations and workspaces are retained. Busy sessions are protected. ' +
        'Never automatically retry an uncertain result.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id to permanently delete'),
        confirm: z.literal(true).describe('Explicit confirmation of irreversible native deletion; required'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, confirm }): Promise<ToolResult> => {
      try {
        // Retain the already-destructive wire name across staggered deployments.
        await intent('session/purge', {
          sessionId: session_id,
          confirm,
        });
        return ok(`Deleted ${session_id} permanently. Managed files and workspaces are retained.`);
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
