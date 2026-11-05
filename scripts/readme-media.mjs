// Renders the README showcase media: screenshots of the desktop app and a short animation of agents
// moving tasks across the board. Everything runs against scratch data roots in the temp folder,
// with a scratch opsd whose "claude" and "codex" runtimes are a scripted stand-in (fake-agent.mjs,
// written into the scratch folder), so no real agent starts and no user config or app data is
// touched.
//
//   node scripts/readme-media.mjs                 # screenshots and animation into docs/media/
//   node scripts/readme-media.mjs --only shots    # or --only anim
//   node scripts/readme-media.mjs --keep          # keep the scratch folders and raw frames
//   node scripts/readme-media.mjs --size 1600x960 # window size (default 1600x960)
//
// Needs `npm run build` and `npm run build:desktop`, and ffmpeg on PATH for the animation.
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
import { clearTimeout, setTimeout } from 'node:timers';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(top, 'packages', 'cli', 'dist', 'main.js');
const out = join(top, 'docs', 'media');
const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const only = opt('--only', null);
const keep = argv.includes('--keep');
// At the app's default 1360 px the board's fifth column is cut off, so the window is resized.
const size = opt('--size', '1600x960').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = 'human:you';
const CE = 'claude:engineer';
const XE = 'codex:engineer';
const QA = 'codex:qa';
const RV = 'claude:reviewer';
const PM = 'claude:pm';

/**
 * The stand-in runtime opsd starts for every run: it reads the prompt, finds the task id, runs the
 * `ops` steps planned for that task in plan.json with pauses between them, and prints Claude
 * `stream-json` or Codex `--json` lines with token usage, so runs show tokens like real ones.
 */
const FAKE_AGENT = `import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const CLI = process.argv[2];
const PLAN = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agent = process.env.OPS_AGENT ?? '';
const codex = agent.startsWith('codex:');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
await new Promise((r) => { process.stdin.on('end', r); setTimeout(r, 3000); });
const task = (prompt.match(/\\b(?:SHOP|DOCS)-\\d{4}\\b/) ?? [])[0];
const plan = (task && JSON.parse(readFileSync(PLAN, 'utf8'))[task]) || { steps: [], hold: 1000 };
const say = (o) => console.log(JSON.stringify(o));
const total = { input_tokens: 0, output_tokens: 0 };
const usage = () => {
  const u = { input_tokens: 9000 + Math.floor(Math.random() * 21000), output_tokens: 600 + Math.floor(Math.random() * 2400) };
  total.input_tokens += u.input_tokens;
  total.output_tokens += u.output_tokens;
  return u;
};
say(codex ? { type: 'turn.started' } : { type: 'system', subtype: 'init', model: 'demo' });
let n = 0;
for (const [wait, ...args] of plan.steps) {
  await sleep(wait);
  const text = 'ops ' + args.join(' ');
  if (codex) {
    say({ type: 'item.completed', item: { type: 'command_execution', command: text } });
    say({ type: 'turn.completed', usage: { ...usage(), cached_input_tokens: 0 } });
  }
  else say({ type: 'assistant', message: { id: 'msg_' + ++n, usage: usage(), content: [{ type: 'text', text }] } });
  const r = spawnSync(process.execPath, [CLI, ...args], { env: process.env, encoding: 'utf8', windowsHide: true });
  console.log((r.stdout || '') + (r.stderr || ''));
}
await sleep(plan.hold ?? 1500);
if (!codex) say({ type: 'result', subtype: 'success', usage: total, result: 'Done.' });
`;

