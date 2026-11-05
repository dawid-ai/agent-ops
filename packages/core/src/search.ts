// Search across tasks, their threads, learn notes, channel posts and votes, for the desktop's
// search bar and `GET /api/search`. Words must all match; `key:value` filters narrow the results.

import type { ChannelMessage } from './channels.js';
import type { Decision } from './decisions.js';
import { OpsError } from './ids.js';
import type { KbNote } from './kb.js';
import type { OpsEvent, TaskView } from './model.js';
import { OPEN_STATUSES } from './model.js';

export type SearchKind = 'task' | 'note' | 'post' | 'vote';

const KINDS: Record<string, SearchKind> = {
  task: 'task',
  tasks: 'task',
  note: 'note',
  notes: 'note',
  kb: 'note',
  post: 'post',
  posts: 'post',
  channel: 'post',
  channels: 'post',
  vote: 'vote',
  votes: 'vote',
  decision: 'vote',
  decisions: 'vote',
};

/** A parsed query: free words and phrases, plus filters. */
export interface SearchQuery {
  words: string[];
  /** `agent:` (also `who:`, `by:`): an owner, author or anyone who acted on the item. */
  agents: string[];
  status: string[];
  project: string[];
  type: string[];
  priority: string[];
  root: string[];
  /** `is:open` or `is:closed`. */
  open?: boolean;
  /** `in:tasks`, `in:notes`, `in:posts`, `in:votes`. Empty means every kind. */
  kinds: SearchKind[];
}

const FILTERS = ['agent', 'who', 'by', 'status', 'project', 'type', 'priority', 'root', 'is', 'in'];

/**
 * Most distinct words and phrases a query may have, and most tokens in all. Each word is one scan
 * of the candidate text, so these bound the work one request can ask for.
 */
export const MAX_WORDS = 16;
export const MAX_TOKENS = 32;

/**
 * Splits a query into tokens. A quoted phrase is one token without its quotes; an opening quote
 * with no closing one (while someone types) runs to the end of the text, so no typed character
 * is lost. `quoted` marks phrases, which are never filters. The desktop's `queryWords` uses the
 * same rules.
 */
export function tokenize(q: string): Array<{ text: string; quoted: boolean }> {
  const out: Array<{ text: string; quoted: boolean }> = [];
  for (const m of q.matchAll(/"([^"]*)("|$)|(\S+)/g)) {
    if (m[3] !== undefined) out.push({ text: m[3], quoted: false });
    else if (m[1]!.trim()) out.push({ text: m[1]!.trim(), quoted: true });
  }
  return out;
}

/**
 * Parses `words "a phrase" agent:codex status:blocked in:tasks`. An unknown `key:value` stays a
 * word, so text such as `http://` or `claude:engineer` without a key still searches. Repeated
 * words count once. More than `MAX_WORDS` distinct words or `MAX_TOKENS` tokens is refused.
 */
export function parseQuery(q: string): SearchQuery {
  const tokens = tokenize(q);
  if (tokens.length > MAX_TOKENS) {
    throw new OpsError(`a search takes at most ${MAX_TOKENS} words and filters`, 2);
  }
  const out = parseTokens(tokens);
  out.words = [...new Set(out.words)];
  if (out.words.length > MAX_WORDS) {
    throw new OpsError(`a search takes at most ${MAX_WORDS} different words and phrases`, 2);
  }
  return out;
}

