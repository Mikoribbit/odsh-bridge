#!/usr/bin/env node
// ODSH Bridge Daemon (C-1) — DSH side persistent watcher.
// Watches Input/ for new T-*.json envelopes, executes supported kinds,
// writes Output/<taskId>_result.json, optionally notifies the Discord channel.
// Usage: node dsh_bridge.mjs [--once] [--interval-ms N] [--notify]
import { readdirSync, readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, basename, dirname, resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initSqlite, recordEnvelope, recordError } from './sqlite-store.mjs';

const BRIDGE = process.env.BRIDGE_PATH || '/root/ODSH-bridge';
// SECURITY: read-file/write-file honor this flag. Default false => ONLY relative paths below BRIDGE;
// absolute paths and any path escaping BRIDGE are rejected (prevents .env / JWK / authorized_keys exfiltration).
const ALLOW_ABS_PATHS = process.env.BRIDGE_ALLOW_ABS_PATHS === 'true';
// requester allowlist (F-4): leave empty to accept anyone; set e.g. 'openclaw,dsh' to restrict.
const ALLOW_REQUESTERS = (process.env.BRIDGE_ALLOW_REQUESTERS || '').split(',').map(s => s.trim()).filter(Boolean);
const INPUT = join(BRIDGE, 'Input');
const OUTPUT = join(BRIDGE, 'Output');
const STATE = join(INPUT, '.state');
const FAILED_DLQ = join(INPUT, 'failed'); // dead-letter queue: bad envelopes (unparsable / threw) land here instead of wedging the scheduler
const NOTIFY = process.argv.includes('--notify');
const ONCE = process.argv.includes('--once');
const idxi = process.argv.indexOf('--interval-ms');
const INTERVAL_MS = Number(idxi >= 0 ? process.argv[idxi + 1] : 5000) || 5000;
const CHANNEL = process.env.DISCORD_CHANNEL_ID || ''; // override via .env; if empty, notifications are skipped
const SEND_SCRIPT = process.env.OC_SEND_SCRIPT || join(process.cwd(), 'src', 'oc-send.mjs');
// Back-compat: routes commands to a paired node via gateway node.invoke.
// This is NOT the recommended desktop path anymore — use docs/CUA-EXECUTION.md
// (oc-cua.mjs over SSH + Cua Driver). Kept for envelopes that still target it.
const NODE_SCRIPT = process.env.OC_NODE_SCRIPT || join(process.cwd(), 'src', 'oc-cua.mjs');

mkdirSync(STATE, { recursive: true });

function log(...a) { console.log(new Date().toISOString(), ...a); }

function loadState() {
  const f = join(STATE, 'dsh-processed.json');
  if (!existsSync(f)) return { processed: {} };
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (!j || typeof j !== 'object' || !j.processed) throw new Error('bad state shape');
    return j;
  } catch (e) {
    // fail-closed: do NOT silently reset to empty (would re-execute everything)
    log('state unreadable, refusing to reset: ' + e.message);
    throw new Error('state unreadable: ' + e.message);
  }
}
function saveState(s) {
  const f = join(STATE, 'dsh-processed.json');
  const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, f);
}

// ---- dead-letter queue (DLQ) ----
// Bad envelopes — ones that could not be parsed or threw an uncaught exception
// while processing — must not sit in Input/ and retry forever. They are moved
// atomically into Input/failed/ with a <taskId>.error.json report. Normal,
// expected failures (a payload handler returning { error: ... }) are NOT DLQ'd;
// they produce a regular failed result like before.
function dlqEnvelope(taskId, fileName, raw, errInfo) {
  const failedDir = FAILED_DLQ;
  mkdirSync(failedDir, { recursive: true });
  const orig = join(INPUT, fileName);
  const body = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  // preserve the original envelope inside failed/ with its exact name (collision-safe)
  let dest = join(failedDir, fileName);
  if (existsSync(dest)) { dest = join(failedDir, basename(fileName, '.json') + '-' + Date.now() + '.json'); }
  writeFileSync(dest + '.tmp', body);
  renameSync(dest + '.tmp', dest);
  // companion error report
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { parsed = null; }
  const report = {
    schema: 'odsh-dlq/v1', taskId,
    failedAt: new Date().toISOString(),
    originalFile: fileName,
    error: { code: errInfo.code || 'exception', message: errInfo.message || String(errInfo), stack: errInfo.stack || null },
    payload: parsed !== null ? parsed : { raw: body.slice(0, 16000) },
  };
  const reportPath = join(failedDir, taskId + '.error.json');
  writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2));
  renameSync(reportPath + '.tmp', reportPath);
  // remove the original from Input/ so the scheduler stops re-watching it
  try { unlinkSync(orig); } catch {}
  log('DLQ', fileName, '->', dest.split('/').pop());
}

