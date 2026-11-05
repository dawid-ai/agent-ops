// The Agent Ops Master Repo: project roots that opt in (`mirror: true`) are copied to
// `<master>/mirrors/<name>/` and kept in step both ways by every sync on a machine that has both.
//
// Event files are immutable and uniquely named, so the copy is a union of files. Only stable
// events cross: pushed ones (in the upstream tree) or ones that crossed before. An unpushed event
// can still be renamed by push ordering, so it waits for the next sync. Events that crossed keep
// their names on both sides: each side lists them in `.ops/mirrored.json`, push ordering treats
// them as pushed, and this clone's own unpushed events on the task are renamed above them, as for
// events from the remote. Both sides then hold the same files and fold the same state.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import type { UserConfig } from './config.js';
import { rootDirOf, samePath } from './config.js';
import { parseDoc } from './frontmatter.js';
import { OpsError } from './ids.js';
import { Root } from './root.js';
import type { LostClaim, SyncOptions, SyncResult } from './sync.js';
import {
  lostClaims,
  orderLocalEvents,
  readMirrored,
  storeCommitHold,
  syncRoot,
  writeMirrored,
} from './sync.js';
import { isUlid } from './ulid.js';

export interface MirrorResult {
  project: string;
  /** Files copied into the Master Repo's copy. */
  toMaster: number;
  /** Files copied into the project root. */
  toProject: number;
  /** Local events renamed to sort after events that came across. */
  reordered: number;
  lost: LostClaim[];
  notes: string[];
}

/** One side of a mirror: the data root that holds the tasks and the repo that syncs them. */
interface Side {
  /** The project root, or the Master Repo's copy of it. */
  root: Root;
  /** The root whose sync commits and pushes this repo: the project root, or the Master Repo. */
  owner: Root;
  top: string;
  upstream: boolean;
  kept: Set<string>;
  keptChanged: boolean;
  /** Tasks that got files from the other side. */
  touched: Set<string>;
  copied: number;
  renamed: string[];
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function posix(p: string): string {
  return p.split(sep).join('/');
}

function side(root: Root, owner: Root): Side {
  const top = (git(root.dir, ['rev-parse', '--show-toplevel']) ?? '').trim();
  if (!top) throw new Error(`${root.dir} is not inside a git repo`);
  return {
    root,
    owner,
    top,
    upstream: git(top, ['rev-parse', '--abbrev-ref', '@{u}']) !== null,
    kept: readMirrored(owner),
    keptChanged: false,
    touched: new Set(),
    copied: 0,
    renamed: [],
  };
}

/**
 * The folders a mirror may read and write: the two data roots of the pair. Set for the length of
 * one mirrorPair call (it is synchronous). Links in a synced repo could point anywhere, so a path
 * counts only when it is inside a fence folder and nothing between that folder and the path is a
 * symlink or junction.
 */
let fence: string[] = [];

function linkFree(path: string): boolean {
  const abs = resolve(path);
  for (const top of fence) {
    const rel = relative(top, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    let cur = top;
    for (const part of rel ? rel.split(sep) : []) {
      cur = join(cur, part);
      try {
        if (lstatSync(cur).isSymbolicLink()) return false;
      } catch {
        // Not there yet: nothing below it can be a link.
        return true;
      }
    }
    return true;
  }
  return false;
}

/** Throws unless a write to `path` stays inside the pair's roots and passes through no link. */
function writable(path: string): void {
  if (!linkFree(path)) {
    throw new OpsError(
      `mirror: refusing to write ${path}: outside the data roots or through a link`,
      1,
    );
  }
}

/** True for a plain file, never a link, inside the pair's roots. */
function plainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile() && linkFree(path);
  } catch {
    return false;
  }
}

function plainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && linkFree(path);
  } catch {
    return false;
  }
}

