import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import type {
  ActResult,
  Decision,
  InboxItem,
  OpsEvent,
  Priority,
  RepeatInput,
  RepeatView,
  Status,
  TaskView,
} from '@agent-ops/core';
import {
  defaultHumanId,
  formatMinutes,
  checkRoot,
  editUserConfig,
  initRoot,
  isHuman,
  masterRoot,
  mirrorPartners,
  OpsError,
  readDenyFile,
  readUserConfig,
  scanFiles,
  setRootMirror,
  setupUserConfig,
  STATUSES,
  suggestedRoot,
  syncAll,
  ulidTime,
  Workspace,
} from '@agent-ops/core';
import type { ProcView, RunRecord, SignInState, UsageState, WaitItem } from '@agent-ops/supervisor';
import {
  buildReport,
  daemonCall,
  doctor,
  formatChecks,
  opsdConfig,
  SIGN_IN_FILE,
  signedOutText,
  signedOutView,
  usagePause,
  readDaemon,
  readTail,
  reportText,
  reportWindow,
  RunStore,
  runDaemon,
  seedUserConfig,
  setPaused,
  startDaemon,
  stateDir,
  stopDaemon,
} from '@agent-ops/supervisor';
import { installClaudeHooks, mergeClaudeHooks } from './hooks.js';
import { VERSION } from './version.js';

