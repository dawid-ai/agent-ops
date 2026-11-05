import {
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actorMatches,
  clearSearchCache,
  SEARCH_CACHE_BYTES,
  SearchCache,
  searchCacheStats,
  setSearchCacheLimit,
  emptyQuery,
  initRoot,
  MAX_TOKENS,
  MAX_WORDS,
  OpsError,
  parseQuery,
  resetSearchWork,
  runSearch,
  searchWork,
  snippet,
  tokenize,
  wantedKinds,
  Workspace,
} from '../src/index.js';
import { gitRepo, setup } from './helpers.js';

describe('search queries', () => {
  it('splits words, phrases and filters; unknown keys stay words', () => {
    const q = parseQuery(
      'Tray "go with 3" agent:Codex status:blocked is:open in:notes project:v2 claude:engineer http://x',
    );
    expect(q.words).toEqual(['tray', 'go with 3', 'claude:engineer', 'http://x']);
    expect(q.agents).toEqual(['codex']);
    expect(q.status).toEqual(['blocked']);
    expect(q.open).toBe(true);
    expect(q.kinds).toEqual(['note']);
    expect(q.project).toEqual(['v2']);
    expect(parseQuery('is:closed').open).toBe(false);
    expect(parseQuery('in:nowhere').words).toEqual(['in:nowhere']);
    expect(parseQuery('agent:').words).toEqual(['agent:']);
    expect(emptyQuery(parseQuery('   '))).toBe(true);
    expect(emptyQuery(parseQuery('who:qa'))).toBe(false);
  });

  it('matches agents by full id, runtime, role, name or wildcard', () => {
    expect(actorMatches('codex:qa', 'codex:qa')).toBe(true);
    expect(actorMatches('codex:qa', 'codex')).toBe(true);
    expect(actorMatches('codex:qa', 'qa')).toBe(true);
    expect(actorMatches('human:dawid', 'dawid')).toBe(true);
    expect(actorMatches('codex:qa', 'codex:*')).toBe(true);
    expect(actorMatches('claude:qa', '*:qa')).toBe(true);
    expect(actorMatches('claude:qa', 'codex:qa')).toBe(false);
    expect(actorMatches('claude:engineer', 'eng')).toBe(false);
    expect(actorMatches(null, 'qa')).toBe(false);
  });

  it('cuts a snippet around the first match', () => {
    const long = `${'a '.repeat(200)}needle ${'b '.repeat(200)}`;
    const s = snippet(long, ['needle'], 60);
    expect(s).toContain('needle');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(snippet('short\n text', ['x'])).toBe('short text');
  });
});

