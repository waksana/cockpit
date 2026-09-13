# Deep: Protocol schema hardening (spec)

> **历史归档，不是当前规范或操作指南。** [当前文档](../../../README.md) · [归档边界](../../README.md) · [原位置固定版本](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/review/deep/dr-protocol-refine.md)。
> 结论、行号、旧路径和环境按原记录理解，未为本次文档整理重新执行其操作。


Scope: `packages/protocol/src/index.ts` only — turn the cross-cutting invariants
the first pass (`docs/review/01-protocol.md`) and the deep passes
(`dr-engine-subagents.md` undefined-serialization §, `dr-prefs-durability.md`)
found scattered in engine/server code into schema refinements, so the one shared
contract enforces them at the boundary. **REVIEW ONLY** — this is a spec, no
source under `packages/`/`apps/` was edited. Every zod behavior asserted below
was checked against the repo's `zod@3.25.76` in a throwaway `/tmp` script
(deleted): the verified facts are inlined as `(verified)`.

## Verdict summary

The contract already gets the load-bearing design right (`session/patch =
SessionMeta.partial().required({sessionId:true})`, `index.ts:546` — "add a field
is patchable for free"), but it leaks four classes of invariant into code:
(1) the M1/T5 root cause — model sub-fields are `.optional()` but **not**
`.nullable()`, so a patch can only "clear" them to `undefined`, which
`JSON.stringify` then drops on the wire (`dr-engine-subagents.md:237-267`),
leaving a stale reasoning-effort/context-tier badge on the **success** path of a
normal model switch; (2) three "exactly one of…" intent bodies whose invariant is
re-checked in dispatch code instead of at the schema gate; (3) two filesystem
basename fields constrained only engine-side; (4) one attacker-influenceable URL
(`push/subscribe.endpoint`) with no shape. All four are fixable with small,
additive zod changes plus the matching engine `emit-null-not-omit` edits, and the
package currently has **zero tests** to lock any of it.

---

## Clearable-fields table

Every `SessionMeta` field, classified by whether the engine ever needs to CLEAR
it (set back to absent). "Clear-site" cites the engine line that today omits or
nulls it. The rule: a field the engine clears **must be `.nullable()`** so the
patch can carry an explicit `null` (which survives JSON and round-trips), and the
engine must **emit `null`, not omit**. Fields never cleared stay `.optional()`
(do **not** over-nullable).

Verified zod facts underpinning the table:
- `z.string().optional().safeParse(null)` → **fails** (verified) — the documented
  cockpit gotcha; an optional-non-nullable field cannot carry `null`.
- `z.string().nullable().optional()` accepts both `null` and `undefined` (verified).
- `SessionMeta.partial()` **preserves** nullability: a partial of
  `{eff: z.string().nullable().optional()}` accepts `{sessionId, eff:null}`
  (verified) but a partial still **rejects** `null` for a non-nullable key
  (`{sessionId, modelId:null}` → fails, verified) — this is exactly the
  over-nullable guard the task asks for.

| Field (index.ts) | Current zod | Engine ever clears it? | Make nullable? | Clear-site(s) |
|---|---|---|---|---|
| `error` :438 | `z.string().nullable()` | yes | already ✓ — no change | set `error:null` on resolve `engine.ts:413,703` |
| `ask` :446 | `AskRequest.nullable()` | yes | already ✓ | `ask:null` on completion |
| `planRequest` :447 | `…nullable().optional()` | yes | already ✓ | cleared on respond |
| `elicitation` :448 | `…nullable().optional()` | yes | already ✓ | `elicitation:null` `engine.ts:700` |
| `todo` :449 | `…nullable().optional()` | yes | already ✓ | refreshTodo null |
| `intent` :455 | `z.string().nullable().optional()` | yes | already ✓ | `intent:null` on idle/cancel `engine.ts:713,866` |
| `attention` :456 | `Attention.nullable().optional()` | yes | already ✓ | `out.attention=att` (att may be null) `engine.ts:1850-1851` |
| **`currentReasoningEffort`** :440 | `z.string().optional()` | **yes** | **YES — required** | setModel **success** `engine.ts:895` (`cur.reasoningEffort` is `undefined` on a non-reasoning model); rollback `:900` (`...prev`, prev built `:875`); load `:415` |
| **`currentContextTier`** :441 | `ContextTier.optional()` | **yes** | **YES — required** | setModel success `engine.ts:896`; rollback `:900`; load `:416` |
| `currentMode` :442 | `AgentMode.optional()` | yes (edge) | **recommended** | setMode rollback `engine.ts:973` (`prev` usually defined); load `:417` if `mode.get()` failed |
| `currentModelId` :439 | `z.string().optional()` | **no** | leave optional* | only ever SET to a real value: `engine.ts:381,386,414,879,894` (`cur.modelId ?? modelId`); never omitted-to-clear |
| `availableModels` :443 | `z.array(ModelOption).optional()` | **no** | **leave optional** | set once on load; no clear-site found (over-nullable guard) |
| `attnId/seenId/scheduleCount/hookCount/activeSubagents` | `z.number().optional()` | monotonic/count — never "cleared" | leave optional | n/a |
| `pinned/compacting/loaded/spawnedBy` | bool/string | toggled to a real value, not absent | leave optional | n/a |

\* `currentModelId` is included as nullable **only if** you adopt the
belt-and-suspenders blanket normalizer (below); on its own it is never cleared,
so leaving it `.optional()` is correct today.

### Exact zod change (the two required + one recommended)

```ts
// index.ts:440-442 — current
currentReasoningEffort: z.string().optional(),
currentContextTier: ContextTier.optional(),
currentMode: AgentMode.optional(),
// → replacement
currentReasoningEffort: z.string().nullable().optional(),   // clearable: non-reasoning model
currentContextTier: ContextTier.nullable().optional(),      // clearable: model w/o long_context
currentMode: AgentMode.nullable().optional(),               // recommended, for the blanket fix
```

`SessionMeta` must stay a plain `ZodObject` (no top-level `.superRefine` — see the
HARD CONSTRAINT in the next section) so `SessionMeta.partial()` at `index.ts:546`
keeps working; `.nullable()` on a leaf is fine and `.partial()` preserves it
(verified).

### Matching engine change (one line each — "emit null, not omit")

These are the consumers that must change in lockstep so the schema relaxation
actually clears the field (consistent with `dr-engine-subagents.md:269-278`):

```ts
// engine.ts:893-897 (setModel success — the visible-bug site)
this.patch(st, {
  currentModelId: cur.modelId ?? modelId,
  currentReasoningEffort: cur.reasoningEffort ?? null,   // was: cur.reasoningEffort (undefined → dropped)
  currentContextTier: cur.contextTier ?? null,           // was: cur.contextTier
});
```

- `engine.ts:880-881` (optimistic pre-switch patch): emit `currentReasoningEffort:
  reasoningEffort ?? null` instead of the `...(x!==undefined?{}:{})` spread, so an
  intent that explicitly *unsets* effort propagates the clear.
- `engine.ts:875-876` + `:900` (rollback `prev`): `prev` must carry `null` for an
  absent effort/tier so the rollback patch clears rather than omits.
- `engine.ts:414-417` (load): pass `?? null` for the four model sub-fields.

**Belt-and-suspenders (kills the whole class, recommended):** in `patch()` right
where `out` is assembled (`engine.ts:1848 const out: Partial<SessionMeta> = {
...fields }`), normalize every `undefined` value to `null` before emit
(`engine.ts:1861`). This requires the corresponding protocol field to be
`.nullable()` — which is precisely why `currentMode` (and, if this is adopted,
`currentModelId`) should also be nullabled, so the normalizer can never produce a
`null` the schema rejects. One change closes every future occurrence.

> Why this is the systemic fix, not cosmetic: server-side `st.meta` is already
> correct (`Object.assign` copies the `undefined`); the bug is purely the wire
> omission (`JSON.stringify` drops `undefined`, `apps/server/src/index.ts:39`) +
> the client's spread-merge keeping the old value
> (`apps/web/src/net/store.ts:236-238`). That is a direct breach of "the frontend
> is a pure projection." Making the field nullable + emitting `null` is the only
> way the projection can be told "this is now absent."

---

## Exactly-one-of refinements

> **HARD CONSTRAINT (verified).** `.superRefine()` returns a `ZodEffects`, which
> has **no `.partial()`** (verified: `z.object({...}).superRefine(...).partial is
> not a function`). Therefore refinements may go **only** on the three intent
> *body* objects below — never on `SessionMeta` (it is `.partial()`-derived for
> `session/patch`) and never on a schema that is later `.partial()`/`.extend()`-ed.
> All three bodies here are terminal `z.object(...)`, so they refine cleanly.

A `.superRefine` that counts the set keys is verified to reject the zero-set and
multi-set cases and accept exactly one (verified). Recommended over a discriminated
union because it **preserves the existing flat wire shape** (callers already send
`interval`/`cron`/`at` as sibling keys); a discriminated union would force a
synthetic tag and a client change. (`FlowAction` at `index.ts:249` is the right
place for a real `discriminatedUnion` — and already is one — because its variants
are genuinely different shapes.)

A small reusable helper keeps the three call-sites uniform:

```ts
const exactlyOne = (obj: Record<string, unknown>, keys: string[]) =>
  keys.filter((k) => obj[k] !== undefined).length === 1;
```

### 1. `schedule/add` — exactly one of {interval, cron, at} (`index.ts:814-824`)

Current (all three independently optional; invariant only in
`engine.ts:1340 'one of interval, cron, or at is required'`):

```ts
'schedule/add': {
  body: z.object({
    sessionId: z.string(),
    prompt: z.string().min(1),
    interval: z.string().optional(),
    cron: z.string().optional(),
    at: z.number().optional(),
    recurring: z.boolean().optional(),
    tz: z.string().optional(),
    displayPrompt: z.string().optional(),
  }),
```

Add after the `z.object({...})`:

```ts
  body: z.object({ /* …unchanged… */ })
    .superRefine((v, ctx) => {
      if (!exactlyOne(v, ['interval', 'cron', 'at']))
        ctx.addIssue({ code: z.ZodIssueCode.custom,
          message: 'provide exactly one of interval, cron, or at' });
    }),
```

Engine note: `engine.ts:1337-1340` keeps its `if/else` dispatch but the
`else return {error:'…required'}` becomes unreachable for the none-case — it can
stay as a defensive fallback.

### 2. `hook/add` — exactly one of {flowId, promptTemplate} (`index.ts:839-847`)

Current (neither required; invariant in `engine.ts:1602 'a hook needs either a
promptTemplate or a flowId'`, which today allows **both**):

```ts
'hook/add': {
  body: z.object({
    ownerSession: z.string(),
    event: SessionEventType,
    filter: HookFilter.optional(),
    flowId: z.string().optional(),
    promptTemplate: z.string().optional(),
    once: z.boolean().optional(),
  }),
```

Add:

```ts
  body: z.object({ /* …unchanged… */ })
    .superRefine((v, ctx) => {
      if (!exactlyOne(v, ['flowId', 'promptTemplate']))
        ctx.addIssue({ code: z.ZodIssueCode.custom,
          message: 'a hook needs exactly one of flowId or promptTemplate' });
    }),
```

Note this is *stricter* than the engine guard (`!promptTemplate && !flowId`),
which permits both-set; the schema should be the authority and reject both. (If
"both" is ever intended to mean "flow with a fallback template," make that explicit
instead of leaving it representable-but-undefined.)

### 3. `flow-schedule/add` — one action AND one timing (`index.ts:900-910`)

Current (two independent one-of invariants, both only in
`flow-schedule.ts:128-131 buildEntry`):

```ts
'flow-schedule/add': {
  body: z.object({
    flowId: z.string().optional(),
    target: InlineScheduleTarget.optional(),
    interval: z.string().optional(),
    cron: z.string().optional(),
    at: z.number().optional(),
    recurring: z.boolean().optional(),
    tz: z.string().optional(),
    label: z.string().optional(),
  }),
```

Add a `.superRefine` enforcing **both** groups (mirrors `buildEntry`'s two checks):

```ts
  body: z.object({ /* …unchanged… */ })
    .superRefine((v, ctx) => {
      if (!exactlyOne(v, ['flowId', 'target']))
        ctx.addIssue({ code: z.ZodIssueCode.custom,
          message: 'provide exactly one of flowId or target' });
      if (!exactlyOne(v, ['interval', 'cron', 'at']))
        ctx.addIssue({ code: z.ZodIssueCode.custom,
          message: 'provide exactly one of interval, cron, or at' });
    }),
```

### Server→client entry schemas (lower priority — engine-produced, trusted)

`ScheduleEntry` (`index.ts:163-173`) and `FlowScheduleEntry` (`index.ts:284-295`)
carry the same loose one-of shape, but they are *emitted by the engine* (a trusted
producer that already constructed them via `buildEntry`), so a boundary refinement
there guards only against an engine bug, not a malicious client. Optional: add the
same `.superRefine` for symmetry/self-documentation, but it is not load-bearing —
prioritize the three intent bodies, which are the untrusted boundary.

---

## Basename + url constraints

### Safe-basename on the three filesystem-bound fields

`flow/add.id`, `flow/remove.id`, and `flow/write-gate.name` all become a path
under `~/.copilot/flows/`. Today the **only** guard is engine-side
`isSafeBasename` (`flows.ts:20-21`, used at `flows.ts:166,180,192`):

```ts
// flows.ts:20-21 (existing engine defense — mirror it in the schema)
export function isSafeBasename(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}
```

The regex `^[A-Za-z0-9][A-Za-z0-9._-]*$` alone is **not** sufficient — verified
that it accepts `a..b` (no separator, but a traversal token), so the `!includes('..')`
half is essential; encode **both** as a reusable schema (verified to reject
`../evil`, `a/b`, `.hidden`, `''`, `a..b` and accept `welcome-flow`):

```ts
const SafeBasename = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a safe basename (no separators/leading dot)')
  .refine((s) => !s.includes('..'), 'must not contain ".."');
```

Apply it:

- `Flow.id` (`index.ts:260`): `id: SafeBasename,` — this is the field
  `flow/add` (`index.ts:872-874 body: Flow`) writes as `<id>.json`.
- `flow/remove` (`index.ts:877`): `body: z.object({ id: SafeBasename })`.
- `flow/write-gate` (`index.ts:884`): `name: SafeBasename` (the `<name>` written
  chmod +x). Keep `script: z.string()` as free content but add `.min(1)` (an empty
  gate script is meaningless).

Engine note: no behavior change — `flows.ts:166,180,192` keep their checks as
defense-in-depth; the schema now rejects traversal at the boundary for **every**
caller (a new MCP path that forgets the guard is covered). This is the
"both ends validate" property the contract promises.

> Out of scope but noted: `GateSpec.script` (`index.ts:228`) is a *path* to an
> owner-authored script, deliberately unconstrained (owner-trust decision,
> documented in the comment); leave it, but a future hardening could confine it to
> the flows dir.

### URL/endpoint constraints

`push/subscribe` (`index.ts:704-707`) carries `PushSubscriptionJson`
(`index.ts:572-576`) whose `endpoint: z.string()` is later used as a server-side
`fetch` target for Web Push — an attacker-influenceable URL with no shape, plus
`.passthrough()` retaining arbitrary keys (SSRF-adjacent; first pass [Low]).

Verified caveat: `z.string().url()` **accepts `file:///etc/passwd`** — so `.url()`
alone is insufficient; add an https-only refine:

```ts
// index.ts:572-576 — replacement
export const PushSubscriptionJson = z.object({
  endpoint: z.string().url().refine((u) => u.startsWith('https://'), 'endpoint must be https'),
  expirationTime: z.number().nullable().optional(),
  keys: z.record(z.string()).optional(),
});   // drop .passthrough() — the three keys above are the whole Web Push shape
```

(verified: this rejects `not-a-url` and `file:///etc/passwd`, accepts
`https://push.example/x`.) Server note: no change to `apps/server` — the body is
already `Intents['push/subscribe'].body.parse(body)`, so tightening the schema
tightens the live gate.

> Adjacent, optional: `Attachment.url` (`index.ts:72`) is server→client and must be
> a same-origin `/uploads/` path (`fold.ts:184`). A `.refine(u =>
> u.startsWith('/uploads/'))` would self-document it, but it is engine-produced
> (trusted) so it is low priority. `McpServer*.detail` is a free-text
> "command/url summary" — leave unconstrained.

---

## Proposed protocol fixture test suite

The package has **no `*.test.ts`** (first pass §"Test coverage"). Add
`packages/protocol/src/index.test.ts` (node:test, matching the repo's
`*.test.ts` + `tsx` convention). High-value cases, grouped:

**A. SessionMeta round-trip & null discipline**
1. A fully-populated `SessionMeta` (snapshot shape) parses.
2. A minimal `SessionMeta` (only the required keys) parses.
3. `SessionMeta` with `null` for each already-nullable field
   (`error/ask/planRequest/elicitation/todo/intent/attention`) parses.
4. `SessionMeta` with `null` for a **non-nullable** key (`title`) is **rejected**.
5. **Snapshot gotcha lock:** `null` for a non-nullable optional (`currentModelId`)
   is **rejected** — encodes "omit absent optionals, don't send null" for snapshots.

**B. `session/patch` — the M1/T5 contract lock** (use
`SessionMeta.partial().required({sessionId:true})`)
6. Patch `{sessionId, error:null}` parses (baseline clearable).
7. **Post-fix:** patch `{sessionId, currentReasoningEffort:null}` parses, and
   `{sessionId, currentContextTier:null}` parses — locks the nullable change.
8. **Over-nullable guard:** patch `{sessionId, currentModelId:null}` is
   **rejected** (proves we did not nullable a never-cleared field).
9. Patch without `sessionId` is **rejected** (required key preserved).
10. **Wire fidelity:** `JSON.parse(JSON.stringify(patch))` of a patch with a
    `null` field keeps the key (vs an `undefined` field, which is dropped) — the
    exact behavior the engine `emit-null` fix relies on
    (`dr-engine-subagents.md:237-242`).

**C. Exactly-one-of (after the refinements land)**
11. `schedule/add` body with **none** of interval/cron/at → reject.
12. `schedule/add` body with **two** (interval+at) → reject.
13. `schedule/add` body with exactly one → accept.
14. `hook/add` with neither flowId nor promptTemplate → reject; with **both** →
    reject; with exactly one → accept.
15. `flow-schedule/add`: valid action but no timing → reject; valid timing but no
    action → reject; both flowId+target → reject; one action + one timing → accept.

**D. Basename / url**
16. `flow/add` (`body: Flow`) with `id` ∈ {`../evil`,`a/b`,`.hidden`,``,`a..b`} →
    each rejected; `id:'welcome-flow'` → accepted.
17. `flow/write-gate` with `name:'../x'` → reject; `name:'gate.sh'` → accept.
18. `push/subscribe` endpoint ∈ {`not-a-url`,`file:///etc/passwd`} → reject;
    `https://push.example/x` → accept.

**E. Union & parity (cheap regression guards)**
19. Each `ServerEvent` variant parses a representative sample (catches a future
    union member with a duplicate/missing `type` discriminant).
20. Each `Intents[name].body` and `.result` parses a representative sample.
21. Compile-time parity: assert `z.infer<typeof ChatMessage>` matches the
    hand-written `interface ChatMessage` (a `satisfies`/type-equality assertion),
    locking the one place the "schema is the single truth" property isn't
    structurally guaranteed (first pass [Low], `index.ts:80-108`).

These directly lock Findings #1–#4 and would fail loudly if a future edit
re-introduced any of them.

---

## Recommended implementation order

1. **Clearable model fields (highest value — fixes a live, user-visible bug).**
   Nullable `currentReasoningEffort` + `currentContextTier` (`index.ts:440-441`);
   engine emit `?? null` at `engine.ts:893-897` (success path — the
   `dr-engine-subagents` N1 High), plus `:880-881`, `:875/:900` rollback, `:414-417`
   load. Add fixture cases B6–B10. Optionally nullable `currentMode`/`currentModelId`
   **and** add the `patch()` blanket `undefined→null` normalizer
   (`engine.ts:1848`) to kill the class permanently.
2. **Exactly-one-of `.superRefine` on the three intent bodies** (`index.ts:814,
   839, 900`) using the `exactlyOne` helper — moves the invariant from
   `engine.ts:1340/1602` + `flow-schedule.ts:128-131` to the shared gate. Cases C11–C15.
3. **`SafeBasename` on flow id/name** (`index.ts:260, 877, 884`) — security
   defense-in-depth mirroring `flows.ts:20-21`. Cases D16–D17.
4. **`push/subscribe.endpoint` → https-only + drop `.passthrough()`**
   (`index.ts:572-576`). Case D18.
5. **Stand up `packages/protocol/src/index.test.ts`** with all of A–E. This both
   closes the 0-test gap and is the regression net that keeps 1–4 from silently
   regressing; case E21 also locks the `ChatMessage` interface/schema parity.

Ordering rationale: #1 is the only item that fixes a symptom a user sees today
(stale effort/tier badge on a normal model switch); #2–#4 are boundary-hardening
that prevent representable-but-meaningless / unsafe values; #5 makes the whole set
durable. All are additive and independently shippable. Cross-refs:
`dr-engine-subagents.md` owns the engine-side emit-null edits for #1;
`dr-prefs-durability.md` is complementary — `hooks`/`flowSchedules` persist to
`cockpit-prefs.json`, so schema validation at the intent boundary also narrows
what can ever be persisted, reinforcing that report's "validate before trust"
theme.
