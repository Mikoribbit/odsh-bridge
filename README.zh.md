# ODSH Bridge — OpenClaw × DeepSeek Harness 互联桥

<div align="center">

[**English**](https://github.com/Mikoribbit/odsh-bridge/blob/main/README.md) ·
[**中文**](https://github.com/Mikoribbit/odsh-bridge/blob/main/README.zh.md)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/Node-%3E%3D18-green.svg)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
![Platform](https://img.shields.io/badge/platform-Docker%2Fagent--mesh-blue.svg)

</div>

> **一句话定位**：让 DeepSeek Harness（DSH，执行层）通过 WebSocket 连接 OpenClaw（大脑/人格层）网关，
> 借助共享目录桥（信封 + 守护进程）在两侧容器间可靠交接任务；**自 v1.1 起**，还能通过
> **SSH + [Cua Driver](https://github.com/trycua/cua)** 操作**宿主机上的真实 Windows 桌面**
> （截图 / 点击 / 浏览器 / 系统操作，不偷焦点；无需 OpenClaw Desktop，也无需专用节点守护进程）。

> 本仓库全部内容来自 2026-08 在 docker `agent-mesh` 网络上**真实跑通并验证**的集成；
> 未验证或猜测的内容一律标注 `⚠️ 请自行验证`。
> 所有凭据均为占位符——仓库中**绝不出现真实 token/密钥**。

---

## 目录

- [1. 架构（文字版）](#1-架构文字版)
- [2. 已验证能力](#2-已验证能力)
- [3. 快速开始](#3-快速开始)
- [4. 配置（.env 字段）](#4-配置env-字段)
- [5. 目录结构](#5-目录结构)
- [6. 集成方式](#6-集成方式)
- [7. Windows 桌面执行（Cua Driver）](#7-windows-桌面执行cua-driver)
- [8. 安全说明](#8-安全说明)
- [9. 常见故障排查](#9-常见故障排查)
- [10. 路线图](#10-路线图)
- [11. 致谢](#11-致谢)
- [维护说明](MAINTENANCE.md)

---

## 1. 架构（文字版）

```
┌────────────────────────────── agent-mesh（docker 网络）─────────────────────────────────┐
│                                                                                           │
│   deepseek-harness (DSH)                        openclaw (OpenClaw)                │
│   ├─ oc-invoke.mjs  ──┐                                                                    │
│   ├─ oc-send.mjs   ───┼── WebSocket(:18789) ─────▶ 网关（设备配对 +                 │
│   ├─ oc-client.mjs ───┘   显式 Origin / Ed25519 签名   JSON-RPC 风格方法）             │
│   │                      配对 / tools.invoke         ├─ agents.list / status             │
│   └─ bridge-daemon.mjs                                ├─ doctor.memory.*（dreaming）     │
│         │                                             └─ message（Discord 收发）           │
│   └─ oc-cua.mjs ─── SSH(:22, ed25519) ──────────────▶ Windows 宿主                   │
│         │                                             └─ Cua Driver（cua-driver serve）  │
│         └── 共享桥挂载：Input/ Output/ DSH-Workspace/ Openclaw-Workspace/                  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

共有三条数据流：

1. **实时通道**：DSH 脚本作为"配对设备"连接 18789 上的 OpenClaw 网关
   （HTTP Upgrade + Origin 白名单 + Ed25519 签名配对 + `connect.challenge` → `hello-ok`），
   再以 JSON-RPC 风格调用网关方法。
2. **异步桥**：任一侧写入任务信封 `Input/T-*.json` → 守护进程监视并执行 → 原子写回
   `Output/<taskId>_result.json`，可选经 `oc-send` 通知 Discord 频道。
3. **Windows 桌面执行（v1.1+）**：DSH 调用 `oc-cua.mjs` → `ssh` 进入 Windows 宿主 →
   执行 `cua-driver call <tool> '<json>'` → 驱动操作真实桌面（截图、点击/键入/热键、
   浏览器 CDP、拉起应用），**全程不偷焦点**。

---

## 2. 已验证能力

> 以下每一项都在真实环境中实际跑通并通过。

- ✅ **网关 WebSocket 握手 + Ed25519 设备配对**：HTTP Upgrade（显式 `Origin`）→
  `connect.challenge`（nonce）→ 对 `v2` 认领串签名 → `connect` → `hello-ok`；
  经控制台批准（operator 角色 + 5 scopes）。`deviceId = hex(SHA-256(Ed25519 公钥))` 恒定，
  一次批准永久有效。**已知坑已修**：认领串与 `device.signedAt` 必须取自同一次 `Date.now()`
  （见 docs/PROTOCOL.md §2.3）。
- ✅ **网关方法调用**：`agents.list`、`status`、`health`、`talk.catalog`、
  `talk.session.create`、`tools.invoke`（消息收发）、`config.schema.lookup` —— 全部通过。
- ✅ **异步桥**：信封 → 守护进程 → 结果，`.tmp → rename` 原子写 + 幂等 `.state`；
  kind 支持 `echo / notify / run-command / write-file / read-file / bridge-status`。
- ✅ **Windows 桌面执行（v1.1，经 Cua Driver）**：从 DSH 容器经 SSH 实测：
  - `cua-driver --version` → 0.21.0
  - `get_screen_size` → 真实宿主分辨率（如 2560×1440）
  - `get_accessibility_tree` → 经 UIA 读到真实桌面进程树
  - 完整工具面：`get_desktop_state`、`browser_navigate/click/type/pointer`、`launch_app`、
    `kill_app`、`click/double_click/right_click/hotkey/type/scroll`、`list_apps`、`list_windows` …

---

## 3. 快速开始

### 3.0 获取项目

```bash
git clone https://github.com/Mikoribbit/odsh-bridge.git
cd odsh-bridge
# 零依赖——无需安装任何东西；`.env` 由 `src/env.mjs` 自动加载
```

### 3.0.1 拉起容器（需要 Docker Desktop / Docker Engine）

```bash
# 1. 从模板生成你的桥目录（四区）
cp -r bridge-template /srv/odsh-bridge          # Docker Desktop/Windows 可用 H:/ODSH-bridge

# 2. 配置
cp .env.example .env                             # 填 OC_TOKEN、DISCORD_CHANNEL_ID 等
export ODSH_BRIDGE_HOST_DIR=/srv/odsh-bridge     # 你的桥目录宿主路径

# 3. 在共享 agent-mesh 网络启动 OpenClaw + DSH
docker compose up -d

# 4.（DSH 镜像）若尚未构建 deepseek-harness：
#    克隆 DeepSeek Harness 官方仓库 → docker build -t deepseek-harness:local .，或在 compose 里换成你的镜像
```
> 没有 Docker Desktop 也能跑桥核心（如 Podman/Buildx）：只需两个容器 + 共享挂载，按你的引擎调整 compose。

### 前置条件（已验证）

- **Docker**（Windows/macOS 用 Docker Desktop；Linux 用 Docker Engine + compose；Podman 带
  compose 兼容参数也能跑桥核心）——ODSH Bridge 本质是"两个容器"的构想：
  OpenClaw（大脑/网关）+ DeepSeek Harness（DSH，执行层）在同一 docker 网络。
  没有 Docker 就跑不了同样的桥；见 §3.0.1 的 compose + `bridge-template` 开箱包。
- 两个容器位于同一 docker 网络（本仓库示例名 `agent-mesh`），名字分别为
  `deepseek-harness` 与 `openclaw`；两者都能 ping 到对方容器名。
- 共享桥在两侧容器挂载到同一绝对路径（默认 `/root/ODSH-bridge`；宿主 `H:/ODSH-bridge`，
  见 `docker-compose.snippet.yml`）。
- OpenClaw 网关侧需要放行（见 `docs/PROTOCOL.md` §2.1）：
  - `gateway.controlUi.allowedOrigins` 显式包含你要用的 Origin（如 `http://openclaw:18789`）；
    ⚠️ 这是受保护配置——直接编辑 `openclaw.json`（先备份）并重启网关生效。
  - ⚠️ 安全：保持 `autoApproveCidrs` **不设置**。自动批准整个 docker 子网意味着该子网上任何容器
    都可能配对成 operator 设备；每个设备请手动批准一次。
  - 在不信任网络下，请在网关前终止 TLS（wss）（或把它放到只有你的两个容器加入的隔离 docker 网络）。
    无 TLS 时网关凭据和签名连接串会以明文在网络上传送——仅在可信桥上可接受。

### 部署步骤（桥核心，3 步 + 1 次批准）

```bash
# 1. 配置环境（DSH 容器内，仓库根目录）
cp .env.example .env
#   编辑 .env：OC_TOKEN=<openclaw.json → gateway.auth.token 的值>；按需填 DISCORD 等

# 2. 配对 + 连接测试
node src/oc-client.mjs connect
#   首次运行会打印 "device not approved"；在 OpenClaw 控制台批准该 deviceId

# 3a. 部署守护进程
node src/bridge-daemon.mjs --notify --interval-ms 5000
# 3b. 或手动调用网关
#   node src/oc-invoke.mjs agents.list '{}'
#   node src/oc-send.mjs "你好" --channel <id>

# 4. 安装 OpenClaw 侧 skill（让 OpenClaw 知道如何协作）
#    在 OpenClaw 容器内：
mkdir -p /root/.openclaw/skills/odsh-interop
cp skills/odsh-interop/SKILL.md /root/.openclaw/skills/odsh-interop/SKILL.md
```

### 启用 Windows 桌面执行（v1.1，可选）

> 完整指引：`docs/CUA-EXECUTION.md`。**最快路径——两个幂等的一键脚本：**
>
> ```powershell
> # Windows 宿主（管理员 PowerShell）
> .\scripts\setup-windows.ps1 -BridgePath C:\ODSH-bridge
> ```
> ```bash
> # DSH 容器
> ./scripts/setup-dsh.sh --bridge /root/ODSH-bridge --host host.docker.internal
> ```
> 每个脚本自动检测已完成步骤并跳过；它们互相写入 `windows-connect.json` / `.env`，
> DSH 侧脚本最后会做一次真实的 `get_screen_size` 验证。以下手动步骤供参考/排查：

```powershell
# A. Windows 宿主侧
irm https://cua.ai/driver/install.ps1 | iex            # 安装 Cua Driver
#   设置 → 可选功能 → 安装 "OpenSSH 服务器"（GUI 安装可避开 CBS 报错）
Start-Service sshd; Set-Service sshd -StartupType Automatic
#   若 Start-Service 失败但 `sshd -d` 正常，用计划任务兜底：
schtasks /create /tn "sshd-keepalive" /tr "C:\Windows\System32\OpenSSH\sshd.exe" /sc onlogon /ru SYSTEM /rl HIGHEST /f
Start-Process -WindowStyle Hidden C:\Windows\System32\OpenSSH\sshd.exe
#   把 DSH 公钥写入（Administrators 用户必须放这）：
#   C:/ProgramData/ssh/administrators_authorized_keys
```

```bash
# B. DSH 容器侧
apt-get install -y openssh-client
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519 -C "dsh-bridge-cua"
cat /root/.ssh/id_ed25519.pub   # → 粘贴到上面的 Windows 文件

# 验证
ssh -i /root/.ssh/id_ed25519 <windows-用户名>@host.docker.internal whoami
node src/oc-cua.mjs get_screen_size
```

> 桥核心不依赖此可选步骤；只有需要真实桌面控制时才启用 Cua 通道。

---

## 4. 配置（.env 字段）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OC_HOST` | `openclaw` | 网关容器名（用 DNS 不要用 IP） |
| `OC_PORT` | `18789` | 网关端口 |
| `OC_TOKEN` | （必填） | `openclaw.json → gateway.auth.token` 的值；**占位 REPLACE_WITH_GATEWAY_TOKEN** |
| `OC_ORIGIN` | `http://<host>:<port>` | 动态生成；须被网关 allowedOrigins 放行 |
| `OC_KEYS` | `<BRIDGE_PATH>/DSH-Workspace/openclaw-device.json` | 设备身份 JWK（自动生成/复用） |
| `BRIDGE_PATH` | `/root/ODSH-bridge` | 桥根路径 |
| `DISCORD_CHANNEL_ID` | （空） | 通知/发送目标频道 |
| `OC_RETRY_MS` | `8000` | oc-client 配对等待/重连间隔 |
| `OC_CONNECT_TIMEOUT_MS` | `45000` | 连接（握手+配对）超时 |
| `OC_REPLY_TIMEOUT_MS` | `20000` | 单次请求超时 |
| `BRIDGE_INTERVAL_MS` | `5000` | 守护进程扫描间隔 |
| `BRIDGE_RUN_TIMEOUT_MS` | `15000` | `run-command` 超时 |
| `BRIDGE_ALLOW_ABS_PATHS` | `false` | 是否允许读写文件使用绝对路径（安全默认 false） |
| `OC_SEND_SCRIPT` | `src/oc-send.mjs` | 通知用发送脚本路径 |
| `CUA_SSH_USER` | （必填，无默认） | Cua 通道的 Windows 用户名 |
| `CUA_SSH_HOST` | `host.docker.internal` | 容器可达的 Windows 宿主 |
| `CUA_SSH_PORT` | `22` | Windows SSH 端口 |
| `CUA_SSH_KEY` | `/root/.ssh/id_ed25519` | SSH 私钥 |
| `CUA_BIN` | `C:/Users/<user>/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe` | Windows 端 cua-driver 完整路径 |
| `CUA_TIMEOUT_MS` | `60000` | 单次调用超时 |

---

## 5. 目录结构

```
plugin-release/
├── README.md                  本说明（中）＝README.zh.md（EN 见 README.md）
├── AUTHORS.md                 维护者 / 贡献者
├── CHANGELOG.md               版本历史（Keep a Changelog）
├── MAINTENANCE.md             已验证的故障排查笔记
├── docs/
│   ├── PROTOCOL.md            网关握手/帧/方法/错误/幂等
│   ├── BRIDGE-SPEC.md         桥四区/信封 schema/状态机/原子写
│   └── CUA-EXECUTION.md       Windows 桌面执行（安装/授权/使用）
├── skills/
│   └── odsh-interop/          OpenClaw 侧 skill（SKILL.md + 安装 README）
├── src/
│   ├── env.mjs                .env 加载器
│   ├── gateway-client.mjs     共享 WS/Ed25519 配对客户端
│   ├── oc-invoke.mjs          调用任意网关方法
│   ├── oc-send.mjs            经网关发消息
│   ├── oc-client.mjs          配对等待 / 长连客户端
│   ├── oc-cua.mjs             （v1.1）SSH + Cua Driver 桌面执行
│   ├── bridge-daemon.mjs      信封监视/执行器
│   └── bridge-cleanup.mjs     留存清理工具
├── scripts/                   一键幂等部署
│   ├── setup-windows.ps1      Windows 宿主：Cua Driver + OpenSSH + 防火墙 + 公钥 + 连接信息
│   └── setup-dsh.sh           DSH 容器：ssh 客户端 + 密钥 + .env + 验证 get_screen_size
├── config/                    Cordis 插件形态（⚠️ 可选，未经产品验证）
├── docker-compose.yml         可运行的 compose 模板（OpenClaw 官方镜像 + DSH 构建/自定义镜像）
├── bridge-template/           可直接复制的目录桥：Input/ Output/ DSH-Workspace/ Openclaw-Workspace/
├── .env.example               环境变量模板（全占位）
└── LICENSE  ·  package.json  ·  docker-compose.snippet.yml（旧片段）
```

---

## 6. 集成方式

### A. 独立 CLI / 守护进程（推荐，已验证形态）

- 零构建、零 npm 依赖，直接 `node src/xxx.mjs` 运行；`.env` 由 `src/env.mjs` 自动加载。
- 连接统一经 `safeClose()`（`gateway-client.mjs`）：新版 `node:net` ESM Socket 只有
  `destroy()/resetAndDestroy()`、没有 `.close()`；见 `gateway-client.mjs` 内注释。
- 守护进程长驻：`node src/bridge-daemon.mjs --notify --interval-ms 5000`（可用 systemd/supervisor 托管）。

### B. 挂载进 DSH 作为 Cordis 插件（⚠️ 未经产品环境验证）

- `config/odsh-bridge.ts`：`export function apply(ctx, config)` 形态，在 `ctx.effect()` 内
  spawn `bridge-daemon.mjs`，卸载/热重载时 SIGTERM 回收（与官方 Cordis 教程一致）。
  `config/cordis.yml` 是 `insert:` 合并片段。
- ⚠️ 该挂载路径未经产品环境验证——先跑通 A，再切换。

---

## 7. Windows 桌面执行（Cua Driver）

完整指引见 **`docs/CUA-EXECUTION.md`**。摘要：

- **为什么**：给 DSH 执行层在 Windows 宿主上提供真实、不抢焦点的桌面控制——
  截图、点击/键入、浏览器自动化（CDP）、拉起应用；无需 OpenClaw Desktop，也无需专用节点进程。
- **怎么跑**：`src/oc-cua.mjs` 执行 `ssh -i <key> <user>@<host> "cua-driver call <tool> '<json>'"`。
- **安全姿态**：SSH 仅密钥（`BatchMode=yes`），Windows 侧只放行 DSH 容器的公钥；
  驱动操作真实桌面但**不偷焦点**。

---

## 8. 安全说明

1. **绝不入库 token**：`OC_TOKEN` 只在 `.env`（已 gitignore）；仓库 `.env.example` 全是占位符。
2. **设备配对**：`deviceId` 是设备指纹（Ed25519 公钥的哈希）；批准即授予 operator 级权限——
   确保网络隔离，不要随意批准陌生设备。
3. **Origin 白名单**：开太宽会降低安全性；生产只放行你实际使用的 Origin；改白名单需重启网关。
4. **私钥权限**：JWK 文件以 `0600` 创建并存在 DSH-Workspace（另一容器不得修改）。
5. **run-command**：守护进程的 `run-command` 可执行 shell（逐字检查：首词不得以 `;`、`&`、`|`、
   反引号开头）——仅信任信封来源；生产建议加 requester 白名单（见 BRIDGE-SPEC §8）。
6. **Cua 通道**：SSH 密钥限定 DSH 身份；`CUA_SSH_*` 放受控环境变量（绝不入库）；
   宿主或容器失陷时立即吊销密钥。

---

## 9. 常见故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| `spawn <script> ENOENT` | 经 DSH 工具执行通道启动时命令/环境缺失 | 用长连会话（`oc-client connect`）+ 手动 shell 启动守护进程；给出完整 node 路径（`which node`）。⚠️ 请验证你的 DSH runner 配置。 |
| `ECONNREFUSED / ENOTFOUND` | 网关不可达 | 确认两容器在同一 docker 网络、容器名正确（`docker exec openclaw getent hosts openclaw`） |
| `handshake rejected / non-101` | Origin 未放行 | 把所用 Origin 加入 `gateway.controlUi.allowedOrigins` 并重启网关（先备份 openclaw.json） |
| 容器 IP 变化后断连 | 硬编码了 IP | 全用容器名 DNS（默认 `OC_HOST=openclaw`） |
| `device signature invalid`（偶发） | **已确认真因**：认领串时间戳与 `device.signedAt` 用了两次 `Date.now()` → 毫秒不一致 | 二者共用同一个 `const signedAt = Date.now()`（见 `gateway-client.mjs`） |
| `PAIRING_REQUIRED` | 设备未批准 | 在控制台批准对应 deviceId |
| 守护进程不处理信封 | 已处理过（`.state`）/ 文件名非 `T-*.json` | 清 `.state` 或换新 taskId |
| Cua：22 端口 `Connection refused` | sshd 未运行（服务管理器启动失败） | 用 `sshd.exe -d` 调试确认；若能跑，用计划任务兜底（见 docs/CUA-EXECUTION.md §1.2） |
| Cua：`Permission denied (publickey)` | 公钥未在 `administrators_authorized_keys`（Administrators 用户） | 把 DSH 公钥放进去并 `icacls ... Administrators:F`；见 §1.4 |
| Cua：`cua-driver: not recognized` / 路径不对 | PATH / 安装位置不同 | 把 `CUA_BIN` 设为 `cua-driver.exe` 的真实完整路径 |

---

## 10. 路线图

- **F-2（完成）** `message` 工具读取方向已验证：`{action:"read",channel:"discord",to:"channel:<id>"}`。
- **F-3（完成）** 网关防重放 / signature invalid 根因已修（单一 `signedAt`）。
- **F-4** 守护进程 `requester` 白名单（生产加固）⚠️。
- **F-5** 持久订阅网关事件（`caps:["tool-events"]`）⚠️。
- **F-6** Cua 通道加固：能力清单（`--permission-mode bounded`）+ 按应用白名单 ⚠️。
- **F-7** 信封 `target: windows-node` 保留但不再使用；Cua 通道是受支持的桌面路径。

---

## 11. 致谢

- **Cua** — 本项目的 Windows 桌面执行层由
  [Cua Driver](https://github.com/trycua/cua)（trycua 团队）提供支持。感谢他们开源了一个
  跨平台、不抢焦点的 computer-use 驱动，让 agent 可以在不抢走用户鼠标的情况下操作桌面应用。
  Cua Driver 由其作者独立许可——详见其仓库。

---

> 维护：ODSH Bridge contributors · 许可证：MIT · Node >= 18 · 零依赖 ESM
