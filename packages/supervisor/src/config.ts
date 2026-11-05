import { cpus, homedir } from 'node:os';
import { join } from 'node:path';
import type { UserConfig } from '@agent-ops/core';
import {
  isActorId,
  isHuman,
  OpsError,
  parseDuration,
  READ_ONLY_ROLES,
  runtimeOf,
} from '@agent-ops/core';
import type { NotifyConfig } from './notify.js';
import { checkNotify } from './notify.js';

/** How to start one runtime. `{prompt}` is not used: the prompt always goes on stdin. */
export interface RuntimeConfig {
  /** Executable name or path, such as `claude` or `codex`. */
  command: string;
  /** Extra arguments placed before the generated ones. */
  args?: string[];
  /**
   * Model for this provider's runs, passed as `--model` (Claude) or `-m` (Codex). An agent's
   * `model` overrides it. Other providers get no model flag: their `args` are the whole line.
   */
  model?: string;
  /** Environment variables removed for this runtime's runs. */
  unset_env?: string[];
  /** Most live runs of this provider on this PC; no limit when unset. */
  max_live?: number;
  /** Overrides `usage_pause_at` for this provider. */
  pause_at?: number;
  /** Paused from Settings: opsd starts no new runs on this provider; live runs go on. */
  paused?: boolean;
}

/** Limits for one role (the part after the colon), counted over every provider. */
export interface RoleConfig {
  /** The role changes files. Default true, except for `qa` and `reviewer`. */
  writes?: boolean;
  /** Most live runs of the role on one project. Default 1 if it writes, else 3. */
  per_project?: number;
  /** Most live runs of the role on all projects; no limit when unset. */
  max_live?: number;
  /**
   * Live runs per project while reviews pile up there (`review_backlog`). Default: twice
   * `per_project` for roles that only read, `per_project` for roles that write.
   */
  burst?: number;
  /** Providers in order of preference for tasks owned by `*:<role>`; default: `runtimes` order. */
  providers?: string[];
  /** Hand a `*:<role>` task to the next provider when the preferred ones have no room. Default true. */
  overflow?: boolean;
  /** Most helper runs (`ops spawn`) one run of this role may have live at once. Default 2. */
  max_children?: number;
}

/**
 * Built-in limits a config entry overrides key by key. One orchestrator run at a time, chat turns
 * included, so two runs never answer one ask differently.
 */
const ROLE_DEFAULTS: Record<string, RoleConfig> = { orchestrator: { max_live: 1 } };

export interface RoleLimits {
  writes: boolean;
  per_project: number;
  max_live?: number;
  burst: number;
  providers: string[];
  overflow: boolean;
  max_children: number;
}

export function roleLimits(cfg: OpsdConfig, role: string): RoleLimits {
  const r = { ...ROLE_DEFAULTS[role], ...cfg.roles[role] };
  const writes = r.writes ?? !READ_ONLY_ROLES.includes(role);
  const perProject = r.per_project ?? (writes ? 1 : 3);
  return {
    writes,
    per_project: perProject,
    max_live: r.max_live,
    burst: Math.max(perProject, r.burst ?? (writes ? perProject : perProject * 2)),
    providers: r.providers ?? Object.keys(cfg.runtimes),
    overflow: r.overflow ?? true,
    max_children: r.max_children ?? 2,
  };
}

export interface AgentRunConfig {
  /** Start a run when the agent has new inbox items or a task to claim. */
  wake?: boolean;
  /** Working directory for its runs; defaults to the top of the root's git repo. */
  cwd?: string;
  /** Default time budget for a run, such as `2h`. */
  budget?: string;
  /** Model for this agent's runs; overrides the role file's and the provider's. */
  model?: string;
}

/** The desktop chat with the PM. */
export interface ChatConfig {
  /** The agent the chat talks to; a Claude agent, since each turn resumes its session. */
  agent: string;
  /** Channel posts that mention the agent continue the chat. */
  mentions: boolean;
  /** Time budget of one turn, such as `20m`; defaults to the agent's budget. */
  budget?: string;
}

