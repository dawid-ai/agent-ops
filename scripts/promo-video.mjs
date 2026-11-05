// Renders the Agent Ops promo video: docs/media/promo.mp4, promo.gif and promo-poster.png.
//
// 1. Capture: a scratch workspace (two project repos, a user config, a scratch opsd whose claude
//    and codex runtimes are scripts/promo/fake-agent.mjs) plays a short story with real `ops`
//    commands and real opsd runs, while the desktop app, offscreen at twice the pixels, captures
//    the board after each step, plus the chat, inbox, runs, activity and a task panel. Each capture
//    is a PNG and a JSON file with the rectangles of columns, cards and controls.
// 2. Render: scripts/promo/index.html composes those captures into a timeline (`render(t)`), and
//    scripts/promo/render-main.mjs steps it frame by frame offscreen and pipes the frames to ffmpeg.
//
// Nothing touches the user's config, opsd or app data: OPS_CONFIG, OPS_STATE_DIR, OPS_CWD and the
// app's --user-data-dir all point into the scratch folder.
//
//   node scripts/promo-video.mjs                    # capture and render
//   node scripts/promo-video.mjs --keep             # keep the scratch folder (prints its path)
//   node scripts/promo-video.mjs --assets DIR       # render again from an earlier capture
//   node scripts/promo-video.mjs --assets DIR --stills 4.2,9.5   # PNG stills only, for review
//   --gif-from 7.4 --gif-to 14.9 --gif-fps 20                     # the GIF's cut (README size)
//   --poster 8.85                                                 # the poster frame, in seconds
//
// Needs `npm run build` and `npm run build:desktop`, and ffmpeg on PATH.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(top, 'packages', 'cli', 'dist', 'main.js');
const promo = join(top, 'scripts', 'promo');
const out = join(top, 'docs', 'media');
const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const keep = argv.includes('--keep');
const electron = createRequire(import.meta.url)('electron');
const fwd = (p) => p.replace(/\\/g, '/');

const ME = 'human:you';
const CE = 'claude:engineer';
const XE = 'codex:engineer';
const CD = 'claude:docs';
const QA = 'codex:qa';
const RV = 'claude:reviewer';
const PM = 'claude:pm';

/** The scratch workspace: repos, config, state, plan and signal files for the stand-in runs. */
function workspace(base) {
  const shop = join(base, 'storefront');
  const docs = join(base, 'docs-site');
  const state = join(base, 'state');
  const work = join(base, 'work');
  const signals = join(base, 'signals');
  const ctrl = join(base, 'assets');
  for (const d of [shop, docs, state, signals, ctrl, join(base, 'appshots')]) {
    mkdirSync(d, { recursive: true });
  }
  for (const a of ['claude-engineer', 'codex-engineer', 'claude-docs']) {
    mkdirSync(join(work, a), { recursive: true });
  }
  for (const d of [shop, docs]) {
    execFileSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore', windowsHide: true });
  }
  const plan = join(base, 'plan.json');
  writeFileSync(plan, '{}');
  const agentJs = join(promo, 'fake-agent.mjs');
  const runtime = `{ command: '${fwd(process.execPath)}', args: ['${fwd(agentJs)}', '${fwd(cli)}', '${fwd(plan)}', '${fwd(signals)}'] }`;
  const config = join(base, 'config.yml');
  writeFileSync(
    config,
    [
      `me: ${ME}`,
      'roots:',
      `  - '${fwd(docs)}'`,
      'opsd:',
      '  port: 0',
      '  sync: false',
      '  max_runs: 8',
      '  min_free_gb: 0',
      '  review_backlog: 50',
      '  seeded: 1',
      '  runtimes:',
      `    claude: ${runtime}`,
      `    codex: ${runtime}`,
      '  roles:',
      '    engineer: { per_project: 4 }',
      '    docs: { per_project: 4 }',
      '  agents:',
      `    claude:engineer: { cwd: '${fwd(join(work, 'claude-engineer'))}' }`,
      `    codex:engineer: { cwd: '${fwd(join(work, 'codex-engineer'))}' }`,
      `    claude:docs: { cwd: '${fwd(join(work, 'claude-docs'))}' }`,
      '    codex:qa: {}',
      '    claude:reviewer: {}',
      '    claude:pm: {}',
      '  chat:',
      '    agent: claude:pm',
      '    mentions: false',
      '',
    ].join('\n'),
  );
  const env = { ...process.env, OPS_CONFIG: config, OPS_STATE_DIR: state, OPS_CWD: shop };
  for (const k of ['OPS_AGENT', 'OPS_RUN', 'OPS_ROOTS', 'OPS_RUN_TOKEN', 'OPS_RUN_STATE_DIR']) {
    delete env[k];
  }
  const ops = (actor, ...args) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd: shop,
      env: actor ? { ...env, OPS_AGENT: actor } : env,
      encoding: 'utf8',
      windowsHide: true,
    });
  const plans = {};
  const setPlan = (task, steps) => {
    plans[task] = steps;
    writeFileSync(plan, JSON.stringify(plans, null, 2));
  };
  const signal = (name) => writeFileSync(join(signals, name), '');
  return { base, shop, docs, state, ctrl, env, ops, setPlan, signal };
}

