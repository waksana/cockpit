# Cockpit global review — master index

> Historical, pre-modernization review. Its SDK, governance, memory-policy and
> authentication descriptions are not the current deployment. See the
> [2026-09-08 final foundation review](2026-09-08-foundation.md) for that dated
> release's conclusions and evidence. Current source contracts and paused work
> are distinguished from deployment in the [foundation document](../cockpit-plan.md#source-status).

A coordinated, whole-codebase review of cockpit (≈14.3k lines of TS/TSX). The
architecture was divided into 7 modules; each was reviewed in its own dedicated
session against the durable invariants (backend-owns-state / frontend pure
projection, live==replay, the SDK-internals contract, the R1 anti-fork-bomb rule,
upload/XSS hardening). Reviews were **read-only** — no source was changed.

This index synthesizes the per-module reports. The cross-cutting themes are the
highest-value part: each was corroborated independently by two or more reviewers.

> **Read [Pass 2 — deep verification](#pass-2--deep-verification) (bottom) for the
> verified verdicts.** A serial second pass re-tested the riskiest findings against
> the real SDK bundle + logs: it **refuted** the Engine-eviction catastrophe,
> **confirmed** the prefs fork-bomb with a working repro, and **upgraded** the fold
> to a real `live==replay` break (reasoning dropped on reload). Pass 2 supersedes the
> Pass-1 severities below where they differ.

## Module reports

| # | Module | Scope | Health | Highest sev | Report |
|---|--------|-------|--------|-------------|--------|
| 1 | Protocol contract | `packages/protocol` | Good | High×1 | [01-protocol.md](01-protocol.md) |
| 2 | Core: Engine & SDK bootstrap | `engine/bootstrap/sdk-types` | Good, fragile seams | High×1 | [02-engine.md](02-engine.md) |
| 3 | Core: Fold | `fold.ts` (+test) | Strong (clean on 34 real logs) | Medium×1 | [03-fold.md](03-fold.md) |
| 4 | Core: Orchestration & persistence | flows/hooks/schedule/attention/prefs/mcp-config/memory | Strong | High×1 | [04-orchestration.md](04-orchestration.md) |
| 5 | Server transport | `apps/server` | Disciplined | High×1 | [05-server.md](05-server.md) |
| 6 | MCP server | `apps/mcp` | Good | High×1 | [06-mcp.md](06-mcp.md) |
| 7 | Web frontend | `apps/web` | Strong | Medium×4 | [07-web.md](07-web.md) |

## Severity rollup

- **Critical: 0** across the entire codebase. The two designed-for risks — fold
  `live==replay` divergence and upload path-traversal/stored-content XSS — both
  held: the fold replays clean on 34 real sessions / 18.6k messages (0 errors / 0
  invalid), and `MessageBody` is XSS-safe by construction (react-markdown v10, no
  `rehype-raw`, URL transforms strip dangerous protocols).
- **High: 5** — one in each of Protocol, Engine, Orchestration, Server, MCP.
- The rest are Medium/Low; most are defensive or single-operator-trust-model edges.

## The 5 High findings

1. **Engine eviction vs background sub-agents** — `engine.ts:452-471,508-565` — the
   heap-watchdog/LRU eviction and manual unload/reload gate only on
   `status==='running'` and ignore `activeSubagents>0`, but an *idle* session can
   have in-flight background `task` sub-agents. Evicting it zeroes the count and can
   let a pending graceful restart `exit(0)` and **kill that background work** — the
   exact thing `inflightTasks` exists to prevent. (Module 2)

2. **Non-atomic prefs write can wipe the R1 safety state** — `prefs.ts:75-98` —
   `save()` writes in place (no tmp+rename) and `load()` silently returns `empty()`
   on any parse error, so a truncated/locked file makes the next save overwrite all
   butler state, including `spawnedBySession`/`welcomedSessions`. Losing those
   re-opens the **fork-bomb** R1 was built to stop. (Module 4)

3. **Whole route surface trusts nginx for auth** — `apps/server/src/index.ts:22,158,465` —
   the server binds loopback with **no in-process auth** while `/intent/*` exposes
   destructive/RCE-capable ops (`session/purge`, `prompt`, `flow/write-gate`,
   `flow/run`) and `/admin/restart`. One nginx misconfig or an un-proxied new path =
   full host compromise; no defense-in-depth. (Module 5)

4. **`cockpit_upload_file` is an exfiltration primitive** — `apps/mcp/src/tools/files.ts:54-78` —
   reads *any* host-readable absolute path (`~/.ssh/id_rsa`, `session-store.db`,
   token-bearing prefs) and republishes it at a web-reachable `/uploads/<name>` URL,
   with the documented 25 MB cap not enforced MCP-side (OOM risk). (Module 6)

5. **`session/patch` cannot clear optional-but-non-nullable fields** — `packages/protocol/src/index.ts:439-443` —
   `currentReasoningEffort`/`currentContextTier`/`currentMode` are `.optional()` but
   not `.nullable()`, so a patch can't express "clear", and the Engine already
   silently omits them (`engine.ts:880`) → a **stale reasoning effort** persists
   across a model switch and any direct consumer (MCP `get_session`, a 2nd device)
   reads a wrong value. (Module 1)

## Cross-cutting themes (independently corroborated — fix these first)

### T1. One "busy" definition, two divergent copies  *(M2 + M5)*
The graceful-restart gate (`apps/server/src/index.ts:67` — counts
`running || awaitingChoice || activeSubagents>0 || compacting`) and the Engine's
eviction/unload filters (`engine.ts:456,516,562` — only `running`/`compacting`)
encode the same concept differently. The drift **is** High finding #1.
→ Factor a single `engineSessionBusy(st)` predicate in `packages/core`, consume it
in both the restart gate and every teardown path so they cannot diverge again.

### T2. Persistence durability is a *safety* property, not a UX nicety  *(M4 + M2)*
R1's anti-fork-bomb guarantee is only as durable as `cockpit-prefs.json`. High #2
is the seam: `spawnedBySession`/`welcomedSessions` are the sole barrier between a
restart and a spawn storm.
→ Atomic write (`tmp` + `renameSync`); on a load parse-failure preserve the corrupt
file and surface it loudly instead of silently resetting to `empty()`.

### T3. Contract invariants live in code, not in the shared schema  *(M1 + M4 + M6 + M5)*
"Exactly one of (interval|cron|at)", "exactly one of (flowId|promptTemplate)",
basename/no-path-traversal, and `confirm`-gating are all re-checked in Engine/MCP
code rather than encoded in the zod contract both ends validate against. Each is a
single-sided defense: a new caller (or the documented loopback fallback) that skips
the hand guard inherits the bug.
→ Push these into the protocol with `.superRefine()` / basename regex
(`packages/protocol/src/index.ts`), so the boundary enforces them for free; mirror
`confirm`/`force` on the destructive *intents* (not just the MCP wrappers).

### T4. Defense-in-depth is thin under the single-user trust model  *(M5 + M6 + M1)*
Auth (T3-adjacent), `confirm`, and path-traversal protection each hold at exactly
one surface and are bypassable from another (loopback intents, a moved nginx path).
Acceptable for a single-operator localhost deployment, but worth making explicit and
cheaply hardening: a shared-secret header from nginx on `/admin/*` + `/intent/*`,
schema-level basename guards, and a documented statement that `confirm` is an
agent-facing latch, not a server gate.

### T5. The optional-vs-null / `undefined`-serialization edge recurs  *(M1 + M2 + M7)*
Three faces of one issue: the protocol can't express "clear" (High #5); the Engine
reverts fields to `undefined`, which `JSON.stringify` drops so the revert never
reaches the client (`engine.ts:899`); and the web store *invents* `lastActivity`
client-side (`net/store.ts:294`) — a genuine pure-projection leak that desyncs
sidebar ordering across devices.
→ Make clearable fields `.nullable().optional()` and emit explicit `null`; never
synthesize server-owned state on the client.

### T6. The riskiest logic is the least tested  *(M1 + M2 + M3 + M7)*
The pure helpers are densely covered (core: 137 tests; uploads: 11; MCP
`cappedJson`: 6), but the **integration seams** are not: `engine.ts` (1889 lines)
has zero direct tests; the fold's `live==replay` is asserted weakly (the live
`client` projection is built but never asserted, and streaming/reasoning events
don't exist in the replay logs, so that path is effectively unverified); `apps/web`
and `packages/protocol` have no tests at all.
→ Add (a) an Engine suite with a fake SDK manager covering eviction-vs-subagents,
prompt/cancel, queue round-trip; (b) a fold test that asserts an ordered
reconstruction of the live `client` map equals `replay().messages` for a
streaming+reasoning+sub-agent turn; (c) a protocol fixture suite; (d) a web
store-reducer suite (idempotent re-feed + reconnect-merge).

## Suggested fix priority

1. **High #2 + T2** — atomic prefs write (safety-critical: fork-bomb re-enabler, data loss). Cheap.
2. **High #1 + T1** — shared `engineSessionBusy` predicate; exclude `activeSubagents`/`awaitingChoice` from eviction & unload.
3. **High #5 + T5** — make clearable `SessionMeta` fields `.nullable().optional()`, emit `null`; drop client-synthesized `lastActivity`.
4. **High #3 + T4** — audit nginx coverage for every path; add a nginx→server shared-secret on `/admin/*` + `/intent/*`.
5. **High #4** — `stat`-then-refuse oversized reads in `cockpit_upload_file`; document the exfiltration consideration; ensure `/upload` enforces its own size cap.
6. **T3** — encode one-of / basename / confirm invariants in the protocol schema.
7. **T6** — the four targeted test suites, starting with the Engine eviction case (would have caught High #1) and prefs corruption (would have caught High #2).
8. Module-local Mediums: `assertSdkContract` session-method coverage (M2), soft-delete orphaned schedules/sub-agents (M2), `removeQueued` drops non-message queue items (M2), rename-dialog Enter stale closure (M7), MCP/Skills optimistic toggle (M7), `cockpit_rewind_session` unreachable `toMsgId` (M6).

---

# Pass 2 — deep verification

Pass 1 (above) was a broad parallel sweep. Pass 2 re-examined the riskiest
findings **serially** (3 dedicated sessions at a time, ≤3 concurrent to bound
memory), each tasked to *verify or refute* a specific claim with concrete evidence
— reading the cited code, the installed `@github/copilot@1.0.63` SDK bundle, and
the real `events.jsonl` logs, and constructing throwaway `/tmp` harnesses that
exercise the **real** modules. 9 deep reports in [`deep/`](deep/).

| Deep task | Target | Verdict | Report |
|---|---|---|---|
| Engine lifecycle | High #1 catastrophe | **Refuted as stated**, downgraded + 1 new bug | [deep/dr-engine-lifecycle.md](deep/dr-engine-lifecycle.md) |
| Prefs durability | High #2 | **Confirmed** (working repro) | [deep/dr-prefs-durability.md](deep/dr-prefs-durability.md) |
| Fold streaming | M3 (fold) | **Upgraded — invariant actually broken** | [deep/dr-fold-streaming.md](deep/dr-fold-streaming.md) |
| Engine turn/queue | stuck-running + queue | Stuck-running **refuted**, queue **confirmed + worse** | [deep/dr-engine-turn.md](deep/dr-engine-turn.md) |
| Engine subagents | High #1 + accounting | **Confirmed** + real leak in logs | [deep/dr-engine-subagents.md](deep/dr-engine-subagents.md) |
| Server security | High #3 | **Confirmed + sharpened** + new CSRF | [deep/dr-server-security.md](deep/dr-server-security.md) |
| MCP security | High #4 | **Confirmed** read side, cap-claim **refined** | [deep/dr-mcp-security.md](deep/dr-mcp-security.md) |
| Web projection | M7 cluster | Projection leak **confirmed**, XSS **safe**, off-origin **refuted** | [deep/dr-web-projection.md](deep/dr-web-projection.md) |
| Protocol hardening | High #5 / T3 / T5 | **Confirmed** → full hardening spec | [deep/dr-protocol-refine.md](deep/dr-protocol-refine.md) |

## What changed after deep verification

**The single most important new defect — the fold actually violates `live==replay`.**
Pass 1 rated fold a Medium ("the streaming/reasoning path is untested"). Pass 2
*proved it is broken*: a reasoning turn reloads **without its `thought`** — yet the
reasoning text **is** persisted (`data.reasoningText` is present on **9,440 / 18,916**
real `assistant.message`s, ~50%). The `assistant.message` fold handler
(`fold.ts:529-543`) never reads it, so on every reconnect/reload the user sees the
answer with the thinking silently stripped. **This is a one-line, in-fold fix**
(fall back to `d.reasoningText` when there is no live `prevThought`). Both first-pass
Lows (non-idempotent positional fallback ids; empty-`reasoningId` segment collision)
were reproduced by direct construction. → **Upgrade to High; cheap fix.**

**A genuine cross-session disagreement, resolved.** The *lifecycle* reviewer
**refuted** High #1's catastrophe: SDK 1.0.63 **defers `session.idle` while
`hasRunningAgents()`**, so a session with *live* background sub-agents stays
`status:'running'` and is never an eviction victim. The *subagents* reviewer
**confirmed** High #1 and found, in real logs, **1 of 124** `task` starts with no
matching completion — a **count leak with no reaper**. Reconciliation: deferral
protects *live* work (so eviction cannot kill a running sub-agent today), but a
*leaked/never-completing* task is the only way to reach `idle && activeSubagents>0`
— and by then the sub-agent is already gone, so eviction destroys nothing live.
**Net:** the "eviction kills background work" catastrophe is **downgraded to Low /
latent** (it relies on an undocumented SDK timing guarantee), while two *real*
residues remain: a **missing leak reaper** (sweep `inflightTasks` older than N
minutes) and a **newly-found hole — `unload()`/`reload()` don't guard `compacting`**
(`engine.ts:562,573`), so a graceful restart can `exit(0)` mid-manual-compaction.
The recommended **shared `engineSessionBusy` predicate** fixes both and remains the
right move (now as defense-in-depth + correctness, not catastrophe-prevention).

**Revised status of the 5 Highs:**

1. **Engine eviction (High #1) → Low/Medium + 2 real sub-bugs.** Catastrophe
   refuted (SDK idle-deferral); keep the shared predicate; **add a leak reaper**
   and **fix the `compacting` hole in unload/reload**.
2. **Prefs durability (High #2) → CONFIRMED, top priority.** Reproduced
   end-to-end with the real `Prefs` class: a truncated file → `load()`→`empty()` at
   restart wipes `spawnedBy`/`welcomed`, flipping `firstTurnEligible` **false→true**
   (R1 fork-bomb re-armed); the next `save()` makes it unrecoverable. Fix: atomic
   `tmp`+`rename`, preserve-corrupt (`*.corrupt-<ts>`), fail loud for safety fields.
3. **Server trust boundary (High #3) → CONFIRMED + sharpened.** `prompt` is not
   "RCE-capable" but **direct arbitrary code execution** as the operator (every
   session runs `APPROVE_ALL_PERMISSIONS`, `engine.ts:328`). **New: CSRF** — with no
   in-process auth, a cross-origin `text/plain` form POST carrying the operator
   cookie reaches every **bodiless** side-effecting intent + `/admin/restart`
   (forced-restart DoS); body-bearing intents are only *accidentally* protected (zod
   rejects the string body / a JSON body would preflight). **SSE backpressure**
   confirmed and **upgraded**: `push.ts` buffers unboundedly for a slow client and
   it is the one heap-growth path the OOM watchdog **cannot see**. Fix:
   nginx→server shared-secret **and** an `Origin`/`Referer` check on side-effecting
   routes; SSE high-water-mark → drop-oldest/disconnect; connection cap.
4. **MCP upload exfil (High #4) → CONFIRMED (read side) + REFINED.** Arbitrary
   host-readable path → web-reachable `/uploads/<rand>` with zero confinement: real.
   But the 25 MB cap **is** authoritatively enforced server-side (`bodyLimit`), so
   the OOM-via-publish sub-claim is **refined away** (only MCP-process memory).
   First-pass framings corrected: `confirm`-gating is **consistent** (gates exactly
   the 3 irreversible ops) and the basename guard is **airtight** (all traversal
   classes incl. `\n`). **New:** a flow's `gate.script` is an **unconfined arbitrary
   executable spawn** primitive — the real under-reported risk, masked by the
   well-guarded `write_gate`.
5. **Protocol clear-field (High #5) → CONFIRMED + systemic (T5).** It also bites
   the **success path** of a normal model switch (`undefined` patch fields dropped by
   `JSON.stringify`, leaving a stale reasoning-effort/context-tier badge), not just
   error-rollback. Deep pass delivered a full **schema-hardening spec**
   ([deep/dr-protocol-refine.md](deep/dr-protocol-refine.md)): `.nullable()` the
   clearable fields + emit `null`; `.superRefine()` the three exactly-one-of bodies;
   basename `.regex()`; `.url()` on `push/subscribe.endpoint`; + a fixture suite.

**Other notable deep findings (beyond the 5 Highs):**

- **Queue mutation is the most fragile path in the engine.** `removeQueued` clears
  the *entire* SDK queue (messages + immediate steering queue + hidden non-message
  items) and rebuilds via `enqueueUserMessage` — which is **`private` in the SDK
  `.d.ts`** (`sdk/index.d.ts:13893`) and reached with optional-chaining, so an SDK
  rename makes the rebuild a silent no-op → **removing one item wipes the queue**.
  The positional `q-<i>` id race is reproducible (delete A then B → deletes A then
  C). `cancel` never drains the SDK pending queue, so a cancelled-before-start
  prompt **resurrects** on the next send. (`dr-engine-turn.md`)
- **`assertSdkContract()` guards zero of the per-session methods** the engine calls
  at runtime (it checks bootstrap symbols only) — including the `private`
  `enqueueUserMessage` and the `@deprecated getPendingQueuedMessages`. The "fail
  fast on an SDK move" promise doesn't cover the surface most likely to move.
  (`dr-engine-subagents.md`)
- **Failed turns never surface as `status:'error'`.** The SDK swallows agentic-loop
  errors into a `session.error` event and still emits `session.idle`, so the
  optimistic `running` clears (good — stuck-running refuted) but `onLive` ignores
  `session.error`, projecting a failed turn as a normal "ready". (`dr-engine-turn.md`)
- **Web is XSS-safe by construction** (react-markdown v10, no `rehype-raw`, raw HTML
  downgraded to text, `defaultUrlTransform` strips dangerous URLs) and the
  AttachmentView "off-origin url" worry is **refuted** (the fold enforces a
  `/uploads/` same-origin allowlist, `fold.ts:194`). The one real projection leak is
  `lastActivity` synthesized on the client (`store.ts:294`) while the server already
  computes the authoritative value (`engine.ts:762`) — fix is to **forward it**, not
  invent it. Plus a real rename-dialog Enter **stale-closure**. (`dr-web-projection.md`)

## Revised fix priority (after Pass 2)

1. **Prefs atomic write (High #2 / T2)** — safety-critical (fork-bomb re-enabler + data loss); cheap, self-contained.
2. **Fold `reasoningText` fallback (new High)** — one line restores `live==replay` for reasoning; add the streaming/reasoning fixture tests that prove it.
3. **Protocol `.nullable()` + emit-`null` (High #5 / T5)** — fixes the stale model-badge on the *success* path; drop client-synthesized `lastActivity` (forward the server's).
4. **Shared `engineSessionBusy` predicate (High #1 / T1)** + **leak reaper** + **`compacting` guard on unload/reload** — defense-in-depth + two real correctness fixes.
5. **Server defense-in-depth (High #3 / T4)** — nginx→server shared secret **and** `Origin`/`Referer` check on side-effecting routes (kills CSRF too); SSE high-water-mark + connection cap.
6. **Queue path hardening** — migrate off `private enqueueUserMessage` / `@deprecated getPendingQueuedMessages`; make `removeQueued` fail *closed*; stable (non-positional) queue ids; drain the SDK queue on `cancel`.
7. **MCP** — `stat`-then-refuse + path-allowlist on `cockpit_upload_file`; treat `gate.script` as the privileged primitive it is (document/confine the spawn).
8. **Schema-level invariants (T3)** — the exactly-one-of / basename / url refinements from the protocol spec; extend `assertSdkContract` to the session method surface.
9. **Tests (T6)** — the four suites, led by: fold reasoning `live==replay`, engine eviction-vs-subagents + queue round-trip, prefs corruption, protocol fixtures.

## Review method (for reproducibility)

- **Pass 1:** 7 dedicated cockpit sessions (one per module), autopilot,
  `claude-opus-4.8`, each booted with the `cockpit` skill (web also
  `cockpit-frontend`), scoped to its files, told to cite `file:line`, run its
  module's tests read-only, and write its report here.
- **Pass 2:** 9 deep sessions run **serially in 3 waves of 3** (bounded to ≤3
  concurrent for memory), each tasked to verify/refute one specific claim against
  the code + the installed SDK bundle + real `events.jsonl` logs, building throwaway
  `/tmp` harnesses over the *real* modules (deleted after). Reports in `deep/`.
- Verification facts: core suite 137 pass; `regress` 34 sessions / 18.6k msgs / 0
  errors; uploads 11 pass; MCP `cappedJson` 6 pass; fold 26 pass; zod behaviors
  checked against `zod@3.25.76`; SDK shapes against `@github/copilot@1.0.63`.
- All review sessions were left **idle/unloaded** for inspection (named
  `Review N · …` / `Deep · …` in the sidebar). Trash them when done. **Reviews were
  read-only — no source was changed.**
