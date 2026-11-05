import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyAction } from '../ui/src/lib/keys';
import {
  channelUrl,
  enterTarget,
  highlightParts,
  isCurrent,
  openable,
  openHit,
  parseChannelTarget,
  queryWords,
  searchRunner,
} from '../ui/src/lib/search';
import type { SearchHit, SearchResult } from '../ui/src/types';

describe('search helpers', () => {
  it('marks free words and phrases, never filters', () => {
    expect(queryWords('Tray "go with 3" agent:codex status:blocked claude:engineer')).toEqual([
      'tray',
      'go with 3',
      'claude:engineer',
    ]);
    expect(queryWords('agent:')).toEqual(['agent:']);
    expect(queryWords('')).toEqual([]);
  });

  it('splits text into marked parts, case-insensitive, longest word first', () => {
    expect(highlightParts('The Tray and trays', ['tray'])).toEqual([
      { text: 'The ', hit: false },
      { text: 'Tray', hit: true },
      { text: ' and ', hit: false },
      { text: 'tray', hit: true },
      { text: 's', hit: false },
    ]);
    expect(highlightParts('a.b(c)', ['b(c'])).toEqual([
      { text: 'a.', hit: false },
      { text: 'b(c', hit: true },
      { text: ')', hit: false },
    ]);
    expect(highlightParts('plain', [])).toEqual([{ text: 'plain', hit: false }]);
  });

  it('focuses search with Ctrl+F, also while typing, but not in a dialog', () => {
    const idle = { pendingG: false, typing: false };
    expect(keyAction({ key: 'f', ctrlKey: true }, idle).action).toEqual({ kind: 'find' });
    expect(keyAction({ key: 'F', metaKey: true }, { ...idle, typing: true }).action).toEqual({
      kind: 'find',
    });
    expect(keyAction({ key: 'f', ctrlKey: true }, { ...idle, modal: true }).action).toBeNull();
    expect(keyAction({ key: 'f' }, idle).action).toBeNull();
  });
});

describe('search review fixes (round 1)', () => {
  it('keeps an unclosed phrase whole, like the core', () => {
    expect(queryWords('"go wi')).toEqual(['go wi']);
    expect(queryWords('tray "agent:codex')).toEqual(['tray', 'agent:codex']);
    expect(queryWords('"')).toEqual([]);
  });

  it('opens a picked row on Enter only while the rows belong to the current text', () => {
    expect(enterTarget({ current: true, pick: 1, count: 3 })).toBe(1);
    // The text changed and the debounce has not answered yet: search the new text instead.
    expect(enterTarget({ current: false, pick: 1, count: 3 })).toBe('all');
    expect(enterTarget({ current: true, pick: -1, count: 3 })).toBe('all');
    expect(enterTarget({ current: true, pick: 5, count: 3 })).toBe('all');
  });

  it('opens each kind of result where it lives, votes with their root', () => {
    const calls: unknown[][] = [];
    const nav = {
      openTask: (id: string) => calls.push(['task', id]),
      go: (view: string, arg?: string) => calls.push([view, arg]),
    };
    const base = { field: 'body', snippet: '', at: '', score: 0, title: '' };
    openHit(nav, { ...base, kind: 'task', ref: 'agent-ops/AO-0047' });
    openHit(nav, { ...base, kind: 'note', ref: 'windows/tray', root: 'agent-ops' });
    openHit(nav, { ...base, kind: 'post', ref: '#general' });
    openHit(nav, { ...base, kind: 'vote', ref: 'D-0001', root: 'agent-ops' });
    expect(calls).toEqual([
      ['task', 'agent-ops/AO-0047'],
      ['knowledge', 'agent-ops/windows/tray'],
      ['channels', 'general'],
      ['decisions', 'agent-ops/D-0001'],
    ]);
  });
});

