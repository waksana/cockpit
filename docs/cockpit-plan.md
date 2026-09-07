# cockpit — project plan & roadmap

cockpit is a personal, single-user web console (`https://cockpit.rbym47.com`) to
drive GitHub Copilot CLI agent sessions from any device. It runs the in-process
`@github/copilot/sdk`, with a stateful authoritative backend and a thin React
projection frontend, presented in a Telegram-aligned UI.

This is the single source of truth for **where the project is and where it's
going**. Detailed change history lives in the session checkpoints; design
deviations from Telegram live in [`cockpit-tweb-diff.md`](./cockpit-tweb-diff.md);
the Telegram study notes in [`telegram-study.md`](./telegram-study.md).

---

## Product boundary (owner-approved 2026-09-07)

Cockpit is a **remote Copilot session foundation with a web GUI, API, and MCP,
not the owner of session-governance policy**. Its essential journey is: open the web app, select a session, chat or
control execution, exchange files, leave, and return from another device.

Owner clarification at 15:44 CST: Cockpit is the GUI projection of Copilot's
capabilities, currently a subset, plus capabilities needed for remote graphical
use such as upload/download, attachment presentation, and image preview. Broader
native feature coverage is a direction, not a claim of current complete parity
or a requirement to implement everything at once.

**Priorities:** reliability and correct state, frontend experience (especially
mobile), and dependable image/file exchange take precedence over feature breadth.

- **Core:** session selection and lifecycle controls; chat and streamed output;
  execution controls and approval responses; image/file upload, preview, and
  download; reconnect/history consistency; secure remote access and file boundaries.
- **Not core:** default Cockpit-owned fleet governance, onboarding/outfitting, skill
  mining, multi-layer review, automatic dispatch/reminders, and self-modification. Existing
  automation may remain as an independent extension, but core chat, control, and
  file exchange must work without it. Exposing user-controlled skill/MCP settings
  is distinct from automatically governing those settings across a fleet.
- **Native semantics first:** reuse Copilot's model, skill discovery/on-demand
  loading, configured MCP enablement, and user-invoked agent/automation semantics.
  Configured enabled MCPs being initialized is not itself a Cockpit defect.
  Do not introduce task-inferred outfitting or mandatory pre-birth filtering just
  to differ from the CLI or satisfy a diagnostic fixture.
- **Always available, not always generating:** submitted work should not depend
  on an open browser or SSH connection; completed sessions may wait quietly.
  Host/process failure recovery remains an explicit reliability concern, not a
  promise of uninterrupted execution.
- **Feature admission:** identify the concrete remote-use step a proposed feature
  fixes. Autonomous sophistication alone is not a reason to expand the core.

This boundary supersedes conflicting scope-expansion proposals below. Existing
implementation descriptions are not mandates to retain every feature in the core.
Contraction should be incremental and dependency-aware, not a rewrite or blanket
shutdown. This decision records direction; it does not itself disable flows,
delete sessions, or authorize destructive cleanup.

### GUI, API, and MCP are views of the same capabilities

```text
Human -> Web GUI ---------+
                         +-> Cockpit API/backend -> Copilot runtime
Session -> cockpit MCP --+
```

All externally useful Cockpit operations, including session controls,
cross-session interaction and file exchange, should be accessible through the
backend API. The GUI is the human client; the cockpit MCP is the agent client
and should expose the same domain capabilities. Neither client should maintain
independent business logic or bypass authoritative state/permission/confirmation
handling. Native Copilot execution stays in the runtime; GUI-specific services
such as file storage/presentation belong to Cockpit.

This is a target contract, not a statement that today's GUI/API/MCP coverage is
complete. Record coverage gaps and intentional limitations rather than claiming
parity. Prioritize reliable existing workflows and small missing mappings over
new orchestration policy; local visual gestures need not become separate domain
operations. Broader MCP capability does not bypass authorization for its use.

### Foundation versus upper-layer governance

Owner clarification at 15:49 CST: Cockpit is the foundation on which a user may
build session governance or other applications. Governance is a separate layer,
not forbidden functionality and not a default responsibility of the foundation.

- **Foundation mechanisms:** reliable session lifecycle/execution/state, explicit
  messaging/delegation, file exchange, access controls, and equivalent API/GUI/MCP
  access. Generic scheduling, events, or flow execution may remain optional
  mechanisms where their usefulness justifies maintaining them.
