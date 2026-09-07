// Shared types + helpers for the cockpit MCP tool groups. The tools are split by
// concern into ./tools/*.ts; each exports a register<Group>Tools(server) function
// that index.ts calls. This module holds what they all need so nothing is
// duplicated across groups.
import { z } from 'zod';

export const ResponseFormat = z.enum(['markdown', 'json']).default('markdown');

export interface TrashEntry {
  sessionId: string;
  title: string;
  cwd: string;
  at: string;
  reason?: string;
}

export interface SessionBrief {
  sessionId: string;
  title: string;
  cwd: string;
  status: string;
  launchState?: 'launching' | 'launch_failed' | null;
  loaded: boolean;
  lastActivity: number;
  currentModelId?: string;
}

// The full SessionMeta the SSE snapshot projects (and session/get returns). Only
// the fields the MCP surfaces are typed; the rest pass through structurally.
export interface SessionMetaFull {
  sessionId: string;
  title: string;
  cwd: string;
  status: string;
  loaded: boolean;
  lastActivity: number;
  createdAt?: number;
  error?: string | null;
  launchState?: 'launching' | 'launch_failed' | null;
  currentModelId?: string;
  currentReasoningEffort?: string;
  currentContextTier?: string;
  currentMode?: string;
  availableModels?: { id: string; name?: string }[];
  pinned?: boolean;
  scheduleCount?: number;
  queue?: { id: string; text: string }[];
  ask?: { requestId: string; question: string; choices?: string[]; allowFreeform?: boolean } | null;
  planRequest?: { requestId: string; summary: string } | null;
  elicitation?: { requestId: string; message: string } | null;
  todo?: { total: number; done: number; inProgress: number; currentTitle?: string } | null;
  attention?: unknown;
}

export const McpServerStatus = z.enum([
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled',
  'not_configured',
  'unloaded',
]);
export type McpServerStatus = z.infer<typeof McpServerStatus>;

export const McpToggleOperation = z.object({
  id: z.string(),
  desiredEnabled: z.boolean(),
  state: z.enum(['running', 'cancelling', 'settling', 'succeeded', 'failed']),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  status: McpServerStatus,
  error: z.string().optional(),
});
export type McpToggleOperation = z.infer<typeof McpToggleOperation>;

export const McpServerSession = z.object({
  name: z.string(),
  detail: z.string(),
  status: McpServerStatus,
  enabled: z.boolean(),
  error: z.string().optional(),
  operation: McpToggleOperation.optional(),
});
export type McpServerSession = z.infer<typeof McpServerSession>;

export const McpSessionResult = z.object({
  loaded: z.boolean(),
  servers: z.array(McpServerSession),
});
export type McpSessionResult = z.infer<typeof McpSessionResult>;

export const McpToggleResult = z.object({
  ok: z.boolean(),
  applied: z.boolean(),
  sessionId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  status: McpServerStatus,
  error: z.string().optional(),
  operation: McpToggleOperation,
});
export type McpToggleResult = z.infer<typeof McpToggleResult>;

export interface McpServerGlobal {
  name: string;
  detail?: string;
  defaultOn?: boolean;
}

export interface SkillSession {
  name: string;
  description?: string;
  source?: string;
  enabled: boolean;
}

export interface SkillGlobal {
  name: string;
  description?: string;
  source?: string;
}

export interface PanelItem {
  label: string;
  detail?: string;
  status?: string;
}

export interface ScheduleEntry {
  id: number;
  prompt: string;
  recurring: boolean;
  nextRunAt: number;
  intervalMs?: number;
  cron?: string;
  tz?: string;
  at?: number;
  displayPrompt?: string;
}

export interface HookEntry {
  id: string;
  ownerSession: string;
  event: string;
  filter?: { cwdPrefix?: string; sessionId?: string; excludeSelf?: boolean };
  flowId?: string;
  promptTemplate?: string;
  once?: boolean;
  createdAt: number;
}

export interface Flow {
  id: string;
  name?: string;
  gate?: { script: string; timeoutMs?: number };
  action:
    | { kind: 'spawn-session'; template: { cwd: string; prompt: string; skills?: string[]; mcps?: string[]; model?: string; mode?: string } }
    | { kind: 'prompt-existing'; sessionId: string; prompt: string };
}

export interface FlowScheduleEntry {
  id: number;
  flowId?: string;
  target?: { kind: 'prompt-existing'; sessionId: string; prompt: string; displayPrompt?: string };
  recurring: boolean;
  nextRunAt: number;
  intervalMs?: number;
  cron?: string;
  tz?: string;
  at?: number;
  label?: string;
}

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// A ToolResult historically carried BOTH a `content` text copy AND a
// `structuredContent` copy. The CLI host materializes/serializes BOTH and emits
// them back-to-back, so every machine (`response_format:"json"`) caller received
// the SAME payload twice — a pretty block followed by a compact block — and had to
// brace-balance / take-last-line to recover one clean JSON. None of these tools
// declare an `outputSchema`, so `structuredContent` has no contractual consumer;
// the `text` is always the complete, self-describing representation (JSON in json
// mode, human markdown in markdown mode) and is therefore the single source of
// truth. We no longer attach `structuredContent`. The second parameter is kept so
// the ~40 call sites stay unchanged.
export function ok(text: string, _structured?: Record<string, unknown>): ToolResult {
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
// `{ [listKey]: items, count }`. Most list tools (skills/mcp/hooks/flows) call
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
