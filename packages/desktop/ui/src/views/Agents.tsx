import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  CalendarClock,
  CircleDot,
  Eye,
  FilePlus2,
  GitFork,
  Hourglass,
  Inbox,
  Info,
  PauseCircle,
  Play,
  Plus,
  ScrollText,
  Skull,
  Trash2,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { Nav } from '../App';
import { api, refreshSoon, useData } from '../api';
import { backlogOf } from '../lib/filters';
import {
  Avatar,
  Button,
  Empty,
  ErrorLine,
  Input,
  Modal,
  Section,
  toast,
  Toggle,
  useAction,
  Who,
  cx,
} from '../components';
import { ago, minutes, tokens } from '../lib/format';
import { identity } from '../lib/identity';
import type {
  Agent,
  DirectoryItem,
  Machine,
  ProviderUsage,
  RunRecord,
  Settings,
  Task,
  WaitItem,
} from '../types';
import { ProviderMark, ROLE_ICONS } from '../ui/identity';
import { Markdown } from '../ui/markdown';
import { RefText } from '../ui/refs';
import { RoleEditor } from '../ui/roles';

// Known providers first, in this order; humans last; anything else alphabetically between.
const PROVIDER_ORDER = ['claude', 'codex', 'gemini', 'grok', 'cursor'];

function providerRank(rt: string): number {
  if (rt === 'human') return 1000;
  const i = PROVIDER_ORDER.indexOf(rt);
  return i === -1 ? 100 : i;
}

function byProvider(a: string, b: string): number {
  return providerRank(a) - providerRank(b) || a.localeCompare(b);
}

