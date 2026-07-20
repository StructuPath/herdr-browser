#!/usr/bin/env bash
# Open action: navigate the workspace browser session to a URL, or attach
# view-only when invoked with no URL (action invoke and keybindings cannot
# pass arguments in herdr 0.7.x, so URL-less is the primary invoke path).
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

require_agent_browser

url="${1:-${HERDR_PLUGIN_CLICKED_URL:-}}"
session="$(session_name)"

if [ -n "$url" ]; then
  if ! validate_url "$url"; then
    echo "herdr-browser: refusing URL (must start with http:// or https://): $url" >&2
    exit 2
  fi
  # If this call spawns the session daemon, let it self-reap after 30 min
  # idle instead of living forever (no-op for daemons agents already own).
  export AGENT_BROWSER_IDLE_TIMEOUT_MS="${AGENT_BROWSER_IDLE_TIMEOUT_MS:-1800000}"
  if ! agent-browser --session "$session" open "$url" >/dev/null; then
    echo "herdr-browser: agent-browser failed to open $url" >&2
    exit 3
  fi
fi

# Serialize concurrent opens: two invokes racing past the liveness check
# would each open a pane (herdr pane open is not idempotent). mkdir is the
# portable atomic lock; after ~5s of waiting the holder is presumed dead and
# the lock is stolen — a duplicate pane beats an open action that never acts.
lock="$(state_dir)/open-lock-${HERDR_WORKSPACE_ID:-default}"
tries=0
until mkdir "$lock" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt "${HERDR_BROWSER_LOCK_TRIES:-50}" ]; then
    rm -rf "$lock"
  fi
  sleep 0.1
done
trap 'rmdir "$lock" 2>/dev/null' EXIT

pidfile="$(pane_id_file)"
existing=""
[ -f "$pidfile" ] && existing="$(cat "$pidfile")"

if pane_alive "$existing"; then
  "$HERDR" plugin pane focus "$existing" >/dev/null 2>&1 || true
else
  out="$("$HERDR" plugin pane open --plugin "$PLUGIN_ID" --entrypoint view \
    --placement split --direction right --focus)" || {
    echo "herdr-browser: failed to open pane" >&2
    exit 4
  }
  pane_id="$(parse_pane_id "$out")"
  if [ -n "$pane_id" ]; then
    printf '%s\n' "$pane_id" > "$pidfile"
  else
    echo "herdr-browser: warning: could not parse pane id from pane-open output" >&2
    rm -f "$pidfile"
  fi
fi
