import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@agent-ops/core';
import type { RunRecord } from '../src/index.js';
import { buildReport, reportText, reportWindow } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

function run(agent: string, startDay: number, minutes: number, tokens: number): RunRecord {
  const start = T0 + startDay * DAY;
  return {
    id: `r${startDay}${agent}`,
    agent,
    pid: 1,
    command: 'x',
    cwd: '.',
    log: 'x',
    started_at: new Date(start).toISOString(),
    ended_at: new Date(start + minutes * 60_000).toISOString(),
    status: 'ended',
    tokens,
  } as RunRecord;
}

describe('report windows', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  it('takes whole days from 1 to 366, or a from and to', () => {
    expect(reportWindow({}, now)).toEqual({ from: now - 7 * DAY, to: now });
    expect(reportWindow({ days: '1' }, now)).toEqual({ from: now - DAY, to: now });
    expect(reportWindow({ days: '366' }, now).from).toBe(now - 366 * DAY);
    for (const days of ['1.5', '0', '367', '-1', 'week', '']) {
      expect(() => reportWindow({ days }, now), days).toThrow(/whole number/);
    }
    expect(reportWindow({ from: '2026-11-01', to: '2026-11-02' }, now)).toEqual({
      from: Date.parse('2026-11-01'),
      to: Date.parse('2026-11-02'),
    });
    expect(reportWindow({ from: '2026-11-01' }, now)).toEqual({
      from: Date.parse('2026-11-01'),
      to: now,
    });
    expect(() => reportWindow({ to: '2026-11-02' }, now)).toThrow(/give from/);
    expect(() => reportWindow({ from: '2026-11-03', to: '2026-11-02' }, now)).toThrow(/end after/);
    expect(() => reportWindow({ from: '2024-01-01', to: '2026-01-01' }, now)).toThrow(/366 days/);
    expect(() => reportWindow({ from: 'soon' }, now)).toThrow(/dates/);
  });
});

describe('reports', () => {
  it('counts tasks per project, usage per agent and provider, and decisions in the window', () => {
    const repo = mkdtempSync(join(tmpdir(), 'opsd-report-'));
    dirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    let now = T0 - 2 * DAY;
    const clock = () => now;
    const as = (actor: string) =>
      new Workspace({
        cwd: repo,
        env: { OPS_CONFIG: join(repo, 'none.yml') },
        actor,
        user: {},
        now: clock,
      });
    // Before the window: one task made, one closed.
    as('human:dawid').newTask({ title: 'old', project: 'site' });
    as('human:dawid').newTask({ title: 'old done', project: 'site' });
    as('human:dawid').done('2');
    now = T0 + DAY;
    as('human:dawid').newTask({ title: 'new', project: 'site' });
    as('human:dawid').newTask({ title: 'api work', project: 'api' });
    as('human:dawid').done('3');
    as('human:dawid').park('1', 'not now');
    as('human:dawid').block('4', 'waiting', { to: 'human:dawid' });
    as('human:dawid').post('general', 'hello');
    as('human:dawid').propose({
      question: 'Ship it?',
      options: ['yes', 'no'],
      voters: ['human:dawid'],
    });
    as('human:dawid').decide('D-0001', 'yes');
    now = T0 + 3 * DAY;

    const runs = [
      run('claude:engineer', 1, 30, 1000),
      run('codex:qa', 2, 10, 500),
      run('claude:engineer', -3, 99, 9999),
    ];
    const r = buildReport(as('human:dawid'), runs, T0, T0 + 7 * DAY);
    expect(r.projects).toEqual([
      { project: 'api', opened: 1, closed: 0, parked: 0, open: 1, blocked: 1 },
      { project: 'site', opened: 1, closed: 1, parked: 1, open: 0, blocked: 0 },
    ]);
    expect(r.agents).toEqual([
      { key: 'claude:engineer', runs: 1, minutes: 30, tokens: 1000 },
      { key: 'codex:qa', runs: 1, minutes: 10, tokens: 500 },
    ]);
    expect(r.providers.map((p) => p.key)).toEqual(['claude', 'codex']);
    expect(r.decisions).toMatchObject([{ id: 'D-0001', choice: 'yes' }]);
    expect(r.channels).toEqual([{ channel: 'general', posts: 1 }]);
    expect(r.totals).toEqual({ opened: 2, closed: 1, runs: 2, minutes: 40, tokens: 1500 });
    expect(reportText(r)).toMatch(/^Report 2026-11-01 to 2026-11-08: 1 closed, 2 opened, 2 runs/);
    expect(() => buildReport(as('human:dawid'), runs, T0, T0)).toThrow(/window/);
  });
});
