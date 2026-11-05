import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  initRoot,
  readAgentFiles,
  readAgents,
  defaultHumanId,
  readUserConfig,
  setupUserConfig,
} from '../src/index.js';
import { tempDir, setup } from './helpers.js';

describe('initRoot', () => {
  it('keeps data files LF and copies role templates on request', () => {
    const plain = initRoot(tempDir());
    expect(readFileSync(join(plain, '.gitattributes'), 'utf8')).toBe('* text=auto eol=lf\n');
    expect(readAgents(plain)).toEqual([]);

    const withAgents = initRoot(tempDir(), { withAgents: true });
    const ids = readAgents(withAgents).map((a) => a.id);
    expect(ids).toContain('claude:orchestrator');
    expect(ids).toContain('codex:backend');
    const backend = readAgents(withAgents).find((a) => a.id === 'codex:backend')!;
    expect(backend.can_claim).toEqual(['task', 'bug']);
    expect(readFileSync(join(withAgents, 'people', 'owner.md'), 'utf8')).toContain('human:owner');
  });
});

describe('readAgentFiles', () => {
  it('skips a role file that does not parse and keeps the rest', () => {
    const { rootDir, as } = setup();
    const dir = join(rootDir, 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codex-qa.md'), '---\nid: codex:qa\nstatus: active\n---\nChecks.\n');
    writeFileSync(
      join(dir, 'claude-reviewer.md'),
      '---\ndescription: Reviews code: carefully\n---\n',
    );
    writeFileSync(join(dir, 'claude-list.md'), '---\n- not\n- a map\n---\n');
    writeFileSync(join(dir, 'claude-claim.md'), '---\ncan_claim: bug\n---\n');

    const files = readAgentFiles(rootDir);
    expect(files.agents.map((a) => a.id)).toEqual(['codex:qa']);
    expect(files.problems.map((p) => basename(p.file)).sort()).toEqual([
      'claude-claim.md',
      'claude-list.md',
      'claude-reviewer.md',
    ]);
    const yaml = files.problems.find((p) => p.file.endsWith('claude-reviewer.md'))!;
    expect(yaml.message).not.toContain('\n');
    expect(readAgents(rootDir).map((a) => a.id)).toEqual(['codex:qa']);

    const ws = as('human:dawid');
    expect(ws.agents().map((a) => a.id)).toEqual(['codex:qa']);
    expect(ws.agentProblems()).toHaveLength(3);
    // The app edits a role through saveRole: a broken file is refused, not overwritten.
    expect(() => ws.saveRole({ id: 'claude:reviewer', name: 'Reviewer' })).toThrow(
      /does not parse/,
    );
    expect(readFileSync(join(dir, 'claude-reviewer.md'), 'utf8')).toContain('Reviews code: ');
  });
});

describe('user config setup', () => {
  it('creates the user config, and only adds what an existing one lacks', () => {
    const { repo } = setup();
    const other = setup().repo;
    const file = join(repo, 'user', 'config.yml');
    const env = { OPS_CONFIG: file } as NodeJS.ProcessEnv;
    const first = setupUserConfig({ me: 'human:dawid', roots: [repo] }, env);
    expect(first).toMatchObject({ created: true, changed: true, me: 'human:dawid' });
    expect(readUserConfig(env)).toEqual({ me: 'human:dawid', roots: [repo] });

    // An existing file keeps its comments, its me and its other settings.
    writeFileSync(
      file,
      '# my notes\nopsd:\n  max_runs: 8 # keep\nroots:\n  - ' + JSON.stringify(repo) + '\n',
    );
    const second = setupUserConfig({ me: 'human:someone', roots: [repo, other] }, env);
    // Only me is added: the file's own roots stay as they are.
    expect(second).toMatchObject({
      created: false,
      changed: true,
      me: 'human:someone',
      roots: [repo],
    });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# my notes');
    expect(text).toContain('max_runs: 8 # keep');
    expect(readUserConfig(env)).toMatchObject({
      me: 'human:someone',
      roots: [repo],
      opsd: { max_runs: 8 },
    });
    const third = setupUserConfig({ me: 'human:dawid', roots: [other] }, env);
    expect(third).toMatchObject({ changed: false, me: 'human:someone' });

    expect(() => setupUserConfig({ me: 'claude:engineer' }, env)).toThrow(/must be a person/);
    // Roots are checked when the config is new.
    const unused = { OPS_CONFIG: join(repo, 'user', 'unused.yml') } as NodeJS.ProcessEnv;
    expect(() => setupUserConfig({ me: 'human:x', roots: [join(repo, 'nope')] }, unused)).toThrow(
      /not a data root/,
    );
    expect(defaultHumanId()).toMatch(/^human:[a-z][a-z0-9-]*$/);

    // An existing config without me gains me even when the roots given are not data roots.
    const noMe = join(repo, 'user', 'no-me.yml');
    writeFileSync(noMe, 'roots: []\n');
    const added = setupUserConfig(
      { me: 'human:dawid', roots: [join(repo, 'nope')] },
      { OPS_CONFIG: noMe },
    );
    expect(added).toMatchObject({ created: false, changed: true, me: 'human:dawid', roots: [] });

    // Another start writes the file between the check and the create: its file is kept.
    const raced = join(repo, 'user', 'raced.yml');
    const result = setupUserConfig(
      { me: 'human:second' },
      { OPS_CONFIG: raced },
      {
        beforeCreate: () => writeFileSync(raced, 'me: human:first # theirs\n'),
      },
    );
    expect(result).toMatchObject({ created: false, changed: false, me: 'human:first' });
    expect(readFileSync(raced, 'utf8')).toBe('me: human:first # theirs\n');

    // Only real v2 roots, each stored once, as the repo path.
    const bogus = join(repo, 'bogus');
    mkdirSync(join(bogus, '.agent-ops'), { recursive: true });
    writeFileSync(join(bogus, '.agent-ops', 'config.yml'), 'name: old\n');
    expect(() => setupUserConfig({ me: 'human:x', roots: [bogus] }, unused)).toThrow(
      /not a data root/,
    );
    const fresh = { OPS_CONFIG: join(repo, 'user', 'fresh.yml') } as NodeJS.ProcessEnv;
    const dup = setupUserConfig(
      { me: 'human:x', roots: [repo, join(repo, '.agent-ops'), repo + '/'] },
      fresh,
    );
    expect(dup.roots).toEqual([repo]);
  });
});
