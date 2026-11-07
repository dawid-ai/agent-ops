import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { state, world, SCENARIO_TIMEOUT } from './mirror-world.js';

describe('Master Repo mirror: claim race', { timeout: SCENARIO_TIMEOUT }, () => {
  it('settles a claim race between the project root and the Master Repo the same way on both', async () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'pricing page', owner: '*:engineer' });
    await w.sync1();
    await w.sync2();
    // Both machines claim before either sees the other.
    w.m1('claude:engineer').claim('site/WEB-0001');
    w.m2('codex:engineer').claim('site/WEB-0001');
    await w.sync2();
    await w.sync1();
    await w.sync2();
    await w.sync1();
    const one = state(w.m1('human:dawid'), 'site/WEB-0001');
    const two = state(w.m2('human:dawid'), 'site/WEB-0001');
    expect(one).toEqual(two);
    expect(['claude:engineer', 'codex:engineer']).toContain(one.claimedBy);
    // Both sides hold the same event files.
    const names = (dir: string) => readdirSync(dir).sort();
    expect(names(join(w.site.clone, '.agent-ops', 'tasks', 'WEB-0001', 'events'))).toEqual(
      names(join(w.hub2, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001', 'events')),
    );
    // The losing side learns it lost.
    const loserWs =
      one.claimedBy === 'claude:engineer' ? w.m2('codex:engineer') : w.m1('claude:engineer');
    expect(loserWs.holdsClaim('site/WEB-0001')).toBe(false);
  });
});
