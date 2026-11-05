#!/usr/bin/env node
// Builds the static docs site: README.md becomes index.html and every docs/**/*.md becomes a page
// at the same path under the output folder. Links between the pages point at the built pages;
// links to other repo files point at the file on GitHub. A relative link to a file that does not
// exist, or an anchor that no heading on the target page has, fails the build.
//
// Usage: node scripts/build-docs.mjs [--root DIR] [--out DIR]   (default out: <root>/dist/docs)
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { Marked } from 'marked';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = opt('--root', process.cwd());
const out = opt('--out', join(root, 'dist', 'docs'));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const repoUrl = githubUrl(pkg.repository);
const branch = 'main';
// Top-level pages in this order; other pages follow by name.
const ORDER = ['protocol', 'supervisor', 'desktop'];

/** `github:owner/name`, `owner/name` or a GitHub URL -> https://github.com/owner/name. */
function githubUrl(repository) {
  const raw = typeof repository === 'string' ? repository : (repository?.url ?? '');
  const m = /(?:github:|github\.com[/:])?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(raw);
  return m ? `https://github.com/${m[1]}` : '';
}

/** Repo-relative paths (posix) of every Markdown file under docs/. */
function docFiles(dir = 'docs') {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = posix.join(dir, e.name);
    if (e.isDirectory()) return docFiles(rel);
    return e.name.endsWith('.md') ? [rel] : [];
  });
}

/** Source path -> output path: README.md -> index.html, docs/a/b.md -> a/b.html. */
function outPath(src) {
  if (src === 'README.md') return 'index.html';
  return src.replace(/^docs\//, '').replace(/\.md$/, '.html');
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const plain = (html) =>
  html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITIES[e]);
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sources = ['README.md', ...docFiles()].filter((f) => existsSync(join(root, f)));
const pages = new Map(sources.map((src) => [src, { src, out: outPath(src) }]));
const errors = [];
const anchorChecks = []; // { from, target, hash }
const assets = new Set(); // repo paths of images the pages show, copied next to the pages
const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i;

for (const page of pages.values()) {
  const md = readFileSync(join(root, page.src), 'utf8');
  const ids = new Map(); // slug -> times seen, for GitHub's -1, -2 suffixes
  page.ids = new Set();
  const marked = new Marked({
    gfm: true,
    walkTokens: (token) => {
      if (token.type === 'link' || token.type === 'image') token.href = rewrite(page, token.href);
      // Raw HTML in Markdown, such as a centered <img>: its src and href get the same treatment.
      if (token.type === 'html') {
        token.text = token.text.replace(
          /\b(src|href)="([^"]*)"/g,
          (_m, attr, url) => `${attr}="${rewrite(page, url)}"`,
        );
      }
    },
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const base = slug(plain(inner));
        const n = ids.get(base) ?? 0;
        ids.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        page.ids.add(id);
        if (depth === 1 && !page.title) page.title = plain(inner);
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
      },
    },
  });
  page.html = marked.parse(md);
  page.title ??= page.src;
}

/** Points a link at the built page, at the file on GitHub, or leaves it; records broken ones. */
function rewrite(page, href) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
  const [path, hash] = splitHash(href);
  if (!path) {
    anchorChecks.push({ from: page.src, target: page.src, hash });
    return href;
  }
  const target = posix.normalize(posix.join(posix.dirname(page.src), decodeURI(path)));
  const suffix = hash ? `#${hash}` : '';
  if (pages.has(target)) {
    if (hash) anchorChecks.push({ from: page.src, target, hash });
    const rel = posix.relative(posix.dirname(page.out), pages.get(target).out);
    return rel + suffix;
  }
  const abs = join(root, target);
  if (target.startsWith('..') || !existsSync(abs)) {
    errors.push(`${page.src}: broken link ${href} (no file ${target})`);
    return href;
  }
  // Images are served from the site itself, so they show on the page instead of linking to GitHub.
  if (IMAGE.test(target) && statSync(abs).isFile()) {
    assets.add(target);
    return posix.relative(posix.dirname(page.out), `assets/${target}`) + suffix;
  }
  const kind = statSync(abs).isDirectory() ? 'tree' : 'blob';
  return `${repoUrl}/${kind}/${branch}/${encodeURI(target)}${suffix}`;
}

function splitHash(href) {
  const i = href.indexOf('#');
  return i < 0 ? [href, ''] : [href.slice(0, i), href.slice(i + 1)];
}

for (const { from, target, hash } of anchorChecks) {
  if (!pages.get(target).ids.has(decodeURIComponent(hash))) {
    errors.push(`${from}: broken anchor #${hash} (no such heading in ${target})`);
  }
}
if (errors.length) {
  for (const e of errors) console.error(e);
  console.error(`docs: ${errors.length} broken link(s); nothing written`);
  process.exit(1);
}

