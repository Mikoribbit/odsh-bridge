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

---

## 3. 部署（几分钟搞定）

前置：**Docker** + 两张镜像——OpenClaw（官方 `openclaw/openclaw:latest`）与 DSH
（无公开镜像；从 [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness) 自建 `deepseek-harness:local`）。

```bash
# 1. 克隆，然后用交互式向导生成桥目录
git clone https://github.com/Mikoribbit/odsh-bridge.git && cd odsh-bridge
chmod +x scripts/new-bridge.sh
./scripts/new-bridge.sh            # 可视化提示；回车保留默认

# 2. 拉起 OpenClaw + DSH（DSH 内自动启动桥守护进程）
docker compose up -d              # 使用生成的 docker-compose.yaml

# 3. 配对一次，之后即开即用
node src/oc-client.mjs connect    # 在 OpenClaw 控制台批准 deviceId

# （可选）验证守护健康 + 一趟往返
node src/dshtrigger.mjs status
node src/dshtrigger.mjs send --kind echo --text "hello"
```

完整逐步、配置与可选 Windows 桌面（Cua）：**docs/QUICKSTART.md**。

## 文档（已拆分）

为了缩短本页，深挖内容移到了独立页面：

| 页面 | 覆盖 |
|------|------|
| [**快速开始**](docs/QUICKSTART.zh.md) | 获取项目 / 拉起容器 / 部署守护 / 可选 Cua |
| [**配置**](docs/CONFIGURATION.zh.md) | .env 字段 + 目录结构 |
| [**集成方式**](docs/INTEGRATIONS.zh.md) | 独立守护 vs Cordis 插件 |
| [**运维**](docs/OPERATIONS.zh.md) | Cua Windows 桌面、安全、故障排查 |
| [**路线图**](ROADMAP.md) | 分阶段长期计划（ClawHub / 插件生态 / 事件总线）|
| [**协议**](docs/PROTOCOL.md) | 网关握手 / JSON-RPC 细节 |
| [**桥规范**](docs/BRIDGE-SPEC.md) | 信封格式 / 状态机 / 分区 |
| [**维护笔记**](MAINTENANCE.md) | 客观记录的问题与修复 |

---

## 支持

如果你觉得这个项目有帮助，可以考虑支持维护者：

<a href="https://www.buymeacoffee.com/mikoribbit" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-orange.png" alt="Buy Me A Coffee" height="45" width="auto"></a>

> ☕ [buymeacoffee.com/mikoribbit](https://www.buymeacoffee.com/mikoribbit)

---

## 致谢

- **Cua** — 本项目的 Windows 桌面执行层由
  [Cua Driver](https://github.com/trycua/cua)（trycua 团队）提供支持。感谢他们开源了一个跨平台、不抢焦点的
  computer-use 驱动，让 agent 可以在不抢走用户鼠标的情况下操作桌面应用。
  Cua Driver 由其作者独立许可——详见其仓库。

---

> 维护：ODSH Bridge contributors · 许可证：MIT · 核心 Node >= 18 · SQLite 审计存储需 Node >=22.5 · 零依赖 ESM
