import type { OpsEvent, Status, TaskMeta, TaskState, TaskView } from './model.js';
import { OPEN_STATUSES } from './model.js';
import { ulidTime } from './ulid.js';

const DEFAULT_CLAIM_MS = 60 * 60_000;
const DEFAULT_WORK_MS = 240 * 60_000;
const SUMMARY_LEN = 160;
/** A review request keeps its full text up to this length, for the reviewer's inbox. */
const REVIEW_LEN = 4000;

/** The first line of an event body, cut to fit one inbox or list line. */
export function summaryLine(body: string): string {
  const line = body.trim().split('\n')[0] ?? '';
  return line.length > SUMMARY_LEN ? `${line.slice(0, SUMMARY_LEN - 1)}…` : line;
}

function eventTime(e: OpsEvent): number {
  return Date.parse(e.at) || ulidTime(e.id);
}

function leaseFrom(e: OpsEvent, fallbackMs: number): string {
  return e.lease_until ?? new Date(eventTime(e) + fallbackMs).toISOString();
}

function leaseLive(state: TaskState, atMs: number): boolean {
  return state.leaseUntil !== null && Date.parse(state.leaseUntil) > atMs;
}

/**
 * Folds a task's events into its current state. Events apply in id (ULID) order, which every
 * machine computes the same way, so all machines agree on the result after a sync.
 *
 * The fold records what happened; permission checks live in the write path. The one rule it
 * enforces is the claim race: a claim stands only when the task is free at that point, and a
 * start or release applies only while the holder it was written under still holds the claim.
 * Sync renames unpushed events after the ones that came from the remote, so this order is the
 * push order across machines.
 */
