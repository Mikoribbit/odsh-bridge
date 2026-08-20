#!/usr/bin/env node
// bridge-daemon.mjs — ODSH 桥守护进程（DSH 侧执行层）
//
// 行为（验证环境跑通，原样保留）：
//   监视桥 Input/ 下的 T-*.json 信封 → 按 payload.kind 执行 → 原子写
//   Output/<taskId>_result.json（.tmp → rename）→ 可选经 oc-send 通知 Discord 频道。
//
// 用法：
//   node bridge-daemon.mjs                     # 常驻循环（默认区间 5000ms）
//   node bridge-daemon.mjs --once              # 单次扫描（脚本/CI 用）
//   node bridge-daemon.mjs --interval-ms 2000  # 自定义扫描间隔
//   node bridge-daemon.mjs --notify            # 完成后经 oc-send 通知频道
//
// 配置（.env，见 .env.example）：
//   BRIDGE_PATH           桥根路径（默认 /root/ODSH-bridge）
//   DISCORD_CHANNEL_ID    通知频道；配合 --notify
//   OC_SEND_SCRIPT        oc-send 脚本路径（默认本目录 oc-send.mjs）
//   BRIDGE_ALLOW_ABS_PATHS  write-file/read-file 是否允许绝对路径（默认 true，⚠️ 安全默认值取 false 更稳）
//   INPUT_DIR/OUTPUT_DIR  覆盖四区路径（本地测试用）
import { readdirSync, readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, basename, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadEnvFile, envStr, envInt } from './env.mjs';

loadEnvFile();

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = envStr('BRIDGE_PATH', '/root/ODSH-bridge');
const INPUT = envStr('INPUT_DIR', join(BRIDGE, 'Input'));
const OUTPUT = envStr('OUTPUT_DIR', join(BRIDGE, 'Output'));
const STATE = join(INPUT, '.state');
const NOTIFY = process.argv.includes('--notify');
const ONCE = process.argv.includes('--once');
const idxi = process.argv.indexOf('--interval-ms');
const INTERVAL_MS = Number(idxi >= 0 ? process.argv[idxi + 1] : envInt('BRIDGE_INTERVAL_MS', 5000)) || 5000;
const CHANNEL = envStr('DISCORD_CHANNEL_ID', '');
const SEND_SCRIPT = envStr('OC_SEND_SCRIPT', join(HERE, 'oc-send.mjs'));
const ALLOW_ABS_PATHS = envStr('BRIDGE_ALLOW_ABS_PATHS', 'false') === 'true';
const RUN_COMMAND_TIMEOUT_MS = envInt('BRIDGE_RUN_TIMEOUT_MS', 15000);

mkdirSync(STATE, { recursive: true });
mkdirSync(INPUT, { recursive: true });
mkdirSync(OUTPUT, { recursive: true });

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---------------------------------------------------------------------------
// 状态（防重复处理）
// ---------------------------------------------------------------------------
function loadState() {
  const f = join(STATE, 'dsh-processed.json');
  if (!existsSync(f)) return { processed: {} };
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return { processed: {} }; }
}
function saveState(s) { writeFileSync(join(STATE, 'dsh-processed.json'), JSON.stringify(s, null, 2)); }

function envelopeCandidates() {
  return readdirSync(INPUT).filter((f) => /^T-.*\.json$/.test(f));
}

// ---------------------------------------------------------------------------
// 执行器（已验证的 payload.kind 全集）
// ---------------------------------------------------------------------------
function resolvePath(p) {
  if (isAbsolute(p)) {
    if (!ALLOW_ABS_PATHS) throw new Error('绝对路径被 BRIDGE_ALLOW_ABS_PATHS=false 禁止: ' + p);
    return p;
  }
  return join(BRIDGE, p); // 相对路径一律落在桥根目录下
}

