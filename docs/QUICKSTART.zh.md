# 快速开始

## 3. 快速开始

> ⚠️ **自启守护进程（v1.2+）**：DSH 容器启动时自动拉起桥守护进程
>（`scripts/dsh-entrypoint.sh` → `src/dshtrigger.mjs daemon`）。OpenClaw 随时把
> `T-*.json` 信封投进 `Input/` 即被执行——无需任何手动步骤，且守护进程自愈（崩溃自动重启）。

### 3.0 获取项目

```bash
git clone https://github.com/Mikoribbit/odsh-bridge.git
cd odsh-bridge
# 零依赖——无需安装任何东西；`.env` 由 `src/env.mjs` 自动加载
```

### 3.0.1 拉起容器（需要 Docker Desktop / Docker Engine）

```bash
# 1. 从模板生成你的桥目录（四区）
cp -r bridge-template /srv/odsh-bridge          # （Windows 示例：C:/ODSH-bridge，任意目录均可）

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
- 共享桥在两侧容器挂载到同一绝对路径（容器内 `/root/ODSH-bridge`；宿主路径由你定，
  见 `docker-compose.snippet.yml`）。
- OpenClaw 网关侧需要放行（见 `PROTOCOL.md` §2.1）：
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

> 完整指引：`CUA-EXECUTION.md`。**最快路径——两个幂等的一键脚本：**
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

