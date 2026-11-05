import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertOctagon,
  CalendarClock,
  CheckCircle2,
  Clock,
  Cpu,
  ExternalLink,
  Eye,
  GitFork,
  Inbox,
  Layers,
  Play,
  Plus,
  Radio,
  Skull,
  SquareTerminal,
  XCircle,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, refreshSoon, useData } from '../api';
import {
  Avatar,
  Button,
  Empty,
  ErrorLine,
  Field,
  Input,
  Modal,
  Section,
  Stat,
  useAction,
  Who,
  cx,
} from '../components';
import { ago, minutes, readableLog, tokens } from '../lib/format';
import { identity } from '../lib/identity';
import type { ProcView, RunRecord } from '../types';
import { AgentPicker } from '../ui/pickers';

type Filter = 'all' | 'live' | 'ended' | 'errors';

/** Re-renders every `ms` so elapsed times on live runs keep moving. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** `42s` under a minute, then `12m`, `1h5m`. */
function duration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  return minutes(Math.floor(ms / 60_000));
}

function elapsed(run: RunRecord, now: number): number {
  const end = run.ended_at ? Date.parse(run.ended_at) : now;
  return end - Date.parse(run.started_at);
}

/** A run that ended on its own with a non-zero exit, hit a budget, or was lost; a kill is not one. */
function failed(run: RunRecord): boolean {
  if (run.status === 'running') return false;
  if (run.reason === 'killed') return false;
  return run.reason !== 'exit' || run.exit !== 0;
}

function isToday(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString();
}

interface Look {
  label: string;
  color: string;
  icon: LucideIcon;
}

function look(run: RunRecord): Look {
  if (run.status === 'running') return { label: 'Live', color: '#3ddc97', icon: Radio };
  if (run.reason === 'killed') return { label: 'Killed', color: '#ffb547', icon: Skull };
  if (run.reason === 'budget') return { label: 'Over budget', color: '#ffb547', icon: Clock };
  if (run.reason === 'tokens') return { label: 'Token limit', color: '#ffb547', icon: Zap };
  if (run.reason === 'lost') return { label: 'Lost', color: '#ff5d6c', icon: AlertOctagon };
  if (run.exit === 0) return { label: 'Done', color: '#7f8899', icon: CheckCircle2 };
  return { label: `Exit ${run.exit ?? '-'}`, color: '#ff5d6c', icon: XCircle };
}

function StatusPill({ run }: { run: RunRecord }) {
  const l = look(run);
  const Icon = l.icon;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium"
      style={{
        color: l.color,
        background: `color-mix(in oklab, ${l.color} 12%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${l.color} 28%, transparent)`,
      }}
    >
      <Icon size={11} strokeWidth={2.4} />
      {l.label}
    </span>
  );
}

function Badge({
  children,
  color,
  icon: Icon,
}: {
  children: ReactNode;
  color: string;
  icon?: LucideIcon;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px text-[10px] font-semibold tracking-wider uppercase"
      style={{ color, background: `color-mix(in oklab, ${color} 13%, transparent)` }}
    >
      {Icon && <Icon size={10} strokeWidth={2.6} />}
      {children}
    </span>
  );
}

/** Time used against the budget: the provider's color while live, amber near the end, red past it. */
function BudgetBar({ run, now, thick }: { run: RunRecord; now: number; thick?: boolean }) {
  const used = elapsed(run, now) / 60_000;
  const share = run.budget_minutes > 0 ? used / run.budget_minutes : 0;
  const color =
    share > 1
      ? '#ff5d6c'
      : share >= 0.9
        ? '#ffb547'
        : run.status === 'running'
          ? identity(run.agent).provider.color
          : '#3a4558';
  return (
    <div
      className={cx('w-full overflow-hidden rounded-full bg-white/6', thick ? 'h-1.5' : 'h-[3px]')}
    >
      <div
        className="h-full rounded-full transition-[width] duration-700"
        style={{
          width: `${Math.min(100, Math.max(2, share * 100))}%`,
          background: color,
          boxShadow: run.status === 'running' ? `0 0 8px ${color}` : undefined,
        }}
      />
    </div>
  );
}

