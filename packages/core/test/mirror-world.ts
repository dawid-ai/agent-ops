import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserConfig } from '../src/index.js';
import { initRoot, syncAll, Workspace } from '../src/index.js';
import { git, gitRepo, tempDir, TEST_IDENTITY } from './helpers.js';

/*
 * The two-machine world the Master Repo mirror tests share. Each scenario lives in its own
 * mirror*.test.ts file: every sync runs real git against real remotes, 1-2 s per sync on Windows,
 * so the scenarios run in parallel workers instead of one after another.
 */

/** A bare remote with one pushed clone holding a data root. */
export function hosted(
  name: string,
  prefix: string,
  mirror = false,
): { remote: string; clone: string } {
  const clone = gitRepo();
  initRoot(clone, { name, prefix, human: 'human:dawid' });
  if (mirror) {
    const file = join(clone, '.agent-ops', 'config.yml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}mirror: true\n`);
  }
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'init');
  // The remote is a bare clone of the clone, and the clone tracks it: the state `git push -u`
  // leaves, without a push (half a second on Windows) or `git remote` and `git config` processes.
  const remote = tempDir();
  git(remote, 'clone', '-q', '--bare', clone, '.');
  appendFileSync(
    join(clone, '.git', 'config'),
    [
      '[remote "origin"]',
      // Forward slashes: a backslash starts an escape in git config files.
      `\turl = ${remote.split('\\').join('/')}`,
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[branch "main"]',
      '\tremote = origin',
      '\tmerge = refs/heads/main',
      '',
    ].join('\n'),
  );
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { remote, clone };
}

export function cloneOf(remote: string): string {
  const dir = tempDir();
  git(dir, 'clone', '-q', remote, '.');
  appendFileSync(join(dir, '.git', 'config'), TEST_IDENTITY);
  return dir;
}

/**
 * Machine 1 has the project repo and the Master Repo; machine 2 has only the Master Repo. Both
 * run every sync through syncAll, as `ops sync` and opsd do.
 */
export function world() {
  const site = hosted('site', 'WEB', true);
  const hub = hosted('hub', 'HUB');
  const hub2 = cloneOf(hub.remote);
  const env = { OPS_CONFIG: join(site.clone, 'none.yml') } as NodeJS.ProcessEnv;
  const user1: UserConfig = { roots: [site.clone], master: hub.clone, id_block: 0, machine: 'pc' };
  const user2: UserConfig = { master: hub2, id_block: 1, machine: 'laptop' };
  const m1 = (actor: string, now?: () => number) =>
    new Workspace({ cwd: site.clone, env, actor, user: user1, now });
  const m2 = (actor: string, now?: () => number) =>
    new Workspace({ cwd: hub2, env, actor, user: user2, now });
  const sync1 = async () => {
    await turn();
    return syncAll(m1('human:dawid').roots, user1, { pull: true, push: true });
  };
  const sync2 = async () => {
    await turn();
    return syncAll(m2('human:dawid').roots, user2, { pull: true, push: true });
  };
  return { site, hub, hub2, m1, m2, sync1, sync2, env, user1, user2 };
}

/**
 * A machine with one project root and a Master Repo clone, syncing the way `ops sync` does. Use it
 * when both machines keep a project root, which world() does not model.
 */
export function machine(site: string, hub: string, block: number) {
  const env = { OPS_CONFIG: join(site, 'none.yml') } as NodeJS.ProcessEnv;
  const user: UserConfig = { roots: [site], master: hub, id_block: block };
  const ws = (actor: string) => new Workspace({ cwd: site, env, actor, user });
  const sync = async () => {
    await turn();
    return syncAll(ws('human:dawid').roots, user, { pull: true, push: true });
  };
  return { ws, sync };
}

/**
 * One event-loop turn before each sync. A scenario runs git synchronously for many seconds, and
 * the vitest worker reads its RPC replies only when the loop turns; a reply left unread for 60 s
 * fails the run however long the test timeout is.
 */
export function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The test timeout for a scenario: a hang guard. A scenario takes 6-16 s alone on Windows, and
 * up to four times as long while the full suite runs git in every worker.
 */
export const SCENARIO_TIMEOUT = 120_000;

/** A world where the project root has a daily repeat that both machines have synced. */
export async function withRepeat() {
  const w = world();
  w.m1('human:dawid').saveRepeat({
    name: 'report',
    title: 'Daily report',
    start: '2026-11-01 09:00',
    repeat: 'daily',
  });
  await w.sync1();
  await w.sync2();
  return w;
}

export const state = (ws: Workspace, ref: string) => {
  const v = ws.view(ref);
  return {
    status: v.status,
    claimedBy: v.claimedBy,
    claimToken: v.claimToken,
    title: v.meta.title,
  };
};
