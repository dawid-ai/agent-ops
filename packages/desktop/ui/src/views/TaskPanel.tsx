import type { LucideIcon } from 'lucide-react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  CircleDot,
  Eye,
  FileText,
  GitMerge,
  GitPullRequestArrow,
  Hand,
  History,
  ListChecks,
  MessageCircleQuestion,
  MessageSquare,
  Play,
  Reply,
  Undo2,
  UserRoundPlus,
  X,
} from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, q, refreshSoon, useData } from '../api';
import {
  Button,
  ErrorLine,
  Field,
  Input,
  PriorityIcon,
  StatusIcon,
  useAction,
  Who,
  cx,
} from '../components';
import { ago, minutes, ownerlessLabel, tokens } from '../lib/format';
import {
  dueLabel,
  identity,
  PRIORITIES,
  priorityInfo,
  STATUSES,
  statusInfo,
} from '../lib/identity';
import { renderMarkdown } from '../lib/markdown';
import { findEvent, mergeEvents, pairAnswers, writtenReducer } from '../lib/thread';
import { moveTo, shownStatus } from '../lib/transitions';
import type { OpsEvent, Status, Task, TaskDetail } from '../types';
import { Markdown } from '../ui/markdown';
import { useMover } from '../ui/move';
import type { Due } from '../ui/pickers';
import { AgentPicker, DuePicker, dueToApi, MentionArea, Menu, useDirectory } from '../ui/pickers';
import type { TaskFocus } from '../ui/refs';
import { RefText } from '../ui/refs';
import { TriageActions, waitsOn } from '../ui/triage';

type Panel = 'delegate' | 'launch' | null;

/** Types that wait for a person to turn them into work, with the shared triage actions. */
const TRIAGED = new Set(['finding', 'idea']);

