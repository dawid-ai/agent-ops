#!/usr/bin/env node
// Checks the links of a built docs site (scripts/build-docs.mjs). Every relative href or src must
// name a file in the site, and every #anchor an id on the target page; a broken one exits 1.
//
// With --external, it also requests each http(s) link once. A failing external link is a warning,
// not an error: third-party sites rate-limit CI runners, and links to this repo's releases or
// pages return 404 until the public repo has them.
//
// Usage: node scripts/check-docs-links.mjs [DIR] [--external]   (default DIR: dist/docs)
/* global fetch, AbortSignal */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

const args = process.argv.slice(2);
const external = args.includes('--external');
const dir = args.find((a) => !a.startsWith('--')) ?? join('dist', 'docs');
const ci = process.env.GITHUB_ACTIONS === 'true';

if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`docs links: no site at ${dir}; run node scripts/build-docs.mjs first`);
  process.exit(2);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITIES[e]);

function htmlFiles(d) {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    if (e.isDirectory()) return htmlFiles(p);
    return e.name.endsWith('.html') ? [relative(dir, p).split(sep).join('/')] : [];
  });
}

const files = htmlFiles(dir);
const html = new Map(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
const ids = new Map(
  files.map((f) => [
    f,
    new Set([...html.get(f).matchAll(/\sid="([^"]*)"/g)].map((m) => decode(m[1]))),
  ]),
);

const errors = [];
const urls = new Map(); // external url -> first page that links it
for (const [file, text] of html) {
  for (const m of text.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const link = decode(m[1]);
    if (/^https?:\/\//i.test(link)) {
      if (!urls.has(link)) urls.set(link, file);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('//')) continue;
    const i = link.indexOf('#');
    const path = i < 0 ? link : link.slice(0, i);
    const hash = i < 0 ? '' : link.slice(i + 1);
    let target = path ? posix.normalize(posix.join(posix.dirname(file), decodeURI(path))) : file;
    if (target.endsWith('/') || target === '.') target = posix.join(target, 'index.html');
    if (target.startsWith('..') || !existsSync(join(dir, target))) {
      errors.push(`${file}: broken link ${link} (no file ${target})`);
    } else if (hash && ids.has(target) && !ids.get(target).has(decodeURIComponent(hash))) {
      errors.push(`${file}: broken anchor ${link} (no id "${hash}" in ${target})`);
    }
  }
}

for (const e of errors) console.error(e);

let warnings = 0;
if (external) {
  const list = [...urls];
  const workers = Array.from({ length: 4 }, async () => {
    while (list.length) {
      const [url, file] = list.shift();
      const problem = await probe(url);
      if (problem) {
        warnings++;
        const msg = `${file}: ${url} ${problem}`;
        console.warn(ci ? `::warning title=External link::${msg}` : `warning: ${msg}`);
      }
    }
  });
  await Promise.all(workers);
}

/** Null when the url answers below 400; otherwise a short reason. HEAD first, then GET. */
async function probe(url) {
  let last = '';
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
        headers: { 'user-agent': 'agent-ops-docs-link-check' },
      });
      await res.body?.cancel();
      if (res.status < 400) return null;
      last = `answered ${res.status}`;
    } catch (err) {
      last = `failed: ${err.cause?.code ?? err.name}`;
    }
  }
  return last;
}

const ext = external ? `, ${urls.size} external link(s) with ${warnings} warning(s)` : '';
if (errors.length) {
  console.error(`docs links: ${errors.length} broken in ${files.length} page(s)${ext}`);
  process.exit(1);
}
console.log(`docs links: ${files.length} page(s) ok${ext}`);
