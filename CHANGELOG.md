# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [SemVer](https://semver.org/).

## [1.1.2] — 2026-08-21

Patch release — documentation/example correctness (no functional change).

### Added

- `ROADMAP.md`: phase-gated long-term plan (ClawHub skill publishing, Cordis plugin
  ecosystem, event bus), linked from README §10 (EN + zh).

### Fixed

- Remove assumptions that the bridge host path is drive "H:": defaults in compose templates
  now use `./bridge` / `<bridge-host-dir>`; README/BRIDGE-SPEC/AUTHORS/MAINTENANCE updated to
  neutral examples (`C:/ODSH-bridge` on Windows, `/srv/odsh-bridge` on Linux). `setup-windows.ps1`
  still auto-probes common locations (H:/, C:/, user profile) — that is intentional.

---
## [1.1.1] — 2026-08-21

Patch release — security regression fix + CI.

### Fixed

- **WS client mask was still constant** `0x01,0x02,0x03,0x04` in the shipped tree (the earlier
  hardening edit had not persisted); now truly `crypto.randomBytes(4)` per frame. Caught by the
  new regression suite before you could run it twice.
- package.json `test` script wired; `npm run check` extended with `bash -n scripts/setup-dsh.sh`.

### Added

- **GitHub Actions CI** (`.github/workflows/ci.yml`): on every push/PR to `main`, runs Node 20
  syntax checks + `tests/security.test.mjs` (injection fail-closed, secret scan, hardening
  presence) + bash syntax + repo-cleanliness guard.
- **`tests/security.test.mjs`**: reproducible regression tests covering every v1.1.0 hardening
  item (oc-cua tool allowlist, daemon argv allowlist / path confinement / requester allowlist /
  atomic state, gateway handshake & mask, no miko default, no obvious secrets).

---
## [1.1.0] — 2026-08-21
### Security (v1.1.0 hardening — from a full repo audit)

- **oc-cua.mjs: strict tool-name allowlist** (`^[A-Za-z0-9_][A-Za-z0-9_-]*# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [SemVer](https://semver.org/).

) - blocks
  command injection into the remote PowerShell/cmd call (e.g. `x\" & whoami & \"` fails closed).
  JSON args stay base64+stdin (safe). `CUA_SSH_USER` is now required (no default).
- **bridge-daemon: run-command is now argv-allowlisted only** (no `/bin/sh -c`); the old
  first-word charset check was bypassable (`ls ;id`, `ls && id`). Fixed command map +
  literal argv passing.
- **bridge-daemon: read-file/write-file path confinement** - `BRIDGE_ALLOW_ABS_PATHS`
  (default false) is now actually enforced; absolute paths and `..` are rejected;
  realpath must stay inside BRIDGE (blocks `.env` / JWK / authorized_keys reads).
- **bridge-daemon: requester allowlist** (`BRIDGE_ALLOW_REQUESTERS`) - empty accepts all;
  set e.g. `openclaw,dsh` to restrict which senders can execute envelopes.
- **bridge-daemon: `.state` atomic write + fail-closed read** (unreadable state aborts the
  tick instead of silently resetting and re-executing everything).
- **gateway-client: per-frame random WS mask** (RFC 6455) and **strict handshake**
  (exact `101` status + `Sec-WebSocket-Accept` SHA-1 check) instead of `includes('101')`.
- **gateway-client: OC_TOKEN placeholder guard** - refuse to connect with the .env.example
  placeholder or an empty token.
- **SSH**: `StrictHostKeyChecking=accept-new` + explicit known_hosts (no more `=no`);
  `setup-windows.ps1` downloads the Cua installer to a temp file before running it
  (no blind `irm | iex`), and documents TLS/isolated-network guidance; README/PROTOCOL
  no longer recommend `autoApproveCidrs`.
- **Privacy**: Windows username / hostname examples genericized to `<windows-username>`;
  `CUA_SSH_USER` no longer defaults to a personal name.
- **CI (GitHub Actions)**: `.github/workflows/ci.yml` + `tests/security.test.mjs` regression
  suite (syntax, injection fail-closed, secret scan, hardening presence) on every push/PR.
- **Fix found by CI**: WS client mask was still the constant `0x01,0x02,0x03,0x04` in the
  worktree (earlier edit not persisted) — now truly `crypto.randomBytes(4)` and guarded by test.

---

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
- **Docker onboarding pack**: runnable `docker-compose.yml` template
  (OpenClaw official image `openclaw/openclaw:latest`, DSH via local build/your image,
  shared agent-mesh network, bridge mount) + `bridge-template/` directory bridge
  (Input/Output/DSH-Workspace/Openclaw-Workspace + per-zone READMEs) so new users can
  bring up both containers and the four-zone bridge in minutes.
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