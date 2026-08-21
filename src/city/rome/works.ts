import * as THREE from 'three';
import { lerp } from '../../util/math';
import { Rng, hash2 } from '../../util/rand';
import { archPanel, box, cylinder, hipRoof, quadPrism, type Batch } from '../build';
import { PAL } from '../palette';
import { cylinderBetween, strut } from '../wall';
import {
  CURTAIN_T,
  frameOf,
  HALF_T,
  OUT,
  P0,
  P1,
  P2,
  P3,
  WALL,
  type Bay,
} from './section';

/**
 * The building site — `docs/ROME.md` §4.9 — and the west terminus at the river.
 *
 * In 271 the circuit is under construction, so the dressing is not scenery: scaffolds,
 * treadwheel cranes, material yards, shuttered footings and the rubble-and-palisade
 * barricades across the gaps are what a bay at a given `BayStage` actually looks like, and
 * §4.9 gives each of them a rule. Split out of `wall.ts` by §15 task 0 so that the pass
 * which builds the outwork (§10.4) edits one file rather than the middle of the curtain
 * builder.
 *
 * Imports `./section` and never `./circuit`, so the wall modules form a tree.
 */

// ---------------------------------------------------------------------------
// Construction site dressing
// ---------------------------------------------------------------------------

/**
 * Where the circuit meets the Tiber.
 *
 * The Aurelian Wall did not run masonry into the river: it ended in a round tower on
 * the bank, with a *posterula* — a small postern for the towpath — beside it. A round
 * plan resists undermining by the current far better than a square one, which is why
 * every Roman river terminus is round.
 */
/**
 * Where the terminus drum stands and how much ground it occupies, in plan.
 *
 * **The single place its footprint is decided**, called by the stone `buildRiverTerminus`
 * lays *and* by `buildWall`, which publishes the `Blocker` for it. Until §15 task 1 there
 * was no blocker at all: a 15.2 m masonry drum, footed 4.5 m below the flood line and drawn
 * in every frame, that a cohort walked straight through — the same class of defect §14.2
 * records for Carthage's posterns, arches with nothing hung in them. It went unnoticed
 * because the wall's west end used to be 8 m from a modelled channel whose bed was below
 * drowning depth, so the pathfinder refused the ground either side of it and no route ever
 * came this way. With the Tiber on the survey the bank is dry and this is the closure.
 *
 * `radius` is the brick drum a shoulder meets, not the travertine footing under it: the
 * footing flares to `R + 1.5` but it is below the walking surface.
 */
export function riverTerminusPlan(bay: Bay): { cx: number; cz: number; radius: number } {
  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  return { cx: bay.x0 - f.dx * 2.5, cz: bay.z0 - f.dz * 2.5, radius: TERMINUS_R + 0.4 };
}

/** Radius of the terminus drum at the springing of its brick face. */
const TERMINUS_R = 7.6;

