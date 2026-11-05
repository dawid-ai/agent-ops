import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoTop = join(here, '..', '..', '..');
const coreDist = join(repoTop, 'packages', 'core', 'dist', 'index.js');
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'ops-cli-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d, windowsHide: true });
  // CI runners have no git identity; ops sync commits.
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: d, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
    cwd: d,
    windowsHide: true,
  });
  return d;
}

function ops(cwd: string, actor: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { OPS_CONFIG: join(cwd, 'none.yml'), OPS_AGENT: actor } as NodeJS.ProcessEnv;
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('ops', () => {
  it('sets the Master Repo and mirrors a project root into it on sync', () => {
    const proj = repo();
    const hub = repo();
    ops(proj, 'human:dawid', 'init', '--name', 'site', '--prefix', 'WEB');
    ops(hub, 'human:dawid', 'init', '--name', 'hub', '--prefix', 'HUB');
    expect(ops(proj, 'human:dawid', 'master').code).toBe(3);
    expect(ops(proj, 'human:dawid', 'master', hub).out).toMatch(/^Master Repo: /);
    expect(ops(proj, 'human:dawid', 'mirror', 'sideways').code).toBe(2);
    expect(ops(proj, 'human:dawid', 'mirror', 'on').out).toMatch(/^site: mirror on/);
    expect(ops(proj, 'human:dawid', 'mirror', 'on').out).toMatch(/already on/);
    expect(ops(proj, 'human:dawid', 'new', 'pricing page').code).toBe(0);
    const synced = ops(proj, 'human:dawid', 'sync');
    expect(synced.out).toMatch(/site: mirrored with the Master Repo/);
    expect(
      existsSync(join(hub, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001', 'task.md')),
    ).toBe(true);
    // The project root is still the one this machine works in: its copy stays hidden here.
    expect(ops(proj, 'human:dawid', 'roots').out).not.toMatch(/mirrors/);
    expect(ops(proj, 'human:dawid', 'master', '--off').out).toBe('no Master Repo set');
  });

  it('runs a task from creation to done', () => {
    const d = repo();
    expect(ops(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid').code).toBe(0);
    expect(
      ops(d, 'human:dawid', 'new', 'Write', 'docs', '--to', 'claude:writer', '-p', 'p1').out,
    ).toBe('T-0001');
    expect(ops(d, 'claude:writer', 'next').out).toBe('T-0001\tp1\tWrite docs');
    expect(ops(d, 'claude:writer', 'start', '1', 'outline', 'first').out).toBe(
      'T-0001 in-progress (claude:writer)',
    );
    expect(ops(d, 'codex:engineer', 'progress', '1', 'x').code).toBe(1);
    expect(ops(d, 'claude:writer', 'review', '1', 'draft', 'ready').out).toContain('needs-review');
    expect(ops(d, 'human:dawid', 'inbox').out).toContain('review');
    expect(ops(d, 'human:dawid', 'verdict', '1', 'approve').out).toContain('done');
    const shown = ops(d, 'human:dawid', 'show', '1', '--json');
    const parsed = JSON.parse(shown.out) as { task: { status: string }; events: unknown[] };
    expect(parsed.task.status).toBe('done');
    expect(parsed.events).toHaveLength(4);
    expect(ops(d, 'claude:writer', 'next').code).toBe(3);
  });

  it('warns, without refusing, when a message to a person names no task or is a fragment', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    ops(d, 'human:dawid', 'new', 'Pick a database', '--to', 'claude:engineer');
    ops(d, 'human:dawid', 'new', 'Second task', '--to', 'claude:engineer');
    ops(d, 'claude:engineer', 'start', '1', 'compare options');

    const vague = ops(d, 'claude:engineer', 'comment', '1', 'see above', '--to', 'human:dawid');
    expect(vague.code).toBe(0);
    expect(vague.err).toMatch(/note: the message names no task/);
    expect(vague.err).toMatch(/note: the message is shorter than a sentence/);

    // Messages to agents are not checked.
    expect(ops(d, 'claude:engineer', 'comment', '1', 'ok', '--to', 'codex:qa').err).toBe('');

    const clear = ops(
      d,
      'claude:engineer',
      'ask',
      '1',
      'T-0001: Postgres or SQLite for the cache? I recommend SQLite: no server to run.',
    );
    expect(clear.code).toBe(0);
    expect(clear.err).toBe('');

    ops(d, 'human:dawid', 'answer', '1', 'SQLite, as you recommend for T-0001.');
    expect(ops(d, 'human:dawid', 'assign', '2', 'human:dawid', 'mine').err).toMatch(
      /names no task/,
    );

    const shown = ops(d, 'human:dawid', 'show', '1', '--ids').out;
    const [first] = JSON.parse(ops(d, 'human:dawid', 'show', '1', '--json').out).events as Array<{
      id: string;
    }>;
    expect(shown).toContain(`${first!.id}  `);
    expect(ops(d, 'human:dawid', 'show', '1').out).not.toContain(first!.id);
  });

  it('attaches an image and lists its file in show', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--name', 'demo');
    ops(d, 'human:dawid', 'new', 'Fix the header');
    writeFileSync(join(d, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 7]));
    writeFileSync(join(d, 'notes.txt'), 'not an image');
    const att = ops(d, 'human:dawid', 'attach', 'shot.png', '--task', '1', '--alt', 'header');
    expect(att.code).toBe(0);
    const link = att.out;
    expect(link).toMatch(/^!\[header\]\(attachments\/[0-9A-Z]{26}\.png\)$/);
    expect(ops(d, 'human:dawid', 'attach', 'notes.txt').code).toBe(2);
    expect(ops(d, 'human:dawid', 'attach', 'missing.png').code).toBe(2);
    ops(d, 'human:dawid', 'comment', '1', `The logo overlaps: ${link}`);
    const ref = /\((attachments\/[^)]+)\)/.exec(link)![1]!;
    const file = join(d, '.agent-ops', ...ref.split('/'));
    const shown = ops(d, 'human:dawid', 'show', '1');
    expect(shown.out).toContain(`attachments:\n  ${ref}  ${file}`);
    const json = JSON.parse(ops(d, 'human:dawid', 'show', '1', '--json').out) as {
      attachments: Array<{ ref: string; file: string; type: string }>;
    };
    expect(json.attachments).toEqual([{ ref, file, type: 'image/png' }]);
  });

  it('files an agent ops new without an approved parent as a proposal and says so', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--human', 'human:dawid');
    const top = ops(d, 'claude:pm', 'new', 'Rewrite', 'the', 'sync');
    expect(top.code).toBe(0);
    expect(top.out).toBe('T-0001');
    expect(top.err).toMatch(/note: T-0001 is a proposal \(finding\): it has no --parent/);
    expect(ops(d, 'claude:pm', 'show', '1').out).toMatch(/type: finding/);
    ops(d, 'human:dawid', 'new', 'Approved', 'work');
    const sub = ops(d, 'claude:pm', 'new', 'Step', 'one', '--parent', '2');
    expect(sub.out).toBe('T-0003');
    expect(sub.err).toBe('');
    const json = JSON.parse(ops(d, 'claude:pm', 'new', 'Another', '--json').out);
    expect(json).toMatchObject({ id: 'T-0004', type: 'finding', proposed: expect.any(String) });
  });

  it('reports bad input with exit 2', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init');
    expect(ops(d, 'human:dawid', 'nope').code).toBe(2);
    expect(ops(d, 'human:dawid', 'new', 'x', '--bogus').code).toBe(2);
    expect(ops(d, 'human:dawid', 'show', 'T-0042').code).toBe(2);
    expect(ops(d, 'Not An Id', 'list').code).toBe(2);
    expect(ops(d, 'human:dawid', 'list', '--status', 'weird').code).toBe(2);
  });

  it('offers no work to paused or proposed roles and warns when work goes to them', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    const agents = join(d, '.agent-ops', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'claude-writer.md'), '---\nstatus: proposed\n---\n');
    writeFileSync(join(agents, 'codex-qa.md'), '---\nstatus: paused\n---\n');
    // With role files, work goes only to configured agents (AO-0096).
    writeFileSync(join(agents, 'claude-engineer.md'), '---\nstatus: active\n---\n');
    ops(d, 'human:dawid', 'new', 'open');
    ops(d, 'human:dawid', 'new', 'owned', '--to', 'claude:writer');
    expect(ops(d, 'claude:writer', 'next').code).toBe(3);
    expect(ops(d, 'codex:qa', 'next').code).toBe(3);
    expect(ops(d, 'claude:engineer', 'next').out).toMatch(/^T-0001/);

    ops(d, 'claude:engineer', 'start', '1');
    const handed = ops(d, 'claude:engineer', 'handoff', '1', 'claude:writer', 'over to you');
    expect(handed.code).toBe(0);
    expect(handed.err).toMatch(/note: claude:writer is proposed in its role file/);
    const assigned = ops(d, 'human:dawid', 'assign', '1', 'claude:engineer');
    expect(assigned.code).toBe(0);
    expect(assigned.err).toBe('');

    ops(d, 'claude:engineer', 'start', '1');
    const reviewed = ops(d, 'claude:engineer', 'review', '1', 'check', '--to', 'codex:qa');
    expect(reviewed.code).toBe(0);
    expect(reviewed.err).toMatch(/note: codex:qa is paused in its role file/);

    // An agent's own top-level task would be a proposal (AO-0107), so the human files it.
    ops(d, 'human:dawid', 'new', 'more', '--to', 'claude:engineer');
    ops(d, 'claude:engineer', 'start', '3');
    const delegated = ops(
      d,
      'claude:engineer',
      'delegate',
      '3',
      '*:writer',
      '--review',
      'codex:qa',
    );
    expect(delegated.code).toBe(0);
    expect(delegated.err).toMatch(/no active role matches \*:writer \(claude:writer proposed\)/);
    expect(delegated.err).toMatch(/codex:qa is paused/);
  });

  it('prints help for every command', () => {
    const d = repo();
    const all = ops(d, 'human:dawid', 'help');
    for (const c of ['claim', 'handoff', 'inbox', 'sync', 'leaks']) expect(all.out).toContain(c);
    expect(ops(d, 'human:dawid', 'claim', '--help').out).toContain('ops claim ID');
  });
});