function parseTokens(tokens: Array<{ text: string; quoted: boolean }>): SearchQuery {
  const out: SearchQuery = {
    words: [],
    agents: [],
    status: [],
    project: [],
    type: [],
    priority: [],
    root: [],
    kinds: [],
  };
  for (const { text: tok, quoted } of tokens) {
    const at = quoted ? -1 : tok.indexOf(':');
    const key = at > 0 ? tok.slice(0, at).toLowerCase() : '';
    const value = at > 0 ? tok.slice(at + 1).toLowerCase() : '';
    if (!key || !FILTERS.includes(key) || !value) {
      out.words.push(tok.toLowerCase());
      continue;
    }
    if (key === 'agent' || key === 'who' || key === 'by') out.agents.push(value);
    else if (key === 'is') {
      if (value === 'open') out.open = true;
      else if (value === 'closed' || value === 'done') out.open = false;
      else out.words.push(tok.toLowerCase());
    } else if (key === 'in') {
      const k = KINDS[value];
      if (k) out.kinds.push(k);
      else out.words.push(tok.toLowerCase());
    } else
      (out[key as 'status' | 'project' | 'type' | 'priority' | 'root'] as string[]).push(value);
  }
  return out;
}

/** True when the query has nothing to search for. */
export function emptyQuery(q: SearchQuery): boolean {
  return (
    q.words.length === 0 &&
    q.agents.length === 0 &&
    q.status.length === 0 &&
    q.project.length === 0 &&
    q.type.length === 0 &&
    q.priority.length === 0 &&
    q.root.length === 0 &&
    q.open === undefined &&
    q.kinds.length === 0
  );
}

/**
 * Whether an actor id matches an `agent:` filter: a full id (`codex:qa`), a runtime or role
 * (`codex`, `qa`), a person's name (`dawid` for `human:dawid`), or a wildcard (`codex:*`).
 */
export function actorMatches(actor: string | null | undefined, f: string): boolean {
  if (!actor) return false;
  const a = actor.toLowerCase();
  if (a === f) return true;
  if (f.endsWith(':*')) return a.startsWith(f.slice(0, -1));
  if (f.startsWith('*:')) return a.endsWith(f.slice(1));
  if (f.includes(':')) return false;
  return a.split(':').includes(f);
}

export interface SearchHit {
  kind: SearchKind;
  /** What to open: a task ref (`root/ID`), a note ref (`topic/slug`), `#channel`, or a vote id. */
  ref: string;
  title: string;
  /** Where the words matched: `id`, `title`, `description`, `thread`, `body` or `filter`. */
  field: string;
  /** Text around the first match, or the start of the item. */
  snippet: string;
  /** Who wrote the matching text, when it is a thread event, a note, a post or a vote. */
  actor?: string;
  /** The matching event, for jumping to it in the task thread. */
  event?: string;
  at: string;
  score: number;
  /** Tasks: status, owner, project, priority. */
  status?: string;
  owner?: string | null;
  project?: string;
  priority?: string;
  /** The data root the item lives in. */
  root?: string;
}

/**
 * What `GET /api/search` answers: the hits, and whether the request reached its work budget
 * before it searched every item (see `SEARCH_WORK`).
 */
export interface SearchResult {
  hits: SearchHit[];
  partial: boolean;
}

/** Text around the first match of any word, about `width` characters, on one line. */
export function snippet(text: string, words: string[], width = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || flat.length <= width)
    return flat.length > width ? `${flat.slice(0, width)}…` : flat;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** Text scans since the last `resetSearchWork`, for tests that bound a query's cost. */
let scans = 0;

export function searchWork(): number {
  return scans;
}

export function resetSearchWork(): void {
  scans = 0;
}

/**
 * Occurrences of `w` in `hay`, counted up to `max`: no score uses more, so a one-letter word
 * stops early instead of walking every match.
 */
function count(hay: string, w: string, max: number): number {
  scans++;
  if (!w) return 0;
  let n = 0;
  for (let at = hay.indexOf(w); at >= 0 && n < max; at = hay.indexOf(w, at + w.length)) n++;
  return n;
}

/** Most occurrences of one word that add to a score, per field. */
const CAP = 10;

/** A task's description and events, with their lower-case text ready for matching. */
export interface TaskText {
  events: OpsEvent[];
  body: string;
  low: { body: string; events: string[] };
}

/** A task as the search sees it: the view and its text. */
export interface SearchTask {
  view: TaskView;
  text: TaskText;
}

/** A learn note with its lower-case title, tags and topic (`head`) and body. */
export type SearchNote = KbNote & { low: { head: string; body: string } };

