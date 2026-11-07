// The replay timeline (AO-0075): what happened in a root or a project, in time order, built from
// task events and decisions. It is the data layer the replay scenes read: lanes per agent, work
// spans, review rounds, waits, runs, decisions, learn notes, creates and closes, plus totals for the stat
// cards and a time map that squeezes idle stretches so a night without events takes seconds of
// playback, not half the clip.

import type { Decision } from './decisions.js';
import { fold, summaryLine } from './fold.js';
import { isHuman, runtimeOf } from './ids.js';
import type { OpsEvent, TaskMeta, TaskState } from './model.js';
import { ulidTime } from './ulid.js';

/** One task as the timeline reads it. */
export interface TimelineTask {
  root: string;
  meta: TaskMeta;
  events: OpsEvent[];
}

/** One stretch of time an agent held a task: claim (or start) to the event that let it go. */
export interface WorkSpan {
  root: string;
  task: string;
  title: string;
  agent: string;
  start: string;
  /** Null while the agent still holds the task at the end of the window. */
  end: string | null;
  /** The event type that ended the hold, `expired` when the lease ran out, or `open`. */
  endedBy: string;
}

/** A review request and its verdict. */
export interface ReviewRound {
  root: string;
  task: string;
  title: string;
  /** 1 for the first review of the task, 2 for the next, and so on. */
  round: number;
  author: string;
  /** Null when the review went to the human queue without a named reviewer. */
  reviewer: string | null;
  start: string;
  end: string | null;
  /** Who gave the verdict, when one closed the round. */
  decidedBy?: string;
  verdict?: 'approve' | 'changes';
  /** `verdict`, another event type that took the task out of review, or `open`. */
  endedBy: string;
}

/** A task waiting: an ask for an answer, or a block on someone or on other tasks. */
export interface Wait {
  root: string;
  task: string;
  title: string;
  kind: 'ask' | 'block';
  /** Who asked or blocked. */
  actor: string;
  /** Whose answer the task waits for, when it waits for someone. */
  waitingOn: string | null;
  /** The tasks it waits on, for a block on tasks. */
  on: string[];
  /** The wait is on a human. */
  human: boolean;
  start: string;
  end: string | null;
  /** True when an answer ended the wait. */
  answered: boolean;
  /** The event type that ended the wait, or `open`. */
  endedBy: string;
}

/** A supervised run, from run-start to run-end. */
export interface RunSpan {
  root: string;
  task: string;
  agent: string;
  run: string;
  start: string;
  end: string | null;
  tokens?: number;
  exit?: number | null;
  reason?: string;
}

export interface TimelineDecision {
  root: string;
  id: string;
  question: string;
  task?: string;
  proposedBy: string;
  start: string;
  /** When the outcome was recorded; null while undecided. */
  end: string | null;
  choice?: string;
  decidedBy?: string;
  ballots: Array<{ actor: string; at: string; choice: string }>;
}

/** A learn note written from a task. */
export interface TimelineNote {
  root: string;
  task: string;
  agent: string;
  at: string;
  /** The note as `<topic>/<slug>`. */
  ref?: string;
  title: string;
}

/** A task being created. */
export interface TimelineCreate {
  root: string;
  task: string;
  title: string;
  at: string;
  by: string;
}

/** A task reaching `done`. */
export interface TimelineClose {
  root: string;
  task: string;
  title: string;
  at: string;
  by: string;
  /** `done`, or `verdict` for an approval. */
  via: string;
}

/** One row of the replay: an agent, a human, or a system actor such as `opsd:merge`. */
export interface TimelineLane {
  agent: string;
  kind: 'agent' | 'human' | 'system';
  /** The first time the actor shows on the timeline. */
  first: string;
  /** Time holding tasks and time in runs, in ms, clipped to the window. */
  workMs: number;
  runMs: number;
  tokens: number;
  /** Tasks the actor held at least once. */
  tasks: number;
  /** Review rounds the actor decided. */
  reviews: number;
}

export interface TimelineTotals {
  /** Hours agents spent in supervised runs. */
  agentHours: number;
  /** Hours agents held tasks (claim to release), which includes interactive sessions. */
  workHours: number;
  /**
   * An estimate of the minutes humans spent acting: their events grouped into sessions (events
   * at most `HUMAN_GAP_MS` apart), each counted from its first to its last event plus
   * `HUMAN_EVENT_MS`. The store records actions, not attention, so this is a floor.
   */
  humanMinutes: number;
  /** Minutes tasks waited on a human, clipped to the window. */
  humanWaitMinutes: number;
  asksAnswered: number;
  reviewRounds: number;
  tasksClosed: number;
  runs: number;
  tokens: number;
}

