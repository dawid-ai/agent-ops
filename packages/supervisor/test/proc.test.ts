import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Spawned } from '../src/index.js';
import { isAlive, killTree, quoteBatch, spawnHidden } from '../src/index.js';
import { processStart } from '../src/proc.js';

const WIN = process.platform === 'win32';
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-proc-'));
  dirs.push(d);
  return d;
}

/** A program that prints its arguments, stdin and a few env values as JSON. */
function printer(dir: string): string {
  const script = join(dir, 'print args.mjs');
  writeFileSync(
    script,
    `let input = '';
for await (const c of process.stdin) input += c;
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  input,
  pipe: process.env.OPS_LAUNCH_PIPE ?? null,
  probe: process.env.OPS_PROBE ?? null,
}));`,
  );
  return script;
}

async function output(
  spawned: Spawned,
  prompt: string,
): Promise<{ code: number | null; out: string }> {
  let out = '';
  spawned.child.stdout!.setEncoding('utf8');
  spawned.child.stdout!.on('data', (d: string) => (out += d));
  const closed = new Promise<number | null>((r) => spawned.child.on('close', r));
  if (spawned.launch) {
    await spawned.launch.ready;
    spawned.launch.go(prompt);
  } else {
    spawned.child.stdin!.end(prompt);
  }
  return { code: await closed, out };
}

const AWKWARD = [
  'plain',
  'with space',
  'C:\\dir with space\\',
  'C:\\trailing\\',
  'Bash(ops *),Read',
  'say "hi"',
  'a\\"b',
  'a\\\\"b',
  'a&b|c<d>e^f',
  'x%PATH%y',
  '%OPS_PROBE%',
  '!PATH!',
  '!OPS_PROBE!',
  'line\r\nbreak',
  'lf\nonly',
  'cr\ronly',
  'C:\\100% done!\\file "x".txt',
  'tab\there',
  '',
];