export function fold(meta: TaskMeta, events: OpsEvent[]): TaskState {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const s: TaskState = {
    meta,
    status: 'todo',
    owner: meta.owner || null,
    claimedBy: null,
    claimToken: null,
    leaseUntil: null,
    reviewer: null,
    waitingOn: null,
    waitEvent: null,
    blockedOn: [],
    askedBy: null,
    checkpoint: null,
    lastEvent: null,
    updatedAt: meta.created_at,
    eventCount: sorted.length,
    addressed: [],
    lastReview: null,
    lostClaims: [],
    delegation: null,
  };
  if (meta.blocked_by && meta.blocked_by.length > 0) {
    s.status = 'blocked';
    s.blockedOn = [...meta.blocked_by];
  }

  const clearClaim = (): void => {
    s.claimedBy = null;
    s.claimToken = null;
    s.leaseUntil = null;
  };
  // Whether an event written under a claim still belongs to the standing claim.
  const underStandingClaim = (e: OpsEvent): boolean =>
    e.holder === undefined || e.holder === s.claimToken;
  const clearWait = (): void => {
    s.waitingOn = null;
    s.waitEvent = null;
    s.blockedOn = [];
    s.askedBy = null;
  };

  for (const e of sorted) {
    const at = eventTime(e);
    s.lastEvent = e.id;
    s.updatedAt = e.at;
    if (e.to) {
      s.addressed.push({
        event: e.id,
        type: e.type,
        actor: e.actor,
        to: e.to,
        summary: summaryLine(e.body),
      });
    }
    switch (e.type) {
      case 'claim': {
        const free =
          s.status === 'todo' || (s.status === 'claimed' && !leaseLive(s, at) && s.claimedBy);
        const expiredWork = s.status === 'in-progress' && !leaseLive(s, at);
        if (free || expiredWork) {
          s.status = 'claimed';
          s.claimedBy = e.actor;
          s.claimToken = e.token ?? null;
          s.leaseUntil = leaseFrom(e, DEFAULT_CLAIM_MS);
        } else {
          s.lostClaims.push(e.id);
        }
        break;
      }
      case 'start':
        if (!underStandingClaim(e) && !e.forced) {
          s.lostClaims.push(e.id);
          break;
        }
        s.status = 'in-progress';
        s.claimedBy = s.claimedBy ?? e.actor;
        s.leaseUntil = leaseFrom(e, DEFAULT_WORK_MS);
        break;
      case 'progress':
      case 'renew':
        if (s.claimedBy === e.actor && underStandingClaim(e)) {
          s.leaseUntil = leaseFrom(e, DEFAULT_WORK_MS);
        }
        break;
      case 'checkpoint':
        s.checkpoint = { summary: e.body.trim(), next: e.next, at: e.at };
        if (s.claimedBy === e.actor && underStandingClaim(e)) {
          s.leaseUntil = leaseFrom(e, DEFAULT_WORK_MS);
        }
        break;
      case 'release':
        if (!underStandingClaim(e) && !e.forced) {
          s.lostClaims.push(e.id);
          break;
        }
        s.status = 'todo';
        clearClaim();
        break;
      case 'handoff':
      case 'assign':
        if (e.to) s.owner = e.to;
        if (e.type === 'assign' && e.keep_wait && s.status === 'blocked') {
          // The task changes hands but still waits: the question stays open for its addressee.
          clearClaim();
          s.reviewer = null;
          break;
        }
        if (OPEN_STATUSES.has(s.status)) s.status = 'todo';
        clearClaim();
        clearWait();
        s.reviewer = null;
        break;
      case 'delegate':
        if (e.to) s.owner = e.to;
        if (OPEN_STATUSES.has(s.status)) s.status = 'todo';
        clearClaim();
        clearWait();
        s.reviewer = null;
        s.delegation = {
          by: e.actor,
          to: e.to ?? '',
          at: e.at,
          budget_minutes: e.budget_minutes,
          tokens: e.tokens,
          due: e.due,
          review: e.review,
        };
        break;
      case 'review':
        s.status = 'needs-review';
        s.reviewer = e.to ?? null;
        s.lastReview = {
          event: e.id,
          actor: e.actor,
          at: e.at,
          body: e.body.trim().slice(0, REVIEW_LEN),
        };
        clearClaim();
        break;
      case 'verdict':
        s.status = e.verdict === 'approve' ? 'done' : 'todo';
        s.reviewer = null;
        clearClaim();
        break;
      case 'done':
        s.status = 'done';
        clearClaim();
        clearWait();
        break;
      case 'park':
        s.status = 'parked';
        clearClaim();
        clearWait();
        break;
      case 'reopen':
        s.status = 'todo';
        clearClaim();
        clearWait();
        break;
      case 'ask':
        s.status = 'blocked';
        s.askedBy = e.actor;
        s.waitingOn = e.to ?? null;
        s.waitEvent = e.id;
        s.blockedOn = [];
        clearClaim();
        break;
      case 'block':
        s.status = 'blocked';
        s.askedBy = e.actor;
        s.waitEvent = e.id;
        if (e.on && e.on.length > 0) {
          s.blockedOn = [...e.on];
          s.waitingOn = null;
        } else {
          s.waitingOn = e.to ?? null;
          s.blockedOn = [];
        }
        clearClaim();
        break;
      case 'answer':
      case 'unblock':
        if (s.status === 'blocked') s.status = 'todo';
        clearWait();
        break;
      case 'priority':
        if (e.priority) s.meta = { ...s.meta, priority: e.priority };
        break;
      case 'retype':
        if (e.task_type) s.meta = { ...s.meta, type: e.task_type };
        break;
      default:
        break;
    }
  }
  return s;
}

/** Applies the rules that need the clock or other tasks: expired leases and finished dependencies. */
export function derive(
  state: TaskState,
  root: string,
  nowMs: number,
  statusOf: (id: string) => Status | undefined,
): TaskView {
  const view: TaskView = { ...state, root, stale: false, unblocked: false };
  if (
    (state.status === 'claimed' || state.status === 'in-progress') &&
    state.leaseUntil &&
    Date.parse(state.leaseUntil) <= nowMs
  ) {
    view.stale = true;
  }
  if (state.status === 'blocked' && state.blockedOn.length > 0) {
    const allClosed = state.blockedOn.every((id) => {
      const st = statusOf(id);
      return st === 'done' || st === 'parked';
    });
    if (allClosed) view.unblocked = true;
  }
  return view;
}

/** True when anyone allowed to own the task may claim it now. */
export function isClaimable(v: TaskView): boolean {
  return v.status === 'todo' || v.stale || v.unblocked;
}
