// @vitest-environment happy-dom
// The agent picker inside New task, rendered: the list closes on a pick and on a click elsewhere
// in the dialog, Escape closes only the open list, and Escape with typed input asks before the
// dialog discards it.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddAgentRequest } from '../ui/src/lib/goto';
import { ADD_AGENT_EVENT } from '../ui/src/lib/goto';
import type { DirectoryItem } from '../ui/src/types';
import { directoryEntries } from '../ui/src/ui/pickers';
import { NewTask } from '../ui/src/views/NewTask';

const DIRECTORY: DirectoryItem[] = [
  { id: 'claude:engineer', name: 'Builder one', source: 'role' },
  { id: 'codex:qa', name: 'Checker two', source: 'role', configured: true },
  // Not configured: a write refuses them, so the owner picker offers neither (AO-0124).
  { id: 'claude:qa', source: 'runtime', configured: false },
  { id: 'claude:orchestrator', source: 'seen', configured: false },
];

/** What /api/directory returns; a test may swap it before it renders. */
const opsd = vi.hoisted(() => ({ directory: [] as unknown[] }));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => ({
    data: (path === '/api/directory' ? opsd.directory : []) as T,
    error: null,
    reload: () => {},
  }),
  api: async <T>(): Promise<T> => ({}) as T,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn>;

function renderNewTask(): void {
  act(() =>
    root!.render(createElement(NewTask, { me: 'human:dawid', onClose, onCreated: vi.fn() })),
  );
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  opsd.directory = DIRECTORY;
  onClose = vi.fn();
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
  renderNewTask();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

function type(input: HTMLInputElement, text: string): void {
  act(() => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function ownerInput(): HTMLInputElement {
  const i = box.querySelector<HTMLInputElement>('input[placeholder="Unassigned"]');
  if (!i) throw new Error('no Owner input');
  return i;
}

function openOwner(): void {
  act(() => ownerInput().focus());
  expect(option('Builder one')).toBeDefined();
}

/** A row of the open agent list, drawn in a portal on document.body. */
function option(name: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find(
    (b) => !box.contains(b) && b.textContent?.includes(name),
  );
}

function press(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function mouse(target: Element, kind: 'mousedown' | 'click'): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true }));
  });
}

describe('New task: agent picker', () => {
  it('closes the list on a pick and keeps it closed', () => {
    openOwner();
    const row = option('Builder one')!;
    mouse(row, 'mousedown');
    mouse(row, 'click');
    expect(option('Builder one')).toBeUndefined();
    expect(option('Checker two')).toBeUndefined();
    expect(box.textContent).toContain('engineer');
  });

  it('closes the list on a click elsewhere in the dialog', () => {
    openOwner();
    const title = box.querySelector<HTMLInputElement>('input[placeholder="Task title"]')!;
    mouse(title, 'mousedown');
    expect(option('Builder one')).toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes only the list on Escape, never the dialog', () => {
    openOwner();
    press(ownerInput(), 'Escape');
    expect(option('Builder one')).toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(box.textContent).not.toContain('Discard what you typed?');
  });
});

describe('New task: owner picker offers configured agents only (AO-0124)', () => {
  /** Rows of the open list that pick an agent, as opposed to greyed not configured rows. */
  function pickable(): HTMLButtonElement[] {
    return [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => !box.contains(b) && !b.hasAttribute('data-unconfigured'),
    );
  }

  function greyed(id: string): HTMLButtonElement | null {
    return document.body.querySelector<HTMLButtonElement>(`button[data-unconfigured="${id}"]`);
  }

  it('lists runtime and seen ids only greyed, and a click opens Add agent instead of picking', () => {
    openOwner();
    const rows = pickable().map((b) => b.textContent ?? '');
    expect(rows.some((t) => t.includes('Builder one'))).toBe(true);
    expect(rows.some((t) => t.includes('Checker two'))).toBe(true);
    expect(rows.some((t) => t.includes('no role file') || t.includes('seen lately'))).toBe(false);
    expect(greyed('claude:qa')).not.toBeNull();
    expect(greyed('claude:orchestrator')).not.toBeNull();
    expect(document.body.textContent).toContain('Not configured');

    const asked: string[] = [];
    const listen = (e: Event): void => {
      asked.push((e as CustomEvent<AddAgentRequest>).detail.id);
    };
    window.addEventListener(ADD_AGENT_EVENT, listen);
    try {
      mouse(greyed('claude:orchestrator')!, 'click');
    } finally {
      window.removeEventListener(ADD_AGENT_EVENT, listen);
    }
    expect(asked).toEqual(['claude:orchestrator']);
    // Nothing was picked: the empty Owner field still shows its placeholder.
    expect(ownerInput().value).toBe('');
    expect(box.querySelector('input[placeholder="Unassigned"]')).not.toBeNull();
  });

  it('never picks an unknown typed id or a greyed one with Enter; a typed person it does', () => {
    act(() => ownerInput().focus());
    type(ownerInput(), 'claude:ghost');
    expect(greyed('claude:ghost')).not.toBeNull();
    press(ownerInput(), 'Enter');
    expect(box.querySelector('input[placeholder="Unassigned"]')).not.toBeNull();

    type(ownerInput(), 'orchestrator');
    press(ownerInput(), 'Enter');
    expect(box.querySelector('input[placeholder="Unassigned"]')).not.toBeNull();

    type(ownerInput(), 'human:ana');
    press(ownerInput(), 'Enter');
    expect(box.querySelector('input[placeholder="Unassigned"]')).toBeNull();
    expect(box.textContent).toContain('ana');
  });
});

