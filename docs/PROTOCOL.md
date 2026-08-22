# ODSH Bridge Communication Protocol (PROTOCOL)

Corresponds to `src/gateway-client.mjs`. Content comes from the integration actually run and verified in 2026-08 on the docker `agent-mesh` network: DeepSeek Harness (DSH) ↔ OpenClaw (gateway port 18789). Only verified behavior is documented; anything unverified is marked "⚠️ verify it yourself".

## 1. Topology & Addressing

```
agent-mesh (docker network)
  deepseek-harness (DSH)                  openclaw (OpenClaw)
  ├ oc-invoke.mjs                         ├ gateway :18789
  ├ oc-send.mjs   ──WebSocket──▶          ├ device pairing (Ed25519 fingerprint)
  ├ oc-client.mjs    (explicit Origin)     └ JSON-RPC-style methods (agents.list, etc.)
  └ bridge-daemon.mjs
         shared bridge mounts: Input/ Output/ DSH-Workspace/ Openclaw-Workspace/
```

- Address by container-name DNS (default `OC_HOST=openclaw`); do not hardcode container IPs. Verified lesson: container IPs can swap after a restart (actually observed), and hardcoded IPs stop working after the restart; the docker built-in DNS always resolves correctly.
- Origin is built dynamically: `http://${OC_HOST}:${OC_PORT}`, never a fixed IP.

## 2. Connection Establishment (Pairing Handshake)

### 2.1 HTTP Upgrade (with explicit Origin)

```
GET / HTTP/1.1
Host: openclaw:18789
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <16 random bytes base64>
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: json
Origin: http://openclaw:18789
```

Gateway admission conditions (verified environment): `gateway.controlUi.allowedOrigins` must explicitly include the origin in use (previously allowed examples: `http://localhost:18789`, `http://openclaw:18789`, `http://172.18.x.x:18789`). ⚠️ Verify it yourself: this path is protected config — `config.patch` refuses to modify it; you must edit openclaw.json directly (back it up first) and restart the gateway process for it to take effect (reloadKind=restart, not hot reload). ⚠️ Do NOT enable `autoApproveCidrs` on shared docker subnets: any container there could pair as an operator device. Prefer manual per-device approval. Also: without TLS (wss) in front of the gateway, gateway credentials and the signed connect claim cross the docker bridge in plaintext — keep the bridge network isolated or terminate TLS first.
- zh: 要点：网关只放行 allowedOrigins 显式列出的 origin；该配置受保护，config.patch 拒绝修改，需直接编辑 openclaw.json 并重启网关（reloadKind=restart）生效。

### 2.2 Keys & Fingerprint

