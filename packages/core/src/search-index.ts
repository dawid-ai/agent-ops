// The search's reusable index: tasks, learn notes, channel posts and votes, each parsed and
// lower-cased once and kept in one cache with a byte budget. A request lists folders and checks
// file stamps; it reads and parses only what changed since an earlier request.
//
// Every request scans the whole corpus in the same order, which defeats a least-recently-used
// cache: once the corpus is larger than the budget, each request evicts the entries it needs
// next and rereads everything. So the cache never evicts a valid entry to make room. It admits
// new entries while they fit and keeps them until their files change or go away.
//
// The cache alone does not bound a request: a store larger than the cache, or one huge item,
// is read again on every request. So each request also has a fixed work budget
// (`SEARCH_WORK`): file system calls and bytes read, counted before each call is made. A
// request that reaches it stops reading and answers with what it has, marked partial. Items
// read by earlier requests stay cached and cost only their stamp checks, so repeated searches
// cover more of a large store until the cache is full.
//
// A request that stops early must not stop at the same place next time, or whatever lies past
// that point is never searched. So each folder is walked from where the last request stopped,
// wrapping around at its end (`walk`), and each root gets its own share of the budget.

import { lstatSync, opendirSync, statSync } from 'node:fs';
import type { Dir } from 'node:fs';
import { join } from 'node:path';
import { CHANNEL_RE, readMessage } from './channels.js';
import { parseDecisionId, readDecision } from './decisions.js';
import { derive, fold } from './fold.js';
import { parseTaskId } from './ids.js';
import { readNote } from './kb.js';
import type { Status, TaskState } from './model.js';
import type { Root } from './root.js';
import type {
  SearchNote,
  SearchPost,
  SearchSources,
  SearchTask,
  SearchVote,
  TaskText,
} from './search.js';

/** The default budget: about 32 MB of cached text. */
export const SEARCH_CACHE_BYTES = 32 * 1024 * 1024;

/** A change newer than this may be followed by another in the same time tick (see `Root.states`). */
const RACY_MS = 2000;

interface Entry {
  stamp: string;
  value: unknown;
  bytes: number;
  /** The request (`tick`) that last used it. */
  seen: number;
}

/**
 * A scan-resistant cache with a byte budget. Each entry has a stamp that names the state of its
 * files; a different stamp loads the entry again. A new entry is kept only when it fits in the
 * room left: no valid entry is evicted for it (see the note at the top of this file). `retain`
 * and `sweep` drop the entries whose files are gone, which frees room for new ones.
 */
export class SearchCache {
  private entries = new Map<string, Entry>();
  private size = 0;
  private loadCount = 0;
  private clock = 0;
  /** Values this request loaded that did not fit, for `sweep` to admit when it frees room. */
  private missed: Array<{ key: string; entry: Entry }> = [];

  constructor(private maxBytes: number) {}

  /** Starts a request: the entries it uses are marked with its number, which `now` returns. */
  tick(): number {
    this.missed = [];
    return ++this.clock;
  }

  now(): number {
    return this.clock;
  }

