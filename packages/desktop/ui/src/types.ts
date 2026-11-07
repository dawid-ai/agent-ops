// Shapes the opsd API returns. They mirror @agent-ops/core and @agent-ops/supervisor, which the
// page cannot import because they use Node.

export type Status =
  'todo' | 'claimed' | 'in-progress' | 'blocked' | 'needs-review' | 'done' | 'parked';

export interface Delegation {
  by: string;
  to: string;
  at: string;
  budget_minutes?: number;
  tokens?: number;
  due?: string;
  review?: string;
}

export interface Task {
  id: string;
  root: string;
  title: string;
  type: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  project?: string;
  labels?: string[];
  createdBy?: string;
  createdAt?: string;
  status: Status;
  stale?: boolean;
  unblocked?: boolean;
  archived?: boolean;
  owner: string | null;
  claimedBy: string | null;
  leaseUntil: string | null;
  reviewer: string | null;
  waitingOn: string | null;
  blockedOn?: string[];
  /** blocked: the open ask or block the task waits on, and who it is for. */
  question?: Question & { to: string };
  checkpoint: { summary: string; next?: string; at: string } | null;
  delegation?: Delegation;
  updatedAt: string;
}

export interface OpsEvent {
  id: string;
  type: string;
  actor: string;
  at: string;
  to?: string;
  on?: string[];
  verdict?: string;
  priority?: string;
  /** retype: the new task type. */
  task_type?: string;
  ref?: string;
  run?: string;
  exit?: number | null;
  reason?: string;
  minutes?: number;
  tokens?: number;
  forced?: boolean;
  body: string;
}

export interface TaskDetail {
  task: Task;
  body: string;
  events: OpsEvent[];
}

export interface Question {
  event: string;
  from: string;
  summary: string;
  /** The whole question when it is longer than `summary`, its first line. */
  detail?: string;
}

export interface InboxItem {
  kind:
    'message' | 'ask' | 'review' | 'owned' | 'mention' | 'vote' | 'decide' | 'stranded' | 'triage';
  task: string;
  root: string;
  title: string;
  event?: string;
  from?: string;
  type?: string;
  summary: string;
  at?: string;
  /**
   * The full text when it says more than `summary`, its first line: a review request, message,
   * question or channel mention. Rendered as Markdown.
   */
  detail?: string;
  pr?: string;
  commit?: string;
  branch?: string;
  /** triage: the finding's owner and priority. */
  owner?: string;
  priority?: Task['priority'];
  /** triage: an open question to you, answered together with Accept. */
  question?: Question;
}

export interface RunRecord {
  id: string;
  agent: string;
  task?: string;
  root?: string;
  schedule?: string;
  pid: number;
  cwd: string;
  started_at: string;
  ended_at?: string;
  status: 'running' | 'ended';
  exit?: number | null;
  reason?: string;
  budget_minutes: number;
  token_budget?: number;
  tokens: number;
  procs_left?: number;
  project?: string;
  review?: boolean;
  parent?: string;
  chat?: boolean;
}

/** Something a chat turn changed in Agent Ops. */
export interface ChatAction {
  kind: 'task' | 'channel';
  type: string;
  root: string;
  task?: string;
  title?: string;
  channel?: string;
  summary: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  at: string;
  text: string;
  from?: string;
  channel?: string;
  root?: string;
  status?: 'queued' | 'sent' | 'cancelled';
  run?: string;
  actions?: ChatAction[];
  error?: string;
}

/** `GET /api/chat`. */
export interface ChatView {
  agent: string;
  mentions: boolean;
  messages: ChatMessage[];
  live: RunRecord | null;
  streaming: string | null;
  busy: RunRecord | null;
  waiting: string | null;
}

export interface UsageWindow {
  utilization: number;
  resets_at: number;
  status?: string;
}

/** One provider from `GET /api/waits`. */
export interface ProviderUsage {
  windows: Record<string, UsageWindow>;
  limited_until?: number;
  plan?: string;
  paused: string | null;
  live: number;
  /** Set while the provider is signed out: no run of it starts until it is signed in. */
  signed_out?: SignedOut;
}

/** A signed-out provider, from `GET /api/usage` (AO-0154). */
export interface SignedOut {
  since: string;
  run?: string;
  task?: string;
  /** How to sign in again, such as "run `codex login`". */
  steps: string;
  /** opsd checks the sign-in by itself; false: it tries one run an hour. */
  check: boolean;
  next: string;
}

/** Work waking agents could start, and why no run has started on it. */
export interface WaitItem {
  kind: 'review' | 'inbox' | 'task';
  task?: string;
  title: string;
  project: string;
  review: boolean;
  agents: string[];
  reason: string;
}

/** One process a run started, from `GET /api/runs/:id/procs`. */
export interface ProcView {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  first_seen: string;
  last_seen: string;
  gone_at?: string;
  killed_at?: string;
  unsure?: boolean;
  alive: boolean;
}

