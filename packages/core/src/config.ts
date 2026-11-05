import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { assertActor, isHuman, OpsError } from './ids.js';

export const SYNC_POLICIES = ['manual', 'checkpoint', 'coordinated'] as const;
export type SyncPolicy = (typeof SYNC_POLICIES)[number];

/** `<root>/config.yml`: shared by everyone who uses the root. */
export interface RootConfig {
  agent_ops: 2;
  name: string;
  /** Task id prefix, such as `T` for `T-0001`. */
  id_prefix: string;
  /** Who answers asks and reviews when no one is named. */
  human?: string;
  sync: {
    policy: SyncPolicy;
    pull_minutes: number;
    push_minutes: number;
    remote?: string;
    /**
     * The branch that holds the store. Sync commits only while the root's checkout is on it.
     * Default: the branch this clone learned on its first sync, the one holding the newest store
     * commit.
     */
    branch?: string;
  };
  leases: {
    claim_minutes: number;
    work_minutes: number;
  };
  /**
   * Mirror this project root into the Agent Ops Master Repo (`master` in the user config), as
   * `<master>/mirrors/<name>/`. Opt-in per project root.
   */
  mirror?: boolean;
  /**
   * The project of a task that names none. Default: `name`. opsd counts runs per project, so every
   * task in one checkout should resolve to one project.
   */
  project?: string;
  /**
   * Old project names and the project each now reads as, such as `v2: agent-ops`. Tasks keep the
   * name they were filed with in `task.md`; every reader sees the new one.
   */
  project_aliases?: Record<string, string>;
}

/** Per-machine settings, never committed: `OPS_CONFIG` or the user config file. */
export interface UserConfig {
  /** The human using this machine, such as `human:dawid`. */
  me?: string;
  /** Data roots to read besides the one found from the working directory. */
  roots?: string[];
  /**
   * The Agent Ops Master Repo: one data root for every project. It is read like any root, its
   * mirror roots show the projects that mirror into it, and mirrored project roots sync with it.
   */
  master?: string;
  /** Machine name for sync commit messages; left out when unset. */
  machine?: string;
  /**
   * Task number block for this machine. Block 0 allocates 1-9999, block 1 allocates 10001-19999,
   * so machines that create tasks between syncs never pick the same id.
   */
  id_block?: number;
}

export const ROOT_DIR_NAME = '.agent-ops';
export const ID_BLOCK_SIZE = 10_000;

export function defaultRootConfig(name: string, prefix = 'T', human?: string): RootConfig {
  return {
    agent_ops: 2,
    name,
    id_prefix: prefix,
    human,
    sync: { policy: 'checkpoint', pull_minutes: 10, push_minutes: 30 },
    leases: { claim_minutes: 60, work_minutes: 240 },
  };
}

export function readRootConfig(dir: string): RootConfig {
  const file = join(dir, 'config.yml');
  if (!existsSync(file)) throw new OpsError(`${dir} is not a data root: no config.yml`, 2);
  const raw = (YAML.parse(readFileSync(file, 'utf8')) ?? {}) as Partial<RootConfig>;
  if (raw.agent_ops !== 2) throw new OpsError(`${file}: expected 'agent_ops: 2'`, 2);
  const base = defaultRootConfig(raw.name ?? 'default', raw.id_prefix ?? 'T', raw.human);
  return {
    ...base,
    ...raw,
    id_prefix: (raw.id_prefix ?? 'T').toUpperCase(),
    sync: { ...base.sync, ...(raw.sync ?? {}) },
    leases: { ...base.leases, ...(raw.leases ?? {}) },
  } as RootConfig;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPS_CONFIG) return env.OPS_CONFIG;
  if (process.platform === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'agent-ops', 'config.yml');
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'agent-ops', 'config.yml');
}

export function readUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  const file = userConfigPath(env);
  if (!existsSync(file)) return {};
  return (YAML.parse(readFileSync(file, 'utf8')) ?? {}) as UserConfig;
}

