// The tray icon and the background-service settings: pure helpers, tested without Electron.

/** What the tray shows about opsd on this PC. */
export interface ServiceState {
  running: boolean;
  /** Paused: no new runs or schedules start. Read from the config, so it is known while stopped. */
  paused: boolean;
  live: number;
  /** Asks, reviews and votes waiting for the human. */
  waiting: number;
  /**
   * Whether live runs keep going after opsd stops, from opsd's `runs_outlive`. True on every
   * system today (`RUNS_OUTLIVE_OPSD`); an opsd that reports false ends its runs when it stops.
   */
  runsOutlive: boolean;
}

/**
 * Whether a stop or restart now ends live runs, so it needs the person's confirmation. Only an
 * opsd whose runs cannot outlive it: otherwise the next opsd adopts them.
 */
export function stopEndsRuns(s: ServiceState): boolean {
  return s.running && s.live > 0 && !s.runsOutlive;
}

function runsText(live: number): string {
  return live === 1 ? '1 live run' : `${live} live runs`;
}

/** The system dialog for a stop or restart that ends live runs (an opsd they cannot outlive). */
export function endRunsPrompt(
  action: 'stop' | 'restart',
  live: number,
): { message: string; detail: string; confirm: string } {
  const verb = action === 'stop' ? 'Stop' : 'Restart';
  return {
    message: `${verb} opsd and end ${runsText(live)}?`,
    detail:
      'This opsd ends its runs when it stops. Ending a run releases its claim, ' +
      'and the task goes back to the queue. To let runs finish first, cancel, pause new runs ' +
      'and stop opsd when none are live.',
    confirm: `End runs and ${action}`,
  };
}

/** The error for a cancelled stop or restart that would end runs. */
export function keptRunsMessage(live: number): string {
  return `opsd keeps running: ${runsText(live)} would have ended. Pause new runs to let them finish.`;
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'pause' | 'resume';

export const SERVICE_ACTIONS: ServiceAction[] = ['start', 'stop', 'restart', 'pause', 'resume'];

/** One line for the tray tooltip and the top of its menu. */
export function serviceLine(s: ServiceState): string {
  if (!s.running) return s.paused ? 'opsd stopped (starts paused)' : 'opsd stopped';
  const runs = runsText(s.live);
  if (!s.paused) return `opsd running · ${runs}`;
  return s.live === 0 ? 'opsd paused · no live runs' : `opsd paused · ${runs} finishing`;
}

export type TrayCommand = ServiceAction | 'open' | 'inbox' | 'notify' | 'update' | 'quit';

export interface TrayItem {
  label?: string;
  command?: TrayCommand;
  enabled?: boolean;
  checked?: boolean;
  separator?: true;
}

/** The tray's right-click menu for a state; main.ts turns it into an Electron menu. */
export function trayMenu(s: ServiceState, notify: boolean, update?: string): TrayItem[] {
  const items: TrayItem[] = [{ label: serviceLine(s), enabled: false }];
  if (update) items.push({ label: `Restart to update to ${update}`, command: 'update' });
  if (s.waiting > 0) {
    items.push({
      label: s.waiting === 1 ? '1 item needs you' : `${s.waiting} items need you`,
      command: 'inbox',
    });
  }
  // A stop that ends runs says so, and asks in a dialog before it does.
  const ends = stopEndsRuns(s) ? ` (ends ${runsText(s.live)})…` : '';
  items.push(
    { separator: true },
    { label: 'Open Agent Ops', command: 'open' },
    { separator: true },
    s.running
      ? { label: `Stop opsd${ends}`, command: 'stop' }
      : { label: 'Start opsd', command: 'start' },
    s.paused
      ? { label: 'Resume new runs', command: 'resume' }
      : { label: 'Pause new runs', command: 'pause' },
    { label: `Restart opsd${ends}`, command: 'restart', enabled: s.running },
    { separator: true },
    { label: 'Notify me when I am needed', command: 'notify', checked: notify },
    { label: 'Quit Agent Ops (opsd keeps running)', command: 'quit' },
  );
  return items;
}

/** The status light's colour: green running, amber paused, grey stopped. */
export function trayColor(s: ServiceState): [number, number, number] {
  if (!s.running) return [139, 148, 158];
  return s.paused ? [210, 153, 34] : [63, 185, 80];
}

/**
 * A `size`-pixel square status light as a BGRA bitmap for `nativeImage.createFromBitmap`: a ring
 * in the state colour, plus a blue dot at the top right while something waits for the human.
 */
export function trayBitmap(s: ServiceState, size = 32): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = trayColor(s);
  const c = (size - 1) / 2;
  const outer = size * 0.44;
  const inner = size * 0.22;
  const dot = { x: size * 0.8, y: size * 0.2, r: size * 0.2 };
  const put = (i: number, rgb: [number, number, number], a: number): void => {
    buf[i] = rgb[2];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[0];
    buf[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - c, y - c);
      // A one-pixel soft edge on both sides of the ring; the centre stays solid but dimmer.
      const ring = Math.min(outer - d + 0.5, 1);
      if (ring > 0) {
        put(i, [r, g, b], d < inner ? 0.55 * ring : ring);
      }
      if (s.waiting > 0) {
        const dd = Math.hypot(x - dot.x, y - dot.y);
        const a = Math.min(dot.r - dd + 0.5, 1);
        if (a > 0) put(i, [88, 166, 255], a);
      }
    }
  }
  return buf;
}

