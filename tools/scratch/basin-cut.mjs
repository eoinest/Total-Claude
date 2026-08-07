#!/usr/bin/env node
/**
 * Does the heightfield actually excavate the harbours?
 *
 * `docs/ARCHITECTURE.md` quotes "51 % of the cothon's water area and 84 % of the merchant
 * basin's stand under terrain that is above their surface" — but that figure is prose, not an
 * instrument: nothing in the tree computes it, so nothing can watch it move. This does.
 *
 * It reads the basins out of the map's own `WaterProfile` rather than restating COTHON and
 * MERCHANT_HARBOUR, so it cannot disagree with the surfaces that are actually rendered, and it
 * samples `TerrainSystem.heightAt` on a 2 m lattice inside each basin's plan.
 *
 *   node tools/scratch/basin-cut.mjs --port=5563
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5563);
const base = `http://127.0.0.1:${PORT}`;

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

let server = null;
let own = false;
if (!(await waitForServer(base, 1500))) {
  own = true;
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) { console.error('vite did not start'); process.exit(1); }
}
console.log(`[basin-cut] ${base} — ${own ? 'server started by this run' : 'server already up'}, root ${ROOT}`);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(`console.error: ${t}`);
  if (t.includes('[carthage]') || t.includes('[harbour]')) console.log(`  page> ${t}`);
});

const token = Buffer.from(JSON.stringify({ map: 'carthage', scenario: 'field' }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
await page.goto(`${base}/?menu=0&quality=low&scenario=field&battle=${token}`,
  { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });
} catch {
  console.error('*** window.__game.ready never became true ***');
  for (const e of errors) console.error('   ' + e);
  await browser.close(); if (server) server.kill(); process.exit(1);
}
console.log(`[basin-cut] booted`);

const res = await page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const terrain = ctx.get('terrain');
  const H = (x, z) => terrain.heightAt(x, z);
  const prof = terrain.map.terrain.water;
  const waterLevel = terrain.map.terrain.waterLevel;
  const STEP = 2;

  const basins = (prof.basins ?? []).map((b, k) => {
    const s = b.shape;
    const box = s.kind === 'rect'
      ? { x0: s.x - s.hw, x1: s.x + s.hw, z0: s.z - s.hd, z1: s.z + s.hd }
      : { x0: s.x - s.outerR, x1: s.x + s.outerR, z0: s.z - s.outerR, z1: s.z + s.outerR };
    const inShape = (x, z) => {
      if (s.kind === 'rect') return true;
      const r = Math.hypot(x - s.x, z - s.z);
      return r <= s.outerR && r >= (s.innerR ?? 0);
    };
    let cells = 0, buried = 0, aboveDatum = 0;
    let lo = Infinity, hi = -Infinity, sum = 0;
    const beds = [];
    for (let z = box.z0 + STEP / 2; z < box.z1; z += STEP) {
      for (let x = box.x0 + STEP / 2; x < box.x1; x += STEP) {
        if (!inShape(x, z)) continue;
        const h = H(x, z);
        cells++;
        if (h > b.y) buried++;
        if (h > waterLevel) aboveDatum++;
        lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h;
        beds.push(h);
      }
    }
    beds.sort((a, c) => a - c);
    const q = (t) => beds.length ? beds[Math.floor(t * (beds.length - 1))] : 0;
    return {
      k, kind: s.kind, surfaceY: b.y, declaredDepth: b.depth,
      areaHa: +((cells * STEP * STEP) / 1e4).toFixed(2),
      pctBuried: +((buried / Math.max(1, cells)) * 100).toFixed(1),
      pctAboveDatum: +((aboveDatum / Math.max(1, cells)) * 100).toFixed(1),
      bed: { min: +lo.toFixed(2), p10: +q(0.1).toFixed(2), median: +q(0.5).toFixed(2),
             p90: +q(0.9).toFixed(2), max: +hi.toFixed(2), mean: +(sum / Math.max(1, cells)).toFixed(2) },
    };
  });

  /** Named terrain samples: the two quay references and the survey's harbour-district point. */
  const at = (name, x, z) => ({ name, x, z, h: +H(x, z).toFixed(2) });
  const points = [
    at('cothon centre (island; harbour.ts quayY)', -930, 1000),
    at('cothon ring quay, landward (-x side)', -930 - 172, 1000),
    at('cothon ring quay, seaward (+z side)', -930, 1000 + 172),
    at('cothon ring quay, +x side', -930 + 172, 1000),
    at('cothon ring quay, -z side', -930, 1000 - 172),
    at('merchant centre (harbour.ts mQuayY)', -540, 1010),
    at('merchant quay, west', -540, 1010 - 75 - 8),
    at('survey point: harbour district', -600, 978),
    at('inter-basin channel, mid', -733, 1005),
    at('the Carthaginian cut, in the mole', -915, 1190),
  ];

  /**
   * The steepest gradient over the pathfinder's own 7 m cell anywhere on the ground a man is
   * meant to walk in the harbour: the ring quay belt and the landward approach to it.
   */
  const grad = (x, z) => {
    const d = 3.5;
    return Math.hypot((H(x + d, z) - H(x - d, z)) / (2 * d), (H(x, z + d) - H(x, z - d)) / (2 * d));
  };
  /**
   * §6.4's two channels, so a bank the city already stamps as solid is not graded as quay.
   * Endpoints are `harbour.ts:occSegments`; distance is returned as a fraction of half-width.
   */
  const CH = [
    { x1: -930, z1: 1000 + 162.5 + 6, x2: -930 + 60, z2: 1340, half: 15 },
    { x1: -930 + 162.5 + 8, z1: 1000, x2: -540 - 160 - 6, z2: 1010, half: 10.5 },
  ];
  const channelNess = (x, z) => Math.min(...CH.map((c) => {
    const dx = c.x2 - c.x1, dz = c.z2 - c.z1, l2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - c.x1) * dx + (z - c.z1) * dz) / l2));
    return Math.hypot(x - (c.x1 + dx * t), z - (c.z1 + dz * t)) / c.half;
  }));

  // From outerR + 5, not outerR: the 7 m stencil straddles the basin's revetment for the
  // first 3.5 m and reads the 5 m drop into the water, which is a real refusal and not a bug.
  let worstQuay = 0, worstQuayAt = null;
  for (let a = 0; a < 360; a += 1) {
    const th = (a * Math.PI) / 180;
    for (let r = 167.5; r <= 181.5; r += 1) {
      const x = -930 + Math.cos(th) * r;
      const z = 1000 + Math.sin(th) * r;
      if (channelNess(x, z) < 1.6) continue;
      const g = grad(x, z);
      if (g > worstQuay) { worstQuay = g; worstQuayAt = [Math.round(x), Math.round(z)]; }
    }
  }
  // The landward approach: the ground between the city and the ring, which must stay walkable.
  let worstApproach = 0, worstApproachAt = null;
  for (let z = 860; z <= 1040; z += 2) {
    for (let x = -1140; x <= -700; x += 2) {
      if (Math.hypot(x + 930, z - 1000) < 187) continue;
      if (z > 1039) continue; // seaward of shoreZAt: not city ground
      if (channelNess(x, z) < 1.6) continue;
      const g = grad(x, z);
      if (g > worstApproach) { worstApproach = g; worstApproachAt = [Math.round(x), Math.round(z)]; }
    }
  }

  /** Dry/wet split over the harbour quarter, so a raise cannot quietly drain the gulf. */
  let wet = 0, dry = 0;
  for (let z = 780; z <= 1360; z += 4) {
    for (let x = -1240; x <= -640; x += 4) {
      if (H(x, z) < waterLevel) wet++; else dry++;
    }
  }

  /**
   * **Can a cohort still walk from the city onto the ring quay?**
   *
   * The whole point of the made ground is that its seaward face refuses a formation, and a
   * mole whose *landward* face also refuses one is a harbour nobody can reach. Flood fill the
   * pathfinder's own `isStandable` at the 17.5 m body from the harbour district, over terrain
   * only, and ask which azimuths of the ring quay it arrives at.
   */
  const nav = ctx.tryGet('pathfinding');
  let quayReach = null;
  if (nav && nav.isStandable) {
    const C = 3, X0 = -1260, Z0 = 760, NX = 220, NZ = 220;
    const key = (i, j) => j * NX + i;
    const ok = new Uint8Array(NX * NZ);
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      ok[key(i, j)] = nav.isStandable(X0 + i * C, Z0 + j * C, 3.0) ? 1 : 0;
    }
    const seen = new Uint8Array(NX * NZ);
    const si = Math.round((-600 - X0) / C), sj = Math.round((978 - Z0) / C);
    const q = [key(si, sj)];
    seen[q[0]] = 1;
    let reached = 0;
    while (q.length) {
      const c = q.pop();
      reached++;
      const ci = c % NX, cj = (c - ci) / NX;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
        const n = key(ni, nj);
        if (seen[n] || !ok[n]) continue;
        seen[n] = 1; q.push(n);
      }
    }
    /**
     * Three radii, because the annulus is three different pieces of ground: the ring quay men
     * fight along (172), the ring-shed range behind their mouths (142) and the island-shed
     * range (82). Digging the whole annulus takes the two shed ranges under water; this says
     * whether they were reachable ground before it and whether they are after.
     */
    const band = (r) => {
      const out = [];
      for (let a = 0; a < 360; a += 30) {
        const th = (a * Math.PI) / 180;
        const x = -930 + Math.cos(th) * r, z = 1000 + Math.sin(th) * r;
        const i = Math.round((x - X0) / C), j = Math.round((z - Z0) / C);
        const inGrid = i >= 0 && j >= 0 && i < NX && j < NZ;
        out.push({ deg: a, standable: inGrid ? !!ok[key(i, j)] : null,
          reached: inGrid ? !!seen[key(i, j)] : null, h: +H(x, z).toFixed(2) });
      }
      return { r, reached: out.filter((o) => o.reached).length, of: out.length,
        standable: out.filter((o) => o.standable).length, detail: out };
    };
    // Area of each band that a 35 m body can stand on and reach from the city, in hectares.
    const areaOf = (r0, r1) => {
      let cells = 0, reachedCells = 0;
      for (let z = 760; z < 760 + NZ * C; z += C) {
        for (let x = X0; x < X0 + NX * C; x += C) {
          const rr = Math.hypot(x + 930, z - 1000);
          if (rr < r0 || rr > r1) continue;
          const i = Math.round((x - X0) / C), j = Math.round((z - Z0) / C);
          if (i < 0 || j < 0 || i >= NX || j >= NZ) continue;
          cells++;
          if (seen[key(i, j)]) reachedCells++;
        }
      }
      return { r0, r1, ha: +((cells * C * C) / 1e4).toFixed(2),
        reachedHa: +((reachedCells * C * C) / 1e4).toFixed(2) };
    };
    quayReach = {
      seedFrom: [-600, 978], cellsReached: reached,
      bands: [band(172), band(142), band(82)],
      areas: [areaOf(122.5, 162.5), areaOf(62.5, 102.5), areaOf(162.5, 182.5)],
    };
  }

  return {
    waterLevel, basins, points,
    worstQuayGradient: +worstQuay.toFixed(3), worstQuayAt,
    worstApproachGradient: +worstApproach.toFixed(3), worstApproachAt,
    harbourQuarter: { wetCells: wet, dryCells: dry, cellM: 4 },
    quayReach,
  };
});