describe('two agents on one machine', () => {
  beforeAll(() => {
    if (!existsSync(coreDist)) {
      execFileSync(
        process.execPath,
        [join(repoTop, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'packages/core'],
        {
          cwd: repoTop,
          windowsHide: true,
        },
      );
    }
  });

  it('work a shared queue with no network and never share a task', async () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--human', 'human:dawid');
    const N = 40;
    for (let i = 0; i < N; i++) ops(d, 'human:dawid', 'new', `task ${i}`);

    // Each agent is its own process looping next, claim, start, done, like a real run.
    const worker = `
      const { Workspace, OpsError } = await import(${JSON.stringify(pathToFileURL(coreDist).href)});
      const [cwd, actor] = process.argv.slice(1);
      const env = { OPS_CONFIG: cwd + '/none.yml' };
      const done = [];
      let lost = 0;
      for (;;) {
        const ws = new Workspace({ cwd, env, actor });
        const next = ws.next();
        if (!next) break;
        try { ws.claim(next.meta.id); } catch (e) { if (e instanceof OpsError) { lost++; continue; } throw e; }
        ws.start(next.meta.id);
        ws.done(next.meta.id, 'ok');
        done.push(next.meta.id);
      }
      process.stdout.write(JSON.stringify({ done, lost }));
    `;
    const runAgent = (actor: string) =>
      new Promise<{ done: string[]; lost: number }>((resolve, reject) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', worker, d, actor], {
          windowsHide: true,
        });
        let out = '';
        let err = '';
        p.stdout.on('data', (c: Buffer) => (out += c.toString()));
        p.stderr.on('data', (c: Buffer) => (err += c.toString()));
        p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
      });

    const [a, b] = await Promise.all([runAgent('claude:engineer'), runAgent('codex:engineer')]);
    const all = [...a.done, ...b.done].sort();
    expect(all).toHaveLength(N);
    expect(new Set(all).size).toBe(N);
    const listed = JSON.parse(ops(d, 'human:dawid', 'list', '--all', '--json').out) as Array<{
      status: string;
    }>;
    expect(listed.every((t) => t.status === 'done')).toBe(true);
  }, 60_000);
});

