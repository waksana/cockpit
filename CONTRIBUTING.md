# Contributing to Cockpit

English and Chinese issues and pull requests are welcome. Cockpit is a small,
experimental **0.x**, single-operator project. Keep changes focused; discuss
substantial behavior or architecture changes in an issue before implementing them.

## Before you start

- Read the [current architecture and scope](docs/cockpit-plan.md) and
  [product requirements](docs/product-requirements.md). Planned modules are not
  currently installable features.
- For setup, use the [source installation guide](docs/DEPLOY-PORTABLE.md#from-source):
  Node **24.20.0**, pnpm **10.34.5**, and the frozen lockfile.
- The [development guide](docs/DEVELOPMENT.md) owns engineering commands and
  workflow details. The [testing guide](docs/cockpit-testing.md) owns test selection
  and isolation. Link to these guides rather than duplicating their contracts.

## A small pull request

1. Fork the repository if needed. Create a short-lived branch from current `main`;
   do not develop inside a running installation.
2. Make one coherent change, with regression tests for changed behavior and updates
   to the [canonical documentation](docs/README.md). Do not change product semantics
   merely to satisfy a stale test.
3. Run the smallest relevant existing checks from the testing guide. Report exact
   commands and results, including failures, skips and what was not tested.
   Documentation-only changes need link, anchor and factual checks, not unrelated
   builds or native sessions.
4. Open a PR against `main` explaining the problem, scope and evidence. Use
   descriptive commits; no special commit prefix is required. Integrate updated
   `main` when required checks need a fresh base.
5. Resolve review conversations and obtain the green **`Required checks`** status
   (`CI / Required checks` in the workflow). A maintainer checks scope and evidence
   before merging. A second-person approval is not mandatory for this
   single-maintainer project.

Main requires PRs, up-to-date required checks and resolved conversations; force
pushes and deletion are disabled. Merged contribution branches are deleted.
Do not weaken a check or bypass these rules to hide a failure. CI uses isolated
fixtures, read-only PR permissions and no production credentials. A green PR is
not permission to deploy.

## Safe development and reports

Use synthetic workspaces, sessions and providers for validation. Never point tests
at real user history, a production service or another contributor's native home.
Do not submit credentials, tokens, cookies, MCP secrets, session transcripts or
screenshots of real conversations. Redact logs and use a minimal synthetic
reproduction. Keep generated archives, local configuration and review scratch
files out of commits. Clean up only resources you created.

For Web chat changes, use the maintained
[Chat Lab](docs/DEVELOPMENT.md#isolated-chat-component-review), which imports the
production components with synthetic inputs. Do not add a parallel chat app.

- **Bug:** use the [bug report form](https://github.com/waksana/cockpit/issues/new?template=bug_report.yml)
  with version/source SHA, OS/architecture/libc, Node, SDK/runtime versions,
  reproduction steps and redacted output.
- **Feature:** describe the user problem, current limitation and a small proposed
  scope in the [feature form](https://github.com/waksana/cockpit/issues/new?template=feature_request.yml).
- **Security:** do not open a public issue; use the [private reporting policy](SECURITY.md).

## Versions and releases

Only Web/backend/MCP from the same release are supported. During 0.x, the baseline
is a fresh installation, without old API aliases or automatic migration.
Breaking changes still require a new public version and clear release notes.
Workspace packages are internal parts of Cockpit, not separately supported SDKs.

The [release procedure](docs/packaging.md#versioned-releases) owns version changes,
tags and publication: green main → `vX.Y.Z` → full checks/native smoke/build/package
→ publish the exact checked archive and checksum. It does **not** deploy to a
production host. Only maintainers publish releases.

Contributions are distributed under [GPL-3.0-only](LICENSE), the project's existing
license. Preserve relevant third-party licenses and [attribution](NOTICE.md).
