#!/usr/bin/env node
/**
 * How many men are stuck, where, and in what.
 *
 * The report this exists for, from the owner, 1 Sep 2026:
 *
 *   > "a lot of units getting stuck into the walls or buildings. typically happens during
 *   >  navigation but they get trapped"
 *   > "lots of issues with soldiers walking up stairs to get onto and off of the walls."
 *
 * Neither is a measurement, and this file's only job is to turn them into two.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ## What "stuck" is, and the five things it is not
 *
 * A man who has stopped is not stuck. `MAP-METHOD.md` §1 rule 12 — a degenerate statistic
 * reports a confident number rather than an error — cuts both ways here: a detector that
 * calls every stationary man stuck reports a huge confident number, and one that cannot fire
 * reports zero. So the predicate is explicitly *five conjunctions and five exclusions*, and
 * every exclusion is counted and printed by name (rule 16: an exclusion is a claim).
 *
 * `STUCK(i)` over a window of `WINDOW` ticks holds when **all** of:
 *
 *   1. **Commanded.** His unit is live (`!destroyed`, `alive > 0`) and holds a movement order
 *      — `MoveTo`, `AttackMove` or `AttackUnit`. Somebody told this body to be elsewhere.
 *      A `Hold` or `Garrison` unit standing still is doing what it was told.
 *   2. **Not excused.** For every tick of the window his `SoldierState` is outside
 *      {Fighting, Dying, Dead, Routing, Staggered, Cheering, Climbing, Bracing, Throwing,
 *      Shooting, Reloading}. A man in melee, a man who has broken, a man winding up a pilum
 *      and a man mid-ladder are all legitimately not translating.
 *   3. **Not arrived.** He is further than `GOAL_EPS` from the slot he is being steered at
 *      (`BattleSystem.slotX/slotZ`, the sim's own per-man goal). A dressed rank is not stuck.
 *   4. **Not moving.** Path length integrated over the window is under `CREEP`, *and* his
 *      distance to that goal closed by under `PROGRESS`. Both, because a man shuffling on the
 *      spot fails the first and a man walking a circuit fails the second, and they are
 *      different faults — the second is reported separately as `orbiting`.
 *   5. **Not blocked by his own side.** No living friendly stands within `QUEUE_R` of him in
 *      the 120-degree sector toward his goal. A column waiting its turn at a gate is queuing,
 *      which is correct behaviour, and it is the single largest false positive this predicate
 *      has. It is *counted* as `queued` rather than discarded, so the size of the exclusion is
 *      visible on every run.
 *
 * The five exclusions above are the false-negative surface, stated plainly:
 *
 *   - **A man genuinely wedged while also in melee is not counted.** Exclusion 2 is a real
 *     blind spot and it is deliberate: on a wall assault most stationary men are fighting, and
 *     without it the number is dominated by the melee. `stuckFighting` is printed beside the
 *     headline as the size of what is being given up.
 *   - **A man wedged inside a friendly crush is not counted** (exclusion 5), and `queued` is
 *     printed for the same reason.
 *   - **A man whose whole unit is wedged is counted**, because the unit still holds a movement
 *     order — this is the case the owner is reporting and it must not be excused.
 *   - **A man stuck for less than `WINDOW` ticks is not counted.** 2 s at 30 Hz. A transient
 *     shove against a corner is not a trap.
 *   - **An `elevated` man is not counted here at all.** The siege system writes his position
 *     directly and `integrate` exempts him from collision, so the ground predicate is
 *     meaningless for him. He is measured by the `stairs` arm instead, which is the second
 *     owner report and a different manoeuvre.
 *
 * ## The instrument compares against something outside the thing being checked (rule 6)
 *
 * Three independent references, and they are reported separately so they can disagree:
 *
 *   - **The order.** "Commanded somewhere" comes from `UnitGroupState.order`, which is set by
 *     the order log and the AI, not by the mover.
 *   - **The rest of his unit.** `abandoned` is the subset of stuck men whose unit *anchor*
 *     travelled more than `UNIT_MOVED` metres during the same window in which they travelled
 *     less than `CREEP`. No self-comparison can produce that number: it is the man against his
 *     own cohort, and it is the exact signature the owner describes — the line walks on and a
 *     few men stay in the wall.
 *   - **Two rasterisations of the same stone.** Where a stuck man is standing is classified
 *     both by `BattleSystem.masonry` (the oriented-box set the mover collides against) *and*
 *     by `CitySystem.blocksMovement` (the city's own 4 m occupancy grid, built by a different
 *     function from the same footprints). Rule 11 is that these two producers have never been
 *     compared; `solidDisagree` is that comparison, and it is free here.
 *
 * ## Proving it can fire, and proving it can be wrong
 *
 * A count of zero from a detector that cannot fire is worth nothing, so `--only=controls`
 * runs six, on the real battle, on real maps, against real stone. Five are *injections*: the
 * harness perturbs the world (it teleports real men one time) and never the probe's own
 * thresholds or reference data.
 *
 *   | control        | perturbation                                   | must |
 *   |----------------|------------------------------------------------|------|
 *   | `wedge`        | 24 men of a marching cohort placed 0.1 m inside a real wall box | FIRE, >= 20 of 24 |
 *   | `shell`        | 24 men placed in the 0.42 m radius shell *outside* that box's face | FIRE — this is the predicted trap |
 *   | `displace`     | the same 24 men placed 40 m away on open ground | NOT fire (they walk back) |
 *   | `melee`        | 24 men wedged while their unit is engaged       | NOT fire (exclusion 2 holds) |
 *   | `hold`         | 24 men wedged with the unit ordered `Hold`      | NOT fire (exclusion 1 holds) |
 *   | `null`         | nothing injected, same unit, same order         | the baseline the four are read against |
 *
 * `wedge` and `shell` failing to fire is a broken detector. `displace`, `melee` or `hold`
 * firing is a false positive with a name attached. All six run on one page load each.
 *
 * ## The stairs arm
 *
 * Getting **onto** a wall and getting **off** it are two manoeuvres and are counted
 * separately, because they can fail differently and the second report says they do. For each
 * direction the arm orders a real cohort to do it and measures: how many men started the
 * crossing, how many completed it, how many were still on the flight at the deadline, how
 * many never reached the foot of it at all, and the wall-clock the median man took. A
 * detector written on ground-plane movement alone cannot see either — a man on a stair is
 * making progress in y — so the stair arm reads `Siege.crossOf` / `stationOf` and the man's
 * own y, and never the ground-plane predicate above. **Which way this one errs:** it counts a
 * man who is *slowly* climbing as in-progress, not as stuck, so a stair that is merely far too
 * slow reads as `onFlightAtDeadline` rather than as a failure. The deadline is printed.
 *
 * ## Usage
 *
 *     node tools/probe-stuck.mjs --port=5733
 *     node tools/probe-stuck.mjs --port=5733 --battle='map=campus-martius&scenario=assault'
 *     node tools/probe-stuck.mjs --port=5733 --battle='map=carthage&scenario=assault'
 *     node tools/probe-stuck.mjs --port=5733 --only=controls
 *     node tools/probe-stuck.mjs --port=5733 --json=screenshots/stuck-before.json
 *
 * `--battle` takes the same query string `tools/qa-determinism.mjs` does, and for the same
 * reason: a short name is silently ignored and measures the field battle under another map's
 * name. It is validated here too.
 */

import path from 'node:path';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const PORT = Number(args.get('port') ?? 5733);
const BATTLE = args.get('battle') ?? '';
const SECONDS = Number(args.get('seconds') ?? 200);
const SAMPLE_AT = (args.get('at') ?? '30,60,90,120,160,200').split(',').map(Number);
const JSON_OUT = args.get('json') ?? null;
/*
 * Where to write the picture, and where to stand for it.
 *
 * `--camera` exists so a before shot and an after shot are the SAME shot. Left to choose for
 * itself the probe parks on the worst trapped man, and after the fix there is no worst
 * trapped man, so the two frames would be of two different places and would prove nothing.
 * The before run prints the camera it chose; the after run is given it.
 */
