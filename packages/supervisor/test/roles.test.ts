import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@agent-ops/core';
import {
  agentDirectory,
  checkRuntime,
  editRuntime,
  invocation,
  runPrompt,
  startApi,
  Supervisor,
} from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// The test process's own config path: nothing here may write to it.
const guard = mkdtempSync(join(tmpdir(), 'opsd-roles-guard-'));
const processConfig = join(guard, 'process-config.yml');
const savedConfig = process.env.OPS_CONFIG;
beforeAll(() => {
  process.env.OPS_CONFIG = processConfig;
});
afterAll(() => {
  if (savedConfig === undefined) delete process.env.OPS_CONFIG;
  else process.env.OPS_CONFIG = savedConfig;
  rmSync(guard, { recursive: true, force: true });
});
afterEach(async () => {
  expect(existsSync(processConfig), 'an edit went to the process config').toBe(false);
  for (const s of sups.splice(0)) {
    s.stop({ killRuns: true });
    await s.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-roles-'));
  dirs.push(d);
  return d;
}

async function setup(config = 'me: human:dawid\nopsd:\n  sync: false\n') {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const userConfig = join(temp(), 'config.yml');
  writeFileSync(userConfig, config);
  const env = {
    ...process.env,
    OPS_CONFIG: userConfig,
    OPS_STATE_DIR: temp(),
  } as NodeJS.ProcessEnv;
  delete env.OPS_AGENT;
  delete env.OPS_ROOTS;
  const sup = new Supervisor({ env, cwd: repo, freeMem: () => 64 * 2 ** 30 });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'roles-token', version: 't', build: '1' });
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: 'Bearer roles-token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {} });
  const rootDir = join(repo, '.agent-ops');
  return { repo, rootDir, sup, api, call, as, env, userConfig };
}

describe('role files from the app', () => {
  it('creates a role with knowledge and style, edits it, and keeps tools the app cannot set', async () => {
    const { rootDir, call, sup } = await setup();
    let res = await call('POST', '/api/roles', {
      as: 'human:dawid',
      create: true,
      role: {
        id: 'claude:writer',
        name: 'Writer',
        description: 'Drafts posts',
        instructions: 'You write posts.',
        kb: ['voice', 'agent-ops'],
        files: ['docs/voice.md'],
        style: 'Plain and direct.',
        budget_min: 60,
        // Not a role input: the app never sets tool permissions.
        tools: ['Bash(*)'],
      },
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ id: 'claude:writer', kb: ['voice', 'agent-ops'] });
    expect(res.data).not.toHaveProperty('file');
    const file = join(rootDir, 'agents', 'claude-writer.md');
    expect(readFileSync(file, 'utf8')).not.toContain('Bash(*)');

    // A tools list written by hand stays when the app edits the role.
    writeFileSync(file, readFileSync(file, 'utf8').replace('status:', 'tools:\n  - Read\nstatus:'));
    res = await call('POST', '/api/roles', {
      as: 'human:dawid',
      role: { id: 'claude:writer', style: 'Short sentences.', kb: ['agent-ops'] },
    });
    expect(res.status).toBe(200);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('- Read');
    expect(text).toContain('Short sentences.');
    expect(text).not.toMatch(/^\s*- voice$/m);
    expect(text).toMatch(/^\s*- agent-ops$/m);
    // Fields the edit left out keep their value.
    expect(text).toContain('docs/voice.md');
    expect(text).toContain('You write posts.');

    res = await call('GET', '/api/roles/claude%3Awriter');
    expect(res.data).toMatchObject({ id: 'claude:writer', root: 'test', budget_min: 60 });
    expect(res.data.instructions).toBe('You write posts.');

    // A second create of the same role is refused.
    res = await call('POST', '/api/roles', {
      as: 'human:dawid',
      create: true,
      role: { id: 'claude:writer' },
    });
    expect(res.status).toBe(400);

    // The run prompt names the role's reading list and style.
    const def = sup.ws().agent('claude:writer')!;
    const prompt = runPrompt({ agent: def.id, task: 'T-0001', roleFile: def.file, role: def });
    expect(prompt).toContain('`ops kb --topic');
    expect(prompt).toContain('docs/voice.md');
    expect(prompt).toContain('Short sentences.');
    // Runs decide technical choices and never ask a person for push access (AO-0093).
    expect(prompt).toContain('Decide technical and process choices yourself');
    expect(prompt).toContain('the orchestrator commits and pushes');
    // A review run keeps its verdict-only ending: no work rules that say to finish with ops review.
    const review = runPrompt({ agent: 'codex:qa', task: 'T-0001', review: true });
    expect(review).toContain('Finish with exactly one verdict');
    expect(review).not.toContain('finish with `ops review`');
    expect(review).not.toContain('Decide technical and process choices yourself');
  });

  it('refuses bad ids, secrets, and an agents folder that is a link', async () => {
    const { rootDir, call } = await setup();
    for (const id of ['human:dawid', 'claude', 'claude:*', 'Claude:Writer']) {
      const res = await call('POST', '/api/roles', { as: 'human:dawid', role: { id } });
      expect(res.status, id).toBe(400);
    }
    // Malformed fields are refused with 400 before any check or write, never a 500.
    for (const role of [
      { id: 'claude:writer', files: 7 },
      { id: 'claude:writer', files: [7] },
      { id: 'claude:writer', kb: 'voice' },
      { id: 'claude:writer', name: 5 },
      { id: 'claude:writer', instructions: { text: 'x' } },
      { id: 'claude:writer', budget_min: '60' },
      { id: 'claude:writer', status: 'gone' },
      { id: 7 },
    ]) {
      const res = await call('POST', '/api/roles', { as: 'human:dawid', create: true, role });
      expect(res.status, JSON.stringify(role)).toBe(400);
    }
    expect((await call('POST', '/api/roles', { as: 'human:dawid', role: 'x' })).status).toBe(400);
    expect(existsSync(join(rootDir, 'agents', 'claude-writer.md'))).toBe(false);

    const leak = await call('POST', '/api/roles', {
      as: 'human:dawid',
      // Built in parts, so the leak check of this repo does not flag the test itself.
      role: {
        id: 'claude:writer',
        instructions: `token ${['gh', 'p_'].join('')}${'A'.repeat(36)}`,
      },
    });
    expect(leak.status).toBe(400);

    const outside = temp();
    mkdirSync(join(outside, 'x'));
    rmSync(join(rootDir, 'agents'), { recursive: true, force: true });
    symlinkSync(join(outside, 'x'), join(rootDir, 'agents'), 'junction');
    const linked = await call('POST', '/api/roles', {
      as: 'human:dawid',
      role: { id: 'claude:writer' },
    });
    expect(linked.status).toBe(400);
    expect(existsSync(join(outside, 'x', 'claude-writer.md'))).toBe(false);
  });
});

