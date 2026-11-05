import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseDoc, stringifyDoc } from './frontmatter.js';
import { OpsError, parseTaskId } from './ids.js';
import type { Priority } from './model.js';
import type { Root } from './root.js';

// Repeating tasks (AO-0142). A repeat is a task template in `repeats/<name>.md` with a rule that
// says when it fires. Each firing creates a task that names the repeat (`repeat`) and the slot it
// fired for (`repeat_slot`), so the store itself records what fired; nothing else is written.

export const REPEAT_RULES = ['once', 'daily', 'weekly', 'weekdays', 'monthly', 'yearly'] as const;
export type RepeatRule = (typeof REPEAT_RULES)[number];

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * Condition kinds, the first safe set:
 * - `closed <task>`: the task is done or parked.
 * - `children-closed <task>`: the task has subtasks and every one of them is done or parked.
 */
export const CONDITION_KINDS = ['closed', 'children-closed'] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** How far a slot search walks, in days: a year and a leap day, plus a week. */
const SEARCH_DAYS = 380;

/** Frontmatter of `repeats/<name>.md`; the body is the body of each task it creates. */
export interface RepeatMeta {
  name: string;
  /** Task title; `{date}` becomes the slot's date, such as `2026-11-05`. */
  title: string;
  type?: string;
  priority?: Priority;
  owner?: string;
  project?: string;
  parent?: string;
  labels?: string[];
  /**
   * First slot, as local wall time `YYYY-MM-DDTHH:MM`. Every later slot keeps its time of day in
   * the local time zone of the machine that checks it, across daylight saving changes.
   */
  start?: string;
  /** Time rule. Without `when`, a repeat needs `start` and a rule (`once` by default). */
  repeat?: RepeatRule;
  /** `weekdays`: the days it fires on. */
  days?: Weekday[];
  /** Last local date (`YYYY-MM-DD`) a slot may fall on. */
  until?: string;
  /** Most tasks it creates in total. */
  count?: number;
  /** Condition trigger, such as `closed AO-0012`, instead of a time rule. */
  when?: string;
  paused?: boolean;
  created_by: string;
  created_at: string;
}

export interface RepeatDef {
  root: string;
  meta: RepeatMeta;
  body: string;
}

/** What `ops repeat add`, the API and the desktop app send. */
export interface RepeatInput {
  /** The repeat's name, or `root/name`. */
  name: string;
  /** The root it lives in; without one, the name's root part or the default root. */
  root?: string;
  title: string;
  body?: string;
  type?: string;
  priority?: Priority;
  owner?: string;
  project?: string;
  parent?: string;
  labels?: string[];
  start?: string;
  repeat?: string;
  days?: string | string[];
  until?: string;
  count?: number;
  when?: string;
  paused?: boolean;
}

/**
 * - `active`: fires at its next slot, or when its condition holds.
 * - `waiting`: a slot is due, but the last task it created is still open; it fires once that
 *   task closes.
 * - `paused`, `finished` (no slots left, or `count` reached), `broken` (a bad file; see `note`).
 */
export type RepeatState = 'active' | 'waiting' | 'paused' | 'finished' | 'broken';

export interface RepeatView extends RepeatDef {
  /** The root the repeat lives in. */
  root: string;
  /** The rule in words. */
  rule: string;
  state: RepeatState;
  /** Tasks it created so far, archived ones included. */
  fired: number;
  /** The last task it created. */
  last?: RepeatTask;
  /** Time rules: the next slot after now, local `YYYY-MM-DDTHH:MM`. */
  next?: string;
  /** The slot that is due and has not fired: a local time or a condition key. */
  due?: string;
  /** When the due slot came, in ms. */
  dueAt?: number;
  note?: string;
}

export interface FiredRepeat {
  root: string;
  repeat: string;
  task: string;
  slot: string;
}

export interface Condition {
  kind: ConditionKind;
  task: string;
}

/** Event types that close a task: `done`, `park` and an approving `verdict`. */
export function closesTask(e: { type: string; verdict?: string }): boolean {
  return (
    e.type === 'done' || e.type === 'park' || (e.type === 'verdict' && e.verdict === 'approve')
  );
}

/** Local wall time as `YYYY-MM-DDTHH:MM`. */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Parses `2026-11-05T09:00` or `2026-11-05 09:00` as local wall time; returns ms. */
export function parseLocal(text: string): number {
  const m = LOCAL_RE.exec(text.trim());
  if (!m) throw new OpsError(`bad start '${text}': use 2026-11-05 09:00 (local time)`, 2);
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59) {
    throw new OpsError(`bad start '${text}': no such date or time`, 2);
  }
  return date.getTime();
}

/** Normalizes a start to `YYYY-MM-DDTHH:MM`. */
export function normalizeStart(text: string): string {
  return localStamp(parseLocal(text));
}

