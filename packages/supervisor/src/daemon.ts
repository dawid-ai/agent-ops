import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpsError, readUserConfig, samePath } from '@agent-ops/core';
import { startApi } from './api.js';
import { opsdConfig, stateDir } from './config.js';
import { seedOnStart } from './seed.js';
import { isAlive, PROC_START_TIMEOUT_MS, processStartSync } from './proc.js';
import { Supervisor } from './supervisor.js';

export const OPSD_VERSION = '0.2.0-beta.1';

/**
 * When the code opsd runs was built: the newest `.js` file of the supervisor and core packages.
 * opsd reads it at start and the desktop reads it from disk; a difference means opsd runs an
 * older build than the one installed and needs a restart.
 */
export function buildStamp(): string {
  const dirs = [dirname(fileURLToPath(import.meta.url))];
  try {
    dirs.push(dirname(createRequire(import.meta.url).resolve('@agent-ops/core')));
  } catch {
    // Core resolves in every install; a stamp from the supervisor alone still detects updates.
  }
  let newest = 0;
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      // `.mjs`: the installed app runs bundles (main.mjs, opsd.mjs, ops.mjs) from one folder.
      if (f.endsWith('.js') || f.endsWith('.mjs')) {
        newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
      }
    }
  }
  return String(Math.round(newest));
}

/** `<state>/opsd.json`: how `ops` and the desktop app reach the running supervisor. */
export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  started_at: string;
  version: string;
}

function infoFile(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'opsd.json');
}

function lockFile(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'opsd.lock');
}

/** `<state>/opsd.lock`: the holder's PID and process creation time. */
interface LockContent {
  pid: number;
  start: string | null;
}

function parseLock(raw: string): LockContent | null {
  // An early lock held only the PID.
  if (/^\d+$/.test(raw.trim())) return { pid: Number(raw.trim()), start: null };
  try {
    const v = JSON.parse(raw) as Partial<LockContent> | null;
    if (typeof v?.pid === 'number' && v.pid > 0) return { pid: v.pid, start: v.start ?? null };
  } catch {
    // Not JSON: unreadable, so the holder is unknown.
  }
  return null;
}

/**
 * Whether a lock's holder still runs. `stale` only when that is certain: the PID is gone, or it now
 * has another creation time. When the creation time cannot be read, the holder counts as alive.
 */
function holderState(c: LockContent): 'live' | 'stale' | 'unknown' {
  if (!isAlive(c.pid)) return 'stale';
  if (!c.start) return 'unknown';
  const now = processStartSync(c.pid);
  if (now === null) return isAlive(c.pid) ? 'unknown' : 'stale';
  return now === c.start ? 'live' : 'stale';
}

/**
 * Replaces a lock judged stale (content `raw`) with `mine`. Only the holder of the short-lived
 * `<lock>.takeover` file deletes a lock, and only while it still holds exactly `raw`; everyone
 * else creates a lock only where none exists. So a live lock is never deleted or displaced.
 *
 * The takeover file is never reclaimed automatically: while its holder may live, others wait;
 * when its holder is certainly gone (it crashed mid-takeover), opsd refuses and names the file.
 * Returns false when another starter is taking over or won the slot; the caller looks again.
 */
function takeOver(file: string, raw: string, mine: string): boolean {
  const guard = `${file}.takeover`;
  if (!createExclusive(guard, mine)) {
    let held: LockContent | null = null;
    try {
      held = parseLock(readFileSync(guard, 'utf8'));
    } catch {
      return false; // Gone: the other takeover finished.
    }
    if (held && holderState(held) === 'stale') {
      throw new OpsError(
        `an opsd start crashed while taking over the lock; if no opsd runs, delete ${guard}`,
      );
    }
    return false;
  }
  try {
    let current: string | null = null;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // Already gone.
    }
    if (current !== null && current !== raw) return false;
    if (current !== null) rmSync(file, { force: true });
    return createExclusive(file, mine);
  } finally {
    rmSync(guard, { force: true });
  }
}

