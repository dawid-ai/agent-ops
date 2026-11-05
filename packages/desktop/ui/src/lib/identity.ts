// Who is who at a glance: every provider has a color and a mark, every role an icon and a color,
// and priorities and statuses have display names. Agents keep the protocol values (p0 to p3,
// todo, needs-review); only the app shows the friendly ones.

export interface Provider {
  key: string;
  label: string;
  color: string;
}

const PROVIDERS: Record<string, Provider> = {
  claude: { key: 'claude', label: 'Claude', color: '#f08a5d' },
  codex: { key: 'codex', label: 'Codex', color: '#3ddc97' },
  gemini: { key: 'gemini', label: 'Gemini', color: '#6aa8ff' },
  grok: { key: 'grok', label: 'Grok', color: '#d4d9e2' },
  cursor: { key: 'cursor', label: 'Cursor', color: '#a5a8ff' },
  human: { key: 'human', label: 'Human', color: '#ffc857' },
  '*': { key: '*', label: 'Any provider', color: '#94a3b8' },
};

export type RoleIcon =
  | 'engineer'
  | 'qa'
  | 'reviewer'
  | 'pm'
  | 'designer'
  | 'docs'
  | 'orchestrator'
  | 'writer'
  | 'research'
  | 'ops'
  | 'security'
  | 'data'
  | 'person'
  | 'any'
  | 'bot';

export interface Role {
  key: string;
  label: string;
  color: string;
  icon: RoleIcon;
}

const ROLES: Record<string, Omit<Role, 'key'>> = {
  engineer: { label: 'Engineer', color: '#5aa9ff', icon: 'engineer' },
  dev: { label: 'Developer', color: '#5aa9ff', icon: 'engineer' },
  backend: { label: 'Backend', color: '#5aa9ff', icon: 'engineer' },
  frontend: { label: 'Frontend', color: '#7cc4ff', icon: 'engineer' },
  qa: { label: 'QA', color: '#b18cff', icon: 'qa' },
  reviewer: { label: 'Reviewer', color: '#c9a4ff', icon: 'reviewer' },
  pm: { label: 'PM', color: '#ff7eb6', icon: 'pm' },
  product: { label: 'Product', color: '#ff7eb6', icon: 'pm' },
  designer: { label: 'Designer', color: '#ff9ee6', icon: 'designer' },
  docs: { label: 'Docs', color: '#4fd1c5', icon: 'docs' },
  orchestrator: { label: 'Orchestrator', color: '#ffd166', icon: 'orchestrator' },
  copywriter: { label: 'Copywriter', color: '#f6ad55', icon: 'writer' },
  writer: { label: 'Writer', color: '#f6ad55', icon: 'writer' },
  researcher: { label: 'Researcher', color: '#7dd3fc', icon: 'research' },
  research: { label: 'Research', color: '#7dd3fc', icon: 'research' },
  ops: { label: 'Ops', color: '#94a3b8', icon: 'ops' },
  devops: { label: 'DevOps', color: '#94a3b8', icon: 'ops' },
  security: { label: 'Security', color: '#ff7a7a', icon: 'security' },
  data: { label: 'Data', color: '#a3e635', icon: 'data' },
};

