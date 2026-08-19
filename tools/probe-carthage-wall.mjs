#!/usr/bin/env node
/**
 * Numerical acceptance tests for Carthage's triple wall.
 *
 * The sibling of `probe-wall.mjs`, and it exists for the same reason: a screenshot only
 * shows a hole in a wall if the camera happens to point at it, and a unit test written
 * against `carthageWall.ts` only shows what its author already believed. Everything here is
 * read out of **the scene graph the renderer was given** or out of **the accessors the siege
 * system actually calls** — never out of a recomputation of the builder's own arithmetic,
 * because this project has repeatedly shipped assertions that passed while measuring the
 * wrong thing.
 *
 * Four groups, and they check each other rather than themselves:
 *
 *   A. **Contract.** Every field of `WallStair`, `GateDoorOut` and `GarrisonBay` that
 *      `Siege.ts` reads, tested against the semantics Rome's implementation defines. If this
 *      group passes, the siege system drives Carthage with no second implementation.
 *   B. **Stone.** Triangles inside a corridor around each of the three wall lines, splatted
 *      into 25 cm x-bins **by their own x-extent**, so a single 30 m quad covers all 120 bins
 *      it spans. Binning vertices instead under-reports large faces and is how a 23 m hole
 *      beside the Porta Flaminia stayed invisible.
 *   C. **Orientation, signed.** A ladder once passed 24 assertions while rendered 180°
 *      backwards, so every claim about which way something faces is tested as a **signed**
 *      quantity read off the matrix the renderer wrote, not off an analytic recomputation.
 *   D. **Agreement.** Geometry against `masonryTopAt`, against `getObstacles()`, and against
 *      the published records. Each of the three has to be wrong in the same direction for a
 *      hole to be invisible, which is the only reason this catches anything.
 *
 * Usage:
 *   node tools/probe-carthage-wall.mjs --port=5733
 *   node tools/probe-carthage-wall.mjs --port=5733 --json
 */

import { chromium } from 'playwright';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const PORT = Number(args.get('port') ?? 5733);
const AS_JSON = args.has('json');
const QUALITY = args.get('quality') ?? 'ultra';

/** Bin width of the circuit walk, metres. Fine enough to see one missing sub-bay panel. */
const STEP = 0.25;

async function ensureServer() {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const r = await fetch(`${base}/src/main.ts`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      console.log(`• using the dev server at ${base}`);
      return base;
    }
    console.error(`! ${base} answered ${r.status} for /src/main.ts — refusing to grade a stale dist/.`);
    process.exit(2);
  } catch {
    console.error(`! no dev server on ${PORT}. Start one; a probe that silently falls back to ` +
      'dist/ has reported 5/12 on a tree that scored 12/12.');
    process.exit(2);
  }
}

