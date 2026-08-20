#!/usr/bin/env node
/**
 * A/B for the shipped per-cascade band skip, driving `LightingSystem.cascadeTierSkip`.
 *
 * `gpucost-cascskip.mjs` proved the idea by installing the hooks from the probe. This drives
 * the real flag on the real system, so what is measured is what ships. Both arms interleave in
 * one page load and the base arm is re-shot last, per `docs/RELEASING.md` §4a.
 *
 * **`renderScale` and the adaptive pressure are printed with every run.** The quality loop had
 * two arms controlling to different frame rates, and on a 120 Hz panel it would sit at pressure
 * 1.00 and scale 0.65 while believing itself idle — so any frame time taken without recording
 * the scale it was taken at is unreadable. If `scale` is not 1.00 below, the milliseconds are
 * measuring a smaller frame than the draw counts are.
 *
 *   node tools/scratch/gpucost-band.mjs --port=5921 --scene=carthage
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5921);
const W = Number(args.get('w') ?? 1920), H = Number(args.get('h') ?? 1080);
const QUALITY = args.get('quality') ?? 'ultra';
const FRAMES = Number(args.get('frames') ?? 40);
const BLOCKS = Number(args.get('blocks') ?? 8);
const SCENE_ID = args.get('scene') ?? 'rome';
const OUT = path.resolve(ROOT, args.get('out') ?? `screenshots/gpucost-band-${SCENE_ID}`);

const SCENES = {
  rome: { cfg: { scenario: 'assault', timeOfDay: 14.3 }, cam: { x: 166, z: 435, zoom: 0.46, yaw: -0.53 }, at: 170 },
  carthage: { cfg: { map: 'carthage', opponent: 2, scenario: 'assault', timeOfDay: 15.2 }, cam: { x: 62, z: 433, zoom: 0.46, yaw: -0.49 }, at: 170 },
};
const sc = SCENES[SCENE_ID];
const ARMS = ['base', 'bandskip'];
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['diff', 'HEAD', '--shortstat', '--', 'src/'], { cwd: ROOT, encoding: 'utf8' }).trim() || 'clean';
const load = () => { try { return execFileSync('uptime', { encoding: 'utf8' }).match(/load averages?:\s*([\d.]+)/)[1]; } catch { return '?'; } };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

await mkdir(OUT, { recursive: true });
const base = `http://127.0.0.1:${PORT}`;
const up = async (ms) => { const e = Date.now() + ms; while (Date.now() < e) { try { const r = await fetch(base, { signal: AbortSignal.timeout(2500) }); if (r.ok || r.status === 304) return true; } catch {} await new Promise((r) => setTimeout(r, 300)); } return false; };
let server = null;
if (!(await up(1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await up(90000))) throw new Error('vite did not start');
}
const token = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

console.log(`# ${head} (${dirty})  ${W}x${H} ${QUALITY} dpr1  scene=${SCENE_ID}  load ${load()}`);
await page.goto(`${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}&battle=${token(sc.cfg)}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });

await page.evaluate(() => {
  const g = window.__game, ctx = g.engine.context ?? g.engine.ctx, r = ctx.renderer, info = r.info;
  g.engine.stop();
  const acc = { shadow: 0, scene: 0, quad: 0 };
  const sm = r.shadowMap, os = sm.render.bind(sm);
  sm.render = (...z) => { const b = info.render.calls; os(...z); acc.shadow += info.render.calls - b; };
  const orr = r.render.bind(r);
  r.render = (...z) => { const b = info.render.calls; orr(...z); const d = info.render.calls - b; if (z[0] === ctx.scene) acc.scene += d; else acc.quad += d; };
  const gl = r.getContext(), px = new Uint8Array(4);
  const lighting = ctx.tryGet('lighting');
  window.tc = {
    sync: () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px),
    freeze: () => { window.__f = g.engine.time.elapsed * 1000; },
    still: (n) => { for (let i = 0; i < n; i++) g.engine.frame(window.__f); },
    live: (n) => { for (let i = 0; i < n; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7); },
    arm: (a) => { lighting.cascadeTierSkip = a === 'bandskip'; },
    split: () => { acc.shadow = 0; acc.scene = 0; acc.quad = 0; g.engine.frame(window.__f); window.tc.sync(); const t = info.render.calls; return { draws: t, tris: info.render.triangles, shadow: acc.shadow, colour: acc.scene - acc.shadow, post: acc.quad }; },
    men: () => { let m = 0, u = 0; for (const x of g.battle.units) if (!x.destroyed) { u++; m += x.alive; } return { men: m, units: u }; },
    /** The one thing a frame time is unreadable without. */
    scale: () => {
      const aq = ctx.tryGet('adaptiveQuality') ?? ctx.tryGet('adaptive');
      return {
        renderScale: ctx.quality.renderScale, maxPixelRatio: ctx.quality.maxPixelRatio,
        pixelRatio: r.getPixelRatio(),
        drawingBuffer: [r.domElement.width, r.domElement.height],
        pressure: aq && aq.pressure !== undefined ? +aq.pressure.toFixed(3) : null,
      };
    },
    plan: () => {
      const cd = lighting.cascadeDepth.map((b) => [+b[0].toFixed(1), +b[1].toFixed(1)]);
      const rows = [];
      ctx.scene.traverse((o) => {
        const b = o.userData && o.userData.shadowRadialBand;
        if (!b) return;
        const skip = [];
        cd.forEach(([cn, cf], i) => { if (b[0] - 8 > cf || b[1] + 8 < cn) skip.push(i); });
        rows.push({ name: o.name, band: [+b[0].toFixed(1), +b[1].toFixed(1)], inst: o.geometry.instanceCount, skip });
      });
      return { cd, rows };
    },
  };
});