describe('Directory from an older opsd without the configured flag (AO-0124)', () => {
  const legacy = (items: DirectoryItem[]): DirectoryItem[] =>
    items.map(({ configured: _drop, ...rest }) => rest);

  it('counts only role and config ids while the store defines an agent', () => {
    const dir = directoryEntries(legacy(DIRECTORY), null);
    const configured = (id: string): boolean | undefined =>
      dir.find((e) => e.id === id)?.configured;
    expect(configured('claude:engineer')).toBe(true);
    expect(configured('codex:qa')).toBe(true);
    expect(configured('claude:qa')).toBe(false);
    expect(configured('claude:orchestrator')).toBe(false);
  });

  it('counts every id when no role file or opsd.agents entry exists, as a write accepts any', () => {
    const open = legacy(DIRECTORY).filter((a) => a.source !== 'role' && a.source !== 'config');
    const dir = directoryEntries(open, 'human:dawid');
    expect(dir.map((e) => e.id)).toEqual(
      expect.arrayContaining(['claude:qa', 'claude:orchestrator']),
    );
    expect(dir.every((e) => e.configured)).toBe(true);
  });

  it('offers runtime, seen and typed ids in the owner picker of such a store', () => {
    opsd.directory = [
      { id: 'claude:qa', name: 'Runner qa', source: 'runtime' },
      { id: 'claude:orchestrator', name: 'Lead', source: 'seen' },
    ];
    renderNewTask();
    act(() => ownerInput().focus());
    expect(option('Runner qa')).toBeDefined();
    expect(option('Lead')).toBeDefined();
    expect(document.body.querySelector('button[data-unconfigured]')).toBeNull();
    expect(document.body.textContent).not.toContain('Not configured');

    type(ownerInput(), 'claude:ghost');
    expect(document.body.querySelector('button[data-unconfigured]')).toBeNull();
    press(ownerInput(), 'Enter');
    expect(box.querySelector('input[placeholder="Unassigned"]')).toBeNull();
    expect(box.textContent).toContain('ghost');
  });
});

describe('New task: due picker', () => {
  function dueButton(): HTMLButtonElement {
    const b = [...box.querySelectorAll('button')].find((x) => x.textContent === 'Due date');
    if (!b) throw new Error('no Due date button');
    return b;
  }

  /** A button of the open calendar, drawn in a portal on document.body. */
  function calendar(text: string): HTMLButtonElement | undefined {
    return [...document.body.querySelectorAll('button')].find(
      (b) => !box.contains(b) && b.textContent === text,
    );
  }

  it('closes the calendar on a date pick', () => {
    mouse(dueButton(), 'click');
    const tomorrow = calendar('Tomorrow')!;
    mouse(tomorrow, 'mousedown');
    mouse(tomorrow, 'click');
    expect(calendar('Tomorrow')).toBeUndefined();
    expect(box.textContent).not.toContain('Due date');
  });

  it('stays open for a time after a date pick with a time, and closes on the time', () => {
    mouse(dueButton(), 'click');
    mouse(calendar('Add a time')!, 'click');
    mouse(calendar('Tomorrow')!, 'click');
    expect(calendar('Tomorrow')).toBeDefined();
    mouse(calendar('09:00')!, 'click');
    expect(calendar('Tomorrow')).toBeUndefined();
  });

  it('closes on Escape without closing the dialog', () => {
    mouse(dueButton(), 'click');
    press(calendar('Tomorrow')!, 'Escape');
    expect(calendar('Tomorrow')).toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('New task: Escape on the dialog', () => {
  it('closes at once when nothing is typed', () => {
    press(document.body, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks before discarding a typed title; a second Escape keeps editing', () => {
    const title = box.querySelector<HTMLInputElement>('input[placeholder="Task title"]')!;
    type(title, 'Keep this');
    press(title, 'Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(box.textContent).toContain('Discard what you typed?');
    press(title, 'Escape');
    expect(box.textContent).not.toContain('Discard what you typed?');
    expect(title.value).toBe('Keep this');

    press(title, 'Escape');
    const discard = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Discard')!;
    mouse(discard, 'click');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes the mention list on Escape without asking or closing', () => {
    const area = box.querySelector<HTMLTextAreaElement>('textarea')!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      set.call(area, '@');
      area.setSelectionRange(1, 1);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(box.textContent).toContain('Mention');
    press(area, 'Escape');
    expect(box.textContent).not.toContain('Mention');
    expect(onClose).not.toHaveBeenCalled();
    expect(box.textContent).not.toContain('Discard what you typed?');
  });
});
