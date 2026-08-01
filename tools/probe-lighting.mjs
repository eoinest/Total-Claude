#!/usr/bin/env node
/**
 * Ambient attribution probe: where does a soldier's light actually come from?
 *
 * Twenty blind rounds have separated our frames from the Rome II plates, and the last three
 * causes all resolved to the same symptom: a soldier renders at 2-4 % display luminance
 * against ground at ~30 %, so none of the crowd variation that demonstrably exists in the
 * instance buffers can be seen. `tools/probe-crowd.mjs` proved the variation is there;
 * `tools/probe-units.mjs` proved the environment probe is bound. Neither answers *how much
 * light each term delivers to a man*, which is the only question that identifies the fault.
 *
 * Three measurements, none of which existed before:
 *
 *  1. **Analytic irradiance budget.** Read the live rig and evaluate three.js's own
 *     irradiance formulae for a set of representative normals. `getHemisphereLightIrradiance`
 *     returns `mix(ground, sky, w)` **as irradiance, with no factor of pi**, while
 *     `getIBLIrradiance` returns `PI * probe * envMapIntensity`. So a hemisphere light whose
 *     colour is a *radiance* is short by pi unless its intensity carries the pi, and the two
 *     ambient paths in this project are quoted in different units. That is checkable in
 *     closed form and it is checked here.
 *
 *  2. **Pixel classification by emissive flash.** A mask built by making a tier's material
 *     emit white and thresholding the frame at 200/255. Emissive does not touch the depth
 *     prepass, the shadow pass or any other object, so the mask is exactly the pixels that
 *     tier owns — unlike a visibility diff, which also flags every pixel of that tier's cast
 *     shadow and cannot tell the two apart. Reports display luminance over the soldier mask
 *     and the ground mask separately, which is the man-to-ground ratio the critics read.
 *
 *  3. **Term isolation.** Soldier-mask luminance with each light zeroed in turn: sun,
 *     hemisphere fill, sun-opposed bounce, IBL probe. `LightingSystem.preRender` rewrites
 *     every one of these intensities each frame, so a plain assignment is erased before the
 *     next present; each term is pinned with an accessor property instead and restored after.
 *
 *   node tools/probe-lighting.mjs --port=5641 --shots=raking,wide,midcrowd
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Same cameras as probe-shadow.mjs, so figures are comparable between the two. */
const SHOTS = {
  clash: { x: 15, z: -17, zoom: 0.3, yaw: Math.PI * 1.15, at: 72 },
  romanline: { x: -100, z: 128, zoom: 0.36, yaw: Math.PI * 1.42, at: 2 },
  raking: { x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72, at: 2 },
  midcrowd: { x: -20, z: 128, zoom: 0.46, yaw: Math.PI * 1.42, at: 2 },
  wall: { x: -81, z: 503, zoom: 0.62, yaw: Math.PI * 0.06, at: 3 },
  wide: { x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82, at: 2 },
};

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5641);
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/lighting');
const TAG = args.get('tag') ?? '';
const TIER = args.get('tier') ?? 'ultra';
const KEEP = args.has('keep');
const requested = args.get('shots') ? String(args.get('shots')).split(',') : ['raking', 'midcrowd'];

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const base = `http://127.0.0.1:${PORT}`;
let server = null;
let reused = await waitForServer(base, 1200);
if (!reused) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
}
/*
 * First line, always, and it names the source. A probe pointed at a port with no dev server
 * on it can be silently served a stale `dist/` by whatever else is listening, and a stale
 * build reports the *previous* pass's numbers as though they were this one's. One reading of
 * a 5/12 as a regression in this project was exactly that.
 */
{
  let via = 'unknown';
  try {
    const r = await fetch(`${base}/src/main.ts`, { signal: AbortSignal.timeout(4000) });
    via = r.ok ? 'vite dev (src/main.ts served)' : `NOT a dev server (src/main.ts -> ${r.status}) — probably a stale dist/`;
  } catch { via = 'unreachable'; }
  console.log(`source: ${base} — ${reused ? 'reused an existing server' : 'started my own'} — ${via}`);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
// Six agents share this machine and it has sat at load 15-35. Boot has to bake VATs and
// compile every shader, so a per-call timeout is not enough — one run died on a 30 s default
// that the explicit option on `waitForFunction` did not override.
page.setDefaultTimeout(300000);
page.setDefaultNavigationTimeout(300000);
page.on('pageerror', (e) => console.error('  ! page error:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('  ! console:', m.text().slice(0, 200)); });
await page.goto(`${base}/?harness=1&quality=${TIER}&w=${W}&h=${H}&nohud=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
await page.addStyleTag({
  content: '#hud-root, #loading { display: none !important; visibility: hidden !important; }',
});
await mkdir(OUT, { recursive: true });

/**
 * Render frames without letting the world move.
 *
 * `engine.advance(1e-6, 1e-3)` does **not** advance one microsecond, and the comment in
 * `probe-shadow.mjs` that says it does is wrong. `Engine.advance` seeds its timestamp from
 * `time.elapsed` — a cumulative sum of *clamped* deltas — while `Time.beginFrame` differences
 * the argument against `lastNow`, which holds the previous raw timestamp. They are two
 * different clocks, so after the first call the difference settles at the 0.25 s clamp and
 * `maxStepsPerFrame` fires its full five fixed ticks. Measured through `simTime()`: six arms
 * of ten frames each walked the battle from t=5.8 to t=16.5, about 1.9 s per arm, which is
 * long enough for the Roman line to march clean out of the `raking` frame. The arms that were
 * supposed to isolate a light were photographs of a different moment in the battle, and every
 * light in the rig duly read as a *negative* contributor.
 *
 * This is the same five-ticks-per-rendered-frame error already on record for the shot
 * harness, still live in the probes. Pausing the clock is the actual fix: `Time.beginFrame`
 * multiplies its delta by `paused ? 0 : gameSpeed`, so no tick runs, `simTime` is frozen and
 * the identical world state is re-rendered under each rig. The camera is still re-issued per
 * frame because `RTSCamera` eases on the unscaled frame delta, which pausing does not stop.
 */
let curShot = null;
const step = async (n = 4) => page.evaluate(([k, c]) => {
  for (let i = 0; i < k; i++) {
    // Re-issued inside the loop, not once before it: the ease is fractional per frame, so
    // one placement followed by k frames still lands k frames' worth of drift away.
    if (c) window.__game.setCamera(c.x, c.z, c.zoom, c.yaw);
    window.__game.engine.advance(1e-6, 1e-3);
  }
}, [n, curShot]);

const shot = (name) => page.screenshot({ path: path.join(OUT, `${TAG}${name}.png`) });

const raw = (p) => sharp(p).raw().toBuffer({ resolveWithObject: true });
const lumAt = (b, info, i) => {
  const o = i * info.channels;
  return 0.2126 * b[o] + 0.7152 * b[o + 1] + 0.0722 * b[o + 2];
};

/**
 * The 21st blind round's two separating statistics, reproduced here so a change can be
 * accepted or rejected without a critic round trip.
 *
 * `darkQLum` is the mean display luminance of the darkest quartile of the frame, and
 * `darkQRatio` is that quartile's blue-to-red divided by everything else's — how hard the
 * frame separates cool shade from warm sun. Measured over the ten Rome II plates with the
 * same bottom-20 % wordmark crop `blind-compare.mjs` applies: **0.1172 and 1.968**. The
 * critic reported 0.122 and 1.85 by a slightly different crop, which is close enough that
 * both are measuring the same thing.
 *
 * Ours came back 0.159 and 1.11. So our shadows are ~30 % brighter than theirs *and* barely
 * distinguishable in hue from our own lit surfaces. That rules out the two obvious readings —
 * "ambient too blue" and "ambient too warm" — and leaves the actual defect: both hemispheres
 * sit at the same middling blue and the total is too high. The target is more contrast
 * between them at equal or lower total, which is not the same change as warming everything.
 */
function quartileStats(ref) {
  const n = ref.info.width * ref.info.height;
  const ch = ref.info.channels;
  const lum = new Float64Array(n);
  for (let i = 0; i < n; i++) lum[i] = lumAt(ref.data, ref.info, i) / 255;
  const q25 = Float64Array.from(lum).sort()[Math.floor(n * 0.25)];
  let dl = 0, dn = 0, dr = 0, db = 0, er = 0, eb = 0;
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    if (lum[i] <= q25) { dl += lum[i]; dn++; dr += ref.data[o]; db += ref.data[o + 2]; }
    else { er += ref.data[o]; eb += ref.data[o + 2]; }
  }
  const dbr = db / Math.max(1, dr);
  const ebr = eb / Math.max(1, er);
  return { darkQLum: dl / Math.max(1, dn), darkQbr: dbr, restBr: ebr, darkQRatio: dbr / Math.max(1e-6, ebr) };
}

/**
 * Who actually lives in the frame's darkest quartile.
 *
 * This settles whether two measurements that look contradictory can both be true. The blind
 * critic scores the *frame's* darkest quartile against the Rome II plates and finds ours too
 * bright; the soldier mask's dark tail is three times darker than the ground it stands on.
 * Both hold only if the two populations barely overlap — if men are a thin slice of the
 * darkest quartile, then lifting the ambient on men is nearly invisible to the critic's
 * statistic and can be argued on its own merits. If men *are* the darkest quartile, the same
 * lift moves the frame further from the plates, and that is a trade to be argued explicitly
 * rather than one metric quietly outvoting the other because it is the one being watched.
 */
function quartilePopulation(ref, solMask) {
  const n = ref.info.width * ref.info.height;
  const lum = new Float64Array(n);
  for (let i = 0; i < n; i++) lum[i] = lumAt(ref.data, ref.info, i) / 255;
  const q25 = Float64Array.from(lum).sort()[Math.floor(n * 0.25)];
  let darkN = 0, darkSol = 0, solN = 0, solInDark = 0;
  for (let i = 0; i < n; i++) {
    const dark = lum[i] <= q25;
    const sol = solMask[i] === 1;
    if (dark) darkN++;
    if (sol) solN++;
    if (dark && sol) { darkSol++; solInDark++; }
  }
  return {
    darkQPixels: darkN,
    soldierPixels: solN,
    soldierShareOfFrame: solN / n,
    soldierShareOfDarkQ: darkSol / Math.max(1, darkN),
    soldierPixelsInDarkQ: solInDark / Math.max(1, solN),
  };
}

/** Mean / percentiles of display luminance over a boolean mask, in 0..1 display units. */
function statsOver(ref, mask) {
  const n = ref.info.width * ref.info.height;
  const vals = [];
  let sr = 0, sg = 0, sb = 0, cool = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const o = i * ref.info.channels;
    sr += ref.data[o]; sg += ref.data[o + 1]; sb += ref.data[o + 2];
    if (ref.data[o + 2] > ref.data[o]) cool++;
    vals.push(lumAt(ref.data, ref.info, i));
  }
  if (!vals.length) {
    return { px: 0, mean: 0, p05: 0, p25: 0, p50: 0, p75: 0, p95: 0, rgb: [0, 0, 0], bOverR: 0, coolFrac: 0 };
  }
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] / 255;
  return {
    px: vals.length,
    mean: vals.reduce((a, b) => a + b, 0) / vals.length / 255,
    p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95),
    rgb: [sr / vals.length / 255, sg / vals.length / 255, sb / vals.length / 255],
    /*
     * Chromaticity, and the reason it is here rather than luminance alone.
     *
     * The recorded shadow-chromaticity measurement that drove FILL_CHROMA_GAIN from 1.20 to
     * 1.35 was taken over *ground* pixels in a soldier's cast shadow. Ground has a warm
     * albedo, so it hides a blue illuminant; bare steel does not, and a galea is very nearly
     * a mirror for whatever the probe contains. Tuning the illuminant bluer on evidence
     * gathered from the one surface class that cannot show it is how an army ends up as a
     * cold slab in a warm field. So chromaticity is now reported per mask, and `coolFrac` —
     * the share of pixels with more blue than red — is the direct statistic for "is this
     * region cooler than the frame it sits in".
     */
    bOverR: sb / Math.max(1e-6, sr),
    coolFrac: cool / vals.length,
  };
}

/**
 * Build a pixel mask for a set of meshes by making their material emit white.
 *
 * Threshold 200/255 rather than a difference: bloom at strength 0.07 cannot lift a 30 %
 * ground pixel past 200, and the flashed tier saturates, so the mask is interior pixels of
 * that tier and nothing else. Antialiased edges fall out, which is wanted — an edge pixel is
 * a blend of the man and what is behind him and belongs to neither statistic.
 */
async function maskFor(namePattern, label) {
  const hit = await page.evaluate((pat) => {
    const re = new RegExp(pat);
    window.__flash = [];
    window.__game.engine.context.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      if (!re.test(o.name || '')) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || !m.emissive || window.__flash.some((f) => f.m === m)) continue;
        window.__flash.push({ m, e: m.emissive.clone(), i: m.emissiveIntensity ?? 1 });
        m.emissive.setRGB(1, 1, 1);
        m.emissiveIntensity = 60;
      }
    });
    return window.__flash.length;
  }, namePattern);
  await step(8);
  const png = await shot(`${label}-flash`);
  await page.evaluate(() => {
    for (const f of window.__flash ?? []) { f.m.emissive.copy(f.e); f.m.emissiveIntensity = f.i; }
    window.__flash = [];
  });
  await step(8);
  const r = await raw(png);
  const wpx = r.info.width;
  const hpx = r.info.height;
  const n = wpx * hpx;
  const hot = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (lumAt(r.data, r.info, i) > 200) hot[i] = 1;
  // Erode by one pixel. The flash saturates the tier itself, but bloom puts a bright ring
  // just outside its silhouette and TAA smears that ring another pixel; both would enter the
  // statistic as "soldier" while actually being ground seen past his shoulder. Requiring all
  // four neighbours to be hot as well keeps interior pixels only.
  const mask = new Uint8Array(n);
  let count = 0;
  for (let y = 1; y < hpx - 1; y++) {
    for (let x = 1; x < wpx - 1; x++) {
      const i = y * wpx + x;
      if (!hot[i]) continue;
      if (!hot[i - 1] || !hot[i + 1] || !hot[i - wpx] || !hot[i + wpx]) continue;
      mask[i] = 1;
      count++;
    }
  }
  return { mask, count, mats: hit, frac: count / n };
}

/**
 * Pin a light term to a value `LightingSystem.preRender` cannot overwrite.
 *
 * Every intensity in the rig is recomputed from the sky each frame, so `light.intensity = 0`
 * is undone before the next present. An accessor property whose setter discards writes
 * survives it; the restore puts back an ordinary data property with the original value.
 */
const TERM_JS = `
window.__pin = function (obj, prop, value) {
  const had = Object.getOwnPropertyDescriptor(obj, prop);
  Object.defineProperty(obj, prop, { get: () => value, set: () => {}, configurable: true });
  return () => Object.defineProperty(obj, prop, had ?? { value, writable: true, configurable: true, enumerable: true });
};
`;

const statesFor = (term) => page.evaluate(([t, js]) => {
  // eslint-disable-next-line no-eval
  if (!window.__pin) eval(js);
  const ctx = window.__game.engine.context;
  const lig = ctx.tryGet('lighting');
  const undo = [];
  if (t === 'nosun') for (const l of lig.csm.lights) undo.push(window.__pin(l, 'intensity', 0));
  if (t === 'nofill') undo.push(window.__pin(lig.fill, 'intensity', 0));
  if (t === 'nobounce') undo.push(window.__pin(lig.bounce, 'intensity', 0));
  if (t === 'noibl') undo.push(window.__pin(ctx.scene, 'environmentIntensity', 0));
  /*
   * `metal` is not a light term. It re-runs the measurement that reproduced across two
   * workstreams: pushing the soldier kit to a true metal F0 makes armour *darker* and
   * bluer. That is the signature of a probe too weak to pay for the diffuse term metalness
   * removes, so it is the same defect as the ambient shortfall seen from the other end —
   * and if a correctly-united fill fixes the ambient, this arm should stop inverting.
   */
  if (t === 'metal') {
    const seen = [];
    ctx.scene.traverse((o) => {
      if (!o.isMesh || !/^(soldiers|horses)/.test(o.name || '')) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (m && m.metalness !== undefined && !seen.includes(m)) seen.push(m);
      }
    });
    for (const m of seen) {
      /*
       * Pinning `metalness` to 1 is a no-op and the first version of this arm duly reported a
       * delta of exactly 0.0000: the soldier material already ships `metalness: 1`, and the
       * value that actually varies is `metalnessMap.b` per texel. Driving the kit to a true
       * metal F0 means removing the map's modulation, not raising the factor it modulates.
       */
      const um = window.__pin(m, 'metalnessMap', null);
      const uv = window.__pin(m, 'metalness', 1);
      // Dropping a map flips a shader define, so this needs a real recompile, not just a
      // uniform refresh.
      m.needsUpdate = true;
      undo.push(() => { um(); uv(); m.needsUpdate = true; });
    }
  }
  /*
   * `notint` neutralises the grade's warm/cool split so the *scene's own* shadow-to-lit hue
   * ratio can be read directly.
   *
   * Kept after the split-space bug was fixed, because it is the only way to see how much of
   * the finished frame's warm/cool separation is the render's own and how much the grade
   * manufactures. Post-fix it reads 1.333 against a graded 2.000, i.e. the scene contributes
   * about a third and the grade the rest.
   *
   * The arithmetic that motivated it: `uShadowTint` is b/r 1.18/0.9 = 1.311 and
   * `uHighlightTint` is 0.82/1.18 = 0.695, so the grade multiplies the darkest quartile's
   * blue-to-red against the rest of the frame by 1.311/0.695 = 1.887. We measure 1.228 on the
   * finished frame. Since the tint is a plain multiply it cannot lose part of itself, which
   * means the scene arriving at the grade already carries a ratio of 1.228/1.887 = 0.651 —
   * shadows *warmer* than lit surfaces, and the grade spends its entire budget climbing out of
   * that before it can produce any split at all. This arm tests that prediction: with both
   * tints neutral the measured separation should land near 0.651, not near 1.0.
   */
  if (t === 'notint') {
    const fx = ctx.tryGet('postfx');
    const mats = [];
    for (const k of Object.keys(fx)) {
      const v = fx[k];
      if (v && v.uniforms && v.uniforms.uShadowTint) mats.push(v);
    }
    for (const m of mats) {
      const s = m.uniforms.uShadowTint.value.clone();
      const h = m.uniforms.uHighlightTint.value.clone();
      m.uniforms.uShadowTint.value.set(1, 1, 1);
      m.uniforms.uHighlightTint.value.set(1, 1, 1);
      undo.push(() => {
        m.uniforms.uShadowTint.value.copy(s);
        m.uniforms.uHighlightTint.value.copy(h);
      });
    }
    window.__notintCount = mats.length;
  }
  /*
   * `noao` removes the ambient-occlusion map from the soldier kit.
   *
   * three.js applies `aoMap` to the *indirect* term only — `material.aoMap` multiplies
   * `iblIrradiance` and the light-probe irradiance, never the direct sun. On a crowd whose
   * shadowed side is already three times darker than the ground it stands on, an AO map is
   * attenuating precisely the light that is in shortest supply, and only where it is shortest.
   * This measures how much of the dark tail it accounts for.
   */
  if (t === 'noao') {
    const seen = [];
    ctx.scene.traverse((o) => {
      if (!o.isMesh || !/^(soldiers|horses)/.test(o.name || '')) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (m && m.aoMap && !seen.includes(m)) seen.push(m);
      }
    });
    for (const m of seen) {
      const u = window.__pin(m, 'aoMapIntensity', 0);
      m.needsUpdate = true;
      undo.push(() => { u(); m.needsUpdate = true; });
    }
    window.__noaoCount = seen.length;
  }
  window.__undo = undo;
}, [term, TERM_JS]);

const restore = () => page.evaluate(() => {
  for (const u of window.__undo ?? []) u();
  window.__undo = [];
});

let simTime = 0;
const summary = [];

for (const name of requested) {
  const s = SHOTS[name];
  if (!s) { console.error(`unknown shot ${name}`); continue; }
  console.log(`\n=== ${name} ===`);

  const need = s.at - simTime;
  await page.evaluate(async (dt) => {
    // Unpaused only while seeking, so the seek is the one place the world is allowed to move.
    window.__game.engine.time.paused = false;
    if (dt > 0.05) await window.__game.advance(dt);
  }, need);
  if (need > 0.05) simTime = s.at;
  curShot = s;
  await page.evaluate((c) => {
    window.__game.setCamera(c.x, c.z, c.zoom, c.yaw);
    window.__game.engine.time.paused = true;
  }, s);
  await step(8);

  // --- 1. analytic irradiance budget ---------------------------------------
  const budget = await page.evaluate(() => {
    const ctx = window.__game.engine.context;
    const sky = ctx.tryGet('sky');
    const lig = ctx.tryGet('lighting');
    const cam = ctx.camera;
    const L = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const v3 = (c) => [+c.r.toFixed(4), +c.g.toFixed(4), +c.b.toFixed(4)];

    const fill = lig.fill;
    const bounce = lig.bounce;
    const envI = ctx.scene.environmentIntensity;

    // Hemisphere irradiance for a normal, exactly as three.js computes it:
    //   w = 0.5 * dot(n, up) + 0.5 ;  E = mix(ground, sky, w) * intensity
    const hemi = (ny) => {
      const w = 0.5 * ny + 0.5;
      const mix = (a, b) => a + (b - a) * w;
      return [
        mix(fill.groundColor.r, fill.color.r) * fill.intensity,
        mix(fill.groundColor.g, fill.color.g) * fill.intensity,
        mix(fill.groundColor.b, fill.color.b) * fill.intensity,
      ];
    };
    const lum3 = (a) => 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];

    const sunLum = sky.sunIntensity;
    const elev = Math.asin(sky.sunDirection.y);

    // What the sky's own integral says its irradiance is. skyFillRadiance returns the
    // cosine-weighted MEAN RADIANCE over the hemisphere, so the irradiance onto an
    // up-facing surface is pi times it — that is the definition, not a fudge.
    const skyRad = L(sky.skyFillColour);
    const skyIrradiancePhysical = Math.PI * skyRad;

    // Soldier material, for the probe gain that actually reaches a man.
    let sol = null;
    ctx.scene.traverse((o) => {
      if (sol || !o.isMesh || !/^soldiers/.test(o.name || '')) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m) return;
      sol = {
        name: o.name,
        envMapIntensity: m.envMapIntensity, aoMapIntensity: m.aoMapIntensity,
        roughness: m.roughness, metalness: m.metalness,
        hasEnvMap: !!(m.envMap || ctx.scene.environment),
      };
    });

    return {
      exposure: sky.preset.exposure,
      sunElevDeg: +((elev * 180) / Math.PI).toFixed(1),
      sunIntensity: +sunLum.toFixed(4),
      sunColour: v3(sky.sunColour),
      sunOnLevelGround: +(sunLum * Math.sin(elev)).toFixed(4),
      skyFillColour: v3(sky.skyFillColour),
      // Stamps which build the frame came from. `undefined` means the scalar-albedo code is
      // running; a triple means the chromatic bounce is in. Two runs in this session were
      // ambiguous about which tree they had loaded, and an assumption about that is exactly
      // the kind of thing that has already cost this workstream three bad measurements.
      groundBounceAlbedo: sky.groundBounceAlbedo
        ? [sky.groundBounceAlbedo.x, sky.groundBounceAlbedo.y, sky.groundBounceAlbedo.z]
          .map((n) => +n.toFixed(4))
        : null,
      skyMeanRadiance: +skyRad.toFixed(4),
      skyIrradiancePhysical: +skyIrradiancePhysical.toFixed(4),
      fillColour: v3(fill.color), fillGround: v3(fill.groundColor),
      fillIntensity: +fill.intensity.toFixed(4),
      hemiUp: +lum3(hemi(1)).toFixed(4),
      hemiSide: +lum3(hemi(0)).toFixed(4),
      hemiDown: +lum3(hemi(-1)).toFixed(4),
      // The whole point: hemisphere delivers `colour * intensity` as irradiance, so the
      // intensity that would make it physically correct is pi, not 0.34.
      hemiFractionOfPhysical: +(lum3(hemi(1)) / Math.max(1e-6, skyIrradiancePhysical)).toFixed(4),
      bounceIntensity: +bounce.intensity.toFixed(4),
      bounceColour: v3(bounce.color),
      envMapIntensityScene: +envI.toFixed(4),
      soldier: sol,
      soldierProbeGain: sol ? +(sol.envMapIntensity * envI).toFixed(4) : null,
      camY: +cam.position.y.toFixed(1),
    };
  });

  const b = budget;
  console.log(`exposure ${b.exposure}  sun elev ${b.sunElevDeg}deg  sun perp ${b.sunIntensity}  on level ground ${b.sunOnLevelGround}`);
  console.log(`sky integral: mean radiance ${b.skyMeanRadiance} -> physical irradiance pi*L = ${b.skyIrradiancePhysical}`);
  console.log(`BUILD STAMP groundBounceAlbedo ${b.groundBounceAlbedo ?? 'ABSENT (scalar-albedo build)'}`);
  console.log(`hemisphere fill: colour ${b.fillColour} ground ${b.fillGround} intensity ${b.fillIntensity}`);
  console.log(`  E(up) ${b.hemiUp}  E(side) ${b.hemiSide}  E(down) ${b.hemiDown}  -> ${(b.hemiFractionOfPhysical * 100).toFixed(1)}% of the sky's own physical irradiance`);
  console.log(`bounce ${b.bounceIntensity}   scene.environmentIntensity ${b.envMapIntensityScene}   soldier envMapIntensity ${b.soldier?.envMapIntensity} -> probe gain ${b.soldierProbeGain}`);

  // --- 2. masks -------------------------------------------------------------
  const sol = await maskFor('^(soldiers|horses)', `${name}-sol`);
  const gnd = await maskFor('^terrain$', `${name}-gnd`);
  const f3 = (x) => x.toFixed(4);
  console.log(`masks: soldier ${sol.count}px (${(sol.frac * 100).toFixed(1)}% of frame, ${sol.mats} mats)   ground ${gnd.count}px`);

  /*
   * --- 3. term isolation, with `base` measured first *and last* -------------
   *
   * `base` runs through exactly the same pin/step/shoot path as every other arm, and it runs
   * twice. The first pass supplies the reference statistics; the pair supplies a drift floor,
   * which is the only way to know a term's delta is a light and not the harness. An earlier
   * revision took the reference before the mask flashes and every arm afterwards came back
   * *brighter* than it, reporting the sun as a negative contributor — a comparison between
   * two different points in the frame's own settling, not between two lighting rigs.
   */
  const arms = ['base', 'nosun', 'nofill', 'nobounce', 'noibl', 'metal', 'notint', 'noao', 'base2'];
  const res = {};
  for (const t of arms) {
    await statesFor(t === 'base2' ? 'base' : t);
    await step(10);
    const readback = await page.evaluate(() => {
      const ctx = window.__game.engine.context;
      const lig = ctx.tryGet('lighting');
      const c = ctx.camera;
      // Camera state travels with every arm. Two revisions of this probe have now been
      // wrecked by the frames being differenced not being the same frame, and a number that
      // proves the viewpoint held is worth more than any amount of reasoning that it should.
      return {
        sun: +lig.csm.lights.map((l) => l.intensity).reduce((a, c2) => a + c2, 0).toFixed(4),
        fill: +lig.fill.intensity.toFixed(4),
        bounce: +lig.bounce.intensity.toFixed(4),
        env: +ctx.scene.environmentIntensity.toFixed(4),
        cam: [c.position.x, c.position.y, c.position.z].map((v) => +v.toFixed(2)),
        fov: +c.fov.toFixed(2),
        simTime: +window.__game.simTime().toFixed(3),
      };
    });
    const p = await shot(`${name}-${t}`);
    const r = await raw(p);
    const all = new Uint8Array(r.info.width * r.info.height).fill(1);
    res[t] = {
      readback,
      soldier: statsOver(r, sol.mask),
      ground: statsOver(r, gnd.mask),
      frame: statsOver(r, all),
      quartile: quartileStats(r),
      population: quartilePopulation(r, sol.mask),
    };
    await restore();
    await step(4);
  }

  const sStat = res.base.soldier;
  const gStat = res.base.ground;
  const fStat = res.base.frame;
  console.log(`  soldier  mean ${f3(sStat.mean)}  p05 ${f3(sStat.p05)} p25 ${f3(sStat.p25)} p50 ${f3(sStat.p50)} p75 ${f3(sStat.p75)} p95 ${f3(sStat.p95)}  rgb ${sStat.rgb.map(f3).join('/')}`);
  console.log(`  ground   mean ${f3(gStat.mean)}  p05 ${f3(gStat.p05)} p25 ${f3(gStat.p25)} p50 ${f3(gStat.p50)} p75 ${f3(gStat.p75)} p95 ${f3(gStat.p95)}`);
  console.log(`  frame    mean ${f3(fStat.mean)}  p05 ${f3(fStat.p05)} p25 ${f3(fStat.p25)} p50 ${f3(fStat.p50)} p75 ${f3(fStat.p75)} p95 ${f3(fStat.p95)}`);
  console.log(`  man:ground ${(sStat.mean / Math.max(1e-6, gStat.mean)).toFixed(3)}   plates: frame mean 0.2957 display / 0.1068 linear`);
  console.log(`  CHROMA  soldier b/r ${sStat.bOverR.toFixed(3)} cool ${(sStat.coolFrac * 100).toFixed(1)}%   ground b/r ${gStat.bOverR.toFixed(3)} cool ${(gStat.coolFrac * 100).toFixed(1)}%   frame b/r ${fStat.bOverR.toFixed(3)} cool ${(fStat.coolFrac * 100).toFixed(1)}%`);
  console.log(`  slab index (soldier b/r divided by ground b/r) ${(sStat.bOverR / Math.max(1e-6, gStat.bOverR)).toFixed(3)}  — 1.0 means the crowd is the same temperature as the field it stands in`);
  const qz = res.base.quartile;
  console.log(`  ACCEPTANCE  darkest-quartile luminance ${qz.darkQLum.toFixed(4)}  (plates 0.1172 — must not rise above 0.159)`);
  console.log(`              darkest-quartile b/r ${qz.darkQbr.toFixed(3)} vs rest ${qz.restBr.toFixed(3)} -> warm/cool separation ${qz.darkQRatio.toFixed(3)}  (plates 1.968 — ours was 1.11, wants to RISE)`);
  console.log(`  drift floor (base vs base2): soldier ${f3(Math.abs(sStat.mean - res.base2.soldier.mean))}  ground ${f3(Math.abs(gStat.mean - res.base2.ground.mean))}`);
  console.log(`  base cam ${res.base.readback.cam} fov ${res.base.readback.fov} t ${res.base.readback.simTime}`);
  console.log(`  base2 cam ${res.base2.readback.cam} fov ${res.base2.readback.fov} t ${res.base2.readback.simTime}`);
  console.log('  term isolation — mean display luminance with that term pinned to zero:');
  for (const t of ['nosun', 'nofill', 'nobounce', 'noibl']) {
    const v = res[t];
    const dS = sStat.mean - v.soldier.mean;
    const dG = gStat.mean - v.ground.mean;
    const rb = v.readback;
    console.log(`    ${t.padEnd(8)} [sun ${rb.sun} fill ${rb.fill} bounce ${rb.bounce} env ${rb.env}] cam ${rb.cam} fov ${rb.fov} t ${rb.simTime}`);
    console.log(`             soldier ${f3(v.soldier.mean)} (-${f3(dS)}, ${((dS / Math.max(1e-6, sStat.mean)) * 100).toFixed(1)}%)   ground ${f3(v.ground.mean)} (-${f3(dG)}, ${((dG / Math.max(1e-6, gStat.mean)) * 100).toFixed(1)}%)`);
  }

  /*
   * The metalness inversion, reported explicitly because it is a second symptom of the same
   * root cause and the direction of the sign is the whole result.
   *
   * On record from two workstreams: pushing the kit to a true metal F0 made armour *darker*
   * (0.0354 -> 0.0329 linear) and *bluer* (1.60 -> 1.93). Metal has no diffuse lobe, so
   * raising metalness trades a sun-lit diffuse term for a reflection of the probe — and under
   * a probe whose lower hemisphere was achromatic and outvoted, that trade lost both light and
   * warmth. If a warm bounce below and a cool sky above turns this arm around, so that more
   * metal now means brighter and warmer armour, then the inversion was never a material bug.
   */
  const pop = res.base.population;
  console.log(`  POPULATION  soldiers are ${(pop.soldierShareOfFrame * 100).toFixed(1)}% of the frame but ${(pop.soldierShareOfDarkQ * 100).toFixed(1)}% of its darkest quartile; ${(pop.soldierPixelsInDarkQ * 100).toFixed(1)}% of soldier pixels fall inside that quartile`);
  console.log(`              ${pop.soldierShareOfDarkQ > 0.5 ? 'men DOMINATE the darkest quartile — lifting them moves the critic\'s frame metric too' : "men are a MINORITY of the darkest quartile — a man-selective lift barely touches the critic's frame metric"}`);

  const tArm = res.notint;
  if (tArm) {
    const q = tArm.quartile;
    const graded = res.base.quartile.darkQRatio;
    console.log(`  GRADE       tints neutralised: separation ${q.darkQRatio.toFixed(3)}  (graded ${graded.toFixed(3)}; the tints are built to multiply by 1.887)`);
    console.log(`              grade delivers x${(graded / Math.max(1e-6, q.darkQRatio)).toFixed(3)} of its designed x1.887 -> ${Math.abs(graded / Math.max(1e-6, q.darkQRatio) - 1.887) < 0.25 ? 'the grade is WORKING; the scene arrives with shadows warmer than lit' : 'something downstream IS eating the tint'}`);
  }


  const aArm = res.noao;
  if (aArm) {
    const a = aArm.soldier, b = sStat;
    console.log(`  AO MAP      aoMapIntensity 0.3 -> 0 on the kit: soldier p05 ${b.p05.toFixed(4)} -> ${a.p05.toFixed(4)}, p25 ${b.p25.toFixed(4)} -> ${a.p25.toFixed(4)}, mean ${b.mean.toFixed(4)} -> ${a.mean.toFixed(4)}`);
    console.log(`              the AO map is costing the dark tail ${((a.p25 / Math.max(1e-6, b.p25) - 1) * 100).toFixed(1)}% at p25 and ${((a.mean / Math.max(1e-6, b.mean) - 1) * 100).toFixed(1)}% at the mean`);
  }

  const mArm = res.metal;
  if (mArm) {
    const dL = mArm.soldier.mean - sStat.mean;
    const dB = mArm.soldier.bOverR - sStat.bOverR;
    console.log(`  METALNESS metalness=1 on the kit: soldier ${f3(sStat.mean)} -> ${f3(mArm.soldier.mean)} (${dL >= 0 ? '+' : ''}${f3(dL)}), b/r ${sStat.bOverR.toFixed(3)} -> ${mArm.soldier.bOverR.toFixed(3)} (${dB >= 0 ? '+' : ''}${dB.toFixed(3)})`);
    console.log(`            ${dL >= 0 ? 'BRIGHTENS' : 'DARKENS'} and ${dB <= 0 ? 'WARMS' : 'COOLS'} — the recorded inversion is ${dL >= 0 && dB <= 0 ? 'RESOLVED' : 'still present'}`);
  }

  summary.push({ name, budget: b, soldier: sStat, ground: gStat, frame: fStat, masks: { soldier: sol.count, ground: gnd.count }, terms: res });
}

await writeFile(path.join(OUT, `${TAG || 'run'}summary.json`), JSON.stringify(summary, null, 2));
console.log(`\nframes -> ${path.relative(ROOT, OUT)}`);

await browser.close();
if (server && !KEEP) server.kill('SIGTERM');
else if (server) console.log(`(server left running on ${PORT}; --keep)`);
