import { ArrowRightLeft, Bot, Hand } from 'lucide-react';
import { useState } from 'react';
import type { Nav } from '../App';
import { api, q, refreshSoon } from '../api';
import { Button, ErrorLine, Field, Input, Modal, useAction } from '../components';
import { statusInfo } from '../lib/identity';
import type { Move } from '../lib/transitions';
import { moveRequest, moveTo } from '../lib/transitions';
import type { Status, Task } from '../types';
import { StatusIcon } from './identity';
import { AgentPicker, MentionArea } from './pickers';
import { onTaskRef, RefText } from './refs';

interface Pending {
  task: Task;
  move: Move;
}

/**
 * Moves tasks between statuses from the board, the task panel and the palette. Every move opens a
 * dialog and applies only when you click its button there, so a stray menu pick, drop or Enter
 * never closes or reopens a task in your name (AO-0134). `onError` gets a refusal (from the rules
 * or opsd).
 */
export function useMover(nav: Nav, onError: (msg: string | null) => void) {
  const [pending, setPending] = useState<Pending | null>(null);
  const ref = (t: Task): string => `${t.root}/${t.id}`;
  const apply = async (
    t: Task,
    move: Move,
    input: { message?: string; to?: string; on?: string },
  ) => {
    const { path, body } = moveRequest(move, input);
    await api('POST', `/api/tasks/${q(ref(t))}/${path}`, { as: nav.me, ...body });
    refreshSoon();
  };
  const request = (t: Task, target: Status): void => {
    const m = moveTo(t, target);
    if (typeof m === 'string') {
      onError(`${t.id} cannot move to ${statusInfo(target).label}: ${m}`);
      return;
    }
    onError(null);
    setPending({ task: t, move: m });
  };
  const dialog = pending ? (
    <MoveDialog
      key={`${ref(pending.task)}:${pending.move.action}`}
      nav={nav}
      task={pending.task}
      move={pending.move}
      onClose={() => setPending(null)}
      apply={(input) => apply(pending.task, pending.move, input)}
    />
  ) : null;
  return { request, dialog };
}

/** What a move without other input does, for its confirmation line. */
const MOVE_SAYS: Partial<Record<Move['action'], string>> = {
  done: 'Closes the task as done',
  reopen: 'Reopens the task: it goes back to To do, and opsd may wake its owner',
  unblock: 'Unblocks the task: it goes back to To do',
  release: 'Releases the claim: the task goes back to the queue',
};

