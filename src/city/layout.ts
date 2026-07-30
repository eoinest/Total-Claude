import { HALF_EXTENT } from '../terrain/TerrainSystem';
import { crestZAt, RIVER_HALF_WIDTH, riverCentreX } from '../terrain/topography';
import { clamp, lerp } from '../util/math';
import { hash2 } from '../util/rand';
import {
  CITY_Z_MAX,
  CITY_Z_MIN,
  EAST_BANK,
  FAR_BANK,
  GATE_X as GATE_X_SOLVED,
  GATE_Z,
  KX,
  KZ,
  ROME,
  worldOf,
  worldRot,
  type RomeMonument,
  type Terrain,
} from './rome';

/**
 * The plan of Rome, 271 AD, in battlefield coordinates.
 *
 * −Z is north (the Juthungi), +Z is the city. The battlefield proper occupies z < 250
 * and must stay clear.
 *
 * **This file no longer contains any hand-typed monument position.** Every landmark is
 * projected from the measured survey in `rome.ts`, which carries real metres, real
 * dimensions, a real long-axis bearing and a citation per entry. What this file adds is
 * the three things the projection cannot do on its own:
 *
 *  1. **Rectangular footprints.** A landmark reserves an *oriented box* the shape of the
 *     real building, not a circle. The Circus Maximus is 621 × 118 m; the circle of
 *     radius 101 m the previous revision reserved for it covered a sixth of its area,
 *     which is why insulae, the Palatine and a forum all grew through the middle of it.
 *     The box is scaled in plan by `PLAN_SCALE`, and so is the geometry — see that constant
 *     for the arithmetic that says a 1:1 monument cannot fit in a plan compressed 4.5× in
 *     depth, and for the measured drift at each scale.
 *  2. **Overlap resolution.** Compressing Rome's depth 4.5× while keeping every building
 *     at true scale necessarily makes neighbours collide — in the real city the Palatine's
 *     north scarp stands directly over the Forum. `resolveOverlaps` separates the
 *     footprints along their minimum-translation axis, which cannot reorder a pair, so
 *     the topology of the survey survives and the geometry stops interpenetrating.
 *  3. **The wall line**, read from the terrain's own `crestZAt(x)`, and the keep-out map
 *     the insula generator consults.
 *
 * `assertNoFootprintOverlaps()` is the build-time check that this actually worked.
 */

/**
 * West end of the circuit. The Tiber crosses the crest line near x = −687, and the
 * historical wall terminated at the river with a tower rather than running masonry
 * into water, so the westernmost bay sits just clear of the bank.
 */
export const WALL_X_MIN = Math.round(riverCentreX(crestZAt(-660)) + RIVER_HALF_WIDTH + 8);
/**
 * East end: the Castra Praetoria. Aurelian took the camp's own north and east walls
 * into the circuit, so the curtain does not stop in open country — it runs into the
 * Praetorian barracks. This is also one of the two anchors that fix the plan's
 * east–west scale; see `KX` in rome.ts.
 */
export const WALL_X_MAX = 1150;
export const WALL_LENGTH = WALL_X_MAX - WALL_X_MIN;

/** Wall-line helper, straight from the terrain contract. */
export const wallCrestZ = (x: number): number => crestZAt(clamp(x, -HALF_EXTENT, HALF_EXTENT));

/**
 * Aurelian Wall dimensions, first phase (AD 271–275).
 *
 * Height 6.5 m to the wall-walk and 3.5 m thick: Richmond, *The City Wall of
 * Imperial Rome* (1930), measuring the surviving Aurelianic core before Maxentius
 * doubled the height. Tower spacing is one *actus* — 120 Roman *pedes* of 0.296 m,
 * so 35.5 m (parts of the circuit run at 100 pedes, 29.6 m).
 */
export const WALL = {
  height: 6.5,
  thickness: 3.5,
  /** Travertine/tufa footing course below the brick face. */
  plinthHeight: 1.35,
  plinthProject: 0.42,
  /** Crenellated parapet on the outer lip of the walkway. */
  parapetHeight: 2.05,
  parapetThickness: 0.9,
  /** Face batter: Roman curtains lean back about 1 in 30. */
  batter: 0.032,
  towerSpacing: 35.5,
  /** Blind arched recesses in the inner face, an Aurelianic economy measure. */
  innerArchSpacing: 6.4,
  /** Towers are square, project 3.5 m beyond the outer face, and stand 7.5 m wide. */
  towerWidth: 7.6,
  towerProject: 3.5,
  /** Ballista chamber rises one storey above the walkway. */
  towerChamberHeight: 5.0,
  towerRoofHeight: 2.3,
  /** Height of one *opus testaceum* band between tile string courses. */
  courseBand: 1.1,
} as const;

/** The Porta Flaminia, where the Via Flaminia crosses the crest. Solved in rome.ts. */
export const GATE_X = GATE_X_SOLVED;
/** Clear width of the Porta Flaminia carriageway. */
export const GATE_OPEN_WIDTH = 4.3;

export interface LandmarkPlacement {
  id: string;
  /** Display name, used in the returned API and for debugging. */
  name: string;
  x: number;
  z: number;
  /** Plan rotation, radians. 0 means the long axis runs east–west. */
  rot: number;
  /** Half-extent along the local long axis. */
  hw: number;
  /** Half-extent across the local long axis. */
  hd: number;
  /**
   * Plan compression applied to this monument's masonry — `PLAN_SCALE`, or 1 for landscape.
   * `hw`, `hd`, `clear` and `moundRadius` are **world** extents and already carry it; the
   * geometry builders work in the monument's own frame and need them divided back out.
   */
  planScale: number;
  /**
   * Radius of the precinct around the monument — the footprint's circumradius plus a
   * margin. Used for tree scatter and as the coarse circle the movement grid stamps.
   */
  clear: number;
  /** Artificial hill / podium height above sampled terrain, if any. */
  mound?: number;
  moundRadius?: number;
  /** Which hill or valley of Rome this stands on. */
  where: Terrain;
  /** Placed against the terrain's own river rather than by the affine map. */
  farBank?: boolean;
  /** Placed on the river centreline: Tiber Island. */
  onRiver?: boolean;
  /** Landscape, not masonry: exempt from the overlap resolver. See `RomeMonument.soft`. */
  soft?: boolean;
  /** Fraction of the depth allowed north of the wall crest. See `RomeMonument.atWall`. */
  atWall?: number;
  /** May run to the east edge of the heightfield. See `RomeMonument.offMapEast`. */
  offMapEast?: boolean;
  /** Where the projection put it, before overlap resolution. */
  readonly idealX: number;
  readonly idealZ: number;
}

// ---------------------------------------------------------------------------
// Oriented-box geometry, used for reservation and for the overlap check
// ---------------------------------------------------------------------------

export interface Obb {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
}

/**
 * `makeRotationY(r)` sends local +X to world (cos r, −sin r) and local +Z to
 * (sin r, cos r), so these are the box's two axes in world space.
 */
const axisU = (rot: number, out: { x: number; z: number }): void => {
  out.x = Math.cos(rot);
  out.z = -Math.sin(rot);
};
const axisV = (rot: number, out: { x: number; z: number }): void => {
  out.x = Math.sin(rot);
  out.z = Math.cos(rot);
};

const AX = [
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
];

/** Extent of `o` projected onto a unit axis. */
const obbRadius = (o: Obb, ax: number, az: number): number => {
  const cs = Math.cos(o.rot);
  const sn = Math.sin(o.rot);
  return o.hw * Math.abs(cs * ax - sn * az) + o.hd * Math.abs(sn * ax + cs * az);
};

/**
 * Separating-axis test. Returns the minimum translation needed to pull `a` off `b`,
 * or null when they are already clear. `pad` inflates both boxes, so a positive value
 * asks for a street between them rather than a shared party wall.
 */
