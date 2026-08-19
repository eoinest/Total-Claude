import { clamp } from '../../util/math';
import {
  carthageWallZ, SEA_LEVEL, WALL_X_MAX, WALL_X_MIN,
} from '../../maps/carthage/topography';
import type { WallLine } from '../carthageWall';

/**
 * Where Carthage's landward defence runs, and what the city inside owes it.
 *
 * **This file is the contract between the wall and the fabric, and it is deliberately data
 * with no geometry in it.** The streets, the military way and every nav measurement inside
 * need the *line*; the masonry needs the same line; a city whose fabric was planned against a
 * different line from the one the walls followed is a seam nobody can see until a cohort
 * walks into a house.
 *
 * ## There were three lines. There is now one, and it is the terrain's.
 *
 * `docs/CARTHAGE.md` §2.5 gives three surveyed anchors — (+1013, 494), (0, 527), (−968, 615)
 * — and two workstreams fitted them independently:
 *
 *     maps/carthage/topography.ts   carthageWallZ   a quadratic through all three
 *     city/carthage/circuit.ts      circuitZAt      piecewise-linear, then bowed 25 m
 *
 * They agree *at* the anchors and nowhere between them. The bow put the two 25.0 m apart at
 * mid-span and 10.6 m apart at x +500 — wider than the graded bench the terrain lays under
 * the wall (`WALL_BENCH_HALF = 40`, so 40 m either side of the centreline), which means a
 * bowed wall would have stood off its own footing over half its length, on ungraded ground,
 * through vegetation the scatter had cleared somewhere else.
 *
 * So the bow is gone and this file re-exports the terrain's function. The reasoning behind
 * the bow was sound and is not lost: it was there so every bay has a flanking angle onto its
 * neighbours and the wall does not read as an extruded rectangle at the strategic camera. The
 * quadratic gives the same thing more weakly — the line's bearing swings 12° across the
 * frontage — and the flanking angle is bought properly by the towers, which project 5.5 m
 * beyond the face at 59.2 m centres. If more curvature is ever wanted, **move it in
 * `topography.ts`**, where the bench and the glacis move with it.
 *
 * ## Orientation, which is not Rome's
 *
 * §2.2: **map −Z is true west, +Z is true east, +X is true north, −X is true south.** The only
 * land approach to Carthage is from the west across the isthmus, and the attacker deploys at
 * z ≈ −190, so the map is rotated 90° anticlockwise from Rome's. Consequences that matter
 * here: the wall's two ends both die on water, there is no flank march, and the defender's
 * back is to the sea at +Z.
 */

/** North and south ends of the frontage — the terrain's, §2.5: x −968 to +1013. */
export const CIRCUIT_X_MIN = WALL_X_MIN;
export const CIRCUIT_X_MAX = WALL_X_MAX;

/**
 * The main wall's line, as a z for each x. **One definition, in `topography.ts`.**
 *
 * Clamped at the anchors so the fabric can sample past the wall's ends without the quadratic
 * running away — beyond them the land wall does not exist and the ground is lagoon.
 */
export function circuitZAt(x: number): number {
  return carthageWallZ(clamp(x, CIRCUIT_X_MIN, CIRCUIT_X_MAX));
}

/** Fieldward (−z) unit normal of the circuit at x. */
export function circuitNormalAt(x: number): { nx: number; nz: number } {
  const dz = (circuitZAt(x + 1) - circuitZAt(x - 1)) * 0.5;
  const len = Math.hypot(1, dz);
  return { nx: dz / len, nz: -1 / len };
}

/**
 * The line handed to `buildCarthageWall`, so the masonry and the fabric cannot disagree.
 *
 * `gateX = 0` is the Porta Byrsae on the axis of the road from Tunis (§4.5) and it is also
 * the survey origin's x, so the principal gate, the forum road and the Byrsa summit are on
 * one axis — which is what makes the isthmus assault legible from the deployment line.
 */
