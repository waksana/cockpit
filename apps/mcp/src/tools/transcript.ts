import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HistoryPage, IntentResult, SubagentHistoryPage } from '@cockpit/protocol';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CHARACTER_LIMIT } from '../config.js';
import { protocolIntent as intent } from '../cockpit.js';
import { ResponseFormat, fail, ok, type ToolResult } from '../shared.js';

// Validate the envelope and pagination keys only. Preserve every canonical message
// field (including attachments, tools and nested subMessages) without another fold.
const Messages = z.array(z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.number(),
}).passthrough());
const History = z.object({
  sessionId: z.string(),
  messages: Messages,
  hasMore: z.boolean(),
  latest: z.boolean().optional(),
  append: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<HistoryPage>;
const Preview = History.extend({
  title: z.string(),
  cwd: z.string(),
}).passthrough() satisfies z.ZodType<IntentResult<'session/peek'>>;
const SubagentHistory = History.extend({
  toolCallId: z.string(),
  subagent: z.object({
    name: z.string(), displayName: z.string(), status: z.enum(['running', 'completed', 'failed']),
  }).passthrough(),
}).passthrough() satisfies z.ZodType<SubagentHistoryPage>;

export function registerTranscriptTools(server: McpServer): void {
  server.registerTool('cockpit_read_session', {
    title: 'Read a canonical session transcript',
    description: 'Read session/peek over HTTP for live or unloaded sessions, without loading a runtime or local state. '
      + 'Returns canonical folded messages, oldest-first within the newest page, including tools, images and subagents. '
      + 'Use nextBeforeMsgId as before_message_id to read older pages. operation:"history" instead reads '
      + 'session/history passively for a live session without loading it, returning HistoryPage including latest/append when present. '
      + 'details:"summary" omits nested transcripts and spawn prompts; full is the default for root reads. '
      + 'Use operation:"subagent" with tool_call_id from a summary card to read its paginated transcript without loading it; '
      + 'nested cards are summaries by default in that operation. History and subagent accept after_message_id; '
      + 'before/after are mutually exclusive. '
      + 'No session/history-page SSE event or local DB/event-log fallback is needed. '
      + 'Oversized pages return lossless JSON fragments; repeat identical page parameters with nextPageOffset '
      + 'as page_offset and pageVersion as page_version, concatenate json fragments, then JSON.parse. '
      + 'Continuation fails if the canonical page changed; discard fragments and restart from offset zero.',
    inputSchema: {
      session_id: z.string().min(1),
      operation: z.enum(['peek', 'history', 'subagent']).default('peek'),
      tool_call_id: z.string().min(1).optional(),
      details: z.enum(['full', 'summary']).optional(),
      before_message_id: z.string().min(1).optional(),
      after_message_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).default(40),
      page_offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)
        .describe('Character offset for oversized serialized pages, not a turn offset.'),
      page_version: z.string().regex(/^[a-f0-9]{64}$/).optional()
        .describe('pageVersion from the first fragment; required when page_offset is greater than zero.'),
      response_format: ResponseFormat,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ session_id, operation, tool_call_id, details, before_message_id, after_message_id, limit, page_offset, page_version, response_format }): Promise<ToolResult> => {
    try {
      if (before_message_id !== undefined && after_message_id !== undefined) {
        return fail('before_message_id and after_message_id are mutually exclusive.');
      }
      if (after_message_id !== undefined && operation === 'peek') {
        return fail('after_message_id requires operation:"history" or "subagent"; peek only supports older pages.');
      }
      if ((operation === 'subagent') !== (tool_call_id !== undefined)) {
        return fail('tool_call_id is required only for operation:"subagent".');
      }
      if (page_offset > 0 && !page_version) {
        return fail('page_version is required for continuation; restart at page_offset=0.');
      }
      const body = {
        sessionId: session_id,
        ...(before_message_id === undefined ? {} : { beforeMsgId: before_message_id }),
        ...(details === undefined ? {} : { details }),
        limit,
      };
      const preview: HistoryPage | IntentResult<'session/peek'> | SubagentHistoryPage = operation === 'subagent'
        ? SubagentHistory.parse(await intent('session/subagent-history', {
          ...body, toolCallId: tool_call_id!,
          ...(after_message_id === undefined ? {} : { afterMsgId: after_message_id }),
        }))
        : operation === 'peek'
        ? Preview.parse(await intent('session/peek', body))
        : History.parse(await intent('session/history', {
          ...body, ...(after_message_id === undefined ? {} : { afterMsgId: after_message_id }),
        }));
      if (preview.sessionId !== session_id) return fail('Backend returned a different session transcript.');
      if (operation === 'subagent' && (!('toolCallId' in preview) || preview.toolCallId !== tool_call_id)) {
        return fail('Backend returned a different subagent transcript.');
      }
      const result = {
        ...preview,
        source: 'api' as const,
        returned: preview.messages.length,
        nextBeforeMsgId: after_message_id === undefined && preview.hasMore ? preview.messages[0]?.id ?? null : null,
        ...(operation !== 'peek' ? { nextAfterMsgId: preview.messages.at(-1)?.id ?? after_message_id ?? null } : {}),
      };
      const json = JSON.stringify(result, null, 2);
      const pageVersion = createHash('sha256').update(json).digest('hex');
      if (page_version !== undefined && page_version !== pageVersion) {
        return fail('The canonical page changed; discard earlier fragments and restart at page_offset=0.');
      }
      if (page_offset > json.length) return fail('page_offset exceeds this page; restart at page_offset=0.');
      if (json.length > CHARACTER_LIMIT || page_offset > 0) {
        // A serialized JSON fragment escapes at most twice again. 8K leaves room
        // for the envelope within the 25K response budget, even for large tool data.
        const end = Math.min(json.length, page_offset + 8000);
        return ok(JSON.stringify({
          format: 'json-fragment',
          pageVersion,
          pageOffset: page_offset,
          nextPageOffset: end < json.length ? end : null,
          pageCharacters: json.length,
          json: json.slice(page_offset, end),
        }));
      }
      if (response_format === 'json') return ok(json);
      const title = 'title' in preview ? preview.title : session_id;
      return ok(`# ${title}\nCanonical session/${operation} page (JSON; preserves all message fields):\n\n${json}`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });
}
