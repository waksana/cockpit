#!/usr/bin/env bash
# The backend owns the busy check and restart decision. Do not race it with a
# second poller or restart systemd directly. DRY_RUN=1 reads status only.
set -euo pipefail
exec node "$(dirname "$0")/graceful-restart.mjs"
