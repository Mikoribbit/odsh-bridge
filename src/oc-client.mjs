#!/usr/bin/env node
// oc-client.mjs — 长连接/配对等待客户端（验证环境用它等待 Control UI 批准）
//
// 用法：
//   node oc-client.mjs connect            # 若未配对则每 OC_RETRY_MS 重连等待；获批后保持会话
//   node oc-client.mjs node <method> [paramsJson]   # 连接一次，发一个请求，打印回复后退出
//
// 与 oc-invoke 的区别：oc-client 面向“保持会话/等待批准”场景，失败自动重试；
// oc-invoke 面向一次性脚本调用，失败快速失败并给出提示。
import { loadEnvFile, envInt, envStr } from './env.mjs';
import { openSession, GatewayError } from './gateway-client.mjs';

loadEnvFile();

const mode = process.argv[2] || 'connect';
const retryMs = envInt('OC_RETRY_MS', 8000);

async function waitAndConnect() {
  console.log('[oc-client] connecting to ' + envStr('OC_HOST', 'openclaw') + ':' + envStr('OC_PORT', '18789') + ' ...');
  while (true) {
    let session = null;
    try {
      session = await openSession({ onStatus: (m) => console.log(m) });
      console.log('[oc-client] 会话就绪，保持长连（复现环境行为：已批准设备连上即算打通）。');
      console.log('[oc-client] hello-ok -> ' + JSON.stringify(session.hello).slice(0, 400));
      // 保持会话：断开后自动重连（DNS 地址，容器重启/IP 对调不影响）
      await new Promise((resolve) => {
        session.onClose(() => {
          console.log('[oc-client] 会话关闭，' + (retryMs / 1000) + 's 后重连...');
          resolve();
        });
      });
      session = null;
      await new Promise((r) => setTimeout(r, retryMs));
    } catch (e) {
      if (e instanceof GatewayError && e.code === 'PAIRING_REQUIRED') {
        console.log('[oc-client] ' + e.message);
        console.log('[oc-client]  -> 在 OpenClaw Control UI 批准 deviceId 后会自动连上（每 ' + (retryMs / 1000) + 's 重试）。');
      } else {
        console.log('[oc-client] 连接失败: ' + e.message);
      }
      try { session?.close(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}

async function sendNodeRequest() {
  const method = process.argv[3];
  if (!method) {
    console.error('用法: node oc-client.mjs node <method> [paramsJson]');
    process.exit(64);
  }
  let params = {};
  const raw = process.argv[4];
  if (raw) {
    try { params = JSON.parse(raw); }
    catch { console.error('params 不是合法 JSON'); process.exit(64); }
  }
  try {
    const session = await openSession({ onStatus: (m) => console.log(m) });
    const payload = await session.request(method, params);
    console.log('[reply] ' + JSON.stringify(payload, null, 2));
    session.close();
    process.exit(0);
  } catch (e) {
    console.error('[!] ' + e.message);
    process.exit(e.code === 'PAIRING_REQUIRED' ? 3 : 1);
  }
}

if (mode === 'node') await sendNodeRequest();
else await waitAndConnect();