/** A fresh scratch workspace: two project repos, a user config, a state dir, a scratch opsd. */
function workspace(tag) {
  const base = mkdtempSync(join(tmpdir(), `ops-readme-${tag}-`));
  const shop = join(base, 'storefront');
  const docs = join(base, 'docs-site');
  const state = join(base, 'state');
  const work = join(base, 'work');
  for (const d of [shop, docs, state, join(work, 'claude'), join(work, 'codex')]) {
    mkdirSync(d, { recursive: true });
  }
  for (const d of [shop, docs]) {
    execFileSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore', windowsHide: true });
  }
  const fwd = (p) => p.replace(/\\/g, '/');
  const agentJs = join(base, 'fake-agent.mjs');
  const plan = join(base, 'plan.json');
  writeFileSync(agentJs, FAKE_AGENT);
  writeFileSync(plan, '{}');
  const runtime = `{ command: '${fwd(process.execPath)}', args: ['${fwd(agentJs)}', '${fwd(cli)}', '${fwd(plan)}'] }`;
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
      '  max_runs: 6',
      '  min_free_gb: 0',
      '  review_backlog: 50',
      '  seeded: 1',
      '  runtimes:',
      `    claude: ${runtime}`,
      `    codex: ${runtime}`,
      '  roles:',
      '    engineer: { per_project: 4 }',
      // Each engineer works in a folder of its own, so their runs do not wait for one checkout.
      '  agents:',
      `    claude:engineer: { cwd: '${fwd(join(work, 'claude'))}', model: opus }`,
      `    codex:engineer: { cwd: '${fwd(join(work, 'codex'))}' }`,
      '    codex:qa: {}',
      '    claude:reviewer: {}',
      '    claude:pm: {}',
      '  chat:',
      '    agent: claude:pm',
      '    mentions: false',
      '  schedules:',
      '    - name: standup',
      "      at: '09:00'",
      '      agent: claude:pm',
      '      prompt: Write the daily standup from open tasks and post it to the general channel.',
      '      paused: true',
      '    - name: triage',
      '      every: 2h',
      '      agent: codex:qa',
      '      prompt: Triage new findings and propose priorities.',
      '      paused: true',
      '',
    ].join('\n'),
  );
  const env = { ...process.env, OPS_CONFIG: config, OPS_STATE_DIR: state, OPS_CWD: shop };
  for (const k of ['OPS_AGENT', 'OPS_RUN', 'OPS_ROOTS', 'OPS_RUN_TOKEN', 'OPS_RUN_STATE_DIR']) {
    delete env[k];
  }
  const envAs = (actor) => (actor ? { ...env, OPS_AGENT: actor } : env);
  const ops = (actor, ...args) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd: shop,
      env: envAs(actor),
      encoding: 'utf8',
      windowsHide: true,
    });
  // Fire and forget, for the animation: one slow `ops` must not hold the next step.
  const opsAsync = (actor, ...args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [cli, ...args], {
        cwd: shop,
        env: envAs(actor),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => {
        // A refused launch is retried by the caller, so only other failures are printed.
        if (code !== 0 && args[0] !== 'launch') {
          console.error(`  ops ${args.slice(0, 2).join(' ')}: ${err.trim()}`);
        }
        resolve(code);
      });
    });
  const plans = {};
  const setPlan = (task, steps, hold = 1500) => {
    plans[task] = { steps, hold };
    writeFileSync(plan, JSON.stringify(plans, null, 2));
  };
  const status = (task) => {
    try {
      return JSON.parse(ops(ME, 'show', task, '--json')).task.status;
    } catch {
      return null;
    }
  };
  const waitStatus = async (task, want, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (want.includes(status(task))) return true;
      await sleep(400);
    }
    console.error(`  ${task} did not reach ${want.join('|')} (is ${status(task)})`);
    return false;
  };
  return { base, shop, docs, state, config, env, ops, opsAsync, setPlan, status, waitStatus };
}

const id = (s) => s.match(/[A-Z]+-\d{4}/)[0];