describe('collaboration commands', () => {
  it('delegates, files findings, learns, posts and votes', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    ops(d, 'human:dawid', 'new', 'Port', 'the', 'board');
    const del = ops(
      d,
      'human:dawid',
      'delegate',
      '1',
      'codex:engineer',
      '--budget',
      '2h',
      '--tokens',
      '400k',
      '--review',
      'claude:qa',
    );
    expect(del.out).toBe('T-0001 todo (owner codex:engineer)');
    expect(ops(d, 'human:dawid', 'show', '1').out).toContain(
      'delegated: by human:dawid to codex:engineer (budget 2h, tokens 400000, review claude:qa)',
    );
    expect(
      ops(d, 'codex:engineer', 'finding', 'Board', 'flickers', '--task', '1', '-m', 'web/Board.tsx')
        .out,
    ).toBe('T-0002');
    expect(ops(d, 'codex:engineer', 'show', '1').out).toContain('finding T-0002');
    expect(
      ops(
        d,
        'codex:engineer',
        'learn',
        'ui',
        'Virtualize',
        'long',
        'lists',
        '-m',
        'Use windowing above 500 rows.',
      ).out,
    ).toBe('ui/virtualize-long-lists');
    expect(ops(d, 'codex:engineer', 'learn', 'ui', 'No', 'body').code).toBe(2);
    expect(ops(d, 'claude:qa', 'kb', 'windowing').out).toContain('ui/virtualize-long-lists');
    expect(ops(d, 'claude:qa', 'kb', 'nothing').code).toBe(3);
    expect(ops(d, 'claude:qa', 'kb', '--read', 'ui/virtualize-long-lists').out).toContain(
      '500 rows',
    );
    expect(
      ops(d, 'claude:qa', 'channel', 'post', 'dev', 'ready', 'for', '@codex:engineer').code,
    ).toBe(0);
    expect(ops(d, 'codex:engineer', 'inbox').out).toContain('mention  #dev');
    expect(ops(d, 'codex:engineer', 'channel', 'read', 'dev').out).toContain(
      'ready for @codex:engineer',
    );
    expect(ops(d, 'codex:engineer', 'channel', 'list').out).toMatch(/^#dev\s+1/);
    expect(
      ops(
        d,
        'claude:orchestrator',
        'propose',
        'Shell?',
        '--option',
        'Electron',
        '--option',
        'Tauri',
        '--voters',
        'claude:qa,codex:engineer',
      ).out,
    ).toBe('D-0001');
    expect(ops(d, 'claude:qa', 'vote', 'D-1', 'Electron', 'reuse web UI').code).toBe(0);
    ops(d, 'codex:engineer', 'vote', 'D-1', '2');
    expect(ops(d, 'claude:orchestrator', 'tally', 'D-1').out).toContain('state:    tie');
    expect(ops(d, 'claude:orchestrator', 'decide', 'D-1', 'Electron').code).toBe(1);
    expect(ops(d, 'human:dawid', 'decisions').out).toContain('D-0001   tie');
    expect(ops(d, 'human:dawid', 'decide', 'D-1', 'Electron').out).toContain('decided: Electron');
    ops(d, 'human:dawid', 'done', '2');
    expect(ops(d, 'human:dawid', 'archive', '--days', '0').out).toBe('archived T-0002');
    expect(ops(d, 'human:dawid', 'list', '--all', '--json').out).toContain('"archived": true');
  });
});

