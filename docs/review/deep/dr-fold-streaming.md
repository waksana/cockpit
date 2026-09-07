# Deep: Fold live==replay streaming verification

Scope: prove or disprove the `live == replay` invariant for the **live-only**
streaming/reasoning path of the fold (`packages/core/src/fold.ts`). Review-only —
no source touched. Harness was throwaway `/tmp` scratch (deleted), importing the
**real** fold via `tsx`. Companion to first-pass `docs/review/03-fold.md` (Medium
M1, Lows L1/L2).

## Verdict summary

**The invariant does NOT hold on the live-only streaming/reasoning path.** Pure
token streaming reloads faithfully, but **every turn that contains reasoning
diverges on reload: the `thought` is silently dropped.** This is *not* inherent to
persistence as the first-pass assumed — the reasoning text **is** persisted, on the
final `assistant.message` as `data.reasoningText` (9,440 of 18,916 real messages —
~50% — carry a non-empty one), but the fold's `assistant.message` handler never
reads it (`fold.ts:464-547` reads only `content`/`messageId`/`toolRequests`). So a
user who watches the model think live sees the answer **without the thinking** after
any reconnect or reload. A cancelled partial bubble also vanishes on reload. Both
first-pass Lows (L1 non-idempotent fallback ids, L2 empty-`reasoningId` segment
collision) are **CONFIRMED** by direct construction.

## Scenarios tested

The persisted (replay) form was built from what `getEvents()` actually returns —
verified empirically: across **141,811** real events there are **0**
`assistant.message_start` / `assistant.message_delta` / `assistant.reasoning` /
`assistant.reasoning_delta`, but **17,393** `assistant.turn_start` and **18,898**
`assistant.message` (the final message, carrying `reasoningText`). Live = the full
stream folded one event at a time, reconstructed in the store's first-upsert
insertion order (`store.ts:282-294`, `engine.onLive:757-763`). Comparison is a
deep-equal on `{id, role, subtype, content, thought, subagent.status, subMessages}`.

| # | Scenario | LIVE result | REPLAY result | Verdict |
|---|----------|-------------|---------------|---------|
| 1 | Pure streaming (`message_start`+`message_delta`×2+final) | `{a1, "Hello"}` | `{a1, "Hello"}` | **CONFIRMED-OK** |
| 2 | Reasoning before message (real `reasoningText` on final msg) | `{stream-r1, "The answer.", thought:"Let me think hard."}` | `{a1, "The answer."}` *(no thought)* | **DIVERGES** (thought + id) |
| 3 | Multi-segment reasoning (`r1`+`r2`) | `{stream-r1, "done", thought:"first…\n\nsecond…"}` | `{a1, "done"}` *(no thought)* | **DIVERGES** (thought + id) |
| 4 | Cancelled partial, then real turn | `[{a1,"partial…"}, {a2,"second turn answer"}]` | `[{a2,"second turn answer"}]` | **DIVERGES** (phantom bubble) |
| 5 | Sub-agent that streams internally | card→`[{stream-ir1,"inner ans",thought:"inner thinking"}]` | card→`[{sa1,"inner ans"}]` *(no thought)* | **DIVERGES** (thought + id, in card) |

First-pass findings:

| Finding | Verdict |
|---|---|
| L1 — position-dependent fallback ids non-idempotent (`messages.length`) | **CONFIRMED** (id-less event duplicates on 2nd pass) |
| L2 — empty-`reasoningId` multi-segment collision (`seg-${len}`) | **CONFIRMED** (2nd segment overwrites the 1st) |
| M1 — live==replay asserted weakly; streaming path uncovered | **CONFIRMED & REFINED** (a real, fixable divergence, not just untested) |

## Divergences / confirmed findings

### D1 — Reasoning `thought` is dropped on reload, although it IS persisted *(scenarios 2, 3, 5)* — **the load-bearing finding**

**Mechanism.** Live, reasoning arrives as `assistant.reasoning_delta`/
`assistant.reasoning` *before* the message and is folded onto a reasoning-derived
placeholder message:

```
fold.ts:438   const m = streamingMsg(state) ?? ensureStreaming(state, `stream-${rid || state.messages.length}`, tsOf(ev));
fold.ts:440   m.thought = base + content;
```

When the real message then streams, `assistant.message` preserves that already-
attached thought via `prevThought`:

```
fold.ts:530   const prevIdx = state.byId.get(id);
fold.ts:531   const prevThought = prevIdx !== undefined ? state.messages[prevIdx]?.thought : undefined;
fold.ts:540   ...(prevThought ? { thought: prevThought } : {}),
```

On **replay**, `getEvents()` contains **no** `assistant.reasoning*` events, so no
placeholder is ever created, `prevThought` is `undefined`, and the handler **never
falls back to `data.reasoningText`** even though it is present on the very event it
is folding. Result: `thought` is lost.

