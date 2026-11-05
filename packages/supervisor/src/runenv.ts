import { delimiter } from 'node:path';

/**
 * The environment an agent run starts with: opsd's own, plus `extra`, with two adjustments.
 *
 * - `ELECTRON_RUN_AS_NODE` and `OPS_DAEMON_ENTRY` go: opsd may run inside the desktop app's
 *   executable as Node, and a run that inherits them would start any Electron app (a smoke
 *   check, the app itself) as Node, or the installed opsd instead of its checkout's.
 * - The installed app's `bin` folder (`OPS_BIN_DIR`, set by the app and its `ops` shims) goes to
 *   the front of PATH, so runs find `ops` without a change to the person's PATH.
 */
export function runEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  // The installed app's opsd entry: a run working in a checkout must start that checkout's opsd
  // (its tests do). The installed `ops` sets it again for itself.
  delete env.OPS_DAEMON_ENTRY;
  const bin = env.OPS_BIN_DIR?.replace(/[\\/]+$/, '');
  if (bin) {
    // Windows keeps it as `Path`; a copied env is a plain object, so match the name ourselves.
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const parts = (env[key] ?? '').split(delimiter).filter(Boolean);
    const same = (p: string): boolean =>
      p.replace(/[\\/]+$/, '').toLowerCase() === bin.toLowerCase();
    env[key] = [bin, ...parts.filter((p) => !same(p))].join(delimiter);
  }
  return env;
}

/**
 * Deletes `names` from `env`. Windows environment names ignore case, but a copied env is a plain
 * object, so on Windows every key that matches a name in any case goes (`Github_Token` for
 * `GITHUB_TOKEN`).
 */
export function dropEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    for (const k of names) delete env[k];
    return;
  }
  const drop = new Set(names.map((n) => n.toUpperCase()));
  for (const k of Object.keys(env)) if (drop.has(k.toUpperCase())) delete env[k];
}
