import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { ActivityItem, ActivityOptions, ActivityPage } from './activity.js';
import { activityPage } from './activity.js';
import type {
  AgentDef,
  AgentFileProblem,
  AgentFiles,
  GroupProviders,
  RoleInput,
} from './agents.js';
import type { Attachment } from './attachments.js';
import { attachmentRefs, findAttachment, saveAttachment } from './attachments.js';
import {
  canClaimType,
  checkRole,
  DEFAULT_PROVIDERS,
  readAgentFiles,
  roleGroupFor,
  roleInactive,
  takesGroupWork,
  writeAgent,
} from './agents.js';
import type { ChannelInfo, ChannelMessage } from './channels.js';
import {
  assertChannel,
  createChannel as writeChannel,
  findMentions,
  listChannels,
  messagesSince,
  postMessage,
  readChannel,
} from './channels.js';
import type { UserConfig } from './config.js';
import { discoverRoots, readUserConfig } from './config.js';
import type { Decision, DecisionMeta } from './decisions.js';
import {
  createDecision,
  defaultQuorum,
  hasDecision,
  listDecisionIds,
  matchOption,
  mayVote,
  parseDecisionId,
  readDecision,
  writeBallot,
  writeOutcome,
} from './decisions.js';
import { derive, detailText, isClaimable, summaryLine } from './fold.js';
import {
  assertActor,
  assertOwner,
  isHuman,
  isOrchestrator,
  messageNotes,
  OpsError,
  ownerMatches,
  parseTaskId,
  roleOf,
  runtimeOf,
  isActorId,
  isWildcard,
} from './ids.js';
import type { KbHit, KbNote } from './kb.js';
import { readNotes, searchNotes, writeNote } from './kb.js';
import type { RootedPost, SearchHit, SearchResult } from './search.js';
import { parseQuery, runSearch, wantedKinds } from './search.js';
import { searchBudget, searchSources } from './search-index.js';
import type { Timeline, TimelineTask } from './timeline.js';
import { buildTimeline } from './timeline.js';
import type { OpsEvent, Priority, Status, TaskMeta, TaskView } from './model.js';
import { OPEN_STATUSES, PRIORITIES } from './model.js';
import type {
  Condition,
  FiredRepeat,
  RepeatDef,
  RepeatInput,
  RepeatMeta,
  RepeatRule,
  RepeatTask,
  RepeatView,
} from './repeats.js';
import {
  archivedRepeatTasks,
  assertRepeatName,
  closesTask,
  describeRule,
  hasRepeat,
  latestSlot,
  listRepeatNames,
  localStamp,
  nextSlot,
  normalizeStart,
  parseCondition,
  parseLocal,
  parseWeekdays,
  readRepeat,
  readRepeatCache,
  removeRepeat,
  validateRule,
  writeRepeat,
  writeRepeatCache,
} from './repeats.js';
import { Root } from './root.js';
import { secretKind } from './secrets.js';
import type { SyncResult } from './sync.js';
import { mirrorPartners, syncAll } from './mirror.js';
import { parseDuration, parseTokens, parseWhen } from './units.js';

export interface WorkspaceOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Acting id; defaults to `OPS_AGENT`, then the user config's `me`. */
  actor?: string;
  /** Root name for new tasks and bare task numbers; defaults to `OPS_ROOT`, then the first root. */
  root?: string;
  /** Skip ownership checks; the event records `forced: true`. */
  force?: boolean;
  now?: () => number;
  user?: UserConfig;
  /** The supervised run acting; defaults to `OPS_RUN`. Claims record it. */
  run?: string;
  /**
   * A helper run (`ops spawn`), which may comment on tasks but never change their state; defaults
   * to whether `OPS_PARENT_RUN` is set.
   */
  helper?: boolean;
}

export interface NewTaskInput {
  title: string;
  body?: string;
  type?: string;
  priority?: Priority;
  owner?: string;
  /** Default: the project of `parent`, if it has one. */
  project?: string;
  parent?: string;
  labels?: string[];
  blockedBy?: string[];
}

export interface DelegateInput {
  /** Time budget such as `2h` or `90m`. */
  budget?: string;
  /** Token budget such as `400k`. */
  tokens?: string;
  /** Due time: `18:00`, `+2h`, a date or an ISO timestamp. */
  due?: string;
  /** The reviewer the delegator expects; must come from another provider than the delegate. */
  review?: string;
  message?: string;
}

export interface ProposeInput {
  question: string;
  options: string[];
  voters?: string[];
  quorum?: number;
  /** `+2h`, `18:00`, a date or an ISO timestamp. */
  deadline?: string;
  task?: string;
  body?: string;
}

export interface ActResult {
  view: TaskView;
  events: OpsEvent[];
  /**
   * Things the caller should know, printed as `note:` lines: what the immediate sync reported
   * under `coordinated` sync, such as a failed push, and soft warnings about the message.
   */
  notes?: string[];
  /** Ids the write names that no configured agent answers to, such as an unmatched `*:role`. */
  warnings?: string[];
}

/** An open task that waits on an id no configured agent answers to, so no run picks it up. */
export interface StrandedTask {
  view: TaskView;
  /** What the id is to the task: the owner of `todo` work, the reviewer, or who an ask waits for. */
  role: 'owner' | 'reviewer' | 'addressee';
  who: string;
  /** Such as `owner claude:release is not a configured agent`. */
  reason: string;
}

/** Ownerless work and the role group opsd gives it (AO-0140); see `Workspace.routes`. */
export interface Route {
  view: TaskView;
  /** The role group, such as `*:engineer`. */
  to: string;
  /** Why it needs an owner, such as `AO-0140 has no owner`. */
  why: string;
  /** The assign event's text: `why` and where opsd routes it. */
  reason: string;
  /** Why opsd cannot route it yet, such as `no waking agent answers to *:qa`. */
  blocker?: string;
}

function withNotes(res: ActResult, notes: string[]): ActResult {
  return notes.length > 0 ? { ...res, notes: [...(res.notes ?? []), ...notes] } : res;
}

/** An event as a state change plans it, before the write stamps its id, actor and time. */
type PlannedEvent = Omit<OpsEvent, 'id' | 'actor' | 'at'>;

/** A `holder` that names no claim, so the event never counts as the standing claim's. */
const NO_CLAIM = 'none';

/**
 * Task types that are not work: `ops next`, opsd wake and `ops waits` skip them. A finding waits
 * for a person to triage it (accept, set aside as an idea, or park); agents woke on findings
 * before triage and sent their reviews to the person (AO-0095).
 */
const NOT_WORK_TYPES = new Set(['idea', 'finding']);

/**
 * A question (AO-0063): a person or agent asks one chosen agent something, with tasks and
 * projects referenced in the text. Only the addressed agent sees it in its queue; it answers
 * with `ops done ID "answer"`, and the answer goes to the asker's inbox. It differs from
 * `ops ask`, where an agent working a task asks a person and the task blocks until the answer.
 */
export const QUESTION_TYPE = 'question';
/** Events by a human or the orchestrator that approve a task an agent created (AO-0107). */
const APPROVING_EVENTS = new Set(['retype', 'assign', 'delegate', 'reopen']);

function privileged(actor: string | undefined): boolean {
  return actor !== undefined && (isHuman(actor) || isOrchestrator(actor));
}

/** Events that a `coordinated` root pushes at once; others wait for the batched sync. */
const IMMEDIATE_SYNC = new Set(['claim', 'handoff', 'delegate', 'verdict', 'ask']);

export interface InboxItem {
  kind:
    'message' | 'ask' | 'review' | 'owned' | 'mention' | 'vote' | 'decide' | 'stranded' | 'triage';
  /**
   * A task id, a channel as `#name`, or a decision id. Task and decision ids are written
   * `root/id` when more than one root is visible, so the ref is unique and resolvable.
   */
  task: string;
  /** The root the item comes from. */
  root: string;
  title: string;
  event?: string;
  from?: string;
  type?: string;
  summary: string;
  /** When the event behind the item was written: the review request, for a review. */
  at?: string;
  /**
   * The full text (cut to 4000 characters) when it says more than `summary`, its first line: a
   * review request, message, question or channel mention. The inbox renders it as Markdown.
   */
  detail?: string;
  /** review: the pull request, commit and branch the request names. */
  pr?: string;
  commit?: string;
  branch?: string;
  /** triage: the finding's owner and priority, for the triage actions. */
  owner?: string;
  priority?: string;
  /** triage: an open question to the person, answered together with Accept. */
  question?: { event: string; from: string; summary: string; detail?: string };
}

/** The pull request, commit and branch a review request names, for a link in the inbox. */
export function reviewRefs(text: string): { pr?: string; commit?: string; branch?: string } {
  const pr = /https?:\/\/[^\s)>\]]+\/(?:pull|merge_requests)\/\d+/.exec(text)?.[0];
  // A commit is 7 to 40 hex characters with a digit and a letter, so neither words such as
  // "defaced" nor plain numbers count.
  const commit = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/.exec(text)?.[0];
  // A branch name after "branch" with a slash or hyphen, so prose such as "the branch is" doesn't.
  const branch = /\bbranch\s+`?([\w.]*[/-][\w./-]*[\w-])`?/i.exec(text)?.[1];
  return {
    ...(pr ? { pr } : {}),
    ...(commit ? { commit } : {}),
    ...(branch ? { branch } : {}),
  };
}

/** The open question a blocked task waits on, if the ask or block addressed someone. */
export function openQuestion(
  v: TaskView,
): { event: string; from: string; to: string; summary: string; detail?: string } | undefined {
  if (v.status !== 'blocked' || v.blockedOn.length > 0 || !v.waitEvent) return undefined;
  const a = v.addressed.find((x) => x.event === v.waitEvent);
  if (!a) return undefined;
  const { event, actor: from, to, summary, detail } = a;
  return { event, from, to, summary, ...(detail !== undefined ? { detail } : {}) };
}

/** A finding a person has not yet accepted, set aside or parked. */
function untriaged(v: TaskView): boolean {
  return v.meta.type === 'finding' && OPEN_STATUSES.has(v.status);
}

export interface ListFilter {
  status?: Status[];
  owner?: string;
  project?: string;
  type?: string;
  /** Include done and parked tasks. */
  all?: boolean;
}

const PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

function byQueueOrder(a: TaskView, b: TaskView): number {
  const p = (PRIORITY_RANK[a.meta.priority] ?? 2) - (PRIORITY_RANK[b.meta.priority] ?? 2);
  if (p !== 0) return p;
  return a.meta.created_at < b.meta.created_at ? -1 : a.meta.created_at > b.meta.created_at ? 1 : 0;
}

function assertNoSecret(...texts: (string | undefined)[]): void {
  for (const t of texts) {
    if (!t) continue;
    const kind = secretKind(t);
    if (kind) {
      throw new OpsError(
        `refusing to write: the text looks like a ${kind}. Nothing was written.`,
        2,
      );
    }
  }
}

/** All data roots the current process can see, plus the acting id. The API behind `ops`. */
export class Workspace {
  readonly roots: Root[];
  readonly user: UserConfig;
  readonly actor: string | null;
  readonly force: boolean;
  /** The supervised run this workspace acts for, if any. */
  readonly run: string | null;
  /** A helper run: task-state writes are refused. */
  readonly helper: boolean;
  private readonly now: () => number;
  private readonly rootName?: string;
  private agentCache?: AgentFiles;

  constructor(opts: WorkspaceOptions = {}) {
    const env = opts.env ?? process.env;
    this.user = opts.user ?? readUserConfig(env);
    this.roots = discoverRoots(opts.cwd ?? process.cwd(), env, this.user).map((d) => new Root(d));
    const actor = opts.actor ?? env.OPS_AGENT ?? this.user.me ?? null;
    this.actor = actor ? assertActor(actor) : null;
    this.force = opts.force ?? false;
    this.run = opts.run ?? env.OPS_RUN ?? null;
    this.helper = opts.helper ?? Boolean(env.OPS_PARENT_RUN);
    this.now = opts.now ?? Date.now;
    this.rootName = opts.root ?? env.OPS_ROOT;
  }

  requireActor(): string {
    if (!this.actor) {
      throw new OpsError(
        'no acting id: set OPS_AGENT (claude:engineer) or `me` in the user config',
        2,
      );
    }
    return this.actor;
  }

  defaultRoot(): Root {
    if (this.roots.length === 0) {
      throw new OpsError('no data root found: run `ops init` or set OPS_ROOTS', 2);
    }
    if (!this.rootName) return this.roots[0]!;
    const r = this.roots.find((x) => x.name === this.rootName);
    if (!r) throw new OpsError(`no root named '${this.rootName}'`, 2);
    return r;
  }

  /** Roots selected for commands that enumerate work; explicit task references stay unscoped. */
  private scopedRoots(): Root[] {
    return this.rootName ? [this.defaultRoot()] : this.roots;
  }

