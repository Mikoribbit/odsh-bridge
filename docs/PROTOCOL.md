# ODSH Bridge 通信协议（PROTOCOL）

对应 `src/gateway-client.mjs`。内容来自 2026-08 在 docker `agent-mesh` 网络上实际跑通并验证的集成：DeepSeek Harness（DSH）↔ OpenClaw（网关端口 18789）。只写验证过的行为；未验证项一律标注「⚠️ 需自行验证」。

## 1. 拓扑与寻址

```
agent-mesh (docker network)
  deepseek-harness (DSH)                  openclaw (OpenClaw)
  ├ oc-invoke.mjs                         ├ gateway :18789
  ├ oc-send.mjs   ──WebSocket──▶          ├ 设备配对（Ed25519 指纹）
  ├ oc-client.mjs    （显式 Origin）        └ JSON-RPC 风格方法（agents.list 等）
  └ bridge-daemon.mjs
        共享桥挂载：Input/ Output/ DSH-Workspace/ Openclaw-Workspace/
```

- 用容器名 DNS 寻址（默认 `OC_HOST=openclaw`），不要硬编码容器 IP。验证教训：容器重启后 IP 可能对调（实测对调过），硬编码 IP 重启后失效；docker 内置 DNS 始终解析正确。
- origin 动态构造：`http://${OC_HOST}:${OC_PORT}`，不写死具体 IP。

## 2. 连接建立（配对握手）

### 2.1 HTTP Upgrade（带显式 Origin）

```
GET / HTTP/1.1
Host: openclaw:18789
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <16 随机字节 base64>
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: json
Origin: http://openclaw:18789
```

网关放行条件（验证环境）：`gateway.controlUi.allowedOrigins` 必须显式包含所用 origin（放行过的示例：`http://localhost:18789`、`http://openclaw:18789`、`http://172.18.x.x:18789`）。⚠️ 需自行验证：该路径是受保护配置，`config.patch` 会拒绝修改，需要直接编辑 openclaw.json（先备份）并重启网关进程生效（reloadKind=restart，非热重载）。可选：`autoApproveCidrs` 加入 `172.18.0.0/16` 免逐台批准。

### 2.2 密钥与指纹

- Ed25519 密钥对存 JWK 文件：`{version:1, createdAtMs, jwk:{kty:"OKP", crv:"Ed25519", x, d}}`（在桥的 DSH-Workspace）。
- 指纹：`deviceId = hex(SHA-256(Ed25519 公钥 x 的原始字节))`，64 个十六进制字符。
- 公钥不变 → deviceId 恒定 → 首次批准后永久有效。JWK 必须持久化：首次生成、后续复用。

### 2.3 challenge → 签名 → connect

1. 服务端下发：`{"type":"event","event":"connect.challenge","payload":{"nonce":"<uuid>","ts":1787251465376}}`
2. claim（顺序勿改，9 段 `|` 连接）：

```
v2|<deviceId>|<clientId>|<clientMode>|<role>|<scopes(逗号连接)>|<signedAtMs>|<token>|<nonce>
```

3. Ed25519 对 claim 的 UTF-8 字节签名，base64url 编码。

> **⚠️ 关键教训（确凿根因，控制变量实验确认 + 已修复）：claim 签名时间戳与 device.signedAt 必须取同一值。**
> 同样的 keyfile 与 token 下，生产版稳定成功、发布版随机失败；逐字段对比确认根因：
> claim 用 `String(Date.now())` 签名，而 `device.signedAt: Date.now()` 又取了一次 →
> 两次 `Date.now()` 毫秒级不同 → 网关用 `device.signedAt` 重建 claim 验签必然失败，
> 表现为**偶发**（似随机）的 `device signature invalid`（仅两次恰好同毫秒时偶尔能过）。
> **修复**：单一 `const signedAt = Date.now()`，claim 与 `device.signedAt` 共用同一值
> （`gateway-client.mjs` 已如此实现）。实测：修复后 4/4 连续成功，health / agents.list / status / oc-send（tools.invoke）全通。
4. 发送 connect（验证环境原样）：

```json
{"type":"req","id":"<uuid>","method":"connect","params":{"minProtocol":4,"maxProtocol":4,"client":{"id":"openclaw-control-ui","version":"control-ui","platform":"web","mode":"webchat","instanceId":"<dsh-ts>"},"role":"operator","scopes":["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"],"device":{"id":"<deviceId>","publicKey":"<x>","signature":"<sig>","signedAt":<ms>,"nonce":"<nonce>"},"caps":["tool-events"],"auth":{"token":"<OC_TOKEN>"},"userAgent":"DSH","locale":"en"}}
```

> params 字段名全部来自验证环境实际报文。其中 `locale` 存疑，删掉不影响连接 ⚠️ 需自行验证。


