#!/usr/bin/env node
/**
 * Interleaved A/B/A for render-side changes: picture, draw calls and frame time, one session.
 *
 * `docs/RELEASING.md` §4a forbids cross-session pixel comparison on this project — two runs
 * at identical configuration differ on 50-70% of pixels at a mean of 17-27/255 because dust
 * and particle VFX reseed per session even with the sim clock paused. So every arm here runs
 * inside one page load, and the base arm is re-shot **last** as a drift check. If base and
 * base-again differ by so much as a pixel, the session is void and the middle arm's numbers
 * mean nothing.
 *
 * Three things are measured at each named camera:
 *
 *  1. **Picture.** The sim is frozen by re-issuing the *same* frame timestamp, so `frameDt`
 *     is 0, no fixed step runs and no emitter advances. Each arm then renders and is
 *     screenshotted off that one stationary world state. This is what makes an exact pixel
 *     diff between arms meaningful at all.
 *  2. **Draw calls, split.** `renderer.shadowMap.render` and `renderer.render` are wrapped to
 *     snapshot `info.render.calls` either side, giving shadow / colour / post from the real
 *     frame rather than from a reconstruction.
 *  3. **Frame time, parked and panning.** Blocks of N frames, arms rotated, arm order
 *     alternated per block so warm-up cannot tax whichever arm always goes first, medians
 *     over blocks. A `readPixels` either side drains the queue so this cannot degenerate
 *     into a measurement of command submission. Reported p50 and p90, never a mean.
 *
 * Cameras come from a `shoot.mjs` `report.json`: the resolved focus of a *named* entry in
 * that tool's `SHOTS` table, never a camera placed by hand here.
 *
 *   node tools/scratch/gpucost-ab.mjs --port=5921 --scene=rome \
 *     --report=screenshots/gpucost-base/report.json --out=screenshots/gpucost-ab
 */

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5921);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const QUALITY = args.get('quality') ?? 'ultra';
const FRAMES = Number(args.get('frames') ?? 40);
const BLOCKS = Number(args.get('blocks') ?? 4);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/gpucost-ab');
const REPORT = path.resolve(ROOT, args.get('report') ?? 'screenshots/gpucost-base/report.json');
const SCENE_ID = args.get('scene') ?? 'rome';

/**
 * Scene configs, mirroring the matching `shoot.mjs` SHOTS entries. `shot` names the entry
 * whose resolved camera this run reuses.
 */
const SCENES = {
  rome: { shot: 'ab-rome-wall', cfg: { scenario: 'assault', timeOfDay: 14.3 }, zoom: 0.46 },
  carthage: {
    shot: 'ab-carth-wall',
    cfg: { map: 'carthage', opponent: 2, scenario: 'assault', timeOfDay: 15.2 }, zoom: 0.46,
  },
};

/**
 * Arms. Each sets *every* knob it knows about, never a delta, so rotating through them in
 * any order lands in the same state. `base` must be first: it is both the reference and the
 * drift check.
 */
const ARMS = [
  ['base', 'tc.mbMin(0)'],
  ['mbskip', 'tc.mbMin(0.5)'],
];

const tree = (() => {
  const g = (a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return '?'; } };
  return {
    head: g(['rev-parse', '--short', 'HEAD']),
    branch: g(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: g(['diff', 'HEAD', '--shortstat', '--', 'src/']) || 'clean',
  };
})();
const loadAvg = () => {
  try {
    const m = execFileSync('uptime', { encoding: 'utf8' }).match(/load averages?:\s*([\d.]+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
};

const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
  return s[i];
};

await mkdir(OUT, { recursive: true });
const rep = JSON.parse(await readFile(REPORT, 'utf8'));
const shotsInReport = new Map((rep.shots ?? rep.results ?? []).map((s) => [s.name, s]));

const scene = SCENES[SCENE_ID];
if (!scene) throw new Error(`unknown --scene=${SCENE_ID}`);
const rec = shotsInReport.get(scene.shot);
if (!rec || rec.error) throw new Error(`no usable report entry for ${scene.shot}`);

const base = `http://127.0.0.1:${PORT}`;
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); if (r.ok || r.status === 304) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
}

const battleToken = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

console.log(`# ${tree.branch}@${tree.head} (${tree.dirty})  ${W}x${H} ${QUALITY} dpr1`);
console.log(`# scene=${SCENE_ID} camera=${scene.shot} @(${rec.focusX},${rec.focusZ}) `
  + `zoom=${scene.zoom} yaw=${rec.yaw} t+${Math.round(rec.simTime)}s  load ${loadAvg()}`);

await page.goto(`${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}&battle=${battleToken(scene.cfg)}`,
  { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });

