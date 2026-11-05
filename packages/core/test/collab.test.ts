import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  findMentions,
  initRoot,
  parseDuration,
  parseTokens,
  parseWhen,
  Root,
  slugify,
} from '../src/index.js';
import { fakeToken, gitRepo, setup } from './helpers.js';

const DAY = 86_400_000;

describe('units', () => {
  it('parses durations, token counts and times', () => {
    expect(parseDuration('90m')).toBe(90);
    expect(parseDuration('2h')).toBe(120);
    expect(parseDuration('1h30m')).toBe(90);
    expect(parseDuration('1d')).toBe(1440);
    expect(parseDuration('45')).toBe(45);
    expect(() => parseDuration('soon')).toThrow(/bad duration/);
    expect(parseTokens('400k')).toBe(400_000);
    expect(parseTokens('1.5m')).toBe(1_500_000);
    expect(() => parseTokens('lots')).toThrow(/bad token count/);
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(parseWhen('+2h', now)).toBe('2026-10-31T14:00:00.000Z');
    expect(parseWhen('2026-11-02T08:00:00Z', now)).toBe('2026-11-02T08:00:00.000Z');
    expect(Date.parse(parseWhen('18:00', now))).toBeGreaterThan(now);
    expect(Date.parse(parseWhen('18:00', now))).toBeLessThanOrEqual(now + DAY);
    expect(() => parseWhen('someday', now)).toThrow(/bad time/);
    expect(slugify('Windows: CRLF breaks jq!')).toBe('windows-crlf-breaks-jq');
  });
});

describe('delegation', () => {
  it('records limits and routes the review to the expected reviewer', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'port the board' });
    const res = h.delegate('1', 'codex:engineer', {
      budget: '2h',
      tokens: '400k',
      due: '+3h',
      review: 'claude:qa',
      message: 'keep it small',
    });
    expect(res.view.owner).toBe('codex:engineer');
    expect(res.view.status).toBe('todo');
    expect(res.view.delegation).toMatchObject({
      by: 'human:dawid',
      to: 'codex:engineer',
      budget_minutes: 120,
      tokens: 400_000,
      review: 'claude:qa',
    });
    const c = as('codex:engineer');
    expect(c.next()?.meta.id).toBe('T-0001');
    c.start('1');
    const reviewed = c.review('1', 'PR ready');
    expect(reviewed.view.reviewer).toBe('claude:qa');
    expect(
      as('claude:qa')
        .inbox()
        .some((i) => i.kind === 'review'),
    ).toBe(true);
  });

  it('refuses a reviewer from the delegate provider and lets only the owner delegate', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'x', owner: 'claude:engineer' });
    expect(() =>
      as('claude:engineer').delegate('1', 'codex:engineer', { review: 'codex:qa' }),
    ).toThrow(/another provider/);
    expect(() => as('cursor:frontend').delegate('1', 'codex:engineer')).toThrow(/owned by/);
    expect(() => h.delegate('1', 'codex:engineer', { budget: 'forever' })).toThrow(/bad duration/);
    expect(as('claude:engineer').delegate('1', 'codex:engineer').view.owner).toBe('codex:engineer');
  });
});

describe('archive', () => {
  it('moves old closed tasks and still finds them', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const { as, rootDir } = setup();
    const h = as('human:dawid', { now: () => now });
    h.newTask({ title: 'old done' });
    h.newTask({ title: 'old parked' });
    h.newTask({ title: 'open' });
    h.newTask({ title: 'waits on 1', blockedBy: ['1'] });
    h.done('1');
    h.park('2', 'not now');
    now += 40 * DAY;
    h.newTask({ title: 'recent done' });
    h.done('5');

    expect(() => as('claude:engineer', { now: () => now }).archive()).toThrow(/only a human/);
    expect(h.archive({ dryRun: true })).toEqual(['T-0001', 'T-0002']);
    expect(existsSync(join(rootDir, 'tasks', 'T-0001'))).toBe(true);
    expect(h.archive()).toEqual(['T-0001', 'T-0002']);
    expect(existsSync(join(rootDir, 'tasks', 'T-0001'))).toBe(false);
    expect(existsSync(join(rootDir, 'archive', 'tasks', 'T-0001', 'task.md'))).toBe(true);

    expect(h.list().map((v) => v.meta.id)).toEqual(['T-0003', 'T-0004']);
    const all = h.list({ all: true });
    expect(all.find((v) => v.meta.id === 'T-0001')?.archived).toBe(true);
    expect(h.view('1').archived).toBe(true);
    expect(h.showEvents('1').events.length).toBe(1);
    // A dependency in the archive still counts as done.
    expect(h.list().find((v) => v.meta.id === 'T-0004')?.unblocked).toBe(true);
    // Archived ids stay taken.
    expect(h.newTask({ title: 'next' }).id).toBe('T-0006');

    const back = h.reopen('2', 'needed after all');
    expect(back.view.status).toBe('todo');
    expect(back.view.archived).toBeUndefined();
    expect(existsSync(join(rootDir, 'tasks', 'T-0002', 'task.md'))).toBe(true);
  });
});

