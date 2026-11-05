import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  defaultHumanId,
  editUserConfig,
  readUserConfig,
  setupUserConfig,
  suggestedRoot,
  userConfigPath,
} from '@agent-ops/core';
import type { DaemonInfo } from '@agent-ops/supervisor';
import {
  buildStamp,
  checkRuntime,
  daemonCall,
  DaemonCallError,
  editRuntime,
  opsdConfig,
  readDaemon,
  RUNS_OUTLIVE_OPSD,
  seedUserConfig,
  setPaused,
  startDaemon,
  stopDaemon,
} from '@agent-ops/supervisor';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  session,
  shell,
  Tray,
} from 'electron';
import electronUpdater from 'electron-updater';
import { allowedCall, attachmentName, ATTACHMENT_SCHEME } from './allow.js';
import { inboxTarget } from './route.js';
import { runtimeDetail } from './runtime-dialog.js';
import type { UpdateState } from './updates.js';
import {
  installPrompt,
  installUpdate as runInstall,
  notesText,
  plainNotes,
  takeRelaunch,
  writeRelaunch,
} from './updates.js';
import type { LoginEntry, ServiceAction, ServiceState, TrayCommand } from './service.js';
import {
  APPROVED_KEY,
  cwdArg,
  desktopSettings,
  endRunsPrompt,
  keptRunsMessage,
  loginArgs,
  loginEntry,
  RUN_KEY,
  SERVICE_ACTIONS,
  serviceLine,
  stopEndsRuns,
  trayBitmap,
  trayMenu,
} from './service.js';
import type { VoiceChange } from './voice.js';
import {
  checkVoicePatch,
  CLOUD_KEY_ENV,
  permissionAllowed,
  transcribeCloud,
  transcribeLocal,
  voiceProblem,
  voiceSettings,
  wavProblem,
  writeVoice,
} from './voice.js';

const here = dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
let info: DaemonInfo | null = null;
let me: string | null = null;
let streamAbort: AbortController | null = null;
const notified = new Set<string>();
let firstPass = true;
/** Asks, reviews and votes waiting for the human at the last inbox read, for the tray. */
let waiting = 0;
/**
 * Started with `--background` (the Windows sign-in entry), or relaunched by an update that found
 * no window open: tray only, no window.
 */
let background = process.argv.includes('--background');
/** The installed app, as opposed to a development build run from the engine checkout. */
const packaged = app.isPackaged;
if (packaged) {
  // The `ops` command for agent runs: opsd puts this folder first on their PATH.
  process.env.OPS_BIN_DIR ??= join(process.resourcesPath, 'bin');
}
/** The folder opsd starts in: the sign-in entry passes the one the person chose it from. */
const opsCwd = cwdArg(process.argv) ?? process.env.OPS_CWD ?? process.cwd();
/** Name of the sign-in entry, the same for reading and writing it. */
const LOGIN_NAME = 'Agent Ops';

/**
 * The running opsd. With `start`, starts one in the background when none runs; the app does that
 * once, when the window opens. Reconnects only look it up, so they never start a second one.
 */
async function daemon(start = false): Promise<DaemonInfo> {
  info = readDaemon();
  if (!info && start) info = await startDaemon({ cwd: opsCwd });
  if (!info) {
    throw new Error(
      'opsd is not running: start it from the tray icon, Settings or `ops daemon start`',
    );
  }
  return info;
}

/**
 * Serves `ops-att://file/<name>`: an attached image, read through opsd, which looks it up by name
 * in the data roots only. The page cannot reach opsd itself, and its CSP allows images from this
 * scheme and from nowhere else outside the app.
 */
async function attachmentResponse(url: string): Promise<Response> {
  const res = await fetchAttachment(url);
  // A smoke check fails on an image that does not load.
  if (offscreen && !res.ok) problems.push(`attachment ${url}: ${res.status}`);
  return res;
}

async function fetchAttachment(url: string): Promise<Response> {
  const name = attachmentName(url);
  if (!name) return new Response('bad attachment', { status: 400 });
  const get = (d: DaemonInfo): Promise<Response> =>
    fetch(`http://127.0.0.1:${d.port}/api/attachments/${name}`, {
      headers: { authorization: `Bearer ${d.token}` },
    });
  try {
    const d = info ?? (await daemon());
    let res: Response;
    try {
      res = await get(d);
    } catch (err) {
      // opsd may have restarted on another port; look it up once and retry.
      const fresh = readDaemon();
      if (!fresh || (fresh.pid === d.pid && fresh.port === d.port)) throw err;
      info = fresh;
      res = await get(fresh);
    }
    if (!res.ok) return new Response('not found', { status: res.status === 404 ? 404 : 502 });
    return new Response(await res.arrayBuffer(), {
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('opsd does not answer', { status: 502 });
  }
}

// Before the app is ready: lets the page load images from the scheme like from a web origin.
protocol.registerSchemesAsPrivileged([
  { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true } },
]);

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const d = info ?? (await daemon());
  try {
    return await daemonCall(d, method, path, body);
  } catch (err) {
    // opsd may have restarted on another port; look it up once and retry.
    const fresh = readDaemon();
    if (fresh && (fresh.pid !== d.pid || fresh.port !== d.port)) {
      info = fresh;
      return daemonCall(fresh, method, path, body);
    }
    throw err;
  }
}