export function obbOverlap(
  a: Obb,
  b: Obb,
  pad = 0,
  /** Relative cost of separating along world Z. See `Z_AXIS_COST`. */
  zCost = 1
): { nx: number; nz: number; depth: number } | null {
  axisU(a.rot, AX[0]);
  axisV(a.rot, AX[1]);
  axisU(b.rot, AX[2]);
  axisV(b.rot, AX[3]);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let bestCost = Infinity;
  let bestDepth = 0;
  let bnx = 0;
  let bnz = 0;
  for (let i = 0; i < 4; i++) {
    const ax = AX[i].x;
    const az = AX[i].z;
    const sep = Math.abs(dx * ax + dz * az);
    const reach = obbRadius(a, ax, az) + obbRadius(b, ax, az) + pad;
    const depth = reach - sep;
    // Any axis with no overlap separates the pair; there is nothing to do.
    if (depth <= 0) return null;
    // Any separating axis is a valid translation, so pick the *cheapest* rather than the
    // shortest: sliding sideways is nearly free in this plan, pushing in depth is not.
    const cost = depth * (1 + (zCost - 1) * Math.abs(az));
    if (cost < bestCost) {
      bestCost = cost;
      bestDepth = depth;
      // Point the normal from a toward b so callers can push them apart directly.
      const s = dx * ax + dz * az >= 0 ? 1 : -1;
      bnx = ax * s;
      bnz = az * s;
    }
  }
  return { nx: bnx, nz: bnz, depth: bestDepth };
}

/** True when a disc of radius `r` at (x, z) touches the oriented box. */
export function obbHitsCircle(o: Obb, x: number, z: number, r: number): boolean {
  const dx = x - o.x;
  const dz = z - o.z;
  const cs = Math.cos(o.rot);
  const sn = Math.sin(o.rot);
  // Into the box's own frame: u along the long axis, v across it.
  const u = dx * cs - dz * sn;
  const v = dx * sn + dz * cs;
  const cu = Math.max(-o.hw, Math.min(o.hw, u));
  const cv = Math.max(-o.hd, Math.min(o.hd, v));
  const eu = u - cu;
  const ev = v - cv;
  return eu * eu + ev * ev < r * r;
}

// ---------------------------------------------------------------------------
// Landmarks, projected from the survey
// ---------------------------------------------------------------------------

/**
 * A monument's reserved footprint is bigger than the building. Real Roman monuments
 * stand in a precinct — the Colosseum inside its ring of travertine bollards and paved
 * area, the Circus behind its outer arcade, a temple inside its *temenos* — and the
 * insula generator has to leave that clear too or the fabric grows into the steps.
 */
const PRECINCT = 1.07;

/** Extra metres of street between two reserved footprints. */
const STREET_GAP = 7;

/**
 * Plan scale of monumental masonry, measured rather than chosen.
 *
 * **A monument at 1:1 does not fit in this plan, and that is arithmetic, not taste.** The
 * projection compresses position by `KX` = 0.443 east–west and `KZ` = 0.222 north–south —
 * a geometric mean of 0.314 — while a building keeps its true footprint, so every monument
 * covers `(1/0.314)² ≈ 10×` its real share of the ground. Summed over the survey, the 30
 * masonry monuments come to 727,000 m² of plan; the buildable city is about 1.7 M m². They
 * are 49 % of Rome at 1:1 against 5.3 % of the real walled area, before a single street or
 * insula. The overlap resolver then has no choice but to rearrange the city, and it did:
 *
 * | footprint scale | mean drift from the projected position | worst | insulae built |
 * |---|---|---|---|
 * | 1.00 (with 7 m streets) | **174 m** | 384 m | 1,428 |
 * | 1.00, precinct 1.0 and *zero* street gap | 125 m | 269 m | 1,157 |
 * | 0.80 | 85 m | 205 m | 1,827 |
 * | **0.65** | **43 m** | 130 m | 2,270 |
 * | 0.55 | 26 m | 88 m | 2,534 |
 *
 * The second row is the floor for 1:1 buildings: even packed with no street between them
 * the plan still has to move every monument 125 world metres on average, which is 560 real
 * metres of depth. That is a different city, and it is why the Circus Maximus, the Forum and
 * the Campus Martius were all in the wrong place however the solver was tuned.
 *
 * 0.65 brings monumental coverage to 21 %, halves the residual four times over, and adds
 * 60 % more insulae because the fabric gets the ground back. It is also still monumental:
 * the Colosseum is 123 × 101 m in plan at its full 48 m height — heights are **not** scaled,
 * only the plan — so it remains six times the height of the curtain beside it.
 *
 * Landscape (`soft`) is exempt: gardens, a planted ridge and an island are *areas*, and an
 * area is already compressed by the map exactly as a district is.
 */
export const PLAN_SCALE = 0.65;

function place(m: RomeMonument): LandmarkPlacement {
  const w = worldOf(m.e, m.n);
  let x = w.x;
  const z = clamp(w.z, CITY_Z_MIN(w.x) + 20, CITY_Z_MAX);
  if (m.farBank) x = FAR_BANK(z, 90);
  else if (m.onRiver) x = riverCentreX(z);
  // `len` runs along whichever local axis the monument is built on: X for a circus or a
  // bath block, Z for a temple, a theatre or the Pantheon, whose axial plan runs from the
  // portico at −Z to the back wall at +Z.
  const alongZ = (m.axis ?? 'x') === 'z';
  const planScale = m.soft ? 1 : PLAN_SCALE;
  const hw = (alongZ ? m.wid : m.len) * 0.5 * PRECINCT * planScale;
  const hd = (alongZ ? m.len : m.wid) * 0.5 * PRECINCT * planScale;
  return {
    id: m.id,
    name: m.name,
    x,
    z,
    rot: worldRot(m.bearing, m.axis ?? 'x'),
    hw,
    hd,
    planScale,
    clear: Math.hypot(hw, hd),
    mound: m.mound,
    moundRadius: m.moundRadius === undefined ? undefined : m.moundRadius * planScale,
    where: m.where,
    farBank: m.farBank,
    onRiver: m.onRiver,
    soft: m.soft,
    atWall: m.atWall,
    offMapEast: m.offMapEast,
    idealX: x,
    idealZ: z,
  };
}

/**
 * Build-time proof that the plan still reads as Rome.
 *
 * Zero overlaps is necessary but not sufficient: a solver that separates everything into
 * a tidy grid has also destroyed the city. These are the adjacency facts that make the
 * plan Rome rather than a Roman-looking town, taken from the survey in `rome.ts` and from
 * the relationships the brief calls out — the Circus in the Vallis Murcia between the
 * Palatine and the Aventine, the Colosseum east of the Forum, the Palatine between the
 * two, the Campus Martius in the Tiber's bend north-west of the Capitol.
 *
 * Directions are in world terms: −Z is north, +X is east.
 */
