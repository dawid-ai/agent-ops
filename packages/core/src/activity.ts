// The activity feed: every task event and channel post, archived tasks included, newest first,
// with cursor paging and a query. Backed by an index each root keeps in `.ops/activity.json`;
// the event and message files stay the source of truth, and the index is rebuilt from them when
// it is missing, damaged or from an older version.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { channelNames, readMessage } from './channels.js';
import { parseDoc } from './frontmatter.js';
import { OpsError } from './ids.js';
import type { OpsEvent, TaskMeta } from './model.js';
import type { Root } from './root.js';
import { actorMatches, MAX_TOKENS, MAX_WORDS, tokenize } from './search.js';

/** One line of the activity feed: a task event or a channel post. */
export interface ActivityItem {
  id: string;
  at: string;
  kind: 'task' | 'channel';
  /** The event type, `created` for a new task, or `post` for a channel message. */
  type: string;
  actor: string;
  to?: string;
  root: string;
  task?: string;
  title?: string;
  project?: string;
  channel?: string;
  verdict?: string;
  run?: string;
  body: string;
  /** Set when the task is in `archive/tasks/`. */
  archived?: boolean;
}

/** One page of the feed, as `GET /api/activity` answers it. */
export interface ActivityPage {
  items: ActivityItem[];
  /** Pass as `before` for the next older page; null on the last page. */
  next: string | null;
  /** Items that match the query, on every page. */
  total: number;
  /** Everyone who acted and every project, across the whole feed, for the view's filters. */
  actors: string[];
  projects: string[];
}

/** The groups the `kind:` filter and the desktop's kind buttons use. */
export const ACTIVITY_KINDS: Record<string, string[]> = {
  work: [
    'created',
    'claim',
    'start',
    'progress',
    'checkpoint',
    'done',
    'release',
    'handoff',
    'assign',
    'delegate',
    'park',
    'reopen',
    'retype',
    'priority',
    'block',
    'unblock',
  ],
  review: ['review', 'verdict', 'merge'],
  talk: ['comment', 'ask', 'answer', 'post'],
  runs: ['run-start', 'run-end'],
  notes: ['finding', 'learn'],
};

const KIND_NAMES: Record<string, string> = {
  work: 'work',
  review: 'review',
  reviews: 'review',
  talk: 'talk',
  run: 'runs',
  runs: 'runs',
  note: 'notes',
  notes: 'notes',
  finding: 'notes',
  findings: 'notes',
};

const IN_NAMES: Record<string, ActivityItem['kind']> = {
  task: 'task',
  tasks: 'task',
  post: 'channel',
  posts: 'channel',
  channel: 'channel',
  channels: 'channel',
};

/** Lease renewals are bookkeeping, not activity: the index leaves them out. */
export const ACTIVITY_HIDDEN = new Set(['renew']);

/** Characters of each event or post body the feed shows; the query searches the whole body. */
const SHOWN_CHARS = 240;

/** A parsed activity query: words and phrases that must all match, plus filters. */
export interface ActivityQuery {
  words: string[];
  /** `agent:` (also `who:`, `by:`): who acted, or who the event was addressed to. */
  agents: string[];
  project: string[];
  root: string[];
  /** `task:AO-0061`, or `task:61`. */
  task: string[];
  /** The event type: `type:verdict`, `type:created`, `type:post`. */
  type: string[];
  /** A group from `ACTIVITY_KINDS`: `kind:review`. */
  kinds: string[];
  /** `channel:general` or `channel:#general`. */
  channel: string[];
  /** `in:tasks` or `in:posts`. */
  in: Array<ActivityItem['kind']>;
}

/** Filter keys an activity query knows; any other `key:value` is a word. */
export const ACTIVITY_FILTERS = [
  'agent',
  'who',
  'by',
  'project',
  'root',
  'task',
  'type',
  'kind',
  'channel',
  'in',
];

/**
 * Parses `words "a phrase" agent:codex task:AO-0061 kind:review`, with the tokenizer and limits of
 * the search bar (`parseQuery`): a quoted phrase is never a filter, an unknown key or value stays a
 * word, and more than `MAX_WORDS` words or `MAX_TOKENS` tokens is refused. Values of one filter
 * are alternatives; `agent:` filters and words must all match.
 */
