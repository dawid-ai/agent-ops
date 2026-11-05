// Stages the desktop app for electron-builder: one bundled file each for the Electron main
// process, opsd and the `ops` CLI, plus the preload script, the UI and the command shims.
// The staged folder has no node_modules: everything the app runs is in the bundles.
//
// Usage: node packages/desktop/scripts/package.mjs   (after `npm run build:desktop`)

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const top = join(desktop, '..', '..');
const stage = join(desktop, 'release', 'app');
const version = JSON.parse(readFileSync(join(top, 'package.json'), 'utf8')).version;

rmSync(join(desktop, 'release'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// ESM bundles still need `require` for the CommonJS packages they include (yaml, the updater),
// and every bundle names opsd.mjs, which sits beside it, as the program `startDaemon` runs.
const banner = [
  "import { createRequire as __agentOpsRequire } from 'node:module';",
  "import { fileURLToPath as __agentOpsPath } from 'node:url';",
  'const require = __agentOpsRequire(import.meta.url);',
  "process.env.OPS_DAEMON_ENTRY ??= __agentOpsPath(new URL('./opsd.mjs', import.meta.url));",
].join('\n');

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: banner },
  logLevel: 'warning',
};

await build({
  ...common,
  entryPoints: [join(desktop, 'dist', 'main.js')],
  outfile: join(stage, 'main.mjs'),
  external: ['electron'],
});
await build({
  ...common,
  entryPoints: [join(top, 'packages', 'supervisor', 'dist', 'main.js')],
  outfile: join(stage, 'opsd.mjs'),
});
await build({
  ...common,
  entryPoints: [join(top, 'packages', 'cli', 'dist', 'main.js')],
  outfile: join(stage, 'ops.mjs'),
});

cpSync(join(desktop, 'dist', 'preload.cjs'), join(stage, 'preload.cjs'));
cpSync(join(desktop, 'dist', 'ui'), join(stage, 'ui'), { recursive: true });

writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'agent-ops',
      productName: 'Agent Ops',
      version,
      description:
        'A team of AI agents and one human working one queue, with tasks as files in git',
      author: 'agent-ops contributors',
      license: 'MIT',
      type: 'module',
      main: 'main.mjs',
    },
    null,
    2,
  )}\n`,
);

// The bundles drop the licence comments of what they include, so the notices ship in one file:
// every production dependency of the packages, plus the libraries the UI bundles.
const UI_LIBS = [
  'react',
  'react-dom',
  'scheduler',
  'marked',
  'dompurify',
  'lucide-react',
  '@fontsource-variable/jetbrains-mono',
  '@fontsource/chakra-petch',
  '@fontsource/ibm-plex-sans',
];
const lock = JSON.parse(readFileSync(join(top, 'package-lock.json'), 'utf8'));
const found = new Map();
const walk = (name, from) => {
  for (const base of [from, '']) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    const entry = lock.packages[key];
    if (!entry) continue;
    if (found.has(key)) return;
    found.set(key, entry);
    for (const dep of Object.keys(entry.dependencies ?? {})) walk(dep, key);
    return;
  }
};
for (const ws of ['core', 'supervisor', 'cli', 'desktop']) {
  const entry = lock.packages[`packages/${ws}`] ?? {};
  for (const dep of Object.keys(entry.dependencies ?? {})) {
    if (!dep.startsWith('@agent-ops/')) walk(dep, '');
  }
}
for (const lib of UI_LIBS) walk(lib, '');
const notices = [
  'Agent Ops includes the following third-party software. Electron and Chromium licences are in',
  'LICENSE.electron.txt and LICENSES.chromium.html next to the application.',
  '',
];
for (const [key, entry] of [...found].sort((a, b) => a[0].localeCompare(b[0]))) {
  const name = key.split('node_modules/').pop();
  const dir = join(top, key);
  const file = existsSync(dir)
    ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
    : undefined;
  notices.push(`${'-'.repeat(78)}\n${name} ${entry.version} (${entry.license ?? 'see below'})\n`);
  notices.push(file ? readFileSync(join(dir, file), 'utf8').trim() : '(no licence file shipped)');
  notices.push('');
}
writeFileSync(join(stage, 'THIRD_PARTY_LICENSES.txt'), `${notices.join('\n')}\n`);

// The `ops` command, for the installer's PATH entry and for agent runs: `ops.cmd` for cmd and
// PowerShell, an extensionless script for Git Bash. Both run the app's own executable as Node.
// Kept in one folder: PowerShell and cmd pick `ops.cmd`, Git Bash picks `ops`.
const bin = join(desktop, 'release', 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(
  join(bin, 'ops.cmd'),
  [
    '@echo off',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    'set "OPS_BIN_DIR=%~dp0"',
    '"%~dp0..\\..\\Agent Ops.exe" "%~dp0..\\app\\ops.mjs" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n'),
);
writeFileSync(
  join(bin, 'ops'),
  [
    '#!/bin/sh',
    '# The installed Agent Ops `ops` command for Git Bash.',
    'here="$(cd "$(dirname "$0")" && pwd)"',
    'OPS_BIN_DIR="$here" ELECTRON_RUN_AS_NODE=1 exec "$here/../../Agent Ops.exe" "$here/../app/ops.mjs" "$@"',
    '',
  ].join('\n'),
);

console.log(`staged Agent Ops ${version} in ${stage}`);
