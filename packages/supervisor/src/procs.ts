import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const WIN = process.platform === 'win32';

/** One process from a system snapshot. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Unix: the process group. Runs lead their own group, so its id is the run's root PID. */
  pgid?: number;
  name: string;
  cmd: string;
  /** Creation time in ms since the epoch. With the PID, it names one process. */
  start: number;
}

/** A process to kill, named by PID and creation time. */
export interface ProcTarget {
  pid: number;
  start: number;
}

/**
 * `killed`; `gone` (no such PID); `other` (the PID runs another process now, left alone);
 * `error` (could not check or kill).
 */
export type KillResult = 'killed' | 'gone' | 'other' | 'error';

/** Lists every process on the machine and kills processes by identity. */
export interface ProcLister {
  /**
   * Creation times are exact (Windows: 1 ms from the kernel; Linux: clock ticks). Without that,
   * opsd keeps no ledger: a PID reused within the same second could not be told apart.
   */
  readonly precise: boolean;
  /**
   * How far creation times may be off the wall clock, in ms: Linux derives them from a boot time
   * in whole seconds. Rules that compare them with snapshot times allow for it.
   */
  readonly clockSlack: number;
  list(): Promise<ProcInfo[]>;
  /**
   * Kills each target only if its PID still runs a process with that creation time, checked at
   * the moment of the kill (Windows: through the open process handle, so the PID cannot be reused
   * in between).
   */
  kill(targets: ProcTarget[]): Promise<Map<number, KillResult>>;
  /** PIDs of the lister's own helper processes, never taken for a run's. */
  ownPids?(): number[];
  close(): void;
}

/** One process a run started, directly or through its children. */
export interface ProcEntry {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  start: number;
  first_seen: string;
  last_seen: string;
  /** The first snapshot that no longer had it. */
  gone_at?: string;
  /** When opsd killed it after the run ended. */
  killed_at?: string;
  /**
   * Its parent had exited when it was first seen, and the parent's PID could have been reused in
   * between, so it may not be the run's. Listed for a human to check; never killed automatically.
   */
  unsure?: true;
}

/** Every process seen for one run, kept in `<state>/procs/<run>.json`. */
export interface ProcLedger {
  run: string;
  root_pid: number;
  /** The root's creation time from the run record; without it the ledger stays empty. */
  root_start: number | null;
  entries: ProcEntry[];
}

/** A ledger entry with whether it still runs, from a fresh snapshot. */
export interface ProcView extends ProcEntry {
  alive: boolean;
}

type Verdict = 'yes' | 'unsure' | 'no';

/**
 * Whether `p` is a child of ledger entry `e` by its parent PID. While `e` runs, yes. After `e`
 * exited, its PID may have gone to another process, so: yes if `p` started before the last
 * snapshot that saw `e` alive (allowing for clock slack); no if a process holding the PID now started before `p` (likely its
 * parent), or if `p` started after `e` was seen gone; otherwise unsure.
 */
function childOf(
  p: ProcInfo,
  e: ProcEntry,
  holder: ProcInfo | undefined,
  clockSlack: number,
): Verdict {
  if (p.ppid !== e.pid || p.start < e.start) return 'no';
  if (!e.gone_at) return 'yes';
  if (p.start + clockSlack <= Date.parse(e.last_seen)) return 'yes';
  if (p.start > Date.parse(e.gone_at)) return 'no';
  if (holder && holder.start !== e.start && p.start >= holder.start) return 'no';
  return 'unsure';
}

/**
 * Adds the run's processes from a snapshot to its ledger and marks the ones that are gone.
 *
 * - The root joins only with the creation time from the run record, so a later process that
 *   reused the root's PID is never taken for it.
 * - A process joins when its parent PID names a ledger entry (`childOf`). That keeps children
 *   whose parent exited, which a tree kill misses; the ones that may belong to a process that
 *   reused the parent's PID join as unsure.
 * - Unix: a process in the root's process group joins the same way, which keeps children that
 *   were reparented after their parent exited.
 */
