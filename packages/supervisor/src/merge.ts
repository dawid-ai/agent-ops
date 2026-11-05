import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { killTree } from './proc.js';

/** Where an approved task's work is, as its last review request names it. */
export interface MergeSource {
  /** The commit the reviewer approved, when the review names one. */
  commit?: string;
  branch?: string;
}

/**
 * Reads the branch and commit from a review request: `<commit> on branch <name>`, the form the
 * agent skill and opsd's own leftover reviews use, else `branch <name>` alone (its tip).
 */
export function mergeSource(text: string): MergeSource | null {
  // A name ends at a space, a colon, a comma, a bracket or a full stop that ends a sentence.
  const name = '`?([A-Za-z0-9._/-]+?)`?(?=[\\s:,;)]|\\.(?:\\s|$)|$)';
  const both = new RegExp(`\\b([0-9a-f]{7,40})\\s+on\\s+branch\\s+${name}`, 'm').exec(text);
  if (both) return { commit: both[1], branch: both[2] };
  const branch = new RegExp(`\\bbranch\\s+${name}`, 'm').exec(text);
  return branch ? { branch: branch[1] } : null;
}

/** What one command run printed and how it ended. */
export interface CommandResult {
  ok: boolean;
  command: string;
  /** The end of what it printed, stdout and stderr together. */
  output: string;
  /** Why it failed: `exit <code>`, `timed out after <n> min` or `stopped`. */
  why?: string;
}

/** How much of a command's output opsd keeps. */
const OUTPUT_KEEP = 64 * 1024;

/**
 * Git work for merging approved branches: rebasing in a worktree of opsd's own, and moving the
 * base branch forward without ever forcing it.
 */
export class MergeRepo {
  private readonly excludes: string[];

  /**
   * @param top The checkout the base branch is built in.
   * @param worktree opsd's own worktree for rebases and checks; created on first use.
   * @param stores Task store folders, whose files never count as code changes.
   * @param env The environment git and the commands run with.
   */
  constructor(
    readonly top: string,
    readonly worktree: string,
    stores: string[],
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.excludes = [':(exclude,glob)**/.agent-ops/**'];
    for (const dir of stores) {
      const rel = relative(resolve(top), resolve(dir));
      if (rel === '' || rel.startsWith('..') || rel.includes(':')) continue;
      this.excludes.push(`:(exclude,literal)${rel.split(sep).join('/')}`);
    }
  }