export function TaskPanel({
  id,
  focus,
  nav,
  onClose,
  onBack,
  onForward,
}: {
  id: string;
  /** An event to scroll to and highlight, from an `AO-0014#<event id>` reference. */
  focus?: TaskFocus;
  nav: Nav;
  onClose: () => void;
  /** Returns to the task this one was opened from; no **Back** button without it. */
  onBack?: () => void;
  /** Returns to the task Back left; no **Forward** button without it. */
  onForward?: () => void;
}) {
  const { data, error, reload } = useData<TaskDetail>(`/api/tasks/${q(id)}`);
  const [panel, setPanel] = useState<Panel>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Events this window wrote, shown at once, until a read started after the write returns.
  const [written, dispatch] = useReducer(writtenReducer, { events: [], waiting: false });
  // useData lets only its newest request set data, so after `reload()` below the next new
  // `data` comes from a read that started after the write.
  useEffect(() => {
    if (data) dispatch({ type: 'loaded' });
  }, [data]);
  const mover = useMover(nav, setMoveError);
  const act = useAction();
  const t = data?.task;
  const events = mergeEvents(data?.events ?? [], written.events);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useFollow(scroller, events.length);
  const wrote = (res: unknown): void => {
    const evs = (res as { events?: OpsEvent[] } | undefined)?.events ?? [];
    dispatch({ type: 'wrote', events: evs });
    follow.toEnd();
    reload();
    refreshSoon();
  };
  const post = (action: string, body: Record<string, unknown> = {}) =>
    act.run(async () => {
      wrote(await api('POST', `/api/tasks/${q(id)}/${action}`, { as: nav.me, ...body }));
    });
  const open = t && !['done', 'parked'].includes(t.status);
  const waitsOnMe = t?.status === 'blocked' && !t.blockedOn && t.waitingOn === nav.me;
  const reviewsMe = t?.status === 'needs-review' && (t.reviewer === nav.me || !t.reviewer);
  const asker = waitsOnMe ? [...events].reverse().find((e) => e.type === 'ask')?.actor : undefined;

  return (
    <div
      className="animate-fade fixed inset-0 z-30 flex justify-end bg-black/35"
      onMouseDown={onClose}
    >
      <div
        className="flex h-full w-[660px] max-w-[96vw] flex-col border-l border-white/10 bg-ink-900 shadow-[-30px_0_80px_-20px_rgba(0,0,0,0.8)]"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ animation: 'rise 0.25s cubic-bezier(0.2,0.7,0.2,1) both' }}
      >
        <header className="border-b border-white/7 px-6 pt-4 pb-4">
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                type="button"
                className="-ml-1 rounded-md p-1 text-fg-3 hover:bg-white/8 hover:text-fg"
                onClick={onBack}
                aria-label="Back"
                title="Back (Alt+Left)"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            {onForward && (
              <button
                type="button"
                className={`${onBack ? '' : '-ml-1 '}rounded-md p-1 text-fg-3 hover:bg-white/8 hover:text-fg`}
                onClick={onForward}
                aria-label="Forward"
                title="Forward (Alt+Right)"
              >
                <ArrowRight size={16} />
              </button>
            )}
            <span className="font-mono text-xs text-fg-4">
              {t?.root}/{t?.id ?? id}
            </span>
            {t?.type && t.type !== 'task' && (
              <span className="rounded bg-white/6 px-1.5 text-[10px] font-semibold tracking-wider text-fg-3 uppercase">
                {t.type}
              </span>
            )}
            {t?.archived && <span className="text-xs text-fg-4">archived</span>}
            <button
              className="ml-auto rounded-md p-1 text-fg-3 hover:bg-white/8 hover:text-fg"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
          <h2 className="mt-1.5 font-display text-[22px] leading-tight font-semibold tracking-wide">
            {t ? <RefText text={t.title} /> : '…'}
          </h2>
          {t && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <StatusMenu t={t} onPick={(s) => mover.request(t, s)} />
              <Menu
                title="Priority"
                value={t.priority}
                onPick={(p) => post('priority', { priority: p })}
                items={PRIORITIES.map((p) => ({
                  value: p.key,
                  label: p.label,
                  hint: p.key,
                  icon: <PriorityIcon p={p.key} />,
                  disabled: !open,
                }))}
                trigger={() => (
                  <Pill>
                    <PriorityIcon p={t.priority} />
                    <span
                      style={{
                        color:
                          priorityInfo(t.priority).color === '#566074'
                            ? '#7f8899'
                            : priorityInfo(t.priority).color,
                      }}
                    >
                      {priorityInfo(t.priority).label}
                    </span>
                    <ChevronDown size={13} className="text-fg-4" />
                  </Pill>
                )}
              />
              {t.delegation?.due && <DueChip iso={t.delegation.due} />}
              {t.project && <Pill>{t.project}</Pill>}
              {(t.labels ?? []).map((l) => (
                <Pill key={l}>#{l}</Pill>
              ))}
            </div>
          )}
        </header>

        <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto px-6 py-5">
          <ErrorLine error={error ?? moveError ?? act.error} />
          {t && (
            <div className="panel grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-2.5 p-4 text-sm">
              <Prop icon={UserRoundPlus} label="Owner" />
              <OwnerField t={t} nav={nav} id={id} />
              {t.claimedBy && (
                <>
                  <Prop icon={Hand} label="Held by" />
                  <div className="flex items-center gap-2">
                    <Who id={t.claimedBy} />
                    {t.leaseUntil && (
                      <span className="text-xs text-fg-4">lease {ago(t.leaseUntil)}</span>
                    )}
                  </div>
                </>
              )}
              {t.reviewer && (
                <>
                  <Prop icon={Eye} label="Reviewer" />
                  <Who id={t.reviewer} />
                </>
              )}
              {(t.waitingOn || t.blockedOn) && (
                <>
                  <Prop icon={CircleDot} label="Waits on" />
                  <div>
                    {t.waitingOn ? (
                      <Who id={t.waitingOn} />
                    ) : (
                      <span className="font-mono text-xs">{t.blockedOn?.join(', ')}</span>
                    )}
                  </div>
                </>
              )}
              {t.delegation && (
                <>
                  <Prop icon={ArrowRightLeft} label="Delegated" />
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
                    <span className="inline-flex items-center gap-1">
                      by <Who id={t.delegation.by} plain />
                    </span>
                    {t.delegation.budget_minutes !== undefined && (
                      <span>· {minutes(t.delegation.budget_minutes)} budget</span>
                    )}
                    {t.delegation.tokens !== undefined && (
                      <span>· {tokens(t.delegation.tokens)} tokens</span>
                    )}
                    {t.delegation.review && (
                      <span className="inline-flex items-center gap-1">
                        · review <Who id={t.delegation.review} plain />
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {t?.checkpoint && (
            <div className="mt-3 rounded-xl border border-info/20 bg-info/6 p-3 text-sm">
              <div className="label-caps !text-info">Checkpoint · {ago(t.checkpoint.at)}</div>
              <Markdown text={t.checkpoint.summary} className="md-tight mt-1 text-fg-2" />
              {t.checkpoint.next && (
                <div className="mt-1 text-fg-3">
                  Next: <Markdown inline text={t.checkpoint.next} />
                </div>
              )}
            </div>
          )}

          {open && t && TRIAGED.has(t.type) && (
            <div className="mt-4 rounded-xl border border-warn/20 bg-warn/[0.04] p-3">
              <div className="label-caps mb-2 !text-warn">
                {t.type === 'idea' ? 'Turn this idea into work' : 'Finding to triage'}
              </div>
              <TriageActions
                key={`${t.root}/${t.id}/${t.type}`}
                task={`${t.root}/${t.id}`}
                type={t.type}
                owner={t.owner}
                priority={t.priority}
                question={t.question && waitsOn(t.waitingOn, nav.me) ? t.question : undefined}
                me={nav.me}
                onDone={() => {
                  reload();
                  follow.toEnd();
                }}
              />
            </div>
          )}

          {t && (
            <div className="mt-4 flex flex-wrap gap-2">
              {reviewsMe && (
                <>
                  <Button
                    kind="primary"
                    icon={Check}
                    onClick={() => post('verdict', { verdict: 'approve' })}
                  >
                    Approve
                  </Button>
                  <Button icon={Undo2} onClick={() => mover.request(t, 'todo')}>
                    Request changes
                  </Button>
                </>
              )}
              {open && (
                <Button
                  icon={ArrowRightLeft}
                  onClick={() => setPanel(panel === 'delegate' ? null : 'delegate')}
                >
                  Delegate
                </Button>
              )}
              {open && (
                <Button icon={Play} onClick={() => setPanel(panel === 'launch' ? null : 'launch')}>
                  Run agent
                </Button>
              )}
            </div>
          )}
          {open && panel === 'delegate' && t && (
            <DelegateForm id={id} t={t} nav={nav} onDone={() => setPanel(null)} />
          )}
          {open && panel === 'launch' && t && (
            <LaunchForm id={id} owner={t.owner ?? ''} nav={nav} onDone={() => nav.go('runs')} />
          )}

          {data?.body.trim() && (
            <>
              <h3 className="label-caps mt-6 mb-2 flex items-center gap-1.5">
                <FileText size={12} /> Description
              </h3>
              <div
                className="md text-sm text-fg-2"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(data.body) }}
              />
            </>
          )}

          <h3 className="label-caps mt-7 mb-3 flex items-center gap-1.5">
            <History size={12} /> Conversation and history
            <span className="font-normal tracking-normal text-fg-4 normal-case">
              · oldest first, newest at the bottom
            </span>
          </h3>
          <Thread events={events} focus={focus} onRun={(run) => nav.go('runs', run)} />
          {follow.unseen > 0 && (
            <button
              type="button"
              onClick={follow.toEnd}
              className="sticky bottom-2 left-full z-10 ml-auto flex items-center gap-1.5 rounded-full bg-signal px-3 py-1 text-xs font-semibold text-ink-950 shadow-lg"
            >
              <ArrowDown size={13} /> {follow.unseen} new
            </button>
          )}
        </div>

        {open && t && (
          <Composer id={id} nav={nav} answer={waitsOnMe} asker={asker} onSent={wrote} />
        )}
        {/* A question stays a conversation: an answer never takes the box away (AO-0134). */}
        {!open && t?.type === 'question' && (
          <Composer
            id={id}
            nav={nav}
            answer={false}
            reply
            owner={t.owner ?? undefined}
            onSent={wrote}
          />
        )}
      </div>
      {mover.dialog}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/10 bg-white/4 px-2.5 text-xs text-fg-2">
      {children}
    </span>
  );
}

function DueChip({ iso }: { iso: string }) {
  const d = dueLabel(iso);
  return (
    <span
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs',
        d.overdue ? 'bg-bad/15 text-bad' : d.soon ? 'bg-warn/12 text-warn' : 'bg-white/5 text-fg-2',
      )}
      title={new Date(iso).toLocaleString()}
    >
      <CalendarClock size={13} /> Due {d.text}
      {d.overdue && ' · overdue'}
    </span>
  );
}

