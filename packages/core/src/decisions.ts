import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ID_BLOCK_SIZE } from './config.js';
import { parseDoc, stringifyDoc } from './frontmatter.js';
import { actorSlug, OpsError, ownerMatches } from './ids.js';
import type { Root } from './root.js';

const DECISION_RE = /^D-(\d+)$/i;

/** Frontmatter of `decisions/<id>/decision.md`. */
export interface DecisionMeta {
  id: string;
  question: string;
  options: string[];
  /** Who may vote: actor ids or runtime wildcards. Empty means anyone. */
  voters?: string[];
  /** Ballots needed before the vote can decide. */
  quorum: number;
  /** When voting closes (ISO). */
  deadline?: string;
  /** A task the decision belongs to. */
  task?: string;
  created_by: string;
  created_at: string;
}

/** `decisions/<id>/ballots/<actor>.md`. One per voter, final once cast. */
export interface Ballot {
  actor: string;
  at: string;
  choice: string;
  body: string;
}

/** `decisions/<id>/outcome.md`, written by `ops decide`. */
export interface Outcome {
  choice: string;
  decided_by: string;
  at: string;
  body: string;
}

/**
 * - `open`: voting goes on.
 * - `ready`: quorum is met and one option leads in a way the missing ballots cannot change
 *   (ballots are final), or voting closed with one leader.
 * - `tie`, `no-quorum`: voting closed without a result; the human decides.
 * - `decided`: an outcome exists.
 */
export type DecisionState = 'open' | 'ready' | 'tie' | 'no-quorum' | 'decided';

export interface Tally {
  counts: Record<string, number>;
  votes: number;
  leaders: string[];
  state: DecisionState;
  /** Listed voters who have not voted yet. */
  missing: string[];
  closed: boolean;
}

export interface Decision {
  root: string;
  meta: DecisionMeta;
  body: string;
  ballots: Ballot[];
  outcome: Outcome | null;
  tally: Tally;
}

export function formatDecisionId(n: number): string {
  return `D-${String(n).padStart(4, '0')}`;
}

export function parseDecisionId(s: string): string | null {
  const m = DECISION_RE.exec(s.trim());
  return m ? formatDecisionId(Number(m[1])) : null;
}

/** Default quorum: a majority of the listed voters, or 2 when anyone may vote. */
export function defaultQuorum(voters: string[] | undefined): number {
  return voters && voters.length > 0 ? Math.floor(voters.length / 2) + 1 : 2;
}

/** Matches a choice by option text (case-insensitive) or 1-based number. */
export function matchOption(options: string[], choice: string): string {
  const c = choice.trim();
  if (/^\d+$/.test(c)) {
    const opt = options[Number(c) - 1];
    if (opt !== undefined) return opt;
  }
  const opt = options.find((o) => o.toLowerCase() === c.toLowerCase());
  if (opt === undefined) {
    const list = options.map((o, i) => `${i + 1}. ${o}`).join(', ');
    throw new OpsError(`'${choice}' is not an option: ${list}`, 2);
  }
  return opt;
}

export function mayVote(meta: DecisionMeta, actor: string): boolean {
  if (!meta.voters || meta.voters.length === 0) return true;
  return meta.voters.some((v) => ownerMatches(v, actor));
}

export function tally(
  meta: DecisionMeta,
  ballots: Ballot[],
  outcome: Outcome | null,
  nowMs: number,
): Tally {
  const counts: Record<string, number> = Object.fromEntries(meta.options.map((o) => [o, 0]));
  const valid = ballots.filter((b) => mayVote(meta, b.actor) && b.choice in counts);
  for (const b of valid) counts[b.choice]!++;
  const votes = valid.length;
  const top = Math.max(0, ...Object.values(counts));
  const leaders = top === 0 ? [] : meta.options.filter((o) => counts[o] === top);
  const listed = (meta.voters ?? []).filter((v) => !v.endsWith(':*'));
  const voted = new Set(valid.map((b) => b.actor));
  const missing = listed.filter((v) => !voted.has(v));
  const fixedList = listed.length > 0 && listed.length === (meta.voters ?? []).length;
  const deadlinePassed = meta.deadline ? Date.parse(meta.deadline) <= nowMs : false;
  const closed = deadlinePassed || (fixedList && missing.length === 0);

  let state: DecisionState = 'open';
  if (outcome) {
    state = 'decided';
  } else {
    const second = [...Object.values(counts)].sort((a, b) => b - a)[1] ?? 0;
    // Ballots are final, so with a fixed voter list a lead larger than the missing ballots
    // cannot change. Open votes (anyone, or a runtime wildcard) are ready only once closed.
    const settled = fixedList && top - second > missing.length;
    if (votes >= meta.quorum && leaders.length === 1 && (closed || settled)) {
      state = 'ready';
    } else if (closed) {
      state = votes < meta.quorum ? 'no-quorum' : 'tie';
    }
  }
  return { counts, votes, leaders, state, missing, closed };
}

