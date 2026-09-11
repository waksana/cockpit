# Consumer installation and explicit main-program updates

This opt-in CLI path is for a **new**, single-user Linux x64/glibc installation.
It does not adopt the existing private-CD deployment, modify systemd, DNS, TLS,
Passkey, global MCP settings or native Copilot storage. The operator supplies the
trusted publisher/channel; no production signing secret or hosted publisher has
been provisioned by this implementation. See [publisher packaging](consumer-publishing.md).

## Prerequisites and boundaries

* Linux x64/glibc, Node **24**, and Python **3.12+** with `tarfile.data_filter`.
  The Node **patch version must equal the package build manifest**; the current
  CI toolchain is Node 24.20.0. The installer checks the OS/architecture/glibc,
  Node major, Python capability and writable canonical owner-only roots.
* The publisher's package includes locked platform dependencies, TS + tsx,
  native runtime assets and the built-in Web application. It is not a bundled
  Node executable and does not install Node, Python or distribution libraries.
  The staged server's own `tsx` must load before any running process is drained.
* An unprivileged, unused loopback port (default 8771), accessible to the
  launcher, is required. The application still listens on `127.0.0.1`.
  Remote use needs an independently configured authenticated gateway. This
  command neither provides nor removes such protection.
  Do not run two backends against the same native home under different ports;
  the operator must ensure exclusive backend ownership of that native home.
  This installer does not discover or rewrite another service's private policy.
* The dedicated launcher must remain outside native Copilot sessions and outlive
  the backend it updates. Run it from an independent terminal/service arrangement.
  Do not submit an update and then wait inside the old backend's active owner
  turn: submit once, end that turn, and inspect the same operation on a new entry.
* One Unix account is the trust boundary. Owner-only directories and the private
  Unix control socket are not a sandbox against other programs of the same user.
  Install roots must be short enough for the Unix socket path (at most 100 bytes).
* Native Copilot home remains where `COCKPIT_HOME` already points (default
  `~/.copilot`), recorded as an absolute reference at initialization. No native
  directory is created, moved, copied, backed up or rolled back by this tool.

## Obtain a trusted bootstrap

The publisher emits `cockpit-bootstrap.zip` and `bootstrap.signed.json` in
addition to the main archive/channel. Obtain the small
`scripts/verify-consumer-bootstrap.mjs` verifier from trusted operator media or a
reviewed source checkout—not from an unverified archive you are about to run.
Supply a pinned **public** Ed25519 key and an expected full source SHA out of
band. The verifier authenticates the bootstrap archive before safely extracting
its fixed file set into a new directory:

```sh
node verify-consumer-bootstrap.mjs \
  "$BOOTSTRAP_ZIP" "$BOOTSTRAP_SIGNED_JSON" "$PINNED_PUBLIC_KEY_FILE" \
  "$EXPECTED_FULL_SOURCE_SHA" "$NEW_BOOTSTRAP_DIRECTORY"
```

The extracted bootstrap uses only Node built-ins and Python; no `pnpm install`,
private CI/CD controller, publisher credential, Git checkout or root `tsx` is
needed. A reviewed checkout can also run `node scripts/consumer/cli.mjs` directly.
Never run `curl | sh` or trust a checksum from the same untrusted download as if
it authenticated its publisher.

Provide a local channel JSON file (the PEM contains the pinned **public** key):

```json
{
  "metadataUrl": "https://YOUR_RELEASE_HOST/stable.signed.json",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "allowedDownloadOrigins": ["https://YOUR_RELEASE_HOST"]
}
```

An optional `tokenFile` is an absolute owner-only regular-file reference for
**your own download access** to a private release repository. Its bearer is sent
only to the metadata origin, not to redirected asset hosts. Redirect origins
must be explicitly allowed. Transport rejects non-HTTPS URLs, digest/size
mismatch, expired metadata, old sequence floors and untrusted signatures.
Network failure means the latest version is unknown; there is no proxy,
TLS-bypass, source checkout or private-CD fallback.

