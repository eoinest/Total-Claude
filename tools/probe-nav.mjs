#!/usr/bin/env node
/**
 * Numerical acceptance tests for navigation against the city's solid geometry.
 *
 * A screenshot cannot show that a cohort walked *through* the Aurelian Wall — from most
 * cameras a man inside 3.5 m of brick is simply hidden by it, and from the others he looks
 * like he is standing in front. So this counts it instead.
 *
 * The ground truth is the city's own masonry occupancy grid, read through the public
 * `blocksMovement(x,z,x,z)` degenerate-segment query and rasterised once into a flat
 * bitmap. Every cell is then classified as wall or building by its distance to the wall
 * polyline, so the two failures the user reported are counted separately.
 *
 * Measurements:
 *   penetration   man-ticks spent inside masonry, split wall / building. Target zero.
 *   reach         can a unit ordered across the wall actually arrive, and by what route.
 *   tower         distance between a unit's issued destination and the siege tower it was
 *                 told to attack.
 *   corridor      free-space width between blocks and the depth of the open ground behind
 *                 the wall, from a distance transform of the same bitmap.
 *   stamp         what the pathfinder actually stamped into its nav grid.
 *
 * Usage:
 *   node tools/probe-nav.mjs --port=5461
 *   node tools/probe-nav.mjs --port=5461 --scenario=assault --seconds=90
 *   node tools/probe-nav.mjs --port=5461 --json=screenshots/nav-before.json
 *   node tools/probe-nav.mjs --port=5461 --only=corridor,stamp
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

const PORT = Number(args.get('port') ?? 5461);
const SECONDS = Number(args.get('seconds') ?? 60);
/** Sim seconds run before the penetration window opens. See `penetration`. */
const WARMUP = Number(args.get('warmup') ?? 100);
const SCENARIO = args.get('scenario') ?? '';
const QUALITY = args.get('quality') ?? 'low';
const JSON_OUT = args.get('json') ?? null;
const ARM = args.get('arm') ?? 'ab';
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