  /** The cached value for `key` while `stamp` holds, or undefined. A stale entry is dropped. */
  peek<T>(key: string, stamp: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.stamp === stamp) {
      hit.seen = this.clock;
      return hit.value as T;
    }
    // A stale entry gives its room back to its own new value.
    this.entries.delete(key);
    this.size -= hit.bytes;
    return undefined;
  }

  /** Keeps a freshly loaded value if it fits in the room left. */
  put(key: string, stamp: string, value: unknown, bytes: number, racy = false): void {
    this.loadCount++;
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.size -= old.bytes;
    }
    // A racy entry gets an empty stamp, which no real stamp matches, so the next request loads
    // it again.
    const entry = { stamp: racy ? '' : stamp, value, bytes, seen: this.clock };
    if (this.size + bytes <= this.maxBytes) {
      this.entries.set(key, entry);
      this.size += bytes;
    } else if (bytes <= this.maxBytes) {
      this.missed.push({ key, entry });
    }
  }

  /** The cached value for `key` while `stamp` holds; otherwise `load` runs and its value is kept if it fits. */
  get<T>(key: string, stamp: string, load: () => { value: T; bytes: number; racy?: boolean }): T {
    const hit = this.peek<T>(key, stamp);
    if (hit !== undefined) return hit;
    const { value, bytes, racy } = load();
    this.put(key, stamp, value, bytes, racy);
    return value;
  }

  /** Drops every entry under `prefix` whose key is not in `keys`: its files are gone. */
  retain(prefix: string, keys: Set<string>): void {
    for (const [key, e] of this.entries) {
      if (key.startsWith(prefix) && !keys.has(key)) {
        this.entries.delete(key);
        this.size -= e.bytes;
      }
    }
  }

  /**
   * Drops every entry under `prefix` that no request since `since` used. A walk calls it at the
   * end of a pass over the folders that hold those items: an entry it did not see is gone. The
   * room it frees goes first to what this request loaded under `prefix` and could not keep.
   */
  sweep(prefix: string, since: number): void {
    for (const [key, e] of this.entries) {
      if (key.startsWith(prefix) && e.seen < since) {
        this.entries.delete(key);
        this.size -= e.bytes;
      }
    }
    this.missed = this.missed.filter(({ key, entry }) => {
      if (!key.startsWith(prefix)) return true;
      if (!this.entries.has(key) && this.size + entry.bytes <= this.maxBytes) {
        this.entries.set(key, entry);
        this.size += entry.bytes;
      }
      return false;
    });
  }

  /** Sets the budget, dropping the newest entries until the cache fits. */
  setLimit(bytes: number): void {
    this.maxBytes = bytes;
    for (const [key, e] of [...this.entries].reverse()) {
      if (this.size <= this.maxBytes) break;
      this.entries.delete(key);
      this.size -= e.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.size = 0;
  }

  /** Entries kept, their estimated bytes, the budget, and loads (file reads) since the start. */
  stats(): { entries: number; bytes: number; maxBytes: number; loads: number } {
    return {
      entries: this.entries.size,
      bytes: this.size,
      maxBytes: this.maxBytes,
      loads: this.loadCount,
    };
  }
}

/** The one cache opsd and the CLI use for search. */
const cache = new SearchCache(SEARCH_CACHE_BYTES);

/** For tests and diagnostics: the cache's size and how many loads it made. */
export function searchCacheStats(): ReturnType<SearchCache['stats']> {
  return cache.stats();
}

/** Sets the search cache's byte budget; `SEARCH_CACHE_BYTES` restores the default. */
export function setSearchCacheLimit(bytes: number): void {
  cache.setLimit(bytes);
}

/** Forgets every cached item and where each walk stopped. */
export function clearSearchCache(): void {
  cache.clear();
  walks.clear();
}

/** What one search request may spend: file system calls, and bytes of files read. */
export interface SearchWorkLimits {
  ops: number;
  bytes: number;
}

/**
 * The default per-request budget. A warm request over the real store spends a few hundred calls;
 * this lets a cold one read a few thousand items, and it holds whatever the store's size.
 */
export const SEARCH_WORK: SearchWorkLimits = { ops: 40_000, bytes: 16 * 1024 * 1024 };

let workLimits: SearchWorkLimits = SEARCH_WORK;

/** Sets the per-request budget; `SEARCH_WORK` restores the default. */
export function setSearchWorkLimits(limits: SearchWorkLimits): void {
  workLimits = limits;
}

/**
 * One request's work budget. Each kind the query reads, in each root it reads, gets an even share
 * of what is left when it starts, so a large task store cannot use up the room for notes, posts
 * and votes, and a large root cannot use up the room for the roots after it; a share left unused
 * goes to the shares after it. Work is taken before it is done: a refusal means the call is never
 * made, and the answer is marked partial.
 */
export class SearchBudget {
  private ops = 0;
  private bytes = 0;
  private opsEnd = 0;
  private bytesEnd = 0;
  private sharesLeft: number;
  private done = 0;
  /** True once any work was refused: some items were not searched. */
  partial = false;

  constructor(
    private limits: SearchWorkLimits,
    shares: number,
  ) {
    this.sharesLeft = Math.max(1, shares);
  }

  /** Starts the next share: an even part of what is left. */
  begin(): void {
    const n = Math.max(1, this.sharesLeft);
    this.sharesLeft--;
    this.done = 0;
    this.opsEnd = this.ops + Math.floor((this.limits.ops - this.ops) / n);
    this.bytesEnd = this.bytes + Math.floor((this.limits.bytes - this.bytes) / n);
  }

  /** Counts a folder entry handled in the current share. */
  handled(): void {
    this.done++;
  }

  /** True while the current share has handled no folder entry. */
  fresh(): boolean {
    return this.done === 0;
  }