/** A piece of the real-to-playback map. Times are ms: real ones since the epoch, playback ones from 0. */
export interface TimeSegment {
  start: number;
  end: number;
  playStart: number;
  playEnd: number;
  /** A gap longer than `maxGapMs`, squeezed to `maxGapMs` before scaling. */
  idle: boolean;
}

export interface TimeMap {
  segments: TimeSegment[];
  /** Playback length in ms: `clipMs` when given, else the squeezed real length. */
  playbackMs: number;
  maxGapMs: number;
}

export interface Timeline {
  from: string | null;
  to: string;
  lanes: TimelineLane[];
  spans: WorkSpan[];
  reviews: ReviewRound[];
  waits: Wait[];
  runs: RunSpan[];
  decisions: TimelineDecision[];
  notes: TimelineNote[];
  created: TimelineCreate[];
  closes: TimelineClose[];
  totals: TimelineTotals;
  time: TimeMap;
}

export interface TimelineOptions {
  /** Window start (ms). Items that end before it are left out. Omitted: from the first event. */
  from?: number;
  /** Window end (ms), normally now. Items that start at or after it are left out. */
  to: number;
  /** Gaps between events longer than this play as this long. Default 30 minutes. */
  maxGapMs?: number;
  /** Scale playback to this length in ms. Omitted: the squeezed real length. */
  clipMs?: number;
}

const HUMAN_GAP_MS = 10 * 60_000;
const HUMAN_EVENT_MS = 2 * 60_000;
const DEFAULT_MAX_GAP_MS = 30 * 60_000;

