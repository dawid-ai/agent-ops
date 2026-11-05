import type { ChannelMessage, UserConfig } from '@agent-ops/core';
import {
  assertActor,
  checkRoot,
  editUserConfig,
  isHuman,
  masterRoot,
  OpsError,
  parseDuration,
  samePath,
  sameRoot,
  setRootMirror,
} from '@agent-ops/core';
import type { OpsdConfig, RoleConfig, RuntimeConfig, ScheduleConfig } from './config.js';
import { DEFAULT_RUNTIMES, opsdConfig, roleLimits, stateDir } from './config.js';
import { checkNotify, checkWebhook } from './notify.js';
import { resolveCommand } from './proc.js';
import { seedDoc } from './seed.js';
import type { Supervisor } from './supervisor.js';

type Document = Parameters<Parameters<typeof editUserConfig>[1]>[0];
import { scheduleDue } from './supervisor.js';

// The desktop's Settings, Schedules and Standups views. Settings change a fixed set of keys only.
// A provider's program, arguments and removed environment change through the desktop's main
// process after a system dialog (`editRuntime`), and agent working folders stay file-only, so
// nobody holding the API token can make opsd start a program of their choice. Through the API a
// provider can only be removed or reset to its seeded default, which starts a known program.

/** Top-level opsd keys the settings view may change, and the smallest value each takes. */
const COUNTS: Record<string, number> = {
  max_runs: 0,
  review_backlog: 1,
  budget_minutes: 1,
  wake_cooldown_minutes: 0,
  usage_cooldown_minutes: 1,
};
const AMOUNTS = ['min_free_gb'];
const ROLE_COUNTS = ['per_project', 'max_live', 'burst', 'max_children'] as const;
/** Provider keys the API sets: limits and the model, never what program starts. */
const RUNTIME_KEYS = ['max_live', 'pause_at', 'paused', 'model'];
const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

export interface SettingsView {
  path: string;
  me: string | null;
  roots: string[];
  /** The Agent Ops Master Repo, from the user config. */
  master: string | null;
  /** Every root opsd loads, with its part in the Master Repo setup. */
  rootList: RootInfo[];
  notify: { webhook: boolean; kinds: string[] | null };
  /** Effective values, defaults included. */
  opsd: Pick<
    OpsdConfig,
    | 'max_runs'
    | 'paused'
    | 'min_free_gb'
    | 'usage_pause_at'
    | 'review_backlog'
    | 'budget_minutes'
    | 'wake_cooldown_minutes'
    | 'usage_cooldown_minutes'
    | 'sync'
    | 'port'
    | 'tick_seconds'
  > & {
    runtimes: Record<string, RuntimeView>;
    roles: Record<string, ReturnType<typeof roleLimits>>;
    agents: Record<string, { wake?: boolean; budget?: string; model?: string }>;
    /** The default providers were written into the file; see `seedUserConfig`. */
    seeded: boolean;
  };
  /** Default providers the config does not list, with whether their program is on PATH. */
  missingDefaults: Array<{ name: string; command: string; found: string | null }>;
  /** Keys the file sets, so the page can tell a default from a chosen value. */
  set: string[];
}

/**
 * A runtime as Settings shows it. The API shows the command but never sets it: the desktop's
 * main process does, after a system dialog.
 */
export interface RuntimeView {
  command: string;
  args?: string[];
  unset_env?: string[];
  model?: string;
  max_live?: number;
  pause_at?: number;
  paused: boolean;
  /** A seeded provider (`claude`, `codex`): "Reset to default" restores this entry. */
  default: RuntimeConfig | null;
  /** Where the command was found on opsd's PATH, or null when it was not. */
  found: string | null;
  /** Agents that run on it: in the opsd config or with a role file. */
  agents: string[];
}

/** Agents whose id starts with `<runtime>:`, from the opsd config and the role files. */
function agentsOn(sup: Supervisor, runtime: string): string[] {
  const ids = [
    ...Object.keys(sup.config.agents),
    ...sup
      .ws()
      .agents()
      .map((a) => a.id),
  ];
  return [...new Set(ids.filter((id) => id.split(':')[0] === runtime))].sort();
}

