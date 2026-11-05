import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  FolderKanban,
  X,
} from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useData } from '../api';
import { insertAt } from '../lib/attachments';
import { openAddAgent } from '../lib/goto';
import { dueLabel, dueValue, identity, mentionAt } from '../lib/identity';
import { insertSpoken } from '../lib/voice';
import type { RefTask } from '../lib/refs';
import { hashAt, projectRef, rankRefProjects, rankRefTasks, refFor } from '../lib/refs';
import type { DirectoryItem } from '../types';
import type { AttachTarget } from './attach';
import { AttachButton, useAttach } from './attach';
import { AgentTag, StatusIcon, Who } from './identity';
import { useRefTasks } from './refs';
import { MicButton } from './voice';

// ---- Popover -------------------------------------------------------------------------------------

/**
 * A floating panel under (or above) `anchor`, drawn in a portal so scrolling containers never
 * clip it. Closes on Escape and on a click outside both the anchor and the panel.
 *
 * Both listeners run in the capture phase on `document`. Dialogs and the task panel stop
 * `mousedown` from bubbling, so a bubbling listener never saw a click elsewhere in them. Escape
 * stops there too, so it closes only this panel and never the dialog around it.
 */
export function Popover(props: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  align?: 'start' | 'end';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!props.open || !props.anchor.current) return;
    const place = (): void => {
      const r = props.anchor.current!.getBoundingClientRect();
      const h = panel.current?.offsetHeight ?? 280;
      const w = props.width ?? Math.max(r.width, 220);
      const up = r.bottom + h + 8 > window.innerHeight && r.top > h + 8;
      let left = props.align === 'end' ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      setPos({ top: up ? r.top - h - 6 : r.bottom + 6, left, up });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [props.open, props.anchor, props.width, props.align]);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const { open, anchor } = props;
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose.current();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose.current();
    };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open, anchor]);
  if (!props.open) return null;
  return createPortal(
    <div
      ref={panel}
      className="animate-fade fixed z-[60] rounded-xl border border-white/10 bg-ink-800/95 p-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)] backdrop-blur"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: props.width ?? Math.max(props.anchor.current?.offsetWidth ?? 0, 220),
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

/** A menu of choices behind a trigger; each item has an icon slot and an optional hint. */
export function Menu<T extends string>(props: {
  trigger: (open: boolean) => ReactNode;
  items: Array<{ value: T; label: string; icon?: ReactNode; hint?: string; disabled?: boolean }>;
  value?: T;
  onPick: (v: T) => void;
  width?: number;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        title={props.title}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center rounded-lg transition hover:bg-white/5"
      >
        {props.trigger(open)}
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        width={props.width ?? 220}
      >
        {props.items.map((it) => (
          <button
            key={it.value}
            type="button"
            disabled={it.disabled}
            onClick={() => {
              setOpen(false);
              if (it.value !== props.value) props.onPick(it.value);
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-fg-2 hover:bg-white/6 hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
          >
            <span className="flex w-4 justify-center">{it.icon}</span>
            <span className="flex-1">{it.label}</span>
            {it.hint && <span className="text-xs text-fg-4">{it.hint}</span>}
            {it.value === props.value && <Check size={14} className="text-signal" />}
          </button>
        ))}
      </Popover>
    </>
  );
}

// ---- Who can be tagged ---------------------------------------------------------------------------

export interface DirectoryEntry {
  id: string;
  name?: string;
  description?: string;
  /** A wildcard (`claude:*`, `*:engineer`): whoever matches claims it. */
  group?: boolean;
  /**
   * A write that hands it work accepts it: a person, a wildcard, a role file or an opsd.agents
   * entry. False for a runtime with a usual role or an agent only seen lately; `ops assign` and
   * the other owner writes refuse those without `--force` (AO-0096).
   */
  configured: boolean;
}

/**
 * Whether opsd marks `a` configured. An older opsd leaves the flag out; then the rest of its
 * directory `data` decides, the way `Workspace.unreachable` does: with a role file or an
 * opsd.agents entry, only those count; with neither, the store checks no id, so every id counts.
 */
export function isConfigured(a: DirectoryItem, data: DirectoryItem[]): boolean {
  if (a.configured !== undefined) return a.configured;
  const defined = (d: DirectoryItem): boolean => d.source === 'role' || d.source === 'config';
  return defined(a) || !data.some(defined);
}

/**
 * Everyone a task can go to: you, the agents opsd knows (role files, the opsd config, each
 * runtime with the usual roles, agents seen lately), and the wildcards the configured agents'
 * providers and roles make (`codex:*`, `*:qa`). Each entry says whether a write accepts it.
 */
export function useDirectory(me: string | null): DirectoryEntry[] {
  const { data } = useData<DirectoryItem[]>('/api/directory');
  return useMemo(() => directoryEntries(data ?? [], me), [data, me]);
}

/** The entries `useDirectory` returns for the opsd directory `data`. */
export function directoryEntries(data: DirectoryItem[], me: string | null): DirectoryEntry[] {
  const out: DirectoryEntry[] = [];
  const seen = new Set<string>();
  const add = (e: DirectoryEntry): void => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    out.push(e);
  };
  if (me) add({ id: me, name: 'You', configured: true });
  const active = data.filter((a) => !a.status || a.status === 'active');
  for (const a of active) {
    add({
      id: a.id,
      name:
        a.name ??
        (a.paused
          ? 'provider paused'
          : a.source === 'runtime'
            ? 'no role file'
            : a.source === 'seen'
              ? 'seen lately'
              : undefined),
      description: a.description,
      configured: isConfigured(a, data),
    });
  }
  // A wildcard only claims for an agent that can run, so it comes from configured agents only.
  const agents = active
    .filter((a) => isConfigured(a, data))
    .map((a) => identity(a.id))
    .filter((a) => !a.human);
  for (const rt of [...new Set(agents.map((a) => a.runtime))].sort()) {
    add({
      id: `${rt}:*`,
      name: `Any ${identity(`${rt}:x`).provider.label} agent`,
      group: true,
      configured: true,
    });
  }
  for (const role of [...new Set(agents.map((a) => a.role))].sort()) {
    if (role && role !== '*')
      add({
        id: `*:${role}`,
        name: `Any ${identity(`x:${role}`).roleInfo.label}`,
        group: true,
        configured: true,
      });
  }
  return out;
}

/**
 * Whether the store checks agent ids: opsd marks some entry not configured. A store with no role
 * file and no opsd.agents entry accepts every id (`Workspace.knownAgents`), typed ones too.
 */
function checksIds(dir: DirectoryEntry[]): boolean {
  return dir.some((e) => !e.configured);
}

const ID_RE = /^([a-z][a-z0-9]*|\*):([a-z][a-z0-9-]*[a-z0-9]|[a-z]|\*)$/;

function matches(e: DirectoryEntry, q: string): boolean {
  if (!q) return true;
  const hay = `${e.id} ${e.name ?? ''} ${identity(e.id).roleInfo.label} ${identity(e.id).provider.label}`;
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.toLowerCase().includes(w));
}

function OptionRow({
  e,
  active,
  onPick,
}: {
  e: DirectoryEntry;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(ev) => ev.preventDefault()}
      onClick={onPick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
        active ? 'bg-white/8' : 'hover:bg-white/5'
      }`}
    >
      <Who id={e.id} />
      <span className="ml-auto truncate pl-2 text-xs text-fg-3">{e.name}</span>
    </button>
  );
}

/** A greyed row for an id a write refuses: it opens Add agent for it instead of picking it. */
function UnconfiguredRow({ e, onOpen }: { e: DirectoryEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-unconfigured={e.id}
      title={`${e.id} is not configured: add it as an agent`}
      onMouseDown={(ev) => ev.preventDefault()}
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/5"
    >
      <span className="opacity-45">
        <Who id={e.id} />
      </span>
      <span className="ml-auto shrink-0 pl-2 text-xs text-fg-4 underline decoration-dotted">
        Add agent
      </span>
    </button>
  );
}

/**
 * Agents as inline tags with a filterable dropdown. Type to filter by id, name, provider or
 * role; Enter picks the highlighted entry (or a typed id); Backspace on an empty box removes the
 * last tag.
 *
 * Only ids a write accepts are offered: people, wildcards, role files and opsd.agents entries.
 * The others (a runtime with a usual role, an agent seen lately, a typed unknown id) show greyed
 * under **Not configured**, and a click on one opens Add agent for it. Run pickers pass
 * `runnable`: opsd starts a run as any runtime and role, so they offer every id.
 */
export function AgentPicker(props: {
  value: string[];
  onChange: (v: string[]) => void;
  me: string | null;
  multiple?: boolean;
  placeholder?: string;
  /** Leave out wildcards, for fields that need one id (a reviewer, a run's agent). */
  noGroups?: boolean;
  /** Leave out the reader, for fields that notify someone else. */
  noSelf?: boolean;
  /** Leave out people, for fields only an agent can fill (who a question goes to). */
  noHumans?: boolean;
  /** Offer every id opsd can start a run as, configured or not: for a run's or schedule's agent. */
  runnable?: boolean;
  autoFocus?: boolean;
}) {
  const allowed = (id: string): boolean =>
    !(props.noHumans && identity(id).human) && !(props.noSelf && id === props.me);
  const dir = useDirectory(props.me).filter((e) => !(props.noGroups && e.group) && allowed(e.id));
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const shown = dir.filter((e) => !props.value.includes(e.id) && matches(e, q.trim()));
  const offered = (e: DirectoryEntry): boolean => Boolean(props.runnable) || e.configured;
  const options = shown.filter(offered);
  const typed = q.trim().toLowerCase();
  const custom =
    ID_RE.test(typed) && allowed(typed) && !dir.some((e) => e.id === typed) ? typed : null;
  const typedEntry: DirectoryEntry | null = custom
    ? {
        id: custom,
        name: 'typed id',
        configured: custom.includes('*') || identity(custom).human || !checksIds(dir),
      }
    : null;
  const list: DirectoryEntry[] =
    typedEntry && offered(typedEntry) ? [typedEntry, ...options] : options;
  const refused = [
    ...(typedEntry && !offered(typedEntry) ? [typedEntry] : []),
    ...shown.filter((e) => !offered(e)),
  ];
  const pick = (id: string): void => {
    props.onChange(props.multiple ? [...props.value, id] : [id]);
    setQ('');
    setHi(0);
    if (!props.multiple) {
      setOpen(false);
      input.current?.blur();
    }
  };
  // Add agent answers after the dialog closes, so read the value then, not at the click.
  const latest = useRef(props);
  latest.current = props;
  const addAdded = (id: string): void => {
    const p = latest.current;
    p.onChange(p.multiple ? [...p.value.filter((x) => x !== id), id] : [id]);
  };
  const full = !props.multiple && props.value.length > 0;
  return (
    <div
      ref={box}
      onClick={(e) => {
        // Clicks in the list bubble here through the portal; only a click on the box itself
        // focuses the input and opens the list again.
        if (!box.current?.contains(e.target as Node)) return;
        input.current?.focus();
        setOpen(true);
      }}
      className="flex min-h-[34px] cursor-text flex-wrap items-center gap-1 rounded-lg border border-white/10 bg-ink-950/60 px-1.5 py-1 transition focus-within:border-signal/60 focus-within:shadow-[0_0_0_3px_rgba(92,225,230,0.12)]"
    >
      {props.value.map((id) => (
        <AgentTag
          key={id}
          id={id}
          onRemove={() => props.onChange(props.value.filter((x) => x !== id))}
        />
      ))}
      <input
        ref={input}
        autoFocus={props.autoFocus}
        value={q}
        placeholder={props.value.length === 0 ? props.placeholder : full ? '' : 'add…'}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHi((h) => Math.min(h + 1, list.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if ((e.key === 'Enter' || e.key === 'Tab') && open && list[hi]) {
            e.preventDefault();
            pick(list[hi].id);
          } else if (e.key === 'Backspace' && !q && props.value.length > 0) {
            props.onChange(props.value.slice(0, -1));
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        className="min-w-16 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-fg-4"
        style={{ width: full ? 24 : undefined }}
      />
      <Popover
        anchor={box}
        open={open && list.length + refused.length > 0}
        onClose={() => setOpen(false)}
      >
        <div className="max-h-72 overflow-auto">
          {list.some((e) => !e.group) && <div className="label-caps px-2 pt-1.5 pb-1">Agents</div>}
          {list.map(
            (e, i) =>
              !e.group && (
                <OptionRow key={e.id} e={e} active={i === hi} onPick={() => pick(e.id)} />
              ),
          )}
          {list.some((e) => e.group) && <div className="label-caps px-2 pt-2 pb-1">Groups</div>}
          {list.map(
            (e, i) =>
              e.group && <OptionRow key={e.id} e={e} active={i === hi} onPick={() => pick(e.id)} />,
          )}
          {refused.length > 0 && (
            <>
              <div className="label-caps px-2 pt-2 pb-0.5">Not configured</div>
              <div className="px-2 pb-1 text-[11px] text-fg-4">
                No run picks up work for these. Add one as an agent to hand it work.
              </div>
              {refused.map((e) => (
                <UnconfiguredRow
                  key={e.id}
                  e={e}
                  onOpen={() => {
                    setOpen(false);
                    setQ('');
                    openAddAgent(e.id, addAdded);
                  }}
                />
              ))}
            </>
          )}
        </div>
      </Popover>
    </div>
  );
}

// ---- Mentions in text ----------------------------------------------------------------------------

/** One row of the # picker: a task (status, id, title, project) or a project. */
function RefRow({ o, active, onPick }: { o: RefOption; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onMouseDown={(ev) => ev.preventDefault()}
      onClick={onPick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
        active ? 'bg-white/8' : 'hover:bg-white/5'
      }`}
    >
      {o.task ? (
        <>
          <StatusIcon status={o.task.status} size={13} />
          <span className="shrink-0 font-mono text-xs text-fg-2">{o.text}</span>
          <span className="min-w-0 flex-1 truncate text-fg">{o.task.title}</span>
          {o.task.project && (
            <span className="shrink-0 text-[11px] text-fg-4">{o.task.project}</span>
          )}
        </>
      ) : (
        <>
          <FolderKanban size={13} className="text-fg-3" />
          <span className="min-w-0 flex-1 truncate text-fg">{o.project}</span>
          <span className="shrink-0 text-[11px] text-fg-4">{o.open} open</span>
        </>
      )}
    </button>
  );
}

