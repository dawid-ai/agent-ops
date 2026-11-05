import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  History,
  BarChart3,
  BookOpen,
  Bookmark,
  Bot,
  CalendarClock,
  Hash,
  Inbox as InboxIcon,
  Kanban,
  ListTodo,
  MessageSquare,
  Newspaper,
  Plus,
  Radar,
  RefreshCw,
  Repeat,
  Settings as SettingsIcon,
  TriangleAlert,
  Vote,
  X,
  Download,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetupStatus } from './api';
import { bridge, refreshSoon, useData, useUpdate } from './api';
import { Avatar, Toaster, cx } from './components';
import { Lightbox } from './ui/attach';
import type { SavedView } from './lib/filters';
import { loadViews, storeViews, VIEWS_CHANGED } from './lib/filters';
import type { AddAgentRequest } from './lib/goto';
import { ADD_AGENT_EVENT } from './lib/goto';
import { mouseNav } from './lib/history';
import { findTask, isTyping, keyAction } from './lib/keys';
import { useMover } from './ui/move';
import { Palette, ShortcutHelp } from './ui/palette';
import { setRefTasks } from './lib/refs';
import { useRefTasks, useTaskFocus } from './ui/refs';
import type { Decision, InboxItem, Info, RunRecord, Task } from './types';
import { Activity as ActivityView } from './views/Activity';
import { AddAgentDialog, Agents } from './views/Agents';
import { Board } from './views/Board';
import { Channels } from './views/Channels';
import { Chat } from './views/Chat';
import { Decisions } from './views/Decisions';
import { Findings } from './views/Findings';
import { Inbox } from './views/Inbox';
import { Knowledge } from './views/Knowledge';
import { List } from './views/List';
import { NewTask } from './views/NewTask';
import { Reports } from './views/Reports';
import { Runs } from './views/Runs';
import { Repeating } from './views/Repeating';
import { Schedules } from './views/Schedules';
import { Settings } from './views/Settings';
import { Setup } from './views/Setup';
import { Search } from './views/Search';
import { Standups } from './views/Standups';
import { SEARCH_INPUT_ID, SearchBox } from './ui/search';
import { TaskPanel } from './views/TaskPanel';

export type View =
  | 'inbox'
  | 'board'
  | 'list'
  | 'findings'
  | 'standups'
  | 'activity'
  | 'reports'
  | 'agents'
  | 'runs'
  | 'schedules'
  | 'repeating'
  | 'decisions'
  | 'chat'
  | 'channels'
  | 'knowledge'
  | 'search'
  | 'settings';

const GROUPS: Array<{ title: string; items: Array<[View, string, LucideIcon]> }> = [
  {
    title: 'Work',
    items: [
      ['inbox', 'Inbox', InboxIcon],
      ['board', 'Board', Kanban],
      ['list', 'Tasks', ListTodo],
      ['findings', 'Findings', Radar],
      ['standups', 'Standups', Newspaper],
      ['activity', 'Activity', History],
      ['reports', 'Reports', BarChart3],
    ],
  },
  {
    title: 'Agents',
    items: [
      ['agents', 'Agents', Bot],
      ['runs', 'Runs', Activity],
      ['schedules', 'Schedules', CalendarClock],
      ['repeating', 'Repeating', Repeat],
    ],
  },
  {
    title: 'Talk',
    items: [
      ['chat', 'Chat', MessageSquare],
      ['channels', 'Channels', Hash],
      ['decisions', 'Decisions', Vote],
      ['knowledge', 'Knowledge', BookOpen],
    ],
  },
];

const VIEWS: View[] = [...GROUPS.flatMap((g) => g.items.map(([v]) => v)), 'search', 'settings'];

interface Status {
  connected: boolean;
  error?: string;
}

export interface Nav {
  me: string | null;
  /** Opens a task: `AO-0047`, `root/AO-0047`, or `AO-0014#<event id>` scrolled to that event. */
  openTask: (ref: string) => void;
  go: (view: View, arg?: string) => void;
}

