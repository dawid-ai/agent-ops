import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RootConfig } from './config.js';
import { ID_BLOCK_SIZE, isMirrorDir, readRootConfig } from './config.js';
import { fold } from './fold.js';
import { parseDoc, stringifyDoc } from './frontmatter.js';
import { actorSlug, formatTaskId, OpsError, parseTaskId } from './ids.js';
import { withLock } from './lock.js';
import type { OpsEvent, TaskMeta, TaskState } from './model.js';
import { ulid, ulidAfter } from './ulid.js';

// 5: task states carry waitEvent. 6: task states carry the resolved project; `p` stamps it.
// 7: task states carry lastReview.
// 8: an assign with keep_wait keeps the task blocked; older builds folded it to todo.
const INDEX_VERSION = 8;

interface IndexEntry {
  tm: number;
  em: number;
  state: TaskState;
}

interface IndexFile {
  v: number;
  /** The root's project settings the states were folded with (`Root.projectStamp`). */
  p?: string;
  tasks: Record<string, IndexEntry>;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** One data root: a folder of tasks, events and config inside a git repo. */
export class Root {
  readonly config: RootConfig;

  constructor(readonly dir: string) {
    this.config = readRootConfig(dir);
  }

  get name(): string {
    return this.config.name;
  }

  get prefix(): string {
    return this.config.id_prefix;
  }

  get opsDir(): string {
    return join(this.dir, '.ops');
  }

  /**
   * The project a task reads as: the name it gives, else the root's default project (`project`,
   * else the root's name), then mapped once through `project_aliases`. Every task read goes
   * through this, so a checkout whose tasks were filed under two names shows one project.
   */
  projectName(given?: string): string {
    const name = (typeof given === 'string' && given.trim()) || this.defaultProject();
    const aliases = this.config.project_aliases;
    const to = aliases && Object.hasOwn(aliases, name) ? aliases[name] : undefined;
    return typeof to === 'string' && to.trim() ? to.trim() : name;
  }

  private defaultProject(): string {
    const p = this.config.project;
    return (typeof p === 'string' && p.trim()) || this.name;
  }

  /** Changes when the project settings change, so caches of resolved tasks know to refold. */
  get projectStamp(): string {
    return JSON.stringify([this.config.project ?? null, this.config.project_aliases ?? null]);
  }

  /** A Master Repo's copy of a project root (`<master>/mirrors/<name>/`). */
  get isMirror(): boolean {
    return isMirrorDir(this.dir);
  }

  /** The folder of a live task. */
  liveDir(id: string): string {
    return join(this.dir, 'tasks', id);
  }

  /** The folder of an archived task. */
  archiveDir(id: string): string {
    return join(this.dir, 'archive', 'tasks', id);
  }

  /** The task's folder: live when it exists there, else archived when it exists there. */
  taskDir(id: string): string {
    const live = this.liveDir(id);
    if (existsSync(join(live, 'task.md'))) return live;
    const archived = this.archiveDir(id);
    return existsSync(join(archived, 'task.md')) ? archived : live;
  }

  hasTask(id: string): boolean {
    return existsSync(join(this.taskDir(id), 'task.md'));
  }

  isArchived(id: string): boolean {
    return (
      !existsSync(join(this.liveDir(id), 'task.md')) &&
      existsSync(join(this.archiveDir(id), 'task.md'))
    );
  }

  /** Runs `fn` under a named lock in this root's `.ops/locks`. */
  lock<T>(name: string, fn: () => T): T {
    return withLock(join(this.opsDir, 'locks', `${name}.lock`), fn);
  }

