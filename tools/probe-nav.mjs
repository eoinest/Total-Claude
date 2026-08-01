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
      for (let iz = 0; iz < NZ; iz++) {
        const z = Z0 + iz * CELL + CELL * 0.5;
        for (let ix = 0; ix < NX; ix++) {
          const k = occ[iz * NX + ix];
          if (!k) continue;
          const x = X0 + ix * CELL + CELL * 0.5;
          const blocked = gr.blockedAt(x, z);
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
const mapToken = MAP
  ? '&battle=' + encodeConfig({
      map: MAP, unitSize: 'ultra',
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
await page.evaluate(KIT);

const out = { url, scenario: SCENARIO || 'default', seconds: SECONDS };

out.info = await page.evaluate(() => window.__nav.info());
out.map = MAP || 'default';
console.log(`\n── setup ──────────────────────────────────────────────`);
console.log(`  city ${out.info.hasCity ? 'present' : 'ABSENT'}   pathfinding ${out.info.hasNav ? 'present' : 'ABSENT'}`);
console.log(`  wall segments ${out.info.segments}   units ${out.info.units}   men ${out.info.men}`);
console.log(`  masonry raster: ${out.info.rasterCounts.wall} wall cells, ${out.info.rasterCounts.building} building cells (4 m)`);

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