/** Forwards opsd's Server-Sent Events to the window; reconnects with a short backoff. */
async function stream(): Promise<void> {
  let delay = 1000;
  for (;;) {
    streamAbort = new AbortController();
    try {
      const d = await daemon();
      const res = await fetch(`http://127.0.0.1:${d.port}/api/events`, {
        headers: { authorization: `Bearer ${d.token}` },
        signal: streamAbort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
      send('ops:status', { connected: true, pid: d.pid, port: d.port, version: d.version });
      delay = 1000;
      // Notifications need the human's id even when no window ever asked for it.
      if (!me) {
        const health = (await call('GET', '/api/health').catch(() => null)) as Health | null;
        me = health?.me ?? null;
      }
      void notifyInbox();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event) continue;
          const parsed: unknown = data ? JSON.parse(data) : null;
          send('ops:event', { event, data: parsed });
          if (event === 'changed' || event === 'hello') void notifyInbox();
          refreshTraySoon();
        }
      }
    } catch (err) {
      if (streamAbort.signal.aborted) return;
      send('ops:status', { connected: false, error: (err as Error).message });
    }
    refreshTraySoon();
    // A start from the tray or Settings ends the wait early.
    await new Promise<void>((r) => {
      wakeStream = r;
      setTimeout(r, delay);
    });
    wakeStream = null;
    delay = Math.min(delay * 2, 15_000);
    info = null;
  }
}

let wakeStream: (() => void) | null = null;

interface InboxItem {
  kind: string;
  task: string;
  title: string;
  event?: string;
  summary: string;
}

/** A desktop notification for each new ask, review, finding or decision waiting for the human. */
async function notifyInbox(): Promise<void> {
  if (!me || !Notification.isSupported()) return;
  try {
    const items = (await call('GET', `/api/inbox?as=${encodeURIComponent(me)}`)) as InboxItem[];
    const next = items.filter((it) =>
      ['ask', 'review', 'triage', 'decide'].includes(it.kind),
    ).length;
    if (next !== waiting) {
      waiting = next;
      refreshTraySoon();
    }
    const allowed = desktopSettings(readUserConfig()).notify;
    for (const it of items) {
      if (!['ask', 'review', 'triage', 'decide', 'mention', 'message'].includes(it.kind)) continue;
      const key = `${it.kind}:${it.task}:${it.event ?? ''}`;
      if (notified.has(key)) continue;
      notified.add(key);
      // Items already waiting when the app starts are shown in the inbox, not as notifications.
      if (firstPass || !allowed) continue;
      const n = new Notification({ title: `${it.task}: ${it.kind}`, body: it.summary || it.title });
      n.on('click', () => void openWindow(inboxTarget(it)));
      n.show();
    }
    firstPass = false;
  } catch {
    // The window shows connection problems; notifications stay quiet.
  }
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Screenshot mode renders offscreen, so it works without a GPU or a visible desktop. */
const offscreen = Boolean(process.env.AGENT_OPS_SCREENSHOTS);
// A CI runner has no GPU: page captures fail there with UnknownVizError unless Chromium renders
// in software from the start.
if (offscreen) app.disableHardwareAcceleration();

// ---- Window, tray and the background service ---------------------------------------------------

/** Where the page goes once it has loaded, for a window opened from a notification or the tray. */
let pendingNav: unknown = null;

/** Shows the window, creating it when it was closed, and optionally opens a view in it. */
async function openWindow(target?: unknown): Promise<void> {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (target) send('ops:navigate', target);
    return;
  }
  pendingNav = target ?? null;
  await createWindow();
}

let tray: Tray | null = null;
let trayTimer: ReturnType<typeof setTimeout> | null = null;

