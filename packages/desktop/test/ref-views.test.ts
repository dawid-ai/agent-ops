// @vitest-environment happy-dom
// Person-facing text outside Markdown, rendered: task references in decisions (with their
// options and choices), task titles and checkpoints, reports, standups, the inbox, activity,
// list, board, findings, knowledge notes, schedules, the agents' waiting list and the move dialog
// are the same `a[data-task-ref]` links App opens in the task panel. Rows that open something keep
// those links outside their button, and a reference click doesn't also open the row. An event
// reference scrolls the task panel to its event every time it is opened.
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type {
  ActivityItem,
  Decision,
  InboxItem,
  KbNote,
  OpsEvent,
  Report,
  Standup,
  Schedule,
  Task,
  TaskDetail,
  WaitItem,
} from '../ui/src/types';
import { useMover } from '../ui/src/ui/move';
import { useTaskFocus } from '../ui/src/ui/refs';
import { Activity } from '../ui/src/views/Activity';
import { Agents } from '../ui/src/views/Agents';
import { Board } from '../ui/src/views/Board';
import { Decisions } from '../ui/src/views/Decisions';
import { Findings } from '../ui/src/views/Findings';
import { Inbox } from '../ui/src/views/Inbox';
import { Knowledge } from '../ui/src/views/Knowledge';
import { List } from '../ui/src/views/List';
import { Reports } from '../ui/src/views/Reports';
import { Schedules } from '../ui/src/views/Schedules';
import { Standups } from '../ui/src/views/Standups';
import { TaskPanel } from '../ui/src/views/TaskPanel';

const EVT = '01M6GN2PZGYB4SFGHXJYTD99XF';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** What each GET path answers; anything else gets an empty list. */
const answers = new Map<string, unknown>();

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  // The desktop bridge every `api()` call goes through.
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

/** The `data-task-ref` of every reference link on screen. */
const refs = (): string[] =>
  [...box.querySelectorAll('a[data-task-ref]')].map((a) => a.getAttribute('data-task-ref')!);

const decision = (outcome: boolean): Decision => ({
  root: 'r',
  meta: {
    id: 'D-0001',
    question: 'Which region for AO-0014?',
    options: ['EU', 'US'],
    quorum: 1,
    created_by: 'claude:engineer',
  },
  body: `Context in AO-0014#${EVT}.`,
  ballots: [
    {
      actor: 'codex:engineer',
      at: '2026-11-03T10:00:00Z',
      choice: 'EU',
      body: 'Cheaper, see AO-0020',
    },
  ],
  outcome: outcome
    ? {
        choice: 'EU',
        decided_by: 'human:dawid',
        at: '2026-11-03T11:00:00Z',
        body: 'Follow-up in r/AO-0021',
      }
    : null,
  tally: {
    counts: { EU: 1 },
    votes: 1,
    leaders: ['EU'],
    state: outcome ? 'decided' : 'ready',
    missing: [],
  },
});

it('links task references in a decision question, body, ballot reason and outcome', async () => {
  answers.set('/api/decisions', [decision(true)]);
  await mount(createElement(Decisions, { nav: nav(), selected: 'r/D-0001' }));
  expect(refs()).toEqual(
    expect.arrayContaining(['AO-0014', `AO-0014#${EVT}`, 'AO-0020', 'r/AO-0021']),
  );
});

it('links task references in a task title, checkpoint and next step', async () => {
  const detail: TaskDetail = {
    task: {
      id: 'AO-0057',
      root: 'r',
      title: 'Messages to a person, after AO-0050',
      type: 'bug',
      priority: 'p1',
      status: 'in-progress',
      owner: 'claude:engineer',
      claimedBy: 'claude:engineer',
      leaseUntil: null,
      reviewer: null,
      waitingOn: null,
      checkpoint: {
        summary: `Shares rendering with AO-0060; see AO-0014#${EVT}.`,
        next: 'Re-review with r/AO-0101',
        at: '2026-11-03T12:00:00Z',
      },
      updatedAt: '2026-11-03T12:00:00Z',
    },
    body: '',
    events: [],
  };
  answers.set('/api/tasks/r%2FAO-0057', detail);
  await mount(createElement(TaskPanel, { id: 'r/AO-0057', nav: nav(), onClose: vi.fn() }));
  expect(refs()).toEqual(
    expect.arrayContaining(['AO-0050', 'AO-0060', `AO-0014#${EVT}`, 'r/AO-0101']),
  );
});

