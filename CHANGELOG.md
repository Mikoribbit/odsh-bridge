# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [SemVer](https://semver.org/).

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