import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initRoot, OpsError, Root, searchSources, Workspace } from '../src/index.js';
import { fakeToken, gitRepo, setup } from './helpers.js';

describe('tasks', () => {
  it('lets a helper run comment on a task but never change its state', () => {
    const { as, env, repo } = setup();
    as('human:dawid').newTask({ title: 'x', owner: 'claude:engineer' });
    as('claude:engineer', { run: 'PARENT' }).start('1', 'plan');
    // The same pinned owner, as a helper: owner checks alone would let it through.
    const helper = as('claude:engineer', { run: 'HELPER', helper: true });
    for (const act of [
      () => helper.done('1', 'x'),
      () => helper.review('1', 'x', 'codex:qa'),
      () => helper.handoff('1', 'codex:engineer', 'x'),
      () => helper.ask('1', 'x'),
      () => helper.block('1', 'x'),
      () => helper.delegate('1', 'codex:engineer'),
      () => helper.release('1', 'x'),
    ]) {
      expect(act).toThrow(/helper run cannot change task state/);
    }
    helper.comment('1', 'found the cause in foo.ts');
    const fromEnv = new Workspace({
      cwd: repo,
      env: { ...env, OPS_AGENT: 'claude:engineer', OPS_RUN: 'H2', OPS_PARENT_RUN: 'PARENT' },
    });
    expect(fromEnv.helper).toBe(true);
    expect(() => fromEnv.done('1', 'x')).toThrow(/helper run/);
  });

  it('lets only the holder act on a claimed *:role task, and checks the reviewer against it', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    const claude = as('claude:engineer');
    claude.start('1', 'plan');
    const codex = as('codex:engineer');
    expect(() => codex.review('1', 'mine now', 'claude:qa')).toThrow(/held by claude:engineer/);
    expect(() => codex.release('1', 'x')).toThrow(/held by claude:engineer/);
    // The author is the holder, whoever sends it: a Claude reviewer is refused.
    expect(() => claude.review('1', 'check', 'claude:qa')).toThrow(
      /another provider than the author \(claude\)/,
    );
    claude.review('1', 'check', 'codex:qa');
    // Before anyone holds it, any engineer may act as its owner.
    as('human:dawid').newTask({ title: 'y', owner: '*:engineer' });
    codex.comment('2', 'looking');
    as('human:dawid').delegate('2', '*:engineer', { review: 'claude:qa' });
  });

  it('records the run that claimed, and lets only that run act on the claim', () => {
    const { as, rootDir } = setup();
    as('human:dawid').newTask({ title: 'x', owner: 'claude:engineer' });
    const runA = as('claude:engineer', { run: 'RUN-A' });
    runA.claim('1');
    expect(new Root(rootDir).claimRecord('T-0001')).toMatchObject({ run: 'RUN-A' });
    expect(() => as('claude:engineer', { run: 'RUN-B' }).progress('1', 'x')).toThrow(
      /another run on this PC/,
    );
    runA.start('1', 'plan');
    // No run: a person or the supervisor acting as the agent.
    as('claude:engineer').progress('1', 'from the supervisor');
    // A claim taken without a run belongs to no run until it is bound to one.
    as('human:dawid').newTask({ title: 'y', owner: 'claude:engineer' });
    as('claude:engineer').claim('2');
    expect(as('claude:engineer').holdsClaim('2')).toBe(true);
    expect(as('claude:engineer', { run: 'RUN-B' }).holdsClaim('2')).toBe(false);
    expect(() => as('claude:engineer', { run: 'RUN-B' }).release('2', 'x')).toThrow(/another run/);
    as('claude:engineer', { run: 'RUN-B' }).bindClaim('2');
    expect(as('claude:engineer', { run: 'RUN-B' }).holdsClaim('2')).toBe(true);
    expect(as('claude:engineer', { run: 'RUN-A' }).holdsClaim('2')).toBe(false);
    expect(() => as('codex:engineer', { run: 'RUN-C' }).bindClaim('2')).toThrow(
      /not held by codex:engineer/,
    );
  });

  it('keeps claim records of different tasks written at the same time', () => {
    const { rootDir } = setup();
    const first = new Root(rootDir);
    const second = new Root(rootDir);
    // Another process records its claim on T-0002 between this one's read and write.
    const write = first.writeAtomic.bind(first);
    let injected = false;
    first.writeAtomic = (path: string, content: string) => {
      if (!injected) {
        injected = true;
        second.rememberClaim('T-0002', 'second');
      }
      write(path, content);
    };
    first.rememberClaim('T-0001', 'first');
    expect(injected).toBe(true);
    const fresh = new Root(rootDir);
    expect(fresh.myClaim('T-0001')).toBe('first');
    expect(fresh.myClaim('T-0002')).toBe('second');
  });

  it('writes each new event after the newest one, even with a clock behind it', () => {
    const { as } = setup();
    const ahead = as('human:dawid', { now: () => Date.now() + 3600_000 });
    ahead.newTask({ title: 't' });
    ahead.comment('1', 'first');
    as('human:dawid', { now: () => Date.now() - 3600_000 }).comment('1', 'second');
    expect(
      as('human:dawid')
        .showEvents('1')
        .events.map((e) => e.body.trim()),
    ).toEqual(['first', 'second']);
  });

  it('allocates sequential ids in the machine block', () => {
    const { as } = setup({ prefix: 'ao' });
    const ws = as('human:dawid');
    expect(ws.newTask({ title: 'one' }).id).toBe('AO-0001');
    expect(ws.newTask({ title: 'two' }).id).toBe('AO-0002');
    const other = as('human:dawid', { user: { id_block: 1 } });
    expect(other.newTask({ title: 'three' }).id).toBe('AO-10001');
    expect(ws.newTask({ title: 'four' }).id).toBe('AO-0003');
  });

  it('resolves bare numbers and lower-case ids', () => {
    const { as } = setup();
    const ws = as('human:dawid');
    ws.newTask({ title: 'one' });
    expect(ws.resolve('1').id).toBe('T-0001');
    expect(ws.resolve('t-1').id).toBe('T-0001');
    expect(ws.resolve('test/T-0001').id).toBe('T-0001');
    expect(() => ws.resolve('T-0009')).toThrow(OpsError);
  });

  it('refuses secrets in titles, bodies and events', () => {
    const { as } = setup();
    const ws = as('human:dawid');
    expect(() => ws.newTask({ title: 'x', body: fakeToken() })).toThrow(
      /looks like a GitHub token/,
    );
    ws.newTask({ title: 'ok' });
    expect(() => ws.comment('1', `here ${fakeToken()}`)).toThrow(/Nothing was written/);
  });
});