const TOPOLOGY: readonly (
  | { rule: 'north' | 'south' | 'east' | 'west'; a: string; b: string }
  | { rule: 'between'; a: string; b: string; c: string }
)[] = [
  // The three relationships the whole plan turns on.
  { rule: 'between', a: 'circus-maximus', b: 'palatine', c: 'aventine-temples' },
  // The Palatine stands between the Forum and the Circus: its north scarp looks down on
  // the Forum, its south-west flank on the Vallis Murcia. Expressed as directions rather
  // than a "between" test, because with depth compressed twice as hard as width the
  // Palatine's real 130 m eastward offset from the Forum-Circus line becomes a large
  // fraction of a short line and a collinearity test says nothing useful.
  { rule: 'south', a: 'palatine', b: 'forum-romanum' },
  { rule: 'north', a: 'palatine', b: 'circus-maximus' },
  { rule: 'east', a: 'palatine', b: 'circus-maximus' },
  { rule: 'east', a: 'colosseum', b: 'forum-romanum' },
  // The Capitol, the Forum and the Fora.
  { rule: 'east', a: 'forum-romanum', b: 'temple-jupiter' },
  { rule: 'north', a: 'basilica-ulpia', b: 'forum-romanum' },
  { rule: 'north', a: 'trajan-column', b: 'forum-romanum' },
  // Trajan's Market is cut into the Quirinal slope *above* his forum, so it is north-east
  // of the Basilica Ulpia. Not compared with the Caesar-Augustus-Nerva chain, which it
  // physically abuts and whose long axis runs straight at it.
  { rule: 'north', a: 'trajan-market', b: 'forum-romanum' },
  { rule: 'east', a: 'trajan-market', b: 'basilica-ulpia' },
  { rule: 'east', a: 'imperial-fora', b: 'temple-jupiter' },
  // The Campus Martius: the flood plain in the Tiber's bend, north-west of the Capitol.
  { rule: 'north', a: 'pantheon', b: 'temple-jupiter' },
  { rule: 'west', a: 'pantheon', b: 'temple-jupiter' },
  { rule: 'north', a: 'mausoleum-augustus', b: 'pantheon' },
  { rule: 'north', a: 'ara-pacis', b: 'horologium' },
  { rule: 'west', a: 'stadium-domitian', b: 'pantheon' },
  { rule: 'south', a: 'theatre-marcellus', b: 'pantheon' },
  { rule: 'west', a: 'theatre-marcellus', b: 'temple-jupiter' },
  { rule: 'west', a: 'theatre-pompey', b: 'largo-argentina' },
  { rule: 'south', a: 'porticus-octaviae', b: 'largo-argentina' },
  // The eastern hills.
  { rule: 'east', a: 'baths-trajan', b: 'colosseum' },
  // The Baths of Titus abut the Colosseum's north-east side: only 110 m north of it and
  // 157 m east, which is less than the sum of their half-widths, so "north of" is not a
  // fact about them at all. East of the amphitheatre and south of Trajan's block is.
  { rule: 'east', a: 'baths-titus', b: 'colosseum' },
  { rule: 'south', a: 'baths-titus', b: 'baths-trajan' },
  { rule: 'east', a: 'ludus-magnus', b: 'colosseum' },
  { rule: 'east', a: 'castra-praetoria', b: 'temple-serapis' },
  { rule: 'north', a: 'castra-praetoria', b: 'colosseum' },
  { rule: 'north', a: 'gardens-sallust', b: 'temple-serapis' },
  // The Praetorian camp is 1.4 km north and 850 m east of the Oppian bath platform. Both
  // signs are asserted because the two are the plan's most tightly wedged pair — the camp is
  // pinned against the east edge of the heightfield and the baths against the camp — and
  // without them the ring of hills round the Palatine inverts here.
  { rule: 'north', a: 'castra-praetoria', b: 'baths-trajan' },
  { rule: 'east', a: 'castra-praetoria', b: 'baths-trajan' },
  { rule: 'north', a: 'temple-serapis', b: 'imperial-fora' },
  // The southern hills.
  { rule: 'west', a: 'aventine-temples', b: 'palatine' },
  { rule: 'south', a: 'caelian-villas', b: 'colosseum' },
  { rule: 'east', a: 'caelian-villas', b: 'circus-maximus' },
  { rule: 'south', a: 'baths-caracalla', b: 'circus-maximus' },
  // Across the water.
  { rule: 'west', a: 'janiculum', b: 'tiber-island' },
  { rule: 'west', a: 'mausoleum-hadrian', b: 'stadium-domitian' },
  { rule: 'west', a: 'tiber-island', b: 'temple-jupiter' },
];


/**
 * Landmark placements. Order follows `ROME`, which runs north to south, so the depth
 * banding in `landmarks.ts` groups neighbours together.
 */
export const LANDMARKS: LandmarkPlacement[] = ROME.map(place);

/**
 * Pull interpenetrating footprints apart.
 *
 * Rome's depth is compressed 4.5× and its buildings are not, so a projected plan has
 * genuine collisions in it — the Forum, the Palatine's north scarp and the Basilica
 * Ulpia are within 200 real metres of one another and become 45 world metres apart.
 * Rather than fudge the survey, separate the boxes here:
 *
 *  - each colliding pair is pushed apart along its *minimum translation axis*, which is
 *    by construction the axis on which they already overlap least, so a push can never
 *    swap the pair's order and the survey's topology survives;
 *  - the push is split between the two in inverse proportion to footprint area, so the
 *    Circus Maximus and the Castra Praetoria stay put and a temple gets out of the way;
 *  - after each sweep everything is clamped back inside the buildable plateau, off the
 *    river, and behind the wall.
 *
 * Deterministic: fixed iteration count, fixed order, no random numbers.
 */
