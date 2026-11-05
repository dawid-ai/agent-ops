import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { freemem, homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { UserConfig } from '@agent-ops/core';
import { userConfigPath, Workspace } from '@agent-ops/core';
import type { OpsdConfig } from './config.js';
import { opsdConfig } from './config.js';
import { buildStamp, daemonCall, readDaemon } from './daemon.js';
import { resolveCommand } from './proc.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  /** Stable key, such as `config`, `root:<dir>` or `runtime:claude`. */
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a warn or fail. */
  fix?: string;
}

export interface DoctorOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Set when opsd runs the checks itself: its own build, so it does not call itself. */
  self?: { build?: string; pid: number };
  freeMem?: () => number;
  /** Free bytes on the disk that holds `dir`, or null when unknown. */
  diskFree?: (dir: string) => number | null;
  home?: string;
}

/** Disk space below which a root gets a warning: clones, logs and builds need room. */
const DISK_WARN_GB = 5;

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function defaultDiskFree(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Where each runtime keeps its sign-in, checked for existence only: the files are never read. An
 * API key in the environment counts too. Null when there is no way to tell (macOS Keychain, an
 * unknown runtime).
 */
function signedIn(runtime: string, env: NodeJS.ProcessEnv, home: string): boolean | null {
  if (runtime === 'claude') {
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return true;
    const dir = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
    return existsSync(join(dir, '.credentials.json')) ? true : null;
  }
  if (runtime === 'codex') {
    if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return true;
    const dir = env.CODEX_HOME ?? join(home, '.codex');
    return existsSync(join(dir, 'auth.json')) ? true : null;
  }
  return null;
}

const gb = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(1)} GB`;

/**
 * Checks this machine's setup: user config, data roots, the opsd config, runtimes on PATH and
 * signed in, opsd itself, and free memory and disk. Never throws; every problem is a check.
 */
export async function doctor(opts: DoctorOptions): Promise<Check[]> {
  const { env } = opts;
  const home = opts.home ?? homedir();
  const out: Check[] = [];
  const add = (c: Check): void => {
    out.push(c);
  };

  // User config.
  const file = userConfigPath(env);
  let user: UserConfig & { opsd?: Partial<OpsdConfig> } = {};
  if (!existsSync(file)) {
    add({
      id: 'config',
      label: 'User config',
      status: 'warn',
      detail: `${file} does not exist`,
      fix: 'run `ops setup`, or open the desktop app once',
    });
  } else {
    try {
      user = (YAML.parse(readFileSync(file, 'utf8')) ?? {}) as typeof user;
      add({ id: 'config', label: 'User config', status: 'ok', detail: file });
    } catch (err) {
      add({
        id: 'config',
        label: 'User config',
        status: 'fail',
        detail: `${file} is not valid YAML: ${(err as Error).message.split('\n')[0]}`,
        fix: 'fix the file by hand; opsd and the app refuse to edit it while it does not parse',
      });
    }
  }
  add(
    user.me
      ? { id: 'me', label: 'You', status: 'ok', detail: user.me }
      : {
          id: 'me',
          label: 'You',
          status: 'warn',
          detail: '`me` is not set: asks and reviews have no human to go to',
          fix: 'run `ops setup`',
        },
  );

  // Data roots.
  let ws: Workspace | null = null;
  try {
    ws = new Workspace({ cwd: opts.cwd, env, user });
    const roots = ws.roots;
    if (roots.length === 0) {
      add({
        id: 'roots',
        label: 'Data roots',
        status: 'fail',
        detail: 'no data root: not inside one, and the user config lists none',
        fix: 'run `ops init` in a repo, or add a root with `ops setup`',
      });
    }
    for (const r of roots) {
      const top = gitOut(r.dir, ['rev-parse', '--show-toplevel']);
      if (!top) {
        add({
          id: `root:${r.dir}`,
          label: `Root ${r.name}`,
          status: 'fail',
          detail: `${r.dir} is not inside a git repo`,
          fix: '`git init` the folder, or move the root into a repo',
        });
        continue;
      }
      const upstream = gitOut(r.dir, ['rev-parse', '--abbrev-ref', '@{u}']);
      add(
        upstream
          ? {
              id: `root:${r.dir}`,
              label: `Root ${r.name}`,
              status: 'ok',
              detail: `${r.dir} (syncs with ${upstream})`,
            }
          : {
              id: `root:${r.dir}`,
              label: `Root ${r.name}`,
              status: 'warn',
              detail: `${r.dir} has no upstream branch: ops sync commits but never pushes or pulls`,
              fix: 'push the branch once with `git push -u`',
            },
      );
    }
    for (const p of ws.agentProblems()) {
      add({
        id: `agent-file:${p.file}`,
        label: 'Role file',
        status: 'warn',
        detail: `${p.file} is skipped: ${p.message}`,
        fix: 'fix the frontmatter by hand; quote any value that contains `: `',
      });
    }
  } catch (err) {
    add({
      id: 'roots',
      label: 'Data roots',
      status: 'fail',
      detail: (err as Error).message,
      fix: 'run `ops init` in a repo, or add a root with `ops setup`',
    });
  }

  // opsd config and runtimes.
  let cfg: OpsdConfig | null = null;
  try {
    cfg = opsdConfig(user);
    add({ id: 'opsd-config', label: 'opsd config', status: 'ok', detail: 'valid' });
  } catch (err) {
    add({
      id: 'opsd-config',
      label: 'opsd config',
      status: 'fail',
      detail: (err as Error).message,
      fix: `fix the opsd section of ${file}`,
    });
  }
  for (const [name, rc] of Object.entries(cfg?.runtimes ?? {})) {
    // The opsd config does not check commands, so anything can be here.
    const command = (rc as { command?: unknown } | null)?.command;
    if (typeof command !== 'string' || !command.trim()) {
      add({
        id: `runtime:${name}`,
        label: `Runtime ${name}`,
        status: 'fail',
        detail: 'no command set',
        fix: `set opsd.runtimes.${name}.command to the program to run`,
      });
      continue;
    }
    let path: string | null;
    try {
      path = resolveCommand(command, env);
    } catch {
      path = null;
    }
    if (!path) {
      add({
        id: `runtime:${name}`,
        label: `Runtime ${name}`,
        status: 'fail',
        detail: `'${command}' is not on PATH`,
        fix: `install ${name}, or set opsd.runtimes.${name}.command to its full path`,
      });
      continue;
    }
    const signed = signedIn(name, env, home);
    add(
      signed
        ? {
            id: `runtime:${name}`,
            label: `Runtime ${name}`,
            status: 'ok',
            detail: `${path}; signed in`,
          }
        : {
            id: `runtime:${name}`,
            label: `Runtime ${name}`,
            status: 'warn',
            detail: `${path}; cannot tell whether it is signed in`,
            fix: `run \`${command}\` once in a terminal and sign in, if runs fail to start`,
          },
    );
  }

  // opsd itself.
  if (opts.self) {
    add({
      id: 'opsd',
      label: 'opsd',
      status: 'ok',
      detail: `running, pid ${opts.self.pid}${opts.self.build ? `, build ${opts.self.build}` : ''}`,
    });
  } else {
    const info = readDaemon(env);
    if (!info) {
      add({
        id: 'opsd',
        label: 'opsd',
        status: 'warn',
        detail: 'not running: no schedules or wakes until it starts',
        fix: 'run `ops daemon start`, or open the desktop app',
      });
    } else {
      try {
        const health = await daemonCall<{ build?: string }>(info, 'GET', '/api/health');
        const here = buildStamp();
        // Same rule as the desktop: a different stamp means opsd runs other code than this install.
        const stale = health.build !== here;
        add(
          stale
            ? {
                id: 'opsd',
                label: 'opsd',
                status: 'warn',
                detail: `pid ${info.pid} runs an older build than this install`,
                fix: 'the desktop app restarts it once no run is live; or `ops daemon stop` then `ops daemon start`',
              }
            : {
                id: 'opsd',
                label: 'opsd',
                status: 'ok',
                detail: `pid ${info.pid} on port ${info.port}`,
              },
        );
      } catch (err) {
        add({
          id: 'opsd',
          label: 'opsd',
          status: 'fail',
          detail: `pid ${info.pid} does not answer: ${(err as Error).message}`,
          fix: 'run `ops daemon stop`, then `ops daemon start`',
        });
      }
    }
  }

  // Memory and disk.
  const minGb = cfg?.min_free_gb ?? 0;
  const mem = (opts.freeMem ?? freemem)();
  add(
    mem / 2 ** 30 < minGb
      ? {
          id: 'memory',
          label: 'Free memory',
          status: 'fail',
          detail: `${gb(mem)} free; min_free_gb is ${minGb}, so opsd starts no runs`,
          fix: 'close programs, or lower opsd.min_free_gb in Settings',
        }
      : {
          id: 'memory',
          label: 'Free memory',
          status: 'ok',
          detail: `${gb(mem)} free (min ${minGb} GB)`,
        },
  );
  const diskFree = opts.diskFree ?? defaultDiskFree;
  const seen = new Set<string>();
  for (const r of ws ? safeRoots(ws) : []) {
    const free = diskFree(r.dir);
    if (free === null) continue;
    // One line per disk: roots on the same device share their free space.
    let key: string;
    try {
      key = String(statSync(r.dir).dev);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    add(
      free / 2 ** 30 < DISK_WARN_GB
        ? {
            id: `disk:${r.name}`,
            label: `Disk for ${r.name}`,
            status: 'warn',
            detail: `${gb(free)} free`,
            fix: 'free space: runs write logs and builds',
          }
        : {
            id: `disk:${r.name}`,
            label: `Disk for ${r.name}`,
            status: 'ok',
            detail: `${gb(free)} free`,
          },
    );
  }
  return out;
}

function safeRoots(ws: Workspace): Array<{ name: string; dir: string }> {
  try {
    return ws.roots;
  } catch {
    return [];
  }
}

/** One line per check for a terminal, with the fix under each warn or fail. */
export function formatChecks(checks: Check[]): string {
  const mark: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  return checks
    .map(
      (c) =>
        `${mark[c.status]}  ${c.label}: ${c.detail}${c.fix && c.status !== 'ok' ? `\n      -> ${c.fix}` : ''}`,
    )
    .join('\n');
}
