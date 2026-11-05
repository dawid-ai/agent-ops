import type { LucideIcon } from 'lucide-react';
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Cpu,
  Download,
  FileText,
  PenLine,
  Stethoscope,
  FolderGit2,
  Gauge,
  BellRing,
  Library,
  Mic,
  Network,
  Pause,
  Play,
  Plus,
  Power,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  Trash2,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { Nav } from '../App';
import { api, bridge, q, refreshSoon, useData, useUpdate } from '../api';
import {
  Button,
  ErrorLine,
  Field,
  Input,
  Section,
  Select,
  Toggle,
  toast,
  useAction,
  Who,
  cx,
} from '../components';
import { identity } from '../lib/identity';
import { joinArgs, splitArgs } from '../lib/thread';
import type {
  Agent,
  Check,
  DesktopView,
  DirectoryItem,
  Info,
  ServiceAction,
  ServiceState,
  Settings as SettingsData,
  VoiceView,
} from '../types';
import { ProviderMark } from '../ui/identity';
import { RoleEditor } from '../ui/roles';
import { setVoiceView } from '../ui/voice';

type Patch = Record<string, unknown>;

/** A number field: empty means "use the default" (sent as null). */
function num(v: string): number | null {
  if (v.trim() === '') return null;
  return Number(v);
}

/**
 * opsd's settings, written to your user config (comments kept) and applied at once. Provider
 * commands change only through the main process, after a system dialog shows the exact command.
 */
export function Settings({
  nav,
  info,
  onRestarted,
}: {
  nav: Nav;
  info: Info | null;
  onRestarted: () => void;
}) {
  const { data, error, reload } = useData<SettingsData>('/api/settings');
  const agents = useData<Agent[]>('/api/agents');
  return (
    <Section
      title="Settings"
      icon={SettingsIcon}
      subtitle={data ? `Saved to ${data.path}` : 'opsd and the user config'}
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-5 p-6">
        <ErrorLine error={error} />
        <OpsdCard info={info} me={nav.me} onRestarted={onRestarted} />
        <UpdatesCard />
        <VoiceCard />
        <HealthCard />
        {data && (
          <>
            <RootsCard data={data} onSaved={reload} />
            <MasterCard data={data} onSaved={reload} />
            <NotifyCard data={data} onSaved={reload} />
            <LimitsCard data={data} onSaved={reload} />
            <ProvidersCard data={data} onSaved={reload} />
            <RoleFilesCard me={nav.me} />
            <RolesCard data={data} onSaved={reload} />
            <AgentsCard data={data} agents={agents.data ?? []} onSaved={reload} />
          </>
        )}
      </div>
    </Section>
  );
}

function Card(props: {
  icon: LucideIcon;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <section className="panel animate-rise">
      <header className="flex items-start gap-3 border-b border-white/6 px-5 py-3.5">
        <Icon size={18} className="mt-0.5 text-signal" />
        <div>
          <h2 className="font-display text-base font-semibold tracking-wide">{props.title}</h2>
          {props.hint && <div className="text-xs text-fg-3">{props.hint}</div>}
        </div>
      </header>
      <div className="px-5 py-4">{props.children}</div>
      {props.footer && (
        <footer className="flex items-center gap-3 border-t border-white/6 px-5 py-3">
          {props.footer}
        </footer>
      )}
    </section>
  );
}

/** Saves one card's patch and shows the result next to its button. */
function useSave(onSaved: () => void) {
  const act = useAction();
  const [saved, setSaved] = useState(false);
  return {
    act,
    saved,
    save: (patch: Patch) => {
      setSaved(false);
      act.run(
        () => api('POST', '/api/settings', { patch }),
        () => {
          setSaved(true);
          onSaved();
          refreshSoon();
        },
      );
    },
  };
}

function SaveBar({
  s,
  dirty,
  onSave,
}: {
  s: ReturnType<typeof useSave>;
  dirty: boolean;
  onSave: () => void;
}) {
  return (
    <>
      <Button kind="primary" size="sm" icon={Save} disabled={!dirty || s.act.busy} onClick={onSave}>
        Save
      </Button>
      {s.saved && !dirty && <span className="text-xs text-ok">Saved and applied</span>}
      <div className="min-w-0 flex-1">
        <ErrorLine error={s.act.error} />
      </div>
    </>
  );
}

const CHECK_LOOK: Record<Check['status'], { icon: LucideIcon; color: string }> = {
  ok: { icon: CircleCheck, color: '#3ddc97' },
  warn: { icon: CircleAlert, color: '#ffb547' },
  fail: { icon: CircleX, color: '#ff5d6c' },
};

