import { describe, expect, it } from 'vitest';
import { humanSessionMinutes, playbackAt, timeMap } from '../src/index.js';
import { setup } from './helpers.js';

const MIN = 60_000;

/** A clock the test sets: `at('09:00')` on day 1, `at('09:00', 2)` on day 2. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    at(hhmm: string, day = 1): void {
      t = Date.parse(`2026-10-0${day}T${hhmm}:00Z`);
    },
  };
}

/**
 * A fixture store, project `site`:
 * - T-0001: claude:engineer works it in one run, asks the human (answered after 2 h), sends two
 *   review rounds to codex:reviewer (changes, then approve) and writes a learn note.
 * - T-0002: codex:engineer starts it on day 2 and goes quiet, so the lease runs out; a decision
 *   on it is proposed by claude:engineer and decided by the human.
 * Project `api`, T-0003: claude:engineer holds it, so a project filter must leave it out.
 */
function fixture() {
  const c = clock();
  const { as } = setup();
  const h = as('human:dawid', { now: c.now });
  const cl = as('claude:engineer', { now: c.now });
  const cr = as('codex:reviewer', { now: c.now });
  const ce = as('codex:engineer', { now: c.now });

  c.at('08:50');
  h.newTask({ title: 'Login page', project: 'site', owner: 'claude:engineer' });
  h.newTask({ title: 'Billing page', project: 'site', owner: 'codex:engineer' });
  h.newTask({ title: 'Rate limits', project: 'api', owner: 'claude:engineer' });

  c.at('09:00');
  cl.start('1', 'build the login form');
  cl.recordRun('1', 'run-start', { run: 'r1' });
  c.at('09:30');
  cl.ask('1', 'Email or username login?');
  c.at('11:30');
  h.answer('1', 'Email');
  c.at('11:35');
  cl.start('1', 'email login');
  c.at('12:00');
  cl.learn({ topic: 'auth', title: 'Sessions need SameSite=Lax', body: 'why', task: '1' });
  c.at('12:10');
  cl.review('1', 'login form ready', 'codex:reviewer');
  cl.recordRun('1', 'run-end', { run: 'r1', exit: 0, reason: 'exit', minutes: 190, tokens: 5000 });
  c.at('12:40');
  cr.verdict('1', 'changes', 'add a rate limit');
  c.at('13:00');
  cl.start('1', 'rate limit');
  c.at('13:20');
  cl.review('1', 'rate limit added', 'codex:reviewer');
  c.at('13:50');
  cr.verdict('1', 'approve', 'good');

  c.at('14:00');
  cl.start('3', 'limits');

  c.at('09:00', 2);
  ce.start('2', 'billing form');
  c.at('09:10', 2);
  const d = cl.propose({
    question: 'Stripe or Paddle?',
    options: ['stripe', 'paddle'],
    voters: ['human:dawid'],
    quorum: 1,
    task: '2',
  });
  c.at('09:20', 2);
  h.decide(d.id, 'stripe', 'we have an account');
  c.at('18:00', 2);
  return { as, c };
}

