// @vitest-environment happy-dom
// The whole app, rendered (AO-0124): a not configured agent picked in a dialog's agent picker
// opens Add agent above that dialog. The dialog stays mounted with what was typed in it; Escape
// closes only Add agent; after the add, the picker holds the new agent and the form sends.
// AO-0134 removed Ask an agent, so the dialog here is New task with the Question type, whose Ask
// picker lists agents only.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../ui/src/App';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const QUESTION = 'Which runs are stuck?';
const PICKER = 'input[placeholder="codex:qa, claude:pm…"]';
const TITLE = 'input[placeholder="The question, in one line"]';

let root: Root | undefined;
let box: HTMLDivElement;
let posts: Array<{ path: string; body: unknown }>;
let data: Record<string, unknown>;

/** A stand-in for the preload bridge: opsd answers from `data`, and POSTs land in `posts`. */
function stubBridge(): void {
  const off = (): (() => void) => () => {};
  window.agentOps = {
    info: async () => ({ pid: 1, port: 1, version: 'test', me: 'human:dawid' }),
    setupStatus: async () => ({ needed: false }),
    desktop: async () => ({ ok: false }),
    update: async () => ({ ok: false }),
    onService: off,
    onUpdate: off,
    onEvent: off,
    onStatus: off,
    onNavigate: off,
    call: async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      if (method === 'POST') {
        posts.push({ path, body });
        if (path === '/api/settings') {
          // opsd now has the agent in its config, so the directory marks it configured.
          data['/api/directory'] = [
            { id: 'claude:engineer', name: 'Builder one', source: 'role', configured: true },
            {
              id: 'claude:orchestrator',
              name: 'claude:orchestrator',
              source: 'config',
              configured: true,
            },
          ];
          return { ok: true, data: {} };
        }
        if (path === '/api/tasks') {
          // New task opens the created task's panel, so opsd has to answer for it.
          data['/api/tasks/r%2FAO-0200'] = {
            task: {
              id: 'AO-0200',
              root: 'r',
              title: QUESTION,
              type: 'question',
              priority: 'p2',
              status: 'todo',
              owner: 'claude:orchestrator',
              claimedBy: null,
              leaseUntil: null,
              reviewer: null,
              waitingOn: null,
              updatedAt: '2026-11-04T17:00:00Z',
            },
            body: QUESTION,
            events: [],
          };
        }
        return { ok: true, data: { root: 'r', id: 'AO-0200' } };
      }
      return { ok: true, data: data[path.split('?')[0]!] ?? [] };
    },
  } as unknown as NonNullable<Window['agentOps']>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  posts = [];
  data = {
    '/api/directory': [
      { id: 'claude:engineer', name: 'Builder one', source: 'role', configured: true },
      { id: 'claude:orchestrator', name: 'seen lately', source: 'seen', configured: false },
    ],
    '/api/settings': { opsd: { agents: {}, runtimes: { claude: { command: 'claude' } } } },
    '/api/agents': [{ id: 'claude:engineer', status: 'active', wake: false, live: null }],
  };
  stubBridge();
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  delete window.agentOps;
});

/** Lets bridge promises and the 250 ms shared refresh run. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function button(text: string, within: ParentNode = document.body): HTMLButtonElement {
  const b = [...within.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no ${text} button`);
  return b;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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

function escape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

function dialog(title: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[role="dialog"][aria-label="${title}"]`);
}

/** Types into New task's Ask picker and clicks the greyed claude:orchestrator row. */
async function openAddFromPicker(): Promise<void> {
  const input = dialog('New task')!.querySelector<HTMLInputElement>(PICKER)!;
  act(() => input.focus());
  type(input, 'orchestrator');
  const row = document.body.querySelector('button[data-unconfigured="claude:orchestrator"]');
  expect(row).not.toBeNull();
  click(row!);
  await settle();
}

describe('Add agent from a picker inside a dialog', () => {
  it('opens above the dialog, keeps its text, and fills the picker after the add', async () => {
    act(() => root!.render(createElement(App)));
    await settle();
    click(button('New task'));
    await settle();
    const ask = dialog('New task')!;
    expect(ask).not.toBeNull();
    click(button('Question', ask));
    type(ask.querySelector<HTMLInputElement>(TITLE)!, QUESTION);
    type(ask.querySelector('textarea')!, QUESTION);

    await openAddFromPicker();
    const add = dialog('Add agent')!;
    expect(add).not.toBeNull();
    // Add agent sits above New task, and New task is still there with its text.
    expect(add.className).toContain('z-[45]');
    expect(ask.className).toContain('z-40');
    expect(ask.isConnected).toBe(true);
    expect(add.contains(ask)).toBe(false);
    expect(add.querySelector<HTMLInputElement>('input[placeholder="writer"]')!.value).toBe(
      'orchestrator',
    );

    // Escape closes Add agent only; New task does not ask to discard its text.
    escape();
    expect(dialog('Add agent')).toBeNull();
    expect(dialog('New task')).not.toBeNull();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(dialog('New task')!.querySelector('textarea')!.value).toBe(QUESTION);

    await openAddFromPicker();
    click(button('Add claude:orchestrator', dialog('Add agent')!));
    await settle(300);
    expect(posts).toContainEqual({
      path: '/api/settings',
      body: { patch: { opsd: { agents: { 'claude:orchestrator': { wake: false } } } } },
    });
    expect(dialog('Add agent')).toBeNull();
    const back = dialog('New task')!;
    expect(back).not.toBeNull();
    expect(back.querySelector('textarea')!.value).toBe(QUESTION);
    expect(back.textContent).toContain('orchestrator');

    // The form sends to the agent that was just added.
    click(button('Ask', back));
    await settle();
    const sent = posts.find((p) => p.path === '/api/tasks');
    expect(JSON.stringify(sent?.body)).toContain('claude:orchestrator');
  });
});
