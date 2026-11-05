import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** The folder name of a task store inside a code checkout. */
const STORE_DIR = '.agent-ops';

/**
 * Git work on a code checkout that runs write in: whether it has changes, and committing what a
 * run left to a branch of its own. Task stores never take part: their files are not changes of
 * the checkout and never go into a run's commit.
 */
export class Checkout {
  private readonly excludes: string[];
  /** The checkout is itself a task store: opsd leaves it alone. */
  readonly isStore: boolean;

  /**
   * @param top The top of the checkout's git work tree.
   * @param stores The task store folders opsd knows (each root's folder).
   * @param env The environment git runs with: opsd's, so commits carry its git identity.
   */
  constructor(
    readonly top: string,
    stores: string[] = [],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.excludes = [`:(exclude,glob)**/${STORE_DIR}/**`];
    let isStore = false;
    for (const dir of stores) {
      const rel = relative(resolve(top), resolve(dir));
      if (rel === '' || rel.startsWith('..') || rel.includes(':')) {
        // The store holds the checkout, or the checkout is the store.
        if (rel === '' || isInside(top, dir)) isStore = true;
        continue;
      }
      this.excludes.push(`:(exclude,literal)${rel.split(sep).join('/')}`);
    }
    this.isStore = isStore;
  }

  /** The commit checked out, or null in a repo without one. */
  head(): string | null {
    try {
      return this.git(['rev-parse', '--verify', '-q', 'HEAD']).trim() || null;
    } catch {
      return null;
    }
  }

  /** The commit `rev` names, or null when it names none. */
  private ref(rev: string): string | null {
    try {
      return this.git(['rev-parse', '--verify', '-q', `${rev}^{commit}`]).trim() || null;
    } catch {
      return null;
    }
  }

