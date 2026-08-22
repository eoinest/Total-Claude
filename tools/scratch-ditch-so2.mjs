#!/usr/bin/env node
/**
 * Scratch: where the new ditch falls in the opening frame.
 *
 * `e/city/ditch-and-sky` cut Carthage's defensive ditch into the heightfield after this
 * branch's framing was solved. The framing probe's sample points — the eye's own xz, and the
 * ground under the bottom-centre pixel — both land well short of the wall, so every number it
 * reports came back bit-identical across the merge. Identical numbers across a change that is
 * supposed to be in the frame is the reading to distrust, so this walks the terrain along the
 * gate bay's outward normal and projects each station, which puts the ditch on the screen in
 * pixels rather than leaving it to a sample that happens to miss it.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5414);
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;

const up = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; }
    catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
let server = null;
if (!(await up(1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await up(90000))) { console.error('vite did not start'); process.exit(1); }
}
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});

const PROFILE = ([W, H]) => {
  const g = window.__game;
  const ctx = g.engine.context;
  const cam = ctx.camera;
  cam.updateMatrixWorld(true);
  const V = cam.position.constructor;
  const v = new V();
  const eye = cam.position;
  const dir = cam.getWorldDirection(new V());
  const px = (x, y, z) => {
    v.set(x, y, z).project(cam);
    const behind = (x - eye.x) * dir.x + (y - eye.y) * dir.y + (z - eye.z) * dir.z < 0;
    return {
      x: +((v.x * 0.5 + 0.5) * W).toFixed(0), y: +((-v.y * 0.5 + 0.5) * H).toFixed(0),
      off: behind || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1,
    };
  };
  const bays = ctx.tryGet('city').getGarrisonBays();
  const gb = bays.find((q) => q.isGate) ?? bays[bays.length >> 1];
  /*
   * Several bays, not just the gate's.
   *
   * The first version of this sampled only the gate bay's own outward normal and reported
   * 0.83 m of relief on Carthage against the 6.00 m the ditch work published — which is the
   * causeway. A ditch is bridged at its gate; measuring a ditch down the middle of the road
   * that crosses it is measuring the one line where it is not there.
   */
  const KS = [-6, -4, -2, 0, 2, 4, 6];
  const perBay = [];
  for (const k of KS) {
    const q = bays[gb.index + k];
    if (!q) continue;
    const qx = (q.x0 + q.x1) * 0.5, qz = (q.z0 + q.z1) * 0.5;
    const rs = [];
    for (let d = -6; d <= 90; d += 2) {
      const x = qx + q.nx * d, z = qz + q.nz * d;
      rs.push({ d, y: +g.battle.groundAt(x, z).toFixed(2) });
    }
    const ys = rs.map((r) => r.y);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const fl = rs.find((r) => r.y === lo);
    const flx = qx + q.nx * fl.d, flz = qz + q.nz * fl.d;
    perBay.push({
      k, isGate: !!q.isGate, relief: +(hi - lo).toFixed(2),
      floorAt: fl.d, floorY: fl.y, crownY: hi,
      floorPx: px(flx, fl.y, flz),
      lipPx: px(qx + q.nx * Math.max(0, fl.d - 12), hi, qz + q.nz * Math.max(0, fl.d - 12)),
    });
  }

  const b = gb;
  const mx = (b.x0 + b.x1) * 0.5, mz = (b.z0 + b.z1) * 0.5;
  const rows = [];
  for (let d = -6; d <= 160; d += 2) {
    const x = mx + b.nx * d, z = mz + b.nz * d;
    const y = g.battle.groundAt(x, z);
    rows.push({ d, y: +y.toFixed(2), px: px(x, y, z) });
  }
  const ys = rows.map((r) => r.y);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const floor = rows.find((r) => r.y === lo);
  // The lip on the wall side of the lowest point, and the lip on the field side.
  const iFloor = rows.indexOf(floor);
  let inner = rows[0], outer = rows[rows.length - 1];
  for (let i = iFloor; i >= 0; i--) if (rows[i].y > inner.y) { inner = rows[i]; break; }
  for (let i = iFloor; i < rows.length; i++) if (rows[i].y > outer.y) { outer = rows[i]; break; }
  const cardTop = document.querySelector('.cardbar')?.getBoundingClientRect().top ?? H;
  return {
    zone: g.deployment?.zone ?? null,
    gateBay: { x: +mx.toFixed(1), z: +mz.toFixed(1), n: [+b.nx.toFixed(3), +b.nz.toFixed(3)],
      groundY: +b.groundY.toFixed(2), crestY: +b.crestY.toFixed(2) },
    relief: +(hi - lo).toFixed(2),
    floor: { d: floor.d, y: floor.y, px: floor.px },
    innerLip: { d: inner.d, y: inner.y, px: inner.px },
    outerLip: { d: outer.d, y: outer.y, px: outer.px },
    cardTop: Math.round(cardTop),
    rows: rows.filter((r) => r.d % 6 === 0),
    perBay,
  };
};

for (const map of ['carthage', 'campus-martius']) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.goto(`${base}/?menu=0&map=${map}&scenario=assault&deploy=1&autoplay=0&quality=high`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  await page.waitForTimeout(2200);
  const p = await page.evaluate(PROFILE, [W, H]);
  console.log(`\n=== ${map} ===  gate bay (${p.gateBay.x}, ${p.gateBay.z}) foot y ${p.gateBay.groundY}`);
  console.log(`  relief along the outward normal, -6..160 m: ${p.relief} m`);
  console.log(`  inner lip  d ${p.innerLip.d} m  y ${p.innerLip.y}  -> screen (${p.innerLip.px.x}, ${p.innerLip.px.y})`);
  console.log(`  ditch floor d ${p.floor.d} m  y ${p.floor.y}  -> screen (${p.floor.px.x}, ${p.floor.px.y})`);
  console.log(`  outer lip  d ${p.outerLip.d} m  y ${p.outerLip.y}  -> screen (${p.outerLip.px.x}, ${p.outerLip.px.y})`);
  console.log(`  deployment zone ${p.zone?.label}`);
  console.log(`  unit cards start y ${p.cardTop}`);
  console.log(`  profile down the gate's own normal: ${p.rows.map((r) => `${r.d}m:${r.y}${r.px.off ? '' : `@y${r.px.y}`}`).join('  ')}`);
  console.log('  relief per bay over 0..90 m out (a ditch is bridged at its gate):');
  for (const q of p.perBay) {
    console.log(`    ${q.isGate ? 'GATE' : `k${q.k >= 0 ? '+' : ''}${q.k}  `}  relief ${String(q.relief).padStart(5)} m`
      + `  floor ${String(q.floorAt).padStart(3)} m out at y ${q.floorY}`
      + `  -> screen y ${q.floorPx.off ? 'off-frame' : q.floorPx.y} (lip y ${q.lipPx.off ? 'off' : q.lipPx.y})`);
  }
  await page.close();
}
await browser.close();
if (server) server.kill();
