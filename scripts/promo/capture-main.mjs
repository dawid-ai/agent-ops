// Electron main for the promo's app captures. It resizes the desktop app's offscreen window to
// 3200x1920 at zoom 2 (the page lays out at 1600x960 CSS px, captured at twice the pixels), then
// imports the real main process. promo-video.mjs drives it through request files in PROMO_CTRL:
// each request navigates, waits until the board shows what it expects, and writes a PNG of the
// page and a JSON file with the rectangles of columns, cards, chips and controls.
import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ctrl = process.env.PROMO_CTRL;
const shots = process.env.AGENT_OPS_SCREENSHOTS;
const W = 3200;
const H = 1920;
const NOANIM =
  '.animate-rise, .animate-fade { animation: none !important; } ::-webkit-scrollbar { display: none; }';

// Rectangles in CSS px of what the composition moves or draws over.
const COLLECT = `(() => {
  const R = (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100); };
  const keys = ['todo', 'working', 'blocked', 'review', 'done'];
  const wrappers = [...document.querySelectorAll('div.rounded-2xl')].filter((d) => d.className.includes('min-w-60'));
  const cols = wrappers.map((wr, i) => {
    const list = wr.children[1];
    const badge = wr.querySelector('span.rounded-full');
    const cards = list ? [...list.children].filter((c) => c.getAttribute('draggable') === 'true') : [];
    return {
      key: keys[i], rect: R(wr), list: list ? R(list) : null, badge: badge ? R(badge) : null,
      count: badge ? Number(badge.textContent) : 0,
      cards: cards.map((c) => ({ id: (c.querySelector('.font-mono') || {}).textContent, rect: R(c) })),
    };
  });
  const leaf = [...document.querySelectorAll('div, p, span')].find((e) => e.children.length === 0 && /open · drag a card/.test(e.textContent));
  const chips = [...document.querySelectorAll('span.font-mono.text-signal')].map((s) => ({ id: s.textContent.trim(), rect: R(s.parentElement) }));
  const ta = document.querySelector('textarea');
  const list = document.querySelector('div.space-y-4.overflow-auto');
  let qcard = null;
  for (let e = ta; e && !qcard; e = e.parentElement) {
    if (e !== ta && getComputedStyle(e).borderTopWidth !== '0px' && e.getBoundingClientRect().height > 140) qcard = R(e);
  }
  const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => ({ text: b.textContent.trim().slice(0, 40), rect: R(b) }));
  return {
    cols, subtitle: leaf ? { text: leaf.textContent, rect: R(leaf) } : null, chips,
    textarea: ta ? R(ta) : null, msgs: list ? [...list.children].map(R) : [], qcard, buttons,
  };
})()`;

// Hides the cards, column counts, empty-column notes and the board subtitle: the composition
// draws those itself over this "chrome" capture.
const HIDE = `(() => {
  const hide = (e) => { e.dataset.promoHidden = '1'; e.style.visibility = 'hidden'; };
  document.querySelectorAll('[draggable="true"]').forEach(hide);
  [...document.querySelectorAll('div.rounded-2xl')].filter((d) => d.className.includes('min-w-60')).forEach((wr) => {
    const b = wr.querySelector('span.rounded-full'); if (b) hide(b);
    [...wr.querySelectorAll('div')].filter((d) => /^(Nothing here|Drop here)$/.test(d.textContent.trim()) && d.children.length === 0).forEach(hide);
  });
  [...document.querySelectorAll('div, p, span')].filter((e) => e.children.length === 0 && /open · drag a card/.test(e.textContent)).forEach(hide);
})()`;
const UNHIDE = `document.querySelectorAll('[data-promo-hidden]').forEach((e) => { e.style.visibility = ''; delete e.dataset.promoHidden; })`;

let win = null;
let last = null;
let paints = 0;

app.on('browser-window-created', (_e, w) => {
  if (win) return;
  win = w;
  w.setSize(W, H);
  w.webContents.on('paint', (_ev, _dirty, image) => {
    last = image;
    paints++;
  });
  w.webContents.on('dom-ready', () => {
    w.webContents.setZoomFactor(2);
    void w.webContents.insertCSS(NOANIM);
  });
  void serve();
});

const exec = (js) => win.webContents.executeJavaScript(js, true);

async function freshPaint() {
  await sleep(250);
  const n = paints;
  win.webContents.invalidate();
  for (let i = 0; i < 100 && paints === n; i++) await sleep(20);
}

/** True when every `[id, column]` in `expect` holds on the board. */
function meets(info, expect) {
  return (expect ?? []).every(([id, col]) => {
    const c = info.cols.find((x) => x.key === col);
    return Boolean(c && c.cards.some((k) => k.id === id));
  });
}

async function serve() {
  // Wait until the app's own screenshot loop has started: opsd is up and the page has data.
  while (!existsSync(join(shots, 'noop.png'))) await sleep(200);
  for (let n = 0; ; n++) {
    const req = join(ctrl, `req-${n}.json`);
    while (!existsSync(req)) await sleep(60);
    const r = JSON.parse(readFileSync(req, 'utf8'));
    if (r.quit) {
      writeFileSync(join(ctrl, `res-${n}.json`), '{}');
      app.exit(0);
      return;
    }
    let warn = null;
    try {
      if (r.view) win.webContents.send('ops:navigate', { view: r.view, id: r.id });
      const start = Date.now();
      let info = null;
      let prev = '';
      // Settled: what it expects is there and two reads in a row agree.
      for (;;) {
        await sleep(250);
        info = await exec(COLLECT);
        const s = JSON.stringify(info);
        const ok = meets(info, r.expect) && s === prev && Date.now() - start >= (r.min ?? 900);
        prev = s;
        if (ok) break;
        if (Date.now() - start > (r.timeout ?? 15000)) {
          warn = `timed out waiting for ${JSON.stringify(r.expect ?? [])}`;
          break;
        }
      }
      if (r.js) await exec(r.js);
      if (r.chrome) await exec(HIDE);
      await freshPaint();
      writeFileSync(join(ctrl, `${r.name}.png`), last.toPNG());
      writeFileSync(join(ctrl, `${r.name}.json`), JSON.stringify(info, null, 1));
      if (r.chrome) await exec(UNHIDE);
    } catch (e) {
      warn = String(e && e.message);
    }
    writeFileSync(join(ctrl, `res-${n}.json`), JSON.stringify({ warn }));
  }
}

await import(process.env.PROMO_APP_MAIN);
