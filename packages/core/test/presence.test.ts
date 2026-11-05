import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { presenceSlug, readPresence, Root, writePresence } from '../src/index.js';
import { setup } from './helpers.js';

const T = Date.parse('2026-11-02T12:00:00Z');
const at = (min: number) => new Date(T + min * 60_000).toISOString();

describe('machine presence', () => {
  it('writes when something changed or the record is old, not on every tick', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    const base = { machine: 'PC Main', live_runs: 0, agents: [] as string[] };
    expect(writePresence(root, { ...base, last_seen: at(0) }, 20 * 60_000, T)).toBe(true);
    const file = join(rootDir, 'machines', 'pc-main.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      machine: 'pc-main',
      live_runs: 0,
    });
    expect(writePresence(root, { ...base, last_seen: at(5) }, 20 * 60_000, T + 5 * 60_000)).toBe(
      false,
    );
    expect(
      writePresence(
        root,
        { ...base, live_runs: 1, agents: ['claude:engineer'], last_seen: at(6) },
        20 * 60_000,
        T + 6 * 60_000,
      ),
    ).toBe(true);
    expect(
      writePresence(
        root,
        { ...base, live_runs: 1, agents: ['claude:engineer'], last_seen: at(30) },
        20 * 60_000,
        T + 30 * 60_000,
      ),
    ).toBe(true);
  });

  it('refuses names that cannot be a file name, and writes nothing for them', () => {
    expect(presenceSlug(undefined)).toBeNull();
    expect(presenceSlug('../../x')).toBe('x');
    expect(presenceSlug('///')).toBeNull();
    const { rootDir } = setup();
    expect(
      writePresence(new Root(rootDir), { machine: '???', live_runs: 0, last_seen: at(0) }),
    ).toBe(false);
  });

  it('never reads or writes through links, and returns only known fields', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    const outside = setup().rootDir;
    writeFileSync(
      join(outside, 'pc.json'),
      JSON.stringify({ machine: 'pc', last_seen: at(0), live_runs: 1 }),
    );
    symlinkSync(outside, join(rootDir, 'machines'), 'junction');
    expect(readPresence([root], T)).toEqual([]);
    expect(writePresence(root, { machine: 'pc', live_runs: 0, last_seen: at(0) }, 0, T)).toBe(
      false,
    );
    expect(readFileSync(join(outside, 'pc.json'), 'utf8')).toContain('"live_runs":1');

    const other = setup();
    const r2 = new Root(other.rootDir);
    writePresence(r2, { machine: 'laptop', live_runs: 0, last_seen: at(0) }, 0, T);
    writeFileSync(
      join(other.rootDir, 'machines', 'odd.json'),
      JSON.stringify({
        machine: 'odd',
        last_seen: at(0),
        live_runs: 'many',
        token: 'x',
        agents: [1, 'a'],
      }),
    );
    const seen = readPresence([r2], T);
    expect(seen.find((m) => m.machine === 'odd')).toEqual({
      machine: 'odd',
      last_seen: at(0),
      live_runs: 0,
      agents: ['a'],
      alive: true,
    });
  });

  it('reads the newest record per machine across roots and says which are alive', () => {
    const a = setup();
    const b = setup();
    const ra = new Root(a.rootDir);
    const rb = new Root(b.rootDir);
    writePresence(ra, { machine: 'pc', live_runs: 2, last_seen: at(0) }, 0, T);
    writePresence(rb, { machine: 'pc', live_runs: 0, last_seen: at(-200) }, 0, T);
    writePresence(rb, { machine: 'laptop', live_runs: 0, last_seen: at(-120) }, 0, T);
    // A broken file is skipped.
    writeFileSync(join(b.rootDir, 'machines', 'junk.json'), '{nope');
    const seen = readPresence([ra, rb], T + 60_000);
    expect(seen.map((m) => [m.machine, m.live_runs, m.alive])).toEqual([
      ['pc', 2, true],
      ['laptop', 0, false],
    ]);
  });
});
