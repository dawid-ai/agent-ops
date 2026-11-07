import { describe, expect, it } from 'vitest';
import { opsdConfig, readSignInCheck, runSignInCheck, signInSteps } from '../src/index.js';

describe('sign-in check (AO-0154)', () => {
  it('reads the status commands of Claude Code and Codex', () => {
    expect(readSignInCheck(0, '{"loggedIn": true, "authMethod": "claude.ai"}')).toBe('in');
    expect(readSignInCheck(1, '{"loggedIn": false}')).toBe('out');
    expect(readSignInCheck(0, 'Logged in using ChatGPT\n')).toBe('in');
    expect(readSignInCheck(1, 'Not logged in\n')).toBe('out');
    expect(readSignInCheck(1, 'Invalid API key · Please run /login')).toBe('out');
  });

  it('never reads an answer it does not know as signed in', () => {
    // An older CLI without the command, a crash, or help text.
    expect(readSignInCheck(2, "error: unknown command 'auth'")).toBe('unknown');
    expect(readSignInCheck(0, 'Usage: claude [options] [command]')).toBe('unknown');
    expect(readSignInCheck(1, '')).toBe('unknown');
    expect(readSignInCheck(null, '')).toBe('unknown');
    expect(readSignInCheck(1, '{"loggedIn": true}')).toBe('unknown');
  });

  it('runs the check with no prompt and stops one that hangs', async () => {
    const node = process.execPath;
    expect(
      await runSignInCheck(node, ['-e', 'console.log("Logged in using ChatGPT")'], process.env),
    ).toBe('in');
    expect(
      await runSignInCheck(
        node,
        ['-e', 'console.log("Not logged in"); process.exit(1)'],
        process.env,
      ),
    ).toBe('out');
    expect(
      await runSignInCheck(node, ['-e', 'setInterval(() => {}, 1000)'], process.env, 300),
    ).toBe('unknown');
    expect(await runSignInCheck('no-such-command-ao-0154', [], process.env)).toBe('unknown');
    // opsd's stop ends a check at once.
    const stop = new AbortController();
    const hung = runSignInCheck(
      node,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.env,
      60_000,
      stop.signal,
    );
    stop.abort();
    expect(await hung).toBe('unknown');
  });

  it('names how to sign in to each runtime', () => {
    expect(signInSteps('claude')).toBe('run `claude`, then `/login`');
    expect(signInSteps('codex')).toBe('run `codex login`');
    expect(signInSteps('other')).toBe('sign in to other again');
  });

  it('checks the sign-in settings', () => {
    const cfg = (opsd: Record<string, unknown>) => opsdConfig({ opsd } as never);
    expect(cfg({}).signed_out_handoff_minutes).toBe(15);
    expect(cfg({ signed_out_handoff_minutes: 0 }).signed_out_handoff_minutes).toBe(0);
    expect(() => cfg({ signed_out_handoff_minutes: -1 })).toThrow(/signed_out_handoff_minutes/);
    const rt = (sign_in_check: unknown) =>
      cfg({ runtimes: { claude: { command: 'claude', sign_in_check } } });
    expect(rt(false).runtimes.claude!.sign_in_check).toBe(false);
    expect(rt(['auth', 'status']).runtimes.claude!.sign_in_check).toEqual(['auth', 'status']);
    expect(() => rt([])).toThrow(/sign_in_check/);
    expect(() => rt('auth status')).toThrow(/sign_in_check/);
  });
});
