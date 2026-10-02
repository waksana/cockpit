# Module SDK

`@waksana/cockpit-module-sdk` is the public TypeScript contract for trusted
Cockpit modules. It targets independent npm releases to
`https://npm.pkg.github.com` and contains compiled ESM JavaScript plus declaration
files. It does not contain React, host implementation code, the internal protocol
registry, or workspace/file dependencies.

The source of truth stays in this repository:
[`backend.ts`](../packages/module-api/src/backend.ts),
[`manifest.ts`](../packages/module-api/src/manifest.ts) and
[`frontend.ts`](../packages/module-api/src/frontend.ts) own the module APIs.
Shared wire types are generated from the host's canonical protocol schemas through
the explicit [public projection](../packages/protocol/src/module-sdk-projection.ts).
The generated `wire.ts` is checked in for review, not edited by hand.
[`contract.ts`](../packages/module-api/src/contract.ts) owns the recursive module
payload and invocation metadata; the host imports these instead of copying them.
Only flattened public declarations enter the SDK, not Zod or the internal intent
registry.

After changing a projected schema, run `pnpm sdk:generate`. SDK builds and CI reject
a stale projection. Generation rejects unresolved/internal type references and
normalizes property/union ordering so inference order is not an API change.

## Install from GitHub Packages

Configure the `@waksana` scope without writing a token into the repository:

```ini
@waksana:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Before migrating a consumer, confirm that the chosen version is available from
the registry to both the developer and the consumer's CI identity. A source
version, Git tag, or successful local pack does not establish publication or
package access. Do not merge consumer dependencies on an unavailable version.

Set `SDK_VERSION` to that verified version and install it exactly (not as npm's
default semver range):

```sh
npm install --save-dev --save-exact "@waksana/cockpit-module-sdk@${SDK_VERSION:?Set a verified published SDK version}"
```

Supply `NODE_AUTH_TOKEN` through the environment. GitHub Packages
[requires authentication even for public npm packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages);
a developer personal access token (classic) needs `read:packages` and access to
the package. A GitHub Actions workflow may use `GITHUB_TOKEN` only after the
package grants that repository read access; set `NODE_AUTH_TOKEN: ${{ github.token }}` and
use `actions/setup-node` with `registry-url: https://npm.pkg.github.com`. Never
commit `.npmrc` credentials, a personal access token, or generated auth files.

Commit the dependency and lockfile together, retaining the resolved package
integrity. The public entry points have separate environment requirements:

| Import | Surface | Consumer requirements |
| --- | --- | --- |
| `@waksana/cockpit-module-sdk` | Common wire, manifest and invocation types; constants | No React or Node types |
| `@waksana/cockpit-module-sdk/backend` | Backend activation, routes and host calls; common exports | `@types/node` 22 through 25 for TypeScript |
| `@waksana/cockpit-module-sdk/frontend` | Web API v3 public components and owner drafts, explicit legacy v2 types; common types | Matching React / `@types/react` 18 or 19 and DOM types |
| `@waksana/cockpit-module-sdk/runtime` | Runtime constants only | No peers |

Environment peers are optional at installation because a consumer need not use
every entry point. Install the peers for the entry points you compile; missing
required declarations fail type checking. A backend consumer does not need
React. A frontend consumer uses the host's React instance and must not bundle
another React/ReactDOM. Optional does not mean an incompatible installed peer is
supported.

The supported compiler baseline is TypeScript 5.9.3 (5.9 series), in NodeNext or
Bundler resolution mode. ESM is the runtime format; there is no CommonJS entry.
Backend and frontend types moved out of the root entry in the breaking SDK
change recorded in [`changes.json`](../packages/module-api/changes.json).
Update those imports to `/backend` or `/frontend`, not to private `dist` paths.

## Build and verify

