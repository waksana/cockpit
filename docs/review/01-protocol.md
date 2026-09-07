# Module 1 — Protocol contract

## Summary

The contract is in good shape: the `ServerEvent`/`FlowAction` discriminated unions are sound,
the `session/patch = SessionMeta.partial()` derivation is the right "add-a-field-is-free" design,
and the optional-vs-null discipline on `SessionMeta`'s clearable runtime fields
(`ask`/`planRequest`/`elicitation`/`todo`/`intent`/`attention`) is correctly `.nullable().optional()`.
The biggest risk is the **flip side of that discipline**: fields that are `.optional()` but *not*
`.nullable()` (notably `currentReasoningEffort`) **cannot be cleared through a patch**, and the
Engine already silently omits them (engine.ts:880) — so a stale value persists across a model switch.
Secondary risks are validation completeness: the file has essentially **zero `.refine`s and one
`.min()`**, so documented "exactly one of…" invariants and safety-critical "basename only / no path
traversal" rules live in comments and in scattered Engine code rather than in the shared schema that
both ends are supposed to enforce. There are **no tests** in the package.

## Findings

### [High] `session/patch` cannot clear optional-but-non-nullable fields — `packages/protocol/src/index.ts:439-443, 546`
- **What** `SessionMeta` declares `currentModelId`, `currentReasoningEffort`, `currentContextTier`,
  `currentMode`, and `availableModels` as `.optional()` but **not** `.nullable()`. `session/patch` is
  derived as `SessionMeta.partial()`, where patch semantics are "present = set, absent = unchanged."
  There is therefore **no way to express "clear this field"** in a patch: omission means "leave it",
  and an explicit `null` is rejected (verified: `z.string().optional().safeParse(null)` → fails — the
  documented cockpit gotcha). The Engine confirms it hits exactly this wall: when switching to a model
  with no reasoning effort it *omits* the field from the patch
  (`engine.ts:880: ...(reasoningEffort !== undefined ? { currentReasoningEffort } : {})`), so the
  previous effort stays stuck in `SessionMeta`.
- **Why it matters** After switching from a reasoning model to a non-reasoning one, `currentReasoningEffort`
  (and analogously `currentContextTier`/`currentMode`) carries a **stale value** that the contract makes
  un-clearable. The UI hides the effort control for such models, masking it visually, but any consumer
  reading the field directly — the cockpit MCP's `cockpit_get_session`, future logic, another device's
  projection — sees a wrong value. This is precisely the optional-vs-null + patch-derivation intersection
  this module owns, and it is a silent-drift bug by construction.
- **Recommendation** Make the runtime-mutable, can-go-absent fields `.nullable()` (in addition to
  `.optional()`), e.g. `currentReasoningEffort: z.string().nullable().optional()`. `partial()` preserves
  nullability, so the patch can then carry an explicit `null` to clear (verified:
  `z.object({error:z.string().nullable()}).partial().safeParse({error:null})` → succeeds), matching how
  `error`/`ask` already clear. Then have the Engine emit `null` instead of omitting.

### [Medium] "Exactly one of…" invariants are not enforced by the schema — `packages/protocol/src/index.ts:163-173, 284-296, 814-826, 839-849, 900-912`
- **What** Several schemas document a mutual-exclusion invariant but encode every alternative as an
  independent `.optional()`, so a body with **none** or **several** of them passes validation:
  - `schedule/add` (814) — "exactly one timing kind" but `interval`/`cron`/`at` are all optional.
  - `flow-schedule/add` (900) — "exactly one of flowId/target" **and** one timing kind; none enforced.
  - `hook/add` (839) — needs exactly one of `flowId`/`promptTemplate`; neither required.
  - The server→client `ScheduleEntry` (163) and `FlowScheduleEntry` (284) carry the same loose shape.
  The invariants are instead re-checked in Engine code
  (`engine.ts:1340 'one of interval, cron, or at is required'`, `engine.ts:1602 'a hook needs either a
  promptTemplate or a flowId'`).
- **Why it matters** The contract's stated purpose is that "both ends validate against these, so they
  can't drift." Pushing these invariants into the Engine means a malformed intent passes the shared gate
  and relies on hand-written guards that can drift or be forgotten when a new caller (e.g. another MCP
  path) is added. A hook with neither action, or a schedule with two timing kinds, is currently a
  representable-but-meaningless value.
- **Recommendation** Add a `.superRefine()` to each of the three intent bodies (and ideally the two
  entry schemas) asserting exactly one of the mutually-exclusive keys is set, so the boundary rejects
  it uniformly and both ends get the guarantee for free.

### [Medium] Path-traversal / basename safety is documented in comments, not encoded in the schema — `packages/protocol/src/index.ts:869-885 (flow/add, flow/remove, flow/write-gate)`
- **What** `flow/add` takes `Flow` whose `id` becomes a filename (`~/.copilot/flows/<id>.json`),
  `flow/remove` takes a bare `id`, and `flow/write-gate` takes a `name` that becomes
  `~/.copilot/flows/<name>` (chmod +x). The comments explicitly require "a safe basename (no path
  traversal)", but the schemas are plain `z.string()`. The gate `script` body is likewise unconstrained
  `z.string()`.
- **Why it matters** These ids/names flow to filesystem paths. With the contract imposing no constraint,
  the *only* thing preventing `../../etc/...`-style traversal is Engine-side guarding — the shared
  contract provides zero defense-in-depth for a security-relevant field, contradicting the "both ends
  validate" model. A new caller that forgets the guard is an immediate traversal bug.
