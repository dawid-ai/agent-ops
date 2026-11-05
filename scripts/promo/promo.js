// The promo composition. render(t) sets every layer for time t (seconds); nothing reads the clock,
// so render-main.mjs can step it frame by frame. All app imagery is real captures of the desktop
// app (window.PROMO, from promo-video.mjs): the board states, chat, inbox, runs, activity and a
// task panel. Cards are crops of those captures, moved between the positions the app itself laid
// them out at in consecutive states.
/* global window, document, Image, createImageBitmap */
'use strict';
(() => {
  const P = window.PROMO;
  const A = window.ASSETS;
  const S = P.shots;
  const M = P.meta;
  const T = M.T;
  const DUR = 32.5;
  window.DURATION = DUR;
  const W = 1920;
  const H = 1080;

  // ---------- math ----------
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const env = (t, a, b, c, d) => seg(t, a, b) * (1 - seg(t, c, d));
  const E = {
    inOut3: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    inOut5: (p) => (p < 0.5 ? 16 * p ** 5 : 1 - Math.pow(-2 * p + 2, 5) / 2),
    out3: (p) => 1 - Math.pow(1 - p, 3),
    out5: (p) => 1 - Math.pow(1 - p, 5),
    outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    outBack: (p, s = 1.7) => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2),
    smooth: (p) => p * p * (3 - 2 * p),
  };
  // Moves between columns: a slow start, a fast middle and a soft landing (the speed ramp).
  const move = (p) => E.inOut5(p);
  const rnd = (i) => {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  // ---------- DOM helpers ----------
  const stage = document.getElementById('stage');
  const el = (tag, cls, parent, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    (parent || stage).appendChild(e);
    return e;
  };
  const css = (e, o) => Object.assign(e.style, o);
  const vis = (e, o) => {
    e.style.opacity = String(o);
    e.style.visibility = o <= 0.002 ? 'hidden' : 'visible';
  };
  const R = (r) => ({ x: r[0], y: r[1], w: r[2], h: r[3] });
  const hexA = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  // ---------- identity ----------
  const PROV = { claude: '#f08a5d', codex: '#3ddc97', human: '#ffc857' };
  const ROLE = {
    engineer: '#5aa9ff',
    qa: '#b18cff',
    reviewer: '#c9a4ff',
    pm: '#ff7eb6',
    docs: '#4fd1c5',
    you: '#ffc857',
  };
  const COLC = {
    todo: '#8b93a3',
    working: '#5aa9ff',
    blocked: '#ffb547',
    review: '#b18cff',
    done: '#3ddc97',
  };
  const svg = (inner, color, size, sw = 2) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  // The app's provider marks (ui/identity.tsx) and the lucide role icons it uses.
  const MARK = {
    claude:
      [0, 45, 90, 135]
        .map((a) => `<line x1="12" y1="3" x2="12" y2="21" transform="rotate(${a} 12 12)"/>`)
        .join('') + `<circle cx="12" cy="12" r="2.2" fill="${PROV.claude}" stroke="none"/>`,
    codex:
      '<path d="M12 2.5 20.5 7.25v9.5L12 21.5 3.5 16.75v-9.5Z"/><path d="m8.5 9.5 2.5 2.5-2.5 2.5M12.5 15h3"/>',
    human: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  };
  const ROLE_ICON = {
    engineer: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
    qa: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    reviewer:
      '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    pm: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>',
    docs: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    you: '<path d="M12 22c5.5 0 10-4.5 10-10S17.5 2 12 2 2 6.5 2 12s4.5 10 10 10z"/><path d="m9 12 2 2 4-4"/>',
  };
  const who = (id) => {
    const [rt, role] = id.split(':');
    return { rt, role, prov: PROV[rt] ?? '#94a3b8', roleC: ROLE[role] ?? '#94a3b8' };
  };
  const idHtml = (id) => {
    const w = who(id);
    return `<span style="color:${w.prov}">${w.rt}</span><span style="color:#566074">:</span><span style="color:${w.roleC}">${w.role}</span>`;
  };

  // ---------- layers ----------
  const bg = el('canvas');
  bg.width = W;
  bg.height = H;
  const bgx = bg.getContext('2d');
  const cold = el('div');
  cold.id = 'cold';
  const camera = el('div');
  camera.id = 'camera';
  const win = el('div', null, camera);
  win.id = 'win';
  const fx = el('canvas');
  fx.width = W;
  fx.height = H;
  const g = fx.getContext('2d');
  const nodesL = el('div', 'full');
  const pillsL = el('div', 'full');
  pillsL.style.zIndex = '0';
  const hud = el('div');
  hud.id = 'hud';
  const caption = el('div');
  caption.id = 'caption';
  const dim = el('div');
  dim.id = 'dim';
  const inbox = el('div');
  inbox.id = 'inbox';
  const cursor = el(
    'div',
    null,
    stage,
    '<svg width="34" height="34" viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.6L10 19z" fill="#e7eaf0" stroke="#05070a" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  );
  cursor.id = 'cursor';
  const merge = el('div');
  merge.id = 'merge';
  const montage = el('div', 'full');
  const mcap = el('div');
  mcap.id = 'mcap';
  const statkick = el('div', null, stage, 'ONE DEMO SESSION, ON ONE PC');
  statkick.id = 'statkick';
  const stats = el('div');
  stats.id = 'stats';
  const end = el('div');
  end.id = 'end';
  const sync = el('div');
  css(sync, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    zIndex: '99',
  });

  // ---------- captures as canvases ----------
  // CSS background images decode on first paint and can show blank for a frame; a canvas filled
  // once from a decoded bitmap always holds its pixels.
  const BM = {};
  const filled = [];
  const shotCanvas = (parent, name, r = { x: 0, y: 0, w: 1600, h: 960 }) => {
    const cv = el('canvas', null, parent);
    cv.width = Math.round(r.w * 2);
    cv.height = Math.round(r.h * 2);
    css(cv, { position: 'absolute', left: '0', top: '0', width: `${r.w}px`, height: `${r.h}px` });
    filled.push({ cv, name, r });
    return cv;
  };

  // ---------- window content ----------
  const shot = {};
  for (const n of ['chat0', 'chatbg', 'chrome']) shot[n] = shotCanvas(win, n);
  const c1 = S.chat1;
  const userR = R(c1.msgs[0]);
  const pmR = R(c1.msgs[1]);
  const userPiece = shotCanvas(win, 'chat1', userR);
  css(userPiece, { left: `${userR.x}px`, top: `${userR.y}px` });
  const pmWrap = el('div', 'layer', win);
  css(pmWrap, {
    left: `${pmR.x}px`,
    top: `${pmR.y}px`,
    width: `${pmR.w}px`,
    overflow: 'hidden',
  });
  shotCanvas(pmWrap, 'chat1', pmR);

  const ta = R(S.chat0.textarea);
  const composerPatch = el('div', 'layer', win);
  css(composerPatch, {
    left: `${ta.x + 2}px`,
    top: `${ta.y + 3}px`,
    width: `${ta.w * 0.7}px`,
    height: '30px',
    background: P.colors.composer,
  });
  const composerText = el('div', 'typed', win);
  css(composerText, { left: `${ta.x + 13}px`, top: `${ta.y + 9}px` });
  const sendBtn = S.chat0.buttons.find((b) => b.text === 'Send');
  const sendGlow = el('div', 'layer', win);
  if (sendBtn) {
    const b = R(sendBtn.rect);
    css(sendGlow, {
      left: `${b.x}px`,
      top: `${b.y}px`,
      width: `${b.w}px`,
      height: `${b.h}px`,
      borderRadius: '8px',
      background: 'rgba(92,225,230,0.55)',
      boxShadow: '0 0 30px rgba(92,225,230,0.8)',
    });
  }

  const boardL = el('div', 'layer', win);
  const subtitle = el('div', 'subtitle', boardL);
  const sub = R(S.b1.subtitle.rect);
  css(subtitle, { left: `${sub.x}px`, top: `${sub.y}px` });
  const badges = {};
  for (const c of S.b1.cols) {
    const b = R(c.badge);
    const e = el('div', 'badge', boardL);
    css(e, {
      left: `${b.x}px`,
      top: `${b.y}px`,
      width: `${b.w}px`,
      height: `${b.h}px`,
      color: COLC[c.key],
      background: hexA(COLC[c.key], 0.12),
    });
    badges[c.key] = e;
  }
  const cardsL = el('div', 'layer', win);

  // ---------- board states ----------
  const STATES = Object.keys(S)
    .filter((k) => /^b\d+$/.test(k))
    .sort((a, b) => +a.slice(1) - +b.slice(1));
  const live = (runs) => runs.filter((r) => !r.ended_at);
  const ST = {};
  for (const k of STATES) {
    const cards = {};
    for (const col of S[k].cols) {
      for (const c of col.cards) cards[c.id] = { ...R(c.rect), col: col.key, shot: k };
    }
    const runs = M.states[k].runs;
    ST[k] = {
      cards,
      counts: Object.fromEntries(S[k].cols.map((c) => [c.key, c.count])),
      subtitle: S[k].subtitle ? S[k].subtitle.text : '',
      actions: M.actions[k] ?? [],
      live: live(runs).length,
      liveAgents: new Map(live(runs).map((r) => [r.agent, r.task])),
      tokens: runs.reduce((s, r) => s + (r.tokens || 0), 0),
      runs: runs.length,
    };
  }
  // The chat: the three created-task chips are where those cards start.
  const created = [T.prices, T.banner, T.badges];
  const chips = {};
  for (const ch of c1.chips) if (created.includes(ch.id)) chips[ch.id] = R(ch.rect);
  ST.chat = {
    cards: Object.fromEntries(
      created.map((id) => [id, { ...chips[id], col: 'chat', shot: 'chat1' }]),
    ),
    counts: ST.b1.counts,
    subtitle: ST.b1.subtitle,
    actions: [],
    live: ST.b1.live,
    liveAgents: new Map(),
    tokens: ST.b1.tokens,
    runs: ST.b1.runs,
  };
  ST.chat.actions = created.map((id) => [id, 'claude:pm']);

  const TR = [
    { from: 'chat', to: 'b1', t0: 5.55, d: 1.5, kind: 'fly' },
    { from: 'b1', to: 'b2', t0: 8.3, d: 1.15 },
    { from: 'b2', to: 'b3', t0: 9.8, d: 1.0 },
    { from: 'b3', to: 'b4', t0: 11.1, d: 0.9 },
    { from: 'b4', to: 'b5', t0: 12.3, d: 0.85 },
    { from: 'b5', to: 'b6', t0: 13.65, d: 1.15 },
    { from: 'b6', to: 'b7', t0: 17.2, d: 1.0 },
    { from: 'b7', to: 'b8', t0: 18.45, d: 0.95 },
    { from: 'b8', to: 'b9', t0: 19.6, d: 1.0 },
  ];
  for (const tr of TR) {
    const acts = tr.kind === 'fly' ? ST.chat.actions : ST[tr.to].actions;
    const n = acts.length;
    const step = n > 1 ? Math.min(0.12, 0.3 / (n - 1)) : 0;
    tr.acts = new Map(acts.map(([id, actor], k) => [id, { actor, delay: k * step }]));
    tr.dmax = step * Math.max(0, n - 1);
  }
  const boardAt = (t) => {
    let key = 'b1';
    for (const tr of TR) {
      if (t < tr.t0) return { tr: null, key };
      if (t < tr.t0 + tr.d) return { tr, p: (t - tr.t0) / tr.d };
      key = tr.to;
    }
    return { tr: null, key };
  };
  const landAt = (tr, id) => {
    const a = tr.acts.get(id);
    return tr.t0 + tr.d * ((a ? a.delay : 0) + (1 - tr.dmax));
  };

  // What each landing means, as a pill and a burst color.
  const R_OF = {
    [T.prices]: 'claude:reviewer',
    [T.banner]: 'codex:qa',
    [T.dsearch]: 'codex:qa',
    [T.dlinks]: 'claude:reviewer',
  };
  const meaning = (tr, id, actor) => {
    const to = ST[tr.to].cards[id];
    const from = ST[tr.from].cards[id];
    if (!to) return null;
    if (tr.kind === 'fly') return { text: 'new task', color: '#5ce1e6' };
    if (!from) return { text: id === T.finding ? 'finding filed' : 'new', color: '#ffb547' };
    if (to.col === from.col) return null;
    if (to.col === 'done') return { text: `approved by ${actor}`, color: '#3ddc97', who: actor };
    if (to.col === 'review')
      return { text: `review → ${R_OF[id] ?? 'reviewer'}`, color: '#b18cff', who: R_OF[id] };
    if (to.col === 'blocked') return { text: 'question for you', color: '#ffc857' };
    if (from.col === 'review' && to.col === 'todo')
      return { text: 'changes requested', color: '#ff5d6c' };
    if (from.col === 'blocked') return { text: 'answered', color: '#ffc857' };
    if (to.col === 'working')
      return { text: `claimed by ${actor}`, color: who(actor).prov, who: actor };
    return null;
  };

  // ---------- camera ----------
  const CAM = [
    [0, { x: 960, y: 650, s: 0.84, rx: 28, o: 0 }],
    [1.75, { x: 960, y: 650, s: 0.84, rx: 28, o: 0 }],
    [2.45, { x: 800, y: 70, s: 1.35, rx: 0, o: 1 }],
    [3.75, { x: 790, y: 76, s: 1.36, rx: 0, o: 1 }],
    [4.35, { x: 800, y: 740, s: 1.34, rx: 0, o: 1 }],
    [5.3, { x: 820, y: 720, s: 1.28, rx: 0, o: 1 }],
    [7.1, { x: 960, y: 566, s: 0.86, rx: 0, o: 1 }],
    [13.4, { x: 960, y: 566, s: 0.86, rx: 0, o: 1 }],
    [14.4, { x: 960, y: 566, s: 0.87, rx: 0, o: 1 }],
    [22.0, { x: 960, y: 566, s: 0.88, rx: 0, o: 1 }],
    [22.6, { x: 960, y: 620, s: 0.7, rx: 10, o: 0 }],
  ];
  const cam = (t) => {
    let i = 0;
    while (i < CAM.length - 1 && t >= CAM[i + 1][0]) i++;
    const [t0, a] = CAM[i];
    const nxt = CAM[Math.min(i + 1, CAM.length - 1)];
    const p = nxt[0] > t0 ? E.inOut3(seg(t, t0, nxt[0])) : 0;
    const b = nxt[1];
    const o = {};
    for (const k of Object.keys(a)) o[k] = lerp(a[k], b[k] ?? a[k], p);
    return o;
  };
  let C = cam(0);
  const proj = (x, y) => [C.x + (x - 800) * C.s, C.y + (y - 480) * C.s];

  // ---------- agent nodes ----------
  const NODES = [
    ['claude:pm', 138, 290],
    ['claude:engineer', 138, 470],
    ['claude:docs', 138, 650],
    ['claude:reviewer', 138, 830],
    ['codex:engineer', 1782, 380],
    ['codex:qa', 1782, 590],
    ['human:you', 1782, 800],
  ].map(([id, x, y], i) => {
    const w = who(id);
    const e = el('div', 'node', nodesL);
    css(e, { left: `${x}px`, top: `${y - 39}px` });
    const ring = el('div', 'ring', e, svg(MARK[w.rt], w.prov, 40));
    const pulse = el('div', 'pulse', ring);
    el('div', 'role', ring, svg(ROLE_ICON[w.role], w.roleC, 17));
    el('div', 'label', e, idHtml(id));
    const state = el('div', 'state', e);
    return { id, x, y, e, ring, pulse, state, w, i };
  });
  const nodeOf = (id) => NODES.find((n) => n.id === id) ?? NODES.find((n) => n.id === 'human:you');

  // ---------- HUD ----------
  const tile = (k) => {
    const e = el('div', 'tile', hud);
    el('div', 'k', e, k);
    return el('div', 'v', e);
  };
  const hudLive = tile('Live runs');
  const hudTok = tile('Tokens');
  const hudRuns = tile('Runs');
  const capKick = el('div', 'kick', caption);
  const capLine = el('div', 'line', caption);
  const CAPS = [
    [6.6, 8.0, '01 · PLAN', 'Your PM splits the idea into tasks.'],
    [8.15, 13.5, '02 · BUILD', 'Claude and Codex agents claim tasks and work in parallel.'],
    [13.6, 22.3, '03 · CHECK', 'Reviews come from the other provider. Questions come to you.'],
  ];

  // ---------- cards ----------
  const cardCv = el('canvas', null, cardsL);
  cardCv.width = 3200;
  cardCv.height = 1920;
  css(cardCv, { position: 'absolute', left: '0', top: '0', width: '1600px', height: '960px' });
  const cg = cardCv.getContext('2d');
  /** One card: crop `src` of a capture, in a box at x, y (w, h), scaled s about its center. */
  const drawCard = (op) => {
    const { srcA, srcB, bOp, x, y, w, h, s: sc, alpha, glowC, glow } = op;
    if (alpha <= 0.002) return;
    cg.save();
    cg.translate((x + w / 2) * 2, (y + h / 2) * 2);
    cg.scale(sc, sc);
    const w2 = w * 2;
    const h2 = h * 2;
    if (glow > 0.01) {
      cg.save();
      cg.globalAlpha = alpha;
      cg.shadowColor = 'rgba(0,0,0,0.6)';
      cg.shadowBlur = 70 * glow;
      cg.shadowOffsetY = 30 * glow;
      cg.fillStyle = '#111620';
      cg.beginPath();
      cg.roundRect(-w2 / 2, -h2 / 2, w2, h2, 24);
      cg.fill();
      cg.shadowColor = hexA(glowC, 0.75 * glow);
      cg.shadowBlur = 64 * glow;
      cg.shadowOffsetY = 0;
      cg.fill();
      cg.restore();
    }
    cg.beginPath();
    cg.roundRect(-w2 / 2, -h2 / 2, w2, h2, 24);
    cg.clip();
    for (const [src, o] of [
      [srcA, bOp >= 1 ? 0 : 1],
      [srcB, bOp],
    ]) {
      if (!src || o <= 0.002) continue;
      cg.globalAlpha = alpha * o;
      cg.drawImage(
        BM[src.shot],
        src.x * 2,
        src.y * 2,
        src.w * 2,
        src.h * 2,
        -w2 / 2,
        -h2 / 2,
        src.w * 2,
        src.h * 2,
      );
    }
    if (glow > 0.01) {
      cg.globalAlpha = alpha * glow;
      cg.strokeStyle = hexA(glowC, 0.9);
      cg.lineWidth = 3;
      cg.beginPath();
      cg.roundRect(-w2 / 2 + 1.5, -h2 / 2 + 1.5, w2 - 3, h2 - 3, 23);
      cg.stroke();
    }
    cg.restore();
  };

  /** Cards for time t; returns what the effects layer draws (beams). */
  function renderBoard(t, boardOpacity) {
    cg.clearRect(0, 0, 3200, 1920);
    const fxItems = [];
    if (t < TR[0].t0) return fxItems;
    const at = boardAt(t);
    const tr = at.tr;
    const from = tr ? ST[tr.from] : ST[at.key];
    const to = tr ? ST[tr.to] : ST[at.key];
    const ops = [];
    for (const id of new Set([...Object.keys(from.cards), ...Object.keys(to.cards)])) {
      const r0 = from.cards[id];
      const r1 = to.cards[id];
      const act = tr && tr.acts.get(id);
      const op = {
        srcA: null,
        srcB: null,
        bOp: 1,
        s: 1,
        alpha: 1,
        glow: 0,
        glowC: '#5ce1e6',
        z: 1,
      };
      let lift = 0;
      if (!tr) {
        Object.assign(op, { srcB: r1, x: r1.x, y: r1.y, w: r1.w, h: r1.h, alpha: boardOpacity });
      } else if (r0 && r1) {
        const colChange = r0.col !== r1.col;
        const lp = clamp((at.p - (act ? act.delay : 0)) / (1 - tr.dmax));
        const bounce = r0.col === 'review' && r1.col === 'todo';
        let e = colChange ? move(lp) : E.inOut3(lp);
        if (bounce) e = E.outBack(E.inOut3(lp), 1.2);
        const ec = clamp(e);
        const dist = Math.hypot(r1.x - r0.x, r1.y - r0.y);
        const arc = 24 + dist * 0.07;
        if (colChange) {
          lift = -arc * Math.sin(Math.PI * ec);
          op.s = 1 + 0.08 * Math.sin(Math.PI * ec);
          op.glow = Math.sin(Math.PI * clamp(lp));
          op.glowC = act ? who(act.actor).prov : '#5ce1e6';
          op.z = 10;
          // Trails: earlier positions of the same card, fading out.
          for (let k = 4; k >= 1; k--) {
            const pk = lp - k * 0.045;
            if (pk <= 0 || pk >= 1) continue;
            const ek = move(pk);
            ops.push({
              srcA: null,
              srcB: r0,
              bOp: 1,
              x: lerp(r0.x, r1.x, ek),
              y: lerp(r0.y, r1.y, ek) - arc * Math.sin(Math.PI * ek),
              w: r0.w,
              h: r0.h,
              s: 1,
              alpha: 0.3 * (1 - k / 5) * Math.sin(Math.PI * lp),
              glow: 0,
              z: 5,
            });
          }
        }
        Object.assign(op, {
          srcA: r0,
          srcB: r1,
          x: lerp(r0.x, r1.x, e),
          y: lerp(r0.y, r1.y, e) + lift,
          w: lerp(r0.w, r1.w, ec),
          h: lerp(r0.h, r1.h, ec),
          bOp: tr.kind === 'fly' ? E.smooth(seg(e, 0.08, 0.42)) : E.smooth(seg(e, 0.3, 0.7)),
        });
        if (tr.kind === 'fly') op.z = 12;
      } else if (r1) {
        Object.assign(op, { srcB: r1, x: r1.x, y: r1.y, w: r1.w, h: r1.h });
        if (tr.kind === 'fly') op.alpha = boardOpacity;
        else {
          const lp = seg(at.p, 0.2, 0.8);
          op.s = 0.55 + 0.45 * E.outBack(lp, 2.2);
          op.alpha = clamp(lp * 3);
          op.z = 10;
        }
      } else {
        Object.assign(op, {
          srcB: r0,
          x: r0.x,
          y: r0.y,
          w: r0.w,
          h: r0.h,
          alpha: 1 - seg(at.p, 0, 0.35),
        });
      }
      ops.push(op);
      if (tr && act && r1) {
        const [sx, sy] = proj(op.x + op.w / 2, op.y + op.h / 2);
        fxItems.push({
          kind: 'beam',
          actor: act.actor,
          sx,
          sy,
          lp: clamp((at.p - act.delay) / (1 - tr.dmax)),
          tr,
        });
      }
    }
    ops.sort((p, q) => p.z - q.z);
    for (const op of ops) drawCard(op);
    return fxItems;
  }

  // ---------- effects drawing ----------
  const beam = (x0, y0, x1, y1, color, alpha, phase) => {
    if (alpha <= 0.01) return;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2 - Math.abs(x1 - x0) * 0.18;
    g.save();
    g.lineCap = 'round';
    for (const [lw, a] of [
      [14, 0.06],
      [7, 0.16],
      [2.4, 0.9],
    ]) {
      g.strokeStyle = hexA(color, a * alpha);
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(x0, y0);
      g.quadraticCurveTo(mx, my, x1, y1);
      g.stroke();
    }
    // Pulses travelling along the beam, toward the card.
    for (let k = 0; k < 3; k++) {
      const u = (phase + k / 3) % 1;
      const px = (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * mx + u * u * x1;
      const py = (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * my + u * u * y1;
      const rg = g.createRadialGradient(px, py, 0, px, py, 14);
      rg.addColorStop(0, hexA('#ffffff', 0.9 * alpha));
      rg.addColorStop(0.3, hexA(color, 0.8 * alpha));
      rg.addColorStop(1, hexA(color, 0));
      g.fillStyle = rg;
      g.beginPath();
      g.arc(px, py, 14, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  };
  const burst = (x, y, color, q) => {
    if (q <= 0 || q >= 1) return;
    g.save();
    const r = 18 + 70 * E.out3(q);
    g.strokeStyle = hexA(color, 0.9 * (1 - q));
    g.lineWidth = 3 * (1 - q) + 0.5;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + rnd(k) * 0.4;
      const d = 30 + 90 * E.out3(q) * (0.7 + rnd(k + 9) * 0.6);
      g.fillStyle = hexA(color, 1 - q);
      g.beginPath();
      g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 2.6 * (1 - q) + 0.6, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  };
  const roundRect = (x, y, w, h, r) => {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
  };

  // Pills near landed cards.
  const pillPool = [];
  const pill = (i) => {
    while (pillPool.length <= i) pillPool.push(el('div', 'pill', pillsL));
    return pillPool[i];
  };

  // ---------- inbox overlay ----------
  const qr = R(S.inbox.qcard);
  shotCanvas(inbox, 'inbox', qr);
  css(inbox, { width: `${qr.w}px`, height: `${qr.h}px`, transformOrigin: '0 0' });
  const ita = R(S.inbox.textarea);
  const inboxPatch = el('div', 'layer', inbox);
  css(inboxPatch, {
    left: `${ita.x - qr.x + 2}px`,
    top: `${ita.y - qr.y + 3}px`,
    width: `${ita.w * 0.6}px`,
    height: '30px',
    background: P.colors.inbox,
  });
  const inboxText = el('div', 'typed', inbox);
  css(inboxText, { left: `${ita.x - qr.x + 13}px`, top: `${ita.y - qr.y + 9}px` });
  const ansBtn = S.inbox.buttons.find(
    (b) => b.text === 'Answer' && b.rect[1] > qr.y && b.rect[1] < qr.y + qr.h,
  );
  const ab = R(ansBtn.rect);
  const ansFlash = el('div', 'layer', inbox);
  css(ansFlash, {
    left: `${ab.x - qr.x}px`,
    top: `${ab.y - qr.y}px`,
    width: `${ab.w}px`,
    height: `${ab.h}px`,
    borderRadius: '8px',
    background: 'rgba(92,225,230,0.5)',
    boxShadow: '0 0 26px rgba(92,225,230,0.8)',
  });
  const ANSWER = '72 h, and alert after the third failure.';

  // ---------- merge panel ----------
  const CHECKS = [
    'npm run typecheck',
    'npm run lint',
    'npm test',
    'npm run leaks',
    'npm run build',
  ];
  el('div', 'h', merge, `opsd merge · <span style="color:#5ce1e6">${T.prices}</span>`);
  const mergeSub = el(
    'div',
    'sub',
    merge,
    'approved by claude:reviewer · checks on the rebased work',
  );
  const rows = CHECKS.map((cmd) => {
    const r = el('div', 'row', merge);
    const ic = el('div', 'ic', r);
    el('div', null, r, cmd);
    return { r, ic, state: '' };
  });
  const mergeDone = el('div', 'row', merge);
  void mergeSub;
  const ICON = {
    wait: '<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="#3a4558" stroke-width="2"/></svg>',
    ok: '<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#3ddc97"/><path d="m7.5 12.5 3 3 6-6.5" fill="none" stroke="#05070a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const spin = (a) =>
    `<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="#273042" stroke-width="2.4"/><path d="M12 4a8 8 0 0 1 8 8" fill="none" stroke="#5ce1e6" stroke-width="2.4" stroke-linecap="round" transform="rotate(${a} 12 12)"/></svg>`;

  // ---------- montage ----------
  const MONT = [
    {
      shot: 'runs',
      t0: 22.5,
      t1: 24.05,
      focus: [1120, 330],
      text: 'opsd supervises every run: logs, tokens, budget.',
    },
    {
      shot: 'task',
      t0: 23.85,
      t1: 25.4,
      focus: [1260, 520],
      text: 'Every task keeps its full history, as files in git.',
    },
    {
      shot: 'activity',
      t0: 25.2,
      t1: 26.75,
      focus: [700, 380],
      text: 'One feed for everything your agents do.',
    },
  ].map((m) => {
    const p = el('div', 'panel', montage);
    const sh = shotCanvas(p, m.shot);
    sh.style.transformOrigin = `${m.focus[0]}px ${m.focus[1]}px`;
    return { ...m, p, sh };
  });

  // ---------- stats ----------
  const final = ST[STATES[STATES.length - 1]];
  const STATS = [
    { n: final.counts.done, l: 'tasks done', c: '#3ddc97' },
    { n: final.runs, l: 'agent runs', c: '#5ce1e6' },
    { n: M.verdicts, l: 'reviews', c: '#b18cff' },
    { n: 1, l: 'question for you', c: '#ffc857' },
  ].map((s) => {
    const e = el('div', 'stat', stats);
    const n = el('div', 'n', e);
    n.style.color = s.c;
    el('div', 'l', e, s.l);
    return { ...s, e, nEl: n };
  });

  // ---------- end card ----------
  const markSvg = el(
    'div',
    'mark',
    end,
    `<svg width="150" height="150" viewBox="0 0 32 32"><defs><linearGradient id="mk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ce1e6"/><stop offset="1" stop-color="#3ddc97"/></linearGradient></defs>
    <rect id="mrect" x="1" y="1" width="30" height="30" rx="9" fill="#0d1117" stroke="url(#mk)" stroke-opacity="0.5" stroke-width="0.8"/>
    ${[0, 90, 180, 270].map((a) => `<path class="arc" d="M16 6.5a9.5 9.5 0 0 1 8.2 4.7" stroke="url(#mk)" stroke-width="2.6" stroke-linecap="round" fill="none" transform="rotate(${a} 16 16)" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/>`).join('')}
    <circle id="mdot" cx="16" cy="16" r="3" fill="#5ce1e6"/></svg>`,
  );
  const arcs = [...markSvg.querySelectorAll('.arc')];
  const mdot = markSvg.querySelector('#mdot');
  const name = el('div', 'name', end, 'Agent Ops');
  const tag1 = el('div', 'tag1', end, 'Your AI team, on your machine.');
  const tag2 = el('div', 'tag2', end, 'Tasks are files in git.');
  const ver = el('div', 'ver', end, `Windows beta · ${P.version}`);

  // ---------- background particles ----------
  const PART = Array.from({ length: 90 }, (_, i) => ({
    x: rnd(i) * W,
    y: rnd(i + 100) * H,
    vx: (rnd(i + 200) - 0.5) * 14,
    vy: -6 - rnd(i + 300) * 12,
    r: 0.6 + rnd(i + 400) * 1.6,
    a: 0.12 + rnd(i + 500) * 0.3,
  }));
  const drawBg = (time, boost) => {
    const t = window.PROMO_STILL_BG ? 0 : time;
    bgx.clearRect(0, 0, W, H);
    for (const p of PART) {
      const x = (((p.x + p.vx * t) % W) + W) % W;
      const y = (((p.y + p.vy * t) % H) + H) % H;
      bgx.fillStyle = `rgba(150,220,230,${p.a * (0.6 + 0.4 * boost)})`;
      bgx.beginPath();
      bgx.arc(x, y, p.r, 0, Math.PI * 2);
      bgx.fill();
    }
  };

  const typed = (text, t, t0, t1) => {
    const n = Math.round(text.length * clamp((t - t0) / (t1 - t0)));
    return text.slice(0, n);
  };
  const caretOn = (t, typing) => typing || (t * 2) % 1 < 0.55;

  // ---------- render ----------
  window.render = (t, frame = 0) => {
    // A near-black pixel at (0, 0) that names the frame, so the renderer can tell a stale paint.
    sync.style.background = `rgb(${frame & 31}, ${(frame >> 5) & 31}, ${(frame >> 10) & 31})`;
    C = cam(t);
    g.clearRect(0, 0, W, H);
    drawBg(t, env(t, 7.2, 8.2, 22, 22.6) + env(t, 29, 30, 40, 41));

    // Cold open.
    const coldText = 'You have one idea.';
    const ct = typed(coldText, t, 0.3, 1.25);
    const coldOut = seg(t, 1.55, 2.05);
    cold.innerHTML = `${ct}<span class="caret" style="opacity:${caretOn(t, t < 1.3) ? 1 : 0}"></span>`;
    css(cold, {
      transform: `translateY(${-70 * E.inOut3(coldOut)}px)`,
      letterSpacing: `${0.01 + 0.06 * coldOut}em`,
    });
    vis(cold, (1 - coldOut) * seg(t, 0.05, 0.3));

    // Window and camera.
    win.style.transform = `translate(${C.x - 800}px, ${C.y - 480}px) rotateX(${C.rx}deg) scale(${C.s})`;
    vis(win, C.o);

    // Chat: empty, typing, sent, the PM's answer streams in.
    const MSG = 'Break the holiday sale into tasks.';
    const typing = t >= 2.4 && t < 3.6;
    const sent = 3.75;
    vis(shot.chat0, 1 - seg(t, sent, sent + 0.25));
    vis(shot.chatbg, seg(t, sent, sent + 0.25) * (1 - seg(t, 5.85, 6.35)));
    composerText.innerHTML =
      t < sent
        ? `${typed(MSG, t, 2.4, 3.55)}<span class="caret" style="opacity:${t > 2.3 && caretOn(t, typing) ? 1 : 0}"></span>`
        : '';
    vis(composerPatch, t > 2.38 && t < sent + 0.3 ? 1 : 0);
    vis(composerText, 1 - seg(t, sent, sent + 0.12));
    vis(sendGlow, env(t, sent - 0.08, sent, sent + 0.05, sent + 0.4));
    const up = E.out3(seg(t, sent + 0.05, sent + 0.45));
    vis(userPiece, up * (1 - seg(t, 5.6, 5.95)));
    userPiece.style.transform = `translateY(${18 * (1 - up)}px)`;
    const rev = seg(t, 4.35, 5.2);
    pmWrap.style.height = `${pmR.h * E.inOut3(rev) + (rev > 0 ? 4 : 0)}px`;
    pmWrap.style.webkitMaskImage =
      rev < 1 ? 'linear-gradient(#000 calc(100% - 28px), transparent)' : 'none';
    vis(pmWrap, seg(t, 4.3, 4.4) * (1 - seg(t, 5.6, 5.95)));

    // Board.
    const boardOp = seg(t, 5.8, 6.4);
    vis(shot.chrome, boardOp);
    vis(boardL, boardOp);
    const at = boardAt(t);
    const stNow = at.tr ? (at.p < 0.5 ? ST[at.tr.from] : ST[at.tr.to]) : ST[at.key];
    const stCounts = stNow === ST.chat ? ST.b1 : stNow;
    for (const k of Object.keys(badges)) badges[k].textContent = String(stCounts.counts[k] ?? 0);
    subtitle.textContent = stCounts.subtitle;
    const items = renderBoard(t < 22.7 ? t : -1, boardOp);

    // Chips glow before the flight.
    const chipGlow = env(t, 5.1, 5.35, 5.6, 6.0);
    if (chipGlow > 0) {
      for (const id of created) {
        const r = chips[id];
        const [x0, y0] = proj(r.x, r.y);
        g.save();
        g.shadowColor = '#5ce1e6';
        g.shadowBlur = 24;
        g.strokeStyle = hexA('#5ce1e6', chipGlow);
        g.lineWidth = 2;
        roundRect(x0 - 3, y0 - 3, r.w * C.s + 6, r.h * C.s + 6, 7);
        g.stroke();
        g.restore();
      }
    }

    // Nodes.
    const nodesOn = 1 - seg(t, 22.1, 22.5);
    const liveAgents = stNow.liveAgents ?? new Map();
    const acting = new Set();
    for (const it of items) {
      if (it.kind === 'beam' && it.tr.kind !== 'fly') acting.add(it.actor);
    }
    for (const n of NODES) {
      const wake = 7.35 + n.i * 0.1;
      const q = seg(t, wake, wake + 0.45);
      const humanLate = n.id === 'human:you' ? 1 : 1;
      vis(n.e, clamp(q * 1.5) * nodesOn * humanLate);
      n.e.style.transform = `scale(${0.5 + 0.5 * E.outBack(q)})`;
      const on = acting.has(n.id) || (n.id === 'human:you' && t > 15.0 && t < 17.6);
      const isLive = liveAgents.has(n.id) && t > 8.3;
      const glowA = on ? 0.9 : isLive ? 0.45 : 0.15;
      n.ring.style.boxShadow = `inset 0 0 0 2px ${hexA(n.w.prov, on || isLive ? 0.95 : 0.45)}, 0 0 ${on ? 46 : 26}px ${hexA(n.w.prov, glowA)}`;
      const pq = (t * 0.8 + n.i * 0.37) % 1;
      n.pulse.style.boxShadow = `0 0 0 2px ${hexA(n.w.prov, isLive ? 0.7 * (1 - pq) : 0)}`;
      n.pulse.style.transform = `scale(${1 + 0.55 * pq})`;
      n.state.innerHTML = isLive
        ? `<span style="color:#3ddc97">● live</span> · <span style="font-family:'JetBrains Mono';color:#b4bccb">${liveAgents.get(n.id) ?? ''}</span>`
        : '';
    }

    // Beams from agents to the cards they move.
    for (const it of items) {
      if (it.kind !== 'beam' || it.tr.kind === 'fly') continue;
      const n = nodeOf(it.actor);
      const a = seg(it.lp, -0.2, 0.12) * (1 - seg(it.lp, 0.88, 1.0));
      const nx = n.x + (n.x < 960 ? 46 : -46);
      beam(nx, n.y, it.sx, it.sy, n.w.prov, a * nodesOn, (t * 1.4) % 1);
    }

    // Landings: bursts, pills, and reviewer hand-offs.
    let pi = 0;
    for (const tr of TR) {
      for (const [id, a] of tr.acts) {
        const m = meaning(tr, id, a.actor);
        if (!m) continue;
        const tl = landAt(tr, id);
        if (t < tl - 0.1 || t > tl + 1.6) continue;
        const r = ST[tr.to].cards[id];
        const [cx, cy] = proj(r.x + r.w / 2, r.y + r.h / 2);
        burst(cx, cy, m.color, seg(t, tl - 0.04, tl + 0.7));
        if (m.who && tr.kind !== 'fly' && ST[tr.to].cards[id].col === 'review') {
          const n = nodeOf(m.who);
          const ha = env(t, tl, tl + 0.2, tl + 0.9, tl + 1.2);
          beam(cx, cy, n.x + (n.x < 960 ? 46 : -46), n.y, '#b18cff', ha * 0.8, (t * 1.4) % 1);
        }
        const pe = pill(pi++);
        const next = TR[TR.indexOf(tr) + 1];
        const until = Math.min(tl + 1.3, next ? next.t0 + 0.15 : 99);
        const pa =
          tr.kind === 'fly'
            ? 0
            : env(t, tl - 0.02, tl + 0.18, until - 0.3, until) *
              (1 - env(t, 14.9, 15.05, 17.3, 17.5));
        const [px, py] = proj(r.x + r.w, r.y);
        pe.textContent = m.text;
        css(pe, {
          left: `${px - 4}px`,
          top: `${py - 8}px`,
          color: m.color,
          boxShadow: `inset 0 0 0 1.5px ${hexA(m.color, 0.7)}, 0 8px 30px rgba(0,0,0,0.5), 0 0 24px ${hexA(m.color, 0.25)}`,
          transform: `translate(-100%, -100%) scale(${0.85 + 0.15 * E.outBack(seg(t, tl - 0.02, tl + 0.25))})`,
          transformOrigin: '100% 100%',
          zIndex: String(pi),
        });
        vis(pe, pa);
      }
    }
    for (let i = pi; i < pillPool.length; i++) vis(pillPool[i], 0);

    // HUD.
    const hudOn = seg(t, 7.6, 8.1) * (1 - seg(t, 22.1, 22.5));
    vis(hud, hudOn);
    hud.style.transform = `translateY(${-14 * (1 - E.out3(seg(t, 7.6, 8.1)))}px)`;
    const sA = at.tr ? ST[at.tr.from] : stNow;
    const sB = at.tr ? ST[at.tr.to] : stNow;
    const hp = at.tr ? E.inOut3(at.p) : 1;
    hudLive.textContent = String(Math.round(lerp(sA.live, sB.live, hp)));
    hudLive.style.color = '#3ddc97';
    hudTok.textContent = `${Math.round(lerp(sA.tokens, sB.tokens, hp) / 1000)}k`;
    hudTok.style.color = '#5ce1e6';
    hudRuns.textContent = String(Math.round(lerp(sA.runs, sB.runs, hp)));

    // Captions.
    let capOn = 0;
    for (const [a, b, k, l] of CAPS) {
      const o = env(t, a, a + 0.35, b - 0.3, b);
      if (o > 0) {
        capKick.textContent = k;
        capLine.textContent = l;
        capOn = o;
        caption.style.transform = `translateY(${10 * (1 - E.out3(seg(t, a, a + 0.4)))}px)`;
      }
    }
    vis(caption, capOn);

    // Inbox: the question, typed answer, one click.
    const inOn = seg(t, 14.95, 15.4);
    const inOut = seg(t, 17.0, 17.45);
    vis(dim, 0.9 * inOn * (1 - inOut));
    const sc0 = 1.32;
    const qx = 960 - (qr.w * sc0) / 2;
    const qy = 560 - (qr.h * sc0) / 2;
    const wh = ST.b6.cards[T.webhook];
    const [wx, wy] = proj(wh.x + wh.w / 2, wh.y + wh.h / 2);
    const enter = E.outBack(inOn, 1.3);
    const fly = E.inOut3(inOut);
    const sc = lerp(sc0 * (0.9 + 0.1 * enter), 0.18, fly);
    const ix = lerp(qx + (qr.w * sc0 * (1 - (0.9 + 0.1 * enter))) / 2, wx - (qr.w * 0.18) / 2, fly);
    const iy = lerp(qy + 40 * (1 - inOn), wy - (qr.h * 0.18) / 2, fly);
    inbox.style.transform = `translate(${ix}px, ${iy}px) scale(${sc})`;
    vis(inbox, inOn * (1 - seg(t, 17.25, 17.45)));
    const ansT = typed(ANSWER, t, 15.75, 16.55);
    inboxText.innerHTML = `${ansT}<span class="caret" style="opacity:${t > 15.65 && t < 16.85 && caretOn(t, t < 16.55) ? 1 : 0}"></span>`;
    vis(inboxPatch, t > 15.7 ? 1 : 0);
    vis(ansFlash, env(t, 16.86, 16.9, 16.98, 17.25));
    // Cursor: in from the corner, to the answer box, then to Answer.
    const toBox = [qx + (ita.x - qr.x + 60) * sc0, qy + (ita.y - qr.y + 30) * sc0];
    const toBtn = [qx + (ab.x - qr.x + ab.w * 0.55) * sc0, qy + (ab.y - qr.y + ab.h * 0.6) * sc0];
    const c1p = E.inOut3(seg(t, 15.3, 15.68));
    const c2p = E.inOut3(seg(t, 16.55, 16.85));
    const cx = lerp(lerp(1560, toBox[0], c1p), toBtn[0], c2p);
    const cy = lerp(lerp(960, toBox[1], c1p), toBtn[1], c2p);
    const press = env(t, 16.86, 16.9, 16.95, 17.05);
    cursor.style.transform = `translate(${cx}px, ${cy}px) scale(${1 - 0.18 * press})`;
    vis(cursor, seg(t, 15.25, 15.4) * (1 - seg(t, 17.05, 17.2)));

    // Merge checks after the approval.
    const pr = ST.b9.cards[T.prices];
    const [mx, my] = proj(pr.x, pr.y);
    const mOn = env(t, 20.45, 20.75, 22.1, 22.4);
    vis(merge, mOn);
    css(merge, {
      left: `${mx - 424}px`,
      top: `${my - 6}px`,
      transform: `translateX(${20 * (1 - E.out3(seg(t, 20.45, 20.8)))}px)`,
    });
    rows.forEach((r, i) => {
      const t0 = 20.75 + i * 0.25;
      const st = t < t0 ? 'wait' : t < t0 + 0.22 ? 'spin' : 'ok';
      if (st === 'spin') r.ic.innerHTML = spin((t * 900) % 360);
      else if (r.state !== st) r.ic.innerHTML = ICON[st];
      r.state = st;
      r.r.style.color = st === 'ok' ? '#e7eaf0' : '#7f8899';
    });
    const merged = seg(t, 22.0, 22.15);
    mergeDone.innerHTML =
      merged > 0
        ? `<span style="color:#3ddc97;font-family:'Chakra Petch';font-weight:700;font-size:18px;letter-spacing:0.04em">MERGED</span>`
        : '&nbsp;';
    if (t > 21.95 && t < 22.7) {
      burst(mx - 224, my + 260, '#3ddc97', seg(t, 22.0, 22.6));
    }

    // Montage of real screens.
    let mc = '';
    let mcO = 0;
    for (const m of MONT) {
      const pin = E.out5(seg(t, m.t0, m.t0 + 0.45));
      const pout = E.inOut3(seg(t, m.t1 - 0.35, m.t1));
      const life = seg(t, m.t0, m.t1);
      const x = 1200 * (1 - pin) - 1300 * pout;
      const ry = -32 * (1 - pin) + 30 * pout;
      const s = 0.8 + 0.035 * life;
      m.p.style.transform = `perspective(2000px) translateX(${x}px) rotateY(${ry}deg) scale(${s})`;
      vis(m.p, t > m.t0 && t < m.t1 ? Math.min(1, pin * 1.4) * (1 - pout * 0.7) : 0);
      m.sh.style.transform = `scale(${1 + 0.16 * E.inOut3(seg(t, m.t0 + 0.2, m.t1))})`;
      const o = env(t, m.t0 + 0.15, m.t0 + 0.45, m.t1 - 0.35, m.t1 - 0.1);
      if (o > mcO) {
        mcO = o;
        mc = m.text;
      }
    }
    mcap.textContent = mc;
    vis(mcap, mcO);

    // Stats.
    const stOn = env(t, 26.6, 26.9, 28.75, 29.05);
    vis(stats, stOn);
    vis(statkick, stOn);
    STATS.forEach((s, i) => {
      const t0 = 26.65 + i * 0.12;
      const q = seg(t, t0, t0 + 0.4);
      s.e.style.transform = `translateY(${40 * (1 - E.out3(q))}px) scale(${0.94 + 0.06 * E.out3(q)})`;
      s.e.style.opacity = String(q);
      s.nEl.textContent = String(Math.round(s.n * E.outExpo(seg(t, t0 + 0.1, t0 + 1.1))));
    });

    // End card.
    const eOn = seg(t, 29.0, 29.3);
    vis(end, eOn);
    arcs.forEach((a, i) =>
      a.setAttribute(
        'stroke-dashoffset',
        String(1 - E.out3(seg(t, 29.05 + i * 0.07, 29.6 + i * 0.07))),
      ),
    );
    mdot.setAttribute('r', String(3 * E.outBack(seg(t, 29.5, 29.85), 2.5)));
    markSvg.style.transform = `scale(${0.85 + 0.15 * E.out3(seg(t, 29.0, 29.7))}) rotate(${-30 * (1 - E.out3(seg(t, 29.0, 29.8)))}deg)`;
    const nq = E.out3(seg(t, 29.35, 29.95));
    name.style.opacity = String(nq);
    name.style.letterSpacing = `${0.32 - 0.22 * nq}em`;
    for (const [e, a] of [
      [tag1, 29.75],
      [tag2, 29.95],
      [ver, 30.2],
    ]) {
      const q = E.out3(seg(t, a, a + 0.45));
      e.style.opacity = String(q);
      e.style.translate = `0 ${16 * (1 - q)}px`;
    }
    if (eOn > 0) {
      const glow = g.createRadialGradient(960, 330, 0, 960, 330, 520);
      glow.addColorStop(0, `rgba(92,225,230,${0.1 * eOn})`);
      glow.addColorStop(1, 'rgba(92,225,230,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
    }
  };

  // Ready once every capture is decoded and the fonts are loaded.
  const names = [
    'chat0',
    'chat1',
    'chatbg',
    'chrome',
    'inbox',
    'runs',
    'task',
    'activity',
    ...STATES,
  ];
  window.promoReady = Promise.all([
    document.fonts.ready,
    ...names.map(async (n) => {
      const img = new Image();
      img.src = `${A}/${n}.png`;
      await img.decode();
      BM[n] = await createImageBitmap(img);
    }),
    ...['500', '600', '700'].map((w) => document.fonts.load(`${w} 20px "Chakra Petch"`)),
    document.fonts.load('500 20px "IBM Plex Sans"'),
    document.fonts.load('400 20px "IBM Plex Sans"'),
    document.fonts.load('600 20px "JetBrains Mono"'),
  ]).then(() => {
    for (const { cv, name: n, r } of filled) {
      cv.getContext('2d').drawImage(
        BM[n],
        r.x * 2,
        r.y * 2,
        r.w * 2,
        r.h * 2,
        0,
        0,
        cv.width,
        cv.height,
      );
    }
    window.render(0);
    return true;
  });
})();
