// Leak check for this repo: key files, secret-looking strings and denied terms.
//   node scripts/check-leaks.mjs [--staged] [--deny FILE]... [PATH...]
// --staged checks only files staged for commit (the pre-commit hook). Keep your deny list
// (org names, logins, machine names) outside the repo and pass it with --deny.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDist = join(repo, 'packages', 'core', 'dist', 'secrets.js');
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

if (!existsSync(coreDist))
  run(process.execPath, [
    join(repo, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-b',
    'packages/core',
  ]);
const { scanFiles, readDenyFile } = await import(pathToFileURL(coreDist).href);

const args = process.argv.slice(2);
const deny = [];
const paths = [];
let staged = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--staged') staged = true;
  else if (args[i] === '--deny') deny.push(...readDenyFile(args[++i]));
  else paths.push(args[i]);
}
const files = paths.length
  ? paths
  : run(
      'git',
      staged
        ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
        : ['ls-files', '-co', '--exclude-standard', '-z'],
    )
      .split('\0')
      .filter(Boolean);
const hits = scanFiles(
  files.map((f) => resolve(repo, f)),
  { deny },
);
for (const h of hits)
  console.log(`LEAK: ${h.kind} in ${h.file.slice(repo.length + 1)}${h.line ? `:${h.line}` : ''}`);
if (hits.length) {
  console.log(`check-leaks: ${hits.length} problem(s)`);
  process.exit(1);
}
console.log(`check-leaks: clean (${files.length} files)`);