const base = await ensureServer();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`);
});

const url = `${base}/?harness=1&fort=carthage&quality=${QUALITY}&w=1280&h=720`;
await page.goto(url, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction('window.__game && window.__game.ready === true', { timeout: 180000 });
} catch (e) {
  console.error('! the page never reported ready.');
  for (const p of pageErrors) console.error(`  pageerror: ${p}`);
  for (const c of consoleErrors.slice(0, 20)) console.error(`  ${c}`);
  await browser.close();
  process.exit(2);
}

const result = await page.evaluate(
  ({ STEP }) => {
    const g = window.__game;
    const ctx = g.engine.context;
    const city = ctx.tryGet('city');
    if (!city) return { fatal: 'no city subsystem' };

    const out = { checks: [], facts: {} };
    const ok = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail });
    const near = (name, got, want, tol, unit = 'm') =>
      ok(name, Math.abs(got - want) <= tol, `${got.toFixed(3)} ${unit} vs ${want.toFixed(3)} ±${tol}`);

    // ---------------------------------------------------------------------
    // The accessors the siege system drives
    // ---------------------------------------------------------------------
    const bays = city.getGarrisonBays();
    const stairs = city.getWallStairs();
    const door = city.getGateDoor();
    const segs = city.getWallSegments();
    const gates = city.getGates();
    const obstacles = city.getObstacles();
    const casemates = city.getCasemates ? city.getCasemates() : [];
    const outworks = city.getOutworks ? city.getOutworks() : [];

    out.facts.bays = bays.length;
    out.facts.stairs = stairs.length;
    out.facts.segments = segs.length;
    out.facts.gates = gates.length;
    out.facts.casemates = casemates.length;
    out.facts.outworks = outworks.length;
    out.facts.obstacles = obstacles.length;

    // --- A. contract -----------------------------------------------------
    ok('A1 getWallStairs is non-empty', stairs.length > 0, `${stairs.length} flights`);
    ok(
      'A2 every stair has the fields CityStairView asks for',
      stairs.every((s) =>
        ['footX', 'footY', 'footZ', 'topX', 'topY', 'topZ', 'width', 'side', 'bay'].every(
          (k) => Number.isFinite(s[k])
        )
      ),
      'footX/Y/Z topX/Y/Z width side bay'
    );
    ok(
      'A3 rise is positive and equals topY - footY on every flight',
      stairs.every((s) => s.rise > 0 && Math.abs(s.rise - (s.topY - s.footY)) < 1e-6),
      stairs.length
        ? `min rise ${Math.min(...stairs.map((s) => s.rise)).toFixed(2)} m, ` +
          `max ${Math.max(...stairs.map((s) => s.rise)).toFixed(2)} m`
        : 'no flights'
    );
    ok(
      'A4 side is -1 (cityward) on every flight',
      stairs.length > 0 && stairs.every((s) => s.side === -1),
      [...new Set(stairs.map((s) => s.side))].join(',')
    );
    // `bay` must index a real bay, and that bay's walk must be the height the stair lands at.
    let bayMismatch = 0;
    let worstLanding = 0;
    for (const s of stairs) {
      const b = bays[s.bay];
      if (!b) { bayMismatch++; continue; }
      const d = Math.abs(b.walkY - s.topY);
      if (d > worstLanding) worstLanding = d;
      if (d > 0.02) bayMismatch++;
    }
    ok('A5 bay indexes a real bay and topY is that bay walkY', bayMismatch === 0,
      `${bayMismatch} mismatched, worst landing error ${worstLanding.toFixed(4)} m`);
    // The foot must be *outside* the wall's own footprint, or a man cannot reach it.
    let footInside = 0;
    let worstFootOff = Infinity;
    for (const s of stairs) {
      const b = bays[s.bay];
      if (!b) continue;
      const t = (s.footX - b.x0) * b.dx + (s.footZ - b.z0) * b.dz;
      const px = b.x0 + b.dx * t;
      const pz = b.z0 + b.dz * t;
      const off = (s.footX - px) * b.nx + (s.footZ - pz) * b.nz;
      // Cityward is negative: the foot must be past the inner face, i.e. more negative.
      if (off > -b.halfThickness) footInside++;
      worstFootOff = Math.min(worstFootOff, -off - b.halfThickness);
    }
    ok('A6 every foot stands clear of the wall footprint, on the city side', footInside === 0,
      `${footInside} inside; nearest foot ${worstFootOff.toFixed(2)} m past the inner face`);
    // Widths, and the top landing inside the clear standing band.
    let topOutOfBand = 0;
    for (const s of stairs) {
      const b = bays[s.bay];
      if (!b) continue;
      const t = (s.topX - b.x0) * b.dx + (s.topZ - b.z0) * b.dz;
      const px = b.x0 + b.dx * t;
      const pz = b.z0 + b.dz * t;
      const off = (s.topX - px) * b.nx + (s.topZ - pz) * b.nz;
      if (off < b.innerOff - 1e-6 || off > b.outerOff + 1e-6) topOutOfBand++;
    }
    ok('A7 every landing lands inside the bay clear standing band', topOutOfBand === 0,
      `${topOutOfBand} outside [innerOff, outerOff]`);
    ok('A8 stair width is two men or more', stairs.every((s) => s.width >= 2.4),
      stairs.length ? `min ${Math.min(...stairs.map((s) => s.width)).toFixed(2)} m` : 'none');

    // The gate, modelled shut.
    ok('A9 getGateDoor returns a door and it is shut', !!door && door.open === false,
      door ? `${door.gateId} open=${door.open}` : 'null');
    ok('A10 the door plane is the width of its own passage',
      !!door && door.halfWidth > 1.5 && door.height > 4,
      door ? `halfWidth ${door.halfWidth.toFixed(2)} m, height ${door.height.toFixed(2)} m` : 'null');
    ok('A11 getGates()[0] is the besieged gate, shut, and no postern precedes it',
      gates.length > 0 && gates[0].open === false && gates[0].id === (door && door.gateId),
      gates.length ? `${gates[0].id} open=${gates[0].open}` : 'none');

    // Garrison band: five ranks at the sim's 0.72 m interlocking pitch.
    const bands = bays.filter((b) => b.garrisonable).map((b) => b.outerOff - b.innerOff);
    const minBand = bands.length ? Math.min(...bands) : 0;
    out.facts.minStandingBand = minBand;
    out.facts.maxStandingBand = bands.length ? Math.max(...bands) : 0;
    out.facts.minRanks = Math.floor(minBand / 0.72) + 1;
    ok('A12 the worst bay still seats five ranks at 0.72 m', minBand >= 5 * 0.72,
      `min band ${minBand.toFixed(2)} m = ${Math.floor(minBand / 0.72) + 1} ranks`);

    // Bay indexing: `CitySystem.bayAt` is arithmetic in x and needs a uniform pitch.
    let pitchSpread = 0;
    if (bays.length > 2) {
      const p0 = bays[1].x0 - bays[0].x0;
      for (let i = 2; i < bays.length; i++) {
        pitchSpread = Math.max(pitchSpread, Math.abs(bays[i].x0 - bays[i - 1].x0 - p0));
      }
      out.facts.bayPitch = p0;
    }
    ok('A13 bay pitch is uniform, so bayAt index arithmetic holds', pitchSpread < 1e-6,
      `worst deviation ${pitchSpread.toExponential(2)} m`);

    // Every bay must be walkable and report a half-thickness, or masonryTopAt goes blind.
    ok('A14 every bay publishes walkable and its own halfThickness',
      bays.every((b) => b.walkable && b.halfThickness > 1),
      `halfThickness ${bays.length ? bays[0].halfThickness.toFixed(3) : '-'} m`);

    // --- B/D. the stone, and whether the data agrees with it -------------
    const scene = ctx.scene;
    let root = null;
    scene.traverse((o) => { if (o.name === 'city') root = o; });
    const wallMeshes = [];
    /** The leaves hung in the posterns, kept apart from the wall for E7's sake. See E9. */
    const doorMeshes = [];
    if (root) {
      root.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        if (/^postern-door-/.test(o.name) || (o.parent && /^postern-door-/.test(o.parent.name || ''))) {
          doorMeshes.push(o);
        }
        // Full-detail wall chunks only. Names are `<chunk>-lod<N>-<material>`.
        //
        // **A door is not a wall**, and that exclusion is what makes E7 mean anything: the
        // Porta Byrsae's leaves and, since the posterns were shut, the eight
        // `postern-door-N` chunks all stand inside passages this probe is trying to prove
        // are cut. Gathering them would let a hung door pass for uncut tufa and retire the
        // one assertion in this file that found r4's painted-on posterns.
        if (!/^wall-\d+/.test(o.name)) return;
        if (!/lod2|-l2|detail2/.test(o.name) && o.parent && o.parent.name &&
            !/lod2/.test(o.parent.name)) {
          // fall through: LOD grouping differs, filter by visibility below
        }
        wallMeshes.push(o);
      });
    }
    // Only the levels currently switched in, so a chunk is not counted three times.
    const visible = wallMeshes.filter((m) => {
      let p = m;
      while (p) { if (p.visible === false) return false; p = p.parent; }
      return true;
    });
    out.facts.wallMeshes = visible.length;

    /** World-space triangles of the visible wall meshes. */
    const tris = [];
    const V = { x: 0, y: 0, z: 0 };
    for (const m of visible) {
      m.updateWorldMatrix(true, false);
      const e = m.matrixWorld.elements;
      const pos = m.geometry.getAttribute('position');
      const idx = m.geometry.getIndex();
      const n = idx ? idx.count : pos.count;
      const arr = pos.array;
      const get = (i) => {
        const k = i * 3;
        const x = arr[k], y = arr[k + 1], z = arr[k + 2];
        V.x = e[0] * x + e[4] * y + e[8] * z + e[12];
        V.y = e[1] * x + e[5] * y + e[9] * z + e[13];
        V.z = e[2] * x + e[6] * y + e[10] * z + e[14];
        return V;
      };
      for (let t = 0; t < n; t += 3) {
        const ia = idx ? idx.getX(t) : t;
        const ib = idx ? idx.getX(t + 1) : t + 1;
        const ic = idx ? idx.getX(t + 2) : t + 2;
        const a = get(ia); const ax = a.x, ay = a.y, az = a.z;
        const b = get(ib); const bx = b.x, by = b.y, bz = b.z;
        const c = get(ic); const cx = c.x, cy = c.y, cz = c.z;
        tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      }
    }
    out.facts.triangles = tris.length / 9;

    /** The same, for the postern leaves alone. */
    const doorTris = [];
    for (const m of doorMeshes.filter((m) => {
      let q = m;
      while (q) { if (q.visible === false) return false; q = q.parent; }
      return true;
    })) {
      m.updateWorldMatrix(true, false);
      const pos = m.geometry.getAttribute('position');
      const idx = m.geometry.getIndex();
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        for (let k = 0; k < 3; k++) {
          const j = idx ? idx.getX(i + k) : i + k;
          V.x = pos.getX(j); V.y = pos.getY(j); V.z = pos.getZ(j);
          const e = m.matrixWorld.elements;
          const wx = e[0] * V.x + e[4] * V.y + e[8] * V.z + e[12];
          const wy = e[1] * V.x + e[5] * V.y + e[9] * V.z + e[13];
          const wz = e[2] * V.x + e[6] * V.y + e[10] * V.z + e[14];
          doorTris.push(wx, wy, wz);
        }
      }
    }
    out.facts.posternDoorTriangles = doorTris.length / 9;

    // The circuit's x span, from the published bays.
    const x0 = bays[0].x0;
    const x1 = bays[bays.length - 1].x1;
    const nBin = Math.ceil((x1 - x0) / STEP);
    out.facts.spanX = [x0, x1];

    /**
     * Highest triangle vertex per 25 cm bin, per line, splatted by x-extent.
     *
     * `wallZAt` for the main line comes from the bays themselves; the two forward lines come
     * from their own published records, so nothing here re-derives an offset the builder
     * chose.
     */
    const lineOf = (x) => {
      const i = Math.floor((x - x0) / (bays[1].x0 - bays[0].x0));
      return bays[Math.max(0, Math.min(bays.length - 1, i))];
    };
    /**
     * The point on the wall centreline whose **x is exactly `x`**.
     *
     * The inverse of the run parameter is `t = (x - x0) / dx`, not `t = (x - x0) * dx`. The
     * second is the one that reads naturally and it is wrong by `dz²` of the run: this wall
     * line reaches dz/dx = 0.52 on the Pincian shoulder, which throws the sampled point six
     * metres off a 4.62 m half-thickness. It failed two assertions here against innocent
     * geometry before it was caught, so it is written once and used everywhere.
     */
    const onLine = (x) => {
      const b = lineOf(x);
      const t = (x - b.x0) / (b.dx || 1);
      return { b, t, x, z: b.z0 + b.dz * t };
    };
    const mainTop = new Float64Array(nBin).fill(-Infinity);
    const ground = new Float64Array(nBin).fill(NaN);
    // Corridor half-width around the main line: half the thickness plus the tower project.
    const CORRIDOR = bays[0].halfThickness + 6.0;

    for (let t = 0; t < tris.length; t += 9) {
      const xs = [tris[t], tris[t + 3], tris[t + 6]];
      const ys = [tris[t + 1], tris[t + 4], tris[t + 7]];
      const zs = [tris[t + 2], tris[t + 5], tris[t + 8]];
      const yMax = Math.max(ys[0], ys[1], ys[2]);
      const xa = Math.min(xs[0], xs[1], xs[2]);
      const xb = Math.max(xs[0], xs[1], xs[2]);
      const zc = (zs[0] + zs[1] + zs[2]) / 3;
      const xc = (xa + xb) / 2;
      const b = lineOf(xc);
      // Signed offset of the triangle's centroid from the main line, positive outward.
      const tt = (xc - b.x0) * b.dx + (zc - b.z0) * b.dz;
      const px = b.x0 + b.dx * tt;
      const pz = b.z0 + b.dz * tt;
      const off = (xc - px) * b.nx + (zc - pz) * b.nz;
      if (Math.abs(off) > CORRIDOR) continue;
      const ia = Math.max(0, Math.floor((xa - x0) / STEP));
      const ib = Math.min(nBin - 1, Math.ceil((xb - x0) / STEP));
      for (let i = ia; i <= ib; i++) if (yMax > mainTop[i]) mainTop[i] = yMax;
    }

    // Terrain under the main line, for a rise test that does not assume a datum.
    const terrain = ctx.tryGet('terrain');
    for (let i = 0; i < nBin; i++) {
      const p = onLine(x0 + (i + 0.5) * STEP);
      ground[i] = terrain ? terrain.heightAt(p.x, p.z) : 0;
    }

    let unwalled = 0;
    let worstGapRun = 0;
    let run = 0;
    let worstGapX = 0;
    for (let i = 0; i < nBin; i++) {
      const rise = mainTop[i] - ground[i];
      // 3 m is far below anything on this circuit: the lowest thing authored on the main
      // line is a 1.75 m plinth under a 13.86 m wall, so under 3 m is absence, not a stage.
      if (!(rise > 3.0)) {
        unwalled++;
        run += STEP;
        if (run > worstGapRun) { worstGapRun = run; worstGapX = x0 + i * STEP; }
      } else run = 0;
    }
    out.facts.unwalledMetres = unwalled * STEP;
    out.facts.worstGapRun = worstGapRun;
    out.facts.worstGapX = worstGapX;
    // The gate passage and the posterns are deliberate holes, but they are holes in the
    // *ground* storey, not in the wall: masonry stands over every one of them.
    ok('B1 no gap longer than a postern anywhere on the main line',
      worstGapRun <= 7.0,
      `worst continuous gap ${worstGapRun.toFixed(2)} m at x=${worstGapX.toFixed(0)}`);

    const heights = [];
    for (let i = 0; i < nBin; i++) {
      const r = mainTop[i] - ground[i];
      if (r > 3.0) heights.push(r);
    }
    heights.sort((a, b) => a - b);
    const median = heights.length ? heights[heights.length >> 1] : 0;
    out.facts.medianRise = median;
    out.facts.minRise = heights.length ? heights[0] : 0;
    out.facts.maxRise = heights.length ? heights[heights.length - 1] : 0;
    // Appian: 30 cubits to the walk, apart from the parapets and towers. The measured
    // silhouette therefore has to be the walk plus a parapet, and the towers push the tail up.
    ok('B2 the built silhouette carries Appian 30 cubits plus a parapet',
      median >= 13.86 && median <= 13.86 + 2.15 + 4.0,
      `median rise ${median.toFixed(2)} m (walk 13.86 + parapet 2.15 + tower tail)`);

    /**
     * B3: **the approach is empty**, and this is the inverse of the assertion it replaces.
     *
     * The old B3 measured the outer and middle lines' own stone, because every other check on
     * them read their published records and none had ever asked "is there any masonry out
     * there at all" — a record is a claim and a triangle is a fact. The two lines are gone,
     * and the same technique run the other way is what proves it: walk the whole frontage in
     * the corridor from just clear of the towers out past the ditch, splat every triangle by
     * its own x-extent, and demand that nothing stands there.
     *
     * Deleting the records without deleting the geometry is a real failure mode and it is
     * invisible from every accessor — `getOutworks()` would answer empty while the palisade
     * still stood, exactly the way round that the original B3 was written to catch.
     */
    // The builder's own tower projection, not a literal: an assertion that re-derives the
    // number it is testing against cannot fail.
    const secB = city.punicSection ? city.punicSection() : null;
    const APPROACH_FROM = bays[0].halfThickness + (secB ? secB.towerProject : 5.5) + 2.0;
    const APPROACH_TO = 70.0;
    const approachTop = new Float64Array(nBin).fill(-Infinity);
    for (let t = 0; t < tris.length; t += 9) {
      const xa = Math.min(tris[t], tris[t + 3], tris[t + 6]);
      const xb = Math.max(tris[t], tris[t + 3], tris[t + 6]);
      const yMax = Math.max(tris[t + 1], tris[t + 4], tris[t + 7]);
      const xc = (xa + xb) * 0.5;
      const zc = (tris[t + 2] + tris[t + 5] + tris[t + 8]) / 3;
      const b = lineOf(xc);
      const tt = (xc - b.x0) * b.dx + (zc - b.z0) * b.dz;
      const o2 = (xc - (b.x0 + b.dx * tt)) * b.nx + (zc - (b.z0 + b.dz * tt)) * b.nz;
      // Signed, and outward-positive: only the field side counts. The ramps and the gallery
      // ramps stand at −8 to −9 m and are none of this assertion's business.
      if (o2 < APPROACH_FROM || o2 > APPROACH_TO) continue;
      const ia = Math.max(0, Math.floor((xa - x0) / STEP));
      const ib = Math.min(nBin - 1, Math.ceil((xb - x0) / STEP));
      for (let i = ia; i <= ib; i++) if (yMax > approachTop[i]) approachTop[i] = yMax;
    }
    let standing = 0;
    let worstStand = 0;
    let worstStandX = 0;
    for (let i = 0; i < nBin; i++) {
      if (!Number.isFinite(approachTop[i])) continue;
      const rise = approachTop[i] - ground[i];
      // 1.0 m: below that is a plinth skirt or a footing apron of the wall itself sampled at
      // the corridor's inner edge, which is masonry that belongs to the main line.
      if (rise > 1.0) {
        standing++;
        if (rise > worstStand) { worstStand = rise; worstStandX = x0 + i * STEP; }
      }
    }
    out.facts.approachCorridor = { from: APPROACH_FROM, to: APPROACH_TO, bins: nBin };
    out.facts.approachStandingMetres = standing * STEP;
    out.facts.approachWorstRise = worstStand;
    ok('B3 the approach in front of the wall carries no masonry at all',
      standing === 0,
      `${(standing * STEP).toFixed(1)} m of the frontage carries something standing between ` +
        `${APPROACH_FROM.toFixed(1)} and ${APPROACH_TO} m out` +
        (standing ? `, worst ${worstStand.toFixed(2)} m at x=${worstStandX.toFixed(0)}` : ''));

    // --- masonryTopAt agrees with the stone ------------------------------
    /**
     * Sampled **along each bay's own run**, not by stepping x.
     *
     * Stepping x and taking z from the centreline is wrong and this probe shipped it once:
     * the wall line's slope reaches dz/dx = 0.52 on the shoulders, so a point built as
     * `(x, z(t(x)))` sits `dz³·(x − x0)` off the centreline — six metres at the worst bay,
     * which is outside a 4.62 m half-thickness. Two assertions failed and the geometry was
     * innocent. Sweep the parameter, never the axis.
     */
    const centreline = [];
    for (const b of bays) {
      const len = Math.hypot(b.x1 - b.x0, b.z1 - b.z0);
      const n = Math.max(2, Math.round(len / 6));
      for (let k = 0; k <= n; k++) {
        const t = (len * k) / n;
        centreline.push({ b, t, x: b.x0 + b.dx * t, z: b.z0 + b.dz * t });
      }
    }
    out.facts.centrelineSamples = centreline.length;

    let topMismatch = 0;
    let worstTop = 0;
    let sampled = 0;
    const offenders = [];
    for (const s of centreline) {
      // The gate block legitimately reports its own attic across its 30 m.
      if (Math.abs(s.x - gates[0].x) <= 22) continue;
      /**
       * Bay joints are excluded here and measured by D3 instead.
       *
       * At a joint two bays meet and the walk genuinely steps, so "which bay's walk should
       * `masonryTopAt` report" has two right answers and the question is not about masonry.
       * The interesting question — *is the step the ground's fault or the builder's* — is a
       * different assertion, and folding it into this one would make both untestable.
       */
      const len = Math.hypot(s.b.x1 - s.b.x0, s.b.z1 - s.b.z0);
      if (s.t < 0.8 || s.t > len - 0.8) continue;
      const said = city.masonryTopAt(s.x, s.z);
      sampled++;
      if (!Number.isFinite(said)) {
        topMismatch++;
        if (offenders.length < 4) offenders.push(`x=${s.x.toFixed(1)} none`);
        continue;
      }
      const d = Math.abs(said - s.b.walkY);
      if (d > 0.05) {
        topMismatch++;
        if (d > worstTop) worstTop = d;
        if (offenders.length < 4) offenders.push(`x=${s.x.toFixed(1)} ${said.toFixed(2)} vs ${s.b.walkY.toFixed(2)}`);
      }
    }
    ok('D1 masonryTopAt reports the walk everywhere on the centreline',
      topMismatch === 0,
      `${topMismatch} of ${sampled} samples disagree, worst ${worstTop.toFixed(3)} m` +
        (offenders.length ? ` [${offenders.join('; ')}]` : ''));

    /**
     * The trap that left the rear 1.25 m of Rome's walkway transparent to arrows.
     *
     * Sample right at the inner lip of the wall-walk — the last place a rear rank stands —
     * and demand that `masonryTopAt` still reports stone there. A consumer testing the wrong
     * half-thickness fails exactly here and nowhere else.
     */
    let lipHoles = 0;
    let lipTested = 0;
    const lipOffenders = [];
    for (const s of centreline) {
      const len = Math.hypot(s.b.x1 - s.b.x0, s.b.z1 - s.b.z0);
      // Offsetting along the normal moves x, so a sample taken at a bay end can land past
      // the end of the circuit where there is legitimately nothing. Stay inside the run.
      if (s.t < 0.8 || s.t > len - 0.8) continue;
      for (const o of [-(s.b.halfThickness - 0.1), s.b.halfThickness - 0.1, s.b.innerOff, s.b.outerOff]) {
        const sx = s.x + s.b.nx * o;
        const sz = s.z + s.b.nz * o;
        lipTested++;
        if (!Number.isFinite(city.masonryTopAt(sx, sz))) {
          lipHoles++;
          if (lipOffenders.length < 4) lipOffenders.push(`x=${sx.toFixed(1)} off=${o.toFixed(2)}`);
        }
      }
    }
    ok('D2 masonryTopAt reports stone at both lips and at both standing limits',
      lipHoles === 0,
      `${lipHoles} of ${lipTested} samples transparent` +
        (lipOffenders.length ? ` [${lipOffenders.join('; ')}]` : ''));

    /**
     * D3: does the wall step because the *ground* steps?
     *
     * A joint step is not a defect — a real curtain crossing a hillside steps its courses
     * rather than shearing them, and Rome's circuit has a 3.62 m drop at the joint east of
     * the gate. What would be a defect is a step the terrain does not account for, which is
     * what a quantisation bug or a mis-indexed level array looks like. So the bound is the
     * terrain's own rise across the joint plus one course module, not a fixed number.
     */
    let worstJoint = 0;
    let worstJointExcess = -Infinity;
    let worstJointX = 0;
    for (let i = 1; i < bays.length; i++) {
      const a = bays[i - 1];
      const b = bays[i];
      const step = Math.abs(b.walkY - a.walkY);
      if (step > worstJoint) worstJoint = step;
      // Terrain rise across the two runs the joint separates.
      const sample = (bay) => {
        const len = Math.hypot(bay.x1 - bay.x0, bay.z1 - bay.z0);
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k <= 12; k++) {
          const t = (len * k) / 12;
          const h = terrain.heightAt(bay.x0 + bay.dx * t, bay.z0 + bay.dz * t);
          if (h < lo) lo = h;
          if (h > hi) hi = h;
        }
        return { lo, hi };
      };
      const sa = sample(a);
      const sb = sample(b);
      const groundStep = Math.abs(sb.hi - sa.hi);
      const excess = step - (groundStep + 0.5);
      if (excess > worstJointExcess) { worstJointExcess = excess; worstJointX = b.x0; }
    }
    out.facts.worstJointStep = worstJoint;
    out.facts.worstJointExcess = worstJointExcess;
    ok('D3 every joint step is the ground rise across it, to within one course',
      worstJointExcess <= 0,
      `worst step ${worstJoint.toFixed(2)} m; worst unexplained excess ` +
        `${worstJointExcess.toFixed(3)} m at x=${worstJointX.toFixed(0)}`);

    // --- C. orientation, signed ------------------------------------------
    /**
     * Every claim about which way something faces, tested as a **signed** dot product
     * against a vector read from the published record. A ladder once passed 24 assertions
     * while rendered 180° backwards; unsigned tests cannot see that and these can.
     */
    // C1: the gate's outward normal points at the attacker, i.e. toward −Z.
    ok('C1 the gate faces the field (signed, nz < 0)', !!door && door.nz < -0.5,
      door ? `n=(${door.nx.toFixed(3)}, ${door.nz.toFixed(3)})` : 'null');
    // C2: the door plane stands on the field side of its own bay centreline.
    let doorSide = 0;
    if (door) {
      const b = lineOf(door.x);
      const tt = (door.x - b.x0) * b.dx + (door.z - b.z0) * b.dz;
      const px = b.x0 + b.dx * tt;
      const pz = b.z0 + b.dz * tt;
      doorSide = (door.x - px) * b.nx + (door.z - pz) * b.nz;
    }
    ok('C2 the leaves hang outboard of the wall centreline (signed)', doorSide > 0,
      `${doorSide.toFixed(2)} m along the outward normal`);
    // C3: every ramp climbs *away* from its own head, i.e. foot→head runs against `d`.
    let dirWrong = 0;
    let worstDir = 1;
    for (const s of stairs) {
      const dx = s.headX - s.footX;
      const dz = s.headZ - s.footZ;
      const len = Math.hypot(dx, dz) || 1;
      const dot = (dx / len) * s.dx + (dz / len) * s.dz;
      if (dot < 0.999) dirWrong++;
      if (dot < worstDir) worstDir = dot;
    }
    ok('C3 published (dx,dz) is the signed foot→head direction on every flight',
      dirWrong === 0, `worst dot ${worstDir.toFixed(5)}`);
    // C4: every ramp is on the city side of its own bay for its whole length.
    let rampOutside = 0;
    for (const s of stairs) {
      const b = bays[s.bay];
      if (!b) continue;
      for (const p of [[s.footX, s.footZ], [s.headX, s.headZ], [s.topX, s.topZ]]) {
        const tt = (p[0] - b.x0) * b.dx + (p[1] - b.z0) * b.dz;
        const px = b.x0 + b.dx * tt;
        const pz = b.z0 + b.dz * tt;
        const off = (p[0] - px) * b.nx + (p[1] - pz) * b.nz;
        if (off > 0) rampOutside++;
      }
    }
    ok('C4 no part of any ramp is outboard of the wall (signed offsets all ≤ 0)',
      rampOutside === 0, `${rampOutside} outboard points`);
    /**
     * C5: **the ditch is in front of the wall**, signed, and it is the only forward work left.
     *
     * The offset it replaces was the outer and middle lines'. This is the same test on the
     * same axis for the same reason: `CarthageDitch.offset` is measured along the *outward*
     * normal, so a sign error puts a 20 × 6 m trench through the intervallum behind the
     * curtain, where the garrison forms up and where nothing in the pathfinder knows it is.
     * Measured off the published path, point by point, not off the scalar — the scalar is the
     * builder's claim and the path is what a terrain agent will actually cut to.
     */
    const ditchPub = city.getDitch ? city.getDitch() : null;
    let ditchBehind = 0;
    let ditchOffMin = Infinity;
    let ditchOffMax = -Infinity;
    for (const p of ditchPub ? ditchPub.path : []) {
      const b = lineOf(p.x);
      const tt = (p.x - b.x0) * b.dx + (p.z - b.z0) * b.dz;
      const px = b.x0 + b.dx * tt;
      const pz = b.z0 + b.dz * tt;
      const off = (p.x - px) * b.nx + (p.z - pz) * b.nz;
      if (off < ditchOffMin) ditchOffMin = off;
      if (off > ditchOffMax) ditchOffMax = off;
      // Clear of the wall's own footing by at least the berm, on the field side.
      if (!(off - ditchPub.width * 0.5 >= b.halfThickness)) ditchBehind++;
    }
    out.facts.ditchOffsetRange = [ditchOffMin, ditchOffMax];
    out.facts.ditchPathPoints = ditchPub ? ditchPub.path.length : 0;
    ok('C5 the ditch is published on the field side of the wall, clear of it (signed)',
      !!ditchPub && ditchPub.path.length >= 8 && ditchBehind === 0 &&
        Math.abs(ditchOffMax - ditchOffMin) < 0.5,
      ditchPub
        ? `${ditchPub.path.length} points at +${ditchOffMin.toFixed(2)}..+${ditchOffMax.toFixed(2)} m ` +
          `outward, ${ditchBehind} of them inside the wall's footing; ` +
          `counterscarp stands ${(ditchOffMin - ditchPub.width * 0.5 - bays[0].halfThickness).toFixed(2)} m ` +
          'off the outer face'
        : 'no ditch published');

    /**
     * C6: **one line, and all three views agree.**
     *
     * This replaces "there are three lines and the main one overlooks both", which was the
     * command test that made a defence in depth mean something. With one line the claim that
     * has to be checked is the owner's: *the soldiers treat exactly one wall as real.* So
     * sample the whole of the old belt — the killing ground at +24.6 m and the outwork's
     * ground at +41.6 m, the two offsets the removed lines stood on — and require the
     * records, the missile lookup and the movement surface to say the same thing about it.
     *
     * Three views, because each one is a different consumer and this project has shipped a
     * disagreement between exactly this pair before: a raster that was open where the boxes
     * were not, and units routed at a gate the collision surface did not have.
     */
    let owRecords = outworks.length;
    let masonryOut = 0;
    let blockedOut = 0;
    let sampledOut = 0;
    for (const b of bays) {
      const len = Math.hypot(b.x1 - b.x0, b.z1 - b.z0);
      for (let t = 2; t < len - 2; t += 6) {
        const cx = b.x0 + b.dx * t;
        const cz = b.z0 + b.dz * t;
        for (const off of [24.55, 41.55]) {
          const px = cx + b.nx * off;
          const pz = cz + b.nz * off;
          sampledOut++;
          if (Number.isFinite(city.masonryTopAt(px, pz))) masonryOut++;
          // A 3 m step across the old line's own thickness: if masonry were still stamped
          // there this crosses it.
          if (city.blocksMovement(px - b.nx * 3, pz - b.nz * 3, px + b.nx * 3, pz + b.nz * 3)) {
            blockedOut++;
          }
        }
      }
    }
    out.facts.oldBeltSamples = sampledOut;
    out.facts.oldBeltMasonry = masonryOut;
    out.facts.oldBeltBlocked = blockedOut;
    ok('C6 exactly one wall is real, in records, masonryTopAt and blocksMovement alike',
      owRecords === 0 && masonryOut === 0 && blockedOut === 0,
      `${owRecords} forward-line records; over ${sampledOut} stations on the old middle and ` +
        `outer offsets: ${masonryOut} report masonry, ${blockedOut} stop movement`);

    /**
     * C7: permeability, now carried entirely by the main wall.
     *
     * The old C7 measured the forward lines, on the argument that a wall a storming party
     * cannot reach at all is a broken map rather than a harder one. That argument did not
     * belong to the outworks; it belongs to whatever line is in front, and now there is one.
     * Longest run of curtain with no gate and no postern in it, measured off the published
     * gates so a cadence change in the builder cannot slip past.
     */
    const openings = gates
      .map((g) => ({ id: g.id, x: g.x }))
      .sort((a, b) => a.x - b.x);
    let worstSolidRun = 0;
    let worstSolidAt = 0;
    {
      let prev = bays[0].x0;
      for (const o of [...openings, { id: 'east end', x: bays[bays.length - 1].x1 }]) {
        if (o.x - prev > worstSolidRun) { worstSolidRun = o.x - prev; worstSolidAt = prev; }
        prev = o.x;
      }
    }
    out.facts.worstSolidCurtainRun = worstSolidRun;
    ok('C7 no stretch of curtain runs more than 260 m without a gate or a postern',
      worstSolidRun <= 260,
      `longest run ${worstSolidRun.toFixed(0)} m from x=${worstSolidAt.toFixed(0)}, ` +
        `over ${openings.length} openings`);

    // --- the casemate ----------------------------------------------------
    const stalls = casemates.reduce((s, c) => s + c.stalls, 0);
    out.facts.stalls = stalls;
    out.facts.casemateMetres = casemates.reduce(
      (s, c) => s + Math.hypot(c.x1 - c.x0, c.z1 - c.z0), 0);
    ok('E1 the main wall is hollow over most of its length',
      casemates.length >= Math.floor(bays.length * 0.5),
      `${casemates.length} of ${bays.length} bays hollow, ${out.facts.casemateMetres.toFixed(0)} m of gallery`);
    ok('E2 every gallery fits inside its own wall, with cover over the upper vault',
      casemates.every((c) => {
        const b = bays[c.bay];
        return b && c.upperFloorY + c.upperCrown < b.walkY - 1.0 &&
          c.width > 3.0 && Math.abs(c.centreOff) < b.halfThickness;
      }),
      (() => {
        let worst = Infinity;
        for (const c of casemates) {
          const b = bays[c.bay];
          if (b) worst = Math.min(worst, b.walkY - (c.upperFloorY + c.upperCrown));
        }
        return `least cover ${Number.isFinite(worst) ? worst.toFixed(2) : '-'} m`;
      })()
    );
    ok('E3 the galleries state whether they are enterable rather than implying it',
      casemates.every((c) => typeof c.enterable === 'boolean'),
      casemates.length ? `enterable=${casemates[0].enterable}` : 'none');

    /**
     * Posterns: **by id, and shut.**
     *
     * This population has now been wrong twice in opposite directions and both times the
     * assertion above it was right. It was first `id !== gates[0].id`, which counted the two
     * walled-up flanking gatehouses as sally ports and demanded men walk through them. It
     * was then `gg.open`, which was correct only for as long as a postern was a hole — and
     * the moment the eight of them were shut, an `open`-keyed population would have gone
     * silently empty and taken E4, E5, E6 and E7 with it. An empty population passes every
     * `every()` in this file. That is the shape of a green suite that is measuring nothing,
     * so the population is now keyed on the id the builder actually publishes and
     * `E4a` asserts the count before anything asserts a property of it.
     */
    const posterns = gates.filter((gg) => /^postern-/.test(gg.id));
    out.facts.shutGates = gates.filter((gg) => !gg.open).length;
    out.facts.posterns = posterns.length;
    out.facts.openPosterns = posterns.filter((gg) => gg.open).length;
    /**
     * Not `=== 8`. The `?fort=carthage` rig builds this circuit on the Campus Martius
     * heightfield, whose frontage is shorter, so it carries 7 posterns where the Carthage
     * map carries 8. A count pinned to the map is a check that fails on the rig it is run
     * on; a count pinned to zero is no check at all. C7 already guards the spacing.
     */
    ok('E4a the circuit still publishes its posterns, and they are shut',
      posterns.length >= 6 && posterns.every((gg) => !gg.open),
      `${posterns.length} posterns, ${out.facts.openPosterns} of them open`);

    /**
     * E4: a shut postern stands in the collision surface.
     *
     * **This assertion is inverted from the one it replaces, and the inversion is the fix.**
     * It used to read "every postern is really cut out of the obstacle set" and it passed:
     * eight 6 m sally ports were published `open: true`, so `CitySystem.pushWallBox` split
     * the curtain's box at each, `blocksMovement` reported eight open bands across 29 of 990
     * crossing stations, and the wall an assault has to get over had eight ways round it
     * that needed no ram. A postern is a small door, shut and barred; the ground at its
     * centre is masonry-and-timber, not open ground.
     */
    /**
     * **Both skins, not the centreline.** The first draft of this asked whether a wall box
     * contained the postern's own centre and reported all seven open on a wall that stops a
     * man dead. It does not: `buildCarthageWall` publishes a casemated bay as its **two
     * skins** — 1.5 m of field face and 1.2 m of city face with a 6.4 m gallery between them
     * — precisely so the gallery is a place a man can be, and G4 below asserts that emptiness
     * on purpose. The centre of a hollow wall is supposed to be outside the box set. What a
     * shut postern owes the simulation is that neither *skin* is pierced at its station.
     */
    let posternPassable = 0;
    const posternSkins = [];
    for (const p of posterns) {
      const b = lineOf(p.x);
      const gy = terrain ? terrain.heightAt(p.x, p.z) : 0;
      let open = 0;
      for (const off of [b.halfThickness - 0.4, -(b.halfThickness - 0.4)]) {
        if (!boxAt(p.x + b.nx * off, p.z + b.nz * off, gy + 1.0)) open++;
      }
      if (open > 0) { posternPassable++; posternSkins.push(`${p.id}:${open}`); }
    }
    ok('E4 every shut postern stands in the obstacle set, not as a gap in it',
      posterns.length > 0 && posternPassable === 0,
      `${posterns.length} posterns, ${posternPassable} with a pierced skin` +
        `${posternSkins.length ? ` (${posternSkins.join(', ')})` : ''}`);
    ok('E5 blocksMovement agrees with the boxes at every postern',
      posterns.every((p) => {
        const b = lineOf(p.x);
        return city.blocksMovement(
          p.x + b.nx * 14, p.z + b.nz * 14, p.x - b.nx * 14, p.z - b.nz * 14);
      }),
      `${posterns.length} passages tested through the full thickness`);

    // Masonry still stands *over* a postern: a hole at knee height is not a hole in the wall.
    let posternRoofless = 0;
    for (const p of posterns) {
      if (!Number.isFinite(city.masonryTopAt(p.x, p.z))) posternRoofless++;
    }
    ok('E6 the wall still reports a top over every postern',
      posternRoofless === 0, `${posternRoofless} posterns with no masonry over them`);

    /**
     * E7: behind every mouth the passage is a real tunnel, in the **drawn stone**.
     *
     * `probe-wall` has carried this assertion for Rome since a curtain was found built
     * straight through the Porta Flaminia's carriageway. Carthage had no equivalent, and
     * that is exactly how eight posterns came to be published as already-open `GateOut`s —
     * so `CitySystem` cut them out of the collision surface — while `buildPostern` set a
     * pierced arch *panel* into each face and never touched the wall's own body. Measured
     * with these rays before the cut: every postern stopped one at 8.03-8.10 m, the
     * curtain's cityward face, at every height and every lateral offset; `porta-byrsae`
     * stopped one at 8.39-8.67 m with the leaves excluded.
     *
     * E4 and E5 cannot see it. Both grade the *obstacle set*, which agrees with itself; the
     * only instrument that finds a hole in the collision surface with stone standing in it
     * is a ray against the triangles the renderer was given. Möller-Trumbore over `tris`,
     * which is the visible wall chunks only — the gate leaves live in their own chunk and
     * are excluded by name, because a door is not a wall.
     *
     * Rays are cast face to face plus 0.6 m, at three heights and three lateral offsets, so
     * a threshold slab or one badly-aligned sample cannot pass for a passage and a 6 m
     * opening is tested across its width rather than down its centreline.
     */
    const rayHits = (ox, oy, oz, dx, dy, dz, len, T = tris) => {
      let best = Infinity;
      for (let i = 0; i < T.length; i += 9) {
        const e1x = T[i + 3] - T[i], e1y = T[i + 4] - T[i + 1], e1z = T[i + 5] - T[i + 2];
        const e2x = T[i + 6] - T[i], e2y = T[i + 7] - T[i + 1], e2z = T[i + 8] - T[i + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-9 && det < 1e-9) continue;
        const inv = 1 / det;
        const tx = ox - T[i], ty = oy - T[i + 1], tz = oz - T[i + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (s > 1e-4 && s < len && s < best) best = s;
      }
      return best;
    };
    const solidMouths = [];
    let passageRays = 0;
    for (const gt of posterns) {
      const b = lineOf(gt.x);
      const gy = terrain ? terrain.heightAt(gt.x, gt.z) : 0;
      const reach = b.halfThickness + 0.6;
      let worst = Infinity;
      for (const h of [0.8, 1.6, 2.4]) {
        for (const off of [-2, 0, 2]) {
          const ox = gt.x + b.nx * reach + b.dx * off;
          const oz = gt.z + b.nz * reach + b.dz * off;
          passageRays++;
          const t = rayHits(ox, gy + h, oz, -b.nx, 0, -b.nz, reach * 2);
          if (Number.isFinite(t) && t < worst) worst = t;
        }
      }
      if (Number.isFinite(worst)) solidMouths.push(`${gt.id}@${worst.toFixed(2)}m`);
    }
    /**
     * And the main gate, from a metre behind the leaves.
     *
     * The same shape as `probe-wall`'s "behind the leaves the passage is a real tunnel":
     * with the gate shut a ray from the field cannot see past the doors, so the test starts
     * inside them. What the ram opens has to be a road.
     */
    {
      const gy = terrain ? terrain.heightAt(door.x, door.z) : 0;
      for (const h of [1.6, 3.0]) {
        for (const off of [-2, 0, 2]) {
          const ox = door.x - door.nx * 1.0 + door.dx * off;
          const oz = door.z - door.nz * 1.0 + door.dz * off;
          passageRays++;
          const t = rayHits(ox, gy + h, oz, -door.nx, 0, -door.nz, 22);
          if (Number.isFinite(t)) solidMouths.push(`${door.gateId}@${t.toFixed(2)}m`);
        }
      }
    }
    out.facts.passageRays = passageRays;
    out.facts.solidMouths = solidMouths;
    ok('E7 behind every mouth the stone is really cut, not painted',
      solidMouths.length === 0,
      `${passageRays} rays through ${posterns.length} posterns and the Porta Byrsae's ` +
        `carriageway${solidMouths.length ? `; stopped: ${solidMouths.slice(0, 6).join(', ')}` : ', none stopped'}`);

    /**
     * E8: and the guard that was refusing the cut has retired itself.
     *
     * `CitySystem.assertGatePassages` casts its own three rays per build-time-open gate and
     * refuses to punch the collision surface where the stone is solid, because a hole in the
     * obstacle set with masonry standing in it is a man walking through a wall. It is a
     * fail-open guard and it exempts anything the siege opens, so a green E4/E5 with a
     * non-empty verdict here would mean the posterns had been *dropped* rather than cut.
     */
    const unpierced = city.getUnpiercedGates ? city.getUnpiercedGates() : [];
    out.facts.unpiercedGates = [...unpierced];
    ok('E8 no gate stands open with its passage refused',
      unpierced.length === 0,
      unpierced.length ? unpierced.join(', ') : 'getUnpiercedGates() is empty');

    /**
     * E9: and there is something *in* the doorway E7 just proved is empty.
     *
     * E7 and E9 are deliberately opposed, and neither is sufficient alone. E7 casts through
     * the wall chunks and demands the stone be gone; E9 casts through the leaf chunks and
     * demands the timber be there. Pass one and fail the other and you have either r4's
     * postern — an arch painted on solid tufa — or r5's, which is the defect this pass was
     * opened for: a 6 m doorway cut clean through nine metres of curtain with nothing hung
     * in it, and the far ground visible through all eight.
     *
     * The ray height is taken from the **opening's own ground**, not from the ground where
     * the ray starts. `tools/probe-solid.mjs --case=gates` starts 16 m out at
     * `groundAt(start) + h` and 16 m out is inside the ditch, so at h = 1.0 its ray flies
     * four metres under the footing and out the far side; it reported `porta-uticensis` as
     * "mesh CLEAR" at every height while that gate's own obstacle box stopped a man at
     * 11.25 m. A number that cannot be true given its neighbour.
     */
    const doorlessPosterns = [];
    let doorRays = 0;
    for (const gt of posterns) {
      const b = lineOf(gt.x);
      const gy = terrain ? terrain.heightAt(gt.x, gt.z) : 0;
      const reach = b.halfThickness + 3.0;
      let stopped = 0, shots = 0;
      for (const h of [0.8, 1.6, 2.4, 3.2]) {
        for (const off of [-2, 0, 2]) {
          const ox = gt.x + b.nx * reach + b.dx * off;
          const oz = gt.z + b.nz * reach + b.dz * off;
          shots++; doorRays++;
          if (Number.isFinite(rayHits(ox, gy + h, oz, -b.nx, 0, -b.nz, reach * 2, doorTris))) stopped++;
        }
      }
      if (stopped < shots) doorlessPosterns.push(`${gt.id} ${stopped}/${shots}`);
    }
    out.facts.posternDoorRays = doorRays;
    ok('E9 every postern carries a drawn door across its whole opening',
      posterns.length > 0 && doorlessPosterns.length === 0,
      `${doorRays} rays through ${posterns.length} mouths against the leaf chunks` +
        `${doorlessPosterns.length ? `; open: ${doorlessPosterns.slice(0, 8).join(', ')}` : ', none got through'}`);

    // --- G. the spec's own claims ----------------------------------------
    const sec = city.punicSection ? city.punicSection() : null;
    out.facts.section = sec;
    ok('G1 the builder reports no section faults of its own',
      !!sec && sec.faults.length === 0,
      sec ? (sec.faults.length ? sec.faults.join('; ') : 'section closes') : 'not published');

    /**
     * §4.2, and the number moved with the design rather than being left as a claim.
     *
     * The belt was 74.1 m — 20 m ditch, 5 m berm, the outwork, 12 m, the middle wall, 18 m of
     * killing ground and then 9.1 m of curtain — and it bought the spec's 12.4× headline over
     * Rome's six metres. With the two forward lines gone it is the ditch, the berm and the
     * wall: **34.1 m, still 5.7× Rome**, of which 14.1 m is standing masonry and 20 m is a
     * request to the heightfield. Saying which part is which is the whole point of publishing
     * it, and it is why the check is against the builder's own posted arithmetic and not
     * against a literal this file keeps in step by hand.
     */
    const ditch = city.getDitch ? city.getDitch() : null;
    out.facts.beltDepth = sec ? sec.beltDepth : null;
    out.facts.beltBuilt = sec ? sec.beltDepth - (ditch && !ditch.built ? ditch.width : 0) : null;
    const beltWanted = sec ? sec.ditchWidth + sec.berm + sec.mainThickness : NaN;
    ok('G2 the belt is ditch + berm + wall, and says which part of it is built',
      !!sec && Math.abs(sec.beltDepth - beltWanted) < 0.001 && !!ditch && ditch.built === false,
      sec ? `${sec.beltDepth.toFixed(1)} m published (${sec.ditchWidth} ditch + ${sec.berm} berm ` +
        `+ ${sec.mainThickness} wall), ` +
        `${(sec.beltDepth - (ditch ? ditch.width : 0)).toFixed(1)} m built; ` +
        `the ${ditch ? ditch.width : 0} m ditch is a terrain cut and is published as a request`
        : 'not published');

    /**
     * **A ram driven straight at a gate does not get through it.**
     *
     * §4.5's staggered openings were the mechanism — three gaps offset 8 m apart so a ram at
     * the ditch could not see the leaves — and they went with the lines that carried them.
     * The claim they backed is the one that still matters and it is tested unchanged: walk
     * the gate's own outward normal from clear of the ditch to just inside the passage and
     * require the movement surface to stop it. What stops it now is the gate itself — leaves
     * shut and barred at the Porta Byrsae, masonry at the two flanking gatehouses — which is
     * a weaker defence than a 74 m jink and is exactly what the map is meant to have.
     */
    let seeThrough = 0;
    const jinkDetail = [];
    for (const gg of gates) {
      if (gg.open) continue;
      const b = lineOf(gg.x);
      // Beyond the ditch's outer lip, so the walk starts where an engine would be parked.
      const far = 12 + (sec ? sec.ditchOffset + sec.ditchWidth * 0.5 : 30);
      /**
       * **The near end is 12 m *inside* the wall, and that is the whole test.**
       *
       * This assertion used to ask a different question — "no gate can be reached in a
       * straight line through the belt" — and it ran from beyond the ditch to 12 m short of
       * the gate, because what had to stop the walk was the outer and middle lines standing
       * in between. Both of those endpoints are in front of the curtain. With the forward
       * lines gone the segment lies wholly in open ground, and it reported three OPEN gates
       * on a circuit whose gates are shut and barred — a green-to-red flip with no stone
       * moved, which is trap 7: a number that cannot be true beside its neighbour, since C6
       * and G1 both measure masonry standing across those same passages.
       *
       * The claim now is that a shut gate is not a way in, so the walk has to cross the
       * carriageway and come out the other side. `-12` is 3.7 m behind the gatehouse's own
       * inner face at a `gateBlockDepth` of 16.6 m.
       */
      const blocked = city.blocksMovement(
        gg.x + b.nx * far, gg.z + b.nz * far,
        gg.x - b.nx * 12, gg.z - b.nz * 12
      );
      if (!blocked) seeThrough++;
      jinkDetail.push(`${gg.id}:${blocked ? 'shut' : 'OPEN'}`);
    }
    ok('G3 no shut gate can be walked through from the field',
      seeThrough === 0 && gates.some((g) => !g.open), jinkDetail.join(' '));

    /**
     * The casemate is enterable, and this is the assertion that proves it rather than
     * asserting it: at the gallery's own floor level, a point on its centreline is in **no**
     * obstacle, while a point in each of the two skins is in one.
     */
    // A declaration rather than a `const` arrow: E4 above uses it too, and a `const` is in
    // its own temporal dead zone until this line runs.
    function boxAt(px, pz, y) {
      for (const o of obstacles) {
        if (o.kind !== 'wall') continue;
        if (o.topY <= y + 0.05) continue;
        const c = Math.cos(-o.rot), sn = Math.sin(-o.rot);
        const dx = px - o.x, dz = pz - o.z;
        if (Math.abs(dx * c - dz * sn) <= o.hw && Math.abs(dx * sn + dz * c) <= o.hd) return true;
      }
      return false;
    }
    let corridorBlocked = 0;
    let skinOpen = 0;
    let tested = 0;
    for (const c of casemates) {
      const b = bays[c.bay];
      if (!b) continue;
      const len = Math.hypot(c.x1 - c.x0, c.z1 - c.z0);
      for (const frac of [0.25, 0.5, 0.75]) {
        const t = len * frac;
        const cx = c.x0 + c.dx * t;
        const cz = c.z0 + c.dz * t;
        // A postern is a hole in both skins by design; do not ask them to be solid there.
        if (gates.some((gg) => Math.hypot(gg.x - cx, gg.z - cz) < 8)) continue;
        tested++;
        if (boxAt(cx, cz, c.lowerFloorY + 0.5)) corridorBlocked++;
        // A point 0.4 m inside each skin, measured from the bay centreline outward.
        for (const off of [b.halfThickness - 0.4, -(b.halfThickness - 0.4)]) {
          const sx = b.x0 + b.dx * ((cx - b.x0) * b.dx + (cz - b.z0) * b.dz) + b.nx * off;
          const sz = b.z0 + b.dz * ((cx - b.x0) * b.dx + (cz - b.z0) * b.dz) + b.nz * off;
          if (!boxAt(sx, sz, c.lowerFloorY + 0.5)) skinOpen++;
        }
      }
    }
    ok('G4 the gallery is open to movement and both skins are not',
      corridorBlocked === 0 && skinOpen === 0,
      `${tested} stations: ${corridorBlocked} corridor points solid, ${skinOpen} skin points open`);

    /**
     * The counterpart, and the one that keeps this honest: the raster must **not** agree.
     * A 1.5 m skin is not representable in a 4 m cell, so `blocksMovement` reports the wall
     * solid, which is conservative and safe. If it ever starts reporting the corridor open,
     * the two views have drifted in the dangerous direction and a unit will be routed
     * through a wall.
     */
    let rasterOpen = 0;
    for (const c of casemates.slice(0, 24)) {
      const b = bays[c.bay];
      if (!b || b.isGate) continue;
      const len = Math.hypot(c.x1 - c.x0, c.z1 - c.z0);
      const t = len * 0.5;
      const cx = c.x0 + c.dx * t;
      const cz = c.z0 + c.dz * t;
      // Skip anywhere a postern or a gate legitimately cuts the raster.
      if (gates.some((gg) => Math.hypot(gg.x - cx, gg.z - cz) < 18)) continue;
      if (!city.blocksMovement(cx + b.nx * 14, cz + b.nz * 14, cx - b.nx * 14, cz - b.nz * 14)) {
        rasterOpen++;
      }
    }
    ok('G5 the occupancy raster still reports the hollow wall solid, as it must',
      rasterOpen === 0, `${rasterOpen} sections passable in blocksMovement`);

    // Every gallery with an entrance must have a ramp that reaches it at 1 in 6 or shallower.
    const entrances = casemates.filter((c) => c.entranceAt !== null);
    out.facts.galleryEntrances = entrances.length;
    const spanM = bays[bays.length - 1].x1 - bays[0].x0;
    const doorSpacing = entrances.length ? spanM / entrances.length : Infinity;
    out.facts.galleryDoorSpacing = doorSpacing;
    ok('G6 the enterable gallery has doors, at the spec 118 m cadence',
      Math.abs(doorSpacing - 118) <= 20,
      `${entrances.length} access blocks over ${spanM.toFixed(0)} m — one per ` +
        `${doorSpacing.toFixed(0)} m against the spec's 118`);

    // Towers, measured off the stone: the spec's 22.5 m, from the tallest triangle within a
    // tower's own footprint.
    let towerTop = -Infinity;
    let towerGround = 0;
    const towerBay = bays.find((b) => b.hasTower && !b.isGate);
    if (towerBay) {
      towerGround = terrain.heightAt(towerBay.x0, towerBay.z0);
      for (let t = 0; t < tris.length; t += 9) {
        for (let k = 0; k < 3; k++) {
          const px = tris[t + k * 3];
          const pz = tris[t + k * 3 + 2];
          if (Math.hypot(px - towerBay.x0, pz - towerBay.z0) > towerBay.towerHalf) continue;
          if (tris[t + k * 3 + 1] > towerTop) towerTop = tris[t + k * 3 + 1];
        }
      }
    }
    out.facts.towerHeight = towerTop - towerGround;
    ok('G7 a tower stands to the spec 22.5 m, measured off its own triangles',
      Math.abs(towerTop - towerGround - 22.5) <= 1.2,
      `${(towerTop - towerGround).toFixed(2)} m over its own ground vs 22.5 ±1.2`);

    // --- draw calls ------------------------------------------------------
    const info = ctx.renderer.info;
    out.facts.drawCalls = info.render.calls;
    out.facts.renderTriangles = info.render.triangles;

    return out;
  },
  { STEP }
);

