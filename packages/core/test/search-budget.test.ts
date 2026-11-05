// The search's per-request work budget, measured from outside: every file system call the search
// makes is counted here, so a call the budget forgets to charge fails these tests.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** File system calls and bytes read while `on` is true. */
const meter = { on: false, calls: 0, bytes: 0 };

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const count =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...a: A): R => {
      if (meter.on) meter.calls++;
      const out = fn(...a);
      if (meter.on && fn === (real.readFileSync as unknown)) {
        meter.bytes += typeof out === 'string' ? Buffer.byteLength(out) : (out as Buffer).length;
      }
      return out;
    };
  // Node's Dir reads `bufferSize` entries (32 by default) per call and hands them out one by
  // one, so a call is counted on every `bufferSize`-th read.
  const opendirSync = (...a: Parameters<typeof real.opendirSync>): fs.Dir => {
    if (meter.on) meter.calls++;
    const d = real.opendirSync(...a);
    const batch = a[1]?.bufferSize ?? 32;
    const readSync = d.readSync.bind(d);
    let n = 0;
    d.readSync = () => {
      if (meter.on && n % batch === 0) meter.calls++;
      n++;
      return readSync();
    };
    return d;
  };
  const wrapped = {
    ...real,
    statSync: count(real.statSync),
    lstatSync: count(real.lstatSync),
    readdirSync: count(real.readdirSync),
    readFileSync: count(real.readFileSync),
    existsSync: count(real.existsSync),
    opendirSync,
  };
  return { ...wrapped, default: wrapped };
});

const {
  clearSearchCache,
  initRoot,
  SEARCH_CACHE_BYTES,
  SEARCH_WORK,
  searchCacheStats,
  setSearchCacheLimit,
  setSearchWorkLimits,
  Workspace,
} = await import('../src/index.js');
const { gitRepo, setup } = await import('./helpers.js');

afterEach(() => {
  setSearchWorkLimits(SEARCH_WORK);
  setSearchCacheLimit(SEARCH_CACHE_BYTES);
  meter.on = false;
});

/** Sets every file and folder under `dir` an hour back, so no stamp is racy. */
function age(dir: string): void {
  const then = new Date(Date.now() - 3_600_000);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) age(p);
    fs.utimesSync(p, then, then);
  }
}

/** A root with `n` tasks that each say "heron" and carry a few events, made by copying one. */
function store(n: number, body = 'a heron by the water') {
  const { as, rootDir, repo, env } = setup();
  const h = as('human:dawid');
  h.newTask({ title: 'Task 1', body });
  h.comment('1', 'first comment');
  h.comment('1', 'second comment');
  for (let i = 2; i <= n; i++) {
    const id = `T-${String(i).padStart(4, '0')}`;
    fs.cpSync(join(rootDir, 'tasks', 'T-0001'), join(rootDir, 'tasks', id), { recursive: true });
  }
  age(rootDir);
  return { h, rootDir, repo, env };
}

/** Runs one search with the meter on. */
function measured(h: { searchResult: ReturnType<typeof store>['h']['searchResult'] }, q: string) {
  meter.calls = 0;
  meter.bytes = 0;
  meter.on = true;
  try {
    const r = h.searchResult(q, { limit: 200 });
    return { ...r, calls: meter.calls, bytes: meter.bytes };
  } finally {
    meter.on = false;
  }
}

