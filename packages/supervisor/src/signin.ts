// A runtime that is signed out (AO-0154): how to sign in again, and a sign-in check that sends no
// prompt, through the CLI's own status command.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { quoteBatch } from './proc.js';

/** How to sign in to a known runtime again, for the notice and the app's banner. */
export const SIGN_IN_STEPS: Record<string, string> = {
  claude: 'run `claude`, then `/login`',
  codex: 'run `codex login`',
};

/** How to sign in to `provider` again, in words. */
export function signInSteps(provider: string): string {
  return SIGN_IN_STEPS[provider] ?? `sign in to ${provider} again`;
}

/**
 * The status command of a known runtime: arguments after its `command` (and `args`) that print
 * whether it is signed in, without starting a session or calling a model.
 */
export const SIGN_IN_CHECKS: Record<string, string[]> = {
  claude: ['auth', 'status'],
  codex: ['login', 'status'],
};

/** What a sign-in check found: signed in, signed out, or nothing opsd can read. */
export type SignInAnswer = 'in' | 'out' | 'unknown';

/** How long a sign-in check may take before opsd stops it and counts it as unknown. */
export const SIGN_IN_CHECK_TIMEOUT_MS = 15_000;

/**
 * Reads a status command's exit code and output. `claude auth status` prints JSON with
 * `loggedIn`; `codex login status` prints `Logged in using ...` or `Not logged in`. Anything else,
 * such as an older CLI that has no such command, is `unknown`, never `in`.
 */
export function readSignInCheck(exit: number | null, output: string): SignInAnswer {
  const json = /"loggedIn"\s*:\s*(true|false)/.exec(output);
  if (json) return json[1] === 'true' ? (exit === 0 ? 'in' : 'unknown') : 'out';
  if (
    /\bnot (logged|signed) in\b|\blogged out\b|\bno credentials\b|please (run \/login|log ?in)/i.test(
      output,
    )
  )
    return 'out';
  if (exit === 0 && /\b(logged|signed) in\b/i.test(output)) return 'in';
  return 'unknown';
}

/**
 * Runs a sign-in check: `file` with `args`, stdin closed, no window, in the home folder (so it
 * holds no checkout or state folder open), stopped after `timeoutMs` or when `signal` aborts. A
 * `.cmd` or `.bat` file runs through `cmd.exe`, as runs do. Never throws.
 */
export function runSignInCheck(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = SIGN_IN_CHECK_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<SignInAnswer> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve('unknown');
    let out = '';
    let settled = false;
    const settle = (a: SignInAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(a);
    };
    let child: ReturnType<typeof spawn>;
    try {
      const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
      const opts = {
        cwd: homedir(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      };
      child = batch
        ? spawn(
            process.env.ComSpec ?? 'cmd.exe',
            ['/d', '/v:off', '/s', '/c', `"${[file, ...args].map(quoteBatch).join(' ')}"`],
            { ...opts, windowsVerbatimArguments: true },
          )
        : spawn(file, args, opts);
    } catch {
      resolve('unknown');
      return;
    }
    // Only this check's own process, by the handle that started it.
    function stop(): void {
      child.kill();
      settle('unknown');
    }
    const timer = setTimeout(stop, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', stop, { once: true });
    const take = (d: Buffer): void => {
      if (out.length < 64 * 1024) out += d.toString('utf8');
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', () => settle('unknown'));
    child.on('close', (code) => settle(readSignInCheck(code, out)));
  });
}
