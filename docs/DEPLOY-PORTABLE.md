# Deploying the Cockpit foundation

Cockpit runs Copilot on an always-online server. Its web app and MCP are clients
of the same backend API. Installing Cockpit does **not** install a commander,
Butler, flows, executable gates, fleet hooks, or governance schedules.

For the explicitly connected private GitHub Actions route, see
[immutable delivery](DELIVERY.md) and [development](DEVELOPMENT.md).
The source installation below remains valid but is not immutable runtime identity.

## Prerequisites

- Node.js 24 LTS is recommended, plus pnpm and Git.
- Authenticate Copilot/GitHub on the server once. The runtime uses the server's
  credentials; browsers do not need an SSH session or their own Copilot process.
- For remote browser access, an authenticated HTTPS reverse proxy in front of the
  loopback server. The backend is a single-operator service, not a public,
  unauthenticated API.

## Install and run

From the repository root:

```bash
pnpm install
pnpm build
pnpm start
```

`pnpm start` serves both the built web app and API at
`http://127.0.0.1:8771`. It supervises the server child and restarts it after a
graceful exit. For an always-online deployment, run this launcher under the
operating system's service manager: systemd on Linux, launchd on macOS, or a
Windows service / startup task configured to run without an open terminal.

An open browser is not required for submitted work to continue. Process failure
is different from a disconnected browser: persisted history can be recovered,
but an in-flight Copilot turn is not guaranteed to survive a process restart.

The SDK uses a 30-minute session idle timeout. Cockpit does not run its own
automatic unloading or memory-recycling policy. Reading history does not resume
a session; sending a prompt or explicitly loading it does. Native schedules pause
while unloaded and relative delays restart on resume. Use an external scheduler
through the API if wall-clock execution while unloaded is required.

Cockpit startup does not activate sessions based on saved schedule preferences.
The scheduler or webhook receiver belongs outside Cockpit and can send a prompt
through the same API; that explicit operation resumes the target when needed.

The [module catalog](module-catalog.md) describes the parked enhancements.
This source has no bundled self-reset workflow, browser file transfer, voice,
notifications, organization or system dashboard. Native compaction, rewind and
normal load/unload remain distinct operations.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `COCKPIT_PORT` | `8771` | Loopback listening port |
| `COCKPIT_HOME` | `~/.copilot` | Native Copilot storage used by this host |
| `COCKPIT_SERVE_WEB` | `1` through the launcher | Serve the built SPA from the API process |
| `COCKPIT_WEB_DIR` | `apps/web/dist` | Built SPA directory |
| `COCKPIT_ALLOWED_ORIGINS` | Built-in origin allowlist | Additional comma-separated browser origins |
| `COCKPIT_MAX_OLD_SPACE_MB` | Node default | Optional server child's V8 old-space ceiling override |

The backend binds `127.0.0.1`, not a routable interface. When using the source
server directly rather than the launcher, SPA serving is opt-in.

## Remote access

Put the web app, `/intent/*`, `/events`, `/chat/stream` and `/capabilities`
behind the same authenticated HTTPS origin. Forward SSE without proxy buffering
and allow long-lived streams. There is no built-in file transfer route.

Keep `/admin/restart` and operational status private unless the gateway explicitly
authorizes them. Origin checks are CSRF protection, **not authentication**. Do not
expose a raw loopback service through an unauthenticated tunnel.

After this one-time setup, computers and phones use the web app for session
selection, native chat, execution controls and questions. Reconnecting
clients receive a fresh metadata snapshot. Their browser-owned chat windows
continue through native event cursors; see [native chat transport](native-chat.md)
for paging, incomplete streaming messages and explicit cursor invalidation.

## MCP client

Build `apps/mcp` as part of `pnpm build`, then register its
`apps/mcp/dist/index.js` stdio entry in the Copilot MCP configuration. Set
`COCKPIT_URL` to the backend URL reachable by that MCP process. See
[`apps/mcp/README.md`](../apps/mcp/README.md) for the exact client configuration,
tools and gateway credentials.

The MCP client reads sessions and transcripts through the API; it does not need
the server's session database or event-log directories mounted locally.
SDK-native attachment paths refer to the **Copilot runtime's** filesystem.
Passing a path does not transfer a file from the MCP client's machine.

## Existing installations and governance

Back up the state directory before upgrading. Keep existing session-state,
conversation logs, preferences and uploaded files in place. Do not copy server
credentials or private conversation data to a new machine merely to install the
software.