/** opsd's state for the tray: running from its pid file, paused from the config. */
async function serviceState(): Promise<ServiceState> {
  let paused = false;
  try {
    paused = opsdConfig(readUserConfig()).paused;
  } catch {
    // A config opsd refuses shows in the app; the tray shows it as not paused.
  }
  const d = readDaemon();
  if (!d) return { running: false, paused, live: 0, waiting, runsOutlive: RUNS_OUTLIVE_OPSD };
  info = d;
  const health = (await call('GET', '/api/health').catch(() => null)) as Health | null;
  return {
    running: Boolean(health),
    paused: health?.paused ?? paused,
    live: health?.live ?? 0,
    waiting,
    runsOutlive: health?.runs_outlive ?? RUNS_OUTLIVE_OPSD,
  };
}

/** Redraws the tray icon, tooltip and menu; calls within a second share one redraw. */
function refreshTraySoon(): void {
  if (!tray || trayTimer) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    void refreshTray();
  }, 1000);
}

async function refreshTray(): Promise<void> {
  if (!tray || tray.isDestroyed()) return;
  const st = await serviceState();
  const icon = nativeImage.createFromBitmap(trayBitmap(st, 32), {
    width: 32,
    height: 32,
    scaleFactor: 2,
  });
  tray.setImage(icon);
  tray.setToolTip(`Agent Ops: ${serviceLine(st)}`);
  // The window follows changes made elsewhere, such as `ops daemon pause`.
  send('ops:service', st);
  const notify = desktopSettings(readUserConfig()).notify;
  const ready = update.status === 'ready' ? update.version : undefined;
  tray.setContextMenu(
    Menu.buildFromTemplate(
      trayMenu(st, notify, ready).map((it) =>
        it.separator
          ? { type: 'separator' as const }
          : {
              label: it.label,
              enabled: it.enabled ?? true,
              type: it.checked === undefined ? ('normal' as const) : ('checkbox' as const),
              checked: it.checked,
              click: it.command ? () => void trayCommand(it.command!) : undefined,
            },
      ),
    ),
  );
}

async function trayCommand(cmd: TrayCommand): Promise<void> {
  try {
    if (cmd === 'open') return void (await openWindow());
    if (cmd === 'inbox') return void (await openWindow({ view: 'inbox' }));
    if (cmd === 'quit') {
      app.exit(0);
      return;
    }
    if (cmd === 'update') return void (await installUpdate(true));
    if (cmd === 'notify') {
      setDesktop({ notify: !desktopSettings(readUserConfig()).notify });
      return void (await refreshTray());
    }
    await service(cmd);
  } catch (err) {
    if (Notification.isSupported()) {
      new Notification({ title: 'Agent Ops', body: (err as Error).message }).show();
    }
  }
}

function createTray(): void {
  if (offscreen || tray) return;
  tray = new Tray(
    nativeImage.createFromBitmap(
      trayBitmap(
        { running: false, paused: false, live: 0, waiting: 0, runsOutlive: RUNS_OUTLIVE_OPSD },
        32,
      ),
      { width: 32, height: 32, scaleFactor: 2 },
    ),
  );
  tray.on('click', () => void openWindow());
  void refreshTray();
  // Catches a stop or start made outside the app, such as `ops daemon stop`.
  setInterval(() => void refreshTray(), 15_000).unref();
}

/**
 * Asks in a system dialog before a stop or restart ends live runs (an opsd that reports
 * `runs_outlive: false`; otherwise it returns false at once), so neither the page
 * nor a stray click ends an agent's run. True to go on and end them; throws when the person
 * keeps them.
 */
