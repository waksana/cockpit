import { DatabaseSync } from 'node:sqlite';
import { existsSync, createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { SESSION_STORE, SESSION_STATE_DIR } from './config.js';

// Read-only views of the Copilot SDK's session-store.db. cockpit has no synchronous
// HTTP path for transcript content, so list_sessions / read_session read the store
// directly (read-only, never mutating — all destructive ops go through cockpit intents).

export interface SessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface TurnRow {
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string | null;
}

export const ASSISTANT_VIEW_VALUES = ['default', 'authoritative_text'] as const;
export type AssistantView = (typeof ASSISTANT_VIEW_VALUES)[number];

interface AssistantPart {
  source: 'assistant_content' | 'tool_summary' | 'task_complete';
  text: string;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

function open(): DatabaseSync {
  if (!existsSync(SESSION_STORE)) {
    throw new StoreError(
      `session store not found at ${SESSION_STORE}. Set COCKPIT_SESSION_STORE to the correct path.`,
    );
  }
  try {
    return new DatabaseSync(SESSION_STORE, { readOnly: true });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new StoreError(`cannot open session store ${SESSION_STORE} (${reason}).`);
  }
}

export function listSessionRows(limit: number, offset: number): SessionRow[] {
  const db = open();
  try {
    return db
      .prepare(
        `SELECT id, cwd, repository, branch, summary, created_at, updated_at
           FROM sessions
          ORDER BY COALESCE(updated_at, created_at) DESC
          LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as SessionRow[];
  } finally {
    db.close();
  }
}

export function countSessions(): number {
  const db = open();
  try {
    const row = db.prepare(`SELECT count(*) AS c FROM sessions`).get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

export function getSessionRow(id: string): SessionRow | undefined {
  const db = open();
  try {
    return db
      .prepare(
        `SELECT id, cwd, repository, branch, summary, created_at, updated_at
           FROM sessions WHERE id = ?`,
      )
      .get(id) as SessionRow | undefined;
  } finally {
    db.close();
  }
}

export function countTurns(id: string): number {
  const db = open();
  try {
    const row = db.prepare(`SELECT count(*) AS c FROM turns WHERE session_id = ?`).get(id) as {
      c: number;
    };
    return row.c;
  } finally {
    db.close();
  }
}

export function readTurns(id: string, limit: number, offset: number): TurnRow[] {
  const db = open();
  try {
    return db
      .prepare(
        `SELECT turn_index, user_message, assistant_response, timestamp
           FROM turns WHERE session_id = ?
          ORDER BY turn_index ASC
          LIMIT ? OFFSET ?`,
      )
      .all(id, limit, offset) as unknown as TurnRow[];
  } finally {
    db.close();
  }
}

// ── Authoritative transcript from the event log ─────────────────────────────────
// The `turns` table above is the SDK's coarse, lossy summary (its
// `assistant_response` is NULL for many turns — observed 6/20 in one session,
// including turns from hours before any restart). The append-per-event
// `events.jsonl` is the authoritative log (it's also what cockpit's UI folds), so
// read_session reconstructs turns from it: each `user.message` opens a turn; every
// following `assistant.message` until the next user message is that turn's reply.

// Strip a leading <cockpit-attachment .../> marker (upload machinery) so a salvage
// read shows the human text, not raw XML. Keeps any guidance/caption after it.
const ATTACHMENT_MARKER = /^\s*<cockpit-attachment\b[^>]*?\/?>(?:<\/cockpit-attachment>)?\s*/;
function stripMarker(text: string): string {
  return text.replace(ATTACHMENT_MARKER, '').trim();
}

// Remove injected <skill-context name="...">…</skill-context> blocks. The SDK
// injects each loaded skill's full SKILL.md (+ CONTRACT/rubric) as a synthetic
// user.message at turn start — for a worker with several heavy skills that is tens
// of KB of boilerplate per turn that buries the real user/assistant exchange in a
// salvage read (a reviewer reading a build worker saw ~96% skill-context noise).
// This drops the well-formed blocks (and a defensive dangling unclosed one at the
// end), then collapses the blank lines they leave behind. Pure + exported so the
// reviewer-facing `exclude_skill_context` option is directly testable.
const SKILL_CONTEXT_BLOCK = /<skill-context\b[^>]*>[\s\S]*?<\/skill-context>/g;
const SKILL_CONTEXT_DANGLING = /<skill-context\b[^>]*>[\s\S]*$/;
export function stripSkillContext(text: string): string {
  if (!text || text.indexOf('<skill-context') === -1) return text;
  return text
    .replace(SKILL_CONTEXT_BLOCK, '')
    .replace(SKILL_CONTEXT_DANGLING, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function eventLogPath(id: string): string {
  return join(SESSION_STATE_DIR, id, 'events.jsonl');
}

const FLOW_LAUNCH_MARKER = 'cockpit-launch.json';
function flowLaunchMarkerPath(id: string): string {
  return join(SESSION_STATE_DIR, id, FLOW_LAUNCH_MARKER);
}

export interface ZeroTurnDiagnostic {
  source: 'empty';
  zeroTurnReason: string;
  eventLogExists: boolean;
  sessionDbExists: boolean;
  launchState: 'launch_failed' | null;
  error: string | null;
}

function readFlowLaunchMarker(id: string): { state?: string; error?: string } | null {
  const path = flowLaunchMarkerPath(id);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { state?: unknown; error?: unknown } | null;
    return raw && typeof raw === 'object'
      ? {
          ...(typeof raw.state === 'string' ? { state: raw.state } : {}),
          ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

export function readZeroTurnDiagnostic(id: string): ZeroTurnDiagnostic {
  const eventLogExists = existsSync(eventLogPath(id));
  const sessionDbExists = existsSync(join(SESSION_STATE_DIR, id, 'session.db'));
  const marker = readFlowLaunchMarker(id);
  if (marker?.state === 'launch_failed') {
    return {
      source: 'empty',
      zeroTurnReason: 'launch_failed_before_first_turn',
      eventLogExists,
      sessionDbExists,
      launchState: 'launch_failed',
      error: marker.error ?? 'flow worker first turn failed before any turn was persisted',
    };
  }
  if (marker?.state === 'launching') {
    return {
      source: 'empty',
      zeroTurnReason: 'launch_interrupted_before_first_turn',
      eventLogExists,
      sessionDbExists,
      launchState: 'launch_failed',
      error: marker.error ?? 'flow worker launch was interrupted before any turn was persisted',
    };
  }
  return {
    source: 'empty',
    zeroTurnReason: eventLogExists ? 'event_log_has_no_turns' : 'no_event_log_and_no_turns',
    eventLogExists,
    sessionDbExists,
    launchState: null,
    error: null,
  };
}

export function hasEventLog(id: string): boolean {
  return existsSync(eventLogPath(id));
}

function renderAssistantParts(parts: AssistantPart[], assistantView: AssistantView): string | null {
  const visible = assistantView === 'default'
    ? parts
    : parts.filter((part) => part.source !== 'tool_summary');
  return visible.length ? visible.map((part) => part.text).join('\n\n') : null;
}

function summarizeToolRequests(toolRequests: unknown): string {
  if (!Array.isArray(toolRequests)) return '';
  return toolRequests
    .map((request) => {
      if (!request || typeof request !== 'object') return '';
      const r = request as Record<string, unknown>;
      const label = [r.intentionSummary, r.description, r.toolTitle, r.name]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      return label ? `【tool】 ${label.trim()}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function isChildScopedEvent(ev: { agentId?: unknown }): boolean {
  return typeof ev.agentId === 'string' && ev.agentId.trim().length > 0;
}

// Fold the full event log into user→assistant turns. Streams the file (logs reach
// 100MB+), keeping only the text. Returns every turn in order; the caller paginates.
export async function readEventTurns(
  id: string,
  options: { assistantView?: AssistantView } = {},
): Promise<TurnRow[]> {
  const assistantView = options.assistantView ?? 'default';
  const path = eventLogPath(id);
  if (!existsSync(path)) return [];
  const turns: TurnRow[] = [];
  let cur: { turn_index: number; user: string; parts: AssistantPart[]; ts: string | null } | null = null;
  const flush = (): void => {
    if (!cur) return;
    turns.push({
      turn_index: cur.turn_index,
      user_message: cur.user || null,
      assistant_response: renderAssistantParts(cur.parts, assistantView),
      timestamp: cur.ts,
    });
  };
  const rl = createInterface({ input: createReadStream(path, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: {
      type?: string;
      agentId?: unknown;
      data?: {
        content?: unknown;
        summary?: unknown;
        success?: unknown;
        toolRequests?: unknown;
      };
      timestamp?: unknown;
    };
    try { ev = JSON.parse(line); } catch { continue; }
    const content = typeof ev.data?.content === 'string' ? ev.data.content : '';
    if (ev.type === 'user.message') {
      flush();
      cur = {
        turn_index: turns.length + 1,
        user: stripMarker(content),
        parts: [],
        ts: typeof ev.timestamp === 'string' ? ev.timestamp : null,
      };
    } else if (ev.type === 'assistant.message') {
      if (isChildScopedEvent(ev)) continue;
      // Tool-only autopilot messages persist with an empty `content` and the useful
      // action text in toolRequests[].intentionSummary. Preserve that trace rather
      // than returning an entirely blank assistant turn after unload/reload.
      const toolFallback = summarizeToolRequests(ev.data?.toolRequests);
      const assistantParts: AssistantPart[] = [];
      if (content) assistantParts.push({ source: 'assistant_content', text: content });
      else if (toolFallback) assistantParts.push({ source: 'tool_summary', text: toolFallback });
      if (assistantParts.length) {
        // An assistant message before any user prompt (rare/system) opens turn 0.
        if (!cur) cur = { turn_index: 0, user: '', parts: [], ts: typeof ev.timestamp === 'string' ? ev.timestamp : null };
        cur.parts.push(...assistantParts);
      }
    } else if (ev.type === 'session.task_complete') {
      if (isChildScopedEvent(ev)) continue;
      const summary = typeof ev.data?.summary === 'string' ? ev.data.summary.trim() : '';
      if (summary) {
        if (!cur) cur = { turn_index: 0, user: '', parts: [], ts: typeof ev.timestamp === 'string' ? ev.timestamp : null };
        const label = ev.data?.success === false
          ? '【task_complete summary · FAILED】'
          : '【task_complete summary】';
        cur.parts.push({ source: 'task_complete', text: `${label}\n${summary}` });
      }
    }
  }
  flush();
  return turns;
}
