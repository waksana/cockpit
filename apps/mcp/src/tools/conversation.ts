// Conversation tools: drive a session's turn — send a prompt, cancel the running
// turn, and remove a queued message. These are how an agent (or a multiagent
// orchestrator) actually talks to another cockpit session.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Intents, MessagePart, type Attachment } from '@cockpit/protocol';
import { CockpitError, protocolIntent as intent } from '../cockpit.js';
import { validateUploadUrl } from '../file-client.js';
import { ok, fail, type ToolResult } from '../shared.js';

const AttachmentInput = z.object({
  kind: z.enum(['image', 'file']),
  name: z.string(),
  url: z.string().describe('Backend-relative /uploads/<safe-basename> from cockpit_upload_file'),
  size: z.number().optional(),
  mime: z.string().optional(),
}) satisfies z.ZodType<Attachment>;

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
        'multiagent worker. Find the session id with cockpit_list_sessions. Optional attachment is JSON ' +
        'from cockpit_upload_file (kind/name/url/size/mime); no text marker is needed. Only safe backend ' +
        '/uploads/<basename> URLs are accepted. Use exactly one of attachment, attachments (1–20 files before text), ' +
        'or parts (1–100 ordered text/file parts, at most 20 files; text must be ""). Retain a native tool image first ' +
        'using files/from-tool-image via cockpit_call_intent. The server resolves authoritative metadata and supplies native file paths; ' +
        'the agent must explicitly read/view them, not assume attachment contents were automatically read. ' +
        'transport support does not imply the selected model can interpret every media format.',
      inputSchema: {
        session_id: z.string().min(1).describe('The target session id'),
        text: z.string().describe('The message text to send; may be empty when an attachment is supplied'),
        attachment: AttachmentInput.optional(),
        attachments: z.array(AttachmentInput).min(1).max(20).optional(),
        parts: z.array(MessagePart).min(1).max(100).optional(),
        mode: z
          .enum(['enqueue', 'immediate'])
          .default('enqueue')
          .describe('enqueue = wait behind a running turn (default, safe); immediate = start a fresh turn now'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id, text, mode, attachment, attachments, parts }): Promise<ToolResult> => {
      try {
        const body = Intents.prompt.body.parse({
          sessionId: session_id, text, mode, ...(attachment ? { attachment } : {}),
          ...(attachments !== undefined ? { attachments } : {}),
          ...(parts !== undefined ? { parts } : {}),
        });
        const files = attachment ? [attachment] : attachments ?? parts?.flatMap(part => part.type === 'file' ? [part.attachment] : []) ?? [];
        if (!text.trim() && !files.length && !parts?.some(part => part.type === 'text' && part.text.trim())) {
          return fail('Supply message text or an attachment.');
        }
        for (const file of files) validateUploadUrl(file.url);
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
