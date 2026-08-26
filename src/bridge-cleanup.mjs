#!/usr/bin/env node
// bridge-cleanup.mjs — retention & cleanup for the ODSH bridge.
// Deletes stale files in Input/ and Output/ older than a retention window.
//
// Usage (CLI):
//   node bridge-cleanup.mjs [--days 7] [--dry-run] [--input] [--output]
//
// Also exports cleanDir() so higher-level tools (e.g. dshtrigger purge) can reuse
// the same retention/delete logic against an arbitrary directory.
//
// Safety:
//   - protects Input/.state/* and any file whose name starts with '.' or is "README.md" / ".gitkeep"
//   - default retention: 7 days
//   - --dry-run: only print what would be deleted
import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGE = process.env.BRIDGE_PATH || '/root/ODSH-bridge';

export const PROTECTED = new Set(['.state', 'README.md', '.gitkeep']);

// Remove stale files in `dir` older than `opts.days` (default 7).
// opts: { days=7, dryRun=false, label? } — returns count (removed, or would-remove under dryRun).
export function cleanDir(dir, opts = {}) {
  const days = Number(opts.days) || 7;
  const dryRun = !!opts.dryRun;
  const label = opts.label || dir;
  if (!existsSync(dir)) { if (opts.verbose || !dryRun) console.log('[skip] ' + label + ': missing'); return 0; }
  const MAX_AGE_MS = days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (PROTECTED.has(f) || f.startsWith('.')) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    if (Date.now() - st.mtimeMs > MAX_AGE_MS) {
      if (dryRun) { console.log('[dry] would delete ' + label + '/' + f + ' (' + Math.round((Date.now() - st.mtimeMs) / 86400000) + 'd old)'); }
      else { try { unlinkSync(p); removed++; } catch (e) { console.log('[warn] cannot delete ' + p + ': ' + e.message); } }
    }
  }
  return removed;
}

// CLI entry — only when executed directly (importing this module is side-effect free).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes('--' + name);
  const flagVal = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? Number(argv[i + 1] ?? def) : def; };
  const DAYS = flagVal('days', 7);
  const DO_INPUT = flag('input') || !flag('output');
  const DO_OUTPUT = flag('output') || !flag('input');
  const DRY_RUN = flag('dry-run');
  const targets = [];
  if (DO_INPUT) targets.push(['Input', join(BRIDGE, 'Input')]);
  if (DO_OUTPUT) targets.push(['Output', join(BRIDGE, 'Output')]);
  console.log('bridge-cleanup: days=' + DAYS + ' dry-run=' + DRY_RUN + ' input=' + DO_INPUT + ' output=' + DO_OUTPUT);
  for (const [nm, dir] of targets) {
    const n = cleanDir(dir, { days: DAYS, dryRun: DRY_RUN, label: nm });
    if (!DRY_RUN) console.log('[done] ' + nm + ': removed ' + n + ' stale file(s) (>' + DAYS + 'd)');
  }
}