export function settingsView(sup: Supervisor): SettingsView {
  const cfg = sup.config;
  const user = sup.userConfig;
  // Roles the config names, the usual ones, and the roles of known agents.
  const roleNames = new Set([
    'engineer',
    'qa',
    'reviewer',
    'pm',
    ...Object.keys(cfg.roles),
    ...sup
      .ws()
      .agents()
      .map((a) => a.id.split(':')[1] ?? ''),
  ]);
  roleNames.delete('');
  roleNames.delete('*');
  const raw = (user as { opsd?: Record<string, unknown> }).opsd ?? {};
  const { env } = sup.context;
  return {
    path: sup.configPath,
    me: user.me ?? null,
    roots: (user.roots ?? []).map(String),
    master: user.master ?? null,
    rootList: rootList(sup),
    // Whether a webhook is set, never the URL: it is a secret.
    notify: { webhook: Boolean(cfg.notify.webhook), kinds: cfg.notify.kinds ?? null },
    opsd: {
      max_runs: cfg.max_runs,
      paused: cfg.paused,
      min_free_gb: cfg.min_free_gb,
      usage_pause_at: cfg.usage_pause_at,
      review_backlog: cfg.review_backlog,
      budget_minutes: cfg.budget_minutes,
      wake_cooldown_minutes: cfg.wake_cooldown_minutes,
      usage_cooldown_minutes: cfg.usage_cooldown_minutes,
      sync: cfg.sync,
      port: cfg.port,
      tick_seconds: cfg.tick_seconds,
      runtimes: Object.fromEntries(
        Object.entries(cfg.runtimes).map(([n, r]): [string, RuntimeView] => [
          n,
          {
            command: r.command,
            args: r.args,
            unset_env: r.unset_env,
            model: r.model,
            max_live: r.max_live,
            pause_at: r.pause_at,
            paused: r.paused === true,
            default: Object.hasOwn(DEFAULT_RUNTIMES, n) ? { ...DEFAULT_RUNTIMES[n]! } : null,
            found: resolveCommand(r.command, env),
            agents: agentsOn(sup, n),
          },
        ]),
      ),
      roles: Object.fromEntries([...roleNames].sort().map((r) => [r, roleLimits(cfg, r)])),
      agents: Object.fromEntries(
        Object.entries(cfg.agents).map(([id, a]) => [
          id,
          { wake: a.wake, budget: a.budget, model: a.model },
        ]),
      ),
      seeded: cfg.seeded,
    },
    missingDefaults: Object.entries(DEFAULT_RUNTIMES)
      .filter(([n]) => !Object.hasOwn(cfg.runtimes, n))
      .map(([name, rc]) => ({ name, command: rc.command, found: resolveCommand(rc.command, env) })),
    set: Object.keys(raw),
  };
}

/**
 * A change from the settings view. `null` removes the key, so its default applies again; for a
 * provider or an agent, `null` removes it, and a provider set to `"default"` gets its seeded
 * entry back.
 */
export interface SettingsPatch {
  master?: string | null;
  notify?: { webhook?: string | null; kinds?: string[] | null };
  roots?: string[];
  opsd?: Record<string, unknown> & {
    roles?: Record<string, Record<string, unknown> | null>;
    runtimes?: Record<string, Record<string, unknown> | 'default' | null>;
    agents?: Record<string, Record<string, unknown> | null>;
  };
}

function setOrDelete(doc: Document, path: string[], value: unknown): void {
  if (value === null) doc.deleteIn(path);
  else doc.setIn(path, value);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new OpsError(`${what}: expected an object`, 2);
  }
  return v as Record<string, unknown>;
}