/** Creates `file` with `text` only if it does not exist; readers never see it half written. */
function createExclusive(file: string, text: string): boolean {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    linkSync(tmp, file);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw err;
    // No hard links on this file system: create exclusively, then write. A reader that finds it
    // empty treats the holder as unknown and refuses, so this stays safe.
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, text);
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Takes the per-state-folder lock, so only one opsd runs per state folder even when two start at
 * once. A lock is replaced only when its holder is certainly gone; otherwise this throws. Returns
 * this process's creation time as written in the lock, for `releaseLock`.
 */
function acquireLock(env: NodeJS.ProcessEnv): string | null {
  const file = lockFile(env);
  const start = processStartSync(process.pid);
  const mine = JSON.stringify({ pid: process.pid, start });
  for (let attempt = 0; attempt < 20; attempt++) {
    if (createExclusive(file, mine)) return start;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (raw === mine) return start;
    const c = parseLock(raw);
    // A lock with this PID but another start time was left by a dead opsd whose PID this process
    // now has: certainly stale.
    const state =
      c && c.pid === process.pid
        ? start && c.start === start
          ? 'live'
          : 'stale'
        : c
          ? holderState(c)
          : 'unknown';
    if (state === 'live' && c!.pid === process.pid) return start;
    if (state === 'live') throw new OpsError(`opsd already runs (pid ${c!.pid})`);
    if (state === 'unknown') {
      throw new OpsError(
        `cannot tell whether ${c ? `pid ${c.pid}` : 'another opsd'} still holds ${file}; ` +
          'if no opsd runs, delete that file',
      );
    }
    if (takeOver(file, raw, mine)) return start;
    // Someone else is taking over: give them a moment, then look again.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new OpsError(`could not take ${file}: another opsd is starting; try again`);
}

/**
 * Removes the lock if this process still holds it. `start` is the creation time `acquireLock` wrote:
 * it never changes, and reading it again would start PowerShell on Windows, which a loaded machine
 * can hold past the time `stopDaemon` waits for opsd to exit.
 */
function releaseLock(env: NodeJS.ProcessEnv, start: string | null): void {
  try {
    const c = parseLock(readFileSync(lockFile(env), 'utf8'));
    if (c?.pid === process.pid && c.start === start) {
      rmSync(lockFile(env), { force: true });
    }
  } catch {
    // Gone already.
  }
}

/** Writes a file readable by this user only (POSIX modes; Windows keeps the profile's ACL). */
function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * The running supervisor's address, or null when its PID is gone. A reused PID passes this check,
 * but calls then fail on the token; `startDaemon` checks health before trusting it. Inside a
 * supervised run, calls to the opsd that started it use the run's own token (`OPS_RUN_TOKEN`), so
 * they act as the run's agent; another opsd (a test's, on its own state folder) gets its own token.
 */
export function readDaemon(env: NodeJS.ProcessEnv = process.env): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(infoFile(env), 'utf8')) as DaemonInfo;
    if (!isAlive(info.pid)) return null;
    const runToken =
      env.OPS_RUN_TOKEN && env.OPS_RUN_STATE_DIR && samePath(env.OPS_RUN_STATE_DIR, stateDir(env))
        ? env.OPS_RUN_TOKEN
        : undefined;
    return runToken ? { ...info, token: runToken } : info;
  } catch {
    return null;
  }
}

/** True when the supervisor at `info` answers with that token within 3 s. */
async function healthy(info: DaemonInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Calls the supervisor's API. Throws an OpsError with the API's message on failure. */
/** An error answer from opsd, with its HTTP status (409: runs are live). */
export class DaemonCallError extends OpsError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message, status === 400 ? 2 : 1);
    this.name = 'DaemonCallError';
  }
}

