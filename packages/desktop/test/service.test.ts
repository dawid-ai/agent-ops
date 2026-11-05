import { describe, expect, it } from 'vitest';
import {
  cwdArg,
  desktopSettings,
  endRunsPrompt,
  keptRunsMessage,
  loginArgs,
  loginEntry,
  regValue,
  serviceLine,
  stopEndsRuns,
  trayBitmap,
  trayColor,
  trayMenu,
} from '../src/service';

const base = { running: true, paused: false, live: 0, waiting: 0, runsOutlive: true };

describe('tray', () => {
  it('describes opsd running, paused and stopped', () => {
    expect(serviceLine({ ...base, live: 2 })).toBe('opsd running · 2 live runs');
    expect(serviceLine({ ...base, live: 1, paused: true })).toBe(
      'opsd paused · 1 live run finishing',
    );
    expect(serviceLine({ ...base, paused: true })).toBe('opsd paused · no live runs');
    expect(serviceLine({ ...base, running: false })).toBe('opsd stopped');
    expect(serviceLine({ ...base, running: false, paused: true })).toBe(
      'opsd stopped (starts paused)',
    );
  });

  it('offers start or stop, pause or resume, and restart only while running', () => {
    const labels = (s: typeof base) =>
      trayMenu(s, true)
        .filter((i) => i.command)
        .map((i) => `${i.command}${i.enabled === false ? '(off)' : ''}`);
    expect(labels(base)).toEqual(['open', 'stop', 'pause', 'restart', 'notify', 'quit']);
    expect(labels({ ...base, running: false, paused: true })).toEqual([
      'open',
      'start',
      'resume',
      'restart(off)',
      'notify',
      'quit',
    ]);
    const waiting = trayMenu({ ...base, waiting: 3 }, false);
    expect(waiting[1]).toMatchObject({ label: '3 items need you', command: 'inbox' });
    expect(waiting.find((i) => i.command === 'notify')?.checked).toBe(false);
  });

  it('asks before a stop or restart ends live runs, only where runs end with opsd', () => {
    const win = { ...base, runsOutlive: false };
    expect(stopEndsRuns({ ...base, live: 2 })).toBe(false);
    expect(stopEndsRuns(win)).toBe(false);
    expect(stopEndsRuns({ ...win, live: 2, running: false })).toBe(false);
    expect(stopEndsRuns({ ...win, live: 2 })).toBe(true);
    const label = (s: typeof base, cmd: string) =>
      trayMenu(s, true).find((i) => i.command === cmd)?.label;
    expect(label({ ...base, live: 2 }, 'stop')).toBe('Stop opsd');
    expect(label({ ...win, live: 2 }, 'stop')).toBe('Stop opsd (ends 2 live runs)…');
    expect(label({ ...win, live: 1 }, 'restart')).toBe('Restart opsd (ends 1 live run)…');
    expect(endRunsPrompt('restart', 2)).toMatchObject({
      message: 'Restart opsd and end 2 live runs?',
      confirm: 'End runs and restart',
    });
    expect(keptRunsMessage(1)).toMatch(/^opsd keeps running: 1 live run would have ended/);
  });

  it('draws a status light in the state colour, with a dot when something waits', () => {
    expect(trayColor(base)).toEqual([63, 185, 80]);
    expect(trayColor({ ...base, paused: true })).toEqual([210, 153, 34]);
    expect(trayColor({ ...base, running: false })).toEqual([139, 148, 158]);
    const size = 32;
    const px = (buf: Buffer, x: number, y: number) => {
      const i = (y * size + x) * 4;
      return [buf[i + 2], buf[i + 1], buf[i], buf[i + 3]];
    };
    const plain = trayBitmap(base, size);
    expect(plain.length).toBe(size * size * 4);
    // A corner is transparent; the ring is opaque green.
    expect(px(plain, 0, 0)[3]).toBe(0);
    expect(px(plain, 16, 3)).toEqual([63, 185, 80, 255]);
    // The top-right dot shows only while something waits.
    expect(px(plain, 29, 3)[3]).toBe(0);
    expect(px(trayBitmap({ ...base, waiting: 1 }, size), 29, 3)).toEqual([88, 166, 255, 255]);
  });
});

