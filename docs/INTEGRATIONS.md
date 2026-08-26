# Integration Approaches

## 6. Integration approaches

### A. Standalone CLI / daemon (recommended, verified form)

- Zero build, zero npm dependencies, run `node src/xxx.mjs` directly; `.env` is auto-loaded by `src/env.mjs`.
- Connections always close through `safeClose()` (`gateway-client.mjs`): the newer `node:net` ESM Socket
  has only `destroy()/resetAndDestroy()`, no `.close()`; see comments in `gateway-client.mjs`.
- Daemon runs as a long-lived process: `node src/bridge-daemon.mjs --notify --interval-ms 5000`
  (manage with systemd/supervisor).

### B. Mounted into DSH as a Cordis plugin (⚠️ not tested in the product environment)

- `config/odsh-bridge.ts`: `export function apply(ctx, config)` shape, spawns `bridge-daemon.mjs`
  inside `ctx.effect()`, reclaiming with SIGTERM on unload/hot-reload (consistent with the official Cordis
  tutorial). `config/cordis.yml` is an `insert:` merge snippet.
- ⚠️ this mount path was not tested in the product environment — get method A working first, then switch.

---