const id = (s) => s.match(/[A-Z]+-\d{4}/)[0];

/** The opening state: a web shop and its docs site with work in every column. */
function seed(w) {
  const { ops } = w;
  ops(ME, 'init', '--name', 'storefront', '--prefix', 'SHOP', '--human', ME);
  execFileSync(
    process.execPath,
    [cli, 'init', w.docs, '--name', 'docs-site', '--prefix', 'DOCS', '--human', ME],
    { cwd: w.docs, env: { ...w.env, OPS_AGENT: ME }, stdio: 'ignore', windowsHide: true },
  );
  const task = (title, ...o) => id(ops(ME, 'new', title, ...o));
  const dtask = (title, ...o) => id(ops(ME, 'new', title, ...o, '--root', 'docs-site'));
  const T = {};
  T.checkout = task(
    'Checkout total ignores discount codes on mobile Safari',
    '--type',
    'bug',
    '--priority',
    'p0',
    '--label',
    'checkout',
    '--to',
    CE,
  );
  T.reviews = task(
    'Lazy-load the reviews widget below the fold',
    '--priority',
    'p3',
    '--label',
    'perf',
    '--to',
    CE,
  );
  T.pricing = task(
    'Redesign the pricing page with a monthly/annual toggle',
    '--priority',
    'p1',
    '--label',
    'pricing',
    '--to',
    XE,
  );
  T.sale = task(
    'Holiday sale launch',
    '--priority',
    'p1',
    '--label',
    'marketing',
    '--to',
    PM,
    '-m',
    'Site-wide 25 % off from Black Friday to Cyber Monday: banner, countdown, sale badges.',
  );
  T.webhook = task(
    'Retry failed payment webhooks with backoff',
    '--priority',
    'p1',
    '--label',
    'payments',
    '--to',
    XE,
  );
  T.cart = task(
    'Cart badge count is stale after removing an item',
    '--type',
    'bug',
    '--priority',
    'p2',
    '--label',
    'cart',
    '--to',
    '*:engineer',
  );
  T.e2e = task(
    'End-to-end tests for guest checkout',
    '--priority',
    'p1',
    '--label',
    'tests',
    '--to',
    QA,
  );
  T.shipping = task(
    'Shipping estimate times out for international addresses',
    '--type',
    'bug',
    '--priority',
    'p1',
    '--label',
    'checkout',
    '--to',
    CE,
  );
  T.dstart = dtask('Getting started guide', '--priority', 'p1', '--label', 'docs', '--to', CD);
  T.dlinks = dtask(
    'Fix broken links in the API reference',
    '--type',
    'bug',
    '--priority',
    'p2',
    '--label',
    'docs',
    '--to',
    XE,
  );
  T.dsearch = dtask(
    'Add search to the docs site',
    '--priority',
    'p2',
    '--label',
    'docs',
    '--to',
    CD,
  );

  const d = (actor, ...args) => ops(actor, ...args, '--root', 'docs-site');
  ops(CE, 'start', T.checkout, 'Reproduce in WebKit first');
  ops(CE, 'review', T.checkout, 'Totals recompute on input now; added a WebKit test.', '--to', QA);
  ops(QA, 'verdict', T.checkout, 'approve', 'Verified on iOS 18 Safari.');
  ops(CE, 'start', T.reviews, 'IntersectionObserver around the widget');
  ops(CE, 'review', T.reviews, 'Loads 200 px before it scrolls into view.', '--to', XE);
  ops(XE, 'verdict', T.reviews, 'approve', 'No layout shift.');
  d(CD, 'start', T.dstart, 'Install, first order, webhooks');
  d(CD, 'review', T.dstart, 'The guide is live on the preview site.', '--to', XE);
  d(XE, 'verdict', T.dstart, 'approve', 'Clear and short.');
  ops(XE, 'start', T.pricing, 'Toggle first, then plan cards');
  ops(
    XE,
    'review',
    T.pricing,
    'Toggle, three plan cards, annual badge, mobile layout.',
    '--to',
    RV,
  );
  d(XE, 'start', T.dlinks, 'Link checker in CI first');
  ops(CE, 'start', T.shipping, 'Profile the carrier API call');
  ops(
    CE,
    'block',
    T.shipping,
    `The carrier fallback needs the retry queue from ${T.webhook}.`,
    '--on',
    T.webhook,
  );
  return T;
}