export async function daemonCall<T>(
  info: DaemonInfo,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${info.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new OpsError(`opsd at port ${info.port} does not answer: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Not JSON.
    }
    throw new DaemonCallError(message, res.status);
  }
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? JSON.parse(text) : text) as T;
}

/** A sync as the daemon log reports it. */
export interface SyncLogEntry {
  root: string;
  committed: number;
  pulled: boolean;
  pushed: boolean;
  notes?: string[];
}

/**
 * The daemon log's sync lines. A sync that did nothing and repeats the notes of the root's last
 * line gets no line: while a code branch holds the store checkout, every tick retries the sync
 * and says the same thing (AO-0135). The line comes back when the notes change or a sync does
 * something.
 */
export class SyncLog {
  private readonly last = new Map<string, string>();

  /** The line for `s`, without a time stamp, or null when it only repeats the last one. */
  line(s: SyncLogEntry): string | null {
    const notes = (s.notes ?? []).map((n) => `; ${n}`).join('');
    const line = `sync ${s.root}: committed ${s.committed}${s.pulled ? ', pulled' : ''}${s.pushed ? ', pushed' : ''}${notes}`;
    const idle = s.committed === 0 && !s.pulled && !s.pushed;
    if (idle && notes && this.last.get(s.root) === line) return null;
    this.last.set(s.root, line);
    return line;
  }
}

export interface RunDaemonOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  port?: number;
  log?: (line: string) => void;
}

/**
 * Runs the supervisor in this process until a shutdown request, SIGINT or SIGTERM. Refuses to
 * start when another opsd runs for the same state folder.
 */
export async function runDaemon(opts: RunDaemonOptions = {}): Promise<void> {
  // Agent runs inherit this env; the Electron host flag is for opsd itself only.
  const env = { ...(opts.env ?? process.env) };
  delete env.ELECTRON_RUN_AS_NODE;
  // An opsd started from inside a run must not carry that run's token.
  delete env.OPS_RUN_TOKEN;
  delete env.OPS_RUN_STATE_DIR;
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  // Checked before the lock, so a broken config never leaves a lock behind.
  opsdConfig(readUserConfig(env));
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  // One opsd per state folder: the lock is atomic, so two starts at once cannot both run.
  const lockStart = acquireLock(env);
  let user: ReturnType<typeof readUserConfig>;
  let config: ReturnType<typeof opsdConfig>;
  try {
    // Under the lock, so two starts never seed the file at once.
    const note = seedOnStart(env);
    if (note) log(`opsd: ${note}`);
  } catch (err) {
    log(`opsd: warn could not seed the user config: ${(err as Error).message}`);
  }
  try {
    user = readUserConfig(env);
    config = opsdConfig(user);
  } catch (err) {
    releaseLock(env, lockStart);
    throw err;
  }
  if (opts.port !== undefined) config.port = opts.port;
  const sup = new Supervisor({
    env,
    cwd: opts.cwd,
    user,
    config,
    build: buildStamp(),
    version: OPSD_VERSION,
  });
  const token = randomBytes(24).toString('hex');
  let stopping = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  try {
    api = await startApi(sup, {
      port: config.port,
      token,
      version: OPSD_VERSION,
      build: buildStamp(),
      onShutdown: (killRuns) => void stop(killRuns),
    });
    const info: DaemonInfo = {
      pid: process.pid,
      port: api.port,
      token,
      started_at: new Date().toISOString(),
      version: OPSD_VERSION,
    };
    writePrivate(infoFile(env), JSON.stringify(info, null, 2));
  } catch (err) {
    await api?.close();
    releaseLock(env, lockStart);
    throw err;
  }
  const server = api;

  const stamp = (): string => new Date().toISOString().slice(11, 19);
  sup.on(
    'run',
    (r: { id: string; agent: string; task?: string; status: string; reason?: string }) =>
      log(
        `${stamp()} run ${r.id} ${r.agent} ${r.task ?? '-'} ${r.status}${r.reason ? ` (${r.reason})` : ''}`,
      ),
  );
  sup.on('warn', (m: string) => log(`${stamp()} warn ${m}`));
  const syncLog = new SyncLog();
  sup.on('sync', (s: SyncLogEntry) => {
    const line = syncLog.line(s);
    if (line) log(`${stamp()} ${line}`);
  });
  sup.on('branches', (b: { top: string; pushed: { branch: string }[] }) => {
    if (b.pushed.length === 0) return;
    log(`${stamp()} push ${b.top}: ${b.pushed.map((p) => p.branch).join(', ')}`);
  });
  sup.start();
  log(
    `opsd ${OPSD_VERSION} pid ${process.pid} on 127.0.0.1:${server.port}, state ${stateDir(env)}`,
  );

  async function stop(killRuns: boolean): Promise<void> {
    if (stopping) return;
    stopping = true;
    sup.stop({ killRuns });
    await sup.close();
    await server.close();
    try {
      const cur = JSON.parse(readFileSync(infoFile(env), 'utf8')) as DaemonInfo;
      if (cur.pid === process.pid) rmSync(infoFile(env), { force: true });
    } catch {
      // Already gone.
    }
    releaseLock(env, lockStart);
    log(`opsd stopped${killRuns ? ' (runs killed)' : ''}`);
    resolveDone();
  }
  const onSignal = (): void => void stop(false);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await done;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}

/** Starts opsd in the background with no console window, logging to `<state>/opsd.log`. */
export async function startDaemon(
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; port?: number } = {},
): Promise<DaemonInfo> {
  const env = opts.env ?? process.env;
  const running = readDaemon(env);
  if (running && (await healthy(running))) return running;
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  // The installed app bundles opsd as opsd.mjs and names it in OPS_DAEMON_ENTRY. From the
  // sources (tests), start the built entry point.
  const here = fileURLToPath(import.meta.url);
  const main =
    env.OPS_DAEMON_ENTRY ??
    (here.endsWith('.ts')
      ? join(dirname(here), '..', 'dist', 'main.js')
      : join(dirname(here), 'main.js'));
  const args = [main, 'run', ...(opts.port !== undefined ? ['--port', String(opts.port)] : [])];
  const fd = openSync(join(stateDir(env), 'opsd.log'), 'a');
  // Inside Electron, execPath is the app; ELECTRON_RUN_AS_NODE makes it a plain Node process.
  const childEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
  const child = spawn(process.execPath, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: childEnv,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.unref();
  const info = await awaitDaemon(child, env);
  if (info) return info;
  throw new OpsError(`opsd did not start; see ${join(stateDir(env), 'opsd.log')}`);
}

/**
 * How long `startDaemon` waits for a new opsd to answer while its process lives. Before the API
 * answers, opsd reads creation times with blocking calls that start PowerShell on Windows, each up
 * to `PROC_START_TIMEOUT_MS`: its own for the lock, a stale lock holder's, a takeover file
 * holder's, and those of the runs it adopts. A loaded machine can hold each read to its timeout,
 * so the wait covers four of them on top of the 15 s a normal start gets.
 */
export const START_WAIT_MS = 15_000 + 4 * PROC_START_TIMEOUT_MS;

/**
 * Waits until the opsd `child` answers, or another opsd answers after `child` exited (it lost the
 * lock to that one). An exited child ends the wait at once; a live one gets `waitMs`. Null when
 * no opsd answers in time.
 */
export async function awaitDaemon(
  child: { readonly pid?: number; readonly exitCode: number | null },
  env: NodeJS.ProcessEnv,
  waitMs: number = START_WAIT_MS,
): Promise<DaemonInfo | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const info = readDaemon(env);
    if (info && info.pid === child.pid && (await healthy(info))) return info;
    if (child.exitCode !== null) {
      if (info && (await healthy(info))) return info;
      break;
    }
  }
  const winner = readDaemon(env);
  return winner && (await healthy(winner)) ? winner : null;
}

/**
 * Asks the running opsd to stop and waits until its process is gone. False when none runs;
 * throws when it is still alive after the wait, so a restart never starts a second opsd.
 * `ifIdle`: opsd stops only when no run is live, checked in one step with stopping new launches;
 * otherwise it answers 409 and this throws a `DaemonCallError` with that status.
 */
export async function stopDaemon(
  opts: { env?: NodeJS.ProcessEnv; killRuns?: boolean; ifIdle?: boolean; waitMs?: number } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  const info = readDaemon(env);
  if (!info) return false;
  await daemonCall(info, 'POST', '/api/shutdown', {
    killRuns: Boolean(opts.killRuns),
    ...(opts.ifIdle ? { ifIdle: true } : {}),
  });
  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  while (Date.now() < deadline && isAlive(info.pid)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isAlive(info.pid)) {
    throw new OpsError(
      `opsd pid ${info.pid} did not stop in time; see ${join(stateDir(env), 'opsd.log')}`,
    );
  }
  return true;
}
