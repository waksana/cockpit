# Cockpit agent notes

Web UI and API host for GitHub Copilot, plus optional trusted modules. pnpm
workspace; TypeScript; Linux only.

## Commands (repository root)

- `pnpm install --frozen-lockfile`
- `pnpm build` · `pnpm test` · `pnpm lint` — what CI's `Required checks` runs
  (plus native smoke and packaging; see `.github/workflows/build.yml`).
- One package: `pnpm --filter @cockpit/<protocol|core|server|mcp|web> test`.
- Test selection: `docs/testing.md`. Dev server and Chat Lab: `docs/development.md`.

## Map

`packages/protocol` API schemas and `Intents` · `packages/core` Engine and native SDK ·
`packages/module-api` public module types · `apps/server` Fastify host and module
loader · `apps/web` React UI (read `apps/web/AGENTS.md`) · `apps/mcp` stdio MCP
client · `scripts` packaging/release checks · `docs` (index: `docs/README.md`).

## Safety

- Never touch a running installation: not port 8771, not the real `~/.copilot`,
  `~/.cockpit` or user sessions. Run servers and native tests with isolated
  `HOME`, `COPILOT_HOME`, `COCKPIT_HOME` and a free `COCKPIT_PORT`.
- Never commit credentials, tokens, transcripts or real screenshots.
- A green build is not permission to deploy, tag or bump versions.

## Docs

English only. One canonical page per topic; link instead of copying. Host/module
versions live only in `docs/modules.md` and GitHub Releases; `docs/release-notes.md`
holds only the current version (CI enforces this). Docs-only changes need link,
anchor and command checks, not builds. PR rules: `CONTRIBUTING.md`.
