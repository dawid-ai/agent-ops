import { BookOpen, Hash, Link2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Nav } from '../App';
import { q, useData } from '../api';
import { Empty, ErrorLine, Input, Section, Who, cx } from '../components';
import { ago, noteTaskRef } from '../lib/format';
import { hashColor } from '../lib/identity';
import { renderMarkdown } from '../lib/markdown';
import type { KbNote } from '../types';
import { RefText } from '../ui/refs';

/**
 * Learn notes from `kb/` across every root: topics on the left, search with the same matching
 * as `ops kb` (every word must match), the note on the right.
 */
export function Knowledge({ nav, selected }: { nav: Nav; selected?: string }) {
  const [text, setText] = useState('');
  const [topic, setTopic] = useState('');
  // `<root>/<topic>/<slug>` from a search result opens that note.
  const [picked, setPicked] = useState<string | null>(selected ?? null);
  const words = text.trim();
  // Topics come from the unfiltered list, so they stay put while searching.
  const all = useData<KbNote[]>('/api/kb');
  const params = [words && `q=${q(words)}`, topic && `topic=${q(topic)}`].filter(Boolean);
  const { data, error } = useData<KbNote[]>(
    params.length ? `/api/kb?${params.join('&')}` : '/api/kb',
  );
  const topics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of all.data ?? []) counts.set(n.topic, (counts.get(n.topic) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [all.data]);
  const notes = data ?? [];
  const key = (n: KbNote): string => `${n.root}/${n.ref}`;
  const note = notes.find((n) => key(n) === picked) ?? notes[0];

  return (
    <Section
      title="Knowledge"
      icon={BookOpen}
      subtitle={
        all.data
          ? `${all.data.length} learn notes in ${topics.length} topics`
          : 'Lessons agents and people wrote with ops learn'
      }
      actions={
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-2.5 left-2.5 text-fg-4" />
          <Input
            value={text}
            onChange={setText}
            placeholder="Search notes: every word must match"
            className="w-80 pl-8"
          />
        </div>
      }
    >
      <ErrorLine error={error ?? all.error} />
      {all.data && all.data.length === 0 ? (
        <Empty icon={BookOpen} title="No learn notes yet">
          Agents write one with <span className="font-mono">ops learn TOPIC TITLE</span> when they
          find something the next run should know. They show up here.
        </Empty>
      ) : (
        <div className="flex h-full min-h-0">
          <nav className="w-52 shrink-0 overflow-y-auto border-r border-white/6 p-3">
            <TopicButton active={!topic} onClick={() => setTopic('')} label="All topics" />
            {topics.map(([t, n]) => (
              <TopicButton
                key={t}
                active={topic === t}
                onClick={() => setTopic(t)}
                label={t}
                count={n}
                color={hashColor(t)}
              />
            ))}
          </nav>
          <div className="w-80 shrink-0 overflow-y-auto border-r border-white/6">
            {data && notes.length === 0 && (
              <div className="p-6 text-sm text-fg-4">No note matches every word.</div>
            )}
            {notes.map((n) => (
              <div
                key={key(n)}
                className={cx(
                  'row-link border-b border-white/5 px-4 py-3 transition',
                  note && key(note) === key(n)
                    ? 'bg-signal/8 shadow-[inset_2px_0_0_#5ce1e6]'
                    : 'hover:bg-white/4',
                )}
              >
                <div className="text-sm font-medium text-fg">
                  <RefText text={n.title} />
                </div>
                {/* The row's button: it names the note and stretches over the row. */}
                <button
                  type="button"
                  aria-label={n.title}
                  aria-pressed={note ? key(note) === key(n) : false}
                  onClick={() => setPicked(key(n))}
                  className="row-open mt-1 flex cursor-pointer items-center gap-2 text-xs text-fg-4"
                >
                  <span style={{ color: hashColor(n.topic) }}>#{n.topic}</span>
                  <span>·</span>
                  <span>{ago(n.created_at)}</span>
                </button>
              </div>
            ))}
          </div>
          <article className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
            {note && (
              <div className="animate-rise max-w-3xl" key={key(note)}>
                <div
                  className="font-mono text-xs"
                  style={{ color: hashColor(note.topic) }}
                >{`${note.root} · kb/${note.ref}.md`}</div>
                <h2 className="mt-1 font-display text-2xl font-semibold tracking-wide">
                  <RefText text={note.title} />
                </h2>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-3">
                  <Who id={note.author} label size="xs" />
                  <span>{ago(note.created_at)}</span>
                  {note.task && (
                    <button
                      type="button"
                      onClick={() => nav.openTask(noteTaskRef(note)!)}
                      className="inline-flex items-center gap-1 font-mono text-signal hover:underline"
                    >
                      <Link2 size={12} /> {note.task}
                    </button>
                  )}
                  {(note.tags ?? []).map((t) => (
                    <span key={t} className="rounded bg-white/6 px-1.5 py-0.5">
                      {t}
                    </span>
                  ))}
                </div>
                <div
                  className="md mt-6 text-sm leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(note.body) }}
                />
              </div>
            )}
          </article>
        </div>
      )}
    </Section>
  );
}

function TopicButton(props: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cx(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition',
        props.active ? 'bg-signal/10 text-signal' : 'text-fg-3 hover:bg-white/5 hover:text-fg',
      )}
    >
      <Hash size={13} style={props.color ? { color: props.color } : undefined} />
      <span className="truncate">{props.label}</span>
      {props.count !== undefined && (
        <span className="ml-auto text-xs text-fg-4">{props.count}</span>
      )}
    </button>
  );
}
