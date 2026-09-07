# Module 3 — Core Fold

Scope: `packages/core/src/fold.ts`, `packages/core/src/fold.test.ts` (review only — no code changed).

## Summary

The fold is in good health. I traced every event kind for both the live (one-at-a-time)
and replay (full-history) paths and found **no Critical or High correctness bug**: routing,
depth-N sub-agent nesting, reasoning/streaming pairing, ask-reply surfacing, and attachment
extraction are all internally consistent, and both required verifications are green (137 unit
tests pass; real-log regression = 0 errors / 0 invalid over 34 sessions). The real risk is in
**verification, not implementation**: the most fragile path — the live-only streaming/reasoning
pairing — is *structurally invisible to the regression* (persisted logs contain zero
`assistant.reasoning*` / `message_start` / `message_delta` events), and the one test helper that
models the real client projection (`live().client`) is built but **never asserted**. So the
`live == replay` invariant is, in practice, exercised far less than it looks. Secondary items are
all Low/defensive (position-dependent fallback ids, a stale load-bearing comment, an empty-`reasoningId`
segment collision).

## Verification results

Both commands were run from the repo root.

- `pnpm --filter @cockpit/core test` → **PASS**. `tests 137 | pass 137 | fail 0 | cancelled 0 | skipped 0`
  (suite covers fold + prefs + mcp-config + eviction; the fold fixtures including H1/M2/M3 all pass).
- `pnpm --filter @cockpit/core regress` → **PASS**. `=== 34 sessions | 18597 msgs | 0 fold errors | 0 invalid | 120 subagent cards ===`.
  Every persisted `events.jsonl` folds clean and every resulting `ChatMessage` validates against the protocol schema.

Two read-only probes I ran to calibrate severity (temp script, deleted; no source touched):

- **Event-id presence:** of 139,462 real events, **0 are missing `id`**; `assistant.reasoning*`
  events never carry an empty `reasoningId` (because there are none — see below). This means the
  `state.messages.length`-derived fallback ids are *never reached on real data* → the idempotency
  concerns below are defensive, not live.
- **Double-pass idempotency:** folding each session's full history **twice onto the same state**
  did not grow `messages.length` for any of the 34 sessions — but only because real ids are stable;
  the suite/regress never actually assert this property (see Finding L1).
- **Event-type histogram (real logs):** there are **no** `assistant.reasoning`,
  `assistant.reasoning_delta`, `assistant.message_start`, or `assistant.message_delta` events in any
  persisted log. They are live-only/ephemeral and never replayed. The regression therefore validates
  the **replay** path only and tells us nothing about live==replay for streaming/reasoning.

## Findings

### [Critical] — none
No event path produces a divergent or invalid message; replay is schema-clean on all real logs.

### [High] — none
No mis-routing, lost reasoning, id collision, or append-instead-of-upsert found on any reachable path.

### [Medium] The live==replay invariant is asserted weakly; the most fragile path isn't covered — `fold.test.ts:25`, `fold.test.ts:91`
- **What:** `live()` builds a `client` Map that mirrors the real store's per-id upsert projection
  (`fold.test.ts:25-37`), which is the *only* representation that can catch an ordering/projection
  divergence between incremental emission and batch replay. **No test ever asserts on `client`.** H1
  uses `const { st: liveSt } = live(evs)` and compares `liveSt.messages` (the fold *state* array) to
  `replay().messages` (`fold.test.ts:91,99`). Because `replay()` and `live()` call the identical
  `foldEvent` over the identical event order, `liveSt.messages === replay().messages` is true
  *by construction* (the only delta is `engineIntercepts`, which is empty for turn_start after the H1
  fix). So the suite's "live == replay" is largely tautological. Meanwhile the genuinely
  divergence-prone, **live-only** streaming path (`assistant.reasoning` → placeholder `stream-…` →
  `assistant.message` adopts it via `msgAlias`/`streamingId`, `fold.ts:416-462`) never appears in
  persisted logs, so the regression can't see it either.
- **Why it matters:** A future change to reasoning/message pairing or to the order in which `changed`
  ids are first emitted could ship a real reload/multi-device divergence that **every existing check
  still passes**. This is exactly the bug class the invariant exists to prevent.
- **Recommendation:** Add tests that drive a streaming+reasoning turn through `live()`, reconstruct an
  *ordered* list from the `client` projection (insertion order of first-`changed`), and assert it
  deep-equals `replay().messages` — ids, order, `content`, and `thought`. Cover: reasoning-before-message,
  multi-segment reasoning, a cancelled partial followed by a real turn, and a sub-agent turn (card +
  nested subMessages). This converts the load-bearing invariant from "trusted" to "tested."

