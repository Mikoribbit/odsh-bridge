#!/usr/bin/env node
// oc-invoke.mjs — 调用 OpenClaw 网关任意方法（通用）
//
// 用法：
//   node oc-invoke.mjs <method> [paramsJson] [--timeout N] [--raw]
// 示例（验证环境跑通过）：
//   node oc-invoke.mjs agents.list '{}'
//   node oc-invoke.mjs doctor.memory.status '{}'
//   node oc-invoke.mjs status '{}'
//   node oc-invoke.mjs crestodian.chat '{"message":"hello"}'
//   node oc-invoke.mjs tools.invoke '{"name":"message","args":{"action":"send","channel":"discord","to":"channel:<channelId>","text":"hi"}}'
//
// 配置：.env（OC_HOST / OC_PORT / OC_TOKEN / OC_ORIGIN / OC_KEYS），见 .env.example
import { loadEnvFile, envStr, envInt } from './env.mjs';
import { openSession } from './gateway-client.mjs';

loadEnvFile();

function usage() {
  console.error('用法: node oc-invoke.mjs <method> [paramsJson] [--timeout N] [--raw]');
  console.error('示例: node oc-invoke.mjs agents.list \'{}\'');
  process.exit(64);
}

const argv = process.argv.slice(2);
const method = argv[0];
if (!method) usage();

let paramsRaw = null;
let timeoutMs;
let raw = false;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--raw') raw = true;
  else if (a === '--timeout') timeoutMs = Number(argv[++i]);
  else paramsRaw = a;
}
let params = {};
if (paramsRaw) {
  try { params = JSON.parse(paramsRaw); }
  catch { console.error('params 不是合法 JSON: ' + paramsRaw); process.exit(64); }
}

try {
  const session = await openSession({
    onStatus: (msg) => console.error(msg),
    connectTimeoutMs: envInt('OC_CONNECT_TIMEOUT_MS', 45000),
  });
  const payload = await session.request(method, params, {
    timeoutMs: timeoutMs || envInt('OC_REPLY_TIMEOUT_MS', 20000),
  });
  if (raw) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    console.log('[reply] ' + JSON.stringify(payload, null, 2));
  }
  session.close();
  process.exit(0);
} catch (e) {
  if (e.code === 'PAIRING_REQUIRED') {
    console.error('[!] ' + e.message);
    console.error('    处理：在 OpenClaw Control UI 批准该设备后重试（或先运行 node oc-client.mjs 等待批准）。');
    process.exit(3);
  }
  console.error('[!] ' + e.message);
  if (e.code) console.error('    code=' + e.code);
  if (/ECONNREFUSED|ENOTFOUND/.test(e.message || '')) {
    console.error('    检查：是否与 openclaw 同在 agent-mesh 网络？OC_HOST 应使用容器名 DNS（默认 openclaw），而非 IP。');
  }
  process.exit(1);
}