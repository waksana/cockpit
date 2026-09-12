# Consumer installation and explicit main-program updates

This CLI manages a **new, core-only**, single-user Linux x64/glibc installation.
It manages the Cockpit main process, not business modules. It does not adopt
private-CD deployments, alter systemd/DNS/TLS/Passkey, edit global MCP settings,
or move native Copilot storage. Publishing is a separate
[publisher operation](consumer-publishing.md).

## Breaking boundary

The core-only installer uses consumer authority **schema version 2**, main
release metadata **schema version 2**, and a runtime declaration with
`mainLifecycleApi: 1` and `dataCompatibility: "cockpit-core-user-root-v2"`.
Earlier authority markers and runtime contracts are explicitly rejected.
There is no module runner, module restore plan, or old-runner adoption path.

Do not rewrite an old marker to bypass this boundary. Retain old directories,
credentials, operation receipts and business data. Before a separately
authorized replacement, use the original installation's controls to stop its
owned processes and resolve unknown ownership; do not force-kill or infer
absence from a failed status request. Initialize distinct empty install/user
roots for this version. Native-home reuse also requires exclusive ownership:
never run two backends against the same native home.

This is a source/install contract, not a production migration or deployment
instruction for an existing instance.

## Prerequisites

* Linux x64/glibc, Node **24**, Python **3.12+** with `tarfile.data_filter`.
  The exact Node patch must match the package build manifest.
* A complete publisher package with locked platform dependencies, TS + tsx,
  SDK/runtime native assets and built Web resources. It is not a bundled Node
  executable and does not install Node, Python or operating-system libraries.
* Canonical, owner-only, writable, separate install/user/native roots and an
  unused unprivileged loopback port (default 8771). The install root's Unix
  control socket path must fit within 100 bytes.
* A launcher outside the backend's native sessions, kept alive by an independent
  terminal/service arrangement. Submitting an update and then waiting in the old
  active backend turn can prevent native safe-idle exit.
* Independently configured authenticated remote access. Loopback control and
  owner-only files are not a sandbox against other programs of the same user.
  Gateway authentication must not be removed to make updates work.

`COCKPIT_HOME` identifies native storage (default `~/.copilot`). Initialization
records that absolute reference; it does not create, copy, back up, migrate or
roll back native storage. Required writable configuration and credentials remain
operator prerequisites.

## Obtain a trusted bootstrap

Obtain `scripts/verify-consumer-bootstrap.mjs` from trusted operator media or a
reviewed checkout, not from an archive you have not verified. Supply an
independently pinned public Ed25519 key and expected full source SHA:

```sh
node verify-consumer-bootstrap.mjs \
  "$BOOTSTRAP_ZIP" "$BOOTSTRAP_SIGNED_JSON" "$PINNED_PUBLIC_KEY_FILE" \
  "$EXPECTED_FULL_SOURCE_SHA" "$NEW_BOOTSTRAP_DIRECTORY"
```

The verifier checks the signature, source SHA, digest and size before extracting
the fixed bounded installer file set. The bootstrap uses Node built-ins and
Python; it does not require Git, pnpm, developer credentials or private CD.
Never substitute `curl | sh` or a same-source untrusted checksum for publisher
authentication.

Provide the channel configuration with a pinned **public**, not private, key:

```json
{
  "metadataUrl": "https://publisher.example/stable.signed.json",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "allowedDownloadOrigins": ["https://publisher.example"]
}
```

Public releases download anonymously by default. A private source can optionally
add an absolute owner-only `tokenFile` for the consumer's own download identity.
It is not a publisher or deployment credential. Bearers go only to the initial
metadata origin, never to the redirected CDN. Metadata/archive fetches require
HTTPS, explicit download origins, bounded redirects, timeouts and sizes.
Authentication, network or verification failure is explicit, with no silent
retry, cached-release fallback or TLS bypass.

### HTTPS hosting and GitHub Release assets

A normal HTTPS host can serve immutable main ZIPs and a fixed signed metadata
URL. It must return raw bytes, not an HTML repository or Release page.
For public GitHub Releases, a stable discovery configuration is:

```json
{
  "metadataUrl": "https://api.github.com/repos/OWNER/REPO/releases/latest",
  "metadataAssetName": "stable.signed.json",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "allowedDownloadOrigins": [
    "https://api.github.com",
    "https://release-assets.githubusercontent.com"
  ]
}
```

