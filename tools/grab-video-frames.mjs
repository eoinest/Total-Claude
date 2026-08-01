#!/usr/bin/env node
/**
 * Sample still frames from a YouTube video for local visual reference.
 *
 * We hold no `yt-dlp` or `ffmpeg`, and rather than install either this drives the page with
 * Playwright — which is already trusted in this repo — seeks the HTML5 `<video>` element to a
 * list of timestamps, and screenshots the element's own bounding box. Nothing is downloaded
 * except the frames the player was already going to draw, and the video file itself is never
 * fetched or stored.
 *
 * Frames land under `reference/`, which is gitignored, exactly like the Rome II press plates
 * and the museum photographs. They are local comparison material and are never redistributed,
 * never shipped, and never committed.
 *
 * **These are for design and layout reference, not for a blind render-quality deck.** A
 * computer-generated architectural reconstruction is a different class of renderer with
 * different goals — very likely offline-rendered, with no real-time budget, no crowd, and its
 * own art direction. Mixing it into the Rome II deck would repeat a mistake already made and
 * caught twice on this project: Rome Remastered frames would have lowered the bar and flattered
 * us, Total War: Pharaoh frames would have raised it unfairly. Provenance decides deck safety.
 * Use this to answer "does our city read like a city", not "is our renderer as good".
 *
 * **Sample near where the player starts, and move the start with `&t=`.** This is the third
 * real trap and it cost an afternoon. Seeking works for the first frame or two of a fresh
 * page and then the player hands back a black rectangle for ever — the *same* rectangle,
 * 18,738 bytes at quality 92, whatever timestamp is asked for. It survives `seeked`, two
 * `requestVideoFrameCallback` presentations, a retry two seconds further on, and a page that
 * is otherwise perfectly healthy. What does work is loading the watch URL with `&t=NNNs` so
 * the player *begins* there and grabbing within twenty seconds of that point. So sample a
 * long video as several short runs with `--append`, one per start position:
 *
 *   for T in 75 150 220 300 370 450 520; do
 *     node tools/grab-video-frames.mjs --url="<watch url>&t=${T}s" --out=reference/rome3d \
 *       --append --start=$((T+4)) --end=$((T+16)) --count=2
 *   done
 *
 * A single-position run is the simple case:
 *
 *   node tools/grab-video-frames.mjs --url=<watch url> --out=reference/rome3d \
 *     --start=60 --end=1500 --count=24
 */

import { chromium } from 'playwright';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const URL_IN = args.get('url');
const OUT = args.get('out') ?? 'reference/video';
const START = Number(args.get('start') ?? 30);
const END = Number(args.get('end') ?? 0);
const COUNT = Number(args.get('count') ?? 24);
const WIDTH = Number(args.get('width') ?? 1920);
/** Below this a JPEG of a lit scene cannot exist; see the black-frame retry. */
const MIN_BYTES = Number(args.get('minbytes') ?? 40000);

if (!URL_IN) {
  console.error('usage: grab-video-frames.mjs --url=<watch url> [--out=dir] [--start=s] [--end=s] [--count=n]');
  process.exit(2);
}

const outAbs = path.resolve(ROOT, OUT);
// `--append` exists because of the two-seeks-then-black failure below: the reliable way to
// get twelve frames out of this player is six runs of two, each with a fresh page, and a
// tool that wipes its output directory on start cannot be used that way.
if (!args.has('append')) await rm(outAbs, { recursive: true, force: true });
await mkdir(outAbs, { recursive: true });

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({
  viewport: { width: WIDTH, height: Math.round((WIDTH * 9) / 16) },
  deviceScaleFactor: 1,
});

console.log(`• loading ${URL_IN}`);
await page.goto(URL_IN, { waitUntil: 'domcontentloaded', timeout: 90000 });

// Consent interstitials vary by region and block the player entirely when they appear.
for (const sel of ['button[aria-label*="Accept"]', 'button[aria-label*="accept"]',
  'form[action*="consent"] button', 'button:has-text("Accept all")']) {
  const el = await page.$(sel).catch(() => null);
  if (el) { await el.click().catch(() => {}); console.log(`• dismissed consent (${sel})`); break; }
}

await page.waitForSelector('video', { timeout: 60000 });
await page.waitForFunction(() => {
  const v = document.querySelector('video');
  return v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 0;
}, null, { timeout: 90000 });

// Strip the chrome so a frame is the picture and nothing else.
await page.addStyleTag({
  content: `
    .ytp-chrome-top, .ytp-chrome-bottom, .ytp-gradient-top, .ytp-gradient-bottom,
    .ytp-ce-element, .ytp-cued-thumbnail-overlay, .ytp-spinner, .ytp-pause-overlay,
    .ytp-watermark, .annotation, #movie_player .caption-window { display: none !important; }
    video::-webkit-media-controls { display: none !important; }
  `,
});

