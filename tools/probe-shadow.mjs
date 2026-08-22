#!/usr/bin/env node
/**
 * Shadow / AO attribution probe.
 *
 * Six blind critics all named the same defect: soldiers do not appear to sit in the ground
 * and do not shadow one another. "Appear" is not a measurement, so this answers it
 * numerically.
 *
 * The metric is a **darkened-pixel fraction**, not a mean absolute difference. A plain MAD
 * is useless here: TAA cycles an 8-tap Halton jitter and the grade adds grain, so two
 * consecutive frames of an unchanged scene already differ by a mean of ~26/255. Both of
 * those are low-amplitude and zero-mean, while a shadow is a 30-60 % darkening. So each
 * A/B counts the pixels that got *darker by more than a threshold* when a caster was
 * switched on, which is insensitive to jitter and directly answers "how much of this frame
 * is shadow, and who cast it".
 *
 * Reported per camera:
 *   noise      A vs A' one frame apart, no change at all — the floor every figure below
 *              must clear.
 *   allShadow  everything that casts, vs `shadowMap.enabled = false`.
 *   crowd      the soldier/horse/engine tiers only, vs the same frame with their
 *              `castShadow` cleared. This is the number the critics were reading.
 *   ao         the HBAO pass, vs `quality.ssao = false`.
 *   contact    the screen-space contact pass alone, vs `postfx.contactShadows = false`.
 *              Reported separately from `ao` because the two are composited with a `min`:
 *              wherever HBAO is already the darker term, the contact pass changes nothing
 *              and the `ao` arm cannot tell you whether it contributed at all. Blind critics
 *              kept naming absent contact shadowing while this pass was demonstrably
 *              running, and only measuring it on its own settles that.
 *
 * Also dumps, per cascade, the fitted ortho extent and its texel footprint in metres. A man
 * is ~0.5 m across, so a cascade whose texel exceeds ~0.25 m cannot hold his silhouette at
 * all, and a PCF radius quoted in texels multiplies that footprint again.
 *
 *   node tools/probe-shadow.mjs --port=5391 --shots=clash,romanline
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Cameras chosen to put crowds at the ranges the critics complained about. */
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
const PORT = Number(args.get('port') ?? 5391);
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/probe-shadow');
const TAG = args.get('tag') ?? '';
const GRAPH = args.has('graph');
/** Darkening, in 8-bit sRGB units, that counts as "this pixel is in shadow". */
const DARK = Number(args.get('dark') ?? 12);
const requested = args.get('shots') ? String(args.get('shots')).split(',') : ['romanline', 'clash'];

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

let server = null;
const base = `http://127.0.0.1:${PORT}`;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) throw new Error('vite did not start');
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('  ! page error:', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}&nohud=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });
// The same DOM strip `shoot.mjs --nohud` uses, so the HUD cannot enter the statistics.
// Hiding `body > *:not(canvas)` instead looks equivalent and is not: the canvas sits inside
// a wrapper, so that selector hides the render surface and every metric reads a flat 6/255.
await page.addStyleTag({
  content: '#hud-root, #loading { display: none !important; visibility: hidden !important; }',
});

await mkdir(OUT, { recursive: true });

const grey = (buf, info, i) => {
  const o = i * info.channels;
  return 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
};

/**
 * How much darker `darkPng` is than `lightPng`.
 *
 * Two figures, both deliberately insensitive to TAA. The chain jitters the projection over
 * an 8-tap Halton sequence and keeps a temporal history, so two frames of a *completely*
 * unchanged scene differ per-pixel by more than a shadow does — measured at a 48 % noise
 * floor on the clash camera with a naive per-pixel threshold, which is larger than every
 * signal this probe exists to find.
 *
 *   dLum   mean luminance over the whole frame, differenced. Sub-pixel jitter cannot move
 *          a frame mean, so this is a clean scalar: the noise floor lands near 0.1/255.
 *   frac   fraction of pixels darkened past DARK, measured after a 4x area downsample.
 *          Jitter is sub-pixel and averages out of a 4x4 box; a man's shadow at mid
 *          distance is several pixels across and survives it.
 */