export const DEFAULT_CHAT_AGENT = 'claude:pm';

export interface ScheduleConfig {
  name: string;
  /** Interval such as `30m` or `24h`. */
  every?: string;
  /** Daily local time such as `09:00`. */
  at?: string;
  /** The agent to run. */
  agent: string;
  /** The prompt; defaults to the standard work-the-queue prompt. */
  prompt?: string;
  task?: string;
  /** Kept in the config but starts no runs. */
  paused?: boolean;
}

/**
 * Merging approved work of one root (`opsd.merge.<root name>`). Kept per machine, in the user
 * config: the commands run here, and a task store's shared config never names what opsd runs.
 */
export interface MergeConfig {
  /** The branch approved work goes into, such as `v2`. */
  base: string;
  /** The checkout the base is built in; defaults to the top of the root's git repo. */
  checkout?: string;
  /** Commands that must pass on the rebased work before the base moves, run in opsd's worktree. */
  checks?: string[];
  /** Commands run in `checkout` after the base moved, such as `npm run build`. */
  build?: string[];
  /** Minutes each command may take; default 30. */
  timeout_minutes?: number;
}

/** The `opsd` section of the user config. */
export interface OpsdConfig {
  port: number;
  /** Seconds between supervisor ticks. */
  tick_seconds: number;
  /** Seconds between looks at the processes of live runs. */
  proc_seconds: number;
  /** Most live runs on this PC; defaults to the number of CPU cores. */
  max_runs: number;
  /**
   * Paused from the app, its tray icon or `ops daemon pause`: no new runs or schedules start. Live
   * runs, their helper runs, sync and the API go on. It stays paused until resumed.
   */
  paused: boolean;
  /** No new run while the PC has less free memory than this, in GB. */
  min_free_gb: number;
  /**
   * Share of a provider's usage window (0 to 1) at which opsd starts no new runs on it until the
   * window resets. The rest stays for the human's own sessions.
   */
  usage_pause_at: number;
  roles: Record<string, RoleConfig>;
  /** Minutes to pause a provider whose usage-limit error names no reset time. */
  usage_cooldown_minutes: number;
  /**
   * Tasks waiting for review in one project at which opsd starts no new work there for roles
   * that write, and lets reviewers burst, so reviews catch up before more work piles on.
   */
  review_backlog: number;
  /** Default run budget in minutes when neither the task nor the agent sets one. */
  budget_minutes: number;
  /** Minutes before the same agent is woken again for the same items. */
  wake_cooldown_minutes: number;
  /** Commit, pull and push each root when its sync policy says so. */
  sync: boolean;
  /**
   * The default providers were written into the file (`opsd.seeded`). From then on the file's
   * `runtimes` are the only providers; before, the defaults fill in what the file leaves out.
   */
  seeded: boolean;
  runtimes: Record<string, RuntimeConfig>;
  agents: Record<string, AgentRunConfig>;
  schedules: ScheduleConfig[];
  /**
   * Create tasks from the roots' repeats (`repeats/*.md`) each tick. On by default; set it to
   * false on every PC but one that shares a task store, so two PCs never fire the same slot.
   */
  repeats: boolean;
  /** Webhook notifications for the human; the URL is a secret and stays in the user config. */
  notify: NotifyConfig;
  chat: ChatConfig;
  /** Roots whose approved branches opsd merges, by root name. */
  merge: Record<string, MergeConfig>;
  /**
   * Per root name, whether opsd pushes the repo's task branches with new commits at each sync and
   * deletes a merged one's remote branch. On for every root unless set to false.
   */
  push_branches: Record<string, boolean>;
}

export const DEFAULT_PORT = 4747;

/**
 * The providers `ops setup`, the desktop's first start and opsd's first start write into the
 * user config (see `seedUserConfig`), and what "Reset to default" restores. After seeding, the
 * config is the only source of providers: code reads these for seeding and resetting only.
 */