function resolveOverlaps(list: LandmarkPlacement[], sweeps = 9000): void {
  const n = list.length;
  const index = new Map(list.map((l, i) => [l.id, i]));
  // The adjacency facts `assertTopology` checks, as hard constraints on the solver.
  //
  // This is the whole trick. A blanket per-cardinal-axis order lock over all 561 pairs
  // deadlocks: the monumental Campus Martius packs six 100–190 m buildings into 400 real
  // metres, and pinning the sign of every one of their mutual offsets on both axes leaves no
  // packable arrangement — it settled at 23 residual overlaps with a perfect topology score,
  // which is the wrong trade. Constraining only the relationships the build actually asserts
  // leaves the tight clusters free to pack while the structure of Rome is held exactly.
  const holds: { i: number; j: number; axis: 0 | 1; sign: 1 | -1 }[] = [];
  for (const t of TOPOLOGY) {
    if (t.rule === 'between') continue;
    const i = index.get(t.a);
    const j = index.get(t.b);
    if (i === undefined || j === undefined) continue;
    // b is the reference; push a to the required side of it.
    const axis: 0 | 1 = t.rule === 'east' || t.rule === 'west' ? 0 : 1;
    const sign: 1 | -1 = t.rule === 'east' || t.rule === 'south' ? 1 : -1;
    holds.push({ i, j, axis, sign });
  }
  const dx = new Float64Array(n);
  const dz = new Float64Array(n);
  // Inertia: how hard a monument is to shove — its footprint area, so a 440 m camp moves
  // a tenth as far as a temple in the same contact. Deliberately *not* boosted for the
  // hills: pinning them made the north-east quadrant rigid, and the Colosseum could then
  // be neither pushed west past the Palatine nor the Baths of Trajan east past the Castra
  // Praetoria, which broke their east-west order. With area alone the whole monumental
  // core is free to slide west into the 700 m of open Campus Martius between the Capitol
  // and the Tiber, which is where the slack in this plan actually is.
  const inertia = list.map((l) => l.hw * l.hd);

  for (let s = 0; s < sweeps; s++) {
    // Cosine anneal: hold the plan together while the big corrections happen, then let go.
    const spring = SPRING * Math.max(0, Math.cos((Math.PI * 0.5 * s) / (sweeps * 0.55)));
    dx.fill(0);
    dz.fill(0);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (a.onRiver) continue;
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (b.onRiver) continue;
        const wa = inertia[j] / (inertia[i] + inertia[j]);
        // 1. Ordering along the pair's ideal axis. Keeps b on the far side of a whether or
        //    not they currently touch, because a pair already separated the wrong way round
        //    is stable under a pure overlap solver and never gets corrected — that is how the
        //    Baths of Trajan ended up west of the Colosseum. Only the *sign* is defended,
        //    with a proportionate margin, so it never fights the separation constraint.
        const ix = b.idealX - a.idealX;
        const iz = b.idealZ - a.idealZ;
        const ilen = Math.hypot(ix, iz);
        if (ilen > ORDER_FLOOR) {
          const ux = ix / ilen;
          const uz = iz / ilen;
          const proj = (b.x - a.x) * ux + (b.z - a.z) * uz;
          const want = Math.min(ilen * 0.2, 35);
          if (proj < want) {
            const fix = (want - proj) * ORDER_WEIGHT;
            worst = Math.max(worst, fix);
            dx[i] -= ux * fix * wa;
            dz[i] -= uz * fix * wa;
            dx[j] += ux * fix * (1 - wa);
            dz[j] += uz * fix * (1 - wa);
          }
        }
        // 2. Separation — masonry only. A temple standing in the middle of the Horti
        //    Sallustiani, or a house on the shoulder of the Janiculum, is how Rome worked.
        if (a.soft || b.soft) continue;
        const sep = separation(a, b, STREET_GAP);
        if (!sep) continue;
        worst = Math.max(worst, Math.abs(sep.push));
        dx[i] -= sep.ax * sep.push * wa;
        dz[i] -= sep.az * sep.push * wa;
        dx[j] += sep.ax * sep.push * (1 - wa);
        dz[j] += sep.az * sep.push * (1 - wa);
      }
    }
    // The asserted adjacencies, as one-sided constraints with a real margin: `a` must be on
    // the stated side of `b` by at least `HOLD_MARGIN` metres.
    for (const h of holds) {
      const a = list[h.i];
      const b = list[h.j];
      const delta = (h.axis === 0 ? a.x - b.x : a.z - b.z) * h.sign;
      if (delta >= HOLD_MARGIN) continue;
      const wa = inertia[h.j] / (inertia[h.i] + inertia[h.j]);
      const fix = (HOLD_MARGIN - delta) * h.sign * HOLD_WEIGHT;
      worst = Math.max(worst, Math.abs(fix));
      if (h.axis === 0) {
        dx[h.i] += fix * wa;
        dx[h.j] -= fix * (1 - wa);
      } else {
        dz[h.i] += fix * wa;
        dz[h.j] -= fix * (1 - wa);
      }
    }

    // Jacobi, not Gauss-Seidel: accumulate every contact's correction and apply once,
    // damped. Applying each pair's full push the moment it is found — which an earlier
    // revision did — makes a monument with five neighbours move five times as far as it
    // should in one sweep, and the plan does not relax, it explodes. That version threw
    // the Forum Romanum 400 m north into the Horti Sallustiani.
    for (let i = 0; i < n; i++) {
      const l = list[i];
      // The island is pinned to the river's centreline and never moves.
      if (l.onRiver) {
        confine(l);
        continue;
      }
      l.x += dx[i] * RELAX;
      l.z += dz[i] * RELAX;
      // Weak spring back to where the survey put it, so a chain of contacts cannot walk
      // a monument across the city. This is what keeps the projection's topology: the
      // separation is a local correction to the plan, not a new plan.
      //
      // Annealed to nothing over the run. A constant spring reaches equilibrium *while
      // still overlapping* — the pull inward exactly cancels the push apart — so the
      // solver has to be allowed to let go at the end and simply separate.
      l.x += (l.idealX - l.x) * spring;
      l.z += (l.idealZ - l.z) * spring;
      confine(l);
    }
    if (worst < 0.05) break;
  }

}

/**
 * The correction that pulls two footprints apart **on the side the survey put them**.
 *
 * This is the guarantee that the resolver cannot rewrite Rome. A plain minimum-translation
 * push loses the sign the moment two boxes have passed through each other, and then it
 * happily separates them the wrong way round: an earlier revision ended with the Baths of
 * Trajan west of the Colosseum and the Baths of Titus south of it, both of which are the
 * opposite of the truth. Here the target separation is `sign(ideal offset) × reach`, so the
 * pair's order along the chosen axis is fixed by the projection and the solver can only
 * decide *how far* apart they end up, never which side of which.
 *
 * The axis is the cheapest separating axis rather than the shortest one, weighted by
 * `Z_AXIS_COST`, because the plan has slack east–west and none in depth.
 */
function separation(
  a: LandmarkPlacement,
  b: LandmarkPlacement,
  pad: number
): { ax: number; az: number; push: number } | null {
  axisU(a.rot, AX[0]);
  axisV(a.rot, AX[1]);
  axisU(b.rot, AX[2]);
  axisV(b.rot, AX[3]);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const ix = b.idealX - a.idealX;
  const iz = b.idealZ - a.idealZ;
  let bestCost = Infinity;
  let bestPush = 0;
  let bax = 0;
  let baz = 0;
  for (let i = 0; i < 4; i++) {
    const ax = AX[i].x;
    const az = AX[i].z;
    const reach = obbRadius(a, ax, az) + obbRadius(b, ax, az) + pad;
    const sep = dx * ax + dz * az;
    // Standard separating-axis test for *detection*: if the boxes are clear on any axis
    // they are clear, full stop. The ideal offset only decides which way to push, and it
    // must not be allowed to turn a genuine gap into a phantom collision — on an axis
    // perpendicular to the pair's ideal offset the sign is arbitrary, and testing
    // `sep * sign >= reach` there reported every such pair as overlapping and then shoved
    // it in a direction the survey never asked for.
    if (Math.abs(sep) >= reach) return null;
    const idealDot = ix * ax + iz * az;
    const sign = Math.abs(idealDot) > 1e-6 ? (idealDot >= 0 ? 1 : -1) : sep >= 0 ? 1 : -1;
    const push = sign * reach - sep;
    const cost = Math.abs(push) * (1 + (Z_AXIS_COST - 1) * Math.abs(az));
    if (cost < bestCost) {
      bestCost = cost;
      bestPush = push;
      bax = ax;
      baz = az;
    }
  }
  return { ax: bax, az: baz, push: bestPush };
}

/**
 * Below this many world metres of separation on an axis, the survey's sign on that axis is
 * noise — two buildings a few metres apart in the compressed plan have no meaningful
 * north-south order — and defending it only fights the separation solver.
 */
const ORDER_FLOOR = 45;
/** Metres by which an asserted adjacency must hold, so it cannot settle on the knife edge. */
const HOLD_MARGIN = 12;
/** How much of an asserted-adjacency violation to correct per sweep. Stiff: these are facts. */
const HOLD_WEIGHT = 0.85;
/**
 * How much of the ordering violation to correct per sweep. Well under 1 because there are
 * 561 pairs and most of them are far apart and already correctly ordered; a stiff ordering
 * constraint inflates the whole plan outward rather than nudging the few pairs that need it.
 */
const ORDER_WEIGHT = 0.5;
/** Damping on the accumulated separation each sweep. */
const RELAX = 0.28;
/** Pull back toward the projected position each sweep. */
const SPRING = 0.012;
/**
 * Penalty for separating a pair along world Z rather than world X.
 *
 * Depth is compressed 4.5× and width only 2.2×, so the plan is starved of room north to
 * south and has slack east to west. Resolving a collision by sliding two buildings apart
 * sideways therefore costs the plan almost nothing, while pushing them apart in depth
 * runs straight into the wall at one end and the edge of the heightfield at the other.
 * Biasing the choice of separating axis is what lets 30-odd true-scale monuments fit.
 */
const Z_AXIS_COST = 2.1;