export function buildRiverTerminus(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number
): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const roof = batch.s('roof');
  const g = heightAt(bay.x0, bay.z0);
  const R = TERMINUS_R;
  const top = Math.max(bay.topY, g + 6.5) + 5.6;
  const seg = detail >= 2 ? 22 : detail === 1 ? 13 : 7;
  const { cx, cz } = riverTerminusPlan(bay);

  // Battered travertine footing carried well below the flood line.
  cylinder(stone, cx, g - 4.5, cz, R + 1.5, R + 0.7, 5.4, seg, PAL.travertineDirty, { shadeLow: 0.28 });
  cylinder(brick, cx, g + 0.9, cz, R + 0.7, R * 0.92, top - g - 0.9, seg, PAL.brick, { shadeLow: 0.3 });
  if (detail >= 1) {
    const nb = Math.max(2, Math.round((top - g) / WALL.courseBand));
    for (let k = 1; k < nb; k++) {
      const t = k / nb;
      const y = g + 0.9 + (top - g - 0.9) * t;
      const rr = R + 0.7 + (R * 0.92 - R - 0.7) * t + 0.15;
      cylinder(brick, cx, y - 0.12, cz, rr, rr, 0.12, seg, PAL.tileCourse, { top: true, bottom: true });
    }
    // Postern for the towpath, facing the water.
    brick.push(new THREE.Matrix4().makeRotationY(Math.atan2(-1, 0.2)).setPosition(cx - R * 0.9, g + 0.9, cz));
    archPanel(brick, 4.2, 5.0, PAL.brick, {
      depth: 1.6,
      spring: 2.0,
      openWidth: 1.8,
      segments: detail >= 2 ? 9 : 5,
      archivolt: 0.18,
      voidCol: new THREE.Color(0.024, 0.022, 0.018),
    });
    brick.pop();
  }
  // Cornice, then a crenellated crown and a tiled cap over the guard chamber.
  // Splayed out of the drum, for the same reason as the gate towers': a ring at 1.02 R
  // over a drum tapering to 0.92 R has 0.76 m of open soffit and shows sky through it.
  cylinder(stone, cx, top - 0.3, cz, R * 0.92, R * 1.02, 0.3, seg, PAL.travertine);
  cylinder(stone, cx, top, cz, R * 1.02, R * 1.02, 0.7, seg, PAL.travertine, { top: true });
  const nm = detail >= 1 ? 14 : 7;
  for (let k = 0; k < nm; k++) {
    const a = (Math.PI * 2 * (k + 0.5)) / nm;
    const ax = cx + Math.cos(a) * R * 0.94;
    const az = cz + Math.sin(a) * R * 0.94;
    const tg = a + Math.PI * 0.5;
    quadPrism(
      brick,
      ax - Math.cos(tg) * 0.78,
      az - Math.sin(tg) * 0.78,
      ax + Math.cos(tg) * 0.78,
      az + Math.sin(tg) * 0.78,
      Math.cos(a),
      Math.sin(a),
      0.9,
      top + 0.7,
      top + 2.4,
      PAL.brick,
      PAL.travertine
    );
  }
  cylinder(brick, cx, top + 0.7, cz, R * 0.62, R * 0.62, 3.4, seg, PAL.brick, { shadeLow: 0.1 });
  roof.pushTranslate(cx, 0, cz);
  hipRoof(roof, R * 1.35, R * 1.35, top + 4.1, R * 0.42, 0.5, PAL.roofTileOld);
  roof.pop();
}

/**
 * Timber scaffolding: standards, ledgers, putlogs and plank lifts, **on the city face**.
 *
 * Every offset here is negative along the outward normal, and that is the whole point.
 * The scaffold used to stand on the field side, which put two rows of poles, a plank deck
 * and a fifteen-metre treadwheel crane on the *glacis* of a wall being assaulted by a
 * Germanic host — a free ladder for the Juthungi and the first thing a player notices is
 * wrong. Aurelian's men worked from inside their own circuit for the same reason his
 * material yard is inside it (see `buildYard`): the outside of an unfinished wall in 271
 * is enemy ground.
 *
 * It also means the scaffold, the yard and the wall stair all share the pomerium, so their
 * offsets are chosen not to foul each other: scaffold −3.0..−4.9, stair −3.0..−6.2, yard
 * −11..−23. Stairs are built on finished bays only and scaffolds on unfinished ones, so the
 * two never occupy the same bay.
 */