/**
 * The sign-in entry's arguments. A packaged app starts itself; a development build starts
 * Electron with the app folder. `--ops-cwd` keeps the folder opsd starts in, since Windows starts
 * sign-in apps in another one.
 */
export function loginArgs(opts: { packaged: boolean; appPath: string; cwd: string }): string[] {
  const args = opts.packaged ? [] : [opts.appPath];
  // Electron joins the arguments with spaces, so one with a space needs its own quotes.
  return [...args, '--background', `--ops-cwd=${opts.cwd}`].map((a) =>
    /\s/.test(a) ? `"${a}"` : a,
  );
}

/** Where Windows keeps sign-in apps, and where Task Manager turns them off. */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const APPROVED_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

/** One value from the output of `reg query KEY /v NAME`, or null when it is not there. */
export function regValue(out: string | null, name: string): { type: string; data: string } | null {
  for (const line of (out ?? '').split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    // Value names are case-insensitive in the registry.
    if (m && m[1]!.toLowerCase() === name.toLowerCase()) {
      return { type: m[2]!, data: (m[3] ?? '').trim() };
    }
  }
  return null;
}

/** The app's sign-in entry, read by its name wherever the app was when it made the entry. */
export interface LoginEntry {
  /** The command line Windows runs at sign-in, or null when there is no entry. */
  command: string | null;
  /** Turned off in Task Manager > Startup apps: the entry stays but Windows skips it. */
  off: boolean;
  /** Whether the command starts this app, from this folder, with these arguments. */
  current: boolean;
}

/** Compares command lines without quotes, case or extra spaces, as Windows paths compare. */
function sameCommand(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The entry from `reg query` output for the Run key and the StartupApproved key. A
 * StartupApproved value whose first byte is odd (`03…`) is an entry turned off in Task Manager.
 */
export function loginEntry(
  runOut: string | null,
  approvedOut: string | null,
  name: string,
  item: { path: string; args: string[] },
): LoginEntry {
  const run = regValue(runOut, name);
  if (!run || !run.data) return { command: null, off: false, current: false };
  const approved = regValue(approvedOut, name);
  const first = approved ? parseInt(approved.data.slice(0, 2), 16) : 2;
  return {
    command: run.data,
    off: Number.isFinite(first) && (first & 1) === 1,
    current: sameCommand(run.data, [item.path, ...item.args].join(' ')),
  };
}

/** `--ops-cwd=DIR` from the command line, if given. */
export function cwdArg(argv: string[]): string | undefined {
  const a = argv.find((x) => x.startsWith('--ops-cwd='));
  return a ? a.slice('--ops-cwd='.length) || undefined : undefined;
}

/** The desktop's own settings in the user config, under `desktop:`. */
export interface DesktopSettings {
  /** Windows notifications for asks, reviews and votes that wait for the human. */
  notify: boolean;
}

export function desktopSettings(user: unknown): DesktopSettings {
  const d = (user as { desktop?: { notify?: unknown } } | null)?.desktop;
  return { notify: d?.notify !== false };
}
