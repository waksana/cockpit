# Explicit consumer release publishing

This is an opt-in **publisher** command, not a deployment or a consumer updater.
It does not alter the existing private delivery workflows, register a signing
authority, publish a repository, or grant users private CD credentials.

The supported packaging host is Linux x64/glibc, Node 24, Python 3.12+ (including
`tarfile`'s data filter). The runtime's exact Node version must match the build
manifest. Use the current CI toolchain, not an arbitrary Node patch release.

Build and validate a fixed, clean source SHA using the existing CI configuration.
Run the existing packager, which produces `runtime.tar.gz` and its inventory:

```sh
node .delivery/toolkit/bin/package.mjs service-delivery.json "$NEW_BUILD_OUTPUT" "$BUILD_ID"
```

Do not build from the shared development worktree. `service-delivery.json`'s
committed artifact list is authoritative; it must include the consumer runtime
integration before a consumer release is issued. The package is still TS + tsx
with built-in Web and locked platform dependencies, not a standalone binary.
The main closure must include `consumer-runtime.json`, `scripts/consumer/`,
`packages/core/src/consumer/`, `.delivery/toolkit/lib/artifact.mjs` and the
existing `.delivery/toolkit/bin/extract.py`. The publisher refuses an archive
that lacks the no-automatic-migration compatibility declaration,
`"moduleRunnerApi": 1`, `"moduleRunnerLifecycleApi": 1`,
`packages/core/src/modules/supervisor-entry.ts`, or
bootstrap files (including `scripts/consumer/module-runner.mjs`); an old
private-CD package is not automatically a consumer release. Normal main
shutdown/restart/update safely drains owned modules and stops that runner before
main exits. A replacement starts a fresh compatible runner from the new
verified archive; it does not reuse a resident runner from an older release.
After main health, restoration uses exact owned service version/digest pins
captured by the previous confirmed host drain, not catalog role defaults or
activation permission flags. Main-only updates must not implicitly upgrade
module services or start merely installed modules. Old runner-only API1 archives lacking the lifecycle declaration
are not compatible with this lifecycle. All old source releases and runner
operation histories remain retained; there is no automatic release garbage
collection or business-data migration.

Supply a new publisher specification file:

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "sequence": 1,
  "issuedAt": "2026-09-11T12:00:00.000Z",
  "expiresAt": "2026-09-18T12:00:00.000Z",
  "version": "0.1.0",
  "sourceSha": "REPLACE_WITH_FULL_40_CHARACTER_COMMIT_SHA",
  "url": "https://YOUR_RELEASE_HOST/immutable-release/cockpit-linux-x64.zip"
}
```

Version must equal the packaged server version; timestamps above are examples,
not perpetual validity. Sequence must increase under the operator's channel
policy. The URL must identify immutable bytes and use HTTPS.

```sh
node scripts/package-consumer-release.mjs \
  "$NEW_BUILD_OUTPUT/runtime.tar.gz" "$PUBLISH_SPEC_JSON" \
  "$PROTECTED_ED25519_KEY_FILE" "$NEW_PUBLISH_OUTPUT"
