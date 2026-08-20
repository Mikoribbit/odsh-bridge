#!/usr/bin/env node
// oc-client.mjs — long-lived connection / pairing-wait client (the verify environment used it to wait for Control UI approval)
//
// Usage:
//   node oc-client.mjs connect            # if not paired, keeps retrying every OC_RETRY_MS; holds the session once approved
//   node oc-client.mjs node <method> [paramsJson]   # connect once, send one request, print the reply, exit
//
// Difference from oc-invoke: oc-client targets the "keep a session / wait for approval" scenario and auto-retries on failure;
// oc-invoke targets one-shot script calls and fails fast with a hint.
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
      console.log('[oc-client] session ready; holding the long-lived connection (mirrors the verify environment: an approved device connecting is considered a success).');
      console.log('[oc-client] hello-ok -> ' + JSON.stringify(session.hello).slice(0, 400));
      // Hold the session: auto-reconnect on disconnect (DNS addressing, unaffected by container restart / IP swap)
      await new Promise((resolve) => {
        session.onClose(() => {
          console.log('[oc-client] session closed; reconnecting in ' + (retryMs / 1000) + 's...');
          resolve();
        });
      });
      session = null;
      await new Promise((r) => setTimeout(r, retryMs));
    } catch (e) {
      if (e instanceof GatewayError && e.code === 'PAIRING_REQUIRED') {
        console.log('[oc-client] ' + e.message);
        console.log('[oc-client]  -> it connects automatically once the deviceId is approved in the OpenClaw Control UI (retrying every ' + (retryMs / 1000) + 's).');
      } else {
        console.log('[oc-client] connection failed: ' + e.message);
      }
      try { session?.close(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}

async function sendNodeRequest() {
  const method = process.argv[3];
  if (!method) {
    console.error('Usage: node oc-client.mjs node <method> [paramsJson]');
    process.exit(64);
  }
  let params = {};
  const raw = process.argv[4];
  if (raw) {
    try { params = JSON.parse(raw); }
    catch { console.error('params is not valid JSON'); process.exit(64); }
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