/** Applies a settings change to the user config file, then reloads opsd's config. */
export function applySettings(sup: Supervisor, patch: SettingsPatch): void {
  const p = obj(patch, 'settings');
  for (const k of Object.keys(p)) {
    if (k !== 'roots' && k !== 'opsd' && k !== 'master' && k !== 'notify') {
      throw new OpsError(`settings: '${k}' is not editable`, 2);
    }
  }
  let roots: string[] | undefined;
  if (p.roots !== undefined) {
    if (!Array.isArray(p.roots) || p.roots.some((r) => typeof r !== 'string')) {
      throw new OpsError('roots: use a list of folders', 2);
    }
    roots = [];
    for (const r of p.roots as string[]) {
      if (!r.trim()) continue;
      const ok = checkRoot(r);
      if (!roots.some((x) => sameRoot(x, ok))) roots.push(ok);
    }
  }
  let master: string | null | undefined;
  if (p.master !== undefined) {
    if (p.master !== null && typeof p.master !== 'string') {
      throw new OpsError('master: use a folder, or null to clear it', 2);
    }
    master = typeof p.master === 'string' && p.master.trim() ? checkRoot(p.master) : null;
  }
  let notify: { webhook?: string | null; kinds?: string[] | null } | undefined;
  if (p.notify !== undefined) {
    const n = obj(p.notify, 'notify');
    for (const k of Object.keys(n)) {
      if (k !== 'webhook' && k !== 'kinds') throw new OpsError(`notify.${k}: not a setting`, 2);
    }
    notify = {};
    if (n.webhook !== undefined)
      notify.webhook = n.webhook === null ? null : checkWebhook(n.webhook);
    if (n.kinds !== undefined)
      notify.kinds = n.kinds === null ? null : (checkNotify({ kinds: n.kinds }).kinds ?? null);
  }
  const o = p.opsd === undefined ? {} : obj(p.opsd, 'opsd');
  const runtimes = Object.keys(sup.config.runtimes);
  sup.editConfig(
    (doc) => {
      // Removing or resetting a provider in a config from before seeding would not stick: the
      // defaults fill in what such a config leaves out. Seed it in the same write, as opsd's
      // start does, so a refused change writes nothing.
      if (o.runtimes !== undefined) seedDoc(doc, sup.context.env);
      if (roots) setOrDelete(doc, ['roots'], roots.length > 0 ? roots : null);
      if (master !== undefined) setOrDelete(doc, ['master'], master);
      if (notify?.webhook !== undefined)
        setOrDelete(doc, ['opsd', 'notify', 'webhook'], notify.webhook);
      if (notify?.kinds !== undefined) setOrDelete(doc, ['opsd', 'notify', 'kinds'], notify.kinds);
      for (const [k, v] of Object.entries(o)) {
        // Own keys only: `in` would also pass __proto__, constructor and toString.
        if (
          Object.hasOwn(COUNTS, k) ||
          AMOUNTS.includes(k) ||
          k === 'usage_pause_at' ||
          k === 'sync'
        ) {
          setOrDelete(doc, ['opsd', k], v);
        } else if (k === 'paused') {
          // Resuming removes the key, so the file keeps only what differs from the default.
          setOrDelete(doc, ['opsd', 'paused'], v === false ? null : v);
        } else if (k === 'roles') {
          for (const [role, r] of Object.entries(obj(v, 'opsd.roles'))) {
            if (!NAME_RE.test(role)) throw new OpsError(`opsd.roles: bad role '${role}'`, 2);
            if (r === null) {
              doc.deleteIn(['opsd', 'roles', role]);
              continue;
            }
            for (const [rk, rv] of Object.entries(obj(r, `opsd.roles.${role}`))) {
              const editable: Array<keyof RoleConfig> = [
                ...ROLE_COUNTS,
                'writes',
                'overflow',
                'providers',
              ];
              if (!editable.includes(rk as keyof RoleConfig)) {
                throw new OpsError(`opsd.roles.${role}.${rk} is not editable`, 2);
              }
              setOrDelete(doc, ['opsd', 'roles', role, rk], rv);
            }
          }
        } else if (k === 'runtimes') {
          for (const [name, r] of Object.entries(obj(v, 'opsd.runtimes'))) {
            // `"default"` restores a seeded provider, removed or changed, to its seeded entry.
            if (r === 'default') {
              if (!Object.hasOwn(DEFAULT_RUNTIMES, name)) {
                throw new OpsError(`opsd.runtimes.${name}: not a default provider`, 2);
              }
              doc.setIn(['opsd', 'runtimes', name], doc.createNode({ ...DEFAULT_RUNTIMES[name] }));
              continue;
            }
            if (!runtimes.includes(name)) {
              throw new OpsError(
                `opsd.runtimes: no provider '${name}'; add it in Settings > Providers`,
                2,
              );
            }
            // Removing starts no program, so the API may do it; live runs go on.
            if (r === null) {
              doc.deleteIn(['opsd', 'runtimes', name]);
              continue;
            }
            for (const [rk, rv] of Object.entries(obj(r, `opsd.runtimes.${name}`))) {
              if (!RUNTIME_KEYS.includes(rk)) {
                throw new OpsError(
                  `opsd.runtimes.${name}.${rk} is not editable here; the program, arguments ` +
                    'and environment change in Settings > Providers > Edit',
                  2,
                );
              }
              setOrDelete(doc, ['opsd', 'runtimes', name, rk], rv === '' ? null : rv);
            }
          }
        } else if (k === 'agents') {
          for (const [id, a] of Object.entries(obj(v, 'opsd.agents'))) {
            assertActor(id, 'agent');
            if (isHuman(id) || id.includes('*')) {
              throw new OpsError(`opsd.agents: '${id}' is not one agent`, 2);
            }
            if (a === null) {
              doc.deleteIn(['opsd', 'agents', id]);
              continue;
            }
            if (!doc.hasIn(['opsd', 'agents', id]) || doc.getIn(['opsd', 'agents', id]) === null) {
              // A new agent needs a provider to run on; one whose provider was removed later
              // stays editable, and its runs say why they cannot start.
              const provider = id.split(':')[0]!;
              if (!Object.hasOwn(sup.config.runtimes, provider)) {
                throw new OpsError(
                  `opsd.agents: no provider '${provider}' for ${id}; add it in Settings > Providers first`,
                  2,
                );
              }
              doc.setIn(['opsd', 'agents', id], doc.createNode({}));
            }
            for (const [ak, av] of Object.entries(obj(a, `opsd.agents.${id}`))) {
              if (ak !== 'wake' && ak !== 'budget' && ak !== 'model') {
                throw new OpsError(`opsd.agents.${id}.${ak} is not editable here`, 2);
              }
              // Wake off is the default, so turning it off removes the key; the agent stays.
              setOrDelete(
                doc,
                ['opsd', 'agents', id, ak],
                (ak === 'wake' && av === false) || av === '' ? null : av,
              );
            }
          }
        } else {
          throw new OpsError(`opsd.${k} is not editable here`, 2);
        }
      }
    },
    (next) => {
      const cfg = opsdConfig(next as UserConfig & { opsd?: Partial<OpsdConfig> });
      for (const k of Object.keys(COUNTS)) {
        const v = (cfg as unknown as Record<string, unknown>)[k];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < COUNTS[k]!) {
          throw new OpsError(`opsd.${k}: use a whole number of at least ${COUNTS[k]}`, 2);
        }
      }
    },
  );
}

