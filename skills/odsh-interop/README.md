# OpenClaw-side skill: odsh-interop

This directory contains the **OpenClaw-side** counterpart of the odsh-bridge
project. Without it, the OpenClaw agent does not know how to cooperate with a
DeepSeek Harness execution layer — install it so both sides can work together.

## What you need on the OpenClaw side

- OpenClaw with a skills directory (default `/root/.openclaw/skills/`).
- The shared bridge mount at the same path in both containers
  (default `<BRIDGE>` = `/root/ODSH-bridge`).
- A notification channel (e.g. a Discord channel) whose id you configure in
  both sides.

## Install (no release needed — copy from a checkout)

```bash
# from a clone/download of odsh-bridge:
mkdir -p /root/.openclaw/skills/odsh-interop
cp skills/odsh-interop/SKILL.md /root/.openclaw/skills/odsh-interop/SKILL.md

# verify the skill loads
openclaw skills list | grep odsh-interop
```

## Files

- `SKILL.md` — the skill definition (front-matter + instructions).

## Keeping it in sync

The skill is a small, single file. When you update the bridge protocol, re-copy
`SKILL.md` into OpenClaw's skills dir (or have the OpenClaw agent re-read it
via `skills.reload` if supported).