  /** Takes `ops` file system calls and `bytes` of reads from the share, or refuses all of it. */
  take(ops: number, bytes = 0): boolean {
    if (this.ops + ops > this.opsEnd || this.bytes + bytes > this.bytesEnd) {
      this.partial = true;
      return false;
    }
    this.ops += ops;
    this.bytes += bytes;
    return true;
  }

  /** The work taken so far. */
  spent(): SearchWorkLimits {
    return { ops: this.ops, bytes: this.bytes };
  }
}

/** A budget for a request that reads `kinds` kinds in `roots` roots, with the current limits. */
export function searchBudget(kinds: number, roots = 1): SearchBudget {
  return new SearchBudget(workLimits, kinds * Math.max(1, roots));
}

/**
 * True when a file changed in the last `RACY_MS`, by the file system's clock (not the
 * workspace's, which tests can move).
 */
function racy(...mtimes: number[]): boolean {
  return Date.now() - Math.max(...mtimes) < RACY_MS;
}

interface Stamp {
  stamp: string;
  mtime: number;
  size: number;
  ok: boolean;
  /** A plain folder or file: with `lstat`, a link is neither. */
  dir: boolean;
  file: boolean;
}

const MISSING: Stamp = { stamp: '-', mtime: 0, size: 0, ok: false, dir: false, file: false };

/** A path's size and change time (one call), or `MISSING`. `lstat` does not follow links. */
function stampOf(path: string, link = false): Stamp {
  try {
    const s = link ? lstatSync(path) : statSync(path);
    return {
      stamp: `${s.size}:${s.mtimeMs}`,
      mtime: s.mtimeMs,
      size: s.size,
      ok: true,
      dir: s.isDirectory(),
      file: s.isFile(),
    };
  } catch {
    return MISSING;
  }
}

/** One folder entry: its name and whether it is a folder. */
interface Item {
  name: string;
  dir: boolean;
}

/**
 * Every entry of a folder that belongs to one item (a task's events, a vote's ballots), or null
 * when the budget ran out. Opening the folder is one call and each entry is one more. A missing
 * folder has no entries.
 */
function listAll(dir: string, budget: SearchBudget): Item[] | null {
  if (!budget.take(1)) return null;
  let d: Dir;
  try {
    d = opendirSync(dir);
  } catch {
    return [];
  }
  const items: Item[] = [];
  try {
    for (;;) {
      if (!budget.take(1)) return null;
      const e = d.readSync();
      if (!e) break;
      items.push({ name: e.name, dir: e.isDirectory() });
    }
  } finally {
    d.closeSync();
  }
  return items;
}

/** Folder entries Node reads per call (`opendirSync`'s `bufferSize`); it hands them out one by one. */
export const LIST_BATCH = 128;

/** Where a walk stopped: its position in the sequence, and the request its current pass began in. */
interface WalkState {
  pos: number;
  since: number;
}

/** Walks that stopped before the end of their folders. Few at a time; bounded anyway. */
const walks = new Map<string, WalkState>();
const MAX_WALKS = 4096;

/**
 * Handles one folder entry; false means the budget ran out and the entry was not handled.
 * `dir` is the folder that lists it.
 */
type Visit = (item: Item, dir: string) => boolean;

/**
 * Visits the entries of `dirs`, read in the file system's order as one sequence, from position
 * `from` up to `to`. Opening a folder is one call; reading costs one call per `LIST_BATCH`
 * entries, so skipping to `from` is cheap; each visited entry costs one call more. Returns the
 * position to start from next time, or -1 when it got to `to` or the end.
 *
 * An entry that the first visit of a share cannot finish does not fit in any share: it is
 * skipped and the answer is marked partial. Without that, a walk could stop on it forever.
 */
function visitRange(
  dirs: string[],
  from: number,
  to: number,
  budget: SearchBudget,
  visit: Visit,
): number {
  let index = 0;
  for (const dir of dirs) {
    if (index >= to) return -1;
    if (!budget.take(1)) return Math.max(index, from);
    let d: Dir;
    try {
      d = opendirSync(dir, { bufferSize: LIST_BATCH });
    } catch {
      continue;
    }
    try {
      for (let n = 0; ; n++) {
        if (index >= to) return -1;
        if (n % LIST_BATCH === 0 && !budget.take(1)) return Math.max(index, from);
        const e = d.readSync();
        if (!e) break;
        const i = index++;
        if (i < from) continue;
        if (budget.take(1) && visit({ name: e.name, dir: e.isDirectory() }, dir)) {
          budget.handled();
          continue;
        }
        if (!budget.fresh()) return i;
        budget.partial = true;
        budget.handled();
      }
    } finally {
      d.closeSync();
    }
  }
  return -1;
}

