import { existsSync } from 'node:fs';
import type { UserConfig } from '@agent-ops/core';
import { editUserConfig, readUserConfig, userConfigPath } from '@agent-ops/core';
import type { OpsdConfig } from './config.js';
import { DEFAULT_AGENT_ROLES, DEFAULT_RUNTIMES, SEED_VERSION, opsdConfig } from './config.js';
import { resolveCommand } from './proc.js';

type Document = Parameters<Parameters<typeof editUserConfig>[1]>[0];

export interface SeedResult {
  path: string;
  /** False when the config was seeded before: nothing changed. */
  seeded: boolean;
  /** Providers written, or given their default command. */
  runtimes: string[];
  /** Agents written. */
  agents: string[];
}

export interface SeedOptions {
  /**
   * Also write the default agents, when the config names none: `ops setup`, the desktop's first
   * start, and an opsd that starts with no config file. Not for an existing config, whose agents
   * are its own.
   */
  agents?: boolean;
  /** Whether a provider's program is on PATH; defaults to a PATH lookup in `env`. */
  installed?: (command: string) => boolean;
}

/**
 * Seeds a parsed user config in place, unless it was seeded before (`opsd.seeded`). A config
 * from before seeding keeps every entry it has: a provider entry with limits only gets the
 * default command, and missing defaults are added, because that config ran them all along.
 * Returns what it wrote, or null when the config was seeded already.
 */
export function seedDoc(
  doc: Document,
  env: NodeJS.ProcessEnv,
  opts: SeedOptions = {},
): Omit<SeedResult, 'path' | 'seeded'> | null {
  const raw = (doc.toJS() as { opsd?: Record<string, unknown> } | null)?.opsd ?? {};
  if (raw.seeded !== undefined && raw.seeded !== null) return null;
  const runtimes: string[] = [];
  const agents: string[] = [];
  const have = (raw.runtimes ?? {}) as Record<string, Record<string, unknown> | null>;
  for (const [name, rc] of Object.entries(DEFAULT_RUNTIMES)) {
    const entry = have[name];
    if (entry && typeof entry.command === 'string' && entry.command.trim()) continue;
    if (entry && typeof entry === 'object') {
      doc.setIn(['opsd', 'runtimes', name, 'command'], rc.command);
    } else doc.setIn(['opsd', 'runtimes', name], doc.createNode({ ...rc }));
    runtimes.push(name);
  }
  if (opts.agents && (raw.agents === undefined || raw.agents === null)) {
    const installed = opts.installed ?? ((c: string) => resolveCommand(c, env) !== null);
    const found = Object.entries(DEFAULT_RUNTIMES).filter(([, rc]) => installed(rc.command));
    // Nothing installed yet: seed them all, so the app shows who will run once one is.
    const providers = (found.length > 0 ? found : Object.entries(DEFAULT_RUNTIMES)).map(([n]) => n);
    for (const p of providers) {
      for (const role of DEFAULT_AGENT_ROLES) {
        const id = `${p}:${role}`;
        doc.setIn(['opsd', 'agents', id], doc.createNode({}));
        agents.push(id);
      }
    }
  }
  doc.setIn(['opsd', 'seeded'], SEED_VERSION);
  return { runtimes, agents };
}

/**
 * Writes the default providers, and the default agents when asked, into the user config once, so
 * the config is the only source of providers and agents from then on. Comments and everything
 * else in the file stay. A config already seeded is not touched, so a provider or agent removed
 * in Settings stays removed.
 */
export function seedUserConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: SeedOptions = {},
): SeedResult {
  const path = userConfigPath(env);
  const before = readUserConfig(env) as UserConfig & { opsd?: Record<string, unknown> };
  if (before.opsd?.seeded !== undefined && before.opsd.seeded !== null) {
    return { path, seeded: false, runtimes: [], agents: [] };
  }
  let wrote: ReturnType<typeof seedDoc> = null;
  editUserConfig(
    env,
    (doc) => {
      wrote = seedDoc(doc, env, opts);
    },
    (next) => void opsdConfig(next as UserConfig & { opsd?: Partial<OpsdConfig> }),
  );
  const w = wrote as ReturnType<typeof seedDoc>;
  return { path, seeded: w !== null, runtimes: w?.runtimes ?? [], agents: w?.agents ?? [] };
}

/**
 * Seeds the user config as opsd starts: a config without seeded providers gets them written
 * once, and a machine with no config file at all gets the default agents too. Returns the note
 * for the opsd log, or null when nothing changed.
 */
export function seedOnStart(env: NodeJS.ProcessEnv, opts: SeedOptions = {}): string | null {
  const fresh = !existsSync(userConfigPath(env));
  const r = seedUserConfig(env, { ...opts, agents: fresh });
  if (!r.seeded) return null;
  const parts = [
    r.runtimes.length > 0
      ? `providers ${r.runtimes.join(', ')}`
      : 'no providers (it lists them all)',
    ...(r.agents.length > 0 ? [`agents ${r.agents.join(', ')}`] : []),
  ];
  return `seeded ${r.path}: wrote ${parts.join(' and ')}; edit or remove them in Settings`;
}
