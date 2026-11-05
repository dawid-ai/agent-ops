import { processStartSync, systemLister, type ProcLister } from '../src/index.js';

/**
 * Stops a leftover process this test started, by PID, but only while the PID still runs a process
 * created no later than `aliveAt`, a time the test knew its own process was running.
 *
 * A bare `process.kill(pid)` in cleanup can hit another process: once the test's process exits,
 * Windows hands its PID to the next process soon, often a new vitest worker, and killing that
 * worker ends the whole run with ERR_IPC_CHANNEL_CLOSED (AO-0145). A process that took the PID
 * over was created after the original exited, so after `aliveAt`, and is left alone.
 *
 * The kill goes only through the lister's identity-checked kill, which checks the creation time at
 * the moment of the kill. It fails closed: with a lister that cannot tell a reused PID apart
 * (macOS and other Unix), or when that kill reports an error, the process is left running. A
 * leftover test process is cheaper than killing an unrelated one.
 *
 * @param given The process lister to use; without it, the call opens the system lister and closes it.
 * @returns true when this call stopped the process; false when the PID is gone, runs another
 *   process, its creation time cannot be read, or the lister cannot kill it safely.
 */
export async function killOwn(pid: number, aliveAt: number, given?: ProcLister): Promise<boolean> {
  const lister = given ?? systemLister();
  try {
    if (!lister.precise) return false;
    const snap = await lister.list().catch(() => []);
    let start = snap.find((p) => p.pid === pid)?.start ?? null;
    // A lister that sees no process, as in a sandbox: read the one PID instead. Only Windows needs
    // this; Linux reports clock ticks there, not a time, but its lister reads /proc and is never blind.
    if (start === null && process.platform === 'win32') {
      const read = processStartSync(pid);
      const ms = read === null ? NaN : Date.parse(read);
      if (!Number.isNaN(ms)) start = ms;
    }
    if (start === null || start > aliveAt + lister.clockSlack) return false;
    return (await lister.kill([{ pid, start }])).get(pid) === 'killed';
  } finally {
    if (!given) lister.close();
  }
}
