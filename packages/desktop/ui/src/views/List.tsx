import { AlarmClock, ArrowDown, ArrowUp, ListTodo } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Nav } from '../App';
import { useData } from '../api';
import {
  Empty,
  ErrorLine,
  PriorityTag,
  Section,
  StatusIcon,
  StatusTag,
  Toggle,
  Who,
  cx,
} from '../components';
import type { TaskFilter } from '../lib/filters';
import { loadViews, matchesFilter } from '../lib/filters';
import { ago } from '../lib/format';
import { dueLabel, STATUSES } from '../lib/identity';
import type { Task } from '../types';
import { FilterBar, FilterChip } from '../ui/filters';
import { onTaskRef, RefText } from '../ui/refs';

const OPEN = new Set(['todo', 'claimed', 'in-progress', 'blocked', 'needs-review']);
const CLOSED = new Set(['done', 'parked']);

type SortKey = 'priority' | 'updated';
interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

function SortHead(props: {
  label: string;
  k: SortKey;
  sort: Sort;
  onSort: (s: Sort) => void;
  className?: string;
}) {
  const active = props.sort.key === props.k;
  const Arrow = props.sort.dir === 1 ? ArrowUp : ArrowDown;
  return (
    <th className={cx('py-2 pr-3 font-normal', props.className)}>
      <button
        type="button"
        onClick={() =>
          props.onSort(
            active
              ? { key: props.k, dir: props.sort.dir === 1 ? -1 : 1 }
              : { key: props.k, dir: props.k === 'priority' ? 1 : -1 },
          )
        }
        className={cx(
          'label-caps inline-flex items-center gap-1 transition hover:text-fg',
          active && 'text-signal!',
        )}
      >
        {props.label}
        {active && <Arrow size={11} />}
      </button>
    </th>
  );
}

