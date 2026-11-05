import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRoot, mirrorPair, Root, samePath, syncRoot, Workspace } from '@agent-ops/core';
import type { ProcLister, ProcTarget, RunRecord } from '../src/index.js';
import {
  daemonCall,
  processStartSync,
  invocation,
  isAlive,
  opsdConfig,
  questionPrompt,
  readDaemon,
  runDaemon,
  runPrompt,
  scheduleDue,
  startApi,
  startMs,
  startDaemon,
  stopDaemon,
  Supervisor,
  SyncLog,
  systemLister,
  UsageMeter,
  withStoreCheckoutRule,
} from '../src/index.js';
import { Checkout } from '../src/checkout.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoTop = join(here, '..', '..', '..');
const coreDist = join(repoTop, 'packages', 'core', 'dist', 'index.js');
const dirs: string[] = [];
const sups: Supervisor[] = [];

beforeAll(() => {
  // The fake agent is a separate process, so it needs the built core.
  execFileSync(
    process.execPath,
    [join(repoTop, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'packages/core'],
    { cwd: repoTop, windowsHide: true },
  );
});

afterEach(async () => {
  for (const s of sups.splice(0)) {
    s.stop({ killRuns: true });
    await s.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-test-'));
  dirs.push(d);
  return d;
}

/** A fake runtime: reads the prompt, reports token use, then finishes, crashes or hangs. */
const FAKE_AGENT = `
const { Workspace } = await import(${JSON.stringify(pathToFileURL(coreDist).href)});
// Before stdin: proves the process started, whether or not it ever gets a prompt.
if (process.env.FAKE_MARK) (await import('node:fs')).writeFileSync(process.env.FAKE_MARK, String(process.ppid));
if (process.env.FAKE_PID) (await import('node:fs')).writeFileSync(process.env.FAKE_PID, String(process.pid));
let prompt = '';
for await (const c of process.stdin) prompt += c;
if (process.env.FAKE_PROMPT) (await import('node:fs')).writeFileSync(process.env.FAKE_PROMPT, prompt);
const mode = process.env.FAKE_MODE ?? 'done';
const task = /Work on (\\S+):/.exec(prompt)?.[1];
const ws = new Workspace({ cwd: process.cwd(), env: process.env });
console.log(JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 50 } } }));
if (task) ws.start(task, 'fake plan');
if (mode === 'done') { if (task) ws.done(task, 'fake done'); }
else if (mode === 'crash') process.exit(3);
else if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'big') {
  const filler = 'x'.repeat(1023) + '\\n';
  for (let i = 0; i < 5 * 1024; i++) process.stdout.write(filler);
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'm2', usage: { input_tokens: 1000, output_tokens: 1 } } }));
}
else if (mode === 'orphan') {
  // Starts B, which starts C and exits; C lives on until something kills it.
  const { spawn } = await import('node:child_process');
  spawn(process.execPath, [process.env.FAKE_B], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LINGER ?? 4000)));
}
else if (mode === 'limited') {
  const resetsAt = Number(process.env.FAKE_RESET);
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt, rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.95, resetsAt, status: 'allowed_warning' } } } }));
}
else if (mode === 'hit') {
  console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|' + process.env.FAKE_RESET }));
}
else if (mode === 'hit-codex') {
  console.log(JSON.stringify({ type: 'error', message: "You've hit your usage limit." }));
}
else if (mode === 'hit-both') {
  const resetsAt = Number(process.env.FAKE_RESET);
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } }));
  console.log(JSON.stringify({ type: 'error', message: "You've hit your usage limit." }));
}
else if ((mode === 'edit-wait' || mode === 'edit-move') && process.env.OPS_PARENT_RUN) {
  // A helper: writes in the checkout until it is killed.
  const fs = await import('node:fs');
  for (let i = 0; ; i++) {
    fs.writeFileSync(process.env.FAKE_HELPER_GO ?? 'helper.txt', String(i) + '\\n');
    await new Promise((r) => setTimeout(r, 50));
  }
}
else if (mode === 'edit' || mode === 'edit-review' || mode === 'edit-wait' || mode === 'edit-move') {
  // A sandboxed run: changes files, cannot commit them.
  const fs = await import('node:fs');
  fs.writeFileSync('tracked.txt', 'changed by the run\\n');
  fs.rmSync('gone.txt');
  fs.mkdirSync('src/new', { recursive: true });
  fs.writeFileSync('src/new/added.txt', 'new\\n');
  if (mode === 'edit-review' && task) ws.review(task, 'changed files are in the checkout');
  if (mode === 'edit-wait') {
    while (!fs.existsSync(process.env.FAKE_GO)) await new Promise((r) => setTimeout(r, 50));
  }
  if (mode === 'edit-move') {
    // Moves HEAD, then leaves a change on top of it.
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['commit', '-qam', 'run commit'], { windowsHide: true });
    fs.writeFileSync('tracked.txt', 'changed after the move\\n');
  }
}
else if (mode === 'commit') {
  const fs = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  fs.writeFileSync('tracked.txt', 'committed by the run\\n');
  execFileSync('git', ['commit', '-qam', 'run commit'], { windowsHide: true });
  if (task) ws.done(task, 'committed');
}
else if (mode === 'tail') process.stdout.write(JSON.stringify({ type: 'result', usage: { input_tokens: 1000, output_tokens: 1 } }));
`;

function setup(
  opts: {
    mode?: string;
    opsd?: Record<string, unknown>;
    now?: () => number;
    env?: Record<string, string>;
    freeMem?: () => number;
    procs?: ProcLister;
    runsOutlive?: boolean;
    /** The task repo's folder, under a `temp()` folder; a new temp folder by default. */
    repo?: string;
  } = {},
) {
  const repo = opts.repo ?? temp();
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const agentFile = join(temp(), 'fake-agent.mjs');
  writeFileSync(agentFile, FAKE_AGENT);
  const state = temp();
  const env = {
    ...process.env,
    OPS_CONFIG: join(repo, 'none.yml'),
    OPS_STATE_DIR: state,
    FAKE_MODE: opts.mode ?? 'done',
    ...(opts.env ?? {}),
  } as NodeJS.ProcessEnv;
  delete env.OPS_AGENT;
  delete env.OPS_ROOTS;
  const config = opsdConfig({
    opsd: {
      sync: false,
      // The default follows the CPU count; tests that start several runs need the same room on
      // a 4-core CI runner as on a workstation.
      max_runs: 16,
      ...(opts.opsd ?? {}),
      runtimes: {
        fake: { command: process.execPath, args: [agentFile] },
        ...((opts.opsd?.runtimes as object | undefined) ?? {}),
      },
    },
  });
  /** An opsd on the same state, like the one a restart starts. */
  const opsd = (procs = opts.procs): Supervisor => {
    const s = new Supervisor({
      env,
      cwd: repo,
      user: {},
      config,
      now: opts.now,
      freeMem: opts.freeMem ?? (() => 64 * 2 ** 30),
      procs,
      runsOutlive: opts.runsOutlive,
    });
    sups.push(s);
    return s;
  };
  const sup = opsd();
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {}, now: opts.now });
  return { repo, sup, as, state, opsd };
}

function ended(sup: Supervisor, id: string, ms = 15_000): Promise<RunRecord> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`run ${id} did not end`)), ms);
    const check = (r: RunRecord): void => {
      if (r.id !== id || r.status !== 'ended') return;
      clearTimeout(timer);
      sup.off('run', check);
      resolve(r);
    };
    sup.on('run', check);
  });
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('runs', () => {
  it('claims, runs the agent to the end and records the run on the task', async () => {
    const { sup, as } = setup();
    as('human:dawid').newTask({ title: 'fake work', owner: 'fake:engineer' });
    const run = sup.launch({ agent: 'fake:engineer', task: 'T-0001' });
    expect(as('human:dawid').view('1').claimedBy).toBe('fake:engineer');
    expect(() => sup.launch({ agent: 'fake:engineer' })).toThrow(
      /1 engineer run\(s\) live on test; per_project is 1/,
    );
    expect(() => sup.launch({ agent: 'fake:engineer', task: 'T-0001' })).toThrow(
      /T-0001 already has a live run/,
    );
    const r = await ended(sup, run.id);
    expect(r).toMatchObject({ exit: 0, reason: 'exit', tokens: 150 });
    const v = as('human:dawid').view('1');
    expect(v.status).toBe('done');
    const types = as('human:dawid')
      .showEvents('1')
      .events.map((e) => e.type);
    expect(types).toEqual(['claim', 'run-start', 'start', 'done', 'run-end']);
    expect(readFileSync(r.log, 'utf8')).toContain('"output_tokens":50');
    expect(sup.runs()[0]!.id).toBe(run.id);
  });

  it('frees the task when the run ends without finishing', async () => {
    const { sup, as } = setup({ mode: 'crash' });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    const r = await ended(sup, sup.launch({ agent: 'fake:engineer', task: '1' }).id);
    expect(r).toMatchObject({ exit: 3, reason: 'exit' });
    const { events } = as('human:dawid').showEvents('1');
    expect(events.at(-1)).toMatchObject({ type: 'release', actor: 'fake:engineer' });
    expect(events.at(-2)).toMatchObject({ type: 'run-end', exit: 3 });
    expect(as('human:dawid').view('1').status).toBe('todo');
  });

  it('kills a run over its time or token budget, and only its own tree', async () => {
    let now = Date.now();
    const { sup, as } = setup({ mode: 'hang', now: () => now });
    as('human:dawid').newTask({ title: 'slow', owner: 'fake:engineer' });
    as('human:dawid').newTask({ title: 'hungry', owner: 'fake:qa' });
    const slow = sup.launch({ agent: 'fake:engineer', task: '1', budget: '5m' });
    const hungry = sup.launch({ agent: 'fake:qa', task: '2', tokens: '100' });
    await until(() => readFileSync(hungry.log, 'utf8').includes('usage'));
    await until(() => as('human:dawid').view('2').status === 'in-progress');
    await sup.tick();
    const h = await ended(sup, hungry.id);
    expect(h).toMatchObject({ reason: 'tokens', exit: null, tokens: 150 });
    expect(sup.run(slow.id).status).toBe('running');
    now += 6 * 60_000;
    await sup.tick();
    const s = await ended(sup, slow.id);
    expect(s.reason).toBe('budget');
    expect(as('human:dawid').view('1').status).toBe('todo');
  });

  it('renews the lease while the run lives', async () => {
    let now = Date.now();
    const { sup, as } = setup({ mode: 'hang', now: () => now });
    as('human:dawid').newTask({ title: 'long', owner: 'fake:engineer' });
    const run = sup.launch({ agent: 'fake:engineer', task: '1', budget: '10h' });
    await until(() => as('human:dawid').view('1').status === 'in-progress');
    await sup.tick();
    expect(
      as('human:dawid')
        .showEvents('1')
        .events.some((e) => e.type === 'renew'),
    ).toBe(false);
    now += 150 * 60_000;
    await sup.tick();
    const renew = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'renew');
    expect(renew).toMatchObject({ actor: 'fake:engineer', run: run.id });
    expect(Date.parse(as('human:dawid').view('1').leaseUntil!)).toBeGreaterThan(now + 3 * 3600_000);
    sup.kill(run.id);
    expect((await ended(sup, run.id)).reason).toBe('killed');
  });

  it('wakes an agent that has a task, and runs schedules', async () => {
    const { sup, as } = setup({
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        schedules: [{ name: 'digest', every: '24h', agent: 'fake:writer', prompt: 'Write it.' }],
      },
    });
    await sup.tick();
    const first = sup.runs();
    expect(first.map((r) => [r.agent, r.schedule])).toEqual([['fake:writer', 'digest']]);
    await ended(sup, first[0]!.id);
    as('human:dawid').newTask({ title: 'for the engineer', owner: 'fake:engineer' });
    await sup.tick();
    const woke = sup.runs({ live: true });
    expect(woke.map((r) => [r.agent, r.task])).toEqual([['fake:engineer', 'T-0001']]);
    await ended(sup, woke[0]!.id);
    expect(as('human:dawid').view('1').status).toBe('done');
    // The schedule does not run again within its interval.
    await sup.tick();
    expect(sup.runs().filter((r) => r.schedule === 'digest')).toHaveLength(1);
  });

  it('marks runs lost when their process is gone or the PID runs something else', () => {
    const { sup, state } = setup();
    const dead = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    const base = {
      agent: 'fake:engineer',
      command: 'x',
      cwd: state,
      log: join(state, 'none.log'),
      started_at: new Date().toISOString(),
      status: 'running' as const,
      budget_minutes: 60,
      tokens: 0,
    };
    sup.store.save({ ...base, id: '01AAAAAAAAAAAAAAAAAAAAAAA1', pid: 999_999, image: 'node.exe' });
    sup.store.save({
      ...base,
      id: '01AAAAAAAAAAAAAAAAAAAAAAA2',
      agent: 'fake:qa',
      pid: process.pid,
      image: 'not-node.exe',
    });
    sup.adopt();
    expect(sup.runs({ live: true })).toEqual([]);
    expect(sup.runs().map((r) => r.reason)).toEqual(['lost', 'lost']);
    dead.kill();
  });

  it('checks launches', () => {
    const { sup, as } = setup({ opsd: { max_runs: 0 } });
    as('human:dawid').newTask({ title: 'x' });
    expect(() => sup.launch({ agent: 'nobody:x' })).toThrow(/no provider 'nobody'/);
    expect(() => sup.launch({ agent: 'fake:engineer' })).toThrow(/max_runs/);
  });
});

describe('claim races across clones', () => {
  it('stops a live run whose claim lost to one pushed first from another clone', async () => {
    const remote = temp();
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote, windowsHide: true });
    const { repo, sup, as } = setup({ mode: 'hang', opsd: { sync: true } });
    const g = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
    for (const [k, v] of [
      ['user.name', 'Test'],
      ['user.email', 'test@example.invalid'],
    ] as const) {
      g(repo, 'config', k, v);
    }
    as('human:dawid').newTask({ title: 'raced', owner: 'fake:engineer' });
    g(repo, 'checkout', '-q', '-b', 'main');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'init');
    g(repo, 'remote', 'add', 'origin', remote);
    g(repo, 'push', '-q', '-u', 'origin', 'main');
    const other = temp();
    g(other, 'clone', '-q', remote, '.');
    g(other, 'config', 'user.name', 'Test');
    g(other, 'config', 'user.email', 'test@example.invalid');
    const otherEnv = { ...process.env, OPS_CONFIG: join(other, 'none.yml') } as NodeJS.ProcessEnv;
    delete otherEnv.OPS_ROOTS;
    const winner = new Workspace({ cwd: other, env: otherEnv, actor: 'fake:engineer', user: {} })
      .claim('T-0001')
      .events.find((e) => e.type === 'claim')!.token;
    syncRoot(new Root(join(other, '.agent-ops')), {});

    const run = sup.launch({ agent: 'fake:engineer', task: 'T-0001' });
    const done = ended(sup, run.id);
    await sup.tick();
    const r = await done;
    expect(r.reason).toBe('lost-claim');
    const v = as('human:dawid').view('T-0001');
    expect(v.claimToken).toBe(winner);
    expect(v.status).toBe('claimed');

    // Now the winner's claim is visible here: opsd must not launch fake:engineer on it, although
    // the agent id matches.
    expect(() => sup.launch({ agent: 'fake:engineer', task: 'T-0001' })).toThrow(
      /claim from another clone|not claimable/,
    );
    expect(sup.liveFor('fake:engineer')).toBeUndefined();
  });

  it('launches on a claim this clone already holds without claiming again', async () => {
    const { sup, as } = setup({ mode: 'done' });
    as('human:dawid').newTask({ title: 'held', owner: 'fake:engineer' });
    const token = as('fake:engineer')
      .claim('T-0001')
      .events.find((e) => e.type === 'claim')!.token;
    const r = await ended(sup, sup.launch({ agent: 'fake:engineer', task: 'T-0001' }).id);
    expect(r.exit).toBe(0);
    const claims = as('human:dawid')
      .showEvents('T-0001')
      .events.filter((e) => e.type === 'claim');
    expect(claims.map((e) => e.token)).toEqual([token]);
  });
});

