#!/usr/bin/env node
/**
 * What a knee-high wall costs, measured.
 *
 * The owner's report, verbatim: *"the horses can go around and through a half constructed /
 * very low wall. I don't know if it's just horses but I played against the bot and it was
 * using that technique."*
 *
 * Two claims, and they are not the same claim. **Through** is about the three `footing`
 * bays of the Aurelian circuit, which are deliberately open. **Around** is about the ends
 * of a curtain that is a *line*, not a ring, on a map 2,800 m across. This tool measures
 * both, and it measures them with more than one instrument each, because the last wall
 * probe in this repo reported seventeen stretches of standing stone as invisible on the
 * strength of one ray that started inside a ditch.
 *
 * ## Modes
 *
 *   census   every bay: stage, x-range, ground, the height of whatever is standing on it,
 *            and whether three independent instruments agree that it is open —
 *            `blocksMovement` (the city's 4 m occupancy raster), `getObstacles()` (the
 *            oriented boxes the sim collides against) and `NavGrid.blocked` (what A*
 *            actually searches). A band open in one and shut in another is a seam fault,
 *            not a finding, and it is printed as such.
 *
 *   nav      what the nav raster *charges* for crossing each footing band, against a
 *            finished bay and against open field. Plus a routed A* comparison: the cost of
 *            the cheapest legal route from the storm's ground to a point inside the city,
 *            and where it crosses.
 *
 *   around   can anything path round the ends? Sweeps beyond both terminal towers to the
 *            map edge with the same three instruments, and then asks the live pathfinder
 *            for a route whose goal is inside the city and reports the crossing x.
 *
 *   battle   one autoplayed assault, with every attacker soldier's signed depth relative
 *            to the curtain sampled once a second. A *crossing* is a sign change from
 *            outside to inside on a man who is not `elevated` — so a ladder, a tower ramp
 *            and a gate are all excluded by construction, and what is left is men walking
 *            through masonry that is not there. Binned by bay and by unit type, with the
 *            time each unit took from the outer approach to the inner face.
 *
 * Usage:
 *   node tools/probe-footing.mjs --port=5471 --only=census,nav,around
 *   node tools/probe-footing.mjs --port=5471 --only=battle --seeds=3 --until=900
 *   node tools/probe-footing.mjs --port=5471 --only=battle --seeds=12 --json=out.json
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const PORT = Number(args.get('port') ?? 5471);
const MAP = args.get('map') ?? 'campus-martius';
const QUALITY = args.get('quality') ?? 'low';
const SEEDS = Number(args.get('seeds') ?? 1);
const SEED0 = Number(args.get('seed0') ?? 4265438264);
const UNTIL = Number(args.get('until') ?? 900);
const JSON_OUT = args.get('json') ?? '';
const ONLY = args.has('only') ? new Set(String(args.get('only')).split(',')) : null;
/**
 * Ablation: keep the nav raster's charge, throw away the integrator's drag.
 *
 * The two halves of the fix land in different subsystems and a single after-arm cannot say
 * which one moved a number. Emptying `ObstacleField`'s rough set after boot removes the
 * movement drag and leaves `costBox`'s charge exactly where `restamp` already wrote it, so
 * this is a clean third arm that needs no second build and no product code behind a flag.
 */
const NO_DRAG = args.has('nodrag');
/**
 * Override the traverse cost the *integrator* charges, leaving the nav raster's charge
 * where the build put it.
 *
 * The derived figure — the grid's own rule for sloping ground, applied to the measured
 * rise — comes out at 4.41 on bay 28, and measured it does not slow a crossing, it stops
 * one. That makes the magnitude a balance question, and a balance question deserves a dial
 * with measured points on it rather than an argument. `rise` is re-solved from the wanted
 * cost through the same `roughTraverseCost` the product uses, so this sweeps the real
 * mechanism and not a parallel one.
 */
const TRAVERSE = args.has('traverse') ? Number(args.get('traverse')) : null;
const want = (k) => !ONLY || ONLY.has(k);

const base = `http://127.0.0.1:${PORT}`;

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let server = null;
if (!(await waitForServer(base, 1500))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 120000))) throw new Error('vite did not start');
  console.log(`• started vite pid ${server.pid} on ${PORT}`);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});

const tokenOf = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function openPage(seed, extra = '') {
  const cfg = { map: MAP, scenario: 'assault', quality: QUALITY };
  if (seed !== undefined) cfg.seed = seed;
  const url = `${base}/?harness=1&w=480&h=270&quality=${QUALITY}`
    + `&scenario=assault&autoplay=1&battle=${tokenOf(cfg)}${extra}`;
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000, polling: 250 });
  await page.evaluate(() => window.__game.engine.stop());
  if (TRAVERSE !== null) {
    const got = await page.evaluate((want) => {
      const g = window.__game;
      const city = g.engine.context.get('city');
      const m = g.battle.masonry;
      if (!city.getRoughGround || !m || typeof m.setRough !== 'function') return null;
      // cost = 1 + min(1, rise/hd) * 5  =>  rise = (cost - 1) / 5 * hd
      const list = city.getRoughGround().map((r) => ({
        x: r.x, z: r.z, hw: r.hw, hd: r.hd, rot: r.rot,
        rise: ((want - 1) / 5) * r.hd,
      }));
      m.setRough(list);
      return list.length;
    }, TRAVERSE);
    if (got === null) throw new Error('--traverse asked for on a build with no rough ground');
    if (got === 0) throw new Error('--traverse: the city published no rough ground to scale');
  }
  if (NO_DRAG) {
    const dropped = await page.evaluate(() => {
      const m = window.__game.battle.masonry;
      if (!m || typeof m.setRough !== 'function') return null;
      const had = m.noRough ? 0 : 1;
      m.setRough([]);
      return { had, noRoughNow: m.noRough };
    });
    if (dropped === null) throw new Error('--nodrag asked for on a build with no ObstacleField.setRough');
    if (!dropped.noRoughNow) throw new Error('--nodrag did not take');
  }
  return { page, errors };
}

// ---------------------------------------------------------------------------
// Shared in-page helpers, installed once per page.
// ---------------------------------------------------------------------------
const KIT = `(() => {
window.__fk = (() => {
  const ctx = window.__game.engine.context;
  const city = ctx.get('city');
  const nav = ctx.get('pathfinding');
  const terrain = ctx.tryGet('terrain');
  const bays = city.getGarrisonBays();

  /** The bay whose x-range contains x, or the nearest one. Bays are ordered west to east. */
  const bayAtX = (x) => {
    for (const b of bays) if (x >= Math.min(b.x0, b.x1) && x <= Math.max(b.x0, b.x1)) return b;
    return x < bays[0].x0 ? bays[0] : bays[bays.length - 1];
  };
  /**
   * Where the curtain's centreline is at this x, and which way is out.
   *
   * Extrapolated along the terminal bay's own direction past either end, so a transect
   * beyond the last tower is still measured perpendicular to the wall it is going round
   * rather than square to the world axes.
   */
  const lineAt = (x) => {
    const b = bayAtX(x);
    const t = (x - b.x0) / (b.x1 - b.x0 || 1);
    return { x, z: b.z0 + (b.z1 - b.z0) * t, nx: b.nx, nz: b.nz, bay: b.index, stage: b.stage };
  };
  /** Signed distance of a world point from the curtain, positive = outside (the storm's side). */
  const depthOf = (x, z) => {
    const L = lineAt(x);
    return (x - L.x) * L.nx + (z - L.z) * L.nz;
  };
  return { ctx, city, nav, terrain, bays, bayAtX, lineAt, depthOf };
})();
})()
`;

