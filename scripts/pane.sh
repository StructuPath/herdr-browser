#!/usr/bin/env bash
# Pane entrypoint: run the renderer. Never exit instantly on a missing
# dependency — an exiting pane process closes the pane before the user can
# read the error.
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "herdr-browser: node not found on PATH (need Node.js >= 20)."
  echo "Install Node.js, then reopen this pane."
  sleep 600
  exit 1
fi

# Resolve the session once through the shared bash helper so the launcher and
# the renderer can never derive different names.
. scripts/lib.sh
HERDR_BROWSER_SESSION="$(session_name)"
export HERDR_BROWSER_SESSION

exec node bin/renderer.mjs