describe('workspace search', () => {
  function world() {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Tray icon for opsd', body: 'Show the state in the notification area.' });
    h.newTask({ title: 'Search bar', body: 'Find things by text.', type: 'idea', project: 'v2' });
    h.newTask({ title: 'Release', body: 'Tag 2.0.0' });
    const c = as('claude:engineer');
    c.start('1');
    c.review('1', 'Ready: the tray draws a status light.', 'codex:qa');
    as('codex:qa').verdict('1', 'approve', 'Checked the shallow merge fix too.');
    c.start('2');
    c.ask('2', 'Should Ctrl+F focus it?');
    h.answer('2', 'Yes, go with Ctrl+F');
    c.learn({ topic: 'windows', title: 'Tray icons need a bitmap', body: 'No icon file ships.' });
    c.post('general', 'The tray build is up for review @codex:qa');
    as('claude:orchestrator').propose({
      question: 'Tray colour?',
      options: ['green', 'blue'],
      voters: ['claude:engineer', 'codex:qa'],
    });
    return { h, as };
  }

  it('finds tasks by id, title, description and thread, best first', () => {
    const { h } = world();
    const ids = (q: string) => h.search(q).map((x) => `${x.kind}:${x.ref}:${x.field}`);
    expect(h.search('2')[0]).toMatchObject({ kind: 'task', ref: 'test/T-0002', field: 'id' });
    expect(h.search('T-0003')[0]).toMatchObject({ ref: 'test/T-0003', field: 'id' });
    expect(ids('notification')).toEqual(['task:test/T-0001:description']);
    // Thread text, with who wrote it and the event to jump to.
    const hit = h.search('shallow merge')[0]!;
    expect(hit).toMatchObject({ ref: 'test/T-0001', field: 'thread', actor: 'codex:qa' });
    expect(hit.event).toMatch(/^[0-9A-Z]{26}$/);
    expect(hit.snippet).toContain('shallow merge');
    // Title matches outrank thread matches; every kind can match.
    const tray = h.search('tray');
    expect(tray[0]).toMatchObject({ kind: 'task', ref: 'test/T-0001', field: 'title' });
    expect(new Set(tray.map((x) => x.kind))).toEqual(new Set(['task', 'note', 'post', 'vote']));
    // Every word must match.
    expect(h.search('tray release')).toEqual([]);
  });

  it('narrows by agent, status, project, type, open and kind', () => {
    const { h } = world();
    const refs = (q: string) => h.search(q).map((x) => x.ref);
    expect(refs('agent:codex in:tasks')).toEqual(['test/T-0001']);
    expect(refs('agent:dawid "go with ctrl+f"')).toEqual(['test/T-0002']);
    expect(refs('status:done')).toEqual(['test/T-0001']);
    expect(refs('is:open').sort()).toEqual(['test/T-0002', 'test/T-0003']);
    expect(refs('project:v2 type:idea')).toEqual(['test/T-0002']);
    // Task-only filters leave notes, posts and votes out.
    expect(h.search('tray status:done').every((x) => x.kind === 'task')).toBe(true);
    expect(refs('in:notes tray')).toEqual(['windows/tray-icons-need-a-bitmap']);
    expect(refs('in:posts tray')).toEqual(['#general']);
    // A post matches the agents it mentions too.
    expect(refs('in:posts agent:codex:qa')).toEqual(['#general']);
    expect(refs('in:votes colour')).toEqual(['D-0001']);
    expect(h.search('')).toEqual([]);
  });

  it('sees events written after an earlier search', () => {
    const { h, as } = world();
    expect(h.search('zebra')).toEqual([]);
    as('claude:engineer').comment('3', 'zebra crossing');
    expect(h.search('zebra')[0]).toMatchObject({ ref: 'test/T-0003', field: 'thread' });
  });
});

