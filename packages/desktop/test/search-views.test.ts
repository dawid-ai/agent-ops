// @vitest-environment happy-dom
// The search box and the Search view, rendered: a row for earlier text never opens, by click or
// by Enter, while the new text waits for its answer, whatever order the answers come in.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { SearchHit } from '../ui/src/types';
import { PARTIAL_TEXT, SearchBox } from '../ui/src/ui/search';
import { Search } from '../ui/src/views/Search';

/** Search requests the test answers one by one, in any order. */
const net = vi.hoisted(() => ({
  asked: [] as string[],
  pending: new Map<string, (hits: unknown) => void>(),
}));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  api: <T>(_method: string, path: string): Promise<T> =>
    new Promise<T>((resolve) => {
      const text = new URL(path, 'http://opsd').searchParams.get('q') ?? '';
      net.asked.push(text);
      net.pending.set(text, resolve as (hits: unknown) => void);
    }),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const hit = (n: number, title: string): SearchHit => ({
  kind: 'task',
  ref: `r/T-000${n}`,
  title,
  field: 'title',
  snippet: '',
  at: '',
  score: 0,
});

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  net.asked.length = 0;
  net.pending.clear();
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  vi.useRealTimers();
});

function mount(el: ReactElement): void {
  root = createRoot(box);
  act(() => root!.render(el));
}

function nav(): Nav & { openTask: ReturnType<typeof vi.fn>; go: ReturnType<typeof vi.fn> } {
  return { me: null, openTask: vi.fn(), go: vi.fn() };
}

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

function type(input: HTMLInputElement, text: string): void {
  act(() => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(input: HTMLInputElement, k: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

function wait(ms: number): void {
  act(() => vi.advanceTimersByTime(ms));
}

async function answer(text: string, hits: SearchHit[], partial = false): Promise<void> {
  await act(async () => net.pending.get(text)!({ hits, partial }));
}

/** The button that opens the result row showing `title`. */
function row(title: string): HTMLButtonElement | undefined {
  const r = [...box.querySelectorAll('.row-link')].find((b) => b.textContent?.includes(title));
  return r?.querySelector<HTMLButtonElement>('.row-open') ?? undefined;
}

function click(b: HTMLButtonElement): void {
  act(() => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Types, clicks an old row inside the debounce and while the request is out, then answers the
 * two newest requests out of order. Shared by both views.
 */
async function staleRows(input: HTMLInputElement, n: ReturnType<typeof nav>): Promise<void> {
  wait(200);
  await answer('alpha', [hit(1, 'Alpha task')]);
  expect(row('Alpha task')?.disabled).toBe(false);
  // New text: inside the debounce, the old row stays on screen but neither shows as live nor
  // opens.
  type(input, 'alpha beta');
  wait(100);
  expect(row('Alpha task')?.disabled).toBe(true);
  click(row('Alpha task')!);
  // The request for the new text is out; the old row still does not open.
  wait(100);
  expect(net.asked).toEqual(['alpha', 'alpha beta']);
  click(row('Alpha task')!);
  expect(n.openTask).not.toHaveBeenCalled();
  // Newer text again; its answer comes first, the older answer last.
  type(input, 'gamma');
  wait(200);
  await answer('gamma', [hit(3, 'Gamma task')]);
  await answer('alpha beta', [hit(2, 'Beta task')]);
  expect(row('Beta task')).toBeUndefined();
  expect(row('Gamma task')?.disabled).toBe(false);
  click(row('Gamma task')!);
  expect(n.openTask.mock.calls).toEqual([['r/T-0003']]);
}

describe('search views with old rows (round 4)', () => {
  it('the search box opens no row for earlier text, by click or by Enter', async () => {
    const n = nav();
    mount(createElement(SearchBox, { nav: n }));
    const input = box.querySelector<HTMLInputElement>('#global-search')!;
    type(input, 'alpha');
    await staleRows(input, n);
    // Opening a row closed the box. New rows, then new text, arrow down onto the old row, and
    // Enter before the answer: the full Search view opens for the new text, not the old row.
    type(input, 'delta');
    wait(200);
    await answer('delta', [hit(4, 'Delta task')]);
    type(input, 'epsilon');
    key(input, 'ArrowDown');
    expect(row('Delta task')?.disabled).toBe(true);
    key(input, 'Enter');
    expect(n.openTask).toHaveBeenCalledTimes(1);
    expect(n.go.mock.calls).toEqual([['search', 'epsilon']]);
  });

  it('the Search view opens no row for earlier text', async () => {
    const n = nav();
    mount(createElement(Search, { nav: n, initial: 'alpha' }));
    const input = box.querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('alpha');
    await staleRows(input, n);
    expect(n.go).not.toHaveBeenCalled();
  });
});

describe('search rows with task references', () => {
  const EVT = '01M6GN2PZGYB4SFGHXJYTD99XF';
  const refs = (): string[] =>
    [...box.querySelectorAll('a[data-task-ref]')].map((a) => a.getAttribute('data-task-ref')!);

  it('link references in the title and snippet, outside the row button, until the row is stale', async () => {
    mount(createElement(Search, { nav: nav(), initial: 'region' }));
    const input = box.querySelector<HTMLInputElement>('input')!;
    wait(200);
    await answer('region', [
      { ...hit(1, 'Region for AO-0014'), snippet: `Decided in AO-0014#${EVT}` },
    ]);
    expect(refs()).toEqual(['AO-0014', `AO-0014#${EVT}`]);
    expect(box.querySelector('button a')).toBeNull();
    // The search words stay marked inside the text around the links.
    expect(box.querySelector('mark')?.textContent?.toLowerCase()).toBe('region');
    // New text: the old row opens nothing, its references included.
    type(input, 'regions');
    expect(refs()).toEqual([]);
    expect(row('Region for')?.disabled).toBe(true);
  });
});

describe('search views with a partial answer (round 6)', () => {
  const said = (): boolean => box.textContent?.includes(PARTIAL_TEXT) ?? false;

  it('the search box and the Search view say when opsd searched part of the store', async () => {
    mount(createElement(SearchBox, { nav: nav() }));
    const input = box.querySelector<HTMLInputElement>('#global-search')!;
    type(input, 'heron');
    wait(200);
    await answer('heron', [hit(1, 'Heron task')], true);
    expect(said()).toBe(true);
    // New text: the note belongs to the old answer and goes until the new one says so.
    type(input, 'egret');
    expect(said()).toBe(false);
    wait(200);
    await answer('egret', [hit(2, 'Egret task')]);
    expect(said()).toBe(false);
    act(() => root!.unmount());
    root = undefined;

    mount(createElement(Search, { nav: nav(), initial: 'heron' }));
    wait(200);
    await answer('heron', [], true);
    expect(said()).toBe(true);
  });
});
