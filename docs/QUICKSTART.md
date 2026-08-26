# Quick Start

## 3. Quick start

> ⚠️ **Self-starting daemon (v1.2+)**: the DSH container auto-starts the bridge daemon
> at boot (`scripts/dsh-entrypoint.sh` → `src/dshtrigger.mjs daemon`). OpenClaw can drop
> a `T-*.json` envelope into `Input/` at any time and DSH will execute it — no manual step,
> and the daemon self-heals (a crashed child restarts automatically).

### 3.0 Get the project

```bash
git clone https://github.com/Mikoribbit/odsh-bridge.git
cd odsh-bridge
# zero dependencies — nothing to install; `.env` is auto-loaded by `src/env.mjs`
```

### 3.0.1 Bring up the containers (Docker Desktop / Docker Engine required)

```bash
# 1. Make your bridge directory from the template (four zones)
cp -r bridge-template /srv/odsh-bridge          # (Windows example: C:/ODSH-bridge, pick any host dir)

# 2. Configure
cp .env.example .env                             # fill OC_TOKEN, DISCORD_CHANNEL_ID etc.
export ODSH_BRIDGE_HOST_DIR=/srv/odsh-bridge     # path of your bridge dir

# 3. Start OpenClaw + DSH on the shared agent-mesh network
docker compose up -d

# 4. (DSH image) if you haven't built deepseek-harness yet, see the image note:
#    clone the DeepSeek Harness repo, docker build -t deepseek-harness:local . , or set your image
```
> Without Docker Desktop (e.g. bare Podman/Buildx), you can still run the bridge core:
> only the two containers + shared mount matter; adapt the compose to your engine.

### Prerequisites (environment prep, verified)

- **Docker** (Docker Desktop on Windows/macOS, or Docker Engine + compose on Linux; Podman with
  compose-compatible flags also works for the bridge core) — the ODSH Bridge is a two-container idea:
  OpenClaw (brain/gateway) + DeepSeek Harness (DSH, execution layer) on one docker network.
  Without Docker you cannot run the same bridge; see §3.0.1 for the compose + `bridge-template` pack.
