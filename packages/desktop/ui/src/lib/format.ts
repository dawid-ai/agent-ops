import type { Status, Task } from '../types';

export interface Column {
  key: string;
  title: string;
  statuses: Status[];
}

export const COLUMNS: Column[] = [
  { key: 'todo', title: 'To do', statuses: ['todo'] },
  { key: 'working', title: 'Working', statuses: ['claimed', 'in-progress'] },
  { key: 'blocked', title: 'Blocked', statuses: ['blocked'] },
  { key: 'review', title: 'Review', statuses: ['needs-review'] },
  { key: 'done', title: 'Done', statuses: ['done', 'parked'] },
];

const RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

/** Tasks per board column: open columns by priority then age, done newest first, capped. */
export function columns(tasks: Task[], doneLimit = 20): Record<string, Task[]> {
  const out: Record<string, Task[]> = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  for (const t of tasks) {
    // A stale claim or finished dependencies make a task claimable again: show it as to do.
    const status: Status = t.stale || t.unblocked ? 'todo' : t.status;
    const col = COLUMNS.find((c) => c.statuses.includes(status));
    if (col) out[col.key]!.push(t);
  }
  for (const c of COLUMNS) {
    const list = out[c.key]!;
    if (c.key === 'done') {
      list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      out[c.key] = list.slice(0, doneLimit);
    } else {
      list.sort(
        (a, b) => (RANK[a.priority] ?? 2) - (RANK[b.priority] ?? 2) || (a.id < b.id ? -1 : 1),
      );
    }
  }
  return out;
}

/** `5m`, `3h`, `2d` ago (or ahead, for leases and deadlines). */
/** Why each task waits, by `root/id`: reviews and claims, not inbox-only runs or ready ones. */
export function waitReasons(
  waits: Array<{ kind: string; task?: string; reason: string }>,
): Map<string, string> {
  return new Map(
    waits
      .filter((w) => w.task && w.kind !== 'inbox' && w.reason !== 'starts at the next tick')
      .map((w) => [w.task!, w.reason]),
  );
}

export function ago(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '-';
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return '-';
  const abs = Math.abs(ms);
  const unit =
    abs < 60_000
      ? `${Math.round(abs / 1000)}s`
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)}m`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)}h`
          : `${Math.round(abs / 86_400_000)}d`;
  return ms >= 0 ? `${unit} ago` : `in ${unit}`;
}

export function minutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h === 0 ? `${r}m` : r === 0 ? `${h}h` : `${h}h${r}m`;
}

export function tokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);
}

export interface LogLine {
  kind: 'text' | 'tool' | 'result' | 'raw' | 'error';
  text: string;
}

/**
 * Turns a run log (Claude `stream-json`, Codex `--json`, or plain text) into readable lines: what
 * the agent said, the tools and commands it ran, and the result.
 */
export function readableLog(log: string, max = 400): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== '{') {
      out.push({ kind: 'raw', text: line });
      continue;
    }
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.push({ kind: 'raw', text: line });
      continue;
    }
    if (ev.type === 'assistant') {
      const content = (ev.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const c of content as Array<Record<string, unknown>>) {
        if (c.type === 'text' && typeof c.text === 'string')
          out.push({ kind: 'text', text: c.text });
        if (c.type === 'tool_use') {
          const input = c.input as Record<string, unknown> | undefined;
          const detail = input?.command ?? input?.file_path ?? input?.pattern ?? '';
          out.push({ kind: 'tool', text: `${String(c.name)} ${String(detail)}`.trim() });
        }
      }
    } else if (ev.type === 'result') {
      const r = typeof ev.result === 'string' ? ev.result : String(ev.subtype ?? 'done');
      out.push({ kind: ev.is_error ? 'error' : 'result', text: r });
    } else if (ev.type === 'item.completed') {
      const item = ev.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message') out.push({ kind: 'text', text: String(item.text ?? '') });
      else if (item?.type === 'command_execution') {
        out.push({ kind: 'tool', text: `$ ${String(item.command ?? '')}` });
      } else if (item?.type === 'file_change') out.push({ kind: 'tool', text: 'edit files' });
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      out.push({ kind: 'error', text: JSON.stringify(ev.error ?? ev.message ?? ev) });
    }
  }
  return out.slice(-max);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The task a learn note came from, as a root-qualified ref: notes name it by its plain id. */
export function noteTaskRef(note: { root: string; task?: string }): string | null {
  return note.task ? `${note.root}/${note.task}` : null;
}

/** The time a ULID (message and event ids) was made, as ISO; null when it is not a ULID. */
export function ulidTime(id: string | null | undefined): string | null {
  if (!id || id.length < 10) return null;
  let ms = 0;
  for (const ch of id.slice(0, 10).toUpperCase()) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    ms = ms * 32 + v;
  }
  return new Date(ms).toISOString();
}