export const DEFAULT_RUNTIMES: Record<string, RuntimeConfig> = {
  claude: { command: 'claude' },
  // Runs inherit opsd's environment and act as the human's accounts; task events record which
  // agent did what. Codex's sandbox blocks network and `.git` writes on its own.
  codex: { command: 'codex' },
};

/** Roles seeded as agents for each installed default provider, such as `claude:engineer`. */
export const DEFAULT_AGENT_ROLES = ['engineer', 'qa', 'reviewer', 'pm'];

/** Written as `opsd.seeded`; bump it when the seed adds something a seeded config should get. */
export const SEED_VERSION = 1;

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/;

/** Checks a model name: one word that cannot read as a flag, such as `opus` or `gpt-5-codex`. */
export function checkModel(v: unknown, where: string): string {
  if (typeof v !== 'string' || !MODEL_RE.test(v)) {
    throw new OpsError(
      `${where}: name a model such as opus or gpt-5-codex (letters, digits and . _ : / @ - [ ])`,
      2,
    );
  }
  return v;
}

/**
 * The runtimes opsd starts. A seeded config lists every provider itself, so a removed one stays
 * removed. An older config gets the defaults with its entries merged into each by key, as
 * before, so a limit set from Settings (`runtimes.codex.max_live`) keeps the default command.
 */
function mergeRuntimes(raw: unknown, seeded: boolean): Record<string, RuntimeConfig> {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new OpsError('opsd.runtimes: use one entry per provider name', 2);
  }
  const out: Record<string, RuntimeConfig> = {};
  if (!seeded) for (const [name, rc] of Object.entries(DEFAULT_RUNTIMES)) out[name] = { ...rc };
  for (const [name, rc] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (rc === null || typeof rc !== 'object') {
      throw new OpsError(`opsd.runtimes.${name}: expected command, args and limits`, 2);
    }
    const merged = { ...out[name], ...rc } as RuntimeConfig;
    if (typeof merged.command !== 'string' || !merged.command.trim()) {
      throw new OpsError(`opsd.runtimes.${name}.command: name the program to start`, 2);
    }
    out[name] = merged;
  }
  return out;
}

