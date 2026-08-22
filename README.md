# ODSH Bridge — OpenClaw × DeepSeek Harness connectivity bridge

<div align="center">

[**English**](https://github.com/Mikoribbit/odsh-bridge/blob/main/README.md) ·
[**中文**](https://github.com/Mikoribbit/odsh-bridge/blob/main/README.zh.md)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/Node-%3E%3D18-green.svg)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
![Platform](https://img.shields.io/badge/platform-Docker%2Fagent--mesh-blue.svg)

</div>

> **One-line positioning**: lets DeepSeek Harness (DSH, the execution layer) reach the OpenClaw (brain/persona layer)
> gateway over WebSocket, hand off tasks reliably between the two containers through a shared directory bridge
> (envelope + daemon), and — since **v1.1** — operate a **real Windows desktop** on the host machine via
> **SSH + [Cua Driver](https://github.com/trycua/cua)** (no OpenClaw Desktop, no dedicated node daemon).

> Everything here comes from a real integration that was run and verified in 2026-08 on the docker
> `agent-mesh` network; anything not verified or speculative is marked `⚠️ verify yourself`.
> All credentials are placeholders — no real token/secret should ever appear in this repository.

---

## Table of contents

- [1. Architecture](#1-architecture-text-version)
- [2. Verified features](#2-verified-features)
- [3. Quick start](#3-quick-start)
- [4. Configuration (.env fields)](#4-configuration-env-fields)
- [5. Directory structure](#5-directory-structure)
- [6. Integration approaches](#6-integration-approaches)
- [7. Windows desktop execution (Cua Driver)](#7-windows-desktop-execution-cua-driver)
- [8. Security notes](#8-security-notes)
- [9. Troubleshooting (common failures)](#9-troubleshooting-common-failures)
- [10. Roadmap](#10-roadmap)
- [11. Credits](#11-credits)
- [Maintenance notes](MAINTENANCE.md)

---

## 1. Architecture (text version)

```
┌────────────────────────────── agent-mesh (docker network) ────────────────────────────────┐
│                                                                                           │
│   deepseek-harness (DSH)                        openclaw (OpenClaw)                │
│   ├─ oc-invoke.mjs  ──┐                                                                    │
│   ├─ oc-send.mjs   ───┼── WebSocket(:18789) ─────▶ gateway (Device Pairing +          │
│   ├─ oc-client.mjs ───┘   explicit Origin / Ed25519   JSON-RPC-style methods)           │
│   │                      signed pairing / tools.invoke ├─ agents.list / status            │
│   └─ bridge-daemon.mjs                                ├─ doctor.memory.* (dreaming)      │
│         │                                             └─ message (Discord send/recv)      │
│   └─ oc-cua.mjs ─── SSH(:22, ed25519) ──────────────▶ Windows host                     │
│         │                                             └─ Cua Driver (cua-driver serve)    │
│         └── shared bridge mount: Input/ Output/ DSH-Workspace/ Openclaw-Workspace/         │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

There are three data flows:

1. **Realtime channel**: A DSH script connects to the OpenClaw gateway on 18789 as a "paired device"
   (HTTP Upgrade + origin allowlist + Ed25519 signature pairing + `connect.challenge` → `hello-ok`),
   then calls methods in a JSON-RPC style.
2. **Async bridge**: Either side writes a task envelope to `Input/T-*.json` → the daemon watches and
   executes it → atomically writes back `Output/<taskId>_result.json`, optionally notifying a Discord
   channel via `oc-send`.
3. **Windows desktop execution (v1.1+)**: DSH calls `oc-cua.mjs` → `ssh` into the Windows host →
   invokes `cua-driver call <tool> '<json>'` → the driver operates the real desktop (snapshot,
   click/type/hotkey, browser via CDP, app launch) **without stealing focus**.

---

## 2. Verified features

> Each item below was actually exercised and passed in the real environment.

- ✅ **Gateway WebSocket handshake + Ed25519 device pairing**: HTTP Upgrade (with explicit `Origin`) →
  `connect.challenge` (nonce) → sign the `v2` claim string → `connect` → `hello-ok`; the device is
  approved through the Control UI (operator role + 5 scopes). `deviceId = hex(SHA-256(Ed25519 public
  key))` stays constant, so a device approved once stays approved forever. **Known pitfall fixed**: the
  claim and `device.signedAt` must come from the same `Date.now()` call (see docs/PROTOCOL.md §2.3).
- ✅ **Gateway method calls**: `agents.list`, `status`, `health`, `talk.catalog`,
  `talk.session.create`, `tools.invoke` (message send/read), `config.schema.lookup` — all pass.
- ✅ **Async bridge**: envelope → daemon → result, with `.tmp → rename` atomic writes and an idempotent
  `.state` store; kinds `echo / notify / run-command / write-file / read-file / bridge-status`.
- ✅ **Windows desktop execution via Cua Driver (v1.1)**: verified from the DSH container over SSH:
  - `cua-driver --version` → 0.21.0
  - `get_screen_size` → real host resolution (e.g. 2560×1440)
  - `get_accessibility_tree` → live desktop process tree via UIA
  - full tool surface: `get_desktop_state`, `browser_navigate/click/type/pointer`, `launch_app`,
    `kill_app`, `click/double_click/right_click/hotkey/type/scroll`, `list_apps`, `list_windows` …

---

## 3. Quick start

### 3.0 Get the project

```bash
git clone https://github.com/Mikoribbit/odsh-bridge.git
cd odsh-bridge
# zero dependencies — nothing to install; `.env` is auto-loaded by `src/env.mjs`
```

### 3.0.1 Bring up the containers (Docker Desktop / Docker Engine required)

```bash
# 1. Make your bridge directory from the template (four zones)
cp -r bridge-template /srv/odsh-bridge          # or H:/ODSH-bridge on Docker Desktop/Windows

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
  `/root/ODSH-bridge`; host `H:/ODSH-bridge`, see `docker-compose.snippet.yml`).
- The OpenClaw gateway side is opened up (see `docs/PROTOCOL.md` §2.1):
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

> Full guide: `docs/CUA-EXECUTION.md`. **Fastest path — two idempotent one-shot scripts:**
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

## 5. Directory structure

```
plugin-release/
├── README.md                  This document (EN)
├── README.zh.md               Chinese version
├── AUTHORS.md                 Maintainer / contributors
├── CHANGELOG.md               Version history (Keep a Changelog)
├── MAINTENANCE.md             Verified troubleshooting notes
├── docs/
│   ├── PROTOCOL.md            Gateway handshake / frames / methods / errors / idempotency
│   ├── BRIDGE-SPEC.md         Bridge four zones / envelope schema / state machine / atomic write
│   └── CUA-EXECUTION.md       Windows desktop execution via Cua Driver (install/authorize/use)
├── skills/
│   └── odsh-interop/          OpenClaw-side skill (SKILL.md + install README)
├── src/
│   ├── env.mjs                .env loader
│   ├── gateway-client.mjs     Shared WS/Ed25519 pairing client
│   ├── oc-invoke.mjs          Invoke any gateway method
│   ├── oc-send.mjs            Send a message via gateway
│   ├── oc-client.mjs          Pairing wait / long-lived client
│   ├── oc-cua.mjs             (v1.1) SSH + Cua Driver desktop execution
│   ├── bridge-daemon.mjs      Envelope watcher/executor
│   └── bridge-cleanup.mjs     Retention cleanup tool
├── scripts/                   One-shot idempotent setup
│   ├── setup-windows.ps1      Windows host: Cua Driver + OpenSSH + firewall + key + connect json
│   └── setup-dsh.sh           DSH container: ssh client + key + .env + verify get_screen_size
├── config/                    Cordis plugin form (⚠️ optional, not product-verified)
├── docker-compose.yml         Runnable compose template (OpenClaw official image + DSH build/image)
├── bridge-template/           Copy-ready directory bridge: Input/ Output/ DSH-Workspace/ Openclaw-Workspace/
├── .env.example               Env template (all placeholders)
└── LICENSE  ·  package.json  ·  docker-compose.snippet.yml (legacy snippet)
```

---

## 6. Integration approaches

### A. Standalone CLI / daemon (recommended, verified form)

- Zero build, zero npm dependencies, run `node src/xxx.mjs` directly; `.env` is auto-loaded by `src/env.mjs`.
- Connections always close through `safeClose()` (`gateway-client.mjs`): the newer `node:net` ESM Socket
  has only `destroy()/resetAndDestroy()`, no `.close()`; see comments in `gateway-client.mjs`.
- Daemon runs as a long-lived process: `node src/bridge-daemon.mjs --notify --interval-ms 5000`
  (manage with systemd/supervisor).

### B. Mounted into DSH as a Cordis plugin (⚠️ not tested in the product environment)

- `config/odsh-bridge.ts`: `export function apply(ctx, config)` shape, spawns `bridge-daemon.mjs`
  inside `ctx.effect()`, reclaiming with SIGTERM on unload/hot-reload (consistent with the official Cordis
  tutorial). `config/cordis.yml` is an `insert:` merge snippet.
- ⚠️ this mount path was not tested in the product environment — get method A working first, then switch.

---

## 7. Windows desktop execution (Cua Driver)

See **`docs/CUA-EXECUTION.md`** for the full guide. Summary:

- **Why**: gives the DSH execution layer real, focus-safe desktop control on the Windows host —
  screenshot, click/type, browser automation (CDP), app launch — without any OpenClaw Desktop or a
  dedicated node process.
- **How it works**: `src/oc-cua.mjs` runs `ssh -i <key> <user>@<host> "cua-driver call <tool> '<json>'"`.
- **Security posture**: SSH is key-only (`BatchMode=yes`), the Windows side whitelists exactly the DSH
  container's public key; the driver operates the real desktop but never steals focus.

---

## 8. Security notes

1. **Never commit tokens**: `OC_TOKEN` lives only in `.env` (gitignored); everything in the repo's
   `.env.example` is a placeholder.
2. **Device pairing**: `deviceId` is a device fingerprint (a hash of the Ed25519 public key); approving it
   grants operator-level permissions — make sure your network is isolated and do not approve unknown devices
   casually.
3. **Origin allowlist**: broad openings lower security; in production only allow the origin you actually use;
   changing the allowlist requires a gateway restart.
4. **Private key permissions**: the JWK file is created `0600` and lives in DSH-Workspace (the other container
   must not modify it).
5. **run-command**: the daemon's `run-command` can execute shell (verbatim check: the first word may not
   start with `;`, `&`, `|`, or a backtick) — only trust envelope sources; in production add a requester
   allowlist (see BRIDGE-SPEC §8).
6. **Cua channel**: SSH key is limited to the DSH identity; keep `CUA_SSH_*` in controlled env vars (never
   commit). Revoke the key immediately if the Windows host or container is compromised.

---

## 9. Troubleshooting (common failures)

| Symptom | Cause | Fix |
|---|---|---|
| `spawn <script> ENOENT` | Command/environment missing when launched through DSH's tool-runner exec channel | Use a long-lived session (`oc-client connect`) + start the daemon from a manual shell; give the full node path (`which node`). ⚠️ verify your DSH runner config. |
| `ECONNREFUSED / ENOTFOUND` | Cannot reach the gateway | Check both containers on the same docker network and the container name (`docker exec openclaw getent hosts openclaw`) |
| `handshake rejected / non-101` | origin not allowed | Add the origin to `gateway.controlUi.allowedOrigins` and restart the gateway (back up openclaw.json first) |
| Connection breaks after container IP swap | An IP was hardcoded | Use container-name DNS everywhere (default `OC_HOST=openclaw`) |
| `device signature invalid` (intermittent) | **Confirmed root cause**: claim signature timestamp and `device.signedAt` used two separate `Date.now()` calls → millisecond mismatch | Use a single `const signedAt = Date.now()` for both (see `gateway-client.mjs`) |
| `PAIRING_REQUIRED` | Device not approved | Approve that deviceId in the Control UI |
| daemon does not process envelopes | Already processed (`.state`) / filename is not `T-*.json` | Clear `.state` or use a new taskId |
| Cua: `Connection refused` on 22 | sshd not running (service-manager start fails) | Use `sshd.exe -d` debug-check; if that works, use the scheduled-task fallback (see docs/CUA-EXECUTION.md §1.2) |
| Cua: `Permission denied (publickey)` | Key not in `administrators_authorized_keys` (Administrators user) | Put the DSH pubkey there with `icacls ... Administrators:F`; see docs/CUA-EXECUTION.md §1.4 |
| Cua: `cua-driver: not recognized` or wrong path | PATH / install location differs | Set `CUA_BIN` to the real full path of `cua-driver.exe` |

---

## 10. Roadmap

- **F-2 (done)** `message` tool read direction verified: `{action:"read",channel:"discord",to:"channel:<id>"}`.
- **F-3 (done)** Gateway anti-replay / signature-invalid root cause fixed (single `signedAt`).
- **F-4** Daemon `requester` allowlist (production hardening) ⚠️.
- **F-5** Persistent subscription to gateway events (`caps:["tool-events"]`) ⚠️.
- **F-6** Cua channel hardening: capability manifest (`--permission-mode bounded`) + per-app allowlist ⚠️.
- **F-7** Envelope `target: windows-node` kept reserved but unused; the Cua channel is the supported desktop path.

---

## 11. Credits

- **Cua** — this project's Windows desktop execution layer is powered by
  [Cua Driver](https://github.com/trycua/cua) (by the trycua team). Huge thanks for an open, cross-platform,
  focus-safe computer-use driver that lets agents drive desktop apps without stealing the user's cursor.
  The Cua Driver is independently licensed by its authors — see their repository for details.

---

> Maintained by: ODSH Bridge contributors · License: MIT · Node >= 18 · Zero-dependency ESM
