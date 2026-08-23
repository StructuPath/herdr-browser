#!/usr/bin/env bash
# Create or complete a run-scoped WebM observation bundle.
# Recording resets the browser context (the page reloads; cookies and
# localStorage are preserved), so start before the flow to capture.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

case "${1:-}" in
start | stop) ;;
*)
	echo "usage: record.sh start|stop" >&2
	exit 2
	;;
esac

# Recording captures the workspace's agent-browser session. A workspace
# configured for CDP attach mode has no such session — starting one here
# would record a fresh, unrelated headless browser, not the observed one.
cdp_endpoint="${HERDR_BROWSER_CDP_URL:-}"
if [ -z "$cdp_endpoint" ] && [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ] && [ -f "${HERDR_PLUGIN_CONFIG_DIR}/cdp-url" ]; then
	cdp_endpoint="$(head -n1 "${HERDR_PLUGIN_CONFIG_DIR}/cdp-url" | tr -d '[:space:][:cntrl:]')"
fi
if [ -n "$cdp_endpoint" ]; then
	echo "herdr-browser: recording captures agent-browser sessions, but this workspace is configured for CDP attach mode (cdp-url). Record from the automation client that owns the browser, or remove the cdp-url configuration to record an agent-browser session." >&2
	exit 1
fi

require_agent_browser
if ! command -v node >/dev/null 2>&1; then
	echo "herdr-browser: node is required." >&2
	exit 1
fi

HERDR_BROWSER_STATE_DIR="$(state_dir)"
HERDR_BROWSER_WORKSPACE_ID="$(ws_id)"
HERDR_BROWSER_SESSION_PINNED="$(session_name)"
export HERDR_BROWSER_STATE_DIR HERDR_BROWSER_WORKSPACE_ID HERDR_BROWSER_SESSION_PINNED
exec node bin/record.mjs "$1"
