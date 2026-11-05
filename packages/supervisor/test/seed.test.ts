import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UserConfig } from '@agent-ops/core';
import { DEFAULT_PROVIDERS, readUserConfig, Workspace } from '@agent-ops/core';
import type { OpsdConfig } from '../src/index.js';
import {
  DEFAULT_RUNTIMES,
  invocation,
  opsdConfig,
  roleLimits,
  runModel,
  seedOnStart,
  seedUserConfig,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function configAt(text?: string): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), 'opsd-seed-'));
  dirs.push(d);
  const file = join(d, 'config.yml');
  if (text !== undefined) writeFileSync(file, text);
  return { OPS_CONFIG: file } as NodeJS.ProcessEnv;
}

const onlyClaude = (c: string): boolean => c === 'claude';

describe('seeding providers and agents', () => {
  it('seeds providers and agents of the installed providers on a clean profile', () => {
    const env = configAt();
    const note = seedOnStart(env, { installed: onlyClaude });
    expect(note).toMatch(/wrote providers claude, codex and agents claude:engineer, claude:qa/);
    const cfg = opsdConfig(readUserConfig(env));
    expect(cfg.seeded).toBe(true);
    expect(cfg.runtimes).toEqual({ claude: { command: 'claude' }, codex: { command: 'codex' } });
    expect(Object.keys(cfg.agents)).toEqual([
      'claude:engineer',
      'claude:qa',
      'claude:reviewer',
      'claude:pm',
    ]);
  });

  it('seeds the agents of every default provider when none is installed yet', () => {
    const env = configAt();
    const r = seedUserConfig(env, { agents: true, installed: () => false });
    expect(r.agents).toHaveLength(8);
    expect(r.agents).toContain('codex:reviewer');
  });

  it('migrates a config without runtimes: comments, me and agents stay, no agents are added', () => {
    const env = configAt(
      '# my notes\nme: human:dawid\nopsd:\n  max_runs: 4 # four\n  agents:\n    claude:writer:\n      wake: true\n',
    );
    const note = seedOnStart(env, { installed: () => true });
    expect(note).toMatch(/wrote providers claude, codex; edit or remove them in Settings$/);
    const text = readFileSync(env.OPS_CONFIG!, 'utf8');
    expect(text).toContain('# my notes');
    expect(text).toContain('max_runs: 4 # four');
    const cfg = opsdConfig(readUserConfig(env));
    expect(Object.keys(cfg.agents)).toEqual(['claude:writer']);
    expect(Object.keys(cfg.runtimes)).toEqual(['claude', 'codex']);
  });

  it('migrates limits set on a default provider and keeps custom providers', () => {
    const env = configAt(
      'opsd:\n  runtimes:\n    codex: { max_live: 2, unset_env: [GH_TOKEN] }\n    hermes: { command: hermes }\n',
    );
    // Before the migration, the defaults fill in what the file leaves out, as they always did.
    expect(Object.keys(opsdConfig(readUserConfig(env)).runtimes).sort()).toEqual([
      'claude',
      'codex',
      'hermes',
    ]);
    const r = seedUserConfig(env);
    expect(r.runtimes).toEqual(['claude', 'codex']);
    const cfg = opsdConfig(readUserConfig(env));
    expect(cfg.runtimes).toEqual({
      codex: { max_live: 2, unset_env: ['GH_TOKEN'], command: 'codex' },
      hermes: { command: 'hermes' },
      claude: { command: 'claude' },
    });
  });

  it('never touches a seeded config, so removed providers and agents stay removed', () => {
    const text = 'opsd:\n  seeded: 1\n  runtimes:\n    hermes: { command: hermes }\n';
    const env = configAt(text);
    expect(seedOnStart(env)).toBeNull();
    expect(seedUserConfig(env, { agents: true }).seeded).toBe(false);
    expect(readFileSync(env.OPS_CONFIG!, 'utf8')).toBe(text);
    expect(Object.keys(opsdConfig(readUserConfig(env)).runtimes)).toEqual(['hermes']);
  });

  it('refuses a seeded provider without a command and a bad model', () => {
    expect(() =>
      opsdConfig({ opsd: { seeded: 1, runtimes: { codex: { max_live: 1 } } } } as never),
    ).toThrow(/codex\.command/);
    expect(() =>
      opsdConfig({ opsd: { runtimes: { codex: { command: 'codex', model: '--yolo' } } } } as never),
    ).toThrow(/runtimes\.codex\.model/);
    expect(() =>
      opsdConfig({ opsd: { agents: { 'codex:qa': { model: 'a b' } } } } as never),
    ).toThrow(/agents\.codex:qa\.model/);
    // An agent listed with nothing after it is an agent with no settings of its own.
    expect(opsdConfig({ opsd: { agents: { 'codex:qa': null } } } as never).agents).toEqual({
      'codex:qa': {},
    });
  });
});

describe('role providers in core and opsd (AO-0140)', () => {
  it('agree, so the owner check and routing match what wake starts', () => {
    expect(Object.keys(DEFAULT_RUNTIMES)).toEqual([...DEFAULT_PROVIDERS]);
    const users: Array<UserConfig & { opsd?: Partial<OpsdConfig> }> = [
      {},
      { opsd: { runtimes: { fake: { command: 'fake' } } } },
      { opsd: { seeded: true, runtimes: { fake: { command: 'fake' } } } },
      { opsd: { roles: { qa: { providers: ['codex'], overflow: false } } } },
    ];
    for (const user of users) {
      const cwd = mkdtempSync(join(tmpdir(), 'opsd-providers-'));
      dirs.push(cwd);
      const ws = new Workspace({ user, cwd, actor: 'human:dawid', env: {} as NodeJS.ProcessEnv });
      const lim = roleLimits(opsdConfig(user), 'qa');
      expect(ws.groupProviders('claude:qa')).toEqual({
        providers: lim.providers,
        overflow: lim.overflow,
      });
    }
  });
});

describe('the model of a run', () => {
  it("takes the agent's model over the provider's and refuses one that reads as a flag", () => {
    expect(runModel({ command: 'codex', model: 'o3' }, undefined)).toBe('o3');
    expect(
      runModel({ command: 'codex', model: 'o3' }, { model: 'gpt-5-codex', file: 'x.md' }),
    ).toBe('gpt-5-codex');
    expect(runModel({ command: 'codex' }, undefined)).toBeUndefined();
    expect(() => runModel({ command: 'codex' }, { model: '--full-auto', file: 'a.md' })).toThrow(
      /a\.md: model/,
    );
  });

  it('passes the model as --model to Claude, -m to Codex, and nothing to other providers', () => {
    const claude = invocation(
      { command: 'claude', model: 'opus' },
      'claude:qa',
      undefined,
      '/w',
      [],
    );
    expect(claude.args.join(' ')).toContain('--model opus');
    const codex = invocation({ command: 'codex', model: 'o3' }, 'codex:qa', undefined, '/w', []);
    expect(codex.args.slice(0, 3)).toEqual(['exec', '-m', 'o3']);
    const hermes = invocation(
      { command: 'hermes', args: ['run', '-'], model: 'x' },
      'hermes:qa',
      undefined,
      '/w',
      [],
    );
    expect(hermes.args).toEqual(['run', '-']);
  });
});
