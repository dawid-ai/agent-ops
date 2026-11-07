import type { LucideIcon } from 'lucide-react';
import {
  ArrowUpRight,
  AtSign,
  Check,
  CheckCheck,
  CircleCheckBig,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Inbox as InboxIcon,
  MessageCircleQuestion,
  MessageSquare,
  PenLine,
  Radar,
  ScanEye,
  Send,
  UserCheck,
  UserX,
  Vote,
} from 'lucide-react';
import { useState } from 'react';
import type { Nav } from '../App';
import { api, q, refreshSoon } from '../api';
import {
  Button,
  Empty,
  ErrorLine,
  Section,
  StatusTag,
  toast,
  useAction,
  Who,
  cx,
} from '../components';
import { ago } from '../lib/format';
import type { InboxItem } from '../types';
import { Markdown } from '../ui/markdown';
import { MentionArea } from '../ui/pickers';
import { RefText } from '../ui/refs';
import { TriageActions } from '../ui/triage';

interface Group {
  key: string;
  title: string;
  hint: string;
  kinds: InboxItem['kind'][];
  icon: LucideIcon;
  color: string;
}

const GROUPS: Group[] = [
  {
    key: 'ask',
    title: 'Needs your answer',
    hint: 'An agent is blocked on a question to you; it stays until you answer.',
    kinds: ['ask'],
    icon: MessageCircleQuestion,
    color: '#ffb547',
  },
  {
    key: 'stranded',
    title: 'Waiting on no agent',
    hint: 'Owned by, or waiting for, an id no configured agent answers to. Reassign it, or add the agent.',
    kinds: ['stranded'],
    icon: UserX,
    color: '#ff6b6b',
  },
  {
    key: 'triage',
    title: 'Findings to triage',
    hint: 'Filed by agents outside their task; the Findings view lists the same.',
    kinds: ['triage'],
    icon: Radar,
    color: '#ff8a5c',
  },
  {
    key: 'review',
    title: 'Reviews for you',
    hint: 'Work handed to you for a verdict.',
    kinds: ['review'],
    icon: ScanEye,
    color: '#b18cff',
  },
  {
    key: 'decide',
    title: 'Decisions',
    hint: 'Votes you are listed on, and ties or results to record.',
    kinds: ['decide', 'vote'],
    icon: Vote,
    color: '#5ce1e6',
  },
  {
    key: 'owned',
    title: 'Assigned to you',
    hint: 'Tasks delegated to you or yours, to do or in progress.',
    kinds: ['owned'],
    icon: UserCheck,
    color: '#5aa9ff',
  },
  {
    key: 'mention',
    title: 'Mentions and messages',
    hint: 'Unread notes addressed to you in tasks and channels, and answers to your questions.',
    kinds: ['mention', 'message'],
    icon: AtSign,
    color: '#ffc857',
  },
];

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  ask: 'Question',
  review: 'Review',
  triage: 'Finding',
  decide: 'Decide',
  vote: 'Vote',
  mention: 'Mention',
  message: 'Message',
  owned: 'Assigned',
  stranded: 'No agent',
};

