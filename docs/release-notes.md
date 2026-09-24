# Cockpit 0.4.7

Joint-deployment release for the accepted host changes merged after 0.4.6:

- isolate region failures so one broken host or module surface does not take down
  the surrounding application (#201);
- centralize chat/sidebar visual tokens and preserve correct overlay stacking
  (#202);
- add maintained DOM and browser test infrastructure for the Web workspace (#203);
- attach host-provided native invocation metadata to module MCP calls so modules can
  derive the calling session without caller-supplied identity fields (#205);
- split Thread transcript/input concerns from Workspace session orchestration
  without changing native session ownership (#207);
- show session titles on up to two lines (#209);
- render ask, plan and MCP confirmation requests as transcript input cards and
  disable ordinary composer input while a decision is pending (#211); and
- show module-provided Skills and MCP servers read-only in session resource
  management, including disabled Skills (#213).

The prepared pairing is recorded in the [module catalog](modules.md). The next
Task module requires the invocation metadata added by #205 and a coordinated,
roll-forward-only schema v9 upgrade. This source preparation does not itself
publish, install, migrate or restart anything; those remain separate steps of
the authorized joint deployment.