export const CARTHAGE_WALL_LINE: WallLine = {
  xMin: CIRCUIT_X_MIN,
  xMax: CIRCUIT_X_MAX,
  gateX: 0,
  zAt: circuitZAt,
  /**
   * Both anchors die on water and the south one dies *in* it. Measured on the centreline, the
   * ground crosses the datum at x ≈ −956 and the anchor is at −968, so the last 12 m of
   * curtain stands in up to 0.94 m of the Lake of Tunis. §2.2 wants exactly that — a wall
   * that ends in a lagoon is a wall with no flank march round it. What it does not want is
   * the 22.5 m anchor **tower** founded at −0.75 m, which is what was there.
   *
   * The anchor itself is not moved. `nBays` is `round(length / 30.8) & ~1`, so anything east
   * of x −943.4 drops the wall from 64 bays to 62 and relays every bay, tower, postern, ramp
   * and casemate on the circuit to bury one tower — and the window of dry ground before that
   * boundary is 13 m wide, which is a footing measured in centimetres of margin.
   */
  waterLevel: SEA_LEVEL,
  /**
   * **This map cuts the ditch.** `src/maps/carthage/heightfield.ts` stage 4h reads
   * `carthageDitchPath(CARTHAGE_WALL_LINE)` and digs the §4.2 profile into the field before
   * the wall is ever built, so `CarthageDitch.built` is a fact and not an aspiration.
   *
   * Rome's circuit under the `?fort=carthage` rig leaves this unset, which is correct: the
   * Campus Martius heightfield knows nothing about a Punic ditch and its glacis is flat.
   */
  ditchIsCut: true,
};

export interface CircuitGate {
  id: string;
  x: number;
  /** Clear width of the passage through the main wall. */
  width: number;
  principal: boolean;
  name: string;
  /** What kind of ground lies behind it. Each gate opens on a different battle — §8.9. */
  opensOnto: 'megara' | 'forum-road' | 'harbour';
}

/**
 * Three gates, §4.5, all `[GAME]` — no gate in the land wall has been excavated.
 *
 * Each opens onto a different kind of ground, which is the point: the north gate lets an
 * attacker into the Megara's walled gardens, the centre gate onto the road to the forum, and
 * the south gate into the harbour quarter. The attacker picks before he commits.
 *
 * **The x positions are `carthageWall.ts`'s `GATE_AXES`, not the spec's.** §4.5 puts the
 * Porta Maritima at x ≈ −760; the wall builder places it at −560, because its gatehouses are
 * clamped 90 m inside the anchors and pinned to a bay. Two numbers for one gate is the bug
 * this whole file exists to prevent, so the fabric takes the built one and the ways run to
 * it. Only the Porta Byrsae carries leaves; the other two are barred with masonry, which is
 * what a city does with the gates it is not using during a siege.
 */
export const CIRCUIT_GATES: readonly CircuitGate[] = [
  { id: 'porta-byrsae', x: 0, width: 5.2, principal: true, name: 'Porta Byrsae', opensOnto: 'forum-road' },
  { id: 'porta-uticensis', x: 560, width: 5.2, principal: false, name: 'Porta Uticensis', opensOnto: 'megara' },
  { id: 'porta-maritima', x: -560, width: 5.2, principal: false, name: 'Porta Maritima', opensOnto: 'harbour' },
];

/**
 * Clear ground behind the main wall's inner face. §7.5.
 *
 * **35 m, and it is 25 m less than Rome's 60.** Rome's *pomerium* stacks three needs front
 * to back: a lateral movement corridor, room to form up facing a breach, and slack. Carthage
 * needs the last two and not the first, because its lateral corridor is *inside* the wall —
 * that is what the casemate gallery is for. So 25 + 10.
 *
 * The consequence is intended and should not be softened: the fabric stands 25 m closer to
 * the wall than at Rome, so a breach dumps an attacker into houses almost immediately.
 */
export const INTERVALLUM = 35;

