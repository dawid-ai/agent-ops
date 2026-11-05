import { describe, expect, it } from 'vitest';
import { ACTIVITY_FILTERS, ACTIVITY_KINDS } from '@agent-ops/core';
import {
  ACTIVITY_FILTER_KEYS,
  activityKey,
  activityQuery,
  activityWords,
  appendPage,
  KINDS,
  kindOf,
  mergeFirstPage,
  verbOf,
} from '../ui/src/lib/activity';
import type { ActivityItem } from '../ui/src/types';
import { noteTaskRef, ulidTime } from '../ui/src/lib/format';
import {
  dueLabel,
  dueValue,
  identity,
  markMentions,
  mentionAt,
  priorityInfo,
} from '../ui/src/lib/identity';
import { findTaskRefs, markTaskRefs, parseTaskRef, splitTaskRefs } from '../ui/src/lib/refs';
import {
  findEvent,
  joinArgs,
  mergeEvents,
  pairAnswers,
  splitArgs,
  splitList,
  writtenReducer,
} from '../ui/src/lib/thread';
import { moveRequest, moveTo } from '../ui/src/lib/transitions';
import { quoteArg as dialogQuote } from '../src/runtime-dialog';
import type { OpsEvent, Status } from '../ui/src/types';

const task = (status: Status, over: { stale?: boolean; unblocked?: boolean } = {}) => ({
  status,
  ...over,
});

describe('status moves', () => {
  it('maps each column to the protocol action, asking for input where the protocol needs it', () => {
    expect(moveTo(task('todo'), 'in-progress')).toMatchObject({ action: 'start', needs: 'work' });
    expect(moveTo(task('in-progress'), 'todo')).toMatchObject({ action: 'release' });
    expect(moveTo(task('claimed'), 'needs-review')).toMatchObject({
      action: 'review',
      needs: 'reviewer',
    });
    expect(moveTo(task('blocked'), 'todo')).toMatchObject({ action: 'unblock' });
    expect(moveTo(task('done'), 'todo')).toMatchObject({ action: 'reopen' });
    expect(moveTo(task('parked'), 'todo')).toMatchObject({ action: 'reopen' });
    expect(moveTo(task('needs-review'), 'todo')).toMatchObject({
      action: 'verdict-changes',
      needs: 'reason',
    });
    expect(moveTo(task('todo'), 'blocked')).toMatchObject({ action: 'block', needs: 'reason' });
    expect(moveTo(task('needs-review'), 'done')).toMatchObject({ action: 'done' });
    expect(moveTo(task('todo'), 'parked')).toMatchObject({ action: 'park', needs: 'reason' });
  });

  it('refuses moves the protocol has no single action for', () => {
    expect(moveTo(task('todo'), 'needs-review')).toBeTypeOf('string');
    expect(moveTo(task('blocked'), 'in-progress')).toMatch(/unblock it first/);
    expect(moveTo(task('needs-review'), 'in-progress')).toBeTypeOf('string');
    expect(moveTo(task('done'), 'blocked')).toBeTypeOf('string');
    expect(moveTo(task('done'), 'done')).toBeTypeOf('string');
    expect(moveTo(task('claimed'), 'in-progress')).toBe('already there');
  });

  it('treats a stale or unblocked task as to do', () => {
    expect(moveTo(task('in-progress', { stale: true }), 'in-progress')).toMatchObject({
      action: 'start',
    });
    expect(moveTo(task('blocked', { unblocked: true }), 'todo')).toBe('already there');
  });

  it('builds the request each move sends', () => {
    const changes = moveTo(task('needs-review'), 'todo');
    if (typeof changes === 'string') throw new Error(changes);
    expect(moveRequest(changes, { message: 'fix x' })).toEqual({
      path: 'verdict',
      body: { verdict: 'changes', message: 'fix x' },
    });
    const block = moveTo(task('todo'), 'blocked');
    if (typeof block === 'string') throw new Error(block);
    expect(moveRequest(block, { message: 'key', to: 'claude:pm', on: 'AO-1' })).toEqual({
      path: 'block',
      body: { message: 'key', to: 'claude:pm', on: 'AO-1' },
    });
  });
});