/**
 * Pauses or resumes opsd in the user config, whether or not opsd runs: a running opsd applies it
 * once it reads the file again (`POST /api/settings` with an empty patch); a stopped one starts
 * paused. For the CLI and the desktop's tray, which may act while opsd is down.
 */
export function setPaused(env: NodeJS.ProcessEnv, paused: boolean): void {
  if (
    env.OPS_RUN_TOKEN &&
    env.OPS_RUN_STATE_DIR &&
    samePath(env.OPS_RUN_STATE_DIR, stateDir(env))
  ) {
    throw new OpsError(
      `${paused ? 'pausing' : 'resuming'} opsd is for the human; use \`ops ask\` to request it`,
    );
  }
  editUserConfig(
    env,
    (doc) => setOrDelete(doc, ['opsd', 'paused'], paused ? true : null),
    (next) => void opsdConfig(next as UserConfig & { opsd?: Partial<OpsdConfig> }),
  );
}

// ---- Runtimes ----------------------------------------------------------------------------------

/** What the desktop's add-provider form sends. */
export interface RuntimeInput {
  command: string;
  args?: string[];
  unset_env?: string[];
}

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Checks a runtime name and its command line; returns the config entry to write. */
export function checkRuntime(name: unknown, input: unknown): RuntimeConfig {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === 'human') {
    throw new OpsError(
      `bad runtime name '${String(name)}': use lowercase letters, digits and hyphens`,
      2,
    );
  }
  const i = obj(input, `runtime ${name}`);
  for (const k of Object.keys(i)) {
    if (k !== 'command' && k !== 'args' && k !== 'unset_env') {
      throw new OpsError(`runtime ${name}: '${k}' is not a runtime field`, 2);
    }
  }
  const command = typeof i.command === 'string' ? i.command.trim() : '';
  if (!command || command.length > 400 || /[\r\n\0]/.test(command)) {
    throw new OpsError(`runtime ${name}: give the program to start, such as hermes`, 2);
  }
  // An empty argument is a real value (`--prefix ""`), so arguments keep it; an empty
  // environment name means nothing and is dropped.
  const strings = (
    v: unknown,
    what: string,
    max: number,
    keepEmpty: boolean,
  ): string[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || /[\r\n\0]/.test(s))) {
      throw new OpsError(`runtime ${name}: ${what} must be a list of single-line values`, 2);
    }
    if (v.length > max) throw new OpsError(`runtime ${name}: at most ${max} ${what}`, 2);
    const out = keepEmpty ? [...(v as string[])] : (v as string[]).filter((s) => s !== '');
    return out.length > 0 ? out : undefined;
  };
  const args = strings(i.args, 'arguments', 40, true);
  const unset = strings(i.unset_env, 'environment names', 40, false);
  for (const e of unset ?? []) {
    if (!ENV_RE.test(e)) throw new OpsError(`runtime ${name}: bad environment name '${e}'`, 2);
  }
  return { command, args, unset_env: unset };
}