function decisionDir(root: Root, id: string): string {
  return join(root.dir, 'decisions', id);
}

export function hasDecision(root: Root, id: string): boolean {
  return existsSync(join(decisionDir(root, id), 'decision.md'));
}

export function listDecisionIds(root: Root): string[] {
  const dir = join(root.dir, 'decisions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => parseDecisionId(n) === n);
}

/** Creates `decisions/<id>/decision.md` with the next free id in this machine's block. */
export function createDecision(
  root: Root,
  meta: Omit<DecisionMeta, 'id'>,
  body: string,
  idBlock = 0,
): DecisionMeta {
  const dir = join(root.dir, 'decisions');
  mkdirSync(dir, { recursive: true });
  const lo = idBlock * ID_BLOCK_SIZE;
  const hi = lo + ID_BLOCK_SIZE;
  let n = lo;
  for (const id of listDecisionIds(root)) {
    const num = Number(id.slice(2));
    if (num > n && num < hi) n = num;
  }
  for (;;) {
    n++;
    if (n >= hi) throw new OpsError(`decision id block ${idBlock} is full`);
    const id = formatDecisionId(n);
    try {
      mkdirSync(decisionDir(root, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    mkdirSync(join(decisionDir(root, id), 'ballots'));
    const full: DecisionMeta = { id, ...meta };
    root.writeAtomic(join(decisionDir(root, id), 'decision.md'), stringifyDoc(full, body));
    return full;
  }
}

export function readDecision(root: Root, id: string, nowMs: number): Decision {
  const dir = decisionDir(root, id);
  const file = join(dir, 'decision.md');
  if (!existsSync(file)) throw new OpsError(`no decision ${id} in root '${root.name}'`, 2);
  const doc = parseDoc<DecisionMeta>(readFileSync(file, 'utf8'));
  const meta: DecisionMeta = {
    ...doc.data,
    id,
    options: doc.data.options ?? [],
    quorum: doc.data.quorum ?? defaultQuorum(doc.data.voters),
  };
  const ballots: Ballot[] = [];
  const bdir = join(dir, 'ballots');
  if (existsSync(bdir)) {
    for (const name of readdirSync(bdir)) {
      if (!name.endsWith('.md')) continue;
      const b = parseDoc<Omit<Ballot, 'body'>>(readFileSync(join(bdir, name), 'utf8'));
      if (b.data.actor && b.data.choice) ballots.push({ ...b.data, body: b.body.trim() });
    }
  }
  let outcome: Outcome | null = null;
  const ofile = join(dir, 'outcome.md');
  if (existsSync(ofile)) {
    const o = parseDoc<Omit<Outcome, 'body'>>(readFileSync(ofile, 'utf8'));
    outcome = { ...o.data, body: o.body.trim() };
  }
  return {
    root: root.name,
    meta,
    body: doc.body.trim(),
    ballots,
    outcome,
    tally: tally(meta, ballots, outcome, nowMs),
  };
}

export function writeBallot(root: Root, id: string, ballot: Ballot): void {
  const bdir = join(decisionDir(root, id), 'ballots');
  mkdirSync(bdir, { recursive: true });
  const { body, ...front } = ballot;
  root.writeAtomic(join(bdir, `${actorSlug(ballot.actor)}.md`), stringifyDoc(front, body));
}

export function writeOutcome(root: Root, id: string, outcome: Outcome): void {
  const { body, ...front } = outcome;
  root.writeAtomic(join(decisionDir(root, id), 'outcome.md'), stringifyDoc(front, body));
}
