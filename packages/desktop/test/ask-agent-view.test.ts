// @vitest-environment happy-dom
// Questions to a chosen agent (AO-0063): New task's Question type creates a `question` task owned
// by the agent, never by a person. The Inbox offers no agent picker: it opens the PM chat
// (AO-0134), and labels an answer to your question.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Inbox } from '../ui/src/views/Inbox';
import { NewTask } from '../ui/src/views/NewTask';

const calls = vi.hoisted(() => [] as Array<{ method: string; path: string; body: unknown }>);

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => ({
    data: (path === '/api/directory'
      ? [
          { id: 'claude:engineer', name: 'Builder one', source: 'role' },
          { id: 'human:ana', name: 'Ana', source: 'seen' },
        ]
      : []) as T,
    error: null,
    reload: () => {},
  }),
  api: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body });
    return { root: 'r', id: 'AO-0007' } as T;
  },
  refreshSoon: () => {},
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
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

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pickAgent(id: string): void {
  const input = box.querySelector<HTMLInputElement>('input[placeholder="codex:qa, claude:pm…"]')!;
  act(() => input.focus());
  type(input, id);
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('New task: Question type', () => {
  it('needs an agent, hides the due date and creates no delegation', async () => {
    const onCreated = vi.fn();
    act(() =>
      root!.render(createElement(NewTask, { me: 'human:dawid', onClose: vi.fn(), onCreated })),
    );
    click(button('Question'));
    expect(box.textContent).not.toContain('Due date');
    type(
      box.querySelector<HTMLInputElement>('input[placeholder="The question, in one line"]')!,
      'Why is the build slow?',
    );
    expect(button('Ask').disabled).toBe(true);
    pickAgent('claude:engineer');
    click(button('Ask'));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      title: 'Why is the build slow?',
      type: 'question',
      to: 'claude:engineer',
    });
    expect(onCreated).toHaveBeenCalledWith('r/AO-0007');
  });
});

describe('Inbox', () => {
  const nav = { me: 'human:dawid', openTask: vi.fn(), go: vi.fn() };

  it('opens the PM chat without an agent picker and labels an answer to your question', () => {
    const items = [
      {
        kind: 'message' as const,
        task: 'AO-0007',
        root: 'r',
        title: 'Is AO-0047 blocked?',
        event: '01M6J7KEW6RF3TZHXTRYPCRW8R',
        from: 'claude:engineer',
        type: 'done',
        summary: 'AO-0047 waits for a review only.',
      },
    ];
    act(() => root!.render(createElement(Inbox, { nav, items, error: null })));
    const labels = [...box.querySelectorAll('span.uppercase')].map((s) => s.textContent);
    expect(labels).toEqual(['Answer']);
    expect(() => button('Ask an agent')).toThrow();
    click(button('Chat with the PM'));
    expect(nav.go).toHaveBeenCalledWith('chat');
    expect(box.querySelector('[data-modal]')).toBeNull();
    expect(box.querySelector('input[placeholder="codex:qa, claude:pm…"]')).toBeNull();
  });
});