  /** Finds the root and canonical id for `T-0012`, `t-12`, `12` or `name/T-0012`. */
  resolve(ref: string): { root: Root; id: string } {
    let rootPart: string | undefined;
    let idPart = ref.trim();
    const slash = idPart.indexOf('/');
    if (slash > 0) {
      rootPart = idPart.slice(0, slash);
      idPart = idPart.slice(slash + 1);
    }
    let candidates = rootPart ? this.roots.filter((r) => r.name === rootPart) : this.roots;
    if (rootPart && candidates.length === 0) throw new OpsError(`no root named '${rootPart}'`, 2);
    let parsed = parseTaskId(idPart);
    if (!parsed && /^\d+$/.test(idPart)) {
      const r = rootPart ? candidates[0]! : this.defaultRoot();
      parsed = { prefix: r.prefix, n: Number(idPart) };
      candidates = [r];
    }
    if (!parsed) throw new OpsError(`bad task id '${ref}'`, 2);
    const id = `${parsed.prefix}-${String(parsed.n).padStart(4, '0')}`;
    const matches = candidates.filter((r) => r.prefix === parsed.prefix && r.hasTask(id));
    if (matches.length === 0) throw new OpsError(`no task ${id}`, 2);
    if (matches.length > 1) {
      throw new OpsError(`${id} exists in several roots; write <root>/${id}`, 2);
    }
    return { root: matches[0]!, id };
  }

  /**
   * The form a task in `from` stores a dependency in: the bare id in the same root, `root/id` in
   * another, so equal ids in two roots stay apart.
   */
  private depRef(from: Root, ref: string): string {
    const dep = this.resolve(ref);
    return dep.root === from ? dep.id : `${dep.root.name}/${dep.id}`;
  }

  /** The task a dependency stored on a task in `from` points at, if it still exists. */
  private depTarget(from: Root, ref: string): { root: Root; id: string } | undefined {
    const slash = ref.indexOf('/');
    if (slash > 0) {
      const root = this.roots.find((r) => r.name === ref.slice(0, slash));
      const id = ref.slice(slash + 1);
      return root?.hasTask(id) ? { root, id } : undefined;
    }
    if (from.hasTask(ref)) return { root: from, id: ref };
    // Stores written before root-qualified refs hold a bare id for a task in another root.
    const others = this.roots.filter((r) => r !== from && r.hasTask(ref));
    return others.length === 1 ? { root: others[0]!, id: ref } : undefined;
  }

  private agentFiles(): AgentFiles {
    if (!this.agentCache) {
      const each = this.roots.map((r) => readAgentFiles(r.dir));
      this.agentCache = {
        agents: each.flatMap((f) => f.agents),
        problems: each.flatMap((f) => f.problems),
      };
    }
    return this.agentCache;
  }

  /** Role files from every root; ones that do not parse are left out (see `agentProblems`). */
  agents(): AgentDef[] {
    return this.agentFiles().agents;
  }

  /** Role files `agents()` skipped because they do not parse, with the reason. */
  agentProblems(): AgentFileProblem[] {
    return this.agentFiles().problems;
  }

  /**
   * Creates (`create`) or updates the role file of `input.id` in the root named `opts.root`, or
   * in the root that holds it, or the default root. Secrets are refused like everywhere else.
   */
  saveRole(input: RoleInput, opts: { root?: string; create?: boolean } = {}): AgentDef {
    this.requireActor();
    // Types and sizes first, so the secret scan below only sees checked text.
    const role = checkRole(input);
    const s = role.set;
    assertNoSecret(
      s.name as string | undefined,
      s.description as string | undefined,
      role.instructions,
      s.style as string | undefined,
      ...((s.files as string[] | undefined) ?? []),
    );
    const existing = this.agents().filter((a) => a.id === role.id);
    const rootOf = (file: string): Root | undefined =>
      this.roots.find((r) => join(r.dir, 'agents') === dirname(file));
    if (opts.create && existing.length > 0) {
      const name = rootOf(existing[0]!.file)?.name;
      throw new OpsError(`${role.id} already has a role file${name ? ` in ${name}` : ''}`, 2);
    }
    let root: Root;
    if (opts.root) {
      const r = this.roots.find((x) => x.name === opts.root);
      if (!r) throw new OpsError(`no root named '${opts.root}'`, 2);
      const elsewhere = existing.find((a) => rootOf(a.file) !== r);
      const here = existing.some((a) => rootOf(a.file) === r);
      if (!here && elsewhere) {
        const name = rootOf(elsewhere.file)?.name;
        throw new OpsError(
          `${role.id} has a role file${name ? ` in ${name}` : ''}; edit it there`,
          2,
        );
      }
      root = r;
    } else {
      root = (existing[0] && rootOf(existing[0].file)) ?? this.defaultRoot();
    }
    const def = writeAgent(root, role, { create: opts.create });
    this.agentCache = undefined;
    return def;
  }

  agent(id: string): AgentDef | undefined {
    return this.agents().find((a) => a.id === id);
  }

  /**
   * Agent ids a run can start as: role files (`agents/*.md`) in any root, and the agents in the
   * user config's opsd section (`opsd.agents`). Empty when neither defines one; then no id is
   * checked, so a store without agent definitions keeps working.
   */
  knownAgents(): string[] {
    const opsd = (this.user as { opsd?: { agents?: unknown } }).opsd;
    const configured =
      opsd?.agents && typeof opsd.agents === 'object' ? Object.keys(opsd.agents) : [];
    const ids = [...this.agents().map((a) => a.id), ...configured.filter(isActorId)];
    return [...new Set(ids)].filter((id) => !isHuman(id)).sort();
  }

  /**
   * Why `id` reaches no agent, or null when it does: a human, a defined agent, or a wildcard that
   * matches one. Null for every id when no agent is defined (see `knownAgents`).
   */
  unreachable(id: string): string | null {
    if (isHuman(id)) return null;
    const known = this.knownAgents();
    if (known.length === 0 || known.includes(id)) return null;
    if (isWildcard(id)) {
      return known.some((a) => ownerMatches(id, a)) ? null : `${id} matches no configured agent`;
    }
    return `${id} is not a configured agent`;
  }

  /**
   * Agents opsd starts runs for on its own: `opsd.agents.<id>.wake: true` in the user config,
   * without a paused or proposed role file.
   */
  wakingAgents(): string[] {
    const opsd = (this.user as { opsd?: { agents?: unknown } }).opsd;
    const agents = opsd?.agents && typeof opsd.agents === 'object' ? opsd.agents : {};
    return Object.entries(agents as Record<string, { wake?: unknown } | null>)
      .filter(([id, c]) => isActorId(id) && !isHuman(id) && c?.wake === true)
      .filter(([id]) => !roleInactive(this.agent(id)))
      .map(([id]) => id)
      .sort();
  }

  /**
   * Why `ops new` and `ops assign` refuse `id` as an owner, or null (AO-0140): it must be a person,
   * a configured agent, or a group (`*:engineer`, `claude:*`) that a waking agent answers to, so
   * the work wakes a run. When no agent wakes, a group needs a configured agent instead, since
   * agents then run by hand. Null for every id when no agent is defined (see `knownAgents`).
   */
  ownerRefusal(id: string): string | null {
    if (isHuman(id) || !isWildcard(id)) return this.unreachable(id);
    if (this.knownAgents().length === 0) return null;
    const waking = this.wakingAgents();
    if (waking.length === 0) {
      return this.knownAgents().some((a) => ownerMatches(id, a))
        ? null
        : `${id} matches no configured agent`;
    }
    const matching = waking.filter((a) => ownerMatches(id, a));
    if (matching.length === 0) return `${id} matches no waking agent`;
    // opsd starts `*:<role>` work only on the role's providers (`opsd.roles.<role>.providers`,
    // `overflow`); a provider group (`claude:*`) is not limited by them.
    if (!id.startsWith('*:') || matching.some((a) => takesGroupWork(a, this.groupProviders(a)))) {
      return null;
    }
    const role = roleOf(id);
    return `${id} matches no waking agent of the role's providers (opsd.roles.${role}.providers, overflow)`;
  }

  /**
   * Which providers take `*:<role>` work for the role of `agent`, from the user config's
   * `opsd.roles.<role>`: `providers` (default: every runtime opsd knows) and `overflow` (default
   * true). opsd passes the same from its parsed config (`roleLimits`).
   */
  groupProviders(agent: string): GroupProviders {
    const opsd = (this.user as { opsd?: { roles?: unknown; runtimes?: unknown; seeded?: unknown } })
      .opsd;
    const roles = opsd?.roles && typeof opsd.roles === 'object' ? opsd.roles : {};
    const r = (roles as Record<string, { providers?: unknown; overflow?: unknown } | null>)[
      roleOf(agent)
    ];
    const listed =
      Array.isArray(r?.providers) && r.providers.every((p) => typeof p === 'string')
        ? (r.providers as string[])
        : undefined;
    const configured =
      opsd?.runtimes && typeof opsd.runtimes === 'object' ? Object.keys(opsd.runtimes) : [];
    // Before seeding, opsd fills in the default providers, as its `mergeRuntimes` does.
    const runtimes =
      opsd?.seeded !== undefined ? configured : [...new Set([...DEFAULT_PROVIDERS, ...configured])];
    return {
      providers: listed ?? runtimes,
      overflow: typeof r?.overflow === 'boolean' ? r.overflow : true,
    };
  }

  /**
   * Owners that take work, for a refusal: role groups `ownerRefusal` accepts, configured agents,
   * then the person. When agents wake, a group needs a waking agent that is one of the role's
   * providers; only when no agent wakes do configured agents stand in, as in `ownerRefusal`.
   */
  ownerSuggestions(root: Root = this.defaultRoot()): string {
    const waking = this.wakingAgents();
    const takers =
      waking.length > 0
        ? waking.filter((a) => takesGroupWork(a, this.groupProviders(a)))
        : this.knownAgents();
    const groups = [...new Set(takers.map(roleOf))].sort().map((r) => `*:${r}`);
    const human = root.config.human;
    const parts = [
      groups.length > 0 ? `a role group (${groups.join(', ')})` : '',
      `a configured agent (${this.knownAgents().join(', ')})`,
      human ? human : '',
    ].filter(Boolean);
    return `use ${parts.join(', or ')}`;
  }

  /**
   * Work no agent owns (AO-0140): `todo` or `blocked` tasks, or claims whose lease ran out, not
   * findings or ideas, whose
   * owner is empty or reaches no configured agent. Each names the role group `roleGroupFor` its
   * type and labels picks, and whether opsd may route it there: a waking agent answers to that
   * group, is one of the role's providers (`takesGroupWork`), is not the provider of the reviewer
   * a delegation expects, may claim the task's type, and for a question the group is not the
   * asker's. These are the checks opsd's wake planner makes, so a
   * routed task has an agent that starts it. opsd passes the agents its config wakes and its
   * parsed role limits.
   */
  routes(
    waking = this.wakingAgents(),
    limits: (agent: string) => GroupProviders = (a) => this.groupProviders(a),
  ): Route[] {
    const out: Route[] = [];
    for (const v of this.views()) {
      const why = this.routeReason(v);
      if (!why) continue;
      const to = roleGroupFor(v.meta.type, v.meta.labels ?? []);
      const role = roleOf(to);
      const answering = waking.filter((a) => ownerMatches(to, a));
      const providers = answering.filter((a) => takesGroupWork(a, limits(a)));
      // A routing `assign` keeps the delegation, and opsd never wakes the provider of the
      // reviewer the task expects.
      const avoid = v.delegation?.review;
      const eligible =
        avoid && !isHuman(avoid)
          ? providers.filter((a) => runtimeOf(a) !== runtimeOf(avoid))
          : providers;
      let blocker: string | undefined;
      if (answering.length === 0) blocker = `no waking agent answers to ${to}`;
      else if (providers.length === 0) {
        blocker = `no waking agent of ${to} is one of its providers (opsd.roles.${role}.providers, overflow)`;
      } else if (eligible.length === 0) {
        blocker = `every waking provider of ${to} is the provider of the expected reviewer ${avoid}`;
      } else if (!eligible.some((a) => canClaimType(this.agent(a), v.meta.type, a))) {
        blocker = `no waking agent of ${to} may claim ${v.meta.type} work (can_claim)`;
      } else if (v.meta.type === QUESTION_TYPE && ownerMatches(to, v.meta.created_by)) {
        blocker = `${to} includes the asker ${v.meta.created_by}`;
      }
      out.push({
        view: v,
        to,
        why,
        reason: `${why}; opsd routes ${v.meta.type} work to ${to}`,
        ...(blocker && { blocker }),
      });
    }
    return out;
  }