function timeOf(e: OpsEvent): number {
  return Date.parse(e.at) || ulidTime(e.id);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function laneKind(actor: string): TimelineLane['kind'] {
  if (isHuman(actor)) return 'human';
  return runtimeOf(actor) === 'opsd' ? 'system' : 'agent';
}

/** Everything one task adds to the timeline, before the window is applied. */
interface TaskParts {
  spans: WorkSpan[];
  reviews: ReviewRound[];
  waits: Wait[];
  runs: RunSpan[];
  notes: TimelineNote[];
  closes: TimelineClose[];
}

/**
 * Replays a task's events through `fold` one at a time and records each change of holder, wait,
 * review and status. Folding every prefix costs O(n²) per task, which is small for task-sized
 * event lists, and keeps the claim race, lease and wait rules exactly as `fold` applies them.
 */
function taskParts(t: TimelineTask, toMs: number): TaskParts {
  const { root, meta } = t;
  const task = meta.id;
  const title = meta.title;
  const events = [...t.events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: TaskParts = { spans: [], reviews: [], waits: [], runs: [], notes: [], closes: [] };
  let prev: TaskState = fold(meta, []);
  let span: WorkSpan | null = null;
  let review: ReviewRound | null = null;
  let wait: Wait | null = null;
  let rounds = 0;
  const runs = new Map<string, RunSpan>();

  const endSpan = (at: string, endedBy: string): void => {
    if (!span) return;
    span.end = at;
    span.endedBy = endedBy;
    span = null;
  };
  const endReview = (at: string, endedBy: string): void => {
    if (!review) return;
    review.end = at;
    review.endedBy = endedBy;
    review = null;
  };
  const endWait = (at: string, endedBy: string): void => {
    if (!wait) return;
    wait.end = at;
    wait.endedBy = endedBy;
    wait.answered = endedBy === 'answer';
    wait = null;
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const next = fold(meta, events.slice(0, i + 1));
    const at = e.at || iso(timeOf(e));

    // Holder: a span runs while the same claim stands.
    if (prev.claimedBy !== next.claimedBy || prev.claimToken !== next.claimToken) {
      if (span) {
        // A claim cleared after its lease ran out (a new claim, assign, handoff, review, done,
        // release and so on) ended when the lease did, not at the event that cleared it.
        const lease = prev.leaseUntil ? Date.parse(prev.leaseUntil) : NaN;
        const expired = lease <= timeOf(e);
        endSpan(expired ? iso(lease) : at, expired ? 'expired' : e.type);
      }
      if (next.claimedBy) {
        span = { root, task, title, agent: next.claimedBy, start: at, end: null, endedBy: 'open' };
        out.spans.push(span);
      }
    }

    // Review rounds: a review event opens one; a verdict or leaving review closes it.
    if (e.type === 'review') {
      endReview(at, 'review');
      rounds++;
      review = {
        root,
        task,
        title,
        round: rounds,
        author: e.actor,
        reviewer: e.to ?? null,
        start: at,
        end: null,
        endedBy: 'open',
      };
      out.reviews.push(review);
    } else if (e.type === 'verdict' && review) {
      const r: ReviewRound = review;
      if (e.verdict) r.verdict = e.verdict;
      r.decidedBy = e.actor;
      endReview(at, 'verdict');
    } else if (review && next.status !== 'needs-review') {
      endReview(at, e.type);
    }

    // Waits follow the fold's wait event: a new one replaces the old, none ends it.
    if (prev.waitEvent !== next.waitEvent) {
      endWait(at, e.type);
      if (next.waitEvent === e.id && (e.type === 'ask' || e.type === 'block')) {
        const waitingOn = next.waitingOn;
        wait = {
          root,
          task,
          title,
          kind: e.type,
          actor: e.actor,
          waitingOn,
          on: [...next.blockedOn],
          human: waitingOn !== null && isHuman(waitingOn),
          start: at,
          end: null,
          answered: false,
          endedBy: 'open',
        };
        out.waits.push(wait);
      }
    }

    if (prev.status !== 'done' && next.status === 'done') {
      out.closes.push({ root, task, title, at, by: e.actor, via: e.type });
    }

    if (e.type === 'run-start' && e.run) {
      const r: RunSpan = { root, task, agent: e.actor, run: e.run, start: at, end: null };
      runs.set(e.run, r);
      out.runs.push(r);
    } else if (e.type === 'run-end' && e.run) {
      let r = runs.get(e.run);
      if (!r) {
        // The start is missing (older store or a lost event): place it from the minutes.
        const startMs = timeOf(e) - (e.minutes ?? 0) * 60_000;
        r = { root, task, agent: e.actor, run: e.run, start: iso(startMs), end: null };
        out.runs.push(r);
      }
      r.end = at;
      if (typeof e.tokens === 'number') r.tokens = e.tokens;
      if (e.exit !== undefined) r.exit = e.exit;
      if (e.reason) r.reason = e.reason;
      runs.delete(e.run);
    }

    if (e.type === 'learn') {
      out.notes.push({
        root,
        task,
        agent: e.actor,
        at,
        ...(e.ref ? { ref: e.ref } : {}),
        title: summaryLine(e.body),
      });
    }
    prev = next;
  }

  // A claim whose lease ran out before the window ended is over, even with no event saying so.
  const s = span as WorkSpan | null;
  if (s && prev.leaseUntil && Date.parse(prev.leaseUntil) <= toMs) {
    s.end = prev.leaseUntil;
    s.endedBy = 'expired';
  }
  return out;
}

/** Time in ms that [start, end) overlaps the window; an open end counts to the window end. */
function clipped(start: string, end: string | null, fromMs: number, toMs: number): number {
  const a = Math.max(Date.parse(start), fromMs);
  const b = Math.min(end ? Date.parse(end) : toMs, toMs);
  return Math.max(0, b - a);
}

function overlaps(start: string, end: string | null, fromMs: number, toMs: number): boolean {
  const a = Date.parse(start);
  const b = end ? Date.parse(end) : toMs;
  return a < toMs && b >= fromMs;
}

function within(at: string, fromMs: number, toMs: number): boolean {
  const t = Date.parse(at);
  return t >= fromMs && t < toMs;
}

const byStart = <T extends { start: string }>(a: T, b: T): number =>
  a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
const byAt = <T extends { at: string }>(a: T, b: T): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : 0;

/** Minutes of human activity, estimated from the times humans acted (see `humanMinutes`). */
export function humanSessionMinutes(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let total = 0;
  let first = NaN;
  let last = NaN;
  for (const t of sorted) {
    if (Number.isNaN(last) || t - last > HUMAN_GAP_MS) {
      if (!Number.isNaN(first)) total += last - first + HUMAN_EVENT_MS;
      first = t;
    }
    last = t;
  }
  if (!Number.isNaN(first)) total += last - first + HUMAN_EVENT_MS;
  return Math.round(total / 60_000);
}

/**
 * Maps real time to playback time. Between consecutive points, a gap longer than `maxGapMs`
 * plays as `maxGapMs`; shorter gaps play at real speed. With `clipMs`, the result is scaled to
 * that length. Points are ms since the epoch, in any order.
 */
export function timeMap(
  points: number[],
  opts: { maxGapMs?: number; clipMs?: number } = {},
): TimeMap {
  const maxGapMs = opts.maxGapMs && opts.maxGapMs > 0 ? opts.maxGapMs : DEFAULT_MAX_GAP_MS;
  const sorted = [...new Set(points.filter(Number.isFinite))].sort((a, b) => a - b);
  const segments: TimeSegment[] = [];
  let play = 0;
  for (let i = 1; i < sorted.length; i++) {
    const start = sorted[i - 1]!;
    const end = sorted[i]!;
    const idle = end - start > maxGapMs;
    const len = idle ? maxGapMs : end - start;
    segments.push({ start, end, playStart: play, playEnd: play + len, idle });
    play += len;
  }
  if (opts.clipMs && opts.clipMs > 0 && play > 0) {
    const k = opts.clipMs / play;
    for (const s of segments) {
      s.playStart *= k;
      s.playEnd *= k;
    }
    play = opts.clipMs;
  }
  return { segments, playbackMs: play, maxGapMs };
}

/** The playback time of real time `ms`, clamped to the map's ends. */
export function playbackAt(map: TimeMap, ms: number): number {
  const segs = map.segments;
  if (segs.length === 0) return 0;
  if (ms <= segs[0]!.start) return 0;
  // Binary search for the segment that holds `ms`.
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.end < ms) lo = mid + 1;
    else hi = mid;
  }
  const s = segs[lo]!;
  if (ms >= s.end) return s.playEnd;
  return s.playStart + ((ms - s.start) / (s.end - s.start)) * (s.playEnd - s.playStart);
}

