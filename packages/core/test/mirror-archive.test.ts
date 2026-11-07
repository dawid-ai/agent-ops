import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Root } from '../src/index.js';
import { world, SCENARIO_TIMEOUT } from './mirror-world.js';

describe('Master Repo mirror: archive', { timeout: SCENARIO_TIMEOUT }, () => {
  it('carries an archive move to the Master Repo', async () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'old title' });
    await w.sync1();
    await w.sync2();
    w.m1('human:dawid').done('site/WEB-0001');
    new Root(join(w.site.clone, '.agent-ops')).archiveTask('WEB-0001');
    await w.sync1();
    await w.sync2();
    expect(
      existsSync(join(w.hub2, '.agent-ops', 'mirrors', 'site', 'archive', 'tasks', 'WEB-0001')),
    ).toBe(true);
    expect(existsSync(join(w.hub2, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001'))).toBe(
      false,
    );
  });
});
