// Sets the release version everywhere it is written down: the root and workspace package.json
// files (and their @agent-ops/* dependencies), package-lock.json, the CLI's VERSION and opsd's
// OPSD_VERSION. Edits the lock file directly: `npm install` would re-resolve it and can drop
// optional platform packages.
//
// Usage: node scripts/set-version.mjs 0.2.0-beta.1

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <semver>, such as 0.2.0-beta.1');
  process.exit(2);
}

const packages = ['core', 'cli', 'supervisor', 'desktop'];
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

const setDeps = (deps) => {
  for (const name of Object.keys(deps ?? {})) {
    if (name.startsWith('@agent-ops/')) deps[name] = version;
  }
};

const root = json(join(top, 'package.json'));
root.version = version;
save(join(top, 'package.json'), root);

for (const p of packages) {
  const file = join(top, 'packages', p, 'package.json');
  const data = json(file);
  data.version = version;
  setDeps(data.dependencies);
  setDeps(data.devDependencies);
  save(file, data);
}

const lockFile = join(top, 'package-lock.json');
const lock = json(lockFile);
lock.version = version;
lock.packages[''].version = version;
for (const p of packages) {
  const entry = lock.packages[`packages/${p}`];
  if (!entry) continue;
  entry.version = version;
  setDeps(entry.dependencies);
  setDeps(entry.devDependencies);
}
save(lockFile, lock);

const replaceIn = (file, re) => {
  const path = join(top, file);
  const text = readFileSync(path, 'utf8');
  if (!re.test(text)) throw new Error(`${file}: version line not found`);
  writeFileSync(
    path,
    text.replace(re, (_m, head) => `${head}'${version}';`),
  );
};
replaceIn('packages/cli/src/version.ts', /(export const VERSION = )'[^']*';/);
replaceIn('packages/supervisor/src/daemon.ts', /(export const OPSD_VERSION = )'[^']*';/);

console.log(`version ${version}`);
