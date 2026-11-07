import {
  CalendarClock,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat as RepeatIcon,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { Nav } from '../App';
import { api, q, refreshSoon, useData } from '../api';
import {
  Button,
  Empty,
  ErrorLine,
  Field,
  Input,
  Modal,
  Section,
  TextArea,
  Toggle,
  useAction,
  Who,
  cx,
} from '../components';
import type { Repeat } from '../types';
import { Markdown } from '../ui/markdown';
import { AgentPicker } from '../ui/pickers';
import { RefText } from '../ui/refs';

type Mode = 'once' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'yearly' | 'condition';

export interface RepeatDraft {
  /** Set when editing: the name can't change. */
  editing?: boolean;
  /** Set when editing: the root the repeat lives in, so the save targets that definition. */
  root?: string;
  /** Set when editing: the card title, `root/name` when another root uses the name. */
  label?: string;
  /** Fields the form does not show; an edit sends them back unchanged. */
  kept?: Pick<Repeat['meta'], 'type' | 'project' | 'parent' | 'labels'>;
  name: string;
  title: string;
  owner: string[];
  priority: string;
  mode: Mode;
  /** `YYYY-MM-DDTHH:MM`, as a datetime-local input writes it. */
  start: string;
  days: string[];
  condKind: 'closed' | 'children-closed';
  condTask: string;
  until: string;
  count: string;
  body: string;
  paused: boolean;
}

const MODES: Array<[Mode, string]> = [
  ['once', 'Once'],
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['weekdays', 'Chosen days'],
  ['monthly', 'Monthly'],
  ['yearly', 'Yearly'],
  ['condition', 'When a task closes'],
];

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function tomorrowAt9(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
}

export function blankDraft(): RepeatDraft {
  return {
    name: '',
    title: '',
    owner: [],
    priority: 'p2',
    mode: 'weekly',
    start: tomorrowAt9(),
    days: ['mon', 'thu'],
    condKind: 'closed',
    condTask: '',
    until: '',
    count: '',
    body: '',
    paused: false,
  };
}

export function draftOf(r: Repeat): RepeatDraft {
  const m = r.meta;
  const [kind, task] = (m.when ?? '').split(/\s+/);
  return {
    editing: true,
    root: r.root,
    kept: { type: m.type, project: m.project, parent: m.parent, labels: m.labels },
    name: m.name,
    title: m.title,
    owner: m.owner ? [m.owner] : [],
    priority: m.priority ?? 'p2',
    mode: m.when ? 'condition' : (m.repeat ?? 'once'),
    start: m.start ?? (m.when ? '' : tomorrowAt9()),
    days: m.days ?? ['mon', 'thu'],
    condKind: kind === 'children-closed' ? 'children-closed' : 'closed',
    condTask: task ?? '',
    until: m.until ?? '',
    count: m.count ? String(m.count) : '',
    body: r.body,
    paused: Boolean(m.paused),
  };
}

/** `root/name`: names one repeat even when two roots use the same name. */
export function repeatRef(r: Repeat): string {
  return `${r.root}/${r.meta.name}`;
}

/**
 * Card titles: `name`, or `root/name` for a name that more than one root uses, so two repeats with
 * the same name and definition can be told apart before a run, pause, edit or delete.
 */
export function repeatLabels(all: Repeat[]): Map<Repeat, string> {
  const count = new Map<string, number>();
  for (const r of all) count.set(r.meta.name, (count.get(r.meta.name) ?? 0) + 1);
  return new Map(
    all.map((r) => [r, (count.get(r.meta.name) ?? 0) > 1 ? repeatRef(r) : r.meta.name]),
  );
}

/** The body `POST /api/repeats` takes for a draft. */
export function repeatBody(d: RepeatDraft): Record<string, unknown> {
  const condition = d.mode === 'condition';
  return {
    ...d.kept,
    replace: Boolean(d.editing),
    root: d.root,
    name: d.name,
    title: d.title,
    owner: d.owner[0] || undefined,
    priority: d.priority,
    start: d.start || undefined,
    repeat: condition ? undefined : d.mode,
    days: d.mode === 'weekdays' ? d.days : undefined,
    when: condition ? `${d.condKind} ${d.condTask.trim()}` : undefined,
    until: d.until || undefined,
    count: d.count ? Number(d.count) : undefined,
    body: d.body,
    paused: d.paused,
  };
}

const STATE_TONE: Record<Repeat['state'], string> = {
  active: 'text-signal',
  waiting: 'text-warn',
  paused: 'text-warn',
  finished: 'text-fg-3',
  broken: 'text-bad',
};

/** Repeating tasks: templates that create a task on a date, on a rule, or when a task closes. */
export function Repeating({ nav }: { nav: Nav }) {
  const { data, error } = useData<Repeat[]>('/api/repeats');
  const [draft, setDraft] = useState<RepeatDraft | null>(null);
  const act = useAction();
  const labels = repeatLabels(data ?? []);
  const post = (path: string, after?: () => void) =>
    act.run(
      () => api('POST', path, {}),
      () => {
        refreshSoon();
        after?.();
      },
    );
  return (
    <Section
      title="Repeating"
      icon={RepeatIcon}
      subtitle="opsd creates these tasks on time; a repeat waits while its last task is open"
      actions={
        <Button kind="primary" icon={Plus} onClick={() => setDraft(blankDraft())}>
          New repeating task
        </Button>
      }
    >
      <div className="flex flex-col gap-4 p-6">
        <ErrorLine error={error ?? act.error} />
        {data && data.length === 0 && (
          <Empty icon={RepeatIcon} title="No repeating tasks yet">
            A repeating task creates a task from a template once, every day, week, month or year, on
            chosen weekdays, or when a task closes. They live in the task store under{' '}
            <code>repeats/</code>.
          </Empty>
        )}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {(data ?? []).map((r, i) => (
            <div
              key={`${r.root}/${r.meta.name}`}
              className={cx(
                'panel animate-rise flex flex-col gap-3 p-4',
                (r.state === 'paused' || r.state === 'finished') && 'opacity-60',
              )}
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0">
                  <div className="font-display text-base font-semibold tracking-wide">
                    {labels.get(r)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-3">
                    <CalendarClock size={12} /> <RefText text={r.rule || '-'} />
                  </div>
                </div>
                {r.meta.owner && (
                  <div className="ml-auto">
                    <Who id={r.meta.owner} />
                  </div>
                )}
              </div>
              <div className="text-sm text-fg-2">
                <RefText text={r.meta.title} />
              </div>
              {r.body.trim() && (
                <Markdown text={r.body} clamp lines={3} className="text-sm text-fg-3" />
              )}
              {r.note && (
                <div className="text-xs text-warn">
                  <RefText text={r.note} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-4 text-xs text-fg-3">
                <span>
                  State: <span className={STATE_TONE[r.state]}>{r.state}</span>
                </span>
                {r.next && r.state !== 'paused' && (
                  <span>
                    Next: <span className="text-fg-2">{r.next.replace('T', ' ')}</span>
                  </span>
                )}
                <span>
                  Created: <span className="text-fg-2">{r.fired}</span>
                  {r.last && (
                    <span className="font-mono text-fg-4">
                      {' '}
                      · last <RefText text={r.last.id} />
                    </span>
                  )}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  icon={Play}
                  disabled={act.busy}
                  onClick={() => post(`/api/repeats/${q(repeatRef(r))}/run`)}
                >
                  Run now
                </Button>
                <Button
                  size="sm"
                  icon={r.meta.paused ? Play : Pause}
                  disabled={act.busy}
                  onClick={() =>
                    post(`/api/repeats/${q(repeatRef(r))}/${r.meta.paused ? 'resume' : 'pause'}`)
                  }
                >
                  {r.meta.paused ? 'Resume' : 'Pause'}
                </Button>
                <Button
                  size="sm"
                  icon={Pencil}
                  onClick={() => setDraft({ ...draftOf(r), label: labels.get(r) })}
                >
                  Edit
                </Button>
                <DeleteButton onDelete={() => post(`/api/repeats/${q(repeatRef(r))}/delete`)} />
              </div>
            </div>
          ))}
        </div>
      </div>
      {draft && <RepeatForm nav={nav} draft={draft} onClose={() => setDraft(null)} />}
    </Section>
  );
}

function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [sure, setSure] = useState(false);
  if (sure) {
    return (
      <span className="inline-flex items-center gap-1">
        <Button size="sm" kind="danger" onClick={onDelete}>
          Delete for good
        </Button>
        <Button size="sm" kind="ghost" onClick={() => setSure(false)}>
          Keep
        </Button>
      </span>
    );
  }
  return (
    <Button size="sm" kind="ghost" icon={Trash2} onClick={() => setSure(true)}>
      Delete
    </Button>
  );
}

function RepeatForm({
  nav,
  draft,
  onClose,
}: {
  nav: Nav;
  draft: RepeatDraft;
  onClose: () => void;
}) {
  const [d, setD] = useState<RepeatDraft>(draft);
  const act = useAction();
  const set = (patch: Partial<RepeatDraft>): void => setD((x) => ({ ...x, ...patch }));
  const nameOk = /^[a-z0-9][a-z0-9-]{0,59}$/.test(d.name);
  const condition = d.mode === 'condition';
  const ready =
    nameOk &&
    d.title.trim() !== '' &&
    (condition ? d.condTask.trim() !== '' : d.start !== '') &&
    (d.mode !== 'weekdays' || d.days.length > 0);
  const save = (): void =>
    act.run(
      () => api('POST', '/api/repeats', repeatBody(d)),
      () => {
        refreshSoon();
        onClose();
      },
    );
  return (
    <Modal
      title={d.editing ? `Edit ${d.label ?? d.name}` : 'New repeating task'}
      icon={RepeatIcon}
      onClose={onClose}
      width={640}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Name"
            hint={
              d.name && !nameOk ? (
                <span className="text-warn">Lowercase letters, digits and hyphens</span>
              ) : undefined
            }
          >
            <Input
              value={d.name}
              onChange={(v) => set({ name: v })}
              placeholder="weekly-report"
              disabled={d.editing}
              autoFocus={!d.editing}
            />
          </Field>
          <Field label="Owner">
            <AgentPicker
              value={d.owner}
              onChange={(v) => set({ owner: v })}
              me={nav.me}
              placeholder="Anyone"
            />
          </Field>
        </div>
        <Field label="Task title" hint="{date} becomes the date of each run">
          <Input
            value={d.title}
            onChange={(v) => set({ title: v })}
            placeholder="Weekly report {date}"
          />
        </Field>
        <Field label="Repeat">
          <div className="flex flex-wrap gap-1">
            {MODES.map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => set({ mode: m })}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs',
                  d.mode === m ? 'bg-signal/15 text-signal' : 'bg-white/5 text-fg-3 hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        {condition ? (
          <div className="flex items-end gap-3">
            <Field label="When" className="w-56">
              <div className="flex w-fit rounded-lg bg-white/5 p-0.5">
                {(
                  [
                    ['closed', 'Task closes'],
                    ['children-closed', 'All subtasks close'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => set({ condKind: k })}
                    className={cx(
                      'rounded-md px-2.5 py-1 text-xs',
                      d.condKind === k ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Task" className="w-40">
              <Input
                value={d.condTask}
                onChange={(v) => set({ condTask: v })}
                placeholder="AO-0012"
              />
            </Field>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Field
              label={d.mode === 'once' ? 'Date and time' : 'First run'}
              hint="Local time on the PC that runs opsd"
            >
              <input
                type="datetime-local"
                value={d.start}
                onChange={(e) => set({ start: e.target.value })}
                className="h-[34px] w-60 rounded-lg border border-white/10 bg-ink-950/60 px-2 font-mono text-xs"
              />
            </Field>
            {d.mode === 'weekdays' && (
              <div className="flex gap-1">
                {DAYS.map((day) => {
                  const on = d.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        set({ days: on ? d.days.filter((x) => x !== day) : [...d.days, day] })
                      }
                      className={cx(
                        'h-8 w-11 rounded-lg font-mono text-xs capitalize',
                        on
                          ? 'bg-signal/15 text-signal ring-1 ring-signal/40'
                          : 'bg-white/5 text-fg-3 hover:bg-white/10',
                      )}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {d.mode !== 'once' && (
          <div className="flex items-end gap-3">
            <Field label="Until (optional)" className="w-44">
              <input
                type="date"
                value={d.until}
                onChange={(e) => set({ until: e.target.value })}
                className="h-[34px] rounded-lg border border-white/10 bg-ink-950/60 px-2 font-mono text-xs"
              />
            </Field>
            <Field label="At most (optional)" className="w-36">
              <Input
                value={d.count}
                onChange={(v) => set({ count: v.replace(/\D/g, '') })}
                placeholder="10 tasks"
              />
            </Field>
          </div>
        )}
        <Field label="Task description">
          <TextArea
            value={d.body}
            onChange={(v) => set({ body: v })}
            rows={4}
            placeholder="What each task asks for"
          />
        </Field>
        <div className="flex items-end gap-4">
          <Field label="Priority" className="w-28">
            <Input value={d.priority} onChange={(v) => set({ priority: v })} placeholder="p2" />
          </Field>
          <Toggle checked={d.paused} onChange={(v) => set({ paused: v })} label="Paused" />
        </div>
        <ErrorLine error={act.error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!ready || act.busy} onClick={save}>
            {d.editing ? 'Save' : 'Add repeating task'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