function parseDate(text: string, what: string): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(text.trim());
  const y = Number(m?.[1]);
  const mo = Number(m?.[2]);
  const d = Number(m?.[3]);
  const date = new Date(y, mo - 1, d);
  if (!m || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    throw new OpsError(`bad ${what} '${text}': use a date such as 2027-01-31`, 2);
  }
  return { y, m: mo, d };
}

export function parseWeekdays(text: string | string[]): Weekday[] {
  const parts = (Array.isArray(text) ? text : text.split(/[\s,]+/))
    .map((s) => s.trim().toLowerCase().slice(0, 3))
    .filter(Boolean);
  const bad = parts.filter((p) => !(WEEKDAYS as readonly string[]).includes(p));
  if (parts.length === 0 || bad.length > 0) {
    throw new OpsError(`bad days '${String(text)}': use mon, tue, wed, thu, fri, sat or sun`, 2);
  }
  // Week order, each day once.
  return WEEKDAYS.filter((w) => parts.includes(w));
}

export function parseCondition(text: string): Condition {
  const m = /^\s*([a-z-]+)\s+(\S+)\s*$/i.exec(text);
  const kind = m?.[1]?.toLowerCase();
  if (!m || !(CONDITION_KINDS as readonly string[]).includes(kind!)) {
    throw new OpsError(
      `bad condition '${text}': use 'closed <task>' or 'children-closed <task>'`,
      2,
    );
  }
  return { kind: kind as ConditionKind, task: m[2]! };
}

export function assertRepeatName(name: string): string {
  const n = name.trim();
  if (!NAME_RE.test(n)) {
    throw new OpsError(`bad repeat name '${name}': lowercase letters, digits and hyphens`, 2);
  }
  return n;
}

/** Checks the rule fields of a repeat; throws on the first problem. */
export function validateRule(meta: RepeatMeta): void {
  if (meta.when) {
    parseCondition(meta.when);
    if (meta.repeat || meta.days) {
      throw new OpsError('a repeat has a time rule or a condition (--when), not both', 2);
    }
  } else {
    if (!meta.start) throw new OpsError('a repeat needs a start (--start) or a condition', 2);
    const rule = meta.repeat ?? 'once';
    if (!(REPEAT_RULES as readonly string[]).includes(rule)) {
      throw new OpsError(`bad rule '${rule}': use ${REPEAT_RULES.join(', ')}`, 2);
    }
    if (rule === 'weekdays' && (!meta.days || meta.days.length === 0)) {
      throw new OpsError('a weekdays repeat needs --days, such as mon,thu', 2);
    }
    if (rule !== 'weekdays' && meta.days) {
      throw new OpsError('--days goes with the weekdays rule only', 2);
    }
  }
  if (meta.start) parseLocal(meta.start);
  if (meta.until) parseDate(meta.until, 'until');
  if (meta.count !== undefined && (!Number.isInteger(meta.count) || meta.count < 1)) {
    throw new OpsError(`bad count '${meta.count}': use a whole number from 1`, 2);
  }
}

function daysInMonth(y: number, m0: number): number {
  return new Date(y, m0 + 1, 0).getDate();
}

/** Whether the rule fires on a local calendar day (`date` is any time on that day). */
function firesOn(meta: RepeatMeta, startMs: number, date: Date): boolean {
  const s = new Date(startMs);
  const y = date.getFullYear();
  const m0 = date.getMonth();
  const d = date.getDate();
  switch (meta.repeat ?? 'once') {
    case 'once':
      return y === s.getFullYear() && m0 === s.getMonth() && d === s.getDate();
    case 'daily':
      return true;
    case 'weekly':
      return date.getDay() === s.getDay();
    case 'weekdays':
      return (meta.days ?? []).includes(WEEKDAYS[date.getDay()]!);
    case 'monthly':
      // The 29th to 31st fall on the month's last day in shorter months.
      return d === Math.min(s.getDate(), daysInMonth(y, m0));
    case 'yearly':
      return m0 === s.getMonth() && d === Math.min(s.getDate(), daysInMonth(y, m0));
    default:
      return false;
  }
}

/** The slot on a day: that day at the start's time of day, local. */
function slotOn(day: Date, startMs: number): number {
  const s = new Date(startMs);
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    s.getHours(),
    s.getMinutes(),
  ).getTime();
}