function Prop({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="flex items-center gap-2 text-xs text-fg-3">
      <Icon size={14} className="text-fg-4" /> {label}
    </span>
  );
}

/** The status pill: a menu of every status, with the ones the protocol does not allow from here dimmed. */
function StatusMenu({ t, onPick }: { t: Task; onPick: (s: Status) => void }) {
  const cur = shownStatus(t);
  const info = statusInfo(cur);
  return (
    <Menu
      title="Status"
      value={cur === 'claimed' ? 'in-progress' : cur}
      width={280}
      onPick={(s) => onPick(s as Status)}
      items={STATUSES.filter((s) => s.key !== 'claimed').map((s) => {
        const m = moveTo(t, s.key);
        return {
          value: s.key,
          label: typeof m === 'string' ? s.label : m.label,
          icon: <StatusIcon status={s.key} />,
          hint: typeof m === 'string' && s.key !== cur ? m : undefined,
          disabled:
            typeof m === 'string' &&
            s.key !== cur &&
            !(s.key === 'in-progress' && cur === 'claimed'),
        };
      })}
      trigger={() => (
        <span
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium"
          style={{
            color: info.color,
            background: `color-mix(in oklab, ${info.color} 12%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${info.color} 30%, transparent)`,
          }}
        >
          <StatusIcon status={cur} size={13} />
          {info.label}
          {t.stale && <span className="text-warn">· stale</span>}
          <ChevronDown size={13} />
        </span>
      )}
    />
  );
}