describe('replay timeline', () => {
  it('builds lanes, spans, review rounds, waits, runs and totals for a project', () => {
    const { as, c } = fixture();
    const t = as('human:dawid', { now: c.now }).timeline({ project: 'site' });

    expect(t.to).toBe('2026-10-02T18:00:00.000Z');
    expect(t.lanes.map((l) => [l.agent, l.kind])).toEqual([
      ['human:dawid', 'human'],
      ['claude:engineer', 'agent'],
      ['codex:reviewer', 'agent'],
      ['codex:engineer', 'agent'],
    ]);

    // T-0003 is in project api and stays out.
    expect(
      t.spans.map((s) => [s.task, s.agent, s.start.slice(11, 16), s.end?.slice(11, 16), s.endedBy]),
    ).toEqual([
      ['T-0001', 'claude:engineer', '09:00', '09:30', 'ask'],
      ['T-0001', 'claude:engineer', '11:35', '12:10', 'review'],
      ['T-0001', 'claude:engineer', '13:00', '13:20', 'review'],
      // The lease from the start (4 h) ran out with no event.
      ['T-0002', 'codex:engineer', '09:00', '13:00', 'expired'],
    ]);

    expect(t.reviews).toMatchObject([
      {
        task: 'T-0001',
        round: 1,
        author: 'claude:engineer',
        reviewer: 'codex:reviewer',
        verdict: 'changes',
        decidedBy: 'codex:reviewer',
        endedBy: 'verdict',
      },
      {
        task: 'T-0001',
        round: 2,
        verdict: 'approve',
        endedBy: 'verdict',
        end: '2026-10-01T13:50:00.000Z',
      },
    ]);

    expect(t.waits).toMatchObject([
      {
        task: 'T-0001',
        kind: 'ask',
        actor: 'claude:engineer',
        waitingOn: 'human:dawid',
        human: true,
        start: '2026-10-01T09:30:00.000Z',
        end: '2026-10-01T11:30:00.000Z',
        answered: true,
        endedBy: 'answer',
      },
    ]);

    expect(t.runs).toMatchObject([
      {
        task: 'T-0001',
        agent: 'claude:engineer',
        run: 'r1',
        start: '2026-10-01T09:00:00.000Z',
        end: '2026-10-01T12:10:00.000Z',
        tokens: 5000,
        exit: 0,
      },
    ]);
    expect(t.notes).toMatchObject([
      { task: 'T-0001', agent: 'claude:engineer', title: 'Sessions need SameSite=Lax' },
    ]);
    expect(t.closes).toMatchObject([
      { task: 'T-0001', by: 'codex:reviewer', via: 'verdict', at: '2026-10-01T13:50:00.000Z' },
    ]);
    expect(t.decisions).toMatchObject([
      {
        task: 'T-0002',
        proposedBy: 'claude:engineer',
        choice: 'stripe',
        decidedBy: 'human:dawid',
        end: '2026-10-02T09:20:00.000Z',
      },
    ]);

    const claude = t.lanes.find((l) => l.agent === 'claude:engineer')!;
    expect(claude).toMatchObject({
      workMs: (30 + 35 + 20) * MIN,
      runMs: 190 * MIN,
      tokens: 5000,
      tasks: 1,
    });
    expect(t.lanes.find((l) => l.agent === 'codex:reviewer')).toMatchObject({
      reviews: 2,
      tasks: 0,
    });

    expect(t.totals).toEqual({
      agentHours: 3.2, // the 190-minute run
      workHours: 5.4, // 85 min on T-0001, 240 min on T-0002
      // Sessions: 08:50 (3 tasks), 11:30 answer, day 2 09:20 decide: 2 min each.
      humanMinutes: 6,
      humanWaitMinutes: 120,
      asksAnswered: 1,
      reviewRounds: 2,
      tasksClosed: 1,
      runs: 1,
      tokens: 5000,
    });
  });

  it('keeps items that overlap the window and counts only time inside it', () => {
    const { as, c } = fixture();
    const t = as('human:dawid', { now: c.now }).timeline({
      project: 'site',
      from: Date.parse('2026-10-01T11:00:00Z'),
      to: Date.parse('2026-10-01T13:00:00Z'),
    });
    // The wait started before the window; the second round starts after it.
    expect(t.waits).toHaveLength(1);
    expect(t.reviews.map((r) => r.round)).toEqual([1]);
    expect(t.spans.map((s) => s.start.slice(11, 16))).toEqual(['11:35']);
    expect(t.totals).toMatchObject({
      humanWaitMinutes: 30,
      asksAnswered: 1,
      reviewRounds: 1,
      tasksClosed: 0,
      // The run overlaps the window from 11:00 to 12:10.
      agentHours: 1.2,
      runs: 0,
    });
  });

  it('covers every project of a root without a project filter', () => {
    const { as, c } = fixture();
    const ws = as('human:dawid', { now: c.now });
    const t = ws.timeline({ root: 'test' });
    expect(new Set(t.spans.map((s) => s.task))).toEqual(new Set(['T-0001', 'T-0002', 'T-0003']));
    expect(() => ws.timeline({ root: 'nope' })).toThrow(/no root/);
  });

  it('ends a stale claim at its lease when a later event clears it', () => {
    const c = clock();
    const { as } = setup();
    const h = as('human:dawid', { now: c.now });
    const cl = as('claude:engineer', { now: c.now });
    c.at('08:50');
    h.newTask({ title: 'Closed late', project: 'site', owner: 'claude:engineer' });
    h.newTask({ title: 'Handed off late', project: 'site', owner: 'claude:engineer' });
    c.at('09:00');
    cl.start('1', 'work');
    cl.start('2', 'work');
    // Both leases (4 h) run out at 13:00; the human clears the claims hours later.
    c.at('15:00');
    h.done('1', 'finished elsewhere');
    h.handoff('2', 'codex:engineer', 'take this over');
    c.at('18:00');
    const t = h.timeline({ project: 'site' });
    expect(
      t.spans.map((s) => [s.task, s.start.slice(11, 16), s.end?.slice(11, 16), s.endedBy]),
    ).toEqual([
      ['T-0001', '09:00', '13:00', 'expired'],
      ['T-0002', '09:00', '13:00', 'expired'],
    ]);
    expect(t.totals.workHours).toBe(8);
  });

  it('maps playback over items that cross the window with no other point inside it', () => {
    const c = clock();
    const { as } = setup();
    const h = as('human:dawid', { now: c.now });
    const cl = as('claude:engineer', { now: c.now });
    c.at('08:50');
    h.newTask({ title: 'Waiting', project: 'site', owner: 'claude:engineer' });
    c.at('09:00');
    cl.start('1', 'work');
    cl.ask('1', 'Which colour?');
    c.at('18:00');
    // The ask is still open; the window holds no event of its own.
    const t = h.timeline({
      project: 'site',
      from: Date.parse('2026-10-01T12:00:00Z'),
      clipMs: 1000,
    });
    expect(t.waits).toMatchObject([{ kind: 'ask', end: null }]);
    expect(t.time.playbackMs).toBe(1000);
    expect(t.time.segments[0]!.start).toBe(Date.parse('2026-10-01T12:00:00Z'));
    expect(t.time.segments.at(-1)!.end).toBe(Date.parse('2026-10-01T18:00:00Z'));

    // A closed run and answered wait that both cross the window edges map it the same way.
    const { as: as2, c: c2 } = fixture();
    const w = as2('human:dawid', { now: c2.now }).timeline({
      project: 'site',
      from: Date.parse('2026-10-01T10:00:00Z'),
      to: Date.parse('2026-10-01T11:00:00Z'),
      clipMs: 1000,
    });
    expect(w.time.playbackMs).toBe(1000);
    expect(playbackAt(w.time, Date.parse('2026-10-01T10:30:00Z'))).toBeCloseTo(500, 6);
  });

  it('squeezes idle gaps in playback time', () => {
    const { as, c } = fixture();
    const t = as('human:dawid', { now: c.now }).timeline({ project: 'site', clipMs: 60_000 });
    const map = t.time;
    expect(map.playbackMs).toBe(60_000);
    // The night between day 1 and day 2 plays as no more than 30 minutes of the squeezed length.
    const night = map.segments.find((s) => s.idle && s.end === Date.parse('2026-10-02T09:00:00Z'))!;
    expect(night).toBeDefined();
    const busy = map.segments.find((s) => s.start === Date.parse('2026-10-01T09:00:00Z'))!;
    const rate = (s: typeof busy): number => (s.playEnd - s.playStart) / (s.end - s.start);
    expect(rate(night)).toBeLessThan(rate(busy) / 10);
    expect(playbackAt(map, Date.parse('2026-09-30T00:00:00Z'))).toBe(0);
    expect(playbackAt(map, Date.parse('2026-10-03T00:00:00Z'))).toBe(60_000);
  });
});

