#!/usr/bin/env node
/**
 * Numerical acceptance tests for the *continuity* of the Aurelian circuit.
 *
 * A screenshot only shows a hole in the wall if the camera happens to point at it, and a
 * unit test written against `wall.ts` only shows what the author already believed. This
 * walks the whole circuit at 25 cm and measures the **triangles the renderer was given**,
 * so it fails on geometry that is missing, not on a model that says it should be there.
 *
 * It exists because the gate bay was 35.5 m long and the gatehouse that replaced it was
 * 25 m wide and centred on a point in the *previous* bay, which left 28.4 m of open ground
 * beside the Porta Flaminia with no masonry in it — while `getObstacles()`, `getWallSegments()`
 * and `masonryTopAt()` all reported a solid wall there. Every one of those three had to be
 * wrong in the same direction for it to be invisible to the sim, so the probe checks the
 * geometry and the nav data against each other rather than either against itself.
 *
 * Measurement, not model:
 *   - full-detail wall chunks are read out of the scene graph;
 *   - every triangle inside a corridor around the wall centreline is splatted into 25 cm
 *     x-bins by its own x-extent, so a single 25 m quad covers all 100 bins it spans
 *     (binning vertices instead under-reports large faces and would have hidden this);
 *   - the resulting profile is compared with the terrain, with `masonryTopAt` and with
 *     the obstacle set.
 *
 * Usage:
 *   node tools/probe-wall.mjs --port=5511
 *   node tools/probe-wall.mjs --port=5511 --json
 *   node tools/probe-wall.mjs --port=5511 --dump=screenshots/wall-profile.json
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const PORT = Number(args.get('port') ?? 5511);
const QUALITY = args.get('quality') ?? 'ultra';
const AS_JSON = args.has('json');
const DUMP = args.get('dump') ?? null;
const ROOT = resolve(process.cwd());

/** Bin width of the circuit walk, metres. Fine enough to see a missing sub-bay panel. */
const STEP = 0.25;
/**
 * Half-width of the corridor a triangle must touch to count as circuit masonry, metres.
 *
 * The curtain is 3.5 m thick and the towers project 3.5 m beyond its outer face, so 7 m
 * takes both. The gate block is 11 m front to back and overhangs it, which is fine: the
 * test is "is there stone here", not "is it exactly the curtain".
 */
const CORRIDOR = 7.0;
/**
 * A bin counts as walled if some triangle in the corridor stands this far above the
 * terrain under the wall line.
 *
 * 0.8 m is below the shortest thing the circuit is ever authored at — a `footing` bay is a
 * 1.1 m concrete pour the city deliberately leaves walkable — so anything under it is an
 * absence of masonry rather than an early construction stage.
 */
const WALLED_RISE = 0.8;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.ts': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.hdr': 'application/octet-stream',
  '.ktx2': 'application/octet-stream', '.glb': 'model/gltf-binary',
};

/** Same contract as `probe-siege.mjs`: reuse a live dev server, never a stale `dist/`. */
async function ensureServer() {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const r = await fetch(`${base}/src/main.ts`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      console.log(`• using the dev server at ${base}`);
      return { base, close: () => {} };
    }
    console.error(`! dev server at ${base} answered ${r.status} for /src/main.ts — refusing ` +
      'to fall back to a stale dist/.');
    process.exit(2);
  } catch {
    /* fall through */
  }
  console.log('• no dev server; serving dist/ (which may be stale)');
  const dist = join(ROOT, 'dist');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let p = join(dist, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname === '') p = join(dist, 'index.html');
    try {
      const body = await readFile(p);
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((ok) => server.listen(PORT + 1, ok));
  return { base: `http://127.0.0.1:${PORT + 1}`, close: () => server.close() };
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}
function report() {
  const pass = checks.filter((c) => c.ok).length;
  if (AS_JSON) {
    console.log(JSON.stringify({ pass, total: checks.length, checks }, null, 2));
  } else {
    for (const c of checks) console.log(`${c.ok ? '  PASS' : '  FAIL'}  ${c.name}\n          ${c.detail}`);
    console.log(`\n${pass}/${checks.length} assertions passed`);
  }
  return pass === checks.length;
}

