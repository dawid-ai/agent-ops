import { describe, expect, it } from 'vitest';
import { inboxTarget } from '../src/route';

describe('notification routing', () => {
  it('opens decisions, channels and tasks in their own views', () => {
    expect(inboxTarget({ kind: 'decide', task: 'alpha/D-0001' })).toEqual({ view: 'decisions' });
    expect(inboxTarget({ kind: 'vote', task: 'D-0002' })).toEqual({ view: 'decisions' });
    expect(inboxTarget({ kind: 'mention', task: '#dev' })).toEqual({ view: 'channels', id: 'dev' });
    expect(inboxTarget({ kind: 'ask', task: 'beta/T-0001' })).toEqual({
      view: 'task',
      id: 'beta/T-0001',
    });
    expect(inboxTarget({ kind: 'message', task: 'T-0003' })).toEqual({
      view: 'task',
      id: 'T-0003',
    });
  });
});