export function parseActivityQuery(text: string): ActivityQuery {
  const tokens = tokenize(text);
  if (tokens.length > MAX_TOKENS) {
    throw new OpsError(`a search takes at most ${MAX_TOKENS} words and filters`, 2);
  }
  const q: ActivityQuery = {
    words: [],
    agents: [],
    project: [],
    root: [],
    task: [],
    type: [],
    kinds: [],
    channel: [],
    in: [],
  };
  for (const { text: tok, quoted } of tokens) {
    const at = quoted ? -1 : tok.indexOf(':');
    const key = at > 0 ? tok.slice(0, at).toLowerCase() : '';
    const value = at > 0 ? tok.slice(at + 1).toLowerCase() : '';
    const word = (): void => void q.words.push(tok.toLowerCase());
    if (!key || !ACTIVITY_FILTERS.includes(key) || !value) word();
    else if (key === 'agent' || key === 'who' || key === 'by') q.agents.push(value);
    else if (key === 'kind') {
      const k = KIND_NAMES[value];
      if (k) q.kinds.push(k);
      else word();
    } else if (key === 'in') {
      const k = IN_NAMES[value];
      if (k) q.in.push(k);
      else word();
    } else if (key === 'channel') q.channel.push(value.replace(/^#/, ''));
    else (q[key as 'project' | 'root' | 'task' | 'type'] as string[]).push(value);
  }
  q.words = [...new Set(q.words)];
  if (q.words.length > MAX_WORDS) {
    throw new OpsError(`a search takes at most ${MAX_WORDS} different words and phrases`, 2);
  }
  return q;
}

// ---- The index --------------------------------------------------------------------------------

// 1: first version. 2: bodies stored whole (1 cut them to 1000 characters).
const INDEX_VERSION = 2;
/** Like git's racy-timestamp rule: a folder changed this recently is read again next time. */
const RACY_MS = 2000;
/** The in-memory index is written to `.ops/activity.json` at most this often. */
const PERSIST_MS = 30_000;

interface EventRec {
  id: string;
  at: string;
  type: string;
  actor: string;
  to?: string;
  verdict?: string;
  run?: string;
  /** Trimmed, whole: the query searches all of it; the feed clips its copy. */
  body: string;
}

interface TaskEntry {
  /** mtimes of task.md and the events folder; -1 when they were too recent to trust. */
  tm: number;
  em: number;
  archived?: boolean;
  title: string;
  project?: string;
  created_at: string;
  created_by: string;
  owner?: string;
  /** Event file name to its record; 0 for a hidden event, so the file is not read again. */
  events: Record<string, EventRec | 0>;
}

interface PostRec {
  id: string;
  at: string;
  actor: string;
  task?: string;
  body: string;
}

interface ChannelEntry {
  m: number;
  posts: Record<string, PostRec>;
}

interface IndexFile {
  v: number;
  tasks: Record<string, TaskEntry>;
  channels: Record<string, ChannelEntry>;
}

/** An item with its sort key and the lowercased text that words search. */
interface Row {
  item: ActivityItem;
  key: string;
  low: string;
}

interface RootIndex {
  data: IndexFile;
  /** Rows per task id or `#channel`, built when first needed after a change. */
  rows: Map<string, Row[]>;
  /** Bumped on every change, so merged lists know to rebuild. */
  gen: number;
  dirty: boolean;
  written: number;
}

const indexes = new Map<string, RootIndex>();
let merged: { sig: string; rows: Row[]; actors: string[]; projects: string[] } | undefined;

/** Forgets every in-memory index, so the next read loads `.ops/activity.json` again. For tests. */
export function clearActivityCache(): void {
  indexes.clear();
  merged = undefined;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function indexFile(root: Root): string {
  return join(root.opsDir, 'activity.json');
}

function load(root: Root): RootIndex {
  const file = indexFile(root);
  let data: IndexFile = { v: INDEX_VERSION, tasks: {}, channels: {} };
  let written = 0;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as IndexFile;
    if (raw.v === INDEX_VERSION && raw.tasks && raw.channels) {
      data = raw;
      written = mtime(file);
    }
  } catch {
    // No index yet, or a damaged one: rebuild from the files.
  }
  return { data, rows: new Map(), gen: 0, dirty: false, written };
}

const clipTo = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function readEvent(file: string, name: string): EventRec | 0 {
  const doc = parseDoc<Omit<OpsEvent, 'id' | 'body'>>(readFileSync(file, 'utf8'));
  const d = doc.data;
  if (ACTIVITY_HIDDEN.has(String(d.type))) return 0;
  const rec: EventRec = {
    id: name.slice(0, 26),
    at: String(d.at ?? ''),
    type: String(d.type ?? ''),
    actor: String(d.actor ?? ''),
    body: doc.body.trim(),
  };
  if (d.to) rec.to = String(d.to);
  if (d.verdict) rec.verdict = String(d.verdict);
  if (d.run) rec.run = String(d.run);
  return rec;
}

/**
 * Brings one task's entry up to date: task.md again when it changed, and only the event files
 * not read before. Event files are never edited after they are written.
 */
function updateTask(
  dir: string,
  prev: TaskEntry | undefined,
  tm: number,
  em: number,
  archived: boolean,
  now: number,
): TaskEntry {
  let head: Omit<TaskEntry, 'tm' | 'em' | 'events' | 'archived'>;
  if (prev && prev.tm === tm) {
    head = prev;
  } else {
    const meta = parseDoc<TaskMeta>(readFileSync(join(dir, 'task.md'), 'utf8')).data;
    head = {
      title: String(meta.title ?? ''),
      project: meta.project ? String(meta.project) : undefined,
      created_at: String(meta.created_at ?? ''),
      created_by: String(meta.created_by ?? ''),
      owner: meta.owner ? String(meta.owner) : undefined,
    };
  }
  const events: Record<string, EventRec | 0> = {};
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, 'events')).filter((n) => n.endsWith('.md') && n.length > 27);
  } catch {
    // No events folder: a task with no events yet.
  }
  for (const name of names) {
    const known = prev?.events[name];
    events[name] = known !== undefined ? known : readEvent(join(dir, 'events', name), name);
  }
  const racy = now - Math.max(tm, em) < RACY_MS;
  const entry: TaskEntry = {
    tm: racy ? -1 : tm,
    em: racy ? -1 : em,
    title: head.title,
    created_at: head.created_at,
    created_by: head.created_by,
    events,
  };
  if (head.project) entry.project = head.project;
  if (head.owner) entry.owner = head.owner;
  if (archived) entry.archived = true;
  return entry;
}

