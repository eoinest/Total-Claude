#!/usr/bin/env node
/**
 * Numerical acceptance tests for Carthage's city fabric.
 *
 * `probe-nav.mjs` is Rome's instrument and it is welded to Rome: it hard-codes the Campus
 * Martius' geography into its seeds, its spans and its thresholds — including the
 * `openGroundBehindWall min 40` that §7.5 makes 35 here. So this is the equivalent, reading
 * the same ground truth through the same public surface — `blocksMovement`, `getObstacles`,
 * the pathfinder's nav grid — and reporting the same three body widths so the two cities'
 * numbers can be put side by side.
 *
 * **It draws its plan from the built city, not from the layout constants**, which is the one
 * thing `src/city/plan.ts` cannot do: that renders Rome's *intent* by re-importing `LANDMARKS`
 * and re-running `buildDistricts`, so a divergence between the plan and what was baked is
 * invisible to it by construction. `--plan=out.svg` here is `getObstacles()`,
 * `getLanes()` and `getCircuitSamples()`, and it found four faults nothing else did.
 *
 * **It reports both seedings, and that is the point.** Rome's published reachability
 * (16,845 / 6,858 / 3,466 cells) is measured from a start point *outside* the wall, so it
 * answers "can a besieger get in". The figure that grades *this* workstream is the
 * inside-out one: seed at the principal gate's inner mouth, which is exactly where a stormed
 * gate or a wall stair delivers a formation, and count what it can reach. Both are printed.
 *
 * **Hectares, not cells.** Rome's published cell counts are on a 7 m grid and this raster is
 * 4 m, so the two are not comparable as counts and quoting them side by side would be an
 * error of a factor of three. Area is comparable and area is what is printed.
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
/**
 * The **map**, not the city.
 *
 * This probe was written against a `?city=carthage` override, from when the fabric had to be
 * buildable before its map existed. `MapDefinition.city` retired that: a city is something a
 * map carries, there is no second selector, and naming one here would reinstate exactly the
 * "which city is this really" test `cityPlan.ts` forbids. So the map is chosen the way every
 * other probe chooses it — a `?battle=` token — and the city comes with it. `stats().id` is
 * then read back and printed, so a run that graded the wrong city says so.
 */
const MAP = args.get('map') ?? 'carthage';
const SCENARIO = args.get('scenario') ?? 'field';
const QUALITY = args.get('quality') ?? 'low';
const JSON_OUT = args.get('json') ?? null;
const PLAN_OUT = args.get('plan') ?? null;
/**
 * `--plates=DIR` — the layered plan a human can approve a city from.
 *
 * `--plan` is the engineer's plot: everything at once, one colour, no ground. It is what
 * found four faults and it stays exactly as it is. This is the other job. Four plates, each
 * adding one layer to the last — ground, then the named armature, then the generated mesh,
 * then the fabric — over real terrain read out of `TerrainSystem.heightAt`, because a plan
 * with no water and no relief cannot be compared against anything.
 */
const PLATES_OUT = args.get('plates') ?? null;
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