describe('identity and display', () => {
  it('colors providers and roles, with stable colors for unknown names', () => {
    const c = identity('claude:engineer');
    expect(c.provider.label).toBe('Claude');
    expect(c.roleInfo).toMatchObject({ label: 'Engineer', icon: 'engineer' });
    expect(identity('human:dawid')).toMatchObject({ human: true });
    expect(identity('codex:*')).toMatchObject({ wildcard: true });
    expect(identity('*:qa').roleInfo.label).toBe('QA');
    expect(identity('newcli:poet').provider.color).toBe(identity('newcli:x').provider.color);
  });

  it('shows p0 to p3 as Urgent, Medium, Standard, Low', () => {
    expect(['p0', 'p1', 'p2', 'p3'].map((p) => priorityInfo(p).label)).toEqual([
      'Urgent',
      'Medium',
      'Standard',
      'Low',
    ]);
  });

  it('pills mentions in text, never inside tags or code', () => {
    const html =
      '<p>ask @codex:qa or @*:engineer <a href="x@claude:pm">l</a> <code>@claude:qa</code></p>';
    const out = markMentions(html);
    expect(out).toContain('<span class="mention" data-rt="codex">@codex:qa</span>');
    expect(out).toContain('<span class="mention" data-rt="any">@*:engineer</span>');
    expect(out).toContain('href="x@claude:pm"');
    expect(out).toContain('<code>@claude:qa</code>');
    expect(markMentions('mail me@claude:qa')).toBe('mail me@claude:qa');
  });

  it('finds the @ word at the caret for autocomplete', () => {
    expect(mentionAt('hi @cod', 7)).toEqual({ start: 3, query: 'cod' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('mail a@b', 8)).toBeNull();
    expect(mentionAt('hi @codex:qa done', 17)).toBeNull();
  });

  it('turns picked dates into due values: a date alone is the end of that day', () => {
    expect(dueValue('2026-11-03')).toBe('2026-11-03');
    expect(dueValue('2026-11-03', '18:30')).toBe(new Date(2026, 10, 3, 18, 30).toISOString());
    expect(dueValue('')).toBe('');
    const now = new Date(2026, 10, 1, 12, 0).getTime();
    expect(dueLabel(new Date(2026, 10, 1, 18, 0).toISOString(), now)).toMatchObject({
      text: 'Today 18:00',
      overdue: false,
      soon: true,
    });
    expect(dueLabel(new Date(2026, 10, 2, 23, 59).toISOString(), now).text).toBe('Tomorrow');
    expect(dueLabel(new Date(2026, 10, 1, 9, 0).toISOString(), now).overdue).toBe(true);
  });

  it('reads the time from a ULID', () => {
    expect(ulidTime('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(new Date(1469922850259).toISOString());
    expect(ulidTime('nope')).toBeNull();
    expect(ulidTime(null)).toBeNull();
  });
});

describe('learn note links', () => {
  it('opens the source task in the root the note lives in', () => {
    expect(noteTaskRef({ root: 'site', task: 'T-0003' })).toBe('site/T-0003');
    expect(noteTaskRef({ root: 'site' })).toBeNull();
  });
});

describe('activity feed', () => {
  it('reads verdicts by outcome and groups every shown type', () => {
    expect(verbOf({ type: 'verdict', verdict: 'approve' })).toBe('approved');
    expect(verbOf({ type: 'verdict', verdict: 'changes' })).toBe('asked for changes on');
    expect(verbOf({ type: 'post' })).toBe('posted in');
    expect(verbOf({ type: 'something-new' })).toBe('something-new');
    for (const t of ['claim', 'review', 'comment', 'run-end', 'finding', 'retype']) {
      expect(kindOf(t), t).toBeDefined();
    }
    expect(kindOf('renew')).toBeUndefined();
  });

  it('groups types and knows filter keys as the core does', () => {
    expect(Object.fromEntries(KINDS.map((k) => [k.key, k.types]))).toEqual(ACTIVITY_KINDS);
    expect([...ACTIVITY_FILTER_KEYS].sort()).toEqual([...ACTIVITY_FILTERS].sort());
  });

  it('builds the query from the text and the filters, and marks only words', () => {
    expect(activityQuery('  login ', { who: 'codex:qa', project: 'site', kind: 'review' })).toBe(
      'login agent:codex:qa project:site kind:review',
    );
    expect(activityQuery('', {})).toBe('');
    expect(activityWords('Login task:AO-0061 "the page" kind:review status:x')).toEqual([
      'login',
      'the page',
      'status:x',
    ]);
  });

  const item = (n: number): ActivityItem => ({
    id: `01K${String(n).padStart(4, '0')}`,
    at: `2026-11-04T${String(n).padStart(2, '0')}:00:00Z`,
    kind: 'task',
    type: 'comment',
    actor: 'codex:qa',
    root: 'v2',
    body: '',
  });
  // Newest first, as opsd sends them.
  const items = (from: number, to: number): ActivityItem[] => {
    const out: ActivityItem[] = [];
    for (let n = from; n >= to; n--) out.push(item(n));
    return out;
  };

  it('keeps older pages behind a fresh first page, and starts over across a gap', () => {
    const loaded = { items: items(10, 1), next: activityKey(item(1)) };
    // Two new items: the fresh page of 4 overlaps what is loaded.
    const fresh = { items: items(12, 9), next: activityKey(item(9)) };
    const merged = mergeFirstPage(loaded, fresh);
    expect(merged.items.map((i) => i.id)).toEqual(items(12, 1).map((i) => i.id));
    expect(merged.next).toBe(loaded.next);
    // Six new items: the fresh page ends before the old first item, so older pages would leave
    // a hole. Only the fresh page stays.
    const far = { items: items(16, 13), next: activityKey(item(13)) };
    expect(mergeFirstPage(loaded, far)).toEqual(far);
    // A last page replaces everything; nothing loaded keeps the fresh page as it is.
    const all = { items: items(11, 1), next: null };
    expect(mergeFirstPage(loaded, all)).toEqual(all);
    expect(mergeFirstPage(null, fresh)).toEqual(fresh);
  });

  it('appends an older page once per item', () => {
    const got = appendPage(
      { items: items(6, 4), next: activityKey(item(4)) },
      { items: items(4, 2), next: null },
    );
    expect(got.items.map((i) => i.id)).toEqual(items(6, 2).map((i) => i.id));
    expect(got.next).toBeNull();
  });
});

describe('task thread', () => {
  const ev = (id: string, type: string, actor = 'claude:engineer'): OpsEvent => ({
    id,
    type,
    actor,
    at: '2026-11-02T00:00:00Z',
    body: id,
  });

  it('shows events oldest first, each once, with ones this window wrote before the next read', () => {
    const server = [ev('01B', 'comment'), ev('01A', 'ask')];
    const written = [ev('01C', 'answer', 'human:dawid'), ev('01B', 'comment')];
    expect(mergeEvents(server, written).map((e) => e.id)).toEqual(['01A', '01B', '01C']);
  });

  it('pairs each answer with the latest open question before it', () => {
    const events = [
      ev('01A', 'ask'),
      ev('01B', 'answer', 'human:dawid'),
      ev('01C', 'comment', 'human:dawid'),
      ev('01D', 'ask'),
      ev('01E', 'ask'),
      ev('01F', 'answer', 'human:dawid'),
    ];
    const pairs = pairAnswers(events);
    expect(pairs.get('01A')).toBe('01B');
    expect(pairs.get('01B')).toBe('01A');
    expect(pairs.get('01F')).toBe('01E');
    expect(pairs.has('01D')).toBe(false);
    expect(pairs.has('01C')).toBe(false);
  });

  it('splits command lines and lists the way the forms take them', () => {
    expect(splitArgs('run --json "two words" -')).toEqual(['run', '--json', 'two words', '-']);
    expect(splitArgs('   ')).toEqual([]);
    expect(splitArgs('--prefix "" x')).toEqual(['--prefix', '', 'x']);
    expect(splitArgs('C:\\tools\\ "C:\\Program Files\\x\\\\"')).toEqual([
      'C:\\tools\\',
      'C:\\Program Files\\x\\',
    ]);
    expect(splitArgs('"say \\"hi\\"" a\\\\\\"b')).toEqual(['say "hi"', 'a\\"b']);
    expect(splitArgs('--x="a b"c "open')).toEqual(['--x=a bc', 'open']);
    expect(splitList('docs/a.md\n docs/b.md, docs/a.md\n')).toEqual(['docs/a.md', 'docs/b.md']);
  });

  it('opens and saves provider arguments without changing them', () => {
    const cases: string[][] = [
      [],
      [''],
      ['', ''],
      ['--prefix', '', 'x'],
      ['say "hi"', '"', '""', 'a"b'],
      ['C:\\tools\\', 'C:\\Program Files\\x\\', '\\\\server\\share', 'a\\"b', '\\'],
      [' ', '\t', 'two words', ' lead', 'trail '],
      ['--json', '-'],
    ];
    for (const args of cases) expect(splitArgs(joinArgs(args))).toEqual(args);
    // The editor shows arguments the way the confirm dialog does.
    const shown = ['', 'say "hi"', 'C:\\Program Files\\x\\', 'plain'];
    expect(joinArgs(shown)).toBe(shown.map(dialogQuote).join(' '));

    // Every list over a small alphabet of the tricky characters, up to three arguments.
    const alphabet = ['a', ' ', '"', '\\', '\t'];
    const words: string[] = [''];
    for (let len = 1; len <= 4; len++) {
      for (const w of words.filter((x) => x.length === len - 1)) {
        for (const ch of alphabet) words.push(w + ch);
      }
    }
    let i = 0;
    for (const a of words) {
      for (let k = 0; k < 8; k++) {
        const args = [a, words[(i++ * 7919) % words.length]!, words[(i * 104729) % words.length]!];
        expect(splitArgs(joinArgs(args))).toEqual(args);
      }
    }
  });
});

describe('events this window wrote', () => {
  const ev = (id: string): OpsEvent => ({
    id,
    type: 'comment',
    actor: 'human:dawid',
    at: '2026-11-02T00:00:00Z',
    body: 'hello',
  });

  it('shows a written event once after a sync renamed it on the server', () => {
    // The write returned 01A; a coordinated sync then renamed the same event to 01Z.
    let w = writtenReducer({ events: [], waiting: false }, { type: 'wrote', events: [ev('01A')] });
    expect(mergeEvents([], w.events).map((e) => e.id)).toEqual(['01A']);
    w = writtenReducer(w, { type: 'loaded' });
    expect(mergeEvents([ev('01Z')], w.events).map((e) => e.id)).toEqual(['01Z']);
  });

  it('keeps written events until a read after the write returns, and only then', () => {
    let w = writtenReducer({ events: [], waiting: false }, { type: 'loaded' });
    expect(w).toEqual({ events: [], waiting: false });
    w = writtenReducer(w, { type: 'wrote', events: [ev('01A')] });
    w = writtenReducer(w, { type: 'wrote', events: [ev('01B')] });
    expect(w.events.map((e) => e.id)).toEqual(['01A', '01B']);
    expect(writtenReducer(w, { type: 'loaded' })).toEqual({ events: [], waiting: false });
  });
});

describe('task references', () => {
  const evt = '01M6GJ2V0H2HRXQ4991YN9ZWBY';

  it('links task ids, root-qualified ids and event references in rendered text', () => {
    const out = markTaskRefs(`<p>See AO-0047, agent-ops/AO-0012 and AO-0014#${evt}.</p>`);
    expect(out).toContain(
      '<a class="task-ref" href="#AO-0047" data-task-ref="AO-0047" title="Open AO-0047">AO-0047</a>',
    );
    expect(out).toContain('data-task-ref="agent-ops/AO-0012"');
    expect(out).toContain(`data-task-ref="AO-0014#${evt}"`);
    expect(out).toContain('title="Open AO-0014 at this event"');
  });

  it('leaves links, code blocks, attributes and look-alikes alone', () => {
    const link = '<a href="https://x.dev/AO-0047">AO-0047</a>';
    expect(markTaskRefs(link)).toBe(link);
    const pre = '<pre><code>ops show AO-0047</code></pre>';
    expect(markTaskRefs(pre)).toBe(pre);
    expect(markTaskRefs('<img alt="AO-0047">')).toBe('<img alt="AO-0047">');
    for (const s of ['SHA-256', 'AO-47', 'xAO-0047', 'AO-0047-b', 'ao-0047']) {
      expect(markTaskRefs(s)).toBe(s);
    }
    // Inline code still links, so `AO-0047` in backticks opens the task.
    expect(markTaskRefs('<code>AO-0047</code>')).toContain('data-task-ref="AO-0047"');
    // Escaped text after an id does not break it.
    expect(markTaskRefs('AO-0047&#39;s')).toContain('data-task-ref="AO-0047"');
  });

  it('finds references in plain text and splits them into task and event', () => {
    expect(findTaskRefs(`AO-0014#${evt}, then r/AO-0002.`)).toEqual([
      { task: 'AO-0014', event: evt },
      { task: 'r/AO-0002' },
    ]);
    expect(findTaskRefs('Waits for Dawid: see the comment of 2026-11-03.')).toEqual([]);
    expect(parseTaskRef(`r/AO-0014#${evt}`)).toEqual({ task: 'r/AO-0014', event: evt });
    expect(parseTaskRef('AO-0014')).toEqual({ task: 'AO-0014' });
    expect(parseTaskRef('AO-0014#')).toEqual({ task: 'AO-0014' });
  });

  it('splits plain message text into text runs and references for Inbox and Activity', () => {
    expect(splitTaskRefs(`AO-0014: pick a region (see AO-0014#${evt}), then r/AO-0002.`)).toEqual([
      { ref: 'AO-0014' },
      ': pick a region (see ',
      { ref: `AO-0014#${evt}` },
      '), then ',
      { ref: 'r/AO-0002' },
      '.',
    ]);
    expect(splitTaskRefs('Waits for Dawid: see the comment of 2026-11-03.')).toEqual([
      'Waits for Dawid: see the comment of 2026-11-03.',
    ]);
    expect(splitTaskRefs('')).toEqual([]);
    // The text runs and references always join back to the original text.
    const text = `xAO-0047 SHA-256 AO-0047-b <b>AO-0001</b>\nAO-0002#${evt}`;
    const parts = splitTaskRefs(text);
    expect(parts.map((p) => (typeof p === 'string' ? p : p.ref)).join('')).toBe(text);
    expect(parts.filter((p) => typeof p !== 'string')).toEqual([
      { ref: 'AO-0001' },
      { ref: `AO-0002#${evt}` },
    ]);
  });

  it('finds the referenced event by exact id or by its start', () => {
    const events = ['01M6GA9R7JM5M8172YQXCEBZ6A', evt].map((id): OpsEvent => ({
      id,
      type: 'comment',
      actor: 'human:dawid',
      at: '',
      body: '',
    }));
    expect(findEvent(events, evt)?.id).toBe(evt);
    expect(findEvent(events, '01m6gj2v0h')?.id).toBe(evt);
    expect(findEvent(events, '01M6ZZZZZZ')).toBeUndefined();
    expect(findEvent(events, '')).toBeUndefined();
  });
});