  /** Writes a file by renaming a finished temp file into place, so readers never see half of it. */
  writeAtomic(path: string, content: string | Uint8Array): void {
    const tmpDir = join(this.opsDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${ulid()}.tmp`);
    if (typeof content === 'string') writeFileSync(tmp, content, 'utf8');
    else writeFileSync(tmp, content);
    this.renameRetry(tmp, path);
  }

  /** Renames, retrying while Windows holds the source or target open. */
  renameRetry(from: string, to: string): void {
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(from, to);
        return;
      } catch (err) {
        // Windows reports EPERM or EBUSY while a scanner or editor holds the target open.
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  /** Ids of live tasks (not archived). */
  listTaskIds(): string[] {
    return this.idsIn(join(this.dir, 'tasks'));
  }

  listArchivedIds(): string[] {
    return this.idsIn(join(this.dir, 'archive', 'tasks'));
  }

  private idsIn(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => parseTaskId(name)?.prefix === this.prefix);
  }

  /** Moves a task folder to `archive/tasks/`. Events and history move with it. */
  archiveTask(id: string): void {
    const to = this.archiveDir(id);
    mkdirSync(join(this.dir, 'archive', 'tasks'), { recursive: true });
    if (existsSync(to)) throw new OpsError(`${id} is already in the archive`);
    this.renameRetry(this.liveDir(id), to);
  }

  /** Moves an archived task folder back to `tasks/`. */
  unarchiveTask(id: string): void {
    if (existsSync(this.liveDir(id))) throw new OpsError(`${id} exists in tasks/ and archive/`);
    this.renameRetry(this.archiveDir(id), this.liveDir(id));
  }

  /** Folds every archived task. Archived tasks are read rarely, so they have no cache. */
  archivedStates(): TaskState[] {
    return this.listArchivedIds().map((id) =>
      fold(this.readTaskAt(this.archiveDir(id), id).meta, this.readEventsAt(this.archiveDir(id))),
    );
  }

  readTask(id: string): { meta: TaskMeta; body: string } {
    return this.readTaskAt(this.taskDir(id), id);
  }

  /**
   * The project a task's `task.md` names, old names mapped, or undefined when it names none. A
   * task that inherits it keeps following the root's default project when its source does.
   */
  namedProject(id: string): string | undefined {
    const p = this.parseTaskAt(this.taskDir(id), id).data.project;
    return typeof p === 'string' && p.trim() ? this.projectName(p) : undefined;
  }

  private parseTaskAt(dir: string, id: string): { data: TaskMeta; body: string } {
    const file = join(dir, 'task.md');
    if (!existsSync(file)) throw new OpsError(`no task ${id} in root '${this.name}'`, 2);
    return parseDoc<TaskMeta>(readFileSync(file, 'utf8'));
  }

  private readTaskAt(dir: string, id: string): { meta: TaskMeta; body: string } {
    const doc = this.parseTaskAt(dir, id);
    const meta: TaskMeta = {
      ...doc.data,
      id,
      priority: doc.data.priority ?? 'p2',
      type: doc.data.type ?? 'task',
      project: this.projectName(doc.data.project),
    };
    return { meta, body: doc.body };
  }

  readEvents(id: string): OpsEvent[] {
    return this.readEventsAt(this.taskDir(id));
  }

  private readEventsAt(taskDir: string): OpsEvent[] {
    const dir = join(taskDir, 'events');
    if (!existsSync(dir)) return [];
    const events: OpsEvent[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const doc = parseDoc<Omit<OpsEvent, 'id' | 'body'>>(readFileSync(join(dir, name), 'utf8'));
      events.push({ ...doc.data, id: name.slice(0, 26), body: doc.body } as OpsEvent);
    }
    return events.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  foldTask(id: string): TaskState {
    return fold(this.readTask(id).meta, this.readEvents(id));
  }

  /** Creates a task folder with the next free id in this machine's block. */
  createTask(meta: Omit<TaskMeta, 'id'>, body: string, idBlock = 0): TaskMeta {
    const tasksDir = join(this.dir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const lo = idBlock * ID_BLOCK_SIZE;
    const hi = lo + ID_BLOCK_SIZE;
    let n = lo;
    // Archived ids stay taken, so an id never names two tasks.
    for (const id of [...this.listTaskIds(), ...this.listArchivedIds()]) {
      const num = parseTaskId(id)!.n;
      if (num > n && num < hi) n = num;
    }
    for (;;) {
      n++;
      if (n >= hi) throw new OpsError(`id block ${idBlock} is full in root '${this.name}'`);
      const id = formatTaskId(this.prefix, n);
      if (existsSync(this.archiveDir(id))) continue;
      try {
        mkdirSync(this.liveDir(id));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      mkdirSync(join(this.liveDir(id), 'events'));
      const full: TaskMeta = { id, ...meta };
      this.writeAtomic(join(this.liveDir(id), 'task.md'), stringifyDoc(full, body));
      return full;
    }
  }

  /** Writes one new event file. Event files are never edited after this. */
  appendEvent(taskId: string, ev: Omit<OpsEvent, 'id'>, atMs: number = Date.now()): OpsEvent {
    if (!this.hasTask(taskId)) throw new OpsError(`no task ${taskId} in root '${this.name}'`, 2);
    const dir = join(this.taskDir(taskId), 'events');
    mkdirSync(dir, { recursive: true });
    const id = ulidAfter(newestEventId(dir), atMs);
    const { body, ...front } = ev;
    this.writeAtomic(join(dir, `${id}-${actorSlug(ev.actor)}.md`), stringifyDoc(front, body));
    return { ...ev, id };
  }

  /**
   * Returns the folded state of every task. A cache in `.ops/index.json` keeps each task's fold
   * with the mtimes of its task.md and events folder; only changed tasks are folded again.
   */
  states(): TaskState[] {
    const indexFile = join(this.opsDir, 'index.json');
    let index: IndexFile = { v: INDEX_VERSION, tasks: {} };
    try {
      const raw = JSON.parse(readFileSync(indexFile, 'utf8')) as IndexFile;
      // States folded under other project settings name the old projects: refold them all.
      if (raw.v === INDEX_VERSION && raw.p === this.projectStamp) index = raw;
    } catch {
      // No cache yet, or a damaged one: rebuild.
    }
    let dirty = false;
    const next: Record<string, IndexEntry> = {};
    const out: TaskState[] = [];
    for (const id of this.listTaskIds()) {
      const dir = this.liveDir(id);
      // Read the mtimes before the files, so a write that lands in between shows up next time.
      const tm = mtime(join(dir, 'task.md'));
      if (tm === 0) continue;
      const em = mtime(join(dir, 'events'));
      const cached = index.tasks[id];
      let entry: IndexEntry;
      if (cached && cached.tm === tm && cached.em === em) {
        entry = cached;
      } else {
        // Like git's racy-timestamp rule: a folder changed in the last 2 s may change again
        // within the same mtime tick, so its entry is refolded on the next read.
        const racy = Date.now() - Math.max(tm, em) < 2000;
        entry = { tm: racy ? -1 : tm, em, state: this.foldTask(id) };
        dirty = true;
      }
      next[id] = entry;
      out.push(entry.state);
    }
    if (dirty || Object.keys(index.tasks).length !== Object.keys(next).length) {
      try {
        const file: IndexFile = { v: INDEX_VERSION, p: this.projectStamp, tasks: next };
        this.writeAtomic(indexFile, JSON.stringify(file));
      } catch {
        // The cache is optional; a failed write costs speed, not correctness.
      }
    }
    return out;
  }

  /**
   * The token of this clone's last claim on a task. Local state in `.ops/claims/`, never committed: it
   * tells two runs with the same agent id on different clones apart.
   */
  myClaim(task: string): string | undefined {
    return this.claimRecord(task).token;
  }

  /** This clone's record of its claim on the task: the claim token and the run that took it. */
  claimRecord(task: string): { token?: string; run?: string } {
    try {
      return JSON.parse(readFileSync(this.claimFile(task), 'utf8')) as {
        token?: string;
        run?: string;
      };
    } catch {
      return {};
    }
  }

  /**
   * Called under the task's lock; each task has its own file, so claims never overwrite. `run` is
   * the supervised run that claimed, so two live runs with one agent id stay apart.
   */
  rememberClaim(task: string, token: string, run?: string): void {
    mkdirSync(join(this.opsDir, 'claims'), { recursive: true });
    this.writeAtomic(this.claimFile(task), JSON.stringify(run ? { token, run } : { token }));
  }

  private claimFile(task: string): string {
    return join(this.opsDir, 'claims', `${task}.json`);
  }

  readMarker(actor: string): string {
    try {
      const raw = JSON.parse(
        readFileSync(join(this.opsDir, 'read', `${actorSlug(actor)}.json`), 'utf8'),
      ) as { last?: string };
      return raw.last ?? '';
    } catch {
      return '';
    }
  }

  writeMarker(actor: string, last: string): void {
    mkdirSync(join(this.opsDir, 'read'), { recursive: true });
    this.writeAtomic(
      join(this.opsDir, 'read', `${actorSlug(actor)}.json`),
      JSON.stringify({ last }),
    );
  }
}

/** The newest event id in a task's events folder, from the file names. */
export function newestEventId(eventsDir: string): string | undefined {
  let newest: string | undefined;
  for (const name of readdirSync(eventsDir)) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, 26);
    if (!newest || id > newest) newest = id;
  }
  return newest;
}
