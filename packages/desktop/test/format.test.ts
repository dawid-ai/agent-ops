import { describe, expect, it } from 'vitest';
import {
  ago,
  columns,
  ownerlessLabel,
  readableLog,
  tokens,
  waitReasons,
} from '../ui/src/lib/format';
import type { Task } from '../ui/src/types';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    root: 'demo',
    title: id,
    type: 'task',
    priority: 'p2',
    status: 'todo',
    owner: null,
    claimedBy: null,
    leaseUntil: null,
    reviewer: null,
    waitingOn: null,
    checkpoint: null,
    updatedAt: '2026-10-31T10:00:00.000Z',
    ...over,
  };
}

describe('ownerless label (AO-0140)', () => {
  it('tells nobody-owns-it-by-design from stuck', () => {
    expect(ownerlessLabel(task('T-1', { type: 'finding' }))).toBe('Waiting for your triage');
    expect(ownerlessLabel(task('T-2', { type: 'idea' }))).toBe('Parked idea');
    expect(ownerlessLabel(task('T-3', { type: 'idea', status: 'parked' }))).toBe('Parked idea');
    // A closed finding, owned work and ownerless work show their owner, or none.
    expect(ownerlessLabel(task('T-4', { type: 'finding', status: 'parked' }))).toBeNull();
    expect(ownerlessLabel(task('T-5', { type: 'finding', owner: 'claude:qa' }))).toBeNull();
    expect(ownerlessLabel(task('T-6'))).toBeNull();
  });
});

describe('board columns', () => {
  it('groups by status, orders by priority, and shows claimable tasks as to do', () => {
    const cols = columns([
      task('T-3', { priority: 'p3' }),
      task('T-1', { priority: 'p0' }),
      task('T-2', { status: 'in-progress', stale: true }),
      task('T-4', { status: 'blocked', unblocked: true }),
      task('T-5', { status: 'needs-review' }),
      task('T-6', { status: 'done', updatedAt: '2026-10-31T09:00:00.000Z' }),
      task('T-7', { status: 'parked', updatedAt: '2026-10-31T11:00:00.000Z' }),
      task('T-8', { status: 'claimed' }),
    ]);
    expect(cols.todo!.map((t) => t.id)).toEqual(['T-1', 'T-2', 'T-4', 'T-3']);
    expect(cols.working!.map((t) => t.id)).toEqual(['T-8']);
    expect(cols.review!.map((t) => t.id)).toEqual(['T-5']);
    expect(cols.done!.map((t) => t.id)).toEqual(['T-7', 'T-6']);
    expect(
      columns([task('a', { status: 'done' }), task('b', { status: 'done' })], 1).done,
    ).toHaveLength(1);
  });
});

describe('formatting', () => {
  it('formats ages and token counts', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(ago('2026-10-31T11:55:00Z', now)).toBe('5m ago');
    expect(ago('2026-10-31T14:00:00Z', now)).toBe('in 2h');
    expect(ago(null, now)).toBe('-');
    expect(tokens(950)).toBe('950');
    expect(tokens(21_703)).toBe('22k');
    expect(tokens(1_500_000)).toBe('1.5M');
  });

  it('turns Claude and Codex logs into readable lines', () => {
    const log = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Starting.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ops start T-1' } },
          ],
        },
      }),
      JSON.stringify({ type: 'result', result: 'Done.', is_error: false }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hi' } }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'ls' },
      }),
      'plain text line',
      '{not json',
    ].join('\n');
    expect(readableLog(log)).toEqual([
      { kind: 'text', text: 'Starting.' },
      { kind: 'tool', text: 'Bash ops start T-1' },
      { kind: 'result', text: 'Done.' },
      { kind: 'text', text: 'Hi' },
      { kind: 'tool', text: '$ ls' },
      { kind: 'raw', text: 'plain text line' },
      { kind: 'raw', text: '{not json' },
    ]);
  });
});

describe('waitReasons', () => {
  it('maps reviews and claims that wait, not inbox runs or ready work', () => {
    const map = waitReasons([
      { kind: 'review', task: 'site/WEB-3', reason: 'codex:qa: codex usage at 93%' },
      { kind: 'task', task: 'site/WEB-1', reason: 'claude:engineer: 1 runs live; max_runs is 1' },
      { kind: 'task', task: 'site/WEB-2', reason: 'starts at the next tick' },
      { kind: 'inbox', reason: 'a run of claude:engineer is live or starting' },
    ]);
    expect([...map]).toEqual([
      ['site/WEB-3', 'codex:qa: codex usage at 93%'],
      ['site/WEB-1', 'claude:engineer: 1 runs live; max_runs is 1'],
    ]);
  });
});