export function opsdConfig(user: UserConfig & { opsd?: Partial<OpsdConfig> }): OpsdConfig {
  const raw = user.opsd ?? {};
  const seeded = (raw as { seeded?: unknown }).seeded !== undefined;
  const cfg: OpsdConfig = {
    port: raw.port ?? DEFAULT_PORT,
    tick_seconds: raw.tick_seconds ?? 15,
    proc_seconds: raw.proc_seconds ?? 5,
    max_runs: raw.max_runs ?? Math.max(1, cpus().length),
    paused: raw.paused ?? false,
    min_free_gb: raw.min_free_gb ?? 4,
    usage_pause_at: raw.usage_pause_at ?? 0.9,
    roles: raw.roles ?? {},
    review_backlog: raw.review_backlog ?? 3,
    usage_cooldown_minutes: raw.usage_cooldown_minutes ?? 30,
    budget_minutes: raw.budget_minutes ?? 180,
    wake_cooldown_minutes: raw.wake_cooldown_minutes ?? 10,
    sync: raw.sync ?? true,
    seeded,
    runtimes: mergeRuntimes(raw.runtimes, seeded),
    // `claude:qa:` with nothing after it names the agent with no settings of its own.
    agents: Object.fromEntries(Object.entries(raw.agents ?? {}).map(([id, a]) => [id, a ?? {}])),
    schedules: raw.schedules ?? [],
    repeats: raw.repeats ?? true,
    notify: checkNotify((raw as { notify?: unknown }).notify),
    chat: {
      agent: raw.chat?.agent ?? DEFAULT_CHAT_AGENT,
      mentions: raw.chat?.mentions ?? true,
      budget: raw.chat?.budget,
    },
    merge: checkMerge((raw as { merge?: unknown }).merge),
    push_branches: checkPushBranches((raw as { push_branches?: unknown }).push_branches),
  };
  const count = (v: unknown, name: string, min: number): void => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
      throw new OpsError(`opsd.${name}: use a whole number of at least ${min}`, 2);
    }
  };
  const amount = (v: unknown, name: string): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new OpsError(`opsd.${name}: use a number of at least 0`, 2);
    }
  };
  count(cfg.max_runs, 'max_runs', 0);
  if (typeof cfg.paused !== 'boolean') throw new OpsError('opsd.paused: use true or false', 2);
  if (typeof cfg.repeats !== 'boolean') throw new OpsError('opsd.repeats: use true or false', 2);
  amount(cfg.min_free_gb, 'min_free_gb');
  amount(cfg.tick_seconds, 'tick_seconds');
  amount(cfg.proc_seconds, 'proc_seconds');
  if (!(cfg.tick_seconds > 0 && cfg.proc_seconds > 0)) {
    throw new OpsError('opsd.tick_seconds and opsd.proc_seconds must be above 0', 2);
  }
  for (const [name, rc] of Object.entries(cfg.runtimes)) {
    if (rc.max_live !== undefined) count(rc.max_live, `runtimes.${name}.max_live`, 0);
    if (rc.paused !== undefined && typeof rc.paused !== 'boolean') {
      throw new OpsError(`opsd.runtimes.${name}.paused: use true or false`, 2);
    }
    if (rc.model !== undefined) checkModel(rc.model, `opsd.runtimes.${name}.model`);
  }
  for (const [name, r] of Object.entries(cfg.roles)) {
    if (r.per_project !== undefined) count(r.per_project, `roles.${name}.per_project`, 0);
    if (r.max_live !== undefined) count(r.max_live, `roles.${name}.max_live`, 0);
    if (r.burst !== undefined) count(r.burst, `roles.${name}.burst`, 0);
    if (r.max_children !== undefined) count(r.max_children, `roles.${name}.max_children`, 0);
    for (const key of ['writes', 'overflow'] as const) {
      if (r[key] !== undefined && typeof r[key] !== 'boolean') {
        throw new OpsError(`opsd.roles.${name}.${key}: use true or false`, 2);
      }
    }
    if (
      r.providers !== undefined &&
      (!Array.isArray(r.providers) || r.providers.some((p) => typeof p !== 'string'))
    ) {
      throw new OpsError(`opsd.roles.${name}.providers: use a list of runtime names`, 2);
    }
  }
  count(cfg.review_backlog, 'review_backlog', 1);
  count(cfg.budget_minutes, 'budget_minutes', 1);
  count(cfg.wake_cooldown_minutes, 'wake_cooldown_minutes', 0);
  if (typeof cfg.sync !== 'boolean') throw new OpsError('opsd.sync: use true or false', 2);
  for (const [id, a] of Object.entries(cfg.agents)) {
    if (a.wake !== undefined && typeof a.wake !== 'boolean') {
      throw new OpsError(`opsd.agents.${id}.wake: use true or false`, 2);
    }
    if (a.budget !== undefined) {
      // Text only: a bare number would pass here and crash the agent's next launch.
      if (typeof a.budget !== 'string') {
        throw new OpsError(`opsd.agents.${id}.budget: use a duration such as 90m or 2h`, 2);
      }
      parseDuration(a.budget);
    }
    if (a.model !== undefined) checkModel(a.model, `opsd.agents.${id}.model`);
  }
  count(cfg.usage_cooldown_minutes, 'usage_cooldown_minutes', 1);
  if (
    typeof cfg.usage_pause_at !== 'number' ||
    !(cfg.usage_pause_at > 0 && cfg.usage_pause_at <= 1)
  ) {
    throw new OpsError('opsd.usage_pause_at: use a share from 0 to 1, such as 0.9', 2);
  }
  for (const [name, rc] of Object.entries(cfg.runtimes)) {
    if (
      rc.pause_at !== undefined &&
      (typeof rc.pause_at !== 'number' || !(rc.pause_at > 0 && rc.pause_at <= 1))
    ) {
      throw new OpsError(`opsd.runtimes.${name}.pause_at: use a share from 0 to 1`, 2);
    }
  }
  checkChat(cfg.chat);
  const names = new Set<string>();
  for (const s of cfg.schedules) {
    if (names.has(s.name)) throw new OpsError(`opsd.schedules: '${s.name}' appears twice`, 2);
    names.add(s.name);
    if (!s.name || !s.agent)
      throw new OpsError('opsd.schedules: each needs a name and an agent', 2);
    if (!s.every === !s.at) {
      throw new OpsError(`opsd.schedules.${s.name}: set exactly one of every or at`, 2);
    }
    if (s.every) parseDuration(s.every);
    if (s.paused !== undefined && typeof s.paused !== 'boolean') {
      throw new OpsError(`opsd.schedules.${s.name}: paused is true or false`, 2);
    }
    if (s.at && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(s.at)) {
      throw new OpsError(`opsd.schedules.${s.name}: at must be a time from 00:00 to 23:59`, 2);
    }
  }
  return cfg;
}