const duration = await page.evaluate(() => document.querySelector('video').duration);
const end = END > 0 ? Math.min(END, duration - 2) : duration - 2;
const start = Math.max(1, Math.min(START, end - 1));
console.log(`• duration ${duration.toFixed(0)}s, sampling ${COUNT} frames from ${start}s to ${end.toFixed(0)}s`);

/**
 * Seek and wait until the compositor has actually *presented* a frame at the new time.
 *
 * Three things go wrong with the naive `currentTime = t; await 'seeked'` and all three were
 * visible in the first run of this tool: two byte-identical captures 20 s apart, and one
 * frame that came back at t=0. `seeked` fires when the media element has updated its
 * position, not when a decoded frame has been painted, so a screenshot taken immediately
 * after it captures whatever was on screen before — usually the previous sample. And
 * seeking a *paused* element past the buffered range can drop the position back to zero
 * rather than buffering forward.
 *
 * So: keep it playing across the seek so the decoder is running, then wait on
 * `requestVideoFrameCallback`, which fires with the presentation time of a frame that has
 * genuinely been handed to the compositor, and only then pause and shoot.
 */
async function seekAndSettle(page, target) {
  return page.evaluate(async (t) => {
    const v = document.querySelector('video');
    const player = document.getElementById('movie_player');
    if (player && player.classList.contains('ad-showing')) return { ad: true };
    v.muted = true;
    // Playing across the seek: a paused element asked for a position outside its buffer
    // can reset to zero instead of buffering forward.
    try { await v.play(); } catch { /* autoplay policy already relaxed by a launch flag */ }
    v.currentTime = t;
    await new Promise((res) => {
      const done = () => { v.removeEventListener('seeked', done); res(); };
      v.addEventListener('seeked', done);
      setTimeout(res, 10000);
    });
    // Wait for a genuinely presented frame rather than for the seek to be acknowledged.
    if (v.requestVideoFrameCallback) {
      await new Promise((res) => {
        let n = 0;
        const tick = () => { if (++n >= 2) res(); else v.requestVideoFrameCallback(tick); };
        v.requestVideoFrameCallback(tick);
        setTimeout(res, 4000);
      });
    } else {
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    }
    v.pause();
    await new Promise((res) => requestAnimationFrame(res));
    return { ad: false, at: v.currentTime, w: v.videoWidth, h: v.videoHeight };
  }, target);
}

