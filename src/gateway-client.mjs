#!/usr/bin/env node
// gateway-client.mjs — ODSH Bridge 公共网关客户端模块（三个 CLI 共用）
//
// 来源：真实环境（2026-08，docker agent-mesh，DeepSeek Harness ↔ OpenClaw/Vivian）
// 验证过的 `oc_client.mjs` 握手/连接逻辑抽取而成，功能原样保留：
//   1. 最小 WebSocket-over-net 客户端（零 npm 依赖）
//   2. Ed25519 设备身份持久化（JWK 存桥 DSH-Workspace，首次生成、后续复用）
//   3. 配对握手：HTTP Upgrade(显式 Origin) → connect.challenge(nonce)
//      → 对 v2 claim 串做 Ed25519 签名 → connect → hello-ok
//   4. 请求-响应帧（JSON-RPC 风格）request() / send()
//
// 环境变量：见 .env.example（OC_HOST / OC_PORT / OC_TOKEN / OC_ORIGIN / OC_KEYS 等）
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { webcrypto } = crypto;
const subtle = webcrypto.subtle;
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// 协议常量（来自验证环境，勿改）
// ---------------------------------------------------------------------------
export const SUB_PROTOCOL = 'json';                 // Sec-WebSocket-Protocol
export const CONNECT_METHOD = 'connect';
// 配对成功后授予的角色与 scope（OpenClaw Control UI 批准的 operator 权限）
export const ROLE = 'operator';
export const SCOPES = ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'];
// 客户端身份描述（验证环境中即用此形态模拟 Control UI）
export const CLIENT = {
  id: 'openclaw-control-ui',
  version: 'control-ui',
  platform: 'web',
  mode: 'webchat',
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');

/** base64url 解码为 Buffer */
function b64urlToBuf(s) {
  return Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, ''), 'base64');
}

/**
 * 安全关闭 net Socket（兼容 node:net 不同 API 形态）：
 * 新版 ESM `node:net` 的 Socket 可能没有 `.close`（为 destroy/resetAndDestroy 取代），
 * 统一走 `.close()` → 兜底 `.destroy()` → 兜底 `.resetAndDestroy()`。
 */
function safeClose(sock) {
  if (!sock) return;
  try { if (typeof sock.close === 'function') return sock.close(); } catch { /* fallthrough */ }
  try { if (typeof sock.destroy === 'function') return sock.destroy(); } catch { /* fallthrough */ }
  try { if (typeof sock.resetAndDestroy === 'function') return sock.resetAndDestroy(); } catch { /* ignore */ }
}

/**
 * deviceId = hex(SHA-256(Ed25519 公钥 x 字节)) —— 验证环境中就以此作为设备指纹。
 * 公钥不变 → deviceId 恒定 → 首次配对批准后永久有效。
 */
async function computeDeviceId(jwk) {
  const xBytes = b64urlToBuf(jwk.x);
  const digest = await subtle.digest('SHA-256', xBytes);
  return hex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// WebSocket（最小实现：文本帧 + close/ping/pong 控制帧）
// ---------------------------------------------------------------------------
function wsSendFrame(sock, opcode, payloadBuf) {
  const payload = Buffer.from(payloadBuf);
  const mk = Buffer.from([0x01, 0x02, 0x03, 0x04]);   // 客户端掩码（4 字节，与验证环境一致）
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= mk[i % 4]; // 异或掩码
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

/** 发送一个文本消息帧（opcode 0x1，FIN=1） */
function wsSendText(sock, text) {
  wsSendFrame(sock, 0x1, Buffer.from(text, 'utf8'));
}

/** 发送 pong（opcode 0xA），回应对端 ping —— 健壮性增强，⚠️ 未在验证环境确认网关是否发送 ping */
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
    } catch { /* 忽略瞬时读错误 */ }
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
    } catch { /* 忽略 */ }
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
  if (b1 & 0x80) await readN(sock, 4);            // 服务端帧不应带掩码；防御性跳过
  const payload = op === 8 ? Buffer.alloc(0) : await readN(sock, len);
  return { op, len, payload };
}

