// @vitest-environment happy-dom
// Back and Forward in the task panel: following a task link while a panel is open keeps the task
// you came from, Back and Forward move through them, a link to the open task adds nothing, and
// closing the panel clears the history. Alt+Left, Alt+Right and the mouse side buttons map to Back
// and Forward.
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import type { TaskHistory } from '../ui/src/lib/history';
import { goBack, goForward, mouseNav, NO_HISTORY, openTask, sameTask } from '../ui/src/lib/history';
import { keyAction } from '../ui/src/lib/keys';
import type { Task, TaskDetail } from '../ui/src/types';
import { useTaskFocus } from '../ui/src/ui/refs';
import { TaskPanel } from '../ui/src/views/TaskPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe('task history', () => {
  const open = (...refs: Array<string | null>): TaskHistory => refs.reduce(openTask, NO_HISTORY);

  it('starts fresh with no panel open and pushes the open task on each link', () => {
    expect(open('AO-0001')).toEqual({ back: [], current: 'AO-0001', forward: [] });
    expect(open('AO-0001', 'AO-0002', 'AO-0003')).toEqual({
      back: ['AO-0001', 'AO-0002'],
      current: 'AO-0003',
      forward: [],
    });
  });

  it('goes back and forward, and a new link clears forward', () => {
    const h = open('AO-0001', 'AO-0002', 'AO-0003');
    const b = goBack(h);
    expect(b).toEqual({ back: ['AO-0001'], current: 'AO-0002', forward: ['AO-0003'] });
    expect(goForward(b)).toEqual(h);
    expect(goBack(goBack(b))).toEqual({
      back: [],
      current: 'AO-0001',
      forward: ['AO-0003', 'AO-0002'],
    });
    expect(openTask(b, 'AO-0009')).toEqual({
      back: ['AO-0001', 'AO-0002'],
      current: 'AO-0009',
      forward: [],
    });
  });

  it('stays put with nothing to go back or forward to', () => {
    const h = open('AO-0001');
    expect(goBack(h)).toBe(h);
    expect(goForward(h)).toBe(h);
    expect(goBack(NO_HISTORY)).toBe(NO_HISTORY);
  });

  it('adds no entry for a link to the task already open, with or without its root', () => {
    const h = open('AO-0001', 'r/AO-0002');
    expect(openTask(h, 'r/AO-0002')).toBe(h);
    expect(openTask(h, 'AO-0002')).toBe(h);
    expect(sameTask('r/AO-0002', 's/AO-0002')).toBe(false);
    expect(openTask(h, 's/AO-0002').back).toEqual(['AO-0001', 'r/AO-0002']);
  });

  it('clears the history when the panel closes', () => {
    expect(open('AO-0001', 'AO-0002', null)).toEqual(NO_HISTORY);
    expect(open('AO-0001', 'AO-0002', null, 'AO-0005')).toEqual({
      back: [],
      current: 'AO-0005',
      forward: [],
    });
  });

  it('maps Alt+Left, Alt+Right and the mouse side buttons', () => {
    const idle = { pendingG: false, typing: false };
    expect(keyAction({ key: 'ArrowLeft', altKey: true }, idle).action).toEqual({ kind: 'back' });
    expect(keyAction({ key: 'ArrowRight', altKey: true }, idle).action).toEqual({
      kind: 'forward',
    });
    // Not while typing (Alt+arrows move by word on some systems), in a dialog, or with more keys.
    expect(
      keyAction({ key: 'ArrowLeft', altKey: true }, { ...idle, typing: true }).action,
    ).toBeNull();
    expect(
      keyAction({ key: 'ArrowLeft', altKey: true }, { ...idle, modal: true }).action,
    ).toBeNull();
    expect(keyAction({ key: 'ArrowLeft', altKey: true, ctrlKey: true }, idle).action).toBeNull();
    expect(keyAction({ key: 'ArrowLeft' }, idle).action).toBeNull();
    expect(mouseNav(3)).toBe('back');
    expect(mouseNav(4)).toBe('forward');
    expect(mouseNav(0)).toBeNull();
    expect(mouseNav(2)).toBeNull();
  });
});

