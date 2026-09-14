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
        'Uses the same session/new API as Web and returns the real native ID; ' +
        'it never sends a message. Send subsequent content with cockpit_send_prompt to that ID. ' +
        'An empty session with no first message may not survive unload. ' +
        'A persisted session can be resumed with its original ID; a missing one is never silently recreated. ' +
        'Uses native configuration discovery without product role injection. Do not retry an uncertain creation. ' +
        'Reading history does not load a runtime. Use cockpit_list_dir to pick a cwd.',
      inputSchema: z.object({
        cwd: z.string().min(1).describe('Absolute working directory for the new session'),
      }).strict(),
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
        'Only run when permanent deletion is intended. ' +
        'Cockpit does not delete workspace or unrelated files. Busy sessions are protected. ' +
        'Never automatically retry an uncertain result.',
      inputSchema: z.object({
        session_id: z.string().min(1).describe('The session id to permanently delete'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id }): Promise<ToolResult> => {
      try {
        await intent('session/delete', {
          sessionId: session_id,
        });
        return ok(`Deleted ${session_id} permanently. Cockpit did not delete workspace or unrelated files.`);
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
        'Unload an idle session from memory to free resources. Persisted history is retained. ' +
        'An empty, never-messaged native session may disappear on unload; no replacement is created. ' +
        'For an existing persisted ID, a prompt or explicit load/reload resumes it; reading history does not. ' +
        'Native schedules pause while unloaded. Does not work mid-turn.',
      inputSchema: { session_id: z.string().min(1).describe('The session id to unload') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }): Promise<ToolResult> => {
      try {
        await intent('session/unload', { sessionId: session_id });
        return ok(`Unloaded ${session_id}; persisted history is retained. Empty never-messaged sessions may disappear; session/get reports actual presence.`);
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
