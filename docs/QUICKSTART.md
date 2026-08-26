# Quick Start

> ⚠️ **Self-starting daemon (v1.2+)**: the DSH container auto-starts the bridge daemon at boot
> (`scripts/dsh-entrypoint.sh` → `src/dshtrigger.mjs daemon`). OpenClaw can drop a `T-*.json`
> envelope into `Input/` at any time and DSH executes it — **no manual daemon step**, and the
> daemon self-heals (a crashed child restarts automatically).

## 1. Prerequisites

- **Docker** (Docker Desktop on Windows/macOS, or Docker Engine + compose on Linux; Podman with
  compose-compatible flags also works for the bridge core). ODSH Bridge is a two-container idea:
  OpenClaw (brain / gateway) + DeepSeek Harness (DSH, execution layer) on one docker network.
- **Two images**:
  - OpenClaw — official `openclaw/openclaw:latest` (Docker Hub).
  - DSH — **no public image**; build it from the official repo:
    ```bash
    git clone https://github.com/deepseek-ai/deepseek-harness.git dsh-src && cd dsh-src
    docker build -t deepseek-harness:local .
    ```
- Both containers on the same docker network (this repo's example name `agent-mesh`), each able to
  reach the other by container name.
- OpenClaw gateway allowed origins must include the origin you use (see `docs/PROTOCOL.md` §2.1).

## 2. Scaffold the bridge — interactive wizard (recommended)

One command walks you through every value with a visual prompt; **press Enter to accept the
bracketed default**, type to override, and answer yes/no prompts.

```bash
cd odsh-bridge
chmod +x scripts/new-bridge.sh
./scripts/new-bridge.sh          # interactive wizard
```

You'll be asked, in order:

| Prompt | Default | Notes |
|---|---|---|
| bridge host dir | `C:/ODSH-bridge` | where the four zone folders live on the host |
| container mount path | `/root/ODSH-bridge` | the in-container path both sides agree on |
| OpenClaw service name | `openclaw` | container / service name |
| DSH service name | `deepseek-harness` | container / service name |
| gateway port | `18789` | OpenClaw gateway port |
| OC_TOKEN | placeholder | paste the key from `openclaw.json → gateway.auth.token` |
| Discord channel id | *(none)* | for completion notifications (optional) |
| generate docker-compose.yaml? | `y` | writes a ready-to-run compose into the bridge dir |
| enable Cua Desktop channel? | `n` | optional Windows desktop execution (see §5) |
| Windows SSH username | `whoami` | only if Cua enabled |

The wizard copies the four zones (`Input/ Output/ DSH-Workspace/ Openclaw-Workspace/`), writes a
`.env` with `BRIDGE_PATH` pointed at your mount path, and (if chosen) a `docker-compose.yaml`
whose volumes mount `<host-dir>` → `<bind>`.

> **Non-interactive one-liner** still works (same result, no prompts):
> ```bash
> ./scripts/new-bridge.sh /srv/odsh-bridge --no-compose
> ```

## 3. Bring up the containers

```bash
docker compose up -d          # from the generated docker-compose.yaml (or the repo one)
```

- The **DSH container auto-starts the bridge daemon** via its `entrypoint` (self-starting, no manual step).
- Verify it is alive:
```bash
node src/dshtrigger.mjs status        # shows health: { running: true, pid: … }
```

## 4. Pair once + verify

```bash
# inside the DSH container, repo root
node src/oc-client.mjs connect
#   first run prints "device not approved" → approve that deviceId in the OpenClaw Control UI.
```

Then confirm end-to-end:

```bash
node src/dshtrigger.mjs send --kind echo --text "hello"     # drop an envelope, get a result
```

## 5. Optional — Windows desktop execution (Cua Driver)

> Full guide: `docs/CUA-EXECUTION.md`. Fastest path — two idempotent one-shot scripts:

```powershell
.\scripts\setup-windows.ps1 -BridgePath C:\ODSH-bridge
```
```bash
./scripts/setup-dsh.sh --bridge /root/ODSH-bridge --host host.docker.internal
```

Each script detects what is already set up and skips it; they write `windows-connect.json` /
`.env` for each other, and the DSH side ends with a live `get_screen_size` verification.

## 6. Next

- **Config / `.env` fields / directory**: `docs/CONFIGURATION.md`
- **Standalone vs Cordis-plugin**: `docs/INTEGRATIONS.md`
- **Real ops, security, troubleshooting**: `docs/OPERATIONS.md`