  /** The commit `rev` names in the repo, or null. */
  commit(rev: string): string | null {
    try {
      return this.git(this.top, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]).trim() || null;
    } catch {
      return null;
    }
  }

  /** Creates opsd's worktree, detached at `at`, unless it is there already. */
  ensureWorktree(at: string): void {
    if (existsSync(this.worktree)) {
      // A folder that is no worktree may be someone's: it stays for a person to look at.
      try {
        this.git(this.worktree, ['rev-parse', '--git-dir']);
        return;
      } catch {
        throw new Error(`${this.worktree} exists but is no git worktree; remove it`);
      }
    }
    mkdirSync(dirname(this.worktree), { recursive: true });
    // `-f` takes over opsd's own path when git still lists it after the folder was deleted;
    // other worktrees' entries are left alone.
    this.git(this.top, ['worktree', 'add', '-q', '-f', '--detach', this.worktree, at]);
  }

  /**
   * Replays `commit` and the commits before it that `onto` lacks onto `onto`, in opsd's worktree.
   * Returns the new commit, or the conflict git reported (the rebase is undone).
   */
  rebase(commit: string, onto: string): { head: string } | { conflict: string } {
    const wt = this.worktree;
    this.git(wt, ['rebase', '--abort'], { allowFail: true });
    this.git(wt, ['checkout', '-q', '-f', '--detach', commit]);
    // Untracked files of an earlier merge go; ignored ones (installed packages, builds) stay.
    this.git(wt, ['clean', '-q', '-f', '-d']);
    try {
      this.git(wt, ['rebase', '-q', onto]);
    } catch (err) {
      const out = errorText(err);
      let files = '';
      try {
        files = this.git(wt, ['diff', '--name-only', '--diff-filter=U']).trim();
      } catch {
        // No rebase in progress: the message says why.
      }
      this.git(wt, ['rebase', '--abort'], { allowFail: true });
      return {
        conflict: files ? `conflicts in ${files.split('\n').join(', ')}\n\n${out}` : out,
      };
    }
    return { head: this.git(wt, ['rev-parse', 'HEAD']).trim() };
  }

  /** Whether two commits have the same files outside task stores. */
  sameCode(a: string, b: string): boolean {
    try {
      this.git(this.top, ['diff', '--quiet', a, b, '--', '.', ...this.excludes]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Moves `base` from `from` to `to`, which must be a descendant. Where `base` is checked out, it
   * merges there with `--ff-only`, so the work tree follows and local changes are never lost;
   * elsewhere it updates the ref only if it is still at `from`. Returns `moved` when `base` is no
   * longer at `from`; throws on any other refusal.
   */
  fastForward(base: string, from: string, to: string): 'done' | 'moved' {
    if (this.commit(`refs/heads/${base}`) !== from) return 'moved';
    const at = this.checkedOut(base);
    try {
      if (at) this.git(at, ['merge', '-q', '--ff-only', to]);
      else this.git(this.top, ['update-ref', `refs/heads/${base}`, to, from]);
    } catch (err) {
      // A commit (a task store sync, say) landed on the base in between.
      if (this.commit(`refs/heads/${base}`) !== from) return 'moved';
      throw new Error(errorText(err));
    }
    return 'done';
  }

  /** The worktree that has `branch` checked out, or null. */
  checkedOut(branch: string): string | null {
    const out = this.git(this.top, ['worktree', 'list', '--porcelain']);
    let path: string | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      else if (line.trim() === `branch refs/heads/${branch}` && path) return resolve(path);
    }
    return null;
  }

  /** Files that differ between two commits, outside task stores. */
  changedFiles(a: string, b: string): string[] {
    return lines(this.git(this.top, ['diff', '--name-only', a, b, '--', '.', ...this.excludes]));
  }

  /** Task store files that differ between two commits. */
  storeFiles(a: string, b: string): string[] {
    const code = new Set(this.changedFiles(a, b));
    return lines(this.git(this.top, ['diff', '--name-only', a, b])).filter((f) => !code.has(f));
  }

  private git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...this.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (opts.allowFail) return '';
      throw err;
    }
  }
}

/**
 * How long a command that has exited may keep its output open, through a process it started,
 * before opsd stops reading it: a leftover nothing could end must not hold a merge or a stop.
 */
const DRAIN_MS = 5_000;

/** How long a stop waits for the watch to end the command's processes before ending the shell. */
const WATCH_STOP_MS = 15_000;

/**
 * Follows the processes of each command a `CommandRunner` starts, so a stop ends all of them and
 * none outlives the command. opsd implements it with its process ledger.
 */
export interface CommandWatch {
  /** The command started as the shell `pid`; `running` says whether that shell still runs. */
  started(pid: number, running: () => boolean): void;
  /** Ends every process of the command; the runner ends the shell itself afterwards. */
  stop(pid: number): Promise<void>;
  /** The shell exited: ends what the command left behind. */
  ended(pid: number): Promise<void>;
}

/** The launcher's exit code when it could not run the command in a job object. */
export const JOB_FAILED = 125;

/**
 * Windows: runs `OPS_JOB_COMMAND` through `cmd.exe` inside a job object of its own, then exits
 * with the command's exit code. The job ends every process in it when its last handle closes, and
 * only the launcher holds that handle, so ending the launcher ends the whole tree: processes
 * started detached and their children too, since the job allows no breakaway. This needs no
 * process list and no `OpenProcess` on other processes, both of which a sandbox may refuse. The
 * shell starts suspended and runs only once it is in the job; when the shell exits, the launcher
 * ends what it left behind. Without a job, nothing runs (exit `JOB_FAILED`).
 */
