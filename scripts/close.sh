#!/usr/bin/env bash
# Close action: close this workspace's browser panes first (so the renderers
# exit cleanly), then end this plugin's browser session. Never touches other
# workspaces or other sessions.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

session="$(session_name)"
closed=0

close_pane() {
  [ -n "$1" ] || return 0
  if "$HERDR" pane close "$1" >/dev/null 2>&1; then
    closed=$((closed + 1))
  fi
  return 0
}

# Tracked panes: the view pane (open.sh) and any browse panes (browse.sh).
# Close unconditionally — a liveness pre-check that fails would strand a live
# pane, while closing an already-dead id is harmless.
for f in "$(pane_id_file)" "$(browse_ids_file)"; do
  if [ -f "$f" ]; then
    while IFS= read -r id; do close_pane "$id"; done < "$f"
    rm -f "$f"
  fi
done

# Safety net for untracked panes: list this workspace's panes and close any
# carrying this plugin's pane labels. Generic close, not `plugin pane close`:
# the plugin-scoped variant silently no-ops on panes from a previous plugin
# registration.
if [ -n "${HERDR_WORKSPACE_ID:-}" ] && command -v node >/dev/null 2>&1; then
  strays="$("$HERDR" pane list --workspace "$HERDR_WORKSPACE_ID" 2>/dev/null | node -e '
    let d = "";
    process.stdin.on("data", c => d += c).on("end", () => {
      let j; try { j = JSON.parse(d); } catch { return; }
      for (const p of (j.result && j.result.panes) || []) {
        if (p.pane_id && (p.label === "Browser" || p.label === "Browse")) {
          console.log(p.pane_id);
        }
      }
    });')"
  for stray in $strays; do close_pane "$stray"; done
fi

if command -v agent-browser >/dev/null 2>&1; then
  agent-browser --session "$session" close >/dev/null 2>&1 || true
fi

sd="$(state_dir)"
ws="${HERDR_WORKSPACE_ID:-default}"
rm -f "$sd/shot-$ws.png" "$sd/shot-$ws.png.tmp"

# Surfaces in `herdr plugin log list` — close must never fail silently again.
echo "herdr-browser: closed $closed pane(s); session $session released"
