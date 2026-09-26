# Building and releasing

This page owns host runtime packaging, immutable Rolling releases and in-place
Milestone promotion. Installation is covered by the [install guide](install.md).
The independently versioned [module SDK](module-sdk.md) has a separate workflow.

## Build a package

From one clean committed checkout, with Git, the pinned pnpm and GNU tar:

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/package-runtime.mjs --source-sha "$(git rev-parse HEAD)" --output runtime-output
```

The output must be a new, plain direct child of the repository root. Existing or
linked outputs, dirty tracked sources and a mismatched HEAD are refused. Failures
remove partial output. Development packaging produces `runtime.tar.gz` and its
checksum; it is not a Rolling Release. The packager does not rebuild or vouch for
arbitrary existing `dist`. Its offline `pnpm deploy` exports portable dependencies
from the locked workspace, not a running service.

`pnpm build` compiles server, core, protocol and MCP to `dist/` with source maps;
Web ships without source maps. Extracted packages need Node, but not pnpm, Git or
a TypeScript loader:

```sh
node --enable-source-maps apps/server/dist/index.js
node --enable-source-maps apps/mcp/dist/index.js
node --enable-source-maps apps/server/dist/module-cli.js
```

<a id="entry-point-upgrade"></a>
Older installations launched source via `node --import .../tsx/...`. When
installing a compiled runtime, change the service and MCP launch commands to the
entries above. Root package scripts also expose `start`, `start:mcp` and `module`.

<a id="package-contents"></a>
## Package contents and identity

The archive keeps workspace layout: compiled host JavaScript/source maps, built
Web, production dependencies including native Copilot platform assets, LICENSE
and NOTICE. Workspace exports resolve compiled files. Modules are not bundled.
No Node binary, `tsx`/`esbuild` loader, user data, configuration, credentials,
tests, development diagnostics or Git is included. Dependencies cannot point
outside the package.

`runtime-manifest.json` records format 1, product `cockpit`, version, source SHA,
Node/platform/architecture, SDK identity and a hashed inventory. The server
refuses mismatched package versions or platforms. `/version` reports the package
source and process instance; development checkouts display `dev+<shortSHA>`.

Every Rolling Release has **exactly four assets**:

| Asset | Contract |
| --- | --- |
| `runtime.tar.gz` | Checked runtime for the exact merged source SHA |
| `runtime.tar.gz.sha256` | SHA-256 of that archive |
| `cockpit-deployment.json` | Format 2, channel `rolling`, repository/tag/source/version/sequence, archive name and host API/capabilities |
| `cockpit-deployment.json.sha256` | SHA-256 of the deployment sidecar |

The descriptor is also at the archive root, byte-identical to the sidecar, and
included in the runtime inventory. It does **not** contain the archive checksum:
that would introduce self-reference. API and capability declarations are derived
from actual module activation contexts in host source, not a per-version local
catalog. Unknown or changed declarations fail closed. Modules own their own
database, preservation and explicit migration declarations.

Package checks:

```sh
node --test scripts/package-runtime.test.mjs scripts/rolling-release.test.mjs
COCKPIT_PACKAGE_PNPM_SMOKE=1 node --test scripts/package-runtime.test.mjs
COCKPIT_RUNTIME_ARCHIVE="$PWD/runtime-output/runtime.tar.gz" \
  node --test scripts/package-runtime.test.mjs
