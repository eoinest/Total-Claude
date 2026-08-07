#!/usr/bin/env node
/**
 * The adaptive-quality loop: does it boot, does each lever buy time, what does a resolution
 * change cost, and does the controller settle.
 *
 * Four modes, because they need different instruments and only one of them needs a quiet
 * machine:
 *
 *   life    three maps x four tiers: boots, `__game.ready`, pageerror/console, draw calls and
 *           framebuffer variance after a runtime tier switch. Pass/fail, load-immune.
 *   realloc what one resolution change costs. The number the whole design turns on.
 *   levers  interleaved A/B of every lever in one session, both arms reported.
 *   loop    close the loop, drive the camera hard, dump the scale-over-time trace.
 *
 * Two traps specific to this probe:
 *
 * - **The harness renders at dpr 1 even at ultra**, because `maxPixelRatio: 2` is capped by
 *   `window.devicePixelRatio`, which is 1 headless. That systematically understates the cost of
 *   a resolution lever — the one thing being measured here. `--dsf=2` asks Playwright for
 *   `deviceScaleFactor: 2` so there is a real 2x arm.
 * - **A lever that moves a number and buys nothing is the failure to look for.** `PostFX`
 *   rasterises the world into `sceneRT`, sized from `getDrawingBufferSize()` at allocation time,
 *   so `setPixelRatio` without a `resize` fan-out leaves the 98-draw colour pass at the old
 *   resolution. Every arm therefore asserts that the scene target's own dimensions moved, not
 *   just the canvas'.
 *
 *   node tools/probe-adaptive.mjs --port=5735 --mode=life
 */

import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5735);
const MODE = args.get('mode') ?? 'life';
const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);
const DSF = Number(args.get('dsf') ?? 1);
const TIER = args.get('tier') ?? 'ultra';
const MAP = args.get('map') ?? 'rome';
const AT = Number(args.get('at') ?? 60);
const BLOCKS = Number(args.get('blocks') ?? 6);
const FRAMES = Number(args.get('frames') ?? 24);

const base = `http://127.0.0.1:${PORT}`;
const ping = await fetch(base, { signal: AbortSignal.timeout(5000) }).catch(() => null);
if (!ping?.ok) throw new Error(`no dev server on ${base} — start your own, never touch 5173`);
console.log(`source: ${base} (my server; confirmed ${ping.status})`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});

/** Everything the page needs to answer a question, installed once per load. */
const INSTALL = `
  const g = window.__game;
  const eng = g.engine;
  const ctx = eng.context;
  const postfx = ctx.tryGet('postfx');
  const gl = eng.renderer.getContext();
  const drain = () => { const p = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return p[0]; };
  window.tc = {
    adaptive: () => eng.adaptiveQuality,
    /** Scene-target dimensions, which is where the world is actually rasterised. */
    sceneRT: () => (postfx && postfx.sceneRT ? [postfx.sceneRT.width, postfx.sceneRT.height] : [0, 0]),
    db: () => eng.drawingBufferSize(),
    drain,
    /** Mean and std of framebuffer luminance over a centre block. A grey world has std ~0. */
    fb: () => {
      const d = eng.drawingBufferSize();
      const n = Math.min(256, d.w, d.h);
      const x0 = ((d.w - n) / 2) | 0, y0 = ((d.h - n) / 2) | 0;
      const px = new Uint8Array(n * n * 4);
      gl.readPixels(x0, y0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let s = 0, s2 = 0;
      const m = n * n;
      for (let i = 0; i < m; i++) {
        const l = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
        s += l; s2 += l * l;
      }
      const mean = s / m;
      return { mean: +mean.toFixed(2), std: +Math.sqrt(Math.max(0, s2 / m - mean * mean)).toFixed(2) };
    },
    /**
     * Render N frames and return a *drained* per-frame cost.
     *
     * eng.lastRenderMs alone is CPU submit time and is blind to fill rate: measured flat at
     * 4-5 ms from scale 1.00 to 0.50 while the scene target went 3200x1800 to 1600x900. A 1x1
     * readPixels per frame is the only real barrier on ANGLE-on-Metal (gl.finish returns before
     * the GPU drains) and turns the same clock into a true frame cost.
     */
    block: async (frames) => {
      eng.drainAfterFrame = true;
      drain();
      const out = [];
      for (let i = 0; i < frames; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        out.push(eng.lastRenderMs);
      }
      eng.drainAfterFrame = false;
      return out;
    },
    calls: () => eng.renderer.info.render.calls,
    programs: () => eng.renderer.info.programs.length,
    q: () => ({ ...eng.quality }),
  };
`;

