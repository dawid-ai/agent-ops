// @vitest-environment happy-dom
// AO-0144: the task panel shows the shared triage control. An open idea gets Make task, Bug and
// Park with an owner and a priority, posted as one retype; an open finding gets the same actions
// as Findings and the Inbox (Accept as task, Bug, Idea, Park), with the answer to a question that
// waits on you. Other tasks and closed ideas show no triage control.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { Task, TaskDetail } from '../ui/src/types';
import { TriageActions } from '../ui/src/ui/triage';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const answers = new Map<string, unknown>();
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
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

/** Every button on the page (popovers draw in a portal) whose text is exactly `text`. */
function buttons(text: string): HTMLButtonElement[] {
  return [...document.body.querySelectorAll('button')].filter(
    (x) => x.textContent?.trim() === text,
  );
}

function button(text: string): HTMLButtonElement {
  const b = buttons(text)[0];
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

async function click(b: Element): Promise<void> {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function type(el: HTMLTextAreaElement, text: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'AO-0200',
    root: 'r',
    title: 'Dark mode for the board',
    type: 'idea',
    priority: 'p2',
    status: 'todo',
    owner: null,
    claimedBy: null,
    leaseUntil: null,
    reviewer: null,
    waitingOn: null,
    checkpoint: null,
    updatedAt: '2026-11-05T10:00:00Z',
    ...over,
  };
}

async function panel(t: Task): Promise<void> {
  const detail: TaskDetail = { task: t, body: '', events: [] };
  answers.set(`/api/tasks/${encodeURIComponent(`${t.root}/${t.id}`)}`, detail);
  await mount(createElement(TaskPanel, { id: `${t.root}/${t.id}`, nav: nav(), onClose: vi.fn() }));
}

/** The triage control's priority picker: the button whose title is `Priority` inside the box. */
function triagePriority(): HTMLButtonElement {
  const all = [...document.body.querySelectorAll<HTMLButtonElement>('button[title="Priority"]')];
  const b = all.find((x) => x.querySelector('[data-priority]'));
  if (!b) throw new Error('no triage priority picker');
  return b;
}

describe('an idea in the task panel', () => {
  it('offers Make task, Bug and Park, and no Idea', async () => {
    await panel(task());
    expect(box.textContent).toContain('Turn this idea into work');
    for (const label of ['Make task', 'Bug', 'Park']) button(label);
    expect(buttons('Idea')).toEqual([]);
    expect(buttons('Accept as task')).toEqual([]);
  });

  it('Make task posts one retype with the picked priority', async () => {
    await panel(task());
    await click(triagePriority());
    await click(button('Urgentp0'));
    expect(triagePriority().querySelector('[data-priority]')!.getAttribute('data-priority')).toBe(
      'p0',
    );
    await click(button('Make task'));
    expect(writes).toEqual([
      {
        path: '/api/tasks/r%2FAO-0200/retype',
        body: {
          as: 'human:dawid',
          type: 'task',
          priority: 'p0',
          message: 'Made a task from the idea',
        },
      },
    ]);
  });

  it('Bug keeps the owner the idea already has and leaves an unchanged priority out', async () => {
    await panel(task({ owner: 'claude:engineer' }));
    await click(button('Bug'));
    expect(writes).toEqual([
      {
        path: '/api/tasks/r%2FAO-0200/retype',
        body: {
          as: 'human:dawid',
          type: 'bug',
          to: 'claude:engineer',
          message: 'Made a bug from the idea',
        },
      },
    ]);
  });

  it('Park asks for a reason and parks the idea', async () => {
    await panel(task());
    await click(button('Park'));
    const input = box.querySelector<HTMLInputElement>(
      'input[placeholder="Why it is not planned"]',
    )!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(input, 'Out of scope');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Park it'));
    expect(writes).toEqual([
      {
        path: '/api/tasks/r%2FAO-0200/park',
        body: { as: 'human:dawid', message: 'Out of scope' },
      },
    ]);
  });

  it('shows no triage control once the idea is parked', async () => {
    await panel(task({ status: 'parked' }));
    expect(box.textContent).not.toContain('Turn this idea into work');
    expect(buttons('Make task')).toEqual([]);
  });
});

describe('a finding in the task panel', () => {
  const finding = (over: Partial<Task> = {}): Task =>
    task({
      id: 'AO-0201',
      title: 'Login retries forever on 401',
      type: 'finding',
      status: 'blocked',
      waitingOn: 'human:dawid',
      ...over,
    });

  it('offers the Findings and Inbox actions and posts the same retype', async () => {
    await panel(finding());
    expect(box.textContent).toContain('Finding to triage');
    for (const label of ['Accept as task', 'Bug', 'Idea', 'Park']) button(label);
    await click(button('Accept as task'));
    expect(writes).toEqual([
      {
        path: '/api/tasks/r%2FAO-0201/retype',
        body: { as: 'human:dawid', type: 'task', message: 'Accepted in triage' },
      },
    ]);
  });

  it('sends the answer to a question that waits on you with Accept', async () => {
    await panel(
      finding({
        question: { event: 'E1', from: 'codex:engineer', to: 'human:dawid', summary: 'Which way?' },
      }),
    );
    expect(box.textContent).toContain('Which way?');
    const area = box.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder^="Your answer, sent with Accept"]',
    )!;
    type(area, 'This way');
    await click(button('Bug'));
    expect(writes[0]).toEqual({
      path: '/api/tasks/r%2FAO-0201/retype',
      body: { as: 'human:dawid', type: 'bug', answer: 'This way', message: 'Accepted in triage' },
    });
  });
});

describe('the triage control when the task changes under it', () => {
  const control = (owner: string | null, priority: Task['priority']): ReactElement =>
    createElement(TriageActions, {
      task: 'r/AO-0200',
      type: 'idea',
      owner,
      priority,
      me: 'human:dawid',
    });

  async function rerender(el: ReactElement): Promise<void> {
    await act(async () => root!.render(el));
    await settle();
  }

  const shownPriority = (): string | null =>
    triagePriority().querySelector('[data-priority]')!.getAttribute('data-priority');

  it('follows a new owner and priority when the pickers were not changed', async () => {
    await mount(control('claude:engineer', 'p2'));
    await rerender(control('codex:engineer', 'p0'));
    expect(shownPriority()).toBe('p0');
    await click(button('Make task'));
    expect(writes).toEqual([
      {
        path: '/api/tasks/r%2FAO-0200/retype',
        body: {
          as: 'human:dawid',
          type: 'task',
          to: 'codex:engineer',
          message: 'Made a task from the idea',
        },
      },
    ]);
  });

  it('keeps a priority picked here when the task priority changes', async () => {
    await mount(control(null, 'p2'));
    await click(triagePriority());
    await click(button('Mediump1'));
    await rerender(control(null, 'p0'));
    expect(shownPriority()).toBe('p1');
    await click(button('Bug'));
    expect(writes[0]!.body).toMatchObject({ type: 'bug', priority: 'p1' });
  });
});

describe('other tasks in the task panel', () => {
  it('show no triage control', async () => {
    await panel(task({ type: 'task' }));
    expect(box.textContent).not.toContain('Turn this idea into work');
    expect(buttons('Make task')).toEqual([]);
    expect(buttons('Accept as task')).toEqual([]);
  });
});