describe('queue', () => {
  it('orders by priority, then age, and honors owners and can_claim', () => {
    const { as, rootDir } = setup();
    writeFileSync(
      join(rootDir, 'agents', 'claude-writer.md'),
      '---\nid: claude:writer\ncan_claim: [doc]\n---\n# Writer\n',
    );
    // Once any agent is defined, an owner must be one of them.
    writeFileSync(join(rootDir, 'agents', 'codex-engineer.md'), '---\nid: codex:engineer\n---\n');
    const h = as('human:dawid');
    h.newTask({ title: 'low', priority: 'p3' });
    h.newTask({ title: 'high', priority: 'p0' });
    h.newTask({ title: 'mine', owner: 'codex:engineer' });
    h.newTask({ title: 'doc', type: 'doc' });
    h.newTask({ title: 'runtime', owner: 'claude:*' });
    expect(
      as('codex:engineer')
        .queue()
        .map((v) => v.meta.title),
    ).toEqual(['high', 'mine', 'doc', 'low']);
    expect(
      as('claude:writer')
        .queue()
        .map((v) => v.meta.title),
    ).toEqual(['doc', 'runtime']);
    expect(as('human:dawid').queue()).toEqual([]);
  });

  it('keeps unowned work from read-only roles that have no can_claim (AO-0136)', () => {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'task' });
    h.newTask({ title: 'bug', type: 'bug' });
    h.newTask({ title: 'feature', type: 'feature' });
    h.newTask({ title: 'for qa', owner: 'claude:qa' });
    for (const id of ['claude:qa', 'codex:reviewer', 'claude:orchestrator']) {
      const titles = as(id)
        .queue()
        .map((v) => v.meta.title);
      expect(titles).not.toContain('task');
      expect(titles).not.toContain('bug');
      expect(titles).not.toContain('feature');
    }
    // The orchestrator stays privileged: it may still claim by id, as a person may.
    for (const id of ['claude:qa', 'codex:reviewer']) {
      expect(() => as(id).claim('1')).toThrow(/owned by nobody/);
    }
    // Work assigned to the role by name stays its own to take.
    expect(
      as('claude:qa')
        .queue()
        .map((v) => v.meta.title),
    ).toEqual(['for qa']);
    expect(as('claude:engineer').queue()).toHaveLength(3);
    // A role file's can_claim widens it again.
    writeFileSync(
      join(rootDir, 'agents', 'codex-reviewer.md'),
      '---\nid: codex:reviewer\ncan_claim: [bug]\n---\n',
    );
    expect(as('codex:reviewer').claim('2').view.claimedBy).toBe('codex:reviewer');
  });

  it('skips paused agents', () => {
    const { as, rootDir } = setup();
    writeFileSync(join(rootDir, 'agents', 'claude-qa.md'), '---\nstatus: paused\n---\n');
    as('human:dawid').newTask({ title: 'x' });
    expect(as('claude:qa').queue()).toEqual([]);
  });
});

