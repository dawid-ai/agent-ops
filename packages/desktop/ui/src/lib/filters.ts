// Task filters shared by the board and the list, swimlanes, and saved views. Pure functions, so
// they are tested without a browser.
import type { Task } from '../types';
import { identity, PRIORITIES } from './identity';

export interface TaskFilter {
  text?: string;
  project?: string;
  /** Owner or claim holder. */
  owner?: string;
  /** Role of the owner or claim holder, such as `engineer`. */
  role?: string;
  /** Provider of the owner or claim holder, such as `claude` or `human`. */
  provider?: string;
  priority?: string;
  type?: string;
  label?: string;
  /** Owned, claimed, waiting on or reviewed by me. */
  mine?: boolean;
  /** Show tasks of type idea; off hides them. */
  ideas?: boolean;
}

export type Lanes = 'none' | 'agent' | 'project' | 'priority';

export const LANES: Array<[Lanes, string]> = [
  ['none', 'No lanes'],
  ['agent', 'By agent'],
  ['project', 'By project'],
  ['priority', 'By priority'],
];

/** Who a card belongs to: the claim holder, else the owner. */
export function whoOf(t: Task): string | null {
  return t.claimedBy ?? t.owner;
}

export function matchesFilter(t: Task, f: TaskFilter, me: string | null): boolean {
  const who = whoOf(t);
  const id = who ? identity(who) : null;
  const needle = f.text?.trim().toLowerCase();
  if (
    needle &&
    !`${t.id} ${t.title} ${t.project ?? ''} ${t.owner ?? ''} ${t.claimedBy ?? ''} ${(t.labels ?? []).join(' ')}`
      .toLowerCase()
      .includes(needle)
  ) {
    return false;
  }
  if (f.project && t.project !== f.project) return false;
  if (f.owner && t.owner !== f.owner && t.claimedBy !== f.owner) return false;
  if (f.role && (!id || id.human || id.role !== f.role)) return false;
  if (f.provider && id?.runtime !== f.provider) return false;
  if (f.priority && t.priority !== f.priority) return false;
  if (f.type && t.type !== f.type) return false;
  if (f.label && !(t.labels ?? []).includes(f.label)) return false;
  // Asking for ideas by type shows them whatever the toggle says.
  if (f.ideas === false && t.type === 'idea' && f.type !== 'idea') return false;
  if (
    f.mine &&
    !(me && (t.owner === me || t.claimedBy === me || t.waitingOn === me || t.reviewer === me))
  ) {
    return false;
  }
  return true;
}

/** The values each filter can take in these tasks, sorted, for the dropdowns. */
export function filterOptions(tasks: Task[]): {
  projects: string[];
  owners: string[];
  roles: string[];
  providers: string[];
  types: string[];
  labels: string[];
} {
  const set = (xs: Array<string | null | undefined>): string[] =>
    [...new Set(xs.filter((x): x is string => Boolean(x)))].sort();
  const people = tasks.flatMap((t) => [t.owner, t.claimedBy]);
  const ids = set(people).map(identity);
  return {
    projects: set(tasks.map((t) => t.project)),
    owners: set(people),
    roles: set(ids.filter((i) => !i.human && i.role !== '*').map((i) => i.role)),
    providers: set(ids.filter((i) => i.runtime !== '*').map((i) => i.runtime)),
    types: set(tasks.map((t) => t.type)),
    labels: set(tasks.flatMap((t) => t.labels ?? [])),
  };
}

export function activeFilters(f: TaskFilter): number {
  return (
    (['text', 'project', 'owner', 'role', 'provider', 'priority', 'type', 'label'] as const).filter(
      (k) => Boolean(f[k]?.trim()),
    ).length + (f.mine ? 1 : 0)
  );
}

export interface Lane {
  key: string;
  tasks: Task[];
}

const UNASSIGNED = '';

