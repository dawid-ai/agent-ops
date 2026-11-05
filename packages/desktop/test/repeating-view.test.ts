// @vitest-environment happy-dom
// The Repeating view (AO-0142): pause, resume, run now and delete call the repeat routes, the form
// sends each rule's fields, and the allow list lets exactly those calls through.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedCall } from '../src/allow';
import type { Repeat } from '../ui/src/types';
import { blankDraft, draftOf, Repeating, repeatBody } from '../ui/src/views/Repeating';

const calls = vi.hoisted(() => [] as Array<{ method: string; path: string; body: unknown }>);
const list = vi.hoisted(() => ({ repeats: [] as unknown[] }));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => ({
    data: (path === '/api/repeats' ? list.repeats : []) as T,
    error: null,
    reload: () => {},
  }),
  api: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body });
    return {} as T;
  },
  refreshSoon: () => {},
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const WEEKLY: Repeat = {
  root: 'r',
  meta: {
    name: 'weekly-report',
    title: 'Weekly report {date}',
    owner: 'claude:engineer',
    start: '2026-11-02T09:00',
    repeat: 'weekly',
    created_by: 'human:dawid',
    created_at: '2026-11-01T00:00:00.000Z',
  },
  body: 'Sum up the week.',
  rule: 'weekly at 09:00 from 2026-11-02',
  state: 'active',
  fired: 2,
  last: { id: 'AO-0007', slot: '2026-11-02T09:00', created_at: '', status: 'done' },
  next: '2026-11-09T09:00',
};

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  list.repeats = [WEEKLY];
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

const nav = { me: 'human:dawid', go: vi.fn() } as never;

function render(): void {
  act(() => root!.render(createElement(Repeating, { nav })));
}

function button(text: string): HTMLButtonElement {
  const b = [...box.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

async function click(b: Element): Promise<void> {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('Repeating view', () => {
  it('shows a repeat and pauses, runs and deletes it', async () => {
    render();
    expect(box.textContent).toContain('weekly-report');
    expect(box.textContent).toContain('weekly at 09:00 from 2026-11-02');
    expect(box.textContent).toContain('2026-11-09 09:00');
    await click(button('Pause'));
    await click(button('Run now'));
    await click(button('Delete'));
    await click(button('Delete for good'));
    expect(calls.map((c) => c.path)).toEqual([
      '/api/repeats/r%2Fweekly-report/pause',
      '/api/repeats/r%2Fweekly-report/run',
      '/api/repeats/r%2Fweekly-report/delete',
    ]);
    for (const c of calls) expect(allowedCall('POST', c.path)).toBe(true);
    expect(allowedCall('GET', '/api/repeats')).toBe(true);
  });

  it('offers Resume on a paused repeat', async () => {
    list.repeats = [{ ...WEEKLY, state: 'paused', meta: { ...WEEKLY.meta, paused: true } }];
    render();
    await click(button('Resume'));
    expect(calls.map((c) => c.path)).toEqual(['/api/repeats/r%2Fweekly-report/resume']);
  });

  it('names the root in every call when two roots use the same name', async () => {
    list.repeats = [
      { ...WEEKLY, root: 'alpha' },
      { ...WEEKLY, root: 'beta', meta: { ...WEEKLY.meta, paused: true }, state: 'paused' },
    ];
    render();
    const titles = (): string[] =>
      [...box.querySelectorAll('.panel .font-display')].map((x) => x.textContent ?? '');
    expect(titles()).toEqual(['alpha/weekly-report', 'beta/weekly-report']);
    await click(button('Pause'));
    await click(button('Resume'));
    const runs = [...box.querySelectorAll('button')].filter(
      (x) => x.textContent?.trim() === 'Run now',
    );
    await click(runs[1]!);
    expect(calls.map((c) => c.path)).toEqual([
      '/api/repeats/alpha%2Fweekly-report/pause',
      '/api/repeats/beta%2Fweekly-report/resume',
      '/api/repeats/beta%2Fweekly-report/run',
    ]);
    for (const c of calls) expect(allowedCall('POST', c.path)).toBe(true);
    const edits = [...box.querySelectorAll('button')].filter(
      (x) => x.textContent?.trim() === 'Edit',
    );
    await click(edits[1]!);
    expect(document.body.textContent).toContain('Edit beta/weekly-report');
  });

  it('titles a repeat by its bare name when no other root uses the name', () => {
    list.repeats = [WEEKLY, { ...WEEKLY, root: 'beta', meta: { ...WEEKLY.meta, name: 'other' } }];
    render();
    const titles = [...box.querySelectorAll('.panel .font-display')].map((x) => x.textContent);
    expect(titles).toEqual(['weekly-report', 'other']);
  });

  it('edits keep the root and the fields the form does not show', () => {
    const r: Repeat = {
      ...WEEKLY,
      root: 'beta',
      meta: { ...WEEKLY.meta, type: 'chore', project: 'ops', parent: 'B-0003', labels: ['x'] },
    };
    expect(repeatBody(draftOf(r))).toMatchObject({
      replace: true,
      root: 'beta',
      name: 'weekly-report',
      type: 'chore',
      project: 'ops',
      parent: 'B-0003',
      labels: ['x'],
    });
    expect(repeatBody(blankDraft()).root).toBeUndefined();
  });

  it('sends each rule with the fields it needs', () => {
    const days = repeatBody({ ...blankDraft(), name: 'n', title: 't', mode: 'weekdays' });
    expect(days).toMatchObject({ repeat: 'weekdays', days: ['mon', 'thu'], when: undefined });
    const cond = repeatBody({
      ...blankDraft(),
      name: 'n',
      title: 't',
      mode: 'condition',
      condKind: 'children-closed',
      condTask: ' AO-0012 ',
      start: '',
    });
    expect(cond).toMatchObject({
      when: 'children-closed AO-0012',
      repeat: undefined,
      days: undefined,
    });
    expect(cond.start).toBeUndefined();
    const edit = repeatBody(draftOf(WEEKLY));
    expect(edit).toMatchObject({
      replace: true,
      name: 'weekly-report',
      repeat: 'weekly',
      start: '2026-11-02T09:00',
      owner: 'claude:engineer',
      body: 'Sum up the week.',
    });
  });
});
