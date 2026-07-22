#!/usr/bin/env bash
# Interactive browser pane: carbonyl renders Chromium straight into the
# terminal with full mouse/keyboard support. Prompts for a URL when none was
# passed, so a bare keybinding acts as an address bar.
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

if ! command -v carbonyl >/dev/null 2>&1; then
	echo "herdr-browser: carbonyl not found."
	echo "Install it with: npm install -g carbonyl"
	echo "Then reopen this pane."
	sleep 600
	exit 1
fi

url="${HERDR_BROWSE_URL:-}"
if [ -n "$url" ]; then
	# The env path came from outside this script — apply the same policy the
	# browse action does instead of trusting the environment blindly (a
	# leading '-' would be eaten by carbonyl as a Chromium flag).
	if ! validate_url "$url"; then
		echo "herdr-browser: refusing URL (must start with http:// or https://, no credentials): $url"
		sleep 600
		exit 1
	fi
else
	printf 'URL: '
	IFS= read -r url
	# Trim surrounding whitespace; an empty answer closes the pane.
	url="${url#"${url%%[![:space:]]*}"}"
	url="${url%"${url##*[![:space:]]}"}"
	if [ -z "$url" ]; then
		exit 0
	fi
	case "$url" in
	[hH][tT][tT][pP]://* | [hH][tT][tT][pP][sS]://*) ;;
	*) url="https://$url" ;;
	esac
	if ! validate_url "$url"; then
		echo "herdr-browser: refusing URL (must start with http:// or https://, no credentials): $url"
		sleep 600
		exit 1
	fi
fi

zoom="${HERDR_BROWSE_ZOOM:-}"
if [ -z "$zoom" ] && [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ] && [ -f "${HERDR_PLUGIN_CONFIG_DIR}/zoom" ]; then
	zoom="$(head -n1 "${HERDR_PLUGIN_CONFIG_DIR}/zoom" | tr -cd '0-9')"
fi
# Clamp to a sane range; garbage becomes the default.
case "$zoom" in
'' | *[!0-9]*) zoom=100 ;;
*)
	if [ "$zoom" -lt 25 ]; then zoom=25; fi
	if [ "$zoom" -gt 500 ]; then zoom=500; fi
	;;
esac

exec carbonyl --zoom="$zoom" "$url"