const SHOT = args.get('shot') ?? null;
const CAMERA = args.get('camera') ? String(args.get('camera')).split(',').map(Number) : null;
const ONLY = args.has('only') ? new Set(String(args.get('only')).split(',')) : null;
const want = (k) => !ONLY || ONLY.has(k);
const base = `http://127.0.0.1:${PORT}`;

/*
 * `--battle` must name a battle. Copied in spirit from `qa-determinism.mjs`, which documents
 * why: a misspelled or short-name flag is silently ignored, loads the default field battle and
 * reports it under the name you asked for. Three battles exist and these are their spellings.
 */
const BATTLE_KEYS = new Set([
  'autoplay', 'battle', 'deploy', 'difficulty', 'enemy', 'from', 'h', 'harness', 'map',
  'quality', 'scenario', 'seed', 'size', 'w',
]);
if (BATTLE) {
  const segs = BATTLE.split('&').map((s) => s.trim()).filter(Boolean);
  const bad = segs.filter((s) => !/^[^=]+=[^=]*$/.test(s) || !BATTLE_KEYS.has(s.split('=')[0]));
  if (bad.length) {
    console.error(`--battle=${BATTLE} is not a battle. Offending: ${bad.join(', ')}\n`);
    console.error('  The three real invocations:');
    console.error('    node tools/probe-stuck.mjs                  # field battle, 8,632 men');
    console.error("    node tools/probe-stuck.mjs --battle='map=campus-martius&scenario=assault'  # 3,072");
    console.error("    node tools/probe-stuck.mjs --battle='map=carthage&scenario=assault'        # 3,440");
    process.exit(2);
  }
}
const BATTLE_KEY = BATTLE
  ? BATTLE.split('&').map((s) => s.trim()).filter(Boolean).sort().join('&')
  : 'default';