  /** The branch checked out, or null on a detached HEAD. */
  branch(): string | null {
    try {
      return this.git(['symbolic-ref', '-q', '--short', 'HEAD']).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * The pathspecs that leave out task stores and the repo's linked worktrees inside this
   * checkout. A run makes its code branch in a worktree such as `out/wt-<ID>` (AO-0135); a repo
   * that does not ignore that folder would otherwise show it as an untracked change, and
   * `git add -A` would stage it as an embedded repo.
   */
  private pathExcludes(): string[] {
    let list: string;
    try {
      list = this.git(['worktree', 'list', '--porcelain', '-z']);
    } catch {
      return this.excludes;
    }
    const nested: string[] = [];
    for (const field of list.split('\0')) {
      if (!field.startsWith('worktree ')) continue;
      const rel = relative(resolve(this.top), resolve(field.slice('worktree '.length)));
      if (rel === '' || rel.startsWith('..') || rel.includes(':')) continue;
      nested.push(`:(exclude,literal)${rel.split(sep).join('/')}`);
    }
    return [...this.excludes, ...nested];
  }

  /** Changed tracked files and untracked files, outside task stores; ignored files never count. */
  changes(): string[] {
    if (this.isStore) return [];
    const out = this.git([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--',
      '.',
      ...this.pathExcludes(),
    ]);
    return out
      .split('\0')
      .filter((e) => e.length > 3)
      .map((e) => e.slice(3));
  }

  /**
   * Commits every change outside task stores on a new branch `branch` from `base`, the commit
   * the run started on, then restores those files to it. Neither the index nor HEAD's branch
   * take the commit: it is built in a temporary index. A file whose content changed again since
   * the commit, or whose staged version is in neither `base` nor the commit, stays as it is and
   * is listed in `kept`, so nothing is discarded that the commit does not hold. When `branch`
   * already exists on `base` (an earlier call stopped before its restore was over), its commit
   * is taken as is and only the restore runs.
   *
   * Throws, committing nothing, when changes are left but HEAD is no longer `base` (the run, or
   * someone else, moved it: the changes may belong on another commit) or `base` is null (the
   * start commit was not recorded). Returns null when nothing is left or the repo has no commit
   * to branch from.
   */
  commitLeftovers(branch: string, message: string, base: string | null): LeftoverCommit | null {
    if (this.isStore) return null;
    const head = this.head();
    if (!head) return null;
    if (head !== base) {
      // A run that committed its work itself and left nothing needs nothing.
      if (this.changes().length === 0) return null;
      if (!base) throw new Error(`no start commit recorded; HEAD is ${head.slice(0, 7)}`);
      throw new Error(
        `HEAD moved from ${base.slice(0, 7)} to ${head.slice(0, 7)} during the run; the changes stay for a person`,
      );
    }
    const tmp = mkdtempSync(join(tmpdir(), 'opsd-index-'));
    try {
      let commit = this.ref(`refs/heads/${branch}`);
      if (commit) {
        // An earlier wrap-up stopped after the commit (opsd restarted): the branch holds what
        // the run left, and the restore below finishes what that wrap-up started.
        if (this.ref(`${commit}^`) !== head) {
          throw new Error(`branch ${branch} exists and does not start from ${head.slice(0, 7)}`);
        }
      } else {
        const tree = this.stage(join(tmp, 'commit'), head);
        if (tree === this.git(['rev-parse', `${head}^{tree}`]).trim()) return null;
        commit = this.git(['commit-tree', tree, '-p', head], { input: message }).trim();
        // An empty old value: the branch must not exist yet.
        this.git(['update-ref', `refs/heads/${branch}`, commit, '']);
      }

      const changed = this.parseNameStatus(
        this.git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', head, commit]),
      );
      const now = this.stage(join(tmp, 'check'), head);
      const nowChanged = new Set(
        this.names(this.git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', head, now])),
      );
      // Files changed again since the commit (helpers still writing, a person at work).
      const movedOn = new Set(
        this.names(this.git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', commit, now])),
      );
      // Staged versions in neither HEAD nor the commit.
      const staged = new Set(
        this.names(this.git(['diff-index', '--cached', '-z', '--name-only', '--no-renames', head])),
      );
      const stagedOther = new Set(
        this.names(
          this.git(['diff-index', '--cached', '-z', '--name-only', '--no-renames', commit]),
        ),
      );
      const kept: string[] = [];
      const restore: string[] = [];
      const added: string[] = [];
      const unstage: string[] = [];
      for (const [status, path] of changed) {
        // As in `head` already: restored before opsd restarted, or changed back.
        if (!nowChanged.has(path) && !staged.has(path)) continue;
        if (movedOn.has(path) || (staged.has(path) && stagedOther.has(path))) {
          kept.push(path);
          continue;
        }
        if (status === 'A') {
          added.push(path);
          if (staged.has(path)) unstage.push(path);
        } else restore.push(path);
      }
      const literal = { env: { GIT_LITERAL_PATHSPECS: '1' } };
      if (unstage.length > 0) {
        this.git(['reset', '-q', head, '--pathspec-from-file=-', '--pathspec-file-nul'], {
          ...literal,
          input: unstage.join('\0'),
        });
      }
      if (restore.length > 0) {
        this.git(['checkout', head, '--pathspec-from-file=-', '--pathspec-file-nul'], {
          ...literal,
          input: restore.join('\0'),
        });
      }
      for (const path of added) this.removeAdded(path);
      return { commit, branch, base: head, files: changed.map(([, p]) => p), kept };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Stages the work tree outside task stores over `head` into a fresh index at `index`; returns
   * its tree.
   */
  private stage(index: string, head: string): string {
    const env = { GIT_INDEX_FILE: index };
    this.git(['read-tree', head], { env });
    this.git(['add', '-A', '--', '.', ...this.pathExcludes()], { env });
    return this.git(['write-tree'], { env }).trim();
  }

  /** Deletes a file the run added, and the folders it leaves empty, up to the checkout's top. */
  private removeAdded(path: string): void {
    const abs = join(this.top, ...path.split('/'));
    try {
      unlinkSync(abs);
    } catch {
      return;
    }
    let dir = dirname(abs);
    while (isInside(dir, this.top) && resolve(dir) !== resolve(this.top)) {
      try {
        if (readdirSync(dir).length > 0) return;
        rmdirSync(dir);
      } catch {
        return;
      }
      dir = dirname(dir);
    }
  }

  private names(out: string): string[] {
    return out.split('\0').filter(Boolean);
  }

  private parseNameStatus(out: string): Array<[string, string]> {
    const parts = out.split('\0').filter(Boolean);
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) pairs.push([parts[i]![0]!, parts[i + 1]!]);
    return pairs;
  }

  private git(args: string[], opts: { env?: Record<string, string>; input?: string } = {}): string {
    return execFileSync('git', args, {
      cwd: this.top,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      input: opts.input ?? '',
      env: { ...this.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

export interface LeftoverCommit {
  commit: string;
  branch: string;
  /** The commit the branch starts from: the one the run started on, still HEAD at its end. */
  base: string;
  /** Files the commit changes, relative to the checkout's top. */
  files: string[];
  /** Files left in the checkout because they changed again after the commit. */
  kept: string[];
}

/** The branch for what run `run` of `agent` left: `<runtime>/<task>-<run>`, lowercase. */
export function leftoverBranch(runtime: string, run: string, task?: string): string {
  return `${runtime}/${task ?? 'run'}-${run}`.toLowerCase().replace(/[^a-z0-9/._-]/g, '-');
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'));
}
