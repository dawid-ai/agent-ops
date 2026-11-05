import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dropEnv, runEnv } from '../src/index.js';

describe('run environment', () => {
  it('drops what only opsd inside the desktop app needs', () => {
    const env = runEnv(
      { ELECTRON_RUN_AS_NODE: '1', OPS_DAEMON_ENTRY: 'C:/app/opsd.mjs', KEEP: 'yes' },
      { OPS_AGENT: 'claude:engineer' },
    );
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.OPS_DAEMON_ENTRY).toBeUndefined();
    expect(env).toMatchObject({ KEEP: 'yes', OPS_AGENT: 'claude:engineer' });
  });

  it("puts the installed app's bin folder first on PATH, once, whatever the key's case", () => {
    // No drive letters: on Linux the PATH delimiter is a colon.
    const bin = '/opt/Agent Ops/resources/bin';
    const env = runEnv(
      { OPS_BIN_DIR: `${bin}/`, Path: ['/opt/tools', bin, '/opt/other'].join(delimiter) },
      {},
    );
    expect(env.Path).toBe([bin, '/opt/tools', '/opt/other'].join(delimiter));
    expect(env.PATH).toBeUndefined();
  });

  it('leaves PATH alone without a bin folder', () => {
    expect(runEnv({ PATH: 'a' }, {}).PATH).toBe('a');
    expect(runEnv({}, {}).PATH).toBeUndefined();
  });
});

describe('dropEnv', () => {
  it('drops a name in any case on Windows', () => {
    const env = { Github_Token: 'a', gh_token: 'b', KEEP: 'c' };
    dropEnv(env, ['GITHUB_TOKEN', 'GH_TOKEN'], 'win32');
    expect(env).toEqual({ KEEP: 'c' });
  });

  it('drops only the exact name elsewhere', () => {
    const env = { GITHUB_TOKEN: 'a', Github_Token: 'b' };
    dropEnv(env, ['GITHUB_TOKEN'], 'linux');
    expect(env).toEqual({ Github_Token: 'b' });
  });
});
