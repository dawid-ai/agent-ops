import { History, Search as SearchIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, q, useRefresh } from '../api';
import { Avatar, Button, Empty, ErrorLine, Input, Section, Who, cx } from '../components';
import { ago } from '../lib/format';
import { identity } from '../lib/identity';
import {
  activityKey,
  activityQuery,
  activityWords,
  appendPage,
  KINDS,
  kindOf,
  mergeFirstPage,
  verbOf,
} from '../lib/activity';
import type { Loaded } from '../lib/activity';
import type { ActivityItem, ActivityPage } from '../types';
import { FilterChip } from '../ui/filters';
import { RefText } from '../ui/refs';
import { Highlight } from '../ui/search';

const PAGE = 100;

interface Feed extends Loaded {
  /** The query these items answer. */
  query: string;
  total: number;
  actors: string[];
  projects: string[];
}

/**
 * The feed for `query`: the newest page, fetched again on every refresh signal and merged in
 * front of the older pages loaded with `more`. Typing waits 200 ms before it asks opsd.
 */
function useFeed(query: string): {
  feed: Feed | null;
  error: string | null;
  loading: boolean;
  more: () => void;
} {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the newest first-page request may set state, so a slow answer for older text never
  // shows under newer text.
  const seq = useRef(0);
  const first = useCallback(() => {
    const mine = ++seq.current;
    api<ActivityPage>('GET', `/api/activity?limit=${PAGE}&q=${q(query)}`).then(
      (page) => {
        if (mine !== seq.current) return;
        setFeed((prev) => ({
          query,
          ...mergeFirstPage(prev && prev.query === query ? prev : null, page),
          total: page.total,
          actors: page.actors,
          projects: page.projects,
        }));
        setError(null);
      },
      (e: Error) => {
        if (mine === seq.current) setError(e.message);
      },
    );
  }, [query]);
  useEffect(() => {
    const t = setTimeout(first, 200);
    return () => clearTimeout(t);
  }, [first]);
  useRefresh(first);
  const more = (): void => {
    const cursor = feed?.query === query ? feed.next : null;
    if (!cursor || loading) return;
    setLoading(true);
    api<ActivityPage>('GET', `/api/activity?limit=${PAGE}&q=${q(query)}&before=${q(cursor)}`)
      .then(
        (page) =>
          // A new query or a reset since the request: this page belongs to neither.
          setFeed((prev) =>
            prev && prev.query === query && prev.next === cursor
              ? { ...prev, ...appendPage(prev, page) }
              : prev,
          ),
        (e: Error) => setError(e.message),
      )
      .finally(() => setLoading(false));
  };
  return { feed, error, loading, more };
}

/**
 * Every task event and channel post, archived tasks included, newest first, by day. The search
 * box filters by words and `agent:`, `task:`, `project:`, `kind:` or `type:`; older pages load on
 * request.
 */
