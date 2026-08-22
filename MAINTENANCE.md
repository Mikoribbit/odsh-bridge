# Maintenance Notes

> Objectively recorded issues that were **actually encountered and resolved**
> during real-world use of this project. Only reproducible problems and their
> verified fixes are listed here — nothing speculative, nothing private.

## How to use this file

- Each entry follows: **Symptom → Cause → Fix**.
- "Verified" means the fix was executed and confirmed working in the reference
  environment (docker `agent-mesh`, two containers: DeepSeek Harness ↔ OpenClaw).
- If you hit an entry, apply the fix; if it does not help, open an issue with
  your environment details.

---

## 1. `spawn bash ENOENT` — DSH tool-runner cannot start commands

- **Symptom**: in the DSH Web UI, every bash/node tool call fails immediately
  with `spawn bash ENOENT`; error logs say `spawn failed: Error: spawn bash ENOENT`.
  The container's own shell still works (`docker exec ... sh -c 'echo ok'` succeeds).
- **Cause**: the DSH agent session's *exec runner* lost its binding to the
  container's process namespace (not a missing `bash`: `/bin/bash` exists and is
  healthy — verified).
- **Fix (verified)**:
  1. Restart the DSH web process (kill the `node ... apps/cli/src/bin.ts web` PID
     holding port 3080; docker auto-restarts it). If still broken:
  2. **Fork / open a brand-new DSH session** — the fresh session gets a clean
     runner→container channel. After forking, `echo` worked again (verified).
- **Prevention**: keep tool scripts and identity on a persistent shared volume
  (e.g. the bridge) so a session loss does not lose work.

## 2. `device signature invalid` (intermittent, looks random)

- **Symptom**: gateway replies `INVALID_REQUEST / device signature invalid` during
  connect, but only *some* runs fail while others (same keyfile, same token) pass.
- **Cause (verified root cause)**: the claim string was signed with
  `String(Date.now())` while `device.signedAt: Date.now()` took a *second* read.
  The two millisecond timestamps differ → the gateway rebuilds the claim from
  `device.signedAt` to verify → signature mismatch; only occasionally passes when
  both reads land in the same millisecond.
- **Fix (verified, 4/4 consecutive successes)**: take **one** `const signedAt =
  Date.now()` and use it for both the claim and `device.signedAt`. See current
  `src/gateway-client.mjs` and `docs/PROTOCOL.md §2.3`.

## 3. `origin not allowed` — Control UI / WS connect rejected

- **Symptom**: browser shows "Gateway rejected this page origin" or the WS
  connect returns `CONTROL_UI_ORIGIN_NOT_ALLOWED` /
  `origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)`.
- **Cause**: OpenClaw's gateway validates the HTTP `Origin` header against a
  whitelist (`gateway.controlUi.allowedOrigins`); an unlisted origin is dropped
  even when `allowInsecureAuth: true`.
- **Fix (verified)**: add the exact origin(s) you connect from to
  `gateway.controlUi.allowedOrigins` in `openclaw.json`:
  ```json
  "allowedOrigins": ["http://localhost:18789", "http://openclaw:18789"]
  ```
  then reload the gateway (hot reload) / restart. In our setup the DNS container
  name origin (`http://openclaw:18789`) is what the DSH tools send.

## 4. Container IP changed after restart → connections fail

- **Symptom**: everything worked, then after a `docker compose down/up` (or plain
  restart) both containers are healthy but DSH→OpenClaw connects are refused /
  destination unreachable.
- **Cause (verified)**: Docker may reassign container IPs — in our case the two
  containers' addresses *swapped* (`172.18.0.2` ↔ `172.18.0.3`). Hardcoded IPs
  went stale.
- **Fix (verified)**: never address the peer by IP. Use the **docker network DNS
  container name** (`openclaw`), and build the `Origin` from the host dynamically
  (`http://${OC_HOST}:${OC_PORT}`). This is already the default in the published
  tooling. Container start order no longer matters.

## 5. `node:net` ESM has no `Socket.close()`

- **Symptom**: after a clean disconnect a script crashes with
  `Error: sock.close is not a function` (or the socket never closes cleanly).
- **Cause (verified)**: the ESM `node:net` `Socket` API exposes
  `destroy()`/`resetAndDestroy()` but **not** `.close()` (older CJS-style code
  uses `.close()`).
- **Fix (verified)**: use a `safeClose()` helper that prefers `.close()`, falls
  back to `.destroy()`, then `.resetAndDestroy()`. All close sites in
  `src/gateway-client.mjs` use it.

## 6. DSH tool channel broke after container restart — files fine, commands dead

- **Symptom**: file tools (read/write via the harness) work, but every shell
  spawn fails; persists across `docker restart` and even new sessions until...
- **Cause**: exec runner binding (see #1) — distinct from the file system, which
  remains healthy on the persistent bridge.
- **Fix (verified)**: fork a new session (see #1). The bridge files, identities
  and scripts survive because they live on the shared persistent volume.

---

## Release / version workflow (verified, used for v1.0.0)

1. Edit code/docs in the working copy.
2. `npm run check` (syntax-checks all `.mjs`).
3. Update `CHANGELOG.md` (Keep a Changelog format).
4. Commit, tag: `git tag v1.0.x` and `git push origin v1.0.x`.
5. Keep `README.md` (EN) and `README.zh.md` (ZH) in structural parity.

## 7. Cross-mount permission mismatch (UID/GID) — WSL2 footgun

- **Symptom**: both containers share the bridge, but one side gets `EACCES` /
  permission-denied when writing into `Input/` or `Output/`, even though the
  other side writes fine.
- **Cause**: on WSL2-hosted docker (or any cross-host mount), if the two
  containers run as **different users** (e.g. one `root`, one `node`/non-root),
  the file ownership/umask written by one side blocks the other.
- **Fix (verified)**: align the users explicitly — add `user: "${UID}:${GID}"`
  to **both** services in `docker-compose.snippet.yml`, or once on the host run
  `chmod -R 770 <bridge-host-dir>` so both users can write. In our verified
  environment both containers run as root (0:0), which is why it worked out of
  the box; plan for this if you switch to non-root.

## 8. Bridge retention — stale files accumulate

- **Symptom**: `Input/` and `Output/` accumulate old envelopes/results over time.
- **Fix**: run the bundled cleanup tool (`src/bridge-cleanup.mjs`) on a schedule
  (e.g. cron) — it removes files older than N days (default 7) while protecting
  `.state`, `README.md`, and dotfiles:
  ```bash
  node src/bridge-cleanup.mjs --days 7          # real delete
  node src/bridge-cleanup.mjs --days 7 --dry-run # preview
  ```

## Environment facts (reference only)

- Network: docker network `agent-mesh` (external), both containers attached.
- Bridge mount: host dir → `/root/ODSH-bridge` in both containers.
- Device identity: persisted Ed25519 JWK (approved once; `deviceId` constant).
- Discord channel: dedicated collaboration channel for bridge notifications.