/** End of the `until` day, local, in ms; Infinity without one. */
function untilEnd(meta: RepeatMeta): number {
  if (!meta.until) return Infinity;
  const { y, m, d } = parseDate(meta.until, 'until');
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

/**
 * The latest slot of a time rule at or before `nowMs`, or null when none has come yet. Slots
 * before `start` or after `until` don't count, so every missed slot folds into this one.
 */
export function latestSlot(meta: RepeatMeta, nowMs: number): number | null {
  if (meta.when || !meta.start) return null;
  const startMs = parseLocal(meta.start);
  const limit = Math.min(nowMs, untilEnd(meta));
  if (limit < startMs) return null;
  const firstDay = new Date(startMs);
  firstDay.setHours(0, 0, 0, 0);
  const day = new Date(limit);
  day.setHours(12, 0, 0, 0);
  for (let i = 0; i <= SEARCH_DAYS && day.getTime() >= firstDay.getTime(); i++) {
    const slot = slotOn(day, startMs);
    if (firesOn(meta, startMs, day) && slot <= limit && slot >= startMs) return slot;
    day.setDate(day.getDate() - 1);
  }
  return null;
}

/** The first slot of a time rule after `afterMs`, or null when the rule has no more. */
export function nextSlot(meta: RepeatMeta, afterMs: number): number | null {
  if (meta.when || !meta.start) return null;
  const startMs = parseLocal(meta.start);
  const end = untilEnd(meta);
  const day = new Date(Math.max(afterMs, startMs));
  day.setHours(12, 0, 0, 0);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const slot = slotOn(day, startMs);
    if (slot > end) return null;
    if (firesOn(meta, startMs, day) && slot > afterMs && slot >= startMs) return slot;
    day.setDate(day.getDate() + 1);
  }
  return null;
}

/** A plain description of the rule, such as `weekdays mon, thu at 09:00 from 2026-11-05`. */
export function describeRule(meta: RepeatMeta): string {
  let text: string;
  if (meta.when) {
    text = `when ${meta.when}`;
    if (meta.start) text += `, not before ${meta.start.replace('T', ' ')}`;
  } else {
    const [date, time] = (meta.start ?? '').split('T');
    const rule = meta.repeat ?? 'once';
    if (rule === 'once') text = `once on ${date} at ${time}`;
    else if (rule === 'weekdays')
      text = `on ${(meta.days ?? []).join(', ')} at ${time} from ${date}`;
    else text = `${rule} at ${time} from ${date}`;
  }
  if (meta.until) text += `, until ${meta.until}`;
  if (meta.count) text += `, at most ${meta.count} time(s)`;
  return text;
}

// ---- Files --------------------------------------------------------------------------------------

function repeatsDir(root: Root): string {
  return join(root.dir, 'repeats');
}

function repeatFile(root: Root, name: string): string {
  return join(repeatsDir(root), `${name}.md`);
}

export function hasRepeat(root: Root, name: string): boolean {
  return existsSync(repeatFile(root, name));
}

export function listRepeatNames(root: Root): string[] {
  const dir = repeatsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3))
    .filter((n) => NAME_RE.test(n))
    .sort();
}

export function readRepeat(root: Root, name: string): RepeatDef {
  const file = repeatFile(root, name);
  if (!existsSync(file)) throw new OpsError(`no repeat '${name}' in root '${root.name}'`, 2);
  const doc = parseDoc<RepeatMeta>(readFileSync(file, 'utf8'));
  return { root: root.name, meta: { ...doc.data, name }, body: doc.body.trim() };
}

export function writeRepeat(root: Root, meta: RepeatMeta, body: string): void {
  mkdirSync(repeatsDir(root), { recursive: true });
  root.writeAtomic(repeatFile(root, meta.name), stringifyDoc(meta, body));
}

export function removeRepeat(root: Root, name: string): void {
  rmSync(repeatFile(root, name), { force: true });
}

/** A task a repeat created. `status` is unknown for archived tasks, which are all closed. */
export interface RepeatTask {
  id: string;
  slot: string;
  created_at: string;
  status?: string;
}

/**
 * This clone's list of archived tasks per repeat, in `.ops/repeats.json` (never committed), so
 * checks every tick need not read the archive. A check reads the archive again before it fires.
 */
export function readRepeatCache(root: Root): Record<string, RepeatTask[]> {
  try {
    return JSON.parse(readFileSync(join(root.opsDir, 'repeats.json'), 'utf8')) as Record<
      string,
      RepeatTask[]
    >;
  } catch {
    return {};
  }
}

export function writeRepeatCache(root: Root, cache: Record<string, RepeatTask[]>): void {
  try {
    root.writeAtomic(join(root.opsDir, 'repeats.json'), JSON.stringify(cache));
  } catch {
    // The cache is optional; without it the next check reads the archive again.
  }
}

/** Archived tasks a repeat created, read from `task.md` alone: slot and creation time. */
export function archivedRepeatTasks(root: Root, name: string): RepeatTask[] {
  const out: RepeatTask[] = [];
  for (const id of root.listArchivedIds()) {
    if (!parseTaskId(id)) continue;
    const file = join(root.archiveDir(id), 'task.md');
    let data: { repeat?: unknown; repeat_slot?: unknown; created_at?: unknown };
    try {
      data = parseDoc<typeof data>(readFileSync(file, 'utf8')).data;
    } catch {
      continue;
    }
    if (data.repeat !== name) continue;
    out.push({
      id,
      slot: String(data.repeat_slot ?? ''),
      created_at: String(data.created_at ?? ''),
    });
  }
  return out;
}
