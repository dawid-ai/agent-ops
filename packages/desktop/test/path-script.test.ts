// Runs build/path.ps1 against scratch keys under HKCU\Software, so it never touches the real
// PATH. Windows only.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../build/path.ps1', import.meta.url));
const root = `HKCU\\Software\\AgentOpsTest-${randomUUID()}`;
const DIR = 'C:\\Users\\me\\AppData\\Local\\Programs\\Agent Ops\\resources\\bin';

type Kind = 'REG_SZ' | 'REG_EXPAND_SZ';
let n = 0;

function reg(args: string[]): string {
  return execFileSync('reg.exe', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A fresh pair of keys: one stands in for HKCU\Environment, one for the ownership record. */
function scratch(path?: string, kind: Kind = 'REG_EXPAND_SZ'): { env: string; state: string } {
  n += 1;
  const env = `${root}\\env${n}`;
  const state = `${root}\\state${n}`;
  reg(['add', env, '/f']);
  // reg.exe cannot write an empty REG_*SZ through /d "", so the empty case goes through PowerShell.
  if (path !== undefined) setPath(env, path, kind);
  return { env, state };
}

function ps(command: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  }).replace(/\r?\n$/, '');
}

const sub = (key: string): string => key.replace(/^HKCU\\/, '').replace(/'/g, "''");
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function setPath(env: string, value: string, kind: Kind): void {
  const k = kind === 'REG_SZ' ? 'String' : 'ExpandString';
  ps(
    `$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${lit(sub(env))}); $k.SetValue('Path', ${lit(value)}, '${k}'); $k.Close()`,
  );
}

/** The raw value and kind, or null when there is no Path value. */
function getPath(env: string): { value: string; kind: string } | null {
  const out = ps(
    `$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${lit(sub(env))}); if ($k.GetValueNames() -contains 'Path') { $k.GetValueKind('Path').ToString() + '|' + $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '<none>' }`,
  );
  if (out === '<none>') return null;
  const bar = out.indexOf('|');
  return { kind: out.slice(0, bar), value: out.slice(bar + 1) };
}

function run(action: 'add' | 'remove', keys: { env: string; state: string }, dir = DIR): void {
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Action',
    action,
    '-Dir',
    dir,
    '-EnvKey',
    sub(keys.env),
    '-StateKey',
    sub(keys.state),
    '-NoBroadcast',
  ]);
}

afterAll(() => {
  if (process.platform === 'win32') {
    try {
      reg(['delete', root, '/f']);
    } catch {
      // Nothing was created.
    }
  }
});