/** A channel post with the root it was read from. */
export type RootedPost = ChannelMessage & { root: string };

/** A channel post with its root and its lower-case text. */
export type SearchPost = RootedPost & { low: string };

/** A vote with all its lower-case text: id, question, options, description and ballots. */
export type SearchVote = Pick<Decision, 'root' | 'meta' | 'body' | 'ballots'> & { low: string };

/**
 * Where the search reads from (see `searchSources`). Each source is loaded only when the query
 * can match its kind, so `in:notes` never folds the tasks and a task filter never reads the
 * channels.
 */
export interface SearchSources {
  tasks: () => SearchTask[];
  notes: () => SearchNote[];
  posts: () => SearchPost[];
  decisions: () => SearchVote[];
}

/** Filters only tasks have; a query with one leaves notes, posts and votes out. */
const TASK_ONLY = (q: SearchQuery): boolean =>
  q.status.length > 0 ||
  q.project.length > 0 ||
  q.type.length > 0 ||
  q.priority.length > 0 ||
  q.open !== undefined;

/** The kinds a query can match. */
export function wantedKinds(q: SearchQuery): SearchKind[] {
  const all: SearchKind[] = ['task', 'note', 'post', 'vote'];
  return all.filter(
    (k) => (q.kinds.length === 0 || q.kinds.includes(k)) && (k === 'task' || !TASK_ONLY(q)),
  );
}