/** `human:<OS user name>`, cleaned into a valid id, for a first-start default. */
export function defaultHumanId(): string {
  let name = '';
  try {
    name = userInfo().username;
  } catch {
    // No user name on this system.
  }
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '');
  return `human:${clean || 'me'}`;
}

export interface SetupResult {
  path: string;
  created: boolean;
  changed: boolean;
  /** The `me` the config has now: an existing one is never replaced. */
  me: string;
  roots: string[];
}

/**
 * Writes the user config on a first start: `me` and the data roots to load. A missing file is
 * created where the platform expects it, never over a file another process created meanwhile. An
 * existing one keeps everything, comments and roots included, and only gains a missing `me`.
 */
export function setupUserConfig(
  input: { me: string; roots?: string[] },
  env: NodeJS.ProcessEnv = process.env,
  /** For tests: runs right before the exclusive create, as another start could. */
  hooks: { beforeCreate?: () => void } = {},
): SetupResult {
  const me = assertActor(input.me.trim(), 'me');
  if (!isHuman(me)) throw new OpsError(`me must be a person: human:<name>, not ${me}`, 2);
  const file = userConfigPath(env);
  // An existing config only gains a missing me; the roots given are not used, so not checked.
  if (existsSync(file)) return addMe(file, me);
  // A repo and its .agent-ops folder name one root; the repo is the spelling kept.
  const roots: string[] = [];
  for (const raw of input.roots ?? []) {
    if (!raw.trim()) continue;
    const r = checkRoot(raw);
    if (!roots.some((x) => sameRoot(x, r))) roots.push(r);
  }
  mkdirSync(dirname(file), { recursive: true });
  hooks.beforeCreate?.();
  try {
    // `wx`: create only; a file another start wrote first is kept and handled as existing.
    const doc = new YAML.Document(roots.length > 0 ? { me, roots } : { me });
    writeFileSync(file, doc.toString(), { flag: 'wx' });
    return { path: file, created: true, changed: true, me, roots };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return addMe(file, me);
}

/**
 * A data root as the user config lists it: the repo that holds `.agent-ops/` (or a dedicated data
 * repo). Throws when the folder is not a data root.
 */
export function checkRoot(raw: string): string {
  const r = rootFolder(resolve(raw.trim()));
  const dir = existsSync(join(r, ROOT_DIR_NAME, 'config.yml')) ? join(r, ROOT_DIR_NAME) : r;
  try {
    readRootConfig(dir);
  } catch (err) {
    throw new OpsError(`${r} is not a data root: ${(err as Error).message}`, 2);
  }
  return r;
}

/** Whether two spellings name one root (a repo and its `.agent-ops` folder count as one). */
export function sameRoot(x: string, y: string): boolean {
  const p = canonical(rootFolder(resolve(x)));
  const q = canonical(rootFolder(resolve(y)));
  return process.platform === 'win32' ? p.toLowerCase() === q.toLowerCase() : p === q;
}

/**
 * Changes the user config in place, keeping comments and everything `change` leaves alone.
 * `check` sees the result before it is written and throws to refuse it; nothing is written then.
 * The write goes to a temporary file first, so a crash never leaves half a config. `env` has no
 * default on purpose: the caller names whose config it edits (opsd passes its own env).
 */
export function editUserConfig(
  env: NodeJS.ProcessEnv,
  change: (doc: YAML.Document) => void,
  check: (next: UserConfig) => void = () => {},
): UserConfig {
  const file = userConfigPath(env);
  const doc = existsSync(file)
    ? YAML.parseDocument(readFileSync(file, 'utf8'))
    : new YAML.Document({});
  if (doc.errors.length > 0) {
    throw new OpsError(`${file}: ${doc.errors[0]!.message}; fix the file by hand first`, 2);
  }
  change(doc);
  const next = (doc.toJS() ?? {}) as UserConfig;
  check(next);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, doc.toString());
  renameSync(tmp, file);
  return next;
}