describe('who the app can address', () => {
  it('lists runtimes with the usual roles, role files and agents seen lately, never humans', async () => {
    const { as, sup } = await setup(
      'me: human:dawid\nopsd:\n  sync: false\n  runtimes:\n    hermes: { command: hermes, paused: true }\n',
    );
    as('human:dawid').newTask({ title: 'x' });
    as('grok:pm').comment('T-0001', 'hello');
    const dir = agentDirectory(sup);
    const ids = dir.map((d) => d.id);
    expect(ids).toContain('claude:engineer');
    expect(ids).toContain('codex:qa');
    expect(ids).toContain('hermes:reviewer');
    expect(dir.find((d) => d.id === 'hermes:engineer')).toMatchObject({
      source: 'runtime',
      paused: true,
    });
    expect(dir.find((d) => d.id === 'grok:pm')).toMatchObject({ source: 'seen' });
    expect(ids.some((id) => id.startsWith('human:'))).toBe(false);
    // No role file and no opsd.agents entry: a write checks no id, so every entry is configured.
    expect(dir.every((d) => d.configured)).toBe(true);
  });

  it('marks configured exactly the ids an assign accepts (AO-0124)', async () => {
    const { as, call } = await setup(
      'me: human:dawid\nopsd:\n  sync: false\n  agents:\n    codex:qa: {}\n',
    );
    expect(
      (
        await call('POST', '/api/roles', {
          as: 'human:dawid',
          create: true,
          role: { id: 'claude:writer' },
        })
      ).status,
    ).toBe(201);
    as('human:dawid').newTask({ title: 'x' });
    as('claude:orchestrator').comment('T-0001', 'hello');
    const dir = (await call('GET', '/api/directory')).data as unknown as Array<{
      id: string;
      source: string;
      configured: boolean;
    }>;
    const entry = (id: string) => dir.find((d) => d.id === id);
    expect(entry('claude:writer')).toMatchObject({ source: 'role', configured: true });
    expect(entry('codex:qa')).toMatchObject({ source: 'config', configured: true });
    expect(entry('claude:engineer')).toMatchObject({ source: 'runtime', configured: false });
    expect(entry('claude:orchestrator')).toMatchObject({ source: 'seen', configured: false });
    for (const d of dir) {
      const res = await call('POST', '/api/tasks/T-0001/assign', { as: 'human:dawid', to: d.id });
      expect(res.status === 200, `${d.id}: ${JSON.stringify(res.data)}`).toBe(d.configured);
    }
  });
});