describe('search work budget (round 6)', () => {
  const limits = { ops: 400, bytes: 32 * 1024 };

  it('keeps cold and warm requests within the budget, whatever the store size', () => {
    setSearchWorkLimits(limits);
    for (const n of [10, 60, 600]) {
      clearSearchCache();
      const { h } = store(n);
      h.searchResult('warm-up');
      for (let round = 0; round < 4; round++) {
        const r = measured(h, 'heron');
        expect(r.calls).toBeLessThanOrEqual(limits.ops);
        expect(r.bytes).toBeLessThanOrEqual(limits.bytes);
        if (n === 10) {
          // A small store fits: every task is found and nothing is cut.
          expect(r.partial).toBe(false);
          expect(r.hits).toHaveLength(10);
        }
        if (n === 600) expect(r.partial).toBe(true);
      }
    }
  });

  it('never reads an item larger than the budget, and says the answer is partial', () => {
    setSearchWorkLimits(limits);
    clearSearchCache();
    const { h } = store(3, `heron ${'lorem ipsum '.repeat(8000)}`);
    for (let round = 0; round < 3; round++) {
      const r = measured(h, 'heron');
      expect(r.bytes).toBeLessThanOrEqual(limits.bytes);
      expect(r.calls).toBeLessThanOrEqual(limits.ops);
      expect(r.partial).toBe(true);
      expect(r.hits).toEqual([]);
    }
    // Nothing that large was read, so nothing was loaded or cached.
    expect(searchCacheStats().entries).toBe(0);
  });

  it('covers more of a large store with each request, until all of it is cached', () => {
    // Enough for every warm task, not for reading them all at once.
    setSearchWorkLimits({ ops: 600, bytes: 1024 * 1024 });
    clearSearchCache();
    const { h } = store(120);
    const found: number[] = [];
    let r = measured(h, 'heron');
    for (let i = 0; i < 20 && r.partial; i++) {
      found.push(r.hits.length);
      expect(r.calls).toBeLessThanOrEqual(600);
      r = measured(h, 'heron');
    }
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual([...found].sort((a, b) => a - b));
    expect(r.partial).toBe(false);
    expect(r.hits).toHaveLength(120);
    expect(r.calls).toBeLessThanOrEqual(600);
  });

  it('gives each kind a share, so a large task store cannot crowd out votes', () => {
    setSearchWorkLimits(limits);
    clearSearchCache();
    const { h, rootDir } = store(600);
    h.propose({ question: 'Heron colour?', options: ['grey', 'blue'], voters: ['codex:qa'] });
    age(rootDir);
    const r = measured(h, 'heron');
    expect(r.partial).toBe(true);
    expect(r.calls).toBeLessThanOrEqual(limits.ops);
    expect(r.hits.some((x) => x.kind === 'vote')).toBe(true);
    expect(r.hits.some((x) => x.kind === 'task')).toBe(true);
  });

  it('spends a few calls per item on a warm request over the default budget', () => {
    clearSearchCache();
    const { h } = store(50);
    h.searchResult('heron');
    const r = measured(h, 'heron');
    expect(r.partial).toBe(false);
    expect(r.hits).toHaveLength(50);
    // Two stamp calls and one folder entry per task, plus folder listings; no file is read.
    expect(r.bytes).toBe(0);
    expect(r.calls).toBeLessThan(50 * 4 + 40);
  });
});

