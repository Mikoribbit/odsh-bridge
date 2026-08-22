# ODSH Bridge Directory-Bridge Spec (BRIDGE-SPEC)

Corresponds to `src/bridge-daemon.mjs` and the four-zone bridge at `/root/ODSH-bridge` in the verified environment. Principle: all cross-container collaboration happens via envelopes — machine-readable, retryable, traceable.

## 1. Directory Overview (Four Zones)

```
/root/ODSH-bridge/
├── Input/                 # [SHARED] task entry: T-*.json (envelopes)
├── Output/                # [SHARED] result exit: <taskId>_result.json
├── DSH-Workspace/         # [PRIVATE] DSH-private: identity JWK/drafts/logs (OpenClaw must not modify)
└── Openclaw-Workspace/    # [PRIVATE] OpenClaw-private: memory/summaries/dream-feed (DSH must not modify)
```

Both containers mount it to the same host directory (host path is operator-chosen and mounted to in-container `/root/ODSH-bridge`; see docker-compose.snippet.yml).

## 2. Envelope Format (Input/<taskId>.json)

```json
{
  "schema": "odsh-envelope/v1",
  "taskId": "T-260820-01",
  "type": "execute | query | notify | bridge-status | interop",
  "status": "queued",
  "requester": "dsh | openclaw | human",
  "target": "dsh | openclaw | both",   // (windows-node kept reserved in daemon for back-compat; desktop execution goes through the Cua channel, see docs/CUA-EXECUTION.md)
  "createdMs": 1787249900000,
  "expiresMs": 1787336000000,
  "payload": { "kind": "echo", "text": "..." },
  "context": { "channel": "<discordChannelId>", "sessionKey": "<agentSessionKey>" },
  "result": null
}
```

Required: `taskId / type / status / requester / target / createdMs / payload`; `expiresMs / context / result` optional.

## 3. State Machine

```
queued -> running -> done
   |          |        -> failed (with error)
   |          +-> failed (timeout/abandoned)
   +-> cancelled
```

Advancement rules:

- The writer may update `status` in the envelope at each step, or just write the result file;
- The reader **must not modify the original Input file**; results go to `Output/<taskId>_result.json`;
- Atomic write: always write `.tmp` first, then `rename` (mv) to the final name, so the peer never reads a half-written file.
- zh: 原子写规则：先写 .tmp 再 rename 成正式名，防止对端读到半截文件。

## 4. Result Files (Output/<taskId>_result.json)

```json
{
  "schema": "odsh-result/v1",
  "taskId": "T-260820-01",
  "status": "done | failed | cancelled",
  "finishedMs": 1787249903000,
  "by": "dsh | openclaw",
  "payload": { "...": "..." },
  "human": "Task T-260820-01 complete",
  "error": null
}
```

`human` is a human-readable summary that can be posted directly to a channel.

## 5. Naming & Conflict Avoidance

- Task ids: `T-<YYMMDD>-<two-digit sequence>` (e.g. `T-260820-01`); the daemon uses the **envelope filename basename** as the taskId (`T-*.json`).
- Results: same id + `_result.json`; attachments: `Output/<taskId>_att-<sequence>.<ext>`.
- Each side maintains `Input/.state/<requester>.json` recording processed ids to avoid duplicates (DSH side: `dsh-processed.json`).

## 6. payload.kind (implemented and verified by the DSH daemon)

| kind | payload fields | output |
|---|---|---|
| echo | `text` or `command` | `{echoed}` |
| notify | `text` / `items` | `{ack:true, from, text}` (recorded and acknowledged) |
| run-command | `command` | `{stdout}` or `{error,stderr}` |
| write-file | `args.{file,content}` | `{written}` |
| read-file | `args.file` | `{content}` (truncated to 4000 chars) |
| bridge-status | — | `{input,output}` file counts |

Operational details (matching the verified environment):

- `run-command`: `/bin/sh -c`, 15 s timeout, stdout truncated at 4000; first-word charset validation (forbids `;`, `&`, `|` and backtick characters) refuses execution.
- `write-file / read-file`: absolute paths are used directly; relative paths resolve against the bridge root; the release build adds `BRIDGE_ALLOW_ABS_PATHS` (default `false`) to disable absolute paths ⚠️ `false` is the recommended safe default — adjust per your trust model.
- Scan interval: `--interval-ms` (default 5000); `--once` for a single pass; already-processed ids are skipped (idempotent).

## 7. Atomic Write Example (inside the daemon)

```js
writeFileSync(tmp, JSON.stringify(result, null, 2)); // <taskId>_result.json.tmp
renameSync(tmp, fin);                                // → <taskId>_result.json
```

## 8. Security

- Four-zone ownership: DSH never enters Openclaw-Workspace, OpenClaw never enters DSH-Workspace; the identity JWK belongs exclusively to DSH-Workspace.
- `run-command` has execution capability: only open to envelope requesters that are trusted/whitelisted; the release build keeps the original validation as-is (first-word charset check), and production deployments should add a requester whitelist.
- All files UTF-8 + LF; sensitive info never committed (`.env` / gitignore already exclude it).