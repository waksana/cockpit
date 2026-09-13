// Conversation tools: drive a session's turn — send a prompt, cancel the running
// turn, and remove a queued message. These are how an agent (or a multiagent
// orchestrator) actually talks to another cockpit session.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Intents, NativeAttachment } from '@cockpit/protocol';
import { CockpitError, protocolIntent as intent } from '../cockpit.js';
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
        'multiagent worker. Find the session id with cockpit_list_sessions. Optional attachments use the SDK-native ' +
        'file/directory/selection/blob schema. Paths belong to the native runtime filesystem, not this client. ' +
        'No upload, file-library association or module reference resolution is performed. Retired attachment/parts ' +
        'and managed URL formats are rejected. Acceptance does not prove the model read the attachments; format support is model-specific.',
      inputSchema: z.object({
        session_id: z.string().min(1).describe('The target session id'),
        text: z.string().describe('The message text to send; may be empty when an attachment is supplied'),
        attachments: z.array(NativeAttachment).max(20).optional(),
        mode: z
          .enum(['enqueue', 'immediate'])
          .default('enqueue')
          .describe('enqueue = wait behind a running turn (default, safe); immediate = start a fresh turn now'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, text, mode, attachments }): Promise<ToolResult> => {
      try {
        const body = Intents.prompt.body.parse({
          sessionId: session_id, text, mode,
          ...(attachments !== undefined ? { attachments } : {}),
        });
        if (!text.trim() && !attachments?.length) {
          return fail('Supply message text or an attachment.');
        }
        const res = await intent('prompt', body);
        return ok(
          `Sent to ${session_id} (${mode}${res.queued ? ', queued' : ''}). The turn runs asynchronously — ` +
            `read it back with cockpit_read_session.`
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
        'Stop current work and discard pending queued messages (the same as the Stop button). ' +
        'Success acknowledges cancellation, not immediate idle; native work may still be settling. ' +
        'Read cockpit_get_session for current activity. Queue-clear and abort failures are returned; ' +
        'discarded messages are not automatically replayed.',
      inputSchema: { session_id: z.string().min(1).describe('The session id whose turn to cancel') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }): Promise<ToolResult> => {
      try {
        await intent('cancel', { sessionId: session_id });
        return ok(`Cancel signalled on ${session_id}.`);
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
        const res = await intent('queue/remove', { sessionId: session_id, itemId: item_id });
        return res.ok
          ? ok(`Removed queued item ${item_id} from ${session_id}.`)
          : fail(`No queued item ${item_id} on ${session_id} (already sent or removed?).`);
      } catch (e) {
        return fail(e instanceof CockpitError ? e.message : String(e));
      }
    },
  );
}