export interface Agent {
  id: string;
  name?: string;
  description?: string;
  status: 'active' | 'paused' | 'proposed';
  can_claim?: string[];
  budget_min?: number;
  /** The role file's model, when it sets one. */
  model?: string;
  /** Path of its role file; agents only the opsd config names have none. */
  file?: string;
  /** opsd starts runs for it when it has work. */
  wake?: boolean;
  live: string | null;
  /** Listed in the opsd config; older opsd builds leave it out. */
  configured?: boolean;
  /** Its provider is in Settings > Providers; older opsd builds leave it out. */
  provider?: boolean;
}

/** A provider runtime as Settings shows it. */
export interface RuntimeView {
  command: string;
  args?: string[];
  unset_env?: string[];
  model?: string;
  max_live?: number;
  pause_at?: number;
  paused: boolean;
  /** The seeded entry "Reset to default" restores; null for a provider you added. */
  default?: { command: string; args?: string[] } | null;
  /** Where opsd found the command on PATH, or null; older opsd builds leave it out. */
  found?: string | null;
  /** Agents that run on it. */
  agents?: string[];
}

/** Someone the pickers offer, and why: role file, opsd config, runnable runtime, or seen lately. */
export interface DirectoryItem {
  id: string;
  source: 'role' | 'config' | 'runtime' | 'seen';
  /** A write that hands it work accepts it; older opsd builds leave it out (see `isConfigured`). */
  configured?: boolean;
  name?: string;
  description?: string;
  status?: string;
  paused?: boolean;
}

/** A role file as the role editor reads and writes it. */
export interface RoleFile {
  id: string;
  name?: string;
  description?: string;
  status: 'active' | 'paused' | 'proposed';
  instructions: string;
  kb?: string[];
  files?: string[];
  style?: string;
  budget_min?: number;
  can_claim?: string[];
  tools?: string[];
  root?: string | null;
}

export interface Decision {
  root: string;
  meta: {
    id: string;
    question: string;
    options: string[];
    voters?: string[];
    quorum: number;
    deadline?: string;
    task?: string;
    created_by: string;
  };
  body: string;
  ballots: { actor: string; at: string; choice: string; body: string }[];
  outcome: { choice: string; decided_by: string; at: string; body: string } | null;
  tally: {
    counts: Record<string, number>;
    votes: number;
    leaders: string[];
    state: 'open' | 'ready' | 'tie' | 'no-quorum' | 'decided';
    missing: string[];
  };
}

export interface ChannelInfo {
  name: string;
  messages: number;
  last: string | null;
  description?: string;
}

export interface ChannelMessage {
  id: string;
  channel: string;
  actor: string;
  at: string;
  mentions?: string[];
  task?: string;
  body: string;
  /** The data root the message file lives in. */
  root?: string;
}

/** The installed app's updates, from the main process. */
export interface UpdateState {
  status: 'off' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  current: string;
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: string;
  notes?: string;
}

/** One result of `GET /api/search`. */
export interface SearchHit {
  kind: 'task' | 'note' | 'post' | 'vote';
  ref: string;
  title: string;
  field: string;
  snippet: string;
  actor?: string;
  event?: string;
  at: string;
  score: number;
  status?: string;
  owner?: string | null;
  project?: string;
  priority?: string;
  root?: string;
}

/**
 * The answer of `GET /api/search`: `partial` is true when the request reached opsd's work budget
 * before it searched every item.
 */
export interface SearchResult {
  hits: SearchHit[];
  partial: boolean;
}

