import { describe, expect, it } from 'vitest';
import { withRepeat, SCENARIO_TIMEOUT } from './mirror-world.js';

// Edits and deletes are in mirror-repeat-edits.test.ts, so the two run in parallel.
describe('Master Repo mirror: repeats', { timeout: SCENARIO_TIMEOUT }, () => {
  it('fires a repeat on a machine with only the Master Repo, and carries a pause back', async () => {
    const w = await withRepeat();
    const now = () => new Date(2026, 10, 3, 12).getTime();
    // A machine with only the Master Repo sees the repeat and fires it.
    const ws2 = w.m2('human:dawid', now);
    expect(ws2.repeats().map((r) => `${r.root}/${r.meta.name}`)).toEqual(['site/report']);
    expect(ws2.fireRepeats().map((f) => `${f.root} ${f.slot}`)).toEqual(['site 2026-11-03T09:00']);

    // A pause in the Master Repo reaches the project root.
    w.m2('human:dawid').setRepeatPaused('site/report', true);
    await w.sync2();
    await w.sync1();
    const ws1 = w.m1('human:dawid', now);
    expect(ws1.repeatView('site/report').meta.paused).toBe(true);
    // The task it fired came across too: the project root does not fire that slot again.
    ws1.setRepeatPaused('site/report', false);
    expect(ws1.fireRepeats()).toEqual([]);
  });
});