/** The app's mark: an aperture of four signal arcs. */
function Mark() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="mk" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5ce1e6" />
          <stop offset="1" stopColor="#3ddc97" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="9"
        fill="#0d1117"
        stroke="url(#mk)"
        strokeOpacity="0.5"
      />
      {[0, 90, 180, 270].map((a) => (
        <path
          key={a}
          d="M16 6.5a9.5 9.5 0 0 1 8.2 4.7"
          stroke="url(#mk)"
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
          transform={`rotate(${a} 16 16)`}
        />
      ))}
      <circle cx="16" cy="16" r="3" fill="#5ce1e6" />
    </svg>
  );
}

export function App() {
  const [view, setView] = useState<View>('inbox');
  const [arg, setArg] = useState<string | undefined>();
  // The open task and the event a task reference points at.
  const { task, focus, open: setTask, back, forward } = useTaskFocus();
  // Back and Forward for the key and mouse listeners below, which are added once.
  const moves = useRef({ back, forward });
  moves.current = { back, forward };
  useEffect(() => {
    const onMouse = (e: MouseEvent): void => {
      const dir = mouseNav(e.button);
      if (!dir) return;
      // Stop Chromium's own page history on the side buttons too.
      e.preventDefault();
      if (e.type === 'mouseup') moves.current[dir]?.();
    };
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);
  // Task references in rendered text (lib/refs.ts) open the task panel.
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const el = (e.target as Element | null)?.closest?.('a[data-task-ref]');
      if (!el) return;
      e.preventDefault();
      setTask(el.getAttribute('data-task-ref'));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [setTask]);
  // A greyed, not configured agent in a picker opens Add agent for it (lib/goto.ts), as a dialog
  // above the form the picker is in: the view, the task panel and that form stay as they are.
  const [addAgent, setAddAgent] = useState<AddAgentRequest | null>(null);
  useEffect(() => {
    const onAdd = (e: Event): void => {
      const req = (e as CustomEvent<AddAgentRequest>).detail;
      if (typeof req?.id === 'string') setAddAgent(req);
    };
    window.addEventListener(ADD_AGENT_EVENT, onAdd);
    return () => window.removeEventListener(ADD_AGENT_EVENT, onAdd);
  }, []);
  const [info, setInfo] = useState<Info | null>(null);
  const [status, setStatus] = useState<Status>({ connected: false });
  // Paused opsd, from the main process: the tray, Settings and `ops daemon pause` change it.
  const [halted, setHalted] = useState(false);
  useEffect(() => {
    let live = true;
    void bridge()
      .desktop()
      .then((res) => live && res.ok && setHalted(Boolean(res.data?.state.paused)));
    const off = bridge().onService(
      (m) => live && setHalted(Boolean((m as { paused?: boolean }).paused)),
    );
    return () => {
      live = false;
      off();
    };
  }, []);
  const update = useUpdate();
  const [creating, setCreating] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [restartNote, setRestartNote] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const pendingG = useRef(false);

  const loadInfo = useCallback(() => {
    bridge()
      .info()
      .then(
        (i) => {
          setInfo(i);
          setInfoError(null);
          refreshSoon();
        },
        (e: Error) => setInfoError(e.message),
      );
  }, []);

  useEffect(() => {
    let b;
    try {
      b = bridge();
    } catch (e) {
      setInfoError((e as Error).message);
      return;
    }
    // First start: set up the user config before opsd starts, so it loads it.
    b.setupStatus().then(
      (s) => {
        if (s.needed) setSetup(s);
        else loadInfo();
      },
      (e: Error) => setInfoError(e.message),
    );
    const offs = [
      b.onEvent((m) => {
        const ev = (m as { event: string }).event;
        if (ev === 'tasks' || ev === 'changed' || ev === 'run' || ev === 'sync') refreshSoon();
      }),
      b.onStatus((m) => {
        setStatus(m as Status);
        if ((m as Status).connected) refreshSoon();
      }),
      b.onNavigate((m) => {
        const nav = m as { view: string; id?: string };
        if (nav.view === 'task' && nav.id) setTask(nav.id);
        // The screenshot run opens the palette and the shortcut list this way.
        else if (nav.view === 'palette') setPalette(true);
        else if (nav.view === 'shortcuts') setHelp(true);
        else if (VIEWS.includes(nav.view as View)) {
          setView(nav.view as View);
          setArg(nav.id);
          setTask(null);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [loadInfo, setTask]);

  // An opsd older than the app restarts once no run is live: look again every 30 s.
  useEffect(() => {
    if (!info?.stale) return;
    const timer = setInterval(loadInfo, 30_000);
    return () => clearInterval(timer);
  }, [info?.stale, loadInfo]);

  const me = info?.me ?? null;
  const inbox = useData<InboxItem[]>(me ? `/api/inbox?as=${encodeURIComponent(me)}` : null);
  const live = useData<RunRecord[]>(info ? '/api/runs?live' : null);
  const votes = useData<Decision[]>(info ? '/api/decisions' : null);
  const tasks = useData<Task[]>(info ? '/api/tasks' : null);
  const [saved, setSaved] = useState<SavedView[]>(() => loadViews());
  useEffect(() => {
    const reload = (): void => setSaved(loadViews());
    window.addEventListener(VIEWS_CHANGED, reload);
    return () => window.removeEventListener(VIEWS_CHANGED, reload);
  }, []);
  const nav: Nav = {
    me,
    openTask: setTask,
    go: (v, a) => {
      setView(v);
      setArg(a);
    },
  };
  const mover = useMover(nav, setMoveError);
  // Closed tasks too: task reference chips show their status and title, and the palette, the task
  // panel and the # picker search them.
  const allTasks = useData<Task[]>(info ? '/api/tasks?all' : null);
  useEffect(() => {
    if (allTasks.data) setRefTasks(allTasks.data);
  }, [allTasks.data]);
  // Markdown views draw chips from the index as they render, so App draws again when it changes.
  useRefTasks();

  // Ctrl+K anywhere; single keys only outside fields (see lib/keys.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const r = keyAction(e, {
        pendingG: pendingG.current,
        typing: isTyping(document.activeElement as HTMLElement | null),
        // With a dialog open only Ctrl+K acts, and no `g` sequence starts or carries over.
        modal: document.querySelector('[data-modal]') !== null,
      });
      pendingG.current = r.pendingG;
      if (!r.action) return;
      e.preventDefault();
      switch (r.action.kind) {
        case 'palette':
          setPalette((p) => !p);
          break;
        case 'find': {
          const box = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
          box?.focus();
          box?.select();
          break;
        }
        case 'new':
          setCreating(true);
          break;
        case 'help':
          setHelp(true);
          break;
        case 'back':
        case 'forward':
          moves.current[r.action.kind]?.();
          break;
        case 'search':
          document
            .querySelector<HTMLInputElement>('main input:not([type]), main input[type="text"]')
            ?.focus();
          break;
        case 'go':
          setView(r.action.view as View);
          setArg(undefined);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const counts: Partial<Record<View, { n: number; tone: string }>> = {
    inbox: { n: inbox.data?.length ?? 0, tone: '#5ce1e6' },
    runs: { n: live.data?.length ?? 0, tone: '#3ddc97' },
    decisions: { n: (votes.data ?? []).filter((d) => !d.outcome).length, tone: '#b18cff' },
    findings: {
      n: (tasks.data ?? []).filter(
        (t) => t.type === 'finding' && !['done', 'parked'].includes(t.status),
      ).length,
      tone: '#ffb547',
    },
  };

  if (setup) {
    return (
      <Setup
        status={setup}
        onDone={(restart) => {
          setSetup(null);
          setRestartNote(restart);
          loadInfo();
        }}
      />
    );
  }

  if (infoError && !info) {
    return (
      <div className="stage flex h-screen items-center justify-center p-8 text-center">
        <div className="panel max-w-md p-8">
          <TriangleAlert size={28} className="mx-auto text-warn" />
          <div className="mt-3 font-display text-lg font-semibold tracking-wide">
            Cannot reach opsd
          </div>
          <div className="mt-1 text-sm text-fg-3">{infoError}</div>
        </div>
      </div>
    );
  }

  const restart = (): void => {
    setRestarting('Restarting…');
    bridge()
      .restart()
      .then((res) => {
        setRestarting(res.ok ? null : (res.error ?? 'restart failed'));
        if (res.ok) loadInfo();
      });
  };

  return (
    <div className="flex h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/6 bg-ink-950">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <Mark />
          <div>
            <div className="font-display text-[17px] leading-none font-bold tracking-[0.08em] uppercase">
              Agent Ops
            </div>
            <div className="mt-1 text-[10px] tracking-[0.2em] text-fg-4 uppercase">
              control room
            </div>
          </div>
        </div>
        <div className="px-3 pb-2">
          <button
            onClick={() => setCreating(true)}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-signal text-sm font-semibold text-ink-950 shadow-[0_0_24px_-6px_rgba(92,225,230,0.8)] transition hover:bg-[#7debef] active:translate-y-px"
          >
            <Plus size={16} strokeWidth={2.6} /> New task
          </button>
          {/* The conversation with the PM, one click from every view (AO-0134). */}
          <button
            type="button"
            data-chat-button
            onClick={() => nav.go('chat')}
            title="One conversation with the project's PM; an answer never closes it"
            className={cx(
              'mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border text-sm font-medium transition active:translate-y-px',
              view === 'chat'
                ? 'border-signal/50 bg-signal/10 text-signal'
                : 'border-white/10 text-fg-2 hover:border-white/20 hover:bg-white/4 hover:text-fg',
            )}
          >
            <MessageSquare size={16} /> Chat with the PM
          </button>
        </div>
        <SearchBox nav={nav} />
        <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-2 py-2">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="label-caps px-3 pb-1.5 !text-[10px]">{g.title}</div>
              {g.items.map(([v, label, Icon]) => (
                <NavItem
                  key={v}
                  active={view === v}
                  icon={Icon}
                  label={label}
                  count={counts[v]}
                  onClick={() => nav.go(v)}
                />
              ))}
            </div>
          ))}
          {saved.length > 0 && (
            <div>
              <div className="label-caps px-3 pb-1.5 !text-[10px]">Saved views</div>
              {saved.map((v) => (
                <div key={v.name} className="group/view relative">
                  <NavItem
                    active={view === v.view && arg === `saved:${v.name}`}
                    icon={v.view === 'board' ? Kanban : Bookmark}
                    label={v.name}
                    onClick={() => nav.go(v.view, `saved:${v.name}`)}
                  />
                  <button
                    type="button"
                    aria-label={`Delete the view ${v.name}`}
                    title="Delete this view"
                    onClick={() => storeViews(saved.filter((x) => x.name !== v.name))}
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-fg-4 opacity-0 transition group-hover/view:opacity-100 hover:bg-white/10 hover:text-fg"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </nav>
        <div className="border-t border-white/6 px-2 py-2">
          <NavItem
            active={view === 'settings'}
            icon={SettingsIcon}
            label="Settings"
            onClick={() => nav.go('settings')}
          />
        </div>
        <div className="flex items-center gap-2.5 border-t border-white/6 px-4 py-3">
          {me ? (
            <Avatar id={me} size={30} />
          ) : (
            <span className="h-[30px] w-[30px] rounded-[30%] bg-ink-700" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-xs text-fg-2">{me ?? 'no me set'}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-4">
              <span
                className={cx(
                  'h-1.5 w-1.5 rounded-full',
                  status.connected ? 'animate-pulse-dot bg-ok text-ok' : 'bg-bad',
                )}
              />
              {status.connected ? `opsd · pid ${info?.pid ?? '-'}` : 'opsd offline'}
              {status.connected && halted && <span className="text-warn">· paused</span>}
            </div>
          </div>
        </div>
        {(restartNote || (!status.connected && status.error)) && (
          <div className="px-4 pb-3 text-[11px] text-warn">
            {restartNote
              ? 'opsd runs agents: restart it in Settings to load the new config'
              : status.error}
          </div>
        )}
      </aside>
      <main className="stage flex min-w-0 flex-1 flex-col">
        {update?.status === 'ready' && (
          <div className="flex items-center gap-3 border-b border-signal/25 bg-signal/8 px-6 py-2 text-sm text-signal">
            <Download size={16} />
            <span className="min-w-0 flex-1">
              Agent Ops {update.version} is ready. It installs on its own once no agent run is live
              and this window is closed.
            </span>
            <button
              onClick={() => void bridge().update('install')}
              className="inline-flex items-center gap-1.5 rounded-md bg-signal/15 px-2.5 py-1 text-xs font-medium hover:bg-signal/25"
            >
              <RefreshCw size={13} /> Restart and install
            </button>
          </div>
        )}
        {info?.stale && (
          <div className="flex items-center gap-3 border-b border-warn/25 bg-warn/8 px-6 py-2 text-sm text-warn">
            <TriangleAlert size={16} />
            <span className="min-w-0 flex-1">
              opsd runs an older build than this app
              {info.live ? ` and ${info.live} run${info.live === 1 ? ' is' : 's are'} live` : ''}.
              It restarts on its own once no run is live; until then some views may lack data.
            </span>
            {restarting && <span className="text-xs">{restarting}</span>}
            <button
              onClick={restart}
              className="inline-flex items-center gap-1.5 rounded-md bg-warn/15 px-2.5 py-1 text-xs font-medium hover:bg-warn/25"
            >
              <RefreshCw size={13} /> Restart now if idle
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {view === 'inbox' && <Inbox nav={nav} items={inbox.data} error={inbox.error} />}
          {/* Keyed on the saved view, so leaving one starts from the default filters. */}
          {view === 'board' && <Board key={arg ?? ''} nav={nav} preset={arg} />}
          {view === 'list' && <List key={arg ?? ''} nav={nav} preset={arg} />}
          {view === 'findings' && <Findings nav={nav} />}
          {view === 'knowledge' && <Knowledge key={arg ?? ''} nav={nav} selected={arg} />}
          {view === 'search' && <Search nav={nav} initial={arg} />}
          {view === 'standups' && <Standups nav={nav} />}
          {view === 'activity' && <ActivityView nav={nav} />}
          {view === 'reports' && <Reports nav={nav} />}
          {view === 'agents' && <Agents nav={nav} />}
          {view === 'runs' && <Runs nav={nav} selected={arg} />}
          {view === 'schedules' && <Schedules nav={nav} selected={arg} />}
          {view === 'repeating' && <Repeating nav={nav} />}
          {view === 'decisions' && <Decisions key={arg ?? ''} nav={nav} selected={arg} />}
          {view === 'chat' && <Chat nav={nav} />}
          {view === 'channels' && <Channels nav={nav} selected={arg} />}
          {view === 'settings' && <Settings nav={nav} info={info} onRestarted={loadInfo} />}
        </div>
      </main>
      {task && (
        <TaskPanel
          key={task}
          id={task}
          focus={focus ?? undefined}
          nav={nav}
          onClose={() => setTask(null)}
          onBack={back ?? undefined}
          onForward={forward ?? undefined}
        />
      )}
      <Toaster />
      <Lightbox />
      {palette && (
        <Palette
          nav={nav}
          tasks={allTasks.data ?? tasks.data ?? []}
          open={findTask(allTasks.data ?? tasks.data ?? [], task)}
          onMove={mover.request}
          onNew={() => setCreating(true)}
          onHelp={() => setHelp(true)}
          onClose={() => setPalette(false)}
        />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {mover.dialog}
      {moveError && (
        <div className="animate-rise fixed right-5 bottom-5 z-50 flex max-w-md items-start gap-3 rounded-xl border border-bad/30 bg-ink-850 px-4 py-3 text-sm text-bad shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]">
          <span className="flex-1">{moveError}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setMoveError(null)}
            className="text-fg-3 hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {creating && (
        <NewTask
          me={me}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setTask(id);
          }}
        />
      )}
      {addAgent && (
        <AddAgentDialog
          key={addAgent.id}
          id={addAgent.id}
          onAdded={addAgent.onAdded}
          onClose={() => setAddAgent(null)}
        />
      )}
    </div>
  );
}

function NavItem(props: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  count?: { n: number; tone: string };
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      onClick={props.onClick}
      className={cx(
        'group relative flex w-full items-center gap-2.5 rounded-lg px-3 py-[7px] text-left text-sm transition',
        props.active ? 'bg-white/7 text-fg' : 'text-fg-3 hover:bg-white/4 hover:text-fg-2',
      )}
    >
      {props.active && (
        <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-signal shadow-[0_0_10px_rgba(92,225,230,0.9)]" />
      )}
      <Icon
        size={16}
        className={props.active ? 'text-signal' : 'text-fg-4 group-hover:text-fg-3'}
        strokeWidth={2}
      />
      <span className="flex-1">{props.label}</span>
      {props.count && props.count.n > 0 && (
        <span
          className="min-w-5 rounded-full px-1.5 text-center font-mono text-[11px] font-semibold"
          style={{
            color: props.count.tone,
            background: `color-mix(in oklab, ${props.count.tone} 15%, transparent)`,
          }}
        >
          {props.count.n}
        </span>
      )}
    </button>
  );
}
