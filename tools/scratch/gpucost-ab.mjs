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
  ['base', 'tc.mbMin(0); tc.mbOn(1)'],
  ['mbskip', 'tc.mbMin(0.5); tc.mbOn(1)'],
  // The pass switched off at the quality flag. This is the *ceiling* on what the sub-pixel
  // skip can ever recover, measured the same way in the same session: if `base` and `mboff`
  // are indistinguishable then the pass is not worth skipping and no amount of gating it
  // more cleverly will show up in a frame time.
  ['mboff', 'tc.mbMin(0); tc.mbOn(0)'],
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

  /*
   * Stop the engine's own rAF loop before anything else.
   *
   * Without this the game keeps rendering in real time between `page.evaluate` and
   * `page.screenshot`, so a "frozen" frame is whatever the loop last drew and two shots of
   * the *same* arm differ on 81% of pixels. That is a second problem on top of the VFX
   * reseeding `RELEASING.md` §4a describes, and it makes the drift check fail for a reason
   * that has nothing to do with the arms. Measured: with the loop running, base-1 vs base-2
   * differed on 0.81 of the frame at a mean of 5.2/255, which is larger than any render lever
   * under test here and made the whole picture comparison inconclusive.
   */
  g.engine.stop();

  const acc = { shadow: 0, scene: 0, quad: 0 };
  const sm = renderer.shadowMap;
  const origShadow = sm.render.bind(sm);
  sm.render = (...z) => { const b = info.render.calls; origShadow(...z); acc.shadow += info.render.calls - b; };
  /*
   * `FullScreenQuad.render` goes through `renderer.render`, so one wrapper cannot tell the
   * colour pass from a post blit — the first cut of this probe reported post = 0 and a colour
   * pass 25 calls too large. The scene render is the one whose first argument is the world
   * scene; every other call is a fullscreen quad.
   */
  const origRender = renderer.render.bind(renderer);
  renderer.render = (...z) => {
    const b = info.render.calls;
    origRender(...z);
    const d = info.render.calls - b;
    if (z[0] === ctx.scene) acc.scene += d; else acc.quad += d;
  };

  const gl = renderer.getContext();
  const px = new Uint8Array(4);

  window.tc = {
    acc,
    postfx,
    sync: () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px),
    /** The one knob under test. 0 restores the stock behaviour exactly. */
    mbMin: (v) => { postfx.motionBlurMinPixels = v; },
    /** The tier's own motion-blur flag, which is what `AdaptiveQuality`'s rung drives. */
    mbOn: (v) => { ctx.quality.motionBlur = !!v; },
    /** Re-issue the same timestamp: frameDt 0, no fixed step, no emitter advance. */
    freeze: () => { window.__tcFrozenAt = g.engine.time.elapsed * 1000; },
    still: (n) => { for (let i = 0; i < n; i++) g.engine.frame(window.__tcFrozenAt); },
    /** A real advancing frame, for the panning arm. */
    live: (n) => { for (let i = 0; i < n; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7); },
    split: () => {
      acc.shadow = 0; acc.scene = 0; acc.quad = 0;
      g.engine.frame(window.__tcFrozenAt);
      window.tc.sync();
      const total = info.render.calls;
      return {
        total, tris: info.render.triangles,
        shadow: acc.shadow, colour: acc.scene - acc.shadow, post: acc.quad,
        unattributed: total - acc.scene - acc.quad,
      };
    },
    /** Rig yaw, so a "panning" arm can be shown to have actually panned. */
    yaw: () => ctx.rig.yaw,
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