**This is fixable in the fold** — the data is in hand. The first-pass framing
("reasoning is live-only/ephemeral and never replayed") is true of the *events* but
not of the *text*: I confirmed empirically that **9,440 / 18,916** persisted
`assistant.message`s carry a non-empty `data.reasoningText` (keys present on real
messages: `reasoningText`, `reasoningOpaque`, alongside `content`/`messageId`/
`toolRequests`). The fold simply ignores it.

**Fix (one line, in the `assistant.message` handler at `fold.ts:529-543`):** when
there is no `prevThought`, fall back to the persisted reasoning —

```ts
const persistedThought = typeof d.reasoningText === 'string' && d.reasoningText.trim()
  ? d.reasoningText : undefined;
const thought = prevThought ?? persistedThought;
// …and use `thought` in the empty-byline guard (:534) and the spread (:540).
```

This makes replay reconstruct the reasoning that the user saw live. Note the
exact-equality caveat below.

**Residual id asymmetry (benign).** Even with the thought fix, the message *id*
still differs: live keeps the placeholder `stream-r1` (the real id is aliased onto
it — `fold.ts:449,468`), while replay uses the real `messageId` `a1`. This is an
*inherent* consequence of reasoning preceding the message with no shared id, and is
**benign**: on reconnect/reload the store replaces the whole message window
atomically (`store.ts:264`, `engine.maybeMaterialize(force)`), so the id is never
user-visible and is not used for cross-snapshot identity. Re-keying the placeholder
to the real id on `message_start` would instead orphan `stream-r1` in the store
(msg/upsert can only insert/replace, never delete), which is worse for live. So the
right scope of the fix is the **thought**, not the id.

### D2 — Cancelled partial bubble disappears on reload *(scenario 4)*

**Mechanism.** Live, a cancelled turn streams `message_start`+`message_delta` into
`a1`; `engine.cancel()` then calls `resetTurn` (`fold.ts:116`) so the next turn
stays separate (H1 — verified: live keeps `a1` *and* `a2`). But the cancelled turn
emits **no** final `assistant.message`, and streaming deltas are not persisted, so
`getEvents()` holds only the two `turn_start`s + the second turn's message. Replay
therefore yields just `[a2]` — the `partial…` bubble the user watched is gone.

This is **persistence-rooted, not a fold defect** (and the first-pass cross-cutting
note flagged it). It is defensible (nothing was committed), but it is a genuine
live≠replay difference and should be acknowledged as expected behavior, ideally
with a test that pins it so it can't silently change.

### L1 — Position-dependent fallback ids are non-idempotent — **CONFIRMED** — `fold.ts:390, 411, 423, 438, 445, 465, 599`

Constructed the precise trigger: an **id-less** `user.message` (no `ev.id`), folded
twice onto the same state (the "second replay pass is a no-op" promise).

```
ids after pass 1: ["u-0"]
ids after pass 2: ["u-0","u-1"]   → DUPLICATED
with stable id  : pass1 len=1, pass2 len=1   → idempotent (control)
```

The id `u-${state.messages.length}` (`fold.ts:390`) depends on *when* the event is
folded, so a re-pass mints a *new* id and appends a duplicate. Same mechanism at
`skill-${name}-${len}` (:411), `stream-${len}` (:423,:438), `a-${len}` (:445,:465),
`${level}-${len}` (:599). **Currently unreachable** on real data (all 141,811
events carry an id), so this is defensive — but nothing enforces the assumption and
no test asserts the second-pass-no-op property. **Fix:** assert `ev.id` at the fold
boundary, or derive fallbacks from a monotonic event offset rather than mutable
`messages.length`; add a double-pass idempotency assertion.

### L2 — Empty-`reasoningId` multi-segment collision — **CONFIRMED** — `fold.ts:128-134, 426, 439`

Constructed two `assistant.reasoning` events with `reasoningId: ''` in one turn:

```
final thought: "BBB"
contains AAA? false   contains BBB? true     → AAA LOST
control (r1/r2) thought: "AAA\n\nBBB"        → both kept
```

With an empty `rid`, both finals fall back to `seg-${state.messages.length}`
(`fold.ts:439`). The streaming message is pushed by the first `ensureStreaming`, so
`messages.length` is identical (=1) at both calls → both compute **`seg-1`**.
`beginReasoningSegment` sees `state.reasoningId === rid` (`fold.ts:129`) on the
second, treats it as the *same* segment, and the line `m.thought = base + content`
(`:440`) overwrites `AAA` with `BBB` — the exact M2 loss M2 was meant to fix.
**Unreachable today** (no reasoning events in logs, and live reasoning realistically
carries an id), so defensive — but the `rid || seg-…` fallback signals the author
anticipated empty ids, and it does not disambiguate. **Fix:** key segments on a
per-turn monotonic counter (reset in `resetTurn`), not `messages.length`.

## Demonstration

Harness `/tmp/foldverify/verify.ts` (deleted after capture) imported the real
`newFoldState`/`foldEvent`/`resetTurn`. `live()` folds one event at a time and
projects in the store's first-upsert insertion order; `replay()` folds the
persisted form in one batch; both deep-equal on `{id, role, subtype, content,
thought, subStatus, subMessages}`. Captured output:

```
=== 1. pure streaming (message_start/delta) === CONFIRMED-OK
  LIVE  : [{"id":"a1","role":"assistant","content":"Hello"}]
  REPLAY: [{"id":"a1","role":"assistant","content":"Hello"}]

=== 2. reasoning-before-message (real getEvents carries reasoningText) === DIVERGES
  LIVE  : [{"id":"stream-r1","role":"assistant","content":"The answer.","thought":"Let me think hard."}]
  REPLAY: [{"id":"a1","role":"assistant","content":"The answer."}]
  ↳ diff @[0]  live={…thought:"Let me think hard."}  replay={…no thought, id a1}

=== 3. multi-segment reasoning (r1 + r2) === DIVERGES
  LIVE  : [{"id":"stream-r1","content":"done","thought":"first thought\n\nsecond thought"}]
  REPLAY: [{"id":"a1","content":"done"}]            ← thought lost

=== 4. cancelled partial then real turn === DIVERGES
  LIVE  : [{"id":"a1","content":"partial…"},{"id":"a2","content":"second turn answer"}]
  REPLAY: [{"id":"a2","content":"second turn answer"}]   ← phantom partial gone

=== 5. sub-agent that streams (inner reasoning + deltas) === DIVERGES
  LIVE  : card → subMessages:[{"id":"stream-ir1","content":"inner ans","thought":"inner thinking"}]
  REPLAY: card → subMessages:[{"id":"sa1","content":"inner ans"}]   ← inner thought lost

### Finding L1: fallback id non-idempotency (id-less user.message) ###
  ids after pass 1: ["u-0"]
  ids after pass 2: ["u-0","u-1"] → DUPLICATED (non-idempotent)
  with stable id: pass1 len=1, pass2 len=1 → idempotent (control)

### Finding L2: empty-reasoningId multi-segment collision ###
  final thought: "BBB"
  contains AAA? false  contains BBB? true → AAA LOST (collision)
  control (r1/r2) thought: "AAA\n\nBBB" → both kept: true
```

Baseline (read-only, this pass): `node --test packages/core/src/fold.test.ts` →
**26 pass / 0 fail**. The suite is green *because* it never asserts the streaming
path against a persisted-only replay (M1) — every existing fixture either replays a
stream that has no reasoning, or compares post-fold state to itself.

**Exact-equality caveat for the D1 fix:** live accumulates `thought` from
`assistant.reasoning` content (multi-segment joined with `\n\n` by
`beginReasoningSegment`), whereas `data.reasoningText` is the SDK's own final
rendering. Reading `reasoningText` guarantees the reasoning is **present and
correct** after reload (the user-visible property the invariant protects); whether
it is *byte-identical* to the live-accumulated multi-segment string depends on the
SDK's formatting. The recommended tests below assert presence/equality against the
`reasoningText` value, not against the live `\n\n`-joined form.

## Recommended tests to add to `fold.test.ts`

A shared helper that folds the **live** stream one-at-a-time and the **persisted**
form in batch, then deep-equals the *projected* result — this is the assertion M1
asks for (the existing `live().client` map is built but never asserted).

1. **Streaming reasoning survives reload (D1 — the headline test).**
   Live: `turn_start, reasoning_delta, reasoning, message_start, message_delta,
   assistant.message{content, reasoningText}`. Replay: `turn_start,
   assistant.message{content, reasoningText}` only. Assert
   `replay.messages[0].thought === <reasoningText>` and equals the live thought.
   *This test fails today* and is the guard for the proposed `reasoningText`
   fallback fix.

2. **Pure streaming reloads identically (regression lock for scenario 1).**
   Assert `live == replay` for `message_start`/`message_delta`/final with no
   reasoning (currently OK — lock it).

3. **Multi-segment reasoning reload (D1 + M2 together).**
   Two `reasoning` segments live; replay = final message with the combined
   `reasoningText`. Assert both segments are present after reload.

4. **Cancelled partial vs reload (D2 — pin expected behavior).**
   Assert live shows `[partial, secondTurn]` but replay (no final message for the
   cancelled turn) shows `[secondTurn]` — documents that a cancelled partial is not
   persisted, so a future accidental change is caught.

5. **Sub-agent streaming reload (scenario 5).**
   Inner reasoning + deltas live; replay = inner final message only. Assert the
   card's `subMessages[0].thought` is reconstructed (fails today; passes with the
   fix).

6. **Double-pass idempotency (L1).**
   Fold a fixture twice onto the same state; assert `messages.length` and the id
   list are unchanged. Add an id-less event variant to pin the fallback behavior
   (or assert the fold rejects/normalizes a missing id).

7. **Empty-`reasoningId` multi-segment (L2).**
   Two `reasoning` events with `reasoningId: ''` in one turn; assert *both* texts
   survive (fails today; passes with a per-turn segment counter).

Tests 1, 3, 5 convert the load-bearing `live == replay` invariant on the
reasoning path from "trusted" to "tested" and double as the acceptance check for
the D1 `reasoningText` fix.