An explicit `releases/tags/channel-stable` URL is also supported. Private
repositories add their own optional read-token reference. The signed main
target's URL identifies the numeric release asset API, not a browser page.
See [private publishing order](consumer-publishing.md#private-github-asset-publishing-order).

Discovery reads at most 1,000,000 JSON bytes and 1,000 assets. It requires the
configured repository's exact release/asset identities, a non-draft release,
the requested tag or stable latest release, unique asset names/IDs and the
exact configured metadata filename. Repository redirects and ambiguous matches
are rejected. Metadata is limited to 400,000 bytes; archives to 400 MiB.
Metadata and archive bytes use `Accept: application/octet-stream`.

The unsigned discovery list only locates metadata. Pinned-key signatures,
validity times, increasing sequence and same-sequence envelope digest still
authorize the release. A changed URL or renewed expiry requires a new sequence.
When `metadataAssetName` is absent, a fixed raw-envelope URL remains supported,
but replacement of a numeric asset requires an explicit pointer change.

## Initialize and start the launcher

Choose empty, separate installation and user roots:

```sh
node "$NEW_BOOTSTRAP_DIRECTORY/cli.mjs" init \
  --root "$INSTALL_ROOT" --user-root "$USER_ROOT" \
  --channel "$CHANNEL_JSON" --port 8771
node "$INSTALL_ROOT/launcher/cli.mjs" serve --root "$INSTALL_ROOT"
```

`init` rejects nonempty roots, symlink ancestors, overlapping roots, competing
selectors and private-CD authority. It never overwrites an earlier installation.
`serve` starts only the stable launcher; it does not adopt or start a backend.

```text
INSTALL_ROOT/
  authority.json                  # explicit v2 installation identity
  launcher/                       # stable Node/Python installer
  releases/<archive-sha256>/       # immutable complete main packages
  current.json                    # sole atomic main selection
  checks/ downloads/ operations/ staging/
  assets/                         # retained hashed Web assets
  launcher.lock/ control.sock runtime.json known-good.json

USER_ROOT/
  .consumer-installation.json
  consumer-config.json            # channel, public trust, optional token reference
  logs/main.log
```

The launcher does not create module program/config/data directories or read old
role and service records. Ordinary Cockpit preferences, uploads and native
storage keep their existing paths and overrides; they are not release payload.

## Explicit check, download, install and restart

```sh
node "$INSTALL_ROOT/launcher/cli.mjs" check \
  --root "$INSTALL_ROOT" --id check-example-001
node "$INSTALL_ROOT/launcher/cli.mjs" download \
  --root "$INSTALL_ROOT" --id download-example-001 \
  --check check-example-001 --version 0.1.0
node "$INSTALL_ROOT/launcher/cli.mjs" install \
  --root "$INSTALL_ROOT" --id install-example-001 \
  --download download-example-001
node "$INSTALL_ROOT/launcher/cli.mjs" status \
  --root "$INSTALL_ROOT" --id install-example-001
```

Use the actual version from the verified check. Installation validates the
archive, immutable manifest, entry files and staged tsx before draining anything.
It refuses incompatible data/config declarations. Then it requests the owned
main's native drain over instance-bound parent IPC, waits for a clean exit,
atomically changes selection, starts the new child, and checks matching
`/version`, health and lifecycle readiness. It preserves prior code and assets.

`restart --root "$INSTALL_ROOT" --id restart-example-001` uses the same safe
drain but retains the selected release. Web and MCP use
`system/consumer/restart {operationId, confirm:true}` and
`system/consumer/status {operationId?}` through that same launcher.
Source/private-CD installations report consumer control unavailable; they do
not fabricate an installation. Main download/install remains CLI-only.
`stop` drains and stops the owned main and closes the launcher.

Acceptance is not completion. Inspect the original operation ID after timeout.
Same-ID requests return the retained receipt; conflicting inputs are rejected.
Unknown native drain is never replayed or hidden behind a new operation.
Busy sessions, queues, pending decisions and native attached resources can keep
the drain waiting. No force timeout or automatic crash respawn is provided.
Do not poll from an active old-backend turn that must finish before exit.

## Recovery and retention

`recover --id ORIGINAL_ID --action ACTION` supports only:

| Action | Required evidence and effect |
| --- | --- |
| `verify` | Read the same still-owned candidate's actual identity/health/lifecycle; never start a replacement. |
| `drain` | Ask a known candidate to drain only if its original native drain is not already uncertain. |
| `fallback` | Candidate confirmed exited; an actually known-good, data-compatible prior release exists. Switch code, not business data. |
| `abandon` | No live/unknown candidate; retain evidence and restore a compatible previous selection or remove an uncompleted first selection. |

The retired runner `restore`/`continue` recovery actions are not supported.
`reconcile-download` validates already-present bytes without downloading again.
`unlock` and `unlock-channel` require the previous recorded owner to be absent;
they do not adopt a child, replay a request or resolve unknown spawn evidence.

No automatic checks, downloads, installs, business initialization, message
replay or data rollback are enabled. Older releases, failed staging, user data,
logs and operation receipts are not garbage-collected by this implementation.
Code installation, main startup and a user's actual business outcome remain
different facts.
