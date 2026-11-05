import { CalendarClock, ChevronRight, GripVertical, Kanban, Rows3 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Nav } from '../App';
import { useData } from '../api';
import {
  Avatar,
  ErrorLine,
  PriorityIcon,
  PriorityTag,
  Section,
  Select,
  StatusIcon,
  Toggle,
  Who,
  cx,
} from '../components';
import type { Lanes, TaskFilter } from '../lib/filters';
import {
  boardShowsIdeas,
  IDEAS_CHANGED,
  LANES,
  lanesOf,
  loadViews,
  matchesFilter,
  setBoardShowsIdeas,
} from '../lib/filters';
import { ago, columns, COLUMNS, ownerlessLabel, waitReasons } from '../lib/format';
import { dueLabel, identity, priorityInfo, statusInfo } from '../lib/identity';
import { moveTo } from '../lib/transitions';
import type { RunRecord, Status, Task, WaitItem } from '../types';
import { FilterBar } from '../ui/filters';
import { useMover } from '../ui/move';
import { onTaskRef, RefText } from '../ui/refs';

/** The status a drop on each column asks for. */
const TARGET: Record<string, Status> = {
  todo: 'todo',
  working: 'in-progress',
  blocked: 'blocked',
  review: 'needs-review',
  done: 'done',
};

const TYPE_COLOR: Record<string, string> = {
  bug: '#ff5d6c',
  finding: '#ffb547',
  doc: '#4fd1c5',
  eval: '#b18cff',
  idea: '#ffd166',
};

