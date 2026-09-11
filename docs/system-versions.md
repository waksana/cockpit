# System versions and delivery boundaries

The global menu's **系统 / 版本与更新** opens a small on-demand view. It reads
`GET /system/versions` only while the menu/dialog is being used, on connection
recovery or explicit refresh; there is no periodic collector or native session
state copy. Closing the consumer aborts its read. Failed refreshes do not display
old observations as current facts.

The backend reads the private `COCKPIT_DELIVERY_VIEWER_CREDENTIAL` file and calls
the delivery runner's read-only `/status` API. That actor has no submit, approve,
import, boot or recovery permission. No credential is sent to the browser.
The public projection includes only allowlisted project names, actual process
version/short SHA/instance and health, delivery request stage and prepared artifact
identity, and known waiting reasons. Missing/unsupported runtime identity stays
unknown. `/admin/lifecycle` supplies aggregate native busy/restart information
without fetching session titles or chat contents.

Cockpit, Task and WeChat are separate services with separate process identities,
launchers and `current` directories. A build-only artifact is not deployment;
an unavailable paused connector is not silently presented as its Git version.
The runner owns the queued/building/built/waiting-idle/activating/verifying/
succeeded/failed/unknown stages. A restart flag without a candidate is an ordinary
safe restart, not evidence of a new version.

## Shared implementation, project-specific policy

Thin `delivery-ci.yml` and `delivery-transfer.yml` wrappers pin the reusable
workflows in this private repository to a full commit. The reusable build in turn
pins its composite implementation. Each caller keeps its own committed
`service-delivery.json`, branch and private host configuration. Task integrates
on `main`; the connector integrates on `master`. Push runs CI/build only.
Production still requires an explicit authenticated fixed-SHA submit; changing
branch names or creating workflow files does not enable automatic deployment.

GitHub private reuse is enabled for this account after explicit approval, not
public distribution and not a two-repository access allowlist. Runtime data,
uploads, SDK sessions, authentication and Commander credentials remain outside
releases. The restricted receiver authenticates GitHub artifact provenance
against each accepted project's repository and exact request/run.

## Safe lifecycle and MCP/skill updates

Cockpit waits for native busy/decision/subagent/tool work before exit. Task waits
for admitted service operations, not every ongoing business owner's whole goal.
The connector drains started receive/send/CDN/prompt work; an empty outbox at
one instant is not a drain guarantee. A paused/unknown-send connector remains
disabled independently of whether its code package has been built.

Future MCP startup paths should point to each service's immutable current
package. Existing connections can still contain older code/descriptions; where
they do not expose a reliable version, their loaded version is unknown. Cockpit
restart updates only the connections it manages, and native global defaults may
replace temporary per-session enable choices. External consumers are not
automatically restarted.

Released skill files and references can be discovered after native refresh.
Instructions already loaded into a model context are not erased by file updates
or service restart. Neither this view nor a package hash proves every agent's
current instruction version.