describe('runtimes', () => {
  it('builds Claude and Codex command lines with the role profile', () => {
    const claude = invocation(
      { command: 'claude' },
      'claude:qa',
      undefined,
      'C:/w',
      ['C:/data'],
      ['C:/data/.agent-ops/agents', 'D:\\ops\\agents', '/home/user/.agent-ops/agents'],
    );
    const tools = claude.args[claude.args.indexOf('--allowedTools') + 1]!;
    expect(tools).toContain('Bash(ops *)');
    expect(tools).toContain('Edit');
    expect(claude.args).toContain('stream-json');
    const denied = claude.args[claude.args.indexOf('--disallowedTools') + 1]!;
    expect(denied).toContain('Bash(taskkill*)');
    expect(denied).toContain('Edit(//c/data/.agent-ops/agents/**)');
    expect(denied).toContain('Write(//d/ops/agents/**)');
    expect(denied).toContain('Edit(//home/user/.agent-ops/agents/**)');
    expect(claude.args.slice(-2)).toEqual(['--add-dir', 'C:/data']);
    const role = invocation(
      { command: 'claude' },
      'claude:writer',
      { id: 'claude:writer', status: 'active', tools: ['Read'], file: 'f', body: '' },
      '.',
      [],
    );
    expect(role.args[role.args.indexOf('--allowedTools') + 1]).toBe('Read,Bash(ops *)');
    // A role that does not write gets no Edit or Write, even from its role file (AO-0136).
    const reader = invocation(
      { command: 'claude' },
      'claude:reviewer',
      { id: 'claude:reviewer', status: 'active', tools: ['Read', 'Edit'], file: 'f', body: '' },
      '.',
      [],
      [],
      undefined,
      true,
    );
    expect(reader.args[reader.args.indexOf('--allowedTools') + 1]).toBe('Read,Bash(ops *)');
    const readerDeny = reader.args[reader.args.indexOf('--disallowedTools') + 1]!.split(',');
    expect(readerDeny).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']));
    const qaDefault = invocation(
      { command: 'claude' },
      'claude:qa',
      undefined,
      '.',
      [],
      [],
      undefined,
      true,
    );
    const qaTools = qaDefault.args[qaDefault.args.indexOf('--allowedTools') + 1]!.split(',');
    expect(qaTools).toContain('Read');
    expect(qaTools).not.toContain('Edit');
    expect(qaTools).not.toContain('Write');
    const codex = invocation(
      opsdConfig({}).runtimes.codex!,
      'codex:engineer',
      undefined,
      'C:/w',
      [],
    );
    expect(codex.unsetEnv).toEqual([]);
    expect(
      invocation(
        { command: 'codex', unset_env: ['GH_TOKEN'] },
        'codex:engineer',
        undefined,
        'C:/w',
        [],
      ).unsetEnv,
    ).toEqual(['GH_TOKEN']);
    expect(codex.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      'C:/w',
      '-',
    ]);
    // A Codex run of a role that does not write starts in its task store, with only the task
    // stores writable, so `ops` works and the checkout stays read-only (AO-0138).
    const codexReader = invocation(
      { command: 'codex', model: 'gpt-5-codex' },
      'codex:qa',
      undefined,
      'C:/w',
      ['D:/other'],
      [],
      undefined,
      true,
      false,
      [
        'C:/w/.agent-ops',
        'D:/other/.agent-ops',
        'c:\\W\\.agent-ops\\mirrors\\p',
        'C:/w/.agent-ops',
      ],
    );
    expect(codexReader.args).toEqual([
      'exec',
      '-m',
      'gpt-5-codex',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      'C:/w/.agent-ops',
      '--add-dir',
      'D:/other/.agent-ops',
      '-',
    ]);
    expect(codexReader.args).not.toContain('C:/w');
    expect(codexReader.args).not.toContain('D:/other');
    expect(codexReader.note).toContain('may not change files in C:/w');
    expect(codexReader.note).toContain('git -C C:/w');
    // A store inside another one is covered by it, whichever comes first.
    const nested = invocation(
      { command: 'codex' },
      'codex:qa',
      undefined,
      'C:/w',
      [],
      [],
      undefined,
      true,
      false,
      ['C:/w/.agent-ops/mirrors/p', 'C:/w/.agent-ops'],
    );
    expect(nested.args.slice(-3)).toEqual(['-C', 'C:/w/.agent-ops', '-']);
    // With no task store, the sandbox is read-only and the run starts in its checkout.
    const storeless = invocation(
      { command: 'codex' },
      'codex:qa',
      undefined,
      'C:/w',
      ['D:/other'],
      [],
      undefined,
      true,
    );
    expect(storeless.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-C',
      'C:/w',
      '-',
    ]);
    expect(storeless.note).toBeUndefined();
    expect(codex.note).toBeUndefined();
    const prompt = runPrompt({ agent: 'codex:qa', task: 'T-0003', roleFile: 'agents/codex-qa.md' });
    expect(prompt).toContain('Work on T-0003:');
    expect(prompt).toContain('never kill by name');
    // AO-0057: messages to a person must say what they refer to and what is needed.
    expect(prompt).toContain('names the task id');
    expect(prompt).toContain('Never "see the comment of <date>"');
    expect(prompt).not.toContain('holds the task store');
  });

  it("keeps runs in a data root's checkout off git checkout and switch (AO-0135)", () => {
    const deny = (storeCheckout: boolean, agent = 'claude:engineer') => {
      const inv = invocation(
        { command: 'claude' },
        agent,
        undefined,
        'C:/w',
        [],
        [],
        undefined,
        false,
        storeCheckout,
      );
      return inv.args[inv.args.indexOf('--disallowedTools') + 1]!.split(',');
    };
    expect(deny(true)).toEqual(
      expect.arrayContaining(['Bash(git checkout*)', 'Bash(git switch*)', 'Bash(taskkill*)']),
    );
    expect(deny(false)).not.toContain('Bash(git checkout*)');
    expect(deny(false)).not.toContain('Bash(git switch*)');

    const work = runPrompt({
      agent: 'codex:engineer',
      task: 'AO-0001',
      storeCheckout: { top: 'C:\\dev\\repo', branch: 'v2' },
    });
    expect(work).toContain(
      '- C:/dev/repo holds the task store: keep `v2` checked out and never run `git checkout` or',
    );
    expect(work).toContain('`git worktree add out/wt-AO-0001 -b <branch> <base>`');
    // Review runs look at branches too: the rule holds for them, without a known branch here.
    const review = runPrompt({
      agent: 'codex:qa',
      task: 'AO-0001',
      review: true,
      storeCheckout: { top: '/srv/repo', branch: null },
    });
    expect(review).toContain('- /srv/repo holds the task store: keep its branch checked out');

    // A custom prompt keeps its text and gets the rule appended; elsewhere it stays as given.
    const co = { top: '/srv/repo', branch: 'v2' };
    expect(withStoreCheckoutRule('help\n', undefined, 'AO-0001')).toBe('help\n');
    expect(withStoreCheckoutRule('help\n', co, 'AO-0001')).toMatch(
      /^help\n\nRule for this folder:\n- \/srv\/repo holds the task store: keep `v2` checked out/,
    );
    expect(withStoreCheckoutRule('', co)).toMatch(/^Rule for this folder:\n/);
    expect(withStoreCheckoutRule('', co)).toContain('out/wt-<task id>');
  });

  it('logs a sync that repeats the last notes and did nothing only once (AO-0135)', () => {
    const log = new SyncLog();
    const held = {
      root: 'r',
      committed: 0,
      pulled: false,
      pushed: false,
      notes: ['not synced: code is checked out, but the store branch is v2'],
    };
    expect(log.line(held)).toBe(
      'sync r: committed 0; not synced: code is checked out, but the store branch is v2',
    );
    expect(log.line(held)).toBeNull();
    expect(log.line({ ...held, root: 'other' })).not.toBeNull();
    // A new note, or a sync that does something, is logged again.
    expect(log.line({ ...held, notes: ['not synced: HEAD is detached'] })).not.toBeNull();
    expect(log.line(held)).not.toBeNull();
    expect(log.line({ ...held, committed: 2 })).toBe(
      'sync r: committed 2; not synced: code is checked out, but the store branch is v2',
    );
    expect(log.line({ ...held, committed: 2 })).not.toBeNull();
    // Syncs without notes keep their line every time.
    const quiet = { root: 'r', committed: 0, pulled: true, pushed: false };
    expect(log.line(quiet)).toBe('sync r: committed 0, pulled');
    expect(log.line({ ...quiet, pulled: false })).toBe('sync r: committed 0');
    expect(log.line({ ...quiet, pulled: false })).toBe('sync r: committed 0');
  });

  it('counts tokens from Claude and Codex logs', () => {
    const m = new UsageMeter();
    const msg = (id: string, i: number, o: number) =>
      JSON.stringify({
        type: 'assistant',
        message: { id, usage: { input_tokens: i, output_tokens: o } },
      });
    const b = msg('b', 20, 10);
    // A line split across two reads counts once, when it is complete.
    m.feed(`${msg('a', 10, 5)}\n${msg('a', 10, 5)}\n${b.slice(0, 20)}`);
    expect(m.tokens).toBe(15);
    m.feed(`${b.slice(20)}\nnot json\n`);
    expect(m.tokens).toBe(45);
    m.feed(
      `${JSON.stringify({ type: 'result', usage: { input_tokens: 50, cache_creation_input_tokens: 7, output_tokens: 3 } })}\n`,
    );
    expect(m.tokens).toBe(60);
    const c = new UsageMeter();
    c.feed(
      `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } })}\n`,
    );
    expect(c.tokens).toBe(250);
    const t = new UsageMeter();
    t.feed('codex\ndone\ntokens used\n92,388\n');
    expect(t.tokens).toBe(92_388);
  });

  it('decides when schedules are due', () => {
    const now = new Date(2026, 9, 31, 10, 0).getTime();
    expect(scheduleDue({ every: '30m' }, undefined, now)).toBe(true);
    expect(scheduleDue({ every: '30m' }, now - 10 * 60_000, now)).toBe(false);
    expect(scheduleDue({ every: '30m' }, now - 31 * 60_000, now)).toBe(true);
    expect(scheduleDue({ at: '09:00' }, undefined, now)).toBe(true);
    expect(scheduleDue({ at: '09:00' }, now - 30 * 60_000, now)).toBe(false);
    expect(scheduleDue({ at: '09:00' }, now - 24 * 3600_000, now)).toBe(true);
    expect(scheduleDue({ at: '11:00' }, undefined, now)).toBe(false);
    expect(() => opsdConfig({ opsd: { schedules: [{ name: 'x', agent: 'a:b' }] } })).toThrow(
      /exactly one/,
    );
  });
});

