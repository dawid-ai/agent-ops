import type { LucideIcon } from 'lucide-react';
import {
  AtSign,
  CornerDownLeft,
  Hash,
  LifeBuoy,
  Lightbulb,
  MessagesSquare,
  Plus,
  Send,
  Sparkles,
  Coffee,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, q, refreshSoon, useData } from '../api';
import {
  Avatar,
  Button,
  Empty,
  ErrorLine,
  Field,
  Input,
  Modal,
  Section,
  useAction,
  Who,
  cx,
} from '../components';
import { ago, ulidTime } from '../lib/format';
import { hashColor } from '../lib/identity';
import { renderMarkdown } from '../lib/markdown';
import { channelUrl, parseChannelTarget } from '../lib/search';
import type { ChannelInfo, ChannelMessage } from '../types';
import { MentionArea } from '../ui/pickers';

// ---- Channel identity ----------------------------------------------------------------------------

const DEFAULTS: Array<{ name: string; description: string; icon: LucideIcon; color: string }> = [
  {
    name: 'general',
    description: 'Anything that is not a task.',
    icon: MessagesSquare,
    color: '#5ce1e6',
  },
  {
    name: 'standup',
    description: 'Short status: done, next, blocked.',
    icon: Coffee,
    color: '#3ddc97',
  },
  {
    name: 'findings',
    description: 'Things noticed on the way.',
    icon: Lightbulb,
    color: '#ffb547',
  },
  {
    name: 'help',
    description: "An agent is stuck and wants another agent's eyes.",
    icon: LifeBuoy,
    color: '#ff7eb6',
  },
];

function channelLook(name: string): { icon: LucideIcon; color: string } {
  const known = DEFAULTS.find((d) => d.name === name);
  return known ?? { icon: Hash, color: hashColor(name) };
}

function ChannelGlyph({ name, size = 28 }: { name: string; size?: number }) {
  const { icon: Icon, color } = channelLook(name);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[30%]"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(145deg, color-mix(in oklab, ${color} 22%, #0d1117), color-mix(in oklab, ${color} 7%, #0d1117))`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 34%, transparent)`,
      }}
    >
      <Icon size={Math.round(size * 0.52)} color={color} strokeWidth={2.1} />
    </span>
  );
}

const NAME_RE = /^[a-z0-9-]+$/;

function nameProblem(name: string, existing: string[]): string | null {
  if (!name) return null;
  if (name.length > 40) return 'At most 40 characters.';
  if (!NAME_RE.test(name)) return 'Use lowercase letters, digits and hyphens only.';
  if (existing.includes(name)) return `#${name} already exists.`;
  return null;
}

// ---- View ----------------------------------------------------------------------------------------

/**
 * `selected` is a channel name, or `name?root=R&msg=ID` from a search result: that root's
 * messages around that post, scrolled to and outlined.
 */