// ---------------------------------------------------------------------------
// The detector, as a string evaluated in the page. Everything below `HELPERS` reads the
// simulation's own arrays; nothing writes to them except the named injections.
// ---------------------------------------------------------------------------
const HELPERS = `
window.__stuck = (() => {
  const g = window.__game, b = g.battle, p = b.pool, s = b.siege;
  const city = g.engine.context.tryGet ? g.engine.context.tryGet('city') : g.engine.context.get('city');
  g.engine.stop();

  /** One 30 Hz fixed tick at the 60 Hz frame step the determinism pin uses. */
  const step = () => g.engine.advance(1 / 30, 1000 / 60, { render: false });
  const run = (sec) => { const n = Math.round(sec * 30); for (let k = 0; k < n; k++) step(); };

  // ---- thresholds. Every one of them is printed with the result. -----------
  const T = {
    WINDOW: 60,        // ticks the man must fail to progress for; 2 s at 30 Hz
    CREEP: 0.20,       // m of integrated path over the window
    PROGRESS: 0.30,    // m of closing on his own goal over the window
    GOAL_EPS: 2.0,     // m; nearer his slot than this and he has arrived
    QUEUE_R: 1.00,     // m; a living friendly this close ahead is a queue, not a trap
    UNIT_MOVED: 5.0,   // m the unit anchor must travel for a stuck man to be 'abandoned'
    RADIUS: 0.42,      // SOLDIER_RADIUS, from BattleSystem
  };

  const S = { Fighting: 4, Bracing: 5, Throwing: 6, Shooting: 7, Reloading: 8,
              Staggered: 9, Dying: 10, Dead: 11, Routing: 12, Climbing: 13, Cheering: 14 };
  const EXCUSED = new Set([S.Fighting, S.Bracing, S.Throwing, S.Shooting, S.Reloading,
                           S.Staggered, S.Dying, S.Dead, S.Routing, S.Climbing, S.Cheering]);
  /** MoveTo, AttackMove, AttackUnit. Hold(0), Withdraw(4), Rout(5), Garrison(6) are not. */
  const MOVING_ORDER = new Set([1, 2, 3]);

  const unitOf = (i) => b.units.find((u) => u.id === p.unitId[i]);
  const unitIndex = () => { const m = new Map(); for (const u of b.units) m.set(u.id, u); return m; };

  /** Which box a point is in, at two inflations, and what the city's own raster says. */
  const classify = (x, z, y) => {
    const solid = b.masonry.solidAt(x, z, y, 0);
    const shell = b.masonry.solidAt(x, z, y, T.RADIUS);
    const raster = city && city.blocksMovement ? city.blocksMovement(x, z, x, z) : null;
    const idx = solid >= 0 ? solid : shell;
    const kind = idx >= 0 ? (b.masonry.items ? b.masonry.items[idx].kind : 'unknown') : null;
    return {
      inSolid: solid >= 0,
      inShell: solid < 0 && shell >= 0,
      clear: shell < 0,
      kind,
      box: idx,
      raster,
    };
  };

  /**
   * Watch every living man for \`ticks\` ticks and return the stuck census.
   *
   * One pass, no allocation per tick beyond the accumulators, because this runs over 8,632
   * men for six hundred ticks and a probe that takes ten minutes does not get run.
   */
  const census = (ticks, mark, eachTick) => {
    const marked = mark ? new Set(mark) : null;
    const n = p.count;
    const x0 = new Float32Array(n), z0 = new Float32Array(n);
    const lx = new Float32Array(n), lz = new Float32Array(n);
    const pathLen = new Float32Array(n);
    const d0 = new Float32Array(n);
    const excused = new Uint8Array(n);
    const wasElevated = new Uint8Array(n);
    const ux0 = new Map(), uz0 = new Map();
    const um = unitIndex();

    for (let i = 0; i < n; i++) {
      x0[i] = lx[i] = p.x[i]; z0[i] = lz[i] = p.z[i];
      d0[i] = Math.hypot(b.slotX[i] - p.x[i], b.slotZ[i] - p.z[i]);
      if (EXCUSED.has(p.state[i])) excused[i] = 1;
      if (b.elevated[i] !== 0) wasElevated[i] = 1;
    }
    for (const u of b.units) { ux0.set(u.id, u.x); uz0.set(u.id, u.z); }

    for (let k = 0; k < ticks; k++) {
      step();
      if (eachTick) eachTick(k);
      for (let i = 0; i < n; i++) {
        if (p.state[i] === S.Dead) continue;
        pathLen[i] += Math.hypot(p.x[i] - lx[i], p.z[i] - lz[i]);
        lx[i] = p.x[i]; lz[i] = p.z[i];
        if (EXCUSED.has(p.state[i])) excused[i] = 1;
        if (b.elevated[i] !== 0) wasElevated[i] = 1;
      }
    }

    // ---- classify -----------------------------------------------------------
    const out = {
      t: +g.simTime().toFixed(1),
      windowTicks: ticks,
      living: 0, commanded: 0,
      stuck: 0, abandoned: 0, orbiting: 0,
      inSolid: 0, inShell: 0, clear: 0,
      byKind: {}, solidDisagree: 0,
      // named exclusions, all counted (rule 16)
      exNotCommanded: 0, exExcused: 0, exArrived: 0, exMoving: 0, exQueued: 0, exElevated: 0,
      stuckFighting: 0,
      worst: [],
      /*
       * How many of a caller-supplied set of men came out stuck, and where each of them
       * fell out if it did not. This is the whole of the controls arm: an injection whose
       * men are not reported is a detector that cannot fire, and one whose men are reported
       * for the wrong reason is worse. \`worst\` is capped at 24 and sorted, so counting the
       * injected men out of it — which is what the first draft of this file did — silently
       * undercounts whenever more than 24 men are stuck. This does not.
       */
      marked: marked ? { n: marked.size, stuck: 0, inSolid: 0, inShell: 0, clear: 0, fellOutAt: {} } : null,
    };
    const drop = (i, why) => {
      if (out.marked && marked.has(i)) out.marked.fellOutAt[why] = (out.marked.fellOutAt[why] ?? 0) + 1;
    };
    const stuckIdx = [];
    const alive = [];
    for (let i = 0; i < n; i++) if (p.state[i] !== S.Dead && p.state[i] !== S.Dying) alive.push(i);
    out.living = alive.length;

    // Cheap grid for the "friendly in front of me" test.
    const CELL = 2.0;
    const grid = new Map();
    const key = (x, z) => (Math.floor(x / CELL) + ':' + Math.floor(z / CELL));
    for (const i of alive) {
      const kk = key(p.x[i], p.z[i]);
      let a = grid.get(kk); if (!a) { a = []; grid.set(kk, a); }
      a.push(i);
    }
    const friendAhead = (i, gx, gz) => {
      const dx = gx - p.x[i], dz = gz - p.z[i];
      const L = Math.hypot(dx, dz); if (L < 1e-6) return false;
      const ax = dx / L, az = dz / L;
      const cx = Math.floor(p.x[i] / CELL), cz = Math.floor(p.z[i] / CELL);
      for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
        const arr = grid.get((cx + a) + ':' + (cz + c)); if (!arr) continue;
        for (const j of arr) {
          if (j === i) continue;
          if (p.faction[j] !== p.faction[i]) continue;
          const ddx = p.x[j] - p.x[i], ddz = p.z[j] - p.z[i];
          const d = Math.hypot(ddx, ddz);
          if (d > T.QUEUE_R || d < 1e-6) continue;
          // 120-degree sector toward the goal: cos(60 deg) = 0.5
          if ((ddx * ax + ddz * az) / d > 0.5) return true;
        }
      }
      return false;
    };

    for (const i of alive) {
      const u = um.get(p.unitId[i]);
      if (wasElevated[i]) { out.exElevated++; drop(i, 'elevated'); continue; }
      if (!u || u.destroyed || u.alive === 0 || !MOVING_ORDER.has(u.order)) {
        out.exNotCommanded++; drop(i, 'notCommanded'); continue;
      }
      out.commanded++;
      const gx = b.slotX[i], gz = b.slotZ[i];
      const d1 = Math.hypot(gx - p.x[i], gz - p.z[i]);
      const moved = pathLen[i];
      const closed = d0[i] - d1;
      if (excused[i]) {
        out.exExcused++; drop(i, 'excused');
        // How much the melee exclusion is costing us, printed rather than assumed.
        if (moved < T.CREEP && d1 > T.GOAL_EPS && p.state[i] === S.Fighting) out.stuckFighting++;
        continue;
      }
      if (d1 <= T.GOAL_EPS) { out.exArrived++; drop(i, 'arrived'); continue; }
      if (moved >= T.CREEP) {
        // Moving. If he is moving but not closing, that is a different fault.
        if (closed < T.PROGRESS && moved > 1.0) out.orbiting++;
        out.exMoving++; drop(i, 'moving');
        continue;
      }
      /*
       * There is deliberately NO \`closed >= PROGRESS\` exclusion here, and the 'shell'
       * control is what removed it.
       *
       * The first draft excused a man whose distance to his goal had fallen by 0.3 m even
       * when he had not moved a centimetre, on the reasoning that he was making progress.
       * He was not: 'slotX/slotZ' is his slot in a formation that is still walking, so when
       * the cohort marches past a trapped man **the goal closes on him**. That is precisely
       * the owner's case — the line walks on and a few men stay in the wall — and the
       * exclusion silenced it. Injecting 24 men into the shell reported 0 of 24 stuck with
       * all 24 falling out at 'closing', which is a detector that cannot fire on the fault
       * it was built for. A man who has not moved has not progressed, whatever the goal did;
       * if the goal has arrived at him, the 'arrived' test above has already excused him.
       */
      if (friendAhead(i, gx, gz)) { out.exQueued++; drop(i, 'queued'); continue; }

      out.stuck++;
      stuckIdx.push(i);
      const c = classify(p.x[i], p.z[i], p.y[i]);
      if (out.marked && marked.has(i)) {
        out.marked.stuck++;
        if (c.inSolid) out.marked.inSolid++; else if (c.inShell) out.marked.inShell++; else out.marked.clear++;
      }
      if (c.inSolid) out.inSolid++; else if (c.inShell) out.inShell++; else out.clear++;
      if (c.kind) out.byKind[c.kind] = (out.byKind[c.kind] ?? 0) + 1;
      if (c.raster !== null && c.raster !== (c.inSolid || c.inShell)) out.solidDisagree++;
      const uz = ux0.has(u.id) ? Math.hypot(u.x - ux0.get(u.id), u.z - uz0.get(u.id)) : 0;
      if (uz > T.UNIT_MOVED) out.abandoned++;
      out.worst.push({
        i, x: +p.x[i].toFixed(2), z: +p.z[i].toFixed(2), y: +p.y[i].toFixed(2),
        unit: u.id, type: u.typeId, order: u.order,
        toGoal: +d1.toFixed(2), moved: +moved.toFixed(3), unitMoved: +uz.toFixed(1),
        inSolid: c.inSolid, inShell: c.inShell, kind: c.kind, box: c.box, raster: c.raster,
      });
    }
    out.worst.sort((a, c) => c.toGoal - a.toGoal);
    out.worst = out.worst.slice(0, 24);
    out.T = T;
    return out;
  };

  /**
   * The standing population of men frozen against masonry, over a whole battle.
   *
   * \`census\` is instantaneous and it undercounts a *permanent* trap, which is the whole of
   * what the owner reported. A man wedged at t+60 is counted at t+60; by t+90 his cohort has
   * been wiped, or has given up and reverted to \`Hold\`, or the AI has re-tasked it, and he
   * falls out of \`commanded\` and stops being counted while still standing in the wall. The
   * instantaneous number therefore measures the *arrival rate* into the trap and not the
   * occupancy of it.
   *
   * This is the occupancy. It drops every predicate except two physical ones — he has not
   * moved, and he is inside a collider's envelope — so it has no order, no melee and no
   * queue exclusion and consequently a much larger false-positive surface, all of it named:
   * a garrison standing at the foot of its own wall, a man in melee with his back to a
   * building, and a corpse-adjacent idler all qualify. That is why it is reported *split by
   * soldier state and by order*, and why \`census\` above still exists: the two bracket the
   * truth from either side, and a fix has to move both.
   *
   * The one thing it can say that nothing else here can: **how long**. A trap is permanent
   * and a jostle is not, so the distribution of the longest motionless-in-masonry run per man
   * is the discriminator, and \`heldFor\` is that distribution.
   */
  const occupancy = (seconds, sampleEvery) => {
    sampleEvery = sampleEvery || 1;
    const n = p.count;
    const ticks = Math.round(seconds * 30);
    const EPS = 0.02;                     // m per tick; 0.6 m/s is a slow walk, this is 1/30 of it
    const lx = new Float32Array(n), lz = new Float32Array(n);
    const runShell = new Int32Array(n), maxShell = new Int32Array(n);
    const runSolid = new Int32Array(n), maxSolid = new Int32Array(n);
    const shellTicks = new Int32Array(n), solidTicks = new Int32Array(n);
    for (let i = 0; i < n; i++) { lx[i] = p.x[i]; lz[i] = p.z[i]; }

    for (let k = 0; k < ticks; k++) {
      step();
      if (k % sampleEvery !== 0) continue;
      for (let i = 0; i < n; i++) {
        const st = p.state[i];
        if (st === S.Dead || st === S.Dying) continue;
        if (b.elevated[i] !== 0) { runShell[i] = 0; runSolid[i] = 0; lx[i] = p.x[i]; lz[i] = p.z[i]; continue; }
        const moved = Math.hypot(p.x[i] - lx[i], p.z[i] - lz[i]);
        lx[i] = p.x[i]; lz[i] = p.z[i];
        const solid = b.masonry.solidAt(p.x[i], p.z[i], p.y[i], 0) >= 0;
        const shell = solid || b.masonry.solidAt(p.x[i], p.z[i], p.y[i], T.RADIUS) >= 0;
        if (shell) shellTicks[i]++;
        if (solid) solidTicks[i]++;
        const frozen = moved < EPS * sampleEvery;
        if (shell && frozen) { runShell[i]++; if (runShell[i] > maxShell[i]) maxShell[i] = runShell[i]; }
        else runShell[i] = 0;
        if (solid && frozen) { runSolid[i]++; if (runSolid[i] > maxSolid[i]) maxSolid[i] = runSolid[i]; }
        else runSolid[i] = 0;
      }
    }

    const secOf = (t) => (t * sampleEvery) / 30;
    const buckets = { 'ge5s': 0, 'ge15s': 0, 'ge30s': 0, 'ge60s': 0, 'ge120s': 0 };
    const byState = {}, byKind = {}, byOrder = {};
    const um = unitIndex();
    const held = [];
    let living = 0, everInShell = 0, everInSolid = 0;
    const worst = [];
    for (let i = 0; i < n; i++) {
      const st = p.state[i];
      if (st === S.Dead || st === S.Dying) continue;
      living++;
      if (shellTicks[i] > 0) everInShell++;
      if (solidTicks[i] > 0) everInSolid++;
      const s = secOf(maxShell[i]);
      if (s >= 5) {
        buckets.ge5s++;
        if (s >= 15) buckets.ge15s++;
        if (s >= 30) buckets.ge30s++;
        if (s >= 60) buckets.ge60s++;
        if (s >= 120) buckets.ge120s++;
        held.push(s);
        byState[st] = (byState[st] ?? 0) + 1;
        const c = classify(p.x[i], p.z[i], p.y[i]);
        if (c.kind) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
        const u = um.get(p.unitId[i]);
        const o = u ? u.order : -1;
        byOrder[o] = (byOrder[o] ?? 0) + 1;
        if (s >= 30) {
          worst.push({ i, heldSec: +s.toFixed(1), x: +p.x[i].toFixed(2), z: +p.z[i].toFixed(2),
            y: +p.y[i].toFixed(2), state: st, order: o, unit: u ? u.id : -1,
            type: u ? u.typeId : '?', kind: c.kind, inSolid: c.inSolid, inShell: c.inShell,
            box: c.box, raster: c.raster });
        }
      }
    }
    held.sort((a, c) => a - c);
    worst.sort((a, c) => c.heldSec - a.heldSec);
    return {
      t: +g.simTime().toFixed(1), seconds, sampleEvery, living,
      everInShell, everInSolid,
      manTicksInShell: shellTicks.reduce((a, c) => a + c, 0),
      manTicksInSolid: solidTicks.reduce((a, c) => a + c, 0),
      heldFor: buckets,
      medianHeldSec: held.length ? +held[held.length >> 1].toFixed(1) : 0,
      maxHeldSec: held.length ? +held[held.length - 1].toFixed(1) : 0,
      byState, byKind, byOrder,
      worst: worst.slice(0, 40),
      EPS, RADIUS: T.RADIUS,
    };
  };

  /*
   * A row of points along the LONG face of a real solid, 'depth' metres inside it.
   *
   * Spread along the face rather than clustered, and that is not cosmetic: the first draft
   * dropped 24 men into a 0.6 m circle and the detector correctly reported 23 of them as
   * 'queued', because each had 23 friendlies inside the 1 m queue radius. The injection was
   * measuring exclusion 5 instead of the trap. Men wedged against a wall in a real battle
   * are strung out along it, so the control has to be too (rule 28: a handwritten case
   * tidier than the production input is testing a different function).
   *
   * 'depth' > 0 is inside the solid; 'depth' < 0 is outside its face, i.e. in the radius
   * shell if it is smaller than SOLDIER_RADIUS.
   */
  const boxPoint = (kindWanted, depth, k, spacing) => {
    const items = b.masonry.items;
    if (!items) return null;
    spacing = spacing || 3.0;
    k = k || 1;
    for (let n = 0; n < items.length; n++) {
      const o = items[n];
      if (kindWanted && o.kind !== kindWanted) continue;
      const long = Math.max(o.hw, o.hd), short = Math.min(o.hw, o.hd);
      // Long enough to string k men along, and thick enough to be real masonry.
      if (long * 2 < (k - 1) * spacing + 2 || short < 0.8) continue;
      const c = Math.cos(o.rot), sn = Math.sin(o.rot);
      // Unit vectors of the box's own frame in world space.
      const ux = c, uz = sn, vx = -sn, vz = c;
      // Offset along the SHORT axis (out through the long face); run along the LONG axis.
      const alongX = o.hw >= o.hd ? ux : vx, alongZ = o.hw >= o.hd ? uz : vz;
      const outX = o.hw >= o.hd ? vx : ux, outZ = o.hw >= o.hd ? vz : uz;
      const off = short - depth;
      const pts = [];
      for (let m = 0; m < k; m++) {
        const t = (m - (k - 1) / 2) * spacing;
        pts.push({ x: o.x + outX * off + alongX * t, z: o.z + outZ * off + alongZ * t });
      }
      return { pts, topY: o.topY, box: n, kind: o.kind, hw: o.hw, hd: o.hd, rot: o.rot,
               cx: o.x, cz: o.z, long, short, depth };
    }
    return null;
  };

  return { g, b, p, s, city, step, run, census, occupancy, classify, boxPoint, unitOf, unitIndex, T, S, EXCUSED, MOVING_ORDER };
})();
undefined;
`;

