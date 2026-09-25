# Building and releasing

This page owns the runtime package, its identity, the delivery version rules and
the release procedure. Users install packages with the [install guide](install.md).

## Build a package

Build and package from one clean, committed checkout (Git, the locked pnpm and GNU tar required):

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/package-runtime.mjs --source-sha "$(git rev-parse HEAD)" --output runtime-output
```

The output must be a new, plain direct child of the repository root (default
`runtime-output`). Existing or linked outputs, a dirty tree and a mismatched HEAD
are refused, and failures leave no partial archive. The result is
`runtime.tar.gz` plus `runtime.tar.gz.sha256`. The packager does not rebuild or
vouch for an arbitrary existing `dist`. `pnpm deploy` inside it is only pnpm's
portable dependency export, performed offline from the shared lockfile; the
workspace injection/deduplication settings and the lockfile must stay together
for that to work.

`pnpm build` compiles the server, core, protocol and MCP client to `dist/` with
source maps (shared settings in [`tsconfig.runtime.json`](../tsconfig.runtime.json));
the packager requires those outputs and the built Web. Entry points from an
extracted package root (no pnpm, checkout or TypeScript loader needed):

```sh
node --enable-source-maps apps/server/dist/index.js   # service
node --enable-source-maps apps/mcp/dist/index.js      # stdio MCP client
```

<a id="entry-point-upgrade"></a>
Packages built before this change started with
`node --import …/tsx/dist/loader.mjs apps/server/src/index.ts` (and the same loader
for `apps/mcp/dist/index.js`). Those loaders are no longer shipped: when deploying a
newer package, update every existing launch command — the service unit and each
Copilot MCP registration — to the commands above. The root `package.json` of a
package lists them as `start`, `start:mcp` and `module`.

The package also contains the local module CLI (`apps/server/dist/module-cli.js`).
The public [module SDK](module-sdk.md) is released separately to npm; its compiled
contract is also a host runtime dependency. Modules are released separately and
are never bundled with the host.

<a id="package-contents"></a>
## Package contents and identity

The archive keeps the workspace layout: compiled server, core, protocol and MCP
client JavaScript with source maps (workspace manifests are rewritten to resolve
`dist`), built Web without source maps, production dependencies including the
native Copilot SDK's platform assets, and LICENSE/NOTICE. It contains no
TypeScript loader (`tsx`/`esbuild`); the packager refuses a closure that does.
It excludes Node, user modules, `.cockpit` data, credentials, tests, fixtures,
development diagnostics, docs (except license files) and Git. It must run without
symlinks into a development tree.

The root `runtime-manifest.json` records `format: 1`, `product: "cockpit"`, the
version, the source SHA, Node version, platform, architecture and the file list.
The server refuses to start if the version, Node, platform or architecture differ.
`/version` reports the manifest `sourceSha` with the process instance ID; a source
checkout without a manifest reports `null` and never guesses from Git.

Package checks:

```sh
node --test scripts/package-runtime.test.mjs                                   # synthetic closure
COCKPIT_PACKAGE_PNPM_SMOKE=1 node --test scripts/package-runtime.test.mjs      # real offline dependency export
COCKPIT_RUNTIME_ARCHIVE="$PWD/runtime-output/runtime.tar.gz" \
  node --test scripts/package-runtime.test.mjs                                 # a specific archive
```

Cases whose variable is unset are skipped; a skip is not evidence about a real package.

## CI

`CI / Required checks` ([build.yml](../.github/workflows/build.yml)) runs on pull
requests, `main` pushes and release tags: frozen install, `pnpm lint`, `pnpm test`,
isolated native smoke tests, `pnpm build`, MCP fork smoke, packaging and archive
verification. It uploads a development artifact kept for 7 days — not a stable
download. Fork PRs get read-only permissions and no credentials.

<a id="delivery-versions"></a>
## Delivery versions

Ordinary commits do not bump versions. Before publishing or deploying a package
whose code, dependencies, assets or bundled docs changed since the last delivered
version, allocate a new version — also for installs from a fixed commit.
Docs outside the package do not require a new package.

The module installer binds a module ID/version to one archive digest: the same
digest may be reinstalled, a different digest requires a new version. Never
replace a version by changing the SHA, repacking, deleting the installed
directory, editing the manifest or bypassing verification. If an unintended digest
change appears, investigate reproducibility and recover the verified artifact, or
bump the version. Keep old installations for explicit rollback.

Choose versions by each repository's compatibility rules; not every change is a
patch. During 0.x, record incompatible changes and required host capabilities
explicitly. Modules and the public module SDK version independently; the host's
Web/backend/MCP, core and internal protocol package versions stay identical.
Published tags never move. See the [module SDK version rules](module-sdk.md#versions-and-compatibility).

Before each delivery:

1. Check the target's installed versions/digests and selection; the candidate
   version must be unused and built from a verified commit.
2. Update the host workspace versions (the MCP self-reported version is read from
   `apps/mcp/package.json`), the lockfile if needed and `docs/release-notes.md`.
   Do not change the independently versioned module SDK merely to match the host.
   `pnpm test` (via `scripts/check-release.test.mjs`) checks that they agree.
3. Build from one clean commit, run relevant checks and consumer pairing checks,
   and use CI on the latest head.
4. Verify digest and identity before installing; after restart confirm the loaded
   identity at `/version`. Do not disable integrity checks or delete data to succeed.

Development, merge, tagging/release and deployment are separate authorizations,
except that a joint deployment includes its
[release step](#release-after-acceptance).

<a id="release-notes"></a>
## Release notes

[`release-notes.md`](release-notes.md) holds **only the current workspace version**:
one `# Cockpit X.Y.Z` heading matching `package.json`, with no other version or
"Unreleased" sections. When the version changes, replace its content. Earlier notes
live in [GitHub Releases](https://github.com/waksana/cockpit/releases), which
publishes this file plus generated notes. `scripts/check-release.mjs` enforces the rule.

<a id="versioned-releases"></a>
## Release procedure

During 0.x only Web/backend/MCP from the same release are supported, as fresh
installs without old API aliases or automatic migration. Only maintainers release:

1. Merge a PR that updates versions and release notes as above.
2. Confirm `CI / Required checks` passed for that exact `main` SHA.
3. Tag it and push the tag:
   ```sh
   git fetch origin
   git tag -a vX.Y.Z VERIFIED_MAIN_SHA -m "Cockpit vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. The `Release` workflow reruns CI on the tag SHA, requires the SHA to be on
   `main`, verifies tag/workspace version, source SHA, Node/platform and checksum
   of that run's artifact, rechecks that the remote tag still points there, and
   publishes exactly that archive.

`v*` tags cannot be updated or deleted and the publisher never overwrites assets.
Fix a failed release with the next version, not by moving a tag. Release assets do
not expire with CI retention. A release does not deploy anything.

<a id="release-after-acceptance"></a>
## Release after a joint deployment

A joint deployment of the host and modules is complete only after every commit it
installed and accepted is tagged and released:

1. Tag each accepted `main` SHA with an annotated `vX.Y.Z` tag, following that
   repository's release procedure (the host's is [above](#versioned-releases)).
   A repository without a Release workflow publishes the unchanged main CI
   archive that was deployed.
2. Compare each Release asset's sha256 with the installed digest recorded at
   deployment. On a mismatch, stop: publish or replace nothing further and ask
   the user. Never overwrite assets or move tags.
3. Confirm each new Release is marked Latest.

Authorizing a joint deployment includes this release step. The deployment itself
still needs its own authorization; a release never implies one.
