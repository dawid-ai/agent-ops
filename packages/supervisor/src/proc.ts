import type { ChildProcess } from 'node:child_process';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Socket } from 'node:net';
import { createServer } from 'node:net';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';

const WIN = process.platform === 'win32';

/**
 * Whether a run can outlive the opsd that started it. On Windows, Node puts every child it starts
 * without `detached` into a job object that ends the child when opsd exits, and `detached` would
 * leave the run without a console, so its console tools would open visible windows. `spawnHidden`
 * starts runs there through a hidden `cmd.exe` that runs a launcher: the job lets the shell's
 * children break away silently, so the launcher runs outside the job and keeps the shell's hidden
 * console when the job ends the shell. opsd records the launcher's PID before the launcher starts
 * the command (see `Launch`).
 */
export const RUNS_OUTLIVE_OPSD = true;

/** Finds an executable on PATH, with PATHEXT on Windows. Returns null when it is missing. */
export function resolveCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const exts = WIN ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const withExt = (p: string): string | null => {
    if (WIN && extname(p) && isFile(p)) return p;
    for (const e of exts) if (isFile(p + e)) return p + e;
    return !WIN && isFile(p) ? p : null;
  };
  if (isAbsolute(command) || command.includes('/') || command.includes('\\'))
    return withExt(command);
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    const hit = withExt(join(dir, command));
    if (hit) return hit;
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface Spawned {
  child: ChildProcess;
  pid: number;
  /** The image the PID runs, to check before killing an adopted run. */
  image: string;
  /**
   * Windows: the PID is a hidden `cmd.exe` running the launcher, and the command has not started.
   * See `Launch`.
   */
  launch?: Launch;
}

/**
 * Windows: a run's launcher, between its start and the start of the command. The launcher runs
 * outside opsd's job (see `RUNS_OUTLIVE_OPSD`), reports its PID, and starts the command only on
 * `go`. If the channel closes first, it exits without starting anything, so no command ever runs
 * that opsd has not recorded. The command runs in the launcher's own kill-on-close job: killing
 * the launcher ends the command too.
 */
export interface Launch {
  /** The image the launcher runs. */
  image: string;
  /** The launcher's PID, once it reports in; rejects if it exits or does not report in time. */
  ready: Promise<number>;
  /** Starts the command with the prompt on its stdin. */
  go(prompt: string): void;
  /** Closes the channel: a launcher that has not had `go` exits without starting the command. */
  abort(): void;
}

/** How long opsd waits for a launcher to report in. */
const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * The launcher, run as `node -e` (CommonJS). It sends its PID down the pipe, reads one JSON line
 * with the command, then forwards the rest of the stream to the command's stdin. It gives up after
 * 120 s or when the pipe closes before the command line arrives.
 */
const LAUNCHER = `
const net = require('net');
const { spawn } = require('child_process');
let child = null;
let buf = Buffer.alloc(0);
const giveUp = () => { if (!child) process.exit(70); };
const timer = setTimeout(giveUp, 120000);
const s = net.connect(process.env.OPS_LAUNCH_PIPE);
s.on('connect', () => s.write(process.pid + '\\n'));
s.on('error', giveUp);
s.on('close', () => { if (child) child.stdin.end(); else giveUp(); });
s.on('data', (d) => {
  if (child) { child.stdin.write(d); return; }
  buf = Buffer.concat([buf, d]);
  const i = buf.indexOf(10);
  if (i < 0) return;
  clearTimeout(timer);
  const spec = JSON.parse(buf.subarray(0, i).toString('utf8'));
  try {
    child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim === true,
    });
  } catch {
    process.exit(71);
  }
  child.stdin.on('error', () => {});
  child.on('error', () => process.exit(71));
  child.on('exit', (code) => process.exit(code ?? 1));
  const rest = buf.subarray(i + 1);
  if (rest.length > 0) child.stdin.write(rest);
});
`;

/**
 * Starts a process with no console window. On Unix it leads its own process group, so the whole
 * group can be stopped, and gets its prompt on stdin. On Windows it starts through a launcher
 * (see `Launch`): pass `launch.go(prompt)` once the launcher's PID is recorded.
 */