function writeChat(w, messages) {
  writeFileSync(join(w.state, 'chat.json'), JSON.stringify({ markers: {}, messages }));
}

/** Sends one capture request to scripts/promo/capture-main.mjs and waits for its answer. */
function capturer(w) {
  let n = 0;
  const shots = [];
  const cap = async (name, r = {}) => {
    const k = n++;
    writeFileSync(join(w.ctrl, `req-${k}.json`), JSON.stringify({ name, ...r }));
    const res = join(w.ctrl, `res-${k}.json`);
    for (let i = 0; !existsSync(res); i++) {
      if (i > 1200) throw new Error(`capture ${name} got no answer`);
      await sleep(50);
    }
    const { warn } = JSON.parse(readFileSync(res, 'utf8'));
    if (warn) console.error(`  ${name}: ${warn}`);
    if (name) {
      shots.push(name);
      console.log(`  captured ${name}`);
    }
  };
  return { cap, shots };
}

/** Plays the story and captures every state the composition needs. */
async function capture(w) {
  const { ops, setPlan, signal } = w;
  console.log('capture: seeding');
  const T = seed(w);
  writeChat(w, []);
  execFileSync(process.execPath, [cli, 'daemon', 'start'], {
    cwd: w.shop,
    env: w.env,
    stdio: 'ignore',
    windowsHide: true,
    timeout: 120_000,
  });
  // QA's e2e suite runs through the whole story.
  setPlan(T.e2e, [
    ['start', T.e2e, 'Playwright: guest checkout with card, PayPal and a declined card'],
    ['@', 'end'],
  ]);
  ops(ME, 'launch', QA, '--task', T.e2e);

  console.log('capture: starting the app');
  const views = Array(700).fill('noop').join(',');
  const app = spawn(
    electron,
    [join(promo, 'capture-main.mjs'), `--user-data-dir=${join(w.base, 'userdata')}`],
    {
      env: {
        ...w.env,
        AGENT_OPS_SCREENSHOTS: join(w.base, 'appshots'),
        AGENT_OPS_VIEWS: views,
        PROMO_CTRL: w.ctrl,
        PROMO_APP_MAIN: pathToFileURL(join(top, 'packages', 'desktop', 'dist', 'main.js')).href,
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  console.log(`  app pid ${app.pid}`);
  const exited = new Promise((r) => app.on('exit', r));
  const { cap } = capturer(w);
  const meta = { T, states: {}, actions: {} };
  const board = async (name, expect, actions = []) => {
    await cap(name, { view: 'board', expect });
    meta.states[name] = { runs: JSON.parse(w.ops(ME, 'runs', '--all', '--json')) };
    meta.actions[name] = actions;
  };
  try {
    await cap('chat0', { view: 'chat', min: 1500 });
    await board('b0', [[T.sale, 'todo']]);
    await cap('chrome', { view: 'board', chrome: true });

    // The PM splits the sale into three tasks; the chat shows the turn.
    ops(PM, 'start', T.sale, 'Break the launch into tasks');
    T.prices = id(
      ops(
        PM,
        'new',
        'Schedule the 25 % price rule for Nov 27 to Dec 1',
        '--parent',
        T.sale,
        '--priority',
        'p1',
        '--label',
        'pricing',
        '--to',
        XE,
      ),
    );
    T.banner = id(
      ops(
        PM,
        'new',
        'Sale banner with countdown on every page',
        '--parent',
        T.sale,
        '--priority',
        'p1',
        '--label',
        'marketing',
        '--to',
        '*:engineer',
      ),
    );
    T.badges = id(
      ops(
        PM,
        'new',
        'Sale price badges on product cards',
        '--parent',
        T.sale,
        '--priority',
        'p2',
        '--label',
        'ui',
        '--to',
        '*:engineer',
      ),
    );
    const at = new Date(Date.now() - 20_000).toISOString();
    const created = (task, title) => ({
      kind: 'task',
      type: 'created',
      root: 'storefront',
      task,
      title,
      summary: '',
    });
    writeChat(w, [
      {
        id: '01PROMO0CHAT000000000000001',
        role: 'user',
        at,
        text: 'Break the holiday sale into tasks.',
        from: ME,
        status: 'sent',
      },
      {
        id: '01PROMO0CHAT000000000000002',
        role: 'assistant',
        at: new Date().toISOString(),
        text: [
          `I split ${T.sale} into three tasks:`,
          '',
          `- ${T.prices}: p1, assigned to \`codex:engineer\``,
          `- ${T.banner}: p1, open to any engineer`,
          `- ${T.badges}: p2, open to any engineer`,
          '',
          'The price rule merges first, so the badges read real sale prices.',
        ].join('\n'),
        actions: [
          created(T.prices, 'Schedule the 25 % price rule for Nov 27 to Dec 1'),
          created(T.banner, 'Sale banner with countdown on every page'),
          created(T.badges, 'Sale price badges on product cards'),
        ],
      },
    ]);
    await cap('chat1', { view: 'chat', min: 1500 });
    // The same view with the messages hidden: the composition brings them in itself.
    await cap('chatbg', {
      view: 'chat',
      min: 600,
      js: "document.querySelectorAll('div.space-y-4.overflow-auto > *').forEach((e) => (e.style.visibility = 'hidden'))",
    });
    await board('b1', [
      [T.sale, 'working'],
      [T.prices, 'todo'],
      [T.banner, 'todo'],
      [T.badges, 'todo'],
    ]);

    // Agents wake: three runs start at once, on two projects.
    setPlan(T.banner, [
      ['start', T.banner, 'Countdown component, then the banner slot'],
      ['@', 'banner-review'],
      ['review', T.banner, 'Banner with a live countdown on every page.', '--to', QA],
    ]);
    setPlan(T.prices, [
      ['start', T.prices, 'Price rule with start and end dates'],
      ['@', 'prices-review'],
      ['review', T.prices, 'Rule runs Nov 27 00:00 to Dec 1 23:59.', '--to', RV],
    ]);
    setPlan(T.dsearch, [
      ['start', T.dsearch, 'Static index at build time', '--root', 'docs-site'],
      ['@', 'dsearch-review'],
      ['review', T.dsearch, 'Search box with a prebuilt index.', '--to', QA, '--root', 'docs-site'],
    ]);
    const runOf = (s) => s.trim().split(' ')[0];
    const ceRun = runOf(ops(ME, 'launch', CE, '--task', T.banner));
    ops(ME, 'launch', XE, '--task', T.prices);
    ops(ME, 'launch', CD, '--task', T.dsearch);
    await board(
      'b2',
      [
        [T.banner, 'working'],
        [T.prices, 'working'],
        [T.dsearch, 'working'],
      ],
      [
        [T.banner, CE],
        [T.prices, XE],
        [T.dsearch, CD],
      ],
    );

    ops(RV, 'verdict', T.pricing, 'approve', 'Toggle, cards and table match.');
    ops(
      XE,
      'review',
      T.dlinks,
      'Link checker in CI; 14 links fixed.',
      '--to',
      RV,
      '--root',
      'docs-site',
    );
    await board(
      'b3',
      [
        [T.pricing, 'done'],
        [T.dlinks, 'review'],
      ],
      [
        [T.pricing, RV],
        [T.dlinks, XE],
      ],
    );
    await cap('runs', { view: 'runs', id: ceRun, min: 1500 });

    signal('prices-review');
    signal('dsearch-review');
    await board(
      'b4',
      [
        [T.prices, 'review'],
        [T.dsearch, 'review'],
      ],
      [
        [T.prices, XE],
        [T.dsearch, CD],
      ],
    );

    ops(RV, 'verdict', T.dlinks, 'approve', 'All links resolve.', '--root', 'docs-site');
    ops(QA, 'verdict', T.dsearch, 'approve', 'Finds every page title.', '--root', 'docs-site');
    setPlan(T.webhook, [
      ['start', T.webhook, 'Queue failed events, exponential backoff'],
      ['@', 'webhook-ask'],
      [
        'ask',
        T.webhook,
        'How long should we retry a failed webhook before we alert: 24 h or 72 h?',
      ],
    ]);
    ops(ME, 'launch', XE, '--task', T.webhook);
    await board(
      'b5',
      [
        [T.dlinks, 'done'],
        [T.dsearch, 'done'],
        [T.webhook, 'working'],
      ],
      [
        [T.dlinks, RV],
        [T.dsearch, QA],
        [T.webhook, XE],
      ],
    );

    // Checks: a change request, a finding, a question for the human.
    ops(
      RV,
      'verdict',
      T.prices,
      'changes',
      'Use the store time zone for the start and end, not UTC.',
    );
    T.finding = id(
      ops(
        QA,
        'finding',
        'Countdown jumps an hour at the DST change',
        '--task',
        T.banner,
        '--priority',
        'p2',
        '-m',
        'Seen in the banner preview with the clock set to Oct 26.',
      ),
    );
    signal('webhook-ask');
    await board(
      'b6',
      [
        [T.prices, 'todo'],
        [T.finding, 'todo'],
        [T.webhook, 'blocked'],
      ],
      [
        [T.prices, RV],
        [T.finding, QA],
        [T.webhook, XE],
      ],
    );
    await cap('inbox', { view: 'inbox', min: 1500 });

    ops(ME, 'answer', T.webhook, '72 h, and alert after the third failure.');
    setPlan(T.prices, [
      ['start', T.prices, 'Switch the rule to the store time zone'],
      ['@', 'prices-review2'],
      ['review', T.prices, 'Start and end use the store time zone now.', '--to', RV],
    ]);
    ops(ME, 'launch', XE, '--task', T.prices);
    await board(
      'b7',
      [
        [T.webhook, 'todo'],
        [T.prices, 'working'],
      ],
      [
        [T.webhook, ME],
        [T.prices, XE],
      ],
    );

    signal('prices-review2');
    signal('banner-review');
    await board(
      'b8',
      [
        [T.prices, 'review'],
        [T.banner, 'review'],
      ],
      [
        [T.prices, XE],
        [T.banner, CE],
      ],
    );

    ops(RV, 'verdict', T.prices, 'approve', 'Time zone handled; tests cover both edges.');
    ops(QA, 'verdict', T.banner, 'approve', 'Countdown matches the server clock.');
    await board(
      'b9',
      [
        [T.prices, 'done'],
        [T.banner, 'done'],
      ],
      [
        [T.prices, RV],
        [T.banner, QA],
      ],
    );

    setPlan(T.webhook, [
      ['start', T.webhook, 'Backoff 1 m, 5 m, 30 m, then hourly up to 72 h'],
      ['@', 'end'],
    ]);
    setPlan(T.badges, [
      ['start', T.badges, 'Badge reads the active price rule'],
      ['@', 'end'],
    ]);
    ops(ME, 'launch', XE, '--task', T.webhook);
    ops(ME, 'launch', CE, '--task', T.badges);
    ops(QA, 'ask', T.e2e, 'Run the PayPal flow against the sandbox in CI, or mock it?');
    await board(
      'b10',
      [
        [T.webhook, 'working'],
        [T.badges, 'working'],
        [T.e2e, 'blocked'],
      ],
      [
        [T.webhook, XE],
        [T.badges, CE],
        [T.e2e, QA],
      ],
    );
    await cap('activity', { view: 'activity', min: 1500 });
    await cap('task', { view: 'task', id: `storefront/${T.prices}`, min: 1800 });
    // Reviews given in this session: verdict events on every task, both projects.
    meta.verdicts = 0;
    for (const t of JSON.parse(ops(ME, 'list', '--all', '--json'))) {
      const ev = JSON.parse(ops(ME, 'show', `${t.root}/${t.id}`, '--json')).events;
      meta.verdicts += ev.filter((e) => e.type === 'verdict').length;
    }
    await cap(null, { quit: true });
  } finally {
    await Promise.race([exited, sleep(15000)]);
    if (app.exitCode === null) app.kill();
    signal('end');
    spawnSync(process.execPath, [cli, 'daemon', 'stop', '--kill-runs'], {
      cwd: w.shop,
      env: w.env,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 60_000,
    });
  }
  writeFileSync(join(w.ctrl, 'meta.json'), JSON.stringify(meta, null, 1));
  return w.ctrl;
}

/** data.js for the composition: every capture's rectangles plus the story's metadata. */
function writeData(assets) {
  const meta = JSON.parse(readFileSync(join(assets, 'meta.json'), 'utf8'));
  const names = ['chat0', 'chat1', 'chrome', 'runs', 'inbox', 'activity', 'task'];
  for (let i = 0; existsSync(join(assets, `b${i}.json`)); i++) names.push(`b${i}`);
  if (!names.includes('chatbg')) names.push('chatbg');
  const shots = {};
  for (const n of names) shots[n] = JSON.parse(readFileSync(join(assets, `${n}.json`), 'utf8'));
  for (const st of Object.values(meta.states)) {
    st.runs = st.runs.map((r) => ({
      agent: r.agent,
      task: r.task,
      tokens: r.tokens ?? 0,
      ended_at: r.ended_at ?? null,
    }));
  }
  // Background colors of the two text boxes the composition types into (captures are 2x).
  const pixel = (shot, r) => {
    const buf = execFileSync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-i',
        join(assets, `${shot}.png`),
        '-vf',
        `crop=1:1:${Math.round((r[0] + r[2] * 0.5) * 2)}:${Math.round((r[1] + r[3] * 0.5) * 2)}`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { windowsHide: true },
    );
    return `rgb(${buf[0]},${buf[1]},${buf[2]})`;
  };
  const colors = {
    composer: pixel('chat0', shots.chat0.textarea),
    inbox: pixel('inbox', shots.inbox.textarea),
  };
  writeFileSync(
    join(assets, 'data.js'),
    `window.PROMO = ${JSON.stringify({ meta, shots, colors, version: JSON.parse(readFileSync(join(top, 'package.json'), 'utf8')).version })};\n`,
  );
}

/** Renders the composition offscreen: a video through ffmpeg, or PNG stills. */
function render(assets, { stills, mp4, gifSrc }) {
  const res = spawnSync(
    electron,
    [join(promo, 'render-main.mjs'), `--user-data-dir=${join(assets, '..', 'render-userdata')}`],
    {
      env: {
        ...process.env,
        PROMO_ASSETS: assets,
        PROMO_STILLS: stills ?? '',
        PROMO_MP4: mp4 ?? '',
        PROMO_GIF_SRC: gifSrc ?? '',
        PROMO_GIF_FPS: opt('--gif-fps', '20'),
        // The board segment: agents wake, runs move cards, a change request, a finding, a question.
        PROMO_GIF_FROM: opt('--gif-from', '7.4'),
        PROMO_GIF_TO: opt('--gif-to', '14.9'),
      },
      stdio: 'inherit',
      windowsHide: true,
      timeout: 1_800_000,
    },
  );
  if (res.status !== 0) throw new Error(`render failed (exit ${res.status})`);
}

const ff = (...args) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], {
    stdio: 'inherit',
    windowsHide: true,
  });