  /** Why `v` needs an owner from opsd, or null; see `routes`. */
  private routeReason(v: TaskView): string | null {
    // A claim whose lease ran out holds nothing: its agent may be gone, so the task routes too.
    const staleClaim = (v.status === 'claimed' || v.status === 'in-progress') && v.stale;
    if (v.status !== 'todo' && v.status !== 'blocked' && !staleClaim) return null;
    if (NOT_WORK_TYPES.has(v.meta.type)) return null;
    if (!v.owner) return `${v.meta.id} has no owner`;
    if (isHuman(v.owner)) return null;
    const why = this.unreachable(v.owner);
    return why ? `owner ${why}` : null;
  }

  /**
   * Gives an ownerless task the role group `to` as its owner, as an `assign` event with the reason
   * (AO-0140). For opsd only. Checked again under the task lock, so an owner set meanwhile stays.
   */
  route(ref: string, to: string, reason: string): ActResult {
    assertOwner(to);
    if (!this.actor || runtimeOf(this.actor) !== 'opsd') {
      throw new OpsError('only opsd routes tasks to a role group', 1);
    }
    return this.act(ref, (v) => {
      if (!this.routeReason(v)) {
        throw new OpsError(`${v.meta.id} needs no route: it is ${v.status}, owner ${v.owner}`);
      }
      const keepWait = v.status === 'blocked';
      return [{ type: 'assign', to, body: reason, ...(keepWait && { keep_wait: true }) }];
    });
  }

  /** One warning per id that reaches no agent; for mentions and addressees, which are not refused. */
  reachWarnings(ids: Array<string | null | undefined>): string[] {
    const out: string[] = [];
    for (const id of new Set(ids)) {
      const why = id ? this.unreachable(id) : null;
      if (why) out.push(`${why}: no run reads it`);
    }
    return out;
  }

  /**
   * Checks an id a write hands work to. An agent id nothing defines is refused (exit 1, with the
   * defined agents), since no run would ever pick the work up; `--force` passes it. A wildcard
   * that matches no agent, and any id when `refuse` is false, only adds a warning.
   */
  private checkTarget(ctx: ActCtx, id: string | null | undefined, what: string, refuse = true) {
    if (!id) return;
    const why = this.unreachable(id);
    if (!why) return;
    if (refuse && !isWildcard(id)) {
      ctx.needForce(`${what} ${why}; configured agents: ${this.knownAgents().join(', ')}`);
    }
    ctx.warnings.push(`${what} ${why}: no run picks it up`);
  }

  /**
   * Open tasks that wait on an id no configured agent answers to: a review requested from one, an
   * ask addressed to one, or work no live claim holds whose owner is one, including work still
   * blocked on other tasks, which nobody picks up once they close. Nothing wakes for them.
   */
  stranded(): StrandedTask[] {
    if (this.knownAgents().length === 0) return [];
    const out: StrandedTask[] = [];
    const add = (view: TaskView, role: StrandedTask['role'], who: string | null): boolean => {
      const why = who ? this.unreachable(who) : null;
      if (who && why) out.push({ view, role, who, reason: `${role} ${why}` });
      return Boolean(why);
    };
    for (const v of this.views()) {
      if (!OPEN_STATUSES.has(v.status)) continue;
      if (v.status === 'needs-review') {
        add(v, 'reviewer', v.reviewer);
        continue;
      }
      if (v.status === 'blocked' && v.blockedOn.length === 0 && add(v, 'addressee', v.waitingOn)) {
        continue;
      }
      const held = (v.status === 'claimed' || v.status === 'in-progress') && !v.stale;
      if (!held) add(v, 'owner', v.owner);
    }
    return out;
  }

  /**
   * Warnings for work sent to roles that cannot take it: an id whose role file is paused or
   * proposed, or a group (`*:writer`, `claude:*`) whose matching role files are all inactive.
   * Ids with no role file and humans get none.
   */
  inactiveNotes(...ids: Array<string | null | undefined>): string[] {
    const notes: string[] = [];
    for (const id of new Set(ids)) {
      if (!id || isHuman(id)) continue;
      if (id.startsWith('*:') || id.endsWith(':*')) {
        const matched = this.agents().filter((a) => ownerMatches(id, a.id));
        if (matched.length > 0 && matched.every((a) => a.status !== 'active')) {
          const list = matched.map((a) => `${a.id} ${a.status}`).join(', ');
          notes.push(`no active role matches ${id} (${list}); opsd starts no run for it`);
        }
        continue;
      }
      const why = roleInactive(this.agent(id));
      if (why) notes.push(`${why}; opsd starts no run for it until then`);
    }
    return notes;
  }

  /** `res` with the inactive-role warnings for `ids` added to its notes. */
  private noteInactive(res: ActResult, ...ids: Array<string | null | undefined>): ActResult {
    const notes = [...this.inactiveNotes(...ids), ...(res.notes ?? [])];
    return notes.length > 0 ? { ...res, notes } : res;
  }

  /** Tasks in every root, or the selected root, with cross-root dependencies applied. */
  views(opts: { archived?: boolean } = {}): TaskView[] {
    const roots = new Set(this.scopedRoots().map((r) => r.name));
    return this.allViews(opts).filter((v) => roots.has(v.root));
  }

  /** Every task in every root, for callers such as activity and inbox that are not root-scoped. */
  private allViews(opts: { archived?: boolean } = {}): TaskView[] {
    const all = this.roots.flatMap((r) => r.states().map((s) => ({ root: r, s, archived: false })));
    if (opts.archived) {
      for (const r of this.roots) {
        for (const s of r.archivedStates()) all.push({ root: r, s, archived: true });
      }
    }
    // Keyed by root name and id: two roots can both hold T-0001.
    const status = new Map(all.map(({ root, s }) => [`${root.name}/${s.meta.id}`, s.status]));
    const nowMs = this.now();
    return all.map(({ root, s, archived }) => {
      const statusOf = (ref: string): Status | undefined => {
        const dep = this.depTarget(root, ref);
        if (!dep) return undefined;
        return status.get(`${dep.root.name}/${dep.id}`) ?? dep.root.foldTask(dep.id).status;
      };
      const v = derive(s, root.name, nowMs, statusOf);
      if (archived) v.archived = true;
      return v;
    });
  }

  /** One task with a fresh fold (no cache). */
  view(ref: string): TaskView {
    const { root, id } = this.resolve(ref);
    return this.freshView(root, id);
  }

  /** The project a task names, or undefined without a task or a project. */
  private projectOfTask(ref: string | undefined): string | undefined {
    if (!ref) return undefined;
    const { root, id } = this.resolve(ref);
    return root.namedProject(id);
  }

  private freshView(root: Root, id: string): TaskView {
    const state = root.foldTask(id);
    const deps = state.blockedOn;
    const statusOf = (ref: string): Status | undefined => {
      const dep = this.depTarget(root, ref);
      return dep && dep.root.foldTask(dep.id).status;
    };
    const known = new Map(deps.map((d) => [d, statusOf(d)] as const));
    const v = derive(state, root.name, this.now(), (d) => known.get(d));
    if (root.isArchived(id)) v.archived = true;
    return v;
  }

  showEvents(ref: string): { meta: TaskMeta; body: string; events: OpsEvent[] } {
    const { root, id } = this.resolve(ref);
    const { meta, body } = root.readTask(id);
    return { meta, body, events: root.readEvents(id) };
  }

  list(filter: ListFilter = {}): TaskView[] {
    return this.views({ archived: filter.all })
      .filter((v) => filter.all || filter.status || OPEN_STATUSES.has(v.status))
      .filter((v) => !filter.status || filter.status.includes(v.status))
      .filter(
        (v) => !filter.owner || ownerMatches(v.owner, filter.owner) || v.owner === filter.owner,
      )
      .filter((v) => !filter.project || v.meta.project === this.projectIn(v.root, filter.project))
      .filter((v) => !filter.type || v.meta.type === filter.type)
      .sort(byQueueOrder);
  }

  /** `name` as a task in root `rootName` reads it, old names mapped, so a filter finds both. */
  private projectIn(rootName: string, name: string): string {
    return this.roots.find((r) => r.name === rootName)?.projectName(name) ?? name;
  }

  /** Tasks the actor may claim now, best first: priority, then age. */
  queue(actor = this.requireActor()): TaskView[] {
    const agent = this.agent(actor);
    if (agent && agent.status !== 'active') return [];
    return (
      this.views()
        .filter(isClaimable)
        // Ideas and findings are not work until someone changes the type. An idea can still be
        // claimed by id; a finding needs --force to claim or start (requireTriaged).
        .filter((v) => !NOT_WORK_TYPES.has(v.meta.type))
        // A question waits for the agent it names, never the asker. Writes refuse both cases;
        // this guards questions filed before that check or merged in by sync.
        .filter(
          (v) => v.meta.type !== QUESTION_TYPE || (v.owner !== null && v.meta.created_by !== actor),
        )
        .filter((v) =>
          v.owner
            ? ownerMatches(v.owner, actor)
            : canClaimType(agent, v.meta.type, actor) && !isHuman(actor),
        )
        .sort(byQueueOrder)
    );
  }

  next(actor?: string): TaskView | undefined {
    return this.queue(actor)[0];
  }

  newTask(input: NewTaskInput, root: Root = this.defaultRoot()): TaskMeta {
    const actor = this.requireActor();
    const title = input.title.trim();
    if (!title) throw new OpsError('a task needs a title', 2);
    assertNoSecret(title, input.body);
    if (input.owner) assertOwner(input.owner);
    if (input.type === QUESTION_TYPE) assertQuestionTo(input.owner, actor, actor);
    const why = input.owner ? this.ownerRefusal(input.owner) : null;
    if (why && !this.force) {
      throw new OpsError(
        `owner ${why}, so no run picks it up; ${this.ownerSuggestions(root)} (use --force to override)`,
      );
    }
    if (input.priority && !PRIORITIES.includes(input.priority)) {
      throw new OpsError(`bad priority '${input.priority}': use p0, p1, p2 or p3`, 2);
    }
    const parent = input.parent ? this.resolve(input.parent).id : undefined;
    const blocked = input.blockedBy?.map((d) => this.depRef(root, d));
    // A subtask belongs to its parent's project, so opsd counts both against one project. An old
    // project name is stored as the name it maps to.
    const given = input.project?.trim();
    const project = given ? root.projectName(given) : this.projectOfTask(input.parent);
    return root.createTask(
      {
        title,
        type: input.type ?? 'task',
        priority: input.priority ?? 'p2',
        owner: input.owner,
        project,
        parent,
        labels: input.labels && input.labels.length > 0 ? input.labels : undefined,
        blocked_by: blocked && blocked.length > 0 ? blocked : undefined,
        created_by: actor,
        created_at: new Date(this.now()).toISOString(),
      },
      input.body ?? '',
      this.user.id_block ?? 0,
    );
  }