export function Activity({ nav }: { nav: Nav }) {
  const [text, setText] = useState('');
  const [who, setWho] = useState('');
  const [project, setProject] = useState('');
  const [kind, setKind] = useState('');
  const query = activityQuery(text, { who, project, kind });
  const { feed, error, loading, more } = useFeed(query);
  const current = feed?.query === query;
  const shown = feed?.items ?? [];
  const words = activityWords(text);
  const days: Array<{ day: string; items: ActivityItem[] }> = [];
  for (const i of shown) {
    const day = new Date(i.at).toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push(i);
    else days.push({ day, items: [i] });
  }
  const actors = feed?.actors ?? [];
  const projects = feed?.projects ?? [];
  return (
    <Section
      title="Activity"
      icon={History}
      subtitle={
        feed
          ? `${feed.total} ${feed.total === 1 ? 'event' : 'events'}${
              feed.total > shown.length ? `, newest ${shown.length} shown` : ''
            }`
          : 'Everything agents and people did'
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
            placeholder="Words, or agent:codex task:AO-0061 kind:review"
            className="w-96 pl-8"
          />
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2 px-6 pt-4 pb-2">
        <FilterChip
          label="Who"
          icon={<History size={14} />}
          value={who}
          display={<Who id={who} size="xs" />}
          onChange={setWho}
          width={280}
          options={actors.map((a) => ({ value: a, node: <Who id={a} label /> }))}
        />
        {projects.length > 0 && (
          <FilterChip
            label="Project"
            icon={<History size={14} />}
            value={project}
            display={<span className="font-mono text-xs">{project}</span>}
            onChange={setProject}
            options={projects.map((p) => ({
              value: p,
              node: <span className="font-mono text-xs">{p}</span>,
            }))}
          />
        )}
        <div className="flex rounded-lg bg-white/5 p-0.5">
          {[{ key: '', label: 'All', color: '#e6edf3' }, ...KINDS].map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setKind(k.key)}
              className={cx(
                'rounded-md px-2.5 py-1 text-xs transition',
                kind === k.key ? 'bg-white/10' : 'text-fg-3 hover:text-fg',
              )}
              style={kind === k.key ? { color: k.color } : undefined}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <div className={cx('px-6 pb-6', !current && feed && 'opacity-60')}>
        <ErrorLine error={error} />
        {feed && current && shown.length === 0 && (
          <Empty icon={History} title={query ? 'Nothing found' : 'Nothing here yet'}>
            {query ? (
              <>
                Every word must match. Try fewer words, or a filter such as{' '}
                <span className="font-mono">agent:codex</span> or{' '}
                <span className="font-mono">task:AO-0061</span>.
              </>
            ) : (
              'Claims, reviews, comments, runs and channel posts show up here as they happen.'
            )}
          </Empty>
        )}
        {days.map((d, n) => (
          <div key={`${n}:${d.day}`} className="mt-4">
            <div className="label-caps sticky top-0 z-10 bg-ink-900/90 py-1.5 backdrop-blur">
              {d.day}
            </div>
            <ol className="relative ml-3 border-l border-white/8">
              {d.items.map((i) => (
                <Row key={activityKey(i)} i={i} nav={nav} words={words} />
              ))}
            </ol>
          </div>
        ))}
        {current && feed?.next && (
          <div className="mt-4 flex justify-center">
            <Button size="sm" onClick={more} disabled={loading}>
              {loading ? 'Loading…' : `Show ${PAGE} older`}
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}

function Row({ i, nav, words }: { i: ActivityItem; nav: Nav; words: string[] }) {
  const k = kindOf(i.type);
  const who = identity(i.actor);
  const ref = i.task ? `${i.root}/${i.task}` : null;
  const time = new Date(i.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return (
    <li className="group relative py-2 pl-6">
      <span
        className="absolute top-3.5 -left-[5px] h-2.5 w-2.5 rounded-full ring-4 ring-ink-900"
        style={{ background: k?.color ?? '#7f8899' }}
      />
      <div className="flex items-start gap-2.5">
        <Avatar id={i.actor} size={22} />
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-mono text-xs" style={{ color: who.provider.color }}>
            {i.actor}
          </span>{' '}
          <span className="text-fg-3">{verbOf(i)}</span>{' '}
          {i.kind === 'channel' ? (
            <button
              type="button"
              onClick={() => nav.go('channels', i.channel)}
              className="font-medium text-fg hover:text-signal"
            >
              #{i.channel}
            </button>
          ) : (
            ref && (
              <span className="row-link text-fg hover:text-signal">
                <button
                  type="button"
                  onClick={() => nav.openTask(ref)}
                  className="row-open cursor-pointer font-mono text-xs text-fg-4"
                >
                  {i.task}
                </button>{' '}
                <RefText
                  text={i.title ?? ''}
                  render={(s) => <Highlight text={s} words={words} />}
                />
                {i.archived && <span className="ml-1.5 text-[11px] text-fg-4">archived</span>}
              </span>
            )
          )}
          {i.to && i.type !== 'post' && (
            <span className="text-fg-3">
              {' '}
              → <span className="font-mono text-xs">{i.to}</span>
            </span>
          )}
          {i.body && (
            <div className="mt-0.5 line-clamp-2 text-xs text-fg-3">
              <RefText text={i.body} render={(s) => <Highlight text={s} words={words} />} />
            </div>
          )}
        </div>
        <span className="shrink-0 text-[11px] text-fg-4" title={ago(i.at)}>
          {time}
        </span>
      </div>
    </li>
  );
}