/** Explicit timestamps beat uniform sampling when you know where the good material is. */
const explicit = args.has('times')
  ? String(args.get('times')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
  : null;
const targets = explicit ?? Array.from({ length: COUNT }, (_, i) =>
  start + ((end - start) * i) / Math.max(1, COUNT - 1));

/**
 * **Seeking works exactly twice, and then the player hands you black for ever.**
 *
 * Measured across four runs on two different days: the first two samples come back as real
 * pictures and every one after that is a near-black rectangle — the *same* near-black
 * rectangle, byte for byte, whatever timestamp is asked for. It survives `seeked`, it
 * survives two `requestVideoFrameCallback` presentations, it survives a retry two seconds
 * further on, and it is not a fade in the source. Something in the player's state machine
 * stops repainting the surface after a couple of programmatic seeks.
 *
 * So `--play` does not seek at all after the first one. It sets `playbackRate`, lets the
 * video run, and screenshots as the clock passes each target. Slower — real time divided by
 * the rate — but it is the mode that actually returns pictures, and for layout reference a
 * frame grabbed in motion is as good as one grabbed paused.
 */
const PLAY = args.has('play');
const RATE = Number(args.get('rate') ?? 2);
if (PLAY) {
  await seekAndSettle(page, Math.max(1, targets[0] - 3));
  await page.evaluate((r) => {
    const v = document.querySelector('video');
    v.muted = true;
    v.playbackRate = r;
    void v.play();
  }, RATE);
  console.log(`• playing through at ${RATE}x rather than seeking (see the note above)`);
}

const manifest = [];
const seen = new Set();
for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  let state = null;
  if (PLAY) {
    try {
      await page.waitForFunction((tt) => document.querySelector('video').currentTime >= tt, t, { timeout: 600000 });
    } catch {
      console.log(`  t=${t.toFixed(0)}s  never reached`);
      continue;
    }
    state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { ad: false, at: v.currentTime, w: v.videoWidth, h: v.videoHeight };
    });
  } else {
    // Retry: an ad, a buffering stall or a seek that landed nowhere near the ask.
    for (let attempt = 0; attempt < 3; attempt++) {
      state = await seekAndSettle(page, t);
      if (state.ad) { await page.waitForTimeout(6000); continue; }
      if (Math.abs(state.at - t) <= 2.5) break;
      await page.waitForTimeout(800);
    }
    if (!state || state.ad || Math.abs(state.at - t) > 2.5) {
      console.log(`  t=${t.toFixed(0)}s  skipped (landed at ${state ? state.at.toFixed(0) : '?'}s)`);
      continue;
    }
    await page.waitForTimeout(220);
  }

  const el = await page.$('video');
  const name = `frame-${String(i + 1).padStart(2, '0')}-t${Math.round(state.at)}s.jpg`;
  const file = path.join(outAbs, name);
  await el.screenshot({ path: file, type: 'jpeg', quality: 92 });

  /**
   * **The third trap: a settled frame can still be black.**
   *
   * `requestVideoFrameCallback` proves a frame reached the compositor; it says nothing about
   * whether that frame is *the video*. Two independent runs of this tool died in the same
   * place — two good frames, then every subsequent sample came back a near-black rectangle,
   * byte-for-byte identical across runs at different timestamps. The player is in a quality
   * switch or a fade, and rVFC happily reports the black one.
   *
   * A JPEG is a good detector for free: at quality 92 a 1344×756 frame of a lit city is
   * 100–200 kB and a black one is under 20 kB, because there is nothing for the DCT to
   * encode. So retry a suspiciously small capture a couple of seconds further on rather
   * than writing it. `--minbytes=0` disables the check if a genuinely dark shot is wanted.
   */
  let bytes = (await readFile(file)).length;
  for (let nudge = 1; nudge <= 3 && bytes < MIN_BYTES; nudge++) {
    if (PLAY) await page.waitForTimeout(1200);
    else if ((await seekAndSettle(page, t + nudge * 2.5)).ad) continue;
    else await page.waitForTimeout(260);
    await el.screenshot({ path: file, type: 'jpeg', quality: 92 });
    bytes = (await readFile(file)).length;
  }
  if (bytes < MIN_BYTES) {
    await rm(file, { force: true });
    console.log(`  t=${Math.round(state.at)}s  dropped (${(bytes / 1024).toFixed(0)} kB — a black frame, not a picture)`);
    continue;
  }

  // A duplicate byte-for-byte means the compositor never repainted; drop it rather than
  // hand a grader the same picture twice under two different timestamps.
  const digest = createHash('sha1').update(await readFile(file)).digest('hex');
  if (seen.has(digest)) {
    await rm(file, { force: true });
    console.log(`  t=${Math.round(state.at)}s  dropped (identical to an earlier frame)`);
    continue;
  }
  seen.add(digest);
  manifest.push({ file: name, atSeconds: Math.round(state.at), sourceW: state.w, sourceH: state.h });
  console.log(`  t=${Math.round(state.at)}s  ${name}  (source ${state.w}x${state.h})`);
}

// With `--append` the run only knows about its own frames, but SOURCES.md is the
// provenance record for the whole directory and has to list everything in it.
const onDisk = (await readdir(outAbs)).filter((f) => /^frame-.*\.jpg$/.test(f)).sort();
const listed = new Set(manifest.map((m) => m.file));
for (const f of onDisk) {
  if (listed.has(f)) continue;
  manifest.push({ file: f, atSeconds: Number((f.match(/-t(\d+)s/) ?? [, 0])[1]), sourceW: 0, sourceH: 0 });
}
manifest.sort((a, b) => a.atSeconds - b.atSeconds);

await writeFile(
  path.join(outAbs, 'SOURCES.md'),
  `# Video reference frames\n\n` +
    `Sampled from: ${URL_IN}\n\n` +
    `${manifest.length} frames, captured with \`tools/grab-video-frames.mjs\` by seeking the\n` +
    `page's own \`<video>\` element and screenshotting it. The video file was never downloaded.\n\n` +
    `**Local reference only.** \`reference/\` is gitignored; nothing here is committed, shipped\n` +
    `or redistributed.\n\n` +
    `**Not a blind render-quality target.** This is a computer-generated architectural\n` +
    `reconstruction — a different class of renderer, very likely offline, with no real-time\n` +
    `budget and no crowd. Putting it in a deck against our frames would repeat the Rome\n` +
    `Remastered and Total War: Pharaoh mistakes, which lowered and raised the bar respectively.\n` +
    `Use it for layout, massing, street proportion and how a Roman city reads — not for\n` +
    `judging our renderer.\n\n` +
    manifest.map((m) => `- \`${m.file}\` — t+${m.atSeconds}s${m.sourceW ? `, source ${m.sourceW}x${m.sourceH}` : ''}`).join('\n') +
    '\n'
);

console.log(`\n→ ${manifest.length} frames in ${path.relative(ROOT, outAbs)}`);
await browser.close();