- Ed25519 keypair stored as a JWK file: `{version:1, createdAtMs, jwk:{kty:"OKP", crv:"Ed25519", x, d}}` (in the bridge's DSH-Workspace).
- Fingerprint: `deviceId = hex(SHA-256(raw bytes of the Ed25519 public key x))`, 64 hex characters.
- Public key unchanged → deviceId constant → valid forever after the first approval. The JWK must be persisted: generated on first run, reused afterwards.

### 2.3 challenge → sign → connect

1. Server sends: `{"type":"event","event":"connect.challenge","payload":{"nonce":"<uuid>","ts":1787251465376}}`
2. Claim (order fixed — 9 segments joined by `|`):

```
v2|<deviceId>|<clientId>|<clientMode>|<role>|<scopes(comma-joined)>|<signedAtMs>|<token>|<nonce>
```

3. Ed25519-sign the UTF-8 bytes of the claim, base64url-encoded.

> **⚠️ Key lesson (confirmed root cause — control-variable experiment + fixed): the claim signature timestamp and device.signedAt must be the same value.**
> With the same keyfile and token, the production build succeeded consistently while the release build failed randomly; field-by-field comparison confirmed the root cause:
> the claim was signed with `String(Date.now())`, while `device.signedAt: Date.now()` took another reading →
> the two `Date.now()` calls differ at the millisecond level → the gateway rebuilds the claim from `device.signedAt` to verify the signature and necessarily fails,
> manifesting as **intermittent** (seemingly random) `device signature invalid` (only occasionally passing when the two happen to fall in the same millisecond).
> **Fix**: a single `const signedAt = Date.now()`, used for both the claim and `device.signedAt`
> (`gateway-client.mjs` already implements this). Verified: after the fix, 4/4 consecutive successes — health / agents.list / status / oc-send (tools.invoke) all passed.
- zh: 核心教训：claim 签名与 device.signedAt 必须共用同一个 Date.now() 值，否则网关重建 claim 验签必然失败（偶发 device signature invalid）。

4. Send connect (verbatim from the verified environment):

```json
{"type":"req","id":"<uuid>","method":"connect","params":{"minProtocol":4,"maxProtocol":4,"client":{"id":"openclaw-control-ui","version":"control-ui","platform":"web","mode":"webchat","instanceId":"<dsh-ts>"},"role":"operator","scopes":["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"],"device":{"id":"<deviceId>","publicKey":"<x>","signature":"<sig>","signedAt":<ms>,"nonce":"<nonce>"},"caps":["tool-events"],"auth":{"token":"<OC_TOKEN>"},"userAgent":"DSH","locale":"en"}}
```

> All `params` field names come from actual messages in the verified environment. Of these, `locale` is questionable — removing it does not affect the connection ⚠️ verify it yourself.

### 2.4 Approval (mandatory on first connect)

- Not approved: `{"type":"res","ok":false,"error":{"code":"PAIRING_REQUIRED","message":"..."}}`
- Approve that `deviceId` in the OpenClaw Control UI (operator role + the 5 operator scopes).
- `oc-client.mjs connect` retries automatically every `OC_RETRY_MS` (default 8 s) until approved.

### 2.5 Connection Success

```json
{"type":"res","ok":true,"payload":{"type":"hello-ok","protocol":4,
 "server":{"version":"2026.7.1-2","connId":"..."},
 "features":{"methods":["health","diagnostics.stability","doctor.memory.status", "crestodian.chat", ...]}}}
```

- Criterion: `payload.type === "hello-ok"`.
- `payload.features.methods` is the full list of gateway methods (captured in the verified environment) — usable for capability discovery.

## 3. Frame Format

Bidirectional JSON text frames (WS opcode 0x1; client mask fixed `[0x01,0x02,0x03,0x04]`):

| Direction | Shape | Notes |
|---|---|---|
| Client → | `{"type":"req","id":"<uuid>","method":"<method>","params":{...}}` | id regenerated per request |
| Server → | `{"type":"res","id":"<uuid>","ok":true,"payload":{...}}` | id matches the request |
| Server → | `{"type":"res","id":"<uuid>","ok":false,"error":{"code":...}}` | failure |
| Server → | `{"type":"event","event":"<name>","payload":{...}}` | event (e.g. connect.challenge) |

## 4. Verified Methods

| Method | params example | Notes |
|---|---|---|
| agents.list | `{}` | returns the list of agents |
| doctor.memory.status | `{}` | dreaming memory-system status |
| status | `{}` | runtime status |
| crestodian.chat | `{"message":"hello"}` | banner-guard conversation |
| tools.invoke | `{"name":"message","args":{"action":"send","channel":"discord","to":"channel:<id>","text":"hi"}}` | tool name in `name`, arguments in `args` |

- tools.invoke message tool: `reply.ok===true && reply.payload.ok===true` counts as DELIVERED; debug info is in `payload.output.delivered` / `payload.output.deliveryStatus`.
- `action:"read"` **actually tested and passed (2026-08-20)**: args `{action:"read",channel:"discord",to:"channel:<id>"}`; `tools.invoke` returns `payload.output.content[0].text` (the full message list, including author/timestamp/id).

## 5. Error Handling

| Symptom | Meaning | Client action |
|---|---|---|
| HTTP response ≠ 101 | origin not allowed / gateway unreachable | report an error, prompt to check allowedOrigins |
| error.code === PAIRING_REQUIRED | device not approved | oc-client retries automatically; CLI prompts you to approve |
| `device signature invalid` (intermittent, seemingly random) | **confirmed root cause (control-variable experiment)**: claim signature timestamp and `device.signedAt` differ — the two `Date.now()` calls differ at the millisecond level → the gateway rebuilds the claim from `signedAt` to verify the signature and necessarily fails, only occasionally passing in the same millisecond | take a single `signedAt` and use it for both the claim and `device.signedAt` (see §2.3 and the current `gateway-client.mjs` implementation; verified 4/4 consecutive successes). If **new code** still hits this error, **first check whether there are two timestamps** |
| ok:false + error{code,message} | business error | surface code/message, exit code non-zero |
| close frame (op8) | gateway disconnected | clean up pending, trigger onClose (oc-client reconnects) |
| request timeout | OC_REPLY_TIMEOUT_MS default 20 s | reject that request; caller decides whether to retry |

## 6. Message Idempotency & Retry

- Each request `id` uses `crypto.randomUUID()`. Retry semantics are your own design: don't blindly resend non-idempotent methods (e.g. sending a message); when the method is idempotent and the gateway dedupes by id (⚠️ unverified), you may resend with the same id.
- Bridge envelopes are idempotent by `taskId`; `.state/dsh-processed.json` prevents reprocessing (see BRIDGE-SPEC.md).
- After a disconnect, oc-client backs off and reconnects every `OC_RETRY_MS`; addressing uses DNS container names, so restarts / IP swaps need no config change.

## 7. Security Checklist

1. `OC_TOKEN` is only written to `.env` (never committed); its value = `openclaw.json → gateway.auth.token`.
2. JWK private-key file permissions 600 (the release build creates it with 0600), never in git (.gitignore excludes *.jwk).
3. Prefer container-name origins; if an IP really needs to be allowed, sync the gateway allowedOrigins after restarting the container and restart the gateway for it to take effect.
4. `run-command` envelope tasks are restricted to trusted sources (see the Security section of BRIDGE-SPEC).