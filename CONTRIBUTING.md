# Contribution Guide (CONTRIBUTING)

## Local reproduction (minimal environment)

- Requires: Node.js >= 18 (no npm dependencies, pure ESM `.mjs`).
- Option A (full): following `docker-compose.snippet.yml`, bring up the agent-mesh network + two containers → mount the shared bridge →
  `cp .env.example .env` and fill it in → `node src/oc-client.mjs connect` (connects automatically after approval in the Control UI) →
  `node src/bridge-daemon.mjs --notify`.
- Option B (offline): use only the bridge, no gateway. Point `BRIDGE_PATH` at an empty directory,
  drop an envelope in manually, then verify with `--once`:

```bash
mkdir -p /tmp/bridge-dev/Input /tmp/bridge-dev/Output
cat > /tmp/bridge-dev/Input/T-dev-01.json <<'EOF'
{"schema":"odsh-envelope/v1","taskId":"T-dev-01","type":"execute","status":"queued",
 "requester":"dsh","target":"dsh","createdMs":1787249900000,
 "payload":{"kind":"echo","text":"dev smoke"},"result":null}
EOF
BRIDGE_PATH=/tmp/bridge-dev node src/bridge-daemon.mjs --once
cat /tmp/bridge-dev/Output/T-dev-01_result.json   # expecting status: done
```

## Adding a new payload.kind (four steps)

1. Add a case to the `executePayload()` switch in `src/bridge-daemon.mjs` (returning a JSON-serializable object).
2. Add one row to the table in `docs/BRIDGE-SPEC.md` §6.
3. Write a matching envelope smoke test based on Option B above (including the failure branch).
4. Run `node --check src/bridge-daemon.mjs` and `npm run check`.

## About the protocol implementation

- Handshake/signature/frame changes must be kept in sync with `docs/PROTOCOL.md` and `src/gateway-client.mjs`;
- Never hardcode tokens/keys/channel ids in code: always read them from environment variables, with
  placeholders written in `.env.example`;
- Branches not yet verified against a real gateway (e.g. ping/pong, the read action, `expiresMs` expiry) must keep
  the `⚠️ verify yourself` marker in their comments, and the README feature list may only include verified items.

## Testing and committing

- Minimal smoke: `npm run check` (syntax of all scripts) + one Option B envelope run + one identity-persistence check
  (two `loadIdentity` calls yield the same `deviceId`).
- Commit messages: concise English, or Chinese if you prefer; one-line summary plus a body only when needed.