/** The git top level of `cwd`, or `cwd` itself outside a repo. */
function gitTop(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

/** Task types whose work is code a reviewer reads on a branch or in a PR (AO-0136). */
const CODE_TASK_TYPES = new Set(['task', 'bug', 'feature']);

/** A review message that names `<commit> on branch <name>`. */
const NAMES_COMMIT = /\b[0-9a-f]{7,40}\b[\s\S]*?\bon branch\s+\S/i;

/** A review message that names a pull or merge request. */
const NAMES_PR = /\/pull\/\d+|\/merge_requests\/\d+|\b(?:PR|MR)\s*[:#!]?\s*[#!]?\d+/i;

/** True when `path` is `dir` or inside it. */
function within(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Changed and untracked files in the git checkout of `cwd`, outside the task stores `stores`,
 * relative to the checkout's top. Empty outside a repo or when git cannot read it.
 */
function uncommittedFiles(cwd: string, stores: string[]): string[] {
  let top: string;
  let status: string;
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    top = git(['rev-parse', '--show-toplevel']).trim();
    status = git(['status', '--porcelain', '-z']);
  } catch {
    return [];
  }
  // Git prints the long form of a path, while a temp folder can reach this process in its Windows
  // short form (C:\Users\RUNNER~1), so both sides compare as real paths.
  const real = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  const realTop = real(top);
  const realStores = stores.map(real);
  const out: string[] = [];
  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    // A rename or copy is followed by its old path, which is not a change of its own.
    if (e[0] === 'R' || e[0] === 'C') i++;
    const file = e.slice(3);
    // Any task store folder is left out by name as well, as opsd does.
    if (file.split('/').includes('.agent-ops')) continue;
    if (!realStores.some((s) => within(join(realTop, file), s))) out.push(file);
  }
  return out;
}

/**
 * Why an agent's review request for a code task cannot go out, or null when it can: the message
 * names neither `<commit> on branch <name>` nor a PR while the checkout it runs in has uncommitted
 * changes, which a reviewer could approve with nothing to merge (AO-0136, after AO-0128). A run of
 * opsd that has a start commit is let through: opsd commits what it leaves on a task branch and
 * tells the reviewer.
 */
function uncommittedReview(ctx: Ctx, ref: string, message: string): string | null {
  if (ctx.opts.force) return null;
  const ws = ctx.ws();
  if (!ws.actor || isHuman(ws.actor)) return null;
  const v = ws.view(ref);
  if (!CODE_TASK_TYPES.has(v.meta.type)) return null;
  if (NAMES_COMMIT.test(message) || NAMES_PR.test(message)) return null;
  if (opsdCommitsLeftovers(ctx.io.env)) return null;
  const files = uncommittedFiles(
    ctx.io.cwd,
    ws.roots.map((r) => r.dir),
  );
  if (files.length === 0) return null;
  const more = files.length > 1 ? ` and ${files.length - 1} more` : '';
  return (
    `${v.meta.id} is a ${v.meta.type} and ${gitTop(ctx.io.cwd)} has uncommitted changes ` +
    `(${files[0]}${more}): commit them on a task branch and name '<commit> on branch <name>' ` +
    `or a PR in the message`
  );
}

/**
 * True inside a top-level opsd run with a start commit: opsd commits what that run leaves on a
 * task branch when it ends (see `Supervisor.writesLeftovers`).
 */
function opsdCommitsLeftovers(env: NodeJS.ProcessEnv): boolean {
  const run = env.OPS_RUN;
  const dir = env.OPS_RUN_STATE_DIR;
  if (!run || !dir || !/^[A-Za-z0-9_-]+$/.test(run) || env.OPS_PARENT_RUN) return false;
  try {
    const rec = JSON.parse(readFileSync(join(dir, 'runs', `${run}.json`), 'utf8')) as {
      base?: unknown;
      parent?: unknown;
    };
    return typeof rec.base === 'string' && rec.base !== '' && !rec.parent;
  } catch {
    return false;
  }
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  readStdin?: () => string;
}

type Options = NonNullable<ParseArgsConfig['options']>;
type Values = Record<string, string | boolean | string[] | undefined>;

interface Ctx {
  io: Io;
  args: string[];
  opts: Values;
  ws: () => Workspace;
}

interface Command {
  usage: string;
  summary: string;
  options?: Options;
  run: (ctx: Ctx) => number | void | Promise<number | void>;
}

const GLOBAL_OPTIONS: Options = {
  as: { type: 'string' },
  root: { type: 'string' },
  force: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const MESSAGE_OPTIONS: Options = {
  message: { type: 'string', short: 'm' },
  'body-file': { type: 'string' },
};

function usageError(msg: string): never {
  throw new OpsError(msg, 2);
}

function str(v: Values[string]): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function list(v: Values[string]): string[] {
  if (Array.isArray(v))
    return v
      .flatMap((x) => x.split(','))
      .map((x) => x.trim())
      .filter(Boolean);
  if (typeof v === 'string')
    return v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  return [];
}

/** Text from a file, or from stdin for `-`; Windows line ends become `\n`. */
function readText(ctx: Ctx, file: string): string {
  const raw =
    file === '-' ? (ctx.io.readStdin?.() ?? '') : readFileSync(resolve(ctx.io.cwd, file), 'utf8');
  return raw.replace(/\r\n?/g, '\n');
}

/**
 * The message, newlines kept as written (AO-0143): `-m`, `--body-file F` (`-` for stdin), a lone
 * `-` argument for stdin, or the remaining arguments joined by spaces.
 */
function message(ctx: Ctx, from: number, required: boolean): string {
  const file = str(ctx.opts['body-file']);
  const rest = ctx.args.slice(from);
  let text = str(ctx.opts.message);
  if (file) text = readText(ctx, file);
  else if (text === undefined && rest.length === 1 && rest[0] === '-') text = readText(ctx, '-');
  text ??= rest.join(' ');
  if (required && !text.trim()) usageError('a message is required');
  return text;
}

/** A body from `-m` or `--body-file` only, for commands whose arguments are a title. */
function bodyText(ctx: Ctx): string {
  const file = str(ctx.opts['body-file']);
  if (file) return readText(ctx, file);
  return str(ctx.opts.message) ?? '';
}

/** `exit 0, 12m, 21703 tokens` for a run-end event. */
function runEnd(e: OpsEvent): string {
  const how = e.reason && e.reason !== 'exit' ? e.reason : `exit ${e.exit ?? '-'}`;
  const parts = [how, e.minutes !== undefined ? formatMinutes(e.minutes) : null];
  if (e.tokens) parts.push(`${e.tokens} tokens`);
  return parts.filter(Boolean).join(', ');
}

function ulidIso(id: string): string {
  return new Date(ulidTime(id)).toISOString();
}

function printDecision(ctx: Ctx, d: Decision, full: boolean): void {
  if (ctx.opts.json) {
    ctx.io.out(JSON.stringify(d, null, 2));
    return;
  }
  const o = ctx.io.out;
  const t = d.tally;
  const state = d.outcome ? `decided: ${d.outcome.choice} by ${d.outcome.decided_by}` : t.state;
  o(`${d.meta.id}  ${d.meta.question}`);
  o(`state:    ${state}    votes: ${t.votes}/${d.meta.quorum} needed`);
  if (!full) return;
  if (d.meta.voters) o(`voters:   ${d.meta.voters.join(', ')}`);
  if (t.missing.length) o(`missing:  ${t.missing.join(', ')}`);
  if (d.meta.deadline) o(`deadline: ${d.meta.deadline}`);
  if (d.meta.task) o(`task:     ${d.meta.task}`);
  if (d.body) o(`\n${d.body}`);
  o('');
  d.meta.options.forEach((opt, i) => o(`  ${i + 1}. ${pad(opt, 30)} ${t.counts[opt] ?? 0}`));
  if (d.ballots.length) o('');
  for (const b of d.ballots) o(`${pad(b.actor, 18)} ${b.choice}${b.body ? `: ${b.body}` : ''}`);
  if (d.outcome?.body) o(`\noutcome: ${d.outcome.body}`);
}

/** Names used by more than one root; those repeats print as `root/name`, the form commands take. */
function sharedRepeatNames(all: RepeatView[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const r of all) (seen.has(r.meta.name) ? shared : seen).add(r.meta.name);
  return shared;
}

function printRepeat(ctx: Ctx, r: RepeatView, full: boolean, shared?: Set<string>): void {
  const o = ctx.io.out;
  const next = r.next ? `    next: ${r.next.replace('T', ' ')}` : '';
  const label = shared?.has(r.meta.name) ? `${r.root}/${r.meta.name}` : r.meta.name;
  o(`${pad(label, 20)} ${pad(r.state, 9)} ${r.rule || '-'}${next}`);
  if (r.note) o(`  note: ${r.note}`);
  if (!full) return;
  const m = r.meta;
  o(`title:    ${m.title}`);
  o(`owner:    ${m.owner ?? '-'}    priority: ${m.priority ?? 'p2'}    type: ${m.type ?? 'task'}`);
  if (m.project) o(`project:  ${m.project}`);
  if (m.parent) o(`parent:   ${m.parent}`);
  if (m.labels) o(`labels:   ${m.labels.join(', ')}`);
  o(
    `created:  ${m.created_at.slice(0, 16).replace('T', ' ')} by ${m.created_by}    root: ${r.root}`,
  );
  const last = r.last ? `    last: ${r.last.id} (${r.last.status ?? 'archived'})` : '';
  o(`fired:    ${r.fired}${last}`);
  if (r.body) o(`\n${r.body}`);
}

function arg(ctx: Ctx, i: number, name: string): string {
  const v = ctx.args[i];
  if (!v) usageError(`missing ${name}`);
  return v;
}

/**
 * `ops setup` and `ops init --user`: write the user config, or add a missing `me` to it, and seed
 * the default providers and agents once.
 */
function setupUser(ctx: Ctx): void {
  const rootsOpt = ctx.opts.root as string[] | undefined;
  const roots = rootsOpt ?? [suggestedRoot(ctx.io.cwd)].filter((r): r is string => r !== null);
  const res = setupUserConfig({ me: str(ctx.opts.me) ?? defaultHumanId(), roots }, ctx.io.env);
  const seed = seedUserConfig(ctx.io.env, { agents: true });
  if (ctx.opts.json) {
    return void ctx.io.out(
      JSON.stringify({ ...res, seeded: { runtimes: seed.runtimes, agents: seed.agents } }, null, 2),
    );
  }
  const verb = res.created ? 'wrote' : res.changed ? 'added me to' : 'kept';
  ctx.io.out(`${verb} ${res.path}: me ${res.me}, roots ${res.roots.join(', ') || 'none'}`);
  if (seed.runtimes.length > 0) ctx.io.out(`providers: ${seed.runtimes.join(', ')}`);
  if (seed.agents.length > 0) ctx.io.out(`agents: ${seed.agents.join(', ')}`);
}

function printWaits(ctx: Ctx, waits: WaitItem[]): void {
  for (const w of waits) {
    const label = w.kind === 'review' ? 'review ' : w.kind === 'inbox' ? 'inbox  ' : '';
    ctx.io.out(`${pad(w.task ?? '-', 14)} ${label}${w.title}`);
    ctx.io.out(`  ${w.reason}`);
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function statusLabel(v: TaskView): string {
  if (v.stale) return `${v.status}(stale)`;
  if (v.unblocked) return 'todo(unblocked)';
  return v.status;
}

function printTasks(ctx: Ctx, views: TaskView[]): void {
  if (ctx.opts.json) {
    ctx.io.out(JSON.stringify(views.map(compact), null, 2));
    return;
  }
  if (views.length === 0) {
    ctx.io.out('no tasks');
    return;
  }
  // With several roots, ids can repeat across them: print root/id so each row is unique.
  const qualify = ctx.ws().roots.length > 1;
  const width = qualify
    ? Math.max(8, ...views.map((v) => v.root.length + v.meta.id.length + 1))
    : 8;
  for (const v of views) {
    const who = v.claimedBy ?? v.owner ?? '-';
    const id = qualify ? `${v.root}/${v.meta.id}` : v.meta.id;
    ctx.io.out(
      `${pad(id, width)} ${pad(statusLabel(v), 16)} ${v.meta.priority}  ${pad(who, 20)} ${v.meta.title}`,
    );
  }
}

function compact(v: TaskView): Record<string, unknown> {
  return {
    id: v.meta.id,
    root: v.root,
    title: v.meta.title,
    type: v.meta.type,
    priority: v.meta.priority,
    project: v.meta.project,
    status: v.status,
    stale: v.stale || undefined,
    unblocked: v.unblocked || undefined,
    owner: v.owner,
    claimedBy: v.claimedBy,
    leaseUntil: v.leaseUntil,
    reviewer: v.reviewer,
    waitingOn: v.waitingOn,
    blockedOn: v.blockedOn.length ? v.blockedOn : undefined,
    checkpoint: v.checkpoint,
    delegation: v.delegation ?? undefined,
    archived: v.archived || undefined,
    updatedAt: v.updatedAt,
  };
}

function printAct(ctx: Ctx, res: ActResult): void {
  const v = res.view;
  if (ctx.opts.json) {
    const warnings = res.warnings;
    ctx.io.out(
      JSON.stringify({ task: compact(v), events: res.events.map((e) => e.id), warnings }, null, 2),
    );
    return;
  }
  const who = v.claimedBy ? ` (${v.claimedBy})` : v.owner ? ` (owner ${v.owner})` : '';
  ctx.io.out(`${v.meta.id} ${v.status}${who}`);
  for (const n of res.notes ?? []) ctx.io.err(`note: ${n}`);
  printWarnings(ctx, res.warnings);
}

/** Warnings go to stderr, so `--json` output and scripts reading stdout stay clean. */
function printWarnings(ctx: Ctx, warnings: string[] | undefined): void {
  for (const w of warnings ?? []) ctx.io.err(`warning: ${w}`);
}

function printInbox(ctx: Ctx, items: InboxItem[]): void {
  if (ctx.opts.json) {
    ctx.io.out(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) {
    ctx.io.out('inbox empty');
    return;
  }
  const width = Math.max(8, ...items.map((it) => it.task.length + 1));
  for (const it of items) {
    const from = it.from ? ` from ${it.from}` : '';
    const type = it.type ? ` [${it.type}]` : '';
    ctx.io.out(
      `${pad(it.kind, 8)} ${pad(it.task, width)}${type}${from}: ${it.summary || it.title}`,
    );
  }
}

const COMMANDS: Record<string, Command> = {
  setup: {
    usage: 'setup [--me human:NAME] [--root DIR]...',
    summary: 'write your user config (me, data roots); an existing one only gains a missing me',
    options: { me: { type: 'string' }, root: { type: 'string', multiple: true } },
    run: (ctx) => setupUser(ctx),
  },
  init: {
    usage:
      'init [DIR] [--name NAME] [--prefix P] [--human human:NAME] [--with-agents] | init --user [--me human:NAME] [--root DIR]...',
    summary:
      'create a data root (.agent-ops/) in DIR or the current folder; --user writes your user config',
    options: {
      name: { type: 'string' },
      prefix: { type: 'string' },
      human: { type: 'string' },
      'with-agents': { type: 'boolean' },
      user: { type: 'boolean' },
      me: { type: 'string' },
      root: { type: 'string', multiple: true },
    },
    run: (ctx) => {
      if (ctx.opts.user) return setupUser(ctx);
      const dir = initRoot(ctx.args[0] ?? ctx.io.cwd, {
        name: str(ctx.opts.name),
        prefix: str(ctx.opts.prefix),
        human: str(ctx.opts.human),
        withAgents: Boolean(ctx.opts['with-agents']),
      });
      ctx.io.out(`created ${dir}`);
    },
  },
  roots: {
    usage: 'roots',
    summary: 'list the data roots this shell sees',
    run: (ctx) => {
      const ws = ctx.ws();
      if (ctx.opts.json) {
        ctx.io.out(
          JSON.stringify(ws.roots.map((r) => ({ name: r.name, prefix: r.prefix, dir: r.dir }))),
        );
        return;
      }
      for (const r of ws.roots) ctx.io.out(`${pad(r.name, 16)} ${pad(r.prefix, 6)} ${r.dir}`);
      if (ws.roots.length === 0) ctx.io.out('no data roots; run `ops init`');
    },
  },
  whoami: {
    usage: 'whoami',
    summary: 'print the acting id (OPS_AGENT, --as, or `me` in the user config)',
    run: (ctx) => {
      ctx.io.out(ctx.ws().requireActor());
    },
  },
  agents: {
    usage: 'agents',
    summary: 'list agent definitions from agents/*.md',
    run: (ctx) => {
      const ws = ctx.ws();
      const agents = ws.agents();
      // On stderr, so `--json` output stays parseable.
      for (const p of ws.agentProblems()) {
        ctx.io.err(`warning: skipped ${p.file}: ${p.message}`);
      }
      if (ctx.opts.json) {
        ctx.io.out(
          JSON.stringify(
            agents.map(({ body: _b, ...a }) => a),
            null,
            2,
          ),
        );
        return;
      }
      for (const a of agents) {
        ctx.io.out(`${pad(a.id, 24)} ${pad(a.status, 9)} ${(a.can_claim ?? ['*']).join(',')}`);
      }
      if (agents.length === 0) ctx.io.out('no agents defined');
    },
  },
  new: {
    usage:
      'new TITLE [--to OWNER] [--type T] [--priority P] [--project S] [--parent ID] [--label L]... [--blocked-by IDS] [-m BODY|--body-file F]',
    summary:
      'create a task; an agent files a proposal (finding) unless --parent names an approved open task',
    options: {
      to: { type: 'string' },
      type: { type: 'string' },
      priority: { type: 'string', short: 'p' },
      project: { type: 'string' },
      parent: { type: 'string' },
      label: { type: 'string', multiple: true },
      'blocked-by': { type: 'string' },
      ...MESSAGE_OPTIONS,
    },
    run: (ctx) => {
      const title = ctx.args.join(' ');
      const body = bodyText(ctx);
      const ws = ctx.ws();
      const owner = str(ctx.opts.to);
      const { meta, proposed } = ws.addTask({
        title,
        body,
        owner,
        type: str(ctx.opts.type),
        priority: str(ctx.opts.priority) as Priority | undefined,
        project: str(ctx.opts.project),
        parent: str(ctx.opts.parent),
        labels: list(ctx.opts.label),
        blockedBy: list(ctx.opts['blocked-by']),
      });
      if (ctx.opts.json) {
        ctx.io.out(JSON.stringify(proposed ? { ...meta, proposed } : meta, null, 2));
      } else {
        ctx.io.out(meta.id);
        if (proposed) {
          ctx.io.err(
            `note: ${meta.id} is a proposal (finding): ${proposed}. It waits for the human's triage; ` +
              "don't start it.",
          );
        }
      }
      // A refused owner gets here only with --force; then it is a warning.
      printWarnings(ctx, ws.reachWarnings([owner]));
    },
  },
  list: {
    usage: 'list [--status S[,S]] [--owner ID] [--mine] [--project S] [--type T] [--all]',
    summary: 'list open tasks (with --all, closed ones too)',
    options: {
      status: { type: 'string' },
      owner: { type: 'string' },
      mine: { type: 'boolean' },
      project: { type: 'string' },
      type: { type: 'string' },
      all: { type: 'boolean' },
    },
    run: (ctx) => {
      const ws = ctx.ws();
      const status = list(ctx.opts.status);
      for (const s of status) {
        if (!(STATUSES as readonly string[]).includes(s)) usageError(`unknown status '${s}'`);
      }
      printTasks(
        ctx,
        ws.list({
          status: status.length ? (status as Status[]) : undefined,
          owner: ctx.opts.mine ? ws.requireActor() : str(ctx.opts.owner),
          project: str(ctx.opts.project),
          type: str(ctx.opts.type),
          all: Boolean(ctx.opts.all),
        }),
      );
    },
  },
  show: {
    usage: 'show ID [--ids]',
    summary: 'print a task, its state and its events (--ids: with event ids, for ID#<event id>)',
    options: { ids: { type: 'boolean' } },
    run: (ctx) => {
      const ws = ctx.ws();
      const ref = arg(ctx, 0, 'task id');
      const v = ws.view(ref);
      const { body, events } = ws.showEvents(ref);
      // Images the text refers to, as local files, so an agent can open them.
      const files = ws.attachmentsIn(body, ...events.map((e) => e.body));
      if (ctx.opts.json) {
        const attachments = files.map((a) => ({ ref: a.ref, file: a.file, type: a.type }));
        ctx.io.out(
          JSON.stringify({ task: compact(v), meta: v.meta, body, events, attachments }, null, 2),
        );
        return;
      }
      const o = ctx.io.out;
      o(`${v.meta.id}  ${v.meta.title}`);
      o(`status:   ${statusLabel(v)}${v.claimedBy ? ` by ${v.claimedBy}` : ''}`);
      o(`owner:    ${v.owner ?? '-'}    priority: ${v.meta.priority}    type: ${v.meta.type}`);
      if (v.meta.project) o(`project:  ${v.meta.project}`);
      if (v.reviewer) o(`reviewer: ${v.reviewer}`);
      if (v.waitingOn) o(`waiting:  ${v.waitingOn}`);
      if (v.blockedOn.length) o(`blocked on: ${v.blockedOn.join(', ')}`);
      if (v.leaseUntil) o(`lease:    ${v.leaseUntil}`);
      if (v.delegation) {
        const d = v.delegation;
        const limits = [
          d.budget_minutes !== undefined ? `budget ${formatMinutes(d.budget_minutes)}` : null,
          d.tokens !== undefined ? `tokens ${d.tokens}` : null,
          d.due ? `due ${d.due}` : null,
          d.review ? `review ${d.review}` : null,
        ].filter(Boolean);
        o(`delegated: by ${d.by} to ${d.to}${limits.length ? ` (${limits.join(', ')})` : ''}`);
      }
      if (v.archived) o('archived: yes (reopen moves it back)');
      if (v.checkpoint) {
        o(
          `checkpoint: ${v.checkpoint.summary}${v.checkpoint.next ? ` (next: ${v.checkpoint.next})` : ''}`,
        );
      }
      if (body.trim()) o(`\n${body.trim()}`);
      if (v.lostClaims.length) {
        o(
          `lost:     ${v.lostClaims.length} event(s) under a claim that lost a race (marked below)`,
        );
      }
      if (events.length) o('');
      const lost = new Set(v.lostClaims);
      for (const e of events) {
        const to = e.to ? ` -> ${e.to}` : lost.has(e.id) ? ' (lost)' : '';
        const extra = e.on
          ? ` on ${e.on.join(',')}`
          : e.ref
            ? ` ${e.ref}`
            : e.verdict
              ? ` ${e.verdict}`
              : e.priority
                ? ` ${e.priority}`
                : e.type === 'run-end'
                  ? ` ${runEnd(e)}`
                  : e.type === 'merge' && e.commit
                    ? ` ${e.commit.slice(0, 7)} into ${e.into ?? '?'}`
                    : '';
        // A multi-line body (Markdown) keeps its lines, indented under the event line.
        const [first = '', ...more] = e.body.trim().split('\n');
        const id = ctx.opts.ids ? `${e.id}  ` : '';
        o(
          `${id}${e.at.slice(0, 16).replace('T', ' ')}  ${pad(e.actor, 18)} ${e.type}${extra}${to}${first ? `: ${first}` : ''}`,
        );
        for (const line of more) o(line.trim() ? `    ${line.trimEnd()}` : '');
      }
      if (files.length) {
        o('\nattachments:');
        for (const a of files) o(`  ${a.ref}  ${a.file}`);
      }
    },
  },
  attach: {
    usage: 'attach FILE [--task ID] [--alt TEXT]',
    summary:
      'store an image (PNG, JPEG, WebP or GIF, 5 MB at most) and print a Markdown link to it',
    options: { task: { type: 'string' }, alt: { type: 'string' } },
    run: (ctx) => {
      const file = resolve(ctx.io.cwd, arg(ctx, 0, 'image file'));
      let data: Buffer;
      try {
        data = readFileSync(file);
      } catch (err) {
        return usageError(`cannot read ${file}: ${(err as Error).message}`);
      }
      const a = ctx.ws().attach(data, { task: str(ctx.opts.task), alt: str(ctx.opts.alt) });
      if (ctx.opts.json) {
        ctx.io.out(JSON.stringify(a));
        return;
      }
      ctx.io.out(a.markdown);
    },
  },
  next: {
    usage: 'next [--all]',
    summary: 'print the best task to claim now (with --all, the whole queue)',
    options: { all: { type: 'boolean' } },
    run: (ctx) => {
      const ws = ctx.ws();
      const q = ws.queue();
      if (ctx.opts.all) return printTasks(ctx, q);
      const top = q[0];
      if (!top) {
        if (ctx.opts.json) ctx.io.out('null');
        return 3;
      }
      if (ctx.opts.json) ctx.io.out(JSON.stringify(compact(top), null, 2));
      else ctx.io.out(`${top.meta.id}\t${top.meta.priority}\t${top.meta.title}`);
    },
  },
  claim: {
    usage: 'claim ID',
    summary: 'claim a task (exit 1 when someone else holds it)',
    run: (ctx) => printAct(ctx, ctx.ws().claim(arg(ctx, 0, 'task id'))),
  },
  start: {
    usage: 'start ID [PLAN]',
    summary: 'start work (claims first when the task is free)',
    options: MESSAGE_OPTIONS,
    run: (ctx) => printAct(ctx, ctx.ws().start(arg(ctx, 0, 'task id'), message(ctx, 1, false))),
  },
  progress: {
    usage: 'progress ID MESSAGE',
    summary: 'progress note; renews the lease',
    options: MESSAGE_OPTIONS,
    run: (ctx) => printAct(ctx, ctx.ws().progress(arg(ctx, 0, 'task id'), message(ctx, 1, true))),
  },
  checkpoint: {
    usage: 'checkpoint ID SUMMARY [--next STEP]',
    summary: 'save where the work stands so the next run can resume',
    options: { next: { type: 'string' }, ...MESSAGE_OPTIONS },
    run: (ctx) =>
      printAct(
        ctx,
        ctx.ws().checkpoint(arg(ctx, 0, 'task id'), message(ctx, 1, true), str(ctx.opts.next)),
      ),
  },
  release: {
    usage: 'release ID [MESSAGE]',
    summary: 'give the task back to the queue',
    options: MESSAGE_OPTIONS,
    run: (ctx) => printAct(ctx, ctx.ws().release(arg(ctx, 0, 'task id'), message(ctx, 1, false))),
  },
  handoff: {
    usage: 'handoff ID TO MESSAGE',
    summary: 'pass the task to another owner; it goes back to todo',
    options: MESSAGE_OPTIONS,
    run: (ctx) =>
      printAct(
        ctx,
        ctx.ws().handoff(arg(ctx, 0, 'task id'), arg(ctx, 1, 'new owner'), message(ctx, 2, true)),
      ),
  },
  assign: {
    usage: 'assign ID TO [MESSAGE]',
    summary: 'set the owner (human, orchestrator or current owner)',
    options: MESSAGE_OPTIONS,
    run: (ctx) =>
      printAct(
        ctx,
        ctx.ws().assign(arg(ctx, 0, 'task id'), arg(ctx, 1, 'owner'), message(ctx, 2, false)),
      ),
  },
  review: {
    usage: 'review ID MESSAGE [--to REVIEWER]',
    summary: 'ask for review; the reviewer comes from another provider or is a human',
    options: { to: { type: 'string' }, ...MESSAGE_OPTIONS },
    run: (ctx) => {
      const ref = arg(ctx, 0, 'task id');
      const msg = message(ctx, 1, true);
      const refused = uncommittedReview(ctx, ref, msg);
      if (refused) throw new OpsError(refused, 1);
      return printAct(ctx, ctx.ws().review(ref, msg, str(ctx.opts.to)));
    },
  },
  verdict: {
    usage: 'verdict ID approve|changes MESSAGE',
    summary: 'finish a review: approve closes the task, changes sends it back',
    options: MESSAGE_OPTIONS,
    run: (ctx) => {
      const v = arg(ctx, 1, 'verdict');
      if (v !== 'approve' && v !== 'changes') usageError("verdict must be 'approve' or 'changes'");
      printAct(ctx, ctx.ws().verdict(arg(ctx, 0, 'task id'), v, message(ctx, 2, v === 'changes')));
    },
  },
  done: {
    usage: 'done ID [MESSAGE]',
    summary: 'close the task',
    options: MESSAGE_OPTIONS,
    run: (ctx) => printAct(ctx, ctx.ws().done(arg(ctx, 0, 'task id'), message(ctx, 1, false))),
  },
  ask: {
    usage: 'ask ID QUESTION [--to ID]',
    summary: 'block on a question to the human (or --to someone else)',
    options: { to: { type: 'string' }, ...MESSAGE_OPTIONS },
    run: (ctx) =>
      printAct(ctx, ctx.ws().ask(arg(ctx, 0, 'task id'), message(ctx, 1, true), str(ctx.opts.to))),
  },
  block: {
    usage: 'block ID MESSAGE [--on IDS] [--to ID]',
    summary: 'block on other tasks (--on) or on a person',
    options: { on: { type: 'string' }, to: { type: 'string' }, ...MESSAGE_OPTIONS },
    run: (ctx) =>
      printAct(
        ctx,
        ctx.ws().block(arg(ctx, 0, 'task id'), message(ctx, 1, true), {
          on: list(ctx.opts.on),
          to: str(ctx.opts.to),
        }),
      ),
  },
  answer: {
    usage: 'answer ID MESSAGE',
    summary: 'answer an ask; the task goes back to todo',
    options: MESSAGE_OPTIONS,
    run: (ctx) => printAct(ctx, ctx.ws().answer(arg(ctx, 0, 'task id'), message(ctx, 1, true))),
  },
  unblock: {
    usage: 'unblock ID [MESSAGE]',
    summary: 'clear a block; the task goes back to todo',
    options: MESSAGE_OPTIONS,
    run: (ctx) => printAct(ctx, ctx.ws().unblock(arg(ctx, 0, 'task id'), message(ctx, 1, false))),
  },
  comment: {
    usage: 'comment ID MESSAGE [--to ID]',
    summary: 'add a comment; --to puts it in that inbox',
    options: { to: { type: 'string' }, ...MESSAGE_OPTIONS },
    run: (ctx) =>
      printAct(
        ctx,
        ctx.ws().comment(arg(ctx, 0, 'task id'), message(ctx, 1, true), str(ctx.opts.to)),
      ),
  },
  priority: {
    usage: 'priority ID p0|p1|p2|p3 [MESSAGE]',
    summary: 'change the priority',
    options: MESSAGE_OPTIONS,
    run: (ctx) =>
      printAct(
        ctx,
        ctx
          .ws()
          .setPriority(
            arg(ctx, 0, 'task id'),
            arg(ctx, 1, 'priority') as Priority,
            message(ctx, 2, false),
          ),
      ),
  },
  retype: {
    usage: 'retype ID TYPE [MESSAGE] [--to OWNER] [--priority P] [--answer TEXT]',
    summary:
      'change the task type, such as finding to bug or idea (human or orchestrator); --to and --priority set the owner and priority in the same write; --answer also answers its open question',
    options: {
      to: { type: 'string' },
      priority: { type: 'string' },
      answer: { type: 'string' },
      ...MESSAGE_OPTIONS,
    },
    run: (ctx) =>
      printAct(
        ctx,
        ctx.ws().retype(arg(ctx, 0, 'task id'), arg(ctx, 1, 'type'), message(ctx, 2, false), {
          to: str(ctx.opts.to),
          answer: str(ctx.opts.answer),
          priority: str(ctx.opts.priority) as Priority | undefined,
        }),
      ),
  },
  park: {
    usage: 'park ID MESSAGE',
    summary: 'close as not planned (human or orchestrator)',
    options: MESSAGE_OPTIONS,
    run: (ctx) => printAct(ctx, ctx.ws().park(arg(ctx, 0, 'task id'), message(ctx, 1, true))),
  },
  reopen: {
    usage: 'reopen ID [MESSAGE]',
    summary: 'reopen a closed task',
    options: MESSAGE_OPTIONS,
    run: (ctx) => printAct(ctx, ctx.ws().reopen(arg(ctx, 0, 'task id'), message(ctx, 1, false))),
  },
  delegate: {
    usage: 'delegate ID TO [--budget 2h] [--tokens 400k] [--due WHEN] [--review ID] [-m MESSAGE]',
    summary: 'hand a task to another owner with limits and an expected reviewer',
    options: {
      budget: { type: 'string' },
      tokens: { type: 'string' },
      due: { type: 'string' },
      review: { type: 'string' },
      ...MESSAGE_OPTIONS,
    },
    run: (ctx) =>
      printAct(
        ctx,
        ctx.ws().delegate(arg(ctx, 0, 'task id'), arg(ctx, 1, 'delegate'), {
          budget: str(ctx.opts.budget),
          tokens: str(ctx.opts.tokens),
          due: str(ctx.opts.due),
          review: str(ctx.opts.review),
          message: message(ctx, 2, false),
        }),
      ),
  },
  archive: {
    usage: 'archive [--days N] [--dry-run]',
    summary: 'move done and parked tasks older than N days (default 30) to archive/',
    options: { days: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    run: (ctx) => {
      const days = str(ctx.opts.days);
      if (days !== undefined && !/^\d+$/.test(days)) usageError(`bad --days '${days}'`);
      const dryRun = Boolean(ctx.opts['dry-run']);
      const moved = ctx.ws().archive({ days: days ? Number(days) : undefined, dryRun });
      if (ctx.opts.json) {
        ctx.io.out(JSON.stringify({ archived: moved, dryRun }, null, 2));
        return;
      }
      if (moved.length === 0) ctx.io.out('nothing to archive');
      else ctx.io.out(`${dryRun ? 'would archive' : 'archived'} ${moved.join(', ')}`);
    },
  },
  finding: {
    usage: 'finding TITLE [--task ID] [--to OWNER] [--priority P] [--project S] [-m BODY]',
    summary: 'file a bug, risk or idea outside your task as a finding (linked from --task)',
    options: {
      task: { type: 'string' },
      to: { type: 'string' },
      priority: { type: 'string', short: 'p' },
      project: { type: 'string' },
      ...MESSAGE_OPTIONS,
    },
    run: (ctx) => {
      const res = ctx.ws().finding({
        title: ctx.args.join(' '),
        body: bodyText(ctx),
        task: str(ctx.opts.task),
        owner: str(ctx.opts.to),
        priority: str(ctx.opts.priority) as Priority | undefined,
        project: str(ctx.opts.project),
      });
      ctx.io.out(ctx.opts.json ? JSON.stringify(res.meta, null, 2) : res.meta.id);
    },
  },
  learn: {
    usage: 'learn TOPIC TITLE [--task ID] [--tag T]... (-m BODY | --body-file F)',
    summary: 'write a learn note to kb/<topic>/ (and a learn event on --task)',
    options: {
      task: { type: 'string' },
      tag: { type: 'string', multiple: true },
      ...MESSAGE_OPTIONS,
    },
    run: (ctx) => {
      const res = ctx.ws().learn({
        topic: arg(ctx, 0, 'topic'),
        title: ctx.args.slice(1).join(' '),
        body: bodyText(ctx),
        task: str(ctx.opts.task),
        tags: list(ctx.opts.tag),
      });
      ctx.io.out(
        ctx.opts.json ? JSON.stringify({ ref: res.note.ref, file: res.note.file }) : res.note.ref,
      );
    },
  },
  kb: {
    usage: 'kb [WORDS...] [--topic T] [--read TOPIC/SLUG]',
    summary: 'search learn notes (every word must match), or print one with --read',
    options: { topic: { type: 'string' }, read: { type: 'string' } },
    run: (ctx) => {
      const ws = ctx.ws();
      const ref = str(ctx.opts.read);
      if (ref) {
        const n = ws.kbNote(ref);
        if (ctx.opts.json) {
          ctx.io.out(JSON.stringify(n, null, 2));
          return;
        }
        ctx.io.out(`${n.ref}  ${n.title}`);
        const meta = [n.author, n.created_at.slice(0, 10), n.task, (n.tags ?? []).join(',')];
        ctx.io.out(meta.filter(Boolean).join('  '));
        ctx.io.out(`\n${n.body}`);
        return;
      }
      const hits = ws.kb(ctx.args, str(ctx.opts.topic));
      if (ctx.opts.json) {
        const rows = hits.map((h) => ({ ref: h.note.ref, title: h.note.title, score: h.score }));
        ctx.io.out(JSON.stringify(rows, null, 2));
        return;
      }
      if (hits.length === 0) {
        ctx.io.out('no notes');
        return 3;
      }
      for (const h of hits) ctx.io.out(`${pad(h.note.ref, 40)} ${h.note.title}`);
    },
  },
  channel: {
    usage: 'channel list | post NAME MESSAGE [--to ID]... [--task ID] | read NAME [--limit N]',
    summary: 'post to and read channels; @id in a message puts it in that inbox',
    options: {
      to: { type: 'string', multiple: true },
      task: { type: 'string' },
      limit: { type: 'string' },
      after: { type: 'string' },
      ...MESSAGE_OPTIONS,
    },
    run: (ctx) => {
      const ws = ctx.ws();
      const action = arg(ctx, 0, "'list', 'post' or 'read'");
      if (action === 'list') {
        const chans = ws.channels();
        if (ctx.opts.json) return void ctx.io.out(JSON.stringify(chans, null, 2));
        if (chans.length === 0) ctx.io.out('no channels');
        for (const c of chans) {
          const last = c.last ? ulidIso(c.last).slice(0, 16).replace('T', ' ') : '-';
          ctx.io.out(`#${pad(c.name, 20)} ${pad(String(c.messages), 6)} ${last}`);
        }
        return;
      }
      const name = arg(ctx, 1, 'channel name');
      if (action === 'post') {
        const m = ws.post(name, message(ctx, 2, true), {
          to: list(ctx.opts.to),
          task: str(ctx.opts.task),
        });
        ctx.io.out(ctx.opts.json ? JSON.stringify(m, null, 2) : `#${m.channel} ${m.id}`);
        printWarnings(ctx, ws.reachWarnings(m.mentions ?? []));
        return;
      }
      if (action !== 'read') usageError("use 'channel list', 'channel post' or 'channel read'");
      const limit = str(ctx.opts.limit);
      if (limit !== undefined && !/^\d+$/.test(limit)) usageError(`bad --limit '${limit}'`);
      const msgs = ws.channel(name, {
        after: str(ctx.opts.after),
        limit: limit ? Number(limit) : 50,
      });
      if (ctx.opts.json) return void ctx.io.out(JSON.stringify(msgs, null, 2));
      if (msgs.length === 0) ctx.io.out(`#${name}: no messages`);
      for (const m of msgs) {
        const task = m.task ? ` [${m.task}]` : '';
        const text = m.body.replace(/\n+/g, ' ');
        ctx.io.out(`${m.at.slice(0, 16).replace('T', ' ')}  ${pad(m.actor, 18)}${task} ${text}`);
      }
    },
  },
  repeat: {
    usage:
      'repeat list | show NAME | add NAME --title T (--start "2026-11-05 09:00" [--every once|daily|weekly|weekdays|monthly|yearly] [--days mon,thu] | --when "closed ID" | --when "children-closed ID") [--until DATE] [--count N] [--owner ID] [--project P] [--priority P] [--type T] [--label L]... [--parent ID] [-m BODY] | edit NAME [same options] | pause NAME | resume NAME | delete NAME | run NAME | tick',
    summary:
      'repeating tasks: a template that creates a task on a date, on a schedule or when a task closes',
    options: {
      title: { type: 'string' },
      start: { type: 'string' },
      every: { type: 'string' },
      days: { type: 'string' },
      when: { type: 'string' },
      until: { type: 'string' },
      count: { type: 'string' },
      owner: { type: 'string' },
      project: { type: 'string' },
      priority: { type: 'string' },
      type: { type: 'string' },
      label: { type: 'string', multiple: true },
      parent: { type: 'string' },
      paused: { type: 'boolean' },
      ...MESSAGE_OPTIONS,
    },
    run: (ctx) => {
      const ws = ctx.ws();
      const action = arg(
        ctx,
        0,
        "'list', 'show', 'add', 'edit', 'pause', 'resume', 'delete', 'run' or 'tick'",
      );
      const json = (v: unknown): void => ctx.io.out(JSON.stringify(v, null, 2));
      if (action === 'list') {
        const all = ws.repeats();
        if (ctx.opts.json) return json(all);
        if (all.length === 0) ctx.io.out('no repeats');
        const shared = sharedRepeatNames(all);
        for (const r of all) printRepeat(ctx, r, false, shared);
        return;
      }
      if (action === 'tick') {
        const fired = ws.fireRepeats();
        if (ctx.opts.json) return json(fired);
        if (fired.length === 0) ctx.io.out('nothing due');
        for (const f of fired) ctx.io.out(`${f.repeat}: created ${f.task} for ${f.slot}`);
        return;
      }
      const name = arg(ctx, 1, 'repeat name');
      // A root-qualified name prints back as root/name.
      const asGiven = name.includes('/') ? new Set([name.slice(name.indexOf('/') + 1)]) : undefined;
      if (action === 'show') {
        const r = ws.repeatView(name);
        return ctx.opts.json ? json(r) : printRepeat(ctx, r, true);
      }
      if (action === 'add' || action === 'edit') {
        const count = str(ctx.opts.count);
        if (count !== undefined && !/^\d+$/.test(count)) usageError(`bad --count '${count}'`);
        const given: Partial<RepeatInput> = {
          title: str(ctx.opts.title),
          start: str(ctx.opts.start),
          repeat: str(ctx.opts.every),
          days: str(ctx.opts.days),
          when: str(ctx.opts.when),
          until: str(ctx.opts.until),
          count: count === undefined ? undefined : Number(count),
          owner: str(ctx.opts.owner),
          project: str(ctx.opts.project),
          priority: str(ctx.opts.priority) as Priority | undefined,
          type: str(ctx.opts.type),
          labels: ctx.opts.label === undefined ? undefined : list(ctx.opts.label),
          parent: str(ctx.opts.parent),
          paused: ctx.opts.paused === undefined ? undefined : Boolean(ctx.opts.paused),
        };
        const body =
          ctx.opts.message !== undefined || ctx.opts['body-file'] ? bodyText(ctx) : undefined;
        if (body !== undefined) given.body = body;
        const defined = Object.fromEntries(
          Object.entries(given).filter(([, v]) => v !== undefined),
        ) as Partial<RepeatInput>;
        let input: RepeatInput;
        if (action === 'add') {
          if (!defined.title) usageError('a repeat needs --title');
          input = { ...defined, name, title: defined.title };
        } else {
          const cur = ws.repeatView(name);
          const m = cur.meta;
          // A condition and a time rule exclude each other: setting one drops the other.
          const rule = defined.when
            ? { start: defined.start, repeat: undefined, days: undefined }
            : defined.repeat || defined.start || defined.days
              ? { when: undefined }
              : {};
          input = {
            name: m.name,
            root: cur.root,
            title: m.title,
            body: cur.body,
            type: m.type,
            priority: m.priority,
            owner: m.owner,
            project: m.project,
            parent: m.parent,
            labels: m.labels,
            start: m.start,
            repeat: m.repeat,
            days: m.days,
            until: m.until,
            count: m.count,
            when: m.when,
            paused: m.paused,
            ...rule,
            ...defined,
          };
        }
        const r = ws.saveRepeat(input, { replace: action === 'edit' });
        return ctx.opts.json ? json(r) : printRepeat(ctx, r, false, asGiven);
      }
      if (action === 'pause' || action === 'resume') {
        const r = ws.setRepeatPaused(name, action === 'pause');
        return ctx.opts.json ? json(r) : printRepeat(ctx, r, false, asGiven);
      }
      if (action === 'delete') {
        ws.deleteRepeat(name);
        ctx.io.out(`deleted repeat ${name}; the tasks it created stay`);
        return;
      }
      if (action === 'run') {
        const meta = ws.runRepeat(name);
        ctx.io.out(ctx.opts.json ? JSON.stringify(meta, null, 2) : `created ${meta.id}`);
        return;
      }
      usageError(
        `unknown action '${action}': use list, show, add, edit, pause, resume, delete, run or tick`,
      );
    },
  },
  propose: {
    usage:
      'propose QUESTION --option A --option B... [--voters IDS] [--quorum N] [--deadline WHEN] [--task ID] [-m CONTEXT]',
    summary: 'start a vote; ties and missing quorum go to the human',
    options: {
      option: { type: 'string', multiple: true },
      options: { type: 'string' },
      voters: { type: 'string' },
      quorum: { type: 'string' },
      deadline: { type: 'string' },
      task: { type: 'string' },
      ...MESSAGE_OPTIONS,
    },
    run: (ctx) => {
      const quorum = str(ctx.opts.quorum);
      if (quorum !== undefined && !/^\d+$/.test(quorum)) usageError(`bad --quorum '${quorum}'`);
      const repeated = Array.isArray(ctx.opts.option) ? ctx.opts.option : [];
      const d = ctx.ws().propose({
        question: ctx.args.join(' '),
        options: [...repeated, ...list(ctx.opts.options)],
        voters: list(ctx.opts.voters),
        quorum: quorum ? Number(quorum) : undefined,
        deadline: str(ctx.opts.deadline),
        task: str(ctx.opts.task),
        body: bodyText(ctx),
      });
      ctx.io.out(ctx.opts.json ? JSON.stringify(d, null, 2) : d.id);
    },
  },
  vote: {
    usage: 'vote D-ID CHOICE [REASON]',
    summary: 'cast your ballot; it is final (CHOICE is the option text or its number)',
    options: MESSAGE_OPTIONS,
    run: (ctx) => {
      const d = ctx
        .ws()
        .vote(arg(ctx, 0, 'decision id'), arg(ctx, 1, 'choice'), message(ctx, 2, false));
      printDecision(ctx, d, false);
    },
  },
  tally: {
    usage: 'tally D-ID',
    summary: 'print a vote: question, options, ballots, state',
    run: (ctx) => printDecision(ctx, ctx.ws().decision(arg(ctx, 0, 'decision id')), true),
  },
  decisions: {
    usage: 'decisions [--all]',
    summary: 'list open votes (with --all, decided ones too)',
    options: { all: { type: 'boolean' } },
    run: (ctx) => {
      const ds = ctx.ws().decisions({ all: Boolean(ctx.opts.all) });
      if (ctx.opts.json) return void ctx.io.out(JSON.stringify(ds, null, 2));
      if (ds.length === 0) ctx.io.out('no open votes');
      for (const d of ds) {
        const state = d.outcome ? `decided: ${d.outcome.choice}` : d.tally.state;
        ctx.io.out(`${pad(d.meta.id, 8)} ${pad(state, 20)} ${d.meta.question}`);
      }
    },
  },
  decide: {
    usage: 'decide D-ID CHOICE [REASON]',
    summary: 'record the outcome (the human any time; others only for the vote winner)',
    options: MESSAGE_OPTIONS,
    run: (ctx) => {
      const d = ctx
        .ws()
        .decide(arg(ctx, 0, 'decision id'), arg(ctx, 1, 'choice'), message(ctx, 2, false));
      printDecision(ctx, d, false);
    },
  },
  daemon: {
    usage: 'daemon start|stop|restart|pause|resume|status|run [--port N] [--kill-runs]',
    summary:
      'start, stop, restart, pause or check opsd, the supervisor that runs agents; pause starts no new runs',
    options: { port: { type: 'string' }, 'kill-runs': { type: 'boolean' } },
    run: async (ctx) => {
      const action = arg(
        ctx,
        0,
        "'start', 'stop', 'restart', 'pause', 'resume', 'status' or 'run'",
      );
      const portText = str(ctx.opts.port);
      if (portText !== undefined && !/^\d+$/.test(portText)) usageError(`bad --port '${portText}'`);
      const port = portText ? Number(portText) : undefined;
      const env = ctx.io.env;
      if (action === 'run') {
        await runDaemon({ env, cwd: ctx.io.cwd, port, log: ctx.io.out });
        return;
      }
      if (action === 'start') {
        const info = await startDaemon({ env, cwd: ctx.io.cwd, port });
        ctx.io.out(`opsd pid ${info.pid} on 127.0.0.1:${info.port}`);
        return;
      }
      if (action === 'stop') {
        const stopped = await stopDaemon({ env, killRuns: Boolean(ctx.opts['kill-runs']) });
        ctx.io.out(stopped ? 'opsd stopped' : 'opsd is not running');
        return;
      }
      if (action === 'restart') {
        // Live runs keep going: a restart without --kill-runs leaves them to the new opsd.
        await stopDaemon({ env, killRuns: Boolean(ctx.opts['kill-runs']) });
        const info = await startDaemon({ env, cwd: ctx.io.cwd, port });
        ctx.io.out(`opsd pid ${info.pid} on 127.0.0.1:${info.port}`);
        return;
      }
      if (action === 'pause' || action === 'resume') {
        const paused = action === 'pause';
        setPaused(env, paused);
        const info = readDaemon(env);
        // A running opsd reads the file again at once; a stopped one starts in this state.
        if (info) await daemonCall(info, 'POST', '/api/settings', { patch: {} });
        // Resume also starts runs of a signed-out provider again (AO-0154); an older opsd has no
        // such route, and a stopped one checks each sign-in when it starts.
        if (info && !paused) {
          await daemonCall(info, 'POST', '/api/signin/resume', {}).catch(() => undefined);
        }
        ctx.io.out(
          paused ? 'opsd paused: no new runs or schedules start; live runs finish' : 'opsd resumed',
        );
        return;
      }
      if (action !== 'status') {
        usageError("use 'daemon start', 'stop', 'restart', 'pause', 'resume', 'status' or 'run'");
      }
      const info = readDaemon(env);
      let paused = false;
      try {
        paused = opsdConfig(readUserConfig(env)).paused;
      } catch {
        // A config opsd refuses: status still answers; `ops doctor` names the problem.
      }
      if (ctx.opts.json) {
        ctx.io.out(JSON.stringify(info ? { ...info, token: undefined, paused } : null));
      } else {
        ctx.io.out(
          info
            ? `opsd ${info.version} pid ${info.pid} on 127.0.0.1:${info.port} since ${info.started_at}${paused ? ' (paused)' : ''}`
            : `opsd is not running${paused ? ' (paused: it starts paused)' : ''}`,
        );
      }
      return info ? 0 : 3;
    },
  },
  usage: {
    usage: 'usage',
    summary: "each provider's usage allowance as opsd last read it, and whether it pauses new runs",
    run: (ctx) => {
      const store = new RunStore(stateDir(ctx.io.env));
      const usage = store.readJson<UsageState>('usage.json', {});
      const signIn = store.readJson<Record<string, SignInState>>(SIGN_IN_FILE, {});
      const cfg = opsdConfig(ctx.ws().user);
      const live = store.list().filter((r) => r.status === 'running');
      const now = Date.now();
      const report = Object.fromEntries(
        [...new Set([...Object.keys(cfg.runtimes), ...Object.keys(usage)])].map((p) => {
          const pauseAt = cfg.runtimes[p]?.pause_at ?? cfg.usage_pause_at;
          const out = signIn[p]?.out;
          return [
            p,
            {
              ...(usage[p] ?? { windows: {} }),
              live: live.filter((r) => r.agent.startsWith(`${p}:`)).length,
              // Signed out first: no run of it starts, whatever its allowance (AO-0154).
              paused: out ? signedOutText(p, out, now) : usagePause(p, usage[p], pauseAt, now),
              ...(out ? { signed_out: signedOutView(p, out) } : {}),
            },
          ];
        }),
      );
      if (ctx.opts.json) return void ctx.io.out(JSON.stringify(report, null, 2));
      for (const [p, u] of Object.entries(report)) {
        const windows = Object.entries(u.windows)
          .map(([name, w]) => `${name} ${Math.round(w.utilization * 100)}%`)
          .join(', ');
        const label = 'signed_out' in u ? 'SIGNED OUT' : 'PAUSED';
        ctx.io.out(
          `${pad(p, 8)} ${u.live} live  ${windows || 'no reading yet'}${u.paused ? `  ${label}: ${u.paused}` : ''}`,
        );
      }
    },
  },
  waits: {
    usage: 'waits',
    summary: 'what waking agents could start, and why each waits (needs opsd)',
    run: async (ctx) => {
      const info = readDaemon(ctx.io.env) ?? usageError('opsd is not running: `ops daemon start`');
      const res = await daemonCall<{ waits: WaitItem[] }>(info, 'GET', '/api/waits');
      if (ctx.opts.json) return void ctx.io.out(JSON.stringify(res, null, 2));
      if (res.waits.length === 0) return void ctx.io.out('nothing waits');
      printWaits(ctx, res.waits);
    },
  },
  runs: {
    usage: 'runs [--all]',
    summary: 'list supervised agent runs: live ones, or the last 30 with --all; then what waits',
    options: { all: { type: 'boolean' } },
    run: async (ctx) => {
      const store = new RunStore(stateDir(ctx.io.env));
      const all = store.list();
      const runs = ctx.opts.all ? all.slice(0, 30) : all.filter((r) => r.status === 'running');
      if (ctx.opts.json) return void ctx.io.out(JSON.stringify(runs, null, 2));
      if (runs.length === 0) ctx.io.out(ctx.opts.all ? 'no runs' : 'no live runs');
      for (const r of runs) {
        const end = r.ended_at ? Date.parse(r.ended_at) : Date.now();
        const mins = formatMinutes(Math.round((end - Date.parse(r.started_at)) / 60_000));
        const how = r.status === 'running' ? 'running' : `${r.reason ?? 'ended'} ${r.exit ?? '-'}`;
        ctx.io.out(
          `${r.id.slice(-8)}  ${pad(r.agent, 20)} ${pad(r.task ?? '-', 9)} ${pad(how, 12)} ${pad(mins, 7)} ${r.tokens} tokens${r.procs_left ? `, ${r.procs_left} process(es) left: ops procs ${r.id.slice(-8)} --kill` : ''}`,
        );
      }
      // Why work waits, when opsd runs; the run list stands on its own without it.
      const info = readDaemon(ctx.io.env);
      if (!info || ctx.opts.json) return;
      try {
        const res = await daemonCall<{ waits: WaitItem[] }>(info, 'GET', '/api/waits');
        const waiting = res.waits.filter((w) => w.reason !== 'starts at the next tick');
        if (waiting.length === 0) return;
        ctx.io.out('');
        ctx.io.out('waiting:');
        printWaits(ctx, waiting.slice(0, 10));
      } catch {
        // opsd went away between the lookup and the call.
      }
    },
  },
  logs: {
    usage: 'logs RUN [--bytes N]',
    summary: "print the end of a run's log (RUN: an id, or its last characters)",
    options: { bytes: { type: 'string' } },
    run: (ctx) => {
      const ref = arg(ctx, 0, 'run id').toUpperCase();
      const runs = new RunStore(stateDir(ctx.io.env)).list();
      const hits = runs.filter((r) => r.id === ref || r.id.endsWith(ref) || r.id.startsWith(ref));
      if (hits.length !== 1)
        usageError(hits.length ? `run '${ref}' is ambiguous` : `no run ${ref}`);
      const bytes = Number(str(ctx.opts.bytes) ?? 16384);
      ctx.io.out(readTail(hits[0]!.log, bytes).replace(/\n$/, ''));
    },
  },
  procs: {
    usage: 'procs RUN [--kill [--pid N]]',
    summary:
      'list the processes a run started; --kill stops what an ended run left, --pid one of them',
    options: { kill: { type: 'boolean' }, pid: { type: 'string' } },
    run: async (ctx) => {
      const ref = arg(ctx, 0, 'run id').toUpperCase();
      const runs = new RunStore(stateDir(ctx.io.env)).list();
      const hits = runs.filter((r) => r.id === ref || r.id.endsWith(ref) || r.id.startsWith(ref));
      if (hits.length !== 1)
        usageError(hits.length ? `run '${ref}' is ambiguous` : `no run ${ref}`);
      const id = hits[0]!.id;
      const info = readDaemon(ctx.io.env) ?? usageError('opsd is not running: `ops daemon start`');
      const procs = await daemonCall<ProcView[]>(
        info,
        ctx.opts.kill ? 'POST' : 'GET',
        `/api/runs/${encodeURIComponent(id)}/procs`,
        ctx.opts.kill ? (str(ctx.opts.pid) ? { pid: Number(str(ctx.opts.pid)) } : {}) : undefined,
      );
      if (ctx.opts.json) return void ctx.io.out(JSON.stringify(procs, null, 2));
      if (procs.length === 0) return void ctx.io.out('no processes recorded');
      for (const p of procs) {
        const state = (p.alive ? 'alive' : p.killed_at ? 'killed' : 'gone') + (p.unsure ? '?' : '');
        ctx.io.out(
          `${pad(String(p.pid), 7)} ${pad(state, 7)} ${pad(p.name, 18)} ${p.cmd.slice(0, 100)}`,
        );
      }
      if (procs.some((p) => p.unsure)) {
        ctx.io.out(
          '?: unsure, its parent had exited and its PID may have been reused; check it, then --kill --pid N',
        );
      }
      const alive = procs.filter((p) => p.alive && !p.unsure).length;
      return alive > 0 && hits[0]!.status === 'ended' ? 1 : 0;
    },
  },
  launch: {
    usage: 'launch AGENT [--task ID] [--budget 2h] [--tokens 400k] [--prompt-file F] [--cwd DIR]',
    summary: 'start an agent run through opsd (claims --task for the agent first)',
    options: {
      task: { type: 'string' },
      budget: { type: 'string' },
      tokens: { type: 'string' },
      'prompt-file': { type: 'string' },
      cwd: { type: 'string' },
    },
    run: async (ctx) => {
      const info = readDaemon(ctx.io.env) ?? usageError('opsd is not running: `ops daemon start`');
      const file = str(ctx.opts['prompt-file']);
      const r = await daemonCall<RunRecord>(info, 'POST', '/api/runs', {
        agent: arg(ctx, 0, 'agent'),
        task: str(ctx.opts.task),
        budget: str(ctx.opts.budget),
        tokens: str(ctx.opts.tokens),
        cwd: str(ctx.opts.cwd),
        prompt: file ? readFileSync(file, 'utf8') : undefined,
      });
      ctx.io.out(ctx.opts.json ? JSON.stringify(r, null, 2) : `${r.id} ${r.agent} pid ${r.pid}`);
    },
  },
  spawn: {
    usage: 'spawn [AGENT] (-m PROMPT | --prompt-file F) [--budget 30m] [--tokens 200k]',
    summary:
      'from inside a supervised run: start a helper run under your claim (default: your own agent)',
    options: {
      message: { type: 'string', short: 'm' },
      'prompt-file': { type: 'string' },
      budget: { type: 'string' },
      tokens: { type: 'string' },
    },
    run: async (ctx) => {
      const parent =
        ctx.io.env.OPS_RUN ?? usageError('ops spawn works only inside a supervised run (OPS_RUN)');
      const info = readDaemon(ctx.io.env) ?? usageError('opsd is not running');
      const file = str(ctx.opts['prompt-file']);
      const prompt = file ? readFileSync(file, 'utf8') : str(ctx.opts.message);
      if (!prompt) usageError('give the helper its instructions with -m or --prompt-file');
      const agent = ctx.args[0] ?? ctx.io.env.OPS_AGENT ?? usageError('name the agent');
      const r = await daemonCall<RunRecord>(info, 'POST', '/api/runs', {
        agent,
        parent,
        prompt,
        budget: str(ctx.opts.budget),
        tokens: str(ctx.opts.tokens),
      });
      ctx.io.out(
        ctx.opts.json
          ? JSON.stringify(r, null, 2)
          : `${r.id} ${r.agent} pid ${r.pid} (helper of ${parent})`,
      );
    },
  },
  kill: {
    usage: 'kill RUN',
    summary: 'stop a run and its process tree through opsd; its task goes back to the queue',
    run: async (ctx) => {
      const info = readDaemon(ctx.io.env) ?? usageError('opsd is not running');
      const ref = encodeURIComponent(arg(ctx, 0, 'run id'));
      const r = await daemonCall<RunRecord>(info, 'POST', `/api/runs/${ref}/kill`, {});
      ctx.io.out(`${r.id} ${r.status} (${r.reason ?? 'killed'})`);
    },
  },
  inbox: {
    usage: 'inbox [--mark-read]',
    summary: 'messages, asks and reviews waiting for you',
    options: { 'mark-read': { type: 'boolean' } },
    run: (ctx) => {
      const ws = ctx.ws();
      printInbox(ctx, ws.inbox(ws.requireActor(), { markRead: Boolean(ctx.opts['mark-read']) }));
    },
  },
  sync: {
    usage: 'sync [--pull] [--push] [--auto] [--session-end] [--all-paths]',
    summary: 'commit root changes, then pull and push (default: both)',
    options: {
      pull: { type: 'boolean' },
      push: { type: 'boolean' },
      auto: { type: 'boolean' },
      'session-end': { type: 'boolean' },
      'all-paths': { type: 'boolean' },
    },
    run: (ctx) => {
      const ws = ctx.ws();
      const roots = ctx.opts.root ? [ws.defaultRoot()] : ws.roots;
      if (roots.length === 0) {
        // Hooks and schedules run this everywhere; a folder without a root is not an error then.
        if (ctx.opts.auto || ctx.opts['session-end']) {
          ctx.io.out('no data root here; nothing to sync');
          return 0;
        }
        usageError('no data root found');
      }
      const targets = ctx.opts.root ? mirrorPartners(roots[0]!, ws.roots, ws.user) : roots;
      const results = syncAll(targets, ws.user, {
        pull: ctx.opts.pull ? true : undefined,
        push: ctx.opts.push ? true : undefined,
        auto: Boolean(ctx.opts.auto),
        sessionEnd: Boolean(ctx.opts['session-end']),
        allPaths: Boolean(ctx.opts['all-paths']),
      });
      for (const { root: r, result: res, mirror } of results) {
        if (ctx.opts.json) {
          ctx.io.out(JSON.stringify({ root: r.name, ...res, ...(mirror ? { mirror } : {}) }));
          continue;
        }
        const parts = [
          res.committed ? `committed ${res.committed}` : 'nothing to commit',
          res.pulled ? 'pulled' : null,
          res.pushed ? 'pushed' : null,
        ].filter(Boolean);
        ctx.io.out(`${r.name}: ${parts.join(', ')}`);
        if (res.reordered) {
          ctx.io.out(`${r.name}: put ${res.reordered} local event(s) after remote ones`);
        }
        for (const l of res.lost) {
          ctx.io.out(
            `${l.root}: ${l.actor} lost the claim on ${l.task} to ${l.winner ?? 'an earlier push'}`,
          );
        }
        if (mirror && mirror.toMaster + mirror.toProject > 0) {
          ctx.io.out(
            `${r.name}: mirrored with the Master Repo (${mirror.toMaster} file(s) there, ${mirror.toProject} back)`,
          );
        }
        for (const n of res.notes) ctx.io.out(`${r.name}: ${n}`);
      }
    },
  },
  hooks: {
    usage: 'hooks install|show [--dir DIR]',
    summary: 'add Claude Code hooks that run `ops sync --session-end` (repo settings only)',
    options: { dir: { type: 'string' } },
    run: (ctx) => {
      const action = arg(ctx, 0, "'install' or 'show'");
      if (action === 'show') {
        ctx.io.out(JSON.stringify(mergeClaudeHooks({}).settings, null, 2));
        return;
      }
      if (action !== 'install') usageError("use 'ops hooks install' or 'ops hooks show'");
      const dir = str(ctx.opts.dir) ?? gitTop(ctx.io.cwd);
      const res = installClaudeHooks(dir);
      ctx.io.out(
        res.added.length
          ? `wrote ${res.added.join(' and ')} hooks to ${res.file}`
          : `hooks already in ${res.file}`,
      );
    },
  },
  report: {
    usage: 'report [--days N | --from DATE [--to DATE]] [--post CHANNEL] [--json]',
    summary:
      'tasks opened and closed per project, runs and tokens per agent and provider, decisions; --post sends it to a channel',
    options: {
      days: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      post: { type: 'string' },
    },
    run: (ctx) => {
      const w = reportWindow({
        days: str(ctx.opts.days),
        from: str(ctx.opts.from),
        to: str(ctx.opts.to),
      });
      const ws = ctx.ws();
      const runs = new RunStore(stateDir(ctx.io.env)).list();
      const report = buildReport(ws, runs, w.from, w.to);
      const text = reportText(report);
      const channel = str(ctx.opts.post);
      if (channel) {
        const m = ws.post(channel, text);
        ctx.io.out(`posted to #${m.channel}`);
        return;
      }
      ctx.io.out(ctx.opts.json ? JSON.stringify(report) : text);
    },
  },
  master: {
    usage: 'master [PATH] [--off]',
    summary: 'print, set or clear the Agent Ops Master Repo (one data root for every project)',
    options: { off: { type: 'boolean' } },
    run: (ctx) => {
      const env = ctx.io.env;
      if (ctx.opts.off) {
        editUserConfig(env, (doc) => {
          doc.delete('master');
        });
        ctx.io.out('no Master Repo set');
        return;
      }
      if (ctx.args.length === 0) {
        const m = ctx.ws().user.master;
        ctx.io.out(m ? `Master Repo: ${m}` : 'no Master Repo set: ops master PATH sets one');
        return m ? 0 : 3;
      }
      const dir = checkRoot(ctx.args[0]!);
      editUserConfig(env, (doc) => {
        doc.set('master', dir);
      });
      ctx.io.out(`Master Repo: ${dir}`);
    },
  },
  mirror: {
    usage: 'mirror on|off [--root NAME]',
    summary:
      'mirror this project root into the Master Repo, or stop (writes mirror: in its config.yml)',
    run: (ctx) => {
      const action = arg(ctx, 0, "'on' or 'off'");
      if (action !== 'on' && action !== 'off')
        usageError("use 'ops mirror on' or 'ops mirror off'");
      const ws = ctx.ws();
      const root = ws.defaultRoot();
      const master = masterRoot(ws.roots, ws.user);
      const changed = setRootMirror(root, action === 'on', master);
      if (action === 'on' && !master) {
        ctx.io.out(
          `${root.name}: mirror on; set the Master Repo with ops master PATH so sync copies it`,
        );
        return;
      }
      ctx.io.out(
        changed
          ? `${root.name}: mirror ${action}; the next ops sync ${action === 'on' ? 'copies it to the Master Repo' : 'stops copying'}`
          : `${root.name}: mirror was already ${action}`,
      );
    },
  },
  doctor: {
    usage: 'doctor [--json]',
    summary:
      'check this machine: user config, roots, runtimes on PATH and signed in, opsd, memory and disk',
    run: async (ctx) => {
      const checks = await doctor({ env: ctx.io.env, cwd: ctx.io.cwd });
      ctx.io.out(ctx.opts.json ? JSON.stringify(checks) : formatChecks(checks));
      return checks.some((c) => c.status === 'fail') ? 1 : 0;
    },
  },
  leaks: {
    usage: 'leaks [PATH...] [--deny FILE]...',
    summary: 'scan files for keys, tokens, webhook URLs and denied terms',
    options: { deny: { type: 'string', multiple: true } },
    run: (ctx) => {
      const deny = list(ctx.opts.deny).flatMap((f) => readDenyFile(f));
      const files = ctx.args.length ? ctx.args : usageError('name the files to scan');
      const hits = scanFiles(files, { deny });
      for (const h of hits) ctx.io.out(`LEAK: ${h.kind} in ${h.file}${h.line ? `:${h.line}` : ''}`);
      if (hits.length) return 1;
      ctx.io.out(`clean (${files.length} files)`);
    },
  },
};

function help(io: Io, name?: string): void {
  const cmd = name ? COMMANDS[name] : undefined;
  if (cmd) {
    io.out(`ops ${cmd.usage}\n\n${cmd.summary}`);
    return;
  }
  io.out(
    `ops ${VERSION}: tasks as files in git\n\nUsage: ops <command> [args] [--as ID] [--root NAME] [--force] [--json]\n`,
  );
  for (const [, c] of Object.entries(COMMANDS))
    io.out(`  ${pad(c.usage.split(' [')[0]!, 28)} ${c.summary}`);
  io.out('\nExit codes: 0 ok, 1 refused, 2 bad input, 3 nothing to do (next).');
}

function failure(err: unknown, name: string, io: Io, usage: string): number {
  if (err instanceof OpsError) {
    io.err(`ops ${name}: ${err.message}`);
    return err.code;
  }
  if (err instanceof TypeError && 'code' in err && String(err.code).startsWith('ERR_PARSE_ARGS')) {
    io.err(`ops ${name}: ${err.message}\nusage: ops ${usage}`);
    return 2;
  }
  throw err;
}

/**
 * Runs one `ops` command and returns its exit code. Commands that talk to opsd return a promise;
 * the rest return the code at once.
 */
export function run(argv: string[], io: Io): number | Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    help(io, rest[0]);
    return 0;
  }
  if (name === '--version' || name === 'version') {
    io.out(VERSION);
    return 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    io.err(`ops: unknown command '${name}'. Run 'ops help'.`);
    return 2;
  }
  try {
    const parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...(cmd.options ?? {}) },
      allowPositionals: true,
      strict: true,
    });
    const opts = parsed.values as Values;
    if (opts.help) {
      help(io, name);
      return 0;
    }
    let ws: Workspace | undefined;
    const ctx: Ctx = {
      io,
      args: parsed.positionals,
      opts,
      ws: () =>
        (ws ??= new Workspace({
          cwd: io.cwd,
          env: io.env,
          actor: str(opts.as),
          root: str(opts.root),
          force: Boolean(opts.force),
        })),
    };
    const res = cmd.run(ctx);
    if (res instanceof Promise) {
      return res.then(
        (code) => code ?? 0,
        (err: unknown) => failure(err, name, io, cmd.usage),
      );
    }
    return res ?? 0;
  } catch (err) {
    return failure(err, name, io, cmd.usage);
  }
}