/**
 * Where a stair off the wall-walk may put a formation down.
 *
 * **The part of the contract that matters most since wall traversal landed at `fbcfe65`.**
 * Men climb the wall, move along it and walk down into the city, so the ground at the foot
 * of a flight is where the battle goes. The fabric reserves a widened apron at each of these
 * x positions whether or not a flight is ever built there, and the walls workstream can land
 * a stair foot anywhere on this list without coordinating again.
 *
 * §4.4 puts stair-and-ramp blocks in the inner face **at every second tower**, i.e. every
 * 118 world m across 1,981 m of frontage — seventeen of them. Reserving seventeen 70 m-deep
 * aprons would be reserving the whole military way twice over, so the aprons here are placed
 * at every *sixth* tower (355 m) and the 35 m of §7.5 is continuous between them. A flight
 * that lands between two aprons still gets its 35 m, which is 25 m to form up on.
 */
export const STAIR_APRONS: readonly number[] = [-830, -475, -120, 235, 590, 945];

/** Apron half-extents: 120 m along the wall, 70 m deep. */
export const APRON_HALF_RUN = 60;
export const APRON_DEPTH = 70;

/**
 * How far the apron's full depth extends past its half-run before tapering back to 35 m.
 *
 * **Not zero, and the first revision's bug is instructive.** With the cosine shoulder
 * starting at the apron's own edge, the reserved depth at |dx| = `APRON_HALF_RUN` was already
 * back to `INTERVALLUM` — so the corners of the apron the probe then measured were never
 * reserved, and four cells of housing stood in one. The reservation has to be *wider* than
 * the thing it protects.
 */
const APRON_TAPER = 45;

/** Cityward limit of the reserved strip at x — the military way, widened over an apron. */
export function intervallumDepthAt(x: number): number {
  let depth = INTERVALLUM;
  for (const ax of STAIR_APRONS) {
    const d = Math.abs(x - ax);
    if (d > APRON_HALF_RUN + APRON_TAPER) continue;
    const t = d <= APRON_HALF_RUN
      ? 1
      : 0.5 + 0.5 * Math.cos(((d - APRON_HALF_RUN) / APRON_TAPER) * Math.PI);
    depth = Math.max(depth, INTERVALLUM + (APRON_DEPTH - INTERVALLUM) * t);
  }
  return depth;
}

/** Cityward edge of the reserved strip: no building may stand at a smaller z than this. */
export function buildLineZAt(x: number): number {
  return circuitZAt(x) + intervallumDepthAt(x);
}

/**
 * The coastline, §3.6, as world-space points.
 *
 * The fabric stops short of it. Kept here rather than in `layout.ts` because the terrain
 * workstream owns the water and both of us need the same polyline: a city built past the
 * shore and a shore drawn through the city are the same bug seen from two sides. These are
 * the seven surveyed points of §3.6; `topography.ts:coastZ` is a quadratic fitted to them
 * whose worst residual is 45 m, so the polyline is the stricter of the two and the fabric
 * keeps to it.
 */
export const SHORE: readonly { x: number; z: number }[] = [
  { x: -1080, z: 1000 },
  { x: -788, z: 1077 },
  { x: -540, z: 1116 },
  { x: -270, z: 1143 },
  { x: 0, z: 1176 },
  { x: 250, z: 1253 },
  { x: 540, z: 1331 },
];

/** Seaward limit at x: the shore, interpolated, less a margin for the quay and the sea wall. */
export function shoreZAt(x: number): number {
  if (x <= SHORE[0].x) return SHORE[0].z;
  if (x >= SHORE[SHORE.length - 1].x) {
    // Past the last surveyed point the coast keeps running north-east off the map.
    const a = SHORE[SHORE.length - 2];
    const b = SHORE[SHORE.length - 1];
    return b.z + ((x - b.x) * (b.z - a.z)) / (b.x - a.x);
  }
  for (let i = 0; i + 1 < SHORE.length; i++) {
    if (x >= SHORE[i].x && x <= SHORE[i + 1].x) {
      const t = (x - SHORE[i].x) / (SHORE[i + 1].x - SHORE[i].x);
      return SHORE[i].z + (SHORE[i + 1].z - SHORE[i].z) * t;
    }
  }
  return SHORE[SHORE.length - 1].z;
}