// ---- install the knobs and the frame instrumentation, once ----------------
await page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context ?? g.engine.ctx;
  const postfx = ctx.tryGet('postfx');
  const renderer = ctx.renderer;
  const info = renderer.info;

  const acc = { shadow: 0, render: 0 };
  const sm = renderer.shadowMap;
  const origShadow = sm.render.bind(sm);
  sm.render = (...z) => { const b = info.render.calls; origShadow(...z); acc.shadow += info.render.calls - b; };
  const origRender = renderer.render.bind(renderer);
  renderer.render = (...z) => { const b = info.render.calls; origRender(...z); acc.render += info.render.calls - b; };

  const gl = renderer.getContext();
  const px = new Uint8Array(4);

  window.tc = {
    acc,
    postfx,
    sync: () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px),
    /** The one knob under test. 0 restores the stock behaviour exactly. */
    mbMin: (v) => { postfx.motionBlurMinPixels = v; },
    /** Re-issue the same timestamp: frameDt 0, no fixed step, no emitter advance. */
    freeze: () => { window.__tcFrozenAt = g.engine.time.elapsed * 1000; },
    still: (n) => { for (let i = 0; i < n; i++) g.engine.frame(window.__tcFrozenAt); },
    /** A real advancing frame, for the panning arm. */
    live: (n) => { for (let i = 0; i < n; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7); },
    split: () => {
      acc.shadow = 0; acc.render = 0;
      g.engine.frame(window.__tcFrozenAt);
      window.tc.sync();
      const total = info.render.calls;
      return {
        total, tris: info.render.triangles,
        shadow: acc.shadow, colour: acc.render - acc.shadow, post: total - acc.render,
      };
    },
    passes: () => postfx.debugPasses(),
    resetPasses: () => postfx.debugResetPasses(),
    men: () => {
      let men = 0, units = 0;
      for (const u of g.battle.units) if (!u.destroyed) { units++; men += u.alive; }
      return { men, units };
    },
  };
});