export function buildScaffold(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  topY: number,
  rng: Rng
): void {
  if (detail < 1) return;
  const timber = batch.s('timber');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  // Cityward. A working scaffold stands about 1.6 m off the face — near enough to reach
  // the work from the deck, far enough to walk behind.
  const standOff = -(HALF_T + 1.6);
  // Inner standard, i.e. the row *nearer the wall*. Cityward offsets grow more negative
  // going away from the wall, so the near row is the larger (less negative) offset.
  const nearOff = standOff + 1.0;
  const nStands = 12;

  for (let s = 0; s <= nStands; s++) {
    const t = s / nStands;
    const px = lerp(bay.x0, bay.x1, t) + nx * standOff;
    const pz = lerp(bay.z0, bay.z1, t) + nz * standOff;
    const g = heightAt(px, pz);
    const h = topY + 2.8 - g;
    const c = new THREE.Color().copy(PAL.timber).multiplyScalar(0.84 + hash2(s, bay.index, 3) * 0.32);
    cylinder(timber, px, g, pz, 0.17, 0.14, h, 6, c);
    // Two rows of poles, not one: a real scaffold is a frame, not a fence.
    const qx = lerp(bay.x0, bay.x1, t) + nx * nearOff;
    const qz = lerp(bay.z0, bay.z1, t) + nz * nearOff;
    cylinder(timber, qx, heightAt(qx, qz), qz, 0.15, 0.12, h - 0.5, 5, c);
    if (detail >= 2) {
      // Sole plates. A 170 mm pole carrying four lifts punches straight through soft ground
      // without one, and a critic reading the frames named the standards "poking into grass
      // with no base pad" before naming anything else about the timber.
      const sole = new THREE.Color().copy(PAL.timberDark).multiplyScalar(0.9);
      box(timber, px - 0.34, g - 0.06, pz - 0.28, px + 0.34, g + 0.1, pz + 0.28, sole);
      box(timber, qx - 0.3, heightAt(qx, qz) - 0.06, qz - 0.24, qx + 0.3, heightAt(qx, qz) + 0.1, qz + 0.24, sole);
    }
    if (s % 2 === 0) {
      // Raking brace out into the pomerium, footed on the ground behind the scaffold.
      const braceOff = standOff - 1.7;
      const bxp = lerp(bay.x0, bay.x1, t) + nx * braceOff;
      const bzp = lerp(bay.z0, bay.z1, t) + nz * braceOff;
      strut(timber, P0.set(px, g + h * 0.9, pz), P1.set(bxp, heightAt(bxp, bzp), bzp), 0.1, c);
    }
  }

  const gBase = Math.min(bay.g0, bay.g1);
  const lifts = Math.max(1, Math.floor((topY - gBase) / 1.9));
  // Inner edge of the plank deck, hard against the curtain's city face.
  const deckOff = -(HALF_T - 0.15);
  for (let k = 1; k <= lifts; k++) {
    const y = gBase + k * 1.9;
    const ax = bay.x0 + nx * standOff;
    const az = bay.z0 + nz * standOff;
    const bx = bay.x1 + nx * standOff;
    const bz = bay.z1 + nz * standOff;
    cylinderBetween(timber, ax, y, az, bx, y, bz, 0.07, PAL.timber);
    /**
     * A ledger on the **inner** row too, and raking braces in the plane of the face.
     *
     * Without these the scaffold is thirteen bare uprights per bay and reads as a picket
     * fence — which is exactly what it looked like once it was moved to the city side where
     * the camera can actually see it. A scaffold is a *frame*: what makes it legible is the
     * horizontals and the diagonals, not the standards. Vitruvius' *machinae* and every
     * surviving depiction of Roman staging show the same triangulated bay.
     */
    const nax = bay.x0 + nx * nearOff;
    const naz = bay.z0 + nz * nearOff;
    const nbx = bay.x1 + nx * nearOff;
    const nbz = bay.z1 + nz * nearOff;
    cylinderBetween(timber, nax, y - 0.5, naz, nbx, y - 0.5, nbz, 0.06, PAL.timberDark);
    if (detail >= 2 && k < lifts) {
      /**
       * Face-plane diagonals, **one standard bay each**.
       *
       * The first attempt at this ran each brace from t = 0 to t = 0.5 of the *wall* bay —
       * 17.75 m along against 1.9 m of rise, a 6° member that is a second ledger with a
       * slope on it, not a brace. A critic shown the render said there was no bracing in the
       * frame at all, and was right to. A scaffold bay here is 35.5 / 12 = 2.96 m, so a
       * proper diagonal over one lift rises 1.9 m in 2.96 and lands at 33°, which is what
       * triangulates the frame and what breaks the orthogonal grid at a distance.
       */
      for (let s = 0; s < nStands; s++) {
        if ((s + k + bay.index) % 2 !== 0) continue;
        // Alternate the hand so the run reads as a braced frame, not a row of parallel ticks.
        const up = (s + k) % 4 < 2;
        const t0 = (up ? s : s + 1) / nStands;
        const t1 = (up ? s + 1 : s) / nStands;
        strut(
          timber,
          P0.set(lerp(ax, bx, t0), y, lerp(az, bz, t0)),
          P1.set(lerp(ax, bx, t1), y + 1.9, lerp(az, bz, t1)),
          0.055,
          PAL.timberDark
        );
      }
      // Rope lashings where a ledger crosses a standard. Roman staging is tied, not nailed,
      // and the binding is the detail that separates modelled staging from decorative.
      for (let s = 0; s <= nStands; s += 2) {
        const t2 = s / nStands;
        const lx = lerp(ax, bx, t2);
        const lz = lerp(az, bz, t2);
        cylinder(timber, lx, y - 0.11, lz, 0.215, 0.215, 0.22, 6, PAL.timberDark);
      }
    }
    /**
     * The plank deck: **boards, not a slab.**
     *
     * It was one quad the length of the bay, which from anywhere near it is a 35 m sheet of
     * timber with one clean straight edge — "no individual board ends, no differing lengths,
     * no overlaps, no gaps". Scaffold boards are about four metres long and are laid four or
     * five abreast with the ends butted wherever a putlog falls, so the deck is emitted as a
     * grid of them with a joint between each and a little tone and height variation.
     *
     * Each board gets a soffit as well. A deck emitted as a single upward quad is invisible
     * from underneath, and now that the staging is on the city side there is a whole
     * pomerium to stand in and look up from.
     */
    const across = detail >= 2 ? 4 : 1;
    const along = detail >= 2 ? 9 : 1;
    for (let c2 = 0; c2 < across; c2++) {
      const w0 = c2 / across;
      const w1 = (c2 + 1) / across;
      for (let a2 = 0; a2 < along; a2++) {
        // 25 mm between boards, and a board sits a few millimetres off its neighbour.
        const j = across > 1 ? 0.012 : 0;
        const s0 = a2 / along;
        const s1 = (a2 + 1) / along;
        const dyB = across > 1 ? hash2(a2, c2 + bay.index * 7 + k * 3, 59) * 0.02 : 0;
        const yb = y + 0.08 + dyB;
        const oA = lerp(standOff, deckOff, w0);
        const oB = lerp(standOff, deckOff, w1) - (across > 1 ? 0.025 : 0);
        const tone = new THREE.Color()
          .copy(PAL.timber)
          .multiplyScalar(0.84 + hash2(a2 * 3 + c2, bay.index + k, 131) * 0.34);
        const pA = { x: lerp(bay.x0, bay.x1, s0), z: lerp(bay.z0, bay.z1, s0) };
        const pB = { x: lerp(bay.x0, bay.x1, s1), z: lerp(bay.z0, bay.z1, s1) };
        const gap = across > 1 ? 0.02 : 0;
        P0.set(pA.x + nx * oB + dx * gap, yb, pA.z + nz * oB + dz * gap);
        P1.set(pB.x + nx * oB - dx * gap, yb, pB.z + nz * oB - dz * gap);
        P2.set(pB.x + nx * oA - dx * gap, yb, pB.z + nz * oA - dz * gap);
        P3.set(pA.x + nx * oA + dx * gap, yb, pA.z + nz * oA + dz * gap);
        OUT.set(0, 1, 0);
        timber.quadN(OUT, P0, P1, P2, P3, tone, tone, tone, tone);
        P0.set(pA.x + nx * oA + dx * gap, yb - 0.055 - j, pA.z + nz * oA + dz * gap);
        P1.set(pB.x + nx * oA - dx * gap, yb - 0.055 - j, pB.z + nz * oA - dz * gap);
        P2.set(pB.x + nx * oB - dx * gap, yb - 0.055 - j, pB.z + nz * oB - dz * gap);
        P3.set(pA.x + nx * oB + dx * gap, yb - 0.055 - j, pA.z + nz * oB + dz * gap);
        OUT.set(0, -1, 0);
        timber.quadN(OUT, P0, P1, P2, P3, PAL.timberDark);
      }
    }
    if (detail >= 2 && k < lifts) {
      // A ladder to the lift above. Four decks with no way between them is a scaffold no
      // builder can use, and it was the first thing a reviewer said was missing outright.
      const lt = 0.18 + ((k * 5 + bay.index) % 7) * 0.1;
      const lOff = standOff + 0.55;
      const lx = lerp(bay.x0, bay.x1, lt) + nx * lOff;
      const lz = lerp(bay.z0, bay.z1, lt) + nz * lOff;
      const foot = 0.55;
      for (const sr of [-1, 1]) {
        strut(
          timber,
          P0.set(lx + dx * sr * 0.24 - nx * foot, y + 0.1, lz + dz * sr * 0.24 - nz * foot),
          P1.set(lx + dx * sr * 0.24, y + 2.0, lz + dz * sr * 0.24),
          0.045,
          PAL.timber
        );
      }
      for (let r = 1; r < 7; r++) {
        const f2 = r / 7;
        const rx = lx - nx * foot * (1 - f2);
        const rz = lz - nz * foot * (1 - f2);
        const ry = y + 0.1 + f2 * 1.9;
        cylinderBetween(timber, rx - dx * 0.24, ry, rz - dz * 0.24, rx + dx * 0.24, ry, rz + dz * 0.24, 0.033, PAL.timberDark, 4);
      }
    }
    if (detail >= 2) {
      // Putlogs: the transoms that carry the deck, one end socketed into the wall.
      for (let s = 0; s < 10; s++) {
        const t = (s + 0.5) / 10;
        const px = lerp(bay.x0, bay.x1, t);
        const pz = lerp(bay.z0, bay.z1, t);
        cylinderBetween(
          timber,
          px + nx * (standOff - 0.35),
          y,
          pz + nz * (standOff - 0.35),
          px + nx * (-(HALF_T - 0.5)),
          y,
          pz + nz * (-(HALF_T - 0.5)),
          0.06,
          PAL.timberDark
        );
      }
    }
  }

  if (bay.index % 2 === 0) buildCrane(batch, detail, bay, topY, rng);
}

