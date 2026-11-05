import { SquarePen } from 'lucide-react';
import { useState } from 'react';
import { api, refreshSoon, useData } from '../api';
import { Button, ErrorLine, Field, Input, Modal, PriorityIcon, useAction, cx } from '../components';
import { setBoardShowsIdeas } from '../lib/filters';
import { PRIORITIES } from '../lib/identity';
import { QUESTION } from '../lib/question';
import type { Task } from '../types';
import type { Due } from '../ui/pickers';
import { AgentPicker, DuePicker, dueToApi, MentionArea } from '../ui/pickers';

const TYPES: Array<[string, string]> = [
  ['task', 'Task'],
  ['bug', 'Bug'],
  ['idea', 'Idea'],
  [QUESTION, 'Question'],
  ['finding', 'Finding'],
  ['doc', 'Doc'],
  ['eval', 'Eval'],
];

export function NewTask({
  me,
  onClose,
  onCreated,
}: {
  me: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [owner, setOwner] = useState<string[]>([]);
  const [priority, setPriority] = useState('p2');
  const [type, setType] = useState('task');
  const [project, setProject] = useState('');
  const [due, setDue] = useState<Due | null>(null);
  const tasks = useData<Task[]>('/api/tasks?all');
  const projects = [
    ...new Set((tasks.data ?? []).map((t) => t.project).filter(Boolean)),
  ] as string[];
  const act = useAction();
  const [uploading, setUploading] = useState(false);
  // An idea is not work yet: like `ops new --type idea`, it has no owner and no due date, and stays
  // out of every queue until someone changes its type.
  const idea = type === 'idea';
  // A question goes to one agent (or group) and only it takes it; the answer comes back to your
  // inbox. No due date: nothing is delegated.
  const question = type === QUESTION;
  const people = owner.some((o) => o.startsWith('human:'));
  const missing = question && (owner.length === 0 || people);
  const create = (): void => {
    if (!title.trim() || act.busy || uploading || missing) return;
    let created = '';
    act.run(
      async () => {
        const t = await api<Task>('POST', '/api/tasks', {
          title: title.trim(),
          body,
          to: idea ? undefined : owner[0],
          priority,
          type,
          project: project.trim() || undefined,
        });
        created = `${t.root}/${t.id}`;
        if (question) return;
        if (idea) {
          setBoardShowsIdeas(true);
          return;
        }
        // A due date is part of a delegation: hand it to the owner (or you) with the date.
        const dueValue = dueToApi(due);
        if (dueValue) {
          await api('POST', `/api/tasks/${encodeURIComponent(created)}/delegate`, {
            as: me,
            to: owner[0] ?? me,
            due: dueValue,
            message: '',
          });
        }
      },
      () => {
        refreshSoon();
        onCreated(created);
      },
    );
  };
  return (
    <Modal
      title="New task"
      icon={SquarePen}
      onClose={onClose}
      width={640}
      dirty={Boolean(title.trim() || body.trim() || owner.length > 0 || project.trim() || due)}
    >
      <div className="flex flex-col gap-4">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder={question ? 'The question, in one line' : 'Task title'}
          className="w-full border-b border-white/10 bg-transparent pb-2 font-display text-xl font-semibold tracking-wide outline-none placeholder:text-fg-4 focus:border-signal/60"
        />
        <MentionArea
          value={body}
          onChange={setBody}
          me={me}
          rows={6}
          placeholder="What to do, what done means, links (Markdown). @ mentions an agent. Paste or drop images"
          onSubmit={create}
          // New tasks go to the default root, so their images do too.
          attach={{}}
          onUploading={setUploading}
        />
        <div className="grid grid-cols-[1fr_180px] gap-3">
          {idea ? (
            <Field label="Owner">
              <p className="py-2 text-xs text-fg-3">
                Ideas have no owner and stay out of every queue. Change the type to task or bug when
                it becomes work.
              </p>
            </Field>
          ) : question ? (
            <Field
              label="Ask"
              hint="The agent that answers; only it takes the question, and the answer comes back to your inbox"
            >
              <AgentPicker
                value={owner.filter((o) => !o.startsWith('human:'))}
                onChange={setOwner}
                me={me}
                noHumans
                placeholder="codex:qa, claude:pm…"
              />
            </Field>
          ) : (
            <Field
              label="Owner"
              hint="An agent, a group such as codex:* or *:engineer, or a person"
            >
              <AgentPicker value={owner} onChange={setOwner} me={me} placeholder="Unassigned" />
            </Field>
          )}
          <Field label="Project">
            <Input value={project} onChange={setProject} placeholder="project" />
            {projects.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {projects.slice(0, 5).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProject(p)}
                    className={cx(
                      'rounded px-1.5 text-[11px]',
                      project === p
                        ? 'bg-signal/15 text-signal'
                        : 'bg-white/5 text-fg-3 hover:text-fg',
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </Field>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Priority">
            <div className="flex gap-1">
              {PRIORITIES.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPriority(p.key)}
                  title={p.key}
                  className={cx(
                    'inline-flex h-[34px] items-center gap-1.5 rounded-lg px-2.5 text-xs transition',
                    priority === p.key ? 'ring-1' : 'bg-white/4 text-fg-3 hover:bg-white/8',
                  )}
                  style={
                    priority === p.key
                      ? {
                          color: p.key === 'p3' ? '#b4bccb' : p.color,
                          background: `color-mix(in oklab, ${p.color} 14%, transparent)`,
                          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${p.color} 45%, transparent)`,
                        }
                      : undefined
                  }
                >
                  <PriorityIcon p={p.key} /> {p.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Type">
            <div className="flex gap-1">
              {TYPES.map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setType(v)}
                  className={cx(
                    'h-[34px] rounded-lg px-2.5 text-xs transition',
                    type === v
                      ? 'bg-white/12 text-fg ring-1 ring-white/20'
                      : 'bg-white/4 text-fg-3 hover:bg-white/8',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          {!idea && !question && (
            <Field label="Due">
              <DuePicker value={due} onChange={setDue} />
            </Field>
          )}
        </div>
        <ErrorLine error={act.error} />
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-fg-4">
            Ctrl+Enter in the description creates it
          </span>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={!title.trim() || act.busy || uploading || missing}
            title={
              uploading
                ? 'Waiting for the image upload'
                : missing
                  ? 'Pick the agent that answers first'
                  : undefined
            }
            onClick={create}
          >
            {idea ? 'Create idea' : question ? 'Ask' : 'Create task'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
