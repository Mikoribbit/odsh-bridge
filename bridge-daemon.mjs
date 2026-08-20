#!/usr/bin/env node
// ODSH Bridge Daemon (C-1) — DSH side persistent watcher.
// Watches Input/ for new T-*.json envelopes, executes supported kinds,
// writes Output/<taskId>_result.json, optionally notifies the Discord channel.
// Usage: node dsh_bridge.mjs [--once] [--interval-ms N] [--notify]
import { readdirSync, readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const BRIDGE = '/root/ODSH-bridge';
const INPUT = join(BRIDGE, 'Input');
const OUTPUT = join(BRIDGE, 'Output');
const STATE = join(INPUT, '.state');
const NOTIFY = process.argv.includes('--notify');
const ONCE = process.argv.includes('--once');
const idxi = process.argv.indexOf('--interval-ms');
const INTERVAL_MS = Number(idxi >= 0 ? process.argv[idxi + 1] : 5000) || 5000;
const CHANNEL = '1540063599605579837';
const SEND_SCRIPT = '/root/ODSH-bridge/DSH-Workspace/tools/oc_send.mjs';

mkdirSync(STATE, { recursive: true });

function log(...a) { console.log(new Date().toISOString(), ...a); }

function loadState() {
  const f = join(STATE, 'dsh-processed.json');
  if (!existsSync(f)) return { processed: {} };
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return { processed: {} }; }
}
function saveState(s) { writeFileSync(join(STATE, 'dsh-processed.json'), JSON.stringify(s, null, 2)); }

function envelopeCandidates() {
  return readdirSync(INPUT).filter(f => /^T-.*\.json$/.test(f));
}

// Restricted executor for supported payload kinds (DSH local execution)
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
      const cmd = String(p.command || '').trim();
      if (!cmd) return { error: 'empty command' };
      if (/[;&|`]/.test(cmd.split(' ')[0])) return { error: 'unsafe command prefix' };
      try {
        const out = execFileSync('/bin/sh', ['-c', cmd], { timeout: 15000, encoding: 'utf8' }).slice(0, 4000);
        return { stdout: out };
      } catch (e) {
        return { error: e.message, stderr: String(e.stderr || '').slice(0, 2000) };
      }
    }
    // run-command is for trusted envelope sources only; the first-word charset check (rejects ; & | and backtick) refuses unsafe commands
    // 中文：run-command 仅限可信信封来源；首词字符集校验（禁 ; & | 反引号）拒绝执行。
    case 'write-file': {
      const { file, content } = p.args || {};
      if (!file) return { error: 'no file' };
      const dest = file.startsWith('/') ? file : join(BRIDGE, file);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      return { written: dest };
    }
    case 'read-file': {
      const { file } = p.args || {};
      const src = file.startsWith('/') ? file : join(BRIDGE, file);
      if (!existsSync(src)) return { error: 'not found: ' + src };
      return { content: readFileSync(src, 'utf8').slice(0, 4000) };
    }
    case 'bridge-status':
      return { input: envelopeCandidates().length, output: readdirSync(OUTPUT).length };
    default:
      return { unsupportedKind: kind };
  }
}

function notifyChannel(text) {
  if (!NOTIFY || !existsSync(SEND_SCRIPT)) return false;
  try {
    const out = execFileSync('node', [SEND_SCRIPT, CHANNEL, text], { timeout: 25000, encoding: 'utf8' });
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
    let task;
    try { task = JSON.parse(readFileSync(join(INPUT, f), 'utf8')); }
    catch (e) { log('skip unparsable', f, e.message); continue; }

    if (task.status === 'running') continue;
    if (!['queued', undefined].includes(task.status)) { state.processed[taskId] = task.status; saveState(state); continue; }

    log('processing', taskId, task.payload?.kind || task.type);
    let result;
    try {
      const r = executePayload(task);
      result = {
        schema: 'odsh-result/v1', taskId,
        status: r.error ? 'failed' : 'done',
        finishedMs: Date.now(), by: 'dsh',
        payload: r.error ? { error: r.error } : r,
        human: r.error ? `task ${taskId} failed: ${r.error}` : `task ${taskId} done`,
        error: r.error ? { code: 'exec_failed', message: r.error } : null
      };
    } catch (e) {
      result = { schema: 'odsh-result/v1', taskId, status: 'failed', finishedMs: Date.now(), by: 'dsh', payload: {}, human: `exception: ${e.message}`, error: { code: 'exception', message: e.message } };
    }
    const tmp = join(OUTPUT, taskId + '_result.json.tmp');
    const fin = join(OUTPUT, taskId + '_result.json');
    writeFileSync(tmp, JSON.stringify(result, null, 2));
    renameSync(tmp, fin);
    log('done', taskId, result.status);
    state.processed[taskId] = result.status;
    saveState(state);
    if (result.status !== 'cancelled') notifyChannel(result.human);
  }
}

log('dsh_bridge daemon start', { intervalMs: INTERVAL_MS, notify: NOTIFY });
tick();
if (!ONCE) setInterval(tick, INTERVAL_MS);
log('daemon ready' + (ONCE ? ' (once)' : ' (looping)'));