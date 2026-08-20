#!/usr/bin/env node
// env.mjs — 零依赖 .env 加载（发布版新增的管道设施，非握手逻辑）。
// 规则：
//   - 默认读当前工作目录的 .env，可用 OC_ENV_FILE 覆盖路径；
//   - 已存在的进程环境变量优先（shell 里 export 的变量不会被 .env 覆盖）；
//   - 支持 `#` 注释行与简单引号；不支持行内注释与多行值。
import { existsSync, readFileSync } from 'node:fs';

export function loadEnvFile(file = process.env.OC_ENV_FILE || '.env') {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// 读环境变量；空串视为未设置（走默认值）。
export function envStr(name, def = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

export function envInt(name, def) {
  const v = envStr(name, '');
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}