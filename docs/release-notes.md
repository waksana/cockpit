# Cockpit 0.4.6

Current-source deployment version for the host changes merged after 0.4.5:
the joint-deployment release step for accepted commits (#192), the Engine split
into focused services (#193), composer editor pinning so module status stays
visible plus ask speech status (#195), durable crash-safe module storage writes
(#196), precompiled host runtime entry points instead of loading TypeScript
through `tsx` (#197), and TypeScript strict mode with type-aware promise linting
for the Web workspace (#198).

Packages built from this version no longer ship the TypeScript loader entry path.
Existing service and MCP launch commands must be updated to the compiled package
entry points:

```sh
node --enable-source-maps apps/server/dist/index.js   # service
node --enable-source-maps apps/mcp/dist/index.js      # stdio MCP client
```

All host workspaces and the MCP handshake report 0.4.6 from their package
metadata. Native SDK 1.0.13 / runtime 1.0.83 are unchanged. Modules remain
independently versioned. This preparation does not migrate user or Task data,
select modules, create a tag or GitHub Release, or install/restart a service.
