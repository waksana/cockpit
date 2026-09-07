// hooks.ts — the Butler/Flow event-hook trigger layer (engine-global, cross-
// session). A hook is schedule's sibling: schedule fires on TIME, a hook fires
// on an ECOSYSTEM EVENT. The registry is engine-global because hooks are
// cross-session — one session (the butler) reacts to events anywhere in the
// fleet. The mechanism is mechanical and cheap; all intelligence lives in the
// agent the delivery lands on.
//
// This module holds the PURE, testable decision logic (no Engine/SDK):
//   - firstTurnEligible: the guard for emitting session.first-turn-complete,
//     including R1 (a spawnedBy worker is a non-trigger-source).
//   - matchHooks: which hooks fire for a given event (filters), and the
//     interpolated delivery text for each.
// The Engine owns the side effects (persistence, emitting, enqueuing).

import type { HookEntry, SessionEventCtx, SessionEventType } from '@cockpit/protocol';

// A GLOBAL event has no source session — its ctx carries empty source fields and
// it is not "about" any one session. Currently only engine.boot-complete. The
// distinction is load-bearing for `once`: on a source-keyed event `once` means
// "once per source" (deduped elsewhere), but on a global event there is no source
// to dedupe on, so `once` means "fire on the next occurrence then auto-remove".
export function isGlobalEvent(event: SessionEventType): boolean {
  return event === 'engine.boot-complete';
}

// Fail-loud guard (Finding 1): a cwdPrefix/sessionId source filter on the GLOBAL
// engine.boot-complete event can NEVER match — the event is source-less (empty
// source fields), so any such filter silently drops every firing, making the hook
// dead with no error. Returns an error string to reject at creation, else null.
// (excludeSelf is harmless on a '' source — it can never drop it — so not rejected.)
export function bootFilterRejection(
  event: SessionEventType,
  filter?: { cwdPrefix?: string; sessionId?: string },
): string | null {
  if (event === 'engine.boot-complete' && (filter?.cwdPrefix || filter?.sessionId)) {
    return "source filters (cwd_prefix/source_session) don't apply to the global engine.boot-complete event (it has no source)";
  }
  return null;
}

// ── R1 + first-turn-complete eligibility ─────────────────────────────────────
// The event fires when a REAL (human-created) session finishes its TRUE first
// turn — the one and only turn in its persisted history. It must NOT fire for: a
// spawned worker (R1 — else a welcome worker would trigger another welcome = fork
// bomb), a session already welcomed (once per source, persisted), a cancelled
// turn (user-initiated, not a natural completion), or an OLD session that has
// already had multiple turns. The last is the load-bearing guard: eligibility is
// keyed on the PERSISTED turn count (= number of genuine user prompts in the
// folded history), so reloading/restarting an established session can never
// mistake its next idle for a "first turn".
export interface FirstTurnInputs {
  spawnedBy?: string;     // set ⇒ this is a worker ⇒ NON-trigger-source (R1)
  alreadyWelcomed: boolean; // the persistent once-bit for this source session
  cancelled: boolean;     // the just-ended turn was user-cancelled/aborted
  userPrompts: number;    // genuine user prompts in the folded history (excl. ask-reply) = the persisted turn count
  assistantMessages: number; // count of assistant messages with non-empty content
}

export function firstTurnEligible(i: FirstTurnInputs): boolean {
  if (i.spawnedBy) return false;        // R1: workers never trigger
  if (i.alreadyWelcomed) return false;  // once per source session (persisted)
  if (i.cancelled) return false;        // not a natural completion
  // EXACTLY the first turn in the session's PERSISTED history: a single genuine
  // user prompt that has produced a reply. An old session with multiple turns has
  // userPrompts >= 2 and never fires — this is what stops a reload/restart from
  // re-welcoming established sessions.
  return i.userPrompts === 1 && i.assistantMessages >= 1;
}

// Count the turn signals from a session's folded messages. `userPrompts` excludes
// ask-reply messages (those are mid-turn answers to ask_user, not new turns) so it
// equals the session's persisted turn count; `assistantMessages` counts replies
// with content (excluding sub-agent cards). Pure so the ask-reply exclusion — the
// subtle part of the first-turn guard — is directly testable.
export function countTurnSignals(
  messages: readonly { role: string; subtype?: string; content: string }[],
): { userPrompts: number; assistantMessages: number } {
  let userPrompts = 0;
  let assistantMessages = 0;
  for (const m of messages) {
    if (m.role === 'user') { if (m.subtype !== 'ask-reply') userPrompts++; }
    else if (m.role === 'assistant' && m.subtype !== 'subagent' && m.content.trim().length > 0) assistantMessages++;
  }
  return { userPrompts, assistantMessages };
}

// ── R1 + session.error eligibility (the triage trigger guard) ────────────────
// session.error fires when a REAL session's turn ends in error. It must NOT fire
// for a spawned worker (R1 — a worker that crashes is reviewed by flow-review, not
// triaged; otherwise a bad worker error-storms triage into a fork bomb), and it is
// rate-limited per source: a flapping session that errors repeatedly emits at most
// one event per `windowMs`, so the bus can't be stormed. Pure + (lastFiredAt, now)
// driven so the dedup window is directly testable; the Engine owns the timestamps.
export interface SessionErrorInputs {
  spawnedBy?: string;          // set ⇒ worker ⇒ NON-trigger-source (R1)
  lastFiredAt?: number;        // when session.error last fired for THIS source (undefined = never)
  now: number;                 // current epoch ms
  windowMs: number;            // min spacing between fires for one source
}