describe('agent ids nothing defines', () => {
  it('refuses them as owner or reviewer, warns on unmatched wildcards, and flags stranded work', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    // One agent from a role file, one from the opsd config: either source defines an agent.
    writeFileSync(
      join(d, '.agent-ops', 'agents', 'claude-engineer.md'),
      '---\nid: claude:engineer\n---\n',
    );
    writeFileSync(join(d, 'none.yml'), "opsd:\n  agents:\n    'codex:qa': { wake: true }\n");
    // The test's user config is no change of the checkout, which `ops review` would refuse.
    writeFileSync(join(d, '.git', 'info', 'exclude'), 'none.yml\n');

    ops(d, 'human:dawid', 'new', 'Fix', 'login', '--to', 'claude:engineer');
    ops(d, 'claude:engineer', 'start', '1', 'plan');

    const bad = ops(d, 'claude:engineer', 'review', '1', 'ready', '--to', 'codex:backend');
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/reviewer codex:backend is not a configured agent/);
    expect(bad.err).toContain('configured agents: claude:engineer, codex:qa');
    expect(ops(d, 'claude:engineer', 'handoff', '1', 'claude:release', 'x').code).toBe(1);
    expect(ops(d, 'claude:engineer', 'delegate', '1', 'claude:docs').code).toBe(1);
    expect(
      ops(d, 'claude:engineer', 'delegate', '1', 'claude:engineer', '--review', 'codex:backend')
        .code,
    ).toBe(1);
    expect(ops(d, 'human:dawid', 'new', 'Docs', '--to', 'claude:docs').code).toBe(1);
    expect(ops(d, 'human:dawid', 'show', '1').out).toContain('status:   in-progress');

    // A defined agent from the opsd config passes.
    expect(ops(d, 'claude:engineer', 'review', '1', 'ready', '--to', 'codex:qa').out).toContain(
      'needs-review',
    );

    // A role group needs a waking agent (AO-0140): claude:engineer is defined but does not wake.
    const asleep = ops(d, 'human:dawid', 'new', 'Any', 'engineer', '--to', '*:engineer');
    expect(asleep.code).toBe(1);
    expect(asleep.err).toMatch(/owner \*:engineer matches no waking agent, so no run picks it up/);
    expect(asleep.err).toContain(
      'use a role group (*:qa), or a configured agent (claude:engineer, codex:qa), or human:dawid',
    );
    writeFileSync(
      join(d, 'none.yml'),
      "opsd:\n  agents:\n    'codex:qa': { wake: true }\n    'claude:engineer': { wake: true }\n",
    );
    // A role group with a waking agent passes quietly; one with none is refused, as is assign.
    const ok = ops(d, 'human:dawid', 'new', 'Any', 'engineer', '--to', '*:engineer');
    expect(ok.code).toBe(0);
    expect(ok.err).toBe('');
    const orphan = ops(d, 'human:dawid', 'new', 'Orchestrate', '--to', '*:orchestrator');
    expect(orphan.code).toBe(1);
    expect(orphan.err).toMatch(/owner \*:orchestrator matches no waking agent/);
    expect(orphan.err).toContain('*:engineer, *:qa');
    const reassign = ops(d, 'human:dawid', 'assign', ok.out, '*:orchestrator');
    expect(reassign.code).toBe(1);
    expect(reassign.err).toMatch(/owner \*:orchestrator matches no waking agent/);
    expect(ops(d, 'human:dawid', 'assign', ok.out, 'claude:release').code).toBe(1);
    expect(ops(d, 'human:dawid', 'assign', ok.out, '*:qa').code).toBe(0);
    const forcedGroup = ops(
      d,
      'human:dawid',
      'new',
      'Orchestrate',
      '--to',
      '*:orchestrator',
      '--force',
    );
    expect(forcedGroup.code).toBe(0);
    expect(forcedGroup.err).toMatch(/warning: \*:orchestrator matches no configured agent/);
    const post = ops(d, 'human:dawid', 'channel', 'post', 'general', 'hi', '@*:orchestrator');
    expect(post.code).toBe(0);
    expect(post.err).toMatch(/warning: \*:orchestrator matches no configured agent/);
    const role = ops(d, 'human:dawid', 'channel', 'post', 'general', 'ping', '@*:engineer');
    expect(role.err).toBe('');
    expect(ops(d, 'claude:engineer', 'inbox').out).toContain('mention  #general');

    // --force still hands work to an undefined id; the human hears that it is stranded.
    const forced = ops(d, 'human:dawid', 'new', 'Release', '--to', 'claude:release', '--force');
    expect(forced.out).toBe('T-0004');
    const inbox = ops(d, 'human:dawid', 'inbox').out;
    expect(inbox).toMatch(/stranded\s+T-0004/);
    expect(inbox).toContain('owner claude:release is not a configured agent');
    expect(inbox).toMatch(/stranded\s+T-0003/);
    expect(inbox).not.toMatch(/stranded\s+T-000[12]/);
  });
});

