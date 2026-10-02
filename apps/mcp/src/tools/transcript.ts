import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ChatTextPage, ChatTextRead, NativeChatPage, NativeChatRead } from '@cockpit/protocol';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CHARACTER_LIMIT } from '../config.js';
import { protocolIntent as intent } from '../cockpit.js';
import { ResponseFormat, fail, ok, type ToolResult } from '../shared.js';

const FRAGMENT_CHARACTERS = 8000;

export function registerTranscriptTools(server: McpServer): void {
  server.registerTool('cockpit_read_session', {
    title: 'Read a native session event page',
    description: 'Read one native session/chat event page, not server-assembled messages. '
      + 'source:"persisted" works passively for loaded and unloaded sessions; it has no native type/agent filters. '
      + 'source:"live" requires an already loaded session and supports types, agent_scope and agent_ids. '
      + 'Default backward reads fetch the newest events in append order; pass returned cursor unchanged with the same '
      + 'source, direction and filters for the next page. UUIDs are identities, not ordering or seek keys. '
      + 'bootstrap:true on a fresh live backward read also returns a separate liveCursor for forward continuation. '
      + 'Expired cursors require explicit resynchronization. No whole-history scan, local database, or cache fallback. '
      + 'Internal tool-image bytes are omitted and never collected. File-library and media-preview enhancements '
      + 'are not provided by this native history reader. '
      + 'Default limit is 16 events, not a byte bound. Oversized pages require an explicitly smaller limit with the '
      + 'original input cursor; no automatic retry or bisection. Only limit:1 can use bounded JSON fragments for a giant event. '
      + 'Repeat that identical query with page_offset:nextPageOffset and page_version:pageVersion; each fragment rereads '
      + 'the whole event (and live bootstrap tail), then slices in memory. No native body offset, cache, or saved copy. '
      + 'The version binds the query and complete page; changed or expired continuations fail rather than mix pages.',
    inputSchema: z.object({
      session_id: z.string().min(1),
      source: z.enum(['persisted', 'live']).default('persisted'),
      direction: z.enum(['forward', 'backward']).default('backward'),
      cursor: z.string().min(1).max(16384).optional(),
      limit: z.number().int().min(1).max(256).default(16)
        .describe('Native event count, not characters. Narrow oversized pages explicitly; limit:1 permits giant-event fragments.'),
      agent_scope: z.enum(['primary', 'all']).optional(),
      agent_ids: z.array(z.string().min(1)).min(1).max(20).optional(),
      types: z.array(z.string().min(1)).min(1).max(64).optional(),
      include_ephemeral: z.boolean().default(false),
      wait_ms: z.number().int().min(0).max(1000).default(0),
      bootstrap: z.boolean().default(false),
      page_offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)
        .describe('Local JSON string offset, not an SDK offset. Continuation requires limit:1 and page_version; rereads the full event.'),
      page_version: z.string().regex(/^[a-f0-9]{64}$/).optional()
        .describe('Returned query-and-page hash; repeat the same native query to prevent mixed fragments.'),
      response_format: ResponseFormat,
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input): Promise<ToolResult> => {
    try {
      if (input.page_offset > 0 && !input.page_version) return fail('page_version is required for fragment continuation.');
      if ((input.page_offset > 0 || input.page_version !== undefined) && input.limit !== 1) {
        return fail('Fragment continuation requires limit:1. Discard earlier fragments and restart the original query with a smaller native page; no read was performed.');
      }
      const query = NativeChatRead.parse({
        sessionId: input.session_id, source: input.source, direction: input.direction, cursor: input.cursor,
        max: input.limit, agentScope: input.agent_scope, agentIds: input.agent_ids, types: input.types,
        includeEphemeral: input.include_ephemeral, waitMs: input.wait_ms, bootstrap: input.bootstrap,
      });
      const result = NativeChatPage.parse(await intent('session/chat', query));
      if (result.sessionId !== input.session_id || result.source !== input.source || result.direction !== input.direction) {
        return fail('Backend returned a different native event page.');
      }
      if (result.events.length > input.limit) return fail('Backend exceeded the requested native event count.');
      const json = JSON.stringify(result, null, 2);
      const oversized = json.length > CHARACTER_LIMIT;
      if (result.cursorStatus === 'expired' && (oversized || input.page_version !== undefined || input.page_offset > 0)) {
        return fail('NATIVE_CURSOR_EXPIRED: cursorStatus=expired; discard earlier fragments and explicitly resynchronize. No fallback read was performed.');
      }
      if (oversized && input.limit !== 1) {
        return fail(`NATIVE_PAGE_TOO_LARGE: ${result.events.length} events, ${json.length} JSON characters exceed ${CHARACTER_LIMIT}. `
          + `Retry explicitly with a smaller limit (suggested: ${Math.max(1, Math.floor(input.limit / 2))}; limit:1 for a giant event), `
          + 'the original input cursor, and the same source/direction/filters/bootstrap. '
          + 'No fragments or next-page cursor were delivered, and no automatic reread was performed.');
      }
      if (input.page_offset > 0 && input.page_offset >= json.length) {
        return fail('page_offset is outside this page; discard earlier fragments and restart at page_offset=0.');
      }
      if (oversized || input.page_version !== undefined || input.page_offset > 0) {
        const pageVersion = createHash('sha256').update(JSON.stringify(query)).update('\0').update(json).digest('hex');
        if (input.page_version !== undefined && input.page_version !== pageVersion) {
          return fail('The native page changed or the query differs; discard earlier fragments and restart at page_offset=0.');
        }
        const end = Math.min(json.length, input.page_offset + FRAGMENT_CHARACTERS);
        return ok(JSON.stringify({
          format: 'json-fragment', pageVersion, pageOffset: input.page_offset,
          nextPageOffset: end < json.length ? end : null, pageCharacters: json.length,
          read: result.read, json: json.slice(input.page_offset, end),
        }));
      }
      return ok(input.response_format === 'json' ? json
        : `# ${input.session_id}\nNative event page (${result.source}, ${result.direction}):\n\n${json}`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });
  server.registerTool('cockpit_read_session_text', {
    title: 'Read bounded native session text',
    description: 'Read primary user/assistant nonempty text only, without summaries, reasoning, tool payloads, '
      + 'child agents or attachment bytes. Persisted works passively on loaded/unloaded sessions; live requires loaded. '
      + 'Backward defaults to newest-first; forward is oldest-first. Each native page has at most 16 events; '
      + 'scan_pages bounds native reads, not hidden SDK work/bytes. read reports pages/events/RPCs, including replay. '
      + 'Empty messages with hasMore/scanLimited can continue. max_bytes bounds the returned compact JSON UTF-8 text. '
      + 'Pass cursor unchanged with the same session/source/direction; limits may change. Long messages return '
      + 'eventId/messageId and UTF-16 offset/nextOffset fragments; cursor continues the remainder without losing '
      + 'later messages. Partial pages are reread and version-checked, not cached. Changed/expired cursors fail '
      + 'explicitly. Positions are caller-owned and survive host restart, not authorization credentials. '
      + 'Recover an expired/changed incremental cursor by explicitly repeating the original since without cursor '
      + 'and reconciling duplicate/overlapping eventId/offset fragments; never reset to recent-only history. '
      + 'bootstrap on a fresh live backward read returns liveCursor '
      + 'for forward increments; deduplicate overlap by eventId/offset. '
      + 'checkpoint is a safely completed backward boundary: pass it as since for a NEW backward incremental range '
      + 'on the SAME source. Keep since unchanged while paging that range with cursor; only a returned checkpoint '
      + 'after complete delivery advances your processed boundary. since reads may yield newest-first text, not forward '
      + 'events. They work unloaded with persisted, without native cursor conversion or a history index. '
      + 'Attachments are bounded descriptors, not '
      + 'downloads; omittedFields/omittedAttachments are explicit. Use cockpit_get_session for current asks/activity. '
      + 'Use cockpit_read_session for raw native events. Idle/unloaded does not establish task completion.',
    inputSchema: z.object({
      session_id: z.string().min(1),
      source: z.enum(['persisted', 'live']).default('persisted'),
      direction: z.enum(['forward', 'backward']).default('backward'),
      cursor: z.string().min(1).max(32768).optional(),
      since: z.string().min(1).max(4096).optional()
        .describe('Returned checkpoint for a new backward incremental range; keep the same since while paging with cursor.'),
      limit: z.number().int().min(1).max(64).default(16),
      max_bytes: z.number().int().min(8192).max(65536).default(16384),
      scan_pages: z.number().int().min(1).max(16).default(4),
      bootstrap: z.boolean().default(false),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input): Promise<ToolResult> => {
    try {
      const query = ChatTextRead.parse({
        sessionId: input.session_id, source: input.source, direction: input.direction, cursor: input.cursor,
        since: input.since,
        max: input.limit, maxBytes: input.max_bytes, scanPages: input.scan_pages, bootstrap: input.bootstrap,
      });
      const result = ChatTextPage.parse(await intent('session/chat/text', query));
      const json = JSON.stringify(result);
      if (result.sessionId !== query.sessionId || result.source !== query.source || result.direction !== query.direction
        || result.messages.length > query.max || Buffer.byteLength(json, 'utf8') > query.maxBytes) {
        return fail('Backend returned a mismatched or over-budget text page.');
      }
      return ok(json);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });
}