/**
 * A Roman *polyspaston*: raking timber legs, a treadwheel driving the tackle, and a
 * dressed block hanging in the fall. Vitruvius X.2 describes exactly this machine.
 */
export function buildCrane(batch: Batch, detail: number, bay: Bay, topY: number, rng: Rng): void {
  const timber = batch.s('timber');
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const t = rng.range(0.3, 0.7);
  const bxp = lerp(bay.x0, bay.x1, t);
  const bzp = lerp(bay.z0, bay.z1, t);
  const baseY = topY + 0.22;
  const mastH = 15.5;
  /**
   * The mast leans **cityward**, and the jib swings over the pomerium.
   *
   * A *polyspaston* is fed from the ground it stands over, and the ground the stone is
   * stacked on is inside the wall — `buildYard` puts the travertine, the brick pallets and
   * the mortar pit at −11..−23 m, because you do not stockpile your building material on
   * the enemy's side of an unfinished wall. The crane used to lean the other way and hang
   * its load out over the glacis, lifting blocks from a yard that is not there.
   */
  const lean = -2.6;

  const apex = new THREE.Vector3(bxp + nx * lean, baseY + mastH, bzp + nz * lean);
  for (const s of [-1, 1]) {
    strut(
      timber,
      P0.set(bxp + dx * s * 1.6 + nx * 0.7, baseY, bzp + dz * s * 1.6 + nz * 0.7),
      apex,
      0.18,
      PAL.timber
    );
  }
  // Backstay taking the overturning moment, footed on the outer lip of the lift. Brought
  // in from 3.2 m to 2.2: the exposed core is 5.45 m wide, so 3.2 stood in mid-air.
  strut(timber, apex, P0.set(bxp + nx * 2.2, baseY, bzp + nz * 2.2), 0.16, PAL.timberDark);
  // Jib carrying the fall out over the yard behind the wall.
  strut(timber, apex, P0.set(bxp - nx * 6.5, baseY + mastH * 0.62, bzp - nz * 6.5), 0.15, PAL.timber);

  // Treadwheel: two rims joined by treads, big enough for two men to walk in.
  //
  // Centred on the lift rather than offset to one side of it. The wheel is 5.8 m across and
  // stands in the plane *across* the wall, so any offset at all hangs most of it over one
  // face or the other: at 1.5 m to the field side it reached 4.4 m out — further than the
  // scaffold it replaced and, being a wheel, a rather better ladder. On the centreline it
  // overhangs the 5.45 m core by 175 mm each way, which is what a real one would do.
  if (detail >= 1) {
    const R = 2.9;
    const wcx = bxp;
    const wcz = bzp;
    const wheelY = baseY + 0.35 + R;
    const rimSeg = detail >= 2 ? 16 : 9;
    for (const s of [-1, 1]) {
      const ox = dx * s * 0.6;
      const oz = dz * s * 0.6;
      // Rim drawn as a thin ring in the vertical plane: a torus is overkill, a short
      // cylinder rotated onto its side reads correctly at this distance.
      const rm = new THREE.Matrix4()
        .makeRotationX(Math.PI / 2)
        .premultiply(new THREE.Matrix4().makeRotationY(Math.atan2(dx, dz)))
        .setPosition(wcx + ox, wheelY, wcz + oz);
      timber.push(rm);
      cylinder(timber, 0, -0.06, 0, R, R, 0.12, rimSeg, PAL.timber, { top: true, bottom: true });
      cylinder(timber, 0, -0.05, 0, R * 0.86, R * 0.86, 0.1, rimSeg, PAL.timberDark, { top: true });
      timber.pop();
    }
    for (let k = 0; k < 12; k++) {
      const a = (Math.PI * 2 * k) / 12;
      const rx = wcx + nx * Math.cos(a) * R;
      const rz = wcz + nz * Math.cos(a) * R;
      const yy = wheelY + Math.sin(a) * R;
      cylinderBetween(timber, rx - dx * 0.6, yy, rz - dz * 0.6, rx + dx * 0.6, yy, rz + dz * 0.6, 0.055, PAL.timberDark);
    }
    cylinderBetween(metal, wcx - dx * 0.85, wheelY, wcz - dz * 0.85, wcx + dx * 0.85, wheelY, wcz + dz * 0.85, 0.09, PAL.iron);
  }

  // The load: a dressed travertine block on the fall, halfway up.
  const loadY = baseY + mastH * 0.4;
  cylinderBetween(metal, apex.x, apex.y - 0.25, apex.z, apex.x, loadY + 1.0, apex.z, 0.035, PAL.iron, 4);
  box(stone, apex.x - 0.62, loadY, apex.z - 0.44, apex.x + 0.62, loadY + 0.86, apex.z + 0.44, PAL.travertine, { bottom: true });
}

