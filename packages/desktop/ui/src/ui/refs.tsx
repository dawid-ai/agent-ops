import type { ReactNode } from 'react';
import { Fragment, useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { statusInfo } from '../lib/identity';
import type { RefTask } from '../lib/refs';
import {
  parseTaskRef,
  refTask,
  refTasks,
  refTasksVersion,
  refTooltip,
  splitTaskRefs,
  subscribeRefTasks,
} from '../lib/refs';

/** The task index references read (lib/refs.ts); the view draws again when App reloads it. */
export function useRefTasks(): readonly RefTask[] {
  useSyncExternalStore(subscribeRefTasks, refTasksVersion);
  return refTasks();
}

/** An event to scroll to; a new `n` asks the task panel to scroll there again. */
export interface TaskFocus {
  event: string;
  n: number;
}

/**
 * The open task and the event a reference points at. `open('AO-0014#<event id>')` opens the task
 * and focuses the event, `open('AO-0014')` opens it unfocused, `open(null)` closes it. `n` comes
 * from a counter that never resets, so every event reference opened gets a new token, even after
 * a plain reference cleared the focus.
 */
export function useTaskFocus(): {
  task: string | null;
  focus: TaskFocus | null;
  open: (ref: string | null) => void;
} {
  const [task, setTask] = useState<string | null>(null);
  const [focus, setFocus] = useState<TaskFocus | null>(null);
  const seq = useRef(0);
  const open = useCallback((ref: string | null): void => {
    const r = ref ? parseTaskRef(ref) : null;
    setTask(r?.task ?? null);
    setFocus(r?.event ? { event: r.event, n: ++seq.current } : null);
  }, []);
  return { task, focus, open };
}

/**
 * Whether a click landed on a task reference link. Rows that open something on click (a table
 * row, a board card) skip those clicks: App already opens the referenced task.
 */
export function onTaskRef(e: { target: EventTarget | null }): boolean {
  return Boolean((e.target as Element | null)?.closest?.('a[data-task-ref]'));
}

/**
 * Plain message text with its task references as links. App opens `a[data-task-ref]` clicks in
 * the task panel, the same as links in rendered Markdown. A task the index knows gets the same
 * chip as Markdown: a status dot, and its status and title on hover. `render` draws each run of
 * text (for example, with search words marked); `links={false}` keeps the references as text.
 */
export function RefText({
  text,
  render = (s) => s,
  links = true,
}: {
  text: string;
  render?: (text: string) => ReactNode;
  links?: boolean;
}) {
  useRefTasks();
  if (!links) return <>{render(text)}</>;
  return (
    <>
      {splitTaskRefs(text).map((p, i) =>
        typeof p === 'string' ? (
          // Parts never reorder, so the index is a stable key.
          <Fragment key={i}>{render(p)}</Fragment>
        ) : (
          <RefChip key={i} target={p.ref} render={render} />
        ),
      )}
    </>
  );
}

function RefChip({ target, render }: { target: string; render: (text: string) => ReactNode }) {
  const t = refTask(target);
  const st = t ? statusInfo(t.status) : undefined;
  return (
    <a
      className="task-ref"
      href={`#${target}`}
      data-task-ref={target}
      data-status={st?.key}
      title={refTooltip(target, t, st?.label)}
    >
      {st && <span className="ref-dot" />}
      {render(target)}
      {t && <span className="ref-title">{t.title}</span>}
    </a>
  );
}
