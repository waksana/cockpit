// memory.ts — bounding cockpit's resident heap against image-heavy sessions.
//
// THE PROBLEM. The dominant heap consumer is the in-process SDK conversation:
// the model is stateless, so every viewed image is held as a base64 string and
// re-sent on every turn. With several image-heavy sessions resident at once the
// process reaches V8's old-space ceiling (~2.2 GB by default) and aborts with a
// fatal "JavaScript heap out of memory" — observed here as the 11th restart.
//
// THE CONSTRAINT. cockpit cannot prune images *inside* a loaded SDK session: the
// SDK owns that conversation and rebuilds it from its on-disk event log on every
// reload. The only lever cockpit holds is WHETHER a session is resident at all —
// unloading drops the SDK handle (and the folded window) and the session
// transparently re-materializes from disk when next opened.
//
// THE FIX (these helpers). (1) Estimate each session's image weight cheaply so we
// know which sessions are heavy, and (2) under real heap pressure, evict the
// fewest idle sessions that free the most memory. The Engine triggers on the true
// `process.memoryUsage().heapUsed` (ground truth); these helpers only rank and
// select. Eviction is invisible to clients beyond the existing unloaded state.

import v8 from 'node:v8';

const MAX_WALK_DEPTH = 14;

// Recursively sum the byte length of every inline image payload in an SDK event.
// Image blocks surface at varying depths and event shapes (a tool result's
// `binaryResultsForLlm[]`, a user message's `content[]`, …) but always as an
// object carrying `type: 'image'` and a base64 `data` string. Walking by shape
// (not by a fixed path) keeps this correct as new event shapes appear. Depth is
// bounded so a pathological/cyclic object can't run away. The base64 char count
// is used as the weight unit — a close, monotonic proxy for the resident bytes,
// which is all the ranking needs.
export function imageBytesOf(ev: unknown, depth = 0): number {
  if (depth > MAX_WALK_DEPTH || ev === null || typeof ev !== 'object') return 0;
  if (Array.isArray(ev)) {
    let sum = 0;
    for (const item of ev) sum += imageBytesOf(item, depth + 1);
    return sum;
  }
  const o = ev as Record<string, unknown>;
  if (o.type === 'image' && typeof o.data === 'string') {
    // The image payload is counted here; its sibling metadata is negligible and
    // not worth descending into.
    return o.data.length;
  }
  let sum = 0;
  for (const k in o) {
    const v = o[k];
    if (v !== null && typeof v === 'object') sum += imageBytesOf(v, depth + 1);
  }
  return sum;
}

export interface EvictionCandidate {
  sessionId: string;
  lastActivity: number;
  imageBytes: number;
}

// Choose idle sessions to unload under heap pressure. Frees the most memory with
// the fewest evictions: heaviest image weight first, ties broken by least-recently
// active. Stops once the accumulated estimate reaches `bytesToFree`, and never
// evicts more than `maxCount` in one pass — a wrong estimate must not unload every
// session, and the next watchdog tick re-checks the true heap after a GC.
export function pickEvictionVictims(
  candidates: EvictionCandidate[],
  bytesToFree: number,
  maxCount: number,
): string[] {
  if (maxCount <= 0) return [];
  const ordered = [...candidates].sort(
    (a, b) => b.imageBytes - a.imageBytes || a.lastActivity - b.lastActivity,
  );
  const victims: string[] = [];
  let freed = 0;
  for (const c of ordered) {
    if (victims.length >= maxCount || freed >= bytesToFree) break;
    victims.push(c.sessionId);
    freed += c.imageBytes;
  }
  return victims;
}

// Heap-pressure watermarks as fractions of V8's *actual* ceiling, so they adapt if
// --max-old-space-size is later raised. Trigger eviction above HIGH, evict down
// toward LOW. The observed OOM abort was at ~92% of the ceiling. Tuned aggressive
// (2026-06-19): trigger at 60% (was 70%) and drain to 45% (was 50%) so eviction
// starts with more runway and frees more per pass — allocation bursts were
// outrunning the watchdog near the wall and OOM-aborting the whole process.
export const HEAP_HIGH_FRAC = 0.60;
export const HEAP_LOW_FRAC = 0.45;
// Last-resort ceiling. Above this, even a keep-loaded (has-schedule) idle session
// may be evicted — but only when no schedule-free candidate remains — because a
// stalled schedule is recoverable (it reloads + re-arms) while an OOM abort takes
// the whole server down. Always logged loud.
export const HEAP_HARD_FRAC = 0.88;

export interface HeapReading {
  used: number;
  limit: number;
}

export function readHeap(): HeapReading {
  return {
    used: process.memoryUsage().heapUsed,
    limit: v8.getHeapStatistics().heap_size_limit,
  };
}
