#!/usr/bin/env node
/**
 * What a water surface costs, and whether it changed anything it must not.
 *
 * Four measurements, and the second and third are the ones that matter:
 *
 *   boot      the page loads, `window.__game.ready` goes true, and pageerror/console are
 *             empty. A typecheck is not proof of life on this project and never has been.
 *   movement  every cell of the nav grid, at three body radii, plus the city's own
 *             `blocksMovement` over the same lattice. **These are deterministic**, so unlike
 *             a rendered frame they are comparable across sessions: run this arm at HEAD and
 *             at the candidate and the two must agree exactly.
 *   cost      draw calls, triangles and frame time, measured with the water mesh visible and
 *             hidden **in the same session, interleaved, base arm re-shot last**. Two runs of
 *             this project at identical configuration differ on 50-70 % of pixels from VFX
 *             reseeding, so cross-session before/after is not a measurement here.
 *   shots     both arms of every camera, so the before and the after are one session apart
 *             and not one boot apart.
 *   tiers     ultra -> low -> medium -> high -> ultra through `Engine.setQuality`, with the
 *             last one a restore check. A CSM bug once rendered the whole world grey on a
 *             tier switch, and a material patched through `onBeforeCompile` is exactly the
 *             kind of thing a program rebuild loses.
 *
 * Usage:
 *   node tools/probe-water.mjs --port=5561 --map=carthage --shots=screenshots/water
 *   node tools/probe-water.mjs --port=5561 --map=carthage --only=movement --json=out.json
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const PORT = Number(args.get('port') ?? 5561);
const MAP = args.get('map') ?? 'carthage';
const SCENARIO = args.get('scenario') ?? 'field';
const QUALITY = args.get('quality') ?? 'ultra';
const HOUR = args.has('hour') ? Number(args.get('hour')) : null;
const SHOT_DIR = args.get('shots') ?? null;
const JSON_OUT = args.get('json') ?? null;
const ONLY = args.has('only') ? new Set(String(args.get('only')).split(',')) : null;
const want = (k) => !ONLY || ONLY.has(k);
const base = `http://127.0.0.1:${PORT}`;

/**
 * Cameras, per map.
 *
 * The view direction is `(sin yaw, cos yaw)` — `RTSCamera.place` says so — and at 17:00 on
 * Carthage the sun sits at (-0.937, 0.346, -0.043), which is 20.25 deg up and almost exactly
 * down -X. So **yaw 1.5 pi looks straight into the sun path** and yaw 0 or pi is cross-lit.
 * Both are shot deliberately: a specular surface should be transformed by the first and a
 * diffuse one should be identical in either, which is the whole claim under test.
 */
const CAMERAS = {
  carthage: [
    { name: 'gulf', x: 0, z: 1250, zoom: 0.62, yaw: Math.PI * 1.5, desc: 'Off the shore in the Gulf of Tunis, looking south down the sun path' },
    { name: 'horizon', x: 0, z: 1240, zoom: 0.55, yaw: 0, desc: 'From the shore out to the open sea and the horizon, cross-lit' },
    { name: 'gulfwide', x: 100, z: 1100, zoom: 0.95, yaw: Math.PI * 1.35, desc: 'Strategic: the whole east coast and the gulf beyond it' },
    { name: 'lake', x: -1040, z: 700, zoom: 0.72, yaw: Math.PI * 1.5, desc: 'The Lake of Tunis channel, across the Taenia bar into the sun' },
    { name: 'lakewide', x: -1000, z: 620, zoom: 0.95, yaw: Math.PI * 1.5, desc: 'Strategic: the head of the lake and the walls south anchor' },
    { name: 'taenia', x: -1080, z: 860, zoom: 0.66, yaw: Math.PI * 1.35, desc: 'Across the channel at the sand bar' },
    { name: 'cothon', x: -930, z: 1000, zoom: 0.78, yaw: Math.PI, desc: 'The circular harbour and its admiralty island from the north' },
    { name: 'harbours', x: -740, z: 1010, zoom: 0.9, yaw: Math.PI * 1.5, desc: 'Both basins, the sea entrance and the quays' },
    { name: 'byrsa', x: -240, z: 1080, zoom: 0.4, yaw: Math.PI * 0.82, desc: 'The byrsa camera the frame budget is measured at' },
    { name: 'assault', x: 30, z: 180, zoom: 0.55, yaw: 0, desc: 'The assault camera: only the horizon should carry water' },
  ],
  // The Tiber's centreline at these z is riverCentreX: -868 at z -300, -930 at z -520.
  // The sun bears (0.485, 0.741) at hour 10, so yaw 0.58 looks into it and 2.15 across it.
  'campus-martius': [
    { name: 'river', x: -868, z: -300, zoom: 0.72, yaw: 0.58, desc: 'The Tiber down the sun path' },
    { name: 'reach', x: -868, z: -300, zoom: 0.72, yaw: 2.15, desc: 'The same reach, cross-lit' },
    { name: 'ford', x: -930, z: -520, zoom: 0.68, yaw: 0.58, desc: 'The ford, where the shoal breaks the flow' },
    { name: 'assault', x: 30, z: 180, zoom: 0.55, yaw: 0, desc: 'The assault camera' },
  ],
  pydna: [
    { name: 'wide', x: 0, z: 0, zoom: 0.85, yaw: 0, desc: 'The plain — there must be no water surface anywhere' },
    { name: 'leucus', x: -300, z: -200, zoom: 0.66, yaw: Math.PI * 0.3, desc: 'The dry shingle braid of the Leucus' },
  ],
};

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

