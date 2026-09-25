# Module SDK

`@waksana/cockpit-module-sdk` is the public TypeScript contract for trusted
Cockpit modules. It is published independently from the host to
`https://npm.pkg.github.com` and contains compiled ESM JavaScript plus declaration
files. It does not contain React, host implementation code, the internal protocol
registry, or workspace/file dependencies.

The source of truth stays in this repository:
[`packages/module-api/src/index.ts`](../packages/module-api/src/index.ts) for the
backend and manifest surface, [`frontend.ts`](../packages/module-api/src/frontend.ts)
for Web API v2, and [`contract.ts`](../packages/module-api/src/contract.ts) for
shared public projections and runtime constants. The host imports these same
types and constants; modules must not copy them.

## Install from GitHub Packages

Configure the `@waksana` scope without writing a token into the repository:

```ini
@waksana:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then install an explicit SDK version:

```sh
NODE_AUTH_TOKEN=... npm install --save-dev @waksana/cockpit-module-sdk@0.1.1
```

For a private package, a developer token needs `read:packages` and repository
access. A GitHub Actions workflow may use `GITHUB_TOKEN` only after the package
grants that repository read access; set `NODE_AUTH_TOKEN: ${{ github.token }}` and
use `actions/setup-node` with `registry-url: https://npm.pkg.github.com`. Never
commit `.npmrc` credentials, a personal access token, or generated auth files.

React and its type declarations are peers because frontend modules reuse the
host's React instance. Backend-only modules do not load React at runtime. A module
with a frontend should develop against a supported `react` and `@types/react`
version without bundling React into the module.

## Build and verify

From a clean Cockpit checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @waksana/cockpit-module-sdk build
pnpm --filter @waksana/cockpit-module-sdk test
pnpm --filter @waksana/cockpit-module-sdk pack --pack-destination sdk-output
```

The pack test installs the generated archive into an isolated npm consumer,
imports its runtime constants, compiles a TypeScript consumer, and rejects
workspace/file dependencies or source-only output. Missing peers or an invalid
package fail explicitly; there is no source-checkout fallback.

## Versions and compatibility

SDK semver is independent from the Cockpit host version. A host bump does not
require an SDK bump. Change the SDK version only when its published package
changes, applying ordinary semver to the public contract. Host implementations
may add capability fields while keeping an API version stable; modules must check
the documented capability member before using it and fail clearly when a required
capability is absent.

An SDK version is not proof that every host version supports a module. Module
releases still record and test their exact host compatibility in the
[module catalog](modules.md) and their own release material. Pin the SDK version
used to build a module, run consumer pairing tests against the intended host, and
do not infer compatibility by comparing host and SDK version numbers.

## Independent release

Only maintainers release the SDK, after the exact commit passes required checks:

```sh
git fetch origin
git tag -a module-sdk-vX.Y.Z VERIFIED_MAIN_SHA -m "Cockpit module SDK vX.Y.Z"
git push origin module-sdk-vX.Y.Z
```

The `Release module SDK` workflow reruns required checks, requires the tagged SHA
to be on `main`, rebuilds and packs that tag, and verifies the
`module-sdk-vX.Y.Z` tag, commit, package name, package version, registry and
standalone closure. It publishes with the repository `GITHUB_TOKEN` and only
`packages: write`; it does not persist the token. GitHub Packages does not
document npm provenance for restricted packages, so this workflow deliberately
does not request unsupported `--provenance`/OIDC behavior. The tag is separate
from host `vX.Y.Z` tags and does not create a host GitHub Release, deploy Cockpit,
change package visibility, or grant package access. Never move or reuse a
published tag/version; fix a failed or incorrect release with a new SDK version.
