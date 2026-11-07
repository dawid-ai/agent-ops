// @vitest-environment happy-dom
// AO-0143, rendered: event text written as Markdown (a heading and a bullet list) renders as
// Markdown in the task panel checkpoint, the Inbox (message, ask, review, triage question),
// Activity and Decisions; task references stay chips; long text in lists is folded and a click
// expands it. Sanitizing is tested in markdown-sanitize.test.ts, under jsdom.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { ActivityItem, Decision, InboxItem, Repeat, TaskDetail } from '../ui/src/types';
import { Markdown } from '../ui/src/ui/markdown';
import { Activity } from '../ui/src/views/Activity';
import { Decisions } from '../ui/src/views/Decisions';
import { Inbox } from '../ui/src/views/Inbox';
import { Repeating } from '../ui/src/views/Repeating';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// The format agents write: a summary line, then headings and bullets. Under happy-dom, DOMPurify
// unwraps the first element of its input and leaves the rest unchecked (`<p>x</p>` becomes `x`;
// Chromium and jsdom keep it), so every text here starts with a summary paragraph and the checks
// look at what follows it.
const MD =
  'Parser done.\n\n## Done\n\n- parser in `core/fold.ts`\n- tests, see AO-0014\n\n## Next\n\n- docs';

/** What each GET path answers; anything else gets an empty list. */
const answers = new Map<string, unknown>();

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  window.agentOps = {
    call: (_method: string, path: string) =>
      Promise.resolve({ ok: true, data: answers.get(path.split('?')[0]!) ?? [] }),
  } as unknown as NonNullable<Window['agentOps']>;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  delete window.agentOps;
});

