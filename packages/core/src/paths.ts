// paths.ts — the single source of truth for cockpit's state root.
//
// Native storage includes mcp-config.json, session-state/, session-store.db and
// native skills. That root defaults to ~/.copilot — resolved with homedir() so it
// is correct on every OS (USERPROFILE on Windows, $HOME on POSIX), never a
// hardcoded literal — and the WHOLE tree can be relocated with one knob,
// COCKPIT_HOME, for a portable or side-by-side install.
//
// Individual paths keep their own finer-grained env overrides (COCKPIT_SESSION_STORE,
// COCKPIT_SESSION_STATE_DIR, …) which
// take precedence where set; COCKPIT_HOME only moves the default base they fall back
// to. Read at call time so a test or launcher can set COCKPIT_HOME before use.
// The consumer launcher's COCKPIT_USER_ROOT is separate from this native root.

import { homedir } from 'node:os';
import { join } from 'node:path';

// The cockpit state root (default ~/.copilot, overridable with COCKPIT_HOME).
export function cockpitHome(): string {
  return process.env.COCKPIT_HOME ?? join(homedir(), '.copilot');
}

// Join segments under the cockpit state root.
export function copilotPath(...segments: string[]): string {
  return join(cockpitHome(), ...segments);
}

// The SDK-owned global session store (SQLite + FTS5), shared across all sessions.
// COCKPIT_SESSION_STORE overrides the default location under the cockpit home (the
// same override apps/mcp resolves, so the engine and the MCP always agree on the
// file).
export function sessionStorePath(): string {
  return process.env.COCKPIT_SESSION_STORE ?? copilotPath('session-store.db');
}
