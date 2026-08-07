#!/usr/bin/env node
/**
 * What each quality knob costs, all arms interleaved in one session.
 *
 * The ranked "what to give up" list this project needs cannot be assembled from separate
 * runs: two workstreams have measured the same camera at 21.78 ms and 9.14 ms on identical
 * code in consecutive runs. So every knob is rotated inside one browser session, the arm
 * order reverses on alternate blocks, and both the median and the best-of-blocks are
 * reported. Contention is one-sided — it can only add time — so the *best* block is the
 * estimator that converges on the uncontended cost, and a disagreement between the two is
 * the signal that the run was too noisy to quote.
 *
 * A 1x1 `readPixels` bounds each block. `gl.finish()` does not work here: under
 * ANGLE-on-Metal it returns before the GPU drains and once reported 0.25 ms/frame for a
 * 1.3 M-triangle scene.
 *
 *   node tools/probe-cost.mjs --port=5477 --arms=base,msaa0,aniso8,grass50,cascades3
 */

import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const TIER = args.get('tier') ?? 'ultra';
const SCENARIO = args.get('scenario') ?? 'assault';
const AT = Number(args.get('at') ?? 72);
const FRAMES = Number(args.get('frames') ?? 30);
const BLOCKS = Number(args.get('blocks') ?? 5);
const ARMS = String(args.get('arms') ?? 'base,msaa0,msaa2,aniso8,grass50,noshadow,nopost').split(',');

const CAMS = {
  assault: null,
  clash: { x: 15, z: -17, zoom: 0.30, yaw: -1.92 },
  melee: { x: -28, z: -37, zoom: 0.30, yaw: -1.79 },
  wide: { x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82 },
  romanline: { x: -100, z: 128, zoom: 0.36, yaw: Math.PI * 1.42 },
  raking: { x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72 },
  terrain: { x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4 },
  city: { x: 40, z: 620, zoom: 0.74, yaw: Math.PI * 0.06 },
  wall: { x: -120, z: 470, zoom: 0.58, yaw: 0.0 },
};
const cams = args.get('cams') ? String(args.get('cams')).split(',') : ['melee', 'assault'];

