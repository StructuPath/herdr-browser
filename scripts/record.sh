#!/usr/bin/env bash
# Record the workspace browser session to a WebM video (agent-browser record).
# Note: record start creates a fresh browser context (the page reloads;
# cookies and localStorage are preserved) — that is the engine's trade-off
# for capturing video, so start recording before the flow you want to show.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

require_agent_browser

session="$(session_name)"
dir="$(state_dir)/recordings"
mkdir -p "$dir"

case "${1:-}" in
start)
	f="$dir/$session-$(date +%Y%m%d-%H%M%S).webm"
	if ! with_timeout 15 agent-browser --session "$session" record start "$f" >/dev/null; then
		echo "herdr-browser: failed to start recording (is the session running?)" >&2
		exit 3
	fi
	echo "herdr-browser: recording to $f"
	;;
stop)
	if ! with_timeout 15 agent-browser --session "$session" record stop >/dev/null; then
		echo "herdr-browser: failed to stop recording" >&2
		exit 3
	fi
	echo "herdr-browser: recording saved under $dir"
	;;
*)
	echo "usage: record.sh start|stop" >&2
	exit 2
	;;
esac