describe('search review fixes (round 1)', () => {
  it('counts needs-review as open, and status:needs-review finds it', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Under review' });
    h.newTask({ title: 'Finished' });
    const c = as('claude:engineer');
    c.start('1');
    c.review('1', 'ready', 'codex:qa');
    h.done('2');
    const refs = (q: string) => h.search(q).map((x) => x.ref);
    expect(refs('is:open')).toEqual(['test/T-0001']);
    expect(refs('is:closed')).toEqual(['test/T-0002']);
    expect(refs('status:needs-review')).toEqual(['test/T-0001']);
  });

  it('searches the description, thread and people of archived tasks, and after a reopen', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const { as } = setup();
    const h = as('human:dawid', { now: () => now });
    h.newTask({ title: 'Old work', body: 'The walrus description.' });
    as('codex:qa', { now: () => now }).comment('1', 'A narwhal in the thread.');
    h.done('1');
    now += 40 * 86_400_000;
    expect(h.archive()).toEqual(['T-0001']);
    expect(h.search('walrus')[0]).toMatchObject({ ref: 'test/T-0001', field: 'description' });
    expect(h.search('narwhal')[0]).toMatchObject({ field: 'thread', actor: 'codex:qa' });
    expect(h.search('agent:codex').map((x) => x.ref)).toEqual(['test/T-0001']);
    h.reopen('1', 'back');
    expect(h.search('walrus')[0]).toMatchObject({ ref: 'test/T-0001', field: 'description' });
  });

  // Each test changes one thing a sync can change, with the cache warm, so each part of the
  // cache key is tested on its own.
  it('sees a rewritten task.md while the event files stay the same', () => {
    clearSearchCache();
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Cache', body: 'first words' });
    h.comment('1', 'kestrel');
    expect(h.search('first')[0]?.field).toBe('description');
    const events = join(rootDir, 'tasks', 'T-0001', 'events');
    const names = readdirSync(events);
    const taskFile = join(rootDir, 'tasks', 'T-0001', 'task.md');
    writeFileSync(taskFile, readFileSync(taskFile, 'utf8').replace('first words', 'second words'));
    expect(readdirSync(events)).toEqual(names);
    expect(h.search('first')).toEqual([]);
    expect(h.search('second')[0]?.field).toBe('description');
  });

  it('sees a renamed event with the same file count while task.md stays the same', () => {
    clearSearchCache();
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Cache', body: 'first words' });
    h.comment('1', 'kestrel');
    // Old files, so the first search caches the task; the folder's time is all that changes.
    age(rootDir);
    const first = h.search('kestrel')[0]!;
    const taskFile = join(rootDir, 'tasks', 'T-0001', 'task.md');
    const before = statSync(taskFile);
    const events = join(rootDir, 'tasks', 'T-0001', 'events');
    const count = readdirSync(events).length;
    const name = readdirSync(events).find((n) => n.startsWith(first.event!))!;
    const renamed = `01M00000000000000000000000${name.slice(26)}`;
    renameSync(join(events, name), join(events, renamed));
    // A rename one tick later, not a racy one: only the events folder's stamp shows it.
    const then = new Date(Date.now() - 1_800_000);
    utimesSync(events, then, then);
    expect(readdirSync(events)).toHaveLength(count);
    expect(statSync(taskFile).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(taskFile).size).toBe(before.size);
    expect(h.search('kestrel')[0]?.event).toBe('01M00000000000000000000000');
  });

  it('keeps the root of channel posts, so root: narrows posts too', () => {
    const { as, env } = setup();
    const otherRepo = gitRepo();
    initRoot(otherRepo, { name: 'other', human: 'human:dawid' });
    const both = (actor: string) =>
      as(actor, { user: { roots: [otherRepo] } as Record<string, unknown> });
    both('claude:engineer').post('general', 'heron in test');
    new Workspace({ cwd: otherRepo, env, actor: 'claude:engineer' }).post(
      'general',
      'heron in other',
    );
    const h = both('human:dawid');
    expect(
      h
        .search('heron in:posts')
        .map((x) => x.root)
        .sort(),
    ).toEqual(['other', 'test']);
    expect(h.search('heron root:other in:posts')).toMatchObject([
      { kind: 'post', root: 'other', snippet: 'heron in other' },
    ]);
  });

  it('loads only the sources a query can match', () => {
    const { as } = setup();
    const ws = as('human:dawid');
    const boom = (what: string) => () => {
      throw new Error(`${what} was read`);
    };
    const src = {
      roots: ws.roots,
      tasks: boom('tasks'),
      notes: () => [],
      posts: boom('posts'),
      decisions: boom('decisions'),
    };
    expect(runSearch(src, parseQuery('x in:notes'))).toEqual([]);
    expect(() => runSearch(src, parseQuery('x status:todo'))).toThrow(/tasks was read/);
    expect(wantedKinds(parseQuery('x status:todo'))).toEqual(['task']);
    expect(wantedKinds(parseQuery('x'))).toEqual(['task', 'note', 'post', 'vote']);
  });

  it('keeps an unclosed phrase whole while it is typed', () => {
    expect(tokenize('"go wi')).toEqual([{ text: 'go wi', quoted: true }]);
    expect(tokenize('a "b c" d')).toEqual([
      { text: 'a', quoted: false },
      { text: 'b c', quoted: true },
      { text: 'd', quoted: false },
    ]);
    expect(parseQuery('tray "agent:codex').words).toEqual(['tray', 'agent:codex']);
    expect(parseQuery('"').words).toEqual([]);
  });
});