console.log('\n── the two authored basins, against the bed under them ──');
for (const b of res.basins) {
  console.log(`  basin ${b.k} (${b.kind}): surface ${b.surfaceY.toFixed(2)} m, declared depth ${b.declaredDepth} m, ${b.areaHa} ha`);
  console.log(`     ** ${b.pctBuried}% of its water area stands under terrain above its surface **`);
  console.log(`     ${b.pctAboveDatum}% of it is above the datum (${res.waterLevel})`);
  console.log(`     bed  min ${b.bed.min}  p10 ${b.bed.p10}  median ${b.bed.median}  p90 ${b.bed.p90}  max ${b.bed.max}  mean ${b.bed.mean}`);
}
console.log('\n── named samples ──');
for (const p of res.points) console.log(`  ${String(p.h).padStart(7)} m   ${p.name}  (${p.x}, ${p.z})`);
console.log('\n── slope, against the pathfinder\'s SLOPE_IMPASSABLE = 0.62 over 7 m ──');
console.log(`  worst on the ring quay belt   ${res.worstQuayGradient}  at ${JSON.stringify(res.worstQuayAt)}`);
console.log(`  worst on the landward approach ${res.worstApproachGradient} at ${JSON.stringify(res.worstApproachAt)}`);
console.log(`\n── harbour quarter, 4 m lattice: ${res.harbourQuarter.wetCells} wet / ${res.harbourQuarter.dryCells} dry`);
if (res.quayReach) {
  console.log(`\n── can a 35 m body walk from the city onto the ring quay? (terrain only, 3 m lattice)`);
  console.log(`  seeded at ${JSON.stringify(res.quayReach.seedFrom)}, ${res.quayReach.cellsReached} cells reached`);
  for (const b of res.quayReach.bands) {
    console.log(`  r=${b.r} m: ${b.reached}/${b.of} azimuths reached, ${b.standable}/${b.of} standable`
      + `  heights ${b.detail.map((d) => d.h).join(' ')}`);
  }
  for (const a of res.quayReach.areas) {
    console.log(`  band r ${a.r0}..${a.r1}: ${a.reachedHa} of ${a.ha} ha reachable from the city`);
  }
} else {
  console.log('\n  (no pathfinding subsystem exposed — quay reach not measured)');
}
if (errors.length) { console.log('\n── page errors ──'); for (const e of errors) console.log('  ' + e); }
else console.log('\nno pageerror, no console.error');