/** Re-renders every `ms` so elapsed times on live runs keep moving. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function Caps({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <span className="label-caps">{children}</span>
      <span className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
      {right}
    </div>
  );
}

function Chip({
  children,
  color,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  color: string;
  icon?: LucideIcon;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 26%, transparent)`,
      }}
    >
      {Icon && <Icon size={11} strokeWidth={2.4} />}
      {children}
    </span>
  );
}

export function Agents({ nav }: { nav: Nav }) {
  const agents = useData<Agent[]>('/api/agents');
  const runs = useData<RunRecord[]>('/api/runs?live');
  const tasks = useData<Task[]>('/api/tasks');
  const machines = useData<Machine[]>('/api/machines');
  const waits = useData<{ providers: Record<string, ProviderUsage>; waits: WaitItem[] }>(
    '/api/waits',
  );
  const dir = useData<DirectoryItem[]>('/api/directory');
  const settings = useData<Settings>('/api/settings');
  const [editing, setEditing] = useState<{ id?: string; runtime?: string; role?: string } | null>(
    null,
  );
  const wakeAct = useAction();
  /** Changes an agent's opsd settings; `null` removes a key, and wake off removes `wake`. */
  const setAgent = (id: string, patch: AgentPatch): void =>
    wakeAct.run(
      () => api('POST', '/api/settings', { patch: { opsd: { agents: { [id]: patch } } } }),
      () => {
        settings.reload();
        agents.reload();
        refreshSoon();
      },
    );
  const setWake = (id: string, wake: boolean): void => setAgent(id, { wake });
  /** Takes an agent out of the opsd config; its role file, if any, stays. */
  const removeAgent = (id: string): void =>
    wakeAct.run(
      () => api('POST', '/api/settings', { patch: { opsd: { agents: { [id]: null } } } }),
      () => {
        settings.reload();
        agents.reload();
        dir.reload();
        refreshSoon();
      },
    );
  const [adding, setAdding] = useState(false);
  const agentCfg = settings.data?.opsd.agents ?? {};
  const runtimes = settings.data?.opsd.runtimes ?? {};
  const now = useNow(10_000);
  const live = runs.data ?? [];
  // Agents with a live run but no role file still show up.
  const ids = [
    ...new Set([...(agents.data ?? []).map((a) => a.id), ...live.map((r) => r.agent)]),
  ].sort();
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const rt = identity(id).runtime;
    groups.set(rt, [...(groups.get(rt) ?? []), id]);
  }
  const wakes = (agents.data ?? []).filter((a) => a.wake).length;
  // Runtimes with a usual role and no role file or config entry: they run all the same.
  const runnable = (dir.data ?? []).filter((d) => d.source === 'runtime' && !ids.includes(d.id));
  return (
    <Section
      title="Agents"
      icon={Bot}
      subtitle={
        agents.data
          ? `${ids.length} agents · ${live.length} live runs · ${wakes} wake on their own`
          : 'Who works here, what runs now, and what waits'
      }
    >
      <div className="flex flex-col gap-8 p-6">
        <ErrorLine error={agents.error ?? runs.error ?? wakeAct.error} />

        <HowAgentsStart
          connected={!agents.error}
          wakes={wakes}
          maxRuns={settings.data?.opsd.max_runs}
          halted={settings.data?.opsd.paused === true}
          paused={Object.entries(settings.data?.opsd.runtimes ?? {})
            .filter(([, r]) => r.paused)
            .map(([n]) => n)}
          onCreate={() => setEditing({})}
        />

        {settings.data &&
          (adding ? (
            <AddAgent
              providers={Object.keys(runtimes)}
              taken={ids}
              busy={wakeAct.busy}
              onAdd={(id, patch) => {
                setAgent(id, patch);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <div>
              <Button icon={Plus} onClick={() => setAdding(true)}>
                Add agent
              </Button>
            </div>
          ))}

        <section>
          <Caps>Providers</Caps>
          {waits.error ? (
            <WaitsUnavailable error={waits.error} />
          ) : waits.data ? (
            <Providers
              providers={waits.data.providers}
              agents={[...ids, ...runnable.map((d) => d.id)]}
            />
          ) : (
            <div className="text-sm text-fg-4">Reading usage…</div>
          )}
        </section>

        {(machines.data ?? []).length > 0 && (
          <section>
            <Caps>Machines</Caps>
            <div className="flex flex-wrap gap-3">
              {machines.data!.map((m) => (
                <div key={m.machine} className="panel flex min-w-56 items-center gap-3 px-4 py-3">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      background: m.alive ? '#3ddc97' : '#7f8899',
                      boxShadow: m.alive ? '0 0 10px rgba(61,220,151,0.7)' : undefined,
                    }}
                  />
                  <div className="min-w-0">
                    <div className="font-mono text-sm text-fg">{m.machine}</div>
                    <div className="text-xs text-fg-4">
                      {m.alive ? 'alive' : 'not seen'} · {ago(m.last_seen)} · {m.live_runs} live
                      {m.agents && m.agents.length > 0 ? ` · ${m.agents.join(', ')}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {waits.data && (
          <section>
            <Caps
              right={
                waits.data.waits.length > 0 && (
                  <span className="font-mono text-xs text-warn">{waits.data.waits.length}</span>
                )
              }
            >
              Waiting
            </Caps>
            <Waiting waits={waits.data.waits} nav={nav} />
          </section>
        )}

        <Runnable
          items={runnable}
          wake={Object.fromEntries(Object.entries(agentCfg).map(([id, a]) => [id, a.wake]))}
          busy={wakeAct.busy}
          onWake={setWake}
          onCreate={(id) => {
            const [runtime, role] = id.split(':');
            setEditing({ runtime, role });
          }}
        />

        <section>
          {agents.data && ids.length === 0 && runnable.length === 0 && (
            <Empty icon={Bot} title="No agents yet">
              opsd reports no runtimes. Add a provider in Settings, or create a role.
            </Empty>
          )}
          <div className="flex flex-col gap-8">
            {[...groups.keys()].sort(byProvider).map((rt) => {
              const members = groups.get(rt)!;
              const p = identity(`${rt}:x`).provider;
              const liveHere = live.filter((r) => identity(r.agent).runtime === rt).length;
              return (
                <div key={rt}>
                  <div className="mb-3 flex items-center gap-2.5">
                    <ProviderMark runtime={rt} size={18} />
                    <span
                      className="font-display text-base font-semibold tracking-wide"
                      style={{ color: p.color }}
                    >
                      {p.label}
                    </span>
                    <span className="text-xs text-fg-4">
                      {members.length} {members.length === 1 ? 'agent' : 'agents'}
                    </span>
                    {liveHere > 0 && (
                      <span className="inline-flex items-center gap-1.5 text-xs text-ok">
                        <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-ok text-ok" />
                        {liveHere} live
                      </span>
                    )}
                    <span
                      className="h-px flex-1"
                      style={{
                        background: `linear-gradient(90deg, color-mix(in oklab, ${p.color} 35%, transparent), transparent)`,
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-3">
                    {members.map((id) => (
                      <AgentCard
                        key={id}
                        agent={agents.data?.find((a) => a.id === id)}
                        id={id}
                        runs={live.filter((r) => r.agent === id)}
                        backlog={backlogOf(id, tasks.data ?? [])}
                        nav={nav}
                        now={now}
                        config={settings.data ? (agentCfg[id] ?? {}) : undefined}
                        defaultBudget={settings.data?.opsd.budget_minutes}
                        providerModel={runtimes[identity(id).runtime]?.model}
                        configBusy={wakeAct.busy}
                        onConfig={(patch) => setAgent(id, patch)}
                        onRemove={Object.hasOwn(agentCfg, id) ? () => removeAgent(id) : undefined}
                        onRoleFile={() => {
                          const a = agents.data?.find((x) => x.id === id);
                          if (a?.file) setEditing({ id });
                          else {
                            const [runtime, role] = id.split(':');
                            setEditing({ runtime, role });
                          }
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
      {editing && (
        <RoleEditor
          id={editing.id}
          preset={
            editing.runtime ? { runtime: editing.runtime, role: editing.role ?? '' } : undefined
          }
          me={nav.me}
          onClose={() => {
            setEditing(null);
            dir.reload();
            agents.reload();
          }}
        />
      )}
    </Section>
  );
}

/** `/api/waits` failed: most often an opsd older than this app, which has no such route. */
function WaitsUnavailable({ error }: { error: string }) {
  const old = /no route/i.test(error);
  return (
    <div className="panel flex items-start gap-3 px-4 py-3 text-sm" title={error}>
      <Info size={16} className="mt-0.5 shrink-0 text-info" />
      <div>
        <div className="text-fg-2">Usage and waits are unavailable.</div>
        <div className="mt-0.5 text-fg-3">
          {old
            ? 'opsd is older than this app; restart it to see usage and waits.'
            : `opsd did not answer for usage and waits: ${error}`}
        </div>
      </div>
    </div>
  );
}

/** Each provider's live runs and usage windows, and whether opsd pauses new runs on it. */
function Providers({
  providers,
  agents,
}: {
  providers: Record<string, ProviderUsage>;
  agents: string[];
}) {
  const names = Object.keys(providers).sort(byProvider);
  if (names.length === 0) {
    return <div className="text-sm text-fg-4">opsd reports no providers yet.</div>;
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
      {names.map((name) => {
        const p = providers[name]!;
        const c = identity(`${name}:x`).provider;
        const count = agents.filter((id) => identity(id).runtime === name).length;
        const limited = p.limited_until && p.limited_until > Date.now() ? p.limited_until : null;
        return (
          <div
            key={name}
            className={cx(
              'panel animate-rise relative overflow-hidden p-4',
              p.paused && 'ring-1 ring-warn/40',
            )}
          >
            <div
              className="absolute inset-x-0 top-0 h-[2px]"
              style={{ background: `linear-gradient(90deg, ${c.color}, transparent 80%)` }}
            />
            <div
              className="pointer-events-none absolute -top-16 -right-10 h-40 w-40 rounded-full opacity-40 blur-3xl"
              style={{ background: c.color }}
            />
            <div className="relative flex items-start gap-3">
              <span
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl"
                style={{
                  background: `color-mix(in oklab, ${c.color} 12%, #0d1117)`,
                  boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c.color} 35%, transparent)`,
                }}
              >
                <ProviderMark runtime={name} size={22} />
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className="font-display text-lg leading-tight font-semibold tracking-wide"
                  style={{ color: c.color }}
                >
                  {c.label}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
                  {p.plan && <span className="rounded bg-white/6 px-1.5 text-fg-2">{p.plan}</span>}
                  <span>
                    {count} {count === 1 ? 'agent' : 'agents'}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <div
                  className={cx(
                    'flex items-center justify-end gap-1.5 font-display text-2xl leading-none font-semibold',
                    p.live > 0 ? 'text-ok' : 'text-fg-3',
                  )}
                >
                  {p.live > 0 && (
                    <span className="animate-pulse-dot h-2 w-2 rounded-full bg-ok text-ok" />
                  )}
                  {p.live}
                </div>
                <div className="label-caps mt-1">live</div>
              </div>
            </div>
            <div className="relative mt-4 flex flex-col gap-2.5">
              {Object.keys(p.windows).length === 0 && (
                <div className="text-xs text-fg-4">No usage reading yet.</div>
              )}
              {Object.entries(p.windows).map(([w, u]) => {
                const pct = Math.round(u.utilization * 100);
                const hot = u.utilization >= 0.9;
                return (
                  <div key={w}>
                    <div className="mb-1 flex items-baseline gap-2 text-xs">
                      <span className="text-fg-2 capitalize">{w.replace(/_/g, ' ')}</span>
                      {u.resets_at > 0 && (
                        <span className="text-fg-4">
                          resets {ago(new Date(u.resets_at).toISOString())}
                        </span>
                      )}
                      <span className={cx('ml-auto font-mono', hot ? 'text-warn' : 'text-fg-2')}>
                        {pct}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/6">
                      <div
                        className="h-full rounded-full transition-[width] duration-700"
                        style={{
                          width: `${Math.min(100, Math.max(1, pct))}%`,
                          background: hot ? '#ffb547' : c.color,
                          boxShadow: `0 0 8px ${hot ? '#ffb547' : c.color}`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {p.paused && (
              <div className="relative mt-3 flex items-start gap-2 rounded-lg bg-warn/10 px-2.5 py-2 text-xs text-warn">
                <PauseCircle size={14} className="mt-px shrink-0" />
                <span>{p.paused}</span>
              </div>
            )}
            {!p.paused && limited && (
              <div className="relative mt-3 text-xs text-warn">
                Limited until{' '}
                {new Date(limited).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const WAIT_LOOK: Record<WaitItem['kind'], { color: string; icon: LucideIcon; label: string }> = {
  review: { color: '#b18cff', icon: Eye, label: 'review' },
  inbox: { color: '#5aa9ff', icon: Inbox, label: 'inbox' },
  task: { color: '#5ce1e6', icon: CircleDot, label: 'task' },
};

/** Work waking agents could take, and why no run has started on it. */
function Waiting({ waits, nav }: { waits: WaitItem[]; nav: Nav }) {
  if (waits.length === 0) {
    return (
      <div className="text-sm text-fg-4">
        Nothing waits. Every piece of work for waking agents has a run, or there is none.
      </div>
    );
  }
  return (
    <div className="panel divide-y divide-white/5 overflow-hidden">
      {waits.map((w) => {
        const l = WAIT_LOOK[w.kind] ?? WAIT_LOOK.task;
        const Icon = l.icon;
        return (
          <div key={`${w.kind}-${w.task ?? w.title}`} className="flex items-start gap-3 px-4 py-3">
            <span
              className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
              style={{ background: `color-mix(in oklab, ${l.color} 13%, transparent)` }}
              title={l.label}
            >
              <Icon size={14} color={l.color} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {w.task && (
                  <button
                    className="font-mono text-xs text-signal hover:underline"
                    onClick={() => nav.openTask(w.task!)}
                  >
                    {w.task.split('/').pop()}
                  </button>
                )}
                <span className="min-w-0 truncate text-fg">
                  <RefText text={w.title} />
                </span>
                {w.project && <span className="text-xs text-fg-4">{w.project}</span>}
              </div>
              <div className="mt-1 flex items-start gap-1.5 text-xs text-fg-3">
                <Hourglass size={12} className="mt-px shrink-0 text-warn" />
                <Markdown text={w.reason} clamp lines={2} className="min-w-0 flex-1" />
              </div>
            </div>
            <div className="flex shrink-0 -space-x-1.5">
              {w.agents.slice(0, 4).map((a) => (
                <Avatar key={a} id={a} size={22} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STATUS_COLOR: Record<Agent['status'], string> = {
  active: '#3ddc97',
  paused: '#ffb547',
  proposed: '#5aa9ff',
};

type AgentPatch = { wake?: boolean; budget?: string | null; model?: string | null };

function AgentCard(props: {
  agent?: Agent;
  id: string;
  runs: RunRecord[];
  backlog: Task[];
  nav: Nav;
  now: number;
  /** The agent's `opsd.agents.<id>` settings; undefined until Settings loads. */
  config?: { wake?: boolean; budget?: string; model?: string };
  defaultBudget?: number;
  /** The model its provider sets, if any. */
  providerModel?: string;
  configBusy: boolean;
  onConfig: (patch: AgentPatch) => void;
  /** Takes it out of the opsd config; only for agents listed there. */
  onRemove?: () => void;
  /** Opens its role file, or starts one for it. */
  onRoleFile: () => void;
}) {
  const { agent, id, runs, backlog, nav, now, config } = props;
  const [removing, setRemoving] = useState(false);
  const [task, setTask] = useState('');
  const [budget, setBudget] = useState('');
  const act = useAction();
  const who = identity(id);
  const RoleIcon = ROLE_ICONS[who.roleInfo.icon];
  const c = who.provider.color;
  const status = agent?.status ?? 'active';
  const claims = agent?.can_claim ?? ['*'];
  const start = (): void =>
    act.run(
      () =>
        api('POST', '/api/runs', {
          agent: id,
          task: task.trim() || undefined,
          budget: budget.trim() || undefined,
        }),
      () => {
        setTask('');
        refreshSoon();
      },
    );
  return (
    <div
      className={cx(
        'panel animate-rise relative flex flex-col overflow-hidden p-4',
        status !== 'active' && 'opacity-75',
      )}
      style={
        runs.length > 0
          ? {
              boxShadow: `0 0 0 1px color-mix(in oklab, ${c} 35%, transparent), 0 0 30px -12px ${c}`,
            }
          : undefined
      }
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(360px 140px at 0% 0%, color-mix(in oklab, ${c} 11%, transparent), transparent 70%)`,
        }}
      />
      <div className="relative flex items-start gap-3">
        <Avatar id={id} size={46} live={runs.length > 0} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Who id={id} plain size="md" />
            {agent?.wake && (
              <Chip color="#5ce1e6" icon={Zap} title="opsd starts runs for it when it has work">
                wakes
              </Chip>
            )}
          </div>
          {agent?.name && <div className="mt-0.5 truncate font-medium text-fg">{agent.name}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {!who.human && who.role && (
              <Chip color={who.roleInfo.color} icon={RoleIcon}>
                {who.roleInfo.label}
              </Chip>
            )}
            <Chip color={STATUS_COLOR[status]}>
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: STATUS_COLOR[status] }}
              />
              {agent?.file ? status : 'no role file'}
            </Chip>
            {agent?.provider === false && (
              <Chip
                color="#ffb547"
                icon={PauseCircle}
                title={`No provider '${who.runtime}' in Settings > Providers: its runs do not start`}
              >
                no provider
              </Chip>
            )}
          </div>
        </div>
      </div>

      {agent?.description && (
        <p className="relative mt-3 line-clamp-3 text-sm leading-relaxed text-fg-3">
          {agent.description}
        </p>
      )}

      <div className="relative mt-3 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="label-caps mr-1">Claims</span>
        {claims.map((k) => (
          <span key={k} className="rounded-md bg-white/6 px-1.5 py-px font-mono text-fg-2">
            {k === '*' ? 'anything' : k}
          </span>
        ))}
        {agent?.budget_min ? (
          <span className="ml-auto text-fg-4">budget {minutes(agent.budget_min)}</span>
        ) : null}
      </div>

      {config && !who.human && (
        <AgentSettings
          config={config}
          placeholder={
            agent?.budget_min
              ? minutes(agent.budget_min)
              : props.defaultBudget
                ? minutes(props.defaultBudget)
                : ''
          }
          modelPlaceholder={agent?.model ?? props.providerModel ?? `${who.runtime} default`}
          busy={props.configBusy}
          onChange={props.onConfig}
        />
      )}
      {!who.human && (
        <div className="relative mt-2 flex items-center gap-2 text-xs">
          <Button
            size="sm"
            kind="ghost"
            icon={agent?.file ? ScrollText : FilePlus2}
            onClick={props.onRoleFile}
          >
            {agent?.file ? 'Role file' : 'Create role file'}
          </Button>
          {props.onRemove &&
            (removing ? (
              <span className="ml-auto flex items-center gap-2 text-fg-3">
                Remove {id} from your agents?
                <Button
                  size="sm"
                  kind="danger"
                  disabled={props.configBusy}
                  onClick={() => {
                    setRemoving(false);
                    props.onRemove!();
                  }}
                >
                  Remove
                </Button>
                <Button size="sm" kind="ghost" onClick={() => setRemoving(false)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <span className="ml-auto">
                <Button
                  size="sm"
                  kind="ghost"
                  icon={Trash2}
                  title={agent?.file ? 'Its role file stays' : undefined}
                  onClick={() => setRemoving(true)}
                >
                  Remove
                </Button>
              </span>
            ))}
        </div>
      )}

      {backlog.length > 0 && (
        <div className="relative mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span
            className="label-caps mr-1"
            title="To do, owned by this agent, its role or its provider"
          >
            Backlog {backlog.length}
          </span>
          {backlog.slice(0, 4).map((t) => (
            <button
              key={`${t.root}/${t.id}`}
              type="button"
              title={t.title}
              onClick={() => nav.openTask(`${t.root}/${t.id}`)}
              className="rounded-md bg-white/6 px-1.5 py-px font-mono text-fg-2 transition hover:bg-signal/12 hover:text-signal"
            >
              {t.id}
            </button>
          ))}
          {backlog.length > 4 && <span className="text-fg-4">+{backlog.length - 4}</span>}
        </div>
      )}

      {runs.length > 0 && (
        <div className="relative mt-3 flex flex-col gap-2">
          {runs.map((run) => (
            <LiveRun
              key={run.id}
              run={run}
              nav={nav}
              now={now}
              busy={act.busy}
              onKill={() => act.run(() => api('POST', `/api/runs/${run.id}/kill`, {}), refreshSoon)}
            />
          ))}
        </div>
      )}

      {(!agent || agent.status === 'active') && (
        <div className="relative mt-auto pt-4">
          <div className="flex items-center gap-2 border-t border-white/6 pt-3">
            <Input
              value={task}
              onChange={setTask}
              placeholder="task (optional)"
              className="w-0 min-w-0 flex-1"
              onEnter={start}
            />
            <Input
              value={budget}
              onChange={setBudget}
              placeholder="budget"
              className="w-20"
              onEnter={start}
            />
            <Button kind="primary" icon={Play} disabled={act.busy} onClick={start}>
              Start run
            </Button>
          </div>
          <div className="mt-1.5 text-xs text-fg-4">
            {task.trim()
              ? 'Works that task.'
              : 'Empty task: reads its inbox, then takes its next task.'}
          </div>
        </div>
      )}
      {act.error && (
        <div className="relative mt-2">
          <ErrorLine error={act.error} />
        </div>
      )}
    </div>
  );
}

/**
 * The card's own opsd settings: the Wake switch and the default run budget. Every listed agent
 * has them, so wake turned on anywhere can be turned off from the card.
 */
function AgentSettings({
  config,
  placeholder,
  modelPlaceholder,
  busy,
  onChange,
}: {
  config: { wake?: boolean; budget?: string; model?: string };
  placeholder: string;
  modelPlaceholder: string;
  busy: boolean;
  onChange: (patch: AgentPatch) => void;
}) {
  const savedBudget = config.budget ?? '';
  const savedModel = config.model ?? '';
  const [budget, setBudget] = useState(savedBudget);
  const [model, setModel] = useState(savedModel);
  useEffect(() => setBudget(savedBudget), [savedBudget]);
  useEffect(() => setModel(savedModel), [savedModel]);
  const patch: AgentPatch = {};
  if (budget.trim() !== savedBudget) patch.budget = budget.trim() || null;
  if (model.trim() !== savedModel) patch.model = model.trim() || null;
  const dirty = Object.keys(patch).length > 0;
  const save = (): void => {
    if (dirty && !busy) onChange(patch);
  };
  return (
    <div className="relative mt-3 flex items-center gap-2 text-xs">
      <Toggle
        checked={config.wake ?? false}
        onChange={(on) => !busy && onChange({ wake: on })}
        label="Wake"
      />
      <span
        className="ml-auto text-fg-4"
        title="Model for this agent's runs; over its role file's and its provider's"
      >
        Model
      </span>
      <Input
        value={model}
        onChange={setModel}
        placeholder={modelPlaceholder}
        className="w-28 font-mono"
        onEnter={save}
      />
      <span
        className="text-fg-4"
        title="Budget for each run of this agent, unless a run sets its own"
      >
        Budget
      </span>
      <Input
        value={budget}
        onChange={setBudget}
        placeholder={placeholder}
        className="w-16"
        onEnter={save}
      />
      {dirty && (
        <Button size="sm" disabled={busy} onClick={save}>
          Save
        </Button>
      )}
    </div>
  );
}

/**
 * Adds an agent to the opsd config: a provider from Settings > Providers and a role. It runs
 * with the built-in prompt for the role until it has a role file.
 */
function AddAgent({
  initial,
  bare,
  providers,
  taken,
  busy,
  onAdd,
  onCancel,
}: {
  /** An id to fill in, such as `claude:orchestrator`; its provider only if one exists. */
  initial?: string;
  /** Leave out the panel frame, inside a dialog. */
  bare?: boolean;
  providers: string[];
  taken: string[];
  busy: boolean;
  onAdd: (id: string, patch: AgentPatch) => void;
  onCancel: () => void;
}) {
  const [initialProvider, initialRole] = initial?.split(':') ?? [];
  const [provider, setProvider] = useState(
    initialProvider && providers.includes(initialProvider) ? initialProvider : (providers[0] ?? ''),
  );
  const [role, setRole] = useState(initialRole ?? '');
  const [model, setModel] = useState('');
  const [wake, setWake] = useState(false);
  const r = role.trim().toLowerCase();
  const id = `${provider}:${r}`;
  const error = !r
    ? null
    : !/^[a-z][a-z0-9-]{0,39}$/.test(r)
      ? 'Lowercase letters, digits and hyphens'
      : taken.includes(id)
        ? `${id} exists`
        : null;
  return (
    <div className={cx('flex flex-wrap items-end gap-3', !bare && 'panel animate-rise p-4')}>
      <label className="flex flex-col gap-1 text-xs text-fg-3">
        Provider
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="h-[34px] rounded-lg border border-white/10 bg-ink-950/60 px-2 text-sm text-fg"
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-3">
        Role
        <Input value={role} onChange={setRole} placeholder="writer" className="w-36" autoFocus />
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-3">
        Model
        <Input
          value={model}
          onChange={setModel}
          placeholder="provider default"
          className="w-36 font-mono"
        />
      </label>
      <div className="pb-1.5">
        <Toggle checked={wake} onChange={setWake} label="Wake" />
      </div>
      <Button
        kind="primary"
        icon={Plus}
        disabled={!provider || !r || Boolean(error) || busy}
        onClick={() => onAdd(id, { wake, ...(model.trim() ? { model: model.trim() } : {}) })}
      >
        Add {provider && r ? id : 'agent'}
      </Button>
      <Button kind="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <div className="basis-full text-xs">
        {error ? (
          <span className="text-warn">{error}</span>
        ) : providers.length === 0 ? (
          <span className="text-warn">Add a provider in Settings first.</span>
        ) : (
          <span className="text-fg-4">
            Runs with the built-in prompt for its role until you create its role file.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Add agent as a dialog, for a not configured id picked in a form (lib/goto.ts). It opens above
 * that form's dialog and leaves it as it was; `onAdded` gets the id once opsd saved it.
 */
export function AddAgentDialog({
  id,
  onAdded,
  onClose,
}: {
  id: string;
  onAdded?: (id: string) => void;
  onClose: () => void;
}) {
  const settings = useData<Settings>('/api/settings');
  const agents = useData<Agent[]>('/api/agents');
  const act = useAction();
  const taken = [
    ...new Set([
      ...(agents.data ?? []).map((a) => a.id),
      ...Object.keys(settings.data?.opsd.agents ?? {}),
    ]),
  ];
  const add = (added: string, patch: AgentPatch): void =>
    act.run(
      () => api('POST', '/api/settings', { patch: { opsd: { agents: { [added]: patch } } } }),
      () => {
        // The pickers read /api/directory; the refresh marks the new agent configured there.
        refreshSoon();
        toast(`Added ${added}`);
        onAdded?.(added);
        onClose();
      },
    );
  return (
    <Modal title="Add agent" icon={Bot} onClose={onClose} width={640} stacked>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-3">
          <span className="font-mono">{id}</span> is not configured, so no run picks up work for it.
          Add it here; the form you came from stays as you left it.
        </p>
        {settings.data ? (
          <AddAgent
            bare
            initial={id}
            providers={Object.keys(settings.data.opsd.runtimes ?? {})}
            taken={taken}
            busy={act.busy}
            onAdd={add}
            onCancel={onClose}
          />
        ) : (
          !settings.error && <div className="text-sm text-fg-4">Loading settings…</div>
        )}
        <ErrorLine error={settings.error ?? act.error} />
      </div>
    </Modal>
  );
}

function LiveRun(props: {
  run: RunRecord;
  nav: Nav;
  now: number;
  busy: boolean;
  onKill: () => void;
}) {
  const { run, nav, now } = props;
  const c = identity(run.agent).provider.color;
  const used = (now - Date.parse(run.started_at)) / 60_000;
  const share = run.budget_minutes > 0 ? used / run.budget_minutes : 0;
  const bar = share > 1 ? '#ff5d6c' : share >= 0.9 ? '#ffb547' : c;
  return (
    <div
      className="rounded-lg bg-ink-950/60 px-3 py-2.5"
      style={{ boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 22%, transparent)` }}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="animate-pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-ok text-ok" />
        {run.task ? (
          <button
            className="font-mono text-signal hover:underline"
            onClick={() => nav.openTask(`${run.root}/${run.task}`)}
          >
            {run.task}
          </button>
        ) : run.schedule ? (
          <span className="inline-flex items-center gap-1 text-review">
            <CalendarClock size={13} />
            {run.schedule}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-info">
            <Inbox size={13} />
            inbox
          </span>
        )}
        {run.review && (
          <Chip color="#b18cff" icon={Eye}>
            review
          </Chip>
        )}
        {run.parent && (
          <Chip color="#5aa9ff" icon={GitFork}>
            helper
          </Chip>
        )}
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" icon={ScrollText} onClick={() => nav.go('runs', run.id)}>
            Log
          </Button>
          <Button size="sm" kind="danger" icon={Skull} disabled={props.busy} onClick={props.onKill}>
            Kill
          </Button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/6">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(100, Math.max(2, share * 100))}%`,
              background: bar,
              boxShadow: `0 0 8px ${bar}`,
            }}
          />
        </div>
        <span className="shrink-0 font-mono text-[11px] text-fg-3">
          {minutes(Math.max(0, Math.floor(used)))}/{minutes(run.budget_minutes)} ·{' '}
          {tokens(run.tokens)}
          {run.token_budget ? `/${tokens(run.token_budget)}` : ''} tok
        </span>
      </div>
      {run.project && (
        <div className="mt-1 text-[11px] text-fg-4">
          {run.project} · started {ago(run.started_at)}
        </div>
      )}
    </div>
  );
}

/**
 * What makes an agent run, in plain words, with this machine's numbers: so an empty Agents view
 * still says whether anything works.
 */
function HowAgentsStart({
  connected,
  wakes,
  maxRuns,
  halted,
  paused,
  onCreate,
}: {
  connected: boolean;
  wakes: number;
  maxRuns?: number;
  /** opsd as a whole is paused. */
  halted: boolean;
  paused: string[];
  onCreate: () => void;
}) {
  const items: Array<{ icon: LucideIcon; title: string; text: string }> = [
    {
      icon: Zap,
      title: 'Wake on work',
      text:
        wakes > 0
          ? `opsd starts ${wakes === 1 ? 'one agent' : `${wakes} agents`} by itself when they have inbox items or a task to claim.`
          : 'Off for every agent: opsd starts nothing by itself. Turn it on per agent below or in a role.',
    },
    {
      icon: Play,
      title: 'Run agent',
      text: 'From a task panel: starts that agent on the task now, within the limits.',
    },
    {
      icon: CalendarClock,
      title: 'Schedules',
      text: 'Start an agent at a time or every interval, with or without a task.',
    },
    {
      icon: ScrollText,
      title: 'Role files',
      text: 'Optional. Give an agent its own instructions, knowledge and style; without one it runs with the built-in prompt.',
    },
  ];
  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center gap-3">
        <span
          className={cx('h-2.5 w-2.5 rounded-full', connected ? 'bg-ok' : 'bg-bad')}
          style={{ boxShadow: connected ? '0 0 10px rgba(61,220,151,0.7)' : undefined }}
        />
        <span className="text-sm text-fg-2">
          {connected
            ? `opsd is running on this PC${maxRuns !== undefined ? ` · up to ${maxRuns} runs at once` : ''}`
            : 'opsd is not connected: nothing runs until it starts'}
          {connected && halted && (
            <span className="text-warn">
              {' '}
              · opsd is paused: no new runs start until you resume it in Settings or the tray
            </span>
          )}
          {connected && maxRuns === 0 && (
            <span className="text-warn"> · max_runs is 0 in Settings, so no run starts</span>
          )}
          {paused.length > 0 && <span className="text-warn"> · paused: {paused.join(', ')}</span>}
        </span>
        <Button size="sm" kind="primary" icon={FilePlus2} onClick={onCreate}>
          Create role
        </Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {items.map(({ icon: Icon, title, text }) => (
          <div key={title} className="rounded-xl bg-white/3 px-3 py-2.5">
            <div className="flex items-center gap-2 text-sm font-medium text-fg">
              <Icon size={14} className="text-signal" /> {title}
            </div>
            <div className="mt-1 text-xs leading-relaxed text-fg-3">{text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Agents a configured runtime can run with a usual role and no role file: they work from Run
 * agent and schedules, and wake when turned on.
 */
function Runnable({
  items,
  wake,
  onWake,
  onCreate,
  busy,
}: {
  items: DirectoryItem[];
  wake: Record<string, boolean | undefined>;
  onWake: (id: string, on: boolean) => void;
  onCreate: (id: string) => void;
  busy: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <Caps>Ready without a role file</Caps>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
        {items.map((d) => (
          <div key={d.id} className="panel flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <Who id={d.id} label />
              <div className="mt-0.5 text-[11px] text-fg-4">
                {d.paused ? 'provider paused' : 'built-in prompt'}
              </div>
            </div>
            <Toggle
              checked={wake[d.id] ?? false}
              onChange={(on) => !busy && onWake(d.id, on)}
              label="Wake"
            />
            <button
              type="button"
              title="Create a role file for this agent"
              onClick={() => onCreate(d.id)}
              className="rounded-md p-1 text-fg-4 hover:bg-white/8 hover:text-fg"
            >
              <FilePlus2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