/** Stockpiles, mortar pits and rubble on the city side of a working stretch. */
export function buildYard(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const stone = batch.s('stone');
  const brick = batch.s('brick');
  const concrete = batch.s('concrete');
  const timber = batch.s('timber');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);

  // Yards sit on the city side: you do not stack your building stone outside the
  // wall with a Germanic host on the plain.
  const yardOff = -(HALF_T + rng.range(8, 20));
  const nStacks = detail >= 1 ? 5 : 2;
  for (let i = 0; i < nStacks; i++) {
    const t = rng.next();
    const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.jitter(5));
    const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.jitter(5));
    const g = heightAt(px, pz);
    // Dressed travertine in 1.2 × 0.6 × 0.6 m blocks, a few courses high.
    const cols = 2 + rng.int(0, 2);
    const rows = 2 + rng.int(0, 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - (r > 1 ? 1 : 0); c++) {
        const ox = (c - (cols - 1) * 0.5) * 1.3;
        const bx2 = px + dx * ox;
        const bz2 = pz + dz * ox;
        const tone = 0.62 + hash2(i * 7 + c, r, 21) * 0.5;
        const col = new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(tone);
        quadPrism(stone, bx2 - dx * 0.6, bz2 - dz * 0.6, bx2 + dx * 0.6, bz2 + dz * 0.6, nx, nz, 0.62, g + r * 0.62, g + (r + 1) * 0.62 - 0.02, col, col);
      }
    }
  }

  if (detail >= 1) {
    // Brick pallets: *bipedales* stacked on edge.
    for (let i = 0; i < 3; i++) {
      const t = rng.next();
      const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.range(-7, 7));
      const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.range(-7, 7));
      const g = heightAt(px, pz);
      quadPrism(brick, px - dx * 0.85, pz - dz * 0.85, px + dx * 0.85, pz + dz * 0.85, nx, nz, 1.2, g, g + rng.range(0.7, 1.5), PAL.brick, PAL.brickPale);
    }
  }

  // Mortar pit: slaked lime, blindingly pale, with a spoil bank round it.
  const mpT = rng.next();
  const mx = lerp(bay.x0, bay.x1, mpT) + nx * (yardOff - rng.range(3, 10));
  const mz = lerp(bay.z0, bay.z1, mpT) + nz * (yardOff - rng.range(3, 10));
  const mg = heightAt(mx, mz);
  box(concrete, mx - 2.7, mg + 0.04, mz - 2.0, mx + 2.7, mg + 0.12, mz + 2.0, new THREE.Color(0.82, 0.81, 0.75));
  for (const s of [-1, 1]) {
    box(concrete, mx - 3.05, mg, mz + s * 2.1 - 0.32, mx + 3.05, mg + 0.45, mz + s * 2.1 + 0.32, PAL.dust);
    box(concrete, mx + s * 3.05 - 0.32, mg, mz - 2.1, mx + s * 3.05 + 0.32, mg + 0.45, mz + 2.1, PAL.dust);
  }

  // Rubble heaps of broken tufa and tile for the core.
  for (let i = 0; i < (detail >= 1 ? 4 : 1); i++) {
    const t = rng.next();
    const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.range(-9, 9));
    const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.range(-9, 9));
    const g = heightAt(px, pz);
    const r = rng.range(1.7, 3.5);
    cylinder(concrete, px, g, pz, r, r * 0.22, r * 0.52, 7, PAL.concrete, { top: true });
  }

  if (detail >= 1) {
    // Timber stack for the shuttering and the scaffold.
    const t = rng.next();
    const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.range(-5, 5));
    const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.range(-5, 5));
    const g = heightAt(px, pz);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) {
        const off = (c - 1) * 0.34;
        cylinderBetween(
          timber,
          px + nx * off - dx * 2.5,
          g + 0.16 + r * 0.3,
          pz + nz * off - dz * 2.5,
          px + nx * off + dx * 2.5,
          g + 0.16 + r * 0.3,
          pz + nz * off + dz * 2.5,
          0.14,
          PAL.timber
        );
      }
    }
  }
}

