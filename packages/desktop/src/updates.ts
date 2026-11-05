// Auto-update policy for the installed app: pure helpers, tested without Electron.
//
// The installer replaces the app's files, and opsd and the `ops` command run from them (the
// app's executable as Node), so opsd stops first. An update installs on its own only while no run
// is live, since a run's `ops` calls fail while the files are replaced; the person can install
// sooner and is asked first.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type UpdateStatus = 'off' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';

/** What the Settings card, the banner and the tray show about updates. */
export interface UpdateState {
  status: UpdateStatus;
  /** The running app's version. */
  current: string;
  /** The version found or downloaded. */
  version?: string;
  /** Download progress, 0 to 100. */
  percent?: number;
  error?: string;
  /** When the last check finished (ISO). */
  checkedAt?: string;
  /** The release notes of the new version, as the feed gives them. */
  notes?: string;
}

export type InstallDecision = 'install' | 'confirm' | 'wait';

/**
 * Whether to install a downloaded update now.
 * - The person asked: install when no run is live; with live runs, ask first (`confirm`).
 * - Nobody asked: install only when no run is live and no window is open (the app sits in the
 *   tray), so nobody's work or reading is cut off; otherwise wait for the next look.
 */
export function installDecision(s: {
  ready: boolean;
  asked: boolean;
  windowOpen: boolean;
  live: number;
}): InstallDecision {
  if (!s.ready) return 'wait';
  if (s.asked) return s.live === 0 ? 'install' : 'confirm';
  return s.live === 0 && !s.windowOpen ? 'install' : 'wait';
}

/** What `installUpdate` needs from the app; main.ts wires them to Electron and opsd. */
export interface InstallSteps {
  /** opsd's live runs now, and whether they keep going after it stops. */
  state(): Promise<{ live: number; runsOutlive: boolean }>;
  /** Whether the app's window is open and visible. */
  windowOpen(): boolean;
  /** The live-run dialog: true to install now. */
  confirm(live: number, runsOutlive: boolean): Promise<boolean>;
  /**
   * Stops opsd if it runs. `ifIdle`: opsd stops only when no run is live, checked in one step
   * with refusing new launches; `busy` when it refused because a run is live.
   */
  stop(opts: { ifIdle: boolean; killRuns: boolean }): Promise<'stopped' | 'busy'>;
  /** Leaves the relaunch note and restarts into the installer. */
  install(background: boolean): void;
}

export type InstallOutcome = 'installed' | 'waiting' | 'kept';

/**
 * Installs a downloaded update when `installDecision` allows it. Without the person confirming
 * live runs, opsd stops only through its atomic idle check, so a run that starts after the live
 * count was read is never cut off: an unattended install waits, and a clicked one asks first.
 */
export async function installUpdate(asked: boolean, steps: InstallSteps): Promise<InstallOutcome> {
  // A second pass only when a run started between reading the count and stopping opsd.
  for (let pass = 0; pass < 2; pass++) {
    const st = await steps.state();
    const windowOpen = steps.windowOpen();
    const decision = installDecision({ ready: true, asked, windowOpen, live: st.live });
    if (decision === 'wait') return 'waiting';
    if (decision === 'confirm') {
      if (!(await steps.confirm(st.live, st.runsOutlive))) return 'kept';
      // Runs that outlive opsd keep going and the new opsd adopts them; others end with it.
      if ((await steps.stop({ ifIdle: false, killRuns: !st.runsOutlive })) === 'busy') {
        return 'waiting';
      }
      steps.install(!windowOpen);
      return 'installed';
    }
    if ((await steps.stop({ ifIdle: true, killRuns: false })) === 'stopped') {
      steps.install(!windowOpen);
      return 'installed';
    }
    // A run started: unattended, leave the update ready for a later look.
    if (!asked) return 'waiting';
  }
  return 'waiting';
}

/** The confirm dialog's text when the person installs with runs live. */
export function installPrompt(live: number, runsOutlive: boolean): string {
  const runs = live === 1 ? '1 agent run is' : `${live} agent runs are`;
  const wait =
    'Or wait: the update installs on its own once no run is live and the window is closed.';
  return runsOutlive
    ? `${runs} live. Installing stops opsd for about a minute: the runs keep going and the new opsd picks them up, but their ops commands fail until it is back. ${wait}`
    : `${runs} live. Installing stops opsd, and its runs end with it; their tasks go back to the queue. ${wait}`;
}

/** Release notes from electron-updater: a string, or one entry per version. */
export function notesText(
  notes: string | Array<{ version: string; note: string | null }> | null | undefined,
): string | undefined {
  if (!notes) return undefined;
  if (typeof notes === 'string') return notes;
  return notes
    .map((n) => `${n.version}\n${n.note ?? ''}`.trim())
    .join('\n\n')
    .trim();
}

/** Strips HTML tags from release notes, which GitHub serves as HTML. */
export function plainNotes(notes: string | undefined): string | undefined {
  if (!notes) return undefined;
  return notes
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The note an update leaves for the app it relaunches: start in the tray when the old app had no
 * window open, so an update at night opens no window. Read once, then deleted.
 */
const MARKER = 'relaunch.json';

export function writeRelaunch(dir: string, background: boolean, now = Date.now()): void {
  writeFileSync(join(dir, MARKER), JSON.stringify({ background, at: now }));
}

/** True when a recent update asked the next start to stay in the tray. */
export function takeRelaunch(dir: string, now = Date.now()): boolean {
  const file = join(dir, MARKER);
  if (!existsSync(file)) return false;
  let background = false;
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as { background?: unknown; at?: unknown };
    // A note older than 10 minutes belongs to an update that never relaunched: ignore it.
    background = m.background === true && typeof m.at === 'number' && now - m.at < 600_000;
  } catch {
    background = false;
  }
  rmSync(file, { force: true });
  return background;
}
