// attention.ts — the authoritative derivation of a session's "needs the user"
// state. This is the SINGLE place that decides whether a session needs attention
// and of what kind; the client never re-derives it from raw events. Both
// notification channels (client Notification + server Web Push) and the sidebar
// badge consume the result.
//
//   'choice' — blocked mid-turn on a required decision (ask_user / plan confirm /
//              elicitation). The agent literally cannot proceed. Strongest signal.
//   'ready'  — the agent just finished its turn (running → idle) and awaits input;
//              it persists until the user sends the next prompt.
//   null     — nothing needed (running, freshly prompted, unloaded, error).
//
// 'ready' is edge-born (the running→idle moment), so this is a transition function
// of (previous, next), not a pure function of the current snapshot — otherwise
// every idle session on startup would falsely read as 'ready'.

import type { Attention } from '@cockpit/protocol';

export interface AttentionInputs {
  status: string;
  choicePending: boolean;
  // A user-initiated transition (e.g. the user cancelled the turn). Such a
  // running→idle is NOT a fresh "ready" — the user is right there and asked for
  // it — so it must never raise attention or fire a notification.
  silent?: boolean;
}

export function nextAttention(
  prev: AttentionInputs & { attention: Attention | null },
  next: AttentionInputs,
): Attention | null {
  // A user-initiated transition never raises attention: the user is present and
  // caused it (cancel), so there is nothing to alert them about. Clears any prior
  // signal too — opening/acting on the session is the natural "seen".
  if (next.silent) return null;
  // A pending decision always wins — the agent is blocked on the user.
  if (next.choicePending) return 'choice';
  // Actively working (or about to): nothing to ask, clear any prior signal.
  if (next.status === 'running') return null;
  if (next.status === 'idle') {
    // Only the moment of becoming idle-after-busy is a fresh "ready". An
    // already-idle session that receives an unrelated patch keeps its state, so a
    // 'ready' badge persists until the user prompts (status → running) and a
    // freshly loaded idle session never spuriously reads ready.
    const wasBusy = prev.status === 'running' || prev.choicePending;
    return wasBusy ? 'ready' : (prev.attention ?? null);
  }
  // error / unloaded / starting → no attention.
  return null;
}

// applySeen — the OTHER half of the lifecycle: what happens when the user looks.
// `nextAttention` decides when a session RAISES attention; this decides how a
// raised attention RESOLVES on sight. The two kinds resolve differently, which is
// the whole point of the design:
//   'ready'  — a finished result. Seeing it IS completion → clears to null. This
//              is what stops the badge from degrading into "every session" (an
//              agent always ends a turn idle-and-ready, so a ready that only
//              cleared on the next prompt would never leave the count).
//   'choice' — a blocked process. Seeing only advances `seenId` (so the UI can
//              show it demoted/muted); it stays raised and counted until ANSWERED
//              (which clears it structurally via nextAttention, not here).
// `seenId` is monotonic (max), so this is idempotent and commutative across the
// user's devices — replaying a stale "seen" can never lower it.
export function applySeen(
  cur: { attention: Attention | null; attnId: number; seenId: number },
): { attention: Attention | null; seenId: number } {
  return {
    seenId: Math.max(cur.seenId, cur.attnId),
    attention: cur.attention === 'ready' ? null : cur.attention,
  };
}