/** Splits tasks into lanes in a fixed order: priorities high to low, others by name, empty last. */
export function lanesOf(tasks: Task[], mode: Lanes): Lane[] {
  if (mode === 'none') return [{ key: 'all', tasks }];
  const keyOf = (t: Task): string =>
    mode === 'agent'
      ? (whoOf(t) ?? UNASSIGNED)
      : mode === 'project'
        ? (t.project ?? UNASSIGNED)
        : t.priority;
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const k = keyOf(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const order =
    mode === 'priority' ? (k: string) => PRIORITIES.findIndex((p) => p.key === k) : () => 0;
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return order(a) - order(b) || a.localeCompare(b);
    })
    .map(([key, list]) => ({ key, tasks: list }));
}

/** Open work waiting for an agent: to do, not an idea, owned by it or by its role or provider. */
export function backlogOf(agent: string, tasks: Task[]): Task[] {
  const a = identity(agent);
  return tasks.filter((t) => {
    if (t.status !== 'todo' || t.type === 'idea' || !t.owner) return false;
    if (t.owner === agent) return true;
    if (a.human) return false;
    const o = identity(t.owner);
    return (o.runtime === '*' && o.role === a.role) || (o.role === '*' && o.runtime === a.runtime);
  });
}

// ---- Saved views ---------------------------------------------------------------------------------

export interface SavedView {
  name: string;
  view: 'board' | 'list';
  filter: TaskFilter;
  lanes?: Lanes;
}

const KEY = 'agent-ops.saved-views';
export const VIEWS_CHANGED = 'agent-ops:saved-views';

const TEXT_KEYS = [
  'text',
  'project',
  'owner',
  'role',
  'provider',
  'priority',
  'type',
  'label',
] as const;
const FLAG_KEYS = ['mine', 'ideas'] as const;

/** Keeps only filter fields of the right type, so stored data can never break filtering. */
export function cleanFilter(raw: unknown): TaskFilter {
  const out: TaskFilter = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const k of TEXT_KEYS) if (typeof r[k] === 'string') out[k] = r[k];
  for (const k of FLAG_KEYS) if (typeof r[k] === 'boolean') out[k] = r[k];
  return out;
}

/** Saved views live in this machine's app storage, never in a data root. */
export function loadViews(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage(),
): SavedView[] {
  let raw: unknown;
  try {
    raw = JSON.parse(storage?.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: SavedView[] = [];
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r.name !== 'string' || !r.name.trim()) continue;
    if (r.view !== 'board' && r.view !== 'list') continue;
    const lanes = LANES.find(([k]) => k === r.lanes)?.[0];
    out.push({
      name: r.name,
      view: r.view,
      filter: cleanFilter(r.filter),
      ...(lanes ? { lanes } : {}),
    });
  }
  return out;
}

/** Adds or replaces the view with the same name; returns the new list. */
export function upsertView(views: SavedView[], v: SavedView): SavedView[] {
  const name = v.name.trim();
  return [...views.filter((x) => x.name !== name), { ...v, name }];
}

export function storeViews(
  views: SavedView[],
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(views));
    window.dispatchEvent(new Event(VIEWS_CHANGED));
  } catch {
    // No storage in this window: the view lasts until the app closes.
  }
}

const IDEAS_KEY = 'agent-ops.board-ideas';
export const IDEAS_CHANGED = 'agent-ops:board-ideas';

/** Whether the board shows ideas. Off until someone turns it on or creates an idea. */
export function boardShowsIdeas(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage(),
): boolean {
  try {
    return storage?.getItem(IDEAS_KEY) === 'on';
  } catch {
    return false;
  }
}

/** Remembers the board's Ideas toggle on this machine and tells an open board. */
export function setBoardShowsIdeas(
  on: boolean,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(IDEAS_KEY, on ? 'on' : 'off');
  } catch {
    // No storage in this window: the board falls back to hiding ideas.
  }
  try {
    window.dispatchEvent(new CustomEvent(IDEAS_CHANGED, { detail: on }));
  } catch {
    // No window, as in tests: nothing is listening.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