describe('search review fixes (round 3)', () => {
  it('ranks an exact id first, above any amount of repeated text, for all three id forms', () => {
    const { as } = setup({ prefix: 'AO' });
    const h = as('human:dawid');
    for (let i = 1; i < 47; i++) h.newTask({ title: `Filler ${i}` });
    expect(h.newTask({ title: 'The target' }).id).toBe('AO-0047');
    // Another task, its thread, a note and a vote repeat every id form hundreds of times.
    const spam = Array.from({ length: 150 }, () => 'AO-0047 0047 47').join(' ');
    h.newTask({ title: spam.slice(0, 900), body: spam });
    h.comment('AO-0048', spam);
    h.learn({ topic: 'ids', title: spam.slice(0, 900), body: spam });
    for (const q of ['47', '0047', 'AO-0047', 'ao-0047']) {
      const hits = h.search(q);
      expect(hits[0], q).toMatchObject({ kind: 'task', ref: 'test/AO-0047', field: 'id' });
      expect(hits.length, q).toBeGreaterThan(2);
    }
  });

  it('counts a repeated word once and refuses too many words or tokens', () => {
    expect(parseQuery(Array(MAX_TOKENS).fill('a').join(' ')).words).toEqual(['a']);
    expect(() => parseQuery(Array(250).fill('a').join(' '))).toThrow(OpsError);
    const many = Array.from({ length: MAX_WORDS + 1 }, (_, i) => `w${i}`).join(' ');
    expect(() => parseQuery(many)).toThrow(/at most 16 different words/);
    const filters = Array(MAX_TOKENS + 1)
      .fill('agent:codex')
      .join(' ');
    expect(() => parseQuery(filters)).toThrow(/at most 32 words and filters/);
    // About 250 one-letter terms, as a 500-character query allows.
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const wide = Array.from({ length: 250 }, (_, i) => letters[i % 26]).join(' ');
    expect(() => parseQuery(wide)).toThrow(OpsError);
  });

  it('scans each candidate text at most once per word, whatever the corpus holds', () => {
    clearSearchCache();
    const { as } = setup();
    const h = as('human:dawid');
    const text = 'a b c d e f g h i j k l m n o p '.repeat(200);
    const tasks = 12;
    const comments = 4;
    for (let i = 0; i < tasks; i++) {
      h.newTask({ title: `Task ${text.slice(0, 100)}`, body: text });
      for (let c = 0; c < comments; c++) h.comment(String(i + 1), text);
    }
    // Every task matches every word, the worst case. Per word and task: the title, the
    // description and each event (the creation and the comments).
    const words = 'a b c d e f g h i j k l m n o p';
    const perWord = tasks * (2 + 1 + comments);
    resetSearchWork();
    expect(h.search(`${words} in:tasks`, { limit: 200 })).toHaveLength(tasks);
    const sixteen = searchWork();
    expect(sixteen).toBeGreaterThan(0);
    expect(sixteen).toBeLessThanOrEqual(16 * perWord);
    // The same words repeated cost the same as once.
    resetSearchWork();
    h.search(`${words} a b c d e f in:tasks`, { limit: 200 });
    expect(searchWork()).toBe(sixteen);
  });

  it('reads one root, and a window around a message, for a channel', () => {
    const { as, env } = setup();
    const otherRepo = gitRepo();
    initRoot(otherRepo, { name: 'other', human: 'human:dawid' });
    let now = Date.parse('2026-10-01T00:00:00Z');
    const both = (actor: string) =>
      as(actor, { user: { roots: [otherRepo] } as Record<string, unknown>, now: () => now });
    const c = both('claude:engineer');
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      now += 1000;
      ids.push(c.post('general', `test ${i}`).id);
    }
    now += 1000;
    const other = new Workspace({ cwd: otherRepo, env, actor: 'claude:engineer', now: () => now });
    const otherPost = other.post('general', 'from other');
    const h = both('human:dawid');
    // Merged, every message names its root; root: reads one.
    expect(h.channel('general').map((m) => m.root)).toContain('other');
    expect(h.channel('general', { root: 'other' })).toMatchObject([
      { id: otherPost.id, root: 'other', body: 'from other' },
    ]);
    // An old message outside the newest 10 still loads, in a window of 10 around it.
    const old = h.channel('general', { root: 'test', around: ids[3], limit: 10 });
    expect(old.map((m) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `test ${i}`));
    const mid = h.channel('general', { root: 'test', around: ids[15], limit: 10 });
    expect(mid.map((m) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `test ${i + 10}`));
    expect(() => h.channel('general', { root: 'other', around: ids[3] })).toThrow(/no message/);
    expect(() => h.channel('general', { root: 'nowhere' })).toThrow(/no root/);
  });
});

