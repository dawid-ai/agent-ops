import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepeatMeta } from '../src/index.js';
import { initRoot, latestSlot, localStamp, nextSlot, parseLocal, Workspace } from '../src/index.js';
import { gitRepo, setup } from './helpers.js';

/** Local wall time in ms, as the rules read it. */
function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi).getTime();
}

function rule(over: Partial<RepeatMeta>): RepeatMeta {
  return { name: 'r', title: 't', created_by: 'human:dawid', created_at: '', ...over };
}

/** A workspace factory whose clock the test moves. */
function clocked(start: number) {
  const s = setup();
  const clock = { now: start };
  const as = (actor: string) => s.as(actor, { now: () => clock.now });
  return { ...s, clock, as, human: as('human:dawid') };
}

function repeatTasks(ws: Workspace, name: string) {
  return ws
    .list({ all: true })
    .filter((v) => v.meta.repeat === name)
    .map((v) => v.meta);
}

describe('repeat slots', () => {
  it('reads and writes local wall time', () => {
    expect(localStamp(parseLocal('2026-11-05 09:00'))).toBe('2026-11-05T09:00');
    expect(() => parseLocal('2026-02-30 09:00')).toThrow(/no such date/);
    expect(() => parseLocal('tomorrow')).toThrow(/bad start/);
  });

  it('finds the latest and next slot of each rule', () => {
    const daily = rule({ start: '2026-11-05T09:00', repeat: 'daily' });
    expect(latestSlot(daily, at(2026, 11, 5, 8, 59))).toBeNull();
    expect(latestSlot(daily, at(2026, 11, 5, 9))).toBe(at(2026, 11, 5, 9));
    expect(latestSlot(daily, at(2026, 11, 9, 8))).toBe(at(2026, 11, 8, 9));
    expect(nextSlot(daily, at(2026, 11, 9, 8))).toBe(at(2026, 11, 9, 9));

    // 2026-11-05 is a Thursday.
    const weekly = rule({ start: '2026-11-05T09:00', repeat: 'weekly' });
    expect(latestSlot(weekly, at(2026, 11, 11, 12))).toBe(at(2026, 11, 5, 9));
    expect(nextSlot(weekly, at(2026, 11, 5, 9))).toBe(at(2026, 11, 12, 9));

    const days = rule({ start: '2026-11-05T09:00', repeat: 'weekdays', days: ['mon', 'thu'] });
    expect(latestSlot(days, at(2026, 11, 8, 12))).toBe(at(2026, 11, 5, 9));
    expect(nextSlot(days, at(2026, 11, 5, 10))).toBe(at(2026, 11, 9, 9));

    const once = rule({ start: '2026-11-05T09:00' });
    expect(latestSlot(once, at(2027, 3, 1))).toBe(at(2026, 11, 5, 9));
    expect(nextSlot(once, at(2026, 11, 5, 9))).toBeNull();

    const yearly = rule({ start: '2028-02-29T10:00', repeat: 'yearly' });
    expect(nextSlot(yearly, at(2028, 3, 1))).toBe(at(2029, 2, 28, 10));
    expect(latestSlot(yearly, at(2029, 6, 1))).toBe(at(2029, 2, 28, 10));
  });

  it('puts the 29th to 31st on the last day of shorter months', () => {
    const monthly = rule({ start: '2027-01-31T08:00', repeat: 'monthly' });
    expect(nextSlot(monthly, at(2027, 2, 1))).toBe(at(2027, 2, 28, 8));
    expect(nextSlot(monthly, at(2027, 3, 1))).toBe(at(2027, 3, 31, 8));
    expect(nextSlot(monthly, at(2027, 4, 1))).toBe(at(2027, 4, 30, 8));
    expect(latestSlot(monthly, at(2027, 5, 15))).toBe(at(2027, 4, 30, 8));
  });

  it('stops at until', () => {
    const daily = rule({ start: '2026-11-05T09:00', repeat: 'daily', until: '2026-11-07' });
    expect(latestSlot(daily, at(2026, 12, 1))).toBe(at(2026, 11, 7, 9));
    expect(nextSlot(daily, at(2026, 11, 7, 9))).toBeNull();
  });
});

