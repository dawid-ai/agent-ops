import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { UserConfig } from './config.js';
import { OpsError } from './ids.js';
import { Root } from './root.js';
import { scanFiles } from './secrets.js';
import { isUlid, ulidAfter } from './ulid.js';

export interface SyncOptions {
  pull?: boolean;
  push?: boolean;
  /** Pull and push only when the root's policy says they are due. */
  auto?: boolean;
  /** Session end or context compaction: push now, whatever the policy. */
  sessionEnd?: boolean;
  /** Push even when unpushed commits touch files outside the root. */
  allPaths?: boolean;
  now?: number;
}

/** A claim made on this clone that lost to a claim pushed first from elsewhere. */
export interface LostClaim {
  /** The root the task lives in: a mirror root's name for a task in the Master Repo's copy. */
  root: string;
  task: string;
  actor: string;
  /** Who holds the task now, if anyone. */
  winner: string | null;
  event: string;
}

export interface SyncResult {
  committed: number;
  pulled: boolean;
  pushed: boolean;
  /** Local event files renamed to sort after the events that came from the remote. */
  reordered: number;
  lost: LostClaim[];
  notes: string[];
}

interface SyncStamp {
  lastPull?: number;
  lastPush?: number;
  /** The store branch this clone learned on its first sync, when config.yml names none. */
  branch?: string;
}