async function mount(el: ReactElement): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(el));
}

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** True when `el` holds MD rendered: two headings, three list items, code and a task chip. */
function rendersMd(el: ParentNode): void {
  expect([...el.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Done', 'Next']);
  expect(el.querySelectorAll('li')).toHaveLength(3);
  expect(el.querySelector('code')?.textContent).toBe('core/fold.ts');
  expect(el.querySelector('a[data-task-ref="AO-0014"]')).not.toBeNull();
}

describe('the Markdown component', () => {
  it('folds clamped text and expands it on a click, but not on a link click', async () => {
    await mount(createElement(Markdown, { text: MD, clamp: true }));
    const body = box.querySelector('[data-clamp]')!;
    expect(body.getAttribute('data-clamp')).toBe('closed');
    expect(body.classList.contains('md-clamped')).toBe(true);
    await click(body.querySelector('a[data-task-ref]')!);
    expect(body.getAttribute('data-clamp')).toBe('closed');
    await click(body.querySelector('li')!);
    expect(body.getAttribute('data-clamp')).toBe('open');
    expect(body.classList.contains('md-clamped')).toBe(false);
    expect(box.querySelector('button')?.textContent).toBe('Show less');
    await click(box.querySelector('button')!);
    expect(body.getAttribute('data-clamp')).toBe('closed');
  });
});

describe('views', () => {
  it('renders a checkpoint as Markdown in the task panel', async () => {
    const detail: TaskDetail = {
      task: {
        id: 'AO-0057',
        root: 'r',
        title: 'Parse events',
        type: 'task',
        priority: 'p2',
        status: 'in-progress',
        owner: 'claude:engineer',
        claimedBy: 'claude:engineer',
        leaseUntil: null,
        reviewer: null,
        waitingOn: null,
        checkpoint: { summary: MD, next: 'Run `npm test`', at: '2026-11-05T12:00:00Z' },
        updatedAt: '2026-11-05T12:00:00Z',
      },
      body: '',
      events: [],
    };
    answers.set('/api/tasks/r%2FAO-0057', detail);
    await mount(createElement(TaskPanel, { id: 'r/AO-0057', nav: nav(), onClose: vi.fn() }));
    rendersMd(box.querySelector('.md-tight')!);
    expect(box.querySelector('.md-inline code')?.textContent).toBe('npm test');
  });

  it('renders the whole message, ask and review request in the inbox as Markdown', async () => {
    const items: InboxItem[] = [
      { kind: 'message', task: 'T-1', root: 'r', title: 'A', summary: 'Parser done.', detail: MD },
      { kind: 'ask', task: 'T-2', root: 'r', title: 'B', summary: 'Parser done.', detail: MD },
    ];
    await mount(createElement(Inbox, { nav: nav(), items, error: null }));
    const rows = box.querySelectorAll('[data-clamp]');
    expect(rows).toHaveLength(2);
    for (const r of rows) rendersMd(r);
  });

  it('shows the whole review request as Markdown after a click on its first line', async () => {
    const item: InboxItem = {
      kind: 'review',
      task: 'T-3',
      root: 'r',
      title: 'C',
      from: 'claude:engineer',
      summary: 'Parser done.',
      detail: MD,
    };
    await mount(createElement(Inbox, { nav: nav(), items: [item], error: null }));
    const text = box.querySelector('[data-review-text]')!;
    expect(text.querySelectorAll('li')).toHaveLength(0);
    await click(text.querySelector('.md')!);
    rendersMd(text);
  });

  it('renders the open question on a triage card as Markdown', async () => {
    const item: InboxItem = {
      kind: 'triage',
      task: 'T-0002',
      root: 'r',
      title: 'Board flickers',
      from: 'codex:engineer',
      summary: 'finding to triage: Board flickers',
      priority: 'p2',
      question: { event: 'E1', from: 'codex:engineer', summary: 'Parser done.', detail: MD },
    };
    await mount(createElement(Inbox, { nav: nav(), items: [item], error: null }));
    rendersMd(box.querySelector('[data-clamp]')!);
  });

  it('renders an activity body as Markdown, with the search words marked', async () => {
    const item: ActivityItem = {
      id: '01M6GN2PZGYB4SFGHXJYTD99XF',
      at: '2026-11-05T12:00:00Z',
      kind: 'task',
      type: 'checkpoint',
      actor: 'claude:engineer',
      root: 'r',
      task: 'AO-0057',
      title: 'Parse events',
      body: MD,
    };
    answers.set('/api/activity', {
      items: [item],
      next: null,
      total: 1,
      actors: ['claude:engineer'],
      projects: [],
    });
    await mount(createElement(Activity, { nav: nav() }));
    // The feed asks opsd 200 ms after the query settles.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    rendersMd(box.querySelector('[data-clamp]')!);
  });

  it('renders a decision body, ballot reason and outcome as Markdown', async () => {
    const d: Decision = {
      root: 'r',
      meta: {
        id: 'D-0001',
        question: 'Parse with `marked`?',
        options: ['Yes', 'No'],
        quorum: 1,
        created_by: 'claude:engineer',
      },
      body: MD,
      ballots: [{ actor: 'codex:engineer', at: '2026-11-05T10:00:00Z', choice: 'Yes', body: MD }],
      outcome: { choice: 'Yes', decided_by: 'human:dawid', at: '2026-11-05T11:00:00Z', body: MD },
      tally: { counts: { Yes: 1 }, votes: 1, leaders: ['Yes'], state: 'decided', missing: [] },
    };
    answers.set('/api/decisions', [d]);
    await mount(createElement(Decisions, { nav: nav(), selected: 'r/D-0001' }));
    expect(box.querySelector('h2 code')?.textContent).toBe('marked');
    const blocks = [...box.querySelectorAll('.md:not(.md-inline)')];
    expect(blocks).toHaveLength(3);
    for (const b of blocks) rendersMd(b);
  });

  it('renders a repeat task description as folded Markdown that expands on a click', async () => {
    const r: Repeat = {
      root: 'r',
      meta: {
        name: 'weekly-report',
        title: 'Weekly report {date}',
        created_by: 'human:dawid',
        created_at: '2026-11-01T09:00:00Z',
      },
      body: MD,
      rule: 'weekly',
      state: 'active',
      fired: 0,
    };
    answers.set('/api/repeats', [r]);
    await mount(createElement(Repeating, { nav: nav() }));
    const body = box.querySelector('[data-clamp]')!;
    expect(body.getAttribute('data-clamp')).toBe('closed');
    rendersMd(body);
    await click(body.querySelector('li')!);
    expect(body.getAttribute('data-clamp')).toBe('open');
  });
});