/** The demo: a web shop and its docs site. Tasks first, worked directly where no run is needed. */
function seed(w) {
  const { ops } = w;
  ops(ME, 'init', '--name', 'storefront', '--prefix', 'SHOP', '--human', ME);
  execFileSync(
    process.execPath,
    [cli, 'init', w.docs, '--name', 'docs-site', '--prefix', 'DOCS', '--human', ME],
    { cwd: w.docs, env: { ...w.env, OPS_AGENT: ME }, stdio: 'ignore', windowsHide: true },
  );
  const task = (title, ...o) => id(ops(ME, 'new', title, ...o));
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
    '-m',
    'Repro: add any item, apply `WELCOME10` on iOS 18 Safari, the total does not change.',
  );
  T.pricing = task(
    'Redesign the pricing page with a monthly/annual toggle',
    '--priority',
    'p1',
    '--label',
    'pricing',
    '--label',
    'ui',
    '--to',
    XE,
    '-m',
    'Three plans, annual saves 20 %. Keep the comparison table below the fold.',
  );
  T.images = task(
    'Serve responsive product images (srcset, AVIF)',
    '--priority',
    'p1',
    '--label',
    'perf',
    '--to',
    CE,
    '-m',
    'The product grid ships 2400 px JPEGs to phones. Generate 400, 800 and 1200 px widths in AVIF and WebP.',
  );
  T.a11y = task(
    'Accessibility pass on the checkout form',
    '--priority',
    'p1',
    '--label',
    'a11y',
    '--to',
    XE,
    '-m',
    'Labels, error messages tied to inputs, focus order, 4.5:1 contrast.',
  );
  T.dark = task(
    'Dark mode for the storefront theme',
    '--priority',
    'p2',
    '--label',
    'ui',
    '--to',
    '*:engineer',
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
  T.webhook = task(
    'Retry failed payment webhooks with backoff',
    '--priority',
    'p1',
    '--label',
    'payments',
    '--to',
    XE,
  );
  T.search = task(
    'Search ranks out-of-stock products first',
    '--type',
    'bug',
    '--priority',
    'p2',
    '--label',
    'search',
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
  T.reviews = task(
    'Lazy-load the reviews widget below the fold',
    '--priority',
    'p3',
    '--label',
    'perf',
    '--to',
    CE,
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
  T.gift = task('Gift card balance page', '--priority', 'p3', '--label', 'payments');
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
  T.wish = task('Shareable wishlists', '--type', 'idea', '--label', 'growth');

  // Working: images (Claude) and the e2e suite (QA).
  ops(CE, 'start', T.images, 'sharp at build time, <picture> with AVIF and WebP fallbacks');
  ops(CE, 'progress', T.images, 'The build emits 3 widths in 2 formats; the grid uses srcset now.');
  ops(QA, 'start', T.e2e, 'Playwright: guest checkout with card, PayPal and a declined card');
  ops(QA, 'progress', T.e2e, '7 of 11 scenarios pass; the declined-card flow needs a test key.');

  // Blocked: the webhook retries wait for the human, shipping waits on the webhook work.
  ops(XE, 'start', T.webhook, 'Queue failed events, exponential backoff');
  ops(
    XE,
    'ask',
    T.webhook,
    'How long should we retry a failed webhook before we alert: 24 h or 72 h?',
  );
  ops(CE, 'start', T.shipping, 'Profile the carrier API call');
  ops(
    CE,
    'block',
    T.shipping,
    `The carrier fallback needs the retry queue from ${T.webhook}.`,
    '--on',
    T.webhook,
  );

  // Findings from QA and the reviewer.
  ops(
    QA,
    'finding',
    'Product images have no width/height: layout shift on the grid',
    '--task',
    T.images,
    '--priority',
    'p2',
    '-m',
    'CLS 0.21 on the category page (mobile).',
  );
  ops(
    RV,
    'finding',
    'Coupon field accepts expired codes',
    '--task',
    T.checkout,
    '--priority',
    'p1',
    '-m',
    '`SUMMER24` still applies. The expiry check runs only server-side.',
  );

  // The PM breaks the sale into subtasks (the chat transcript shows the turn).
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
  ops(PM, 'progress', T.sale, `Filed ${T.prices}, ${T.banner} and ${T.badges}.`);

  // Knowledge, channels, a vote.
  ops(
    CE,
    'learn',
    'safari',
    'Promo inputs: listen to input, not change',
    '-m',
    'iOS Safari fires `change` on blur only. Recompute totals on `input`.',
    '--task',
    T.checkout,
  );
  ops(
    CE,
    'learn',
    'images',
    'AVIF with a WebP fallback in <picture>',
    '-m',
    'Order the sources AVIF, WebP, then the JPEG `img`. Always set width and height.',
  );
  ops(
    QA,
    'learn',
    'testing',
    'Stripe test cards for declined payments',
    '-m',
    'Use 4000 0000 0000 0002 for a generic decline in Playwright runs.',
  );
  ops(
    PM,
    'channel',
    'post',
    'general',
    `The holiday sale is split into ${T.prices}, ${T.banner} and ${T.badges}. @codex:engineer the price rule is yours.`,
  );
  ops(
    XE,
    'channel',
    'post',
    'general',
    `On it after ${T.a11y}. @claude:reviewer the pricing page is ready for you.`,
  );
  ops(
    QA,
    'channel',
    'post',
    'qa',
    'Guest checkout suite: 7/11 green. The declined-card flow is next.',
  );
  ops(
    PM,
    'propose',
    'Which image CDN should we use for product photos?',
    '--option',
    'Cloudflare Images',
    '--option',
    'imgix',
    '--option',
    'Self-hosted (sharp + S3)',
    '--voters',
    `${CE},${XE},${RV}`,
    '--deadline',
    '+48h',
    '--task',
    T.images,
    '-m',
    `${T.images} needs a CDN that serves AVIF. Cost and cache purge speed matter most.`,
  );

  ops(CE, 'vote', 'D-0001', '1', 'Serves AVIF on the fly and purges in seconds.');
  ops(XE, 'vote', 'D-0001', '3', 'Cheapest at our volume; we already resize with sharp.');

  // docs-site
  const dtask = (title, ...o) => id(ops(ME, 'new', title, ...o, '--root', 'docs-site'));
  const D = {};
  D.start = dtask('Getting started guide', '--priority', 'p1', '--label', 'docs', '--to', CE);
  D.links = dtask(
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
  D.search = dtask('Add search to the docs site', '--priority', 'p2', '--label', 'docs');
  D.versions = dtask('Versioned docs for API v2', '--priority', 'p3', '--label', 'docs');
  ops(XE, 'start', D.links, 'Link checker in CI first', '--root', 'docs-site');
  return { T, D };
}

/** Finished work, done through opsd runs so Runs, Reports and the task history show real runs. */
async function history(w, T, D) {
  const { ops, setPlan, waitStatus } = w;
  setPlan(T.checkout, [
    [300, 'start', T.checkout, 'Reproduce in WebKit, then fix applyDiscount()'],
    [
      800,
      'progress',
      T.checkout,
      'Found it: Safari fires `change` on the promo input only on blur.',
    ],
    [
      800,
      'review',
      T.checkout,
      'The total is recomputed on `input` now; added a WebKit test.',
      '--to',
      QA,
    ],
  ]);
  setPlan(T.pricing, [
    [300, 'start', T.pricing, 'Toggle component first, then plan cards and the table'],
    [800, 'progress', T.pricing, 'Toggle and plan cards done; prices come from the plans API.'],
    [
      800,
      'review',
      T.pricing,
      'Ready: toggle, three plan cards, annual badge, mobile layout.',
      '--to',
      RV,
    ],
  ]);
  setPlan(T.reviews, [
    [300, 'start', T.reviews, 'IntersectionObserver around the widget'],
    [
      800,
      'review',
      T.reviews,
      'The widget loads 200 px before it scrolls into view. LCP -0.4 s.',
      '--to',
      XE,
    ],
  ]);
  setPlan(T.a11y, [
    [300, 'start', T.a11y, 'axe-core audit first'],
    [
      800,
      'review',
      T.a11y,
      'Labels and aria-describedby on every field; axe is clean.',
      '--to',
      RV,
    ],
  ]);
  setPlan(D.start, [
    [300, 'start', D.start, 'Install, first order, webhooks', '--root', 'docs-site'],
    [
      800,
      'review',
      D.start,
      'The guide is live on the preview site.',
      '--to',
      XE,
      '--root',
      'docs-site',
    ],
  ]);
  const run = async (agent, task, verdict) => {
    ops(ME, 'launch', agent, '--task', task);
    await waitStatus(task, ['needs-review']);
    // The run ends shortly after its review; the next run of the agent needs its folder free.
    await sleep(2500);
    if (verdict) ops(...verdict);
  };
  await Promise.all([
    (async () => {
      await run(CE, T.checkout, [
        QA,
        'verdict',
        T.checkout,
        'approve',
        'Verified on iOS 18 Safari and desktop Chrome.',
      ]);
      await run(CE, T.reviews, [
        XE,
        'verdict',
        T.reviews,
        'approve',
        'Looks good, no layout shift.',
      ]);
      await run(CE, D.start, [
        XE,
        'verdict',
        D.start,
        'approve',
        'Clear and short.',
        '--root',
        'docs-site',
      ]);
    })(),
    (async () => {
      await run(XE, T.pricing, null);
      ops(
        RV,
        'comment',
        T.pricing,
        'Annual prices round to .99 on the cards but not in the table.',
        '--to',
        XE,
      );
      ops(
        XE,
        'comment',
        T.pricing,
        'Fixed: the table uses the same price formatter as the cards now.',
        '--to',
        RV,
      );
      await run(XE, T.a11y, [
        RV,
        'verdict',
        T.a11y,
        'changes',
        'Focus still jumps to the top after a failed submit. Move it to the first invalid field.',
      ]);
    })(),
  ]);
}

/** The chat view: the human asks the PM to split an idea into tasks. */
function writeChat(w, T) {
  const t0 = Date.now() - 6 * 60_000;
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  const created = (task, title) => ({
    kind: 'task',
    type: 'created',
    root: 'storefront',
    task,
    title,
    summary: '',
  });
  writeFileSync(
    join(w.state, 'chat.json'),
    JSON.stringify({
      markers: {},
      messages: [
        {
          id: '01README0CHAT00000000000001',
          role: 'user',
          at: at(0),
          text: `Break ${T.sale} into tasks we can start this week. Prices go live Nov 27.`,
          from: ME,
          status: 'sent',
        },
        {
          id: '01README0CHAT00000000000002',
          role: 'assistant',
          at: at(1),
          text: [
            `I split ${T.sale} into three tasks under it:`,
            '',
            `- ${T.prices}: p1, assigned to \`codex:engineer\``,
            `- ${T.banner}: p1, open to any engineer`,
            `- ${T.badges}: p2, open to any engineer`,
            '',
            'The price rule should merge first, so the badges read real sale prices. Banner and badges can run in parallel.',
          ].join('\n'),
          actions: [
            created(T.prices, 'Schedule the 25 % price rule for Nov 27 to Dec 1'),
            created(T.banner, 'Sale banner with countdown on every page'),
            created(T.badges, 'Sale price badges on product cards'),
            {
              kind: 'channel',
              type: 'post',
              root: 'storefront',
              channel: 'general',
              summary: 'Holiday sale plan posted',
            },
          ],
        },
        {
          id: '01README0CHAT00000000000003',
          role: 'user',
          at: at(3),
          text: `Good. Who is free to take ${T.banner}?`,
          from: ME,
          status: 'sent',
        },
        {
          id: '01README0CHAT00000000000004',
          role: 'assistant',
          at: at(4),
          text: `\`claude:engineer\` is close to done with ${T.images}, and \`codex:engineer\` is fixing review notes on ${T.a11y}. The banner stays open to \`*:engineer\`, so whoever frees up first claims it.`,
          actions: [],
        },
      ],
    }),
  );
}

/**
 * A wrapper app in the scratch folder that resizes the window and turns off the card rise
 * animation, then imports the real main process (packages/desktop/dist/main.js), so the build
 * itself is not changed.
 */
function wrapper(w) {
  const dir = join(w.base, 'app');
  mkdirSync(dir, { recursive: true });
  const main = pathToFileURL(join(top, 'packages', 'desktop', 'dist', 'main.js')).href;
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'agent-ops-readme', type: 'module', main: 'main.mjs' }),
  );
  writeFileSync(
    join(dir, 'main.mjs'),
    [
      "import { app } from 'electron';",
      "app.on('browser-window-created', (_e, win) => {",
      `  win.setSize(${size[0]}, ${size[1]});`,
      // Cards rise in over 0.32 s when they change column; a frame taken then shows a gap.
      "  win.webContents.on('dom-ready', () => win.webContents.insertCSS('.animate-rise, .animate-fade { animation: none !important; }'));",
      '});',
      `await import('${main}');`,
      '',
    ].join('\n'),
  );
  return dir;
}

