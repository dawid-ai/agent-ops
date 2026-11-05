import type { Workspace } from '@agent-ops/core';
import { OpsError, runtimeOf } from '@agent-ops/core';
import type { RunRecord } from './runs.js';

export interface ProjectReport {
  project: string;
  opened: number;
  closed: number;
  parked: number;
  /** Open now. */
  open: number;
  /** Blocked now. */
  blocked: number;
}

export interface UsageLine {
  /** An agent id, or a provider such as `claude`. */
  key: string;
  runs: number;
  minutes: number;
  tokens: number;
}

export interface Report {
  from: string;
  to: string;
  projects: ProjectReport[];
  agents: UsageLine[];
  providers: UsageLine[];
  decisions: Array<{ id: string; question: string; choice: string; at: string }>;
  channels: Array<{ channel: string; posts: number }>;
  totals: { opened: number; closed: number; runs: number; minutes: number; tokens: number };
}

/**
 * What happened between `from` and `to` (ms): per project, tasks opened, closed, parked, and open
 * and blocked now; runs, minutes and tokens per agent and provider; decisions taken; channel posts.
 */
export function buildReport(ws: Workspace, runs: RunRecord[], from: number, to: number): Report {
  if (!(from < to)) throw new OpsError('report: the window must end after it starts', 2);
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const inWindow = (iso: string | undefined): boolean => !!iso && iso >= fromIso && iso < toIso;

  const projects = new Map<string, ProjectReport>();
  const project = (name: string): ProjectReport => {
    let p = projects.get(name);
    if (!p) {
      p = { project: name, opened: 0, closed: 0, parked: 0, open: 0, blocked: 0 };
      projects.set(name, p);
    }
    return p;
  };
  for (const t of ws.list({ all: true })) {
    const p = project(t.meta.project ?? t.root);
    if (inWindow(t.meta.created_at)) p.opened++;
    if (!['done', 'parked'].includes(t.status)) p.open++;
    if (t.status === 'blocked' && !t.unblocked) p.blocked++;
    // Closing events in the window; a task closed, reopened and closed again counts once.
    if (t.status === 'done' || t.status === 'parked') {
      const { events } = ws.showEvents(`${t.root}/${t.meta.id}`);
      const last = [...events]
        .reverse()
        .find(
          (e) =>
            e.type === 'done' ||
            e.type === 'park' ||
            (e.type === 'verdict' && e.verdict === 'approve'),
        );
      if (last && inWindow(last.at)) {
        if (t.status === 'parked') p.parked++;
        else p.closed++;
      }
    }
  }

  const agents = new Map<string, UsageLine>();
  const providers = new Map<string, UsageLine>();
  const add = (map: Map<string, UsageLine>, key: string, r: RunRecord, minutes: number): void => {
    const line = map.get(key) ?? { key, runs: 0, minutes: 0, tokens: 0 };
    line.runs++;
    line.minutes += minutes;
    line.tokens += r.tokens;
    map.set(key, line);
  };
  for (const r of runs) {
    if (!inWindow(r.started_at)) continue;
    const end = r.ended_at ? Date.parse(r.ended_at) : Math.min(Date.now(), to);
    const minutes = Math.max(0, Math.round((end - Date.parse(r.started_at)) / 60_000));
    add(agents, r.agent, r, minutes);
    add(providers, runtimeOf(r.agent), r, minutes);
  }

  const decisions = ws
    .decisions({ all: true })
    .filter((d) => d.outcome && inWindow(d.outcome.at))
    .map((d) => ({
      id: d.meta.id,
      question: d.meta.question,
      choice: d.outcome!.choice,
      at: d.outcome!.at,
    }));

  const channels = ws
    .channels()
    .map((c) => ({
      channel: c.name,
      posts: ws.channel(c.name).filter((m) => inWindow(m.at)).length,
    }))
    .filter((c) => c.posts > 0);

  const list = [...projects.values()].sort((a, b) => a.project.localeCompare(b.project));
  const byUse = (a: UsageLine, b: UsageLine): number =>
    b.minutes - a.minutes || a.key.localeCompare(b.key);
  const usage = [...agents.values()];
  return {
    from: fromIso,
    to: toIso,
    projects: list,
    agents: usage.sort(byUse),
    providers: [...providers.values()].sort(byUse),
    decisions,
    channels,
    totals: {
      opened: list.reduce((n, p) => n + p.opened, 0),
      closed: list.reduce((n, p) => n + p.closed, 0),
      runs: usage.reduce((n, u) => n + u.runs, 0),
      minutes: usage.reduce((n, u) => n + u.minutes, 0),
      tokens: usage.reduce((n, u) => n + u.tokens, 0),
    },
  };
}

/** The report as a short Markdown post for a channel. */
export function reportText(r: Report): string {
  const day = (iso: string): string => iso.slice(0, 10);
  const lines = [
    `Report ${day(r.from)} to ${day(r.to)}: ${r.totals.closed} closed, ${r.totals.opened} opened, ` +
      `${r.totals.runs} runs, ${r.totals.minutes} min, ${r.totals.tokens} tokens.`,
  ];
  for (const p of r.projects) {
    if (p.opened + p.closed + p.parked === 0 && p.open === 0) continue;
    lines.push(
      `- ${p.project}: ${p.closed} closed, ${p.opened} opened, ${p.open} open (${p.blocked} blocked)`,
    );
  }
  if (r.providers.length) {
    lines.push(
      `Providers: ${r.providers.map((u) => `${u.key} ${u.runs} runs, ${u.minutes} min`).join('; ')}.`,
    );
  }
  if (r.decisions.length) {
    lines.push(`Decided: ${r.decisions.map((d) => `${d.id} ${d.choice}`).join('; ')}.`);
  }
  return lines.join('\n');
}

const DAY_MS = 86_400_000;

/**
 * The report window from user input: `from` and `to` (dates or ISO times; `to` defaults to
 * now), or the last `days` whole days (1 to 366, default 7).
 */
export function reportWindow(
  input: { days?: string | null; from?: string | null; to?: string | null },
  now = Date.now(),
): { from: number; to: number } {
  if (input.from || input.to) {
    if (!input.from) throw new OpsError('report: give from with to', 2);
    const from = Date.parse(input.from);
    const to = input.to ? Date.parse(input.to) : now;
    if (Number.isNaN(from) || Number.isNaN(to)) {
      throw new OpsError('report: use dates such as 2026-11-01 or ISO times', 2);
    }
    if (!(from < to)) throw new OpsError('report: the window must end after it starts', 2);
    if (to - from > 366 * DAY_MS) throw new OpsError('report: at most 366 days', 2);
    return { from, to };
  }
  const raw = input.days ?? '7';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 366) {
    throw new OpsError('days: use a whole number from 1 to 366', 2);
  }
  return { from: now - Number(raw) * DAY_MS, to: now };
}