/**
 * Visits the entries of `dirs` as one sequence that wraps around: from where the last walk under
 * `key` stopped to the end, then from the start back to there, until the budget runs out. Each
 * request so covers the part of a large folder the request before it could not reach.
 *
 * A pass runs from the first entry to the end and may span several requests: since the last
 * time a walk under `key` reached the end, it has visited every entry before its stored
 * position. Returns true when this call reached the end, which completes a pass. A walk nested
 * in another one's visit (the posts of one channel, the notes of one topic) reports that pass,
 * not this request's coverage: requiring a whole cycle within one request would hold the outer
 * walk on a folder too large for one share forever. Whatever this request did not cover took a
 * refused call, which marked the answer partial.
 *
 * After a whole cycle the next walk starts where this one did. So an entry that stopped a walk
 * is the next walk's first, which `visitRange` skips if even a fresh share cannot finish it.
 *
 * `sweep` names the cache prefix of the items the sequence holds. At the end of each pass the
 * entries under it that the pass did not use are dropped: their files are gone.
 */
function walk(key: string, dirs: string[], budget: SearchBudget, visit: Visit, sweep?: string) {
  const state = walks.get(key);
  walks.delete(key);
  const start = state?.pos ?? 0;
  let since = state?.since ?? cache.now();
  let next = visitRange(dirs, start, Infinity, budget, visit);
  const passed = next < 0;
  if (passed) {
    if (sweep) cache.sweep(sweep, since);
    since = cache.now();
    next = start > 0 ? visitRange(dirs, 0, start, budget, visit) : -1;
    if (next < 0) next = start;
  }
  if (next > 0) {
    walks.set(key, { pos: next, since });
    if (walks.size > MAX_WALKS) walks.delete(walks.keys().next().value!);
  }
  return passed;
}

/** Estimated memory of a cached value: two bytes per character of its JSON, plus overhead. */
function bytesOf(value: unknown): number {
  return 256 + 2 * JSON.stringify(value).length;
}

/**
 * The size of every `.md` file in a folder, one call each, or null when the budget ran out.
 * `names` come from `list`.
 */
function mdSizes(dir: string, names: string[], budget: SearchBudget): number | null {
  let total = 0;
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    if (!budget.take(1)) return null;
    total += stampOf(join(dir, n)).size;
  }
  return total;
}

/** A task's fold and its text, cached together. */
interface TaskRecord {
  state: TaskState;
  text: TaskText;
}

/** Calls `Root.readTask` and `Root.readEvents` make besides one read per event file. */
const TASK_READ_CALLS = 10;

/**
 * A task, read again when anything that could change it changed: its folder (live or archived),
 * the size and time of `task.md`, and the time of its `events` folder, which changes when an
 * event file is added, removed or renamed (a sync renames the events it rewrites). Event files
 * are never edited in place once written. A warm task costs two calls; reading one costs about
 * four calls per event and the bytes of its files, taken before any file is read.
 */
function taskRecord(
  root: Root,
  id: string,
  dir: string,
  task: Stamp,
  key: string,
  budget: SearchBudget,
): TaskRecord | null {
  if (!budget.take(1)) return null;
  const events = stampOf(join(dir, 'events'));
  // The fold carries the project the root's settings resolve, so those settings are in the stamp.
  const stamp = `${dir}|${task.stamp}|${events.stamp}|${root.projectStamp}`;
  const hit = cache.peek<TaskRecord>(key, stamp);
  if (hit) return hit;
  const names = events.ok ? listAll(join(dir, 'events'), budget) : [];
  if (!names) return null;
  const files = names.map((i) => i.name);
  const size = mdSizes(join(dir, 'events'), files, budget);
  if (size === null) return null;
  if (!budget.take(TASK_READ_CALLS + 2 * files.length, task.size + size)) return null;
  const { meta, body } = root.readTask(id);
  const read = root.readEvents(id);
  const record: TaskRecord = {
    state: fold(meta, read),
    text: {
      events: read,
      body,
      low: { body: body.toLowerCase(), events: read.map((e) => e.body.toLowerCase()) },
    },
  };
  cache.put(key, stamp, record, bytesOf(record), racy(task.mtime, events.mtime));
  return record;
}