/** Starts the app in screenshot mode for `views`; resolves with its exit code. */
function launchApp(w, shots, views) {
  const electron = createRequire(import.meta.url)('electron');
  const child = spawn(electron, [wrapper(w), `--user-data-dir=${join(w.base, 'userdata')}`], {
    env: { ...w.env, AGENT_OPS_SCREENSHOTS: shots, AGENT_OPS_VIEWS: views.join(',') },
    // No pipes: the scratch opsd would hold them open past the app's exit.
    stdio: 'ignore',
    windowsHide: true,
  });
  console.log(`  app pid ${child.pid}`);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('  app timed out; stopping it');
      child.kill();
    }, 300_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function startDaemon(w) {
  execFileSync(process.execPath, [cli, 'daemon', 'start'], {
    cwd: w.shop,
    env: w.env,
    stdio: 'ignore',
    windowsHide: true,
    timeout: 120_000,
  });
}

/** Stops the scratch opsd and every run it still has. */
function stopDaemon(w) {
  if (w.stopped) return;
  w.stopped = true;
  const ok =
    spawnSync(process.execPath, [cli, 'daemon', 'stop', '--kill-runs'], {
      cwd: w.shop,
      env: w.env,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 60_000,
    }).status === 0;
  if (!ok) console.error(`  could not stop the scratch opsd: see ${join(w.state, 'opsd.json')}`);
}

