import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot } from '@agent-ops/core';
import type { Check } from '../src/index.js';
import { doctor, formatChecks } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-doctor-'));
  dirs.push(d);
  return d;
}

/** A clean env: nothing from the machine running the tests leaks into the checks. */
function envFor(config: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    Path: process.env.Path,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    OPS_CONFIG: config,
    OPS_STATE_DIR: temp(),
    ...extra,
  };
}
const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id);

describe('ops doctor', () => {
  it('warns about a missing config and fails without a data root', async () => {
    const cwd = temp();
    const checks = await doctor({ env: envFor(join(cwd, 'none.yml')), cwd, home: temp() });
    expect(byId(checks, 'config')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('ops setup'),
    });
    expect(byId(checks, 'me')?.status).toBe('warn');
    expect(byId(checks, 'roots')?.status).toBe('fail');
    expect(byId(checks, 'opsd')?.status).toBe('warn');
  });

  it('fails a config that does not parse', async () => {
    const cwd = temp();
    const config = join(cwd, 'config.yml');
    writeFileSync(config, 'me: [unclosed\n');
    const checks = await doctor({ env: envFor(config), cwd, home: temp() });
    expect(byId(checks, 'config')?.status).toBe('fail');
  });

  it('checks roots, runtimes, sign-in, memory and disk', async () => {
    const repo = temp();
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'site', human: 'human:dawid' });
    const claudeDir = temp();
    const config = join(temp(), 'config.yml');
    writeFileSync(
      config,
      [
        'me: human:dawid',
        'opsd:',
        '  min_free_gb: 8',
        '  runtimes:',
        `    claude: { command: ${JSON.stringify(process.execPath)} }`,
        `    codex: { command: ${JSON.stringify(process.execPath)} }`,
        '    ghost: { command: no-such-command-for-doctor }',
        '',
      ].join('\n'),
    );
    const env = envFor(config, { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: temp() });
    let checks = await doctor({
      env,
      cwd: repo,
      home: temp(),
      freeMem: () => 2 * 2 ** 30,
      diskFree: () => 1 * 2 ** 30,
    });
    expect(byId(checks, `root:${join(repo, '.agent-ops')}`)).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('no upstream'),
    });
    expect(byId(checks, 'runtime:ghost')?.status).toBe('fail');
    expect(byId(checks, 'runtime:claude')?.status).toBe('warn');
    expect(byId(checks, 'runtime:codex')?.status).toBe('warn');
    expect(byId(checks, 'memory')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('min_free_gb is 8'),
    });
    expect(byId(checks, 'disk:site')?.status).toBe('warn');

    // A sign-in file counts; it is only checked for, never read.
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, '.credentials.json'), 'not read');
    checks = await doctor({
      env: { ...env, OPENAI_API_KEY: 'set' },
      cwd: repo,
      home: temp(),
      freeMem: () => 64 * 2 ** 30,
      diskFree: () => 500 * 2 ** 30,
      self: { pid: 4242, build: '7' },
    });
    expect(byId(checks, 'runtime:claude')?.status).toBe('ok');
    expect(byId(checks, 'runtime:codex')?.status).toBe('ok');
    expect(byId(checks, 'memory')?.status).toBe('ok');
    expect(byId(checks, 'opsd')).toMatchObject({
      status: 'ok',
      detail: 'running, pid 4242, build 7',
    });

    const text = formatChecks(checks);
    expect(text).toMatch(
      /^FAIL {2}Runtime ghost: 'no-such-command-for-doctor' is not on PATH\n {6}-> install ghost/m,
    );
    expect(text).not.toContain('OPENAI');
  });

  it('warns about a role file that does not parse', async () => {
    const repo = temp();
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    const root = initRoot(repo, { name: 'site', human: 'human:dawid' });
    mkdirSync(join(root, 'agents'), { recursive: true });
    const bad = join(root, 'agents', 'claude-broken.md');
    writeFileSync(bad, '---\ndescription: Reviews code: carefully\nstatus: active\n---\n');
    const config = join(temp(), 'config.yml');
    writeFileSync(config, 'me: human:dawid\n');
    const checks = await doctor({ env: envFor(config), cwd: repo, home: temp() });
    expect(byId(checks, `agent-file:${bad}`)).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('is skipped'),
    });
  });

  it('fails an opsd config that does not validate', async () => {
    const cwd = temp();
    const config = join(cwd, 'config.yml');
    writeFileSync(config, 'me: human:dawid\nopsd:\n  max_runs: lots\n');
    const checks = await doctor({ env: envFor(config), cwd, home: temp() });
    expect(byId(checks, 'opsd-config')?.status).toBe('fail');
  });
});

describe('ops doctor edge cases', () => {
  it('turns runtimes with no usable command into failed checks instead of throwing', async () => {
    const cwd = temp();
    const config = join(cwd, 'config.yml');
    writeFileSync(
      config,
      [
        'me: human:dawid',
        'opsd:',
        '  runtimes:',
        '    nocmd: { args: [x] }',
        '    number: { command: 5 }',
        '    empty: { command: "" }',
        '',
      ].join('\n'),
    );
    const checks = await doctor({ env: envFor(config), cwd, home: temp() });
    const runtimeChecks = checks.filter((c) => c.id.startsWith('runtime:'));
    const configCheck = byId(checks, 'opsd-config');
    // Either the opsd config refuses them, or each runtime fails on its own; nothing throws.
    if (configCheck?.status === 'ok') {
      expect(runtimeChecks.map((c) => [c.id, c.status])).toEqual(
        expect.arrayContaining([
          ['runtime:nocmd', 'fail'],
          ['runtime:number', 'fail'],
          ['runtime:empty', 'fail'],
        ]),
      );
    } else {
      expect(configCheck?.status).toBe('fail');
    }
  });

  it('calls an opsd without a build stamp stale, as the desktop does', async () => {
    const cwd = temp();
    const state = temp();
    const config = join(cwd, 'config.yml');
    writeFileSync(config, 'me: human:dawid\n');
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(
        join(state, 'opsd.json'),
        JSON.stringify({ pid: process.pid, port, token: 't', started_at: '', version: 'x' }),
      );
      const checks = await doctor({
        env: { ...envFor(config), OPS_STATE_DIR: state },
        cwd,
        home: temp(),
      });
      expect(byId(checks, 'opsd')).toMatchObject({
        status: 'warn',
        detail: expect.stringContaining('older build'),
      });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
