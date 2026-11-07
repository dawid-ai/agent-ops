import {
  Archive,
  Bug,
  ChevronDown,
  Lightbulb,
  ListChecks,
  MessageCircleQuestion,
  UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import { api, q, refreshSoon } from '../api';
import { Button, ErrorLine, Input, Who, useAction } from '../components';
import type { PriorityKey } from '../lib/identity';
import { PRIORITIES, priorityInfo } from '../lib/identity';
import type { Question } from '../types';
import { PriorityIcon } from './identity';
import { Markdown } from './markdown';
import { AgentPicker, MentionArea, Menu } from './pickers';

/** Whether a task that waits on `waitingOn` waits on `me`; no one named means any person. */
export function waitsOn(waitingOn: string | null | undefined, me: string | null): boolean {
  if (!me) return false;
  if (!waitingOn) return me.startsWith('human:');
  if (waitingOn === me) return true;
  return waitingOn.endsWith(':*') && me.startsWith(waitingOn.slice(0, -1));
}

/**
 * The triage actions for a finding or an idea, shared by the Findings view, the Inbox and the task
 * panel so all act on the same state. A finding: accept as a task or bug (with an owner), set aside
 * as an idea, or park. An idea: make it a task or bug (with an owner), or park it. With an open
 * question to you, the answer goes in the same write as Accept; with `priority`, a priority picker
 * sets the priority in that write too.
 */
export function TriageActions({
  task,
  type = 'finding',
  owner,
  priority,
  question,
  me,
  onDone,
}: {
  /** The task ref the API resolves: `root/id`, or an id when it is unique. */
  task: string;
  /** The task's type now: `finding` (the default) or `idea`. */
  type?: string;
  owner?: string | null;
  /** The task's priority now; given, the control shows a priority picker. */
  priority?: PriorityKey;
  question?: Question;
  me: string | null;
  /** Runs after an action lands, with what happened, such as `Accepted as task`. */
  onDone?: (what: string) => void;
}) {
  const act = useAction();
  const idea = type === 'idea';
  const [picked, setPicked] = useState<string[]>(owner ? [owner] : []);
  const [prio, setPrio] = useState<PriorityKey | undefined>(priority);
  // The task can change under the control: the panel stays mounted when its header sets another
  // owner or priority, or another agent does. Follow the new value unless the picker was changed
  // here, so Make task never sends a stale owner or priority back, and an edit in progress stays.
  const [seen, setSeen] = useState({ owner: owner ?? null, priority });
  if (seen.owner !== (owner ?? null) || seen.priority !== priority) {
    if ((picked[0] ?? null) === seen.owner) setPicked(owner ? [owner] : []);
    if (prio === seen.priority) setPrio(priority);
    setSeen({ owner: owner ?? null, priority });
  }
  const [answer, setAnswer] = useState('');
  const [parking, setParking] = useState(false);
  const [reason, setReason] = useState('');
  const post = (action: string, body: Record<string, unknown>) =>
    api('POST', `/api/tasks/${q(task)}/${action}`, { as: me, ...body });
  const after = (what: string) => (): void => {
    setAnswer('');
    onDone?.(what);
    refreshSoon();
  };

  /** Accept as `to`, with the picked owner, priority and answer, if any, in the same write. */
  const accept = (to: string): void => {
    const text = answer.trim();
    act.run(
      () =>
        post('retype', {
          type: to,
          to: picked[0] || undefined,
          priority: prio && prio !== priority ? prio : undefined,
          answer: text || undefined,
          message: idea ? `Made a ${to} from the idea` : 'Accepted in triage',
        }),
      after(`${idea ? 'Made a' : 'Accepted as'} ${to}${text ? ', answer sent' : ''}`),
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {question && (
        <div className="rounded-lg bg-white/4 p-2.5 ring-1 ring-white/8 ring-inset">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-fg-3">
            <MessageCircleQuestion size={13} color="#ffb547" />
            <Who id={question.from} label size="xs" />
            <span>asks you</span>
          </div>
          <Markdown
            text={question.detail ?? question.summary}
            clamp
            className="mb-2 text-sm text-fg-2"
          />
          <MentionArea
            value={answer}
            onChange={setAnswer}
            me={me}
            rows={2}
            placeholder="Your answer, sent with Accept (leave empty to answer later)"
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-64">
          <AgentPicker
            value={picked}
            onChange={setPicked}
            me={me}
            placeholder={idea ? 'Owner of the task' : 'Owner when accepted'}
          />
        </div>
        {prio && (
          <Menu
            title="Priority"
            value={prio}
            onPick={setPrio}
            items={PRIORITIES.map((p) => ({
              value: p.key,
              label: p.label,
              hint: p.key,
              icon: <PriorityIcon p={p.key} />,
            }))}
            trigger={() => (
              <span
                data-priority={prio}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/4 px-2.5 text-xs text-fg-2"
              >
                <PriorityIcon p={prio} />
                {priorityInfo(prio).label}
                <ChevronDown size={13} className="text-fg-4" />
              </span>
            )}
          />
        )}
        <Button
          size="sm"
          kind="primary"
          icon={ListChecks}
          disabled={act.busy}
          onClick={() => accept('task')}
        >
          {idea ? 'Make task' : 'Accept as task'}
        </Button>
        <Button size="sm" icon={Bug} disabled={act.busy} onClick={() => accept('bug')}>
          Bug
        </Button>
        {!idea && (
          <Button
            size="sm"
            icon={Lightbulb}
            disabled={act.busy}
            onClick={() =>
              act.run(
                () => post('retype', { type: 'idea', message: 'Set aside as an idea' }),
                after('Set aside as an idea'),
              )
            }
          >
            Idea
          </Button>
        )}
        <Button
          size="sm"
          kind="ghost"
          icon={Archive}
          disabled={act.busy}
          onClick={() => setParking((p) => !p)}
        >
          Park
        </Button>
        {picked[0] && picked[0] !== owner && (
          <span className="inline-flex items-center gap-1 text-xs text-fg-4">
            <UserPlus size={12} /> assigns on {idea ? 'Make task or Bug' : 'accept'}
          </span>
        )}
      </div>
      {parking && (
        <div className="flex items-center gap-2">
          <Input
            value={reason}
            onChange={setReason}
            placeholder="Why it is not planned"
            className="flex-1"
          />
          <Button
            size="sm"
            kind="danger"
            disabled={act.busy || !reason.trim()}
            onClick={() => act.run(() => post('park', { message: reason.trim() }), after('Parked'))}
          >
            Park it
          </Button>
        </div>
      )}
      <ErrorLine error={act.error} />
    </div>
  );
}
