# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [SemVer](https://semver.org/).

## [1.1.0] — 2026-08-21

Cua-powered Windows desktop execution, documentation overhaul, and the
removal of the early "Windows Node" experiment.

### Added

- **Windows desktop execution via Cua Driver** (`src/oc-cua.mjs`): DSH
  (container) → SSH (key-only, ed25519) → `cua-driver call <tool> '<json>'`
  on the Windows host. Verified in the real environment: screen size read,
  UIA accessibility tree, full desktop snapshot, browser CDP tools,
  click/type/hotkey, app launch — all **without stealing focus**.
- **Guide** `docs/CUA-EXECUTION.md`: Windows-side install (Cua Driver +
  OpenSSH Server + scheduled-task fallback + key placement for
  Administrators), DSH-side SSH key setup, usage examples, verification
  checklist, security posture.
- **README rewrite** (EN + zh): three-data-flow architecture (realtime /
  async bridge / desktop execution), verified-features incl. Cua, quick
  start incl. Cua enablement, .env table incl. `CUA_*`, roadmap F-6/F-7,
  and a **Credits** section thanking the trycua team (Cua Driver).
- **One-shot setup scripts** (`scripts/setup-windows.ps1` + `scripts/setup-dsh.sh`):
  idempotent Windows-host and DSH-container installers — Cua Driver locate/install,
  OpenSSH service + scheduled-task fallback, firewall 22, Administrators key placement
  (`administrators_authorized_keys`), `cua-driver serve` check, bridge
  `windows-connect.json` handoff, DSH `.env` `CUA_*` write, SSH test, and a live
  `get_screen_size` verification.
- **`oc-cua.mjs` loads `.env`** (via `env.mjs`) so `CUA_BIN` from setup-dsh's `/ .env`
  or `windows-connect.json` is honored.
- **setup-windows.ps1 OpenSSH auto-install** (3 levels): try
  `Add-WindowsCapability` -> `winget Microsoft.OpenSSH.Beta` -> clear GUI guidance,
  all idempotent (re-run continues). The scheduled-task fallback already covers the
  Windows "service manager fails to start sshd" edge case.
- **`CUA_*` environment variables**: `CUA_SSH_USER`, `CUA_SSH_HOST`,
  `CUA_SSH_PORT`, `CUA_SSH_KEY`, `CUA_BIN`, `CUA_TIMEOUT_MS`.

### Changed

- **Skill** `skills/odsh-interop/SKILL.md`: routing decision updated —
  DSH can handle Windows desktop tasks via Cua Driver (remove the old
  "DSH has no Windows node capability" assumption).
- **Bridge spec** `docs/BRIDGE-SPEC.md`: `target: windows-node` kept
  reserved (not used) — the Cua channel is the supported desktop path.
- **package.json**: version 1.1.0; `bin` adds `oc-cua`.

### Removed

- Early **"Windows Node" experiment** (never part of a release): removed
  `docs/WINDOWS-NODE.md`, `src/oc-node.mjs` and the node-invoke envelope
  example. The bridge daemon keeps a backward-compatible envelope branch
  for `run-node`/`windows-node` but it is no longer the documented desktop
  path.

### Security

- Cua channel: SSH is key-only (`BatchMode=yes`), Windows-side key
  whitelist limited to the DSH identity; `CUA_SSH_*` must stay in
  controlled env vars (never committed). Documented revocation guidance.

---

## [1.0.0] — 2026-08-20

Initial release — the first fully verified, publishable release of the
ODSH Bridge (OpenClaw × DeepSeek Harness interop).
### Added

- **Gateway WebSocket client** (`src/gateway-client.mjs`): zero-dependency
  client with explicit `Origin` handshake, Ed25519 device pairing
  (`deviceId = hex(SHA-256(public key))`), `connect.challenge` flow, and a
  JSON-RPC-style request/response framing (`request` / `send`). Persistent
  JWK device identity (approved once, valid forever).
- **CLI tools**: `oc-invoke` (call any gateway method), `oc-send`
  (send/read Discord channel messages via `tools.invoke` + `message` tool),
  `oc-client` (long-lived connect / pairing wait).
- **Bridge daemon** (`src/bridge-daemon.mjs`): watches `Input/T-*.json`
  envelopes → executes by `payload.kind` (echo / notify / run-command /
  write-file / read-file / bridge-status) → atomic `.tmp`→rename result into
  `Output/<taskId>_result.json` → optional Discord notification.
  Idempotent per `taskId`; tick-level fault tolerance.
- **Docs**: `PROTOCOL.md` (handshake/frames/error table), `BRIDGE-SPEC.md`
  (four-zone bridge + envelope schema + state machine).
- **i18n**: English `README.md` + Chinese `README.zh.md`; code comments
  English-primary with Chinese bilingual notes.

### Fixed

- `node:net` ESM `Socket` has no `.close()` → `safeClose()` compatibility
  layer (`.close()` → `.destroy()` → `.resetAndDestroy()`).
- Intermittent `device signature invalid` → root cause confirmed: claim
  signature and `device.signedAt` used two separate `Date.now()` calls
  (millisecond mismatch). Fixed by sharing a single `signedAt`. Verified
  4/4 consecutive successes (health / agents.list / status / oc-send).

### Security

- Credentials are placeholders only; real tokens/keys must never be
  committed (`.gitignore` covers `.env`, `*.jwk`, `*device.json`, `*.tmp`).
- Gateway origin must be whitelisted in
  `gateway.controlUi.allowedOrigins` (documented).