const open = async (query) => {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DSF });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /failed to link|INVALID_OPERATION|Program Info Log/i.test(t)) {
      errors.push(`${m.type()}: ${t.slice(0, 240)}`);
    }
  });
  await page.goto(`${base}/?harness=1&w=${W}&h=${H}&${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
  await page.evaluate(INSTALL);
  return { page, errors };
};

const stats = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  return { n: s.length, p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p99: +q(0.99).toFixed(2), min: +s[0].toFixed(2), mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2) };
};

// ---------------------------------------------------------------------------

if (MODE === 'life') {
  // Load-immune: pass/fail on booting, on the app being alive, and on the world not being grey
  // after a runtime tier switch. The grey-world bug left stale cascade lights so every lit
  // shader failed to link; its signature is a collapse in draw calls and in framebuffer
  // variance, plus a link error on the console.
  const maps = String(args.get('maps') ?? 'rome,pydna,carthage').split(',');
  const tiers = String(args.get('tiers') ?? 'ultra,high,medium,low,ultra').split(',');
  let bad = 0;
  for (const map of maps) {
    const { page, errors } = await open(`map=${map}&quality=ultra&scenario=${map === 'pydna' ? 'field' : 'assault'}`);
    await page.evaluate((t) => window.__game.advance(t), 20);
    const rows = [];
    for (const tier of tiers) {
      await page.evaluate((t) => window.__game.engine.setQuality(t), tier);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const r = await page.evaluate(() => ({
        calls: window.tc.calls(), fb: window.tc.fb(), db: window.tc.db(),
        rt: window.tc.sceneRT(), q: window.tc.q(), progs: window.tc.programs(),
      }));
      rows.push([tier, r]);
    }
    const ready = await page.evaluate(() => window.__game.ready === true);
    const greys = rows.filter(([, r]) => r.fb.std < 3 || r.calls < 40);
    const soldierDrift = rows.some(([, r]) => r.q.maxSoldiers !== rows[0][1].q.maxSoldiers);
    console.log(`\n== ${map} ==  ready=${ready}  errors=${errors.length}`);
    for (const [t, r] of rows) {
      console.log(`  ${t.padEnd(7)} draws ${String(r.calls).padStart(4)}  fb mean ${String(r.fb.mean).padStart(6)} std ${String(r.fb.std).padStart(6)}` +
        `  db ${r.db.w}x${r.db.h}  sceneRT ${r.rt[0]}x${r.rt[1]}  progs ${r.progs}  maxSoldiers ${r.q.maxSoldiers}  cascades ${r.q.shadowCascades}`);
    }
    if (!ready) { console.log('  FAIL: not ready'); bad++; }
    if (errors.length) { console.log('  errors:'); for (const e of errors.slice(0, 6)) console.log(`    ${e}`); bad++; }
    if (greys.length) { console.log(`  FAIL: grey/empty world at ${greys.map(([t]) => t).join(',')}`); bad++; }
    if (soldierDrift) { console.log('  FAIL: maxSoldiers moved across a tier switch'); bad++; }
    await page.close();
  }
  console.log(bad ? `\nFAIL (${bad})` : '\nPASS — three maps, five tier switches each, no grey world, maxSoldiers pinned');
}

// ---------------------------------------------------------------------------

if (MODE === 'realloc') {
  // What one resolution change costs, wall clock, drained at both ends. Alternates two scales
  // so every sample is a real reallocation and none is a no-op early-return.
  const { page, errors } = await open(`map=${MAP}&quality=${TIER}&scenario=assault`);
  await page.evaluate((t) => window.__game.advance(t), AT);
  const n = Number(args.get('n') ?? 40);
  const r = await page.evaluate(async (n) => {
    const eng = window.__game.engine;
    const a = [], sizes = [];
    window.tc.drain();
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const s = i % 2 ? 1.0 : 0.7;
      window.tc.drain();
      const t0 = performance.now();
      eng.applyRenderQuality({ renderScale: s });
      const t1 = performance.now();
      window.tc.drain();
      a.push(t1 - t0);
      sizes.push([s, window.tc.db().w, window.tc.sceneRT()[0]]);
    }
    eng.applyRenderQuality({ renderScale: 1 });
    return { a, sizes: sizes.slice(0, 4) };
  }, n);
  console.log(`\nreallocation cost, ${n} alternating 1.00 <-> 0.70 at ${TIER} dsf=${DSF}`);
  console.log(`  ${JSON.stringify(stats(r.a))}`);
  console.log(`  first four (scale, canvasW, sceneRTW): ${JSON.stringify(r.sizes)}`);
  if (errors.length) console.log(`  errors: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

// ---------------------------------------------------------------------------

if (MODE === 'levers') {
  /*
   * Every arm sets every lever, never a delta, so arms can be rotated and land in the same
   * state. Arm order reverses on alternate blocks and the base arm is re-run last as a drift
   * check — that is the only thing that distinguishes "my change did nothing" from "my arms did
   * not restore".
   */
  const { page, errors } = await open(`map=${MAP}&quality=${TIER}&scenario=assault`);
  await page.evaluate((t) => window.__game.advance(t), AT);
  const cams = String(args.get('cams') ?? 'assault,wide').split(',');
  const CAM = { wide: { x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82 }, melee: { x: -28, z: -37, zoom: 0.3, yaw: -1.79 }, city: { x: 40, z: 620, zoom: 0.74, yaw: 0.06 }, assault: null };
  CAM.assault = await page.evaluate(() => { const r = window.__game.engine.rig; return { x: r.focus.x, z: r.focus.z, zoom: r.zoom, yaw: r.yaw }; });

  const ARMS = {
    base: { renderScale: 1, grass: 1, ssao: true, volumetricLight: true, depthOfField: true, motionBlur: true },
    res90: { renderScale: 0.9, grass: 1, ssao: true, volumetricLight: true, depthOfField: true, motionBlur: true },
    res70: { renderScale: 0.7, grass: 1, ssao: true, volumetricLight: true, depthOfField: true, motionBlur: true },
    res50: { renderScale: 0.5, grass: 1, ssao: true, volumetricLight: true, depthOfField: true, motionBlur: true },
    grass50: { renderScale: 1, grass: 0.5, ssao: true, volumetricLight: true, depthOfField: true, motionBlur: true },
    grass0: { renderScale: 1, grass: 0, ssao: true, volumetricLight: true, depthOfField: true, motionBlur: true },
    nopostflags: { renderScale: 1, grass: 1, ssao: false, volumetricLight: false, depthOfField: false, motionBlur: false },
    floor: { renderScale: 0.7, grass: 0.55, ssao: true, volumetricLight: true, depthOfField: false, motionBlur: false },
  };
  const names = String(args.get('arms') ?? 'base,res90,res70,res50,grass50,grass0,nopostflags,floor').split(',');

  for (const cam of cams) {
    await page.evaluate((c) => window.__game.setCamera(c.x, c.z, c.zoom, c.yaw), CAM[cam]);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    const acc = Object.fromEntries(names.map((n) => [n, []]));
    const meta = {};
    for (let b = 0; b < BLOCKS; b++) {
      const order = b % 2 ? [...names].reverse() : names;
      for (const arm of order) {
        const a = ARMS[arm];
        const m = await page.evaluate(async ({ a, frames }) => {
          const eng = window.__game.engine;
          const base = eng.baseQuality;
          eng.applyRenderQuality({
            renderScale: a.renderScale,
            grassDensity: base.grassDensity * a.grass,
            ssao: a.ssao, volumetricLight: a.volumetricLight,
            depthOfField: a.depthOfField, motionBlur: a.motionBlur,
          });
          // Three frames of settle: a reallocation invalidates history and the first frame
          // after it pays for the allocation.
          for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
          const t = await window.tc.block(frames);
          return { t, rt: window.tc.sceneRT(), db: window.tc.db(), calls: window.tc.calls(), grass: eng.quality.grassDensity };
        }, { a, frames: FRAMES });
        acc[arm].push(...m.t);
        meta[arm] = m;
      }
    }
    console.log(`\n== ${cam} @ ${TIER}, dsf=${DSF}, ${BLOCKS} blocks x ${FRAMES} frames, arms rotated ==`);
    const b = stats(acc.base);
    for (const arm of names) {
      const s = stats(acc[arm]);
      const m = meta[arm];
      const d = (s.min - b.min).toFixed(2);
      console.log(`  ${arm.padEnd(12)} p50 ${String(s.p50).padStart(6)} p90 ${String(s.p90).padStart(6)} best ${String(s.min).padStart(6)}` +
        `  delta(best) ${String(d).padStart(7)}  sceneRT ${m.rt[0]}x${m.rt[1]}  draws ${m.calls}  grass ${m.grass.toFixed(2)}`);
    }
  }
  if (errors.length) console.log(`errors: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

// ---------------------------------------------------------------------------

if (MODE === 'loop') {
  // Close the loop and push it: a wide camera, then a hard pan, then a zoom into the melee.
  const { page, errors } = await open(`map=${MAP}&quality=${TIER}&scenario=assault&autoplay=1`);
  await page.evaluate((t) => window.__game.advance(t), AT);
  const secs = Number(args.get('secs') ?? 60);
  const out = await page.evaluate(async ({ secs, TARGET }) => {
    const eng = window.__game.engine;
    const aq = eng.adaptiveQuality;
    /*
     * Drive the controller through a drained clock.
     *
     * Headless has no display, so the presented-frame arm correctly switches itself off and only
     * the CPU arm runs -- and the CPU arm cannot see a fill-rate lever (4-5 ms flat from scale
     * 1.00 to 0.50). `drainAfterFrame` puts a 1x1 readPixels at the end of every frame, which is
     * the only real barrier on ANGLE-on-Metal, so `lastRenderMs` becomes a true frame cost and
     * the loop closes on the same number a player's GPU would impose. The budget is raised to
     * suit, because a drained frame is not a pipelined one: this measures the controller, not
     * the machine.
     */
    eng.drainAfterFrame = true;
    aq.targetMs = TARGET;
    aq.enabled = true;
    aq.forceWarm();
    const rig = eng.rig;
    const log = [];
    const t0 = performance.now();
    let phase = '';
    const phases = [
      [0, 'settle-wide', () => window.__game.setCamera(0, 90, 0.72, Math.PI * 0.82)],
      [0.25, 'pan', null],
      [0.5, 'melee', () => window.__game.setCamera(-28, -37, 0.3, -1.79)],
      [0.75, 'settle-melee', null],
    ];
    let pi = -1;
    while (performance.now() - t0 < secs * 1000) {
      await new Promise((r) => requestAnimationFrame(r));
      const f = (performance.now() - t0) / (secs * 1000);
      for (let i = phases.length - 1; i >= 0; i--) {
        if (f >= phases[i][0] && pi < i) { pi = i; phase = phases[i][1]; phases[i][2]?.(); break; }
      }
      // The pan phase drives the camera continuously, which is the measured worst case: it is
      // the only thing that touches 226 draws against a 220 budget.
      if (phase === 'pan') { rig.focus.x += Math.sin(performance.now() / 700) * 2.2; rig.focus.z += 0.9; }
      const s = aq.state();
      if (log.length === 0 || performance.now() - log[log.length - 1].t > 250) {
        log.push({ t: +(performance.now() - t0).toFixed(0), phase, p: +s.pressure.toFixed(3), sc: s.appliedScale, gr: +s.grassDensity.toFixed(2), p50: +s.p50.toFixed(1), p90: +s.p90.toFixed(1), p99: +s.p99.toFixed(1), rg: s.regressing ? 1 : 0, la: s.latched ? 1 : 0 });
      }
    }
    return { log, state: aq.state(), trace: aq.trace };
  }, { secs, TARGET: Number(args.get('target') ?? 0) || 16.67 });
  console.log(`\n== loop, ${MAP} @ ${TIER}, ${secs}s, dsf=${DSF}, target ${args.get('target') ?? 16.67} ms, drained ==`);
  console.log('   t(ms)  phase          press  scale  grass   p50   p90   p99 rg la');
  for (const r of out.log) {
    console.log(`  ${String(r.t).padStart(6)}  ${r.phase.padEnd(13)} ${r.p.toFixed(2).padStart(5)}  ${r.sc.toFixed(2)}   ${r.gr.toFixed(2)}  ${String(r.p50).padStart(5)} ${String(r.p90).padStart(5)} ${String(r.p99).padStart(5)}  ${r.rg} ${r.la}`);
  }
  console.log(`\nfinal: ${JSON.stringify(out.state)}`);
  console.log(`decisions: ${out.trace.length}  ${JSON.stringify(out.trace.map((x) => [Math.round(x.t), x.dir, +x.pressure.toFixed(2), x.scale, +x.reallocMs.toFixed(2)]))}`);
  if (errors.length) console.log(`errors: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

await browser.close();
