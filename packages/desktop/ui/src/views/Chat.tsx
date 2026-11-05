import { CornerDownLeft, Hash, MessageSquarePlus, Send, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, bridge, refreshSoon, useData } from '../api';
import { Avatar, Button, Empty, ErrorLine, Who, cx, useAction } from '../components';
import { ago } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import type { ChatAction, ChatMessage, ChatView } from '../types';
import { MentionArea } from '../ui/pickers';

/** What an action did, as a short verb phrase. */
const VERBS: Record<string, string> = {
  created: 'created',
  comment: 'commented on',
  assign: 'assigned',
  retype: 'retyped',
  priority: 'set the priority of',
  park: 'parked',
  answer: 'answered',
  unblock: 'unblocked',
  reopen: 'reopened',
  handoff: 'handed off',
  delegate: 'delegated',
  done: 'closed',
};

function Action({ a, nav }: { a: ChatAction; nav: Nav }) {
  if (a.kind === 'channel') {
    return (
      <button
        type="button"
        onClick={() => a.channel && nav.go('channels', a.channel)}
        className="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-px text-[11px] text-fg-2 ring-1 ring-white/10 ring-inset hover:bg-white/10"
        title={a.summary}
      >
        posted in <Hash size={11} />
        {a.channel}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => a.task && nav.openTask(`${a.root}/${a.task}`)}
      className="inline-flex max-w-full items-center gap-1 rounded-md bg-signal/8 px-1.5 py-px text-[11px] text-fg-2 ring-1 ring-signal/20 ring-inset hover:bg-signal/15"
      title={a.summary || a.title}
    >
      <span>{VERBS[a.type] ?? a.type}</span>
      <span className="font-mono text-signal">{a.task}</span>
      {a.title && <span className="truncate text-fg-3">{a.title}</span>}
    </button>
  );
}

function Mine({ m }: { m: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%]">
        <div className="mb-1 flex items-center justify-end gap-2 text-[11px] text-fg-4">
          {m.channel && (
            <span className="flex items-center gap-0.5">
              <Who id={m.from ?? ''} plain /> in <Hash size={11} />
              {m.channel}
            </span>
          )}
          {m.status === 'queued' && <span className="text-warn">queued</span>}
          {m.status === 'cancelled' && <span className="text-fg-4 line-through">not sent</span>}
          <span title={m.at}>{ago(m.at)}</span>
        </div>
        <div
          className={cx(
            'md rounded-2xl rounded-tr-md px-3.5 py-2 text-sm',
            m.status === 'cancelled' ? 'bg-white/4 text-fg-4' : 'bg-signal/12 text-fg',
          )}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
        />
      </div>
    </div>
  );
}

