# 快速开始

> ⚠️ **自启守护进程（v1.2+）**：DSH 容器启动时自动拉起桥守护进程
>（`scripts/dsh-entrypoint.sh` → `src/dshtrigger.mjs daemon`）。OpenClaw 随时把 `T-*.json`
> 信封投进 `Input/` 即被执行——无需任何手动步骤，且守护进程自愈（崩溃自动重启）。

## 1. 前置条件

- **Docker**（Windows/macOS 用 Docker Desktop；Linux 用 Docker Engine + compose；Podman 带
  compose 兼容参数也能跑桥核心）——ODSH Bridge 本质是「两个容器」：
  OpenClaw（大脑/网关）+ DeepSeek Harness（DSH，执行层）在同一 docker 网络。
- **两张镜像**：
  - OpenClaw——官方 `openclaw/openclaw:latest`（Docker Hub）。
  - DSH——**无公开镜像**，从官方仓库自建：
    ```bash
    git clone https://github.com/deepseek-ai/deepseek-harness.git dsh-src && cd dsh-src
    docker build -t deepseek-harness:local .
    ```
- 两个容器位于同一 docker 网络（本仓库示例名 `agent-mesh`），彼此能用容器名互通。
- OpenClaw 网关 allowed origins 需包含你使用的 origin（见 `docs/PROTOCOL.md` §2.1）。

## 2. 生成桥目录——交互式向导（推荐）

一条命令以可视化提示引导你填写每一项；**直接回车保留方括号内的默认值**，键入则覆盖，
y/n 回答可选项。

```bash
cd odsh-bridge
chmod +x scripts/new-bridge.sh
./scripts/new-bridge.sh          # 交互式向导
```

按顺序会依次询问：

| 提示 | 默认值 | 说明 |
|---|---|---|
| 桥宿主目录 | `C:/ODSH-bridge` | 四个分区文件夹在宿主上的位置 |
| 容器挂载路径 | `/root/ODSH-bridge` | 两侧容器内统一的路径 |
| OpenClaw 服务名 | `openclaw` | 容器/服务名 |
| DSH 服务名 | `deepseek-harness` | 容器/服务名 |
| 网关端口 | `18789` | OpenClaw 网关端口 |
| OC_TOKEN | 占位符 | 粘贴 `openclaw.json → gateway.auth.token` 的值 |
| Discord 频道 ID | *（无）* | 完成通知用（可选） |
| 生成 docker-compose.yaml？ | `y` | 在桥目录写入可运行的 compose |
| 启用 Cua 桌面通道？ | `n` | 可选 Windows 桌面执行（见 §5） |
| Windows SSH 用户名 | `whoami` | 仅启用 Cua 时需要 |

向导会复制四个分区（`Input/ Output/ DSH-Workspace/ Openclaw-Workspace/`）、写入 `.env`
（`BRIDGE_PATH` 自动指向你的挂载路径），并按需生成 `docker-compose.yaml`（挂载 `<宿主目录>` → `<挂载点>`）。

> **非交互一键式** 仍可用（结果相同，无提示）：
> ```bash
> ./scripts/new-bridge.sh /srv/odsh-bridge --no-compose
> ```

## 3. 拉起容器

```bash
docker compose up -d          # 用生成的 docker-compose.yaml（或仓库自带那个）
```

- **DSH 容器通过入口脚本自动拉起桥守护进程**（自启，无需手动）。
- 验证它活着：
```bash
node src/dshtrigger.mjs status        # 显示 health: { running: true, pid: … }
```

## 4. 配对一次 + 验证

```bash
# DSH 容器内，仓库根目录
node src/oc-client.mjs connect
#   首次运行打印 "device not approved" → 在 OpenClaw 控制台批准该 deviceId。
```

然后端到端确认：

```bash
node src/dshtrigger.mjs send --kind echo --text "hello"     # 投信封、取结果
```

## 5. 可选——Windows 桌面执行（Cua Driver）

> 完整指南：`docs/CUA-EXECUTION.md`。最快路径——两个幂等的一键脚本：

```powershell
.\scripts\setup-windows.ps1 -BridgePath C:\ODSH-bridge
```
```bash
./scripts/setup-dsh.sh --bridge /root/ODSH-bridge --host host.docker.internal
```

每个脚本会检测已完成部分并跳过；互写 `windows-connect.json` / `.env`，DSH 侧以实弹
`get_screen_size` 验证收尾。

## 6. 下一步

- **配置 / `.env` 字段 / 目录**：`docs/CONFIGURATION.md`
- **独立 vs Cordis 插件**：`docs/INTEGRATIONS.md`
- **真实运维 / 安全 / 故障排查**：`docs/OPERATIONS.md`