describe('supervisor commands without opsd', () => {
  it('reports that opsd is not running', async () => {
    const d = repo();
    const state = join(d, 'state');
    const out: string[] = [];
    const err: string[] = [];
    const env = { OPS_CONFIG: join(d, 'none.yml'), OPS_STATE_DIR: state } as NodeJS.ProcessEnv;
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env, cwd: d };
    expect(await run(['daemon', 'status'], io)).toBe(3);
    expect(out.pop()).toBe('opsd is not running');
    expect(await run(['runs'], io)).toBe(0);
    expect(out.pop()).toBe('no live runs');
    expect(await run(['launch', 'claude:qa'], io)).toBe(2);
    expect(err.pop()).toContain('opsd is not running');
    expect(await run(['logs', 'NOPE'], io)).toBe(2);
    expect(await run(['daemon', 'start', '--port', 'x'], io)).toBe(2);
  });

  it('pauses and resumes opsd in the config while it is down', async () => {
    const d = repo();
    const out: string[] = [];
    const cfg = join(d, 'config.yml');
    const env = { OPS_CONFIG: cfg, OPS_STATE_DIR: join(d, 'state') } as NodeJS.ProcessEnv;
    const io = { out: (l: string) => out.push(l), err: () => {}, env, cwd: d };
    expect(await run(['daemon', 'pause'], io)).toBe(0);
    expect(out.pop()).toMatch(/opsd paused/);
    expect(readFileSync(cfg, 'utf8')).toMatch(/paused: true/);
    expect(await run(['daemon', 'status'], io)).toBe(3);
    expect(out.pop()).toBe('opsd is not running (paused: it starts paused)');
    expect(await run(['daemon', 'resume'], io)).toBe(0);
    expect(readFileSync(cfg, 'utf8')).not.toMatch(/paused/);
    expect(await run(['daemon', 'status'], io)).toBe(3);
    expect(out.pop()).toBe('opsd is not running');
    expect(await run(['daemon', 'nap'], io)).toBe(2);
  });
});

