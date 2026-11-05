import { BarChart3, Vote } from 'lucide-react';
import { useState } from 'react';
import type { Nav } from '../App';
import { q, useData } from '../api';
import { Empty, ErrorLine, Section, Stat, Who, cx } from '../components';
import { minutes, tokens } from '../lib/format';
import { identity } from '../lib/identity';
import type { Report } from '../types';
import { ProviderMark } from '../ui/identity';
import { RefText } from '../ui/refs';

const RANGES: Array<[number, string]> = [
  [1, 'Day'],
  [7, 'Week'],
  [30, '30 days'],
  [90, '90 days'],
];

/** Progress per project and usage per provider and agent over a window. */
export function Reports({ nav }: { nav: Nav }) {
  const [days, setDays] = useState(7);
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const path = custom
    ? from
      ? `/api/report?from=${q(from)}${to ? `&to=${q(to)}` : ''}`
      : null
    : `/api/report?days=${days}`;
  const { data, error } = useData<Report>(path);
  const r = data;
  const maxMin = Math.max(1, ...(r?.providers ?? []).map((p) => p.minutes));
  return (
    <Section
      title="Reports"
      icon={BarChart3}
      subtitle="Tasks per project, runs and tokens per provider and agent, decisions taken"
      actions={
        <div className="flex rounded-lg bg-white/5 p-0.5">
          {RANGES.map(([d, label]) => (
            <button
              key={d}
              type="button"
              onClick={() => {
                setDays(d);
                setCustom(false);
              }}
              className={cx(
                'rounded-md px-2.5 py-1 text-xs transition',
                !custom && days === d ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCustom(true)}
            className={cx(
              'rounded-md px-2.5 py-1 text-xs transition',
              custom ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
            )}
          >
            Custom
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-5 p-6">
        {custom && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-fg-3">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-[34px] rounded-lg border border-white/10 bg-ink-950/60 px-2 text-fg"
            />
            <span className="text-fg-3">to</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-[34px] rounded-lg border border-white/10 bg-ink-950/60 px-2 text-fg"
            />
            <span className="text-xs text-fg-4">Leave the end empty for now.</span>
          </div>
        )}
        <ErrorLine error={error} />
        {r && (
          <div className="flex flex-wrap gap-3">
            <Stat label="Closed" value={r.totals.closed} tone="#3ddc97" />
            <Stat label="Opened" value={r.totals.opened} tone="#5aa9ff" />
            <Stat label="Runs" value={r.totals.runs} hint={minutes(r.totals.minutes)} />
            <Stat label="Tokens" value={tokens(r.totals.tokens)} />
            <Stat label="Decisions" value={r.decisions.length} tone="#b18cff" />
          </div>
        )}
        {r && r.projects.length === 0 && r.totals.runs === 0 && (
          <Empty icon={BarChart3} title="Nothing in this window">
            Reports fill in as tasks open and close and agents run.
          </Empty>
        )}
        {r && r.projects.length > 0 && (
          <div className="panel overflow-hidden">
            <div className="label-caps border-b border-white/6 px-4 py-2.5">Projects</div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-fg-4">
                <tr>
                  <th className="px-4 py-2 font-normal">Project</th>
                  <th className="px-2 py-2 text-right font-normal">Closed</th>
                  <th className="px-2 py-2 text-right font-normal">Opened</th>
                  <th className="px-2 py-2 text-right font-normal">Parked</th>
                  <th className="px-2 py-2 text-right font-normal">Open</th>
                  <th className="px-4 py-2 text-right font-normal">Blocked</th>
                </tr>
              </thead>
              <tbody>
                {r.projects.map((p) => (
                  <tr key={p.project} className="border-t border-white/5">
                    <td className="px-4 py-2 font-mono text-xs">{p.project}</td>
                    <td className="px-2 py-2 text-right text-ok">{p.closed}</td>
                    <td className="px-2 py-2 text-right">{p.opened}</td>
                    <td className="px-2 py-2 text-right text-fg-3">{p.parked}</td>
                    <td className="px-2 py-2 text-right">{p.open}</td>
                    <td
                      className={cx(
                        'px-4 py-2 text-right',
                        p.blocked > 0 ? 'text-warn' : 'text-fg-4',
                      )}
                    >
                      {p.blocked}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r && r.providers.length > 0 && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="panel p-4">
              <div className="label-caps mb-3">Providers</div>
              {r.providers.map((p) => {
                const color = identity(`${p.key}:x`).provider.color;
                return (
                  <div key={p.key} className="mb-3">
                    <div className="flex items-center gap-2 text-sm">
                      <ProviderMark runtime={p.key} size={14} />
                      <span style={{ color }}>{identity(`${p.key}:x`).provider.label}</span>
                      <span className="ml-auto text-xs text-fg-3">
                        {p.runs} runs · {minutes(p.minutes)} · {tokens(p.tokens)} tokens
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 rounded-full bg-white/6">
                      <div
                        className="h-1.5 rounded-full"
                        style={{ width: `${(p.minutes / maxMin) * 100}%`, background: color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="panel p-4">
              <div className="label-caps mb-3">Agents</div>
              {r.agents.map((a) => (
                <div key={a.key} className="flex items-center gap-2 py-1 text-sm">
                  <Who id={a.key} label size="xs" />
                  <span className="ml-auto text-xs text-fg-3">
                    {a.runs} runs · {minutes(a.minutes)} · {tokens(a.tokens)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {r && r.decisions.length > 0 && (
          <div className="panel p-4">
            <div className="label-caps mb-2">Decided</div>
            {r.decisions.map((d) => (
              <div
                key={d.id}
                className="row-link flex w-full items-center gap-2 py-1 text-left text-sm hover:text-signal"
              >
                <Vote size={14} className="text-review" />
                <button
                  type="button"
                  onClick={() => nav.go('decisions')}
                  aria-label={`Open decisions: ${d.id}, ${d.question}`}
                  className="row-open cursor-pointer font-mono text-xs text-fg-4"
                >
                  {d.id}
                </button>
                <span className="min-w-0 flex-1 truncate">
                  <RefText text={d.question} />
                </span>
                <span className="text-xs text-ok">
                  <RefText text={d.choice} />
                </span>
              </div>
            ))}
          </div>
        )}
        {r && r.channels.length > 0 && (
          <div className="text-xs text-fg-3">
            Channel posts: {r.channels.map((c) => `#${c.channel} ${c.posts}`).join(' · ')}
          </div>
        )}
      </div>
    </Section>
  );
}
