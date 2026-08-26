#!/usr/bin/env node
// dshtrigger.mjs — ODSH Bridge 一体化守护 / 触发 / 状态入口
//
// 用法:
//   node dshtrigger.mjs daemon [--interval-ms 5000] [--notify]   # 常驻守护 + 崩溃自愈 (supervisor)
//   node dshtrigger.mjs send [--kind X] [--text ".."] [--timeout 60000] [--notify]  # 投任务信封 & 等结果
//   node dshtrigger.mjs status   # 打印桥当前状态快照
//   node dshtrigger.mjs once     # 单次扫描处理(不常驻)
//
// 自定位的守护脚本:
//   1) env ODSH_DAEMON          (显式指定)
//   2) 同目录 bridge-daemon.mjs (发行版 src/)
//   3) 同目录 dsh_bridge.mjs    (运行侧 tools/)
//   通知脚本类似: ODSH_SEND / oc-send.mjs / oc_send.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
const __dirname = dirname(fileURLToPath(import.meta.url));

const BRIDGE   = process.env.BRIDGE_PATH || '/root/ODSH-bridge';
const INPUT    = join(BRIDGE, 'Input');
const OUTPUT   = join(BRIDGE, 'Output');
const STATE    = join(INPUT, '.state');
const STATE_F  = join(STATE, 'dsh-processed.json');
const pick = (...paths) => { for (const p of paths) if (p && existsSync(p)) return p; return paths[paths.length-1] || null; };
const DAEMON  = process.env.ODSH_DAEMON || pick(join(__dirname,'bridge-daemon.mjs'), join(__dirname,'dsh_bridge.mjs'));
const SENDS   = process.env.ODSH_SEND   || pick(join(__dirname,'oc-send.mjs'),    join(__dirname,'oc_send.mjs'));
const OCCUA   = process.env.ODSH_CUA    || pick(join(__dirname,'oc-cua.mjs'),     join(__dirname,'oc_cua.mjs'));
const CHANNEL = process.env.OC_CHANNEL || process.env.DISCORD_CHANNEL_ID || '';

mkdirSync(STATE, { recursive: true });
const MODE = process.argv[2] || 'status';
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i+1] ?? d : d; };
const flag = (f) => process.argv.includes(f);
const NOTIFY = flag('--notify');
function log(...a){ console.log(new Date().toISOString(), ...a); }
function j(p){ try { return JSON.parse(readFileSync(p,'utf8')); } catch { return null; } }

function statusObj(){
  const s = j(STATE_F) || { processed:{} };
  return {
    schema: 'odsh-status/v1', at: new Date().toISOString(),
    inputTasks: readdirSync(INPUT).filter(f=>/^T-.*\.json$/.test(f)),
    outputResults: readdirSync(OUTPUT).filter(f=>/_result\.json$/.test(f)),
    processed: Object.keys(s.processed||{}).length,
    scripts: { daemon: !!DAEMON && existsSync(DAEMON), send: !!SENDS && existsSync(SENDS), cua: !!OCCUA && existsSync(OCCUA) },
  };
}
async function triggerSend(){
  const kind = arg('--kind','echo');
  const text = arg('--text','');
  const timeout = Number(arg('--timeout','60000')) || 60000;
  const taskId = 'T-' + new Date().toISOString().replace(/\D/g,'').slice(0,14) + '-trigger';
  const task = { schema:'odsh-task/v1', taskId, id:taskId, type:'task', status:'queued', requester:'dsh-trigger', target: arg('--to','openclaw'), createdMs: Date.now(), payload:{ kind, text, from:'dsh-trigger' } };
  const path = join(INPUT, taskId + '.json');
  writeFileSync(path + '.tmp', JSON.stringify(task, null, 2));
  try { renameSync(path+'.tmp', path); } catch { unlinkSync(path+'.tmp'); writeFileSync(path, JSON.stringify(task,null,2)); }
  log('envelope written', path);
  const resultPath = join(OUTPUT, taskId + '_result.json');
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (existsSync(resultPath)) {
      const r = j(resultPath);
      log('result', JSON.stringify(r||{}).slice(0,400));
      if (NOTIFY && r && r.human && SENDS) { try { execFileSync(process.execPath,[SENDS,CHANNEL,r.human],{timeout:25000,encoding:'utf8'}); } catch{} }
      return r;
    }
    await new Promise(res=>setTimeout(res,500));
  }
  return { error:'timeout', waitedMs: timeout, resultPath };
}
// ---- dispatch ----
if (MODE === 'daemon') {
  if (!DAEMON || !existsSync(DAEMON)) { console.error('daemon script not found; set ODSH_DAEMON or place bridge-daemon.mjs beside this file'); process.exit(2); }
  const iv = Number(arg('--interval-ms','5000')) || 5000;
  log('daemon supervisor start (daemon='+DAEMON+')');
  let child = null, stopping = false;
  const start = () => {
    const args = [DAEMON, '--interval-ms', String(iv)];
    if (flag('--notify')) args.push('--notify');
    log('child start', args.join(' '));
    child = spawn(process.execPath, args, { stdio:'inherit' });
    child.on('exit', (code, sig) => { log('child exited', code, sig); if (!stopping) { log('restart in 2s'); setTimeout(start, 2000); } });
  };
  const stop = () => { stopping = true; if (child) child.kill('SIGTERM'); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  start();
  await new Promise(()=>{});
} else if (MODE === 'send') {
  console.log(JSON.stringify(await triggerSend(), null, 2)); process.exit(0);
} else if (MODE === 'status') {
  console.log(JSON.stringify(statusObj(), null, 2)); process.exit(0);
} else if (MODE === 'once') {
  if (!DAEMON || !existsSync(DAEMON)) { console.error('daemon script not found'); process.exit(2); }
  try { log((execFileSync(process.execPath,[DAEMON,'--once'],{timeout:30000,encoding:'utf8'})).trim()); } catch(e){ console.error('once err', e.message); }
  process.exit(0);
} else {
  console.error('unknown mode', MODE); process.exit(2);
}