function files(dir: string): string[] {
  if (!plainDir(dir)) return [];
  return readdirSync(dir).filter((n) => plainFile(join(dir, n)));
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Event file names in a folder that can cross: pushed, or crossed before. */
function stableEvents(s: Side, dir: string): Set<string> {
  const names = files(dir).filter((n) => n.endsWith('.md') && isUlid(n.slice(0, 26)));
  // Without an upstream nothing is ever renamed, so every file is final.
  if (!s.upstream) return new Set(names);
  const rel = posix(relative(s.top, dir));
  const pushed = new Set(
    (git(s.top, ['ls-tree', '-r', '--name-only', '@{u}', '--', rel]) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((p) => p.slice(rel.length + 1)),
  );
  return new Set(names.filter((n) => pushed.has(n) || s.kept.has(`${rel}/${n}`)));
}

/** Copies one file into a side and pins it there as final. */
function copyIn(s: Side, from: string, to: string, pin: boolean): void {
  writable(to);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  s.copied++;
  if (pin) {
    s.kept.add(posix(relative(s.top, to)));
    s.keptChanged = true;
  }
}

interface TaskSide {
  exists: boolean;
  archived: boolean;
  md: string | null;
  dir: string;
}

function taskSide(root: Root, id: string): TaskSide {
  const live = root.liveDir(id);
  const archive = root.archiveDir(id);
  const archived = !existsSync(join(live, 'task.md')) && existsSync(join(archive, 'task.md'));
  const dir = archived ? archive : live;
  const file = join(dir, 'task.md');
  const md = plainFile(file) ? readFileSync(file, 'utf8') : null;
  return { exists: md !== null, archived, md, dir };
}

interface Base {
  md: string;
  archived: boolean;
}

function creator(md: string): string {
  const data = parseDoc<{ created_by?: string; created_at?: string }>(md).data;
  return `${data.created_by ?? ''}|${data.created_at ?? ''}`;
}

/** Copies one task both ways. An id clash is reported and left alone. */
function mirrorTask(
  id: string,
  p: Side,
  m: Side,
  bases: Record<string, Base>,
  now: number,
  notes: string[],
): void {
  const a = taskSide(p.root, id);
  const b = taskSide(m.root, id);
  const base = bases[id];
  if (a.exists && b.exists && !base && a.md !== b.md && creator(a.md!) !== creator(b.md!)) {
    notes.push(
      `${p.root.name}/${id}: different tasks with one id in the project root and the Master Repo; ` +
        'not mirrored (give each machine its own id_block)',
    );
    return;
  }

  // Where the task lives: the side that changed since the last mirror wins; else the project.
  let archived = a.exists ? a.archived : b.archived;
  if (a.exists && b.exists && a.archived !== b.archived) {
    archived = base && a.archived === base.archived ? b.archived : a.archived;
  }
  for (const [s, t] of [
    [p, a],
    [m, b],
  ] as const) {
    if (!t.exists || t.archived === archived) continue;
    writable(join(s.root.archiveDir(id), 'task.md'));
    writable(join(s.root.liveDir(id), 'task.md'));
    if (archived) s.root.archiveTask(id);
    else s.root.unarchiveTask(id);
  }

  // task.md: the side that changed since the last mirror wins; both changed, the project wins.
  let md = a.md ?? b.md!;
  if (a.md !== null && b.md !== null && a.md !== b.md) {
    if (base && hash(a.md) === base.md) md = b.md;
    else if (base && hash(b.md) !== base.md) {
      notes.push(`${p.root.name}/${id}: task.md changed on both sides; kept the project root's`);
    }
  }
  const dirOf = (s: Side): string => (archived ? s.root.archiveDir(id) : s.root.liveDir(id));
  for (const s of [p, m]) {
    const file = join(dirOf(s), 'task.md');
    const current = plainFile(file) ? readFileSync(file, 'utf8') : null;
    if (current === md) continue;
    writable(file);
    mkdirSync(dirOf(s), { recursive: true });
    writeFileSync(file, md);
    s.copied++;
    s.touched.add(id);
  }

  // Events: stable files the other side lacks.
  for (const [from, to] of [
    [p, m],
    [m, p],
  ] as const) {
    const fromDir = join(dirOf(from), 'events');
    const toDir = join(dirOf(to), 'events');
    const have = new Set(files(toDir));
    let got = false;
    for (const name of stableEvents(from, fromDir)) {
      if (have.has(name)) continue;
      copyIn(to, join(fromDir, name), join(toDir, name), true);
      from.kept.add(posix(relative(from.top, join(fromDir, name))));
      from.keptChanged = true;
      got = true;
    }
    if (!got) continue;
    to.touched.add(id);
    // Like events from the remote: this clone's unpushed events on the task go after them.
    const rel = posix(relative(to.top, toDir));
    const pushed = new Set<string>();
    if (to.upstream) {
      for (const f of (git(to.top, ['ls-tree', '-r', '--name-only', '@{u}', '--', rel]) ?? '')
        .split('\n')
        .filter(Boolean)) {
        pushed.add(f.slice(rel.length + 1, rel.length + 27));
      }
    }
    for (const k of to.kept)
      if (k.startsWith(`${rel}/`)) pushed.add(k.slice(rel.length + 1, rel.length + 27));
    if (!to.upstream) {
      // Nothing is pushed anywhere: every file is final, so nothing moves.
      for (const n of files(toDir)) pushed.add(n.slice(0, 26));
    }
    const res = orderLocalEvents(to.root, id, to.top, rel, pushed, now);
    to.renamed.push(...res.renamed);
  }
  bases[id] = { md: hash(md), archived };
}

/** Copies plain files one folder lacks from the other, both ways (channels, learn notes). */
function unionDir(p: Side, m: Side, rel: string): void {
  const walk = (dir: string, out: string[], prefix = ''): void => {
    if (!plainDir(dir)) return;
    for (const n of readdirSync(dir)) {
      const full = join(dir, n);
      if (plainDir(full)) walk(full, out, `${prefix}${n}/`);
      else if (plainFile(full)) out.push(`${prefix}${n}`);
    }
  };
  for (const [from, to] of [
    [p, m],
    [m, p],
  ] as const) {
    const list: string[] = [];
    walk(join(from.root.dir, rel), list);
    for (const f of list) {
      const dest = join(to.root.dir, rel, f);
      if (existsSync(dest)) continue;
      copyIn(to, join(from.root.dir, rel, f), dest, false);
    }
  }
}

/** Copies plain files from the project to the copy when missing or different. */
function oneWay(p: Side, m: Side, rel: string): void {
  const src = join(p.root.dir, rel);
  if (plainFile(src)) {
    const dest = join(m.root.dir, rel);
    const body = readFileSync(src);
    if (plainFile(dest) && readFileSync(dest).equals(body)) return;
    writable(dest);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    m.copied++;
    return;
  }
  for (const n of files(src)) oneWay(p, m, join(rel, n));
}

/**
 * Keeps a project root and its copy in the Master Repo in step: tasks both ways, channels and
 * learn notes both ways, config.yml and agents/ from the project only. Creates the copy on
 * first use. Run between pull and push of both repos; commits come from their next sync.
 */
export function mirrorPair(project: Root, master: Root, opts: { now?: number } = {}): MirrorResult {
  const skip = (note: string): MirrorResult => ({
    project: project.name,
    toMaster: 0,
    toProject: 0,
    reordered: 0,
    lost: [],
    notes: [note],
  });
  // The name comes from a file in the repo: it names a folder, so it must be one plain segment.
  if (!MIRROR_NAME.test(project.name)) {
    return skip(
      `${project.name}: not mirrored; a mirrored root's name uses letters, digits, '.', '_' and '-'`,
    );
  }
  const dir = join(master.dir, 'mirrors', project.name);
  fence = [resolve(master.dir)];
  try {
    // A mirror commits renamed events in both checkouts: only on their store branches.
    for (const r of [project, master]) {
      const hold = storeCommitHold(r);
      if (hold) return skip(`${r.name}: not mirrored; ${hold.replace(/^not synced: /, '')}`);
    }
    if (!existsSync(join(dir, 'config.yml'))) {
      writable(join(dir, 'config.yml'));
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(project.dir, 'config.yml'), join(dir, 'config.yml'));
      writable(join(dir, '.gitignore'));
      writeFileSync(join(dir, '.gitignore'), '.ops/\n');
    } else if (!plainFile(join(dir, 'config.yml'))) {
      return skip(`${dir}: not mirrored; it is reached through a link`);
    }
    // The project root and the Master Repo (its copy and its .ops state) are the only places a
    // mirror touches.
    fence = [resolve(project.dir), resolve(master.dir)];
    // The mirror's own state lives in .ops folders: those must not be links either.
    for (const ops of [project.opsDir, master.opsDir, join(dir, '.ops')]) {
      if (existsSync(ops) && !plainDir(ops)) {
        return skip(`${ops}: not mirrored; the folder is reached through a link`);
      }
      writable(join(ops, 'state.json'));
    }
    return mirrorFenced(project, master, dir, opts.now ?? Date.now());
  } catch (err) {
    if (err instanceof OpsError) return skip(err.message);
    throw err;
  } finally {
    fence = [];
  }
}

const MIRROR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function mirrorFenced(project: Root, master: Root, dir: string, now: number): MirrorResult {
  const notes: string[] = [];
  const copy = new Root(dir);
  if (copy.name !== project.name || copy.prefix !== project.prefix) {
    return {
      project: project.name,
      toMaster: 0,
      toProject: 0,
      reordered: 0,
      lost: [],
      notes: [`${dir} holds another root (${copy.name}); not mirrored`],
    };
  }
  const p = side(project, project);
  const m = side(copy, master);

  oneWay(p, m, 'config.yml');
  oneWay(p, m, 'agents');

  const baseFile = join(project.opsDir, `mirror-base.json`);
  let bases: Record<string, Base> = {};
  try {
    bases = JSON.parse(readFileSync(baseFile, 'utf8')) as Record<string, Base>;
  } catch {
    // First mirror on this machine.
  }
  const ids = new Set([
    ...project.listTaskIds(),
    ...project.listArchivedIds(),
    ...copy.listTaskIds(),
    ...copy.listArchivedIds(),
  ]);
  for (const id of [...ids].sort()) mirrorTask(id, p, m, bases, now, notes);
  project.writeAtomic(baseFile, JSON.stringify(bases));

  unionDir(p, m, 'channels');
  unionDir(p, m, 'kb');
  unionDir(p, m, 'attachments');

  for (const s of [p, m]) {
    if (s.keptChanged) writeMirrored(s.owner, s.kept);
    if (s.renamed.length > 0) {
      git(s.top, ['add', '-A', '--', ...s.renamed]);
      git(s.top, [
        'commit',
        '-q',
        '-m',
        `ops: order ${s.renamed.length / 2} local event(s) after mirrored ones`,
        '--',
        ...s.renamed,
      ]);
    }
  }
  const lost = lostClaims([
    ...[...p.touched].map((task) => ({ root: project, task })),
    ...[...m.touched].map((task) => ({ root: copy, task })),
  ]);
  return {
    project: project.name,
    toMaster: m.copied,
    toProject: p.copied,
    reordered: (p.renamed.length + m.renamed.length) / 2,
    lost,
    notes,
  };
}

/** The Master Repo among the roots, when the user config names one. */
export function masterRoot(roots: Root[], user: UserConfig): Root | undefined {
  if (!user.master) return undefined;
  const dir = rootDirOf(user.master);
  return roots.find((r) => samePath(r.dir, dir));
}

/** Project roots that mirror into the Master Repo. */
export function mirrorPairs(roots: Root[], user: UserConfig): Array<[Root, Root]> {
  const master = masterRoot(roots, user);
  if (!master) return [];
  return roots
    .filter((r) => r !== master && !r.isMirror && r.config.mirror === true)
    .map((r) => [r, master]);
}

function merge(into: SyncResult, more: SyncResult): void {
  into.committed += more.committed;
  into.pulled ||= more.pulled;
  into.pushed ||= more.pushed;
  into.reordered += more.reordered;
  into.lost.push(...more.lost);
  into.notes.push(...more.notes);
}

/**
 * Syncs roots, then mirrors each project root that opts in with the Master Repo, then syncs again
 * the roots that got files from the mirror, so they are committed (and pushed when the policy
 * pushes). Mirror roots are synced by their Master Repo, never on their own.
 */
export function syncAll(
  roots: Root[],
  user: UserConfig,
  opts: SyncOptions = {},
): Array<{ root: Root; result: SyncResult; mirror?: MirrorResult }> {
  const master = masterRoot(roots, user);
  const inMaster = (r: Root): boolean =>
    master !== undefined && r.isMirror && samePath(dirname(dirname(r.dir)), master.dir);
  const out = new Map<Root, { root: Root; result: SyncResult; mirror?: MirrorResult }>();
  const run = (r: Root): void => {
    const result = syncRoot(r, user, opts);
    const prev = out.get(r);
    if (prev) merge(prev.result, result);
    else out.set(r, { root: r, result });
  };
  for (const r of roots) if (!inMaster(r)) run(r);
  for (const [project, m] of mirrorPairs(roots, user)) {
    const res = mirrorPair(project, m, { now: opts.now });
    if (res.toProject > 0 || res.reordered > 0) run(project);
    if (res.toMaster > 0 || res.reordered > 0) run(m);
    const entry = out.get(project);
    if (entry) {
      entry.mirror = res;
      entry.result.lost.push(...res.lost);
      entry.result.notes.push(...res.notes);
    }
  }
  return [...out.values()];
}

/** The roots a sync of `root` must include: its Master Repo or its mirrored project, if any. */
export function mirrorPartners(root: Root, roots: Root[], user: UserConfig): Root[] {
  const master = masterRoot(roots, user);
  if (!master) return [root];
  if (root === master) return [root];
  if (root.config.mirror === true && !root.isMirror) return [root, master];
  if (root.isMirror && samePath(dirname(dirname(root.dir)), master.dir)) return [master];
  return [root];
}

/**
 * Turns mirroring into the Master Repo on or off for a project root, in its config.yml (shared:
 * the next sync commits it). Returns whether the file changed.
 */
export function setRootMirror(root: Root, on: boolean, master?: Root): boolean {
  if (root.isMirror)
    throw new OpsError(
      `${root.name} is a Master Repo copy; turn mirroring on in the project root`,
      2,
    );
  if (master && samePath(root.dir, master.dir)) {
    throw new OpsError(`${root.name} is the Master Repo itself`, 2);
  }
  if ((root.config.mirror === true) === on) return false;
  const file = join(root.dir, 'config.yml');
  const doc = YAML.parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) throw new OpsError(`${file} does not parse; fix it by hand`, 2);
  if (on) doc.set('mirror', true);
  else doc.delete('mirror');
  root.writeAtomic(file, doc.toString());
  return true;
}