export function track(
  ledger: ProcLedger,
  snapshot: ProcInfo[],
  now: number,
  exclude: number[] = [],
  clockSlack = 0,
): number {
  const at = new Date(now).toISOString();
  const byPid = new Map(snapshot.map((p) => [p.pid, p]));
  const skip = new Set([process.pid, ...exclude]);
  for (const e of ledger.entries) {
    const p = byPid.get(e.pid);
    if (p && p.start === e.start && !e.gone_at) e.last_seen = at;
    else e.gone_at ??= at;
  }
  const known = (p: ProcInfo): boolean =>
    ledger.entries.some((e) => e.pid === p.pid && e.start === p.start);
  const add = (p: ProcInfo, unsure: boolean): void => {
    ledger.entries.push({
      pid: p.pid,
      ppid: p.ppid,
      name: p.name,
      cmd: p.cmd,
      start: p.start,
      first_seen: at,
      last_seen: at,
      ...(unsure ? { unsure: true as const } : {}),
    });
  };
  let added = 0;
  const root = byPid.get(ledger.root_pid);
  if (
    root &&
    ledger.root_start !== null &&
    root.start === ledger.root_start &&
    !ledger.entries.some((e) => e.pid === root.pid) &&
    !skip.has(root.pid)
  ) {
    add(root, false);
    added++;
  }
  const rootEntry = ledger.entries.find((e) => e.pid === ledger.root_pid && !e.unsure);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of snapshot) {
      if (skip.has(p.pid) || known(p)) continue;
      let best: Verdict = 'no';
      for (const e of ledger.entries) {
        const v = childOf(p, e, byPid.get(e.pid), clockSlack);
        // A child of an unsure process is unsure too.
        const verdict: Verdict = v === 'yes' && e.unsure ? 'unsure' : v;
        if (verdict === 'yes') {
          best = 'yes';
          break;
        }
        if (verdict === 'unsure') best = 'unsure';
      }
      if (best === 'no' && rootEntry && p.pgid === rootEntry.pid && p.pid !== rootEntry.pid) {
        best = childOf(
          { ...p, ppid: rootEntry.pid },
          rootEntry,
          byPid.get(rootEntry.pid),
          clockSlack,
        );
      }
      if (best === 'no') continue;
      add(p, best === 'unsure');
      added++;
      grew = true;
    }
  }
  return added;
}

/**
 * Ledger entries the snapshot shows still running: same PID and same creation time. Unsure ones
 * only with `unsure: true`.
 */
export function survivors(
  ledger: ProcLedger,
  snapshot: ProcInfo[],
  opts: { unsure?: boolean } = {},
): ProcEntry[] {
  const byPid = new Map(snapshot.map((p) => [p.pid, p]));
  return ledger.entries.filter((e) => {
    if (e.unsure && !opts.unsure) return false;
    const p = byPid.get(e.pid);
    return p !== undefined && p.start === e.start;
  });
}

export function viewLedger(ledger: ProcLedger, snapshot: ProcInfo[]): ProcView[] {
  const alive = new Set(survivors(ledger, snapshot, { unsure: true }));
  return ledger.entries.map((e) => ({ ...e, alive: alive.has(e) }));
}

/** Marks the entries a `ProcLister.kill` reports as killed. */
export function applyKills(
  entries: ProcEntry[],
  results: Map<number, KillResult>,
  now: number,
): void {
  const at = new Date(now).toISOString();
  for (const e of entries) if (results.get(e.pid) === 'killed') e.killed_at = at;
}

/**
 * A run record's `proc_start` as ms since the epoch, comparable with snapshot creation times:
 * ISO text on Windows, `ps lstart` text on macOS, clock ticks since boot on Linux. Null when it is
 * missing or unreadable, which keeps the ledger empty: fail closed.
 */
export function startMs(procStart: string | undefined): number | null {
  if (!procStart) return null;
  if (/^\d+$/.test(procStart)) {
    try {
      const btime = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
      if (!btime) return null;
      return linuxStartMs(Number(btime[1]), Number(procStart));
    } catch {
      return null;
    }
  }
  const ms = Date.parse(procStart.replace(/\s+/g, ' '));
  return Number.isNaN(ms) ? null : ms;
}

/** Linux: boot time in seconds plus start ticks (USER_HZ is 100), in ms. */
function linuxStartMs(btime: number, ticks: number): number {
  return btime * 1000 + ticks * 10;
}

