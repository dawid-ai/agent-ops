// Folds the fragments in changelog.d/ into CHANGELOG.md under a version heading and deletes
// them. Sections follow Keep a Changelog: Added, Changed, Fixed, Removed. When the version
// already has a heading (fragments landed after an earlier fold, before the tag), the new
// entries join its sections and the heading keeps its date.
//
// Usage: node scripts/fold-changelog.mjs 0.2.0-beta.1 [YYYY-MM-DD] [--root DIR]

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const top =
  rootAt >= 0
    ? resolve(args.splice(rootAt, 2)[1] ?? '.')
    : join(dirname(fileURLToPath(import.meta.url)), '..');
const [version, date = new Date().toISOString().slice(0, 10)] = args;
if (!version) {
  console.error('usage: node scripts/fold-changelog.mjs <version> [date] [--root DIR]');
  process.exit(2);
}

const dir = join(top, 'changelog.d');
const types = ['added', 'changed', 'fixed', 'removed'];
const title = (t) => t[0].toUpperCase() + t.slice(1);
const fresh = Object.fromEntries(types.map((t) => [t, []]));
const files = readdirSync(dir).filter((f) => f !== 'README.md' && f.endsWith('.md'));
for (const f of files.sort()) {
  const type = f.split('.').at(-2);
  if (!types.includes(type)) throw new Error(`${f}: type must be one of ${types.join(', ')}`);
  // A fragment written as a paragraph becomes one bullet.
  const body = readFileSync(join(dir, f), 'utf8').trim();
  fresh[type].push(body.startsWith('- ') ? body : `- ${body}`);
}
if (files.length === 0) {
  console.error('no fragments to fold');
  process.exit(3);
}

const file = join(top, 'CHANGELOG.md');
const text = readFileSync(file, 'utf8');
const lines = text.split('\n');
const start = lines.findIndex((l) => l.startsWith(`## ${version} (`));

/** Renders a version block from its heading, any text before the sections, and the sections. */
function render(heading, preamble, sections, extra) {
  const out = [heading, ''];
  if (preamble.length > 0) out.push(...preamble, '');
  for (const t of types) {
    if (sections[t].length > 0) out.push(`### ${title(t)}`, '', ...sections[t], '');
  }
  for (const [name, body] of extra) out.push(name, '', ...body, '');
  return out;
}

/** Drops blank lines at both ends. */
const trim = (ls) => {
  const a = [...ls];
  while (a.length > 0 && a[0].trim() === '') a.shift();
  while (a.length > 0 && a.at(-1).trim() === '') a.pop();
  return a;
};

let next;
if (start < 0) {
  const block = render(`## ${version} (${date})`, [], fresh, []);
  const at = lines.findIndex((l) => l.startsWith('## '));
  next =
    at < 0 ? [...trim(lines), '', ...block] : [...lines.slice(0, at), ...block, ...lines.slice(at)];
} else {
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = lines.length;
  const sections = Object.fromEntries(types.map((t) => [t, []]));
  const extra = [];
  let preamble = [];
  let current = null;
  for (const l of lines.slice(start + 1, end)) {
    const m = /^### (.+)$/.exec(l);
    if (m) {
      const t = m[1].trim().toLowerCase();
      current = types.includes(t) ? sections[t] : (extra.push([l, []]), extra.at(-1)[1]);
      continue;
    }
    (current ?? preamble).push(l);
  }
  for (const t of types) sections[t] = [...trim(sections[t]), ...fresh[t]];
  for (const e of extra) e[1] = trim(e[1]);
  preamble = trim(preamble);
  const block = render(lines[start], preamble, sections, extra);
  next = [...lines.slice(0, start), ...block, ...lines.slice(end)];
}

writeFileSync(file, `${next.join('\n').trimEnd()}\n`);
for (const f of files) rmSync(join(dir, f));
console.log(`folded ${files.length} fragments into ${version}`);