/**
 * Builds the timeline of `tasks` and `decisions` for the window in `opts`. Items keep their real
 * start and end; those that overlap the window are kept. Totals count only time and events
 * inside the window.
 */
export function buildTimeline(
  tasks: TimelineTask[],
  decisions: Decision[],
  opts: TimelineOptions,
): Timeline {
  const toMs = opts.to;
  const fromMs = opts.from ?? -Infinity;
  const all: TaskParts = { spans: [], reviews: [], waits: [], runs: [], notes: [], closes: [] };
  const humanTimes: number[] = [];
  const created: TimelineCreate[] = [];
  for (const t of tasks) {
    const { meta } = t;
    if (within(meta.created_at, fromMs, toMs)) {
      created.push({
        root: t.root,
        task: meta.id,
        title: meta.title,
        at: meta.created_at,
        by: meta.created_by,
      });
    }
    const parts = taskParts(t, toMs);
    for (const k of Object.keys(all) as Array<keyof TaskParts>) {
      (all[k] as unknown[]).push(...parts[k]);
    }
    if (isHuman(t.meta.created_by)) humanTimes.push(Date.parse(t.meta.created_at));
    for (const e of t.events) if (isHuman(e.actor)) humanTimes.push(timeOf(e));
  }

  const spans = all.spans.filter((s) => overlaps(s.start, s.end, fromMs, toMs)).sort(byStart);
  const reviews = all.reviews.filter((r) => overlaps(r.start, r.end, fromMs, toMs)).sort(byStart);
  const waits = all.waits.filter((w) => overlaps(w.start, w.end, fromMs, toMs)).sort(byStart);
  const runs = all.runs.filter((r) => overlaps(r.start, r.end, fromMs, toMs)).sort(byStart);
  const notes = all.notes.filter((n) => within(n.at, fromMs, toMs)).sort(byAt);
  const closes = all.closes.filter((c) => within(c.at, fromMs, toMs)).sort(byAt);
  created.sort(byAt);

  const outDecisions: TimelineDecision[] = [];
  for (const d of decisions) {
    const end = d.outcome?.at ?? null;
    if (!overlaps(d.meta.created_at, end, fromMs, toMs)) continue;
    outDecisions.push({
      root: d.root,
      id: d.meta.id,
      question: d.meta.question,
      ...(d.meta.task ? { task: d.meta.task } : {}),
      proposedBy: d.meta.created_by,
      start: d.meta.created_at,
      end,
      ...(d.outcome ? { choice: d.outcome.choice, decidedBy: d.outcome.decided_by } : {}),
      ballots: d.ballots.map((b) => ({ actor: b.actor, at: b.at, choice: b.choice })),
    });
    if (isHuman(d.meta.created_by)) humanTimes.push(Date.parse(d.meta.created_at));
    for (const b of d.ballots) if (isHuman(b.actor)) humanTimes.push(Date.parse(b.at));
    if (d.outcome && isHuman(d.outcome.decided_by)) humanTimes.push(Date.parse(d.outcome.at));
  }
  outDecisions.sort(byStart);

  // Lanes: everyone who acts on the timeline, in order of first appearance.
  const lanes = new Map<string, TimelineLane & { held: Set<string> }>();
  const lane = (agent: string, at: string): TimelineLane & { held: Set<string> } => {
    let l = lanes.get(agent);
    if (!l) {
      l = {
        agent,
        kind: laneKind(agent),
        first: at,
        workMs: 0,
        runMs: 0,
        tokens: 0,
        tasks: 0,
        reviews: 0,
        held: new Set(),
      };
      lanes.set(agent, l);
    }
    const shown = Date.parse(at) < fromMs ? iso(fromMs) : at;
    if (shown < l.first) l.first = shown;
    return l;
  };
  for (const s of spans) {
    const l = lane(s.agent, s.start);
    l.workMs += clipped(s.start, s.end, fromMs, toMs);
    l.held.add(`${s.root}/${s.task}`);
  }
  for (const r of runs) {
    const l = lane(r.agent, r.start);
    l.runMs += clipped(r.start, r.end, fromMs, toMs);
    if (r.tokens && r.end && within(r.end, fromMs, toMs)) l.tokens += r.tokens;
  }
  for (const r of reviews) {
    lane(r.author, r.start);
    if (r.reviewer) lane(r.reviewer, r.start);
    if (r.decidedBy && r.end) lane(r.decidedBy, r.end).reviews++;
  }
  for (const w of waits) {
    lane(w.actor, w.start);
    if (w.waitingOn) lane(w.waitingOn, w.start);
  }
  for (const d of outDecisions) {
    lane(d.proposedBy, d.start);
    for (const b of d.ballots) lane(b.actor, b.at);
    if (d.decidedBy && d.end) lane(d.decidedBy, d.end);
  }
  for (const n of notes) lane(n.agent, n.at);
  for (const c of [...created, ...closes]) lane(c.by, c.at);

  const laneList: TimelineLane[] = [...lanes.values()]
    .map(({ held, ...l }) => ({ ...l, tasks: held.size }))
    .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.agent < b.agent ? -1 : 1));

  const agentLanes = laneList.filter((l) => l.kind === 'agent');
  const hours = (ms: number): number => Math.round((ms / 3_600_000) * 10) / 10;
  const totals: TimelineTotals = {
    agentHours: hours(agentLanes.reduce((n, l) => n + l.runMs, 0)),
    workHours: hours(agentLanes.reduce((n, l) => n + l.workMs, 0)),
    humanMinutes: humanSessionMinutes(humanTimes.filter((t) => t >= fromMs && t < toMs)),
    humanWaitMinutes: Math.round(
      waits.filter((w) => w.human).reduce((n, w) => n + clipped(w.start, w.end, fromMs, toMs), 0) /
        60_000,
    ),
    asksAnswered: waits.filter(
      (w) => w.kind === 'ask' && w.answered && w.end && within(w.end, fromMs, toMs),
    ).length,
    reviewRounds: reviews.filter((r) => within(r.start, fromMs, toMs)).length,
    tasksClosed: new Set(closes.map((c) => `${c.root}/${c.task}`)).size,
    runs: runs.filter((r) => within(r.start, fromMs, toMs)).length,
    tokens: laneList.reduce((n, l) => n + l.tokens, 0),
  };

  // Every start, end and moment drives the playback map. An item that crosses a window edge
  // adds that edge, so an open wait that began before the window still spans it in playback.
  const points: number[] = [];
  const add = (at: string | null | undefined): void => {
    if (!at) return;
    const t = Date.parse(at);
    if (t >= fromMs && t <= toMs) points.push(t);
  };
  for (const x of [...spans, ...reviews, ...waits, ...runs, ...outDecisions]) {
    points.push(Math.max(Date.parse(x.start), fromMs));
    points.push(Math.min(x.end ? Date.parse(x.end) : toMs, toMs));
  }
  for (const d of outDecisions) for (const b of d.ballots) add(b.at);
  for (const x of [...notes, ...created, ...closes]) add(x.at);

  return {
    from: Number.isFinite(fromMs) ? iso(fromMs) : null,
    to: iso(toMs),
    lanes: laneList,
    spans,
    reviews,
    waits,
    runs,
    decisions: outDecisions,
    notes,
    created,
    closes,
    totals,
    time: timeMap(points, { maxGapMs: opts.maxGapMs, clipMs: opts.clipMs }),
  };
}