/** Clicks the row's own button: the one that stretches over a row with reference links. */
function openRow(): void {
  const b = box.querySelector<HTMLButtonElement>('.row-link .row-open')!;
  act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

it('links task references in report decisions, outside the row button', async () => {
  const report: Report = {
    from: '2026-10-27',
    to: '2026-11-03',
    projects: [],
    agents: [],
    providers: [],
    decisions: [
      { id: 'D-0001', question: `Region for AO-0014#${EVT}?`, choice: 'Use AO-0030', at: '' },
    ],
    channels: [],
    totals: { opened: 0, closed: 0, runs: 0, minutes: 0, tokens: 0 },
  };
  answers.set('/api/report', report);
  const n = nav();
  await mount(createElement(Reports, { nav: n }));
  expect(refs()).toEqual([`AO-0014#${EVT}`, 'AO-0030']);
  expect(box.querySelector('button a')).toBeNull();
  openRow();
  expect(n.go).toHaveBeenCalledWith('decisions');
});

it('links task references in standup titles and notes, outside the row button', async () => {
  const standup: Standup = {
    since: '2026-11-02T12:00:00Z',
    until: '2026-11-03T12:00:00Z',
    agents: [
      {
        agent: 'claude:engineer',
        done: [
          {
            task: 'r/AO-0057',
            title: 'Follow-up to AO-0014',
            at: '2026-11-03T11:00:00Z',
            note: `Answered AO-0014#${EVT}`,
          },
        ],
        review: [],
        working: [],
        blocked: [],
        runs: 1,
        tokens: 0,
        minutes: 0,
      },
    ],
    posts: [],
  };
  answers.set('/api/standup', standup);
  const n = nav();
  await mount(createElement(Standups, { nav: n }));
  expect(refs()).toEqual(expect.arrayContaining(['AO-0014', `AO-0014#${EVT}`]));
  expect(box.querySelector('button a')).toBeNull();
  openRow();
  expect(n.openTask).toHaveBeenCalledWith('r/AO-0057');
});

const TITLE = `Follow-up to AO-0014#${EVT}`;

const task = (over: Partial<Task> = {}): Task => ({
  id: 'AO-0057',
  root: 'r',
  title: TITLE,
  type: 'task',
  priority: 'p1',
  status: 'todo',
  owner: null,
  claimedBy: null,
  leaseUntil: null,
  reviewer: null,
  waitingOn: null,
  checkpoint: null,
  updatedAt: '2026-11-03T12:00:00Z',
  ...over,
});

function click(el: Element): void {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
}

it('links task references in activity titles, outside the row button', async () => {
  const item: ActivityItem = {
    id: EVT,
    at: '2026-11-03T12:00:00Z',
    kind: 'task',
    type: 'comment',
    actor: 'claude:engineer',
    root: 'r',
    task: 'AO-0057',
    title: TITLE,
    body: '',
  };
  answers.set('/api/activity', {
    items: [item],
    next: null,
    total: 1,
    actors: ['claude:engineer'],
    projects: [],
  });
  const n = nav();
  await mount(createElement(Activity, { nav: n }));
  // The feed asks opsd 200 ms after the query settles.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });
  expect(refs()).toEqual([`AO-0014#${EVT}`]);
  expect(box.querySelector('button a')).toBeNull();
  openRow();
  expect(n.openTask).toHaveBeenCalledWith('r/AO-0057');
});

it('links task references in inbox titles, outside the row button', async () => {
  const item: InboxItem = {
    kind: 'message',
    task: 'r/AO-0057',
    root: 'r',
    title: TITLE,
    summary: 'Needs your answer on AO-0020',
  };
  const n = nav();
  await mount(createElement(Inbox, { nav: n, items: [item], error: null }));
  expect(refs()).toEqual([`AO-0014#${EVT}`, 'AO-0020']);
  expect(box.querySelector('button a')).toBeNull();
  openRow();
  expect(n.openTask).toHaveBeenCalledWith('r/AO-0057');
});

it('links task references in list titles; a reference click does not open the row', async () => {
  answers.set('/api/tasks', [task()]);
  const n = nav();
  await mount(createElement(List, { nav: n }));
  expect(refs()).toEqual([`AO-0014#${EVT}`]);
  click(box.querySelector('a[data-task-ref]')!);
  expect(n.openTask).not.toHaveBeenCalled();
  click(box.querySelector('tbody tr')!);
  expect(n.openTask).toHaveBeenCalledWith('r/AO-0057');
});

it('links task references in board cards; a reference click does not open the card', async () => {
  answers.set('/api/tasks', [task()]);
  answers.set('/api/waits', { waits: [] });
  const n = nav();
  await mount(createElement(Board, { nav: n }));
  expect(refs()).toEqual([`AO-0014#${EVT}`]);
  click(box.querySelector('a[data-task-ref]')!);
  expect(n.openTask).not.toHaveBeenCalled();
  click(box.querySelector('[draggable="true"]')!);
  expect(n.openTask).toHaveBeenCalledWith('r/AO-0057');
});

it('links task references in finding titles, outside the row button', async () => {
  answers.set('/api/tasks', [task({ type: 'finding' })]);
  const n = nav();
  await mount(createElement(Findings, { nav: n }));
  expect(refs()).toEqual([`AO-0014#${EVT}`]);
  expect(box.querySelector('button a')).toBeNull();
  openRow();
  expect(n.openTask).toHaveBeenCalledWith('r/AO-0057');
});

it('links task references in knowledge note titles, outside the row button', async () => {
  const note = (slug: string, title: string): KbNote => ({
    root: 'r',
    topic: 'windows',
    slug,
    ref: `windows/${slug}`,
    title,
    author: 'claude:engineer',
    created_at: '2026-11-03T12:00:00Z',
    body: '',
    score: 0,
  });
  answers.set('/api/kb', [note('a', 'Plain note'), note('b', TITLE)]);
  await mount(createElement(Knowledge, { nav: nav() }));
  // Only the second note's row: the first note is open, and its heading has no reference.
  expect(refs()).toEqual([`AO-0014#${EVT}`]);
  expect(box.querySelector('button a')).toBeNull();
  const second = box.querySelectorAll<HTMLButtonElement>('.row-link .row-open')[1]!;
  expect(second.getAttribute('aria-label')).toBe(TITLE);
  click(second);
  // Picked, so its heading links the reference too.
  expect(refs()).toEqual([`AO-0014#${EVT}`, `AO-0014#${EVT}`]);
  expect(second.getAttribute('aria-pressed')).toBe('true');
});

it('links task references in a schedule name, task and prompt', async () => {
  const schedule: Schedule = {
    name: 'Sweep after AO-0014',
    agent: 'claude:engineer',
    every: '1h',
    task: 'r/AO-0057',
    prompt: `Check AO-0014#${EVT} and report`,
    last_run: null,
    next_run: null,
  };
  answers.set('/api/schedules', [schedule]);
  await mount(createElement(Schedules, { nav: nav() }));
  expect(refs()).toEqual(['AO-0014', 'r/AO-0057', `AO-0014#${EVT}`]);
  expect(box.querySelector('button a')).toBeNull();
});

it("links task references in the agents' waiting list, outside the id button", async () => {
  const wait: WaitItem = {
    kind: 'task',
    task: 'r/AO-0057',
    title: TITLE,
    project: 'v2',
    review: false,
    agents: ['claude:engineer'],
    reason: 'Waits on AO-0020',
  };
  answers.set('/api/waits', { providers: {}, waits: [wait] });
  answers.set('/api/settings', { opsd: {} });
  await mount(createElement(Agents, { nav: nav() }));
  expect(refs()).toEqual([`AO-0014#${EVT}`, 'AO-0020']);
  expect(box.querySelector('button a')).toBeNull();
});

it('links task references in the move dialog title; a reference click closes it', async () => {
  function Mover({ t }: { t: Task }) {
    const { request, dialog } = useMover(nav(), () => {});
    useEffect(() => request(t, 'blocked'), []);
    return dialog;
  }
  await mount(createElement(Mover, { t: task({ status: 'in-progress' }) }));
  expect(box.querySelector('[data-modal]')).not.toBeNull();
  expect(refs()).toEqual([`AO-0014#${EVT}`]);
  click(box.querySelector('a[data-task-ref]')!);
  expect(box.querySelector('[data-modal]')).toBeNull();
});

it('links task references in decision options, ballot choices and the outcome choice', async () => {
  const d = decision(true);
  const opt = 'Use AO-0030';
  d.meta.options = [opt, 'US'];
  d.ballots[0]!.choice = opt;
  d.outcome!.choice = opt;
  d.tally.counts = { [opt]: 1 };
  d.tally.leaders = [opt];
  answers.set('/api/decisions', [d]);
  await mount(createElement(Decisions, { nav: nav(), selected: 'r/D-0001' }));
  // Option label, ballot choice and recorded outcome.
  expect(refs().filter((r) => r === 'AO-0030')).toHaveLength(3);
  expect(box.querySelector('button a')).toBeNull();
});

it('scrolls to an event reference again after a plain reference to the same task', async () => {
  const events: OpsEvent[] = [
    { id: EVT, type: 'comment', actor: 'codex:qa', at: '2026-11-03T10:00:00Z', body: 'Note' },
  ];
  answers.set('/api/tasks/r%2FAO-0014', {
    task: task({ id: 'AO-0014', status: 'in-progress' }),
    body: '',
    events,
  });
  const scroll = vi.fn();
  const had = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  const n = nav();
  let open: (ref: string | null) => void = () => {};
  function Panel() {
    const f = useTaskFocus();
    open = f.open;
    return f.task
      ? createElement(TaskPanel, {
          key: f.task,
          id: f.task,
          focus: f.focus ?? undefined,
          nav: n,
          onClose: () => f.open(null),
        })
      : null;
  }
  try {
    await mount(createElement(Panel));
    const go = async (ref: string): Promise<void> => {
      await act(async () => open(ref));
      await act(async () => {});
    };
    await go(`r/AO-0014#${EVT}`);
    expect(scroll).toHaveBeenCalledTimes(1);
    await go('r/AO-0014');
    expect(scroll).toHaveBeenCalledTimes(1);
    await go(`r/AO-0014#${EVT}`);
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally {
    Element.prototype.scrollIntoView = had;
    vi.unstubAllGlobals();
  }
});