describe('api', () => {
  it('serves root-qualified inbox refs that the task routes accept with several roots', async () => {
    const alpha = temp();
    const beta = temp();
    for (const [dir, name] of [
      [alpha, 'alpha'],
      [beta, 'beta'],
    ] as const) {
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      initRoot(dir, { name, human: 'human:dawid' });
    }
    const env = {
      ...process.env,
      OPS_CONFIG: join(alpha, 'none.yml'),
      OPS_STATE_DIR: temp(),
      OPS_ROOTS: beta,
    } as NodeJS.ProcessEnv;
    delete env.OPS_AGENT;
    const sup = new Supervisor({
      env,
      cwd: alpha,
      user: {},
      config: opsdConfig({ opsd: { sync: false } }),
    });
    sups.push(sup);
    const as = (actor: string, root?: string) =>
      new Workspace({ cwd: alpha, env, actor, user: {}, root });
    as('human:dawid').newTask({ title: 'in alpha', owner: 'claude:engineer' });
    as('human:dawid', 'beta').newTask({ title: 'in beta', owner: 'claude:engineer' });
    for (const ref of ['alpha/T-0001', 'beta/T-0001']) {
      as('claude:engineer').start(ref, 'plan');
      as('claude:engineer').ask(ref, `question on ${ref}`);
    }
    const api = await startApi(sup, { port: 0, token: 'multi-root-token', version: 't' });
    const base = `http://127.0.0.1:${api.port}`;
    const auth = { authorization: 'Bearer multi-root-token' };
    try {
      const inbox = async () =>
        (await (
          await fetch(`${base}/api/inbox?as=human:dawid`, { headers: auth })
        ).json()) as Array<{ kind: string; task: string; root: string }>;
      const asks = (await inbox()).filter((i) => i.kind === 'ask');
      expect(asks.map((i) => [i.task, i.root]).sort()).toEqual([
        ['alpha/T-0001', 'alpha'],
        ['beta/T-0001', 'beta'],
      ]);
      const betaAsk = asks.find((i) => i.root === 'beta')!;
      const answered = await fetch(`${base}/api/tasks/${encodeURIComponent(betaAsk.task)}/answer`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ as: 'human:dawid', message: 'yes' }),
      });
      expect(answered.status).toBe(200);
      const left = (await inbox()).filter((i) => i.kind === 'ask').map((i) => i.task);
      expect(left).toEqual(['alpha/T-0001']);
    } finally {
      await api.close();
    }
  });

  it('serves waits, usage, and agents the opsd config names', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { max_runs: 0, agents: { 'fake:engineer': { wake: true } } },
    });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    const api = await startApi(sup, { port: 0, token: 'secret-test-token', version: 't' });
    const get = async (path: string): Promise<unknown> =>
      (
        await fetch(`http://127.0.0.1:${api.port}${path}`, {
          headers: { authorization: 'Bearer secret-test-token' },
        })
      ).json();
    try {
      const waits = (await get('/api/waits')) as {
        providers: Record<string, { live: number }>;
        waits: Array<{ task: string; reason: string }>;
      };
      expect(waits.providers.fake).toMatchObject({ live: 0 });
      expect(waits.waits).toEqual([
        expect.objectContaining({
          task: 'test/T-0001',
          reason: 'fake:engineer: 0 runs live; max_runs is 0',
        }),
      ]);
      expect(await get('/api/usage')).toHaveProperty('fake');
      const agents = (await get('/api/agents')) as Array<{ id: string; wake: boolean }>;
      expect(agents).toContainEqual(expect.objectContaining({ id: 'fake:engineer', wake: true }));
    } finally {
      await api.close();
    }
  });

  it('shuts down on ifIdle only with no run live, and refuses launches once it agreed', async () => {
    const { sup, as } = setup({ mode: 'hang' });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    let shutdowns = 0;
    const api = await startApi(sup, {
      port: 0,
      token: 'secret-test-token',
      version: 't',
      onShutdown: () => shutdowns++,
    });
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${api.port}/api/shutdown`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-test-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const run = sup.launch({ agent: 'fake:engineer', task: '1' });
      expect((await post({ ifIdle: true })).status).toBe(409);
      // Callers such as the desktop's update install tell the refusal apart by its status.
      const info = {
        pid: 0,
        port: api.port,
        token: 'secret-test-token',
        started_at: '',
        version: 't',
      };
      await expect(
        daemonCall(info, 'POST', '/api/shutdown', { killRuns: false, ifIdle: true }),
      ).rejects.toMatchObject({ name: 'DaemonCallError', status: 409 });
      expect(sup.run(run.id).status).toBe('running');
      sup.kill(run.id);
      await ended(sup, run.id);
      expect((await post({ ifIdle: true })).status).toBe(200);
      expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(/opsd is stopping/);
      await until(() => shutdowns === 1);
    } finally {
      await api.close();
    }
  });

  it('refuses a stop that keeps runs where runs end with opsd, and ends them on stop', async () => {
    const { sup, as } = setup({ mode: 'hang', runsOutlive: false });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    let shutdowns = 0;
    const api = await startApi(sup, {
      port: 0,
      token: 'secret-test-token',
      version: 't',
      onShutdown: () => shutdowns++,
    });
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${api.port}/api/shutdown`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-test-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const health = await fetch(`http://127.0.0.1:${api.port}/api/health`, {
        headers: { authorization: 'Bearer secret-test-token' },
      });
      expect(((await health.json()) as { runs_outlive: boolean }).runs_outlive).toBe(false);
      const run = sup.launch({ agent: 'fake:engineer', task: '1' });
      const res = await post({ killRuns: false });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/1 live run would end/);
      expect(sup.run(run.id).status).toBe('running');
      expect(shutdowns).toBe(0);
      // A signal stop keeps no runs here: they end with their claims released.
      sup.stop();
      const r = await ended(sup, run.id);
      expect(r.reason).toBe('shutdown');
      await until(() => as('human:dawid').view('1').claimedBy === null);
      expect((await post({ killRuns: false })).status).toBe(200);
      await until(() => shutdowns === 1);
    } finally {
      await api.close();
    }
  });

  it('needs the token and a localhost host, launches runs and pushes events', async () => {
    const { sup, as } = setup();
    as('human:dawid').newTask({ title: 'via api', owner: 'fake:engineer' });
    const api = await startApi(sup, { port: 0, token: 'secret-test-token', version: 't' });
    const base = `http://127.0.0.1:${api.port}`;
    const auth = { authorization: 'Bearer secret-test-token' };
    try {
      expect((await fetch(`${base}/api/health`)).status).toBe(401);
      const health = (await (await fetch(`${base}/api/health`, { headers: auth })).json()) as {
        ok: boolean;
      };
      expect(health.ok).toBe(true);
      const tasks = (await (await fetch(`${base}/api/tasks`, { headers: auth })).json()) as Array<{
        id: string;
      }>;
      expect(tasks.map((t) => t.id)).toEqual(['T-0001']);

      const events: string[] = [];
      const stream = await fetch(`${base}/api/events?token=secret-test-token`);
      const reader = stream.body!.getReader();
      const pump = (async () => {
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          events.push(...[...dec.decode(value).matchAll(/^event: (\w+)/gm)].map((m) => m[1]!));
        }
      })();

      const created = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'fake:engineer', task: 'T-0001' }),
      });
      expect(created.status).toBe(201);
      const run = (await created.json()) as RunRecord;
      await ended(sup, run.id);
      const log = await (
        await fetch(`${base}/api/runs/${run.id.slice(-6)}/log`, { headers: auth })
      ).text();
      expect(log).toContain('usage');

      const bad = await fetch(`${base}/api/tasks/T-0001/comment`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'no actor' }),
      });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/api/tasks/T-0001/comment`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ as: 'human:dawid', message: 'thanks' }),
      });
      expect(ok.status).toBe(200);
      const missing = await fetch(`${base}/api/runs/NOPE`, { headers: auth });
      expect(missing.status).toBe(404);
      await until(() => events.includes('run'));
      expect(events[0]).toBe('hello');
      await reader.cancel();
      await pump.catch(() => {});
    } finally {
      await api.close();
    }
  });

  it('rejects other hosts', async () => {
    const { sup } = setup();
    const api = await startApi(sup, { port: 0, token: 't0k', version: 't' });
    try {
      const res = await new Promise<number>((resolve, reject) => {
        // fetch does not let a page set Host; a raw request shows what a rebinding attack sends.
        import('node:http').then(({ request }) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: api.port,
              path: '/api/health',
              headers: { host: 'evil.example:80', authorization: 'Bearer t0k' },
            },
            (r) => resolve(r.statusCode ?? 0),
          );
          req.on('error', reject);
          req.end();
        }, reject);
      });
      expect(res).toBe(403);
    } finally {
      await api.close();
    }
  });
});

describe('state', () => {
  it('keeps run records and logs in the state folder', () => {
    const { sup, state } = setup();
    expect(existsSync(join(state, 'runs'))).toBe(true);
    expect(sup.store.logPath('X')).toBe(join(state, 'logs', 'X.log'));
  });
});

describe('daemon', () => {
  it('starts in the background, runs an agent through the API and stops', async () => {
    execFileSync(
      process.execPath,
      [join(repoTop, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'packages/supervisor'],
      { cwd: repoTop, windowsHide: true },
    );
    const { repo, as, state } = setup();
    const agentFile = join(temp(), 'fake-agent.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const userConfig = join(temp(), 'config.yml');
    writeFileSync(
      userConfig,
      [
        'opsd:',
        '  port: 0',
        '  sync: false',
        '  runtimes:',
        '    fake:',
        `      command: ${JSON.stringify(process.execPath)}`,
        `      args: [${JSON.stringify(agentFile)}]`,
        '',
      ].join('\n'),
    );
    const env = {
      ...process.env,
      OPS_CONFIG: userConfig,
      OPS_STATE_DIR: state,
      FAKE_MODE: 'done',
    } as NodeJS.ProcessEnv;
    delete env.OPS_AGENT;
    delete env.OPS_ROOTS;
    as('human:dawid').newTask({ title: 'daemon work', owner: 'fake:engineer' });
    const info = await startDaemon({ env, cwd: repo });
    try {
      expect(readDaemon(env)?.pid).toBe(info.pid);
      expect((await startDaemon({ env, cwd: repo })).pid).toBe(info.pid);
      const run = await daemonCall<RunRecord>(info, 'POST', '/api/runs', {
        agent: 'fake:engineer',
        task: 'T-0001',
      });
      let r = run;
      for (let i = 0; i < 100 && r.status === 'running'; i++) {
        await new Promise((res) => setTimeout(res, 100));
        r = await daemonCall<RunRecord>(info, 'GET', `/api/runs/${run.id}`);
      }
      expect(r).toMatchObject({ status: 'ended', exit: 0 });
      expect(as('human:dawid').view('1').status).toBe('done');
      await expect(daemonCall(info, 'POST', '/api/runs', { agent: 'bad' })).rejects.toThrow(
        /bad agent id/,
      );
    } finally {
      expect(await stopDaemon({ env })).toBe(true);
    }
    expect(readDaemon(env)).toBeNull();
    expect(readFileSync(join(state, 'opsd.log'), 'utf8')).toContain('opsd stopped');
  }, 60_000);

  it('stops and restarts with a live run: the next opsd adopts it', async () => {
    execFileSync(
      process.execPath,
      [join(repoTop, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'packages/supervisor'],
      { cwd: repoTop, windowsHide: true },
    );
    const { repo, as, state } = setup();
    const agentFile = join(temp(), 'fake-agent.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const userConfig = join(temp(), 'config.yml');
    writeFileSync(
      userConfig,
      [
        'opsd:',
        '  port: 0',
        '  sync: false',
        '  runtimes:',
        '    fake:',
        `      command: ${JSON.stringify(process.execPath)}`,
        `      args: [${JSON.stringify(agentFile)}]`,
        '',
      ].join('\n'),
    );
    const env = {
      ...process.env,
      OPS_CONFIG: userConfig,
      OPS_STATE_DIR: state,
      FAKE_MODE: 'hang',
    } as NodeJS.ProcessEnv;
    delete env.OPS_AGENT;
    delete env.OPS_ROOTS;
    as('human:dawid').newTask({ title: 'long work', owner: 'fake:engineer' });
    const first = await startDaemon({ env, cwd: repo });
    let runPid: number | undefined;
    try {
      const launched = await daemonCall<RunRecord>(first, 'POST', '/api/runs', {
        agent: 'fake:engineer',
        task: 'T-0001',
      });
      await until(() => as('human:dawid').view('1').status === 'in-progress', 20_000);
      let run = launched;
      if (launched.shim_pid !== undefined) {
        // Windows: the run starts as a hidden cmd.exe; the record moves on to the launcher behind
        // it, which runs the agent.
        expect(launched.pid).toBe(launched.shim_pid);
        const end = Date.now() + 20_000;
        while (run.pid === launched.shim_pid && Date.now() < end) {
          await new Promise((r) => setTimeout(r, 200));
          run = await daemonCall<RunRecord>(first, 'GET', `/api/runs/${launched.id}`);
        }
        expect(run.pid).not.toBe(launched.shim_pid);
        expect(run.image).toBe('node.exe');
      }
      runPid = run.pid;

      // Before the fix, the run's handles kept the old opsd alive and this timed out.
      expect(await stopDaemon({ env })).toBe(true);
      expect(isAlive(first.pid)).toBe(false);
      expect(isAlive(run.pid)).toBe(true);
      // Windows: the job object ended the hidden cmd.exe with opsd; the agent outlived both.
      if (launched.shim_pid !== undefined) {
        await until(() => !isAlive(launched.shim_pid!), 20_000);
        expect(isAlive(run.pid)).toBe(true);
      }

      const second = await startDaemon({ env, cwd: repo });
      expect(second.pid).not.toBe(first.pid);
      const adopted = await daemonCall<RunRecord>(second, 'GET', `/api/runs/${run.id}`);
      expect(adopted).toMatchObject({ status: 'running', pid: run.pid });

      // A restart goes through the same stop: the run survives a second handover.
      expect(await stopDaemon({ env })).toBe(true);
      expect(isAlive(second.pid)).toBe(false);
      expect(isAlive(run.pid)).toBe(true);
      const third = await startDaemon({ env, cwd: repo });
      const again = await daemonCall<RunRecord>(third, 'GET', `/api/runs/${run.id}`);
      expect(again).toMatchObject({ status: 'running', pid: run.pid });

      await daemonCall(third, 'POST', `/api/runs/${run.id}/kill`, {});
      await until(() => !isAlive(run.pid), 20_000);
      await until(() => as('human:dawid').view('1').claimedBy === null, 20_000);
      const done = await daemonCall<RunRecord>(third, 'GET', `/api/runs/${run.id}`);
      expect(done).toMatchObject({ status: 'ended', reason: 'killed' });
    } finally {
      if (readDaemon(env)) await stopDaemon({ env, killRuns: true });
      // Only this test's own fake agent, by the PID its opsd printed.
      if (runPid !== undefined && isAlive(runPid)) process.kill(runPid);
    }
  }, 90_000);

  it('fails a stop when the old opsd is still alive, so a restart cannot start a second one', async () => {
    const state = temp();
    const env = { ...process.env, OPS_STATE_DIR: state } as NodeJS.ProcessEnv;
    // An opsd that answers the shutdown but whose process stays: a server here, a live PID there.
    const stuck = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(
        join(state, 'opsd.json'),
        JSON.stringify({ pid: stuck.pid, port, token: 't', started_at: '', version: 't' }),
      );
      await expect(stopDaemon({ env, waitMs: 500 })).rejects.toThrow(/did not stop in time/);
    } finally {
      server.close();
      stuck.kill();
    }
  });
});

describe('review fixes', () => {
  it('rolls back its own claim when the launch fails after claiming', () => {
    const { sup, as } = setup();
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    expect(() => sup.launch({ agent: 'fake:engineer', task: '1', budget: 'forever' })).toThrow(
      /bad duration/,
    );
    expect(as('human:dawid').showEvents('1').events).toEqual([]);
    expect(() =>
      sup.launch({ agent: 'fake:engineer', task: '1', cwd: join(temp(), 'missing', 'dir') }),
    ).toThrow();
    const types = as('human:dawid')
      .showEvents('1')
      .events.map((e) => e.type);
    expect(types).toEqual(['claim', 'release']);
    expect(as('human:dawid').view('1').status).toBe('todo');
    expect(sup.runs({ live: true })).toEqual([]);
  });

  it('counts tokens past 4 MiB of output and in a last line without a newline', async () => {
    const big = setup({ mode: 'big' });
    const r1 = await ended(big.sup, big.sup.launch({ agent: 'fake:engineer' }).id);
    expect(r1.tokens).toBe(150 + 1001);
    const tail = setup({ mode: 'tail' });
    const r2 = await ended(tail.sup, tail.sup.launch({ agent: 'fake:engineer' }).id);
    expect(r2.tokens).toBe(1001);
  }, 30_000);

  it('adopts a run only when the PID is still the same process', async () => {
    const { sup, state } = setup();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    await until(() => processStartSync(child.pid!) !== null, 20_000);
    const start = processStartSync(child.pid!)!;
    const base = {
      agent: 'fake:engineer',
      command: 'x',
      cwd: state,
      log: join(state, 'none.log'),
      started_at: new Date().toISOString(),
      status: 'running' as const,
      budget_minutes: 60,
      tokens: 0,
      pid: child.pid!,
      image: 'node.exe',
    };
    sup.store.save({ ...base, id: '01BBBBBBBBBBBBBBBBBBBBBBB1', proc_start: start });
    // Same PID and image, another start time: a reused PID, never adopted or killed.
    sup.store.save({
      ...base,
      id: '01BBBBBBBBBBBBBBBBBBBBBBB2',
      agent: 'fake:qa',
      proc_start: 'not-this-process',
    });
    sup.adopt();
    expect(sup.runs({ live: true }).map((r) => r.id)).toEqual(['01BBBBBBBBBBBBBBBBBBBBBBB1']);
    expect(sup.run('01BBBBBBBBBBBBBBBBBBBBBBB2').reason).toBe('lost');
    const exited = new Promise((r) => child.once('exit', r));
    sup.kill('01BBBBBBBBBBBBBBBBBBBBBBB1');
    await exited;
    await until(() => sup.run('01BBBBBBBBBBBBBBBBBBBBBBB1').status === 'ended');
    expect(sup.run('01BBBBBBBBBBBBBBBBBBBBBBB1')).toMatchObject({
      status: 'ended',
      reason: 'killed',
    });
  }, 60_000);

  it('never kills an adopted PID that runs another process at the moment of the kill', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      await until(() => processStartSync(child.pid!) !== null, 20_000);
      const start = processStartSync(child.pid!)!;
      // Adopted while the PID was the run's; by the kill, the PID runs another process (another
      // creation time in the snapshot).
      const killed: ProcTarget[] = [];
      const lister: ProcLister = {
        precise: true,
        clockSlack: 0,
        list: () =>
          Promise.resolve([{ pid: child.pid!, ppid: 1, name: 'node', cmd: 'node', start: 12_345 }]),
        kill: (targets) => {
          killed.push(...targets);
          return Promise.resolve(new Map(targets.map((t) => [t.pid, 'killed' as const])));
        },
        close: () => {},
      };
      const { sup, state } = setup({ procs: lister });
      sup.store.save({
        id: '01BBBBBBBBBBBBBBBBBBBBBBB3',
        agent: 'fake:engineer',
        command: 'x',
        cwd: state,
        log: join(state, 'none.log'),
        started_at: new Date().toISOString(),
        status: 'running',
        budget_minutes: 60,
        tokens: 0,
        pid: child.pid!,
        image: 'node.exe',
        proc_start: start,
      });
      sup.adopt();
      expect(sup.runs({ live: true })).toHaveLength(1);
      sup.kill('01BBBBBBBBBBBBBBBBBBBBBBB3');
      await until(() => sup.run('01BBBBBBBBBBBBBBBBBBBBBBB3').status === 'ended');
      expect(killed).toEqual([]);
      expect(alive(child.pid!)).toBe(true);
    } finally {
      child.kill();
    }
  }, 60_000);

  it('retries schedules and wakes whose launch failed, and wakes on inbox items', async () => {
    const { sup, as } = setup({
      opsd: {
        runtimes: {
          gone: { command: 'definitely-not-a-command-xyz' },
        },
        agents: { 'gone:engineer': { wake: true }, 'fake:qa': { wake: true } },
        schedules: [{ name: 'digest', every: '24h', agent: 'gone:writer' }],
      },
    });
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    as('human:dawid').newTask({ title: 'for gone', owner: 'gone:engineer' });
    await sup.tick();
    expect(sup.runs()).toEqual([]);
    expect(warns.some((w) => /not on PATH/.test(w))).toBe(true);
    expect(sup.store.readJson('schedules.json', {})).toEqual({});
    expect(sup.store.readJson('wake.json', {})).toEqual({});
    expect(as('human:dawid').view('1').claimedBy).toBeNull();

    // An addressed comment wakes fake:qa with the inbox prompt, once.
    as('human:dawid').newTask({ title: 'question for qa', owner: 'human:dawid' });
    as('human:dawid').comment('2', 'please look', 'fake:qa');
    await sup.tick();
    const woke = sup.runs({ live: true });
    expect(woke.map((r) => [r.agent, r.task])).toEqual([['fake:qa', undefined]]);
    await ended(sup, woke[0]!.id);
    await sup.tick();
    expect(sup.runs().filter((r) => r.agent === 'fake:qa')).toHaveLength(1);
  });

  it('rejects duplicate schedule names and impossible times', () => {
    const sched = (s: object[]) => () => opsdConfig({ opsd: { schedules: s as never } });
    expect(
      sched([
        { name: 'a', agent: 'x:y', every: '1h' },
        { name: 'a', agent: 'x:y', every: '2h' },
      ]),
    ).toThrow(/twice/);
    expect(sched([{ name: 'a', agent: 'x:y', at: '99:99' }])).toThrow(/00:00 to 23:59/);
    expect(sched([{ name: 'a', agent: 'x:y', at: '24:00' }])).toThrow(/00:00 to 23:59/);
    expect(sched([{ name: 'a', agent: 'x:y', at: '23:59' }])()).toBeTruthy();
  });

  it('takes the token from the URL only for the event stream', async () => {
    const { sup } = setup();
    const api = await startApi(sup, { port: 0, token: 'tok3n', version: 't' });
    try {
      const base = `http://127.0.0.1:${api.port}`;
      expect((await fetch(`${base}/api/health?token=tok3n`)).status).toBe(401);
      expect((await fetch(`${base}/api/runs?token=tok3n`)).status).toBe(401);
      const stream = await fetch(`${base}/api/events?token=tok3n`);
      expect(stream.status).toBe(200);
      await stream.body?.cancel();
    } finally {
      await api.close();
    }
  });

  it('runs one opsd per state folder even when two start at once', async () => {
    const { repo, state } = setup();
    const userConfig = join(temp(), 'config.yml');
    writeFileSync(userConfig, 'opsd:\n  port: 0\n  sync: false\n');
    const env = {
      ...process.env,
      OPS_CONFIG: userConfig,
      OPS_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    delete env.OPS_AGENT;
    const [a, b] = await Promise.all([
      startDaemon({ env, cwd: repo }),
      startDaemon({ env, cwd: repo }),
    ]);
    try {
      expect(a.pid).toBe(b.pid);
      expect(readDaemon(env)?.pid).toBe(a.pid);
      // Exactly one supervisor bound a port; the other start gave up on the lock.
      const started = readFileSync(join(state, 'opsd.log'), 'utf8').match(/ on 127\.0\.0\.1:/g);
      expect(started).toHaveLength(1);
    } finally {
      expect(await stopDaemon({ env })).toBe(true);
    }
    expect(existsSync(join(state, 'opsd.lock'))).toBe(false);
  }, 60_000);
});

describe('fail-closed identity', () => {
  it('never adopts a live run whose creation time is missing', async () => {
    const { sup, state } = setup();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      sup.store.save({
        id: '01CCCCCCCCCCCCCCCCCCCCCCC1',
        agent: 'fake:engineer',
        command: 'x',
        cwd: state,
        log: join(state, 'none.log'),
        started_at: new Date().toISOString(),
        status: 'running',
        budget_minutes: 60,
        tokens: 0,
        pid: child.pid!,
        image: 'node.exe',
      });
      sup.adopt();
      expect(sup.runs({ live: true })).toEqual([]);
      expect(sup.run('01CCCCCCCCCCCCCCCCCCCCCCC1').reason).toBe('lost');
    } finally {
      child.kill();
    }
  });

  it('records the creation time before a launched run can be adopted', async () => {
    const { sup } = setup({ mode: 'hang' });
    const run = sup.launch({ agent: 'fake:engineer' });
    expect(sup.store.get(run.id)?.proc_start).toBeTruthy();
    sup.kill(run.id);
    await ended(sup, run.id);
  });

  const listers: Record<string, () => ProcLister> = {
    slow: () => {
      const real = systemLister();
      return {
        precise: real.precise,
        clockSlack: real.clockSlack,
        list: async () => {
          await new Promise((r) => setTimeout(r, 3000));
          return real.list();
        },
        kill: (t) => real.kill(t),
        ownPids: () => real.ownPids?.() ?? [],
        close: () => real.close(),
      };
    },
    failing: () => ({
      precise: true,
      clockSlack: 0,
      list: () => Promise.reject(new Error('lister down')),
      kill: () => Promise.reject(new Error('lister down')),
      close: () => {},
    }),
  };

  for (const [kind, lister] of Object.entries(listers)) {
    it.runIf(process.platform === 'win32')(
      `hands a run stopped right after launch to the next opsd by its launcher (${kind} lister)`,
      async () => {
        const mark = join(temp(), 'started');
        const { sup, as, opsd } = setup({
          mode: 'hang',
          procs: lister(),
          env: { FAKE_MARK: mark },
        });
        as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
        const run = sup.launch({ agent: 'fake:engineer', task: '1' });
        expect(run.pid).toBe(run.shim_pid);
        sup.stop();
        await sup.close();
        // The record names the launcher, read while it waited, before the command started.
        const handed = sup.store.get(run.id)!;
        expect(handed.status).toBe('running');
        expect(handed.pid).not.toBe(run.shim_pid);
        expect(handed.image).toBe('node.exe');
        expect(processStartSync(handed.pid)).toBe(handed.proc_start);
        // The agent is the launcher's child: the exact process the record names.
        await until(() => existsSync(mark), 20_000);
        expect(Number(readFileSync(mark, 'utf8'))).toBe(handed.pid);

        const next = opsd(systemLister());
        next.adopt();
        expect(next.run(run.id)).toMatchObject({ status: 'running', pid: handed.pid });
        next.kill(run.id);
        const done = await ended(next, run.id);
        expect(done.reason).toBe('killed');
        await until(() => !isAlive(handed.pid), 20_000);
        expect(as('human:dawid').view('1').claimedBy).toBeNull();
      },
      60_000,
    );
  }

  /** A lister that sees no process, as in a sandbox, but kills through the system lister. */
  const blind = (): ProcLister => {
    const real = systemLister();
    return {
      precise: true,
      clockSlack: 0,
      list: () => Promise.resolve([]),
      kill: (t) => real.kill(t),
      close: () => real.close(),
    };
  };

  for (const how of ['kill', 'stop'] as const) {
    it.runIf(process.platform === 'win32')(
      `stops the launcher and the command when the lister sees no process (${how})`,
      async () => {
        const mark = join(temp(), 'started');
        const agentPid = join(temp(), 'pid');
        const { sup, as } = setup({
          mode: 'hang',
          procs: blind(),
          env: { FAKE_MARK: mark, FAKE_PID: agentPid },
        });
        as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
        const run = sup.launch({ agent: 'fake:engineer', task: '1' });
        await until(() => existsSync(mark) && existsSync(agentPid), 20_000);
        const launcher = sup.store.get(run.id)!.pid;
        expect(launcher).not.toBe(run.shim_pid);
        expect(Number(readFileSync(mark, 'utf8'))).toBe(launcher);
        const agent = Number(readFileSync(agentPid, 'utf8'));
        try {
          if (how === 'kill') {
            sup.kill(run.id);
            expect((await ended(sup, run.id)).reason).toBe('killed');
          } else {
            sup.stop({ killRuns: true });
            await sup.close();
            expect(sup.store.get(run.id)).toMatchObject({ status: 'ended' });
          }
          await until(() => !isAlive(launcher) && !isAlive(agent), 20_000);
        } finally {
          // Only the PIDs this test's run printed.
          for (const pid of [launcher, agent]) if (isAlive(pid)) process.kill(pid);
        }
      },
      60_000,
    );
  }

  it('kills an adopted run by its recorded identity when the lister sees no process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      await until(() => processStartSync(child.pid!) !== null, 20_000);
      const start = processStartSync(child.pid!)!;
      const killed: ProcTarget[] = [];
      const lister: ProcLister = {
        precise: true,
        clockSlack: 0,
        list: () => Promise.resolve([]),
        kill: (targets) => {
          killed.push(...targets);
          for (const t of targets) process.kill(t.pid);
          return Promise.resolve(new Map(targets.map((t) => [t.pid, 'killed' as const])));
        },
        close: () => {},
      };
      const { sup, state } = setup({ procs: lister });
      sup.store.save({
        id: '01BBBBBBBBBBBBBBBBBBBBBBB4',
        agent: 'fake:engineer',
        command: 'x',
        cwd: state,
        log: join(state, 'none.log'),
        started_at: new Date().toISOString(),
        status: 'running',
        budget_minutes: 60,
        tokens: 0,
        pid: child.pid!,
        image: 'node.exe',
        proc_start: start,
      });
      sup.adopt();
      sup.kill('01BBBBBBBBBBBBBBBBBBBBBBB4');
      await until(() => sup.run('01BBBBBBBBBBBBBBBBBBBBBBB4').status === 'ended');
      expect(killed).toEqual([{ pid: child.pid!, start: startMs(start)! }]);
      await until(() => !alive(child.pid!));
    } finally {
      if (alive(child.pid!)) child.kill();
    }
  }, 60_000);

  it('warns to stop a run it cannot kill when the lister fails', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      await until(() => processStartSync(child.pid!) !== null, 20_000);
      const { sup, state } = setup({ procs: listers.failing!() });
      const warns: string[] = [];
      sup.on('warn', (m: string) => warns.push(m));
      sup.store.save({
        id: '01BBBBBBBBBBBBBBBBBBBBBBB5',
        agent: 'fake:engineer',
        command: 'x',
        cwd: state,
        log: join(state, 'none.log'),
        started_at: new Date().toISOString(),
        status: 'running',
        budget_minutes: 60,
        tokens: 0,
        pid: child.pid!,
        image: 'node.exe',
        proc_start: processStartSync(child.pid!)!,
      });
      sup.adopt();
      sup.kill('01BBBBBBBBBBBBBBBBBBBBBBB5');
      await until(() => sup.run('01BBBBBBBBBBBBBBBBBBBBBBB5').status === 'ended');
      expect(
        warns.some((w) => w.includes(`PID ${child.pid}`) && w.includes('stop it yourself')),
      ).toBe(true);
    } finally {
      child.kill();
    }
  }, 60_000);

  it.runIf(process.platform === 'win32')(
    'ends a run still launching at shutdown, before its command starts',
    async () => {
      const mark = join(temp(), 'started');
      const { sup, as } = setup({ mode: 'hang', env: { FAKE_MARK: mark } });
      as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
      // A launcher that never gets its command, as when opsd cannot record it in time.
      Object.assign(sup, { handOver: () => Promise.resolve() });
      const run = sup.launch({ agent: 'fake:engineer', task: '1' });
      sup.stop();
      await sup.close();
      expect(sup.store.get(run.id)).toMatchObject({ status: 'ended', reason: 'shutdown' });
      expect(as('human:dawid').view('1').claimedBy).toBeNull();
      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(mark)).toBe(false);
    },
    30_000,
  );

  it('rolls back a launch it cannot record, and the command never runs on Windows', async () => {
    const mark = join(temp(), 'started');
    const { sup, as } = setup({ mode: 'hang', env: { FAKE_MARK: mark } });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    const save = sup.store.save.bind(sup.store);
    let fail = true;
    sup.store.save = (r: RunRecord) => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
      save(r);
    };
    expect(() => sup.launch({ agent: 'fake:engineer', task: '1' })).toThrow(/disk full/);
    expect(sup.runs({ live: true })).toEqual([]);
    expect(as('human:dawid').view('1').claimedBy).toBeNull();
    if (process.platform === 'win32') {
      // The fake agent marks its start before it reads stdin, so it ignores a closed one.
      await new Promise((r) => setTimeout(r, 2000));
      expect(existsSync(mark)).toBe(false);
    }
  }, 30_000);

  it.runIf(process.platform === 'win32')(
    'kills a run before its launcher reports in: nothing starts',
    async () => {
      const mark = join(temp(), 'started');
      const { sup, as } = setup({ mode: 'hang', env: { FAKE_MARK: mark } });
      as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
      const run = sup.launch({ agent: 'fake:engineer', task: '1' });
      sup.kill(run.id);
      expect((await ended(sup, run.id)).reason).toBe('killed');
      expect(as('human:dawid').view('1').claimedBy).toBeNull();
      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(mark)).toBe(false);
    },
    30_000,
  );

  it('replaces a lock only when its holder is certainly gone', async () => {
    const { state } = setup();
    const env = {
      ...process.env,
      OPS_CONFIG: join(temp(), 'none.yml'),
      OPS_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    const lock = join(state, 'opsd.lock');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      await until(() => processStartSync(child.pid!) !== null, 20_000);
      // Alive, with no creation time to compare: refuse rather than guess.
      writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null }));
      await expect(runDaemon({ env, port: 0, log: () => {} })).rejects.toThrow(/cannot tell/);
      expect(existsSync(lock)).toBe(true);
      // An empty or broken lock is not proof of anything either.
      writeFileSync(lock, '');
      await expect(runDaemon({ env, port: 0, log: () => {} })).rejects.toThrow(/cannot tell/);
      // Alive with the same creation time: a running opsd.
      writeFileSync(lock, JSON.stringify({ pid: child.pid, start: processStartSync(child.pid!) }));
      await expect(runDaemon({ env, port: 0, log: () => {} })).rejects.toThrow(/already runs/);
      // Same PID, another creation time: a reused PID, so the lock is stale.
      writeFileSync(lock, JSON.stringify({ pid: child.pid, start: 'long-gone' }));
      const stopped = runDaemon({ env, port: 0, log: () => {} });
      await until(() => readDaemon(env)?.pid === process.pid);
      expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
      await stopDaemon({ env }).catch(() => false);
      await stopped;
      expect(existsSync(lock)).toBe(false);
    } finally {
      child.kill();
    }
  }, 60_000);
});

