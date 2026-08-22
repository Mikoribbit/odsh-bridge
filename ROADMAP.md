# Long-Term Plan (Roadmap)

> Strategic, forward-looking items that go beyond the current release train.
> Tactical "F-item" work is tracked separately in README §10 — this document is the
> phase-gated **product/ecosystem** roadmap. Items are intentionally sequenced so each
> phase depends on the one before it, and nothing here ships without its own security
> review (the project's default is **fail-closed**.

---

## Phase 0 — Distribution hygiene (near-term, enabled today)

Baseline: get the two existing artifact "storefronts" into a clean, publishable state
before chasing new features.

### 0.1 ClawHub skill publishing — odsh-interop
- **Status**: skill exists at `skills/odsh-interop/SKILL.md`, already versioned `version: 2`.
- **Why**: this is the project's public "brain-side" face; getting it on ClawHub is high
  value, low cost, and fully in scope today.
- **Depends on**: nothing external. The operator has OpenClaw on Windows and can run
  `openclaw skills publish`.
- **Work**:
  - Complete the **mandatory frontmatter** fields required by ClawHub (author email,
    license, tags/categories, maintainers) — current frontmatter only has name/description/version.
  - Dry-run `openclaw skills publish --dry-run` first, then publish, then re-pull to
    verify the published artifact matches.
  - Keep examples/call-sites in sync with `docs/CUA-EXECUTION.md` and the current routing rules.
- **Done when**: skill is listed/verifiable on ClawHub and a "quick link" to it exists in README §Credits or Tools.

---

## Phase 1 — Plugin ecosystem (medium-term)

### 1.1 Cordis plugin release form
- **Status**: reference form only — `config/odsh-bridge.ts` (`odsh-bridge-daemon`) plus
  `cordis.yml`, explicitly annotated "⚠️ not verified in a product environment".
- **Why**: real market reach for the plugin form depends on the DSH plugin publish
  mechanism existing; that is **outside this project's current verifiable scope**.
- **Depends on**: DSH providing a first-class plugin distribution channel (npm package
  convention, plugin manifest, registry/installer). Until then, a full "release" is
  not meaningfully consumable.
- **Actions possible now (verifiable)**:
  - Package the daemon + config + starting story as a proper npm module with exports map,
    README, and a `--help` CLI, so it is structurally release-ready.
  - Add a lifecycle/healthcheck test for `apply(ctx)` (spawn, SIGTERM reclaim) under CI.
  - Document the "plugin vs standalone process" trade-off in one page.
- **Gate**: re-evaluate when DSH's plugin mechanism lands; the npm packing work keeps us quick-to-ship.
- **Done when**: the plugin form builds/exports cleanly as a package and its lifecycle is CI-tested;
  actual "ecosystem entry" is explicitly **blocked on DSH publish support** and re-checked then.

---

## Phase 2 — Architecture: event bus (long-term, NOT now)

### 2.1 Socket / RPC event bus replacing (or augmenting) the file bridge
- **Status**: future only. The current file-bridge (envelope in `Input/` → result in `Output/`)
  is deliberately simple and adequate for the present workload — envelopes are **low-frequency
  handoffs**, so bridge performance is not a bottleneck today.
- **Why deferred (explicitly not now)**:
  - It is an **architecture-level change** that adds a new **network attack surface**.
  - The project just finished a security convergence pass (fail-closed everywhere:
    argv-only exec, path confinement, requester allowlist, atomic state). Any new IPC channel
    would need the **same rigor** — authn on the link, replay protection, payload validation,
    and a small, auditable protocol — which is a substantial effort.
  - No current user-visible pain forces it (bridge latency/throughput is fine for
    low-frequency task handoff).
- **When it would become relevant**: sustained high-frequency cross-container events, real-time
  telemetry, or pushable subscriptions where polling the filesystem is wasteful.
- **If taken on later, it must include**: link-level authn + integrity, replay protection,
  bounded payloads, a strict state machine (fail-closed on malformed frames), and a fresh
  security review before any release. It cannot weaken the current file-bridge guarantees.
- **Done when (future)**: replaced or augmented without regressing the fail-closed posture;
  documented protocol; cross-container reconnect tested.

---

## Sequencing / decision rules

1. **Phase 0 ships only work that survives our security tests** (CI `npm test`, allowlists intact).
2. **Phase 1 "market" claim is gated on DSH plugin publish support** — never overstate before that exists.
3. **Phase 2 is parked** with an explicit trigger (real high-frequency need), not a date.

> Items are listed in rough priority order. Anything marked "NOT now" stays out of active
> development regardless of attractiveness until its gate condition fires.
