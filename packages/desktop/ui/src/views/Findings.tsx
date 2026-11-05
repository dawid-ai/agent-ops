import { Radar } from 'lucide-react';
import type { Nav } from '../App';
import { api, q, refreshSoon, useData } from '../api';
import { Empty, ErrorLine, Section, Who, useAction } from '../components';
import { ago } from '../lib/format';
import { PRIORITIES } from '../lib/identity';
import type { Task } from '../types';
import { PriorityIcon, PriorityTag } from '../ui/identity';
import { Menu } from '../ui/pickers';
import { RefText } from '../ui/refs';
import { TriageActions, waitsOn } from '../ui/triage';

const OPEN = new Set(['todo', 'claimed', 'in-progress', 'blocked', 'needs-review']);

/**
 * Findings agents filed outside their task (`ops finding`), waiting for a person to triage: accept
 * as a task or bug (with a priority and owner), set aside as an idea, or park. The Inbox lists the
 * same findings with the same actions (`TriageActions`); acting in either place clears both.
 */
export function Findings({ nav }: { nav: Nav }) {
  const { data, error } = useData<Task[]>('/api/tasks');
  const findings = (data ?? [])
    .filter((t) => t.type === 'finding' && OPEN.has(t.status))
    .sort((a, b) => a.priority.localeCompare(b.priority) || b.updatedAt.localeCompare(a.updatedAt));
  return (
    <Section
      title="Findings"
      icon={Radar}
      subtitle={
        data
          ? `${findings.length} waiting for triage`
          : 'Bugs, risks and ideas agents filed outside their task'
      }
    >
      <div className="p-6">
        <ErrorLine error={error} />
        {data && findings.length === 0 && (
          <Empty icon={Radar} title="Nothing to triage">
            When an agent runs into a bug, risk or idea outside its task, it files it with{' '}
            <span className="font-mono">ops finding</span>. It lands here for you to sort.
          </Empty>
        )}
        <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
          {findings.map((t, i) => (
            <FindingCard key={`${t.root}/${t.id}`} t={t} nav={nav} index={i} />
          ))}
        </div>
      </div>
    </Section>
  );
}

function FindingCard({ t, nav, index }: { t: Task; nav: Nav; index: number }) {
  const ref = q(`${t.root}/${t.id}`);
  const act = useAction();
  const post = (action: string, body: Record<string, unknown>) =>
    api('POST', `/api/tasks/${ref}/${action}`, { as: nav.me, ...body });

  return (
    <div
      className="panel animate-rise p-4"
      style={{ animationDelay: `${index * 30}ms`, borderLeft: '2px solid #ffb547' }}
    >
      <div className="flex items-start gap-3">
        <div className="row-link group/open min-w-0 flex-1">
          <div className="text-sm font-medium text-fg group-hover/open:text-signal">
            <RefText text={t.title} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-xs text-fg-4">
            <button
              type="button"
              onClick={() => nav.openTask(`${t.root}/${t.id}`)}
              className="row-open cursor-pointer font-mono"
            >
              {t.id}
            </button>
            {t.createdBy && <Who id={t.createdBy} label size="xs" />}
            <span>{ago(t.createdAt ?? t.updatedAt)}</span>
            {t.project && <span className="font-mono">{t.project}</span>}
          </div>
        </div>
        <Menu
          title="Priority"
          value={t.priority}
          onPick={(p) => act.run(() => post('priority', { priority: p }), refreshSoon)}
          items={PRIORITIES.map((p) => ({
            value: p.key,
            label: p.label,
            icon: <PriorityIcon p={p.key} />,
          }))}
          trigger={() => (
            <span className="px-2 py-1">
              <PriorityTag p={t.priority} />
            </span>
          )}
        />
      </div>

      <div className="mt-3">
        <TriageActions
          task={`${t.root}/${t.id}`}
          owner={t.owner}
          question={t.question && waitsOn(t.waitingOn, nav.me) ? t.question : undefined}
          me={nav.me}
        />
      </div>
      <ErrorLine error={act.error} />
    </div>
  );
}
