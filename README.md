# Cockpit

Cockpit is a web UI and API service for GitHub Copilot, built as a **host plus
optional modules**. The host provides sessions, chat and native configuration;
modules add features such as file attachments and notifications. You can install
existing modules or write your own against the public frontend and backend APIs.

[Install](docs/install.md) · [Modules](docs/modules.md) · [Build a module](docs/module-contract.md) · [All docs](docs/README.md)

## The host

Pick a project directory in the browser, start or continue a session, read replies
and expand tool calls, thinking and subagent work. While work runs you can queue
messages, stop it or answer the agent's questions. Session settings cover model,
reasoning effort and context tier; MCP servers and Skills are managed separately.

![Workspace: sessions on the left, subagent and tool details in the middle, model settings on the right](docs/images/workspace.png)

*Switch sessions on the left, follow messages and execution in the middle, adjust the session's model on the right.*

![Answering the agent: pick an offered choice or type your own answer](docs/images/answering.png)

*When the agent needs input, pick a choice or type an answer. Both screenshots are
rendered from real UI components with synthetic data.*

The host uses Copilot through the official SDK; sessions, history and execution state
remain Copilot's. Web and API share one service, and other agents can reach the same
backend through the bundled [stdio MCP client](apps/mcp/README.md). HTTP/MCP and Web
entry points differ; `/capabilities` lists the full API.

## How extensions work

A module is a local `.tgz` with a `cockpit.module.json`; it can include backend
JavaScript and frontend ESM/CSS. Modules ship separately and are never enabled by
default.

| Where | What it can do | How |
| --- | --- | --- |
| Frontend | Enhance the input, messages and session state; add actions to the global/session menus; render drafts, links and images. | Shares the host's React and theme via menu declarations, component middleware, state services/draft schemas and Markdown renderers. |
| Backend | Serve module HTTP routes, observe native events, manage its config and data, send events to its frontend. | Loaded in the host Node process with its own route namespace and data directory, on the same port and SSE connection. |

![Extension structure: one module package plugs into the browser and the server; the host reaches native Copilot through the SDK](docs/images/extensions.svg)

For example, the File module adds picking, pasting and dropping files to the input
and handles uploads and downloads in its backend, while sending still uses the host's
native API. The Notification module shows unread state on messages and the session
list and handles push in its own backend and browser worker.

Modules are **trusted local packages with cold loading**: install, version choice,
enable and disable take effect at the next cold start. There is no hot loading,
sandbox, remote-URL install, generic page registration or per-module HTTP MCP.
Cockpit modules are distinct from Copilot MCP servers, Skills and plugins.

See the [module contract](docs/module-contract.md) for the package format and APIs, and
the [module UI guide](docs/module-ui-guide.md) for styles, icons and a runnable example.
Available modules and which host versions they pair with are listed only in the
[module catalog](docs/modules.md).

<a id="install"></a>
## Install and run

Follow the [install guide](docs/install.md). Cockpit supports Linux; Windows is
possible through WSL2 (unverified). The Web UI defaults to `http://127.0.0.1:8771`.

Or give this prompt to an agent:

```text
Find the latest Cockpit release at https://github.com/waksana/cockpit/releases/latest.
Read the install guide for that release: docs/install.md on main
(https://github.com/waksana/cockpit/blob/main/docs/install.md); for older tags
without it, read docs/DEPLOY-PORTABLE.md at that tag. Install and start Cockpit on
this machine as the guide describes.

Also read the module catalog: https://github.com/waksana/cockpit/blob/main/docs/modules.md.
Before installing, introduce each module's purpose, main limits and whether it is
compatible with the chosen host version. Ask me about each installable module
separately, one at a time; installing none is fine. Only describe modules that are
not installable. Install only the modules I choose, using their paired releases.

Download the package and checksum for that one version; never mix files or modules
from different versions. If an installation is already running, tell me first and
do not overwrite or stop it. If sign-in is needed, guide me through it on this
machine; never ask me to paste a token into chat. When done, give me the URL and say
which modules are installed, which are actually loaded, and what still needs
configuration or authorization.
```

Cockpit is for a single operator on a trusted machine; it has no multi-user isolation
or built-in web login. Native tool permission is `allow-all`, so remote access must go
through an authenticated HTTPS entry, never an exposed unauthenticated port. See
[remote access](docs/install.md#remote-access) and the [security policy](SECURITY.md).

[Docs](docs/README.md) · [Releases](https://github.com/waksana/cockpit/releases) · [Report an issue](https://github.com/waksana/cockpit/issues/new/choose) · [Contributing](CONTRIBUTING.md)

Licensed under [GPL-3.0-only](LICENSE); third-party sources and attributions are in [NOTICE](NOTICE.md).
