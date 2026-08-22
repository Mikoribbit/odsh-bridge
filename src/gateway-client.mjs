#!/usr/bin/env node
// gateway-client.mjs — ODSH Bridge shared gateway client module (used by all three CLIs)
//
// Origin: extracted verbatim from the handshake/connection logic of the `oc_client.mjs` that was
// verified in the real environment (2026-08, docker agent-mesh, DeepSeek Harness ↔ OpenClaw);
// behavior is preserved as-is:
//   1. Minimal WebSocket-over-net client (zero npm dependencies)
//   2. Ed25519 device identity persistence (JWK stored in bridge DSH-Workspace, generated once, reused later)
//   3. Pairing handshake: HTTP Upgrade (explicit Origin) → connect.challenge(nonce)
//      → sign the v2 claim string with Ed25519 → connect → hello-ok
//   4. Request-response frames (JSON-RPC style) via request() / send()
//
// Environment variables: see .env.example (OC_HOST / OC_PORT / OC_TOKEN / OC_ORIGIN / OC_KEYS etc.)
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { webcrypto } = crypto;
const subtle = webcrypto.subtle;
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Protocol constants (from the verified environment, do not change)
// ---------------------------------------------------------------------------
export const SUB_PROTOCOL = 'json';                 // Sec-WebSocket-Protocol
export const CONNECT_METHOD = 'connect';
// Role and scopes granted after successful pairing (the operator permissions approved in the OpenClaw Control UI)
export const ROLE = 'operator';
export const SCOPES = ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'];
// Client identity description (this shape emulated the Control UI in the verify environment)
export const CLIENT = {
  id: 'openclaw-control-ui',
  version: 'control-ui',
  platform: 'web',
  mode: 'webchat',
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');

/** base64url-decode a string into a Buffer */
function b64urlToBuf(s) {
  return Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, ''), 'base64');
}

/**
 * Safely close a net Socket (compat across the different node:net API shapes):
 * the newer ESM `node:net` Socket may not have `.close` (superseded by destroy/resetAndDestroy),
 * so try `.close()` → fall back to `.destroy()` → fall back to `.resetAndDestroy()`.
 * — 中文：新版 node:net 的 Socket 可能没有 .close()，统一用 .close() → .destroy() → .resetAndDestroy() 兜底。
 */
function safeClose(sock) {
  if (!sock) return;
  try { if (typeof sock.close === 'function') return sock.close(); } catch { /* fallthrough */ }
  try { if (typeof sock.destroy === 'function') return sock.destroy(); } catch { /* fallthrough */ }
  try { if (typeof sock.resetAndDestroy === 'function') return sock.resetAndDestroy(); } catch { /* ignore */ }
}

/**
 * deviceId = hex(SHA-256(Ed25519 public key x bytes)) — this was the device fingerprint in the verify environment.
 * If the public key is unchanged the deviceId stays constant, so a device approved once stays approved forever.
 * — 中文：公钥不变 → deviceId 恒定 → 首次配对批准后永久有效。
 */
async function computeDeviceId(jwk) {
  const xBytes = b64urlToBuf(jwk.x);
  const digest = await subtle.digest('SHA-256', xBytes);
  return hex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// WebSocket (minimal implementation: text frames + close/ping/pong control frames)
// ---------------------------------------------------------------------------
function wsSendFrame(sock, opcode, payloadBuf) {
  const payload = Buffer.from(payloadBuf);
  const mk = crypto.randomBytes(4);   // per-frame random mask (RFC 6455 §8.1)
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= mk[i % 4]; // XOR-mask the payload
  const len = out.length;
  let hdr;
  if (len <= 125) hdr = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len <= 65535) hdr = Buffer.from([0x80 | opcode, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
  else {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(len));
    hdr = Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), b]);
  }
  sock.write(Buffer.concat([hdr, Buffer.from(mk), out]));
}

/** Send a text message frame (opcode 0x1, FIN=1) */
function wsSendText(sock, text) {
  wsSendFrame(sock, 0x1, Buffer.from(text, 'utf8'));
}

/** Send a pong (opcode 0xA) to answer the peer's ping — a robustness enhancement, ⚠️ whether the gateway sends ping was not confirmed in the verify environment */
function wsPong(sock, payload) {
  wsSendFrame(sock, 0xA, payload);
}

