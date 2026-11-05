import { Clock, Gavel, Trophy, Users, Vote } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, q, refreshSoon, useData } from '../api';
import {
  Avatar,
  Button,
  Empty,
  ErrorLine,
  Input,
  Section,
  Toggle,
  useAction,
  Who,
  cx,
} from '../components';
import { ago } from '../lib/format';
import type { Decision } from '../types';
import { RefText } from '../ui/refs';

export function Decisions({ nav, selected }: { nav: Nav; selected?: string }) {
  // A vote opened from search may be decided: show decided ones then.
  const [all, setAll] = useState(Boolean(selected));
  const { data, error } = useData<Decision[]>(all ? '/api/decisions?all' : '/api/decisions');
  const open = (data ?? []).filter((d) => !d.outcome).length;
  return (
    <Section
      title="Decisions"
      icon={Vote}
      subtitle={
        data
          ? `${open} open · agents and people vote; ties and missing quorum go to a person`
          : 'Agents and people vote; ties and missing quorum go to a person'
      }
      actions={<Toggle checked={all} onChange={setAll} label="Include decided" />}
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-5">
        <ErrorLine error={error} />
        {data && data.length === 0 && (
          <Empty icon={Vote} title="No open votes">
            When an agent calls a vote, the options and ballots show here.
            {!all && ' Turn on Include decided to see past results.'}
          </Empty>
        )}
        {data?.map((d, i) => (
          <DecisionCard
            key={`${d.root}/${d.meta.id}`}
            d={d}
            nav={nav}
            delay={Math.min(i * 50, 300)}
            picked={selected === `${d.root}/${d.meta.id}`}
          />
        ))}
      </div>
    </Section>
  );
}

const STATE: Record<string, { label: string; color: string }> = {
  open: { label: 'Voting', color: '#5ce1e6' },
  ready: { label: 'Ready', color: '#3ddc97' },
  tie: { label: 'Tie', color: '#ffb547' },
  'no-quorum': { label: 'No quorum', color: '#ffb547' },
  decided: { label: 'Decided', color: '#7f8899' },
};

/** One color per option, in order, so each bar reads as its own lane. */
const LANES = ['#5ce1e6', '#b18cff', '#ff9f43', '#5aa9ff', '#ff7eb6', '#a3e635', '#ffd166'];