// ---------------------------------------------------------------------------
// census
// ---------------------------------------------------------------------------
async function census(page) {
  return page.evaluate(() => {
    const { city, nav, terrain, bays, lineAt } = window.__fk;
    const boxes = city.getObstacles();
    const R = 14; // half-transect: clear of a 6 m curtain and its 3.5 m tower projection

    /** Does the city's own occupancy raster stop a straight crossing here? */
    const rasterShut = (x) => {
      const L = lineAt(x);
      return city.blocksMovement(L.x + L.nx * R, L.z + L.nz * R, L.x - L.nx * R, L.z - L.nz * R);
    };
    /** Does A*'s own mask stop it? Walks the transect cell by cell. */
    const navShut = (x) => {
      const L = lineAt(x);
      for (let t = -R; t <= R; t += nav.grid.cell * 0.5) {
        if (nav.grid.blockedAt(L.x + L.nx * t, L.z + L.nz * t)) return true;
      }
      return false;
    };
    /** Is there an oriented solid box whose footprint covers the centreline here? */
    const boxAt = (x) => {
      const L = lineAt(x);
      for (const o of boxes) {
        const c = Math.cos(-o.rot), s = Math.sin(-o.rot);
        const dx = L.x - o.x, dz = L.z - o.z;
        const u = dx * c - dz * s, v = dx * s + dz * c;
        if (Math.abs(u) <= o.hw && Math.abs(v) <= o.hd) return o;
      }
      return null;
    };

    // --- open bands, at 0.5 m ------------------------------------------------
    const x0 = Math.min(...bays.map((b) => b.x0)) - 2;
    const x1 = Math.max(...bays.map((b) => b.x1)) + 2;
    const bands = [];
    let run = null;
    for (let x = x0; x <= x1; x += 0.5) {
      const open = !rasterShut(x);
      if (open && !run) run = { from: x, to: x };
      else if (open) run.to = x;
      else if (run) { bands.push(run); run = null; }
    }
    if (run) bands.push(run);
    for (const b of bands) {
      const mid = (b.from + b.to) * 0.5;
      const L = lineAt(mid);
      b.bay = L.bay;
      b.stage = L.stage;
      b.width = +(b.to - b.from).toFixed(1);
      b.navShut = navShut(mid);
      b.box = boxAt(mid) ? { kind: boxAt(mid).kind, topY: +boxAt(mid).topY.toFixed(2) } : null;
    }

    // --- per bay -------------------------------------------------------------
    const rows = bays.map((b) => {
      const mid = (b.x0 + b.x1) * 0.5;
      const L = lineAt(mid);
      const g = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const px = b.x0 + (b.x1 - b.x0) * t, pz = b.z0 + (b.z1 - b.z0) * t;
        g.push(terrain ? terrain.heightAt(px, pz) : 0);
      }
      const gMin = Math.min(...g), gMax = Math.max(...g);
      // What the city says is standing here, sampled along the run, as a height above the
      // ground under that very point — which is the number a man has to step over.
      let overGround = -Infinity, overAt = 0;
      let minOver = Infinity;
      for (let k = 0; k <= 16; k++) {
        // 0.03..0.97, never 0 or 1. At exactly x0 the sample lands on the *previous*
        // bay — `bayIndexAt` is index arithmetic and a boundary belongs to one side —
        // and bay 2's neighbour is finished curtain 40 m up. That is how this instrument
        // first reported a 40.55 m knee-high pour.
        const t = 0.03 + (k / 16) * 0.94;
        const px = b.x0 + (b.x1 - b.x0) * t, pz = b.z0 + (b.z1 - b.z0) * t;
        const top = city.masonryTopAt(px, pz);
        const gp = terrain ? terrain.heightAt(px, pz) : 0;
        const d = top === -Infinity ? -Infinity : top - gp;
        if (d > overGround) { overGround = d; overAt = px; }
        if (d < minOver) minOver = d;
      }
      const bx = boxAt(mid);
      return {
        index: b.index, stage: b.stage, isGate: b.isGate,
        x0: +b.x0.toFixed(1), x1: +b.x1.toFixed(1),
        gMin: +gMin.toFixed(2), gMax: +gMax.toFixed(2),
        walkY: +b.walkY.toFixed(2),
        maxOverGround: Number.isFinite(overGround) ? +overGround.toFixed(2) : null,
        minOverGround: Number.isFinite(minOver) ? +minOver.toFixed(2) : null,
        maxOverAt: +overAt.toFixed(0),
        rasterShut: rasterShut(mid),
        navShut: navShut(mid),
        hasBox: !!bx,
        boxTopY: bx ? +bx.topY.toFixed(2) : null,
      };
    });

    return {
      nBays: bays.length,
      xRange: [+x0.toFixed(1), +x1.toFixed(1)],
      stages: rows.reduce((a, r) => (a[r.stage] = (a[r.stage] ?? 0) + 1, a), {}),
      bands, rows,
      obstacleCount: boxes.length,
      wallBoxes: boxes.filter((o) => o.kind === 'wall').length,
      /**
       * What the city publishes as standing-but-passable, if it publishes any.
       *
       * Absent on a build that predates `getRoughGround`, which is exactly what the before
       * arm is, so this is probed rather than called. `null` and `[]` mean different things
       * and are reported as different things.
       */
      rough: typeof city.getRoughGround === 'function'
        ? city.getRoughGround().map((r) => ({
          bay: r.bay, x: +r.x.toFixed(1), hw: +r.hw.toFixed(2), hd: +r.hd.toFixed(2),
          rise: +r.rise.toFixed(2), crestY: +r.crestY.toFixed(2),
        }))
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// nav — what the raster charges
// ---------------------------------------------------------------------------
async function navCost(page) {
  return page.evaluate(() => {
    const { city, nav, bays, lineAt } = window.__fk;
    const g = nav.grid;
    const R = 14;

    /** cost / blocked / clearance sampled straight across the curtain at this x. */
    const transect = (x) => {
      const L = lineAt(x);
      const out = [];
      for (let t = -R; t <= R; t += g.cell) {
        const px = L.x + L.nx * t, pz = L.z + L.nz * t;
        const i = g.cellAt(px, pz);
        out.push({ t: +t.toFixed(1), cost: +g.cost[i].toFixed(3), blocked: g.blocked[i], clear: +g.clearance[i].toFixed(1) });
      }
      return out;
    };
    /** Total `cost` a straight crossing accumulates, in cell steps — what A* would pay. */
    const crossingCost = (x) => {
      const L = lineAt(x);
      let sum = 0, n = 0, blocked = 0;
      for (let t = -R; t <= R; t += g.cell) {
        const i = g.cellAt(L.x + L.nx * t, L.z + L.nz * t);
        sum += g.cost[i]; n++;
        if (g.blocked[i]) blocked++;
      }
      return { mean: +(sum / n).toFixed(3), sum: +sum.toFixed(2), blocked };
    };

    const footings = bays.filter((b) => b.stage === 'footing');
    const gapBay = bays.find((b) => b.stage === 'gap');
    const finished = bays.find((b) => b.stage === 'finished' && !b.isGate && Math.abs(b.x0) < 300);
    const gate = city.getGates()[0];

    const sites = [];
    for (const b of footings) sites.push({ name: `footing bay ${b.index}`, x: (b.x0 + b.x1) * 0.5 });
    if (gapBay) sites.push({ name: `gap bay ${gapBay.index}`, x: (gapBay.x0 + gapBay.x1) * 0.5 });
    if (finished) sites.push({ name: `finished bay ${finished.index}`, x: (finished.x0 + finished.x1) * 0.5 });
    if (gate) sites.push({ name: 'gate', x: gate.x });

    const rows = sites.map((s) => ({ ...s, ...crossingCost(s.x) }));

    // Open field 300 m out in front of the same bays, as the "costs nothing" datum.
    const field = (() => {
      let sum = 0, n = 0;
      for (const b of bays) {
        const i = g.cellAt((b.x0 + b.x1) * 0.5 + b.nx * 300, (b.z0 + b.z1) * 0.5 + b.nz * 300);
        sum += g.cost[i]; n++;
      }
      return +(sum / n).toFixed(3);
    })();

    return {
      cell: g.cell,
      res: g.res,
      stampedObstacles: nav.stats.cityObstacles,
      openFieldMeanCost: field,
      rows,
      exampleTransect: footings.length
        ? { bay: footings[footings.length - 1].index, samples: transect((footings[footings.length - 1].x0 + footings[footings.length - 1].x1) * 0.5) }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// around — the ends of a wall that is a line
// ---------------------------------------------------------------------------
async function around(page) {
  return page.evaluate(() => {
    const { city, nav, terrain, bays, lineAt } = window.__fk;
    const HALF = 1400;
    const R = 14;
    const wMin = Math.min(...bays.map((b) => b.x0));
    const wMax = Math.max(...bays.map((b) => b.x1));

    /**
     * Beyond the terminal tower, is there a crossing?
     *
     * Two questions, and they are different. `shut` is whether the curtain's own line is
     * blocked here — meaningless past its end, where there is no curtain. `passable` is
     * whether a body can get from the storm's side to the city's side at this x at all,
     * which past the end is about terrain and buildings only.
     */
    const probe = (x) => {
      const L = lineAt(x);
      const rasterShut = city.blocksMovement(L.x + L.nx * R, L.z + L.nz * R, L.x - L.nx * R, L.z - L.nz * R);
      let navBlocked = 0, cells = 0, cost = 0;
      for (let t = -R; t <= R; t += nav.grid.cell * 0.5) {
        const i = nav.grid.cellAt(L.x + L.nx * t, L.z + L.nz * t);
        if (nav.grid.blocked[i]) navBlocked++;
        cost += nav.grid.cost[i]; cells++;
      }
      // And 120 m in, because getting past the wall line is not the same as getting into
      // the city: the pomerium, the Castra and the insulae are behind it.
      let deepBlocked = 0, deepCells = 0;
      for (let d = 20; d <= 160; d += 7) {
        const i = nav.grid.cellAt(L.x - L.nx * d, L.z - L.nz * d);
        if (nav.grid.blocked[i]) deepBlocked++;
        deepCells++;
      }
      return {
        x: +x.toFixed(0), z: +L.z.toFixed(0),
        ground: terrain ? +terrain.heightAt(L.x, L.z).toFixed(1) : null,
        rasterShut, navBlocked, cells, meanCost: +(cost / cells).toFixed(2),
        deepBlocked, deepCells,
      };
    };

    const east = [];
    for (let x = wMax - 40; x <= HALF - 10; x += 10) east.push(probe(x));
    const west = [];
    for (let x = wMin + 40; x >= -HALF + 10; x -= 10) west.push(probe(x));

    // The first x past each end at which a crossing is open in *both* instruments.
    const firstOpenEast = east.find((r) => r.x > wMax && !r.rasterShut && r.navBlocked === 0) ?? null;
    const firstOpenWest = west.find((r) => r.x < wMin && !r.rasterShut && r.navBlocked === 0) ?? null;

    return { wMin: +wMin.toFixed(1), wMax: +wMax.toFixed(1), halfExtent: HALF, east, west, firstOpenEast, firstOpenWest };
  });
}

/**
 * Ask the live pathfinder for a route from a point on the storm's side to a point deep
 * inside the city, and report where it crosses the curtain. This is the question the AI
 * asks, answered by the code the AI asks.
 */
async function routes(page) {
  return page.evaluate(async () => {
    const { nav, bays, lineAt, depthOf } = window.__fk;
    const g = window.__game;
    const grid = nav.grid;
    /** Nudge a point to somewhere A* will accept, so a blocked goal is not read as no route. */
    const standable = (x, z, radius) => {
      const out = { x, z };
      nav.findStandable(x, z, radius, out);
      return out;
    };
    const mid = bays[Math.floor(bays.length / 2)];
    const goal = standable(
      (mid.x0 + mid.x1) * 0.5 - mid.nx * 120,
      (mid.z0 + mid.z1) * 0.5 - mid.nz * 120,
      11,
    );
    const out = [];
    // Start points spread along the storm's frontage, 260 m out.
    for (let k = 0; k <= 8; k++) {
      const b = bays[Math.round((bays.length - 1) * k / 8)];
      const s = standable((b.x0 + b.x1) * 0.5 + b.nx * 260, (b.z0 + b.z1) * 0.5 + b.nz * 260, 11);
      const id = 900000 + k;
      nav.requestPath(id, s.x, s.z, goal.x, goal.z, 11, 3, 3);
      out.push({ id, fromBay: b.index, sx: +s.x.toFixed(0), sz: +s.z.toFixed(0) });
    }
    // Give the budgeted searches time to run: one search at a time, 2,400 nodes a tick.
    for (let i = 0; i < 1200; i++) g.engine.advance(1 / 30, 33);
    const summarise = (r) => {
      const p = nav.pathFor ? nav.pathFor(r.id) : null;
      if (!p) { r.route = { state: 'none' }; return; }
      let crossX = null, crossT = null;
      for (let i = 1; i < p.n; i++) {
        const ax = p.pts[(i - 1) * 2], az = p.pts[(i - 1) * 2 + 1];
        const bx = p.pts[i * 2], bz = p.pts[i * 2 + 1];
        const da = depthOf(ax, az), db = depthOf(bx, bz);
        if (da > 0 && db <= 0) {
          const t = da / (da - db);
          crossX = ax + (bx - ax) * t;
          crossT = lineAt(crossX);
          break;
        }
      }
      r.route = {
        state: p.ok ? 'ok' : 'partial',
        length: +p.length.toFixed(0), n: p.n, narrow: p.narrow,
        crossX: crossX === null ? null : +crossX.toFixed(0),
        crossBay: crossT ? crossT.bay : null,
        crossStage: crossT ? crossT.stage : null,
      };
    };
    for (const r of out) summarise(r);
    return {
      goal: { x: +goal.x.toFixed(0), z: +goal.z.toFixed(0), blocked: grid.blockedAt(goal.x, goal.z) },
      stats: { ...nav.stats },
      rows: out,
    };
  });
}

/**
 * What the raster charges, end to end, with nothing budgeted.
 *
 * The game's own A* is incremental, capped at 2,400 expansions a tick and branch-and-bounded
 * against `MAX_DETOUR`, and two live AI commanders are queueing against it — so asking it
 * "what is the cheapest way in" during a battle measures the queue as much as the ground.
 * This runs one uncapped Dijkstra from a single source outside the curtain over the very
 * same `cost`, `blocked` and `clearance` arrays, with the relaxation transcribed from
 * `AStarSearch.step`:
 *
 *     g(n) = g(c) + stepLen * (cost[c] + cost[n]) / 2 + max(0, height[n] - height[c]) * 1.4
 *
 * It is a copy, and a copy can drift. That is why it is checked against the live search on
 * one route below rather than trusted on its own — and why the number it exists to produce
 * is a *ratio* between crossings on one grid, which drift cancels out of.
 */
async function dijkstra(page) {
  return page.evaluate(() => {
    const { nav, bays, lineAt } = window.__fk;
    const g = nav.grid;
    const res = g.res, N = res * res, CELL = g.cell, S2 = Math.SQRT2;
    const CLIMB_K = 1.4;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

    const run = (srcCell, radius) => {
      const dist = new Float64Array(N).fill(Infinity);
      const from = new Int32Array(N).fill(-1);
      const done = new Uint8Array(N);
      // Bucketless binary heap over indices, keyed by dist.
      const heap = new Int32Array(N * 2);
      let hn = 0;
      const push = (c) => {
        let i = hn++;
        const k = dist[c];
        while (i > 0) {
          const par = (i - 1) >> 1;
          if (dist[heap[par]] <= k) break;
          heap[i] = heap[par]; i = par;
        }
        heap[i] = c;
      };
      const pop = () => {
        const top = heap[0];
        const last = heap[--hn];
        if (hn > 0) {
          let i = 0; const k = dist[last];
          for (;;) {
            const l = i * 2 + 1;
            if (l >= hn) break;
            const r = l + 1;
            const ch = r < hn && dist[heap[r]] < dist[heap[l]] ? r : l;
            if (dist[heap[ch]] >= k) break;
            heap[i] = heap[ch]; i = ch;
          }
          heap[i] = last;
        }
        return top;
      };
      dist[srcCell] = 0; push(srcCell);
      while (hn > 0) {
        const c = pop();
        if (done[c]) continue;
        done[c] = 1;
        const cx = c % res, cz = (c - cx) / res;
        const gc = dist[c], cc = g.cost[c], hc = g.height[c];
        for (let k = 0; k < 8; k++) {
          const nx = cx + DX[k], nz = cz + DZ[k];
          if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
          const n = nz * res + nx;
          if (g.blocked[n]) continue;
          if (g.clearance[n] < radius) continue;
          const diag = k >= 4;
          if (diag && (g.blocked[cz * res + nx] || g.blocked[nz * res + cx])) continue;
          const stepLen = diag ? CELL * S2 : CELL;
          const climb = g.height[n] - hc;
          const t = gc + stepLen * (cc + g.cost[n]) * 0.5 + (climb > 0 ? climb * CLIMB_K : 0);
          if (t < dist[n] - 1e-6) { dist[n] = t; from[n] = c; push(n); }
        }
      }
      return { dist, from };
    };

    // Source: the storm's ground, 320 m out in front of the middle of the curtain.
    const mid = bays[Math.floor(bays.length / 2)];
    const sx = (mid.x0 + mid.x1) * 0.5 + mid.nx * 320;
    const sz = (mid.z0 + mid.z1) * 0.5 + mid.nz * 320;
    const src = g.cellAt(sx, sz);

    /** Where a shortest path crossed the curtain, walking the parent chain back. */
    const crossingOf = (from, cell) => {
      let c = cell, prevIn = null;
      const cw = (i) => { const cx = i % res; return { x: g.toWorld(cx), z: g.toWorld((i - cx) / res) }; };
      const depth = (pt) => { const L = lineAt(pt.x); return (pt.x - L.x) * L.nx + (pt.z - L.z) * L.nz; };
      let guard = 0;
      while (c >= 0 && guard++ < 200000) {
        const pt = cw(c);
        const d = depth(pt);
        if (d > 0 && prevIn) {
          const L = lineAt(prevIn.x);
          return { x: +prevIn.x.toFixed(0), bay: L.bay, stage: L.stage };
        }
        if (d <= 0) prevIn = pt;
        c = from[c];
      }
      return null;
    };

    const out = { source: { x: +sx.toFixed(0), z: +sz.toFixed(0) }, arms: [] };
    for (const radius of [11, 4]) {
      const { dist, from } = run(src, radius);
      // Cheapest way to a point 60 m inside the curtain at each x along it.
      const probes = [];
      for (const b of bays) {
        const px = (b.x0 + b.x1) * 0.5 - b.nx * 60;
        const pz = (b.z0 + b.z1) * 0.5 - b.nz * 60;
        const c = g.cellAt(px, pz);
        probes.push({
          bay: b.index, stage: b.stage, isGate: b.isGate,
          cost: Number.isFinite(dist[c]) ? +dist[c].toFixed(0) : null,
          via: Number.isFinite(dist[c]) ? crossingOf(from, c) : null,
        });
      }
      // And one deep objective: 150 m inside, at the middle of the wall — what a break-in
      // actually aims at.
      const dx = (mid.x0 + mid.x1) * 0.5 - mid.nx * 150;
      const dz = (mid.z0 + mid.z1) * 0.5 - mid.nz * 150;
      const dc = g.cellAt(dx, dz);
      out.arms.push({
        radius,
        deep: {
          x: +dx.toFixed(0), z: +dz.toFixed(0),
          cost: Number.isFinite(dist[dc]) ? +dist[dc].toFixed(0) : null,
          via: Number.isFinite(dist[dc]) ? crossingOf(from, dc) : null,
        },
        probes,
      });
    }
    return out;
  });
}

/**
 * Is bay 28 special, or merely the one nearest the attacker's approach?
 *
 * The twelve-seed before arm is unambiguous: 191 crossings, every one at bay 28, none at
 * bay 2 or bay 29 — and all three are open in `blocksMovement`. So permission and route are
 * different things, and this asks which of the two separates them. Four candidates, all
 * measured against the *riders' own deployment position* rather than a convenient origin,
 * because "nearest the approach" is a claim about where they start:
 *
 *   admission   `clearance` at the band against the footprint radius. A body wider than the
 *               aperture is refused by A* whatever the cost.
 *   terrain     the nav grid's own `blocked` mask. Bay 2 crosses a knoll.
 *   cost        the uncapped least cost from the riders' start to a point 50 m behind each
 *               band at radius 2.2 — `BattleSystem.ROUTE_RADIUS`, the constant an attack
 *               order is actually searched at, regardless of the unit's real frontage.
 *   proximity   straight-line metres from the riders' start to each band.
 *
 * If cost and proximity rank the three bands the same way, "nearest" explains it and the
 * fix has to hold for all three. If admission or terrain rules two of them out, bay 28 is
 * special and the other two were never live.
 */
async function bands(page) {
  return page.evaluate(() => {
    const { nav, bays, lineAt, city } = window.__fk;
    const b = window.__game.battle;
    const flow = window.__game.engine.context.get('battleFlow');
    const storm = flow.objective ? flow.objective.storm : 1;
    const g = nav.grid;
    const res = g.res, N = res * res, CELL = g.cell, S2 = Math.SQRT2, CLIMB_K = 1.4;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

    let horse = null;
    for (const u of b.units) {
      if (u.faction !== storm || u.destroyed || u.alive === 0) continue;
      const cls = b.typeOf(u).unitClass;
      if (cls !== 'heavy-cavalry' && cls !== 'light-cavalry') continue;
      if (!horse || u.alive > horse.alive) horse = u;
    }
    const src = horse ? g.cellAt(horse.x, horse.z) : g.cellAt(0, -300);

    const dijkstra = (radius) => {
      const dist = new Float64Array(N).fill(Infinity);
      const done = new Uint8Array(N);
      const heap = new Int32Array(N * 2);
      let hn = 0;
      const push = (c) => {
        let i = hn++; const k = dist[c];
        while (i > 0) { const par = (i - 1) >> 1; if (dist[heap[par]] <= k) break; heap[i] = heap[par]; i = par; }
        heap[i] = c;
      };
      const pop = () => {
        const top = heap[0]; const last = heap[--hn];
        if (hn > 0) {
          let i = 0; const k = dist[last];
          for (;;) {
            const l = i * 2 + 1; if (l >= hn) break;
            const r = l + 1; const ch = r < hn && dist[heap[r]] < dist[heap[l]] ? r : l;
            if (dist[heap[ch]] >= k) break;
            heap[i] = heap[ch]; i = ch;
          }
          heap[i] = last;
        }
        return top;
      };
      dist[src] = 0; push(src);
      while (hn > 0) {
        const c = pop();
        if (done[c]) continue;
        done[c] = 1;
        const cx = c % res, cz = (c - cx) / res;
        const gc = dist[c], cc = g.cost[c], hc = g.height[c];
        for (let k = 0; k < 8; k++) {
          const nx = cx + DX[k], nz = cz + DZ[k];
          if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
          const n = nz * res + nx;
          if (g.blocked[n]) continue;
          if (g.clearance[n] < radius) continue;
          const diag = k >= 4;
          if (diag && (g.blocked[cz * res + nx] || g.blocked[nz * res + cx])) continue;
          const stepLen = diag ? CELL * S2 : CELL;
          const climb = g.height[n] - hc;
          const t = gc + stepLen * (cc + g.cost[n]) * 0.5 + (climb > 0 ? climb * CLIMB_K : 0);
          if (t < dist[n] - 1e-6) { dist[n] = t; push(n); }
        }
      }
      return dist;
    };

    const d22 = dijkstra(2.2);
    const d11 = dijkstra(11);

    const rows = bays.filter((x) => x.stage === 'footing' || x.stage === 'gap').map((x) => {
      const mx = (x.x0 + x.x1) * 0.5, mz = (x.z0 + x.z1) * 0.5;
      const centre = g.cellAt(mx, mz);
      const inside = g.cellAt(mx - x.nx * 50, mz - x.nz * 50);
      let bestClear = 0;
      for (let t = 0.1; t <= 0.9; t += 0.05) {
        const px = x.x0 + (x.x1 - x.x0) * t, pz = x.z0 + (x.z1 - x.z0) * t;
        const c = g.cellAt(px, pz);
        if (!g.blocked[c] && g.clearance[c] > bestClear) bestClear = g.clearance[c];
      }
      return {
        bay: x.index, stage: x.stage, x: +mx.toFixed(0),
        navBlockedAtCentre: g.blocked[centre] !== 0,
        costAtCentre: +g.cost[centre].toFixed(3),
        bestClearance: +bestClear.toFixed(1),
        fromHorse: horse ? +Math.hypot(mx - horse.x, mz - horse.z).toFixed(0) : null,
        entryCost22: Number.isFinite(d22[inside]) ? +d22[inside].toFixed(0) : null,
        entryCost11: Number.isFinite(d11[inside]) ? +d11[inside].toFixed(0) : null,
      };
    });

    const gate = city.getGates()[0];
    if (gate) {
      const L = lineAt(gate.x);
      const inside = g.cellAt(gate.x - L.nx * 50, gate.z - L.nz * 50);
      rows.push({
        bay: 'gate', stage: gate.open ? 'open' : 'shut', x: +gate.x.toFixed(0),
        navBlockedAtCentre: g.blockedAt(gate.x, gate.z),
        costAtCentre: +g.costAt(gate.x, gate.z).toFixed(3),
        bestClearance: +g.clearanceAt(gate.x, gate.z).toFixed(1),
        fromHorse: horse ? +Math.hypot(gate.x - horse.x, gate.z - horse.z).toFixed(0) : null,
        entryCost22: Number.isFinite(d22[inside]) ? +d22[inside].toFixed(0) : null,
        entryCost11: Number.isFinite(d11[inside]) ? +d11[inside].toFixed(0) : null,
      });
    }

    return {
      horse: horse ? { typeId: horse.typeId, x: +horse.x.toFixed(0), z: +horse.z.toFixed(0), alive: horse.alive } : null,
      rows,
    };
  });
}

/**
 * Does the garrison cover its own hole?
 *
 * A gap in your wall is a thing you post men at. Whether Rome does is a fact, and it is a
 * different fact from whether the gap is expensive to cross: charging a horse four times
 * the going rate to scramble a rubble bank buys nothing if there is nobody within two
 * hundred metres to shoot at it while it does. Measured here and **reported rather than
 * changed** — where the garrison stands is a balance decision and it is the owner's.
 *
 * Two numbers per footing bay: how many defenders are within `NEAR` of its centre, and how
 * that compares with the same count taken over every bay of the circuit. A ratio near 1
 * means the hole is covered exactly as well as ordinary curtain, which is to say not
 * deliberately at all.
 */
async function cover(seed) {
  const { page, errors } = await openPage(seed);
  await page.evaluate(KIT);
  const out = await page.evaluate(async () => {
    const { city, bays } = window.__fk;
    const g = window.__game;
    const ctx = g.engine.context;
    const b = g.battle;
    const flow = ctx.get('battleFlow');
    const garrison = flow.objective ? flow.objective.garrison : 0;
    const storm = flow.objective ? flow.objective.storm : 1;
    const p = b.pool;
    const NEAR = 60;

    // Static: how far is each footing from the nearest bay a man can be posted on?
    const stations = bays.filter((x) => x.garrisonable);
    const gapCover = bays.filter((x) => x.stage === 'footing').map((x) => {
      const mx = (x.x0 + x.x1) * 0.5, mz = (x.z0 + x.z1) * 0.5;
      let best = Infinity, bestBay = -1;
      for (const st of stations) {
        const d = Math.hypot((st.x0 + st.x1) * 0.5 - mx, (st.z0 + st.z1) * 0.5 - mz);
        if (d < best) { best = d; bestBay = st.index; }
      }
      return { bay: x.index, x: +mx.toFixed(0), nearestStation: bestBay, metres: +best.toFixed(0) };
    });

    const series = [];
    const near = (mx, mz, faction) => {
      let n = 0;
      for (let i = 0; i < p.count; i++) {
        if (p.faction[i] !== faction || !p.aliveAt(i)) continue;
        if (Math.hypot(p.x[i] - mx, p.z[i] - mz) <= NEAR) n++;
      }
      return n;
    };
    for (let t = 0; t < 600; t += 10) {
      g.engine.advance(10, 166);
      const row = { t: +ctx.time.simTime.toFixed(0), footings: [], allBays: 0 };
      for (const x of bays) {
        const mx = (x.x0 + x.x1) * 0.5, mz = (x.z0 + x.z1) * 0.5;
        const d = near(mx, mz, garrison);
        row.allBays += d;
        if (x.stage === 'footing') row.footings.push({ bay: x.index, defenders: d, attackers: near(mx, mz, storm) });
      }
      row.meanPerBay = +(row.allBays / bays.length).toFixed(1);
      series.push(row);
      if (flow.result) break;
    }
    void city;
    return { gapCover, series };
  });
  await page.close();
  return { seed, errors, ...out };
}

// ---------------------------------------------------------------------------
// battle — who actually crosses, where, and how long it takes
// ---------------------------------------------------------------------------
const BATTLE_KIT = `(() => {
window.__fkBattle = (() => {
  const { city, bays, lineAt, depthOf } = window.__fk;
  const ctx = window.__game.engine.context;
  const b = window.__game.battle;
  const flow = ctx.get('battleFlow');
  const storm = flow.objective ? flow.objective.storm : 1;
  const p = b.pool;
  const cap = p.capacity ?? p.x.length;
  /**
   * Has this man been definitely outside since he was last counted? A latch, not a memory
   * of the previous sample.
   *
   * **This was a differencing test and the differencing test was wrong**, in the one
   * direction that matters here. It counted a man only when *consecutive* one-second
   * samples went from depth > +2 to depth <= -2 — that is, only when he covered four
   * metres of curtain in a second. A galloping horse does; a horse crossing the same
   * ground four times slower does not. It sits at +1, then 0, then -1, and on the sample
   * where it finally passes -2 the previous depth is -1, which fails the test.
   *
   * So the instrument reported **zero crossings** for exactly the change that was supposed
   * to make crossings slower, and it reported it in two separate arms before its own
   * neighbours gave it away: the same runs counted 41-53 storm men inside the curtain and
   * showed every rider unit's centroid crossing at t+45. Nought and fifty-three cannot both
   * be true. A latch has no such blind spot at any speed.
   */
  const outside = new Uint8Array(cap);
  /** Sim time this slot was last seen at depth > +OUT, so a duration can be closed. */
  const outAt = new Float32Array(cap).fill(NaN);
  /** Crossings, keyed bay index -> { typeId -> {men, sumSecs, n} }. */
  const byBay = {};
  const byType = {};
  /** Man-seconds spent standing on the curtain's own footprint, by bay. */
  const dwell = {};
  /**
   * Thresholds, in metres of signed depth.
   *
   * A crossing is +2 to -2 across the curtain's own footprint, which is 6 m thick: the
   * generous +-10 the first draft used never fired once in a 559 s battle, because a man
   * who walks a footing bay does not necessarily continue 10 m into the pomerium — he
   * arrives, is shot at, and mills about on the line. OUT is where the duration clock
   * starts and is deliberately further out than IN is in.
   */
  const OUT = 15, IN = 2, START = 2;
  const wMin = Math.min(...bays.map((b) => b.x0));
  const wMax = Math.max(...bays.map((b) => b.x1));
  /**
   * Peak men counted "inside" broken down by where they got in.
   *
   * BattleFlow.censusWall clamps a man's x to the ends of the wall line before taking his
   * depth, so a storm soldier standing in open country 200 m *past* the east tower is
   * measured against the last bay's normal and scores as a break-in. Sixty of those win the
   * battle. Whether that is happening is a fact, and it is separated here from men who
   * actually got through masonry.
   */
  const insidePeak = { throughWall: 0, pastEast: 0, pastWest: 0 };
  /** Footprint each storm unit type would be routed at, for the record. */
  const footprints = {};

  const typeOf = (i) => {
    const u = b.unitById(p.unitId[i]);
    return u ? u.typeId : '?';
  };

  const sample = () => {
    const t = ctx.time.simTime;
    let inWall = 0, inEast = 0, inWest = 0;
    for (let i = 0; i < p.count; i++) {
      if (p.faction[i] !== storm || !p.aliveAt(i)) continue;
      const d = depthOf(p.x[i], p.z[i]);
      // A man the siege system is carrying — up a ladder, on a tower ramp, on the walk —
      // is not walking through a hole, and is excluded by construction.
      const carried = b.elevated[i] !== 0;
      if (!carried && d < -14) {
        if (p.x[i] > wMax) inEast++; else if (p.x[i] < wMin) inWest++; else inWall++;
      }
      if (!carried && Math.abs(d) <= 4) {
        const L = lineAt(p.x[i]);
        const k = L.bay;
        (dwell[k] ??= { stage: L.stage, manSecs: 0 }).manSecs += 1;
      }
      if (!carried && d > OUT) outAt[i] = t;
      if (!carried && d > START) outside[i] = 1;
      if (!carried && outside[i] === 1 && d <= -IN) {
        const L = lineAt(p.x[i]);
        const k = L.bay;
        const ty = typeOf(i);
        const rec = (byBay[k] ??= { stage: L.stage, men: 0, types: {} });
        rec.men++;
        rec.types[ty] = (rec.types[ty] ?? 0) + 1;
        const tr = (byType[ty] ??= { men: 0, sumSecs: 0, n: 0, bays: {}, firstAt: t });
        tr.men++;
        tr.bays[k] = (tr.bays[k] ?? 0) + 1;
        if (!Number.isNaN(outAt[i])) { tr.sumSecs += t - outAt[i]; tr.n++; }
        outside[i] = 0;
        continue;
      }
      // A man the siege system picks up has not walked anywhere: drop the latch so he
      // cannot be counted as having crossed when he is set down on the far side.
      if (carried) outside[i] = 0;
    }
    if (inWall > insidePeak.throughWall) insidePeak.throughWall = inWall;
    if (inEast > insidePeak.pastEast) insidePeak.pastEast = inEast;
    if (inWest > insidePeak.pastWest) insidePeak.pastWest = inWest;
  };

  /**
   * The same question asked of whole units, because that is what the owner watched.
   *
   * A unit has crossed when its living centroid goes from +15 m outside to -15 m inside
   * without the siege system carrying the majority of it. Per-man counting and per-unit
   * counting answer different things and both are wanted: one is "how many men came
   * through this hole", the other is "did that squadron of horse ride through the wall".
   */
  const unitState = new Map();
  const unitCross = [];
  const sampleUnits = () => {
    const t = ctx.time.simTime;
    for (const u of b.units) {
      if (u.faction !== storm || u.destroyed || u.alive === 0) continue;
      let sx = 0, sz = 0, n = 0, carried = 0;
      for (let i = 0; i < p.count; i++) {
        if (p.unitId[i] !== u.id || !p.aliveAt(i)) continue;
        sx += p.x[i]; sz += p.z[i]; n++;
        if (b.elevated[i] !== 0) carried++;
      }
      if (n === 0) continue;
      const cx = sx / n, cz = sz / n;
      const d = depthOf(cx, cz);
      const st = unitState.get(u.id) ?? { out: NaN, done: false };
      if (carried > n * 0.25) { st.out = NaN; unitState.set(u.id, st); continue; }
      if (d > 15) st.out = t;
      if (!st.done && d < -15 && !Number.isNaN(st.out)) {
        /*
         * Name the bay from the men, not from the centroid.
         *
         * A squadron half through a hole and half strung out along the curtain has a
         * centroid nowhere near the hole: the first draft of this reported bay 26, which is
         * finished masonry, for a crossing every one of whose men went through bay 28.
         * The median x of the men who are actually inside is the honest answer.
         */
        const inX = [];
        for (let i = 0; i < p.count; i++) {
          if (p.unitId[i] !== u.id || !p.aliveAt(i) || b.elevated[i] !== 0) continue;
          if (depthOf(p.x[i], p.z[i]) < 0) inX.push(p.x[i]);
        }
        inX.sort((a, c) => a - c);
        const mx = inX.length ? inX[inX.length >> 1] : cx;
        const L = lineAt(mx);
        unitCross.push({
          unitId: u.id, typeId: u.typeId, unitClass: b.typeOf(u).unitClass,
          bay: L.bay, stage: L.stage, x: +mx.toFixed(0), at: +t.toFixed(0),
          secs: +(t - st.out).toFixed(0), alive: u.alive, initial: u.initialStrength,
        });
        st.done = true;
      }
      unitState.set(u.id, st);
    }
  };

  /** Recorded once, at t=0: what radius each storm unit would be searched at. */
  const recordFootprints = () => {
    for (const u of b.units) {
      if (u.faction !== storm) continue;
      const def = b.typeOf(u);
      footprints[u.typeId] ??= {
        unitClass: def.unitClass,
        formation: u.formationId,
        strength: u.initialStrength,
      };
    }
  };
  recordFootprints();

  return {
    sample: () => { sample(); sampleUnits(); },
    byBay, byType, dwell, storm, insidePeak, footprints, unitCross,
    read: () => ({ byBay, byType, dwell, insidePeak, footprints, unitCross, wMin, wMax }),
  };
})();
})()
`;

async function battle(seed) {
  const { page, errors } = await openPage(seed);
  await page.evaluate(KIT);
  await page.evaluate(BATTLE_KIT);
  const setup = await page.evaluate(() => {
    const b = window.__game.battle;
    const flow = window.__game.engine.context.get('battleFlow');
    return {
      rngState: b.rng?.getState?.() ?? null,
      units: b.units.length,
      strength: { ...b.strength },
      storm: flow.objective?.storm ?? null,
      garrison: flow.objective?.garrison ?? null,
    };
  });
  const series = [];
  let result = null;
  const t0 = Date.now();
  for (let t = 0; t < UNTIL && result === null; t += 20) {
    const row = await page.evaluate(() => {
      const g = window.__game;
      const ctx = g.engine.context;
      const flow = ctx.get('battleFlow');
      // One sample a second, taken between advances, so a crossing cannot be stepped over.
      for (let s = 0; s < 20; s++) { g.engine.advance(1, 166); window.__fkBattle.sample(); }
      const o = flow.objective ?? {};
      const eng = g.battle.siege?.engineReport?.() ?? {};
      return {
        t: +ctx.time.simTime.toFixed(0),
        stormOnWall: o.stormOnWall ?? 0,
        garrisonOnWall: o.garrisonOnWall ?? 0,
        stormInside: o.stormInside ?? 0,
        laddersCrossed: eng.laddersCrossed ?? 0,
        strength: { ...g.battle.strength },
        result: flow.result,
      };
    });
    series.push(row);
    if (row.result) result = row.result;
  }
  const crossings = await page.evaluate(() => window.__fkBattle.read());
  await page.close();
  return { seed, setup, series, result, crossings, errors, wallMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const report = { map: MAP, quality: QUALITY };

if (want('census') || want('nav') || want('around') || want('routes') || want('dijkstra')) {
  const { page, errors } = await openPage(SEED0);
  await page.evaluate(KIT);
  if (want('census')) {
    report.census = await census(page);
    const c = report.census;
    console.log(`\n=== census — ${c.nBays} bays over x ${c.xRange[0]}..${c.xRange[1]} ===`);
    console.log(`stages: ${JSON.stringify(c.stages)}`);
    console.log(`obstacles published: ${c.obstacleCount} (${c.wallBoxes} of kind 'wall')`);
    console.log(`\nopen bands in blocksMovement (0.5 m sweep across the curtain):`);
    if (!c.bands.length) console.log('  none — the circuit is shut end to end');
    for (const b of c.bands) {
      console.log(`  x ${b.from.toFixed(0)} .. ${b.to.toFixed(0)}  (${b.width} m)  bay ${b.bay} [${b.stage}]`
        + `   navBlocked=${b.navShut}  box=${b.box ? `${b.box.kind}@${b.box.topY}` : 'none'}`);
    }
    console.log(`\nbays that are not 'finished', and what is standing on them:`);
    console.log('  bay  stage        x0      x1     gMin    gMax   over-ground  raster  nav   box topY');
    for (const r of c.rows) {
      if (r.stage === 'finished' && !r.isGate) continue;
      console.log(
        `  ${String(r.index).padStart(3)}  ${r.stage.padEnd(11)} ${String(r.x0).padStart(7)} ${String(r.x1).padStart(7)}`
        + ` ${String(r.gMin).padStart(7)} ${String(r.gMax).padStart(7)}`
        + `  ${String(r.minOverGround).padStart(5)}..${String(r.maxOverGround).padEnd(6)}`
        + ` ${String(r.rasterShut).padStart(6)} ${String(!r.navShut ? 'OPEN' : 'shut').padStart(5)}`
        + ` ${String(r.boxTopY ?? '-').padStart(8)}`,
      );
    }
    // Instrument cross-check: the three views must agree, or one of them is lying.
    const disagree = c.rows.filter((r) => r.rasterShut !== !!r.hasBox || r.rasterShut === r.navShut === false && r.hasBox);
    const seam = c.rows.filter((r) => r.rasterShut !== r.navShut);
    console.log(`\nseam check: ${seam.length} bay(s) where blocksMovement and NavGrid.blocked disagree`
      + `${seam.length ? `: ${seam.map((r) => `${r.index}(${r.stage}) raster=${r.rasterShut} nav=${r.navShut}`).join(', ')}` : ''}`);
    if (c.rough === null) {
      console.log('\nthe city publishes no getRoughGround(): nothing knows the footings are there');
    } else {
      console.log(`\ngetRoughGround(): ${c.rough.length} record(s) — standing work crossed at a price`);
      for (const r of c.rough) {
        console.log(`  bay ${String(r.bay).padStart(3)}  x ${String(r.x).padStart(7)}  ${r.hw * 2} x ${r.hd * 2} m`
          + `  rise ${r.rise} m  crest ${r.crestY}`);
      }
    }
    const noBox = c.rows.filter((r) => !r.hasBox);
    console.log(`bays with no oriented solid box at all: ${noBox.length}`
      + `${noBox.length ? ` — ${noBox.map((r) => `${r.index}[${r.stage}]`).join(', ')}` : ''}`);
    void disagree;
  }
  if (want('nav')) {
    report.nav = await navCost(page);
    const n = report.nav;
    console.log(`\n=== nav raster — ${n.res}x${n.res} at ${n.cell} m, ${n.stampedObstacles} boxes stamped ===`);
    console.log(`open field mean cost 300 m out: ${n.openFieldMeanCost}`);
    console.log('  site                     mean cost  summed  blocked cells of 5');
    for (const r of n.rows) {
      console.log(`  ${r.name.padEnd(24)} ${String(r.mean).padStart(9)} ${String(r.sum).padStart(7)} ${String(r.blocked).padStart(8)}`);
    }
    if (n.exampleTransect) {
      console.log(`\ntransect across bay ${n.exampleTransect.bay} (t is metres outward from the centreline):`);
      console.log('  ' + n.exampleTransect.samples.map((s) => `${s.t}:${s.cost}${s.blocked ? '*' : ''}`).join('  '));
    }
  }
  if (want('around')) {
    report.around = await around(page);
    const a = report.around;
    console.log(`\n=== around — the curtain runs x ${a.wMin} .. ${a.wMax} on a map ±${a.halfExtent} ===`);
    console.log(`east of the last tower there are ${(a.halfExtent - a.wMax).toFixed(0)} m of map;`
      + ` west of the first there are ${(a.wMin + a.halfExtent).toFixed(0)} m.`);
    console.log('\n  x       z    ground  rasterShut  navBlocked/cells  meanCost   deepBlocked/cells');
    for (const r of [...a.east.filter((_, i) => i % 2 === 0)]) {
      console.log(`  ${String(r.x).padStart(5)} ${String(r.z).padStart(5)} ${String(r.ground).padStart(7)}`
        + ` ${String(r.rasterShut).padStart(11)} ${String(`${r.navBlocked}/${r.cells}`).padStart(17)}`
        + ` ${String(r.meanCost).padStart(9)} ${String(`${r.deepBlocked}/${r.deepCells}`).padStart(19)}`);
    }
    console.log(`\n  first open crossing east of the wall: ${a.firstOpenEast ? `x ${a.firstOpenEast.x}` : 'none'}`);
    console.log(`  first open crossing west of the wall: ${a.firstOpenWest ? `x ${a.firstOpenWest.x}` : 'none'}`);
    console.log('\nwest end (every 20 m):');
    for (const r of a.west.filter((_, i) => i % 2 === 0).slice(0, 14)) {
      console.log(`  ${String(r.x).padStart(5)} ${String(r.z).padStart(5)} ${String(r.ground).padStart(7)}`
        + ` ${String(r.rasterShut).padStart(11)} ${String(`${r.navBlocked}/${r.cells}`).padStart(17)}`
        + ` ${String(r.meanCost).padStart(9)} ${String(`${r.deepBlocked}/${r.deepCells}`).padStart(19)}`);
    }
  }
  if (want('dijkstra')) {
    report.dijkstra = await dijkstra(page);
    const d = report.dijkstra;
    console.log(`\n=== uncapped least-cost entry, source (${d.source.x}, ${d.source.z}) ===`);
    for (const arm of d.arms) {
      console.log(`\nfootprint radius ${arm.radius} m`);
      console.log(`  deep objective 150 m inside at (${arm.deep.x}, ${arm.deep.z}): cost ${arm.deep.cost}`
        + `, entering at ${arm.deep.via ? `x ${arm.deep.via.x} — bay ${arm.deep.via.bay} [${arm.deep.via.stage}]` : 'nowhere'}`);
      const reach = arm.probes.filter((p) => p.cost !== null);
      const viaCount = new Map();
      for (const p of reach) {
        const k = p.via ? `bay ${p.via.bay} [${p.via.stage}]` : 'no crossing found';
        viaCount.set(k, (viaCount.get(k) ?? 0) + 1);
      }
      console.log(`  ${reach.length}/${arm.probes.length} points 60 m inside the curtain are reachable;`
        + ' the ways in they use:');
      for (const [k, v] of [...viaCount].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(3)}  ${k}`);
      const cheap = [...reach].sort((a, b) => a.cost - b.cost).slice(0, 6);
      console.log('  cheapest six interior points:  ' + cheap.map((p) => `bay ${p.bay}=${p.cost}`).join('  '));
    }
  }
  if (want('routes')) {
    report.routes = await routes(page);
    const R = report.routes;
    console.log('\n=== what the pathfinder returns for a route into the city ===');
    console.log(`goal (${R.goal.x}, ${R.goal.z}) blocked=${R.goal.blocked}; `
      + `searches ${R.stats.searches}, failures ${R.stats.failures}, capped ${R.stats.capped}, `
      + `straightLine ${R.stats.straightLine}, dropped ${R.stats.dropped}`);
    console.log('  from bay   start x    state    length   crosses at x   bay  stage');
    for (const r of R.rows) {
      const q = r.route;
      console.log(`  ${String(r.fromBay).padStart(8)} ${String(r.sx).padStart(9)}  ${String(q.state).padStart(7)}  `
        + (q.state === 'none' ? '' : `${String(q.length).padStart(8)} ${String(q.crossX ?? '-').padStart(14)} ${String(q.crossBay ?? '-').padStart(5)}  ${q.crossStage ?? '-'}`));
    }
  }
  if (errors.length) console.log(`\n!! ${errors.length} page error(s): ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
  else console.log('\nno page errors on the static page');
  await page.close();
}

if (want('bands')) {
  const { page, errors } = await openPage(SEED0);
  await page.evaluate(KIT);
  report.bands = await bands(page);
  const bd = report.bands;
  console.log('\n=== is bay 28 special, or merely nearest? ===');
  console.log(`the storm's horse starts at (${bd.horse ? bd.horse.x : '?'}, ${bd.horse ? bd.horse.z : '?'})`
    + ` — ${bd.horse ? bd.horse.typeId : '?'}, ${bd.horse ? bd.horse.alive : '?'} men`);
  console.log('  band   stage      x   navBlocked   cost   widest clear   m from horse   entry r=2.2   entry r=11');
  for (const r of bd.rows) {
    console.log(`  ${String(r.bay).padStart(4)}   ${String(r.stage).padEnd(9)} ${String(r.x).padStart(5)}`
      + ` ${String(r.navBlockedAtCentre).padStart(12)} ${String(r.costAtCentre).padStart(6)}`
      + ` ${String(r.bestClearance).padStart(14)} ${String(r.fromHorse).padStart(14)}`
      + ` ${String(r.entryCost22 === null ? 'unreachable' : r.entryCost22).padStart(13)}`
      + ` ${String(r.entryCost11 === null ? 'unreachable' : r.entryCost11).padStart(12)}`);
  }
  if (errors.length) console.log(`  !! ${errors.length} page error(s)`);
  await page.close();
}

if (want('cover')) {
  const c = await cover(SEED0);
  report.cover = c;
  console.log('\n=== does the garrison cover its own hole? ===');
  console.log('  footing bay   x   nearest garrisonable bay   metres away');
  for (const r of c.gapCover) {
    console.log(`  ${String(r.bay).padStart(11)} ${String(r.x).padStart(5)} ${String(r.nearestStation).padStart(26)} ${String(r.metres).padStart(13)}`);
  }
  console.log('\n  defenders within 60 m of each footing bay, against the mean over all 50 bays');
  console.log('     t   ' + c.gapCover.map((r) => `bay${String(r.bay).padStart(3)}`).join('  ') + '   meanPerBay   attackers on the footings');
  for (const row of c.series.filter((_, i) => i % 4 === 0)) {
    const atk = row.footings.reduce((a, f) => a + f.attackers, 0);
    console.log(`  ${String(row.t).padStart(4)}   `
      + row.footings.map((f) => String(f.defenders).padStart(6)).join('  ')
      + `   ${String(row.meanPerBay).padStart(10)}   ${String(atk).padStart(6)}`);
  }
  if (c.errors.length) console.log(`  !! ${c.errors.length} page error(s)`);
}

if (want('battle')) {
  const runs = [];
  for (let i = 0; i < SEEDS; i++) {
    const seed = (SEED0 + i * 0x9e3779b1) >>> 0;
    process.stdout.write(`  run ${i + 1}/${SEEDS} seed ${seed} …`);
    const r = await battle(seed);
    const total = Object.values(r.crossings.byBay).reduce((a, b) => a + b.men, 0);
    console.log(` ${r.result ? `${r.result.victor === 1 ? 'JUTHUNGI' : 'Rome'} by ${r.result.reason} at ${r.result.at.toFixed(0)}s` : 'undecided'}`
      + `  [${total} crossings]  (${(r.wallMs / 1000).toFixed(0)}s wall)`);
    runs.push(r);
  }
  report.runs = runs;

  console.log(`\n=== ${SEEDS} seed(s), cap ${UNTIL}s ===`);
  const outcomes = new Map();
  for (const r of runs) {
    const k = r.result ? `${r.result.victor === 1 ? 'Juthungi' : r.result.victor === 0 ? 'Rome' : r.result.victor} / ${r.result.reason}` : 'undecided';
    outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
  }
  console.log('outcomes');
  for (const [k, v] of [...outcomes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}/${SEEDS}  ${k}`);

  const bayAgg = new Map();
  const typeAgg = new Map();
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.crossings.byBay)) {
      const a = bayAgg.get(k) ?? { stage: v.stage, men: 0, types: {} };
      a.men += v.men;
      for (const [t, n] of Object.entries(v.types)) a.types[t] = (a.types[t] ?? 0) + n;
      bayAgg.set(k, a);
    }
    for (const [k, v] of Object.entries(r.crossings.byType)) {
      const a = typeAgg.get(k) ?? { men: 0, sumSecs: 0, n: 0 };
      a.men += v.men; a.sumSecs += v.sumSecs; a.n += v.n;
      typeAgg.set(k, a);
    }
  }
  console.log('\nmen who crossed the curtain on foot or hoof, by bay (ladders/towers/gate excluded)');
  console.log('  bay   stage        men   by unit type');
  for (const [k, v] of [...bayAgg].sort((a, b) => b[1].men - a[1].men)) {
    console.log(`  ${String(k).padStart(3)}   ${String(v.stage).padEnd(11)} ${String(v.men).padStart(5)}   `
      + Object.entries(v.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', '));
  }
  // The thresholds are OUT and IN in the kit above, and this line said 10 and 10 while
  // they were 15 and 2. A caption that does not match its own instrument is the cheapest
  // possible way to publish a wrong number, and this file has already done it once.
  console.log('\ncrossing time from 15 m out to 2 m in, by unit type');
  console.log('  type                     men   mean seconds');
  for (const [k, v] of [...typeAgg].sort((a, b) => b[1].men - a[1].men)) {
    console.log(`  ${k.padEnd(22)} ${String(v.men).padStart(7)}   ${v.n ? (v.sumSecs / v.n).toFixed(1) : '-'}`);
  }
  console.log('\nWHOLE UNITS that walked or rode through the curtain (centroid +15 m to -15 m, not carried)');
  /*
   * `bay`, `stage` and `x` are where this unit's men were **when its centroid finished
   * crossing**, which is not always where they came through: a squadron that enters at bay
   * 28 and turns west along the pomerium reads as bay 26 fifteen metres later. The per-man
   * table above is the one that answers "which hole", and it is also the stricter
   * instrument — it drops a man who was on a ladder at the previous sample, where this one
   * admits a unit that is up to a quarter carried.
   */
  console.log('  seed         at s   unit type              class          where it was  stage      x   secs  alive/initial');
  let anyUnit = false;
  for (const r of runs) {
    for (const c of r.crossings.unitCross) {
      anyUnit = true;
      console.log(`  ${String(r.seed).padStart(10)} ${String(c.at).padStart(6)}   ${c.typeId.padEnd(22)} ${String(c.unitClass).padEnd(15)} `
        + `${String(c.bay).padStart(3)}  ${String(c.stage).padEnd(9)} ${String(c.x).padStart(5)} ${String(c.secs).padStart(5)}   ${c.alive}/${c.initial}`);
    }
  }
  if (!anyUnit) console.log('  none');

  console.log('\npeak men counted inside, by where they got in');
  console.log('  seed        through the wall   past the EAST end   past the WEST end');
  for (const r of runs) {
    const ip = r.crossings.insidePeak;
    console.log(`  ${String(r.seed).padStart(10)} ${String(ip.throughWall).padStart(18)} ${String(ip.pastEast).padStart(19)} ${String(ip.pastWest).padStart(19)}`);
  }
  const dwellAgg = new Map();
  for (const r of runs) for (const [k, v] of Object.entries(r.crossings.dwell)) {
    const a = dwellAgg.get(k) ?? { stage: v.stage, manSecs: 0 };
    a.manSecs += v.manSecs; dwellAgg.set(k, a);
  }
  console.log('\nman-seconds spent within 4 m of the curtain centreline, by bay (top 10)');
  for (const [k, v] of [...dwellAgg].sort((a, b) => b[1].manSecs - a[1].manSecs).slice(0, 10)) {
    console.log(`  bay ${String(k).padStart(3)} [${v.stage}]  ${v.manSecs}`);
  }
  const allErrors = runs.flatMap((r) => r.errors);
  console.log(allErrors.length ? `\n!! ${allErrors.length} page error(s): ${[...new Set(allErrors)].slice(0, 5).join(' | ')}` : '\nno page errors in any run');
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 1));
  console.log(`wrote ${JSON_OUT}`);
}

await browser.close();
if (server) {
  server.kill('SIGTERM');
  console.log(`• killed vite pid ${server.pid}`);
}
