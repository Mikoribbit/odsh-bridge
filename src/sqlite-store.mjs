// sqlite-store.mjs — OPTIONAL SQLite auditing/stats side-store for the bridge daemon.
//
// Additive & non-required. The core bridge stays on the original JSON file store
// (.state/dsh-processed.json + Output/*_result.json). When Node ships built-in
// node:sqlite (>=22.5) AND BRIDGE_SQLITE is enabled, this module mirrors
// task/event/error rows into <BRIDGE>/DSH-Workspace/dsh.db for queryable history,
// aggregates and audit. If node:sqlite is unavailable or disabled, initSqlite()
// returns null and every record* call is a harmless no-op.

let store = null;          // { insertEnvelope, insertEvent, insertError, close }
let loading = null;        // in-flight init promise

// Async init (call once at daemon start). Returns the store or null.
export async function initSqlite(dbPath) {
  if (store) return store;
  if (loading) return loading;
  if (process.env.BRIDGE_SQLITE === '0' || process.env.BRIDGE_SQLITE === 'false') {
    return null; // explicitly disabled
  }
  loading = (async () => {
    try {
      const imp = await import('./sqlite-impl.mjs');
      store = imp.openStore(dbPath || process.env.BRIDGE_SQLITE_DB);
    } catch (_) {
      store = null; // node:sqlite unavailable / open failed -> auditing off, JSON store unaffected
    }
    return store;
  })();
  return loading;
}

// Synchronous "is it active now" — used by the daemon after init.
export function sqliteActive() { return !!store; }

export function recordEnvelope(task, result, trace) {
  if (!store) return;
  try {
    store.insertEnvelope({
      taskId: task.taskId ?? task.id,
      type: task.type || null,
      status: result ? result.status : (task.status || 'queued'),
      requester: task.requester || null,
      target: task.target || null,
      createdMs: Number(task.createdMs) || null,
      expiresMs: task.expiresMs != null ? Number(task.expiresMs) : null,
      finishedMs: result && result.finishedMs != null ? Number(result.finishedMs) : null,
      raw_envelope: JSON.stringify(task),
      // trace fields may be undefined when keys are absent; normalize to null so
      // node:sqlite run() never hits 'cannot be bound to SQLite parameter' and
      // silently drops the whole envelope from audit.
      trace_id: trace && (trace.trace_id ?? null),
      span_id: trace && (trace.span_id ?? null),
      parent_span_id: trace && (trace.parent_span_id ?? null),
    });
    if (result && result.status === 'failed' && result.error) {
      store.insertError({ taskId: task.taskId ?? task.id, error: String(result.error.message || result.error), traceback: '' });
    }
    store.insertEvent({ taskId: task.taskId ?? task.id, eventType: 'status', fromStatus: task.status || 'queued', toStatus: result ? result.status : (task.status || 'queued') });
  } catch (_) { /* never break the daemon */ }
}

export function recordError(taskId, message, traceback) {
  if (!store) return;
  try { store.insertError({ taskId, error: String(message || ''), traceback: String(traceback || '') }); } catch (_) {}
}

export function closeSqlite() { if (store) { try { store.close(); } catch (_) {} } store = null; }