/** A footing-only stretch: shuttering boards and the first lift of poured concrete. */
export function buildFootingSite(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const timber = batch.s('timber');
  const concrete = batch.s('concrete');
  const { nx, nz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const gm = Math.min(bay.g0, bay.g1);

  for (const s of [-1, 1]) {
    const off = s * (HALF_T + 0.16);
    quadPrism(
      timber,
      bay.x0 + nx * off,
      bay.z0 + nz * off,
      bay.x1 + nx * off,
      bay.z1 + nz * off,
      nx,
      nz,
      0.1,
      gm + WALL.plinthHeight,
      gm + WALL.plinthHeight + 1.2,
      PAL.timber,
      PAL.timberDark,
      { ends: false }
    );
    if (detail >= 1) {
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        const px = lerp(bay.x0, bay.x1, t) + nx * (off + s * 0.32);
        const pz = lerp(bay.z0, bay.z1, t) + nz * (off + s * 0.32);
        cylinder(timber, px, heightAt(px, pz), pz, 0.08, 0.07, WALL.plinthHeight + 1.45, 5, PAL.timberDark);
      }
    }
  }
  quadPrism(
    concrete,
    bay.x0,
    bay.z0,
    bay.x1,
    bay.z1,
    nx,
    nz,
    CURTAIN_T,
    gm + WALL.plinthHeight,
    gm + WALL.plinthHeight + 1.0,
    PAL.concrete,
    PAL.mortar,
    { ends: false }
  );
  if (bay.dress) buildYard(batch, detail, bay, heightAt, rng);
}