describe('repeating tasks', () => {
  it('creates each task at its slot with a fake clock', () => {
    const t = clocked(at(2026, 11, 4, 12));
    const cases = [
      { name: 'one-off', start: '2026-11-05 09:00', fires: at(2026, 11, 5, 9) },
      { name: 'daily', start: '2026-11-05 10:00', repeat: 'daily', fires: at(2026, 11, 5, 10) },
      {
        name: 'weekly',
        start: '2026-11-06 07:30',
        repeat: 'weekly',
        fires: at(2026, 11, 6, 7, 30),
      },
      {
        name: 'mon-thu',
        start: '2026-11-06 09:00',
        repeat: 'weekdays',
        days: 'mon,thu',
        fires: at(2026, 11, 9, 9),
      },
      { name: 'monthly', start: '2026-11-30 09:00', repeat: 'monthly', fires: at(2026, 11, 30, 9) },
      { name: 'yearly', start: '2027-01-01 00:00', repeat: 'yearly', fires: at(2027, 1, 1) },
    ];
    for (const c of cases) {
      t.human.saveRepeat({ ...c, title: `${c.name} {date}`, owner: 'claude:engineer' });
    }
    for (const c of cases) {
      t.clock.now = c.fires - 60_000;
      const before = t.human.fireRepeats().filter((f) => f.repeat === c.name);
      expect(before, c.name).toEqual([]);
      t.clock.now = c.fires;
      const fired = t.as('claude:engineer').fireRepeats();
      const mine = fired.filter((f) => f.repeat === c.name);
      expect(mine, c.name).toHaveLength(1);
      expect(mine[0]!.slot).toBe(localStamp(c.fires));
      const tasks = repeatTasks(t.human, c.name);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.title).toBe(`${c.name} ${localStamp(c.fires).slice(0, 10)}`);
      expect(tasks[0]!.owner).toBe('claude:engineer');
      expect(tasks[0]!.created_by).toBe('human:dawid');
      // Fired once: the next tick does nothing.
      t.clock.now = c.fires + 60_000;
      expect(t.human.fireRepeats().filter((f) => f.repeat === c.name)).toEqual([]);
      // Close it, so later slots of the other repeats are not held back.
      t.human.done(tasks[0]!.id, 'ok');
    }
  });

  it('fires missed slots once, and waits while the last task is open', () => {
    const t = clocked(at(2026, 11, 1, 8));
    t.human.saveRepeat({
      name: 'standup',
      title: 'Standup',
      start: '2026-11-01 09:00',
      repeat: 'daily',
    });
    // The PC was off for four days: one task for the latest slot.
    t.clock.now = at(2026, 11, 5, 12);
    const fired = t.human.fireRepeats();
    expect(fired.map((f) => f.slot)).toEqual(['2026-11-05T09:00']);
    expect(t.human.fireRepeats()).toEqual([]);
    // The next slot comes while that task is open: the repeat waits.
    t.clock.now = at(2026, 11, 6, 9, 5);
    expect(t.human.fireRepeats()).toEqual([]);
    expect(t.human.repeatView('standup').state).toBe('waiting');
    // Once it closes, the waiting slot fires once.
    t.human.done(fired[0]!.task, 'done');
    expect(t.human.fireRepeats().map((f) => f.slot)).toEqual(['2026-11-06T09:00']);
    expect(repeatTasks(t.human, 'standup')).toHaveLength(2);
  });

  it('pauses, resumes, runs now and deletes', () => {
    const t = clocked(at(2026, 11, 1, 8));
    t.human.saveRepeat({
      name: 'report',
      title: 'Report',
      start: '2026-11-01 09:00',
      repeat: 'daily',
    });
    expect(t.human.setRepeatPaused('report', true).state).toBe('paused');
    t.clock.now = at(2026, 11, 3, 12);
    expect(t.human.fireRepeats()).toEqual([]);
    // Resumed: the slots missed while paused fire once.
    t.human.setRepeatPaused('report', false);
    const fired = t.human.fireRepeats();
    expect(fired.map((f) => f.slot)).toEqual(['2026-11-03T09:00']);
    t.human.done(fired[0]!.task, 'ok');
    // Run now creates a task at once and counts as this minute's slot.
    t.clock.now = at(2026, 11, 3, 12, 30);
    const now = t.human.runRepeat('report');
    expect(now.repeat_slot).toBe('2026-11-03T12:30');
    expect(t.human.fireRepeats()).toEqual([]);
    t.human.deleteRepeat('report');
    expect(t.human.repeats()).toEqual([]);
    expect(t.human.view(now.id).meta.repeat).toBe('report');
  });

  it('keeps each repeat in its own root when two roots use the same name', () => {
    const t = clocked(at(2026, 11, 1, 8));
    const betaDir = gitRepo();
    initRoot(betaDir, { name: 'beta', human: 'human:dawid' });
    const ws = new Workspace({
      cwd: t.repo,
      env: { ...t.env, OPS_ROOTS: betaDir } as NodeJS.ProcessEnv,
      actor: 'human:dawid',
      now: () => t.clock.now,
    });
    const beta = ws.roots.find((r) => r.name === 'beta')!;
    const added = ws.saveRepeat({
      name: 'beta/report',
      title: 'Beta report',
      start: '2026-11-01 09:00',
      repeat: 'daily',
    });
    expect(added.root).toBe('beta');
    expect(existsSync(join(beta.dir, 'repeats', 'report.md'))).toBe(true);
    expect(existsSync(join(t.rootDir, 'repeats', 'report.md'))).toBe(false);

    // With one repeat of that name, a bare-name edit finds it in beta, never writes a copy
    // into the default root.
    ws.saveRepeat(
      { name: 'report', title: 'Beta report v2', start: '2026-11-01 09:00' },
      {
        replace: true,
      },
    );
    expect(existsSync(join(t.rootDir, 'repeats', 'report.md'))).toBe(false);
    expect(ws.repeatView('beta/report').meta.title).toBe('Beta report v2');

    ws.saveRepeat({ name: 'report', title: 'Test report', start: '2026-11-01 09:00' });
    expect(() => ws.repeatView('report')).toThrow(/several roots; write <root>\/report/);
    expect(ws.repeats().map((r) => `${r.root}/${r.meta.title}`)).toEqual([
      'beta/Beta report v2',
      'test/Test report',
    ]);

    // Each mutation by root/name touches only that root's definition.
    ws.saveRepeat(
      { name: 'report', root: 'beta', title: 'Beta report v3', start: '2026-11-01 09:00' },
      { replace: true },
    );
    expect(ws.repeatView('test/report').meta.title).toBe('Test report');
    expect(ws.setRepeatPaused('beta/report', true).root).toBe('beta');
    expect(ws.repeatView('test/report').meta.paused).toBeUndefined();
    const ran = ws.runRepeat('test/report');
    expect(ws.view(`test/${ran.id}`).root).toBe('test');
    ws.deleteRepeat('beta/report');
    expect(ws.repeats().map((r) => `${r.root}/${r.meta.name}`)).toEqual(['test/report']);
  });

  it('honours count', () => {
    const t = clocked(at(2026, 11, 1, 8));
    t.human.saveRepeat({
      name: 'twice',
      title: 'Twice',
      start: '2026-11-01 09:00',
      repeat: 'daily',
      count: 2,
    });
    for (const day of [1, 2, 3]) {
      t.clock.now = at(2026, 11, day, 10);
      for (const f of t.human.fireRepeats()) t.human.done(f.task, 'ok');
    }
    expect(repeatTasks(t.human, 'twice')).toHaveLength(2);
    expect(t.human.repeatView('twice').state).toBe('finished');
  });

  it('fires when a task closes, once per close', () => {
    const t = clocked(at(2026, 11, 1, 8));
    const dep = t.human.newTask({ title: 'Ship the release' });
    t.human.saveRepeat({ name: 'after-ship', title: 'Announce', when: `closed ${dep.id}` });
    expect(t.human.fireRepeats()).toEqual([]);
    t.human.done(dep.id, 'shipped');
    const fired = t.human.fireRepeats();
    expect(fired).toHaveLength(1);
    expect(t.human.fireRepeats()).toEqual([]);
    // A comment on the closed task changes nothing.
    t.human.comment(dep.id, 'note');
    expect(t.human.fireRepeats()).toEqual([]);
    // Reopened and closed again: a new close fires once more, after the last task closed.
    t.human.done(fired[0]!.task, 'ok');
    t.human.reopen(dep.id, 'again');
    t.human.done(dep.id, 'shipped again');
    expect(t.human.fireRepeats()).toHaveLength(1);
  });

  it('fires when every subtask of a parent closes', () => {
    const t = clocked(at(2026, 11, 1, 8));
    const parent = t.human.newTask({ title: 'Epic' });
    const a = t.human.newTask({ title: 'A', parent: parent.id });
    const b = t.human.newTask({ title: 'B', parent: parent.id });
    t.human.saveRepeat({ name: 'wrap-up', title: 'Wrap up', when: `children-closed ${parent.id}` });
    t.human.done(a.id, 'ok');
    expect(t.human.fireRepeats()).toEqual([]);
    t.human.done(b.id, 'ok');
    expect(t.human.fireRepeats()).toHaveLength(1);
  });

  it('lets only a human or the orchestrator manage repeats', () => {
    const t = clocked(at(2026, 11, 1, 8));
    const agent = t.as('claude:engineer');
    expect(() =>
      agent.saveRepeat({ name: 'x', title: 'X', start: '2026-11-02 09:00', repeat: 'daily' }),
    ).toThrow(/cannot manage repeats/);
    t.human.saveRepeat({ name: 'x', title: 'X', start: '2026-11-02 09:00', repeat: 'daily' });
    expect(() => agent.setRepeatPaused('x', true)).toThrow(/cannot manage repeats/);
    expect(() => agent.deleteRepeat('x')).toThrow(/cannot manage repeats/);
    expect(() => agent.runRepeat('x')).toThrow(/cannot run repeats/);
  });

  it('checks the rule', () => {
    const t = clocked(at(2026, 11, 1, 8));
    const bad = (over: object) => () => t.human.saveRepeat({ name: 'bad', title: 'Bad', ...over });
    expect(bad({})).toThrow(/needs a start/);
    expect(bad({ start: '2026-11-02 09:00', repeat: 'hourly' })).toThrow(/bad rule/);
    expect(bad({ start: '2026-11-02 09:00', repeat: 'weekdays' })).toThrow(/needs --days/);
    expect(bad({ start: '2026-11-02 09:00', repeat: 'weekdays', days: 'mon,xyz' })).toThrow(
      /bad days/,
    );
    expect(bad({ when: 'opened AO-1' })).toThrow(/bad condition/);
    expect(bad({ start: '2026-11-02 09:00', count: 0 })).toThrow(/bad count/);
    expect(bad({ name: 'Bad Name', start: '2026-11-02 09:00' })).toThrow(/bad repeat name/);
  });
});
