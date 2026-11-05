// Copies the committed code of this repository into a checkout of the public repository and
// commits it there. Everything marked `export-ignore` in .gitattributes stays out: the task store
// (.agent-ops/) holds private conversations and decisions and never leaves this repository.
//
// Usage: node scripts/export-public.mjs <public-checkout> [--message "Release 0.2.0-beta.1"]
//
// The public checkout must be a git repository with no changes of its own. The script replaces
// every file in it (except .git) with HEAD of this repository, then commits. It never pushes.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const target = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : null;
const at = args.indexOf('--message');
const message = at >= 0 ? args[at + 1] : null;
if (!target || (at >= 0 && !message)) {
  console.error('usage: node scripts/export-public.mjs <public-checkout> [--message TEXT]');
  process.exit(2);
}

const git = (cwd, ...a) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).trim();

if (!existsSync(join(target, '.git'))) {
  console.error(`${target} is not a git checkout`);
  process.exit(2);
}
if (resolve(target) === resolve(top)) {
  console.error('the target is this repository');
  process.exit(2);
}
if (git(target, 'status', '--porcelain')) {
  console.error(`${target} has changes of its own: commit or discard them first`);
  process.exit(1);
}
if (git(top, 'status', '--porcelain', '--untracked-files=no')) {
  console.error('this repository has uncommitted changes: the export takes HEAD, commit first');
  process.exit(1);
}

// Only what git archive leaves out may be private: refuse if the task store would be included.
const attrs = git(top, 'check-attr', 'export-ignore', '--', '.agent-ops/config.yml');
if (!attrs.endsWith('export-ignore: set')) {
  console.error('.agent-ops is not export-ignore in .gitattributes: refusing to export');
  process.exit(1);
}

for (const name of readdirSync(target)) {
  if (name !== '.git') rmSync(join(target, name), { recursive: true, force: true });
}

// Git alone writes the files: a throwaway index holds HEAD minus every export-ignore path, and
// checkout-index writes it into the target. This repository's own index and files stay as they
// are, and no tar is needed (Git Bash's tar reads `C:` as a host name).
const tmp = mkdtempSync(join(tmpdir(), 'ops-export-'));
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
  const run = (...a) => execFileSync('git', a, { cwd: top, env, windowsHide: true, stdio: 'pipe' });
  run('read-tree', 'HEAD');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: top, env, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  // One check-attr for every file: output is path NUL attribute NUL value NUL, per file.
  const attrs = execFileSync('git', ['check-attr', '--stdin', '-z', 'export-ignore'], {
    cwd: top,
    input: files.join('\0'),
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  }).split('\0');
  const ignored = [];
  for (let i = 0; i + 2 < attrs.length; i += 3) {
    if (attrs[i + 2] === 'set') ignored.push(attrs[i]);
  }
  // Exactly those paths leave the throwaway index, read from stdin (no command-line limit).
  if (ignored.length > 0) {
    execFileSync('git', ['update-index', '--force-remove', '-z', '--stdin'], {
      cwd: top,
      env,
      input: `${ignored.join('\0')}\0`,
      windowsHide: true,
    });
  }
  run(`--work-tree=${target}`, 'checkout-index', '-a', '-f');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (existsSync(join(target, '.agent-ops'))) {
  console.error('.agent-ops reached the export: stopping before any commit');
  process.exit(1);
}

const head = git(top, 'rev-parse', '--short', 'HEAD');
const version = JSON.parse(
  execFileSync('git', ['show', 'HEAD:package.json'], { cwd: top, encoding: 'utf8' }),
).version;
git(target, 'add', '-A');
if (!git(target, 'status', '--porcelain')) {
  console.log('nothing changed since the last export');
  process.exit(0);
}
git(target, 'commit', '-q', '-m', message ?? `Agent Ops ${version}`);
console.log(`exported ${head} (${version}) to ${target}: ${git(target, 'log', '--oneline', '-1')}`);