describe('several roots', () => {
  it('scopes next, next --all and list to --root', () => {
    const alpha = repo();
    const beta = repo();
    const out: string[] = [];
    const env = {
      OPS_CONFIG: join(alpha, 'none.yml'),
      OPS_AGENT: 'claude:engineer',
      OPS_ROOTS: beta,
    } as NodeJS.ProcessEnv;
    const io = { out: (l: string) => out.push(l), err: () => {}, env, cwd: alpha };
    run(['init', '--name', 'alpha', '--human', 'human:dawid'], io);
    run(['init', '--name', 'beta', '--prefix', 'B', '--human', 'human:dawid'], {
      ...io,
      cwd: beta,
    });
    run(['new', 'alpha work', '--priority', 'p0'], {
      ...io,
      env: { ...env, OPS_AGENT: 'human:dawid' },
    });
    run(['new', 'beta work', '--root', 'beta'], {
      ...io,
      env: { ...env, OPS_AGENT: 'human:dawid' },
    });

    out.length = 0;
    expect(run(['next', '--root', 'beta'], io)).toBe(0);
    expect(out).toEqual(['B-0001\tp2\tbeta work']);

    for (const args of [
      ['next', '--all', '--root', 'beta'],
      ['list', '--root', 'beta'],
    ]) {
      out.length = 0;
      expect(run(args, io)).toBe(0);
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('beta/B-0001');
      expect(out[0]).toContain('beta work');
    }

    const human = { ...io, env: { ...env, OPS_AGENT: 'human:dawid' } };
    expect(run(['block', 'beta/B-0001', 'wait', '--on', 'alpha/T-0001'], human)).toBe(0);
    expect(run(['done', 'alpha/T-0001'], human)).toBe(0);
    out.length = 0;
    expect(run(['next', '--root', 'beta'], io)).toBe(0);
    expect(out).toEqual(['B-0001\tp2\tbeta work']);
  });

  it('lists tasks as root/id so equal ids stay apart', () => {
    const alpha = repo();
    const beta = repo();
    const out: string[] = [];
    const env = {
      OPS_CONFIG: join(alpha, 'none.yml'),
      OPS_AGENT: 'human:dawid',
      OPS_ROOTS: beta,
    } as NodeJS.ProcessEnv;
    const io = (cwd: string) => ({ out: (l: string) => out.push(l), err: () => {}, env, cwd });
    run(['init', '--name', 'alpha', '--human', 'human:dawid'], io(alpha));
    run(['init', '--name', 'beta', '--human', 'human:dawid'], io(beta));
    run(['new', 'in alpha'], io(alpha));
    run(['new', 'in beta', '--root', 'beta'], io(alpha));
    out.length = 0;
    expect(run(['list'], io(alpha))).toBe(0);
    expect(out.map((l) => l.split(/\s+/)[0]).sort()).toEqual(['alpha/T-0001', 'beta/T-0001']);
  });

  it('prints inbox items as root/id, and the printed ref answers the right task', () => {
    const alpha = repo();
    const beta = repo();
    const out: string[] = [];
    const io = (cwd: string, agent: string) => ({
      out: (l: string) => out.push(l),
      err: () => {},
      env: {
        OPS_CONFIG: join(alpha, 'none.yml'),
        OPS_AGENT: agent,
        OPS_ROOTS: beta,
      } as NodeJS.ProcessEnv,
      cwd,
    });
    const human = (args: string[]) => run(args, io(alpha, 'human:dawid'));
    const eng = (args: string[]) => run(args, io(alpha, 'claude:engineer'));
    human(['init', '--name', 'alpha', '--human', 'human:dawid']);
    run(['init', '--name', 'beta', '--human', 'human:dawid'], io(beta, 'human:dawid'));
    human(['new', 'in alpha', '--to', 'claude:engineer']);
    human(['new', 'in beta', '--to', 'claude:engineer', '--root', 'beta']);
    for (const ref of ['alpha/T-0001', 'beta/T-0001']) {
      expect(eng(['start', ref, 'plan'])).toBe(0);
      expect(eng(['ask', ref, `question on ${ref}`])).toBe(0);
    }
    out.length = 0;
    expect(human(['inbox'])).toBe(0);
    const asks = out.filter((l) => l.startsWith('ask'));
    expect(asks.map((l) => l.split(/\s+/)[1]).sort()).toEqual(['alpha/T-0001', 'beta/T-0001']);

    out.length = 0;
    expect(human(['inbox', '--json'])).toBe(0);
    const items = JSON.parse(out.join('\n')) as Array<{ kind: string; task: string; root: string }>;
    const betaAsk = items.find((i) => i.kind === 'ask' && i.root === 'beta')!;
    expect(betaAsk.task).toBe('beta/T-0001');
    expect(human(['answer', betaAsk.task, 'yes'])).toBe(0);
    out.length = 0;
    human(['inbox']);
    expect(out.filter((l) => l.startsWith('ask')).map((l) => l.split(/\s+/)[1])).toEqual([
      'alpha/T-0001',
    ]);
  });
});

describe('setup', () => {
  it('writes the user config from flags, suggesting the root it runs in', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--name', 'site');
    const file = join(d, 'user.yml');
    const out: string[] = [];
    const env = { OPS_CONFIG: file } as NodeJS.ProcessEnv;
    const code = run(['setup', '--me', 'human:dawid'], {
      out: (l) => out.push(l),
      err: () => {},
      env,
      cwd: d,
    });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^wrote .*user\.yml: me human:dawid, roots /);
    // The default providers and agents are seeded into the file; with no CLI on this PATH, the
    // agents of every default provider.
    expect(out[1]).toBe('providers: claude, codex');
    expect(out[2]).toMatch(/^agents: claude:engineer, claude:qa, .*codex:pm$/);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('me: human:dawid');
    expect(text).toContain('seeded: 1');
    expect(text).toMatch(/codex:\s+command: codex/);
    expect(text).toContain('claude:reviewer: {}');
  });
});