describe('timeMap', () => {
  it('plays short gaps at real speed and long ones as the cap, then scales to the clip', () => {
    const m = timeMap([0, 10 * MIN, 10 * MIN + 5 * 60 * MIN, 10 * MIN + 5 * 60 * MIN + MIN], {
      maxGapMs: 30 * MIN,
    });
    expect(m.segments.map((s) => [s.playEnd - s.playStart, s.idle])).toEqual([
      [10 * MIN, false],
      [30 * MIN, true],
      [MIN, false],
    ]);
    expect(m.playbackMs).toBe(41 * MIN);
    expect(playbackAt(m, 5 * MIN)).toBe(5 * MIN);
    // Halfway through the 5-hour gap is halfway through its 30 playback minutes.
    expect(playbackAt(m, 10 * MIN + 150 * MIN)).toBe(25 * MIN);

    const clip = timeMap([0, 10 * MIN, 20 * MIN], { clipMs: 1000 });
    expect(clip.playbackMs).toBe(1000);
    expect(playbackAt(clip, 10 * MIN)).toBeCloseTo(500, 6);
    expect(timeMap([]).segments).toEqual([]);
    expect(playbackAt(timeMap([5]), 9)).toBe(0);
  });

  it('estimates human minutes from sessions of events', () => {
    expect(humanSessionMinutes([])).toBe(0);
    // One session of 0, 5 and 9 minutes: 9 + 2; one lone event later: 2.
    expect(humanSessionMinutes([0, 5 * MIN, 9 * MIN, 60 * MIN])).toBe(13);
  });
});
