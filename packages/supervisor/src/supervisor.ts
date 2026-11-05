import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { freemem } from 'node:os';
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import type { AgentDef, Priority, Root, Route, TaskView, UserConfig } from '@agent-ops/core';
import type { SyncResult } from '@agent-ops/core';
import {
  assertActor,
  canClaimType,
  editUserConfig,
  formatMinutes,
  OpsError,
  parseDuration,
  redactSecrets,
  parseTokens,
  isHuman,
  isWildcard,
  ownerMatches,
  readUserConfig,
  roleInactive,
  roleOf,
  runtimeOf,
  mirrorPartners,
  presenceSlug,
  projectRefs,
  QUESTION_TYPE,
  READ_ONLY_CAN_CLAIM,
  takesGroupWork,
  taskRefs,
  writePresence,
  syncAll,
  syncDue,
  storeBranch,
  ulid,
  userConfigPath,
  Workspace,
} from '@agent-ops/core';
import { Checkout, leftoverBranch } from './checkout.js';
import type { MergeConfig, OpsdConfig, ScheduleConfig } from './config.js';
import type { CommandResult, CommandWatch, MergeSource } from './merge.js';
import { CommandRunner, MergeRepo, mergeSource } from './merge.js';
import type { NotifyItem } from './notify.js';
import { BranchPusher, gitError } from './push.js';
import { dropEnv, runEnv } from './runenv.js';
import { Notifier } from './notify.js';
import { opsdConfig, roleLimits, stateDir } from './config.js';
import type { ProviderUsage, UsageState } from './quota.js';
import {
  claudeUsage,
  codexHome,
  codexUsage,
  findRollout,
  lastCodexLimits,
  mergeUsage,
  usagePause,
} from './quota.js';
import type { Launch, Spawned } from './proc.js';
import {
  isAlive,
  killTree,
  processStart,
  processStartSync,
  resolveCommand,
  RUNS_OUTLIVE_OPSD,
  spawnHidden,
} from './proc.js';
import type { KillResult, ProcEntry, ProcInfo, ProcLedger, ProcLister, ProcView } from './procs.js';
import { applyKills, startMs, survivors, systemLister, track, viewLedger } from './procs.js';
import type { Leftovers, RunRecord } from './runs.js';
import { RunStore } from './runs.js';
import { Chat } from './chat.js';
import type { ChatInvocation, QuestionPrompt } from './runtimes.js';
import { invocation, runPrompt, withStoreCheckoutRule } from './runtimes.js';
import { UsageMeter } from './usage.js';

/** Most referenced tasks a question's prompt lists; the agent reads more with `ops show`. */
const QUESTION_REFS = 20;

/**
 * What a question run's prompt carries (AO-0063): who asked, the question, and each task and
 * project the text references, so the agent starts with the context the asker pointed at.
 * References that resolve to no task are left out; the question text still has them.
 */
export function questionPrompt(ws: Workspace, ref: string, v: TaskView): QuestionPrompt {
  const shown = ws.showEvents(ref);
  const body = shown.body.trim();
  // Earlier rounds (AO-0134): each answer (`done`) and each reply the asker reopened it with.
  const rounds: QuestionPrompt['rounds'] = [];
  for (const e of shown.events) {
    const said = e.body.trim();
    if (!said) continue;
    if (e.type === 'done') rounds.push({ from: e.actor, kind: 'answer', text: said });
    else if (e.type === 'reopen') rounds.push({ from: e.actor, kind: 'reply', text: said });
  }
  const text = [
    v.meta.title,
    body,
    ...rounds.filter((r) => r.kind === 'reply').map((r) => r.text),
  ].join('\n');
  const tasks: QuestionPrompt['tasks'] = [];
  for (const r of taskRefs(text)) {
    if (tasks.length >= QUESTION_REFS) break;
    try {
      const t = ws.view(r);
      if (t.root === v.root && t.meta.id === v.meta.id) continue;
      tasks.push({ ref: r, status: t.status, title: t.meta.title });
    } catch {
      // Not a task this workspace can see: the question text keeps the reference.
    }
  }
  return {
    from: v.meta.created_by,
    title: v.meta.title,
    body,
    tasks,
    projects: projectRefs(text),
    ...(rounds.length > 0 ? { rounds } : {}),
  };
}

/** Why nothing starts while opsd is paused. */
export const PAUSED =
  'opsd is paused: resume it in Settings, from the tray icon or with `ops daemon resume`';

/** Why no run starts on a provider the config does not list, such as one removed in Settings. */
export function noProvider(provider: string): string {
  return `no provider '${provider}' in Settings > Providers: add it back, or hand the work to an agent of another provider`;
}

/** Why a stop that keeps runs is refused where runs end with opsd. */
export function liveRunsEndMessage(live: number): string {
  const runs = live === 1 ? '1 live run' : `${live} live runs`;
  return `${runs} would end with opsd on this system: stop with --kill-runs to end them, or pause new runs and stop after they finish`;
}

export interface SupervisorOptions {
  env?: NodeJS.ProcessEnv;
  /** Folder the roots are discovered from. */
  cwd?: string;
  user?: UserConfig;
  config?: OpsdConfig;
  stateDir?: string;
  now?: () => number;
  /** Lists the machine's processes for the run ledgers; defaults to the system lister. */
  procs?: ProcLister;
  /** Free memory in bytes; defaults to the OS figure. */
  freeMem?: () => number;
  /** The build opsd runs, for machine presence. */
  build?: string;
  version?: string;
  /** Whether runs outlive this opsd; defaults to the platform's `RUNS_OUTLIVE_OPSD`. */
  runsOutlive?: boolean;
}