export function spawnHidden(
  file: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; out: number | 'pipe' | 'ignore' },
): Spawned {
  if (!WIN) {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', opts.out, opts.out],
      windowsHide: true,
      detached: true,
    });
    // Without a listener, a spawn error would crash the supervisor; exit handling covers the rest.
    child.on('error', () => {});
    if (child.pid === undefined) throw new Error(`could not start ${file}`);
    return { child, pid: child.pid, image: basename(file).toLowerCase() };
  }
  const spec = winSpec(file, args, opts);
  const node = process.execPath;
  if (/["%\r\n]/.test(node)) throw new Error(`cannot start a launcher from ${node}`);
  const pipe = `\\\\.\\pipe\\agent-ops-launch-${randomBytes(16).toString('hex')}`;
  const launch = openLaunch(pipe, spec, basename(node).toLowerCase());
  const code = `eval(Buffer.from('${Buffer.from(LAUNCHER).toString('base64')}','base64').toString())`;
  const env: NodeJS.ProcessEnv = { ...opts.env, OPS_LAUNCH_PIPE: pipe };
  // Inside Electron, execPath is the app; ELECTRON_RUN_AS_NODE makes it a plain Node process.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const shell = process.env.ComSpec ?? 'cmd.exe';
  let child: ChildProcess;
  try {
    // A fixed line: no argument of the command passes through cmd.exe. With /s, cmd.exe drops
    // the outer quotes and runs the rest as written.
    child = spawn(shell, ['/d', '/v:off', '/s', '/c', `""${node}" -e "${code}""`], {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', opts.out, opts.out],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  } catch (err) {
    launch.abort();
    throw err;
  }
  child.on('error', () => {});
  if (child.pid === undefined) {
    launch.abort();
    throw new Error(`could not start ${file}`);
  }
  // The launcher cannot report in once the shell is gone.
  child.on('exit', () => launch.abort());
  return { child, pid: child.pid, image: basename(shell).toLowerCase(), launch };
}

interface LaunchSpec {
  file: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  verbatim?: boolean;
}

/**
 * What the launcher starts. An `.exe` gets its arguments as they are (Node quotes them for the
 * program's parser). A `.cmd` or `.bat` runs in `cmd.exe`, which reads the arguments again, so
 * ones it would change are refused.
 */
function winSpec(
  file: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
): LaunchSpec {
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args, cwd: opts.cwd, env: opts.env };
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/v:off', '/s', '/c', `"${[file, ...args].map(quoteBatch).join(' ')}"`],
    cwd: opts.cwd,
    env: opts.env,
    verbatim: true,
  };
}

/**
 * Quotes one argument for a batch file run with `cmd.exe /v:off /s /c`. Inside quotes, cmd.exe
 * keeps `&|<>^()` as they are; trailing backslashes are doubled, so the closing quote stays a
 * quote for the program's parser. `"`, `%`, `!`, CR and LF cannot pass through a batch file
 * unchanged (`%*` expands and splits them again), so they are refused.
 */
export function quoteBatch(a: string): string {
  const bad = /["%!\r\n]/.exec(a);
  if (bad) {
    throw new Error(
      `argument ${JSON.stringify(a)} holds ${JSON.stringify(bad[0])}, which a .cmd or .bat ` +
        "runtime cannot receive unchanged; use the runtime's .exe or another path",
    );
  }
  if (a !== '' && /^[\w\-+.,:/\\@=]+$/.test(a)) return a;
  return `"${a.replace(/(\\+)$/, '$1$1')}"`;
}

function openLaunch(pipe: string, spec: LaunchSpec, image: string): Launch {
  const server = createServer();
  let sock: Socket | undefined;
  let sent = false;
  let fail: (err: Error) => void = () => {};
  const ready = new Promise<number>((resolveReady, rejectReady) => {
    fail = rejectReady;
    const timer = setTimeout(
      () => rejectReady(new Error('the launcher did not report in')),
      LAUNCH_TIMEOUT_MS,
    );
    timer.unref();
    server.on('error', (err) => rejectReady(err));
    server.on('connection', (s) => {
      // One launcher per pipe: a second connection is not ours.
      if (sock) return void s.destroy();
      sock = s;
      server.close();
      s.on('error', () => {});
      s.on('close', () => rejectReady(new Error('the launcher exited before it started the run')));
      let hello = '';
      s.setEncoding('utf8');
      s.on('data', (d: string) => {
        hello += d;
        const i = hello.indexOf('\n');
        if (i < 0) return;
        clearTimeout(timer);
        const pid = Number(hello.slice(0, i));
        if (Number.isSafeInteger(pid) && pid > 0) resolveReady(pid);
        else rejectReady(new Error('the launcher sent no PID'));
      });
    });
  });
  // Callers that never await it (a failed launch) must not crash opsd.
  ready.catch(() => {});
  server.listen(pipe);
  return {
    image,
    ready,
    go(prompt) {
      if (!sock) throw new Error('the launcher has not reported in');
      sent = true;
      sock.end(`${JSON.stringify(spec)}\n${prompt}`);
    },
    abort() {
      // After `go`, the command runs; the channel only carries the rest of its stdin.
      if (sent) return;
      fail(new Error('launch aborted'));
      server.close();
      sock?.destroy();
    },
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The executable name a PID runs now, lowercased, or null when the PID is gone. */
export function imageOf(pid: number): string | null {
  try {
    if (WIN) {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = /^"([^"]+)","(\d+)"/m.exec(out);
      return m && Number(m[2]) === pid ? m[1]!.toLowerCase() : null;
    }
    const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return comm ? basename(comm).toLowerCase() : null;
  } catch {
    return null;
  }
}

/** True while a Unix process group still has members. Surviving members keep its id reserved. */
function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Unix: stops the process group led by a child this opsd spawned. The leader may be reaped before
 * the SIGKILL deadline, so follow-up checks probe the group rather than its leader PID. Windows
 * runs are stopped through the process ledger instead (`Supervisor.kill`), never with a tree kill
 * by bare PID: `taskkill /T` matches a tree by parent PID alone, and a refused kill would leave
 * the tree running unnoticed. Throws there.
 */
export function killTree(pid: number): void {
  if (WIN) {
    throw new Error(`killTree is Unix-only; stop PID ${pid} through the process ledger`);
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // The owned group is already gone. A bare PID may have been reused, so leave it alone.
    return;
  }
  const deadline = Date.now() + 5000;
  const timer = setInterval(() => {
    if (!isGroupAlive(pid)) return clearInterval(timer);
    if (Date.now() < deadline) return;
    clearInterval(timer);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }, 200);
  timer.unref();
}

function startCommand(pid: number): [string, string[]] | null {
  if (WIN) {
    return [
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
    ];
  }
  if (process.platform === 'darwin') return ['ps', ['-o', 'lstart=', '-p', String(pid)]];
  return null;
}

/** Linux: the start time in clock ticks since boot, field 22 of /proc/<pid>/stat. */
function linuxStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) may hold spaces; fields after it follow the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** How long one creation-time read may take outside Linux, where it starts a child process. */
export const PROC_START_TIMEOUT_MS = 15_000;

/**
 * When the process started, as an opaque string. Together with the PID it names one process: a
 * later process that reuses the PID has another start time. Null when the PID is gone.
 */
export function processStartSync(pid: number): string | null {
  if (process.platform === 'linux') return linuxStart(pid);
  const cmd = startCommand(pid);
  if (!cmd) return null;
  try {
    const out = execFileSync(cmd[0], cmd[1], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROC_START_TIMEOUT_MS,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * `processStartSync` without blocking the event loop. Aborting `signal` kills the read's child
 * process and resolves null, so a pending read cannot keep the process alive.
 */
export function processStart(pid: number, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve(null);
  if (process.platform === 'linux') return Promise.resolve(linuxStart(pid));
  const cmd = startCommand(pid);
  if (!cmd) return Promise.resolve(null);
  return new Promise((resolveStart) => {
    execFile(
      cmd[0],
      cmd[1],
      { encoding: 'utf8', windowsHide: true, timeout: PROC_START_TIMEOUT_MS, signal },
      (err, stdout) => resolveStart(err ? null : stdout.trim() || null),
    );
  });
}