/** The owner as a tag; picking another one reassigns the task. */
function OwnerField({ t, nav, id }: { t: Task; nav: Nav; id: string }) {
  const [editing, setEditing] = useState(false);
  const act = useAction();
  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        {ownerlessLabel(t) ? (
          <span className="text-xs text-fg-4">{ownerlessLabel(t)}</span>
        ) : (
          <Who id={t.owner} label />
        )}
        {!['done', 'parked'].includes(t.status) && (
          <button className="text-xs text-fg-4 hover:text-signal" onClick={() => setEditing(true)}>
            change
          </button>
        )}
      </div>
    );
  }
  return (
    <div>
      <AgentPicker
        value={[]}
        me={nav.me}
        autoFocus
        placeholder="New owner: agent, group or person"
        onChange={(v) => {
          if (!v[0]) return;
          act.run(
            () => api('POST', `/api/tasks/${q(id)}/assign`, { as: nav.me, to: v[0] }),
            () => {
              setEditing(false);
              refreshSoon();
            },
          );
        }}
      />
      <div className="mt-1 flex items-center gap-2">
        <button className="text-xs text-fg-4 hover:text-fg" onClick={() => setEditing(false)}>
          cancel
        </button>
        <ErrorLine error={act.error} />
      </div>
    </div>
  );
}