describe('spawnHidden', () => {
  it('passes every argument through unchanged, through the launcher on Windows', async () => {
    const dir = temp();
    const script = printer(dir);
    const env = { ...process.env, OPS_PROBE: 'expanded' };
    const spawned = spawnHidden(process.execPath, [script, ...AWKWARD], { env, out: 'pipe' });
    expect(spawned.launch !== undefined).toBe(WIN);
    const { code, out } = await output(spawned, 'the prompt\n');
    expect(code).toBe(0);
    const got = JSON.parse(out) as { args: string[]; input: string; pipe: string | null };
    expect(got.args).toEqual(AWKWARD);
    expect(got.input).toBe('the prompt\n');
    // The launcher's own channel stays out of the command's environment.
    expect(got.pipe).toBeNull();
  });

  it.runIf(WIN)('reports the launcher, not the shell, and starts nothing before go', async () => {
    const dir = temp();
    const marker = join(dir, 'started');
    const script = join(dir, 'mark.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], String(process.ppid));`,
    );
    const spawned = spawnHidden(process.execPath, [script, marker], {
      env: process.env,
      out: 'ignore',
    });
    const launcher = await spawned.launch!.ready;
    expect(launcher).not.toBe(spawned.pid);
    expect(isAlive(launcher)).toBe(true);
    // Give a launcher that did not wait time to start the command.
    await new Promise((r) => setTimeout(r, 1000));
    expect(existsSync(marker)).toBe(false);
    const closed = new Promise<number | null>((r) => spawned.child.on('close', r));
    spawned.launch!.abort();
    expect(await closed).toBe(70);
    expect(isAlive(launcher)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(WIN)("runs the command as the launcher's child", async () => {
    const dir = temp();
    const marker = join(dir, 'started');
    const script = join(dir, 'mark.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], String(process.ppid));`,
    );
    const spawned = spawnHidden(process.execPath, [script, marker], {
      env: process.env,
      out: 'ignore',
    });
    const closed = new Promise<number | null>((r) => spawned.child.on('close', r));
    const launcher = await spawned.launch!.ready;
    spawned.launch!.go('');
    expect(await closed).toBe(0);
    const { readFileSync } = await import('node:fs');
    expect(Number(readFileSync(marker, 'utf8'))).toBe(launcher);
  });

  it.runIf(WIN)('passes safe arguments through a .cmd runtime and refuses the rest', async () => {
    const dir = join(temp(), 'dir with space & (parens)');
    mkdirSync(dir);
    const script = printer(dir);
    const shim = join(dir, 'runtime.cmd');
    writeFileSync(shim, `@"${process.execPath}" "${script}" %*\r\n`);
    const safe = ['plain', 'with space', 'C:\\trailing\\', 'a&b|c<d>e^f', 'Bash(ops *),Read', ''];
    const spawned = spawnHidden(shim, safe, { env: process.env, out: 'pipe' });
    const { code, out } = await output(spawned, 'p');
    expect(code).toBe(0);
    expect((JSON.parse(out) as { args: string[] }).args).toEqual(safe);
    for (const bad of ['say "hi"', 'x%PATH%y', '!PATH!', 'a\nb', 'a\rb']) {
      expect(() => spawnHidden(shim, [bad], { env: process.env, out: 'ignore' })).toThrow(
        /cannot receive unchanged/,
      );
    }
  });
});

describe('killTree', () => {
  it.runIf(WIN)('refuses on Windows instead of a taskkill that can fail unnoticed', () => {
    // An unused PID: a regression returns quietly and fails here, with nothing killed.
    expect(() => killTree(2_147_483_644)).toThrow(/Unix-only/);
  });
});

describe('processStart', () => {
  it('resolves null at once for an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await processStart(process.pid, ac.signal)).toBeNull();
  });

  it('an abort during a read resolves null', async () => {
    const ac = new AbortController();
    const read = processStart(process.pid, ac.signal);
    ac.abort();
    // Linux reads /proc synchronously, so the answer is already in; elsewhere the abort kills
    // the read's child process.
    const got = await read;
    if (process.platform === 'linux') expect(got).not.toBeNull();
    else expect(got).toBeNull();
  });
});

describe('quoteBatch', () => {
  it('quotes what cmd.exe would read and doubles trailing backslashes', () => {
    expect(quoteBatch('plain')).toBe('plain');
    expect(quoteBatch('')).toBe('""');
    expect(quoteBatch('a b')).toBe('"a b"');
    expect(quoteBatch('a&b')).toBe('"a&b"');
    expect(quoteBatch('C:\\x y\\')).toBe('"C:\\x y\\\\"');
    expect(() => quoteBatch('50%')).toThrow();
  });
});

describe('killTree', () => {
  it.runIf(!WIN)('SIGKILLs a live group after its leader exits', async () => {
    vi.useFakeTimers();
    const pid = 4242;
    let leaderAlive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (signal === 0) {
        if (target === -pid || (target === pid && leaderAlive)) return true;
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (target === -pid && signal === 'SIGTERM') {
        leaderAlive = false;
        return true;
      }
      if (target === -pid && signal === 'SIGKILL') return true;
      throw Object.assign(new Error('unexpected process'), { code: 'ESRCH' });
    });

    killTree(pid);
    await vi.advanceTimersByTimeAsync(5200);

    expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
  });

  it.runIf(!WIN)(
    'does not SIGKILL after the group disappears when the leader PID is reused',
    async () => {
      vi.useFakeTimers();
      const pid = 4242;
      let groupAlive = true;
      const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (signal === 0) {
          // The positive PID now names an unrelated process; the original group is gone.
          if (target === pid || (target === -pid && groupAlive)) return true;
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        }
        if (target === -pid && signal === 'SIGTERM') {
          groupAlive = false;
          return true;
        }
        if (target === -pid && signal === 'SIGKILL') return true;
        throw Object.assign(new Error('unexpected process'), { code: 'ESRCH' });
      });

      killTree(pid);
      await vi.advanceTimersByTimeAsync(5200);

      expect(kill).not.toHaveBeenCalledWith(-pid, 'SIGKILL');
    },
  );
});
