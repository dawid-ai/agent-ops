import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const top = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const source = readFileSync(join(top, 'skills', 'agent-ops', 'SKILL.md'), 'utf8');

describe('agent-ops skill', () => {
  it('has identical copies for Claude Code and Codex', () => {
    for (const dir of ['.claude', '.agents']) {
      const copy = readFileSync(join(top, dir, 'skills', 'agent-ops', 'SKILL.md'), 'utf8');
      expect(copy, `${dir}/skills/agent-ops/SKILL.md differs from skills/agent-ops/SKILL.md`).toBe(
        source,
      );
    }
  });

  it('names only commands that exist', () => {
    const out: string[] = [];
    run(['help'], { out: (l) => out.push(l), err: () => {}, env: {}, cwd: top });
    const known = new Set(out.map((l) => l.trim().split(/\s+/)[0]));
    const used = new Set([...source.matchAll(/`ops ([a-z-]+)/g)].map((m) => m[1]));
    for (const cmd of used) expect(known, `ops ${cmd}`).toContain(cmd);
  });
});
