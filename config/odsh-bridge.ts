/**
 * ODSH Bridge — Cordis plugin orchestration (reference form, ⚠️ not verified in a product environment)
 *
 * Notes:
 *   - The verified form is a standalone node process: `node src/bridge-daemon.mjs --notify`.
 *   - This file provides the orchestration to mount the daemon into DeepSeek Harness (Cordis): on apply it
 *     spawns the daemon as a child process, and on unload it reclaims it via SIGTERM. Side effects (the child
 *     process) are managed with ctx.effect(), matching the writing style of the official tutorial
 *     02-lifecycle-and-effects.md.
 *   - Dependency: @deepseek-ai/cordis (bundled with the DSH runtime).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';

export const name = 'odsh-bridge-daemon';

export interface ODSHBridgeConfig {
  /** Bridge root path (default /root/ODSH-bridge) */
  bridgePath?: string;
  /** daemon script path (default <repo>/src/bridge-daemon.mjs) */
  script?: string;
  /** scan interval in ms (default 5000) */
  intervalMs?: number;
  /** whether to notify a Discord channel via oc-send after completion (requires DISCORD_CHANNEL_ID in .env) */
  notify?: boolean;
  /** extra environment variables passed to the daemon */
  env?: Record<string, string>;
}

export function apply(ctx: Context, config: ODSHBridgeConfig = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = resolve(config.script ?? join(here, '..', 'src', 'bridge-daemon.mjs'));
  const intervalMs = config.intervalMs ?? 5000;

  ctx.effect(() => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(config.env || {}) };
    if (config.bridgePath) env.BRIDGE_PATH = config.bridgePath;

    const args = ['--interval-ms', String(intervalMs)];
    if (config.notify) args.push('--notify');

    const child: ChildProcess = spawn(process.execPath, [script, ...args], {
      env,
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        console.error(`[odsh-bridge] daemon exited abnormally code=${code} signal=${signal}`);
      }
    });

    // disposer: reclaim the child process on plugin unload / hot-reload
    return () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    };
  });

  console.log(`[odsh-bridge] daemon started with the plugin: ${script} (interval=${intervalMs}ms, notify=${config.notify ?? false})`);
}

export default apply;