describe('lock takeover', () => {
  function daemonEnv() {
    const { repo, state } = setup();
    const userConfig = join(temp(), 'config.yml');
    writeFileSync(userConfig, 'opsd:\n  port: 0\n  sync: false\n');
    const env = {
      ...process.env,
      OPS_CONFIG: userConfig,
      OPS_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    delete env.OPS_AGENT;
    return { repo, state, env, lock: join(state, 'opsd.lock') };
  }

  it('treats a lock with its own PID but another start time as stale', async () => {
    const { env, lock } = daemonEnv();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, start: 'a-dead-opsd' }));
    const running = runDaemon({ env, port: 0, log: () => {} });
    await until(() => readDaemon(env)?.pid === process.pid);
    const held = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; start: string };
    expect(held.start).toBe(processStartSync(process.pid));
    await stopDaemon({ env }).catch(() => false);
    await running;
    expect(existsSync(lock)).toBe(false);
  }, 60_000);

  it('writes the default providers into a config without them once, with a note in its log', async () => {
    const { env } = daemonEnv();
    const lines: string[] = [];
    const running = runDaemon({ env, port: 0, log: (l) => lines.push(l) });
    await until(() => readDaemon(env)?.pid === process.pid);
    await stopDaemon({ env }).catch(() => false);
    await running;
    const text = readFileSync(env.OPS_CONFIG!, 'utf8');
    expect(text).toContain('seeded: 1');
    expect(text).toMatch(/claude:\s+command: claude/);
    // An existing config's agents are its own: none are added.
    expect(text).not.toContain('agents');
    expect(lines.filter((l) => l.includes('seeded'))).toEqual([
      expect.stringMatching(/^opsd: seeded .*: wrote providers claude, codex; edit or remove/),
    ]);
    // The next start finds it seeded and writes nothing.
    lines.length = 0;
    const again = runDaemon({ env, port: 0, log: (l) => lines.push(l) });
    await until(() => readDaemon(env)?.pid === process.pid);
    await stopDaemon({ env }).catch(() => false);
    await again;
    expect(readFileSync(env.OPS_CONFIG!, 'utf8')).toBe(text);
    expect(lines.some((l) => l.includes('seeded'))).toBe(false);
  }, 60_000);

  it('lets exactly one of three starters take over a stale lock', async () => {
    const { repo, state, env, lock } = daemonEnv();
    const gone = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    await new Promise((r) => gone.once('exit', r));
    writeFileSync(lock, JSON.stringify({ pid: gone.pid, start: 'whatever' }));
    const infos = await Promise.all([
      startDaemon({ env, cwd: repo }),
      startDaemon({ env, cwd: repo }),
      startDaemon({ env, cwd: repo }),
    ]);
    try {
      expect(new Set(infos.map((i) => i.pid)).size).toBe(1);
      const started = readFileSync(join(state, 'opsd.log'), 'utf8').match(/ on 127\.0\.0\.1:/g);
      expect(started).toHaveLength(1);
      expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(infos[0]!.pid);
      expect(existsSync(`${lock}.takeover`)).toBe(false);
    } finally {
      expect(await stopDaemon({ env })).toBe(true);
    }
  }, 90_000);
});

describe('takeover guard', () => {
  it('never displaces a takeover in progress, however long it pauses', async () => {
    const { state } = setup();
    const env = {
      ...process.env,
      OPS_CONFIG: join(temp(), 'none.yml'),
      OPS_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    const lock = join(state, 'opsd.lock');
    const guard = `${lock}.takeover`;
    // Starter A: alive, holding the guard, paused between its read and its delete.
    const a = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
    const gone = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    await new Promise((r) => gone.once('exit', r));
    try {
      await until(() => processStartSync(a.pid!) !== null, 20_000);
      const staleLock = JSON.stringify({ pid: gone.pid, start: 'dead' });
      const guardText = JSON.stringify({ pid: a.pid, start: processStartSync(a.pid!) });
      writeFileSync(lock, staleLock);
      writeFileSync(guard, guardText);
      // Make the guard look old: age alone must not matter.
      const old = new Date(Date.now() - 3600_000);
      utimesSync(guard, old, old);
      await expect(runDaemon({ env, port: 0, log: () => {} })).rejects.toThrow(
        /another opsd is starting/,
      );
      expect(readFileSync(guard, 'utf8')).toBe(guardText);
      expect(readFileSync(lock, 'utf8')).toBe(staleLock);

      // The guard's holder is certainly gone: refuse and name the file, change nothing.
      const deadGuard = JSON.stringify({ pid: gone.pid, start: 'dead' });
      writeFileSync(guard, deadGuard);
      await expect(runDaemon({ env, port: 0, log: () => {} })).rejects.toThrow(
        /crashed while taking over/,
      );
      expect(readFileSync(guard, 'utf8')).toBe(deadGuard);
      expect(readFileSync(lock, 'utf8')).toBe(staleLock);
    } finally {
      a.kill();
    }
  }, 60_000);
});

describe('push on collaboration changes', () => {
  it('sends changed when an agent posts to a channel or votes', async () => {
    const { sup, as } = setup();
    const api = await startApi(sup, { port: 0, token: 'push-token', version: 't' });
    const events: string[] = [];
    const stream = await fetch(`http://127.0.0.1:${api.port}/api/events?token=push-token`);
    const reader = stream.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        events.push(...[...dec.decode(value).matchAll(/^event: (\w+)/gm)].map((m) => m[1]!));
      }
    })();
    try {
      await until(() => events.includes('hello'));
      // Let the first signature settle before writing.
      await new Promise((r) => setTimeout(r, 500));
      as('codex:qa').post('dev', 'hello @human:dawid');
      await until(() => events.includes('changed'), 10_000);
      expect(events).not.toContain('tasks');
      const before = events.length;
      as('claude:orchestrator').propose({
        question: 'Q?',
        options: ['a', 'b'],
        voters: ['claude:qa', 'codex:qa'],
      });
      await until(() => events.length > before, 10_000);
      const mid = events.length;
      as('codex:qa').vote('D-1', 'a');
      await until(() => events.length > mid, 10_000);
      expect(events.filter((e) => e === 'changed').length).toBeGreaterThanOrEqual(3);
    } finally {
      await reader.cancel();
      await pump.catch(() => {});
      await api.close();
    }
  }, 40_000);
});

/** B starts C and exits after 3 s; C writes its PID to FAKE_MARKER and runs until killed. */
function orphanScripts(): { env: Record<string, string>; marker: string } {
  const dir = temp();
  const marker = join(dir, 'c.pid');
  const c = join(dir, 'c.cjs');
  const b = join(dir, 'b.cjs');
  writeFileSync(
    c,
    "require('fs').writeFileSync(process.env.FAKE_MARKER, String(process.pid)); setInterval(() => {}, 1000);\n",
  );
  writeFileSync(
    b,
    "require('child_process').spawn(process.execPath, [process.env.FAKE_C], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); setTimeout(() => {}, 3000);\n",
  );
  return { env: { FAKE_B: b, FAKE_C: c, FAKE_MARKER: marker }, marker };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('process ledger', () => {
  it('kills by PID only while the PID still runs the process with the recorded creation time', async () => {
    const lister = systemLister();
    const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await until(() => alive(victim.pid!));
      const me = (await lister.list()).find((p) => p.pid === victim.pid)!;
      expect(me).toBeDefined();
      if (!lister.precise) return;
      // A creation time 1 ms off stands for a PID that another process took over.
      const wrong = await lister.kill([{ pid: victim.pid!, start: me.start + 1 }]);
      expect(wrong.get(victim.pid!)).toBe('other');
      expect(alive(victim.pid!)).toBe(true);
      const right = await lister.kill([{ pid: victim.pid!, start: me.start }]);
      expect(right.get(victim.pid!)).toBe('killed');
      await until(() => !alive(victim.pid!), 10_000);
      const again = await lister.kill([{ pid: victim.pid!, start: me.start }]);
      expect(['gone', 'other']).toContain(again.get(victim.pid!));
    } finally {
      lister.close();
      if (victim.pid && alive(victim.pid)) victim.kill();
    }
  }, 30_000);

  it('records what a run started and kills a grandchild left behind after its parent exited', async () => {
    const { env, marker } = orphanScripts();
    const { sup } = setup({ mode: 'orphan', env });
    const run = sup.launch({ agent: 'fake:engineer' });
    await until(() => existsSync(marker) && readFileSync(marker, 'utf8') !== '', 15_000);
    const cPid = Number(readFileSync(marker, 'utf8'));
    try {
      await sup.trackProcs();
      expect(sup.store.procs(run.id)?.entries.map((e) => e.pid)).toEqual(
        expect.arrayContaining([run.pid, cPid]),
      );
      await ended(sup, run.id, 20_000);
      // The agent and B exited on their own; C is an orphan that only the ledger knows about.
      await until(() => !alive(cPid), 15_000);
      await until(
        () => sup.store.procs(run.id)?.entries.find((e) => e.pid === cPid)?.killed_at !== undefined,
      );
      expect(sup.run(run.id).procs_left).toBeUndefined();
      const views = await sup.procs(run.id);
      expect(views.find((v) => v.pid === cPid)).toMatchObject({ alive: false });
    } finally {
      if (alive(cPid)) process.kill(cPid);
    }
  }, 40_000);

  it('sweeps processes of ended runs at startup, but never a PID that now runs something else', async () => {
    const { sup, state } = setup();
    const keep = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await until(() => alive(keep.pid!) && alive(left.pid!));
      const lister = systemLister();
      const snap = await lister.list().finally(() => lister.close());
      const info = (pid: number) => snap.find((p) => p.pid === pid)!;
      const now = new Date().toISOString();
      const record: RunRecord = {
        id: '01KOLD0000000000000000RUN1',
        agent: 'fake:engineer',
        pid: left.pid!,
        image: 'node.exe',
        command: 'node',
        cwd: state,
        log: join(state, 'logs', 'x.log'),
        started_at: now,
        ended_at: now,
        status: 'ended',
        reason: 'exit',
        exit: 0,
        budget_minutes: 10,
        tokens: 0,
      };
      sup.store.save(record);
      const entry = (pid: number, start: number) => ({
        pid,
        ppid: 1,
        name: 'node.exe',
        cmd: 'node',
        start,
        first_seen: now,
        last_seen: now,
      });
      sup.store.saveProcs({
        run: record.id,
        root_pid: left.pid!,
        root_start: info(left.pid!).start,
        // keep's PID with another creation time stands for a PID reused by another process.
        entries: [
          entry(left.pid!, info(left.pid!).start),
          entry(keep.pid!, info(keep.pid!).start - 5000),
        ],
      });
      await sup.sweep();
      await until(() => !alive(left.pid!), 10_000);
      expect(alive(keep.pid!)).toBe(true);
      expect(sup.store.procs(record.id)?.entries[0]?.killed_at).toBeDefined();
      expect(sup.store.procs(record.id)?.entries[1]?.killed_at).toBeUndefined();
    } finally {
      for (const c of [keep, left]) if (c.pid && alive(c.pid)) c.kill();
    }
  }, 30_000);

  it('never kills an unsure process on its own, but kills it when a human picks it', async () => {
    const { sup, state } = setup();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await until(() => alive(child.pid!));
      const lister = systemLister();
      const snap = await lister.list().finally(() => lister.close());
      const start = snap.find((x) => x.pid === child.pid)!.start;
      const now = new Date().toISOString();
      const record: RunRecord = {
        id: '01KOLD0000000000000000RUN2',
        agent: 'fake:engineer',
        pid: 1,
        image: 'node.exe',
        command: 'node',
        cwd: state,
        log: join(state, 'logs', 'y.log'),
        started_at: now,
        ended_at: now,
        status: 'ended',
        reason: 'exit',
        exit: 0,
        budget_minutes: 10,
        tokens: 0,
      };
      sup.store.save(record);
      sup.store.saveProcs({
        run: record.id,
        root_pid: 1,
        root_start: null,
        entries: [
          {
            pid: child.pid!,
            ppid: 1,
            name: 'node.exe',
            cmd: 'node',
            start,
            first_seen: now,
            last_seen: now,
            unsure: true,
          },
        ],
      });
      await sup.reap(record.id);
      expect(alive(child.pid!)).toBe(true);
      expect(sup.run(record.id).procs_left).toBeUndefined();
      expect((await sup.procs(record.id))[0]).toMatchObject({ alive: true, unsure: true });
      await expect(sup.reapNow(record.id, 999_999)).rejects.toThrow(/no live process/);
      await sup.reapNow(record.id, child.pid!);
      await until(() => !alive(child.pid!), 10_000);
    } finally {
      if (child.pid && alive(child.pid)) child.kill();
    }
  }, 30_000);
});

