#!/usr/bin/env node
/**
 * film.mjs — the video design studio's runner. It reads a shot script and shoots it.
 *
 *   node tools/film.mjs tools/shots/aurelian-gate.shot.mjs --check     # validate, print the plan
 *   node tools/film.mjs tools/shots/aurelian-gate.shot.mjs --stills    # 3 frames a shot, to look at
 *   node tools/film.mjs tools/shots/aurelian-gate.shot.mjs             # the whole film
 *   node tools/film.mjs tools/shots/aurelian-gate.shot.mjs --shots=ram-push
 *   node tools/film.mjs tools/shots/aurelian-gate.shot.mjs --encode    # frames on disk -> webm
 *   node tools/film.mjs tools/shots/aurelian-gate.shot.mjs --json      # the resolved film, for a GUI
 *
 * The format lives in `docs/video/SHOT-FORMAT.md` and its validator in
 * `tools/lib/shot-format.mjs`. **You do not need to read this file to write a shot.** If you
 * are reading it because a script was refused, the refusal named the shot, the field, what you
 * gave and what is accepted, and the answer is in the doc.
 *
 * ---------------------------------------------------------------------------------------
 * What this is, and why it is a frame sequence rather than a screen recording
 * ---------------------------------------------------------------------------------------
 *
 * The same three reasons the shipped trailer is one, restated because they are the whole
 * design and a future maintainer will be tempted by `recordVideo`:
 *
 *   - **No dead air across a page load.** A film's scenes are fixed before `Engine` is
 *     constructed, so each costs a reload. Frames are addressed by name, so capture order and
 *     cut order are independent and eight seconds of loading screen never reach the film.
 *   - **Every frame is rendered and none are dropped.** The GPU is shared with other agents.
 *     A wall-clock recorder stutters wherever they happen to be busy.
 *   - **The clock is exact.** One captured frame is one `engine.advance(1/30, 1000/30)` — the
 *     same `Engine.frame()` the rAF loop calls, at the dt a player at 30 fps gets — with the
 *     rAF loop stopped and the clock driven by the capture. Playback at 30 fps is real time,
 *     and `simTime` is asserted against the plan on every frame of every shot. This project
 *     has shipped a battle that froze for sixteen minutes and photographed perfectly, so the
 *     clock is asserted, not assumed.
 *
 * ---------------------------------------------------------------------------------------
 * What it does not do
 * ---------------------------------------------------------------------------------------
 *
 * **No sound.** The mixer schedules against `AudioContext.currentTime`, so a capture that
 * steps two thousand frames in ninety seconds of wall clock would pile the whole film into
 * ninety seconds of nothing. The trailer solved that with a second wall-clock-paced pass over
 * the same fixed grid (`tools/scratch/trailer-audio-pass.mjs`); a shot script has no `audio`
 * field because implementing half of that would be worse than not having it. When it is added
 * it is a second runner over this same plan, not a change to the format.
 *
 * **It does not touch `src/`.** The camera is parked by replacing four `RTSCamera` curves for
 * the duration of a frame and putting them back on the next one; slow motion is the engine's
 * own `Time.paused`; fast motion is the engine's own `{ render: false }`. No simulation
 * behaviour changes and no pinned determinism hash moves.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import {
  FPS, EASINGS, ANCHORS, RAIL_FIELDS, STAGE, FINDERS,
  validateFilm, planFilm, railAt, frameState, provenance, ShotError,
} from './lib/shot-format.mjs';
import { PAGE_LIB, OVERLAY_HTML, SET_OVERLAY } from './lib/shot-page.mjs';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : ['@positional', a];
}));
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (args.has('help') || (!positional.length && !args.has('vocabulary'))) {
  console.log(`
tools/film.mjs — shoot a declarative shot script.

  node tools/film.mjs <script.shot.mjs|.json> [options]

  --check           validate and print the plan; no browser, no server, no frames
  --json[=path]     dump the resolved film as JSON (the read path for a GUI)
  --schedule        with --json, include the per-frame tick schedule
  --vocabulary      print every anchor, rail field, staging action and finder, and exit
  --stills          three frames a shot instead of all of them, to look at framing
  --shots=a,b       shoot a subset; the cut is still rebuilt from everything on disk
  --scenes=x,y      shoot only these scenes
  --encode          encode the frames already on disk and stop
  --noencode        capture only
  --keepframes      do not wipe the frame directory first (re-shoot one shot into a film)
  --nooverlay       no captions, no end card, no fades — clean plates
  --out=DIR         work directory (default /tmp/tc-video-studio)
  --port=N          vite port (default 5209). NEVER 5173: that is the owner's playtest server
  --keep            leave the vite server running afterwards
  --w= --h= --dpr=  override the film's frame size
  --scale=W:H       encoder output scale (default 1600:900); --scale= to keep native
  --quality=        override the film's quality tier

The format: docs/video/SHOT-FORMAT.md. Examples: tools/shots/.
`.trim());
  process.exit(positional.length ? 0 : 2);
}

if (args.has('vocabulary')) {
  const table = (title, obj, fmt) => {
    console.log(`\n## ${title}\n`);
    for (const [k, v] of Object.entries(obj)) console.log(`  ${k.padEnd(14)} ${fmt(v)}`);
  };
  table('track.kind (anchors)', ANCHORS, (v) => `[${v.frame}] ${v.desc}`);
  table('rail key fields', RAIL_FIELDS, (v) => `[${v.kind}${v.unit ? ` ${v.unit}` : ''}] ${v.desc}`);
  table('stage actions', STAGE, (v) => `${v.sim ? '[touches the battle] ' : '[camera only]     '}${v.desc}`);
  table('start.find predicates', FINDERS, (v) => `${v.args.length ? `(${v.args.join(', ')}) ` : ''}${v.desc}`);
  console.log(`\n## easings\n\n  ${Object.keys(EASINGS).join(', ')}\n`);
  process.exit(0);
}

const SCRIPT = path.resolve(ROOT, positional[0]);
const PORT = Number(args.get('port') ?? 5209);
const WORK_ROOT = path.resolve(ROOT, args.get('out') ?? '/tmp/tc-video-studio');
const STILLS = args.has('stills');
const ENCODE_ONLY = args.has('encode');
const NO_ENCODE = args.has('noencode');
const NO_OVERLAY = args.has('nooverlay');
const KEEP_FRAMES = args.has('keepframes');
const DPR = Number(args.get('dpr') ?? 1);
const SCALE = args.has('scale') ? args.get('scale') : '1600:900';
const FFMPEG = args.get('ffmpeg')
  ?? `${process.env.HOME}/Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac`;
const BITRATE = args.get('bitrate') ?? '1600k';
const CRF = args.get('crf') ?? '38';
const QMAX = args.get('qmax') ?? '58';

if (PORT === 5173) {
  console.error('refusing --port=5173: that is the owner\'s playtest server. Pick another.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Load and validate
// ---------------------------------------------------------------------------

let raw;
try {
  if (SCRIPT.endsWith('.json')) raw = JSON.parse(await readFile(SCRIPT, 'utf8'));
  else raw = (await import(pathToFileURL(SCRIPT).href)).default;
} catch (e) {
  console.error(`cannot load ${path.relative(ROOT, SCRIPT)}: ${e.message}`);
  process.exit(2);
}

let film;
let plan;
try {
  film = validateFilm(raw, { source: path.relative(ROOT, SCRIPT) });
  if (args.has('w')) film.width = Number(args.get('w'));
  if (args.has('h')) film.height = Number(args.get('h'));
  if (args.has('quality')) film.quality = args.get('quality');
  plan = planFilm(film);
} catch (e) {
  if (e instanceof ShotError) { console.error(`\n✗ ${e.message}\n`); process.exit(2); }
  throw e;
}

const W = film.width;
const H = film.height;
const WORK = path.join(WORK_ROOT, film.id);
const FRAMES = path.join(WORK, STILLS ? 'stills' : 'frames');
const OUT_WEBM = args.get('outfile') ?? path.join(WORK, `${film.id}.webm`);

const wantShots = args.has('shots') ? new Set(String(args.get('shots')).split(',')) : null;
const wantScenes = args.has('scenes') ? new Set(String(args.get('scenes')).split(',')) : null;
const selected = plan.shots.filter((s) => (!wantShots || wantShots.has(s.id)) && (!wantScenes || wantScenes.has(s.scene)));
if (wantShots) {
  const missing = [...wantShots].filter((id) => !plan.shots.some((s) => s.id === id));
  if (missing.length) { console.error(`no such shot(s): ${missing.join(', ')}`); process.exit(2); }
}
if (!selected.length) { console.error('nothing selected'); process.exit(2); }

const PROV = provenance(ROOT);

// ---------------------------------------------------------------------------
// --check / --json
// ---------------------------------------------------------------------------

const describeStart = (s) => (s.at !== null
  ? `t+${s.at}s`
  : `find ${s.find.find}${s.find.nth !== undefined ? `(${s.find.nth})` : s.find.n !== undefined ? `(${s.find.n})` : ''}${s.find.offset ? ` ${s.find.offset > 0 ? '+' : ''}${s.find.offset}s` : ''}`);

function printPlan() {
  console.log(`\n${plan.title}  [${plan.id}]  ${plan.source}`);
  console.log(`  ${plan.width}x${plan.height} @ ${FPS} fps, quality ${plan.quality}`);
  console.log(`  ${plan.shots.length} shot(s), ${plan.totalFrames} frames, ${plan.runtimeSeconds}s of film, `
    + `${plan.pageLoads} page load(s)`);
  console.log(`  ${plan.emergent ? 'emergent — nothing in this film is staged'
    : `STAGED — shots marked ✱${plan.stagedScenes.length ? `, and a custom order of battle in ${plan.stagedScenes.join(', ')}` : ''}`}`);
  console.log(`  tree ${PROV.srcHash.slice(0, 12)} at ${PROV.commit}${PROV.clean ? '' : ` +${PROV.dirty.length} uncommitted`}`);
  console.log('\n  scenes');
  for (const [id, s] of Object.entries(plan.scenes)) {
    console.log(`    ${id.padEnd(16)} ${s.map} / ${s.scenario} / vs ${s.enemy} / ${String(s.hour).padStart(4)}h / `
      + `seed ${s.seed} / ${s.unitSize}${s.armies ? ' / staged order of battle' : ''}`);
  }
  console.log('\n  cut');
  let acc = 0;
  for (const s of plan.shots) {
    const t0 = acc; acc += s.footageSeconds;
    const ticks = s.schedule.map((f) => f.ticks);
    const kinds = [...new Set(ticks)].sort();
    console.log(`    ${fmtTime(t0)}–${fmtTime(acc)}  ${s.id.padEnd(18)} ${s.scene.padEnd(14)} `
      + `${describeStart(s.start).padEnd(18)} ${String(s.frames).padStart(4)}f  sim ${s.simSeconds}s  `
      + `${s.track.spec.kind}/${s.track.mode}  ticks{${kinds.join(',')}}${s.staged.length ? `  ✱ ${s.staged.join(',')}` : ''}`);
    if (s.desc) console.log(`${' '.repeat(20)}${s.desc}`);
  }
  console.log(`\n  capture order (grouped by scene, ascending in sim time):`);
  console.log(`    ${plan.captureOrder.join(' -> ')}`);
  if (plan.shots.some((s) => s.start.find)) {
    console.log('    (a shot cut against an event sorts here by its `before` ceiling; the real order');
    console.log('     is settled after the scouting pass, when the cue has a number)');
  }
  console.log('');
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;

if (args.has('json')) {
  /*
   * The read path for an editor.
   *
   * The *normalised* shot is kept — rail keys with `lift` split into a base and an interpolable
   * offset, speed as keys, defaults filled in — because that is the thing a GUI would bind its
   * inspector to, and it round-trips: `film.mjs <that>.json` shoots it. The per-frame tick
   * schedule is dropped unless asked for, because it is 795 entries on a 26-second film and
   * `scheduleShot()` recomputes it from the shot in microseconds.
   */
  const full = args.has('schedule');
  const out = JSON.stringify({
    // The film itself is at the top level so this file *is* a shot script: hand it back to
    // `film.mjs` and it shoots. The validator is idempotent for exactly this reason.
    ...film,
    provenance: PROV,
    plan: {
      captureOrder: plan.captureOrder,
      pageLoads: plan.pageLoads,
      totalFrames: plan.totalFrames,
      runtimeSeconds: plan.runtimeSeconds,
      emergent: plan.emergent,
      stagedScenes: plan.stagedScenes,
      shots: plan.shots.map((s) => ({
        id: s.id, scene: s.scene, frames: s.frames, footageSeconds: s.footageSeconds,
        simSeconds: s.simSeconds, staged: s.staged,
        ...(full ? { schedule: s.schedule } : {}),
      })),
    },
  }, null, 1);
  const dest = args.get('json');
  if (dest === 'true') console.log(out);
  else { await writeFile(path.resolve(ROOT, dest), out); console.log(`→ ${dest}`); }
  process.exit(0);
}