- **Upper-layer policy:** which sessions to create, when to review or harvest,
  what to outfit, who to notify, how to close work items, and when to archive.
  Named governance flow definitions, prompts, schedules, repair manifests and
  ledgers belong to this layer and use the foundation's published APIs/MCP.
- **One-way dependency:** governance depends on Cockpit; Cockpit must remain fully
  usable without governance installed or running. A base install/update/repair
  must not silently reinstall or re-arm an upper-layer governance package.
- **Shared safety boundary:** upper layers may orchestrate authorized operations,
  but may not bypass backend permissions, confirmations, durable state ownership,
  or runtime protection. Removing governance does not remove basic service health,
  restart supervision, or safe session/file persistence.

Separate ownership/configuration and dependencies first. This does not by itself
require another service, repository, microservice architecture, or runtime rewrite.
Retiring specific governance jobs is distinct from deleting generic flow support.

---

## Architecture

**Monorepo** (`~/cockpit`, pnpm workspaces):
- `packages/protocol` — wire types + intents (zod). The one shared contract.
- `packages/core` — Engine: drives the SDK, folds events, owns session state +
  lifecycle (load/unload/reload/delete). `bootstrap.ts` resolves auth + model list.
- `apps/server` — thin transport: `GET /events` (SSE: snapshot then live events),
  `POST /intent/*` (validated intents). Binds `127.0.0.1:8771`; TLS + cookie auth
  at the nginx layer.
- `apps/web` — React + Zustand. **Pure projection**: renders server state, sends
  intents, holds no domain logic. The store is the only consumer; components are
  prop-driven leaves.

**Principle:** the backend is the single owner of all state; its only source is
the SDK. The frontend never holds domain truth — this kills refresh / multi-device
/ "stuck running" / pagination-vs-load consistency bugs.

**Design system:** inherited (not imitated) from Telegram Web K (tweb): real
structural tokens (`styles/tokens.scss` ← tweb `variables.scss`/`base.scss`), the
real `tgico` icon font, component CSS ported near-verbatim; only colors are
overridden (Solarized). Components render tweb's DOM/class contract. See
`cockpit-tweb-diff.md` for the explicit deviation registry. License: GPL-3.0
(tweb is GPL-3.0-only); see `NOTICE.md`.

---

## SDK strategy — internal vs official (decision: migrate, stay Node)

There are **two distinct SDK families**, easily confused. cockpit currently uses
the first; the second is the intended target.

