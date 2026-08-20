# Authors

This project is the result of a two-sided integration effort
between **DeepSeek Harness (DSH)** and **OpenClaw**.

## Maintainer / Owner

- **MikoRibbit** <897322599a@gmail.com>
  - Project owner, operator, and human decision-maker.
  - Set up the docker `agent-mesh` network, the shared bridge (`H:/ODSH-bridge`),
    and the Discord collaboration channel.

## Contributor

- **0vstarphoto** <0vstarphoto@gmail.com>
  - Automation/integration engineering on the DSH side:
    - Reverse-engineered the OpenClaw gateway WebSocket handshake
      (explicit `Origin`, Ed25519 device pairing, `connect.challenge` flow).
    - Implemented and battle-tested the gateway client, envelope bridge,
      and the resident bridge daemon (watch `Input/` → execute → write result → notify).
    - Diagnosed and fixed two real-world issues now documented in `docs/PROTOCOL.md`:
      `node:net` ESM has no `Socket.close()` (→ `safeClose` compatibility layer),
      and the occasional `device signature invalid` (claim `signedAt` vs `device.signedAt`
      used two `Date.now()` calls — must share a single timestamp).
    - Produced this release package (docs, zero-dependency ESM tools, i18n README).

## With thanks to

- **OpenClaw** — the brain/persona layer: adopted the `odsh-interop` skill,
  keeps the long-term memory & dreaming pipeline, and will digest DSH session
  summaries from `Openclaw-Workspace/dream-feed/`.