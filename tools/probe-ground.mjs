#!/usr/bin/env node
/**
 * Ground inspection probe.
 *
 * Renders arbitrary cameras with the HUD hidden and, optionally, the units and the dust
 * suppressed, so the terrain and its vegetation can be judged on their own. The graded
 * screenshot harness deliberately shows the whole frame including HUD, particles and men;
 * that is right for grading a *game* frame and useless for deciding whether a detail
 * normal is reading.
 *
 * Also reports how many scatter instances sit inside the wall keep-out, which is the only
 * honest way to confirm that exclusion holds.
 *
 *   node tools/probe-ground.mjs --port=5214 --out=screenshots/crit-world/ground
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

// x, z, zoom (0 = eye level, 1 = strategic), yaw
const VIEWS = {
  sward: { x: -20, z: 128, zoom: 0.05, yaw: Math.PI * 1.42, desc: 'eye level in the sward' },
  boots: { x: 120, z: 40, zoom: 0.02, yaw: Math.PI * 0.8, desc: 'boot level, open plain' },
  fields: { x: -120, z: -60, zoom: 0.34, yaw: Math.PI * 0.55, desc: 'the field patchwork at 60 m' },
  midplain: { x: -300, z: -150, zoom: 0.62, yaw: Math.PI * 0.35, desc: 'plain from 200 m' },
  wallfoot: { x: -120, z: 430, zoom: 0.22, yaw: 0.0, desc: 'wall foot — vegetation keep-out' },
  roadside: { x: 40, z: 300, zoom: 0.12, yaw: Math.PI * 0.02, desc: 'Via Flaminia paving and verge' },
  // Mirrors of the graded cameras in tools/shoot.mjs, so the same framings can be judged
  // with the HUD out of the way.
  gwide: { x: 0, z: 90, zoom: 0.95, yaw: Math.PI * 0.82, desc: 'graded: wide' },
  gterrain: { x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4, desc: 'graded: terrain' },
  gcity: { x: 60, z: 400, zoom: 0.62, yaw: 0.0, desc: 'graded: city' },
  gwall: { x: -120, z: 470, zoom: 0.58, yaw: 0.0, desc: 'graded: wall' },
  gskyline: { x: -180, z: 780, zoom: 0.8, yaw: Math.PI * 0.05, desc: 'graded: skyline' },
  gdeepcity: { x: -20, z: 1050, zoom: 0.86, yaw: Math.PI * 0.1, desc: 'graded: deepcity' },
  gline: { x: -20, z: 128, zoom: 0.16, yaw: Math.PI * 1.42, desc: 'graded: romanline' },
};

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5214);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/crit-world/ground');
const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);
const KEEP_UNITS = args.has('units');
const requested = args.get('views') ? String(args.get('views')).split(',') : Object.keys(VIEWS);

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let server = null;
const base = `http://127.0.0.1:${PORT}`;
if (!(await waitForServer(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) throw new Error('vite did not start');
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 120000 });

// Hide everything that is not the world, so the ground can be judged on its own.
const hidden = await page.evaluate((keepUnits) => {
  // Hide every DOM layer except the renderer's own canvas — found by identity, because the
  // post chain may own a different canvas from the one the page markup declares.
  const canvas = window.__game.engine.ctx.renderer.domElement;
  for (const el of document.querySelectorAll('body > *')) {
    if (el !== canvas && !el.contains(canvas)) el.style.display = 'none';
  }
  const scene = window.__game.engine.ctx.scene;
  const off = [];
  scene.traverse((o) => {
    const n = o.name || '';
    const isUnit = /^soldiers|^horses|^corpses/.test(n) || /impostor/.test(n);
    const isFx = /^vfx-/.test(n);
    if ((isUnit && !keepUnits) || isFx) {
      if (o.visible) {
        o.visible = false;
        off.push(n);
      }
    }
  });
  return off;
}, KEEP_UNITS);
console.log(`• hidden: ${hidden.join(', ') || 'nothing'}`);

// Vegetation keep-out audit: read the placed instances straight out of the scatter field.
const keepout = await page.evaluate(() => {
  const t = window.__game.engine.ctx.get('terrain');
  const scatter = t.scatter;
  if (!scatter || !scatter.groups) return null;
  // crestZAt from src/terrain/topography.ts, inlined: the probe cannot import modules.
  const crest = (x) => 330 + 52 * Math.sin(x * 0.00476) + 26 * Math.sin(x * 0.01053 + 2.1) + 175;
  const rows = [];
  for (const g of scatter.groups) {
    let deepest = -1e9;
    let n = 0;
    for (const p of g.items) {
      const c = crest(p.x) - p.z; // positive = outside the wall line
      if (c < 30) n++;
      if (-c > deepest) deepest = -c;
    }
    rows.push({
      species: g.species,
      total: g.items.length,
      within30m: n,
      deepestPastWall: Math.round(deepest),
    });
  }
  return rows;
});
if (keepout) console.log('• keep-out audit:', JSON.stringify(keepout));

for (const name of requested) {
  const v = VIEWS[name];
  if (!v) continue;
  await page.evaluate(
    async ({ v }) => {
      const g = window.__game;
      g.setCamera(v.x, v.z, v.zoom, v.yaw);
      g.advance(0.4);
      // The engine's own loop is not driving the page here, so present explicitly —
      // several frames, to let camera smoothing, LOD hysteresis and TAA history settle.
      for (let i = 0; i < 20; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
    },
    { v }
  );
  const buf = await page.screenshot({ type: 'png' });
  await writeFile(path.join(OUT, `${name}.png`), buf);

  // A/B the cost of the ground stack against the rest of the frame. Same camera, same
  // frame count, `readPixels` barrier — the only honest way to tell whether a slow frame
  // is the grass or somebody else's system.
  const perf = await page.evaluate(() => {
    const g = window.__game;
    const gl = g.engine.ctx.renderer.getContext();
    const px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const time = (n) => {
      g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
      sync();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
      sync();
      return (performance.now() - t0) / n;
    };
    const named = (re) => {
      const out = [];
      g.engine.ctx.scene.traverse((o) => {
        if ((o.isMesh || o.isInstancedMesh) && re.test(o.name || '') && o.visible) out.push(o);
      });
      return out;
    };
    const all = time(24);
    const grass = named(/^grass-/);
    for (const o of grass) o.visible = false;
    const noGrass = time(24);
    for (const o of grass) o.visible = true;
    const veg = named(/^veg-/);
    for (const o of veg) o.visible = false;
    const noVeg = time(24);
    for (const o of veg) o.visible = true;
    return { all, noGrass, noVeg, draws: g.engine.stats().calls };
  });
  console.log(
    `  ✓ ${name.padEnd(10)} ${v.desc.padEnd(34)} ${perf.all.toFixed(2)}ms ` +
      `(−grass ${perf.noGrass.toFixed(2)}, −veg ${perf.noVeg.toFixed(2)}, ${perf.draws} draws)`
  );
}

await browser.close();
if (server) server.kill('SIGTERM');