describe('search walks (round 7)', () => {
  const limits = { ops: 400, bytes: 32 * 1024 };

  /** Searches until a hit for `ref` comes back; the number of requests it took, or -1. */
  function until(h: Parameters<typeof measured>[0], q: string, ref: string, max: number): number {
    for (let i = 1; i <= max; i++) {
      const r = measured(h, q);
      expect(r.calls).toBeLessThanOrEqual(limits.ops);
      expect(r.bytes).toBeLessThanOrEqual(limits.bytes);
      if (r.hits.some((x) => x.ref === ref)) return i;
      expect(r.partial).toBe(true);
    }
    return -1;
  }

  it('reaches the late entries of a task folder that one request cannot even list', () => {
    setSearchWorkLimits(limits);
    clearSearchCache();
    const { h, rootDir } = store(600);
    // The last task in name order says kingfisher. The folder holds more entries than one
    // request may list, so a walk that restarts at the first entry never gets to it.
    const last = join(rootDir, 'tasks', 'T-0600', 'task.md');
    fs.writeFileSync(last, fs.readFileSync(last, 'utf8').replace('a heron', 'a kingfisher'));
    age(rootDir);
    const first = measured(h, 'kingfisher in:tasks');
    expect(first.partial).toBe(true);
    expect(until(h, 'kingfisher in:tasks', 'test/T-0600', 200)).toBeGreaterThan(0);
    // It is found again on later passes, once its walk comes round to it.
    expect(until(h, 'kingfisher in:tasks', 'test/T-0600', 200)).toBeGreaterThan(0);
  });

  it('reaches the late posts of a channel that one request cannot even list', () => {
    setSearchWorkLimits(limits);
    clearSearchCache();
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    const m = h.post('general', 'a heron by the water');
    const dir = join(rootDir, 'channels', 'general');
    const [file] = fs.readdirSync(dir).filter((f) => f.startsWith(m.id));
    const text = fs.readFileSync(join(dir, file!), 'utf8');
    // 900 posts in name (and time) order; only the newest says kingfisher.
    for (let i = 0; i < 900; i++) {
      const id = `01M0000000000000000000${String(i).padStart(4, '0')}`;
      const body = i === 899 ? text.replace('a heron', 'a kingfisher') : text;
      fs.writeFileSync(join(dir, `${id}-human-dawid.md`), body);
    }
    age(rootDir);
    expect(measured(h, 'kingfisher in:posts').partial).toBe(true);
    expect(until(h, 'kingfisher in:posts', '#general', 200)).toBeGreaterThan(0);
  });

  it('skips an item too large for any request instead of stopping on it', () => {
    setSearchWorkLimits(limits);
    clearSearchCache();
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Huge', body: `heron ${'lorem ipsum '.repeat(8000)}` });
    h.newTask({ title: 'Small', body: 'a heron' });
    age(rootDir);
    // T-0001 comes first and never fits; the walk moves past it to T-0002, and from then on
    // every request starts at T-0001 with a fresh share, skips it and finds T-0002.
    expect(until(h, 'heron in:tasks', 'test/T-0002', 5)).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) {
      const r = measured(h, 'heron in:tasks');
      expect(r.hits.map((x) => x.ref)).toEqual(['test/T-0002']);
      expect(r.partial).toBe(true);
    }
  });

  it('gives each root a share, and root: reads only the roots it names', () => {
    setSearchWorkLimits(limits);
    clearSearchCache();
    const { repo, env } = store(600);
    const otherRepo = gitRepo();
    const otherDir = initRoot(otherRepo, { name: 'other', human: 'human:dawid' });
    const other = new Workspace({ cwd: otherRepo, env, actor: 'human:dawid' });
    other.newTask({ title: 'Kingfisher', body: 'blue' });
    age(otherDir);
    const both = new Workspace({
      cwd: repo,
      env,
      actor: 'human:dawid',
      user: { roots: [otherRepo] } as Record<string, unknown>,
    });
    expect(both.roots.map((r) => r.name).sort()).toEqual(['other', 'test']);
    // Without root:, the large root cannot use up the share of the other one.
    const r = measured(both, 'kingfisher in:tasks');
    expect(r.partial).toBe(true);
    expect(r.calls).toBeLessThanOrEqual(limits.ops);
    expect(r.hits.map((x) => x.ref)).toEqual(['other/T-0001']);
    // With root:other, the large root costs nothing: one small task is all the work.
    const only = measured(both, 'kingfisher in:tasks root:other');
    expect(only.partial).toBe(false);
    expect(only.hits.map((x) => x.ref)).toEqual(['other/T-0001']);
    expect(only.calls).toBeLessThan(20);
  });
});

