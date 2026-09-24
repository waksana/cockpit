# Development

How to build, run and change Cockpit from source. Pull request rules are in
[CONTRIBUTING](../CONTRIBUTING.md), test selection in the [testing guide](testing.md),
packaging and versions in [releasing](releasing.md), and the system design in
[architecture](architecture.md).

## Quickstart

Requirements: Linux, Git, the Node version pinned in
[`build.yml`](../.github/workflows/build.yml) and the pnpm version in `package.json`
(`packageManager`).

```sh
git clone https://github.com/waksana/cockpit.git && cd cockpit
pnpm install --frozen-lockfile
pnpm build          # all workspaces; Web goes to apps/web/dist
pnpm test           # all workspace tests + scripts/*.test.mjs
pnpm lint           # ESLint + Stylelint for apps/web
```

Run a development server against an **isolated** native home and data root, on a
port other than any real service:

```sh
DEV=$(mktemp -d)
HOME=$DEV COPILOT_HOME=$DEV/.copilot COCKPIT_HOME=$DEV/.cockpit COCKPIT_PORT=48771 \
  pnpm dev:server    # tsx watch apps/server/src/index.ts, serves apps/web/dist
```

Open `http://127.0.0.1:48771`. The server restarts on backend changes; rebuild the
Web UI with `pnpm --filter @cockpit/web build` to see frontend changes. An isolated
home has no Copilot sign-in, so the UI works but models will not reply unless you
sign in inside that home; native behavior is better exercised with the isolated
fixtures in the [testing guide](testing.md#native-sdk-and-package).

`pnpm dev:web` starts the Vite dev server for `apps/web`. The server sends no CORS
headers, so Vite cannot call a backend on another origin; use it for the
[Chat Lab](#isolated-chat-component-review), which needs no backend.

Never point development at a running installation (default port 8771), your real
`~/.copilot` or `~/.cockpit`, or another contributor's worktree.

## Repository map

| Path | Contents |
| --- | --- |
| `packages/protocol` | Schemas and the `Intents` registry — the API source of truth. |
| `packages/core` | `Engine` and native SDK adapters; native smoke tests. |
| `packages/module-api` | Public module types (`src/index.ts` backend, `src/frontend.ts` Web). |
| `apps/server` | Fastify server, static Web, module host, installer and `module-cli.ts`. |
| `apps/web` | React UI; `src/dev` holds Chat Lab fixtures and checks. |
| `apps/mcp` | stdio MCP client ([README](../apps/mcp/README.md)). |
| `scripts` | Packaging, release checks, module API export, e2e/perf diagnostics. |
| `docs` | This documentation ([index](README.md)). |

Useful commands:

| Command | Purpose |
| --- | --- |
| `pnpm --filter <pkg> test` | One workspace's tests (`@cockpit/protocol`, `core`, `server`, `mcp`, `web`). |
| `pnpm --filter @cockpit/web typecheck` | Web type check (also part of its build). |
| `pnpm start` | Start the service from a source checkout (explicit tsx loader; workspace packages resolve to TypeScript). Packages run compiled `dist` instead ([releasing](releasing.md#entry-point-upgrade)). |
| `pnpm start:mcp` | Start the built stdio MCP client from a source checkout (tsx resolves the protocol sources). |
| `pnpm module <command>` | Local module CLI: `install`, `enable`, `disable`, `list`, `migrate-id`. |
| `pnpm package:runtime` | Build a runtime archive ([releasing](releasing.md)). |
| `pnpm e2e` / `pnpm perf` / `pnpm regress` | Opt-in diagnostics with synthetic fixtures ([testing](testing.md#diagnostics)). |

## Workflow

Work on a short-lived branch (a separate worktree is fine) and open a PR against
`main`; integrate current `main` before submitting. Do not paste changes into
running source or develop inside an installation. Before preparing an installable
delivery, follow the [delivery version rules](releasing.md#delivery-versions);
CI checks host version consistency but cannot see an operator's installed modules.
Clean up only branches, worktrees and fixtures you own; never clear native
sessions, queues or uploads as cleanup.

Module features — roles, `host.call`, menus, middleware, state and Markdown — are
specified in the [module contract](module-contract.md). In short: ordinary session
reads expose saved/applied role identity and reload state, never readiness (there is
no readiness cache or badge); readiness is an explicit on-demand check. `roles/add`
saves selections even during active work with results `saved | unchanged | uncertain`;
new roles apply on explicit reload or next cold load. The Web role header reads only
`session/resources` identity; an uncertain addition stays locked until that read
confirms it and is never retried automatically.

## Documentation rules

1. Each behavior has one canonical page; others link with a short summary instead of
   copying contracts. The [index](README.md) lists owners.
2. Create a new page only for a distinct topic; otherwise extend the owner.
3. Versions of the host and modules appear only in the [module catalog](modules.md)
   and GitHub Releases; elsewhere link there or to `/version`. Capability versions
   (API v1, `menuVersion: 1`, …) are contracts and stay with their contract.
4. Describe current behavior and confirmed targets; no aliases, migration inventories,
   archived pages, release history or review notes in the tree.
5. Check links, anchors, commands and paths against the source before committing.
   Documentation-only changes need no product build, service or native session.
6. A mismatch between requirement and implementation is an explicit gap, never a
   silent change to either. Documentation changes authorize no deployment,
   restart, module enablement or data migration.

All documentation is written in English.

<a id="interaction-semantics-and-structural-correctness"></a>
## Interaction semantics

Before any host Web or module UI work, read the [frontend guidelines](frontend-guidelines.md);
they own native-first semantics, valid structure, focus and event ownership,
minimal JS, reading behavior, truthful state and the review checklist.

Keep the four module extension mechanisms distinct: menu declarations, semantic
component middleware, state/service/draft and Markdown renderers. Menu contributions
use the existing global/session menus, not a navigation HOC or page registration.
The host owns menu keyboard/focus/closing and rechecks availability on selection;
module state stays in its service. Validate original-target binding, stale
callbacks, disabled changes and late results without redirecting work to the active
session. Closing a menu or navigating does not cancel accepted work; target loss,
an unknown connection or module stop aborts the signal without waiting for the
action promise. See [menu registration](module-contract.md#65-menu-registration).

<a id="isolated-chat-component-review"></a>
## Chat Lab

```sh
COCKPIT_CHAT_LAB=1 pnpm --filter @cockpit/web dev --host 127.0.0.1 --port 47831 --strictPort
```

This opt-in, development-only `/chat-lab.html` entry mounts the **production**
components with synthetic native inputs and local callbacks; it creates no native
client or session and is excluded from production builds and runtime packages. It is
the only interactive review harness: do not add one-off pages, parallel chat apps or
component copies. When changing a Chat component, update the affected scenes and
their contract tests; add a scene only for a distinct interaction or failure
boundary, and remove scenes whose behavior is removed.

Select a scene with `?scene=<id>`:

| Scene | Use it for |
| --- | --- |
| `all` (default), `streaming`, `idle-queued`, `plan`, `user-time` | General transcript and input states. |
| `ask`, `ask-queued` (`&compact=1`) | Unified input card: folding by the status header, shared scroller for queue/question/choices/editor, request-ID changes, hold/failure controls for local-send following. |
| `input-states` | Idle, execution, questions (including no free text: editable but submission and input enhancements blocked), plans, tool confirmations and disabled input on one mounted editor; draft geometry must not change. |
| `process-summary` | Process headers: one icon/count pair per category, accessible labels, statuses and nested details. |
| `ordered-events` | Historical/live/reconnect pages through the production projection ([ordering](native-chat.md#ordered-presentation)). |
| `thought-markdown` | Formatted thinking, code copy and incremental updates. |
| `history-loading`, `history-progressive`, `initial-history`, `reading` | History-start hint, progressive pages with retained anchors, first-page positioning (`&frame=1` late commit, `&short=1`, `&cards=1` growing card). Record actual first paint, not just scroll positions. |
| `dialog-focus` | Confirmation, `DirectoryModal` and `InspectorPane` (modal at 1000×800, docked above 1200px). Run `await import('/src/dev/dialog-focus-checks.ts').then(m => m.checkDialogFocus('pointer'))` (or `'keyboard'`/`'input'`) after each open/close. `window.dialogFocusLab` exposes `directoryReady()`, `replaceTrigger()`, `removeTrigger()` and `release()`. |
| `sidebar` | Two-line session rows with long/unbroken titles, roles, statuses and module badges. Run `await import('/src/dev/sidebar-checks.ts').then(m => m.runSidebarChecks())` at desktop and narrow touch widths. |
| `resources` (`&longNames=1`, `&page=mcp|skills|session-mcp|session-skills`, `&item=`, `&empty=1`, `&fail=1`, `&delay=1`) | Session list, role picker, settings and global/session MCP/Skills pages against a synthetic store. Run `await import('/src/dev/role-picker-checks.ts').then(m => m.runRolePickerChecks())` with a role picker open. Check 1600, 1024 and 390px. |
| `workspace`, `full-web` (`&case=tool-loading`, `agent-unloaded`) | The complete App on a synthetic store, including the session control bar. |
| `workspace&failures=1` | [Region error boundaries](frontend-guidelines.md#error-boundaries): a malformed message, session row and settings panel fail in place with no global notice. `window.renderFailureLab.repair()` restores valid data to check automatic recovery. |

Use real mouse, touch and keyboard actions, both themes and narrow widths
(`&pane=narrow` constrains the chat pane to 456px). The checks measure geometry and
focus; they are not native, iOS or production evidence.

To include the unmodified File module's frontend (`&modules=1` in `dialog-focus`),
set `COCKPIT_LAB_FILE_ROOT` to an extracted, receipt-verified File package (the
directory with `cockpit.module.json` and `module-build.json`). Only inventoried
frontend assets are served, module backends never run, and uploads use a bounded
in-memory File API.

Likewise, `COCKPIT_LAB_SPEECH_ROOT` mounts an extracted Speech package in
`full-web` with `&modules=1` (for example `&case=ask`). Its backend never runs, so
credentials are rejected; stub `navigator.mediaDevices.getUserMedia` with a pending
promise to hold the "preparing" status while reviewing input-card layout.

Stop temporary previews after review; do not publish user screenshots.

### Documentation images

- `docs/images/workspace.png`: `?scene=workspace` at 1600×1000 with settings open;
  expand the latest agent and tool, keep the earlier process overview collapsed, and
  capture the viewport without Lab controls.
- `docs/images/answering.png`: `?scene=ask&compact=1` at 1040×650 with an unsent short
  answer; capture only the input card.
- `docs/images/extensions.svg` is hand-maintained; keep it aligned with the module contract.

All screenshot content is synthetic and labelled so in the README.

## Web application boundaries

`public/manifest.webmanifest` and the HTML metadata describe the app and icons. The
host registers no service worker, offline cache or push subscription; a trusted
module may declare a packaged worker at a stable module URL with a narrow scope and
owns its registration, notifications and badges. Production builds have a single
`index.html` entry.

<a id="web-presentation-boundaries"></a>
### Presentation and ownership

- Unknown persisted draft namespaces (including from an absent or failed module)
  block native submission until their schema restores them; edits and retirement
  keep opaque recovery data, so a missing module can never turn an attachment send
  into a text-only send.
- The document entry calls `installHostLeaveProtection(window)` (`src/lib/hostLeave.ts`)
  before first render, outside React, and keeps the disposer until entry teardown/HMR.
  It adds native `beforeunload` confirmation for unpersisted drafts, dirty forms and
  dispatched mutations (even after their view unmounts); uncertain outcomes keep
  protection for the document lifetime. It never cancels, retries or changes work.
- `PaneHeader` and `StateNotice` share presentation only. Management routes keep
  their header during lazy loading; first loads show a pane placeholder; session
  settings refreshes keep content with a header indicator; a toggle owns its row's
  feedback including final readback.
- Accepted data stays usable during a healthy refresh; errors, reconnections and
  disabled resources do not imply current values. MCP mutations keep the native
  per-session serial constraint; Skills mutations are per row. No optimistic
  enablement, client mutation queue or native-state mirror.
- Consumers use the session resource's availability (including closing and
  resume-required) instead of old metadata.
- `PendingDecision` shares plan/elicitation/question content inside the input card;
  questions reuse the composer; callbacks and native action lists stay distinct.
  Read ownership and scrolling belong to the route/window and single scroll owner.
- Session rows have exactly two lines and one height, without a directory avatar.
  Line 1: single-line ellipsized title (full text on hover and in the accessible name)
  and the always-visible time. Line 2: role badges, cwd basename (full path on hover)
  and status. When space runs out the directory yields first, then role badges share
  the rest equally (short ones whole, long ones ellipsized down to outlined stubs with
  full titles); status never shrinks, wraps or overlaps, and host attention indicators
  (overall, then decision) come first.
- The session control bar (`SessionControlBar`, via `session/control` with the
  loaded-handle token from `session/resources`) shows active work only: one overall
  indicator (a spinner coexists with question, agent, terminal, queue and compaction
  icons), grouped agent/terminal/queue rows, native question/decision content and the
  editor in one input card. Confirmed idle hides the bar; offline and errors stay
  explicit. Stopped tasks disappear without deleting recorded output. Agent/terminal
  rows have a cancel action, queue rows copy and send-now; each group header clears
  its captured task IDs. Cancelling a question is request-bound: ask stops its main
  turn, plan uses exit-only, elicitation uses cancel. A new question opens the list
  and positions its answer once before paint; later updates do not repeat that.
- Process headers show one icon/count pair per nonempty category (tools, thoughts,
  Skills), never category words or Skill names; accessible labels keep the semantics.
  Tool status icons are block SVGs so rotation cannot change scrollable overflow.