const SHOT_DIR = args.get('shots') ?? null;
if (SHOT_DIR) {
  const { mkdir } = await import('node:fs/promises');
  const dir = path.resolve(ROOT, SHOT_DIR);
  await mkdir(dir, { recursive: true });
  // Let the title card fade before anything is shot: it covers the middle of the frame.
  await page.waitForTimeout(9000);
  const shots = [
    { name: 'harbours-wide', x: -800, z: 1000, zoom: 0.98, yaw: Math.PI * 1.5 },
    { name: 'cothon-landward', x: -930, z: 830, zoom: 0.8, yaw: 0 },
    { name: 'mole-from-sea', x: -930, z: 1240, zoom: 0.7, yaw: Math.PI },
    { name: 'coast', x: -760, z: 1080, zoom: 1.0, yaw: Math.PI * 1.25 },
    // Close on the west ring-shed range from the island: does the shed sit on its ground, or
    // does it hover over a bed that has just been dug 5 m out from under it?
    { name: 'sheds-close', x: -1050, z: 1000, zoom: 0.16, yaw: Math.PI * 1.5 },
  ];
  for (const s of shots) {
    await page.evaluate((c) => window.__game.setCamera(c.x, c.z, c.zoom, c.yaw), s);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(dir, `${s.name}.png`) });
  }
  console.log(`\nwrote ${shots.length} frames to ${SHOT_DIR}`);
}

await browser.close();
if (server) server.kill();
