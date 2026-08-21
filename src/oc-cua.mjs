#!/usr/bin/env node
// oc-cua.mjs — DSH 执行层 → Windows 宿主桌面操作（经 SSH + Cua Driver）
//
// ODSH Bridge 1.1 的核心新增：让容器里的 DSH 通过 SSH 调用 Windows 宿主上的
// Cua Driver（https://github.com/trycua/cua），直接获得真实桌面能力
// （截图 / 点击 / 浏览器 / 系统操作，且不偷焦点）。
//
// 用法：
//   node oc-cua.mjs <tool> '[jsonArgs]'          # 调用一个 cua-driver 工具
//   node oc-cua.mjs list-tools                    # 列出所有可用工具
//   node oc-cua.mjs get_screen_size               # 读屏幕分辨率
//   node oc-cua.mjs get_desktop_state             # 全屏截图（返回 base64/路径）
//   node oc-cua.mjs browser_navigate '{"url":"https://example.com"}'
//   node oc-cua.mjs click '{"pid":123,"x":100,"y":200}'
//
// 环境变量（.env / 进程环境）：
//   CUA_SSH_USER    Windows 用户名（默认 miko）
//   CUA_SSH_HOST    Windows 宿主（默认 host.docker.internal）
//   CUA_SSH_PORT    SSH 端口（默认 22）
//   CUA_SSH_KEY     SSH 私钥路径（默认 /root/.ssh/id_ed25519）
//   CUA_BIN         Windows 端 cua-driver.exe 的完整路径
//                   （默认 C:/Users/<USER>/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe。
//                    注意：实际安装可能在 C:/Users/<USER>/.cua-driver/packages/releases/<v>-<target>/cua-driver.exe
//                    或 AppData junction；与本机不符时务必设置 CUA_BIN 覆盖）
//   CUA_TIMEOUT_MS  单次调用超时（默认 60s）
//
// 说明：
//   - SSH 使用 BatchMode + 私钥免密（Windows 侧需放公钥到
//     C:/ProgramData/ssh/administrators_authorized_keys，若用户属 Administrators）
//   - 输出：cua-driver 的 JSON 响应原样打印到 stdout；非零退出码表示失败。
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadEnvFile } from './env.mjs';
loadEnvFile(process.env.OC_ENV_FILE || '.env');

// ---- config ----
const args = process.argv.slice(2);
const TOOL = args[0];
if (!TOOL) {
  console.error('usage: node oc-cua.mjs <tool> [jsonArgs]');
  console.error('example: node oc-cua.mjs get_desktop_state');
  process.exit(64);
}
const JSON_ARGS = args[1] || '{}';
let parsed;
try { parsed = JSON.parse(JSON_ARGS); }
catch {
  // allow bare string passthrough for tools that accept a string payload
  parsed = JSON_ARGS;
}

const SSH_USER = process.env.CUA_SSH_USER || 'miko';
const SSH_HOST = process.env.CUA_SSH_HOST || 'host.docker.internal';
const SSH_PORT = process.env.CUA_SSH_PORT || '22';
const SSH_KEY = process.env.CUA_SSH_KEY || '/root/.ssh/id_ed25519';
const TIMEOUT_MS = Number(process.env.CUA_TIMEOUT_MS || 60000);
const CUA_BIN = process.env.CUA_BIN
  || `C:/Users/${SSH_USER}/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe`;

// If the tool is "list-tools" it's a subcommand, not a call tool.
const isSubcommand = ['list-tools', '--version', 'doctor', 'status', 'manifest', 'telemetry'].includes(TOOL);

function buildRemote() {
  const cua = CUA_BIN.replaceAll('/', '\\');
  let remote;
  if (isSubcommand) {
    remote = `cmd /c "${cua}" ${TOOL}`;
  } else {
    // JSON via stdin (cua-driver's official fix for Windows PowerShell stripping quotes).
    // Encode the JSON as base64 to avoid any quoting/escaping across ssh → cmd → shell.
    const payload = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    const b64 = Buffer.from(payload, 'utf8').toString('base64');
    remote = `powershell -NoProfile -Command "$b64='${b64}'; $json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)); $json | & '${cua}' call ${TOOL}"`;
  }
  return remote;
}
function run() {
  const remote = buildRemote();
  const sshArgs = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-i', SSH_KEY,
    '-p', SSH_PORT,
    `${SSH_USER}@${SSH_HOST}`,
    remote,
  ];
  try {
    const out = execFileSync('ssh', sshArgs, {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(out);
    process.exit(0);
  } catch (e) {
    console.error('[oc-cua] failed:', e.message || String(e));
    if (e.stdout) process.stdout.write(String(e.stdout));
    if (e.stderr) process.stderr.write(String(e.stderr));
    process.exit(1);
  }
}

run();
