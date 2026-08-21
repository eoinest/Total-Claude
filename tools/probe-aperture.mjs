#!/usr/bin/env node
/**
 * Does a formation fit the hole it is being routed through, and does a broken unit run
 * into the wall?
 *
 * Two reports, measured in one rig because they share a candidate root: a route planned at
 * one width and executed by a body of another.
 *
 *   gate    a cavalry unit ordered through an open gate. Counts men whose *body* is inside
 *           masonry, men whose mount's barrel is inside masonry, men outside the
 *           carriageway corridor while inside the gate's depth band, and seconds to get
 *           the unit through.
 *   rout    a unit placed inside the circuit and then broken. Counts man-ticks in masonry,
 *           ticks the anchor made no progress, whether the unit ever left the city, and
 *           whether anything ever asked the pathfinder about it.
 *   widths  the three numbers that describe one aperture: the drawn stone, the collision
 *           box cut, and the nav raster clear. Plus every unit's frontage against them.
 *
 * ## The instrument comes first
 *
 * Ground truth is `battle.masonry` — the very `ObstacleField` the simulation collides
 * against, with the gate carriageway punched out of it by `CitySystem.recutWallObstacles`.
 * `probe-nav.mjs`'s penetration sweep cannot answer this question: its ground truth is
 * `city.masonryTopAt`, which reports the gatehouse block solid across the whole bay, so it
 * excludes everything within 20 m of a gate as a known false positive (`inGateBay`). The
 * defect under test lives entirely inside that exclusion.
 *
 * So `--selftest` runs first and is not optional. It asserts, against the live field:
 *   1. a point on the carriageway centreline is NOT solid          (else: the hole is not cut)
 *   2. a point 8 m to the side at the same z IS solid              (else: no wall to be in)
 *   3. the two ground truths — the oriented boxes and the city's own occupancy raster —
 *      are compared across the gate mouth and their disagreement is printed, because if
 *      they disagree then one of the numbers below is measuring the other's artefact
 * A failed self-test exits non-zero and prints nothing else. A zero from a probe that has
 * not proved it can see a wall is not a measurement.
 *
 * Usage:
 *   node tools/probe-aperture.mjs --port=5731 --selftest
 *   node tools/probe-aperture.mjs --port=5731 --map=carthage --foe=carthage
 *   node tools/probe-aperture.mjs --port=5731 --json=screenshots/ap-before.json
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5731);
const MAP = args.get('map') ?? '';
const FOE = args.get('foe') ?? '';
const QUALITY = args.get('quality') ?? 'low';
const SEEDS = Number(args.get('seeds') ?? 1);
const JSON_OUT = args.get('json') ?? null;
const ONLY = args.has('only') ? new Set(String(args.get('only')).split(',')) : null;
const want = (k) => !ONLY || ONLY.has(k);

const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) {
  console.error(`no dev server at ${base} — a probe that falls through to dist/ measures a build`);
  process.exit(2);
}

const encodeConfig = (c) =>
  Buffer.from(JSON.stringify(c)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const KIT = `
window.__ap = (() => {
  const g = window.__game;
  const engine = g.engine;
  const ctx = engine.context;
  const battle = g.battle;
  const city = ctx.tryGet('city');
  const nav = ctx.tryGet('pathfinding');
  const pool = battle.pool;

  // ---- clock, driven from a clock this code owns. See probe-nav.mjs. -------------
  let savedRender; let clock = 0;
  const beginSweep = () => {
    engine.stop();
    savedRender = engine.renderOverride;
    engine.renderOverride = () => {};
    ctx.time.resync();
    clock = 0;
    engine.frame(clock);
  };
  const endSweep = () => { engine.renderOverride = savedRender; };
  const FRAME_MS = (1000 / 30) * (1 + 1e-9);
  const step = () => { clock += FRAME_MS; engine.frame(clock); };

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
  const releaseAI = () => { for (const [s, fn] of held) s.fixedUpdate = fn; held.length = 0; };

  // ---- ground truth -------------------------------------------------------------
  const M = battle.masonry;
  /** Index of the solid containing a point at height y inflated by r, or -1. */
  const solidAt = (x, z, y, r) => M.solidAt(x, z, y, r);
  const kindOf = (i) => {
    const it = M.items && M.items[i];
    return it ? it.kind : '?';
  };
  /** The city's independent occupancy raster, through its public segment query. */
  const rasterSolid = (x, z) => (city && city.blocksMovement
    ? city.blocksMovement(x, z, x, z) : false);

  const gates = () => (city && city.getGates ? city.getGates() : []);
  const mainGate = () => {
    const gs = gates();
    return gs.length ? gs[0] : null;
  };

  /** Ground height, through whatever the sim itself uses. */
  const groundAt = (x, z) => battle.groundAt(x, z);

  return {
    info() {
      const gs = gates();
      return {
        hasCity: !!city, hasNav: !!nav,
        obstacles: M.count, units: battle.units.length, men: pool.count,
        gates: gs.map((t) => ({ id: t.id, x: +t.x.toFixed(1), z: +t.z.toFixed(1), open: t.open })),
        plan: city && city.plan ? { gateOpenWidth: city.plan.gateOpenWidth } : null,
      };
    },

    /**
     * The instrument, before any number it produces is believed.
     *
     * Opens the main gate, then probes across its mouth at 0.1 m and reports where each
     * of the two ground truths says the stone starts. If they disagree the disagreement
     * is the finding, not a nuisance.
     */
    selftest() {
      const gt = mainGate();
      if (!gt) return { ok: false, why: 'no gates on this map' };
      city.setGateOpen(gt.id, true);
      if (city.setGateDoorBroken) city.setGateDoorBroken(gt.id);
      battle.units.length && 0;
      // Re-index the sim's field the way a tick would.
      beginSweep(); step(); endSweep();

      const y = groundAt(gt.x, gt.z) + 0.9;
      const centre = solidAt(gt.x, gt.z, y, 0);
      const aside = solidAt(gt.x + 8, gt.z, y, 0);

      // Sweep laterally across the mouth. +x runs along the wall on both these maps.
      const scan = [];
      for (let d = -14; d <= 14.0001; d += 0.1) {
        const x = gt.x + d;
        scan.push([+d.toFixed(2), solidAt(x, gt.z, y, 0) >= 0 ? 1 : 0, rasterSolid(x, gt.z) ? 1 : 0]);
      }
      const firstSolid = (col) => {
        // Walk out from the centre until each truth says solid.
        let lo = null, hi = null;
        for (const [d, b, r] of scan) {
          const v = col === 'box' ? b : r;
          if (d <= 0 && v) lo = d;
          if (d >= 0 && v && hi === null) hi = d;
        }
        return { lo, hi };
      };
      const box = firstSolid('box');
      const ras = firstSolid('raster');
      let disagree = 0;
      for (const [, b, r] of scan) if (b !== r) disagree++;
      return {
        ok: centre < 0 && aside >= 0,
        why: centre >= 0 ? 'carriageway centreline reads SOLID — the hole is not cut'
          : aside < 0 ? 'a point 8 m aside reads OPEN — there is no wall here to be inside of'
          : 'ok',
        gate: gt.id,
        centreSolid: centre >= 0, centreKind: centre >= 0 ? kindOf(centre) : null,
        asideSolid: aside >= 0, asideKind: aside >= 0 ? kindOf(aside) : null,
        boxClear: box, rasterClear: ras,
        // The open span, not the distance between the two solid samples either side of
        // it: 'lo' and 'hi' are the innermost samples that read SOLID, so the hole is one
        // 0.1 m step narrower at each end. Reporting hi-lo would overstate every aperture
        // in this file by 0.2 m, which is the sort of quiet bias that makes two probes
        // disagree for a reason neither can see.
        boxClearWidth: box.lo !== null && box.hi !== null ? +(box.hi - box.lo - 0.2).toFixed(2) : null,
        rasterClearWidth: ras.lo !== null && ras.hi !== null ? +(ras.hi - ras.lo - 0.2).toFixed(2) : null,
        samples: scan.length, disagreeSamples: disagree,
      };
    },

    /**
     * Every unit's frontage, and its narrowest, against the aperture it has to enter.
     *
     * Read out of the same helpers the AI uses, not re-derived here: re-deriving is how a
     * probe comes to agree with itself and with nothing else.
     */
    async widths() {
      const pf = await import('/src/ai/Pathfinding.ts');
      const gt = mainGate();
      const rows = [];
      const seen = new Set();
      for (const u of battle.units) {
        if (u.destroyed) continue;
        const def = battle.typeOf(u);
        if (seen.has(u.typeId)) continue;
        seen.add(u.typeId);
        const fp = pf.footprintOf(u, def);
        rows.push({
          typeId: u.typeId, faction: u.faction, alive: u.alive,
          formation: u.formationId, files: u.width,
          spacingX: +u.spacingX.toFixed(3),
          frontage: +(u.width * u.spacingX).toFixed(2),
          footprintMax: +fp.max.toFixed(2), footprintMin: +fp.min.toFixed(2),
          narrowest: pf.narrowestFormation(def, u.alive || u.initialStrength),
          frontHalf: +battle.frontHalf(u).toFixed(2),
        });
      }
      return { gate: gt ? gt.id : null, rows };
    },

    /**
     * Can a sim route ever be flagged narrow? Read the request the sim actually makes.
     *
     * Instrumented by wrapping requestPath and recording every (radius, minRadius) pair
     * the simulation asks for during one gate order.
     */
    async routeWidths(seconds) {
      const gt = mainGate();
      city.setGateOpen(gt.id, true);
      if (city.setGateDoorBroken) city.setGateDoorBroken(gt.id);
      const calls = [];
      const real = nav.requestPath.bind(nav);
      nav.requestPath = (id, sx, sz, gx, gz, radius, minRadius, priority) => {
        calls.push({ id, radius: +radius.toFixed(2), minRadius: +minRadius.toFixed(2), priority });
        return real(id, sx, sz, gx, gz, radius, minRadius, priority);
      };
      const u = pickCav();
      beginSweep();
      const aiHeld = holdAI();
      const inside = insidePoint(gt, 60);
      engine.events.emit('orderIssued', {
        unitIds: [u.id], kind: 'move', x: inside.x, z: inside.z, facing: gt.facing + Math.PI, running: true,
      });
      for (let t = 0; t < seconds * 30; t++) step();
      endSweep();
      releaseAI();
      nav.requestPath = real;
      const p = nav.pathFor(u.id + 1000000);
      return {
        aiHeld, unitId: u.id, typeId: u.typeId, calls: calls.slice(0, 40),
        callCount: calls.length,
        anyNarrowable: calls.some((c) => c.radius > c.minRadius + 0.5),
        path: p ? { n: p.n, radius: +p.radius.toFixed(2), narrow: !!p.narrow, ok: !!p.ok } : null,
      };
    },

    /** The gate transit itself. */
    gate(opts) {
      const gt = mainGate();
      if (!gt) return { ok: false, why: 'no gate' };
      city.setGateOpen(gt.id, true);
      if (city.setGateDoorBroken) city.setGateDoorBroken(gt.id);

      const u = opts.cavalry ? pickCav() : pickFoot();
      if (!u) return { ok: false, why: 'no candidate unit' };

      // Axis: out of the city is +facing. Lateral is that rotated 90 degrees.
      const ox = Math.sin(gt.facing), oz = Math.cos(gt.facing);
      const lx = Math.cos(gt.facing), lz = -Math.sin(gt.facing);

      // Place the unit on the gate axis, 'standoff' metres out, so the measurement is the
      // transit and not a three-hundred-metre march. Stated in the report: this is a rig,
      // not the owner's own approach.
      const standoff = opts.standoff ?? 55;
      place(u, gt.x + ox * standoff, gt.z + oz * standoff, gt.facing + Math.PI);

      beginSweep();
      const aiHeld = holdAI();
      // Order it to a point 'depth' metres inside the city, on the same axis.
      const dst = insidePoint(gt, opts.depth ?? 60);
      engine.events.emit('orderIssued', {
        unitIds: [u.id], kind: 'move', x: dst.x, z: dst.z, facing: gt.facing + Math.PI, running: true,
      });

      const ticks = (opts.seconds ?? 60) * 30;
      let manTicks = 0, bodyIn = 0, mountIn = 0, centreIn = 0, outsideCorridor = 0, bandTicks = 0;
      let worstLateral = 0;
      // Inside the gatehouse itself, not merely near it. The passage is what is under test;
      // men spread along the outer face queueing for it are not in a wall, they are in a
      // queue, and counting them as 'outside the corridor' inflated the first version of
      // this number from 0 to 88% without a single man being anywhere he should not be.
      const PASSAGE = 6;
      let passageTicks = 0, passageOutside = 0, passageBody = 0, passageMount = 0;
      /*
       * Where each man crossed the wall plane.
       *
       * The one number that cannot be argued with: at the tick a man's along-axis sign
       * flips, how far off the gate's centreline was he? Inside half the drawn stone gap he
       * went through the hole. Outside it he went through the pier.
       */
      const prevOut = new Map();
      const crossings = [];
      const perKind = {};
      const streak = new Int32Array(pool.x.length);
      let persistent = 0, maxStreak = 0;
      const rows = [];
      // Depth band: within 12 m of the wall plane along the gate axis is "in the gate".
      const BAND = 12;
      let clearedAt = null;
      for (let t = 0; t < ticks; t++) {
        step();
        let insideCity = 0, live = 0;
        for (const i of u.members) {
          const st = pool.state[i];
          if (st === 10 || st === 11) continue;
          live++;
          manTicks++;
          const x = pool.x[i], z = pool.z[i], y = pool.y[i];
          const el = battle.elevated[i] !== 0;
          // Along-axis signed distance from the gate: positive outside the city.
          const dOut = (x - gt.x) * ox + (z - gt.z) * oz;
          const dLat = (x - gt.x) * lx + (z - gt.z) * lz;
          if (dOut < -2) insideCity++;
          if (!el) {
            const c = solidAt(x, z, y, 0);
            const b = solidAt(x, z, y, 0.42);
            const m = solidAt(x, z, y, 1.05);
            if (c >= 0) { centreIn++; perKind[kindOf(c)] = (perKind[kindOf(c)] ?? 0) + 1; }
            if (b >= 0) bodyIn++;
            if (m >= 0) mountIn++;
            if (b >= 0) {
              const run = (streak[i] ?? 0) + 1; streak[i] = run;
              if (run > maxStreak) maxStreak = run;
              if (run > 30) persistent++;
            } else streak[i] = 0;
          }
          const lat = Math.abs(dLat);
          if (Math.abs(dOut) <= BAND) {
            bandTicks++;
            if (lat > worstLateral) worstLateral = lat;
            // Outside the carriageway: beyond half the drawn stone gap.
            if (lat > (city.plan.gateOpenWidth * 0.5)) outsideCorridor++;
          }
          if (Math.abs(dOut) <= PASSAGE) {
            passageTicks++;
            if (lat > (city.plan.gateOpenWidth * 0.5)) passageOutside++;
            if (!el) {
              if (solidAt(x, z, y, 0.42) >= 0) passageBody++;
              if (solidAt(x, z, y, 1.05) >= 0) passageMount++;
            }
          }
          const was = prevOut.get(i);
          if (was !== undefined && was > 0 && dOut <= 0) {
            crossings.push({ lat: +lat.toFixed(2), t: +((t + 1) / 30).toFixed(1) });
          }
          prevOut.set(i, dOut);
        }
        if (clearedAt === null && live > 0 && insideCity >= live * 0.9) clearedAt = (t + 1) / 30;
        if (t % 30 === 29) rows.push({
          t: (t + 1) / 30, alive: u.alive, order: u.order,
          x: +u.x.toFixed(1), z: +u.z.toFixed(1), files: u.width,
          squeezedFrom: battle.squeezedFrom ? battle.squeezedFrom(u.id) : -1,
          corridor: battle.corridorOf
            ? +(Number.isFinite(battle.corridorOf(u.id)) ? battle.corridorOf(u.id) : -1).toFixed(2)
            : -1,
          formation: u.formationId, wps: u.waypoints.length,
          inside: insideCity, live,
        });
      }
      endSweep();
      releaseAI();

      // Where the men finished, relative to the wall plane.
      let through = 0, live = 0;
      for (const i of u.members) {
        const st = pool.state[i];
        if (st === 10 || st === 11) continue;
        live++;
        const dOut = (pool.x[i] - gt.x) * ox + (pool.z[i] - gt.z) * oz;
        if (dOut < -2) through++;
      }
      return {
        ok: true, aiHeld, gate: gt.id, unitId: u.id, typeId: u.typeId,
        formation: u.formationId, files: u.width, frontage: +(u.width * u.spacingX).toFixed(2),
        manTicks, centreInMasonry: centreIn, bodyInMasonry: bodyIn, mountInMasonry: mountIn,
        perKind, persistentManTicks: persistent, longestStreakTicks: maxStreak,
        bandManTicks: bandTicks, outsideCorridorManTicks: outsideCorridor,
        worstLateral: +worstLateral.toFixed(2),
        passageManTicks: passageTicks, passageOutsideCorridor: passageOutside,
        passageBodyInMasonry: passageBody, passageMountInMasonry: passageMount,
        crossings: crossings.length,
        crossingsThroughPier: crossings.filter((c) => c.lat > city.plan.gateOpenWidth * 0.5).length,
        worstCrossingLateral: crossings.length
          ? +Math.max(...crossings.map((c) => c.lat)).toFixed(2) : null,
        crossingLaterals: crossings.map((c) => c.lat).sort((a, b) => b - a).slice(0, 12),
        secondsToClear: clearedAt, throughAtEnd: through, liveAtEnd: live,
        rows,
      };
    },

    /** A unit inside the city, broken, and what it does about the wall in its way. */
    rout(opts) {
      const gt = mainGate();
      if (!gt) return { ok: false, why: 'no gate' };
      const ox = Math.sin(gt.facing), oz = Math.cos(gt.facing);

      // An invader — the faction attacking the city — placed inside the circuit, off the
      // gate axis so the straight line home is through stone rather than through the hole.
      const u = pickFoot();
      if (!u) return { ok: false, why: 'no candidate' };
      const off = opts.lateral ?? 60;
      const lx = Math.cos(gt.facing), lz = -Math.sin(gt.facing);
      const px = gt.x + lx * off - ox * (opts.depth ?? 35);
      const pz = gt.z + lz * off - oz * (opts.depth ?? 35);
      place(u, px, pz, gt.facing + Math.PI);

      // And an enemy on the city side of him, so "away from the enemy" points at the wall.
      const foe = pickFoe(u.faction);
      if (foe) place(foe, px - ox * 40, pz - oz * 40, gt.facing);

      beginSweep();
      const aiHeld = holdAI();
      let navCalls = 0;
      const realReq = nav.requestPath.bind(nav);
      nav.requestPath = (...a) => { navCalls++; return realReq(...a); };

      battle.rout(u);
      const ticks = (opts.seconds ?? 45) * 30;
      let manTicks = 0, bodyIn = 0, mountIn = 0, stuckTicks = 0, minWallGap = Infinity;
      // Everything below is counted **only while the unit is actually routing**.
      //
      // Not a nicety. The first cut of this counted no-progress ticks over the whole window
      // and reported 6% before the change and 31% after, which reads as a fourfold
      // regression and is nothing of the kind: the routed unit that ran in a straight line
      // got far enough from every enemy to be retired from the field at t+43, while the one
      // that deflected round two buildings stayed in the fight, rallied at t+32 and then
      // stood still under a Hold order for the remaining thirteen seconds. A metric that
      // counts a rallied unit standing at ease as a unit stuck against a wall cannot answer
      // the question this file exists to ask.
      let routTicks = 0, nearWallTicks = 0, rallyAt = null;
      const rows = [];
      let px0 = u.x, pz0 = u.z, travelled = 0;
      const ROUT_ORDER = u.order;
      for (let t = 0; t < ticks; t++) {
        const bx = u.x, bz = u.z;
        const wasRouting = u.order === ROUT_ORDER;
        step();
        if (u.order !== ROUT_ORDER && rallyAt === null && wasRouting) rallyAt = (t + 1) / 30;
        const routingNow = u.order === ROUT_ORDER;
        const moved = Math.hypot(u.x - bx, u.z - bz);
        const gap = forwardGap(u);
        if (routingNow) {
          routTicks++;
          travelled += moved;
          if (moved < 0.02) stuckTicks++;
          if (gap < 3) nearWallTicks++;
          if (gap < minWallGap) minWallGap = gap;
          for (const i of u.members) {
            const st = pool.state[i];
            if (st === 10 || st === 11) continue;
            manTicks++;
            if (battle.elevated[i] !== 0) continue;
            if (solidAt(pool.x[i], pool.z[i], pool.y[i], 0.42) >= 0) bodyIn++;
            if (solidAt(pool.x[i], pool.z[i], pool.y[i], 1.05) >= 0) mountIn++;
          }
        }
        if (t % 30 === 29) rows.push({
          t: (t + 1) / 30, order: u.order, alive: u.alive,
          x: +u.x.toFixed(1), z: +u.z.toFixed(1),
          tx: +u.targetX.toFixed(1), tz: +u.targetZ.toFixed(1),
          wps: u.waypoints.length,
          dOut: +(((u.x - gt.x) * ox + (u.z - gt.z) * oz)).toFixed(1),
          gap: +gap.toFixed(2), navCalls,
        });
      }
      endSweep();
      releaseAI();
      nav.requestPath = realReq;
      const dOut = (u.x - gt.x) * ox + (u.z - gt.z) * oz;
      return {
        ok: true, aiHeld, unitId: u.id, typeId: u.typeId,
        startedAt: { x: +px0.toFixed(1), z: +pz0.toFixed(1) },
        endedAt: { x: +u.x.toFixed(1), z: +u.z.toFixed(1) },
        distanceTravelled: +travelled.toFixed(1),
        netDisplacement: +Math.hypot(u.x - px0, u.z - pz0).toFixed(1),
        escapedCircuit: dOut > 2,
        dOutAtEnd: +dOut.toFixed(1),
        manTicks, bodyInMasonry: bodyIn, mountInMasonry: mountIn,
        stuckTicks, ticks, routTicks, nearWallTicks, rallyAt,
        minForwardGap: Number.isFinite(minWallGap) ? +minWallGap.toFixed(2) : null,
        navRequestsWhileRouting: navCalls,
        waypointsEverQueued: rows.some((r) => r.wps > 0),
        rows,
      };
    },

    /**
     * What the mechanism costs, in milliseconds of simulation.
     *
     * Wall-clock over a fixed tick count with rendering off, on the busiest battle there
     * is. Timed inside the page so the Playwright round trip is not in the number, and
     * reported as a median of three runs because a shared GPU box does not give the same
     * answer twice.
     */
    cost(ticks, runs) {
      const ms = [];
      beginSweep();
      // Warm the JIT and get the armies to the wall, where the corridor work actually runs.
      for (let t = 0; t < 150 * 30; t++) step();
      for (let r = 0; r < runs; r++) {
        const t0 = performance.now();
        for (let t = 0; t < ticks; t++) step();
        ms.push(performance.now() - t0);
      }
      endSweep();
      ms.sort((a, b) => a - b);
      let squeezed = 0;
      for (const u of battle.units) {
        if (!u.destroyed && battle.squeezedFrom && battle.squeezedFrom(u.id) >= 0) squeezed++;
      }
      return {
        ticks, runs, men: pool.count, units: battle.units.length,
        medianMs: +ms[ms.length >> 1].toFixed(1),
        perTickMs: +(ms[ms.length >> 1] / ticks).toFixed(4),
        all: ms.map((v) => +v.toFixed(1)),
        squeezedNow: squeezed,
      };
    },

    /**
     * The same question asked of the battle itself rather than of a rig.
     *
     * No placement, no forced break, no held AI: run the assault and watch every unit that
     * breaks on its own. A staged rout is repeatable and a real one is the report, and a
     * change that only helps the staged one has not helped anybody.
     */
    routField(seconds, warmup) {
      beginSweep();
      for (let t = 0; t < (warmup | 0) * 30; t++) step();
      const prev = new Map();
      let routTicks = 0, stuck = 0, nearWall = 0, manTicks = 0, bodyIn = 0;
      let worstStreak = 0, unitsBroken = 0;
      const streak = new Map();
      const ticks = seconds * 30;
      for (let t = 0; t < ticks; t++) {
        step();
        for (const u of battle.units) {
          if (u.destroyed || u.alive === 0) continue;
          if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
          const routing = u.order === 5;
          const was = prev.get(u.id);
          if (routing && (was === undefined || !was.routing)) unitsBroken++;
          if (routing) {
            routTicks++;
            if (was && Math.hypot(u.x - was.x, u.z - was.z) < 0.02) stuck++;
            const gap = forwardGap(u);
            if (gap < 3) {
              nearWall++;
              const run = (streak.get(u.id) ?? 0) + 1;
              streak.set(u.id, run);
              if (run > worstStreak) worstStreak = run;
            } else streak.set(u.id, 0);
            for (const i of u.members) {
              const st = pool.state[i];
              if (st === 10 || st === 11) continue;
              manTicks++;
              if (battle.elevated[i] !== 0) continue;
              if (solidAt(pool.x[i], pool.z[i], pool.y[i], 0.42) >= 0) bodyIn++;
            }
          }
          prev.set(u.id, { x: u.x, z: u.z, routing });
        }
      }
      endSweep();
      return {
        ticks, warmup, unitsBroken, routTicks, stuck, nearWall, manTicks, bodyIn,
        worstNearWallStreakTicks: worstStreak,
        stuckPct: routTicks ? +(stuck / routTicks * 100).toFixed(1) : 0,
        nearWallPct: routTicks ? +(nearWall / routTicks * 100).toFixed(1) : 0,
        bodyPerMille: manTicks ? +(bodyIn / manTicks * 1000).toFixed(1) : 0,
      };
    },
  };

  // ---- helpers ------------------------------------------------------------------
  function insidePoint(gt, depth) {
    const ox = Math.sin(gt.facing), oz = Math.cos(gt.facing);
    return { x: gt.x - ox * depth, z: gt.z - oz * depth };
  }
  /** Metres from the anchor to the first solid along its own heading, capped at 40. */
  function forwardGap(u) {
    const fx = Math.sin(u.facing), fz = Math.cos(u.facing);
    const y = battle.groundAt(u.x, u.z) + 0.9;
    for (let d = 0.5; d <= 40; d += 0.5) {
      if (solidAt(u.x + fx * d, u.z + fz * d, y, 0.42) >= 0) return d;
    }
    return 40;
  }
  function pickCav() {
    let best = null;
    for (const u of battle.units) {
      if (u.destroyed || u.alive === 0) continue;
      if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
      const def = battle.typeOf(u);
      if (!def || !(def.unitClass === 'heavy-cavalry' || def.unitClass === 'light-cavalry')) continue;
      if (!best || u.alive > best.alive) best = u;
    }
    return best;
  }
  function pickFoot() {
    let best = null;
    for (const u of battle.units) {
      if (u.destroyed || u.alive === 0) continue;
      if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
      const def = battle.typeOf(u);
      if (!def || def.unitClass === 'heavy-cavalry' || def.unitClass === 'light-cavalry' || def.walkSpeed < 1.0) continue;
      if (!best || u.alive > best.alive) best = u;
    }
    return best;
  }
  function pickFoe(faction) {
    for (const u of battle.units) {
      if (u.destroyed || u.alive === 0 || u.faction === faction) continue;
      if (battle.siege && battle.siege.ownsUnit && battle.siege.ownsUnit(u.id)) continue;
      return u;
    }
    return null;
  }
  /** Move a unit and its men bodily, preserving their formation offsets. */
  function place(u, x, z, facing) {
    const dx = x - u.x, dz = z - u.z;
    for (const i of u.members) {
      pool.x[i] += dx; pool.z[i] += dz;
      pool.y[i] = battle.groundAt(pool.x[i], pool.z[i]);
      pool.vx[i] = 0; pool.vz[i] = 0;
      pool.facing[i] = facing;
    }
    u.x = x; u.z = z; u.facing = facing; u.targetFacing = facing;
    u.targetX = x; u.targetZ = z; u.waypoints.length = 0;
    u.contactLock = false;
  }
})();
`;

const mapToken = (MAP || FOE)
  ? '&battle=' + encodeConfig({
      ...(MAP ? { map: MAP } : {}),
      ...(FOE === 'carthage' ? { opponent: 2 } : {}),
      unitSize: 'ultra',
      rome: { 'legio-cohort': 6, 'praetorian-cohort': 2, 'urban-cohort': 2, sagittarii: 2, equites: 3, scorpio: 1 },
      juthungi: { 'juthungi-warband': 6, 'juthungi-spears': 3, 'juthungi-skirmishers': 3, 'juthungi-chosen': 2, 'juthungi-berserkers': 2, 'juthungi-riders': 3 },
      quality: QUALITY, difficulty: 'hard', seed: 4265438264,
    })
  : '';
const url = `${base}/?harness=1&quality=${QUALITY}&w=960&h=540&scenario=assault${mapToken}`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

const boot = async () => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  await page.evaluate(KIT);
};

console.log(`• ${url}`);
await boot();
const out = { url, map: MAP || 'campus-martius' };
out.info = await page.evaluate(() => window.__ap.info());
console.log(`  city ${out.info.hasCity ? 'yes' : 'NO'}  nav ${out.info.hasNav ? 'yes' : 'NO'}`
  + `  obstacles ${out.info.obstacles}  units ${out.info.units}  men ${out.info.men}`);
console.log(`  gates ${out.info.gates.map((g) => `${g.id}@${g.x},${g.z}${g.open ? ' open' : ''}`).join('  ')}`);
console.log(`  plan.gateOpenWidth ${out.info.plan?.gateOpenWidth}`);

// ---- the instrument, first ------------------------------------------------------
out.selftest = await page.evaluate(() => window.__ap.selftest());
const st = out.selftest;
console.log(`\n── self-test ────────────────────────────────────────`);
console.log(`  ${st.ok ? 'PASS' : 'FAIL'}  ${st.why}`);
console.log(`  centreline solid ${st.centreSolid} (${st.centreKind})   8 m aside solid ${st.asideSolid} (${st.asideKind})`);
console.log(`  clear width: collision boxes ${st.boxClearWidth} m [${st.boxClear.lo} … ${st.boxClear.hi}]`);
console.log(`               nav/occupancy   ${st.rasterClearWidth} m [${st.rasterClear.lo} … ${st.rasterClear.hi}]`);
console.log(`  the two truths disagree on ${st.disagreeSamples}/${st.samples} samples across the mouth`);
if (!st.ok) {
  console.error('\ninstrument failed its own test; no measurement follows');
  await browser.close();
  if (JSON_OUT) { await mkdir(path.dirname(JSON_OUT), { recursive: true }); await writeFile(JSON_OUT, JSON.stringify(out, null, 2)); }
  process.exit(3);
}

if (want('widths')) {
  out.widths = await page.evaluate(() => window.__ap.widths());
  console.log(`\n── frontage against a ${out.info.plan?.gateOpenWidth} m aperture ──────────`);
  for (const r of out.widths.rows.sort((a, b) => b.frontage - a.frontage)) {
    console.log(`  ${r.typeId.padEnd(20)} ${String(r.alive).padStart(4)} men  ${r.formation.padEnd(11)}`
      + ` ${String(r.files).padStart(3)} files  frontage ${String(r.frontage).padStart(6)} m`
      + `  fp ${r.footprintMax}/${r.footprintMin}  narrowest ${r.narrowest}`
      + `  frontHalf ${r.frontHalf}`);
  }
}

if (want('routewidths')) {
  await boot();
  out.routeWidths = await page.evaluate(() => window.__ap.routeWidths(6));
  const rw = out.routeWidths;
  console.log(`\n── what width does the sim ask for? ─────────────────`);
  console.log(`  ${rw.callCount} requestPath calls; any with room to narrow: ${rw.anyNarrowable}`);
  for (const c of rw.calls.slice(0, 8)) {
    console.log(`    id ${c.id}  radius ${c.radius}  minRadius ${c.minRadius}  prio ${c.priority}`);
  }
  console.log(`  resulting path: ${JSON.stringify(rw.path)}`);
}

if (want('gate')) {
  await boot();
  const CAV = !args.has('infantry');
  out.gate = await page.evaluate((cav) => window.__ap.gate({ cavalry: cav, seconds: 70 }), CAV);
  const r = out.gate;
  console.log(`\n── gate transit, ${CAV ? 'cavalry' : 'infantry'} ─────────────────────────`);
  if (!r.ok) console.log(`  skipped: ${r.why}`);
  else {
    console.log(`  ${r.typeId} ${r.formation} ${r.files} files, ${r.frontage} m of frontage`);
    console.log(`  man-ticks ${r.manTicks}`);
    console.log(`    centre inside masonry  ${r.centreInMasonry}  (${(r.centreInMasonry / r.manTicks * 1000).toFixed(1)}‰)`);
    console.log(`    body   inside masonry  ${r.bodyInMasonry}  (${(r.bodyInMasonry / r.manTicks * 1000).toFixed(1)}‰)`);
    console.log(`    mount  inside masonry  ${r.mountInMasonry}  (${(r.mountInMasonry / r.manTicks * 1000).toFixed(1)}‰)`);
    console.log(`    by kind ${JSON.stringify(r.perKind)}`);
    console.log(`    persistent (>1 s continuous) ${r.persistentManTicks}, longest streak ${r.longestStreakTicks} ticks`);
    console.log(`  within 12 m of the wall plane: ${r.bandManTicks} man-ticks, ${r.outsideCorridorManTicks} outside the carriageway (queueing counts here)`);
    console.log(`  inside the gatehouse passage: ${r.passageManTicks} man-ticks`);
    console.log(`    outside the 5.2 m carriageway  ${r.passageOutsideCorridor}`);
    console.log(`    body touching stone            ${r.passageBodyInMasonry}`);
    console.log(`    mount overlapping stone        ${r.passageMountInMasonry}`);
    console.log(`  wall-plane crossings ${r.crossings}, of which ${r.crossingsThroughPier} were outside the carriageway`);
    console.log(`    worst crossing offset ${r.worstCrossingLateral} m; top offsets ${JSON.stringify(r.crossingLaterals)}`);
    console.log(`  worst lateral offset anywhere in the band ${r.worstLateral} m`);
    console.log(`  seconds to get 90% inside: ${r.secondsToClear ?? 'never'}   through at end ${r.throughAtEnd}/${r.liveAtEnd}`);
    console.log(`  files/corridor by second: ${r.rows.map((q) => `${q.t}:${q.files}${q.squeezedFrom >= 0 ? '<' + q.squeezedFrom : ''}/${q.corridor}`).join(' ')}`);
  }
}

if (want('rout')) {
  await boot();
  out.rout = await page.evaluate(() => window.__ap.rout({ seconds: 45 }));
  const r = out.rout;
  console.log(`\n── a broken unit inside the city ────────────────────`);
  if (!r.ok) console.log(`  skipped: ${r.why}`);
  else {
    console.log(`  ${r.typeId} placed at ${JSON.stringify(r.startedAt)}, broken on tick 0`);
    console.log(`  travelled ${r.distanceTravelled} m, net displacement ${r.netDisplacement} m`);
    console.log(`  routing for ${r.routTicks}/${r.ticks} ticks${r.rallyAt ? `, rallied at t+${r.rallyAt}s` : ''}`);
    console.log(`  anchor made no progress on ${r.stuckTicks}/${r.routTicks} routing ticks`
      + ` (${(r.stuckTicks / Math.max(1, r.routTicks) * 100).toFixed(0)}%)`);
    console.log(`  routing ticks with a solid inside 3 m of its own heading: ${r.nearWallTicks}`
      + ` (${(r.nearWallTicks / Math.max(1, r.routTicks) * 100).toFixed(0)}%)`);
    console.log(`  closest the anchor's own heading came to a solid: ${r.minForwardGap} m`);
    console.log(`  man-ticks with a body in masonry ${r.bodyInMasonry}/${r.manTicks}`
      + ` (${(r.bodyInMasonry / Math.max(1, r.manTicks) * 1000).toFixed(1)}‰)`);
    console.log(`  pathfinder consulted while routing: ${r.navRequestsWhileRouting} requests;`
      + ` waypoints ever queued: ${r.waypointsEverQueued}`);
    console.log(`  escaped the circuit: ${r.escapedCircuit} (dOut ${r.dOutAtEnd} m)`);
    for (const row of r.rows) {
      console.log(`    t${String(row.t).padStart(3)}s  at (${row.x}, ${row.z})  target (${row.tx}, ${row.tz})`
        + `  dOut ${row.dOut}  fwdGap ${row.gap}  wps ${row.wps}  nav ${row.navCalls}`);
    }
  }
}