async function ensureOpen(sock) {
  for (let i = 0; i < 80 && sock.readyState !== 'open' && sock.readyState !== 'closed'; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return sock.readyState === 'open';
}

async function readN(sock, n, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let buf = Buffer.alloc(0);
  while (buf.length < n && Date.now() < deadline) {
    try {
      const r = await sock.read(n - buf.length);
      if (r && r.length) buf = Buffer.concat([buf, Buffer.from(r)]);
    } catch { /* ignore transient read errors */ }
    if (sock.readyState === 'closed') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return buf;
}

async function readHttpResp(sock) {
  let buf = Buffer.alloc(0);
  const deadline = Date.now() + 3000;
  while (!buf.toString('utf8').includes('\r\n\r\n') && Date.now() < deadline) {
    try {
      const r = await sock.read(1);
      if (r && r.length) buf = Buffer.concat([buf, Buffer.from(r)]);
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  return buf.toString('utf8');
}

async function readFrame(sock) {
  const b = await readN(sock, 2);
  if (b.length < 2) return null;
  const b0 = b[0], b1 = b[1];
  const op = b0 & 0x0f;
  let len = b1 & 0x7f;
  if (len === 126) {
    const e = await readN(sock, 2);
    len = (e[0] << 8) | e[1];
  } else if (len === 127) {
    const e = await readN(sock, 8);
    len = Number([...e].reduce((a, x) => (a << 8n) | BigInt(x), 0n));
  }
  if (b1 & 0x80) await readN(sock, 4);            // server frames should not be masked; skip defensively
  const payload = op === 8 ? Buffer.alloc(0) : await readN(sock, len);
  return { op, len, payload };
}

// ---------------------------------------------------------------------------
// Device identity (JWK persistence)
// ---------------------------------------------------------------------------
/**
 * Read or create the device identity.
 * @param {string} keyFile  JWK file path (default DSH-Workspace/openclaw-device.json)
 * @returns {Promise<{jwk: object, publicKeyStr: string, deviceId: string}>}
 */
export async function loadIdentity(keyFile) {
  if (fs.existsSync(keyFile)) {
    const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    if (j.version === 1 && j.jwk?.kty === 'OKP' && j.jwk?.crv === 'Ed25519') {
      const deviceId = await computeDeviceId(j.jwk);
      return { jwk: j.jwk, publicKeyStr: j.jwk.x, deviceId };
    }
    throw new Error('bad identity file (expected {version:1, jwk:{kty:"OKP",crv:"Ed25519"}}): ' + keyFile);
  }

  // First run: generate an Ed25519 key pair and write it to the bridge's DSH-Workspace (the private key never leaves the DSH container)
  const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwkFull = await subtle.exportKey('jwk', kp.privateKey);
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: jwkFull.x, d: jwkFull.d };
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, JSON.stringify({ version: 1, createdAtMs: Date.now(), jwk }, null, 2), { mode: 0o600 });
  const deviceId = await computeDeviceId(jwk);
  return { jwk, publicKeyStr: jwk.x, deviceId };
}

// ---------------------------------------------------------------------------
// Pairing/connection: openSession()
// ---------------------------------------------------------------------------
/**
 * Error returned by the server (the error field {code, message} when ok is false). Codes such as PAIRING_REQUIRED.
 */
export class GatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
  }
}

/**
 * Open an already-paired long-lived connection.
 * Flow (verified in the verify environment):
 *   HTTP Upgrade (explicit Origin) → 101 → receive connect.challenge(nonce)
 *   → sign the v2 claim with Ed25519 → send connect → receive {res, ok:true, payload:{type:"hello-ok"}} → ready
 *
 * @param {object} o
 * @param {string} [o.host]            default openclaw (DNS container name, not IP)
 * @param {number} [o.port]            default 18789
 * @param {string} [o.token]           required: OpenClaw openclaw.json → gateway.auth.token
 * @param {string} [o.origin]          default `http://${host}:${port}`; must be allowed by the gateway's allowedOrigins
 * @param {string} [o.keyFile]         default `$BRIDGE_PATH/DSH-Workspace/openclaw-device.json`
 * @param {number} [o.connectTimeoutMs] default 45000
 * @param {(msg: string) => void} [o.onStatus] progress callback (used by the CLIs to print logs)
 * @returns {Promise<object>} session
 */