export function Inbox({
  nav,
  items,
  error,
}: {
  nav: Nav;
  items?: InboxItem[];
  error: string | null;
}) {
  const markRead = useAction();
  const groups = GROUPS.map((g) => ({
    g,
    list: (items ?? []).filter((it) => g.kinds.includes(it.kind)),
  }));
  const unread = (items ?? []).some((it) => it.kind === 'mention' || it.kind === 'message');
  return (
    <Section
      title="Inbox"
      icon={InboxIcon}
      subtitle="Questions to you, findings to triage, reviews and votes waiting on you, tasks delegated to you, and mentions."
      actions={
        <>
          <Button
            icon={MessageSquare}
            kind="plain"
            title="One conversation with the project's PM; an answer never closes it"
            onClick={() => nav.go('chat')}
          >
            Chat with the PM
          </Button>
          <Button
            icon={CheckCheck}
            kind={unread ? 'plain' : 'ghost'}
            disabled={!nav.me || markRead.busy}
            title="Clears mentions and messages; questions, findings, reviews and tasks stay until handled"
            onClick={() =>
              markRead.run(() => api('GET', `/api/inbox?as=${q(nav.me!)}&markRead=1`), refreshSoon)
            }
          >
            Mark messages read
          </Button>
        </>
      }
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-6 py-5">
        <ErrorLine error={error} />
        <ErrorLine error={markRead.error} />
        {!nav.me && (
          <ErrorLine error="Set `me: human:<name>` in the user config so the app knows who you are." />
        )}

        {items && items.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {groups.map(({ g, list }) => {
              const Icon = g.icon;
              const has = list.length > 0;
              return (
                <a
                  key={g.key}
                  href={`#inbox-${g.key}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document
                      .getElementById(`inbox-${g.key}`)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className={cx(
                    'panel group flex items-center gap-2.5 px-3 py-2.5 transition',
                    has ? 'hover:border-white/20' : 'pointer-events-none opacity-45',
                  )}
                  style={
                    has
                      ? {
                          boxShadow: `inset 0 -2px 0 color-mix(in oklab, ${g.color} 55%, transparent)`,
                        }
                      : undefined
                  }
                >
                  <Icon size={16} color={has ? g.color : '#566074'} strokeWidth={2.1} />
                  <span className="min-w-0 flex-1 truncate text-xs text-fg-3 group-hover:text-fg-2">
                    {g.title}
                  </span>
                  <span
                    className="font-display text-lg leading-none font-semibold"
                    style={{ color: has ? g.color : undefined }}
                  >
                    {list.length}
                  </span>
                </a>
              );
            })}
          </div>
        )}

        {items && items.length === 0 && (
          <Empty icon={CircleCheckBig} title="Inbox zero">
            Nothing waits for you. Questions to you, reviews, votes, tasks delegated to you, and
            mentions land here as they come in. To talk something through, use Chat with the PM.
          </Empty>
        )}

        {groups.map(
          ({ g, list }) =>
            list.length > 0 && (
              <section key={g.key} id={`inbox-${g.key}`} className="scroll-mt-4">
                <GroupHeader g={g} count={list.length} />
                <div className="flex flex-col gap-2">
                  {list.map((it, i) => (
                    <Item
                      key={`${it.kind}:${it.task}:${it.event ?? ''}`}
                      it={it}
                      g={g}
                      nav={nav}
                      delay={Math.min(i * 30, 300)}
                    />
                  ))}
                </div>
              </section>
            ),
        )}
      </div>
    </Section>
  );
}

/**
 * The latest review request: who asked and when, its text, and the PR, commit and branch it names,
 * so the item says what to check rather than only that a review waits.
 */
export function ReviewRequest({ it }: { it: InboxItem }) {
  const [full, setFull] = useState(false);
  const text = full && it.detail ? it.detail : it.summary;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {it.from && (
        <div className="flex items-center gap-1.5 text-xs text-fg-4">
          <Who id={it.from} label size="xs" />
          <span>asks for your review{it.at ? `, ${ago(it.at)}` : ''}</span>
        </div>
      )}
      {/* The first line until expanded; a click on it, or the button below, shows all of it. */}
      <div
        className={cx('text-sm text-fg-3', it.detail && 'cursor-pointer')}
        data-review-text
        onClick={(e) => {
          if (!it.detail || (e.target as Element).closest('a, button, img')) return;
          if (window.getSelection?.()?.toString()) return;
          setFull((f) => !f);
        }}
      >
        <Markdown text={text} className="md-tight" />
      </div>
      {(it.detail || it.pr || it.commit || it.branch) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {it.pr && (
            <a
              href={it.pr}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-signal hover:bg-white/10"
            >
              <GitPullRequest size={12} /> {prLabel(it.pr)}
            </a>
          )}
          {it.commit && (
            <span className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 font-mono text-fg-3">
              <GitCommitHorizontal size={12} /> {it.commit.slice(0, 7)}
            </span>
          )}
          {it.branch && (
            <span className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 font-mono text-fg-3">
              <GitBranch size={12} /> {it.branch}
            </span>
          )}
          {it.detail && (
            <button
              type="button"
              className="text-fg-4 hover:text-fg"
              onClick={() => setFull((f) => !f)}
            >
              {full ? 'Show less' : 'Show the whole request'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** `PR #68` for a GitHub pull request URL, `MR !12` for GitLab, else the URL. */
export function prLabel(url: string): string {
  const m = /\/(pull|merge_requests)\/(\d+)/.exec(url);
  if (!m) return url;
  return m[1] === 'pull' ? `PR #${m[2]}` : `MR !${m[2]}`;
}

function GroupHeader({ g, count }: { g: Group; count: number }) {
  const Icon = g.icon;
  return (
    <div className="mb-2 flex items-center gap-2.5">
      <span
        className="flex h-6 w-6 items-center justify-center rounded-lg"
        style={{
          background: `color-mix(in oklab, ${g.color} 14%, transparent)`,
          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${g.color} 32%, transparent)`,
        }}
      >
        <Icon size={13} color={g.color} strokeWidth={2.3} />
      </span>
      <h2 className="font-display text-sm font-semibold tracking-wide text-fg">{g.title}</h2>
      <span
        className="rounded-full px-1.5 font-mono text-[11px]"
        style={{ color: g.color, background: `color-mix(in oklab, ${g.color} 12%, transparent)` }}
      >
        {count}
      </span>
      <span className="truncate text-xs text-fg-4">{g.hint}</span>
      <div className="ml-2 h-px flex-1 bg-gradient-to-r from-white/8 to-transparent" />
    </div>
  );
}

function Item({ it, g, nav, delay }: { it: InboxItem; g: Group; nav: Nav; delay: number }) {
  const [text, setText] = useState('');
  const act = useAction();
  const [uploading, setUploading] = useState(false);
  const wait = act.busy || uploading;
  const post = (action: string, body: Record<string, unknown>): void => {
    if (wait) return;
    act.run(
      () => api('POST', `/api/tasks/${q(it.task)}/${action}`, { as: nav.me, ...body }),
      () => {
        setText('');
        // The item leaves the inbox once handled: say where the reply went.
        const what =
          action === 'answer'
            ? 'Answer sent'
            : body.verdict === 'approve'
              ? 'Approved'
              : 'Changes requested';
        toast(`${what} on ${it.task}${it.from ? ` to ${it.from}` : ''}`, {
          action: { label: 'Open task', run: () => nav.openTask(it.task) },
        });
        refreshSoon();
      },
    );
  };
  const isDecision = it.kind === 'vote' || it.kind === 'decide';
  const isChannel = it.task.startsWith('#');
  const open = (): void =>
    isDecision
      ? nav.go('decisions')
      : isChannel
        ? nav.go('channels', it.task.slice(1))
        : nav.openTask(it.task);
  const answer = (): void => {
    if (text.trim()) post('answer', { message: text });
  };
  return (
    <div
      className="panel animate-rise group relative overflow-hidden transition hover:border-white/16"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: g.color, boxShadow: `0 0 12px ${g.color}` }}
      />
      <div className="py-3 pr-3 pl-4">
        <div className="flex items-center gap-2.5 text-sm">
          <span
            className="shrink-0 rounded-md px-1.5 py-0.5 font-display text-[10px] font-semibold tracking-[0.1em] uppercase"
            style={{
              color: g.color,
              background: `color-mix(in oklab, ${g.color} 12%, transparent)`,
            }}
          >
            {/* An agent closing your question with its answer (AO-0063). */}
            {it.kind === 'message' && it.type === 'done' ? 'Answer' : KIND_LABEL[it.kind]}
          </span>
          <span className="row-link flex min-w-0 items-center gap-2.5 font-medium text-fg transition hover:text-signal">
            <button
              type="button"
              className="row-open shrink-0 cursor-pointer font-mono text-xs font-normal text-fg-3"
              onClick={open}
            >
              {it.task}
            </button>
            <span className="min-w-0 truncate">
              <RefText text={isChannel ? `#${it.title}` : it.title} />
            </span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {it.from && <Who id={it.from} />}
            <button
              type="button"
              title="Open"
              onClick={open}
              className="rounded-md p-1 text-fg-4 opacity-0 transition group-hover:opacity-100 hover:bg-white/8 hover:text-fg"
            >
              <ArrowUpRight size={15} />
            </button>
          </span>
        </div>

        {it.kind === 'owned' ? (
          <div className="mt-1.5">
            <StatusTag status={it.summary} />
          </div>
        ) : it.kind === 'review' ? (
          <ReviewRequest it={it} />
        ) : it.kind === 'triage' ? (
          <div className="mt-3">
            <TriageActions
              task={it.task}
              owner={it.owner}
              question={it.question}
              me={nav.me}
              onDone={(what) =>
                toast(`${what}: ${it.task}`, {
                  action: { label: 'Open task', run: () => nav.openTask(it.task) },
                })
              }
            />
          </div>
        ) : (
          it.summary && (
            <Markdown text={it.detail ?? it.summary} clamp className="mt-1.5 text-sm text-fg-3" />
          )
        )}
        {it.kind === 'ask' && (
          <div className="mt-1 text-xs text-fg-4">
            Stays here until you answer; Mark messages read does not clear it.
          </div>
        )}

        {(it.kind === 'ask' || it.kind === 'review') && (
          <div className="mt-3 flex flex-col gap-2">
            <MentionArea
              value={text}
              onChange={setText}
              me={nav.me}
              rows={2}
              onSubmit={it.kind === 'ask' ? answer : undefined}
              placeholder={
                it.kind === 'ask'
                  ? 'Your answer (Ctrl+Enter sends)'
                  : 'What to fix, or why it is good'
              }
              attach={{ task: it.task }}
              onUploading={setUploading}
            />
            <div className="flex items-center gap-2">
              {it.kind === 'ask' ? (
                <Button
                  kind="primary"
                  size="sm"
                  icon={Send}
                  disabled={!text.trim() || wait}
                  onClick={answer}
                  title={
                    text.trim()
                      ? 'Closes the question and puts the task back to todo, so the agent goes on'
                      : 'Write your answer first'
                  }
                >
                  Answer
                </Button>
              ) : (
                <>
                  <Button
                    kind="primary"
                    size="sm"
                    icon={Check}
                    disabled={wait}
                    onClick={() => post('verdict', { verdict: 'approve', message: text })}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    icon={PenLine}
                    disabled={!text.trim() || wait}
                    title={text.trim() ? undefined : 'Write what to fix first'}
                    onClick={() => post('verdict', { verdict: 'changes', message: text })}
                  >
                    Request changes
                  </Button>
                </>
              )}
              <Button
                size="sm"
                kind="ghost"
                icon={ArrowUpRight}
                onClick={() => nav.openTask(it.task)}
              >
                Open
              </Button>
            </div>
            <ErrorLine error={act.error} />
          </div>
        )}
      </div>
    </div>
  );
}
