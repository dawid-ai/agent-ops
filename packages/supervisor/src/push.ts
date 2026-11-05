import { execFileSync } from 'node:child_process';
import { isKeyFile, redactSecrets, secretKind } from '@agent-ops/core';

/** What one round of pushing task branches looks at and skips. */
export interface BranchPushOptions {
  /** Branch name prefixes of task branches, such as `claude/`; each ends with a slash. */
  prefixes: string[];
  /**
   * Branches work goes into, such as `v2`. They are never pushed here, and a task branch with
   * nothing beyond them is not either.
   */
  bases: string[];
  /** Per branch, the approved commit opsd merged; a tip at or behind it has nothing new. */
  merged: Record<string, string>;
  /** Per branch, the `<tip> <remote tip>` an earlier round decided to leave alone. */
  seen: Record<string, string>;
}

export interface BranchPushRound {
  /** The remote branches go to; null when the repo has none. */
  remote: string | null;
  pushed: { branch: string; tip: string }[];
  /** Branches left alone for a reason a person may want to know, such as a diverged remote. */
  held: { branch: string; why: string }[];
  /** `seen` for the next round: what this round left alone and why it need not look again. */
  seen: Record<string, string>;
  /** Why the round stopped early, such as an unreachable remote. */
  error?: string;
}

/** Pushes rejected because the remote moved; anything else (network, sign-in) ends the round. */
const REJECTED = /rejected|non-fast-forward|fetch first|stale info|\[remote rejected\]/i;

/**
 * Pushes task branches with new commits to the repo's remote, so work that is not merged yet is
 * not only on this machine. Never forces, never pushes a base branch, and deletes a remote branch
 * only while it still holds what was approved.
 */
export class BranchPusher {
  /**
   * @param top The repo's checkout.
   * @param env The environment git runs with: opsd's own, with the machine's git sign-in.
   * @param timeoutMs How long one git command may take before it counts as failed.
   */
  constructor(
    readonly top: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly timeoutMs = 120_000,
  ) {}

