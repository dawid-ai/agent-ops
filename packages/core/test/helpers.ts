import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { initRoot, Workspace } from '../src/index.js';
import type { WorkspaceOptions } from '../src/index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ops-test-'));
  dirs.push(d);
  return d;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
}

export function gitRepo(dir = tempDir()): string {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/** A git repo with a data root; returns a factory for workspaces acting as different ids. */
export function setup(opts: { prefix?: string; human?: string } = {}) {
  const repo = gitRepo();
  const rootDir = initRoot(repo, {
    name: 'test',
    prefix: opts.prefix,
    human: opts.human ?? 'human:dawid',
  });
  const env = { OPS_CONFIG: join(repo, 'no-user-config.yml') } as NodeJS.ProcessEnv;
  const as = (actor: string, extra: Partial<WorkspaceOptions> = {}) =>
    new Workspace({ cwd: repo, env, actor, ...extra });
  return { repo, rootDir, env, as };
}

/** Builds a secret-looking string at runtime so this file never trips the leak check. */
export function fakeToken(): string {
  return ['gh', 'p_'].join('') + 'A'.repeat(36);
}