/** Every task in every root, archived ones included, with leases and dependencies applied. */
function tasks(roots: Root[], nowMs: number, budget: SearchBudget): SearchTask[] {
  const all = new Map<string, { root: Root; rec: TaskRecord; archived: boolean }>();
  for (const root of roots) {
    budget.begin();
    const prefix = `task|${root.dir}|`;
    const archive = join(root.dir, 'archive', 'tasks');
    // Root.taskDir finds archived tasks too, so their text and people are searched. Live and
    // archived tasks are one sequence, so a large live folder cannot keep the archive unread.
    const visit: Visit = ({ name: id }, dir) => {
      if (parseTaskId(id)?.prefix !== root.prefix) return true;
      const archived = dir === archive;
      const at = `${root.dir}|${id}`;
      // A task in both folders is live.
      if (archived && all.has(at)) return true;
      if (!budget.take(1)) return false;
      const taskDir = archived ? root.archiveDir(id) : root.liveDir(id);
      const task = stampOf(join(taskDir, 'task.md'));
      if (!task.ok) return true;
      const rec = taskRecord(root, id, taskDir, task, prefix + id, budget);
      if (!rec) return false;
      if (!archived || !all.has(at)) all.set(at, { root, rec, archived });
      return true;
    };
    walk(prefix, [join(root.dir, 'tasks'), archive], budget, visit, prefix);
  }
  // Dependencies are stored bare in the same root and as root/id across roots (Workspace.depRef).
  const status = new Map<string, Status>();
  // Bare id to status for stores that kept a bare id across roots; null when two roots hold it.
  const bare = new Map<string, Status | null>();
  for (const { root, rec } of all.values()) {
    const { id } = rec.state.meta;
    status.set(`${root.name}/${id}`, rec.state.status);
    bare.set(id, bare.has(id) ? null : rec.state.status);
  }
  return [...all.values()].map(({ root, rec, archived }) => {
    const statusOf = (ref: string): Status | undefined =>
      ref.includes('/')
        ? status.get(ref)
        : (status.get(`${root.name}/${ref}`) ?? bare.get(ref) ?? undefined);
    const view = derive(rec.state, root.name, nowMs, statusOf);
    if (archived) view.archived = true;
    return { view, text: rec.text };
  });
}

/** Calls `readNote`, `readMessage` make: one read. */
const FILE_READ_CALLS = 1;

/**
 * Notes as `noteFiles` finds them: `kb/<topic>/<slug>.md`, folders and files only, no links. A
 * warm note costs two calls (its entry and its `lstat`).
 */
function notes(roots: Root[], budget: SearchBudget): SearchNote[] {
  const out: SearchNote[] = [];
  for (const root of roots) {
    budget.begin();
    const prefix = `note|${root.dir}|`;
    const kb = join(root.dir, 'kb');
    if (!budget.take(1)) continue;
    if (!stampOf(kb, true).dir) {
      cache.retain(prefix, new Set());
      continue;
    }
    const note =
      (topic: string, dir: string): Visit =>
      ({ name }) => {
        if (!name.endsWith('.md')) return true;
        const file = join(dir, name);
        const key = prefix + file;
        if (!budget.take(1)) return false;
        const s = stampOf(file, true);
        if (!s.file) return true;
        const hit = cache.peek<SearchNote>(key, s.stamp);
        if (hit) {
          out.push(hit);
          return true;
        }
        if (!budget.take(FILE_READ_CALLS, s.size)) return false;
        const n = readNote(root, { topic, slug: name.slice(0, -3), file });
        const value: SearchNote = {
          ...n,
          low: {
            head: `${n.title} ${(n.tags ?? []).join(' ')} ${n.topic}`.toLowerCase(),
            body: n.body.toLowerCase(),
          },
        };
        cache.put(key, s.stamp, value, bytesOf(value), racy(s.mtime));
        out.push(value);
        return true;
      };
    // A topic is done when its own walk's pass reaches the end, in this request or after
    // several; until then the next request goes on with the same topic, where its walk stopped.
    const topic: Visit = (t) => {
      if (!t.dir) return true;
      if (!budget.take(1)) return false;
      const dir = join(kb, t.name);
      if (!stampOf(dir, true).dir) return true;
      return walk(`${prefix}${t.name}`, [dir], budget, note(t.name, dir));
    };
    walk(prefix, [kb], budget, topic, prefix);
  }
  return out;
}