export function Channels({ nav, selected }: { nav: Nav; selected?: string }) {
  const list = useData<ChannelInfo[]>('/api/channels');
  const [target, setTarget] = useState(() => parseChannelTarget(selected));
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    setTarget(parseChannelTarget(selected));
  }, [selected]);
  const setPick = (n: string): void => setTarget({ channel: n });
  const channels = list.data ?? [];
  const name = target.channel ?? channels[0]?.name;
  const current = channels.find((c) => c.name === name);
  const focus = target.channel === name && target.msg ? target : undefined;
  const created = (n: string): void => {
    setPick(n);
    list.reload();
    refreshSoon();
  };
  return (
    <Section
      title="Channels"
      icon={MessagesSquare}
      subtitle="Talk that is not a task. Mention an agent to put the message in its inbox."
      actions={
        channels.length > 0 && (
          <Button kind="primary" icon={Plus} disabled={!nav.me} onClick={() => setCreating(true)}>
            New channel
          </Button>
        )
      }
    >
      {list.data && channels.length === 0 ? (
        <div className="p-6">
          <ErrorLine error={list.error} />
          <StarterChannels nav={nav} onCreated={created} onCustom={() => setCreating(true)} />
        </div>
      ) : (
        <div className="flex h-full min-h-0">
          <aside className="flex w-64 shrink-0 flex-col border-r border-white/6 bg-ink-950/30">
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <span className="label-caps">Channels · {channels.length}</span>
              <button
                type="button"
                title="New channel"
                disabled={!nav.me}
                onClick={() => setCreating(true)}
                className="rounded-md p-1 text-fg-3 transition hover:bg-white/8 hover:text-signal disabled:opacity-40"
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
              <ErrorLine error={list.error} />
              {channels.map((c, i) => {
                const active = c.name === name;
                const { color } = channelLook(c.name);
                return (
                  <button
                    key={c.name}
                    onClick={() => setPick(c.name)}
                    style={{
                      animationDelay: `${Math.min(i * 25, 250)}ms`,
                      boxShadow: active
                        ? `inset 2px 0 0 ${color}, inset 0 0 0 1px rgb(255 255 255 / 0.06)`
                        : undefined,
                    }}
                    className={cx(
                      'animate-rise group mb-0.5 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition',
                      active ? 'bg-white/7' : 'hover:bg-white/4',
                    )}
                  >
                    <ChannelGlyph name={c.name} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span
                          className={cx(
                            'truncate font-display text-sm font-semibold tracking-wide',
                            active ? 'text-fg' : 'text-fg-2 group-hover:text-fg',
                          )}
                        >
                          <span className="text-fg-4">#</span>
                          {c.name}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-4">
                          {c.last ? ago(ulidTime(c.last)).replace(' ago', '') : ''}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-4">
                        <span className="truncate">{c.description || 'No description'}</span>
                        <span
                          className="ml-auto shrink-0 rounded-full px-1.5 font-mono text-[10px]"
                          style={{
                            color: active ? color : undefined,
                            background: 'rgb(255 255 255 / 0.05)',
                          }}
                        >
                          {c.messages}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>
          <div className="min-w-0 flex-1">
            {name ? (
              <Channel
                key={`${name}?${focus?.root ?? ''}#${focus?.msg ?? ''}`}
                name={name}
                info={current}
                nav={nav}
                root={focus?.root}
                msg={focus?.msg}
                onLatest={() => setPick(name)}
              />
            ) : (
              <Empty icon={Hash} title="Pick a channel" />
            )}
          </div>
        </div>
      )}
      {creating && (
        <NewChannel
          nav={nav}
          existing={channels.map((c) => c.name)}
          onClose={() => setCreating(false)}
          onCreated={(n) => {
            setCreating(false);
            created(n);
          }}
        />
      )}
    </Section>
  );
}

// ---- Starter channels ----------------------------------------------------------------------------

function StarterChannels(props: {
  nav: Nav;
  onCreated: (name: string) => void;
  onCustom: () => void;
}) {
  const act = useAction();
  const [made, setMade] = useState<string[]>([]);
  const create = (names: string[]): void =>
    act.run(
      async () => {
        for (const n of names) {
          const d = DEFAULTS.find((x) => x.name === n)!;
          await api('POST', '/api/channels', {
            as: props.nav.me,
            name: d.name,
            description: d.description,
          });
          setMade((m) => [...m, n]);
        }
      },
      () => props.onCreated(names[0]!),
    );
  const left = DEFAULTS.filter((d) => !made.includes(d.name)).map((d) => d.name);
  return (
    <Empty
      icon={MessagesSquare}
      title="No channels yet"
      action={
        <div className="flex w-[34rem] max-w-[90vw] flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 text-left">
            {DEFAULTS.map((d, i) => {
              const done = made.includes(d.name);
              return (
                <button
                  key={d.name}
                  type="button"
                  disabled={!props.nav.me || act.busy || done}
                  onClick={() => create([d.name])}
                  style={{ animationDelay: `${i * 60}ms` }}
                  className="panel animate-rise group flex items-start gap-3 p-3 text-left transition hover:border-white/20 hover:bg-white/4 disabled:cursor-default disabled:opacity-60"
                >
                  <ChannelGlyph name={d.name} size={32} />
                  <span className="min-w-0">
                    <span className="block font-display text-sm font-semibold tracking-wide">
                      <span className="text-fg-4">#</span>
                      {d.name}
                    </span>
                    <span className="block text-xs leading-snug text-fg-3">{d.description}</span>
                  </span>
                  <Plus
                    size={14}
                    className="ml-auto shrink-0 text-fg-4 transition group-hover:text-signal"
                  />
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-center gap-2">
            <Button
              kind="primary"
              icon={Sparkles}
              disabled={!props.nav.me || act.busy || left.length === 0}
              onClick={() => create(left)}
            >
              Create {left.length === DEFAULTS.length ? 'all four' : 'the rest'}
            </Button>
            <Button kind="ghost" icon={Plus} disabled={!props.nav.me} onClick={props.onCustom}>
              Custom channel
            </Button>
          </div>
          <ErrorLine error={act.error} />
        </div>
      }
    >
      Channels hold talk that is not a task: status, findings, and calls for help. Start with the
      suggested set, one click each.
    </Empty>
  );
}

// ---- New channel modal ---------------------------------------------------------------------------

function NewChannel(props: {
  nav: Nav;
  existing: string[];
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const act = useAction();
  const problem = nameProblem(name, props.existing);
  const ok = !!name && !problem && !!props.nav.me;
  const submit = (): void => {
    if (!ok || act.busy) return;
    act.run(
      () => api('POST', '/api/channels', { as: props.nav.me, name, description }),
      () => props.onCreated(name),
    );
  };
  const suggestions = DEFAULTS.filter((d) => !props.existing.includes(d.name));
  return (
    <Modal title="New channel" icon={Hash} onClose={props.onClose} width={480}>
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          hint={
            problem ? (
              <span className="text-bad">{problem}</span>
            ) : name ? (
              <span className="text-ok">#{name} is free.</span>
            ) : (
              'Lowercase letters, digits and hyphens; at most 40 characters.'
            )
          }
        >
          <div className="relative">
            <Hash size={14} className="pointer-events-none absolute top-2.5 left-2.5 text-fg-4" />
            <Input
              value={name}
              autoFocus
              onChange={(v) => setName(v.toLowerCase().replace(/\s+/g, '-'))}
              onEnter={submit}
              placeholder="release-notes"
              className="w-full pl-7 font-mono"
            />
          </div>
        </Field>
        <Field label="Description" hint="One line on what belongs here; agents read it.">
          <Input
            value={description}
            onChange={setDescription}
            onEnter={submit}
            placeholder="What this channel is for"
            className="w-full"
          />
        </Field>
        {suggestions.length > 0 && (
          <div>
            <div className="label-caps mb-1.5">Suggested</div>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((d) => (
                <button
                  key={d.name}
                  type="button"
                  onClick={() => {
                    setName(d.name);
                    setDescription(d.description);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/5 py-0.5 pr-2.5 pl-0.5 text-xs text-fg-2 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-fg"
                >
                  <ChannelGlyph name={d.name} size={18} />#{d.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <ErrorLine error={act.error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button kind="primary" icon={Plus} disabled={!ok || act.busy} onClick={submit}>
            Create channel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---- One channel ---------------------------------------------------------------------------------

interface Group {
  actor: string;
  day: string | null;
  items: ChannelMessage[];
}

const GROUP_GAP_MS = 10 * 60_000;

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (dayKey(iso) === dayKey(today.toISOString())) return 'Today';
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Consecutive messages by one author within ten minutes, with a day divider when the day turns. */
function groupMessages(messages: ChannelMessage[]): Group[] {
  const out: Group[] = [];
  let lastDay = '';
  for (const m of messages) {
    const day = dayKey(m.at);
    const g = out[out.length - 1];
    const prev = g?.items[g.items.length - 1];
    if (
      g &&
      prev &&
      g.actor === m.actor &&
      day === lastDay &&
      Date.parse(m.at) - Date.parse(prev.at) < GROUP_GAP_MS
    ) {
      g.items.push(m);
    } else {
      out.push({ actor: m.actor, day: day !== lastDay ? dayLabel(m.at) : null, items: [m] });
    }
    lastDay = day;
  }
  return out;
}

function TaskLink({ task, nav }: { task: string; nav: Nav }) {
  return (
    <button
      type="button"
      onClick={() => nav.openTask(task)}
      className="inline-flex items-center gap-1 rounded-md bg-signal/8 px-1.5 py-px font-mono text-[11px] text-signal ring-1 ring-signal/20 transition ring-inset hover:bg-signal/15"
    >
      {task}
    </button>
  );
}

function Channel({
  name,
  info,
  nav,
  root,
  msg,
  onLatest,
}: {
  name: string;
  info?: ChannelInfo;
  nav: Nav;
  /** With `msg`: show this root's messages around that post instead of the newest. */
  root?: string;
  msg?: string;
  onLatest: () => void;
}) {
  const { data, error } = useData<ChannelMessage[]>(channelUrl(name, { root, msg }));
  const [text, setText] = useState('');
  const act = useAction();
  const bottom = useRef<HTMLDivElement>(null);
  const picked = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupMessages(data ?? []), [data]);
  const { color } = channelLook(name);
  // A search result scrolls to its post once; otherwise the newest message stays in view.
  const placed = useRef(false);
  useEffect(() => {
    if (!msg) bottom.current?.scrollIntoView({ block: 'end' });
    else if (!placed.current && picked.current) {
      picked.current.scrollIntoView({ block: 'center' });
      placed.current = true;
    }
  }, [data, msg]);
  const [uploading, setUploading] = useState(false);
  const hold = !text.trim() || act.busy || uploading || !nav.me;
  const send = (): void => {
    if (hold) return;
    act.run(
      () => api('POST', `/api/channels/${q(name)}`, { as: nav.me, message: text }),
      () => {
        setText('');
        refreshSoon();
        // The new message is the newest one; leave a search result's window to show it.
        if (msg) onLatest();
      },
    );
  };
  return (
    <div className="flex h-full flex-col">
      <header
        className="flex items-center gap-3 border-b border-white/6 px-6 py-3"
        style={{
          background: `linear-gradient(90deg, color-mix(in oklab, ${color} 7%, transparent), transparent 55%)`,
        }}
      >
        <ChannelGlyph name={name} size={34} />
        <div className="min-w-0">
          <div className="font-display text-lg leading-tight font-semibold tracking-wide">
            <span style={{ color }}>#</span>
            {name}
          </div>
          <div className="truncate text-xs text-fg-3">
            {info?.description || 'No description yet.'}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-4 text-xs text-fg-3">
          <span>
            <span className="font-display text-sm font-semibold text-fg-2">
              {info?.messages ?? data?.length ?? 0}
            </span>{' '}
            messages
          </span>
          {info?.last && <span>last {ago(ulidTime(info.last))}</span>}
        </div>
      </header>

      {msg && (
        <div className="flex items-center gap-3 border-b border-white/6 bg-signal/5 px-6 py-1.5 text-xs text-fg-3">
          <span>
            A search result{root ? ` in ${root}` : ''}, with the messages around it
            {root ? ' from that root' : ''}.
          </span>
          <button type="button" onClick={onLatest} className="ml-auto text-signal hover:underline">
            Show the newest messages
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        <ErrorLine error={error} />
        {data?.length === 0 && (
          <Empty icon={channelLook(name).icon} title={`#${name} is quiet`}>
            {info?.description || 'Nothing posted yet.'} Write the first message below.
          </Empty>
        )}
        {groups.map((g) => (
          <div key={g.items[0]!.id} className="animate-rise">
            {g.day && (
              <div className="my-4 flex items-center gap-3">
                <div className="h-px flex-1 bg-white/6" />
                <span className="label-caps text-fg-4">{g.day}</span>
                <div className="h-px flex-1 bg-white/6" />
              </div>
            )}
            <div className="group/g -mx-3 flex gap-3 rounded-xl px-3 py-2 transition hover:bg-white/[0.025]">
              <div className="pt-0.5">
                <Avatar id={g.actor} size={34} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <Who id={g.actor} plain size="md" label />
                  <span className="font-mono text-[11px] text-fg-4" title={g.items[0]!.at}>
                    {clock(g.items[0]!.at)} · {ago(g.items[0]!.at)}
                  </span>
                </div>
                {g.items.map((m, i) => (
                  <div
                    key={`${m.root ?? ''}/${m.id}`}
                    ref={m.id === msg ? picked : undefined}
                    className={cx(
                      'group/m relative',
                      m.id === msg && '-mx-1.5 rounded-md px-1.5 ring-2 ring-signal/60',
                    )}
                  >
                    {i > 0 && (
                      <span
                        className="absolute top-1 -left-[46px] w-9 text-right font-mono text-[10px] text-fg-4 opacity-0 transition group-hover/m:opacity-100"
                        title={m.at}
                      >
                        {clock(m.at)}
                      </span>
                    )}
                    <div
                      className="md text-sm text-fg-2"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(m.body) }}
                    />
                    {m.task && (
                      <div className="mt-0.5 mb-1">
                        <TaskLink task={m.task} nav={nav} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="border-t border-white/6 bg-ink-950/30 px-6 py-3">
        <MentionArea
          value={text}
          onChange={setText}
          me={nav.me}
          rows={2}
          onSubmit={send}
          placeholder={`Message #${name}`}
          // Posts go to the default root, so their images do too.
          attach={{}}
          onUploading={setUploading}
        />
        <div className="mt-2 flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-fg-4">
            <AtSign size={12} className="text-signal" />
            Mention an agent to put the message in its inbox.
          </span>
          <span className="ml-auto flex items-center gap-1 text-xs text-fg-4">
            <kbd className="rounded bg-white/6 px-1 font-mono text-[10px] text-fg-3">Ctrl</kbd>
            <kbd className="flex items-center rounded bg-white/6 px-1 text-fg-3">
              <CornerDownLeft size={10} />
            </kbd>
            to send
          </span>
          <Button kind="primary" size="sm" icon={Send} disabled={hold} onClick={send}>
            Send
          </Button>
        </div>
        {!nav.me && (
          <div className="mt-2">
            <ErrorLine error="Set `me: human:<name>` in the user config to post." />
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
