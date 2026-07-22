#!/usr/bin/env bash
# Browse action: open an interactive carbonyl browser pane. Unlike the viewer
# pane, this is a personal browser — its own Chromium, no shared agent session.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

require_herdr

url="${1:-${HERDR_PLUGIN_CLICKED_URL:-}}"
if [ -n "$url" ] && ! validate_url "$url"; then
	echo "herdr-browser: refusing URL (must start with http:// or https://, no credentials): $url" >&2
	exit 2
fi

args=(plugin pane open --plugin "$PLUGIN_ID" --entrypoint browse
	--placement zoomed --focus)
if [ -n "$url" ]; then
	args+=(--env "HERDR_BROWSE_URL=$url")
fi
out="$(with_timeout 15 "$HERDR" "${args[@]}")" || {
	echo "herdr-browser: failed to open browse pane" >&2
	exit 4
}
# Record the pane so the close action can find it later.
pane_id="$(parse_pane_id "$out")"
if [ -n "$pane_id" ]; then
	printf '%s\n' "$pane_id" >>"$(browse_ids_file)"
else
	echo "herdr-browser: warning: could not parse pane id from pane-open output" >&2
fi