describe('search review fixes (round 3)', () => {
  const hit = (ref: string): SearchHit => ({
    kind: 'task',
    ref,
    title: ref,
    field: 'title',
    snippet: '',
    at: '',
    score: 0,
  });

  /** A fetch whose answers the test releases one by one, in any order. */
  function deferredFetch() {
    const pending = new Map<string, (r: SearchResult) => void>();
    const asked: string[] = [];
    const fetch = (text: string): Promise<SearchResult> =>
      new Promise((resolve) => {
        asked.push(text);
        pending.set(text, resolve);
      });
    const answer = async (text: string, hits: SearchHit[], partial = false): Promise<void> => {
      pending.get(text)!({ hits, partial });
      await Promise.resolve();
    };
    return { fetch, answer, asked };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not open an old row clicked after the text changed and before the answer', async () => {
    const f = deferredFetch();
    const runner = searchRunner(f.fetch, () => undefined);
    const opened: string[] = [];
    // What a row's click does in both views: open only through `openable`.
    const click = (query: string, h: SearchHit): void => {
      const ok = openable(runner.state(), query, h);
      if (ok) opened.push(ok.ref);
    };
    runner.query('tray');
    vi.advanceTimersByTime(200);
    await f.answer('tray', [hit('r/T-0001')]);
    expect(isCurrent(runner.state(), 'tray')).toBe(true);
    click('tray', hit('r/T-0001'));
    // The text changes; inside the debounce, and then while the request is out, the old row
    // stays on screen but does not open.
    runner.query('tray icon');
    expect(runner.state().hits).toEqual([hit('r/T-0001')]);
    click('tray icon', runner.state().hits![0]!);
    vi.advanceTimersByTime(200);
    expect(f.asked).toEqual(['tray', 'tray icon']);
    click('tray icon', runner.state().hits![0]!);
    await f.answer('tray icon', [hit('r/T-0002')]);
    click('tray icon', runner.state().hits![0]!);
    expect(opened).toEqual(['r/T-0001', 'r/T-0002']);
  });

  it('keeps the newest answer when an older one arrives later', async () => {
    const f = deferredFetch();
    const runner = searchRunner(f.fetch, () => undefined);
    runner.query('a');
    vi.advanceTimersByTime(200);
    runner.query('ab');
    vi.advanceTimersByTime(200);
    expect(f.asked).toEqual(['a', 'ab']);
    await f.answer('ab', [hit('r/T-0002')]);
    await f.answer('a', [hit('r/T-0001')]);
    expect(runner.state()).toMatchObject({ forText: 'ab', hits: [hit('r/T-0002')], busy: false });
    expect(isCurrent(runner.state(), 'ab')).toBe(true);
    expect(openable(runner.state(), 'a', hit('r/T-0001'))).toBeNull();
  });

  it('keeps whether the answer is partial, and clears it with the text', async () => {
    const f = deferredFetch();
    const runner = searchRunner(f.fetch, () => undefined);
    runner.query('heron');
    vi.advanceTimersByTime(200);
    await f.answer('heron', [hit('r/T-0001')], true);
    expect(runner.state()).toMatchObject({ forText: 'heron', partial: true });
    runner.query('');
    expect(runner.state().partial).toBe(false);
  });

  it('sends one request per pause in typing, and none for empty text', () => {
    const f = deferredFetch();
    const runner = searchRunner(f.fetch, () => undefined);
    runner.query('t');
    vi.advanceTimersByTime(100);
    runner.query('tr');
    vi.advanceTimersByTime(100);
    runner.query('tra');
    vi.advanceTimersByTime(200);
    runner.query('   ');
    vi.advanceTimersByTime(500);
    expect(f.asked).toEqual(['tra']);
    expect(runner.state()).toMatchObject({ hits: undefined, busy: false });
    runner.query('x');
    runner.stop();
    vi.advanceTimersByTime(500);
    expect(f.asked).toEqual(['tra']);
  });

  it('opens a post in its root at that message, and reads the target back', () => {
    const calls: unknown[][] = [];
    const nav = {
      openTask: (id: string) => calls.push(['task', id]),
      go: (view: string, arg?: string) => calls.push([view, arg]),
    };
    openHit(nav, {
      ...hit('#general'),
      kind: 'post',
      root: 'other',
      event: '01M6G87BF4D4NEJK2RB4R6MA8Q',
    });
    expect(calls).toEqual([['channels', 'general?root=other&msg=01M6G87BF4D4NEJK2RB4R6MA8Q']]);
    expect(parseChannelTarget(calls[0]![1] as string)).toEqual({
      channel: 'general',
      root: 'other',
      msg: '01M6G87BF4D4NEJK2RB4R6MA8Q',
    });
    expect(parseChannelTarget('general')).toEqual({ channel: 'general' });
    expect(parseChannelTarget(undefined)).toEqual({});
    expect(channelUrl('general')).toBe('/api/channels/general?limit=200');
    expect(channelUrl('general', { root: 'other', msg: '01M6' })).toBe(
      '/api/channels/general?limit=200&root=other&around=01M6',
    );
    // Without a message, a root alone does not narrow the channel.
    expect(channelUrl('general', { root: 'other' })).toBe('/api/channels/general?limit=200');
  });
});
