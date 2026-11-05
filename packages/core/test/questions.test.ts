import { describe, expect, it } from 'vitest';
import { projectRefs, taskRefs } from '../src/index.js';
import { setup } from './helpers.js';

describe('questions (AO-0063)', () => {
  it('needs an agent to go to, never a person or the asker', () => {
    const { as } = setup();
    const h = as('human:dawid');
    expect(() => h.newTask({ title: 'why?', type: 'question' })).toThrow(/needs the agent/);
    expect(() => h.newTask({ title: 'why?', type: 'question', owner: 'human:ana' })).toThrow(
      /goes to an agent, not human:ana: to ask a person, use ops ask/,
    );
    expect(() =>
      as('claude:pm').newTask({ title: 'why?', type: 'question', owner: 'claude:pm' }),
    ).toThrow(/another agent than you/);
    expect(h.newTask({ title: 'why?', type: 'question', owner: 'codex:*' }).owner).toBe('codex:*');
  });

  it('is in the queue of the agent it names only', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Is AO-0001 safe to merge?', type: 'question', owner: 'codex:qa' });
    expect(
      as('codex:qa')
        .queue()
        .map((v) => v.meta.title),
    ).toEqual(['Is AO-0001 safe to merge?']);
    expect(as('claude:qa').queue()).toEqual([]);
    expect(as('codex:engineer').queue()).toEqual([]);
  });

  it('never goes to a group the asker belongs to', () => {
    const { as } = setup();
    const qa = as('codex:qa');
    expect(() => qa.newTask({ title: 'why?', type: 'question', owner: 'codex:*' })).toThrow(
      /another agent than you: codex:\* includes codex:qa/,
    );
    expect(() => qa.newTask({ title: 'why?', type: 'question', owner: '*:qa' })).toThrow(
      /another agent than you: \*:qa includes codex:qa/,
    );
    expect(qa.newTask({ title: 'why?', type: 'question', owner: 'claude:*' }).owner).toBe(
      'claude:*',
    );
    expect(qa.queue()).toEqual([]);
  });

  it('keeps the owner rule on handoff, assign, delegate and retype', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Is AO-0001 safe?', type: 'question', owner: 'claude:pm' });
    as('codex:qa').newTask({ title: 'Why red?', type: 'question', owner: 'claude:engineer' });
    const pm = as('claude:pm');
    expect(() => pm.handoff('1', 'human:dawid', 'yours')).toThrow(/goes to an agent, not/);
    expect(() => h.assign('1', 'human:ana')).toThrow(/goes to an agent, not human:ana/);
    expect(() => pm.delegate('1', 'human:ana')).toThrow(/goes to an agent, not human:ana/);
    const eng = as('claude:engineer');
    expect(() => eng.handoff('2', 'codex:qa', 'back to you')).toThrow(
      /another agent than the one who asked \(codex:qa\)/,
    );
    expect(() => eng.assign('2', 'codex:*')).toThrow(/codex:\* includes codex:qa/);
    expect(() => eng.delegate('2', '*:qa')).toThrow(/\*:qa includes codex:qa/);
    expect(pm.handoff('1', 'codex:qa', 'QA knows').view.owner).toBe('codex:qa');
    expect(eng.delegate('2', 'claude:*').view.owner).toBe('claude:*');

    // A task becomes a question only with an agent owner that is not the asker.
    h.newTask({ title: 'unowned' });
    expect(() => h.retype('3', 'question')).toThrow(/needs the agent/);
    h.newTask({ title: 'to a person', owner: 'human:ana' });
    expect(() => h.retype('4', 'question')).toThrow(/goes to an agent, not human:ana/);
    expect(() => h.retype('4', 'question', '', { to: 'human:dawid' })).toThrow(
      /goes to an agent, not human:dawid/,
    );
    as('codex:qa').newTask({ title: 'mine', owner: 'codex:qa' });
    expect(() => h.retype('5', 'question')).toThrow(/the one who asked \(codex:qa\)/);
    expect(h.retype('5', 'question', '', { to: 'claude:pm' }).view.owner).toBe('claude:pm');
    expect(h.retype('3', 'question', '', { to: 'codex:qa' }).view.meta.type).toBe('question');
  });

  it('sends the answer to the asker inbox and needs answer text', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'What blocks the release?', type: 'question', owner: 'codex:qa' });
    const qa = as('codex:qa');
    qa.start('1', 'read the open reviews');
    expect(() => qa.done('1')).toThrow(/is a question: answer it with ops done T-0001 "answer"/);
    const res = qa.done('1', 'T-0002 waits for a review; nothing else blocks the release.');
    expect(res.view.status).toBe('done');
    expect(res.events[0]).toMatchObject({ type: 'done', to: 'human:dawid' });
    const inbox = h.inbox();
    expect(inbox).toEqual([
      expect.objectContaining({
        kind: 'message',
        task: 'T-0001',
        from: 'codex:qa',
        type: 'done',
        summary: expect.stringContaining('T-0002 waits for a review'),
      }),
    ]);
  });

  it('lets the asker close their own question without an answer', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'Never mind', type: 'question', owner: 'codex:qa' });
    expect(h.done('1').events[0]).not.toHaveProperty('to');
  });

  it('leaves done on other task types as it was', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x', owner: 'claude:engineer' });
    expect(as('claude:engineer').done('1').events[0]).not.toHaveProperty('to');
  });
});

describe('references in text', () => {
  it('finds task and project references once each, in order', () => {
    const text =
      'Compare AO-0047 with other/AO-0012 and AO-0047#01M6J7KEW6RF3TZHXTRYPCRW8R in project:v2, ' +
      'then project:agent-ops. Not XAO-0001x, not AO-01, not myproject:x.';
    expect(taskRefs(text)).toEqual(['AO-0047', 'other/AO-0012']);
    expect(projectRefs(text)).toEqual(['v2', 'agent-ops']);
  });
});
