// @vitest-environment happy-dom
// The PM chat and explicit status changes (AO-0134). The top bar reaches the PM chat in one click.
// An answered question keeps its reply box, and a reply reopens it with the text. No status change
// is written without a click on the confirming button: not from the status menu, not from the
// palette, not by typing the open task's id and pressing Enter.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../ui/src/App';
import type { Nav } from '../ui/src/App';
import type { Status, Task, TaskDetail } from '../ui/src/types';
import { Palette } from '../ui/src/ui/palette';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** What each GET path answers; anything else gets an empty list. */
const answers = new Map<string, unknown>();
/** Every write the UI sent to opsd. */
const writes: Array<{ path: string; body: Record<string, unknown> }> = [];

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  writes.length = 0;
  const off = (): (() => void) => () => {};
  window.agentOps = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      if (method !== 'GET') {
        writes.push({ path, body: body ?? {} });
        return Promise.resolve({ ok: true, data: { events: [] } });
      }
      return Promise.resolve({ ok: true, data: answers.get(path.split('?')[0]!) ?? [] });
    },
    info: () => Promise.resolve({ me: 'human:dawid', pid: 1, roots: [] }),
    setupStatus: () => Promise.resolve({ needed: false }),
    desktop: () => Promise.resolve({ ok: false }),
    onService: off,
    onEvent: off,
    onStatus: off,
    onNavigate: off,
  } as unknown as NonNullable<Window['agentOps']>;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  document.body.innerHTML = '';
  delete window.agentOps;
});

async function mount(el: ReactElement): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(el));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

/** A button anywhere on the page (popovers draw in a portal) whose text starts with `text`. */
function button(text: string): HTMLButtonElement {
  const b = [...document.body.querySelectorAll('button')].find((x) =>
    x.textContent?.trim().startsWith(text),
  );
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

async function click(b: Element): Promise<void> {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'AO-0125',
    root: 'r',
    title: 'Can I talk to you here?',
    type: 'question',
    priority: 'p2',
    status: 'done',
    owner: '*:orchestrator',
    claimedBy: null,
    leaseUntil: null,
    reviewer: null,
    waitingOn: null,
    updatedAt: '2026-11-04T07:39:00Z',
    ...over,
  } as Task;
}

async function panel(t: Task): Promise<void> {
  const detail: TaskDetail = { task: t, body: '', events: [] };
  answers.set(`/api/tasks/${encodeURIComponent(`${t.root}/${t.id}`)}`, detail);
  await mount(createElement(TaskPanel, { id: `${t.root}/${t.id}`, nav: nav(), onClose: vi.fn() }));
}

/** Opens the status pill's menu in the task panel and picks `label`. */
async function pickStatus(label: string): Promise<void> {
  await click(box.querySelector('button[title="Status"]')!);
  await click(button(label));
}

describe('top bar', () => {
  it('reaches the PM chat in one click, with no agent to pick', async () => {
    answers.set('/api/chat', { agent: 'claude:orchestrator', messages: [], live: null });
    await mount(createElement(App));
    await settle();
    await click(box.querySelector('[data-chat-button]')!);
    expect(box.querySelector('main')?.textContent).toContain('Chat with the PM');
    expect(box.querySelector('[data-modal]')).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe('an answered question', () => {
  it('keeps the reply box, and Reply reopens it with the text', async () => {
    await panel(task());
    const area = box.querySelector('textarea')!;
    expect(area.placeholder).toContain('Reply');
    type(area, 'Then: is AO-0124 on track?');
    await click(button('Reply'));
    expect(writes).toEqual([
      {
        path: '/api/tasks/r%2FAO-0125/reopen',
        body: { as: 'human:dawid', message: 'Then: is AO-0124 on track?' },
      },
    ]);
  });

  it('writes nothing when the panel opens', async () => {
    await panel(task({ status: 'todo' }));
    await settle();
    expect(writes).toEqual([]);
  });
});

describe('status changes need a click on the confirming button', () => {
  it('closes as done from the status menu only after the dialog button', async () => {
    await panel(task({ status: 'in-progress', claimedBy: 'claude:orchestrator' }));
    await pickStatus('Close as done');
    expect(writes).toEqual([]);
    expect(box.querySelector('[data-move-confirm]')?.textContent).toContain('Closes the task');
    // The menu closed on the pick, so the only Close as done button left is the dialog's.
    await click(button('Close as done'));
    expect(writes.map((w) => w.path)).toEqual(['/api/tasks/r%2FAO-0125/done']);
  });

  it('reopens from the status menu only after the dialog button, and Cancel writes nothing', async () => {
    await panel(task({ type: 'task' }));
    await pickStatus('Reopen');
    expect(writes).toEqual([]);
    expect(box.querySelector('[data-move-confirm]')?.textContent).toContain('Reopens the task');
    await click(button('Cancel'));
    expect(box.querySelector('[data-modal]')).toBeNull();
    expect(writes).toEqual([]);
  });

  it('palette: the open task id finds the task, not a move on it', async () => {
    const onMove = vi.fn<(t: Task, s: Status) => void>();
    const t = task();
    await mount(
      createElement(Palette, {
        nav: nav(),
        tasks: [t],
        open: t,
        onMove,
        onNew: vi.fn(),
        onHelp: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    const input = box.querySelector('input')!;
    type(input, 'AO-0125');
    expect(button('Can I talk to you here?')).toBeTruthy();
    expect(() => button('Back to to do')).toThrow();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // Enter opened the task, not a move on it.
    expect(onMove).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
