// Shared types + helpers for the cockpit MCP tool groups. The tools are split by
// concern into ./tools/*.ts; each exports a register<Group>Tools(server) function
// that index.ts calls. This module holds what they all need so nothing is
// duplicated across groups.
import { z } from 'zod';
import {
  Intents,
  type IntentResult,
  McpServerSession as ProtocolMcpServerSession,
  McpServerStatus as ProtocolMcpServerStatus,
  McpToggleOperation as ProtocolMcpToggleOperation,
  McpToggleResult as ProtocolMcpToggleResult,
} from '@cockpit/protocol';

export type {
  NativeAttachment, DirListing, McpServerGlobal, PanelItem, ScheduleEntry, SessionBrief, SessionMeta,
  SessionPanels, SessionPlan, SkillGlobal, SkillSession, Snapshot, TodoProgress,
} from '@cockpit/protocol';
export type McpSessionResult = IntentResult<'mcp/session'>;
export type McpServerSession = ProtocolMcpServerSession;
export type McpServerStatus = ProtocolMcpServerStatus;
export type McpToggleOperation = ProtocolMcpToggleOperation;
export type McpToggleResult = ProtocolMcpToggleResult;

export const ResponseFormat = z.enum(['markdown', 'json']).default('markdown');

// Preserve forward-compatible fields at each existing MCP envelope boundary.
export const McpServerStatus = ProtocolMcpServerStatus;
export const McpToggleOperation = ProtocolMcpToggleOperation.passthrough();
export const McpServerSession = ProtocolMcpServerSession.extend({
  operation: McpToggleOperation.optional(),
}).passthrough();

export const McpSessionResult = Intents['mcp/session'].result.extend({
  servers: z.array(McpServerSession),
}).passthrough();

export const McpToggleResult = ProtocolMcpToggleResult.extend({
  operation: McpToggleOperation,
}).passthrough();

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

// These tools return one text representation; structuredContent duplicated it
// in the CLI host, and no tool declares an outputSchema requiring that copy.
export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

import { CHARACTER_LIMIT } from './config.js';

// Render a value, capping length so a huge transcript can't overflow the agent
// context. For HUMAN/markdown text only — a raw slice is fine there.
export function capped(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n…[truncated ${text.length - CHARACTER_LIMIT} chars — narrow the query or read the underlying source]`
  );
}

// Serialize `value` as pretty JSON that is guaranteed (a) valid and (b) within the
// character budget. NEVER raw-slice JSON.stringify output: a slice cuts a string
// mid-escape and any appended suffix lands inside the now-unterminated string,
// yielding "Bad control character in string literal" / "Expecting ',' delimiter"
// — exactly the cockpit_read_session machine-read bug. Instead: if it fits, return
// it verbatim; otherwise an optional `shrink(attempt)` may return a smaller value
// to re-try (e.g. fewer array items) until it fits; if it still doesn't (or no
// shrink was given), return a valid overflow ENVELOPE so json.loads() always
// succeeds and the caller knows to paginate.
export function cappedJson(value: unknown, shrink?: (attempt: number) => unknown | null): string {
  const s = JSON.stringify(value, null, 2);
  if (s.length <= CHARACTER_LIMIT) return s;
  if (shrink) {
    for (let attempt = 1; ; attempt++) {
      const smaller = shrink(attempt);
      if (smaller == null) break;
      const ss = JSON.stringify(smaller, null, 2);
      if (ss.length <= CHARACTER_LIMIT) return ss;
    }
  }
  return JSON.stringify(
    {
      _truncated: true,
      _limit: CHARACTER_LIMIT,
      _fullLength: s.length,
      _note: 'Output exceeded the machine-read budget. Retrieve with response_format=markdown, or narrow the query / read the underlying source.',
    },
    null,
    2,
  );
}

// Build the `shrink(attempt)` callback cappedJson wants for a LIST payload of shape
// `{ [listKey]: items, count }`. Most list tools (skills/mcp) call
// `cappedJson(structured)` bare, so an over-budget json read fell to the useless
// overflow stub. Passing `shrinkList(...)` instead lets cappedJson retry with a
// progressively compacted — but always VALID and in-budget — projection:
//   attempt 1   keep the identifier `keep` fields + a ≤previewLen preview of each
//               verbose `clip` field
//   attempt 2   drop the verbose `clip` fields entirely (identifiers only)
//   attempt 3+  identifiers only AND shed items (thin the array) so even an
//               enormous list fits, returning null once nothing more can be shed
//               so cappedJson terminates (and only then falls to the stub)
// The projection carries a `_compacted` marker (and `_returned` when items were
// shed) so the consumer knows detail was elided and can re-query in markdown.
// Nested-payload tools (flows/flow-schedules) flatten each item to a shape with a
// top-level clip field before calling this.
export function shrinkList<T>(
  items: readonly T[],
  listKey: string,
  opts: { keep: (keyof T)[]; clip: (keyof T)[]; previewLen?: number },
): (attempt: number) => Record<string, unknown> | null {
  const previewLen = opts.previewLen ?? 120;
  const total = items.length;
  const project = (item: T, mode: 'preview' | 'drop'): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of opts.keep) {
      if (item[k] !== undefined) out[k as string] = item[k];
    }
    if (mode === 'preview') {
      for (const k of opts.clip) {
        const v = item[k];
        if (typeof v === 'string') {
          out[k as string] = v.length > previewLen ? `${v.slice(0, previewLen)}…` : v;
        } else if (v !== undefined) {
          out[k as string] = v;
        }
      }
    }
    return out;
  };
  return (attempt: number): Record<string, unknown> | null => {
    const mode: 'preview' | 'drop' = attempt === 1 ? 'preview' : 'drop';
    let kept = total;
    if (attempt >= 3) {
      kept = Math.floor(total / (attempt - 1));
      if (kept < 1) return null;
    }
    const projected = items.slice(0, kept).map((it) => project(it, mode));
    const envelope: Record<string, unknown> = {
      [listKey]: projected,
      count: total,
      _compacted: mode === 'preview' ? 'field-previews' : 'identifiers-only',
    };
    if (kept < total) envelope._returned = kept;
    return envelope;
  };
}
