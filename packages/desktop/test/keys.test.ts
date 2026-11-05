import { describe, expect, it } from 'vitest';
import { findTask, isTyping, keyAction, rankTasks } from '../ui/src/lib/keys';
import type { Task } from '../ui/src/types';

const t = (root: string, id: string, title: string, over: Partial<Task> = {}): Task => ({
  id,
  root,
  title,
  type: 'task',
  priority: 'p2',
  status: 'todo',
  owner: null,
  claimedBy: null,
  leaseUntil: null,
  reviewer: null,
  waitingOn: null,
  checkpoint: null,
  updatedAt: '2026-11-01T00:00:00Z',
  ...over,
});

const idle = { pendingG: false, typing: false };

describe('keyboard shortcuts', () => {
  it('opens the palette with Ctrl+K or Cmd+K, even while typing', () => {
    expect(keyAction({ key: 'k', ctrlKey: true }, { ...idle, typing: true }).action).toEqual({
      kind: 'palette',
    });
    expect(keyAction({ key: 'K', metaKey: true }, idle).action).toEqual({ kind: 'palette' });
    expect(keyAction({ key: 'k', ctrlKey: true, altKey: true }, idle).action).toBeNull();
  });

  it('never fires single keys while typing or with a modifier', () => {
    expect(keyAction({ key: 'n' }, { ...idle, typing: true })).toEqual({
      action: null,
      pendingG: false,
    });
    expect(keyAction({ key: 'n', ctrlKey: true }, idle).action).toBeNull();
    expect(keyAction({ key: 'g' }, { ...idle, typing: true }).pendingG).toBe(false);
  });

  it('ignores shifted letters but still opens the list with ?', () => {
    expect(keyAction({ key: 'N', shiftKey: true }, idle).action).toBeNull();
    expect(keyAction({ key: 'G', shiftKey: true }, idle)).toEqual({
      action: null,
      pendingG: false,
    });
    expect(keyAction({ key: 'B', shiftKey: true }, { ...idle, pendingG: true }).action).toBeNull();
    expect(keyAction({ key: '?', shiftKey: true }, idle).action).toEqual({ kind: 'help' });
  });

  it('does nothing but Ctrl+K while a dialog is open, and never arms g there', () => {
    const modal = { ...idle, modal: true };
    expect(keyAction({ key: 'g' }, modal)).toEqual({ action: null, pendingG: false });
    expect(keyAction({ key: 'b' }, { ...modal, pendingG: true })).toEqual({
      action: null,
      pendingG: false,
    });
    expect(keyAction({ key: 'n' }, modal).action).toBeNull();
    expect(keyAction({ key: 'k', ctrlKey: true }, modal).action).toEqual({ kind: 'palette' });
  });

  it('runs n, /, ? and g sequences', () => {
    expect(keyAction({ key: 'n' }, idle).action).toEqual({ kind: 'new' });
    expect(keyAction({ key: '/' }, idle).action).toEqual({ kind: 'search' });
    expect(keyAction({ key: '?' }, idle).action).toEqual({ kind: 'help' });
    const g = keyAction({ key: 'g' }, idle);
    expect(g).toEqual({ action: null, pendingG: true });
    expect(keyAction({ key: 'b' }, { ...idle, pendingG: true }).action).toEqual({
      kind: 'go',
      view: 'board',
    });
    expect(keyAction({ key: 'k' }, { ...idle, pendingG: true }).action).toEqual({
      kind: 'go',
      view: 'knowledge',
    });
    // An unknown second key ends the sequence and does nothing.
    expect(keyAction({ key: 'z' }, { ...idle, pendingG: true })).toEqual({
      action: null,
      pendingG: false,
    });
  });

  it('knows fields from other elements', () => {
    expect(isTyping({ tagName: 'input' })).toBe(true);
    expect(isTyping({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTyping({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTyping({ tagName: 'BUTTON' })).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe('palette search', () => {
  const tasks = [
    t('web', 'WEB-0012', 'Fix the pricing page'),
    t('web', 'WEB-0001', 'Pricing copy', { status: 'done' }),
    t('ops', 'AO-0012', 'Pricing for agents', { priority: 'p0' }),
    t('ops', 'AO-0030', 'Board swimlanes'),
  ];
  it('ranks an exact id first, then id prefixes, then titles, open before closed', () => {
    expect(rankTasks(tasks, 'ao-0030').map((x) => x.id)).toEqual(['AO-0030']);
    expect(rankTasks(tasks, '12').map((x) => x.id)).toEqual(['AO-0012', 'WEB-0012']);
    expect(rankTasks(tasks, 'pricing').map((x) => x.id)).toEqual([
      'AO-0012',
      'WEB-0012',
      'WEB-0001',
    ]);
    expect(rankTasks(tasks, 'pricing page').map((x) => x.id)).toEqual(['WEB-0012']);
    expect(rankTasks(tasks, '  ')).toEqual([]);
  });

  it('finds the open task by root/id, or by a bare id only one root has', () => {
    const dup = [...tasks, t('site', 'AO-0030', 'other root')];
    expect(findTask(dup, 'site/AO-0030')?.title).toBe('other root');
    expect(findTask(dup, 'AO-0030')).toBeUndefined();
    expect(findTask(dup, 'WEB-0012')?.root).toBe('web');
    expect(findTask(dup, null)).toBeUndefined();
  });
});