/**
 * Adds or replaces (`input`) or removes (`null`) a runtime in the user config at `env`. Only the
 * desktop's main process calls this, after the person confirmed the exact command in a system
 * dialog; opsd's HTTP API never changes what program a run starts. Seeded providers are edited
 * and removed like any other. Limits, the model and `paused` of a replaced runtime stay.
 */
export function editRuntime(env: NodeJS.ProcessEnv, name: string, input: unknown): void {
  const rc = input === null ? null : checkRuntime(name, input);
  editUserConfig(
    env,
    (doc) => {
      // A config from before seeding would bring a removed default back; seed it in this write.
      seedDoc(doc, env);
      if (rc === null) {
        doc.deleteIn(['opsd', 'runtimes', name]);
        return;
      }
      for (const k of ['command', 'args', 'unset_env'] as const) {
        setOrDelete(doc, ['opsd', 'runtimes', name, k], rc[k] ?? null);
      }
    },
    (next) => {
      opsdConfig(next as UserConfig & { opsd?: Partial<OpsdConfig> });
    },
  );
}

// ---- Who can be addressed ----------------------------------------------------------------------

/** One id the desktop offers in its agent pickers, and why it is there. */
export interface DirectoryEntry {
  id: string;
  /** `role`: a role file; `config`: named in opsd.agents; `runtime`: a runtime with a usual
   * role, runnable without a role file; `seen`: acted in a task lately. */
  source: 'role' | 'config' | 'runtime' | 'seen';
  /**
   * A write that hands it work (owner, reviewer, delegate, question target) accepts it without
   * `--force`: a role file or an opsd.agents entry, or any id while the store defines no agent.
   * `runtime` and `seen` ids are false then; pickers that set an owner must not offer them.
   */
  configured: boolean;
  name?: string;
  description?: string;
  status?: string;
  /** Its runtime is paused in Settings. */
  paused?: boolean;
}