### HTTPS hosting and GitHub Release assets

The minimum complete channel is a normal HTTPS file host: publish immutable
`releases/<source-sha>/cockpit-linux-x64.zip` and update the signed
`stable.signed.json` URL explicitly when publishing a new counter. Serve their
raw file bytes for `Accept: application/octet-stream`. A private host may
require the configured bearer on that same origin. No GitHub discovery or
private delivery controller is needed for this path.

For private **or public GitHub Releases**, the recommended stable configuration
uses an explicit metadata filename plus a single repository's release API:

```json
{
  "metadataUrl": "https://api.github.com/repos/OWNER/REPO/releases/latest",
  "metadataAssetName": "stable.signed.json",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "allowedDownloadOrigins": [
    "https://api.github.com",
    "https://release-assets.githubusercontent.com"
  ],
  "tokenFile": "/ABSOLUTE/OWNER_ONLY/consumer-download-token"
}
```

Alternatively, use
`https://api.github.com/repos/OWNER/REPO/releases/tags/channel-stable` for an
explicit named channel release. The consumer does not enumerate releases or
repositories, guess a metadata filename, or follow moving repository redirects.
Publish the same metadata asset name in each complete release. New checks of
the **unchanged** configured URL discover the new metadata asset ID; no per-release
consumer configuration edit is needed. Public repositories omit `tokenFile`.

The signed main target's `url` must similarly be
`https://api.github.com/repos/OWNER/REPO/releases/assets/MAIN_ZIP_ASSET_ID`.
For a private repository, use the consumer's repository-scoped read token
(for a fine-grained token, repository Contents read permission); don't substitute
a GitHub browser download page and assume that it accepts API bearer auth.
Discovery sends `Accept: application/vnd.github+json`; it reads at most
1,000,000 JSON bytes and 1,000 asset entries. It requires the configured repository's
exact numeric release identity (and the requested tag, when configured), a
non-draft release, unique asset names/IDs, and exactly matching `metadataAssetName`.
Every listed asset URL must be a numeric `api.github.com/repos/OWNER/REPO/releases/assets/<id>`
URL for that same repository, with matching asset ID, uploaded state and valid
size. External URLs, browser-download links, missing/duplicate/malformed
matches, discovery redirects and wrong-repository identities fail closed.
An API redirect while fetching the selected metadata asset cannot change that
asset's repository or numeric identity.

The discovered list is **not publisher authentication**. Only the original
pinned-key signature, metadata validity and counter/digest checks authorize a
release. Discovery never changes those checks or selects an install target from
the unsigned GitHub response. The metadata asset retains its 400,000-byte bound.

Metadata and archive bytes use **exactly** `Accept: application/octet-stream`
and support direct 200 bytes or 302 redirects. Those binary-resource redirects
may reach only the configured download origins (the initial metadata origin is
also permitted); no wildcard CDN discovery is installed. Bearer authorization
is sent only to the initial metadata origin, never to the asset CDN.