1. **`@github/copilot` `./sdk` subpath** (what cockpit uses today) — the CLI npm
   package's *internal*, **undocumented** surface (`internal.LocalSessionManager`),
   run **in-process / same heap** as cockpit. This is the source of the structural
   OOM: the SDK holds every session's base64 image blocks in cockpit's own V8 heap.
   It also forces the `bootstrap.ts` hand-rolling (passing `autoModeManager`,
   symlinking `sdk/definitions`) and is exposed to `.d.ts`≠runtime drift
   (`assertSdkContract()` guards it). Note: `CopilotClient`/`RuntimeConnection` are
   declared in this package's `.d.ts` but are **`undefined` at runtime here** — an
   earlier probe wrongly concluded the official client was "unavailable"; it was
   looking in the wrong package (see #2).

2. **`@github/copilot-sdk`** (separate, official npm package — the target) — drives
   the Copilot CLI runtime over **JSON-RPC (stdio/TCP) as a SEPARATE child
   process**. Verified 2026-06-19: v1.0.2, deps `@github/copilot ^1.0.64-0` (the
   *same* CLI cockpit already installs) + `vscode-jsonrpc` + `zod`; repo
   `github/copilot-sdk` (public, MIT, ~9.4k★, protocol version 3); one repo
   generates **six languages** — `nodejs/python/go/rust/dotnet/java`, all v1.0.x,
   **feature-parity** (every CHANGELOG entry tagged `[All SDKs]`), CLI auto-bundled
   for Node/Python/.NET. Public `CopilotClient.createSession()` / `sendAndWait()`.

**Decision — migrate cockpit's core from the `./sdk` internal path to
`@github/copilot-sdk`, remaining in Node/TypeScript.** Rationale:
- **Process isolation = the OOM structural fix.** The runtime (and its base64 image
  heap) moves to the child process; cockpit's heap stops growing with image
  history. This is the real fix tuning only buys time for.
- **Documented, versioned public API** replaces the undocumented `internal.*` —
  kills the `.d.ts`≠runtime drift risk and removes the bootstrap hand-rolling.
- **No language rewrite.** Python is **not** more mature — all six SDKs are parity,
  generated together; switching to Python would buy zero maturity and cost a full
  rewrite. Stay in Node to reuse the Engine/protocol/web layers unchanged.

**Status: PoC pending** (do before committing to migration). Zero-risk: a throwaway
dir outside `~/cockpit`, `npm i @github/copilot-sdk`, run the official
`createSession → sendAndWait` sample, and `ps`-verify it spawns a child runtime +
confirm image heap lands in the child, not the parent. Migration itself is a larger
effort gated on that PoC (the Engine's `ensureLoaded`/fold/eviction assume an
in-process `getEvents()` array — JSON-RPC changes that access shape).

---

## Operational notes

- **Build:** `node ./node_modules/vite/bin/vite.js build` (the `pnpm exec` wrapper
  fails a deps-check on an ignored `@parcel/watcher` build script). Backend:
  `pnpm -r --filter @cockpit/protocol --filter @cockpit/core --filter @cockpit/server build`.
- **Deploy frontend:** nginx serves `apps/web/dist` statically — a rebuild is the
  deploy. No server restart needed for frontend-only changes.
- **Deploy backend:** `systemctl --user restart cockpit-server.service` (it's a
  **user** unit running `tsx src/index.ts`; loads TS source directly so a restart =
  deploy, no build step strictly needed). Verify: log `Server listening`, port
  `8771`, `GET /health` → `{ok:true,login:waksana}`. A restart cannot preserve an
  in-flight turn (only event history persists to disk), so deploy when idle — see
  graceful self-restart below.
- **Graceful self-restart (primary):** the server holds an in-memory `restartPending`
  flag. Arm it with `curl -XPOST http://127.0.0.1:8771/admin/restart` (body
  `{"pending":false}` disarms). When the **last** running session goes idle, the
  running→idle hook `process.exit(0)`s (after a 500ms SSE flush) and systemd
  (`Restart=always`, `RestartSec=1`) brings it back, replaying history. This lets an
  agent running *inside* cockpit deploy its own backend change without interrupting
  any turn (including its own): POST the intent, then just finish the turn. `GET
  /status` reports `{running, restartPending, sessions[]}`.
- **Bootstrap restart (only when server predates /admin/restart):**
  `scripts/graceful-restart.sh` polls `/status` (falls back to one SSE snapshot
  frame), waits for 0 running, then `systemctl --user restart`. Run it as a
  transient unit so it survives the agent's own turn ending (a plain detached shell
  gets torn down between turns):
  `systemd-run --user --unit=cockpit-graceful-restart bash scripts/graceful-restart.sh`
