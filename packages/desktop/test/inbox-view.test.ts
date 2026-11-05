// @vitest-environment happy-dom
// AO-0099, rendered: a finding to triage in the Inbox has the Findings view's actions and posts
// the same retype; Accept carries the answer to an open question; a review item shows the request;
// an ask says it stays and why Answer is off.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { InboxItem, Task } from '../ui/src/types';
import { waitsOn } from '../ui/src/ui/triage';
import { Findings } from '../ui/src/views/Findings';
import { Inbox, prLabel } from '../ui/src/views/Inbox';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
let tasks: Task[] = [];

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  posts.length = 0;
  tasks = [];
  (window as unknown as { agentOps: unknown }).agentOps = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === 'POST') {
        posts.push({ path, body: body ?? {} });
        return Promise.resolve({ ok: true, data: {} });
      }
      return Promise.resolve({ ok: true, data: path.startsWith('/api/tasks') ? tasks : [] });
    },
  };
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

async function mount(el: ReactElement): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(el));
}

function nav(): Nav {
  return { me: 'human:dawid', openTask: vi.fn(), go: vi.fn() };
}

const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;

function type(area: HTMLTextAreaElement, text: string): void {
  act(() => {
    setText.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const b = [...box.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button '${label}'`);
  return b;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => el.click());
}

const triage: InboxItem = {
  kind: 'triage',
  task: 'T-0002',
  root: 'r',
  title: 'Login retries forever on 401',
  from: 'claude:qa',
  summary: 'finding to triage: Login retries forever on 401',
  priority: 'p2',
};

describe('Inbox triage items', () => {
  it('offer the Findings actions and post the same retype', async () => {
    await mount(createElement(Inbox, { nav: nav(), items: [triage], error: null }));
    expect(box.textContent).toContain('Findings to triage');
    for (const label of ['Accept as task', 'Bug', 'Idea', 'Park']) button(label);
    await click(button('Accept as task'));
    expect(posts).toEqual([
      {
        path: '/api/tasks/T-0002/retype',
        body: { as: 'human:dawid', type: 'task', message: 'Accepted in triage' },
      },
    ]);
  });

  it('show the open question and send the answer with Accept', async () => {
    const it2: InboxItem = {
      ...triage,
      question: { event: 'E1', from: 'codex:engineer', summary: 'Push, or wait for review?' },
    };
    await mount(createElement(Inbox, { nav: nav(), items: [it2], error: null }));
    expect(box.textContent).toContain('Push, or wait for review?');
    type(box.querySelector('textarea')!, 'Wait for review');
    await click(button('Bug'));
    expect(posts[0]!.body).toMatchObject({ type: 'bug', answer: 'Wait for review' });
  });
});

describe('Findings view', () => {
  const finding = (extra: Partial<Task>): Task => ({
    id: 'T-0002',
    root: 'r',
    title: 'Route needs a guard',
    type: 'finding',
    priority: 'p2',
    status: 'blocked',
    owner: null,
    claimedBy: null,
    leaseUntil: null,
    reviewer: null,
    waitingOn: 'human:dawid',
    checkpoint: null,
    updatedAt: '2026-11-03T10:00:00Z',
    ...extra,
  });

  it('shows a question waiting on you and answers it with Accept, through the shared actions', async () => {
    tasks = [
      finding({
        question: { event: 'E1', from: 'codex:engineer', to: 'human:dawid', summary: 'Which way?' },
      }),
    ];
    await mount(createElement(Findings, { nav: nav() }));
    expect(box.textContent).toContain('Which way?');
    type(box.querySelector('textarea')!, 'This way');
    await click(button('Accept as task'));
    expect(posts[0]).toEqual({
      path: '/api/tasks/r%2FT-0002/retype',
      body: { as: 'human:dawid', type: 'task', answer: 'This way', message: 'Accepted in triage' },
    });
  });

  it('leaves out a question that waits on someone else', async () => {
    tasks = [
      finding({
        waitingOn: 'human:anna',
        question: { event: 'E1', from: 'codex:engineer', to: 'human:anna', summary: 'Which way?' },
      }),
    ];
    await mount(createElement(Findings, { nav: nav() }));
    expect(box.textContent).toContain('Route needs a guard');
    expect(box.textContent).not.toContain('Which way?');
  });
});

describe('Inbox review and ask items', () => {
  it('show who asked for the review, the request, and its PR, commit and branch', async () => {
    const review: InboxItem = {
      kind: 'review',
      task: 'T-0001',
      root: 'r',
      title: 'x',
      from: 'claude:engineer',
      at: new Date().toISOString(),
      summary: 'Commit 5a42cf3 on branch claude/ao-1-x: check the parser',
      detail: 'Commit 5a42cf3 on branch claude/ao-1-x: check the parser\nTests: 12 pass.',
      pr: 'https://github.com/o/r/pull/68',
      commit: '5a42cf3',
      branch: 'claude/ao-1-x',
    };
    await mount(createElement(Inbox, { nav: nav(), items: [review], error: null }));
    expect(box.textContent).toContain('asks for your review');
    expect(box.textContent).not.toContain('waits for your review');
    const link = box.querySelector<HTMLAnchorElement>('a[href="https://github.com/o/r/pull/68"]');
    expect(link?.textContent).toContain('PR #68');
    expect(box.textContent).toContain('5a42cf3');
    expect(box.textContent).toContain('claude/ao-1-x');
    expect(box.querySelector('[data-review-text]')!.textContent).not.toContain('Tests: 12 pass.');
    await click(button('Show the whole request'));
    expect(box.querySelector('[data-review-text]')!.textContent).toContain('Tests: 12 pass.');
  });

  it('say an ask stays until answered and why Answer is off', async () => {
    const ask: InboxItem = {
      kind: 'ask',
      task: 'T-0003',
      root: 'r',
      title: 'y',
      from: 'codex:engineer',
      summary: 'Which way?',
    };
    await mount(createElement(Inbox, { nav: nav(), items: [ask], error: null }));
    expect(box.textContent).toContain('Stays here until you answer');
    expect(button('Answer').disabled).toBe(true);
    expect(button('Answer').title).toBe('Write your answer first');
    type(box.querySelector('textarea')!, 'This way');
    expect(button('Answer').disabled).toBe(false);
    expect(button('Answer').title).not.toBe('Write your answer first');
  });
});

describe('helpers', () => {
  it('waitsOn matches the person, a group, or anyone when no one is named', () => {
    expect(waitsOn('human:dawid', 'human:dawid')).toBe(true);
    expect(waitsOn('human:*', 'human:dawid')).toBe(true);
    expect(waitsOn(null, 'human:dawid')).toBe(true);
    expect(waitsOn('human:anna', 'human:dawid')).toBe(false);
    expect(waitsOn('human:dawid', null)).toBe(false);
  });

  it('prLabel names GitHub and GitLab requests', () => {
    expect(prLabel('https://github.com/o/r/pull/68')).toBe('PR #68');
    expect(prLabel('https://gitlab.com/g/p/-/merge_requests/12')).toBe('MR !12');
    expect(prLabel('https://example.com/x')).toBe('https://example.com/x');
  });
});