function updateChannel(
  root: Root,
  name: string,
  prev: ChannelEntry | undefined,
  m: number,
  now: number,
): ChannelEntry {
  const posts: Record<string, PostRec> = {};
  let files: string[] = [];
  try {
    files = readdirSync(join(root.dir, 'channels', name)).filter(
      (f) => f.endsWith('.md') && f.length > 27,
    );
  } catch {
    // The folder went away between the listing and the read.
  }
  for (const file of files) {
    const known = prev?.posts[file];
    if (known) {
      posts[file] = known;
      continue;
    }
    const msg = readMessage(root, name, file);
    const rec: PostRec = {
      id: msg.id,
      at: msg.at,
      actor: msg.actor,
      body: msg.body.trim(),
    };
    if (msg.task) rec.task = msg.task;
    posts[file] = rec;
  }
  return { m: now - m < RACY_MS ? -1 : m, posts };
}

/** Reads what changed since the last call. Returns the root's index. */
function refresh(root: Root): RootIndex {
  let idx = indexes.get(root.dir);
  if (!idx) {
    idx = load(root);
    indexes.set(root.dir, idx);
  }
  const now = Date.now();
  const data = idx.data;
  const tasks: Record<string, TaskEntry> = {};
  let changed = false;
  // A task in both folders counts once, live, like `Workspace.views`.
  const live = root.listTaskIds();
  const liveSet = new Set(live);
  const all = [
    ...live.map((id) => ({ id, dir: root.liveDir(id), archived: false })),
    ...root
      .listArchivedIds()
      .filter((id) => !liveSet.has(id))
      .map((id) => ({ id, dir: root.archiveDir(id), archived: true })),
  ];
  for (const { id, dir, archived } of all) {
    // The stamps before the files, so a write that lands in between shows next time.
    const tm = mtime(join(dir, 'task.md'));
    if (tm === 0) continue;
    const em = mtime(join(dir, 'events'));
    const prev = data.tasks[id];
    if (prev && prev.tm === tm && prev.em === em) {
      // Archiving moves the folder; its files and stamps stay as they were.
      if (Boolean(prev.archived) !== archived) {
        if (archived) prev.archived = true;
        else delete prev.archived;
        idx.rows.delete(id);
        changed = true;
      }
      tasks[id] = prev;
      continue;
    }
    let entry: TaskEntry;
    try {
      entry = updateTask(dir, prev, tm, em, archived, now);
    } catch {
      // A task moved or was removed while it was read: try again next time.
      if (prev) tasks[id] = { ...prev, tm: -1 };
      continue;
    }
    tasks[id] = entry;
    idx.rows.delete(id);
    changed = true;
  }
  for (const id of Object.keys(data.tasks)) {
    if (!(id in tasks)) {
      idx.rows.delete(id);
      changed = true;
    }
  }
  const channels: Record<string, ChannelEntry> = {};
  for (const name of channelNames(root)) {
    const m = mtime(join(root.dir, 'channels', name));
    const prev = data.channels[name];
    if (prev && prev.m === m) {
      channels[name] = prev;
      continue;
    }
    try {
      channels[name] = updateChannel(root, name, prev, m, now);
    } catch {
      if (prev) channels[name] = { ...prev, m: -1 };
      continue;
    }
    idx.rows.delete(`#${name}`);
    changed = true;
  }
  for (const name of Object.keys(data.channels)) {
    if (!(name in channels)) {
      idx.rows.delete(`#${name}`);
      changed = true;
    }
  }
  idx.data = { v: INDEX_VERSION, tasks, channels };
  if (changed) {
    idx.gen++;
    idx.dirty = true;
  }
  if (idx.dirty && now - idx.written >= PERSIST_MS) {
    try {
      root.writeAtomic(indexFile(root), JSON.stringify(idx.data));
      idx.dirty = false;
      idx.written = now;
    } catch {
      // The index file is optional; a failed write costs speed on the next start, not results.
    }
  }
  return idx;
}

