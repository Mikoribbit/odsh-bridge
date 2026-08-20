---
name: odsh-interop
description: ODSH Bridge cross-container collaboration protocol — how the OpenClaw agent works with a DeepSeek Harness (DSH) execution layer: task envelopes, bridge zones, notification channel rules
version: 1
author: odsh-bridge project
when_to_use: whenever the operator asks for cross-application/container work (DSH executes), when a task must be handed to the DSH layer, or when reporting bridge collaboration status
---

# ODSH-Interop Skill (OpenClaw side)

## Roles

- **OpenClaw (you) = brain / persona**: conversation, memory, dreaming, decisions, final judgement.
- **DSH (DeepSeek Harness) = execution layer**: heavy cross-application work — tools,
  code, retrieval, Windows node actions, etc.
- **Human operator = final arbiter** for anything uncertain.

## Collaboration channels (bridge zones)

| Path | Purpose |
|---|---|
| `<BRIDGE>/Input/` | Task entry: `T-*.json` envelopes (SHARED) |
| `<BRIDGE>/output/` | Result exit: `T-*_result.json` (SHARED) |
| `<BRIDGE>/DSH-Workspace/` | DSH private zone (OpenClaw must not modify) |
| `<BRIDGE>/openclaw-workspace/` | OpenClaw private zone (DSH must not modify) |
| configured notification channel (e.g. Discord) | real-time status between both sides |

`<BRIDGE>` = the shared mount path both containers use (repo default `/root/ODSH-bridge`).

## Envelope contract (v1)

- A task is `input/T-<YYMMDD>-<seq>.json`; fields (see `docs/BRIDGE-SPEC.md`):
  `taskId / type / status / requester / target / createdMs / payload / context / result`.
- State machine: `queued -> running -> done | failed | cancelled`.
- Atomic writes: always `.tmp` → rename (never write a half file).
- Result: `output/<taskId>_result.json` with `status / finishedMs / by / payload / human / error`.

## What OpenClaw should do

1. When a cross-application task should be executed by DSH:
   - Write an envelope `input/T-*.json` (copy the template in `docs/BRIDGE-SPEC.md`).
   - Don't block waiting: the DSH daemon picks it up, executes, writes the result and may
     notify the channel.
2. When a result arrives in `output/`:
   - Surface the `human` summary to the operator via your normal channel.
   - Optionally keep important conclusions in your memory, or drop a note into
     `<bridge>/openclaw-workspace/dream-feed/` for your dreaming pipeline to digest.
3. You are the decider, DSH is the doer: anything needing persona/judgement/operator
   preference stays with you.
4. Prefer bridge envelopes over touching the other side's private zone.

## Template envelope (OpenClaw → DSH)

```json
{
  "schema": "odsh-envelope/v1",
  "taskId": "T-YYMMDD-XX",
  "type": "execute",
  "status": "queued",
  "requester": "openclaw",
  "target": "dsh",
  "createdMs": 0,
  "payload": {
    "kind": "run-command",
    "command": "<command>",
    "args": {}
  },
  "context": {
    "channel": "<notificationChannelId>"
  }
}
```

## Setup (once)

Place this skill in your skills directory (e.g. `/root/.openclaw/skills/odsh-interop/SKILL.md`
or your skills path), then the collaboration works as long as:

- both containers share the bridge mount (same `<BRIDGE>` path);
- DSH side has `dsh_bridge` daemon running (or you trigger it manually);
- the notification channel id is configured on both sides (envelope `context.channel` /
  DSH `.env` `DISCORD_CHANNEL_ID`).

## Notes

- The rest of the integration details live in the odsh-bridge repo
  (`docs/PROTOCOL.md`, `docs/BRIDGE-SPEC.md`, `MAINTENANCE.md`, `src/`).