describe('run limits', () => {
  it('runs one engineer per project and several QA runs, across projects at once', async () => {
    const { sup, as } = setup({ mode: 'hang' });
    const h = as('human:dawid');
    h.newTask({ title: 'site work', owner: 'fake:engineer', project: 'site' });
    h.newTask({ title: 'ops work', owner: 'fake:engineer', project: 'ops' });
    h.newTask({ title: 'more site work', owner: 'fake:engineer', project: 'site' });
    const a = sup.launch({ agent: 'fake:engineer', task: '1' });
    // Another project's engineer works in another checkout: one writing run per checkout.
    const b = sup.launch({ agent: 'fake:engineer', task: '2', cwd: temp() });
    expect(a.project).toBe('site');
    expect(b.project).toBe('ops');
    expect(() => sup.launch({ agent: 'fake:engineer', task: '3' })).toThrow(
      /1 engineer run\(s\) live on site; per_project is 1/,
    );
    for (let i = 0; i < 3; i++) sup.launch({ agent: 'fake:qa' });
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(
      /3 qa run\(s\) live on test; per_project is 3/,
    );
    expect(sup.runs({ live: true })).toHaveLength(5);
  });

  it('counts every provider against the role limit', () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: {
        runtimes: {
          other: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
        },
      },
    });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer', project: 'site' });
    as('human:dawid').newTask({ title: 'y', project: 'site' });
    sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(() => sup.launch({ agent: 'other:engineer', task: '2' })).toThrow(
      /1 engineer run\(s\) live on site/,
    );
  });

  it('binds a claim held without a run to the run it launches', async () => {
    const { sup, as, repo } = setup({ mode: 'hang' });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    as('fake:engineer').claim('1');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(new Root(join(repo, '.agent-ops')).claimRecord('T-0001').run).toBe(run.id);
    const asRun = (id: string) =>
      new Workspace({
        cwd: repo,
        env: { OPS_CONFIG: 'none.yml' },
        actor: 'fake:engineer',
        run: id,
        user: {},
      });
    expect(asRun(run.id).holdsClaim('1')).toBe(true);
    expect(asRun('OTHER').holdsClaim('1')).toBe(false);
  });

  it('never renews or releases a claim that another run of the agent took over', async () => {
    const { sup, as, repo } = setup({ mode: 'hang' });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    // The claim now belongs to run B, as after A lost it and B claimed again.
    new Workspace({
      cwd: repo,
      env: { OPS_CONFIG: 'none.yml' },
      actor: 'fake:engineer',
      run: 'B',
      user: {},
    }).bindClaim('1');
    sup.kill(run.id);
    await ended(sup, run.id);
    const v = as('human:dawid').view('1');
    expect(v.claimedBy).toBe('fake:engineer');
    expect(
      as('human:dawid')
        .showEvents('1')
        .events.map((e) => e.type),
    ).not.toContain('release');
  });

  it('keeps to max_runs on this PC', () => {
    const { sup } = setup({ mode: 'hang', opsd: { max_runs: 1 } });
    sup.launch({ agent: 'fake:qa' });
    expect(() => sup.launch({ agent: 'fake:engineer' })).toThrow(/1 runs live; max_runs is 1/);
  });

  it('gives each run its own claim, so two runs of one agent id cannot act on each other', async () => {
    const { sup, as } = setup({ mode: 'hang' });
    as('human:dawid').newTask({ title: 'site', owner: 'fake:engineer', project: 'site' });
    as('human:dawid').newTask({ title: 'ops', owner: 'fake:engineer', project: 'ops' });
    const a = sup.launch({ agent: 'fake:engineer', task: '1' });
    const b = sup.launch({ agent: 'fake:engineer', task: '2', cwd: temp() });
    const runA = as('fake:engineer');
    const asRun = (run: string) =>
      new Workspace({
        cwd: runA.roots[0]!.dir,
        env: { OPS_CONFIG: 'none.yml' },
        actor: 'fake:engineer',
        run,
        user: {},
      });
    expect(asRun(a.id).holdsClaim('1')).toBe(true);
    expect(asRun(b.id).holdsClaim('1')).toBe(false);
    expect(() => asRun(b.id).release('1', 'not mine')).toThrow(/another run on this PC/);
    // opsd itself acts for every run it started.
    expect(sup.ws('fake:engineer').holdsClaim('1')).toBe(true);
  });

  it('keeps to the PC, provider and role settings', () => {
    let free = 64 * 2 ** 30;
    const { sup } = setup({
      mode: 'hang',
      freeMem: () => free,
      opsd: {
        max_runs: 4,
        roles: { qa: { per_project: 10, max_live: 3 } },
        runtimes: {
          fake: {
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            max_live: 2,
          },
        },
      },
    });
    sup.launch({ agent: 'fake:qa' });
    sup.launch({ agent: 'fake:qa' });
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(/2 fake runs live; max_live is 2/);
    expect(sup.blocker('fake:qa', 'test')).toMatch(/max_live is 2/);
    free = 2 * 2 ** 30;
    expect(sup.blocker('other:engineer', 'test')).toMatch(
      /2\.0 GB of memory free; min_free_gb is 4/,
    );
  });

  it('pauses new runs on a provider whose usage reached the threshold, until it resets', async () => {
    let now = Date.now();
    const reset = Math.floor(now / 1000) + 3600;
    const { sup, state } = setup({
      mode: 'limited',
      env: { FAKE_RESET: String(reset) },
      now: () => now,
    });
    const r = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r.id);
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(
      /fake usage at 95% of the seven_day window \(pause at 90%\)/,
    );
    expect(sup.usageReport().fake).toMatchObject({ paused: expect.stringMatching(/95%/), live: 0 });
    expect(
      JSON.parse(readFileSync(join(state, 'usage.json'), 'utf8')).fake.windows.seven_day,
    ).toMatchObject({
      utilization: 0.95,
    });
    now = reset * 1000 + 1000;
    expect(sup.blocker('fake:qa', 'test')).toBeNull();
  });

  it('wakes one run per task, skipping projects that are full', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      // Counts projects only: a role that writes also gets one run per checkout.
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        roles: { engineer: { writes: false, per_project: 1 } },
      },
    });
    const h = as('human:dawid');
    h.newTask({ title: 'a1', owner: 'fake:engineer', project: 'a', priority: 'p1' });
    h.newTask({ title: 'a2', owner: 'fake:engineer', project: 'a', priority: 'p1' });
    h.newTask({ title: 'b1', owner: 'fake:engineer', project: 'b', priority: 'p2' });
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live.map((r) => r.task).sort()).toEqual(['T-0001', 'T-0003']);
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(2);
  });

  it('counts a task with no project and one under an old name as one project', async () => {
    const { repo, sup, as } = setup({
      mode: 'hang',
      // Counts projects only: a role that writes also gets one run per checkout.
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        roles: { engineer: { writes: false, per_project: 1 } },
      },
    });
    const h = as('human:dawid');
    h.newTask({ title: 'old name', owner: 'fake:engineer', project: 'v2', priority: 'p1' });
    h.newTask({ title: 'no project', owner: 'fake:engineer', priority: 'p1' });
    h.newTask({ title: 'other', owner: 'fake:engineer', project: 'b', priority: 'p2' });
    // Mapped after the tasks were filed: their task.md still says v2.
    const config = join(repo, '.agent-ops', 'config.yml');
    writeFileSync(config, `${readFileSync(config, 'utf8')}project_aliases:\n  v2: test\n`);
    await sup.tick();
    const live = sup.runs({ live: true }).map((r) => [r.task, r.project]);
    expect(live.sort()).toEqual([
      ['T-0001', 'test'],
      ['T-0003', 'b'],
    ]);
    expect(sup.waits().map((w) => w.reason)).toEqual([
      'fake:engineer: 1 engineer run(s) live on test; per_project is 1',
    ]);
  });

  it('runs one writing run per checkout, whatever project its task names', async () => {
    const { repo, sup, as } = setup({ mode: 'hang' });
    const h = as('human:dawid');
    h.newTask({ title: 'labeled', owner: 'fake:engineer', project: 'v2' });
    h.newTask({ title: 'unlabeled', owner: 'fake:engineer' });
    h.newTask({ title: 'docs', owner: 'fake:writer', project: 'docs' });
    const a = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(a.project).toBe('v2');
    // Another project in the same checkout, by the same role or another role that writes.
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2' })).toThrow(
      /fake:engineer works on test\/T-0001 in .+; one writing run per checkout/,
    );
    expect(() => sup.launch({ agent: 'fake:writer', task: '3' })).toThrow(
      /one writing run per checkout/,
    );
    // The checkout is one folder however its path is spelled.
    const spelled = process.platform === 'win32' ? repo.toUpperCase() : join(repo, '.');
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2', cwd: spelled })).toThrow(
      /one writing run per checkout/,
    );
    // Roles that only read share it; a run in another checkout starts.
    sup.launch({ agent: 'fake:qa' });
    sup.launch({ agent: 'fake:engineer', task: '2', cwd: temp() });
    expect(sup.runs({ live: true })).toHaveLength(3);
  });

  it('counts a run in a subfolder of a checkout as a run in that checkout', async () => {
    const tmp = temp();
    const sub = (name: string) => join(tmp, 'repo', 'packages', name);
    const { repo, sup, as } = setup({
      mode: 'hang',
      repo: join(tmp, 'repo'),
      opsd: { agents: { 'fake:writer': { cwd: sub('docs') } } },
    });
    for (const name of ['core', 'cli', 'docs']) mkdirSync(sub(name), { recursive: true });
    const h = as('human:dawid');
    h.newTask({ title: 'core', owner: 'fake:engineer', project: 'v2' });
    h.newTask({ title: 'cli', owner: 'fake:engineer', project: 'other' });
    h.newTask({ title: 'docs', owner: 'fake:writer', project: 'docs' });
    sup.launch({ agent: 'fake:engineer', task: '1', cwd: sub('core') });
    // An explicit launch folder in another subfolder of the same checkout.
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2', cwd: sub('cli') })).toThrow(
      /one writing run per checkout/,
    );
    // The checkout's top, and an agent whose configured folder is a subfolder of it.
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2', cwd: repo })).toThrow(
      /one writing run per checkout/,
    );
    expect(() => sup.launch({ agent: 'fake:writer', task: '3' })).toThrow(
      /one writing run per checkout/,
    );
    expect(sup.runs({ live: true })).toHaveLength(1);
  });

  it('wakes no second writing run in a checkout, and says why it waits', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const h = as('human:dawid');
    const a = h.newTask({ title: 'a', owner: 'fake:engineer', project: 'v2', priority: 'p1' });
    const b = h.newTask({ title: 'b', owner: 'fake:engineer', priority: 'p2' });
    expect(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason])).toEqual([
      [a.id, 'starts at the next tick'],
      [b.id, expect.stringMatching(/^fake:engineer: fake:engineer works on test\/T-0001 in /)],
    ]);
    await sup.tick();
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.task)).toEqual([a.id]);
  });
});

describe('questions (AO-0063)', () => {
  it('runs a question beside work in its project and checkout, and never counts it', () => {
    const { sup, as } = setup({ mode: 'hang' });
    const h = as('human:dawid');
    h.newTask({ title: 'work', owner: 'fake:engineer' });
    h.newTask({ title: 'Is T-0001 on track?', type: 'question', owner: 'fake:engineer' });
    h.newTask({ title: 'more work', owner: 'fake:engineer' });
    sup.launch({ agent: 'fake:engineer', task: 'T-0001' });
    const q = sup.launch({ agent: 'fake:engineer', task: 'T-0002' });
    expect(q.question).toBe(true);
    expect(as('human:dawid').view('2').claimedBy).toBe('fake:engineer');
    // Work still meets the limits, counting the work run only.
    expect(() => sup.launch({ agent: 'fake:engineer', task: 'T-0003' })).toThrow(
      /1 engineer run\(s\) live on test; per_project is 1/,
    );
    expect(sup.runs({ live: true })).toHaveLength(2);
  });

  it('wakes the agent for a question while its work run holds the project', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const h = as('human:dawid');
    h.newTask({ title: 'work', owner: 'fake:engineer', priority: 'p1' });
    h.newTask({ title: 'Why?', type: 'question', owner: 'fake:engineer', priority: 'p3' });
    h.newTask({ title: 'more work', owner: 'fake:engineer', priority: 'p1' });
    sup.launch({ agent: 'fake:engineer', task: 'T-0001' });
    expect(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason])).toEqual([
      ['T-0002', 'starts at the next tick'],
      ['T-0003', expect.stringMatching(/per_project is 1/)],
    ]);
    await sup.tick();
    expect(
      sup
        .runs({ live: true })
        .map((r) => r.task)
        .sort(),
    ).toEqual(['T-0001', 'T-0002']);
  });

  it('puts the question, its asker and what it references in the prompt', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'work', owner: 'fake:engineer' });
    h.newTask({
      title: 'Is T-0001 on track?',
      body: 'Compare T-0001 with T-0009 in project:test.',
      type: 'question',
      owner: 'fake:qa',
    });
    const ws = as('fake:qa');
    const prompt = runPrompt({
      agent: 'fake:qa',
      task: 'T-0002',
      question: questionPrompt(ws, 'test/T-0002', ws.view('test/T-0002')),
    });
    expect(prompt).toContain('Answer the question T-0002 from human:dawid.');
    expect(prompt).toContain('Question: Is T-0001 on track?');
    expect(prompt).toContain('> Compare T-0001 with T-0009 in project:test.');
    // T-0009 does not exist: the text keeps it, the list leaves it out.
    expect(prompt).toContain('- T-0001 (todo): work\n\nProjects');
    expect(prompt).toContain('- test\n');
    expect(prompt).toContain(`\`ops done T-0002 "your answer"\`: the answer goes to human:dawid`);
    expect(prompt).not.toContain('Work on T-0002');
    expect(prompt).not.toContain('If you cannot commit');
  });

  it('carries earlier answers and the reply a reopened question asks (AO-0134)', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'work', owner: 'fake:engineer' });
    h.newTask({ title: 'Can we talk here?', type: 'question', owner: 'fake:qa' });
    const qa = as('fake:qa');
    qa.start('T-0002', 'answer');
    qa.done('T-0002', 'Yes, ask away.');
    h.reopen('T-0002', 'Then: is T-0001 on track?');
    const prompt = runPrompt({
      agent: 'fake:qa',
      task: 'T-0002',
      question: questionPrompt(qa, 'test/T-0002', qa.view('test/T-0002')),
    });
    expect(prompt).toContain(
      'The conversation so far, oldest first:\n- fake:qa answered:\n  > Yes, ask away.\n' +
        '- human:dawid replied:\n  > Then: is T-0001 on track?\n\n' +
        'Answer the latest reply; you need not repeat earlier answers.',
    );
    // A reply's references count like the question's.
    expect(prompt).toContain('- T-0001 (todo): work');
  });
});