// Navigation: the overview, the top-level pages, then one group per subfolder.
const rank = (p) => {
  const name = posix.basename(p.out, '.html');
  const i = ORDER.indexOf(name);
  return [i < 0 ? ORDER.length : i, name];
};
const byRank = (a, b) => {
  const [ra, na] = rank(a);
  const [rb, nb] = rank(b);
  return ra - rb || na.localeCompare(nb);
};
const all = [...pages.values()];
const groups = [
  { title: '', items: all.filter((p) => p.out === 'index.html') },
  { title: 'Guides', items: all.filter((p) => p.out !== 'index.html' && !p.out.includes('/')) },
];
const folders = [
  ...new Set(all.filter((p) => p.out.includes('/')).map((p) => posix.dirname(p.out))),
];
for (const folder of folders.sort()) {
  const title = folder.charAt(0).toUpperCase() + folder.slice(1);
  groups.push({ title, items: all.filter((p) => posix.dirname(p.out) === folder) });
}
for (const g of groups) g.items.sort(byRank);

function nav(current) {
  return groups
    .filter((g) => g.items.length)
    .map((g) => {
      const head = g.title ? `<p class="group">${escapeHtml(g.title)}</p>` : '';
      const links = g.items
        .map((p) => {
          const href = posix.relative(posix.dirname(current.out), p.out);
          const cls = p === current ? ' class="current" aria-current="page"' : '';
          const label = p.out === 'index.html' ? 'Overview' : p.title;
          return `<li><a href="${href}"${cls}>${escapeHtml(label)}</a></li>`;
        })
        .join('');
      return `${head}<ul>${links}</ul>`;
    })
    .join('\n');
}

function layout(page) {
  const up = posix.relative(posix.dirname(page.out), '.') || '.';
  const site = pages.get('README.md')?.title ?? pkg.name ?? 'Docs';
  const title = page.out === 'index.html' ? site : `${page.title} · ${site}`;
  const source = repoUrl
    ? `<a href="${repoUrl}/blob/${branch}/${page.src}">View source on GitHub</a>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${up}/style.css">
</head>
<body>
<nav class="side">
<a class="site" href="${up}/index.html">${escapeHtml(site)}</a>
${nav(page)}
</nav>
<main>
${page.html}
<footer>${source}</footer>
</main>
</body>
</html>
`;
}

const CSS = `:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #fff; --side: #f6f8fa;
  --line: #d1d9e0; --link: #0969da; --code: #eff2f5; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117;
  --side: #151b23; --line: #3d444d; --link: #4493f8; --code: #262c36; } }
* { box-sizing: border-box; }
body { margin: 0; display: flex; min-height: 100vh; color: var(--fg); background: var(--bg);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
nav.side { flex: 0 0 260px; padding: 24px 16px; background: var(--side); border-right: 1px solid var(--line);
  position: sticky; top: 0; height: 100vh; overflow-y: auto; font-size: 14px; }
nav.side .site { display: block; font-weight: 600; font-size: 18px; color: var(--fg); margin-bottom: 16px; }
nav.side .group { margin: 16px 0 4px; color: var(--muted); font-weight: 600; text-transform: uppercase;
  font-size: 12px; letter-spacing: .04em; }
nav.side ul { list-style: none; margin: 0; padding: 0; }
nav.side li a { display: block; padding: 3px 8px; border-radius: 6px; color: var(--fg); }
nav.side li a.current { background: var(--line); font-weight: 600; }
main { flex: 1; min-width: 0; max-width: 900px; padding: 32px 48px 64px; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 .6em; position: relative; }
h1 { margin-top: 0; padding-bottom: .3em; border-bottom: 1px solid var(--line); }
h2 { padding-bottom: .3em; border-bottom: 1px solid var(--line); }
.anchor { position: absolute; left: -1em; padding-right: .2em; color: var(--muted); visibility: hidden; }
h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { visibility: visible; }
code { font: 85% ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; background: var(--code);
  padding: .2em .4em; border-radius: 6px; }
pre { background: var(--code); padding: 16px; border-radius: 6px; overflow-x: auto; line-height: 1.45; }
pre code { padding: 0; background: none; font-size: 85%; }
table { border-collapse: collapse; display: block; overflow-x: auto; margin: 1em 0; }
th, td { border: 1px solid var(--line); padding: 6px 13px; text-align: left; vertical-align: top; }
blockquote { margin: 0; padding: 0 1em; color: var(--muted); border-left: .25em solid var(--line); }
img { max-width: 100%; }
footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 14px; }
@media (max-width: 800px) { body { display: block; } nav.side { position: static; height: auto;
  border-right: 0; border-bottom: 1px solid var(--line); } main { padding: 24px 20px 48px; } }
`;

// The output folder is rebuilt from scratch, so it must not be the repo or one of its sources.
const inside = (dir, file) => {
  const r = relative(resolve(dir), resolve(file));
  return !r.startsWith('..') && !isAbsolute(r);
};
if (sources.some((src) => inside(out, join(root, src)))) {
  console.error(`docs: refusing to write into ${out}: it holds a source file`);
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });
for (const page of pages.values()) {
  const file = join(out, page.out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, layout(page));
}
writeFileSync(join(out, 'style.css'), CSS);
for (const target of assets) {
  const file = join(out, 'assets', target);
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(join(root, target), file);
}
console.log(`docs: ${pages.size} page(s) written to ${out}`);
