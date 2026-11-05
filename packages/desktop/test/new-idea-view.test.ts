// @vitest-environment happy-dom
// New task with the Idea type, rendered: an idea has no owner or due date, is created unowned with
// type idea, and turns the board's Ideas toggle on so it shows there right away.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardShowsIdeas, IDEAS_CHANGED } from '../ui/src/lib/filters';
import { NewTask } from '../ui/src/views/NewTask';

const calls = vi.hoisted(() => [] as Array<{ method: string; path: string; body: unknown }>);

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => ({
    data: (path === '/api/directory'
      ? [{ id: 'claude:engineer', name: 'Builder one', source: 'role' }]
      : []) as T,
    error: null,
    reload: () => {},
  }),
  api: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body });
    return { root: 'r', id: 'AO-0001' } as T;
  },
  refreshSoon: () => {},
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
let onCreated: ReturnType<typeof vi.fn>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  window.localStorage.clear();
  onCreated = vi.fn();
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
  act(() =>
    root!.render(createElement(NewTask, { me: 'human:dawid', onClose: vi.fn(), onCreated })),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

function button(text: string): HTMLButtonElement {
  const b = [...box.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

function click(b: Element): void {
  act(() => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function typeTitle(text: string): void {
  const input = box.querySelector<HTMLInputElement>('input[placeholder="Task title"]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('New task: Idea type', () => {
  it('offers Idea and hides the owner and due pickers for it', () => {
    expect(box.querySelector('input[placeholder="Unassigned"]')).not.toBeNull();
    expect(button('Due date')).toBeDefined();
    click(button('Idea'));
    expect(box.querySelector('input[placeholder="Unassigned"]')).toBeNull();
    expect(box.textContent).not.toContain('Due date');
    expect(box.textContent).toContain('Ideas have no owner');
    expect(button('Create idea')).toBeDefined();
  });

  it('creates an unowned idea, no delegation, and turns the board Ideas toggle on', async () => {
    const heard: boolean[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent<boolean>).detail);
    window.addEventListener(IDEAS_CHANGED, listen);
    click(button('Idea'));
    typeTitle('Search across roots');
    click(button('Create idea'));
    await settle();
    window.removeEventListener(IDEAS_CHANGED, listen);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/tasks' });
    expect(calls[0]!.body).toMatchObject({ title: 'Search across roots', type: 'idea' });
    expect((calls[0]!.body as { to?: string }).to).toBeUndefined();
    expect(onCreated).toHaveBeenCalledWith('r/AO-0001');
    expect(boardShowsIdeas()).toBe(true);
    expect(heard).toEqual([true]);
  });

  it('leaves the board toggle alone for a task', async () => {
    typeTitle('Fix the login');
    click(button('Create task'));
    await settle();
    expect(calls[0]!.body).toMatchObject({ type: 'task' });
    expect(boardShowsIdeas()).toBe(false);
  });
});
