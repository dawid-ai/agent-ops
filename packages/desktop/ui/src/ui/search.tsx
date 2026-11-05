// The search bar in the sidebar, its results, and the pieces the Search view shares with it.
import type { LucideIcon } from 'lucide-react';
import { BookOpen, Hash, ListTodo, Search as SearchIcon, Vote, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, q } from '../api';
import { cx, Who } from '../components';
import { ago } from '../lib/format';
import type { SearchState } from '../lib/search';
import {
  enterTarget,
  highlightParts,
  isCurrent,
  NO_SEARCH,
  openable,
  openHit,
  queryWords,
  searchRunner,
} from '../lib/search';
export { openHit };
import { RefText } from './refs';
import type { SearchHit, SearchResult } from '../types';

export const KIND_ICON: Record<SearchHit['kind'], LucideIcon> = {
  task: ListTodo,
  note: BookOpen,
  post: Hash,
  vote: Vote,
};

export const KIND_LABEL: Record<SearchHit['kind'], string> = {
  task: 'Task',
  note: 'Learn note',
  post: 'Channel post',
  vote: 'Vote',
};

/**
 * Results for a query, 200 ms after the last keystroke (see `searchRunner`). `current` is false
 * while the hits shown belong to an earlier query; `open` then ignores a row, so neither a click
 * nor Enter acts on a row for old text.
 */
export function useSearch(
  query: string,
  limit: number,
): {
  hits: SearchHit[] | undefined;
  partial: boolean;
  error: string | null;
  busy: boolean;
  current: boolean;
  open: (hit: SearchHit, go: (hit: SearchHit) => void) => void;
} {
  const [state, setState] = useState<SearchState>(NO_SEARCH);
  const runner = useMemo(
    () =>
      searchRunner(
        (text) => api<SearchResult>('GET', `/api/search?q=${q(text)}&limit=${limit}`),
        setState,
      ),
    [limit],
  );
  useEffect(() => runner.query(query), [runner, query]);
  useEffect(() => () => runner.stop(), [runner]);
  return {
    hits: state.hits,
    partial: state.partial,
    error: state.error,
    busy: state.busy,
    current: isCurrent(state, query),
    open: (hit, go) => {
      const h = openable(runner.state(), query, hit);
      if (h) go(h);
    },
  };
}

