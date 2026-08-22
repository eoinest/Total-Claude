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

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';

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
const requested = args.get('views') === 'none'
  ? []
  : args.get('views') ? String(args.get('views')).split(',') : Object.keys(VIEWS);
/** Quality tier. `high` is the tier `qa-determinism` pins, so the headcounts compare. */
const QUALITY = args.get('quality') ?? 'ultra';
/** Extra query, in `qa-determinism`'s spelling: `--battle=map=carthage&scenario=assault`. */
const EXTRA = args.get('battle') ? `&${args.get('battle')}` : '';

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

/*
 * Server and browser via `tools/lib/browser-budget.mjs` — 22 Aug 2026.
 *
 * The browser slot is taken **first** and the server started second, so a run that has to
 * queue queues holding nothing. `startVite` replaces `spawn('npx', ['vite', …])`, whose
 * handle was the npx wrapper rather than Vite and so left the server on the port when it was
 * killed; it also refuses to reuse a listener that is serving a different worktree, which
 * this file used to do silently.
 */
const browser = await launchBrowser({
  label: 'probe-ground', port: PORT, root: ROOT,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'probe-ground', slot: browser.budgetSlot,
});
await mkdir(OUT, { recursive: true });

const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(`${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}${EXTRA}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 120000 });

/*
 * Stop the rAF loop before anything is measured.
 *
 * `boot()` calls `engine.start()`, so between `ready` and the first `page.evaluate` the
 * simulation runs for however long the round trip took — a tenth of a second on a warm
 * machine, several on a cold one. That is enough for crowd resolution to nudge every
 * formation off its deployed anchor: the same units measured twice came back at x -300.017
 * and x -300.000. Nothing below wants a battle in progress; everything below wants t+0. The
 * screenshot loop drives `engine.frame` by hand and is unaffected.
 */
await page.evaluate(() => window.__game.engine.stop());

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

/**
 * Deployment-ground audit: is there water or an impassable slope where an army forms up?
 *
 * `docs/ROME.md` §15 tasks 1 and 2 both close on this file. Task 1 moves the Tiber onto the
 * survey, which brings the channel from x -800 to x -400 at the attacker's own latitude and
 * puts §3.2's *"cohort deployed in the Tiber"* within reach for the first time; task 2
 * re-cuts the relief, which is the other way to spoil a parade ground. Both are asked of the
 * built heightfield here rather than of the masks that shaped it.
 *
 * "Inside" is `mask >= 0.02`, ten times the 0.002 the heightfield itself uses to decide a
 * cell is worth flattening — so this is strictly the stronger claim: everywhere the terrain
 * build thought it was levelling.
 *
 * **It does not say the armies are dry.** These masks flatten ground; `sim/scenario.ts`
 * places units at fixed x about zero and never reads them. See `DEPLOY_AXIS_X`.
 */
const deploy = await page.evaluate(async () => {
  const t = window.__game.engine.ctx.get('terrain');
  let topo = null;
  try { topo = await import('/src/terrain/topography.ts'); } catch { return null; }
  if (!topo.germanDeployMask) return null;
  const WATER = topo.WATER_LEVEL;
  const IMPASSABLE = 0.62; // ROUGH_SLOPE_IMPASSABLE, src/sim/Obstacles.ts
  const rows = [];
  for (const [name, mask] of [['attacker', topo.germanDeployMask], ['defender', topo.romanDeployMask]]) {
    let cells = 0, wet = 0, steep = 0, minH = Infinity, maxSlope = 0;
    let wettest = null, steepest = null;
    for (let z = -420; z <= 420; z += 4) {
      for (let x = -800; x <= 800; x += 4) {
        if (mask(x, z) < 0.02) continue;
        cells++;
        const h = t.heightAt(x, z);
        if (h < minH) minH = h;
        if (h < WATER) { wet++; if (!wettest || h < wettest.h) wettest = { x, z, h: +h.toFixed(2) }; }
        const s = Math.hypot((t.heightAt(x + 4, z) - t.heightAt(x - 4, z)) / 8,
          (t.heightAt(x, z + 4) - t.heightAt(x, z - 4)) / 8);
        if (s > maxSlope) { maxSlope = s; steepest = { x, z, s: +s.toFixed(3) }; }
        if (s > IMPASSABLE) steep++;
      }
    }
    rows.push({ name, cells, wet, steep, minH: +minH.toFixed(2), maxSlope: +maxSlope.toFixed(3), wettest, steepest });
  }
  return rows;
});
if (deploy) {
  for (const d of deploy) {
    console.log(`• ${d.name} deployment ground: ${d.cells} cells, ${d.wet} under water, `
      + `${d.steep} over the impassable slope; lowest ${d.minH} m, steepest ${d.maxSlope}`
      + (d.wettest ? `, wettest (${d.wettest.x}, ${d.wettest.z}) at ${d.wettest.h} m` : '')
      + (d.steepest ? `, steepest (${d.steepest.x}, ${d.steepest.z})` : ''));
  }
}

/**
 * Deployment audit — **the men**, which is a different question from the ground.
 *
 * The audit above asks whether the deployment *boxes* are dry. It says nothing about the
 * army, and the note on `DEPLOY_AXIS_X` is explicit that it cannot: the masks flatten
 * ground and `sim/scenario.ts` places units. Task 1 moved the boxes east onto dry land and
 * left the order of battle where it was, so on the corrected ground the two questions have
 * different answers and only this one is about soldiers.
 *
 * Everything here is measured off the pool at t+0 — real men at real positions, not the
 * anchors the deployment asked for — and the boxes are measured off the mask *functions*
 * by scanning them, never read off the arguments they were called with. A centre
 * transcribed from a call site is the fault this probe exists to catch.
 *
 * Two independent tests for "in the river", because one of them could be wrong:
 *   `wet`     ground height under `WATER_LEVEL` — the man is standing in water;
 *   `channel` inside `±RIVER_HALF_WIDTH` of the bed's own centreline.
 * They measure the same thing by different routes and are printed side by side. A large
 * disagreement means the instrument is broken, not the battle.
 *
 * `farBank` is the subtler half and is deliberately *dry*: a man west of the west bank is
 * not drowning, he is in the wrong battle.
 */
const army = await page.evaluate(async () => {
  const g = window.__game;
  const t = g.engine.ctx.get('terrain');
  let topo = null;
  let maps = null;
  try {
    topo = await import('/src/terrain/topography.ts');
    maps = await import('/src/maps/index.ts');
  } catch { return null; }
  const mapId = maps?.activeMap?.().id ?? null;
  // This audit reads Rome's topography module directly, so it can only speak about Rome's
  // map. Saying so beats reporting the Tiber's bank on a map that has no Tiber.
  if (mapId !== 'campus-martius' || !topo.germanDeployMask) return { mapId, skipped: true };

  const WATER = topo.WATER_LEVEL;

  /** Centroid and extent of a mask, scanned rather than transcribed. */
  const boxOf = (mask) => {
    let n = 0, sx = 0, sz = 0;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let z = -1400; z <= 1400; z += 4) {
      for (let x = -1400; x <= 1400; x += 4) {
        if (mask(x, z) < 0.02) continue;
        n++; sx += x; sz += z;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
    }
    return n ? { cx: sx / n, cz: sz / n, x0, x1, z0, z1 } : null;
  };
  const boxes = [
    { key: 'attacker box', mask: topo.germanDeployMask, box: boxOf(topo.germanDeployMask) },
    { key: 'defender box', mask: topo.romanDeployMask, box: boxOf(topo.romanDeployMask) },
  ].filter((b) => b.box);

  const pool = g.battle.pool;
  const factions = [...new Set(g.battle.units.map((u) => u.faction))].sort((a, b) => a - b);
  const rows = [];
  for (const faction of factions) {
    const us = g.battle.units.filter((u) => u.faction === faction);
    const zc = us.reduce((s, u) => s + u.z, 0) / us.length;
    // The army's own box is the nearer of the two in z. Keyed on where the army stands, not
    // on what it is called: at Carthage the same code would have Rome in the northern box.
    const own = boxes.reduce((a, b) =>
      Math.abs(b.box.cz - zc) < Math.abs(a.box.cz - zc) ? b : a);

    let men = 0, wet = 0, channel = 0, farBank = 0, outside = 0;
    let outsideWest = 0, outsideEast = 0, steep = 0, worstSlope = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let deepest = null, worstWest = null;
    // Coarse bucket grid of this army's men, so the vegetation test below is a lookup rather
    // than 8,632 x 2,377 distance computations.
    const CELL = 8;
    const grid = new Map();
    for (let i = 0; i < pool.count; i++) {
      if (pool.faction[i] !== faction || pool.hp[i] <= 0) continue;
      men++;
      const x = pool.x[i];
      const z = pool.z[i];
      grid.set(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`, 1);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      const h = t.heightAt(x, z);
      if (h < WATER) {
        wet++;
        if (!deepest || h < deepest.h) deepest = { x: +x.toFixed(1), z: +z.toFixed(1), h: +h.toFixed(2) };
      }
      const off = topo.riverOffset(x, z);
      if (Math.abs(off) < topo.RIVER_HALF_WIDTH) channel++;
      if (h >= WATER && x < topo.riverBankX(z, -1)) {
        farBank++;
        if (!worstWest || x < worstWest.x) worstWest = { x: +x.toFixed(1), z: +z.toFixed(1) };
      }
      if (own.mask(x, z) < 0.02) {
        outside++;
        if (x < own.box.cx) outsideWest++; else outsideEast++;
      }
      // The other way a parade ground can be spoiled, and the reason the boxes flatten
      // anything at all: `ROUGH_SLOPE_IMPASSABLE` is 0.62 in `src/sim/Obstacles.ts`.
      const sl = Math.hypot((t.heightAt(x + 4, z) - t.heightAt(x - 4, z)) / 8,
        (t.heightAt(x, z + 4) - t.heightAt(x, z - 4)) / 8);
      if (sl > worstSlope) worstSlope = sl;
      if (sl > 0.62) steep++;
    }
    /*
     * Trees standing in the ranks.
     *
     * The boxes exclude vegetation *"so no tree stands inside a formation"*, and that
     * exclusion is keyed on the mask. Any part of a line standing outside its own box is
     * therefore standing on ground that was planted, so this counts what is actually in
     * among the men rather than assuming the exclusion covered them.
     */
    let treesAmong = 0;
    const scatter = t.scatter;
    for (const gr of (scatter?.groups ?? [])) {
      for (const it of gr.items) {
        const cx0 = Math.floor((it.x - 4) / CELL), cx1 = Math.floor((it.x + 4) / CELL);
        const cz0 = Math.floor((it.z - 4) / CELL), cz1 = Math.floor((it.z + 4) / CELL);
        let hit = false;
        for (let cx = cx0; cx <= cx1 && !hit; cx++) {
          for (let cz = cz0; cz <= cz1 && !hit; cz++) hit = grid.has(`${cx},${cz}`);
        }
        if (hit) treesAmong++;
      }
    }
    rows.push({
      faction, box: own.key, units: us.length, men,
      wet, channel, farBank, outside, outsideWest, outsideEast,
      steep, worstSlope: +worstSlope.toFixed(3), treesAmong,
      frontage: +(maxX - minX).toFixed(1), depth: +(maxZ - minZ).toFixed(1),
      xSpan: [+minX.toFixed(1), +maxX.toFixed(1)],
      zSpan: [+minZ.toFixed(1), +maxZ.toFixed(1)],
      deepest, worstWest,
      anchors: us.map((u) => ({
        id: u.id, type: u.typeId,
        x: +u.x.toFixed(3), z: +u.z.toFixed(3), facing: +u.facing.toFixed(6),
        width: u.width, spacingX: +u.spacingX.toFixed(3), spacingZ: +u.spacingZ.toFixed(3),
        alive: u.alive,
      })),
    });
  }
  return {
    mapId,
    boxes: boxes.map((b) => ({
      key: b.key,
      cx: +b.box.cx.toFixed(1), cz: +b.box.cz.toFixed(1),
      x: [b.box.x0, b.box.x1], z: [b.box.z0, b.box.z1],
    })),
    armies: rows,
  };
});
if (army && !army.skipped) {
  for (const b of army.boxes) {
    console.log(`• ${b.key}: centre x ${b.cx}, z ${b.cz}; x ${b.x[0]}..${b.x[1]}, z ${b.z[0]}..${b.z[1]}`);
  }
  for (const a of army.armies) {
    console.log(`• faction ${a.faction} (${a.box}): ${a.men} men in ${a.units} units, `
      + `frontage ${a.frontage} m (x ${a.xSpan[0]}..${a.xSpan[1]}), depth ${a.depth} m `
      + `(z ${a.zSpan[0]}..${a.zSpan[1]})`);
    console.log(`    IN WATER ${a.wet} (channel test ${a.channel}) · FAR BANK ${a.farBank} · `
      + `outside its own box ${a.outside} (${a.outsideWest} west, ${a.outsideEast} east)`
      + (a.deepest ? ` · deepest (${a.deepest.x}, ${a.deepest.z}) at ${a.deepest.h} m` : '')
      + (a.worstWest ? ` · furthest west dry (${a.worstWest.x}, ${a.worstWest.z})` : ''));
    console.log(`    over the impassable slope ${a.steep} (worst ${a.worstSlope}) · `
      + `trees within 4 m of a man ${a.treesAmong}`);
  }
} else if (army?.skipped) {
  console.log(`• men audit skipped: this audit reads Rome's topography and the map is '${army.mapId}'`);
}
if (args.get('dump')) {
  await writeFile(path.resolve(ROOT, args.get('dump')),
    JSON.stringify({ deploy, army }, null, 2));
  console.log(`• dumped to ${args.get('dump')}`);
}

// Vegetation keep-out audit: read the placed instances straight out of the scatter field.
const keepout = await page.evaluate(async () => {
  const t = window.__game.engine.ctx.get('terrain');
  const scatter = t.scatter;
  if (!scatter || !scatter.groups) return null;
  /*
   * The wall's line, read from the module rather than transcribed.
   *
   * It was an inlined copy of `crestZAt` — `330 + 52 sin(0.00476 x) + 26 sin(0.01053 x + 2.1)
   * + 175` — which was right until §15 task 2 gave the wall's line its own name and left
   * `crestZAt` as the terrain's brow. A transcribed constant in a probe measures the tree it
   * was written against, not the one in front of it.
   */
  const topo = await import('/src/terrain/topography.ts');
  const crest = topo.romeWallZ;
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
await closeServer();