  /**
   * Creates a task the way `ops new` and the HTTP API do: new work needs the human's approval
   * (AO-0107). A human or the orchestrator creates tasks directly. An agent creates a task only as
   * a subtask of an approved open task (a breakdown inherits the approval); anything else becomes
   * a finding, a proposal that waits for triage like any other.
   */
  addTask(input: NewTaskInput): { meta: TaskMeta; proposed?: string } {
    const actor = this.requireActor();
    if (privileged(actor)) return { meta: this.newTask(input) };
    const type = input.type ?? 'task';
    // A question (AO-0063) asks another agent and creates no work, so it needs no approval.
    if (NOT_WORK_TYPES.has(type) || type === QUESTION_TYPE) return { meta: this.newTask(input) };
    const why = input.parent
      ? this.unapprovedReason(input.parent)
      : 'it has no --parent; new work needs the human to accept it';
    if (!why) return { meta: this.newTask(input) };
    const body = [
      input.body?.trim(),
      `Proposed by ${actor} as a ${type}${input.parent ? ` under ${input.parent}` : ''}.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return { meta: this.newTask({ ...input, type: 'finding', body }), proposed: why };
  }

  /**
   * Why a task does not carry the human's approval, or undefined when it does. A task is approved
   * when it is open, is work (not a finding or idea), and a human or the orchestrator created it,
   * accepted it (retype), assigned, delegated or reopened it, or it is a subtask of
   * an approved task.
   */
  private unapprovedReason(ref: string): string | undefined {
    const seen = new Set<string>();
    let cur: string | undefined = ref;
    let first = true;
    while (cur) {
      const { root, id } = this.resolve(cur);
      const key = `${root.name}/${id}`;
      if (seen.has(key)) break;
      seen.add(key);
      const v = this.freshView(root, id);
      if (first) {
        if (!OPEN_STATUSES.has(v.status)) return `parent ${id} is ${v.status}`;
        if (NOT_WORK_TYPES.has(v.meta.type)) {
          return `parent ${id} is a ${v.meta.type} that waits for triage`;
        }
        first = false;
      }
      const meta = root.readTask(id).meta;
      if (privileged(meta.created_by)) return undefined;
      const events = root.readEvents(id);
      if (events.some((e) => APPROVING_EVENTS.has(e.type) && privileged(e.actor))) return undefined;
      cur = meta.parent ? `${root.name}/${meta.parent}` : undefined;
    }
    return `parent ${ref} was not created or accepted by a human`;
  }

  // ---- State changes ---------------------------------------------------------------------------

  private act(
    ref: string,
    plan: (v: TaskView, ctx: ActCtx) => PlannedEvent[],
    opts: { helperOk?: boolean } = {},
  ): ActResult {
    const actor = this.requireActor();
    // A helper run reports through comments; the run that started it owns the task's state.
    if (this.helper && !opts.helperOk) {
      throw new OpsError(
        'a helper run cannot change task state: use ops comment, or report to the run that started you',
      );
    }
    const { root, id } = this.resolve(ref);
    const warnings: string[] = [];
    const res = root.lock(`task-${id}`, (): ActResult => {
      const v = this.freshView(root, id);
      const ctx = new ActCtx(
        warnings,
        actor,
        this.force,
        v,
        root.config.human,
        holds(root, v, actor, this.run),
      );
      const planned = plan(v, ctx);
      for (const e of planned) assertNoSecret(e.body);
      const written = planned.map((e) => {
        const nowMs = this.now();
        return root.appendEvent(
          id,
          { ...e, actor, at: new Date(nowMs).toISOString(), forced: ctx.forced || undefined },
          nowMs,
        );
      });
      for (const e of written) {
        if (e.type === 'claim' && e.token) root.rememberClaim(id, e.token, this.run ?? undefined);
      }
      return { view: this.freshView(root, id), events: written };
    });
    const out = this.confirm(root, id, res);
    return warnings.length > 0 ? { ...out, warnings } : out;
  }

  /**
   * Under `coordinated` sync, pushes claims, handoffs, verdicts and asks at once, so other machines
   * see them within seconds and a claim race is settled now. The claim pushed first wins; a loser
   * gets an error and its claim, start and release events change nothing. When the sync fails
   * (offline, say), the write stands locally and the next sync sends it.
   */
  private confirm(root: Root, id: string, res: ActResult): ActResult {
    if (root.config.sync.policy !== 'coordinated') return res;
    if (!res.events.some((e) => IMMEDIATE_SYNC.has(e.type))) return res;
    let sync: SyncResult;
    try {
      // A mirrored task syncs with its other copy too, so the claim settles in both places.
      const results = syncAll(mirrorPartners(root, this.roots, this.user), this.user, {
        pull: true,
        push: true,
        now: this.now(),
      });
      sync = {
        committed: 0,
        pulled: results.some((r) => r.result.pulled),
        pushed: results.some((r) => r.result.pushed),
        reordered: 0,
        lost: results.flatMap((r) => r.result.lost),
        notes: results.flatMap((r) => r.result.notes),
      };
    } catch (err) {
      const why = (err as Error).message.split('\n')[0];
      return { ...res, notes: [`not synced yet: ${why}; the next sync sends it`] };
    }
    const lost = sync.lost.find(
      (l) => l.root === root.name && l.task === id && l.actor === this.actor,
    );
    if (lost) {
      throw new OpsError(
        `lost the claim on ${id} to ${lost.winner ?? 'a claim pushed first'}; pick other work`,
      );
    }
    // Event ids in res.events can be stale when the sync renamed them; the view is current.
    const notes = sync.notes.length > 0 ? sync.notes : undefined;
    return { view: this.freshView(root, id), events: res.events, notes };
  }

  /** Whether the acting id holds the task's claim, made from this clone. */
  holdsClaim(ref: string): boolean {
    const actor = this.requireActor();
    const { root, id } = this.resolve(ref);
    return holds(root, this.freshView(root, id), actor, this.run);
  }

  /**
   * Binds this clone's claim on the task to this workspace's run, so only that run (and callers
   * without a run) may act on it. For the supervisor, when it launches a run on a claim it already
   * holds; it checks first that no live run owns the claim.
   */
  bindClaim(ref: string): void {
    const actor = this.requireActor();
    if (!this.run) throw new OpsError('bindClaim needs a run', 2);
    const run = this.run;
    const { root, id } = this.resolve(ref);
    root.lock(`task-${id}`, () => {
      const v = this.freshView(root, id);
      const rec = root.claimRecord(id);
      if (v.claimedBy !== actor || !v.claimToken || rec.token !== v.claimToken) {
        throw new OpsError(`${id} is not held by ${actor} in this clone`);
      }
      root.rememberClaim(id, v.claimToken, run);
    });
  }

  private lease(root: Root, kind: 'claim' | 'work'): string {
    const min =
      kind === 'claim' ? root.config.leases.claim_minutes : root.config.leases.work_minutes;
    return new Date(this.now() + min * 60_000).toISOString();
  }

  /**
   * A finding waits for a person to triage it (AO-0095): claiming or starting one needs --force,
   * including a start under a claim that already exists.
   */
  private requireTriaged(v: TaskView, ctx: ActCtx): void {
    if (v.meta.type === 'finding') {
      ctx.needForce(`${v.meta.id} is a finding that waits for triage; accept it as a task first`);
    }
  }

  private claimEvents(
    v: TaskView,
    ctx: ActCtx,
    root: Root,
  ): Array<Omit<OpsEvent, 'id' | 'actor' | 'at'>> {
    if (!isClaimable(v)) {
      const who = v.claimedBy ? ` by ${v.claimedBy}` : '';
      throw new OpsError(`${v.meta.id} is ${v.status}${who}; not claimable`);
    }
    const agent = this.agent(ctx.actor);
    const eligible = v.owner
      ? ownerMatches(v.owner, ctx.actor)
      : canClaimType(agent, v.meta.type, ctx.actor) && !isHuman(ctx.actor);
    if (!eligible) ctx.needPrivilege(`${v.meta.id} is owned by ${v.owner ?? 'nobody'}`);
    this.requireTriaged(v, ctx);
    const out: Array<Omit<OpsEvent, 'id' | 'actor' | 'at'>> = [];
    if (v.unblocked)
      out.push({ type: 'unblock', body: `Dependencies done: ${v.blockedOn.join(', ')}` });
    out.push({
      type: 'claim',
      token: randomBytes(6).toString('hex'),
      lease_until: this.lease(root, 'claim'),
      body: '',
    });
    return out;
  }

  claim(ref: string): ActResult {
    const { root } = this.resolve(ref);
    const res = this.act(ref, (v, ctx) => this.claimEvents(v, ctx, root));
    if (res.view.claimedBy !== this.actor) {
      throw new OpsError(
        `lost the claim on ${res.view.meta.id} to ${res.view.claimedBy ?? 'another run'}`,
      );
    }
    return res;
  }

  start(ref: string, plan = ''): ActResult {
    const { root } = this.resolve(ref);
    return this.act(ref, (v, ctx) => {
      this.requireTriaged(v, ctx);
      const out = [];
      let holder = v.claimToken ?? undefined;
      if (isClaimable(v) && !ctx.holds) {
        out.push(...this.claimEvents(v, ctx, root));
        holder = out.find((e) => e.type === 'claim')?.token;
      } else if (!ctx.holds) ctx.needHolder();
      else if (v.status !== 'claimed' && v.status !== 'in-progress') ctx.wrongState('start');
      out.push({ type: 'start', lease_until: this.lease(root, 'work'), holder, body: plan });
      return out;
    });
  }

  progress(ref: string, message: string): ActResult {
    const { root } = this.resolve(ref);
    return this.act(ref, (v, ctx) => {
      ctx.requireStatus(['claimed', 'in-progress'], 'report progress on');
      if (!ctx.holds) ctx.needHolder();
      return [
        {
          type: 'progress',
          lease_until: this.lease(root, 'work'),
          holder: v.claimToken ?? undefined,
          body: message,
        },
      ];
    });
  }

  /** Extends the holder's lease without a note; the supervisor calls it while a run lives. */
  renew(ref: string, run?: string): ActResult {
    const { root } = this.resolve(ref);
    return this.act(ref, (v, ctx) => {
      ctx.requireStatus(['claimed', 'in-progress'], 'renew');
      if (!ctx.holds) ctx.needHolder();
      const kind = v.status === 'claimed' ? 'claim' : 'work';
      return [
        {
          type: 'renew',
          run,
          lease_until: this.lease(root, kind),
          holder: v.claimToken ?? undefined,
          body: '',
        },
      ];
    });
  }

  /** Records a supervisor run starting or ending on a task. History only; no state change. */
  recordRun(
    ref: string,
    type: 'run-start' | 'run-end',
    fields: Pick<OpsEvent, 'run' | 'exit' | 'reason' | 'minutes' | 'tokens'>,
    message = '',
  ): ActResult {
    return this.act(ref, () => [{ type, ...fields, body: message }]);
  }

  /** Records that opsd merged the task's approved work into a base branch. History only. */
  recordMerge(
    ref: string,
    fields: Required<Pick<OpsEvent, 'commit' | 'into'>> & Pick<OpsEvent, 'branch'>,
    message = '',
  ): ActResult {
    return this.act(ref, () => [{ type: 'merge', ...fields, body: message }]);
  }

  /**
   * Sends approved work back to whoever does it when merging it failed: a `changes` verdict on
   * a task the last verdict closed, so it is reopened, lands in their inbox and resumes first.
   */
  sendBack(ref: string, message: string, to?: string): ActResult {
    if (to) assertActor(to, 'addressee');
    return this.act(ref, (v, ctx) => {
      if (v.status !== 'done') ctx.wrongState('send back');
      return [
        { type: 'verdict', verdict: 'changes', to: to ?? v.owner ?? undefined, body: message },
      ];
    });
  }

  checkpoint(ref: string, summary: string, next?: string): ActResult {
    const { root } = this.resolve(ref);
    return this.act(ref, (v, ctx) => {
      if (!ctx.holds) ctx.needOwnerOrHolder();
      return [
        {
          type: 'checkpoint',
          next,
          lease_until: this.lease(root, 'work'),
          // An owner who does not hold the claim (say, on a clone whose claim lost) records the
          // checkpoint without renewing the standing claim.
          holder: ctx.holds ? (v.claimToken ?? undefined) : (root.myClaim(v.meta.id) ?? NO_CLAIM),
          body: summary,
        },
      ];
    });
  }

  release(ref: string, message = ''): ActResult {
    return this.act(ref, (v, ctx) => {
      ctx.requireStatus(['claimed', 'in-progress'], 'release');
      if (!ctx.holds) ctx.needHolder();
      return [{ type: 'release', holder: v.claimToken ?? undefined, body: message }];
    });
  }

  handoff(ref: string, to: string, message: string): ActResult {
    assertOwner(to);
    const res = this.act(ref, (v, ctx) => {
      ctx.requireOpen('hand off');
      // opsd hands unclaimed work of a signed-out provider to another provider (AO-0154).
      const byOpsd = !!this.actor && runtimeOf(this.actor) === 'opsd';
      if (!(byOpsd && !v.claimedBy)) ctx.needOwnerOrHolder();
      if (v.meta.type === QUESTION_TYPE) assertQuestionTo(to, v.meta.created_by, ctx.actor);
      this.checkTarget(ctx, to, 'new owner');
      return [{ type: 'handoff', to, body: message }];
    });
    return this.noteInactive(res, to);
  }

  assign(ref: string, to: string, message = ''): ActResult {
    assertOwner(to);
    const res = this.act(ref, (v, ctx) => {
      ctx.requireOpen('assign');
      ctx.needOwnerOrHolder();
      if (v.meta.type === QUESTION_TYPE) assertQuestionTo(to, v.meta.created_by, ctx.actor);
      const why = this.ownerRefusal(to);
      if (why) {
        const root = this.roots.find((r) => r.name === v.root);
        ctx.needForce(`owner ${why}, so no run picks it up; ${this.ownerSuggestions(root)}`);
        ctx.warnings.push(`owner ${why}: no run picks it up`);
      }
      // A blocked task keeps its open question (or wait on other tasks) under the new owner;
      // `answer` or `unblock` drop it on purpose (AO-0115). Handoff still clears the wait.
      const keepWait = v.status === 'blocked';
      return [{ type: 'assign', to, body: message, ...(keepWait && { keep_wait: true }) }];
    });
    return this.noteInactive(isHuman(to) ? withNotes(res, messageNotes(message)) : res, to);
  }

  review(ref: string, message: string, to?: string): ActResult {
    let sentTo: string | null | undefined;
    const res = this.act(ref, (v, ctx) => {
      ctx.requireStatus(['claimed', 'in-progress'], 'send for review');
      ctx.needOwnerOrHolder();
      const reviewer = to ?? v.delegation?.review ?? ctx.human;
      // The author is whoever holds the work, whoever sends it.
      const author = v.claimedBy ?? ctx.actor;
      if (reviewer) {
        assertActor(reviewer, 'reviewer');
        if (!isHuman(reviewer) && runtimeOf(reviewer) === runtimeOf(author)) {
          ctx.needForce(
            `the reviewer must come from another provider than the author (${runtimeOf(author)})`,
          );
        }
        this.checkTarget(ctx, reviewer, 'reviewer');
      }
      sentTo = reviewer;
      return [{ type: 'review', to: reviewer, body: message }];
    });
    return this.noteInactive(res, sentTo);
  }

  verdict(ref: string, verdict: 'approve' | 'changes', message: string): ActResult {
    return this.act(ref, (v, ctx) => {
      ctx.requireStatus(['needs-review'], 'give a verdict on');
      if (!v.reviewer || !ownerMatches(v.reviewer, ctx.actor)) {
        ctx.needPrivilege(`${v.meta.id} waits for ${v.reviewer ?? 'a human'}'s review`);
      }
      return [{ type: 'verdict', verdict, to: v.owner ?? undefined, body: message }];
    });
  }

  done(ref: string, message = ''): ActResult {
    return this.act(ref, (v, ctx) => {
      ctx.requireOpen('close');
      const reviewing = v.status === 'needs-review' && ownerMatches(v.reviewer, ctx.actor);
      if (!reviewing) ctx.needOwnerOrHolder();
      if (v.meta.type !== QUESTION_TYPE) return [{ type: 'done', body: message }];
      // The answer to a question goes to whoever asked, so it lands in their inbox.
      const asker = v.meta.created_by;
      if (ownerMatches(asker, ctx.actor)) return [{ type: 'done', body: message }];
      if (!message.trim()) {
        throw new OpsError(
          `${v.meta.id} is a question: answer it with ops done ${v.meta.id} "answer"`,
          2,
        );
      }
      return [{ type: 'done', to: asker, body: message }];
    });
  }

  ask(ref: string, question: string, to?: string): ActResult {
    const res = this.act(ref, (_v, ctx) => {
      ctx.requireOpen('ask on');
      ctx.needOwnerOrHolder();
      const target = to ?? ctx.human;
      if (target) assertActor(target, 'addressee');
      this.checkTarget(ctx, target, 'addressee', false);
      return [{ type: 'ask', to: target, body: question }];
    });
    // With no addressee the question still waits for a person.
    const target = res.events.find((e) => e.type === 'ask')?.to;
    return !target || isHuman(target) ? withNotes(res, messageNotes(question)) : res;
  }

  block(ref: string, message: string, opts: { on?: string[]; to?: string } = {}): ActResult {
    const { root } = this.resolve(ref);
    const on = opts.on?.map((d) => this.depRef(root, d));
    return this.act(ref, (v, ctx) => {
      ctx.requireOpen('block');
      ctx.needOwnerOrHolder();
      // depRef keeps a same-root ref bare, so the task itself shows up as its bare id.
      if (on?.includes(v.meta.id)) throw new OpsError('a task cannot wait on itself', 2);
      if (on && on.length > 0) return [{ type: 'block', on, body: message }];
      const target = opts.to ?? ctx.human;
      if (target) assertActor(target, 'addressee');
      this.checkTarget(ctx, target, 'addressee', false);
      return [{ type: 'block', to: target, body: message }];
    });
  }

  answer(ref: string, message: string): ActResult {
    return this.act(ref, (v, ctx) => {
      if (v.status !== 'blocked') ctx.wrongState('answer');
      if (!(v.waitingOn && ownerMatches(v.waitingOn, ctx.actor))) {
        ctx.needPrivilege(`${v.meta.id} waits for ${v.waitingOn ?? 'a human'}`);
      }
      return [{ type: 'answer', to: v.askedBy ?? v.owner ?? undefined, body: message }];
    });
  }

  unblock(ref: string, message = ''): ActResult {
    return this.act(ref, (v, ctx) => {
      if (v.status !== 'blocked') ctx.wrongState('unblock');
      const waitingOnMe = v.waitingOn !== null && ownerMatches(v.waitingOn, ctx.actor);
      if (!waitingOnMe) ctx.needOwnerOrHolder();
      return [{ type: 'unblock', to: v.askedBy ?? undefined, body: message }];
    });
  }

  comment(ref: string, message: string, to?: string): ActResult {
    if (to) assertOwner(to);
    if (!message.trim()) throw new OpsError('a comment needs text', 2);
    // A comment addressed to its own author notifies nobody, so it is written without one.
    const res = this.act(
      ref,
      (_v, ctx) => {
        this.checkTarget(ctx, to, 'addressee', false);
        return [{ type: 'comment', to: to === ctx.actor ? undefined : to, body: message }];
      },
      { helperOk: true },
    );
    return to && isHuman(to) ? withNotes(res, messageNotes(message)) : res;
  }

  setPriority(ref: string, priority: Priority, message = ''): ActResult {
    if (!PRIORITIES.includes(priority)) {
      throw new OpsError(`bad priority '${priority}': use p0, p1, p2 or p3`, 2);
    }
    return this.act(ref, (_v, ctx) => {
      ctx.needOwnerOrHolder();
      return [{ type: 'priority', priority, body: message }];
    });
  }

  /**
   * Changes the task's type, for example a finding accepted as a bug or set aside as an idea.
   * Written as an event, so it syncs like any other change; `task.md` keeps the type it was filed with.
   */
  retype(
    ref: string,
    type: string,
    message = '',
    opts: { to?: string; answer?: string; priority?: Priority } = {},
  ): ActResult {
    if (opts.to) assertOwner(opts.to);
    if (!/^[a-z][a-z0-9-]{0,29}$/.test(type)) {
      throw new OpsError(`bad type '${type}': use lowercase letters, digits and hyphens`, 2);
    }
    if (opts.priority && !PRIORITIES.includes(opts.priority)) {
      throw new OpsError(`bad priority '${opts.priority}': use p0, p1, p2 or p3`, 2);
    }
    const answer = opts.answer?.trim();
    return this.act(ref, (v, ctx) => {
      ctx.needPrivilege('only a human or the orchestrator changes a task type');
      if (v.meta.type === type) throw new OpsError(`${v.meta.id} is already a ${type}`, 1);
      if (type === QUESTION_TYPE) {
        assertQuestionTo(opts.to ?? v.owner, v.meta.created_by, ctx.actor);
      }
      // The owner, the priority and the answer to an open question land in the same write as the
      // new type: triage never leaves half a change (AO-0093 was accepted but still waited for its
      // answer).
      const events: PlannedEvent[] = [{ type: 'retype', task_type: type, body: message }];
      if (opts.priority && opts.priority !== v.meta.priority) {
        events.push({ type: 'priority', priority: opts.priority, body: '' });
      }
      if (opts.to && opts.to !== v.owner) {
        ctx.requireOpen('assign');
        this.checkTarget(ctx, opts.to, 'owner');
        // Without an answer, the open question (or wait on other tasks) moves to the new owner
        // instead of disappearing (AO-0111).
        const keepWait = !answer && v.status === 'blocked';
        events.push({
          type: 'assign',
          to: opts.to,
          body: '',
          ...(keepWait && { keep_wait: true }),
        });
      }
      if (answer) {
        if (v.status !== 'blocked' || !v.waitingOn) ctx.wrongState('answer');
        events.push({ type: 'answer', to: v.askedBy ?? v.owner ?? undefined, body: answer });
      }
      return events;
    });
  }

  park(ref: string, message: string): ActResult {
    return this.act(ref, (_v, ctx) => {
      ctx.requireOpen('park');
      ctx.needPrivilege('only a human or the orchestrator parks tasks');
      return [{ type: 'park', body: message }];
    });
  }

  reopen(ref: string, message = ''): ActResult {
    const { root, id } = this.resolve(ref);
    return this.act(ref, (v, ctx) => {
      if (OPEN_STATUSES.has(v.status)) ctx.wrongState('reopen');
      ctx.needOwnerOrHolder();
      if (root.isArchived(id)) root.unarchiveTask(id);
      return [{ type: 'reopen', body: message }];
    });
  }

  /** Hands the task to `to` with limits and an expected reviewer, recorded on the task. */
  delegate(ref: string, to: string, input: DelegateInput = {}): ActResult {
    assertOwner(to);
    const budget = input.budget ? parseDuration(input.budget) : undefined;
    const tokens = input.tokens ? parseTokens(input.tokens) : undefined;
    const due = input.due ? parseWhen(input.due, this.now()) : undefined;
    const review = input.review ? assertActor(input.review, 'reviewer') : undefined;
    const res = this.act(ref, (v, ctx) => {
      ctx.requireOpen('delegate');
      ctx.needOwnerOrHolder();
      if (v.meta.type === QUESTION_TYPE) assertQuestionTo(to, v.meta.created_by, ctx.actor);
      this.checkTarget(ctx, to, 'delegate');
      this.checkTarget(ctx, review, 'reviewer');
      // A role wildcard (`*:engineer`) has no provider yet: opsd never hands such a task to the
      // reviewer's provider, and `ops review` checks the author when it is sent.
      if (
        review &&
        !isHuman(review) &&
        !to.startsWith('*:') &&
        runtimeOf(review) === runtimeOf(to)
      ) {
        ctx.needForce(
          `the reviewer must come from another provider than the delegate (${runtimeOf(to)})`,
        );
      }
      return [
        {
          type: 'delegate',
          to,
          budget_minutes: budget,
          tokens,
          due,
          review,
          body: input.message ?? '',
        },
      ];
    });
    return this.noteInactive(res, to, review);
  }

  /**
   * Moves done and parked tasks untouched for `days` days to `archive/tasks/`. `list --all`,
   * `show` and dependency checks still find them; `reopen` moves a task back.
   */
  archive(opts: { days?: number; dryRun?: boolean } = {}): string[] {
    const actor = this.requireActor();
    if (!isHuman(actor) && !isOrchestrator(actor) && !this.force) {
      throw new OpsError(
        'only a human or the orchestrator archives tasks (use --force to override)',
      );
    }
    const days = opts.days ?? 30;
    if (!Number.isFinite(days) || days < 0) throw new OpsError(`bad --days '${days}'`, 2);
    const cutoff = this.now() - days * 86_400_000;
    const moved: string[] = [];
    for (const r of this.roots) {
      for (const s of r.states()) {
        const id = s.meta.id;
        if (!archivable(s.status, s.updatedAt, cutoff)) continue;
        // The index may be stale: fold again under the task lock before moving anything.
        const ok = opts.dryRun
          ? true
          : r.lock(`task-${id}`, () => {
              if (r.isArchived(id) || !r.hasTask(id)) return false;
              const now = r.foldTask(id);
              if (!archivable(now.status, now.updatedAt, cutoff)) return false;
              r.archiveTask(id);
              return true;
            });
        if (ok) moved.push(this.roots.length > 1 ? `${r.name}/${id}` : id);
      }
    }
    return moved;
  }

  // ---- Findings and the KB -------------------------------------------------------------------

  /** Files a finding as a new task of type `finding`; with `task`, links it from that task. */
  finding(input: NewTaskInput & { task?: string }): { meta: TaskMeta; linked?: OpsEvent } {
    const from = input.task ? this.resolve(input.task) : undefined;
    // A linked finding lives in its source task's root, so the plain id in the link is unique,
    // and belongs to its project, so opsd counts work on both against one project.
    const project =
      input.project?.trim() ||
      (from ? this.projectOfTask(`${from.root.name}/${from.id}`) : undefined);
    const meta = this.newTask({ ...input, type: 'finding', project }, from?.root);
    if (!from) return { meta };
    const res = this.act(`${from.root.name}/${from.id}`, () => [
      { type: 'finding', ref: meta.id, body: meta.title },
    ]);
    return { meta, linked: res.events[0] };
  }

  /** Writes a learn note to `kb/<topic>/<slug>.md`; with `task`, adds a learn event to it. */
  learn(input: { topic: string; title: string; body: string; task?: string; tags?: string[] }): {
    note: KbNote;
    linked?: OpsEvent;
  } {
    const actor = this.requireActor();
    const title = input.title.trim();
    if (!title) throw new OpsError('a learn note needs a title', 2);
    if (!input.body.trim()) throw new OpsError('a learn note needs a body (-m or --body-file)', 2);
    assertNoSecret(title, input.body, ...(input.tags ?? []));
    const from = input.task ? this.resolve(input.task) : undefined;
    const root = from?.root ?? this.defaultRoot();
    const note = writeNote(
      root,
      {
        title,
        topic: input.topic,
        author: actor,
        created_at: new Date(this.now()).toISOString(),
        task: from?.id,
        tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
      },
      input.body,
    );
    if (!from) return { note };
    const res = this.act(`${from.root.name}/${from.id}`, () => [
      { type: 'learn', ref: note.ref, body: note.title },
    ]);
    return { note, linked: res.events[0] };
  }

  /** Searches learn notes in every root. */
  kb(words: string[] = [], topic?: string): KbHit[] {
    return searchNotes(
      this.roots.flatMap((r) => readNotes(r, topic)),
      words,
    );
  }

  /**
   * Searches tasks (id, title, description, thread), learn notes, channel posts and votes in
   * every root. Words must all match; `agent:`, `status:`, `project:`, `type:`, `priority:`,
   * `root:`, `is:open|closed` and `in:tasks|notes|posts|votes` narrow it (see `parseQuery`).
   */
  search(q: string, opts: { limit?: number } = {}): SearchHit[] {
    return this.searchResult(q, opts).hits;
  }

  /**
   * `search` with whether it is partial: the request reached its fixed work budget
   * (`SEARCH_WORK`) and some items were not searched.
   */
  searchResult(q: string, opts: { limit?: number } = {}): SearchResult {
    // The sources read through a shared, bounded cache, so a repeated search reads only what
    // changed; each source loads only when the query can match its kind, within its share of
    // the request's budget.
    const query = parseQuery(q);
    // `root:` narrows the roots before any source work, so other roots cost nothing.
    const roots =
      query.root.length === 0
        ? this.roots
        : this.roots.filter((r) => query.root.includes(r.name.toLowerCase()));
    const budget = searchBudget(wantedKinds(query).length, roots.length);
    const hits = runSearch(searchSources(roots, this.now(), budget), query, opts.limit);
    return { hits, partial: budget.partial };
  }

  /** One note by `<topic>/<slug>` or `<root>/<topic>/<slug>`. */
  kbNote(ref: string): KbNote {
    const parts = ref.replace(/\.md$/, '').split('/');
    const [rootName, topic, slug] = parts.length === 3 ? parts : [undefined, parts[0], parts[1]];
    if (!topic || !slug) throw new OpsError(`bad note '${ref}': use <topic>/<slug>`, 2);
    const roots = rootName ? this.roots.filter((r) => r.name === rootName) : this.roots;
    const found = roots.flatMap((r) => readNotes(r, topic)).filter((n) => n.slug === slug);
    if (found.length === 0) throw new OpsError(`no note ${ref}`, 2);
    if (found.length > 1) {
      throw new OpsError(`${ref} exists in several roots; write <root>/${ref}`, 2);
    }
    return found[0]!;
  }

  // ---- Attachments ---------------------------------------------------------------------------

  /**
   * Stores an image for text that refers to it: in the root of `task` when given (comments and
   * answers), else in the default root, where new tasks and channel posts go.
   */
  attach(data: Uint8Array, opts: { task?: string; alt?: string } = {}): Attachment {
    this.requireActor();
    const root = opts.task ? this.resolve(opts.task).root : this.defaultRoot();
    return saveAttachment(root, data, { alt: opts.alt, now: this.now() });
  }

  /** An attachment by file name, from whichever visible root holds it. */
  attachment(name: string): Attachment {
    const a = findAttachment(this.roots, name);
    if (!a) throw new OpsError(`no attachment ${name}`, 2);
    return a;
  }

  /** The attachments that `texts` refer to and that a visible root holds, in order of mention. */
  attachmentsIn(...texts: string[]): Attachment[] {
    const names = [...new Set(texts.flatMap((t) => attachmentRefs(t)))];
    return names.flatMap((n) => findAttachment(this.roots, n) ?? []);
  }

  // ---- Channels ------------------------------------------------------------------------------

  /** Posts to a channel in the default root. `@id` in the text and `to` become mentions. */
  post(channel: string, text: string, opts: { to?: string[]; task?: string } = {}): ChannelMessage {
    const actor = this.requireActor();
    if (!text.trim()) throw new OpsError('a message needs text', 2);
    assertNoSecret(text);
    const name = assertChannel(channel);
    for (const t of opts.to ?? []) assertOwner(t);
    const mentions = [...new Set([...findMentions(text), ...(opts.to ?? [])])];
    const task = opts.task ? this.resolve(opts.task).id : undefined;
    const nowMs = this.now();
    return postMessage(
      this.defaultRoot(),
      name,
      {
        actor,
        at: new Date(nowMs).toISOString(),
        mentions: mentions.length > 0 ? mentions : undefined,
        task,
        body: text,
      },
      nowMs,
    );
  }

  /** Creates a channel in the default root, with what it is for. */
  createChannel(channel: string, description = ''): ChannelInfo {
    const actor = this.requireActor();
    assertNoSecret(description);
    const name = assertChannel(channel);
    const existing = this.channels().find((c) => c.name === name);
    if (existing) throw new OpsError(`channel #${name} exists`, 2);
    return writeChannel(this.defaultRoot(), name, {
      description: description.trim() || undefined,
      created_by: actor,
      created_at: new Date(this.now()).toISOString(),
    });
  }

  /**
   * Messages in a channel across roots, oldest first, each with its root. `root` reads one root
   * only. `around` returns the `limit` messages centred on that message id instead of the newest.
   */
  channel(
    name: string,
    opts: { after?: string; limit?: number; root?: string; around?: string } = {},
  ): RootedPost[] {
    const roots = opts.root ? this.roots.filter((r) => r.name === opts.root) : this.roots;
    if (opts.root && roots.length === 0) throw new OpsError(`no root '${opts.root}'`, 2);
    const all = roots
      .flatMap((r) =>
        readChannel(r, name, { after: opts.after }).map((m) => ({ ...m, root: r.name })),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.root < b.root ? -1 : 1));
    if (opts.around !== undefined) {
      const at = all.findIndex((m) => m.id === opts.around);
      if (at < 0) throw new OpsError(`no message ${opts.around} in #${assertChannel(name)}`, 2);
      const asked = opts.limit ?? Number.NaN;
      const n = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : all.length;
      const start = Math.max(0, Math.min(at - Math.floor(n / 2), all.length - n));
      return all.slice(start, start + n);
    }
    return opts.limit !== undefined ? all.slice(-opts.limit) : all;
  }

  /**
   * Everything that happened across roots, newest first: task events (with the task's title and
   * project), archived tasks included, and channel posts. The newest `limit` items (default 200,
   * at most 1000); `activityPage` pages and filters.
   */
  activity(opts: { limit?: number } = {}): ActivityItem[] {
    const limit = Number.isFinite(opts.limit) ? opts.limit : 200;
    return activityPage(this.roots, { limit }).items;
  }

  /**
   * One page of the activity feed: `q` filters it (see `parseActivityQuery`), `before` is the
   * `next` of the page before. Every task is read, archived ones too: an event's time is not
   * bounded by its task's `updatedAt` (push ordering can put an older clock after a newer one).
   */
  activityPage(opts: ActivityOptions = {}): ActivityPage {
    return activityPage(this.roots, opts);
  }

  /**
   * The replay timeline (see `buildTimeline`) of every root, or of `root`, narrowed to `project`
   * when given, for the window `from` to `to` (ms; `to` defaults to now). Archived tasks count.
   * A closed task whose last event is more than a day before `from` is not read: the day covers
   * events that sync placed after newer ones.
   */
  timeline(
    opts: {
      root?: string;
      project?: string;
      from?: number;
      to?: number;
      maxGapMs?: number;
      clipMs?: number;
    } = {},
  ): Timeline {
    const to = opts.to ?? this.now();
    const roots = opts.root ? this.roots.filter((r) => r.name === opts.root) : this.scopedRoots();
    if (opts.root && roots.length === 0) throw new OpsError(`no root named '${opts.root}'`, 2);
    const tasks: TimelineTask[] = [];
    const ids = new Set<string>();
    for (const root of roots) {
      const project = opts.project ? root.projectName(opts.project) : undefined;
      for (const s of [...root.states(), ...root.archivedStates()]) {
        const ref = `${root.name}/${s.meta.id}`;
        if (ids.has(ref)) continue;
        if (project !== undefined && s.meta.project !== project) continue;
        if (Date.parse(s.meta.created_at) >= to) continue;
        const closed = !OPEN_STATUSES.has(s.status);
        const quiet = opts.from !== undefined && Date.parse(s.updatedAt) < opts.from - 86_400_000;
        if (closed && quiet) continue;
        ids.add(ref);
        tasks.push({ root: root.name, meta: s.meta, events: root.readEvents(s.meta.id) });
      }
    }
    const names = new Set(roots.map((r) => r.name));
    const decisions = this.decisions({ all: true }).filter(
      (d) =>
        names.has(d.root) &&
        (!opts.project || (d.meta.task !== undefined && ids.has(`${d.root}/${d.meta.task}`))),
    );
    return buildTimeline(tasks, decisions, {
      from: opts.from,
      to,
      maxGapMs: opts.maxGapMs,
      clipMs: opts.clipMs,
    });
  }

  channels(): ChannelInfo[] {
    const byName = new Map<string, ChannelInfo>();
    for (const c of this.roots.flatMap((r) => listChannels(r))) {
      const prev = byName.get(c.name);
      if (!prev) {
        byName.set(c.name, { ...c });
      } else {
        prev.messages += c.messages;
        prev.description ??= c.description;
        if (c.last && (!prev.last || c.last > prev.last)) prev.last = c.last;
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- Votes and decisions -------------------------------------------------------------------

  resolveDecision(ref: string): { root: Root; id: string } {
    const slash = ref.indexOf('/');
    const rootName = slash > 0 ? ref.slice(0, slash) : undefined;
    const id = parseDecisionId(slash > 0 ? ref.slice(slash + 1) : ref);
    if (!id) throw new OpsError(`bad decision id '${ref}': use D-0001`, 2);
    const roots = rootName ? this.roots.filter((r) => r.name === rootName) : this.roots;
    const matches = roots.filter((r) => hasDecision(r, id));
    if (matches.length === 0) throw new OpsError(`no decision ${id}`, 2);
    if (matches.length > 1) {
      throw new OpsError(`${id} exists in several roots; write <root>/${id}`, 2);
    }
    return { root: matches[0]!, id };
  }

  propose(input: ProposeInput): DecisionMeta {
    const actor = this.requireActor();
    const question = input.question.trim();
    if (!question) throw new OpsError('a vote needs a question', 2);
    const options = input.options.map((o) => o.trim()).filter(Boolean);
    if (options.length < 2) throw new OpsError('a vote needs at least two options', 2);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
      throw new OpsError('options must differ', 2);
    }
    assertNoSecret(question, input.body, ...options);
    const voters = (input.voters ?? []).map((v) => assertOwner(v));
    const quorum = input.quorum ?? defaultQuorum(voters);
    if (!Number.isInteger(quorum) || quorum < 1) throw new OpsError(`bad quorum '${quorum}'`, 2);
    const fixed = voters.length > 0 && voters.every((v) => !isWildcard(v));
    if (fixed && quorum > voters.length) {
      throw new OpsError(`quorum ${quorum} is more than the ${voters.length} voters`, 2);
    }
    if (!fixed && !input.deadline) {
      throw new OpsError(
        'a vote open to anyone or to a group (claude:*, *:engineer) needs --deadline, or it never closes',
        2,
      );
    }
    const from = input.task ? this.resolve(input.task) : undefined;
    const root = from?.root ?? this.defaultRoot();
    return createDecision(
      root,
      {
        question,
        options,
        voters: voters.length > 0 ? voters : undefined,
        quorum,
        deadline: input.deadline ? parseWhen(input.deadline, this.now()) : undefined,
        task: from?.id,
        created_by: actor,
        created_at: new Date(this.now()).toISOString(),
      },
      input.body ?? '',
      this.user.id_block ?? 0,
    );
  }

  decision(ref: string): Decision {
    const { root, id } = this.resolveDecision(ref);
    return readDecision(root, id, this.now());
  }

  /** Decisions in every root; open ones unless `all`. */
  decisions(opts: { all?: boolean } = {}): Decision[] {
    const nowMs = this.now();
    return this.roots
      .flatMap((r) => listDecisionIds(r).map((id) => readDecision(r, id, nowMs)))
      .filter((d) => opts.all || d.tally.state !== 'decided');
  }

  /** Casts the actor's ballot. Ballots are final. */
  vote(ref: string, choice: string, reason = ''): Decision {
    const actor = this.requireActor();
    assertNoSecret(reason);
    const { root, id } = this.resolveDecision(ref);
    return root.lock(`decision-${id}`, () => {
      const d = readDecision(root, id, this.now());
      if (d.outcome) throw new OpsError(`${id} is decided: ${d.outcome.choice}`);
      if (d.meta.deadline && Date.parse(d.meta.deadline) <= this.now()) {
        throw new OpsError(`voting on ${id} closed at ${d.meta.deadline}`);
      }
      if (d.ballots.some((b) => b.actor === actor)) {
        throw new OpsError(`${actor} already voted on ${id}; ballots are final`);
      }
      if (!mayVote(d.meta, actor)) {
        throw new OpsError(
          `${actor} is not a voter on ${id} (${(d.meta.voters ?? []).join(', ')})`,
        );
      }
      const opt = matchOption(d.meta.options, choice);
      writeBallot(root, id, {
        actor,
        at: new Date(this.now()).toISOString(),
        choice: opt,
        body: reason,
      });
      return readDecision(root, id, this.now());
    });
  }

  /**
   * Records the outcome. A human may decide at any time; anyone else only when the vote is ready
   * and the choice is the leading option. Ties and missing quorum go to the human.
   */
  decide(ref: string, choice: string, reason = ''): Decision {
    const actor = this.requireActor();
    assertNoSecret(reason);
    const { root, id } = this.resolveDecision(ref);
    const d = root.lock(`decision-${id}`, () => {
      const cur = readDecision(root, id, this.now());
      if (cur.outcome && !(this.force && isHuman(actor))) {
        throw new OpsError(`${id} is decided: ${cur.outcome.choice} (a human can use --force)`);
      }
      const opt = matchOption(cur.meta.options, choice);
      if (!isHuman(actor)) {
        const t = cur.tally;
        if (t.state === 'tie' || t.state === 'no-quorum') {
          throw new OpsError(`${id} ended in ${t.state}; the human decides`);
        }
        if (t.state !== 'ready') throw new OpsError(`${id} is still open; voting goes on`);
        if (t.leaders[0] !== opt) {
          throw new OpsError(`the vote on ${id} chose '${t.leaders[0]}', not '${opt}'`);
        }
      }
      writeOutcome(root, id, {
        choice: opt,
        decided_by: actor,
        at: new Date(this.now()).toISOString(),
        body: reason,
      });
      return readDecision(root, id, this.now());
    });
    if (d.meta.task) {
      const why = reason ? `. ${reason}` : '';
      const text = `Decision ${id} (${d.meta.question}): ${d.outcome!.choice}${why}`;
      const to = d.meta.created_by === actor ? undefined : d.meta.created_by;
      this.act(`${root.name}/${d.meta.task}`, () => [{ type: 'comment', to, body: text }]);
    }
    return d;
  }

  // ---- Repeating tasks (AO-0142) -------------------------------------------------------------

  /** Finds the root of a repeat named `name` or `root/name`. */
  resolveRepeat(ref: string): { root: Root; name: string } {
    const slash = ref.indexOf('/');
    const rootName = slash > 0 ? ref.slice(0, slash) : undefined;
    const name = assertRepeatName(slash > 0 ? ref.slice(slash + 1) : ref);
    const roots = rootName ? this.roots.filter((r) => r.name === rootName) : this.roots;
    if (rootName && roots.length === 0) throw new OpsError(`no root named '${rootName}'`, 2);
    const matches = roots.filter((r) => hasRepeat(r, name));
    if (matches.length === 0) throw new OpsError(`no repeat '${name}'`, 2);
    if (matches.length > 1)
      throw new OpsError(`'${name}' exists in several roots; write <root>/${name}`, 2);
    return { root: matches[0]!, name };
  }

  /**
   * Adds a repeat, or with `replace` changes the one of that name. Each firing creates approved
   * work, so only a human or the orchestrator manages repeats.
   */
  saveRepeat(input: RepeatInput, opts: { replace?: boolean } = {}): RepeatView {
    const actor = this.requireActor();
    if (!privileged(actor)) {
      throw new OpsError(`${actor} cannot manage repeats: a human or the orchestrator does`);
    }
    // `root/name` or `root` names the root; an edit finds the repeat wherever it is, so it never
    // writes a second copy into the default root.
    const slash = input.name.indexOf('/');
    const rootName = input.root?.trim() || (slash > 0 ? input.name.slice(0, slash) : undefined);
    const name = assertRepeatName(slash > 0 ? input.name.slice(slash + 1) : input.name);
    const ref = rootName ? `${rootName}/${name}` : name;
    let root: Root;
    if (opts.replace) {
      root = this.resolveRepeat(ref).root;
    } else if (rootName) {
      const r = this.roots.find((x) => x.name === rootName);
      if (!r) throw new OpsError(`no root named '${rootName}'`, 2);
      root = r;
    } else {
      root = this.defaultRoot();
    }
    const title = input.title.trim();
    if (!title) throw new OpsError('a repeat needs a title', 2);
    assertNoSecret(title, input.body);
    if (input.owner) {
      assertOwner(input.owner);
      const why = isWildcard(input.owner) ? null : this.unreachable(input.owner);
      if (why && !this.force) {
        throw new OpsError(
          `owner ${why}; configured agents: ${this.knownAgents().join(', ')} (use --force to override)`,
        );
      }
    }
    if (input.priority && !PRIORITIES.includes(input.priority)) {
      throw new OpsError(`bad priority '${input.priority}': use p0, p1, p2 or p3`, 2);
    }
    const existing = hasRepeat(root, name) ? readRepeat(root, name) : undefined;
    if (opts.replace && !existing) throw new OpsError(`no repeat '${name}'`, 2);
    if (!opts.replace && existing) throw new OpsError(`repeat '${name}' exists`, 2);
    const parent = input.parent ? this.resolve(input.parent).id : undefined;
    const when = input.when?.trim() || undefined;
    if (when) this.resolve(parseCondition(when).task);
    const meta: RepeatMeta = {
      name,
      title,
      type: input.type || undefined,
      priority: input.priority,
      owner: input.owner || undefined,
      project: input.project?.trim() || undefined,
      parent,
      labels: input.labels && input.labels.length > 0 ? input.labels : undefined,
      start: input.start?.trim() ? normalizeStart(input.start) : undefined,
      repeat: when ? undefined : ((input.repeat?.trim() || 'once') as RepeatRule),
      days: input.days && input.days.length > 0 ? parseWeekdays(input.days) : undefined,
      until: input.until?.trim() || undefined,
      count: input.count,
      when,
      paused: input.paused || undefined,
      created_by: existing?.meta.created_by ?? actor,
      created_at: existing?.meta.created_at ?? new Date(this.now()).toISOString(),
    };
    validateRule(meta);
    writeRepeat(root, meta, input.body ?? '');
    return this.repeatView(`${root.name}/${name}`);
  }

  /** Every repeat in the visible roots, by name, then root. */
  repeats(): RepeatView[] {
    return this.scopedRoots()
      .flatMap((r) => listRepeatNames(r).map((n) => this.viewRepeat(r, readRepeat(r, n), true)))
      .sort((a, b) => a.meta.name.localeCompare(b.meta.name) || a.root.localeCompare(b.root));
  }

  repeatView(ref: string): RepeatView {
    const { root, name } = this.resolveRepeat(ref);
    return this.viewRepeat(root, readRepeat(root, name), true);
  }

  /** Pauses or resumes a repeat. Slots missed while paused fire once on resume. */
  setRepeatPaused(ref: string, paused: boolean): RepeatView {
    const actor = this.requireActor();
    if (!privileged(actor)) {
      throw new OpsError(`${actor} cannot manage repeats: a human or the orchestrator does`);
    }
    const { root, name } = this.resolveRepeat(ref);
    root.lock(`repeat-${name}`, () => {
      const def = readRepeat(root, name);
      writeRepeat(root, { ...def.meta, paused: paused || undefined }, def.body);
    });
    return this.repeatView(`${root.name}/${name}`);
  }

  /** Deletes the repeat. The tasks it created stay. */
  deleteRepeat(ref: string): void {
    const actor = this.requireActor();
    if (!privileged(actor)) {
      throw new OpsError(`${actor} cannot manage repeats: a human or the orchestrator does`);
    }
    const { root, name } = this.resolveRepeat(ref);
    root.lock(`repeat-${name}`, () => removeRepeat(root, name));
  }

  /**
   * Creates the repeat's task now, whether or not a slot is due, paused or not. A time rule counts
   * it as the slot of this minute, so a slot that passed before it does not fire as well.
   */
  runRepeat(ref: string): TaskMeta {
    const actor = this.requireActor();
    if (!privileged(actor)) {
      throw new OpsError(`${actor} cannot run repeats: a human or the orchestrator does`);
    }
    const { root, name } = this.resolveRepeat(ref);
    return root.lock(`repeat-${name}`, () => {
      const def = readRepeat(root, name);
      const nowMs = this.now();
      const slot = def.meta.when ? `manual ${new Date(nowMs).toISOString()}` : localStamp(nowMs);
      return this.fireRepeat(root, def, slot, nowMs);
    });
  }

  /**
   * Creates a task for every repeat that is due, once each. opsd calls it every tick; `ops repeat
   * tick` does the same by hand. Any actor may: the repeats themselves were set by a person.
   */
  fireRepeats(): FiredRepeat[] {
    const fired: FiredRepeat[] = [];
    for (const root of this.scopedRoots()) {
      for (const name of listRepeatNames(root)) {
        try {
          const meta = root.lock(`repeat-${name}`, () => {
            let def: RepeatDef;
            try {
              def = readRepeat(root, name);
            } catch {
              return undefined;
            }
            if (def.meta.paused) return undefined;
            // A cheap check on live tasks and the cached archive first; the archive is read
            // again only when that says a slot is due.
            if (!this.viewRepeat(root, def, false).due) return undefined;
            const v = this.viewRepeat(root, def, true);
            if (!v.due || v.state !== 'active') return undefined;
            return this.fireRepeat(root, def, v.due, v.dueAt ?? this.now());
          });
          if (meta)
            fired.push({ root: root.name, repeat: name, task: meta.id, slot: meta.repeat_slot! });
        } catch {
          // A broken repeat file must not stop the others; `ops repeat list` shows its error.
        }
      }
    }
    return fired;
  }

  private fireRepeat(root: Root, def: RepeatDef, slot: string, slotMs: number): TaskMeta {
    const m = def.meta;
    assertNoSecret(m.title, def.body);
    const date = localStamp(slotMs).slice(0, 10);
    const title = m.title.replaceAll('{date}', date);
    const given = m.project?.trim();
    const parent = m.parent && root.hasTask(m.parent) ? m.parent : undefined;
    const project = given
      ? root.projectName(given)
      : parent
        ? root.namedProject(parent)
        : undefined;
    const label = m.when ? `condition ${m.when}` : `the ${slot.replace('T', ' ')} slot`;
    const note = `Created by repeat \`${m.name}\` for ${label}.`;
    const body = def.body ? `${def.body}\n\n${note}` : note;
    return root.createTask(
      {
        title,
        type: m.type ?? 'task',
        priority: m.priority ?? 'p2',
        owner: m.owner,
        project,
        parent,
        labels: m.labels && m.labels.length > 0 ? m.labels : undefined,
        repeat: m.name,
        repeat_slot: slot,
        created_by: m.created_by,
        created_at: new Date(this.now()).toISOString(),
      },
      body,
      this.user.id_block ?? 0,
    );
  }

  /** A repeat's state; `archive` reads the archive (and refreshes the cache) instead of the cache. */
  private viewRepeat(root: Root, def: RepeatDef, archive: boolean): RepeatView {
    const m = def.meta;
    const nowMs = this.now();
    const view: RepeatView = { ...def, root: root.name, rule: '', state: 'active', fired: 0 };
    try {
      validateRule(m);
      view.rule = describeRule(m);
    } catch (err) {
      return { ...view, state: 'broken', note: (err as Error).message };
    }
    const live: RepeatTask[] = root
      .states()
      .filter((s) => s.meta.repeat === m.name)
      .map((s) => ({
        id: s.meta.id,
        slot: String(s.meta.repeat_slot ?? ''),
        created_at: s.meta.created_at,
        status: s.status,
      }));
    const cache = readRepeatCache(root);
    let archived = cache[m.name] ?? [];
    if (archive) {
      archived = archivedRepeatTasks(root, m.name);
      if (JSON.stringify(archived) !== JSON.stringify(cache[m.name] ?? [])) {
        writeRepeatCache(root, { ...cache, [m.name]: archived });
      }
    }
    const byId = new Map<string, RepeatTask>();
    for (const t of [...archived, ...live]) byId.set(t.id, { ...byId.get(t.id), ...t });
    const tasks = [...byId.values()];
    view.fired = tasks.length;
    const last = tasks.sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
    )[tasks.length - 1];
    if (last) view.last = last;

    const finishedByCount = m.count !== undefined && view.fired >= m.count;
    let due: string | null = null;
    let dueAt: number | undefined;
    if (m.when) {
      const notBefore = m.start ? parseLocal(m.start) : -Infinity;
      if (nowMs >= notBefore && (!m.until || nowMs <= parseLocal(`${m.until} 23:59`) + 59_999)) {
        try {
          const key = this.conditionKey(parseCondition(m.when));
          if (key && !tasks.some((t) => t.slot === key)) {
            due = key;
            dueAt = nowMs;
          }
        } catch (err) {
          view.note = (err as Error).message;
        }
      }
    } else {
      const slot = latestSlot(m, nowMs);
      const lastSlot = tasks
        .map((t) => t.slot)
        .filter((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s))
        .sort()
        .pop();
      if (slot !== null && (!lastSlot || localStamp(slot) > lastSlot)) {
        due = localStamp(slot);
        dueAt = slot;
      }
      const next = nextSlot(m, nowMs);
      if (next !== null) view.next = localStamp(next);
    }
    const open = last?.status !== undefined && OPEN_STATUSES.has(last.status as Status);
    if (m.paused) view.state = 'paused';
    else if (finishedByCount || (!m.when && !due && !view.next)) view.state = 'finished';
    else if (due && open) {
      view.state = 'waiting';
      view.note = `${last!.id} from this repeat is still ${last!.status}; it fires once that closes`;
    }
    if (due && !finishedByCount) {
      view.due = due;
      if (dueAt !== undefined) view.dueAt = dueAt;
    }
    return view;
  }

  /** The key of a condition that holds now, or null. A new key fires the repeat again. */
  private conditionKey(c: Condition): string | null {
    const { root, id } = this.resolve(c.task);
    const closeEvent = (taskId: string): string | null => {
      if (OPEN_STATUSES.has(root.foldTask(taskId).status)) return null;
      const ev = root.readEvents(taskId).filter(closesTask).pop();
      return ev?.id ?? 'closed';
    };
    if (c.kind === 'closed') {
      const ev = closeEvent(id);
      return ev ? `closed ${id}@${ev}` : null;
    }
    const kids = root.states().filter((s) => s.meta.parent === id);
    if (kids.length === 0) return null;
    let newest = '';
    for (const k of kids) {
      const ev = closeEvent(k.meta.id);
      if (!ev) return null;
      if (ev > newest) newest = ev;
    }
    return `children-closed ${id}@${newest}`;
  }

  // ---- Inbox ---------------------------------------------------------------------------------

  /** What waits for the actor: unread messages, asks, reviews and, for humans, owned tasks. */
  inbox(actor = this.requireActor(), opts: { markRead?: boolean } = {}): InboxItem[] {
    const items: InboxItem[] = [];
    const human = isHuman(actor);
    const markers = new Map(this.roots.map((r) => [r.name, r.readMarker(actor)] as const));
    const newest = new Map<string, string>();
    // With several roots, ids can repeat across them: write root/id so each ref is unique.
    const qualify = this.roots.length > 1;
    const ref = (root: string, id: string): string => (qualify ? `${root}/${id}` : id);
    for (const v of this.allViews()) {
      const marker = markers.get(v.root) ?? '';
      const task = ref(v.root, v.meta.id);
      const root = v.root;
      const forMe = (who: string | null): boolean => (who ? ownerMatches(who, actor) : human);
      const waits = v.status === 'blocked' && v.blockedOn.length === 0 && forMe(v.waitingOn);
      // The ask or block that started the current wait shows once, as the ask item below.
      const question = waits ? v.addressed.find((a) => a.event === v.waitEvent) : undefined;
      // An untriaged finding is one triage item for every person, unless another person owns
      // it: triage comes first, so its question rides on the item and its review or ownership
      // shows once it is accepted. Accepting it in the Findings view or here clears it in both.
      const triage =
        human && untriaged(v) && (!v.owner || !isHuman(v.owner) || ownerMatches(v.owner, actor));
      for (const a of v.addressed) {
        if (!ownerMatches(a.to, actor)) continue;
        if (a.event > (newest.get(v.root) ?? '')) newest.set(v.root, a.event);
        // A question is never a message too: an open one is the ask item, an answered one is
        // handled. Listing it as a message left it behind after the answer.
        if (a.type === 'ask' || a.event === question?.event) continue;
        // The reader wrote it, so it is not news to them, even when it names them as recipient.
        if (a.actor === actor) continue;
        // A review request is the review item while open, and handled after the verdict: as a
        // message too, it said the same thing twice and stayed after the verdict.
        if (a.type === 'review') continue;
        if (a.event <= marker) continue;
        items.push({
          kind: 'message',
          task,
          root,
          title: v.meta.title,
          event: a.event,
          from: a.actor,
          type: a.type,
          summary: a.summary,
          ...(a.detail !== undefined ? { detail: a.detail } : {}),
        });
      }
      if (triage) {
        items.push({
          kind: 'triage',
          task,
          root,
          title: v.meta.title,
          from: v.meta.created_by,
          at: v.meta.created_at,
          summary: `finding to triage: ${v.meta.title}`,
          ...(v.owner ? { owner: v.owner } : {}),
          priority: v.meta.priority,
          ...(question
            ? {
                question: {
                  event: question.event,
                  from: question.actor,
                  summary: question.summary,
                  ...(question.detail !== undefined ? { detail: question.detail } : {}),
                },
              }
            : {}),
        });
        continue;
      }
      if (waits) {
        items.push({
          kind: 'ask',
          task,
          root,
          title: v.meta.title,
          event: question?.event ?? v.waitEvent ?? undefined,
          from: question?.actor,
          summary: question?.summary ?? 'waits for your answer',
          ...(question?.detail !== undefined ? { detail: question.detail } : {}),
        });
      }
      if (v.status === 'needs-review' && forMe(v.reviewer)) {
        // Say who asked for what, with the PR or commit, instead of a bare "waits for review".
        const req = v.lastReview;
        items.push({
          kind: 'review',
          task,
          root,
          title: v.meta.title,
          ...(req
            ? {
                event: req.event,
                from: req.actor,
                at: req.at,
                summary: summaryLine(req.body) || 'waits for your review',
                ...(detailText(req.body) !== undefined ? { detail: detailText(req.body) } : {}),
                ...reviewRefs(req.body),
              }
            : { summary: 'waits for your review' }),
        });
      }
      if (human && v.owner === actor && (v.status === 'todo' || v.status === 'in-progress')) {
        items.push({ kind: 'owned', task, root, title: v.meta.title, summary: v.status });
      }
    }
    // Work that waits on an id no agent answers to hangs silently; a person reassigns it.
    if (human) {
      for (const s of this.stranded()) {
        items.push({
          kind: 'stranded',
          task: ref(s.view.root, s.view.meta.id),
          root: s.view.root,
          title: s.view.meta.title,
          summary: `${s.reason}: reassign it, or add the agent`,
        });
      }
    }
    for (const r of this.roots) {
      const marker = markers.get(r.name) ?? '';
      for (const m of messagesSince(r, marker)) {
        if (m.actor === actor) continue;
        if (!(m.mentions ?? []).some((who) => ownerMatches(who, actor))) continue;
        if (m.id > (newest.get(r.name) ?? '')) newest.set(r.name, m.id);
        items.push({
          kind: 'mention',
          task: `#${m.channel}`,
          root: r.name,
          title: m.channel,
          event: m.id,
          from: m.actor,
          summary: m.body.split('\n')[0] ?? '',
          ...(detailText(m.body) !== undefined ? { detail: detailText(m.body) } : {}),
        });
      }
    }
    for (const d of this.decisions()) {
      const t = d.tally;
      const listed = (d.meta.voters ?? []).some((v) => ownerMatches(v, actor));
      const voted = d.ballots.some((b) => b.actor === actor);
      let summary: string | null = null;
      let kind: InboxItem['kind'] = 'vote';
      if (t.state === 'open' && listed && !voted) {
        summary = `vote: ${d.meta.question}`;
      } else if ((t.state === 'tie' || t.state === 'no-quorum') && human) {
        kind = 'decide';
        summary = `${t.state}, you decide: ${d.meta.question}`;
      } else if (t.state === 'ready' && d.meta.created_by === actor) {
        kind = 'decide';
        summary = `ready (${t.leaders[0]}): ${d.meta.question}`;
      }
      if (summary) {
        items.push({
          kind,
          task: ref(d.root, d.meta.id),
          root: d.root,
          title: d.meta.question,
          summary,
        });
      }
    }
    if (opts.markRead) {
      for (const r of this.roots) {
        const last = newest.get(r.name);
        if (last && last > (markers.get(r.name) ?? '')) r.writeMarker(actor, last);
      }
    }
    return items;
  }
}

