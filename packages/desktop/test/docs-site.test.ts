// The docs site build (scripts/build-docs.mjs) and its link check (scripts/check-docs-links.mjs),
// run on scratch repos.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'ops-docs-'));
  dirs.push(d);
  const all = { 'package.json': '{"repository":"github:me/proj"}', ...files };
  for (const [name, body] of Object.entries(all)) {
    mkdirSync(dirname(join(d, name)), { recursive: true });
    writeFileSync(join(d, name), body);
  }
  return d;
}

function node(script: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const build = (d: string) => node('build-docs.mjs', '--root', d);
const check = (d: string) => node('check-docs-links.mjs', join(d, 'dist', 'docs'));
const page = (d: string, p: string) => readFileSync(join(d, 'dist', 'docs', p), 'utf8');

describe('docs site', () => {
  it('builds README and docs/ into pages and rewrites their links', () => {
    const d = repo({
      'README.md':
        '# Proj\n\nRead [the protocol](docs/protocol.md#two-words) and [the license](LICENSE).\n',
      LICENSE: 'MIT\n',
      'docs/protocol.md':
        '# Protocol\n\n## Two words\n\n## Two words\n\nBack to [home](../README.md).\n',
      'docs/proposals/p1.md': '# First proposal\n\nSee [protocol](../protocol.md#two-words-1).\n',
    });
    const r = build(d);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/3 page\(s\) written/);

    const index = page(d, 'index.html');
    expect(index).toContain('href="protocol.html#two-words"');
    expect(index).toContain('href="https://github.com/me/proj/blob/main/LICENSE"');
    expect(index).toContain('<title>Proj</title>');

    const protocol = page(d, 'protocol.html');
    expect(protocol).toContain('id="two-words"');
    expect(protocol).toContain('id="two-words-1"');
    expect(protocol).toContain('href="index.html"');

    const proposal = page(d, 'proposals/p1.html');
    expect(proposal).toContain('href="../protocol.html#two-words-1"');
    expect(proposal).toContain('href="../style.css"');
    expect(proposal).toContain('<p class="group">Proposals</p>');
    expect(existsSync(join(d, 'dist', 'docs', 'style.css'))).toBe(true);

    expect(check(d).code).toBe(0);
  });

  it('fails on a link to a missing file or an anchor no heading has, and writes nothing', () => {
    const d = repo({
      'README.md': '# Proj\n\n[gone](docs/gone.md) and [here](#nowhere)\n',
      'docs/a.md': '# A\n\n[bad anchor](../README.md#missing)\n',
    });
    const r = build(d);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/README\.md: broken link docs\/gone\.md/);
    expect(r.out).toMatch(/README\.md: broken anchor #nowhere/);
    expect(r.out).toMatch(/docs\/a\.md: broken anchor #missing/);
    expect(existsSync(join(d, 'dist', 'docs'))).toBe(false);
  });

  it('link check fails on a broken link in the built site', () => {
    const d = repo({ 'README.md': '# Proj\n\n## Part\n' });
    expect(build(d).code).toBe(0);
    const site = join(d, 'dist', 'docs');
    writeFileSync(
      join(site, 'extra.html'),
      '<a href="index.html#part">ok</a> <a href="index.html#nope">x</a> <a href="gone.html">y</a>',
    );
    const r = check(d);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/extra\.html: broken anchor index\.html#nope/);
    expect(r.out).toMatch(/extra\.html: broken link gone\.html/);
    expect(r.out).not.toMatch(/#part/);
  });

  it('refuses an output folder that holds a source file', () => {
    const d = repo({ 'README.md': '# Proj\n' });
    const r = node('build-docs.mjs', '--root', d, '--out', d);
    expect(r.code).toBe(2);
    expect(existsSync(join(d, 'README.md'))).toBe(true);
  });
});