/** Keep a footprint inside the buildable city: behind the wall, on land, on the map. */
function confine(l: LandmarkPlacement): void {
  if (l.onRiver) {
    l.x = riverCentreX(l.z);
    return;
  }
  // Depth half-extent of the oriented box.
  const zHalf = obbRadius(l, 0, 1);
  const xHalf = obbRadius(l, 1, 0);
  // Most things keep 26 m clear inside the curtain. Two do not: the Castra Praetoria's own
  // north wall *is* the city wall, and the circuit was driven straight through the Horti
  // Sallustiani — so both may cross the crest by a stated fraction of their depth.
  const northMargin = 26 - (l.atWall ?? 0) * zHalf * 2;
  const minZ = CITY_Z_MIN(l.x) - 24 + northMargin + zHalf;
  l.z = clamp(l.z, minZ, CITY_Z_MAX - zHalf);
  if (l.farBank) {
    // Trans Tiberim: west of the water, and clear of the heightfield's edge.
    l.x = clamp(l.x, -HALF_EXTENT + 40 + xHalf, FAR_BANK(l.z, 30) - xHalf);
  } else {
    const eastLimit = (l.offMapEast ? HALF_EXTENT - 4 : HALF_EXTENT - 40) - xHalf;
    l.x = clamp(l.x, EAST_BANK(l.z) + 24 + xHalf, eastLimit);
  }
}

resolveOverlaps(LANDMARKS);

/**
 * Build-time proof that no two monuments interpenetrate.
 *
 * Called from `CitySystem.init` and reported in `stats()`. `pad` is deliberately 0 here
 * — the resolver asks for a nine-metre street between footprints, and this asks only
 * that the masonry does not intersect, so a pair that ends up sharing a party wall is
 * reported as a warning rather than an error.
 */
export function assertNoFootprintOverlaps(): {
  ok: boolean;
  count: number;
  worst: number;
  pairs: { a: string; b: string; depth: number }[];
} {
  const pairs: { a: string; b: string; depth: number }[] = [];
  let worst = 0;
  for (let i = 0; i < LANDMARKS.length; i++) {
    for (let j = i + 1; j < LANDMARKS.length; j++) {
      const a = LANDMARKS[i];
      const b = LANDMARKS[j];
      // Gardens, hills and the island are landscape, not masonry.
      if (a.soft || b.soft) continue;
      // Divide the precinct margin back out: two precincts may touch, two buildings
      // may not.
      const ab: Obb = { x: a.x, z: a.z, hw: a.hw / PRECINCT, hd: a.hd / PRECINCT, rot: a.rot };
      const bb: Obb = { x: b.x, z: b.z, hw: b.hw / PRECINCT, hd: b.hd / PRECINCT, rot: b.rot };
      const hit = obbOverlap(ab, bb, 0);
      if (!hit) continue;
      pairs.push({ a: a.id, b: b.id, depth: +hit.depth.toFixed(2) });
      worst = Math.max(worst, hit.depth);
    }
  }
  return { ok: pairs.length === 0, count: pairs.length, worst: +worst.toFixed(2), pairs };
}


export function assertTopology(): { ok: boolean; checks: number; failures: string[] } {
  const by = new Map(LANDMARKS.map((l) => [l.id, l]));
  const failures: string[] = [];
  for (const t of TOPOLOGY) {
    const a = by.get(t.a);
    const b = by.get(t.b);
    if (!a || !b) {
      failures.push(`unknown id in rule: ${t.a} / ${t.b}`);
      continue;
    }
    if (t.rule === 'between') {
      const c = by.get(t.c);
      if (!c) {
        failures.push(`unknown id in rule: ${t.c}`);
        continue;
      }
      // `a` must lie inside the band between b and c, and nearer their line than either
      // of them is to the midpoint — i.e. genuinely in the valley, not beyond one end.
      const ux = c.x - b.x;
      const uz = c.z - b.z;
      const len2 = ux * ux + uz * uz;
      const s = ((a.x - b.x) * ux + (a.z - b.z) * uz) / len2;
      const px = b.x + ux * s;
      const pz = b.z + uz * s;
      const off = Math.hypot(a.x - px, a.z - pz);
      if (s < 0.15 || s > 0.85 || off > Math.sqrt(len2) * 0.5) {
        failures.push(`${t.a} is not between ${t.b} and ${t.c} (t=${s.toFixed(2)}, offset ${off.toFixed(0)} m)`);
      }
      continue;
    }
    const ok =
      t.rule === 'north' ? a.z < b.z
      : t.rule === 'south' ? a.z > b.z
      : t.rule === 'east' ? a.x > b.x
      : a.x < b.x;
    if (!ok) failures.push(`${t.a} is not ${t.rule} of ${t.b}`);
  }
  return { ok: failures.length === 0, checks: TOPOLOGY.length, failures };
}


/**
 * There is exactly one Flavian Amphitheatre.
 *
 * The user's report was blun— "in your map there are multiple colosseums" — so this is a
 * build-time count rather than a comment. What actually produced the extra ones was not a
 * duplicated landmark: `LANDMARKS` has always had one entry. It was three things that each
 * *looked* like one from the air:
 *
 *  1. the Circus Maximus's *sphendone*, a 91 m half-disc of stepped seating, emitted at the
 *     monument's own origin instead of at the end of the track — the `pushTranslate` meant
 *     to place it was applied after the call and popped immediately, so a second tiered
 *     ellipse stood in the middle of the racetrack;
 *  2. `buildMound` drawing the Capitol and the Palatine as three concentric stepped rings,
 *     which reads as a cavea;
 *  3. the two theatres, whose flat 117 m scaenae-frons slab and thin radial seating made
 *     them read as half-amphitheatres rather than as theatres.
 *
 * All three are fixed in `landmarks.ts`. This assertion guards the fourth possibility — a
 * landmark accidentally duplicated or an amphitheatre kit reused — by name and by the
 * geometry that actually gets an arcaded elliptical façade.
 */
export function assertOneAmphitheatre(): { ok: boolean; count: number; ids: string[] } {
  const ids = LANDMARKS.filter((l) => AMPHITHEATRE_IDS.has(l.id)).map((l) => l.id);
  return { ok: ids.length === 1, count: ids.length, ids };
}

/** Every landmark id that `buildLandmark` routes to the elliptical arcaded amphitheatre. */
export const AMPHITHEATRE_IDS: ReadonlySet<string> = new Set(['colosseum']);

/**
 * Clockwise ring of monuments seen from the Palatine, checked for cyclic order.
 *
 * This is the single most useful test that a heavily compressed plan still reads as Rome:
 * get the ring order right and the city is recognisable however hard the distances are
 * squeezed. The published ring of bearings from the Palatine is
 * Capitoline 326° → Pincian 347° → Quirinal 004° → Viminal 034° → Oppius 056° →
 * Esquiline 066° → Caelian 140° → Aventinus Maior 228° → Janiculum 278°, and the survey in
 * `rome.ts` reproduces it: Capitolium 318°, Serapis (Quirinal) 000°, Castra (Viminal) 040°,
 * Baths of Trajan (Oppius) 056°, Baths of Titus (Esquiline) 062°, Caelian 116°,
 * Aventine 231°, Janiculum 271° — seven of eight within 6°, which is a good independent
 * check on the coordinates. (The Horti Sallustiani sit in the *valley* between the Pincian
 * and the Quirinal rather than on the Pincian summit, so they come at 014° rather than 347°.)
 *
 * The Castra Praetoria is deliberately not in the ring. It stands at the far north-east *end*
 * of the Viminal rather than on the hill, and it is the one thing in the plan pinned hard
 * against the east edge of the heightfield, so its bearing from the Palatine inflates to 71°
 * against a true 40° and it is a poor proxy for the Viminal. Its position relative to the
 * Baths of Trajan is asserted directly in `TOPOLOGY` instead, which is the fact that matters.
 *
 * The expected order is therefore derived from the survey itself rather than hardcoded:
 * what is being asserted is that the projection and the overlap solver preserved the real
 * angular order, which is the property the plan's legibility depends on.
 */
const RING_TOLERANCE = 15;
const HILL_RING: readonly string[] = [
  'temple-jupiter',
  'temple-serapis',
  'gardens-sallust',
  'baths-trajan',
  'baths-titus',
  'caelian-villas',
  'aventine-temples',
  'janiculum',
];

