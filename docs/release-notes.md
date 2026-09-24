# Cockpit 0.4.7

Joint-deployment release for the accepted host changes merged after 0.4.6:

- isolate region failures so one broken host or module surface does not take down
  the surrounding application (#201);
- centralize chat/sidebar visual tokens and preserve correct overlay stacking
  (#202);
- add maintained DOM and browser test infrastructure for the Web workspace (#203);
- attach trusted native invocation metadata to module MCP calls so modules can
  derive the calling session without caller-supplied identity fields (#205);
- split Thread transcript/input concerns from Workspace session orchestration
  without changing native session ownership (#207);
- show session titles on up to two lines (#209);
- render ask, plan and MCP confirmation requests as transcript input cards and
  disable ordinary composer input while a decision is pending (#211); and
- show module-provided Skills and MCP servers read-only in session resource
  management, including disabled Skills (#213).

This host is paired with Cockpit File 0.2.4, Cockpit Notification 0.1.17,
Cockpit Speech 0.9.2 and Cockpit Task 0.2.0. Task 0.2.0 is a coordinated,
roll-forward-only schema v9 upgrade and requires the invocation metadata added
by #205. Publication, installation, migration and restart remain separate steps
of the authorized joint deployment.
