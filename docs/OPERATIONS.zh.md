# 运维：Cua 桌面、安全、故障排查

## 7. Windows 桌面执行（Cua Driver）

完整指引见 **`CUA-EXECUTION.md`**。摘要：

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
| Cua：22 端口 `Connection refused` | sshd 未运行（服务管理器启动失败） | 用 `sshd.exe -d` 调试确认；若能跑，用计划任务兜底（见 CUA-EXECUTION.md §1.2） |
| Cua：`Permission denied (publickey)` | 公钥未在 `administrators_authorized_keys`（Administrators 用户） | 把 DSH 公钥放进去并 `icacls ... Administrators:F`；见 §1.4 |
| Cua：`cua-driver: not recognized` / 路径不对 | PATH / 安装位置不同 | 把 `CUA_BIN` 设为 `cua-driver.exe` 的真实完整路径 |

---

