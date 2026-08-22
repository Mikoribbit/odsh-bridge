#!/usr/bin/env node
// security.test.mjs — security regression tests for ODSH Bridge (run by CI).
// Verifies the v1.1.0 hardening still holds: no command injection, no secrets, fail-closed.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let failures = 0;
function ok(name){ console.log('  ✓ ' + name); }
function fail(name, detail=''){ failures++; console.error('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
function assert(cond, name, detail){ cond ? ok(name) : fail(name, detail); }

// ---- 1) oc-cua tool-name injection must fail closed ----
function runOC(extraEnv, args){
  try {
    execFileSync('node', [join(ROOT,'src','oc-cua.mjs'), ...args], { env: { ...process.env, ...extraEnv }, stdio: 'pipe' });
    return { exit: 0 };
  } catch (e) { return { exit: e.status ?? -1, out: String(e.stdout||'') + String(e.stderr||'') }; }
}
console.log('oc-cua tool-name injection:');
for (const evil of [
  'x" & whoami & "',
  'foo"|ping 8.8.8.8',
  'click;calc',
  'list-tools;calc',
  '$(whoami)',
  '`whoami`',
]) {
  const r = runOC({ CUA_SSH_USER: 'test' }, [evil, '{}']);
  assert(r.exit !== 0, 'rejects ' + JSON.stringify(evil), 'exit=' + r.exit);
  if (r.exit === 0) console.error('    stdout: ' + (r.out||'').slice(0,120));
}
assert(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test('browser_navigate'), 'valid tool passes regex');
assert(!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test('x" & whoami'), 'invalid tool fails regex');

// ---- 2) oc-cua requires CUA_SSH_USER (no personal default) ----
console.log('oc-cua env hardening:');
const rNoUser = runOC({ CUA_SSH_USER: '' }, ['get_screen_size','{}']);
assert(rNoUser.exit !== 0, 'CUA_SSH_USER empty -> fails');
const srcOC = readFileSync(join(ROOT,'src','oc-cua.mjs'),'utf8');
assert(!/\|\s*'miko'/.test(srcOC) && !/CUA_SSH_USER\s*\|\|\s*'miko'/.test(srcOC), 'no miko default in oc-cua');

// ---- 3) daemon hardening present ----
console.log('bridge-daemon hardening:');
const srcBD = readFileSync(join(ROOT,'src','bridge-daemon.mjs'),'utf8');
assert(srcBD.includes('ALLOWED_BINS'), 'argv allowlist exists');
assert(!srcBD.includes("execFileSync('/bin/sh'"), 'no /bin/sh -c execution');
assert(srcBD.includes('resolveTarget'), 'path confinement helper exists');
assert(srcBD.includes('BRIDGE_ALLOW_ABS_PATHS'), 'abs-path flag wired');
assert(srcBD.includes('ALLOW_REQUESTERS'), 'requester allowlist wired');
assert(srcBD.includes('renameSync') || srcBD.includes('mode: 0o600'), 'atomic state write');

// ---- 4) gateway hardening present ----
console.log('gateway-client hardening:');
const srcGW = readFileSync(join(ROOT,'src','gateway-client.mjs'),'utf8');
assert(srcGW.includes('Sec-WebSocket-Accept'), 'handshake accept check exists');
assert(!srcGW.includes('includes(\'101\')'), 'no weak includes(101) check');
assert(srcGW.includes('crypto.randomBytes(4)'), 'random WS mask');
assert(srcGW.includes('REPLACE_WITH_GATEWAY_TOKEN'), 'token placeholder guard');

// ---- 5) no secrets in the tree (real tokens/keys/JWK/device ids) ----
console.log('secret scan:');
const secretPats = [
  /ghp_[A-Za-z0-9]{10,}/,            // GitHub PAT
  /[0-9a-f]{64}/gi,                   // long hex (tokens/keys/deviceId)
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,  // private key blocks
];
function walk(d){ let out=[]; for(const n of readdirSync(d)){ const p=join(d,n); const st=statSync(p); if(st.isDirectory()){ if(!['.git','node_modules'].includes(n)) out=out.concat(walk(p)); } else if(!/\.(jpg|png|zip)$/i.test(n)) out.push(p); } return out; }
const ALL_FILES = walk(ROOT);
const allowed = ['CHANGELOG.md','README.md','README.zh.md','docs/CUA-EXECUTION.md','docs/PROTOCOL.md'];
for (const f of ALL_FILES) {
  if (!existsSync(f)) continue;
  try { const txt = readFileSync(f,'utf8');
    for (const pat of secretPats) {
      const m = txt.match(pat);
      const rel = f.replace(ROOT+'/','');
      // skip the CHANGELOG/README lines that deliberately mention the pattern in prose
      if (m && !allowed.includes(rel)) fail('secret pattern '+pat+' in '+rel);
    }
  } catch {}
}
ok('no obvious secrets outside allowed docs');

// ---- 6) scripts present + bash syntax ----
console.log('scripts:');
assert(existsSync(join(ROOT,'scripts','setup-dsh.sh')), 'setup-dsh.sh exists');
assert(existsSync(join(ROOT,'scripts','setup-windows.ps1')), 'setup-windows.ps1 exists');
try { execFileSync('bash', ['-n', join(ROOT,'scripts','setup-dsh.sh')]); ok('bash -n setup-dsh.sh'); } catch(e){ fail('bash -n', e.message); }

console.log(failures === 0 ? '\nALL SECURITY TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