interface RefOption {
  /** What the pick inserts: `AO-0047`, `root/AO-0047` or `project:v2`. */
  text: string;
  task?: RefTask;
  project?: string;
  open?: number;
}

/**
 * A textarea where `@` opens the agent list and `#` the task list. For `@`, type to filter and
 * Enter or Tab inserts `@id `; a mention puts the message in that agent's inbox. For `#`, type an
 * id, a number or words of a title: open tasks come first, then projects; a pick replaces the `#`
 * with a plain reference agents read as-is (`AO-0047`, `root/AO-0047` when two roots share the
 * id, or `project:v2`). The app draws task references as chips. Ctrl+Enter calls `onSubmit`.
 *
 * With `attach`, images pasted, dropped or picked with the image button upload to the data root
 * and their Markdown links go in at the caret. While one uploads, Ctrl+Enter does nothing and
 * `onUploading(true)` tells the form to hold its send buttons, so text never goes out without the
 * image link it is waiting for.
 */
export function MentionArea(props: {
  value: string;
  onChange: (v: string) => void;
  me: string | null;
  placeholder?: string;
  rows?: number;
  onSubmit?: () => void;
  autoFocus?: boolean;
  attach?: AttachTarget;
  onUploading?: (busy: boolean) => void;
}) {
  // A mention puts the text in an inbox, and only configured agents have a run that reads one.
  const dir = useDirectory(props.me).filter((e) => e.configured);
  const tasks = useRefTasks();
  const area = useRef<HTMLTextAreaElement>(null);
  // Uploads finish after later keystrokes: insert into the text as it is then, not as it was.
  const latest = useRef(props.value);
  latest.current = props.value;
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  const files = useAttach(props.attach, (markdown) => {
    const el = area.current;
    const text = latest.current;
    const start = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    const next = insertAt(text, start, end, markdown);
    latest.current = next.text;
    onChange.current(next.text);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  });
  const onUploading = useRef(props.onUploading);
  onUploading.current = props.onUploading;
  useEffect(() => {
    onUploading.current?.(files.busy);
  }, [files.busy]);
  const [at, setAt] = useState<{ start: number; query: string; kind: '@' | '#' } | null>(null);
  const [hi, setHi] = useState(0);
  const agents =
    at?.kind === '@' ? dir.filter((e) => matches(e, at.query.replace(/:$/, ''))).slice(0, 8) : [];
  const refs: RefOption[] =
    at?.kind === '#'
      ? [
          ...rankRefTasks(tasks, at.query, 8).map((t) => ({ text: refFor(t, tasks), task: t })),
          ...rankRefProjects(tasks, at.query, 3).map((p) => ({
            text: projectRef(p.name),
            project: p.name,
            open: p.open,
          })),
        ]
      : [];
  const count = at?.kind === '#' ? refs.length : agents.length;
  const insert = (text: string): void => {
    if (!at || !area.current) return;
    const caret = area.current.selectionStart;
    const next = `${props.value.slice(0, at.start)}${text} ${props.value.slice(caret)}`;
    props.onChange(next);
    setAt(null);
    const pos = at.start + text.length + 1;
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(pos, pos);
    });
  };
  const pickAt = (i: number): void => {
    if (at?.kind === '#') insert(refs[i]!.text);
    else insert(`@${agents[i]!.id}`);
  };
  const track = (el: HTMLTextAreaElement): void => {
    const m = mentionAt(el.value, el.selectionStart);
    const h = m ? null : hashAt(el.value, el.selectionStart);
    setAt(m ? { ...m, kind: '@' } : h ? { ...h, kind: '#' } : null);
    setHi(0);
  };
  // Spoken text replaces the selection, or goes in at the caret, as typing would.
  const speak = (text: string): void => {
    const el = area.current;
    const end = el ? el.selectionEnd : props.value.length;
    const next = insertSpoken(props.value, el ? el.selectionStart : end, end, text);
    props.onChange(next.value);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  return (
    <div className="relative">
      <textarea
        ref={area}
        autoFocus={props.autoFocus}
        rows={props.rows ?? 3}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => {
          props.onChange(e.target.value);
          track(e.target);
        }}
        onClick={(e) => track(e.currentTarget)}
        onKeyDown={(e) => {
          if (at && count > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              return setHi((h) => Math.min(h + 1, count - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              return setHi((h) => Math.max(h - 1, 0));
            }
            if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
              e.preventDefault();
              return pickAt(Math.min(hi, count - 1));
            }
            if (e.key === 'Escape') {
              // Closes the list only, not the dialog the text is in.
              e.stopPropagation();
              e.preventDefault();
              return setAt(null);
            }
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && props.onSubmit) {
            e.preventDefault();
            if (!files.busy) props.onSubmit();
          }
        }}
        onBlur={() => setTimeout(() => setAt(null), 120)}
        onPaste={files.onPaste}
        onDragOver={files.onDragOver}
        onDrop={files.onDrop}
        className={`w-full resize-y rounded-lg border border-white/10 bg-ink-950/60 py-2 pl-3 text-sm leading-relaxed outline-none transition placeholder:text-fg-4 focus:border-signal/60 focus:shadow-[0_0_0_3px_rgba(92,225,230,0.12)] ${files.enabled ? 'pr-16' : 'pr-10'}`}
      />
      {files.enabled && <AttachButton busy={files.busy} onFiles={files.upload} />}
      {/* With the image button in the corner, the microphone sits to its left. */}
      <MicButton
        className={`absolute top-1.5 ${files.enabled ? 'right-8' : 'right-1.5'}`}
        onText={speak}
      />
      {files.error && (
        <div role="alert" className="mt-1 flex items-center gap-2 text-xs text-[#ffb3ba]">
          <span className="flex-1">Image not attached: {files.error}</span>
          <button
            type="button"
            className="text-fg-4 hover:text-fg"
            onClick={files.clearError}
            aria-label="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      )}
      {at?.kind === '@' && agents.length > 0 && (
        <div className="animate-fade absolute top-full left-0 z-50 mt-1 w-80 rounded-xl border border-white/10 bg-ink-800/95 p-1 shadow-2xl backdrop-blur">
          <div className="label-caps px-2 pt-1 pb-1">Mention</div>
          {agents.map((e, i) => (
            <OptionRow key={e.id} e={e} active={i === hi} onPick={() => pickAt(i)} />
          ))}
        </div>
      )}
      {at?.kind === '#' && refs.length > 0 && (
        <div
          role="listbox"
          aria-label="Reference a task"
          className="animate-fade absolute top-full left-0 z-50 mt-1 w-[30rem] max-w-full rounded-xl border border-white/10 bg-ink-800/95 p-1 shadow-2xl backdrop-blur"
        >
          {refs.some((o) => o.task) && <div className="label-caps px-2 pt-1 pb-1">Tasks</div>}
          {refs.map(
            (o, i) =>
              o.task && <RefRow key={o.text} o={o} active={i === hi} onPick={() => pickAt(i)} />,
          )}
          {refs.some((o) => o.project) && <div className="label-caps px-2 pt-2 pb-1">Projects</div>}
          {refs.map(
            (o, i) =>
              o.project && <RefRow key={o.text} o={o} active={i === hi} onPick={() => pickAt(i)} />,
          )}
        </div>
      )}
    </div>
  );
}

// ---- Due date and time ---------------------------------------------------------------------------

export interface Due {
  date: string;
  time?: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WEEK = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const SLOTS = Array.from(
  { length: 48 },
  (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`,
);

/** The due value to send for a picked date and optional time ('' when none). */
export function dueToApi(d: Due | null): string {
  return d ? dueValue(d.date, d.time) : '';
}

/**
 * A due date with a calendar, and a time only when you add one: a date alone means the end of
 * that day.
 */
export function DuePicker({
  value,
  onChange,
}: {
  value: Due | null;
  onChange: (d: Due | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const today = new Date();
  const initial = value ? new Date(`${value.date}T00:00`) : today;
  const [month, setMonth] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1));
  const [withTime, setWithTime] = useState(Boolean(value?.time));
  const slots = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && withTime) {
      const t = value?.time ?? '17:00';
      slots.current?.querySelector(`[data-t="${t}"]`)?.scrollIntoView({ block: 'center' });
    }
  }, [open, withTime, value?.time]);
  const first = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [
    ...Array<null>(first).fill(null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  const label = value
    ? dueLabel(
        value.time
          ? dueValue(value.date, value.time)
          : new Date(`${value.date}T23:59:00`).toISOString(),
      )
    : null;
  const quick: Array<[string, Date]> = [
    ['Today', today],
    ['Tomorrow', new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)],
    [
      'Next Monday',
      new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate() + ((8 - today.getDay()) % 7 || 7),
      ),
    ],
    ['In a week', new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7)],
  ];
  // A date pick finishes the choice unless a time is still to be picked; a time slot always does.
  const setDate = (date: string): void => {
    onChange({ date, time: withTime ? (value?.time ?? '17:00') : undefined });
    if (!withTime) setOpen(false);
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-[34px] items-center gap-2 rounded-lg border px-2.5 text-sm transition ${
          value ? 'border-signal/30 bg-signal/8 text-fg' : 'border-white/10 bg-ink-950/60 text-fg-4'
        } hover:border-signal/50`}
      >
        <CalendarClock
          size={15}
          className={label?.overdue ? 'text-bad' : value ? 'text-signal' : ''}
        />
        {label ? label.text : 'Due date'}
        {value && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
              setWithTime(false);
            }}
            className="-mr-1 rounded p-0.5 text-fg-3 hover:bg-white/10 hover:text-fg"
            aria-label="Clear due date"
          >
            <X size={13} />
          </span>
        )}
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        width={withTime ? 392 : 288}
      >
        <div className="flex gap-2 p-2">
          <div className="w-[264px]">
            <div className="mb-2 flex flex-wrap gap-1">
              {quick.map(([name, d]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    setDate(ymd(d));
                    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
                  }}
                  className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-fg-2 hover:bg-white/10 hover:text-fg"
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="mb-1 flex items-center justify-between">
              <button
                type="button"
                className="rounded p-1 text-fg-3 hover:bg-white/8 hover:text-fg"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                aria-label="Previous month"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="font-display text-sm font-semibold tracking-wide">
                {month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
              </span>
              <button
                type="button"
                className="rounded p-1 text-fg-3 hover:bg-white/8 hover:text-fg"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                aria-label="Next month"
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
              {WEEK.map((w) => (
                <div key={w} className="py-1 text-fg-4">
                  {w}
                </div>
              ))}
              {cells.map((d, i) => {
                if (d === null) return <div key={`e${i}`} />;
                const date = ymd(new Date(month.getFullYear(), month.getMonth(), d));
                const isToday = date === ymd(today);
                const picked = value?.date === date;
                const past = date < ymd(today);
                return (
                  <button
                    key={date}
                    type="button"
                    onClick={() => setDate(date)}
                    className={`h-8 rounded-md transition ${
                      picked
                        ? 'bg-signal font-semibold text-ink-950 shadow-[0_0_14px_-2px_rgba(92,225,230,0.7)]'
                        : isToday
                          ? 'text-signal ring-1 ring-signal/40 hover:bg-white/8'
                          : past
                            ? 'text-fg-4 hover:bg-white/5'
                            : 'text-fg-2 hover:bg-white/8 hover:text-fg'
                    }`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => {
                const next = !withTime;
                setWithTime(next);
                if (value)
                  onChange({ date: value.date, time: next ? (value.time ?? '17:00') : undefined });
              }}
              className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs transition ${
                withTime
                  ? 'bg-signal/12 text-signal'
                  : 'bg-white/5 text-fg-3 hover:bg-white/8 hover:text-fg'
              }`}
            >
              <Clock size={13} />
              {withTime ? 'Remove time (due end of day)' : 'Add a time'}
            </button>
          </div>
          {withTime && (
            <div
              ref={slots}
              className="h-[300px] w-[104px] overflow-auto border-l border-white/8 pl-2"
            >
              {SLOTS.map((t) => (
                <button
                  key={t}
                  data-t={t}
                  type="button"
                  onClick={() => {
                    onChange({ date: value?.date ?? ymd(today), time: t });
                    setOpen(false);
                  }}
                  className={`block w-full rounded-md py-1 text-center font-mono text-xs ${
                    value?.time === t ? 'bg-signal text-ink-950' : 'text-fg-2 hover:bg-white/8'
                  }`}
                >
                  {t}
                </button>
              ))}
              <input
                type="time"
                value={value?.time ?? ''}
                onChange={(e) =>
                  e.target.value &&
                  onChange({ date: value?.date ?? ymd(today), time: e.target.value })
                }
                className="mt-1 w-full rounded-md border border-white/10 bg-ink-950 px-1 py-1 font-mono text-xs"
                title="Any minute"
              />
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
