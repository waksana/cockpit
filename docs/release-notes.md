# Cockpit 0.4.5

Current-source deployment version for the host changes merged after 0.4.4:
removal of the legacy `/next` Web UI (#167), frontend reduction (#171), the
English documentation overhaul (#172), backend quick fixes including MCP
handshake version sourcing from `apps/mcp/package.json` (#173), module default
instructions and Cockpit user instructions (#186), unified Web error ownership
and operation result disclosure (#187), typed protocol error codes (#188), and
bounded concurrent session reads through the split runtime serial gate (#189).

All host workspaces and the MCP handshake report 0.4.5 from their package
metadata. Native SDK 1.0.13 / runtime 1.0.83 are unchanged. Modules remain
independently versioned. This preparation does not migrate user or Task data,
select modules, create a tag or GitHub Release, or install/restart a service.