describe.runIf(process.platform === 'win32')('path.ps1', { timeout: 30_000 }, () => {
  it('appends and removes its folder byte for byte, keeping %VARIABLES% and the kind', () => {
    const before = '%USERPROFILE%\\bin;C:\\tools;;%LOCALAPPDATA%\\x';
    const keys = scratch(before);
    run('add', keys);
    expect(getPath(keys.env)).toEqual({ kind: 'ExpandString', value: `${before};${DIR}` });
    run('remove', keys);
    expect(getPath(keys.env)).toEqual({ kind: 'ExpandString', value: before });
  });

  it('keeps a REG_SZ value REG_SZ and a trailing semicolon', () => {
    const keys = scratch('C:\\a;C:\\b;', 'REG_SZ');
    run('add', keys);
    expect(getPath(keys.env)).toEqual({ kind: 'String', value: `C:\\a;C:\\b;${DIR}` });
    run('remove', keys);
    expect(getPath(keys.env)).toEqual({ kind: 'String', value: 'C:\\a;C:\\b;' });
  });

  it('handles a long value', () => {
    const before = Array.from({ length: 300 }, (_, i) => `C:\\long\\folder\\number${i}`).join(';');
    expect(before.length).toBeGreaterThan(2048);
    const keys = scratch(before);
    run('add', keys);
    expect(getPath(keys.env)?.value).toBe(`${before};${DIR}`);
    run('remove', keys);
    expect(getPath(keys.env)?.value).toBe(before);
  });

  it('leaves an entry the person already had, in any case or with a trailing backslash', () => {
    for (const existing of [DIR, DIR.toUpperCase(), `${DIR}\\`, ` ${DIR.toLowerCase()}\\`]) {
      const before = `C:\\a;${existing};C:\\b`;
      const keys = scratch(before);
      run('add', keys);
      expect(getPath(keys.env)?.value).toBe(before);
      run('remove', keys);
      expect(getPath(keys.env)?.value).toBe(before);
    }
  });

  it('removes only its own entry when the person added more after it, and keeps duplicates', () => {
    const keys = scratch('C:\\a');
    run('add', keys);
    // Later edits: something appended after ours, and an empty segment.
    setPath(keys.env, `C:\\a;${DIR};;C:\\later`, 'REG_EXPAND_SZ');
    run('remove', keys);
    expect(getPath(keys.env)?.value).toBe('C:\\a;;C:\\later');

    const twice = scratch('C:\\a');
    run('add', twice);
    setPath(twice.env, `C:\\a;${DIR};C:\\later;${DIR.toUpperCase()}`, 'REG_EXPAND_SZ');
    run('remove', twice);
    expect(getPath(twice.env)?.value).toBe(`C:\\a;C:\\later;${DIR.toUpperCase()}`);
  });

  it('removes its own entry, not an identical one the person appended later', () => {
    const keys = scratch('C:\\a');
    run('add', keys);
    // The person appends the very same folder after ours.
    setPath(keys.env, `C:\\a;${DIR};${DIR}`, 'REG_EXPAND_SZ');
    run('remove', keys);
    expect(getPath(keys.env)?.value).toBe(`C:\\a;${DIR}`);

    const between = scratch('C:\\a');
    run('add', between);
    setPath(between.env, `C:\\a;${DIR};C:\\later;${DIR}`, 'REG_EXPAND_SZ');
    run('remove', between);
    expect(getPath(between.env)?.value).toBe(`C:\\a;C:\\later;${DIR}`);
  });

  it('gives back a trailing semicolon when more was appended after its entry', () => {
    const keys = scratch('C:\\a;');
    run('add', keys);
    expect(getPath(keys.env)?.value).toBe(`C:\\a;${DIR}`);
    setPath(keys.env, `C:\\a;${DIR};C:\\later`, 'REG_EXPAND_SZ');
    run('remove', keys);
    expect(getPath(keys.env)?.value).toBe('C:\\a;;C:\\later');

    // The same with an identical duplicate appended too.
    const dup = scratch('C:\\a;');
    run('add', dup);
    setPath(dup.env, `C:\\a;${DIR};${DIR}`, 'REG_EXPAND_SZ');
    run('remove', dup);
    expect(getPath(dup.env)?.value).toBe(`C:\\a;;${DIR}`);
  });

  it('drops the joining semicolon when PATH was empty before install', () => {
    const keys = scratch();
    run('add', keys);
    setPath(keys.env, `${DIR};C:\\later`, 'REG_EXPAND_SZ');
    run('remove', keys);
    expect(getPath(keys.env)?.value).toBe('C:\\later');
  });

  it('does not take a longer entry that only starts with its folder', () => {
    const keys = scratch('C:\\a');
    run('add', keys);
    setPath(keys.env, `C:\\a;${DIR}-old;C:\\b`, 'REG_EXPAND_SZ');
    run('remove', keys);
    expect(getPath(keys.env)?.value).toBe(`C:\\a;${DIR}-old;C:\\b`);
  });

  it('leaves PATH alone once anything at or before its entry changed', () => {
    // The person removed ours, put C:\new in front and added the same folder themselves. The
    // value cannot show that the remaining entry is theirs, so remove must not touch it.
    const replaced = scratch('C:\\a');
    run('add', replaced);
    setPath(replaced.env, `C:\\new;C:\\a;${DIR}`, 'REG_EXPAND_SZ');
    run('remove', replaced);
    expect(getPath(replaced.env)?.value).toBe(`C:\\new;C:\\a;${DIR}`);

    // Something was put in front and more appended after.
    const front = scratch('C:\\a');
    run('add', front);
    setPath(front.env, `C:\\new;C:\\a;${DIR};C:\\later`, 'REG_EXPAND_SZ');
    run('remove', front);
    expect(getPath(front.env)?.value).toBe(`C:\\new;C:\\a;${DIR};C:\\later`);

    // The old value ended in ';' and something was put in front.
    const trailing = scratch('C:\\a;');
    run('add', trailing);
    setPath(trailing.env, `C:\\new;C:\\a;${DIR};C:\\later`, 'REG_EXPAND_SZ');
    run('remove', trailing);
    expect(getPath(trailing.env)?.value).toBe(`C:\\new;C:\\a;${DIR};C:\\later`);

    // An entry before ours was edited in place.
    const edited = scratch('C:\\a;C:\\b');
    run('add', edited);
    setPath(edited.env, `C:\\a;C:\\B;${DIR}`, 'REG_EXPAND_SZ');
    run('remove', edited);
    expect(getPath(edited.env)?.value).toBe(`C:\\a;C:\\B;${DIR}`);

    // Two exact matches after a front insertion.
    const two = scratch('C:\\a');
    run('add', two);
    setPath(two.env, `C:\\new;${DIR};C:\\a;${DIR}`, 'REG_EXPAND_SZ');
    run('remove', two);
    expect(getPath(two.env)?.value).toBe(`C:\\new;${DIR};C:\\a;${DIR}`);

    // The record is cleared either way, so a later uninstall does not act on stale context.
    setPath(replaced.env, `C:\\a;${DIR}`, 'REG_EXPAND_SZ');
    run('remove', replaced);
    expect(getPath(replaced.env)?.value).toBe(`C:\\a;${DIR}`);
  });

  it('does nothing on remove when it never added the entry', () => {
    const keys = scratch(`C:\\a;${DIR}`);
    run('remove', keys);
    expect(getPath(keys.env)?.value).toBe(`C:\\a;${DIR}`);
  });

  it('removes only once, so a second uninstall leaves PATH alone', () => {
    const keys = scratch('C:\\a');
    run('add', keys);
    run('remove', keys);
    setPath(keys.env, `C:\\a;${DIR}`, 'REG_EXPAND_SZ');
    run('remove', keys);
    expect(getPath(keys.env)?.value).toBe(`C:\\a;${DIR}`);
  });

  it('creates PATH when there was none and deletes it again, or keeps an empty one', () => {
    const none = scratch();
    run('add', none);
    expect(getPath(none.env)).toEqual({ kind: 'ExpandString', value: DIR });
    run('remove', none);
    expect(getPath(none.env)).toBeNull();

    const empty = scratch('', 'REG_SZ');
    run('add', empty);
    expect(getPath(empty.env)).toEqual({ kind: 'String', value: DIR });
    run('remove', empty);
    expect(getPath(empty.env)).toEqual({ kind: 'String', value: '' });
  });
});
