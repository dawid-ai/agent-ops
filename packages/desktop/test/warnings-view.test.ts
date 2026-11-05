// @vitest-environment happy-dom
// opsd accepts some writes with `warnings` (a mention, owner or addressee that no configured agent
// answers to). Every write goes through api(), so the poster sees each warning in a toast, whichever
// view sent it and whether or not that view reads the response.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, warningsOf } from '../ui/src/api';
import { Toaster } from '../ui/src/components';

let host: HTMLDivElement;
let root: Root;
let reply: unknown;
const calls: Array<[string, string]> = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  window.agentOps = {
    call: (method: 'GET' | 'POST', path: string) => {
      calls.push([method, path]);
      return Promise.resolve({ ok: true, data: reply });
    },
  } as unknown as NonNullable<Window['agentOps']>;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(Toaster)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete window.agentOps;
  vi.useRealTimers();
});

const toasts = (): string[] =>
  [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? '');

describe('write warnings', () => {
  it('reads only non-empty string warnings from a response', () => {
    expect(warningsOf({ warnings: ['a', '', 3, 'b'] })).toEqual(['a', 'b']);
    expect(warningsOf({ id: 'x' })).toEqual([]);
    expect(warningsOf(null)).toEqual([]);
    expect(warningsOf('text')).toEqual([]);
  });

  it('shows a channel post warning although the channel view ignores the response', async () => {
    reply = {
      id: 'm1',
      mentions: ['*:orchestrator'],
      warnings: ['mention *:orchestrator matches no configured agent: no run picks it up'],
    };
    await act(async () => {
      await api('POST', '/api/channels/general', {
        as: 'human:dawid',
        message: 'hi @*:orchestrator',
      });
    });
    expect(calls).toEqual([['POST', '/api/channels/general']]);
    expect(toasts()).toEqual([
      'mention *:orchestrator matches no configured agent: no run picks it up',
    ]);
  });

  it('shows every warning of a new task and of a task action', async () => {
    reply = {
      id: 'AO-1',
      warnings: ['owner *:release matches no configured agent: no run picks it up'],
    };
    await act(async () => {
      await api('POST', '/api/tasks', { title: 'x', owner: '*:release' });
    });
    reply = {
      task: { id: 'AO-1' },
      events: [],
      warnings: [
        'addressee *:docs matches no configured agent: no run picks it up',
        'mention *:pm matches no configured agent: no run picks it up',
      ],
    };
    await act(async () => {
      await api('POST', '/api/tasks/AO-1/comment', { body: 'note', to: '*:docs' });
    });
    expect(toasts()).toEqual([
      'owner *:release matches no configured agent: no run picks it up',
      'addressee *:docs matches no configured agent: no run picks it up',
      'mention *:pm matches no configured agent: no run picks it up',
    ]);
  });

  it('stays quiet for a write without warnings and for reads', async () => {
    reply = { id: 'm2', warnings: [] };
    await act(async () => {
      await api('POST', '/api/channels/general', { message: 'plain' });
    });
    reply = { warnings: ['not a write'] };
    await act(async () => {
      await api('GET', '/api/tasks');
    });
    expect(toasts()).toEqual([]);
  });

  it('keeps a warning on screen longer than a confirmation', async () => {
    vi.useFakeTimers();
    reply = { warnings: ['owner *:x matches no configured agent: no run picks it up'] };
    await act(async () => {
      await api('POST', '/api/tasks', { title: 'x' });
    });
    act(() => vi.advanceTimersByTime(7000));
    expect(toasts()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(6000));
    expect(toasts()).toEqual([]);
  });
});