/** A stable hue for names no table knows, so each still gets its own color. */
export function hashColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 68%)`;
}

export interface Identity {
  id: string;
  runtime: string;
  role: string;
  human: boolean;
  wildcard: boolean;
  provider: Provider;
  roleInfo: Role;
}

export function identity(id: string): Identity {
  const [runtime = id, role = ''] = id.split(':');
  const human = runtime === 'human';
  const provider = PROVIDERS[runtime] ?? {
    key: runtime,
    label: runtime.charAt(0).toUpperCase() + runtime.slice(1),
    color: hashColor(runtime),
  };
  let roleInfo: Role;
  if (human) {
    roleInfo = { key: role, label: role, color: PROVIDERS.human!.color, icon: 'person' };
  } else if (role === '*') {
    roleInfo = { key: '*', label: 'Any role', color: '#94a3b8', icon: 'any' };
  } else {
    const known = ROLES[role];
    roleInfo = known
      ? { key: role, ...known }
      : { key: role, label: role, color: hashColor(role), icon: 'bot' };
  }
  return {
    id,
    runtime,
    role,
    human,
    wildcard: runtime === '*' || role === '*',
    provider,
    roleInfo,
  };
}

// ---- Priorities ----------------------------------------------------------------------------------

export type PriorityKey = 'p0' | 'p1' | 'p2' | 'p3';

export const PRIORITIES: Array<{ key: PriorityKey; label: string; color: string; bars: number }> = [
  { key: 'p0', label: 'Urgent', color: '#ff5d6c', bars: 4 },
  { key: 'p1', label: 'Medium', color: '#ff9f43', bars: 3 },
  { key: 'p2', label: 'Standard', color: '#8fa3bf', bars: 2 },
  { key: 'p3', label: 'Low', color: '#566074', bars: 1 },
];

export function priorityInfo(p: string): (typeof PRIORITIES)[number] {
  return PRIORITIES.find((x) => x.key === p) ?? PRIORITIES[2]!;
}

// ---- Statuses ------------------------------------------------------------------------------------

export const STATUSES = [
  { key: 'todo', label: 'To do', color: '#8b93a3' },
  { key: 'claimed', label: 'Claimed', color: '#5ce1e6' },
  { key: 'in-progress', label: 'In progress', color: '#5aa9ff' },
  { key: 'blocked', label: 'Blocked', color: '#ffb547' },
  { key: 'needs-review', label: 'In review', color: '#b18cff' },
  { key: 'done', label: 'Done', color: '#3ddc97' },
  { key: 'parked', label: 'Parked', color: '#566074' },
] as const;

export type StatusKey = (typeof STATUSES)[number]['key'];

export function statusInfo(s: string): (typeof STATUSES)[number] {
  return STATUSES.find((x) => x.key === s) ?? STATUSES[0];
}

// ---- Mentions ------------------------------------------------------------------------------------

const MENTION_RE = /(^|[^\w@])@([a-z*][a-z0-9]*:(?:[a-z][a-z0-9-]*[a-z0-9]|[a-z]|\*))/g;

/** Wraps `@runtime:role` in rendered HTML text with a pill the stylesheet colors per provider. */
export function markMentions(html: string): string {
  // Only text between tags: attributes and code blocks stay as they are.
  return html.replace(/(<code[\s\S]*?<\/code>|<[^>]+>)|([^<]+)/g, (all, tag, text) => {
    if (tag) return tag;
    return (text as string).replace(MENTION_RE, (_m, pre: string, id: string) => {
      const rt = id.split(':')[0]!;
      return `${pre}<span class="mention" data-rt="${rt === '*' ? 'any' : rt}">@${id}</span>`;
    });
  });
}

/** The `@` word the caret is in, for mention autocomplete: where it starts and what is typed. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([a-z0-9:*-]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

// ---- Due dates -----------------------------------------------------------------------------------

/**
 * A due value from the date and time pickers: a date alone means the end of that day (the
 * protocol's own rule for `2026-11-03`); with a time, that local time as an ISO timestamp.
 */
export function dueValue(date: string, time?: string): string {
  if (!date) return '';
  if (!time) return date;
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y!, mo! - 1, d!, h!, mi!).toISOString();
}

/** `Today 18:00`, `Tomorrow`, `Mon 3 Nov`, with whether it is overdue. */
export function dueLabel(
  iso: string,
  now = Date.now(),
): { text: string; overdue: boolean; soon: boolean } {
  const d = new Date(iso);
  const t = d.getTime();
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  const endOfDay = d.getHours() === 23 && d.getMinutes() === 59;
  const time = endOfDay
    ? ''
    : ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const name =
    diffDays === 0
      ? 'Today'
      : diffDays === 1
        ? 'Tomorrow'
        : diffDays === -1
          ? 'Yesterday'
          : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return { text: `${name}${time}`, overdue: t < now, soon: t >= now && t - now < 86_400_000 };
}
