import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NativeChatPage } from '@cockpit/protocol';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CHARACTER_LIMIT } from '../config.js';
import { protocolIntent as intent } from '../cockpit.js';
import { ResponseFormat, fail, ok, type ToolResult } from '../shared.js';

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
      + 'Internal tool-image bytes are omitted and never collected. To show an image, upload an existing local artifact '
      + 'or reuse a managed file, then include its /uploads markdown; native image lookup is retired. '
      + 'For an oversized page, repeat the identical native query with nextPageOffset/pageVersion to obtain JSON fragments; '
      + 'this rereads the bounded native page, does not cache it, and fails explicitly if it changed.',
    inputSchema: {
      session_id: z.string().min(1),
      source: z.enum(['persisted', 'live']).default('persisted'),
      direction: z.enum(['forward', 'backward']).default('backward'),
      cursor: z.string().min(1).max(16384).optional(),
      limit: z.number().int().min(1).max(256).default(64),
      agent_scope: z.enum(['primary', 'all']).optional(),
      agent_ids: z.array(z.string().min(1)).min(1).max(20).optional(),
      types: z.array(z.string().min(1)).min(1).max(64).optional(),
      include_ephemeral: z.boolean().default(false),
      wait_ms: z.number().int().min(0).max(1000).default(0),
      bootstrap: z.boolean().default(false),
      page_offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      page_version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      operation: z.string().optional().describe('Retired: use source/direction/native cursor.'),
      tool_call_id: z.string().optional().describe('Retired: use agent_ids with source:"live".'),
      details: z.string().optional().describe('Retired: output contains native events.'),
      before_message_id: z.string().optional().describe('Retired: message IDs are not native cursors.'),
      after_message_id: z.string().optional().describe('Retired: message IDs are not native cursors.'),
      response_format: ResponseFormat,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input): Promise<ToolResult> => {
    try {
      if ([input.operation, input.tool_call_id, input.details, input.before_message_id, input.after_message_id].some(value => value !== undefined)) {
        return fail('CHAT_PROTOCOL_CHANGED: use source, direction, cursor, and optional live agent_ids. Message-ID seek and server-folded transcripts have retired; no implicit scan is performed.');
      }
      if (input.page_offset > 0 && !input.page_version) return fail('page_version is required for fragment continuation.');
      const result = NativeChatPage.parse(await intent('session/chat', {
        sessionId: input.session_id, source: input.source, direction: input.direction, cursor: input.cursor,
        max: input.limit, agentScope: input.agent_scope, agentIds: input.agent_ids, types: input.types,
        includeEphemeral: input.include_ephemeral, waitMs: input.wait_ms, bootstrap: input.bootstrap,
      }));
      if (result.sessionId !== input.session_id || result.source !== input.source || result.direction !== input.direction) {
        return fail('Backend returned a different native event page.');
      }
      const json = JSON.stringify(result, null, 2);
      const pageVersion = createHash('sha256').update(json).digest('hex');
      if (input.page_version !== undefined && input.page_version !== pageVersion) {
        return fail('The native page changed; discard earlier fragments and restart at page_offset=0.');
      }
      if (input.page_offset > json.length) return fail('page_offset exceeds this page; restart at page_offset=0.');
      if (json.length > CHARACTER_LIMIT || input.page_offset > 0) {
        const end = Math.min(json.length, input.page_offset + 8000);
        return ok(JSON.stringify({
          format: 'json-fragment', pageVersion, pageOffset: input.page_offset,
          nextPageOffset: end < json.length ? end : null, pageCharacters: json.length,
          json: json.slice(input.page_offset, end),
        }));
      }
      return ok(input.response_format === 'json' ? json
        : `# ${input.session_id}\nNative event page (${result.source}, ${result.direction}):\n\n${json}`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });
}
