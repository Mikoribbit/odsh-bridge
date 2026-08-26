#!/bin/sh
# dsh-entrypoint.sh — ODSH Bridge container self-start wrapper (Route A: self-start daemon)
#
# Starts the bridge daemon in the background on container boot (self-healing via
# dshtrigger's supervisor), then hands control back to the real DSH web (PID1).
# No manual daemon start ever needed — open the DSH GUI and the daemon is already up.

# Locates the daemon in either layout:
#   - distributed/release: <repo>/src/dshtrigger.mjs (beside bridge-daemon.mjs)
#   - bridge-mounted runtime: <BRIDGE>/DSH-Workspace/tools/dshtrigger.mjs
set -e

NODE="${NODE:-/usr/local/bin/node}"
BRIDGE="${BRIDGE_PATH:-/root/ODSH-bridge}"
REPO_SRC="${ODSH_REPO_SRC:-/opt/odsh-bridge/src}"
RUNTIME_TOOLS="$BRIDGE/DSH-Workspace/tools"
LOG="${ODSH_DAEMON_LOG:-$BRIDGE/DSH-Workspace/daemon.log}"
INTERVAL="${ODSH_INTERVAL_MS:-2000}"

# pick the first dshtrigger that exists
DAEMON=""
for cand in "${ODSH_DAEMON:-}" "$REPO_SRC/dshtrigger.mjs" "$RUNTIME_TOOLS/dshtrigger.mjs"; do
  if [ -n "$cand" ] && [ -f "$cand" ]; then DAEMON="$cand"; break; fi
done

NOTIFY_FLAG=""
# Enable completion notifications: set ODSH_NOTIFY=1 + DISCORD_CHANNEL_ID in compose env
# if [ "${ODSH_NOTIFY:-}" = "1" ]; then NOTIFY_FLAG="--notify"; fi

if [ -z "$DAEMON" ]; then
  echo "[entrypoint] WARN: no dshtrigger.mjs found (searched $REPO_SRC, $RUNTIME_TOOLS); daemon will NOT auto-start" >&2
else
  echo "[entrypoint] starting bridge daemon supervisor: $DAEMON (interval=${INTERVAL}ms)"
  "$NODE" "$DAEMON" daemon --interval-ms "$INTERVAL" $NOTIFY_FLAG >> "$LOG" 2>&1 &
fi

echo "[entrypoint] starting dsh web..."
exec pnpm dsh web --host 0.0.0.0 --port 3080 --no-open
