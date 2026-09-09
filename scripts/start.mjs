#!/usr/bin/env node
// Cross-platform launcher for a single-process, loopback cockpit (no reverse proxy).
//
// Starts the cockpit server so it serves BOTH the built web SPA and the API from
// one process on 127.0.0.1:<port> — the turnkey way to run cockpit on a box with no
// nginx (e.g. Windows, local-only). It just sets sensible env defaults and runs the
// same server entry systemd uses, through the tsx loader, with stdio inherited.
//
// Everything is overridable from the environment before you run it:
//   COCKPIT_PORT       listen port (default 8771)
//   COCKPIT_HOME       state root (default ~/.copilot) — prefs/sessions/uploads
//   COCKPIT_SERVE_WEB  serve the SPA from this process (default 1 here)
//   COCKPIT_WEB_DIR    built SPA dir (default apps/web/dist)
//   COCKPIT_MAX_OLD_SPACE_MB  V8 old-space ceiling in MB for the server child
//                             (unset: Node default; positive integer when supplied)
//
// Prereq: `pnpm install` and `pnpm --filter @cockpit/web build` have been run.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { buildServerNodeArgs } from './heap-config.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(root, 'apps', 'server');

const env = { ...process.env };
if (env.COCKPIT_SERVE_WEB === undefined) env.COCKPIT_SERVE_WEB = '1';

const webDir = env.COCKPIT_WEB_DIR ?? join(root, 'apps', 'web', 'dist');
if (env.COCKPIT_SERVE_WEB === '1' && !existsSync(join(webDir, 'index.html'))) {
  console.error(`[cockpit] web bundle not found at ${webDir}\n` +
    `[cockpit] build it first:  pnpm --filter @cockpit/web build`);
  process.exit(1);
}

// The optional API heap override does not control the separate Copilot runtime.
// Invalid overrides fail rather than silently falling back.
let args;
try {
  args = buildServerNodeArgs(env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Respawn supervisor: relaunch the server whenever it exits, so a graceful
// `POST /admin/restart` (which exits 0 once every session is idle) is brought right
// back up on fresh source — mirroring systemd's `Restart=always` on a host (e.g. this
// Windows box) whose process supervisor (a logon-triggered Scheduled Task) only
// (re)starts at logon or on FAILURE, never after a clean exit. Without this, a graceful
// restart would exit 0 and strand the fleet. Guard against a boot crash-loop: if the
// child keeps dying within 5s, give up and exit non-zero so the OS supervisor's
// failure-restart / next logon still applies.
let fastCrashes = 0;
function startServer() {
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, { cwd: serverDir, env, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    const ranMs = Date.now() - startedAt;
    fastCrashes = ranMs < 5000 ? fastCrashes + 1 : 0;
    if (fastCrashes >= 5) {
      console.error(`[cockpit] server exited ${fastCrashes}x within 5s (code=${code}, signal=${signal}) — stopping supervisor`);
      process.exit(code ?? 1);
    }
    const backoffMs = ranMs < 5000 ? Math.min(1000 * fastCrashes, 10000) : 0;
    console.error(`[cockpit] server exited (code=${code}, signal=${signal}) — respawning in ${backoffMs}ms`);
    setTimeout(startServer, backoffMs);
  });
}
startServer();
