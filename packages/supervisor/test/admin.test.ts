import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRoot, Root, Workspace } from '@agent-ops/core';
import type { RunRecord } from '../src/index.js';
import { nextRun, startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// The test process's own config path: opsd must edit the config its env names, never this one.
const guard = mkdtempSync(join(tmpdir(), 'opsd-admin-guard-'));
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
afterEach(() => {
  expect(existsSync(processConfig), 'an edit went to the process config').toBe(false);
});

afterEach(async () => {
  for (const s of sups.splice(0)) {
    s.stop({ killRuns: true });
    await s.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-admin-'));
  dirs.push(d);
  return d;
}

const CONFIG = (agentFile: string): string =>
  [
    '# my notes stay',
    'me: human:dawid',
    'opsd:',
    '  sync: false # no pushes in tests',
    '  runtimes:',
    '    fake:',
    `      command: ${JSON.stringify(process.execPath)}`,
    `      args: [${JSON.stringify(agentFile)}]`,
    '',
  ].join('\n');

/** opsd on a scratch root whose user config is a real file the API edits. */
async function setup() {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const agentFile = join(temp(), 'agent.mjs');
  // Reads the prompt and ends: enough for a scheduled run.
  writeFileSync(agentFile, 'for await (const c of process.stdin) {}\n');
  const userConfig = join(temp(), 'config.yml');
  writeFileSync(userConfig, CONFIG(agentFile));
  const env = {
    ...process.env,
    OPS_CONFIG: userConfig,
    OPS_STATE_DIR: temp(),
  } as NodeJS.ProcessEnv;
  delete env.OPS_AGENT;
  delete env.OPS_ROOTS;
  const sup = new Supervisor({ env, cwd: repo, freeMem: () => 64 * 2 ** 30 });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'admin-token', version: 't', build: '42' });
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown> & { error?: string };
    return { status: res.status, data };
  };
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {} });
  return { repo, sup, api, call, as, userConfig };
}