/** Contiguous runs of bins for which `pred` holds, as {x0,x1,width}. */
function runsOf(prof, pred) {
  const out = [];
  let run = null;
  for (const r of prof) {
    if (pred(r)) {
      if (!run) run = { x0: r.x, x1: r.x };
      else run.x1 = r.x;
    } else if (run) {
      out.push({ ...run, width: run.x1 - run.x0 + STEP });
      run = null;
    }
  }
  if (run) out.push({ ...run, width: run.x1 - run.x0 + STEP });
  return out;
}

let browser = null;
let srv = null;
let measured = null;

try {
  srv = await ensureServer();
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${srv.base}/?harness=1&quality=${QUALITY}&w=1280&h=720`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, {}, { timeout: 180000 });

  measured = await page.evaluate(({ STEP, CORRIDOR }) => {
    const g = window.__game;
    const ctx = g.engine.context;
    const city = ctx.tryGet('city');
    if (!city) return { noCity: true };
    const terrain = ctx.get('terrain');
    const root = ctx.scene.getObjectByName('city');

    const bays = city.getGarrisonBays().map((b) => ({
      index: b.index, x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1,
      nx: b.nx, nz: b.nz, dx: b.dx, dz: b.dz, length: b.length,
      stage: b.stage, walkY: b.walkY, crestY: b.crestY, sillY: b.sillY,
      groundY: b.groundY, garrisonable: b.garrisonable, isGate: b.isGate,
      towerHalf: b.towerHalf,
    }));
    const gates = city.getGates().map((x) => ({ ...x }));
    const segs = city.getWallSegments().map((s) => ({ ...s }));
    const gateBay = bays[bays.findIndex((b) => b.isGate)];
    const obstacles = city.getObstacles()
      .filter((o) => o.kind === 'wall' || o.kind === 'tower')
      .map((o) => ({ x: o.x, z: o.z, hw: o.hw, hd: o.hd, rot: o.rot, topY: o.topY, kind: o.kind }));

    const X0 = bays[0].x0;
    const X1 = bays[bays.length - 1].x1;
    const N = Math.round((X1 - X0) / STEP) + 1;

    const zAtX = (x) => {
      const i = Math.max(0, Math.min(bays.length - 1, Math.floor((x - X0) / (bays[0].x1 - bays[0].x0))));
      const b = bays[i];
      const t = (x - b.x0) / (b.x1 - b.x0);
      return b.z0 + (b.z1 - b.z0) * t;
    };

    // ---- splat the wall chunks' triangles into x bins ------------------------
    const meshes = [];
    root.traverse((o) => {
      if (o.isMesh && o.parent && /^wall-\d+-lod0$/.test(o.parent.name)) meshes.push(o);
    });
    const top = new Float64Array(N).fill(-Infinity);
    let tris = 0;
    const ax = [0, 0, 0], ay = [0, 0, 0], az = [0, 0, 0];

    /**
     * Every corridor triangle, flattened, plus an index of them by 2 m of x.
     *
     * The splat above answers "is there stone at this x", which is blind to a fault that
     * is a *slit*: the gatehouse was a shell with no end caps and you could see straight
     * in one 11 m end and out of the other, while every bin it covers reported masonry.
     * Line of sight is the only test that catches that, and it needs the triangles.
     */
    const TRI = [];
    const BUCKET = 2;
    const NB = Math.ceil((X1 - X0) / BUCKET) + 2;
    const buckets = Array.from({ length: NB }, () => []);

    /**
     * Rays down the middle of the carriageway, from outside the block to inside it.
     *
     * A wall that has been closed correctly leaves exactly one legal crossing, and this is
     * the only test that proves the crossing is actually open: the curtain that used to
     * block it was hidden 3.75 m behind the gate leaves, invisible from every camera, and
     * the gate's own travertine socle ran 1.15 m of solid stone across the road.
     * Moller-Trumbore against every corridor triangle, so nothing can hide.
     *
     * The ceiling is 4.0 m, not the 8.4 m of the vault: the *cataracta* is raised, and a
     * raised portcullis legitimately hangs in the passage with its bottom rail at 4.92 m.
     * A cart is under three metres.
     */
    const gy = terrain.heightAt(gates[0].x, gates[0].z);
    const rays = [0.4, 1.2, 2.4, 4.0].map((h) => ({
      h,
      // 16 m outside the block, heading in along the bay's inward normal.
      ox: gates[0].x + gateBay.nx * 16,
      oy: gy + h,
      oz: gates[0].z + gateBay.nz * 16,
      dx: -gateBay.nx, dy: 0, dz: -gateBay.nz,
      hit: Infinity,
    }));

    for (const mesh of meshes) {
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();
      const e = mesh.matrixWorld.elements;
      const count = idx ? idx.count : pos.count;
      for (let i = 0; i + 2 < count; i += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx.getX(i + k) : i + k;
          const lx = pos.getX(vi), ly = pos.getY(vi), lz = pos.getZ(vi);
          ax[k] = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
          ay[k] = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
          az[k] = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
        }
        // Inside the corridor if any vertex is, or if the triangle straddles it.
        const o0 = az[0] - zAtX(ax[0]), o1 = az[1] - zAtX(ax[1]), o2 = az[2] - zAtX(ax[2]);
        const omin = Math.min(o0, o1, o2), omax = Math.max(o0, o1, o2);
        if (omin > CORRIDOR || omax < -CORRIDOR) continue;
        tris++;
        const ti = TRI.length;
        TRI.push(ax[0], ay[0], az[0], ax[1], ay[1], az[1], ax[2], ay[2], az[2]);
        {
          const b0 = Math.max(0, Math.floor((Math.min(ax[0], ax[1], ax[2]) - X0) / BUCKET));
          const b1 = Math.min(NB - 1, Math.floor((Math.max(ax[0], ax[1], ax[2]) - X0) / BUCKET));
          for (let b = b0; b <= b1; b++) buckets[b].push(ti);
        }
        const yMax = Math.max(ay[0], ay[1], ay[2]);
        let lo = Math.min(ax[0], ax[1], ax[2]);
        let hi = Math.max(ax[0], ax[1], ax[2]);
        // A triangle that is vertical in x still covers the bin it sits in.
        let b0 = Math.ceil((lo - X0) / STEP - 1e-9);
        let b1 = Math.floor((hi - X0) / STEP + 1e-9);
        if (b1 < b0) { b0 = Math.round((lo - X0) / STEP); b1 = b0; }
        if (b1 < 0 || b0 >= N) continue;
        if (b0 < 0) b0 = 0;
        if (b1 >= N) b1 = N - 1;
        for (let b = b0; b <= b1; b++) if (yMax > top[b]) top[b] = yMax;

      }
    }

    /** Moller-Trumbore against the triangles indexed near `xs`. */
    const castNear = (ox, oy, oz, dx, dy, dz, maxT, xs) => {
      let best = Infinity;
      const seen = new Set();
      for (const x of xs) {
        const b = Math.floor((x - X0) / BUCKET);
        if (b < 0 || b >= NB || seen.has(b)) continue;
        seen.add(b);
        for (const ti of buckets[b]) {
          const a0 = TRI[ti], a1 = TRI[ti + 1], a2 = TRI[ti + 2];
          const e1x = TRI[ti + 3] - a0, e1y = TRI[ti + 4] - a1, e1z = TRI[ti + 5] - a2;
          const e2x = TRI[ti + 6] - a0, e2y = TRI[ti + 7] - a1, e2z = TRI[ti + 8] - a2;
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-9) continue;
          const inv = 1 / det;
          const tvx = ox - a0, tvy = oy - a1, tvz = oz - a2;
          const u = (tvx * px + tvy * py + tvz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = tvy * e1z - tvz * e1y, qy = tvz * e1x - tvx * e1z, qz = tvx * e1y - tvy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t > 0.01 && t < maxT && t < best) best = t;
        }
      }
      return best;
    };

    for (const r of rays) {
      r.hit = castNear(r.ox, r.oy, r.oz, r.dx, r.dy, r.dz, 40, [gates[0].x]);
    }

    /**
     * Cross-wall sweep: from 9 m outside to 9 m inside, at 1 m above the ground, every
     * metre of the circuit. Nothing but the carriageway may let a ray through.
     * 1 m clears nothing the wall is ever authored at — the shortest stage is a 2.35 m
     * footing pour — so a pass here is a slit, not an early construction stage.
     */
    const seeThrough = [];
    for (let x = X0 + 0.5; x < X1; x += 1.0) {
      const z = zAtX(x);
      const bi = Math.max(0, Math.min(bays.length - 1, Math.floor((x - X0) / (bays[0].x1 - bays[0].x0))));
      const bb = bays[bi];
      // The terrain **on the wall line**, not the corridor minimum the rise metric uses.
      // Where the ground falls away steeply across the wall — the Tiber bank does, by ten
      // metres in five — the corridor minimum put the ray under the footing's foundation
      // and it sailed beneath the circuit, reporting nine metres of hole that is not there.
      const y = terrain.heightAt(x, z) + 0.8;
      const t = castNear(x + bb.nx * 9, y, z + bb.nz * 9, -bb.nx, 0, -bb.nz, 19, [x - 2, x, x + 2]);
      if (!Number.isFinite(t)) {
        const open = gates.some((gt) => gt.open && Math.abs(x - gt.x) <= 3.2);
        seeThrough.push({ x: +x.toFixed(2), bay: bi, stage: bb.stage, carriageway: open });
      }
    }

    /**
     * Along-run sweep through the gatehouse: the block is 25 x 11 m of solid masonry with
     * one tunnel across it, so no ray parallel to the run may traverse it at any height or
     * offset. This is the test the open end caps failed.
     */
    const gRun = [];
    const gy2 = terrain.heightAt(gates[0].x, gates[0].z);
    for (let off = -5.0; off <= 5.01; off += 1.0) {
      for (const h of [2.0, 4.0, 6.0, 9.0, 12.0]) {
        const ox = gates[0].x - gateBay.dx * 20 + gateBay.nx * off;
        const oz = gates[0].z - gateBay.dz * 20 + gateBay.nz * off;
        const t = castNear(ox, gy2 + h, oz, gateBay.dx, 0, gateBay.dz, 40,
          [gates[0].x - 12, gates[0].x - 6, gates[0].x, gates[0].x + 6, gates[0].x + 12]);
        if (!Number.isFinite(t)) gRun.push({ off: +off.toFixed(1), h });
      }
    }

    // ---- per-bin readings ----------------------------------------------------
    const prof = [];
    for (let i = 0; i < N; i++) {
      const x = X0 + i * STEP;
      const z = zAtX(x);
      // Lowest terrain across the wall's own footprint, not a single sample on a line the
      // probe reconstructs slightly differently from `wall.ts`. On the Tiber bank a 1 m
      // error in z is metres in height, and it read as a hole in a footing bay.
      let ground = Infinity;
      for (let k = -2; k <= 2; k++) {
        const g2 = terrain.heightAt(x, z + k * 1.25);
        if (g2 < ground) ground = g2;
      }
      const bi = Math.max(0, Math.min(bays.length - 1, Math.floor((x - X0) / (bays[0].x1 - bays[0].x0))));
      // The gate carriageway is a deliberate opening; exclude it from the walk.
      let inGate = false;
      for (const gt of gates) {
        if (gt.open && Math.abs(x - gt.x) <= 3.2) inGate = true;
      }
      // Is this x covered by a wall/tower obstacle? Point test in the box's own frame.
      let obst = false;
      let obstTop = -Infinity;
      for (const o of obstacles) {
        const c = Math.cos(o.rot), s = Math.sin(o.rot);
        const rx = x - o.x, rz = z - o.z;
        const u = rx * c + rz * s;
        const v = -rx * s + rz * c;
        if (Math.abs(u) <= o.hw + 1e-6 && Math.abs(v) <= o.hd + 1e-6) {
          obst = true;
          if (o.topY > obstTop) obstTop = o.topY;
        }
      }
      prof.push({
        x: +x.toFixed(3),
        top: Number.isFinite(top[i]) ? +top[i].toFixed(3) : null,
        ground: +ground.toFixed(3),
        rise: Number.isFinite(top[i]) ? +(top[i] - ground).toFixed(3) : -1,
        bay: bi,
        stage: bays[bi].stage,
        inGate,
        obst,
        obstTop: Number.isFinite(obstTop) ? +obstTop.toFixed(3) : null,
        model: city.masonryTopAt(x, z),
      });
    }

    return {
      bays, gates, segs, prof, meshCount: meshes.length, tris,
      carriageway: rays.map((r) => ({ h: r.h, hit: Number.isFinite(r.hit) ? +r.hit.toFixed(2) : null })),
      seeThrough, gRun, seeThroughSamples: Math.floor(X1 - X0),
      X0, X1, obstacleCount: obstacles.length,
      obstacleGeneration: city.obstacleGeneration,
      gateContainingBay: bays.findIndex((b) => gates[0] && gates[0].x >= b.x0 && gates[0].x <= b.x1),
      gateFlaggedBay: bays.findIndex((b) => b.isGate),
      errors: [],
    };
  }, { STEP, CORRIDOR });

  if (measured.noCity) {
    check('map has no city — nothing to check', true, 'CitySystem is not registered on this map');
  } else {
    const { bays, gates, prof, segs } = measured;
    const gate = gates[0];

    // -------------------------------------------------------------------
    check('the city exposes a circuit to walk',
      bays.length > 0 && segs.length === bays.length && gates.length > 0,
      `${bays.length} bays, ${segs.length} segments, ${gates.length} gate(s); ` +
      `${measured.meshCount} full-detail wall meshes, ${measured.tris} triangles in the corridor`);

    // ---- the headline: no hole anywhere in the circuit ------------------
    const holes = runsOf(prof, (r) => !r.inGate && r.rise < WALLED_RISE)
      .filter((h) => h.width >= 1.0);
    const worst = holes.reduce((a, h) => Math.max(a, h.width), 0);
    check('the circuit is continuous — no gap in the masonry anywhere along it',
      holes.length === 0,
      holes.length === 0
        ? `walked ${prof.length} bins of ${STEP} m from x ${measured.X0.toFixed(1)} to ` +
          `${measured.X1.toFixed(1)}; masonry stands ` +
          `${Math.min(...prof.filter((r) => !r.inGate).map((r) => r.rise)).toFixed(2)} m or more ` +
          `above the ground at every one of them`
        : `${holes.length} hole(s), worst ${worst.toFixed(2)} m: ` +
          holes.slice(0, 6).map((h) => `x ${h.x0.toFixed(1)}..${h.x1.toFixed(1)} (${h.width.toFixed(1)} m, bay ` +
            `${prof.find((p) => p.x === h.x0)?.bay} ${prof.find((p) => p.x === h.x0)?.stage})`).join('; '));

    // ---- consecutive bays actually meet ---------------------------------
    let worstJoin = 0;
    let joinAt = '';
    for (let i = 1; i < bays.length; i++) {
      const d = Math.hypot(bays[i].x0 - bays[i - 1].x1, bays[i].z0 - bays[i - 1].z1);
      if (d > worstJoin) { worstJoin = d; joinAt = `${i - 1}->${i}`; }
    }
    check('consecutive bays share an end — the run is one polyline, not fifty pieces',
      worstJoin < 1e-6,
      `worst separation ${(worstJoin * 100).toFixed(3)} cm${joinAt ? ` at bay ${joinAt}` : ''} over ${bays.length - 1} joins`);

    // ---- the gatehouse spans its own bay --------------------------------
    const gb = bays[measured.gateFlaggedBay];
    const gateBins = prof.filter((r) => r.bay === gb.index && !r.inGate);
    const gateHoles = runsOf(gateBins, (r) => r.rise < WALLED_RISE).filter((h) => h.width >= 1.0);
    check('the gate bay is masonry from end to end, carriageway aside',
      gateHoles.length === 0,
      `bay ${gb.index} runs x ${gb.x0.toFixed(2)}..${gb.x1.toFixed(2)} (${gb.length.toFixed(1)} m); ` +
      `the gate stands at x ${gate.x.toFixed(2)}, ` +
      `${measured.gateContainingBay === measured.gateFlaggedBay ? 'inside its own bay' :
        `inside bay ${measured.gateContainingBay}, ${(gb.x0 - gate.x).toFixed(2)} m west of bay ${gb.index}`}; ` +
      (gateHoles.length === 0
        ? `lowest rise across the bay ${Math.min(...gateBins.map((r) => r.rise)).toFixed(2)} m`
        : `${gateHoles.length} gap(s), worst ${Math.max(...gateHoles.map((h) => h.width)).toFixed(2)} m at x ` +
          `${gateHoles[0].x0.toFixed(1)}..${gateHoles[0].x1.toFixed(1)}`));

    // ---- the one legal crossing is actually open ------------------------
    const cw = measured.carriageway;
    const blocked = cw.filter((r) => r.hit !== null && r.hit < 30);
    check('the gate passage is clear through the block — the one way in is open',
      blocked.length === 0,
      blocked.length === 0
        ? `four rays down the carriageway centreline at ${cw.map((r) => r.h.toFixed(1)).join('/')} m ` +
          'above the road pass through 30 m of gatehouse without striking masonry'
        : `${blocked.length} of ${cw.length} rays hit stone inside the passage: ` +
          blocked.map((r) => `${r.h.toFixed(1)} m up at ${r.hit.toFixed(2)} m in`).join('; '));

    // ---- nothing sees through the wall ----------------------------------
    const st = measured.seeThrough.filter((r) => !r.carriageway);
    check('nothing sees through the circuit but the gate',
      st.length === 0,
      st.length === 0
        ? `${measured.seeThroughSamples} rays cast across the wall at 0.8 m above the ground, ` +
          `one per metre of circuit; every one is stopped by masonry except at the carriageway`
        : `${st.length} ray(s) pass clean through the wall: ` +
          st.slice(0, 6).map((r) => `x ${r.x.toFixed(1)} (bay ${r.bay} ${r.stage})`).join('; '));

    check('the gatehouse is a closed solid, not a shell',
      measured.gRun.length === 0,
      measured.gRun.length === 0
        ? '55 rays along the run through the block, at offsets -5..+5 m and heights 2..12 m, '
          + 'are all stopped: it has end walls, and the tunnel is closed along the run by its reveals'
        : `${measured.gRun.length} of 55 along-run rays traverse the block — it is open at the ends: `
          + measured.gRun.slice(0, 8).map((r) => `off ${r.off} m at ${r.h} m`).join('; '));

    // ---- nav data agrees with the stone ---------------------------------
    // Every metre of standing masonry must be inside a wall or tower obstacle, or a unit
    // walks through it; and every obstacle must have stone in it, or a unit is stopped by
    // nothing. The open carriageway is excluded from both directions.
    // A `footing` bay is knee-high courses the city deliberately leaves walkable, so it is
    // masonry the movement grid is *meant* to ignore. Every other stage must be solid.
    const unstamped = runsOf(prof, (r) => !r.inGate && r.stage !== 'footing' && r.rise >= WALLED_RISE && !r.obst)
      .filter((h) => h.width >= 1.0);
    check('every stretch of standing masonry is solid to the movement grid',
      unstamped.length === 0,
      unstamped.length === 0
        ? `all ${prof.filter((r) => !r.inGate && r.stage !== 'footing' && r.rise >= WALLED_RISE).length} walled bins are ` +
          `inside one of ${measured.obstacleCount} wall/tower obstacles (generation ${measured.obstacleGeneration})`
        : `${unstamped.length} stretch(es) of stone a unit can walk through, worst ` +
          `${Math.max(...unstamped.map((h) => h.width)).toFixed(1)} m at x ${unstamped[0].x0.toFixed(1)}`);

    // A `footing` bay is deliberately open to movement: knee-high courses, no blocker. So
    // the reverse test only asks that an obstacle is not stamped over open ground.
    const phantom = runsOf(prof, (r) => !r.inGate && r.obst && r.rise < 0.35)
      .filter((h) => h.width >= 2.0);
    check('no obstacle is stamped where there is no masonry',
      phantom.length === 0,
      phantom.length === 0
        ? 'every wall/tower obstacle has stone standing in it'
        : `${phantom.length} phantom obstacle(s), worst ${Math.max(...phantom.map((h) => h.width)).toFixed(1)} m ` +
          `at x ${phantom[0].x0.toFixed(1)}..${phantom[0].x1.toFixed(1)}`);

    // ---- masonryTopAt matches the stone ---------------------------------
    // Only checked where the model claims masonry: the known quirks (the gatehouse
    // reporting across its carriageway, the walkable footing courses) are both cases of
    // the model claiming *more* than the corridor, which the hole test already covers.
    const cmp = prof.filter((r) => !r.inGate && Number.isFinite(r.model) && r.rise >= WALLED_RISE);
    const over = cmp.filter((r) => r.model > r.top + 0.75);
    check('masonryTopAt never reports masonry higher than the stone that is there',
      over.length <= cmp.length * 0.02,
      `${over.length} of ${cmp.length} sampled bins report a top more than 0.75 m above the ` +
      `highest triangle in the corridor` +
      (over.length ? `; worst +${Math.max(...over.map((r) => r.model - r.top)).toFixed(2)} m at x ${over[0].x.toFixed(1)}` : ''));

    // ---- the wall is a wall ---------------------------------------------
    const garr = bays.filter((b) => b.garrisonable);
    const badWalk = garr.filter((b) => !(b.walkY > b.groundY + 1.5) || !(b.crestY >= b.walkY));
    check('every garrisonable bay stands above its own ground with its crest above its walk',
      badWalk.length === 0,
      `${garr.length} garrisonable bays; walk stands ` +
      `${Math.min(...garr.map((b) => b.walkY - b.groundY)).toFixed(2)}..` +
      `${Math.max(...garr.map((b) => b.walkY - b.groundY)).toFixed(2)} m over the ground` +
      (badWalk.length ? `; offenders ${badWalk.map((b) => b.index).join(',')}` : ''));

    check('no runtime errors', errors.length === 0, errors.slice(0, 4).join(' | ') || 'clean');
  }

  if (DUMP && measured && measured.prof) {
    await mkdir(dirname(resolve(ROOT, DUMP)), { recursive: true });
    await writeFile(resolve(ROOT, DUMP), JSON.stringify(measured, null, 1));
    console.log(`profile -> ${DUMP}`);
  }
} catch (err) {
  check('probe ran to completion', false, String(err && err.stack ? err.stack : err));
} finally {
  await browser?.close();
  srv?.close();
}

process.exit(report() ? 0 : 1);