describe('agents from Settings and the Agents view', () => {
  it('turns wake on, then off: the key goes and the agent stays until removed', async () => {
    const { call, sup, userConfig } = await setup(
      'me: human:dawid\nopsd:\n  sync: false\n  agents:\n    codex:qa:\n      budget: 30m\n',
    );
    let res = await call('POST', '/api/settings', {
      patch: { opsd: { agents: { 'claude:pm': { wake: true }, 'codex:qa': { wake: true } } } },
    });
    expect(res.status).toBe(200);
    expect(sup.config.agents['claude:pm']).toEqual({ wake: true });
    let agents = (await call('GET', '/api/agents')).data as unknown as Array<{
      id: string;
      wake: boolean;
      configured: boolean;
    }>;
    expect(agents.find((a) => a.id === 'claude:pm')).toMatchObject({
      wake: true,
      configured: true,
    });

    res = await call('POST', '/api/settings', {
      patch: { opsd: { agents: { 'claude:pm': { wake: false }, 'codex:qa': { wake: false } } } },
    });
    expect(res.status).toBe(200);
    expect(readFileSync(userConfig, 'utf8')).not.toContain('wake');
    expect(sup.config.agents).toEqual({ 'claude:pm': {}, 'codex:qa': { budget: '30m' } });

    // Removing is explicit: null takes the agent out of the config.
    await call('POST', '/api/settings', { patch: { opsd: { agents: { 'claude:pm': null } } } });
    expect(readFileSync(userConfig, 'utf8')).not.toContain('claude:pm');
    agents = (await call('GET', '/api/agents')).data as unknown as typeof agents;
    expect(agents.some((a) => a.id === 'claude:pm')).toBe(false);
  });

  it('adds an agent with a model, edits and clears each field, and refuses one with no provider', async () => {
    const { call, sup, userConfig } = await setup();
    let res = await call('POST', '/api/settings', {
      patch: {
        opsd: { agents: { 'codex:writer': { wake: true, budget: '45m', model: 'gpt-5-codex' } } },
      },
    });
    expect(res.status).toBe(200);
    expect(sup.config.agents['codex:writer']).toEqual({
      wake: true,
      budget: '45m',
      model: 'gpt-5-codex',
    });
    expect(
      (res.data as { opsd: { agents: Record<string, unknown> } }).opsd.agents['codex:writer'],
    ).toEqual({ wake: true, budget: '45m', model: 'gpt-5-codex' });

    res = await call('POST', '/api/settings', {
      patch: { opsd: { agents: { 'codex:writer': { budget: '2h', model: 'o3' } } } },
    });
    expect(sup.config.agents['codex:writer']).toMatchObject({ budget: '2h', model: 'o3' });
    // An empty value or null clears a field; the agent stays.
    await call('POST', '/api/settings', {
      patch: { opsd: { agents: { 'codex:writer': { budget: null, model: '', wake: false } } } },
    });
    expect(sup.config.agents['codex:writer']).toEqual({});

    for (const [id, a] of [
      ['hermes:engineer', { wake: true }],
      ['codex:writer', { model: '--dangerously-bypass' }],
      ['codex:writer', { model: 'a b' }],
      ['codex:writer', { budget: 'soon' }],
      ['codex:writer', { cwd: 'C:\\' }],
      ['human:dawid', { wake: true }],
      ['claude:*', { wake: true }],
    ] as const) {
      const before = readFileSync(userConfig, 'utf8');
      const bad = await call('POST', '/api/settings', { patch: { opsd: { agents: { [id]: a } } } });
      expect(bad.status, `${id} ${JSON.stringify(a)}`).toBe(400);
      expect(readFileSync(userConfig, 'utf8')).toBe(before);
    }
    const refused = await call('POST', '/api/settings', {
      patch: { opsd: { agents: { 'hermes:engineer': { wake: true } } } },
    });
    expect(String(refused.data.error)).toMatch(/no provider 'hermes'/);
  });
});

