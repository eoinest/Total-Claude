#!/usr/bin/env node
/**
 * Numerical acceptance tests for Carthage's city fabric.
 *
 * `probe-nav.mjs` is Rome's instrument and it is welded to Rome in two places: it takes its
 * wall line from `getWallSegments()`, and Carthage has no masonry on its circuit yet; and it
 * seeds its flood fill outside the wall, which for a city with no wall measures nothing. So
 * this is the equivalent, reading the same ground truth through the same public surface —
 * `blocksMovement`, `getObstacles`, the pathfinder's nav grid — and reporting the same three
 * body widths so the two cities' numbers can be put side by side.
 *
 * **It reports both seedings, and that is the point.** Rome's published reachability
 * (16,845 / 6,858 / 3,466 cells) is measured from a start point *outside* the wall, so it
 * answers "can a besieger get in". Carthage's wall does not exist, so that number would be
 * inflated by an open circuit and would say nothing about the fabric. The figure that grades
 * *this* workstream is the inside-out one: seed at the principal gate's mouth, on the circuit
 * line, which is exactly where a stormed gate or a wall stair delivers a formation, and count
 * what it can reach. Both are printed.
 *
 * Measurements:
 *   reach       cells reachable at each of three body radii, seeded outside and at the gate
 *   corridor    free-space width distribution, and the fraction admitting each body
 *   intervallum depth of clear ground behind the circuit, and each stair apron
 *   solids      what the city published, by kind
 *   draws       draw calls, triangles and visible meshes at each of five cameras
 *   assertions  the build-time checks, with what each measured
 *
 * Usage:
 *   node tools/probe-carthage.mjs --port=5548
 *   node tools/probe-carthage.mjs --port=5548 --json=out.json --only=reach,draws
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const PORT = Number(args.get('port') ?? 5548);
const CITY = args.get('city') ?? 'carthage';
const QUALITY = args.get('quality') ?? 'low';
const JSON_OUT = args.get('json') ?? null;
const PLAN_OUT = args.get('plan') ?? null;
const SHOT_DIR = args.get('shots') ?? null;
const ONLY = args.has('only') ? new Set(String(args.get('only')).split(',')) : null;
const want = (k) => !ONLY || ONLY.has(k);
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

/**
 * A probe that silently graded a stale `dist/` reported 5/12 where the live tree scored
 * 12/12. So: the server is started here or it is confirmed here, and the first line of
 * output says which.
 */
let server = null;
let ownServer = false;
if (!(await waitForServer(base, 1500))) {
  ownServer = true;
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) {
    console.error('vite did not start on ' + base);
    process.exit(1);
  }
}
console.log(`[probe-carthage] ${base} — ${ownServer ? 'server started by this run' : 'server already up'}, root ${ROOT}`);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  if (m.type() === 'warning' && m.text().includes('[city]')) errors.push(`console.warn: ${m.text()}`);
});