export function List({ nav, preset }: { nav: Nav; preset?: string }) {
  const [all, setAll] = useState(false);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState<TaskFilter>({});
  const [sort, setSort] = useState<Sort>({ key: 'priority', dir: 1 });
  // A saved view from the sidebar arrives as `saved:<name>`.
  useEffect(() => {
    if (!preset?.startsWith('saved:')) return;
    const v = loadViews().find((x) => x.name === preset.slice(6));
    if (v) setFilter(v.filter);
  }, [preset]);
  const { data, error } = useData<Task[]>(all ? '/api/tasks?all' : '/api/tasks');
  const tasks = useMemo(() => data ?? [], [data]);
  const rows = useMemo(() => {
    const out = tasks.filter(
      (t) =>
        matchesFilter(t, filter, nav.me) &&
        (!status || (status === 'open' ? OPEN.has(t.status) : t.status === status)),
    );
    const updated = (t: Task): number => Date.parse(t.updatedAt) || 0;
    return out.sort((x, y) => {
      if (sort.key === 'priority') {
        const p = x.priority.localeCompare(y.priority) * sort.dir;
        return p || updated(y) - updated(x);
      }
      return (updated(x) - updated(y)) * sort.dir;
    });
  }, [tasks, filter, status, sort, nav.me]);
  const now = Date.now();
  const statusLabel =
    status === 'open' ? 'Open' : (STATUSES.find((st) => st.key === status)?.label ?? status);
  return (
    <Section
      title="Tasks"
      icon={ListTodo}
      subtitle={data ? `${rows.length} of ${tasks.length} tasks` : 'Every task across your roots'}
      actions={<Toggle checked={all} onChange={setAll} label="Include closed and archived" />}
    >
      <div className="px-6 pt-4 pb-3">
        <FilterBar tasks={tasks} filter={filter} onChange={setFilter} view="list">
          <FilterChip
            label="Status"
            icon={<StatusIcon status={status && status !== 'open' ? status : 'in-progress'} />}
            value={status}
            display={<span>{statusLabel}</span>}
            onChange={setStatus}
            options={[
              {
                value: 'open',
                node: (
                  <span className="flex items-center gap-2">
                    <StatusIcon status="in-progress" /> Open (not done or parked)
                  </span>
                ),
              },
              ...STATUSES.map((st) => ({
                value: st.key,
                node: (
                  <span className="flex items-center gap-2">
                    <StatusIcon status={st.key} /> {st.label}
                  </span>
                ),
              })),
            ]}
          />
        </FilterBar>
      </div>

      <div className="px-6 pb-6">
        <ErrorLine error={error} />
        {data && rows.length === 0 && (
          <Empty icon={ListTodo} title={tasks.length ? 'No tasks match' : 'No tasks yet'}>
            {tasks.length
              ? 'Loosen a filter or clear the search.'
              : 'Create a task and it shows up here.'}
          </Empty>
        )}
        {rows.length > 0 && (
          <div className="panel overflow-clip">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-ink-850/95 text-left backdrop-blur">
                <tr className="border-b border-white/6">
                  <SortHead
                    label="Priority"
                    k="priority"
                    sort={sort}
                    onSort={setSort}
                    className="w-28 pl-4"
                  />
                  <th className="label-caps py-2 pr-3 font-normal">Task</th>
                  <th className="label-caps w-36 py-2 pr-3 font-normal">Status</th>
                  <th className="label-caps w-48 py-2 pr-3 font-normal">Owner</th>
                  <th className="label-caps w-32 py-2 pr-3 font-normal">Due</th>
                  <SortHead
                    label="Updated"
                    k="updated"
                    sort={sort}
                    onSort={setSort}
                    className="w-24 pr-4"
                  />
                </tr>
              </thead>
              <tbody>
                {rows.map((t, i) => {
                  const due = t.delegation?.due ? dueLabel(t.delegation.due, now) : null;
                  const late = !!due?.overdue && !CLOSED.has(t.status);
                  return (
                    <tr
                      key={`${t.root}/${t.id}`}
                      onClick={(e) => onTaskRef(e) || nav.openTask(`${t.root}/${t.id}`)}
                      style={{ animationDelay: `${Math.min(i * 12, 240)}ms` }}
                      className={cx(
                        'animate-rise group cursor-pointer border-b border-white/[0.04] transition last:border-0 hover:bg-white/[0.035]',
                        (t.archived || CLOSED.has(t.status)) && 'opacity-60',
                      )}
                    >
                      <td className="py-2 pr-3 pl-4">
                        <PriorityTag p={t.priority} />
                      </td>
                      <td className="max-w-0 py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 font-mono text-[11px] text-fg-4 group-hover:text-signal">
                            {t.id}
                          </span>
                          <span className="truncate text-fg group-hover:text-white">
                            <RefText text={t.title} />
                          </span>
                          {t.project && (
                            <span className="shrink-0 rounded-md bg-white/5 px-1.5 font-mono text-[10px] text-fg-3 ring-1 ring-white/8 ring-inset">
                              {t.project}
                            </span>
                          )}
                          {(t.labels ?? []).slice(0, 2).map((l) => (
                            <span key={l} className="shrink-0 text-[11px] text-fg-4">
                              #{l}
                            </span>
                          ))}
                          {t.archived && (
                            <span className="shrink-0 rounded-md bg-white/5 px-1.5 text-[10px] text-fg-4">
                              archived
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <StatusTag status={t.status} stale={t.stale} unblocked={t.unblocked} />
                      </td>
                      <td className="max-w-0 py-2 pr-3">
                        <Who id={t.claimedBy ?? t.owner} />
                      </td>
                      <td className="py-2 pr-3">
                        {due ? (
                          <span
                            className={cx(
                              'inline-flex items-center gap-1 text-xs',
                              late ? 'font-medium text-bad' : due.soon ? 'text-warn' : 'text-fg-3',
                            )}
                            title={t.delegation!.due}
                          >
                            <AlarmClock size={12} />
                            {due.text}
                          </span>
                        ) : (
                          <span className="text-fg-4">-</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 font-mono text-[11px] text-fg-4" title={t.updatedAt}>
                        {ago(t.updatedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}
