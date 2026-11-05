import { describe, expect, it } from 'vitest';
import { derive, fold, isClaimable, ulid } from '../src/index.js';
import type { OpsEvent, TaskMeta } from '../src/index.js';

const T0 = Date.parse('2026-10-31T10:00:00Z');
const meta: TaskMeta = {
  id: 'T-0001',
  title: 't',
  type: 'task',
  priority: 'p2',
  owner: 'claude:engineer',
  created_by: 'human:dawid',
  created_at: new Date(T0).toISOString(),
};

function ev(minute: number, type: string, actor: string, extra: Partial<OpsEvent> = {}): OpsEvent {
  const ms = T0 + minute * 60_000;
  return { id: ulid(ms), type, actor, at: new Date(ms).toISOString(), body: '', ...extra };
}

describe('fold', () => {
  it('walks the main path', () => {
    const events = [
      ev(1, 'claim', 'claude:engineer'),
      ev(2, 'start', 'claude:engineer'),
      ev(3, 'review', 'claude:engineer', { to: 'codex:qa' }),
    ];
    const s = fold(meta, events);
    expect(s.status).toBe('needs-review');
    expect(s.reviewer).toBe('codex:qa');
    expect(s.claimedBy).toBeNull();
    expect(
      fold(meta, [...events, ev(4, 'verdict', 'codex:qa', { verdict: 'approve' })]).status,
    ).toBe('done');
    expect(
      fold(meta, [...events, ev(4, 'verdict', 'codex:qa', { verdict: 'changes' })]).status,
    ).toBe('todo');
  });

  it('lets the first claim win and records the loser', () => {
    const a = ev(1, 'claim', 'claude:engineer');
    const b = ev(1, 'claim', 'claude:other');
    const s = fold(meta, [b, a]);
    expect(s.claimedBy).toBe(a.id < b.id ? 'claude:engineer' : 'claude:other');
    expect(s.lostClaims).toHaveLength(1);
  });

  it('ignores start, progress and release written under a claim that lost', () => {
    const s = fold(meta, [
      ev(1, 'claim', 'claude:engineer', { token: 'won' }),
      ev(2, 'claim', 'claude:engineer', { token: 'lost' }),
      ev(3, 'start', 'claude:engineer', { holder: 'lost' }),
      ev(4, 'progress', 'claude:engineer', {
        holder: 'lost',
        lease_until: new Date(T0 + 999 * 60_000).toISOString(),
      }),
      ev(5, 'release', 'claude:engineer', { holder: 'lost' }),
    ]);
    expect(s).toMatchObject({ status: 'claimed', claimToken: 'won' });
    expect(s.leaseUntil).not.toBe(new Date(T0 + 999 * 60_000).toISOString());
    expect(s.lostClaims).toHaveLength(3);
  });

  it('applies a release that names the standing claim, by anyone', () => {
    const s = fold(meta, [
      ev(1, 'claim', 'claude:engineer', { token: 'tok' }),
      ev(2, 'release', 'human:dawid', { holder: 'tok' }),
    ]);
    expect(s).toMatchObject({ status: 'todo', claimedBy: null, claimToken: null });
  });

  it('accepts a claim after the earlier lease expired', () => {
    const s = fold(meta, [
      ev(0, 'claim', 'claude:a', { lease_until: new Date(T0 + 30 * 60_000).toISOString() }),
      ev(31, 'claim', 'claude:b'),
    ]);
    expect(s.claimedBy).toBe('claude:b');
  });

  it('rejects a claim while the lease is live', () => {
    const s = fold(meta, [
      ev(0, 'claim', 'claude:a', { lease_until: new Date(T0 + 30 * 60_000).toISOString() }),
      ev(10, 'claim', 'claude:b'),
    ]);
    expect(s.claimedBy).toBe('claude:a');
  });

  it('moves ownership on handoff and clears the claim', () => {
    const s = fold(meta, [
      ev(1, 'claim', 'claude:engineer'),
      ev(2, 'handoff', 'claude:engineer', { to: 'codex:engineer' }),
    ]);
    expect(s).toMatchObject({ status: 'todo', owner: 'codex:engineer', claimedBy: null });
  });

  it('blocks on asks and returns to todo on answer', () => {
    const asked = fold(meta, [
      ev(1, 'claim', 'claude:engineer'),
      ev(2, 'ask', 'claude:engineer', { to: 'human:dawid' }),
    ]);
    expect(asked).toMatchObject({ status: 'blocked', waitingOn: 'human:dawid' });
    const answered = fold(meta, [
      ev(1, 'claim', 'claude:engineer'),
      ev(2, 'ask', 'claude:engineer', { to: 'human:dawid' }),
      ev(3, 'answer', 'human:dawid'),
    ]);
    expect(answered).toMatchObject({ status: 'todo', waitingOn: null });
  });

  it('starts blocked when task.md lists dependencies', () => {
    const s = fold({ ...meta, blocked_by: ['T-0002'] }, []);
    expect(s).toMatchObject({ status: 'blocked', blockedOn: ['T-0002'] });
  });

  it('keeps addressed events for the inbox', () => {
    const s = fold(meta, [
      ev(1, 'comment', 'human:dawid', { to: 'claude:engineer', body: 'Hi\nmore' }),
    ]);
    expect(s.addressed).toEqual([
      expect.objectContaining({ to: 'claude:engineer', summary: 'Hi', type: 'comment' }),
    ]);
  });

  it('ignores unknown event types', () => {
    expect(fold(meta, [ev(1, 'something-new', 'claude:engineer')]).status).toBe('todo');
  });
});

describe('derive', () => {
  it('marks expired leases stale and claimable', () => {
    const s = fold(meta, [
      ev(0, 'claim', 'claude:a', { lease_until: new Date(T0 + 60_000).toISOString() }),
    ]);
    const live = derive(s, 'r', T0 + 30_000, () => undefined);
    const late = derive(s, 'r', T0 + 120_000, () => undefined);
    expect(isClaimable(live)).toBe(false);
    expect(late.stale).toBe(true);
    expect(isClaimable(late)).toBe(true);
  });

  it('unblocks when every dependency is closed', () => {
    const s = fold({ ...meta, blocked_by: ['T-0002', 'T-0003'] }, []);
    expect(derive(s, 'r', T0, (id) => (id === 'T-0002' ? 'done' : 'todo')).unblocked).toBe(false);
    expect(derive(s, 'r', T0, (id) => (id === 'T-0002' ? 'done' : 'parked')).unblocked).toBe(true);
  });
});
