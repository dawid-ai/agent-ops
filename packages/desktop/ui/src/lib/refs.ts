// Task references in any text: `AO-0047`, `root/AO-0047` across roots, and `AO-0014#<event id>`
// for one event in a task's thread. Agents write them as plain text and read them as-is; the app
// turns them into links that open the task panel. The # picker (AO-0060) inserts the same form.

/** A task id in canonical form (`AO-0047`), an optional root before it, an optional event after. */
const REF_RE =
  /(^|[^\w./-])((?:([A-Za-z0-9][\w.-]*)\/)?([A-Z][A-Z0-9]*-\d{4,}))(?:#([0-9A-HJKMNP-TV-Z]{8,26}))?(?![\w-])/g;

export interface TaskRef {
  /** What the task API takes: `AO-0047` or `root/AO-0047`. */
  task: string;
  /** An event id, or the start of one, in that task's thread. */
  event?: string;
}

/** Splits `root/AO-0047#01M6...` into the task and the event. */
export function parseTaskRef(ref: string): TaskRef {
  const hash = ref.indexOf('#');
  if (hash < 0) return { task: ref };
  const event = ref.slice(hash + 1);
  return event ? { task: ref.slice(0, hash), event } : { task: ref.slice(0, hash) };
}

/** Every task reference in plain text, in order. */
export function findTaskRefs(text: string): TaskRef[] {
  const out: TaskRef[] = [];
  for (const m of text.matchAll(REF_RE)) {
    out.push(m[5] ? { task: m[2]!, event: m[5] } : { task: m[2]! });
  }
  return out;
}

/** A run of plain text, or a task reference to render as a link. */
export type RefPart = string | { ref: string };

/**
 * Splits plain text into text runs and task references, for views that show message bodies as
 * text rather than Markdown (Inbox, Activity). `ref` is what the task panel opens.
 */
export function splitTaskRefs(text: string): RefPart[] {
  const out: RefPart[] = [];
  let last = 0;
  for (const m of text.matchAll(REF_RE)) {
    const start = m.index + m[1]!.length;
    const ref = m[5] ? `${m[2]}#${m[5]}` : m[2]!;
    if (start > last) out.push(text.slice(last, start));
    out.push({ ref });
    last = start + ref.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---- The task index references read --------------------------------------------------------------

/** What a reference chip and the # picker show about a task. */
export interface RefTask {
  id: string;
  root: string;
  title: string;
  status: string;
  project?: string;
  archived?: boolean;
  updatedAt?: string;
}

/** Statuses that sort after open work in the # picker. */
const CLOSED = new Set(['done', 'parked']);

function isOpen(t: RefTask): boolean {
  return !t.archived && !CLOSED.has(t.status);
}

/**
 * Every task by `root/AO-0047`, and by bare `AO-0047` when only one root has that id. App fills it
 * from `/api/tasks?all`; chips and the # picker read it. A version number lets React views
 * subscribe (`useSyncExternalStore`) and draw again when it changes.
 */
const index = {
  list: [] as readonly RefTask[],
  byRef: new Map<string, RefTask>(),
  version: 0,
  listeners: new Set<() => void>(),
};

export function setRefTasks(tasks: readonly RefTask[]): void {
  const count = new Map<string, number>();
  for (const t of tasks) count.set(t.id, (count.get(t.id) ?? 0) + 1);
  const byRef = new Map<string, RefTask>();
  for (const t of tasks) {
    byRef.set(`${t.root}/${t.id}`, t);
    if (count.get(t.id) === 1) byRef.set(t.id, t);
  }
  index.list = tasks;
  index.byRef = byRef;
  index.version++;
  for (const fn of index.listeners) fn();
}

/** The task a reference points at, if the index has it and it is not ambiguous. */
export function refTask(ref: string): RefTask | undefined {
  return index.byRef.get(parseTaskRef(ref).task);
}

export function refTasks(): readonly RefTask[] {
  return index.list;
}

export function subscribeRefTasks(fn: () => void): () => void {
  index.listeners.add(fn);
  return () => index.listeners.delete(fn);
}

export function refTasksVersion(): number {
  return index.version;
}

/**
 * The plain text the # picker inserts: the bare id (`AO-0047`) when no other root has that id,
 * else `root/AO-0047`. Both are what agents pass to `ops show`.
 */
export function refFor(t: RefTask, tasks: readonly RefTask[] = index.list): string {
  const clash = tasks.some((o) => o.id === t.id && o.root !== t.root);
  return clash ? `${t.root}/${t.id}` : t.id;
}

/** The plain text the # picker inserts for a project; agents read it as `--project v2`. */
export function projectRef(name: string): string {
  return `project:${name}`;
}

// ---- The # picker ----------------------------------------------------------------------------------

/**
 * The `#` word the caret is in, for the task picker: where it starts and what is typed. The `#`
 * must start a word, so `AO-0014#01M6...`, URL fragments and `##` headings never open it, and a
 * space after it (`# Heading`) closes it.
 */
export function hashAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s([])#([^\s#@]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/** Whether every character of `q` appears in `s` in order. */
function subsequence(q: string, s: string): boolean {
  let i = 0;
  for (const c of s) if (c === q[i] && ++i === q.length) return true;
  return q.length === 0;
}

/**
 * How well a task matches a picker query, or -1 for no match. The id ranks first (`60`, `0060`
 * and `ao-60` all find AO-0060), then a word start in the title, any substring, the project, and
 * last the query's letters in order anywhere in the title.
 */
export function refScore(t: RefTask, query: string): number {
  const q = query.toLowerCase();
  if (!q) return 0;
  const id = t.id.toLowerCase();
  const full = `${t.root}/${t.id}`.toLowerCase();
  if (id === q || full === q) return 100;
  const [prefix, num] = id.split('-') as [string, string | undefined];
  const qm = /^(?:([a-z][a-z0-9]*?)-?)?0*(\d+)$/.exec(q);
  if (qm && num && Number(num) === Number(qm[2]) && (!qm[1] || prefix === qm[1])) return 95;
  if (id.startsWith(q) || full.startsWith(q)) return 85;
  if (num?.replace(/^0+/, '').startsWith(q.replace(/^0+/, '')) && /^\d+$/.test(q)) return 80;
  const title = t.title.toLowerCase();
  if (title.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 60;
  if (title.includes(q)) return 50;
  if (t.project?.toLowerCase().includes(q)) return 40;
  if (subsequence(q, title)) return 20;
  return -1;
}

/**
 * Tasks for the # picker: open ones first, then by match, then the most recently changed.
 */
export function rankRefTasks(tasks: readonly RefTask[], query: string, limit = 8): RefTask[] {
  return tasks
    .map((t) => ({ t, s: refScore(t, query) }))
    .filter((x) => x.s >= 0)
    .sort(
      (a, b) =>
        Number(isOpen(b.t)) - Number(isOpen(a.t)) ||
        b.s - a.s ||
        (b.t.updatedAt ?? '').localeCompare(a.t.updatedAt ?? ''),
    )
    .slice(0, limit)
    .map((x) => x.t);
}

/** Projects for the # picker: names that contain the query or its letters in order, busiest first. */
export function rankRefProjects(
  tasks: readonly RefTask[],
  query: string,
  limit = 3,
): Array<{ name: string; open: number }> {
  const q = query.toLowerCase();
  const open = new Map<string, number>();
  for (const t of tasks) {
    if (!t.project) continue;
    open.set(t.project, (open.get(t.project) ?? 0) + Number(isOpen(t)));
  }
  return [...open]
    .filter(([name]) => subsequence(q, name.toLowerCase()))
    .sort(
      ([a, na], [b, nb]) =>
        Number(b.toLowerCase().includes(q)) - Number(a.toLowerCase().includes(q)) ||
        nb - na ||
        a.localeCompare(b),
    )
    .slice(0, limit)
    .map(([name, n]) => ({ name, open: n }));
}

// ---- Rendering --------------------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** The hover text of a reference: what it opens, its status and its title when known. */
export function refTooltip(ref: string, t: RefTask | undefined, statusLabel?: string): string {
  const { task, event } = parseTaskRef(ref);
  const id = task.slice(task.lastIndexOf('/') + 1);
  const head = event ? `Open ${id} at this event` : `Open ${id}`;
  return t ? `${head}\n${statusLabel ?? t.status} · ${t.title}` : head;
}

/**
 * Wraps task references in rendered HTML with links the app opens in the task panel (App listens
 * for clicks on `a[data-task-ref]`). Text inside links and code blocks stays as it is. A task the
 * index knows becomes a chip: a status dot, the reference, and its title (shown in Markdown
 * bodies, see index.css). The reference comes only from the characters the pattern allows and the
 * title is escaped, so sanitized HTML stays safe. `status` maps a status to its known key and
 * label, so only fixed values reach the `data-status` attribute.
 */
export function markTaskRefs(
  html: string,
  status: (s: string) => { key: string; label: string } = (s) => ({
    key: s.replace(/[^a-z-]/g, ''),
    label: s,
  }),
): string {
  return html.replace(
    /(<pre[\s\S]*?<\/pre>|<a\b[\s\S]*?<\/a>|<[^>]+>)|([^<]+)/g,
    (_all, tag: string | undefined, text: string | undefined) => {
      if (tag) return tag;
      return text!.replace(
        REF_RE,
        (_m, pre: string, task: string, _root: string, _id: string, event?: string) => {
          const ref = event ? `${task}#${event}` : task;
          const t = refTask(task);
          const st = t ? status(t.status) : undefined;
          const title = escapeHtml(refTooltip(ref, t, st?.label));
          if (!t || !st) {
            return `${pre}<a class="task-ref" href="#${ref}" data-task-ref="${ref}" title="${title}">${ref}</a>`;
          }
          return (
            `${pre}<a class="task-ref" href="#${ref}" data-task-ref="${ref}" data-status="${st.key}" title="${title}">` +
            `<span class="ref-dot"></span>${ref}<span class="ref-title">${escapeHtml(t.title)}</span></a>`
          );
        },
      );
    },
  );
}