```

Unset opt-in cases skip; skips are not evidence about a real package. See
[test isolation](testing.md).

## CI

[`build.yml`](../.github/workflows/build.yml) runs `CI / Required checks` for PRs,
main pushes and reusable Rolling calls: frozen install, lint, tests, isolated
native smoke, build, MCP fork smoke, packaging and archive verification.
PR runs may supersede earlier runs of the same PR. Main/merged-PR builds use
unique run identities, never a shared pending-run slot. CI artifacts last 7 days;
GitHub Release assets do not expire with that retention.

<a id="delivery-versions"></a>
## Delivery versions

Host product manifests on `main` stay **`0.0.0-dev`**. Ordinary feature, fix, docs
and chore PRs do not bump versions or require a release label/preparation PR.
The SDK remains independently versioned. Do not commit a generated Rolling
version back to source.

After a real main merge, Actions packages an isolated Git snapshot and injects
`0.0.0-rolling.<sequence>` into host manifests there. Compiled server/MCP identity
reads those packaged manifests; Web receives the backend identity. The tag is
`v0.0.0-rolling.<sequence>`.

The sequence is **`github.run_number` of `.github/workflows/release.yml`**.
Its existing counter continues at the switch from legacy releases; it need not
start at 1 and gaps are valid. Never rename, delete/recreate or reset this workflow.
A rerun retains the original number, PR event, source and run ID. Lower-sequence
builds can finish late; consumers must select by sequence, not completion time,
publication time, API list order or Latest.

Installed versions bind to one archive digest. Never replace bytes under an
existing version, move tags, delete an installation to evade integrity checks,
or repack and upload a replacement. Retain previous installations for explicit
rollback.

<a id="release-notes"></a>
## Release notes

[`release-notes.md`](release-notes.md) describes only the current development
workspace. Published Rolling notes instead preserve the triggering PR's complete
title and body, followed by deterministic PR/build/source/sequence and all four
asset digests. The final machine-readable provenance record also seals the
original four GitHub asset IDs, names, sizes and digests for reruns and promotion.
Editing that record, title/body or assets
invalidates later verification.

<a id="versioned-releases"></a>
## Rolling release procedure

[`Rolling`](../.github/workflows/release.yml) handles `pull_request_target:
closed` on `main`, gated on `merged == true`. This permits merged fork PRs while
only checking out the trusted **merge commit**, never the unmerged head. The
untrusted PR text is read as data from the event JSON, not interpolated into shell.
No paths, labels or PR types are filtered. Closing without merging publishes
nothing. The change introducing this workflow is the switch point; historical
merges are not caught up and old manual `vX.Y.Z` tags no longer trigger it.

1. Merge a reviewed, green PR through normal branch protection.
2. The merge's independent Rolling run repeats required checks at its exact SHA,
   packages the isolated snapshot, verifies the four-asset contract, and passes
   that run's artifact to the publisher.
3. The publisher creates the immutable tag, creates a prerelease draft, uploads
   each asset once, downloads all four, checks source/version/inventory/checksums
   and embedded descriptor, and guards tag/Release/asset identities again.
4. It seals the verified original asset identities and publishes the same Release
   in one atomic PATCH as non-draft **prerelease**, with `make_latest=false`, then
   downloads and verifies again. There is no separate body-only draft PATCH.
   Ordinary Rolling does
   not claim Latest or deploy anything.

No global release concurrency group cancels or replaces older pending runs.
A failed build/publication is one failed attempt; it does not block later PRs.
Each HTTPS write has one attempt. A timeout/lost response is **unknown**, not a
reason to retry creation, upload or publication. Inspect the run and remote state.
An explicit rerun can retry a failed pre-publication build, or verify an already
published identical release without writes (including a promoted milestone).
It rejects changed identities and existing drafts; it never silently repairs,
replaces, reuploads or republishes them. Resolve uncertain/incomplete legacy
attempts only with separate explicit authorization, not automatic recovery.

## Milestone promotion

Run [`Milestone`](../.github/workflows/milestone.yml) on `main`, entering one
existing successful Rolling `tag` and the identical `confirm_tag`. For example:

```sh
gh workflow run milestone.yml --ref main \
  -f tag=v0.0.0-rolling.123 -f confirm_tag=v0.0.0-rolling.123
```

The example is not a selection recommendation. Promotion requires an explicit
user-selected tag. The workflow verifies the original successful Rolling run,
source/tag, provenance and all four original assets. It then changes **only**
`prerelease=false` and `make_latest=true` on the existing Release and verifies
again. It does not rebuild, renumber, retag, upload, alter title/body or create a
replacement. Missing, non-Rolling, draft, failed-run or changed assets are refused.
An uncertain promotion write is not retried. Rolling releases created before the
asset-ID seal was introduced remain unchanged and are not eligible for this
stronger promotion/rerun entry point; never add a seal retroactively or replace
their assets to bypass that guard.

<a id="release-after-acceptance"></a>
## Deployment boundary

Merge, Rolling publication, Milestone promotion and deployment are distinct.
A separately authorized external deployment service consumes compatible
verified releases, rejects sequence regressions and owns installation, backups,
explicit migration, restart and acceptance. It does not need a hand-edited catalog
for each merge. Release automation never contacts that service or modifies
production data. Deployment does not retroactively authorize tagging, replacing
assets or choosing a milestone.