- **Visual verify (no auth):** preview `cd apps/web/dist && python3 /tmp/spa.py`
  (SPA fallback) on `127.0.0.1:8099`; drive a research Chrome with an
  `initScript` that stubs `window.EventSource` to emit a snapshot (+ optional
  `session/history-page`) and stubs `fetch` for `/intent/*`. Test desktop (1280)
  + mobile emulation. **Gotcha:** stub session objects must OMIT optional fields
  (don't send `null` for `currentReasoningEffort` etc.) or zod rejects the
  snapshot.

---

## Status

### Done (live)

- **Butler / Flow orchestration** (TRIGGER → FLOW → ACTION; design in
  [`butler.md`](./butler.md)). Phases A–D shipped. The trigger layer is
  cockpit-native, engine-global, additive to the SDK per-session ScheduleRegistry.
  - **A — event hooks**: `HookRegistry` + the v1 event `session.first-turn-complete`
    (emitted in the live `session.idle` handler, guarded by `firstTurnEligible`),
    `hook/add|list|stop` intents + `cockpit_hook_*` MCP tools. Persisted in
    `cockpit-prefs.json` (hooks/welcomedSessions/spawnedBySession), re-armed on
    start. **R1 invariant**: a `spawnedBy` worker is a non-trigger-source — its
    lifecycle fires no hook (no welcome fork-bomb). `hooks.ts` is pure + unit-tested.
  - **B — Flow layer**: `FlowRegistry` (loads `~/.copilot/flows/*.json`, zod-valid),
    `runGate` (subprocess cost-gate: event ctx via env+stdin, exit 0=go / non-zero
    or timeout=skip fail-safe, stdout JSON → interpolation params), `runFlow` →
    action. `spawnSession` builds a born-configured worker (MCP set at birth, tight
    skill match, model/mode before the first turn, marked `spawnedBy` first).
    `flow/list|run` intents + `cockpit_flow_*` tools. `flows.ts` unit-tested.
    Live-verified end-to-end incl. gate skip/go, born-config, gate-param interpolation.
  - **C — visibility**: info-panel **事件钩子** + **流程** sections; sidebar folds
    `spawnedBy` workers into a collapsible **自动** group; a **Flows** management page
    (hamburger → 流程, `/flows`·`/flows/:item`) via the shared `ManageWorkspace`.
  - **D — server-level flow schedules**: `FlowScheduleRegistry` (engine-global,
    armed at `start()`) fires a flow on a time cadence (interval | cron | at) even
    with **zero sessions loaded**, additive to the SDK per-session schedule. Cron
    is a hand-rolled, timezone-aware, DST-safe next-fire calculator (no third-party
    dep). `flow-schedule/add|list|stop` intents + `cockpit_flow_schedule_*` tools;
    persisted in prefs, re-armed across restart. Live-verified (0-session fire).
  - **Flow authoring on MCP** — the maintainer MCP can now CREATE flows, not just
    trigger them: `flow/add` (write `~/.copilot/flows/<id>.json`), `flow/remove`
    (also stops schedules pointing at it), `flow/write-gate` (write an executable
    gate script, returns its path) + `cockpit_flow_add` / `cockpit_flow_write_gate`
    / `cockpit_flow_remove`. All writes are confined to the flows dir (path-traversal
    rejected via `isSafeBasename`). **Decision (owner, 2026-06-20):** authoring gate
    scripts via the maintainer-only MCP is ALLOWED (the owner accepted the risk —
    this relaxes the design's F10 "gate scripts owner-authored only" red line for
    the maintainer-MCP context); the path-traversal guard stays.
  - **Triggers page — each flow shows its triggers**: the Flows detail joins
    `hook/list` + `flow-schedule/list` filtered by flowId into a 触发器 section
    (event chips vs time chips); list rows show a trigger-count tag.
  - **Decision (owner, 2026-06-20):** flow-maintenance is owned by a forthcoming
    **`cockpit-butler` skill** — any session that reads it (AND has the cockpit MCP
    enabled — the flow tools are maintainer-only) can maintain flows. The skill is
    knowledge; the cockpit MCP is the capability. **TODO:** author `cockpit-butler`
    (dev session dfd7c71e, after the flow-authoring round-trip is live-verified),
    grounded in this session's real method, with the cockpit-MCP prerequisite stated.
  - Source: session dfd7c71e; spec in admin session 96c3db7a's `butler-dev-spec.md`.
- **Core console** — session list (new/open/reload/unload/delete/pin), streaming
  messages, tool-call display, thought display, ask_user choices, CLI-style
  message queue, cancel, push notifications, voice input, history pagination, PWA.
- **Telegram-inherited rewrite** — full frontend re-authored onto tweb's design
  layer: tokens, tgico font, ripple / long-press / scrollable / menu primitives,
  global `user-select:none` (long-press never selects text), left column
  (`.chatlist`), chat (user bubbles `.is-out` + assistant document `.is-doc`, no
  bubble), composer, context menus, FAB. Solarized colors, restrained tweb
  micro-animation (reduced-motion honored). Removed legacy `index.css` + Tailwind.
- **TODO progress bar** — pinned bar under the topbar; accent rail fills by
  done/total + current-intent title; tap → info panel. SDK
  `getTodoStatus()`+`getCurrentIntent()`, refreshed on `session.todos_changed`.
- **Session info panel** — tweb right-column (`#column-right`); tap topbar title
  or TodoBar. Sections: title+cwd, model controls, full todo checklist (grouped,
  tgico icons, done struck), plan.md (collapsible). SDK `session.plan.read()` +
  `readSqlTodos()`; intent `session/plan` → `engine.getPlan`.
- **Model + reasoning-effort + context-tier switching** — `model.switchTo`;
  controls in the info panel (header read-only compact). Per-model gating:
  `supportedReasoningEfforts` (effort), `token_prices.long_context` →
  `supportsLongContext` (tier).
- **Info-panel state persists across session switch** — switching sessions keeps
  the right column open and re-loads the new session's plan/todos (panel data
  effect keyed on `sid`); removed the auto-close-on-`activeId`-change effect.
- **Near-term UX fixes** — `fix-tool-permission` (yolo handler; sessions can run
  bash/all tools), `fix-context-tier` (model long-context gating via
  `billing.token_prices`), `title-no-hover`, `chat-selectable` (text selectable
  except long-press targets), `remove-todobar`, `info-panel-responsive` (TG 3
  tiers: wide docked / medium floating+scrim / narrow full-page — verified).