function MoveDialog(props: {
  nav: Nav;
  task: Task;
  move: Move;
  onClose: () => void;
  apply: (input: { message?: string; to?: string; on?: string }) => Promise<void>;
}) {
  const { task: t, move, nav } = props;
  const act = useAction();
  const [message, setMessage] = useState('');
  const [to, setTo] = useState<string[]>(() => {
    if (move.needs === 'reviewer' && t.delegation?.review) return [t.delegation.review];
    if (
      move.needs === 'work' &&
      t.owner &&
      !t.owner.includes('*') &&
      !t.owner.startsWith('human:')
    ) {
      return [t.owner];
    }
    return [];
  });
  const [on, setOn] = useState('');
  const [mode, setMode] = useState<'agent' | 'me'>(
    move.needs === 'work' && t.owner && !t.owner.startsWith('human:') ? 'agent' : 'me',
  );
  const target = statusInfo(move.target);
  const submit = (): void => {
    if (move.needs === 'work' && mode === 'agent') {
      act.run(
        () => api('POST', '/api/runs', { agent: to[0], task: `${t.root}/${t.id}` }),
        () => {
          refreshSoon();
          props.onClose();
          nav.go('runs');
        },
      );
      return;
    }
    act.run(() => props.apply({ message, to: to[0], on }), props.onClose);
  };
  // Blocking and requesting changes say why; parking and review notes are optional.
  const ready =
    move.needs === 'work'
      ? mode === 'me' || to.length === 1
      : move.action === 'block' || move.action === 'verdict-changes'
        ? message.trim().length > 0
        : true;
  return (
    <Modal title={move.label} icon={ArrowRightLeft} onClose={props.onClose} width={520}>
      {/* App opens a clicked reference in the task panel; close the dialog so the panel shows. */}
      <div
        className="mb-4 flex items-center gap-2 text-sm text-fg-3"
        onClick={(e) => onTaskRef(e) && props.onClose()}
      >
        <span className="font-mono text-xs text-fg-4">{t.id}</span>
        <span className="truncate text-fg-2">
          <RefText text={t.title} />
        </span>
        <span
          className="ml-auto inline-flex items-center gap-1.5 text-xs"
          style={{ color: target.color }}
        >
          <StatusIcon status={move.target} size={12} /> {target.label}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {move.needs === 'work' && (
          <>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['agent', Bot, 'Run an agent', 'opsd starts a run that claims it'],
                  ['me', Hand, 'I take it', 'you hold the claim'],
                ] as const
              ).map(([key, Icon, title, hint]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  className={`rounded-xl border p-3 text-left transition ${
                    mode === key
                      ? 'border-signal/50 bg-signal/8 shadow-[0_0_20px_-8px_rgba(92,225,230,0.7)]'
                      : 'border-white/10 hover:border-white/20'
                  }`}
                >
                  <Icon size={18} className={mode === key ? 'text-signal' : 'text-fg-3'} />
                  <div className="mt-1.5 text-sm font-medium">{title}</div>
                  <div className="text-xs text-fg-4">{hint}</div>
                </button>
              ))}
            </div>
            {mode === 'agent' && (
              <Field label="Agent" hint={t.owner ? `Owner: ${t.owner}` : undefined}>
                <AgentPicker
                  value={to}
                  onChange={setTo}
                  me={nav.me}
                  noGroups
                  placeholder="Pick an agent"
                  autoFocus
                />
              </Field>
            )}
          </>
        )}
        {move.needs === 'reviewer' && (
          <Field
            label="Reviewer"
            hint="Another provider than the author, or a person. Empty: the delegation's reviewer or you."
          >
            <AgentPicker
              value={to}
              onChange={setTo}
              me={nav.me}
              noGroups
              placeholder="Who reviews"
              autoFocus
            />
          </Field>
        )}
        {move.action === 'block' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Waiting on" hint="Leave empty to wait on you">
              <AgentPicker
                value={to}
                onChange={setTo}
                me={nav.me}
                noGroups
                placeholder="A person or agent"
              />
            </Field>
            <Field label="Or on tasks" hint="Ids, comma separated">
              <Input value={on} onChange={setOn} placeholder="AO-0012, AO-0014" />
            </Field>
          </div>
        )}
        {!move.needs && (
          <>
            <p className="text-sm text-fg-3" data-move-confirm>
              {MOVE_SAYS[move.action] ?? 'Changes the status'}, as{' '}
              <span className="font-mono text-xs">{nav.me ?? 'you'}</span>. Nothing changes until
              you click {move.label}.
            </p>
            <Field label="Note" hint="Optional; it goes on the event">
              <MentionArea value={message} onChange={setMessage} me={nav.me} rows={2} />
            </Field>
          </>
        )}
        {(move.needs === 'reason' || move.needs === 'reviewer') && (
          <Field
            label={
              move.action === 'block'
                ? 'Why it is blocked'
                : move.action === 'park'
                  ? 'Why it is not planned'
                  : move.action === 'verdict-changes'
                    ? 'What to change'
                    : 'Note for the reviewer'
            }
          >
            <MentionArea
              value={message}
              onChange={setMessage}
              me={nav.me}
              rows={3}
              onSubmit={() => ready && submit()}
            />
          </Field>
        )}
        <ErrorLine error={act.error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!ready || act.busy} onClick={submit}>
            {move.needs === 'work' && mode === 'agent' ? 'Start run' : move.label}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