/**
 * A question goes to one agent, or a group of agents such as `codex:*`, and never to a person:
 * an agent asks a person with `ops ask` on the task it works. It never goes to the asker, or to a
 * group the asker belongs to, or it would sit in the asker's own queue. Checked when the question
 * is filed and whenever its owner or type changes.
 */
function assertQuestionTo(owner: string | null | undefined, asker: string, actor: string): void {
  if (!owner) throw new OpsError('a question needs the agent it goes to: --to codex:qa', 2);
  if (isHuman(owner)) {
    throw new OpsError(
      `a question goes to an agent, not ${owner}: to ask a person, use ops ask on your task`,
      2,
    );
  }
  if (ownerMatches(owner, asker)) {
    const who = asker === actor ? 'you' : `the one who asked (${asker})`;
    const group = owner === asker ? '' : `: ${owner} includes ${asker}`;
    throw new OpsError(`a question goes to another agent than ${who}${group}`, 2);
  }
}

function archivable(status: Status, updatedAt: string, cutoff: number): boolean {
  return (status === 'done' || status === 'parked') && Date.parse(updatedAt) <= cutoff;
}

/**
 * The actor holds the claim when it is theirs and, for claims with a token, when this clone made
 * it: the same agent id on another clone is a different run.
 */
/**
 * True when this actor in this clone holds the task's claim. A caller with a run (`OPS_RUN`) holds
 * it only if the claim record names that run: two live runs with one agent id on one PC are two
 * holders, and a claim recorded without a run belongs to no run until opsd binds it. Callers
 * without a run (a person acting as the agent, opsd itself) are not checked for one.
 */