const EVENT_STYLE: Record<string, { icon: LucideIcon; color: string; label?: string }> = {
  comment: { icon: MessageSquare, color: '#b4bccb' },
  claim: { icon: Hand, color: '#5ce1e6' },
  start: { icon: Play, color: '#5aa9ff' },
  review: { icon: GitPullRequestArrow, color: '#b18cff', label: 'asked for review' },
  verdict: { icon: Eye, color: '#b18cff' },
  merge: { icon: GitMerge, color: '#3ddc97', label: 'merged' },
  done: { icon: Check, color: '#3ddc97' },
  delegate: { icon: ArrowRightLeft, color: '#ffc857' },
  'run-start': { icon: Bot, color: '#5ce1e6' },
  'run-end': { icon: Bot, color: '#7f8899' },
  block: { icon: CircleDot, color: '#ffb547' },
  ask: { icon: MessageCircleQuestion, color: '#ffb547', label: 'asked' },
  answer: { icon: Reply, color: '#3ddc97', label: 'answered' },
  retype: { icon: ListChecks, color: '#ffd166', label: 'changed the type' },
};

/**
 * Keeps the thread's end in view: `toEnd` scrolls there (after a send); events that arrive while
 * the reader is scrolled up count as `unseen` instead of moving the page under them.
 */
function useFollow(box: React.RefObject<HTMLDivElement | null>, count: number) {
  const [unseen, setUnseen] = useState(0);
  const last = useRef(count);
  const pinned = useRef(false);
  const toEnd = (): void => {
    pinned.current = true;
    setUnseen(0);
    requestAnimationFrame(() => {
      const el = box.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  };
  useEffect(() => {
    const before = last.current;
    last.current = count;
    // The first load is not news.
    if (before === 0 || count <= before) return;
    const el = box.current;
    const near = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 160 : true;
    if (pinned.current || near) toEnd();
    else setUnseen((n) => n + count - before);
  }, [count]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = (): void => {
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (atEnd) setUnseen(0);
      else pinned.current = false;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [box]);
  return { unseen, toEnd };
}

function Thread({
  events,
  focus,
  onRun,
}: {
  events: OpsEvent[];
  focus?: TaskFocus;
  onRun: (run: string) => void;
}) {
  const pairs = pairAnswers(events);
  const [flash, setFlash] = useState<string | null>(null);
  const jump = (id: string): void => {
    document.getElementById(`ev-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600);
  };
  // Jump to the referenced event once it has loaded, once per reference opened.
  const jumped = useRef<number | null>(null);
  const target = focus ? findEvent(events, focus.event) : undefined;
  useEffect(() => {
    if (!focus || !target || jumped.current === focus.n) return;
    jumped.current = focus.n;
    requestAnimationFrame(() => jump(target.id));
  }, [focus, target]);
  const byId = new Map(events.map((e) => [e.id, e]));
  return (
    <ol className="relative ml-3 border-l border-white/8">
      {events.map((e) => {
        const other = pairs.get(e.id);
        return (
          <EventRow
            key={e.id}
            e={e}
            onRun={onRun}
            flash={flash === e.id}
            link={
              e.type === 'answer' && other
                ? { text: `answers ${byId.get(other)?.actor ?? ''}'s question`, to: other }
                : e.type === 'ask' && other
                  ? { text: 'answered below', to: other }
                  : e.type === 'ask'
                    ? { text: 'waiting for an answer' }
                    : undefined
            }
            onJump={jump}
          />
        );
      })}
    </ol>
  );
}