/**
 * `--use-angle=metal` is not optional on this platform, and its absence is not a slow run but
 * an indistinguishable one: without it ANGLE falls through to SwiftShader, the page renders on
 * the CPU, and a probe that should take under a minute runs for tens of minutes and looks
 * exactly like a hang. An agent lost an hour to that. `tools/shoot.mjs` already carries the
 * flag and this file did not; the two are now the same launch.
 */
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  if (m.type() === 'warning' && m.text().includes('[city]')) errors.push(`console.warn: ${m.text()}`);
});

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
const url = `${base}/?menu=0&quality=${QUALITY}&scenario=${SCENARIO}&battle=${token}`;
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
  if (!city) throw new Error('no city subsystem — does this map carry a CityPlan?');

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
      let reached = 0, inside = 0, walled = 0, deepest = 0, deepestAt = null;
      const xMin = circuit.length ? circuit[0].x : -1400;
      const xMax = circuit.length ? circuit[circuit.length - 1].x : 1400;
      const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
      while (head < tail) {
        const c = q[head++];
        reached++;
        const ci = c % RES, cj = (c - ci) / RES;
        const wx = toWorld(ci), wz = toWorld(cj);
        const cz = circuitZAt(wx);
        if (cz !== null && wz > cz + 20) {
          inside++;
          /**
           * ...and again, restricted to the wall's own x-span.
           *
           * circuitZAt clamps past the anchors, so "z beyond the circuit" is true of the
           * sebkha north of x +1013 and the lake south of x -968 as well as of the city.
           * Counting those put the inside figure at 170 ha against a walled area of 136 —
           * a number that cannot be true given its neighbour. The city publishes no solid
           * out there because there is no city out there; what stops a man on that ground
           * is the terrain, which this raster cannot see. Both are reported: inside is what
           * the earlier revision measured, walled is the city.
           */
          if (wx >= xMin && wx <= xMax) walled++;
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
        cellsReached: reached, cellsInsideCircuit: inside, cellsWalled: walled,
        hectaresReached: +(reached * HA).toFixed(1),
        hectaresInsideCircuit: +(inside * HA).toFixed(1),
        hectaresWalled: +(walled * HA).toFixed(1),
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

    /**
     * Depth of clear ground behind the circuit, over the circuit's real span only.
     *
     * **Measured from the back of the masonry, not from the centreline**, and that is not a
     * refinement — it is the difference between 41 m and 2 m. This arm was written while the
     * circuit carried no stone, so scanning outward from z0 + 2 found open ground
     * immediately. With the wall built, z0 + 2 is *inside* the curtain and every sample
     * reported 2 m: a number that cannot be true given its neighbour, which on this project
     * is the best bug detector there is.
     *
     * So the leading run of solid cells is skipped first. A stair block projecting cityward
     * off the inner face counts as masonry and is skipped with it, which is right: the
     * intervallum is the ground a relief column uses, and a stair is not it. Section 7.5 wants
     * 35 m, against Rome's 60 — the lateral corridor is inside this wall, not behind it.
     */
    intervallum() {
      const depths = [];
      let worst = { depth: 1e9, x: 0 };
      for (const s of circuit) {
        // Walk cityward off the centreline until the masonry ends.
        let back = 0;
        while (back < 120 && grid[cellAt(s.x, s.z + back)]) back += CELL;
        let d = null;
        for (let z = s.z + back + CELL; z < s.z + back + 400; z += CELL) {
          if (grid[cellAt(s.x, z)]) { d = z - (s.z + back); break; }
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
        // Offset past the curtain for the same reason intervallum does: an apron measured
        // from the centreline is measuring the wall for its first ten metres.
        let back = 0;
        while (back < 120 && grid[cellAt(ax, cz + back)]) back += 4;
        for (let dx = -halfRun; dx <= halfRun; dx += 4) {
          for (let dz = 4; dz <= depth; dz += 4) {
            const c = cellAt(ax + dx, cz + back + dz);
            tested++;
            if (!grid[c]) { open++; best = Math.max(best, clearance[c] * 2); }
          }
        }
        return { x: ax, ok: true, openFraction: +(open / tested).toFixed(3), widestBody: +best.toFixed(1) };
      });
    },

    /**
     * Where the two flood fills start, derived from the built circuit rather than typed in.
     *
     * The gate seed was a literal (30, 495) while the circuit had no masonry on it. Now it
     * has: 495 is *outside* the wall at x 0, so the inside-out arm would have measured the
     * besieger's approach twice and called the second one the fabric. Both seeds are taken
     * off getCircuitSamples() and both are printed, because a seed in the wrong place is
     * the kind of error that produces a plausible number.
     */
    seeds() {
      const zGate = circuitZAt(0);
      return {
        field: { x: 0, z: Math.round((zGate === null ? 527 : zGate) - 230) },
        gate: { x: 0, z: Math.round((zGate === null ? 527 : zGate) + 26) },
      };
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

const out = { url, map: MAP, scenario: SCENARIO, when: new Date().toISOString() };

if (want('solids')) {
  out.solids = await page.evaluate(() => window.__cart.solids());
  const s = out.solids;
  console.log(`\n── what the city published ────────────────────────────`);
  console.log(`  city                      ${s.stats.id}  (map ${MAP}, ${SCENARIO})`);
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
  const seeds = await page.evaluate(() => window.__cart.seeds());
  console.log(`  seeds: field (${seeds.field.x}, ${seeds.field.z})  gate (${seeds.gate.x}, ${seeds.gate.z})`);
  out.seeds = seeds;
  for (const r of [2.2, 8, 17.5]) {
    const v = await page.evaluate(([rr, s]) => window.__cart.reach(rr, s.x, s.z), [r, seeds.field]);
    out.reach.fromField.push(v);
    if (!v.ok) { console.log(`  field  radius ${r}: ${v.why}`); continue; }
    console.log(`  field seed  r=${String(r).padStart(4)} m (body ${(r * 2).toFixed(1)} m): reached ${String(v.cellsReached).padStart(7)} cells`
      + `  walled ground ${String(v.hectaresWalled).padStart(6)} ha  (with the ground past the wall's ends: ${v.hectaresInsideCircuit} ha)  deepest z=${v.deepestReached}`);
  }
  // Seeded at the principal gate's mouth: where a stormed gate or a wall stair puts a
  // formation down, and the figure that grades the fabric rather than the wall.
  for (const r of [2.2, 8, 17.5]) {
    const v = await page.evaluate(([rr, s]) => window.__cart.reach(rr, s.x, s.z), [r, seeds.gate]);
    out.reach.fromGate.push(v);
    if (!v.ok) { console.log(`  gate   radius ${r}: ${v.why} (clearance ${v.seedClearance} m)`); continue; }
    console.log(`  gate seed   r=${String(r).padStart(4)} m (body ${(r * 2).toFixed(1)} m): reached ${String(v.cellsReached).padStart(7)} cells`
      + `  walled ground ${String(v.hectaresWalled).padStart(6)} ha  (with the ground past the wall's ends: ${v.hectaresInsideCircuit} ha)  deepest z=${v.deepestReached}`);
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

if (errors.length) {
  console.log(`\n── page errors and city warnings ──────────────────────`);
  for (const e of errors) console.log('  ' + e);
}
out.errors = errors;


// ---8<--- PLATES BEGIN
// Everything between the markers is pure: plain data in, SVG strings out, no imports, no
// closure over anything above. That is deliberate — it can be lifted out and run against a
// cached payload while the drawing is being tuned, without booting a browser or a city.

/** The page. World extent is the terrain's own ±1400 in x and the city's z-range plus glacis. */
const PLATE_PAGE = {
  x0: -1400, x1: 1400, z0: 200, z1: 1400,
  width: 2200, margin: 78, mapTop: 130, legendH: 196, sectionH: 232,
};

const plateLayout = (P) => {
  const mapW = P.width - P.margin * 2;
  const sc = mapW / (P.x1 - P.x0);
  const mapH = Math.round((P.z1 - P.z0) * sc);
  const mapY1 = P.mapTop + mapH;
  const sectionY = mapY1 + 44;
  const legendY = sectionY + P.sectionH + 44;
  return {
    ...P, sc, mapW, mapH,
    mapX: P.margin, mapY: P.mapTop, mapX1: P.margin + mapW, mapY1,
    sectionY,
    legendY,
    height: legendY + P.legendH,
  };
};

/** Ink. A warm, printed-plan palette; every value is used in the legend as well as the map. */
const PC = {
  paper: '#f7f1e2', ink: '#2b2419', inkSoft: '#6d5d46', rule: '#b8a888',
  wall: '#3a2f25', wallLt: '#7a674f',
  civic: '#8c5f3b', civicEdge: '#5a3a22',
  pave: '#e0d2b2', paveEdge: '#a99372',
  water: '#7ba4bb', waterEdge: '#3f6a82',
  citadel: '#7b4a30',
  house: '#c0a07d', houseEdge: '#7a6247',
  megara: '#9aab72',
  artery: '#a02a1c', secondary: '#cf7b28', local: '#3f7d66',
  stepped: '#2f6494', vicus: '#6e5c44',
  mark: '#8c2f2f',
};

/** True world width, metres, per rank. These are the spec's and they are drawn to scale. */
const RANK_W = { artery: 20, secondary: 12, local: 7, stepped: 6, vicus: 4 };
const RANK_COL = {
  artery: PC.artery, secondary: PC.secondary, local: PC.local,
  stepped: PC.stepped, vicus: PC.vicus,
};

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f2 = (n) => (Math.round(n * 100) / 100).toString();
/** Monospace advance width. Used for label collision, so it must not be optimistic. */
const textW = (s, size) => s.length * size * 0.6;

/**
 * Labels that do not collide, with anything.
 *
 * Side is chosen by whether the text fits to the right of its anchor. Then every label is
 * swept top to bottom against a single occupancy list that is *seeded* with the things this
 * pass does not own — the way ids set on the carriageways, the italic terrain names, the spot
 * heights, the compass card and the scale bar — and pushed down until its box is clear.
 * Testing both axes matters: the earlier revision pushed on y alone, so a label at x 400
 * was displaced by one at x 1900 that it could never have touched, and monument names walked
 * a hundred pixels off their own monuments to avoid nothing.
 */
function placeLabels(items, box, size, reserved = []) {
  const cols = { R: [], L: [] };
  for (const it of items) {
    const w = textW(it.text, it.size ?? size);
    const side = it.side ?? (it.ax + 13 + w < box.x1 - 8 ? 'R' : 'L');
    cols[side].push({ ...it, w, side, size: it.size ?? size });
  }
  const taken = reserved.map((r) => ({ ...r }));
  const out = [];
  for (const side of ['R', 'L']) {
    for (const it of cols[side].sort((a, b) => a.ay - b.ay)) {
      const lx = side === 'R' ? it.ax + 13 : it.ax - 13;
      const x0 = (side === 'R' ? lx : lx - it.w) - 2;
      const x1 = x0 + it.w + 4;
      let y = it.ay;
      for (let guard = 0; guard < 240; guard++) {
        let hit = null;
        for (const p of taken) {
          if (x1 < p.x0 || x0 > p.x1 || y - it.size > p.y1 || y + 4 < p.y0) continue;
          hit = p;
          break;
        }
        if (!hit) break;
        y = hit.y1 + it.size + 2;
      }
      y = Math.min(box.y1 - 6, Math.max(box.y0 + it.size, y));
      taken.push({ x0, y0: y - it.size, x1, y1: y + 4 });
      out.push({ ...it, lx, ly: y, h: it.size + 6 });
    }
  }
  return out;
}

function drawLabels(placed) {
  const p = [];
  for (const it of placed) {
    const tip = it.side === 'R' ? it.lx - 4 : it.lx + 4;
    if (Math.hypot(tip - it.ax, it.ly - 4 - it.ay) > 9) {
      p.push(`<path d="M${f2(it.ax)} ${f2(it.ay)} L${f2(tip)} ${f2(it.ly - 4)}" `
        + `fill="none" stroke="${PC.mark}" stroke-width="1" opacity="0.75"/>`);
    }
    p.push(`<circle cx="${f2(it.ax)}" cy="${f2(it.ay)}" r="2.8" fill="${PC.mark}" `
      + `stroke="${PC.paper}" stroke-width="1"/>`);
    p.push(`<text x="${f2(it.lx)}" y="${f2(it.ly)}" text-anchor="${it.side === 'R' ? 'start' : 'end'}"`
      + ` font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="${it.size}"`
      + ` font-weight="${it.bold ? 700 : 500}" fill="${it.fill ?? PC.ink}"`
      + ` stroke="${PC.paper}" stroke-width="3.4" paint-order="stroke"`
      + ` stroke-linejoin="round">${esc(it.text)}</text>`);
  }
  return p.join('\n');
}

/** Build all four plates. `pd` is the payload gathered in-page; see `platePayload`. */
function buildPlates(pd) {
  const L = plateLayout(PLATE_PAGE);
  const S = (x) => L.mapX + (x - L.x0) * L.sc;
  const T = (z) => L.mapY1 - (z - L.z0) * L.sc;
  const M = (m) => m * L.sc;

  // ---- shared geometry ------------------------------------------------------
  /** An oriented world rectangle as a screen polygon. Matches `--plan`'s hand exactly. */
  const rectPts = (o) => {
    const c = Math.cos(o.rot), s = Math.sin(o.rot);
    const pts = [];
    for (const [u, v] of [[-o.hw, -o.hd], [o.hw, -o.hd], [o.hw, o.hd], [-o.hw, o.hd]]) {
      pts.push(`${f2(S(o.x + u * c - v * s))},${f2(T(o.z + u * s + v * c))}`);
    }
    return pts.join(' ');
  };
  const poly = (o, fill, stroke, sw) =>
    `<polygon points="${rectPts(o)}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw ?? 0.6}"` : ''}/>`;
  const pathD = (pts) => pts.map((q, i) => `${i ? 'L' : 'M'}${f2(S(q[0] ?? q.x))} ${f2(T(q[1] ?? q.z))}`).join(' ');
  const segPath = (segs) => segs.map((s) =>
    `M${f2(S(s[0]))} ${f2(T(s[1]))}L${f2(S(s[2]))} ${f2(T(s[3]))}`).join('');

  const frame = [];
  frame.push(`<rect x="${L.mapX}" y="${L.mapY}" width="${L.mapW}" height="${L.mapH}" `
    + `fill="none" stroke="${PC.ink}" stroke-width="1.6"/>`);

  // ---- ground: the raster, its contours and its coastline -------------------
  const ground = [];
  ground.push(`<image x="${L.mapX}" y="${L.mapY}" width="${L.mapW}" height="${L.mapH}" `
    + `href="${pd.raster}" preserveAspectRatio="none"/>`);
  for (const c of pd.contours) {
    const major = c.level % 20 === 0;
    ground.push(`<path d="${segPath(c.segs)}" fill="none" stroke="#6a4a24" `
      + `stroke-width="${major ? 1.35 : 0.7}" opacity="${major ? 0.72 : 0.42}"/>`);
  }
  ground.push(`<path d="${segPath(pd.coast)}" fill="none" stroke="${PC.waterEdge}" `
    + `stroke-width="1.7" opacity="0.85"/>`);

  // ---- what the city actually published as large civic solids ---------------
  // Every `kind: 'monument'` box out of `getObstacles()` — the moles, the island core, the
  // cothon's 28 water chords, the citadel platform, the basins. Drawn first and plainly, so
  // that the authored shapes above it are labelling something that is really there.
  const builtSolids = [];
  for (const o of pd.obstacles) {
    if (o.kind !== 'monument') continue;
    builtSolids.push(poly(o, '#9b7752', '#5a3a22', 0.5));
  }

  // ---- the harbours ---------------------------------------------------------
  // Drawn from the same constants `harbour.ts` builds from: the basins are water, but they
  // are quay-level obstacles rather than terrain below the datum, so the raster cannot know.
  const har = [];
  const CO = pd.cothon, MH = pd.merchant;
  const ringOuter = M(CO.outerR), ringIsland = M(CO.islandR);
  har.push(`<circle cx="${f2(S(CO.x))}" cy="${f2(T(CO.z))}" r="${f2(ringOuter)}" `
    + `fill="${PC.water}" stroke="${PC.waterEdge}" stroke-width="1.4"/>`);
  // Ship sheds: a radial comb on both faces of the annulus. 168 of them, and they are the
  // reason the ring reads as a naval yard rather than as a pond.
  const shedTicks = [];
  for (let i = 0; i < CO.ringSheds; i++) {
    const a = (i / CO.ringSheds) * Math.PI * 2;
    const r0 = CO.outerR - CO.shedDepth, r1 = CO.outerR;
    shedTicks.push(`M${f2(S(CO.x + Math.cos(a) * r0))} ${f2(T(CO.z + Math.sin(a) * r0))}`
      + `L${f2(S(CO.x + Math.cos(a) * r1))} ${f2(T(CO.z + Math.sin(a) * r1))}`);
  }
  for (let i = 0; i < CO.islandSheds; i++) {
    const a = (i / CO.islandSheds) * Math.PI * 2;
    const r0 = CO.islandR + 1.5, r1 = CO.islandR + CO.shedDepth;
    shedTicks.push(`M${f2(S(CO.x + Math.cos(a) * r0))} ${f2(T(CO.z + Math.sin(a) * r0))}`
      + `L${f2(S(CO.x + Math.cos(a) * r1))} ${f2(T(CO.z + Math.sin(a) * r1))}`);
  }
  har.push(`<path d="${shedTicks.join('')}" fill="none" stroke="${PC.civicEdge}" stroke-width="0.8" opacity="0.85"/>`);
  har.push(`<circle cx="${f2(S(CO.x))}" cy="${f2(T(CO.z))}" r="${f2(ringIsland)}" `
    + `fill="${PC.pave}" stroke="${PC.civicEdge}" stroke-width="1.2"/>`);
  har.push(`<line x1="${f2(S(CO.x + CO.islandR))}" y1="${f2(T(CO.z))}" `
    + `x2="${f2(S(CO.x + CO.outerR))}" y2="${f2(T(CO.z))}" stroke="#7a5a34" `
    + `stroke-width="${f2(Math.max(1.4, M(CO.causewayWidth)))}"/>`);
  // The merchant basin, its quay belts and the 21 m chained entrance between the two moles.
  har.push(`<rect x="${f2(S(MH.x - MH.hw - MH.quayWest))}" y="${f2(T(MH.z + MH.hd + MH.quayEast))}" `
    + `width="${f2(M(MH.hw * 2 + MH.quayWest * 2))}" height="${f2(M(MH.hd * 2 + MH.quayEast + MH.quayWest))}" `
    + `fill="${PC.pave}" stroke="${PC.paveEdge}" stroke-width="0.9"/>`);
  har.push(`<rect x="${f2(S(MH.x - MH.hw))}" y="${f2(T(MH.z + MH.hd))}" `
    + `width="${f2(M(MH.hw * 2))}" height="${f2(M(MH.hd * 2))}" `
    + `fill="${PC.water}" stroke="${PC.waterEdge}" stroke-width="1.4"/>`);
  for (const ch of pd.channels) {
    har.push(`<line x1="${f2(S(ch.x1))}" y1="${f2(T(ch.z1))}" x2="${f2(S(ch.x2))}" y2="${f2(T(ch.z2))}" `
      + `stroke="${PC.water}" stroke-width="${f2(M(ch.halfW * 2))}" stroke-linecap="butt"/>`);
  }

  // ---- masonry: the triple circuit, its towers and its gates ----------------
  const walls = [];
  // The line first, so a bay whose masonry the plan happens not to publish does not read as
  // a hole in the circuit; then the stone the city actually built, on top of it.
  walls.push(`<path d="${pathD(pd.circuit)}" fill="none" stroke="${PC.wall}" `
    + `stroke-width="2.4" opacity="0.5"/>`);
  const wallKinds = { wall: PC.wall, tower: '#221a12', gate: '#8c2f2f' };
  for (const o of pd.obstacles) {
    if (!wallKinds[o.kind]) continue;
    walls.push(poly(o, wallKinds[o.kind], '#1d1710', 0.4));
  }
  // The six reserved stair aprons: where a flight off the walk may put a formation down.
  for (const ax of pd.aprons) {
    const cz = pd.circuitZAt[String(ax)];
    if (cz == null) continue;
    walls.push(`<rect x="${f2(S(ax - pd.apronHalfRun))}" y="${f2(T(cz + pd.apronDepth))}" `
      + `width="${f2(M(pd.apronHalfRun * 2))}" height="${f2(M(pd.apronDepth))}" fill="none" `
      + `stroke="${PC.wall}" stroke-width="0.9" stroke-dasharray="3 4" opacity="0.55"/>`);
  }

  // ---- monuments ------------------------------------------------------------
  const monKind = {
    cothon: null, harbour: null, // drawn as water above
    forum: [PC.pave, PC.paveEdge], tophet: [PC.pave, PC.paveEdge],
    byrsa: [PC.citadel, '#4a2a18'],
    stoa: [PC.civic, PC.civicEdge], temple: [PC.civic, PC.civicEdge],
    cistern: [PC.civic, PC.civicEdge], warehouse: [PC.civic, PC.civicEdge],
    'quay-fort': ['#7a3b2e', '#43201a'],
  };
  const mons = [];
  for (const m of pd.monuments) {
    const c = monKind[m.kind];
    if (!c) continue;
    mons.push(poly(m, c[0], c[1], 1.1));
  }
  // The citadel enceinte and the temple of Eshmun on the summit plateau. §5.2 — geometry
  // that is built (`byrsa.ts`) but carries no entry in `getLandmarks()`.
  const BY = pd.byrsa;
  mons.push(`<rect x="${f2(S(BY.x - BY.summitHw))}" y="${f2(T(BY.z + BY.summitHd))}" `
    + `width="${f2(M(BY.summitHw * 2))}" height="${f2(M(BY.summitHd * 2))}" fill="none" `
    + `stroke="#3a1f10" stroke-width="1.8"/>`);
  mons.push(`<circle cx="${f2(S(BY.x))}" cy="${f2(T(BY.z))}" r="4.5" fill="none" `
    + `stroke="#3a1f10" stroke-width="1.6"/>`);
  // The sixty steps: from the enceinte's landward gate down to where the three streets end.
  mons.push(`<line x1="${f2(S(BY.stairHead.x))}" y1="${f2(T(BY.stairHead.z))}" `
    + `x2="${f2(S(BY.x - BY.summitHw))}" y2="${f2(T(BY.z))}" stroke="#3a1f10" `
    + `stroke-width="${f2(Math.max(2, M(9)))}" stroke-linecap="butt"/>`);

  // ---- quarters: the Megara is a land class, not housing --------------------
  const quarters = [];
  for (const q of pd.quarters) {
    if (q.kind !== 'megara') continue;
    quarters.push(poly(q, 'none', PC.megara, 1.6).replace('/>', ' stroke-dasharray="10 6"/>'));
  }

  // ---- streets --------------------------------------------------------------
  const rankOf = (l) => (l.stepped ? 'stepped' : l.cls);
  const wayPath = (l) => l.path.map((q, i) => `${i ? 'L' : 'M'}${f2(S(q[0]))} ${f2(T(q[1]))}`).join(' ');

  const namedWays = [];
  /** Ways too short to carry their own id inline; they join the leader-label pass instead. */
  const wayLeaders = [];
  /** Boxes the leader pass must route around. See `placeLabels`. */
  const reservedWays = [];
  for (const w of pd.named) {
    const r = rankOf(w);
    const d = wayPath(w);
    namedWays.push(`<path d="${d}" fill="none" stroke="#4a3b28" stroke-width="${f2(M(w.width) + 2.2)}" `
      + `stroke-linejoin="round" stroke-linecap="round" opacity="0.5"/>`);
    namedWays.push(`<path d="${d}" fill="none" stroke="${RANK_COL[r]}" stroke-width="${f2(M(w.width))}" `
      + `stroke-linejoin="round" stroke-linecap="round"/>`);
    if (w.stepped) {
      const rungs = [];
      for (let i = 0; i + 1 < w.path.length; i++) {
        const [ax, az] = w.path[i], [bx, bz] = w.path[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const nx = -(bz - az) / len, nz = (bx - ax) / len;
        for (let t = 0; t < len; t += 9) {
          const px = ax + ((bx - ax) * t) / len, pz = az + ((bz - az) * t) / len;
          rungs.push(`M${f2(S(px - nx * 3))} ${f2(T(pz - nz * 3))}L${f2(S(px + nx * 3))} ${f2(T(pz + nz * 3))}`);
        }
      }
      namedWays.push(`<path d="${rungs.join('')}" fill="none" stroke="#dceaf4" stroke-width="0.8" opacity="0.8"/>`);
    }
    /**
     * The id, set on the way itself.
     *
     * Not `textPath`: on a 97 px path a 15-character id overflows its own way and on the
     * cothon ring it comes out upside down. So the id goes on the *straightest, flattest*
     * segment the way owns — among everything at least half the length of its longest run,
     * the one closest to horizontal on the page — and anything with no run long enough to
     * hold the text at all drops into the leader pass with the monuments.
     */
    const sp = w.path.map((q) => [S(q[0]), T(q[1])]);
    let total = 0, best = 0;
    const segs = [];
    for (let i = 0; i + 1 < sp.length; i++) {
      const len = Math.hypot(sp[i + 1][0] - sp[i][0], sp[i + 1][1] - sp[i][1]);
      total += len;
      best = Math.max(best, len);
      segs.push({ i, len });
    }
    const need = textW(w.id, 11.5);
    if (total < need + 34) {
      const mid = sp[Math.floor(sp.length / 2)];
      wayLeaders.push({ ax: mid[0], ay: mid[1], text: w.id, size: 11.5, fill: RANK_COL[r] });
      continue;
    }
    let pick = null, score = 1e9;
    for (const sg of segs) {
      if (sg.len < Math.max(26, best * 0.5)) continue;
      const a = sp[sg.i], b = sp[sg.i + 1];
      const s = Math.abs((b[1] - a[1]) / sg.len) - sg.len / 4000;
      if (s < score) { score = s; pick = sg; }
    }
    if (!pick) pick = segs.reduce((p, q) => (q.len > p.len ? q : p), segs[0]);
    {
      const a = sp[pick.i], b = sp[pick.i + 1];
      let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
      const nx = -(b[1] - a[1]) / pick.len, ny = (b[0] - a[0]) / pick.len;
      const sgn = ny > 0 ? -1 : 1;
      const off = M(w.width) * 0.5 + 9;
      const tx = (a[0] + b[0]) * 0.5 + nx * off * sgn;
      const ty = (a[1] + b[1]) * 0.5 + ny * off * sgn;
      // A conservative axis-aligned box round the rotated id.
      const hw = (Math.abs(Math.cos((ang * Math.PI) / 180)) * need + 8) * 0.5;
      const hh = (Math.abs(Math.sin((ang * Math.PI) / 180)) * need + 15) * 0.5;
      reservedWays.push({ x0: tx - hw, y0: ty - hh, x1: tx + hw, y1: ty + hh });
      namedWays.push(`<text x="${f2(tx)}" y="${f2(ty)}" text-anchor="middle" `
        + `transform="rotate(${f2(ang)} ${f2(tx)} ${f2(ty)})" `
        + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11.5" font-weight="700" `
        + `fill="${PC.ink}" stroke="${PC.paper}" stroke-width="3" paint-order="stroke" `
        + `stroke-linejoin="round">${esc(w.id)}</text>`);
    }
  }

  // The generated mesh, batched by (rank, true width) so every lane is drawn at its own
  // carriageway width and the whole 200-odd of them cost four paths.
  const meshLanes = [];
  {
    const groups = new Map();
    for (const l of pd.lanes) {
      const k = `${l.cls}|${l.w}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    }
    const order = ['vicus', 'local', 'secondary', 'artery'];
    for (const [k, ls] of [...groups].sort((a, b) =>
      order.indexOf(a[0].split('|')[0]) - order.indexOf(b[0].split('|')[0]))) {
      const [cls, w] = k.split('|');
      meshLanes.push(`<path d="${ls.map(wayPath).join(' ')}" fill="none" stroke="${RANK_COL[cls]}" `
        + `stroke-width="${f2(M(Number(w)))}" stroke-linejoin="round" stroke-linecap="round" opacity="0.82"/>`);
    }
  }

  // ---- housing --------------------------------------------------------------
  const houses = [];
  {
    const parts = [];
    for (const o of pd.obstacles) {
      if (o.kind !== 'building') continue;
      parts.push(`M${rectPts(o).replace(/ /g, 'L').replace(/,/g, ' ')}Z`);
    }
    houses.push(`<path d="${parts.join('')}" fill="${PC.house}" stroke="${PC.houseEdge}" `
      + `stroke-width="0.45" fill-rule="evenodd"/>`);
  }

  // ---- compass, scale bar and the four edge legends -------------------------
  const card = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" `
    + `fill="${PC.paper}" fill-opacity="0.86" stroke="${PC.rule}" stroke-width="1"/>`;

  const compass = [];
  {
    const cx = L.mapX + 118, cy = L.mapY1 - 106, r = 46;
    compass.push(card(L.mapX + 14, L.mapY1 - 194, 208, 180));
    compass.push(`<text x="${cx}" y="${L.mapY1 - 170}" text-anchor="middle" `
      + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12" font-weight="700" `
      + `letter-spacing="1.6" fill="${PC.ink}">ORIENTATION</text>`);
    compass.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${PC.ink}" stroke-width="1.2"/>`);
    compass.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.66}" fill="none" stroke="${PC.rule}" stroke-width="0.8"/>`);
    // +X is true north and it is to the RIGHT. +Z is true east and it is UP.
    const arms = [
      ['N', r, 0, true], ['E', 0, -r, false], ['S', -r, 0, false], ['W', 0, r, false],
    ];
    for (const [lab, dx, dy, big] of arms) {
      compass.push(`<line x1="${cx}" y1="${cy}" x2="${cx + dx}" y2="${cy + dy}" `
        + `stroke="${big ? PC.mark : PC.ink}" stroke-width="${big ? 3 : 1.4}"/>`);
      if (big) {
        compass.push(`<polygon points="${cx + dx + 11},${cy} ${cx + dx - 4},${cy - 6} ${cx + dx - 4},${cy + 6}" `
          + `fill="${PC.mark}"/>`);
      }
      compass.push(`<text x="${cx + dx * 1.32}" y="${cy + dy * 1.32 + 5}" text-anchor="middle" `
        + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="15" font-weight="700" `
        + `fill="${big ? PC.mark : PC.ink}">${lab}</text>`);
    }
    compass.push(`<text x="${L.mapX + 118}" y="${L.mapY1 - 34}" text-anchor="middle" `
      + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11" fill="${PC.inkSoft}">`
      + `true north = map +X</text>`);
    compass.push(`<text x="${L.mapX + 118}" y="${L.mapY1 - 21}" text-anchor="middle" `
      + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11" fill="${PC.inkSoft}">`
      + `true east = map +Z (up)</text>`);
  }

  const scaleBar = [];
  {
    const total = 1500, px = M(total);
    const bx = L.mapX1 - 24 - px, by = L.mapY1 - 58;
    scaleBar.push(card(bx - 16, by - 40, px + 32, 74));
    for (let i = 0; i < 3; i++) {
      scaleBar.push(`<rect x="${f2(bx + M(500) * i)}" y="${by}" width="${f2(M(500))}" height="11" `
        + `fill="${i % 2 ? PC.paper : PC.ink}" stroke="${PC.ink}" stroke-width="1"/>`);
    }
    for (let i = 0; i <= 3; i++) {
      scaleBar.push(`<text x="${f2(bx + M(500) * i)}" y="${by - 6}" text-anchor="middle" `
        + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12" fill="${PC.ink}">`
        + `${i * 500}</text>`);
    }
    scaleBar.push(`<text x="${f2(bx + px / 2)}" y="${by + 26}" text-anchor="middle" `
      + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11.5" fill="${PC.inkSoft}">`
      + `world metres — see the projection note below</text>`);
  }

  const edges = [];
  const edgeTxt = (x, y, t, anchor, rot) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}"${rot ? ` transform="rotate(${rot} ${x} ${y})"` : ''} `
    + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="13.5" font-weight="700" `
    + `letter-spacing="1.6" fill="${PC.inkSoft}">${esc(t)}</text>`;
  edges.push(edgeTxt(L.mapX + L.mapW / 2, L.mapY - 12, 'GULF OF TUNIS  ·  map +Z  ·  TRUE EAST', 'middle'));
  edges.push(edgeTxt(L.mapX + L.mapW / 2, L.mapY1 + 25,
    'THE ISTHMUS — the Roman assault deploys here (z −190)  ·  map −Z  ·  TRUE WEST', 'middle'));
  edges.push(edgeTxt(L.mapX1 + 22, L.mapY + L.mapH / 2, 'SEBKHET ARIANA  ·  map +X  ·  TRUE NORTH', 'middle', 90));
  edges.push(edgeTxt(L.mapX - 26, L.mapY + L.mapH / 2,
    'LAKE OF TUNIS and THE TAENIA  ·  map −X  ·  TRUE SOUTH', 'middle', -90));

  // ---- terrain naming and spot heights --------------------------------------
  const terrainLabels = [];
  const reservedBase = [];
  for (const t of pd.terrainNames) {
    const sz = t.size ?? 15;
    const len = t.text.length * (sz * 0.6 + (sz < 13 ? 1 : 2.2));
    const [bw, bh] = t.rot ? [sz * 1.5, len] : [len, sz * 1.5];
    reservedBase.push({ x0: S(t.x) - bw / 2 - 4, y0: T(t.z) - bh / 2 - 4, x1: S(t.x) + bw / 2 + 4, y1: T(t.z) + bh / 2 + 4 });
  }
  for (const s of pd.spots) {
    reservedBase.push({ x0: S(s.x) - 8, y0: T(s.z) - 8, x1: S(s.x) + 52, y1: T(s.z) + 18 });
  }
  // The two cards, so no monument name is ever set under the compass or the scale bar.
  reservedBase.push({ x0: L.mapX + 8, y0: L.mapY1 - 200, x1: L.mapX + 228, y1: L.mapY1 - 8 });
  {
    const px = M(1500), bx = L.mapX1 - 24 - px;
    reservedBase.push({ x0: bx - 22, y0: L.mapY1 - 104, x1: bx + px + 22, y1: L.mapY1 - 18 });
  }
  for (const t of pd.terrainNames) {
    terrainLabels.push(`<text x="${f2(S(t.x))}" y="${f2(T(t.z))}" text-anchor="middle" `
      + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="${t.size ?? 15}" `
      + `letter-spacing="${t.size && t.size < 13 ? 1 : 2.2}" fill="${t.fill ?? '#3f6a82'}" `
      + `font-style="italic" opacity="0.95"${t.rot ? ` transform="rotate(${t.rot} ${f2(S(t.x))} ${f2(T(t.z))})"` : ''} `
      + `stroke="${PC.paper}" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">${esc(t.text)}</text>`);
  }
  for (const s of pd.spots) {
    terrainLabels.push(`<path d="M${f2(S(s.x) - 4)} ${f2(T(s.z) - 4)}l8 8M${f2(S(s.x) + 4)} ${f2(T(s.z) - 4)}l-8 8" `
      + `stroke="${PC.ink}" stroke-width="1.3"/>`);
    terrainLabels.push(`<text x="${f2(S(s.x) + 8)}" y="${f2(T(s.z) + 13)}" `
      + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11.5" font-weight="700" `
      + `fill="${PC.ink}" stroke="${PC.paper}" stroke-width="2.6" paint-order="stroke" `
      + `stroke-linejoin="round">${s.h.toFixed(0)} m</text>`);
  }

  // ---- legend ---------------------------------------------------------------
  const legend = (n) => {
    const p = [];
    const y0 = L.legendY;
    p.push(`<line x1="${L.mapX}" y1="${y0 - 20}" x2="${L.mapX1}" y2="${y0 - 20}" stroke="${PC.ink}" stroke-width="1"/>`);
    const col = [L.mapX + 4, L.mapX + 560, L.mapX + 1120, L.mapX + 1600];
    const head = (x, t) => `<text x="${x}" y="${y0 + 4}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="12.5" font-weight="700" letter-spacing="1.6" fill="${PC.ink}">${esc(t)}</text>`;
    const row = (x, i, sw, t, sub) => {
      const y = y0 + 26 + i * 20;
      return sw + `<text x="${x + 40}" y="${y + 4}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
        + `font-size="12" fill="${PC.ink}">${esc(t)}</text>`
        + (sub ? `<text x="${x + 40 + textW(t, 12) + 10}" y="${y + 4}" `
          + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11" fill="${PC.inkSoft}">${esc(sub)}</text>` : '');
    };
    const box = (x, i, fill, stroke, dash) => {
      const y = y0 + 26 + i * 20;
      return `<rect x="${x}" y="${y - 7}" width="30" height="13" fill="${fill}" stroke="${stroke ?? 'none'}" `
        + `stroke-width="1.1"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
    };
    const line = (x, i, col2, w) => {
      const y = y0 + 26 + i * 20;
      return `<line x1="${x}" y1="${y}" x2="${x + 30}" y2="${y}" stroke="${col2}" stroke-width="${w}" stroke-linecap="round"/>`;
    };

    // Column 1 — the ground, on every plate.
    p.push(head(col[0], 'THE GROUND'));
    p.push(`<image x="${col[0]}" y="${y0 + 19}" width="150" height="13" href="${pd.rampSwatch}" preserveAspectRatio="none"/>`);
    p.push(`<rect x="${col[0]}" y="${y0 + 19}" width="150" height="13" fill="none" stroke="${PC.ink}" stroke-width="0.8"/>`);
    for (let i = 0; i <= 3; i++) {
      p.push(`<text x="${col[0] + (150 * i) / 3}" y="${y0 + 46}" text-anchor="middle" `
        + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10.5" fill="${PC.inkSoft}">${i * 20}</text>`);
    }
    p.push(`<text x="${col[0] + 160}" y="${y0 + 31}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="11.5" fill="${PC.ink}">metres above sea level (hillshaded)</text>`);
    p.push(row(col[0], 1.6, box(col[0], 1.6, PC.water, PC.waterEdge), 'sea, lagoon, basin water'));
    p.push(row(col[0], 2.6, box(col[0], 2.6, '#ecebe1', '#c3bfae'), 'Sebkhet Ariana', 'salt pan, dry, walkable'));
    p.push(row(col[0], 3.6, box(col[0], 3.6, '#cfd6b4', '#9aa77c'), 'salt marsh', 'lake margin, the Taenia route'));
    p.push(row(col[0], 4.6, line(col[0], 4.6, '#6a4a24', 1.5), 'contours',
      '10 m, plus the 5 m line at the shore'));
    p.push(`<text x="${col[0]}" y="${y0 + 26 + 5.8 * 20 + 4}" `
      + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11.5" font-weight="700" `
      + `fill="${PC.ink}">Byrsa summit ${pd.relief.summit.toFixed(0)} m a.s.l. · lower town `
      + `${pd.relief.lowerTown.toFixed(0)} m · ${(pd.relief.summit - pd.relief.lowerTown).toFixed(0)} m of relief</text>`);

    // Column 2 — the built city, on every plate.
    p.push(head(col[1], 'MASONRY AND MONUMENTS'));
    p.push(row(col[1], 0, box(col[1], 0, PC.wall, '#1d1710'), 'the triple circuit', 'wall, towers, gatehouses'));
    p.push(row(col[1], 1, box(col[1], 1, 'none', PC.wall, '3 4'), 'stair apron', '6 reserved, 120 × 70 m'));
    p.push(row(col[1], 2, box(col[1], 2, PC.citadel, '#4a2a18'), 'the Byrsa citadel platform'));
    p.push(row(col[1], 3, box(col[1], 3, PC.civic, PC.civicEdge), 'civic solid', 'temple, stoa, cistern, horreum'));
    p.push(row(col[1], 4, box(col[1], 4, PC.pave, PC.paveEdge), 'open paving', 'forum, quay, precinct — walkable'));
    p.push(row(col[1], 5, box(col[1], 5, 'none', PC.megara, '10 6'), 'the Megara', 'gardens and orchards, not housing'));

    // Column 3 — what this plate adds.
    if (n === 1) {
      p.push(head(col[2], 'PLATE 1 SHOWS'));
      p.push(`<text x="${col[2]}" y="${y0 + 30}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
        + `font-size="12" fill="${PC.ink}">the ground, the water, the wall and the</text>`);
      p.push(`<text x="${col[2]}" y="${y0 + 48}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
        + `font-size="12" fill="${PC.ink}">monuments — and nothing else. No streets,</text>`);
      p.push(`<text x="${col[2]}" y="${y0 + 66}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
        + `font-size="12" fill="${PC.ink}">no housing. Plates 2–4 add one layer each.</text>`);
    } else {
      p.push(head(col[2], 'STREETS, AT TRUE WIDTH'));
      const ranks = [
        ['artery', 'artery', '20 m — processional'],
        ['secondary', 'secondary', '12 m — arterial'],
        ['local', 'local', '7 m'],
        ['stepped', 'stepped', '6 m — no wheels, no engines'],
        ['vicus', 'vicus', '4 m — no formation fits'],
      ];
      ranks.forEach(([k, t, sub], i) => {
        p.push(row(col[2], i, line(col[2], i, RANK_COL[k], Math.max(1.5, M(RANK_W[k]))), t, sub));
      });
      p.push(row(col[2], 5,
        line(col[2], 5, '#4a3b28', 7) + line(col[2], 5, PC.secondary, 4),
        'named way', n === 2 ? '11 in the armature, labelled' : 'dark casing + id'));
      if (n >= 3) {
        p.push(row(col[2], 6, line(col[2], 6, PC.vicus, 3), 'generated lane', 'no casing, cut per quarter'));
      }
    }

    // Column 4 — the projection warning and the plate's own count.
    p.push(head(col[3], 'READ THIS BEFORE COMPARING'));
    const notes = [
      'The plan is anisotropically compressed.',
      'x = 0.45 · (metres true north)   KN = 0.45',
      'z = 945 + 0.22 · (metres true east)  KE = 0.22',
      'So true EAST–WEST — the vertical axis here —',
      'is squeezed 2.05× against true north–south.',
      'A distance up the page is 4.55 real metres per',
      'world metre; across the page, 2.22.',
      'Do not measure this against a survey plan of',
      'Carthage without applying both factors.',
    ];
    notes.forEach((t, i) => {
      p.push(`<text x="${col[3]}" y="${y0 + 24 + i * 16}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
        + `font-size="11" fill="${i < 3 ? PC.ink : PC.inkSoft}"${i === 0 ? ` font-weight="700"` : ''}>${esc(t)}</text>`);
    });
    return p.join('\n');
  };

  /**
   * **The section, because the plan view structurally cannot show this.**
   *
   * §4.2's belt is 74.1 m from the ditch's outer lip to the back of the main wall, and at the
   * plate's scale of 1,500 world metres to the sheet that is about three pixels — a hairline.
   * So the one thing that makes Carthage worth building, the *depth* of the works, is the one
   * thing the plan cannot carry, and an owner approving landmarks off plates 1–4 would be
   * approving a black line.
   *
   * Drawn at true 1:1 with no vertical exaggeration, so a height and a run on this band can be
   * measured against each other with a ruler. Every dimension is §4.2, §4.3, §4.4 and §4.5;
   * they are literals here rather than reads out of the build because this is the *spec*
   * against which the built wall is graded, and `src/city/carthageWall.ts` is being rewritten
   * by another workstream as this is drawn. If the two ever disagree, the wall is wrong or the
   * spec moved, and either way the disagreement is the finding.
   *
   * Rome's curtain is drawn beside it at the same scale, because the 12.4× is the headline and
   * a reader should not have to take it on trust.
   */
  const wallSection = () => {
    const p = [];
    const K = 6.6;                                   // pixels per true metre, both axes
    const y0 = L.sectionY;
    const baseY = y0 + L.sectionH - 52;              // natural ground level
    const sx = L.mapX + 92;
    const X = (m) => sx + m * K;
    const Y = (h) => baseY - h * K;
    const M = (a, b) => `${a},${b}`;

    p.push(`<line x1="${L.mapX}" y1="${y0 - 22}" x2="${L.mapX1}" y2="${y0 - 22}" stroke="${PC.ink}" stroke-width="1"/>`);
    p.push(`<text x="${L.mapX}" y="${y0 - 2}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="12.5" font-weight="700" letter-spacing="1.6" fill="${PC.ink}">`
      + `SECTION THROUGH THE TRIPLE WALL — WHAT THE PLAN ABOVE CANNOT SHOW</text>`);
    p.push(`<text x="${L.mapX1}" y="${y0 - 2}" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="11.5" fill="${PC.inkSoft}">true 1:1, no vertical exaggeration · `
      + `the belt is 74.1 m deep and about 3 px wide on the plan above · §4.2–§4.5, the specification, not the build</text>`);

    // Ground, and the ditch cut into it. Lip 0, inner lip 20, 6 m deep on a 2 m flat bottom.
    const groundFill = '#dcc9a4', groundEdge = '#9c8154';
    p.push(`<path d="M ${M(X(-14), baseY)} L ${M(X(0), baseY)} L ${M(X(9), Y(-6))} L ${M(X(11), Y(-6))} `
      + `L ${M(X(20), baseY)} L ${M(X(123), baseY)} L ${M(X(123), Y(-9))} L ${M(X(-14), Y(-9))} Z" `
      + `fill="${groundFill}" stroke="${groundEdge}" stroke-width="1.1"/>`);

    /** A block of masonry with a face batter, drawn from its two ground corners up. */
    const masonry = (m0, m1, h, fill) =>
      `<rect x="${X(m0)}" y="${Y(h)}" width="${(m1 - m0) * K}" height="${h * K}" `
      + `fill="${fill ?? PC.wall}" stroke="#1d1710" stroke-width="1"/>`;
    /** Merlons: a crenellated cap of height `hp` sitting on a walk at `hw`. */
    const merlons = (m0, m1, hw, hp, XF = X) => {
      const s = [];
      const n = Math.max(2, Math.round(((m1 - m0) * K) / 9));
      for (let i = 0; i < n; i += 2) {
        const a = m0 + ((m1 - m0) * i) / n, b = m0 + ((m1 - m0) * (i + 1)) / n;
        s.push(`<rect x="${XF(a)}" y="${Y(hw + hp)}" width="${(b - a) * K}" height="${hp * K}" `
          + `fill="${PC.wall}" stroke="#1d1710" stroke-width="0.8"/>`);
      }
      return s.join('');
    };

    // 2 — the outer work: earth and rubble, stone-revetted on the ditch face, palisade on top.
    p.push(`<path d="M ${M(X(23.5), baseY)} L ${M(X(25), Y(4))} L ${M(X(31), Y(4))} L ${M(X(32.5), baseY)} Z" `
      + `fill="#c9ad82" stroke="${groundEdge}" stroke-width="1.1"/>`);
    for (let m = 25.4; m < 31; m += 1.1) {
      p.push(`<line x1="${X(m)}" y1="${Y(4)}" x2="${X(m)}" y2="${Y(5.8)}" stroke="#6b5636" stroke-width="1.6"/>`);
    }
    // 4 — the middle wall: plain ashlar, 4 m thick, 8 m to the walk.
    p.push(masonry(43, 47, 8));
    p.push(merlons(43, 47, 8, 1.8));
    // 6 — the main wall: 9.1 m thick, 13.7 m to the walk, two vaults inside it.
    p.push(masonry(65, 74.1, 13.7));
    p.push(merlons(65, 74.1, 13.7, 2.2));
    // The casemates. Outer face 1.5 m, inner face 1.2 m, clear span 6.4 m between them.
    const vs = X(66.5), vw = 6.4 * K;
    p.push(`<rect x="${vs}" y="${Y(8.1)}" width="${vw}" height="${4.6 * K}" fill="#6a5842" stroke="#241d16" stroke-width="0.9"/>`);
    p.push(`<rect x="${vs}" y="${Y(12.7)}" width="${vw}" height="${3.6 * K}" fill="#83705a" stroke="#241d16" stroke-width="0.9"/>`);
    // The vaults are 6.4 m of clear span, which is 42 px — narrower than either caption. So the
    // captions stand off in the military way on leaders rather than overprinting the masonry.
    const vlabel = (h, t) => {
      const yy = Y(h);
      return `<line x1="${vs + vw}" y1="${yy}" x2="${X(76.5)}" y2="${yy}" stroke="${PC.inkSoft}" stroke-width="0.8"/>`
        + `<circle cx="${vs + vw}" cy="${yy}" r="1.8" fill="${PC.inkSoft}"/>`
        + `<text x="${X(77.4)}" y="${yy + 3.4}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
        + `font-size="10" fill="${PC.ink}">${esc(t)}</text>`;
    };
    p.push(vlabel(10.5, 'upper vault 3.6 m — the fighting gallery, loopholed (§4.4)'));
    p.push(vlabel(5.6, 'lower vault 4.6 m — stalls for 300 elephants, and dark'));
    p.push(vlabel(1.7, 'and 3.5 m of solid footing under both'));
    // A tower, ghosted, to carry the 22.5 m: 11 m across, projecting 5.5 m beyond the outer face.
    p.push(`<rect x="${X(59.5)}" y="${Y(22.5)}" width="${11 * K}" height="${22.5 * K}" fill="none" `
      + `stroke="${PC.wall}" stroke-width="1.2" stroke-dasharray="5 4" opacity="0.75"/>`);
    p.push(`<text x="${X(65)}" y="${Y(23.4)}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="10" fill="${PC.inkSoft}">tower 22.5 m, one every 59.2 m</text>`);

    // A man, 1.8 m, standing in the killing ground. The whole point of a 1:1 section.
    const mx = X(56);
    p.push(`<circle cx="${mx}" cy="${Y(1.62)}" r="${0.18 * K}" fill="${PC.mark}"/>`);
    p.push(`<line x1="${mx}" y1="${Y(1.44)}" x2="${mx}" y2="${Y(0)}" stroke="${PC.mark}" stroke-width="2"/>`);
    p.push(`<text x="${mx + 9}" y="${Y(0.1)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="10" fill="${PC.mark}">1.8 m</text>`);

    /** A dimension run with ticks and a centred caption, drawn below the ground line. */
    const dim = (m0, m1, lab, row) => {
      const yy = baseY + 20 + row * 15;
      return `<line x1="${X(m0)}" y1="${yy}" x2="${X(m1)}" y2="${yy}" stroke="${PC.inkSoft}" stroke-width="1"/>`
        + `<line x1="${X(m0)}" y1="${yy - 4}" x2="${X(m0)}" y2="${yy + 4}" stroke="${PC.inkSoft}" stroke-width="1"/>`
        + `<line x1="${X(m1)}" y1="${yy - 4}" x2="${X(m1)}" y2="${yy + 4}" stroke="${PC.inkSoft}" stroke-width="1"/>`
        + `<text x="${X((m0 + m1) / 2)}" y="${yy - 5}" text-anchor="middle" `
        + `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10" fill="${PC.ink}">${esc(lab)}</text>`;
    };
    p.push(dim(0, 20, 'ditch 20 × 6 m', 0));
    p.push(dim(20, 25, 'berm 5', 0));
    p.push(dim(25, 31, 'outwork 6', 0));
    p.push(dim(31, 43, 'gap 12', 0));
    p.push(dim(43, 47, '4', 0));
    p.push(dim(47, 65, 'killing ground 18 m', 0));
    p.push(dim(65, 74.1, 'main wall 9.1', 0));
    p.push(dim(74.1, 109.1, 'military way 35 m (§7.5)', 0));
    p.push(dim(0, 74.1, 'THE DEFENSIVE BELT — 74.1 m of works to fight through', 1.15));
    p.push(dim(0, 109.1, 'ditch lip to the first house — 109.1 m', 2.3));

    // Rome at the same scale, so the ratio is a thing you can see rather than a claim.
    const rx = X(132);
    const RX = (m) => rx + m * K;
    p.push(`<path d="M ${M(RX(-8), baseY)} L ${M(RX(30), baseY)} L ${M(RX(30), Y(-9))} L ${M(RX(-8), Y(-9))} Z" `
      + `fill="${groundFill}" stroke="${groundEdge}" stroke-width="1.1"/>`);
    p.push(`<rect x="${RX(0)}" y="${Y(6.5)}" width="${6 * K}" height="${6.5 * K}" fill="${PC.wall}" stroke="#1d1710" stroke-width="1"/>`);
    p.push(merlons(0, 6, 6.5, 2.05, RX));
    const rmx = RX(-4);
    p.push(`<circle cx="${rmx}" cy="${Y(1.62)}" r="${0.18 * K}" fill="${PC.mark}"/>`);
    p.push(`<line x1="${rmx}" y1="${Y(1.44)}" x2="${rmx}" y2="${Y(0)}" stroke="${PC.mark}" stroke-width="2"/>`);
    p.push(`<text x="${RX(3)}" y="${y0 + 22}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="11.5" font-weight="700" fill="${PC.ink}">ROME, same scale</text>`);
    p.push(`<text x="${RX(3)}" y="${y0 + 38}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="10.5" fill="${PC.inkSoft}">the Aurelian curtain,</text>`);
    p.push(`<text x="${RX(3)}" y="${y0 + 51}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="10.5" fill="${PC.inkSoft}">and that is the whole of it</text>`);
    p.push(`<text x="${RX(3)}" y="${baseY + 25}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="10" fill="${PC.ink}">6.0 m</text>`);
    p.push(`<text x="${RX(3)}" y="${baseY + 55}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="12" font-weight="700" fill="${PC.mark}">74.1 ÷ 6.0 = 12.4×</text>`);
    p.push(`<text x="${RX(3)}" y="${baseY + 71}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="10" fill="${PC.inkSoft}">heights are only 1.9–2.1×;</text>`);
    p.push(`<text x="${RX(3)}" y="${baseY + 84}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="10" fill="${PC.inkSoft}">it is the count, not the size</text>`);

    // Attacker's side, defender's side — the section has a direction and it should say so.
    p.push(`<text x="${X(-12)}" y="${Y(17)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="11" font-weight="700" fill="${PC.inkSoft}">← THE ISTHMUS</text>`);
    p.push(`<text x="${X(-12)}" y="${Y(14.6)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="10" fill="${PC.inkSoft}">the attacker</text>`);
    p.push(`<text x="${X(80)}" y="${Y(17)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="11" font-weight="700" fill="${PC.inkSoft}">THE CITY →</text>`);
    p.push(`<text x="${X(80)}" y="${Y(14.6)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="10" fill="${PC.inkSoft}">first house at 109.1 m</text>`);
    return p.join('\n');
  };

  // ---- assemble the four plates ---------------------------------------------
  const nHouse = pd.obstacles.filter((o) => o.kind === 'building').length;
  const nMason = pd.obstacles.filter((o) => o.kind !== 'building' && o.kind !== 'monument').length;
  const specs = [
    {
      n: 1, name: '1-landmarks', title: 'THE GROUND AND THE MONUMENTS',
      sub: `Terrain, water, the ${nMason} masonry solids of the triple circuit, and every named `
        + `monument. No streets and no housing — this is the armature everything else hangs on.`,
      ways: false, mesh: false, fabric: false,
    },
    {
      n: 2, name: '2-streets', title: 'THE NAMED ARMATURE',
      sub: `Plate 1 plus the ${pd.named.length} named ways, drawn to true carriageway width and `
        + `coloured by rank. This is the whole monumental street network of the city.`,
      ways: true, mesh: false, fabric: false,
    },
    {
      n: 3, name: '3-grid', title: 'THE FULL STREET GRID',
      sub: `Plate 2 plus the ${pd.lanes.length} lanes the quarters cut for themselves. Every `
        + `carriageway in Carthage is on this sheet; the blocks between them are where housing goes. Still no housing.`,
      ways: true, mesh: true, fabric: false,
    },
    {
      n: 4, name: '4-fabric', title: 'THE FABRIC AS BUILT',
      sub: `Plate 3 plus the ${nHouse} housing blocks the generator has cut to date. This is what `
        + `stands in the build today, for contrast with plates 1–3.`,
      ways: true, mesh: true, fabric: true,
    },
  ];

  return specs.map((sp) => {
    const g = [];
    g.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" `
      + `viewBox="0 0 ${L.width} ${L.height}" font-kerning="none">`);
    g.push(`<rect width="${L.width}" height="${L.height}" fill="${PC.paper}"/>`);
    // Title block.
    g.push(`<text x="${L.margin}" y="46" font-family="Helvetica Neue,Helvetica,Arial,sans-serif" `
      + `font-size="30" font-weight="700" letter-spacing="0.5" fill="${PC.ink}">`
      + `CARTHAGE, spring 146 BC — plate ${sp.n} of 4: ${esc(sp.title)}</text>`);
    g.push(`<text x="${L.margin}" y="74" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="13.5" fill="${PC.inkSoft}">${esc(sp.sub)}</text>`);
    g.push(`<text x="${L.margin}" y="98" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" `
      + `font-size="12" fill="${PC.inkSoft}">Drawn from the BUILT city — getObstacles(), getLanes(), `
      + `getCircuitSamples() and TerrainSystem.heightAt() — not from the layout constants. `
      + `${esc(pd.stamp)}</text>`);
    // The map.
    g.push(`<clipPath id="mapclip"><rect x="${L.mapX}" y="${L.mapY}" width="${L.mapW}" height="${L.mapH}"/></clipPath>`);
    g.push(`<g clip-path="url(#mapclip)">`);
    g.push(ground.join('\n'));
    g.push(quarters.join('\n'));
    if (sp.mesh) g.push(meshLanes.join('\n'));
    if (sp.fabric) g.push(houses.join('\n'));
    g.push(builtSolids.join('\n'));
    g.push(har.join('\n'));
    g.push(walls.join('\n'));
    g.push(mons.join('\n'));
    if (sp.ways) g.push(namedWays.join('\n'));
    g.push(terrainLabels.join('\n'));
    g.push(compass.join('\n'));
    g.push(scaleBar.join('\n'));
    g.push(drawLabels(placeLabels(
      sp.ways ? [...pd.labels, ...wayLeaders] : pd.labels,
      { x0: L.mapX + 6, y0: L.mapY + 14, x1: L.mapX1 - 6, y1: L.mapY1 - 8 }, 13,
      sp.ways ? [...reservedBase, ...reservedWays] : reservedBase)));
    g.push('</g>');
    g.push(frame.join('\n'));
    g.push(edges.join('\n'));
    g.push(wallSection());
    g.push(legend(sp.n));
    g.push('</svg>');
    return { name: sp.name, svg: g.join('\n'), width: L.width, height: L.height };
  });
}
// ---8<--- PLATES END