describe('init --user', () => {
  it('writes the user config like ops setup, and never touches an existing me', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--name', 'site');
    const file = join(d, 'user.yml');
    const env = { OPS_CONFIG: file } as NodeJS.ProcessEnv;
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: () => {}, env, cwd: d };
    expect(run(['init', '--user', '--me', 'human:dawid', '--root', d], io)).toBe(0);
    expect(out[0]).toMatch(/^wrote .*user\.yml: me human:dawid, roots /);
    const first = out.length;
    expect(run(['init', '--user', '--me', 'human:other'], io)).toBe(0);
    // Seeded once: the second run writes no providers or agents.
    expect(out.slice(first)).toEqual([expect.stringMatching(/^kept .*: me human:dawid/)]);
    expect(readFileSync(file, 'utf8')).not.toContain('human:other');
  });
});

describe('a role file that does not parse', () => {
  it('is skipped with a warning; ops agents and ops next keep working', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    const agents = join(d, '.agent-ops', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, 'codex-qa.md'),
      '---\nid: codex:qa\nstatus: active\ncan_claim: [bug]\n---\n',
    );
    // An unquoted `: ` inside a value is a YAML error (BLOCK_AS_IMPLICIT_KEY).
    writeFileSync(
      join(agents, 'claude-writer.md'),
      '---\nid: claude:writer\ndescription: Writes docs: carefully\n---\n',
    );

    const listed = ops(d, 'human:dawid', 'agents');
    expect(listed.code).toBe(0);
    expect(listed.out).toMatch(/^codex:qa\s+active\s+bug$/m);
    expect(listed.out).not.toContain('claude:writer');
    expect(listed.err).toMatch(/^warning: skipped .*claude-writer\.md: /m);
    const json = ops(d, 'human:dawid', 'agents', '--json');
    expect((JSON.parse(json.out) as { id: string }[]).map((a) => a.id)).toEqual(['codex:qa']);

    ops(d, 'human:dawid', 'new', 'Fix login', '--type', 'bug');
    expect(ops(d, 'codex:qa', 'next').out).toMatch(/^T-0001\t/);
    expect(ops(d, 'claude:writer', 'next').out).toMatch(/^T-0001\t/);
  });
});

describe('a review request for code left uncommitted (AO-0136)', () => {
  function started(type?: string) {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    const args = ['new', 'Fix login', '--to', 'claude:engineer'];
    ops(d, 'human:dawid', ...args, ...(type ? ['--type', type] : []));
    ops(d, 'claude:engineer', 'start', '1', 'plan');
    return d;
  }

  it('is refused while the checkout has changes outside the task store', () => {
    const d = started('bug');
    // Task store files alone are no change of the checkout.
    expect(
      ops(d, 'claude:engineer', 'review', '1', 'fixed', '--to', 'codex:qa', '--json').code,
    ).toBe(0);
    ops(d, 'human:dawid', 'verdict', '1', 'changes', 'more');
    ops(d, 'claude:engineer', 'start', '1', 'again');
    writeFileSync(join(d, 'login.ts'), 'export {};\n');
    const refused = ops(d, 'claude:engineer', 'review', '1', 'fixed, in the checkout');
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(
      /T-0001 is a bug and .+ has uncommitted changes \(login\.ts\): commit them on a task branch/,
    );
    expect(ops(d, 'human:dawid', 'show', '1').out).toMatch(/status:\s+in-progress/);
  });

  it('goes out when it names a commit and branch or a PR, for other types, or forced', () => {
    for (const msg of [
      'a1b2c3d on branch claude/t-0001-login: fixed, tests pass',
      'PR: https://github.com/o/r/pull/12',
    ]) {
      const d = started();
      writeFileSync(join(d, 'login.ts'), 'export {};\n');
      expect(ops(d, 'claude:engineer', 'review', '1', msg).code).toBe(0);
    }
    const doc = started('doc');
    writeFileSync(join(doc, 'notes.md'), 'draft\n');
    expect(ops(doc, 'claude:engineer', 'review', '1', 'draft is ready').code).toBe(0);
    const forced = started();
    writeFileSync(join(forced, 'login.ts'), 'export {};\n');
    expect(ops(forced, 'claude:engineer', 'review', '1', 'look', '--force').code).toBe(0);
  });

  it('goes out from an opsd run that commits what it leaves, and not from one that does not', () => {
    const state = mkdtempSync(join(tmpdir(), 'ops-state-'));
    dirs.push(state);
    mkdirSync(join(state, 'runs'));
    const record = (id: string, base?: string) =>
      writeFileSync(join(state, 'runs', `${id}.json`), JSON.stringify({ id, base }));
    record('RUNWITHBASE', 'a'.repeat(40));
    record('RUNNOBASE');
    const review = (cwd: string, runId: string) => {
      const env = {
        OPS_CONFIG: join(cwd, 'none.yml'),
        OPS_AGENT: 'claude:engineer',
        OPS_RUN: runId,
        OPS_RUN_STATE_DIR: state,
      } as NodeJS.ProcessEnv;
      const quiet = () => {};
      return run(['review', '1', 'files in the checkout'], { out: quiet, err: quiet, env, cwd });
    };
    const without = started();
    writeFileSync(join(without, 'login.ts'), 'export {};\n');
    expect(review(without, 'RUNNOBASE')).toBe(1);
    const withBase = started();
    writeFileSync(join(withBase, 'login.ts'), 'export {};\n');
    expect(review(withBase, 'RUNWITHBASE')).toBe(0);
  });
});

