// AO-0099: a finding waiting for triage is one Inbox item with the triage actions, and acting on
// it anywhere clears it; a review item says who asked for what, with the PR or commit.
import { describe, expect, it } from 'vitest';
import { reviewRefs } from '../src/index.js';
import { setup } from './helpers.js';

describe('inbox triage items', () => {
  it('lists an untriaged finding for people only, and drops it once triaged', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'work', priority: 'p3' });
    const eng = as('claude:engineer');
    eng.start('1');
    eng.finding({ title: 'Login retries forever on 401', task: '1' });
    expect(h.inbox()).toEqual([
      expect.objectContaining({
        kind: 'triage',
        task: 'T-0002',
        from: 'claude:engineer',
        summary: 'finding to triage: Login retries forever on 401',
        priority: 'p2',
      }),
    ]);
    // Agents never triage, so their inbox stays clear of it.
    expect(
      as('claude:qa')
        .inbox()
        .map((i) => i.kind),
    ).not.toContain('triage');
    // Accepting it (from the Findings view or the Inbox: the same retype) clears it.
    h.retype('2', 'task', 'Accepted in triage');
    expect(h.inbox().map((i) => i.kind)).not.toContain('triage');
  });

  it('leaves a finding another person owns to that person', () => {
    const { as } = setup();
    as('claude:engineer').finding({ title: 'f', owner: 'human:anna' });
    expect(as('human:dawid').inbox()).toEqual([]);
    expect(
      as('human:anna')
        .inbox()
        .map((i) => i.kind),
    ).toEqual(['triage']);
  });

  it('carries an open question on the triage item and answers it with Accept, in one write', () => {
    const { as } = setup();
    const h = as('human:dawid');
    as('claude:engineer').finding({ title: 'Route needs a guard' });
    const eng = as('codex:engineer', { force: true });
    eng.start('1', 'plan');
    const ask = as('codex:engineer').ask('1', 'Push the branch, or wait for review?');
    // One item, not a triage item and an ask: triage comes first and the question rides on it.
    const items = h.inbox();
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'triage',
        question: {
          event: ask.events[0]!.id,
          from: 'codex:engineer',
          summary: 'Push the branch, or wait for review?',
        },
      }),
    ]);
    const res = h.retype('1', 'task', 'Accepted in triage', {
      to: 'codex:engineer',
      answer: 'Wait for review',
    });
    expect(res.events.map((e) => e.type)).toEqual(['retype', 'assign', 'answer']);
    expect(res.events[2]).toMatchObject({ to: 'codex:engineer', body: 'Wait for review' });
    expect(res.view.status).toBe('todo');
    expect(h.inbox()).toEqual([]);
  });

  it('turns an idea into a task with an owner and a priority in one write (AO-0144)', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Dark mode', type: 'idea' });
    const res = h.retype('1', 'task', 'Made a task from the idea', {
      to: 'claude:engineer',
      priority: 'p1',
    });
    expect(res.events.map((e) => e.type)).toEqual(['retype', 'priority', 'assign']);
    expect(res.view).toMatchObject({
      status: 'todo',
      owner: 'claude:engineer',
      meta: expect.objectContaining({ type: 'task', priority: 'p1' }),
    });
    expect(
      as('claude:engineer')
        .queue()
        .map((v) => v.meta.id),
    ).toEqual(['T-0001']);
  });

  it('leaves out an unchanged priority and refuses a bad one', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Dark mode', type: 'idea', priority: 'p2' });
    expect(() => h.retype('1', 'task', '', { priority: 'p9' as never })).toThrow(/bad priority/);
    const res = h.retype('1', 'bug', '', { priority: 'p2' });
    expect(res.events.map((e) => e.type)).toEqual(['retype']);
  });

  it('accepts without an answer and keeps the question as an ask item until answered', () => {
    const { as } = setup();
    const h = as('human:dawid');
    as('claude:engineer').finding({ title: 'f' });
    as('codex:engineer', { force: true }).start('1', 'plan');
    as('codex:engineer').ask('1', 'Which way?');
    h.retype('1', 'bug', 'Accepted in triage');
    expect(h.inbox()).toEqual([expect.objectContaining({ kind: 'ask', summary: 'Which way?' })]);
    // Mark all read clears messages only: the ask stays until answered.
    h.inbox(undefined, { markRead: true });
    expect(h.inbox().map((i) => i.kind)).toEqual(['ask']);
  });

  it('accepts to a new owner without an answer and keeps the question open (AO-0111)', () => {
    const { as } = setup();
    const h = as('human:dawid');
    as('claude:engineer').finding({ title: 'f' });
    as('codex:engineer', { force: true }).start('1', 'plan');
    const ask = as('codex:engineer').ask('1', 'Which way?');
    const res = h.retype('1', 'bug', 'Accepted in triage', { to: 'claude:engineer' });
    expect(res.events.map((e) => e.type)).toEqual(['retype', 'assign']);
    expect(res.events[1]).toMatchObject({ to: 'claude:engineer', keep_wait: true });
    expect(res.view).toMatchObject({
      status: 'blocked',
      owner: 'claude:engineer',
      waitingOn: 'human:dawid',
      waitEvent: ask.events[0]!.id,
      askedBy: 'codex:engineer',
    });
    expect(h.inbox()).toEqual([expect.objectContaining({ kind: 'ask', summary: 'Which way?' })]);
    // Answering later frees the task for its new owner.
    h.answer('1', 'This way');
    expect(h.view('1')).toMatchObject({
      status: 'todo',
      owner: 'claude:engineer',
      waitingOn: null,
    });
    expect(h.inbox()).toEqual([]);
  });

  it('accepts to a new owner without an answer and keeps the wait on another task', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'dep' });
    as('claude:engineer').finding({ title: 'f' });
    const eng = as('codex:engineer', { force: true });
    eng.start('2', 'plan');
    as('codex:engineer').block('2', 'needs dep', { on: ['1'] });
    const res = h.retype('2', 'task', '', { to: 'claude:engineer' });
    expect(res.view).toMatchObject({ status: 'blocked', blockedOn: ['T-0001'] });
  });

  it('keeps the question open for a plain assign of a blocked task (AO-0115)', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'x', owner: 'codex:engineer' });
    as('codex:engineer').start('1');
    const ask = as('codex:engineer').ask('1', 'Which way?');
    const res = h.assign('1', 'claude:engineer');
    expect(res.events[0]).toMatchObject({ type: 'assign', keep_wait: true });
    expect(res.view).toMatchObject({
      status: 'blocked',
      owner: 'claude:engineer',
      claimedBy: null,
      waitingOn: 'human:dawid',
      waitEvent: ask.events[0]!.id,
      askedBy: 'codex:engineer',
    });
    expect(h.inbox()).toEqual([expect.objectContaining({ kind: 'ask', summary: 'Which way?' })]);
    // Unblock still drops the question on purpose.
    expect(h.unblock('1').view).toMatchObject({ status: 'todo', waitingOn: null });
  });

  it('keeps the wait on another task for a plain assign (AO-0115)', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'dep' });
    h.newTask({ title: 'x', owner: 'codex:engineer' });
    as('codex:engineer').start('2');
    as('codex:engineer').block('2', 'needs dep', { on: ['1'] });
    expect(h.assign('2', 'claude:engineer').view).toMatchObject({
      status: 'blocked',
      owner: 'claude:engineer',
      blockedOn: ['T-0001'],
    });
  });

  it('writes no keep_wait when the assigned task is not blocked', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'x', owner: 'codex:engineer' });
    as('codex:engineer').start('1');
    const res = h.assign('1', 'claude:engineer');
    expect(res.events[0]).not.toHaveProperty('keep_wait');
    expect(res.view).toMatchObject({ status: 'todo', owner: 'claude:engineer', claimedBy: null });
  });

  it('still clears the wait when the owner hands a blocked task off', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'x', owner: 'codex:engineer' });
    const eng = as('codex:engineer');
    eng.start('1');
    eng.ask('1', 'Which way?');
    expect(eng.handoff('1', 'claude:engineer', 'yours').view).toMatchObject({
      status: 'todo',
      owner: 'claude:engineer',
      waitingOn: null,
    });
    expect(h.inbox().map((i) => i.kind)).not.toContain('ask');
  });

  it('refuses an answer with Accept when nothing waits for one, and writes nothing', () => {
    const { as } = setup();
    const h = as('human:dawid');
    as('claude:engineer').finding({ title: 'f' });
    expect(() => h.retype('1', 'task', '', { answer: 'yes' })).toThrow(/cannot answer/);
    expect(h.view('1').meta.type).toBe('finding');
  });
});