if (result.fatal) {
  console.error(`! ${result.fatal}`);
  await browser.close();
  process.exit(2);
}

/**
 * Draw calls, **interleaved**, both arms reported.
 *
 * Cross-session before/after is not a measurement on this project: two runs at identical
 * configuration differ on 50-70% of pixels because the VFX reseed. Draw calls are steadier
 * than pixels, but the framing is not — a figure shot at "the wall camera" means nothing
 * unless the other arm was shot from the same eye. So Rome and Carthage are loaded into the
 * same browser, parked at the same camera relative to each city's own gate, and read back to
 * back; and Carthage is re-shot last as a drift check, because that is the only thing that
 * distinguishes "my wall is cheaper" from "my arms did not restore".
 */
async function armAt(fort) {
  await page.goto(`${base}/?harness=1&fort=${fort}&quality=${QUALITY}&w=1280&h=720`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction('window.__game && window.__game.ready === true', { timeout: 180000 });
  return page.evaluate(async () => {
    const g = window.__game;
    const ctx = g.engine.context;
    const city = ctx.tryGet('city');
    const gate = city.getGates()[0];
    const bays = city.getGarrisonBays();
    // 90 m off the inner face on the gate axis — the framing Rome's 209-call figure is read
    // at — then the same eye from the field, which is where an assault actually looks.
    const shot = async (x, z, zoom) => {
      g.setCamera(x, z, zoom, 0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
      const i = ctx.renderer.info;
      return { calls: i.render.calls, tris: i.render.triangles };
    };
    const inner = await shot(gate.x, gate.z + 90, 0.55);
    const field = await shot(gate.x, gate.z - 150, 0.42, 0);
    // What the fortification itself costs: the wall chunks' own visible meshes.
    let wallMeshes = 0;
    const root = ctx.scene.getObjectByName('city');
    if (root) {
      root.traverse((o) => {
        if (!o.isMesh || !/^wall-\d+/.test(o.name)) return;
        let p = o;
        while (p) { if (p.visible === false) return; p = p.parent; }
        wallMeshes++;
      });
    }
    return { inner, field, wallMeshes, bays: bays.length };
  });
}

const armCarthage = await armAt('carthage');
const armRome = await armAt('aurelian');
const armCarthageAgain = await armAt('carthage');

result.facts.arm_carthage_innerCalls = armCarthage.inner.calls;
result.facts.arm_rome_innerCalls = armRome.inner.calls;
result.facts.arm_carthage_fieldCalls = armCarthage.field.calls;
result.facts.arm_rome_fieldCalls = armRome.field.calls;
result.facts.arm_carthage_wallMeshes = armCarthage.wallMeshes;
result.facts.arm_rome_wallMeshes = armRome.wallMeshes;
result.facts.arm_drift = Math.abs(armCarthageAgain.inner.calls - armCarthage.inner.calls);

result.checks.push({
  name: 'F1 the wall camera stays inside the 220 draw-call cap',
  pass: armCarthage.inner.calls <= 220 && armCarthage.field.calls <= 220,
  detail: `Carthage ${armCarthage.inner.calls} inner / ${armCarthage.field.calls} field, ` +
    `Rome ${armRome.inner.calls} / ${armRome.field.calls}, same session, same eye`,
});
result.checks.push({
  name: 'F3 Carthage\'s wall costs fewer meshes than Rome\'s',
  pass: armCarthage.wallMeshes <= armRome.wallMeshes,
  detail: `Carthage ${armCarthage.wallMeshes} visible wall meshes against Rome's ` +
    `${armRome.wallMeshes}; casemates, 30 towers and three gatehouses all bake into the same ` +
    'four streams, and with the palisade gone `timber` and `metal` survive in one chunk only',
});
result.checks.push({
  name: 'F4 the re-shot base arm did not drift',
  pass: result.facts.arm_drift === 0,
  detail: `${result.facts.arm_drift} calls between the first and last Carthage arm`,
});
result.checks.push({
  name: 'F2 the page booted with no pageerror',
  pass: pageErrors.length === 0,
  detail: pageErrors.length ? pageErrors[0] : 'clean',
});

await browser.close();

const passed = result.checks.filter((c) => c.pass).length;
if (AS_JSON) {
  console.log(JSON.stringify({ ...result, passed, total: result.checks.length }, null, 2));
} else {
  for (const c of result.checks) {
    console.log(`${c.pass ? '  ok ' : '  FAIL'} ${c.name} — ${c.detail}`);
  }
  console.log('');
  for (const [k, v] of Object.entries(result.facts)) {
    console.log(`  · ${k}: ${typeof v === 'number' ? Number(v.toFixed(3)) : JSON.stringify(v)}`);
  }
  console.log(`\n${passed}/${result.checks.length}`);
}
process.exit(passed === result.checks.length ? 0 : 1);
