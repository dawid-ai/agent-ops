import { CalendarClock, Clock, Pause, Pencil, Play, Plus, Repeat, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { ago } from '../lib/format';
import { identity } from '../lib/identity';
import type { Schedule } from '../types';
import { AgentPicker } from '../ui/pickers';
import { RefText } from '../ui/refs';

interface Draft {
  previous?: string;
  name: string;
  agent: string[];
  mode: 'every' | 'at';
  every: string;
  at: string;
  prompt: string;
  task: string;
  paused: boolean;
}

const BLANK: Draft = {
  name: '',
  agent: [],
  mode: 'at',
  every: '1h',
  at: '09:00',
  prompt: '',
  task: '',
  paused: false,
};

/** Starting points; the prompt is added to the standard work prompt. */
const TEMPLATES: Array<{ title: string; hint: string; draft: Partial<Draft> }> = [
  {
    title: 'Daily standup',
    hint: 'Each morning an agent posts done, next and blocked to #standup',
    draft: {
      name: 'daily-standup',
      mode: 'at',
      at: '09:00',
      prompt:
        'Post a short standup to #standup with `ops channel post standup`: what you finished since your last standup, what you do next, and what blocks you. Then stop.',
    },
  },
  {
    title: 'Inbox sweep',
    hint: 'Every hour an agent answers what waits in its inbox',
    draft: {
      name: 'inbox-sweep',
      mode: 'every',
      every: '1h',
      prompt: 'Handle your inbox: answer questions and reviews addressed to you, then stop.',
    },
  },
  {
    title: 'Nightly QA pass',
    hint: 'At night a QA agent reviews what landed during the day',
    draft: {
      name: 'nightly-qa',
      mode: 'at',
      at: '23:00',
      prompt:
        'Review the work that went to needs-review or done today. File findings with `ops finding` for anything wrong. Then stop.',
    },
  },
];

const EVERY = ['15m', '30m', '1h', '2h', '6h', '12h', '24h'];
const AT = ['07:00', '09:00', '12:00', '17:00', '23:00'];

function cadence(s: Pick<Schedule, 'every' | 'at'>): string {
  return s.every ? `Every ${s.every}` : `Daily at ${s.at}`;
}

/** Recurring agent runs (opsd's cron): standups, inbox sweeps, nightly passes. */
export function Schedules({ nav, selected }: { nav: Nav; selected?: string }) {
  const { data, error } = useData<Schedule[]>('/api/schedules');
  const [draft, setDraft] = useState<Draft | null>(null);
  const act = useAction();
  useEffect(() => {
    // "Schedule agent standups" from the Standups view opens the standup template.
    if (selected === 'standup') setDraft({ ...BLANK, ...TEMPLATES[0]!.draft });
  }, [selected]);
  const run = (path: string, after?: () => void) =>
    act.run(
      () => api('POST', path, {}),
      () => {
        refreshSoon();
        after?.();
      },
    );
  return (
    <Section
      title="Schedules"
      icon={CalendarClock}
      subtitle="opsd starts these runs on time, under the same limits as every other run"
      actions={
        <Button kind="primary" icon={Plus} onClick={() => setDraft({ ...BLANK })}>
          New schedule
        </Button>
      }
    >
      <div className="flex flex-col gap-4 p-6">
        <ErrorLine error={error ?? act.error} />
        {data && data.length === 0 && (
          <Empty icon={CalendarClock} title="No schedules yet">
            A schedule starts an agent run every so often or at a time each day: a standup, an inbox
            sweep, a nightly review. They live in your user config under <code>opsd.schedules</code>
            .
          </Empty>
        )}
        {data && data.length === 0 && (
          <div className="mx-auto grid max-w-3xl grid-cols-1 gap-3 md:grid-cols-3">
            {TEMPLATES.map((t) => (
              <button
                key={t.title}
                onClick={() => setDraft({ ...BLANK, ...t.draft })}
                className="panel group p-4 text-left transition hover:-translate-y-0.5 hover:border-signal/40"
              >
                <Repeat size={18} className="text-signal" />
                <div className="mt-2 font-display font-semibold tracking-wide">{t.title}</div>
                <div className="mt-1 text-xs text-fg-3">{t.hint}</div>
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {(data ?? []).map((s, i) => (
            <div
              key={s.name}
              className={cx('panel animate-rise flex flex-col gap-3 p-4', s.paused && 'opacity-60')}
              style={{
                animationDelay: `${i * 40}ms`,
                borderLeft: `3px solid ${identity(s.agent).provider.color}`,
              }}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0">
                  <div className="font-display text-base font-semibold tracking-wide">
                    <RefText text={s.name} />
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-3">
                    <Clock size={12} /> {cadence(s)}
                    {s.task && (
                      <span className="font-mono text-fg-4">
                        · <RefText text={s.task} />
                      </span>
                    )}
                  </div>
                </div>
                <div className="ml-auto">
                  <Who id={s.agent} />
                </div>
              </div>
              {s.prompt && (
                <div className="line-clamp-2 text-sm text-fg-2">
                  <RefText text={s.prompt} />
                </div>
              )}
              <div className="flex items-center gap-4 text-xs text-fg-3">
                <span>
                  Last run:{' '}
                  <span className="text-fg-2">{s.last_run ? ago(s.last_run) : 'never'}</span>
                </span>
                <span>
                  Next:{' '}
                  <span className={s.paused ? 'text-warn' : 'text-signal'}>
                    {s.paused
                      ? 'paused'
                      : s.next_run && Date.parse(s.next_run) <= Date.now() + 60_000
                        ? 'next tick'
                        : ago(s.next_run)}
                  </span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  icon={Play}
                  disabled={act.busy}
                  onClick={() => run(`/api/schedules/${q(s.name)}/run`, () => nav.go('runs'))}
                >
                  Run now
                </Button>
                <Button
                  size="sm"
                  icon={s.paused ? Play : Pause}
                  disabled={act.busy}
                  onClick={() =>
                    act.run(
                      () =>
                        api('POST', '/api/schedules', {
                          ...s,
                          previous: s.name,
                          paused: !s.paused,
                        }),
                      refreshSoon,
                    )
                  }
                >
                  {s.paused ? 'Resume' : 'Pause'}
                </Button>
                <Button
                  size="sm"
                  icon={Pencil}
                  onClick={() =>
                    setDraft({
                      previous: s.name,
                      name: s.name,
                      agent: [s.agent],
                      mode: s.every ? 'every' : 'at',
                      every: s.every ?? '1h',
                      at: s.at ?? '09:00',
                      prompt: s.prompt ?? '',
                      task: s.task ?? '',
                      paused: Boolean(s.paused),
                    })
                  }
                >
                  Edit
                </Button>
                <DeleteButton onDelete={() => run(`/api/schedules/${q(s.name)}/delete`)} />
              </div>
            </div>
          ))}
        </div>
      </div>
      {draft && <ScheduleForm nav={nav} draft={draft} onClose={() => setDraft(null)} />}
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

function ScheduleForm({ nav, draft, onClose }: { nav: Nav; draft: Draft; onClose: () => void }) {
  const [d, setD] = useState<Draft>(draft);
  const act = useAction();
  const set = (patch: Partial<Draft>): void => setD((x) => ({ ...x, ...patch }));
  const nameOk = /^[a-z][a-z0-9-]{0,39}$/.test(d.name);
  const save = (): void =>
    act.run(
      () =>
        api('POST', '/api/schedules', {
          previous: d.previous,
          name: d.name,
          agent: d.agent[0],
          every: d.mode === 'every' ? d.every : undefined,
          at: d.mode === 'at' ? d.at : undefined,
          prompt: d.prompt || undefined,
          task: d.task || undefined,
          paused: d.paused,
        }),
      () => {
        refreshSoon();
        onClose();
      },
    );
  return (
    <Modal
      title={d.previous ? `Edit ${d.previous}` : 'New schedule'}
      icon={CalendarClock}
      onClose={onClose}
      width={600}
    >
      <div className="flex flex-col gap-4">
        {!d.previous && (
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATES.map((t) => (
              <button
                key={t.title}
                type="button"
                onClick={() => set(t.draft)}
                className="rounded-md bg-white/5 px-2 py-1 text-xs text-fg-2 hover:bg-white/10 hover:text-fg"
              >
                {t.title}
              </button>
            ))}
          </div>
        )}
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
              placeholder="daily-standup"
              autoFocus
            />
          </Field>
          <Field label="Agent">
            <AgentPicker
              value={d.agent}
              onChange={(v) => set({ agent: v })}
              me={nav.me}
              noGroups
              runnable
              placeholder="Who runs"
            />
          </Field>
        </div>
        <Field label="When">
          <div className="flex flex-col gap-2">
            <div className="flex w-fit rounded-lg bg-white/5 p-0.5">
              {(
                [
                  ['at', 'Daily at a time'],
                  ['every', 'Every interval'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => set({ mode: m })}
                  className={cx(
                    'rounded-md px-3 py-1 text-xs',
                    d.mode === m ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {(d.mode === 'at' ? AT : EVERY).map((v) => {
                const on = d.mode === 'at' ? d.at === v : d.every === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => set(d.mode === 'at' ? { at: v } : { every: v })}
                    className={cx(
                      'h-8 rounded-lg px-2.5 font-mono text-xs',
                      on
                        ? 'bg-signal/15 text-signal ring-1 ring-signal/40'
                        : 'bg-white/5 text-fg-3 hover:bg-white/10',
                    )}
                  >
                    {v}
                  </button>
                );
              })}
              {d.mode === 'at' ? (
                <input
                  type="time"
                  value={d.at}
                  onChange={(e) => set({ at: e.target.value })}
                  className="h-8 rounded-lg border border-white/10 bg-ink-950/60 px-2 font-mono text-xs"
                />
              ) : (
                <Input
                  value={EVERY.includes(d.every) ? '' : d.every}
                  onChange={(v) => set({ every: v })}
                  placeholder="45m"
                  className="!h-8 w-20"
                />
              )}
            </div>
          </div>
        </Field>
        <Field
          label="Prompt"
          hint="Added to the standard prompt that tells the agent to work its queue"
        >
          <TextArea
            value={d.prompt}
            onChange={(v) => set({ prompt: v })}
            rows={4}
            placeholder="What the agent does on each run"
          />
        </Field>
        <div className="flex items-end gap-4">
          <Field label="Task (optional)" className="w-48">
            <Input value={d.task} onChange={(v) => set({ task: v })} placeholder="AO-0012" />
          </Field>
          <Toggle checked={d.paused} onChange={(v) => set({ paused: v })} label="Paused" />
        </div>
        <ErrorLine error={act.error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!nameOk || !d.agent[0] || act.busy} onClick={save}>
            {d.previous ? 'Save' : 'Add schedule'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
