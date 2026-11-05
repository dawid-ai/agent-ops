// Actor ids are `<runtime>:<role>` for agents (`claude:engineer`) and `human:<name>` for people.
// The runtime has no hyphen, so the file slug `<runtime>-<role>` maps back to exactly one id.
const ACTOR_RE = /^([a-z][a-z0-9]*):([a-z][a-z0-9-]*)$/;
const OWNER_RE = /^(?:[a-z][a-z0-9]*:(?:[a-z][a-z0-9-]*|\*)|\*:[a-z][a-z0-9-]*)$/;
const TASK_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

export class OpsError extends Error {
  constructor(
    message: string,
    /** 1: refused (lost a claim, not allowed, wrong state). 2: bad input. */
    readonly code: 1 | 2 = 1,
  ) {
    super(message);
    this.name = 'OpsError';
  }
}

export function isActorId(s: string): boolean {
  return ACTOR_RE.test(s);
}

/**
 * An owner is an actor id, a runtime wildcard such as `claude:*` (any role of that provider), or a
 * role wildcard such as `*:engineer` (that role on any provider).
 */
export function isOwnerId(s: string): boolean {
  return OWNER_RE.test(s);
}

export function assertActor(s: string, what = 'actor'): string {
  if (!isActorId(s)) {
    throw new OpsError(`bad ${what} id '${s}': use <runtime>:<role> or human:<name>`, 2);
  }
  return s;
}

export function assertOwner(s: string): string {
  if (!isOwnerId(s)) {
    throw new OpsError(
      `bad owner '${s}': use <runtime>:<role>, <runtime>:*, *:<role> or human:<name>`,
      2,
    );
  }
  return s;
}

export function runtimeOf(actor: string): string {
  return actor.split(':')[0] ?? '';
}

export function isHuman(actor: string): boolean {
  return actor.startsWith('human:');
}

export function isOrchestrator(actor: string): boolean {
  return actor.endsWith(':orchestrator');
}

/** Returns true when `actor` is `owner` or falls under its runtime wildcard. */
export function ownerMatches(owner: string | null | undefined, actor: string): boolean {
  if (!owner) return false;
  if (owner === actor) return true;
  if (owner.startsWith('*:')) return !isHuman(actor) && roleOf(owner) === roleOf(actor);
  return owner.endsWith(':*') && runtimeOf(owner) === runtimeOf(actor);
}

/** The part of an id after the colon: `engineer` in `claude:engineer`. */
export function roleOf(actor: string): string {
  return actor.slice(actor.indexOf(':') + 1);
}

/** True for an owner that names a group (`claude:*`, `*:engineer`) rather than one actor. */
export function isWildcard(owner: string): boolean {
  return owner.endsWith(':*') || owner.startsWith('*:');
}

export function actorSlug(actor: string): string {
  return actor.replace(':', '-');
}

export function slugToActor(slug: string): string {
  const i = slug.indexOf('-');
  return i < 0 ? slug : `${slug.slice(0, i)}:${slug.slice(i + 1)}`;
}

export function formatTaskId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

export function parseTaskId(s: string): { prefix: string; n: number } | null {
  const m = TASK_RE.exec(s.trim());
  if (!m) return null;
  return { prefix: m[1]!.toUpperCase(), n: Number(m[2]) };
}

/**
 * A task reference in free text: `AO-0047`, `root/AO-0047`, or `AO-0014#<event id>`. The app links
 * the same form (packages/desktop/ui/src/lib/refs.ts), so keep the two patterns in step.
 */
const TASK_REF_RE = /(?:^|[^\w./-])(?:[A-Za-z0-9][\w.-]*\/)?[A-Z][A-Z0-9]*-\d{4,}(?![\w-])/;

/** Whether the text names a task in the form the app links. */
export function hasTaskRef(text: string): boolean {
  return TASK_REF_RE.test(text);
}

const TASK_REFS_RE = /(?:^|[^\w./-])((?:[A-Za-z0-9][\w.-]*\/)?[A-Z][A-Z0-9]*-\d{4,})(?![\w-])/g;

/** Every task the text names (`AO-0047`, `root/AO-0047`), once each, in order. */
export function taskRefs(text: string): string[] {
  return [...new Set([...text.matchAll(TASK_REFS_RE)].map((m) => m[1]!))];
}

/** Every project the text names as `project:<name>`, the form the # picker inserts. */
export function projectRefs(text: string): string[] {
  const re = /(?:^|[^\w-])project:([A-Za-z0-9][\w.-]*[A-Za-z0-9]|[A-Za-z0-9])/g;
  return [...new Set([...text.matchAll(re)].map((m) => m[1]!))];
}

/** Fewer words than this reads as a fragment, not a sentence a person can act on. */
const MIN_WORDS = 5;

/**
 * Soft checks for a message to a person (AO-0057): the reader must see what it is about and what
 * they need to do without remembering or searching. Returns notes to print; never refuses.
 */
export function messageNotes(message: string): string[] {
  const notes: string[] = [];
  if (!hasTaskRef(message)) {
    notes.push(
      'the message names no task: write the task id (AO-0014), and AO-0014#<event id> or the date and author for a comment, so the reader can open it',
    );
  }
  if (message.trim().split(/\s+/).filter(Boolean).length < MIN_WORDS) {
    notes.push(
      'the message is shorter than a sentence: say what it is about and the decision or action you need',
    );
  }
  return notes;
}