```

The command wraps the **unchanged tar bytes** in a ZIP containing exactly
`runtime.tar.gz`, extracts it using the existing delivery extractor, verifies the
complete inventory/platform/toolchain/source SHA and main entry files, then
signs the ZIP's exact size and SHA-256. It writes `cockpit-linux-x64.zip`,
`stable.signed.json`, `cockpit-bootstrap.zip` and `bootstrap.signed.json` to an
exclusively created directory. The bootstrap contains only the small stable
Node/Python installer/launcher, extracted from that same verified main package;
its separate Ed25519 envelope binds kind, full source SHA, size and archive
digest. The independently trusted
[`verify-consumer-bootstrap.mjs`](../scripts/verify-consumer-bootstrap.mjs)
verifier requires an out-of-band expected source SHA and pinned public key
before extracting it. See [consumer setup](consumer-installation.md).
Existing output is
never overwritten. Failed attempts remain inspectable; the command neither
retries publication nor claims those files were published.

The signed envelope has the same Ed25519 payload/signature representation as
module releases. Its sole target is `moduleId: "cockpit"`; this is a **main**
target, not an additional installable module role. Remaining target fields are
version, platform, arch, nodeMajor, sourceSha, sha256, bytes and url. Consumer
verification must use the main-channel schema; the module-only role enum does
not include `cockpit`.

An operator provisions the real protected Ed25519 key and consumer pinned public
key out of band. This repository creates no production signing secret and
currently provisions no hosted signing or upload job. Publisher CI may invoke
the explicit command and upload its outputs using separately authorized release
publication credentials. Consumers only need their own optional download access
and pinned publisher trust, never our CD controller or deployment credentials.

## Private GitHub asset publishing order

Private GitHub consumption uses the numeric REST **asset API** URL, not the
browser download URL. The archive asset ID therefore needs to exist before the
final signed metadata names it. This can use the existing explicit packaging
command without changing the consumer archive format:

1. Produce a draft output from the fixed CI tar, using a syntactically valid
   planned HTTPS URL in the draft specification. Do **not** publish its draft
   `stable.signed.json`.
2. The separately authorized publisher uploads only the draft main ZIP to the
   immutable release and obtains its asset ID from the upload response.
3. Change the specification's URL to
   `https://api.github.com/repos/OWNER/REPO/releases/assets/MAIN_ZIP_ASSET_ID`.
   Run `package-consumer-release.mjs` into a different, exclusively new final
   output directory using the **same unchanged tar file**.
4. Require `cmp "$DRAFT/cockpit-linux-x64.zip" "$FINAL/cockpit-linux-x64.zip"` to
   succeed. If bytes differ, stop: the final signature must not describe a
   different already-uploaded artifact. No uploaded bytes are replaced and no
   failed publication is automatically retried.
5. Upload only the final signed metadata (under the stable exact name
   `stable.signed.json`) and signed bootstrap outputs. Prefer preparing these
   assets in an authorized **draft** release, then publishing/marking it latest
   only once every required asset is fully uploaded.
6. Configure the consumer once with the pinned public key, its own optional
   private read-token reference, and:
   `metadataUrl: "https://api.github.com/repos/OWNER/REPO/releases/latest"`,
   `metadataAssetName: "stable.signed.json"`. Future complete releases preserve
   that metadata filename; the consumer discovers their new numeric metadata
   asset IDs without changing its configured source.

The second pass changes metadata, not the main tar/ZIP bytes. This is explicit
local packaging, not a retry of a deployment or uncertain upload. The publisher
still owns release publication credentials and permission; this implementation
does not publish, create repositories or issue credentials.

An explicit `/repos/OWNER/REPO/releases/tags/channel-stable` metadata source is
also supported with the same `metadataAssetName`. It is useful for a named
channel release carrying the current signed metadata while immutable main ZIPs
remain in their own releases. Replacing that channel asset changes its ID but
not consumer configuration. A temporary missing asset or incomplete publication
fails the check; clients do not silently fall back to a cached list or retry.

The discovery JSON is unsigned location information, not trust: clients still
require the pinned signature, valid timestamps, nondecreasing counter and exact
same-counter envelope digest. Every new metadata payload, including a renewed
expiry or changed target URL, needs a new counter. The main and module channels
use separate appropriate envelope schemas; the optional discovery field works
for both, without discovering third-party plugins or unrelated repositories.

Existing fixed numeric metadata asset URLs remain usable when
`metadataAssetName` is omitted, but those fixed references do not discover new
metadata IDs. A normal HTTPS file host remains an alternative. See the exact
configuration and identity/redirect limits in
[consumer installation](consumer-installation.md#https-hosting-and-github-release-assets).

Targeted validation:

```sh
node --test scripts/package-consumer-release.test.mjs
# Optional: exercise a real already-built CI tar using fixture-only signing:
COCKPIT_CONSUMER_RUNTIME_ARCHIVE="$ABSOLUTE_RUNTIME_TAR" \
COCKPIT_CONSUMER_PUBLISH_SPEC="$ABSOLUTE_MATCHING_SPEC" \
  node --test scripts/package-consumer-release.test.mjs
```

Synthetic fixtures cover exact ZIP/tar format, dependency paths containing
spaces, trusted signatures, immutable outputs and refusal of altered inventory,
wrong SHA/version, stale metadata, HTTP URLs and exposed key files. Tests also
verify and initialize the extracted standalone bootstrap without repository
imports or `node_modules`. The optional
real-archive test is explicitly skipped unless both inputs are supplied.