describe('nested search walks (round 8)', () => {
  const limits = { ops: 400, bytes: 32 * 1024 };

  /** Searches until a hit for `ref` comes back; the number of requests it took, or -1. */
  function until(h: Parameters<typeof measured>[0], q: string, ref: string, max: number): number {
    for (let i = 1; i <= max; i++) {
      const r = measured(h, q);
      expect(r.calls).toBeLessThanOrEqual(limits.ops);
      expect(r.bytes).toBeLessThanOrEqual(limits.bytes);
      if (r.hits.some((x) => x.ref === ref)) return i;
      expect(r.partial).toBe(true);
    }
    return -1;
  }

  /** A root whose channel #aaa holds 900 posts about herons and #zzz one about a kingfisher. */
  function channels() {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    const m = h.post('aaa', 'a heron by the water');
    h.post('zzz', 'a kingfisher on the branch');
    const dir = join(rootDir, 'channels', 'aaa');
    const [file] = fs.readdirSync(dir).filter((f) => f.startsWith(m.id));
    const text = fs.readFileSync(join(dir, file!), 'utf8');
    for (let i = 0; i < 900; i++) {
      const id = `01M0000000000000000000${String(i).padStart(4, '0')}`;
      fs.writeFileSync(join(dir, `${id}-human-dawid.md`), text);
    }
    age(rootDir);
    return h;
  }

  /** A root whose KB topic `aaa` holds 600 notes about herons and topic `zzz` one about a kingfisher. */
  function topics() {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    h.learn({ topic: 'aaa', title: 'Heron 0', body: 'a heron by the water' });
    h.learn({ topic: 'zzz', title: 'Kingfisher', body: 'a kingfisher on the branch' });
    const dir = join(rootDir, 'kb', 'aaa');
    const text = fs.readFileSync(join(dir, 'heron-0.md'), 'utf8');
    for (let i = 1; i < 600; i++) fs.writeFileSync(join(dir, `heron-${i}.md`), text);
    age(rootDir);
    return h;
  }

  it('moves on to a later channel after a first channel that one request cannot finish', () => {
    setSearchWorkLimits(limits);
    clearSearchCache();
    const h = channels();
    expect(measured(h, 'kingfisher in:posts').partial).toBe(true);
    // #aaa takes several requests; once its pass reaches the end, the walk goes on to #zzz.
    expect(until(h, 'kingfisher in:posts', '#zzz', 60)).toBeGreaterThan(0);
    // The next pass over the channels comes round to #zzz again.
    expect(until(h, 'kingfisher in:posts', '#zzz', 60)).toBeGreaterThan(0);
  });

  it('moves on to a later KB topic after a first topic that one request cannot finish', () => {
    setSearchWorkLimits(limits);
    clearSearchCache();
    const h = topics();
    expect(measured(h, 'kingfisher in:notes').partial).toBe(true);
    expect(until(h, 'kingfisher in:notes', 'zzz/kingfisher', 60)).toBeGreaterThan(0);
    expect(until(h, 'kingfisher in:notes', 'zzz/kingfisher', 60)).toBeGreaterThan(0);
  });

  it('calls an answer complete only when it searched every post of a resumed channel', () => {
    setSearchWorkLimits(limits);
    clearSearchCache();
    // 150 posts: reading them all takes more than one request, a warm pass fits in one.
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    const m = h.post('aaa', 'a heron by the water');
    const dir = join(rootDir, 'channels', 'aaa');
    const [file] = fs.readdirSync(dir).filter((f) => f.startsWith(m.id));
    const text = fs.readFileSync(join(dir, file!), 'utf8');
    for (let i = 0; i < 149; i++) {
      const id = `01M0000000000000000000${String(i).padStart(4, '0')}`;
      fs.writeFileSync(join(dir, `${id}-human-dawid.md`), text);
    }
    age(rootDir);
    const partials: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      const r = measured(h, 'heron in:posts');
      expect(r.calls).toBeLessThanOrEqual(limits.ops);
      partials.push(r.partial);
      if (!r.partial) expect(r.hits).toHaveLength(150);
    }
    expect(partials[0]).toBe(true);
    expect(partials.at(-1)).toBe(false);
  });
});
