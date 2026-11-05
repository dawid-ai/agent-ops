import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  clearSearchCache,
  initRoot,
  SEARCH_WORK,
  setSearchWorkLimits,
  Workspace,
} from '@agent-ops/core';
import { startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// The test process's own config path: nothing here may write to it.
const guard = mkdtempSync(join(tmpdir(), 'opsd-search-guard-'));
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
  const d = mkdtempSync(join(tmpdir(), 'opsd-search-'));
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
  const api = await startApi(sup, { port: 0, token: 'search-token', version: 't', build: '1' });
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: 'Bearer search-token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  return { sup, call, env: e, file, repo };
}

describe('search route', () => {
  it('answers words and filters, caps the limit, and refuses other methods', async () => {
    const { call, repo, env } = await setup();
    const ws = new Workspace({ cwd: repo, env, actor: 'human:dawid' });
    ws.newTask({ title: 'Tray icon', body: 'status light' });
    ws.newTask({ title: 'Search bar' });
    let res = await call('GET', `/api/search?q=${encodeURIComponent('light')}`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      hits: [{ kind: 'task', ref: 'test/T-0001', field: 'description' }],
      partial: false,
    });
    res = await call('GET', `/api/search?q=${encodeURIComponent('is:open')}&limit=1`);
    expect(res.data.hits).toHaveLength(1);
    res = await call('GET', '/api/search');
    expect(res.data).toEqual({ hits: [], partial: false });
    // Only the first 500 characters count: the word after them is dropped, so tray still matches.
    const long = `tray${' '.repeat(496)}zzzz`;
    res = await call('GET', `/api/search?q=${encodeURIComponent(long)}`);
    expect(res.data.hits).toMatchObject([{ ref: 'test/T-0001' }]);
    // A limit above 200 is capped, not refused; below 1 falls back to the default.
    res = await call('GET', `/api/search?q=${encodeURIComponent('is:open')}&limit=5000`);
    expect(res.status).toBe(200);
    expect(res.data.hits).toHaveLength(2);
    res = await call('GET', `/api/search?q=${encodeURIComponent('is:open')}&limit=0`);
    expect(res.data.hits).toHaveLength(2);
    res = await call('POST', '/api/search', {});
    expect(res.status).toBe(404);
  });

  it('passes Workspace.searchResult at most 500 characters and a limit of exactly 200', async () => {
    const { call } = await setup();
    const spy = vi.spyOn(Workspace.prototype, 'searchResult');
    try {
      await call('GET', `/api/search?q=${encodeURIComponent('x'.repeat(800))}&limit=5000`);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toBe('x'.repeat(500));
      expect(spy.mock.calls[0]![1]).toEqual({ limit: 200 });
      await call('GET', `/api/search?q=y&limit=0`);
      expect(spy.mock.calls[1]![1]).toEqual({ limit: 50 });
      await call('GET', `/api/search?q=y&limit=7`);
      expect(spy.mock.calls[2]![1]).toEqual({ limit: 7 });
    } finally {
      spy.mockRestore();
    }
  });

  it('says when a request reached its work budget', async () => {
    const { call, repo, env } = await setup();
    const ws = new Workspace({ cwd: repo, env, actor: 'human:dawid' });
    for (let i = 0; i < 30; i++) ws.newTask({ title: `Heron ${i}` });
    setSearchWorkLimits({ ops: 60, bytes: 1024 * 1024 });
    clearSearchCache();
    try {
      const res = await call('GET', `/api/search?q=heron&limit=200`);
      expect(res.status).toBe(200);
      expect(res.data.partial).toBe(true);
      expect((res.data.hits as unknown[]).length).toBeLessThan(30);
    } finally {
      setSearchWorkLimits(SEARCH_WORK);
    }
  });

  it('refuses a query with too many words with 400', async () => {
    const { call } = await setup();
    const words = Array.from({ length: 17 }, (_, i) => `w${i}`).join(' ');
    const res = await call('GET', `/api/search?q=${encodeURIComponent(words)}`);
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/at most 16/);
  });

  it('opens a channel at an old post in one root', async () => {
    const { call, repo, env } = await setup();
    let now = Date.parse('2026-10-01T00:00:00Z');
    const ws = new Workspace({ cwd: repo, env, actor: 'human:dawid', now: () => now });
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) {
      now += 1000;
      ids.push(ws.post('general', `post ${i}`).id);
    }
    const latest = await call('GET', '/api/channels/general?limit=200');
    expect(latest.data).toHaveLength(200);
    expect((latest.data as unknown as Array<{ id: string }>).map((m) => m.id)).not.toContain(
      ids[5],
    );
    const res = await call('GET', `/api/channels/general?limit=200&root=test&around=${ids[5]}`);
    expect(res.status).toBe(200);
    const got = res.data as unknown as Array<{ id: string; root: string }>;
    expect(got).toHaveLength(200);
    expect(got.map((m) => m.id)).toContain(ids[5]);
    expect(got.every((m) => m.root === 'test')).toBe(true);
    const missing = await call('GET', '/api/channels/general?root=nowhere');
    expect(missing.status).toBe(400);
  });
});