export function sessionErrorEligible(i: SessionErrorInputs): boolean {
  if (i.spawnedBy) return false;                       // R1: workers never trigger triage
  if (i.lastFiredAt !== undefined && i.now - i.lastFiredAt < i.windowMs) return false; // dedup/rate-limit
  return true;
}

// ── Hook matching ────────────────────────────────────────────────────────────
export interface HookDelivery {
  hook: HookEntry;
  ownerSession: string;
  // Phase A: the interpolated prompt to enqueue into ownerSession. Undefined when
  // the hook delegates to a Flow (flowId) — Phase B resolves that path.
  text?: string;
  flowId?: string;
}

// Does a hook's filter admit this event? cwdPrefix/sessionId narrow the source;
// excludeSelf drops events whose source IS the owner (a butler must not react to
// its own lifecycle).
export function hookMatchesEvent(hook: HookEntry, ev: SessionEventCtx): boolean {
  if (hook.event !== ev.event) return false;
  const f = hook.filter;
  if (f) {
    if (f.sessionId && f.sessionId !== ev.sessionId) return false;
    if (f.cwdPrefix && !ev.cwd.startsWith(f.cwdPrefix)) return false;
    if (f.excludeSelf && ev.sessionId === hook.ownerSession) return false;
  }
  // A hook never reacts to events on its OWN session by default (a butler acting
  // on a source it owns would risk self-loops); excludeSelf makes this explicit,
  // but even without it we drop owner==source to stay safe. Guarded against an
  // empty source: a GLOBAL event has ev.sessionId === '' and must NOT be dropped
  // just because a hook's ownerSession is also '' (defense-in-depth — the protocol
  // now enforces ownerSession.min(1), but a malformed loopback intent could slip).
  if (ev.sessionId !== '' && ev.sessionId === hook.ownerSession) return false;
  return true;
}

// Interpolate the event context into a prompt template. Supports {event.field}
// and bare {field} for the SessionEventCtx keys. Unknown tokens are left intact.
export function interpolate(template: string, ev: SessionEventCtx): string {
  const map: Record<string, string> = {
    event: ev.event,
    'event.event': ev.event,
    sessionId: ev.sessionId,
    'event.sessionId': ev.sessionId,
    cwd: ev.cwd,
    'event.cwd': ev.cwd,
    title: ev.title,
    'event.title': ev.title,
    summary: ev.summary ?? '',
    'event.summary': ev.summary ?? '',
  };
  return template.replace(/\{([a-zA-Z.]+)\}/g, (m, key) => (key in map ? map[key]! : m));
}

// All deliveries for an event. The Engine calls this, then performs each
// delivery's side effect (enqueue text, or — Phase B — run the flow).
export function matchHooks(hooks: readonly HookEntry[], ev: SessionEventCtx): HookDelivery[] {
  const out: HookDelivery[] = [];
  for (const hook of hooks) {
    if (!hookMatchesEvent(hook, ev)) continue;
    const delivery: HookDelivery = { hook, ownerSession: hook.ownerSession };
    if (hook.flowId) delivery.flowId = hook.flowId;
    if (hook.promptTemplate) delivery.text = interpolate(hook.promptTemplate, ev);
    out.push(delivery);
  }
  return out;
}

// ── HookRegistry ─────────────────────────────────────────────────────────────
// A thin in-memory holder over a persisted list. The Engine constructs it with a
// loader+saver bound to Prefs, so hooks survive reload/restart (re-armed on
// engine.start). Engine-global by design: one registry, all sessions.
export class HookRegistry {
  private hooks: HookEntry[];
  private readonly persist: (hooks: HookEntry[]) => void;
  private seq = 0;

  constructor(initial: HookEntry[], persist: (hooks: HookEntry[]) => void) {
    this.hooks = [...initial];
    this.persist = persist;
    // Seed the id sequence past any restored numeric suffix so new ids never collide.
    for (const h of this.hooks) {
      const n = Number(h.id.replace(/^hook-/, ''));
      if (Number.isFinite(n) && n > this.seq) this.seq = n;
    }
  }

  list(ownerSession?: string): HookEntry[] {
    const all = [...this.hooks];
    return ownerSession ? all.filter((h) => h.ownerSession === ownerSession) : all;
  }

  add(entry: Omit<HookEntry, 'id' | 'createdAt'>): HookEntry {
    const hook: HookEntry = { ...entry, id: `hook-${++this.seq}`, createdAt: Date.now() };
    this.hooks.push(hook);
    this.persist(this.hooks);
    return hook;
  }

  stop(id: string): boolean {
    const before = this.hooks.length;
    this.hooks = this.hooks.filter((h) => h.id !== id);
    const removed = this.hooks.length < before;
    if (removed) this.persist(this.hooks);
    return removed;
  }

  // How many hooks a session OWNS (drives SessionMeta.hookCount).
  countFor(ownerSession: string): number {
    return this.hooks.filter((h) => h.ownerSession === ownerSession).length;
  }

  // The distinct owner sessions (for projecting hookCount onto each).
  owners(): Set<string> {
    return new Set(this.hooks.map((h) => h.ownerSession));
  }
}