let base = null;
try {
  let assets = opt('--assets', null);
  if (!assets) {
    base = mkdtempSync(join(tmpdir(), 'ops-promo-'));
    assets = await capture(workspace(base));
  }
  if (argv.includes('--capture-only')) {
    console.log(`assets in ${assets}`);
    process.exit(0);
  }
  writeData(assets);
  const stills = opt('--stills', null);
  if (stills) {
    render(assets, { stills });
    console.log(`stills in ${join(assets, 'stills')}`);
  } else {
    mkdirSync(out, { recursive: true });
    const mp4 = join(out, 'promo.mp4');
    const gifSrc = join(assets, 'gif-src.mkv');
    render(assets, { mp4, gifSrc, stills: opt('--poster', '8.85') });
    copyFileSync(
      join(assets, 'stills', `${opt('--poster', '8.85')}.png`),
      join(out, 'promo-poster.png'),
    );
    const gif = join(out, 'promo.gif');
    const palette = join(assets, 'palette.png');
    ff('-i', gifSrc, '-vf', 'palettegen=max_colors=256:stats_mode=diff', palette);
    ff(
      '-i',
      gifSrc,
      '-i',
      palette,
      '-lavfi',
      'paletteuse=dither=none:diff_mode=rectangle',
      '-loop',
      '0',
      gif,
    );
    for (const f of [mp4, gif, join(out, 'promo-poster.png')]) {
      console.log(`  ${f}: ${(statSync(f).size / 1e6).toFixed(2)} MB`);
    }
  }
  if (base && keep) console.log(`scratch folder: ${base}`);
} finally {
  if (base && !keep) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}
