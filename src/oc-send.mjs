#!/usr/bin/env node
// oc-send.mjs — send (or read) a message to a Discord channel through the OpenClaw gateway
//
// Usage:
//   node oc-send.mjs "<text>" [--channel <channelId>] [--action send|read] [--raw]
// Ran and passed in the verify environment:
//   node oc-send.mjs "hello Vivian" --channel <channelId>     # DELIVERED
// Send implementation: tools.invoke { name:'message', args:{ action:'send', channel:'discord',
//           to:'channel:<channelId>', text } } — delivery is confirmed when payload.ok === true (seen in the large output).
//
// ⚠️ verify yourself: action:'read' is a companion capability (the action slot was confirmed in the task
//    description), but its args shape was not recorded in the acceptance log — it is built as
//    { action:'read', channel:'discord', to:'channel:<channelId>' } by default; adjust as needed.
//
// Config: .env (OC_*), see .env.example. channelId can also default to DISCORD_CHANNEL_ID.
import { loadEnvFile, envStr, envInt } from './env.mjs';
import { openSession } from './gateway-client.mjs';

loadEnvFile();

function usage() {
  console.error('Usage: node oc-send.mjs "<text>" [--channel <channelId>] [--action send|read] [--raw]');
  process.exit(64);
}

const argv = process.argv.slice(2);
let text = null;
let channelId = envStr('DISCORD_CHANNEL_ID', '');
let action = 'send';
let raw = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--channel') channelId = argv[++i] || '';
  else if (a === '--action') action = argv[++i] || 'send';
  else if (a === '--raw') raw = true;
  else text = a;
}
if (text === null) usage();
if (!channelId) {
  console.error('[!] missing channelId: pass it with --channel, or set DISCORD_CHANNEL_ID.');
  process.exit(64);
}

try {
  const session = await openSession({
    onStatus: (msg) => console.error(msg),
    connectTimeoutMs: envInt('OC_CONNECT_TIMEOUT_MS', 45000),
  });

  const args = action === 'read'
    ? { action: 'read', channel: 'discord', to: 'channel:' + channelId } // ⚠️ the 'read' args shape needs verifying yourself
    : { action: 'send', channel: 'discord', to: 'channel:' + channelId, text };
  const payload = await session.request('tools.invoke', { name: 'message', args }, {
    timeoutMs: envInt('OC_REPLY_TIMEOUT_MS', 20000),
  });
  session.close();

  if (raw) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
  // Delivery verdict (verify environment: reply.ok===true and reply.payload.ok===true together mean DELIVERED)
  const delivered = payload?.ok === true;
  const detail = payload?.output?.delivered || payload?.output?.deliveryStatus || '';
  if (delivered) {
    console.log(detail ? `DELIVERED (${detail})` : 'DELIVERED');
    process.exit(0);
  }
  console.log('FAILED payload=' + JSON.stringify(payload).slice(0, 500));
  process.exit(2);
} catch (e) {
  if (e.code === 'PAIRING_REQUIRED') {
    console.error('[!] ' + e.message);
    process.exit(3);
  }
  console.error('[!] ' + e.message);
  process.exit(1);
}