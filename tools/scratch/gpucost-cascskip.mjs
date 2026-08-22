#!/usr/bin/env node
/**
 * Prototype: do not submit a soldier LOD tier to a cascade it cannot reach.
 *
 * Every soldier tier mesh carries `frustumCulled = false`, because its instance buffer is
 * filled per camera-frustum and a bounding sphere would be meaningless. `WebGLShadowMap.js:515`
 * reads that flag and draws the mesh into **every** cascade unconditionally. But a LOD tier
 * occupies a known radial shell around the camera and a cascade covers a known view-depth
 * slice, and at ultra those barely overlap: LOD0 lives inside 44.8 m and cascade 3 starts at
 * 152 m; LOD2 starts at 128 m and cascade 0 ends at 26 m. Each tier is therefore submitted to
 * two cascades that cannot contain a single one of its instances.
 *
 * The lever is the same one `CitySystem.buildShadowProxy` uses for the colour pass, in its
 * instanced form. `onBeforeShadow` fires per shadow draw with the shadow camera, and
 * `renderBufferDirect` reads `geometry.instanceCount` *after* it; `WebGLBufferRenderer`'s
 * `renderInstances` returns before `info.update` when the count is zero, so a zeroed tier
 * costs neither a GL draw nor a counted one.
 *
 * This measures the prize **without editing `UnitRenderSystem`**, which is contended. If the
 * numbers justify it, the shipped version wants the tier to publish its own band rather than
 * have this file re-derive it.
 *
 * Margin: a man is 1.8 m under a 26 deg sun, so he throws about 3.7 m; hysteresis lets him sit
 * 12% past his band edge. `MARGIN` covers both with room, and the arm is only believable
 * because the picture is diffed pixel-for-pixel against a base arm re-shot last.
 *
 *   node tools/scratch/gpucost-cascskip.mjs --port=5921 --scene=rome
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { spawnVite } from '../lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5921);
const W = Number(args.get('w') ?? 1920), H = Number(args.get('h') ?? 1080);
const QUALITY = args.get('quality') ?? 'ultra';
const FRAMES = Number(args.get('frames') ?? 40);
const BLOCKS = Number(args.get('blocks') ?? 8);
const MARGIN = Number(args.get('margin') ?? 8);
const SCENE_ID = args.get('scene') ?? 'rome';
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/gpucost-cascskip');

const SCENES = {
  rome: { cfg: { scenario: 'assault', timeOfDay: 14.3 }, cam: { x: 166, z: 435, zoom: 0.46, yaw: -0.53 }, at: 170 },
  carthage: { cfg: { map: 'carthage', opponent: 2, scenario: 'assault', timeOfDay: 15.2 }, cam: { x: 62, z: 433, zoom: 0.46, yaw: -0.49 }, at: 170 },
};
const sc = SCENES[SCENE_ID];
const ARMS = ['base', 'cascskip'];

const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const load = () => { try { return execFileSync('uptime', { encoding: 'utf8' }).match(/load averages?:\s*([\d.]+)/)[1]; } catch { return '?'; } };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

await mkdir(OUT, { recursive: true });
const base = `http://127.0.0.1:${PORT}`;
const up = async (ms) => { const e = Date.now() + ms; while (Date.now() < e) { try { const r = await fetch(base, { signal: AbortSignal.timeout(2500) }); if (r.ok || r.status === 304) return true; } catch {} await new Promise((r) => setTimeout(r, 300)); } return false; };
let server = null;
if (!(await up(1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await up(90000))) throw new Error('vite did not start');
}
const token = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

console.log(`# ${head}  ${W}x${H} ${QUALITY} scene=${SCENE_ID} margin=${MARGIN}m  load ${load()}`);
await page.goto(`${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}&battle=${token(sc.cfg)}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });

const setup = await page.evaluate((MARGIN) => {
  const g = window.__game, ctx = g.engine.context ?? g.engine.ctx, r = ctx.renderer, info = r.info;
  g.engine.stop();
  const acc = { shadow: 0, scene: 0, quad: 0 };
  const sm = r.shadowMap, os = sm.render.bind(sm);
  sm.render = (...z) => { const b = info.render.calls; os(...z); acc.shadow += info.render.calls - b; };
  const orr = r.render.bind(r);
  r.render = (...z) => { const b = info.render.calls; orr(...z); const d = info.render.calls - b; if (z[0] === ctx.scene) acc.scene += d; else acc.quad += d; };
  const gl = r.getContext(), px = new Uint8Array(4);

  const lighting = ctx.tryGet('lighting');
  const units = ctx.tryGet('unitRender');
  const csm = lighting.csm;

  // Cascade view-depth bands, from the same break array the shader compares against.
  const bands = () => {
    const near = lighting.csmDepth.x, far = lighting.csmDepth.y;
    return lighting.breaks.map((b) => [near + b.x * (far - near), near + b.y * (far - near)]);
  };
  // Tier radial bands. `lodDist` is what `preRender` actually selects on.
  const tierBand = (lod) => {
    const d = units.lodDist;
    return lod === 0 ? [0, d[0]] : lod === 1 ? [d[0], d[1]] : [d[1], d[2]];
  };

  // Every soldier/horse tier mesh, tagged with its LOD.
  const tiers = [];
  ctx.scene.traverse((o) => {
    const m = /^(soldiers-[A-Za-z]+|horses)-lod(\d)$/.exec(o.name || '');
    if (m && o.isMesh && o.geometry) tiers.push({ mesh: o, lod: Number(m[2]), name: o.name });
  });

  const camIndex = new Map(csm.lights.map((l, i) => [l.shadow.camera, i]));
  let installed = false;
  const plan = [];
  const install = () => {
    if (installed) return;
    installed = true;
    for (const t of tiers) {
      t.mesh.onBeforeShadow = (_r, _o, _cam, shadowCam, geom) => {
        const i = camIndex.get(shadowCam);
        if (i === undefined) return;
        const [cNear, cFar] = bands()[i];
        const [tNear, tFar] = tierBand(t.lod);
        if (tNear - MARGIN > cFar || tFar + MARGIN < cNear) {
          t.saved = geom.instanceCount;
          geom.instanceCount = 0;
        }
      };
      t.mesh.onAfterShadow = (_r, _o, _cam, _sc, geom) => {
        if (t.saved !== undefined) { geom.instanceCount = t.saved; t.saved = undefined; }
      };
    }
  };
  const uninstall = () => {
    installed = false;
    for (const t of tiers) { t.mesh.onBeforeShadow = () => {}; t.mesh.onAfterShadow = () => {}; }
  };

  window.tc = {
    sync: () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px),
    freeze: () => { window.__f = g.engine.time.elapsed * 1000; },
    still: (n) => { for (let i = 0; i < n; i++) g.engine.frame(window.__f); },
    live: (n) => { for (let i = 0; i < n; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7); },
    arm: (a) => { if (a === 'cascskip') install(); else uninstall(); },
    split: () => { acc.shadow = 0; acc.scene = 0; acc.quad = 0; g.engine.frame(window.__f); window.tc.sync(); const t = info.render.calls; return { draws: t, tris: info.render.triangles, shadow: acc.shadow, colour: acc.scene - acc.shadow, post: acc.quad }; },
    plan: () => {
      const bs = bands();
      const rows = [];
      for (const t of tiers) {
        const [tNear, tFar] = tierBand(t.lod);
        const skip = [];
        bs.forEach(([cNear, cFar], i) => { if (tNear - MARGIN > cFar || tFar + MARGIN < cNear) skip.push(i); });
        rows.push({ name: t.name, band: [+tNear.toFixed(1), +tFar.toFixed(1)], inst: t.mesh.geometry.instanceCount, skip });
      }
      return { cascades: bs.map((b) => [+b[0].toFixed(1), +b[1].toFixed(1)]), rows };
    },
    men: () => { let m = 0, u = 0; for (const x of g.battle.units) if (!x.destroyed) { u++; m += x.alive; } return { men: m, units: u }; },
  };
  void plan;
  return tiers.length;
}, MARGIN);
console.log(`# ${setup} soldier/horse tier meshes found`);

await page.evaluate(async (a) => {
  const g = window.__game;
  g.advance(a.at);
  g.setCamera(a.cam.x, a.cam.z, a.cam.zoom, a.cam.yaw);
  for (let i = 0; i < 90; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
  window.tc.freeze(); window.tc.still(4);
}, { at: sc.at, cam: sc.cam });

const pop = await page.evaluate(() => window.tc.men());
const plan = await page.evaluate(() => { window.tc.arm('cascskip'); const p = window.tc.plan(); window.tc.arm('base'); return p; });
console.log(`# headcount ${pop.men} men / ${pop.units} units (fixed across every arm)`);
console.log(`# cascade view-depth bands (m): ${plan.cascades.map((b, i) => `c${i} ${b[0]}-${b[1]}`).join('  ')}`);
for (const r of plan.rows) {
  console.log(`#   ${r.name.padEnd(24)} band ${String(r.band[0]).padStart(6)}-${String(r.band[1]).padEnd(6)} inst ${String(r.inst).padStart(5)}  skips ${r.skip.length ? r.skip.map((i) => 'c' + i).join(',') : '-'}`);
}

const order = [['base-1', 'base'], ['cascskip', 'cascskip'], ['base-2', 'base']];
const shots = [];
for (const [label, arm] of order) {
  const s = await page.evaluate(({ arm }) => { window.tc.arm(arm); window.tc.still(3); return window.tc.split(); }, { arm });
  const file = path.join(OUT, `${SCENE_ID}-${label}.png`);
  await page.screenshot({ path: file, type: 'png' });
  shots.push({ label, file, s });
  console.log(`  ${label.padEnd(9)} draws ${String(s.draws).padStart(4)} = shadow ${String(s.shadow).padStart(3)} + colour ${String(s.colour).padStart(3)} + post ${String(s.post).padStart(2)}   tris ${(s.tris / 1e6).toFixed(2)}M`);
}

const times = new Map(ARMS.map((a) => [a, []]));
for (let b = 0; b < BLOCKS; b++) {
  const idx = b % 2 ? [...ARMS.keys()].reverse() : [...ARMS.keys()];
  for (const i of idx) {
    const arm = ARMS[i];
    const ms = await page.evaluate(({ arm, frames }) => {
      window.tc.arm(arm); window.tc.still(2); window.tc.sync();
      const t0 = performance.now();
      for (let k = 0; k < frames; k++) window.__game.engine.frame(window.__f);
      window.tc.sync();
      return (performance.now() - t0) / frames;
    }, { arm, frames: FRAMES });
    times.get(arm).push(ms);
  }
}

async function diff(a, b) {
  const A = await sharp(a).raw().toBuffer({ resolveWithObject: true });
  const B = await sharp(b).raw().toBuffer({ resolveWithObject: true });
  let n = 0, sum = 0, max = 0; const ch = A.info.channels;
  for (let i = 0; i < A.data.length; i += ch) {
    let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.data[i + c] - B.data[i + c]));
    if (d > 0) { n++; sum += d; if (d > max) max = d; }
  }
  return { changedPx: n, changedFrac: +(n / (A.data.length / ch)).toFixed(5), meanOverChanged: +(n ? sum / n : 0).toFixed(2), max };
}
const b1 = shots[0], sk = shots[1], b2 = shots[2];
console.log(`\n  DRIFT base-1 vs base-2 : ${JSON.stringify(await diff(b1.file, b2.file))}`);
console.log(`  cascskip vs base-1     : ${JSON.stringify(await diff(b1.file, sk.file))}`);
console.log(`\n  ${'arm'.padEnd(10)} ${'p50'.padStart(7)} ${'p90'.padStart(7)} ${'best'.padStart(7)}`);
for (const a of ARMS) {
  const t = times.get(a);
  console.log(`  ${a.padEnd(10)} ${q(t, 0.5).toFixed(2).padStart(7)} ${q(t, 0.9).toFixed(2).padStart(7)} ${Math.min(...t).toFixed(2).padStart(7)}`);
}
const tb = times.get('base'), ts = times.get('cascskip');
console.log(`  delta: ${(q(ts, 0.5) - q(tb, 0.5)).toFixed(2)} ms p50, ${(Math.min(...ts) - Math.min(...tb)).toFixed(2)} ms best-of-block  (negative = faster)`);
console.log(errs.length ? `\npageerror: ${errs.length}` : '\nno pageerror.');
console.log(`# load at end ${load()}`);
await browser.close();
if (server) server.kill('SIGTERM');