if (args.has('check')) { printPlan(); process.exit(0); }

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

async function encode(listFile, outPath) {
  if (!existsSync(FFMPEG)) {
    console.error(`\n! no encoder at ${FFMPEG}. The frames are on disk; pass --ffmpeg=<path> or encode them elsewhere.`);
    return null;
  }
  const list = JSON.parse(await readFile(listFile, 'utf8'));
  if (!list.length) { console.error('! nothing to encode'); return null; }
  await mkdir(path.dirname(outPath), { recursive: true });
  const vf = SCALE ? ['-vf', `scale=${SCALE}:flags=lanczos`] : [];
  /*
   * VP8, because that is the only video encoder on this machine.
   *
   * Playwright ships a `--disable-everything` ffmpeg for `recordVideo`: `libvpx` and nothing
   * else — no VP9, no x264, no audio codec at all. The trailer's shipped VP9 and H.264 files
   * were built by `tools/scratch/trailer-encode.mjs` and `trailer-mp4-encode.mjs`, which drive
   * `WebCodecs` inside a browser page and mux with `webm-muxer` / `mp4-muxer`. Those two are
   * pure functions of a frame list, so they can be pointed at this tool's `cut.json` unchanged
   * when a film needs to ship rather than merely be looked at. This encoder is for looking at.
   */
  const ff = spawn(FFMPEG, [
    '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0',
    ...vf,
    '-c:v', 'libvpx', '-b:v', BITRATE, '-crf', CRF, '-qmin', '6', '-qmax', QMAX,
    '-quality', 'good', '-cpu-used', '2', '-auto-alt-ref', '1', '-lag-in-frames', '20',
    '-g', '150', '-threads', '6', '-pix_fmt', 'yuv420p', '-an',
    '-f', 'webm', outPath,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d.toString(); });
  const done = new Promise((ok, no) => {
    ff.on('exit', (c) => (c === 0 ? ok() : no(new Error(`ffmpeg exit ${c}\n${err.slice(-2000)}`))));
  });
  for (const f of list) {
    const buf = await readFile(f);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  const s = await stat(outPath);
  console.log(`\n→ ${outPath}  ${(s.size / 1e6).toFixed(2)} MB  ${list.length} frames  `
    + `${(list.length / FPS).toFixed(2)} s  ${SCALE || `${W}:${H}`}`);
  return s.size;
}

if (ENCODE_ONLY) {
  await encode(path.join(WORK, 'cut.json'), OUT_WEBM);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (await waitForServer(base, 1200)) {
  console.log(`• reusing the dev server already on ${PORT}`);
} else {
  /*
   * An isolated Vite cache, and this is a worktree trap rather than a nicety.
   *
   * Every agent worktree in this repository symlinks `node_modules` back to the main checkout,
   * and Vite's default `cacheDir` is `<pkgDir>/node_modules/.vite` — a *path*, resolved through
   * that symlink. So six agents on six branches share one dependency-optimiser cache and one
   * transform cache, and the failure that produces is the worst kind: a page that loads
   * perfectly while serving another branch's modules. `TC_VITE_CACHE_DIR` is read by
   * `vite.config.ts`; the directory is named for the port so two runs cannot collide either.
   */
  const cacheDir = path.join(WORK_ROOT, '.vite-cache', `p${PORT}`);
  await mkdir(cacheDir, { recursive: true });
  console.log(`• starting vite on ${PORT} (cache ${cacheDir})`);
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TC_NO_HMR: '1', TC_VITE_CACHE_DIR: cacheDir, FORCE_COLOR: '0' },
  });
  if (!(await waitForServer(base, 90000))) {
    console.error(`vite did not start on ${PORT}`);
    server.kill('SIGTERM');
    process.exit(1);
  }
}
const shutdown = () => { if (server && !args.has('keep')) server.kill('SIGTERM'); };

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