// ---- Listers ---------------------------------------------------------------------------------

const END = '<<OPS-PROCS-END>>';
const PS_QUERY =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine' +
  " | ForEach-Object { '{0}\t{1}\t{2}\t{3}\t{4}' -f $_.ProcessId, $_.ParentProcessId," +
  " $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }), $_.Name," +
  " ($_.CommandLine -replace '[\\t\\r\\n]', ' ') }";

/**
 * Opens the process, checks its creation time through that handle, and terminates it through the
 * same handle. Windows does not reuse a PID while a handle to it is open, so the check and the
 * kill always see one process. Creation time in ms since the epoch, as CIM reports it.
 */
const KILL_TYPE =
  'using System; using System.Runtime.InteropServices; public static class OpsProcKill { ' +
  '[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid); ' +
  '[DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user); ' +
  '[DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code); ' +
  '[DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code); ' +
  '[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h); ' +
  'public static string Kill(uint pid, long createdMs) { IntPtr h = OpenProcess(0x0001 | 0x1000, false, pid); ' +
  // Only ERROR_INVALID_PARAMETER means no such PID; a refused open (access denied, a sandbox)
  // leaves the process running, so it is an error, never "gone".
  'if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? "gone" : "error"; ' +
  'try { long c, e, k, u; ' +
  'if (!GetProcessTimes(h, out c, out e, out k, out u)) return "error"; ' +
  'if ((c - 116444736000000000L) / 10000L != createdMs) return "other"; ' +
  'uint code; if (GetExitCodeProcess(h, out code) && code != 259) return "gone"; ' +
  'return TerminateProcess(h, 1) ? "killed" : "error"; } finally { CloseHandle(h); } } }';

/**
 * Windows: one PowerShell process answers every snapshot and kill, so a look starts no new
 * process. It reads commands on stdin and exits when opsd closes it or exits.
 */
class PowerShellLister implements ProcLister {
  readonly precise = true;
  readonly clockSlack = 0;
  private child?: ChildProcess;
  private killReady = false;
  private buf = '';
  private queue: Array<{ resolve: (s: string) => void; reject: (e: Error) => void }> = [];

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.on('error', () => {});
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      this.buf += d;
      for (let i = this.buf.indexOf(END); i >= 0; i = this.buf.indexOf(END)) {
        const out = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + END.length);
        this.queue.shift()?.resolve(out);
      }
    });
    child.on('exit', () => {
      for (const q of this.queue.splice(0)) q.reject(new Error('process lister exited'));
      if (this.child === child) this.child = undefined;
      this.buf = '';
    });
    // The helper never keeps opsd (or a test) alive on its own.
    child.unref();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    this.child = child;
    this.killReady = false;
    return child;
  }

  /** Runs one line in the helper and returns what it printed. */
  private run(command: string): Promise<string> {
    const child = this.ensure();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('process helper timed out'));
        this.close();
      }, 30_000);
      timer.unref();
      this.queue.push({
        resolve: (out) => {
          clearTimeout(timer);
          resolve(out);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin!.write(`${command}; '${END}'\n`);
    });
  }

  async list(): Promise<ProcInfo[]> {
    return parseWindows(await this.run(PS_QUERY));
  }

  async kill(targets: ProcTarget[]): Promise<Map<number, KillResult>> {
    const out = new Map<number, KillResult>();
    if (targets.length === 0) return out;
    if (!this.killReady) {
      await this.run(`Add-Type -TypeDefinition '${KILL_TYPE}'`);
      this.killReady = true;
    }
    const lines = targets
      .filter((t) => Number.isInteger(t.pid) && Number.isInteger(t.start) && t.pid !== process.pid)
      .map((t) => `'{0} {1}' -f ${t.pid}, [OpsProcKill]::Kill(${t.pid}, ${t.start})`);
    const text = await this.run(lines.join('; '));
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\d+) (killed|gone|other|error)$/.exec(line.trim());
      if (m) out.set(Number(m[1]), m[2] as KillResult);
    }
    for (const t of targets) if (!out.has(t.pid)) out.set(t.pid, 'error');
    return out;
  }

  ownPids(): number[] {
    return this.child?.pid ? [this.child.pid] : [];
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    // Its own helper, by the PID this lister spawned.
    if (child.exitCode === null) child.kill();
  }
}

