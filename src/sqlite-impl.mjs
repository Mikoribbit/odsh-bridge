// sqlite-impl.mjs — thin wrapper over Node's built-in node:sqlite (DatabaseSync).
// Because we static-import node:sqlite, this module only loads on Node >=22.5.
// sqlite-store.mjs wraps this in a try/catch so older runtimes degrade to no-op.
import { DatabaseSync } from 'node:sqlite';

export function openStore(dbPath) {
  const db = new DatabaseSync(dbPath || '');

  db.exec(`CREATE TABLE IF NOT EXISTS dsh_envelopes (
    taskId TEXT PRIMARY KEY,
    type TEXT,
    status TEXT,
    requester TEXT,
    target TEXT,
    createdMs INTEGER,
    expiresMs INTEGER,
    finishedMs INTEGER,
    duration INTEGER GENERATED ALWAYS AS (finishedMs - createdMs) STORED,
    raw_envelope TEXT,
    trace_id TEXT,
    span_id TEXT,
    parent_span_id TEXT,
    createdAt TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
    updatedAt TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dsh_status ON dsh_envelopes(status);
  CREATE INDEX IF NOT EXISTS idx_dsh_created ON dsh_envelopes(createdMs);
  CREATE INDEX IF NOT EXISTS idx_dsh_finished ON dsh_envelopes(finishedMs);
  CREATE TABLE IF NOT EXISTS dsh_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taskId TEXT,
    eventType TEXT,
    fromStatus TEXT,
    toStatus TEXT,
    timestamp TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
    metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS dsh_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taskId TEXT,
    error TEXT,
    timestamp TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
    traceback TEXT
  );
  CREATE VIEW IF NOT EXISTS dsh_bridge_stats AS
  SELECT COUNT(*) AS total_tasks,
         SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
         MIN(createdMs) AS first_created,
         MAX(finishedMs) AS last_finished
  FROM dsh_envelopes;`);

  const insEnv = db.prepare(`INSERT OR REPLACE INTO dsh_envelopes
    (taskId,type,status,requester,target,createdMs,expiresMs,finishedMs,raw_envelope,trace_id,span_id,parent_span_id,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%d %H:%M:%S','now'))`);
  const insEv = db.prepare('INSERT INTO dsh_events (taskId,eventType,fromStatus,toStatus) VALUES (?,?,?,?)');
  const insEr = db.prepare('INSERT INTO dsh_errors (taskId,error,traceback) VALUES (?,?,?)');

  return {
    insertEnvelope(row) {
      insEnv.run(row.taskId, row.type, row.status, row.requester, row.target, row.createdMs, row.expiresMs, row.finishedMs, row.raw_envelope, row.trace_id, row.span_id, row.parent_span_id);
    },
    insertEvent(row) { insEv.run(row.taskId, row.eventType, row.fromStatus, row.toStatus); },
    insertError(row) { insEr.run(row.taskId, row.error, row.traceback); },
    close() { try { db.close(); } catch (_) {} },
  };
}
