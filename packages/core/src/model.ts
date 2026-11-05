export const STATUSES = [
  'todo',
  'claimed',
  'in-progress',
  'blocked',
  'needs-review',
  'done',
  'parked',
] as const;
export type Status = (typeof STATUSES)[number];

export const OPEN_STATUSES: ReadonlySet<Status> = new Set([
  'todo',
  'claimed',
  'in-progress',
  'blocked',
  'needs-review',
]);

export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Event types. The fold acts on the ones that change state; the rest (comment, finding, learn,
 * run-start, run-end, merge) are history. Unknown types from newer versions are kept and ignored.
 */
export const EVENT_TYPES = [
  'claim',
  'start',
  'progress',
  'checkpoint',
  'comment',
  'handoff',
  'assign',
  'review',
  'verdict',
  'done',
  'ask',
  'answer',
  'block',
  'unblock',
  'release',
  'priority',
  'park',
  'reopen',
  'finding',
  'learn',
  'run-start',
  'run-end',
  'delegate',
  'renew',
  'retype',
  'merge',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Frontmatter of `tasks/<id>/task.md`. */
export interface TaskMeta {
  id: string;
  title: string;
  type: string;
  priority: Priority;
  /** Initial owner: an actor id, a runtime wildcard (`codex:*`), or empty for anyone. */
  owner?: string;
  project?: string;
  parent?: string;
  labels?: string[];
  /** Tasks that must be done before this one can start. */
  blocked_by?: string[];
  /** The repeat (`repeats/<name>.md`) that created this task. */
  repeat?: string;
  /** The slot the repeat fired for: local time `YYYY-MM-DDTHH:MM`, or a condition key. */
  repeat_slot?: string;
  created_by: string;
  created_at: string;
}

/** Frontmatter of `tasks/<id>/events/<ulid>-<actor>.md`, plus the id from the file name. */
export interface OpsEvent {
  id: string;
  type: EventType | string;
  actor: string;
  at: string;
  to?: string;
  /** block: the tasks this one waits on. */
  on?: string[];
  /** verdict: approve or changes. */
  verdict?: 'approve' | 'changes';
  /** priority: the new priority. */
  priority?: Priority;
  /** retype: the new task type, such as `task`, `bug` or `idea`. */
  task_type?: string;
  /**
   * assign: keep a blocked task's wait (its open question or the tasks it waits on) under the new
   * owner. `ops assign` and triage without an answer write it whenever the task is blocked. Without
   * it (older events), assign clears the wait.
   */
  keep_wait?: boolean;
  /** claim, start, progress, checkpoint: when the claim expires unless renewed. */
  lease_until?: string;
  /** checkpoint: the next step for whoever resumes. */
  next?: string;
  /** Set when the actor used --force to skip the ownership check. */
  forced?: boolean;
  /** claim: a random id for this claim, so two runs with the same agent id stay apart. */
  token?: string;
  /**
   * start, progress, renew, checkpoint, release: the token of the claim the writer held. The event
   * applies only while that claim stands, so a run that lost a claim race (even one with the same
   * agent id on another machine) cannot start, renew or release the winner's claim. Events
   * without it follow the older rules.
   */
  holder?: string;
  /** delegate: time budget in minutes. */
  budget_minutes?: number;
  /** delegate: token budget. */
  tokens?: number;
  /** delegate: when the work is due (ISO). */
  due?: string;
  /** delegate: the reviewer the delegator expects. */
  review?: string;
  /** finding: the task the finding was filed as. learn: the note, as `<topic>/<slug>`. */
  ref?: string;
  /** run-start, run-end, renew: the supervisor's run id. */
  run?: string;
  /** run-end: the exit code, or null when the process was killed or lost. */
  exit?: number | null;
  /** run-end: why the run ended, such as `exit`, `budget`, `tokens`, `killed` or `lost`. */
  reason?: string;
  /** run-end: minutes the run took. */
  minutes?: number;
  /** merge: the commit the base branch moved to. */
  commit?: string;
  /** merge: the branch the work came from. */
  branch?: string;
  /** merge: the base branch it went into. */
  into?: string;
  body: string;
}

/** An event addressed to someone, kept in the index so inboxes need no event reads. */
export interface Addressed {
  event: string;
  type: string;
  actor: string;
  to: string;
  summary: string;
}

export interface ReviewRequest {
  event: string;
  actor: string;
  at: string;
  body: string;
}

/** Limits recorded by `ops delegate`; they stay with the task until the next delegation. */
export interface Delegation {
  by: string;
  to: string;
  at: string;
  budget_minutes?: number;
  tokens?: number;
  due?: string;
  review?: string;
}

/** Task state folded from task.md and its events. */
export interface TaskState {
  meta: TaskMeta;
  status: Status;
  owner: string | null;
  claimedBy: string | null;
  /** The token of the standing claim, when the claim carried one. */
  claimToken: string | null;
  leaseUntil: string | null;
  reviewer: string | null;
  /** blocked: the actor whose answer the task waits for. */
  waitingOn: string | null;
  /** blocked: the ask or block event that started the current wait. */
  waitEvent: string | null;
  /** blocked: the tasks this one waits on. */
  blockedOn: string[];
  /** blocked: who asked or blocked, so the answer goes back to them. */
  askedBy: string | null;
  checkpoint: { summary: string; next?: string; at: string } | null;
  lastEvent: string | null;
  updatedAt: string;
  eventCount: number;
  addressed: Addressed[];
  /** The latest review request: who asked, when, and its full text. */
  lastReview: ReviewRequest | null;
  /**
   * Claims that lost a race, and starts or releases written under a claim that had lost, by event
   * id. None of them changed the state.
   */
  lostClaims: string[];
  delegation: Delegation | null;
}

/** Task state after rules that need the clock or other tasks: leases and dependencies. */
export interface TaskView extends TaskState {
  root: string;
  /** The claim's lease ran out; the task is claimable again. */
  stale: boolean;
  /** Every task this one waited on is closed; the task is claimable again. */
  unblocked: boolean;
  /** The task folder is under `archive/tasks/`. */
  archived?: boolean;
}