describe('bottlenecks and providers', () => {
  const HANG = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };

  /** A task written by codex:engineer that now waits for fake:qa's review. */
  function inReview(as: (a: string) => Workspace, title: string, project: string): string {
    const meta = as('human:dawid').newTask({ title, owner: 'codex:engineer', project });
    const author = as('codex:engineer');
    author.start(meta.id, 'plan');
    author.review(meta.id, 'please check', 'fake:qa');
    return meta.id;
  }

  it('gives each review request one run, holding no claim', async () => {
    const { sup, as } = setup({ mode: 'hang', opsd: { agents: { 'fake:qa': { wake: true } } } });
    const id = inReview(as, 'x', 'a');
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ agent: 'fake:qa', task: id, review: true, project: 'a' });
    expect(as('human:dawid').view(id).status).toBe('needs-review');
    expect(() => sup.launch({ agent: 'fake:qa', task: id, review: true })).toThrow(
      /already has a live run/,
    );
    sup.kill(live[0]!.id);
    await ended(sup, live[0]!.id);
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(0);
    expect(() => sup.launch({ agent: 'fake:engineer', task: id, review: true })).toThrow(
      /does not wait for fake:engineer's review/,
    );
  });

  it('puts reviews first and holds new work where reviews pile up', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:qa': { wake: true }, 'fake:engineer': { wake: true } } },
    });
    for (let i = 0; i < 4; i++) inReview(as, `review ${i}`, 'a');
    const urgent = as('human:dawid').newTask({
      title: 'urgent',
      owner: 'fake:engineer',
      project: 'a',
      priority: 'p0',
    });
    const other = as('human:dawid').newTask({
      title: 'other',
      owner: 'fake:engineer',
      project: 'b',
      priority: 'p3',
    });
    await sup.tick();
    const live = sup.runs({ live: true });
    // Four reviews in a project with a backlog: QA bursts past its 3 per project.
    expect(live.filter((r) => r.review)).toHaveLength(4);
    // No new work in project a until its reviews are back under the backlog; b goes ahead.
    expect(live.filter((r) => !r.review).map((r) => r.task)).toEqual([other.id]);
    expect(as('human:dawid').view(urgent.id).status).toBe('todo');
  });

  it('gives a review sent again after changes a new run', async () => {
    const { sup, as } = setup({ mode: 'hang', opsd: { agents: { 'fake:qa': { wake: true } } } });
    const id = inReview(as, 'x', 'a');
    await sup.tick();
    const first = sup.runs({ live: true })[0]!;
    sup.kill(first.id);
    await ended(sup, first.id);
    as('fake:qa').verdict(id, 'changes', 'fix the thing');
    as('codex:engineer').start(id, 'fix');
    as('codex:engineer').review(id, 'fixed', 'fake:qa');
    await sup.tick();
    const second = sup.runs({ live: true });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ task: id, review: true });
    expect(second[0]!.id).not.toBe(first.id);
  });

  it('takes *:role tasks only from listed providers, and waits for the first without overflow', async () => {
    const both = { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } };
    const unlisted = setup({
      mode: 'hang',
      opsd: {
        agents: both,
        runtimes: { other: HANG, fake: { ...HANG, max_live: 0 } },
        roles: { engineer: { providers: ['fake'] } },
      },
    });
    unlisted.as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    await unlisted.sup.tick();
    expect(unlisted.sup.runs({ live: true })).toHaveLength(0);

    const absent = setup({
      mode: 'hang',
      opsd: {
        agents: { 'other:engineer': { wake: true } },
        runtimes: { other: HANG },
        roles: { engineer: { providers: ['fake', 'other'], overflow: false } },
      },
    });
    absent.as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    await absent.sup.tick();
    expect(absent.sup.runs({ live: true })).toHaveLength(0);
  });

  it('never hands a *:role task to the provider of the reviewer it expects', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } },
        runtimes: { other: HANG, fake: HANG },
        roles: { engineer: { providers: ['fake', 'other'] } },
      },
    });
    const t = as('human:dawid').newTask({ title: 'x' });
    as('human:dawid').delegate(t.id, '*:engineer', { review: 'fake:qa' });
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.agent)).toEqual(['other:engineer']);
  });

  it('plans with each planned run counted, and reports what wake then does', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      // Counts projects only: a role that writes also gets one run per checkout.
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        roles: { engineer: { writes: false, per_project: 1 } },
      },
    });
    const h = as('human:dawid');
    const a1 = h.newTask({ title: 'a1', owner: 'fake:engineer', project: 'a' });
    const a2 = h.newTask({ title: 'a2', owner: 'fake:engineer', project: 'a' });
    const b1 = h.newTask({ title: 'b1', owner: 'fake:engineer', project: 'b' });
    const plan = sup.waits();
    // a1 starts; then b's project has fewer runs than a's, so b1 comes before a2, which waits.
    expect(plan.map((w) => [w.task?.split('/').pop(), w.reason])).toEqual([
      [a1.id, 'starts at the next tick'],
      [b1.id, 'starts at the next tick'],
      [a2.id, 'fake:engineer: 1 engineer run(s) live on a; per_project is 1'],
    ]);
    await sup.tick();
    expect(
      sup
        .runs({ live: true })
        .map((r) => r.task)
        .sort(),
    ).toEqual([a1.id, b1.id].sort());
    expect(sup.waits().map((w) => w.task?.split('/').pop())).toEqual([a2.id]);
  });

  it('counts planned runs against max_runs, resumes answered work first, and reads inboxes last', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { max_runs: 1, agents: { 'fake:engineer': { wake: true } } },
    });
    const h = as('human:dawid');
    const fresh = h.newTask({
      title: 'fresh',
      owner: 'fake:engineer',
      project: 'a',
      priority: 'p0',
    });
    const asked = h.newTask({
      title: 'asked',
      owner: 'fake:engineer',
      project: 'b',
      priority: 'p3',
    });
    as('fake:engineer').start(asked.id, 'plan');
    as('fake:engineer').ask(asked.id, 'which one?');
    h.answer(asked.id, 'the second');
    h.comment(fresh.id, 'a note for you', 'fake:engineer');
    const plan = sup.waits();
    expect(plan.map((w) => [w.kind, w.task?.split('/').pop() ?? null, w.reason])).toEqual([
      ['task', asked.id, 'starts at the next tick'],
      ['task', fresh.id, 'fake:engineer: 1 runs live; max_runs is 1'],
      ['inbox', null, 'a run of fake:engineer is live or starting'],
    ]);
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.task)).toEqual([asked.id]);
    // The run reads its own task, not the note on the other one: that still waits for an inbox run.
    expect(sup.waits().map((w) => [w.kind, w.reason])).toEqual([
      ['task', 'fake:engineer: 1 runs live; max_runs is 1'],
      ['inbox', 'a run of fake:engineer is live or starting'],
    ]);
  });

  it('still wakes an inbox run for a message after a task run on another task ended', async () => {
    const { sup, as } = setup({
      mode: 'done',
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const h = as('human:dawid');
    const mine = h.newTask({ title: 'mine', owner: 'fake:engineer' });
    const other = h.newTask({ title: 'other', owner: 'codex:engineer' });
    h.comment(other.id, 'please look at this', 'fake:engineer');
    await sup.tick();
    const first = sup.runs({ live: true });
    expect(first.map((r) => r.task)).toEqual([mine.id]);
    await ended(sup, first[0]!.id);
    await sup.tick();
    const second = sup.runs().filter((r) => r.id !== first[0]!.id);
    expect(second).toHaveLength(1);
    expect(second[0]!.task).toBeUndefined();
  });

  it('starts an inbox run for new items when there is no task to claim', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const t = as('human:dawid').newTask({ title: 'someone else', owner: 'codex:engineer' });
    as('human:dawid').comment(t.id, 'have a look', 'fake:engineer');
    expect(sup.waits().map((w) => [w.kind, w.reason])).toEqual([
      ['inbox', 'starts at the next tick'],
    ]);
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live).toHaveLength(1);
    expect(live[0]!.task).toBeUndefined();
    expect(sup.waits()).toEqual([]);
  });

  /** A role that writes nothing yet takes work: qa and reviewer take only questions (AO-0136). */
  const AUDITOR = { auditor: { writes: false } };

  it('starts no task run beside a live inbox run of the same agent', async () => {
    // AO-0128: a verdict woke an inbox run, then a task run of the same agent on the same
    // task, and both did the work. The auditor writes nothing, so no checkout rule stops the
    // second.
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:auditor': { wake: true } }, roles: AUDITOR },
    });
    const h = as('human:dawid');
    const other = h.newTask({ title: 'other', owner: 'codex:engineer' });
    h.comment(other.id, 'have a look', 'fake:auditor');
    await sup.tick();
    const inbox = sup.runs({ live: true });
    expect(inbox.map((r) => r.task)).toEqual([undefined]);
    const t = h.newTask({ title: 'merge', owner: 'fake:auditor' });
    as('fake:auditor').start(t.id, 'plan');
    as('fake:auditor').review(t.id, 'merged', 'codex:qa');
    as('codex:qa').verdict(t.id, 'changes', 'resolve the conflict');
    expect(sup.waits().filter((w) => w.kind === 'task')).toMatchObject([
      { reason: 'fake:auditor: an inbox run of fake:auditor is live or starting' },
    ]);
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.id)).toEqual([inbox[0]!.id]);
    // Once the inbox run ends, exactly one run takes the task.
    sup.kill(inbox[0]!.id);
    await ended(sup, inbox[0]!.id);
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.task)).toEqual([t.id]);
  });

  it('starts a task run beside a live scheduled run with its own prompt', async () => {
    // A scheduled run on its own prompt reads no inbox, so it holds no task of the agent back.
    const { sup, as } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:auditor': { wake: true } },
        roles: AUDITOR,
        schedules: [
          { name: 'sweep', every: '24h', agent: 'fake:auditor', prompt: 'Sweep the PRs.' },
        ],
      },
    });
    await sup.tick();
    const sched = sup.runs({ live: true });
    expect(sched.map((r) => [r.schedule, r.inbox])).toEqual([['sweep', undefined]]);
    const t = as('human:dawid').newTask({ title: 'merge', owner: 'fake:auditor' });
    expect(sup.waits().filter((w) => w.kind === 'task')).toMatchObject([
      { reason: 'starts at the next tick' },
    ]);
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live.map((r) => r.task).sort()).toEqual([t.id, undefined].sort());
  });

  it('starts a task run beside a live run with an empty custom prompt', async () => {
    // An empty --prompt-file still replaces the standard prompt, so the run reads no inbox.
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:auditor': { wake: true } }, roles: AUDITOR },
    });
    const own = sup.launch({ agent: 'fake:auditor', prompt: '' });
    expect(own.inbox).toBeUndefined();
    const t = as('human:dawid').newTask({ title: 'merge', owner: 'fake:auditor' });
    expect(sup.waits().filter((w) => w.kind === 'task')).toMatchObject([
      { reason: 'starts at the next tick' },
    ]);
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live.map((r) => r.task).sort()).toEqual([t.id, undefined].sort());
  });

  it('lists work owned by or waiting for an id no agent answers to', () => {
    const { sup, as, repo } = setup({ mode: 'hang' });
    // Written before any agent is defined, as tasks from before the check were.
    const h = as('human:dawid');
    const owned = h.newTask({ title: 'release', owner: 'claude:release' });
    const fine = h.newTask({ title: 'fine', owner: 'fake:engineer' });
    const review = h.newTask({ title: 'review', owner: 'fake:engineer' });
    as('fake:engineer').start(review.id, 'go');
    as('fake:engineer').review(review.id, 'ready', 'codex:backend');
    const later = h.newTask({ title: 'later', owner: 'claude:copywriter', blockedBy: [owned.id] });
    writeFileSync(
      join(repo, '.agent-ops', 'agents', 'fake-engineer.md'),
      '---\nid: fake:engineer\n---\n',
    );
    const stranded = sup.waits().filter((w) => w.agents.length === 0);
    expect(stranded.map((w) => [w.task?.split('/').pop(), w.kind, w.reason])).toEqual([
      [owned.id, 'task', 'owner claude:release is not a configured agent'],
      [review.id, 'review', 'reviewer codex:backend is not a configured agent'],
      [later.id, 'task', 'owner claude:copywriter is not a configured agent'],
    ]);
    expect(stranded.map((w) => w.task)).not.toContain(fine.id);
    expect(
      as('human:dawid')
        .inbox()
        .filter((i) => i.kind === 'stranded'),
    ).toHaveLength(3);
  });

  it('reports what waits and why, without starting anything', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:qa': { wake: true }, 'fake:engineer': { wake: true } } },
    });
    for (let i = 0; i < 3; i++) inReview(as, `review ${i}`, 'a');
    const held = as('human:dawid').newTask({ title: 'held', owner: 'fake:engineer', project: 'a' });
    const busy = as('human:dawid').newTask({ title: 'busy', owner: 'fake:engineer', project: 'b' });
    const next = as('human:dawid').newTask({ title: 'next', owner: 'fake:engineer', project: 'b' });
    sup.launch({ agent: 'fake:engineer', task: busy.id });
    const waits = sup.waits();
    expect(sup.runs({ live: true })).toHaveLength(1);
    const byTask = new Map(waits.map((w) => [(w.task ?? '').split('/').pop(), w]));
    expect(waits.slice(0, 3).every((w) => w.review)).toBe(true);
    expect(waits[0]!.reason).toBe('starts at the next tick');
    expect(byTask.get(held.id)?.reason).toMatch(/3 reviews wait in a; new work there waits/);
    expect(byTask.get(next.id)?.reason).toMatch(/1 engineer run\(s\) live on b; per_project is 1/);
    expect(byTask.has(busy.id)).toBe(false);
  });

  it('does not hold writers for reviews that wait for a person or an unknown agent', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:qa': { wake: false }, 'fake:engineer': { wake: true } } },
    });
    const send = (title: string, reviewer: string): void => {
      const meta = as('human:dawid').newTask({ title, owner: 'codex:engineer', project: 'a' });
      as('codex:engineer').start(meta.id, 'plan');
      as('codex:engineer').review(meta.id, 'check', reviewer);
    };
    for (let i = 0; i < 3; i++) send(`human ${i}`, 'human:dawid');
    for (let i = 0; i < 3; i++) send(`unknown ${i}`, 'other:backend');
    const work = as('human:dawid').newTask({ title: 'work', owner: 'fake:engineer', project: 'a' });
    const byTask = new Map(sup.waits().map((w) => [(w.task ?? '').split('/').pop(), w]));
    expect(byTask.get(work.id)?.reason).toBe('starts at the next tick');
    for (let i = 0; i < 3; i++) send(`agent ${i}`, 'fake:qa');
    const held = new Map(sup.waits().map((w) => [(w.task ?? '').split('/').pop(), w]));
    expect(held.get(work.id)?.reason).toMatch(/3 reviews wait in a; new work there waits/);
  });

  it('hands a *:engineer task to the next provider when the preferred one has no room', async () => {
    const opsd = (fake: Record<string, unknown>, roles: Record<string, unknown> = {}) => ({
      agents: { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } },
      runtimes: { other: HANG, fake: { ...HANG, ...fake } },
      roles: { engineer: { providers: ['fake', 'other'], ...roles } },
    });
    const first = setup({ mode: 'hang', opsd: opsd({}) });
    first.as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    await first.sup.tick();
    expect(first.sup.runs({ live: true }).map((r) => r.agent)).toEqual(['fake:engineer']);

    const full = setup({ mode: 'hang', opsd: opsd({ max_live: 0 }) });
    full.as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    await full.sup.tick();
    expect(full.sup.runs({ live: true }).map((r) => r.agent)).toEqual(['other:engineer']);

    const pinned = setup({ mode: 'hang', opsd: opsd({ max_live: 0 }, { overflow: false }) });
    pinned.as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    await pinned.sup.tick();
    expect(pinned.sup.runs({ live: true })).toHaveLength(0);
  });
});

describe('helper runs', () => {
  it('starts helpers under the parent claim, within limits, and stops them with the parent', async () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: {
        runtimes: {
          fake: {
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            max_live: 3,
          },
        },
      },
    });
    as('human:dawid').newTask({ title: 'main', owner: 'fake:engineer', project: 'site' });
    as('human:dawid').newTask({ title: 'second', owner: 'fake:engineer', project: 'site' });
    const parent = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(() => sup.launch({ agent: 'fake:engineer', parent: parent.id })).toThrow(
      /needs a prompt/,
    );
    const a = sup.launch({ agent: 'fake:engineer', parent: parent.id, prompt: 'look up X' });
    const b = sup.launch({ agent: 'fake:explorer', parent: parent.id, prompt: 'look up Y' });
    expect(a).toMatchObject({
      parent: parent.id,
      task: 'T-0001',
      project: 'site',
      cwd: parent.cwd,
    });
    expect(b.parent).toBe(parent.id);
    // The claim stays the parent's; a helper cannot act on it.
    expect(new Root(join(repo, '.agent-ops')).claimRecord('T-0001').run).toBe(parent.id);
    const asRun = (run: string) =>
      new Workspace({
        cwd: repo,
        env: { OPS_CONFIG: 'none.yml' },
        actor: 'fake:engineer',
        run,
        user: {},
      });
    expect(() => asRun(a.id).progress('1', 'x')).toThrow(/another run/);
    // Helpers count against the provider (3 fake runs live), not the role per project.
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(/3 fake runs live; max_live is 3/);
    expect(() => sup.launch({ agent: 'fake:engineer', parent: parent.id, prompt: 'z' })).toThrow(
      /max_children is 2|max_live is 3/,
    );
    expect(() => sup.launch({ agent: 'fake:qa', parent: a.id, prompt: 'z' })).toThrow(
      /cannot start helpers of its own/,
    );
    sup.kill(parent.id);
    const [ea, eb] = await Promise.all([ended(sup, a.id), ended(sup, b.id)]);
    expect(ea.reason).toBe('parent-ended');
    expect(eb.reason).toBe('parent-ended');
  });

  it('starts helpers only for a run that works on a task it still holds, in its folder', async () => {
    const { sup, as, repo, state } = setup({ mode: 'hang', opsd: { agents: {} } });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    as('human:dawid').newTask({ title: 'y', owner: 'codex:engineer' });
    const taskless = sup.launch({ agent: 'fake:qa' });
    expect(() => sup.launch({ agent: 'fake:qa', parent: taskless.id, prompt: 'p' })).toThrow(
      /only a run working on a task/,
    );
    as('codex:engineer').start('2', 'plan');
    as('codex:engineer').review('2', 'check', 'fake:qa');
    const reviewer = sup.launch({ agent: 'fake:qa', task: '2', review: true });
    expect(() => sup.launch({ agent: 'fake:qa', parent: reviewer.id, prompt: 'p' })).toThrow(
      /only a run working on a task/,
    );
    const parent = sup.launch({ agent: 'fake:engineer', task: '1' });
    const helper = sup.launch({
      agent: 'fake:engineer',
      parent: parent.id,
      prompt: 'p',
      cwd: state,
    });
    expect(helper.cwd).toBe(parent.cwd);
    // The parent lost its claim to another run: no more helpers.
    new Workspace({
      cwd: repo,
      env: { OPS_CONFIG: 'none.yml' },
      actor: 'fake:engineer',
      run: 'B',
      user: {},
    }).bindClaim('1');
    expect(() => sup.launch({ agent: 'fake:explorer', parent: parent.id, prompt: 'p' })).toThrow(
      /no longer holds/,
    );
  });

  it('ends a helper adopted after a restart when its parent already ended', async () => {
    const { sup, state } = setup();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      await until(() => processStartSync(child.pid!) !== null, 20_000);
      const base = {
        agent: 'fake:engineer',
        command: 'x',
        cwd: state,
        log: join(state, 'none.log'),
        started_at: new Date().toISOString(),
        budget_minutes: 60,
        tokens: 0,
        image: 'node.exe',
        task: 'T-0001',
        root: 'test',
      };
      sup.store.save({
        ...base,
        id: '01PARENT00000000000000000A',
        pid: 1,
        status: 'ended',
        ended_at: new Date().toISOString(),
        reason: 'exit',
        exit: 0,
      });
      sup.store.save({
        ...base,
        id: '01CHILD000000000000000000A',
        pid: child.pid!,
        proc_start: processStartSync(child.pid!)!,
        status: 'running',
        parent: '01PARENT00000000000000000A',
      });
      sup.adopt();
      expect(sup.runs({ live: true }).map((r) => r.id)).toEqual(['01CHILD000000000000000000A']);
      await sup.tick();
      await until(() => sup.run('01CHILD000000000000000000A').status === 'ended', 20_000);
      expect(sup.run('01CHILD000000000000000000A').reason).toBe('parent-ended');
      await until(() => !alive(child.pid!), 20_000);
    } finally {
      if (child.pid && alive(child.pid)) child.kill();
    }
  }, 60_000);

  it('keeps to max_children and leaves the role limit to the parent', () => {
    const { sup, as } = setup({ mode: 'hang', opsd: { roles: { engineer: { max_children: 1 } } } });
    as('human:dawid').newTask({ title: 'main', owner: 'fake:engineer', project: 'site' });
    as('human:dawid').newTask({ title: 'second', owner: 'fake:engineer', project: 'site' });
    const parent = sup.launch({ agent: 'fake:engineer', task: '1' });
    sup.launch({ agent: 'fake:engineer', parent: parent.id, prompt: 'help' });
    expect(() => sup.launch({ agent: 'fake:engineer', parent: parent.id, prompt: 'more' })).toThrow(
      /has 1 helper\(s\) live; max_children is 1/,
    );
    // One engineer on site: the parent; its helper does not take a second slot or free one.
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2' })).toThrow(
      /1 engineer run\(s\) live on site/,
    );
    expect(() => sup.launch({ agent: 'fake:engineer', parent: 'NOPE', prompt: 'x' })).toThrow(
      /parent run NOPE is not live/,
    );
  });
});

describe('usage-limit errors', () => {
  it('keeps the reset a provider reported when an error without one comes with it', async () => {
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 7200;
    const { sup } = setup({ mode: 'hit-both', env: { FAKE_RESET: String(reset) }, now: () => now });
    const r = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r.id);
    expect(sup.usageReport().fake?.limited_until).toBe(reset * 1000);
  });

  it('pauses a provider until the reset its limit error names, or for the cooldown', async () => {
    let now = Date.now();
    const reset = Math.floor(now / 1000) + 7200;
    const named = setup({ mode: 'hit', env: { FAKE_RESET: String(reset) }, now: () => now });
    const r = named.sup.launch({ agent: 'fake:qa' });
    await ended(named.sup, r.id);
    expect(named.sup.blocker('fake:qa', 'test')).toMatch(/fake refused work \(usage limit\) until/);
    now = reset * 1000 + 1;
    expect(named.sup.blocker('fake:qa', 'test')).toBeNull();

    let later = Date.now();
    const plain = setup({
      mode: 'hit-codex',
      now: () => later,
      opsd: { usage_cooldown_minutes: 15 },
    });
    const p = plain.sup.launch({ agent: 'fake:qa' });
    await ended(plain.sup, p.id);
    expect(plain.sup.blocker('fake:qa', 'test')).toMatch(/refused work/);
    later += 16 * 60_000;
    expect(plain.sup.blocker('fake:qa', 'test')).toBeNull();
  });
});

describe('same role, different projects', () => {
  it('runs one engineer per project at once, each in its own repo', async () => {
    const { repo: siteRepo, state } = setup({ mode: 'hang' });
    const apiRepo = temp();
    execFileSync('git', ['init', '-q'], { cwd: apiRepo, windowsHide: true });
    initRoot(apiRepo, { name: 'api', prefix: 'API', human: 'human:dawid' });
    const agentFile = join(temp(), 'fake-agent.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const env = {
      ...process.env,
      OPS_CONFIG: join(siteRepo, 'none.yml'),
      OPS_STATE_DIR: state,
      FAKE_MODE: 'hang',
    } as NodeJS.ProcessEnv;
    delete env.OPS_AGENT;
    delete env.OPS_ROOTS;
    const user = { roots: [apiRepo] };
    const sup = new Supervisor({
      env,
      cwd: siteRepo,
      user,
      config: opsdConfig({
        opsd: { sync: false, runtimes: { fake: { command: process.execPath, args: [agentFile] } } },
      }),
      freeMem: () => 64 * 2 ** 30,
    });
    sups.push(sup);
    const human = new Workspace({ cwd: siteRepo, env, actor: 'human:dawid', user });
    human.newTask({ title: 'site work', owner: 'fake:engineer' });
    human.newTask({ title: 'more site work', owner: 'fake:engineer' });
    human.newTask(
      { title: 'api work', owner: 'fake:engineer' },
      human.roots.find((r) => r.name === 'api'),
    );

    const site = sup.launch({ agent: 'fake:engineer', task: 'test/T-0001' });
    const api = sup.launch({ agent: 'fake:engineer', task: 'api/API-0001' });
    expect(
      sup
        .runs({ live: true })
        .map((r) => r.id)
        .sort(),
    ).toEqual([site.id, api.id].sort());
    expect(site).toMatchObject({ project: 'test', root: 'test' });
    expect(api).toMatchObject({ project: 'api', root: 'api' });
    // Each run works in its own project's repo, so its commits land there.
    const same = (a: string, b: string) =>
      realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
    expect(same(site.cwd, siteRepo)).toBe(true);
    expect(same(api.cwd, apiRepo)).toBe(true);
    // The role limit still holds within one project.
    expect(() => sup.launch({ agent: 'fake:engineer', task: 'test/T-0002' })).toThrow(
      /per_project is 1/,
    );
  });
});