// ---------------------------------------------------------------------------
async function newPage(browser, extra = '', big = false) {
  const errs = [];
  const W = big ? 1280 : 640, H = big ? 720 : 360;
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  const url = `${base}/?harness=1&autoplay=1&quality=high&w=${W}&h=${H}${BATTLE ? `&${BATTLE}` : ''}${extra}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
  await page.evaluate(HELPERS);
  return { page, errs };
}

const results = { battle: BATTLE_KEY, url: BATTLE || '(default field battle)', arms: {} };

const browser = await launchBrowser({
  label: 'probe-stuck', port: PORT, root: ROOT,
  args: ['--disable-dev-shm-usage', '--hide-scrollbars'],
});
const { close: killServer } = await startVite({
  port: PORT, root: ROOT, label: 'probe-stuck', slot: browser.budgetSlot,
  cacheDir: process.env.TC_VITE_CACHE_DIR ?? path.join(ROOT, '.vite', 'probe-stuck'),
  timeoutMs: 180000,
});
console.log(`[probe-stuck] ${base}  battle=${BATTLE_KEY}`);

let exitCode = 0;
try {
  // =========================================================================
  // ARM: census — the shipped battle, unattended, sampled at checkpoints.
  // =========================================================================
  if (want('census')) {
    const { page, errs } = await newPage(browser);
    const r = await page.evaluate(async ({ AT, SEC }) => {
      const w = window.__stuck;
      const head = { men: w.p.count, units: w.b.units.length, solids: w.b.masonry.count };
      const samples = [];
      let at = 0;
      for (const mark of AT) {
        // Run up to `mark - 2 s`, then measure over the 2 s window ending at `mark`.
        const lead = Math.max(0, mark - 2 - at);
        if (lead > 0) w.run(lead);
        at = mark - 2;
        samples.push(w.census(60));
        at = mark;
      }
      void SEC;
      return { head, samples };
    }, { AT: SAMPLE_AT, SEC: SECONDS });
    results.arms.census = { ...r, errs: errs.slice(0, 8) };
    await page.close();
    const last = r.samples[r.samples.length - 1];
    console.log(`  census  men=${r.head.men} solids=${r.head.solids}`);
    for (const s of r.samples) {
      console.log(`    t+${String(s.t).padStart(5)}  stuck=${String(s.stuck).padStart(4)}`
        + `  solid=${String(s.inSolid).padStart(3)} shell=${String(s.inShell).padStart(3)} clear=${String(s.clear).padStart(3)}`
        + `  abandoned=${String(s.abandoned).padStart(3)}  orbiting=${String(s.orbiting).padStart(4)}`
        + `  [commanded ${s.commanded}, excused ${s.exExcused}, queued ${s.exQueued}, arrived ${s.exArrived}, elevated ${s.exElevated}]`
        + `  kinds=${JSON.stringify(s.byKind)}`);
    }
    void last;
  }

  // =========================================================================
  // ARM: occupancy — how many men are frozen against masonry, and for how long.
  // =========================================================================
  if (want('occupancy')) {
    const { page, errs } = await newPage(browser, '', !!SHOT);
    const r = await page.evaluate(async ({ SEC }) => window.__stuck.occupancy(SEC, 1), { SEC: SECONDS });
    results.arms.occupancy = { ...r, errs: errs.slice(0, 8) };
    if (SHOT) {
      /*
       * Photograph the biggest CLUSTER of trapped men, not the single worst one.
       *
       * The first attempt parked on the worst man at zoom 0.10 and produced a photograph of
       * the inside of a wall: he is, by construction, standing in masonry, so a camera at his
       * feet is inside the stone with him. What the owner needs to see is the group, from
       * outside, far enough back that the building they are standing in is recognisable as a
       * building. So: cluster within 20 m, take the largest, and shoot it from three
       * distances so one of them is usable.
       */
      const shots = await page.evaluate(({ CAM, LABEL }) => {
        const w = window.__stuck, P = w.p, B = w.b;
        const men = [];
        for (let i = 0; i < P.count; i++) {
          if (P.state[i] === 11 || P.state[i] === 10) continue;
          if (B.elevated[i] !== 0) continue;
          if (B.masonry.solidAt(P.x[i], P.z[i], P.y[i], 0.42) < 0) continue;
          men.push(i);
        }
        // Largest cluster within 20 m, by a greedy seed-and-grow over the survivors.
        let best = { n: 0, x: 0, z: 0 };
        for (const seed of men) {
          let n = 0, sx = 0, sz = 0;
          for (const j of men) {
            if (Math.hypot(P.x[j] - P.x[seed], P.z[j] - P.z[seed]) > 20) continue;
            n++; sx += P.x[j]; sz += P.z[j];
          }
          if (n > best.n) best = { n, x: sx / n, z: sz / n };
        }
        const centre = best.n ? best : { n: 0, x: B.units[0].x, z: B.units[0].z };
        const tag = document.createElement('div');
        tag.style.cssText = 'position:fixed;left:12px;bottom:10px;z-index:99999;font:600 15px/1.35 ui-monospace,monospace;'
          + 'color:#fff;background:rgba(0,0,0,.66);padding:6px 10px;border-radius:4px;white-space:pre';
        tag.textContent = LABEL + '\n' + men.length + ' men standing inside masonry right now'
          + '\nlargest group here: ' + best.n;
        document.body.appendChild(tag);
        return { inMasonryNow: men.length, cluster: best.n,
                 cam: CAM || [centre.x, centre.z, 0, 0] };
      }, { CAM: CAMERA, LABEL: `${BATTLE_KEY}  t+${Math.round(SECONDS)}s` });

      const yaw = shots.cam[3] || Math.PI * 0.25;
      const zooms = CAMERA && shots.cam[2] ? [shots.cam[2]] : [0.30, 0.50];
      const out = [];
      for (const z of zooms) {
        await page.evaluate(({ X, Z, ZOOM, YAW }) => {
          window.__stuck.g.setCamera(X, Z, ZOOM, YAW);
          // One real frame. fastForward leaves the canvas on the frame before the call.
          window.__stuck.g.engine.advance(1 / 30, 1000 / 60);
        }, { X: shots.cam[0], Z: shots.cam[1], ZOOM: z, YAW: yaw });
        const file = zooms.length === 1 ? SHOT : SHOT.replace(/\.png$/, `-z${String(z).replace('.', '')}.png`);
        await mkdir(path.dirname(path.resolve(ROOT, file)), { recursive: true });
        await page.screenshot({ path: path.resolve(ROOT, file) });
        out.push({ file, camera: [+shots.cam[0].toFixed(2), +shots.cam[1].toFixed(2), z, +yaw.toFixed(4)] });
      }
      results.arms.occupancy.shot = { ...shots, files: out };
      console.log(`    shot  inMasonryNow=${shots.inMasonryNow} largestGroup=${shots.cluster}`
        + `  at ${shots.cam[0].toFixed(1)},${shots.cam[1].toFixed(1)} yaw ${yaw.toFixed(3)}`);
      for (const o of out) console.log(`      ${o.file}  camera=${o.camera.join(',')}`);
    }
    await page.close();
    console.log(`  occupancy over ${r.seconds}s  living=${r.living}`
      + `  everInShell=${r.everInShell} everInSolid=${r.everInSolid}`);
    console.log(`    frozen-in-masonry for >=  5s: ${r.heldFor.ge5s}`
      + `  >=15s: ${r.heldFor.ge15s}  >=30s: ${r.heldFor.ge30s}`
      + `  >=60s: ${r.heldFor.ge60s}  >=120s: ${r.heldFor.ge120s}`
      + `   (median ${r.medianHeldSec}s, max ${r.maxHeldSec}s)`);
    console.log(`    man-ticks inShell=${r.manTicksInShell} inSolid=${r.manTicksInSolid}`);
    console.log(`    byKind=${JSON.stringify(r.byKind)} byState=${JSON.stringify(r.byState)} byOrder=${JSON.stringify(r.byOrder)}`);
  }

  // =========================================================================
  // ARM: controls — can it fire, and can it be wrong.
  // =========================================================================
  if (want('controls')) {
    const { page, errs } = await newPage(browser);
    const r = await page.evaluate(async () => {
      const w = window.__stuck;
      const P = w.p, B = w.b;
      const K = 24;

      /** A cohort that is marching in the open with a movement order and is not in melee. */
      const pickCohort = () => {
        let best = null;
        for (const u of B.units) {
          if (u.destroyed || u.alive < 40) continue;
          if (u.engaged || u.contactLock) continue;
          const live = u.members.filter((i) => P.state[i] !== 11 && P.state[i] !== 10 && B.elevated[i] === 0);
          if (live.length < K + 10) continue;
          if (!best || live.length > best.live.length) best = { u, live };
        }
        return best;
      };

      const arms = {};
      const MOVE = new Set([1, 2, 3]);
      const pick = (d) => w.boxPoint('wall', d, K, 3.0) || w.boxPoint('building', d, K, 3.0) || w.boxPoint(null, d, K, 3.0);
      const target = pick(0.1);     // inside the true solid
      const shellPt = pick(-0.15);  // outside the face, inside the 0.42 m radius envelope

      // Advance a little so the armies are moving and orders are live.
      w.run(20);
      const c = pickCohort();
      if (!c) return { error: 'no marching cohort found' };

      const snapshot = () => c.live.slice(0, K).map((i) => ({ i, x: P.x[i], z: P.z[i], y: P.y[i] }));
      const restore = (snap) => { for (const q of snap) { P.x[q.i] = q.x; P.z[q.i] = q.z; P.y[q.i] = q.y; } };
      const men = c.live.slice(0, K);
      const menSet = new Set(men);

      /** Place the injected men on a row of points, one each. */
      const place = (row) => {
        for (let k = 0; k < men.length; k++) {
          const i = men[k];
          const q = row[k % row.length];
          P.x[i] = q.x; P.z[i] = q.z;
          P.y[i] = B.groundAt(q.x, q.z);
          P.vx[i] = 0; P.vz[i] = 0;
        }
      };
      /** The open-ground control needs a row too, for the same queue reason. */
      const openRow = (x0, z0) => {
        const r = [];
        for (let k = 0; k < K; k++) r.push({ x: x0 + k * 3.0, z: z0 });
        return r;
      };

      /*
       * Count how many of the injected men the detector reports as stuck.
       *
       * Three things here were wrong in the first draft and each was found by a control
       * reporting 0 of 24, which is what controls are for.
       *
       *  - **An order has to be issued, not assigned.** Writing u.order = 1 is overwritten
       *    by updateUnitOrder on the very next tick, so every arm fell out at
       *    notCommanded and measured nothing. It goes through the same orderIssued bus
       *    the player mouse uses, and is re-asserted every tick by the hold callback below,
       *    because a control is allowed to hold its own premise steady.
       *  - **The window must open after the injection has settled.** A man dropped inside a
       *    solid is dug out by escape at up to 1.1 m per tick, so for the first second he
       *    is genuinely moving and wedge measured him as such. SETTLE ticks run first.
       *  - **restore has to put back more than position.** State and order are perturbed
       *    too, and leaving them perturbed makes every later arm measure the one before it.
       */
      const SETTLE = 45;
      const far = () => ({ x: c.u.x + Math.cos(c.u.facing) * 120, z: c.u.z + Math.sin(c.u.facing) * 120 });
      const order = (kind, x, z) =>
        w.g.engine.events.emit('orderIssued', { unitIds: [c.u.id], kind, x, z, source: 'local' });

      const measure = (label, prep, hold) => {
        const snap = snapshot();
        const states = men.map((i) => P.state[i]);
        const orders = B.units.map((u) => ({ u, o: u.order, tx: u.targetX, tz: u.targetZ }));
        prep && prep();
        for (let k = 0; k < SETTLE; k++) { w.step(); if (hold) hold(); }
        const cen = w.census(90, men, () => { if (hold) hold(); });
        arms[label] = {
          stuck: cen.stuck, inSolid: cen.inSolid, inShell: cen.inShell, clear: cen.clear,
          injected: cen.marked,
          exExcused: cen.exExcused, exQueued: cen.exQueued, exArrived: cen.exArrived,
          exNotCommanded: cen.exNotCommanded, orbiting: cen.orbiting,
          unit: c.u.id, unitOrder: c.u.order, k: K,
          sample: cen.worst.filter((q) => menSet.has(q.i)).slice(0, 3),
        };
        restore(snap);
        men.forEach((i, k) => { P.state[i] = states[k]; });
        for (const o of orders) { o.u.order = o.o; o.u.targetX = o.tx; o.u.targetZ = o.tz; }
        return arms[label];
      };

      arms.geometry = { target, shellPt, solids: B.masonry.count };
      const march = () => { const f = far(); order('move', f.x, f.z); };
      const keepMoving = () => { if (!MOVE.has(c.u.order)) { const f = far(); order('move', f.x, f.z); } };

      // 1. null - no injection, unit marching. The baseline the rest are read against.
      measure('null', march, keepMoving);

      // 2. wedge - 0.1 m inside a real wall box. MUST fire.
      if (target) measure('wedge', () => { place(target.pts); march(); }, keepMoving);

      // 3. shell - just outside the face, inside the 0.42 m radius envelope. MUST fire if
      //    the shell trap is real; if it does not, the trap hypothesis is wrong.
      if (shellPt) measure('shell', () => { place(shellPt.pts); march(); }, keepMoving);

      // 4. displace - 120 m away on open ground. MUST NOT fire (they walk back).
      measure('displace', () => { place(openRow(c.u.x + 120, c.u.z + 120)); march(); }, keepMoving);

      // 5. melee - wedged in the shell, but held in the Fighting state. MUST NOT fire.
      if (shellPt) measure('melee', () => { place(shellPt.pts); march(); },
        () => { keepMoving(); for (const i of men) if (P.state[i] !== 11 && P.state[i] !== 10) P.state[i] = 4; });

      // 6. hold - wedged in the shell, but the unit was told to halt. MUST NOT fire.
      if (shellPt) measure('hold', () => { place(shellPt.pts); order('halt'); },
        () => { c.u.order = 0; });

      return arms;
    });
    results.arms.controls = { ...r, errs: errs.slice(0, 8) };
    await page.close();
    console.log('  controls');
    if (r.error) console.log(`    ${r.error}`);
    for (const [k, v] of Object.entries(r)) {
      if (k === 'geometry' || k === 'errs' || k === 'error' || !v || !v.injected) continue;
      const m = v.injected;
      console.log(`    ${k.padEnd(9)} allStuck=${String(v.stuck).padStart(4)}`
        + `  injected ${String(m.stuck).padStart(2)}/${m.n} stuck`
        + ` (solid ${m.inSolid}, shell ${m.inShell}, clear ${m.clear})`
        + `  fellOut=${JSON.stringify(m.fellOutAt)}`);
    }
  }

  // =========================================================================
  // ARM: stairs — onto the wall and off it, counted separately.
  // =========================================================================
  if (want('stairs')) {
    const { page, errs } = await newPage(browser, '&autoplay=0');
    const r = await page.evaluate(async () => {
      const w = window.__stuck;
      const B = w.b, P = w.p, S = w.s;
      if (!S) return { error: 'no siege system on this battle' };
      const city = w.city;

      const stairReport = typeof S.stairReport === 'function' ? S.stairReport() : null;
      const published = city && city.getWallStairs ? city.getWallStairs() : null;
      /*
       * Rule 11, applied to a staircase: the flight the sim walks men up and the walkway it
       * is supposed to arrive on are two objects, and nothing compares them.
       *
       * `buildStairs` rejects a published flight whose head is more than 6 m from its station
       * **in plan** and never looks at y at all, so a flight whose head is at the wrong height
       * is accepted and men are walked to it. `headAboveFoot` is the flight's own rise;
       * `stationY` is the height of the stone at the station it serves; `headError` is the
       * gap between them, and it is the number that says whether this is a staircase onto
       * the wall or a ramp to nowhere.
       */
      const stairCheck = (q) => {
        const st = q.station;
        const sy = st >= 0 && st < S.stationCount ? S.sy[st] : null;
        return {
          headAboveFoot: +(q.topY - q.footY).toFixed(2),
          stationY: sy === null ? null : +sy.toFixed(2),
          headError: sy === null ? null : +(q.topY - sy).toFixed(2),
          runLen: +Math.hypot(q.topX - q.footX, q.topZ - q.footZ).toFixed(1),
          rake: +((q.topY - q.footY) / Math.max(0.01, Math.hypot(q.topX - q.footX, q.topZ - q.footZ))).toFixed(3),
        };
      };
      const simStairs = S.stairs ? S.stairs.map((q) => ({
        footX: +q.footX.toFixed(1), footZ: +q.footZ.toFixed(1), footY: +q.footY.toFixed(2),
        topX: +q.topX.toFixed(1), topZ: +q.topZ.toFixed(1), topY: +q.topY.toFixed(2),
        station: q.station, side: q.side, width: q.width, fromCity: q.fromCity,
        ...stairCheck(q),
      })) : null;

      const where = (i) => {
        if (S.crossOf[i] !== -1) return 'rungs';
        const st = S.stationOf[i];
        if (st >= 0) return 'parapet';
        if (st === -2) return 'pending';
        if (st === -3) return 'link';
        return 'grass';
      };

      /*
       * Who can be ordered up, and who can be ordered down.
       *
       * The first draft of this arm took "the biggest unit standing on grass" and measured
       * `started=0, plan=null` on both manoeuvres — a probe defect, not a finding, and the
       * same one `probe-wallstuck.mjs` arm B records paying for. `Siege.interceptOrders`
       * only walks a unit up the defenders' own flights when `sideOf(u.x, u.z) === -1`, the
       * city side; a besieger on the field side falls through to `escalade`, which is
       * ladders and siege towers and a different mechanic entirely. And it only reads a
       * descent for a unit that is in `garrisons` and `standingOnWall`. So both cohorts are
       * chosen by the predicates the order path itself uses, not by where the men look.
       */
      const groundCohort = () => {
        let best = null;
        for (const u of B.units) {
          if (u.destroyed || u.alive < 30) continue;
          if (S.ownsUnit(u.id) || S.isGarrisoned(u.id)) continue;
          if (S.sideOf(u.x, u.z) !== -1) continue;             // city side only
          const onGround = u.members.filter((i) => P.aliveAt(i) && where(i) === 'grass');
          if (onGround.length < u.alive * 0.8) continue;
          if (!best || u.alive > best.u.alive) best = { u, onGround };
        }
        return best;
      };
      const wallCohort = () => {
        let best = null;
        for (const u of B.units) {
          if (u.destroyed || u.alive < 20) continue;
          if (!S.isGarrisoned(u.id)) continue;
          if (!S.standingOnWall(u.id)) continue;
          const onWall = u.members.filter((i) => P.aliveAt(i) && where(i) === 'parapet');
          if (!best || onWall.length > best.onWall.length) best = { u, onWall };
        }
        return best;
      };

      /*
       * An order must execute or be refused out loud (src/core/events.ts). Listening for the
       * refusal is what turns "nothing happened" into a reason, and it is the difference
       * between reporting a broken staircase and reporting a broken probe.
       */
      const refusals = [];
      w.g.engine.events.on('orderRefused', (e) => refusals.push(JSON.parse(JSON.stringify(e))));

      const bays = city.getGarrisonBays().filter((q) => q.garrisonable);
      /*
       * Aim at a *station*, never at a bay midpoint, and issue it as `kind: 'move'`.
       *
       * `tools/probe-wallstuck.mjs` arm B paid for both halves of this. A bay midpoint on
       * Rome is the gate, the spine has no stations inside the gate block, and the order is
       * correctly refused — which measures a unit that never got an order at all. And the
       * ascent verb is not a distinct order kind: `SelectionController.interceptOrders` turns
       * a `move` click at a station into `sendToWall`, so `move` at `(sx, sz)` is the ascent.
       */
      const nearestStation = (x, z) => {
        let best = -1, bd = Infinity;
        for (let k = 0; k < S.stationCount; k++) {
          const d = (S.sx[k] - x) ** 2 + (S.sz[k] - z) ** 2;
          if (d < bd) { bd = d; best = k; }
        }
        return best;
      };
      const click = (u, x, z) =>
        w.g.engine.events.emit('orderIssued', { unitIds: [u.id], kind: 'move', x, z, source: 'local' });

      const census = (u, t) => {
        const c = { parapet: 0, rungs: 0, pending: 0, link: 0, grass: 0 };
        let minY = Infinity, maxY = -Infinity, still = 0;
        for (const i of u.members) {
          if (!P.aliveAt(i)) continue;
          c[where(i)]++;
          if (P.y[i] < minY) minY = P.y[i];
          if (P.y[i] > maxY) maxY = P.y[i];
          if (Math.hypot(P.vx[i], P.vz[i]) < 0.05) still++;
        }
        return { t, ...c, still, minY: +minY.toFixed(2), maxY: +maxY.toFixed(2) };
      };

      /**
       * Drive one manoeuvre and count it. `deadline` seconds, sampled every 5.
       * Returns the census track plus the four outcome numbers.
       */
      const manoeuvre = (u, order, deadline, goalReached) => {
        goalReached = goalReached || (() => false);
        const start = census(u, 0);
        refusals.length = 0;
        order();
        const track = [start];
        const everStarted = new Set();
        const ticks = Math.round(deadline * 30);
        /*
         * When the manoeuvre actually begins and ends, separately from how long it takes.
         * The first run of this arm gave the ascent 120 s, and the cohort spent 115 s of that
         * marching to the foot of the flight — so "0 men on the wall" was measuring the
         * approach, not the stair. Splitting the approach out is what makes the remaining
         * number about the staircase.
         */
        let firstOnFlight = -1, firstArrived = -1, lastArrived = -1;
        const arrivedSet = new Set();
        for (let k = 0; k < ticks; k++) {
          w.step();
          for (const i of u.members) {
            if (!P.aliveAt(i)) continue;
            if (S.crossOf[i] !== -1) {
              everStarted.add(i);
              if (firstOnFlight < 0) firstOnFlight = k;
            }
            if (goalReached(i)) {
              if (!arrivedSet.has(i)) { arrivedSet.add(i); lastArrived = k; }
              if (firstArrived < 0) firstArrived = k;
            }
          }
          if ((k + 1) % 150 === 0) track.push(census(u, +((k + 1) / 30).toFixed(0)));
        }
        const end = census(u, deadline);
        const plan = S.plans && S.plans.get ? S.plans.get(u.id) : null;
        return {
          deadlineSec: deadline,
          start, end, track,
          everStartedFlight: everStarted.size,
          onFlightAtDeadline: end.rungs + end.link,
          arrived: arrivedSet.size,
          approachSec: firstOnFlight < 0 ? null : +(firstOnFlight / 30).toFixed(1),
          firstArrivalSec: firstArrived < 0 ? null : +(firstArrived / 30).toFixed(1),
          lastArrivalSec: lastArrived < 0 ? null : +(lastArrived / 30).toFixed(1),
          refused: refusals.slice(0, 6),
          plan: plan ? { goal: plan.goal, age: plan.age, stuck: plan.stuck,
                         destStation: plan.destStation, destRun: plan.destRun, stair: plan.stair } : null,
        };
      };

      const out = { stairs: { count: simStairs ? simStairs.length : 0, fromCity: S.stairsFromCity,
                              published: published ? published.length : null, list: simStairs },
                    stairReport, bays: bays.length };

      w.run(2);

      /*
       * Why an order did or did not become a plan, printed before the manoeuvre runs.
       *
       * Two rounds of this arm reported `started=0, plan=null` with no refusal on the wire,
       * which is the least informative possible output: it cannot distinguish a broken
       * staircase from a probe that never gave an order. These are the four predicates the
       * order path itself consults, read directly, so the next reader can tell which.
       */
      /*
       * REACHABILITY: which of the wall's runs a man can get onto at all.
       *
       * This is the number the stair report turns on, and it is a property of the map rather
       * than of which station this probe happened to aim at. `Siege.sendToWall` refuses with
       * `noStair` when `nearestStairLink(x, z, destRun)` finds no flight whose head can walk
       * to `destRun` — so the question is not "how many flights are there" (Rome publishes
       * 14) but "how many of the runs those flights serve". A run with no stair is a stretch
       * of parapet that cannot be manned and, worse, cannot be left: `sendToGround` consults
       * the same function from the other end, so a cohort that reaches such a run by walking
       * along the wall is there for the rest of the battle.
       *
       * Measured off the sim's own graph, station by station, so it cannot disagree with the
       * refusal the player gets.
       */
      const runsTotal = S.runNext ? S.runNext.length : 0;
      const runServed = [];
      const stairRuns = new Set();
      for (const l of (S.links || [])) if (l.kind === 2 && l.stationB >= 0) stairRuns.add(l.runB);
      let stationsServed = 0, stationsDead = 0;
      const runStations = new Array(runsTotal).fill(0);
      for (let k = 0; k < S.stationCount; k++) {
        const r = S.sRun[k];
        if (r >= 0 && r < runsTotal) runStations[r]++;
      }
      for (let r = 0; r < runsTotal; r++) {
        let ok = false;
        for (const l of (S.links || [])) {
          if (l.kind !== 2 || l.stationB < 0) continue;
          if (isFinite(S.walkDistance(l.stationB, r))) { ok = true; break; }
        }
        runServed.push(ok);
        if (ok) stationsServed += runStations[r];
      }
      for (let k = 0; k < S.stationCount; k++) if (S.dead(k)) stationsDead++;
      out.reach = {
        runs: runsTotal,
        runsWithAStairOnThem: stairRuns.size,
        runsReachableByAnyStair: runServed.filter(Boolean).length,
        runsUnreachable: runServed.filter((q) => !q).length,
        stations: S.stationCount, stationsServed,
        stationsUnserved: S.stationCount - stationsServed,
        stationsDead,
        pctStationsUnserved: S.stationCount ? +(100 * (S.stationCount - stationsServed) / S.stationCount).toFixed(1) : 0,
        runStations, runServed,
      };

      out.diag = { units: B.units.length, garrisoned: 0, owned: 0, citySide: 0, fieldSide: 0 };
      for (const u of B.units) {
        if (u.destroyed) continue;
        if (S.isGarrisoned(u.id)) out.diag.garrisoned++;
        if (S.ownsUnit(u.id)) out.diag.owned++;
        if (S.sideOf(u.x, u.z) === -1) out.diag.citySide++; else out.diag.fieldSide++;
      }

      // ---- ASCENT: a ground cohort ordered onto the wall ---------------------
      const gc = groundCohort();
      out.diag.ascentCohort = gc ? { id: gc.u.id, type: gc.u.typeId, alive: gc.u.alive,
        order: gc.u.order, side: S.sideOf(gc.u.x, gc.u.z), onGround: gc.onGround.length } : null;
      /*
       * Aim at the nearest station ON A SERVED RUN. Aiming at the nearest station full stop
       * measures whichever run happens to be closest, and on Rome that was run 0, which has
       * no flight — so the arm reported a refusal that was true of one station rather than
       * of the manoeuvre. Both are worth having, so both are run: `ascent` is the climb, and
       * `ascentUnserved` below is the refusal, aimed deliberately.
       */
      const nearestServedStation = (x, z) => {
        let best = -1, bd = Infinity;
        for (let k = 0; k < S.stationCount; k++) {
          const r = S.sRun[k];
          if (r < 0 || r >= runServed.length || !runServed[r]) continue;
          if (S.dead(k)) continue;
          const d = (S.sx[k] - x) ** 2 + (S.sz[k] - z) ** 2;
          if (d < bd) { bd = d; best = k; }
        }
        return best;
      };
      if (gc) {
        const dest = nearestServedStation(gc.u.x, gc.u.z);
        out.diag.ascentDest = { station: dest, served: true,
          x: dest >= 0 ? +S.sx[dest].toFixed(1) : null, z: dest >= 0 ? +S.sz[dest].toFixed(1) : null,
          run: dest >= 0 ? S.sRun[dest] : -1 };
      }
      if (gc && out.diag.ascentDest.station >= 0) {
        const dest = out.diag.ascentDest.station;
        out.ascent = manoeuvre(gc.u, () => click(gc.u, S.sx[dest], S.sz[dest]), 300,
          (i) => S.stationOf[i] >= 0);
        out.ascent.unit = { id: gc.u.id, type: gc.u.typeId, alive: gc.u.alive, faction: gc.u.faction };
        out.ascent.destStation = dest;
        out.ascent.arrivedOnWall = out.ascent.end.parapet;
        out.ascent.neverLeftGround = out.ascent.end.grass;
      }

      // ---- DESCENT: a wall cohort ordered off it -----------------------------
      const wc = wallCohort();
      if (wc) {
        const u = wc.u;
        /*
         * The ground point has to be genuinely off the wall and genuinely reachable, so it
         * is taken from the foot of the flight that serves this unit's own station and then
         * pushed 12 m further into the city. Aiming at the unit's own (x,z) — which is on
         * the parapet — is an order to stay where it is, and would measure nothing.
         */
        const anyMan = u.members.find((i) => P.aliveAt(i) && S.stationOf[i] >= 0);
        const st = anyMan === undefined ? -1 : S.stationOf[anyMan];
        let gx = u.x, gz = u.z;
        if (st >= 0 && S.stairs && S.stairs.length) {
          let bestS = null, bd = Infinity;
          for (const q of S.stairs) {
            const d = (S.sx[st] - q.topX) ** 2 + (S.sz[st] - q.topZ) ** 2;
            if (d < bd) { bd = d; bestS = q; }
          }
          if (bestS) {
            const nx = S.snx[st], nz = S.snz[st];
            gx = bestS.footX + nx * -12; gz = bestS.footZ + nz * -12;
          }
        }
        out.descent = manoeuvre(u, () => click(u, gx, gz), 300,
          (i) => S.stationOf[i] === -1 && S.crossOf[i] === -1);
        out.descent.unit = { id: u.id, type: u.typeId, alive: u.alive, faction: u.faction };
        out.descent.goal = { x: +gx.toFixed(1), z: +gz.toFixed(1) };
        out.descent.reachedGround = out.descent.end.grass;
        out.descent.stillOnWall = out.descent.end.parapet + out.descent.end.pending;
      }

      return out;
    });
    results.arms.stairs = { ...r, errs: errs.slice(0, 8) };
    await page.close();
    if (r.error) console.log(`  stairs  ${r.error}`);
    else {
      console.log(`  stairs  flights=${r.stairs.count} fromCity=${r.stairs.fromCity} published=${r.stairs.published} bays=${r.bays}`);
      if (r.reach) console.log(`    reach    runs=${r.reach.runs}`
        + `  withAStair=${r.reach.runsWithAStairOnThem}`
        + `  reachable=${r.reach.runsReachableByAnyStair}`
        + `  UNREACHABLE=${r.reach.runsUnreachable}`
        + `   stations ${r.reach.stationsServed}/${r.reach.stations} served`
        + ` (${r.reach.pctStationsUnserved}% cannot be reached or left), dead=${r.reach.stationsDead}`);
      const line = (k, m, doneLabel, done) => console.log(`    ${k.padEnd(8)} of ${String(m.unit.alive).padStart(3)}`
        + `  everOnFlight=${String(m.everStartedFlight).padStart(3)}`
        + `  ${doneLabel}=${String(done).padStart(3)}`
        + `  onFlightAtDeadline=${String(m.onFlightAtDeadline).padStart(3)}`
        + `  approach=${m.approachSec}s first=${m.firstArrivalSec}s last=${m.lastArrivalSec}s`
        + `  deadline=${m.deadlineSec}s`
        + `  plan=${JSON.stringify(m.plan)} refused=${JSON.stringify(m.refused)}`);
      if (r.ascent) line('ascent', r.ascent, 'onWall', r.ascent.arrivedOnWall);
      if (r.descent) line('descent', r.descent, 'onGround', r.descent.reachedGround);
      if (r.stairs.list) {
        const bad = r.stairs.list.filter((q) => q.headError !== null && Math.abs(q.headError) > 0.5);
        console.log(`    flights  head-vs-walkway: ${bad.length} of ${r.stairs.list.length} more than 0.5 m out`
          + (bad.length ? `, worst ${bad.map((q) => q.headError).sort((a, b) => Math.abs(b) - Math.abs(a))[0]} m` : ''));
        const rises = r.stairs.list.map((q) => q.headAboveFoot).sort((a, b) => a - b);
        console.log(`    flights  rise foot->head: min ${rises[0]} med ${rises[rises.length >> 1]} max ${rises[rises.length - 1]} m`);
      }
    }
  }

  if (JSON_OUT) {
    await mkdir(path.dirname(path.resolve(ROOT, JSON_OUT)), { recursive: true });
    await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(results, null, 2));
    console.log(`  wrote ${JSON_OUT}`);
  }
} catch (err) {
  console.error(`[probe-stuck] ${err && err.stack ? err.stack : err}`);
  exitCode = 1;
} finally {
  await browser.close();
  await killServer();
}
process.exit(exitCode);
