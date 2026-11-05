// Checks that the repo is ready to release a version, before the release workflow builds it:
// - the version matches the root package.json,
// - CHANGELOG.md has a `## <version> (` heading,
// - changelog.d/ holds no unfolded fragments,
// - UPDATES.md has a non-empty `## v<version> ` entry (the updater shows it as "what's new").
// Prints every problem and exits 1 when there is one.
//
// Usage: node scripts/check-release.mjs <v0.2.0-beta.1 | 0.2.0-beta.1> [--root DIR]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const top =
  rootAt >= 0
    ? resolve(args.splice(rootAt, 2)[1] ?? '.')
    : join(dirname(fileURLToPath(import.meta.url)), '..');
const tag = args[0];
if (!tag) {
  console.error('usage: node scripts/check-release.mjs <version or tag> [--root DIR]');
  process.exit(2);
}
const version = tag.replace(/^v/, '');
const problems = [];

const pkg = JSON.parse(readFileSync(join(top, 'package.json'), 'utf8')).version;
if (pkg !== version) problems.push(`package.json is ${pkg}, not ${version}`);

const changelog = readFileSync(join(top, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
if (!changelog.some((l) => l.startsWith(`## ${version} (`))) {
  problems.push(
    `CHANGELOG.md has no "## ${version} (" heading: run node scripts/fold-changelog.mjs ${version}`,
  );
}

const fragDir = join(top, 'changelog.d');
const fragments = existsSync(fragDir)
  ? readdirSync(fragDir).filter((f) => f !== 'README.md' && f.endsWith('.md'))
  : [];
if (fragments.length > 0) {
  problems.push(
    `changelog.d has ${fragments.length} unfolded fragment(s) (${fragments.slice(0, 3).join(', ')}${fragments.length > 3 ? ', ...' : ''}): run node scripts/fold-changelog.mjs ${version}`,
  );
}

const updates = readFileSync(join(top, 'UPDATES.md'), 'utf8').split(/\r?\n/);
const at = updates.findIndex((l) => l.startsWith(`## v${version} `));
const body = [];
if (at >= 0) {
  for (const l of updates.slice(at + 1)) {
    if (l.startsWith('## ')) break;
    body.push(l);
  }
}
if (body.join('').trim() === '') problems.push(`UPDATES.md has no "## v${version} " entry`);

for (const p of problems) console.error(p);
if (problems.length > 0) process.exit(1);
console.log(`ready to release ${version}`);