async function darkFraction(lightPng, darkPng) {
  const small = (p) => sharp(p).resize(Math.round(W / 4), Math.round(H / 4), { kernel: 'linear', fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  const [L, D] = await Promise.all([small(lightPng), small(darkPng)]);
  const n = L.info.width * L.info.height;
  let hit = 0;
  let depth = 0;
  let sumL = 0;
  let sumD = 0;
  let sumHitL = 0;
  let sumHitD = 0;
  for (let i = 0; i < n; i++) {
    const l = grey(L.data, L.info, i);
    const k = grey(D.data, D.info, i);
    sumL += l;
    sumD += k;
    if (l - k > DARK) { hit++; depth += l - k; sumHitL += l; sumHitD += k; }
  }
  return {
    frac: hit / n, meanDepth: hit ? depth / hit : 0, dLum: (sumL - sumD) / n,
    // Over the pixels the effect actually touched, how much of the lit value survives.
    // This is the empirical "the sun is blocked here" multiplier — the number a
    // screen-space contact shadow has to reproduce rather than invent.
    ratio: hit ? sumHitD / Math.max(1e-6, sumHitL) : 1,
  };
}

/** Luminance percentiles of a frame, for the dynamic-range criterion. */
async function levels(png) {
  const r = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const n = r.info.width * r.info.height;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.round(grey(r.data, r.info, i)))]++;
  const pct = (p) => {
    let acc = 0;
    const want = n * p;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= want) return v; }
    return 255;
  };
  return { p01: pct(0.01), p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) };
}

const shot = (name) => page.screenshot({ path: path.join(OUT, `${TAG}${name}.png`) });
/**
 * Re-render without advancing the world.
 *
 * **The claim this comment used to make was false and every figure below depended on it.**
 * It said `advance(1e-6, 1e-3)` was "one frame carrying one microsecond of time", so the
 * fixed step never fired and nothing moved. It is not. `Engine.advance` seeds its timestamp
 * from `time.elapsed`, a cumulative sum of *clamped* frame deltas, while `Time.beginFrame`
 * differences its argument against `lastNow`, which holds the previous raw timestamp. Those
 * are two different clocks, so from the second call onward the difference saturates the
 * 0.25 s clamp and `maxStepsPerFrame` runs its full five fixed ticks. Measured through
 * `simTime()`, each call advances the battle by about 0.13 s — men march, dust rolls, and
 * corpses fall between the two frames this probe calls "no change at all".
 *
 * That makes the reported `noise floor` a noise floor *for a moving world*, which is far too
 * generous: every shadow figure here is declared to clear it, so shadow work has been passing
 * against a bar that was never valid. Same defect as the shot harness charging five sim ticks
 * to each rendered frame, which made this project's fps history roughly double the truth.
 *
 * `Time.beginFrame` scales its delta by `paused ? 0 : gameSpeed`, so pausing freezes `simTime`
 * outright and the identical world state is re-rendered — which is what the old comment
 * described and never delivered. `--nopause` restores the old behaviour so the two can be
 * compared in one session.
 */
const PAUSE = !args.has('nopause');
const SETTLE = Number(args.get('settle') ?? 3);
const step = (n = SETTLE) => page.evaluate((k) => {
  for (let i = 0; i < k; i++) window.__game.engine.advance(1e-6, 1e-3);
}, n);

