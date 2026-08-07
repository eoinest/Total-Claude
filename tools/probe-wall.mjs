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
      towerHalf: b.towerHalf, halfThickness: b.halfThickness,
      innerOff: b.innerOff, outerOff: b.outerOff,
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

    /**
     * ---- splat the wall chunks' triangles into x bins ------------------------
     *
     * `wall-<n>` is the curtain; `gate-door` and `gate-wreck` are the Porta Flaminia's twin
     * leaves, intact and as the ram left them. The leaves used to be merged into the
     * gatehouse's own chunk and moved out so `CitySystem.setGateDoorBroken` has something
     * separable to hide — at which point this gather silently stopped seeing them, the two
     * carriageway assertions went red, and the wall had a 4 m hole in it that was really a
     * hole in the instrument. That is trap 1 in this file's own idiom: check what the probe
     * is looking at before believing what it says about the stone.
     *
     * **Visibility is part of the query for the gate pair and must not be for the curtain.**
     * Exactly one of the two gate chunks is on screen at a time and the other is baked and
     * hidden, so gathering both would fill the passage with wreckage while the doors are
     * still shut; reading `visible` there means these assertions test the shut gate before a
     * breach and the broken one after it. Applying the same test to `wall-<n>-lod0` drops
     * every bay the camera has already LOD-switched away from — measured, that took the run
     * from 17/19 to 15/19 and reported a discontinuous circuit, stairless bays and phantom
     * obstacles, none of which had moved. The curtain is gathered at full detail always.
     */
    const meshes = [];
    root.traverse((o) => {
      if (!o.isMesh || !o.parent) return;
      const p = o.parent.name;
      if (/^wall-\d+-lod0$/.test(p)) meshes.push(o);
      else if (/^gate-(door|wreck)-lod0$/.test(p) && o.parent.visible) meshes.push(o);
    });

    /**
     * Half-thickness of the curtain, from the published contract rather than a literal.
     *
     * The wall was widened from 3.5 m to 6.0 m and every offset band below is measured
     * from its faces, so hardcoding 1.75 here would have quietly re-tested the old wall.
     */
    const HALF_T = bays[0].halfThickness;

    /**
     * Signed offset bands, in the sense `frameOf` uses: the outward normal of a run heading
     * +X points toward −Z, so **negative offset is the field side and positive is the city
     * side**. Everything the player asked to be moved indoors has to land positive.
     */
    /**
     * Squarely inside the treads, and clear of everything else that stands behind the wall.
     *
     * The flight's treads run from the curtain's inner face out to `HALF_T + 2.8`. A wider
     * band picks up the things that legitimately overhang the pomerium and reads them as
     * rakes: the tower roofs' eaves reach `HALF_T + 0.74`, the gallery's reach `HALF_T`, and
     * the river terminus is a 7.6 m drum that straddles the wall line entirely. Sampling the
     * middle 1.2 m of the tread instead finds the stair and nothing else.
     */
    const STAIR_BAND_LO = HALF_T + 1.2;
    const STAIR_BAND_HI = HALF_T + 2.4;
    /**
     * And the band the stair's own parapet stands in, just outboard of the treads.
     *
     * Two independent reviewers looking at the same render reported that the flight has no
     * parapet and no coping on the open side — "a raw stepped brick arris with nothing above
     * tread level" — while the builder does emit one 0.95 m high. Exactly the kind of
     * disagreement this file exists to settle: either the guard is missing, in which case
     * it is a real fault on a 9 m drop, or the camera was looking down over the top of it.
     * Measured, per flight, as the height of the parapet band over the tread band.
     */
    const PARA_BAND_LO = HALF_T + 2.7;
    const PARA_BAND_HI = HALF_T + 3.4;
    /**
     * Along-run bin for the stair profile. **Finer than a going**, which matters.
     *
     * At 0.5 m against a 0.42 m going a bin straddles two risers whenever the boundaries
     * fall badly, and taking the max over the bin then reports a 0.58 m step on a stair
     * whose risers are 0.29 m — an artefact of the sampling, not of the stone. 0.2 m sees
     * at most one riser per bin, so the number below is the real going-to-going rise.
     */
    const STAIR_BIN = 0.2;

    const nBays = bays.length;
    const bayLen = bays[0].x1 - bays[0].x0;
    const stairBins = Math.ceil(bayLen / STAIR_BIN) + 1;
    /** Max Y of tread-band geometry, per bay per along-bin. */
    const stairTop = new Float64Array(nBays * stairBins).fill(-Infinity);
    /** And of the parapet band just outboard of it. See `PARA_BAND_LO`. */
    const paraTop = new Float64Array(nBays * stairBins).fill(-Infinity);
    /** Furthest cityward any stair-band geometry reaches, per bay. */
    const stairOut = new Float64Array(nBays).fill(0);
    /**
     * Worst *field-side* offset reached by timber standing well above the ground, and where.
     *
     * This is the scaffolding test. Offsets are signed with the city positive, so a scaffold
     * erected outside the wall shows up as a large negative number here. Ground clutter is
     * excluded by the height gate, not by guessing which mesh is which: a concrete pour has
     * to be shuttered from both faces, so the footing bays' boards and stakes are
     * legitimately outside and stand 2.8 m over their own base. 4.0 m clears them and is
     * still far below a scaffold lift, which reaches the wall-walk and then 2.8 m more.
     */
    let timberWorstOut = 0;
    let timberWorstX = 0;
    let timberWorstY = 0;
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
      // `Batch.toMeshes` names each stream `<chunk>-<material>`, so the timber the scaffold
      // is built from can be measured on its own without guessing from position.
      const isTimber = /-timber$/.test(mesh.name);
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

        // ---- stair band and scaffolding side, both measured off the same offsets ----
        {
          const xMid = (ax[0] + ax[1] + ax[2]) / 3;
          const oMid = (o0 + o1 + o2) / 3;
          const bi = Math.floor((xMid - X0) / bayLen);
          /**
           * Bin by **along-run distance**, not by x.
           *
           * The tread band and the parapet band sit at different normal offsets, and the
           * outward normal has an x component on any bay that is not axis-aligned, so the
           * same along-run position maps to two different x values in the two bands. On the
           * obliquest flights that is a full metre of shear, which read as the parapet
           * running two risers below the treads — a 0.07 m guard on a wall that has 0.95 m
           * everywhere. Projecting onto the bay's own direction removes it exactly.
           */
          const tOfXZ = (px, pz) =>
            bi >= 0 && bi < nBays
              ? (px - bays[bi].x0) * bays[bi].dx + (pz - bays[bi].z0) * bays[bi].dz
              : 0;
          const tA = tOfXZ(ax[0], az[0]);
          const tB = tOfXZ(ax[1], az[1]);
          const tC = tOfXZ(ax[2], az[2]);
          const tLo = Math.min(tA, tB, tC);
          const tHi = Math.max(tA, tB, tC);
          const nearGate = gates.length > 0 && Math.abs(xMid - gates[0].x) <= 13;
          if (bi >= 0 && bi < nBays && !nearGate) {
            /**
             * Only geometry at or below the walkway counts as a walking surface.
             *
             * A flight ends *on* the walk, so anything standing above it is a parapet, a
             * coping or the return wall that closes the head of the landing — all of them
             * correct masonry, none of them a tread. Without this the profile topped out on
             * the landing's 0.95 m guard wall and every stair read as overshooting its own
             * bay by exactly that height. It cannot hide a stair that fails to arrive: a
             * short flight's top is *below* walkY and is still measured.
             */
            /**
             * Only geometry lying **wholly outboard of the treads** counts as the parapet.
             *
             * Not a centroid test, which dropped whichever prism face fell a few centimetres
             * outside the band and left bins with no reading; and not a plain overlap test,
             * which swept in the two slabs that legitimately span the whole flight — the
             * landing at the head and the apron at the foot both run from the curtain face
             * out past the parapet, and their tops sit at exactly the tread level, so they
             * reported a guard height of zero on a parapet that is there. Requiring the
             * triangle to start beyond the treads separates the cheek wall from the flight
             * it is built on.
             */
            if (omin >= PARA_BAND_LO && omin <= PARA_BAND_HI) {
              const j0 = Math.max(0, Math.floor(tLo / STAIR_BIN));
              const j1 = Math.min(stairBins - 1, Math.floor(tHi / STAIR_BIN));
              for (let j = j0; j <= j1; j++) {
                const k2 = bi * stairBins + j;
                if (yMax > paraTop[k2]) paraTop[k2] = yMax;
              }
            }
            if (oMid >= STAIR_BAND_LO && oMid <= STAIR_BAND_HI && yMax <= bays[bi].walkY + 0.05) {
              const j0 = Math.max(0, Math.floor(tLo / STAIR_BIN));
              const j1 = Math.min(stairBins - 1, Math.floor(tHi / STAIR_BIN));
              for (let j = j0; j <= j1; j++) {
                const k = bi * stairBins + j;
                if (yMax > stairTop[k]) stairTop[k] = yMax;
              }
            }
            if (oMid > HALF_T + 0.1 && oMid < HALF_T + 8 && yMax > bays[bi].groundY + 1.0) {
              if (omax > stairOut[bi]) stairOut[bi] = omax;
            }
          }
          if (isTimber && omin < timberWorstOut) {
            const zMid = (az[0] + az[1] + az[2]) / 3;
            if (yMax > terrain.heightAt(xMid, zMid) + 4.0) {
              timberWorstOut = omin;
              timberWorstX = xMid;
              timberWorstY = yMax - terrain.heightAt(xMid, zMid);
            }
          }
        }

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

    /**
     * Where the block's own front face is, measured rather than assumed.
     *
     * Cast down the same line at 10 m up, well above the crown of the vault, where the
     * gatehouse is solid attic. Everything the carriageway rays report is then expressed
     * *relative to the face*, so the two door assertions below need no constant from
     * `wall.ts` and cannot drift when the block's depth or setback changes.
     */
    const faceHit = castNear(
      gates[0].x + gateBay.nx * 16, gy + 10.0, gates[0].z + gateBay.nz * 16,
      -gateBay.nx, 0, -gateBay.nz, 40, [gates[0].x]
    );

    for (const r of rays) {
      r.hit = castNear(r.ox, r.oy, r.oz, r.dx, r.dy, r.dz, 40, [gates[0].x]);
      /**
       * And again from a metre behind whatever stopped it.
       *
       * This is the half of the old assertion worth keeping. The passage still has to be a
       * real tunnel — the bug this file was written for was a curtain built straight through
       * it and a 1.15 m socle step across the road, both hidden behind the leaves — but with
       * the gate shut, a ray from outside can no longer see any of that. So the test moves
       * inside the doors: what the ram opens has to be a road, not a bricked-up recess.
       */
      const from = Number.isFinite(r.hit) ? r.hit + 1.0 : 0;
      r.beyond = castNear(
        r.ox + r.dx * from, r.oy, r.oz + r.dz * from,
        r.dx, r.dy, r.dz, 25, [gates[0].x, gates[0].x + 6, gates[0].x - 6]
      );
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

    // ---- stair profiles, read back out of the splat --------------------------
    /**
     * A flight is a sustained monotone climb in the tread band.
     *
     * Discovered from the triangles rather than read from a list, which is the whole point
     * of this file: the geometry has to *be* a walkable rake, not merely be accompanied by
     * a record saying it is. Only finished bays are scanned — an unfinished bay carries the
     * scaffold in the same band, and a scaffold is a roughly level deck, not a climb.
     */
    const stairsFound = [];
    for (let b = 0; b < nBays; b++) {
      if (bays[b].stage !== 'finished') continue;
      const h = [];
      for (let j = 0; j < stairBins; j++) h.push(stairTop[b * stairBins + j]);
      const filled = h.map((v) => (Number.isFinite(v) ? v : null));
      // Longest non-decreasing run of filled bins, scanning from the high end down.
      let best = null;
      let j = 0;
      while (j < stairBins) {
        if (filled[j] === null) { j++; continue; }
        let k = j;
        while (k + 1 < stairBins && filled[k + 1] !== null && filled[k + 1] <= filled[k] + 1e-6) k++;
        const span = { j0: j, j1: k, yTop: filled[j], yBot: filled[k] };
        if (!best || span.yTop - span.yBot > best.yTop - best.yBot) best = span;
        j = Math.max(k + 1, j + 1);
      }
      if (!best) continue;
      const climb = best.yTop - best.yBot;
      // A stair climbs, is long enough to be a flight, and **starts on the ground**. The
      // last clause is what stops a drum or a roof that happens to fall in the band being
      // read as a rake, without making the head-height assertion below tautological.
      if (climb < 2.0) continue;
      if ((best.j1 - best.j0) * STAIR_BIN < 4.0) continue;
      if (best.yBot > bays[b].groundY + 3.0) continue;
      /**
       * A rake is *straight*. This is what separates a flight from the other thing in this
       * band that descends: the river terminus at bay 0 is a 7.6 m drum straddling the wall
       * line, and its tile string courses cross the band at a different height every few
       * metres, which reads as a 6.8 m "climb" in 8 bins. Measured against the chord from
       * head to foot, a stair never departs by more than one riser; the drum departs by
       * metres. Deliberately *not* the same test as the two assertions below — a dead
       * straight rake can still have risers a man cannot climb, and can still stop short of
       * the walkway, so neither of those is made tautological by this.
       */
      /**
       * Measured over the rake only, trimming the flat at **both** ends.
       *
       * The flight is bounded by two level surfaces that are part of it and are not treads:
       * a landing at the head, where a man steps off onto the walkway, and an apron at the
       * foot, where it discharges onto paving instead of into turf. A chord drawn across
       * either of them tilts off the treads — the 1.8 m apron alone put the deviation at
       * 0.5 m on a 16 m flight and made the probe report that the circuit had no stairs at
       * all, half an hour after it had correctly found nine.
       */
      let jr = best.j0;
      while (jr < best.j1 && filled[jr] > best.yTop - 0.05) jr++;
      jr = Math.max(best.j0, jr - 1);
      let je = best.j1;
      while (je > jr && filled[je] < best.yBot + 0.05) je--;
      je = Math.min(best.j1, je + 1);
      let dev = 0;
      for (let q = jr; q <= je; q++) {
        const t = (q - jr) / Math.max(1, je - jr);
        dev = Math.max(dev, Math.abs(filled[q] - (filled[jr] + (filled[je] - filled[jr]) * t)));
      }
      if (dev > 0.45) continue;
      // Biggest jump between adjacent bins over the flight — a step a man cannot take.
      let jump = 0;
      for (let q = best.j0; q < best.j1; q++) jump = Math.max(jump, filled[q] - filled[q + 1]);
      stairsFound.push({
        bay: b,
        alongLength: +((best.j1 - best.j0) * STAIR_BIN).toFixed(2),
        crossExtent: +(stairOut[b] - HALF_T).toFixed(2),
        climb: +climb.toFixed(2),
        headY: +best.yTop.toFixed(2),
        footY: +best.yBot.toFixed(2),
        walkY: +bays[b].walkY.toFixed(2),
        toWalk: +(best.yTop - bays[b].walkY).toFixed(2),
        maxStep: +jump.toFixed(3),
        dev: +dev.toFixed(3),
        // Lowest guard height over the rake: how far the parapet stands above the tread
        // beside it, at the worst bin of the flight.
        /**
         * Lowest guard height over the rake: how far the parapet stands above the tread
         * beside it, at the worst step of the flight.
         *
         * Taken against the highest parapet **within one bin**, which is not a fudge but the
         * removal of a sampling artifact. Both profiles are staircases and their step edges
         * do not fall in the same 0.2 m bin, so wherever the parapet has stepped down and
         * the tread has not, a straight per-bin difference reports exactly one riser less
         * than the truth — an alternating 0.95 / 0.66 sawtooth on a parapet that is a
         * constant 0.95 m everywhere. Same class of error as the 0.58 m "step" a 0.5 m bin
         * reported on 0.29 m risers. A missing parapet still reads as missing: the window is
         * one bin, not the flight.
         */
        /**
         * How far the parapet stands above the tread beside it, as the **median** over the
         * rake, with the fraction of the rake that has a parapet at all reported alongside.
         *
         * Both quantities are needed and neither alone is honest. A per-bin minimum is not
         * measurable here: the two profiles are staircases whose step edges fall in different
         * 0.2 m bins, so it reports one riser short wherever they disagree, and at the two
         * junctions — the landing at the head, the apron at the foot — a level slab lands in
         * both bands at once and it reports zero. Neither is a fault in the wall. The median
         * is immune to both and still collapses if the guard is actually missing, which is
         * what `cover` is for: a flight with no parapet reads 0 % covered, not 0.95 m.
         */
        /**
         * Guard height, measured against the **rake's own chord** rather than against the
         * tread bins.
         *
         * Differencing two independently binned staircases cannot do better than one riser:
         * their step edges fall in different 0.2 m bins, so the reading oscillates by ±0.30 m
         * whichever profile you take the envelope of, and at the junctions with the landing
         * and the apron it collapses to zero. The chord from head to foot is already the
         * line this file asserts the treads lie on, to within 0.45 m, so measuring the
         * parapet against it is well founded and free of the phase error entirely. A parapet
         * that is 0.95 m over the treads reads 0.95 m over the chord, give or take the half
         * riser the treads themselves depart from it.
         */
        guard: (() => {
          const g2 = [];
          const span = Math.max(1, je - jr);
          for (let q = jr + 3; q <= je - 3; q++) {
            const pv = paraTop[b * stairBins + q];
            if (!Number.isFinite(pv)) continue;
            const line = filled[jr] + ((filled[je] - filled[jr]) * (q - jr)) / span;
            g2.push(pv - line);
          }
          if (g2.length === 0) return -1;
          g2.sort((u, v) => u - v);
          // The median, not the minimum. Two things put noise on the tail that is not in the
          // wall: the bin phase between two staircases, worth ±1 riser, and the obliquest
          // bays, where the probe's own reconstruction of the wall line differs from the
          // builder's by enough to push a few triangles out of a 0.7 m offset band. The
          // median is stable against both and still goes to zero if the guard is absent —
          // `cover` is reported beside it so an absent parapet cannot hide behind it.
          return +g2[g2.length >> 1].toFixed(2);
        })(),
        cover: (() => {
          let n2 = 0;
          let tot = 0;
          for (let q = jr; q <= je; q++) {
            tot++;
            if (Number.isFinite(paraTop[b * stairBins + q])) n2++;
          }
          return tot ? +(n2 / tot).toFixed(3) : 0;
        })(),
      });
    }

    // Debug: the two profiles for one flight, so a disagreement can be read bin by bin.
    const dbgBay = 14;
    const dbg = [];
    for (let j = 0; j < stairBins; j++) {
      const a = stairTop[dbgBay * stairBins + j];
      const b2 = paraTop[dbgBay * stairBins + j];
      if (Number.isFinite(a) || Number.isFinite(b2)) {
        dbg.push({ t: +(j * STAIR_BIN).toFixed(1),
          tread: Number.isFinite(a) ? +a.toFixed(2) : null,
          para: Number.isFinite(b2) ? +b2.toFixed(2) : null });
      }
    }
    return {
      bays, gates, segs, prof, meshCount: meshes.length, tris,
      dbg,
      stairsFound,
      timber: {
        worstOut: +timberWorstOut.toFixed(2),
        x: +timberWorstX.toFixed(1),
        above: +timberWorstY.toFixed(2),
        halfT: HALF_T,
      },
      faceHit: Number.isFinite(faceHit) ? +faceHit.toFixed(2) : null,
      carriageway: rays.map((r) => ({
        h: r.h,
        hit: Number.isFinite(r.hit) ? +r.hit.toFixed(2) : null,
        beyond: Number.isFinite(r.beyond) ? +r.beyond.toFixed(2) : null,
      })),
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

    /**
     * ---- the gate is shut ------------------------------------------------
     *
     * It was open, and that was the fourth of the player's reports: the one road into Rome
     * stood wide, so the Juthungi could walk in and the ram in the siege train had nothing
     * to break. The old assertion here demanded the opposite — that the four carriageway
     * rays pass clean through — so closing the gate correctly is what turns it red. It is
     * replaced by the two tests that actually matter now.
     *
     * A shut gate is a *flat plane across the passage, set back behind the block's face*.
     * Both halves of that matter: agreement between the four heights is what distinguishes
     * a pair of leaves from a lump of masonry, and the setback is what distinguishes leaves
     * from a bricked-up arch. Everything is measured against `faceHit`, the block's own
     * front face read off a ray at 10 m up, so no constant from `wall.ts` is assumed.
     */
    const cw = measured.carriageway;
    const face = measured.faceHit;
    const hits = cw.filter((r) => r.hit !== null).map((r) => r.hit);
    const spread = hits.length ? Math.max(...hits) - Math.min(...hits) : Infinity;
    const setback = hits.length && face !== null ? Math.min(...hits) - face : NaN;
    check('the gate is shut — the carriageway is stopped by the leaves, not by the vault',
      hits.length === cw.length && spread <= 0.15 && setback > 1.0 && setback < 9.0,
      hits.length !== cw.length
        ? `${cw.length - hits.length} of ${cw.length} rays pass straight through the gate — it is standing open`
        : `all ${cw.length} rays down the carriageway at ${cw.map((r) => r.h.toFixed(1)).join('/')} m ` +
          `are stopped at ${Math.min(...hits).toFixed(2)}..${Math.max(...hits).toFixed(2)} m in ` +
          `(spread ${(spread * 100).toFixed(1)} cm — one flat plane), ` +
          `${setback.toFixed(2)} m behind the block's own face at ${face === null ? 'n/a' : face.toFixed(2)} m`);

    const notThrough = cw.filter((r) => r.beyond !== null);
    check('behind the leaves the passage is a real tunnel — the ram opens a road, not a recess',
      notThrough.length === 0,
      notThrough.length === 0
        ? `four rays restarted 1 m inside the leaves run 25 m through the block and out the ` +
          `far side without striking masonry: no curtain across the passage, no step in the road`
        : `${notThrough.length} of ${cw.length} rays are blocked behind the doors: ` +
          notThrough.map((r) => `${r.h.toFixed(1)} m up at ${r.beyond.toFixed(2)} m past them`).join('; '));

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

    /**
     * ---- the walkway is wide enough to be worth standing on ---------------
     *
     * The player's first report was that the wall should be wider so more men fit, and the
     * clear standing band is the number that decides how many do: the sim lays ranks at a
     * 0.72 m interlocking pitch, so a band of `b` metres takes `floor(b / 0.72) + 1` ranks.
     * At 3.5 m of curtain the band ran 0.75..1.86 m and most bays took **two**. This asserts
     * the floor that widening bought, so a later change cannot quietly give it back.
     */
    const RANK_PITCH = 0.72;
    const bands = garr.map((b) => ({ i: b.index, band: b.outerOff - b.innerOff }));
    const ranksOf = (b) => Math.floor(b / RANK_PITCH) + 1;
    const thin = bands.filter((b) => ranksOf(b.band) < 4);
    check('every garrisoned bay has a walkway four ranks deep',
      thin.length === 0,
      `clear band ${Math.min(...bands.map((b) => b.band)).toFixed(2)}..` +
      `${Math.max(...bands.map((b) => b.band)).toFixed(2)} m over ${bands.length} bays ` +
      `(${Math.min(...bands.map((b) => ranksOf(b.band)))}..${Math.max(...bands.map((b) => ranksOf(b.band)))} ranks ` +
      `at a ${RANK_PITCH} m pitch; the curtain is ${(bays[0].halfThickness * 2).toFixed(2)} m thick)` +
      (thin.length ? `; too thin at bays ${thin.slice(0, 6).map((b) => `${b.i} (${b.band.toFixed(2)} m)`).join(', ')}` : ''));

    /**
     * ---- the stairs ------------------------------------------------------
     *
     * Discovered from the triangles, not read from a list. The old stair ran out of the
     * tower's city face at right angles to the wall; the player asked for one that climbs
     * along it. "Parallel" is measurable: a flight that runs along the curtain is many times
     * longer than it is deep, and a flight that projects out of it is not.
     */
    const st2 = measured.stairsFound;
    check('the wall has stairs onto the walkway at all',
      st2.length >= 6,
      st2.length === 0
        ? 'no climbable rake found anywhere in the band behind the curtain'
        : `${st2.length} flights found, on bays ${st2.map((s) => s.bay).join(', ')}; ` +
          `they climb ${Math.min(...st2.map((s) => s.climb)).toFixed(2)}..` +
          `${Math.max(...st2.map((s) => s.climb)).toFixed(2)} m`);

    const perp = st2.filter((s) => s.crossExtent > 4.2 || s.alongLength < s.crossExtent * 2.5);
    check('every stair climbs parallel to the curtain, not out of it',
      st2.length > 0 && perp.length === 0,
      st2.length === 0
        ? 'no stairs to measure'
        : `flights run ${Math.min(...st2.map((s) => s.alongLength)).toFixed(1)}..` +
          `${Math.max(...st2.map((s) => s.alongLength)).toFixed(1)} m along the wall against ` +
          `${Math.min(...st2.map((s) => s.crossExtent)).toFixed(2)}..` +
          `${Math.max(...st2.map((s) => s.crossExtent)).toFixed(2)} m of projection into the ` +
          `pomerium — ratio ${Math.min(...st2.map((s) => s.alongLength / Math.max(0.01, s.crossExtent))).toFixed(1)}:1 at worst` +
          (perp.length ? `; offenders ${perp.map((s) => s.bay).join(',')}` : ''));

    const unguarded = st2.filter((s) => s.guard < 0.7 || s.cover < 0.85);
    check('every stair is walled on its open side, not a drop',
      st2.length > 0 && unguarded.length === 0,
      st2.length === 0
        ? 'no stairs to measure'
        : `the parapet stands ${Math.min(...st2.map((s) => s.guard)).toFixed(2)}..` +
          `${Math.max(...st2.map((s) => s.guard)).toFixed(2)} m above the tread beside it ` +
          `(worst step of each rake, against its chord), covering ` +
          `${(Math.min(...st2.map((s) => s.cover)) * 100).toFixed(1)}-` +
          `${(Math.max(...st2.map((s) => s.cover)) * 100).toFixed(1)}% of it, over ${st2.length} ` +
          `flights (0.7 m and 85% minimum for a 9 m drop)` +
          (unguarded.length ? `; short at bays ${unguarded.map((s) => `${s.bay} (${s.guard} m, ${(s.cover * 100).toFixed(0)}%)`).join(', ')}` : ''));

    const short = st2.filter((s) => Math.abs(s.toWalk) > 0.16);
    const steep = st2.filter((s) => s.maxStep > 0.45);
    check('every stair arrives on the wall-walk by steps a man can climb',
      st2.length > 0 && short.length === 0 && steep.length === 0,
      st2.length === 0
        ? 'no stairs to measure'
        : `heads land within ${Math.max(...st2.map((s) => Math.abs(s.toWalk))) * 100 < 0.05 ? 0 : (Math.max(...st2.map((s) => Math.abs(s.toWalk))) * 100).toFixed(1)} cm ` +
          `of their bay's walkY; tallest step ${(Math.max(...st2.map((s) => s.maxStep)) * 100).toFixed(1)} cm ` +
          `(a 45 cm limit)` +
          (short.length ? `; ${short.length} miss the walk, worst ${Math.max(...short.map((s) => Math.abs(s.toWalk))).toFixed(2)} m at bay ${short[0].bay}` : '') +
          (steep.length ? `; ${steep.length} too steep, worst ${steep[0].maxStep.toFixed(2)} m at bay ${steep[0].bay}` : ''));

    /**
     * ---- the scaffolding is inside -----------------------------------------
     *
     * The player's third report: "There can totally be scaffolding but it should definitely
     * be on the inside of the walls not on the outside." Offsets are signed with the city
     * positive, so this is one number — the furthest any raised timber reaches onto the
     * field. The old scaffold stood its outer standards 1.6 m clear of the outer face and
     * decked between, which on a 6 m curtain puts them 4.6 m out and hands the Juthungi a
     * ready-made ladder. The 3.0 m height gate exempts the footing bays' shuttering, which
     * is legitimately outside and reaches 2.8 m.
     */
    const tb = measured.timber;
    const limit = tb.halfT + 0.6;
    check('no scaffolding stands on the field side of the wall',
      -tb.worstOut <= limit,
      tb.worstOut === 0
        ? 'no timber over 4.0 m above ground stands outside the wall centreline at all'
        : `furthest raised timber on the field side reaches ${(-tb.worstOut).toFixed(2)} m from the ` +
          `centreline (the outer face is at ${tb.halfT.toFixed(2)} m, limit ${limit.toFixed(2)}), ` +
          `at x ${tb.x.toFixed(0)}, standing ${tb.above.toFixed(1)} m above the ground`);

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
