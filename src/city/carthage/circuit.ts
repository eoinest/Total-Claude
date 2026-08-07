/**
 * Where Carthage's landward defence runs, and what the city inside owes it.
 *
 * **This file is the contract between the wall workstream and the fabric workstream, and it
 * is deliberately data with no geometry in it.** The triple wall is somebody else's to
 * build; the streets, the military way and every nav measurement inside need the *line*
 * long before the stone exists. A city whose fabric was planned against a different line
 * from the one the walls eventually followed is a seam nobody can see until a cohort walks
 * into a house, so both sides read these numbers and neither invents its own.
 *
 * Every value here is `docs/CARTHAGE.md` §4.1, §4.5 and §7.5. Where this file departs from
 * the spec it says so in the entry.
 *
 * ## Orientation, which is not Rome's
 *
 * `docs/CARTHAGE.md` §2.2: **map −Z is true west, +Z is true east, +X is true north, −X is
 * true south.** The only land approach to Carthage is from the west across the isthmus, and
 * the attacker deploys at z ≈ −190, so the map is rotated 90° anticlockwise from Rome's.
 * Consequences that matter here: the wall's two ends both die on water, there is no flank
 * march, and the defender's back is to the sea at +Z.
 */

/** North and south ends of the frontage. §2.5: the wall spans x −968 to +1013. */
export const CIRCUIT_X_MIN = -968;
export const CIRCUIT_X_MAX = 1013;

/** Sagitta of the bow, world metres, convex toward the attacker. §4.1. */
const BOW = 25;

/**
 * The main wall's line, as a z for each x.
 *
 * §2.5 gives three surveyed points: (+1013, 494), (0, 527), (−968, 615). The line leans so
 * the south end sits 121 m deeper into the map. Interpolated linearly between them and then
 * bowed 25 m toward the field, which gives every bay a flanking angle onto its neighbours
 * and stops the wall reading as an extruded rectangle at the strategic camera.
 */
export function circuitZAt(x: number): number {
  const cx = Math.max(CIRCUIT_X_MIN, Math.min(CIRCUIT_X_MAX, x));
  const base = cx >= 0
    ? 527 + (494 - 527) * (cx / CIRCUIT_X_MAX)
    : 527 + (615 - 527) * (cx / CIRCUIT_X_MIN);
  // Bow: zero at both anchors, full at mid-span.
  const t = (cx - CIRCUIT_X_MIN) / (CIRCUIT_X_MAX - CIRCUIT_X_MIN);
  return base - BOW * Math.sin(t * Math.PI);
}

/** Fieldward (−z) unit normal of the circuit at x. */
export function circuitNormalAt(x: number): { nx: number; nz: number } {
  const dz = (circuitZAt(x + 1) - circuitZAt(x - 1)) * 0.5;
  const len = Math.hypot(1, dz);
  return { nx: dz / len, nz: -1 / len };
}

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
 */
export const CIRCUIT_GATES: readonly CircuitGate[] = [
  { id: 'porta-byrsae', x: 0, width: 9.5, principal: true, name: 'Porta Byrsae', opensOnto: 'forum-road' },
  { id: 'porta-uticensis', x: 560, width: 7, principal: false, name: 'Porta Uticensis', opensOnto: 'megara' },
  { id: 'porta-maritima', x: -760, width: 7, principal: false, name: 'Porta Maritima', opensOnto: 'harbour' },
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
 * 118 world m across 1,981 m of frontage — seventeen of them. Reserving seventeen 78 m-deep
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
 * shore and a shore drawn through the city are the same bug seen from two sides.
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