// ---------------------------------------------------------------------------
// 设备身份（JWK 持久化）
// ---------------------------------------------------------------------------
/**
 * 读取或创建设备身份。
 * @param {string} keyFile  JWK 文件路径（默认 DSH-Workspace/openclaw-device.json）
 * @returns {Promise<{jwk: object, publicKeyStr: string, deviceId: string}>}
 */
export async function loadIdentity(keyFile) {
  if (fs.existsSync(keyFile)) {
    const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    if (j.version === 1 && j.jwk?.kty === 'OKP' && j.jwk?.crv === 'Ed25519') {
      const deviceId = await computeDeviceId(j.jwk);
      return { jwk: j.jwk, publicKeyStr: j.jwk.x, deviceId };
    }
    throw new Error('bad identity file (期望 {version:1, jwk:{kty:"OKP",crv:"Ed25519"}}): ' + keyFile);
  }

  // 首次运行：生成 Ed25519 密钥对并写入桥的 DSH-Workspace（私钥永不出 DSH 容器）
  const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwkFull = await subtle.exportKey('jwk', kp.privateKey);
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: jwkFull.x, d: jwkFull.d };
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, JSON.stringify({ version: 1, createdAtMs: Date.now(), jwk }, null, 2), { mode: 0o600 });
  const deviceId = await computeDeviceId(jwk);
  return { jwk, publicKeyStr: jwk.x, deviceId };
}

// ---------------------------------------------------------------------------
// 配对/连接：openSession()
// ---------------------------------------------------------------------------
/**
 * 服务端返回的错误（ok:false 时 error 字段 {code, message}）。code 如 PAIRING_REQUIRED。
 */
export class GatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
  }
}

/**
 * 打开一个已配对的长连接。
 * 流程（验证环境跑通）：
 *   HTTP Upgrade(显式 Origin) → 101 → 收 connect.challenge(nonce)
 *   → Ed25519 签名 v2 claim → 发 connect → 收 {res, ok:true, payload:{type:"hello-ok"}} → 就绪
 *
 * @param {object} o
 * @param {string} [o.host]            默认 openclaw（DNS 容器名，勿用 IP）
 * @param {number} [o.port]            默认 18789
 * @param {string} [o.token]           必填：OpenClaw openclaw.json → gateway.auth.token
 * @param {string} [o.origin]          默认 `http://${host}:${port}`；必须已被网关 allowedOrigins 放行
 * @param {string} [o.keyFile]         默认 `$BRIDGE_PATH/DSH-Workspace/openclaw-device.json`
 * @param {number} [o.connectTimeoutMs] 默认 45000
 * @param {(msg: string) => void} [o.onStatus] 进度回调（CLI 用于打印日志）
 * @returns {Promise<object>} session
 */
