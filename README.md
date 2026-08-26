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


## Documentation (split)

To keep this page short, the deep-dive sections moved into their own pages:

| Page | Covers |
|------|--------|
| [**Quick Start**](docs/QUICKSTART.md) | getting the project, bring up containers, deploy the daemon, optional Cua |
| [**Configuration**](docs/CONFIGURATION.md) | `.env` fields + directory structure |
| [**Integrations**](docs/INTEGRATIONS.md) | standalone daemon vs Cordis plugin |
| [**Operations**](docs/OPERATIONS.md) | Cua Windows desktop, security notes, troubleshooting |
| [**Roadmap**](ROADMAP.md) | phase-gated long-term plan (ClawHub, plugin ecosystem, event bus) |
| [**Protocol**](docs/PROTOCOL.md) | gateway handshake / JSON-RPC details |
| [**Bridge Spec**](docs/BRIDGE-SPEC.md) | envelope format, state machine, zones |
| [**Maintenance**](MAINTENANCE.md) | objectively-observed issues & fixes |

---

## Support

If this project helps you, consider supporting its maintainer:

<a href="https://www.buymeacoffee.com/mikoribbit" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-orange.png" alt="Buy Me A Coffee" height="45" width="auto"></a>

> ☕ [buymeacoffee.com/mikoribbit](https://www.buymeacoffee.com/mikoribbit)

---

## 3. Docs quick index (one-liner)

- **New to ODSH Bridge?** → start with [Quick Start](docs/QUICKSTART.md).
- **Anything about config/paths?** → [Configuration](docs/CONFIGURATION.md).
- **Cua Windows desktop, security, errors?** → [Operations](docs/OPERATIONS.md).

---

## 11. Credits

- **Cua** — this project's Windows desktop execution layer is powered by
  [Cua Driver](https://github.com/trycua/cua) (by the trycua team). Huge thanks for an open, cross-platform,
  focus-safe computer-use driver that lets agents drive desktop apps without stealing the user's cursor.
  The Cua Driver is independently licensed by their authors — see their repository for details.

---

> Maintained by: ODSH Bridge contributors · License: MIT · Node >= 18 · Zero-dependency ESM