async function confirmEndRuns(action: 'stop' | 'restart'): Promise<boolean> {
  const st = await serviceState();
  if (!stopEndsRuns(st)) return false;
  if (offscreen) throw new Error(keptRunsMessage(st.live));
  const p = endRunsPrompt(action, st.live);
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Agent Ops',
    message: p.message,
    detail: p.detail,
    buttons: [p.confirm, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const res =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
  if (res.response !== 0) throw new Error(keptRunsMessage(st.live));
  return true;
}

/**
 * Starts, stops, restarts, pauses or resumes opsd. Stop and restart leave live runs to the next
 * opsd; an opsd that reports its runs cannot outlive it (`runs_outlive: false`) ends them, so the
 * person confirms first. Pause starts no new runs and survives restarts.
 */
async function service(action: ServiceAction): Promise<ServiceState> {
  if (action === 'start') {
    await daemon(true);
  } else if (action === 'stop') {
    const killRuns = await confirmEndRuns('stop');
    await stopDaemon({ env: process.env, killRuns });
    info = null;
  } else if (action === 'restart') {
    const killRuns = await confirmEndRuns('restart');
    // A stop that did not complete throws, so a second opsd never starts beside the first.
    await stopDaemon({ env: process.env, killRuns });
    info = null;
    await daemon(true);
  } else {
    setPaused(process.env, action === 'pause');
    // A running opsd reads the file again at once; a stopped one starts in this state.
    if (readDaemon()) await call('POST', '/api/settings', { patch: {} });
  }
  wakeStream?.();
  const st = await serviceState();
  send('ops:service', st);
  void refreshTray();
  return st;
}

// ---- Updates ------------------------------------------------------------------------------------

/** Updates come from GitHub Releases, for the installed app only and never in screenshot mode. */
const updatable = packaged && !offscreen;
let update: UpdateState = { status: updatable ? 'idle' : 'off', current: app.getVersion() };

function setUpdate(patch: Partial<UpdateState>): void {
  update = { ...update, ...patch };
  send('ops:update', update);
  refreshTraySoon();
}

/** Looks for a new version now; electron-updater downloads it in the background. */
async function checkUpdate(): Promise<UpdateState> {
  if (!updatable) return update;
  try {
    await electronUpdater.autoUpdater.checkForUpdates();
  } catch (err) {
    setUpdate({
      status: 'error',
      error: (err as Error).message,
      checkedAt: new Date().toISOString(),
    });
  }
  return update;
}

function setupUpdates(): void {
  if (!updatable) return;
  const u = electronUpdater.autoUpdater;
  u.autoDownload = true;
  // Installing stops opsd first, so the app decides when (installUpdate), never a plain quit.
  u.autoInstallOnAppQuit = false;
  u.on('checking-for-update', () => setUpdate({ status: 'checking', error: undefined }));
  u.on('update-not-available', () =>
    setUpdate({ status: 'none', checkedAt: new Date().toISOString() }),
  );
  u.on('update-available', (i) =>
    setUpdate({
      status: 'downloading',
      version: i.version,
      percent: 0,
      notes: plainNotes(notesText(i.releaseNotes)),
      checkedAt: new Date().toISOString(),
    }),
  );
  u.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: p.percent }));
  u.on('update-downloaded', (i) => {
    setUpdate({ status: 'ready', version: i.version, percent: 100 });
    if (Notification.isSupported()) {
      new Notification({
        title: `Agent Ops ${i.version} is ready`,
        body: 'It installs once no agent run is live and the window is closed, or now from Settings or the tray.',
      }).show();
    }
  });
  u.on('error', (err) => setUpdate({ status: 'error', error: err.message }));
  setTimeout(() => void checkUpdate(), 20_000).unref();
  setInterval(() => void checkUpdate(), 4 * 3_600_000).unref();
  // A downloaded update installs on its own when nothing would be cut off.
  setInterval(() => void installUpdate(false).catch(() => undefined), 60_000).unref();
}

/**
 * Installs a downloaded update: stops opsd (the installer replaces the files it runs from),
 * leaves a note so the new app starts in the tray when no window was open, and restarts into the
 * installer. `asked`: the person clicked Install; with live runs they confirm first. The order and
 * the idle check live in `runInstall` (updates.ts).
 */