describe('inbox review items', () => {
  it('show the latest review request: who asked, its text, the PR, commit and branch', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'x', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    eng.start('1');
    eng.review('1', 'first round');
    h.verdict('1', 'changes', 'fix it');
    eng.start('1');
    const long = `Commit 5a42cf3 on branch claude/ao-0057-references, PR: https://github.com/o/r/pull/68. ${'More detail. '.repeat(20)}`;
    const req = eng.review('1', long);
    const [item] = h.inbox();
    expect(item).toMatchObject({
      kind: 'review',
      event: req.events[0]!.id,
      from: 'claude:engineer',
      at: req.events[0]!.at,
      pr: 'https://github.com/o/r/pull/68',
      commit: '5a42cf3',
      branch: 'claude/ao-0057-references',
      detail: long.trim(),
    });
    expect(item!.summary).toMatch(/^Commit 5a42cf3 on branch .*…$/);
    expect(item!.summary.length).toBeLessThanOrEqual(160);
  });

  it('keeps a short request whole in the summary, with no detail', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x', owner: 'claude:engineer' });
    as('claude:engineer').start('1');
    as('claude:engineer').review('1', 'Check the README wording');
    const [item] = as('human:dawid').inbox();
    expect(item).toMatchObject({ kind: 'review', summary: 'Check the README wording' });
    expect(item!.detail).toBeUndefined();
    expect(item!.pr).toBeUndefined();
  });
});

describe('reviewRefs', () => {
  it('finds a PR, a commit and a branch, and skips look-alikes', () => {
    expect(
      reviewRefs('PR: https://gitlab.com/g/p/-/merge_requests/12 (commit c62c665..fb38960)'),
    ).toEqual({ pr: 'https://gitlab.com/g/p/-/merge_requests/12', commit: 'c62c665' });
    expect(reviewRefs('the branch is defaced; 1234567 tests; see `out/x`')).toEqual({});
    expect(reviewRefs('on branch `codex/ao-0093`.')).toEqual({ branch: 'codex/ao-0093' });
  });
});
