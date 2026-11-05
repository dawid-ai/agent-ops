import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trayMenu } from '../src/service';
import type { InstallSteps } from '../src/updates';
import {
  installDecision,
  installPrompt,
  installUpdate,
  notesText,
  plainNotes,
  takeRelaunch,
  writeRelaunch,
} from '../src/updates';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('update install policy', () => {
  it('installs on its own only while no run is live and no window is open', () => {
    const base = { ready: true, asked: false, windowOpen: false, live: 0 };
    expect(installDecision(base)).toBe('install');
    expect(installDecision({ ...base, live: 1 })).toBe('wait');
    expect(installDecision({ ...base, windowOpen: true })).toBe('wait');
    expect(installDecision({ ...base, ready: false })).toBe('wait');
  });

  it('installs when asked, and asks first while runs are live', () => {
    const asked = { ready: true, asked: true, windowOpen: true, live: 0 };
    expect(installDecision(asked)).toBe('install');
    expect(installDecision({ ...asked, live: 2 })).toBe('confirm');
    expect(installDecision({ ...asked, ready: false })).toBe('wait');
  });
});

describe('installing an update', () => {
  /**
   * Fake app and opsd. `live` is what the app reads; `liveAtStop` is what opsd sees when asked
   * to stop, so a run that starts in between is modelled.
   */
  function steps(o: {
    live?: number[];
    liveAtStop?: number[];
    runsOutlive?: boolean;
    windowOpen?: boolean;
    confirm?: boolean;
  }) {
    const live = [...(o.live ?? [0])];
    const liveAtStop = [...(o.liveAtStop ?? live)];
    const log: string[] = [];
    const s: InstallSteps = {
      state: async () => ({ live: live.shift() ?? 0, runsOutlive: o.runsOutlive ?? true }),
      windowOpen: () => o.windowOpen ?? false,
      confirm: async (n) => {
        log.push(`confirm ${n}`);
        return o.confirm ?? true;
      },
      stop: async ({ ifIdle, killRuns }) => {
        const n = liveAtStop.shift() ?? 0;
        log.push(`stop ifIdle=${ifIdle} killRuns=${killRuns}`);
        // opsd's atomic check: with ifIdle it refuses while a run is live.
        return ifIdle && n > 0 ? 'busy' : 'stopped';
      },
      install: (background) => log.push(`install background=${background}`),
    };
    return { s, log };
  }

  it('stops opsd only through the idle check when nobody confirmed live runs', async () => {
    const { s, log } = steps({ live: [0] });
    expect(await installUpdate(false, s)).toBe('installed');
    expect(log).toEqual(['stop ifIdle=true killRuns=false', 'install background=true']);
  });

  it('waits, without installing, when a run starts after the count was read', async () => {
    const { s, log } = steps({ live: [0], liveAtStop: [1] });
    expect(await installUpdate(false, s)).toBe('waiting');
    expect(log).toEqual(['stop ifIdle=true killRuns=false']);
  });

  it('asks when a run started after the person clicked Install', async () => {
    const { s, log } = steps({ live: [0, 1], liveAtStop: [1, 1], windowOpen: true });
    expect(await installUpdate(true, s)).toBe('installed');
    expect(log).toEqual([
      'stop ifIdle=true killRuns=false',
      'confirm 1',
      'stop ifIdle=false killRuns=false',
      'install background=false',
    ]);
  });

  it('keeps everything when the person says wait, and ends runs only where they cannot outlive opsd', async () => {
    const kept = steps({ live: [2], confirm: false, windowOpen: true });
    expect(await installUpdate(true, kept.s)).toBe('kept');
    expect(kept.log).toEqual(['confirm 2']);

    const ending = steps({ live: [1], runsOutlive: false, windowOpen: true });
    expect(await installUpdate(true, ending.s)).toBe('installed');
    expect(ending.log).toEqual([
      'confirm 1',
      'stop ifIdle=false killRuns=true',
      'install background=false',
    ]);
  });

  it('does nothing unattended while a run is live or the window is open', async () => {
    for (const o of [{ live: [1] }, { live: [0], windowOpen: true }]) {
      const { s, log } = steps(o);
      expect(await installUpdate(false, s)).toBe('waiting');
      expect(log).toEqual([]);
    }
  });
});

describe('release notes', () => {
  it('joins per-version notes and strips the HTML GitHub serves', () => {
    expect(notesText(undefined)).toBeUndefined();
    expect(notesText('plain')).toBe('plain');
    expect(
      notesText([
        { version: '0.2.0-beta.2', note: '<p>two</p>' },
        { version: '0.2.0-beta.1', note: null },
      ]),
    ).toBe('0.2.0-beta.2\n<p>two</p>\n\n0.2.0-beta.1');
    expect(
      plainNotes('<ul><li><strong>Search</strong> &amp; more</li><li>Tray</li></ul><p>Done</p>'),
    ).toBe('- Search & more\n- Tray\nDone');
  });
});

describe('relaunch after an update', () => {
  const temp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'ops-relaunch-'));
    dirs.push(d);
    return d;
  };

  it('starts in the tray once when the old app had no window, then forgets it', () => {
    const d = temp();
    writeRelaunch(d, true, 1000);
    expect(takeRelaunch(d, 2000)).toBe(true);
    expect(existsSync(join(d, 'relaunch.json'))).toBe(false);
    expect(takeRelaunch(d, 3000)).toBe(false);
  });

  it('opens the window when the old one was open, the note is stale, or unreadable', () => {
    const d = temp();
    writeRelaunch(d, false, 1000);
    expect(takeRelaunch(d, 2000)).toBe(false);
    writeRelaunch(d, true, 1000);
    expect(takeRelaunch(d, 1000 + 11 * 60_000)).toBe(false);
    writeFileSync(join(d, 'relaunch.json'), '{not json');
    expect(takeRelaunch(d)).toBe(false);
    expect(existsSync(join(d, 'relaunch.json'))).toBe(false);
  });
});

describe('tray menu with an update', () => {
  it('offers to restart into a downloaded update', () => {
    const st = { running: true, paused: false, live: 0, waiting: 0, runsOutlive: false };
    expect(trayMenu(st, true, '0.2.0-beta.2')[1]).toEqual({
      label: 'Restart to update to 0.2.0-beta.2',
      command: 'update',
    });
    expect(trayMenu(st, true).some((i) => i.command === 'update')).toBe(false);
  });
});

describe('install prompt', () => {
  it('says runs keep going when they outlive opsd, and end when they do not', () => {
    expect(installPrompt(1, true)).toMatch(/^1 agent run is live\. .*keep going/);
    expect(installPrompt(2, false)).toMatch(/^2 agent runs are live\. .*end with it/);
  });
});