async function installUpdate(asked: boolean): Promise<UpdateState> {
  if (update.status !== 'ready') return update;
  await runInstall(asked, {
    state: serviceState,
    windowOpen: () => Boolean(win && !win.isDestroyed() && win.isVisible()),
    confirm: async (live, runsOutlive) => {
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        title: 'Agent Ops',
        message: `Install Agent Ops ${update.version ?? ''} now?`,
        detail: installPrompt(live, runsOutlive),
        buttons: [runsOutlive ? 'Install now' : 'Install and end the runs', 'Wait'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const res =
        win && !win.isDestroyed()
          ? await dialog.showMessageBox(win, opts)
          : await dialog.showMessageBox(opts);
      return res.response === 0;
    },
    stop: async ({ ifIdle, killRuns }) => {
      try {
        await stopDaemon({ env: process.env, killRuns, ifIdle });
      } catch (err) {
        // 409: a run is live, so opsd kept running and nothing was cut off.
        if (err instanceof DaemonCallError && err.status === 409) return 'busy';
        throw err;
      }
      info = null;
      return 'stopped';
    },
    install: (background) => {
      writeRelaunch(app.getPath('userData'), background);
      // Silent install, then start the new version.
      electronUpdater.autoUpdater.quitAndInstall(true, true);
    },
  });
  return update;
}

/** Writes the desktop's own settings under `desktop:` in the user config. */
function setDesktop(patch: { notify?: boolean }): void {
  editUserConfig(
    process.env,
    (doc) => {
      // On is the default: the file keeps only an off.
      if (patch.notify !== undefined) {
        if (patch.notify) doc.deleteIn(['desktop', 'notify']);
        else doc.setIn(['desktop', 'notify'], false);
        const d = doc.get('desktop') as { items?: unknown[] } | undefined;
        if (d && Array.isArray(d.items) && d.items.length === 0) doc.delete('desktop');
      }
    },
    (next) => void opsdConfig(next as Parameters<typeof opsdConfig>[0]),
  );
}

/** Whether this system can start the app at sign-in. Windows only for now. */
const loginSupported = process.platform === 'win32';

function loginItem(): { path: string; args: string[]; name: string } {
  return {
    path: process.execPath,
    args: loginArgs({ packaged: app.isPackaged, appPath: app.getAppPath(), cwd: opsCwd }),
    name: LOGIN_NAME,
  };
}

/** `reg query KEY /v NAME` output, or null when the value is not there. */
function regQuery(key: string, name: string): string | null {
  try {
    return execFileSync('reg', ['query', key, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

/**
 * The sign-in entry, read from the registry by its name. Electron's own lookup checks another
 * name and only entries for the current executable, so it misses an entry made from a moved or
 * replaced checkout, which the person could then not turn off here.
 */
function loginState(): LoginEntry {
  if (!loginSupported) return { command: null, off: false, current: false };
  return loginEntry(
    regQuery(RUN_KEY, LOGIN_NAME),
    regQuery(APPROVED_KEY, LOGIN_NAME),
    LOGIN_NAME,
    loginItem(),
  );
}

interface DesktopView {
  notify: boolean;
  /** Windows starts an app named Agent Ops at sign-in. */
  login: boolean;
  /** The entry's command when it starts another copy or folder than this app's. */
  loginOther: string | null;
  /** The entry exists but is turned off in Task Manager > Startup apps. */
  loginOff: boolean;
  loginSupported: boolean;
  state: ServiceState;
}

async function desktopView(): Promise<DesktopView> {
  const entry = loginState();
  return {
    notify: desktopSettings(readUserConfig()).notify,
    login: entry.command !== null && !entry.off,
    loginOther: entry.command !== null && !entry.current ? entry.command : null,
    loginOff: entry.command !== null && entry.off,
    loginSupported,
    state: await serviceState(),
  };
}
/** Screenshot mode: page errors and failed opsd calls, so a smoke check can fail on them. */
const problems: string[] = [];
let lastFrame: Electron.NativeImage | null = null;

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    show: !offscreen,
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Agent Ops',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      offscreen,
    },
  });
  if (offscreen) {
    win.webContents.setFrameRate(10);
    win.webContents.on('paint', (_e, _dirty, image) => {
      lastFrame = image;
    });
    win.webContents.on('console-message', (e) => {
      process.stdout.write(`[page] ${e.message}\n`);
      if (e.level === 'error') problems.push(`page error: ${e.message}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      problems.push(`page crashed: ${details.reason}`);
    });
  }
  // Links open in the browser; the app never navigates away from its own page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(join(here, 'ui', 'index.html'));
}

/** `AGENT_OPS_SCREENSHOTS=<dir>`: capture each view to PNG, then quit. For docs and checks. */
async function screenshots(dir: string): Promise<void> {
  const views = (
    process.env.AGENT_OPS_VIEWS ??
    'inbox,board,list,findings,activity,reports,agents,runs,standups,schedules,decisions,chat,channels,knowledge,settings'
  ).split(',');
  mkdirSync(dir, { recursive: true });
  // Views call opsd as soon as they show: wait until the app has started it, which takes
  // seconds on a busy machine, so the first views do not log calls to an opsd still starting.
  for (let i = 0; i < 600 && !info; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1500));
  for (const v of views) {
    // Only the first colon splits: `board:lanes:agent` opens the board with `lanes:agent`.
    const at = v.indexOf(':');
    const view = at < 0 ? v : v.slice(0, at);
    const id = at < 0 ? undefined : v.slice(at + 1);
    send('ops:navigate', { view, id });
    await new Promise((r) => setTimeout(r, 1200));
    const img = lastFrame ?? (await win!.webContents.capturePage());
    writeFileSync(join(dir, `${v.replace(/[:/]/g, '-')}.png`), img.toPNG());
  }
  writeFileSync(join(dir, 'problems.json'), JSON.stringify(problems, null, 2));
  // A smoke check reads the exit code: any page error or failed call fails it.
  if (problems.length > 0) app.exit(1);
  else app.quit();
}

/** The app's own page, the only page its window shows. */
const PAGE = pathToFileURL(join(here, 'ui', 'index.html')).href;

/** Whether `contents` is the app's window and `url` its own page (query and hash ignored). */
function ownPage(contents: Electron.WebContents | null, url: string | undefined): boolean {
  return Boolean(win && contents === win.webContents && url?.split(/[?#]/)[0] === PAGE);
}

/** Only the app's own page in its own window may call the main process. */
function fromPage(e: Electron.IpcMainInvokeEvent): boolean {
  return ownPage(e.sender, e.senderFrame?.url);
}

/**
 * The page may use the microphone for voice input while it is on, and nothing else: no camera,
 * screen, location or notifications, and no other page or window gets any permission.
 */
function setupPermissions(): void {
  const voiceOn = (): boolean => voiceSettings(readUserConfig()).engine !== 'off';
  session.defaultSession.setPermissionRequestHandler((contents, permission, done, details) => {
    const media = details as { mediaTypes?: string[]; requestingUrl?: string };
    done(
      permissionAllowed({
        permission,
        mediaTypes: media.mediaTypes,
        ownPage: ownPage(contents, media.requestingUrl ?? contents.getURL()),
        voiceOn: voiceOn(),
      }),
    );
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permissionAllowed({
      permission,
      mediaTypes: details.mediaType ? [details.mediaType] : [],
      ownPage: ownPage(contents, details.requestingUrl ?? contents?.getURL()),
      voiceOn: voiceOn(),
    }),
  );
}

/** Writes a voice change under `desktop.voice` in the user config. */
function setVoice(change: VoiceChange): void {
  editUserConfig(
    process.env,
    (doc) => writeVoice(doc, change),
    (next) => void opsdConfig(next as Parameters<typeof opsdConfig>[0]),
  );
}

/** The voice settings for the Settings page and the composers' microphone button. */
function voiceView(): ReturnType<typeof voiceSettings> & {
  cloudKey: boolean;
  problem: string | null;
} {
  const s = voiceSettings(readUserConfig());
  return {
    ...s,
    cloudKey: Boolean(process.env[CLOUD_KEY_ENV]?.trim()),
    problem: voiceProblem(s, process.env),
  };
}

/** Whether the user config needs a first-start setup, with defaults for the form. */
ipcMain.handle('ops:setup-status', () => {
  const start = process.env.OPS_CWD ?? process.cwd();
  const root = suggestedRoot(start);
  return {
    needed: !readUserConfig().me,
    exists: existsSync(userConfigPath()),
    path: userConfigPath(),
    defaults: { me: defaultHumanId(), roots: root ? [root] : [] },
  };
});

/**
 * Writes the user config from the first-start form. A running opsd read the old config, so it is
 * restarted when it runs no agents; otherwise the page says to restart it.
 */
ipcMain.handle('ops:setup', async (e, me: unknown, roots: unknown) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  try {
    if (
      typeof me !== 'string' ||
      !Array.isArray(roots) ||
      roots.some((r) => typeof r !== 'string')
    ) {
      throw new Error('setup needs me and a list of roots');
    }
    const res = setupUserConfig({ me, roots: roots as string[] });
    // The default providers and agents, once; Settings and Agents edit them from then on.
    seedUserConfig(process.env, { agents: true });
    let restart = false;
    const d = readDaemon();
    if (d) {
      // opsd decides in one step: it shuts down only with no run live, and never stops runs.
      try {
        await daemonCall(d, 'POST', '/api/shutdown', { killRuns: false, ifIdle: true });
        for (let i = 0; i < 50 && readDaemon(); i++) await new Promise((r) => setTimeout(r, 100));
        info = null;
      } catch {
        restart = true;
      }
    }
    return { ok: true, data: { ...res, restart } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

interface Health {
  me?: string | null;
  build?: string;
  live?: number;
  paused?: boolean;
  runs_outlive?: boolean;
}

/**
 * Stops opsd while no run is live and starts it again, so it loads the installed build and the
 * current config. opsd refuses (409) while runs are live: no agent is ever cut off.
 */
async function restartIdle(): Promise<DaemonInfo> {
  const d = readDaemon();
  if (d) {
    try {
      await daemonCall(d, 'POST', '/api/shutdown', { killRuns: false, ifIdle: true });
    } catch (err) {
      const msg = (err as Error).message;
      throw new Error(
        /409|live/.test(msg)
          ? 'runs are live: opsd restarts after they end'
          : `restart failed: ${msg}`,
      );
    }
    for (let i = 0; i < 80 && readDaemon(); i++) await new Promise((r) => setTimeout(r, 100));
    if (readDaemon()) throw new Error('opsd did not stop in time');
  }
  info = null;
  return daemon(true);
}

ipcMain.handle('ops:info', async () => {
  let d = await daemon(true);
  let health = (await call('GET', '/api/health')) as Health;
  // An opsd started before the app was updated serves an older API ("no route GET /api/waits").
  // Restart it at once when it runs nothing; otherwise the page offers a restart.
  let stale = health.build !== buildStamp();
  if (stale && (health.live ?? 0) === 0) {
    try {
      d = await restartIdle();
      health = (await call('GET', '/api/health')) as Health;
      stale = health.build !== buildStamp();
    } catch {
      // A run started meanwhile: keep the old opsd and say so.
    }
  }
  me = health.me ?? null;
  if (pendingNav) {
    const target = pendingNav;
    pendingNav = null;
    // The page subscribes to navigation while it asks for this info: send it a moment later.
    setTimeout(() => send('ops:navigate', target), 400);
  }
  return { pid: d.pid, port: d.port, version: d.version, me, stale, live: health.live ?? 0 };
});

ipcMain.handle('ops:restart', async (e) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  try {
    const d = await restartIdle();
    return { ok: true, data: { pid: d.pid, port: d.port } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('ops:service', async (e, action: unknown) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  try {
    if (!SERVICE_ACTIONS.includes(action as ServiceAction)) throw new Error('unknown action');
    return { ok: true, data: await service(action as ServiceAction) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('ops:desktop', async (e) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  try {
    return { ok: true, data: await desktopView() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

/**
 * Changes the desktop's own settings. `login` adds the app to or removes it from the Windows
 * sign-in apps: a change to the machine, so it happens only on the person's click, never in
 * screenshot mode.
 */
ipcMain.handle('ops:desktop-set', async (e, patch: unknown) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  try {
    const p = (patch ?? {}) as { notify?: unknown; login?: unknown };
    if (p.notify !== undefined) {
      if (typeof p.notify !== 'boolean') throw new Error('notify: use true or false');
      setDesktop({ notify: p.notify });
    }
    if (p.login !== undefined) {
      if (typeof p.login !== 'boolean') throw new Error('login: use true or false');
      if (offscreen) throw new Error('not in screenshot mode');
      if (!loginSupported) throw new Error('starting at sign-in works on Windows only for now');
      // On writes this app's entry; off deletes the entry by its name, wherever it points.
      app.setLoginItemSettings({ ...loginItem(), openAtLogin: p.login, enabled: p.login });
      const entry = loginState();
      if (p.login && !(entry.current && !entry.off)) {
        throw new Error('Windows did not save the sign-in entry');
      }
      if (!p.login && entry.command !== null) {
        throw new Error('Windows kept the sign-in entry: remove it in Task Manager > Startup apps');
      }
    }
    void refreshTray();
    return { ok: true, data: await desktopView() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('ops:update', async (e, action: unknown) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  try {
    if (action === 'check') return { ok: true, data: await checkUpdate() };
    if (action === 'install') return { ok: true, data: await installUpdate(true) };
    return { ok: true, data: update };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

/**
 * Adds, replaces or removes (`input` null) a provider runtime, seeded ones included. This is the
 * only way the app changes what program a run starts: the page cannot do it through opsd's API,
 * and nothing changes until the person confirms the exact command line in a system dialog.
 */
ipcMain.handle('ops:runtime', async (e, name: unknown, input: unknown) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  try {
    if (typeof name !== 'string') throw new Error('runtime name missing');
    const rc = input === null ? null : checkRuntime(name, input);
    const detail = runtimeDetail(rc);
    // Screenshot runs have nobody to confirm.
    if (offscreen) throw new Error('not in screenshot mode');
    let exists = false;
    try {
      exists = Object.hasOwn(opsdConfig(readUserConfig()).runtimes, name);
    } catch {
      // A config that does not read: editRuntime reports it.
    }
    const pick = await dialog.showMessageBox(win!, {
      type: 'warning',
      title: 'Agent Ops',
      message:
        rc === null
          ? `Remove the provider ${name}?`
          : exists
            ? `Let agent runs of ${name} start this program from now on?`
            : `Let agent runs start this program as ${name}?`,
      detail,
      buttons: ['Cancel', rc === null ? 'Remove' : exists ? 'Save provider' : 'Add provider'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (pick.response !== 1) return { ok: false, error: 'cancelled' };
    editRuntime(process.env, name, rc);
    // opsd reads the file again; an empty change only reloads it.
    await call('POST', '/api/settings', { patch: {} });
    return { ok: true, data: { name } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('ops:voice', (e) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  return { ok: true, data: voiceView() };
});

/**
 * Changes the voice engine or language. Choosing the cloud engine sends recordings off this PC,
 * so the person confirms it in a system dialog first.
 */
ipcMain.handle('ops:voice-set', async (e, patch: unknown) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  try {
    const change = checkVoicePatch(patch);
    const now = voiceSettings(readUserConfig());
    if (change.engine === 'cloud' && now.engine !== 'cloud') {
      if (offscreen) throw new Error('not in screenshot mode');
      const pick = await dialog.showMessageBox(win!, {
        type: 'warning',
        title: 'Agent Ops',
        message: 'Send voice recordings to OpenAI?',
        detail: [
          `Each recording you make with the microphone button goes to OpenAI's transcription API (${now.cloudModel}) with the key in ${CLOUD_KEY_ENV}, and the text comes back.`,
          '',
          'With Local (whisper.cpp), recordings never leave this PC.',
        ].join('\n'),
        buttons: ['Cancel', 'Use OpenAI'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (pick.response !== 1) return { ok: false, error: 'cancelled' };
    }
    setVoice(change);
    return { ok: true, data: voiceView() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

/**
 * Picks whisper.cpp's program or model file in a system dialog. The program is something the app
 * starts, so the page can never name it: only the person's pick in this dialog sets it.
 */
ipcMain.handle('ops:voice-browse', async (e, kind: unknown) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  try {
    if (kind !== 'program' && kind !== 'model') throw new Error('pick program or model');
    if (offscreen) throw new Error('not in screenshot mode');
    const pick = await dialog.showOpenDialog(win!, {
      title: kind === 'program' ? 'whisper.cpp program (whisper-cli)' : 'whisper.cpp model file',
      properties: ['openFile'],
      filters:
        kind === 'program'
          ? process.platform === 'win32'
            ? [{ name: 'Programs', extensions: ['exe'] }]
            : []
          : [
              { name: 'whisper.cpp models', extensions: ['bin'] },
              { name: 'All files', extensions: ['*'] },
            ],
    });
    const file = pick.filePaths[0];
    if (pick.canceled || !file) return { ok: false, error: 'cancelled' };
    setVoice({ [kind]: file });
    return { ok: true, data: voiceView() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

/** Turns a recording from the page (16 kHz mono WAV) into text with the chosen engine. */
ipcMain.handle('ops:transcribe', async (e, wav: unknown) => {
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  try {
    const s = voiceSettings(readUserConfig());
    const problem = voiceProblem(s, process.env) ?? wavProblem(wav);
    if (problem) throw new Error(problem);
    const bytes = wav as Uint8Array;
    const text =
      s.engine === 'cloud'
        ? await transcribeCloud(s, bytes, process.env[CLOUD_KEY_ENV]!.trim())
        : await transcribeLocal(s, bytes);
    return { ok: true, data: { text } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('ops:call', async (e, method: 'GET' | 'POST', path: string, body?: unknown) => {
  // Only the app's own page in its own window may call opsd.
  if (!fromPage(e)) return { ok: false, error: 'not allowed from this page' };
  if (!allowedCall(method, path)) {
    if (offscreen) problems.push(`not allowed: ${method} ${path}`);
    return { ok: false, error: `not allowed: ${method} ${path}` };
  }
  try {
    return { ok: true, data: await call(method, path, body) };
  } catch (err) {
    if (offscreen) problems.push(`${method} ${path}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
});

// One app per person: a second start (the sign-in entry, a shortcut) shows the first one's
// window. Screenshot runs use their own config and must never reach the person's app.
if (!offscreen && !app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => void openWindow());
  app.whenReady().then(async () => {
    if (!offscreen && takeRelaunch(app.getPath('userData'))) background = true;
    protocol.handle(ATTACHMENT_SCHEME, (req) => attachmentResponse(req.url));
    setupPermissions();
    createTray();
    setupUpdates();
    if (background) {
      // The sign-in entry: start opsd and stay in the tray.
      await daemon(true).catch(() => undefined);
      void refreshTray();
    } else {
      await createWindow();
    }
    void stream();
    const shots = process.env.AGENT_OPS_SCREENSHOTS;
    // A failed capture ends the run with an error instead of leaving the app open.
    if (shots)
      screenshots(shots).catch((e: unknown) => {
        console.error(`screenshots failed: ${e instanceof Error ? e.message : String(e)}`);
        app.exit(1);
      });
  });
}

app.on('window-all-closed', () => {
  // The tray keeps the app: it controls opsd and shows notifications without a window. opsd
  // keeps running either way: agent runs must not stop because the window closed.
  if (tray) return;
  streamAbort?.abort();
  app.quit();
});
