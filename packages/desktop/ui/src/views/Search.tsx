import { Search as SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Nav } from '../App';
import { Empty, ErrorLine, Input, Section, cx } from '../components';
import { queryWords } from '../lib/search';
import type { SearchHit } from '../types';
import { HitRow, KIND_LABEL, openHit, PARTIAL_TEXT, Tips, useSearch } from '../ui/search';

const KINDS: Array<SearchHit['kind']> = ['task', 'note', 'post', 'vote'];

/**
 * Every result for a query: tasks (id, title, description and thread), learn notes, channel posts
 * and votes. Opened from the sidebar's search box with Enter.
 */
export function Search({ nav, initial }: { nav: Nav; initial?: string }) {
  const [text, setText] = useState(initial ?? '');
  useEffect(() => setText(initial ?? ''), [initial]);
  const [only, setOnly] = useState<SearchHit['kind'] | null>(null);
  const search = useSearch(text, 200);
  const { hits, partial, error, busy, current } = search;
  const words = queryWords(text);
  const list = (hits ?? []).filter((h) => !only || h.kind === only);
  const counts = new Map<SearchHit['kind'], number>();
  for (const h of hits ?? []) counts.set(h.kind, (counts.get(h.kind) ?? 0) + 1);
  return (
    <Section
      title="Search"
      icon={SearchIcon}
      subtitle={
        hits
          ? `${hits.length}${hits.length === 200 ? '+' : ''} results`
          : 'Tasks, threads, learn notes, channel posts and votes'
      }
      actions={
        <div className="relative">
          <SearchIcon
            size={14}
            className="pointer-events-none absolute top-2.5 left-2.5 text-fg-4"
          />
          <Input
            value={text}
            onChange={setText}
            autoFocus
            placeholder="Words, an id, or agent:codex status:blocked"
            className="w-96 pl-8"
          />
        </div>
      }
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
        <ErrorLine error={error} />
        {text.trim() && current && partial && (
          <div className="text-xs text-fg-4">{PARTIAL_TEXT}</div>
        )}
        {hits && hits.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!only} onClick={() => setOnly(null)}>
              All {hits.length}
            </Chip>
            {KINDS.filter((k) => counts.get(k)).map((k) => (
              <Chip key={k} active={only === k} onClick={() => setOnly(only === k ? null : k)}>
                {KIND_LABEL[k]}s {counts.get(k)}
              </Chip>
            ))}
          </div>
        )}
        {!text.trim() ? (
          <div className="panel p-5">
            <div className="label-caps mb-3">Search by text, id or agent</div>
            <Tips onPick={(ex) => setText(`${ex} `)} />
          </div>
        ) : hits && hits.length === 0 && !busy ? (
          <Empty icon={SearchIcon} title="Nothing found">
            Every word must match. Try fewer words, or a filter such as{' '}
            <span className="font-mono">agent:codex</span>.
          </Empty>
        ) : (
          <div className="panel flex flex-col gap-0.5 p-2">
            {list.map((h) => (
              <HitRow
                key={`${h.kind}:${h.ref}:${h.event ?? ''}`}
                hit={h}
                words={words}
                stale={!current}
                onOpen={() => search.open(h, (x) => openHit(nav, x))}
              />
            ))}
            {!hits && <div className="p-2 text-xs text-fg-4">Searching…</div>}
          </div>
        )}
      </div>
    </Section>
  );
}

function Chip(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cx(
        'rounded-full px-3 py-1 text-xs ring-1 ring-inset transition',
        props.active
          ? 'bg-signal/15 text-signal ring-signal/40'
          : 'text-fg-3 ring-white/10 hover:text-fg',
      )}
    >
      {props.children}
    </button>
  );
}