function EventRow({
  e,
  onRun,
  link,
  flash,
  onJump,
}: {
  e: OpsEvent;
  onRun: (run: string) => void;
  link?: { text: string; to?: string };
  flash?: boolean;
  onJump: (id: string) => void;
}) {
  const style = EVENT_STYLE[e.type] ?? { icon: CircleDot, color: '#566074' };
  const Icon = style.icon;
  const extra =
    e.type === 'run-end'
      ? `${e.reason && e.reason !== 'exit' ? e.reason : `exit ${e.exit ?? '-'}`}${e.minutes !== undefined ? `, ${minutes(e.minutes)}` : ''}${e.tokens ? `, ${tokens(e.tokens)} tokens` : ''}`
      : e.priority
        ? priorityInfo(e.priority).label
        : e.task_type
          ? `to ${e.task_type}`
          : (e.verdict ?? e.ref ?? (e.on ? `on ${e.on.join(', ')}` : ''));
  const quiet =
    ['renew', 'progress', 'run-start', 'run-end', 'claim'].includes(e.type) && !e.body.trim();
  const said = ['comment', 'review', 'ask', 'answer', 'verdict', 'delegate', 'handoff', 'block'];
  return (
    <li id={`ev-${e.id}`} className={cx('relative pb-4 pl-6', quiet && 'pb-2.5')}>
      <span
        className="absolute top-0.5 -left-[11px] flex h-[21px] w-[21px] items-center justify-center rounded-full bg-ink-900"
        style={{ boxShadow: `0 0 0 1px color-mix(in oklab, ${style.color} 40%, transparent)` }}
      >
        <Icon size={11} color={style.color} />
      </span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <Who id={e.actor} size="xs" />
        <span className="font-medium" style={{ color: style.color }}>
          {style.label ?? e.type}
        </span>
        {extra && <span className="text-fg-3">{extra}</span>}
        {e.to && (
          <span className="inline-flex items-center gap-1 text-fg-4">
            → <Who id={e.to} size="xs" plain />
          </span>
        )}
        {e.forced && <span className="text-warn">forced</span>}
        {link &&
          (link.to ? (
            <button
              type="button"
              className="text-signal hover:underline"
              onClick={() => onJump(link.to!)}
            >
              {link.text}
            </button>
          ) : (
            <span className="text-warn">{link.text}</span>
          ))}
        {e.run && (
          <button className="text-signal hover:underline" onClick={() => onRun(e.run!)}>
            log
          </button>
        )}
        <span className="ml-auto text-fg-4" title={new Date(e.at).toLocaleString()}>
          {ago(e.at)}
        </span>
      </div>
      {e.body.trim() && (
        <div
          className={cx(
            'md mt-1.5 text-sm text-fg-2 transition-shadow',
            said.includes(e.type) ? 'rounded-lg border px-3 py-2' : '',
            e.type === 'ask'
              ? 'border-warn/25 bg-warn/[0.05]'
              : e.type === 'answer'
                ? 'border-ok/25 bg-ok/[0.05]'
                : 'border-white/7 bg-white/[0.025]',
            flash && 'shadow-[0_0_0_2px_rgba(92,225,230,0.7)]',
          )}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(e.body) }}
        />
      )}
    </li>
  );
}

const MENTION_RE = /(?:^|[^\w@])@([a-z*][a-z0-9]*:(?:[a-z][a-z0-9-]*[a-z0-9]|[a-z]|\*))/;

/**
 * The reply box at the bottom: `@` mentions, an optional agent to notify, and Ctrl+Enter, which
 * sends the highlighted button: Answer while the task waits on you, Reply on an answered
 * question, else Comment. Reply reopens the question with your text as the next round, so its
 * owner answers again.
 */
