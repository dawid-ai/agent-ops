import { describe, expect, it } from 'vitest';
import { withRepeat, SCENARIO_TIMEOUT } from './mirror-world.js';

describe('Master Repo mirror: repeat edits', { timeout: SCENARIO_TIMEOUT }, () => {
  it('carries a repeat edit and a delete both ways', async () => {
    const w = await withRepeat();
    // An edit in the project root reaches the Master Repo and is not undone by the old copy.
    w.m1('human:dawid').saveRepeat(
      { name: 'report', title: 'Daily report v2', start: '2026-11-01 09:00', repeat: 'daily' },
      { replace: true },
    );
    await w.sync1();
    await w.sync2();
    expect(w.m2('human:dawid').repeatView('site/report').meta.title).toBe('Daily report v2');
    expect(w.m1('human:dawid').repeatView('site/report').meta.title).toBe('Daily report v2');

    // A delete on either side removes it on both.
    w.m2('human:dawid').deleteRepeat('site/report');
    await w.sync2();
    await w.sync1();
    expect(w.m1('human:dawid').repeats()).toEqual([]);
    await w.sync1();
    await w.sync2();
    expect(w.m2('human:dawid').repeats()).toEqual([]);
  });
});