export function Board({ nav, preset }: { nav: Nav; preset?: string }) {
  const { data, error } = useData<Task[]>('/api/tasks?all');
  const waits = useData<{ waits: WaitItem[] }>('/api/waits');
  const live = useData<RunRecord[]>('/api/runs?live');
  const [moveError, setMoveError] = useState<string | null>(null);
  const mover = useMover(nav, setMoveError);
  // Ideas are not work: hidden until asked for, so they do not crowd the todo column. The toggle
  // is remembered, and creating an idea turns it on so the new idea shows here.
  const [filter, setFilter] = useState<TaskFilter>(() => ({ ideas: boardShowsIdeas() }));
  const [lanes, setLanes] = useState<Lanes>('none');
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Task | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // A saved view from the sidebar arrives as `saved:<name>`.
  useEffect(() => {
    // `lanes:<mode>` opens the board with lanes, for links from other views.
    const mode = LANES.find(([k]) => preset === `lanes:${k}`);
    if (mode) setLanes(mode[0]);
    if (!preset?.startsWith('saved:')) return;
    const v = loadViews().find((x) => x.name === preset.slice(6));
    if (v) {
      setFilter({ ideas: boardShowsIdeas(), ...v.filter });
      setLanes(v.lanes ?? 'none');
    }
  }, [preset]);
  useEffect(() => {
    const changed = (e: Event): void => {
      const ideas = (e as CustomEvent<boolean>).detail;
      setFilter((f) => (f.ideas === ideas ? f : { ...f, ideas }));
    };
    window.addEventListener(IDEAS_CHANGED, changed);
    return () => window.removeEventListener(IDEAS_CHANGED, changed);
  }, []);

  const why = waitReasons(waits.data?.waits ?? []);
  const running = new Set(
    (live.data ?? []).filter((r) => r.task).map((r) => `${r.root}/${r.task}`),
  );
  const tasks = useMemo(() => data ?? [], [data]);
  const shown = tasks.filter((t) => matchesFilter(t, filter, nav.me));
  const open = shown.filter((t) => !['done', 'parked'].includes(t.status)).length;
  const groups = lanesOf(shown, lanes);

  const column = (laneKey: string, key: string, list: Task[], grow: boolean) => {
    const target = TARGET[key]!;
    const allowed = drag ? typeof moveTo(drag, target) !== 'string' : false;
    const id = `${laneKey}:${key}`;
    return (
      <div
        key={id}
        onDragOver={(e) => {
          if (!drag || !allowed) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOver(id);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(null);
          if (drag) mover.request(drag, target);
          setDrag(null);
        }}
        className={cx(
          'flex min-w-60 flex-1 flex-col gap-2 rounded-xl p-2 transition',
          grow && 'min-h-0 overflow-y-auto',
          over === id
            ? 'bg-signal/6 shadow-[inset_0_0_0_1px_rgba(92,225,230,0.6)]'
            : drag && !allowed
              ? 'opacity-50'
              : '',
        )}
      >
        {list.map((t, i) => (
          <Card
            key={`${t.root}/${t.id}`}
            t={t}
            index={i}
            live={running.has(`${t.root}/${t.id}`)}
            waits={why.get(`${t.root}/${t.id}`)}
            dragging={drag?.id === t.id && drag.root === t.root}
            onDragStart={() => setDrag(t)}
            onDragEnd={() => {
              setDrag(null);
              setOver(null);
            }}
            onOpen={() => nav.openTask(`${t.root}/${t.id}`)}
          />
        ))}
        {list.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/8 py-5 text-center text-xs text-fg-4">
            {drag && allowed ? 'Drop here' : 'Nothing here'}
          </div>
        )}
      </div>
    );
  };

  const header = (key: string, title: string, count: number, inRow = false) => {
    const info = statusInfo(TARGET[key]!);
    return (
      <div
        key={key}
        className={cx(
          'flex items-center gap-2 rounded-t-xl px-3 py-2.5',
          inRow ? 'min-w-60 flex-1' : 'shrink-0',
        )}
        style={{ boxShadow: `inset 0 2px 0 ${info.color}` }}
      >
        <StatusIcon status={TARGET[key]!} />
        <span className="font-display text-sm font-semibold tracking-wide">{title}</span>
        <span
          className="ml-auto rounded-full px-2 py-0.5 font-mono text-[11px]"
          style={{
            color: info.color,
            background: `color-mix(in oklab, ${info.color} 12%, transparent)`,
          }}
        >
          {count}
        </span>
      </div>
    );
  };

  const all = columns(shown);
  return (
    <Section
      title="Board"
      icon={Kanban}
      subtitle={`${open} open · drag a card to another column to change its status`}
      actions={
        <>
          <div className="flex items-center gap-1.5 text-fg-4">
            <Rows3 size={14} />
            <Select
              value={lanes}
              onChange={(v) => setLanes(v as Lanes)}
              options={LANES.map(([k, label]): [string, string] => [k, label])}
            />
          </div>
          <Toggle
            checked={filter.ideas !== false}
            onChange={(ideas) => {
              setFilter({ ...filter, ideas });
              setBoardShowsIdeas(ideas);
            }}
            label="Ideas"
          />
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="px-6 pt-4">
          <FilterBar
            tasks={tasks}
            filter={filter}
            onChange={setFilter}
            view="board"
            lanes={lanes}
          />
          {(error || moveError) && (
            <div className="pt-3">
              <ErrorLine error={error ?? moveError} />
            </div>
          )}
        </div>
        {lanes === 'none' ? (
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 py-4">
            {COLUMNS.map((c) => (
              <div
                key={c.key}
                className="flex min-w-60 flex-1 flex-col rounded-2xl border border-white/7 bg-ink-850/60"
              >
                {header(c.key, c.title, all[c.key]!.length)}
                {column('all', c.key, all[c.key]!, true)}
              </div>
            ))}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
            <div className="sticky top-0 z-10 flex gap-3 bg-ink-900/95 pt-4 backdrop-blur">
              {COLUMNS.map((c) => header(c.key, c.title, all[c.key]!.length, true))}
            </div>
            {groups.length === 0 && (
              <div className="py-10 text-center text-sm text-fg-4">No tasks match.</div>
            )}
            {groups.map((g) => {
              const cols = columns(g.tasks);
              const closed = folded.has(g.key);
              return (
                <div key={g.key} className="mt-3 rounded-2xl border border-white/7 bg-ink-850/50">
                  <button
                    type="button"
                    onClick={() => {
                      const next = new Set(folded);
                      if (closed) next.delete(g.key);
                      else next.add(g.key);
                      setFolded(next);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                  >
                    <ChevronRight
                      size={14}
                      className={cx('text-fg-4 transition', !closed && 'rotate-90')}
                    />
                    <LaneLabel mode={lanes} k={g.key} />
                    <span className="ml-auto font-mono text-[11px] text-fg-4">
                      {g.tasks.filter((t) => !['done', 'parked'].includes(t.status)).length} open
                    </span>
                  </button>
                  {!closed && (
                    <div className="flex gap-3 px-1 pb-1">
                      {COLUMNS.map((c) => column(g.key, c.key, cols[c.key]!, false))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {mover.dialog}
    </Section>
  );
}

function LaneLabel({ mode, k }: { mode: Lanes; k: string }) {
  if (mode === 'priority') return <PriorityTag p={k} />;
  if (mode === 'agent') {
    return k ? (
      <Who id={k} label size="xs" />
    ) : (
      <span className="text-sm text-fg-4">Unassigned</span>
    );
  }
  return k ? (
    <span className="font-mono text-sm text-fg-2">{k}</span>
  ) : (
    <span className="text-sm text-fg-4">No project</span>
  );
}

function Card(props: {
  t: Task;
  index: number;
  live: boolean;
  waits?: string;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const { t } = props;
  const who = t.claimedBy ?? t.owner;
  const accent = who ? identity(who).provider.color : '#3a4558';
  const due = t.delegation?.due ? dueLabel(t.delegation.due) : null;
  const closed = t.status === 'done' || t.status === 'parked';
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `${t.root}/${t.id}`);
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}
      onClick={(e) => onTaskRef(e) || props.onOpen()}
      style={{ animationDelay: `${Math.min(props.index, 12) * 25}ms` }}
      className={cx(
        'group animate-rise relative shrink-0 cursor-pointer overflow-hidden rounded-xl border bg-ink-800/90 p-3 pl-3.5 transition hover:-translate-y-px hover:border-white/20 hover:bg-ink-750',
        t.stale ? 'border-warn/40' : 'border-white/8',
        props.dragging && 'opacity-40',
        closed && 'opacity-70',
      )}
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: accent }} />
      <div className="flex items-center gap-2">
        <span title={`${priorityInfo(t.priority).label} priority`}>
          <PriorityIcon p={t.priority} />
        </span>
        <span className="font-mono text-[11px] text-fg-4">{t.id}</span>
        {t.type !== 'task' && (
          <span
            className="rounded px-1.5 text-[10px] font-semibold tracking-wider uppercase"
            style={{
              color: TYPE_COLOR[t.type] ?? '#94a3b8',
              background: `color-mix(in oklab, ${TYPE_COLOR[t.type] ?? '#94a3b8'} 14%, transparent)`,
            }}
          >
            {t.type}
          </span>
        )}
        {t.project && <span className="truncate text-[11px] text-fg-4">{t.project}</span>}
        <GripVertical
          size={14}
          className="ml-auto shrink-0 text-fg-4 opacity-0 transition group-hover:opacity-100"
        />
      </div>
      <div
        className={cx('mt-1.5 line-clamp-2 text-sm leading-snug', closed ? 'text-fg-3' : 'text-fg')}
      >
        <RefText text={t.title} />
      </div>
      {(t.stale || t.unblocked) && (
        <div className="mt-1 text-[11px]">
          {t.stale && <span className="text-warn">stale claim</span>}
          {t.unblocked && <span className="text-ok">dependencies done</span>}
        </div>
      )}
      {t.status === 'blocked' && (t.waitingOn || t.blockedOn) && (
        <div className="mt-1.5 text-[11px] text-warn/90">
          waits on {t.waitingOn ?? t.blockedOn?.join(', ')}
        </div>
      )}
      {props.waits && !closed && (
        <div className="mt-1.5 line-clamp-2 text-[11px] text-fg-4" title={props.waits}>
          <RefText text={props.waits} />
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        {who ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px]">
            <Avatar id={who} size={18} live={props.live} />
            <span className="truncate font-mono" style={{ color: accent }}>
              {who}
            </span>
          </span>
        ) : (
          <span className="text-[11px] text-fg-4">{ownerlessLabel(t) ?? 'unassigned'}</span>
        )}
        {due && !closed && (
          <span
            className={cx(
              'ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]',
              due.overdue
                ? 'bg-bad/15 text-bad'
                : due.soon
                  ? 'bg-warn/12 text-warn'
                  : 'bg-white/5 text-fg-3',
            )}
          >
            <CalendarClock size={11} /> {due.text}
          </span>
        )}
        {(!due || closed) && (
          <span className="ml-auto shrink-0 text-[11px] text-fg-4">{ago(t.updatedAt)}</span>
        )}
      </div>
    </div>
  );
}