/** Text with the query's words marked. */
export function Highlight({ text, words }: { text: string; words: string[] }) {
  return (
    <>
      {highlightParts(text, words).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-signal/25 px-0.5 text-fg">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

const FIELD_TEXT: Record<string, string> = {
  id: 'id',
  title: 'title',
  description: 'description',
  thread: 'thread',
  body: 'text',
  filter: 'filters',
};

/**
 * One result: kind, title, where it matched, the snippet, who and when. A `stale` row belongs to
 * earlier text: it stays visible, dimmed, and does not open.
 */
export function HitRow({
  hit,
  words,
  active,
  compact,
  stale,
  onOpen,
}: {
  hit: SearchHit;
  words: string[];
  active?: boolean;
  compact?: boolean;
  stale?: boolean;
  onOpen: () => void;
}) {
  const Icon = KIND_ICON[hit.kind];
  // References in the title and snippet are links; a stale row shows them as text, since
  // nothing on it opens.
  const text = (s: string) => (
    <RefText text={s} links={!stale} render={(t) => <Highlight text={t} words={words} />} />
  );
  return (
    <div
      className={cx(
        'row-link flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left transition',
        stale ? 'opacity-50' : active ? 'bg-white/8' : 'hover:bg-white/5',
      )}
    >
      <button
        type="button"
        disabled={stale}
        aria-disabled={stale}
        aria-label={`Open ${KIND_LABEL[hit.kind].toLowerCase()}: ${hit.title}`}
        onClick={stale ? undefined : onOpen}
        className={cx('row-open mt-0.5 shrink-0', stale ? 'cursor-default' : 'cursor-pointer')}
      >
        <Icon size={14} className="text-fg-3" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {hit.kind === 'task' && (
            <span className="shrink-0 font-mono text-[11px] text-signal">
              {hit.ref.split('/').pop()}
            </span>
          )}
          <span className="truncate text-sm text-fg">{text(hit.title)}</span>
          {hit.status && (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-4">{hit.status}</span>
          )}
        </div>
        {hit.snippet && (
          <div
            className={cx('mt-0.5 text-xs text-fg-3', compact ? 'line-clamp-1' : 'line-clamp-2')}
          >
            {text(hit.snippet)}
          </div>
        )}
        {!compact && (
          <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-4">
            <span>{KIND_LABEL[hit.kind]}</span>
            <span>· matched in {FIELD_TEXT[hit.field] ?? hit.field}</span>
            {hit.actor && (
              <>
                <span>·</span>
                <Who id={hit.actor} size="xs" />
              </>
            )}
            <span>· {ago(hit.at)}</span>
            {hit.root && <span className="ml-auto font-mono">{hit.root}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Shown when opsd stopped at its work budget before it searched every item. */
export const PARTIAL_TEXT =
  'Searched part of the store. Search again to cover more, or narrow it with in: or root:.';

/** Filter examples shown under the search box and on the Search view. */
export const SEARCH_TIPS: Array<[string, string]> = [
  ['AO-0047 or 47', 'a task by id'],
  ['agent:codex', 'owned, written or acted on by Codex (also qa, claude:engineer, dawid)'],
  ['status:blocked', 'todo, claimed, in-progress, blocked, needs-review, done, parked'],
  ['is:open', 'or is:closed'],
  ['project:v2', 'also type:bug, priority:p1, root:NAME'],
  ['in:notes', 'only learn notes; also in:tasks, in:posts, in:votes'],
  ['"exact phrase"', 'words in quotes match together'],
];

export function Tips({ onPick }: { onPick?: (example: string) => void }): ReactNode {
  return (
    <div className="grid gap-1 text-xs">
      {SEARCH_TIPS.map(([ex, text]) => (
        <div key={ex} className="flex gap-2">
          <button
            type="button"
            onClick={() => onPick?.(ex.split(' ')[0]!)}
            className="shrink-0 font-mono text-signal hover:underline"
          >
            {ex}
          </button>
          <span className="text-fg-4">{text}</span>
        </div>
      ))}
    </div>
  );
}

export const SEARCH_INPUT_ID = 'global-search';

/**
 * The sidebar's search box: results drop down as you type; Enter opens the full Search view,
 * arrow keys pick a result, Esc closes. Ctrl+F focuses it from anywhere.
 */
export function SearchBox({ nav }: { nav: Nav }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(-1);
  const search = useSearch(open ? text : '', 8);
  const { hits, partial, error, busy, current } = search;
  const words = queryWords(text);
  const box = useRef<HTMLDivElement>(null);
  // A new text or new results drop the arrow-key pick, so Enter never opens a row for old text.
  useEffect(() => setPick(-1), [hits, text]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);
  const all = (): void => {
    if (!text.trim()) return;
    setOpen(false);
    nav.go('search', text.trim());
  };
  const choose = (hit: SearchHit): void =>
    search.open(hit, (h) => {
      setOpen(false);
      openHit(nav, h);
    });
  const list = hits ?? [];
  return (
    <div ref={box} className="relative px-3 pb-2">
      <div className="relative">
        <SearchIcon size={14} className="pointer-events-none absolute top-2.5 left-2.5 text-fg-4" />
        <input
          id={SEARCH_INPUT_ID}
          type="search"
          value={text}
          placeholder="Search everything"
          aria-label="Search tasks, notes, posts and votes"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (text) setText('');
              else (e.target as HTMLInputElement).blur();
              setOpen(false);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setPick((p) => Math.min(p + 1, list.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setPick((p) => Math.max(p - 1, -1));
            } else if (e.key === 'Enter') {
              const target = enterTarget({ current, pick, count: list.length });
              if (target === 'all') all();
              else choose(list[target]!);
            }
          }}
          className="h-8 w-full rounded-lg bg-white/5 pr-12 pl-8 text-sm text-fg ring-1 ring-white/8 outline-none ring-inset placeholder:text-fg-4 focus:ring-signal/50 [&::-webkit-search-cancel-button]:hidden"
        />
        {text ? (
          <button
            type="button"
            aria-label="Clear the search"
            onClick={() => setText('')}
            className="absolute top-2 right-2 text-fg-4 hover:text-fg"
          >
            <X size={14} />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-1.5 right-2 rounded bg-white/6 px-1.5 py-0.5 font-mono text-[10px] text-fg-4">
            Ctrl+F
          </kbd>
        )}
      </div>
      {open && (
        <div
          // A task reference in a row opens the task panel (App), so the results close, as they
          // do when a row opens.
          onClick={(e) => {
            if ((e.target as Element).closest('a[data-task-ref]')) setOpen(false);
          }}
          className="absolute top-full left-3 z-40 mt-1 w-[440px] rounded-xl border border-white/10 bg-ink-900 p-1.5 shadow-2xl"
        >
          {!text.trim() ? (
            <div className="p-2">
              <div className="label-caps mb-2 !text-[10px]">Search by text, id or agent</div>
              <Tips
                onPick={(ex) => {
                  setText(`${ex} `);
                  document.getElementById(SEARCH_INPUT_ID)?.focus();
                }}
              />
            </div>
          ) : error ? (
            <div className="p-2 text-xs text-bad">{error}</div>
          ) : list.length === 0 ? (
            <div className="p-2 text-xs text-fg-4">
              {busy || !hits ? 'Searching…' : 'Nothing found'}
            </div>
          ) : (
            list.map((h, i) => (
              <HitRow
                key={`${h.kind}:${h.ref}:${h.event ?? ''}`}
                hit={h}
                words={words}
                compact
                stale={!current}
                active={i === pick}
                onOpen={() => choose(h)}
              />
            ))
          )}
          {text.trim() && current && partial && (
            <div className="px-2.5 pt-1 text-[11px] text-fg-4">{PARTIAL_TEXT}</div>
          )}
          {text.trim() && (
            <button
              type="button"
              onClick={all}
              className="mt-1 flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-fg-3 hover:bg-white/5"
            >
              <span>All results for “{text.trim()}”</span>
              <kbd className="font-mono text-[10px] text-fg-4">Enter</kbd>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
