import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LeftoverCommit } from './checkout.js';
import type { ProcLedger } from './procs.js';

/** Renames into place, retrying while Windows holds the target open for a reader. */
function replaceFile(tmp: string, file: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** One supervised agent run, kept in `<state>/runs/<id>.json`. */
export interface RunRecord {
  id: string;
  agent: string;
  task?: string;
  /** The task's root name. */
  root?: string;
  /** The project the run counts against: the task's project, else its root's name. */
  project?: string;
  /** A review run: it gives a verdict on the task and holds no claim. */
  review?: boolean;
  /**
   * A question run (AO-0063): it answers a question task and writes nothing in the checkout, so
   * role limits per project and the one-writer-per-checkout rule neither stop nor count it.
   */
  question?: boolean;
  /** A helper run (`ops spawn`): the run that started it. It works under that run's claim. */
  parent?: string;
  schedule?: string;
  /**
   * A run with no task on the standard prompt: it reads the agent's whole inbox (AO-0128).
   * Missing for runs with their own prompt, such as a schedule's or a helper's.
   */
  inbox?: boolean;
  /** A turn of the desktop chat with the orchestrator. */
  chat?: boolean;
  pid: number;
  /** Executable name of the PID, checked before an adopted run is killed. */
  image: string;
  /** The process creation time, so a later process that reuses the PID is never taken for it. */
  proc_start?: string;
  /**
   * Windows: the hidden `cmd.exe` opsd started the run through. `pid`, `image` and `proc_start`
   * name it until the run's launcher reports in, then the launcher, which outlives opsd and runs
   * the command.
   */
  shim_pid?: number;
  command: string;
  cwd: string;
  log: string;
  started_at: string;
  ended_at?: string;
  status: 'running' | 'ended';
  exit?: number | null;
  /** `exit`, `budget`, `tokens`, `killed`, `lost` or `shutdown`. */
  reason?: string;
  budget_minutes: number;
  token_budget?: number;
  tokens: number;
  /** Processes of the run still alive after it ended and opsd tried to kill them. */
  procs_left?: number;
  /**
   * SHA-256 of the run's API token (`OPS_RUN_TOKEN`). The token itself lives only in the run's
   * environment; the hash lets an opsd that adopts the run still recognize it.
   */
  token_sha256?: string;
  /**
   * A top-level run of a role that writes: the commit checked out in its git checkout when it
   * started. What the run leaves there is committed on a branch from it.
   */
  base?: string;
  /**
   * How far the wrap-up after the run's end got, so a restarted opsd resumes it: `pending` from
   * the end, `committed` once what the run left is dealt with (`leftovers`, `not_committed`),
   * `recorded` once the run-end event is on the task, `settled` once the task is freed or sent
   * for review, `done` after the sync. Absent on runs ended before opsd kept it.
   */
  wrap_up?: 'pending' | 'committed' | 'recorded' | 'settled' | 'done';
  /** What opsd committed of what the run left. */
  leftovers?: Leftovers;
  /** Why opsd left the run's changes uncommitted. */
  not_committed?: string;
}

/** A commit of what a run left, in the checkout `top`; `into` is the branch to merge it into. */
export type Leftovers = LeftoverCommit & { top: string; into: string | null };

export class RunStore {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'runs'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    mkdirSync(join(dir, 'procs'), { recursive: true });
  }

  /** The run's process ledger, or null when none was kept. */
  procs(id: string): ProcLedger | null {
    return this.readJson<ProcLedger | null>(join('procs', `${id}.json`), null);
  }

  saveProcs(ledger: ProcLedger): void {
    this.writeJson(join('procs', `${ledger.run}.json`), ledger);
  }

  logPath(id: string): string {
    return join(this.dir, 'logs', `${id}.log`);
  }

  save(r: RunRecord): void {
    const file = join(this.dir, 'runs', `${r.id}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(r, null, 2));
    replaceFile(tmp, file);
  }

  get(id: string): RunRecord | undefined {
    const file = join(this.dir, 'runs', `${id}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
    } catch {
      return undefined;
    }
  }

  /** Every run, newest first. */
  list(): RunRecord[] {
    return readdirSync(join(this.dir, 'runs'))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => this.get(f.slice(0, -5)))
      .filter((r): r is RunRecord => r !== undefined);
  }

  readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  writeJson(name: string, data: unknown): void {
    const file = join(this.dir, name);
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    replaceFile(`${file}.tmp`, file);
  }
}