const base = `http://127.0.0.1:${PORT}`;
const ping = await fetch(base, { signal: AbortSignal.timeout(4000) }).catch(() => null);
if (!ping?.ok) throw new Error(`no dev server on ${base} — start your own`);
console.log(`source: ${base} (my server; confirmed 200)`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
await page.goto(`${base}/?harness=1&quality=${TIER}&w=${W}&h=${H}&scenario=${SCENARIO}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
CAMS.assault = await page.evaluate(() => {
  const r = window.__game.engine.rig;
  return { x: r.focus.x, z: r.focus.z, zoom: r.zoom, yaw: r.yaw };
});
if (AT > 0) await page.evaluate((t) => window.__game.advance(t), AT);

/**
 * Every arm sets every knob it knows about, never a delta, so the arms can be rotated in
 * any order and land in the same state each time.
 */
await page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const postfx = ctx.tryGet('postfx');
  const grass = ctx.tryGet('grass') ?? ctx.tryGet('vegetation');
  const lighting = ctx.tryGet('lighting');

  // Record the shipped anisotropy of every texture once, so an arm can restore it exactly
  // rather than guessing at the tier default.
  const texes = [];
  const seen = new Set();
  ctx.scene.traverse((o) => {
    const mat = o.material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      if (seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      for (const t of [m.map, m.normalMap, m.roughnessMap, m.aoMap, m.metalnessMap, m.emissiveMap, m.alphaMap]) {
        if (!t) continue;
        const mipped = t.generateMipmaps || (t.mipmaps?.length ?? 0) > 1;
        if (mipped) texes.push([t, t.anisotropy]);
      }
    }
  });

  // Grass is instanced with `instanceCount` on an InstancedBufferGeometry, so density can be
  // scaled by trimming the count — no rebuild, no shader recompile, no reseed.
  const grassMeshes = [];
  for (const c of ctx.scene.children) {
    if (!/grass/i.test(c.name || '')) continue;
    const g = c.geometry;
    if (g && Number.isFinite(g.instanceCount)) grassMeshes.push([c, g.instanceCount]);
  }

  const casters = [];
  ctx.scene.traverse((o) => { if (o.isDirectionalLight && o.shadow) casters.push([o, o.castShadow]); });

  window.tc = {
    texCount: texes.length,
    grassCount: grassMeshes.reduce((s, [, n]) => s + n, 0),
    msaa: (n) => postfx.setSamplesOverride(n),
    aniso: (n) => { for (const [t, was] of texes) { const v = n === null ? was : Math.min(n, was); if (t.anisotropy !== v) { t.anisotropy = v; t.needsUpdate = true; } } },
    grass: (f) => { for (const [m, was] of grassMeshes) m.geometry.instanceCount = Math.round(was * f); },
    shadowRender: (on) => { for (const [l, was] of casters) l.castShadow = on && was; },
    post: (on) => { postfx.enabled = on; },
    soft: (on) => { if (lighting && 'softShadows' in lighting) lighting.softShadows = on; },
    grassSys: !!grass,
  };
});
const caps = await page.evaluate(() => ({
  max: window.__game.engine.renderer.capabilities.maxSamples,
  aniso: window.__game.engine.renderer.capabilities.getMaxAnisotropy(),
  tex: window.tc.texCount,
  grass: window.tc.grassCount,
}));
console.log(`driver maxSamples ${caps.max}, maxAnisotropy ${caps.aniso}; ${caps.tex} mipped textures, ${caps.grass} grass instances`);

const ARM_SRC = {
  base: 'tc.msaa(null); tc.aniso(null); tc.grass(1); tc.shadowRender(1); tc.post(1); tc.soft(1);',
  msaa0: 'tc.msaa(0); tc.aniso(null); tc.grass(1); tc.shadowRender(1); tc.post(1); tc.soft(1);',
  msaa2: 'tc.msaa(2); tc.aniso(null); tc.grass(1); tc.shadowRender(1); tc.post(1); tc.soft(1);',
  msaa4: 'tc.msaa(4); tc.aniso(null); tc.grass(1); tc.shadowRender(1); tc.post(1); tc.soft(1);',
  aniso8: 'tc.msaa(null); tc.aniso(8); tc.grass(1); tc.shadowRender(1); tc.post(1); tc.soft(1);',
  aniso4: 'tc.msaa(null); tc.aniso(4); tc.grass(1); tc.shadowRender(1); tc.post(1); tc.soft(1);',
  grass50: 'tc.msaa(null); tc.aniso(null); tc.grass(0.5); tc.shadowRender(1); tc.post(1); tc.soft(1);',
  grass0: 'tc.msaa(null); tc.aniso(null); tc.grass(0); tc.shadowRender(1); tc.post(1); tc.soft(1);',
  noshadow: 'tc.msaa(null); tc.aniso(null); tc.grass(1); tc.shadowRender(0); tc.post(1); tc.soft(1);',
  nosoft: 'tc.msaa(null); tc.aniso(null); tc.grass(1); tc.shadowRender(1); tc.post(1); tc.soft(0);',
  nopost: 'tc.msaa(null); tc.aniso(null); tc.grass(1); tc.shadowRender(1); tc.post(0); tc.soft(1);',
};
for (const a of ARMS) if (!ARM_SRC[a]) throw new Error(`unknown arm ${a}`);

const timeBlock = (n) => page.evaluate(async (frames) => {
  const g = window.__game;
  const time = g.engine.time;
  const gl = g.engine.renderer.getContext();
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const wasPaused = time.paused;
  time.paused = false;
  // Seeding `lastNow` pins the frame delta at a true 1/60 s. Left alone it is a fixed point
  // that lands on the 0.25 s clamp and fires five sim ticks per rendered frame.
  time.lastNow = time.elapsed;
  const step = () => g.engine.frame((time.elapsed + 1 / 60) * 1000);
  step(); step(); step();
  sync();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) step();
  sync();
  const ms = (performance.now() - t0) / frames;
  time.paused = wasPaused;
  return { ms, draws: g.engine.renderer.info.render.calls, tris: g.engine.renderer.info.render.triangles };
}, n);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const best = (a) => Math.min(...a);

console.log(`# ${W}x${H} ${TIER}, ${SCENARIO} t+${AT}s, ${FRAMES} frames x ${BLOCKS} blocks, arms: ${ARMS.join(' ')}`);
for (const name of cams) {
  const c = CAMS[name];
  await page.evaluate((s) => window.__game.setCamera(s.x, s.z, s.zoom, s.yaw), c);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.__game.engine.advance(1 / 60); });

  const samples = ARMS.map(() => []);
  const info = ARMS.map(() => null);
  for (let b = 0; b < BLOCKS; b++) {
    const order = b % 2 ? [...ARMS.keys()].reverse() : [...ARMS.keys()];
    for (const i of order) {
      await page.evaluate((src) => { new Function('tc', src)(window.tc); }, ARM_SRC[ARMS[i]]);
      const r = await timeBlock(FRAMES);
      samples[i].push(r.ms);
      info[i] = r;
    }
  }
  await page.evaluate((src) => { new Function('tc', src)(window.tc); }, ARM_SRC.base);

  const mins = samples.map(best);
  const meds = samples.map(median);
  console.log(`\n=== ${name} ===`);
  for (const [i, a] of ARMS.entries()) {
    const d = mins[i] - mins[0];
    const dm = meds[i] - meds[0];
    const flag = Math.abs(d - dm) > 0.9 ? '  ?noisy' : '';
    console.log(`  ${a.padEnd(10)} best ${mins[i].toFixed(2)}  median ${meds[i].toFixed(2)} ms  ${String(info[i].draws).padStart(4)} draws`
      + `  ${(info[i].tris / 1e6).toFixed(1).padStart(5)}M`
      + (i === 0 ? '   (reference)' : `   ${d >= 0 ? '+' : ''}${d.toFixed(2)} best / ${dm >= 0 ? '+' : ''}${dm.toFixed(2)} median${flag}`)
      + `   [${samples[i].map((v) => v.toFixed(1)).join(' ')}]`);
  }
}

if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`   ${e}`);
}
await browser.close();