describe('start at sign-in', () => {
  it('starts the app folder in development and the app itself when packaged', () => {
    expect(loginArgs({ packaged: false, appPath: 'C:/dev/app', cwd: 'C:/dev/agent-ops' })).toEqual([
      'C:/dev/app',
      '--background',
      '--ops-cwd=C:/dev/agent-ops',
    ]);
    expect(loginArgs({ packaged: true, appPath: 'x', cwd: 'C:/work' })).toEqual([
      '--background',
      '--ops-cwd=C:/work',
    ]);
  });

  it('quotes an argument with a space, since Electron joins them with spaces', () => {
    expect(loginArgs({ packaged: false, appPath: 'C:/My Apps/app', cwd: 'D:/work dir' })).toEqual([
      '"C:/My Apps/app"',
      '--background',
      '"--ops-cwd=D:/work dir"',
    ]);
  });

  it('reads the folder back from the command line', () => {
    expect(cwdArg(['electron', '.', '--background', '--ops-cwd=C:/dev/agent-ops'])).toBe(
      'C:/dev/agent-ops',
    );
    expect(cwdArg(['electron', '.'])).toBeUndefined();
    expect(cwdArg(['--ops-cwd='])).toBeUndefined();
  });

  describe('the sign-in entry, read by name', () => {
    const RUN = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    // A stand-in registry with Electron's behaviour: on writes the value under the name, off
    // deletes the value by name, wherever it points.
    function registry() {
      const run = new Map<string, string>();
      const approved = new Map<string, string>();
      const out = (key: string, m: Map<string, string>, type: string, name: string) =>
        m.has(name) ? `\r\n${key}\r\n    ${name}    ${type}    ${m.get(name)}\r\n\r\n` : null;
      return {
        run,
        approved,
        set(name: string, item: { path: string; args: string[] }, on: boolean) {
          if (on) {
            run.set(name, [`"${item.path}"`, ...item.args].join(' '));
            approved.delete(name);
          } else {
            run.delete(name);
            approved.delete(name);
          }
        },
        read(name: string, item: { path: string; args: string[] }) {
          return loginEntry(
            out(RUN, run, 'REG_SZ', name),
            out(`${RUN}\\StartupApproved`, approved, 'REG_BINARY', name),
            name,
            item,
          );
        },
      };
    }
    const at = (exe: string, cwd: string) => ({
      path: exe,
      args: loginArgs({ packaged: false, appPath: `${exe}/../app`, cwd }),
    });

    it('parses one value from reg query output, by a case-insensitive name', () => {
      const out = `\r\n${RUN}\r\n    Other    REG_SZ    x\r\n    Agent Ops    REG_SZ    "C:\\a b\\e.exe" --background\r\n`;
      expect(regValue(out, 'agent ops')).toEqual({
        type: 'REG_SZ',
        data: '"C:\\a b\\e.exe" --background',
      });
      expect(regValue(out, 'Missing')).toBeNull();
      expect(regValue(null, 'Agent Ops')).toBeNull();
    });

    it('turns on, reads back and turns off from the same place', () => {
      const reg = registry();
      const here = at('C:\\dev\\agent-ops\\electron.exe', 'C:\\dev\\agent-ops');
      expect(reg.read('Agent Ops', here)).toEqual({ command: null, off: false, current: false });
      reg.set('Agent Ops', here, true);
      expect(reg.read('Agent Ops', here)).toMatchObject({ off: false, current: true });
      reg.set('Agent Ops', here, false);
      expect(reg.read('Agent Ops', here).command).toBeNull();
    });

    it('still finds the entry after the app moved or its folder changed, and turns it off', () => {
      const reg = registry();
      const old = at('C:\\old\\agent-ops\\electron.exe', 'C:\\old\\agent-ops');
      reg.set('Agent Ops', old, true);
      const moved = at('D:\\agent-ops\\electron.exe', 'D:\\agent-ops');
      const seen = reg.read('Agent Ops', moved);
      // On, but pointing elsewhere: the app shows it and can remove or repoint it.
      expect(seen.command).toContain('C:\\old\\agent-ops\\electron.exe');
      expect(seen).toMatchObject({ off: false, current: false });
      // Same executable, other folder for opsd: also not this app's entry.
      const otherCwd = at('C:\\old\\agent-ops\\electron.exe', 'C:\\elsewhere');
      expect(reg.read('Agent Ops', otherCwd).current).toBe(false);
      // Removal goes by name, so it works from the moved app.
      reg.set('Agent Ops', moved, false);
      expect(reg.read('Agent Ops', moved).command).toBeNull();
      expect(reg.read('Agent Ops', old).command).toBeNull();
      // Repointing from the moved app makes it current there.
      reg.set('Agent Ops', old, true);
      reg.set('Agent Ops', moved, true);
      expect(reg.read('Agent Ops', moved).current).toBe(true);
      expect(reg.read('Agent Ops', old).current).toBe(false);
    });

    it('sees an entry turned off in Task Manager, and matches paths regardless of case', () => {
      const reg = registry();
      const here = at('C:\\dev\\agent-ops\\electron.exe', 'C:\\dev\\agent-ops');
      reg.set('Agent Ops', here, true);
      reg.approved.set('Agent Ops', '030000000000000000000000');
      expect(reg.read('Agent Ops', here)).toMatchObject({ off: true, current: true });
      reg.approved.set('Agent Ops', '020000000000000000000000');
      expect(reg.read('Agent Ops', here).off).toBe(false);
      const upper = at('C:\\DEV\\AGENT-OPS\\electron.exe', 'C:\\DEV\\AGENT-OPS');
      expect(reg.read('Agent Ops', upper).current).toBe(true);
    });
  });

  it('keeps notifications on unless the config turns them off', () => {
    expect(desktopSettings({})).toEqual({ notify: true });
    expect(desktopSettings(null)).toEqual({ notify: true });
    expect(desktopSettings({ desktop: { notify: false } })).toEqual({ notify: false });
    expect(desktopSettings({ desktop: { notify: 'no' } })).toEqual({ notify: true });
  });
});
