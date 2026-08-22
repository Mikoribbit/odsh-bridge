# Cua Execution — Windows 桌面执行通道（1.1）

> ODSH Bridge 1.1 的核心能力：让容器里的 **DeepSeek Harness（DSH）执行层**，通过
> **SSH + [Cua Driver](https://github.com/trycua/cua)（trycua/cua, v0.21+）**，直接操作
> **Windows 宿主机的真实桌面**——截图、点击、键盘、浏览器、系统命令，且**不偷焦点**。
>
> 本通道取代了早期版本的 "OpenClaw Windows Node" 路径：更轻（无 Desktop、无常驻 node 服务），
> DSH 自身即执行层，OpenClaw 只负责大脑/路由（见 README 架构图）。

---

## 架构

```
DSH (容器) ──SSH(22, ed25519 免密)──► Windows 宿主
                                        └─► cua-driver serve（后台常驻，本地权限）
                                              └─► Windows 桌面（UIA/截图/CDP 浏览器）
```

- **SSH**：容器 → Windows 的命令通道（OpenSSH Server，公钥免密）
- **Cua Driver**：Windows 侧的"手和眼"——真实桌面工具（`get_desktop_state`、
  `browser_navigate`、`click`、`launch_app` 等），后台执行不抢焦点
- **DSH 侧封装**：`src/oc-cua.mjs` 把 "调用 cua 工具" 翻译成一条 SSH 远程命令

---

## 0. 一键部署（推荐，替代手动步骤）

仓库提供两个幂等脚本，对着跑一遍即完成环境（可重复运行，已完成的步骤自动跳过）：

### 0.1 Windows 宿主侧（管理员 PowerShell）

```powershell
# 自动：安装/定位 Cua Driver、开 OpenSSH（含服务管理器失败的计划任务兜底）、
#      防火墙 22、把 DSH 公钥放进正确位置、确保 cua-driver serve 在跑、
#      并把连接信息写入桥（windows-connect.json）
.\scripts\setup-windows.ps1 -BridgePath C:\ODSH-bridge
# 若没找到 DSH 公钥（还没跑 DSH 侧脚本），会提示，可先跑 0.2 再重跑本脚本
```

### 0.2 DSH 容器侧（bash）

```bash
# 自动：装 ssh 客户端、生成 ed25519 密钥（幂等）、发布公钥到桥、
#      读桥里 windows-connect.json 的 CUA_BIN/用户名、写 .env CUA_*、
#      测试 SSH、最后直接验证 get_screen_size
./scripts/setup-dsh.sh --bridge /root/ODSH-bridge --host host.docker.internal
# 若 Windows 侧还没生成 windows-connect.json，可先手动传 --user <your-windows-username>，
# 之后 Windows 侧跑完 0.1 再重跑本脚本即可自动补齐真实 CUA_BIN
```

> 两个脚本按任意顺序都可用；推荐先 Windows(0.1) 再 DSH(0.2)，或先 DSH 出公钥、
> 再 Windows 放公钥并写连接信息、再重跑 DSH 完成验证。完成后：
>
> ```bash
> node src/oc-cua.mjs get_screen_size   # 应返回您的真实分辨率
> ```

---

## 1. Windows 宿主侧（一次性配置·手动版）

### 1.1 安装 Cua Driver

```powershell
# PowerShell（免管理员、官方脚本）
irm https://cua.ai/driver/install.ps1 | iex
# 验证
cua-driver --version        # ≥ 0.21.0
```

安装后默认会注册 auto-start（登录即 `cua-driver serve`）。若没有，手动：
```powershell
cua-driver serve   # 后台常驻
```

### 1.2 开启 OpenSSH Server

**GUI 方式（推荐，比命令行稳）**：
```powershell
# 设置 → 系统 → 可选功能 → 添加功能 → 搜 "OpenSSH 服务器" → 安装
# 然后：
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

> ⚠️ 若 `Start-Service sshd` 报错（服务管理器启动失败但 `sshd -d` 正常）：
> 这是 Windows OpenSSH 服务的一个已知环境怪癖，用计划任务兜底即可：
> ```powershell
> schtasks /create /tn "sshd-keepalive" /tr "C:\Windows\System32\OpenSSH\sshd.exe" /sc onlogon /ru SYSTEM /rl HIGHEST /f
> Start-Process -WindowStyle Hidden C:\Windows\System32\OpenSSH\sshd.exe
> ```

### 1.3 防火墙

```powershell
New-NetFirewallRule -Name sshd -DisplayName 'sshd' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

### 1.4 放行容器公钥

> ⚠️ **若你的 Windows 用户属于 Administrators 组**，OpenSSH 会忽略
> `~/.ssh/authorized_keys`，只认 `C:\ProgramData\ssh\administrators_authorized_keys`。

```powershell
# 从 DSH 容器复制公钥到桥，比如 /root/ODSH-bridge/DSH-Workspace/dsh_ssh_pubkey.pub
# 然后（管理员）：
$pub = Get-Content "C:\ODSH-bridge\DSH-Workspace\dsh_ssh_pubkey.pub" -Raw
Add-Content -Path "C:\ProgramData\ssh\administrators_authorized_keys" -Value $pub.Trim()
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

---

## 2. DSH 容器侧（一次性配置）

```bash
# 1. SSH 客户端
apt-get update && apt-get install -y openssh-client

# 2. 密钥
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519 -C "dsh-bridge-cua"
cat /root/.ssh/id_ed25519.pub   # ← 复制给 Windows 侧 §1.4

# 3. 连通性自检
ssh -i /root/.ssh/id_ed25519 <windows-username>@host.docker.internal "whoami"
#   应输出你的 Windows 用户名（如 your-pc-name\\your-username）
```

---

## 3. 使用

### 3.1 命令行（手册 `src/oc-cua.mjs`）

```bash
# 读屏幕信息
node src/oc-cua.mjs get_screen_size

# 全屏截图（返回 base64 或保存路径，取决于响应）
node src/oc-cua.mjs get_desktop_state

# 列窗口 / 进程
node src/oc-cua.mjs get_accessibility_tree
node src/oc-cua.mjs list_windows

# 浏览器
node src/oc-cua.mjs browser_navigate '{"url":"https://example.com"}'
node src/oc-cua.mjs browser_snapshot '{}'

# 点击 / 键入 / 热键
node src/oc-cua.mjs click '{"pid":1234,"x":100,"y":200}'
node src/oc-cua.mjs type '{"pid":1234,"text":"hello"}'
node src/oc-cua.mjs hotkey '{"pid":1234,"keys":"ctrl+s"}'

# 应用
node src/oc-cua.mjs launch_app '{"name":"notepad"}'
node src/oc-cua.mjs kill_app '{"pid":1234}'
```

> 所有工具名呼见 `node src/oc-cua.mjs list-tools`（cua-driver 的 `list-tools` 子命令）。

### 3.2 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CUA_SSH_USER` | （必填，无默认） | Windows 用户名 |
| `CUA_SSH_HOST` | `host.docker.internal` | Windows 宿主（容器内可达宿主回环） |
| `CUA_SSH_PORT` | `22` | SSH 端口 |
| `CUA_SSH_KEY` | `/root/.ssh/id_ed25519` | SSH 私钥 |
| `CUA_BIN` | `C:/Users/<user>/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe` | Windows 端 cua-driver 路径 |
| `CUA_TIMEOUT_MS` | `60000` | 单次调用超时 |

---

## 4. 验证清单（写自动化测试脚本时可复用）

| 检查 | 命令 | 期望 |
|---|---|---|
| SSH 通 | `ssh -i <key> <windows-username>@host.docker.internal whoami` | 返回 Windows 用户名 |
| cua 可用 | `node src/oc-cua.mjs --version` | ≥ 0.21.0 |
| 屏幕读 | `node src/oc-cua.mjs get_screen_size` | `{"width":..., "height":...}` |
| 桌面访问 | `node src/oc-cua.mjs get_accessibility_tree` | 列出真实进程/窗口 |
| 浏览器 | `node src/oc-cua.mjs browser_navigate '{...}'` | `ok:true` |

---

## 5. 安全与许可

- **Cua Driver** 属于 [trycua/cua](https://github.com/trycua/cua)（开源，multi-license）。
  ODSH Bridge 仅作为其一个远程调用封装；上手指引、安装与权限均由 Cua 官方提供。
- SSH 免密只允许**这台 DSH 容器**（固定 host/key）访问；`BatchMode=yes` 禁止交互式密码，
  降低被暴力破解面。
- cua-driver 后台模式**不偷焦点**（`launch_app` 使用 SW_SHOWNOACTIVATE），桌面不被抢占。
- 生产部署建议：把 `CUA_SSH_*` 放进受控环境变量（勿入库）；Windows 侧公钥仅授权你信任的容器。
