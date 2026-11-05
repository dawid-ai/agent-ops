// Back and forward for the task panel. Pure functions, so they are tested without a browser.

/** The open task and the tasks Back and Forward return to, nearest last. */
export interface TaskHistory {
  back: string[];
  current: string | null;
  forward: string[];
}

export const NO_HISTORY: TaskHistory = { back: [], current: null, forward: [] };

/**
 * Whether two panel refs name the same task: equal, or one bare id (`AO-0014`) and one with its
 * root (`agent-ops/AO-0014`) that end in that id.
 */
export function sameTask(a: string, b: string): boolean {
  if (a === b) return true;
  const id = (r: string): string => r.slice(r.lastIndexOf('/') + 1);
  return (!a.includes('/') || !b.includes('/')) && id(a) === id(b);
}

/**
 * Opens a task. With no panel open it starts a fresh history; with a panel open it pushes the open
 * task onto Back and clears Forward. The task already open adds no entry. `null` closes the panel
 * and clears the history.
 */
export function openTask(h: TaskHistory, task: string | null): TaskHistory {
  if (!task) return NO_HISTORY;
  if (!h.current) return { back: [], current: task, forward: [] };
  if (sameTask(h.current, task)) return h;
  return { back: [...h.back, h.current], current: task, forward: [] };
}

/** Returns to the previous task; the open one goes onto Forward. Unchanged with nothing to go back to. */
export function goBack(h: TaskHistory): TaskHistory {
  const prev = h.back.at(-1);
  if (prev === undefined || !h.current) return h;
  return { back: h.back.slice(0, -1), current: prev, forward: [...h.forward, h.current] };
}

/** Returns to the task Back left. Unchanged with nothing to go forward to. */
export function goForward(h: TaskHistory): TaskHistory {
  const next = h.forward.at(-1);
  if (next === undefined || !h.current) return h;
  return { back: [...h.back, h.current], current: next, forward: h.forward.slice(0, -1) };
}

/** Mouse buttons 3 and 4 are the side buttons: back and forward. */
export function mouseNav(button: number): 'back' | 'forward' | null {
  return button === 3 ? 'back' : button === 4 ? 'forward' : null;
}
