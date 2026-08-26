# Configuration & Directory Structure

## Directory structure

```
plugin-release/
├── README.md                  This document (EN)
├── README.zh.md               Chinese version
├── AUTHORS.md                 Maintainer / contributors
├── CHANGELOG.md               Version history (Keep a Changelog)
├── MAINTENANCE.md             Verified troubleshooting notes
├── docs/
│   ├── PROTOCOL.md            Gateway handshake / frames / methods / errors / idempotency
│   ├── BRIDGE-SPEC.md         Bridge four zones / envelope schema / state machine / atomic write
│   └── CUA-EXECUTION.md       Windows desktop execution via Cua Driver (install/authorize/use)
├── skills/
│   └── odsh-interop/          OpenClaw-side skill (SKILL.md + install README)
├── src/
│   ├── env.mjs                .env loader
│   ├── gateway-client.mjs     Shared WS/Ed25519 pairing client
│   ├── oc-invoke.mjs          Invoke any gateway method
│   ├── oc-send.mjs            Send a message via gateway
│   ├── oc-client.mjs          Pairing wait / long-lived client
│   ├── oc-cua.mjs             (v1.1) SSH + Cua Driver desktop execution
│   ├── bridge-daemon.mjs      Envelope watcher/executor
│   └── bridge-cleanup.mjs     Retention cleanup tool
├── scripts/                   One-shot idempotent setup
│   ├── setup-windows.ps1      Windows host: Cua Driver + OpenSSH + firewall + key + connect json
│   └── setup-dsh.sh           DSH container: ssh client + key + .env + verify get_screen_size
├── config/                    Cordis plugin form (⚠️ optional, not product-verified)
├── docker-compose.yml         Runnable compose template (OpenClaw official image + DSH build/image)
├── bridge-template/           Copy-ready directory bridge: Input/ Output/ DSH-Workspace/ Openclaw-Workspace/
├── .env.example               Env template (all placeholders)
└── LICENSE  ·  package.json  ·  docker-compose.snippet.yml (legacy snippet)
```

---