describe('task panel Back and Forward', () => {
  let root: Root | undefined;
  let box: HTMLDivElement;
  /** Each task's thread links the next one: AO-0001 -> AO-0002 -> AO-0003 -> AO-0004. */
  const detail = (n: number): TaskDetail => {
    const id = `AO-000${n}`;
    const t: Task = {
      id,
      root: 'r',
      title: `Task ${n}`,
      type: 'task',
      priority: 'p2',
      status: 'todo',
      owner: null,
      claimedBy: null,
      leaseUntil: null,
      reviewer: null,
      waitingOn: null,
      checkpoint: null,
      updatedAt: '2026-11-05T12:00:00Z',
    };
    return {
      task: t,
      body: '',
      events: [
        {
          id: `01M6NQE48BKAP0S19SPBP8Z2Y${n}`,
          type: 'comment',
          actor: 'claude:pm',
          at: '2026-11-05T12:00:00Z',
          body: `Next: AO-000${n + 1}, and this one: ${id}`,
        },
      ],
    };
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.agentOps = {
      call: (_method: string, path: string) => {
        const m = /^\/api\/tasks\/AO-000(\d)$/.exec(path.split('?')[0]!);
        return Promise.resolve({ ok: true, data: m ? detail(Number(m[1])) : [] });
      },
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

  const nav: Nav = { me: 'human:dawid', openTask: vi.fn(), go: vi.fn() };
  let openRef: (ref: string | null) => void = () => {};

  /** What App does: links open in the panel, and the panel gets Back and Forward. */
  function Harness() {
    const f = useTaskFocus();
    openRef = f.open;
    useEffect(() => {
      const onClick = (e: MouseEvent): void => {
        const el = (e.target as Element | null)?.closest?.('a[data-task-ref]');
        if (!el) return;
        e.preventDefault();
        f.open(el.getAttribute('data-task-ref'));
      };
      document.addEventListener('click', onClick);
      return () => document.removeEventListener('click', onClick);
    }, [f.open]);
    return f.task
      ? createElement(TaskPanel, {
          key: f.task,
          id: f.task,
          nav,
          onClose: () => f.open(null),
          onBack: f.back ?? undefined,
          onForward: f.forward ?? undefined,
        })
      : null;
  }

  const settle = async (): Promise<void> => {
    await act(async () => {});
    await act(async () => {});
  };
  const shown = (): string | null | undefined => box.querySelector('header span')?.textContent;
  const button = (label: string): HTMLButtonElement | null =>
    box.querySelector(`header button[aria-label="${label}"]`);
  const press = async (el: Element): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const follow = async (id: string): Promise<void> => {
    const link = box.querySelector(`a[data-task-ref="${id}"]`);
    expect(link, `link to ${id}`).not.toBeNull();
    await press(link!);
  };

  it('returns through three hops with Back, then forward again', async () => {
    root = createRoot(box);
    await act(async () => root!.render(createElement(Harness)));
    await act(async () => openRef('AO-0001'));
    await settle();
    expect(shown()).toBe('r/AO-0001');
    expect(button('Back')).toBeNull();
    expect(button('Forward')).toBeNull();

    // A link to the open task adds no entry.
    await follow('AO-0001');
    expect(button('Back')).toBeNull();

    await follow('AO-0002');
    await follow('AO-0003');
    await follow('AO-0004');
    expect(shown()).toBe('r/AO-0004');

    await press(button('Back')!);
    expect(shown()).toBe('r/AO-0003');
    expect(button('Forward')).not.toBeNull();
    await press(button('Back')!);
    await press(button('Back')!);
    expect(shown()).toBe('r/AO-0001');
    expect(button('Back')).toBeNull();

    await press(button('Forward')!);
    expect(shown()).toBe('r/AO-0002');
    await press(button('Forward')!);
    await press(button('Forward')!);
    expect(shown()).toBe('r/AO-0004');
    expect(button('Forward')).toBeNull();
  });

  it('shows no Back after the panel closes and a task opens from a view', async () => {
    root = createRoot(box);
    await act(async () => root!.render(createElement(Harness)));
    await act(async () => openRef('AO-0001'));
    await settle();
    await follow('AO-0002');
    expect(button('Back')).not.toBeNull();

    await press(button('Close')!);
    expect(shown()).toBeUndefined();
    await act(async () => openRef('AO-0003'));
    await settle();
    expect(shown()).toBe('r/AO-0003');
    expect(button('Back')).toBeNull();
  });
});
