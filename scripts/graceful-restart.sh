#!/usr/bin/env bash
# Graceful restart of the cockpit backend.
#
# An agent turn (the in-memory model+tool loop) CANNOT survive a process restart —
# only the event history persists to disk. So a "graceful" restart means: wait
# until no session has a turn in flight (all idle/unloaded), THEN restart, so no
# work is interrupted. The new process reloads every session's history from disk.
#
# Run this DETACHED so it outlives the very process it restarts:
#   setsid scripts/graceful-restart.sh >/tmp/cockpit-restart.log 2>&1 < /dev/null &
#
# An agent running inside cockpit can call it to deploy its own backend changes:
# it keeps generating its response (session = running), the script waits, and only
# once the turn ends (session = idle) does the restart fire — uninterrupted.
#
# Options (env vars):
#   PORT=8771            backend port (default 8771)
#   SERVICE=cockpit-server.service  systemd --user unit
#   MAX_WAIT=900         max seconds to wait for an idle window (default 15min)
#   POLL=2               poll interval seconds
#   DRY_RUN=1            report the idle window but do NOT restart
set -euo pipefail

PORT="${PORT:-8771}"
SERVICE="${SERVICE:-cockpit-server.service}"
MAX_WAIT="${MAX_WAIT:-900}"
POLL="${POLL:-2}"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '%s graceful-restart: %s\n' "$(date '+%H:%M:%S')" "$*"; }

# Count sessions currently running. Prefers the lightweight /status endpoint;
# falls back to reading one SSE snapshot frame (for a backend predating /status).
# Echoes the running count, or -1 if the backend is unreachable.
running_count() {
  PORT="$PORT" python3 - <<'PY'
import json, os, sys, urllib.request
base = f"http://127.0.0.1:{os.environ['PORT']}"
# Fast path: dedicated status endpoint.
try:
    with urllib.request.urlopen(base + "/status", timeout=4) as r:
        print(json.load(r).get("running", -1)); sys.exit()
except urllib.error.HTTPError as e:
    if e.code != 404:
        print(-1); sys.exit()
except Exception:
    print(-1); sys.exit()
# Fallback: read exactly one SSE snapshot frame, then close immediately.
try:
    with urllib.request.urlopen(base + "/events", timeout=4) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line.startswith("data:"):
                d = json.loads(line[5:].strip())
                if d.get("type") == "snapshot":
                    print(sum(1 for s in d.get("sessions", []) if s.get("status") == "running"))
                    sys.exit()
    print(-1)
except Exception:
    print(-1)
PY
}

log "waiting for an idle window (no running turns), max ${MAX_WAIT}s…"
elapsed=0
while :; do
  n="$(running_count)"
  if [ "$n" = "-1" ]; then
    log "backend unreachable — proceeding to (re)start"
    break
  fi
  if [ "$n" = "0" ]; then
    log "all sessions idle — proceeding to restart"
    break
  fi
  if [ "$elapsed" -ge "$MAX_WAIT" ]; then
    log "timed out after ${MAX_WAIT}s with ${n} still running — NOT restarting (stay graceful). Re-run later."
    exit 1
  fi
  log "${n} running; waiting…"
  sleep "$POLL"
  elapsed=$((elapsed + POLL))
done

if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN=1 — idle window found, restart skipped."
  exit 0
fi

log "restarting ${SERVICE}…"
systemctl --user restart "$SERVICE"
log "restart issued."