function holds(root: Root, v: TaskView, actor: string, run: string | null): boolean {
  if (v.claimedBy !== actor) return false;
  if (!v.claimToken) return !run;
  const rec = root.claimRecord(v.meta.id);
  if (rec.token !== v.claimToken) return false;
  return !run || rec.run === run;
}

/** Permission and state checks for one write, collected so `--force` can be recorded. */
class ActCtx {
  forced = false;
  readonly privileged: boolean;

  constructor(
    /** Warnings for the caller, such as a wildcard owner that matches no agent. */
    readonly warnings: string[],
    readonly actor: string,
    private readonly force: boolean,
    private readonly v: TaskView,
    readonly human: string | undefined,
    readonly holds: boolean,
  ) {
    this.privileged = isHuman(actor) || isOrchestrator(actor);
  }

  /** Passes for humans and the orchestrator; with --force, passes and marks the event. */
  needPrivilege(reason: string): void {
    if (this.privileged) return;
    if (this.force) {
      this.forced = true;
      return;
    }
    throw new OpsError(`${reason} (use --force to override)`);
  }

  /** A rule that binds everyone, humans included; only --force passes, and the event says so. */
  needForce(reason: string): void {
    if (this.force) {
      this.forced = true;
      return;
    }
    throw new OpsError(`${reason} (use --force to override)`);
  }