// ---- park the camera at the named shot's resolved framing ----------------
await page.evaluate(async (c) => {
  const g = window.__game;
  g.advance(c.at);
  g.setCamera(c.x, c.z, c.zoom, c.yaw);
  // Let the rig damp all the way on to its target before anything is frozen: a camera still
  // converging is a camera that moves between arms, which would smear the drift check.
  for (let i = 0; i < 90; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
  window.tc.freeze();
  window.tc.still(4);
}, { at: rec.simTime ?? 170, x: rec.focusX, z: rec.focusZ, zoom: scene.zoom, yaw: rec.yaw });

const pop = await page.evaluate(() => window.tc.men());
console.log(`# headcount ${pop.men} men / ${pop.units} units (fixed across every arm below)`);

// ---- 1. picture: base, then each arm, then base again --------------------
const order = [['base-1', ARMS[0][1]], ...ARMS.slice(1).map(([n, s]) => [n, s]), ['base-2', ARMS[0][1]]];
const shots = [];
for (const [name, src] of order) {
  const info = await page.evaluate(({ src }) => {
    new Function('tc', src)(window.tc);
    window.tc.resetPasses();
    window.tc.still(3);
    const split = window.tc.split();
    return { split, passes: window.tc.passes() };
  }, { src });
  const file = path.join(OUT, `${SCENE_ID}-${name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  shots.push({ name, file, ...info });
  const s = info.split;
  console.log(`  ${name.padEnd(9)} draws ${String(s.total).padStart(4)} = shadow ${String(s.shadow).padStart(3)}`
    + ` + colour ${String(s.colour).padStart(3)} + post ${String(s.post).padStart(3)}`
    + `   tris ${(s.tris / 1e6).toFixed(2)}M   mb ran ${info.passes.motionBlurFrames} skipped ${info.passes.motionBlurSkipped}`);
}

// ---- 2. frame time: parked, arms rotated, order alternated ---------------
const parked = new Map(ARMS.map(([n]) => [n, []]));
for (let b = 0; b < BLOCKS; b++) {
  const idx = b % 2 ? [...ARMS.keys()].reverse() : [...ARMS.keys()];
  for (const i of idx) {
    const [name, src] = ARMS[i];
    const ms = await page.evaluate(({ src, frames }) => {
      new Function('tc', src)(window.tc);
      const g = window.__game;
      window.tc.still(2);
      window.tc.sync();
      const t0 = performance.now();
      for (let k = 0; k < frames; k++) g.engine.frame(window.__tcFrozenAt);
      window.tc.sync();
      return (performance.now() - t0) / frames;
    }, { src, frames: FRAMES });
    parked.get(name).push(ms);
  }
}

// ---- 3. frame time: panning, where the skip must NOT fire ----------------
const panning = new Map(ARMS.map(([n]) => [n, []]));
for (let b = 0; b < BLOCKS; b++) {
  const idx = b % 2 ? [...ARMS.keys()].reverse() : [...ARMS.keys()];
  for (const i of idx) {
    const [name, src] = ARMS[i];
    const r = await page.evaluate(({ src, frames, cam }) => {
      new Function('tc', src)(window.tc);
      const g = window.__game;
      // Yaw the rig steadily: a real pan, the case the pass exists for.
      g.setCamera(cam.x, cam.z, cam.zoom, cam.yaw);
      window.tc.live(2);
      window.tc.resetPasses();
      window.tc.sync();
      const t0 = performance.now();
      for (let k = 0; k < frames; k++) {
        g.engine.context.rig.yawTarget = cam.yaw + (k + 1) * 0.02;
        g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
      }
      window.tc.sync();
      const ms = (performance.now() - t0) / frames;
      return { ms, passes: window.tc.passes() };
    }, { src, frames: FRAMES, cam: { x: rec.focusX, z: rec.focusZ, zoom: scene.zoom, yaw: rec.yaw } });
    panning.get(name).push({ ...r });
  }
}

// ---- pixel comparison ----------------------------------------------------
async function raw(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}
async function diff(a, b) {
  const A = await raw(a); const B = await raw(b);
  if (A.data.length !== B.data.length) return { err: 'size mismatch' };
  let n = 0, sum = 0, max = 0;
  const ch = A.info.channels;
  for (let i = 0; i < A.data.length; i += ch) {
    let d = 0;
    for (let c = 0; c < Math.min(3, ch); c++) d = Math.max(d, Math.abs(A.data[i + c] - B.data[i + c]));
    if (d > 0) { n++; sum += d; if (d > max) max = d; }
  }
  const px = A.data.length / ch;
  return { changedPx: n, changedFrac: n / px, meanOverChanged: n ? sum / n : 0, max };
}

console.log(`\n--- picture, arms interleaved in one session ---`);
const b1 = shots.find((s) => s.name === 'base-1');
const b2 = shots.find((s) => s.name === 'base-2');
const drift = await diff(b1.file, b2.file);
console.log(`  DRIFT base-1 vs base-2 : ${JSON.stringify(drift)}`);
if (drift.changedPx === 0) console.log('    -> session is stationary; arm diffs below are real.');
else console.log('    -> NOT stationary. Any arm diff at or below this magnitude is not evidence.');
for (const s of shots) {
  if (s.name.startsWith('base')) continue;
  console.log(`  ${s.name} vs base-1     : ${JSON.stringify(await diff(b1.file, s.file))}`);
}

console.log(`\n--- frame time, ${FRAMES} frames x ${BLOCKS} blocks, ms/frame ---`);
console.log(`  ${'arm'.padEnd(10)} ${'parked p50'.padStart(11)} ${'p90'.padStart(7)} ${'best'.padStart(7)}`
  + ` | ${'pan p50'.padStart(8)} ${'p90'.padStart(7)} ${'best'.padStart(7)}   mb ran/skipped (pan)`);
for (const [name] of ARMS) {
  const p = parked.get(name);
  const v = panning.get(name).map((x) => x.ms);
  const last = panning.get(name).at(-1).passes;
  console.log(`  ${name.padEnd(10)} ${q(p, 0.5).toFixed(2).padStart(11)} ${q(p, 0.9).toFixed(2).padStart(7)} ${Math.min(...p).toFixed(2).padStart(7)}`
    + ` | ${q(v, 0.5).toFixed(2).padStart(8)} ${q(v, 0.9).toFixed(2).padStart(7)} ${Math.min(...v).toFixed(2).padStart(7)}`
    + `   ${last.motionBlurFrames}/${last.motionBlurSkipped}`);
}
const pb = parked.get(ARMS[0][0]); const pm = parked.get(ARMS[1][0]);
console.log(`  parked delta: ${(q(pm, 0.5) - q(pb, 0.5)).toFixed(2)} ms p50, `
  + `${(Math.min(...pm) - Math.min(...pb)).toFixed(2)} ms best-of-block`);

if (pageErrors.length) {
  console.error(`\npageerror x${pageErrors.length}:`);
  for (const e of [...new Set(pageErrors)].slice(0, 10)) console.error(`  ${e}`);
} else {
  console.log('\nno pageerror, no console error.');
}
console.log(`# load at end ${loadAvg()}`);

await browser.close();
if (server) server.kill('SIGTERM');
