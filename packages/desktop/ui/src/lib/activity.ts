// How the activity feed reads, groups and pages events. Pure, so it is tested without a browser.
import type { ActivityItem, ActivityPage } from '../types';
import { queryWords } from './search';

/** What each event type reads as in the feed. */
const VERBS: Record<string, string> = {
  created: 'created',
  claim: 'claimed',
  start: 'started',
  progress: 'reported progress on',
  checkpoint: 'saved a checkpoint on',
  comment: 'commented on',
  handoff: 'handed off',
  assign: 'assigned',
  review: 'sent for review',
  done: 'closed',
  ask: 'asked about',
  answer: 'answered on',
  block: 'blocked',
  unblock: 'unblocked',
  release: 'released',
  priority: 'changed the priority of',
  park: 'parked',
  reopen: 'reopened',
  finding: 'filed a finding from',
  learn: 'wrote a learn note from',
  'run-start': 'started a run on',
  'run-end': 'ended a run on',
  delegate: 'delegated',
  retype: 'changed the type of',
  merge: 'merged',
  post: 'posted in',
};

export const KINDS: Array<{ key: string; label: string; color: string; types: string[] }> = [
  {
    key: 'work',
    label: 'Work',
    color: '#5aa9ff',
    types: [
      'created',
      'claim',
      'start',
      'progress',
      'checkpoint',
      'done',
      'release',
      'handoff',
      'assign',
      'delegate',
      'park',
      'reopen',
      'retype',
      'priority',
      'block',
      'unblock',
    ],
  },
  { key: 'review', label: 'Reviews', color: '#b18cff', types: ['review', 'verdict', 'merge'] },
  { key: 'talk', label: 'Talk', color: '#5ce1e6', types: ['comment', 'ask', 'answer', 'post'] },
  { key: 'runs', label: 'Runs', color: '#3ddc97', types: ['run-start', 'run-end'] },
  { key: 'notes', label: 'Findings and notes', color: '#ffb547', types: ['finding', 'learn'] },
];

/** The filter keys of an activity query, as the core's `ACTIVITY_FILTERS`. */
export const ACTIVITY_FILTER_KEYS: ReadonlySet<string> = new Set([
  'agent',
  'who',
  'by',
  'project',
  'root',
  'task',
  'type',
  'kind',
  'channel',
  'in',
]);

/** The words of an activity query to mark in rows. */
export function activityWords(q: string): string[] {
  return queryWords(q, ACTIVITY_FILTER_KEYS);
}

/** The query opsd gets: the typed text, plus the Who, Project and kind filters. */
export function activityQuery(
  text: string,
  f: { who?: string; project?: string; kind?: string },
): string {
  return [
    text.trim(),
    f.who && `agent:${f.who}`,
    f.project && `project:${f.project}`,
    f.kind && `kind:${f.kind}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** An item's place in the feed, newest first, as opsd sorts it; also its paging cursor. */
export function activityKey(i: Pick<ActivityItem, 'at' | 'id' | 'kind' | 'root'>): string {
  return `${i.at}~${i.id}~${i.kind}~${i.root}`;
}

/** Negative when `a` shows before `b` (is newer). */
function compareItems(a: ActivityItem, b: ActivityItem): number {
  const x = [a.at, a.id, a.kind, a.root];
  const y = [b.at, b.id, b.kind, b.root];
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? 1 : -1;
  return 0;
}

/** What the view holds: every item loaded so far and the cursor for the next older page. */
export interface Loaded {
  items: ActivityItem[];
  next: string | null;
}

/**
 * Puts a fresh first page in front of the older pages already loaded. Older items stay when the
 * fresh page reaches them; when more new items arrived than a page holds, a gap would open, so
 * the view starts over from the fresh page.
 */
export function mergeFirstPage(
  prev: Loaded | null,
  page: Pick<ActivityPage, 'items' | 'next'>,
): Loaded {
  const last = page.items.at(-1);
  const first = prev?.items[0];
  if (!prev || !last || !first || page.next === null) {
    return { items: page.items, next: page.next };
  }
  // The fresh page ends older than everything loaded before: nothing old is left to keep.
  if (compareItems(first, last) > 0) return { items: page.items, next: page.next };
  const older = prev.items.filter((i) => compareItems(i, last) > 0);
  return older.length > 0
    ? { items: [...page.items, ...older], next: prev.next }
    : { items: page.items, next: page.next };
}

/** Adds an older page after the items loaded, each item once. */
export function appendPage(prev: Loaded, page: Pick<ActivityPage, 'items' | 'next'>): Loaded {
  const seen = new Set(prev.items.map(activityKey));
  return {
    items: [...prev.items, ...page.items.filter((i) => !seen.has(activityKey(i)))],
    next: page.next,
  };
}

export function verbOf(it: Pick<ActivityItem, 'type' | 'verdict'>): string {
  if (it.type === 'verdict') return it.verdict === 'approve' ? 'approved' : 'asked for changes on';
  return VERBS[it.type] ?? it.type;
}

export function kindOf(type: string): (typeof KINDS)[number] | undefined {
  return KINDS.find((k) => k.types.includes(type));
}
