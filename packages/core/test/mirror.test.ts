import { describe, expect, it } from 'vitest';
import { world, SCENARIO_TIMEOUT } from './mirror-world.js';

// The other mirror scenarios are in mirror-*.test.ts, one per file; see mirror-world.ts for why.
describe('Master Repo mirror', { timeout: SCENARIO_TIMEOUT }, () => {
  it('shows a mirrored project root in the Master Repo, on a machine without the project', async () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'pricing page', owner: 'claude:engineer' });
    w.m1('claude:engineer').post('general', 'hello from the project');
    w.m1('claude:engineer').learn({ topic: 'css', title: 'Grid gaps', body: 'Use gap.' });
    await w.sync1();
    // Machine 1 sees the project root once: its own copy in the Master Repo stays hidden.
    expect(
      w
        .m1('human:dawid')
        .roots.map((r) => r.name)
        .sort(),
    ).toEqual(['hub', 'site']);
    await w.sync2();
    const ws2 = w.m2('human:dawid');
    expect(ws2.roots.map((r) => r.name).sort()).toEqual(['hub', 'site']);
    expect(ws2.roots.find((r) => r.name === 'site')!.isMirror).toBe(true);
    expect(ws2.list().map((v) => `${v.root}/${v.meta.id} ${v.meta.title}`)).toEqual([
      'site/WEB-0001 pricing page',
    ]);
    expect(ws2.kb(['gap']).map((h) => h.note.ref)).toEqual(['css/grid-gaps']);
    expect(ws2.channel('general').map((m) => m.body)).toContain('hello from the project');
  });
});