describe('ops repeat (AO-0142)', () => {
  it('adds, edits, pauses, runs and deletes a repeating task', () => {
    const d = repo();
    ops(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    const add = ops(
      d,
      'human:dawid',
      'repeat',
      'add',
      'standup',
      '--title',
      'Standup {date}',
      '--start',
      '2020-01-06 09:00',
      '--every',
      'weekdays',
      '--days',
      'mon,thu',
      '--owner',
      'claude:engineer',
      '--force',
      '-m',
      'Post the plan.',
    );
    expect(add.err).toBe('');
    expect(add.out).toMatch(/^standup\s+active\s+on mon, thu at 09:00 from 2020-01-06/);
    expect(ops(d, 'claude:engineer', 'repeat', 'pause', 'standup').code).toBe(1);
    expect(ops(d, 'human:dawid', 'repeat', 'pause', 'standup').out).toMatch(/paused/);
    expect(ops(d, 'human:dawid', 'repeat', 'tick').out).toBe('nothing due');
    expect(ops(d, 'human:dawid', 'repeat', 'resume', 'standup').out).toMatch(/active/);
    // Slots passed since 2020: one task for the latest.
    const tick = ops(d, 'human:dawid', 'repeat', 'tick');
    expect(tick.out).toMatch(/^standup: created T-0001 for \d{4}-\d{2}-\d{2}T09:00$/);
    expect(ops(d, 'human:dawid', 'repeat', 'tick').out).toBe('nothing due');
    const edit = ops(d, 'human:dawid', 'repeat', 'edit', 'standup', '--every', 'daily');
    expect(edit.code).toBe(2);
    expect(edit.err).toMatch(/--days goes with the weekdays rule only/);
    const edited = ops(d, 'human:dawid', 'repeat', 'edit', 'standup', '--when', 'closed T-0001');
    expect(edited.out).toMatch(/when closed T-0001/);
    const show = ops(d, 'human:dawid', 'repeat', 'show', 'standup');
    expect(show.out).toMatch(/fired:\s+1\s+last: T-0001 \(todo\)/);
    expect(show.out).toMatch(/Post the plan\./);
    expect(ops(d, 'human:dawid', 'repeat', 'run', 'standup').out).toBe('created T-0002');
    expect(ops(d, 'human:dawid', 'repeat', 'delete', 'standup').out).toMatch(/deleted/);
    expect(ops(d, 'human:dawid', 'repeat', 'list').out).toBe('no repeats');
    expect(ops(d, 'human:dawid', 'show', 'T-0002').code).toBe(0);
  });

  it('lists a name two roots share as root/name, and that ref targets one repeat', () => {
    const alpha = repo();
    const beta = repo();
    const env = {
      OPS_CONFIG: join(alpha, 'none.yml'),
      OPS_AGENT: 'human:dawid',
      OPS_ROOTS: beta,
    } as NodeJS.ProcessEnv;
    const cli = (cwd: string, ...argv: string[]) => {
      const out: string[] = [];
      const code = run(argv, { out: (l) => out.push(l), err: () => {}, env, cwd });
      return { code, out };
    };
    cli(alpha, 'init', '--name', 'alpha', '--human', 'human:dawid');
    cli(beta, 'init', '--name', 'beta', '--human', 'human:dawid');
    const same = ['--title', 'Report', '--start', '2099-01-05 09:00', '--every', 'weekly'];
    expect(cli(alpha, 'repeat', 'add', 'alpha/report', ...same).code).toBe(0);
    expect(cli(alpha, 'repeat', 'add', 'beta/report', ...same).code).toBe(0);
    expect(cli(alpha, 'repeat', 'add', 'standup', ...same).code).toBe(0);
    const list = cli(alpha, 'repeat', 'list');
    expect(list.out.map((l) => l.split(/\s+/)[0])).toEqual([
      'alpha/report',
      'beta/report',
      'standup',
    ]);
    const paused = cli(alpha, 'repeat', 'pause', list.out[1]!.split(/\s+/)[0]!);
    expect(paused.out[0]).toMatch(/^beta\/report\s+paused/);
    const after = cli(alpha, 'repeat', 'list').out;
    expect(after[0]).toMatch(/^alpha\/report\s+active/);
    expect(after[1]).toMatch(/^beta\/report\s+paused/);
  });
});
