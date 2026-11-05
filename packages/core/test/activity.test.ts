import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearActivityCache, parseActivityQuery, Root } from '../src/index.js';
import { setup } from './helpers.js';

/** A clock one minute ahead on every call, so every event has its own time. */
function ticking(start = '2026-10-01T08:00:00Z'): () => number {
  let t = Date.parse(start);
  return () => (t += 60_000);
}

/** Moves every file and folder under `dir` an hour back, so the index trusts their stamps. */
function age(dir: string): void {
  const past = new Date(Date.now() - 3_600_000);
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    utimesSync(join(e.parentPath, e.name), past, past);
  }
  utimesSync(dir, past, past);
}

beforeEach(() => clearActivityCache());

describe('activity query', () => {
  it('parses filters with the search bar rules and keeps unknown ones as words', () => {
    const q = parseActivityQuery(
      'Login "the page" agent:codex task:AO-0061 kind:reviews type:verdict channel:#dev in:posts status:x kind:nope',
    );
    expect(q).toMatchObject({
      words: ['login', 'the page', 'status:x', 'kind:nope'],
      agents: ['codex'],
      task: ['ao-0061'],
      kinds: ['review'],
      type: ['verdict'],
      channel: ['dev'],
      in: ['channel'],
    });
    expect(parseActivityQuery('"agent:codex"').words).toEqual(['agent:codex']);
    expect(() =>
      parseActivityQuery(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')),
    ).toThrow(/at most/);
  });
});

describe('activity feed', () => {
  it('pages through the whole history, archived tasks included, each item once', () => {
    const clock = ticking();
    const { as } = setup();
    const h = as('human:dawid', { now: clock });
    for (let i = 1; i <= 6; i++) {
      h.newTask({ title: `task ${i}` });
      h.comment(String(i), `note ${i}`);
    }
    h.done('1');
    h.post('general', 'hello');
    const later = Date.parse('2026-12-01T00:00:00Z');
    expect(as('human:dawid', { now: () => later }).archive()).toEqual(['T-0001']);

    const ws = as('human:dawid');
    const everything = ws.activityPage({ limit: 1000 });
    // 6 created, 6 comments, 1 done, 1 post.
    expect(everything.total).toBe(14);
    expect(everything.next).toBeNull();
    const archived = everything.items.filter((i) => i.task === 'T-0001' && i.kind === 'task');
    expect(archived.map((i) => i.type)).toEqual(['done', 'comment', 'created']);
    expect(archived.every((i) => i.archived)).toBe(true);

    const seen: string[] = [];
    let before: string | undefined;
    for (let n = 0; n < 10; n++) {
      const page = ws.activityPage({ limit: 4, before });
      seen.push(...page.items.map((i) => `${i.kind}:${i.id}`));
      if (!page.next) break;
      before = page.next;
    }
    expect(seen).toEqual(everything.items.map((i) => `${i.kind}:${i.id}`));
    expect(new Set(seen).size).toBe(14);
  });

  it('filters by words, agent, task, kind, type, project, channel and kind of item', () => {
    const clock = ticking();
    const { as } = setup();
    const h = as('human:dawid', { now: clock });
    h.newTask({ title: 'Login page', project: 'site', owner: 'claude:engineer' });
    h.newTask({ title: 'Billing', project: 'api' });
    const c = as('claude:engineer', { now: clock });
    c.start('1', 'plan');
    c.review('1', 'ready for a look', 'codex:qa');
    as('codex:qa', { now: clock }).verdict('1', 'approve', 'looks right');
    h.comment('2', 'Invoices round down', 'claude:engineer');
    c.post('general', 'shipping the login fix', { task: 'T-0001' });

    const ws = as('human:dawid');
    const types = (q: string): string[] =>
      ws.activityPage({ q }).items.map((i) => `${i.type}:${i.task ?? ''}`);
    expect(types('login')).toEqual([
      'post:T-0001',
      'verdict:T-0001',
      'review:T-0001',
      'start:T-0001',
      'claim:T-0001',
      'created:T-0001',
    ]);
    expect(types('"round down"')).toEqual(['comment:T-0002']);
    expect(types('kind:review')).toEqual(['verdict:T-0001', 'review:T-0001']);
    expect(types('type:verdict type:created project:api')).toEqual(['created:T-0002']);
    expect(types('task:2')).toEqual(['comment:T-0002', 'created:T-0002']);
    // `agent:` matches who acted or who it was addressed to.
    expect(types('agent:codex')).toEqual(['verdict:T-0001', 'review:T-0001']);
    expect(types('agent:claude:engineer in:tasks kind:talk')).toEqual(['comment:T-0002']);
    expect(types('in:posts')).toEqual(['post:T-0001']);
    expect(types('channel:general fix')).toEqual(['post:T-0001']);
    expect(types('root:other')).toEqual([]);
    const page = ws.activityPage({ q: 'login', limit: 2 });
    expect(page).toMatchObject({ total: 6 });
    expect(ws.activityPage({ q: 'login', limit: 2, before: page.next! }).items).toHaveLength(2);
    expect(page.actors).toEqual(['claude:engineer', 'codex:qa', 'human:dawid']);
    expect(page.projects).toEqual(['api', 'site']);
  });

  it('searches the whole body and clips only the preview it returns', () => {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Long notes' });
    const filler = 'lorem ipsum '.repeat(200);
    h.comment('1', `${filler}needle-in-comment`);
    h.post('general', `${filler}needle-in-post`);
    // Old stamps: a fresh process then trusts .ops/activity.json instead of the files.
    age(rootDir);

    const ws = as('human:dawid');
    const comment = ws.activityPage({ q: 'needle-in-comment' }).items;
    expect(comment.map((i) => i.type)).toEqual(['comment']);
    expect(comment[0]!.body.length).toBeLessThanOrEqual(240);
    expect(comment[0]!.body.endsWith('…')).toBe(true);
    const post = ws.activityPage({ q: 'needle-in-post' }).items;
    expect(post.map((i) => i.type)).toEqual(['post']);
    expect(post[0]!.body.length).toBeLessThanOrEqual(240);
    // Warm: the in-memory index still holds the whole body.
    expect(ws.activityPage({ q: 'needle-in-comment' }).items).toHaveLength(1);
    // Cold: the body survives the round trip through .ops/activity.json.
    clearActivityCache();
    expect(as('human:dawid').activityPage({ q: 'needle-in-post' }).items).toHaveLength(1);
  });

  it('leaves out lease renewals and refuses a bad cursor', () => {
    const { as, rootDir } = setup();
    as('human:dawid').newTask({ title: 'x' });
    new Root(rootDir).appendEvent('T-0001', {
      type: 'renew',
      actor: 'claude:engineer',
      at: new Date().toISOString(),
      body: '',
    });
    const ws = as('human:dawid');
    expect(ws.activityPage().items.map((i) => i.type)).toEqual(['created']);
    expect(() => ws.activityPage({ before: 'nonsense' })).toThrow(/bad cursor/);
  });

  it('keeps an index in .ops, reads only what changed, and rebuilds it from the files', () => {
    const clock = ticking();
    const { as, rootDir } = setup();
    const h = as('human:dawid', { now: clock });
    h.newTask({ title: 'Old title' });
    h.comment('1', 'first');
    age(rootDir);
    const file = join(rootDir, '.ops', 'activity.json');
    expect(h.activityPage().total).toBe(2);
    expect(existsSync(file)).toBe(true);

    // A fresh process trusts the index for folders whose stamps match: an edit in the index
    // shows, which proves the event file was not read again.
    clearActivityCache();
    const index = readFileSync(file, 'utf8');
    writeFileSync(file, index.replace('"body":"first"', '"body":"from the index"'));
    const fresh = as('human:dawid');
    expect(fresh.activityPage().items.map((i) => i.body)).toContain('from the index');

    // New events and a changed title show on the next read.
    fresh.comment('1', 'second');
    const md = join(rootDir, 'tasks', 'T-0001', 'task.md');
    writeFileSync(md, readFileSync(md, 'utf8').replace('Old title', 'New title'));
    const items = fresh.activityPage().items;
    expect(items.map((i) => i.body)).toEqual(['second', 'from the index', '']);
    expect(new Set(items.map((i) => i.title))).toEqual(new Set(['New title']));

    // A damaged or missing index is rebuilt from the files.
    clearActivityCache();
    writeFileSync(file, '{not json');
    expect(fresh.activityPage().items.map((i) => i.body)).toEqual(['second', 'first', '']);
    clearActivityCache();
    writeFileSync(file, JSON.stringify({ v: 999 }));
    expect(fresh.activityPage().total).toBe(3);
  });

  it('drops tasks and posts whose files are gone', () => {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'kept' });
    h.newTask({ title: 'removed' });
    h.post('general', 'gone soon');
    expect(h.activityPage().total).toBe(3);
    rmSync(join(rootDir, 'tasks', 'T-0002'), { recursive: true, force: true });
    rmSync(join(rootDir, 'channels', 'general'), { recursive: true, force: true });
    expect(h.activityPage().items.map((i) => i.task)).toEqual(['T-0001']);
  });

  it('stays fast with ten thousand events', () => {
    const { as, rootDir } = setup();
    const root = new Root(rootDir);
    const h = as('human:dawid');
    const tasks = 100;
    const per = 100;
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let t = 1; t <= tasks; t++) {
      const id = h.newTask({ title: `bulk ${t}` }).id;
      for (let e = 0; e < per; e++) {
        const at = base + (t * per + e) * 1000;
        root.appendEvent(
          id,
          { type: 'comment', actor: 'codex:qa', at: new Date(at).toISOString(), body: `body ${e}` },
          at,
        );
      }
    }
    age(rootDir);
    const ws = as('human:dawid');
    expect(ws.activityPage({ limit: 1 }).total).toBe(tasks * (per + 1));
    // Warm: the index is in memory, so a page or a search is a scan, not a read of the files.
    let t0 = performance.now();
    const page = ws.activityPage({ limit: 100 });
    ws.activityPage({ limit: 100, before: page.next! });
    ws.activityPage({ q: '"body 42" agent:codex' });
    const warm = performance.now() - t0;
    expect(warm).toBeLessThan(500);
    // Cold, from the index file in a fresh process: no event file is read.
    clearActivityCache();
    t0 = performance.now();
    expect(ws.activityPage({ q: 'task:7 "body 9"' }).total).toBe(11);
    expect(performance.now() - t0).toBeLessThan(2000);
  }, 120_000);
});
