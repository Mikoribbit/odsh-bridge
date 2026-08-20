/**
 * ODSH Bridge — Cordis 插件编排（参考形态，⚠️ 未在产品环境验证）
 *
 * 说明：
 *   - 验证过的形态是「独立 node 进程」：`node src/bridge-daemon.mjs --notify`。
 *   - 本文件提供把 daemon 挂进 DeepSeek Harness（Cordis）的编排方式：apply 时以子进程
 *     拉起 daemon，unload 时 SIGTERM 回收。副作用（子进程）由 ctx.effect() 管理，
 *     与官方教程 02-lifecycle-and-effects.md 的写法一致。
 *   - 依赖：@deepseek-ai/cordis（DSH 运行时内置）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';

export const name = 'odsh-bridge-daemon';

export interface ODSHBridgeConfig {
  /** 桥根路径（默认 /root/ODSH-bridge） */
  bridgePath?: string;
  /** daemon 脚本路径（默认 <repo>/src/bridge-daemon.mjs） */
  script?: string;
  /** 扫描间隔 ms（默认 5000） */
  intervalMs?: number;
  /** 完成后是否经 oc-send 通知 Discord 频道（需 .env 已有 DISCORD_CHANNEL_ID） */
  notify?: boolean;
  /** 追加传给 daemon 的环境变量 */
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
        console.error(`[odsh-bridge] daemon 异常退出 code=${code} signal=${signal}`);
      }
    });

    // disposer：插件卸载/热更新时回收子进程
    return () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    };
  });

  console.log(`[odsh-bridge] daemon 已随插件启动: ${script} (interval=${intervalMs}ms, notify=${config.notify ?? false})`);
}

export default apply;