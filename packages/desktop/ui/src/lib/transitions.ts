import type { Status, Task } from '../types';

/**
 * What it takes to move a task to another status from the app, as the human. Each move maps to
 * one protocol action; some need input first:
 * - `reason`: blocking and parking say why (blocking may name who or what it waits on);
 * - `reviewer`: sending for review names the reviewer;
 * - `work`: starting work means you take it, or an agent run starts on it.
 */
export interface Move {
  target: Status;
  action:
    | 'release'
    | 'unblock'
    | 'reopen'
    | 'verdict-changes'
    | 'start'
    | 'block'
    | 'review'
    | 'done'
    | 'park';
  needs?: 'reason' | 'reviewer' | 'work';
  /** Shown in the menu or the drop dialog. */
  label: string;
}

/** The status a task shows as: a stale claim or finished dependencies make it claimable. */
export function shownStatus(t: Pick<Task, 'status' | 'stale' | 'unblocked'>): Status {
  return t.stale || t.unblocked ? 'todo' : t.status;
}

const OPEN: Status[] = ['todo', 'claimed', 'in-progress', 'blocked', 'needs-review'];

/** The move to `target`, or a reason it cannot be made from the app. */
export function moveTo(
  t: Pick<Task, 'status' | 'stale' | 'unblocked'>,
  target: Status,
): Move | string {
  const from = shownStatus(t);
  const raw = t.status;
  if (from === target || (target === 'in-progress' && from === 'claimed')) return 'already there';
  switch (target) {
    case 'todo':
      if (raw === 'claimed' || raw === 'in-progress') {
        return { target, action: 'release', label: 'Release to the queue' };
      }
      if (raw === 'blocked') return { target, action: 'unblock', label: 'Unblock' };
      if (raw === 'done' || raw === 'parked') return { target, action: 'reopen', label: 'Reopen' };
      if (raw === 'needs-review') {
        return { target, action: 'verdict-changes', needs: 'reason', label: 'Request changes' };
      }
      return 'already to do';
    case 'in-progress':
    case 'claimed':
      if (from === 'todo')
        return { target: 'in-progress', action: 'start', needs: 'work', label: 'Start work' };
      if (raw === 'blocked') return 'unblock it first: it goes back to To do';
      if (raw === 'needs-review') return 'it waits for review: approve it or request changes';
      return 'reopen it first';
    case 'blocked':
      if (!OPEN.includes(raw)) return 'reopen it first';
      return { target, action: 'block', needs: 'reason', label: 'Block' };
    case 'needs-review':
      if (raw === 'claimed' || raw === 'in-progress') {
        return { target, action: 'review', needs: 'reviewer', label: 'Send for review' };
      }
      return 'only work in progress goes to review';
    case 'done':
      if (!OPEN.includes(raw)) return 'already closed';
      return { target, action: 'done', label: 'Close as done' };
    case 'parked':
      if (!OPEN.includes(raw)) return 'already closed';
      return { target, action: 'park', needs: 'reason', label: 'Park (not planned)' };
  }
}

/** The opsd call for a move, with the input the dialog collected. */
export function moveRequest(
  move: Move,
  input: { message?: string; to?: string; on?: string },
): { path: string; body: Record<string, unknown> } {
  const message = input.message ?? '';
  switch (move.action) {
    case 'verdict-changes':
      return { path: 'verdict', body: { verdict: 'changes', message } };
    case 'block':
      return {
        path: 'block',
        body: { message, to: input.to || undefined, on: input.on || undefined },
      };
    case 'review':
      return { path: 'review', body: { message, to: input.to || undefined } };
    case 'park':
      return { path: 'park', body: { message: message || 'parked from the desktop app' } };
    case 'release':
      return { path: 'release', body: { message: message || 'released from the desktop app' } };
    default:
      return { path: move.action, body: { message } };
  }
}