/** Kill rounds for what an ended run left behind before opsd gives up and warns. */
const REAP_ROUNDS = 3;
/** How long an ended run waits for its killed helpers to end before its wrap-up goes on. */
const HELPER_END_MS = 30_000;
/** How far back the startup sweep looks for ended runs with processes left. */
const SWEEP_DAYS = 7;
/** Reads of an adopted run's creation time, after one at adoption failed, and the wait between. */
const ADOPT_RECHECKS = 5;
const ADOPT_RECHECK_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `sleep` that ends early, without leaving a timer behind, when `signal` aborts. */
function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((r) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      r();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The actor opsd writes merge events, send-backs and notes as. */
export const MERGE_ACTOR = 'opsd:merge';
/** Who tells the human that a checkout's changes hold writing runs (AO-0137), and where. */
export const DIRTY_ACTOR = 'opsd:checkout';
/** Who gives ownerless work a role group as its owner (AO-0140). */
export const ROUTE_ACTOR = 'opsd:router';
const DIRTY_CHANNEL = 'general';
/** Rebase, check and fast-forward rounds before a merge gives up on a base that keeps moving. */
const MERGE_ATTEMPTS = 5;
/** Pause between those rounds. */
const MERGE_RETRY_MS = 2_000;

/** One approved task to merge, and where. */
interface MergeJob {
  cfg: MergeConfig;
  /** The checkout the base is built in. */
  top: string;
  src: MergeSource;
  /** The work as the review names it, such as `abc1234 on branch claude/x`. */
  what: string;
  /** Who gets the task back when the merge fails. */
  author: string;
  /** The root's human, who gets notes on merges opsd cannot do. */
  human?: string;
  root: string;
}

/**
 * A base opsd moved forward whose build has not run to its end, kept in `merge-builds.json` so the
 * next opsd runs it when this one stops during the build.
 */
interface PendingBuild {
  ref: string;
  root: string;
  /** The checkout the base is built in. */
  top: string;
  base: string;
  branch?: string;
  /** The commit the base moved to. */
  commit: string;
  what: string;
  author: string;
  human?: string;
  /** The merge event's text before the build's result; null once the merge event is written. */
  text: string | null;
}

/** A merged task branch whose remote branch opsd deletes once the remote's base has the merge. */
interface PendingDelete {
  /** The repo's checkout, as branch pushing knows it. */
  top: string;
  branch: string;
  /** The commit the reviewer approved; the remote branch is deleted only up to it. */
  approved: string;
  base: string;
  /** The commit the base moved to with the merge. */
  commit: string;
  /** The task, for the log. */
  ref: string;
}

/** What branch pushing keeps between rounds, per repo checkout. */
interface BranchState {
  /** Per repo and branch, the `<tip> <remote tip>` a round left alone. */
  seen: Record<string, Record<string, string>>;
  /** Per repo and branch, the approved commit opsd merged. */
  merged: Record<string, Record<string, string>>;
  deletes: PendingDelete[];
}

export interface LaunchRequest {
  agent: string;
  task?: string;
  /** The whole prompt; defaults to the standard prompt for the agent and task. */
  prompt?: string;
  /** Instructions, such as a schedule's prompt, that the standard prompt carries with its rules. */
  extra?: string;
  cwd?: string;
  /** Time budget such as `2h`; defaults to the delegation, the agent config, then opsd's. */
  budget?: string;
  /** Token budget such as `400k`; defaults to the delegation's. */
  tokens?: string;
  schedule?: string;
  /** Review `task` (it waits for this agent's verdict) instead of claiming it. */
  review?: boolean;
  /**
   * Start a helper of this live run (`ops spawn`): it works under the parent's claim, on the
   * parent's task and in its folder, and stops when the parent ends.
   */
  parent?: string;
  /** A turn of the desktop chat: the Claude session it starts or resumes. */
  chat?: ChatInvocation;
}

interface LiveRun {
  record: RunRecord;
  /** Missing for runs adopted from an earlier opsd: no exit event, only liveness. */
  child?: ChildProcess;
  meter: UsageMeter;
  offset: number;
  /** Keeps a UTF-8 character split across two reads whole. */
  decoder: StringDecoder;
  killReason?: string;
  /** Windows: the launcher, until opsd has recorded its PID and sent it the command. */
  launch?: Launch;
  /** Rate limit events already taken into the usage state. */
  rateLimitsRead?: number;
  /** Codex: the run's session file, once found. */
  rollout?: string;
  /** Usage-limit errors already taken into the usage state. */
  limitHitsRead?: number;
}

interface WakeState {
  keys: string[];
  at: number;
}

/** A writing run that cannot start because its checkout has changes (AO-0137). */
interface DirtyHold {
  agent: string;
  /** The task the run would work on, if any. */
  task?: string;
  /** The first changed file, and how many there are. */
  file: string;
  count: number;
}

/** `dirty-checkouts.json`: the checkouts the human was told about, until each is clean again. */
type DirtyNotices = Record<string, { file: string; at: string }>;

/** A non-review inbox item of an agent: its key, and the task it is about. */
interface InboxKey {
  key: string;
  root: string;
  id: string;
}

type WakeKind = 'review' | 'inbox' | 'task';

/** What a limit check counts: a live run, or one the wake plan has started on paper. */
type PlannedRun = Pick<
  RunRecord,
  'agent' | 'project' | 'root' | 'task' | 'parent' | 'question' | 'inbox' | 'chat'
> & {
  cwd?: string;
};

interface PlanStep {
  c: WakeCandidate;
  /** The agent that starts it, or null when it waits. */
  agent: string | null;
  reason: string;
}

interface WakeCandidate {
  kind: WakeKind;
  /** Review and task candidates: the task. */
  ref?: string;
  root?: string;
  id?: string;
  project: string;
  title: string;
  priority: Priority;
  created: string;
  /** Inbox candidates: the inbox keys to record once a run of the agent started. */
  keys?: string[];
  /** Task candidates: the work resumes after an answer or a change request. */
  resume?: boolean;
  /** The task's owner: one agent, a wildcard, or null for anyone. */
  owner?: string | null;
  /** The reviewer the task expects (a delegation); its provider never takes the task. */
  avoid?: string;
  /** Task candidates: a question to the agent, which role limits do not hold (AO-0063). */
  question?: boolean;
  /** Task candidates: the task type, checked against each agent's `can_claim` (AO-0126). */
  type?: string;
  /** Review runs: the request's `task:event` key, so each request gets one run. */
  key?: string;
  /** Agents that may take it, best first. */
  agents: string[];
}

/** A task waking agents could take, and why no run has started on it. */
export interface WaitItem {
  /** `review`, `inbox` (new items an agent was not started for) or `task` (a claim). */
  kind: 'review' | 'inbox' | 'task';
  /** The task, for reviews and claims. */
  task?: string;
  title: string;
  project: string;
  review: boolean;
  /** Agents that may take it, best first. */
  agents: string[];
  reason: string;
}

/**
 * Events: `run` (a run started, changed or ended), `warn` (message), `tick`, `sync`, `branches`
 * (a round of pushing task branches: repo, remote, pushed, held).
 */
export class Supervisor extends EventEmitter {
  private cfg: OpsdConfig;
  readonly store: RunStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly build?: string;
  private readonly version?: string;
  private user: UserConfig;
  private readonly now: () => number;
  private readonly live = new Map<string, LiveRun>();
  /** Runs whose process ended and whose wrap-up (`wrapUp`) has not finished. */
  private readonly ending = new Map<string, RunRecord>();
  /** Who waits for a run to end and finish its wrap-up. */
  private readonly endWaiters = new Map<string, Array<() => void>>();
  private readonly gitTops = new Map<string, string>();
  /** While wake plans: the changes found per checkout, so each is read once per plan. */
  private changesMemo: Map<string, string[] | Error> | null = null;
  /** During a tick's schedules and wake: writing runs held by a checkout's changes, per checkout. */
  private dirtyHolds: Map<string, DirtyHold> | null = null;
  private timer?: NodeJS.Timeout;
  private procTimer?: NodeJS.Timeout;
  private ticking = false;
  private lister?: ProcLister;
  private readonly listerOpt?: ProcLister;
  /** Process work runs one step at a time, so two snapshots never write one ledger at once. */
  private procChain: Promise<void> = Promise.resolve();
  private killingAll = false;
  private stopping = false;
  /** Aborted by `stop`: cancels background reads that would otherwise keep opsd alive. */
  private readonly stopAbort = new AbortController();
  private closed = false;
  private readonly freeMem: () => number;
  private usage: UsageState;
  /** Whether live runs keep going after this opsd exits; see `RUNS_OUTLIVE_OPSD`. */
  readonly runsOutlive: boolean;
  /** The desktop chat with the orchestrator; each turn is a run under the usual limits. */
  readonly chat: Chat;
  /** The merge under way, if any: its checkout takes no new writing run until it is over. */
  private merging: {
    ref: string;
    top: string;
    base: string;
    runner: CommandRunner;
    done: Promise<void>;
  } | null = null;
  /** The process ledger of the merge command running now, if any. */
  private mergeProc: { ledger: ProcLedger; running: () => boolean } | null = null;
  /** A look at the processes earlier merge commands left behind, before the next merge starts. */
  private mergeClearing: Promise<void> | null = null;
  /** Per task, the last event already looked at for a merge, so unchanged tasks are not read again. */
  private readonly mergeSeen = new Map<string, string>();

  constructor(opts: SupervisorOptions = {}) {
    super();
    this.env = opts.env ?? process.env;
    this.cwd = opts.cwd ?? process.cwd();
    this.user = opts.user ?? readUserConfig(this.env);
    this.cfg = opts.config ?? opsdConfig(this.user);
    this.store = new RunStore(opts.stateDir ?? stateDir(this.env));
    this.now = opts.now ?? Date.now;
    this.listerOpt = opts.procs;
    this.freeMem = opts.freeMem ?? freemem;
    this.build = opts.build;
    this.version = opts.version;
    this.runsOutlive = opts.runsOutlive ?? RUNS_OUTLIVE_OPSD;
    this.usage = this.store.readJson<UsageState>('usage.json', {});
    this.chat = new Chat(this, this.now);
  }

  /** The opsd section of the user config, with defaults; `reloadConfig` replaces it. */
  get config(): OpsdConfig {
    return this.cfg;
  }

  /**
   * Reads the user config again after the app changed it: roots, limits, agents and schedules
   * apply from the next tick. The port and tick interval apply at the next start.
   */
  reloadConfig(): void {
    const user = readUserConfig(this.env);
    const cfg = opsdConfig(user);
    this.user = user;
    this.cfg = { ...cfg, port: this.cfg.port, tick_seconds: this.cfg.tick_seconds };
  }

  /** Where opsd reads its user config. */
  get configPath(): string {
    return userConfigPath(this.env);
  }

  /** The env and folder opsd runs with, for `doctor` to check the same setup opsd uses. */
  get context(): { env: NodeJS.ProcessEnv; cwd: string } {
    return { env: this.env, cwd: this.cwd };
  }

  /**
   * Changes opsd's own user config file (never another one) and reloads it. `check` throws to
   * refuse the result before anything is written.
   */
  editConfig(
    change: Parameters<typeof editUserConfig>[1],
    check?: Parameters<typeof editUserConfig>[2],
  ): void {
    editUserConfig(this.env, change, check);
    this.reloadConfig();
  }

  /** The user config opsd runs with. */
  get userConfig(): UserConfig {
    return this.user;
  }

  /** When each schedule last started a run (ms), by name. */
  scheduleRuns(): Record<string, number> {
    return this.store.readJson<Record<string, number>>('schedules.json', {});
  }

  /** Starts a schedule's run now, under the usual limits; records it like a scheduled start. */
  runScheduleNow(name: string): RunRecord {
    const s = this.config.schedules.find((x) => x.name === name);
    if (!s) throw new OpsError(`no schedule '${name}'`, 2);
    const ws = this.ws(s.agent);
    const why = this.scheduleBlocker(ws, s);
    if (why) throw new OpsError(`${s.agent} cannot start now: ${why}`);
    const run = this.launch({
      agent: s.agent,
      task: s.task,
      extra: s.prompt || undefined,
      schedule: s.name,
    });
    const last = this.scheduleRuns();
    last[s.name] = this.now();
    this.store.writeJson('schedules.json', last);
    return run;
  }

  /**
   * A fresh workspace (fresh index read) acting as `actor`, or as the user config's `me`. The
   * supervisor's own `OPS_AGENT` is ignored, so API calls never act as whoever started opsd.
   * `helper` marks a helper run's workspace, which may not change task state.
   */
  ws(actor?: string, run?: string, helper = false): Workspace {
    const env = { ...this.env };
    delete env.OPS_AGENT;
    delete env.OPS_RUN;
    delete env.OPS_PARENT_RUN;
    delete env.OPS_RUN_TOKEN;
    delete env.OPS_RUN_STATE_DIR;
    return new Workspace({
      cwd: this.cwd,
      env,
      user: this.user,
      actor,
      run,
      helper,
      now: this.now,
    });
  }

  /** The live run whose API token is `token`, or undefined. */
  runByToken(token: string): RunRecord | undefined {
    if (!token) return undefined;
    const hash = sha256(token);
    return this.liveRecords().find((r) => r.status === 'running' && r.token_sha256 === hash);
  }

  // ---- Limits ----------------------------------------------------------------------------------

  /**
   * Live run records, and runs still ending: until opsd has reaped a run, waited for its
   * helpers and committed what it left, it counts against every limit and holds its checkout.
   */
  private liveRecords(): RunRecord[] {
    return [...[...this.live.values()].map((l) => l.record), ...this.ending.values()];
  }

  /**
   * A run that may change files in its checkout: a top-level run of a role that writes. A chat
   * turn has Edit and Write denied, so it never holds a checkout, and opsd commits nothing after
   * it (AO-0136). Question runs are left to each caller: they never hold a checkout either.
   */
  private writingRun(r: Pick<PlannedRun, 'agent' | 'parent' | 'chat'>): boolean {
    return !r.parent && !r.chat && roleLimits(this.config, roleOf(r.agent)).writes;
  }

  /**
   * Why a run of `agent` on `project` cannot start now, or null when every limit has room: the
   * PC (runs and free memory), the provider (live runs and its usage allowance), the role (per
   * project and in all), and, for a run that writes, the checkout `cwd` it would work in. A
   * question run meets only the PC and provider limits, and role limits never count it. A chat
   * turn meets the role limits but not the checkout's: it writes no files.
   */
  blocker(
    agent: string,
    project: string,
    opts: {
      burst?: boolean;
      child?: boolean;
      question?: boolean;
      chat?: boolean;
      live?: PlannedRun[];
      cwd?: string;
      /** The task the run would work on: named when a checkout's changes hold it. */
      task?: string;
    } = {},
  ): string | null {
    // Helper runs belong to a live run, which a pause lets finish.
    if (this.config.paused && !opts.child) return PAUSED;
    const live: PlannedRun[] = opts.live ?? this.liveRecords();
    if (live.length >= this.config.max_runs) {
      return `${live.length} runs live; max_runs is ${this.config.max_runs}`;
    }
    const freeGb = this.freeMem() / 2 ** 30;
    if (freeGb < this.config.min_free_gb) {
      return `${freeGb.toFixed(1)} GB of memory free; min_free_gb is ${this.config.min_free_gb}`;
    }
    const provider = runtimeOf(agent);
    const rc = this.config.runtimes[provider];
    if (!rc) return noProvider(provider);
    if (rc.paused) return `${provider} is paused in Settings`;
    if (rc.max_live !== undefined) {
      const n = live.filter((r) => runtimeOf(r.agent) === provider).length;
      if (n >= rc.max_live) return `${n} ${provider} runs live; max_live is ${rc.max_live}`;
    }
    const paused = usagePause(
      provider,
      this.usage[provider],
      rc.pause_at ?? this.config.usage_pause_at,
      this.now(),
    );
    if (paused) return paused;
    // A helper works under its parent's claim and scope: role limits count the parent only.
    if (opts.child) return null;
    // A question run answers and writes nothing: project and checkout limits are for work.
    if (opts.question) return null;
    const role = roleOf(agent);
    const lim = roleLimits(this.config, role);
    const mine = live.filter((r) => !r.parent && !r.question && roleOf(r.agent) === role);
    const here = mine.filter((r) => (r.project ?? r.root) === project).length;
    const cap = opts.burst ? lim.burst : lim.per_project;
    if (here >= cap) {
      return `${here} ${role} run(s) live on ${project}; ${opts.burst ? 'burst' : 'per_project'} is ${cap}`;
    }
    if (lim.max_live !== undefined && mine.length >= lim.max_live) {
      return `${mine.length} ${role} runs live; max_live is ${lim.max_live}`;
    }
    // Two runs that write in one checkout commit and test each other's half-done changes,
    // whatever project their tasks name; so one writing run per checkout, over every role.
    // A run may start in a subfolder, so runs compare the top of their git checkout.
    if (lim.writes && !opts.chat && opts.cwd) {
      const top = this.checkoutTop(opts.cwd);
      const other = live.find(
        (r) =>
          !r.question &&
          r.cwd !== undefined &&
          this.writingRun(r) &&
          samePath(this.checkoutTop(r.cwd), top),
      );
      if (other) {
        const what = other.task ? ` on ${other.root ? `${other.root}/` : ''}${other.task}` : '';
        return `${other.agent} works${what} in ${top}; one writing run per checkout`;
      }
      // A merge moves the checkout's branch and builds it; a writer there waits for it.
      if (this.merging && samePath(this.merging.top, top)) {
        return `opsd merges ${this.merging.ref} into ${this.merging.base} in ${top}`;
      }
      // A writing run starts on a clean checkout, so what it leaves is its own work alone.
      const gitTop = this.gitTopOf(resolve(opts.cwd));
      if (gitTop) {
        const changes = this.changesIn(gitTop);
        if (changes instanceof Error) {
          return `git cannot read the changes in ${gitTop}: ${changes.message}`;
        }
        if (changes.length > 0) {
          if (this.dirtyHolds && !this.dirtyHolds.has(gitTop)) {
            this.dirtyHolds.set(gitTop, {
              agent,
              task: opts.task,
              file: changes[0]!,
              count: changes.length,
            });
          }
          const more = changes.length > 1 ? ` and ${changes.length - 1} more` : '';
          return `checkout has uncommitted changes in ${gitTop}: ${changes[0]}${more}`;
        }
      }
    }
    return null;
  }

  /** A checkout's changes outside task stores, or the error git gave. */
  private changesIn(top: string): string[] | Error {
    const known = this.changesMemo?.get(top);
    if (known) return known;
    let found: string[] | Error;
    try {
      found = this.checkout(top).changes();
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      found = new Error(msg);
    }
    this.changesMemo?.set(top, found);
    return found;
  }

  /** Git work on the checkout at `top`, with every task store opsd knows left out. */
  private checkout(top: string): Checkout {
    return new Checkout(
      top,
      this.ws().roots.map((r) => r.dir),
      this.env,
    );
  }

  /**
   * The checkout a top-level run of `agent` works in: the launch's folder, else the agent's
   * `cwd`, else the top of the git repo of the task's root (or the first root).
   */
  checkoutOf(ws: Workspace, agent: string, rootName?: string, cwd?: string): string {
    const rootDir = rootName ? ws.roots.find((r) => r.name === rootName)?.dir : undefined;
    return resolve(
      cwd ??
        this.config.agents[agent]?.cwd ??
        this.gitTopOf(rootDir ?? ws.roots[0]?.dir ?? this.cwd) ??
        this.cwd,
    );
  }

  /**
   * The checkout a folder belongs to: the top of its git work tree (each linked worktree is its
   * own), else the folder itself.
   */
  private checkoutTop(dir: string): string {
    const abs = resolve(dir);
    return this.gitTopOf(abs) ?? abs;
  }

  /**
   * The git checkout of a data root that `cwd` is in, with the root's store branch (null when
   * none is known yet); null when `cwd` is in no root's checkout. Each linked worktree is a
   * checkout of its own, so a run in a worktree is in none.
   */
  private storeCheckoutOf(
    ws: Workspace,
    cwd: string,
  ): { top: string; branch: string | null } | null {
    const top = this.gitTopOf(resolve(cwd));
    if (!top) return null;
    for (const root of ws.roots) {
      const rootTop = this.gitTopOf(resolve(root.dir));
      if (rootTop && samePath(rootTop, top)) return { top, branch: storeBranch(root) };
    }
    return null;
  }

  /** `gitTop`, remembered per folder once found, since wake planning asks for it every tick. */
  private gitTopOf(dir: string): string | null {
    const known = this.gitTops.get(dir);
    if (known) return known;
    const top = gitTop(dir);
    if (top) this.gitTops.set(dir, top);
    return top;
  }

  /** Why a schedule's run cannot start now, or null. */
  private scheduleBlocker(ws: Workspace, s: ScheduleConfig): string | null {
    const inactive = roleInactive(ws.agent(s.agent));
    if (inactive) return inactive;
    const root = s.task ? ws.resolve(s.task).root.name : undefined;
    return this.blocker(s.agent, this.projectOf(ws, s.task), {
      cwd: this.checkoutOf(ws, s.agent, root),
      task: s.task,
    });
  }

  /** The project a run counts against: the task's project, else its root's default project. */
  projectOf(ws: Workspace, ref?: string): string {
    if (ref) {
      const v = ws.view(ref);
      return v.meta.project ?? v.root;
    }
    return ws.roots[0]?.projectName() ?? 'default';
  }

  /** What opsd knows about each provider's usage allowance, with whether it pauses new runs. */
  usageReport(): Record<string, ProviderUsage & { paused: string | null; live: number }> {
    const out: Record<string, ProviderUsage & { paused: string | null; live: number }> = {};
    const providers = new Set([...Object.keys(this.config.runtimes), ...Object.keys(this.usage)]);
    for (const p of providers) {
      const u = this.usage[p] ?? { windows: {}, updated_at: 0 };
      const pauseAt = this.config.runtimes[p]?.pause_at ?? this.config.usage_pause_at;
      out[p] = {
        ...u,
        paused: this.config.runtimes[p]?.paused
          ? `${p} is paused in Settings`
          : usagePause(p, this.usage[p], pauseAt, this.now()),
        live: this.liveRecords().filter((r) => runtimeOf(r.agent) === p).length,
      };
    }
    return out;
  }

  /** Takes new usage readings from a run's output into the usage state. */
  private readUsage(l: LiveRun): void {
    const provider = runtimeOf(l.record.agent);
    let reading: ProviderUsage | null = null;
    if (l.meter.rateLimitSeen !== (l.rateLimitsRead ?? 0)) {
      l.rateLimitsRead = l.meter.rateLimitSeen;
      reading = claudeUsage(l.meter.rateLimit, this.now());
    } else if (l.meter.threadId) {
      l.rollout ??= findRollout(codexHome(this.env), l.meter.threadId) ?? undefined;
      if (l.rollout) reading = codexUsage(lastCodexLimits(l.rollout), this.now());
    }
    if (l.meter.limitHits !== (l.limitHitsRead ?? 0)) {
      l.limitHitsRead = l.meter.limitHits;
      // A reset the provider named wins; the cooldown only covers an error without one, and
      // never shortens a refusal already known.
      const known = reading?.limited_until ?? this.usage[provider]?.limited_until ?? 0;
      const until =
        l.meter.limitHit?.resetsAt ??
        (reading?.limited_until ||
          Math.max(known, this.now() + this.config.usage_cooldown_minutes * 60_000));
      reading = { ...(reading ?? { windows: {} }), limited_until: until, updated_at: this.now() };
      this.emit(
        'warn',
        `run ${l.record.id}: ${provider} hit its usage limit; no new ${provider} runs until ${new Date(until).toISOString()}`,
      );
    }
    if (!reading) return;
    this.usage[provider] = mergeUsage(this.usage[provider], reading);
    this.store.writeJson('usage.json', this.usage);
  }

  runs(opts: { live?: boolean } = {}): RunRecord[] {
    const all = this.store.list().map((r) => this.live.get(r.id)?.record ?? r);
    return opts.live ? all.filter((r) => r.status === 'running') : all;
  }

  run(id: string): RunRecord {
    const r = this.live.get(id)?.record ?? this.store.get(id);
    if (!r) throw new OpsError(`no run ${id}`, 2);
    return r;
  }

  /** The run's record while it is live, or undefined once it ended or when opsd never ran it. */
  liveRun(id: string): RunRecord | undefined {
    return this.live.get(id)?.record;
  }

  liveFor(agent: string): RunRecord | undefined {
    return [...this.live.values()].find((l) => l.record.agent === agent)?.record;
  }

  // ---- Launch and end ------------------------------------------------------------------------

  launch(req: LaunchRequest): RunRecord {
    if (this.stopping) throw new OpsError('opsd is stopping');
    const agent = assertActor(req.agent, 'agent');
    const runtime = runtimeOf(agent);
    const rc = this.config.runtimes[runtime];
    if (!rc) throw new OpsError(noProvider(runtime), 2);
    const id = ulid(this.now());
    const ws = this.ws(agent, id);
    const def = ws.agent(agent);
    const inactive = roleInactive(def);
    if (inactive) throw new OpsError(inactive);
    const file = resolveCommand(rc.command, this.env);
    if (!file) throw new OpsError(`'${rc.command}' is not on PATH`, 2);

    let task: string | undefined;
    let rootName: string | undefined;
    let ref: string | undefined;
    let heldHere = false;
    let delegation: { budget_minutes?: number; tokens?: number } | null = null;
    let question: QuestionPrompt | undefined;
    const parent = req.parent ? this.live.get(req.parent)?.record : undefined;
    if (req.parent) {
      if (!parent) throw new OpsError(`parent run ${req.parent} is not live`);
      if (parent.parent) throw new OpsError('a helper run cannot start helpers of its own');
      if (parent.review || !parent.task || !parent.root) {
        throw new OpsError('only a run working on a task can start helpers');
      }
      const parentRef = `${parent.root}/${parent.task}`;
      if (!this.ws(parent.agent, parent.id).holdsClaim(parentRef)) {
        throw new OpsError(`run ${parent.id} no longer holds ${parentRef}`);
      }
      if (!req.prompt) throw new OpsError('a helper run needs a prompt', 2);
      const max = roleLimits(this.config, roleOf(parent.agent)).max_children;
      const kids = this.liveRecords().filter((r) => r.parent === parent.id).length;
      if (kids >= max) {
        throw new OpsError(`run ${parent.id} has ${kids} helper(s) live; max_children is ${max}`);
      }
      task = parent.task;
      rootName = parent.root;
    }
    if (req.task && !parent) {
      const { root, id } = ws.resolve(req.task);
      task = id;
      rootName = root.name;
      ref = `${root.name}/${id}`;
      const v = ws.view(ref);
      delegation = v.delegation;
      if (!req.review && v.meta.type === QUESTION_TYPE) question = questionPrompt(ws, ref, v);
      if (req.review) {
        if (v.status !== 'needs-review' || !ownerMatches(v.reviewer, agent)) {
          throw new OpsError(`${ref} does not wait for ${agent}'s review`);
        }
      }
      const running = this.liveRecords().find((r) => r.root === root.name && r.task === id);
      if (running) throw new OpsError(`${ref} already has a live run (${running.id})`);
      // A claim by the same agent id from another clone is another run's; ws.claim refuses it.
      if (!req.review) {
        // Held by this clone without this run: bind it to the new run, unless a live run owns it.
        heldHere = this.ws(agent).holdsClaim(ref);
        if (heldHere) {
          const owner = root.claimRecord(id).run;
          if (owner && this.live.has(owner))
            throw new OpsError(`${ref} is held by live run ${owner}`);
        }
      }
    }
    const project = parent
      ? (parent.project ?? parent.root ?? this.projectOf(ws))
      : this.projectOf(ws, ref);
    // Reviewers may burst in a project whose reviews pile up.
    const burst =
      req.review === true && this.reviewBacklog(ws.list(), project) >= this.config.review_backlog;
    const agentCfg = this.config.agents[agent] ?? {};
    // A helper always works in its parent's folder.
    const cwd = parent?.cwd ? resolve(parent.cwd) : this.checkoutOf(ws, agent, rootName, req.cwd);
    const blocked = this.blocker(agent, project, {
      burst,
      child: parent !== undefined,
      question: question !== undefined,
      chat: req.chat !== undefined,
      cwd,
    });
    if (blocked) throw new OpsError(blocked);
    // What a top-level run leaves is committed on a branch from the commit it started on. A
    // writing run starts on a clean checkout (see `blocker`). Any other run, such as a qa or
    // reviewer run, gets a start commit only when it finds the checkout clean, so its wrap-up
    // never takes changes a person or another run made before it (AO-0136).
    let base: string | undefined;
    if (!parent) {
      const top = this.gitTopOf(cwd);
      const writes = this.writingRun({ agent, chat: req.chat ? true : undefined });
      if (top && (writes || this.cleanCheckout(top))) base = this.checkout(top).head() || undefined;
    }
    // Everything that can fail on bad input runs before the claim, so a refused launch leaves
    // the task as it was.
    const budget = req.budget
      ? parseDuration(req.budget)
      : (delegation?.budget_minutes ??
        (agentCfg.budget ? parseDuration(agentCfg.budget) : undefined) ??
        def?.budget_min ??
        this.config.budget_minutes);
    const tokenBudget = req.tokens ? parseTokens(req.tokens) : delegation?.tokens;
    const mirrorRoot = rootName
      ? ws.roots.find((r) => r.name === rootName && r.isMirror)
      : undefined;
    if (mirrorRoot && !parent && !req.cwd && !agentCfg.cwd) {
      throw new OpsError(
        `${rootName} is a project mirrored in the Master Repo and has no checkout here: add the ` +
          `project's root to this machine, or give the run a folder (opsd.agents.${agent}.cwd)`,
        2,
      );
    }
    const addDirs = ws.roots
      .map((r) => gitTop(r.dir) ?? r.dir)
      .filter((d, i, all) => all.indexOf(d) === i && !inside(d, cwd));
    const roleDirs = ws.roots.map((r) => join(r.dir, 'agents'));
    if (req.chat && (req.task || req.parent)) {
      throw new OpsError('a chat turn works on no task', 2);
    }
    // The agent's model in Settings wins over its role file's, which wins over the provider's.
    const runDef = agentCfg.model
      ? ({
          ...(def ?? { id: agent, status: 'active', file: '', body: '' }),
          model: agentCfg.model,
        } as AgentDef)
      : def;
    const readOnly = !roleLimits(this.config, roleOf(agent)).writes;
    // A run in a data root's checkout makes code branches in worktrees (AO-0135).
    const storeCheckout = this.storeCheckoutOf(ws, cwd) ?? undefined;
    // Task stores, the one in the run's checkout first: a read-only Codex run starts there.
    const checkoutTop = this.gitTopOf(cwd) ?? cwd;
    const stores = ws.roots
      .map((r) => r.dir)
      .sort((a, b) => Number(inside(b, checkoutTop)) - Number(inside(a, checkoutTop)));
    const inv = invocation(
      rc,
      agent,
      runDef,
      cwd,
      addDirs,
      roleDirs,
      req.chat,
      readOnly,
      storeCheckout !== undefined,
      stores,
    );
    // A custom prompt is used as given, plus the store-checkout rule when it applies, plus the
    // read-only Codex note.
    const prompt =
      (req.prompt !== undefined
        ? withStoreCheckoutRule(req.prompt, storeCheckout, task)
        : runPrompt({
            agent,
            task,
            roleFile: def?.file,
            role: def,
            review: req.review,
            question,
            extra: req.extra,
            storeCheckout,
          })) + (inv.note ?? '');

    // Claim before the process starts, so two runs never race for one task.
    let claimedHere = false;
    // A review run holds no claim.
    if (ref && heldHere && !req.review) ws.bindClaim(ref);
    if (ref && !heldHere && !req.review) {
      ws.claim(ref);
      claimedHere = true;
    }
    let spawned: Spawned | undefined;
    let record: RunRecord;
    // The run's own API token: opsd acts as this run's agent for it, never as the human.
    const runToken = randomBytes(24).toString('hex');
    try {
      const env = runEnv(this.env, {
        OPS_AGENT: agent,
        OPS_RUN: id,
        OPS_RUN_TOKEN: runToken,
        // Where the token is valid: `ops` uses it only for the opsd on this state folder.
        OPS_RUN_STATE_DIR: this.store.dir,
        ...(parent ? { OPS_PARENT_RUN: parent.id } : {}),
        OPS_ROOTS: ws.roots.map((r) => r.dir).join(delimiter),
      });
      dropEnv(env, inv.unsetEnv);
      const log = this.store.logPath(id);
      const fd = openSync(log, 'a');
      try {
        spawned = spawnHidden(file, inv.args, { cwd, env, out: fd });
      } finally {
        closeSync(fd);
      }
      record = {
        id,
        agent,
        task,
        root: rootName,
        project,
        review: req.review || undefined,
        question: question ? true : undefined,
        parent: parent?.id,
        schedule: req.schedule,
        // Matches the prompt choice above: only the standard prompt reads the inbox.
        inbox:
          !task && req.prompt === undefined && req.extra === undefined && !req.chat
            ? true
            : undefined,
        chat: req.chat ? true : undefined,
        pid: spawned.pid,
        image: spawned.image,
        command: [rc.command, ...inv.args].join(' '),
        cwd,
        log,
        started_at: new Date(this.now()).toISOString(),
        status: 'running',
        budget_minutes: budget,
        token_budget: tokenBudget,
        tokens: 0,
        // Read before the record is saved, so an adopting opsd always has it to check.
        proc_start: processStartSync(spawned.pid) ?? undefined,
        shim_pid: spawned.launch ? spawned.pid : undefined,
        token_sha256: sha256(runToken),
        base,
      };
      this.store.save(record);
    } catch (err) {
      // Undo only what this launch did: its own process and its own claim. On Windows the
      // command has not started yet, and without `go` it never does.
      if (spawned) killOwnChild(spawned);
      if (claimedHere && ref) {
        const why = err instanceof Error ? err.message : String(err);
        this.safe(() => ws.release(ref, `launch failed: ${why}`));
      }
      throw err;
    }
    const child = spawned.child;
    const liveRun: LiveRun = {
      record,
      child,
      meter: new UsageMeter(),
      offset: 0,
      decoder: new StringDecoder('utf8'),
      launch: spawned.launch,
    };
    this.live.set(id, liveRun);
    child.on('exit', (code) => this.finish(id, code));
    if (spawned.launch) void this.handOver(liveRun, spawned.launch, prompt);
    else {
      child.stdin?.on('error', () => {});
      child.stdin?.end(prompt);
    }
    void this.trackProcs();
    if (task) {
      this.safe(() =>
        ws.recordRun(
          `${rootName}/${task}`,
          'run-start',
          { run: id },
          `${runtime} run, budget ${formatMinutes(budget)}${tokenBudget ? `, ${tokenBudget} tokens` : ''}`,
        ),
      );
    }
    this.emit('run', record);
    return record;
  }

  /** Stops a run and its process tree. */
  kill(id: string, reason = 'killed'): RunRecord {
    const l = this.live.get(id);
    if (!l) throw new OpsError(`run ${id} is not live`);
    l.killReason = reason;
    const r = l.record;
    if (l.launch) {
      // Nothing started past the launcher yet: closing the channel and the shell ends the run.
      this.abortLaunch(l);
      return r;
    }
    if (l.child && process.platform !== 'win32') {
      // Its own child, not reaped yet: the PID and the process group cannot be reused.
      killTree(r.pid);
      return r;
    }
    if (!l.child && !this.procLister().precise) {
      // Adopted, on a platform without exact creation times: the PID cannot be checked at the
      // moment of a kill, so opsd leaves it alone.
      this.emit('warn', `run ${id}: cannot check adopted PID ${r.pid} here; stop it yourself`);
      this.finish(id, null);
      return r;
    }
    void this.killByLedger(id);
    return r;
  }

  /**
   * Stops the run's root and every descendant the ledger confirms, each checked at the moment of
   * the kill. No tree kill: Windows matches a tree by parent PID alone, which can reach a process
   * whose parent PID was reused. A run opsd started is also stopped through its own process
   * handle, whatever the ledger finds. A snapshot that fails or does not list the root does not
   * leave it running: the root is then killed by its recorded PID and creation time (see
   * `killRoot`).
   */
  private killByLedger(id: string): Promise<void> {
    return this.procWork(async () => {
      const l = this.live.get(id);
      if (!l) return;
      const ledger = this.ledgerOf(l.record);
      // The root still needs a kill unless a snapshot showed it gone or it was killed below.
      let rootLeft = true;
      try {
        const now = Date.now();
        const snap = await this.snapshot();
        track(ledger, snap, now, this.lister?.ownPids?.() ?? [], this.lister?.clockSlack ?? 0);
        const left = survivors(ledger, snap);
        await this.killVerified(left);
        this.store.saveProcs(ledger);
        // Listed but not a survivor: the PID runs another process now, so the root is gone. A
        // survivor whose kill did not take gets one more try, which warns if it fails again.
        const root = left.find((e) => e.pid === ledger.root_pid);
        const listed = snap.some((p) => p.pid === ledger.root_pid);
        rootLeft = !listed || (root !== undefined && !root.killed_at);
      } finally {
        if (rootLeft) await this.killRoot(id, ledger);
        if (l.child) {
          if (l.child.exitCode === null) l.child.kill('SIGKILL');
        } else {
          // An adopted run sends no exit event.
          this.finish(id, null);
        }
      }
    });
  }

  /**
   * Kills the run's root by its recorded PID and creation time, checked at the moment of the kill,
   * for when no snapshot showed it. Windows: the root is the launcher, which runs outside opsd's
   * job; ending only the hidden `cmd.exe` would leave it and the command running, and its own job
   * ends the command with it. Warns when it cannot, so the run is not taken for stopped.
   */
  private async killRoot(id: string, ledger: ProcLedger): Promise<void> {
    const pid = ledger.root_pid;
    const start = ledger.root_start;
    const cannot = (why: string): void => {
      this.emit('warn', `run ${id}: cannot stop PID ${pid} (${why}); stop it yourself`);
    };
    if (start === null) return cannot('no creation time on record');
    let res: KillResult | undefined;
    try {
      res = (await this.procLister().kill([{ pid, start }])).get(pid);
    } catch (err) {
      return cannot(err instanceof Error ? err.message : String(err));
    }
    if (res === 'killed') {
      const entries = ledger.entries.filter((e) => e.pid === pid && e.start === start);
      if (entries.length > 0) {
        applyKills(entries, new Map([[pid, res]]), Date.now());
        this.safe(() => this.store.saveProcs(ledger));
      }
    } else if (res !== 'gone' && res !== 'other') {
      cannot(res === 'error' ? 'the kill failed' : 'no answer from the process lister');
    }
  }

  private finish(id: string, exit: number | null): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    l.launch?.abort();
    l.launch = undefined;
    this.readLog(l);
    l.meter.end();
    const r = l.record;
    r.status = 'ended';
    r.ended_at = new Date(this.now()).toISOString();
    r.exit = l.killReason ? null : exit;
    r.reason = l.killReason ?? (l.child ? 'exit' : 'lost');
    r.tokens = l.meter.tokens;
    // Saved with the end, so an opsd that stops before the wrap-up is over resumes it.
    r.wrap_up = 'pending';
    this.store.save(r);
    this.ending.set(id, r);
    this.startWrapUp(r);
  }

  /**
   * Starts the wrap-up of a run in `ending`. Helpers end with their parent. A helper that ended
   * first may still be in its own wrap-up, reaping descendants that can write: the parent waits
   * for it too. `resumed`: the run ended under an earlier opsd, so its helpers that ended there
   * count as well.
   */
  private startWrapUp(r: RunRecord, resumed = false): void {
    const id = r.id;
    const helpers = [
      ...new Set(
        [...this.liveRecords(), ...(resumed ? this.store.list() : [])]
          .filter((c) => c.parent === id)
          .map((c) => c.id),
      ),
    ];
    for (const child of helpers) {
      if (this.live.has(child)) this.safe(() => this.kill(child, 'parent-ended'));
    }
    void this.wrapUp(r, helpers).catch((err) => {
      this.emit('warn', `run ${id}: wrap-up failed: ${String(err)}`);
      this.ended(id);
    });
  }

  /**
   * Saves how far a run's wrap-up got, onto the stored record: `reap` keeps `procs_left` there.
   */
  private wrapStep(r: RunRecord, patch: Partial<RunRecord>): void {
    Object.assign(r, patch);
    const stored = this.store.get(r.id);
    if (stored) r.procs_left = stored.procs_left;
    this.store.save({ ...(stored ?? r), ...patch });
  }

  /**
   * After a run's process ended: reaps its descendants and waits for its helpers to end, so
   * nothing the run started still writes; then commits what it left, records the run's end on
   * its task, frees or sends the task for review, and syncs. Each step is saved on the run
   * (`wrap_up`), so an opsd that resumes the wrap-up after a restart skips the steps done.
   */
  private async wrapUp(r: RunRecord, helpers: string[]): Promise<void> {
    const id = r.id;
    if ((r.wrap_up ?? 'pending') === 'pending') await this.commitStep(r, helpers);
    const left = r.leftovers ?? null;
    if (r.task && r.root) {
      const ref = `${r.root}/${r.task}`;
      // As the run: only the run's own claim is renewed or released.
      const ws = this.ws(r.agent, id);
      const minutes = Math.round(
        (Date.parse(r.ended_at ?? r.started_at) - Date.parse(r.started_at)) / 60_000,
      );
      if (r.wrap_up === 'committed') {
        this.safe(() =>
          ws.recordRun(
            ref,
            'run-end',
            {
              run: id,
              exit: r.exit,
              reason: r.reason,
              minutes,
              tokens: r.tokens || undefined,
            },
            left ? leftoverNote(left) : (r.not_committed ?? ''),
          ),
        );
        this.wrapStep(r, { wrap_up: 'recorded' });
      }
      if (r.wrap_up === 'recorded') this.settleTask(r, ws, ref, left);
    } else if (left && r.wrap_up === 'committed') {
      this.emit('warn', `run ${id}: ${leftoverNote(left)}`);
    }
    // A run ends like a session: commit and push what it changed. Sandboxed runtimes (Codex)
    // cannot write .git themselves.
    if (this.config.sync) this.safe(() => this.syncAfterRun(r));
    this.wrapStep(r, { wrap_up: 'done' });
    this.ended(id);
    this.emit('run', r);
  }

  /**
   * The first wrap-up step: once the run's descendants are reaped and its helpers ended, commits
   * what the run left, or says why it does not.
   */
  private async commitStep(r: RunRecord, helpers: string[]): Promise<void> {
    const id = r.id;
    await this.reap(id);
    let timer: NodeJS.Timeout | undefined;
    const helpersEnded =
      helpers.length === 0 ||
      (await Promise.race([
        Promise.all(helpers.map((h) => this.whenEnded(h))).then(() => true),
        new Promise<boolean>((res) => {
          timer = setTimeout(() => res(false), HELPER_END_MS);
        }),
      ]).finally(() => clearTimeout(timer)));
    // Sandboxed runtimes (Codex) cannot commit: what the run left goes to a branch of its own.
    let left: Leftovers | null = null;
    let notCommitted = '';
    const procsLeft = this.store.get(id)?.procs_left ?? 0;
    // A helper's descendants that survived its reap can write as well.
    const helperProcsLeft = helpers.reduce((n, h) => n + (this.store.get(h)?.procs_left ?? 0), 0);
    try {
      if (!helpersEnded) notCommitted = 'helper runs still running';
      else if (procsLeft > 0) notCommitted = `${procsLeft} process(es) of the run still alive`;
      else if (helperProcsLeft > 0) {
        notCommitted = `${helperProcsLeft} process(es) of its helpers still alive`;
      }
      if (notCommitted) {
        // Something the run started may still write: a commit now could miss its work.
        if (this.writesLeftovers(r) && this.leftoverTop(r)) {
          notCommitted = `left changes uncommitted: ${notCommitted}`;
          this.emit('warn', `run ${id}: ${notCommitted}`);
        } else notCommitted = '';
      } else left = this.commitLeftovers(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notCommitted = `cannot commit what it left in ${r.cwd}: ${msg}`;
      this.emit('warn', `run ${id}: ${notCommitted}`);
    }
    this.wrapStep(r, {
      wrap_up: 'committed',
      leftovers: left ?? undefined,
      not_committed: notCommitted || undefined,
    });
  }

  /** Frees the run's task, or sends it for review with what opsd committed. */
  private settleTask(r: RunRecord, ws: Workspace, ref: string, left: Leftovers | null): void {
    const id = r.id;
    this.safe(() => {
      const v = ws.view(ref);
      // Only a claim this clone holds; a claim that lost a race belongs to the winner.
      if (ws.holdsClaim(ref) && (v.status === 'claimed' || v.status === 'in-progress')) {
        if (left && !r.review) {
          try {
            ws.review(ref, leftoverReview(r, left, false), this.reviewerFor(ws, v, r.agent));
            return;
          } catch (err) {
            this.emit('warn', `run ${id}: cannot send ${ref} for review: ${String(err)}`);
          }
        }
        ws.release(ref, `run ${id} ended (${r.reason}, exit ${r.exit ?? '-'}) without finishing`);
      } else if (left && !r.review && v.status === 'needs-review') {
        // The run asked for review naming files it could not commit: tell the reviewer where
        // they are now.
        ws.comment(ref, leftoverReview(r, left, true), v.reviewer ?? undefined);
      }
    });
    this.wrapStep(r, { wrap_up: 'settled' });
  }

  /** A run's wrap-up is over: it no longer counts as live, and who waited for it goes on. */
  private ended(id: string): void {
    this.ending.delete(id);
    const waiters = this.endWaiters.get(id) ?? [];
    this.endWaiters.delete(id);
    for (const w of waiters) w();
  }

  /** Resolves once the run has ended and finished its wrap-up. */
  private whenEnded(id: string): Promise<void> {
    if (!this.live.has(id) && !this.ending.has(id)) return Promise.resolve();
    return new Promise((res) => {
      const list = this.endWaiters.get(id) ?? [];
      list.push(res);
      this.endWaiters.set(id, list);
    });
  }

  /**
   * A run whose leftovers opsd commits: a top-level run of a role that writes, or any other
   * top-level run that started on a clean checkout and so has a start commit (AO-0136).
   */
  private writesLeftovers(r: RunRecord): boolean {
    return !r.parent && (this.writingRun(r) || r.base !== undefined);
  }

  /** True when git reads the checkout `top` and finds no changes outside task stores. */
  private cleanCheckout(top: string): boolean {
    const changes = this.changesIn(top);
    return !(changes instanceof Error) && changes.length === 0;
  }

  /** The git checkout a run's leftovers would be committed in, or null when it has none. */
  private leftoverTop(r: RunRecord): string | null {
    const top = this.gitTopOf(resolve(r.cwd));
    if (!top) return null;
    const co = this.checkout(top);
    return co.isStore ? null : top;
  }

  /**
   * Commits what a top-level run of a role that writes left in its checkout (outside task
   * stores) on a new branch `<runtime>/<task>-<run>` from the commit the run started on, and
   * restores those files there. Null when the run left nothing, as runs that commit themselves
   * do. Throws when the checkout's HEAD is no longer that commit, or the run has none recorded.
   */
  private commitLeftovers(r: RunRecord): Leftovers | null {
    if (!this.writesLeftovers(r)) return null;
    const top = this.gitTopOf(resolve(r.cwd));
    if (!top) return null;
    // Another writing run in the checkout owns changes there too; leave them to a person.
    const other = this.liveRecords().find(
      (o) => o.id !== r.id && this.writingRun(o) && samePath(this.checkoutTop(o.cwd), top),
    );
    if (other) {
      this.emit('warn', `run ${r.id}: ${other.id} works in ${top}; its changes stay uncommitted`);
      return null;
    }
    const co = this.checkout(top);
    let title = `Run ${r.id}`;
    if (r.task && r.root) {
      const ref = `${r.root}/${r.task}`;
      this.safe(() => {
        title = this.ws().view(ref).meta.title;
      });
    }
    const into = co.branch();
    const commit = co.commitLeftovers(
      leftoverBranch(runtimeOf(r.agent), r.id, r.task),
      `${title}\n\nChanges left by run ${r.id} (${r.agent}).\n`,
      r.base ?? null,
    );
    return commit ? { ...commit, top, into } : null;
  }

  /**
   * Who reviews what a run left: the reviewer the task's delegation expects, else the first
   * active `qa` agent of another provider, else the human.
   */
  private reviewerFor(ws: Workspace, v: TaskView, author: string): string | undefined {
    if (v.delegation?.review) return v.delegation.review;
    const mine = runtimeOf(author);
    for (const provider of Object.keys(this.config.runtimes)) {
      if (provider === mine) continue;
      const id = `${provider}:qa`;
      if (ws.agent(id)?.status === 'active') return id;
    }
    return undefined;
  }

  private syncAfterRun(r: RunRecord): void {
    const ws = this.ws();
    const roots = ws.roots.filter((root) => !r.root || root.name === r.root);
    const targets = [
      ...new Set(roots.flatMap((root) => mirrorPartners(root, ws.roots, this.user))),
    ];
    for (const { root, result } of syncAll(targets, this.user, {
      sessionEnd: true,
      now: this.now(),
    })) {
      this.synced(root.name, result);
    }
    // What the run committed to its branch leaves this machine with the sync.
    this.safe(() => this.pushBranches(roots));
  }

  /**
   * Reports a sync and stops live runs whose claim lost to one pushed first from another clone.
   * The run writes nothing more and no release is written: the task belongs to the winner.
   */
  private synced(root: string, res: SyncResult): void {
    this.emit('sync', { root, ...res });
    for (const lost of res.lost) {
      for (const l of [...this.live.values()]) {
        const r = l.record;
        // A claim can lose in a mirror root, reported by its Master Repo's sync.
        if (r.root === (lost.root ?? root) && r.task === lost.task && r.agent === lost.actor) {
          this.emit('warn', `run ${r.id}: ${r.agent} lost the claim on ${lost.task}; stopping it`);
          this.safe(() => this.kill(r.id, 'lost-claim'));
        }
      }
    }
  }

  /** Reads everything the run wrote since the last read, in bounded chunks, and counts tokens. */
  private readLog(l: LiveRun): void {
    let size: number;
    try {
      size = statSync(l.record.log).size;
    } catch {
      return;
    }
    if (size <= l.offset) return;
    const fd = openSync(l.record.log, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size - l.offset, 1024 * 1024));
      while (l.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - l.offset), l.offset);
        if (n <= 0) break;
        l.offset += n;
        l.meter.feed(l.decoder.write(buf.subarray(0, n)));
      }
    } finally {
      closeSync(fd);
    }
    l.record.tokens = l.meter.tokens;
    this.safe(() => this.readUsage(l));
  }

  // ---- Processes -----------------------------------------------------------------------------

  /**
   * Queues process work. The chain never breaks: a failure becomes a `warn`. With `rethrow`, the
   * caller also gets the error.
   */
  private procWork(fn: () => Promise<void>, rethrow = false): Promise<void> {
    const run = this.procChain.then(fn);
    const safe = run.catch((err: unknown) => {
      if (!rethrow) {
        this.emit('warn', `processes: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    this.procChain = safe;
    return rethrow ? run : safe;
  }

  private procLister(): ProcLister {
    if (this.closed) throw new Error('opsd is stopping');
    this.lister ??= this.listerOpt ?? systemLister();
    return this.lister;
  }

  private snapshot(): Promise<ProcInfo[]> {
    try {
      return this.procLister().list();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Ledgers need exact creation times; elsewhere opsd keeps none (fail closed). */
  private ledgerOn(): boolean {
    return !this.closed && this.procLister().precise;
  }

  /** Kills each entry only if its PID still runs the recorded process at the moment of the kill. */
  private async killVerified(entries: ProcEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const results = await this.procLister().kill(entries);
    applyKills(entries, results, Date.now());
  }

  private ledgerOf(r: RunRecord): ProcLedger {
    const ledger = this.store.procs(r.id);
    if (!ledger) {
      return { run: r.id, root_pid: r.pid, root_start: startMs(r.proc_start), entries: [] };
    }
    // Windows: the launcher takes over from the hidden cmd.exe as the root, so a ledger that
    // never saw it while the shell lived still finds it and what it started.
    if (r.shim_pid !== undefined && ledger.root_pid === r.shim_pid && r.pid !== r.shim_pid) {
      ledger.root_pid = r.pid;
      ledger.root_start = startMs(r.proc_start);
    }
    return ledger;
  }

  /** Adds the processes live runs started since the last look to their ledgers. */
  trackProcs(): Promise<void> {
    return this.procWork(async () => {
      const merge = this.mergeProc;
      if ((this.live.size === 0 && !merge) || !this.ledgerOn()) return;
      // The time before the snapshot: a process it shows alive was alive at that time or later.
      const now = Date.now();
      const snap = await this.snapshot();
      for (const l of [...this.live.values()]) {
        const ledger = this.ledgerOf(l.record);
        track(ledger, snap, now, this.lister?.ownPids?.() ?? [], this.lister?.clockSlack ?? 0);
        this.store.saveProcs(ledger);
      }
      if (merge) this.trackMerge(merge, snap, now);
    });
  }

  /**
   * Adds a merge command's processes from a snapshot to its ledger. The shell joins by PID while
   * the runner still holds it unreaped, so its creation time comes from the snapshot.
   */
  private trackMerge(
    m: { ledger: ProcLedger; running: () => boolean },
    snap: ProcInfo[],
    now: number,
  ): void {
    if (m.ledger.root_start === null && m.running()) {
      m.ledger.root_start = snap.find((p) => p.pid === m.ledger.root_pid)?.start ?? null;
    }
    track(m.ledger, snap, now, this.lister?.ownPids?.() ?? [], this.lister?.clockSlack ?? 0);
  }

  /**
   * Off Windows, where each merge command runs in a job object of its own instead (see
   * `CommandRunner`): follows each merge command's processes in a ledger, like a run's. A stop kills every one of
   * them, checked by creation time, and what a command leaves behind is killed when it exits.
   * What survives every kill is kept in `merge-procs.json`, and no merge or build starts in this
   * or the next opsd until it is gone, so a leftover build never races a new one.
   */
  private mergeWatch(): CommandWatch {
    let m: { ledger: ProcLedger; running: () => boolean } | null = null;
    const look = async (): Promise<ProcInfo[] | null> => {
      if (!m || !this.ledgerOn()) return null;
      const now = Date.now();
      const snap = await this.snapshot();
      this.trackMerge(m, snap, now);
      return snap;
    };
    return {
      started: (pid, running) => {
        m = { ledger: { run: 'merge', root_pid: pid, root_start: null, entries: [] }, running };
        this.mergeProc = m;
        void this.procWork(async () => void (await look()));
      },
      stop: () =>
        this.procWork(async () => {
          const snap = await look();
          if (m && snap) await this.killVerified(survivors(m.ledger, snap));
        }),
      ended: () =>
        this.procWork(async () => {
          const ledger = m?.ledger;
          for (let round = 0; ledger; round++) {
            const snap = await look();
            if (!snap) break;
            const left = survivors(ledger, snap);
            if (left.length === 0) break;
            if (round >= REAP_ROUNDS) {
              const list = left.map((e) => `${e.name} ${e.pid}`).join(', ');
              this.emit('warn', `merge: still alive after ${REAP_ROUNDS} kills: ${list}`);
              this.saveMergeLeftovers([...this.mergeLeftovers(), ...left]);
              break;
            }
            await this.killVerified(left);
            await sleep(500);
          }
          if (this.mergeProc === m) this.mergeProc = null;
          m = null;
        }),
    };
  }

  /** Processes merge commands left behind that no kill ended, by PID and creation time. */
  private mergeLeftovers(): ProcEntry[] {
    return this.store.readJson<ProcEntry[]>('merge-procs.json', []);
  }

  private saveMergeLeftovers(left: ProcEntry[]): void {
    this.store.writeJson('merge-procs.json', left);
  }

  /**
   * Looks at the leftovers of earlier merge commands, kills the ones still running and keeps
   * those no kill ends; the next merge starts once none is left.
   */
  private clearMergeLeftovers(): void {
    this.mergeClearing = this.procWork(async () => {
      if (this.closed) return;
      // Without exact creation times no ledger was kept, so nothing can be told apart.
      if (!this.procLister().precise) return this.saveMergeLeftovers([]);
      const ledger: ProcLedger = {
        run: 'merge',
        root_pid: 0,
        root_start: null,
        entries: this.mergeLeftovers(),
      };
      let alive = survivors(ledger, await this.snapshot());
      if (alive.length > 0) {
        await this.killVerified(alive);
        await sleep(500);
        alive = survivors(ledger, await this.snapshot());
      }
      this.saveMergeLeftovers(alive);
      if (alive.length > 0) {
        const list = alive.map((e) => `${e.name} ${e.pid}`).join(', ');
        this.emit('warn', `merge: waiting for what an earlier merge left running: ${list}`);
      }
    }).finally(() => {
      this.mergeClearing = null;
      if (this.mergeLeftovers().length === 0) this.safe(() => this.mergeTick());
    });
  }

  /**
   * Windows: once the launcher reports in, the record names it (PID, image and creation time,
   * read while it waits for the command), and only then does the launcher get the command. An
   * opsd that adopts the run later follows a process that outlives this one; if this opsd exits
   * first, the launcher starts nothing. A launch that fails here ends the run.
   */
  private async handOver(l: LiveRun, launch: Launch, prompt: string): Promise<void> {
    const r = l.record;
    try {
      const pid = await launch.ready;
      const start = await processStart(pid);
      if (l.launch !== launch) return;
      if (!start) throw new Error(`launcher ${pid} is gone`);
      r.pid = pid;
      r.image = launch.image;
      r.proc_start = start;
      this.store.save(r);
      l.launch = undefined;
      launch.go(prompt);
      // A stop while it launched left this run's handle referenced; it now outlives opsd.
      if (this.stopping) l.child?.unref();
      this.emit('run', r);
    } catch (err) {
      if (l.launch !== launch) return;
      this.emit('warn', `run ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      l.killReason ??= 'launch-failed';
      this.abortLaunch(l);
    }
  }

  /** Ends a run whose launcher has not had the command: it exits without starting anything. */
  private abortLaunch(l: LiveRun): void {
    l.launch?.abort();
    l.launch = undefined;
    if (l.child && l.child.exitCode === null) l.child.kill('SIGKILL');
  }

  /**
   * After a run ends: one last look for its processes, including children whose parent already
   * exited, then kill every one still alive, checking each again until none is left or
   * `REAP_ROUNDS` kills failed. Leftovers stay on the run as `procs_left`.
   */
  reap(id: string): Promise<void> {
    return this.procWork(async () => {
      for (let round = 0; ; round++) {
        const r = this.store.get(id);
        if (!r || r.status !== 'ended' || !this.ledgerOn()) return;
        const now = Date.now();
        const snap = await this.snapshot();
        const ledger = this.ledgerOf(r);
        track(ledger, snap, now, this.lister?.ownPids?.() ?? [], this.lister?.clockSlack ?? 0);
        const left = survivors(ledger, snap);
        const give = left.length > 0 && round >= REAP_ROUNDS;
        if (left.length > 0 && !give) await this.killVerified(left);
        this.store.saveProcs(ledger);
        // Only a checked result counts: none left, or what survived every kill round.
        const settled = left.length === 0 || give;
        if (settled && (r.procs_left ?? 0) !== left.length) {
          r.procs_left = left.length || undefined;
          this.store.save(r);
          this.emit('run', r);
        }
        if (left.length === 0) return;
        if (give) {
          const list = left.map((e) => `${e.name} ${e.pid}`).join(', ');
          this.emit('warn', `run ${id}: still alive after ${REAP_ROUNDS} kills: ${list}`);
          return;
        }
        await sleep(500);
      }
    });
  }

  /** At startup: reaps ended runs of the last days whose ledgers still have processes alive. */
  sweep(): Promise<void> {
    const since = Date.now() - SWEEP_DAYS * 24 * 60 * 60_000;
    const due = this.store.list().filter((r) => {
      if (r.status !== 'ended' || Date.parse(r.ended_at ?? r.started_at) < since) return false;
      return this.store.procs(r.id)?.entries.some((e) => !e.gone_at) ?? false;
    });
    return Promise.all(due.map((r) => this.reap(r.id))).then(() => undefined);
  }

  /** The run's processes, each marked alive or not from a fresh snapshot. */
  async procs(id: string): Promise<ProcView[]> {
    const r = this.run(id);
    const snap = await this.snapshot();
    return viewLedger(this.ledgerOf(r), snap);
  }

  /**
   * Kills what an ended run left behind; a live run is stopped with `kill` instead. With `pid`,
   * kills that one ledger process, unsure ones included, after a human checked it.
   */
  async reapNow(id: string, pid?: number): Promise<ProcView[]> {
    const r = this.run(id);
    if (r.status !== 'ended') {
      throw new OpsError(`run ${id} is live: kill the run to stop its processes`);
    }
    if (pid === undefined) {
      await this.reap(id);
      return this.procs(id);
    }
    await this.procWork(async () => {
      const ledger = this.ledgerOf(r);
      const snap = await this.snapshot();
      const hit = survivors(ledger, snap, { unsure: true }).filter((e) => e.pid === pid);
      if (hit.length === 0) throw new OpsError(`no live process ${pid} in run ${id}'s ledger`);
      const results = await this.procLister().kill(hit);
      applyKills(hit, results, Date.now());
      const res = results.get(pid);
      if (res === 'other') throw new OpsError(`PID ${pid} runs another process now; left alone`);
      if (res === 'error') throw new OpsError(`could not kill ${pid}`);
      this.store.saveProcs(ledger);
    }, true);
    return this.procs(id);
  }

  // ---- The loop ------------------------------------------------------------------------------

  /**
   * Picks up runs an earlier opsd started that are still alive; the rest are marked lost. Runs
   * that ended under it before their wrap-up was over finish it here.
   */
  adopt(): void {
    const records = this.store.list();
    // In `ending` before any run is adopted, so a parent that turns out to have ended waits for
    // its helpers' wrap-ups.
    const unwrapped = records.filter(
      (r) =>
        r.status === 'ended' &&
        r.wrap_up !== undefined &&
        r.wrap_up !== 'done' &&
        !this.ending.has(r.id),
    );
    for (const r of unwrapped) this.ending.set(r.id, r);
    for (const r of records) {
      if (r.status !== 'running' || this.live.has(r.id)) continue;
      const l: LiveRun = {
        record: r,
        meter: new UsageMeter(),
        offset: 0,
        decoder: new StringDecoder('utf8'),
      };
      this.live.set(r.id, l);
      const same = sameProcess(r);
      if (same === false) this.finish(r.id, null);
      else if (same === 'unknown') void this.recheckAdopted(l);
    }
    for (const r of unwrapped) {
      this.emit('warn', `run ${r.id}: resuming its wrap-up (${r.wrap_up}) after a restart`);
      this.startWrapUp(r, true);
    }
  }

  /**
   * An adopted run whose creation time could not be read at adoption: reads it again without
   * blocking, and ends the run as lost once it shows another process. Until then it counts as the
   * run's; a kill checks the creation time at the moment of the kill either way. `stop` cancels
   * the wait and the pending read, so neither keeps opsd from exiting; the next opsd checks again.
   */
  private async recheckAdopted(l: LiveRun): Promise<void> {
    const r = l.record;
    const signal = this.stopAbort.signal;
    this.emit(
      'warn',
      `run ${r.id}: could not read the creation time of PID ${r.pid}; checking again`,
    );
    for (let attempt = 0; attempt < ADOPT_RECHECKS; attempt++) {
      if (attempt > 0) await sleepUnless(ADOPT_RECHECK_MS, signal);
      if (this.stopping || this.live.get(r.id) !== l) return;
      const now = await processStart(r.pid, signal);
      if (this.stopping || this.live.get(r.id) !== l) return;
      if (now === r.proc_start) return;
      if (now !== null || !isAlive(r.pid)) {
        this.finish(r.id, null);
        return;
      }
    }
    this.emit('warn', `run ${r.id}: creation time of PID ${r.pid} still unreadable; kept adopted`);
  }

  start(): void {
    this.adopt();
    this.safe(() => this.chat.resume());
    void this.sweep();
    this.timer = setInterval(() => void this.tick(), this.config.tick_seconds * 1000);
    // Processes are looked at more often than the tick, so short-lived parents are seen.
    this.procTimer = setInterval(() => void this.trackProcs(), this.config.proc_seconds * 1000);
  }

  /**
   * Stops the loop. Runs keep going unless `killRuns`; the next opsd adopts them. Where runs
   * cannot outlive opsd (`runsOutlive` off), they are stopped like `killRuns`, so they end with
   * their claims released instead of being cut off when this process exits.
   */
  stop(opts: { killRuns?: boolean } = {}): void {
    this.stopping = true;
    this.stopAbort.abort();
    // A merge stops before the base moves; the next opsd starts it again.
    this.merging?.runner.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.procTimer) clearInterval(this.procTimer);
    this.procTimer = undefined;
    this.chat.close();
    if (opts.killRuns || !this.runsOutlive) {
      this.killingAll = true;
      for (const id of [...this.live.keys()]) this.kill(id, 'shutdown');
      return;
    }
    // Live runs stay with the next opsd: their handles must not keep this process alive, or
    // a stop or restart waits for every run to end. A run still launching keeps its handle
    // until `close` settles it.
    for (const l of this.live.values()) {
      if (l.launch) continue;
      l.child?.unref();
      (l.child?.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    }
  }

  /**
   * Stops accepting launches if no run is live, and says whether it did. Checked and set in one
   * step, so no launch can slip in between; for a shutdown that must not stop agents.
   */
  quiesceIfIdle(): boolean {
    if (this.live.size > 0 || this.ending.size > 0) return false;
    this.stopping = true;
    return true;
  }

  /**
   * After `stop`: waits for killed runs to end (up to 10 s) and for the cleanup of their
   * processes, then closes the process lister. Windows: a run left to the next opsd whose
   * launcher has not had its command yet gets up to 5 s to finish launching; after that it ends
   * here, with its claim released, since only a recorded launcher outlives opsd.
   */
  async close(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (this.killingAll && this.live.size > 0 && Date.now() < deadline) await sleep(50);
    const launching = (): LiveRun[] => [...this.live.values()].filter((l) => l.launch);
    const settle = Date.now() + 5_000;
    while (launching().length > 0 && Date.now() < settle) await sleep(50);
    const cut = launching();
    for (const l of cut) {
      l.killReason ??= 'shutdown';
      this.abortLaunch(l);
    }
    const ends = Date.now() + 10_000;
    while (cut.some((l) => this.live.get(l.record.id) === l) && Date.now() < ends) await sleep(50);
    // Ended runs finish their wrap-up: reaping, helpers, the leftover commit, the task events.
    const wrapped = Date.now() + HELPER_END_MS + 10_000;
    while (this.ending.size > 0 && Date.now() < wrapped) await sleep(50);
    await this.merging?.done;
    await this.procChain;
    this.closed = true;
    this.lister?.close();
    this.lister = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.trackProcs();
      this.watchRuns();
      this.safe(() => this.writePresences());
      if (this.config.sync) this.syncRoots();
      // Before the wake plan, so a merge that starts now holds its checkout from this tick.
      this.safe(() => this.mergeTick());
      this.dirtyHolds = new Map();
      try {
        this.runSchedules();
        // Before wake, so a task a repeat creates now can start this tick.
        this.safe(() => this.runRepeats());
        // Before wake: a person waiting for a reply comes before inbox work of the same agent.
        if (!this.stopping) this.safe(() => this.chat.tick());
        // Before wake, so an accepted finding gets its owner and starts in the same tick.
        if (!this.stopping) this.routeOwners();
        this.wake();
      } finally {
        const holds = this.dirtyHolds;
        this.dirtyHolds = null;
        this.safe(() => this.dirtyTick(holds));
      }
      this.safe(() => this.notifyTick());
      this.emit('tick');
    } finally {
      this.ticking = false;
    }
  }

  /** This machine's presence in each root it syncs, so other clones see it alive. */
  private writePresences(): void {
    if (!presenceSlug(this.user.machine)) return;
    const live = this.liveRecords();
    const p = {
      machine: this.user.machine!,
      last_seen: new Date(this.now()).toISOString(),
      live_runs: live.length,
      version: this.version,
      build: this.build,
      agents: [...new Set(live.map((r) => r.agent))].sort(),
    };
    for (const root of this.ws().roots) {
      if (root.isMirror) continue;
      writePresence(root, p, undefined, this.now());
    }
  }

  /**
   * Tells the human, once per checkout until it is clean again, that its uncommitted changes
   * hold a writing run while no run works there to commit them (AO-0137). Before, the hold
   * showed only in `ops waits` and the app's Waiting list. A checkout with a live or ending run
   * is left alone: the changes may be that run's work, which its wrap-up commits.
   */
  private dirtyTick(holds: Map<string, DirtyHold>): void {
    const told = this.store.readJson<DirtyNotices>('dirty-checkouts.json', {});
    let changed = false;
    // A checkout no run waits on any more is forgotten once clean, so new changes there are news.
    for (const top of Object.keys(told)) {
      if (holds.has(top)) continue;
      const changes = this.changesIn(top);
      if (!(changes instanceof Error) && changes.length === 0) {
        delete told[top];
        changed = true;
      }
    }
    const live = this.liveRecords();
    for (const [top, hold] of holds) {
      if (told[top]) continue;
      if (live.some((r) => r.cwd !== undefined && samePath(this.checkoutTop(r.cwd), top))) continue;
      const ws = this.ws(DIRTY_ACTOR);
      const human = this.user.me ?? ws.roots[0]?.config.human;
      if (!human) continue;
      const what = hold.task ? ` on ${hold.task}` : '';
      const more = hold.count > 1 ? ` and ${hold.count - 1} more` : '';
      const text =
        `${hold.agent} waits to work${what} in ${top}, but that checkout has uncommitted ` +
        `changes and no run works in it: ${hold.file}${more}. Commit, stash or discard them, ` +
        `and writing runs start there again.`;
      try {
        ws.post(DIRTY_CHANNEL, text, { to: [human], task: hold.task });
      } catch (err) {
        // Recorded anyway, so a refused post warns once instead of every tick.
        this.emit('warn', `cannot tell ${human} about the changes in ${top}: ${String(err)}`);
      }
      told[top] = { file: hold.file, at: new Date(this.now()).toISOString() };
      changed = true;
    }
    if (changed) this.store.writeJson('dirty-checkouts.json', told);
  }

  private notifier?: Notifier;

  /** Offers new inbox items for the human and failed runs to the webhook, if one is set. */
  private notifyTick(): void {
    const cfg = this.config.notify;
    if (!cfg.webhook) return;
    this.notifier ??= new Notifier(this.store, (m) => this.emit('warn', m));
    const items: NotifyItem[] = [];
    const me = this.user.me;
    if (me) {
      const ws = this.ws();
      for (const it of ws.inbox(me)) {
        // Asks and reviews come from the task's state: key them by the event that started this
        // round, so a second round on the same task is news too.
        let event = it.event;
        if (!event && (it.kind === 'ask' || it.kind === 'review')) {
          const types = it.kind === 'ask' ? ['ask', 'block'] : ['review'];
          event = [...ws.showEvents(it.task).events]
            .reverse()
            .find((e) => types.includes(e.type))?.id;
        }
        items.push({
          key: `${it.kind}:${it.task}:${event ?? ''}`,
          kind: it.kind,
          line: `${it.task} ${it.kind}: ${it.summary || it.title}`,
        });
      }
    }
    const day = this.now() - 86_400_000;
    for (const r of this.store.list()) {
      if (r.status !== 'ended' || !r.ended_at || Date.parse(r.ended_at) < day) continue;
      const failed =
        (r.reason === 'exit' && r.exit !== 0) ||
        r.reason === 'lost' ||
        r.reason === 'budget' ||
        r.reason === 'tokens';
      if (!failed) continue;
      items.push({
        key: `run:${r.id}`,
        kind: 'run-failed',
        line: `run of ${r.agent}${r.task ? ` on ${r.root}/${r.task}` : ''} ended: ${r.reason === 'exit' ? `exit ${r.exit}` : r.reason}`,
      });
    }
    this.notifier.offer(items, cfg);
    // flush never throws, but nothing a webhook does may reach the tick.
    this.notifier.flush(cfg, this.now()).catch(() => this.emit('warn', 'notify: send failed'));
  }

  /** Sends a sample message to the webhook; the result never holds the URL. */
  async notifyTest(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.config.notify;
    if (!cfg.webhook) return { ok: false, error: 'no webhook set' };
    let error: string | undefined;
    const n = new Notifier(this.store, (m) => {
      error = m;
    });
    const ok = await n.send(cfg.webhook, 'Agent Ops: test message from opsd. Notifications work.');
    return ok ? { ok } : { ok, error };
  }

  private watchRuns(): void {
    const now = this.now();
    for (const [id, l] of [...this.live]) {
      // A helper whose parent is gone (also after an opsd restart) ends with it.
      if (l.record.parent && !this.live.has(l.record.parent)) {
        if (!l.killReason) this.safe(() => this.kill(id, 'parent-ended'));
        continue;
      }
      if (!l.child && !isAlive(l.record.pid)) {
        this.finish(id, null);
        continue;
      }
      const before = l.record.tokens;
      this.readLog(l);
      const r = l.record;
      if (now - Date.parse(r.started_at) > r.budget_minutes * 60_000) {
        this.kill(id, 'budget');
        continue;
      }
      if (r.token_budget && r.tokens > r.token_budget) {
        this.kill(id, 'tokens');
        continue;
      }
      if (r.tokens !== before) {
        this.store.save(r);
        this.emit('run', r);
      }
      if (r.task && r.root) this.safe(() => this.renewLease(r, now));
    }
  }

  /** Renews the run's claim when less than half of the lease is left. */
  private renewLease(r: RunRecord, now: number): void {
    const ws = this.ws(r.agent, r.id);
    const ref = `${r.root}/${r.task}`;
    const v = ws.view(ref);
    if (!ws.holdsClaim(ref) || !v.leaseUntil) return;
    const leases = ws.resolve(ref).root.config.leases;
    const full = (v.status === 'claimed' ? leases.claim_minutes : leases.work_minutes) * 60_000;
    if (Date.parse(v.leaseUntil) - now < full / 2) ws.renew(ref, r.id);
  }

  private syncRoots(): void {
    const ws = this.ws();
    const pushing: Root[] = [];
    const due = ws.roots.filter((root) => {
      const d = syncDue(root, this.now());
      if (d.push) pushing.push(root);
      return d.pull || d.push;
    });
    if (due.length === 0) return;
    // A due root brings its mirror partner, so the copy in the Master Repo keeps up.
    const targets = [...new Set(due.flatMap((root) => mirrorPartners(root, ws.roots, this.user)))];
    this.safe(() => {
      for (const { root, result } of syncAll(targets, this.user, { auto: true, now: this.now() })) {
        this.synced(root.name, result);
      }
    });
    this.safe(() => this.pushBranches(pushing));
  }

  // ---- Pushing task branches ------------------------------------------------------------------

  /**
   * Pushes the task branches of each repo the roots live in, those with commits no base and no
   * remote branch holds, so unmerged work is not only on this machine. Then deletes the remote
   * branches of merged work whose base the remote has. A repo is skipped when any of its roots
   * has `opsd.push_branches.<root>` set to false.
   */
  private pushBranches(roots: Root[]): void {
    const repos = new Map<string, Root[]>();
    for (const root of roots) {
      const top = this.gitTopOf(resolve(root.dir));
      if (top) repos.set(top, [...(repos.get(top) ?? []), root]);
    }
    if (repos.size === 0) return;
    const state = this.branchState();
    const prefixes = Object.keys(this.config.runtimes).map((r) => `${r}/`);
    for (const [top, inRepo] of repos) {
      if (inRepo.some((r) => this.config.push_branches[r.name] === false)) continue;
      const pusher = new BranchPusher(top, this.commandEnv());
      const head = pusher.headBranch();
      const bases = [
        ...new Set([
          ...(head ? [head] : []),
          ...inRepo.flatMap((r) => this.config.merge[r.name]?.base ?? []),
        ]),
      ];
      const round = pusher.pushNew({
        prefixes,
        bases,
        merged: state.merged[top] ?? {},
        seen: state.seen[top] ?? {},
      });
      state.seen[top] = round.seen;
      this.emit('branches', { top, ...round });
      for (const h of round.held) this.emit('warn', `push of ${h.branch}: ${h.why}`);
      if (round.error) this.emit('warn', round.error);
      if (round.remote && !round.error) {
        state.deletes = state.deletes.filter(
          (d) => d.top !== top || !this.deleteMerged(pusher, round.remote!, d),
        );
      }
      // Merged tips that are no longer a branch's tip need no remembering.
      const merged = state.merged[top];
      for (const b of Object.keys(merged ?? {})) {
        if (!pusher.isAncestor(`refs/heads/${b}`, merged![b]!)) delete merged![b];
      }
    }
    this.store.writeJson('branches.json', state);
  }

  /**
   * Deletes the remote branch of work opsd merged, once the remote's base has the merged commit.
   * Returns true when the delete is settled: done, not needed, or refused for good.
   */
  private deleteMerged(pusher: BranchPusher, remote: string, d: PendingDelete): boolean {
    if (!pusher.isAncestor(d.commit, `refs/remotes/${remote}/${d.base}`)) return false;
    try {
      const r = pusher.deleteRemote(remote, d.branch, d.approved);
      if (r === 'deleted') {
        this.emit('warn', `push: deleted ${remote}/${d.branch}, merged into ${d.base} (${d.ref})`);
      } else if (r !== 'absent') {
        this.emit('warn', `push: ${r} (${d.ref})`);
      }
      return true;
    } catch (err) {
      this.emit('warn', `push: could not delete ${remote}/${d.branch}: ${gitError(err)}`);
      return false;
    }
  }

  /** What branch pushing keeps between rounds, in `branches.json`. */
  private branchState(): BranchState {
    const s = this.store.readJson<Partial<BranchState>>('branches.json', {});
    return { seen: s.seen ?? {}, merged: s.merged ?? {}, deletes: s.deletes ?? [] };
  }

  /**
   * Remembers a branch opsd merged: its approved tip is not pushed again, and its remote branch
   * is deleted once the remote's base has `commit`.
   */
  private branchMerged(
    ref: string,
    rootName: string,
    branch: string,
    approved: string,
    base: string,
    commit: string,
  ): void {
    if (this.config.push_branches[rootName] === false) return;
    const root = this.ws().roots.find((r) => r.name === rootName);
    const top = root ? this.gitTopOf(resolve(root.dir)) : null;
    if (!top) return;
    const state = this.branchState();
    state.merged[top] = { ...state.merged[top], [branch]: approved };
    state.deletes = [
      ...state.deletes.filter((d) => d.top !== top || d.branch !== branch),
      { top, branch, approved, base, commit, ref },
    ];
    this.store.writeJson('branches.json', state);
  }

  // ---- Merging approved work ------------------------------------------------------------------

  /**
   * Starts merging one approved task of a root with `opsd.merge` set, when no merge runs and no
   * writing run is live in the checkout the base is built in. A task qualifies when its last
   * verdict approves it, came after opsd first saw the root's merge setting, has nothing from
   * opsd after it, and the review it approved names a branch.
   */
  private mergeTick(): void {
    if (this.merging || this.stopping || this.mergeClearing) return;
    // What an earlier merge command left running goes first, so nothing races it.
    if (this.mergeLeftovers().length > 0) return this.clearMergeLeftovers();
    const merge = this.config.merge;
    // A build an earlier opsd stopped after moving a base goes first.
    for (const p of Object.values(this.pendingBuilds())) {
      const cfg = merge[p.root];
      if (!cfg || cfg.base !== p.base) {
        this.dropPendingBuild(p.ref);
        continue;
      }
      if (!this.writerIn(p.top)) {
        this.emit('warn', `merge of ${p.ref}: building ${p.base} again after a restart`);
        this.startMerge(p.ref, p.top, p.base, p.what, p.human, (runner) =>
          this.buildMerged(p, cfg, runner),
        );
      }
      return;
    }
    if (Object.keys(merge).length === 0) return;
    const ws = this.ws();
    const since = this.mergeSince(ws.roots.filter((r) => merge[r.name]).map((r) => r.name));
    const done = ws
      .views()
      .filter((v) => v.status === 'done' && merge[v.root] && v.updatedAt >= since[v.root]!)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const v of done) {
      const ref = `${v.root}/${v.meta.id}`;
      if (v.lastEvent && this.mergeSeen.get(ref) === v.lastEvent) continue;
      const job = this.mergeJob(ws, ref, merge[v.root]!, since[v.root]!);
      if (!job) {
        if (v.lastEvent) this.mergeSeen.set(ref, v.lastEvent);
        continue;
      }
      // The checkout's writing run finishes first; this task waits for the next tick.
      if (this.writerIn(job.top)) continue;
      this.startMerge(ref, job.top, job.cfg.base, job.what, job.human, (runner) =>
        this.mergeOne(ref, job, runner),
      );
      return;
    }
  }

  /** Whether a top-level writing run is live in the checkout `top`. */
  private writerIn(top: string): boolean {
    return this.liveRecords().some(
      (r) => this.writingRun(r) && samePath(this.checkoutTop(r.cwd), top),
    );
  }

  /** Runs `work` as the merge under way, holding the checkout `top` until it is over. */
  private startMerge(
    ref: string,
    top: string,
    base: string,
    what: string,
    human: string | undefined,
    work: (runner: CommandRunner) => Promise<void>,
  ): void {
    const runner = new CommandRunner(this.commandEnv(), { watch: this.mergeWatch() });
    const merging = { ref, top, base, runner, done: Promise.resolve() };
    this.merging = merging;
    merging.done = work(runner)
      .catch((err) => {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        this.emit('warn', `merge of ${ref}: ${msg}`);
        this.mergeNote(ref, `opsd could not merge ${what}: ${firstLines(msg)}`, human);
      })
      .finally(() => {
        // A merge that wrote nothing is not tried again until the task changes; one stopped
        // with opsd is, by the next opsd.
        this.safe(() => {
          const last = this.ws().view(ref).lastEvent;
          if (last && !this.stopping) this.mergeSeen.set(ref, last);
        });
        this.merging = null;
      });
  }

  /** The merge under way, if any: the task and the checkout it holds. */
  get merge(): { ref: string; top: string; base: string } | null {
    if (!this.merging) return null;
    const { ref, top, base } = this.merging;
    return { ref, top, base };
  }

  /**
   * Resolves once the merge under way, if any, is over; and first, a look at what earlier merge
   * commands left running, with the merge it lets start.
   */
  async mergeSettled(): Promise<void> {
    await this.mergeClearing;
    await this.merging?.done;
  }

  /** When opsd first saw each root's merge setting; only verdicts after it are merged. */
  private mergeSince(roots: string[]): Record<string, string> {
    const since = this.store.readJson<Record<string, string>>('merge.json', {});
    let changed = false;
    for (const r of roots) {
      if (since[r]) continue;
      since[r] = new Date(this.now()).toISOString();
      changed = true;
    }
    if (changed) this.store.writeJson('merge.json', since);
    return since;
  }

  /** What merging `ref` takes, or null when the task has nothing for opsd to merge. */
  private mergeJob(ws: Workspace, ref: string, cfg: MergeConfig, since: string): MergeJob | null {
    const { events } = ws.showEvents(ref);
    let at = events.length - 1;
    while (at >= 0 && events[at]!.type !== 'verdict') at--;
    const verdict = events[at];
    if (!verdict || verdict.verdict !== 'approve' || verdict.actor === MERGE_ACTOR) return null;
    if (verdict.at < since) return null;
    if (events.slice(at + 1).some((e) => e.actor === MERGE_ACTOR)) return null;
    const review = events
      .slice(0, at)
      .reverse()
      .find((e) => e.type === 'review');
    const src = review ? mergeSource(review.body) : null;
    if (!review || !src) return null;
    const root = ws.resolve(ref).root;
    const top = cfg.checkout ? resolve(cfg.checkout) : this.gitTopOf(resolve(root.dir));
    if (!top) return null;
    const what = src.commit
      ? `${src.commit} on branch ${src.branch}`
      : `branch ${src.branch ?? '?'}`;
    const v = ws.view(ref);
    const author = v.owner && !v.owner.includes('*') ? v.owner : review.actor;
    return { cfg, top, src, what, author, human: root.config.human, root: root.name };
  }

  /**
   * Rebases the approved commit onto the base in opsd's worktree, runs the checks there, moves
   * the base forward, and builds it in its checkout. A conflict or a failed check sends the
   * task back to its author; nothing is ever forced. When the base moved in the meantime (a
   * task store sync, say), the rebase runs again, and the checks too unless only task store
   * files changed.
   */
  private async mergeOne(ref: string, job: MergeJob, runner: CommandRunner): Promise<void> {
    const { cfg, top, src } = job;
    const repo = new MergeRepo(
      top,
      join(this.store.dir, 'merge', job.root.replace(/[^A-Za-z0-9._-]/g, '-')),
      this.ws().roots.map((r) => r.dir),
      this.commandEnv(),
    );
    const source = src.commit
      ? repo.commit(src.commit)
      : src.branch
        ? (repo.commit(`refs/heads/${src.branch}`) ?? repo.commit(src.branch))
        : null;
    if (!source) {
      const missing = src.commit ? `commit ${src.commit}` : `branch ${src.branch}`;
      this.mergeNote(ref, `opsd cannot merge ${job.what}: ${missing} is not in ${top}`, job.human);
      return;
    }
    if (!repo.commit(`refs/heads/${cfg.base}`)) {
      this.mergeNote(
        ref,
        `opsd cannot merge ${job.what}: no branch ${cfg.base} in ${top}`,
        job.human,
      );
      return;
    }
    const timeout = (cfg.timeout_minutes ?? 30) * 60_000;
    let checked: string | null = null;
    let checks: CommandResult[] = [];
    let merged: { head: string; onto: string } | null = null;
    let refused = '';
    for (let attempt = 0; attempt < MERGE_ATTEMPTS && !merged; attempt++) {
      if (attempt > 0) await sleep(MERGE_RETRY_MS);
      if (this.stopping) return;
      const onto = repo.commit(`refs/heads/${cfg.base}`)!;
      repo.ensureWorktree(onto);
      const r = repo.rebase(source, onto);
      if ('conflict' in r) {
        this.mergeBack(
          ref,
          job.what,
          job.author,
          `it does not rebase onto ${cfg.base} (${short(onto)})`,
          r.conflict,
        );
        return;
      }
      if (r.head === onto) {
        this.mergeRecord(
          { ref, base: cfg.base, branch: src.branch, commit: onto },
          `${job.what} is already in ${cfg.base}; nothing to merge.`,
        );
        if (src.branch) {
          this.safe(() => this.branchMerged(ref, job.root, src.branch!, source, cfg.base, onto));
        }
        return;
      }
      // Task store files on a branch would overwrite the live store in the checkout.
      const store = repo.storeFiles(onto, r.head);
      if (store.length > 0) {
        const more = store.length > 3 ? ` and ${store.length - 3} more` : '';
        this.mergeBack(
          ref,
          job.what,
          job.author,
          `it changes task store files (${store.slice(0, 3).join(', ')}${more}); take them out of the branch`,
          '',
        );
        return;
      }
      if (!checked || !repo.sameCode(checked, r.head)) {
        checks = await runner.runAll(cfg.checks ?? [], repo.worktree, timeout);
        const failed = checks.find((c) => !c.ok);
        // Stopped with opsd: the next opsd merges it from the start.
        if (failed?.why === 'stopped') return;
        if (failed) {
          this.mergeBack(
            ref,
            job.what,
            job.author,
            `\`${failed.command}\` failed (${failed.why}) on it rebased onto ${cfg.base} (${short(onto)})`,
            failed.output,
          );
          return;
        }
        checked = r.head;
      }
      if (this.stopping) return;
      try {
        if (repo.fastForward(cfg.base, onto, r.head) === 'done') merged = { head: r.head, onto };
        else refused = `${cfg.base} kept moving`;
      } catch (err) {
        // Local changes in the way, or a lock another git command holds: tried again shortly.
        refused = firstLines(err instanceof Error ? err.message : String(err));
      }
    }
    if (!merged) {
      const why = `${cfg.base} did not move: ${refused}`;
      this.mergeNote(ref, `opsd could not merge ${job.what}; ${why}`, job.human);
      return;
    }
    if (src.branch) {
      const { branch } = src;
      const { head } = merged;
      this.safe(() => this.branchMerged(ref, job.root, branch, source, cfg.base, head));
    }
    const files = repo.changedFiles(merged.onto, merged.head).length;
    const passed =
      checks.length > 0
        ? ` Checks passed: ${checks.map((c) => `\`${c.command}\``).join(', ')}.`
        : '';
    // Saved before the build, so an opsd that stops during it leaves the build to the next one.
    const pending: PendingBuild = {
      ref,
      root: job.root,
      top,
      base: cfg.base,
      branch: src.branch,
      commit: merged.head,
      what: job.what,
      author: job.author,
      human: job.human,
      text: `Merged ${job.what} into ${cfg.base} as ${short(merged.head)}, rebased onto ${short(merged.onto)} (${files} file(s)).${passed}`,
    };
    this.savePendingBuild(pending);
    await this.buildMerged(pending, cfg, runner);
  }

  /**
   * Runs the build of a base opsd moved forward, in its checkout, and records the merge with the
   * build's result. A failed build sends the task back. A build stopped with opsd stays pending:
   * the merge is recorded now, and the next opsd runs the build again and comments on the result.
   */
  private async buildMerged(
    p: PendingBuild,
    cfg: MergeConfig,
    runner: CommandRunner,
  ): Promise<void> {
    const timeout = (cfg.timeout_minutes ?? 30) * 60_000;
    const build = await runner.runAll(cfg.build ?? [], p.top, timeout);
    const broke = build.find((c) => !c.ok);
    if (broke?.why === 'stopped') {
      if (p.text !== null) {
        this.mergeRecord(
          p,
          `${p.text} Build: \`${broke.command}\` was stopped with opsd; the next opsd runs the build again.`,
        );
        this.savePendingBuild({ ...p, text: null });
      }
      return;
    }
    const commands = build.map((c) => `\`${c.command}\``).join(', ');
    if (p.text !== null) {
      const built =
        build.length === 0
          ? ''
          : broke
            ? ` Build: \`${broke.command}\` failed (${broke.why}).`
            : ` Built with ${commands}.`;
      this.mergeRecord(p, `${p.text}${built}`);
    } else if (!broke && build.length > 0) {
      this.mergeNote(
        p.ref,
        `Built ${p.base} with ${commands} after a restart (${short(p.commit)}).`,
      );
    }
    this.dropPendingBuild(p.ref);
    if (broke) {
      this.mergeBack(
        p.ref,
        p.what,
        p.author,
        `${p.base} has it as ${short(p.commit)}, but \`${broke.command}\` failed (${broke.why}) in ${p.top}; fix it in a new commit`,
        broke.output,
      );
    }
  }

  /** Builds an earlier opsd left pending, by task. */
  private pendingBuilds(): Record<string, PendingBuild> {
    return this.store.readJson<Record<string, PendingBuild>>('merge-builds.json', {});
  }

  private savePendingBuild(p: PendingBuild): void {
    this.store.writeJson('merge-builds.json', { ...this.pendingBuilds(), [p.ref]: p });
  }

  private dropPendingBuild(ref: string): void {
    const all = this.pendingBuilds();
    if (!(ref in all)) return;
    delete all[ref];
    this.store.writeJson('merge-builds.json', all);
  }

  /** The merge event, with the commit the base moved to. */
  private mergeRecord(
    p: { ref: string; base: string; branch?: string; commit: string },
    text: string,
  ): void {
    this.ws(MERGE_ACTOR).recordMerge(
      p.ref,
      { commit: p.commit, into: p.base, branch: p.branch },
      text,
    );
  }

  /**
   * Sends the task back to its author with what failed and the end of its output. Lines that look
   * like secrets are taken out of the output before it is kept anywhere, log file included.
   */
  private mergeBack(ref: string, what: string, author: string, why: string, output: string): void {
    const safe = redactSecrets(output);
    const log = this.mergeLog(ref, safe);
    const head = `opsd did not merge ${what}: ${why}.`;
    const tail = `Fix it on the branch and ask for review again.${log ? ` Full output: ${log}` : ''}`;
    const out = lastLines(safe);
    this.ws(MERGE_ACTOR).sendBack(
      ref,
      out ? `${head}\n\n\`\`\`\n${out}\n\`\`\`\n\n${tail}` : `${head} ${tail}`,
      author,
    );
  }

  /** A comment from opsd on a merge it did not do, for a person. */
  private mergeNote(ref: string, text: string, to?: string): void {
    this.safe(() => this.ws(MERGE_ACTOR).comment(ref, text, to));
  }

  /** Keeps a merge's whole output, already without secrets, in opsd's state folder; returns the file, or null. */
  private mergeLog(ref: string, output: string): string | null {
    if (!output) return null;
    try {
      const dir = join(this.store.dir, 'merge', 'logs');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${ref.replace(/[^A-Za-z0-9._-]/g, '-')}-${ulid(this.now())}.log`);
      writeFileSync(file, output);
      return file;
    } catch {
      return null;
    }
  }

  /** The environment merge commands run with: opsd's, without any run's identity. */
  private commandEnv(): NodeJS.ProcessEnv {
    const env = { ...this.env };
    for (const k of ['OPS_AGENT', 'OPS_RUN', 'OPS_PARENT_RUN', 'OPS_ROOTS']) delete env[k];
    return env;
  }

  /**
   * Creates the tasks of due repeats (AO-0142). Paused opsd creates none; on resume or the next
   * start each repeat fires once for the latest slot it missed.
   */
  private runRepeats(): void {
    if (!this.config.repeats || this.config.paused || this.stopping) return;
    const fired = this.ws().fireRepeats();
    if (fired.length > 0) this.emit('repeats', fired);
  }

  private runSchedules(): void {
    if (this.config.schedules.length === 0) return;
    const last = this.store.readJson<Record<string, number>>('schedules.json', {});
    const now = this.now();
    let changed = false;
    for (const s of this.config.schedules) {
      if (s.paused || !scheduleDue(s, last[s.name], now)) continue;
      this.safe(() => {
        const ws = this.ws(s.agent);
        if (this.scheduleBlocker(ws, s)) return;
        if (s.task && this.liveRecords().some((r) => r.task === ws.resolve(s.task!).id)) return;
        this.launch({
          agent: s.agent,
          task: s.task,
          extra: s.prompt || undefined,
          schedule: s.name,
        });
        // Recorded only after the launch worked, so a failed launch is retried next tick.
        last[s.name] = now;
        changed = true;
      });
    }
    if (changed) this.store.writeJson('schedules.json', last);
  }

  /**
   * Bottleneck first: reviews; then tasks that resume after an answer or a change request; then
   * new claims; last, runs that only read an inbox, since they name no work. Within each,
   * priority, then the project with the fewest live runs, then age.
   */
  private sortCandidates(pending: WakeCandidate[], live: PlannedRun[]): void {
    // Someone waits for a question's answer, as for resumed work.
    const rank = (c: WakeCandidate): number =>
      c.kind === 'review' ? 0 : c.kind === 'task' ? (c.resume || c.question ? 1 : 2) : 3;
    const order: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
    const liveIn = (project: string): number =>
      live.filter((r) => !r.question && (r.project ?? r.root) === project).length;
    pending.sort(
      (x, y) =>
        rank(x) - rank(y) ||
        (order[x.priority] ?? 9) - (order[y.priority] ?? 9) ||
        liveIn(x.project) - liveIn(y.project) ||
        (x.created < y.created ? -1 : x.created > y.created ? 1 : 0),
    );
  }

  /**
   * Tasks in a project that wait for review by an agent opsd runs. Reviews that wait for a
   * person, or for an agent with no opsd entry, do not load the agent reviewers; counting them
   * held every writer until the person reviewed (AO-0094).
   */
  private reviewBacklog(views: TaskView[], project: string): number {
    const agents = Object.keys(this.config.agents);
    return views.filter(
      (v) =>
        v.status === 'needs-review' &&
        (v.meta.project ?? v.root) === project &&
        v.reviewer !== null &&
        !isHuman(v.reviewer) &&
        agents.some((a) => ownerMatches(v.reviewer, a)),
    ).length;
  }

  private wakingAgents(): string[] {
    return Object.entries(this.config.agents)
      .filter(([, c]) => c.wake)
      .map(([a]) => a);
  }

  /**
   * The routes `routeOwners` writes: ownerless work and the role group that wakes for it. Uses
   * the role limits `wakeCandidates` filters by, so a routed task has an agent it may start.
   */
  private plannedRoutes(ws: Workspace = this.ws()): Route[] {
    const waking = this.wakingAgents().filter((a) => !roleInactive(ws.agent(a)));
    return ws.routes(waking, (a) => roleLimits(this.config, roleOf(a)));
  }

  /**
   * Gives each open task without a working owner a role group from its type and labels (AO-0140):
   * a finding a person accepted, or work whose owner no configured agent answers to. Recorded as
   * an `assign` event from `ROUTE_ACTOR` with the reason.
   */
  private routeOwners(): void {
    this.safe(() => {
      const ws = this.ws(ROUTE_ACTOR);
      for (const r of this.plannedRoutes(ws)) {
        if (r.blocker) continue;
        this.safe(() => ws.route(`${r.view.root}/${r.view.meta.id}`, r.to, r.reason));
      }
    });
  }

  /**
   * What the waking agents could start now: review requests (one run each, no claim), new inbox
   * items an agent was not started for (one run per agent), and claimable tasks (one candidate
   * per task). A task more than one agent may take (owned by `*:<role>` or by nobody) lists its
   * agents in the role's provider order.
   */
  private wakeCandidates(
    agents: string[],
    reviewed: Record<string, string[]>,
    state: Record<string, WakeState>,
    inboxItems: Map<string, InboxKey[]> = new Map(),
  ): WakeCandidate[] {
    const byTask = new Map<string, WakeCandidate>();
    const now = this.now();
    for (const agent of agents) {
      this.safe(() => {
        const ws = this.ws(agent);
        const inbox = ws.inbox();
        for (const item of inbox) {
          if (item.kind !== 'review') continue;
          const v = ws.view(item.task);
          if (v.status !== 'needs-review' || !ownerMatches(v.reviewer, agent)) continue;
          const ref = `${v.root}/${v.meta.id}`;
          // Keyed by the review request itself, so a later request after changes gets a run too.
          const request = [...ws.showEvents(ref).events].reverse().find((e) => e.type === 'review');
          const key = `${ref}:${request?.id ?? item.event ?? ''}`;
          if (reviewed[agent]?.includes(key)) continue;
          byTask.set(`review:${ref}`, {
            kind: 'review',
            ref,
            root: v.root,
            id: v.meta.id,
            project: v.meta.project ?? v.root,
            title: v.meta.title,
            priority: v.meta.priority,
            created: v.meta.created_at,
            key,
            agents: [agent],
          });
        }
        // Mentions of the chat agent continue the chat instead of waking an inbox run.
        const chatMentions = this.config.chat.mentions && agent === this.config.chat.agent;
        const items = inbox
          .filter((i) => i.kind !== 'review' && !(chatMentions && i.kind === 'mention'))
          .map((i) => ({
            key: `${i.task}:${i.event ?? i.kind}`,
            root: i.root,
            id: i.task.split('/').pop() ?? i.task,
          }));
        inboxItems.set(agent, items);
        const keys = items.map((i) => i.key);
        const prev = state[agent] ?? { keys: [], at: 0 };
        const fresh = keys.filter((k) => !prev.keys.includes(k));
        const cooled = now - prev.at >= this.config.wake_cooldown_minutes * 60_000;
        if (fresh.length > 0 && cooled) {
          byTask.set(`inbox:${agent}`, {
            kind: 'inbox',
            project: this.projectOf(ws),
            title: `${fresh.length} new inbox item(s) for ${agent}`,
            priority: 'p1',
            created: '',
            keys,
            agents: [agent],
          });
        }
        for (const v of ws.queue()) {
          const ref = `${v.root}/${v.meta.id}`;
          // Work that comes back after an answer or a change request finishes before new work.
          const last = [...ws.showEvents(ref).events]
            .reverse()
            .find((e) =>
              ['answer', 'verdict', 'unblock', 'claim', 'release', 'handoff', 'delegate'].includes(
                e.type,
              ),
            );
          const resume =
            last?.type === 'answer' ||
            last?.type === 'unblock' ||
            (last?.type === 'verdict' && last.verdict === 'changes');
          const c = byTask.get(ref) ?? {
            kind: 'task' as const,
            resume,
            ref,
            root: v.root,
            id: v.meta.id,
            project: v.meta.project ?? v.root,
            title: v.meta.title,
            priority: v.meta.priority,
            created: v.meta.created_at,
            owner: v.owner ?? null,
            avoid: v.delegation?.review,
            question: v.meta.type === QUESTION_TYPE || undefined,
            type: v.meta.type,
            agents: [],
          };
          c.agents.push(agent);
          byTask.set(ref, c);
        }
      });
    }
    for (const c of byTask.values()) {
      // A task owned by one agent, or by one provider (`claude:*`), stays with it.
      if (c.kind !== 'task' || (c.owner && !c.owner.startsWith('*:'))) continue;
      // `*:<role>` and unowned tasks: only the role's providers, in their order; never the
      // provider of the reviewer the task expects; without overflow, only the first provider.
      const order = (x: string): string[] => roleLimits(this.config, roleOf(x)).providers;
      c.agents = c.agents.filter((x) => {
        if (c.avoid && !isHuman(c.avoid) && runtimeOf(c.avoid) === runtimeOf(x)) return false;
        return takesGroupWork(x, roleLimits(this.config, roleOf(x)));
      });
      c.agents.sort((x, y) => order(x).indexOf(runtimeOf(x)) - order(y).indexOf(runtimeOf(y)));
    }
    return [...byTask.values()];
  }

  /**
   * Plans what wake starts, without starting anything: candidates bottleneck first, re-sorted
   * after each planned run, which counts against the limits like a live one. `wake` carries the
   * plan out and `waits` reports it, so both always agree.
   */
  private planWake(): {
    steps: PlanStep[];
    state: Record<string, WakeState>;
    reviewed: Record<string, string[]>;
    inboxItems: Map<string, InboxKey[]>;
  } {
    const state = this.store.readJson<Record<string, WakeState>>('wake.json', {});
    const reviewed = this.store.readJson<Record<string, string[]>>('reviews.json', {});
    const inboxItems = new Map<string, InboxKey[]>();
    const agents = this.wakingAgents();
    if (agents.length === 0) return { steps: [], state, reviewed, inboxItems };
    const planWs = this.ws();
    const views = planWs.list();
    const live: PlannedRun[] = [...this.liveRecords()];
    const pending = this.wakeCandidates(agents, reviewed, state, inboxItems);
    const steps: PlanStep[] = [];
    this.changesMemo = new Map();
    try {
      this.planSteps(pending, live, views, planWs, steps);
    } finally {
      this.changesMemo = null;
    }
    return { steps, state, reviewed, inboxItems };
  }

  /** Plans each pending candidate in turn into `steps`; see `planWake`. */
  private planSteps(
    pending: WakeCandidate[],
    live: PlannedRun[],
    views: TaskView[],
    planWs: Workspace,
    steps: PlanStep[],
  ): void {
    while (pending.length > 0) {
      this.sortCandidates(pending, live);
      const c = pending.shift()!;
      if (c.kind === 'inbox') {
        // One run reads an agent's inbox; a live or planned run of the agent comes back to it.
        const agent = c.agents[0]!;
        if (live.some((r) => r.agent === agent)) {
          steps.push({ c, agent: null, reason: `a run of ${agent} is live or starting` });
          continue;
        }
      } else if (live.some((r) => r.root === c.root && r.task === c.id)) {
        continue;
      }
      const backlog = this.reviewBacklog(views, c.project);
      const held = backlog >= this.config.review_backlog;
      const reasons: string[] = [];
      let chosen: string | null = null;
      let chosenCwd: string | undefined;
      for (const agent of c.agents) {
        // An inbox run reads the agent's whole inbox, across projects, so it may already work on
        // this task; a second run beside it duplicates that work (AO-0128). This one starts
        // after it. A run with its own prompt, such as a schedule's, reads no inbox.
        if (live.some((r) => r.agent === agent && r.inbox)) {
          reasons.push(`${agent}: an inbox run of ${agent} is live or starting`);
          continue;
        }
        if (
          c.kind === 'task' &&
          !c.question &&
          held &&
          roleLimits(this.config, roleOf(agent)).writes
        ) {
          reasons.push(`${agent}: ${backlog} reviews wait in ${c.project}; new work there waits`);
          continue;
        }
        // A paused or proposed role still lists its reviews and inbox here, so `ops waits`
        // shows why they wait; it starts no run until a person sets it active.
        const role = planWs.agent(agent);
        const inactive = roleInactive(role);
        if (inactive) {
          reasons.push(`${agent}: ${inactive}`);
          continue;
        }
        // The queue lists a task owned by `*:<role>` whatever its type; a run must not start
        // on a type the role file does not allow. A task assigned to the agent by name stays
        // claimable whatever its type, as in core, so its run starts.
        if (
          c.kind === 'task' &&
          c.type !== undefined &&
          (!c.owner || isWildcard(c.owner)) &&
          !canClaimType(role, c.type, agent)
        ) {
          const types = role?.can_claim?.length ? role.can_claim : READ_ONLY_CAN_CLAIM;
          reasons.push(`${agent}: role takes only ${types.join(', ')}`);
          continue;
        }
        const cwd = this.checkoutOf(planWs, agent, c.root);
        const why = this.blocker(agent, c.project, {
          burst: c.kind === 'review' && held,
          question: c.question,
          live,
          cwd,
          task: c.kind === 'inbox' ? undefined : c.ref,
        });
        if (!why) {
          chosen = agent;
          chosenCwd = cwd;
          break;
        }
        reasons.push(`${agent}: ${why}`);
      }
      if (c.agents.length === 0) {
        reasons.push(
          'no waking agent may take it (role providers, overflow or the expected reviewer)',
        );
      }
      if (chosen) {
        live.push({
          agent: chosen,
          project: c.project,
          root: c.root,
          task: c.id,
          question: c.question,
          inbox: c.kind === 'inbox' || undefined,
          cwd: chosenCwd,
        });
        steps.push({ c, agent: chosen, reason: 'starts at the next tick' });
      } else {
        steps.push({ c, agent: null, reason: reasons.join('; ') });
      }
    }
  }

  /**
   * What waking agents could start, in wake order, with why each waits. Starts nothing. Then the
   * tasks that wait on an id no configured agent answers to, which no wake ever starts.
   */
  waits(): WaitItem[] {
    const ws = this.ws();
    const key = (v: TaskView): string => `${v.root}/${v.meta.id}`;
    // Ownerless work: opsd routes it at the next tick, or says why it cannot (AO-0140).
    const routes = new Map(this.plannedRoutes(ws).map((r) => [key(r.view), r]));
    const routeNote = (r: Route | undefined): string =>
      !r
        ? ''
        : r.blocker
          ? `; opsd cannot route it: ${r.blocker}`
          : `; opsd routes it to ${r.to} at the next tick`;
    const planned: WaitItem[] = this.planWake().steps.map(({ c, agent, reason }) => ({
      kind: c.kind,
      task: c.ref,
      title: c.title,
      project: c.project,
      review: c.kind === 'review',
      agents: c.agents,
      // An unowned task no agent may take says what routing does about it.
      reason: reason + (c.kind === 'task' && !agent && c.ref ? routeNote(routes.get(c.ref)) : ''),
    }));
    const stranded: WaitItem[] = ws.stranded().map((s) => ({
      kind: s.role === 'reviewer' ? 'review' : 'task',
      task: key(s.view),
      title: s.view.meta.title,
      project: s.view.meta.project ?? s.view.root,
      review: s.role === 'reviewer',
      agents: [],
      reason: s.reason + (s.role === 'owner' ? routeNote(routes.get(key(s.view))) : ''),
    }));
    const listed = new Set([...planned, ...stranded].map((w) => w.task));
    const unrouted: WaitItem[] = [...routes.values()]
      .filter((r) => r.blocker && !listed.has(key(r.view)))
      .map((r) => ({
        kind: 'task',
        task: key(r.view),
        title: r.view.meta.title,
        project: r.view.meta.project ?? r.view.root,
        review: false,
        agents: [],
        reason: `${r.why}${routeNote(r)}`,
      }));
    return [...planned, ...stranded, ...unrouted];
  }

  /** Starts the runs `planWake` plans, recording reviews and inbox items only once started. */
  private wake(): void {
    const { steps, state, reviewed, inboxItems } = this.planWake();
    let reviewsChanged = false;
    let stateChanged = false;
    /** Inbox keys each agent's started runs read: all for an inbox run, a task's own for others. */
    const read = new Map<string, Set<string>>();
    const inboxRun = new Set<string>();
    for (const { c, agent } of steps) {
      if (!agent) continue;
      let ok = false;
      this.safe(() => {
        if (c.kind === 'inbox') this.launch({ agent });
        else this.launch({ agent, task: c.ref, review: c.kind === 'review' });
        ok = true;
      });
      if (!ok) continue;
      const seen = read.get(agent) ?? new Set<string>();
      for (const item of inboxItems.get(agent) ?? []) {
        // An inbox run reads every item; a task or review run reads its task's history only.
        if (c.kind === 'inbox' || (item.root === c.root && item.id === c.id)) seen.add(item.key);
      }
      read.set(agent, seen);
      if (c.kind === 'inbox') inboxRun.add(agent);
      if (c.kind === 'review' && c.key) {
        (reviewed[agent] ??= []).push(c.key);
        reviewed[agent] = reviewed[agent]!.slice(-500);
        reviewsChanged = true;
      }
    }
    // Items count as seen only once a run read them, so a message on another task still wakes
    // an inbox run later; a failed launch uses none up.
    for (const [agent, seen] of read) {
      if (seen.size === 0 && !inboxRun.has(agent)) continue;
      const prev = state[agent] ?? { keys: [], at: 0 };
      const current = (inboxItems.get(agent) ?? []).map((i) => i.key);
      state[agent] = {
        keys: current.filter((k) => prev.keys.includes(k) || seen.has(k)),
        at: inboxRun.has(agent) ? this.now() : prev.at,
      };
      stateChanged = true;
    }
    if (reviewsChanged) this.store.writeJson('reviews.json', reviewed);
    if (stateChanged) this.store.writeJson('wake.json', state);
  }

  private safe(fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      this.emit('warn', err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Stops a process this opsd just started. Windows: closes the launcher's channel, so it exits
 * without starting the command, and ends the hidden `cmd.exe` through Node's own handle.
 * Unix: its process group, which an unreaped child keeps.
 */
function killOwnChild(spawned: Spawned): void {
  if (spawned.launch) {
    spawned.launch.abort();
    spawned.child.kill('SIGKILL');
  } else killTree(spawned.pid);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function scheduleDue(
  s: { every?: string; at?: string },
  last: number | undefined,
  now: number,
): boolean {
  if (s.every) return last === undefined || now - last >= parseDuration(s.every) * 60_000;
  if (!s.at) return false;
  const [h, m] = s.at.split(':').map(Number);
  const today = new Date(now);
  today.setHours(h!, m!, 0, 0);
  return now >= today.getTime() && (last === undefined || last < today.getTime());
}

/**
 * Whether the record's PID still runs the process opsd started. True: alive, with the recorded
 * creation time. False: gone, another creation time, or none on record. `unknown`: alive, but its
 * creation time cannot be read now (Windows asks PowerShell, which a loaded machine can hold past
 * its timeout); `adopt` then reads it again in the background. Kills check the creation time at
 * the moment of the kill either way.
 */
function sameProcess(r: RunRecord): boolean | 'unknown' {
  if (!isAlive(r.pid) || !r.proc_start) return false;
  const now = processStartSync(r.pid);
  if (now === null) return isAlive(r.pid) ? 'unknown' : false;
  return now === r.proc_start;
}

function gitTop(dir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dirname(dir) === dir ? dir : dir,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replace(/\//g, process.platform === 'win32' ? '\\' : '/');
  } catch {
    return null;
  }
}

/** The run-end note on what opsd committed for the run. */
function leftoverNote(l: Leftovers): string {
  const n = l.files.length;
  let note = `left ${n} changed file(s); opsd committed them as ${l.commit.slice(0, 7)} on branch ${l.branch}`;
  if (l.kept.length > 0) {
    note += `. ${l.kept.length} file(s) changed again after the commit and stay in ${l.top}: ${l.kept.slice(0, 5).join(', ')}`;
  }
  return note;
}

/** The review request (or, when the run already asked for one, the comment) for what it left. */
function leftoverReview(r: RunRecord, l: Leftovers, asked: boolean): string {
  const how = asked
    ? `run ${r.id} (${r.agent}) asked for review with ${l.files.length} file(s) it could not commit`
    : `run ${r.id} (${r.agent}) ended without \`ops review\` and left ${l.files.length} changed file(s)`;
  const into = l.into ? ` Merge into ${l.into} after approval.` : '';
  return `${l.commit.slice(0, 7)} on branch ${l.branch}: ${how} in ${l.top}; opsd committed them from ${l.base.slice(0, 7)} and restored the checkout.${into}`;
}

/** A commit id in short form. */
function short(commit: string): string {
  return commit.slice(0, 7);
}

/** The first lines of an error message, for a task event. */
function firstLines(text: string, n = 3): string {
  return text.trim().split('\n').slice(0, n).join(' ').slice(0, 500);
}

/** The end of a command's output, for a task event; the whole of it goes to a log file. */
function lastLines(text: string, n = 40, max = 3_000): string {
  const tail = text.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-n).join('\n');
  return tail.length > max ? tail.slice(-max) : tail;
}

/** One folder, compared as the file system does: case-insensitively on Windows. */
function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'));
}
