#!/usr/bin/env bash
# Close action: close the pane first (so the renderer exits cleanly), then
# end this plugin's browser session. Never touches other sessions.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

session="$(session_name)"
pidfile="$(pane_id_file)"

if [ -f "$pidfile" ]; then
  pane="$(cat "$pidfile")"
  if pane_alive "$pane"; then
    "$HERDR" plugin pane close "$pane" >/dev/null 2>&1 || true
  fi
  rm -f "$pidfile"
fi

if command -v agent-browser >/dev/null 2>&1; then
  agent-browser --session "$session" close >/dev/null 2>&1 || true
fi

rm -f "$(state_dir)"/shot-*.png