export async function openSession(o = {}) {
  const host = o.host || process.env.OC_HOST || 'openclaw';
  const port = Number(o.port ?? process.env.OC_PORT ?? '18789');
  const token = o.token ?? process.env.OC_TOKEN ?? '';
  const bridge = o.bridge || process.env.BRIDGE_PATH || '/root/ODSH-bridge';
  const keyFile = o.keyFile || process.env.OC_KEYS || path.join(bridge, 'DSH-Workspace', 'openclaw-device.json');
  const origin = o.origin || process.env.OC_ORIGIN || `http://${host}:${port}`;
  const connectTimeoutMs = o.connectTimeoutMs || Number(process.env.OC_CONNECT_TIMEOUT_MS || '45000');
  const log = o.onStatus || (() => {});
  if (!token) {
    throw new Error('OC_TOKEN 未设置。请在 .env 填入 OpenClaw openclaw.json → gateway.auth.token 的取值（发布版不含真实 token）。');
  }

  const identity = await loadIdentity(keyFile);
  log('[i] deviceId = ' + identity.deviceId);
  log('[i] keyfile  = ' + keyFile + ' (持久身份)');
  log('[i] target   = ' + host + ':' + port + ' (DNS 容器名)   origin = ' + origin);

  // 1) TCP → WS 升级（带显式 Origin 头）
  const sock = await new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once('error', reject);
    s.setTimeout(15000);
    ensureOpen(s).then((ok) => {
      if (!ok) { reject(new Error('socket 未在超时内打开: ' + host + ':' + port)); return; }
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
    `Origin: ${origin}`,   // ⚠️ 网关按 origin 白名单校验（gateway.controlUi.allowedOrigins）
    '', '',
  ].join('\r\n');
  sock.write(Buffer.from(upgrade));
  const httpResp = await readHttpResp(sock);
  log('[<] handshake: ' + (httpResp.split('\r\n')[0] || '(no status line)'));
  if (!httpResp.includes('101')) {
    safeClose(sock);
    throw new Error('WS 升级被拒绝（检查网关 gateway.controlUi.allowedOrigins 是否放行该 origin）: ' + httpResp.split('\r\n')[0]);
  }

  // 2) challenge → 签名 connect
  const signKey = await subtle.importKey('jwk', identity.jwk, { name: 'Ed25519' }, false, ['sign']);
  const deadline = Date.now() + connectTimeoutMs;
  let sentConnect = false;
  let hello = null;

  while (Date.now() < deadline) {
    const f = await readFrame(sock);
    if (!f) break;
    if (f.op === 8) {
      safeClose(sock);
      throw new Error('连接阶段收到 close 帧: ' + f.payload.toString('utf8'));
    }
    if (f.op === 9) { wsPong(sock, f.payload); continue; }
    let m;
    try { m = JSON.parse(f.payload.toString('utf8')); }
    catch { log('[bad frame]', f.payload.toString('utf8').slice(0, 120)); continue; }

    if (m.type === 'event' && m.event === 'connect.challenge') {
      const nonce = m.payload.nonce;
      const signedAt = Date.now(); // 单一时间戳：claim 签名 与 device.signedAt 必须同值，否则网关验签失败(device signature invalid)
      // claim 串（验证环境格式，字段顺序勿改）：
      //   v2|<deviceId>|<clientId>|<clientMode>|<role>|<scopes(逗号连接)>|<signedAtMs>|<token>|<nonce>
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
        throw new GatewayError('PAIRING_REQUIRED', '设备未批准：请在 OpenClaw Control UI 批准 deviceId=' + identity.deviceId);
      }
      throw new GatewayError(err.code || 'CONNECT_FAILED', err.message || JSON.stringify(m.payload || err).slice(0, 400));
    }
  }
  if (!sentConnect) {
    safeClose(sock);
    throw new Error('未收到 connect.challenge（网关未发 nonce？origin 是否被放行？）');
  }
  if (!hello) {
    safeClose(sock);
    throw new Error('connect 超时（' + connectTimeoutMs + 'ms）：网关未返回 hello-ok');
  }

  // 3) 就绪：进入请求-响应循环
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
      // 其余 frame（events/notifications）：当前无订阅者，忽略。可在此扩展事件订阅。
    }
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('连接已关闭')); }
    pending.clear();
    try { safeClose(sock); } catch { /* ignore */ }
    for (const cb of onCloseCallbacks) { try { cb(); } catch { /* ignore */ } }
  })();

  return {
    deviceId: identity.deviceId,
    hello,
    origin,

    /** 请求-响应：发 {type:'req', id, method, params}，等匹配的 {type:'res', id} */
    request(method, params = {}, { timeoutMs } = {}) {
      const id = crypto.randomUUID();
      const wait = timeoutMs || Number(process.env.OC_REPLY_TIMEOUT_MS || '20000');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('请求超时（' + wait + 'ms）: ' + method));
        }, wait);
        pending.set(id, { resolve, reject, timer });
        wsSendText(sock, JSON.stringify({ type: 'req', id, method, params }));
      });
    },

    /** 单向发送（不回 id 匹配等待） */
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

// 供 CLI 复用的小工具
export { b64url, hex };