function Reply({
  agent,
  text,
  at,
  actions,
  error,
  live,
  nav,
}: {
  agent: string;
  text: string;
  at?: string;
  actions?: ChatAction[];
  error?: string;
  live?: boolean;
  nav: Nav;
}) {
  return (
    <div className="flex gap-3">
      <div className="pt-0.5">
        <Avatar id={agent} size={30} />
      </div>
      <div className="min-w-0 max-w-[82%] flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <Who id={agent} plain label />
          {at && (
            <span className="text-[11px] text-fg-4" title={at}>
              {ago(at)}
            </span>
          )}
          {live && <span className="text-[11px] text-signal">replying…</span>}
        </div>
        {text ? (
          <div
            className="md text-sm text-fg-2"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        ) : (
          live && <div className="h-4 w-10 animate-pulse rounded bg-white/8" />
        )}
        {actions && actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {actions.map((a, i) => (
              <Action key={i} a={a} nav={nav} />
            ))}
          </div>
        )}
        {error && (
          <div className="mt-1 text-xs text-fg-4">
            {error === 'stopped' ? 'Stopped.' : `The turn ended early: ${error}`}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One conversation with the orchestrator, the project's PM. Each message is a run under the usual
 * limits; the runs share one session, so the context carries over, and an answer never closes the
 * conversation. Channel posts that mention the orchestrator show here too.
 */
export function Chat({ nav }: { nav: Nav }) {
  const { data, error, reload } = useData<ChatView>('/api/chat');
  const [text, setText] = useState('');
  const [stream, setStream] = useState<{ run: string; text: string } | null>(null);
  const act = useAction();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return bridge().onEvent((m) => {
      const { event, data: d } = m as {
        event: string;
        data: { run?: string; streaming?: string; changed?: boolean } | null;
      };
      if (event !== 'chat' || !d) return;
      if (d.run && typeof d.streaming === 'string') setStream({ run: d.run, text: d.streaming });
      if (d.changed) reload();
    });
  }, [reload]);

  const live = data?.live ?? null;
  // The live reply: the newest streamed text of the live run, else what opsd had when asked.
  const streaming = live ? (stream?.run === live.id ? stream.text : (data?.streaming ?? '')) : null;
  const count = data?.messages.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count, streaming]);

  const send = (): void => {
    if (!text.trim() || act.busy || !nav.me) return;
    act.run(
      () => api('POST', '/api/chat', { as: nav.me, text }),
      () => {
        setText('');
        reload();
        refreshSoon();
      },
    );
  };
  const stop = (): void => act.run(() => api('POST', '/api/chat/stop', {}), reload);
  const reset = (): void => act.run(() => api('POST', '/api/chat/reset', {}), reload);

  const agent = data?.agent ?? 'claude:pm';
  const busy = data?.busy ?? null;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/6 px-6 py-3">
        <Avatar id={agent} size={34} />
        <div className="min-w-0">
          <div className="font-display text-lg leading-tight font-semibold tracking-wide">
            Chat with the PM
          </div>
          <div className="truncate text-xs text-fg-3">
            Brainstorm and add work with <Who id={agent} plain />.
            {data?.mentions && ` Mentions of @*:orchestrator in channels show here.`}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {(live || data?.waiting) && (
            <Button
              kind="danger"
              size="sm"
              icon={Square}
              onClick={stop}
              disabled={act.busy}
              title={
                live
                  ? 'End the reply and drop the messages it has not read'
                  : busy
                    ? `End run ${busy.id.slice(-6)} of ${busy.agent}, which the messages wait for`
                    : 'Drop the messages that wait'
              }
            >
              Stop
            </Button>
          )}
          <Button
            size="sm"
            icon={MessageSquarePlus}
            onClick={reset}
            disabled={act.busy || live !== null || count === 0}
            title="Start a new conversation; the old one is kept in the opsd state folder"
          >
            New conversation
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 py-4">
        <ErrorLine error={error} />
        {data && count === 0 && !live && (
          <Empty icon={MessageSquarePlus} title="No conversation yet">
            Ask for a status, think out loud, or list tasks to add. The orchestrator creates,
            assigns and comments on tasks; it never gives verdicts or answers for you.
          </Empty>
        )}
        {data?.messages.map((m) =>
          m.role === 'user' ? (
            <Mine key={m.id} m={m} />
          ) : (
            <Reply
              key={m.id}
              agent={agent}
              text={m.text}
              at={m.at}
              actions={m.actions}
              error={m.error}
              nav={nav}
            />
          ),
        )}
        {live && <Reply agent={agent} text={streaming ?? ''} live nav={nav} />}
        <div ref={bottom} />
      </div>

      <div className="border-t border-white/6 bg-ink-950/30 px-6 py-3">
        {data?.waiting && (
          <div className="mb-2 text-xs text-warn">
            Waiting to start: {data.waiting}
            {busy && ` (run ${busy.id.slice(-6)} of ${busy.agent} is live; Stop ends it)`}
          </div>
        )}
        <MentionArea
          value={text}
          onChange={setText}
          me={nav.me}
          rows={2}
          onSubmit={send}
          placeholder={`Message ${agent}`}
        />
        <div className="mt-2 flex items-center gap-3">
          <span className="text-xs text-fg-4">
            Each message is one run; messages sent while it replies wait for the next one.
          </span>
          <span className="ml-auto flex items-center gap-1 text-xs text-fg-4">
            <kbd className="rounded bg-white/6 px-1 font-mono text-[10px] text-fg-3">Ctrl</kbd>
            <kbd className="flex items-center rounded bg-white/6 px-1 text-fg-3">
              <CornerDownLeft size={10} />
            </kbd>
            to send
          </span>
          <Button
            kind="primary"
            size="sm"
            icon={Send}
            disabled={!text.trim() || act.busy || !nav.me}
            onClick={send}
          >
            Send
          </Button>
        </div>
        {!nav.me && (
          <div className="mt-2">
            <ErrorLine error="Set `me: human:<name>` in the user config to chat." />
          </div>
        )}
        {act.error && (
          <div className="mt-2">
            <ErrorLine error={act.error} />
          </div>
        )}
      </div>
    </div>
  );
}
