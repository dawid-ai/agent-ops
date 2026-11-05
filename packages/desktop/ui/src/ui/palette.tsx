import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  CircleCheck,
  CornerDownLeft,
  Eye,
  Hand,
  Keyboard,
  Play,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Nav, View } from '../App';
import { Modal, cx } from '../components';
import { GO_KEYS, rankTasks, SHORTCUTS } from '../lib/keys';
import { moveTo } from '../lib/transitions';
import type { Status, Task } from '../types';
import { PriorityIcon, StatusIcon } from './identity';

interface Item {
  key: string;
  group: string;
  label: string;
  hint?: string;
  icon: LucideIcon | null;
  task?: Task;
  run: () => void;
}

/**
 * Moves the palette offers on the open task, in the board's order; each goes through useMover,
 * which asks for a click before it changes anything.
 */
const MOVES: Array<{ target: Status; label: string; icon: LucideIcon }> = [
  { target: 'in-progress', label: 'Start work', icon: Play },
  { target: 'needs-review', label: 'Send for review', icon: Eye },
  { target: 'blocked', label: 'Block', icon: Hand },
  { target: 'done', label: 'Mark done', icon: CircleCheck },
  { target: 'todo', label: 'Back to to do', icon: RotateCcw },
];

/**
 * Ctrl+K: jump to a task by id or title, switch view, act on the open task, or create a task.
 * Every action goes through the same calls as the buttons it stands for.
 */
export function Palette(props: {
  nav: Nav;
  tasks: Task[];
  open: Task | undefined;
  onMove: (t: Task, target: Status) => void;
  onNew: () => void;
  onHelp: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const items = useMemo((): Item[] => {
    const qy = query.trim().toLowerCase();
    const has = (s: string): boolean => !qy || s.toLowerCase().includes(qy);
    const out: Item[] = [];
    const t = props.open;
    if (t) {
      for (const m of MOVES) {
        if (typeof moveTo(t, m.target) === 'string') continue;
        // By its label only: typing the open task's id finds tasks, not a move on it (AO-0134).
        if (!has(m.label)) continue;
        out.push({
          key: `move:${m.target}`,
          group: `${t.id}`,
          label: m.label,
          icon: m.icon,
          run: () => props.onMove(t, m.target),
        });
      }
    }
    for (const found of rankTasks(props.tasks, query)) {
      out.push({
        key: `task:${found.root}/${found.id}`,
        group: 'Tasks',
        label: found.title,
        hint: found.id,
        icon: null,
        task: found,
        run: () => props.nav.openTask(`${found.root}/${found.id}`),
      });
    }
    for (const [letter, v] of Object.entries(GO_KEYS)) {
      if (!has(`go ${v.label}`)) continue;
      out.push({
        key: `go:${v.view}`,
        group: 'Go to',
        label: v.label,
        hint: `g ${letter}`,
        icon: ArrowRight,
        run: () => props.nav.go(v.view as View),
      });
    }
    if (has('new task create')) {
      out.push({
        key: 'new',
        group: 'Create',
        label: 'New task',
        hint: 'n',
        icon: Plus,
        run: props.onNew,
      });
    }
    if (has('keyboard shortcuts help')) {
      out.push({
        key: 'help',
        group: 'Help',
        label: 'Keyboard shortcuts',
        hint: '?',
        icon: Keyboard,
        run: props.onHelp,
      });
    }
    return out;
  }, [query, props]);

  const pick = Math.min(hi, Math.max(items.length - 1, 0));
  const choose = (it: Item | undefined): void => {
    if (!it) return;
    props.onClose();
    it.run();
  };

  let lastGroup = '';
  return (
    <div
      data-modal
      className="animate-fade fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={props.onClose}
    >
      <div
        className="animate-rise w-[620px] max-w-[94vw] overflow-hidden rounded-2xl border border-white/10 bg-ink-850 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),0_0_40px_-18px_rgba(92,225,230,0.5)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-white/8 px-4">
          <Search size={16} className="text-signal" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') props.onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHi((pick + 1) % Math.max(items.length, 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHi((pick - 1 + items.length) % Math.max(items.length, 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(items[pick]);
              }
            }}
            placeholder={
              props.open
                ? `Act on ${props.open.id}, find a task, or go to a view`
                : 'Find a task by id or title, or go to a view'
            }
            className="h-12 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-4"
          />
          <kbd className="rounded border border-white/10 px-1.5 font-mono text-[10px] text-fg-4">
            Esc
          </kbd>
        </div>
        <div className="max-h-[56vh] overflow-y-auto p-2">
          {items.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-fg-4">Nothing matches.</div>
          )}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            const Icon = it.icon;
            return (
              <div key={it.key}>
                {head && <div className="label-caps px-2.5 pt-2 pb-1">{head}</div>}
                <button
                  type="button"
                  onMouseEnter={() => setHi(i)}
                  onClick={() => choose(it)}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition',
                    i === pick ? 'bg-signal/10 text-fg' : 'text-fg-2',
                  )}
                >
                  {it.task ? (
                    <>
                      <StatusIcon status={it.task.status} />
                      <PriorityIcon p={it.task.priority} />
                    </>
                  ) : (
                    Icon && <Icon size={15} className={i === pick ? 'text-signal' : 'text-fg-4'} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="font-mono text-[11px] text-fg-4">{it.hint}</span>}
                  {i === pick && <CornerDownLeft size={13} className="text-signal" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** `?`: every shortcut. */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" icon={Keyboard} onClose={onClose} width={440}>
      <div className="divide-y divide-white/6">
        {SHORTCUTS.map(([k, what]) => (
          <div key={k} className="flex items-center justify-between py-2 text-sm">
            <span className="text-fg-2">{what}</span>
            <span className="flex gap-1">
              {k.split(' ').map((part) => (
                <kbd
                  key={part}
                  className="rounded-md border border-white/12 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-fg"
                >
                  {part}
                </kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 text-xs text-fg-4">
        Single-key shortcuts never fire while you type in a field.
      </div>
    </Modal>
  );
}
