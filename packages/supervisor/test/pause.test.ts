import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRoot } from '@agent-ops/core';
import { opsdConfig, PAUSED, setPaused, startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// The test process's own config path: nothing here may write to it.
const guard = mkdtempSync(join(tmpdir(), 'opsd-pause-guard-'));
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
  const d = mkdtempSync(join(tmpdir(), 'opsd-pause-'));
  dirs.push(d);
  return d;
}

function env(config: string): { env: NodeJS.ProcessEnv; file: string } {
  const file = join(temp(), 'config.yml');
  writeFileSync(file, config);
  const e = { ...process.env, OPS_CONFIG: file, OPS_STATE_DIR: temp() } as NodeJS.ProcessEnv;
  delete e.OPS_AGENT;
  delete e.OPS_ROOTS;
  return { env: e, file };
}

async function setup(config = 'me: human:dawid\nopsd:\n  sync: false\n') {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const { env: e, file } = env(config);
  const sup = new Supervisor({ env: e, cwd: repo, freeMem: () => 64 * 2 ** 30 });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'pause-token', version: 't', build: '1' });
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: 'Bearer pause-token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  return { sup, call, env: e, file };
}

describe('pausing opsd', () => {
  it('starts no new run while paused, lets helper runs of live runs start, and resumes', async () => {
    const { sup, call, file } = await setup();
    expect(sup.blocker('claude:engineer', 'test')).toBeNull();

    let res = await call('POST', '/api/settings', { patch: { opsd: { paused: true } } });
    expect(res.status).toBe(200);
    expect(readFileSync(file, 'utf8')).toMatch(/paused: true/);
    expect(sup.blocker('claude:engineer', 'test')).toBe(PAUSED);
    expect(sup.blocker('claude:engineer', 'test', { child: true })).toBeNull();
    // A runtime that is not installed (no claude on CI) fails before the pause check; either
    // way, nothing starts.
    expect(() => sup.launch({ agent: 'claude:engineer' })).toThrow(/opsd is paused|not on PATH/);
    res = await call('GET', '/api/health');
    expect(res.data.paused).toBe(true);
    res = await call('GET', '/api/settings');
    expect((res.data.opsd as Record<string, unknown>).paused).toBe(true);

    // Resuming removes the key: the file keeps only what differs from the default.
    res = await call('POST', '/api/settings', { patch: { opsd: { paused: false } } });
    expect(res.status).toBe(200);
    expect(readFileSync(file, 'utf8')).not.toMatch(/paused/);
    expect(sup.blocker('claude:engineer', 'test')).toBeNull();
    res = await call('GET', '/api/health');
    expect(res.data.paused).toBe(false);
  });

  it('refuses a paused value that is not true or false', async () => {
    const { call, file } = await setup();
    const before = readFileSync(file, 'utf8');
    const res = await call('POST', '/api/settings', { patch: { opsd: { paused: 'yes' } } });
    expect(res.status).toBe(400);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(() => opsdConfig({ opsd: { paused: 'yes' as unknown as boolean } })).toThrow(
      /opsd.paused/,
    );
  });

  it('pauses in the config while opsd is down, and a new opsd starts paused', () => {
    const { env: e, file } = env('me: human:dawid\nopsd:\n  sync: false\n  max_runs: 2\n');
    setPaused(e, true);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/paused: true/);
    // Other settings stay.
    expect(text).toMatch(/max_runs: 2/);
    const repo = temp();
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    const sup = new Supervisor({ env: e, cwd: repo, freeMem: () => 64 * 2 ** 30 });
    sups.push(sup);
    expect(sup.config.paused).toBe(true);
    expect(sup.blocker('codex:qa', 'test')).toBe(PAUSED);
    setPaused(e, false);
    expect(readFileSync(file, 'utf8')).not.toMatch(/paused/);
    sup.reloadConfig();
    expect(sup.blocker('codex:qa', 'test')).toBeNull();
  });

  it('refuses pause and resume before a run token can edit the config', () => {
    const { env: e, file } = env('me: human:dawid\nopsd:\n  sync: false\n');
    e.OPS_RUN_TOKEN = 'run-token';
    e.OPS_RUN_STATE_DIR = e.OPS_STATE_DIR;
    expect(() => setPaused(e, true)).toThrow(/pausing opsd is for the human.*ops ask/);
    expect(readFileSync(file, 'utf8')).not.toMatch(/paused/);
    expect(() => setPaused(e, false)).toThrow(/resuming opsd is for the human.*ops ask/);
    expect(readFileSync(file, 'utf8')).not.toMatch(/paused/);

    // A run may control an opsd it starts on a different state folder with that opsd's full token.
    e.OPS_RUN_STATE_DIR = temp();
    setPaused(e, true);
    expect(readFileSync(file, 'utf8')).toMatch(/paused: true/);
  });

  it('runs no schedule while paused', async () => {
    const { sup } = await setup(
      'me: human:dawid\nopsd:\n  sync: false\n  paused: true\n  schedules:\n    - { name: standup, agent: claude:pm, every: 1m }\n',
    );
    expect(() => sup.runScheduleNow('standup')).toThrow(/opsd is paused/);
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(0);
    expect(sup.scheduleRuns()).toEqual({});
  });
});
