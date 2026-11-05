// Keyboard shortcuts and palette search. Pure functions, so they are tested without a browser.
import type { Task } from '../types';

/** Views `g` then a letter jumps to. */
export const GO_KEYS: Record<string, { view: string; label: string }> = {
  i: { view: 'inbox', label: 'Inbox' },
  b: { view: 'board', label: 'Board' },
  l: { view: 'list', label: 'Tasks' },
  f: { view: 'findings', label: 'Findings' },
  s: { view: 'standups', label: 'Standups' },
  h: { view: 'activity', label: 'Activity' },
  p: { view: 'reports', label: 'Reports' },
  a: { view: 'agents', label: 'Agents' },
  r: { view: 'runs', label: 'Runs' },
  c: { view: 'channels', label: 'Channels' },
  d: { view: 'decisions', label: 'Decisions' },
  k: { view: 'knowledge', label: 'Knowledge' },
};

export const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+K', 'Command palette (Cmd+K on macOS)'],
  ['Ctrl+F', 'Search everything: tasks, threads, notes, posts, votes'],
  ['n', 'New task'],
  ['/', 'Search in this view'],
  ...Object.entries(GO_KEYS).map(([k, v]): [string, string] => [`g ${k}`, `Go to ${v.label}`]),
  ['?', 'This list'],
  ['Esc', 'Close a dialog or the palette'],
];

/** True while the user types in a field: single-key shortcuts must not fire then. */
export function isTyping(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export type KeyAction =
  | { kind: 'palette' }
  | { kind: 'find' }
  | { kind: 'new' }
  | { kind: 'search' }
  | { kind: 'help' }
  | { kind: 'go'; view: string };

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * What a key press does. `pendingG` is true right after a bare `g`; the result says whether the
 * next key completes a `g` sequence. Ctrl+K works everywhere, even in a dialog; the rest only
 * outside fields and dialogs, without Ctrl, Cmd or Alt, and letters without Shift. `?` needs Shift
 * on most layouts, so it is matched by the character it types.
 */
export function keyAction(
  e: KeyInput,
  state: { pendingG: boolean; typing: boolean; modal?: boolean },
): { action: KeyAction | null; pendingG: boolean } {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'k') {
    return { action: { kind: 'palette' }, pendingG: false };
  }
  // Ctrl+F also works while typing, but not in a dialog, which has its own fields.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'f' && !state.modal) {
    return { action: { kind: 'find' }, pendingG: false };
  }
  if (state.typing || state.modal || e.ctrlKey || e.metaKey || e.altKey) {
    return { action: null, pendingG: false };
  }
  if (e.shiftKey && /^[a-z]$/.test(k)) return { action: null, pendingG: false };
  if (state.pendingG) {
    const go = GO_KEYS[k];
    return { action: go ? { kind: 'go', view: go.view } : null, pendingG: false };
  }
  if (k === 'g') return { action: null, pendingG: true };
  if (k === 'n') return { action: { kind: 'new' }, pendingG: false };
  if (k === '/') return { action: { kind: 'search' }, pendingG: false };
  if (e.key === '?') return { action: { kind: 'help' }, pendingG: false };
  return { action: null, pendingG: false };
}

/**
 * Tasks for the palette, best first: an exact id, then ids that start with the query, then titles
 * that contain every word; open work before closed.
 */
export function rankTasks(tasks: Task[], query: string, limit = 8): Task[] {
  const qy = query.trim().toLowerCase();
  if (!qy) return [];
  const words = qy.split(/\s+/);
  const closed = (t: Task): number => (t.status === 'done' || t.status === 'parked' ? 1 : 0);
  const score = (t: Task): number => {
    const id = t.id.toLowerCase();
    const ref = `${t.root}/${t.id}`.toLowerCase();
    if (id === qy || ref === qy) return 0;
    if (id.startsWith(qy) || id.replace(/^[a-z]+-0*/, '').startsWith(qy)) return 1;
    const title = t.title.toLowerCase();
    if (words.every((w) => title.includes(w) || id.includes(w))) return 2;
    return -1;
  };
  return tasks
    .map((t) => ({ t, s: score(t) }))
    .filter((x) => x.s >= 0)
    .sort(
      (a, b) => a.s - b.s || closed(a.t) - closed(b.t) || a.t.priority.localeCompare(b.t.priority),
    )
    .slice(0, limit)
    .map((x) => x.t);
}

/** The task a panel ref names: `root/ID`, or a bare id that only one root has. */
export function findTask(tasks: Task[], ref: string | null): Task | undefined {
  if (!ref) return undefined;
  const exact = tasks.find((t) => `${t.root}/${t.id}` === ref);
  if (exact) return exact;
  const byId = tasks.filter((t) => t.id === ref);
  return byId.length === 1 ? byId[0] : undefined;
}