/** Runs a query over the sources; best first, at most `limit` hits. */
export function runSearch(src: SearchSources, q: SearchQuery, limit = 50): SearchHit[] {
  if (emptyQuery(q)) return [];
  const kinds = wantedKinds(q);
  const inRoot = (r: string): boolean => q.root.length === 0 || q.root.includes(r.toLowerCase());
  const agentsOk = (actors: Array<string | null | undefined>): boolean =>
    q.agents.every((f) => actors.some((a) => actorMatches(a, f)));
  // An exact id match ranks above every text match, whatever the text scores.
  const hits: Array<{ hit: SearchHit; exact: boolean }> = [];
  const add = (hit: SearchHit, exact = false): void => {
    hits.push({ hit, exact });
  };
  const words = q.words;
  // Each kind gets an even share of the request's work budget, and a share left unused goes to
  // the kinds read after it. Tasks are usually the most, so they are read last.
  const votes = kinds.includes('vote') ? src.decisions() : [];
  const posts = kinds.includes('post') ? src.posts() : [];
  const notes = kinds.includes('note') ? src.notes() : [];
  const tasks = kinds.includes('task') ? src.tasks() : [];

  if (kinds.includes('task')) {
    for (const { view: t, text } of tasks) {
      if (!inRoot(t.root)) continue;
      const m = t.meta;
      if (q.status.length > 0 && !q.status.includes(t.status)) continue;
      if (q.project.length > 0 && !q.project.includes((m.project ?? '').toLowerCase())) continue;
      if (q.type.length > 0 && !q.type.includes(m.type.toLowerCase())) continue;
      if (q.priority.length > 0 && !q.priority.includes(m.priority)) continue;
      if (q.open !== undefined && OPEN_STATUSES.has(t.status) !== q.open) continue;
      const { events, body } = text;
      const actors = [t.owner, t.claimedBy, m.created_by, ...events.map((e) => e.actor)];
      for (const e of events) if (e.to) actors.push(e.to);
      if (!agentsOk(actors)) continue;
      const id = m.id.toLowerCase();
      const title = `${m.title} ${(m.labels ?? []).join(' ')}`.toLowerCase();
      let score = 0;
      let all = true;
      let exact = false;
      let field = 'filter';
      let event: OpsEvent | undefined;
      for (const w of words) {
        // `47`, `0047` and `ao-0047` all find AO-0047.
        const idHit = id === w || id.endsWith(`-${w.padStart(4, '0')}`) || id.endsWith(`-${w}`);
        const inTitle = count(title, w, CAP);
        const inDesc = count(text.low.body, w, 5);
        let inThread = 0;
        for (let i = 0; i < events.length && inThread < CAP; i++) {
          const c = count(text.low.events[i]!, w, CAP - inThread);
          if (c > 0) {
            inThread += c;
            event ??= events[i];
          }
        }
        if (!idHit && inTitle + inDesc + inThread === 0) {
          all = false;
          break;
        }
        exact ||= idHit;
        score += inTitle * 10 + inDesc * 3 + inThread;
        if (field === 'filter') {
          field = idHit ? 'id' : inTitle ? 'title' : inDesc ? 'description' : 'thread';
        }
      }
      if (!all) continue;
      const shown = field === 'thread' && event ? event.body : body;
      add(
        {
          kind: 'task',
          ref: `${t.root}/${m.id}`,
          title: m.title,
          field,
          snippet: snippet(shown, words),
          actor: field === 'thread' ? event?.actor : undefined,
          event: field === 'thread' ? event?.id : undefined,
          at: t.updatedAt,
          score,
          status: t.status,
          owner: t.owner,
          project: m.project,
          priority: m.priority,
          root: t.root,
        },
        exact,
      );
    }
  }

  if (kinds.includes('note')) {
    for (const n of notes) {
      if (!inRoot(n.root) || !agentsOk([n.author])) continue;
      const { head, body } = n.low;
      let score = 0;
      let all = true;
      let inHeadAll = true;
      for (const w of words) {
        const h = count(head, w, CAP);
        const b = count(body, w, 5);
        if (h + b === 0) {
          all = false;
          break;
        }
        if (h === 0) inHeadAll = false;
        score += h * 8 + b * 2;
      }
      if (!all) continue;
      add({
        kind: 'note',
        ref: n.ref,
        title: n.title,
        field: words.length === 0 ? 'filter' : inHeadAll ? 'title' : 'body',
        snippet: snippet(n.body, words),
        actor: n.author,
        at: n.created_at,
        score,
        root: n.root,
      });
    }
  }

  if (kinds.includes('post')) {
    for (const p of posts) {
      if (!inRoot(p.root) || !agentsOk([p.actor, ...(p.mentions ?? [])])) continue;
      const body = p.low;
      let score = 0;
      let all = true;
      for (const w of words) {
        const c = count(body, w, 5) + (p.channel.toLowerCase() === w.replace(/^#/, '') ? 1 : 0);
        if (c === 0) {
          all = false;
          break;
        }
        score += c * 2;
      }
      if (!all) continue;
      add({
        kind: 'post',
        ref: `#${p.channel}`,
        title: `#${p.channel}`,
        field: words.length === 0 ? 'filter' : 'body',
        snippet: snippet(p.body, words),
        actor: p.actor,
        event: p.id,
        at: p.at,
        score,
        root: p.root,
      });
    }
  }

  if (kinds.includes('vote')) {
    for (const d of votes) {
      if (!inRoot(d.root)) continue;
      if (!agentsOk([d.meta.created_by, ...d.ballots.map((b) => b.actor)])) continue;
      const text = d.low;
      let score = 0;
      let all = true;
      let exact = false;
      for (const w of words) {
        const c = count(text, w, 5);
        if (c === 0) {
          all = false;
          break;
        }
        exact ||= d.meta.id.toLowerCase() === w;
        score += c * 3;
      }
      if (!all) continue;
      add(
        {
          kind: 'vote',
          ref: d.meta.id,
          title: d.meta.question,
          field: words.length === 0 ? 'filter' : 'body',
          snippet: snippet(`${d.meta.options.join(' · ')} ${d.body}`, words),
          actor: d.meta.created_by,
          at: d.meta.created_at,
          score,
          root: d.root,
        },
        exact,
      );
    }
  }

  return hits
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.hit.score - a.hit.score ||
        (a.hit.at < b.hit.at ? 1 : a.hit.at > b.hit.at ? -1 : 0),
    )
    .slice(0, limit)
    .map((x) => x.hit);
}
