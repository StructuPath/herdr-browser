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
    "$HERDR" pane close "$pane" >/dev/null 2>&1 || true
  fi
  rm -f "$pidfile"
fi

# Fallback: the pid file only knows about panes opened through open.sh. Sweep
# this workspace's Browser/Browse panes from the live snapshot so close works
# regardless of how a pane was opened.
if [ -n "${HERDR_WORKSPACE_ID:-}" ] && command -v node >/dev/null 2>&1; then
  "$HERDR" api snapshot 2>/dev/null | node -e '
    let d = "";
    process.stdin.on("data", c => d += c).on("end", () => {
      const ws = process.argv[1];
      let j; try { j = JSON.parse(d); } catch { return; }
      const out = [];
      const walk = o => {
        if (o && typeof o === "object") {
          if (o.pane_id && (o.label === "Browser" || o.label === "Browse")
              && String(o.pane_id).startsWith(ws + ":")) out.push(o.pane_id);
          for (const v of Object.values(o)) walk(v);
        }
      };
      walk(j);
      console.log(out.join("\n"));
    });' "$HERDR_WORKSPACE_ID" | while IFS= read -r stray; do
    # Generic close, not `plugin pane close`: the plugin-scoped variant
    # silently no-ops on panes from a previous plugin registration.
    [ -n "$stray" ] && "$HERDR" pane close "$stray" >/dev/null 2>&1 || true
  done
fi

if command -v agent-browser >/dev/null 2>&1; then
  agent-browser --session "$session" close >/dev/null 2>&1 || true
fi

sd="$(state_dir)"
ws="${HERDR_WORKSPACE_ID:-default}"
rm -f "$sd/shot-$ws.png" "$sd/shot-$ws.png.tmp"