- Both containers on the same docker network (this repo's example name is `agent-mesh`), named
  `deepseek-harness` and `openclaw`; both must be able to ping the other container's name.
- The shared bridge is mounted at the same absolute path inside both containers (default
  `/root/ODSH-bridge`; the host path is yours (set `ODSH_BRIDGE_HOST_DIR`, e.g. `C:/ODSH-bridge` on Windows, see `docker-compose.snippet.yml`).
- The OpenClaw gateway side is opened up (see `PROTOCOL.md` §2.1):
  - `gateway.controlUi.allowedOrigins` explicitly includes the origin you will use
    (e.g. `http://openclaw:18789`); ⚠️ this path is a protected config — edit `openclaw.json` directly
    (back it up first) and restart the gateway for it to take effect.
  - ⚠️ Security: keep `autoApproveCidrs` **unset**. Auto-approving the whole docker subnet means any
    container on it could pair as an operator device. Pair each device once manually.
  - For untrusted networks, terminate TLS (wss) in front of the gateway (or run it on an isolated
    docker network that only your two containers join). Without TLS, gateway credentials and the
    signed connect claim travel in plaintext on that network — acceptable only on a trusted bridge.

### Deployment steps (bridge core, 3 steps + 1 approval)

```bash
# 1. Configure the environment (inside the DSH container, repo root)
cp .env.example .env
#   edit .env: set OC_TOKEN=<the value of openclaw.json → gateway.auth.token>; fill DISCORD etc. as needed

# 2. Pair + connection test
node src/oc-client.mjs connect
#   first run prints "device not approved"; approve that deviceId in the OpenClaw Control UI

# 3a. Deploy the daemon
node src/bridge-daemon.mjs --notify --interval-ms 5000
# 3b. Or invoke the gateway manually
#   node src/oc-invoke.mjs agents.list '{}'
#   node src/oc-send.mjs "hello" --channel <id>

# 4. Install the OpenClaw-side skill (so OpenClaw knows how to cooperate)
#    on the OpenClaw container:
mkdir -p /root/.openclaw/skills/odsh-interop
cp skills/odsh-interop/SKILL.md /root/.openclaw/skills/odsh-interop/SKILL.md
```

### Enable Windows desktop execution (v1.1, optional)

> Full guide: `CUA-EXECUTION.md`. **Fastest path — two idempotent one-shot scripts:**
>
> ```powershell
> # Windows host (Administrator PowerShell)
> .\scripts\setup-windows.ps1 -BridgePath C:\ODSH-bridge
> ```
> ```bash
> # DSH container
> ./scripts/setup-dsh.sh --bridge /root/ODSH-bridge --host host.docker.internal
> ```
> Each script detects what is already done and skips it; they write
> `windows-connect.json` / `.env` for each other, and the DSH side ends with a live
> `get_screen_size` verification. Manual steps below (for reference / troubleshooting):

```powershell
# A. On the Windows host
irm https://cua.ai/driver/install.ps1 | iex            # install Cua Driver
#   Settings → Optional features → install "OpenSSH Server"
#   (GUI install avoids Add-WindowsCapability CBS errors)
Start-Service sshd; Set-Service sshd -StartupType Automatic
#   if Start-Service fails but `sshd -d` works, use the scheduled-task fallback:
schtasks /create /tn "sshd-keepalive" /tr "C:\Windows\System32\OpenSSH\sshd.exe" /sc onlogon /ru SYSTEM /rl HIGHEST /f
Start-Process -WindowStyle Hidden C:\Windows\System32\OpenSSH\sshd.exe
#   put the DSH public key into (Administrators users only):
#   C:/ProgramData/ssh/administrators_authorized_keys
```

```bash
# B. On the DSH container
apt-get install -y openssh-client
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519 -C "dsh-bridge-cua"
cat /root/.ssh/id_ed25519.pub   # → paste to the Windows file above

# Verify
ssh -i /root/.ssh/id_ed25519 <windows-username>@host.docker.internal whoami
node src/oc-cua.mjs get_screen_size
```

> The bridge core works without this optional step; the Cua channel only unlocks real desktop control.

---

## 4. Configuration (.env fields)

| Variable | Default | Description |
|---|---|---|
| `OC_HOST` | `openclaw` | Gateway container name (DNS, not IP) |
| `OC_PORT` | `18789` | Gateway port |
| `OC_TOKEN` | (required) | The value of `openclaw.json → gateway.auth.token`; **placeholder REPLACE_WITH_GATEWAY_TOKEN** |
| `OC_ORIGIN` | `http://<host>:<port>` | Built dynamically; must be allowed by the gateway's allowedOrigins |
| `OC_KEYS` | `<BRIDGE_PATH>/DSH-Workspace/openclaw-device.json` | Device identity JWK file (auto-generated/reused) |
| `BRIDGE_PATH` | `/root/ODSH-bridge` | Bridge root path |
| `DISCORD_CHANNEL_ID` | (empty) | Target channel id for notifications/sends |
| `OC_RETRY_MS` | `8000` | oc-client pairing wait / reconnect interval |
| `OC_CONNECT_TIMEOUT_MS` | `45000` | Connection (handshake + pairing) timeout |
| `OC_REPLY_TIMEOUT_MS` | `20000` | Single request timeout |
| `BRIDGE_INTERVAL_MS` | `5000` | daemon scan interval |
| `BRIDGE_RUN_TIMEOUT_MS` | `15000` | `run-command` timeout |
| `BRIDGE_ALLOW_ABS_PATHS` | `false` | Whether write/read-file may use absolute paths (secure default false) |
| `OC_SEND_SCRIPT` | `src/oc-send.mjs` | Path to the send script used for notifications |
| `CUA_SSH_USER` | *(required, no default)* | Windows username for the Cua channel |
| `CUA_SSH_HOST` | `host.docker.internal` | Windows host reachable from the container |
| `CUA_SSH_PORT` | `22` | Windows SSH port |
| `CUA_SSH_KEY` | `/root/.ssh/id_ed25519` | SSH private key |
| `CUA_BIN` | `C:/Users/<user>/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe` | Windows cua-driver path |
| `CUA_TIMEOUT_MS` | `60000` | Per-call timeout |

---