function checkChat(c: ChatConfig): void {
  if (typeof c.agent !== 'string' || !isActorId(c.agent) || isHuman(c.agent)) {
    throw new OpsError('opsd.chat.agent: name an agent such as claude:pm', 2);
  }
  if (c.agent.includes('*')) {
    throw new OpsError('opsd.chat.agent: name one agent, not a wildcard', 2);
  }
  // Only Claude runs get a session to resume and a streamed reply (see `invocation`); on any
  // other runtime each turn would forget the last and the view would show no reply.
  if (runtimeOf(c.agent) !== 'claude') {
    throw new OpsError(
      'opsd.chat.agent: the chat runs on Claude for now (it resumes a session)',
      2,
    );
  }
  if (typeof c.mentions !== 'boolean') {
    throw new OpsError('opsd.chat.mentions: use true or false', 2);
  }
  if (c.budget !== undefined) {
    if (typeof c.budget !== 'string') {
      throw new OpsError('opsd.chat.budget: use a duration such as 20m', 2);
    }
    parseDuration(c.budget);
  }
}

function checkPushBranches(raw: unknown): Record<string, boolean> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError('opsd.push_branches: use one entry per root name, true or false', 2);
  }
  for (const [root, on] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof on !== 'boolean') {
      throw new OpsError(`opsd.push_branches.${root}: use true or false`, 2);
    }
  }
  return { ...(raw as Record<string, boolean>) };
}

function checkMerge(raw: unknown): Record<string, MergeConfig> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError('opsd.merge: use one entry per root name, each with a base branch', 2);
  }
  const out: Record<string, MergeConfig> = {};
  const commands = (v: unknown, name: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((c) => typeof c !== 'string' || !c.trim())) {
      throw new OpsError(`opsd.merge.${name}: use a list of commands`, 2);
    }
    return v as string[];
  };
  for (const [root, m] of Object.entries(raw as Record<string, unknown>)) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      throw new OpsError(`opsd.merge.${root}: set base, and checks and build if needed`, 2);
    }
    const e = m as Record<string, unknown>;
    if (typeof e.base !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(e.base)) {
      throw new OpsError(`opsd.merge.${root}.base: name the branch to merge into`, 2);
    }
    if (e.checkout !== undefined && (typeof e.checkout !== 'string' || !e.checkout.trim())) {
      throw new OpsError(`opsd.merge.${root}.checkout: use a folder path`, 2);
    }
    const t = e.timeout_minutes;
    if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t < 1)) {
      throw new OpsError(`opsd.merge.${root}.timeout_minutes: use a whole number of at least 1`, 2);
    }
    out[root] = {
      base: e.base,
      checkout: e.checkout as string | undefined,
      checks: commands(e.checks, `${root}.checks`),
      build: commands(e.build, `${root}.build`),
      timeout_minutes: t as number | undefined,
    };
  }
  return out;
}

/** Machine-local supervisor state: run records, logs, the API token. Never committed. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPS_STATE_DIR ?? join(homedir(), '.agent-ops', 'opsd');
}