/**
 * A gap in the circuit blocked in a hurry: an earth-and-rubble rampart with a timber
 * palisade on its crest. This is what Aurelian's men would actually have thrown
 * across an unfinished stretch with a Germanic host on the plain.
 */
export function buildGapBarricade(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const concrete = batch.s('concrete');
  const timber = batch.s('timber');
  const stone = batch.s('stone');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const subs = detail >= 1 ? 14 : 4;

  for (let s = 0; s < subs; s++) {
    const t0 = s / subs;
    const t1 = (s + 1) / subs;
    const ax = lerp(bay.x0, bay.x1, t0);
    const az = lerp(bay.z0, bay.z1, t0);
    const bx = lerp(bay.x0, bay.x1, t1);
    const bz = lerp(bay.z0, bay.z1, t1);
    const g = Math.min(heightAt(ax, az), heightAt(bx, bz));
    const h = 2.5 + hash2(s, bay.index, 77) * 0.9;
    quadPrism(concrete, ax, az, bx, bz, nx, nz, CURTAIN_T + 3.6, g - 0.8, g + h, PAL.concrete, PAL.dust, {
      ends: false,
      batter: 0.44,
    });
    if (detail >= 1 && hash2(s, bay.index, 91) > 0.5) {
      const bxx = lerp(ax, bx, 0.5) + nx * (HALF_T + 1.3);
      const bzz = lerp(az, bz, 0.5) + nz * (HALF_T + 1.3);
      quadPrism(stone, bxx - dx * 0.7, bzz - dz * 0.7, bxx + dx * 0.7, bzz + dz * 0.7, nx, nz, 0.7, g, g + 0.66, PAL.travertineDirty, PAL.travertine);
    }
  }

  // Palisade of split stakes on the crest, sharpened and leaning outward.
  const stakes = detail >= 1 ? 46 : 14;
  for (let s = 0; s < stakes; s++) {
    const t = (s + 0.5) / stakes;
    const px = lerp(bay.x0, bay.x1, t);
    const pz = lerp(bay.z0, bay.z1, t);
    const base = heightAt(px, pz) + 2.4 + hash2(s, bay.index, 77) * 0.9;
    const h = 2.3 + hash2(s, bay.index, 5) * 0.7;
    const leanX = nx * 0.3 + dx * (hash2(s, bay.index, 9) - 0.5) * 0.22;
    const leanZ = nz * 0.3 + dz * (hash2(s, bay.index, 9) - 0.5) * 0.22;
    strut(timber, P0.set(px, base - 0.6, pz), P1.set(px + leanX, base + h, pz + leanZ), 0.11 + hash2(s, bay.index, 13) * 0.045, PAL.timber);
  }
  for (let k = 0; k < 2; k++) {
    const y0 = heightAt(bay.x0, bay.z0) + 3.4 + k * 1.2;
    const y1 = heightAt(bay.x1, bay.z1) + 3.4 + k * 1.2;
    cylinderBetween(timber, bay.x0 - nx * 0.28, y0, bay.z0 - nz * 0.28, bay.x1 - nx * 0.28, y1, bay.z1 - nz * 0.28, 0.1, PAL.timberDark);
  }
}