let server = null;
if (!(await waitForServer(base, 1500))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) {
    console.error('vite did not start');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// In-page measurement kit. Everything runs inside one evaluate so a 3,600-tick
// sweep costs one round trip rather than 3,600.
// ---------------------------------------------------------------------------

/**
 * Screen-picking arms, installed before the main kit because they need a dynamic import.
 *
 * the legacy arm is a frozen transcription of the raySolid merge that shipped in 6bf2568 and
 * was reverted in 01db41e. It is copied rather than called so the "before" column keeps
 * meaning something after the real code changes — a reverted commit is a fixed artefact,
 * and re-deriving the number from live code would silently track the fix.
 */
const PICK_ARMS = `
window.__pickArm = (() => {
  let mod = null;
  const ready = import('/src/ui/picking.ts').then((m) => { mod = m; });
  window.__pickReady = ready;

  const V = window.__game.engine.context.camera.position.constructor;
  const O = new V(), D = new V(), T = new V();

  /* 01db41e's raySolid, verbatim in behaviour: tmin starts at 0, baseY defaults to -1e4. */
  const legacyRaySolid = (origin, dir, solids, maxT) => {
    let best = -1;
    for (const s of solids) {
      const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
      const ox = origin.x - s.x, oz = origin.z - s.z;
      const lox = ox * c - oz * sn, loz = ox * sn + oz * c;
      const ldx = dir.x * c - dir.z * sn, ldz = dir.x * sn + dir.z * c;
      let tmin = 0, tmax = maxT;
      for (const [o, d, h] of [[lox, ldx, s.hw], [loz, ldz, s.hd]]) {
        if (Math.abs(d) < 1e-9) { if (o < -h || o > h) { tmin = Infinity; break; } continue; }
        const inv = 1 / d;
        let t1 = (-h - o) * inv, t2 = (h - o) * inv;
        if (t1 > t2) { const w = t1; t1 = t2; t2 = w; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { tmin = Infinity; break; }
      }
      if (!Number.isFinite(tmin)) continue;
      const b = s.baseY ?? -1e4;
      if (Math.abs(dir.y) < 1e-9) {
        if (origin.y < b || origin.y > s.topY) continue;
      } else {
        const inv = 1 / dir.y;
        let t1 = (b - origin.y) * inv, t2 = (s.topY - origin.y) * inv;
        if (t1 > t2) { const w = t1; t1 = t2; t2 = w; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) continue;
      }
      if (tmin >= 0 && tmin <= maxT && (best < 0 || tmin < best)) best = tmin;
    }
    return best;
  };

  const legacy = (cam, nx, ny, heightAt, out, solids) => {
    T.set(nx, ny, 0.5).unproject(cam);
    O.copy(cam.position);
    D.copy(T).sub(O);
    const len = D.length();
    if (len < 1e-6) return false;
    D.multiplyScalar(1 / len);
    const maxDistance = 4200;
    const tSolid = solids && solids.length ? legacyRaySolid(O, D, solids, maxDistance) : -1;
    if (D.y > -0.012) {
      if (tSolid < 0) return false;
      out.x = O.x + D.x * tSolid; out.y = O.y + D.y * tSolid; out.z = O.z + D.z * tSolid;
      return true;
    }
    let t = (O.y - heightAt(O.x, O.z)) / -D.y;
    t = Math.min(t, maxDistance);
    for (let i = 0; i < 4; i++) {
      const x = O.x + D.x * t, z = O.z + D.z * t;
      const nt = (O.y - heightAt(x, z)) / -D.y;
      if (!Number.isFinite(nt)) break;
      t = Math.min(Math.max(nt, 0.1), maxDistance);
    }
    out.x = O.x + D.x * t; out.z = O.z + D.z * t; out.y = heightAt(out.x, out.z);
    if (tSolid >= 0 && tSolid < t) {
      out.x = O.x + D.x * tSolid; out.y = O.y + D.y * tSolid; out.z = O.z + D.z * tSolid;
      return true;
    }
    return t < maxDistance;
  };

  window.__pickOrderPoint = (solids, index, blockers, hx, hz, heightAt, out) => {
    if (!mod || !mod.orderPointForSolid) throw new Error('picking module not loaded');
    mod.orderPointForSolid(solids, index, blockers, hx, hz, heightAt, out);
  };

  return (kind, cam, nx, ny, heightAt, out, solids) => {
    if (kind === 'legacy') return legacy(cam, nx, ny, heightAt, out, solids);
    if (!mod) throw new Error('picking module not loaded — await window.__pickReady');
    if (kind === 'ground') return mod.screenToGround(cam, nx, ny, heightAt, out);
    if (kind === 'order') {
      // Exactly what SelectionController resolves a move order to: the ground, unless a
      // solid stands in front of it, in which case the ground beside that solid.
      if (!mod.screenPick) return mod.screenToGround(cam, nx, ny, heightAt, out);
      const pk = window.__pickScratch || (window.__pickScratch = mod.makeScreenPick());
      mod.screenPick(cam, nx, ny, heightAt, solids, pk);
      if (pk.solid >= 0) {
        mod.orderPointForSolid(solids, pk.solid, solids, pk.solidX, pk.solidZ, heightAt, out);
        return true;
      }
      if (!pk.groundHit) return false;
      out.x = pk.groundX; out.y = pk.groundY; out.z = pk.groundZ;
      return true;
    }
    if (kind === 'object') {
      /*
       * Via screenPick, not screenToSolid, because this arm is also the mask deciding which
       * pixels count as "no solid under the cursor". screenToSolid has no ground clip, so a
       * solid standing *behind* the hill the cursor is actually on counts as a hit and the
       * pixel is wrongly dropped from the open-ground sample. screenPick clips at the
       * terrain, which is the question the mask is asking.
       */
      if (!mod.screenPick) return false;
      const pk = window.__pickScratch || (window.__pickScratch = mod.makeScreenPick());
      mod.screenPick(cam, nx, ny, heightAt, solids, pk);
      if (pk.solid < 0) return false;
      out.x = pk.solidX; out.y = pk.solidY; out.z = pk.solidZ;
      return true;
    }
    throw new Error('unknown pick arm ' + kind);
  };
})();
`;

const KIT = `
window.__nav = (() => {
  const g = window.__game;
  const engine = g.engine;
  const battle = g.battle;
  const ctx = engine.context;
  const city = ctx.tryGet('city') ?? null;
  const nav = ctx.tryGet('pathfinding') ?? null;

  /** Occupancy raster cell, metres. Matches the city's own OCC_CELL so nothing is lost. */
  const CELL = 4;

  /** Wall polyline, world space. */
  const segs = city && city.getWallSegments ? city.getWallSegments() : [];

  /** Distance from (x,z) to the wall polyline, metres. Infinity with no wall. */
  const distToWall = (x, z) => {
    let best = Infinity;
    for (const s of segs) {
      const ax = s.x2 - s.x1, az = s.z2 - s.z1;
      const l2 = ax * ax + az * az;
      let t = l2 < 1e-9 ? 0 : ((x - s.x1) * ax + (z - s.z1) * az) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = s.x1 + ax * t, pz = s.z1 + az * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best) best = d;
    }
    return best;
  };

  /** Z of the wall centreline at x, by nearest segment. */
  const wallZAt = (x) => {
    let best = null, bestD = Infinity;
    for (const s of segs) {
      const lo = Math.min(s.x1, s.x2), hi = Math.max(s.x1, s.x2);
      const d = x < lo ? lo - x : x > hi ? x - hi : 0;
      if (d < bestD) {
        bestD = d;
        const t = Math.abs(s.x2 - s.x1) < 1e-6 ? 0 : (x - s.x1) / (s.x2 - s.x1);
        best = s.z1 + (s.z2 - s.z1) * Math.max(0, Math.min(1, t));
      }
    }
    return best;
  };

  // ---- occupancy raster -----------------------------------------------------
  // Bounds cover the whole walled city plus the ground the besiegers stand on.
  const X0 = -1000, X1 = 1300, Z0 = -900, Z1 = 900;
  const NX = Math.ceil((X1 - X0) / CELL), NZ = Math.ceil((Z1 - Z0) / CELL);
  // 0 free, 1 wall masonry, 2 building / monument.
  const occ = new Uint8Array(NX * NZ);
  const rasterise = () => {
    if (!city || !city.blocksMovement) return { wall: 0, building: 0 };
    let w = 0, b = 0;
    for (let iz = 0; iz < NZ; iz++) {
      const z = Z0 + iz * CELL + CELL * 0.5;
      for (let ix = 0; ix < NX; ix++) {
        const x = X0 + ix * CELL + CELL * 0.5;
        // Degenerate segment: CitySystem returns occAt() of the single cell.
        if (!city.blocksMovement(x, z, x, z)) continue;
        // Wall masonry is 3.5 m thick with towers projecting 3.5 m and 7.6 m wide, so
        // 12 m of the centreline takes the curtain and its towers and nothing else.
        const k = distToWall(x, z) <= 12 ? 1 : 2;
        occ[iz * NX + ix] = k;
        if (k === 1) w++; else b++;
      }
    }
    return { wall: w, building: b };
  };
  const rasterCounts = rasterise();
  const occAt = (x, z) => {
    const ix = Math.floor((x - X0) / CELL), iz = Math.floor((z - Z0) / CELL);
    if (ix < 0 || iz < 0 || ix >= NX || iz >= NZ) return 0;
    return occ[iz * NX + ix];
  };

  /** Metres from (x,z) to the nearest masonry cell, or Infinity beyond maxR. */
  const nearestMasonry = (x, z, maxR) => {
    const rings = Math.ceil(maxR / CELL);
    const ix0 = Math.floor((x - X0) / CELL), iz0 = Math.floor((z - Z0) / CELL);
    let best = Infinity;
    for (let dz = -rings; dz <= rings; dz++) {
      const iz = iz0 + dz;
      if (iz < 0 || iz >= NZ) continue;
      for (let dx = -rings; dx <= rings; dx++) {
        const ix = ix0 + dx;
        if (ix < 0 || ix >= NX) continue;
        if (!occ[iz * NX + ix]) continue;
        const d = Math.hypot(X0 + ix * CELL + CELL * 0.5 - x, Z0 + iz * CELL + CELL * 0.5 - z);
        if (d < best) best = d;
      }
    }
    return best;
  };

  const median = (a) => {
    if (!a.length) return null;
    const s = a.slice().sort((p, q) => p - q);
    return +s[s.length >> 1].toFixed(2);
  };

  /** Proper segment-segment intersection; null when they do not cross. */
  const segIntersect = (ax, az, bx, bz, cx, cz, dx2, dz2) => {
    const r1 = bx - ax, r2 = bz - az;
    const s1 = dx2 - cx, s2 = dz2 - cz;
    const den = r1 * s2 - r2 * s1;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((cx - ax) * s2 - (cz - az) * s1) / den;
    const u = ((cx - ax) * r2 - (cz - az) * r1) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: ax + r1 * t, z: az + r2 * t };
  };

  /**
   * Is a point on the wall centreline somewhere a man may legally cross?
   *
   * Read from the city's own solid set rather than from a list of bay indices: a crossing
   * is legal exactly where the city publishes no wall box. That covers the gate's cut
   * carriageway and the footing bays it deliberately leaves open, and it keeps following
   * the city if another agent closes or opens one. The 0.6 m margin is float slack on the
   * box test, not a tolerance for walking through stone.
   */
  const wallBoxes = (city && city.getObstacles ? city.getObstacles() : []).filter((o) => o.kind === 'wall' || o.kind === 'tower');
  const legalOpening = (x, z) => {
    for (const o of wallBoxes) {
      const c = Math.cos(o.rot), s = Math.sin(o.rot);
      const dx = x - o.x, dz = z - o.z;
      const u = dx * c + dz * s, v = -dx * s + dz * c;
      if (Math.abs(u) <= o.hw + 0.6 && Math.abs(v) <= o.hd + 0.6) return false;
    }
    return true;
  };

  /** Does a segment cross an oriented box's footprint in plan? Slab test in the box frame. */
  const segBoxPlan = (ax, az, bx, bz, o) => {
    const c = Math.cos(o.rot), s = Math.sin(o.rot);
    const ox = ax - o.x, oz = az - o.z;
    const px = ox * c + oz * s, pz = -ox * s + oz * c;
    const rx0 = bx - ax, rz0 = bz - az;
    const rx = rx0 * c + rz0 * s, rz = -rx0 * s + rz0 * c;
    let t0 = 0, t1 = 1;
    for (const [p, r, h] of [[px, rx, o.hw], [pz, rz, o.hd]]) {
      if (Math.abs(r) < 1e-9) { if (p < -h || p > h) return false; continue; }
      let a = (-h - p) / r, b = (h - p) / r;
      if (a > b) { const w = a; a = b; b = w; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return false;
    }
    return true;
  };

  /** Absolute Y of the walkway/masonry top at a point, or -Infinity off the wall. */
  const topAt = (x, z) => (city && city.masonryTopAt ? city.masonryTopAt(x, z) : -Infinity);

  /** Is x within the gatehouse bay, where masonryTopAt cannot see the carriageway? */
  const gates = city && city.getGates ? city.getGates() : [];
  const inGateBay = (x) => {
    for (const gt of gates) if (Math.abs(x - gt.x) <= 20) return true;
    return false;
  };

  /**
   * Bays the city itself treats as passable, so a man standing there is not penetrating
   * anything.
   *
   * A 'footing' bay is a bare 1.1 m plinth course with no wall on it yet: wall.ts pushes
   * no movement blocker for one, and the assault is meant to pour over them. But
   * masonryTopAt still reports crestY there, so a naive 'is his y below the masonry top'
   * test counts every man crossing a breach as being inside the wall. Read off the bay
   * stages the city publishes, which are authored independently of any of this work.
   */
  const bays = city && city.getGarrisonBays ? city.getGarrisonBays() : [];
  const passableBay = (x) => {
    const b = city && city.bayAt ? city.bayAt(x) : undefined;
    if (!b) return true;
    return b.stage === 'footing' || b.isGate === true;
  };
  const bayStageCounts = {};
  for (const b of bays) bayStageCounts[b.stage] = (bayStageCounts[b.stage] ?? 0) + 1;

  // ---- one-tick step with rendering off --------------------------------------
  //
  // Do NOT drive this with repeated engine.advance(1/30) calls. advance() derives its
  // timestamp from time.elapsed, while beginFrame() tracks lastNow and clamps a negative
  // delta to zero. Page loading always leaves lastNow ahead of elapsed (long frames are
  // clamped at 0.25 s, so elapsed falls behind real time), and from then on every
  // single-tick advance() computes raw <= 0, runs zero fixed steps, and leaves elapsed
  // where it was — so the next call computes the same timestamp again. The clock is
  // frozen permanently and silently. Three runs of this probe reported zero penetration
  // in both arms of an A/B before a tick trace showed a unit sitting at (-63.5, 402.9) for
  // forty seconds with a valid move order. qa-determinism.mjs is unaffected because it
  // makes one advance() call with a large step count, where the timestamp increments
  // monotonically inside the loop.
  //
  // Driving engine.frame() from a clock this code owns sidesteps all of it.
  let savedRender;
  let clock = 0;
  const beginSweep = () => {
    engine.stop();
    savedRender = engine.renderOverride;
    // Nothing here reads the frame buffer; skipping the present makes a 3,600-tick
    // sweep take seconds instead of minutes and cannot affect a fixedUpdate.
    engine.renderOverride = () => {};
    ctx.time.resync();
    clock = 0;
    engine.frame(clock); // baseline: establishes lastNow, runs no fixed step
  };
  const endSweep = () => { engine.renderOverride = savedRender; };
  // A hair over a third of a tick, so accumulator rounding can never leave a frame
  // short of one fixed step. 1e-9 of bias is 0.2 ms across a six-thousand-frame sweep.
  const FRAME_MS = (1000 / 30) * (1 + 1e-9);
  const step = () => { clock += FRAME_MS; engine.frame(clock); };

  /**
   * Silence the AI commanders for the duration of a test.
   *
   * The harness runs with autoplay on, so tactical-ai re-thinks every unit several times a
   * second and its move order replaces the probe's within a fraction of a second. The first
   * version of the crossing test ordered eight units across the wall and none of them so
   * much as set off, in either arm, because the AI had already countermanded it. Holding
   * the two commanders still leaves the question the user actually asked: given a move
   * order, does the sim walk a man through masonry?
   *
   * Pathfinding is left running — it is part of what is being tested.
   */
  const held = [];
  const holdAI = () => {
    for (const nm of ['tactical-ai', 'general-ai']) {
      const s = ctx.tryGet(nm);
      if (!s || !s.fixedUpdate) continue;
      held.push([s, s.fixedUpdate]);
      s.fixedUpdate = () => {};
    }
    return held.length;
  };
  const releaseAI = () => {
    for (const [s, fn] of held) s.fixedUpdate = fn;
    held.length = 0;
  };

  return {
    /**
     * Turn the sim's collision off for a controlled A/B on one build.
     *
     * Comparing two git states is not a controlled experiment here: other agents are
     * editing the tree, and between the first two runs of this probe the assault's order
     * of battle changed from 18 units to 32 under me. Emptying the field leaves everything
     * else — scenario, seed, unit count, tick schedule — bit-identical.
     */
    setCollision(on) {
      const before = battle.masonry.count;
      if (on) battle.masonry.set(city && city.getObstacles ? city.getObstacles() : []);
      else battle.masonry.set([]);
      return { was: before, now: battle.masonry.count };
    },

    /**
     * Order one unit across the wall and record what happens, second by second.
     *
     * Written because two successive versions of the crossing test reported eight units
     * ordered and none moved, and guessing at why is exactly how this project has lost
     * time before. This prints the unit's order, destination, anchor and lock state so the
     * reason is visible rather than inferred.
     */
    trace(seconds) {
      const wzAt = wallZAt;
      let unit = null, best = -1;
      for (const u of battle.units) {
        if (u.destroyed || u.alive === 0) continue;
        if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
        const def = battle.typeOf(u);
        if (!def || def.walkSpeed < 1.0) continue;
        const wzx = wzAt(u.x);
        if (wzx === null || u.z >= wzx - 25) continue;
        if (u.alive > best) { best = u.alive; unit = u; }
      }
      if (!unit) return { ok: false, why: 'no candidate' };
      const wzx = wzAt(unit.x);
      const gz = wzx + 150;

      beginSweep();
      const aiHeld = holdAI();
      engine.events.emit('orderIssued', {
        unitIds: [unit.id], kind: 'move', x: unit.x, z: gz, facing: 0, running: true,
      });
      const rows = [];
      const snap = (t) => rows.push({
        t, tick: ctx.time.tick,
        x: +unit.x.toFixed(1), z: +unit.z.toFixed(1),
        order: unit.order, tx: +unit.targetX.toFixed(1), tz: +unit.targetZ.toFixed(1),
        lock: !!unit.contactLock, alive: unit.alive, wps: unit.waypoints.length,
        running: !!unit.running, fatigue: +unit.fatigue.toFixed(2),
      });
      snap(0);
      for (let s = 0; s < seconds; s++) {
        for (let k = 0; k < 30; k++) step();
        snap(s + 1);
      }
      endSweep();
      releaseAI();
      return {
        ok: true, aiHeld, unitId: unit.id, typeId: unit.typeId,
        wallZ: +wzx.toFixed(1), goalZ: +gz.toFixed(1), rows,
      };
    },

    /**
     * Is the inside of the city reachable from outside at all, on the nav grid?
     *
     * A flood fill over exactly the cells A* will admit — not blocked, and clearance at
     * least the search radius. If this reports zero cells inside the circuit then no route
     * exists and the pathfinder is not at fault: the city has been made solid, which is a
     * worse bug than the one being fixed.
     */
    connectivity(radius) {
      if (!nav || !nav.grid) return { ok: false, why: 'no nav grid' };
      const gr = nav.grid;
      const res = gr.res;
      const seen = new Uint8Array(res * res);
      // Start on the besiegers' side, at the centre of the assault frontage.
      const sx = 0;
      const sz = (wallZAt(0) ?? 400) - 90;
      const start = gr.cellAt(sx, sz);
      if (gr.blocked[start]) return { ok: false, why: 'start cell is blocked' };

      const q = new Int32Array(res * res);
      let head = 0, tail = 0;
      q[tail++] = start;
      seen[start] = 1;
      let reached = 0, inside = 0;
      let nearestInside = null, nearestD = Infinity;
      const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
      while (head < tail) {
        const c = q[head++];
        reached++;
        const cx = c % res, cz = (c - cx) / res;
        const wx = gr.toWorld(cx), wz = gr.toWorld(cz);
        const wzx = wallZAt(wx);
        if (wzx !== null && wz > wzx + 20 && wx > -700 && wx < 1200) {
          inside++;
          const d = Math.hypot(wx - sx, wz - sz);
          if (d < nearestD) { nearestD = d; nearestInside = [+wx.toFixed(0), +wz.toFixed(0)]; }
        }
        for (let k = 0; k < 4; k++) {
          const nx = cx + DX[k], nz = cz + DZ[k];
          if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
          const n = nz * res + nx;
          if (seen[n] || gr.blocked[n] || gr.clearance[n] < radius) continue;
          seen[n] = 1;
          q[tail++] = n;
        }
      }

      // And a cross-section through every named gate and every footing bay, so a closed
      // one can be told from an open one.
      const cut = [];
      for (const gt of (city && city.getGates ? city.getGates() : [])) {
        const row = [];
        for (let d = -21; d <= 21; d += 7) {
          const x = gt.x, z = gt.z + d;
          row.push({ d, blocked: gr.blockedAt(x, z), clear: +gr.clearanceAt(x, z).toFixed(1) });
        }
        cut.push({ what: 'gate ' + gt.id + ' x=' + gt.x.toFixed(0), row });
      }
      for (const b of (city && city.getGarrisonBays ? city.getGarrisonBays() : [])) {
        if (b.stage !== 'footing') continue;
        const mx = (b.x0 + b.x1) * 0.5, mz = (b.z0 + b.z1) * 0.5;
        const row = [];
        for (let d = -21; d <= 21; d += 7) {
          row.push({ d, blocked: gr.blockedAt(mx, mz + d), clear: +gr.clearanceAt(mx, mz + d).toFixed(1) });
        }
        cut.push({ what: 'footing bay ' + b.index + ' x=' + mx.toFixed(0), row });
      }
      return {
        ok: true, radius,
        from: { x: sx, z: +sz.toFixed(0) },
        cellsReached: reached, cellsInsideCity: inside,
        nearestInside, nearestInsideDistance: Number.isFinite(nearestD) ? +nearestD.toFixed(0) : null,
        crossSections: cut,
      };
    },

    /**
     * Cost of a fixed step, which is the figure ARCHITECTURE.md actually budgets (4 ms for
     * 6k men). Measured as an A/B on one page so machine load, which moves fps by tens of
     * percent when several agents are running headless Chromium, cancels between the arms.
     */
    perf(ticks) {
      const time = (label) => {
        beginSweep();
        const orig = battle.fixedUpdate.bind(battle);
        const samples = [];
        battle.fixedUpdate = (dt, c) => {
          const t0 = performance.now();
          orig(dt, c);
          samples.push(performance.now() - t0);
        };
        for (let t = 0; t < ticks; t++) step();
        battle.fixedUpdate = orig;
        endSweep();
        samples.sort((a, b) => a - b);
        const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
        return {
          label, n: samples.length,
          mean: +mean.toFixed(3),
          median: +samples[Math.floor(samples.length * 0.5)].toFixed(3),
          p95: +samples[Math.floor(samples.length * 0.95)].toFixed(3),
          max: +samples[samples.length - 1].toFixed(3),
          men: battle.pool.count,
        };
      };
      // Warm the JIT before either arm, or the first one pays for both.
      time('warm');
      const on = time('collision on');
      const wasCount = battle.masonry.count;
      battle.masonry.set([]);
      const off = time('collision off');
      battle.masonry.set(city && city.getObstacles ? city.getObstacles() : []);
      return { on, off, solids: wasCount, deltaMs: +(on.mean - off.mean).toFixed(3) };
    },

    /**
     * Do siege towers and ladders still deliver men onto the wall?
     *
     * A tower docks with its front face 0.32 m clear of the outer masonry, and the
     * soldier collider stands a man off a wall by his own 0.42 m body radius — so the
     * mouth of a boarding ramp sits *inside* the collider by about a tenth of a metre.
     * Men crossing are flagged 'elevated' and exempt, but a man walking to the foot of the
     * ramp to be admitted is not, and if he cannot reach it he never boards. That is the
     * exact way a correct collision fix breaks a siege, so it is measured rather than
     * assumed.
     */
    crossings(seconds) {
      const siege = battle.siege;
      if (!siege || !siege.towerReport) return { ok: false, why: 'no siege' };
      beginSweep();
      for (let t = 0; t < Math.round(seconds * 30); t++) step();
      const towers = siege.towerReport();
      const eng = siege.engineReport ? siege.engineReport() : {};
      endSweep();
      let crossed = 0, docked = 0, queued = 0;
      for (const t of towers) {
        crossed += t.crossed;
        queued += t.queued;
        if (t.docked) docked++;
      }
      return {
        ok: true, seconds,
        towers: towers.length, towersDocked: docked,
        towerCrossed: crossed, towerQueued: queued,
        ladders: eng.ladders ?? null, ladderCrossed: eng.laddersCrossed ?? null,
        towerDetail: towers.map((t) => ({
          id: t.id, state: t.state, faceGap: +t.faceGap.toFixed(2),
          crossed: t.crossed, queued: t.queued,
        })),
      };
    },

    // -----------------------------------------------------------------------
    // Order legality: does the polyline a unit is actually given cross masonry?
    // -----------------------------------------------------------------------

    /**
     * The polyline a unit will actually walk, right now: anchor, current target, queue.
     *
     * This is the thing the player sees as "where it decided to go". Reading it rather
     * than the pathfinder's cache matters, because a route that was computed and never
     * installed is not a route the unit follows, and that gap is precisely where a
     * straight line through the wall survives.
     */
    issuedPath(u) {
      const pts = [u.x, u.z, u.targetX, u.targetZ];
      for (let i = 0; i + 2 < u.waypoints.length + 1; i += 3) {
        if (i + 1 >= u.waypoints.length) break;
        pts.push(u.waypoints[i], u.waypoints[i + 1]);
      }
      return pts;
    },

    /**
     * Metres of a polyline that lie inside masonry, and where.
     *
     * Sampled at 1 m against the same occupancy raster the penetration test uses, so a
     * crossing counted here is a crossing counted there. wallMetres and buildingMetres
     * are split because the user reported them as two different complaints.
     */
    polylineMasonry(pts) {
      let wall = 0, bldg = 0, total = 0;
      let firstWallAt = null;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.ceil(len));
        for (let s = 0; s <= n; s++) {
          const t = s / n;
          const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          const k = occAt(x, z);
          const dl = len / n;
          total += dl;
          if (k === 1) {
            wall += dl;
            if (!firstWallAt) firstWallAt = [+x.toFixed(1), +z.toFixed(1)];
          } else if (k === 2) bldg += dl;
        }
      }
      return {
        wallMetres: +wall.toFixed(1),
        buildingMetres: +bldg.toFixed(1),
        length: +total.toFixed(1),
        firstWallAt,
      };
    },

    /**
     * Metres of a polyline inside the city's actual solid boxes, by kind.
     *
     * Exact oriented-box geometry, not the 4 m occupancy raster polylineMasonry uses. The
     * raster paints a whole 4 m cell whenever its centre is solid, which inflates a 3.5 m
     * wall into a 7.5 m band — the penetration test documents the same artefact — so a route
     * that legitimately runs 2 m from an insula wall registers as being inside it. This is
     * the number to believe about a polyline; the raster one is kept alongside because it is
     * what the man-tick penetration figures are measured against.
     */
    polylineSolids(pts) {
      const boxes = city && city.getObstacles ? city.getObstacles() : [];
      const acc = { wall: 0, tower: 0, building: 0, monument: 0, gate: 0 };
      let inside = 0;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.ceil(len * 4));
        for (let q = 0; q <= n; q++) {
          const t = q / n;
          const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          let hitKind = null;
          for (const o of boxes) {
            const c = Math.cos(o.rot), sn = Math.sin(o.rot);
            const dx = x - o.x, dz = z - o.z;
            if (Math.abs(dx * c + dz * sn) <= o.hw && Math.abs(-dx * sn + dz * c) <= o.hd) { hitKind = o.kind; break; }
          }
          if (hitKind) { acc[hitKind] = (acc[hitKind] ?? 0) + len / n; inside += len / n; }
        }
      }
      for (const k of Object.keys(acc)) acc[k] = +acc[k].toFixed(1);
      return { byKind: acc, totalMetres: +inside.toFixed(1) };
    },

    /**
     * Does the polyline cross the wall's *centreline* anywhere other than a legal opening?
     *
     * Independent of the raster, and stricter: a segment that clips the curtain between
     * two raster samples still registers here. Legal openings are read off the city — the
     * gate's own carriageway and any bay the city publishes no blocker for — so another
     * agent widening or closing an opening changes this test's answer without an edit.
     */
    illegalWallCrossings(pts) {
      const hits = [];
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
        for (const s of segs) {
          const h = segIntersect(ax, az, bx, bz, s.x1, s.z1, s.x2, s.z2);
          if (!h) continue;
          if (legalOpening(h.x, h.z)) continue;
          hits.push([+h.x.toFixed(1), +h.z.toFixed(1)]);
        }
      }
      return hits;
    },

    /**
     * Order units from several positions across the wall and audit the route they get.
     *
     * settleTicks is generous on purpose: BattleSystem.requestRoute queues an A* search
     * and the straight line stands until it lands, so sampling the path too early measures
     * the placeholder rather than the route. It is reported, so a regression that makes
     * routing slower shows up as a rise in routesWithZeroLegs.
     */
    routeAudit(count, settleTicks, depth) {
      const wz0 = wallZAt(0) ?? 0;
      const cands = [];
      for (const u of battle.units) {
        if (u.destroyed || u.alive === 0) continue;
        if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
        const def = battle.typeOf(u);
        if (!def || def.walkSpeed < 1.0) continue;
        const wzx = wallZAt(u.x);
        if (wzx === null || u.z >= wzx - 40) continue;
        cands.push(u);
      }
      // Spread the sample along the wall rather than taking the biggest units, which all
      // stand together: a route from one x tells you nothing about a route from another.
      cands.sort((a, b) => a.x - b.x);
      const picked = [];
      if (cands.length) {
        for (let k = 0; k < count; k++) {
          picked.push(cands[Math.min(cands.length - 1, Math.round((k * (cands.length - 1)) / Math.max(1, count - 1)))]);
        }
      }
      const uniq = [...new Set(picked)];
      if (!uniq.length) return { ok: false, why: 'no mobile unit outside the wall' };

      beginSweep();
      const aiHeld = holdAI();
      const statsBefore = nav ? JSON.parse(JSON.stringify(nav.stats)) : null;
      const rows = [];
      for (const u of uniq) {
        const gx = u.x;
        const gz = (wallZAt(gx) ?? wz0) + (depth ?? 140);
        rows.push({ u, gx, gz, sx: u.x, sz: u.z });
        engine.events.emit('orderIssued', {
          unitIds: [u.id], kind: 'move', x: gx, z: gz,
          facing: Math.atan2(gx - u.x, gz - u.z), running: true,
        });
      }
      // Snapshot the straight-line placeholder before any route can land.
      for (const r of rows) r.immediate = this.polylineMasonry(this.issuedPath(r.u));
      // Tick-by-tick: when does each unit get legs, and what is the search costing?
      const timeline = [];
      let nodes = 0;
      for (let t = 0; t < settleTicks; t++) {
        step();
        if (nav) nodes += nav.stats.nodesLastTick;
        if (t % 10 === 9) {
          timeline.push({
            t: t + 1, nodes,
            queue: nav ? nav.stats.queueDepth : null,
            searches: nav ? nav.stats.searches : null,
            failures: nav ? nav.stats.failures : null,
            withLegs: rows.filter((r) => r.u.waypoints.length > 0).length,
          });
        }
      }
      const out = [];
      for (const r of rows) {
        // What the pathfinder was asked and what came back, so a route that never arrived
        // is distinguishable from a route that arrived and crossed masonry anyway.
        const key = r.u.id + 1000000;
        const pp = nav && nav.pathFor ? nav.pathFor(key) : null;
        r.nav = {
          pending: nav ? nav.pending(key) : null,
          n: pp ? pp.n : 0, ok: pp ? !!pp.ok : null,
          length: pp ? +pp.length.toFixed(1) : null,
          goal: pp ? [+pp.goalX.toFixed(1), +pp.goalZ.toFixed(1)] : null,
          startClear: nav ? nav.isStandable(r.sx, r.sz, 2.2) : null,
          goalClear: nav ? nav.isStandable(r.gx, r.gz, 2.2) : null,
          // The three tests BattleSystem.requestRoute short-circuits on, evaluated on the
          // same straight line it evaluated. If directClear is true no search is ever
          // queued and the straight line through the wall simply stands.
          directClear: nav ? nav.directRouteClear(r.sx, r.sz, r.gx, r.gz, 2.2) : null,
          corridorClear: nav && nav.grid ? nav.grid.corridorClear(r.sx, r.sz, r.gx, r.gz, 2.2) : null,
          cityBlocks: city && city.blocksMovement ? city.blocksMovement(r.sx, r.sz, r.gx, r.gz) : null,
        };
        const pts = this.issuedPath(r.u);
        const m = this.polylineMasonry(pts);
        const exact = this.polylineSolids(pts);
        const illegal = this.illegalWallCrossings(pts);
        const straight = Math.hypot(r.gx - r.sx, r.gz - r.sz);
        out.push({
          unitId: r.u.id,
          start: [+r.sx.toFixed(1), +r.sz.toFixed(1)],
          goal: [+r.gx.toFixed(1), +r.gz.toFixed(1)],
          legs: (pts.length >> 1) - 1,
          straightLine: +straight.toFixed(1),
          pathLength: m.length,
          ratio: +(m.length / Math.max(1, straight)).toFixed(2),
          wallMetres: m.wallMetres,
          buildingMetres: m.buildingMetres,
          exactSolidMetres: exact.totalMetres,
          exactByKind: exact.byKind,
          illegalCrossings: illegal.length,
          firstWallAt: m.firstWallAt,
          immediateWallMetres: r.immediate.wallMetres,
          nav: r.nav,
          via: (() => { const v = []; for (let q = 0; q < pts.length; q += 2) v.push([+pts[q].toFixed(0), +pts[q + 1].toFixed(0)]); return v; })(),
        });
      }
      endSweep();
      releaseAI();
      // The pass line is the exact-geometry one and it counts every kind of solid. An
    // earlier version filtered on wallMetres alone and printed "ROUTES CROSSING MASONRY
    // 0 / 8" while every one of the eight ran through insulae.
    const badExact = out.filter((r) => r.exactSolidMetres > 0 || r.illegalCrossings > 0);
    const bad = out.filter((r) => r.wallMetres > 0 || r.illegalCrossings > 0);
      const statsAfter = nav ? JSON.parse(JSON.stringify(nav.stats)) : null;
      return {
        ok: true, aiHeld, settleTicks, ordered: out.length,
        // Differenced where the field is a counter; gauges are reported as they stand,
        // because subtracting two readings of a queue depth is meaningless.
        navStats: statsBefore && statsAfter
          ? Object.fromEntries(Object.keys(statsAfter).map((k) => [
            k, (k === 'queueDepth' || k === 'nodesLastTick') ? statsAfter[k] : statsAfter[k] - statsBefore[k],
          ]))
          : null,
        timeline,
        routesCrossingWall: bad.length,
        routesInsideAnySolid: badExact.length,
        totalExactSolidMetres: +out.reduce((a, r) => a + r.exactSolidMetres, 0).toFixed(1),
        totalPathMetres: +out.reduce((a, r) => a + r.pathLength, 0).toFixed(1),
        routesWithZeroLegs: out.filter((r) => r.legs <= 1).length,
        medianRatio: median(out.map((r) => r.ratio)),
        rows: out,
      };
    },

    /**
     * The attack order, which the player says walks a straight line into the wall.
     *
     * Picks the nearest enemy on the far side of the curtain from a mobile unit on the
     * near side, issues attack, and audits the same polyline routeAudit does. Then it
     * runs the clock so the difference between "the order is illegal" and "the order is
     * illegal and the unit is stuck against masonry" is visible.
     */
    attackAudit(seconds) {
      let att = null, tgt = null, bestD = Infinity;
      for (const u of battle.units) {
        if (u.destroyed || u.alive === 0) continue;
        if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
        const def = battle.typeOf(u);
        if (!def || def.walkSpeed < 1.0) continue;
        const wzu = wallZAt(u.x);
        if (wzu === null || u.z >= wzu - 30) continue;
        for (const e of battle.units) {
          if (e.destroyed || e.alive === 0 || e.faction === u.faction) continue;
          const wze = wallZAt(e.x);
          if (wze === null || e.z <= wze + 15) continue;
          const d = Math.hypot(e.x - u.x, e.z - u.z);
          if (d < bestD) { bestD = d; att = u; tgt = e; }
        }
      }
      if (!att || !tgt) return { ok: false, why: 'no attacker outside / target inside' };

      beginSweep();
      const aiHeld = holdAI();
      const sx = att.x, sz = att.z;
      engine.events.emit('orderIssued', { unitIds: [att.id], kind: 'attack', targetUnitId: tgt.id });
      // One tick so the order is resolved into a destination before the path is read.
      step();
      const pts0 = this.issuedPath(att);
      const m0 = this.polylineMasonry(pts0);
      const ill0 = this.illegalWallCrossings(pts0);

      // Let any route that is going to arrive, arrive.
      for (let t = 0; t < 90; t++) step();
      const pts1 = this.issuedPath(att);
      const m1 = this.polylineMasonry(pts1);
      const e1 = this.polylineSolids(pts1);
      const ill1 = this.illegalWallCrossings(pts1);

      let travelled = 0, px = att.x, pz = att.z, ticksInMasonry = 0;
      for (let t = 0; t < Math.round(seconds * 30); t++) {
        step();
        travelled += Math.hypot(att.x - px, att.z - pz);
        px = att.x; pz = att.z;
        if (occAt(att.x, att.z)) ticksInMasonry++;
      }
      endSweep();
      releaseAI();
      const gap = Math.hypot(att.x - tgt.x, att.z - tgt.z);
      return {
        ok: true, aiHeld, attacker: att.id, target: tgt.id,
        start: [+sx.toFixed(1), +sz.toFixed(1)],
        targetAt: [+tgt.x.toFixed(1), +tgt.z.toFixed(1)],
        straightLine: +bestD.toFixed(1),
        immediate: { legs: (pts0.length >> 1) - 1, wallMetres: m0.wallMetres, buildingMetres: m0.buildingMetres, illegal: ill0.length },
        settled: { legs: (pts1.length >> 1) - 1, wallMetres: m1.wallMetres, buildingMetres: m1.buildingMetres, exactSolidMetres: e1.totalMetres, illegal: ill1.length, length: m1.length },
        after: {
          seconds, travelled: +travelled.toFixed(1),
          end: [+att.x.toFixed(1), +att.z.toFixed(1)],
          gapToTarget: +gap.toFixed(1),
          ticksInMasonry,
          crossedWall: att.z > (wallZAt(att.x) ?? 0) + 6,
        },
      };
    },

    /**
     * Do the ordered units actually get there, and how many end up jammed on masonry?
     *
     * stuck is deliberately behavioural rather than geometric: a unit is stuck if it has
     * a live move order, is more than tol from its goal, and has moved less than 2 m in
     * the last five seconds. againstWall narrows that to the ones parked within 10 m of
     * masonry, which is the failure the player described.
     */
    arrival(count, seconds, tol, longSeconds) {
      const cands = [];
      for (const u of battle.units) {
        if (u.destroyed || u.alive === 0) continue;
        if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
        const def = battle.typeOf(u);
        if (!def || def.walkSpeed < 1.0) continue;
        const wzx = wallZAt(u.x);
        if (wzx === null || u.z >= wzx - 40) continue;
        cands.push(u);
      }
      cands.sort((a, b) => a.x - b.x);
      const picked = [];
      for (let k = 0; k < count && cands.length; k++) {
        picked.push(cands[Math.min(cands.length - 1, Math.round((k * (cands.length - 1)) / Math.max(1, count - 1)))]);
      }
      const uniq = [...new Set(picked)];
      if (!uniq.length) return { ok: false, why: 'no mobile unit outside the wall' };

      beginSweep();
      const aiHeld = holdAI();
      const st = uniq.map((u) => {
        const gx = u.x, gz = (wallZAt(u.x) ?? 0) + 140;
        engine.events.emit('orderIssued', {
          unitIds: [u.id], kind: 'move', x: gx, z: gz,
          facing: Math.atan2(gx - u.x, gz - u.z), running: true,
        });
        return { u, gx, gz, hist: [], arrivedAt: null, minDist: Infinity, at60: null };
      });
      /*
       * Two horizons, because one of them answers the wrong question.
       *
       * Sixty seconds is what was asked for and is reported as such, but the legal routes
       * these orders produce run 250 to 540 m through a single 4.3 m gate, and a cohort
       * marches at about 3 m/s. Judging "did it arrive" at 60 s therefore measures the
       * length of the detour, not whether the navigation works. The long horizon is the
       * honest completion figure, and progress — how much of the initial gap was closed —
       * is what says a unit is making its way rather than sitting down.
       */
      const shortTicks = Math.round(seconds * 30);
      const ticks = Math.round(Math.max(seconds, longSeconds) * 30);
      const startGap = st.map((s) => Math.hypot(s.u.x - s.gx, s.u.z - s.gz));
      for (let t = 0; t < ticks; t++) {
        step();
        if (t % 15 === 0) for (const s of st) { s.hist.push([s.u.x, s.u.z]); if (s.hist.length > 11) s.hist.shift(); }
        for (let i = 0; i < st.length; i++) {
          const s = st[i];
          const d = Math.hypot(s.u.x - s.gx, s.u.z - s.gz);
          if (d < s.minDist) s.minDist = d;
          if (s.arrivedAt === null && d < tol) s.arrivedAt = +(t / 30).toFixed(1);
          if (t === shortTicks - 1) {
            s.at60 = {
              remaining: +d.toFixed(1),
              arrived: s.arrivedAt !== null,
              moved5s: s.hist.length >= 2
                ? +Math.hypot(s.hist[s.hist.length - 1][0] - s.hist[0][0], s.hist[s.hist.length - 1][1] - s.hist[0][1]).toFixed(1)
                : 0,
              masonry: nearestMasonry(s.u.x, s.u.z, 14),
              locked: !!s.u.contactLock,
            };
          }
        }
      }
      endSweep();
      releaseAI();
      let arrived = 0, stuck = 0, againstWall = 0;
      let arrived60 = 0, stuck60 = 0, againstWall60 = 0;
      const rows = st.map((s, i) => {
        const d = Math.hypot(s.u.x - s.gx, s.u.z - s.gz);
        const h = s.hist;
        const moved5s = h.length >= 2 ? Math.hypot(h[h.length - 1][0] - h[0][0], h[h.length - 1][1] - h[0][1]) : 0;
        const nearWall = nearestMasonry(s.u.x, s.u.z, 14);
        // A unit held by an enemy it has run into is doing its job, not stuck.
        const isStuck = d >= tol && moved5s < 2 && !s.u.contactLock;
        if (s.arrivedAt !== null) arrived++;
        if (isStuck) { stuck++; if (nearWall <= 10) againstWall++; }
        const a = s.at60;
        if (a) {
          if (a.arrived) arrived60++;
          const st60 = !a.arrived && a.moved5s < 2 && !a.locked;
          if (st60) { stuck60++; if (a.masonry <= 10) againstWall60++; }
        }
        return {
          unitId: s.u.id, goal: [+s.gx.toFixed(0), +s.gz.toFixed(0)],
          end: [+s.u.x.toFixed(1), +s.u.z.toFixed(1)],
          startGap: +startGap[i].toFixed(1),
          remaining: +d.toFixed(1), closest: +s.minDist.toFixed(1),
          progress: +(1 - Math.min(1, d / Math.max(1, startGap[i]))).toFixed(3),
          remainingAt60: a ? a.remaining : null,
          arrivedAt: s.arrivedAt, stuck: isStuck,
          movedLast5s: +moved5s.toFixed(1),
          contactLocked: !!s.u.contactLock,
          metresToMasonry: nearWall === Infinity ? null : +nearWall.toFixed(1),
          order: s.u.order, waypoints: s.u.waypoints.length,
        };
      });
      return {
        ok: true, aiHeld, seconds, longSeconds, tol, ordered: rows.length,
        at60: {
          arrived: arrived60, arrivedFraction: +(arrived60 / rows.length).toFixed(3),
          stuck: stuck60, stuckAgainstWall: againstWall60,
        },
        arrived, arrivedFraction: +(arrived / rows.length).toFixed(3),
        stuck, stuckAgainstWall: againstWall,
        medianProgress: median(rows.map((r) => r.progress)),
        rows,
      };
    },

    // -----------------------------------------------------------------------
    // Destination accuracy: does a click land where the player pointed?
    // -----------------------------------------------------------------------

    /**
     * Round-trip a set of world points the player can unambiguously see.
     *
     * Ground truth is exact by construction: take a world point, project it to the screen
     * with the real camera, then ask the picker what that screen position means. Any
     * difference is the error the player experiences, in metres, with no judgement call
     * about "where they meant".
     *
     * Only points with a clear line of sight are used, and clear is decided *in plan*: no
     * solid's footprint may lie between the eye and the target at all. That is stricter
     * than real occlusion and it has to be, because the city publishes topY = 1e4 for
     * every insula — the boxes carry no real roof height, so no height-aware visibility
     * test against them can be trusted. A point that passes this test is visible whatever
     * the true roof heights are, so a correct picker has no excuse.
     */
    pickAccuracy(camX, camZ, zoom, yaw, arms) {
      const terrain = ctx.tryGet('terrain');
      if (!terrain) return { ok: false, why: 'no terrain' };
      const heightAt = (x, z) => terrain.heightAt(x, z);
      const solids = city && city.getObstacles ? city.getObstacles() : [];
      g.setCamera(camX, camZ, zoom, yaw);
      ctx.camera.updateMatrixWorld(true);
      const cam = ctx.camera;
      const eye = cam.position;
      const V = eye.constructor;
      const PROJ = new V(), RAY = new V();

      /*
       * The reference answer, computed by a method that shares no code with anything
       * under test: march the ray in 0.5 m steps until it passes below the heightfield,
       * then bisect 24 times. Slow and dumb on purpose. screenToGround uses a fixed-point
       * iteration, so if the two ever disagree the disagreement is real and not a shared
       * mistake, and this project has already been burned once by a probe that computed
       * its expected answer with the same code it was grading.
       */
      const marchToGround = (nx, ny, outv) => {
        RAY.set(nx, ny, 0.5).unproject(cam).sub(eye);
        const len = RAY.length();
        if (len < 1e-6) return false;
        RAY.multiplyScalar(1 / len);
        if (RAY.y > -1e-4) return false;
        let lo = 0, hi = -1;
        for (let t = 0.5; t <= 4200; t += 0.5) {
          const y = eye.y + RAY.y * t;
          if (y <= heightAt(eye.x + RAY.x * t, eye.z + RAY.z * t)) { hi = t; break; }
          lo = t;
        }
        if (hi < 0) return false;
        for (let i = 0; i < 24; i++) {
          const m = (lo + hi) * 0.5;
          const y = eye.y + RAY.y * m;
          if (y <= heightAt(eye.x + RAY.x * m, eye.z + RAY.z * m)) hi = m; else lo = m;
        }
        const t = (lo + hi) * 0.5;
        outv.x = eye.x + RAY.x * t;
        outv.y = eye.y + RAY.y * t;
        outv.z = eye.z + RAY.z * t;
        outv.t = t;
        return true;
      };

      /*
       * Is that ground point one the player can unambiguously see?
       *
       * Decided in plan: no solid footprint may lie between the eye and the point at all.
       * That is stricter than real occlusion and it has to be, because the city publishes
       * topY = 1e4 for every insula and monument — 1,730 of its 1,826 boxes carry no real
       * roof height, so no height-aware visibility test against them can be trusted. A
       * point that survives this is visible whatever the true roofs are, which means a
       * picker that misses it has no excuse.
       */
      const eyeInside = (s) => {
        const c = Math.cos(s.rot), sn = Math.sin(s.rot);
        const dx = eye.x - s.x, dz = eye.z - s.z;
        return Math.abs(dx * c + dz * sn) <= s.hw && Math.abs(-dx * sn + dz * c) <= s.hd;
      };
      let insideCount = 0;
      for (const s of solids) if (eyeInside(s)) insideCount++;

      const visible = (ax, az, bx, bz) => {
        for (const s of solids) {
          // A box the eye is standing inside cannot occlude anything: it intersects every
          // segment from the eye by definition, and the game plainly draws the world from
          // there. Without this exclusion the whole test silently returns zero samples at
          // exactly the camera where the regression fires, which is how it would be missed.
          if (eyeInside(s)) continue;
          if (segBoxPlan(ax, az, bx, bz, s)) return false;
        }
        return true;
      };

      const ref = { x: 0, y: 0, z: 0, t: 0 };
      const errs = {};
      /*
       * A second set of numbers over *every* pixel that hits ground, visible or not.
       *
       * The strict-visibility set is the right way to ask "does a click land where I
       * pointed", but deep inside Rome it is empty — from a 35 m camera on an insula, no
       * pixel has a clean sight line in plan — and an empty set silently passes. So the
       * reported symptom is measured directly as well: the reverted merge made every click
       * resolve onto the camera's own position, so what is counted here is how many
       * resolved points land within 3 m of the eye, and how far apart the answers spread.
       * Neither needs a judgement about what the player could see.
       */
      const allErrs = {};
      // And, for the order arm, the same error restricted to pixels with no solid under the
      // cursor. On a solid the order point is *meant* to differ from the ground behind it —
      // that is the whole feature — so grading it there against a ground reference measures
      // the fix as if it were the bug.
      const openErrs = {};
      const spread = {};
      for (const k of arms) {
        errs[k] = []; allErrs[k] = []; openErrs[k] = [];
        spread[k] = { n: 0, onEye: 0, x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9, distinct: new Set() };
      }
      let onScreen = 0, visibleN = 0, roundTripWorst = 0, solidPixels = 0;
      const refSpread = { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 };
      // A 17 x 11 lattice over the central 90% of the frame. Sampling screen space rather
      // than world space keeps the coverage the same at every pitch and field of view;
      // the world lattice this replaced put every target off-frame at low zoom.
      for (let iy = 0; iy < 11; iy++) {
        for (let ix = 0; ix < 17; ix++) {
          const nx = -0.9 + (1.8 * ix) / 16;
          const ny = -0.9 + (1.8 * iy) / 10;
          if (!marchToGround(nx, ny, ref)) continue;
          onScreen++;
          if (ref.x < refSpread.x0) refSpread.x0 = ref.x;
          if (ref.x > refSpread.x1) refSpread.x1 = ref.x;
          if (ref.z < refSpread.z0) refSpread.z0 = ref.z;
          if (ref.z > refSpread.z1) refSpread.z1 = ref.z;
          const probeSolid = { x: 0, y: 0, z: 0 };
          const onSolid = arms.includes('object')
            && window.__pickArm('object', cam, nx, ny, heightAt, probeSolid, solids);
          for (const k of arms) {
            const o = { x: 0, y: 0, z: 0 };
            if (!window.__pickArm(k, cam, nx, ny, heightAt, o, solids)) continue;
            if (!onSolid) openErrs[k].push(Math.hypot(o.x - ref.x, o.z - ref.z));
            const sp = spread[k];
            sp.n++;
            // Rounded to half a metre: the number of *distinct* destinations a frame can
            // produce is the sharpest collapse detector there is, and it needs no notion of
            // what the player could see. 651 pixels giving 622 answers is healthy; 5 pixels
            // spanning 9 m of wall giving 1 answer is the bug.
            sp.distinct.add(Math.round(o.x * 2) + ',' + Math.round(o.z * 2));
            if (Math.hypot(o.x - eye.x, o.z - eye.z) <= 3) sp.onEye++;
            if (o.x < sp.x0) sp.x0 = o.x;
            if (o.x > sp.x1) sp.x1 = o.x;
            if (o.z < sp.z0) sp.z0 = o.z;
            if (o.z > sp.z1) sp.z1 = o.z;
            allErrs[k].push(Math.hypot(o.x - ref.x, o.z - ref.z));
          }
          if (occAt(ref.x, ref.z)) continue;
          if (!visible(eye.x, eye.z, ref.x, ref.z)) continue;
          // The reference must land back on the pixel it came from, or it is not the
          // ground under that pixel and nothing can be concluded from it.
          PROJ.set(ref.x, ref.y, ref.z).project(cam);
          const back = Math.hypot(PROJ.x - nx, PROJ.y - ny);
          if (back > 2e-3) continue;
          if (back > roundTripWorst) roundTripWorst = back;
          visibleN++;
          for (const k of arms) {
            const o = { x: 0, y: 0, z: 0 };
            const ok = window.__pickArm(k, cam, nx, ny, heightAt, o, solids);
            errs[k].push(ok ? Math.hypot(o.x - ref.x, o.z - ref.z) : -1);
          }
        }
      }

      const pitchDeg = +(Math.atan2(eye.y - heightAt(camX, camZ), Math.hypot(eye.x - camX, eye.z - camZ)) * 180 / Math.PI).toFixed(1);
      // Height above the ground under the eye, not absolute Y. "eye 37 m" over a 31 m hill
      // is a six-metre camera, and quoting the absolute number flatters the test.
      const aboveGround = +(eye.y - heightAt(eye.x, eye.z)).toFixed(1);
      const res = {
        ok: true,
        camera: { x: camX, z: camZ, zoom, yaw, eyeY: +eye.y.toFixed(1), aboveGround, pitchDeg },
        eyeInsideSolids: insideCount,
        pixelsHittingGround: onScreen, samples: visibleN,
        solidPixels: spread.object ? spread.object.n : 0,
        // How wide the ground actually visible in this frame is, so an arm's own spread
        // can be read as a fraction of it rather than as a bare number of metres.
        referenceSpreadM: onScreen ? +Math.hypot(refSpread.x1 - refSpread.x0, refSpread.z1 - refSpread.z0).toFixed(1) : null,
        referenceRoundTripNdc: +roundTripWorst.toFixed(5),
        arms: {},
      };
      for (const k of arms) {
        const good = errs[k].filter((v) => v >= 0).sort((a, b) => a - b);
        const missed = errs[k].filter((v) => v < 0).length;
        res.arms[k] = {
          resolved: good.length, unresolved: missed,
          medianM: good.length ? +good[good.length >> 1].toFixed(2) : null,
          meanM: good.length ? +(good.reduce((s, v) => s + v, 0) / good.length).toFixed(2) : null,
          p95M: good.length ? +good[Math.min(good.length - 1, Math.floor(good.length * 0.95))].toFixed(2) : null,
          maxM: good.length ? +good[good.length - 1].toFixed(2) : null,
          within2m: good.length ? +(good.filter((v) => v <= 2).length / good.length).toFixed(3) : null,
        };
        const sp = spread[k];
        const all = allErrs[k].slice().sort((a, b) => a - b);
        res.arms[k].allPixels = {
          resolved: sp.n,
          onEyeFraction: sp.n ? +(sp.onEye / sp.n).toFixed(3) : null,
          spreadM: sp.n ? +Math.hypot(sp.x1 - sp.x0, sp.z1 - sp.z0).toFixed(1) : null,
          distinctDestinations: sp.distinct.size,
          spreadFractionOfView: sp.n && onScreen
            ? +(Math.hypot(sp.x1 - sp.x0, sp.z1 - sp.z0)
              / Math.max(1e-6, Math.hypot(refSpread.x1 - refSpread.x0, refSpread.z1 - refSpread.z0))).toFixed(3)
            : null,
          medianErrM: all.length ? +all[all.length >> 1].toFixed(2) : null,
          p95ErrM: all.length ? +all[Math.min(all.length - 1, Math.floor(all.length * 0.95))].toFixed(2) : null,
        };
        const open = openErrs[k].slice().sort((a, b) => a - b);
        res.arms[k].openGroundPixels = {
          n: open.length,
          medianErrM: open.length ? +open[open.length >> 1].toFixed(2) : null,
          p95ErrM: open.length ? +open[Math.min(open.length - 1, Math.floor(open.length * 0.95))].toFixed(2) : null,
          maxErrM: open.length ? +open[open.length - 1].toFixed(2) : null,
        };
      }
      return res;
    },

    /** Where a right-click on a siege tower actually sends the order. */
    towerPick(arms) {
      const terrain = ctx.tryGet('terrain');
      const siege = battle.siege;
      const towers = siege && siege.towerReport ? siege.towerReport() : [];
      if (!towers.length || !terrain) return { ok: false, why: 'no siege towers' };
      const heightAt = (x, z) => terrain.heightAt(x, z);
      const T = towers[0];
      // Aim the camera at the tower from a normal playing distance and pitch.
      g.setCamera(T.x, T.z - 120, 0.45, 0);
      ctx.camera.updateMatrixWorld(true);
      const cam = ctx.camera;
      const PROJ = new (Object.getPrototypeOf(cam.position).constructor)();
      // Two metres below the deck: the body of the machine, which is what a player clicks.
      const aimY = T.deckY - 2;
      PROJ.set(T.x, aimY, T.z).project(cam);
      // The set SelectionController actually tests the cursor against — the curtain, its
      // towers and the siege train — read off the live controller so the probe cannot drift
      // from it. Falls back to the raw city obstacles if the HUD is not up.
      const hud = ctx.tryGet('hud');
      const shipped = (hud && hud.controller && hud.controller.pickSolids)
        || (city && city.getObstacles ? city.getObstacles() : []);
      // The legacy arm must be fed the legacy *input* as well as the legacy code. At
      // 6bf2568 SelectionController handed city.getObstacles() straight through, and that
      // array contains no siege engine at all — which is exactly why a click on a tower
      // resolved on the grass behind it. Feeding it the shipped pick set, which only exists
      // because of the fix, flatters it into looking correct.
      const raw = city && city.getObstacles ? city.getObstacles() : [];
      const out = {
        ok: true, tower: { x: +T.x.toFixed(1), z: +T.z.toFixed(1), deckY: +T.deckY.toFixed(1) },
        pickSet: shipped.length, legacySet: raw.length,
        ndc: [+PROJ.x.toFixed(3), +PROJ.y.toFixed(3)], arms: {},
      };
      for (const k of arms) {
        const o = { x: 0, y: 0, z: 0 };
        const solids = k === 'legacy' ? raw : shipped;
        const ok = window.__pickArm(k, cam, PROJ.x, PROJ.y, heightAt, o, solids);
        out.arms[k] = ok
          ? { at: [+o.x.toFixed(1), +o.z.toFixed(1)], offsetM: +Math.hypot(o.x - T.x, o.z - T.z).toFixed(1) }
          : { at: null, offsetM: null };
      }
      return out;
    },

    /**
     * Cost of the AI's navigation with both commanders live, and what it is doing.
     *
     * perf() above times BattleSystem alone; the branch-and-bound bound and the per-search
     * cap live in PathfindingSystem, and a change that made the AI re-request routes in a
     * loop would show up here and nowhere else. Both systems are timed, plus the whole
     * fixed step, against the 4 ms budget.
     */
    navPerf(seconds, orders) {
      const nv = ctx.tryGet('pathfinding');
      if (!nv) return { ok: false, why: 'no pathfinding' };
      beginSweep();
      const before = JSON.parse(JSON.stringify(nv.stats));
      /*
       * Time EVERY system's fixedUpdate, not just the two this file cares about.
       *
       * ARCHITECTURE.md budgets the whole fixed step at 4 ms, and pathfinding plus battle is
       * 78% of it in the assault and 93% in the field — so reporting only those two
       * understates the budgeted quantity by about a fifth. An earlier version of this
       * function claimed in its own docstring to time the step and did not.
       */
      const wrapped = [];
      const stepMs = [];
      let stepAcc = 0;
      for (const sys of engine.systems) {
        if (typeof sys.fixedUpdate !== 'function') continue;
        const orig = sys.fixedUpdate.bind(sys);
        wrapped.push([sys, sys.fixedUpdate]);
        sys.fixedUpdate = (...a) => {
          const t0 = performance.now();
          orig(...a);
          stepAcc += performance.now() - t0;
        };
      }
      const nvIdx = wrapped.findIndex(([sys]) => sys === nv);
      const batIdx = wrapped.findIndex(([sys]) => sys === battle);
      const navMs = [], batMs = [];
      // Re-wrap the two named systems so their own cost is recorded as well as summed.
      if (nvIdx >= 0) {
        const inner = nv.fixedUpdate;
        nv.fixedUpdate = (...a) => { const t0 = performance.now(); inner(...a); navMs.push(performance.now() - t0); };
      }
      if (batIdx >= 0) {
        const inner = battle.fixedUpdate;
        battle.fixedUpdate = (...a) => { const t0 = performance.now(); inner(...a); batMs.push(performance.now() - t0); };
      }
      const ticks = Math.round(seconds * 30);
      // Warm the JIT: the first dozen ticks pay for every later one.
      for (let t = 0; t < 30; t++) { stepAcc = 0; step(); }
      navMs.length = 0; batMs.length = 0; stepMs.length = 0;

      // Optionally put the sim under the load a player creates: a whole wing ordered across
      // the wall at once. This is the case the steady-state figures cannot see.
      let ordered = 0;
      const nOrders = Math.abs(orders);
      if (nOrders > 0) {
        const aiHeld = holdAI();
        void aiHeld;
        const cands = [];
        for (const u of battle.units) {
          if (u.destroyed || u.alive === 0) continue;
          if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
          const def = battle.typeOf(u);
          if (!def || def.walkSpeed < 1.0) continue;
          cands.push(u);
        }
        for (const u of cands.slice(0, nOrders)) {
          const wz = wallZAt(u.x);
          // A negative order count means: the same number of units, the same distance,
          // but to a point on their own side of the wall". The straight line is clear, so
          // requestRoute short-circuits and no search, waypoint queue, hold-short or resume
          // is involved — the only difference from the positive case is that the routing
          // machinery does nothing. Whatever cost survives is men moving, not navigating.
          const gz = orders < 0
            ? u.z - 140
            : (wz === null ? u.z + 200 : wz + 140);
          engine.events.emit('orderIssued', {
            unitIds: [u.id], kind: 'move', x: u.x, z: gz, facing: 0, running: true,
          });
          ordered++;
        }
      }

      for (let t = 0; t < ticks; t++) { stepAcc = 0; step(); stepMs.push(stepAcc); }
      for (const [sys, fn] of wrapped) sys.fixedUpdate = fn;
      if (nOrders > 0) releaseAI();
      endSweep();
      const stat = (a) => {
        const s = a.slice().sort((p2, q) => p2 - q);
        return {
          mean: +(s.reduce((p2, q) => p2 + q, 0) / Math.max(1, s.length)).toFixed(3),
          median: +s[Math.floor(s.length * 0.5)].toFixed(3),
          p95: +s[Math.floor(s.length * 0.95)].toFixed(3),
          max: +s[s.length - 1].toFixed(3),
        };
      };
      const after = JSON.parse(JSON.stringify(nv.stats));
      const overBudget = stepMs.filter((v) => v > 4).length;
      /*
       * How fast is this machine *right now*.
       *
       * A fixed arithmetic workload, timed the same way everything else here is. Four
       * agents share this box and its load average has swung between 7 and 41 during this
       * work; the same configuration measured 1.436, 1.919 and 2.304 ms two minutes apart,
       * and a whole-step figure of 6.8 ms was recorded against a repo baseline of 2.7 for
       * the same scenario. Without a contemporaneous calibration there is no way to tell a
       * regression from a busy machine, and this project has already lost a day to exactly
       * that mistake.
       */
      const calibrate = () => {
        const t0 = performance.now();
        let acc = 0;
        for (let i = 1; i <= 4e6; i++) acc += Math.sqrt(i) / i;
        return { ms: +(performance.now() - t0).toFixed(3), acc: +acc.toFixed(6) };
      };
      const cal = calibrate();
      return {
        ok: true, seconds, ticks, men: battle.pool.count, ordered,
        cpuCalibrationMs: cal.ms,
        wholeFixedStep: stat(stepMs),
        ticksOverBudget: overBudget,
        fractionOverBudget: +(overBudget / Math.max(1, stepMs.length)).toFixed(3),
        pathfinding: stat(navMs), battle: stat(batMs),
        navStats: Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]])),
      };
    },

    /**
     * Somewhere the camera stands inside a solid's footprint — the condition the reverted
     * merge failed under. Chosen by scanning the published boxes rather than hard-coded,
     * so it keeps working as the city agent moves things.
     */
    aCameraInsideABuilding() {
      const solids = city && city.getObstacles ? city.getObstacles() : [];
      for (const s of solids) {
        if (s.kind !== 'building') continue;
        if (Math.min(s.hw, s.hd) < 3) continue;
        return { x: +s.x.toFixed(1), z: +s.z.toFixed(1), topY: s.topY, kind: s.kind };
      }
      return null;
    },

    /**
     * Does the nav grid follow the city when a gate is rammed open mid-battle?
     *
     * Siege does exactly that, and BattleSystem already re-indexes its collision field on
     * the same obstacleGeneration signal. Toggling the gate shut and open again is the
     * cheapest way to make the city bump that counter without touching another agent's file.
     */
    gateRestamp() {
      const nv = ctx.tryGet('pathfinding');
      if (!nv || !city || !city.setGateOpen || !city.getGates) return { ok: false, why: 'no gate api' };
      const gates = city.getGates();
      if (!gates.length) return { ok: false, why: 'no gates' };
      const id = gates[0].id;
      beginSweep();
      const genBefore = nv.grid.generation;
      const wasOpen = gates[0].open;

      city.setGateOpen(id, !wasOpen);
      const t0 = performance.now();
      step();
      const msClosed = performance.now() - t0;
      const genAfterClose = nv.grid.generation;
      const blockedWhenShut = nv.grid.blockedAt(gates[0].x, gates[0].z);

      city.setGateOpen(id, wasOpen);
      const t1 = performance.now();
      step();
      const msReopen = performance.now() - t1;
      const openAgain = !nv.grid.blockedAt(gates[0].x, gates[0].z);
      const genAfterOpen = nv.grid.generation;
      endSweep();
      return {
        ok: true, gate: id,
        navGeneration: [genBefore, genAfterClose, genAfterOpen],
        navFollowedTheClose: !!blockedWhenShut,
        navFollowedTheReopen: !!openAgain,
        restampMs: +Math.max(msClosed, msReopen).toFixed(2),
      };
    },

    /** Run N ticks and report exactly when the grid was re-stamped. Two runs must agree. */
    restampTrace(ticks) {
      const nv = ctx.tryGet('pathfinding');
      if (!nv) return null;
      beginSweep();
      const seen = [];
      let last = nv.stats.restamps;
      for (let t = 0; t < ticks; t++) {
        step();
        if (nv.stats.restamps !== last) {
          last = nv.stats.restamps;
          seen.push({ atProbeTick: t, navTick: nv.stats.lastRestampTick, gen: nv.grid.generation });
        }
      }
      endSweep();
      return { ticks, restamps: nv.stats.restamps, events: seen };
    },

    /**
     * Three invariants that must hold, checked directly rather than argued about.
     *
     * 1. The straightening mask is never *less* blocked than the expansion mask. If it ever
     *    were, the string-puller would approve a leg A* would not have expanded through.
     * 2. An order point derived from a solid is outside every solid. It is pushed clear of
     *    the one that was hit; landing inside its neighbour would be a new bug.
     * 3. A partial route never ends further from the goal than it started. AStarSearch
     *    falls back to its deepest node when nothing beat the start's heuristic, and the
     *    deepest node can in principle be in the wrong direction; routeAudit's ratio column
     *    is what catches that.
     */
    invariants() {
      const nv = ctx.tryGet('pathfinding');
      const terrain = ctx.tryGet('terrain');
      const out = {};

      if (nv && nv.grid) {
        let looser = 0;
        const { blocked, tight } = nv.grid;
        for (let i = 0; i < blocked.length; i++) if (blocked[i] && !tight[i]) looser++;
        out.tightLooserThanBlocked = looser;
      }

      if (terrain) {
        const heightAt = (x, z) => terrain.heightAt(x, z);
        const hud = ctx.tryGet('hud');
        const solids = (hud && hud.controller && hud.controller.pickSolids) || [];
        const boxes = city && city.getObstacles ? city.getObstacles() : [];
        const insideAnyBox = (x, z) => {
          for (const o of boxes) {
            const c = Math.cos(o.rot), sn = Math.sin(o.rot);
            const dx = x - o.x, dz = z - o.z;
            if (Math.abs(dx * c + dz * sn) <= o.hw && Math.abs(-dx * sn + dz * c) <= o.hd) return true;
          }
          return false;
        };
        // Sweep every solid in the pick set from eight bearings, as if clicked from each.
        let tested = 0, insideSolid = 0, worst = 0;
        const o = { x: 0, y: 0, z: 0 };
        for (let si = 0; si < solids.length; si++) {
          const s = solids[si];
          for (let a = 0; a < 8; a++) {
            const ang = (a / 8) * Math.PI * 2;
            // A hit point on the box surface in that direction, as a ray would produce.
            const hx = s.x + Math.cos(ang) * s.hw * 0.98;
            const hz = s.z + Math.sin(ang) * s.hd * 0.98;
            window.__pickOrderPoint(solids, si, boxes, hx, hz, heightAt, o);
            tested++;
            if (insideAnyBox(o.x, o.z)) insideSolid++;
            const d = Math.hypot(o.x - hx, o.z - hz);
            if (d > worst) worst = d;
          }
        }
        out.orderPoints = { tested, insideAnySolid: insideSolid, worstOffsetM: +worst.toFixed(2) };
      }
      return out;
    },

    /**
     * Which factions are on the field, and whether anything is actually commanding them.
     *
     * A third faction can be deployed, perceived and still be left standing because the
     * AI's commanded list was built for two sides. Counting units against plans is the
     * difference between "it does not crash" and "it plays".
     */
    factions() {
      const gen = ctx.tryGet('general-ai');
      const world = gen && gen.world ? gen.world : null;
      const counts = {};
      for (const u of battle.units) {
        if (u.destroyed) continue;
        counts[u.faction] = (counts[u.faction] ?? 0) + 1;
      }
      const out = {};
      for (const f of Object.keys(counts)) {
        const n = Number(f);
        const v = world ? world.views.get(n) : null;
        out[f] = {
          units: counts[f],
          hasPlan: gen && gen.planOf ? !!gen.planOf(n) : null,
          doctrine: gen && gen.planOf && gen.planOf(n) ? gen.planOf(n).doctrine : null,
          perceptionView: !!v,
          enemiesSeen: v ? v.seen.size : null,
          strength: battle.strength[n],
        };
      }
      return out;
    },

    info() {
      return {
        hasCity: !!city,
        hasNav: !!nav,
        navStats: nav ? JSON.parse(JSON.stringify(nav.stats)) : null,
        segments: segs.length,
        rasterCounts,
        units: battle.units.filter((u) => !u.destroyed).length,
        men: battle.pool.count,
      };
    },

    /**
     * Holes in the curtain, as the pathfinder sees it.
     *
     * Walk every wall segment's centreline at 1 m and count the samples where the nav grid
     * is passable but the city publishes a solid. Each one is a place A* may route a cohort
     * through masonry, and it is the failure that the deliberate half-cell over-stamp in
     * NavGrid.blockBox exists to prevent — so any change to that padding has to be checked
     * here, not argued about.
     */
    wallHoles() {
      if (!nav || !nav.grid) return null;
      const gr = nav.grid;
      let samples = 0, holes = 0, legal = 0;
      const at = [];
      for (const sg of segs) {
        const len = Math.hypot(sg.x2 - sg.x1, sg.z2 - sg.z1);
        const n = Math.max(1, Math.round(len));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const x = sg.x1 + (sg.x2 - sg.x1) * t;
          const z = sg.z1 + (sg.z2 - sg.z1) * t;
          samples++;
          if (legalOpening(x, z)) { legal++; continue; }
          if (!gr.blockedAt(x, z)) {
            holes++;
            if (at.length < 12) at.push([+x.toFixed(0), +z.toFixed(0)]);
          }
        }
      }
      return { samples, legalOpeningSamples: legal, holes, holeFraction: +(holes / Math.max(1, samples - legal)).toFixed(4), at };
    },

    /** What the pathfinder actually put in its grid. */
    stamp() {
      if (!nav || !nav.grid) return null;
      const gr = nav.grid;
      let terrain = 0, structure = 0;
      for (let i = 0; i < gr.blocked.length; i++) {
        if (gr.blocked[i] === 1) terrain++;
        else if (gr.blocked[i] === 2) structure++;
      }
      // How much of the wall's own length has a blocked nav cell under it, and how much
      // of the building area does. A stamp that covers the wall but not the insulae is
      // the difference between the two user complaints.
      let onWall = 0, onWallBlocked = 0, onBldg = 0, onBldgBlocked = 0;
      // And the other error: ground the city says is free that the grid says is not.
      // Over-stamping is deliberate — a thin barrier that slips between cell centres is a
      // hole A* will route a cohort through — but it also eats streets, and a goal in a
      // street the grid has closed is a goal no search can reach.
      let free = 0, freeBlocked = 0, freeInCity = 0, freeInCityBlocked = 0;
      for (let iz = 0; iz < NZ; iz++) {
        const z = Z0 + iz * CELL + CELL * 0.5;
        for (let ix = 0; ix < NX; ix++) {
          const k = occ[iz * NX + ix];
          const x = X0 + ix * CELL + CELL * 0.5;
          const blocked = gr.blockedAt(x, z);
          if (!k) {
            free++;
            if (blocked) freeBlocked++;
            // Inside the walled city, where it matters for a player's destination.
            const wz = wallZAt(x);
            if (wz !== null && z > wz + 10) {
              freeInCity++;
              if (blocked) freeInCityBlocked++;
            }
            continue;
          }
          if (k === 1) { onWall++; if (blocked) onWallBlocked++; }
          else { onBldg++; if (blocked) onBldgBlocked++; }
        }
      }
      return {
        cityObstacles: nav.stats.cityObstacles,
        blockedTerrainCells: terrain,
        blockedStructureCells: structure,
        wallCoverage: onWall ? onWallBlocked / onWall : 0,
        buildingCoverage: onBldg ? onBldgBlocked / onBldg : 0,
        wallCells: onWall,
        buildingCells: onBldg,
        freeGroundBlocked: free ? freeBlocked / free : 0,
        freeGroundInCityBlocked: freeInCity ? freeInCityBlocked / freeInCity : 0,
        freeCells: free,
        freeCellsInCity: freeInCity,
      };
    },

    /**
     * Man-ticks spent inside masonry.
     *
     * Ground truth for the curtain is the city's own masonryTopAt(), which existed before
     * any of this work and is what already stops an arrow at the wall. It returns the
     * absolute top of the stone within the true 3.5 m thickness and -Infinity outside it.
     * That matters: the 4 m occupancy raster paints a 7.5 m band for a 3.5 m wall, so once
     * men are correctly stopped *against* the face, a raster test counts them as inside.
     * Measuring the fix with the artefact would have read as a threefold regression.
     *
     * The raster figure is reported alongside as wallRaster so the two are comparable.
     *
     * A man on the wall-walk is not a penetration: he is above the stone, not in it. Nor
     * is a man the siege system has placed on a ladder or a boarding ramp.
     */
    penetration(ticks, warmupTicks) {
      const p = battle.pool;
      const el = battle.elevated;
      let wallHits = 0, wallRaster = 0, bldgHits = 0, manTicks = 0, worstDepth = 0;
      let elevatedInWall = 0, gateBayHits = 0, persistent = 0, maxStreak = 0;
      const streak = new Int32Array(p.x.length);
      const offenders = new Map();
      beginSweep();
      // The besiegers deploy 75-100 m out and walk in at about 1.4 m/s, so a sweep started
      // at t=0 measures an empty field: the first version of this test reported zero in
      // both arms because nobody had reached the wall yet. Warm up first, identically in
      // both arms, so the measurement window is the part of the battle that is at the wall.
      for (let t = 0; t < (warmupTicks | 0); t++) step();

      /**
       * Then order the army across, which is the case the user actually reported.
       *
       * Left to itself the assault AI escalades and boards towers, and every man who does
       * that is flagged 'elevated' and legitimately exempt — so an unprompted sweep of the
       * AI battle measures nothing at all, in either arm. The complaint was "I send a group
       * of soldiers and they walk through the wall", so the test sends them: every mobile
       * unit standing outside the circuit is given a plain move order to a point 150 m
       * inside it, through the same 'orderIssued' channel the mouse uses.
       */
      const aiHeld = holdAI();
      const ordered = [];
      for (const u of battle.units) {
        if (u.destroyed || u.alive === 0) continue;
        if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
        const def = battle.typeOf(u);
        if (!def || def.walkSpeed < 1.0) continue;
        const wzx = wallZAt(u.x);
        if (wzx === null || u.z >= wzx - 25) continue;
        const gz = wzx + 150;
        ordered.push(u.id);
        engine.events.emit('orderIssued', {
          unitIds: [u.id], kind: 'move', x: u.x, z: gz,
          facing: 0, running: true,
        });
      }
      for (let t = 0; t < ticks; t++) {
        step();
        const n = p.count;
        for (let i = 0; i < n; i++) {
          const st = p.state[i];
          if (st === 10 || st === 11) continue; // Dying / Dead
          manTicks++;
          const x = p.x[i], z = p.z[i];
          const k = occAt(x, z);

          // --- curtain, exact geometry ---
          const top = topAt(x, z);
          const under = Number.isFinite(top) && p.y[i] < top - 0.6;
          let insideNow = false;
          if (under) {
            if (el && el[i]) elevatedInWall++;
            else {
              insideNow = true;
              // The gate bay is a known false positive: masonryTopAt reports the
              // gatehouse block across the whole 35.5 m bay and 11.2 m of depth with no
              // test along the run, so it calls the open carriageway solid. Anyone
              // marching through the one gate into Rome is counted by it.
              if (inGateBay(x) || passableBay(x)) gateBayHits++;
              else {
                wallHits++;
                worstDepth = Math.max(worstDepth, top - p.y[i]);
                offenders.set(p.unitId[i], (offenders.get(p.unitId[i]) ?? 0) + 1);
              }
            }
          }
          if (k === 1) {
            if (!(Number.isFinite(top) && p.y[i] >= top - 0.6)) wallRaster++;
          } else if (k === 2 && !(el && el[i])) {
            bldgHits++;
            insideNow = true;
            offenders.set(p.unitId[i], (offenders.get(p.unitId[i]) ?? 0) + 1);
          }

          // How long has he been continuously inside? A man clipping a corner for three
          // ticks while the escape push moves him out is the mechanism working; a man
          // inside for a thousand ticks is living in a building.
          if (insideNow) {
            const run = (streak[i] ?? 0) + 1;
            streak[i] = run;
            if (run > maxStreak) maxStreak = run;
            if (run > 30) persistent++;
          } else if (streak[i]) {
            streak[i] = 0;
          }
        }
      }
      endSweep();
      releaseAI();
      const top = [...offenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([id, n]) => {
          const u = battle.unitById(id);
          const bay = u && city && city.bayAt ? city.bayAt(u.x) : undefined;
          return {
            unitId: id, typeId: u ? u.typeId : '?', faction: u ? u.faction : '?', manTicks: n,
            at: u ? { x: +u.x.toFixed(0), z: +u.z.toFixed(0) } : null,
            bay: bay ? { index: bay.index, stage: bay.stage } : null,
            siegeOwned: !!(u && battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)),
          };
        });
      // Where the ordered units actually ended up: how many got inside the circuit.
      let crossed = 0;
      for (const id of ordered) {
        const u = battle.unitById(id);
        if (!u || u.destroyed) continue;
        const wzx = wallZAt(u.x);
        if (wzx !== null && u.z > wzx + 25) crossed++;
      }

      return {
        ticks, warmupTicks: warmupTicks | 0, manTicks,
        aiCommandersHeld: aiHeld,
        unitsOrderedAcross: ordered.length,
        unitsNowInside: crossed,
        wallManTicks: wallHits,
        buildingManTicks: bldgHits,
        wallRasterManTicks: wallRaster,
        elevatedInWallManTicks: elevatedInWall,
        passableBayManTicks: gateBayHits,
        bayStages: bayStageCounts,
        persistentManTicks: persistent,
        longestStreakTicks: maxStreak,
        wallPerMille: manTicks ? (wallHits / manTicks) * 1000 : 0,
        buildingPerMille: manTicks ? (bldgHits / manTicks) * 1000 : 0,
        worstDepthBelowWalkway: worstDepth,
        offenders: top,
      };
    },

    /**
     * Order a unit standing outside the wall to a point well inside the city and see
     * whether it arrives. Reports the distance travelled against the straight line, which
     * is what says whether it went round or through.
     */
    reach(seconds) {
      const wz = wallZAt(0) ?? 0;
      // The strongest mobile body standing outside the wall. Picking by strength rather
      // than by position keeps the choice stable across runs; artillery and siege crews
      // are excluded because they are not free to march and would measure nothing.
      let unit = null, best = -1;
      for (const u of battle.units) {
        if (u.destroyed || u.alive === 0) continue;
        if (u.z >= wz - 40) continue;
        if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
        const def = battle.typeOf(u);
        if (!def || def.walkSpeed < 1.0) continue;
        if (u.alive > best) { best = u.alive; unit = u; }
      }
      if (!unit) return { ok: false, why: 'no mobile unit outside the wall' };

      // A point 140 m inside the wall on the unit's own bearing: far enough that the
      // curtain is unambiguously in the way.
      const gx = unit.x;
      const gz = (wallZAt(gx) ?? 0) + 140;
      const sx = unit.x, sz = unit.z;
      const straight = Math.hypot(gx - sx, gz - sz);

      beginSweep();
      const aiHeld = holdAI();
      engine.events.emit('orderIssued', {
        unitIds: [unit.id], kind: 'move', x: gx, z: gz,
        facing: Math.atan2(gx - sx, gz - sz), running: true,
      });
      // What the pathfinder was asked, and what it came back with. BattleSystem offsets
      // its request ids by 1e6 so they cannot collide with the AI's; see SIM_ROUTE_ID.
      const navKey = unit.id + 1000000;
      const askedFor = nav ? nav.pending(navKey) : false;
      let route = null;
      let waypointLegs = 0;
      let travelled = 0, px = unit.x, pz = unit.z;
      let crossedInside = false, throughMasonry = 0;
      const ticks = Math.round(seconds * 30);
      for (let t = 0; t < ticks; t++) {
        step();
        travelled += Math.hypot(unit.x - px, unit.z - pz);
        px = unit.x; pz = unit.z;
        if (occAt(unit.x, unit.z)) throughMasonry++;
        if (unit.z > (wallZAt(unit.x) ?? 0) + 20) crossedInside = true;
        if (unit.waypoints.length > waypointLegs) waypointLegs = unit.waypoints.length;
        if (!route && nav && nav.pathFor) {
          const pp = nav.pathFor(navKey);
          if (pp && pp.ok && pp.n >= 2) {
            route = {
              legs: pp.n, length: +pp.length.toFixed(1), narrow: !!pp.narrow,
              goal: { x: +pp.goalX.toFixed(1), z: +pp.goalZ.toFixed(1) },
              via: [],
            };
            for (let q = 0; q < pp.n; q++) {
              route.via.push([+pp.pts[q * 2].toFixed(0), +pp.pts[q * 2 + 1].toFixed(0)]);
            }
          }
        }
        if (Math.hypot(unit.x - gx, unit.z - gz) < 12) break;
      }
      endSweep();
      releaseAI();
      const remaining = Math.hypot(unit.x - gx, unit.z - gz);
      return {
        ok: true, aiHeld, askedForRoute: askedFor, route, waypointLegs,
        unitId: unit.id, typeId: unit.typeId, faction: unit.faction,
        start: { x: +sx.toFixed(1), z: +sz.toFixed(1) },
        goal: { x: +gx.toFixed(1), z: +gz.toFixed(1) },
        end: { x: +unit.x.toFixed(1), z: +unit.z.toFixed(1) },
        straightLine: +straight.toFixed(1),
        travelled: +travelled.toFixed(1),
        ratio: +(travelled / Math.max(1, straight)).toFixed(3),
        remaining: +remaining.toFixed(1),
        arrived: remaining < 12,
        crossedInside,
        anchorTicksInMasonry: throughMasonry,
      };
    },

    /**
     * Order a unit to attack a siege tower and report where it was actually sent.
     *
     * Two orders are tested because the UI can produce either: 'attack' with the id the
     * picker returned, and 'move' to the ground point under the cursor. The second is what
     * a right-click on a tall object actually resolves to, and the offset it produces is
     * the number the user is describing.
     */
    tower(seconds) {
      const siege = battle.siege;
      const towers = siege && siege.towerReport ? siege.towerReport() : [];
      if (!towers.length) return { ok: false, why: 'no siege towers in this scenario' };
      const T = towers[0];

      /**
       * Find the tower's crew by where its men are, not by where its unit record says.
       *
       * A siege tower is not a unit and has no id an order can name; the only handle the
       * order channel has is the crew unit. That crew is what a player clicks, because the
       * banner is drawn at the mean of the men's screen positions and therefore tracks the
       * machine correctly. Whether the *anchor* does is the thing being measured.
       */
      const p = battle.pool;
      let crew = null, crewD = Infinity, crewCentroid = null;
      for (const u of battle.units) {
        if (u.destroyed || u.alive === 0) continue;
        let sx = 0, sz = 0, n = 0;
        for (const i of u.members) {
          if (p.state[i] === 10 || p.state[i] === 11) continue;
          sx += p.x[i]; sz += p.z[i]; n++;
        }
        if (n === 0) continue;
        const cx = sx / n, cz = sz / n;
        const d = Math.hypot(cx - T.x, cz - T.z);
        if (d < crewD) { crewD = d; crew = u; crewCentroid = { x: cx, z: cz }; }
      }
      if (!crew) return { ok: false, why: 'no crew unit found' };
      const anchorError = Math.hypot(crew.x - crewCentroid.x, crew.z - crewCentroid.z);
      // Snapshot: the anchor moves during the sweep, and the number that matters is where
      // it was when the order was given.
      const anchorAtOrder = { x: +crew.x.toFixed(1), z: +crew.z.toFixed(1) };

      // An attacker: a mobile unit of the other side, well clear of the tower and free to
      // march. Siege-owned units are excluded — a ballista emplaced on the wall-walk has
      // its position written by Siege every tick and cannot carry out a move order, so
      // ordering one measures nothing. The first run of this test picked exactly that and
      // reported a destination on top of the unit's own feet.
      let unit = null, bestD = Infinity;
      for (const u of battle.units) {
        if (u.destroyed || u.alive === 0 || u.id === crew.id) continue;
        if (u.faction === crew.faction) continue;
        if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
        const def = battle.typeOf(u);
        if (!def || def.walkSpeed < 1.0) continue;
        const d = Math.hypot(u.x - T.x, u.z - T.z);
        if (d > 25 && d < bestD) { bestD = d; unit = u; }
      }
      if (!unit) return { ok: false, why: 'no hostile unit to order' };

      beginSweep();
      const aiHeld = holdAI();
      engine.events.emit('orderIssued', {
        unitIds: [unit.id], kind: 'attack', targetUnitId: crew.id,
      });
      step();
      const dest = { x: unit.targetX, z: unit.targetZ };
      const destToTower = Math.hypot(dest.x - T.x, dest.z - T.z);
      const ticks = Math.round(seconds * 30);
      for (let t = 0; t < ticks; t++) step();
      const T2 = siege.towerReport()[0] ?? T;
      const walked = Math.hypot(unit.x - T2.x, unit.z - T2.z);
      endSweep();
      releaseAI();

      return {
        ok: true, aiHeld,
        tower: { id: T.id, x: +T.x.toFixed(1), z: +T.z.toFixed(1), state: T.state },
        crew: {
          unitId: crew.id, typeId: crew.typeId, alive: crew.alive,
          anchor: anchorAtOrder,
          menCentroid: { x: +crewCentroid.x.toFixed(1), z: +crewCentroid.z.toFixed(1) },
          anchorErrorMetres: +anchorError.toFixed(1),
          anchorToTower: +Math.hypot(crew.x - T.x, crew.z - T.z).toFixed(1),
        },
        orderedUnit: { id: unit.id, typeId: unit.typeId, startDist: +bestD.toFixed(1) },
        issuedDestination: { x: +dest.x.toFixed(1), z: +dest.z.toFixed(1) },
        destinationToTowerMetres: +destToTower.toFixed(1),
        endedDistFromTower: +walked.toFixed(1),
      };
    },

    /**
     * Free-space geometry of the built city.
     *
     * A chamfer distance transform over the occupancy raster gives, for every free cell,
     * the metres to the nearest masonry. Twice that is the width of the corridor the cell
     * sits in, which is the number "large street" has to be measured against.
     */
    corridor() {
      const INF = 1e9, D1 = CELL, D2 = CELL * Math.SQRT2;
      const dt = new Float32Array(NX * NZ);
      for (let i = 0; i < dt.length; i++) dt[i] = occ[i] ? 0 : INF;
      for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
        const i = iz * NX + ix;
        if (dt[i] === 0) continue;
        let b = dt[i];
        if (ix > 0) b = Math.min(b, dt[i - 1] + D1);
        if (iz > 0) b = Math.min(b, dt[i - NX] + D1);
        if (ix > 0 && iz > 0) b = Math.min(b, dt[i - NX - 1] + D2);
        if (ix < NX - 1 && iz > 0) b = Math.min(b, dt[i - NX + 1] + D2);
        dt[i] = b;
      }
      for (let iz = NZ - 1; iz >= 0; iz--) for (let ix = NX - 1; ix >= 0; ix--) {
        const i = iz * NX + ix;
        if (dt[i] === 0) continue;
        let b = dt[i];
        if (ix < NX - 1) b = Math.min(b, dt[i + 1] + D1);
        if (iz < NZ - 1) b = Math.min(b, dt[i + NX] + D1);
        if (ix < NX - 1 && iz < NZ - 1) b = Math.min(b, dt[i + NX + 1] + D2);
        if (ix > 0 && iz < NZ - 1) b = Math.min(b, dt[i + NX - 1] + D2);
        dt[i] = b;
      }

      // Restrict the statistics to the built-up interior: within the wall, and inside the
      // x-range the districts actually occupy. Open countryside would swamp the numbers.
      const widths = [];
      let fits2 = 0, fits8 = 0, fits18 = 0, total = 0;
      for (let iz = 0; iz < NZ; iz++) {
        const z = Z0 + iz * CELL + CELL * 0.5;
        for (let ix = 0; ix < NX; ix++) {
          const i = iz * NX + ix;
          if (occ[i]) continue;
          const x = X0 + ix * CELL + CELL * 0.5;
          const wzx = wallZAt(x);
          if (wzx === null || z < wzx + 10) continue;   // outside or in the wall band
          if (x < -700 || x > 1250) continue;
          // Only count ground that is actually enclosed by fabric, i.e. has masonry
          // within 90 m — otherwise every field inside the circuit reads as a boulevard.
          if (dt[i] > 90) continue;
          total++;
          const w = dt[i] * 2;
          widths.push(w);
          if (dt[i] >= 2.4) fits2++;
          if (dt[i] >= 8) fits8++;
          if (dt[i] >= 17.5) fits18++;
        }
      }
      widths.sort((a, b) => a - b);
      const pct = (q) => (widths.length ? +widths[Math.min(widths.length - 1, Math.floor(q * widths.length))].toFixed(1) : 0);

      // Depth of open ground behind the wall: from the inner face, march inward until the
      // first non-wall masonry.
      const depths = [];
      const tight = [];
      const obs = city && city.getObstacles ? city.getObstacles() : [];
      const kindNear = (x, z) => {
        let best = '-', bestD = Infinity;
        for (const o of obs) {
          const d = Math.hypot(o.x - x, o.z - z);
          if (d < bestD) { bestD = d; best = o.kind; }
        }
        return best;
      };
      for (let x = -650; x <= 1200; x += 8) {
        const wzx = wallZAt(x);
        if (wzx === null) continue;
        let d = null;
        for (let z = wzx + 4; z < wzx + 400; z += CELL) {
          if (occAt(x, z) === 2) { d = z - wzx; break; }
        }
        if (d !== null) {
          depths.push(d);
          // What is standing in the pomerium, if anything: insulae respect it, monuments
          // are placed by the survey projection and do not.
          if (d < 55) tight.push({ x, depth: +d.toFixed(0), kind: kindNear(x, wzx + d) });
        }
      }
      tight.sort((a, b) => a.depth - b.depth);
      depths.sort((a, b) => a - b);
      const dpct = (q) => (depths.length ? +depths[Math.min(depths.length - 1, Math.floor(q * depths.length))].toFixed(1) : 0);

      return {
        freeCellsSampled: total,
        corridorWidth: {
          p05: pct(0.05), p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p95: pct(0.95),
        },
        fractionAdmitting: {
          file2p4m: total ? +(fits2 / total).toFixed(3) : 0,
          column16m: total ? +(fits8 / total).toFixed(3) : 0,
          cohortInLine35m: total ? +(fits18 / total).toFixed(3) : 0,
        },
        pomeriumIntruders: tight.slice(0, 8),
        openGroundBehindWall: {
          samples: depths.length,
          min: depths.length ? +depths[0].toFixed(1) : 0,
          p10: dpct(0.1), median: dpct(0.5), p90: dpct(0.9),
          max: depths.length ? +depths[depths.length - 1].toFixed(1) : 0,
        },
      };
    },
  };
})();
`;

// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const MAP = args.get('map') ?? '';
/**
 * Map choice travels in a base64url `BattleConfig` under `?battle=`, not a `?map=` param —
 * `resolveConfig` publishes it to `src/maps` through a module singleton before the engine
 * exists. Mirrors the literal in tools/probe-map.mjs for the same reason: a node script
 * cannot import the TypeScript module that defines a config.
 */
const encodeConfig = (c) =>
  Buffer.from(JSON.stringify(c)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const FOE = args.get('foe') ?? '';
const mapToken = (MAP || FOE)
  ? '&battle=' + encodeConfig({
      ...(MAP ? { map: MAP } : {}),
      // 2 is Faction.Carthage. Passed as a number so this file does not import the enum.
      ...(FOE === 'carthage' ? { opponent: 2 } : {}),
      unitSize: 'ultra',
      rome: { 'legio-cohort': 6, 'praetorian-cohort': 2, 'urban-cohort': 2, sagittarii: 2, equites: 3, scorpio: 1 },
      juthungi: { 'juthungi-warband': 6, 'juthungi-spears': 3, 'juthungi-skirmishers': 3, 'juthungi-chosen': 2, 'juthungi-berserkers': 2, 'juthungi-riders': 3 },
      quality: QUALITY, difficulty: 'hard', seed: 4265438264,
    })
  : '';
const url = `${base}/?harness=1&quality=${QUALITY}&w=960&h=540`
  + (SCENARIO ? `&scenario=${SCENARIO}` : '') + mapToken;
console.log(`• loading ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await page.evaluate(PICK_ARMS);
await page.evaluate(KIT);

const out = { url, scenario: SCENARIO || 'default', seconds: SECONDS };

/**
 * Reload to a pristine world.
 *
 * Each order test runs the clock for a minute or more, so without this the second test
 * starts from wherever the first one left the army — and a before/after comparison then
 * depends on the order the tests happened to run in. Costs about half a minute; buys the
 * property that every measurement below has the same initial condition.
 */
const reset = async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  await page.evaluate(PICK_ARMS);
  await page.evaluate(KIT);
};

out.info = await page.evaluate(() => window.__nav.info());
out.factions = await page.evaluate(() => window.__nav.factions());
out.map = MAP || 'default';
console.log(`\n── setup ──────────────────────────────────────────────`);
console.log(`  city ${out.info.hasCity ? 'present' : 'ABSENT'}   pathfinding ${out.info.hasNav ? 'present' : 'ABSENT'}`);
console.log(`  wall segments ${out.info.segments}   units ${out.info.units}   men ${out.info.men}`);
console.log(`  masonry raster: ${out.info.rasterCounts.wall} wall cells, ${out.info.rasterCounts.building} building cells (4 m)`);
for (const [f, d] of Object.entries(out.factions)) {
  console.log(`  faction ${f}: ${d.units} units, plan ${d.hasPlan ? d.doctrine : 'NONE (uncommanded)'}, perception view ${d.perceptionView ? 'yes' : 'NO'}, enemies seen ${d.enemiesSeen}, strength ${d.strength}`);
}

if (want('stamp')) {
  out.stamp = await page.evaluate(() => window.__nav.stamp());
  console.log(`\n── what the pathfinder stamped ────────────────────────`);
  if (!out.stamp) console.log('  no nav grid');
  else {
    console.log(`  city segments accepted        ${out.stamp.cityObstacles}`);
    console.log(`  nav cells blocked by terrain  ${out.stamp.blockedTerrainCells}`);
    console.log(`  nav cells blocked by structure${String(out.stamp.blockedStructureCells).padStart(7)}`);
    console.log(`  wall masonry covered          ${(out.stamp.wallCoverage * 100).toFixed(1)}%  (${out.stamp.wallCells} cells)`);
    console.log(`  building masonry covered      ${(out.stamp.buildingCoverage * 100).toFixed(1)}%  (${out.stamp.buildingCells} cells)`);
    console.log(`  FREE ground the grid blocks   ${(out.stamp.freeGroundBlocked * 100).toFixed(1)}%  (${out.stamp.freeCells} cells)`);
    console.log(`  free ground INSIDE the city   ${(out.stamp.freeGroundInCityBlocked * 100).toFixed(1)}%  (${out.stamp.freeCellsInCity} cells)`);
    out.wallHoles = await page.evaluate(() => window.__nav.wallHoles());
    const wh = out.wallHoles;
    if (wh) {
      console.log(`  HOLES in the curtain the grid would route through: ${wh.holes} of ${wh.samples - wh.legalOpeningSamples} solid samples (${(wh.holeFraction * 100).toFixed(2)}%)`);
      if (wh.at.length) console.log(`     at ${JSON.stringify(wh.at)}`);
      console.log(`  samples the city publishes as a legal opening:     ${wh.legalOpeningSamples}`);
    }
  }
}

if (want('corridor')) {
  out.corridor = await page.evaluate(() => window.__nav.corridor());
  const c = out.corridor;
  console.log(`\n── city free space ────────────────────────────────────`);
  console.log(`  corridor width m   p05 ${c.corridorWidth.p05}  p25 ${c.corridorWidth.p25}  median ${c.corridorWidth.median}  p75 ${c.corridorWidth.p75}  p95 ${c.corridorWidth.p95}`);
  console.log(`  free ground admitting a 2.4 m file      ${(c.fractionAdmitting.file2p4m * 100).toFixed(1)}%`);
  console.log(`  free ground admitting a 16 m column     ${(c.fractionAdmitting.column16m * 100).toFixed(1)}%`);
  console.log(`  free ground admitting a 35 m cohort     ${(c.fractionAdmitting.cohortInLine35m * 100).toFixed(1)}%`);
  const o = c.openGroundBehindWall;
  console.log(`  open ground behind the wall, m   min ${o.min}  p10 ${o.p10}  median ${o.median}  p90 ${o.p90}  max ${o.max}  (n=${o.samples})`);
  if (c.pomeriumIntruders?.length) {
    console.log(`  standing inside the 60 m pomerium: ` + c.pomeriumIntruders.map((t) => `${t.kind}@x${t.x} (${t.depth} m)`).join(', '));
  } else {
    console.log(`  nothing stands inside the 60 m pomerium`);
  }
}

if (want('tower')) {
  out.tower = await page.evaluate(() => window.__nav.tower(25));
  console.log(`\n── siege-tower targeting ──────────────────────────────`);
  if (!out.tower.ok) console.log(`  skipped: ${out.tower.why}`);
  else {
    const t = out.tower;
    console.log(`  tower #${t.tower.id} at (${t.tower.x}, ${t.tower.z}), state ${t.tower.state}`);
    console.log(`  crew ${t.crew.typeId} #${t.crew.unitId}: anchor (${t.crew.anchor.x}, ${t.crew.anchor.z}), men at (${t.crew.menCentroid.x}, ${t.crew.menCentroid.z})`);
    console.log(`  ANCHOR ERROR (anchor vs its own men)   ${t.crew.anchorErrorMetres} m`);
    console.log(`  ${t.orderedUnit.typeId} #${t.orderedUnit.id} ordered to attack it from ${t.orderedUnit.startDist} m`);
    console.log(`  ISSUED DESTINATION vs the tower        ${t.destinationToTowerMetres} m   at (${t.issuedDestination.x}, ${t.issuedDestination.z})`);
    console.log(`  after walking, unit is                 ${t.endedDistFromTower} m from the tower`);
  }
}

if (want('reach')) {
  out.reach = await page.evaluate(() => window.__nav.reach(240));
  console.log(`\n── reachability across the wall ───────────────────────`);
  if (!out.reach.ok) console.log(`  skipped: ${out.reach.why}`);
  else {
    const r = out.reach;
    console.log(`  ${r.typeId} #${r.unitId} from (${r.start.x}, ${r.start.z}) to (${r.goal.x}, ${r.goal.z})`);
    console.log(`  straight line ${r.straightLine} m, travelled ${r.travelled} m, ratio ${r.ratio}`);
    console.log(`  arrived ${r.arrived ? 'YES' : 'NO'} (${r.remaining} m short), crossed inside ${r.crossedInside ? 'YES' : 'NO'}`);
    console.log(`  anchor ticks inside masonry: ${r.anchorTicksInMasonry}   AI held: ${r.aiHeld}`);
    if (r.route) {
      console.log(`  route: ${r.route.legs} legs, ${r.route.length} m, narrow ${r.route.narrow}, via ${JSON.stringify(r.route.via)}`);
    } else {
      console.log(`  route: NONE returned (search requested: ${r.askedForRoute}); waypoint legs seen ${r.waypointLegs}`);
    }
  }
}

if (want('pick')) {
  await page.evaluate(() => window.__pickReady);
  const ARMS = ['legacy', 'ground', 'order', 'object'];
  // Two pitches. Zoom 0.12 is near the camera's low limit and is where the reverted bug
  // was worst; 0.85 is the commanding view a player plans from.
  // One camera is placed on top of an insula's footprint on purpose. That is where the
  // reverted merge failed, and a test that never stands there cannot see it.
  const inside = await page.evaluate(() => window.__nav.aCameraInsideABuilding());
  // Zoom 0.62 is RTSCamera's own default and is the camera a player actually has. It was
  // missing from an earlier version of this set, which is how a collapse covering 5.7% of
  // the default frame — all of it the wall band — went unmeasured.
  const CAMS = [
    ...(inside ? [{ label: 'default zoom, on an insula   ', x: inside.x, z: inside.z, zoom: 0.62, yaw: 0 }] : []),
    { label: 'DEFAULT zoom, at the wall    ', x: 40, z: 470, zoom: 0.62, yaw: 0 },
    { label: 'DEFAULT zoom, over the city  ', x: 40, z: 700, zoom: 0.62, yaw: 0 },
    { label: 'low,     over the city       ', x: 40, z: 700, zoom: 0.3, yaw: 0 },
    { label: 'low,     over the city sw    ', x: 40, z: 700, zoom: 0.3, yaw: 2.4 },
    { label: 'low,     outside the wall    ', x: 40, z: 300, zoom: 0.3, yaw: 0 },
    { label: 'medium,  over the city       ', x: 40, z: 500, zoom: 0.5, yaw: 0 },
    { label: 'steep,   over the city       ', x: 40, z: 700, zoom: 0.85, yaw: 0 },
    { label: 'steep,   outside the wall    ', x: 40, z: 300, zoom: 0.85, yaw: 0 },
  ];
  out.pick = [];
  console.log(`\n── destination accuracy: world -> screen -> world ─────`);
  console.log(`  error in metres between where the player pointed and where the ray resolves`);
  for (const c of CAMS) {
    const r = await page.evaluate(
      ([x, z, zoom, yaw, arms]) => window.__nav.pickAccuracy(x, z, zoom, yaw, arms),
      [c.x, c.z, c.zoom, c.yaw, ARMS]
    );
    r.label = c.label;
    out.pick.push(r);
    if (!r.ok) { console.log(`  ${c.label}: skipped (${r.why})`); continue; }
    console.log(`  ${c.label}  eye ${r.camera.aboveGround} m ABOVE GROUND, pitch ${r.camera.pitchDeg}°, ${r.samples} of ${r.pixelsHittingGround} ground pixels are visible open ground, eye inside ${r.eyeInsideSolids} solid(s), ${r.solidPixels} px on a solid (round-trip ${r.referenceRoundTripNdc} ndc)`);
    for (const k of ARMS) {
      const a = r.arms[k];
      const ap = a.allPixels;
      // `object` answers a different question — it returns a point on a solid, so grading it
      // against the *ground* reference is meaningless. Its pixel count is the useful part.
      if (k === 'object') {
        console.log(`      object  ${ap.resolved} of ${r.pixelsHittingGround} pixels land on a targetable solid`);
        continue;
      }
      console.log(
        `      ${k.padEnd(7)} visible-ground median ${String(a.medianM).padStart(6)} m  p95 ${String(a.p95M).padStart(6)}  max ${String(a.maxM).padStart(6)}` +
        `  within 2 m ${a.within2m === null ? '  n/a' : (a.within2m * 100).toFixed(1) + '%'}`
      );
      console.log(
        `              all ${String(ap.resolved).padStart(3)} px: median err ${String(ap.medianErrM).padStart(7)} m  p95 ${String(ap.p95ErrM).padStart(7)} m` +
        `  spread ${String(ap.spreadM).padStart(7)} m = ${((ap.spreadFractionOfView ?? 0) * 100).toFixed(0)}% of the ${r.referenceSpreadM} m in view` +
        `  DISTINCT ${String(ap.distinctDestinations).padStart(4)}/${ap.resolved}`
      );
      const og = a.openGroundPixels;
      // Below twenty pixels the quantiles are noise dressed as a result, so say so instead
      // of printing a confident 0.01 m drawn from a sample of two.
      console.log(og.n < 20
        ? `              no solid under the cursor (${String(og.n).padStart(3)} px): TOO FEW PIXELS TO CONCLUDE`
        : `              no solid under the cursor (${String(og.n).padStart(3)} px): median ${String(og.medianErrM).padStart(6)} m  p95 ${String(og.p95ErrM).padStart(6)} m  max ${String(og.maxErrM).padStart(6)} m`);
    }
  }
  out.towerPick = await page.evaluate((arms) => window.__nav.towerPick(arms), ['legacy', 'ground', 'order', 'object']);
  console.log(`\n── clicking a siege tower ─────────────────────────────`);
  if (!out.towerPick.ok) console.log(`  skipped: ${out.towerPick.why}`);
  else {
    const t = out.towerPick;
    console.log(`  tower at (${t.tower.x}, ${t.tower.z}), deck ${t.tower.deckY} m; aiming 2 m below the deck`);
    console.log(`  legacy arm sees ${t.legacySet} raw city obstacles (no siege engines); shipped arms see the ${t.pickSet}-solid pick set`);
    for (const k of Object.keys(t.arms)) {
      const a = t.arms[k];
      console.log(`      ${k.padEnd(7)} ${a.at ? `resolves at (${a.at[0]}, ${a.at[1]}), ${a.offsetM} m from the tower` : 'no hit'}`);
    }
  }
}

if (want('routes')) {
  if (want('pick')) await reset();
  const settle = Number(args.get('settle') ?? 150);
  const depth = Number(args.get('depth') ?? 140);
  out.routes = await page.evaluate(([n, s, d]) => window.__nav.routeAudit(n, s, d), [8, settle, depth]);
  console.log(`\n── route legality: player move orders across the wall ─`);
  if (!out.routes.ok) console.log(`  skipped: ${out.routes.why}`);
  else {
    const r = out.routes;
    console.log(`  ${r.ordered} units ordered ${depth} m inside the wall, ${r.settleTicks} ticks to settle (AI held: ${r.aiHeld})`);
    console.log(`  ROUTES TOUCHING ANY SOLID (exact oriented boxes, every kind)  ${r.routesInsideAnySolid} / ${r.ordered}   total ${r.totalExactSolidMetres} m over ${r.totalPathMetres} m of path`);
    console.log(`  of which through WALL masonry (4 m raster)  ${r.routesCrossingWall} / ${r.ordered}      median length/straight-line ${r.medianRatio}`);
    console.log(`  routes still a single straight leg: ${r.routesWithZeroLegs}`);
    if (r.navStats) console.log(`  pathfinder over the window: ${JSON.stringify(r.navStats)}`);
    if (r.timeline) for (const tl of r.timeline) console.log(`      t+${String(tl.t).padStart(3)} ticks  nodes ${String(tl.nodes).padStart(7)}  queue ${tl.queue}  searches ${tl.searches}  failures ${tl.failures}  units with a route ${tl.withLegs}`);
    for (const q of r.rows) {
      console.log(
        `   #${String(q.unitId).padStart(3)} (${String(q.start[0]).padStart(7)},${String(q.start[1]).padStart(7)}) -> (${String(q.goal[0]).padStart(7)},${String(q.goal[1]).padStart(7)})` +
        `  legs ${String(q.legs).padStart(2)}  ${String(q.pathLength).padStart(7)} m /${String(q.straightLine).padStart(7)} m = ${q.ratio}` +
        `  wall ${String(q.wallMetres).padStart(6)} m  bldg(raster) ${String(q.buildingMetres).padStart(6)} m  EXACT ${String(q.exactSolidMetres).padStart(5)} m  illegal ${q.illegalCrossings}` +
        (q.firstWallAt ? `  first at (${q.firstWallAt[0]},${q.firstWallAt[1]})` : '')
      );
      const nv = q.nav;
      if (nv) console.log(`        nav: pending ${nv.pending}  storedLegs ${nv.n}  ok ${nv.ok}  len ${nv.length}  startClear ${nv.startClear}  goalClear ${nv.goalClear}  directClear ${nv.directClear}  corridorClear ${nv.corridorClear}  cityBlocks ${nv.cityBlocks}`);
    }
  }
}

if (want('attack')) {
  if (want('routes')) await reset();
  out.attack = await page.evaluate((s) => window.__nav.attackAudit(s), 60);
  console.log(`\n── attack order across the wall ───────────────────────`);
  if (!out.attack.ok) console.log(`  skipped: ${out.attack.why}`);
  else {
    const a = out.attack;
    console.log(`  #${a.attacker} at (${a.start[0]}, ${a.start[1]}) ordered to attack #${a.target} at (${a.targetAt[0]}, ${a.targetAt[1]}), ${a.straightLine} m away`);
    console.log(`  one tick after the order : ${a.immediate.legs} leg(s), ${a.immediate.wallMetres} m of the path inside wall masonry, ${a.immediate.buildingMetres} m inside buildings, ${a.immediate.illegal} illegal wall crossings`);
    console.log(`  after 3 s to settle     : ${a.settled.legs} leg(s), ${a.settled.wallMetres} m inside wall masonry (raster), ${a.settled.exactSolidMetres} m inside ANY solid (exact), ${a.settled.illegal} illegal crossings, ${a.settled.length} m long`);
    console.log(`  after ${a.after.seconds} s of walking : travelled ${a.after.travelled} m, now (${a.after.end[0]}, ${a.after.end[1]}), ${a.after.gapToTarget} m from the target, crossed the wall ${a.after.crossedWall ? 'YES' : 'NO'}, anchor ticks in masonry ${a.after.ticksInMasonry}`);
  }
}

if (want('arrival')) {
  if (want('attack') || want('routes')) await reset();
  const longS = Number(args.get('arrivesecs') ?? 210);
  out.arrival = await page.evaluate(([n, s, t, l]) => window.__nav.arrival(n, s, t, l), [8, 60, 20, longS]);
  console.log(`\n── arrival ────────────────────────────────────────────`);
  if (!out.arrival.ok) console.log(`  skipped: ${out.arrival.why}`);
  else {
    const a = out.arrival;
    console.log(`  at 60 s : ARRIVED ${a.at60.arrived}/${a.ordered} (${(a.at60.arrivedFraction * 100).toFixed(1)}%) within ${a.tol} m; STUCK ${a.at60.stuck}, OF WHICH AGAINST MASONRY ${a.at60.stuckAgainstWall}`);
    console.log(`  at ${String(a.longSeconds).padStart(3)} s : ARRIVED ${a.arrived}/${a.ordered} (${(a.arrivedFraction * 100).toFixed(1)}%);              STUCK ${a.stuck}, OF WHICH AGAINST MASONRY ${a.stuckAgainstWall}`);
    console.log(`  median fraction of the initial gap closed: ${a.medianProgress}`);
    for (const q of a.rows) {
      console.log(
        `   #${String(q.unitId).padStart(3)} -> (${String(q.goal[0]).padStart(6)},${String(q.goal[1]).padStart(6)})  gap ${String(q.startGap).padStart(6)} m` +
        `  at60 ${String(q.remainingAt60).padStart(6)} m  end ${String(q.remaining).padStart(6)} m  progress ${String(q.progress).padStart(5)}` +
        `  arrived ${q.arrivedAt === null ? '   no' : 't+' + q.arrivedAt}  moved/5s ${String(q.movedLast5s).padStart(5)} m` +
        `  locked ${q.contactLocked ? 'Y' : 'n'}  masonry ${q.metresToMasonry === null ? ' >14' : String(q.metresToMasonry).padStart(4)} m  wps ${q.waypoints}`
      );
    }
  }
}

if (want('invariants')) {
  await page.evaluate(() => window.__pickReady);
  out.invariants = await page.evaluate(() => window.__nav.invariants());
  const iv = out.invariants;
  console.log(`\n── invariants ─────────────────────────────────────────`);
  console.log(`  nav cells where the straightening mask is LOOSER than the expansion mask: ${iv.tightLooserThanBlocked}  (must be 0)`);
  if (iv.orderPoints) {
    console.log(`  order points derived from a solid: ${iv.orderPoints.tested} tested, ${iv.orderPoints.insideAnySolid} landed INSIDE a solid (must be 0), worst offset ${iv.orderPoints.worstOffsetM} m`);
  }
}

if (want('restamp')) {
  const r1 = await page.evaluate(() => window.__nav.restampTrace(900));
  await reset();
  const r2 = await page.evaluate(() => window.__nav.restampTrace(900));
  console.log(`\n── when the nav grid re-stamps, twice over ────────────`);
  console.log(`  run A: ${JSON.stringify(r1)}`);
  console.log(`  run B: ${JSON.stringify(r2)}`);
  console.log(`  ${JSON.stringify(r1) === JSON.stringify(r2) ? 'IDENTICAL' : 'DIVERGENT'}`);
  out.restamp = { a: r1, b: r2 };
}

if (want('gate')) {
  out.gate = await page.evaluate(() => window.__nav.gateRestamp());
  console.log(`\n── nav grid follows a gate opening ────────────────────`);
  if (!out.gate.ok) console.log(`  skipped: ${out.gate.why}`);
  else {
    const g = out.gate;
    console.log(`  ${g.gate}: nav grid generation ${g.navGeneration.join(' -> ')}`);
    console.log(`  grid blocked the carriageway when the gate shut: ${g.navFollowedTheClose ? 'YES' : 'NO'}`);
    console.log(`  grid re-opened it when the gate opened:          ${g.navFollowedTheReopen ? 'YES' : 'NO'}`);
    console.log(`  worst re-stamp cost: ${g.restampMs} ms in the tick it happened`);
  }
}

if (want('navperf')) {
  if (want('arrival') || want('attack') || want('routes')) await reset();
  const loadOrders = Number(args.get('orders') ?? 0);
  out.navPerf = await page.evaluate(([s, o]) => window.__nav.navPerf(s, o), [40, loadOrders]);
  console.log(`\n── AI navigation cost, both commanders live ───────────`);
  if (!out.navPerf.ok) console.log(`  skipped: ${out.navPerf.why}`);
  else {
    const n = out.navPerf;
    console.log(`  ${n.ticks} ticks, ${n.men} men${n.ordered ? `, ${n.ordered} units ordered across the wall at t=0` : ''}`);
    console.log(`  machine speed right now: calibration workload ${n.cpuCalibrationMs} ms (lower is a quieter box; compare across runs before believing a delta)`);
    console.log(`  WHOLE fixedUpdate        mean ${n.wholeFixedStep.mean} ms  median ${n.wholeFixedStep.median}  p95 ${n.wholeFixedStep.p95}  max ${n.wholeFixedStep.max}   (BUDGET 4.000 ms for 6k men)`);
    console.log(`  ticks over 4 ms          ${n.ticksOverBudget} / ${n.ticks}  (${(n.fractionOverBudget * 100).toFixed(1)}%)`);
    console.log(`    of which pathfinding   mean ${n.pathfinding.mean} ms  median ${n.pathfinding.median}  p95 ${n.pathfinding.p95}  max ${n.pathfinding.max}`);
    console.log(`    of which battle        mean ${n.battle.mean} ms  median ${n.battle.median}  p95 ${n.battle.p95}  max ${n.battle.max}`);
    console.log(`  pathfinder work: ${JSON.stringify(n.navStats)}`);
  }
}

if (want('trace')) {
  out.trace = await page.evaluate((s) => window.__nav.trace(s), 40);
  console.log(`\n── single-unit trace ───────────────────────────`);
  if (!out.trace.ok) console.log(`  skipped: ${out.trace.why}`);
  else {
    const t = out.trace;
    console.log(`  ${t.typeId} #${t.unitId}, AI commanders held: ${t.aiHeld}; wall z ${t.wallZ}, goal z ${t.goalZ}`);
    for (const r of t.rows) {
      console.log(`   t+${String(r.t).padStart(2)} tick ${String(r.tick).padStart(5)}  pos (${String(r.x).padStart(7)}, ${String(r.z).padStart(7)})  order ${r.order}  target (${r.tx}, ${r.tz})  lock ${r.lock ? 'Y' : 'n'}  wps ${r.wps}  run ${r.running ? 'Y' : 'n'}  alive ${r.alive}`);
    }
  }
}

if (want('crossings')) {
  const secs = Number(args.get('crosssecs') ?? 150);
  const showX = (label, c) => {
    if (!c.ok) { console.log(`  ${label}: skipped (${c.why})`); return; }
    console.log(`  ${label}: ${c.towersDocked}/${c.towers} towers docked, TOWER CROSSINGS ${c.towerCrossed} (queued ${c.towerQueued}); ladders ${c.ladders}, LADDER CROSSINGS ${c.ladderCrossed}`);
    for (const t of c.towerDetail) console.log(`      tower #${t.id} ${t.state} faceGap ${t.faceGap} m crossed ${t.crossed} queued ${t.queued}`);
  };
  console.log(`\n── siege delivery, ${secs} s ──────────────────────────────`);
  const offx = await page.evaluate(() => window.__nav.setCollision(false));
  out.crossingsOff = await page.evaluate((v) => window.__nav.crossings(v), secs);
  showX(`A collision OFF (${offx.was} withheld)`, out.crossingsOff);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  await page.evaluate(KIT);
  await page.evaluate(() => window.__nav.setCollision(true));
  out.crossings = await page.evaluate((v) => window.__nav.crossings(v), secs);
  showX('B collision ON ', out.crossings);
}

if (want('perf')) {
  out.perf = await page.evaluate(() => window.__nav.perf(900));
  const q = out.perf;
  console.log(`\n── fixedUpdate cost ───────────────────────────────────`);
  console.log(`  ${q.on.men} men, ${q.solids} solids, ${q.on.n} ticks per arm`);
  for (const a of [q.on, q.off]) {
    console.log(`  ${a.label.padEnd(14)} mean ${a.mean.toFixed(3)} ms  median ${a.median.toFixed(3)}  p95 ${a.p95.toFixed(3)}  max ${a.max.toFixed(3)}`);
  }
  console.log(`  attributable to collision: ${q.deltaMs >= 0 ? '+' : ''}${q.deltaMs} ms   (budget 4.000 ms for 6k men)`);
}

if (want('connectivity')) {
  console.log(`\n── nav-grid connectivity into the city ─────────────────`);
  // Three body widths: a file threading an alley, a 16 m column, and a cohort in line at
  // 35 m frontage. The last is the one the user's "large street corridors" has to mean.
  out.connectivityByRadius = [];
  for (const rr of [2.2, 8, 17.5]) {
    const r = await page.evaluate((v) => window.__nav.connectivity(v), rr);
    out.connectivityByRadius.push(r);
    if (!r.ok) { console.log(`  radius ${rr} m: ${r.why}`); continue; }
    console.log(`  radius ${String(rr).padStart(4)} m (body ${(rr * 2).toFixed(1)} m wide): reached ${String(r.cellsReached).padStart(7)} cells,`
      + ` inside the circuit ${String(r.cellsInsideCity).padStart(6)}`
      + `  nearest inside ${r.nearestInside ? `(${r.nearestInside[0]}, ${r.nearestInside[1]}) @ ${r.nearestInsideDistance} m` : 'NONE'}`);
  }
  out.connectivity = out.connectivityByRadius[0];
  const c = out.connectivity;
  if (!c.ok) console.log(`  skipped: ${c.why}`);
  else {
    for (const x of c.crossSections) {
      console.log(`  ${x.what}: ` + x.row.map((r) => `${r.d >= 0 ? '+' : ''}${r.d}${r.blocked ? 'X' : '.'}${r.clear}`).join('  '));
    }
  }
}

if (want('penetration')) {
  const ticks = Math.round(SECONDS * 30);
  const show = (label, p) => {
    console.log(`  ${label}`);
    console.log(`    man-ticks sampled            ${p.manTicks.toLocaleString()}`);
    console.log(`    INSIDE THE WALL              ${p.wallManTicks.toLocaleString()}  (${p.wallPerMille.toFixed(2)} per 1000)`);
    console.log(`    INSIDE A BUILDING            ${p.buildingManTicks.toLocaleString()}  (${p.buildingPerMille.toFixed(2)} per 1000)`);
    console.log(`    deepest below the walkway    ${p.worstDepthBelowWalkway.toFixed(2)} m`);
    console.log(`    (4 m raster band, for scale) ${p.wallRasterManTicks.toLocaleString()};  garrison on the walk ${p.elevatedInWallManTicks.toLocaleString()}`);
    console.log(`    units ordered across / now inside   ${p.unitsOrderedAcross} / ${p.unitsNowInside}`);
    console.log(`    gate + footing bays (passable) ${p.passableBayManTicks.toLocaleString()}`);
    console.log(`    man-ticks in streaks > 1 s   ${p.persistentManTicks.toLocaleString()}   longest streak ${p.longestStreakTicks} ticks`);
    for (const o of p.offenders) {
      console.log(`      faction ${o.faction} ${o.typeId} #${o.unitId}: ${o.manTicks.toLocaleString()} man-ticks`
        + `  at (${o.at?.x}, ${o.at?.z})  bay ${o.bay ? o.bay.index + '/' + o.bay.stage : '-'}`
        + `  siege-owned ${o.siegeOwned ? 'Y' : 'n'}`);
    }
  };

  const warm = Math.round(WARMUP * 30);
  console.log(`\n── penetration sweep, ${warm} warm-up + ${ticks} measured ticks (${WARMUP} + ${SECONDS} s) ──`);
  // A/B on one page load, one seed, one order of battle: collision off, then a fresh
  // reload with it on. Reloading rather than re-enabling mid-run, because a sweep with
  // collision off leaves men embedded in masonry and the second sweep would inherit them.
  if (ARM !== 'b') {
    const flip = await page.evaluate(() => window.__nav.setCollision(false));
    console.log(`  A: collision OFF (${flip.was} solids withheld)`);
    out.penetrationOff = await page.evaluate(([t, w]) => window.__nav.penetration(t, w), [ticks, warm]);
    show('A — collision off', out.penetrationOff);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
    await page.evaluate(KIT);
  }
  const on = await page.evaluate(() => window.__nav.setCollision(true));
  console.log(`\n  B: collision ON (${on.now} solids)`);
  out.penetration = await page.evaluate(([t, w]) => window.__nav.penetration(t, w), [ticks, warm]);
  show('B — collision on', out.penetration);

  const a = out.penetrationOff;
  const b = out.penetration;
  if (a) {
    console.log(`\n  DELTA  wall ${a.wallManTicks.toLocaleString()} -> ${b.wallManTicks.toLocaleString()}`
      + `   building ${a.buildingManTicks.toLocaleString()} -> ${b.buildingManTicks.toLocaleString()}`);
  }
}

if (errors.length) {
  out.errors = errors.slice(0, 20);
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of out.errors) console.log(`   ${e}`);
}

if (JSON_OUT) {
  await mkdir(path.dirname(path.resolve(ROOT, JSON_OUT)), { recursive: true });
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 2));
  console.log(`\n• wrote ${JSON_OUT}`);
}

await browser.close();
if (server) server.kill();
console.log('');
