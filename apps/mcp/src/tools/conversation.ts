// Conversation tools: drive a session's turn — send a prompt, cancel the running
// turn, and remove a queued message. These are how an agent (or a multiagent
// orchestrator) actually talks to another cockpit session.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CockpitError, intent } from '../cockpit.js';
import { ok, fail, type ToolResult } from '../shared.js';

export function registerConversationTools(server: McpServer): void {
  // ── cockpit_send_prompt ──────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_send_prompt',
    {
      title: 'Send a prompt to a session',
      description:
        'Send a user message into a cockpit session — the same as typing in its composer. ' +
        'Defaults to enqueue (CLI-style queue): if a turn is already running the message waits ' +
        'its turn; with mode="immediate" it starts a fresh turn now. Fire-and-forget: returns as ' +
        'soon as the message is accepted (the turn runs asynchronously; read it back later with ' +
        'cockpit_read_session or cockpit_get_session). Use this to drive another session or a ' +
        'multiagent worker. Find the session id with cockpit_list_sessions.',
      inputSchema: {
        session_id: z.string().min(1).describe('The target session id'),
        text: z.string().min(1).describe('The message text to send'),
        mode: z
          .enum(['enqueue', 'immediate'])
          .default('enqueue')
          .describe('enqueue = wait behind a running turn (default, safe); immediate = start a fresh turn now'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, text, mode }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean; queued?: boolean }>('prompt', { sessionId: session_id, text, mode });
        return ok(
          `Sent to ${session_id} (${mode}${res.queued ? ', queued' : ''}). The turn runs asynchronously — ` +
            `read it back with cockpit_read_session.`,
          { ok: res.ok, queued: res.queued ?? false },
        );
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_cancel_turn ──────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_cancel_turn',
    {
      title: 'Cancel the running turn',
      description:
        "Stop the in-flight turn on a session (the same as the stop button). No-op if nothing is " +
        'running. Use this to interrupt a long or stuck turn before sending new input.',
      inputSchema: { session_id: z.string().min(1).describe('The session id whose turn to cancel') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('cancel', { sessionId: session_id });
        return ok(`Cancel signalled on ${session_id}.`, { ok: res.ok });
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );

  // ── cockpit_remove_queued ────────────────────────────────────────────────────
  server.registerTool(
    'cockpit_remove_queued',
    {
      title: 'Remove a queued message',
      description:
        'Remove one not-yet-sent message from a session\'s queue. Get the item id from the ' +
        'queue array returned by cockpit_get_session (each item is {id, text}). Use this to ' +
        'undo an enqueued prompt before it runs.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id'),
        item_id: z.string().min(1).describe('The queued item id (from cockpit_get_session → queue[].id)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, item_id }): Promise<ToolResult> => {
      try {
        const res = await intent<{ ok: boolean }>('queue/remove', { sessionId: session_id, itemId: item_id });
        return res.ok
          ? ok(`Removed queued item ${item_id} from ${session_id}.`, { ok: true })
          : fail(`No queued item ${item_id} on ${session_id} (already sent or removed?).`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