describe('Master Repo', () => {
  it('starts no run on a project known only from the Master Repo unless given a folder', async () => {
    const { repo: projectRepo, state } = setup({ mode: 'hang' });
    const hubRepo = temp();
    execFileSync('git', ['init', '-q'], { cwd: hubRepo, windowsHide: true });
    initRoot(hubRepo, { name: 'hub', prefix: 'HUB', human: 'human:dawid' });
    const project = new Root(join(projectRepo, '.agent-ops'));
    new Workspace({
      cwd: projectRepo,
      env: { OPS_CONFIG: join(projectRepo, 'none.yml') },
      actor: 'human:dawid',
      user: {},
    }).newTask({
      title: 'mirrored work',
      owner: 'fake:engineer',
    });
    mirrorPair(project, new Root(join(hubRepo, '.agent-ops')));
    const agentFile = join(temp(), 'fake-agent.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const env = {
      ...process.env,
      OPS_CONFIG: join(hubRepo, 'none.yml'),
      OPS_STATE_DIR: state,
      FAKE_MODE: 'hang',
    } as NodeJS.ProcessEnv;
    delete env.OPS_AGENT;
    delete env.OPS_ROOTS;
    // This machine has only the Master Repo: the project shows up as its mirror root.
    const user = { master: hubRepo };
    const sup = new Supervisor({
      env,
      cwd: hubRepo,
      user,
      config: opsdConfig({
        opsd: { sync: false, runtimes: { fake: { command: process.execPath, args: [agentFile] } } },
      }),
      freeMem: () => 64 * 2 ** 30,
    });
    sups.push(sup);
    expect(
      sup
        .ws()
        .roots.map((r) => `${r.name}${r.isMirror ? ' (mirror)' : ''}`)
        .sort(),
    ).toEqual(['hub', 'test (mirror)']);
    expect(() => sup.launch({ agent: 'fake:engineer', task: 'test/T-0001' })).toThrow(
      /no checkout here/,
    );
    // Nothing was claimed by the refused launch.
    expect(sup.ws('human:dawid').view('test/T-0001').claimedBy).toBeNull();
    const work = temp();
    const run = sup.launch({ agent: 'fake:engineer', task: 'test/T-0001', cwd: work });
    expect(realpathSync(run.cwd).toLowerCase()).toBe(realpathSync(work).toLowerCase());
  });
});

describe('machine presence', () => {
  it('writes this machine into its roots on a tick, and only when it changed', async () => {
    const { repo, state } = setup();
    const env = {
      ...process.env,
      OPS_CONFIG: join(repo, 'none.yml'),
      OPS_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    delete env.OPS_AGENT;
    delete env.OPS_ROOTS;
    const sup = new Supervisor({
      env,
      cwd: repo,
      user: { machine: 'test-pc' },
      config: opsdConfig({ opsd: { sync: false } }),
      freeMem: () => 64 * 2 ** 30,
      build: '42',
      version: 'x',
    });
    sups.push(sup);
    await sup.tick();
    const file = join(repo, '.agent-ops', 'machines', 'test-pc.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      machine: 'test-pc',
      live_runs: 0,
      build: '42',
    });
    const first = readFileSync(file, 'utf8');
    await sup.tick();
    expect(readFileSync(file, 'utf8')).toBe(first);
  });
});

