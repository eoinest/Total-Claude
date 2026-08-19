#!/usr/bin/env node
/**
 * Scratch: split the opening shot's horizontal error into its two causes.
 *
 * The standing hypothesis was that the gate ran off the side of the frame because the yaw
 * was the literal `0` while the offset came from the bay's outward normal. That is one of
 * two faults in the same expression: the focus was also `mid(1)` — the bay *next to* the
 * gate — so the shot was aimed one bay along the curtain before the yaw was applied.
 *
 * Four configurations, all driven at the shipped zoom 0.52 so only the azimuth varies, and
 * all measured off the render matrix:
 *   asShipped   focus mid(1) + 96 n(1),  yaw 0
 *   yawOnly     focus mid(1) + 96 n(1),  yaw = atan2(-nx, -nz) of the gate bay
 *   bayOnly     focus mid(0) + 96 n(0),  yaw 0
 *   both        focus mid(0) + 96 n(0),  yaw = atan2(-nx, -nz)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5393);
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
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await up(90000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});

const RUN = ([W, H]) => {
  const g = window.__game;
  const rig = g.engine.rig;
  const cam = g.engine.context.camera;
  const bays = g.engine.context.tryGet('city').getGarrisonBays();
  const gb = bays.find((b) => b.isGate);
  const nb = bays[gb.index + 1];
  const mid = (b) => ({ x: (b.x0 + b.x1) * 0.5, z: (b.z0 + b.z1) * 0.5 });
  const g0 = mid(gb), g1 = mid(nb);
  const yawN = Math.atan2(-gb.nx, -gb.nz);
  const V = cam.position.constructor;
  const v = new V();
  const px = (x, y, z) => {
    cam.updateMatrixWorld(true);
    v.set(x, y, z).project(cam);
    return { x: +((v.x * 0.5 + 0.5) * W).toFixed(1), y: +((-v.y * 0.5 + 0.5) * H).toFixed(1) };
  };
  const shot = (label, fx, fz, yaw) => {
    rig.jumpTo(fx, fz, 0.52, yaw);
    const p = px(g0.x, gb.crestY, g0.z);
    return { label, yawDeg: +((yaw * 180) / Math.PI).toFixed(2), gateCrest: p,
      dxFromCentre: +(p.x - W / 2).toFixed(1) };
  };
  return {
    gateBayIndex: gb.index,
    normalYawDeg: +((yawN * 180) / Math.PI).toFixed(2),
    alongWallOffset: +Math.hypot(g1.x - g0.x, g1.z - g0.z).toFixed(1),
    rows: [
      shot('asShipped  mid(1) yaw0   ', g1.x + nb.nx * 96, g1.z + nb.nz * 96, 0),
      shot('yawOnly    mid(1) yawN   ', g1.x + nb.nx * 96, g1.z + nb.nz * 96, yawN),
      shot('bayOnly    mid(0) yaw0   ', g0.x + gb.nx * 96, g0.z + gb.nz * 96, 0),
      shot('both       mid(0) yawN   ', g0.x + gb.nx * 96, g0.z + gb.nz * 96, yawN),
    ],
  };
};

for (const map of ['carthage', 'campus-martius']) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.goto(`${base}/?menu=0&map=${map}&scenario=assault&deploy=1&autoplay=0&quality=high`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  await page.waitForTimeout(2000);
  const r = await page.evaluate(RUN, [W, H]);
  console.log(`\n=== ${map} ===  gate bay ${r.gateBayIndex}, normal yaw ${r.normalYawDeg} deg, `
    + `one bay along = ${r.alongWallOffset} m`);
  for (const s of r.rows) {
    console.log(`  ${s.label} yaw ${String(s.yawDeg).padStart(5)}  gate-bay crest x `
      + `${String(s.gateCrest.x).padStart(7)}  (${s.dxFromCentre >= 0 ? '+' : ''}${s.dxFromCentre} px off centre)  y ${s.gateCrest.y}`);
  }
  await page.close();
}
await browser.close();
if (server) server.kill();
