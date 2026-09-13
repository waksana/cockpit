# Fix: Fold drops reasoning `thought` on reload (live ≠ replay)

> **历史归档，不是当前规范或操作指南。** [当前文档](../../../README.md) · [归档边界](../../README.md) · [原位置固定版本](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/review/fixes/fx-fold.md)。
> 结论、行号、旧路径和环境按原记录理解，未为本次文档整理重新执行其操作。


Implements **D1** from `docs/review/deep/dr-fold-streaming.md` (upgraded to High).
First-pass context: `docs/review/03-fold.md` (M1 weak invariant, Lows L1/L2).

## Problem

The `assistant.message` handler in `packages/core/src/fold.ts` paired reasoning
with the message only via the *live* placeholder (`prevThought`). On reload,
`getEvents()` contains **no** `assistant.reasoning*` / `message_*` events, so the
placeholder is never built, `prevThought` is `undefined`, and the handler never
read the reasoning text that **is** persisted on the final message as
`data.reasoningText` (~50% of real messages carry a non-empty one: 9,440 / 18,916).
Result: a user who watched the model think live saw the answer **without the
thinking** after any reconnect/reload — a `live == replay` invariant break.

## Change — `packages/core/src/fold.ts` (`assistant.message` handler)

`fold.ts:529-552`. When there is no `prevThought`, fall back to the persisted
reasoning text, and use the resulting `thought` everywhere `prevThought` was used:

- `fold.ts:538-540` — new fallback:
  ```ts
  const persistedThought = typeof d.reasoningText === 'string' && d.reasoningText.trim()
    ? d.reasoningText : undefined;
  const thought = prevThought ?? persistedThought;
  ```
  `d.reasoningText` is untyped (`d` is `Record<string, unknown>`), so it is narrowed
  with the same `typeof … === 'string'` guard already used for `content` — no
  `sdk-types` change, no cast.
- `fold.ts:543` — empty-byline guard now tests `!thought` (was `!prevThought`), so a
  message that is purely reasoning (no content/tools/attachment) is no longer
  skipped on replay.
- `fold.ts:549` — final spread emits `...(thought ? { thought } : {})`.

This makes replay reconstruct the reasoning the user saw live. The sub-agent path
is fixed for free — the inner card's `subMessages` are produced by the same
`foldEvent`, so `reasoningText` on a nested `assistant.message` rebuilds the inner
`thought` too.

**Exact-equality caveat (from the report):** live accumulates `thought` from
`assistant.reasoning` segments (joined with `\n\n`), whereas `reasoningText` is the
SDK's own final rendering. The fix (and the tests) assert the reasoning is
**present and correct** against the `reasoningText` value — the user-visible
property the invariant protects — not byte-identity with the live `\n\n`-joined
string. The message **id** still differs (live keeps the `stream-…` placeholder,
replay uses the real `messageId`); per the report this is benign (the store
replaces the whole window atomically on reload, so the id is never user-visible),
so the tests assert on the projected user-visible fields, not the id.

## Tests added — `packages/core/src/fold.test.ts`

New "D1" section after the M2 test, plus a `liveProjection()` helper that reads the
existing `live().client` map in first-upsert insertion order (the projection M1
asked to actually assert):

1. **`D1: streaming reasoning survives reload`** (headline) — live =
   `turn_start, reasoning_delta, reasoning, message_start, message_delta,
   assistant.message{content, reasoningText}`; replay = `turn_start,
   assistant.message{content, reasoningText}`. Asserts
   `replay.messages[0].thought === reasoningText` (fails pre-fix), and live thought
   == replay thought, content == content.
2. **`D1: pure streaming (no reasoning) reloads identically`** — regression lock:
   `message_start`/`message_delta`×2/final with no reasoning; both sides one
   message, no `thought`, same id/content.
3. **`D1: multi-segment reasoning reload`** — two `reasoning` segments live; replay
   uses the combined `reasoningText` (`first…\n\nsecond…`); asserts both segments
   present after reload and live thought == replay thought.
4. **`D1: sub-agent streaming reload`** — inner sub-agent streams reasoning+content
   live; replay nests only the final inner `assistant.message{reasoningText}` under
   the card; asserts `card.subMessages[0].thought` is rebuilt (fails pre-fix) on
   both live and replay.

(Report tests 2/3/5 of its list correspond to suites 1–4 here; the report's
"pure streaming" lock and "multi-segment" are both included.)

## Verification

- `pnpm --filter @cockpit/core test` → **PASS**:
  `tests 141 | pass 141 | fail 0 | cancelled 0 | skipped 0` (was 137; +4 D1 tests).
  All four `D1:` cases pass with the fix.
- `pnpm --filter @cockpit/core regress` → **PASS**:
  `=== 54 sessions | 19189 msgs | 0 fold errors | 0 invalid | 123 subagent cards ===`.
  The fallback now folds `reasoningText` on real logs and every resulting
  `ChatMessage` still validates against the protocol schema (0 invalid).

## D2 / L1 / L2 disposition (deferred — documented, not fixed here)

These are out of the D1 fix scope; per the report they are unreachable on today's
data or persistence-rooted, and fixing them now risks regression for no live
benefit. Recorded as follow-ups:

- **D2 — cancelled partial bubble vanishes on reload.** Persistence-rooted, not a
  fold defect: a cancelled turn emits no final `assistant.message` and streaming
  deltas aren't persisted, so replay legitimately omits the partial. Defensible
  (nothing was committed). Not changed. A pin-test could document it later.
- **L1 — position-dependent fallback ids non-idempotent** (`u-${messages.length}`
  etc.). **Unreachable today**: all real events carry an `id`. A double-pass
  idempotency assertion / id-less-event normalization is the right hardening but is
  deferred to avoid touching the fallback paths now.
- **L2 — empty-`reasoningId` multi-segment collision** (`seg-${messages.length}`
  collides within a turn). **Unreachable today**: live reasoning carries an id and
  persisted logs have no reasoning events. Proper fix is a per-turn monotonic
  segment counter (reset in `resetTurn`); deferred for the same reason.

Scope honored: only `packages/core/src/fold.ts` and
`packages/core/src/fold.test.ts` were modified. No git/server/deploy actions taken.