/** Adds `me` to an existing user config that lacks it, keeping everything else. */
function addMe(file: string, me: string): SetupResult {
  const doc = YAML.parseDocument(readFileSync(file, 'utf8'));
  let changed = false;
  if (!doc.get('me')) {
    doc.set('me', me);
    changed = true;
    writeFileSync(file, doc.toString());
  }
  const listed = ((doc.toJS() as { roots?: string[] } | null)?.roots ?? []).map(String);
  return { path: file, created: false, changed, me: String(doc.get('me')), roots: listed };
}

/** A root's `.agent-ops` folder stands for the repo that holds it. */
function rootFolder(p: string): string {
  return basename(p) === ROOT_DIR_NAME ? dirname(p) : p;
}

/**
 * The folder to suggest as a first root: the repo of the data root found from `start`, or none.
 */
export function suggestedRoot(start: string): string | null {
  const found = findRootUp(start);
  if (!found) return null;
  return basename(found) === ROOT_DIR_NAME ? dirname(found) : found;
}

/** Walks up from `start` and returns the first `.agent-ops` folder with a config.yml. */
export function findRootUp(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, ROOT_DIR_NAME);
    if (existsSync(join(candidate, 'config.yml'))) return candidate;
    if (existsSync(join(dir, 'config.yml')) && isRootConfig(join(dir, 'config.yml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isRootConfig(file: string): boolean {
  try {
    return /^agent_ops:\s*2\s*$/m.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Lists data root folders: the one found from `cwd` first, then `OPS_ROOTS`
 * (path-delimiter separated) or the user config's `roots`. Duplicates are dropped.
 */
export function discoverRoots(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  user: UserConfig = readUserConfig(env),
): string[] {
  const found: string[] = [];
  const local = findRootUp(cwd);
  if (local) found.push(local);
  const listed = env.OPS_ROOTS
    ? env.OPS_ROOTS.split(delimiter).filter(Boolean)
    : [...(user.roots ?? []), ...(user.master ? [user.master] : [])];
  for (const r of listed) found.push(rootDirOf(r));
  const seen = new Set<string>();
  const roots = found.filter((p) => {
    const key = pathKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Mirror roots in a Master Repo show projects this machine does not have; a project root that
  // is loaded hides its own copy.
  const names = new Set(roots.map(rootNameOf).filter((n): n is string => n !== null));
  for (const dir of [...roots]) {
    if (isMirrorDir(dir)) continue;
    for (const m of mirrorDirs(dir)) {
      const name = rootNameOf(m);
      if (!name || names.has(name) || seen.has(pathKey(m))) continue;
      names.add(name);
      seen.add(pathKey(m));
      roots.push(m);
    }
  }
  return roots;
}

/** A path given as a repo or as its data root folder, as the data root folder. */
export function rootDirOf(path: string): string {
  const p = resolve(path);
  return existsSync(join(p, ROOT_DIR_NAME, 'config.yml')) ? join(p, ROOT_DIR_NAME) : p;
}

function pathKey(p: string): string {
  return process.platform === 'win32' ? canonical(p).toLowerCase() : canonical(p);
}

/** True when both paths name the same folder. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function rootNameOf(dir: string): string | null {
  try {
    return readRootConfig(dir).name;
  } catch {
    return null;
  }
}

/** `<root>/mirrors/<name>` inside a data root: a Master Repo's copy of a project root. */
export function isMirrorDir(dir: string): boolean {
  const parent = dirname(dir);
  return basename(parent) === 'mirrors' && existsSync(join(dirname(parent), 'config.yml'));
}

/** The mirror roots inside a data root, if it is a Master Repo. */
export function mirrorDirs(dir: string): string[] {
  const base = join(dir, 'mirrors');
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(base, d.name, 'config.yml')))
      .map((d) => join(base, d.name));
  } catch {
    return [];
  }
}
