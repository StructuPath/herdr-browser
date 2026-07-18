#!/usr/bin/env bash
# Open action: navigate the workspace browser session to a URL, or attach
# view-only when invoked with no URL (action invoke and keybindings cannot
# pass arguments in herdr 0.7.x, so URL-less is the primary invoke path).
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}"
. scripts/lib.sh

require_agent_browser

url="${1:-${HERDR_PLUGIN_CLICKED_URL:-}}"
session="$(session_name)"

if [ -n "$url" ]; then
  if ! validate_url "$url"; then
    echo "herdr-browser: refusing URL (must start with http:// or https://): $url" >&2
    exit 2
  fi
  if ! agent-browser --session "$session" open "$url" >/dev/null; then
    echo "herdr-browser: agent-browser failed to open $url" >&2
    exit 3
  fi
fi

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
  printf '%s' "$out" | grep -o '"pane_id":"[^"]*"' | head -n1 | cut -d'"' -f4 > "$pidfile"
fi