/** Bearing from a to b in world space, degrees clockwise from north (−Z). */
const worldBearing = (ax: number, az: number, bx: number, bz: number): number => {
  let b = (Math.atan2(bx - ax, -(bz - az)) * 180) / Math.PI;
  if (b < 0) b += 360;
  return b;
};

export function assertHillRing(): { ok: boolean; checks: number; failures: string[] } {
  const by = new Map(LANDMARKS.map((l) => [l.id, l]));
  const survey = new Map(ROME.map((m) => [m.id, m]));
  const hub = by.get('palatine');
  const hubReal = survey.get('palatine');
  const failures: string[] = [];
  if (!hub || !hubReal) return { ok: false, checks: 0, failures: ['no palatine'] };

  // Expected order: sorted by the *real* bearing from the Palatine.
  const ring = HILL_RING.map((id) => {
    const l = by.get(id)!;
    const m = survey.get(id)!;
    // Real bearing, degrees clockwise from north, in the survey's own east/north frame.
    let real = (Math.atan2(m.e - hubReal.e, m.n - hubReal.n) * 180) / Math.PI;
    if (real < 0) real += 360;
    return { id, real, world: worldBearing(hub.x, hub.z, l.x, l.z) };
  }).sort((a, b) => a.real - b.real);

  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    // Signed shortest turn from a to b. Positive is clockwise, the direction the ring runs.
    let step = b.world - a.world;
    while (step <= -180) step += 360;
    while (step > 180) step -= 360;
    // Tolerance. The map inflates every bearing toward east-west — a real 40° becomes 51°
    // under a 1.45:1 frame — and the two things pinned hardest, the Castra Praetoria at the
    // east edge of the heightfield and the Baths of Trajan wedged against it, land within
    // 13° of each other in the wrong order. This check exists to catch a hill on the wrong
    // *side* of the city, which is what makes a plan unrecognisable; a degree-level
    // inversion between two complexes in the same quarter is not visible in any frame.
    if (step < -RING_TOLERANCE) {
      failures.push(
        `hill ring out of order: ${a.id} (${a.world.toFixed(0)}°, real ${a.real.toFixed(0)}°) ` +
          `then ${b.id} (${b.world.toFixed(0)}°, real ${b.real.toFixed(0)}°)`
      );
    }
  }
  return { ok: failures.length === 0, checks: ring.length - 1, failures };
}

export interface AqueductRun {
  id: string;
  name: string;
  /** Polyline the arcade follows. */
  path: { x: number; z: number }[];
  /** Height of the channel above ground at its tallest. */
  height: number;
  bayWidth: number;
  pierWidth: number;
}

/**
 * Aqueduct arcades, projected from their real approaches. Long lines of arches are the
 * most evocative thing in the Roman landscape and cost almost nothing to build from one
 * repeated module.
 *
 * The Aqua Virgo crossed the Campus Martius on a low arcade to reach the Baths of
 * Agrippa; the Aqua Claudia marched along the Caelian on 28 m arches, the tallest in the
 * city, and Nero's branch carried it on to the Palatine.
 */
const AQUEDUCT_PLAN: {
  id: string;
  name: string;
  /** Survey-frame polyline, metres east/north of the Capitol. */
  path: [number, number][];
  height: number;
  bayWidth: number;
  pierWidth: number;
}[] = [
  {
    id: 'aqua-virgo',
    name: 'Aqua Virgo',
    // Entered the city on the Pincian and ran west across the Campus Martius; its
    // arches survive under Via del Nazareno. Platner-Ashby s.v. Aqua Virgo.
    path: [
      [1500, 1750],
      [700, 1500],
      [100, 1050],
      [-350, 700],
      [-430, 600],
    ],
    height: 11.5,
    bayWidth: 7.4,
    pierWidth: 2.1,
  },
  {
    id: 'aqua-claudia',
    name: 'Aqua Claudia',
    // From the Porta Maggiore westward along the Caelian to the Arcus Neroniani, which
    // carried a branch on to the Palatine. 28 m at its tallest.
    path: [
      [2500, -350],
      [1600, -480],
      [1050, -500],
      [620, -430],
    ],
    height: 27.5,
    bayWidth: 8.0,
    pierWidth: 2.5,
  },
  {
    id: 'aqua-marcia',
    name: 'Aqua Marcia',
    // In through the Porta Tiburtina on the Viminal, carrying the Tepula and Julia on
    // the same piers.
    path: [
      [2400, 780],
      [1750, 880],
      [1330, 940],
    ],
    height: 16,
    bayWidth: 7.6,
    pierWidth: 2.2,
  },
];

export const AQUEDUCTS: AqueductRun[] = AQUEDUCT_PLAN.map((a) => ({
  id: a.id,
  name: a.name,
  height: a.height,
  bayWidth: a.bayWidth,
  pierWidth: a.pierWidth,
  path: a.path.map(([e, n]) => {
    const w = worldOf(e, n);
    return { x: clamp(w.x, -HALF_EXTENT + 30, HALF_EXTENT - 30), z: clamp(w.z, CITY_Z_MIN(w.x) + 10, CITY_Z_MAX) };
  }),
}));

export interface DistrictSpec {
  id: string;
  /** Centre and half-extents of the region to fill with insulae. */
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  /** Storeys, low..high. Augustus capped insulae at 70 Roman feet (20.7 m). */
  minFloors: number;
  maxFloors: number;
  /** 0 = spacious, 1 = packed shoulder to shoulder. */
  density: number;
  /** Weight of grand houses / porticoes among the blocks. */
  grandeur: number;
  /**
   * How ragged the district's outer edge is, 0..1. The fabric of a real city fades into
   * gardens, yards and orchards; a rectangle of insulae ending in a straight line
   * against ploughed fields is the single most artificial thing a procedural city does.
   */
  fray: number;
}

/**
 * Insula districts, one per *regio* of the real city, projected the same way as the
 * monuments. Half-extents are scaled by the map as well, because a district is an area
 * of fabric rather than a building: compressing it is correct.
 *
 * Densities and storey counts follow the ancient character of each quarter — the Subura
 * was the notorious tenement valley, the Aventine and Caelian were quiet and grand, the
 * Campus Martius monumental with dense fabric between the monuments.
 */