/**
 * A probe that silently graded a stale `dist/` reported 5/12 where the live tree scored
 * 12/12, so the server is started here or confirmed here and the first line says which — and
 * it prints the root, because the whole point of a worktree is that two trees serve the same
 * URL shape.
 */
let server = null;
let ownServer = false;
if (!(await waitForServer(base, 1500))) {
  ownServer = true;
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) {
    console.error('vite did not start on ' + base);
    process.exit(1);
  }
}
const load = os.loadavg();
console.log(`[probe-water] ${base} — ${ownServer ? 'server started by this run' : 'server already up'}`);
console.log(`[probe-water] root ${ROOT}`);
console.log(`[probe-water] load ${load.map((l) => l.toFixed(1)).join(' / ')} on ${os.cpus().length} cores`);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
const notes = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(`console.error: ${t}`);
  if (t.includes('[water]') || t.includes('[terrain]')) notes.push(t);
});

const cfg = { map: MAP, scenario: SCENARIO };
if (HOUR !== null) cfg.timeOfDay = HOUR;
const token = Buffer.from(JSON.stringify(cfg))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `${base}/?menu=0&quality=${QUALITY}&scenario=${SCENARIO}&battle=${token}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

try {
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null,
    { timeout: 180000 });
} catch {
  console.error('\n*** window.__game.ready never became true ***');
  for (const x of errors) console.error('   ' + x);
  await browser.close();
  if (server) server.kill();
  process.exit(1);
}
console.log(`[probe-water] booted ${MAP} at ${QUALITY}${HOUR !== null ? ` hour ${HOUR}` : ''}`);
for (const n of notes) console.log(`   ${n}`);

const out = { map: MAP, quality: QUALITY, load, notes };

// ---------------------------------------------------------------------------
// In-page harness
// ---------------------------------------------------------------------------
await page.evaluate(`
window.__wat = (() => {
  const g = window.__game;
  const engine = g.engine;
  const ctx = engine.context;
  const terrain = ctx.get('terrain');
  const sky = ctx.tryGet('sky');
  const nav = ctx.tryGet('pathfinding');
  const city = ctx.tryGet('city');
  let mesh = null;
  ctx.scene.traverse((o) => { if (o.name === 'water') mesh = o; });

  const survey = () => {
    const wl = terrain.map.terrain.waterLevel;
    const sd = sky ? sky.sunDirection : null;
    return {
      waterLevel: wl,
      farHeight: terrain.map.terrain.farHeight,
      declaresWater: terrain.map.terrain.water !== null,
      hasMesh: !!mesh,
      meshVerts: mesh ? mesh.geometry.getAttribute('position').count : 0,
      meshTris: mesh ? mesh.geometry.index.count / 3 : 0,
      sun: sd ? { x: +sd.x.toFixed(4), y: +sd.y.toFixed(4), z: +sd.z.toFixed(4),
                  elevationDeg: +(Math.asin(sd.y) * 180 / Math.PI).toFixed(2) } : null,
      envIntensity: ctx.scene.environmentIntensity,
      hasEnv: !!ctx.scene.environment,
    };
  };

  /**
   * Movement, over the whole map on a 3 m lattice.
   *
   * Three body radii because a formation, a horse and an engine are three different
   * questions, and the aggregate over the whole field is the number that would move if
   * anything at all about passability had changed. Water cells are called out separately
   * because they are the ones this workstream could plausibly have broken.
   */
  const movement = (cell) => {
    const HALF = 1400;
    const wl = terrain.map.terrain.waterLevel;
    const n = Math.floor((HALF * 2) / cell);
    const radii = [0.5, 1.5, 3.0];
    const standable = radii.map(() => 0);
    const waterStandable = radii.map(() => 0);
    let water = 0, land = 0, cityBlocks = 0, cityBlocksWater = 0;
    for (let j = 0; j < n; j++) {
      const z = -HALF + (j + 0.5) * cell;
      for (let i = 0; i < n; i++) {
        const x = -HALF + (i + 0.5) * cell;
        const wet = terrain.heightAt(x, z) < wl;
        if (wet) water++; else land++;
        const cb = city ? city.blocksMovement(x, z, x, z) : false;
        if (cb) { cityBlocks++; if (wet) cityBlocksWater++; }
        for (let r = 0; r < radii.length; r++) {
          if (nav && nav.isStandable(x, z, radii[r])) {
            standable[r]++;
            if (wet) waterStandable[r]++;
          }
        }
      }
    }
    return { cell, cells: n * n, water, land, cityBlocks, cityBlocksWater,
             radii, standable, waterStandable };
  };

  const setWater = (v) => { if (mesh) mesh.visible = v; };

  /**
   * Freeze the world. Two arms 48 frames apart are two seconds of sim apart, and the men,
   * the dust and the flags all move in that time. Paused, the only thing that differs
   * between the arms is the thing under test.
   */
  engine.time.paused = true;

  /**
   * Let the frame settle before it is read.
   *
   * Two rAFs is not enough and the first pass proved it: the post chain's eye adaptation
   * runs over about a second, so two arms shot two frames apart on the Campus Martius came
   * back one bleached yellow and one green with **no water in either frame**. Anything that
   * adapts over time has to be given that time or the A/B measures the adaptation.
   */
  const frame = async (n) => {
    for (let k = 0; k < (n || 48); k++) await new Promise((r) => requestAnimationFrame(r));
  };

  /** Draw calls, triangles and the frame's own mean linear luminance. */
  const info = () => {
    const i = ctx.renderer.info.render;
    const c = ctx.renderer.domElement;
    const W = 320, H = 180;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.drawImage(c, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let y = 0, chroma = 0;
    for (let k = 0; k < d.length; k += 4) {
      const r = d[k] / 255, gg = d[k + 1] / 255, b = d[k + 2] / 255;
      y += 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      chroma += Math.max(r, gg, b) - Math.min(r, gg, b);
    }
    const n = d.length / 4;
    return { calls: i.calls, triangles: i.triangles,
             luma_disp: +(y / n).toFixed(4), chroma_disp: +(chroma / n).toFixed(4) };
  };

  /** Median and p90 of rAF deltas over n frames, after a warm-up. */
  const timeFrames = async (n) => {
    const d = [];
    let last = performance.now();
    for (let k = 0; k < n; k++) {
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now();
      if (k >= 8) d.push(t - last);
      last = t;
    }
    d.sort((a, b) => a - b);
    return { median: +d[d.length >> 1].toFixed(2), p90: +d[Math.floor(d.length * 0.9)].toFixed(2), n: d.length };
  };

  const setTier = (t) => engine.setQuality(t);
  const tierState = () => ({ tier: ctx.quality.tier, hasMesh: !!mesh,
                             visible: mesh ? mesh.visible : null });

  return { survey, movement, setWater, frame, info, timeFrames, setTier, tierState,
           setCamera: (c) => g.setCamera(c.x, c.z, c.zoom, c.yaw), hasMesh: () => !!mesh };
})();
`);

out.survey = await page.evaluate(() => window.__wat.survey());
console.log(`\n── survey ─────────────────────────────────────────────`);
console.log(`  waterLevel ${out.survey.waterLevel}  farHeight ${out.survey.farHeight}`
  + `  declares water: ${out.survey.declaresWater}  mesh: ${out.survey.hasMesh}`
  + (out.survey.hasMesh ? ` (${out.survey.meshVerts} verts, ${out.survey.meshTris} tris)` : ''));
if (out.survey.sun) {
  console.log(`  sun (${out.survey.sun.x}, ${out.survey.sun.y}, ${out.survey.sun.z})`
    + `  elevation ${out.survey.sun.elevationDeg} deg`);
}
console.log(`  scene.environment ${out.survey.hasEnv ? 'present' : 'ABSENT'}`
  + `  intensity ${out.survey.envIntensity}`);

if (want('movement')) {
  out.movement = await page.evaluate(() => window.__wat.movement(3));
  const m = out.movement;
  console.log(`\n── movement, ${m.cell} m lattice, ${m.cells} cells ────────────`);
  console.log(`  under the datum ${m.water}   above it ${m.land}`);
  console.log(`  city.blocksMovement true on ${m.cityBlocks} cells, of which ${m.cityBlocksWater} are water`);
  for (let r = 0; r < m.radii.length; r++) {
    console.log(`  radius ${m.radii[r].toFixed(1)} m: standable ${m.standable[r]}`
      + `   of which under the datum ${m.waterStandable[r]}`
      + `   (${((1 - m.waterStandable[r] / Math.max(1, m.water)) * 100).toFixed(2)} % of water refuses a body this size)`);
  }
}

if (want('cost') || SHOT_DIR) {
  const cams = CAMERAS[MAP] ?? CAMERAS.carthage;
  const dir = SHOT_DIR ? path.resolve(ROOT, SHOT_DIR) : null;
  if (dir) await mkdir(dir, { recursive: true });
  out.cost = [];
  console.log(`\n── cost, water off/on interleaved in one session ──────`);
  for (const c of cams) {
    await page.evaluate((s) => window.__wat.setCamera(s), c);
    const row = { name: c.name, desc: c.desc };
    for (const arm of ['off', 'on', 'off2']) {
      await page.evaluate((v) => window.__wat.setWater(v), arm === 'on');
      await page.evaluate(() => window.__wat.frame(48));
      row[arm] = await page.evaluate(() => window.__wat.info());
      if (want('cost')) {
        row[arm].time = await page.evaluate(() => window.__wat.timeFrames(48));
      }
      if (dir && arm !== 'off2') {
        await page.screenshot({ path: path.join(dir, `${c.name}-${arm === 'on' ? 'after' : 'before'}.png`) });
      }
    }
    // The base arm is re-shot last as a drift check: it is the only thing that
    // distinguishes "my change did nothing" from "my arms did not restore".
    row.drift = row.off2.calls - row.off.calls;
    out.cost.push(row);
    console.log(`  ${c.name.padEnd(9)} draws ${String(row.off.calls).padStart(4)} -> ${String(row.on.calls).padStart(4)}`
      + `  (+${row.on.calls - row.off.calls})   tris ${(row.off.triangles / 1e6).toFixed(2)}M -> ${(row.on.triangles / 1e6).toFixed(2)}M`
      + `   luma ${row.off.luma_disp.toFixed(4)} -> ${row.on.luma_disp.toFixed(4)} (base again ${row.off2.luma_disp.toFixed(4)})`
      + `   chroma ${row.off.chroma_disp.toFixed(4)} -> ${row.on.chroma_disp.toFixed(4)}`
      + (row.off.time ? `\n            frame ${row.off.time.median.toFixed(2)} -> ${row.on.time.median.toFixed(2)} ms`
        + `   (base re-shot ${row.off2.time.median.toFixed(2)} ms, p90 ${row.off.time.p90.toFixed(2)} -> ${row.on.time.p90.toFixed(2)}, draw drift ${row.drift})` : ''));
  }
  await page.evaluate(() => window.__wat.setWater(true));
  if (dir) console.log(`  wrote ${cams.length * 2} frames to ${SHOT_DIR}`);
}

if (want('tiers')) {
  const cams = CAMERAS[MAP] ?? CAMERAS.carthage;
  await page.evaluate((s) => window.__wat.setCamera(s), cams[0]);
  await page.evaluate((v) => window.__wat.setWater(v), true);
  out.tiers = [];
  console.log(`\n── quality tiers at the ${cams[0].name} camera ───────────`);
  for (const t of ['ultra', 'low', 'medium', 'high', 'ultra']) {
    await page.evaluate((x) => window.__wat.setTier(x), t);
    await page.evaluate(() => window.__wat.frame(48));
    const st = await page.evaluate(() => window.__wat.tierState());
    const inf = await page.evaluate(() => window.__wat.info());
    out.tiers.push({ asked: t, ...st, ...inf });
    console.log(`  asked ${t.padEnd(7)} got ${String(st.tier).padEnd(7)} mesh ${st.hasMesh}`
      + ` visible ${st.visible}   draws ${String(inf.calls).padStart(4)}`
      + `   luma ${inf.luma_disp.toFixed(4)}   chroma ${inf.chroma_disp.toFixed(4)}`);
  }
}

out.errors = errors;
if (errors.length) {
  console.log(`\n── page errors ────────────────────────────────────────`);
  for (const e of errors) console.log('  ' + e);
} else {
  console.log(`\n  no pageerror and no console.error.`);
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 2));
  console.log(`  wrote ${JSON_OUT}`);
}

await browser.close();
if (server) server.kill();
process.exit(errors.length ? 1 : 0);
