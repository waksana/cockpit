// lifecycle.ts — pure, unit-testable helpers shared across the Engine's
// lifecycle/correctness paths. Kept dependency-free (only protocol types) so the
// same predicates can be reused by the transport (which only holds a SessionMeta
// snapshot) without pulling in the Engine.

import type { SessionMeta } from '@cockpit/protocol';

// A session is "busy" — it must NOT be evicted, unloaded, reloaded, or have the
// graceful-restart gate opened on it — when ANY of these hold:
//   - a turn is running (status === 'running');
//   - it is paused on a required user decision (ask / planRequest / elicitation);
//   - it has an in-flight background `task` sub-agent (activeSubagents > 0);
//   - a (manual or auto) compaction is in flight;
//   - a per-session MCP mutation is still running or settling.
//
// The subtle one is compaction: a MANUAL `/compact` keeps status === 'idle' (the
// SDK never emits session.idle for it), so `status` alone misses it — only this
// predicate's `compacting` term catches it. Likewise a background sub-agent today
// keeps status === 'running' (the SDK defers session.idle while it runs), but we
// assert `activeSubagents` rather than rely on that timing guarantee, so the
// safety stops depending on an undocumented SDK invariant.
//
// Operates over the PROJECTED SessionMeta fields, so the transport can consume the
// exact same definition from a snapshot.
export function sessionMetaBusy(
  s: Pick<SessionMeta, 'status' | 'ask' | 'planRequest' | 'elicitation' | 'activeSubagents' | 'compacting' | 'activeMcpOperations'>,
): boolean {
  return s.status === 'running'
    || !!(s.ask || s.planRequest || s.elicitation)
    || (s.activeSubagents ?? 0) > 0
    || !!s.compacting
    || (s.activeMcpOperations ?? 0) > 0;
}

// Engine-authoritative wrapper: ORs the live in-memory in-flight `task` count
// (the Set the Engine maintains) on top of the projected predicate. The Engine
// passes `st.inflightTasks.size`; the meta's `activeSubagents` is the projection
// of that same set, so this is belt-and-suspenders against a not-yet-projected
// add. Exported for reuse (the transport can call `sessionMetaBusy` directly with
// just a snapshot; this overload is for callers that also hold the live count).
export function engineSessionBusy(
  meta: Pick<SessionMeta, 'status' | 'ask' | 'planRequest' | 'elicitation' | 'activeSubagents' | 'compacting' | 'activeMcpOperations'>,
  inflightTaskCount: number,
): boolean {
  return sessionMetaBusy(meta) || inflightTaskCount > 0;
}

// ── Queue item ids ──────────────────────────────────────────────────────────
// The SDK exposes NO stable per-queued-item id, and its pending array re-indexes
// on every drain (`shift`) and on every removal (clear + rebuild). A purely
// positional id (`q-<i>`) therefore races: a stale index can target the wrong
// surviving item. We embed a short, stable CONTENT tag in the id so a removal can
// re-validate the target by content (and relocate it if the index shifted) before
// touching the queue — turning the race into a fail-closed no-op instead of a
// wrong-item deletion.

// FNV-1a over the item text → a short base36 tag. Collisions only ever conflate
// two items with identical text (user-indistinguishable), so they are harmless.
export function queueTextTag(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function makeQueueId(index: number, text: string): string {
  return `q-${index}-${queueTextTag(text)}`;
}

// Parse a queue id back into its index + content tag. Tolerates the legacy
// positional form `q-<i>` (a client holding an id minted before this change, e.g.
// across a deploy) by returning an empty tag, which the consumer treats as a
// positional fallback. Returns null for anything else (→ fail-closed no-op).
export function parseQueueId(id: string): { index: number; tag: string } | null {
  const withTag = /^q-(\d+)-([0-9a-z]+)$/.exec(id);
  if (withTag) return { index: Number(withTag[1]), tag: withTag[2] ?? '' };
  const legacy = /^q-(\d+)$/.exec(id);
  if (legacy) return { index: Number(legacy[1]), tag: '' };
  return null;
}