export function parseWindows(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [pid, ppid, created, name, ...cmd] = line.split('\t');
    const start = created ? Date.parse(created) : NaN;
    if (!/^\d+$/.test(pid ?? '') || Number.isNaN(start)) continue;
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid),
      name: name ?? '',
      cmd: cmd.join(' ').trim(),
      start,
    });
  }
  return procs;
}

/** Linux: reads `/proc` directly, with creation times in clock ticks since boot. */
class LinuxLister implements ProcLister {
  readonly precise = true;
  readonly clockSlack = 1000;

  private btime(): number {
    const m = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
    if (!m) throw new Error('no btime in /proc/stat');
    return Number(m[1]);
  }

  private read(pid: number, btime: number): ProcInfo | null {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const info = parseLinuxStat(stat, btime);
      if (!info) return null;
      let cmd = info.name;
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim() || cmd;
      } catch {
        // Exited while being read.
      }
      return { ...info, cmd };
    } catch {
      return null;
    }
  }

  list(): Promise<ProcInfo[]> {
    const btime = this.btime();
    const procs: ProcInfo[] = [];
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const p = this.read(Number(d), btime);
      if (p) procs.push(p);
    }
    return Promise.resolve(procs);
  }

  kill(targets: ProcTarget[]): Promise<Map<number, KillResult>> {
    const btime = this.btime();
    const out = new Map<number, KillResult>();
    for (const t of targets) {
      if (t.pid === process.pid) {
        out.set(t.pid, 'other');
        continue;
      }
      // Checked right before the signal. Linux hands out PIDs in order and wraps only after the
      // whole range, so reuse between the read and the signal needs a full wrap in microseconds.
      const p = this.read(t.pid, btime);
      if (!p) out.set(t.pid, 'gone');
      else if (p.start !== t.start) out.set(t.pid, 'other');
      else {
        try {
          process.kill(t.pid, 'SIGKILL');
          out.set(t.pid, 'killed');
        } catch (err) {
          // The PID was just read from /proc with a matching start time, so only ESRCH means it
          // exited in between. EPERM and anything else means the kill was refused and it still runs.
          out.set(t.pid, (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'error');
        }
      }
    }
    return Promise.resolve(out);
  }

  close(): void {}
}

/** Parses `/proc/<pid>/stat`: the name (field 2) may hold spaces and parentheses. */
export function parseLinuxStat(stat: string, btime: number): Omit<ProcInfo, 'cmd'> | null {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const fields = stat.slice(close + 2).split(' ');
  // After the name: state(3) ppid(4) pgrp(5) ... starttime(22), so index = field - 3.
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const ticks = Number(fields[19]);
  if (![ppid, pgid, ticks].every(Number.isFinite)) return null;
  return {
    pid: Number(stat.slice(0, open).trim()),
    ppid,
    pgid,
    name: stat.slice(open + 1, close),
    start: linuxStartMs(btime, ticks),
  };
}

/**
 * macOS and other Unix: `ps` reports creation times in whole seconds, too coarse to tell a
 * reused PID apart, so opsd lists processes for viewing but keeps no ledger and kills nothing.
 */
class CoarseLister implements ProcLister {
  readonly precise = false;
  readonly clockSlack = 1000;

  list(): Promise<ProcInfo[]> {
    return new Promise((resolve, reject) => {
      execFile(
        'ps',
        ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'args='],
        { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(parsePs(stdout))),
      );
    });
  }

  kill(targets: ProcTarget[]): Promise<Map<number, KillResult>> {
    return Promise.resolve(new Map(targets.map((t) => [t.pid, 'error' as const])));
  }

  close(): void {}
}

export function parsePs(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  const re = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;
  for (const line of out.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const start = Date.parse(m[4]!.replace(/\s+/g, ' '));
    if (Number.isNaN(start)) continue;
    const cmd = m[5]!.trim();
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      name: basename(cmd.split(' ')[0] ?? ''),
      cmd,
      start,
    });
  }
  return procs;
}

export function systemLister(): ProcLister {
  if (WIN) return new PowerShellLister();
  if (process.platform === 'linux') return new LinuxLister();
  return new CoarseLister();
}