const url = `${base}/?menu=0&city=${CITY}&quality=${QUALITY}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

/**
 * A typecheck is not proof of life and neither is a page that loads. Wait on
 * `window.__game.ready` explicitly and fail loudly, because without this an app that
 * white-screened at module init is indistinguishable from a slow boot and has cost this
 * project hours of unexplained timeouts.
 */
try {
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null,
    { timeout: 180000 });
} catch (e) {
  console.error('\n*** window.__game.ready never became true ***');
  for (const x of errors) console.error('   ' + x);
  await browser.close();
  if (server) server.kill();
  process.exit(1);
}
console.log(`[probe-carthage] booted: ${url}`);

// ---------------------------------------------------------------------------
// In-page measurement
// ---------------------------------------------------------------------------

await page.evaluate(`
window.__cart = (() => {
  const g = window.__game;
  const engine = g.engine;
  const ctx = engine.context;
  const city = ctx.tryGet('city');
  if (!city) throw new Error('no city subsystem — was the map built with hidesCity?');

  /** Rasterise the city's own occupancy through its public degenerate-segment query. */
  const CELL = 4;
  const HALF = 1400;
  const RES = Math.ceil((HALF * 2) / CELL);
  const grid = new Uint8Array(RES * RES);
  const toWorld = (i) => -HALF + (i + 0.5) * CELL;
  for (let j = 0; j < RES; j++) {
    const z = toWorld(j);
    for (let i = 0; i < RES; i++) {
      const x = toWorld(i);
      if (city.blocksMovement(x, z, x, z)) grid[j * RES + i] = 1;
    }
  }

  /** Chamfer distance transform: metres of clearance from each free cell to the nearest solid. */
  const clearance = new Float32Array(RES * RES).fill(1e6);
  for (let k = 0; k < grid.length; k++) if (grid[k]) clearance[k] = 0;
  const relax = (a, b, w) => { if (clearance[b] + w < clearance[a]) clearance[a] = clearance[b] + w; };
  const D1 = CELL, D2 = CELL * Math.SQRT2;
  for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
    const c = j * RES + i;
    if (i > 0) relax(c, c - 1, D1);
    if (j > 0) relax(c, c - RES, D1);
    if (i > 0 && j > 0) relax(c, c - RES - 1, D2);
    if (i < RES - 1 && j > 0) relax(c, c - RES + 1, D2);
  }
  for (let j = RES - 1; j >= 0; j--) for (let i = RES - 1; i >= 0; i--) {
    const c = j * RES + i;
    if (i < RES - 1) relax(c, c + 1, D1);
    if (j < RES - 1) relax(c, c + RES, D1);
    if (i < RES - 1 && j < RES - 1) relax(c, c + RES + 1, D2);
    if (i > 0 && j < RES - 1) relax(c, c + RES - 1, D2);
  }

  const circuit = city.getCircuitSamples ? city.getCircuitSamples(20) : [];
  const circuitZAt = (x) => {
    if (circuit.length === 0) return null;
    if (x <= circuit[0].x) return circuit[0].z;
    if (x >= circuit[circuit.length - 1].x) return circuit[circuit.length - 1].z;
    for (let i = 0; i + 1 < circuit.length; i++) {
      if (x >= circuit[i].x && x <= circuit[i + 1].x) {
        const t = (x - circuit[i].x) / (circuit[i + 1].x - circuit[i].x || 1);
        return circuit[i].z + (circuit[i + 1].z - circuit[i].z) * t;
      }
    }
    return null;
  };
  const cellAt = (x, z) => {
    const i = Math.max(0, Math.min(RES - 1, Math.floor((x + HALF) / CELL)));
    const j = Math.max(0, Math.min(RES - 1, Math.floor((z + HALF) / CELL)));
    return j * RES + i;
  };

  return {
    /**
     * Flood fill over the cells a body of the given radius can occupy.
     *
     * The same admission rule the pathfinder uses — not blocked, and clearance at least the
     * body radius — over the city's own occupancy rather than over the nav grid, so the
     * answer does not depend on when the AI last rebuilt.
     */
    reach(radius, sx, sz) {
      const seen = new Uint8Array(RES * RES);
      const q = new Int32Array(RES * RES);
      let head = 0, tail = 0;
      const start = cellAt(sx, sz);
      if (grid[start] || clearance[start] < radius) {
        return { ok: false, why: 'seed cell admits no body of radius ' + radius,
                 seedClearance: +clearance[start].toFixed(1) };
      }
      q[tail++] = start; seen[start] = 1;
      let reached = 0, inside = 0, deepest = 0, deepestAt = null;
      const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
      while (head < tail) {
        const c = q[head++];
        reached++;
        const ci = c % RES, cj = (c - ci) / RES;
        const wx = toWorld(ci), wz = toWorld(cj);
        const cz = circuitZAt(wx);
        if (cz !== null && wz > cz + 20) {
          inside++;
          if (wz > deepest) { deepest = wz; deepestAt = [Math.round(wx), Math.round(wz)]; }
        }
        for (let k = 0; k < 4; k++) {
          const ni = ci + DX[k], nj = cj + DZ[k];
          if (ni < 0 || nj < 0 || ni >= RES || nj >= RES) continue;
          const n = nj * RES + ni;
          if (seen[n] || grid[n] || clearance[n] < radius) continue;
          seen[n] = 1; q[tail++] = n;
        }
      }
      // Hectares as well as cells. Rome's published 16,845 / 6,858 / 3,466 are counted on
      // the pathfinder's 7 m nav grid and these are on a 4 m raster of the city's own
      // occupancy, so the cell counts are not comparable and the areas are.
      const HA = (CELL * CELL) / 1e4;
      return {
        ok: true, radius, from: [Math.round(sx), Math.round(sz)],
        cellsReached: reached, cellsInsideCircuit: inside,
        hectaresReached: +(reached * HA).toFixed(1),
        hectaresInsideCircuit: +(inside * HA).toFixed(1),
        deepestReached: deepest ? Math.round(deepest) : 0, deepestAt,
      };
    },

    /** Free-space width over the built area, and the fraction admitting each body. */
    corridor() {
      const widths = [];
      let f24 = 0, f16 = 0, f35 = 0, total = 0;
      for (let j = 0; j < RES; j++) {
        const z = toWorld(j);
        if (z < 380 || z > 1400) continue;
        for (let i = 0; i < RES; i++) {
          const x = toWorld(i);
          if (x < -960 || x > 960) continue;
          const c = j * RES + i;
          if (grid[c]) continue;
          const w = clearance[c] * 2;
          total++;
          widths.push(w);
          if (w >= 2.4) f24++;
          if (w >= 16) f16++;
          if (w >= 35) f35++;
        }
      }
      widths.sort((a, b) => a - b);
      const pct = (q) => (widths.length ? +widths[Math.floor(q * (widths.length - 1))].toFixed(1) : 0);
      return {
        freeCellsSampled: total,
        corridorWidth: { p05: pct(0.05), p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p95: pct(0.95) },
        fractionAdmitting: {
          file2p4m: total ? +(f24 / total).toFixed(3) : 0,
          column16m: total ? +(f16 / total).toFixed(3) : 0,
          cohortInLine35m: total ? +(f35 / total).toFixed(3) : 0,
        },
      };
    },

    /** Depth of clear ground behind the circuit, over the circuit's real span only. */
    intervallum() {
      const depths = [];
      let worst = { depth: 1e9, x: 0 };
      for (const s of circuit) {
        let d = null;
        for (let z = s.z + 2; z < s.z + 400; z += CELL) {
          if (grid[cellAt(s.x, z)]) { d = z - s.z; break; }
        }
        if (d === null) d = 400;
        depths.push(d);
        if (d < worst.depth) worst = { depth: d, x: s.x };
      }
      depths.sort((a, b) => a - b);
      const q = (t) => (depths.length ? +depths[Math.floor(t * (depths.length - 1))].toFixed(1) : 0);
      return {
        xFrom: circuit.length ? circuit[0].x : null,
        xTo: circuit.length ? circuit[circuit.length - 1].x : null,
        samples: depths.length,
        min: q(0), p10: q(0.1), median: q(0.5), p90: q(0.9), max: q(1),
        worstAt: worst.x,
      };
    },

    /**
     * Can a 35 m cohort stand at the foot of a stair?
     *
     * The question wall traversal made load-bearing. For each apron, the widest free body
     * that fits anywhere in it and the fraction of it that is open ground.
     */
    aprons(xs, halfRun, depth) {
      return xs.map((ax) => {
        const cz = circuitZAt(ax);
        if (cz === null) return { x: ax, ok: false, why: 'off the circuit' };
        let open = 0, tested = 0, best = 0;
        for (let dx = -halfRun; dx <= halfRun; dx += 4) {
          for (let dz = 4; dz <= depth; dz += 4) {
            const c = cellAt(ax + dx, cz + dz);
            tested++;
            if (!grid[c]) { open++; best = Math.max(best, clearance[c] * 2); }
          }
        }
        return { x: ax, ok: true, openFraction: +(open / tested).toFixed(3), widestBody: +best.toFixed(1) };
      });
    },

    /**
     * Everything needed to draw a plan, read off the **built** city.
     *
     * Not off the layout constants. src/city/plan.ts draws Rome's *intent* — it imports
     * LANDMARKS and re-runs buildDistricts — so it cannot show a discrepancy between the
     * plan and what was baked, which is the one thing a plan view is for. This reads
     * getObstacles(), getLanes() and getCircuitSamples(), so what is drawn is what a
     * cohort will actually walk into.
     */
    planData() {
      return {
        obstacles: city.getObstacles().map((o) => ({
          x: +o.x.toFixed(1), z: +o.z.toFixed(1), hw: +o.hw.toFixed(1), hd: +o.hd.toFixed(1),
          rot: +o.rot.toFixed(4), kind: o.kind,
        })),
        lanes: city.getLanes().map((l) => ({ w: l.width, cls: l.cls, p: l.path.map((q) => [Math.round(q.x), Math.round(q.z)]) })),
        circuit,
        landmarks: city.getLandmarks(),
      };
    },

    solids() {
      const obs = city.getObstacles();
      const by = {};
      for (const o of obs) by[o.kind] = (by[o.kind] || 0) + 1;
      let blocked = 0;
      for (let k = 0; k < grid.length; k++) if (grid[k]) blocked++;
      return {
        obstacles: obs.length, byKind: by,
        occupiedCells: blocked,
        occupiedHectares: +((blocked * CELL * CELL) / 1e4).toFixed(1),
        stats: city.stats(),
      };
    },

    /**
     * Draw calls per camera, **as an interleaved A/B with the city hidden**.
     *
     * The whole-frame cap is 220 and the live assault camera already measures 259 with
     * Rome's city and wall in it, so a bare whole-frame figure from this workstream says
     * nothing about what this workstream costs. Both arms are shot at the same camera in
     * the same session, city off last at each camera as the drift check, and the difference
     * is what Carthage's fabric is actually spending. Cross-session comparison is not a
     * measurement on this project — dust and particle VFX reseed per session — so the two
     * arms have to be in one run.
     */
    async draws(shots) {
      const out = [];
      const r = ctx.renderer;
      const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
      const measure = async () => {
        await frame();
        await frame();
        r.info.reset();
        await frame();
        return { calls: r.info.render.calls, triangles: r.info.render.triangles };
      };
      for (const s of shots) {
        g.setCamera(s.x, s.z, s.zoom, s.yaw);
        city.setDebugVisible(true);
        const on = await measure();
        city.setDebugVisible(false);
        const off = await measure();
        city.setDebugVisible(true);
        out.push({
          name: s.name,
          calls: on.calls,
          triangles: on.triangles,
          callsWithoutCity: off.calls,
          cityCalls: on.calls - off.calls,
          cityTriangles: on.triangles - off.triangles,
          programs: r.info.programs ? r.info.programs.length : 0,
        });
      }
      return out;
    },
  };
})();
`);

const out = { url, city: CITY, when: new Date().toISOString() };

if (want('solids')) {
  out.solids = await page.evaluate(() => window.__cart.solids());
  const s = out.solids;
  console.log(`\n── what the city published ────────────────────────────`);
  console.log(`  city                      ${s.stats.cityId}`);
  console.log(`  obstacles                 ${s.obstacles}  ${JSON.stringify(s.byKind)}`);
  console.log(`  occupancy grid            ${s.occupiedCells} cells solid = ${s.occupiedHectares} ha`);
  console.log(`  chunks / meshes / tris    ${s.stats.chunks} / ${s.stats.meshes} / ${s.stats.triangles.toLocaleString()}`);
  console.log(`  visible meshes / tris     ${s.stats.visibleMeshes} / ${s.stats.visibleTriangles.toLocaleString()}`);
  console.log(`  stray geometry            ${s.stats.strayGeometry}`);
  console.log(`  street network            ` + s.stats.ways.map((w) => `${w.cls} ${w.count} (${w.km} km)`).join(', '));
}

if (want('assertions')) {
  out.assertions = await page.evaluate(() => window.__cart.solids().stats.assertions);
  console.log(`\n── build-time checks ──────────────────────────────────`);
  for (const a of out.assertions) {
    console.log(`  [${a.ok ? ' ok ' : 'FAIL'}] ${a.name}`);
    console.log(`         ${a.detail.replace(/\*\*/g, '')}`);
  }
}

if (want('intervallum')) {
  out.intervallum = await page.evaluate(() => window.__cart.intervallum());
  const i = out.intervallum;
  console.log(`\n── open ground behind the circuit ─────────────────────`);
  console.log(`  span x ${i.xFrom}..${i.xTo}, ${i.samples} samples`);
  console.log(`  depth to first solid: min ${i.min} m (x=${i.worstAt}), p10 ${i.p10}, median ${i.median}, p90 ${i.p90}, max ${i.max}`);

  out.aprons = await page.evaluate(() =>
    window.__cart.aprons([-830, -475, -120, 235, 590, 945], 60, 70));
  console.log(`  stair-foot aprons (120 × 70 m each):`);
  for (const a of out.aprons) {
    console.log(`    x=${String(a.x).padStart(5)}  open ${(a.openFraction * 100).toFixed(0)}%  widest free body ${a.widestBody} m`);
  }
}

if (want('corridor')) {
  out.corridor = await page.evaluate(() => window.__cart.corridor());
  const c = out.corridor;
  console.log(`\n── free-space width inside the city ───────────────────`);
  console.log(`  ${c.freeCellsSampled.toLocaleString()} free cells sampled`);
  console.log(`  corridor width  p05 ${c.corridorWidth.p05}  p25 ${c.corridorWidth.p25}  median ${c.corridorWidth.median}  p75 ${c.corridorWidth.p75}  p95 ${c.corridorWidth.p95} m`);
  console.log(`  admits a 2.4 m file      ${(c.fractionAdmitting.file2p4m * 100).toFixed(1)}%`);
  console.log(`  admits a 16 m column     ${(c.fractionAdmitting.column16m * 100).toFixed(1)}%`);
  console.log(`  admits a 35 m cohort     ${(c.fractionAdmitting.cohortInLine35m * 100).toFixed(1)}%`);
}

if (want('reach')) {
  console.log(`\n── reachability ───────────────────────────────────────`);
  out.reach = { fromField: [], fromGate: [] };
  // Seeded on the besiegers' side, comparable with Rome's published figures.
  for (const r of [2.2, 8, 17.5]) {
    const v = await page.evaluate(([rr]) => window.__cart.reach(rr, 0, 300), [r]);
    out.reach.fromField.push(v);
    if (!v.ok) { console.log(`  field  radius ${r}: ${v.why}`); continue; }
    console.log(`  field seed  r=${String(r).padStart(4)} m (body ${(r * 2).toFixed(1)} m): reached ${String(v.cellsReached).padStart(7)} cells`
      + `  inside the circuit ${String(v.cellsInsideCircuit).padStart(6)} = ${String(v.hectaresInsideCircuit).padStart(6)} ha  deepest z=${v.deepestReached}`);
  }
  // Seeded at the principal gate's mouth: where a stormed gate or a wall stair puts a
  // formation down, and the figure that grades the fabric rather than the wall.
  for (const r of [2.2, 8, 17.5]) {
    const v = await page.evaluate(([rr]) => window.__cart.reach(rr, 30, 495), [r]);
    out.reach.fromGate.push(v);
    if (!v.ok) { console.log(`  gate   radius ${r}: ${v.why} (clearance ${v.seedClearance} m)`); continue; }
    console.log(`  gate seed   r=${String(r).padStart(4)} m (body ${(r * 2).toFixed(1)} m): reached ${String(v.cellsReached).padStart(7)} cells`
      + `  inside the circuit ${String(v.cellsInsideCircuit).padStart(6)} = ${String(v.hectaresInsideCircuit).padStart(6)} ha  deepest z=${v.deepestReached}`);
  }
}

if (want('draws')) {
  const shots = [
    { name: 'assault',  x: 30,   z: 180,  zoom: 0.55, yaw: 0 },
    { name: 'wall',     x: 30,   z: 350,  zoom: 0.30, yaw: 0 },
    { name: 'byrsa',    x: -90,  z: 1180, zoom: 0.45, yaw: Math.PI },
    { name: 'harbour',  x: 400,  z: 1180, zoom: 0.50, yaw: Math.PI * 0.5 },
    { name: 'overview', x: 0,    z: 700,  zoom: 1.0,  yaw: 0 },
  ];
  out.draws = await page.evaluate((s) => window.__cart.draws(s), shots);
  console.log(`\n── draw calls per camera (cap 220 whole frame) ────────`);
  for (const d of out.draws) {
    console.log(`  ${d.name.padEnd(9)} whole frame ${String(d.calls).padStart(4)}   city off ${String(d.callsWithoutCity).padStart(4)}`
      + `   → CITY COSTS ${String(d.cityCalls).padStart(3)} calls, ${(d.cityTriangles / 1e6).toFixed(2)} M tris`);
  }
}

if (SHOT_DIR) {
  const dir = path.resolve(ROOT, SHOT_DIR);
  await mkdir(dir, { recursive: true });
  const shots = [
    { name: 'assault',  x: 0,    z: 150,  zoom: 0.75, yaw: 0 },
    { name: 'gate',     x: 0,    z: 420,  zoom: 0.35, yaw: 0 },
    { name: 'byrsa',    x: -240, z: 1080, zoom: 0.4,  yaw: Math.PI * 0.82 },
    { name: 'streets',  x: -140, z: 1010, zoom: 0.18, yaw: Math.PI * 0.5 },
    { name: 'cothon',   x: -930, z: 1180, zoom: 0.5,  yaw: Math.PI },
    { name: 'megara',   x: 620,  z: 620,  zoom: 0.3,  yaw: Math.PI * 0.25 },
  ];
  for (const s of shots) {
    await page.evaluate((c) => window.__game.setCamera(c.x, c.z, c.zoom, c.yaw), s);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: path.join(dir, `${s.name}.png`) });
  }
  console.log(`\nwrote ${shots.length} frames to ${SHOT_DIR}`);
}

if (PLAN_OUT) {
  // Render the plan we just wrote, so a reviewer gets a picture and not only a file.
  const svg = await (await import('node:fs/promises')).readFile(path.resolve(ROOT, PLAN_OUT), 'utf8');
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.setViewportSize({ width: 1800, height: 656 });
  await page.screenshot({ path: path.resolve(ROOT, PLAN_OUT).replace(/\.svg$/, '.png'), fullPage: true });
  console.log(`wrote plan png`);
}

if (errors.length) {
  console.log(`\n── page errors and city warnings ──────────────────────`);
  for (const e of errors) console.log('  ' + e);
}
out.errors = errors;

if (PLAN_OUT) {
  const pd = await page.evaluate(() => window.__cart.planData());
  const X0 = -1400, X1 = 1400, Z0 = 380, Z1 = 1400;
  const W = 1800;
  const H = Math.round((W * (Z1 - Z0)) / (X1 - X0));
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${X0} ${Z0} ${X1 - X0} ${Z1 - Z0}" style="background:#efe7d6">`);
  parts.push(`<g transform="translate(0,${Z0 + Z1}) scale(1,-1)">`);
  // Streets under everything, by rank.
  const rankW = { artery: 1.0, secondary: 1.0, local: 1.0, vicus: 1.0 };
  for (const l of pd.lanes) {
    const d = l.p.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="#cbbfa4" stroke-width="${l.w * (rankW[l.cls] ?? 1)}" stroke-linecap="round"/>`);
  }
  // Solids, coloured by kind.
  for (const o of pd.obstacles) {
    const fill = o.kind === 'monument' ? '#8d6a4f' : o.kind === 'wall' ? '#5b4636' : '#a58a6b';
    parts.push(`<g transform="translate(${o.x},${o.z}) rotate(${(-o.rot * 180) / Math.PI})">`
      + `<rect x="${-o.hw}" y="${-o.hd}" width="${o.hw * 2}" height="${o.hd * 2}" fill="${fill}" stroke="#5b4636" stroke-width="0.6"/></g>`);
  }
  // The circuit line the walls workstream builds to.
  if (pd.circuit.length) {
    const d = pd.circuit.map((q, i) => `${i ? 'L' : 'M'}${q.x} ${q.z}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="#8c2f2f" stroke-width="9" stroke-dasharray="26 14"/>`);
  }
  parts.push('</g>');
  // Labels, in screen space so the text is not mirrored.
  for (const m of pd.landmarks) {
    const sy = Z0 + Z1 - m.z;
    parts.push(`<circle cx="${m.x}" cy="${sy}" r="4" fill="#8c2f2f"/>`
      + `<text x="${m.x + 8}" y="${sy + 4}" font-family="ui-monospace,monospace" font-size="17" fill="#2a2318">${esc(m.name)}</text>`);
  }
  parts.push(`<text x="${X0 + 20}" y="${Z0 + 34}" font-family="ui-monospace,monospace" font-size="22" fill="#2a2318">Carthage, spring 146 BC — plan from the built city (${pd.obstacles.length} solids, ${pd.lanes.length} ways)</text>`);
  parts.push(`<text x="${X0 + 20}" y="${Z0 + 58}" font-family="ui-monospace,monospace" font-size="15" fill="#5b4636">dashed red: the circuit datum the walls workstream builds to. −Z is the isthmus and the assault; +Z is the sea.</text>`);
  parts.push('</svg>');
  const outPath = path.resolve(ROOT, PLAN_OUT);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, parts.join('\n'));
  console.log(`\nwrote plan ${PLAN_OUT}`);
}

if (JSON_OUT) {
  await mkdir(path.dirname(path.resolve(ROOT, JSON_OUT)), { recursive: true });
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

await browser.close();
if (server) server.kill();
