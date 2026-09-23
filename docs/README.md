# Cockpit documentation

Start with [install](install.md); choose modules in the [catalog](modules.md); build
modules with the [module contract](module-contract.md).

## Use

| Page | Contents |
| --- | --- |
| [Project overview](../README.md) | What the host does, how extensions work, screenshots. |
| [Install and run](install.md) | Release or source install, Copilot sign-in, first chat, remote access, WSL2, troubleshooting. |
| [Module catalog](modules.md) | Available modules and the **only** host/module version table. |
| [MCP client](../apps/mcp/README.md) | Register the stdio MCP client so other agents use the same backend; API discovery; fork. |
| [Release notes](release-notes.md) | Current source version only; earlier versions are in [GitHub Releases](https://github.com/waksana/cockpit/releases). |
| [Security policy](../SECURITY.md) | Single-operator trust boundary, remote authentication, private reports. |

## Build modules

Read the [frontend guidelines](frontend-guidelines.md) before any host or module UI
work. Suggested path: [public TypeScript contract](module-contract.md#public-api-map)
→ [minimal frontend](module-ui-guide.md#executable-minimal-frontend) →
[package and local install](module-contract.md#local-install).

| Page | Contents |
| --- | --- |
| [Module contract](module-contract.md) | Package format, cold loading, backend API, Web extension mechanisms, data boundaries, module ID migration. |
| [Module UI guide](module-ui-guide.md) | Public styles, menu capability checks, theme variables, icons, composition, runnable example. |
| [Public types](../packages/module-api/src/index.ts) | Backend API; [frontend.ts](../packages/module-api/src/frontend.ts) for the Web API. |

## Internals

| Page | Contents |
| --- | --- |
| [Architecture](architecture.md) | Repository map, host/SDK/module responsibilities, native authority, error codes, auth, shutdown, target gaps. |
| [Product requirements R1–R8](product-requirements.md) | Confirmed positioning, boundaries and accepted costs; not a claim that every target is implemented. |
| [Native chat](native-chat.md) | Native events, cursors, history/live/reconnect, the Web reading window, media. |
| [Frontend guidelines](frontend-guidelines.md) | Native-first UI principles, minimal JS, truthful state, review checklist. |

## Contribute

| Page | Contents |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Reports, branches, pull requests, CI, review, license. |
| [Development](development.md) | Quickstart, repository map, Chat Lab, documentation rules. |
| [Testing](testing.md) | Choosing existing commands, isolation and cleanup. |
| [Releasing](releasing.md) | Runtime packages, manifests, CI, versions and tagged releases. |

## Sources of truth

| Question | Authority |
| --- | --- |
| What the product should do | Confirmed R1–R8; unconfirmed proposals are never written as requirements. |
| What the source does | The current commit and its verification; docs are corrected to match. |
| What the API accepts | [`Intents` and schemas](../packages/protocol/src/index.ts) and a running instance's `GET /capabilities`. |
| How the API fails | [`ErrorCodes`](../packages/protocol/src/errors.ts); see [error codes](architecture.md#error-codes). |
| What a package contains | [Releasing](releasing.md), package/lock files and the actual `runtime-manifest.json`. |
| What an instance runs | Its `/version`, `/health` and package identity. |
| Which versions pair | [Module catalog](modules.md) and GitHub Releases. |

Source docs describe `main`; for an older package read the docs at its tag. A
requirement/implementation mismatch is an explicit gap
([target gap](architecture.md#target-gap)), never a silent change to either. The
machine-readable transport list includes operational endpoints; it does not make each
one a public product intent or unauthenticated. Maintenance rules are in
[development](development.md#documentation-rules).
