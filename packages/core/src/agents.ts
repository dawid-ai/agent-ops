import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDoc, stringifyDoc } from './frontmatter.js';
import { actorSlug, isActorId, isHuman, OpsError, slugToActor } from './ids.js';
import type { Root } from './root.js';

/** Frontmatter of `agents/<runtime>-<role>.md`. */
export interface AgentDef {
  id: string;
  name?: string;
  description?: string;
  status: 'active' | 'paused' | 'proposed';
  /** Task types this role takes from the queue; `*` for any. Empty or missing means any. */
  can_claim?: string[];
  projects?: string[];
  model?: string;
  budget_min?: number;
  /** Tool permissions for the role, for the phase 2 supervisor's permission profiles. */
  tools?: string[];
  /** MCP server names the role may use. */
  mcp?: string[];
  /** Learn-note topics (`kb/<topic>/`) the agent reads before it works. */
  kb?: string[];
  /** Files or folders the agent reads before it works, relative to the project. */
  files?: string[];
  /** How the agent writes: tone, format, words to use and avoid. */
  style?: string;
  file: string;
  body: string;
}

/** True for a real folder or file, never a link: links in a synced repo could point anywhere. */
function plain(path: string, kind: 'dir' | 'file'): boolean {
  try {
    const s = lstatSync(path);
    return kind === 'dir' ? s.isDirectory() : s.isFile();
  } catch {
    return false;
  }
}

/** True when anything is at `path`, a dangling link included. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A role file that `readAgentFiles` skipped, with the reason. */
export interface AgentFileProblem {
  file: string;
  message: string;
}

/** Role files in one root: the ones that read, and the ones skipped because they did not. */
export interface AgentFiles {
  agents: AgentDef[];
  problems: AgentFileProblem[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws on a role file the queue cannot use: frontmatter that is not a map, or a bad `can_claim`. */
function parseAgentFile(text: string): { data: Partial<AgentDef>; body: string } {
  const doc = parseDoc<unknown>(text);
  if (!isRecord(doc.data)) throw new Error('frontmatter is not a set of `key: value` fields');
  const claim = doc.data.can_claim;
  if (claim !== undefined && claim !== null) {
    if (!Array.isArray(claim) || claim.some((s) => typeof s !== 'string')) {
      throw new Error('can_claim: use a list of task types');
    }
  }
  return { data: doc.data as Partial<AgentDef>, body: doc.body };
}

/**
 * Reads `agents/*.md` in a root. A file that does not parse is skipped and named in `problems`,
 * so one hand-edited role file never stops the queue for every other agent.
 */
export function readAgentFiles(rootDir: string): AgentFiles {
  const dir = join(rootDir, 'agents');
  const out: AgentFiles = { agents: [], problems: [] };
  if (!plain(dir, 'dir')) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue;
    const file = join(dir, name);
    if (!plain(file, 'file')) continue;
    let doc: { data: Partial<AgentDef>; body: string };
    try {
      doc = parseAgentFile(readFileSync(file, 'utf8'));
    } catch (err) {
      // YAML errors carry a multi-line code frame; the first line names the problem and place.
      const message = (err as Error).message.split('\n')[0] ?? 'unreadable';
      out.problems.push({ file, message });
      continue;
    }
    const id = doc.data.id ?? slugToActor(name.slice(0, -3));
    if (!isActorId(id)) continue;
    out.agents.push({ ...doc.data, id, status: doc.data.status ?? 'active', file, body: doc.body });
  }
  return out;
}

/**
 * Why the role may not run or take work, or null when it is active or has no role file. A
 * proposed role waits for a person to approve it; a paused one for a person to resume it.
 */
export function roleInactive(agent: AgentDef | undefined): string | null {
  if (!agent || agent.status === 'active') return null;
  return `${agent.id} is ${agent.status} in its role file; a person sets status: active to let it work`;
}

/** The role files in a root that read; see `readAgentFiles` for the ones skipped. */
export function readAgents(rootDir: string): AgentDef[] {
  return readAgentFiles(rootDir).agents;
}

/**
 * Roles that only read code and post to Agent Ops: they review and answer, and never take work
 * that changes files (AO-0136). opsd gives their runs no `Edit` or `Write` by default.
 */
export const READ_ONLY_ROLES: readonly string[] = ['qa', 'reviewer', 'pm', 'orchestrator'];

/** Task types a read-only role takes from the queue when its role file sets no `can_claim`. */
export const READ_ONLY_CAN_CLAIM: readonly string[] = ['question'];

/** True when the agent id's role (the part after the colon) is one of `READ_ONLY_ROLES`. */
export function isReadOnlyRole(id: string): boolean {
  return READ_ONLY_ROLES.includes(id.slice(id.indexOf(':') + 1));
}

/**
 * True when the role's `can_claim` list allows the task type. A role with no list takes any type,
 * except a read-only role (`READ_ONLY_ROLES`, named by `id`), which takes only questions: a qa or
 * reviewer run that claims unowned work writes it with nobody to commit it (AO-0136).
 */
export function canClaimType(agent: AgentDef | undefined, type: string, id?: string): boolean {
  if (!agent?.can_claim || agent.can_claim.length === 0) {
    const who = agent?.id ?? id;
    return who !== undefined && isReadOnlyRole(who) ? READ_ONLY_CAN_CLAIM.includes(type) : true;
  }
  return agent.can_claim.includes('*') || agent.can_claim.includes(type);
}

/** The parts of a role file a person edits from the app. */
export interface RoleInput {
  id: string;
  name?: string;
  description?: string;
  status?: AgentDef['status'];
  /** The instructions: the role file's body. */
  instructions?: string;
  kb?: string[];
  files?: string[];
  style?: string;
  budget_min?: number;
  can_claim?: string[];
}

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STATUSES: AgentDef['status'][] = ['active', 'paused', 'proposed'];

function list(
  v: unknown,
  what: string,
  max: number,
  check?: (s: string) => boolean,
): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw new OpsError(`${what}: use a list of names`, 2);
  }
  if (v.length > max) throw new OpsError(`${what}: at most ${max} entries`, 2);
  const out = [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))];
  for (const s of out) {
    if (check && !check(s)) throw new OpsError(`${what}: bad entry '${s}'`, 2);
  }
  return out.length > 0 ? out : undefined;
}

