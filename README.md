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
> gateway over WebSocket, and hand off tasks reliably between the two containers through a shared directory bridge
> (envelope + daemon).
>
> Everything here comes from a real integration that was run and verified in 2026-08 on the docker `agent-mesh`
> network; anything not verified or speculative is marked `⚠️ verify yourself`.
> All credentials are placeholders — no real token/secret should ever appear in this repository.

---

## Table of contents

- [1. Architecture](#1-architecture-text-version)
- [2. Verified features](#2-verified-features)
- [3. Quick start](#3-quick-start)
- [4. Configuration (.env fields)](#4-configuration-env-fields)
- [5. Directory structure](#5-directory-structure)
- [6. Two integration approaches](#6-two-integration-approaches)
- [7. Security notes](#7-security-notes)
- [8. Troubleshooting (common failures)](#8-troubleshooting-common-failures)
- [9. Roadmap](#9-roadmap-not-implemented--not-verified--all-marked-️)
- [10. Related links](#10-related-links)
- [Maintenance notes](MAINTENANCE.md)

---

## 1. Architecture (text version)

```
┌────────────────────────────── agent-mesh (docker network) ──────────────────────────────┐
│                                                                                         │
│   deepseek-harness (DSH)                        openclaw (OpenClaw)             │
│   ├─ oc-invoke.mjs  ──┐                                                                    │
│   ├─ oc-send.mjs   ───┼── WebSocket(:18789) ─────▶  gateway (Device Pairing +           │
│   ├─ oc-client.mjs ───┘   explicit Origin / Ed25519    JSON-RPC-style methods)           │
│   │                      signed pairing / tools.invoke ├─ agents.list / status            │
│   └─ bridge-daemon.mjs                                ├─ doctor.memory.* (dreaming)       │
│         │                                             └─ message (Discord send/recv)      │
│         └── shared bridge mount: Input/ Output/ DSH-Workspace/ Openclaw-Workspace/  (envelope)│
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

There are two data flows:

1. **Realtime channel**: A DSH script connects to the OpenClaw gateway on 18789 as a "paired device"
   (HTTP Upgrade + origin allowlist + Ed25519 signature pairing + `connect.challenge` → `hello-ok`),
   then calls methods in a JSON-RPC style.
2. **Async bridge**: Either side writes a task envelope to `Input/T-*.json` → the daemon watches and
   executes it → atomically writes back `Output/<taskId>_result.json`, optionally notifying a Discord
   channel via `oc-send`.

---

## 2. Verified features

> Each item below was actually exercised and passed in the real environment.

- ✅ **Gateway WebSocket handshake + Ed25519 device pairing**: HTTP Upgrade (with explicit `Origin`) →
  `connect.challenge` (nonce) → sign the `v2` claim string → `connect` → `hello-ok`; the device is
  approved through the Control UI (operator role + 5 scopes). `deviceId = hex(SHA-256(Ed25519 public
  key))` stays constant, so a device approved once stays approved forever. **Known pitfall fixed**: the
  claim and `device.signedAt` must come from the same `Date.now()` call (a millisecond mismatch
  intermittently raises `device signature invalid`, see docs/PROTOCOL.md §2.3).
- ✅ **Gateway method calls**: `agents.list`, `status`, `doctor.memory.status` (dreaming memory system),
  `crestodian.chat`.
- ✅ **Discord messages (via tools.invoke)**: the `message` tool with `action=send` posts a message
  (`reply.ok && payload.ok` means DELIVERED); `action=read` reads channel history — the args
  `{action:"read",channel:"discord",to:"channel:<id>"}` were verified (returns the full message list,
  verified 2026-08-20).
- ✅ **Bridge four zones + envelope protocol**: `Input/` task entry, `Output/` result exit, and the two
  per-side private zones `DSH-Workspace/` / `Openclaw-Workspace/`; envelope schema `odsh-envelope/v1`,
  state machine `queued→running→done|failed|cancelled`, `odsh-result/v1` result files.
- ✅ **Daemon**: `bridge-daemon.mjs` watches `Input/T-*.json` → executes per `payload.kind`
  (echo / notify / run-command / write-file / read-file / bridge-status) → atomic write
  (`.tmp`→rename) → optional `oc-send` channel notification; idempotent per `taskId`.
- ✅ **DNS addressing**: default `OC_HOST=openclaw` container name + dynamically built origin, so a
  container restart or IP swap needs no config change (in the verify environment the two container IPs
  actually swapped).
- ✅ **Identity persistence**: the Ed25519 JWK is stored at the bridge `DSH-Workspace/openclaw-device.json`
  (generated on first run, reused afterwards, constant `deviceId`), file mode 0600.

---

## 3. Quick start

### 3.0 Get the project (no release yet — clone or download)

There is no packaged release yet; get the code from this repository:

```bash
git clone https://github.com/Mikoribbit/odsh-bridge.git
cd odsh-bridge
# zero dependencies — nothing to install; `.env` is auto-loaded by `src/env.mjs`
```

Or download the ZIP from the green **Code ▾ → Download ZIP** button on GitHub
and unpack it.

### Prerequisites (environment prep, all verified in the real environment)

- Both containers are on the same docker network (this project's example name is `agent-mesh`), named
  `deepseek-harness` and `openclaw`; **both must be able to ping the other container's name**.
- The shared bridge is mounted at the same absolute path inside both containers (default
  `/root/ODSH-bridge`; host `H:/ODSH-bridge`, see `docker-compose.snippet.yml`).
- The OpenClaw gateway side is opened up (see `docs/PROTOCOL.md` §2.1):
  - `gateway.controlUi.allowedOrigins` explicitly includes the origin you will use
    (e.g. `http://openclaw:18789`); ⚠️ this path is a protected config — edit `openclaw.json` directly
    (back it up first) and restart the gateway for it to take effect.
  - (Optional) add `172.18.0.0/16` to `autoApproveCidrs` to skip per-device approval.

### Deployment steps (3 steps + 1 approval)

```bash
# 1. Configure the environment (inside the DSH container, repo root)
cp .env.example .env
#   edit .env: set OC_TOKEN=<the value of openclaw.json → gateway.auth.token>; fill DISCORD_CHANNEL_ID etc. as needed

# 2. Pair + connection test
node src/oc-client.mjs connect
#   on first run it prints "device not approved"; approve that deviceId in the OpenClaw Control UI and it connects and stays

# 3a. Deploy the daemon (all kinds see docs/BRIDGE-SPEC.md §6; single pass with --once)
node src/bridge-daemon.mjs --notify --interval-ms 5000
# 3b. Otherwise invoke the gateway manually
#   node src/oc-invoke.mjs agents.list '{}'   # generic method
#   node src/oc-send.mjs "hello" --channel <id> # send a Discord message

# 4. Install the OpenClaw-side skill (without it, OpenClaw doesn't know how to cooperate)
#    on the OpenClaw container:
mkdir -p /root/.openclaw/skills/odsh-interop
cp skills/odsh-interop/SKILL.md /root/.openclaw/skills/odsh-interop/SKILL.md
#    see skills/odsh-interop/README.md for details
```

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

---

## 5. Directory structure

```
plugin-release/
├── README.md                  This document (EN)
├── README.zh.md               Chinese version (this document, zh)
├── AUTHORS.md                 Maintainer / contributors
├── CHANGELOG.md               Version history (Keep a Changelog)
├── MAINTENANCE.md             Verified troubleshooting notes
├── docs/
│   ├── PROTOCOL.md            Gateway handshake / frames / methods / errors / idempotency
│   └── BRIDGE-SPEC.md         Bridge four zones / envelope schema / state machine / atomic write
├── skills/
│   └── odsh-interop/          OpenClaw-side skill (SKILL.md + install README)
├── src/
│   ├── env.mjs                .env loading (zero dependencies)
│   ├── gateway-client.mjs     Shared WS+pairing module (openSession/request/safeClose)
│   ├── oc-invoke.mjs          Generic gateway method invocation CLI
│   ├── oc-send.mjs            Discord message CLI (tools.invoke message)
│   ├── oc-client.mjs          Long-connection / pairing-wait CLI (connect / node <method>)
│   └── bridge-daemon.mjs      Bridge daemon (watch envelopes → execute → write back → notify)
├── config/
│   ├── odsh-bridge.ts         Cordis plugin orchestration (method B)
│   └── cordis.yml             Merge-snippet example
├── docker-compose.snippet.yml Bridge mount + agent-mesh network snippet
├── package.json               Metadata + bin + npm run check
├── .env.example               Config sample (all placeholders)
├── LICENSE                    MIT
└── CONTRIBUTING.md            Local reproduction / adding kinds / testing
```

---

## 6. Two integration approaches

### A. Standalone node CLI / daemon (recommended, verified form)

- Zero build, zero npm dependencies, run `node src/xxx.mjs` directly; `.env` is auto-loaded by `src/env.mjs`.
- Connections always close through `safeClose()` (`gateway-client.mjs`): the newer `node:net` ESM Socket has
  only `destroy()/resetAndDestroy()`, no `.close()`; the compatibility layer prefers `.close()` →
  `.destroy()` → `.resetAndDestroy()`, and all call sites have been updated (do not call `sock.close()`
  directly in new code).
- Daemon runs as a long-lived process: `node src/bridge-daemon.mjs --notify --interval-ms 5000`
  (manage with systemd/supervisor).
- All scripts in this repo ship in this form; they are decoupled from your existing DSH main process and
  do not block each other.

### B. Mounted into DSH as a Cordis plugin (⚠️ not tested in the product environment)

- DSH is Cordis-based: `config/odsh-bridge.ts` uses an `export function apply(ctx, config)` shape and, inside
  `ctx.effect()`, spawns `bridge-daemon.mjs` as a child process, reclaiming it with SIGTERM on unload/hot-reload —
  consistent with the official cordis-tutorial (02-lifecycle-and-effects.md) principles.
- `config/cordis.yml` is an `insert:` merge snippet (same syntax as DSH `examples/mcp-memory/*.cordis.yml`)
  that hooks the daemon into the root `cordis.yml` as a plugin entry:
  - Pros: hosted with the DSH lifecycle, hot-reload can reclaim the child process;
  - Note: the script still runs as an independent process, only its lifecycle is managed by Cordis;
  - ⚠️ this mount path was not tested in the product environment — get method A working first, then switch.

---

## 7. Security notes

1. **Never commit tokens**: `OC_TOKEN` lives only in `.env` (gitignored); everything in the repo's
   `.env.example` is a placeholder.
2. **Device pairing**: `deviceId` is a device fingerprint (a hash of the Ed25519 public key); approving it
   grants operator-level permissions (including `operator.admin`/`approvals`/`pairing`) — make sure your
   network is isolated and do not approve unknown devices casually.
3. **Origin allowlist**: broad openings lower security; in production only allow the origin you actually use;
   changing the allowlist requires a gateway restart to take effect.
4. **Private key permissions**: the JWK file is created `0600` and lives in DSH-Workspace (the other container
   must not modify it).
5. **run-command**: the daemon's `run-command` can execute shell (verbatim check: the first word may not start
   with `;`, `&`, `|`, or a backtick) — only trust envelope sources; in production add a requester
   allowlist (see BRIDGE-SPEC §8).

---

## 8. Troubleshooting (common failures)

| Symptom | Cause | Fix |
|---|---|---|
| `spawn <script> ENOENT` | The command/environment is missing when the script is launched through DSH's tool-runner exec channel | Use a long-lived session (`oc-client connect`) + start the daemon from a manual shell; or give the full node path (`which node`). ⚠️ this problem exists in the verify environment; verify your DSH runner config. |
| `ECONNREFUSED / ENOTFOUND` | Cannot reach the gateway | Check that both containers are on the same docker network and the container name is correct (`docker exec openclaw getent hosts openclaw`) |
| `handshake rejected / non-101` | origin not allowed | Add the origin you use to `gateway.controlUi.allowedOrigins` and restart the gateway (back up openclaw.json first) |
| Connection breaks after container IP swap | An IP was hardcoded | Use container-name DNS everywhere (default `OC_HOST=openclaw`); no reconfiguration needed after restart |
| `device signature invalid` (intermittent, looks random) | **Confirmed root cause (verified by controlled-variable experiment)**: the claim signature timestamp and `device.signedAt` used two separate `Date.now()` calls → millisecond mismatch → the gateway rebuilds the claim from `signedAt` to verify the signature and necessarily fails, only occasionally passing when both land in the same millisecond | If you hit this error, **first check whether there are two timestamps**: take a single `const signedAt = Date.now()` and use it for both the claim and `device.signedAt` (see the current implementation in `src/gateway-client.mjs`; already fixed and passing 4/4 in a row — health/agents.list/status/oc-send all OK) |
| `PAIRING_REQUIRED` | Device not approved | Approve that deviceId in the Control UI, then it reconnects automatically |
| daemon does not process envelopes | Already processed (recorded in `.state`) / filename is not `T-*.json` | Clear `.state` or use a new taskId; check file permissions |

---

## 9. Roadmap (not implemented / not verified → all marked ⚠️)

- **F-1** Windows Node execution node (`target: windows-node`) bridging: the envelope `target` is reserved
  but the executor is not implemented ⚠️.
- **F-2** ~~Completing the read direction~~ **verified working**: the `message` tool's `action=read` args
  form is `{action:"read",channel:"discord",to:"channel:<id>"}`, and `tools.invoke` can return the full
  channel history (verified 2026-08-20).
- **F-3** ~~Stable handling of gateway anti-replay / signature invalid~~ **resolved**: the root cause was the
  claim and `device.signedAt` using two separate `Date.now()` calls (millisecond mismatch); unified to a
  single `signedAt` and verified passing 4/4; the remaining optional item is an automatic retry policy
  (low priority).
- **F-4** A switch to enable the daemon's `requester` allowlist (production hardening) ⚠️.
- **F-5** Persistent subscription to gateway events (`caps:["tool-events"]`) — the `event` frames during the
  connect phase are currently ignored ⚠️.

---

## 10. Related links

- DSH: `/app/docs/cordis-tutorial/` (plugin form), DSH examples/mcp-memory (cordis.yml merge syntax)
- GitHub topic: `dsh-plugin` (add this topic after publishing this repo)
- Protocol details: `docs/PROTOCOL.md` · Bridge spec: `docs/BRIDGE-SPEC.md`

---

> Maintained by: ODSH Bridge contributors · License: MIT · Node >= 18 · Zero-dependency ESM