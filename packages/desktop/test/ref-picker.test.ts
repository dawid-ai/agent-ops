// @vitest-environment happy-dom
// The # task picker (AO-0060): where `#` opens it, how tasks and projects rank, the plain text a
// pick inserts, the status chips references render as, and the picker inside New task.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../ui/src/lib/markdown';
import type { RefTask } from '../ui/src/lib/refs';
import {
  hashAt,
  markTaskRefs,
  rankRefProjects,
  rankRefTasks,
  refFor,
  refScore,
  refTask,
  setRefTasks,
} from '../ui/src/lib/refs';
import { RefText } from '../ui/src/ui/refs';
import { NewTask } from '../ui/src/views/NewTask';

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>() => ({ data: [] as T, error: null, reload: () => {} }),
  api: async <T>(): Promise<T> => ({}) as T,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const task = (id: string, title: string, more: Partial<RefTask> = {}): RefTask => ({
  id,
  root: 'agent-ops',
  title,
  status: 'todo',
  updatedAt: '2026-11-01T00:00:00Z',
  ...more,
});

const TASKS: RefTask[] = [
  task('AO-0060', 'Reference tasks with # in the composer', {
    status: 'in-progress',
    project: 'v2',
  }),
  task('AO-0057', 'Messages to a person must link what they refer to', {
    status: 'done',
    project: 'v2',
  }),
  task('AO-0063', 'Questions with options', { project: 'v2', updatedAt: '2026-11-03T00:00:00Z' }),
  task('AO-0006', 'Install script', { project: 'setup' }),
  task('DSK-0012', 'Apple developer account', { root: 'desk', status: 'blocked' }),
];

afterEach(() => setRefTasks([]));

describe('hashAt', () => {
  it('opens on a # that starts a word and reads the query after it', () => {
    expect(hashAt('see #', 5)).toEqual({ start: 4, query: '' });
    expect(hashAt('see #compo', 10)).toEqual({ start: 4, query: 'compo' });
    expect(hashAt('#60', 3)).toEqual({ start: 0, query: '60' });
    expect(hashAt('(#ao-6', 6)).toEqual({ start: 1, query: 'ao-6' });
  });

  it('stays closed for event references, fragments, headings and finished words', () => {
    expect(hashAt('AO-0014#01M6', 12)).toBeNull();
    expect(hashAt('https://x.dev/#top', 18)).toBeNull();
    expect(hashAt('## Plan', 2)).toBeNull();
    expect(hashAt('# Plan', 6)).toBeNull();
    expect(hashAt('see #60 done', 12)).toBeNull();
  });
});

describe('ranking', () => {
  it('finds a task by id, number, title words or letters in order', () => {
    const t = TASKS[0]!;
    expect(refScore(t, 'AO-0060')).toBe(100);
    for (const q of ['60', '0060', 'ao-60', 'ao60']) expect(refScore(t, q)).toBe(95);
    expect(refScore(t, 'compo')).toBe(60);
    expect(refScore(t, 'erence')).toBe(50);
    expect(refScore(t, 'refcomp')).toBe(20);
    expect(refScore(t, 'zzz')).toBe(-1);
    // A number matches only that task, not every id that contains its digits.
    expect(refScore(TASKS[3]!, '60')).toBe(-1);
  });

  it('lists open tasks first, then by match, then the latest change', () => {
    expect(rankRefTasks(TASKS, '').map((t) => t.id)).toEqual([
      'AO-0063',
      'AO-0060',
      'AO-0006',
      'DSK-0012',
      'AO-0057',
    ]);
    // The done task matches the id exactly but still sorts after open matches.
    expect(rankRefTasks(TASKS, 'ao-005').map((t) => t.id)).toEqual(['AO-0057']);
    expect(rankRefTasks(TASKS, 'v2').map((t) => t.id)).toEqual(['AO-0063', 'AO-0060', 'AO-0057']);
  });

  it('lists projects by name, with their open tasks', () => {
    expect(rankRefProjects(TASKS, '')).toEqual([
      { name: 'v2', open: 2 },
      { name: 'setup', open: 1 },
    ]);
    expect(rankRefProjects(TASKS, 'set')).toEqual([{ name: 'setup', open: 1 }]);
  });

  it('inserts the bare id unless another root has the same id', () => {
    expect(refFor(TASKS[0]!, TASKS)).toBe('AO-0060');
    const twin = task('AO-0060', 'Other root', { root: 'hub' });
    expect(refFor(TASKS[0]!, [...TASKS, twin])).toBe('agent-ops/AO-0060');
    expect(refFor(twin, [...TASKS, twin])).toBe('hub/AO-0060');
  });
});

