#!/bin/sh
set -eu
# SSH supplies data on stdin; the controller validates the entire command.
exec /usr/bin/sudo -n -u honglai /home/honglai/.local/bin/node \
  /opt/cockpit-release/controller.mjs receive "${SSH_ORIGINAL_COMMAND-}"
