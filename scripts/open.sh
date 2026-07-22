#!/usr/bin/env bash
# Open action: navigate the workspace browser session to a URL, or attach
# view-only when invoked with no URL (action invoke and keybindings cannot
# pass arguments in herdr 0.7.x, so URL-less is the primary invoke path).
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

require_agent_browser
require_herdr

url="${1:-${HERDR_PLUGIN_CLICKED_URL:-}}"
session="$(session_name)"

if [ -n "$url" ]; then
	if ! validate_url "$url"; then
		echo "herdr-browser: refusing URL (must start with http:// or https://, no credentials): $url" >&2
		exit 2
	fi
	# If this call spawns the session daemon, let it self-reap after 30 min
	# idle instead of living forever (no-op for daemons agents already own).
	export AGENT_BROWSER_IDLE_TIMEOUT_MS="${AGENT_BROWSER_IDLE_TIMEOUT_MS:-1800000}"
	if ! with_timeout 15 agent-browser --session "$session" open "$url" >/dev/null; then
		echo "herdr-browser: agent-browser failed to open $url" >&2
		exit 3
	fi
fi

# Serialize concurrent opens: two invokes racing past the liveness check
# would each open a pane (herdr pane open is not idempotent). mkdir is the
# portable atomic lock, with a PID token so the holder's EXIT trap can never
# remove a stealer's fresh lock. After ~2s of waiting the lock may be stolen
# — but only when the holder's PID is actually dead (kill -0): a legitimate
# hold can last ~20s (5s focus timeout + 15s pane-open timeout), so elapsed
# time alone must never break mutual exclusion. Each waiter steals at most
# once, then keeps waiting; the steal removes only the known token file +
# dir, never an rm -rf of a foreign path.
lock="$(state_dir)/open-lock-$(ws_id)"
case "${HERDR_BROWSER_LOCK_TRIES:-20}" in
'' | *[!0-9]*) tries_max=20 ;;
*) tries_max="${HERDR_BROWSER_LOCK_TRIES:-20}" ;;
esac
tries=0
stolen=0
until mkdir "$lock" 2>/dev/null; do
	tries=$((tries + 1))
	if [ "$tries" -gt "$tries_max" ] && [ "$stolen" -eq 0 ]; then
		holder="$(cat "$lock/pid" 2>/dev/null || true)"
		if [ -z "$holder" ] || ! kill -0 "$holder" 2>/dev/null; then
			rm -f "$lock/pid" 2>/dev/null
			rmdir "$lock" 2>/dev/null || true
			stolen=1
			tries=0
		fi
	fi
	sleep 0.1
done
printf '%s\n' "$$" >"$lock/pid"
trap 'if [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ]; then rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null; fi' EXIT

pidfile="$(pane_id_file)"
existing=""
[ -f "$pidfile" ] && existing="$(cat "$pidfile")"

focused=0
if pane_alive "$existing"; then
	if with_timeout 5 "$HERDR" plugin pane focus "$existing" >/dev/null 2>&1; then
		focused=1
	else
		# Died between the liveness check and focus — drop the stale record and
		# fall through to opening a fresh pane instead of silently doing nothing.
		rm -f "$pidfile"
	fi
fi

if [ "$focused" -eq 0 ]; then
	out="$(with_timeout 15 "$HERDR" plugin pane open --plugin "$PLUGIN_ID" --entrypoint view \
		--placement split --direction right --focus)" || {
		echo "herdr-browser: failed to open pane" >&2
		exit 4
	}
	pane_id="$(parse_pane_id "$out")"
	if [ -n "$pane_id" ]; then
		printf '%s\n' "$pane_id" >"$pidfile"
	else
		echo "herdr-browser: warning: could not parse pane id from pane-open output" >&2
		rm -f "$pidfile"
	fi
fi
