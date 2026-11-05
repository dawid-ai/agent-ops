// The release gate (scripts/check-release.mjs) and the changelog fold
// (scripts/fold-changelog.mjs), run on scratch repos.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HEAD = '# Changelog\n\nIntro.\n';
const UPDATES =
  '# Updates\n\n## v1.0.0-beta.2 (2026-11-03)\n\nThe new one.\n\n## v1.0.0-beta.1 (2026-10-01)\n\nOld.\n';

function repo(o: { changelog?: string; fragments?: Record<string, string>; updates?: string }) {
  const d = mkdtempSync(join(tmpdir(), 'ops-release-'));
  dirs.push(d);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '1.0.0-beta.2' }));
  writeFileSync(join(d, 'CHANGELOG.md'), o.changelog ?? HEAD);
  writeFileSync(join(d, 'UPDATES.md'), o.updates ?? UPDATES);
  mkdirSync(join(d, 'changelog.d'));
  writeFileSync(join(d, 'changelog.d', 'README.md'), 'How fragments work.\n');
  for (const [name, body] of Object.entries(o.fragments ?? {})) {
    writeFileSync(join(d, 'changelog.d', name), body);
  }
  return d;
}

function node(script: string, root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args, '--root', root], {
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('release gate', () => {
  it('refuses a tag whose changelog has no heading or still has fragments', () => {
    const d = repo({ fragments: { 'x.added.md': '- X\n' } });
    const r = node('check-release.mjs', d, 'v1.0.0-beta.2');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no "## 1\.0\.0-beta\.2 \(" heading/);
    expect(r.out).toMatch(/1 unfolded fragment\(s\) \(x\.added\.md\)/);
  });

  it('refuses a tag that does not match package.json or has no UPDATES entry', () => {
    const d = repo({ changelog: `${HEAD}\n## 1.0.0-beta.3 (2026-11-03)\n\n- X\n` });
    const r = node('check-release.mjs', d, 'v1.0.0-beta.3');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/package\.json is 1\.0\.0-beta\.2, not 1\.0\.0-beta\.3/);
    expect(r.out).toMatch(/UPDATES\.md has no "## v1\.0\.0-beta\.3 " entry/);
  });

  it('passes after the fold', () => {
    const d = repo({ fragments: { 'x.added.md': '- X\n', 'y.fixed.md': 'Y as a paragraph.\n' } });
    expect(node('fold-changelog.mjs', d, '1.0.0-beta.2', '2026-11-03').code).toBe(0);
    expect(readdirSync(join(d, 'changelog.d'))).toEqual(['README.md']);
    expect(node('check-release.mjs', d, 'v1.0.0-beta.2')).toEqual({
      code: 0,
      out: 'ready to release 1.0.0-beta.2\n',
    });
  });
});

describe('changelog fold', () => {
  it('puts the new version above the older ones', () => {
    const d = repo({
      changelog: `${HEAD}\n## 1.0.0-beta.1 (2026-10-01)\n\n### Added\n\n- Old\n`,
      fragments: { 'x.added.md': '- X\n', 'y.fixed.md': 'Y\n' },
    });
    node('fold-changelog.mjs', d, '1.0.0-beta.2', '2026-11-03');
    expect(readFileSync(join(d, 'CHANGELOG.md'), 'utf8')).toBe(
      `${HEAD}\n## 1.0.0-beta.2 (2026-11-03)\n\n### Added\n\n- X\n\n### Fixed\n\n- Y\n\n## 1.0.0-beta.1 (2026-10-01)\n\n### Added\n\n- Old\n`,
    );
  });

  it('adds later fragments to a version folded already, keeping its date', () => {
    const d = repo({
      changelog: `${HEAD}\n## 1.0.0-beta.2 (2026-11-01)\n\n### Fixed\n\n- First fix\n\n## 1.0.0-beta.1 (2026-10-01)\n\n- Old\n`,
      fragments: { 'a.added.md': '- New feature\n', 'b.fixed.md': '- Second fix\n' },
    });
    node('fold-changelog.mjs', d, '1.0.0-beta.2', '2026-11-03');
    expect(readFileSync(join(d, 'CHANGELOG.md'), 'utf8')).toBe(
      `${HEAD}\n## 1.0.0-beta.2 (2026-11-01)\n\n### Added\n\n- New feature\n\n### Fixed\n\n- First fix\n- Second fix\n\n## 1.0.0-beta.1 (2026-10-01)\n\n- Old\n`,
    );
  });
});