describe('findings and the KB', () => {
  it('files a finding linked from the task it came from', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'main work' });
    const c = as('codex:engineer');
    c.start('1');
    const res = c.finding({ title: 'Login retries forever', body: 'auth.ts:40', task: '1' });
    expect(res.meta.type).toBe('finding');
    expect(res.meta.created_by).toBe('codex:engineer');
    const events = c.showEvents('1').events;
    expect(events.at(-1)).toMatchObject({ type: 'finding', ref: res.meta.id });
    expect(c.list({ type: 'finding' }).map((v) => v.meta.id)).toEqual([res.meta.id]);
  });

  it('gives findings and subtasks the project of the task they came from', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'main work', project: 'v2' });
    h.newTask({ title: 'loose work' });
    const c = as('codex:engineer');
    expect(c.finding({ title: 'from main', task: '1' }).meta.project).toBe('v2');
    expect(c.view('3').meta.project).toBe('v2');
    expect(c.finding({ title: 'elsewhere', task: '1', project: 'site' }).meta.project).toBe('site');
    expect(c.finding({ title: 'from loose', task: '2' }).meta.project).toBeUndefined();
    expect(c.finding({ title: 'no source' }).meta.project).toBeUndefined();
    expect(h.newTask({ title: 'sub', parent: '1' }).project).toBe('v2');
    expect(h.newTask({ title: 'sub, moved', parent: '1', project: 'site' }).project).toBe('site');
  });

  it('reads every task of a root as one project, old names mapped', () => {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'old name', project: 'v2' });
    h.newTask({ title: 'no project' });
    h.newTask({ title: 'elsewhere', project: 'site' });
    // Old enough that the index cache keeps their folds instead of refolding racy entries.
    const past = new Date(Date.now() - 3_600_000);
    for (const id of ['T-0001', 'T-0002', 'T-0003']) {
      utimesSync(join(rootDir, 'tasks', id, 'task.md'), past, past);
      utimesSync(join(rootDir, 'tasks', id, 'events'), past, past);
    }
    const projects = (ws: ReturnType<typeof as>) => ws.list().map((v) => v.meta.project);
    // A task that names no project reads as the root's name, not as no project.
    expect(projects(h)).toEqual(['v2', 'test', 'site']);

    const config = join(rootDir, 'config.yml');
    const base = readFileSync(config, 'utf8');
    writeFileSync(config, `${base}project_aliases:\n  v2: test\n`);
    // The index cache from the read above was folded under no aliases; it must not be reused.
    const a = as('human:dawid');
    expect(projects(a)).toEqual(['test', 'test', 'site']);
    expect(a.view('1').meta.project).toBe('test');
    expect(a.showEvents('1').meta.project).toBe('test');
    expect(a.list({ project: 'v2' }).map((v) => v.meta.id)).toEqual(['T-0001', 'T-0002']);
    expect(a.list({ project: 'test' }).map((v) => v.meta.id)).toEqual(['T-0001', 'T-0002']);
    expect(a.search('project:test').map((t) => t.ref)).toEqual(
      expect.arrayContaining(['test/T-0001', 'test/T-0002']),
    );
    // task.md keeps the name it was filed with.
    expect(readFileSync(join(rootDir, 'tasks', 'T-0001', 'task.md'), 'utf8')).toMatch(
      /^project: v2$/m,
    );
    // New tasks given the old name, and findings from an old-name task, store the new one.
    expect(a.newTask({ title: 'new', project: 'v2' }).project).toBe('test');
    const c = as('codex:engineer');
    expect(c.finding({ title: 'from old', task: '1' }).meta.project).toBe('test');
    // A finding from a task that names no project names none either, so both follow the default.
    expect(c.finding({ title: 'from loose', task: '2' }).meta.project).toBeUndefined();

    // A default project for tasks that name none; aliases apply to it too.
    writeFileSync(config, `${base}project: web\nproject_aliases:\n  v2: test\n`);
    expect(projects(as('human:dawid')).slice(0, 3)).toEqual(['test', 'web', 'site']);
    writeFileSync(config, `${base}project: v2\nproject_aliases:\n  v2: test\n`);
    expect(projects(as('human:dawid')).slice(0, 3)).toEqual(['test', 'test', 'site']);
    // Keys an object inherits are not aliases.
    writeFileSync(config, `${base}project: constructor\n`);
    expect(projects(as('human:dawid')).slice(0, 3)).toEqual(['v2', 'constructor', 'site']);
  });

  it('lists activity newest first across tasks and channels, within the limit', () => {
    let t = Date.parse('2026-11-02T08:00:00Z');
    const clock = () => (t += 60_000);
    const { as } = setup();
    const h = as('human:dawid', { now: clock });
    h.newTask({ title: 'old work', project: 'site' });
    h.comment('1', 'first');
    h.newTask({ title: 'new work' });
    as('claude:engineer', { now: clock }).start('2', 'plan');
    as('claude:engineer', { now: clock }).post('general', 'hello');
    const all = as('human:dawid').activity();
    expect(all.map((i) => `${i.type}:${i.task ?? i.channel}`)).toEqual([
      'post:general',
      'start:T-0002',
      'claim:T-0002',
      'created:T-0002',
      'comment:T-0001',
      'created:T-0001',
    ]);
    expect(all.find((i) => i.type === 'comment')).toMatchObject({
      title: 'old work',
      project: 'site',
      root: 'test',
    });
    expect(
      as('human:dawid')
        .activity({ limit: 2 })
        .map((i) => i.type),
    ).toEqual(['post', 'start']);
    expect(as('human:dawid').activity({ limit: 2 })).toHaveLength(2);
  });

  it('finds the newest event even when a task folds to an older time, and takes any limit', () => {
    const at = (h: string) => Date.parse(`2026-11-02T${h}:00Z`);
    const { as, rootDir } = setup();
    as('human:dawid', { now: () => at('08:00') }).newTask({ title: 'rolled back' });
    as('human:dawid', { now: () => at('10:30') }).newTask({ title: 'later task' });
    const root = new Root(rootDir);
    // An 11:00 event, then one whose clock reads 09:00 but sorts after it (push ordering).
    root.appendEvent(
      'T-0001',
      {
        type: 'comment',
        actor: 'claude:qa',
        at: new Date(at('11:00')).toISOString(),
        body: 'newest',
      },
      at('11:00'),
    );
    root.appendEvent(
      'T-0001',
      {
        type: 'comment',
        actor: 'claude:qa',
        at: new Date(at('09:00')).toISOString(),
        body: 'old clock',
      },
      at('09:00'),
    );
    const ws = as('human:dawid');
    expect(ws.activity({ limit: 1 }).map((i) => i.body)).toEqual(['newest']);
    expect(ws.activity({ limit: 1.5 })).toHaveLength(1);
    expect(ws.activity({ limit: Number.NaN }).length).toBeGreaterThan(1);
  });

  it('creates nothing behind a linked kb folder', () => {
    const { as, rootDir } = setup();
    const outside = mkdtempSync(join(tmpdir(), 'kb-target-'));
    try {
      rmSync(join(rootDir, 'kb'), { recursive: true, force: true });
      symlinkSync(outside, join(rootDir, 'kb'), 'junction');
      expect(() =>
        as('claude:engineer').learn({ topic: 'fresh', title: 'escape', body: 'x' }),
      ).toThrow(/kb is a link/);
      expect(existsSync(join(outside, 'fresh'))).toBe(false);
      expect(as('claude:engineer').kb([])).toEqual([]);
    } finally {
      rmSync(join(rootDir, 'kb'), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('writes, links and searches learn notes', () => {
    const { as, rootDir } = setup();
    as('human:dawid').newTask({ title: 'fix CI' });
    const c = as('claude:engineer');
    const a = c.learn({
      topic: 'Windows',
      title: 'Git Bash forks slowly under load',
      body: 'Prefer Node tooling over shell pipelines; process starts take seconds.',
      task: '1',
      tags: ['performance'],
    });
    expect(a.note.ref).toBe('windows/git-bash-forks-slowly-under-load');
    expect(c.showEvents('1').events.at(-1)).toMatchObject({ type: 'learn', ref: a.note.ref });
    const text = readFileSync(
      join(rootDir, 'kb', 'windows', 'git-bash-forks-slowly-under-load.md'),
      'utf8',
    );
    expect(text).toContain('task: T-0001');
    const b = c.learn({
      topic: 'windows',
      title: 'Git Bash forks slowly under load',
      body: 'again',
    });
    expect(b.note.slug).toBe('git-bash-forks-slowly-under-load-2');
    c.learn({ topic: 'ci', title: 'Cancel superseded runs', body: 'Windows minutes cost double.' });

    expect(c.kb(['windows']).map((h) => h.note.topic)).toEqual(['windows', 'windows', 'ci']);
    expect(c.kb(['pipelines', 'node']).map((h) => h.note.slug)).toEqual([a.note.slug]);
    expect(c.kb(['performance']).length).toBe(1);
    expect(c.kb([], 'ci').length).toBe(1);
    expect(c.kb(['nothing-matches'])).toEqual([]);
    expect(c.kbNote('ci/cancel-superseded-runs').author).toBe('claude:engineer');
    expect(() => c.kbNote('ci/missing')).toThrow(/no note/);

    // Links inside kb/ never serve files from outside it, listed or by name.
    const outside = mkdtempSync(join(tmpdir(), 'kb-outside-'));
    try {
      writeFileSync(join(outside, 'secret.md'), '---\ntitle: outside\n---\nnot a note');
      symlinkSync(outside, join(rootDir, 'kb', 'linked'), 'junction');
      let fileLink = true;
      try {
        symlinkSync(join(outside, 'secret.md'), join(rootDir, 'kb', 'ci', 'secret.md'), 'file');
      } catch {
        // File symlinks need extra rights on Windows; the junction still covers folders.
        fileLink = false;
      }
      mkdirSync(join(rootDir, 'kb', 'empty'), { recursive: true });
      expect(c.kb(['outside'])).toEqual([]);
      expect(c.kb([], 'linked')).toEqual([]);
      expect(() => c.kbNote('linked/secret')).toThrow(/no note/);
      expect(() => c.learn({ topic: 'linked', title: 'escape', body: 'x' })).toThrow(/is a link/);
      expect(existsSync(join(outside, 'escape.md'))).toBe(false);
      if (fileLink) expect(() => c.kbNote('ci/secret')).toThrow(/no note/);
    } finally {
      rmSync(join(rootDir, 'kb', 'linked'), { force: true, recursive: false });
      rmSync(outside, { recursive: true, force: true });
    }
    expect(() => c.learn({ topic: 'x', title: 'y', body: fakeToken() })).toThrow(
      /Nothing was written/,
    );
    expect(() => c.learn({ topic: 'x', title: 'y', body: ' ' })).toThrow(/needs a body/);
  });
});

describe('channels', () => {
  it('posts, reads and delivers mentions to the inbox', () => {
    const { as } = setup();
    const c = as('claude:engineer');
    expect(findMentions('ping @codex:qa and @human:dawid, not me@x.com')).toEqual([
      'codex:qa',
      'human:dawid',
    ]);
    // A role wildcard reaches every agent of the role; `@*:*` names no one.
    expect(findMentions('who knows? @*:orchestrator, @codex:* and @*:*')).toEqual([
      '*:orchestrator',
      'codex:*',
    ]);
    c.post('dev', 'Starting the board port. @codex:qa can you review after?');
    as('codex:qa').post('dev', 'Yes, @claude:engineer.');
    c.post('dev', 'Plain note.', { to: ['human:dawid'] });
    expect(() => c.post('Bad Name!', 'x')).toThrow(/bad channel name/);
    expect(() => c.post('dev', fakeToken())).toThrow(/Nothing was written/);

    const msgs = c.channel('dev');
    expect(msgs.map((m) => m.actor)).toEqual(['claude:engineer', 'codex:qa', 'claude:engineer']);
    expect(c.channel('#dev', { limit: 1 })[0]!.body).toBe('Plain note.');
    expect(c.channels()).toEqual([{ name: 'dev', messages: 3, last: msgs[2]!.id }]);

    const qa = as('codex:qa');
    const inbox = qa.inbox();
    expect(inbox.map((i) => [i.kind, i.task, i.from])).toEqual([
      ['mention', '#dev', 'claude:engineer'],
    ]);
    qa.inbox(undefined, { markRead: true });
    expect(qa.inbox()).toEqual([]);
    expect(
      as('human:dawid')
        .inbox()
        .filter((i) => i.kind === 'mention').length,
    ).toBe(1);
    // Your own message never lands in your inbox.
    expect(c.inbox().filter((i) => i.kind === 'mention').length).toBe(1);
  });
});

describe('votes and decisions', () => {
  it('decides a clear vote and lets the proposer record it', () => {
    const { as } = setup();
    const o = as('claude:orchestrator');
    o.newTask({ title: 'pick a desktop shell' });
    const d = o.propose({
      question: 'Desktop shell?',
      options: ['Electron', 'Tauri'],
      voters: ['claude:engineer', 'codex:engineer', 'cursor:frontend'],
      task: '1',
    });
    expect(d).toMatchObject({ id: 'D-0001', quorum: 2 });
    expect(
      as('codex:engineer')
        .inbox()
        .map((i) => i.kind),
    ).toEqual(['vote']);
    expect(() => as('codex:qa').vote('D-1', 'Electron')).toThrow(/not a voter/);
    expect(() => as('codex:engineer').vote('D-1', 'Qt')).toThrow(/not an option/);
    as('claude:engineer').vote('D-1', 'Electron', 'reuses the web UI');
    expect(o.decision('D-1').tally.state).toBe('open');
    expect(() => o.decide('D-1', 'Electron')).toThrow(/still open/);
    const after = as('codex:engineer').vote('d-1', '1');
    expect(after.tally).toMatchObject({ state: 'ready', leaders: ['Electron'], votes: 2 });
    expect(o.inbox().map((i) => i.kind)).toContain('decide');
    expect(() => o.decide('D-1', 'Tauri')).toThrow(/chose 'Electron'/);
    const done = o.decide('D-1', 'Electron');
    expect(done.tally.state).toBe('decided');
    expect(() => as('cursor:frontend').vote('D-1', 'Tauri')).toThrow(/is decided/);
    expect(o.decisions()).toEqual([]);
    expect(o.decisions({ all: true }).length).toBe(1);
    expect(o.showEvents('1').events.at(-1)!.body).toContain('Decision D-0001');
  });

  it('sends ties and missing quorum to the human', () => {
    let now = Date.parse('2026-10-31T10:00:00Z');
    const { as } = setup();
    const at = (id: string) => as(id, { now: () => now });
    const o = at('claude:orchestrator');
    o.propose({
      question: 'Index?',
      options: ['JSON', 'SQLite'],
      voters: ['claude:engineer', 'codex:engineer'],
      quorum: 2,
    });
    o.propose({ question: 'Name?', options: ['ops', 'aops'], deadline: '+1h' });
    at('claude:engineer').vote('D-1', 'JSON');
    at('codex:engineer').vote('D-1', 'SQLite');
    expect(o.decision('D-1').tally.state).toBe('tie');
    expect(() => o.decide('D-1', 'JSON')).toThrow(/tie; the human decides/);
    at('codex:qa').vote('D-2', 'ops');
    now += 2 * 3_600_000;
    expect(o.decision('D-2').tally.state).toBe('no-quorum');
    expect(() => at('codex:qa').vote('D-2', 'aops')).toThrow(/closed/);
    const h = at('human:dawid');
    expect(
      h
        .inbox()
        .filter((i) => i.kind === 'decide')
        .map((i) => i.task),
    ).toEqual(['D-0001', 'D-0002']);
    expect(h.decide('D-1', 'JSON', 'no native module').outcome?.decided_by).toBe('human:dawid');
    expect(() => h.decide('D-1', 'SQLite')).toThrow(/is decided/);
    expect(at('human:dawid').decision('D-1').outcome?.choice).toBe('JSON');
  });

  it('checks proposals', () => {
    const { as } = setup();
    const o = as('claude:orchestrator');
    expect(() => o.propose({ question: 'q', options: ['a'] })).toThrow(/at least two/);
    expect(() => o.propose({ question: 'q', options: ['a', 'A'] })).toThrow(/must differ/);
    expect(() => o.propose({ question: 'q', options: ['a', 'b'], voters: ['x'] })).toThrow(
      /bad owner/,
    );
    expect(() =>
      o.propose({ question: 'q', options: ['a', 'b'], voters: ['claude:qa'], quorum: 2 }),
    ).toThrow(/more than/);
  });
});

describe('review fixes', () => {
  it('holds the cross-provider reviewer rule for humans too, unless forced', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'x' });
    expect(() => h.delegate('1', 'codex:engineer', { review: 'codex:qa' })).toThrow(
      /another provider.*--force/,
    );
    const forced = as('human:dawid', { force: true }).delegate('1', 'codex:engineer', {
      review: 'codex:qa',
    });
    expect(forced.events[0]).toMatchObject({ type: 'delegate', forced: true });
    const o = as('claude:orchestrator');
    o.newTask({ title: 'y' });
    o.start('2');
    expect(() => o.review('2', 'check', 'claude:qa')).toThrow(/another provider/);
  });

  it('rechecks a task under its lock before archiving it', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const { as, rootDir } = setup();
    const h = as('human:dawid', { now: () => now });
    h.newTask({ title: 'closed, then reopened mid-archive' });
    h.newTask({ title: 'closed' });
    h.done('1');
    h.done('2');
    now += 40 * DAY;
    // Reopen T-0001 after archive() read the index but before it takes the task's lock.
    const original = Root.prototype.lock;
    let raced = false;
    const spy = vi.spyOn(Root.prototype, 'lock').mockImplementation(function <T>(
      this: Root,
      name: string,
      fn: () => T,
    ): T {
      if (name === 'task-T-0001' && !raced) {
        raced = true;
        original.call(this, name, () => {
          this.appendEvent(
            'T-0001',
            {
              type: 'reopen',
              actor: 'human:dawid',
              at: new Date(now).toISOString(),
              body: 'still needed',
            },
            now,
          );
        });
      }
      return original.call(this, name, fn) as T;
    });
    try {
      expect(h.archive()).toEqual(['T-0002']);
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(join(rootDir, 'tasks', 'T-0001', 'task.md'))).toBe(true);
    expect(h.view('1').status).toBe('todo');
    // A second archive run finds nothing left and does not fail.
    expect(h.archive()).toEqual([]);
  });

  it('files a linked finding in the source task root', () => {
    const { as, env } = setup();
    const beta = gitRepo();
    initRoot(beta, { name: 'beta', human: 'human:dawid' });
    const multi = { ...env, OPS_ROOTS: beta } as NodeJS.ProcessEnv;
    const inBeta = as('human:dawid', { env: multi, root: 'beta' });
    expect(inBeta.newTask({ title: 'beta work' }).id).toBe('T-0001');
    const c = as('codex:engineer', { env: multi });
    expect(c.defaultRoot().name).toBe('test');
    const res = c.finding({ title: 'beta bug', task: 'beta/T-0001' });
    expect(res.meta.id).toBe('T-0002');
    expect(c.resolve('beta/T-0002').root.name).toBe('beta');
    expect(c.defaultRoot().listTaskIds()).toEqual([]);
    expect(c.showEvents('beta/T-0001').events.at(-1)).toMatchObject({
      type: 'finding',
      ref: 'T-0002',
    });
  });

  it('keeps a ready vote stable: final ballots, deadlines for open votes', () => {
    let now = Date.parse('2026-10-31T10:00:00Z');
    const { as } = setup();
    const at = (id: string) => as(id, { now: () => now });
    const o = at('claude:orchestrator');
    o.propose({
      question: 'Store?',
      options: ['Files', 'SQLite'],
      voters: ['claude:engineer', 'codex:engineer', 'cursor:frontend'],
    });
    at('claude:engineer').vote('D-1', 'Files');
    at('codex:engineer').vote('D-1', 'Files');
    expect(o.decision('D-1').tally.state).toBe('ready');
    expect(() => at('claude:engineer').vote('D-1', 'SQLite')).toThrow(/ballots are final/);
    at('cursor:frontend').vote('D-1', 'SQLite');
    expect(o.decision('D-1').tally).toMatchObject({ state: 'ready', leaders: ['Files'] });

    expect(() => o.propose({ question: 'Open?', options: ['a', 'b'] })).toThrow(/needs --deadline/);
    expect(() =>
      o.propose({ question: 'Claude?', options: ['a', 'b'], voters: ['claude:*'] }),
    ).toThrow(/needs --deadline/);
    o.propose({ question: 'Name?', options: ['ops', 'aops'], deadline: '+1h' });
    at('claude:qa').vote('D-2', 'ops');
    at('codex:qa').vote('D-2', 'ops');
    expect(o.decision('D-2').tally.state).toBe('open');
    expect(() => o.decide('D-2', 'ops')).toThrow(/still open/);
    now += 2 * 3_600_000;
    expect(o.decision('D-2').tally.state).toBe('ready');
    expect(o.decide('D-2', 'ops').outcome?.decided_by).toBe('claude:orchestrator');
  });
});