describe('reference chips', () => {
  it('adds status and title for a known task and escapes the title', () => {
    setRefTasks([task('AO-0047', 'Fix <b>"quotes"</b> & more', { status: 'needs-review' })]);
    const out = renderMarkdown('See AO-0047.');
    expect(out).toContain('data-status="needs-review"');
    expect(out).toContain('<span class="ref-dot"></span>AO-0047');
    expect(out).toContain(
      '<span class="ref-title">Fix &lt;b&gt;&quot;quotes&quot;&lt;/b&gt; &amp; more</span>',
    );
    expect(out).toContain('title="Open AO-0047\nIn review · Fix &lt;b&gt;');
    expect(out).not.toContain('<b>');
  });

  it('keeps unknown or ambiguous references as plain links', () => {
    setRefTasks([task('AO-0001', 'One'), task('AO-0001', 'Two', { root: 'hub' })]);
    expect(refTask('AO-0001')).toBeUndefined();
    expect(refTask('hub/AO-0001')?.title).toBe('Two');
    expect(markTaskRefs('AO-0001 and AO-0999')).not.toContain('data-status');
    expect(markTaskRefs('hub/AO-0001')).toContain('data-status="todo"');
  });

  it('never writes an unknown status into the attribute', () => {
    setRefTasks([task('AO-0047', 'X', { status: 'odd" onclick="x' })]);
    expect(markTaskRefs('AO-0047')).toContain('data-status="oddonclickx"');
  });
});

// ---- Rendered -----------------------------------------------------------------------------------

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;

function typeIn(area: HTMLTextAreaElement, text: string): void {
  act(() => {
    setText.call(area, text);
    area.setSelectionRange(text.length, text.length);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function rows(): string[] {
  return [...box.querySelectorAll('[role="listbox"] button')].map((b) => b.textContent ?? '');
}

describe('New task: # picker', () => {
  let body: HTMLTextAreaElement;

  beforeEach(() => {
    setRefTasks(TASKS);
    act(() =>
      root!.render(
        createElement(NewTask, { me: 'human:dawid', onClose: vi.fn(), onCreated: vi.fn() }),
      ),
    );
    body = box.querySelector('textarea')!;
  });

  it('opens on #, filters, and inserts the plain id in place of the #', async () => {
    typeIn(body, 'Follows #');
    expect(rows().length).toBeGreaterThan(0);
    expect(box.textContent).toContain('Projects');
    typeIn(body, 'Follows #compo');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('AO-0060');
    expect(rows()[0]).toContain('Reference tasks with # in the composer');
    press(body, 'Enter');
    await act(async () => {});
    expect(body.value).toBe('Follows AO-0060 ');
    expect(rows()).toHaveLength(0);
  });

  it('inserts project:name for a project and moves with the arrow keys', async () => {
    typeIn(body, 'In #setup');
    // The task in that project, then the project itself.
    expect(rows()).toHaveLength(2);
    press(body, 'ArrowDown');
    press(body, 'Tab');
    await act(async () => {});
    expect(body.value).toBe('In project:setup ');
  });

  it('closes on Escape without picking, and on a space', () => {
    typeIn(body, '#6');
    expect(rows().length).toBeGreaterThan(0);
    press(body, 'Escape');
    expect(rows()).toHaveLength(0);
    expect(body.value).toBe('#6');
    typeIn(body, '# ');
    expect(rows()).toHaveLength(0);
  });
});

describe('RefText chips', () => {
  it('draws a status dot and the title on hover, and updates when the index loads', () => {
    act(() => root!.render(createElement(RefText, { text: 'After AO-0060.' })));
    let link = box.querySelector('a[data-task-ref="AO-0060"]')!;
    expect(link.getAttribute('data-status')).toBeNull();
    act(() => setRefTasks(TASKS));
    link = box.querySelector('a[data-task-ref="AO-0060"]')!;
    expect(link.getAttribute('data-status')).toBe('in-progress');
    expect(link.querySelector('.ref-dot')).not.toBeNull();
    expect(link.getAttribute('title')).toBe(
      'Open AO-0060\nIn progress · Reference tasks with # in the composer',
    );
  });
});