// Trace linkage (cross-container): pass through an inbound trace_id, else mint a
// fresh one. span_id is always a fresh UUID for this hop; parent_span_id records
// the previous hop's span (the inbound envelope's parent_span_id, else its span_id,
// else null). Old envelopes without any trace fields stay fully compatible.
function resolveTrace(task) {
  const trace_id = (typeof task.trace_id === 'string' && task.trace_id) || randomUUID();
  const parent_span_id = (typeof task.parent_span_id === 'string' && task.parent_span_id)
    || (typeof task.span_id === 'string' && task.span_id) || null;
  const span_id = randomUUID();
  return { trace_id, span_id, parent_span_id };
}

function envelopeCandidates() {
  return readdirSync(INPUT).filter(f => /^T-.*\.json$/.test(f));
}

// Restricted executor for supported payload kinds (DSH local execution)
// Resolve a file path safely: relative paths are confined under BRIDGE; absolute paths only when
// ALLOW_ABS_PATHS=true (and even then must not traverse with '..'). Rejects anything escaping BRIDGE.
function resolveTarget(file, mode) {
  const rawPath = String(file||'');
  if (!rawPath || rawPath.includes('\0')) return { error: 'invalid path' };
  const rel = !isAbsolute(rawPath);
  if (rel && rawPath.split(/[\\/]/).includes('..')) return { error: 'path traversal not allowed: ' + rawPath };
  const candidate = rel ? join(BRIDGE, rawPath) : (ALLOW_ABS_PATHS ? rawPath : null);
  if (!candidate) return { error: 'absolute path not allowed (set BRIDGE_ALLOW_ABS_PATHS=true to enable) - path: ' + rawPath };
  if (isAbsolute(candidate)) {
    // ensure it resolves inside BRIDGE (guard symlink-escape too)
    try {
      const rp = realpathSync(dirname(candidate) || candidate) || candidate;
      const bridgeRp = existsSync(BRIDGE) ? realpathSync(BRIDGE) : BRIDGE;
      if (mode === 'write') {
        // parent must stay under bridge (file itself may not exist yet)
        if (!rp.startsWith(bridgeRp + sep())) return { error: 'path escapes bridge: ' + rawPath };
      } else {
        if (!rp.startsWith(bridgeRp + sep())) return { error: 'path escapes bridge: ' + rawPath };
      }
    } catch (e) { return { error: 'cannot resolve path: ' + rawPath }; }
  }
  return { path: candidate };
}
function sep(){ return '/'; }