/**
 * Message files are never edited after they are written, so their name is their stamp: a warm
 * post costs one call (its folder entry).
 */
function posts(roots: Root[], budget: SearchBudget): SearchPost[] {
  const out: SearchPost[] = [];
  for (const root of roots) {
    budget.begin();
    const prefix = `post|${root.dir}|`;
    const channels = join(root.dir, 'channels');
    const post =
      (channel: string, dir: string): Visit =>
      ({ name: file }) => {
        if (!file.endsWith('.md') || file.length <= 27) return true;
        const key = `${prefix}${channel}|${file}`;
        const hit = cache.peek<SearchPost>(key, 'v1');
        if (hit) {
          out.push(hit);
          return true;
        }
        if (!budget.take(1)) return false;
        const s = stampOf(join(dir, file));
        if (!s.ok) return true;
        if (!budget.take(FILE_READ_CALLS, s.size)) return false;
        const m = readMessage(root, channel, file);
        const value: SearchPost = { ...m, root: root.name, low: m.body.toLowerCase() };
        cache.put(key, 'v1', value, bytesOf(value));
        out.push(value);
        return true;
      };
    const channel: Visit = (c) => {
      if (!c.dir || !CHANNEL_RE.test(c.name)) return true;
      const dir = join(channels, c.name);
      return walk(`${prefix}${c.name}`, [dir], budget, post(c.name, dir));
    };
    walk(prefix, [channels], budget, channel, prefix);
  }
  return out;
}

/** Calls `readDecision` makes besides one read per ballot. */
const VOTE_READ_CALLS = 8;

/**
 * A vote, read again when `decision.md`, `outcome.md` or any ballot changes: a ballot is
 * rewritten under the same name when its voter votes again. A warm vote costs four calls plus
 * two per ballot.
 */
function votes(roots: Root[], nowMs: number, budget: SearchBudget): SearchVote[] {
  const out: SearchVote[] = [];
  for (const root of roots) {
    budget.begin();
    const prefix = `vote|${root.dir}|`;
    const vote: Visit = ({ name: id }) => {
      if (parseDecisionId(id) !== id) return true;
      const key = prefix + id;
      const dir = join(root.dir, 'decisions', id);
      if (!budget.take(2)) return false;
      const head = stampOf(join(dir, 'decision.md'));
      const outcome = stampOf(join(dir, 'outcome.md'));
      if (!head.ok) return true;
      const ballots = listAll(join(dir, 'ballots'), budget);
      if (!ballots) return false;
      const md = ballots.filter((b) => b.name.endsWith('.md'));
      if (!budget.take(md.length)) return false;
      const bs = md.map((b) => ({ name: b.name, ...stampOf(join(dir, 'ballots', b.name)) }));
      const stamp = `${head.stamp}|${outcome.stamp}|${bs.map((b) => `${b.name}=${b.stamp}`).join(',')}`;
      const hit = cache.peek<SearchVote>(key, stamp);
      if (hit) {
        out.push(hit);
        return true;
      }
      const size = head.size + outcome.size + bs.reduce((n, b) => n + b.size, 0);
      if (!budget.take(VOTE_READ_CALLS + 2 * md.length, size)) return false;
      const d = readDecision(root, id, nowMs);
      const value: SearchVote = {
        root: d.root,
        meta: d.meta,
        body: d.body,
        ballots: d.ballots,
        low: [
          d.meta.id,
          d.meta.question,
          ...d.meta.options,
          d.body,
          ...d.ballots.map((b) => b.body),
        ]
          .join(' ')
          .toLowerCase(),
      };
      const changed = racy(head.mtime, outcome.mtime, ...bs.map((b) => b.mtime));
      cache.put(key, stamp, value, bytesOf(value), changed);
      out.push(value);
      return true;
    };
    walk(prefix, [join(root.dir, 'decisions')], budget, vote, prefix);
  }
  return out;
}

/**
 * The search's sources over `roots`, read through the shared cache within `budget`, which should
 * have a share for each kind in each root. Without a budget each source gets the whole default
 * one.
 */
export function searchSources(roots: Root[], nowMs: number, budget?: SearchBudget): SearchSources {
  cache.tick();
  const b = (): SearchBudget => budget ?? searchBudget(1, roots.length);
  return {
    tasks: () => tasks(roots, nowMs, b()),
    notes: () => notes(roots, b()),
    posts: () => posts(roots, b()),
    decisions: () => votes(roots, nowMs, b()),
  };
}
