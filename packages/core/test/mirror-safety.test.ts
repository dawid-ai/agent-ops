import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mirrorPair, Root } from '../src/index.js';
import { git, tempDir } from './helpers.js';
import { hosted, machine, SCENARIO_TIMEOUT } from './mirror-world.js';

// The two-machine scenarios are in mirror-safety-task-md.test.ts and
// mirror-safety-upstream.test.ts, so they run in parallel with these.
describe('Master Repo mirror safety', { timeout: SCENARIO_TIMEOUT }, () => {
  it('never writes outside the Master Repo for an odd root name', () => {
    const site = hosted('site', 'WEB', true);
    const hub = hosted('hub', 'HUB');
    const cfg = join(site.clone, '.agent-ops', 'config.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('name: site', 'name: ../../escaped'));
    const res = mirrorPair(
      new Root(join(site.clone, '.agent-ops')),
      new Root(join(hub.clone, '.agent-ops')),
    );
    expect(res.notes.join('\n')).toMatch(/not mirrored/);
    expect(existsSync(join(hub.clone, 'escaped'))).toBe(false);
    expect(existsSync(join(hub.clone, '.agent-ops', 'escaped'))).toBe(false);
  });

  it('does not mirror while the Master Repo checkout is off its store branch', async () => {
    const site = hosted('site', 'WEB', true);
    const hub = hosted('hub', 'HUB');
    const m = machine(site.clone, hub.clone, 0);
    await m.sync();
    git(hub.clone, 'checkout', '-q', '-b', 'code');
    m.ws('human:dawid').newTask({ title: 'held' });
    const res = await m.sync();
    expect(res.flatMap((r) => r.result.notes).join('\n')).toMatch(
      /hub: not mirrored; code is checked out, but the store branch is main/,
    );
    expect(existsSync(join(hub.clone, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001'))).toBe(
      false,
    );
    expect(git(hub.clone, 'log', '--oneline', 'main..code')).toBe('');
  });

  it('never writes through a link in the Master Repo', () => {
    const site = hosted('site', 'WEB', true);
    const hub = hosted('hub', 'HUB');
    const outside = tempDir();
    symlinkSync(outside, join(hub.clone, '.agent-ops', 'mirrors'), 'junction');
    const res = mirrorPair(
      new Root(join(site.clone, '.agent-ops')),
      new Root(join(hub.clone, '.agent-ops')),
    );
    expect(res.notes.join('\n')).toMatch(/through a link/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('never writes mirror state through a linked .ops folder', () => {
    const site = hosted('site', 'WEB', true);
    const hub = hosted('hub', 'HUB');
    const outside = tempDir();
    symlinkSync(outside, join(site.clone, '.agent-ops', '.ops'), 'junction');
    const res = mirrorPair(
      new Root(join(site.clone, '.agent-ops')),
      new Root(join(hub.clone, '.agent-ops')),
    );
    expect(res.notes.join('\n')).toMatch(/through a link/);
    expect(readdirSync(outside)).toEqual([]);
  });
});