describe('claims and ownership', () => {
  it('lets one agent claim and refuses the next', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x' });
    expect(as('claude:engineer').claim('1').view.claimedBy).toBe('claude:engineer');
    expect(() => as('codex:engineer').claim('1')).toThrow(/claimed by claude:engineer/);
  });

  it('keeps ideas out of the queue but lets them be claimed by id', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'an idea', type: 'idea', owner: 'claude:engineer' });
    h.newTask({ title: 'unowned idea', type: 'idea' });
    h.newTask({ title: 'work', priority: 'p3' });
    const eng = as('claude:engineer');
    expect(eng.queue().map((v) => v.meta.title)).toEqual(['work']);
    expect(eng.next()?.meta.title).toBe('work');
    expect(eng.claim('1').view.claimedBy).toBe('claude:engineer');
  });

  it('keeps untriaged findings out of the queue until a person accepts them', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'work', priority: 'p3' });
    const eng = as('claude:engineer');
    eng.start('1');
    eng.finding({ title: 'a finding', task: '1' });
    const other = as('codex:engineer');
    expect(other.queue().map((v) => v.meta.title)).toEqual([]);
    expect(() => other.claim('2')).toThrow(/waits for triage.*--force/);
    expect(() => other.start('2', 'plan')).toThrow(/waits for triage.*--force/);
    expect(() => h.claim('2')).toThrow(/waits for triage/);
    const forced = as('codex:engineer', { force: true }).claim('2');
    expect(forced.events.at(-1)).toMatchObject({ type: 'claim', forced: true });
    // Holding a claim does not skip triage: starting under it still needs --force.
    expect(() => other.start('2', 'plan')).toThrow(/waits for triage.*--force/);
    const started = as('codex:engineer', { force: true }).start('2', 'plan');
    expect(started.events.at(-1)).toMatchObject({ type: 'start', forced: true });
    as('codex:engineer', { force: true }).release('2');
    h.retype('2', 'task', 'Accepted in triage');
    expect(other.queue().map((v) => v.meta.title)).toEqual(['a finding']);
    expect(other.claim('2').view.claimedBy).toBe('codex:engineer');
  });

  it('files new work by an agent as a proposal unless it breaks down an approved task', () => {
    const { as } = setup();
    const h = as('human:dawid');
    const pm = as('claude:pm');
    // Humans and the orchestrator create tasks directly.
    expect(h.addTask({ title: 'approved' })).toEqual({
      meta: expect.objectContaining({ type: 'task' }),
    });
    expect(as('claude:orchestrator').addTask({ title: 'orch' }).meta.type).toBe('task');
    // An agent without --parent files a finding that names the type it proposed.
    const top = pm.addTask({ title: 'new idea of work', type: 'bug', body: 'why' });
    expect(top.meta.type).toBe('finding');
    expect(top.proposed).toMatch(/no --parent/);
    expect(pm.showEvents(top.meta.id).body).toMatch(/why\n\nProposed by claude:pm as a bug\./);
    // Ideas and findings are not work: they pass as filed.
    expect(pm.addTask({ title: 'later', type: 'idea' }).meta.type).toBe('idea');
    // A subtask of a task the human created inherits the approval, and so do its own subtasks.
    const sub = pm.addTask({ title: 'step 1', parent: '1' });
    expect(sub).toEqual({ meta: expect.objectContaining({ type: 'task', parent: 'T-0001' }) });
    expect(pm.addTask({ title: 'step 1a', parent: sub.meta.id }).meta.type).toBe('task');
    // A subtask of an untriaged finding is a proposal too.
    expect(pm.addTask({ title: 'under a finding', parent: top.meta.id }).proposed).toMatch(
      /waits for triage/,
    );
    // An agent's task the human accepted (retype) or assigned counts as approved.
    const legacy = pm.newTask({ title: 'agent-made' });
    expect(pm.addTask({ title: 'x', parent: legacy.id }).proposed).toMatch(
      /not created or accepted/,
    );
    h.assign(legacy.id, 'claude:engineer');
    expect(pm.addTask({ title: 'y', parent: legacy.id }).meta.type).toBe('task');
    // A comment does not approve; a closed parent does not take new subtasks.
    const talked = pm.newTask({ title: 'discussed only' });
    h.comment(talked.id, 'hmm');
    expect(pm.addTask({ title: 'z', parent: talked.id }).meta.type).toBe('finding');
    h.done('1', 'shipped');
    expect(pm.addTask({ title: 'late step', parent: '1' }).proposed).toMatch(
      /parent T-0001 is done/,
    );
  });

  it('retypes a task by event: humans and the orchestrator only, and the queue follows', () => {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'maybe later', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    expect(() => eng.retype('1', 'idea')).toThrow(/only a human or the orchestrator/);
    expect(() => h.retype('1', 'Not A Type')).toThrow(/bad type/);
    const res = h.retype('1', 'idea', 'not now');
    expect(res.events[0]).toMatchObject({ type: 'retype', task_type: 'idea' });
    expect(res.view.meta.type).toBe('idea');
    expect(() => h.retype('1', 'idea')).toThrow(/already a idea/);
    expect(eng.queue()).toEqual([]);
    // task.md keeps the type it was filed with; the fold applies the event.
    expect(readFileSync(join(rootDir, 'tasks', 'T-0001', 'task.md'), 'utf8')).toContain(
      'type: task',
    );
    h.retype('1', 'bug');
    expect(eng.next()?.meta.type).toBe('bug');
    // With an owner, both changes land together, and a bad owner writes nothing.
    const before = readdirSync(join(rootDir, 'tasks', 'T-0001', 'events')).length;
    expect(() => h.retype('1', 'task', '', { to: 'not an id' })).toThrow();
    expect(readdirSync(join(rootDir, 'tasks', 'T-0001', 'events'))).toHaveLength(before);
    const both = h.retype('1', 'task', 'accepted', { to: 'codex:engineer' });
    expect(both.events.map((e) => e.type)).toEqual(['retype', 'assign']);
    expect(both.view).toMatchObject({ owner: 'codex:engineer', meta: { type: 'task' } });
  });

  it('refuses work on a task held by someone else unless forced', () => {
    const { as, rootDir } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:engineer').start('1');
    expect(() => as('codex:engineer').progress('1', 'hi')).toThrow(/held by claude:engineer/);
    const res = as('codex:engineer', { force: true }).progress('1', 'hi');
    expect(res.events[0]!.forced).toBe(true);
    expect(readdirSync(join(rootDir, 'tasks', 'T-0001', 'events'))).toHaveLength(3);
  });

  it('frees a task when the lease expires', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:a').claim('1');
    const later = Date.now() + 61 * 60_000;
    const b = as('claude:b', { now: () => later });
    expect(b.view('1').stale).toBe(true);
    expect(b.claim('1').view.claimedBy).toBe('claude:b');
  });

  it('claims through a finished dependency', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'first' });
    h.newTask({ title: 'second', blockedBy: ['1'] });
    expect(() => as('claude:a').claim('2')).toThrow(/blocked/);
    as('claude:a').start('1');
    as('claude:a').done('1');
    const res = as('claude:a').claim('2');
    expect(res.events.map((e) => e.type)).toEqual(['unblock', 'claim']);
  });

  it('keeps a dependency on its own root when two roots hold the same id', () => {
    const { repo, env } = setup();
    const betaDir = gitRepo();
    initRoot(betaDir, { name: 'beta', human: 'human:dawid' });
    const multi = { ...env, OPS_ROOTS: betaDir } as NodeJS.ProcessEnv;
    const as = (actor: string) => new Workspace({ cwd: repo, env: multi, actor });
    const h = as('human:dawid');
    const beta = h.roots.find((r) => r.name === 'beta')!;
    h.newTask({ title: 'test one' });
    h.newTask({ title: 'beta one' }, beta);
    h.newTask({ title: 'beta two' }, beta);
    const a = as('claude:a');
    a.start('beta/T-0002');
    a.block('beta/T-0002', 'waits on test', { on: ['test/T-0001'] });
    const waiting = h.newTask({ title: 'beta three', blockedBy: ['test/T-0001', 'beta/1'] }, beta);
    expect(waiting.blocked_by).toEqual(['test/T-0001', 'T-0001']);

    const unblocked = (ref: string) => {
      const live = h.views().find((v) => `${v.root}/${v.meta.id}` === ref)!;
      const found = searchSources(h.roots, Date.now())
        .tasks()
        .find(({ view: v }) => `${v.root}/${v.meta.id}` === ref)!;
      return [h.view(ref).unblocked, live.unblocked, found.view.unblocked];
    };
    expect(h.view('beta/T-0002').blockedOn).toEqual(['test/T-0001']);
    a.start('beta/T-0001');
    a.done('beta/T-0001', 'same id, other root');
    expect(unblocked('beta/T-0002')).toEqual([false, false, false]);
    a.start('test/T-0001');
    a.done('test/T-0001', 'the real dependency');
    expect(unblocked('beta/T-0002')).toEqual([true, true, true]);
    expect(a.claim('beta/T-0002').events.map((e) => e.type)).toContain('unblock');
  });

  it('requires a reviewer from another provider', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:engineer').start('1');
    expect(() => as('claude:engineer').review('1', 'PR', 'claude:qa')).toThrow(/another provider/);
    expect(as('claude:engineer').review('1', 'PR', 'codex:qa').view.status).toBe('needs-review');
    expect(() => as('claude:other').verdict('1', 'approve', 'ok')).toThrow(/codex:qa/);
    expect(as('codex:qa').verdict('1', 'approve', 'ok').view.status).toBe('done');
  });

  it('sends reviews to the root human by default', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:engineer').start('1');
    expect(as('claude:engineer').review('1', 'PR').view.reviewer).toBe('human:dawid');
  });

  it('only parks for humans and the orchestrator', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x', owner: 'claude:engineer' });
    expect(() => as('claude:engineer').park('1', 'no')).toThrow(/parks/);
    expect(as('claude:orchestrator').park('1', 'dup').view.status).toBe('parked');
    expect(as('claude:engineer').reopen('1').view.status).toBe('todo');
  });
});