function Composer({
  id,
  nav,
  answer,
  asker,
  reply,
  owner,
  onSent,
}: {
  id: string;
  nav: Nav;
  answer: boolean;
  asker?: string;
  /** The task is an answered question: the primary button reopens it with the text. */
  reply?: boolean;
  owner?: string;
  onSent: (res: unknown) => void;
}) {
  const [text, setText] = useState('');
  const [to, setTo] = useState<string[]>([]);
  const act = useAction();
  const [uploading, setUploading] = useState(false);
  const hold = !text.trim() || act.busy || uploading;
  const others = useDirectory(nav.me).filter((e) => e.id !== nav.me && !e.group && e.configured);
  // The inbox takes one addressee per comment: the picked one, else the first @mention. Never the
  // writer: their own comment is not news to them.
  const mention = MENTION_RE.exec(text)?.[1];
  const picked = to[0] ?? mention;
  const target = picked === nav.me ? undefined : picked;
  const send = (action: 'comment' | 'answer' | 'reopen'): void => {
    if (hold) return;
    act.run(async () => {
      const res = await api('POST', `/api/tasks/${q(id)}/${action}`, {
        as: nav.me,
        message: text,
        to: action === 'comment' ? target || undefined : undefined,
      });
      setText('');
      setTo([]);
      onSent(res);
    });
  };
  const primary: 'answer' | 'comment' | 'reopen' = answer ? 'answer' : reply ? 'reopen' : 'comment';
  const kbd = (
    <kbd className="ml-1 rounded bg-black/20 px-1 font-mono text-[10px] font-normal">
      Ctrl+Enter
    </kbd>
  );
  return (
    <div className="border-t border-white/7 bg-ink-900/95 px-6 py-3">
      {answer && (
        <div className="mb-2 flex items-center gap-2 text-xs text-warn">
          <MessageCircleQuestion size={13} />
          <span>
            {asker ? <Who id={asker} size="xs" plain /> : 'An agent'} is waiting for your answer.
          </span>
        </div>
      )}
      <MentionArea
        value={text}
        onChange={setText}
        me={nav.me}
        rows={2}
        placeholder={
          answer
            ? 'Your answer. Ctrl+Enter sends it as the answer'
            : reply
              ? 'Reply. Ctrl+Enter sends it and asks again'
              : 'Comment. @ mentions an agent; Ctrl+Enter sends'
        }
        onSubmit={() => send(primary)}
        attach={{ task: id }}
        onUploading={setUploading}
      />
      <div className="mt-2 flex items-center gap-2">
        {others.length > 0 && (
          <div className="w-64" title="Puts this comment in that agent's inbox">
            <AgentPicker
              value={to}
              onChange={setTo}
              me={nav.me}
              noSelf
              placeholder="Notify an agent"
            />
          </div>
        )}
        {target && !to[0] && (
          <span className="text-xs text-fg-4">
            notifies <span style={{ color: identity(target).provider.color }}>{target}</span>
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {reply && (
            <Button
              kind="primary"
              icon={Reply}
              disabled={hold}
              onClick={() => send('reopen')}
              title={`Reopens the question with your reply, so ${owner ?? 'its owner'} answers again`}
            >
              Reply {kbd}
            </Button>
          )}
          {answer && (
            <Button
              kind="primary"
              icon={Reply}
              disabled={hold}
              onClick={() => send('answer')}
              title="Closes the question and puts the task back to todo, so the agent goes on"
            >
              Answer {kbd}
            </Button>
          )}
          <Button
            kind={primary === 'comment' ? 'primary' : 'plain'}
            icon={MessageSquare}
            disabled={hold}
            onClick={() => send('comment')}
            title={
              answer
                ? 'Adds a note; the question stays open and the task keeps waiting on you'
                : reply
                  ? 'Adds a note; the question stays closed'
                  : 'Adds a note to the task'
            }
          >
            Comment {primary === 'comment' && kbd}
          </Button>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-fg-4">
        {reply ? (
          <>
            <b className="font-semibold text-fg-3">Reply</b> reopens the question with your text as
            the next round; {owner ?? 'its owner'} answers again and the answer lands in your inbox.{' '}
            <b className="font-semibold text-fg-3">Comment</b> adds a note and keeps it closed.
          </>
        ) : answer ? (
          <>
            <b className="font-semibold text-fg-3">Answer</b> closes the question and puts the task
            back to todo, so the agent goes on. <b className="font-semibold text-fg-3">Comment</b>{' '}
            adds a note; the task keeps waiting on you.
          </>
        ) : (
          <>
            <b className="font-semibold text-fg-3">Comment</b> adds a note to the task.
            {others.length > 0 && ' Notify, or an @mention, also puts it in that inbox.'}
          </>
        )}
      </p>
      <ErrorLine error={act.error} />
    </div>
  );
}

const BUDGETS = ['30m', '1h', '2h', '4h', '8h'];

function DelegateForm({
  id,
  t,
  nav,
  onDone,
}: {
  id: string;
  t: Task;
  nav: Nav;
  onDone: () => void;
}) {
  const [to, setTo] = useState<string[]>([]);
  const [review, setReview] = useState<string[]>(t.delegation?.review ? [t.delegation.review] : []);
  const [budget, setBudget] = useState('2h');
  const [tok, setTok] = useState('');
  const [due, setDue] = useState<Due | null>(null);
  const [msg, setMsg] = useState('');
  const act = useAction();
  const sameProvider =
    to[0] &&
    review[0] &&
    !review[0].startsWith('human:') &&
    !to[0].startsWith('*:') &&
    to[0].split(':')[0] === review[0].split(':')[0];
  return (
    <div className="panel animate-rise mt-3 flex flex-col gap-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Delegate to">
          <AgentPicker
            value={to}
            onChange={setTo}
            me={nav.me}
            placeholder="Agent, group or person"
            autoFocus
          />
        </Field>
        <Field
          label="Reviewer"
          hint={
            sameProvider ? (
              <span className="text-warn">Pick another provider than the delegate</span>
            ) : undefined
          }
        >
          <AgentPicker
            value={review}
            onChange={setReview}
            me={nav.me}
            noGroups
            placeholder="Who reviews"
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Budget">
          <div className="flex items-center gap-1">
            {BUDGETS.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBudget(b)}
                className={cx(
                  'h-[34px] rounded-lg px-2.5 font-mono text-xs transition',
                  budget === b
                    ? 'bg-signal/15 text-signal ring-1 ring-signal/40'
                    : 'bg-white/5 text-fg-3 hover:bg-white/10',
                )}
              >
                {b}
              </button>
            ))}
            <Input
              value={BUDGETS.includes(budget) ? '' : budget}
              onChange={setBudget}
              placeholder="other"
              className="w-20"
            />
          </div>
        </Field>
        <Field label="Tokens">
          <Input value={tok} onChange={setTok} placeholder="400k" className="w-24" />
        </Field>
        <Field label="Due">
          <DuePicker value={due} onChange={setDue} />
        </Field>
      </div>
      <Field label="Note">
        <MentionArea
          value={msg}
          onChange={setMsg}
          me={nav.me}
          rows={2}
          placeholder="What to do, what done means"
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          kind="primary"
          icon={ArrowRightLeft}
          disabled={!to[0] || act.busy}
          onClick={() =>
            act.run(
              () =>
                api('POST', `/api/tasks/${q(id)}/delegate`, {
                  as: nav.me,
                  to: to[0],
                  budget: budget || undefined,
                  tokens: tok || undefined,
                  due: dueToApi(due) || undefined,
                  review: review[0] || undefined,
                  message: msg,
                }),
              () => {
                refreshSoon();
                onDone();
              },
            )
          }
        >
          Delegate
        </Button>
        <Button kind="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorLine error={act.error} />
    </div>
  );
}

function LaunchForm({
  id,
  owner,
  nav,
  onDone,
}: {
  id: string;
  owner: string;
  nav: Nav;
  onDone: () => void;
}) {
  const [agent, setAgent] = useState<string[]>(
    owner && !owner.includes('*') && !owner.startsWith('human:') ? [owner] : [],
  );
  const [budget, setBudget] = useState('');
  const act = useAction();
  return (
    <div className="panel animate-rise mt-3 flex items-end gap-3 p-4">
      <Field label="Agent" className="flex-1">
        <AgentPicker
          value={agent}
          onChange={setAgent}
          me={nav.me}
          noGroups
          runnable
          placeholder="Who runs it"
          autoFocus
        />
      </Field>
      <Field label="Budget">
        <Input value={budget} onChange={setBudget} placeholder="2h" className="w-20" />
      </Field>
      <Button
        kind="primary"
        icon={Play}
        disabled={!agent[0] || act.busy}
        onClick={() =>
          act.run(
            () =>
              api('POST', '/api/runs', { agent: agent[0], task: id, budget: budget || undefined }),
            onDone,
          )
        }
      >
        Start run
      </Button>
      <ErrorLine error={act.error} />
    </div>
  );
}