- **Sub-agent support** — fixed the critical `getLastResolved` crash (hand-rolled
  `bootstrap.ts` omitted `autoModeManager` when building `LocalSessionManager`; every
  session incl. sub-agents copies it, so a sub-agent's first model resolve threw).
  Fix: pass `autoModeManager: new sdk.AutoModeSessionManager()`. Sub-agent events
  carry top-level `agentId` (= spawning task's toolCallId); fold routes them into a
  recursive `SubagentCard` (`ChatMessage.subMessages`), depth-N nesting supported.
- **Review fix-batch** (independent Opus-4.8 sub-agent review → per-item triage):
  - **H1** turn_start/endTurn live==replay divergence — engine no longer intercepts
    `assistant.turn_start` (folds it so `endTurn` runs live); `cancel()` calls
    `resetTurn`. Cancelled streaming turn no longer absorbs the next turn.
  - **M1** SSE reconnect reconcile — every (re)connect re-sends `engine.snapshot()`,
    which triggers `maybeMaterialize(force=true)` to re-pull the active window.
  - **M2** multi-segment reasoning preserved (append across segments, not overwrite).
  - **M3** depth-2 nested sub-agent attribution (recursive `ownsTask`/`ownsAgent`).
  - **M6** `newSession` now calls `evictIfNeeded`. **L3** intent guard →
    `Object.hasOwn`. **L4** client logs `ServerEvent` parse failures.
  - **L8** lint 15→0. **L9** `fold.test.ts` (11 fixture tests, live==replay invariant).
  - **bootstrap-contract-check** — `assertSdkContract()` fail-fast on SDK-internals drift.
  - **M4 debunked** — pending-ask sessions stay `running`, already spared from eviction.
  - Verified: 11 fold tests pass; real-log regression (`pnpm --filter @cockpit/core
    regress`) = 11 sessions / 11373 msgs / 0 errors / 0 invalid / 26 sub-agent cards.
- **Dogfood hardening** (a batch shipped while self-driving cockpit from a phone):
  - **pin (unified)** — one backend pin (`prefs.pinnedSessions` + `SessionMeta.pinned`,
    intent `session/pin`) = pin-to-top (cross-device, pure projection) **and**
    keep-loaded/anti-eviction; replaced the old per-device localStorage pin (no
    migration). Eviction + heap-watchdog skip pinned (last-resort only past the hard
    cap, loudly logged). `engine.start` auto-loads pinned on boot (rehydrates
    schedules). MCP `cockpit_set_session_pin`.
  - **schedule indicator** — `SessionMeta.scheduleCount` (SSE projection); list shows
    a tgico clock badge, info panel has a 定时任务 section.
  - **mode topbar + fleet** — persistent topbar mode chip (interactive/plan/autopilot,
    color-tinted, switch mid-turn → next turn); `autopilot_fleet` is the 4th
    `exit_plan_mode` action (sets mode=autopilot + `session.fleet.start`), not a mode.
  - **authoritative attention (plan B, v2 clear-by-kind)** — `SessionMeta.attention`
    (`'ready'|'choice'|null`) is the single backend truth for notifications; `attention.ts`
    `nextAttention(prev,next)` raises it (ready = running→idle edge; choice = mid-turn
    ask/plan/elicitation). v2: the two kinds CLEAR differently — `applySeen()` clears a
    `'ready'` on sight (an agent always ends a turn ready, so a ready that only cleared on
    the next prompt would never leave the badge), while a `'choice'` only demotes (stays
    counted until answered). Cross-device "seen" is a per-user monotonic water-line
    (`attnId` assigned on raise, `seenId` advanced by the `inbox/seen` intent →
    `engine.markSeen`), replacing the old per-device sticky `unread` flag (which left stale
    dots after an offline raise / remote handle). Badge + sidebar dot derive purely from
    `attention`/`attnId`/`seenId`; client fires `inbox/seen` on open / tab-focus / a raise
    on the active visible session. Deferred: cross-device dismiss-push (Chrome
    `userVisibleOnly` makes a silent dismiss push unreliable), per-session mute, unified
    inbox screen.
  - **session-title marker leak fix** — `fold.ts cleanSessionTitle()` strips a leading
    `<cockpit-attachment>` marker (uploads-first sessions); existing bad titles
    re-derive after a backend restart.
  - **trash bin** — soft-delete via `prefs.trashed`; `refreshList` filters trashed
    (fixes the delete→revive bug); intents `session/trash-list`/`restore`; permanent
    purge only via the cockpit MCP. See `apps/mcp/README.md`.
  - **graceful self-restart** — `/admin/restart` arms a flag; exits at 0-busy (busy =
    running OR awaiting a choice). Lets an in-cockpit agent deploy its own backend.

### Backlog / open (a future context-free agent picks up here)

Genuinely-open work, mirrored in the session `todos` table. Most "dogfood backlog"
items the absorption flagged are now **done** (above); these remain:

- **OOM structural fix** — tuning shipped (systemd heap 4096; aggressive watchdog
  `MEMORY_WATCHDOG_MS=8s`/`GC_GRACE_MS=8s`/`MAX_EVICT_PER_TICK=5`,
  `HEAP_HIGH/LOW=0.60/0.45`; reconnect resume via durable msg-id cursor `3ee3604`).
  The real fix is **out-of-process** — see *SDK strategy* (migrate to
  `@github/copilot-sdk`). `mem-analysis` (heap hot-spots) still in progress.
- **PWA navigation redesign** — three point-fixes for app-like back/right-swipe were
  **reverted** (`1269db0`, App.tsx back to baseline) because the problem is holistic.
  Research done (`files/pwa-nav-research-report.md`: Navigation API is Chromium-only,
  use History API; iOS standalone edge-swipe is a no-op at history root). Redo as one
  History-API stack model following tweb `appNavigationController.ts`. Not point-fixed.
- **iOS Web Push never fires (P0)** — full chain verified healthy (VAPID valid, APNs
  returns 201) yet the iOS home-screen PWA shows no notification. Still diagnosing.
- **Visual decisions awaiting the owner** (`telegram-study.md`) — 3 forks: chat-header
  project avatar (yes/no); selected-row light tint vs tweb-faithful solid-fill+white
  (`/tmp/sel-A.png`/`sel-B.png`); menu backdrop. tweb-faithful = solid.
- **Info-panel MCP status** — the MCP section lists servers but not their live
  connection status (`connected`/`failed`/`needs-auth`); the MCP tool already returns
  it, only the web panel doesn't surface it. Small refinement.
- **m5-fold-memory** — each loaded session keeps its full fold resident (≤16); only
  hurts very long sessions. Low priority; subsumed by the out-of-process migration.
- **composer-triggers** (`/ @ # !`) — blocked on a design decision (see item 18).
- **compact-session-20mb** — compact this dev session (`dfd7c71e`) LAST to drop ~20MB
  of accumulated image blocks once its working context is no longer needed.

### Execution plan (decided forms — sequenced)

This is the agreed build order. Each item's TG-fit / data path is now decided
(no more "待定"); the `todos` table mirrors this 1:1 with dependencies.

**Quick wins**
1. **status-show-task** ✅ DONE — topbar subtitle shows the current-intent title
   (`session.todo.intent`, aligns with how the CLI sets the terminal title);
   falls back to the status word when null/not running. List stays clean. Long
   intent ellipsizes (`data-intent`), model label survives. Frontend-only;
   verified desktop + mobile.
2. **ask-reply-visible** ✅ DONE — surfaces the user's ask_user answer as a visible
   "my reply" bubble. **Better source than originally planned:** not the ephemeral
   `user_input.completed`, but the **persistent** `tool.execution_complete` for the
   `ask_user` tool (`result.content` = "User responded: …"), which survives reload
   via `getEvents()` and folds identically live + replay. Fold tracks ask_user
   toolCallIds, strips the prefix, upserts `reply-<toolCallId>` (role=user,
   `subtype:'ask-reply'`, idempotent). Frontend renders an `is-out` bubble with a
   subtle "↩ 回复" tag. Verified (fold unit test + visual).

**P1 — information density (render inside the chat thread)** ✅ ALL DONE
3. **errors-in-stream** ✅ DONE — `session.error`/`session.warning` carry
   `{message}` and are persisted (replay-safe). Folded into `role:'system'`
   messages with a `level` (error/warning/info); frontend renders distinct pills
   (red + icon / orange / quiet note). Stable id, idempotent. Verified.
4. **shell-display** ✅ DONE — bash runs (`arguments.command` + result `content`)
   now carry `command`/`output` on the ToolCall; frontend shows a command line +
   collapsible output panel (output capped 4KB). Non-shell tools unchanged. Verified.
5. **stream-reasoning** ✅ DONE — `assistant.reasoning_delta` (ephemeral) streams
   live into the message's `thought`; `assistant.reasoning` (final, persisted)
   finalizes it. Reasoning precedes the message with no shared id, so the fold
   pairs them by turn order via a reasoning-derived placeholder id adopted by the
   message (consistent live + reload). Frontend `<Thought>` is expanded while live
   ("正在思考…") and auto-collapses when done ("思考过程", re-openable). Verified
   across 4 fold scenarios + visual.

**P2 — session management (topbar kebab menu)** — 6–9 ✅ DONE
6. **rename** ✅ DONE — `name.set({name})` + `name.get()` read-back; event
   `session.title_changed` patches the title. Kebab → 重命名 → text Dialog.
7. **compact** ✅ DONE — `history.compact({customInstructions?})`;
   `session.compaction_start/complete` flip status + reload. Kebab → confirm Dialog.
8. **rewind** ✅ DONE — `history.truncate({eventId})` ("this event + all after are
   removed"). User-message ids ARE event ids, so 撤销上一轮 targets the last user
   message; destructive confirm; history-only (no file rollback in v1) → reload.
9. **mode-switch** ✅ DONE — `mode.get()`/`mode.set({mode})` (interactive/plan/
   autopilot); `session.mode_changed` patches `currentMode`. Kebab shows current
   mode → two-step picker (deferred past onClose). `mode.get()` read in loadSession.
10. **diff-review** ✅ DONE — no clean SDK API for repo edits, so the fold tracks
    the agent's `edit`/`create` tool-call `path` args into a per-session changed-
    files map (first op wins); surfaced via the `getPlan` payload
    (`changedFiles[]`). Info-panel "改动文件" collapsible section, paths relativized
    to cwd, create=green `+` / edit=orange `~`. Verified on real logs (12 files) + visual.

New shared infra: `Dialog` component (prompt + confirm, tweb popup style),
`AgentMode` protocol type, `currentMode` on SessionMeta + patch. Backend +
frontend verified (kebab items, rename/compact/rewind/mode intents fire correctly;
rewind targets last user msg; live read path via loadSession `mode.get()`).

**P2 — info-panel sections (read-mostly + necessary toggles)** ✅ 11–14,16 DONE
(one batched feature: `session/panels` intent → `engine.getPanels` aggregates each
SDK list call, normalized to a uniform `PanelItem {label,sublabel,enabled}` row;
`<PanelSection>` renders each, hidden when empty. Live-verified end-to-end.)
11. **subagents** ✅ DONE — `session.tasks.list()` → `{tasks}` → 子代理 section.
12. **mcp** ✅ DONE — `session.mcp.list()` → `{servers}` → MCP 服务器 section.
13. **skills** ✅ DONE — `session.skills.list()` → `{skills:[{name,source,enabled}]}`
    → Skills section (shows 已停用 for disabled).
14. **instructions** ✅ DONE — `session.instructions.getSources()` → `{sources}` →
    指令文件 section.
15. **memory** ⛔ NOT FEASIBLE — no per-session `memory` namespace on the session
    (the CLI `/memory` uses a global memory.db, not a session API). Would need a
    separate global-memory entry point, out of scope for the info panel.
16. **scheduling** ✅ DONE — `session.schedule.list()` → `{entries}` → 定时任务 section.

**P2 — composer & misc**
17. **pending-card** ✅ DONE — one card pinned above the composer (TG bot reply-
    keyboard); unifies ask_user (done) + `exit_plan_mode.requested` (📋 summary +
    collapsible plan + 开始执行/自动/仅退出 → `respondToExitPlanMode`) +
    `elicitation.requested` (message + 同意/拒绝 → `respondToElicitation`). Dedicated
    listeners enable the capability; `*.completed` events clear it. Verified.
18. **composer-triggers** — TG-style autocomplete popovers: `/` commands, `@`
    files, `#` issues/PRs, `!` shell. **Needs a design decision** (the only
    un-built item): `session.commands.list()` exposes the slash commands
    (`{commands:[{name,aliases,description,input}]}`), but cockpit is UI-first —
    sending `/model` as a prompt does NOT invoke it (no command executor; most
    commands are already surfaced via kebab/info-panel). So a palette that inserts
    `/cmd` text would mislead. Open questions to resolve with the user: which
    triggers to support, and how `/` commands should EXECUTE in cockpit (map to
    existing actions vs add an SDK command-exec path); `@` needs a file-list
    source, `#` needs GitHub API. Deferred pending that decision rather than
    shipping a misleading text-insert.
19. **copy-share** ✅ DONE — message right-click/long-press → 复制 (clipboard); session
    share dropped (no `share` SDK namespace; low value for single-user). Verified.

**UX**
20. **bk-ios-keyboard** — pure-CSS shell (`100dvh` +
    `interactive-widget=resizes-content`, evo-chat model; the JS `--vvh`/`--app-*`
    visualViewport-tracking shell hook was REMOVED at the owner's ruling "keyboard =
    evo-chat 无可妥协", turn 37 of session 3ef01f4f). On iOS standalone the overlay
    keyboard leaves a gap below the composer (iOS ignores `interactive-widget`); a
    minimal composer-inset fix (`lib/iosKeyboard.ts`, `--kb-inset`) was trialed and
    REVERTED at the owner's call — accepted iOS-only limitation. NOTE: an earlier
    draft of this line claimed a `--vvh` shell var was the impl — that was the
    *rejected* approach, never the real one.

### Deferred / dropped

- **usage-context** (`/usage`,`/context`) — deferred (用户暂时不需要). SDK ready:
  `usage.getMetrics`, `session.usage_info`, `contextWindow`.
- **permission-approval** — dropped; user runs 100% yolo (`--allow-all`).

### Not porting (TUI-only / out of scope)

`/theme` `/statusline` `/footer` `/terminal-setup` `/streamer-mode`; line-edit
keybinds; `/ide` `/lsp`; `/login` `/logout` (server authenticated);
`/update` `/version` `/restart`; `/app`; `/delegate` (optional).

---

## Key SDK access paths (runtime-verified)

- **Models:** `sdk.getAvailableModels(authInfo)` → each model has
  `supportedReasoningEfforts` / `defaultReasoningEffort` and
  `billing.token_prices` (a `long_context` key ⇒ supports long context). **NOT**
  `capabilities.limits.token_prices` (that path is empty — was the fix-context-tier bug).
- **Model switch:** `session.model.switchTo({ modelId, reasoningEffort?,
  contextTier? })`; `getCurrent()` reads back the clamped selection.
- **TODO counts:** `session.sessionFs.sessionDatabase.getTodoStatus()` +
  `getCurrentIntent()`. Refresh trigger: `session.todos_changed` event.
- **Permissions (yolo):** pass `SessionOptions.permissionRequestHandler:
  async () => ({ kind: 'approved' })` or all tool calls are auto-denied.
- **Plan + full todos:** `session.plan.read()` (plan.md markdown),
  `session.plan.readSqlTodos()` (full per-item `[{id,title,description,status}]`).
- **Current intent:** `session.sessionFs.sessionDatabase.getCurrentIntent()` →
  single title from the todos table (the CLI uses it to set the terminal window
  title — its "what am I doing" label). `getTodoStatus()` is separate (counts only).
- **My ask_user reply (persistent):** the `ask_user` tool's
  `tool.execution_complete` carries `result.content` = "User responded: …" and is
  **persisted** in the event log (replays via `getEvents()`). This is the
  authoritative source for surfacing the user's answer — fold it identically live
  + replay. (There's also an ephemeral `user_input.completed` `{requestId,answer}`
  after `respondToUserInput`, but it does NOT survive reload — don't rely on it.)
- **Sub-agents (`task` tool):** two hand-rolled-bootstrap gotchas, both because we
  run the SDK from its `sdk/` entry instead of the full CLI's top-level `app.js`:
  1. **autoModeManager** — the session ctor copies `coreServices.autoModeManager`
     onto every session incl. sub-agents; omit it and a sub-agent's first model
     resolve throws `getLastResolved` of undefined. Pass `new AutoModeSessionManager()`.
  2. **agent definitions** — the bundle loads `<name>.agent.yaml` from
     `dirname(import.meta.url)/definitions` = `sdk/definitions`, but the npm package
     ships them at `@github/copilot/definitions` (sibling of `sdk/`). Without a fix
     every `task` spawn ENOENTs. `bootstrap.ensureAgentDefinitions()` symlinks
     `sdk/definitions -> ../definitions` (idempotent; re-created each boot so it
     survives `pnpm install`). Sub-agent events carry top-level `agentId`; fold them
     into recursive `SubagentCard`s (`ChatMessage.subMessages`).

The roadmap items above are mirrored 1:1 in the session `todos` table so the
in-app TODO bar / info panel reflect real progress.

---

## History

Per-change detail is in the session checkpoints (`checkpoints/index.md`). The
project began as `acp-chat` (WebSocket + `copilot --acp`), then pivoted to
`cockpit` (SSE + in-process `@github/copilot/sdk`) — the ACP-era design is
obsolete and superseded by the architecture above.