function executePayload(task) {
  const p = task.payload || {};
  const kind = p.kind || 'echo';
  switch (kind) {
    case 'echo':
      return { echoed: p.text ?? p.command ?? null };

    case 'notify':
      // ack/notification 信封（如 Vivian 确认某事）——记录并确认
      return {
        ack: true,
        from: task.requester || 'unknown',
        text: typeof p.text === 'string' ? p.text.slice(0, 2000)
          : (p.items ? 'items:' + p.items.length + '条' : null),
      };

    case 'run-command': {
      const cmd = String(p.command || '').trim();
      if (!cmd) return { error: 'empty command' };
      if (/[;&|`]/.test(cmd.split(' ')[0])) return { error: 'unsafe command prefix' };
      try {
        const out = execFileSync('/bin/sh', ['-c', cmd], { timeout: RUN_COMMAND_TIMEOUT_MS, encoding: 'utf8' }).slice(0, 4000);
        return { stdout: out };
      } catch (e) {
        return { error: e.message, stderr: String(e.stderr || '').slice(0, 2000) };
      }
    }

    case 'write-file': {
      const { file, content } = p.args || {};
      if (!file) return { error: 'no file' };
      const dest = resolvePath(file);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      return { written: dest };
    }

    case 'read-file': {
      const { file } = p.args || {};
      if (!file) return { error: 'no file' };
      const src = resolvePath(file);
      if (!existsSync(src)) return { error: 'not found: ' + src };
      return { content: readFileSync(src, 'utf8').slice(0, 4000) };
    }

    case 'bridge-status':
      return { input: envelopeCandidates().length, output: readdirSync(OUTPUT).length };

    default:
      return { unsupportedKind: kind };
  }
}

// ---------------------------------------------------------------------------
// 通知（可选）
// ---------------------------------------------------------------------------
function notifyChannel(text) {
  if (!NOTIFY || !CHANNEL) return false;
  if (!existsSync(SEND_SCRIPT)) { log('notify skipped: 找不到 oc-send 脚本', SEND_SCRIPT); return false; }
  try {
    const out = execFileSync('node', [SEND_SCRIPT, text, '--channel', CHANNEL], { timeout: 25000, encoding: 'utf8' });
    log('notify ok', out.split('\n')[0]);
    return true;
  } catch (e) { log('notify failed', e.message.slice(0, 200)); return false; }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
function tick() {
  const state = loadState();
  for (const f of envelopeCandidates()) {
    const taskId = basename(f, '.json');
    if (state.processed[taskId]) continue;

    let task;
    try { task = JSON.parse(readFileSync(join(INPUT, f), 'utf8')); }
    catch (e) { log('skip unparsable', f, e.message); continue; }
    if (!task || typeof task !== 'object' || !task.taskId) { log('skip bad envelope', f); continue; }

    if (task.status === 'running') continue;
    if (!['queued', undefined].includes(task.status)) { state.processed[taskId] = task.status; saveState(state); continue; }

    // 过期检查：spec 里的可选字段 expiresMs（⚠️ 未在验证环境使用过，超时行为属防御实现）
    if (task.expiresMs != null && Date.now() > task.expiresMs) {
      log('expired', taskId);
      writeResult(taskId, { error: 'expired' }, 'failed', '任务已过期（expiresMs 超时）');
      state.processed[taskId] = 'failed';
      saveState(state);
      continue;
    }

    log('processing', taskId, task.payload?.kind || task.type);
    let r, thrown;
    try { r = executePayload(task); }
    catch (e) { thrown = e; r = { error: 'exception: ' + e.message, code: 'exception' }; }
    const status = (thrown || r.error) ? 'failed' : 'done';
    const human = status === 'failed'
      ? `任务 ${taskId} 失败: ${(thrown || r).error}`
      : `任务 ${taskId} 完成`;
    writeResult(taskId, r, status, human);
    log('done', taskId, status);
    state.processed[taskId] = status;
    saveState(state);
    if (status === 'done') notifyChannel(human);
  }
}

function writeResult(taskId, r, status, human) {
  const failed = status === 'failed';
  const payload = failed ? (r.error !== undefined ? { error: r.error } : r) : r;
  const result = {
    schema: 'odsh-result/v1',
    taskId,
    status,
    finishedMs: Date.now(),
    by: 'dsh',
    payload,
    human,
    error: failed ? { code: r.code || 'exec_failed', message: r.error || String(r) } : null,
  };
  const tmp = join(OUTPUT, taskId + '_result.json.tmp');
  const fin = join(OUTPUT, taskId + '_result.json');
  writeFileSync(tmp, JSON.stringify(result, null, 2));
  renameSync(tmp, fin); // 原子写：先 .tmp 后 rename，避免对端读到半截
}

log('bridge-daemon start', { bridge: BRIDGE, intervalMs: INTERVAL_MS, notify: NOTIFY && !!CHANNEL });
tick();
if (!ONCE) setInterval(tick, INTERVAL_MS);
log('daemon ready' + (ONCE ? ' (once)' : ' (looping)'));