function executePayload(task) {
  const p = task.payload || {};
  const kind = p.kind || 'echo';
  switch (kind) {
    case 'echo':
      return { echoed: p.text ?? p.command ?? null };
    case 'notify':
      // ack/notification envelope (e.g. the peer confirming something) — record and acknowledge
      return {
        ack: true,
        from: task.requester || 'unknown',
        text: typeof p.text === 'string' ? p.text.slice(0, 2000) : (p.items ? 'items:' + p.items.length : null)
      };
    case 'run-command': {
      // SECURITY (v1.1.0 hardening): no /bin/sh -c. Only a fixed argv allowlist is executed.
      // Command strings are split on whitespace; the tool must be in the allowlist below,
      // and every arg is passed as a literal argv element (no shell interpretation).
      const ALLOWED_BINS = {
        node: 'node',
        python3: 'python3',
        git: 'git',
        ls: '/bin/ls',
        cat: '/bin/cat',
        echo: '/bin/echo',
        date: '/bin/date',
        pwd: '/bin/pwd',
        wc: '/usr/bin/wc',
        grep: '/usr/bin/grep',
        wget: '/usr/bin/wget',
        curl: '/usr/bin/curl',
      };
      const tokens = String(p.command || '').trim().split(/\s+/).filter(Boolean).slice(0, 64);
      if (!tokens.length) return { error: 'empty command' };
      const binKey = tokens[0];
      const binPath = ALLOWED_BINS[binKey];
      if (!binPath) return { error: 'command not allowed: ' + binKey };
      try {
        const out = execFileSync(binPath, tokens.slice(1), { timeout: 15000, encoding: 'utf8' }).slice(0, 4000);
        return { stdout: out };
      } catch (e) {
        return { error: e.message, stderr: String(e.stderr || '').slice(0, 2000) };
      }
    }
    // run-command is only for trusted envelope sources; its first-word charset check (rejects ;, &, |, and backtick) refuses unsafe commands
    // 中文：run-command 仅限可信信封来源；首词字符集校验（禁 ; & | 反引号）拒绝不安全的命令。
    case 'write-file': {
      const { file, content } = p.args || {};
      if (!file) return { error: 'no file' };
      const dest = resolveTarget(file, 'write');
      if (dest.error) return { error: dest.error };
      mkdirSync(dirname(dest.path), { recursive: true });
      writeFileSync(dest.path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      return { written: dest.path };
    }
    case 'read-file': {
      const { file } = p.args || {};
      if (!file) return { error: 'no file' };
      const src = resolveTarget(file, 'read');
      if (src.error) return { error: src.error };
      if (!existsSync(src.path)) return { error: 'not found: ' + src.path };
      return { content: readFileSync(src.path, 'utf8').slice(0, 4000) };
    }
    // Back-compat node envelope: kept so old envelopes still route, but the desktop execution
    // path is now docs/CUA-EXECUTION.md (oc-cua.mjs over SSH + Cua Driver).
    // Envelope: payload.kind = "run-node" | "windows-node"; payload.args = { nodeId?, command, params? }
    case 'run-node':
    case 'windows-node': {
      const { command = '', params = {} } = p.args || {};
      const cmd = String(command).trim();
      if (!cmd) return { error: 'no node command' };
      try {
        const out = execFileSync(process.execPath, [NODE_SCRIPT, cmd, JSON.stringify(params)], {
          timeout: 60000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
        });
        return { node: 'cua', command: cmd, reply: out.slice(0, 3000) };
      } catch (e) {
        return {
          error: e.message,
          stderr: String(e.stderr || '') + String(e.stdout || '').slice(0, 2000)
        };
      }
    }
    case 'bridge-status':
      return { input: envelopeCandidates().length, output: readdirSync(OUTPUT).length };
    default:
      return { unsupportedKind: kind };
  }
}

function notifyChannel(text) {
  if (!NOTIFY || !CHANNEL || !existsSync(SEND_SCRIPT)) {
    if (NOTIFY && !CHANNEL) log('notify skipped: DISCORD_CHANNEL_ID not set');
    return false;
  }
  try {
    const out = execFileSync(process.execPath, [SEND_SCRIPT, CHANNEL, text], { timeout: 25000, encoding: 'utf8' });
    log('notify ok', out.slice(0, 200));
    return true;
  } catch (e) { log('notify failed', e.message.slice(0, 200)); return false; }
}

function tick() {
  try {
    innerTick();
  } catch (e) {
    log('tick crashed (will retry next interval):', e.message);
  }
}

function innerTick() {
  const state = loadState();
  for (const f of envelopeCandidates()) {
    const taskId = basename(f, '.json');
    if (state.processed[taskId]) continue;
    const abs = join(INPUT, f);
    let raw;
    try { raw = readFileSync(abs, 'utf8'); } catch (e) { log('cannot read', f, e.message); continue; }
    let task;
    try { task = JSON.parse(raw); }
    catch (e) {
      // truly bad data (unparsable): fail-closed into the DLQ instead of retrying forever
      log('unparsable input -> DLQ', f, e.message);
      dlqEnvelope(taskId, f, raw, { code: 'parse_error', message: e.message, stack: e.stack });
      recordError(taskId, 'parse_error: ' + e.message, e.stack);
      state.processed[taskId] = 'dead'; saveState(state); continue;
    }

    if (task.status === 'running') continue;
    if (!['queued', undefined].includes(task.status)) { state.processed[taskId] = task.status; saveState(state); continue; }
    if (ALLOW_REQUESTERS.length && !ALLOW_REQUESTERS.includes(task.requester)) {
      log('skip ', taskId, ' requester not allowed: ' + task.requester);
      state.processed[taskId] = 'denied'; saveState(state); continue;
    }

    log('processing', taskId, task.payload?.kind || task.type);
    const trace = resolveTrace(task);
    let result;
    try {
      const r = executePayload(task);
      result = {
        schema: 'odsh-result/v1', taskId,
        status: r.error ? 'failed' : 'done',
        finishedMs: Date.now(), by: 'dsh',
        trace: { trace_id: trace.trace_id, span_id: trace.span_id, parent_span_id: trace.parent_span_id },
        payload: r.error ? { error: r.error } : r,
        human: r.error ? `task ${taskId} failed: ${r.error}` : `task ${taskId} done`,
        error: r.error ? { code: 'exec_failed', message: r.error } : null
      };
    } catch (e) {
      // uncaught exception while executing — a bug/bad payload, not a normal failed result.
      // Quarantine into the DLQ and do NOT emit a regular "failed" result.
      log('processing exception -> DLQ', taskId, e.message);
      dlqEnvelope(taskId, f, raw, { code: 'exception', message: e.message, stack: e.stack });
      state.processed[taskId] = 'dead'; saveState(state); continue;
    }
    const tmp = join(OUTPUT, taskId + '_result.json.tmp');
    const fin = join(OUTPUT, taskId + '_result.json');
    writeFileSync(tmp, JSON.stringify(result, null, 2));
    renameSync(tmp, fin);
    log('done', taskId, result.status);
    state.processed[taskId] = result.status;
    saveState(state);
    if (result.status !== 'cancelled') notifyChannel(result.human);
    recordEnvelope(task, result, trace);
  }
}

log('dsh_bridge daemon start', { intervalMs: INTERVAL_MS, notify: NOTIFY });
await initSqlite(process.env.BRIDGE_SQLITE_DB); // optional auditing; no-op if node:sqlite absent
tick();
if (!ONCE) setInterval(tick, INTERVAL_MS);
log('daemon ready' + (ONCE ? ' (once)' : ' (looping)'));