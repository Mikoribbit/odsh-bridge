#!/usr/bin/env node
// oc-invoke.mjs — invoke any OpenClaw gateway method (generic)
//
// Usage:
//   node oc-invoke.mjs <method> [paramsJson] [--timeout N] [--raw]
// Examples (each ran and passed in the verify environment):
//   node oc-invoke.mjs agents.list '{}'
//   node oc-invoke.mjs doctor.memory.status '{}'
//   node oc-invoke.mjs status '{}'
//   node oc-invoke.mjs crestodian.chat '{"message":"hello"}'
//   node oc-invoke.mjs tools.invoke '{"name":"message","args":{"action":"send","channel":"discord","to":"channel:<channelId>","text":"hi"}}'
//
// Config: .env (OC_HOST / OC_PORT / OC_TOKEN / OC_ORIGIN / OC_KEYS), see .env.example
import { loadEnvFile, envStr, envInt } from './env.mjs';
import { openSession } from './gateway-client.mjs';

loadEnvFile();

function usage() {
  console.error('Usage: node oc-invoke.mjs <method> [paramsJson] [--timeout N] [--raw]');
  console.error('Example: node oc-invoke.mjs agents.list \'{}\'');
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
  catch { console.error('params is not valid JSON: ' + paramsRaw); process.exit(64); }
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
    console.error('    Fix: approve the device in the OpenClaw Control UI and retry (or run node oc-client.mjs first to wait for approval).');
    process.exit(3);
  }
  console.error('[!] ' + e.message);
  if (e.code) console.error('    code=' + e.code);
  if (/ECONNREFUSED|ENOTFOUND/.test(e.message || '')) {
    console.error('    Check: is this container on the same agent-mesh network as openclaw? OC_HOST should use container-name DNS (default openclaw), not an IP.');
  }
  process.exit(1);
}