/** Built-in roles every runtime can run without a role file. */
export const BUILTIN_ROLES = ['engineer', 'qa', 'reviewer', 'pm'];

/**
 * Everyone the human can notify or hand work to: role files, agents the opsd config names,
 * each runtime with the usual roles, and agents seen in recent task activity. Each entry says
 * whether a write accepts it (`configured`), the same check `ops assign` and `ops new` run.
 */
export function agentDirectory(sup: Supervisor): DirectoryEntry[] {
  const ws = sup.ws();
  const cfg = sup.config;
  const out: DirectoryEntry[] = [];
  const seen = new Set<string>();
  const paused = (id: string): boolean | undefined =>
    cfg.runtimes[id.split(':')[0] ?? '']?.paused ? true : undefined;
  const add = (e: Omit<DirectoryEntry, 'configured'>): void => {
    if (seen.has(e.id) || isHuman(e.id)) return;
    seen.add(e.id);
    out.push({ ...e, configured: ws.unreachable(e.id) === null, paused: paused(e.id) });
  };
  const defs = ws.agents();
  for (const a of defs) {
    add({ id: a.id, source: 'role', name: a.name, description: a.description, status: a.status });
  }
  for (const id of Object.keys(cfg.agents)) add({ id, source: 'config' });
  const roles = new Set([
    ...BUILTIN_ROLES,
    ...Object.keys(cfg.roles),
    ...defs.map((a) => a.id.split(':')[1] ?? ''),
  ]);
  roles.delete('');
  roles.delete('*');
  for (const rt of Object.keys(cfg.runtimes)) {
    for (const role of roles) add({ id: `${rt}:${role}`, source: 'runtime' });
  }
  for (const e of ws.activity({ limit: 300 })) {
    const actor = e.actor;
    if (actor && /^[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/.test(actor)) add({ id: actor, source: 'seen' });
  }
  return out;
}

// ---- Schedules ---------------------------------------------------------------------------------

export interface ScheduleView extends ScheduleConfig {
  /** When it last started a run (ISO). */
  last_run: string | null;
  /** When it starts next (ISO), or null when paused. */
  next_run: string | null;
}

/** The next start of a schedule after `now`, to the minute. */
export function nextRun(s: ScheduleConfig, last: number | undefined, now: number): number | null {
  if (s.paused) return null;
  if (s.every) {
    if (last === undefined) return now;
    return Math.max(now, last + parseDuration(s.every) * 60_000);
  }
  if (!s.at) return null;
  if (scheduleDue(s, last, now)) return now;
  const [h, m] = s.at.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h!, m!, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function schedulesView(sup: Supervisor, now = Date.now()): ScheduleView[] {
  const last = sup.scheduleRuns();
  return sup.config.schedules.map((s) => {
    const n = nextRun(s, last[s.name], now);
    return {
      ...s,
      last_run: last[s.name] ? new Date(last[s.name]!).toISOString() : null,
      next_run: n === null ? null : new Date(n).toISOString(),
    };
  });
}

/** Adds a schedule, or changes the one named `previous ?? input.name`. */
export function saveSchedule(
  sup: Supervisor,
  input: Record<string, unknown>,
  previous?: string,
): void {
  const str = (k: string): string | undefined => {
    const v = input[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new OpsError(`schedule ${k}: use text`, 2);
    return v.trim() || undefined;
  };
  const name = str('name');
  if (!name || !NAME_RE.test(name)) {
    throw new OpsError('schedule name: lowercase letters, digits and hyphens', 2);
  }
  const s: ScheduleConfig = {
    name,
    agent: assertActor(str('agent') ?? '', 'agent'),
    ...(str('every') ? { every: str('every') } : {}),
    ...(str('at') ? { at: str('at') } : {}),
    ...(str('prompt') ? { prompt: str('prompt') } : {}),
    ...(str('task') ? { task: str('task') } : {}),
    ...(input.paused === true ? { paused: true } : {}),
  };
  if (input.paused !== undefined && typeof input.paused !== 'boolean') {
    throw new OpsError('schedule paused: use true or false', 2);
  }
  const old = previous ?? name;
  sup.editConfig(
    (doc) => {
      const list = ((
        doc.getIn(['opsd', 'schedules']) as { toJSON?: () => unknown } | undefined
      )?.toJSON?.() ?? []) as ScheduleConfig[];
      const at = list.findIndex((x) => x.name === old);
      if (previous && at < 0) throw new OpsError(`no schedule '${previous}'`, 2);
      if (!previous && at >= 0) throw new OpsError(`schedule '${name}' exists`, 2);
      if (name !== old && list.some((x) => x.name === name)) {
        throw new OpsError(`schedule '${name}' exists`, 2);
      }
      if (at >= 0) {
        // Key by key on the existing entry, so its comments stay.
        const path = ['opsd', 'schedules', at];
        for (const k of SCHEDULE_KEYS) {
          const v = (s as unknown as Record<string, unknown>)[k];
          if (v === undefined) doc.deleteIn([...path, k]);
          else doc.setIn([...path, k], v);
        }
      } else if (doc.hasIn(['opsd', 'schedules'])) doc.addIn(['opsd', 'schedules'], s);
      else doc.setIn(['opsd', 'schedules'], [s]);
    },
    (next) => void opsdConfig(next as UserConfig & { opsd?: Partial<OpsdConfig> }),
  );
}

const SCHEDULE_KEYS = ['name', 'agent', 'every', 'at', 'prompt', 'task', 'paused'] as const;

export function deleteSchedule(sup: Supervisor, name: string): void {
  sup.editConfig((doc) => {
    const list = ((
      doc.getIn(['opsd', 'schedules']) as { toJSON?: () => unknown } | undefined
    )?.toJSON?.() ?? []) as ScheduleConfig[];
    const at = list.findIndex((x) => x.name === name);
    if (at < 0) throw new OpsError(`no schedule '${name}'`, 2);
    doc.deleteIn(['opsd', 'schedules', at]);
  });
}

// ---- Standups ----------------------------------------------------------------------------------

export interface StandupItem {
  task: string;
  title: string;
  at: string;
  note?: string;
}

export interface StandupEntry {
  agent: string;
  done: StandupItem[];
  review: StandupItem[];
  working: StandupItem[];
  blocked: StandupItem[];
  runs: number;
  tokens: number;
  minutes: number;
}

export interface Standup {
  since: string;
  until: string;
  agents: StandupEntry[];
  posts: ChannelMessage[];
}

/**
 * What each agent and person did in the last `hours`, from the task events: closed, sent for
 * review, working on now, blocked on; plus runs and tokens, and posts in `#standup`.
 */
export function standup(sup: Supervisor, hours: number, now = Date.now()): Standup {
  if (!(hours > 0 && hours <= 24 * 31)) throw new OpsError('hours: use 1 to 744', 2);
  const since = now - hours * 3_600_000;
  const sinceIso = new Date(since).toISOString();
  const ws = sup.ws();
  const by = new Map<string, StandupEntry>();
  const entry = (agent: string): StandupEntry => {
    let e = by.get(agent);
    if (!e) {
      e = { agent, done: [], review: [], working: [], blocked: [], runs: 0, tokens: 0, minutes: 0 };
      by.set(agent, e);
    }
    return e;
  };
  for (const t of ws.list({ all: true })) {
    const open = ['claimed', 'in-progress', 'blocked'].includes(t.status);
    if (!open && t.updatedAt < sinceIso) continue;
    const ref = `${t.root}/${t.meta.id}`;
    const title = t.meta.title;
    const { events } = ws.showEvents(ref);
    let author: string | null = null;
    // Claims that lost a race across clones never held the task: they name no author.
    const lost = new Set(t.lostClaims);
    for (const e of events) {
      if ((e.type === 'claim' || e.type === 'start') && !lost.has(e.id)) author = e.actor;
      if (e.at < sinceIso) {
        if (e.type === 'review') author = e.actor;
        continue;
      }
      if (e.type === 'review') {
        author = e.actor;
        entry(e.actor).review.push({ task: ref, title, at: e.at, note: firstLine(e.body) });
      } else if (e.type === 'done') {
        entry(e.actor).done.push({ task: ref, title, at: e.at, note: firstLine(e.body) });
      } else if (e.type === 'verdict' && e.verdict === 'approve' && author) {
        entry(author).done.push({ task: ref, title, at: e.at, note: `approved by ${e.actor}` });
      }
    }
    if ((t.status === 'claimed' || t.status === 'in-progress') && t.claimedBy && !t.stale) {
      entry(t.claimedBy).working.push({
        task: ref,
        title,
        at: t.updatedAt,
        note: t.checkpoint?.summary ? firstLine(t.checkpoint.summary) : undefined,
      });
    }
    // Every task it waited on is closed: it is claimable again, not blocked.
    if (t.status === 'blocked' && !t.unblocked) {
      const blocker = [...events].reverse().find((e) => e.type === 'block' || e.type === 'ask');
      if (blocker) {
        entry(blocker.actor).blocked.push({
          task: ref,
          title,
          at: blocker.at,
          note: t.waitingOn
            ? `waits on ${t.waitingOn}`
            : t.blockedOn.length
              ? `waits on ${t.blockedOn.join(', ')}`
              : firstLine(blocker.body),
        });
      }
    }
  }
  for (const r of sup.runs()) {
    if (r.started_at < sinceIso) continue;
    const e = entry(r.agent);
    e.runs += 1;
    e.tokens += r.tokens;
    const end = r.ended_at ? Date.parse(r.ended_at) : now;
    e.minutes += Math.max(0, Math.round((end - Date.parse(r.started_at)) / 60_000));
  }
  let posts: ChannelMessage[] = [];
  if (ws.channels().some((c) => c.name === 'standup')) {
    posts = ws.channel('standup', { limit: 200 }).filter((m) => m.at >= sinceIso);
  }
  for (const m of posts) entry(m.actor);
  return {
    since: sinceIso,
    until: new Date(now).toISOString(),
    agents: [...by.values()].sort((a, b) => a.agent.localeCompare(b.agent)),
    posts,
  };
}

function firstLine(s: string | undefined): string | undefined {
  const line = s?.trim().split('\n')[0]?.trim();
  if (!line) return undefined;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

export interface RootInfo {
  name: string;
  dir: string;
  /** Mirrors into the Master Repo. */
  mirror: boolean;
  /** A Master Repo copy of a project this machine does not have. */
  isMirror: boolean;
  isMaster: boolean;
}

/** Every root opsd loads, with its part in the Master Repo setup. */
export function rootList(sup: Supervisor): RootInfo[] {
  const ws = sup.ws();
  const master = masterRoot(ws.roots, ws.user);
  return ws.roots.map((r) => ({
    name: r.name,
    dir: r.dir,
    mirror: r.config.mirror === true,
    isMirror: r.isMirror,
    isMaster: master !== undefined && r === master,
  }));
}

/** Turns mirroring on or off for a project root, then reloads opsd's view of it. */
export function mirrorRoot(sup: Supervisor, name: string, on: unknown): RootInfo[] {
  if (typeof on !== 'boolean') throw new OpsError('on: use true or false', 2);
  const ws = sup.ws();
  const root = ws.roots.find((r) => r.name === name && !r.isMirror);
  if (!root) throw new OpsError(`no project root named '${name}'`, 2);
  setRootMirror(root, on, masterRoot(ws.roots, ws.user));
  return rootList(sup);
}