/** The sort key: time, then id, kind and root, newest first. Also the paging cursor. */
function keyOf(i: Pick<ActivityItem, 'at' | 'id' | 'kind' | 'root'>): string {
  return `${i.at}~${i.id}~${i.kind}~${i.root}`;
}

function parseCursor(s: string): [string, string, string, string] {
  const parts = s.split('~');
  if (parts.length < 4 || !parts[0] || !parts[1]) throw new OpsError(`bad cursor '${s}'`, 2);
  return [parts[0], parts[1], parts[2]!, parts.slice(3).join('~')];
}

/** Negative when `a` comes first (is newer). */
function compare(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < 4; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? 1 : -1;
  }
  return 0;
}

function tuple(i: ActivityItem): [string, string, string, string] {
  return [i.at, i.id, i.kind, i.root];
}

function taskRows(root: string, id: string, t: TaskEntry): Row[] {
  const base = {
    kind: 'task' as const,
    root,
    task: id,
    title: t.title,
    ...(t.project ? { project: t.project } : {}),
    ...(t.archived ? { archived: true } : {}),
  };
  const head = `${id} ${t.title} ${t.project ?? ''}`.toLowerCase();
  const out: Row[] = [];
  // Creating a task writes task.md, not an event: it shows as `created`.
  const created: ActivityItem = {
    id: `created-${id}`,
    at: t.created_at,
    type: 'created',
    actor: t.created_by,
    ...(t.owner ? { to: t.owner } : {}),
    ...base,
    body: '',
  };
  out.push({ item: created, key: keyOf(created), low: head });
  for (const e of Object.values(t.events)) {
    if (!e) continue;
    const item: ActivityItem = {
      id: e.id,
      at: e.at,
      type: e.type,
      actor: e.actor,
      ...(e.to ? { to: e.to } : {}),
      ...base,
      ...(e.verdict ? { verdict: e.verdict } : {}),
      ...(e.run ? { run: e.run } : {}),
      body: e.body,
    };
    out.push({ item, key: keyOf(item), low: `${head} ${e.body.toLowerCase()}` });
  }
  return out;
}

function channelRows(root: string, name: string, c: ChannelEntry): Row[] {
  return Object.values(c.posts).map((p) => {
    const item: ActivityItem = {
      id: p.id,
      at: p.at,
      kind: 'channel',
      type: 'post',
      actor: p.actor,
      root,
      channel: name,
      ...(p.task ? { task: p.task } : {}),
      body: p.body,
    };
    const low = `#${name} ${p.task ?? ''} ${p.body}`.toLowerCase();
    return { item, key: keyOf(item), low };
  });
}

function rootRows(root: Root, idx: RootIndex): Row[] {
  const out: Row[] = [];
  for (const [id, t] of Object.entries(idx.data.tasks)) {
    let rows = idx.rows.get(id);
    if (!rows) idx.rows.set(id, (rows = taskRows(root.name, id, t)));
    for (const r of rows) out.push(r);
  }
  for (const [name, c] of Object.entries(idx.data.channels)) {
    let rows = idx.rows.get(`#${name}`);
    if (!rows) idx.rows.set(`#${name}`, (rows = channelRows(root.name, name, c)));
    for (const r of rows) out.push(r);
  }
  return out;
}

