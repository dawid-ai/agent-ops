import type { LucideIcon } from 'lucide-react';
import {
  CalendarClock,
  CircleCheck,
  CircleDot,
  GitPullRequestArrow,
  Hammer,
  Newspaper,
  Send,
} from 'lucide-react';
import { useState } from 'react';
import type { Nav } from '../App';
import { api, refreshSoon, useData } from '../api';
import { Avatar, Button, Empty, ErrorLine, Section, Stat, useAction, Who, cx } from '../components';
import { ago, minutes, tokens } from '../lib/format';
import { identity } from '../lib/identity';
import { renderMarkdown } from '../lib/markdown';
import type { Standup, StandupEntry, StandupItem } from '../types';
import { MentionArea } from '../ui/pickers';
import { RefText } from '../ui/refs';

const RANGES: Array<[number, string]> = [
  [24, 'Last 24 h'],
  [72, '3 days'],
  [168, 'Week'],
];

/**
 * The standup: what every agent and person finished, sent for review, works on and is stuck on,
 * built from the task history (no agent has to write it), next to the #standup channel.
 */
export function Standups({ nav }: { nav: Nav }) {
  const [hours, setHours] = useState(24);
  const { data, error } = useData<Standup>(`/api/standup?hours=${hours}`);
  const agents = (data?.agents ?? []).filter(
    (a) => a.done.length + a.review.length + a.working.length + a.blocked.length + a.runs > 0,
  );
  const sum = (f: (a: StandupEntry) => number): number => agents.reduce((n, a) => n + f(a), 0);
  return (
    <Section
      title="Standups"
      icon={Newspaper}
      subtitle="Built from the task history: done, in review, working, blocked"
      actions={
        <>
          <div className="flex rounded-lg bg-white/5 p-0.5">
            {RANGES.map(([h, label]) => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs transition',
                  hours === h ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Button icon={CalendarClock} onClick={() => nav.go('schedules', 'standup')}>
            Schedule agent standups
          </Button>
        </>
      }
    >
      <div className="flex min-h-full gap-5 p-6">
        <div className="min-w-0 flex-1">
          <ErrorLine error={error} />
          {data && (
            <div className="mb-5 flex flex-wrap gap-3">
              <Stat label="Done" value={sum((a) => a.done.length)} tone="#3ddc97" />
              <Stat label="In review" value={sum((a) => a.review.length)} tone="#b18cff" />
              <Stat label="Working" value={sum((a) => a.working.length)} tone="#5aa9ff" />
              <Stat label="Blocked" value={sum((a) => a.blocked.length)} tone="#ffb547" />
              <Stat
                label="Runs"
                value={sum((a) => a.runs)}
                hint={`${tokens(sum((a) => a.tokens))} tokens`}
              />
            </div>
          )}
          {data && agents.length === 0 && (
            <Empty icon={Newspaper} title="Quiet so far">
              Nothing finished, reviewed, started or blocked in this window. Pick a longer range, or
              let agents work.
            </Empty>
          )}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {agents.map((a, i) => (
              <AgentCard key={a.agent} a={a} nav={nav} index={i} />
            ))}
          </div>
        </div>
        <StandupChannel nav={nav} posts={data?.posts ?? []} />
      </div>
    </Section>
  );
}

function AgentCard({ a, nav, index }: { a: StandupEntry; nav: Nav; index: number }) {
  const who = identity(a.agent);
  return (
    <div
      className="panel animate-rise overflow-hidden"
      style={{ animationDelay: `${index * 40}ms`, borderTop: `2px solid ${who.provider.color}` }}
    >
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-2">
        <Avatar id={a.agent} size={34} />
        <div className="min-w-0">
          <Who id={a.agent} plain size="md" />
          <div className="text-xs text-fg-4">
            {who.human ? 'Person' : `${who.provider.label} · ${who.roleInfo.label}`}
          </div>
        </div>
        {a.runs > 0 && (
          <div className="ml-auto text-right text-xs text-fg-3">
            <div className="font-display text-base text-fg">{a.runs} runs</div>
            {minutes(a.minutes)} · {tokens(a.tokens)} tokens
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
        <Group icon={CircleCheck} color="#3ddc97" title="Done" items={a.done} nav={nav} />
        <Group
          icon={GitPullRequestArrow}
          color="#b18cff"
          title="In review"
          items={a.review}
          nav={nav}
        />
        <Group icon={Hammer} color="#5aa9ff" title="Working on" items={a.working} nav={nav} />
        <Group icon={CircleDot} color="#ffb547" title="Blocked" items={a.blocked} nav={nav} />
      </div>
    </div>
  );
}

function Group(props: {
  icon: LucideIcon;
  color: string;
  title: string;
  items: StandupItem[];
  nav: Nav;
}) {
  if (props.items.length === 0) return null;
  const Icon = props.icon;
  return (
    <div>
      <div
        className="mb-1 flex items-center gap-1.5 text-xs font-medium"
        style={{ color: props.color }}
      >
        <Icon size={13} /> {props.title}
        <span className="text-fg-4">{props.items.length}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {props.items.map((it) => (
          <li
            key={`${it.task}-${it.at}`}
            className="row-link group flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 hover:bg-white/5"
          >
            <button
              type="button"
              onClick={() => props.nav.openTask(it.task)}
              aria-label={`Open ${it.task.split('/').pop()}: ${it.title}`}
              className="row-open shrink-0 cursor-pointer font-mono text-[11px] text-fg-4"
            >
              {it.task.split('/').pop()}
            </button>
            <span className="min-w-0 flex-1">
              <span className="text-sm text-fg-2 group-hover:text-fg">
                <RefText text={it.title} />
              </span>
              {it.note && (
                <span className="block truncate text-xs text-fg-4">
                  <RefText text={it.note} />
                </span>
              )}
            </span>
            <span className="shrink-0 text-[11px] text-fg-4">{ago(it.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `#standup`: what people and agents wrote themselves, and a box to post yours. */
function StandupChannel({ nav, posts }: { nav: Nav; posts: Standup['posts'] }) {
  const [text, setText] = useState('');
  const act = useAction();
  const post = (): void => {
    if (!text.trim() || act.busy) return;
    act.run(
      () => api('POST', '/api/channels/standup', { as: nav.me, message: text }),
      () => {
        setText('');
        refreshSoon();
      },
    );
  };
  return (
    <aside className="panel flex w-[340px] shrink-0 flex-col self-start">
      <div className="flex items-center gap-2 border-b border-white/7 px-4 py-3">
        <span className="font-display font-semibold tracking-wide">#standup</span>
        <button
          className="ml-auto text-xs text-fg-4 hover:text-signal"
          onClick={() => nav.go('channels', 'standup')}
        >
          open channel
        </button>
      </div>
      <div className="flex max-h-[52vh] flex-col gap-3 overflow-auto px-4 py-3">
        {posts.length === 0 && (
          <div className="py-4 text-center text-xs text-fg-4">No posts in this window.</div>
        )}
        {posts.map((m) => (
          <div key={m.id}>
            <div className="flex items-center gap-2 text-xs">
              <Who id={m.actor} size="xs" />
              <span className="ml-auto text-fg-4">{ago(m.at)}</span>
            </div>
            <div
              className="md mt-1 text-sm text-fg-2"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(m.body) }}
            />
          </div>
        ))}
      </div>
      <div className="border-t border-white/7 p-3">
        <MentionArea
          value={text}
          onChange={setText}
          me={nav.me}
          rows={3}
          placeholder={'Done: …\nNext: …\nBlocked: …'}
          onSubmit={post}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-fg-4">Ctrl+Enter posts</span>
          <Button
            kind="primary"
            size="sm"
            icon={Send}
            disabled={!text.trim() || act.busy || !nav.me}
            onClick={post}
          >
            Post
          </Button>
        </div>
        <ErrorLine error={act.error} />
      </div>
    </aside>
  );
}