/** What the run works on: a task, a schedule, or the agent's inbox. */
function Target({ run, nav }: { run: RunRecord; nav?: Nav }) {
  if (run.task) {
    // Without `nav` the target sits inside a row button, so it stays plain text.
    return nav ? (
      <button
        className="font-mono text-signal hover:underline"
        onClick={() => nav.openTask(`${run.root}/${run.task}`)}
      >
        {run.task}
      </button>
    ) : (
      <span className="font-mono text-signal">{run.task}</span>
    );
  }
  if (run.schedule) {
    return (
      <span className="inline-flex items-center gap-1 text-review">
        <CalendarClock size={12} />
        {run.schedule}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-info">
      <Inbox size={12} />
      inbox
    </span>
  );
}

export function Runs({ nav, selected }: { nav: Nav; selected?: string }) {
  const { data, error, reload } = useData<RunRecord[]>('/api/runs');
  const [pick, setPick] = useState<string | undefined>(selected);
  const [filter, setFilter] = useState<Filter>('all');
  const [starting, setStarting] = useState(false);
  // The run just started may not be in the list until the next fetch.
  const [fresh, setFresh] = useState<RunRecord | null>(null);
  const now = useNow(5000);
  useEffect(() => {
    setPick(selected);
  }, [selected]);

  const all = data ?? [];
  const today = all.filter((r) => isToday(r.started_at));
  const counts: Record<Filter, number> = {
    all: all.length,
    live: all.filter((r) => r.status === 'running').length,
    ended: all.filter((r) => r.status === 'ended').length,
    errors: all.filter(failed).length,
  };
  const shown = all
    .filter((r) =>
      filter === 'live'
        ? r.status === 'running'
        : filter === 'ended'
          ? r.status === 'ended'
          : filter === 'errors'
            ? failed(r)
            : true,
    )
    .slice(0, 50);
  const current =
    all.find((r) => r.id === pick) ??
    all.find((r) => pick && r.id.endsWith(pick)) ??
    (fresh && fresh.id === pick ? fresh : undefined);

  const started = (run: RunRecord): void => {
    setFresh(run);
    setPick(run.id);
    setStarting(false);
    setFilter('all');
    reload();
  };

  const empty = data !== undefined && all.length === 0 && !fresh;

  return (
    <Section
      title="Runs"
      icon={Activity}
      subtitle="Agent processes opsd started: what is live now and what ran recently"
      actions={
        !empty && (
          <Button kind="primary" icon={Play} onClick={() => setStarting(true)}>
            Start a run
          </Button>
        )
      }
    >
      {starting && (
        <Modal title="Start a run" icon={Play} onClose={() => setStarting(false)} width={520}>
          <StartRun onStarted={started} />
        </Modal>
      )}
      {empty ? (
        <div className="p-6">
          <ErrorLine error={error} />
          <Empty icon={Activity} title="No runs yet">
            A run is one agent process, Claude Code or Codex, that opsd starts to work a task, read
            an inbox, or follow a schedule. opsd starts runs by itself when an agent with{' '}
            <code className="font-mono text-fg-2">wake: true</code> has work, or when a schedule
            fires. You can also start one by hand.
          </Empty>
          <div className="panel animate-rise mx-auto max-w-lg p-5">
            <div className="mb-3 flex items-center gap-2">
              <Play size={15} className="text-signal" />
              <span className="font-display font-semibold tracking-wide">Start a run</span>
            </div>
            <StartRun onStarted={started} />
          </div>
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col gap-4 p-5">
          <ErrorLine error={error} />
          <div className="flex flex-wrap gap-3">
            <Stat
              label="Live now"
              value={
                <span className="inline-flex items-center gap-2">
                  {counts.live}
                  {counts.live > 0 && (
                    <span className="animate-pulse-dot h-2 w-2 rounded-full bg-ok text-ok" />
                  )}
                </span>
              }
              tone={counts.live > 0 ? '#3ddc97' : undefined}
            />
            <Stat label="Runs today" value={today.length} />
            <Stat
              label="Tokens today"
              value={tokens(today.reduce((n, r) => n + r.tokens, 0))}
              tone="#5ce1e6"
            />
            <Stat
              label="Errors today"
              value={today.filter(failed).length}
              tone={today.some(failed) ? '#ff5d6c' : undefined}
              hint="Runs that ended on a non-zero exit, a budget, or a lost process. Kills do not count."
            />
          </div>
          <div className="flex min-h-0 flex-1 gap-4">
            <div className="panel flex w-[400px] shrink-0 flex-col overflow-hidden">
              <div className="flex gap-1 border-b border-white/6 p-2">
                {(
                  [
                    ['all', 'All'],
                    ['live', 'Live'],
                    ['ended', 'Ended'],
                    ['errors', 'Errors'],
                  ] as Array<[Filter, string]>
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    className={cx(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition',
                      filter === key
                        ? 'bg-white/8 text-fg ring-1 ring-white/10'
                        : 'text-fg-3 hover:bg-white/4 hover:text-fg-2',
                    )}
                  >
                    {label}
                    <span
                      className={cx(
                        'font-mono text-[10px]',
                        key === 'errors' && counts.errors > 0
                          ? 'text-bad'
                          : key === 'live' && counts.live > 0
                            ? 'text-ok'
                            : 'text-fg-4',
                      )}
                    >
                      {counts[key]}
                    </span>
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-1.5">
                {data && shown.length === 0 && (
                  <div className="px-4 py-10 text-center text-sm text-fg-4">
                    No {filter === 'errors' ? 'runs with errors' : `${filter} runs`}.
                  </div>
                )}
                {shown.map((r) => (
                  <RunRow
                    key={r.id}
                    run={r}
                    now={now}
                    active={current?.id === r.id}
                    onPick={() => setPick(r.id)}
                  />
                ))}
              </div>
            </div>
            <div className="panel min-w-0 flex-1 overflow-hidden">
              {current ? (
                <RunLog run={current} nav={nav} />
              ) : (
                <Empty icon={SquareTerminal} title="Pick a run">
                  Its log shows here: what the agent said, the commands it ran, and how it ended.
                </Empty>
              )}
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

function RunRow(props: { run: RunRecord; now: number; active: boolean; onPick: () => void }) {
  const { run, now, active } = props;
  const live = run.status === 'running';
  const c = identity(run.agent).provider.color;
  return (
    <button
      onClick={props.onPick}
      className={cx(
        'group relative mb-0.5 block w-full rounded-lg px-3 py-2.5 text-left transition',
        active ? 'bg-white/7 ring-1 ring-white/10' : 'hover:bg-white/4',
      )}
    >
      {active && (
        <span
          className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full"
          style={{ background: c, boxShadow: `0 0 10px ${c}` }}
        />
      )}
      <div className="flex items-start gap-3">
        <Avatar id={run.agent} size={30} live={live} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Who id={run.agent} plain />
            <StatusPill run={run} />
            <span className="ml-auto shrink-0 text-[11px] text-fg-4">{ago(run.started_at)}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <Target run={run} />
            {run.review && (
              <Badge color="#b18cff" icon={Eye}>
                review
              </Badge>
            )}
            {run.parent && (
              <Badge color="#5aa9ff" icon={GitFork}>
                helper
              </Badge>
            )}
            {run.procs_left ? (
              <Badge color="#ff5d6c" icon={Layers}>
                {run.procs_left} left
              </Badge>
            ) : null}
            <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-3">
              {tokens(run.tokens)} tok
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <BudgetBar run={run} now={now} />
            <span className="shrink-0 font-mono text-[10px] text-fg-4">
              {duration(elapsed(run, now))}/{minutes(run.budget_minutes)}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

function Metric({
  icon: Icon,
  children,
  title,
}: {
  icon: LucideIcon;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-fg-2" title={title}>
      <Icon size={13} className="text-fg-4" />
      {children}
    </span>
  );
}

function RunLog({ run, nav }: { run: RunRecord; nav: Nav }) {
  const [log, setLog] = useState('');
  const [raw, setRaw] = useState(false);
  const [showProcs, setShowProcs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kill = useAction();
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const now = useNow(run.status === 'running' ? 1000 : 60_000);
  useEffect(() => {
    let stop = false;
    setLog('');
    follow.current = true;
    const load = (): void => {
      api<string>('GET', `/api/runs/${run.id}/log?tail=262144`).then(
        (text) => {
          if (stop) return;
          setLog(text);
          setError(null);
        },
        (e: Error) => !stop && setError(e.message),
      );
    };
    load();
    // A live run's log grows; follow it every 2 s.
    const timer = run.status === 'running' ? setInterval(load, 2000) : undefined;
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [run.id, run.status]);
  useEffect(() => {
    // Stay at the bottom unless the reader scrolled up to read.
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [log, raw]);
  const lines = readableLog(log);
  const live = run.status === 'running';
  const who = identity(run.agent);
  return (
    <div className="flex h-full flex-col">
      <div className="relative border-b border-white/6 px-5 pt-4 pb-3">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background: `radial-gradient(420px 120px at 0% 0%, color-mix(in oklab, ${who.provider.color} 14%, transparent), transparent 70%)`,
          }}
        />
        <div className="relative flex items-start gap-3">
          <Avatar id={run.agent} size={40} live={live} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Who id={run.agent} plain size="md" label />
              <StatusPill run={run} />
              {run.review && (
                <Badge color="#b18cff" icon={Eye}>
                  review
                </Badge>
              )}
              {run.parent && (
                <Badge color="#5aa9ff" icon={GitFork}>
                  helper of {run.parent}
                </Badge>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Target run={run} nav={nav} />
              {run.project && <span className="text-xs text-fg-3">{run.project}</span>}
              <span className="text-xs text-fg-4">started {ago(run.started_at)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {run.task && (
              <Button
                size="sm"
                icon={ExternalLink}
                onClick={() => nav.openTask(`${run.root}/${run.task}`)}
              >
                Open task
              </Button>
            )}
            {live && (
              <Button
                size="sm"
                kind="danger"
                icon={Skull}
                disabled={kill.busy}
                onClick={() =>
                  kill.run(() => api('POST', `/api/runs/${run.id}/kill`, {}), refreshSoon)
                }
              >
                Kill
              </Button>
            )}
          </div>
        </div>
        <div className="relative mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <Metric icon={Clock} title="Time used of the time budget">
            {duration(elapsed(run, now))}
            <span className="text-fg-4"> / {minutes(run.budget_minutes)}</span>
          </Metric>
          <Metric icon={Zap} title="Tokens used">
            {tokens(run.tokens)}
            {run.token_budget ? (
              <span className="text-fg-4"> / {tokens(run.token_budget)}</span>
            ) : null}
          </Metric>
          <Metric icon={Cpu} title="Process id">
            pid {run.pid}
          </Metric>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-lg bg-white/5 p-0.5 ring-1 ring-white/8">
              {(['readable', 'raw'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setRaw(m === 'raw')}
                  className={cx(
                    'rounded-md px-2 py-0.5 text-xs capitalize transition',
                    (m === 'raw') === raw ? 'bg-white/10 text-fg' : 'text-fg-3 hover:text-fg-2',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              kind={showProcs ? 'plain' : 'ghost'}
              icon={Layers}
              onClick={() => setShowProcs((v) => !v)}
            >
              Processes
              {run.procs_left ? <span className="text-bad">{run.procs_left} left</span> : null}
            </Button>
          </div>
        </div>
        <div className="relative mt-3">
          <BudgetBar run={run} now={now} thick />
        </div>
      </div>
      {showProcs && <Procs run={run} />}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-auto bg-ink-950/50 px-5 py-4 font-mono text-xs leading-relaxed"
      >
        <ErrorLine error={error ?? kill.error} />
        {!log && !error && (
          <div className="py-10 text-center font-sans text-sm text-fg-4">
            {live ? 'Waiting for the first output…' : 'This run wrote no output.'}
          </div>
        )}
        {raw ? (
          <pre className="whitespace-pre-wrap text-fg-2">{log}</pre>
        ) : (
          lines.map((l, i) => (
            <LogLineView key={i} kind={l.kind} text={l.text} color={who.provider.color} />
          ))
        )}
        {live && log && (
          <div className="mt-2 flex items-center gap-2 text-fg-4">
            <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-ok text-ok" />
            following
          </div>
        )}
      </div>
    </div>
  );
}

function LogLineView({ kind, text, color }: { kind: string; text: string; color: string }) {
  if (kind === 'tool') {
    return (
      <div className="my-1 flex items-start gap-2 rounded-md bg-info/6 px-2 py-1 text-[#9fcaff]">
        <SquareTerminal size={13} className="mt-0.5 shrink-0 text-info" />
        <span className="min-w-0 break-all whitespace-pre-wrap">{text}</span>
      </div>
    );
  }
  if (kind === 'result') {
    return (
      <div className="my-2 flex items-start gap-2 rounded-md bg-ok/8 px-2 py-1.5 text-ok ring-1 ring-ok/20">
        <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
        <span className="min-w-0 whitespace-pre-wrap">{text}</span>
      </div>
    );
  }
  if (kind === 'error') {
    return (
      <div className="my-2 flex items-start gap-2 rounded-md bg-bad/8 px-2 py-1.5 text-[#ffb3ba] ring-1 ring-bad/25">
        <XCircle size={13} className="mt-0.5 shrink-0 text-bad" />
        <span className="min-w-0 break-all whitespace-pre-wrap">{text}</span>
      </div>
    );
  }
  if (kind === 'text') {
    return (
      <div
        className="my-1.5 border-l-2 py-0.5 pl-3 font-sans text-[13px] whitespace-pre-wrap text-fg"
        style={{ borderColor: `color-mix(in oklab, ${color} 55%, transparent)` }}
      >
        {text}
      </div>
    );
  }
  return <div className="py-px break-all whitespace-pre-wrap text-fg-4">{text}</div>;
}

/** Every process the run started, from opsd's ledger, with a kill for what an ended run left. */
function Procs({ run }: { run: RunRecord }) {
  const { data, error, reload } = useData<ProcView[]>(`/api/runs/${run.id}/procs`);
  const reap = useAction();
  useEffect(() => {
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);
  const alive = (data ?? []).filter((p) => p.alive && !p.unsure);
  const anyUnsure = (data ?? []).some((p) => p.unsure && p.alive);
  const killOne = (pid: number): void =>
    reap.run(() => api('POST', `/api/runs/${run.id}/procs`, { pid }), reload);
  return (
    <div className="animate-fade max-h-72 overflow-auto border-b border-white/6 bg-ink-900/60 px-5 py-3 text-xs">
      <div className="mb-2 flex items-center gap-3">
        <span className="label-caps">Processes</span>
        <span className="text-fg-3">
          {data ? `${data.length} recorded, ${alive.length} alive` : 'Loading processes'}
        </span>
        {run.status === 'ended' && alive.length > 0 && (
          <span className="ml-auto">
            <Button
              size="sm"
              kind="danger"
              icon={Skull}
              disabled={reap.busy}
              onClick={() =>
                reap.run(
                  () => api('POST', `/api/runs/${run.id}/procs`, {}),
                  () => {
                    reload();
                    refreshSoon();
                  },
                )
              }
            >
              Kill leftovers
            </Button>
          </span>
        )}
      </div>
      <ErrorLine error={error ?? reap.error} />
      {anyUnsure && (
        <div className="mb-2 rounded-md bg-warn/8 px-2 py-1 text-warn">
          Unsure: the parent had exited, and its PID may have gone to another process. Check an
          unsure process before you kill it; Kill leftovers skips them.
        </div>
      )}
      <div className="font-mono">
        {(data ?? []).map((p) => (
          <div
            key={`${p.pid}-${p.first_seen}`}
            className="flex items-center gap-3 rounded px-1 py-1 hover:bg-white/3"
          >
            <span className="w-14 shrink-0 text-fg-3">{p.pid}</span>
            <span className="inline-flex w-16 shrink-0 items-center gap-1.5">
              <span
                className={cx(
                  'h-1.5 w-1.5 rounded-full',
                  p.alive ? 'bg-ok' : p.killed_at ? 'bg-bad' : 'bg-fg-4',
                )}
              />
              <span className={p.alive ? 'text-ok' : p.killed_at ? 'text-bad' : 'text-fg-4'}>
                {p.alive ? 'alive' : p.killed_at ? 'killed' : 'gone'}
              </span>
            </span>
            <span className="w-32 shrink-0 truncate text-fg-2">{p.name}</span>
            <span className="min-w-0 flex-1 truncate text-fg-4" title={p.cmd}>
              {p.unsure && (
                <span
                  className="mr-1.5 rounded bg-warn/12 px-1 text-warn"
                  title="Its parent had exited, and the parent's PID may have gone to another process. Check it before you kill it."
                >
                  unsure
                </span>
              )}
              {p.cmd}
            </span>
            {run.status === 'ended' && p.alive && (
              <button
                className="shrink-0 rounded px-1.5 text-bad hover:bg-bad/12 disabled:opacity-50"
                disabled={reap.busy}
                onClick={() => killOne(p.pid)}
              >
                kill
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Starts a run by hand: an agent, and optionally a task and a time budget. */
function StartRun({ onStarted }: { onStarted: (run: RunRecord) => void }) {
  const [agent, setAgent] = useState<string[]>([]);
  const [task, setTask] = useState('');
  const [budget, setBudget] = useState('');
  const act = useAction();
  const submit = (): void => {
    const id = agent[0];
    if (!id) return;
    act.run(async () => {
      const run = await api<RunRecord>('POST', '/api/runs', {
        agent: id,
        task: task.trim() || undefined,
        budget: budget.trim() || undefined,
      });
      onStarted(run);
    }, refreshSoon);
  };
  return (
    <div className="flex flex-col gap-4">
      {/* Runs are for agents, so the picker leaves you out. */}
      <Field label="Agent">
        <AgentPicker
          value={agent}
          onChange={setAgent}
          me={null}
          noGroups
          runnable
          placeholder="Pick an agent, such as claude:engineer"
        />
      </Field>
      <div className="flex gap-3">
        <Field
          label="Task"
          className="flex-1"
          hint={
            task.trim() ? 'Works that task.' : 'Empty: reads its inbox, then takes its next task.'
          }
        >
          <Input value={task} onChange={setTask} placeholder="T-0012 (optional)" onEnter={submit} />
        </Field>
        <Field label="Budget" className="w-32" hint="Such as 45m or 2h.">
          <Input value={budget} onChange={setBudget} placeholder="optional" onEnter={submit} />
        </Field>
      </div>
      <ErrorLine error={act.error} />
      <div className="flex justify-end">
        <Button kind="primary" icon={Plus} disabled={!agent[0] || act.busy} onClick={submit}>
          {act.busy ? 'Starting…' : 'Start run'}
        </Button>
      </div>
    </div>
  );
}