await page.evaluate(async (a) => {
  const g = window.__game;
  g.advance(a.at);
  g.setCamera(a.cam.x, a.cam.z, a.cam.zoom, a.cam.yaw);
  for (let i = 0; i < 90; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
  window.tc.freeze(); window.tc.still(4);
}, { at: sc.at, cam: sc.cam });

const pop = await page.evaluate(() => window.tc.men());
const scale = await page.evaluate(() => window.tc.scale());
const plan = await page.evaluate(() => window.tc.plan());
console.log(`# headcount ${pop.men} men / ${pop.units} units (fixed across every arm)`);
console.log(`# scale ${JSON.stringify(scale)}`);
if (scale.renderScale !== 1 || scale.pixelRatio !== 1) console.log('#   !! frame times below are of a REDUCED frame — read the draws, not the ms');
console.log(`# cascade view-depth bands (m): ${plan.cd.map((b, i) => `c${i} ${b[0]}-${b[1]}`).join('  ')}`);
for (const r of plan.rows) {
  console.log(`#   ${r.name.padEnd(24)} band ${String(r.band[0]).padStart(7)}-${String(r.band[1]).padEnd(7)} inst ${String(r.inst).padStart(5)}  skips ${r.skip.length ? r.skip.map((i) => 'c' + i).join(',') : '-'}`);
}

const order = [['base-1', 'base'], ['bandskip', 'bandskip'], ['base-2', 'base']];
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
  return { changedPx: n, changedFrac: +(n / (A.data.length / ch)).toFixed(6), meanOverChanged: +(n ? sum / n : 0).toFixed(2), max };
}
console.log(`\n  DRIFT base-1 vs base-2 : ${JSON.stringify(await diff(shots[0].file, shots[2].file))}`);
console.log(`  bandskip vs base-1     : ${JSON.stringify(await diff(shots[0].file, shots[1].file))}`);
console.log(`\n  ${'arm'.padEnd(10)} ${'p50'.padStart(7)} ${'p90'.padStart(7)} ${'best'.padStart(7)}`);
for (const a of ARMS) { const t = times.get(a); console.log(`  ${a.padEnd(10)} ${q(t, 0.5).toFixed(2).padStart(7)} ${q(t, 0.9).toFixed(2).padStart(7)} ${Math.min(...t).toFixed(2).padStart(7)}`); }
const tb = times.get('base'), ts = times.get('bandskip');
console.log(`  delta: ${(q(ts, 0.5) - q(tb, 0.5)).toFixed(2)} ms p50, ${(Math.min(...ts) - Math.min(...tb)).toFixed(2)} ms best-of-block  (negative = faster)`);
console.log(errs.length ? `\npageerror: ${errs.length}\n  ` + [...new Set(errs)].slice(0, 6).join('\n  ') : '\nno pageerror, no console error.');
console.log(`# load at end ${load()}`);
await browser.close();
if (server) server.kill('SIGTERM');