describe('what runs leave in the checkout', () => {
  const ID = {
    GIT_AUTHOR_NAME: 'Opsd Test',
    GIT_AUTHOR_EMAIL: 'opsd@example.com',
    GIT_COMMITTER_NAME: 'Opsd Test',
    GIT_COMMITTER_EMAIL: 'opsd@example.com',
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...ID },
    }).trim();
  /** A file's text with Windows line endings (`core.autocrlf`) read as Unix ones. */
  const text = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

  /** A checkout with code and the task store committed, as in a project repo. */
  function codeSetup(mode: string, env: Record<string, string> = {}, procs?: ProcLister) {
    const s = setup({ mode, env: { ...ID, ...env }, procs });
    writeFileSync(join(s.repo, 'tracked.txt'), 'original\n');
    writeFileSync(join(s.repo, 'gone.txt'), 'deleted by the run\n');
    writeFileSync(join(s.repo, '.gitignore'), 'dist/\n');
    s.as('human:dawid').newTask({ title: 'Fix the parser', owner: 'fake:engineer' });
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-qm', 'start');
    return {
      ...s,
      start: git(s.repo, 'rev-parse', 'HEAD'),
      branch: git(s.repo, 'branch', '--show-current'),
    };
  }

  it('commits what a run left on a branch of its own, restores the checkout and asks for review', async () => {
    const { repo, sup, as, start, branch } = codeSetup('edit');
    // Ignored output is no change of the checkout.
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'out.js'), 'built\n');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);

    const name = `fake/t-0001-${run.id.toLowerCase()}`;
    const commit = git(repo, 'rev-parse', name);
    expect(git(repo, 'rev-parse', `${commit}^`)).toBe(start);
    expect(git(repo, 'log', '-1', '--format=%B', commit)).toBe(
      `Fix the parser\n\nChanges left by run ${run.id} (fake:engineer).`,
    );
    // Only the run's code: the task store's new events never go into the branch.
    expect(git(repo, 'diff-tree', '-r', '--no-renames', '--name-status', start, commit)).toBe(
      ['D\tgone.txt', 'A\tsrc/new/added.txt', 'M\ttracked.txt'].join('\n'),
    );
    expect(git(repo, 'show', `${commit}:tracked.txt`)).toBe('changed by the run');

    // The checkout is back on its branch and commit, clean outside the task store.
    expect(git(repo, 'branch', '--show-current')).toBe(branch);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(start);
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).agent-ops')).toBe('');
    expect(text(join(repo, 'tracked.txt'))).toBe('original\n');
    expect(existsSync(join(repo, 'gone.txt'))).toBe(true);
    expect(existsSync(join(repo, 'src'))).toBe(false);
    expect(readFileSync(join(repo, 'dist', 'out.js'), 'utf8')).toBe('built\n');

    const v = as('human:dawid').view('1');
    expect(v.status).toBe('needs-review');
    expect(v.reviewer).toBe('human:dawid');
    const { events } = as('human:dawid').showEvents('1');
    expect(events.find((e) => e.type === 'run-end')?.body).toContain(
      `opsd committed them as ${commit.slice(0, 7)} on branch ${name}`,
    );
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: 'review', actor: 'fake:engineer' });
    expect(last.body.startsWith(`${commit.slice(0, 7)} on branch ${name}: `)).toBe(true);
    expect(last.body).toContain('ended without `ops review`');
    expect(last.body).toContain(`Merge into ${branch} after approval.`);
  });

  it("sends the review to another provider's qa agent", async () => {
    const { repo, sup, as } = codeSetup('edit');
    as('human:dawid').saveRole({ id: 'claude:qa', status: 'active' }, { create: true });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'qa role');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    expect(as('human:dawid').view('1')).toMatchObject({
      status: 'needs-review',
      reviewer: 'claude:qa',
    });
  });

  it('tells the reviewer where the files went when the run asked for review itself', async () => {
    const { sup, as } = codeSetup('edit-review');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    expect(as('human:dawid').view('1').status).toBe('needs-review');
    const last = as('human:dawid').showEvents('1').events.at(-1)!;
    expect(last).toMatchObject({ type: 'comment', to: 'human:dawid' });
    expect(last.body).toContain(`fake/t-0001-${run.id.toLowerCase()}`);
    expect(last.body).toContain('asked for review with 3 file(s) it could not commit');
  });

  it('leaves runs that commit themselves alone', async () => {
    const { repo, sup, as, start } = codeSetup('commit');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    expect(git(repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD^')).toBe(start);
    expect(as('human:dawid').view('1').status).toBe('done');
    const end = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-end');
    expect(end?.body).toBe('');
  });

  it('starts no writing run in a checkout with uncommitted changes, and says why it waits', async () => {
    const { repo, sup, as } = setup({
      mode: 'hang',
      env: ID,
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    // New tasks and events in the task store are no changes of the checkout.
    const t = as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    writeFileSync(join(repo, 'tracked.txt'), 'a person at work\n');
    writeFileSync(join(repo, 'notes.txt'), 'notes\n');
    expect(() => sup.launch({ agent: 'fake:engineer', task: '1' })).toThrow(
      /^checkout has uncommitted changes in .+: (tracked|notes)\.txt and 1 more$/,
    );
    expect(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason])).toEqual([
      [t.id, expect.stringMatching(/^fake:engineer: checkout has uncommitted changes in /)],
    ]);
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(0);
    expect(as('human:dawid').view('1').status).toBe('todo');
    // Roles that only read start anyway.
    sup.launch({ agent: 'fake:qa' });
    // Once the checkout is clean, the writer starts.
    git(repo, 'checkout', '--', 'tracked.txt');
    rmSync(join(repo, 'notes.txt'));
    sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(sup.runs({ live: true })).toHaveLength(2);
  });

  it('tells the human once per checkout that its changes hold a writing run (AO-0137)', async () => {
    const { repo, sup, as } = setup({
      mode: 'hang',
      env: ID,
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    const t = as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    const notices = () =>
      as('human:dawid')
        .inbox('human:dawid')
        .filter((i) => i.kind === 'mention' && i.from === 'opsd:checkout');
    // A live run in the checkout may be what made the changes: no notice while it runs.
    writeFileSync(join(repo, 'tracked.txt'), 'a person at work\n');
    const qa = sup.launch({ agent: 'fake:qa' });
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.agent)).toEqual(['fake:qa']);
    expect(notices()).toHaveLength(0);
    sup.kill(qa.id);
    await ended(sup, qa.id);
    // The read-only run found the changes, so it left them; now nothing works in the checkout.
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(0);
    const first = notices();
    expect(first).toHaveLength(1);
    expect(first[0]!.summary).toMatch(
      new RegExp(
        `^fake:engineer waits to work on (test/)?${t.id} in .+, but that checkout has uncommitted changes and no run works in it: tracked\\.txt\\. `,
      ),
    );
    // Once per checkout, while it stays dirty.
    writeFileSync(join(repo, 'notes.txt'), 'notes\n');
    await sup.tick();
    expect(notices()).toHaveLength(1);
    // Clean again, the writer starts; changes made later are news.
    git(repo, 'checkout', '--', 'tracked.txt');
    rmSync(join(repo, 'notes.txt'));
    await sup.tick();
    const writer = sup.runs({ live: true });
    expect(writer.map((r) => r.agent)).toEqual(['fake:engineer']);
    sup.kill(writer[0]!.id);
    await ended(sup, writer[0]!.id);
    as('human:dawid').assign(t.id, 'human:dawid');
    writeFileSync(join(repo, 'later.txt'), 'later\n');
    as('human:dawid').newTask({ title: 'b', owner: 'fake:engineer' });
    await sup.tick();
    expect(notices().map((n) => n.summary)).toEqual([
      first[0]!.summary,
      expect.stringMatching(/: later\.txt\. /),
    ]);
  });

  it('commits what a read-only run left when it started on a clean checkout (AO-0136)', async () => {
    const { repo, sup, start, branch } = codeSetup('edit');
    const run = sup.launch({ agent: 'fake:qa' });
    const rec = await ended(sup, run.id);
    expect(rec.base).toBe(start);
    const name = `fake/run-${run.id.toLowerCase()}`;
    expect(sup.run(run.id)).toMatchObject({ leftovers: { branch: name } });
    expect(git(repo, 'rev-parse', `${name}^`)).toBe(start);
    // The checkout is clean again, so writing runs there start.
    expect(git(repo, 'branch', '--show-current')).toBe(branch);
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).agent-ops')).toBe('');
  });

  it('never commits changes a read-only run found in the checkout (AO-0136)', async () => {
    const { repo, sup } = codeSetup('edit');
    writeFileSync(join(repo, 'notes.txt'), 'a person at work\n');
    const run = sup.launch({ agent: 'fake:qa' });
    const rec = await ended(sup, run.id);
    expect(rec.base).toBeUndefined();
    expect(sup.run(run.id)?.leftovers).toBeUndefined();
    expect(git(repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(text(join(repo, 'notes.txt'))).toBe('a person at work\n');
  });

  it('starts a read-only Codex run in its task store with only the stores writable (AO-0138)', async () => {
    const out = join(temp(), 'codex-call.json');
    const recorder = join(temp(), 'codex.mjs');
    writeFileSync(
      recorder,
      [
        "import { writeFileSync } from 'node:fs';",
        "let prompt = '';",
        'for await (const c of process.stdin) prompt += c;',
        'writeFileSync(process.env.CODEX_CALL, JSON.stringify({ args: process.argv.slice(2), prompt }));',
      ].join('\n'),
    );
    const { repo, sup } = setup({
      env: { CODEX_CALL: out },
      opsd: { runtimes: { codex: { command: process.execPath, args: [recorder] } } },
    });
    const run = sup.launch({ agent: 'codex:qa' });
    await ended(sup, run.id);
    const call = JSON.parse(text(out)) as { args: string[]; prompt: string };
    const store = join(repo, '.agent-ops');
    const cd = call.args[call.args.indexOf('-C') + 1]!;
    expect(samePath(cd, store)).toBe(true);
    expect(call.args[call.args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(call.args).not.toContain('--add-dir');
    expect(call.prompt).toMatch(/may not change files in .+: Codex starts you in the task store/);
    // A writing Codex run still works in its checkout.
    const writer = sup.launch({ agent: 'codex:engineer' });
    await ended(sup, writer.id);
    const wcall = JSON.parse(text(out)) as { args: string[]; prompt: string };
    expect(samePath(wcall.args[wcall.args.indexOf('-C') + 1]!, repo)).toBe(true);
    expect(wcall.prompt).not.toContain('may not change files');
  });

  it('lets a chat turn neither hold a checkout nor wait on one (AO-0136)', async () => {
    const { repo, sup, as } = setup({ mode: 'hang', env: ID });
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    as('human:dawid').newTask({ title: 'b', owner: 'fake:planner' });
    // A chat turn of a role that writes starts beside a writing run in the same checkout...
    sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(sup.blocker('fake:planner', 'test', { cwd: repo })).toMatch(
      /one writing run per checkout/,
    );
    expect(sup.blocker('fake:planner', 'test', { cwd: repo, chat: true })).toBeNull();
    // ...and on a checkout with changes, and gets no start commit there.
    writeFileSync(join(repo, 'tracked.txt'), 'a person at work\n');
    const turn = sup.launch({ agent: 'fake:planner', chat: { session: 's1', resume: false } });
    expect(turn.base).toBeUndefined();
    // A live chat turn holds no writing run in its checkout.
    git(repo, 'checkout', '--', 'tracked.txt');
    expect(sup.blocker('fake:engineer', 'test', { cwd: repo, live: [turn] })).toBeNull();
    const engineer = sup.runs({ live: true }).find((r) => r.agent === 'fake:engineer')!;
    expect(sup.blocker('fake:qa', 'test', { cwd: repo, live: [turn, engineer] })).toBeNull();
    expect(sup.blocker('fake:writer', 'test', { cwd: repo, live: [turn, engineer] })).toMatch(
      /fake:engineer works .*one writing run per checkout/,
    );
  });

  it('keeps a file whose staged version is in neither HEAD nor the commit', () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'b.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    writeFileSync(join(repo, 'a.txt'), 'staged\n');
    git(repo, 'add', 'a.txt');
    writeFileSync(join(repo, 'a.txt'), 'working\n');
    writeFileSync(join(repo, 'b.txt'), 'two\n');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    const head = co.head();
    expect(co.changes().sort()).toEqual(['a.txt', 'b.txt']);
    const left = co.commitLeftovers('codex/t-0009-run', 'T\n', head)!;
    expect(left).toMatchObject({ files: ['a.txt', 'b.txt'], kept: ['a.txt'] });
    expect(git(repo, 'show', `${left.commit}:a.txt`)).toBe('working');
    // The staged version stays staged and the work stays in the file.
    expect(git(repo, 'show', ':a.txt')).toBe('staged');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('working\n');
    expect(text(join(repo, 'b.txt'))).toBe('one\n');
    expect(co.commitLeftovers('codex/again', 'T\n', head)).toMatchObject({
      files: ['a.txt'],
      kept: ['a.txt'],
    });
  });

  it('never touches a checkout that is itself a task store', () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    writeFileSync(join(repo, 'x.txt'), 'y\n');
    const co = new Checkout(repo, [repo], { ...process.env, ...ID });
    expect(co.isStore).toBe(true);
    expect(co.changes()).toEqual([]);
    expect(co.commitLeftovers('codex/x', 'T\n', co.head())).toBeNull();
    expect(readFileSync(join(repo, 'x.txt'), 'utf8')).toBe('y\n');
  });

  it('commits only from the commit the run started on', () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    const start = co.head()!;
    writeFileSync(join(repo, 'x.txt'), 'y\n');
    git(repo, 'commit', '-qam', 'moved');
    // Committed by the run itself and nothing left: nothing to do.
    expect(co.commitLeftovers('codex/a', 'T\n', start)).toBeNull();
    writeFileSync(join(repo, 'x.txt'), 'z\n');
    expect(() => co.commitLeftovers('codex/b', 'T\n', start)).toThrow(
      `HEAD moved from ${start.slice(0, 7)} to `,
    );
    expect(() => co.commitLeftovers('codex/c', 'T\n', null)).toThrow(/no start commit recorded/);
    expect(git(repo, 'branch', '--list', 'codex/*')).toBe('');
    expect(text(join(repo, 'x.txt'))).toBe('z\n');
  });

  it('counts no linked worktree inside the checkout as a change and never commits it (AO-0135)', () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    // A code branch in a worktree the repo does not ignore, as the run prompt asks for.
    git(repo, 'worktree', 'add', '-q', 'out/wt-T-0001', '-b', 'fake/t-0001');
    writeFileSync(join(repo, 'out', 'wt-T-0001', 'x.txt'), 'work in the worktree\n');
    expect(git(repo, 'status', '--porcelain')).toContain('out/');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    expect(co.changes()).toEqual([]);
    writeFileSync(join(repo, 'y.txt'), 'left in the checkout\n');
    expect(co.changes()).toEqual(['y.txt']);
    const left = co.commitLeftovers('fake/run-x', 'T\n', co.head())!;
    expect(left.files).toEqual(['y.txt']);
    expect(git(repo, 'ls-tree', '-r', '--name-only', left.commit)).toBe('x.txt\ny.txt');
    // The worktree and its work stay as they were.
    expect(text(join(repo, 'out', 'wt-T-0001', 'x.txt'))).toBe('work in the worktree\n');
  });

  it("tells runs in a data root's checkout to branch in worktrees, and no run in a worktree (AO-0135)", async () => {
    const promptFile = join(temp(), 'prompt.txt');
    const { repo, sup, as } = setup({
      env: { ...ID, FAKE_PROMPT: promptFile },
      opsd: {
        schedules: [{ name: 'digest', every: '24h', agent: 'fake:writer', prompt: 'Write it.' }],
      },
    });
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    const top = git(repo, 'rev-parse', '--show-toplevel');
    let prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain(
      `- ${top} holds the task store: keep its branch checked out and never`,
    );
    expect(prompt).toContain('`git worktree add out/wt-T-0001 -b <branch> <base>`');

    // With a store branch set, the prompt names it; a schedule's prompt carries the rule too.
    const file = join(repo, '.agent-ops', 'config.yml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('policy: checkpoint', 'policy: checkpoint\n  branch: v2'),
    );
    const scheduled = sup.runScheduleNow('digest');
    await ended(sup, scheduled.id);
    prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain('Write it.');
    expect(prompt).toContain(`- ${top} holds the task store: keep \`v2\` checked out`);

    // A custom prompt is used as given, with the rule appended.
    const custom = sup.launch({ agent: 'fake:engineer', prompt: 'Look into X.\n' });
    await ended(sup, custom.id);
    prompt = readFileSync(promptFile, 'utf8');
    expect(prompt.startsWith('Look into X.\n\nRule for this folder:\n')).toBe(true);
    expect(prompt).toContain(`- ${top} holds the task store: keep \`v2\` checked out`);
    expect(prompt).not.toContain('Rules for supervised runs');

    // A run in a linked worktree of the repo is in no data root's checkout.
    const wt = join(temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'code');
    as('human:dawid').newTask({ title: 'b', owner: 'fake:engineer' });
    const inWorktree = sup.launch({ agent: 'fake:engineer', task: '2', cwd: wt });
    await ended(sup, inWorktree.id);
    expect(readFileSync(promptFile, 'utf8')).not.toContain('holds the task store');
  });

  it('leaves the changes alone when HEAD moved during the run', async () => {
    const { repo, sup, as, start } = codeSetup('edit-move');
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(run.base).toBe(start);
    await ended(sup, run.id);
    expect(git(repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(text(join(repo, 'tracked.txt'))).toBe('changed after the move\n');
    const end = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-end');
    expect(end?.body).toMatch(/cannot commit what it left in .+: HEAD moved from /);
    expect(as('human:dawid').view('1').status).toBe('todo');
  });

  it('commits only after the processes the run left behind are killed', async () => {
    const real = systemLister();
    if (!real.precise) {
      real.close();
      return;
    }
    const go = join(temp(), 'go');
    // A process of the run that writes in the checkout until it is killed, after the run ended.
    const late = { pid: 0x7ffffff0, start: 0, alive: false, ppid: 0 };
    let repoDir = '';
    // The run's stored wrap-up step while its process is reaped: what a restart would resume.
    let wrapStep = (): string | undefined => undefined;
    let wrapAtReap: string | undefined;
    const lister: ProcLister = {
      precise: true,
      clockSlack: real.clockSlack,
      list: async () => {
        const procs = await real.list();
        return late.alive
          ? [
              ...procs,
              { pid: late.pid, ppid: late.ppid, name: 'node', cmd: 'late', start: late.start },
            ]
          : procs;
      },
      kill: async (targets: ProcTarget[]) => {
        const out = await real.kill(targets.filter((t) => t.pid !== late.pid));
        if (targets.some((t) => t.pid === late.pid)) {
          wrapAtReap = wrapStep();
          await new Promise((r) => setTimeout(r, 300));
          writeFileSync(join(repoDir, 'late.txt'), 'written while dying\n');
          late.alive = false;
          out.set(late.pid, 'killed');
        }
        return out;
      },
      ownPids: () => real.ownPids?.() ?? [],
      close: () => real.close(),
    };
    const { repo, sup, start } = codeSetup('edit-wait', { FAKE_GO: go }, lister);
    repoDir = repo;
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    wrapStep = () => sup.store.get(run.id)?.wrap_up;
    await until(() => existsSync(join(repo, 'src', 'new', 'added.txt')), 15_000);
    await sup.trackProcs();
    Object.assign(late, { alive: true, ppid: sup.run(run.id).pid, start: Date.now() });
    await sup.trackProcs();
    expect(sup.store.procs(run.id)?.entries.map((e) => e.pid)).toContain(late.pid);
    writeFileSync(go, '');
    await ended(sup, run.id, 30_000);
    expect(wrapAtReap).toBe('pending');
    expect(sup.run(run.id).wrap_up).toBe('done');

    const commit = git(repo, 'rev-parse', `fake/t-0001-${run.id.toLowerCase()}`);
    expect(git(repo, 'rev-parse', `${commit}^`)).toBe(start);
    expect(git(repo, 'show', `${commit}:late.txt`)).toBe('written while dying');
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).agent-ops')).toBe('');
  }, 60_000);

  it('commits only after the helpers of the run ended', async () => {
    const { repo, sup, as, start } = codeSetup('edit-wait', {
      FAKE_GO: join(temp(), 'never'),
      FAKE_HELPER_GO: 'helper.txt',
    });
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    await until(() => as('human:dawid').view('1').status === 'in-progress');
    const helper = sup.launch({ agent: 'fake:engineer', parent: run.id, prompt: 'help' });
    // Helpers write until they are killed; the parent ends first.
    await until(() => existsSync(join(repo, 'helper.txt')), 15_000);
    sup.kill(run.id);
    await ended(sup, run.id, 30_000);
    expect(sup.run(helper.id).status).toBe('ended');
    const commit = git(repo, 'rev-parse', `fake/t-0001-${run.id.toLowerCase()}`);
    expect(git(repo, 'rev-parse', `${commit}^`)).toBe(start);
    expect(git(repo, 'show', `${commit}:helper.txt`)).not.toBe('');
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).agent-ops')).toBe('');
  }, 60_000);

  /**
   * A run whose helper ends first and leaves a process behind in the checkout: `dies` says
   * whether that process writes `late.txt` while it is killed, or survives every kill. A dying
   * one holds its kill until the parent committed or 3 s after the parent ended.
   */
  async function helperEndsFirst(dies: boolean) {
    const real = systemLister();
    if (!real.precise) {
      real.close();
      return null;
    }
    const go = join(temp(), 'go');
    const late = { pid: 0x7ffffff1, start: 0, alive: false, ppid: 0 };
    let repoDir = '';
    let parentId = '';
    const lister: ProcLister = {
      precise: true,
      clockSlack: real.clockSlack,
      list: async () => {
        const procs = await real.list();
        return late.alive
          ? [
              ...procs,
              { pid: late.pid, ppid: late.ppid, name: 'node', cmd: 'late', start: late.start },
            ]
          : procs;
      },
      kill: async (targets: ProcTarget[]) => {
        const out = await real.kill(targets.filter((t) => t.pid !== late.pid));
        if (!targets.some((t) => t.pid === late.pid)) return out;
        if (!dies) {
          out.set(late.pid, 'error');
          return out;
        }
        await until(() => sup.run(parentId).status === 'ended', 30_000);
        const wait = Date.now() + 3000;
        while (Date.now() < wait && git(repoDir, 'branch', '--list', 'fake/*') === '') {
          await new Promise((r) => setTimeout(r, 50));
        }
        writeFileSync(join(repoDir, 'late.txt'), 'written while dying\n');
        late.alive = false;
        out.set(late.pid, 'killed');
        return out;
      },
      ownPids: () => real.ownPids?.() ?? [],
      close: () => real.close(),
    };
    const s = codeSetup('edit-wait', { FAKE_GO: go, FAKE_HELPER_GO: 'helper.txt' }, lister);
    const { repo, sup, as } = s;
    repoDir = repo;
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    parentId = run.id;
    await until(() => as('human:dawid').view('1').status === 'in-progress');
    const helper = sup.launch({ agent: 'fake:engineer', parent: run.id, prompt: 'help' });
    await until(() => existsSync(join(repo, 'helper.txt')), 15_000);
    await sup.trackProcs();
    Object.assign(late, { alive: true, ppid: sup.run(helper.id).pid, start: Date.now() });
    await sup.trackProcs();
    expect(sup.store.procs(helper.id)?.entries.map((e) => e.pid)).toContain(late.pid);
    // The helper ends first; its process is still alive when the parent ends.
    sup.kill(helper.id);
    await until(() => sup.run(helper.id).status === 'ended', 15_000);
    expect(late.alive).toBe(true);
    writeFileSync(go, '');
    await ended(sup, run.id, 30_000);
    return { ...s, run };
  }

  it('commits only after a helper that ended first finished its wrap-up', async () => {
    const s = await helperEndsFirst(true);
    if (!s) return;
    const { repo, run, start } = s;
    const commit = git(repo, 'rev-parse', `fake/t-0001-${run.id.toLowerCase()}`);
    expect(git(repo, 'rev-parse', `${commit}^`)).toBe(start);
    expect(git(repo, 'show', `${commit}:late.txt`)).toBe('written while dying');
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).agent-ops')).toBe('');
  }, 60_000);

  it('commits nothing while a process a helper left behind is still alive', async () => {
    const s = await helperEndsFirst(false);
    if (!s) return;
    const { repo, as } = s;
    expect(git(repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(text(join(repo, 'tracked.txt'))).toBe('changed by the run\n');
    const end = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-end' && e.body !== '');
    expect(end?.body.trim()).toBe(
      'left changes uncommitted: 1 process(es) of its helpers still alive',
    );
    expect(as('human:dawid').view('1').status).toBe('todo');
  }, 60_000);

  /**
   * A run of `fake:engineer` on task 1 that ended under an earlier opsd, which stopped before
   * the wrap-up was over: its record says how far it got, and it left the usual edits.
   */
  function endedBeforeRestart(s: ReturnType<typeof codeSetup>, patch: Partial<RunRecord> = {}) {
    const id = '01RESUME00000000000000000A';
    s.sup.ws('fake:engineer', id).claim('1');
    writeFileSync(join(s.repo, 'tracked.txt'), 'changed by the run');
    rmSync(join(s.repo, 'gone.txt'));
    mkdirSync(join(s.repo, 'src', 'new'), { recursive: true });
    writeFileSync(join(s.repo, 'src', 'new', 'added.txt'), 'added\n');
    const at = new Date().toISOString();
    s.sup.store.save({
      id,
      agent: 'fake:engineer',
      task: 'T-0001',
      root: 'test',
      pid: 1,
      image: 'node.exe',
      command: 'x',
      cwd: s.repo,
      log: join(s.state, 'none.log'),
      started_at: at,
      ended_at: at,
      status: 'ended',
      exit: 0,
      reason: 'exit',
      budget_minutes: 60,
      tokens: 0,
      base: s.start,
      wrap_up: 'pending',
      ...patch,
    });
    return id;
  }

  it('resumes a wrap-up that a restart of opsd cut off', async () => {
    const s = codeSetup('edit');
    const { repo, as, start, branch } = s;
    const id = endedBeforeRestart(s);
    const next = s.opsd();
    const done = ended(next, id);
    next.adopt();
    // Until the wrap-up is over, the run still holds its checkout.
    expect(next.quiesceIfIdle()).toBe(false);
    await done;

    const name = `fake/t-0001-${id.toLowerCase()}`;
    const commit = git(repo, 'rev-parse', name);
    expect(git(repo, 'rev-parse', `${commit}^`)).toBe(start);
    expect(git(repo, 'show', `${commit}:tracked.txt`)).toBe('changed by the run');
    expect(git(repo, 'branch', '--show-current')).toBe(branch);
    expect(git(repo, 'status', '--porcelain', '--', '.', ':(exclude).agent-ops')).toBe('');
    expect(next.run(id)).toMatchObject({ wrap_up: 'done', leftovers: { commit, branch: name } });
    expect(as('human:dawid').view('1')).toMatchObject({
      status: 'needs-review',
      reviewer: 'human:dawid',
    });
    const runEnds = () =>
      as('human:dawid')
        .showEvents('1')
        .events.filter((e) => e.type === 'run-end');
    expect(runEnds()).toHaveLength(1);
    expect(runEnds()[0]!.body).toContain(`opsd committed them as ${commit.slice(0, 7)}`);

    // A wrap-up that is over is never run again.
    const third = s.opsd();
    third.adopt();
    expect(third.quiesceIfIdle()).toBe(true);
    expect(runEnds()).toHaveLength(1);
  });

  it('resumes a wrap-up from the step it got to', async () => {
    const s = codeSetup('edit');
    const { repo, as } = s;
    // Committed and recorded already: only the review is left.
    const leftovers = {
      commit: s.start,
      branch: 'fake/t-0001-earlier',
      base: s.start,
      files: ['tracked.txt'],
      kept: [],
      top: repo,
      into: s.branch,
    };
    const id = endedBeforeRestart(s, { wrap_up: 'recorded', leftovers });
    const next = s.opsd();
    const done = ended(next, id);
    next.adopt();
    await done;
    // Nothing committed again, no second run-end event.
    expect(git(repo, 'branch', '--list', 'fake/*')).toBe('');
    expect(text(join(repo, 'tracked.txt'))).toBe('changed by the run');
    const { events } = as('human:dawid').showEvents('1');
    expect(events.filter((e) => e.type === 'run-end')).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'review', actor: 'fake:engineer' });
    expect(events.at(-1)!.body).toContain('fake/t-0001-earlier');
    expect(next.run(id).wrap_up).toBe('done');
  });

  it('finishes the restore of a commit an earlier wrap-up made', () => {
    const repo = temp();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'b.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    const co = new Checkout(repo, [], { ...process.env, ...ID });
    const head = co.head();
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'b.txt'), 'two\n');
    writeFileSync(join(repo, 'c.txt'), 'new\n');
    const first = co.commitLeftovers('codex/t-0009-run', 'T\n', head)!;
    // As if opsd stopped after restoring b.txt only.
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'c.txt'), 'new\n');
    const again = co.commitLeftovers('codex/t-0009-run', 'T\n', head)!;
    expect(again).toMatchObject({ commit: first.commit, files: ['a.txt', 'b.txt', 'c.txt'] });
    expect(again.kept).toEqual([]);
    expect(text(join(repo, 'a.txt'))).toBe('one\n');
    expect(text(join(repo, 'b.txt'))).toBe('one\n');
    expect(existsSync(join(repo, 'c.txt'))).toBe(false);
    // A branch of that name on another commit is not this run's.
    writeFileSync(join(repo, 'a.txt'), 'three\n');
    git(repo, 'branch', 'codex/other', first.commit);
    git(repo, 'commit', '-qam', 'moved');
    expect(() => co.commitLeftovers('codex/other', 'T\n', co.head())).toThrow(
      /branch codex\/other exists and does not start from /,
    );
  });
});

describe('role file status', () => {
  function role(repo: string, slug: string, status: string): void {
    const dir = join(repo, '.agent-ops', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}.md`), `---\nstatus: ${status}\n---\n`);
  }

  it('starts no wake run for a proposed role and says why in waits', async () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:qa': { wake: true } } },
    });
    role(repo, 'fake-qa', 'proposed');
    // With role files, work goes only to configured agents (AO-0096).
    role(repo, 'codex-engineer', 'active');
    const h = as('human:dawid');
    const meta = h.newTask({ title: 'x', owner: 'codex:engineer' });
    as('codex:engineer').start(meta.id, 'plan');
    as('codex:engineer').review(meta.id, 'check', 'fake:qa');
    h.newTask({ title: 'open work' });
    const waits = sup.waits();
    // The review request waits; the role's queue is empty. Since AO-0099 an open review request
    // is the review item only, not an inbox message too, so no inbox wake waits beside it.
    expect(waits.map((w) => w.kind)).toEqual(['review']);
    for (const w of waits) expect(w.reason).toMatch(/fake:qa is proposed in its role file/);
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(0);
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(/proposed in its role file/);

    role(repo, 'fake-qa', 'active');
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.agent)).toContain('fake:qa');
  });

  it('wakes a role only for task types its can_claim allows (AO-0126)', async () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:orchestrator': { wake: true } },
        roles: { orchestrator: { providers: ['fake'] } },
      },
    });
    const dir = join(repo, '.agent-ops', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fake-orchestrator.md'), '---\ncan_claim: [question]\n---\n');
    const h = as('human:dawid');
    const work = h.newTask({ title: 'Release 2.0.0', owner: '*:orchestrator', priority: 'p0' });
    const q = h.newTask({
      title: 'Is the release on track?',
      type: 'question',
      owner: '*:orchestrator',
      priority: 'p3',
    });
    const byTask = new Map(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason]));
    expect(byTask.get(work.id)).toBe('fake:orchestrator: role takes only question');
    expect(byTask.get(q.id)).toBe('starts at the next tick');
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.task)).toEqual([q.id]);
  });

  it('starts a task assigned by name to a read-only role whatever its type (AO-0136)', async () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:qa': { wake: true }, 'fake:orchestrator': { wake: true } },
        roles: { qa: { providers: ['fake'] }, orchestrator: { providers: ['fake'] } },
      },
    });
    const dir = join(repo, '.agent-ops', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fake-orchestrator.md'), '---\ncan_claim: [question]\n---\n');
    writeFileSync(join(dir, 'fake-qa.md'), '---\nname: QA\n---\n');
    const h = as('human:dawid');
    // fake:qa's role file has no can_claim, so the read-only default applies; fake:orchestrator's file
    // allows only questions. Both tasks name the agent, so both runs start.
    const qaWork = h.newTask({ title: 'Write the release test plan', owner: 'fake:qa' });
    const orchWork = h.newTask({ title: 'Cut 2.0.0', type: 'bug', owner: 'fake:orchestrator' });
    const byTask = new Map(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason]));
    expect(byTask.get(qaWork.id)).toBe('starts at the next tick');
    expect(byTask.get(orchWork.id)).toBe('starts at the next tick');
    await sup.tick();
    expect(
      sup
        .runs({ live: true })
        .map((r) => r.task)
        .sort(),
    ).toEqual([qaWork.id, orchWork.id].sort());
  });

  it('skips a schedule whose role is paused', async () => {
    const { sup, repo } = setup({
      mode: 'hang',
      opsd: { schedules: [{ name: 'digest', every: '1m', agent: 'fake:writer' }] },
    });
    role(repo, 'fake-writer', 'paused');
    await sup.tick();
    expect(sup.runs()).toHaveLength(0);
    expect(() => sup.runScheduleNow('digest')).toThrow(/fake:writer is paused in its role file/);
  });
});