/** Every row across the roots, newest first, rebuilt only when a root changed. */
function allRows(roots: Root[]): NonNullable<typeof merged> {
  const idxs = roots.map((r) => refresh(r));
  const sig = roots.map((r, i) => `${r.dir}|${r.name}|${idxs[i]!.gen}`).join('\n');
  if (merged && merged.sig === sig) return merged;
  const rows = roots.flatMap((r, i) => rootRows(r, idxs[i]!));
  const tuples = new Map(rows.map((r) => [r, tuple(r.item)]));
  rows.sort((a, b) => compare(tuples.get(a)!, tuples.get(b)!));
  const actors = new Set<string>();
  const projects = new Set<string>();
  for (const r of rows) {
    if (r.item.actor) actors.add(r.item.actor);
    if (r.item.project) projects.add(r.item.project);
  }
  merged = { sig, rows, actors: [...actors].sort(), projects: [...projects].sort() };
  return merged;
}

/** Whether a task id matches a `task:` value: `ao-0061`, `61` or `0061`. */
function taskMatches(id: string | undefined, f: string): boolean {
  if (!id) return false;
  const low = id.toLowerCase();
  return low === f || low.endsWith(`-${f.padStart(4, '0')}`) || low.endsWith(`-${f}`);
}

function matcher(q: ActivityQuery): ((r: Row) => boolean) | null {
  const types = new Set(q.type);
  for (const k of q.kinds) for (const t of ACTIVITY_KINDS[k] ?? []) types.add(t);
  const none =
    q.words.length === 0 &&
    q.agents.length === 0 &&
    q.project.length === 0 &&
    q.root.length === 0 &&
    q.task.length === 0 &&
    types.size === 0 &&
    q.channel.length === 0 &&
    q.in.length === 0;
  if (none) return null;
  // `type:` and `kind:` narrow the same field, so together they are alternatives.
  const typed = q.type.length > 0 || q.kinds.length > 0;
  return ({ item: i, low }) =>
    (q.in.length === 0 || q.in.includes(i.kind)) &&
    (!typed || types.has(i.type)) &&
    (q.root.length === 0 || q.root.includes(i.root.toLowerCase())) &&
    (q.project.length === 0 || q.project.includes((i.project ?? '').toLowerCase())) &&
    (q.channel.length === 0 || q.channel.includes(i.channel ?? '')) &&
    (q.task.length === 0 || q.task.some((f) => taskMatches(i.task, f))) &&
    q.agents.every((f) => actorMatches(i.actor, f) || actorMatches(i.to, f)) &&
    q.words.every((w) => low.includes(w));
}

export interface ActivityOptions {
  /** A query for `parseActivityQuery`. */
  q?: string;
  /** A `next` value from the page before: items older than it. */
  before?: string;
  /** Items per page: 1 to 1000, default 100. */
  limit?: number;
}

/** One page of the activity feed across `roots`, newest first. */
export function activityPage(roots: Root[], opts: ActivityOptions = {}): ActivityPage {
  const asked = Number.isFinite(opts.limit) ? Math.floor(opts.limit!) : 100;
  const limit = Math.max(1, Math.min(asked, 1000));
  const match = matcher(parseActivityQuery(opts.q ?? ''));
  const cursor = opts.before ? parseCursor(opts.before) : null;
  const all = allRows(roots);
  const rows = all.rows;
  // The first row older than the cursor; rows are sorted, so a binary search finds it.
  let start = 0;
  if (cursor) {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compare(tuple(rows[mid]!.item), cursor) <= 0) lo = mid + 1;
      else hi = mid;
    }
    start = lo;
  }
  const items: ActivityItem[] = [];
  let total = 0;
  let more = false;
  if (!match) {
    total = rows.length;
    for (let i = start; i < rows.length && items.length < limit; i++) items.push(out(rows[i]!));
    more = start + items.length < rows.length;
  } else {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (!match(r)) continue;
      total++;
      if (i < start) continue;
      if (items.length < limit) items.push(out(r));
      else more = true;
    }
  }
  const last = items.at(-1);
  return {
    items,
    next: more && last ? keyOf(last) : null,
    total,
    actors: all.actors,
    projects: all.projects,
  };
}

/** The item as the feed shows it: a copy, with the body cut to a preview. */
function out(r: Row): ActivityItem {
  return { ...r.item, body: clipTo(r.item.body, SHOWN_CHARS) };
}
