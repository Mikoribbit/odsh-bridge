# ODSH Bridge 目录桥规范（BRIDGE-SPEC）

对应 `src/bridge-daemon.mjs` 与验证环境 `/root/ODSH-bridge` 的四区桥。原则：一切跨容器协作 = 通过信封（envelope）交接，机器可读、可重试、可追溯。

## 1. 目录总纲（四区）

```
/root/ODSH-bridge/
├── Input/                 # [SHARED] 任务入口：T-*.json（信封）
├── Output/                # [SHARED] 结果出口：<taskId>_result.json
├── DSH-Workspace/         # [PRIVATE] DSH 私有：身份 JWK/草稿/日志（OpenClaw 不得改）
└── Openclaw-Workspace/    # [PRIVATE] OpenClaw 私有：记忆/摘要/dream-feed（DSH 不得改）
```

两侧容器都把它挂到同一宿主目录（验证环境：宿主 `H:/ODSH-bridge` → 容器内 `/root/ODSH-bridge`，见 docker-compose.snippet.yml）。

## 2. 信封格式（Input/<taskId>.json）

```json
{
  "schema": "odsh-envelope/v1",
  "taskId": "T-260820-01",
  "type": "execute | query | notify | bridge-status | interop",
  "status": "queued",
  "requester": "dsh | openclaw | miko",
  "target": "dsh | openclaw | windows-node | both",
  "createdMs": 1787249900000,
  "expiresMs": 1787336000000,
  "payload": { "kind": "echo", "text": "..." },
  "context": { "channel": "<discordChannelId>", "sessionKey": "agent:main:main" },
  "result": null
}
```

必填：`taskId / type / status / requester / target / createdMs / payload`；`expiresMs / context / result` 可选。

## 3. 状态机

```
queued -> running -> done
   |          |        -> failed (附 error)
   |          +-> failed (超时/放弃)
   +-> cancelled
```

推进规则：

- 写入方每步可更新信封内 `status`，或只写结果文件；
- 读取方**不得修改 Input 原始文件**，结果写到 `Output/<taskId>_result.json`；
- 原子写：一律先写 `.tmp`，再 `rename`（mv）成正式名，避免对端读到半截文件。

## 4. 结果文件（Output/<taskId>_result.json）

```json
{
  "schema": "odsh-result/v1",
  "taskId": "T-260820-01",
  "status": "done | failed | cancelled",
  "finishedMs": 1787249903000,
  "by": "dsh | openclaw",
  "payload": { "...": "..." },
  "human": "任务 T-260820-01 完成",
  "error": null
}
```

`human` 为可直接投频道的人工可读摘要。

## 5. 命名与冲突避免

- 任务 id：`T-<YYMMDD>-<两位序号>`（例 `T-260820-01`）；daemon 以**信封文件名 basename** 作为 taskId（`T-*.json`）。
- 结果：同 id + `_result.json`；附件：`Output/<taskId>_att-<序号>.<ext>`。
- 双方各自维护 `Input/.state/<requester>.json` 记录已处理 id 防重复（DSH 侧：`dsh-processed.json`）。

## 6. payload.kind（DSH daemon 已验证实现）

| kind | payload 字段 | 输出 |
|---|---|---|
| echo | `text` 或 `command` | `{echoed}` |
| notify | `text` / `items` | `{ack:true, from, text}`（记录并确认） |
| run-command | `command` | `{stdout}` 或 `{error,stderr}` |
| write-file | `args.{file,content}` | `{written}` |
| read-file | `args.file` | `{content}`（截 4000 字符） |
| bridge-status | — | `{input,output}` 文件计数 |

运行细节（与验证环境一致）：

- `run-command`：`/bin/sh -c`，超时 15s，stdout 截 4000；首词字符集校验（禁 `;`、`&`、`|` 与反引号字符）拒绝执行。
- `write-file / read-file`：绝对路径直接使用；相对路径解析到桥根；发布版新增 `BRIDGE_ALLOW_ABS_PATHS`（默认 `false`）可禁绝对路径 ⚠️ 安全默认值建议 false，按你的信任模型调整。
- 扫描区间：`--interval-ms`（默认 5000）；`--once` 单次；已处理 id 跳过（幂等）。

## 7. 原子写示例（daemon 内）

```js
writeFileSync(tmp, JSON.stringify(result, null, 2)); // <taskId>_result.json.tmp
renameSync(tmp, fin);                                // → <taskId>_result.json
```

## 8. 安全

- 四区所有权：DSH 不进 Openclaw-Workspace，OpenClaw 不进 DSH-Workspace；身份 JWK 只属于 DSH-Workspace。
- `run-command` 有执行能力：仅对信封来源可信/白名单 requester 开放；发布版默认保留原实现的原样校验（首词字符合检查），生产部署建议加 requester 白名单。
- 所有文件 UTF-8 + LF；敏感信息不入库（`.env` / gitignore 已排除）。