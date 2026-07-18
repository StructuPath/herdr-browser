#!/usr/bin/env bash
# Shared helpers for herdr-browser launcher actions.

HERDR="${HERDR_BIN_PATH:-herdr}"
PLUGIN_ID="structupath.browser"

state_dir() {
  local d="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr-browser}"
  mkdir -p "$d"
  chmod 700 "$d"
  printf '%s\n' "$d"
}

# Session precedence: env override > config file > workspace id > cwd hash.
# Must stay in lockstep with deriveSession() in bin/renderer.mjs.
session_name() {
  if [ -n "${HERDR_BROWSER_SESSION:-}" ]; then
    printf '%s\n' "$HERDR_BROWSER_SESSION"
  elif [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ] && [ -f "${HERDR_PLUGIN_CONFIG_DIR}/session" ]; then
    head -n1 "${HERDR_PLUGIN_CONFIG_DIR}/session" | tr -d '[:space:]'
  elif [ -n "${HERDR_WORKSPACE_ID:-}" ]; then
    printf 'herdr-ws-%s\n' "$HERDR_WORKSPACE_ID"
  else
    printf 'herdr-cwd-%s\n' "$(printf '%s\n' "$PWD" | cksum | cut -d' ' -f1)"
  fi
}

require_agent_browser() {
  if ! command -v agent-browser >/dev/null 2>&1; then
    echo "herdr-browser: agent-browser CLI not found." >&2
    echo "Install it with: npm install -g agent-browser && agent-browser install" >&2
    exit 1
  fi
}

# Only plain http(s) URLs pass; flag-like and exotic-scheme values are refused.
validate_url() {
  case "$1" in
    -*) return 1 ;;
    http://?*|https://?*) return 0 ;;
    *) return 1 ;;
  esac
}

pane_id_file() {
  printf '%s/pane-id-%s\n' "$(state_dir)" "${HERDR_WORKSPACE_ID:-default}"
}

pane_alive() {
  [ -n "$1" ] && "$HERDR" pane read "$1" --lines 1 >/dev/null 2>&1
}
