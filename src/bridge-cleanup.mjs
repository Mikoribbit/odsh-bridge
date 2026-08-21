#!/usr/bin/env node
// bridge-cleanup.mjs — retention & cleanup for the ODSH bridge.
// Deletes stale files in Input/ and Output/ older than a retention window.
//
// Usage:
//   node bridge-cleanup.mjs [--days 7] [--dry-run] [--input] [--output]
//
// Safety:
//   - protects Input/.state/* and any file whose name starts with '.' or is "README.md"
//   - default retention: 7 days
//   - --dry-run: only print what would be deleted
import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BRIDGE = process.env.BRIDGE_PATH || '/root/ODSH-bridge';
const argv = process.argv.slice(2);

function flag(name) { return argv.includes('--' + name); }
function flagVal(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? Number(argv[i + 1] ?? def) : def;
}

const DAYS = flagVal('days', 7);
const DO_INPUT = flag('input') || !flag('output'); // default: both, unless --output only
const DO_OUTPUT = flag('output') || !flag('input');
const DRY_RUN = flag('dry-run');
const MAX_AGE_MS = DAYS * 24 * 60 * 60 * 1000;

const PROTECTED = new Set(['.state', 'README.md', '.gitkeep']);

function clean(dir, label) {
  if (!existsSync(dir)) { console.log(`[skip] ${label}: missing`); return; }
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (PROTECTED.has(f) || f.startsWith('.')) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    if (Date.now() - st.mtimeMs > MAX_AGE_MS) {
      if (DRY_RUN) { console.log(`[dry] would delete ${label}/${f} (${Math.round((Date.now()-st.mtimeMs)/86400000)}d old)`); }
      else { try { unlinkSync(p); removed++; } catch (e) { console.log(`[warn] cannot delete ${p}: ${e.message}`); } }
    }
  }
  if (!DRY_RUN) console.log(`[done] ${label}: removed ${removed} stale file(s) (>${DAYS}d)`);
}

console.log(`bridge-cleanup: days=${DAYS} dry-run=${DRY_RUN} input=${DO_INPUT} output=${DO_OUTPUT}`);
if (DO_INPUT) clean(join(BRIDGE, 'Input'), 'Input');
if (DO_OUTPUT) clean(join(BRIDGE, 'Output'), 'Output');