function problemsOf(shots) {
  const f = join(shots, 'problems.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : ['no problems.json'];
}

/** Seeds a workspace with tasks and run history; opsd keeps running for the app. */
async function prepare(tag) {
  console.log(`${tag}: seeding`);
  const w = workspace(tag);
  live.push(w);
  const { T, D } = seed(w);
  writeChat(w, T);
  startDaemon(w);
  console.log(`${tag}: runs for finished work`);
  await history(w, T, D);
  return { w, T, D };
}

// The screenshots kept in docs/media, by raw view file; every view is rendered and checked.
const SHOTS = {
  board: 'board.png',
  task: 'task.png',
  inbox: 'inbox.png',
  chat: 'chat.png',
  runs: 'runs.png',
  activity: 'activity.png',
};

async function screenshots() {
  const { w, T } = await prepare('shots');
  // Two live runs while the app looks: Claude on the images, QA on the e2e suite.
  w.setPlan(
    T.images,
    [[500, 'progress', T.images, 'Product detail page done; checking LCP on a throttled profile.']],
    240_000,
  );
  w.setPlan(
    T.e2e,
    [[500, 'progress', T.e2e, '9 of 11 scenarios pass; PayPal sandbox next.']],
    240_000,
  );
  const run = w.ops(ME, 'launch', CE, '--task', T.images).trim().split(' ')[0];
  w.ops(ME, 'launch', QA, '--task', T.e2e);
  await sleep(3000);
  const shots = join(w.base, 'shots');
  const views = [
    'board',
    `task:${T.pricing}`,
    'board:lanes:agent',
    'inbox',
    'list',
    'findings',
    'activity',
    'agents',
    `runs:${run}`,
    'decisions',
    'chat',
    'channels',
    'knowledge',
    'schedules',
    'reports',
  ];
  console.log('shots: rendering');
  const code = await launchApp(w, shots, views);
  stopDaemon(w);
  const problems = problemsOf(shots);
  console.log(`  exit ${code}, problems: ${problems.length ? problems.join(' | ') : 'none'}`);
  mkdirSync(out, { recursive: true });
  for (const [raw, name] of Object.entries(SHOTS)) {
    const file = { task: `task-${T.pricing}`, runs: `runs-${run}` }[raw] ?? raw;
    const from = join(shots, `${file}.png`);
    if (existsSync(from)) copyFileSync(from, join(out, name));
  }
  console.log(`  raw screenshots in ${shots}`);
  return w;
}

/**
 * The animation: the app captures the board once per view step (about 1.2 s) while this process
 * starts runs and gives verdicts, each step fired once the frame it follows is on disk.
 */
async function animation() {
  const { w, T } = await prepare('anim');
  const { ops, opsAsync, setPlan, waitStatus } = w;
  // The e2e suite keeps running through the whole clip.
  setPlan(
    T.e2e,
    [[500, 'progress', T.e2e, '9 of 11 scenarios pass; PayPal sandbox next.']],
    240_000,
  );
  ops(ME, 'launch', QA, '--task', T.e2e);
  setPlan(T.a11y, [
    [300, 'start', T.a11y, 'Move focus to the first invalid field after submit'],
    [2200, 'progress', T.a11y, 'Focus handling done; rerunning axe and VoiceOver.'],
    [2200, 'review', T.a11y, 'Focus moves to the first invalid field; axe is clean.', '--to', RV],
  ]);
  setPlan(T.cart, [
    [300, 'start', T.cart, 'Invalidate the cart query after a remove'],
    [2500, 'progress', T.cart, 'Root cause: the badge reads a cached count.'],
    [2500, 'review', T.cart, 'The badge updates on remove; added a unit test.', '--to', QA],
  ]);
  setPlan(T.webhook, [
    [300, 'start', T.webhook, 'Backoff 1 m, 5 m, 30 m, then hourly up to 72 h'],
    [2000, 'progress', T.webhook, 'Retry queue and alert after the third failure.'],
    [
      2000,
      'review',
      T.webhook,
      'Retries with backoff for 72 h; alert after 3 failures.',
      '--to',
      RV,
    ],
  ]);
  setPlan(
    T.search,
    [
      [300, 'start', T.search, 'Sort by stock, then relevance'],
      [3000, 'progress', T.search, 'In-stock items rank first; tuning the boost.'],
    ],
    240_000,
  );
  const launch = async (agent, task) => {
    for (let i = 0; i < 10; i++) {
      if ((await opsAsync(ME, 'launch', agent, '--task', task)) === 0) return;
      await sleep(700);
    }
    console.error(`  could not launch ${agent} on ${task}`);
  };
  const after =
    (task, want, ...cmd) =>
    async () => {
      if (await waitStatus(task, want, 30_000)) await opsAsync(...cmd);
    };
  // [frame, step]: each step starts right after that frame is written.
  const steps = [
    [
      1,
      () =>
        opsAsync(RV, 'verdict', T.pricing, 'approve', 'Toggle, cards and table match. Ship it.'),
    ],
    [2, () => launch(XE, T.a11y)],
    [3, () => launch(CE, T.cart)],
    [4, () => opsAsync(ME, 'answer', T.webhook, 'Retry for 72 h, alert after the third failure.')],
    [
      5,
      () =>
        opsAsync(
          CE,
          'review',
          T.images,
          'srcset and AVIF on the grid and product pages. LCP 2.9 s -> 1.6 s.',
          '--to',
          QA,
        ),
    ],
    [7, () => opsAsync(QA, 'verdict', T.images, 'approve', 'Checked on a throttled 3G profile.')],
    [
      8,
      after(
        T.a11y,
        ['needs-review'],
        RV,
        'verdict',
        T.a11y,
        'approve',
        'Keyboard and VoiceOver pass.',
      ),
    ],
    [
      9,
      () =>
        opsAsync(
          QA,
          'finding',
          'Cart drawer does not return focus to the cart button',
          '--task',
          T.cart,
          '--priority',
          'p2',
        ),
    ],
    [10, () => launch(XE, T.webhook)],
    [
      11,
      after(
        T.cart,
        ['needs-review'],
        QA,
        'verdict',
        T.cart,
        'approve',
        'Verified on desktop and mobile.',
      ),
    ],
    [13, () => launch(CE, T.search)],
    [
      15,
      after(
        T.webhook,
        ['needs-review'],
        RV,
        'verdict',
        T.webhook,
        'approve',
        'Good coverage of the retry paths.',
      ),
    ],
  ];
  const frames = 19;
  const views = Array.from({ length: frames }, (_, i) => `board:f${String(i).padStart(2, '0')}`);
  views.push(`task:${T.webhook}`);
  const shots = join(w.base, 'frames');
  console.log(`anim: recording ${views.length} frames`);
  let finished = false;
  const done = launchApp(w, shots, views).then((c) => {
    finished = true;
    return c;
  });
  const pending = [];
  for (const [frame, step] of steps) {
    const file = join(shots, `board-f${String(frame).padStart(2, '0')}.png`);
    while (!existsSync(file) && !finished) await sleep(50);
    if (finished) break;
    pending.push(step());
  }
  const code = await done;
  await Promise.all(pending);
  stopDaemon(w);
  const problems = problemsOf(shots);
  console.log(`  exit ${code}, problems: ${problems.length ? problems.join(' | ') : 'none'}`);
  console.log(`  raw frames in ${shots}`);
  return { w, shots, views };
}

/** Builds demo.mp4 and demo.gif from the frames: each frame held, with a short crossfade. */
function encode(shots, views) {
  const files = views.map((v) => join(shots, `${v.replace(/[:/]/g, '-')}.png`));
  const hold = 0.9;
  const fade = 0.3;
  const inputs = [];
  files.forEach((f, i) => {
    const last = i === files.length - 1;
    inputs.push('-loop', '1', '-t', String(last ? hold + 2 : hold + fade), '-i', f);
  });
  let chain = '';
  let prev = '[0:v]';
  let offset = 0;
  for (let i = 1; i < files.length; i++) {
    offset += hold;
    const label = `[x${i}]`;
    chain += `${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(2)}${label};`;
    prev = label;
  }
  mkdirSync(out, { recursive: true });
  const mp4 = join(out, 'demo.mp4');
  const gif = join(out, 'demo.gif');
  const ff = (...args) =>
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], {
      stdio: 'inherit',
      windowsHide: true,
    });
  ff(
    ...inputs,
    '-filter_complex',
    `${chain}${prev}fps=30,format=yuv420p[v]`,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    mp4,
  );
  ff(
    '-i',
    mp4,
    '-filter_complex',
    'fps=10,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop',
    '0',
    gif,
  );
  for (const f of [mp4, gif]) console.log(`  ${f}: ${(statSync(f).size / 1e6).toFixed(2)} MB`);
}

const scratch = [];
/** Workspaces whose opsd may still run, stopped on the way out whatever happens. */
const live = [];
try {
  if (only !== 'anim') scratch.push((await screenshots()).base);
  if (only !== 'shots') {
    const { w, shots, views } = await animation();
    scratch.push(w.base);
    encode(shots, views);
  }
} finally {
  for (const w of live) stopDaemon(w);
  if (!keep) for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
}
