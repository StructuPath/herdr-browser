#!/usr/bin/env bash
# Spike version of the open action (U1). Dumps action-side env, then ensures
# the pane is open twice to probe idempotency, capturing CLI output.
set -u
OUT="${HERDR_PLUGIN_ROOT:-.}/spike-out"
mkdir -p "$OUT"

{
  echo "=== action env $(date) ==="
  env | grep -E '^HERDR' | sort
  echo "=== context json ==="
  echo "${HERDR_PLUGIN_CONTEXT_JSON:-<unset>}"
  echo "=== argv ==="
  echo "argc=$# argv=$*"
} > "$OUT/action-env.txt" 2>&1

{
  echo "=== pane open #1 ==="
  "$HERDR_BIN_PATH" plugin pane open --plugin structupath.browser --entrypoint view \
    --placement split --direction right --no-focus
  echo "exit=$?"
  sleep 1
  echo "=== pane open #2 (idempotency probe) ==="
  "$HERDR_BIN_PATH" plugin pane open --plugin structupath.browser --entrypoint view \
    --placement split --direction right --no-focus
  echo "exit=$?"
} > "$OUT/pane-open.txt" 2>&1