export async function openSession(o = {}) {
  const host = o.host || process.env.OC_HOST || 'openclaw';
  const port = Number(o.port ?? process.env.OC_PORT ?? '18789');
  let token = o.token ?? process.env.OC_TOKEN ?? '';
  // SECURITY: never ship the .env.example placeholder to a real gateway.
  if (!token) { throw new Error('OC_TOKEN not set - put gateway.auth.token into .env (see .env.example)'); }
  if (token === 'REPLACE_WITH_GATEWAY_TOKEN' || token === 'your-gateway-token') { throw new Error('OC_TOKEN is still the placeholder - set a real gateway token'); }
  const bridge = o.bridge || process.env.BRIDGE_PATH || '/root/ODSH-bridge';
  const keyFile = o.keyFile || process.env.OC_KEYS || path.join(bridge, 'DSH-Workspace', 'openclaw-device.json');
  const origin = o.origin || process.env.OC_ORIGIN || `http://${host}:${port}`;
  const connectTimeoutMs = o.connectTimeoutMs || Number(process.env.OC_CONNECT_TIMEOUT_MS || '45000');
  const log = o.onStatus || (() => {});
  if (!token) {
    throw new Error('OC_TOKEN not set. Set it in .env to the value of OpenClaw openclaw.json → gateway.auth.token (the release ships with no real token).');
  }

  const identity = await loadIdentity(keyFile);
  log('[i] deviceId = ' + identity.deviceId);
  log('[i] keyfile  = ' + keyFile + ' (persistent identity)');
  log('[i] target   = ' + host + ':' + port + ' (DNS container name)   origin = ' + origin);

  // 1) TCP → WS upgrade (with an explicit Origin header)
  const sock = await new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once('error', reject);
    s.setTimeout(15000);
    ensureOpen(s).then((ok) => {
      if (!ok) { reject(new Error('socket did not open within the timeout: ' + host + ':' + port)); return; }
      s.removeListener('error', reject);
      resolve(s);
    });
  });

  const key = crypto.randomBytes(16).toString('base64');
  const upgrade = [
    'GET / HTTP/1.1',
    `Host: ${host}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Protocol: ${SUB_PROTOCOL}`,
    `Origin: ${origin}`,   // ⚠️ the gateway validates against the origin allowlist (gateway.controlUi.allowedOrigins)
    '', '',
  ].join('\r\n');
  sock.write(Buffer.from(upgrade));
  const httpResp = await readHttpResp(sock);
  log('[<] handshake: ' + (httpResp.split('\r\n')[0] || '(no status line)'));
    const statusLine = httpResp.split('\r\n')[0] || '';
  // SECURITY: verify the exact status line AND the Sec-WebSocket-Accept header (derived from our
  // nonce key + RFC 6455 GUID). An impostor can't forge this without the key exchange.
  const expectAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const statusOk = /^HTTP\/1\.1 101\s/.test(statusLine);
  const gotAccept = (httpResp.match(/^sec-websocket-accept:\s*(.+)$/im) || [])[1]?.trim();
  log('[<] handshake: ' + statusLine);
  if (!statusOk || !gotAccept || gotAccept !== expectAccept) {
    safeClose(sock);
    throw new Error('WS upgrade rejected or fingerprint mismatch (status=' + statusLine + ' accept_expected=' + expectAccept + ' accept_got=' + gotAccept + ')');
  }

  // 2) challenge → signed connect
  const signKey = await subtle.importKey('jwk', identity.jwk, { name: 'Ed25519' }, false, ['sign']);
  const deadline = Date.now() + connectTimeoutMs;
  let sentConnect = false;
  let hello = null;

  while (Date.now() < deadline) {
    const f = await readFrame(sock);
    if (!f) break;
    if (f.op === 8) {
      safeClose(sock);
      throw new Error('received a close frame during the connect phase: ' + f.payload.toString('utf8'));
    }
    if (f.op === 9) { wsPong(sock, f.payload); continue; }
    let m;
    try { m = JSON.parse(f.payload.toString('utf8')); }
    catch { log('[bad frame]', f.payload.toString('utf8').slice(0, 120)); continue; }

    if (m.type === 'event' && m.event === 'connect.challenge') {
      const nonce = m.payload.nonce;
      const signedAt = Date.now(); // single timestamp: the claim signature and device.signedAt MUST share this same value, otherwise the gateway fails signature verification (device signature invalid)
      // 中文：claim 的 signedAt 必须与 device.signedAt 同值（只取一次 Date.now()），否则网关验签失败
      // claim string (verify-environment format, do not reorder fields):
      //   v2|<deviceId>|<clientId>|<clientMode>|<role>|<scopes(comma-joined)>|<signedAtMs>|<token>|<nonce>
      const claim = ['v2', identity.deviceId, CLIENT.id, 'webchat', ROLE,
        SCOPES.join(','), String(signedAt), token, nonce].join('|');
      const sig = await subtle.sign({ name: 'Ed25519' }, signKey, enc.encode(claim));
      const device = {
        id: identity.deviceId,
        publicKey: identity.publicKeyStr,
        signature: b64url(new Uint8Array(sig)),
        signedAt,
        nonce,
      };
      const params = {
        minProtocol: 4, maxProtocol: 4,
        client: { ...CLIENT, instanceId: 'dsh-' + Date.now() },
        role: ROLE, scopes: SCOPES,
        device,
        caps: ['tool-events'],
        auth: { token },
        userAgent: 'DSH', locale: 'en',
      };
      wsSendText(sock, JSON.stringify({ type: 'req', id: crypto.randomUUID(), method: CONNECT_METHOD, params }));
      sentConnect = true;
      log('[>] sent signed connect; deviceId=' + identity.deviceId);
    } else if (m.type === 'res' && m.ok && m.payload?.type === 'hello-ok') {
      hello = m.payload;
      log('[CONNECTED] auth.hello protocol=' + hello.protocol);
      break;
    } else if (m.type === 'res' && !m.ok) {
      const err = m.error || {};
      safeClose(sock);
      if (err.code === 'PAIRING_REQUIRED') {
        throw new GatewayError('PAIRING_REQUIRED', 'Device not approved: approve deviceId=' + identity.deviceId + ' in the OpenClaw Control UI');
      }
      throw new GatewayError(err.code || 'CONNECT_FAILED', err.message || JSON.stringify(m.payload || err).slice(0, 400));
    }
  }
  if (!sentConnect) {
    safeClose(sock);
    throw new Error('did not receive connect.challenge (gateway did not send a nonce? was the origin allowed?)');
  }
  if (!hello) {
    safeClose(sock);
    throw new Error('connect timed out (' + connectTimeoutMs + 'ms): the gateway did not return hello-ok');
  }

  // 3) Ready: enter the request-response loop
  const pending = new Map();
  let closed = false;
  const onCloseCallbacks = [];

  (async function recvLoop() {
    while (!closed) {
      let f;
      try { f = await readFrame(sock); } catch { break; }
      if (!f) break;
      if (f.op === 8) break;                 // close
      if (f.op === 9) { wsPong(sock, f.payload); continue; }
      if (f.op === 10) continue;
      let m;
      try { m = JSON.parse(f.payload.toString('utf8')); }
      catch { continue; }
      if (m.type === 'res' && m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.payload ?? {});
        else p.reject(new GatewayError(m.error?.code || 'REQUEST_FAILED', m.error?.message || JSON.stringify(m).slice(0, 400)));
      }
      // Other frames (events/notifications) currently have no subscribers, so they are ignored. Event subscription could be extended here.
      // 中文：其余 event/notification 帧当前无订阅者，忽略；可在此扩展事件订阅。
    }
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
    pending.clear();
    try { safeClose(sock); } catch { /* ignore */ }
    for (const cb of onCloseCallbacks) { try { cb(); } catch { /* ignore */ } }
  })();

  return {
    deviceId: identity.deviceId,
    hello,
    origin,

    /** Request-response: send {type:'req', id, method, params}, wait for the matching {type:'res', id} */
    request(method, params = {}, { timeoutMs } = {}) {
      const id = crypto.randomUUID();
      const wait = timeoutMs || Number(process.env.OC_REPLY_TIMEOUT_MS || '20000');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('request timed out (' + wait + 'ms): ' + method));
        }, wait);
        pending.set(id, { resolve, reject, timer });
        wsSendText(sock, JSON.stringify({ type: 'req', id, method, params }));
      });
    },

    /** One-way send (does not wait for a matching id) */
    send(method, params = {}) {
      const id = crypto.randomUUID();
      wsSendText(sock, JSON.stringify({ type: 'req', id, method, params }));
      return id;
    },

    onClose(cb) { onCloseCallbacks.push(cb); },

    get closed() { return closed; },

    close() {
      if (closed) return;
      try { sock.write(Buffer.from([0x88, 0x00])); } catch { /* ignore */ }
      try { safeClose(sock); } catch { /* ignore */ }
    },
  };
}

// Small helpers reused by the CLIs
export { b64url, hex };