// ---- structural diagnostics, on the base arm, before anything is varied --
const diag = await page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context ?? g.engine.ctx;
  const info = ctx.renderer.info;

  // Per-cascade shadow draws, via three's own early-out at WebGLShadowMap.js:170
  // (`shadow.autoUpdate === false && shadow.needsUpdate === false` -> continue). That skips
  // one light's shadow render without touching a material define, so no recompile and no
  // change to NUM_DIR_LIGHT_SHADOWS.
  const lighting = ctx.tryGet('lighting');
  const csm = lighting && lighting.csm;
  const perCascade = [];
  let cascadeInfo = null;
  if (csm && csm.lights) {
    cascadeInfo = {
      lights: csm.lights.length, mapSize: csm.shadowMapSize, maxFar: csm.maxFar,
      extents: csm.lights.map((l) => +(l.shadow.camera.right - l.shadow.camera.left).toFixed(1)),
      texels: csm.lights.map((l) => +((l.shadow.camera.right - l.shadow.camera.left) / csm.shadowMapSize).toFixed(3)),
    };
    for (let i = 0; i < csm.lights.length; i++) {
      for (let j = 0; j < csm.lights.length; j++) {
        csm.lights[j].shadow.autoUpdate = j === i;
        csm.lights[j].shadow.needsUpdate = j === i;
      }
      window.tc.acc.shadow = 0;
      g.engine.frame(window.__tcFrozenAt);
      window.tc.sync();
      perCascade.push(window.tc.acc.shadow);
    }
    for (const l of csm.lights) { l.shadow.autoUpdate = true; l.shadow.needsUpdate = false; }
    g.engine.frame(window.__tcFrozenAt);
  }

  // Who casts, and who ignores the per-cascade frustum. An object with frustumCulled=false
  // is redrawn into every cascade whatever that cascade covers (WebGLShadowMap.js:515).
  const casters = [];
  ctx.scene.traverse((o) => {
    if (!o.castShadow || !(o.isMesh || o.isLine || o.isPoints)) return;
    let vis = true, n = o;
    while (n) { if (!n.visible) { vis = false; break; } n = n.parent; }
    if (!vis) return;
    const cnt = o.isInstancedMesh ? o.count : (o.geometry?.instanceCount ?? 1);
    if (o.isInstancedMesh && o.count === 0) return;
    const idx = o.geometry?.index;
    const pos = o.geometry?.attributes?.position;
    let t = idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
    if (Number.isFinite(cnt)) t *= cnt;
    let top = o; while (top.parent && top.parent !== ctx.scene) top = top.parent;
    casters.push({
      name: o.name || o.type, top: top.name || top.type,
      fc: !!o.frustumCulled, cnt: Number.isFinite(cnt) ? cnt : 1, tris: Math.round(t),
    });
  });

  const units = ctx.tryGet('unitRender');
  const cam = ctx.camera;
  return {
    perCascade, cascadeInfo,
    casters: casters.sort((a, b) => b.tris - a.tris),
    quality: {
      tier: ctx.quality.tier, shadowMapSize: ctx.quality.shadowMapSize,
      shadowCascades: ctx.quality.shadowCascades, motionBlur: ctx.quality.motionBlur,
      depthOfField: ctx.quality.depthOfField, ssao: ctx.quality.ssao,
      volumetricLight: ctx.quality.volumetricLight, bloom: ctx.quality.bloom,
      antialias: ctx.quality.antialias, lodFarDistance: ctx.quality.lodFarDistance,
      maxSoldiers: ctx.quality.maxSoldiers,
    },
    lod: {
      lodDist: units && units.lodDist ? units.lodDist.map((v) => +v.toFixed(1)) : null,
      camFov: +cam.fov.toFixed(2), viewH: ctx.viewH, zoom: +ctx.rig.zoom.toFixed(3),
      orbitRadius: +ctx.rig.orbitRadius.toFixed(1),
      tierCounts: (() => {
        const r = {};
        ctx.scene.traverse((o) => {
          if (o.isInstancedMesh && o.count > 0 && /soldier|horse|impostor|elephant/i.test(o.name || '')) r[o.name] = o.count;
        });
        return r;
      })(),
    },
    voidInfo: info.render.calls,
  };
});
console.log(`# quality  ${JSON.stringify(diag.quality)}`);
console.log(`# cascades ${JSON.stringify(diag.cascadeInfo)}`);
console.log(`# per-cascade shadow draws: ${diag.perCascade.join(' / ')} (sum ${diag.perCascade.reduce((a, b) => a + b, 0)})`);
console.log(`# lod      ${JSON.stringify(diag.lod)}`);
{
  const un = diag.casters.filter((c) => !c.fc);
  console.log(`# shadow casters ${diag.casters.length}, of which frustumCulled=false: ${un.length}`
    + ` (each redrawn into all ${diag.cascadeInfo ? diag.cascadeInfo.lights : '?'} cascades)`);
  for (const c of diag.casters.slice(0, 14)) {
    console.log(`#   ${c.fc ? ' ' : '!'} ${String(c.tris).padStart(9)}t x${String(c.cnt).padStart(5)}  ${c.top.padEnd(22)} ${c.name}`);
  }
}

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
    + `   tris ${(s.tris / 1e6).toFixed(2)}M   mb ran ${info.passes.motionBlurFrames} skipped ${info.passes.motionBlurSkipped}`
    + `  smearPx ${info.passes.lastSmearPx === undefined ? '?' : info.passes.lastSmearPx.toFixed(3)}`);
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
      const yaw0 = window.tc.yaw();
      const t0 = performance.now();
      for (let k = 0; k < frames; k++) {
        // Drive `yaw` itself, not `yawTarget`. The rig damps toward the target and
        // `RTSCamera.update` recomputes `yaw` from it every frame, so writing the target and
        // then letting one frame run gives a fraction of the intended step — and the first
        // cut of this probe panned so slowly that the sub-pixel gate fired on all 40 frames,
        // which read as "the skip is unsafe" when it was the pan that was not real.
        const r = g.engine.context.rig;
        r.yawTarget = cam.yaw + (k + 1) * 0.02;
        r.yaw = r.yawTarget;
        g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
      }
      window.tc.sync();
      const ms = (performance.now() - t0) / frames;
      return { ms, passes: window.tc.passes(), yawMoved: +(window.tc.yaw() - yaw0).toFixed(3) };
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
  const lastRec = panning.get(name).at(-1);
  const last = lastRec.passes;
  console.log(`  ${name.padEnd(10)} ${q(p, 0.5).toFixed(2).padStart(11)} ${q(p, 0.9).toFixed(2).padStart(7)} ${Math.min(...p).toFixed(2).padStart(7)}`
    + ` | ${q(v, 0.5).toFixed(2).padStart(8)} ${q(v, 0.9).toFixed(2).padStart(7)} ${Math.min(...v).toFixed(2).padStart(7)}`
    + `   ${last.motionBlurFrames}/${last.motionBlurSkipped}  yawMoved ${lastRec.yawMoved}`
    + `  smearPx ${last.lastSmearPx === undefined ? '?' : last.lastSmearPx.toFixed(2)}`);
}
const pb = parked.get(ARMS[0][0]);
for (const [name] of ARMS.slice(1)) {
  const pm = parked.get(name);
  const vm = panning.get(name).map((x) => x.ms);
  const vb = panning.get(ARMS[0][0]).map((x) => x.ms);
  console.log(`  ${name} vs base — parked ${(q(pm, 0.5) - q(pb, 0.5)).toFixed(2)} ms p50 / `
    + `${(Math.min(...pm) - Math.min(...pb)).toFixed(2)} best;  panning `
    + `${(q(vm, 0.5) - q(vb, 0.5)).toFixed(2)} ms p50 / ${(Math.min(...vm) - Math.min(...vb)).toFixed(2)} best`);
}
console.log('  (negative = faster than base. best-of-block is the least contaminated read on a shared box.)');

if (pageErrors.length) {
  console.error(`\npageerror x${pageErrors.length}:`);
  for (const e of [...new Set(pageErrors)].slice(0, 10)) console.error(`  ${e}`);
} else {
  console.log('\nno pageerror, no console error.');
}
console.log(`# load at end ${loadAvg()}`);

await browser.close();
if (server) server.kill('SIGTERM');