if (PLATES_OUT) {
  const L = plateLayout(PLATE_PAGE);
  const dir = path.resolve(ROOT, PLATES_OUT);
  await mkdir(dir, { recursive: true });

  const pd = await page.evaluate(async (o) => {
    const g = window.__game;
    const ctx = g.engine.context;
    const city = ctx.tryGet('city');
    const terrain = ctx.get('terrain');
    const waterLevel = terrain.waterLevel ?? 0;

    // The constants, imported rather than retyped. Two files disagreeing about the Byrsa is
    // the bug this city's whole order of operations exists to prevent.
    const lay = await import('/src/city/carthage/layout.ts');
    const cir = await import('/src/city/carthage/circuit.ts');
    const top = await import('/src/maps/carthage/topography.ts');
    const byr = await import('/src/city/carthage/byrsa.ts');

    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    // Hypsometric tint. Deliberately stretched at the bottom: nine tenths of this map lies
    // between 0 and 20 m, so a ramp spaced evenly to 60 would paint the whole lower town one
    // colour and hide the only thing the ramp is for.
    const RAMP = [
      [0, [0xef, 0xe6, 0xcd]], [2, [0xe9, 0xdc, 0xba]], [5, [0xe4, 0xd3, 0xa9]],
      [9, [0xde, 0xc9, 0x99]], [13, [0xd8, 0xbe, 0x8a]], [17, [0xd1, 0xb2, 0x7c]],
      [22, [0xc9, 0xa4, 0x6e]], [32, [0xbe, 0x92, 0x5e]], [45, [0xb0, 0x7d, 0x4d]],
      [60, [0x9f, 0x67, 0x3d]], [70, [0x92, 0x5a, 0x35]],
    ];
    const landCol = (h) => {
      for (let i = 0; i + 1 < RAMP.length; i++) {
        if (h <= RAMP[i + 1][0]) {
          return lerp3(RAMP[i][1], RAMP[i + 1][1], (h - RAMP[i][0]) / (RAMP[i + 1][0] - RAMP[i][0]));
        }
      }
      return RAMP[RAMP.length - 1][1];
    };

    // ---- the height grid, at map pixel resolution --------------------------
    const cw = o.pxW, ch = o.pxH;
    const dx = (o.x1 - o.x0) / cw, dz = (o.z1 - o.z0) / ch;
    const H = new Float32Array(cw * ch);
    for (let py = 0; py < ch; py++) {
      const z = o.z1 - (py + 0.5) * dz;
      const row = py * cw;
      for (let px = 0; px < cw; px++) H[row + px] = terrain.heightAt(o.x0 + (px + 0.5) * dx, z);
    }

    /**
     * A smoothed copy, for the shading only.
     *
     * The heightfield carries an erosion pass and a detail octave, and at 1.4 world metres
     * per pixel a Lambert shade off the raw field renders the whole peninsula as crumpled
     * paper: the noise wins and the Byrsa — the one elevation on this map that matters —
     * disappears into it. Three box passes is about 6 m of blur, which is under the width of
     * a vicus and well over the wavelength of the noise. Colour still comes off the raw field.
     */
    const Hs = (() => {
      let a = H;
      for (let p = 0; p < 3; p++) {
        const b = new Float32Array(cw * ch);
        for (let j = 0; j < ch; j++) {
          const jm = j > 0 ? -cw : 0, jp = j < ch - 1 ? cw : 0;
          for (let i = 0; i < cw; i++) {
            const k = j * cw + i;
            const im = i > 0 ? -1 : 0, ip = i < cw - 1 ? 1 : 0;
            b[k] = (a[k + jm + im] + a[k + jm] + a[k + jm + ip]
              + a[k + im] + a[k] + a[k + ip]
              + a[k + jp + im] + a[k + jp] + a[k + jp + ip]) / 9;
          }
        }
        a = b;
      }
      return a;
    })();

    // ---- hillshade and colour ----------------------------------------------
    const cvs = document.createElement('canvas');
    cvs.width = cw; cvs.height = ch;
    const g2 = cvs.getContext('2d');
    const img = g2.createImageData(cw, ch);
    const D = img.data;
    // Light from the upper left of the page, over the smoothed field. 1.6× exaggeration, so
    // the wall bench and the harbour terrace register at all on ground that falls one in
    // seven hundred — and no more, or the shore scarp blows out to white.
    const EX = 1.6;
    const Lx = -0.6, Lz = 0.6, Ly = 0.8;
    const Ln = Math.hypot(Lx, Lz, Ly);
    const flat = Ly / Ln;
    for (let py = 0; py < ch; py++) {
      const z = o.z1 - (py + 0.5) * dz;
      for (let px = 0; px < cw; px++) {
        const i = py * cw + px;
        const h = H[i];
        const x = o.x0 + (px + 0.5) * dx;
        let c;
        if (h <= waterLevel) {
          const t = clamp((waterLevel - h) / 8, 0, 1);
          c = lerp3([0xb4, 0xd0, 0xd9], [0x6e, 0x99, 0xb1], t * t * (3 - 2 * t));
        } else {
          c = landCol(h);
          const dAr = top.arianaEdgeX(z) - x;
          if (dAr < 0) c = lerp3(c, [0xec, 0xeb, 0xe1], clamp(-dAr / 60, 0, 1) * 0.9);
          const dLk = x - top.lakeEdgeX(z);
          if (dLk < 26 && dLk > -44 && h < 4) {
            c = lerp3(c, [0xcf, 0xd6, 0xb4], clamp((26 - dLk) / 30, 0, 1) * 0.75);
          }
          // Lambert shade on land only. Water stays flat so the coast reads as an edge.
          const hL = Hs[i - (px > 0 ? 1 : 0)], hR = Hs[i + (px < cw - 1 ? 1 : 0)];
          const hU = Hs[i - (py > 0 ? cw : 0)], hD = Hs[i + (py < ch - 1 ? cw : 0)];
          const gx = ((hR - hL) / (2 * dx)) * EX;
          const gz = ((hU - hD) / (2 * dz)) * EX;
          const nn = Math.hypot(gx, gz, 1);
          const sh = (-gx * Lx - gz * Lz + Ly) / (nn * Ln);
          const f = clamp(1 + 1.55 * (sh - flat), 0.6, 1.4);
          c = [c[0] * f, c[1] * f, c[2] * f];
        }
        const k = i * 4;
        D[k] = clamp(c[0], 0, 255); D[k + 1] = clamp(c[1], 0, 255);
        D[k + 2] = clamp(c[2], 0, 255); D[k + 3] = 255;
      }
    }
    g2.putImageData(img, 0, 0);
    const raster = cvs.toDataURL('image/png');

    // The legend's elevation swatch, from exactly the same ramp.
    const sw = document.createElement('canvas');
    sw.width = 150; sw.height = 1;
    const sg = sw.getContext('2d');
    const si = sg.createImageData(150, 1);
    for (let i = 0; i < 150; i++) {
      const c = landCol((i / 149) * 60);
      si.data[i * 4] = c[0]; si.data[i * 4 + 1] = c[1]; si.data[i * 4 + 2] = c[2]; si.data[i * 4 + 3] = 255;
    }
    sg.putImageData(si, 0, 0);
    const rampSwatch = sw.toDataURL('image/png');

    // ---- marching squares, for contours and for the coast -------------------
    const march = (grid, gw, gh, gx0, gz0, gdx, gdz, level) => {
      const segs = [];
      const at = (i, j) => grid[j * gw + i];
      const ip = (xa, za, va, xb, zb, vb) => {
        const t = (level - va) / (vb - va || 1e-9);
        return [xa + (xb - xa) * t, za + (zb - za) * t];
      };
      const TAB = [[], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], [[0, 3], [1, 2]], [[0, 2]], [[0, 3]],
        [[0, 3]], [[0, 2]], [[0, 1], [2, 3]], [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], []];
      for (let j = 0; j + 1 < gh; j++) {
        for (let i = 0; i + 1 < gw; i++) {
          const v0 = at(i, j), v1 = at(i + 1, j), v2 = at(i + 1, j + 1), v3 = at(i, j + 1);
          const idx = (v0 > level ? 8 : 0) | (v1 > level ? 4 : 0) | (v2 > level ? 2 : 0) | (v3 > level ? 1 : 0);
          const cases = TAB[idx];
          if (!cases.length) continue;
          const xA = gx0 + i * gdx, xB = xA + gdx;
          const zA = gz0 - j * gdz, zB = zA - gdz;
          const E = [
            ip(xA, zA, v0, xB, zA, v1), ip(xB, zA, v1, xB, zB, v2),
            ip(xA, zB, v3, xB, zB, v2), ip(xA, zA, v0, xA, zB, v3),
          ];
          for (const [a, b] of cases) segs.push([E[a][0], E[a][1], E[b][0], E[b][1]]);
        }
      }
      return segs;
    };
    const down = (fac, blur) => {
      const gw = Math.floor(cw / fac), gh = Math.floor(ch / fac);
      let gr = new Float32Array(gw * gh);
      for (let j = 0; j < gh; j++) {
        for (let i = 0; i < gw; i++) {
          let s = 0, n = 0;
          for (let b = 0; b < fac; b++) for (let a = 0; a < fac; a++) { s += H[(j * fac + b) * cw + i * fac + a]; n++; }
          gr[j * gw + i] = s / n;
        }
      }
      for (let p = 0; p < blur; p++) {
        const nx = new Float32Array(gw * gh);
        for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
          let s = 0, n = 0;
          for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
            const jj = j + b, ii = i + a;
            if (jj < 0 || ii < 0 || jj >= gh || ii >= gw) continue;
            s += gr[jj * gw + ii]; n++;
          }
          nx[j * gw + i] = s / n;
        }
        gr = nx;
      }
      return { gr, gw, gh, gdx: fac * dx, gdz: fac * dz };
    };
    const cg = down(8, 2);
    const contours = [5, 10, 20, 30, 40, 50].map((level) => ({
      level,
      segs: march(cg.gr, cg.gw, cg.gh, o.x0 + cg.gdx * 0.5, o.z1 - cg.gdz * 0.5, cg.gdx, cg.gdz, level)
        .map((s) => s.map((v) => Math.round(v * 10) / 10)),
    }));
    const fg = down(2, 0);
    const coast = march(fg.gr, fg.gw, fg.gh, o.x0 + fg.gdx * 0.5, o.z1 - fg.gdz * 0.5, fg.gdx, fg.gdz, waterLevel)
      .map((s) => s.map((v) => Math.round(v * 10) / 10));

    // ---- the city -----------------------------------------------------------
    const allLanes = city.getLanes();
    const named = lay.PUNIC_WAYS.map((w) => ({
      id: w.id, cls: w.cls, width: w.width, stepped: !!w.stepped,
      path: w.path.map((q) => [+q.x.toFixed(1), +q.z.toFixed(1)]),
    }));
    // `plan.ts` concatenates PUNIC_WAYS ahead of the fabric's lanes, so the tail is the
    // generated mesh. Verified rather than assumed: a silent slice at the wrong offset would
    // put named ways on the wrong plate and nothing in the picture would say so.
    let namedPrefixOk = allLanes.length > named.length;
    for (let i = 0; i < named.length && namedPrefixOk; i++) {
      const a = allLanes[i], b = lay.PUNIC_WAYS[i];
      if (!a || a.path.length !== b.path.length
        || Math.abs(a.path[0].x - b.path[0].x) > 0.01 || Math.abs(a.path[0].z - b.path[0].z) > 0.01) {
        namedPrefixOk = false;
      }
    }
    const lanes = allLanes.slice(named.length).map((l) => ({
      cls: l.cls, w: l.width, path: l.path.map((q) => [Math.round(q.x), Math.round(q.z)]),
    }));

    const obstacles = city.getObstacles().map((ob) => ({
      x: +ob.x.toFixed(1), z: +ob.z.toFixed(1), hw: +ob.hw.toFixed(1), hd: +ob.hd.toFixed(1),
      rot: +ob.rot.toFixed(4), kind: ob.kind,
    }));
    const circuit = city.getCircuitSamples(12);

    const monuments = lay.MONUMENTS.map((m) => ({
      id: m.id, name: m.name, kind: m.kind, x: m.x, z: m.z, hw: m.hw, hd: m.hd, rot: m.rot, solid: m.solid,
    }));
    const quarters = lay.QUARTERS.map((q) => ({
      id: q.id, name: q.name, kind: q.kind, x: q.x, z: q.z, hw: q.hw, hd: q.hd,
      rot: q.rot, grid: q.grid, density: q.density, storeys: q.storeys,
    }));

    // ---- labels -------------------------------------------------------------
    const SC = o.mapW / (o.x1 - o.x0);
    const SX = (x) => o.mapX + (x - o.x0) * SC;
    const TZ = (z) => o.mapY1 - (z - o.z0) * SC;
    const labels = [];
    const byrsaH = terrain.heightAt(lay.BYRSA.x, lay.BYRSA.z);
    const townH = (terrain.heightAt(-230, 1005) + terrain.heightAt(-430, 990)
      + terrain.heightAt(250, 930)) / 3;
    for (const m of lay.MONUMENTS) {
      labels.push({
        ax: SX(m.x), ay: TZ(m.z), bold: true,
        text: m.id === 'byrsa' ? `${m.name} — summit ${byrsaH.toFixed(0)} m a.s.l.` : m.name,
      });
    }
    for (const gt of cir.CIRCUIT_GATES) {
      labels.push({
        ax: SX(gt.x), ay: TZ(cir.circuitZAt(gt.x)),
        text: gt.name + (gt.principal ? ' (the ram)' : ''), size: 12,
      });
    }
    labels.push({ ax: SX(lay.BYRSA.x), ay: TZ(lay.BYRSA.z), text: 'Temple of Eshmun, the sixty steps', size: 12 });
    labels.push({ ax: SX(byr.BYRSA_STAIR_HEAD.x), ay: TZ(byr.BYRSA_STAIR_HEAD.z), text: 'citadel enceinte gate', size: 11.5 });
    labels.push({ ax: SX(150), ay: TZ(1200), text: 'the Magon sea gate', size: 12 });
    labels.push({
      ax: SX(lay.COTHON.x + (lay.COTHON.islandR + lay.COTHON.outerR) * 0.5), ay: TZ(lay.COTHON.z),
      text: 'admiralty island · 4 m causeway', size: 12,
    });
    labels.push({ ax: SX(lay.COTHON.x + 30), ay: TZ(1340), text: "the Carthaginians' cut channel, 30 m", size: 12 });
    labels.push({
      ax: SX(lay.MERCHANT_HARBOUR.x), ay: TZ(lay.MERCHANT_HARBOUR.z + lay.MERCHANT_HARBOUR.hd + lay.MERCHANT_HARBOUR.quayEast + 17),
      text: 'the chained entrance, 21 m', size: 12,
    });

    // Spot heights. Placed clear of the scale bar and the compass card, which sit over the
    // bottom of the map, and clear of each other.
    const spotAt = [
      [lay.BYRSA.x, lay.BYRSA.z], [210, 1037], [-330, 862],
      [-620, 860], [0, cir.circuitZAt(0)], [-820, 420], [900, 800], [430, 1250],
    ];
    const spots = spotAt.map(([x, z]) => ({ x, z, h: terrain.heightAt(x, z) }));

    const terrainNames = [
      { x: 240, z: 1350, text: 'GULF OF TUNIS', size: 20 },
      { x: -1235, z: 760, text: 'LAKE OF TUNIS', size: 17, rot: -90 },
      { x: 1285, z: 1000, text: 'SEBKHET ARIANA', size: 16, rot: 90, fill: '#7b7364' },
      { x: -1250, z: 400, text: 'THE TAENIA', size: 13, rot: -78, fill: '#4f6b3f' },
      { x: -560, z: 300, text: 'THE ISTHMUS — the only land approach', size: 16, fill: '#7a6a4e' },
      { x: 330, z: 1140, text: 'BORDJ DJEDID', size: 13, fill: '#7a6a4e' },
      { x: 640, z: 620, text: 'THE MEGARA — gardens, orchards and villas', size: 15, fill: '#4f6b3f' },
    ];

    // ---- the measurements ---------------------------------------------------
    // Bearing is a TRUE compass bearing: +X is true north and +Z is true east, so the
    // bearing of a segment is atan2(dz, dx) — east over north — and it is folded mod 90 so
    // the two arms of an orthogonal grid land in the same bin.
    const bear = new Float64Array(90);
    let totalLen = 0;
    const byRank = {};
    const push = (cls, len, width) => {
      byRank[cls] = byRank[cls] ?? { m: 0, n: 0, ha: 0, wMin: 1e9, wMax: 0 };
      byRank[cls].m += len;
      byRank[cls].ha += (len * width) / 1e4;
      byRank[cls].wMin = Math.min(byRank[cls].wMin, width);
      byRank[cls].wMax = Math.max(byRank[cls].wMax, width);
    };
    for (const l of allLanes) {
      let len = 0;
      for (let i = 0; i + 1 < l.path.length; i++) {
        const ax = l.path[i].x, az = l.path[i].z;
        const bx = l.path[i + 1].x, bz = l.path[i + 1].z;
        const d = Math.hypot(bx - ax, bz - az);
        if (d < 1e-6) continue;
        let b = (Math.atan2(bz - az, bx - ax) * 180) / Math.PI;
        b = ((b % 90) + 90) % 90;
        bear[Math.min(89, Math.floor(b))] += d;
        len += d;
        totalLen += d;
      }
      push(l.cls, len, l.width);
      byRank[l.cls].n++;
    }
    // Dominant bearing pair: the peak of the mod-90 histogram, and everything within ±5°.
    let peak = 0;
    for (let i = 1; i < 90; i++) if (bear[i] > bear[peak]) peak = i;
    let within = 0;
    for (let d = -5; d <= 5; d++) within += bear[(((peak + d) % 90) + 90) % 90];
    /**
     * How much of the built city stands on ground the terrain puts under water.
     *
     * Drawing the ground under the plan is the first thing that could ask this question, and
     * it is not rhetorical: the cothon's north half, the moles and part of the Salammbô shore
     * are seaward of `coastZ`. Reported, not fixed — this is a visualisation job.
     */
    const drowned = {};
    for (const ob of city.getObstacles()) {
      const h = terrain.heightAt(ob.x, ob.z);
      const row = (drowned[ob.kind] = drowned[ob.kind] ?? { n: 0, wet: 0, ha: 0, deepest: 0 });
      row.n++;
      if (h < waterLevel) {
        row.wet++;
        row.ha += (ob.hw * 2 * ob.hd * 2) / 1e4;
        row.deepest = Math.min(row.deepest, h);
      }
    }
    let laneWetM = 0;
    for (const l of allLanes) {
      for (let i = 0; i + 1 < l.path.length; i++) {
        const d = Math.hypot(l.path[i + 1].x - l.path[i].x, l.path[i + 1].z - l.path[i].z);
        for (let t = 0; t < d; t += 6) {
          const u = t / d;
          const x = l.path[i].x + (l.path[i + 1].x - l.path[i].x) * u;
          const z = l.path[i].z + (l.path[i + 1].z - l.path[i].z) * u;
          if (terrain.heightAt(x, z) < waterLevel) laneWetM += 6;
        }
      }
    }

    const gridBearings = {};
    for (const q of lay.QUARTERS) {
      const k = ((q.grid * 180) / Math.PI).toFixed(2);
      gridBearings[k] = gridBearings[k] ?? { ha: 0, quarters: [] };
      gridBearings[k].ha += (q.hw * 2 * q.hd * 2) / 1e4;
      gridBearings[k].quarters.push(q.id);
    }

    return {
      raster, rampSwatch, contours, coast,
      named, lanes, obstacles, circuit, monuments, quarters,
      labels, spots, terrainNames,
      namedPrefixOk, lanesTotal: allLanes.length,
      relief: { summit: +byrsaH.toFixed(1), lowerTown: +townH.toFixed(1) },
      cothon: {
        ...lay.COTHON,
        // `SHED_DEPTH`, `ISLAND_SHEDS` and `RING_SHEDS` are module-private in harbour.ts.
        // Only the count is published, on stats(); the depth is a drawing constant here.
        shedDepth: 40, islandSheds: 30, ringSheds: 138,
      },
      merchant: { ...lay.MERCHANT_HARBOUR },
      byrsa: {
        x: lay.BYRSA.x, z: lay.BYRSA.z, summitHw: lay.BYRSA.summitHw, summitHd: lay.BYRSA.summitHd,
        citadelHw: lay.BYRSA.citadelHw, citadelHd: lay.BYRSA.citadelHd, stairHead: byr.BYRSA_STAIR_HEAD,
      },
      channels: [
        { x1: lay.COTHON.x + lay.COTHON.outerR + 8, z1: lay.COTHON.z,
          x2: lay.MERCHANT_HARBOUR.x - lay.MERCHANT_HARBOUR.hw - 6, z2: lay.MERCHANT_HARBOUR.z, halfW: 10.5 },
        { x1: lay.COTHON.x, z1: lay.COTHON.z + lay.COTHON.outerR + 6, x2: lay.COTHON.x + 60, z2: 1340, halfW: 15 },
      ],
      aprons: [...cir.STAIR_APRONS],
      apronHalfRun: cir.APRON_HALF_RUN, apronDepth: cir.APRON_DEPTH,
      circuitZAt: Object.fromEntries(cir.STAIR_APRONS.map((x) => [String(x), cir.circuitZAt(x)])),
      stamp: `${city.stats().id} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`,
      measure: {
        bearings: Array.from(bear).map((v) => Math.round(v)),
        peak, within: +(within / totalLen).toFixed(4), totalLen: Math.round(totalLen),
        byRank, gridBearings, drowned, laneWetM, waterLevel,
      },
    };
  }, { x0: L.x0, x1: L.x1, z0: L.z0, z1: L.z1, pxW: L.mapW, pxH: L.mapH, mapX: L.mapX, mapY1: L.mapY1, mapW: L.mapW });

  out.plateMeasure = pd.measure;
  if (!pd.namedPrefixOk) {
    console.log('\n*** getLanes() does not begin with PUNIC_WAYS — the named/generated split is WRONG ***');
  }

  const m = pd.measure;
  console.log(`\n── street bearings (true compass, +X = north, +Z = east; folded mod 90°) ──`);
  console.log(`  total street length ${m.totalLen.toLocaleString()} m over ${pd.lanesTotal} ways and lanes`);
  console.log(`  dominant bearing pair ${m.peak}° / ${m.peak + 90}°`);
  console.log(`  within ±5° of it: ${(m.within * 100).toFixed(1)}% of all street length`);
  const rows = [];
  for (let i = 0; i < 90; i += 5) {
    let s = 0;
    for (let k = i; k < i + 5; k++) s += m.bearings[k];
    rows.push([i, s]);
  }
  const maxRow = Math.max(...rows.map((r) => r[1]));
  for (const [i, s] of rows) {
    if (s === 0) continue;
    const bar = '█'.repeat(Math.max(1, Math.round((s / maxRow) * 46)));
    console.log(`    ${String(i).padStart(2)}–${String(i + 5).padStart(2)}°  ${String(Math.round(s)).padStart(6)} m  ${((s / m.totalLen) * 100).toFixed(1).padStart(5)}%  ${bar}`);
  }
  console.log(`\n── street length by rank ──────────────────────────────`);
  for (const [cls, v] of Object.entries(m.byRank)) {
    console.log(`  ${cls.padEnd(10)} ${String(Math.round(v.m)).padStart(7)} m  over ${String(v.n).padStart(4)} ways/lanes`
      + `  width ${v.wMin === v.wMax ? `${v.wMin} m` : `${v.wMin}–${v.wMax} m`}`
      + `  → ${v.ha.toFixed(1)} ha of carriageway`);
  }
  console.log(`\n── city solids standing below the water line (level ${m.waterLevel} m) ──`);
  for (const [kind, v] of Object.entries(m.drowned)) {
    console.log(`  ${kind.padEnd(9)} ${String(v.wet).padStart(4)} / ${String(v.n).padStart(4)} below datum`
      + `  ${v.ha.toFixed(2).padStart(7)} ha  deepest ${v.deepest.toFixed(1)} m`);
  }
  console.log(`  carriageway over water: ${m.laneWetM} m of centreline`);

  /**
   * **Authored against built, and the gap between them is the reading.**
   *
   * This block used to print `q.grid` out of `lay.QUARTERS` under the heading "quarter grid
   * bearings", which is a layout *constant* — the authored jitter — and not a bearing anything
   * was built at. That is precisely the divergence this probe exists to catch, and the probe
   * was committing it: it reported five distinct bearings on a build whose every block had
   * been laid at one, so the instrument said the grid was broken while the city said it was
   * not. A probe that reads intent is a probe that cannot see a plan-versus-baked fault.
   *
   * So both are printed. The authored line is what `layout.ts` still says; the built line is
   * `getObstacles()` — every housing block's own `rot`, weighted by its footprint area. When
   * the two disagree, the built line is the true one and the authored constants are dead
   * numbers that should be read as documentation, not as behaviour.
   */
  console.log(`\n── quarter grid bearings ──────────────────────────────`);
  const gb = Object.entries(m.gridBearings).sort((a, b) => Number(a[0]) - Number(b[0]));
  console.log(`  AUTHORED (layout.ts QUARTERS[].grid — a constant, not a measurement)`);
  console.log(`  ${gb.length} distinct bearings among ${pd.quarters.length} quarters`);
  for (const [deg, v] of gb) {
    console.log(`    ${String(deg).padStart(6)}°  ${v.ha.toFixed(1).padStart(6)} ha  ${v.quarters.join(', ')}`);
  }
  {
    const built = new Map();
    let totHa = 0;
    for (const o of pd.obstacles) {
      if (o.kind !== 'building') continue;
      // Fold into [0, 90): a block turned by a right angle is on the same lattice.
      let d = ((o.rot * 180) / Math.PI) % 90;
      if (d < 0) d += 90;
      const k = (d > 89.995 ? 0 : d).toFixed(2);
      const ha = (o.hw * 2 * o.hd * 2) / 1e4;
      built.set(k, (built.get(k) ?? 0) + ha);
      totHa += ha;
    }
    const rows = [...built.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`  BUILT (getObstacles() — every housing block's own rot, area-weighted)`);
    console.log(`  ${rows.length} distinct bearing(s) across ${pd.obstacles.filter((o) => o.kind === 'building').length} blocks, ${totHa.toFixed(1)} ha of roof`);
    for (const [deg, ha] of rows.slice(0, 8)) {
      console.log(`    ${String(deg).padStart(6)}°  ${ha.toFixed(1).padStart(6)} ha  ${((ha / totHa) * 100).toFixed(1)}%`);
    }
    if (rows.length !== gb.length) {
      console.log(`  → authored ${gb.length}, built ${rows.length}. The build ignores the authored jitter; `
        + `layout.ts's QUARTERS[].grid is documentation, not behaviour.`);
    }
  }

  const plates = buildPlates(pd);
  for (const p of plates) {
    await writeFile(path.join(dir, `${p.name}.svg`), p.svg);
    await page.setViewportSize({ width: p.width, height: p.height });
    await page.setContent(`<!doctype html><body style="margin:0;background:#f7f1e2">${p.svg}</body>`);
    await page.screenshot({ path: path.join(dir, `${p.name}.png`), clip: { x: 0, y: 0, width: p.width, height: p.height } });
    console.log(`  wrote ${PLATES_OUT}/${p.name}.svg + .png  (${p.width}×${p.height})`);
  }
  /**
   * `setContent` above destroyed `window.__game`, so nothing that needs the city may run
   * after this block. `--plan` is sequenced below it for exactly that reason.
   */
}

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

  /**
   * ...and render it, so a reviewer gets a picture and not only a file.
   *
   * This used to run *before* the write, twenty lines further up, so it read the previous
   * run's SVG — and on a first run it threw ENOENT and took the whole probe down after every
   * measurement had already been taken. Rendering last also means the page is finished with:
   * `setContent` destroys `window.__game`.
   */
  await page.setContent(`<body style="margin:0">${parts.join('\n')}</body>`);
  await page.setViewportSize({ width: 1800, height: 700 });
  await page.screenshot({ path: outPath.replace(/\.svg$/, '.png'), fullPage: true });
  console.log('wrote plan png');
}

if (JSON_OUT) {
  await mkdir(path.dirname(path.resolve(ROOT, JSON_OUT)), { recursive: true });
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

await browser.close();
if (server) server.kill();
