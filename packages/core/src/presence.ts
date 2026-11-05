// Machine presence: each opsd writes `machines/<machine>.json` in its data roots, committed with
// the next sync, so every clone can tell which machines are alive and what they run. Only the
// configured machine name goes in: no host names, users or addresses.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Root } from './root.js';

export interface Presence {
  machine: string;
  /** When this machine's opsd last wrote the file (ISO). */
  last_seen: string;
  live_runs: number;
  version?: string;
  build?: string;
  /** Agent ids with a live run. */
  agents?: string[];
}

/** A machine counts as alive when it wrote within this window (two push intervals). */
export const ALIVE_MS = 70 * 60_000;

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The file name for a machine name, or null when the name cannot be one (unset or odd). */
export function presenceSlug(machine: string | undefined): string | null {
  if (!machine) return null;
  const slug = machine
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return NAME.test(slug) ? slug : null;
}

/**
 * Writes this machine's presence when it changed or is older than `every` ms; a fresh write on
 * every tick would make a commit each sync. Returns whether it wrote.
 */
export function writePresence(
  root: Root,
  p: Presence,
  every = 20 * 60_000,
  now = Date.now(),
): boolean {
  const slug = presenceSlug(p.machine);
  if (!slug) return false;
  const dir = join(root.dir, 'machines');
  // A link here could point anywhere: presence is never read or written through one.
  if (existsSync(dir) && !plainDir(dir)) return false;
  const file = join(dir, `${slug}.json`);
  if (existsSync(file) && !plainFile(file)) return false;
  const prev = readPresenceFile(file);
  const same =
    prev &&
    prev.live_runs === p.live_runs &&
    prev.build === p.build &&
    prev.version === p.version &&
    (prev.agents ?? []).join(',') === (p.agents ?? []).join(',');
  if (same && now - Date.parse(prev.last_seen) < every) return false;
  mkdirSync(dir, { recursive: true });
  root.writeAtomic(file, `${JSON.stringify({ ...cleanPresence(p), machine: slug }, null, 2)}\n`);
  return true;
}

function plainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function plainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Only the known fields, of the right types: a file in a synced repo can hold anything. */
function cleanPresence(raw: unknown): Presence | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.machine !== 'string' || typeof r.last_seen !== 'string') return null;
  if (Number.isNaN(Date.parse(r.last_seen))) return null;
  const out: Presence = {
    machine: r.machine,
    last_seen: r.last_seen,
    live_runs: typeof r.live_runs === 'number' && Number.isFinite(r.live_runs) ? r.live_runs : 0,
  };
  if (typeof r.version === 'string') out.version = r.version;
  if (typeof r.build === 'string') out.build = r.build;
  if (Array.isArray(r.agents))
    out.agents = r.agents.filter((a): a is string => typeof a === 'string');
  return out;
}

function readPresenceFile(file: string): Presence | null {
  if (!plainFile(file)) return null;
  try {
    return cleanPresence(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Every machine seen in any of the roots, newest record per machine, with whether it is alive. */
export function readPresence(
  roots: Root[],
  now = Date.now(),
): Array<Presence & { alive: boolean }> {
  const by = new Map<string, Presence>();
  for (const r of roots) {
    const dir = join(r.dir, 'machines');
    if (!plainDir(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const p = readPresenceFile(join(dir, name));
      if (!p) continue;
      const prev = by.get(p.machine);
      if (!prev || prev.last_seen < p.last_seen) by.set(p.machine, p);
    }
  }
  return [...by.values()]
    .map((p) => ({ ...p, alive: now - Date.parse(p.last_seen) < ALIVE_MS }))
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}
