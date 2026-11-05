import { Archive, Bug, Lightbulb, ListChecks, MessageCircleQuestion, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { api, q, refreshSoon } from '../api';
import { Button, ErrorLine, Input, Who, useAction } from '../components';
import type { Question } from '../types';
import { AgentPicker, MentionArea } from './pickers';

/** Whether a task that waits on `waitingOn` waits on `me`; no one named means any person. */
export function waitsOn(waitingOn: string | null | undefined, me: string | null): boolean {
  if (!me) return false;
  if (!waitingOn) return me.startsWith('human:');
  if (waitingOn === me) return true;
  return waitingOn.endsWith(':*') && me.startsWith(waitingOn.slice(0, -1));
}

/**
 * The triage actions for a finding, shared by the Findings view and the Inbox so both act on the
 * same state: accept as a task or bug (with an owner), set aside as an idea, or park. With an open
 * question to you, the answer goes in the same write as Accept.
 */
export function TriageActions({
  task,
  owner,
  question,
  me,
  onDone,
}: {
  /** The task ref the API resolves: `root/id`, or an id when it is unique. */
  task: string;
  owner?: string | null;
  question?: Question;
  me: string | null;
  /** Runs after an action lands, with what happened, such as `Accepted as task`. */
  onDone?: (what: string) => void;
}) {
  const act = useAction();
  const [picked, setPicked] = useState<string[]>(owner ? [owner] : []);
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

  /** Accept as `type`, with the picked owner and the answer, if any, in the same write. */
  const accept = (type: string): void => {
    const text = answer.trim();
    act.run(
      () =>
        post('retype', {
          type,
          to: picked[0] || undefined,
          answer: text || undefined,
          message: 'Accepted in triage',
        }),
      after(`Accepted as ${type}${text ? ', answer sent' : ''}`),
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
          <div className="mb-2 text-sm whitespace-pre-wrap text-fg-2">{question.summary}</div>
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
            placeholder="Owner when accepted"
          />
        </div>
        <Button
          size="sm"
          kind="primary"
          icon={ListChecks}
          disabled={act.busy}
          onClick={() => accept('task')}
        >
          Accept as task
        </Button>
        <Button size="sm" icon={Bug} disabled={act.busy} onClick={() => accept('bug')}>
          Bug
        </Button>
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
            <UserPlus size={12} /> assigns on accept
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
