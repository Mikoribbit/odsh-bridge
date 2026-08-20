#!/usr/bin/env node
// oc-send.mjs — 通过 OpenClaw 网关向 Discord 频道发送（或读取）一条消息
//
// 用法：
//   node oc-send.mjs "<text>" [--channel <channelId>] [--action send|read] [--raw]
// 验证环境跑通：
//   node oc-send.mjs "你好 Vivian" --channel <channelId>     # DELIVERED
// 发送实现：tools.invoke { name:'message', args:{ action:'send', channel:'discord',
//           to:'channel:<channelId>', text } } —— 已在大号输出中确认 payload.ok === true 即投递成功。
//
// ⚠️ 需自行验证：action:'read' 是配套能力（任务描述确认过动作位），但其 args 形状未在验收日志中记录，
//    默认按 { action:'read', channel:'discord', to:'channel:<channelId>' } 构造，按需调整。
//
// 配置：.env（OC_*），见 .env.example。channelId 也可用 DISCORD_CHANNEL_ID 默认。
import { loadEnvFile, envStr, envInt } from './env.mjs';
import { openSession } from './gateway-client.mjs';

loadEnvFile();

function usage() {
  console.error('用法: node oc-send.mjs "<text>" [--channel <channelId>] [--action send|read] [--raw]');
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
  console.error('[!] 缺少 channelId：用 --channel 传入，或设置 DISCORD_CHANNEL_ID。');
  process.exit(64);
}

try {
  const session = await openSession({
    onStatus: (msg) => console.error(msg),
    connectTimeoutMs: envInt('OC_CONNECT_TIMEOUT_MS', 45000),
  });

  const args = action === 'read'
    ? { action: 'read', channel: 'discord', to: 'channel:' + channelId } // ⚠️ read 的 args 形状需自行验证
    : { action: 'send', channel: 'discord', to: 'channel:' + channelId, text };
  const payload = await session.request('tools.invoke', { name: 'message', args }, {
    timeoutMs: envInt('OC_REPLY_TIMEOUT_MS', 20000),
  });
  session.close();

  if (raw) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
  // 投递结果判定（验证环境：reply.ok===true 且 reply.payload.ok===true 才算 DELIVERED）
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