From a clean Cockpit checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @waksana/cockpit-module-sdk build
pnpm --filter @waksana/cockpit-module-sdk test
pnpm --filter @waksana/cockpit-module-sdk pack --pack-destination sdk-output
```

The pack test starts from locked consumer fixtures, runs `npm ci`, then installs
the actual tarball with normal peer resolution. It uses no workspace links,
`--legacy-peer-deps`, or `skipLibCheck`. The matrix covers peer-free common types,
Node 22/current Node type consumers, React 18/19 frontends, both resolution modes,
and peer-free runtime imports. It also rejects private deep imports and unwanted
archive contents. Fixture lockfiles pin the exact compiler, peers and integrity.
This is local package-consumption evidence, not registry authentication evidence.
Consumer CI must separately exercise an authenticated, frozen-lockfile registry
install without a host-source or local-tarball fallback.

## Versions and compatibility

SDK semver is independent from the Cockpit host version. A host bump does not
require an SDK bump. Change the SDK version only when its published package
changes, applying ordinary semver to the public contract. Host implementations
may add capability fields while keeping an API version stable; modules must check
the documented capability member before using it and fail clearly when a required
capability is absent.

Record each SDK version decision in
[`packages/module-api/changes.json`](../packages/module-api/changes.json).
During 0.x, incompatible changes require a minor bump; compatible additions
also use a minor bump, and compatible fixes may use a patch bump. At 1.x and
later, incompatible changes require a major bump. Raising the minimum compiler
or removing a supported peer version is a compatibility change, not just a
development-tool update.

PR CI compares SDK source, runtime constants, package metadata and compiler
configuration with the exact base commit. Changes require a newer SDK version
and a matching change record; host-only changes do not. To run this gate locally:

```sh
node scripts/check-sdk-changes.mjs EXACT_BASE_COMMIT_SHA
```

The gate enforces the recorded version decision; it does not infer behavioral
semver automatically. Review public meaning and capability changes as well as
type signatures. Change records describe source preparation, not successful
publication. Release identity checks and an actual registry install remain
separate requirements.

The Web v3 migration exports `frontendApiVersion = 3` from the frontend bundle
before activation, checks `publicComponentsVersion: 1`, `draftOwnerVersion: 1`
and `draftSubmissionVersion: 2`, and returns `apiVersion: 3`. Host compatibility
keeps unmodified v2 entries native-only; generic drafts never reach their schema
or composer wrappers. See the canonical [owner/recovery contract](module-contract.md#draft-owners)
before implementing an adapter. The SDK publishes types, not a second React
component implementation or a browser store.

The compatible Web v3 page addition has its own `pageVersion: 1` check and
`ModulePage` / `ModuleNavigation` types. It does not change the frontend API
major, legacy v2 or global-component behavior. See
[module pages](module-contract.md#module-pages) for URL ownership, navigation,
activation and revocation. SDK types alone do not prove a host advertises
`page.v1` in its deployment descriptor.

Selection-time role checking requires `roleAvailabilityVersion: 1` and the
`roleAvailability.v1` deployment capability. The optional
`roleAssignments.availability` hook and `roles/availability` public host call
return structured denials and unknown checks, not a reservation. See
[selection availability](module-contract.md#selection-availability).
The source addition in `changes.json` does not publish the SDK; consumers must
wait for a separately authorized registry release before depending on it.

Safe in-process service shutdown additionally requires
`context.shutdownVersion === 1` and the `shutdown.v1` deployment capability.
`context.stopping` announces quiescence; returning `onStop` opts into awaited
drain before native/transport teardown. Legacy `dispose` alone remains best-effort.
See [safe module shutdown](module-contract.md#safe-module-shutdown) for the exact
settlement-call boundary, 60-second fail-closed policy and late-completion rules.
Check capabilities on the actual host; an installed SDK does not establish them.

Backend prompt correlation requires `promptReceiptVersion: 1`, independently of
SDK version. The `prompt` result's optional `messageId` preserves the native
acceptance receipt, not the event UUID or an assistant message ID. Follow
[prompt receipt attribution and native limits](module-contract.md#prompt-receipts-and-interaction-attribution)
before consuming output from a shared session; ask and terminal-event provenance
must not be inferred from current state.
Optional `McpInvocationMeta.toolCallId` preserves the native pre-MCP hook identity
for [exact tool-request attribution](module-contract.md#mcp-invocation-meta).
Require the field on the actual call; an SDK version cannot manufacture missing
native evidence.

Backend creation tool filtering is independently gated by `toolScopeVersion: 1`,
advertised as `toolScope.v1` in the host deployment descriptor. `session/new`
accepts an optional immutable explicit `ToolScope`; `session/tool-scope` returns
saved/applied configuration and actual native metadata without loading or
initializing. See [native session tool scope](module-contract.md#session-tool-scope)
for supported identity syntax, collision rejection, role intersection, native deny,
cold-load/fork limits and the unchanged allow-all permission policy. SDK types or
enabled MCP connections alone are not native filtering evidence.

`roleResourcePolicyVersion: 1` adds opt-in role-only resource assembly and
`promptOriginVersion: 1` adds body-free `promptAccepted` callbacks. See
[exclusive resources and native ingress](module-contract.md#exclusive-role-resources)
for lifecycle restrictions and the browser/module/API trust boundary.
Neither capability adds an alternative chat store or exposes private SDK
system-notification calls.

Complete ordinary conversation presentation is separately gated by
`messagePresentationVersion: 1`. The `messageList` and `chatMessage` component
types extend the same public directory while keeping `message` as the original
body middleware boundary. See [conversation presentation](module-contract.md#conversation-presentation)
for row identity, native provenance and layout ownership.

Shared Chat composition is independently gated by
`conversationPresentationVersion: 1`: `conversationFrame`, `conversationHeader`,
`conversationTranscript`, the host-provided `conversation.useScroll` React hook
and `ChatMessageProps.header`. These are controlled presentation contracts;
native sessions, pending-decision cards and request routing are not exposed.
See [shared Chat composition](module-contract.md#conversation-composition).
The SDK exports their types only; both native Chat and module pages use the
host's real implementations. The deployment capability is
`conversationPresentation.v1`, independent of package installation.

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
from host Rolling tags and does not create a host GitHub Release, deploy Cockpit,
change package visibility, or grant package access. Never move or reuse a
published tag/version; fix a failed or incorrect release with a new SDK version.