  /** The remote of the checked-out branch, else `origin`, else the only remote; null without one. */
  remote(): string | null {
    const remotes = lines(this.git(['remote'], { allowFail: true }));
    if (remotes.length === 0) return null;
    const head = this.git(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true }).trim();
    if (head) {
      const r = this.git(['config', '--get', `branch.${head}.remote`], { allowFail: true }).trim();
      if (r && remotes.includes(r)) return r;
    }
    if (remotes.includes('origin')) return 'origin';
    return remotes.length === 1 ? remotes[0]! : null;
  }

  /** The branch checked out in the checkout, or null on a detached HEAD. */
  headBranch(): string | null {
    return this.git(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true }).trim() || null;
  }

  /**
   * Pushes each task branch whose tip has commits that neither the bases nor its remote branch
   * hold, when the remote branch is missing or behind it. A branch whose remote branch has
   * commits this clone lacks, or whose new commits add something that looks like a secret, is
   * held back and named in the result.
   */
  pushNew(opts: BranchPushOptions): BranchPushRound {
    const round: BranchPushRound = { remote: this.remote(), pushed: [], held: [], seen: {} };
    const remote = round.remote;
    if (!remote) return round;
    const heads = this.refs(opts.prefixes.map((p) => `refs/heads/${p.replace(/\/+$/, '')}`));
    if (heads.size === 0) return round;
    const tracking = this.refs([`refs/remotes/${remote}`]);
    const bases = this.baseCommits(remote, opts.bases, tracking);
    for (const [ref, tip] of heads) {
      const branch = ref.slice('refs/heads/'.length);
      if (opts.bases.includes(branch)) continue;
      const approved = opts.merged[branch];
      if (approved && (approved === tip || this.isAncestor(tip, approved))) continue;
      const theirs = tracking.get(`refs/remotes/${remote}/${branch}`);
      if (theirs === tip) continue;
      const key = `${tip} ${theirs ?? '-'}`;
      if (opts.seen[branch] === key) {
        round.seen[branch] = key;
        continue;
      }
      const leave = (why?: string): void => {
        round.seen[branch] = key;
        if (why) round.held.push({ branch, why });
      };
      if (theirs && !this.isAncestor(theirs, tip)) {
        // The remote is ahead (pushed from another clone): nothing to push.
        if (this.isAncestor(tip, theirs)) leave();
        else leave(`${remote}/${branch} has commits this clone lacks; opsd never forces a push`);
        continue;
      }
      const not = theirs ? [...bases, theirs] : bases;
      if (!this.hasNewWork(tip, not, bases)) {
        leave();
        continue;
      }
      const leak = this.leak(tip, not);
      if (leak) {
        leave(`a commit on it adds ${leak}; not pushed`);
        continue;
      }
      try {
        this.git(['push', '-q', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
        round.pushed.push({ branch, tip });
      } catch (err) {
        const msg = gitError(err);
        if (!REJECTED.test(msg)) {
          round.error = `push of ${branch} to ${remote} failed: ${msg}`;
          // The rest waits for the next round; nothing was decided about them.
          for (const [b, k] of Object.entries(opts.seen)) round.seen[b] ??= k;
          return round;
        }
        leave(`${remote} refused it (${msg}); opsd never forces a push`);
      }
    }
    return round;
  }

  /** The commit `branch` points at on `remote`, asked of the remote itself; null when it is gone. */
  remoteTip(remote: string, branch: string): string | null {
    const out = this.git(['ls-remote', remote, `refs/heads/${branch}`]).trim();
    const line = lines(out).find((l) => l.endsWith(`\trefs/heads/${branch}`));
    return line ? line.split('\t')[0]! : null;
  }

  /**
   * Deletes `branch` on `remote` when it holds nothing beyond `approved`. The delete carries a
   * lease on the tip it checked, so a push that lands in between keeps the branch.
   */
  deleteRemote(remote: string, branch: string, approved: string): 'deleted' | 'absent' | string {
    const theirs = this.remoteTip(remote, branch);
    if (!theirs) return 'absent';
    if (theirs !== approved && !this.isAncestor(theirs, approved)) {
      return `kept ${remote}/${branch}: it has commits the approval did not cover`;
    }
    this.git([
      'push',
      '-q',
      `--force-with-lease=refs/heads/${branch}:${theirs}`,
      remote,
      `:refs/heads/${branch}`,
    ]);
    return 'deleted';
  }

  /** Whether commit `a` is `b` or an ancestor of it; false when either is unknown. */
  isAncestor(a: string, b: string): boolean {
    try {
      this.git(['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch {
      return false;
    }
  }

  /** Refs under the patterns, with their commits. */
  private refs(patterns: string[]): Map<string, string> {
    const out = new Map<string, string>();
    const raw = this.git(['for-each-ref', '--format=%(refname) %(objectname)', ...patterns]);
    for (const l of lines(raw)) {
      const at = l.lastIndexOf(' ');
      out.set(l.slice(0, at), l.slice(at + 1));
    }
    return out;
  }

  /** The commits of the bases, here and on the remote, and the remote's default branch. */
  private baseCommits(remote: string, bases: string[], tracking: Map<string, string>): string[] {
    const out = new Set<string>();
    for (const b of bases) {
      const local = this.git(['rev-parse', '-q', '--verify', `refs/heads/${b}^{commit}`], {
        allowFail: true,
      }).trim();
      if (local) out.add(local);
      const theirs = tracking.get(`refs/remotes/${remote}/${b}`);
      if (theirs) out.add(theirs);
    }
    const def = this.git(['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`], {
      allowFail: true,
    }).trim();
    const defTip = def ? tracking.get(def) : undefined;
    if (defTip) out.add(defTip);
    return [...out];
  }

  /**
   * Whether `tip` has commits outside `not` whose changes no base holds either: a branch merged
   * by rebase or cherry-pick has commits outside the base, but none with new changes. A merge
   * commit counts when its result differs from every parent somewhere (a conflict resolution or
   * an edit made in the merge); `git cherry` cannot match merges, so such a merge always counts.
   */
  private hasNewWork(tip: string, not: string[], bases: string[]): boolean {
    for (const m of lines(this.git(['rev-list', '--merges', tip, '--not', ...not]))) {
      const own = this.git([
        ...PLAIN_PATHS,
        'diff-tree',
        '--cc',
        '--no-commit-id',
        '--no-color',
        '--no-ext-diff',
        '--no-renames',
        m,
      ]);
      if (own.trim()) return true;
    }
    const fresh = lines(this.git(['rev-list', '--no-merges', tip, '--not', ...not]));
    if (fresh.length === 0) return false;
    let left = new Set(fresh);
    for (const base of bases) {
      // `+` marks a commit whose change the base lacks.
      const plus = lines(this.git(['cherry', base, tip]))
        .filter((l) => l.startsWith('+ '))
        .map((l) => l.slice(2).trim());
      left = new Set(plus.filter((c) => left.has(c)));
      if (left.size === 0) return false;
    }
    return true;
  }

  /**
   * What the first secret-looking line or key file the new commits add looks like, or null.
   * Merge commits are shown as dense combined diffs (`--cc`): the hunks where the merge result
   * differs from every parent, so a line added while resolving a conflict is scanned too.
   */
  private leak(tip: string, not: string[]): string | null {
    const out = this.git([
      ...PLAIN_PATHS,
      'log',
      '-p',
      '--cc',
      '--no-color',
      '--no-ext-diff',
      '--no-renames',
      '--format=',
      tip,
      '--not',
      ...not,
    ]);
    let file = '';
    // Marker columns of the current hunk: 1 in a plain diff, one per parent in a combined one;
    // 0 while in a file's header.
    let cols = 0;
    for (const l of out.split('\n')) {
      if (l.startsWith('diff ')) {
        cols = 0;
        continue;
      }
      const hunk = /^(@@+) /.exec(l);
      if (hunk) {
        cols = hunk[1]!.length - 1;
        continue;
      }
      if (cols === 0) {
        const path =
          /^\+\+\+ (.+)$/.exec(l)?.[1] ?? /^Binary files .* and (.+) differ$/.exec(l)?.[1];
        if (path && path !== '/dev/null') {
          file = diffPath(path);
          if (isKeyFile(file)) return `a key file (${file})`;
        }
        continue;
      }
      // A line in the result: `+` against some parent, `-` against none.
      const mark = l.slice(0, cols);
      if (!mark.includes('+') || mark.includes('-')) continue;
      const kind = secretKind(l.slice(cols));
      if (kind) return `what looks like a ${kind} in ${file}`;
    }
    return null;
  }

  private git(args: string[], opts: { allowFail?: boolean } = {}): string {
    try {
      return execFileSync('git', args, {
        cwd: this.top,
        encoding: 'utf8',
        windowsHide: true,
        timeout: this.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...this.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (opts.allowFail) return '';
      throw err;
    }
  }
}

/** Git options that keep non-ASCII paths readable in diff output. */
const PLAIN_PATHS = ['-c', 'core.quotePath=false'];

/** A path from a diff header without its quotes and `a/` or `b/` prefix. */
function diffPath(raw: string): string {
  const unquoted = /^".*"$/.test(raw) ? raw.slice(1, -1) : raw;
  return unquoted.replace(/^[ab]\//, '');
}

function lines(out: string): string[] {
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The line of a failed git command that says why, safe to log: URLs (which can carry a sign-in)
 * become `<url>`, a `user:password@` sign-in anywhere else goes, and lines that look like a
 * secret are left out.
 */
export function gitError(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string; code?: string };
  if (e.code === 'ETIMEDOUT') return 'timed out';
  const raw = `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim() || (e.message ?? '');
  const text = redactSecrets(raw)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<url>')
    // Git may print a URL without its scheme; a sign-in in it goes too.
    .replace(/\/\/[^\s'"/@]+@/g, '//')
    .replace(/[^\s'"/@]+:[^\s'"/@]*@/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    text.find((l) => /rejected|fatal|error|denied|could not/i.test(l)) ?? text[0] ?? 'git failed'
  );
}