### 2.4 批准（首次必经）

- 未批准：`{"type":"res","ok":false,"error":{"code":"PAIRING_REQUIRED","message":"..."}}`
- 到 OpenClaw Control UI 批准该 `deviceId`（operator 角色 + 5 个 operator scope）。
- `oc-client.mjs connect` 每 `OC_RETRY_MS`（默认 8 秒）自动重试直到获批。

### 2.5 连接成功

```json
{"type":"res","ok":true,"payload":{"type":"hello-ok","protocol":4,
 "server":{"version":"2026.7.1-2","connId":"..."},
 "features":{"methods":["health","diagnostics.stability","doctor.memory.status", "crestodian.chat", ...]}}}
```

- 判据：`payload.type === "hello-ok"`。
- `payload.features.methods` 是网关全部方法清单（验证环境抓到），可做能力发现。

## 3. 帧格式

双向 JSON 文本帧（WS opcode 0x1；客户端掩码固定 `[0x01,0x02,0x03,0x04]`）：

| 方向 | 形态 | 说明 |
|---|---|---|
| 客户端 → | `{"type":"req","id":"<uuid>","method":"<方法>","params":{...}}` | id 每次随机生成 |
| 服务端 → | `{"type":"res","id":"<uuid>","ok":true,"payload":{...}}` | id 与请求一致 |
| 服务端 → | `{"type":"res","id":"<uuid>","ok":false,"error":{"code":...}}` | 失败 |
| 服务端 → | `{"type":"event","event":"<name>","payload":{...}}` | 事件（如 connect.challenge） |

## 4. 已验证方法

| 方法 | params 示例 | 备注 |
|---|---|---|
| agents.list | `{}` | 返回 agent 列表 |
| doctor.memory.status | `{}` | dreaming 记忆系统状态 |
| status | `{}` | 运行状态 |
| crestodian.chat | `{"message":"hello"}` | 横幅守卫对话 |
| tools.invoke | `{"name":"message","args":{"action":"send","channel":"discord","to":"channel:<id>","text":"hi"}}` | 工具名在 name，参数在 args |

- tools.invoke 的 message 工具：`reply.ok===true && reply.payload.ok===true` 才算 DELIVERED；调试信息在 `payload.output.delivered` / `payload.output.deliveryStatus`。
- `action:"read"` **已实测通过（2026-08-20）**：args `{action:"read",channel:"discord",to:"channel:<id>"}`，`tools.invoke` 返回 `payload.output.content[0].text`（内含完整消息列表，含 author/timestamp/id）。

## 5. 错误处理

| 现象 | 含义 | 客户端动作 |
|---|---|---|
| HTTP 应答非 101 | origin 未放行 / 网关不可达 | 报错，提示检查 allowedOrigins |
| error.code === PAIRING_REQUIRED | 设备未批准 | oc-client 自动重试；CLI 提示去批准 |
| `device signature invalid`（偶发、似随机） | **确凿根因（控制变量实验确认）**：claim 签名时间戳与 `device.signedAt` 不一致——两次 `Date.now()` 毫秒级不同 → 网关用 `signedAt` 重建 claim 验签必然失败，仅同毫秒时偶发通过 | 取单一 `signedAt` 同时用于 claim 与 `device.signedAt`（见 §2.3 与 `gateway-client.mjs` 现实现；已实测 4/4 连续成功）。若**新代码**仍遇此错，**先检查是否两处时间戳** |
| ok:false + error{code,message} | 业务错误 | 透出 code/message，退出码非 0 |
| close 帧（op8） | 网关断开 | 清理 pending，触发 onClose（oc-client 重连） |
| 请求超时 | OC_REPLY_TIMEOUT_MS 默认 20s | 拒绝该请求，由调用方决定重试 |

## 6. 消息幂等与重试

- 每次请求 `id` 用 `crypto.randomUUID()`。重试语义自行设计：非幂等方法（如发消息）不要盲目重发；幂等且网关按 id 去重（⚠️ 未验证）时可复用同一 id 重发。
- 桥信封按 `taskId` 幂等，`.state/dsh-processed.json` 防重复处理（见 BRIDGE-SPEC.md）。
- oc-client 断开后每 `OC_RETRY_MS` 退避重连；寻址用 DNS 容器名，重启 / IP 对调无需改配置。

## 7. 安全清单

1. `OC_TOKEN` 只写在 `.env`（不入库）；取值 = `openclaw.json → gateway.auth.token`。
2. JWK 私钥文件权限 600（发布版生成即 0600），不入 git（.gitignore 排除 *.jwk）。
3. origin 尽量用容器名；确需 IP 放行时，重启容器后同步网关 allowedOrigins 并重启网关生效。
4. `run-command` 信封任务仅限可信来源（见 BRIDGE-SPEC 的安全小节）。