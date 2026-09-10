# Immutable releases

The production route uses `.github/workflows/ci.yml` after a push to main.
Node 24.20.0, pnpm 10.34.5 and the lockfile fix the runtime/build dependency
selection. Required checks and the isolated native contract must succeed before
`build.mjs` packages the exact commit. It includes TS server/core/protocol sources
and tsx: their existing build scripts do not emit runnable dist directories.

`deploy.yml` runs only for a successful main push build and when the repository
variable `DEPLOY_ENABLED` is `true`. Initial installation leaves that variable
disabled until the new service launch path and baseline are safe to activate.
There is no new public unauthenticated deployment HTTP endpoint.

## Transport and installation boundary

The hosted runner sends the Actions artifact ZIP over a dedicated SSH key.
Its server account must have only a forced receive command, no forwarding, PTY
or interactive shell. That command runs the fixed controller as the application
operator, never as root. Pin the host key from the server's local public key,
not an unauthenticated network scan alone.

Install `controller.mjs`, `model.mjs` and `extract.py` outside release directories,
owned by the administrator. They are deployment control code: changing a main
artifact does not replace these files. Install Node at a stable versioned path.
The controller reads `/etc/cockpit-release.json`:

```json
{
  "repository": "owner/repository",
  "root": "/srv/cockpit",
  "url": "http://127.0.0.1:8771",
  "service": "cockpit.service"
}
```

Host-specific settings and SSH keys are not committed. The controller uses an
authorized GitHub CLI identity to read this repository's run/artifact metadata
and commit ancestry; for an unattended dedicated identity, grant only the
repository contents/actions read access it needs.

Required Actions settings:

| Setting | Kind | Meaning |
|---|---|---|
| DEPLOY_ENABLED | variable | Explicit activation gate, initially false |
| DEPLOY_HOST | variable | Existing SSH endpoint reachable by hosted runners |
| DEPLOY_USER | variable | Dedicated forced-command account |
| DEPLOY_KNOWN_HOSTS | variable | Verified server SSH public host key line |
| DEPLOY_KEY | secret | Dedicated private key, not a production login key |

GitHub environments/approval rules are not assumed: private availability depends
on the account plan. No paid runner or plan upgrade is required by these files.

## Identity and state

The receive command is `receive RUN_ID ARTIFACT_ID`, with the ZIP on stdin. It
checks the authoritative repository, workflow path, event, main branch, successful
run, SHA, artifact identity and GitHub SHA-256 digest before extraction. Extraction
is bounded and rejects unsafe paths/links. The package manifest checks every
runtime file and executable bit, internal links, required entries, and Node/OS/
architecture compatibility. No dependency installation happens in production.

```text
root/
  releases/<commit>-<artifact-id>/  read-only immutable runtime closure
  current -> releases/...
  assets/                         retained content-addressed Web assets
  incoming/                       private bounded temporary transfers
  state.json + state.lock         desired/active/high-watermark and notification keys
  runtime-cache/                  disposable cache, outside the release
```

Keep `COCKPIT_HOME`, uploads, push state, authentication, logs and the external
WeChat connector's state outside this tree's release directories. Preserve the
existing push migration input if legacy data still needs migration. Do not
copy user state into an artifact or use production state for package smoke.

Concurrent builds and transfers are allowed. A short filesystem lock protects
candidate selection/state, not builds or busy waiting. Candidates must descend
from the accepted high-watermark; an older CI finishing later cannot roll
production back. Multiple pending successful candidates coalesce into the newest
accepted descendant. Equal-SHA, different-artifact replacements require an
explicit decision rather than silently changing an existing release identity.
The application operator additionally needs a sudo rule for only
`systemctl --no-block start` on this fixed unit. It cannot stop/restart the
service through that rule. This permits recovery after a blocked startup;
starting an already active unit does not interrupt its work.

GitHub concurrency uses `queue: max` and does not cancel running submissions.
Its ordering is not commit order; the server's ancestry check provides the
ordering guarantee. A cancelled/failed SSH client may already have submitted:
query state rather than blindly replaying deployment.

## Single-instance activation

The controller persists desired then requests the existing graceful restart and
returns. The old process continues using its fixed paths until all native work
and decisions drain. Systemd runs the fixed `controller.mjs launch` entry after
the old process exits, selects a verified release, atomically updates `current`,
and launches the server with resolved release-local paths.

It marks healthy only after `/health` reports the selected release identity.
Then it can send one result prompt to each original owner recorded in the
release's commit trailers. Notification attempts are recorded before sending:
uncertain responses are not automatically replayed. A missed notification does
not change the actual release status.

The launcher must not be forcibly stopped during ordinary deployment. Preserve
systemd graceful supervision, allow clean exits to restart, and set
`RestartPreventExitStatus=78` for an explicitly blocked incompatible rollback.
There is one active SDK runtime, not two servers sharing native session state.
Busy may postpone deployment indefinitely; do not force-close turns to meet a
CI timeout. The Actions submission job does not wait for idle/health.

Old hashed Web assets remain accessible through the existing authenticated
origin. HTML and SW stay with the chosen release. Retained assets do not replace
Web/API compatibility. Existing MCP processes may retain old tool descriptions;
use supported idle reload/reconnection, never interrupt active sessions.
The external WeChat connector is independently deployed and its native-history,
cursor and delivery contracts must remain compatible.

## Failures and rollback

`deploy/release-policy.json` explicitly says whether automatic rollback after
failed startup is safe for that release. The initial policy is **false** because
existing native/state migration compatibility has not been asserted. An unsafe
startup failure blocks automatic restart into an old binary (exit 78); recover
with a verified forward fix or an explicitly planned data-compatible rollback.
For a release explicitly marked rollback-safe, failed startup can choose the
last healthy package. The high-watermark is not lowered.

If a new process remains alive but readiness cannot be confirmed, the launcher
does not kill potentially active sessions to manufacture a rollback. Inspect
the actual state and use the same graceful boundary for recovery.

Backups are not permission to delete current data. Do not roll back native
databases, uploads, message cursors or credentials just because code is rolled
back. Retain last healthy and required historical packages independently of
the seven-day Actions artifact retention. No automatic release/data cleanup is
installed.
