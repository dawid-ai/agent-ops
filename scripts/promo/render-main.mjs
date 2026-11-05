// Electron main that renders scripts/promo/index.html frame by frame, offscreen, at 1920x1080.
// Time never comes from the clock: each frame calls the page's render(t), waits for the paint of
// that state and pipes the raw pixels to ffmpeg (PROMO_MP4), or writes PNG stills (PROMO_STILLS,
// a comma list of seconds, into <PROMO_ASSETS>/stills/).
import { app, BrowserWindow, nativeImage } from 'electron';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assets = process.env.PROMO_ASSETS;
const stills = (process.env.PROMO_STILLS ?? '').split(',').filter(Boolean);
const mp4 = process.env.PROMO_MP4 ?? '';
// A second pass for the GIF: fewer frames, a still background (drifting particles change every
// pixel row, which a GIF pays for in every frame), scaled to 1200 px, nearly lossless.
const gifSrc = process.env.PROMO_GIF_SRC ?? '';
const gifFps = Number(process.env.PROMO_GIF_FPS ?? '20');
// The GIF is a cut: a full-motion GIF of the whole video would be far too large for a README.
const gifFrom = Number(process.env.PROMO_GIF_FROM ?? '0');
const gifTo = Number(process.env.PROMO_GIF_TO ?? '0');
const W = 1920;
const H = 1080;
const FPS = 60;

app.commandLine.appendSwitch('force-color-profile', 'srgb');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(60);
  let last = null;
  win.webContents.on('paint', (_e, _dirty, image) => {
    last = image;
  });
  win.webContents.on('console-message', (e) => console.log(`[page] ${e.message}`));
  await win.loadFile(join(here, 'index.html'), {
    query: { assets: pathToFileURL(assets).href },
  });
  const exec = (js) => win.webContents.executeJavaScript(js, true);
  await exec('window.promoReady');
  const duration = await exec('window.DURATION');

  // The page marks each frame in its top-left pixel; a paint counts only once it shows that mark.
  let serial = 0;
  const frame = async (t) => {
    const id = ++serial;
    await exec(`window.render(${t}, ${id})`);
    const want = [id & 31, (id >> 5) & 31, (id >> 10) & 31];
    for (let i = 0; i < 400; i++) {
      win.webContents.invalidate();
      await sleep(i < 4 ? 2 : 8);
      const px = last && last.toBitmap().subarray(0, 4);
      // The bitmap is BGRA.
      if (px && px[2] === want[0] && px[1] === want[1] && px[0] === want[2]) break;
      if (i === 399) console.error(`  frame at ${t} s: no paint with its mark`);
    }
    let img = last;
    const s = img.getSize();
    if (s.width !== W || s.height !== H) img = img.resize({ width: W, height: H, quality: 'best' });
    // The mark has done its job: give the corner pixel its neighbour's color.
    const buf = Buffer.from(img.toBitmap());
    buf.copy(buf, 0, 4, 8);
    return buf;
  };
  const png = (buf) => nativeImage.createFromBitmap(buf, { width: W, height: H }).toPNG();
  /** Streams frames at `fps` to ffmpeg with `args` after the raw input. */
  const encode = async (fps, args, label, from = 0, to = duration) => {
    const ff = spawn(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'bgra',
        '-s',
        `${W}x${H}`,
        '-r',
        String(fps),
        '-i',
        '-',
        ...args,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true },
    );
    const done = new Promise((r) => ff.on('exit', r));
    const total = Math.round((to - from) * fps);
    const started = Date.now();
    for (let i = 0; i < total; i++) {
      const buf = await frame(from + i / fps);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % (fps * 4) === 0) {
        console.log(
          `  ${label}: frame ${i}/${total} (${((Date.now() - started) / 1000).toFixed(0)} s)`,
        );
      }
    }
    ff.stdin.end();
    const code = await done;
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
  };

  if (stills.length) {
    mkdirSync(join(assets, 'stills'), { recursive: true });
    for (const t of stills) {
      writeFileSync(join(assets, 'stills', `${t}.png`), png(await frame(Number(t))));
    }
  }
  try {
    if (mp4) {
      await encode(
        FPS,
        [
          '-c:v',
          'libx264',
          '-preset',
          'slow',
          '-crf',
          '21',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          mp4,
        ],
        'mp4',
      );
    }
    if (gifSrc) {
      await exec('window.PROMO_STILL_BG = true');
      await encode(
        gifFps,
        [
          '-vf',
          'scale=1200:-2:flags=lanczos',
          '-c:v',
          'libx264rgb',
          '-qp',
          '0',
          '-preset',
          'ultrafast',
          gifSrc,
        ],
        'gif',
        gifFrom,
        gifTo || duration,
      );
    }
  } catch (e) {
    console.error(e.message);
    app.exit(1);
    return;
  }
  app.exit(0);
});