/** How many times a push rejected by a newer remote is retried after pulling again. */
const PUSH_ATTEMPTS = 3;

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new OpsError(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`);
  }
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function readStamp(root: Root): SyncStamp {
  try {
    return JSON.parse(readFileSync(join(root.opsDir, 'sync.json'), 'utf8')) as SyncStamp;
  } catch {
    return {};
  }
}

/**
 * Whether `head` may become this clone's store branch when nothing names one yet: null when it
 * may, else why not.
 *
 * The store's own history decides, not what happens to be checked out: the local branch holding
 * the newest store commit (`ops: ...` under `rel`) is the store branch. `head` qualifies only when
 * it is the one branch that holds that commit, or when no branch holds a store commit yet (a new
 * store starts on the branch it is first committed to). A code branch made from the store branch
 * ties with it until one of them moves; the tie goes to the one branch with an upstream, and with
 * no such branch the first sync holds instead of guessing.
 */
function firstStoreBranchHold(top: string, rel: string, head: string): string | null {
  const newest = (grep: string[]): string =>
    git(top, ['log', '--branches', '-1', '--format=%H', ...grep, '--', rel]).trim();
  let tip: string;
  try {
    tip = newest(['--grep=^ops: ']) || newest([]);
  } catch {
    tip = '';
  }
  if (!tip) return null;
  const refs = git(top, [
    'for-each-ref',
    '--contains',
    tip,
    '--format=%(refname:short) %(upstream)',
    'refs/heads',
  ])
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter(([b]) => b);
  const holders = refs.map(([b]) => b!);
  // On a tie, a branch that pushes somewhere beats local-only branches made from it.
  const tracked = refs.filter(([, up]) => up).map(([b]) => b!);
  const pick = holders.length === 1 ? holders : tracked;
  if (pick.length === 1 && pick[0] === head) return null;
  const others = holders.filter((b) => b !== head);
  const why = holders.includes(head)
    ? `${others.join(', ')} also hold${others.length === 1 ? 's' : ''} the newest store commit`
    : `the newest store commit is on ${others.join(', ')}, not ${head}`;
  return (
    `not synced: no store branch is known yet and ${why}; ` +
    `set sync.branch in config.yml to the store branch and sync again`
  );
}

/**
 * Why the checkout at `top` may not take store commits now, or null when it may.
 *
 * Store commits go only to the store branch: `sync.branch` in config.yml, else the branch this
 * clone learned on its first sync (kept in `.ops/sync.json`; `learn` records it; see
 * {@link firstStoreBranchHold}). A commit made while a code branch is checked out in the data
 * root's checkout lands on that branch, and switching back to the store branch removes its files
 * from disk. Held files stay uncommitted on disk instead, and the next sync on the store branch
 * commits them.
 */
function storeBranchHold(root: Root, top: string, stamp: SyncStamp, learn: boolean): string | null {
  let head: string;
  try {
    head = git(top, ['symbolic-ref', '-q', '--short', 'HEAD']).trim();
  } catch {
    head = '';
  }
  const want = root.config.sync.branch ?? stamp.branch;
  if (!head) {
    return `not synced: HEAD is detached; check out ${want ?? 'the store branch'} and sync again`;
  }
  if (!want) {
    const rel = relative(top, root.dir).split(sep).join('/') || '.';
    const hold = firstStoreBranchHold(top, rel, head);
    if (hold) return hold;
    if (learn) stamp.branch = head;
    return null;
  }
  if (head === want) return null;
  const from = root.config.sync.branch ? 'sync.branch in config.yml' : '.ops/sync.json';
  return (
    `not synced: ${head} is checked out, but the store branch is ${want} (from ${from}); ` +
    `check out ${want} and sync again, or set sync.branch in config.yml`
  );
}

/**
 * The branch the root's checkout must keep checked out for store commits: `sync.branch` in
 * config.yml, else the branch this clone learned on its first sync, else null (none known yet).
 */
export function storeBranch(root: Root): string | null {
  return root.config.sync.branch ?? readStamp(root).branch ?? null;
}

/**
 * Why the root's checkout may not take store commits now, or null when it may. Read-only: it
 * never records a store branch. See {@link syncRoot}.
 */
export function storeCommitHold(root: Root): string | null {
  const top = git(root.dir, ['rev-parse', '--show-toplevel']).trim();
  return storeBranchHold(root, top, readStamp(root), false);
}

/** Decides what an automatic sync does now under the root's policy. */
export function dueActions(
  root: Root,
  stamp: SyncStamp,
  now: number,
): { pull: boolean; push: boolean } {
  const { policy, pull_minutes, push_minutes } = root.config.sync;
  if (policy === 'manual') return { pull: false, push: false };
  const pullEvery = policy === 'coordinated' ? Math.min(pull_minutes, 2) : pull_minutes;
  return {
    pull: now - (stamp.lastPull ?? 0) >= pullEvery * 60_000,
    push: now - (stamp.lastPush ?? 0) >= push_minutes * 60_000,
  };
}

/**
 * A task event file path, relative to the repo top:
 * `<rel>/[mirrors/<name>/][archive/]tasks/<ID>/events/<ULID>-<actor>.md`.
 */
interface EventPath {
  /** The task's events folder, relative to the repo top. */
  dir: string;
  task: string;
  id: string;
  /** Set for a task in a Master Repo's copy of a project root. */
  mirror?: string;
}

function eventPaths(paths: string[], prefix: string): EventPath[] {
  const out: EventPath[] = [];
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const m =
      /^((?:mirrors\/([^/]+)\/)?(?:archive\/)?tasks\/([^/]+)\/events)\/([0-9A-Za-z]{26})-[^/]+\.md$/.exec(
        p.slice(prefix.length),
      );
    if (!m || !isUlid(m[4]!)) continue;
    out.push({ dir: prefix + m[1]!, task: m[3]!, id: m[4]!, mirror: m[2] });
  }
  return out;
}

/** A task whose events changed in a sync, with the root it lives in (a mirror root or the root). */
interface Touched {
  root: Root;
  task: string;
}

/** Files this clone copied in from a mirror: final names, never renamed by push ordering. */
const MIRRORED = 'mirrored.json';

export function readMirrored(root: Root): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(join(root.opsDir, MIRRORED), 'utf8')) as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeMirrored(root: Root, paths: Set<string>): void {
  root.writeAtomic(join(root.opsDir, MIRRORED), JSON.stringify([...paths].sort()));
}

/**
 * Renames this clone's local events in one task folder to ids above the newest pushed one, in
 * their local order. `pushed` holds the ids that may not change: in the upstream tree, or copied
 * in from a mirror. Returns the tracked paths renamed, as old and new pairs.
 */
export function orderLocalEvents(
  lockRoot: Root,
  task: string,
  top: string,
  dir: string,
  pushed: Set<string>,
  now: number,
): { renamed: string[]; count: number } {
  const renamed: string[] = [];
  let count = 0;
  const abs = join(top, dir);
  if (!existsSync(abs)) return { renamed, count };
  lockRoot.lock(`task-${task}`, () => {
    const files = readdirSync(abs)
      .filter((n) => n.endsWith('.md') && isUlid(n.slice(0, 26)))
      .sort();
    const local = files.filter((n) => !pushed.has(n.slice(0, 26)));
    if (local.length === 0) return;
    const newestPushed = files
      .filter((n) => pushed.has(n.slice(0, 26)))
      .pop()
      ?.slice(0, 26);
    if (!newestPushed || local[0]!.slice(0, 26) > newestPushed) return;
    const tracked = new Set(lines(git(top, ['ls-files', '--', dir])));
    let prev = newestPushed;
    for (const name of local) {
      const id = ulidAfter(prev, now);
      prev = id;
      const next = id + name.slice(26);
      renameSync(join(abs, name), join(abs, next));
      const oldPath = `${dir}/${name}`;
      if (tracked.has(oldPath)) renamed.push(oldPath, `${dir}/${next}`);
      count++;
    }
  });
  return { renamed, count };
}

/** Commits renames from push ordering, so the next push carries them. */
function commitRenames(top: string, renamed: string[]): void {
  if (renamed.length === 0) return;
  git(top, ['add', '-A', '--', ...renamed]);
  git(top, [
    'commit',
    '-q',
    '-m',
    `ops: order ${renamed.length / 2} local event(s) after remote`,
    '--',
    ...renamed,
  ]);
}

function lines(s: string): string[] {
  return s.split('\n').filter(Boolean);
}

/**
 * Fetches, rebases local commits onto the upstream, then puts local events after remote ones.
 *
 * Events fold in id order. An event written here before a remote event was pushed can carry an
 * older id, so a claim made earlier on this clone but pushed later would win after the fact. For
 * every task that got remote events, the events this clone has not pushed are renamed to fresh
 * ids above the newest pushed one, in their local order. Pushed files never change, so every
 * clone folds the same order, and it equals push order: the claim pushed first wins.
 */
function pullAndOrder(
  root: Root,
  top: string,
  prefix: string,
  now: number,
  result: SyncResult,
  touched: Map<string, Touched>,
): void {
  git(top, ['fetch', '-q']);
  const base = git(top, ['merge-base', 'HEAD', '@{u}']).trim();
  const scope = prefix ? [prefix.replace(/\/$/, '')] : ['.'];
  const incoming = eventPaths(
    lines(git(top, ['diff', '--name-only', '--diff-filter=A', base, '@{u}', '--', ...scope])),
    prefix,
  );
  if (git(top, ['rev-parse', '@{u}']).trim() !== base) {
    try {
      git(top, ['rebase', '-q', '--autostash', '@{u}']);
    } catch (err) {
      if (!settleTaskMdConflicts(root, top, prefix, result)) {
        gitOk(top, ['rebase', '--abort']);
        throw err;
      }
    }
  }
  result.pulled = true;
  if (incoming.length === 0) return;

  const byDir = new Map<string, EventPath>();
  for (const e of incoming) byDir.set(e.dir, e);
  const mirrored = readMirrored(root);
  const renamed: string[] = [];
  for (const [dir, e] of byDir) {
    const owner = e.mirror ? new Root(join(root.dir, 'mirrors', e.mirror)) : root;
    touched.set(dir, { root: owner, task: e.task });
    // Pushed events are the ones in the upstream tree, plus files copied in from a mirror; the
    // rest of the folder is local, committed or not.
    const pushed = new Set(
      eventPaths(lines(git(top, ['ls-tree', '-r', '--name-only', '@{u}', '--', dir])), prefix).map(
        (x) => x.id,
      ),
    );
    for (const p of mirrored) {
      if (p.startsWith(`${dir}/`)) pushed.add(p.slice(dir.length + 1, dir.length + 27));
    }
    const res = orderLocalEvents(owner, e.task, top, dir, pushed, now);
    renamed.push(...res.renamed);
    result.reordered += res.count;
  }
  commitRenames(top, renamed);
}

/**
 * This clone's current claims, on tasks that got remote events, that lost to a claim pushed first.
 * Read from the final state, after every pull of the sync: a claim that lost on one pull can stand
 * after the next (the winner released in between).
 */
export function lostClaims(touched: Iterable<Touched>): LostClaim[] {
  const out: LostClaim[] = [];
  for (const { root, task } of touched) {
    if (!root.hasTask(task)) continue;
    const token = root.myClaim(task);
    if (!token) continue;
    const claim = root.readEvents(task).find((e) => e.type === 'claim' && e.token === token);
    if (!claim) continue;
    const state = root.foldTask(task);
    if (state.lostClaims.includes(claim.id)) {
      out.push({
        root: root.name,
        task,
        actor: claim.actor,
        winner: state.claimedBy,
        event: claim.id,
      });
    }
  }
  return out;
}

/**
 * Commits the root's changes, then pulls and pushes as asked. Only paths inside the root are
 * committed, so a root inside a code repo never sweeps up code changes. Commits use the
 * machine's git identity. While the checkout is off the store branch, or HEAD is detached, it
 * does nothing and says why in a note.
 */
export function syncRoot(root: Root, user: UserConfig, opts: SyncOptions = {}): SyncResult {
  const now = opts.now ?? Date.now();
  const top = git(root.dir, ['rev-parse', '--show-toplevel']).trim();
  const rel = relative(top, root.dir).split(sep).join('/') || '.';
  const prefix = rel === '.' ? '' : `${rel}/`;
  const result: SyncResult = {
    committed: 0,
    pulled: false,
    pushed: false,
    reordered: 0,
    lost: [],
    notes: [],
  };

  return root.lock('git', () => {
    const stamp = readStamp(root);
    let { pull, push } = { pull: opts.pull ?? false, push: opts.push ?? false };
    if (opts.auto) {
      const due = dueActions(root, stamp, now);
      pull ||= due.pull;
      push ||= due.push;
    }
    if (opts.sessionEnd) push = true;
    if (!opts.auto && !opts.sessionEnd && opts.pull === undefined && opts.push === undefined) {
      pull = true;
      push = true;
    }

    // Nothing commits, pulls or pushes while a code branch is checked out in the root's checkout.
    const hold = storeBranchHold(root, top, stamp, true);
    if (hold) {
      result.notes.push(hold);
      return result;
    }

    // Commit what changed under the root, after a leak check of those files.
    const status = git(top, ['status', '--porcelain', '-z', '--untracked-files=all', '--', rel]);
    const changed = status
      .split('\0')
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3))
      .filter((p) => !p.startsWith(`${prefix}.ops/`));
    if (changed.length > 0) {
      const hits = scanFiles(changed.map((p) => join(top, p)));
      if (hits.length > 0) {
        const where = hits.map(
          (h) => `${relative(top, h.file)}${h.line ? `:${h.line}` : ''} (${h.kind})`,
        );
        throw new OpsError(`leak check failed; nothing was committed:\n  ${where.join('\n  ')}`);
      }
      git(top, ['add', '-A', '--', rel]);
      const from = user.machine ? ` from ${user.machine}` : '';
      git(top, ['commit', '-q', '-m', `ops: ${changed.length} change(s)${from}`, '--', rel]);
      result.committed = changed.length;
    }

    const upstream = gitOk(top, ['rev-parse', '--abbrev-ref', '@{u}']);
    if ((pull || push) && !upstream) {
      result.notes.push('no upstream branch; skipped pull and push');
      pull = false;
      push = false;
    }
    const touched = new Map<string, Touched>();
    if (pull) {
      pullAndOrder(root, top, prefix, now, result, touched);
      stamp.lastPull = now;
    }
    if (push) {
      for (let attempt = 1; ; attempt++) {
        const ahead = Number(git(top, ['rev-list', '--count', '@{u}..HEAD']).trim());
        const files = git(top, ['log', '--format=', '--name-only', '@{u}..HEAD']).split('\n');
        const outside = new Set(files.filter((p) => p && !p.startsWith(prefix)));
        if (ahead === 0) {
          stamp.lastPush = now;
          break;
        }
        if (outside.size > 0 && !opts.allPaths) {
          result.notes.push(
            `not pushed: unpushed commits also change ${outside.size} file(s) outside ${rel}; ` +
              'push them yourself or pass --all-paths',
          );
          break;
        }
        try {
          git(top, ['push', '-q']);
          result.pushed = true;
          stamp.lastPush = now;
          break;
        } catch (err) {
          // Someone pushed first: pull their commits, put our events after theirs, try again.
          const msg = (err as Error).message;
          if (attempt >= PUSH_ATTEMPTS || !/rejected|fetch first|non-fast-forward/i.test(msg)) {
            throw err;
          }
          pullAndOrder(root, top, prefix, now, result, touched);
          stamp.lastPull = now;
        }
      }
    }
    result.lost = lostClaims(touched.values());
    // Copied-in files stay pinned until the upstream has them.
    if (upstream) pruneMirrored(root, top);
    root.writeAtomic(join(root.opsDir, 'sync.json'), JSON.stringify(stamp));
    return result;
  });
}

/** What an automatic sync of this root would do now; the supervisor syncs only when one is due. */
export function syncDue(root: Root, now: number = Date.now()): { pull: boolean; push: boolean } {
  return dueActions(root, readStamp(root), now);
}

/** Drops copied-in files the upstream now has, or that no longer exist. */
function pruneMirrored(root: Root, top: string): void {
  const kept = readMirrored(root);
  if (kept.size === 0) return;
  const upstreamFiles = new Set(
    lines(
      git(top, [
        'ls-tree',
        '-r',
        '--name-only',
        '@{u}',
        '--',
        ...[...new Set([...kept].map((p) => p.split('/').slice(0, -1).join('/')))],
      ]),
    ),
  );
  const still = new Set([...kept].filter((p) => !upstreamFiles.has(p) && existsSync(join(top, p))));
  if (still.size !== kept.size) writeMirrored(root, still);
}

/**
 * Settles a rebase that stopped on `task.md` files only: the version pushed first stays, and this
 * clone's version is saved under `.ops/conflicts/` with a note, so no edit is lost. Two people
 * (or a project root and its Master Repo copy) editing the same task.md is the one case where
 * files written by Agent Ops can conflict. Returns false, leaving the rebase as it is, when any
 * other file conflicts.
 */
function settleTaskMdConflicts(
  root: Root,
  top: string,
  prefix: string,
  result: SyncResult,
): boolean {
  const taskMd = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:mirrors/[^/]+/)?(?:archive/)?tasks/[^/]+/task\\.md$`,
  );
  for (let step = 0; step < 100; step++) {
    const conflicted = lines(git(top, ['diff', '--name-only', '--diff-filter=U']));
    if (conflicted.length === 0) {
      const gitDir = git(top, ['rev-parse', '--git-dir']).trim();
      const dir = join(top, gitDir);
      if (!existsSync(join(gitDir, 'rebase-merge')) && !existsSync(join(dir, 'rebase-merge'))) {
        return true;
      }
      git(top, ['-c', 'core.editor=true', 'rebase', '--continue']);
      continue;
    }
    if (!conflicted.every((p) => taskMd.test(p))) return false;
    const saveDir = join(root.opsDir, 'conflicts');
    mkdirSync(saveDir, { recursive: true });
    for (const p of conflicted) {
      const mine = gitOk(top, ['cat-file', '-e', `REBASE_HEAD:${p}`])
        ? git(top, ['show', `REBASE_HEAD:${p}`])
        : '';
      const name = `${Date.now()}-${p.replace(/[^A-Za-z0-9.-]+/g, '_')}`;
      writeFileSync(join(saveDir, name), mine);
      git(top, ['checkout', '--ours', '--', p]);
      git(top, ['add', '--', p]);
      result.notes.push(
        `${p}: your edit conflicted with one pushed first; kept the pushed one, yours is in .ops/conflicts/${name}`,
      );
    }
    try {
      git(top, ['-c', 'core.editor=true', 'rebase', '--continue']);
    } catch {
      // The next commit stopped on a conflict too: the loop looks at it.
    }
  }
  return false;
}
