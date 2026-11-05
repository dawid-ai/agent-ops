import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One usage window of a provider plan, such as `five_hour` or `seven_day`. */
export interface UsageWindow {
  /** Share of the window used, 0 to 1. */
  utilization: number;
  /** When the window resets, ms since the epoch. */
  resets_at: number;
  /** The provider's own status, such as `allowed`, `allowed_warning` or `rejected`. */
  status?: string;
}

/** What opsd last learned about a provider's usage allowance from its runs' output. */
export interface ProviderUsage {
  windows: Record<string, UsageWindow>;
  /** Set when the provider refused work: no new runs until then. */
  limited_until?: number;
  plan?: string;
  updated_at: number;
}

export type UsageState = Record<string, ProviderUsage>;

/**
 * Reads a Claude Code `rate_limit_event` (`stream-json`). Each event names the window it is about
 * and may list several windows under `unifiedWindows`.
 */
export function claudeUsage(info: unknown, now: number): ProviderUsage | null {
  if (!info || typeof info !== 'object') return null;
  const i = info as {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
    utilization?: number;
    unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }>;
  };
  const windows: Record<string, UsageWindow> = {};
  for (const [name, w] of Object.entries(i.unifiedWindows ?? {})) {
    if (typeof w?.resetsAt !== 'number') continue;
    windows[name] = {
      utilization: w.utilization ?? 0,
      resets_at: w.resetsAt * 1000,
      status: w.status,
    };
  }
  if (i.rateLimitType && typeof i.resetsAt === 'number' && !windows[i.rateLimitType]) {
    windows[i.rateLimitType] = {
      utilization: i.utilization ?? (i.status === 'rejected' ? 1 : 0),
      resets_at: i.resetsAt * 1000,
      status: i.status,
    };
  }
  // An authoritative reading: it sets the refusal, or clears it. A window still rejected keeps
  // pausing through its own status.
  const usage: ProviderUsage = { windows, updated_at: now, limited_until: undefined };
  if (i.status === 'rejected' && typeof i.resetsAt === 'number') {
    usage.limited_until = i.resetsAt * 1000;
  }
  return Object.keys(windows).length > 0 || usage.limited_until ? usage : null;
}

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/** Reads the `rate_limits` object of a Codex session file's `token_count` event. */
export function codexUsage(limits: unknown, now: number): ProviderUsage | null {
  if (!limits || typeof limits !== 'object') return null;
  const l = limits as {
    primary?: CodexWindow | null;
    secondary?: CodexWindow | null;
    plan_type?: string;
    rate_limit_reached_type?: string | null;
  };
  const windows: Record<string, UsageWindow> = {};
  for (const w of [l.primary, l.secondary]) {
    if (!w || typeof w.resets_at !== 'number') continue;
    windows[windowName(w.window_minutes)] = {
      utilization: (w.used_percent ?? 0) / 100,
      resets_at: w.resets_at * 1000,
    };
  }
  const usage: ProviderUsage = {
    windows,
    plan: l.plan_type,
    updated_at: now,
    limited_until: undefined,
  };
  if (l.rate_limit_reached_type) {
    const full = Object.values(windows).filter((w) => w.utilization >= 1);
    const until = Math.max(
      0,
      ...(full.length ? full : Object.values(windows)).map((w) => w.resets_at),
    );
    if (until > 0) usage.limited_until = until;
  }
  return Object.keys(windows).length > 0 ? usage : null;
}

function windowName(minutes: number | undefined): string {
  if (minutes === 300) return 'five_hour';
  if (minutes === 10080) return 'seven_day';
  return minutes ? `${minutes}m` : 'window';
}

/**
 * Why no new run should start on the provider now, or null. A window counts once it reaches
 * `pauseAt` (the rest stays for the human's own sessions) and until it resets.
 */
export function usagePause(
  provider: string,
  usage: ProviderUsage | undefined,
  pauseAt: number,
  now: number,
): string | null {
  if (!usage) return null;
  if (usage.limited_until && usage.limited_until > now) {
    return `${provider} refused work (usage limit) until ${clock(usage.limited_until)}`;
  }
  for (const [name, w] of Object.entries(usage.windows)) {
    if (w.resets_at <= now) continue;
    if (w.utilization >= pauseAt || w.status === 'rejected') {
      return (
        `${provider} usage at ${Math.round(w.utilization * 100)}% of the ${name} window ` +
        `(pause at ${Math.round(pauseAt * 100)}%) until ${clock(w.resets_at)}`
      );
    }
  }
  return null;
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/**
 * Merges new readings into a provider's usage; windows not in the reading keep their values. A
 * reading that has `limited_until` as a key, even unset, decides the refusal: provider readings
 * set or clear it.
 */
export function mergeUsage(prev: ProviderUsage | undefined, next: ProviderUsage): ProviderUsage {
  return {
    windows: { ...(prev?.windows ?? {}), ...next.windows },
    limited_until: 'limited_until' in next ? next.limited_until : prev?.limited_until,
    plan: next.plan ?? prev?.plan,
    updated_at: next.updated_at,
  };
}

// ---- Codex session files ---------------------------------------------------------------------

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? join(homedir(), '.codex');
}

/**
 * Finds the session file of a Codex thread: `sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`. Looks
 * in the newest day folders only, since the run started recently.
 */
export function findRollout(home: string, thread: string): string | null {
  const base = join(home, 'sessions');
  const newest = (dir: string, n: number): string[] => {
    try {
      return readdirSync(dir)
        .filter((d) => /^\d+$/.test(d))
        .sort()
        .slice(-n)
        .reverse()
        .map((d) => join(dir, d));
    } catch {
      return [];
    }
  };
  for (const year of newest(base, 2)) {
    for (const month of newest(year, 2)) {
      for (const day of newest(month, 3)) {
        try {
          const hit = readdirSync(day).find(
            (f) => f.startsWith('rollout-') && f.endsWith(`${thread}.jsonl`),
          );
          if (hit) return join(day, hit);
        } catch {
          // Unreadable folder: keep looking.
        }
      }
    }
  }
  return null;
}

/** The last `rate_limits` object in the end of a Codex session file, or null. */
export function lastCodexLimits(file: string, tailBytes = 256 * 1024): unknown {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  const len = Math.min(size, tailBytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const found = findKey(JSON.parse(line), 'rate_limits');
      if (found) return found;
    } catch {
      // A line cut by the tail window.
    }
  }
  return null;
}

function findKey(v: unknown, key: string, depth = 0): unknown {
  if (!v || typeof v !== 'object' || depth > 6) return null;
  const o = v as Record<string, unknown>;
  if (o[key] && typeof o[key] === 'object') return o[key];
  for (const child of Object.values(o)) {
    const hit = findKey(child, key, depth + 1);
    if (hit) return hit;
  }
  return null;
}