/** opsd as the tray and the Background service card show it. */
export interface ServiceState {
  running: boolean;
  paused: boolean;
  live: number;
  waiting: number;
  /** Whether live runs keep going after opsd stops (opsd's `runs_outlive`); true on every system today. */
  runsOutlive: boolean;
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'pause' | 'resume';

/** The desktop's own settings, from the main process. */
/** Voice input settings and readiness, from the main process. */
export interface VoiceView {
  engine: 'off' | 'local' | 'cloud';
  program: string | null;
  model: string | null;
  language: string;
  cloudModel: string;
  /** `OPENAI_API_KEY` is set for the app (its value never reaches the page). */
  cloudKey: boolean;
  /** What is missing before the microphone button can transcribe, or null when it is ready. */
  problem: string | null;
}

export interface DesktopView {
  notify: boolean;
  /** Windows starts the app at sign-in, tray only. */
  login: boolean;
  /** The sign-in entry's command when it starts another copy or folder than this app's. */
  loginOther: string | null;
  /** The sign-in entry exists but is turned off in Task Manager > Startup apps. */
  loginOff: boolean;
  loginSupported: boolean;
  state: ServiceState;
}

export interface Info {
  pid: number;
  port: number;
  version: string;
  me: string | null;
  /** opsd runs an older build than the one installed and needs a restart. */
  stale?: boolean;
  /** Live runs when the app looked. */
  live?: number;
}

/** One schedule from `GET /api/schedules`. */
export interface Schedule {
  name: string;
  agent: string;
  every?: string;
  at?: string;
  prompt?: string;
  task?: string;
  paused?: boolean;
  last_run: string | null;
  next_run: string | null;
}

/** One repeating task from `GET /api/repeats` (AO-0142). */
export interface Repeat {
  root: string;
  meta: {
    name: string;
    title: string;
    type?: string;
    priority?: string;
    owner?: string;
    project?: string;
    parent?: string;
    labels?: string[];
    /** Local wall time `YYYY-MM-DDTHH:MM`. */
    start?: string;
    repeat?: 'once' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'yearly';
    days?: string[];
    until?: string;
    count?: number;
    /** `closed AO-0012` or `children-closed AO-0012`. */
    when?: string;
    paused?: boolean;
    created_by: string;
    created_at: string;
  };
  body: string;
  rule: string;
  state: 'active' | 'waiting' | 'paused' | 'finished' | 'broken';
  fired: number;
  last?: { id: string; slot: string; created_at: string; status?: Status };
  next?: string;
  due?: string;
  note?: string;
}

export interface RoleLimits {
  writes: boolean;
  per_project: number;
  max_live?: number;
  burst: number;
  providers: string[];
  overflow: boolean;
  max_children: number;
}

/** `GET /api/settings`: effective values, and which keys the file sets. */
export interface RootInfo {
  name: string;
  dir: string;
  mirror: boolean;
  isMirror: boolean;
  isMaster: boolean;
}

export interface Settings {
  path: string;
  me: string | null;
  roots: string[];
  master: string | null;
  rootList: RootInfo[];
  notify: { webhook: boolean; kinds: string[] | null };
  opsd: {
    max_runs: number;
    /** No new runs or schedules start until resumed. */
    paused?: boolean;
    min_free_gb: number;
    usage_pause_at: number;
    review_backlog: number;
    budget_minutes: number;
    wake_cooldown_minutes: number;
    usage_cooldown_minutes: number;
    sync: boolean;
    port: number;
    tick_seconds: number;
    runtimes: Record<string, RuntimeView>;
    roles: Record<string, RoleLimits>;
    agents: Record<string, { wake?: boolean; budget?: string; model?: string }>;
    seeded?: boolean;
  };
  /** Default providers the config does not list, with whether their program is on PATH. */
  missingDefaults?: Array<{ name: string; command: string; found: string | null }>;
  set: string[];
}

export interface StandupItem {
  task: string;
  title: string;
  at: string;
  note?: string;
}

export interface StandupEntry {
  agent: string;
  done: StandupItem[];
  review: StandupItem[];
  working: StandupItem[];
  blocked: StandupItem[];
  runs: number;
  tokens: number;
  minutes: number;
}

/** `GET /api/standup?hours=N`. */
export interface Standup {
  since: string;
  until: string;
  agents: StandupEntry[];
  posts: ChannelMessage[];
}

export interface UsageLine {
  key: string;
  runs: number;
  minutes: number;
  tokens: number;
}

/** `GET /api/report`: a window of progress and usage. */
export interface Report {
  from: string;
  to: string;
  projects: Array<{
    project: string;
    opened: number;
    closed: number;
    parked: number;
    open: number;
    blocked: number;
  }>;
  agents: UsageLine[];
  providers: UsageLine[];
  decisions: Array<{ id: string; question: string; choice: string; at: string }>;
  channels: Array<{ channel: string; posts: number }>;
  totals: { opened: number; closed: number; runs: number; minutes: number; tokens: number };
}

/** `GET /api/machines`: each machine's last presence record. */
export interface Machine {
  machine: string;
  last_seen: string;
  live_runs: number;
  version?: string;
  build?: string;
  agents?: string[];
  alive: boolean;
}

/** One line of the activity feed, as `GET /api/activity` returns it. */
export interface ActivityItem {
  id: string;
  at: string;
  kind: 'task' | 'channel';
  type: string;
  actor: string;
  to?: string;
  root: string;
  task?: string;
  title?: string;
  project?: string;
  channel?: string;
  verdict?: string;
  run?: string;
  body: string;
  /** The task is in the archive. */
  archived?: boolean;
}

/** One page of `GET /api/activity`. */
export interface ActivityPage {
  items: ActivityItem[];
  /** The `before` for the next older page; null on the last page. */
  next: string | null;
  /** Items matching the query, on every page. */
  total: number;
  /** Everyone who acted and every project, across the whole feed. */
  actors: string[];
  projects: string[];
}

/** One `ops doctor` check, as `GET /api/doctor` returns it. */
export interface Check {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

/** A learn note from `kb/<topic>/<slug>.md`, as `GET /api/kb` returns it. */
export interface KbNote {
  root: string;
  topic: string;
  slug: string;
  ref: string;
  title: string;
  author: string;
  created_at: string;
  task?: string;
  tags?: string[];
  body: string;
  score: number;
}