  needHolder(): void {
    if (this.v.claimedBy === this.actor) {
      this.needPrivilege(
        `${this.v.meta.id} is held by ${this.actor} under another claim: another run on this ` +
          'PC, or a claim from another clone that won',
      );
      return;
    }
    this.needPrivilege(
      `${this.v.meta.id} is held by ${this.v.claimedBy ?? 'nobody'}; claim it first`,
    );
  }

  /**
   * The holder may act, and so may the owner. A wildcard owner (`claude:*`, `*:engineer`) names
   * who may claim, not who owns the work: once another agent holds the task, only the holder acts.
   */
  needOwnerOrHolder(): void {
    if (this.holds) return;
    const owner = this.v.owner;
    if (owner && ownerMatches(owner, this.actor) && (!isWildcard(owner) || !this.v.claimedBy)) {
      return;
    }
    this.needPrivilege(
      `${this.v.meta.id} is owned by ${this.v.owner ?? 'nobody'}` +
        (this.v.claimedBy ? ` and held by ${this.v.claimedBy}` : ''),
    );
  }

  requireStatus(allowed: Status[], verb: string): void {
    if (!allowed.includes(this.v.status)) this.wrongState(verb);
  }

  requireOpen(verb: string): void {
    if (!OPEN_STATUSES.has(this.v.status)) this.wrongState(verb);
  }

  wrongState(verb: string): never {
    throw new OpsError(`cannot ${verb} ${this.v.meta.id}: it is ${this.v.status}`);
  }
}