function DecisionCard({
  d,
  nav,
  delay,
  picked,
}: {
  d: Decision;
  nav: Nav;
  delay: number;
  picked?: boolean;
}) {
  const card = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (picked) card.current?.scrollIntoView({ block: 'center' });
  }, [picked]);
  const [reason, setReason] = useState('');
  const act = useAction();
  const t = d.tally;
  const max = Math.max(1, ...Object.values(t.counts));
  const ref = `${d.root}/${d.meta.id}`;
  const send = (action: 'vote' | 'decide', choice: string) =>
    act.run(
      () =>
        api('POST', `/api/decisions/${q(ref)}/${action}`, { as: nav.me, choice, message: reason }),
      refreshSoon,
    );
  const me = nav.me;
  const runtime = me?.split(':')[0];
  const eligible =
    !!me &&
    (!d.meta.voters ||
      d.meta.voters.some((v) => v === me || (v.endsWith(':*') && v.split(':')[0] === runtime)));
  const voted = d.ballots.some((b) => b.actor === me);
  // Voting while it is open; deciding only when the vote ended in a tie or without quorum, or to
  // record a ready result. A voter following a vote from the inbox never finalizes by accident.
  const canVote = !d.outcome && t.state === 'open' && eligible && !voted;
  const canDecide =
    !d.outcome && !!me && (t.state === 'tie' || t.state === 'no-quorum' || t.state === 'ready');
  const decideFor = (opt: string): boolean =>
    canDecide && (t.state !== 'ready' || t.leaders[0] === opt);
  const state = STATE[t.state] ?? STATE.open!;
  const quorumPct = Math.min(100, (t.votes / Math.max(1, d.meta.quorum)) * 100);
  return (
    <article
      ref={card}
      className={cx(
        'panel animate-rise relative overflow-hidden p-5',
        d.outcome && !picked && 'opacity-85',
        picked && 'ring-2 ring-signal/60',
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${state.color}, transparent)` }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-xs text-fg-4">{d.meta.id}</span>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
          style={{
            color: state.color,
            background: `color-mix(in oklab, ${state.color} 12%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${state.color} 28%, transparent)`,
          }}
        >
          <span
            className={cx('h-1.5 w-1.5 rounded-full', t.state === 'open' && 'animate-pulse-dot')}
            style={{ background: state.color, color: state.color }}
          />
          {state.label}
        </span>
        <span className="flex items-center gap-2 text-xs text-fg-3" title="Votes cast / quorum">
          <Users size={12} />
          <span className="font-mono">
            {t.votes}/{d.meta.quorum}
          </span>
          <span className="h-1 w-16 overflow-hidden rounded-full bg-ink-600">
            <span
              className="block h-full rounded-full"
              style={{ width: `${quorumPct}%`, background: state.color }}
            />
          </span>
        </span>
        {d.meta.deadline && (
          <span className="flex items-center gap-1 text-xs text-fg-3">
            <Clock size={12} /> closes {ago(d.meta.deadline)}
          </span>
        )}
        <span className="flex items-center gap-1.5 text-xs text-fg-4">
          by <Who id={d.meta.created_by} size="xs" />
        </span>
        {d.meta.task && (
          <button
            className="ml-auto rounded-md bg-signal/8 px-1.5 py-px font-mono text-[11px] text-signal ring-1 ring-signal/20 transition ring-inset hover:bg-signal/15"
            onClick={() => nav.openTask(`${d.root}/${d.meta.task}`)}
          >
            {d.meta.task}
          </button>
        )}
      </div>

      <h2 className="mt-3 font-display text-lg leading-snug font-semibold tracking-wide">
        <RefText text={d.meta.question} />
      </h2>
      {d.body && (
        <div className="mt-1 text-sm whitespace-pre-wrap text-fg-3">
          <RefText text={d.body} />
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2">
        {d.meta.options.map((opt, i) => {
          const count = t.counts[opt] ?? 0;
          const chosen = d.outcome?.choice === opt;
          const leading = !d.outcome && count > 0 && t.leaders.includes(opt);
          const lane = chosen ? '#3ddc97' : LANES[i % LANES.length]!;
          const voters = d.ballots.filter((b) => b.choice === opt);
          const pct = t.votes ? Math.round((count / t.votes) * 100) : 0;
          return (
            <div
              key={opt}
              className="relative flex items-center gap-3 overflow-hidden rounded-xl px-3 py-2.5"
              style={{
                background: 'rgb(255 255 255 / 0.02)',
                boxShadow: `inset 0 0 0 1px ${
                  chosen || leading
                    ? `color-mix(in oklab, ${lane} 45%, transparent)`
                    : 'rgb(255 255 255 / 0.06)'
                }`,
              }}
            >
              <div
                className="absolute inset-y-0 left-0 transition-all duration-500"
                style={{
                  width: `${(count / max) * 100}%`,
                  background: `linear-gradient(90deg, color-mix(in oklab, ${lane} 8%, transparent), color-mix(in oklab, ${lane} 22%, transparent))`,
                  boxShadow: count ? `inset -2px 0 0 ${lane}` : undefined,
                }}
              />
              <span
                className="relative h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: lane, boxShadow: `0 0 10px ${lane}` }}
              />
              <span className="relative min-w-0 flex-1 truncate text-sm font-medium text-fg">
                <RefText text={opt} />
              </span>
              {chosen && (
                <span className="relative inline-flex items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 text-xs font-medium text-ok">
                  <Trophy size={12} /> chosen
                </span>
              )}
              {voters.length > 0 && (
                <span className="relative flex -space-x-1.5">
                  {voters.slice(0, 6).map((b) => (
                    <span key={b.actor} className="rounded-[30%] ring-2 ring-ink-850">
                      <Avatar id={b.actor} size={20} />
                    </span>
                  ))}
                  {voters.length > 6 && (
                    <span className="flex h-5 items-center pl-2.5 text-[10px] text-fg-3">
                      +{voters.length - 6}
                    </span>
                  )}
                </span>
              )}
              <span className="relative w-14 text-right">
                <span
                  className="font-display text-lg leading-none font-semibold"
                  style={{ color: count ? lane : '#566074' }}
                >
                  {count}
                </span>
                <span className="ml-1 text-[10px] text-fg-4">{pct}%</span>
              </span>
              {canVote && (
                <span className="relative">
                  <Button
                    kind="primary"
                    size="sm"
                    icon={Vote}
                    disabled={act.busy}
                    onClick={() => send('vote', opt)}
                  >
                    Vote
                  </Button>
                </span>
              )}
              {decideFor(opt) && (
                <span className="relative">
                  <Button
                    size="sm"
                    icon={Gavel}
                    disabled={act.busy}
                    onClick={() => send('decide', opt)}
                  >
                    {t.state === 'ready' ? 'Record result' : 'Decide'}
                  </Button>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {d.ballots.length > 0 && (
        <div className="mt-4">
          <div className="label-caps mb-1.5">Ballots</div>
          <ul className="flex flex-col gap-1.5">
            {d.ballots.map((b) => {
              const idx = d.meta.options.indexOf(b.choice);
              const lane =
                d.outcome?.choice === b.choice
                  ? '#3ddc97'
                  : LANES[(idx < 0 ? 0 : idx) % LANES.length]!;
              return (
                <li key={b.actor} className="flex items-start gap-2 text-xs">
                  <Who id={b.actor} />
                  <span className="text-fg-4">voted</span>
                  <span
                    className="rounded-full px-1.5 py-px font-medium"
                    style={{
                      color: lane,
                      background: `color-mix(in oklab, ${lane} 12%, transparent)`,
                    }}
                  >
                    <RefText text={b.choice} />
                  </span>
                  {b.body && (
                    <span className="min-w-0 text-fg-3">
                      “<RefText text={b.body} />”
                    </span>
                  )}
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-4">
                    {ago(b.at)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {t.missing.length > 0 && !d.outcome && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fg-4">
          <span>Waiting for</span>
          {t.missing.map((m) => (
            <span key={m} className="opacity-75">
              <Who id={m} size="xs" />
            </span>
          ))}
        </div>
      )}
      {d.outcome ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-ok/8 px-3 py-2.5 text-sm text-fg-2 ring-1 ring-ok/25 ring-inset">
          <Trophy size={16} className="mt-0.5 shrink-0 text-ok" />
          <div className="min-w-0">
            Decided{' '}
            <b className="text-ok">
              <RefText text={d.outcome.choice} />
            </b>{' '}
            by <Who id={d.outcome.decided_by} /> {ago(d.outcome.at)}
            {d.outcome.body && (
              <span className="text-fg-3">
                : <RefText text={d.outcome.body} />
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <Input
            value={reason}
            onChange={setReason}
            placeholder={
              canVote
                ? 'Why (optional, recorded with your ballot; ballots are final)'
                : 'Why (optional, recorded with the decision)'
            }
            className="w-full"
          />
        </div>
      )}
      {act.error && (
        <div className="mt-2">
          <ErrorLine error={act.error} />
        </div>
      )}
    </article>
  );
}