The foundation no longer hosts Cockpit-owned `hook/*`, `flow/*`,
`flow-schedule/*` or `session/set-spawned-by` operations. Their old definitions
and persisted records are not installation inputs and must not be re-armed by a
foundation upgrade or repair. Existing worker sessions remain ordinary sessions,
not hidden behind a governance workspace.

This is distinct from Copilot's native, user-controlled per-session scheduled
prompts and from process supervision. Those runtime mechanisms remain available.

Governance applications may run separately and consume the published session
APIs, events and MCP. They own their policies, timers, ledgers and deployment;
they must not depend on private Engine internals or require Cockpit to install
them. Historical governance designs are retained in Git history, not shipped
as foundation setup procedures. No replacement governance service is bundled.

## Session list

The sidebar lists sessions by most recent native activity, without directory/project
grouping or worktree labels. Rows display their cwd basename; search matches
title, full cwd and session ID. The backend does not resolve Git project or
worktree identity for session organization.

## Restarting safely

The thin foundation no longer reads, migrates or writes `cockpit-prefs.json`.
Old pin/inbox/governance records, uploads, push registrations and rich browser
drafts remain untouched. No background cleanup or automatic replay is added.
Old managed links have no download service in this source. The text-only
composer uses a new key and does not inherit old rich drafts or their captions;
see [adoption boundaries](module-catalog.md#interim-behavior-and-adoption).

There is no Cockpit trash or restore operation. Removing legacy trash marks only
unhides existing native sessions in the normal list; it does not delete history.
Future deletion uses native public `deleteSession` after an irreversible UI
confirmation and server-enforced literal `confirm:true` on `session/delete`.
`session/purge` remains a compatibility alias with the same confirmation gate
and implementation. Old soft-delete requests without confirmation are rejected,
including those from already-loaded MCP tools with stale descriptions. Do not
automatically retry uncertain deletion results. Managed files, associations,
downloads and workspaces survive session deletion. Reload MCP connections only
when idle; a backend restart does not update already-loaded tool descriptions.
New Web and semantic MCP delete consumers use the already-destructive
`session/purge` wire name so a staggered client/backend deployment cannot report
an old backend's soft deletion as permanent.

An authorized `POST /admin/restart` with `{"pending":true}` requests restart when
all sessions are idle. `{"pending":false}` cancels the request. The supervisor
must bring the server back after its clean exit. Do not hard-kill it to apply an
ordinary update while sessions are running or waiting for answers.
If the owned Copilot process dies unexpectedly, the API exits nonzero for that
same supervisor to recover it. Potentially accepted prompts are never replayed.

The convenience restart scripts and MCP command are parked, not installed.
An external deployment controller or the owned consumer launcher can still use
the protected lifecycle. Acknowledgement is not proof that a new process started;
never use an unreachable backend as permission to bypass its busy protection.

### Do not make a restart observer block its own restart

After acknowledgement, finish the calling turn. A background Bash tool remains
native active work even with tool-level `detach:true`; detaching a process is
not the same as removing its tool/task from the session. In particular,
`systemd-run --wait` inside a background tool creates a cycle: the tool waits for
an observer, the observer waits for restart, and restart waits for that tool.
The initiating command must return without waiting for itself to become idle.
Do not bypass the busy gate or classify all background tasks as idle.

Usually, report that restart is pending and verify after the next user entry.
Only with explicit authorization for a bounded cross-restart observer, launch a
finite transient systemd unit from a **synchronous, short-lived** command, with
no `--wait`, `--pipe`, or `--pty`. Let `systemd-run` return after unit startup;
do not leave a native background shell waiting on the unit or tailing its log.
Bound the unit's lifetime and callback count, do not extend the authorized
deadline when correcting a failed launch, and verify the launch command has
exited. The observer must not stop sessions or force a service restart.

For an existing cycle, stop only the identified observer unit and consume the
original Bash completion. Confirm that unit's PID is gone and native task panels
show it completed; confirm `activeSubagents` returns to zero after tool reads
settle. `nativeProcessing` may remain true during the current main turn, which
is expected until that turn ends. Do not erase or override native busy metadata
to simulate completion.

If the live service serves `apps/web/dist`, a normal web build changes the live
frontend immediately. Validate a candidate in a separate output directory before
cutover:

```bash
pnpm --filter @cockpit/web typecheck
pnpm --filter @cockpit/web exec vite build --outDir /absolute/staging/web-dist
```

After deploying, exercise the real remote-use journey: open a session on a
computer, send a text message, disconnect, reopen it on a phone, and confirm
the same history and controls are available. Also use MCP to address another
session. These native journeys do not require a business module. File/voice/
notification journeys must wait for separately adapted modules.