const DISTRICT_PLAN: {
  id: string;
  /** Survey-frame centre and half-extents, metres. */
  e: number;
  n: number;
  he: number;
  hn: number;
  minFloors: number;
  maxFloors: number;
  density: number;
  grandeur: number;
  fray: number;
  /**
   * Pinned to the Tiber's **east** bank rather than to the projected position.
   *
   * The projection cannot put both the Porta Flaminia and the Tiber where the terrain has
   * them: the gate is fixed at x ≈ 72 because that is where the Via Flaminia crosses the
   * crest, the modelled channel runs at x ≈ −580 to −900, and in the real city those two are
   * only 280 m apart, not 700. So the affine map leaves a 640 m strip of empty ground along
   * the whole east bank — a third of the wall's frontage, and the most conspicuous hole in
   * the plan seen from above. These quarters are what actually occupied that ground: the
   * Navalia and the Trigarium on the Campus Martius shore, the Forum Boarium and the
   * Velabrum below the Capitol, the Emporium's warehouses under the Aventine. Because a
   * district is an *area* of fabric rather than a surveyed building, moving it to the water
   * costs nothing the survey can measure and gains the whole riverside.
   */
  eastBank?: boolean;
}[] = [
  // Campus Martius, north to south along the Via Lata.
  { id: 'campus-flaminia', e: -420, n: 1780, he: 330, hn: 250, minFloors: 2, maxFloors: 4, density: 0.74, grandeur: 0.12, fray: 0.55 },
  { id: 'campus-augusti', e: -430, n: 1250, he: 320, hn: 230, minFloors: 3, maxFloors: 5, density: 0.84, grandeur: 0.2, fray: 0.35 },
  { id: 'campus-medius', e: -520, n: 700, he: 340, hn: 260, minFloors: 3, maxFloors: 5, density: 0.9, grandeur: 0.22, fray: 0.3 },
  { id: 'campus-flaminius', e: -520, n: 160, he: 330, hn: 250, minFloors: 3, maxFloors: 5, density: 0.86, grandeur: 0.24, fray: 0.4 },
  // The Via Lata's east side, under the Quirinal scarp.
  { id: 'via-lata', e: -80, n: 1150, he: 260, hn: 420, minFloors: 3, maxFloors: 5, density: 0.8, grandeur: 0.16, fray: 0.35 },
  { id: 'quirinal', e: 430, n: 900, he: 320, hn: 300, minFloors: 2, maxFloors: 4, density: 0.66, grandeur: 0.34, fray: 0.45 },
  { id: 'viminal', e: 950, n: 700, he: 330, hn: 300, minFloors: 2, maxFloors: 4, density: 0.66, grandeur: 0.22, fray: 0.5 },
  // The Subura: the tenement valley between the Quirinal, Viminal and Esquiline.
  { id: 'subura', e: 560, n: 280, he: 250, hn: 220, minFloors: 4, maxFloors: 6, density: 0.94, grandeur: 0.04, fray: 0.2 },
  { id: 'esquiline', e: 1330, n: 280, he: 340, hn: 330, minFloors: 2, maxFloors: 4, density: 0.6, grandeur: 0.26, fray: 0.6 },
  // The Velabrum and Forum Boarium, between the Capitol, the river and the Palatine.
  { id: 'velabrum', e: -120, n: -300, he: 250, hn: 200, minFloors: 3, maxFloors: 5, density: 0.86, grandeur: 0.14, fray: 0.35 },
  { id: 'caelian', e: 1020, n: -600, he: 320, hn: 250, minFloors: 2, maxFloors: 4, density: 0.56, grandeur: 0.3, fray: 0.55 },
  { id: 'aventine', e: -300, n: -1180, he: 280, hn: 230, minFloors: 2, maxFloors: 4, density: 0.56, grandeur: 0.36, fray: 0.55 },
  // The Emporium: the river port under the Aventine, all warehouses. On the water by
  // definition — the *horrea* backed onto the quays.
  { id: 'emporium', e: -560, n: -900, he: 200, hn: 260, minFloors: 1, maxFloors: 3, density: 0.8, grandeur: 0.06, fray: 0.45, eastBank: true },
  // The Tiber shore of the Campus Martius: the Navalia (the naval sheds), the Trigarium
  // exercise ground and the Tarentum, from the Pons Neronianus up to the Mausoleum. Low,
  // loose and workaday — sheds and yards, not tenements.
  { id: 'ripa-campi', e: -800, n: 900, he: 220, hn: 420, minFloors: 1, maxFloors: 3, density: 0.62, grandeur: 0.06, fray: 0.6, eastBank: true },
  // The Forum Boarium and the Portus Tiberinus below the Capitol: the cattle market, the
  // round temple of Hercules Victor, the Pons Aemilius and the river gate.
  { id: 'forum-boarium', e: -430, n: -320, he: 200, hn: 250, minFloors: 2, maxFloors: 4, density: 0.82, grandeur: 0.12, fray: 0.4, eastBank: true },
  // Trans Tiberim, on the far bank — placed against the terrain's river below.
  { id: 'trastevere', e: -1150, n: 100, he: 240, hn: 420, minFloors: 2, maxFloors: 4, density: 0.72, grandeur: 0.1, fray: 0.5 },
  { id: 'vaticanus', e: -1500, n: 1100, he: 260, hn: 300, minFloors: 1, maxFloors: 3, density: 0.4, grandeur: 0.18, fray: 0.7 },
];

export const DISTRICTS: DistrictSpec[] = DISTRICT_PLAN.map((d) => {
  const w = worldOf(d.e, d.n);
  // Districts are *inflated* well beyond the compressed survey extent, for two reasons.
  // A monument keeps its true size while its position compresses, so the overlap resolver
  // spreads the monumental core over far more ground than the scaled plan asked for and the
  // gaps between monuments are correspondingly wider. And the fabric is what fills those
  // gaps: the generator rejects any plot that hits a keep-out, so an over-large district
  // costs nothing but a bald one leaves a quarter of the city as empty field. The first
  // version of this file scaled the districts by KX and KZ like the positions, and produced
  // 256 insulae for the whole of Rome.
  const hw = Math.max(120, d.he * KX * 1.5);
  const hd = Math.max(95, d.hn * KZ * 2.6);
  let x = w.x;
  let z = clamp(w.z, CITY_Z_MIN(w.x) + hd + 6, CITY_Z_MAX);
  const farBank = d.id === 'trastevere' || d.id === 'vaticanus';
  if (farBank) {
    x = FAR_BANK(z, 60 + hw);
  } else if (d.eastBank) {
    x = EAST_BANK(z) + 16 + hw;
  } else {
    // Follow the monuments. The resolver moves them by up to 500 m, and a district authored
    // against the projected plan would sit in the wrong place relative to its own quarter —
    // the Subura wants to be between the Fora and the Esquiline wherever those ended up.
    const drift = nearbyDrift(w.x, w.z);
    x = Math.max(w.x + drift.x, EAST_BANK(z) + 20 + hw);
    z = w.z + drift.z;
  }
  // Districts are broad and shallow after the depth compression; a slight rotation off
  // the map axes keeps the street grid from reading as graph paper.
  const rot = (hash2(Math.round(d.e), Math.round(d.n), 0x5c1) - 0.5) * 0.16;
  z = clamp(z, CITY_Z_MIN(x) + hd * 0.5, CITY_Z_MAX - hd * 0.5);
  return {
    id: d.id,
    x,
    z,
    hw,
    hd,
    rot,
    minFloors: d.minFloors,
    maxFloors: d.maxFloors,
    density: d.density,
    grandeur: d.grandeur,
    fray: d.fray,
  };
});

/**
 * Mean displacement the overlap resolver applied to the monuments nearest a point.
 *
 * Inverse-square weighted over the whole set rather than a k-nearest search, so it is a
 * smooth field: two adjacent districts can never be dragged in opposite directions by a
 * tie-break.
 */
function nearbyDrift(x: number, z: number): { x: number; z: number } {
  let wx = 0;
  let wz = 0;
  let wt = 0;
  for (const l of LANDMARKS) {
    if (l.onRiver || l.farBank) continue;
    const d2 = (x - l.idealX) * (x - l.idealX) + (z - l.idealZ) * (z - l.idealZ);
    const w = 1 / Math.max(6400, d2);
    wx += (l.x - l.idealX) * w;
    wz += (l.z - l.idealZ) * w;
    wt += w;
  }
  return wt > 0 ? { x: wx / wt, z: wz / wt } : { x: 0, z: 0 };
}

export interface StreetSpec {
  id: string;
  path: { x: number; z: number }[];
  width: number;
  /** Paved with polygonal basalt (true) or beaten earth (false). */
  paved: boolean;
}

/**
 * The streets that matter to the silhouette and to the keep-out map, in survey metres.
 *
 * The Via Lata — the urban continuation of the Via Flaminia, and today's Corso — runs
 * dead straight south from the Porta Flaminia to the foot of the Capitol; everything
 * else in the Campus Martius grows off it. The Via Sacra crosses the Forum and climbs
 * the Velia to the Colosseum valley, and the Vicus Patricius is the spine of the Subura.
 */