function text(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new OpsError(`${what}: use text`, 2);
  if (v.length > max) throw new OpsError(`${what}: at most ${max} characters`, 2);
  return v.trim() || undefined;
}

/** A role input after `checkRole`: every field is the right type and size, or left out. */
export interface CheckedRole {
  id: string;
  status?: AgentDef['status'];
  /** Fields to set; `undefined` clears a field the input sent as `null`. */
  set: Record<string, unknown>;
  /** The body, when the input sent instructions. */
  instructions?: string;
}

const FIELDS = ['name', 'description', 'kb', 'files', 'style', 'budget_min', 'can_claim'] as const;

/**
 * Checks a role input from the app before anything reads or writes a file: the id, the status,
 * the budget, and each list and text field with its size. Throws an OpsError (code 2) otherwise.
 */
export function checkRole(input: unknown): CheckedRole {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OpsError('role: expected an object', 2);
  }
  const i = input as Record<string, unknown>;
  const id = typeof i.id === 'string' ? i.id.trim() : '';
  if (!isActorId(id) || isHuman(id) || id.split(':')[1] === '*') {
    throw new OpsError(`bad role id '${id}': use <runtime>:<role>, such as claude:writer`, 2);
  }
  let status: AgentDef['status'] | undefined;
  if (i.status !== undefined && i.status !== null) {
    if (!STATUSES.includes(i.status as AgentDef['status'])) {
      throw new OpsError(`status: use ${STATUSES.join(', ')}`, 2);
    }
    status = i.status as AgentDef['status'];
  }
  let budget: number | undefined;
  if (i.budget_min !== undefined && i.budget_min !== null) {
    budget = i.budget_min as number;
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1) {
      throw new OpsError('budget_min: use a whole number of minutes', 2);
    }
  }
  const values: Record<(typeof FIELDS)[number], unknown> = {
    name: text(i.name, 'name', 80),
    description: text(i.description, 'description', 300),
    kb: list(i.kb, 'kb', 20, (s) => TOPIC_RE.test(s)),
    files: list(i.files, 'files', 40, (s) => s.length <= 200 && !s.includes('\0')),
    style: text(i.style, 'style', 4000),
    budget_min: budget,
    can_claim: list(i.can_claim, 'can_claim', 20, (s) => s === '*' || TOPIC_RE.test(s)),
  };
  // Only the fields the input sent change; the rest keep the file's value.
  const set: Record<string, unknown> = {};
  for (const k of FIELDS) if (i[k] !== undefined) set[k] = values[k];
  const instructions =
    i.instructions === undefined ? undefined : (text(i.instructions, 'instructions', 20000) ?? '');
  return { id, status, set, instructions };
}

/**
 * Creates or updates `agents/<runtime>-<role>.md` in a root. Only the fields in `RoleInput`
 * change; the rest of an existing file's frontmatter (`tools`, `mcp`, `model`, `projects`) is kept,
 * so the app can never widen what a role may run. `create` refuses a file that exists.
 */
export function writeAgent(
  root: Root,
  input: RoleInput | CheckedRole,
  opts: { create?: boolean } = {},
): AgentDef {
  const role = 'set' in input ? input : checkRole(input);
  const { id } = role;
  const dir = join(root.dir, 'agents');
  if (!present(dir)) mkdirSync(dir);
  if (!plain(dir, 'dir'))
    throw new OpsError('agents/ is a link; role files go in a real folder', 2);
  const file = join(dir, `${actorSlug(id)}.md`);
  let data: Record<string, unknown> = {};
  let body = '';
  if (present(file)) {
    if (opts.create) throw new OpsError(`${id} already has a role file in ${root.name}`, 2);
    if (!plain(file, 'file')) throw new OpsError(`${actorSlug(id)}.md is a link; not changed`, 2);
    let doc: { data: Partial<AgentDef>; body: string };
    try {
      doc = parseAgentFile(readFileSync(file, 'utf8'));
    } catch (err) {
      const why = (err as Error).message.split('\n')[0];
      throw new OpsError(`${actorSlug(id)}.md does not parse (${why}); fix it by hand first`, 2);
    }
    data = doc.data as Record<string, unknown>;
    body = doc.body;
  }
  const next: Record<string, unknown> = {
    ...data,
    id,
    status: role.status ?? (data.status as AgentDef['status'] | undefined) ?? 'active',
    ...role.set,
  };
  root.writeAtomic(file, stringifyDoc(next, role.instructions ?? body));
  const def = readAgents(root.dir).find((a) => a.id === id);
  if (!def) throw new OpsError(`could not read ${id} back`, 1);
  return def;
}
