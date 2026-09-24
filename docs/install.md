# Install and run

Cockpit ships as one service package: the backend, the built Web UI, the stdio
MCP client and their runtime dependencies. You provide Node, native Copilot
sign-in and, for remote use, an authenticated HTTPS gateway.

This guide is version-independent. Pick a release from
[GitHub Releases](https://github.com/waksana/cockpit/releases); optional modules
and their paired versions are listed in the [module catalog](modules.md).
Agents installing on a user's behalf: follow the prompt in the
[README](../README.md#install), ask before replacing or stopping an existing
installation, and never ask the user to paste a token into chat.

## Requirements

| Item | Requirement |
| --- | --- |
| Platform | **Linux x64 with glibc.** Windows: use [WSL2](#windows-wsl2). No native Windows, macOS, musl or arm64 runtime package is provided. |
| Node | The exact version recorded in the archive's `runtime-manifest.json` (`node` field); startup rejects any other version, including another patch. |
| Native sign-in | A GitHub account with Copilot access, signed in for the OS user that runs Cockpit. |
| Source builds only | Git and the pnpm version in `package.json` (`packageManager`). |

Install Node from the [official distribution](https://nodejs.org/dist/) and
verify it with `node --version`. Do not pipe install scripts from the web into a shell.

## Install a release package

Set `TAG` to the chosen release (for example the one marked *Latest*), then
download both assets from the same tag into a new directory:

```sh
TAG=vX.Y.Z   # replace with the release tag
mkdir cockpit-download && cd cockpit-download &&
curl --fail --location --remote-name "https://github.com/waksana/cockpit/releases/download/$TAG/runtime.tar.gz" &&
curl --fail --location --remote-name "https://github.com/waksana/cockpit/releases/download/$TAG/runtime.tar.gz.sha256" &&
sha256sum -c runtime.tar.gz.sha256 &&
tar -xOzf runtime.tar.gz ./runtime-manifest.json | grep -E '"(version|node|platform|arch)"' &&
mkdir cockpit && tar -xzf runtime.tar.gz -C cockpit && cd cockpit
```

Stop on any failure. The checksum detects corruption; it is not a publisher
signature. GitHub's auto-generated *Source code* archives have no dependencies
and cannot replace `runtime.tar.gz`. The package contains no Node binary,
credentials or session data; its contents are described in [releasing](releasing.md#package-contents).

After [signing in](#native-sign-in), start from the package root:

```sh
node --enable-source-maps apps/server/dist/index.js
```

Upgrading from a package that started through `tsx/dist/loader.mjs`? Update the
service and MCP launch commands; see [entry points](releasing.md#entry-point-upgrade).

<a id="from-source"></a>
## Install from source

Use a release tag (or an explicitly verified commit), not a moving `main`:

```sh
git clone https://github.com/waksana/cockpit.git cockpit && cd cockpit &&
git switch --detach "$TAG" &&
pnpm install --frozen-lockfile &&
pnpm build &&
pnpm start
```

Use the Node version pinned in [`.github/workflows/build.yml`](../.github/workflows/build.yml)
(`engines` in `package.json` is only a minimum). Do not update the lockfile to get
past an install error, and do not build into a directory a running service reads.
Contributors should use the [development guide](development.md) instead.

<a id="native-sign-in"></a><a id="native-authentication"></a>
## Native sign-in

Cockpit has no login of its own. [`OfficialRuntime`](../packages/core/src/runtime.ts)
starts the SDK's bundled runtime with `useLoggedInUser: true`, so it uses the
credentials already available to the OS user. The native directory follows
Copilot's defaults (normally `~/.copilot`, or `COPILOT_HOME`); `COCKPIT_HOME`
does not affect it.

- If this OS user already uses Copilot CLI, nothing else is needed.
- Otherwise save a credential once, following the upstream
  [authentication guide](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md)
  (its `main` may be ahead of the pinned SDK). No separate CLI is required: the
  bundled SDK's experimental `account.login` RPC validates and stores a token
  without creating a session. While saving, run no other Cockpit/SDK host on the
  same native directory. `storedInVault: false` means nothing was saved; `true` does
  not prove encrypted storage (native config may allow plaintext), and do not
  disable secure storage for convenience. GitHub Enterprise follows its own native
  auth docs. Keep tokens out of command arguments, shell history, repository files,
  logs and chat.
- Do not set `COPILOT_CLI_PATH` or replace the bundled runtime with a global CLI.
  The service checks the pinned runtime/protocol at startup and refuses others.
- Custom model providers (BYOK) are not configurable through Cockpit; see
  [architecture](architecture.md#authentication).

## First chat and checks

In another terminal:

```sh
curl --fail http://127.0.0.1:8771/health
curl --fail http://127.0.0.1:8771/version
```

`/health` answering `ok:true` means the service responds, not that a model call
will succeed; its `login` field may identify the account, so redact it in reports.
`/version` reports the package version and `sourceSha` from the manifest
(`null` for source checkouts; record `git rev-parse HEAD` instead).

Open **http://127.0.0.1:8771**, create a session in a trusted working directory
**on the server machine**, and send a short message. Creating a session sends
nothing by itself. Model access, quota or network failures are separate from
service health.

## Register the MCP client (optional)

Other agents can use the same backend through the bundled stdio MCP client.
Follow [Register with Copilot](../apps/mcp/README.md#register-with-copilot):
build or extract the package, **merge** a `cockpit` entry into the existing Copilot
MCP configuration (never overwrite the file), then start a new session and confirm
the tools appear and a read-only call such as `cockpit_list_sessions` works.

## Data, modules and configuration

`COCKPIT_HOME` (default `~/.cockpit`) holds only Cockpit's own data: module
selection `modules/config.json`, immutable code `modules/installed/` and module
data `modules/data/`. Native Copilot data stays where Copilot keeps it; never copy,
link or move it for Cockpit. If an old setup pointed `COCKPIT_HOME` at `~/.copilot`,
point it at a separate directory instead.

Install modules from the package root with the local CLI (in a source checkout,
`pnpm module …` is equivalent):

```sh
node --enable-source-maps apps/server/dist/module-cli.js \
  install /absolute/path/module.tgz --trust-local-code --enable
```

`--trust-local-code` authorizes the package to run inside the host process; it is
not signature verification or a sandbox. Changes apply on the next cold start.
See the [module catalog](modules.md) for available modules and the
[module contract](module-contract.md#local-install) for all commands.

<a id="user-instructions"></a>
### User instructions

Create `$COCKPIT_HOME/instructions.md` (at most 16 KiB) to append your own text to
every Cockpit session under a `## Cockpit user instructions` header, after native
and [module instructions](module-contract.md#default-instructions). A missing or
blank file means none. Cockpit never creates or edits this file. It is read only
when a session is created or resumed, so reload a session to apply edits; Copilot
CLI sessions are unaffected. For example, to prefer Chinese replies:

```text
与用户交流时尽量使用中文；代码、命令、标识符保持原样；仓库文档与提交信息按项目约定（目前英文）。
```

| Variable | Default and meaning |
| --- | --- |
| `COCKPIT_PORT` | `8771`; the server listens on loopback only. |
| `COCKPIT_HOME` | `~/.cockpit`; non-empty absolute path for Cockpit and module data. |
| `COCKPIT_SERVE_WEB` | On; `0`/`false` gives an API-only service. Without a Web `index.html` startup fails instead. |
| `COCKPIT_WEB_DIR` | `apps/web/dist` relative to the package or checkout. |
| `COCKPIT_ALLOWED_ORIGINS` | Extra comma-separated request origins accepted by the origin check. |
| `LOG_LEVEL` | Server log level. |

Cockpit installs no service unit. If you run it under a process manager, pass the
same user, home and environment you used for sign-in. Do not run two hosts
against the same native home.

<a id="remote-access"></a>
## Remote access

Cockpit is for one operator on a trusted host ([security policy](../SECURITY.md)).
Protect **every** route — Web, API, `/events`, `/chat/stream`, `/intent/*`,
`/health`, `/version` — with an authenticated HTTPS gateway. Loopback binding and
Origin/Referer checks are CSRF protection, not authentication. Never expose the
port through an unauthenticated tunnel.

Example single-operator nginx entry with Basic authentication (replace names,
certificates and the htpasswd file with your own; keep them out of the repository):

```nginx
server {
    listen 443 ssl;
    server_name cockpit.example.com;

    ssl_certificate /etc/nginx/certs/cockpit.example.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/cockpit.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    auth_basic "Cockpit";
    auth_basic_user_file /etc/nginx/private/cockpit.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:8771;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Connection "";
        proxy_set_header Authorization "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        gzip off;
    }
}
```

Keep the external `Host` so same-origin checks pass; do not strip Origin/Referer
or disable CSRF checks to make a proxy work. SSE needs buffering, caching and
compression off and long timeouts. Before opening it, confirm that every path is
rejected without credentials, the UI and events work after login, and 8771 still
listens only on loopback. The stdio MCP client authenticates with a bearer token,
so it cannot use a Basic-only entry; see [MCP configuration](../apps/mcp/README.md#configuration).

<a id="windows-wsl2"></a>
## Windows (WSL2)

Windows is supported only through WSL2, where Cockpit runs as on Linux.
**These steps are not yet verified on a real Windows machine**; report problems
through an issue.

1. Install WSL2 with an Ubuntu distribution (`wsl --install -d Ubuntu`) and work
   inside it.
2. Enable systemd in `/etc/wsl.conf`, then run `wsl --shutdown` from Windows:
   ```ini
   [boot]
   systemd=true
   ```
3. Keep the package, `COCKPIT_HOME`, `~/.copilot` and project working directories
   on the WSL ext4 filesystem (for example under `~`), **not** under `/mnt/c`:
   Windows drives are slow through 9P and lack the POSIX permission semantics
   that module storage checks rely on.
4. Install Linux Node, sign in and install Cockpit inside WSL exactly as above.
   Working directories and attachment paths are Linux paths.
5. Networking: in the default NAT mode, `http://localhost:8771` from Windows is
   forwarded to WSL. Mirrored mode (`networkingMode=mirrored` in `%UserProfile%\.wslconfig`,
   Windows 11 22H2+) also works. For remote access use the gateway above inside WSL.
6. WSL stops idle VMs. To keep Cockpit running, raise `vmIdleTimeout` in
   `.wslconfig` (and `instanceIdleTimeout` where supported) or start it from a
   Windows logon task with `wsl.exe --exec`.

References: Microsoft's WSL [networking](https://learn.microsoft.com/windows/wsl/networking),
[configuration](https://learn.microsoft.com/windows/wsl/wsl-config) and
[filesystem](https://learn.microsoft.com/windows/wsl/filesystems) guides.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Node or platform mismatch | `node --version` must equal the manifest `node`; Linux x64/glibc only. Never edit the manifest. |
| `Unvalidated Copilot runtime` | Unset `COPILOT_CLI_PATH`; use the bundled runtime. |
| SDK platform asset or `dist/index.js` not found | Download `runtime.tar.gz` (not a source archive), extract fully, start from the package root. Source: `pnpm install --frozen-lockfile && pnpm build`. |
| `…/tsx/dist/loader.mjs` not found in a package | The launch command predates compiled packages; use the [current entry points](releasing.md#entry-point-upgrade). |
| Web `index.html` missing | Source: run `pnpm build`. Package: re-download and extract. Do not hide it with `COCKPIT_SERVE_WEB=0`. |
| UI loads but no reply | Native sign-in, Copilot access, quota and network. `/health` does not test models. |
| `EADDRINUSE` | The port is taken. Do not kill unknown processes; stop the old host gracefully or choose `COCKPIT_PORT` for a separate native home. |
| Remote 401 / 403 | 401: gateway credentials. 403: external Host, Origin/Referer and `COCKPIT_ALLOWED_ORIGINS`. |
| Replies arrive in bursts or streams drop | Proxy SSE buffering, caching, compression and timeouts. Do not resend a prompt that may have been accepted. |

For bug reports, follow [CONTRIBUTING](../CONTRIBUTING.md#reports); never upload a native home.

## Shut down

`SIGTERM`, `SIGINT` or `POST /intent/system/shutdown` with `{"confirm":true}`
request a graceful exit that waits for native work to settle. There is no force
mode, and Cockpit does not restart itself. Semantics are in
[architecture](architecture.md#shutdown).
