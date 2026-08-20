# ODSH Bridge — OpenClaw × DeepSeek Harness 互联桥

<div align="center">

[**English**](https://github.com/Mikoribbit/odsh-bridge/blob/main/README.md) ·
[**中文**](https://github.com/Mikoribbit/odsh-bridge/blob/main/README.zh.md)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/Node-%3E%3D18-green.svg)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
![Platform](https://img.shields.io/badge/platform-Docker%2Fagent--mesh-blue.svg)

</div>

> 本文为英文 README.md 的中文对照版。

> **一句话定位**：让 DeepSeek Harness（DSH，执行层）通过 WebSocket 接入 OpenClaw/Vivian（大脑/人格层）的网关，
> 并用一个共享目录桥（信封 + 守护进程）完成两个容器之间的可靠任务交接。
>
> 所有能力均来自 2026-08 在 docker `agent-mesh` 网络上的真实集成并跑通验证；未验证/推测项一律标注 `⚠️ 需自行验证`。
> 认证信息全部为占位符——任何真实 token/密钥都不应出现在此仓库。

---

## 目录

- [1. 架构（文字版）](#1-架构文字版)
- [2. 已验证特性](#2-已验证特性)
- [3. 快速开始](#3-快速开始)
- [4. 配置（.env 字段）](#4-配置env-字段)
- [5. 目录结构](#5-目录结构)
- [6. 两种集成方式](#6-两种集成方式)
- [7. 安全注意事项](#7-安全注意事项)
- [8. 常见故障排查](#8-常见故障排查)
- [9. Roadmap（未实现/未验证 → 全部标注 ⚠️）](#9-roadmap未实现--未验证--全部标注-️)
- [10. 相关链接](#10-相关链接)
- [维护笔记](MAINTENANCE.md)

---

## 1. 架构（文字版）

```
┌────────────────────────────── agent-mesh (docker network) ──────────────────────────────┐
│                                                                                         │
│   deepseek-harness (DSH)                        openclaw (OpenClaw / Vivian)             │
│   ├─ oc-invoke.mjs  ──┐                                                                    │
│   ├─ oc-send.mjs   ───┼── WebSocket(:18789) ─────▶  gateway（Device Pairing +            │
│   ├─ oc-client.mjs ───┘   显式 Origin / Ed25519       JSON-RPC 风格方法）                │
│   │                     签名配对 / tools.invoke      ├─ agents.list / status              │
│   └─ bridge-daemon.mjs                              ├─ doctor.memory.*（dreaming 记忆）   │
│         │                                           └─ message（Discord 频道收发）        │
│         └── 共享桥挂载：Input/ Output/ DSH-Workspace/ Openclaw-Workspace/  （信封协议）     │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

数据流两条：

1. **实时通道**：DSH 脚本作为「已配对设备」连入 OpenClaw 网关 18789（HTTP Upgrade + origin 白名单 + Ed25519 签名配对 + `connect.challenge` → `hello-ok`），随后按 JSON-RPC 风格调用方法。
2. **异步桥**：任一侧把任务写成 `Input/T-*.json` 信封 → daemon 监听执行 → `Output/<taskId>_result.json` 原子回写，可选经 `oc-send` 通知 Discord 频道。

---

## 2. 已验证特性

> 以下每一项都是真实环境下实测跑通的。

- ✅ **网关 WebSocket 握手 + Ed25519 设备配对**：HTTP Upgrade（带显式 `Origin`）→ `connect.challenge`（nonce）→ `v2` claim 串签名 → `connect` → `hello-ok`；设备经 Control UI 批准（operator 角色 + 5 个 scope），`deviceId = hex(SHA-256(Ed25519 公钥))` 恒定，批准一次永久有效。**已知坑已修**：claim 与 `device.signedAt` 必须取同一次 `Date.now()`（毫秒不一致会偶发 `device signature invalid`，见 docs/PROTOCOL.md §2.3）。
- ✅ **网关方法调用**：`agents.list`、`status`、`doctor.memory.status`（dreaming 记忆系统）、`crestodian.chat`。
- ✅ **Discord 消息（经 tools.invoke）**：`message` 工具 `action=send` 发消息（`reply.ok && payload.ok` 判定 DELIVERED）；`action=read` 读频道历史——args `{action:"read",channel:"discord",to:"channel:<id>"}` 已实测（返回完整消息列表，2026-08-20 验证）。
- ✅ **桥四区 + 信封协议**：`Input/` 任务入口、`Output/` 结果出口、`DSH-Workspace/` / `Openclaw-Workspace/` 双方私有区；信封 schema `odsh-envelope/v1`，状态机 `queued→running→done|failed|cancelled`，`odsh-result/v1` 结果文件。
- ✅ **守护进程**：`bridge-daemon.mjs` watch `Input/T-*.json` → 按 `payload.kind` 执行（echo / notify / run-command / write-file / read-file / bridge-status）→ 原子写（`.tmp`→rename）→ 可选 `oc-send` 频道通知；按 `taskId` 幂等防重复处理。
- ✅ **DNS 寻址**：默认 `OC_HOST=openclaw` 容器名 + origin 动态构造，容器重启/IP 对调无需改配置（验证环境实测双容器 IP 曾互换）。
- ✅ **身份持久化**：Ed25519 JWK 存桥 `DSH-Workspace/openclaw-device.json`（首次生成、后续复用、deviceId 恒定），文件权限 0600。

---

## 3. 快速开始

### 先决条件（环境准备，均在真实环境验证过）

- 两个容器在同一 docker 网络（本项目示例名 `agent-mesh`），容器名分别为 `deepseek-harness` 与 `openclaw`；**两者都必须能互相 ping 通对方容器名**。
- 共享桥挂载到两侧容器内同一绝对路径（默认 `/root/ODSH-bridge`；宿主机 `H:/ODSH-bridge`，见 `docker-compose.snippet.yml`）。
- OpenClaw 侧网关放行（见 `docs/PROTOCOL.md` §2.1）：
  - `gateway.controlUi.allowedOrigins` 显式包含将要使用的 origin（如 `http://openclaw:18789`）；⚠️ 该路径是受保护配置，需直接编辑 `openclaw.json`（先备份）并重启网关生效。
  - （可选）`autoApproveCidrs` 加入 `172.18.0.0/16` 免逐台批准。

### 部署步骤（3 步 + 1 次批准）

```bash
# 1. 配置环境（在 DSH 容器内，仓库根目录）
cp .env.example .env
#   编辑 .env：OC_TOKEN=<openclaw.json → gateway.auth.token 的取值>；按需填 DISCORD_CHANNEL_ID 等

# 2. 配对 + 连接测试
node src/oc-client.mjs connect
#   首次会打印「设备未批准」，到 OpenClaw Control UI 批准该 deviceId 后自动连上并保持会话

# 3a. 部署守护进程（daemon 全部 kind 见 docs/BRIDGE-SPEC.md §6；单次可用 --once）
node src/bridge-daemon.mjs --notify --interval-ms 5000
# 3b. 其它时候手动调网关
#   node src/oc-invoke.mjs agents.list '{}'   # 通用方法
#   node src/oc-send.mjs "你好" --channel <id> # 发 Discord 消息
```

---

## 4. 配置（.env 字段）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OC_HOST` | `openclaw` | 网关容器名（DNS，勿用 IP） |
| `OC_PORT` | `18789` | 网关端口 |
| `OC_TOKEN` | （必填） | `openclaw.json → gateway.auth.token` 的取值；**占位符 REPLACE_WITH_GATEWAY_TOKEN** |
| `OC_ORIGIN` | `http://<host>:<port>` | 动态构造；需被网关 allowedOrigins 放行 |
| `OC_KEYS` | `<BRIDGE_PATH>/DSH-Workspace/openclaw-device.json` | 设备身份 JWK 文件（自动生成/复用） |
| `BRIDGE_PATH` | `/root/ODSH-bridge` | 桥根路径 |
| `DISCORD_CHANNEL_ID` | （空） | 通知/发送目标频道 id |
| `OC_RETRY_MS` | `8000` | oc-client 配对等待/重连间隔 |
| `OC_CONNECT_TIMEOUT_MS` | `45000` | 连接（握手+配对）超时 |
| `OC_REPLY_TIMEOUT_MS` | `20000` | 单次 request 超时 |
| `BRIDGE_INTERVAL_MS` | `5000` | daemon 扫描间隔 |
| `BRIDGE_RUN_TIMEOUT_MS` | `15000` | `run-command` 超时 |
| `BRIDGE_ALLOW_ABS_PATHS` | `false` | write/read-file 是否允许绝对路径（安全默认 false） |
| `OC_SEND_SCRIPT` | `src/oc-send.mjs` | 通知用发送脚本路径 |

---

## 5. 目录结构

```
plugin-release/
├── README.md                  本文档
├── docs/
│   ├── PROTOCOL.md            网关握手/帧/方法/错误/幂等
│   └── BRIDGE-SPEC.md         桥四区 / 信封 schema / 状态机 / 原子写
├── src/
│   ├── env.mjs                .env 加载（零依赖）
│   ├── gateway-client.mjs     公共 WS+配对模块（openSession/request/safeClose）
│   ├── oc-invoke.mjs          通用网关方法调用 CLI
│   ├── oc-send.mjs            Discord 消息 CLI（tools.invoke message）
│   ├── oc-client.mjs          长连接/配对等待 CLI（connect / node <method>）
│   └── bridge-daemon.mjs      桥守护进程（watch 信封 → 执行 → 回写 → 通知）
├── config/
│   ├── odsh-bridge.ts         Cordis 插件编排（B 方式）
│   └── cordis.yml             合并片段示例
├── docker-compose.snippet.yml 桥挂载 + agent-mesh 网络片段
├── package.json               元数据 + bin + npm run check
├── .env.example               配置样例（全占位符）
├── LICENSE                    MIT
└── CONTRIBUTING.md            本地复现 / 加 kind / 测试
```

---

## 6. 两种集成方式

### A. 独立 node CLI / 守护进程（推荐，已验证形态）

- 零构建零 npm 依赖，`node src/xxx.mjs` 直接用；`.env` 由 `src/env.mjs` 自动加载。
- 连接关闭统一走 `safeClose()`（`gateway-client.mjs`）：新版 `node:net` ESM 的 Socket 只有 `destroy()/resetAndDestroy()`，没有 `.close()`，兼容层优先 `.close()` → `.destroy()` → `.resetAndDestroy()`，全部调用点已替换（请勿在新增代码里直接用 `sock.close()`）。
- 守护进程常驻：`node src/bridge-daemon.mjs --notify --interval-ms 5000`（用 systemd/supervisor 托管即可）。
- 本仓库所有脚本在此形态下交付使用；与你现有 DSH 主进程解耦，互不阻塞。

### B. 作为 Cordis 插件挂进 DSH（⚠️ 未在产品环境实测）

- DSH 是 Cordis 体系：`config/odsh-bridge.ts` 用 `export function apply(ctx, config)` 形态，在 `ctx.effect()` 内以子进程拉起 `bridge-daemon.mjs`，卸载/热更新时 SIGTERM 回收——与官方 cordis-tutorial（02-lifecycle-and-effects.md）的原则一致。
- `config/cordis.yml` 是 `insert:` 合并片段（同 DSH `examples/mcp-memory/*.cordis.yml` 的语法），把 daemon 作为插件条目挂进根 `cordis.yml`：
  - 优点：随 DSH 生命周期托管，热更新可回收子进程；
  - 注意：脚本仍作为独立进程运行，只是生命周期由 Cordis 管理；
  - ⚠️ 该挂载路径未在产品环境实测，请先按文档 A 方式跑通，再切换。

---

## 7. 安全注意事项

1. **token 绝不入库**：`OC_TOKEN` 只存在于 `.env`（已 gitignore）；仓库里的 `.env.example` 全是占位符。
2. **设备配对**：`deviceId` 是设备指纹（Ed25519 公钥的哈希），批准即给予 operator 级权限（含 `operator.admin`/`approvals`/`pairing`）——务必确保网络隔离，不要随意批准陌生设备。
3. **origin 白名单**：宽泛放行降低安全性，生产环境只放行实际使用的 origin；改白名单需重启网关生效。
4. **私钥权限**：JWK 文件生成即 `0600`，位于 DSH-Workspace（对方容器不得改）。
5. **run-command**：daemon 的 `run-command` 有 shell 执行能力（原样校验：首词禁 `;`、`&`、`|`、反引号），仅限可信信封来源；生产建议额外加 requester 白名单（见 BRIDGE-SPEC §8）。

---

## 8. 常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `spawn <script> ENOENT` | 用 DSH 的 tool-runner exec 通道拉起脚本时找不到命令/环境 | 换用长会话（`oc-client connect`）+ 手动 shell 启动 daemon；或把 node 路径写全（`which node`）。⚠️ 验证环境该问题存在，需自行验证你的 DSH 运行器配置。 |
| `ECONNREFUSED / ENOTFOUND` | 连不到网关 | 检查两容器是否在同一 docker 网络、容器名是否正确（`docker exec openclaw getent hosts openclaw`） |
| `handshake rejected / 非 101` | origin 未放行 | 把所用 origin 加入 `gateway.controlUi.allowedOrigins` 并重启网关（先备份 openclaw.json） |
| 容器 IP 对调后连接失效 | 硬编码了 IP | 全部改用容器名 DNS（默认 `OC_HOST=openclaw`），重启后无需重配 |
| `device signature invalid`（偶发、似随机） | **确凿根因（控制变量实验确认）**：claim 签名时间戳与 `device.signedAt` 用了两次 `Date.now()` → 毫秒级不一致 → 网关用 `signedAt` 重建 claim 验签必然失败，仅同毫秒时偶发通过 | 若代码遇到此错，**先检查是否两处时间戳**：应只取一次 `const signedAt = Date.now()`，同时用于 claim 与 device.signedAt（参考 `src/gateway-client.mjs` 现实现；已修复并 4/4 连续成功，health/agents.list/status/oc-send 全通） |
| `PAIRING_REQUIRED` | 设备未批准 | Control UI 批准该 deviceId，随后自动重连成功 |
| daemon 不处理信封 | 已处理（.state 记录）/文件名非 `T-*.json` | 清 `.state` 或换新 taskId；检查文件权限 |

---

## 9. Roadmap（未实现 / 未验证 → 全部标注 ⚠️）

- **F-1** Windows Node 执行节点（`target: windows-node`）桥接：信封 `target` 预留，执行器未实现 ⚠️。
- **F-2** ~~读方向补齐~~ **已实测通过**：`message` 工具 `action=read` 的 args 形态为 `{action:"read",channel:"discord",to:"channel:<id>"}`，`tools.invoke` 可返回完整频道历史（2026-08-20 实测）。
- **F-3** ~~网关 anti-replay / signature invalid 的稳定处理~~ **已解决**：根因是 claim 与 `device.signedAt` 用了两次 `Date.now()`（毫秒级不一致），已统一为单一 `signedAt` 并 4/4 实测通过；剩余可选项是自动重试策略（低优先级）。
- **F-4** daemon 的 `requester` 白名单可启用开关（生产加固）⚠️。
- **F-5** 持久化订阅网关事件（`caps:["tool-events"]`）——连接阶段的 `event` 帧当前忽略 ⚠️。

---

## 10. 相关链接

- DSH：`/app/docs/cordis-tutorial/`（插件形态）、DSH examples/mcp-memory（cordis.yml 合并语法）
- GitHub topic：`dsh-plugin`（本仓库发布后加入该 topic）
- 协议细节：docs/PROTOCOL.md ｜ 桥规范：docs/BRIDGE-SPEC.md

---

> 维护：ODSH Bridge contributors · License: MIT · Node >= 18 · 零依赖 ESM