/** The same checks as `ops doctor`, run by opsd on the setup it uses. */
function HealthCard() {
  const { data, error, reload } = useData<Check[]>('/api/doctor');
  const checks = data ?? [];
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  return (
    <Card
      icon={Stethoscope}
      title="Health checks"
      hint={
        data
          ? fails + warns === 0
            ? 'Everything checks out'
            : `${fails} failing, ${warns} to look at · same as ops doctor`
          : 'Config, roots, runtimes, opsd, memory and disk'
      }
      footer={
        <Button size="sm" icon={RefreshCw} onClick={reload}>
          Check again
        </Button>
      }
    >
      <ErrorLine error={error} />
      <div className="flex flex-col divide-y divide-white/5">
        {checks.map((c) => {
          const look = CHECK_LOOK[c.status];
          const Icon = look.icon;
          return (
            <div key={c.id} className="flex items-start gap-3 py-2">
              <Icon size={16} className="mt-0.5 shrink-0" style={{ color: look.color }} />
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  <span className="font-medium text-fg">{c.label}</span>
                  <span className="text-fg-3"> · {c.detail}</span>
                </div>
                {c.fix && c.status !== 'ok' && (
                  <div className="mt-0.5 text-xs" style={{ color: look.color }}>
                    {c.fix}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function serviceText(s: ServiceState): { text: string; tone: string } {
  if (!s.running)
    return { text: s.paused ? 'Stopped, starts paused' : 'Stopped', tone: 'text-fg-3' };
  const runs = s.live === 1 ? '1 live run' : `${s.live} live runs`;
  if (!s.paused) return { text: `Running · ${runs}`, tone: 'text-ok' };
  return {
    text: s.live === 0 ? 'Paused · no live runs' : `Paused · ${runs} finishing`,
    tone: 'text-warn',
  };
}

const UPDATE_TEXT: Record<string, string> = {
  off: 'Updates come with the installed app. This copy runs from a checkout: update it with git.',
  idle: 'Looks for a new version a minute after start and every 4 hours.',
  checking: 'Looking for a new version…',
  none: 'You have the newest version.',
  downloading: 'Downloading',
  ready: 'Downloaded. It installs on its own once no agent run is live and the window is closed.',
  error: 'The last check failed',
};

/** The installed app's version and its updates from GitHub Releases. */
function UpdatesCard() {
  const u = useUpdate();
  const act = useAction();
  if (!u) return null;
  const text =
    u.status === 'downloading'
      ? `${UPDATE_TEXT.downloading} ${u.version ?? ''}: ${Math.round(u.percent ?? 0)}%`
      : u.status === 'error'
        ? `${UPDATE_TEXT.error}: ${u.error ?? 'unknown error'}`
        : UPDATE_TEXT[u.status];
  return (
    <Card icon={Download} title="Updates" hint="The app, opsd and the ops command update together">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
        <div>
          <div className="label-caps">Version</div>
          <div className="mt-1 font-mono text-xs text-fg-2">{u.current}</div>
        </div>
        {u.version && u.version !== u.current && (
          <div>
            <div className="label-caps">New</div>
            <div className="mt-1 font-mono text-xs text-signal">{u.version}</div>
          </div>
        )}
        <div className="min-w-0 flex-1 text-xs text-fg-3">{text}</div>
        {u.status !== 'off' && (
          <div className="flex gap-2">
            {u.status === 'ready' ? (
              <Button
                icon={RefreshCw}
                kind="primary"
                disabled={act.busy}
                onClick={() =>
                  act.run(async () => {
                    const res = await bridge().update('install');
                    if (!res.ok) throw new Error(res.error ?? 'install failed');
                  })
                }
              >
                Restart and install
              </Button>
            ) : (
              <Button
                icon={RefreshCw}
                disabled={act.busy || u.status === 'checking' || u.status === 'downloading'}
                onClick={() =>
                  act.run(async () => {
                    const res = await bridge().update('check');
                    if (!res.ok) throw new Error(res.error ?? 'check failed');
                  })
                }
              >
                Check now
              </Button>
            )}
          </div>
        )}
      </div>
      {u.notes && u.status !== 'none' && (
        <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-white/3 p-3 font-sans text-xs whitespace-pre-wrap text-fg-3">
          {u.notes}
        </pre>
      )}
      <div className="mt-2">
        <ErrorLine error={act.error} />
      </div>
    </Card>
  );
}

function OpsdCard({
  info,
  me,
  onRestarted,
}: {
  info: Info | null;
  me: string | null;
  onRestarted: () => void;
}) {
  const act = useAction();
  const [note, setNote] = useState<string | null>(null);
  const [view, setView] = useState<DesktopView | null>(null);
  useEffect(() => {
    let live = true;
    void bridge()
      .desktop()
      .then((res) => live && res.ok && res.data && setView(res.data));
    // The tray changes the same state: follow it.
    const off = bridge().onService((m) => {
      if (live) setView((v) => (v ? { ...v, state: m as ServiceState } : v));
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const st = view?.state;
  const run = (action: ServiceAction, done: string): void =>
    act.run(async () => {
      const res = await bridge().service(action);
      if (!res.ok || !res.data) throw new Error(res.error ?? `${action} failed`);
      setView((v) => (v ? { ...v, state: res.data! } : v));
      setNote(done);
      if (action === 'start' || action === 'restart') onRestarted();
    });
  const set = (patch: { notify?: boolean; login?: boolean }, done: string): void =>
    act.run(async () => {
      const res = await bridge().desktopSet(patch);
      if (!res.ok || !res.data) throw new Error(res.error ?? 'not saved');
      setView(res.data);
      setNote(done);
    });
  const status = st ? serviceText(st) : null;
  return (
    <Card
      icon={Cpu}
      title="Background service (opsd)"
      hint="The supervisor on this PC: it starts, watches and stops agent runs, runs schedules and syncs"
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
        <div>
          <div className="label-caps">Status</div>
          <div className={cx('mt-1 text-sm font-medium', status?.tone ?? 'text-fg-3')}>
            {status?.text ?? '…'}
          </div>
        </div>
        <div>
          <div className="label-caps">You</div>
          <div className="mt-1">
            <Who id={me} />
          </div>
        </div>
        <div>
          <div className="label-caps">Process</div>
          <div className="mt-1 font-mono text-xs text-fg-2">
            {st && !st.running
              ? 'not running'
              : `pid ${info?.pid ?? '-'} · 127.0.0.1:${info?.port ?? '-'} · ${info?.version ?? '-'}`}
          </div>
        </div>
        <div>
          <div className="label-caps">Build</div>
          <div className={cx('mt-1 text-xs', info?.stale ? 'text-warn' : 'text-ok')}>
            {info?.stale ? 'older than this app: restart it' : 'current'}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {st?.running ? (
          <Button icon={Power} disabled={act.busy} onClick={() => run('stop', 'opsd stopped')}>
            Stop
          </Button>
        ) : (
          <Button
            icon={Play}
            kind="primary"
            disabled={act.busy || !st}
            onClick={() => run('start', 'opsd started')}
          >
            Start
          </Button>
        )}
        {st?.paused ? (
          <Button
            icon={Play}
            disabled={act.busy}
            onClick={() => run('resume', 'New runs start again')}
          >
            Resume new runs
          </Button>
        ) : (
          <Button
            icon={Pause}
            disabled={act.busy || !st}
            onClick={() => run('pause', 'Paused: no new runs or schedules start')}
          >
            Pause new runs
          </Button>
        )}
        <Button
          icon={RefreshCw}
          disabled={act.busy || !st?.running}
          onClick={() => run('restart', 'opsd restarted')}
        >
          Restart
        </Button>
      </div>
      <div className="mt-2 text-xs text-fg-4">
        {st && !st.runsOutlive
          ? 'This opsd ends its runs when it stops: with runs live, Stop and Restart ask before they end them. To let runs finish first, pause new runs and stop when none are live.'
          : 'Stop and Restart never stop a run: live runs keep going and the next opsd picks them up.'}{' '}
        Pause starts no new runs or schedules until you resume, also after a restart; live runs
        finish, and sync goes on.
      </div>
      {view && (
        <div className="mt-5 grid gap-4 border-t border-white/6 pt-4 sm:grid-cols-2">
          <div>
            <div className="label-caps">Start opsd</div>
            <div className="mt-2 flex flex-col gap-1.5 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="start-opsd"
                  checked={!view.login}
                  disabled={act.busy}
                  onChange={() => set({ login: false }, 'opsd starts when you open the app')}
                />
                When I open the app
              </label>
              <label
                className={cx('flex items-center gap-2', !view.loginSupported && 'opacity-50')}
              >
                <input
                  type="radio"
                  name="start-opsd"
                  checked={view.login}
                  disabled={act.busy || !view.loginSupported}
                  onChange={() =>
                    set({ login: true }, 'Agent Ops starts in the tray when you sign in')
                  }
                />
                When I sign in to Windows
              </label>
            </div>
            <div className="mt-1.5 text-xs text-fg-4">
              {view.loginSupported
                ? 'Sign-in starts the app in the tray with no window, and it starts opsd. Windows lists it under Task Manager > Startup apps.'
                : 'Starting at sign-in works on Windows only for now.'}
            </div>
            {view.loginOff && (
              <div className="mt-1.5 text-xs text-warn">
                The sign-in entry is turned off in Task Manager &gt; Startup apps. Pick{' '}
                <span className="font-medium">When I sign in to Windows</span> to turn it on.
              </div>
            )}
            {view.loginOther && (
              <div className="mt-1.5 text-xs text-warn">
                The sign-in entry starts another copy or folder:{' '}
                <span className="break-all font-mono">{view.loginOther}</span>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <Button
                    disabled={act.busy}
                    onClick={() => set({ login: true }, 'The sign-in entry starts this app now')}
                  >
                    Start this app instead
                  </Button>
                  <Button
                    disabled={act.busy}
                    onClick={() => set({ login: false }, 'Sign-in entry removed')}
                  >
                    Remove the entry
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="label-caps">Notifications</div>
            <div className="mt-2">
              <Toggle
                checked={view.notify}
                onChange={(v) => set({ notify: v }, v ? 'Notifications on' : 'Notifications off')}
                label="Notify me when I'm needed"
              />
            </div>
            <div className="mt-1.5 text-xs text-fg-4">
              A Windows notification for each new question, review or vote addressed to you.
              Clicking it opens the task.
            </div>
          </div>
          <div className="text-xs text-fg-4 sm:col-span-2">
            The tray icon (bottom right of the taskbar) shows the same status: green running, amber
            paused, grey stopped, with a blue dot when something needs you. Right-click it to start,
            stop, pause or restart opsd without opening this window. Closing the window keeps the
            tray icon; <span className="text-fg-3">Quit</span> in its menu closes the app, and opsd
            keeps running.
          </div>
        </div>
      )}
      {note && <div className="mt-2 text-xs text-ok">{note}</div>}
      <div className="mt-2">
        <ErrorLine error={act.error} />
      </div>
    </Card>
  );
}

const VOICE_LANGUAGES: Array<[string, string]> = [
  ['auto', 'Detect'],
  ['en', 'English'],
  ['pl', 'Polish'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['pt', 'Portuguese'],
  ['uk', 'Ukrainian'],
];

const VOICE_ENGINES: Array<[VoiceView['engine'], string, string]> = [
  ['off', 'Off', 'No microphone button records.'],
  [
    'local',
    'On this PC (whisper.cpp)',
    'Recordings never leave this PC. Needs whisper.cpp and a model file.',
  ],
  [
    'cloud',
    'OpenAI',
    'Recordings go to OpenAI and the text comes back. Needs OPENAI_API_KEY; you confirm before it turns on.',
  ],
];

/**
 * Voice input for the composers' microphone button. The whisper.cpp program is picked in a system
 * dialog only, and the cloud engine asks for confirmation, both in the main process.
 */
function VoiceCard() {
  const act = useAction();
  const [view, setView] = useState<VoiceView | null>(null);
  useEffect(() => {
    let live = true;
    void bridge()
      .voice()
      .then((res) => live && res.ok && res.data && setView(res.data));
    return () => {
      live = false;
    };
  }, []);
  const apply = (call: () => ReturnType<ReturnType<typeof bridge>['voice']>): void =>
    act.run(async () => {
      const res = await call();
      if (res.error === 'cancelled') return;
      if (!res.ok || !res.data) throw new Error(res.error ?? 'not saved');
      setView(res.data);
      setVoiceView(res.data);
    });
  if (!view) return null;
  const pathRow = (kind: 'program' | 'model', label: string, value: string | null) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="label-caps w-20">{label}</span>
      <span
        className={cx(
          'min-w-0 flex-1 break-all font-mono text-xs',
          value ? 'text-fg-2' : 'text-fg-4',
        )}
      >
        {value ?? 'not picked'}
      </span>
      <Button size="sm" disabled={act.busy} onClick={() => apply(() => bridge().voiceBrowse(kind))}>
        {value ? 'Change' : 'Pick file'}
      </Button>
    </div>
  );
  return (
    <Card
      icon={Mic}
      title="Voice input"
      hint="The microphone button in every composer: click to start and stop, or hold to talk; the text goes in at the cursor"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 text-sm">
          <div className="label-caps">Speech to text</div>
          {VOICE_ENGINES.map(([engine, label, hint]) => (
            <label key={engine} className="flex items-start gap-2">
              <input
                type="radio"
                name="voice-engine"
                className="mt-1"
                checked={view.engine === engine}
                disabled={act.busy}
                onChange={() => apply(() => bridge().voiceSet({ engine }))}
              />
              <span>
                {label}
                <span className="block text-xs text-fg-4">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        <Field
          label="Language"
          hint="Detect works for most speech; pick the language when short phrases come out in the wrong one."
        >
          <Select
            value={view.language}
            options={
              VOICE_LANGUAGES.some(([code]) => code === view.language)
                ? VOICE_LANGUAGES
                : [...VOICE_LANGUAGES, [view.language, view.language]]
            }
            onChange={(language) => apply(() => bridge().voiceSet({ language }))}
          />
        </Field>
      </div>
      {view.engine === 'local' && (
        <div className="mt-4 flex flex-col gap-2 border-t border-white/6 pt-4">
          {pathRow('program', 'Program', view.program)}
          {pathRow('model', 'Model', view.model)}
          <div className="text-xs text-fg-4">
            Get <span className="font-mono">whisper-cli.exe</span> from the{' '}
            <a
              className="text-signal hover:underline"
              href="https://github.com/ggml-org/whisper.cpp/releases"
              target="_blank"
              rel="noreferrer"
            >
              whisper.cpp releases
            </a>{' '}
            (<span className="font-mono">whisper-bin-x64.zip</span>) and a model from{' '}
            <a
              className="text-signal hover:underline"
              href="https://huggingface.co/ggerganov/whisper.cpp/tree/main"
              target="_blank"
              rel="noreferrer"
            >
              the model list
            </a>
            : <span className="font-mono">ggml-base.bin</span> (142 MB) is quick on most PCs,{' '}
            <span className="font-mono">ggml-small.bin</span> (466 MB) is more accurate and slower.
            Models ending in <span className="font-mono">.en</span> understand English only.
          </div>
        </div>
      )}
      {view.engine === 'cloud' && (
        <div className="mt-4 border-t border-white/6 pt-4 text-xs text-fg-4">
          Model <span className="font-mono text-fg-2">{view.cloudModel}</span> (change it with{' '}
          <span className="font-mono">desktop.voice.cloud_model</span> in the user config).{' '}
          {view.cloudKey ? (
            <span className="text-ok">OPENAI_API_KEY is set.</span>
          ) : (
            <span className="text-warn">
              Set OPENAI_API_KEY for your Windows user, then quit the app from the tray and open it
              again.
            </span>
          )}{' '}
          The app reads the key from its environment and never stores it.
        </div>
      )}
      {view.engine !== 'off' && view.problem && (
        <div className="mt-3 text-xs text-warn">{view.problem}</div>
      )}
      <div className="mt-3 text-xs text-fg-4">
        Only this app's own page may use the microphone, and only while voice input is on. If
        recording fails, allow desktop apps to use the microphone in Windows Settings &gt; Privacy
        &amp; security &gt; Microphone.
      </div>
      <div className="mt-2">
        <ErrorLine error={act.error} />
      </div>
    </Card>
  );
}

function RootsCard({ data, onSaved }: { data: SettingsData; onSaved: () => void }) {
  const [roots, setRoots] = useState(data.roots);
  const [add, setAdd] = useState('');
  useEffect(() => setRoots(data.roots), [data.roots]);
  const s = useSave(onSaved);
  const dirty = JSON.stringify(roots) !== JSON.stringify(data.roots);
  return (
    <Card
      icon={FolderGit2}
      title="Data roots"
      hint="Repos with .agent-ops/ (or dedicated data repos) whose tasks this PC loads"
      footer={<SaveBar s={s} dirty={dirty} onSave={() => s.save({ roots })} />}
    >
      <ul className="flex flex-col gap-1.5">
        {roots.map((r) => (
          <li
            key={r}
            className="flex items-center gap-2 rounded-lg bg-white/3 px-3 py-2 font-mono text-xs"
          >
            <FolderGit2 size={14} className="text-fg-4" />
            <span className="flex-1 truncate">{r}</span>
            <button
              className="rounded p-1 text-fg-4 hover:bg-bad/15 hover:text-bad"
              onClick={() => setRoots(roots.filter((x) => x !== r))}
              aria-label={`Remove ${r}`}
            >
              <Trash2 size={13} />
            </button>
          </li>
        ))}
        {roots.length === 0 && (
          <li className="text-xs text-fg-4">
            None listed: opsd finds the root of the folder it started in.
          </li>
        )}
      </ul>
      <div className="mt-3 flex gap-2">
        <Input
          value={add}
          onChange={setAdd}
          placeholder="C:\dev\my-project"
          className="flex-1 font-mono"
          onEnter={() => add.trim() && (setRoots([...roots, add.trim()]), setAdd(''))}
        />
        <Button
          icon={Plus}
          disabled={!add.trim()}
          onClick={() => {
            setRoots([...roots, add.trim()]);
            setAdd('');
          }}
        >
          Add
        </Button>
      </div>
      <div className="mt-2 text-xs text-fg-4">
        opsd checks each folder is a data root when you save.
      </div>
    </Card>
  );
}

const NOTIFY_KINDS: Array<[string, string]> = [
  ['ask', 'Questions for you'],
  ['review', 'Reviews for you'],
  ['triage', 'Findings to triage'],
  ['decide', 'Decisions to take'],
  ['mention', 'Mentions'],
  ['message', 'Messages'],
  ['run-failed', 'Failed runs'],
];

/**
 * A webhook (Discord or Slack incoming webhook) that gets your inbox items while the app is
 * closed. The URL is a secret: opsd stores it in your user config and never shows it again.
 */
function NotifyCard({ data, onSaved }: { data: SettingsData; onSaved: () => void }) {
  const [url, setUrl] = useState('');
  const s = useSave(onSaved);
  const test = useAction();
  const [tested, setTested] = useState<string | null>(null);
  const kinds = data.notify.kinds ?? NOTIFY_KINDS.map(([k]) => k);
  return (
    <Card
      icon={BellRing}
      title="Notifications"
      hint={
        data.notify.webhook
          ? 'A webhook is set: new inbox items and failed runs are posted there, at most 6 messages per 10 minutes'
          : 'Post new inbox items and failed runs to a Discord or Slack webhook while the app is closed'
      }
      footer={
        <>
          <Button
            kind="primary"
            size="sm"
            disabled={!url.trim() || s.act.busy}
            onClick={() => {
              s.save({ notify: { webhook: url.trim() } });
              setUrl('');
            }}
          >
            {data.notify.webhook ? 'Replace webhook' : 'Save webhook'}
          </Button>
          {data.notify.webhook && (
            <>
              <Button
                size="sm"
                disabled={test.busy}
                onClick={() =>
                  test.run(async () => {
                    const r = await api<{ ok: boolean; error?: string }>(
                      'POST',
                      '/api/notify/test',
                      {},
                    );
                    setTested(r.ok ? 'Sent a test message' : (r.error ?? 'The test failed'));
                  })
                }
              >
                Send a test
              </Button>
              <Button size="sm" kind="ghost" onClick={() => s.save({ notify: { webhook: null } })}>
                Remove
              </Button>
            </>
          )}
          {tested && <span className="text-xs text-fg-3">{tested}</span>}
          <div className="min-w-0 flex-1">
            <ErrorLine error={s.act.error ?? test.error} />
          </div>
        </>
      }
    >
      <Field label={data.notify.webhook ? 'New webhook URL' : 'Webhook URL'}>
        <input
          type="password"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/..."
          autoComplete="off"
          className="h-[34px] w-full rounded-lg border border-white/10 bg-ink-950/60 px-3 font-mono text-sm text-fg outline-none focus:border-signal/50"
        />
      </Field>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {NOTIFY_KINDS.map(([k, label]) => (
          <Toggle
            key={k}
            checked={kinds.includes(k)}
            label={label}
            onChange={(on) =>
              s.save({
                notify: { kinds: on ? [...kinds, k] : kinds.filter((x) => x !== k) },
              })
            }
          />
        ))}
      </div>
    </Card>
  );
}

/** The Agent Ops Master Repo and which project roots mirror into it. */
function MasterCard({ data, onSaved }: { data: SettingsData; onSaved: () => void }) {
  const [master, setMaster] = useState(data.master ?? '');
  useEffect(() => setMaster(data.master ?? ''), [data.master]);
  const s = useSave(onSaved);
  const toggle = useAction();
  const dirty = master.trim() !== (data.master ?? '');
  const projects = data.rootList.filter((r) => !r.isMirror && !r.isMaster);
  const copies = data.rootList.filter((r) => r.isMirror);
  return (
    <Card
      icon={Library}
      title="Agent Ops Master Repo"
      hint="One data repo for every project. Project roots that mirror into it sync both ways."
      footer={
        <SaveBar
          s={s}
          dirty={dirty}
          onSave={() => s.save({ master: master.trim() ? master.trim() : null })}
        />
      }
    >
      <Field label="Master Repo folder">
        <Input
          value={master}
          onChange={setMaster}
          placeholder="C:\dev\agent-ops-master"
          className="w-full font-mono"
        />
      </Field>
      <div className="mt-4 flex flex-col gap-1.5">
        <div className="label-caps">Project roots</div>
        {projects.length === 0 && <div className="text-xs text-fg-4">No project roots loaded.</div>}
        {projects.map((r) => (
          <div
            key={r.dir}
            className="flex items-center gap-3 rounded-lg bg-white/3 px-3 py-2 text-sm"
          >
            <Network size={14} className={r.mirror ? 'text-signal' : 'text-fg-4'} />
            <span className="font-mono text-xs">{r.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-4">{r.dir}</span>
            <Toggle
              checked={r.mirror}
              label="Mirror"
              onChange={(on) =>
                toggle.run(
                  () => api('POST', `/api/roots/${q(r.name)}/mirror`, { on }),
                  () => {
                    onSaved();
                    refreshSoon();
                  },
                )
              }
            />
          </div>
        ))}
        <ErrorLine error={toggle.error} />
        {copies.length > 0 && (
          <div className="mt-2 text-xs text-fg-3">
            In the Master Repo only (no checkout here): {copies.map((c) => c.name).join(', ')}. Runs
            on their tasks need a folder: set the agent's cwd in the user config.
          </div>
        )}
        {!data.master && projects.some((r) => r.mirror) && (
          <div className="mt-2 text-xs text-warn">
            Mirroring is on, but no Master Repo is set: nothing is copied until you set one.
          </div>
        )}
      </div>
    </Card>
  );
}

const LIMITS: Array<{ key: string; label: string; hint: string; step?: string }> = [
  {
    key: 'max_runs',
    label: 'Runs on this PC',
    hint: 'Most live runs at once; default one per CPU core',
  },
  { key: 'min_free_gb', label: 'Free memory (GB)', hint: 'No new run below this', step: '0.5' },
  {
    key: 'review_backlog',
    label: 'Review backlog',
    hint: 'Reviews waiting in a project before writers pause there',
  },
  {
    key: 'budget_minutes',
    label: 'Default budget (min)',
    hint: 'When neither the task nor the agent sets one',
  },
  {
    key: 'wake_cooldown_minutes',
    label: 'Wake cooldown (min)',
    hint: 'Before an agent is woken again for the same items',
  },
  {
    key: 'usage_cooldown_minutes',
    label: 'Limit cooldown (min)',
    hint: 'Pause after a usage-limit error that names no reset',
  },
];

function LimitsCard({ data, onSaved }: { data: SettingsData; onSaved: () => void }) {
  const initial = (): Record<string, string> =>
    Object.fromEntries(
      LIMITS.map((l) => [
        l.key,
        data.set.includes(l.key)
          ? String((data.opsd as unknown as Record<string, number>)[l.key])
          : '',
      ]),
    );
  const [vals, setVals] = useState(initial);
  const [pause, setPause] = useState(data.opsd.usage_pause_at);
  const [sync, setSync] = useState(data.opsd.sync);
  useEffect(() => {
    setVals(initial());
    setPause(data.opsd.usage_pause_at);
    setSync(data.opsd.sync);
  }, [data]);
  const s = useSave(onSaved);
  const patch: Patch = {};
  for (const l of LIMITS) {
    const was = data.set.includes(l.key)
      ? String((data.opsd as unknown as Record<string, number>)[l.key])
      : '';
    if (vals[l.key] !== was) patch[l.key] = num(vals[l.key]!);
  }
  if (pause !== data.opsd.usage_pause_at) patch.usage_pause_at = pause;
  if (sync !== data.opsd.sync) patch.sync = sync;
  return (
    <Card
      icon={Gauge}
      title="Run limits"
      hint="Empty fields use the default shown in grey"
      footer={
        <SaveBar
          s={s}
          dirty={Object.keys(patch).length > 0}
          onSave={() => s.save({ opsd: patch })}
        />
      }
    >
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {LIMITS.map((l) => (
          <Field key={l.key} label={l.label} hint={l.hint}>
            <Input
              type="number"
              value={vals[l.key] ?? ''}
              onChange={(v) => setVals({ ...vals, [l.key]: v })}
              placeholder={String((data.opsd as unknown as Record<string, number>)[l.key])}
            />
          </Field>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label={`Pause a provider at ${Math.round(pause * 100)}% of its usage window`}
          hint="The rest stays for your own sessions"
        >
          <input
            type="range"
            min={50}
            max={100}
            step={5}
            value={Math.round(pause * 100)}
            onChange={(e) => setPause(Number(e.target.value) / 100)}
            className="accent-[#5ce1e6]"
          />
        </Field>
        <Field label="Sync" hint="Commit, pull and push each root on its sync policy">
          <Toggle checked={sync} onChange={setSync} label={sync ? 'On' : 'Off'} />
        </Field>
      </div>
    </Card>
  );
}

/**
 * Every provider in the config, seeded ones included: the model, limits and pause save through
 * opsd's API; the program, arguments and environment through the main process (Edit), which
 * shows the exact command in a system dialog first. Remove and Reset to default ask here first.
 */
function ProvidersCard({ data, onSaved }: { data: SettingsData; onSaved: () => void }) {
  const toStr = (v?: number): string => (v === undefined ? '' : String(v));
  type Row = { model: string; max_live: string; pause_at: string; paused: boolean };
  const initial = (): Record<string, Row> =>
    Object.fromEntries(
      Object.entries(data.opsd.runtimes).map(([n, r]) => [
        n,
        {
          model: r.model ?? '',
          max_live: toStr(r.max_live),
          pause_at: r.pause_at === undefined ? '' : String(Math.round(r.pause_at * 100)),
          paused: r.paused,
        },
      ]),
    );
  const [vals, setVals] = useState(initial);
  useEffect(() => setVals(initial()), [data]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /** A Remove or Reset waiting for its second click. */
  const [confirm, setConfirm] = useState<{ name: string; what: 'remove' | 'reset' } | null>(null);
  const act = useAction();
  const s = useSave(onSaved);
  const patch: Record<string, Patch> = {};
  for (const [n, r] of Object.entries(data.opsd.runtimes)) {
    const v = vals[n];
    if (!v) continue;
    const p: Patch = {};
    if (v.model.trim() !== (r.model ?? '')) p.model = v.model.trim() || null;
    if (v.max_live !== toStr(r.max_live)) p.max_live = num(v.max_live);
    const pa = r.pause_at === undefined ? '' : String(Math.round(r.pause_at * 100));
    if (v.pause_at !== pa) p.pause_at = v.pause_at === '' ? null : Number(v.pause_at) / 100;
    if (v.paused !== r.paused) p.paused = v.paused ? true : null;
    if (Object.keys(p).length > 0) patch[n] = p;
  }
  /** Removes a provider (`null`) or restores its seeded entry (`'default'`) through opsd. */
  const change = (n: string, to: null | 'default', done: string): void =>
    act.run(
      () => api('POST', '/api/settings', { patch: { opsd: { runtimes: { [n]: to } } } }),
      () => {
        setConfirm(null);
        toast(done);
        onSaved();
        refreshSoon();
      },
    );
  const missing = data.missingDefaults ?? [];
  return (
    <Card
      icon={Cpu}
      title="Providers"
      hint="The programs agent runs start, all editable. Paused: no new runs; live runs go on. Usage windows come from each run's output."
      footer={
        <SaveBar
          s={s}
          dirty={Object.keys(patch).length > 0}
          onSave={() => s.save({ opsd: { runtimes: patch } })}
        />
      }
    >
      <div className="flex flex-col gap-2">
        {Object.keys(data.opsd.runtimes).length === 0 && (
          <div className="text-sm text-warn">
            No providers: no agent run can start. Add one, or add a default back below.
          </div>
        )}
        {Object.entries(data.opsd.runtimes).map(([n, r]) => {
          const p = identity(`${n}:x`).provider;
          const v = vals[n];
          if (!v) return null;
          const line = [r.command, ...(r.args ?? [])].join(' ');
          const uses = r.agents ?? [];
          const asking = confirm?.name === n ? confirm.what : null;
          return (
            <div
              key={n}
              className={cx(
                'flex flex-col gap-2 rounded-xl bg-white/3 px-4 py-3',
                v.paused && 'opacity-70',
              )}
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <ProviderMark runtime={n} size={20} />
                <div className="w-44 min-w-0">
                  <div
                    className="font-display font-semibold tracking-wide"
                    style={{ color: p.color }}
                  >
                    {p.label}
                  </div>
                  <div className="truncate font-mono text-[11px] text-fg-4" title={line}>
                    {line}
                  </div>
                  {r.found !== undefined && (
                    <div
                      className={cx('truncate text-[11px]', r.found ? 'text-ok' : 'text-warn')}
                      title={r.found ?? `${r.command} is not on opsd's PATH`}
                    >
                      {r.found ? 'found on PATH' : 'not found on PATH'}
                    </div>
                  )}
                </div>
                <Field
                  label="Model"
                  className="w-36"
                  hint={n === 'claude' || n === 'codex' ? undefined : 'Claude and Codex only'}
                >
                  <Input
                    value={v.model}
                    onChange={(x) => setVals({ ...vals, [n]: { ...v, model: x } })}
                    placeholder="its default"
                    className="font-mono"
                  />
                </Field>
                <Field label="Most live runs" className="w-28">
                  <Input
                    type="number"
                    value={v.max_live}
                    onChange={(x) => setVals({ ...vals, [n]: { ...v, max_live: x } })}
                    placeholder="no limit"
                  />
                </Field>
                <Field label="Pause at (%)" className="w-24">
                  <Input
                    type="number"
                    value={v.pause_at}
                    onChange={(x) => setVals({ ...vals, [n]: { ...v, pause_at: x } })}
                    placeholder={String(Math.round(data.opsd.usage_pause_at * 100))}
                  />
                </Field>
                <div className="ml-auto">
                  <Toggle
                    checked={!v.paused}
                    onChange={(on) => setVals({ ...vals, [n]: { ...v, paused: !on } })}
                    label={v.paused ? 'Paused' : 'Running'}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-4">
                <span className="min-w-0 flex-1 truncate">
                  {uses.length > 0 ? `Agents: ${uses.join(', ')}` : 'No agents run on it yet'}
                  {r.unset_env?.length ? ` · removes ${r.unset_env.join(', ')}` : ''}
                </span>
                <Button size="sm" icon={PenLine} onClick={() => setEditing(n)}>
                  Edit
                </Button>
                {r.default && (
                  <Button
                    size="sm"
                    icon={RefreshCw}
                    disabled={act.busy}
                    onClick={() => setConfirm({ name: n, what: 'reset' })}
                  >
                    Reset to default
                  </Button>
                )}
                <Button
                  size="sm"
                  kind="danger"
                  icon={Trash2}
                  disabled={act.busy}
                  onClick={() => setConfirm({ name: n, what: 'remove' })}
                >
                  Remove
                </Button>
              </div>
              {asking && (
                <div className="animate-rise flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-fg-2">
                  <span className="min-w-0 flex-1">
                    {asking === 'remove'
                      ? uses.length > 0
                        ? `${uses.join(', ')} run on ${n}. After you remove it, their runs do not start and say why; live runs go on.`
                        : `Remove ${n}? Live runs go on; role files stay.`
                      : `Reset ${n} to ${[r.default!.command, ...(r.default!.args ?? [])].join(' ')}, with no model, limits or pause?`}
                  </span>
                  <Button
                    size="sm"
                    kind={asking === 'remove' ? 'danger' : 'primary'}
                    disabled={act.busy}
                    onClick={() =>
                      asking === 'remove'
                        ? change(n, null, `Removed ${n}`)
                        : change(n, 'default', `Reset ${n} to default`)
                    }
                  >
                    {asking === 'remove' ? 'Remove' : 'Reset'}
                  </Button>
                  <Button size="sm" kind="ghost" onClick={() => setConfirm(null)}>
                    Cancel
                  </Button>
                </div>
              )}
              {editing === n && (
                <ProviderForm
                  existing={{ name: n, ...r }}
                  taken={[]}
                  onDone={(saved) => {
                    setEditing(null);
                    if (saved) {
                      onSaved();
                      refreshSoon();
                    }
                  }}
                />
              )}
            </div>
          );
        })}
        {missing.map((m) => (
          <div
            key={m.name}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-white/10 px-4 py-2.5 text-xs text-fg-3"
          >
            <ProviderMark runtime={m.name} size={16} />
            <span className="min-w-0 flex-1">
              {m.name} is a default provider you removed.{' '}
              <span className={m.found ? 'text-ok' : 'text-fg-4'}>
                {m.found ? `${m.command} is on PATH.` : `${m.command} is not on PATH.`}
              </span>
            </span>
            <Button
              size="sm"
              icon={Plus}
              disabled={act.busy}
              onClick={() => change(m.name, 'default', `Added ${m.name} back`)}
            >
              Add back
            </Button>
          </div>
        ))}
        <ErrorLine error={act.error} />
        {adding ? (
          <ProviderForm
            taken={Object.keys(data.opsd.runtimes)}
            onDone={(added) => {
              setAdding(false);
              if (added) {
                onSaved();
                refreshSoon();
              }
            }}
          />
        ) : (
          <div>
            <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
              Add provider
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * A new provider, or the program, arguments and removed environment of an existing one. The
 * main process shows the exact command in a system dialog before it saves.
 */
function ProviderForm({
  taken,
  existing,
  onDone,
}: {
  taken: string[];
  existing?: { name: string; command: string; args?: string[]; unset_env?: string[] };
  onDone: (saved: boolean) => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [command, setCommand] = useState(existing?.command ?? '');
  const [args, setArgs] = useState(joinArgs(existing?.args));
  const [unset, setUnset] = useState((existing?.unset_env ?? []).join(' '));
  const act = useAction();
  const n = name.trim().toLowerCase();
  const nameError =
    n && !/^[a-z][a-z0-9-]{0,39}$/.test(n)
      ? 'Lowercase letters, digits and hyphens'
      : !existing && taken.includes(n)
        ? 'That provider exists'
        : null;
  const known = n === 'claude' || n === 'codex';
  const save = (): void =>
    act.run(async () => {
      const res = await bridge().runtime(n, {
        command: command.trim(),
        args: splitArgs(args),
        unset_env: unset
          .split(/[\s,]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      });
      if (res.ok) {
        toast(
          existing
            ? `Saved ${n}: the next run uses it`
            : `Added ${n}: agents ${n}:<role> can run now`,
        );
        onDone(true);
      } else if (res.error !== 'cancelled') throw new Error(res.error);
    });
  return (
    <div className="animate-rise mt-1 flex flex-col gap-3 rounded-xl border border-white/8 p-4">
      <div className="grid grid-cols-[160px_1fr] gap-3">
        <Field
          label="Name"
          hint={nameError ? <span className="text-warn">{nameError}</span> : 'hermes, grok, cursor'}
        >
          <Input
            value={name}
            onChange={setName}
            placeholder="hermes"
            autoFocus={!existing}
            disabled={Boolean(existing)}
          />
        </Field>
        <Field label="Program" hint="A name on PATH or a full path">
          <Input value={command} onChange={setCommand} placeholder="hermes" className="font-mono" />
        </Field>
      </div>
      <Field
        label="Arguments"
        hint={
          known
            ? `Placed before the ones Agent Ops adds for ${n}. Quote values with spaces.`
            : 'The whole command line after the program; the task prompt arrives on standard input. Quote values with spaces.'
        }
      >
        <Input
          value={args}
          onChange={setArgs}
          placeholder={known ? '' : 'run --json -'}
          className="font-mono"
        />
      </Field>
      <Field
        label="Environment to remove"
        hint="Variables its runs must not see, such as GITHUB_TOKEN GH_TOKEN"
      >
        <Input
          value={unset}
          onChange={setUnset}
          placeholder="GITHUB_TOKEN GH_TOKEN"
          className="font-mono"
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          kind="primary"
          size="sm"
          icon={existing ? Save : Plus}
          disabled={!n || Boolean(nameError) || !command.trim() || act.busy}
          onClick={save}
        >
          {existing ? 'Save provider…' : 'Add provider…'}
        </Button>
        <Button size="sm" kind="ghost" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <span className="text-[11px] text-fg-4">
          You confirm the exact command in the next step.
        </span>
      </div>
      <ErrorLine error={act.error} />
    </div>
  );
}

/** Role files in the data roots: create one, or edit what an agent reads before it works. */
function RoleFilesCard({ me }: { me: string | null }) {
  const dir = useData<DirectoryItem[]>('/api/directory');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const files = (dir.data ?? []).filter((d) => d.source === 'role');
  return (
    <Card
      icon={FileText}
      title="Role files"
      hint="agents/<provider>-<role>.md in a data root: instructions, knowledge, writing style. Runs without one use the built-in prompt."
      footer={
        <Button size="sm" kind="primary" icon={Plus} onClick={() => setEditing('new')}>
          Create role
        </Button>
      }
    >
      <ErrorLine error={dir.error} />
      {dir.data && files.length === 0 && (
        <div className="text-sm text-fg-4">
          No role files yet. claude:engineer, codex:qa and the other built-in roles run without one;
          create a role to give an agent its own instructions, such as claude:writer.
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {files.map((f) => (
          <div key={f.id} className="flex items-center gap-3 rounded-xl bg-white/3 px-3 py-2">
            <div className="w-56">
              <Who id={f.id} label />
            </div>
            <span className="min-w-0 flex-1 truncate text-xs text-fg-3">
              {f.name ? `${f.name}${f.description ? ` · ${f.description}` : ''}` : f.description}
            </span>
            {f.status && f.status !== 'active' && (
              <span className="text-xs text-warn">{f.status}</span>
            )}
            <Button size="sm" icon={PenLine} onClick={() => setEditing(f.id)}>
              Edit
            </Button>
          </div>
        ))}
      </div>
      {editing && (
        <RoleEditor
          id={editing === 'new' ? undefined : editing}
          me={me}
          onClose={() => {
            setEditing(null);
            dir.reload();
          }}
        />
      )}
    </Card>
  );
}

function RolesCard({ data, onSaved }: { data: SettingsData; onSaved: () => void }) {
  const roles = Object.keys(data.opsd.roles);
  const initial = (): Record<
    string,
    { per_project: string; burst: string; max_children: string; overflow: boolean }
  > =>
    Object.fromEntries(
      roles.map((r) => {
        const l = data.opsd.roles[r]!;
        return [
          r,
          {
            per_project: String(l.per_project),
            burst: String(l.burst),
            max_children: String(l.max_children),
            overflow: l.overflow,
          },
        ];
      }),
    );
  const [vals, setVals] = useState(initial);
  useEffect(() => setVals(initial()), [data]);
  const s = useSave(onSaved);
  const patch: Record<string, Patch> = {};
  for (const r of roles) {
    const l = data.opsd.roles[r]!;
    const v = vals[r]!;
    const p: Patch = {};
    if (v.per_project !== String(l.per_project)) p.per_project = num(v.per_project);
    if (v.burst !== String(l.burst)) p.burst = num(v.burst);
    if (v.max_children !== String(l.max_children)) p.max_children = num(v.max_children);
    if (v.overflow !== l.overflow) p.overflow = v.overflow;
    if (Object.keys(p).length > 0) patch[r] = p;
  }
  const cell = (r: string, k: 'per_project' | 'burst' | 'max_children') => (
    <Input
      type="number"
      value={vals[r]![k]}
      onChange={(v) => setVals({ ...vals, [r]: { ...vals[r]!, [k]: v } })}
      className="w-20"
    />
  );
  return (
    <Card
      icon={Users}
      title="Role limits"
      hint="Per project: live runs of a role on one project. Burst: while reviews pile up. Helpers: ops spawn runs per run."
      footer={
        <SaveBar
          s={s}
          dirty={Object.keys(patch).length > 0}
          onSave={() => s.save({ opsd: { roles: patch } })}
        />
      }
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left">
            {['Role', 'Per project', 'Burst', 'Helpers', 'Next provider when full'].map((h) => (
              <th key={h} className="label-caps pb-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => {
            const who = identity(`x:${r}`);
            return (
              <tr key={r} className="border-t border-white/5">
                <td className="py-2">
                  <span className="font-mono" style={{ color: who.roleInfo.color }}>
                    {r}
                  </span>
                  <span className="ml-2 text-xs text-fg-4">
                    {data.opsd.roles[r]!.writes ? 'writes' : 'reads'}
                  </span>
                </td>
                <td>{cell(r, 'per_project')}</td>
                <td>{cell(r, 'burst')}</td>
                <td>{cell(r, 'max_children')}</td>
                <td>
                  <Toggle
                    checked={vals[r]!.overflow}
                    onChange={(v) => setVals({ ...vals, [r]: { ...vals[r]!, overflow: v } })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function AgentsCard({
  data,
  agents,
  onSaved,
}: {
  data: SettingsData;
  agents: Agent[];
  onSaved: () => void;
}) {
  const ids = [...new Set([...agents.map((a) => a.id), ...Object.keys(data.opsd.agents)])]
    .filter((id) => !id.startsWith('human:'))
    .sort();
  const initial = (): Record<string, { wake: boolean; budget: string }> =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        { wake: data.opsd.agents[id]?.wake ?? false, budget: data.opsd.agents[id]?.budget ?? '' },
      ]),
    );
  const [vals, setVals] = useState(initial);
  useEffect(() => setVals(initial()), [data, agents]);
  const s = useSave(onSaved);
  const patch: Record<string, Patch> = {};
  for (const id of ids) {
    const v = vals[id];
    if (!v) continue;
    const p: Patch = {};
    if (v.wake !== (data.opsd.agents[id]?.wake ?? false)) p.wake = v.wake;
    if (v.budget !== (data.opsd.agents[id]?.budget ?? '')) p.budget = v.budget || null;
    if (Object.keys(p).length > 0) patch[id] = p;
  }
  return (
    <Card
      icon={Users}
      title="Agents"
      hint="Wake: opsd starts a run when the agent has new inbox items or a task to claim"
      footer={
        <SaveBar
          s={s}
          dirty={Object.keys(patch).length > 0}
          onSave={() => s.save({ opsd: { agents: patch } })}
        />
      }
    >
      {ids.length === 0 && (
        <div className="text-sm text-fg-4">
          No agents named yet. Create a role in Role files, or turn on wake for an agent in the opsd
          config; built-in roles such as claude:engineer still run from Run agent and schedules.
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {ids.map((id) => (
          <div key={id} className="flex items-center gap-4 rounded-xl bg-white/3 px-3 py-2">
            <div className="w-64">
              <Who id={id} label />
            </div>
            <Toggle
              checked={vals[id]?.wake ?? false}
              onChange={(w) => setVals({ ...vals, [id]: { ...vals[id]!, wake: w } })}
              label="Wake on work"
            />
            <div className="ml-auto flex items-center gap-2 text-xs text-fg-3">
              Budget
              <Input
                value={vals[id]?.budget ?? ''}
                onChange={(b) => setVals({ ...vals, [id]: { ...vals[id]!, budget: b } })}
                placeholder={`${data.opsd.budget_minutes}m`}
                className="w-20"
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