const JOB_LAUNCHER = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class OpsJob {
  [StructLayout(LayoutKind.Sequential)] struct StartupInfo { public int cb; public IntPtr reserved, desktop, title; public int x, y, xSize, ySize, xChars, yChars, fill, flags; public short show, reserved2; public IntPtr reserved3, stdIn, stdOut, stdErr; }
  [StructLayout(LayoutKind.Sequential)] struct ProcInfo { public IntPtr process, thread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long a, b; public uint flags; public UIntPtr min, max; public uint active; public UIntPtr affinity; public uint priority, cls; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtLimits { public BasicLimits basic; public IoCounters io; public UIntPtr a, b, c, d; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtLimits info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo si, out ProcInfo pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  static int Fail(string step) { Console.Error.WriteLine("opsd could not run the command in a job object: " + step + " failed with error " + Marshal.GetLastWin32Error()); return ${JOB_FAILED}; }
  public static int Run(string command) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return Fail("CreateJobObject");
    ExtLimits limits = new ExtLimits();
    limits.basic.flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtLimits)))) return Fail("SetInformationJobObject");
    string shell = Environment.GetEnvironmentVariable("ComSpec");
    if (String.IsNullOrEmpty(shell)) shell = "cmd.exe";
    StartupInfo si = new StartupInfo();
    si.cb = Marshal.SizeOf(typeof(StartupInfo));
    si.flags = 0x100;
    si.stdIn = GetStdHandle(-10); si.stdOut = GetStdHandle(-11); si.stdErr = GetStdHandle(-12);
    ProcInfo pi;
    StringBuilder line = new StringBuilder("\\"" + shell + "\\" /d /s /c \\"" + command + "\\"");
    if (!CreateProcessW(null, line, IntPtr.Zero, IntPtr.Zero, true, 0x4, IntPtr.Zero, null, ref si, out pi)) return Fail("CreateProcess");
    if (!AssignProcessToJobObject(job, pi.process)) { int r = Fail("AssignProcessToJobObject"); TerminateProcess(pi.process, 1); return r; }
    ResumeThread(pi.thread);
    WaitForSingleObject(pi.process, 0xFFFFFFFF);
    uint code;
    if (!GetExitCodeProcess(pi.process, out code)) code = 1;
    TerminateJobObject(job, 1);
    return (int)code;
  }
}
'@
} catch { [Console]::Error.WriteLine('opsd could not run the command in a job object: ' + $_); exit ${JOB_FAILED} }
$command = $env:OPS_JOB_COMMAND
Remove-Item Env:OPS_JOB_COMMAND
exit [OpsJob]::Run($command)
`;

/** `powershell.exe -EncodedCommand` takes the script as base64 of UTF-16LE. */
const JOB_LAUNCHER_ARG = Buffer.from(JOB_LAUNCHER, 'utf16le').toString('base64');

/** Runs commands one after the other through the shell; stops at the first that fails. */
export class CommandRunner {
  private current?: { pid: number; stop: () => void };
  private stopped = false;
  private readonly killTree: (pid: number) => void;
  private readonly watch?: CommandWatch;
  private readonly job: boolean;

  /**
   * @param opts.killTree Off Windows: stops the command's process group; tests replace it.
   * @param opts.watch Off Windows: follows and ends each command's processes. On Windows each
   *   command runs in a job object instead (see `JOB_LAUNCHER`), which ends the whole tree with
   *   the launcher; `taskkill /T`, a process list and kills by PID can each be refused there.
   * @param opts.job Whether to use the job launcher; on Windows by default. Tests turn it off.
   */
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    opts: { killTree?: (pid: number) => void; watch?: CommandWatch; job?: boolean } = {},
  ) {
    this.killTree = opts.killTree ?? killTree;
    this.job = opts.job ?? process.platform === 'win32';
    this.watch = this.job ? undefined : opts.watch;
  }

  async runAll(commands: string[], cwd: string, timeoutMs: number): Promise<CommandResult[]> {
    const out: CommandResult[] = [];
    for (const command of commands) {
      const r = await this.run(command, cwd, timeoutMs);
      out.push(r);
      if (!r.ok) break;
    }
    return out;
  }

  /** Stops the command running now, and every later one. */
  stop(): void {
    this.stopped = true;
    this.current?.stop();
  }

  private run(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
    if (this.stopped) return Promise.resolve({ ok: false, command, output: '', why: 'stopped' });
    return new Promise((res) => {
      const child = this.job
        ? spawn(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', JOB_LAUNCHER_ARG],
            {
              cwd,
              env: { ...this.env, OPS_JOB_COMMAND: command },
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )
        : spawn(command, {
            cwd,
            env: this.env,
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            // Its own process group off Windows, so a timeout stops what it started too.
            detached: process.platform !== 'win32',
          });
      let output = '';
      const keep = (b: Buffer): void => {
        output += b.toString('utf8');
        if (output.length > OUTPUT_KEEP * 2) output = output.slice(-OUTPUT_KEEP);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      let why: string | undefined;
      const pid = child.pid;
      const running = (): boolean => child.exitCode === null && child.signalCode === null;
      if (pid !== undefined) this.watch?.started(pid, running);
      let killing = false;
      // Only this command's own processes: the job launcher by the handle its spawn returned,
      // which ends the job and so the tree; else the watch's, checked by creation time, then the
      // shell by its handle, while it still runs.
      const kill = (reason: string): void => {
        why ??= reason;
        if (pid === undefined || !running() || killing) return;
        killing = true;
        if (this.job) {
          child.kill();
          return;
        }
        void bounded(this.watch?.stop(pid), WATCH_STOP_MS).then(() => {
          if (!running()) return;
          // Off Windows the group gets SIGTERM first and SIGKILL later.
          if (process.platform !== 'win32') this.killTree(pid);
          child.kill();
        });
      };
      const timer = setTimeout(
        () => kill(`timed out after ${Math.round(timeoutMs / 60_000)} min`),
        timeoutMs,
      );
      if (pid !== undefined) this.current = { pid, stop: () => kill('stopped') };
      let settled = false;
      let drain: NodeJS.Timeout | undefined;
      const done = (code: number | null, err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(drain);
        child.stdout?.destroy();
        child.stderr?.destroy();
        this.current = undefined;
        const tail = output.slice(-OUTPUT_KEEP);
        if (err) why ??= err.message;
        if (this.job && code === JOB_FAILED && tail.includes('opsd could not run the command')) {
          why ??= 'could not run in a job object';
        }
        const ok = !why && code === 0;
        const result = { ok, command, output: tail, why: ok ? undefined : (why ?? `exit ${code}`) };
        // What the command left behind ends before the next command starts.
        const after = pid === undefined ? undefined : this.watch?.ended(pid);
        void bounded(after, WATCH_STOP_MS * 2).then(() => res(result));
      };
      child.on('error', (err) => done(null, err));
      child.on('close', (code) => done(code));
      // A process the command left behind may hold the output open; it does not hold opsd.
      child.on('exit', (code) => {
        drain = setTimeout(() => done(code), DRAIN_MS);
      });
    });
  }
}

/** Waits for `p`, at most `ms`; never rejects. */
function bounded(p: Promise<void> | undefined, ms: number): Promise<void> {
  if (!p) return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((r) => {
    timer = setTimeout(r, ms);
  });
  return Promise.race([p.catch(() => {}), limit]).finally(() => clearTimeout(timer));
}

function lines(out: string): string[] {
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function errorText(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  const text = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
  return text || (e.message ?? String(err));
}
