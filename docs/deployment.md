# Independent deployment service

The optional deployment service runs **outside the Cockpit host process**, under
the same OS user's systemd manager. An explicit authenticated HTTP/CLI request
starts one deployment; it returns a request ID before the work finishes.
The service prepares a fixed published host/module combination, requests graceful
host exit, backs up and migrates declared data, switches installations, starts the
host and records objective acceptance.

It is not part of host startup, a module, an automation Task, a release listener,
a scheduler or a session-continuation mechanism. MCP triggering, result
notifications and [session continuation](https://github.com/waksana/cockpit/issues/37)
are separate work. No deployment happens merely because a Release appears.

## Prerequisites and trust

- Follow [release-before-deployment](releasing.md#release-before-deployment).
  Publish first; use the original formal Release archives and checksums.
  This service does not bump versions, tag, publish or infer a safe combination
  from independent repositories' Latest releases.
- Linux x64/glibc, a working **user** systemd manager, and the exact Node version
  required by both the running and candidate runtime packages. The configured
  Node and the deployment process must use that version. This implementation
  rejects native SDK changes instead of guessing a native-data migration.
- One installation, managed by one deployment service. Every installed module ID
  must have an explicit selected version/digest and enabled/disabled state.
  An installed-but-unselected module is ambiguous: resolve it before deployment.
- The deployment account owns the host user unit, installation directories, plans,
  token and private state. It must be the same account that owns Cockpit data.
  There is no privileged helper, sudo/polkit setup or system-unit control.
- All application-data writers must belong to the managed host and be stopped
  before offline backup/migration. Abstract-socket leases exclude cooperating
  processes in the same network namespace, not arbitrary external writers.
- Plans and migration programs are trusted, reviewed local input. Package hashes
  detect changed bytes; they are not publisher signatures or a sandbox. Migration
  scripts must remain foreground processes and must not daemonize or escape the
  deployment service's cgroup.

Do not move an existing system-level `cockpit.service` to a user unit as an
unannounced side effect. Such a handover requires separate operator authorization,
stopping/disabling the old manager and preserving its user, native home, data and
launch prerequisites. Never enable a second host against the same data or port.
Unattended user services also need a persistent user manager; an administrator may
need to authorize user lingering. Source development does not authorize any of
these production changes.

## Install and configure

Use a verified runtime package and keep its directory immutable. The deployment
service's own `ExecStart` must name a **fixed package directory**, not the host's
moving `current` symlink. Old installations remain present while they are in use.
Upgrading the deployment service itself is a separate controlled operation.

The packaged entry point is:

```sh
node --enable-source-maps /fixed/runtime/apps/server/dist/deployment-cli.js serve /private/deployment/config.json
```

From a source worktree, `pnpm deployment ...` invokes the same CLI through the
existing development loader. `serve` still requires its configured user unit;
ordinary `submit`, `get` and offline reads can run in a terminal.

Create an owner-only configuration, token and plans directory. Use persistent
storage, not a temporary/runtime filesystem, for production state, plans and the
host unit. Replace the example paths and choose a free deployment port:

```json
{
  "format": 1,
  "controllerUnit": "cockpit-deployment.service",
  "stateRoot": "/home/operator/.local/state/cockpit-deployment",
  "plansRoot": "/home/operator/.config/cockpit-deployment/plans",
  "tokenFile": "/home/operator/.config/cockpit-deployment/token",
  "port": 8772,
  "host": {
    "origin": "http://127.0.0.1:8771",
    "home": "/home/operator/.cockpit",
    "installRoot": "/home/operator/.local/lib/cockpit",
    "currentLink": "/home/operator/.local/lib/cockpit/current",
    "node": "/absolute/path/to/node",
    "service": {
      "scope": "user",
      "unit": "cockpit.service",
      "systemctl": "/usr/bin/systemctl"
    }
  }
}
```

`host.home` means `COCKPIT_HOME`, not the OS home or native Copilot directory.
The four data/installation/state/plans roots must be distinct and non-nested.
`currentLink` must be a direct symlink in `installRoot`. Roots and unit files
cannot be symlink aliases; service paths cannot contain whitespace or systemd
specifiers. Keep the token file mode 0600 and state/plans directories mode 0700.
The token must be 32–256 URL-safe characters; generate it locally and never paste
it into chat, commit it, or put it in command-line arguments.

Place the host unit in the user's persistent systemd directory, normally
`~/.config/systemd/user/cockpit.service`. It must directly launch the configured
Node and current package; wrapper scripts and additional `ExecStop` commands are
not silently adopted:

```ini
[Unit]
Description=Cockpit

[Service]
Type=simple
ExecStart=/absolute/path/to/node --enable-source-maps /home/operator/.local/lib/cockpit/current/apps/server/dist/index.js
WorkingDirectory=/home/operator
Environment=COCKPIT_HOME=/home/operator/.cockpit
Restart=always
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=infinity
SendSIGKILL=no

[Install]
WantedBy=default.target
```

Preserve any explicitly configured `COPILOT_HOME`, gateway/network environment and
native sign-in requirements from the existing installation. Do not replace them
with the synthetic test settings.

The independent controller is a different user unit:

```ini
[Unit]
Description=Cockpit deployment service

[Service]
Type=simple
ExecStart=/absolute/path/to/node --enable-source-maps /fixed/runtime/apps/server/dist/deployment-cli.js serve /home/operator/.config/cockpit-deployment/config.json
WorkingDirectory=/home/operator
Restart=on-failure
KillMode=control-group
SendSIGKILL=yes
TimeoutStopSec=150

[Install]
WantedBy=default.target
```

The controller checks that it is the configured user unit's main process, with
the expected cgroup cleanup policy. Killing a controller may terminate its
migration children and leave uncertain effects; it never force-kills the separate
host unit. Start/enable units only after the authorized installation and handover
are complete. The service installs or enables no units itself.

## Reviewed deployment plans

Store each immutable reviewed plan as `<plansRoot>/<planId>.json`, mode 0600.
The complete schema is
[`DeploymentPlan`](../apps/server/src/deployment/contracts.ts).
An authenticated request names the plan and its sha256; it cannot upload a
script, choose an arbitrary unit or change service configuration.

Each host/module release entry specifies:

```json
{
  "repository": "owner/repository",
  "tag": "vX.Y.Z",
  "sourceSha": "FULL_TAG_COMMIT_SHA",
  "version": "X.Y.Z",
  "asset": "runtime.tar.gz",
  "sha256": "FULL_RELEASE_ARCHIVE_SHA256"
}
```

The placeholders are deliberately invalid until replaced. The service verifies
that a non-draft, non-prerelease Release exists, dereferences its tag to the
reviewed commit, fixes its asset ID/size and checks the downloaded bytes. A moved
tag, missing asset, bad digest or incompatible package fails before host exit.
Already installed code is checked against the trusted archive inventory, not
only its own self-reported manifest.

A plan contains `format:1`, `id`, `host`, `modules`, a nonempty `reviewedBy`
annotation and `writers:"only-the-managed-host"`. `modules` must contain exactly
the installed/selected IDs, including disabled modules. Each module declares its
release, exact `compatibleHost` version, `requiredIntents`, `databases` and
optional `migrations`. An empty `modules` object is valid only for an installation
with no modules.

Compatibility declarations need review and paired-release evidence: a version
label or matching intent name alone cannot establish behavioral compatibility.
The service rejects missing declared capabilities and verifies actual module
activation after restart; it does not invent declarations.

Each database uses an exact module-data-relative `path`, final integer `schema`
(`PRAGMA user_version`) and optional `preserve` projections such as
`{"table":"records","columns":["id","value"]}`. Use one projection per table.
The projections preserve specified records/columns, not an unqualified claim
that a migration changed no database value. Undeclared SQLite/WAL files cause a
preflight failure rather than a guessed backup.

A migration is explicitly forward-only: `database`, `from`, `to`,
`nondestructive:true`, and reviewed `preflight`/`apply` hooks. Each hook names a
packaged Node script `entry`, an `args` array and nonempty scalar `expected`
JSON fields. Arguments are literal strings or `{"path":"data"}` /
`{"path":"plan"}` placeholders; no shell is used. An optional
`plan:{file,sha256}` fixes a private migration plan under `plansRoot`. Preflight
receives a consistent isolated copy; apply receives the stopped module's real
data root. Unknown schemas and missing plans are errors. A database already at
the target schema is not migrated again.

Ordinary module files are preserved by default. A reviewed migration may name
exact replacements in `files:[{path,fromSha256,toSha256}]`. Source and result
digests must match; there is no delete rule, wildcard exemption or inferred
classification. Originals remain in backup. The `nondestructive` declaration
does not make an unreviewed program safe.

## Trigger and read

All HTTP endpoints are on the independent loopback port, require the bearer
token, reject browser `Origin`/`Referer`, and use no-store responses. They are
**not Cockpit intents or MCP tools**. Protect any remote gateway separately;
do not expose the port through an unauthenticated tunnel.

From a fixed runtime package:

```sh
node --enable-source-maps apps/server/dist/deployment-cli.js \
  submit /private/config.json REQUEST_ID PLAN_ID PLAN_SHA256
node --enable-source-maps apps/server/dist/deployment-cli.js get /private/config.json REQUEST_ID
node --enable-source-maps apps/server/dist/deployment-cli.js list /private/config.json
node --enable-source-maps apps/server/dist/deployment-cli.js recovery /private/config.json
```

The CLI reads the token file itself. `POST /runs` accepts only
`{requestId,planId,planSha256}` and returns HTTP 202 with an accepted run.
The same ID and input returns its existing record without executing again;
different input for the ID is rejected. Another concurrent deployment or an
unresolved run is rejected rather than secretly queued. A succeeded exact plan
is not executed under another ID.

`GET /runs/:id` returns its durable receipt; `GET /runs` returns summaries.
`GET /recovery` lists unresolved runs, malformed/unpublished claims and the
service-policy guard. `GET /health` describes the deployment service, not a
successful deployment. A successful read/CLI exit is not a successful run:
inspect `state`, `phase`, `attentionRequired`, `checks` and `error`.

There is no need to keep an Agent generating while a run progresses. This
version does not send completion notifications; read the ID when the result is
needed rather than scheduling an Agent polling loop.

## Exit, cutover and acceptance

After preparation the controller creates a durable policy journal and a
`zzzz-cockpit-deployment.conf` drop-in beside the owned host unit. It blocks
startup with `ConditionPathExists` and temporarily sets `Restart=no`. It then
uses `systemctl --user stop --no-block`: `KillMode=mixed` sends SIGTERM to the
host main process, whose existing graceful-exit handler drains protected work.
There is no timeout that forces that host to exit.

After actual exit and acquisition of the host lifetime lease, the controller
takes the **final** configuration/role/module-data baseline, including legitimate
writes made while the old host was finishing. SQLite uses online backup with
committed WAL; ordinary files and directories are flushed before migration.
Preflight runs again against the final copy. Module selection changes atomically
and preserves configuration/enablement; the current host symlink switches only
after data checks pass.

Only then is the startup block removed for the new host. `Restart=no` prevents a
failed package from looping. After successful acceptance the original unit policy
is restored without restarting the accepted host. Unknown guards or changed
unit sources are never overwritten.

Acceptance checks release/source and actual process/instance identities, health
and running shutdown state, inventoried Web/module assets (including the bounded
worker prefix), enabled module identities/errors, preserved configuration,
ordinary files, database integrity/foreign keys/schema and declared projections.
Disabled modules do not need to be active. Model prompts, real ask_user answers,
microphones, device push and subjective UX are explicitly not covered.

## Cancellation and manual recovery

`POST /runs/:id/cancel` (body `{}`), or CLI `cancel CONFIG REQUEST_ID`, is allowed
only before the shutdown commitment. Accepted cancellations prevent the later
host stop, including a concurrent durable phase write. After that boundary,
cancel is rejected: it cannot undo shutdown or migration.

Failures before shutdown do not switch the old host. After shutdown has been
committed, failures can leave the host stopped, guarded or running a rejected
candidate. No package/database rollback, replay or forced continuation occurs.
Keep all original installations, private backups and receipts.

A controller restart marks started unfinished runs `interrupted` and blocks new
work. A torn initial claim is retained separately; valid history and recovery
reads remain available. Never delete a receipt/claim or choose a new state root
to bypass uncertainty. A missing HTTP response is not evidence of no effects.

Stop the deployment user unit before inspecting/recovering a migration worker;
verify its cgroup has exited. Inspect the receipt, `backup/manifest.json`,
database integrity/schema and any guard. Resolve data or package problems only
under separate, explicit operator authorization. Restoring an old backup can
discard later writes and is never automatic.

If the host is startup-blocked, do not simply remove the block and launch the
old version. First establish that the selected code and data schema are a safe
pair. An operator may then remove only the recorded `host-start-blocked` file
and start the chosen user unit. Preserve the policy journal and drop-in until
the running installation has been inspected.

The explicit acknowledgement operation checks a fresh running host instance and
keeps the original failed/interrupted result:

```sh
node --enable-source-maps apps/server/dist/deployment-cli.js \
  acknowledge CONFIG REQUEST_ID RECEIPT_SEQUENCE OBSERVED_HOST_INSTANCE_ID "Reason describing the reviewed effects and repair"
```

It does not repair data or rerun the deployment. It restores the recorded user
unit policy only when the owned guard and original unit sources still match,
then records the operator acknowledgement and releases the attention flag.
Unknown/changed guard files need manual investigation, not blind retries.
The equivalent `POST /runs/:id/acknowledge` requires
`{confirmation:"effects-reviewed",sequence,instanceId,reason}`.

For a genuinely unpublished claim, use `acknowledge-claim CONFIG REQUEST_ID
CLAIM_FINGERPRINT OBSERVED_HOST_INSTANCE_ID REASON` after inspection. The HTTP
equivalent is `POST /claims/:id/acknowledge` with
`{confirmation:"effects-reviewed",fingerprint,instanceId,reason}`.
Its bytes and ID remain reserved forever; acknowledgement never makes that ID
executable. Corrupted published records are not unpublished claims.

When the service itself is unavailable:

```sh
node --enable-source-maps /fixed/runtime/apps/server/dist/deployment-cli.js \
  read-receipt /private/deployment-state REQUEST_ID
```

State and backups contain private configuration/data. Do not publish them as
general logs. Retention/cleanup is a separate operator decision, never part of a
successful deployment.

## Verification and limits

The supported boundaries and opt-in **isolated user-unit** tests are in
[testing](testing.md#deployment-service). A fixed released archive can be checked
without production data; tests of generated packages do not establish a real
Release identity. Local source tests, publication, installation and enabling this
service remain distinct actions.

The default bounds include a 1 GiB compressed/expanded host archive,
100,000 runtime/backup entries, the module installer's own limits and a
configurable per-module backup budget (10 GiB by default). Request, start and
migration-hook waits are bounded; graceful host stopping is not force-timed.
SQLite integrity work can still be substantial, and capacity must be planned.
No distributed locking, cross-Node/native-SDK migration, arbitrary system service,
automatic rollback, MCP trigger or caller notification is promised.