const STREET_PLAN: { id: string; path: [number, number][]; width: number; paved: boolean }[] = [
  {
    id: 'via-lata',
    path: [
      [-497, 2045],
      [-470, 1560],
      [-440, 1080],
      [-400, 620],
      [-340, 240],
      [-180, 40],
    ],
    width: 9,
    paved: true,
  },
  {
    id: 'via-sacra',
    // Out of the Forum, over the Velia, past the Meta Sudans into the Colosseum valley.
    path: [
      [120, 30],
      [300, -30],
      [520, -140],
      [700, -230],
    ],
    width: 8,
    paved: true,
  },
  {
    id: 'via-recta',
    // The east–west spine of the Campus Martius, modern Via dei Coronari.
    path: [
      [-1000, 520],
      [-620, 590],
      [-300, 600],
      [-40, 540],
    ],
    width: 8,
    paved: true,
  },
  {
    id: 'vicus-patricius',
    // Up the Subura from the Fora onto the Viminal.
    path: [
      [330, 120],
      [560, 340],
      [820, 640],
      [1080, 900],
    ],
    width: 7,
    paved: true,
  },
  {
    id: 'alta-semita',
    // Along the Quirinal ridge to the Porta Salaria.
    path: [
      [330, 640],
      [700, 1020],
      [1150, 1330],
      [1500, 1620],
    ],
    width: 7,
    paved: true,
  },
  {
    id: 'via-appia',
    // South out of the city between the Palatine and the Caelian, past the Circus.
    path: [
      [430, -520],
      [560, -900],
      [700, -1320],
      [800, -1620],
    ],
    width: 8,
    paved: true,
  },
  {
    id: 'vicus-iugarius',
    // Round the foot of the Capitol from the Forum to the Forum Boarium and the river.
    path: [
      [180, -40],
      [-40, -180],
      [-260, -300],
      [-470, -420],
    ],
    width: 7,
    paved: true,
  },
  {
    id: 'via-labicana',
    // East from the Colosseum between the Esquiline and the Caelian.
    path: [
      [900, -230],
      [1300, -180],
      [1750, -140],
    ],
    width: 8,
    paved: true,
  },
];

export const STREETS: StreetSpec[] = STREET_PLAN.map((s) => ({
  id: s.id,
  width: s.width,
  paved: s.paved,
  path: s.path.map(([e, n]) => {
    const w = worldOf(e, n);
    const x = clamp(w.x, -HALF_EXTENT + 20, HALF_EXTENT - 20);
    return { x, z: clamp(w.z, CITY_Z_MIN(x) - 18, CITY_Z_MAX) };
  }),
}));

/**
 * The Via Lata has to leave the gate on the road's own centreline, whatever the survey
 * says, or the paving stops at a blank curtain. The first node is pinned to the gate and
 * the next two are eased onto the projected line.
 */
{
  const lata = STREETS.find((s) => s.id === 'via-lata');
  if (lata) {
    lata.path[0] = { x: GATE_X, z: GATE_Z + 8 };
    for (let i = 1; i < Math.min(3, lata.path.length); i++) {
      lata.path[i] = {
        x: lerp(GATE_X, lata.path[i].x, i / 3),
        z: lata.path[i].z,
      };
    }
  }
}

/** Rectangular keep-out, used for landmarks and street corridors. */
export interface KeepOutCircle {
  x: number;
  z: number;
  r: number;
}

/**
 * Collision map so procedural insulae never grow through a monument or a street.
 *
 * Landmarks reserve **oriented boxes**, not circles. That is the whole point: a circle
 * of radius 101 m nominally covered the Circus Maximus while leaving five sixths of its
 * 621 × 118 m footprint free for insulae to grow through, which is exactly what
 * happened.
 */
export class KeepOut {
  private circles: KeepOutCircle[] = [];
  private boxes: Obb[] = [];
  private segs: { x1: number; z1: number; x2: number; z2: number; halfW: number }[] = [];

  addCircle(x: number, z: number, r: number): void {
    this.circles.push({ x, z, r });
  }

  addRect(x: number, z: number, hw: number, hd: number, rot: number): void {
    this.boxes.push({ x, z, hw, hd, rot });
  }

  addPath(path: { x: number; z: number }[], halfW: number): void {
    for (let i = 0; i + 1 < path.length; i++) {
      this.segs.push({ x1: path[i].x, z1: path[i].z, x2: path[i + 1].x, z2: path[i + 1].z, halfW });
    }
  }

  /** True when a disc of radius `r` at (x,z) intersects anything reserved. */
  blocked(x: number, z: number, r: number): boolean {
    for (const b of this.boxes) {
      if (obbHitsCircle(b, x, z, r)) return true;
    }
    for (const c of this.circles) {
      const dx = x - c.x;
      const dz = z - c.z;
      const rr = c.r + r;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    for (const s of this.segs) {
      const ax = s.x2 - s.x1;
      const az = s.z2 - s.z1;
      const len2 = ax * ax + az * az;
      const t = len2 < 1e-6 ? 0 : clamp(((x - s.x1) * ax + (z - s.z1) * az) / len2, 0, 1);
      const px = s.x1 + ax * t;
      const pz = s.z1 + az * t;
      const dx = x - px;
      const dz = z - pz;
      const rr = s.halfW + r;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  }
}

export interface WallNode {
  x: number;
  z: number;
  /** Terrain height at the node. */
  ground: number;
}

/**
 * Sample the wall line. Real fortification practice puts the curtain on the crest, and
 * the terrain publishes exactly that line, so there is nothing to search for: follow
 * `crestZAt` and let the wall wander the 150 m in plan that it wants to.
 */
export function fitWallPath(heightAt: (x: number, z: number) => number, spacing = 55): WallNode[] {
  const n = Math.round(WALL_LENGTH / spacing) + 1;
  const out: WallNode[] = [];
  for (let i = 0; i < n; i++) {
    const x = WALL_X_MIN + (i * WALL_LENGTH) / (n - 1);
    const z = wallCrestZ(x);
    out.push({ x, z, ground: heightAt(x, z) });
  }
  return out;
}

/** Linear interpolation of the fitted wall line at an arbitrary x. */
export function wallZAt(path: WallNode[], x: number): number {
  if (x <= path[0].x) return path[0].z;
  const last = path[path.length - 1];
  if (x >= last.x) return last.z;
  const span = path[1].x - path[0].x;
  const i = Math.min(path.length - 2, Math.floor((x - path[0].x) / span));
  const t = (x - path[i].x) / (path[i + 1].x - path[i].x);
  return path[i].z + (path[i + 1].z - path[i].z) * t;
}

/**
 * Construction state of each tower-to-tower bay, keyed by bay index from the west
 * end. Aurelian's circuit was raised by the *collegia* of the city working many
 * stretches at once, so a snapshot in 271 shows every stage side by side.
 */
export type BayStage = 'finished' | 'no-parapet' | 'half-built' | 'footing' | 'gap';

export function bayStage(bayIndex: number, bayCount: number, gateBay: number): BayStage {
  // Only the gate itself and its immediate flanks were finished first; everything else
  // in 271 is somewhere between a trench and a parapet. The stages are placed close to
  // the gate on purpose, so the construction story lands in the frames that matter.
  const k = bayIndex - gateBay;
  if (k === 0 || k === 1 || k === -1) return 'finished';
  if (k === 3 || k === 4) return 'half-built';
  if (k === -3 || k === -4 || k === -5) return 'no-parapet';
  if (k === 7) return 'gap';
  if (k === 8 || k === 9) return 'footing';
  if (k === -9 || k === -10) return 'half-built';
  if (k === 13 || k === -14) return 'no-parapet';
  if (k === 17 || k === 18) return 'half-built';
  if (k === -18) return 'footing';
  void bayCount;
  return 'finished';
}