- **Recommendation** Constrain the id/name fields with a basename regex
  (e.g. `z.string().regex(/^[A-Za-z0-9._-]+$/)` and reject `.`/`..`) at the schema level so traversal is
  rejected at the boundary regardless of which path-handler runs.

### [Medium] Pervasively loose content validation; only one `.min()` in the whole contract — `packages/protocol/src/index.ts:581, 604, 621, 817`
- **What** The file has exactly one length constraint: `schedule/add.prompt: z.string().min(1)` (817).
  Yet semantically non-empty inputs accept empty strings — `prompt.text` (604), `session/rename.name`
  (621), `session/new.cwd` (581). The single `.min(1)` makes the omission look deliberate elsewhere when
  it is most likely just inconsistent.
- **Why it matters** An empty `prompt.text` enqueues a blank turn; an empty `session/rename.name` can
  blank a title; an empty `cwd` starts a session in an undefined location. These reach the Engine as
  "valid." Low individual severity but a systematic gap in a contract whose job is to be the validation.
- **Recommendation** Apply `.min(1)` (and `.trim()` where appropriate) to the handful of fields that
  must be non-empty, matching the one place that already does.

### [Low] Documented enums modeled as free `z.string()` — `packages/protocol/src/index.ts:341 (McpServerSession.status)`
- **What** `status` is commented as a fixed set (`connected | failed | needs-auth | pending | disabled |
  not_configured`) but typed `z.string()`. It is server→client, so blast radius is small, but the
  contract loses the type-safety that would catch an Engine typo at the boundary and would give the
  frontend an exhaustive union to switch on.
- **Why it matters / Recommendation** Promote to `z.enum([...])`. Same applies anywhere a comment
  enumerates the legal values of a string field.

### [Low] `PushSubscriptionJson` is `.passthrough()` with an unvalidated `endpoint` — `packages/protocol/src/index.ts:572-576, 704-707`
- **What** This is a **client→server** body (`push/subscribe`). `endpoint` is `z.string()` (not `.url()`/
  https-constrained) and `.passthrough()` retains arbitrary extra keys. The server later POSTs to that
  endpoint for Web Push.
- **Why it matters** An unconstrained, attacker-influenced URL used as a fetch target is SSRF-adjacent;
  `.passthrough()` keeps unknown fields verbatim. The `web-push` library mitigates in practice, but the
  contract could and should narrow it.
- **Recommendation** Constrain `endpoint` (at least `z.string().url()`, ideally https-only) and drop
  `.passthrough()` in favor of the explicit `endpoint`/`expirationTime`/`keys` shape.

### [Low] `ChatMessage` is a hand-maintained interface paralleling its `z.lazy` schema with no parity check — `packages/protocol/src/index.ts:80-108`
- **What** Because the schema is recursive (`z.lazy`), a manual `interface ChatMessage` is declared
  alongside the schema. They currently match field-for-field, but nothing enforces that — adding a field
  to one and not the other drifts the inferred type from the validator silently.
- **Why it matters / Recommendation** Recursive lazy schemas legitimately need the manual annotation, but
  a compile-time assertion (e.g. a `satisfies`/type-equality test asserting
  `z.infer<typeof ChatMessage>` ≍ `ChatMessage`) would lock the two together. This is the one place in the
  file where the "schema is the single truth" property is not structurally guaranteed.

## Test coverage assessment

**There are no tests in `packages/protocol` at all** (no `*.test.ts`; the package only builds with `tsc`).
For the one schema both ends import and validate against, this is a real coverage gap. Worth adding a
small, high-value fixture suite — it would have caught (or would document) several findings above:
- a representative `SessionMeta` round-trips, and a `session/patch` with `error:null` validates while a
  patch trying to clear `currentReasoningEffort` is shown to be inexpressible (locks Finding #1's contract);
- every `ServerEvent` variant and every `Intents` body/result parses a sample payload (catches a future
  union member with a duplicate/missing discriminant);
- the "exactly one of" bodies reject the zero-set and multi-set cases (once the refinements land);
- a type-equality assertion that `z.infer<typeof ChatMessage>` matches the hand-written interface.

## Positive notes

- `session/patch` derived as `SessionMeta.partial().required({ sessionId: true })` is the right design:
  adding a `SessionMeta` field is patchable for free with no parallel field list (index.ts:546).
- Optional-vs-null discipline on the clearable `SessionMeta` fields is correct and deliberate — the
  nullable-and-optional ones (`ask`/`planRequest`/`elicitation`/`todo`/`intent`/`attention`) are exactly
  the ones the Engine needs to clear, and `partial()` preserves their clearability.
- Discriminated unions are sound: `ServerEvent` (533) has nine distinct `type` literals with no overlap,
  and `FlowAction` (249) is a real `discriminatedUnion('kind', …)` rather than a loose optional-pair.
- The schemas are unusually well-commented; intent semantics (e.g. attention/seenId waterline, one-of
  timing kinds) are documented at the point of definition.

## Cross-cutting (brief — noted, not investigated)

- The server validates every intent body via `Intents[name].body.parse(body)` (throws) — good: the
  contract genuinely is the gate (apps/server/src/index.ts:185+). This makes Findings #2–#4 actionable,
  since tightening the schema tightens the live boundary.
- The Engine currently *compensates* for the gaps here: it re-checks one-of timing/action invariants
  (engine.ts:1340, 1602) and omits-rather-than-nulls `currentReasoningEffort` (engine.ts:880). Those are
  the other-module symptoms of this module's contract gaps; left for the core/server reviewers to confirm.