describe('providers from Settings', () => {
  it('pauses a provider through the settings API: no new runs, and the reason says so', async () => {
    const { call, sup } = await setup();
    const res = await call('POST', '/api/settings', {
      patch: { opsd: { runtimes: { codex: { paused: true } } } },
    });
    expect(res.status).toBe(200);
    expect(
      (res.data as { opsd: { runtimes: Record<string, unknown> } }).opsd.runtimes.codex,
    ).toMatchObject({
      paused: true,
      default: { command: 'codex' },
      command: 'codex',
    });
    expect(sup.blocker('codex:qa', 'test')).toBe('codex is paused in Settings');
    expect(sup.blocker('claude:qa', 'test')).toBeNull();
    expect(sup.usageReport().codex?.paused).toBe('codex is paused in Settings');
    // The API still cannot set what program a runtime starts.
    const cmd = await call('POST', '/api/settings', {
      patch: { opsd: { runtimes: { codex: { command: 'evil' } } } },
    });
    expect(cmd.status).toBe(400);
  });

  it('adds, edits and removes runtimes in the given config only, seeded ones included', async () => {
    const { env, userConfig, call, sup } = await setup(
      '# keep me\nme: human:dawid\nopsd:\n  sync: false\n  runtimes:\n    codex: { max_live: 2 }\n',
    );
    editRuntime(env, 'hermes', {
      command: 'hermes',
      args: ['run', '--json', '-'],
      unset_env: ['GITHUB_TOKEN'],
    });
    let text = readFileSync(userConfig, 'utf8');
    expect(text).toContain('# keep me');
    expect(text).toContain('hermes');
    // The first edit seeds the config: the defaults are written, the codex limit kept.
    expect(text).toContain('seeded: 1');
    await call('POST', '/api/settings', { patch: {} });
    const view = (await call('GET', '/api/settings')).data as {
      opsd: { runtimes: Record<string, { command: string; default: unknown; agents: string[] }> };
    };
    expect(view.opsd.runtimes.hermes).toMatchObject({ command: 'hermes', default: null });
    expect(sup.config.runtimes.codex).toMatchObject({ command: 'codex', max_live: 2 });

    // A seeded provider's command, arguments and environment change like any other's; its
    // limits and model stay.
    // Arguments survive the config file exactly: empty ones, quotes and backslashes.
    const args = ['--profile', 'work', '--prefix', '', 'say "hi"', 'C:\\tools\\', 'a\\"b'];
    editRuntime(env, 'codex', { command: 'C:\\tools\\codex.cmd', args });
    sup.reloadConfig();
    expect(sup.config.runtimes.codex).toEqual({
      command: 'C:\\tools\\codex.cmd',
      args,
      max_live: 2,
    });
    editRuntime(env, 'claude', null);
    editRuntime(env, 'hermes', null);
    sup.reloadConfig();
    text = readFileSync(userConfig, 'utf8');
    expect(text).not.toContain('hermes');
    expect(Object.keys(sup.config.runtimes)).toEqual(['codex']);
  });

  it('sets the model and limits of a provider through the API, removes and resets it, and runs say why', async () => {
    const { call, sup, userConfig } = await setup(
      'me: human:dawid\nopsd:\n  sync: false\n  agents:\n    codex:qa:\n',
    );
    let res = await call('POST', '/api/settings', {
      patch: {
        opsd: {
          runtimes: { codex: { model: 'gpt-5-codex', max_live: 3, pause_at: 0.8, paused: true } },
        },
      },
    });
    expect(res.status).toBe(200);
    const codexView = (res.data as { opsd: { runtimes: Record<string, Record<string, unknown>> } })
      .opsd.runtimes.codex;
    expect(codexView).toMatchObject({
      model: 'gpt-5-codex',
      max_live: 3,
      pause_at: 0.8,
      paused: true,
      agents: ['codex:qa'],
    });
    expect(codexView).toHaveProperty('found');
    // The next run uses the new model without a restart: opsd reloaded the config.
    expect(sup.config.runtimes.codex!.model).toBe('gpt-5-codex');
    const args = invocation(sup.config.runtimes.codex!, 'codex:qa', undefined, '/w', []).args;
    expect(args.slice(0, 3)).toEqual(['exec', '-m', 'gpt-5-codex']);

    // Each field clears back to its default.
    await call('POST', '/api/settings', {
      patch: {
        opsd: { runtimes: { codex: { model: '', max_live: null, pause_at: null, paused: null } } },
      },
    });
    expect(sup.config.runtimes.codex).toEqual({ command: 'codex' });

    // Bad values and fields the API does not set are refused, and nothing is written.
    for (const r of [
      { model: '-c evil' },
      { model: 7 },
      { max_live: -1 },
      { pause_at: 2 },
      { paused: 'yes' },
      { command: 'evil' },
      { args: ['--yolo'] },
      { unset_env: ['PATH'] },
    ]) {
      const before = readFileSync(userConfig, 'utf8');
      const bad = await call('POST', '/api/settings', {
        patch: { opsd: { runtimes: { codex: r } } },
      });
      expect(bad.status, JSON.stringify(r)).toBe(400);
      expect(readFileSync(userConfig, 'utf8')).toBe(before);
    }

    // Removing a provider: its runs say why they cannot start, and its agents stay.
    res = await call('POST', '/api/settings', { patch: { opsd: { runtimes: { codex: null } } } });
    expect(res.status).toBe(200);
    expect(Object.keys(sup.config.runtimes)).toEqual(['claude']);
    expect(sup.blocker('codex:qa', 'test')).toMatch(/no provider 'codex'/);
    expect(() => sup.launch({ agent: 'codex:qa' })).toThrow(/no provider 'codex'/);
    expect(sup.config.agents).toHaveProperty('codex:qa');
    expect(res.data.missingDefaults).toEqual([
      expect.objectContaining({ name: 'codex', command: 'codex' }),
    ]);
    // It stays removed across a reload.
    sup.reloadConfig();
    expect(sup.config.runtimes.codex).toBeUndefined();
    // Reset to default brings a seeded provider back; a custom one has no default.
    res = await call('POST', '/api/settings', {
      patch: { opsd: { runtimes: { codex: 'default' } } },
    });
    expect(sup.config.runtimes.codex).toEqual({ command: 'codex' });
    expect(sup.blocker('codex:qa', 'test')).toBeNull();
    for (const runtimes of [{ hermes: 'default' }, { hermes: null }]) {
      const bad = await call('POST', '/api/settings', { patch: { opsd: { runtimes } } });
      expect(bad.status, JSON.stringify(runtimes)).toBe(400);
    }
  });

  it('keeps the built-in command and a user-set unset env when Settings sets a limit on a built-in runtime', async () => {
    const { call, sup } = await setup(
      'me: human:dawid\nopsd:\n  sync: false\n  runtimes:\n    codex: { unset_env: [GH_TOKEN] }\n',
    );
    await call('POST', '/api/settings', {
      patch: { opsd: { runtimes: { codex: { max_live: 2 }, claude: { max_live: 1 } } } },
    });
    expect(sup.config.runtimes.codex).toMatchObject({
      command: 'codex',
      unset_env: ['GH_TOKEN'],
      max_live: 2,
    });
    expect(sup.config.runtimes.claude).toMatchObject({ command: 'claude', max_live: 1 });
    expect(sup.config.runtimes.claude!.unset_env).toBeUndefined();
  });

  it('checks runtime names and command lines', () => {
    expect(checkRuntime('hermes', { command: ' hermes ', args: ['a', ''] })).toEqual({
      command: 'hermes',
      args: ['a', ''],
      unset_env: undefined,
    });
    // Arguments are kept exactly: empty ones, embedded quotes, backslashes and spaces.
    const exact = ['', '--prefix', '', 'say "hi"', 'C:\\tools\\', 'a\\"b', ' '];
    expect(checkRuntime('hermes', { command: 'hermes', args: exact }).args).toEqual(exact);
    expect(checkRuntime('hermes', { command: 'hermes', unset_env: ['', 'A_B'] }).unset_env).toEqual(
      ['A_B'],
    );
    expect(() => checkRuntime('human', { command: 'x' })).toThrow();
    expect(() => checkRuntime('Bad', { command: 'x' })).toThrow();
    expect(() => checkRuntime('ok', { command: '' })).toThrow();
    expect(() => checkRuntime('ok', { command: 'x\ny' })).toThrow();
    expect(() => checkRuntime('ok', { command: 'x', args: ['a\nb'] })).toThrow();
    expect(() => checkRuntime('ok', { command: 'x', unset_env: ['A=B'] })).toThrow();
    expect(() => checkRuntime('ok', { command: 'x', cwd: '/' })).toThrow();
  });
});

describe('live updates', () => {
  it('pushes tasks at once after a write through the API, before the next poll', async () => {
    const { api, call, as } = await setup();
    as('human:dawid').newTask({ title: 'talk' });
    const events: string[] = [];
    const stream = await fetch(`http://127.0.0.1:${api.port}/api/events?token=roles-token`);
    const reader = stream.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        events.push(...[...dec.decode(value).matchAll(/^event: (\w+)/gm)].map((m) => m[1]!));
      }
    })();
    // The first look after connecting only takes the baseline.
    await new Promise((r) => setTimeout(r, 200));
    const res = await call('POST', '/api/tasks/T-0001/comment', {
      as: 'human:dawid',
      message: 'hello',
    });
    expect(res.status).toBe(200);
    // The poll runs every 3 s; the push must come well before it.
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toContain('tasks');
    await reader.cancel();
    await pump.catch(() => {});
  });
});
