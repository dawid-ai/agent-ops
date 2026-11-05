import type { OpsEvent } from '../types';

// Pure helpers for the task thread and the Settings forms, kept apart so tests can load them.

/** Events from the server plus ones this window just wrote, each once, oldest first. */
export function mergeEvents(server: OpsEvent[], written: OpsEvent[]): OpsEvent[] {
  const byId = new Map<string, OpsEvent>();
  for (const e of [...server, ...written]) byId.set(e.id, e);
  // Event ids are ULIDs: they sort in the order the events were written.
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Pairs each answer with the question it answers: the latest ask before it that no earlier
 * answer took. Returns ask id -> answer id and answer id -> ask id.
 */
export function pairAnswers(events: OpsEvent[]): Map<string, string> {
  const pairs = new Map<string, string>();
  const open: string[] = [];
  for (const e of events) {
    if (e.type === 'ask') open.push(e.id);
    else if (e.type === 'answer') {
      const ask = open.pop();
      if (ask) {
        pairs.set(ask, e.id);
        pairs.set(e.id, ask);
      }
    }
  }
  return pairs;
}

/**
 * The event an `AO-0014#<event id>` reference names: the exact id, else the first event whose id
 * starts with it, so a shortened id still finds its event. Case does not matter in ULIDs.
 */
export function findEvent(events: OpsEvent[], ref: string): OpsEvent | undefined {
  const want = ref.trim().toUpperCase();
  if (!want) return undefined;
  return events.find((e) => e.id === want) ?? events.find((e) => e.id.startsWith(want));
}

/**
 * Splits a command line into arguments by the Windows rules (CommandLineToArgvW), the same ones
 * `joinArgs` and the main process's confirm dialog quote by: whitespace separates outside double
 * quotes; `""` is an empty argument; backslashes count only before a quote, where 2n give n and
 * toggle quoting and 2n+1 give n and a literal quote. `C:\tools\` stays as typed.
 */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inArg = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\') {
      let n = 0;
      while (s[i] === '\\') {
        n++;
        i++;
      }
      inArg = true;
      if (s[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else quoted = !quoted;
      } else {
        cur += '\\'.repeat(n);
        i--;
      }
    } else if (ch === '"') {
      inArg = true;
      quoted = !quoted;
    } else if (!quoted && /\s/.test(ch)) {
      if (inArg) out.push(cur);
      cur = '';
      inArg = false;
    } else {
      inArg = true;
      cur += ch;
    }
  }
  if (inArg) out.push(cur);
  return out;
}

/**
 * One argument quoted for a Windows command line, the way Node's spawn and the confirm dialog
 * quote it: only when it is empty or has whitespace or a quote, with backslashes doubled before a
 * quote and at the end. `splitArgs` reads it back unchanged.
 */
export function quoteArg(a: string): string {
  if (a !== '' && !/[\s"]/.test(a)) return a;
  let out = '"';
  let slashes = 0;
  for (const ch of a) {
    if (ch === '\\') {
      slashes++;
      continue;
    }
    out += '\\'.repeat(ch === '"' ? slashes * 2 + 1 : slashes) + ch;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/** Joins arguments into one line for editing; `splitArgs(joinArgs(a))` equals `a`. */
export function joinArgs(args: readonly string[] | undefined): string {
  return (args ?? []).map(quoteArg).join(' ');
}

/** Splits a list typed one per line or comma-separated. */
export function splitList(s: string): string[] {
  return [
    ...new Set(
      s
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Events this window wrote, shown before the server returns them. They are kept only until the
 * first read of the task that started after the write: from then on the server's copy counts,
 * because a sync may have renamed an event after the write returned its id.
 */
export interface Written {
  events: OpsEvent[];
  /** A write happened and no read started after it has returned yet. */
  waiting: boolean;
}

export type WrittenAction = { type: 'wrote'; events: OpsEvent[] } | { type: 'loaded' };

export function writtenReducer(state: Written, action: WrittenAction): Written {
  if (action.type === 'wrote') {
    return { events: [...state.events, ...action.events], waiting: true };
  }
  return state.waiting ? { events: [], waiting: false } : state;
}
