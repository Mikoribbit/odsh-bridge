# 贡献指南（CONTRIBUTING）

## 本地复现（最小环境）

- 需要：Node.js >= 18（无需 npm 依赖，纯 ESM `.mjs`）。
- 方案 A（完整）：按 `docker-compose.snippet.yml` 起 agent-mesh 网络 + 两个容器 → 共享桥挂载 →
  `cp .env.example .env` 填写 → `node src/oc-client.mjs connect`（Control UI 批准后自动连上）→
  `node src/bridge-daemon.mjs --notify`。
- 方案 B（可离线）：只用桥，不连网关。把 `BRIDGE_PATH` 指向一个空目录，
  手工投信封后用 `--once` 验证：

```bash
mkdir -p /tmp/bridge-dev/Input /tmp/bridge-dev/Output
cat > /tmp/bridge-dev/Input/T-dev-01.json <<'EOF'
{"schema":"odsh-envelope/v1","taskId":"T-dev-01","type":"execute","status":"queued",
 "requester":"dsh","target":"dsh","createdMs":1787249900000,
 "payload":{"kind":"echo","text":"dev smoke"},"result":null}
EOF
BRIDGE_PATH=/tmp/bridge-dev node src/bridge-daemon.mjs --once
cat /tmp/bridge-dev/Output/T-dev-01_result.json   # 期待 status: done
```

## 新增 payload.kind（四步）

1. 在 `src/bridge-daemon.mjs` 的 `executePayload()` switch 加一个 case（返回可 JSON 序列化对象）。
2. 在 `docs/BRIDGE-SPEC.md` §6 表格加一行。
3. 按上面方案 B 写一条对应信封冒烟验证（含失败分支）。
4. 运行 `node --check src/bridge-daemon.mjs` 与 `npm run check`。

## 关于协议实现

- 握手/签名/帧格式改动请同步 `docs/PROTOCOL.md` 与 `src/gateway-client.mjs`；
- 不要在代码里写死 token/密钥/频道 id：一律从环境变量取，样例写 `.env.example` 占位；
- 未在真实网关验证过的分支（如 ping/pong、read 动作、expiresMs 过期）必须保留注释里的
  `⚠️ 需自行验证` 标注，README 特性清单只列已验证项。

## 测试与提交

- 最小冒烟：`npm run check`（全部脚本语法）+ 方案 B 的信封跑通 + 一次身份持久化验证
  （两次 `loadIdentity` 得到相同 deviceId）。
- 提交信息用简洁英文或中文均可；一行概括 + 必要正文。