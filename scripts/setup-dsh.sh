#!/usr/bin/env bash
# ============================================================================
# setup-dsh.sh - one-shot, idempotent DSH-container setup for ODSH Bridge v1.1
# DSH container one-click setup for the SSH + Cua Driver desktop channel.
# Safe to re-run; skips already-done work.
#
# Usage:
#   ./scripts/setup-dsh.sh [--bridge /root/ODSH-bridge] [--host host.docker.internal] [--user miko]
#
# Steps: 1) install ssh client   2) generate ed25519 key (idempotent)
#        3) publish pubkey to the bridge   4) read windows-connect.json from bridge
#        5) write/update .env CUA_* vars   6) test SSH   7) verify oc-cua get_screen_size
# ============================================================================
set -euo pipefail

BRIDGE=${ODSH_BRIDGE:-/root/ODSH-bridge}
HOST=${ODSH_SSH_HOST:-host.docker.internal}
USER=${ODSH_SSH_USER:-}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bridge) BRIDGE="$2"; shift 2;;
    --host)   HOST="$2";   shift 2;;
    --user)   USER="$2";   shift 2;;
    -h|--help) sed -n '1,14p' "$0"; exit 0;;
    *) echo "[setup-dsh] unknown arg: $1"; exit 64;;
  esac
done

say(){ printf '\033[36m[setup-dsh]\033[0m %s\n' "$*"; }
ok(){ printf '\033[32m[setup-dsh] OK:\033[0m %s\n' "$*"; }
skip(){ printf '\033[90m[setup-dsh] skip:\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m[setup-dsh] WARN:\033[0m %s\n' "$*"; }
fail(){ printf '\033[31m[setup-dsh] FAIL:\033[0m %s\n' "$*"; exit 1; }

# ---- 1) ssh client ----
if command -v ssh >/dev/null 2>&1; then ok 'ssh client present';
else
  say 'installing openssh-client...'
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq openssh-client
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache openssh-client
  else fail 'no package manager to install openssh-client'
  fi
  command -v ssh >/dev/null || fail 'ssh not available after install'
fi

# ---- 2) key (idempotent) ----
KEY=${ODSH_SSH_KEY:-/root/.ssh/id_ed25519}
mkdir -p "$(dirname "$KEY")" && chmod 700 "$(dirname "$KEY")"
if [[ ! -f "$KEY" ]]; then
  ssh-keygen -t ed25519 -N '' -f "$KEY" -C 'dsh-bridge-cua' >/dev/null
  ok "generated key $KEY"
else skip 'key already exists'
fi
PUB="$KEY.pub"
chmod 600 "$KEY"

# ---- 3) publish pubkey to bridge ----
if [[ -d "$BRIDGE" ]]; then
  cp "$PUB" "$BRIDGE/DSH-Workspace/dsh_ssh_pubkey.pub" 2>/dev/null || cp "$PUB" "$BRIDGE/dsh_ssh_pubkey.pub"
  ok "pubkey published to $BRIDGE (DSH-Workspace/dsh_ssh_pubkey.pub)"
else warn "bridge $BRIDGE not found - cannot auto-publish pubkey; copy $PUB manually"
fi

# ---- 4) read windows-connect.json for defaults ----
WCONN="$BRIDGE/DSH-Workspace/windows-connect.json"
if [[ -f "$WCONN" ]]; then
  say "reading $WCONN ..."
  if [[ -z "$USER" ]]; then USER=$(sed -n 's/.*"sshUser"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WCONN" | head -1); fi
  CUA_BIN_FROM_CONN=$(sed -n 's/.*"cuaBin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WCONN" | head -1)
  if [[ -n "$CUA_BIN_FROM_CONN" ]]; then say "cuaBin from windows: $CUA_BIN_FROM_CONN"; fi
else warn "windows-connect.json not found - first run scripts/setup-windows.ps1 on the Windows host, or pass --user"
fi
[[ -z "$USER" ]] && fail 'cannot determine Windows SSH username (pass --user or let setup-windows write windows-connect.json)'

# ---- 5) write .env CUA_* (idempotent append) ----
ENVF="$BRIDGE/.env"
if [[ -f "$BRIDGE/.env" ]]; then ENVF="$BRIDGE/.env"; elif [[ -f /app/.env ]]; then ENVF=/app/.env; fi
apply_env(){ local k="$1" v="$2"; if grep -q "^${k}=" "$ENVF" 2>/dev/null; then sed -i "s|^${k}=.*|${k}=${v}|" "$ENVF"; else printf '%s=%s\n' "$k" "$v" >> "$ENVF"; fi; }
if [[ -w "$ENVF" || ! -f "$ENVF" ]]; then
  touch "$ENVF"
  apply_env CUA_SSH_USER "$USER"
  apply_env CUA_SSH_HOST "$HOST"
  apply_env CUA_SSH_PORT 22
  apply_env CUA_SSH_KEY "$KEY"
  if [[ -n "${CUA_BIN_FROM_CONN:-}" ]]; then apply_env CUA_BIN "${CUA_BIN_FROM_CONN//\\//}"; fi
  ok ".env updated at $ENVF"
else warn "cannot write $ENVF - set CUA_* env manually"
fi

# ---- 6) test SSH ----
say "testing ssh $USER@$HOST (batch, key-only)..."
if timeout 25 ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$KEY" "$USER@$HOST" 'whoami' >/tmp/odsh_ssh_whoami 2>&1; then
  ok "SSH works: $(cat /tmp/odsh_ssh_whoami)"
else
  echo
  cat /tmp/odsh_ssh_whoami 2>/dev/null || true
  fail 'SSH connection failed - check Windows side (sshd running + key placed + firewall 22)'
fi

# ---- 7) verify oc-cua get_screen_size ----
say 'verifying oc-cua get_screen_size via SSH...'
if OC_ENV_FILE="$ENVF" node src/oc-cua.mjs get_screen_size >/tmp/odsh_cua_ss 2>&1; then
  ok "get_screen_size: $(cat /tmp/odsh_cua_ss)"
  say 'DONE: Windows desktop channel verified.'
else
  echo; cat /tmp/odsh_cua_ss
  warn 'get_screen_size failed (may need CUA_BIN override); channel not yet verified.'
fi

say 'Next: (optional) on the Windows host run scripts/setup-windows.ps1 to create windows-connect.json,'
say '      or set CUA_BIN manually if your cua-driver.exe is at a non-default path.'