import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { world, SCENARIO_TIMEOUT } from './mirror-world.js';

describe('Master Repo mirror: attachments', { timeout: SCENARIO_TIMEOUT }, () => {
  it('carries attached images both ways', async () => {
    const w = world();
    const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, n]);
    w.m1('human:dawid').newTask({ title: 'pricing page' });
    const fromProject = w.m1('human:dawid').attach(png(1), { task: 'site/WEB-0001' });
    await w.sync1();
    await w.sync2();
    const there = w.m2('human:dawid').attachment(fromProject.name);
    expect(there.root).toBe('site');
    expect(readFileSync(there.file)).toEqual(png(1));

    const fromMaster = w.m2('human:dawid').attach(png(2), { task: 'site/WEB-0001' });
    await w.sync2();
    await w.sync1();
    const back = w.m1('human:dawid').attachment(fromMaster.name);
    expect(back.file.startsWith(join(w.site.clone, '.agent-ops'))).toBe(true);
    expect(readFileSync(back.file)).toEqual(png(2));
  });
});