### [Low] Stale, load-bearing comment contradicts the H1 fix — `fold.ts:374`
- **What:** The `assistant.turn_start` handler comment reads *"On live this is intercepted by the
  engine before fold; reached on replay."* That is no longer true: the H1 fix makes the engine
  **fall through to the fold** on live (`engine.ts:702-711`: "Fall through to the fold so its
  turn-boundary reset (endTurn) runs on LIVE too — NOT returning here … live would then diverge from
  replay"). The fold's own H1 test (`fold.test.ts:78-103`) likewise relies on turn_start being folded
  live.
- **Why it matters:** The comment describes precisely the pre-H1 behavior whose return would
  re-introduce the "next turn merges into the cancelled bubble" divergence. A maintainer trusting it
  could re-add an engine intercept and silently break the invariant.
- **Recommendation:** Update the comment to state turn_start is folded on both live and replay (the
  engine no longer intercepts it).

### [Low] Position-dependent fallback ids are non-idempotent and not collision-proof — `fold.ts:390, 411, 423, 445, 465, 599`
- **What:** When an event lacks `id`/`messageId`/`reasoningId`, the message id is derived from
  `state.messages.length`: `u-${len}` (`:390`), `skill-${name}-${len}` (`:411`), `stream-${len}`
  (`:423`,`:438`), `a-${len}` (`:445`,`:465`), `${level}-${len}` (`:599`). Such an id depends on *when*
  the event is folded, so it is not stable across a re-pass and could collide with a later message.
  This contradicts the documented promise that "a second replay pass is a no-op."
- **Why it matters:** Currently **unreachable** — all 139,462 real events carry `id` (probe above), so
  this is defensive only. But nothing enforces that assumption, and no test/regress asserts the
  second-pass-no-op property, so a future SDK that drops an id would silently produce duplicate or
  colliding messages with no failing check.
- **Recommendation:** Either fail-fast / assert `ev.id` presence at the fold boundary, or derive the
  fallback from stable event data (e.g. a monotonic event offset) rather than mutable `messages.length`;
  and add a double-pass idempotency assertion to the suite to lock the invariant.

### [Low] Multi-segment reasoning collides when `reasoningId` is empty — `fold.ts:128-134, 426, 439`
- **What:** `beginReasoningSegment` keys a segment on `rid` and only commits the prior thought as the
  new base when `state.reasoningId !== rid` (`:129`). When `reasoningId` is empty the callers fall back
  to `seg-${state.messages.length}` (`:426`,`:439`). Within one turn the streaming message already
  exists, so `messages.length` does not change between two such finals → both compute the **same**
  `seg-N` key → the second is treated as the same segment and **overwrites** the first thought instead
  of appending (the very loss M2 was meant to fix).
- **Why it matters:** Contingent on an empty `reasoningId` (never observed — there are no reasoning
  events in persisted logs at all, and live reasoning realistically always carries an id), so this is
  defensive. But the `rid || seg-…` fallback signals the author anticipated empty ids, and that
  fallback doesn't actually disambiguate two same-turn segments.
- **Recommendation:** Disambiguate with a per-turn monotonic segment counter (reset in `resetTurn`)
  rather than `messages.length`, so empty-id segments still accumulate.

### [Low] `metaChanged` from a sub-fold propagates a (harmless) parent meta emit — `fold.ts:317, 367, 585-589`
- **What:** A `session.model_change` folded inside a sub-agent's nested state sets the *sub-fold's*
  `currentModelId` and returns `metaChanged:true`, which is bubbled up verbatim by both routing returns
  (`:317`,`:367`). The engine would emit a `session/patch` even though the parent fold's
  `currentModelId` is unchanged.
- **Why it matters:** Only a spurious (idempotent, value-unchanged) patch — and only if a sub-agent
  event ever carries a session-scoped `model_change` with an `agentId` (likely never, since model
  change is session-level). No correctness impact.
- **Recommendation:** If sub-agents can emit `model_change`, suppress meta propagation from sub-folds
  (return `metaChanged:false` for nested results). Otherwise leave as-is; noting for completeness.

### [Low] `system.message` / `session.info` are not folded into the thread — `fold.ts:591-606`
- **What:** The fold surfaces only `session.error`/`session.warning` as `role:'system'` bubbles. Real
  logs contain 940 `system.message` and 9 `session.info` events, which hit the `default: return empty`
  case and never appear in the transcript. The protocol `level` enum includes `'info'`
  (`packages/protocol/src/index.ts:104`) but the fold never produces it.
- **Why it matters:** Likely intentional (these are machinery / engine-handled), and consistent across
  live and replay, so not a divergence. Flagged only to confirm nothing user-relevant is silently
  dropped and to reconcile the unused `'info'` level.
- **Recommendation:** Confirm intent; if some `system.message`/`session.info` content should be visible,
  add a handler — otherwise note the `'info'` level is currently dead.

## Test coverage assessment

Strong where it's pointed; blind on the seam that matters most.

- **Well covered (state-level, via `replay()`):** user/assistant messages, streaming-delta
  accumulation, reasoning→message single-bubble pairing, H1 (cancelled turn doesn't absorb the next),
  H1b (`resetTurn`), M2 (multi-segment reasoning preserved), M3 (depth-2 nesting), single sub-agent
  nesting + tool attribution, ask-reply prefix stripping, error/warning levels, skill pill +
  skill-context suppression, and a thorough attachment matrix (user/agent, self-closing variant,
  non-`/uploads/` rejection, first-marker-wins, `cleanSessionTitle`). The regression then proves the
  **replay** path is schema-clean on 34 real sessions / 18.6K messages.

- **Gaps (priority order):**
  1. **The live projection is never asserted** (Finding M1). The `client` Map is the only model of the
     real store; assert an ordered reconstruction from it equals `replay().messages`.
  2. **No streaming/reasoning live==replay test that distinguishes the two paths.** Because these events
     are absent from persisted logs, the regression can't cover them and the fixtures only check
     post-fold state. A turn that streams `message_start`/`message_delta`/`reasoning_delta` then finalizes
     should be asserted identical between the live projection and a replay that contains only the final
     `assistant.message` (the actual production asymmetry).
  3. **No double-pass idempotency assertion** (Finding L1) — the documented "second pass is a no-op" is
     untested; add it.
  4. **Depth ≥ 3 sub-agents** are not tested (only depth-2 / M3). The recursive `ownsTask`/`ownsAgent`
     routing should be exercised at depth 3 to lock the descendant-mirroring bubble-up.
  5. **Sub-agent edge cases** untested: a `subagent.completed`/`failed` with no preceding `started`
     (drops to no-op), and a started-without-completion card remaining `status:'running'` (real logs show
     120 started vs 107 terminal → 13 never complete). Confirm both are intended.
  6. **Tool-status transitions inside a sub-fold**, and `tool.execution_start` arriving before its owning
     `assistant.message` (early return at `fold.ts:553-554`), are not directly tested.

## Positive notes

- The single-`foldEvent`-for-both-modes design is honored cleanly: every state mutation goes through
  the idempotent `upsert` (`fold.ts:64-72`) keyed by stable id, and `changed`/`metaChanged` are the only
  outputs — exactly the seam the invariant needs.
- Depth-N sub-agent routing is genuinely recursive and correct: the descendant block (`fold.ts:306-321`)
  + `ownsTask`/`ownsAgent` (`:82-93`) + per-level card mirroring (`:317`,`:366`) bubble nested updates up
  without leaking sub-agent work onto the main thread (verified by M3 and 120 real cards folding clean).
- Reasoning/message pairing via a reasoning-derived placeholder + `msgAlias` adoption (`:97-112`,
  `:444-468`) is a tidy solution to events that share no id, and `resetTurn` correctly scopes it per turn.
- Security-minded parsing: attachment urls are constrained to `/uploads/` for both user and agent
  markers (`:194`), stray second markers are stripped rather than leaked as raw XML (`:230`), and
  `cleanSessionTitle` prevents a raw marker from becoming a session title.

## Cross-cutting (brief — noted, not investigated)

- **Engine intercept list defines the live==replay contract.** The fold is only half the invariant; the
  set of event types the engine handles *without* folding (`engine.ts` `onLive`) is the other half. The
  H1 fix correctly moved `turn_start` to fall-through; any future addition to that intercept list must be
  re-checked against replay. (Owned by the Engine module — flag only.)
- **Streaming-delta persistence is an Engine/SDK assumption.** Whether a cancelled turn's partial content
  survives reload depends on whether `message_delta` events are in `getEvents()`; real logs suggest they
  are not, so a cancelled partial visible live may differ from replay. Worth confirming in the Engine
  review.
- **Protocol `level: 'info'`** (`packages/protocol/src/index.ts:104`) is currently unproduced by the fold
  (see Finding L6) — a small protocol/fold reconciliation for the Protocol module.
