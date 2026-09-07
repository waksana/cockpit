#!/bin/sh
# welcome-gate.sh — example Butler welcome gate (cost gate, no LLM).
#
# Contract (design F8): cockpit runs this as a subprocess BEFORE the flow's
# action. It receives the triggering event context BOTH via the env var
# COCKPIT_EVENT (JSON) and on stdin (JSON). It must:
#   - exit 0  → GO  (the flow proceeds to its action: spawn the butler-worker)
#   - exit !0 → SKIP (the flow ends cheaply; no agent is spent)
# Optional: print a JSON object to stdout; its keys become interpolation params
# ({gate.key} / {key}) for the downstream prompt.
#
# SECURITY (F10): this is an OWNER-LOCAL script, git-tracked as documentation and
# copied to ~/.copilot/flows/. cockpit never runs third-party/downloaded scripts.
#
# This example always says GO and emits no params. A real gate would inspect the
# source session (e.g. skip sessions whose cwd is a scratch/throwaway dir, or that
# already look well-named) and could emit a "variant" param to steer the prompt.

# Example of reading the event (uncomment to use):
#   echo "$COCKPIT_EVENT" 1>&2   # log the event JSON to stderr (visible in cockpit logs)

exit 0
