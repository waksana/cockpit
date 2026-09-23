# Security policy

## Supported versions

Cockpit is experimental **0.x** software. Security fixes target the latest
[Cockpit service release](https://github.com/waksana/cockpit/releases/latest).
Older releases, old module packages and mixed-version
Web/backend/MCP combinations are not supported. See the
[version policy](docs/releasing.md#versioned-releases).

## Report privately

Use GitHub's **[Report a vulnerability](https://github.com/waksana/cockpit/security/advisories/new)**
for this repository. Do not disclose an unfixed vulnerability in public issues,
pull requests or discussions. If the private form is unavailable, open a public
issue asking only for a private contact route, without technical vulnerability
details or proof-of-concept material.

Include:

- The affected Cockpit version and source SHA; source or runtime-archive install.
- OS, architecture/libc, exact Node version, SDK/runtime/protocol versions.
- The trust boundary involved: local user, remote gateway, API, native runtime
  or configured MCP/tool.
- A minimal synthetic reproduction, expected and actual behavior, and impact.
- Redacted logs or relevant requests, with no credentials or personal content.

**Never attach tokens, cookies, provider/MCP secrets, private keys, native home
directories, session databases or real conversation history.** Use only systems
and data you own or have explicit permission to test. Do not test against the
maintainer's service or anyone else's running sessions.

The maintainer will coordinate assessment, a fix and disclosure through the
private advisory. This small project does not promise a response or fix SLA.
Please agree on disclosure timing before publishing details.

## Deployment trust model

Cockpit is for a **single operator on a trusted host**. It is not a multi-tenant
service, a sandbox, or an isolation layer for untrusted tools, skills, MCP servers
or project instructions.

- Native tool permissions are **`allow-all`**. Interactive/plan/autopilot are
  interaction modes, not permission restrictions. Tools run with the host user's
  access and can modify files or invoke other programs.
- The backend binds to `127.0.0.1`. It has no built-in user authentication.
  Local processes with access to that port are inside the trust boundary.
- Remote access requires an authenticated HTTPS gateway protecting **every**
  exposed route, including Web, API, event streams, health and version endpoints.
  Loopback binding and Origin/Referer checks are not substitutes for authentication.
- Native Copilot credentials and gateway credentials have different purposes.
  Keep both out of source, reports and downloadable runtime archives.
- Verify downloads and use the exact documented Node/platform combination.
  A checksum downloaded with an archive detects corruption, not a compromised
  publisher or an independently authenticated signature.

See [installation and remote access](docs/install.md#remote-access) and the
[architecture's authentication boundary](docs/architecture.md#authentication).
These boundaries describe intended use, not a claim that every implementation
error is acceptable or that the project has passed a security audit.