describe('inbox', () => {
  it('shows the event that started the current wait as the ask, not an older question', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:engineer').start('1');
    const ask = as('claude:engineer').ask('1', 'Which database?');
    as('human:dawid').answer('1', 'Postgres');
    as('claude:engineer').start('1');
    const block = as('claude:engineer').block('1', 'Need the staging password location', {
      to: 'human:dawid',
    });
    const items = as('human:dawid').inbox();
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'ask',
        event: block.events[0]!.id,
        from: 'claude:engineer',
        summary: 'Need the staging password location',
      }),
    ]);
    expect(block.events[0]!.id).not.toBe(ask.events[0]!.id);
  });

  it('shows asks to the human and marks messages read', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('claude:engineer').start('1');
    as('claude:engineer').ask('1', 'Which database?');
    const h = as('human:dawid');
    const items = h.inbox();
    // The question shows once, as the ask with its text, not again as a message.
    expect(items).toEqual([
      expect.objectContaining({ kind: 'ask', from: 'claude:engineer', summary: 'Which database?' }),
    ]);
    h.inbox(undefined, { markRead: true });
    expect(h.inbox().map((i) => i.kind)).toEqual(['ask']);
    h.answer('1', 'Postgres');
    expect(h.inbox()).toEqual([]);
    const agentInbox = as('claude:engineer').inbox();
    expect(agentInbox).toEqual([expect.objectContaining({ kind: 'message', type: 'answer' })]);
  });

  it('writes a comment to its own author without an addressee and keeps it out of their inbox', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'x' });
    const res = h.comment('1', 'Project inheritance seems safer', 'human:dawid');
    expect(res.events[0]!.to).toBeUndefined();
    expect(h.inbox()).toEqual([]);
    // Other recipients still get the comment.
    h.comment('1', 'Have a look', 'claude:engineer');
    expect(as('claude:engineer').inbox()).toEqual([
      expect.objectContaining({ kind: 'message', type: 'comment', from: 'human:dawid' }),
    ]);
  });

  it('leaves out events the reader wrote, even when they name the reader', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'x', owner: 'claude:engineer' });
    // Assigning to yourself writes an assign event addressed to you, like the comments written
    // before the composer stopped addressing their author.
    h.assign('1', 'human:dawid');
    expect(h.inbox().filter((i) => i.kind === 'message')).toEqual([]);
  });
});

