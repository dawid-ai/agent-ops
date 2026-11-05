// Search helpers for the UI. Pure functions, so they are tested without a browser.
import type { Nav } from '../App';
import type { SearchHit, SearchResult } from '../types';

const FILTER_KEYS = new Set([
  'agent',
  'who',
  'by',
  'status',
  'project',
  'type',
  'priority',
  'root',
  'is',
  'in',
]);

/**
 * The words of a query to mark in results: free words and phrases, never filters. `keys` are the
 * filter keys the query knows; the Activity view passes its own.
 */
export function queryWords(q: string, keys: ReadonlySet<string> = FILTER_KEYS): string[] {
  const out: string[] = [];
  // Same rules as the core's tokenize: an unclosed quote runs to the end of the text.
  for (const m of q.matchAll(/"([^"]*)("|$)|(\S+)/g)) {
    if (m[3] === undefined) {
      const phrase = m[1]!.trim().toLowerCase();
      if (phrase) out.push(phrase);
      continue;
    }
    const raw = m[3];
    const at = raw.indexOf(':');
    if (at > 0 && keys.has(raw.slice(0, at).toLowerCase()) && raw.length > at + 1) continue;
    out.push(raw.toLowerCase());
  }
  return out;
}

/** Splits text into marked and plain parts for the query's words, case-insensitive. */
export function highlightParts(
  text: string,
  words: string[],
): Array<{ text: string; hit: boolean }> {
  const ws = [...new Set(words.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (ws.length === 0 || !text) return [{ text, hit: false }];
  const re = new RegExp(
    `(${ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  const parts: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at), hit: false });
    parts.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}

/**
 * The Channels view's argument for one post: `name?root=R&msg=ID`. A plain `name` opens the
 * channel's newest messages across roots.
 */
export function channelTarget(c: { channel: string; root?: string; msg?: string }): string {
  const params = new URLSearchParams();
  if (c.root) params.set('root', c.root);
  if (c.msg) params.set('msg', c.msg);
  const tail = params.toString();
  return tail ? `${c.channel}?${tail}` : c.channel;
}

/** Reads `channelTarget`'s argument back. */
export function parseChannelTarget(arg: string | undefined): {
  channel?: string;
  root?: string;
  msg?: string;
} {
  if (!arg) return {};
  const at = arg.indexOf('?');
  if (at < 0) return { channel: arg };
  const params = new URLSearchParams(arg.slice(at + 1));
  return {
    channel: arg.slice(0, at),
    root: params.get('root') || undefined,
    msg: params.get('msg') || undefined,
  };
}

/**
 * The messages a channel shows: the newest 200 across roots, or, for a search result, the 200
 * of its root around that post.
 */
export function channelUrl(channel: string, focus: { root?: string; msg?: string } = {}): string {
  const params = new URLSearchParams({ limit: '200' });
  if (focus.msg) {
    if (focus.root) params.set('root', focus.root);
    params.set('around', focus.msg);
  }
  return `/api/channels/${encodeURIComponent(channel)}?${params.toString()}`;
}

/** Opens what a hit points at: the task panel, the note, the post in its channel, or the vote. */
export function openHit(nav: Pick<Nav, 'openTask' | 'go'>, hit: SearchHit): void {
  if (hit.kind === 'task') nav.openTask(hit.ref);
  else if (hit.kind === 'note') nav.go('knowledge', `${hit.root}/${hit.ref}`);
  else if (hit.kind === 'post') {
    nav.go(
      'channels',
      channelTarget({ channel: hit.ref.replace(/^#/, ''), root: hit.root, msg: hit.event }),
    );
  }
  // Votes open with decided ones shown, on this vote.
  else nav.go('decisions', `${hit.root}/${hit.ref}`);
}

/**
 * What Enter in the search box opens: the row picked with the arrow keys, but only while the
 * rows shown belong to the text in the box; otherwise every result for the current text.
 */
export function enterTarget(s: { current: boolean; pick: number; count: number }): number | 'all' {
  return s.current && s.pick >= 0 && s.pick < s.count ? s.pick : 'all';
}

/** What the search shows: the hits, the text they answer, and whether a newer answer is due. */
export interface SearchState {
  hits?: SearchHit[];
  /** The trimmed text `hits` answer. */
  forText: string;
  /** opsd stopped at its work budget: some items were not searched. */
  partial: boolean;
  error: string | null;
  busy: boolean;
}

export const NO_SEARCH: SearchState = { forText: '', partial: false, error: null, busy: false };

/** True when the hits shown answer `query`, so a row may be opened. */
export function isCurrent(s: SearchState, query: string): boolean {
  return Boolean(s.hits) && s.forText === query.trim();
}

/** The hit a click opens: none while the rows belong to an earlier query. */
export function openable(s: SearchState, query: string, hit: SearchHit): SearchHit | null {
  return isCurrent(s, query) ? hit : null;
}

/**
 * Runs searches `delay` ms after the last `query` call. Earlier hits stay until newer ones arrive,
 * and an answer for older text never replaces a newer one, whatever order the answers come in.
 */
export function searchRunner(
  fetch: (text: string) => Promise<SearchResult>,
  onChange: (s: SearchState) => void,
  delay = 200,
): { query: (text: string) => void; stop: () => void; state: () => SearchState } {
  let state = NO_SEARCH;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (patch: Partial<SearchState>): void => {
    state = { ...state, ...patch };
    onChange(state);
  };
  return {
    query(raw) {
      const text = raw.trim();
      const mine = ++seq;
      clearTimeout(timer);
      if (!text) {
        set({ hits: undefined, forText: '', partial: false, error: null, busy: false });
        return;
      }
      set({ busy: true });
      timer = setTimeout(() => {
        fetch(text).then(
          ({ hits, partial }) => {
            if (mine === seq) set({ hits, forText: text, partial, error: null, busy: false });
          },
          (e: Error) => {
            if (mine === seq) set({ error: e.message, busy: false });
          },
        );
      }, delay);
    },
    stop() {
      seq++;
      clearTimeout(timer);
    },
    state: () => state,
  };
}