let simTime = 0;
const summary = [];
for (const name of requested) {
  const s = SHOTS[name];
  if (!s) { console.error(`unknown shot ${name}`); continue; }
  console.log(`\n=== ${name} ===`);

  const need = s.at - simTime;
  await page.evaluate(async (dt) => {
    // Unpaused only to seek: the seek is the one place the world may move.
    window.__game.engine.time.paused = false;
    if (dt > 0.05) await window.__game.advance(dt);
  }, need);
  if (need > 0.05) simTime = s.at;
  await page.evaluate(async ([c, pause]) => {
    window.__game.setCamera(c.x, c.z, c.zoom, c.yaw);
    await window.__game.advance(0.25);
    window.__game.engine.time.paused = pause;
  }, [s, PAUSE]);

  const info = await page.evaluate(() => {
    const ctx = window.__game.engine.context;
    const cam = ctx.camera;
    const sky = ctx.tryGet('sky');
    const csm = ctx.tryGet('lighting')?.csm;

    // Sun azimuth relative to the camera's forward vector: 0 = sun straight ahead (shadows
    // point at the camera and are hidden behind their casters), +-180 = sun behind the
    // camera (shadows point away, also largely hidden), +-90 = raking across the frame.
    const e = cam.matrixWorld.elements;
    const fwd = { x: -e[8], z: -e[10] };
    const sd = sky?.sunDirection;
    const sunRel = sd ? Math.atan2(sd.x * fwd.z - sd.z * fwd.x, sd.x * fwd.x + sd.z * fwd.z) : null;

    const cascades = (csm?.lights ?? []).map((l, i) => {
      const c = l.shadow.camera;
      const texel = (c.right - c.left) / csm.shadowMapSize;
      return {
        i,
        splitFarM: csm.breaks ? +(csm.breaks[i] * (csm.maxFar - cam.near) + cam.near).toFixed(1) : null,
        orthoW: +(c.right - c.left).toFixed(1),
        texelM: +texel.toFixed(4),
        blurM: +(texel * l.shadow.radius).toFixed(3),
        normalBias: +l.shadow.normalBias.toFixed(4),
        radius: +l.shadow.radius.toFixed(2),
      };
    });

    // Unit tiers are `THREE.Mesh` + InstancedBufferGeometry under an unnamed Group, so they
    // must be found by mesh name, not by scene-graph node.
    const tiers = [];
    ctx.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (!/^(soldiers|horses|engine)/.test(o.name || '')) return;
      tiers.push({
        name: o.name, vis: o.visible, cast: o.castShadow, cdm: !!o.customDepthMaterial,
        inst: o.geometry?.instanceCount ?? -1,
      });
    });

    return {
      camPos: [cam.position.x, cam.position.y, cam.position.z].map((v) => +v.toFixed(1)),
      fov: +cam.fov.toFixed(1), orbitRadius: +ctx.rig.orbitRadius.toFixed(1),
      sunElevDeg: sd ? +((Math.asin(sd.y) * 180) / Math.PI).toFixed(1) : null,
      sunRelDeg: sunRel === null ? null : +((sunRel * 180) / Math.PI).toFixed(0),
      shadowMapSize: csm?.shadowMapSize ?? null, maxFar: csm ? +csm.maxFar.toFixed(0) : null,
      cascades, tiers,
    };
  });

  console.log(`cam ${info.camPos} orbit ${info.orbitRadius}m fov ${info.fov}  sun elev ${info.sunElevDeg}deg  sun-vs-camera ${info.sunRelDeg}deg (+-90 = raking)`);
  console.log(`csm map ${info.shadowMapSize} maxFar ${info.maxFar}m`);
  for (const c of info.cascades) {
    console.log(`  cascade ${c.i}: ->${c.splitFarM}m  ortho ${c.orthoW}m  texel ${c.texelM}m  pcf radius ${c.radius} = ${c.blurM}m blur  nBias ${c.normalBias}m`);
  }
  const vis = info.tiers.filter((t) => t.vis);
  console.log(`unit tiers visible: ${vis.map((t) => `${t.name}(${t.inst}${t.cast ? ',cast' : ',NOCAST'}${t.cdm ? ',cdm' : ''})`).join(' ') || 'none'}`);
  if (GRAPH) await writeFile(path.join(OUT, `${TAG}${name}.tiers.json`), JSON.stringify(info.tiers, null, 2));

  // --- reference frame + noise floor ---------------------------------------
  const A = await shot(`${name}-A`);
  await step();
  const A2 = await shot(`${name}-A2`);
  const noise = await darkFraction(A, A2);

  // --- everything that casts ------------------------------------------------
  /*
   * `shadowMap.enabled` is a *compile-time* switch: three writes USE_SHADOWMAP into every
   * program from it. Flipping the flag alone leaves the shaders sampling the last shadow map
   * rendered, which is still resident, so the frame does not change at all — this arm reported
   * dLum 0.000/255 over 0.00% of the frame while the crowd-only arm beside it reported 9.7,
   * which is self-contradictory and is what gave it away. Every material has to be marked for
   * recompile on the way in and on the way out.
   */
  const markAll = (on) => page.evaluate((v) => {
    const ctx = window.__game.engine.context;
    ctx.renderer.shadowMap.enabled = v;
    ctx.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) m.needsUpdate = true;
    });
  }, on);
  await markAll(false);
  await step();
  const noAll = await shot(`${name}-noshadow`);
  await markAll(true);
  await step();
  const allShadow = await darkFraction(noAll, A);

  /*
   * Blocker-search radius, A/B'd in this same session.
   *
   * It has to be in-session. Two runs of this probe at identical configuration differ on
   * 50-70 % of pixels with a mean of 17-27/255, because the dust and particle VFX reseed per
   * session even with the sim clock paused — so a before/after built from two separate runs
   * cannot resolve a shadow filter change, and an eye comparison across them is worthless.
   * TC_SEARCH_TEXELS is guarded by #ifndef precisely so it can be overridden here.
   */
  const setSearch = (v) => page.evaluate((val) => {
    const ctx = window.__game.engine.context;
    let n = 0;
    ctx.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        m.defines = m.defines || {};
        if (val === null) delete m.defines.TC_SEARCH_TEXELS;
        else m.defines.TC_SEARCH_TEXELS = val;
        m.needsUpdate = true;
        n++;
      }
    });
    return n;
  }, v);
  const nSearch = await setSearch('3.0');
  await step();
  const searchNarrow = await shot(`${name}-search3`);
  await setSearch(null);
  await step();
  const searchWide = await darkFraction(searchNarrow, A);

  // --- the crowd only -------------------------------------------------------
  const flipped = await page.evaluate(() => {
    window.__probeSaved = [];
    window.__game.engine.context.scene.traverse((o) => {
      if (!o.isMesh || !o.castShadow) return;
      if (!/^(soldiers|horses|engine)/.test(o.name || '')) return;
      window.__probeSaved.push(o);
      o.castShadow = false;
    });
    return window.__probeSaved.length;
  });
  await step();
  const noCrowd = await shot(`${name}-nocrowdcast`);
  await page.evaluate(() => {
    for (const o of window.__probeSaved ?? []) o.castShadow = true;
    window.__probeSaved = [];
  });
  await step();
  const crowd = await darkFraction(noCrowd, A);

  // --- the AO pass ----------------------------------------------------------
  await page.evaluate(() => { window.__game.engine.quality.ssao = false; });
  await step();
  const noAo = await shot(`${name}-noao`);
  await page.evaluate(() => { window.__game.engine.quality.ssao = true; });
  await step();
  const ao = await darkFraction(noAo, A);

  // --- the screen-space contact pass ----------------------------------------
  // Separated from `hbao` because they are composited with a `min`, so the AO arm above
  // cannot tell you whether the contact term contributed anything of its own: wherever HBAO
  // is already the darker of the two, switching contact off changes nothing. Three blind
  // critics have now named absent contact shadowing while this pass was demonstrably
  // running, and the only way to settle that is to measure the pass on its own.
  await page.evaluate(() => {
    const p = window.__game.engine.context.tryGet('postfx');
    if (p) p.contactShadows = false;
  });
  await step();
  const noContact = await shot(`${name}-nocontact`);
  await page.evaluate(() => {
    const p = window.__game.engine.context.tryGet('postfx');
    if (p) p.contactShadows = true;
  });
  await step();
  const contact = await darkFraction(noContact, A);

  const lv = await levels(A);
  const pc = (x) => `${(x * 100).toFixed(2)}%`;
  const row = (label, r, extra = '') => console.log(
    `${label.padEnd(16)} dLum ${r.dLum.toFixed(3).padStart(7)}/255   area ${pc(r.frac).padStart(7)}  depth ${r.meanDepth.toFixed(1).padStart(5)}/255  survives ${r.ratio.toFixed(3)} ${extra}`);
  row('noise floor', noise, '(the floor the rest must clear)');
  row('all shadows', allShadow);
  row('search 9->3', searchWide, `(blocker-search disc narrowed on ${nSearch} materials, in-session)`);
  row('crowd shadows', crowd, `(${flipped} tiers flipped)`);
  row('hbao', ao);
  row('contact ss', contact, '(min-composited with hbao, so this is its own marginal share)');
  console.log(`levels p01 ${lv.p01} p05 ${lv.p05} p50 ${lv.p50} p95 ${lv.p95} p99 ${lv.p99}`);
  summary.push({
    name, noise, allShadow, crowd, ao, contact,
    levels: lv, cascades: info.cascades, sunRelDeg: info.sunRelDeg,
  });
}

await writeFile(path.join(OUT, `${TAG || 'run'}summary.json`), JSON.stringify(summary, null, 2));
console.log(`\nframes -> ${path.relative(ROOT, OUT)}`);

await browser.close();
if (server) server.kill('SIGTERM');
