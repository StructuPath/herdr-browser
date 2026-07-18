#!/usr/bin/env bash
# Browse action: open an interactive carbonyl browser pane. Unlike the viewer
# pane, this is a personal browser — its own Chromium, no shared agent session.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

url="${1:-${HERDR_PLUGIN_CLICKED_URL:-}}"
if [ -n "$url" ] && ! validate_url "$url"; then
  echo "herdr-browser: refusing URL (must start with http:// or https://): $url" >&2
  exit 2
fi

args=(plugin pane open --plugin "$PLUGIN_ID" --entrypoint browse
  --placement split --direction right --focus)
if [ -n "$url" ]; then
  args+=(--env "HERDR_BROWSE_URL=$url")
fi
exec "$HERDR" "${args[@]}" >/dev/null