await mkdir(WORK, { recursive: true });
// Spotlight indexing a tree of agent frames once took this machine down: load 20 with zero
// node processes, `mds` at 76%, 9.3 GB across 287 directories. Every directory that will hold
// frames carries this marker from the moment it is created.
await writeFile(path.join(WORK, '.metadata_never_index'), '');
if (!KEEP_FRAMES && existsSync(FRAMES)) await rm(FRAMES, { recursive: true });
await mkdir(FRAMES, { recursive: true });

printPlan();
if (!PROV.clean) {
  console.log(`! ${PROV.dirty.length} uncommitted change(s) under src/. Frames are stamped with`);
  console.log(`  srcHash ${PROV.srcHash}, which is what Vite is actually serving — not with ${PROV.commit}.`);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage',
    '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

/**
 * The `?battle=` token, which is the only channel that carries a seed.
 *
 * `resolveConfig` reads `?map=`, `?scenario=`, `?enemy=`, `?quality=` and `?difficulty=`
 * separately, but there is no `?seed=` and there never has been: a seed only reaches the app
 * inside this token (`src/sim/battleConfig.ts:914`). Since a film without a pinned seed is not
 * reproducible, every scene goes through the token, and the loose parameters are passed *as
 * well* so that a URL printed in the manifest still reads.
 *
 * `sanitiseConfig` has the last word on the far side, which is why the hour and the weather are
 * re-applied on the live page below and *asserted*: a value the token asked for and the app
 * quietly declined would put two shots under two different suns with nothing to say so.
 */
const battleToken = (s) => {
  const cfg = {
    map: s.map,
    scenario: s.scenario,
    opponent: s.enemy === 'carthage' ? 2 : 1,
    unitSize: s.unitSize,
    difficulty: s.difficulty,
    timeOfDay: s.hour,
    seed: s.seed,
    ...(s.armies ?? {}),
  };
  return Buffer.from(JSON.stringify(cfg)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

let loadedScene = null;
let loadSerial = 0;
async function load(sceneId, { force = false } = {}) {
  if (loadedScene === sceneId && !force) return;
  const s = plan.scenes[sceneId];
  const q = s.quality ?? plan.quality;
  const url = `${base}/?harness=1&quality=${q}&w=${W}&h=${H}`
    + `&map=${s.map}&scenario=${s.scenario}&enemy=${s.enemy}&battle=${battleToken(s)}`;
  const t0 = Date.now();
  console.log(`\n• load ${sceneId} (#${++loadSerial})`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null,
    { timeout: 420000 });
  console.log(`  world ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  await page.addStyleTag({
    content: '#hud-root,#loading,#menu-root{display:none!important;visibility:hidden!important}',
  });
  const hudState = await page.evaluate(() => {
    const hud = window.__game?.engine?.context?.tryGet?.('hud');
    if (hud && hud.overlay) { hud.overlay.visible = false; return hud.overlay.visible === false ? 'hidden' : 'refused'; }
    return 'absent';
  });
  if (hudState === 'refused') throw new Error('the world overlay refused to hide; these frames would carry the interface');

  // Drive the clock ourselves. rAF frames interleaved with synthetic ones would make the step
  // between two captured frames depend on how busy the machine was.
  await page.evaluate(() => window.__game.engine.stop());

  // The hour again, on the live page, and asserted. `sanitiseConfig` is entitled to refuse what
  // the token asked for, and a silently ignored hour would put two shots under two suns.
  const gotHour = await page.evaluate((h) => {
    const sky = window.__game.engine.context.tryGet('sky');
    if (!sky?.setTimeOfDay) return null;
    sky.setTimeOfDay(h);
    return sky.timeOfDay;
  }, s.hour);
  if (gotHour === null || Math.abs(gotHour - s.hour) > 0.01) throw new Error(`scene ${sceneId}: hour ${s.hour} refused (got ${gotHour})`);

  if (s.weather) {
    const gotW = await page.evaluate((w) => {
      const vfx = window.__game.engine.context.tryGet('vfx');
      if (!vfx?.setWeather) return null;
      vfx.setWeather(w);
      return vfx.weatherKind;
    }, s.weather);
    if (gotW !== s.weather) throw new Error(`scene ${sceneId}: weather ${s.weather} refused (got ${gotW})`);
  }

  await page.evaluate(PAGE_LIB);
  await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), OVERLAY_HTML);
  await page.evaluate(`window.__tcOverlay = ${SET_OVERLAY.toString()}`);
  loadedScene = sceneId;
}

/** Where a shot's frames go, and the one place the naming is decided. */
const frameFile = (shotId, i) => path.join(FRAMES, `${shotId}-${String(i).padStart(5, '0')}.jpg`);

/** The overlay state for one frame. All absolute; nothing accumulates. */
function overlayFor(sh, i, n, isFirstInCut) {
  const o = { fade: 0, cap: 0, end: 0, url: 0 };
  if (NO_OVERLAY) return o;
  const u = n <= 1 ? 0 : i / (n - 1);
  if (sh.caption) {
    const fadeIn = Math.min(1, Math.max(0, (u - sh.caption.in) / 0.10));
    const fadeOut = Math.min(1, Math.max(0, (sh.caption.out - u) / 0.10));
    o.cap = Math.min(fadeIn, fadeOut);
    o.capText = sh.caption.text;
    o.capSub = sh.caption.sub;
  }
  if (sh.endcard) {
    o.end = Math.min(1, Math.max(0, (u - 0.05) / 0.15));
    o.url = Math.min(1, Math.max(0, (u - 0.26) / 0.13));
    o.fade = Math.max(0, (u - 0.90) / 0.10);
    o.endTitle = sh.endcard.title;
    o.endSub = sh.endcard.tagline;
    o.endUrl = sh.endcard.url;
  }
  /*
   * Fades. Hard cuts everywhere else, because the brief is cuts on action and a dissolve
   * between two moving cameras reads as a smear. A film opens out of black — the trailer's one
   * measured editorial rule that survived every recut — unless the script says otherwise, and
   * the act boundaries dip through it, which is what tells a viewer that the map has changed
   * rather than the camera.
   */
  const inF = Math.round((isFirstInCut && !sh.fadeIn ? 0.8 : sh.fadeIn) * FPS);
  const outF = Math.round(sh.fadeOut * FPS);
  if (inF > 1 && i < inF) o.fade = Math.max(o.fade, 1 - EASINGS.easeOut(i / (inF - 1)));
  if (outF > 1 && i >= n - outF) o.fade = Math.max(o.fade, EASINGS.easeOut((i - (n - outF)) / (outF - 1)));
  return o;
}

const log = [];
const firstInCut = plan.shots[0];
const byScene = new Map();
for (const id of plan.captureOrder) {
  const s = selected.find((q) => q.id === id);
  if (!s) continue;
  if (!byScene.has(s.scene)) byScene.set(s.scene, []);
  byScene.get(s.scene).push(s);
}

for (const [sceneId, shots] of byScene) {
  /*
   * The scouting pass, and why it costs a whole extra run of the battle.
   *
   * `start: { find: 'gateOpen', offset: -13 }` means "cut in thirteen seconds before the gate
   * gives way", and a simulation can only be fast-forwarded, never rewound — so the only way
   * to know when an event happens is to run past it and then start again. The scout runs on
   * the same fixed 1/30 grid with `{ render: false }`, which `Engine.advance` documents and
   * `qa-determinism` asserts is bit-identical to a rendered pass, so the sim time it reports is
   * the sim time the capture will see the same thing at.
   *
   * All of a scene's cues are scouted in one load and each distinct predicate is resolved
   * once, so the cost is one extra run of that battle however many shots are cut against it.
   */
  const needScout = shots.filter((s) => s.start.find);
  const found = new Map();
  if (needScout.length) {
    await load(sceneId, { force: true });
    console.log(`  scouting ${needScout.length} cue(s)`);
    /*
     * One answer per *predicate*, not per shot.
     *
     * Three shots cut against `contact` at -2, +5 and +16 seconds are three windows on one
     * event, and a scout that ran the predicate three times would answer the second and third
     * with "already true, at the time I am at now" — which is the scouting clock, not the
     * event. Keyed on the predicate with its offset removed, so the cue is found once and the
     * offsets are applied to it.
     */
    const cues = new Map();
    for (const s of needScout) {
      const f = s.start.find;
      const key = JSON.stringify({ ...f, offset: undefined, before: undefined });
      if (!cues.has(key)) {
        const r = await page.evaluate((a) => window.__tc.scout(a.f, a.before), { f, before: f.before });
        if (r.at === null) {
          throw new Error(`shot "${s.id}": ${f.find} never happened by t+${f.before}s `
            + `(scouted ${r.scanned} ticks, reached t+${r.reached}s). Raise start.before, or the battle does not do this.`);
        }
        cues.set(key, r.at);
        console.log(`    cue ${f.find}${f.nth !== undefined ? `(${f.nth})` : f.n !== undefined ? `(${f.n})` : ''} at t+${r.at}s`);
      }
      const cue = cues.get(key);
      const at = Math.max(0, cue + f.offset);
      found.set(s.id, { cue, at });
      console.log(`    ${s.id.padEnd(18)} -> start t+${at.toFixed(3)}s`);
    }
  }

  /*
   * Sort by the *resolved* start, not the declared one.
   *
   * A `find` start is only a number once the scout has run, and two cues can resolve out of
   * the order they were written in. The simulation can only be fast-forwarded, so capture
   * order has to be ascending in sim time or a shot would be shot at whatever time the
   * previous one left the clock at — silently, since `runTo` on a time already passed is a
   * loop that runs zero times. That is checked below as well as sorted for.
   */
  const startOf = (s) => (s.start.at ?? found.get(s.id).at);
  shots.sort((a, b) => startOf(a) - startOf(b));

  await load(sceneId, { force: true });

  let clockAt = 0;
  for (const s of shots) {
    const sh = s.shot;
    const t0 = startOf(s);
    if (t0 < clockAt - 1e-6) {
      throw new Error(`shot "${s.id}" starts at t+${t0.toFixed(3)}s but the scene's clock is already at `
        + `t+${clockAt.toFixed(3)}s — the previous shot ran past it. A simulation cannot be rewound; `
        + `split the scene in two, or move this shot later.`);
    }
    const ffAt = Date.now();
    const reached = await page.evaluate((t) => window.__tc.runTo(t), t0);
    const n = s.frames;

    // Staging, before the camera rolls, and after the fast-forward so it lands on the frame
    // the shot actually opens on.
    const interventions = [];
    for (const a of sh.stage) {
      const rec = await page.evaluate((act) => window.__tc.stage(act), a);
      interventions.push(rec);
    }

    const anchor0 = await page.evaluate((spec) => window.__tc.anchor(spec), sh.track.spec);
    if (!anchor0) {
      throw new Error(`shot "${s.id}": track ${JSON.stringify(sh.track.spec)} resolved to nothing at t+${reached.toFixed(2)}s. `
        + `Check the anchor exists in this scene — see --vocabulary.`);
    }

    console.log(`\n▸ ${s.id}  t+${reached.toFixed(3)}s  ${n} frames  ${s.footageSeconds}s of film  `
      + `sim ${s.simSeconds}s  (ff ${((Date.now() - ffAt) / 1000).toFixed(1)}s)`);
    console.log(`  anchor ${JSON.stringify(anchor0).slice(0, 160)}`);
    if (interventions.length) console.log(`  ✱ staged: ${interventions.map((i) => i.do).join(', ')}`);

    const rec = {
      id: s.id, scene: sceneId, desc: sh.desc, startedAt: +reached.toFixed(4),
      requestedStart: t0, cue: found.get(s.id) ?? null, frames: [], anchor0,
      interventions, motion: sh.motion, interp: sh.interp,
      track: { ...sh.track.spec, mode: sh.track.mode, lag: sh.track.lag },
    };

    const stillIdx = new Set([0, Math.floor(n / 2), n - 1]);
    /** Critically-damped smoothing on a following anchor. Deterministic: a pure function of
     *  the resolved positions and the frame index, so a re-shoot reproduces it exactly. */
    let smooth = null;
    let expectTicks = 0;
    let subCalls = 0;
    // One integer for the whole shot; the validator has already refused anything else.
    const sub = sh.motion === 'substep' ? Math.max(1, Math.round(1 / sh.speed[0].v)) : 1;

    for (const f of s.schedule) {
      let anchor = anchor0;
      if (sh.track.mode === 'follow') {
        const live = await page.evaluate((spec) => window.__tc.anchor(spec), sh.track.spec);
        if (!live) throw new Error(`shot "${s.id}" frame ${f.i}: the tracked subject is gone. Pin the track, or shorten the shot.`);
        if (!smooth) smooth = { x: live.x, z: live.z };
        else {
          const k = sh.track.lag > 0 ? 1 - Math.exp(-(1 / FPS) / (sh.track.lag / 3)) : 1;
          smooth.x += (live.x - smooth.x) * k;
          smooth.z += (live.z - smooth.z) * k;
        }
        anchor = { ...live, x: smooth.x, z: smooth.z };
      }

      const p = railAt(sh, f.u);
      const st = frameState(sh, p, anchor);
      const ov = overlayFor(sh, f.i, n, sh === firstInCut.shot);

      const stepOpts = sh.motion === 'substep' && sub > 1 ? { substep: sub } : null;
      const out = await page.evaluate(({ s: cam, o, ticks, opts }) => {
        window.__tc.apply(cam);
        window.__tcOverlay(o);
        window.__tc.step(ticks, opts);
        return window.__tc.stats();
      }, { s: st, o: ov, ticks: f.ticks, opts: stepOpts });

      /*
       * The clock, asserted on every frame. This is the anti-freeze check and it is not
       * ceremonial: a battle that has stopped photographs perfectly, and this project has
       * shipped one that stopped for sixteen minutes.
       */
      if (stepOpts) { subCalls++; expectTicks = Math.floor(subCalls / sub); }
      else expectTicks += f.ticks;
      const expect = reached + expectTicks / FPS;
      if (Math.abs(out.t - expect) > 1e-6 + 1e-9 * Math.abs(expect)) {
        throw new Error(`shot "${s.id}" frame ${f.i}: simTime is ${out.t.toFixed(5)}s, the plan says ${expect.toFixed(5)}s `
          + `(${f.ticks} tick(s) asked for this frame)`);
      }

      rec.frames.push({ i: f.i, t: +out.t.toFixed(5), ticks: f.ticks, alive: out.alive, fighting: out.fighting,
        corpses: out.corpses, moving: out.moving, climbing: out.climbing, shooting: out.shooting,
        routing: out.routing, draws: out.draws, eye: out.eye, fov: out.fov,
        sunAngle: out.sunAngle, sunElev: out.sunElev, gateBlows: out.gateBlows });

      if (STILLS && !stillIdx.has(f.i)) continue;
      await page.screenshot({ path: frameFile(s.id, f.i), type: 'jpeg', quality: 94 });
    }

    // What actually moved during this shot — the other half of the anti-freeze assertion.
    const ff = rec.frames;
    const a = ff[0];
    const b = ff[ff.length - 1];
    rec.moved = {
      simSeconds: +(b.t - a.t).toFixed(3),
      aliveDelta: b.alive - a.alive,
      corpseDelta: b.corpses - a.corpses,
      fightingRange: [Math.min(...ff.map((q) => q.fighting)), Math.max(...ff.map((q) => q.fighting))],
      movingRange: [Math.min(...ff.map((q) => q.moving)), Math.max(...ff.map((q) => q.moving))],
      climbingMax: Math.max(...ff.map((q) => q.climbing)),
      eyeTravel: +Math.hypot(b.eye[0] - a.eye[0], b.eye[1] - a.eye[1], b.eye[2] - a.eye[2]).toFixed(2),
      fovRange: [Math.min(...ff.map((q) => q.fov)), Math.max(...ff.map((q) => q.fov))],
    };
    clockAt = ff[ff.length - 1].t;
    console.log(`  ${ff.length} frames  sim +${rec.moved.simSeconds}s  alive ${a.alive}->${b.alive}  `
      + `corpses +${rec.moved.corpseDelta}  fighting ${rec.moved.fightingRange}  `
      + `climb<=${rec.moved.climbingMax}  eye moved ${rec.moved.eyeTravel} m  `
      + `fov ${rec.moved.fovRange[0]}->${rec.moved.fovRange[1]}  draws ${b.draws}`);
    if (rec.moved.simSeconds === 0 && s.simSeconds > 0) {
      throw new Error(`shot "${s.id}": the plan says ${s.simSeconds}s of simulation and the clock did not move`);
    }
    log.push(rec);
  }

  // Put the camera knobs back, so a scene shot after a `shakeScale` shot is not still carrying it.
  await page.evaluate(() => window.__tc.restoreCameraKnobs());
}

// ---------------------------------------------------------------------------
// The cut, and the record
// ---------------------------------------------------------------------------

/*
 * The cut is declaration order, and it is read back off disk rather than from what this run
 * happened to produce. So `--shots=ram-push` into a directory that already holds a whole film
 * re-cuts the whole film with one shot replaced, rather than producing a one-shot film.
 */
let cutList = [];
if (!STILLS) {
  const onDisk = (await readdir(FRAMES)).filter((f) => f.endsWith('.jpg')).sort();
  for (const s of plan.shots) {
    const mine = onDisk.filter((f) => /^(.*)-\d{5}\.jpg$/.exec(f)?.[1] === s.id);
    if (!mine.length) { console.warn(`  ! no frames on disk for shot ${s.id}`); continue; }
    cutList.push(...mine.map((f) => path.join(FRAMES, f)));
  }
}

/*
 * Merge the record by shot name rather than overwriting it, and refuse the merge when the
 * *renderer* changed under it.
 *
 * `tools/shoot.mjs` has both halves of this and its refusal branch still writes the file, so a
 * refused merge silently replaces a fourteen-frame record with a two-frame one that stamps the
 * new tree over the old frames. This one returns.
 *
 * The invariant is `srcHash`, not `commit`: `shoot.mjs` compares `git rev-parse HEAD:src`,
 * which cannot see an uncommitted edit, so its guard passes on exactly the before/after pair it
 * exists to catch. See `provenance()`.
 */
const recPath = path.join(WORK, STILLS ? 'stills.json' : 'film.json');
let mergedShots = log;
let priorPasses = [];
if (existsSync(recPath)) {
  const prior = JSON.parse(await readFile(recPath, 'utf8'));
  const fixed = { width: W, height: H, dpr: DPR, quality: plan.quality };
  const clash = Object.entries(fixed).filter(([k, v]) => prior[k] !== undefined && prior[k] !== v);
  if (prior.provenance?.srcHash && prior.provenance.srcHash !== PROV.srcHash) {
    clash.push(['srcHash', `${prior.provenance.srcHash.slice(0, 12)} -> ${PROV.srcHash.slice(0, 12)}`]);
  }
  if (clash.length) {
    console.error(`\nREFUSED to merge into ${path.relative(ROOT, recPath)}: ${clash.map(([k, v]) => `${k} ${v}`).join('; ')}`);
    console.error('  These frames were shot through a different renderer or at a different size than the ones');
    console.error('  already in that directory. Shoot the whole film into a clean one instead.');
    await browser.close();
    shutdown();
    process.exit(1);
  }
  const byName = new Map((prior.shots ?? []).map((r) => [r.id, r]));
  for (const r of log) byName.set(r.id, r);
  mergedShots = plan.shots.map((s) => byName.get(s.id)).filter(Boolean);
  priorPasses = prior.passes ?? [];
}

await writeFile(recPath, JSON.stringify({
  tool: 'tools/film.mjs',
  at: new Date().toISOString(),
  film: { id: plan.id, title: plan.title, source: plan.source },
  provenance: PROV,
  width: W, height: H, dpr: DPR, fps: FPS, quality: plan.quality,
  /** False when anything in this film was arranged. See `STAGE` in shot-format.mjs. */
  emergent: mergedShots.every((r) => !(r.interventions ?? []).some((i) => i.touchesSim)) && plan.stagedScenes.length === 0,
  stagedScenes: plan.stagedScenes,
  scenes: plan.scenes,
  cut: plan.shots.map((s) => s.id),
  capturedThisRun: log.map((r) => r.id),
  passes: [...priorPasses, { at: new Date().toISOString(), argv: process.argv.slice(2), srcHash: PROV.srcHash, commit: PROV.commit }],
  shots: mergedShots,
  errs: [...new Set(errs)],
}, null, 1));
if (!STILLS) await writeFile(path.join(WORK, 'cut.json'), JSON.stringify(cutList));

await browser.close();

if (errs.length) {
  console.error(`\n⚠ ${errs.length} page error(s):`);
  for (const e of [...new Set(errs)].slice(0, 10)) console.error(`   ${e}`);
}

console.log(`\n${STILLS ? 'stills' : 'frames'} → ${FRAMES}`);
console.log(`record → ${recPath}`);
if (!STILLS) {
  console.log(`cut: ${cutList.length} frames = ${(cutList.length / FPS).toFixed(2)} s`);
  if (NO_ENCODE) console.log('--noencode: frames only; run --encode to build the webm');
  else await encode(path.join(WORK, 'cut.json'), OUT_WEBM);
}

shutdown();
process.exit(errs.length ? 1 : 0);
