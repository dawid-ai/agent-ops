import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@agent-ops/core';
import type { Timeline } from '@agent-ops/core';
import { startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// The test process's own config path: nothing here may write to it.
const guard = mkdtempSync(join(tmpdir(), 'opsd-timeline-guard-'));
const processConfig = join(guard, 'process-config.yml');
const savedConfig = process.env.OPS_CONFIG;
beforeAll(() => {
  process.env.OPS_CONFIG = processConfig;
});
afterAll(() => {
  if (savedConfig === undefined) delete process.env.OPS_CONFIG;
  else process.env.OPS_CONFIG = savedConfig;
  rmSync(guard, { recursive: true, force: true });
});
afterEach(async () => {
  expect(existsSync(processConfig), 'an edit went to the process config').toBe(false);
  for (const s of sups.splice(0)) {
    s.stop({ killRuns: true });
    await s.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-timeline-'));
  dirs.push(d);
  return d;
}

async function setup() {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const file = join(temp(), 'config.yml');
  writeFileSync(file, 'me: human:dawid\nopsd:\n  sync: false\n');
  const env = { ...process.env, OPS_CONFIG: file, OPS_STATE_DIR: temp() } as NodeJS.ProcessEnv;
  delete env.OPS_AGENT;
  delete env.OPS_ROOTS;
  const sup = new Supervisor({ env, cwd: repo, freeMem: () => 64 * 2 ** 30 });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'timeline-token', version: 't', build: '1' });
  const call = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      headers: { authorization: 'Bearer timeline-token' },
    });
    return { status: res.status, data: (await res.json()) as Timeline & { error?: string } };
  };
  return { call, env, repo };
}

describe('timeline route', () => {
  it('answers the timeline of a project for a window, scaled to a clip', async () => {
    const { call, env, repo } = await setup();
    let now = Date.parse('2026-10-01T09:00:00Z');
    const as = (actor: string) => new Workspace({ cwd: repo, env, actor, now: () => now });
    const h = as('human:dawid');
    h.newTask({ title: 'Login page', project: 'site', owner: 'claude:engineer' });
    h.newTask({ title: 'Rate limits', project: 'api', owner: 'claude:engineer' });
    const c = as('claude:engineer');
    now += 10 * 60_000;
    c.start('1', 'plan');
    now += 20 * 60_000;
    c.ask('1', 'Email or username?');
    now += 60 * 60_000;
    h.answer('1', 'Email');
    c.start('2', 'limits');

    const window = 'from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z';
    const res = await call(`/api/timeline?project=site&${window}&clip=60&gap=10`);
    expect(res.status).toBe(200);
    expect(res.data.spans.map((s) => [s.task, s.agent, s.endedBy])).toEqual([
      ['T-0001', 'claude:engineer', 'ask'],
    ]);
    expect(res.data.waits).toMatchObject([{ task: 'T-0001', human: true, answered: true }]);
    expect(res.data.totals).toMatchObject({ asksAnswered: 1, humanWaitMinutes: 60 });
    expect(res.data.time).toMatchObject({ playbackMs: 60_000, maxGapMs: 600_000 });
    expect(res.data.from).toBe('2026-10-01T00:00:00.000Z');

    // Without a project, every project of the root.
    const all = await call(`/api/timeline?root=test&${window}`);
    expect(new Set(all.data.spans.map((s) => s.task))).toEqual(new Set(['T-0001', 'T-0002']));

    expect((await call(`/api/timeline?${window}&clip=0`)).status).toBe(400);
    expect((await call(`/api/timeline?${window}&gap=1.5`)).status).toBe(400);
    expect((await call('/api/timeline?days=0')).status).toBe(400);
    const bad = await call('/api/timeline?to=2026-10-02');
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/^timeline: give from with to/);
    expect((await call(`/api/timeline?root=nope&${window}`)).status).toBe(400);
  });
});
