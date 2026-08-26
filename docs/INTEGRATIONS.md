# Integration Approaches

## 1. Standalone CLI / daemon (recommended, verified form)

- Zero build, zero npm dependencies, run `node src/xxx.mjs` directly; `.env` is auto-loaded by `src/env.mjs`.
- **Self-starting daemon (v1.2+)**: the DSH container boots the bridge daemon automatically via
  `scripts/dsh-entrypoint.sh` → `src/dshtrigger.mjs daemon` (a self-healing supervisor that restarts a
  crashed child). No manual `node` invocation is required on a normal boot.
- One tool manages everything: `node src/dshtrigger.mjs 
  daemon | send | status | once |`. `status` also reports live daemon health.
- The underlying watcher is `src/bridge-daemon.mjs` (the same envelope executor) — you can still run it
  directly as `node src/bridge-daemon.mjs --notify --interval-ms 5000` if you manage it yourself.

### B. Mounted into DSH as a Cordis plugin (⚠️ not tested in the product environment)

- `config/odsh-bridge.ts`: `export function apply(ctx, config)` shape, spawns `bridge-daemon.mjs`
  inside `ctx.effect()`, reclaiming with SIGTERM on unload/hot-reload (consistent with the official Cordis
  tutorial). `config/cordis.yml` is an `insert:` merge snippet.
- ⚠️ this mount path was not tested in the product environment — get method A working first, then switch.

---