describe('desktop admin api', () => {
  it('stores a webhook without showing it, tests it, and posts each new ask once', async () => {
    const { sup, api, call, as, userConfig } = await setup();
    const got: string[] = [];
    const hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push(body);
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/secret-hook`;
    try {
      expect(
        (
          await call('POST', '/api/settings', {
            patch: { notify: { webhook: 'http://example.com/x' } },
          })
        ).status,
      ).toBe(400);
      let res = await call('POST', '/api/settings', { patch: { notify: { webhook: url } } });
      expect(res.status).toBe(200);
      // The settings answer says a webhook is set, never which.
      expect(JSON.stringify(res.data)).not.toContain('secret-hook');
      expect(res.data).toMatchObject({ notify: { webhook: true } });
      expect(readFileSync(userConfig, 'utf8')).toContain('secret-hook');
      res = await call('POST', '/api/notify/test', {});
      expect(res.data).toEqual({ ok: true });
      expect(got).toHaveLength(1);

      as('human:dawid').newTask({ title: 'needs an answer', owner: 'fake:engineer' });
      await sup.tick();
      as('fake:engineer').ask('T-0001', 'Which color?');
      await sup.tick();
      await new Promise((r) => setTimeout(r, 300));
      await sup.tick();
      await new Promise((r) => setTimeout(r, 300));
      const asks = got.filter((b) => b.includes('Which color?'));
      expect(asks).toHaveLength(1);
      // The question itself is the ask line: it is not sent a second time as a message.
      const waits = () => got.filter((b) => b.includes('T-0001 ask:')).length;
      expect(waits()).toBe(1);
      // A second ask on the same task is a new round: it is sent too.
      as('human:dawid').answer('T-0001', 'Blue');
      as('fake:engineer').start('T-0001', 'again');
      as('fake:engineer').ask('T-0001', 'Which shade?');
      await sup.tick();
      await new Promise((r) => setTimeout(r, 300));
      expect(waits()).toBe(2);
      // A block on the human after an answered ask is a new round too, sent with its own text.
      as('human:dawid').answer('T-0001', 'Navy');
      as('fake:engineer').start('T-0001', 'again');
      as('fake:engineer').block('T-0001', 'Where is the logo file?', { to: 'human:dawid' });
      await sup.tick();
      await new Promise((r) => setTimeout(r, 300));
      expect(waits()).toBe(3);
      expect(got.filter((b) => b.includes('Where is the logo file?'))).toHaveLength(1);
      res = await call('POST', '/api/settings', { patch: { notify: { webhook: null } } });
      expect(readFileSync(userConfig, 'utf8')).not.toContain('secret-hook');
    } finally {
      await new Promise((r) => hook.close(r));
      await api.close();
    }
  });

  it('sets the Master Repo and turns mirroring on for a project root', async () => {
    const { repo, api, call, userConfig } = await setup();
    try {
      const hub = temp();
      execFileSync('git', ['init', '-q'], { cwd: hub, windowsHide: true });
      initRoot(hub, { name: 'hub', prefix: 'HUB', human: 'human:dawid' });
      expect((await call('POST', '/api/settings', { patch: { master: 5 } })).status).toBe(400);
      let res = await call('POST', '/api/settings', { patch: { master: hub } });
      expect(res.status).toBe(200);
      expect(readFileSync(userConfig, 'utf8')).toContain('# my notes stay');
      const view = res.data as unknown as {
        master: string;
        rootList: Array<{ name: string; mirror: boolean; isMaster: boolean; isMirror: boolean }>;
      };
      expect(view.master).toBeTruthy();
      expect(view.rootList.map((r) => [r.name, r.isMaster, r.mirror])).toEqual(
        expect.arrayContaining([
          ['test', false, false],
          ['hub', true, false],
        ]),
      );
      expect((await call('POST', '/api/roots/test/mirror', { on: 'yes' })).status).toBe(400);
      expect((await call('POST', '/api/roots/hub/mirror', { on: true })).status).toBe(400);
      expect((await call('POST', '/api/roots/nope/mirror', { on: true })).status).toBe(400);
      res = await call('POST', '/api/roots/test/mirror', { on: true });
      expect(res.status).toBe(200);
      expect(readFileSync(join(repo, '.agent-ops', 'config.yml'), 'utf8')).toMatch(
        /^mirror: true$/m,
      );
      res = await call('POST', '/api/roots/test/mirror', { on: false });
      expect(readFileSync(join(repo, '.agent-ops', 'config.yml'), 'utf8')).not.toMatch(/mirror:/);
      res = await call('POST', '/api/settings', { patch: { master: null } });
      expect((res.data as unknown as { master: string | null }).master).toBeNull();
    } finally {
      await api.close();
    }
  });

  it('searches learn notes and retypes a finding', async () => {
    const { api, call, as } = await setup();
    try {
      const eng = as('claude:engineer');
      eng.learn({ topic: 'git', title: 'Rebase before merge', body: 'Run git rebase first.' });
      eng.learn({ topic: 'windows', title: 'Paths', body: 'Use forward slashes.' });
      let res = await call('GET', '/api/kb');
      const all = res.data as unknown as Array<{ ref: string; file?: string; body: string }>;
      expect(all.map((n) => n.ref).sort()).toEqual(['git/rebase-before-merge', 'windows/paths']);
      expect(all.every((n) => n.file === undefined)).toBe(true);
      res = await call('GET', '/api/kb?q=rebase%20first');
      expect((res.data as unknown as Array<{ ref: string }>).map((n) => n.ref)).toEqual([
        'git/rebase-before-merge',
      ]);
      res = await call('GET', '/api/kb?topic=windows');
      expect((res.data as unknown as unknown[]).length).toBe(1);
      // Words split on whitespace: no note has "sss", so nothing matches (a split on the letter s
      // would leave no words and list every note).
      res = await call('GET', '/api/kb?q=sss');
      expect(res.data).toEqual([]);
      res = await call('GET', '/api/kb?q=forward%20%20slashes');
      expect((res.data as unknown as Array<{ ref: string }>).map((n) => n.ref)).toEqual([
        'windows/paths',
      ]);
      res = await call('GET', '/api/kb/git/rebase-before-merge');
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ ref: 'git/rebase-before-merge', root: 'test' });
      expect(res.data.file).toBeUndefined();
      res = await call('GET', '/api/kb/git/rebase-before-merge?root=test');
      expect(res.status).toBe(200);
      expect((await call('GET', '/api/kb/git/nope')).status).toBe(400);
      expect((await call('GET', '/api/kb/..%2F..%2Fx/y')).status).toBe(400);
      expect((await call('GET', '/api/kb/git')).status).toBe(404);

      eng.finding({ title: 'flaky test' });
      res = await call('POST', '/api/tasks/T-0001/retype', {
        as: 'claude:engineer',
        type: 'bug',
      });
      expect(res.status).toBe(409);
      res = await call('POST', '/api/tasks/T-0001/retype', {
        as: 'human:dawid',
        type: 'bug',
        to: 'claude:engineer',
      });
      expect(res.status).toBe(200);
      // Retype and assign land in one write.
      expect(res.data).toMatchObject({ task: { type: 'bug', owner: 'claude:engineer' } });
      expect((res.data.events as Array<{ type: string }>).map((e) => e.type)).toEqual([
        'retype',
        'assign',
      ]);
    } finally {
      await api.close();
    }
  });

  it('pages the activity feed with a cursor and filters it with a query', async () => {
    const { api, call, as } = await setup();
    try {
      const h = as('human:dawid');
      h.newTask({ title: 'first', project: 'site' });
      h.newTask({ title: 'second' });
      h.comment('1', 'about the login page');
      h.comment('2', 'unrelated');
      type Page = { items: Array<{ id: string; task?: string }>; next: string | null };
      const one = (await call('GET', '/api/activity?limit=2')).data as unknown as Page;
      expect(one.items).toHaveLength(2);
      expect(one.next).toBeTruthy();
      const two = (
        await call('GET', `/api/activity?limit=2&before=${encodeURIComponent(one.next!)}`)
      ).data as unknown as Page;
      expect(two.items).toHaveLength(2);
      expect(two.next).toBeNull();
      expect(two.items.map((i) => i.id)).not.toContain(one.items[0]!.id);
      const found = await call('GET', `/api/activity?q=${encodeURIComponent('login task:1')}`);
      expect(found.data).toMatchObject({ total: 1, items: [{ task: 'T-0001' }] });
      expect((await call('GET', '/api/activity?before=nonsense')).status).toBe(400);
    } finally {
      await api.close();
    }
  });

  it('creates an idea from New task: unowned, listed, and out of every queue', async () => {
    const { api, call, as } = await setup();
    try {
      let res = await call('POST', '/api/tasks', {
        title: 'Search across roots',
        body: 'Later, maybe.',
        type: 'idea',
        priority: 'p2',
      });
      expect(res.status).toBe(201);
      expect(res.data).toMatchObject({ id: 'T-0001', type: 'idea', status: 'todo', owner: null });
      res = await call('POST', '/api/tasks', { title: 'Real work', to: 'claude:engineer' });
      expect(res.status).toBe(201);

      res = await call('GET', '/api/tasks');
      const listed = res.data as unknown as Array<{ id: string; type: string }>;
      expect(listed.map((t) => `${t.id}:${t.type}`).sort()).toEqual(['T-0001:idea', 'T-0002:task']);
      const eng = as('claude:engineer');
      expect(eng.queue().map((v) => v.meta.id)).toEqual(['T-0002']);
      expect(as('codex:engineer').queue()).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it('reports the build opsd started with', async () => {
    const { api, call } = await setup();
    try {
      expect((await call('GET', '/api/health')).data).toMatchObject({ build: '42' });
      expect(Array.isArray((await call('GET', '/api/activity?limit=5')).data.items)).toBe(true);
      expect((await call('GET', '/api/activity?limit=1.5')).status).toBe(200);
      expect((await call('GET', '/api/report?days=7')).data).toMatchObject({ totals: { runs: 0 } });
      expect((await call('GET', '/api/report?days=0')).status).toBe(400);
      expect((await call('GET', '/api/report?days=1.5')).status).toBe(400);
      expect((await call('GET', '/api/report?from=2026-11-01&to=2026-11-02')).status).toBe(200);
      expect((await call('GET', '/api/machines')).data).toEqual([]);
      const checks = (await call('GET', '/api/doctor')).data as unknown as Array<{
        id: string;
        status: string;
        detail: string;
      }>;
      // opsd checks itself without calling its own API, on the config its env names.
      expect(checks.find((c) => c.id === 'opsd')).toMatchObject({
        status: 'ok',
        detail: expect.stringContaining('build 42'),
      });
      expect(checks.find((c) => c.id === 'config')?.status).toBe('ok');
      expect(checks.find((c) => c.id === 'runtime:fake')?.status).toBe('warn');
    } finally {
      await api.close();
    }
  });

  it('changes safe settings in the user config, keeping comments, and reloads them', async () => {
    const { sup, api, call, userConfig } = await setup();
    try {
      const before = (await call('GET', '/api/settings')).data as {
        me: string;
        opsd: { review_backlog: number; roles: Record<string, { per_project: number }> };
      };
      expect(before.me).toBe('human:dawid');
      expect(before.opsd.review_backlog).toBe(3);
      expect(before.opsd.roles.qa!.per_project).toBe(3);

      const res = await call('POST', '/api/settings', {
        patch: {
          opsd: {
            max_runs: 3,
            roles: { qa: { per_project: 5 } },
            runtimes: { fake: { max_live: 2 } },
            agents: { 'fake:engineer': { wake: true, budget: '90m' } },
          },
        },
      });
      expect(res.status).toBe(200);
      expect(sup.config.max_runs).toBe(3);
      expect(sup.config.roles.qa).toEqual({ per_project: 5 });
      expect(sup.config.runtimes.fake!.max_live).toBe(2);
      expect(sup.config.agents['fake:engineer']).toEqual({ wake: true, budget: '90m' });
      const text = readFileSync(userConfig, 'utf8');
      expect(text).toContain('# my notes stay');
      expect(text).toContain('sync: false # no pushes in tests');

      // null puts the default back.
      await call('POST', '/api/settings', { patch: { opsd: { max_runs: null } } });
      expect(readFileSync(userConfig, 'utf8')).not.toContain('max_runs');
    } finally {
      await api.close();
    }
  });

  it('refuses runtime commands, unknown keys and bad values, and writes nothing then', async () => {
    const { sup, api, call, userConfig } = await setup();
    try {
      const original = readFileSync(userConfig, 'utf8');
      const refused = [
        { opsd: { runtimes: { fake: { command: 'calc.exe' } } } },
        { opsd: { runtimes: { evil: { max_live: 1 } } } },
        { opsd: { agents: { 'fake:engineer': { cwd: 'C:/' } } } },
        { opsd: { port: 1 } },
        { opsd: { max_runs: -1 } },
        { opsd: { review_backlog: 'lots' } },
        { opsd: { usage_pause_at: 2 } },
        { opsd: { roles: { qa: { per_project: 1.5 } } } },
        { opsd: { agents: { 'fake:engineer': { budget: 90 } } } },
        { opsd: { agents: { 'fake:engineer': { budget: 'soon' } } } },
        { me: 'human:else' },
        { roots: [temp()] },
      ];
      for (const patch of refused) {
        const res = await call('POST', '/api/settings', { patch });
        expect(res.status, JSON.stringify(patch)).toBe(400);
      }
      expect(readFileSync(userConfig, 'utf8')).toBe(original);
      expect(sup.config.runtimes.fake!.command).toBe(process.execPath);
    } finally {
      await api.close();
    }
  });

  it('adds, changes, pauses, runs and deletes schedules', async () => {
    const { sup, api, call, userConfig } = await setup();
    try {
      let res = await call('POST', '/api/schedules', {
        name: 'standup',
        agent: 'fake:pm',
        at: '09:00',
        prompt: 'Post your standup to #standup.',
      });
      expect(res.status).toBe(200);
      expect(sup.config.schedules).toEqual([
        {
          name: 'standup',
          agent: 'fake:pm',
          at: '09:00',
          prompt: 'Post your standup to #standup.',
        },
      ]);
      expect(readFileSync(userConfig, 'utf8')).toContain('# my notes stay');

      // A second schedule with the same name is refused; renaming one keeps a single entry.
      res = await call('POST', '/api/schedules', {
        name: 'standup',
        agent: 'fake:pm',
        every: '1h',
      });
      expect(res.status).toBe(400);
      res = await call('POST', '/api/schedules', {
        previous: 'standup',
        name: 'daily-standup',
        agent: 'fake:pm',
        at: '09:30',
        paused: true,
      });
      expect(res.status).toBe(200);
      const list = res.data as unknown as Array<{ name: string; paused?: boolean; next_run: null }>;
      expect(list).toEqual([expect.objectContaining({ name: 'daily-standup', paused: true })]);
      expect(list[0]!.next_run).toBeNull();
      // Neither every nor at: refused by the config check, nothing written.
      res = await call('POST', '/api/schedules', { name: 'broken', agent: 'fake:pm' });
      expect(res.status).toBe(400);
      expect(sup.config.schedules).toHaveLength(1);

      res = await call('POST', '/api/schedules/daily-standup/run');
      expect(res.status).toBe(201);
      const run = res.data as unknown as RunRecord;
      expect(run).toMatchObject({ agent: 'fake:pm', schedule: 'daily-standup' });
      expect(sup.scheduleRuns()['daily-standup']).toBeTypeOf('number');

      res = await call('POST', '/api/schedules/daily-standup/delete');
      expect(res.data).toEqual([]);
      expect(sup.config.schedules).toEqual([]);
      res = await call('POST', '/api/schedules/daily-standup/delete');
      expect(res.status).toBe(400);
    } finally {
      await api.close();
    }
  });

  it('computes when a schedule starts next', () => {
    const now = new Date(2026, 10, 1, 10, 0).getTime();
    expect(nextRun({ name: 'a', agent: 'x:y', every: '30m' }, undefined, now)).toBe(now);
    expect(nextRun({ name: 'a', agent: 'x:y', every: '30m' }, now - 10 * 60_000, now)).toBe(
      now + 20 * 60_000,
    );
    // 09:00 already ran today: tomorrow at 09:00.
    const ranToday = new Date(2026, 10, 1, 9, 0).getTime();
    expect(nextRun({ name: 'a', agent: 'x:y', at: '09:00' }, ranToday, now)).toBe(
      new Date(2026, 10, 2, 9, 0).getTime(),
    );
    expect(nextRun({ name: 'a', agent: 'x:y', at: '11:00' }, ranToday, now)).toBe(
      new Date(2026, 10, 1, 11, 0).getTime(),
    );
    expect(nextRun({ name: 'a', agent: 'x:y', at: '11:00', paused: true }, 0, now)).toBeNull();
  });

  it('creates channels with a description and refuses duplicates', async () => {
    const { api, call } = await setup();
    try {
      let res = await call('POST', '/api/channels', {
        as: 'human:dawid',
        name: 'launch',
        description: 'Launch plan',
      });
      expect(res.status).toBe(201);
      expect(res.data).toMatchObject({ name: 'launch', messages: 0, description: 'Launch plan' });
      res = await call('GET', '/api/channels');
      expect(res.data).toEqual([expect.objectContaining({ name: 'launch', messages: 0 })]);
      res = await call('POST', '/api/channels', { as: 'human:dawid', name: 'launch' });
      expect(res.status).toBe(400);
      res = await call('POST', '/api/channels', { as: 'human:dawid', name: 'Bad Name' });
      expect(res.status).toBe(400);
      // Posting keeps the description.
      await call('POST', '/api/channels/launch', { as: 'human:dawid', message: 'hello' });
      res = await call('GET', '/api/channels');
      expect(res.data).toEqual([
        expect.objectContaining({ name: 'launch', messages: 1, description: 'Launch plan' }),
      ]);
    } finally {
      await api.close();
    }
  });

  it('starts, blocks and sends tasks for review from the task panel', async () => {
    const { api, call, as } = await setup();
    try {
      as('human:dawid').newTask({ title: 'mine' });
      let res = await call('POST', '/api/tasks/T-0001/start', { as: 'human:dawid' });
      expect(res.data).toMatchObject({ task: { status: 'in-progress', claimedBy: 'human:dawid' } });
      res = await call('POST', '/api/tasks/T-0001/block', { as: 'human:dawid', message: '' });
      expect(res.status).toBe(400);
      res = await call('POST', '/api/tasks/T-0001/block', {
        as: 'human:dawid',
        message: 'needs a key',
        to: 'claude:pm',
      });
      expect(res.data).toMatchObject({ task: { status: 'blocked', waitingOn: 'claude:pm' } });
      await call('POST', '/api/tasks/T-0001/unblock', { as: 'human:dawid' });
      await call('POST', '/api/tasks/T-0001/start', { as: 'human:dawid' });
      res = await call('POST', '/api/tasks/T-0001/review', {
        as: 'human:dawid',
        message: 'look',
        to: 'codex:qa',
      });
      expect(res.data).toMatchObject({ task: { status: 'needs-review', reviewer: 'codex:qa' } });
    } finally {
      await api.close();
    }
  });

  it('creates an agent subtask under an approved parent and proposes one without it', async () => {
    const { api, call, as } = await setup();
    try {
      as('human:dawid').newTask({ title: 'approved epic' });
      let res = await call('POST', '/api/tasks', {
        as: 'claude:engineer',
        title: 'breakdown step',
        parent: 'T-0001',
      });
      expect(res.status).toBe(201);
      expect(res.data).toMatchObject({ id: 'T-0002', type: 'task', createdBy: 'claude:engineer' });
      expect(res.data.proposed).toBeUndefined();
      expect(as('human:dawid').view('T-0002').meta.parent).toBe('T-0001');

      res = await call('POST', '/api/tasks', { as: 'claude:engineer', title: 'new idea of mine' });
      expect(res.status).toBe(201);
      expect(res.data).toMatchObject({ id: 'T-0003', type: 'finding' });
      expect(res.data.proposed).toMatch(/no --parent/);
    } finally {
      await api.close();
    }
  });

  it('builds a standup from the task events, runs and #standup posts', async () => {
    const { api, call, as, sup } = await setup();
    try {
      const human = as('human:dawid');
      human.newTask({ title: 'shipped', owner: 'fake:engineer' });
      human.newTask({ title: 'reviewed', owner: 'fake:engineer' });
      human.newTask({ title: 'ongoing', owner: 'fake:engineer' });
      human.newTask({ title: 'stuck', owner: 'fake:engineer' });
      const eng = as('fake:engineer');
      eng.start('T-0001');
      eng.done('T-0001', 'all green');
      eng.start('T-0002');
      eng.review('T-0002', 'please look', 'human:dawid');
      eng.start('T-0003');
      eng.checkpoint('T-0003', 'half way\nmore detail');
      eng.start('T-0004');
      eng.ask('T-0004', 'which key?');
      human.post('standup', 'Planned the week');
      const res = await call('GET', '/api/standup?hours=24');
      const s = res.data as unknown as {
        agents: Array<{
          agent: string;
          done: Array<{ task: string; note?: string }>;
          review: Array<{ task: string }>;
          working: Array<{ task: string; note?: string }>;
          blocked: Array<{ task: string; note?: string }>;
        }>;
        posts: Array<{ body: string }>;
      };
      const e = s.agents.find((a) => a.agent === 'fake:engineer')!;
      expect(e.done).toEqual([expect.objectContaining({ task: 'test/T-0001', note: 'all green' })]);
      expect(e.review).toEqual([expect.objectContaining({ task: 'test/T-0002' })]);
      expect(e.working).toEqual([
        expect.objectContaining({ task: 'test/T-0003', note: 'half way' }),
      ]);
      expect(e.blocked).toEqual([
        expect.objectContaining({ task: 'test/T-0004', note: 'waits on human:dawid' }),
      ]);
      expect(s.agents.map((a) => a.agent)).toContain('human:dawid');
      expect(s.posts.map((p) => p.body)).toEqual(['Planned the week']);
      // Approving the review counts as done for the author.
      human.verdict('T-0002', 'approve', 'good');
      const after = (await call('GET', '/api/standup?hours=24')).data as typeof s;
      const e2 = after.agents.find((a) => a.agent === 'fake:engineer')!;
      expect(e2.done.map((d) => d.task).sort()).toEqual(['test/T-0001', 'test/T-0002']);
      expect((await call('GET', '/api/standup?hours=0')).status).toBe(400);
      expect(sup.runs()).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it('refuses prototype-named settings keys and writes nothing', async () => {
    const { api, call, userConfig } = await setup();
    try {
      const original = readFileSync(userConfig, 'utf8');
      for (const raw of [
        '{"patch":{"opsd":{"__proto__":5}}}',
        '{"patch":{"opsd":{"constructor":5}}}',
        '{"patch":{"opsd":{"toString":5}}}',
        '{"patch":{"opsd":{"hasOwnProperty":5}}}',
      ]) {
        const res = await call('POST', '/api/settings', raw);
        expect(res.status, raw).toBe(400);
      }
      expect(readFileSync(userConfig, 'utf8')).toBe(original);
    } finally {
      await api.close();
    }
  });

  it('keeps a schedule entry and its comments when editing it, and refuses a bad paused', async () => {
    const { sup, api, call, userConfig } = await setup();
    try {
      writeFileSync(
        userConfig,
        readFileSync(userConfig, 'utf8') +
          [
            '  schedules:',
            '    # the morning one',
            '    - name: standup # keep me',
            '      agent: fake:pm',
            "      at: '09:00' # local time",
            '',
          ].join('\n'),
      );
      sup.reloadConfig();
      let res = await call('POST', '/api/schedules', {
        previous: 'standup',
        name: 'standup',
        agent: 'fake:pm',
        at: '10:00',
        paused: 'yes',
      });
      expect(res.status).toBe(400);
      const before = readFileSync(userConfig, 'utf8');
      expect(before).toContain("at: '09:00' # local time");

      res = await call('POST', '/api/schedules', {
        previous: 'standup',
        name: 'standup',
        agent: 'fake:pm',
        every: '2h',
        paused: true,
      });
      expect(res.status).toBe(200);
      const after = readFileSync(userConfig, 'utf8');
      expect(after).toContain('# the morning one');
      expect(after).toContain('name: standup # keep me');
      expect(sup.config.schedules).toEqual([
        { name: 'standup', agent: 'fake:pm', every: '2h', paused: true },
      ]);
    } finally {
      await api.close();
    }
  });

  it('splits block dependencies on spaces and commas, keeping root/id refs whole', async () => {
    const { api, call, as } = await setup();
    try {
      const human = as('human:dawid');
      human.newTask({ title: 'first' });
      human.newTask({ title: 'second' });
      human.newTask({ title: 'third' });
      const res = await call('POST', '/api/tasks/T-0003/block', {
        as: 'human:dawid',
        message: 'needs both',
        on: 'test/T-0001, test/T-0002',
      });
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({
        task: { status: 'blocked', blockedOn: ['T-0001', 'T-0002'] },
      });
    } finally {
      await api.close();
    }
  });

  it('credits an approval to the author, not to a claim that lost, and drops unblocked tasks', async () => {
    const { api, call, as, repo } = await setup();
    try {
      const human = as('human:dawid');
      human.newTask({ title: 'reviewed', owner: 'fake:engineer' });
      human.newTask({ title: 'dependency' });
      human.newTask({ title: 'waits on it' });
      const eng = as('fake:engineer');
      eng.start('T-0001');
      eng.review('T-0001', 'look', 'human:dawid');
      // A claim from another clone lands after the review and loses: it never held the work.
      const root = new Root(join(repo, '.agent-ops'));
      root.appendEvent('T-0001', {
        type: 'claim',
        actor: 'other:engineer',
        at: new Date().toISOString(),
        token: 'feedbeef',
        body: '',
      });
      expect(human.view('T-0001').lostClaims).toHaveLength(1);
      human.verdict('T-0001', 'approve', 'good');
      human.block('T-0003', 'after the dependency', { on: ['T-0002'] });
      human.done('T-0002');
      const s = (await call('GET', '/api/standup?hours=24')).data as unknown as {
        agents: Array<{ agent: string; done: Array<{ task: string }>; blocked: unknown[] }>;
      };
      const by = (id: string) => s.agents.find((a) => a.agent === id);
      expect(by('fake:engineer')!.done.map((d) => d.task)).toEqual(['test/T-0001']);
      expect(by('other:engineer')?.done ?? []).toEqual([]);
      expect(s.agents.flatMap((a) => a.blocked)).toEqual([]);
    } finally {
      await api.close();
    }
  });
});
