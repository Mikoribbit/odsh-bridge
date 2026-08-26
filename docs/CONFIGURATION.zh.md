# 配置与目录结构

## 配置（.env 字段）

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

## 目录结构

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