/** Moves every file and folder time under `dir` an hour back, past the racy window. */
function age(dir: string): void {
  const then = new Date(Date.now() - 3_600_000);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) age(p);
    utimesSync(p, then, then);
  }
}

describe('search index (round 4)', () => {
  afterEach(() => setSearchCacheLimit(SEARCH_CACHE_BYTES));

  /** Live and archived tasks, notes, posts and a vote: 11 items. */
  function corpus() {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const { as, rootDir } = setup();
    const h = as('human:dawid', { now: () => now });
    h.newTask({ title: 'Archived otter', body: 'old' });
    h.done('1');
    now += 40 * 86_400_000;
    h.archive();
    for (let i = 0; i < 3; i++) h.newTask({ title: `Live ${i}`, body: `body ${i}` });
    h.learn({ topic: 'a', title: 'First note', body: 'one' });
    h.learn({ topic: 'b', title: 'Second note', body: 'two' });
    for (let i = 0; i < 3; i++) h.post('general', `post ${i}`);
    h.propose({ question: 'Colour?', options: ['green', 'blue'], voters: ['codex:qa'] });
    age(rootDir);
    return { h, rootDir, items: 1 + 3 + 2 + 3 + 1 };
  }

  it('reads each item once; a repeated search reads nothing, a change reads one item', () => {
    clearSearchCache();
    const { h, rootDir, items } = corpus();
    const loads = () => searchCacheStats().loads;
    const before = loads();
    expect(h.search('zzz')).toEqual([]);
    expect(loads() - before).toBe(items);
    // The same search again, and a different one over every kind: no file is read.
    const warm = loads();
    expect(h.search('zzz')).toEqual([]);
    expect(h.search('otter')[0]).toMatchObject({ ref: 'test/T-0001', field: 'title' });
    expect(h.search('one')[0]).toMatchObject({ kind: 'note' });
    expect(loads()).toBe(warm);
    // One changed note and one new post: two items read, the rest come from the cache.
    const note = join(rootDir, 'kb', 'a', 'first-note.md');
    writeFileSync(note, readFileSync(note, 'utf8').replace('one', 'uno, changed'));
    utimesSync(note, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_000_000));
    h.post('general', 'a new post about otters');
    const changed = loads();
    expect(h.search('otters')).toMatchObject([{ kind: 'post' }]);
    expect(h.search('changed')).toMatchObject([{ kind: 'note' }]);
    expect(loads() - changed).toBe(2);
  });

  it('reads a file changed in the last two seconds again on the next search', () => {
    clearSearchCache();
    const { h, rootDir } = corpus();
    h.search('zzz');
    const note = join(rootDir, 'kb', 'a', 'first-note.md');
    // Same size, so only the time tells the change; a fresh time is racy and never trusted.
    writeFileSync(note, readFileSync(note, 'utf8').replace('one', 'eno'));
    const at = searchCacheStats().loads;
    expect(h.search('eno')).toMatchObject([{ kind: 'note' }]);
    expect(h.search('eno')).toMatchObject([{ kind: 'note' }]);
    expect(searchCacheStats().loads - at).toBe(2);
  });

  it('over budget, a warm search rereads only the items that never fit, the same ones each time', () => {
    clearSearchCache();
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    const filler = 'lorem ipsum '.repeat(400);
    for (let i = 0; i < 40; i++) h.newTask({ title: `Big ${i}`, body: `${filler} heron` });
    age(rootDir);
    const limit = 64 * 1024;
    setSearchCacheLimit(limit);
    const loads = () => searchCacheStats().loads;
    let at = loads();
    expect(h.search('heron', { limit: 200 })).toHaveLength(40);
    expect(loads() - at).toBe(40);
    const kept = searchCacheStats().entries;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(40);
    for (let round = 0; round < 3; round++) {
      at = loads();
      expect(h.search('heron', { limit: 200 })).toHaveLength(40);
      // An LRU cache rereads all 40 here; this one rereads only the overflow.
      expect(loads() - at).toBe(40 - kept);
      const s = searchCacheStats();
      expect(s.entries).toBe(kept);
      expect(s.bytes).toBeLessThanOrEqual(limit);
    }
    // With room for everything, the next search fills it and the one after reads nothing.
    setSearchCacheLimit(SEARCH_CACHE_BYTES);
    at = loads();
    h.search('heron');
    expect(loads() - at).toBe(40 - kept);
    at = loads();
    h.search('heron');
    expect(loads()).toBe(at);
    expect(searchCacheStats().entries).toBe(40);
  });

  it('drops the entries of deleted files, which frees room for items that did not fit', () => {
    clearSearchCache();
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    const filler = 'lorem ipsum '.repeat(400);
    for (let i = 0; i < 6; i++)
      h.learn({ topic: 't', title: `Note ${i}`, body: `${filler} egret` });
    age(rootDir);
    h.search('egret');
    const one = searchCacheStats().bytes / 6;
    // Room for four notes: two never fit.
    setSearchCacheLimit(Math.floor(one * 4.5));
    clearSearchCache();
    h.search('egret');
    expect(searchCacheStats().entries).toBe(4);
    // Delete two cached notes: their entries go and the two that never fit move in.
    rmSync(join(rootDir, 'kb', 't', 'note-0.md'));
    rmSync(join(rootDir, 'kb', 't', 'note-1.md'));
    let at = searchCacheStats().loads;
    expect(h.search('egret')).toHaveLength(4);
    expect(searchCacheStats().loads - at).toBe(2);
    expect(searchCacheStats().entries).toBe(4);
    at = searchCacheStats().loads;
    expect(h.search('egret')).toHaveLength(4);
    expect(searchCacheStats().loads).toBe(at);
  });

  it('keeps entries while they fit, never evicts a valid one, and never keeps one larger than the room', () => {
    const c = new SearchCache(1000);
    const load = (value: string, bytes: number) => () => ({ value, bytes });
    c.get('a', '1', load('A', 400));
    c.get('b', '1', load('B', 400));
    // c does not fit: it is used once and a and b stay.
    expect(c.get('c', '1', load('C', 400))).toBe('C');
    expect(c.stats()).toMatchObject({ entries: 2, bytes: 800, loads: 3 });
    expect(c.get('a', '1', load('A2', 400))).toBe('A');
    expect(c.get('b', '1', load('B2', 400))).toBe('B');
    expect(c.get('c', '1', load('C2', 400))).toBe('C2');
    expect(c.stats().loads).toBe(4);
    // A new stamp loads again and its new value takes the old one's room.
    expect(c.get('b', '2', load('B3', 100))).toBe('B3');
    expect(c.stats()).toMatchObject({ entries: 2, bytes: 500 });
    expect(c.get('b', '2', load('B4', 100))).toBe('B3');
    expect(c.get('huge', '1', load('H', 5000))).toBe('H');
    expect(c.get('huge', '1', load('H2', 5000))).toBe('H2');
    expect(c.stats().bytes).toBe(500);
    // retain drops the keys under a prefix that are gone, and only those.
    c.get('x|1', '1', load('X1', 100));
    c.get('x|2', '1', load('X2', 100));
    c.retain('x|', new Set(['x|2']));
    expect(c.stats()).toMatchObject({ entries: 3, bytes: 600 });
    expect(c.get('x|2', '1', load('X2b', 100))).toBe('X2');
    // A smaller budget drops the newest entries first.
    c.setLimit(450);
    expect(c.stats()).toMatchObject({ entries: 1, bytes: 400 });
    expect(c.get('a', '1', load('A3', 400))).toBe('A');
  });
});
