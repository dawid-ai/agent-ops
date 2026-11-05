import { describe, expect, it } from 'vitest';
import {
  backlogOf,
  boardShowsIdeas,
  setBoardShowsIdeas,
  filterOptions,
  lanesOf,
  loadViews,
  matchesFilter,
  upsertView,
} from '../ui/src/lib/filters';
import type { Task } from '../ui/src/types';

const t = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  root: 'r',
  title: `task ${id}`,
  type: 'task',
  priority: 'p2',
  status: 'todo',
  owner: null,
  claimedBy: null,
  leaseUntil: null,
  reviewer: null,
  waitingOn: null,
  checkpoint: null,
  updatedAt: '2026-11-01T00:00:00Z',
  ...over,
});

const tasks = [
  t('A', { owner: 'claude:engineer', project: 'web', labels: ['ui'] }),
  t('B', { owner: '*:engineer', claimedBy: 'codex:engineer', priority: 'p0', status: 'claimed' }),
  t('C', { owner: 'codex:qa', type: 'bug', project: 'api' }),
  t('D', { type: 'idea', owner: 'claude:engineer' }),
  t('E', { owner: 'human:dawid', status: 'blocked', waitingOn: 'human:dawid' }),
];
const ids = (xs: Task[]) => xs.map((x) => x.id);

describe('task filters', () => {
  it('filters by role and provider of the holder, then the owner', () => {
    const pick = (f: Parameters<typeof matchesFilter>[1]) =>
      ids(tasks.filter((x) => matchesFilter(x, f, 'human:dawid')));
    expect(pick({ role: 'engineer' })).toEqual(['A', 'B', 'D']);
    expect(pick({ provider: 'codex' })).toEqual(['B', 'C']);
    expect(pick({ provider: 'human' })).toEqual(['E']);
    expect(pick({ owner: 'codex:engineer' })).toEqual(['B']);
    expect(pick({ label: 'ui', project: 'web' })).toEqual(['A']);
    expect(pick({ mine: true })).toEqual(['E']);
    expect(pick({ text: 'task c' })).toEqual(['C']);
  });

  it('hides ideas when asked, unless the type filter asks for them', () => {
    const pick = (f: Parameters<typeof matchesFilter>[1]) =>
      ids(tasks.filter((x) => matchesFilter(x, f, null)));
    expect(pick({ ideas: false })).toEqual(['A', 'B', 'C', 'E']);
    expect(pick({ ideas: false, type: 'idea' })).toEqual(['D']);
    expect(pick({})).toHaveLength(5);
  });

  it('offers only values the tasks have, without wildcards or people as roles', () => {
    const o = filterOptions(tasks);
    expect(o.roles).toEqual(['engineer', 'qa']);
    expect(o.providers).toEqual(['claude', 'codex', 'human']);
    expect(o.projects).toEqual(['api', 'web']);
    expect(o.types).toEqual(['bug', 'idea', 'task']);
  });

  it('orders lanes: priorities high to low, names sorted, empty last', () => {
    expect(lanesOf(tasks, 'priority').map((l) => l.key)).toEqual(['p0', 'p2']);
    expect(lanesOf(tasks, 'project').map((l) => l.key)).toEqual(['api', 'web', '']);
    expect(lanesOf(tasks, 'agent').map((l) => l.key)).toEqual([
      'claude:engineer',
      'codex:engineer',
      'codex:qa',
      'human:dawid',
    ]);
    expect(lanesOf(tasks, 'none')).toEqual([{ key: 'all', tasks }]);
  });

  it('counts the backlog an agent would take: own, role and provider wildcards, no ideas', () => {
    const more = [...tasks, t('F', { owner: 'claude:*' }), t('G', { owner: '*:engineer' })];
    expect(ids(backlogOf('claude:engineer', more))).toEqual(['A', 'F', 'G']);
    expect(ids(backlogOf('codex:engineer', more))).toEqual(['G']);
    expect(ids(backlogOf('human:dawid', more))).toEqual([]);
  });

  it('reads saved views defensively and replaces a view by name', () => {
    expect(loadViews({ getItem: () => 'not json' })).toEqual([]);
    expect(loadViews({ getItem: () => '{"a":1}' })).toEqual([]);
    const good = { name: 'mine', view: 'board', filter: { mine: true } };
    const raw = JSON.stringify([good, { name: 1 }, { name: 'x', view: 'web', filter: {} }]);
    expect(loadViews({ getItem: () => raw })).toEqual([good]);
    // Nested fields of the wrong type are dropped, so filtering never throws on stored data.
    const bad = JSON.stringify([
      {
        name: 'odd',
        view: 'board',
        filter: { text: 5, owner: {}, mine: 'yes', label: ['x'], role: 'qa' },
        lanes: 'sideways',
      },
      { name: 'arr', view: 'list', filter: [1, 2] },
    ]);
    const views = loadViews({ getItem: () => bad });
    expect(views).toEqual([
      { name: 'odd', view: 'board', filter: { role: 'qa' } },
      { name: 'arr', view: 'list', filter: {} },
    ]);
    for (const v of views)
      expect(() => tasks.filter((x) => matchesFilter(x, v.filter, null))).not.toThrow();
    expect(
      loadViews({ getItem: () => JSON.stringify([{ ...good, lanes: 'agent' }]) })[0]!.lanes,
    ).toBe('agent');
    const next = upsertView([good as never], { name: ' mine ', view: 'list', filter: {} });
    expect(next).toEqual([{ name: 'mine', view: 'list', filter: {} }]);
  });
});

describe('board Ideas toggle', () => {
  const store = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };

  it('is off by default and remembers on and off', () => {
    const s = store();
    expect(boardShowsIdeas(s)).toBe(false);
    setBoardShowsIdeas(true, s);
    expect(boardShowsIdeas(s)).toBe(true);
    setBoardShowsIdeas(false, s);
    expect(boardShowsIdeas(s)).toBe(false);
  });

  it('falls back to off when storage throws or is missing', () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
    };
    expect(boardShowsIdeas(broken)).toBe(false);
    expect(boardShowsIdeas(undefined)).toBe(false);
  });
});
