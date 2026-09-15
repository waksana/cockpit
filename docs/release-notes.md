# Cockpit 0.1.0

The first versioned release of the current Cockpit service: one package serving
the text Web client and HTTP/SSE API, with an optional stdio MCP client.

## Requirements

- Linux x64 with glibc; Node **24.20.0** is installed separately.
- Copilot SDK **1.0.13**, bundled runtime **1.0.83**, protocol **3** are included.
- Configure native Copilot authentication before use; the stock quickstart uses
  GitHub credentials. Custom-provider setup is not a validated quickstart path.
- Remote access requires an authenticated gateway; the service listens on loopback.

Download `runtime.tar.gz` and `runtime.tar.gz.sha256`, verify the checksum, then
extract into a new directory. From that directory:

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/index.ts
```

Open `http://127.0.0.1:8771`. See the installation and contribution guides in the
source tree at this tag for configuration, security boundaries and development.

## Scope and stability

This is experimental **0.x** software. Use Web, backend and MCP from the same
release. The supported baseline is a fresh installation; old API aliases,
clients and module packages are not compatibility targets. The current product
does not include a module loader, managed file uploads, voice or notifications.

The archive records its exact source commit and file inventory in
`runtime-manifest.json`. The checksum detects corruption; it is not an independent
publisher signature. Release publication does not deploy or restart any service.