describe('roles', () => {
  it('does not create a role that shadows the same id in another root', () => {
    const { repo, rootDir, env } = setup();
    const beta = gitRepo();
    initRoot(beta, { name: 'beta', human: 'human:dawid' });
    const multi = { ...env, OPS_ROOTS: beta } as NodeJS.ProcessEnv;
    const ws = new Workspace({ cwd: repo, env: multi, actor: 'human:dawid' });
    ws.saveRole({ id: 'claude:writer', name: 'Writer' }, { root: 'beta', create: true });

    expect(() =>
      ws.saveRole({ id: 'claude:writer', name: 'Shadow' }, { root: 'test', create: true }),
    ).toThrow(/already has a role file in beta/);
    expect(() => ws.saveRole({ id: 'claude:writer', name: 'Shadow' }, { root: 'test' })).toThrow(
      /has a role file in beta; edit it there/,
    );
    expect(existsSync(join(rootDir, 'agents', 'claude-writer.md'))).toBe(false);
  });
});

describe('index cache', () => {
  it('sees a hand edit to task.md', () => {
    const { as, rootDir } = setup();
    const ws = as('human:dawid');
    ws.newTask({ title: 'before' });
    expect(ws.list()[0]!.meta.title).toBe('before');
    const file = join(rootDir, 'tasks', 'T-0001', 'task.md');
    const text = `---\ntitle: after\ntype: task\npriority: p1\ncreated_by: human:dawid\ncreated_at: 2026-10-31T00:00:00.000Z\n---\n`;
    writeFileSync(file, text);
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    expect(as('human:dawid').list()[0]!.meta).toMatchObject({ title: 'after', priority: 'p1' });
  });

  it('rebuilds after the cache is deleted or damaged', () => {
    const { as, rootDir } = setup();
    as('human:dawid').newTask({ title: 'x' });
    as('human:dawid').list();
    writeFileSync(join(rootDir, '.ops', 'index.json'), '{not json');
    expect(new Root(rootDir).states()).toHaveLength(1);
  });

  it('refolds a keep_wait assign that a v6 build cached as todo (AO-0111)', () => {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    as('claude:engineer').finding({ title: 'f' });
    as('codex:engineer', { force: true }).start('1', 'plan');
    as('codex:engineer').ask('1', 'Which way?');
    h.retype('1', 'bug', 'Accepted in triage', { to: 'claude:engineer' });
    // Age the task so its cache entry is not racy, then let a read cache it.
    const taskDir = join(rootDir, 'tasks', 'T-0001');
    const past = new Date(Date.now() - 60_000);
    for (const p of [join(taskDir, 'task.md'), join(taskDir, 'events')]) utimesSync(p, past, past);
    new Root(rootDir).states();
    // A v6 build ignored keep_wait: it cached the task as todo with the question gone.
    const indexFile = join(rootDir, '.ops', 'index.json');
    const raw = JSON.parse(readFileSync(indexFile, 'utf8'));
    const state = raw.tasks['T-0001'].state;
    Object.assign(state, { status: 'todo', waitingOn: null, waitEvent: null, askedBy: null });
    writeFileSync(indexFile, JSON.stringify({ ...raw, v: 6 }));

    expect(new Root(rootDir).states()[0]).toMatchObject({ status: 'blocked' });
    expect(h.inbox()).toEqual([expect.objectContaining({ kind: 'ask', summary: 'Which way?' })]);
    expect(JSON.parse(readFileSync(indexFile, 'utf8')).v).toBeGreaterThan(6);
  });
});
