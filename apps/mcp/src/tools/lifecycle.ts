// Lifecycle tools: create, permanently delete, unload, and reload sessions.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ModuleSelections, SessionUnbindApproval } from '@cockpit/protocol';
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
        'This is the low-level native creation primitive: an empty session with no first message may not survive unload. ' +
        'For first-message creation, use session/start via cockpit_call_intent with a stable operationId and real text/files; ' +
        'it prepares selected roles before submitting that first message. Inspect session/start/get after an uncertain result. ' +
        'A persisted session can be resumed with its original ID; a missing one is never silently recreated. ' +
        'Optional modules explicitly compose installed roles without global injection. Inspect modules/list before selecting. ' +
        'Module failure retains a session/operation identity; inspect it rather than recreating blindly. ' +
        'Reading history does not load a runtime. Use cockpit_list_dir to pick a cwd.',
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute working directory for the new session'),
        modules: ModuleSelections.optional().describe('Explicit installed module roles; omitted means no module role'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cwd, modules }): Promise<ToolResult> => {
      try {
        const res = await intent('session/new', {
          cwd, ...(modules ? { modules } : {}),
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
        'Managed files, file associations and workspaces are retained. Busy sessions are protected. ' +
        'If associated modules declare unbind, first read session/delete/preview via cockpit_call_intent, ' +
        'then supply unbind with that planId and a stable operationId after explicit unbind-and-delete confirmation. ' +
        'Modules without this capability receive no hook or notification. ' +
        'Never automatically retry an uncertain result.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id to permanently delete'),
        confirm: z.literal(true).describe('Explicit confirmation of irreversible native deletion; required'),
        unbind: SessionUnbindApproval.optional().describe('Explicit approval of the previewed optional module unbind steps'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, confirm, unbind }): Promise<ToolResult> => {
      try {
        // Retain the already-destructive wire name across staggered deployments.
        await intent('session/purge', {
          sessionId: session_id,
          confirm,
          ...(unbind ? { unbind } : {}),
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