if (want('routfield')) {
  await boot();
  out.routField = await page.evaluate(([s2, w]) => window.__ap.routField(s2, w), [Number(args.get('seconds') ?? 180), Number(args.get('warmup') ?? 150)]);
  const r = out.routField;
  console.log(`\n── every unit that broke on its own, ${r.warmup} s warm-up + ${r.ticks / 30} s ──`);
  console.log(`  units that broke ${r.unitsBroken}, routing unit-ticks ${r.routTicks}`);
  console.log(`  no anchor progress   ${r.stuck} (${r.stuckPct}%)`);
  console.log(`  solid inside 3 m of its own heading ${r.nearWall} (${r.nearWallPct}%),`
    + ` worst continuous streak ${r.worstNearWallStreakTicks} ticks`);
  console.log(`  man-ticks with a body in masonry ${r.bodyIn}/${r.manTicks} (${r.bodyPerMille}‰)`);
}

if (want('cost')) {
  await boot();
  out.cost = await page.evaluate(([t, r]) => window.__ap.cost(t, r), [900, 3]);
  const c = out.cost;
  console.log(`\n── tick cost, ${c.men} men, ${c.units} units ──────────────`);
  console.log(`  ${c.ticks} ticks x ${c.runs}: median ${c.medianMs} ms → ${c.perTickMs} ms/tick   runs ${JSON.stringify(c.all)}`);
  console.log(`  units filed up at the end of the run: ${c.squeezedNow}`);
}

out.pageErrors = errs;
if (errs.length) console.log(`\npage errors: ${errs.length}\n  ${errs.slice(0, 5).join('\n  ')}`);
await browser.close();
if (JSON_OUT) {
  await mkdir(path.dirname(JSON_OUT), { recursive: true });
  await writeFile(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
