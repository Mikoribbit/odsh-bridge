# 集成方式

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