`metadataAssetName` is optional; when absent, ordinary HTTPS raw-envelope URLs
and fixed GitHub metadata asset API URLs keep their existing behavior. A fixed
numeric metadata URL still requires an operator pointer update if replaced;
use the explicit discovery configuration above to avoid that limitation.
Asset names must be safe exact filenames (letters/digits first, then
letters/digits/dot/underscore/hyphen, at most 200 characters), not patterns.
Main `consumer-config.json.channel` and module host configuration's
`values.releaseChannel` use the same strict option/type validation. Point each
at its own correctly signed main or module envelope; discovery does not merge
the main target schema with module roles. See
[private GitHub publishing order](consumer-publishing.md#private-github-asset-publishing-order).

Verification on 2026-09-11 used the real public
`api.github.com/repos/cli/cli/releases/latest` endpoint with explicit asset name
`gh_2.100.0_checksums.txt`, through this shared discovery code and without
credentials: JSON **200**, selected asset API `/releases/assets/542974244`
**302**, then the explicitly configured CDN **200** with 1,971 checksum-file
bytes. That public file is deliberately **not** accepted as signed metadata.
Signed-sequence discovery and private-token behavior are separately covered by
main/module fixtures, including changing asset IDs, signature/expiry/floor
failures and zero bearer forwarding to the CDN. This is
**not** a claim that any production private repository or its credentials were
tested or configured. The wire behavior follows
[GitHub's Get a release asset contract](https://docs.github.com/en/rest/releases/assets#get-a-release-asset).

## Initialize separate roots

Choose an empty new installation root and empty new user root. Defaults are
`~/.local/share/cockpit-consumer` and `~/.cockpit`, respectively.

```sh
node "$NEW_BOOTSTRAP_DIRECTORY/cli.mjs" init \
  --root "$INSTALL_ROOT" --user-root "$USER_ROOT" \
  --channel "$CHANNEL_JSON" --port 8771
```

The command refuses nonempty/unmarked directories, symlink roots, overlapping
installation/user/native roots, private-CD environment markers and competing
`current` selectors. An existing `~/.cockpit` is **not** silently adopted; choose
another fresh user root or plan a separately authorized migration. Unsetting a
private-CD environment variable is not authorization to take over its root.
Re-running `init` does not overwrite an existing installation.
Both roots and their existing ancestors are checked before the first directory
creation, including missing leaves below existing or dangling symlinks.

```text
INSTALL_ROOT/
  authority.json                  # explicit consumer installation identity
  launcher/                       # stable, dependency-free launcher/updater
  releases/<archive-sha256>/       # immutable complete main packages
  current.json                    # sole atomic main selection, not private-CD current
  checks/ downloads/ operations/ staging/
  assets/                         # retained old hashed Web assets
  launcher.lock/ control.sock runtime.json known-good.json

USER_ROOT/
  .consumer-installation.json     # binds exactly this installation
  consumer-config.json            # pinned channel and optional credential path
  modules/ module-config/ data/ logs/
```

The main program's ordinary `config.json`, modules and business data remain
under the user root. The updater changes only its own management records,
program releases, retained static assets and its main/runner logs.

## Start the external launcher and explicitly install

In a separate terminal, keep the stable launcher running:

```sh
node "$INSTALL_ROOT/launcher/cli.mjs" serve --root "$INSTALL_ROOT"
```

This starts only the launcher. It does **not** adopt an existing backend or
runner. Initial installation starts the separate module runner from the
verified main archive, then the first main child; no module business service is
automatically started:

```sh
# Three separate actions; IDs must remain unchanged when inspecting uncertainty.
node "$INSTALL_ROOT/launcher/cli.mjs" check \
  --root "$INSTALL_ROOT" --id check-20260911-01
node "$INSTALL_ROOT/launcher/cli.mjs" download \
  --root "$INSTALL_ROOT" --id download-20260911-01 \
  --check check-20260911-01 --version 0.1.0
node "$INSTALL_ROOT/launcher/cli.mjs" install \
  --root "$INSTALL_ROOT" --id install-20260911-01 \
  --download download-20260911-01
```

Use the actual version from the verified check. `install` returns promptly with
a retained operation ID; **accepted is not installed/healthy**.

```sh
node "$INSTALL_ROOT/launcher/cli.mjs" status \
  --root "$INSTALL_ROOT" --id install-20260911-01
node "$INSTALL_ROOT/launcher/cli.mjs" status --root "$INSTALL_ROOT"
```

Operation receipts are historical evidence. The second command makes an
on-demand live `/version` + `/health` check and reports current health separately
from the last startup receipt. It never substitutes Git HEAD or private-CD
history for a consumer process.

An update repeats the same three explicit actions with new intentional operation
IDs and the desired version. Nothing enables periodic checking, automatic
download/installation or role reapplication.

The retained floor binds **both the counter and signed-envelope digest**.
Reusing a counter with different signed metadata is rejected without replacing
the accepted floor. Download, download reconciliation and activation require
the current counter's exact envelope; they cannot silently use older metadata
after a higher counter was accepted. Re-reading an original operation ID is
historical receipt readback, not a new download or activation authorization.
An older counter-only state cannot be silently bound to a newly supplied
same-counter envelope; an explicit check must accept a strictly higher signed
counter before downloads/installations can proceed.

### What activation does

1. Revalidates the signed target and unchanged downloaded ZIP. ZIP must contain
   exactly one bounded `runtime.tar.gz`; the reviewed toolkit extractor and
   inventory validator are reused. Ordinary dependency paths containing spaces
   work. Hard links, escaping paths/symlinks and privileged modes are rejected.
2. Stages a new immutable release, checks full inventory/source/toolchain,
   consumer compatibility and server-local `tsx`, and retains Web assets
   without overwriting different content at an old asset name.
3. For an owned running backend, checks its exact current identity, sends
   **one** `POST /admin/restart {"pending":true}`, then waits for its actual
   child exit. The backend's authoritative native lifecycle protects turns,
   queues, decisions, subagents and MCP operations. There is no force deadline,
   queue drop, context reset, database busy scan or retry of the mutation.
4. Rechecks signed authorization after drain, atomically replaces `current.json`,
   and starts the new child through TS + tsx from the immutable server directory.
5. Requires matching consumer authority, installation ID, archive digest, source
   SHA, version, operation/request ID and fresh instance ID from `/version`,
   followed by healthy `/health` for that same instance. Process creation, HTTP
   acceptance and an old healthy process cannot complete the operation.

`consumer-runtime.json` explicitly declares no automatic data migrations and a
compatibility class and `"moduleRunnerApi": 1`. A changed class or unsupported
runner API is rejected **before drain**. This is a
publisher/operator compatibility promise, not a universal schema migration
engine. The installation records that class before its first child starts and
does not erase it on failure/abandonment; an unhealthy first boot cannot make
existing live data appear fresh for an incompatible later package.
Releases, configuration references, old MCP entry paths and hashed Web
assets are retained; there is no automatic garbage collection or business-data
rollback.

### Module runner ownership

The stable launcher starts exactly one separate runner using the first verified
archive's `packages/core/src/modules/supervisor-entry.ts` and server-local `tsx`.
Its user root and main loopback URL are fixed. Readiness requires parent IPC
API1, the actual child PID/Linux process identity, private lock instance UUID,
and the private socket's device/inode identity. Main/backend boot never spawns
or adopts a runner. Existing sockets/locks and uncertain old process records
are refused, not removed or adopted.

The same runner and explicitly started Task/WeChat children survive main
restart/update. The runner continues referencing its original immutable main
release, which is retained. New main releases must promise compatibility with
resident runner API1; this launcher does not upgrade/replace that runner or
support automatic cross-API migration. After an explicitly successful full
stop, a later launcher/main start can create a fresh runner from the selected
compatible release. `status` reports `moduleRunner`, including process/instance,
source selection, and live module statuses; `module-runner.json` retains its
provenance and shutdown receipt.

The launcher only reads module status and requests **idle-only runner shutdown**
over its owned parent IPC. It never sends module start/apply/stop commands,
signals the runner, reloads MCP connections, or reapplies session roles.
Use the existing module controls to explicitly start and stop business services.
A runner crash or changed identity is `unknown`, never an automatic respawn;
launcher close/unlock cannot silently abandon that state. Operator investigation
is required; no adoption or force-recovery command is provided.

## Safe stop, restart and recovery

Restart the **same installed release** without stopping its external launcher:

```sh
node "$INSTALL_ROOT/launcher/cli.mjs" restart \
  --root "$INSTALL_ROOT" --id restart-20260911-01
```

The launcher binds this stable ID to its currently owned child and exact
installed selection, checks integrity/compatibility, asks `/admin/restart` for
native safe drain once, confirms a clean actual exit, and starts that same
selection with a fresh instance. Success requires exact version/archive/source
and same-instance health readback. It does not check/download/install a release,
change the selector, close the launcher, or automatically respawn a crashed or
unknown process. The command returns its receipt promptly rather than waiting
for the old backend's owner turn to finish.

Repeating the **same** restart ID only reads the retained receipt—even when
pending or unknown—and never sends another drain. A new ID cannot bypass an
unresolved operation. A crash/nonzero exit while draining is `unknown`, not
permission to restart automatically. Explicit existing recovery remains a
separate operator action and cannot replay an uncertain old-child drain.

Graceful full stop first refuses if any module service, job, or recovery
uncertainty remains. Explicitly stop modules through their normal controls first.
It next asks the owned runner to close **only if still idle**, over parent IPC,
and confirms both acknowledgement and actual exit 0. Only then does it request
native main drain. The launcher closes after the backend also exits. This order
keeps Web available when a concurrent module start makes the atomic idle-close
refuse:

```sh
node "$INSTALL_ROOT/launcher/cli.mjs" stop \
  --root "$INSTALL_ROOT" --id stop-20260911-01
```

A module/job that appears between the status preflight and idle-close can still
refuse runner shutdown. A known idle refusal completes that stop as failed,
without draining the backend; launcher, runner, Web and module remain available.
Unknown IPC/exit results likewise do not drain the backend, but keep
the original operation unresolved and readback-only: changing IDs never resends
an uncertain shutdown. Other close errors are not assumed to have had no effect.
Once idle-close succeeds, module controls are unavailable while native main drain
waits for existing work; no module can be started through the closed runner.

SIGINT/SIGTERM to the launcher requests the same safe stop when no operation is
active; additional signals do not force a busy operation. The child has its own
process group so a terminal interrupt is not forwarded around the native gate.
Do not use a service-manager configuration that kills the whole cgroup after a
short timeout. Automatic system-service installation is intentionally absent.

After a machine reboot or clean standalone backend exit, start the launcher and
explicitly start the selected release:

```sh
node "$INSTALL_ROOT/launcher/cli.mjs" start \
  --root "$INSTALL_ROOT" --id start-20260912-01
```

The launcher deliberately does not automatically respawn crashes or silently
adopt orphaned processes. The raw `/admin/restart` endpoint remains **drain-only**;
calling it directly outside a launcher operation still requires explicit
`start` after exit. Consumer host UI/API must use the dedicated restart seam
below, or disable the old consumer-mode restart button until wired. Do not
redirect `/admin/restart` into that seam: the launcher itself calls this native
drain endpoint, so doing so would recurse.

An unhealthy new child that is **still alive** is retained, not killed and not
replaced. Startup timeout reports `unknown`. Recover on the **original**
installation operation:

```sh
# Read-only identity/health recheck; can confirm a late healthy startup.
node "$INSTALL_ROOT/launcher/cli.mjs" recover \
  --root "$INSTALL_ROOT" --id install-20260911-01 --action verify
# Explicitly request that exact owned candidate's native safe drain, once.
node "$INSTALL_ROOT/launcher/cli.mjs" recover \
  --root "$INSTALL_ROOT" --id install-20260911-01 --action drain
# Only after actual exit, restore actually known-good compatible code.
node "$INSTALL_ROOT/launcher/cli.mjs" recover \
  --root "$INSTALL_ROOT" --id install-20260911-01 --action fallback
```

Fallback is allowed only when a previous release has real successful startup
evidence and the same data/config compatibility class. No database or user file
is restored. Failed fallback remains unknown; it is not successful recovery.
`--action abandon` can close a failed operation **only after known child exit**,
restore a compatible previous selector without starting it, or remove the
selector when no known-good release exists. It retains receipts/releases/data.

If a launcher crashes, a durable PID + Linux process-start-time + boot-ID lock
prevents a second launcher adopting its still-running backend. `unlock` refuses
while either original process exists. After both are proven absent:

```sh
node "$INSTALL_ROOT/launcher/cli.mjs" unlock --root "$INSTALL_ROOT"
node "$INSTALL_ROOT/launcher/cli.mjs" serve --root "$INSTALL_ROOT"
```

Interrupted operations remain `unknown` and need explicit original-ID recovery.
A spawn whose child PID was never durably recorded cannot be inferred safe:
the CLI stops for operator investigation rather than manufacturing absence.
It provides no force-unlock/adopt/kill command.
An uncertain **old** backend drain is not sent again by recovery. Only a newly
started, exactly identified owned candidate can receive an explicit recovery
drain; each process instance receives at most one such request.

If a download finished writing but its receipt was interrupted,
`reconcile-download --root "$INSTALL_ROOT" --id ORIGINAL_DOWNLOAD_ID` verifies
the existing file and signature without making another network request. It
refuses a possibly live writer or incomplete/corrupt file. An interrupted
channel-check lock can be removed with `unlock-channel` only after its recorded
process is proven absent; previous check receipts remain unchanged.

## Backend integration and validation

The minimal consumer runtime seam is `apps/server/src/delivery-identity.ts`:

```text
COCKPIT_CONSUMER_SHA
COCKPIT_CONSUMER_ARTIFACT
COCKPIT_CONSUMER_REQUEST
COCKPIT_CONSUMER_INSTANCE
COCKPIT_CONSUMER_INSTALLATION
```

The launcher additionally supplies `COCKPIT_CONSUMER_ROOT`, an absolute canonical
private root. Backend integration imports the typed, dependency-free helper
from the packaged `scripts/consumer/cli.mjs`:

```js
// Consumer branch only; operationId comes from the validated, stable-ID request.
import { restartConsumer } from '../../../scripts/consumer/cli.mjs';
const receipt = await restartConsumer(operationId);
// Return this acknowledgement, never wait here for drain/startup completion.
```

`restartConsumer` takes no client-provided root. It resolves the launcher's
environment root, rejects private-CD environment markers, and verifies the
authority marker's installation ID and user root against the captured
`COCKPIT_CONSUMER_INSTALLATION` / `COCKPIT_USER_ROOT` environment. The lower-level
seam is `callLauncher(root, {action:"restart", operationId})`, with a root obtained
only through `consumerRootFromEnvironment()` in a host API. `callLauncher`
automatically includes the marker's installation ID; the private socket
validates it against its own bound installation before any action. Do not expose
arbitrary `root`, environment overrides, or a generic control body as public
request fields. Test-only environment injection is not a public API feature.

`/version` exposes existing identity fields plus `authority:"consumer"` and
`installationId`; `/health` uses the same captured instance. Private-CD fields
retain their existing shape and behavior. Mixed authorities fail startup.
`/system/versions` must remain unavailable for consumer private-CD status rather
than fabricate a private delivery success. CLI status is the consumer authority;
UI/protocol consumer-update integration is a separate parent integration.
No server/UI route was changed by the restart implementation: the parent must
wire the consumer-mode button/API to this seam (with a stable operation ID), or
explicitly disable that button. The private-CD branch remains unchanged.

```sh
node --test scripts/consumer-lifecycle.test.mjs \
  scripts/consumer-identity.test.mjs scripts/consumer-transport.test.mjs \
  scripts/package-consumer-release.test.mjs
```

Fixtures run real isolated child processes and HTTP endpoints, real ZIP/tar
extraction, signatures, immutable directories, busy drain, startup identity and
safe fallback. Their simulated native busy flag and minimal tsx package are
**not** real SDK or production acceptance. The optional publisher actual-archive
test is skipped without its documented inputs. Final fixed-SHA package/native
acceptance, publisher provisioning and production deployment remain separate,
explicitly authorized work.
