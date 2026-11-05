import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import {
  installClaudeHooks,
  mergeClaudeHooks,
  SYNC_HOOK_COMMAND,
  SYNC_HOOK_TIMEOUT,
} from '../src/hooks.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ops-hooks-'));
  dirs.push(d);
  return d;
}

describe('Claude Code hooks', () => {
  it('adds SessionEnd and PreCompact once and keeps other settings', () => {
    const start = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
    };
    const first = mergeClaudeHooks(start);
    expect(first.added).toEqual(['SessionEnd', 'PreCompact']);
    expect(first.settings.permissions).toEqual(start.permissions);
    expect(first.settings.hooks?.SessionEnd).toHaveLength(2);
    const second = mergeClaudeHooks(first.settings);
    expect(second.added).toEqual([]);
    expect(second.settings).toEqual(first.settings);
  });

  it('writes .claude/settings.json and refuses a broken file', () => {
    const d = temp();
    const res = installClaudeHooks(d);
    expect(res.added).toHaveLength(2);
    const saved = JSON.parse(readFileSync(res.file, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(saved.hooks.PreCompact![0]!.hooks[0]!.command).toBe(SYNC_HOOK_COMMAND);
    // SessionEnd hooks get 1.5 s unless they set a timeout; sync needs more.
    expect(saved.hooks.SessionEnd![0]!.hooks[0]).toMatchObject({ timeout: SYNC_HOOK_TIMEOUT });
    expect(installClaudeHooks(d).added).toEqual([]);

    const broken = temp();
    mkdirSync(join(broken, '.claude'));
    writeFileSync(join(broken, '.claude', 'settings.json'), '{oops');
    expect(() => installClaudeHooks(broken)).toThrow(/not valid JSON/);
    expect(readFileSync(join(broken, '.claude', 'settings.json'), 'utf8')).toBe('{oops');
  });
});

describe('hook upgrade', () => {
  it('adds the timeout to a sync hook written without one', () => {
    const old = {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: SYNC_HOOK_COMMAND }] }] },
    };
    const res = mergeClaudeHooks(old);
    expect(res.added).toEqual(['SessionEnd', 'PreCompact']);
    const end = (res.settings.hooks as Record<string, Array<{ hooks: unknown[] }>>).SessionEnd!;
    expect(end).toHaveLength(1);
    expect(end[0]!.hooks[0]).toEqual({
      type: 'command',
      command: SYNC_HOOK_COMMAND,
      timeout: SYNC_HOOK_TIMEOUT,
    });
  });
});

describe('sync from a hook', () => {
  it('exits 0 where there is no data root', () => {
    const d = temp();
    const out: string[] = [];
    const env = { OPS_CONFIG: join(d, 'none.yml') } as NodeJS.ProcessEnv;
    const io = { out: (l: string) => out.push(l), err: () => {}, env, cwd: d };
    expect(run(['sync', '--session-end'], io)).toBe(0);
    expect(out).toEqual(['no data root here; nothing to sync']);
    expect(run(['sync'], io)).toBe(2);
  });
});
