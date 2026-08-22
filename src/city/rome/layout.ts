// `terrain/topography`, not `terrain/TerrainSystem` — see the note in `circuit.ts`.
import { HALF_EXTENT, riverCentreX } from '../../terrain/topography';
import { clamp, lerp } from '../../util/math';
import { hash2 } from '../../util/rand';
import { AX, axisU, axisV, obbOverlap, obbRadius, type Obb, type WayClass } from '../layout';
import { GATE_X } from './apertures';
// Straight from the terrain, not through `./circuit`: the wall builder now reads
// `./assertions`, which reads this file, and `./circuit` would close the cycle.
import { WALL_LENGTH, WALL_X_MIN, romeWallZ as wallCrestZ } from '../../terrain/topography';
import {
  CITY_Z_MAX,
  CITY_Z_MIN,
  EAST_BANK,
  FAR_BANK,
  GATE_Z,
  KX,
  KZ,
  ROME,
  worldOf,
  worldRot,
  type RomeMonument,
  type Terrain,
} from './survey';

/**
 * The plan of Rome, 271 AD, in battlefield coordinates.
 *
 * −Z is north (the Juthungi), +Z is the city. The battlefield proper occupies z < 250
 * and must stay clear.
 *
 * **This file no longer contains any hand-typed monument position.** Every landmark is
 * projected from the measured survey in `survey.ts`, which carries real metres, real
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
// Landmarks, projected from the survey
// ---------------------------------------------------------------------------

/**
 * A monument's reserved footprint is bigger than the building. Real Roman monuments
 * stand in a precinct — the Colosseum inside its ring of travertine bollards and paved
 * area, the Circus behind its outer arcade, a temple inside its *temenos* — and the
 * insula generator has to leave that clear too or the fabric grows into the steps.
 */
export const PRECINCT = 1.07;

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
    clear: Math.sqrt(hw * hw + hd * hd),
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
 * plan Rome rather than a Roman-looking town, taken from the survey in `survey.ts` and from
 * the relationships the brief calls out — the Circus in the Vallis Murcia between the
 * Palatine and the Aventine, the Colosseum east of the Forum, the Palatine between the
 * two, the Campus Martius in the Tiber's bend north-west of the Capitol.
 *
 * Directions are in world terms: −Z is north, +X is east.
 */
export const TOPOLOGY: readonly (
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
 * banding in `monuments.ts` groups neighbours together.
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
        const ilen = Math.sqrt(ix * ix + iz * iz);
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
  // Measured with the land audit in `tools/scratch/land-audit.mjs`: at 1.72 / 2.95 the
  // seventeen quarters between them claimed only 77 % of the ground inside the circuit, and
  // the missing 23 % — 570,000 m², most of it the eastern hills behind the Esquiline and the
  // Caelian — was simply not any district's job to fill, so nothing ever built there however
  // the generator was tuned. A district costs nothing where it overlaps a neighbour (the
  // plot grid gives the ground to whichever quarter is planned first) and costs nothing where
  // it overlaps a monument or a street (the keep-out map rejects it), so over-covering is the
  // cheap error and under-covering is the expensive one.
  const hw = Math.max(150, d.he * KX * 2.05);
  const hd = Math.max(120, d.hn * KZ * 3.5);
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
  // **Grain.** Measured on the orthophoto, Rome's street grain holds over patches of
  // 150–400 m and then rotates 15–40° across a street; a plan with one global orientation
  // is the second-strongest tell of a procedural city after a lack of through-routes. The
  // districts are 400–500 m across, which is exactly that scale, so the grain change is
  // free — it only needs the rotation to be large enough to see. It was ±4.6°, which is
  // not, and every quarter of Rome ran very nearly parallel to every other.
  const rot = (hash2(Math.round(d.e), Math.round(d.n), 0x5c1) - 0.5) * 0.7;
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

// ---------------------------------------------------------------------------
// The street network. `WayClass` — the rank — is shared, in `city/layout.ts`;
// these are Rome's widths for it.
// ---------------------------------------------------------------------------

export const WAY_WIDTH: Readonly<Record<WayClass, number>> = {
  /** A cohort in line, 35 m, with 3.5 m either side. Or two columns abreast. */
  artery: 42,
  /** Two columns abreast; a line must narrow to enter. */
  secondary: 24,
  /** One column of about 16 files. */
  local: 14,
  /** Men in file. A *vicus*, and deliberately hostile to formations. */
  vicus: 8,
} as const;

/**
 * How far back from the kerb the building line stands, by rank.
 *
 * **This is a gameplay number wearing an architectural hat, and both readings agree.**
 *
 * The sim reading: a body of `w` metres can only use a corridor if its *centre* stays `w/2`
 * from any masonry, so a 42 m artery with the fabric hard on the kerb admits a 35 m cohort
 * along a ribbon just seven metres wide — two cells of the four-metre nav grid, and on a
 * corridor that runs at an angle to the grid that ribbon rasterises to a staircase which
 * can and does break. Measured: with the blocks filled in and the frontages hard against
 * every kerb, cohort-reachable ground inside the circuit collapsed to the pomerium alone —
 * 2,781 cells against 21,166 with no buildings at all — because *every* route off the
 * military road was marginal. Nine metres of extra setback on an artery turns a two-cell
 * ribbon into a five-cell one and the network reconnects.
 *
 * The architectural reading: a *vicus* is a doorstep on a lane and 1.5 m is right, but a
 * monumental way is not a road with houses on it. The Via Lata ran between continuous
 * porticoes, the Via Sacra between forecourts and temple steps, and the ground between the
 * carriageway and the building line was part of the street. Setting it back by rank is what
 * every one of those places actually did.
 */
export const WAY_FRONTAGE: Readonly<Record<WayClass, number>> = {
  artery: 10,
  secondary: 5,
  local: 2.5,
  vicus: 1.5,
} as const;

export interface CityWay {
  id: string;
  cls: WayClass;
  path: { x: number; z: number }[];
  width: number;
  /** Paved with polygonal basalt (true) or beaten earth (false). */
  paved: boolean;
  /**
   * Monumental: gets a colonnade line along the footway and marble rather than basalt
   * kerbs. Rome's processional ways were porticoed for most of their length — the point
   * of a 42 m corridor is that it reads as the Via Lata, not as a bypass.
   */
  porticoed?: boolean;
}

/** Back-compatible view of the named historical viae. Used by the plan diagnostic. */
export interface StreetSpec {
  id: string;
  path: { x: number; z: number }[];
  width: number;
  /** Paved with polygonal basalt (true) or beaten earth (false). */
  paved: boolean;
}

/**
 * The named streets of Rome, in survey metres.
 *
 * These are the *armature*: the lines the city was actually organised around, every one
 * of them attested. The Via Lata — the urban continuation of the Via Flaminia, and
 * today's Corso — runs dead straight south from the Porta Flaminia to the foot of the
 * Capitol; everything else in the Campus Martius grows off it. The Via Sacra crosses the
 * Forum and climbs the Velia to the Colosseum valley; the Vicus Patricius is the spine of
 * the Subura; the Alta Semita runs the length of the Quirinal ridge.
 *
 * **On width, and the honest size of the compromise.** A real Roman *via* is about 4.8 m
 * between kerbs and the Via Lata perhaps twelve. Nothing here is that narrow, because a
 * street a formation cannot enter is not a street in this game, it is a wall with a crack
 * in it. The compromise is confined rather than spread: only the ways below carry a rank
 * above `local`, so the city has **five** corridors a cohort can deploy in and several
 * hundred lanes at 8 m — a ratio of about 1:20, which is close to the real one even
 * though every individual number is inflated. Rome had a handful of processional ways and
 * a fabric of *vici*; so does this. And a 42 m corridor is not un-Roman at the places it
 * is used: the Via Lata ran between continuous porticoes, and the open width of the
 * Campus Martius, the fora and the Saepta was far more than that.
 */
const STREET_PLAN: {
  id: string;
  path: [number, number][];
  cls: WayClass;
  paved: boolean;
  porticoed?: boolean;
}[] = [
  {
    id: 'via-lata',
    path: [
      [-497, 2045],
      [-470, 1560],
      [-440, 1080],
      [-400, 620],
      [-340, 240],
      [-180, 40],
      [-30, -30],
    ],
    // The one road from the one gate into the city. If any line in Rome is an artery this
    // is it: the army that holds the Porta Flaminia has to be able to deploy behind it.
    cls: 'artery',
    paved: true,
    porticoed: true,
  },
  {
    id: 'via-sacra',
    // Out of the Forum, over the Velia, past the Meta Sudans into the Colosseum valley.
    path: [
      [-30, -30],
      [120, 30],
      [300, -30],
      [520, -140],
      [700, -230],
      [900, -230],
    ],
    // The triumphal route. In the real city this is not a street at all for most of its
    // length — it is the open floor of the Forum Romanum, then Caesar's forum, then
    // Augustus's, then Nerva's, each a paved rectangle 100 m and more across. Forty-two
    // metres of colonnaded processional way is a *reduction* of what was there.
    cls: 'artery',
    paved: true,
    porticoed: true,
  },
  {
    id: 'via-recta',
    // The east–west spine of the Campus Martius, modern Via dei Coronari.
    path: [
      [-1000, 520],
      [-620, 590],
      [-300, 600],
      [-40, 540],
      [180, 380],
    ],
    cls: 'secondary',
    paved: true,
  },
  {
    id: 'vicus-patricius',
    // Up the Subura from the Fora onto the Viminal.
    path: [
      [180, 40],
      [330, 120],
      [560, 340],
      [820, 640],
      [1080, 900],
    ],
    cls: 'local',
    paved: true,
  },
  {
    id: 'alta-semita',
    // Along the Quirinal ridge to the Porta Salaria. The ridge road is the only
    // continuous east–west route through the eastern hills, so it carries a rank.
    path: [
      [180, 380],
      [330, 640],
      [700, 1020],
      [1150, 1330],
      [1500, 1620],
    ],
    cls: 'secondary',
    paved: true,
  },
  {
    id: 'via-appia',
    // South out of the city between the Palatine and the Caelian, past the Circus.
    path: [
      [430, -180],
      [430, -520],
      [560, -900],
      [700, -1320],
      [800, -1620],
    ],
    // Out of the city between the Palatine and the Caelian down the Vallis Murcia, with
    // the Circus Maximus's whole 600 m flank on one side of it. Open by construction.
    cls: 'artery',
    paved: true,
    porticoed: false,
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
    cls: 'local',
    paved: true,
  },
  {
    id: 'vicus-tuscus',
    // The other way out of the Forum's south-west corner, past the Basilica Julia to the
    // Velabrum and the Forum Boarium. Paired with the Iugarius round the Capitol's foot.
    path: [
      [200, -60],
      [140, -260],
      [40, -450],
      [-120, -560],
    ],
    cls: 'local',
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
    cls: 'secondary',
    paved: true,
  },
  {
    id: 'via-tiburtina',
    // Out of the Subura across the Esquiline to the Porta Tiburtina, under the Aqua
    // Marcia's arches. The eastern quarters had no through route before this.
    path: [
      [620, 300],
      [1050, 420],
      [1500, 560],
      [1950, 700],
    ],
    cls: 'secondary',
    paved: true,
  },
  {
    id: 'vicus-longus',
    // The floor of the valley between the Quirinal and the Viminal, parallel to and below
    // the Alta Semita. Its name is literally "the long street".
    path: [
      [300, 300],
      [560, 620],
      [860, 960],
      [1120, 1240],
    ],
    cls: 'local',
    paved: true,
  },
  {
    id: 'via-triumphalis',
    // Up the west side of the Campus Martius from the Pons Neronianus, the route of the
    // triumph before it turned east for the Capitol. Gives the river quarters a spine.
    path: [
      [-880, 1500],
      [-820, 1050],
      [-780, 620],
      [-720, 180],
      [-640, -200],
    ],
    // The Campus Martius was a parade ground before it was a quarter, and stayed open
    // ground between its monuments. The one line the whole west of the city hangs off.
    cls: 'artery',
    paved: true,
    porticoed: true,
  },
  {
    id: 'via-ostiensis',
    // South along the Tiber past the Emporium's warehouses to the Porta Ostiensis.
    path: [
      [-470, -420],
      [-520, -800],
      [-560, -1180],
      [-580, -1520],
    ],
    cls: 'local',
    paved: true,
  },
  {
    id: 'clivus-aventinus',
    // Up onto the Aventine from the Vallis Murcia, round the west end of the Circus.
    path: [
      [-40, -700],
      [-180, -950],
      [-320, -1200],
    ],
    cls: 'local',
    paved: true,
  },
];

/** The named historical viae, projected and graded. The core of the armature. */
const NAMED_WAYS: CityWay[] = STREET_PLAN.map((s) => ({
  id: s.id,
  cls: s.cls,
  width: WAY_WIDTH[s.cls],
  paved: s.paved,
  porticoed: s.porticoed,
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
  const lata = NAMED_WAYS.find((s) => s.id === 'via-lata');
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

/**
 * The *via sagularis*: the military road inside the curtain.
 *
 * Every Roman fortification from a marching camp to the Aurelian circuit keeps a road
 * behind the rampart so a reserve can reach a threatened stretch without going through the
 * town, and Rome's *pomerium* — the consecrated strip kept free of building — is where it
 * ran. `POMERIUM` is 60 m, chosen so a cohort can form up facing a breach; before this the
 * 60 m was simply *absent* fabric, an empty field that read as unfinished ground in every
 * frame taken from the wall. Paving 42 m of it gives the number a reason you can see:
 * 9 m of verge, the road, 9 m of verge, then the building line.
 *
 * Sampled every 40 m off the terrain's own crest, so it follows the wall wherever the
 * wall goes.
 */
const POMERIUM_WAY: CityWay = (() => {
  const path: { x: number; z: number }[] = [];
  const step = 40;
  const n = Math.max(2, Math.round(WALL_LENGTH / step));
  for (let i = 0; i <= n; i++) {
    const x = WALL_X_MIN + 6 + ((WALL_LENGTH - 12) * i) / n;
    path.push({ x, z: wallCrestZ(x) + 30 });
  }
  return { id: 'via-sagularis', cls: 'artery', width: WAY_WIDTH.artery, paved: true, path };
})();

/**
 * A street all the way round every monument.
 *
 * This is the answer to "the large monuments are smacked down across multiple buildings".
 * The old plan reserved a monument's footprint and let the fabric grow to the reservation
 * line, so the Colosseum's outer wall stood a metre from somebody's kitchen and nothing
 * about the arrangement said which was which. A real monument is *addressed*: it stands in
 * a precinct, the precinct has a street round it, and the fabric presents a frontage to
 * that street. Emitting the ring explicitly does four things at once —
 *
 *  - it guarantees the clearance rather than hoping the block cutter leaves one;
 *  - it gives the insula generator a hard, straight edge to build a street wall against,
 *    which is what makes the fabric read as blocks rather than as scatter;
 *  - it puts the monument on the movement network, so a cohort can march round the
 *    Circus instead of only past one end of it;
 *  - and from above it draws the outline the eye needs to see that the monument is a
 *    *different kind of thing* from the houses.
 *
 * Rank is by size: anything over 150 m on its long axis gets a `secondary` ring, the rest
 * `local`. Hills, gardens and the island are landscape and get nothing.
 */
const RING_MARGIN = 4;
function monumentRings(): CityWay[] {
  const out: CityWay[] = [];
  for (const l of LANDMARKS) {
    if (l.soft || l.onRiver) continue;
    // **Rank by size, and sparingly.** Ringing all 34 monuments with a 14 m road is five
    // kilometres of carriageway, and measured against the fabric it drowns it: monument
    // precincts plus the armature were taking 80 % of the ground inside the walls and the
    // city came back as streets with houses in the gaps rather than the other way round. A
    // small temple does not need its own ring — the quarter's own lanes already run past
    // it — so only the ones with a genuinely monumental frontage get one.
    const long = Math.max(l.hw, l.hd) * 2;
    if (long < 95) continue;
    const cls: WayClass = long > 260 ? 'secondary' : long > 150 ? 'local' : 'vicus';
    const w = WAY_WIDTH[cls];
    // Centreline of the ring: clear of the precinct by the margin plus half the road.
    const hu = l.hw + RING_MARGIN + w * 0.5;
    const hv = l.hd + RING_MARGIN + w * 0.5;
    const cs = Math.cos(l.rot);
    const sn = Math.sin(l.rot);
    const at = (u: number, v: number): { x: number; z: number } => ({
      x: l.x + u * cs - v * sn,
      z: l.z + u * sn + v * cs,
    });
    out.push({
      id: `ring-${l.id}`,
      cls,
      width: w,
      paved: true,
      porticoed: cls === 'secondary',
      path: [at(-hu, -hv), at(hu, -hv), at(hu, hv), at(-hu, hv), at(-hu, -hv)],
    });
  }
  return out;
}

/**
 * Feeders: the links that make the armature a connected graph rather than a bundle of
 * parallel lines.
 *
 * A cohort has to be able to get from the gate to any quarter, and the named viae alone do
 * not manage it — they were authored for the silhouette, and several of them never touch.
 * So each district is joined to whichever way is nearest its centre by a straight `local`
 * link, and each way's far endpoint is joined to its nearest neighbour way. Both passes are
 * pure functions of the plan, so they are deterministic and they re-solve automatically
 * when the overlap resolver moves a monument.
 */
export const WAY_RANK: Readonly<Record<WayClass, number>> = { artery: 3, secondary: 2, local: 1, vicus: 0 };
const BY_RANK: readonly WayClass[] = ['vicus', 'local', 'secondary', 'artery'];

function feeders(base: readonly CityWay[]): CityWay[] {
  const out: CityWay[] = [];
  const nearestOn = (
    x: number,
    z: number,
    skip?: string
  ): { x: number; z: number; d: number; cls: WayClass } => {
    let best = { x, z, d: Infinity, cls: 'vicus' as WayClass };
    for (const w of base) {
      if (w.id === skip) continue;
      for (let i = 0; i + 1 < w.path.length; i++) {
        const a = w.path[i];
        const b = w.path[i + 1];
        const ax = b.x - a.x;
        const az = b.z - a.z;
        const len2 = ax * ax + az * az;
        const t = len2 < 1e-6 ? 0 : clamp(((x - a.x) * ax + (z - a.z) * az) / len2, 0, 1);
        const px = a.x + ax * t;
        const pz = a.z + az * t;
        const d = Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
        if (d < best.d) best = { x: px, z: pz, d, cls: w.cls };
      }
    }
    return best;
  };

  /**
   * Every quarter gets a ranked approach, and it is an **artery**.
   *
   * `secondary` was already an upgrade on `local` — a district joined to the network by a
   * 14 m lane is a district a marching column cannot enter — but 24 m is still eleven metres
   * short of a cohort in line, so under it the *only* ground in Rome a cohort could deploy
   * on was the pomerium, the five named arteries and the handful of squares. Measured on the
   * nav probe as the fabric was densified: cohort-reachable cells inside the circuit fell
   * from 3,412 to 2,778, because filling the blocks in took away the scattered open ground a
   * formation had been using by accident. Openness that a formation reaches *by accident* is
   * not a street network — it is the same fault the whole rebuild exists to correct, seen
   * from the sim's side.
   *
   * So the ground comes back deliberately, as one 42 m approach per quarter. Seventeen
   * links, about 3.4 km, and the eighteen extra metres over a secondary cost roughly 61,000
   * m² — 2.4 % of the walled area — for the property that a cohort can march into every
   * quarter of Rome. That is exactly the trade the width table was written to make.
   */
  for (const d of DISTRICTS) {
    const hit = nearestOn(d.x, d.z);
    // Already on a way, or impossibly far (the far bank, which the bridges serve).
    if (hit.d < 40 || hit.d > 620) continue;
    out.push({
      id: `feeder-${d.id}`,
      cls: 'artery',
      width: WAY_WIDTH.artery,
      paved: true,
      path: [{ x: d.x, z: d.z }, { x: hit.x, z: hit.z }],
    });
  }
  // Stitch every loose end onto the network so no named way is an island.
  //
  // A stitch takes the **lower rank of the two ways it joins**, which is the rule a real
  // road hierarchy follows and, more to the point here, the rule that keeps the wide
  // network connected: two arteries meeting end to end are joined by an artery, so a
  // cohort can pass, while an artery running into a lane is joined by a lane and the
  // fabric keeps the ground.
  for (const w of base) {
    for (const end of [w.path[0], w.path[w.path.length - 1]]) {
      const hit = nearestOn(end.x, end.z, w.id);
      // Under 45 m the two ways already meet for practical purposes and the stitch is
      // pure carriageway; over 340 m it is a road through open country, not a link.
      if (hit.d < 45 || hit.d > 340) continue;
      const cls = BY_RANK[Math.min(WAY_RANK[w.cls], WAY_RANK[hit.cls])];
      out.push({
        id: `stitch-${w.id}-${Math.round(end.x)}`,
        cls,
        width: WAY_WIDTH[cls],
        paved: true,
        path: [{ x: end.x, z: end.z }, { x: hit.x, z: hit.z }],
      });
    }
  }
  return out;
}

/** Named historical viae, as the plan diagnostic labels them. */
export const STREETS: StreetSpec[] = NAMED_WAYS.map((w) => ({
  id: w.id,
  width: w.width,
  paved: w.paved,
  path: w.path,
}));

/**
 * The whole street armature: named viae, the military road behind the wall, a ring round
 * every monument, and the feeders that connect them.
 *
 * Order matters — the fabric generator clips against this in order and the first match
 * wins for surface treatment, so the widest and most important ways come first.
 */
/**
 * Bend a way round the monuments, **because the monuments moved after it was drawn.**
 *
 * This is the other half of "the large monuments are smacked down across multiple buildings",
 * and the half nothing in the build could see. A named via is projected from the survey; the
 * overlap resolver then shoves every monument to stop them interpenetrating, by a mean of
 * 45 m and as much as 145 m. Nothing re-ran the streets afterwards, so the Via Appia ran
 * through the Circus Maximus, the Via Sacra through the Temple of Venus and Rome, and the
 * Via Lata through the Mausoleum of Augustus — at *zero* clearance, not a graze.
 *
 * Measured along the centreline against the same boxes the sim collides with: via-appia 90 %
 * of its length inside masonry, via-triumphalis 91 %, via-sacra 81 %, via-lata 73 %. That is
 * why a cohort could march the whole military road behind the wall and then not get into the
 * city — the arteries were not corridors at all, they were dotted lines through buildings —
 * and it is why the fabric round them looked bitten: the generator correctly refused to build
 * where a street was reserved, and the street was reserved inside a temple.
 *
 * The fix is the one a Roman surveyor would recognise. Resample the line every 30 m so there
 * are nodes to work with, then push any node that is inside a precinct out along its shortest
 * exit until the *carriageway* clears the masonry, and relax the result so the deflection
 * reads as a bend rather than a kink. The Via Sacra really does bend round the Basilica of
 * Maxentius; the Clivus Argentarius really does bend round the Capitol.
 *
 * Ring roads are exempt: a ring is *defined* by hugging its own monument, and deflecting one
 * would be asking it not to be a ring.
 */
const DEFLECT_MARGIN = 3;
function deflect(way: CityWay): void {
  const ringOf = way.id.startsWith('ring-') ? way.id.slice(5) : null;
  const solids = LANDMARKS.filter((l) => !l.soft && l.id !== ringOf);
  const clear = way.width * 0.5 + DEFLECT_MARGIN;

  const dense: { x: number; z: number }[] = [];
  for (let i = 0; i + 1 < way.path.length; i++) {
    const a = way.path[i];
    const b = way.path[i + 1];
    const n = Math.max(1, Math.round(Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z)) / 30));
    for (let s = 0; s < n; s++) dense.push({ x: lerp(a.x, b.x, s / n), z: lerp(a.z, b.z, s / n) });
  }
  dense.push({ ...way.path[way.path.length - 1] });

  // Only the Via Lata has a node that cannot move: its first is the Porta Flaminia's
  // carriageway, and the road out of the one gate in the circuit does not get to wander.
  const first = way.id === 'via-lata' ? 1 : 0;
  const push = (): number => {
    let moved = 0;
    const pt: Obb = { x: 0, z: 0, hw: 0.1, hd: 0.1, rot: 0 };
    for (let i = first; i < dense.length; i++) {
      pt.x = dense[i].x;
      pt.z = dense[i].z;
      for (const l of solids) {
        const hit = obbOverlap(pt, l, clear);
        if (!hit) continue;
        // `obbOverlap` points its normal from a toward b, so away is the negative. The 8 %
        // overshoot matters: landing exactly on the boundary leaves the node oscillating
        // between two neighbouring precincts and the relaxation never settles.
        dense[i].x -= hit.nx * hit.depth * 1.08;
        dense[i].z -= hit.nz * hit.depth * 1.08;
        pt.x = dense[i].x;
        pt.z = dense[i].z;
        moved++;
      }
    }
    return moved;
  };

  // Relax weakly — 0.12 a side, not 0.25. The smoothing exists so a node shoved sixty metres
  // drags its neighbours into a curve instead of leaving a spike the fabric has to be cut
  // around; at a quarter each side it was undoing the push faster than the push applied it,
  // and the deflection converged to about half the job (via-appia 90 % of its length inside
  // masonry down to 34 %, where it needed to reach zero).
  for (let pass = 0; pass < 40; pass++) {
    const moved = push();
    if (moved === 0) break;
    for (let i = 1; i + 1 < dense.length; i++) {
      dense[i].x = dense[i].x * 0.76 + (dense[i - 1].x + dense[i + 1].x) * 0.12;
      dense[i].z = dense[i].z * 0.76 + (dense[i - 1].z + dense[i + 1].z) * 0.12;
    }
  }
  // Finish on pure pushes, so the last thing that happened to the line was clearing stone.
  for (let i = 0; i < 6; i++) if (push() === 0) break;
  way.path = dense;
}

/**
 * True where a monument's masonry stands, for the paving.
 *
 * **The reservation and the paving want different answers here, and conflating them cost
 * 558 cells of cohort reach before it was separated out.**
 *
 * Deflection bends the ways round the monuments but cannot always finish the job: at
 * `PLAN_SCALE` 0.65 the Campus Martius is very nearly wall-to-wall precinct, and about a
 * quarter of the ranked network's length still ends up inside one. The reflex is to cut
 * those runs out of `WAYS` entirely — and measured, that is a bad trade. It surrenders the
 * *reservation* on both sides of the monument, the fabric closes in behind it, and the
 * corridors that were the point of the whole exercise neck shut: cohort-reachable ground
 * inside the circuit fell from 3,466 cells to 2,908, below where this workstream started.
 *
 * The reservation through a monument costs nothing — the monument is already there, and
 * nothing was going to be built inside it. The only thing that was actually wrong is that
 * `buildWays` painted a basalt carriageway across the temple's floor. So the way keeps its
 * whole length, and the *paving* skips the cells that stand on masonry.
 */
export function onMonument(x: number, z: number): boolean {
  for (const l of LANDMARKS) {
    if (l.soft) continue;
    const dx = x - l.x;
    const dz = z - l.z;
    if (dx * dx + dz * dz > (l.hw + l.hd) * (l.hw + l.hd)) continue;
    const cs = Math.cos(l.rot);
    const sn = Math.sin(l.rot);
    if (Math.abs(dx * cs - dz * sn) <= l.hw && Math.abs(dx * sn + dz * cs) <= l.hd) return true;
  }
  return false;
}

export const WAYS: CityWay[] = (() => {
  const named = [POMERIUM_WAY, ...NAMED_WAYS];
  const rings = monumentRings();
  // Deflect the named viae *before* the feeders are solved, so a feeder joins the line the
  // road actually takes rather than the line the survey drew before the monuments moved.
  for (const w of named) deflect(w);
  const base = [...named, ...rings];
  const links = feeders(base);
  for (const w of links) deflect(w);
  return [...base, ...links];
})();

/**
 * An open paved square where two ranked ways meet.
 *
 * **This is what pays for the density.** Filling the blocks in solid takes away the
 * scattered open ground the old plan had, and with it the room a cohort needs to wheel —
 * measured on the old plan, 47 % of the city's free cells would hold a cohort in line but
 * only 14 % of them could be reached by one, because that ground was puddles. Concentrating
 * the same openness into squares at the junctions of the network gives the manoeuvre room
 * back *where a formation actually needs it*, and it does it at the one place a city is
 * historically open anyway.
 *
 * Rome is the proof: the Forum Romanum, the Forum Boarium, the Forum Holitorium, the four
 * Imperial Fora, the Area Sacra, the Saepta and the precincts of the great baths are all
 * exactly this — a paved rectangle where the important streets converge. A plan of Rome
 * without them does not read as Rome, and Lanciani's plate is more square than street in
 * the monumental core.
 */
export interface CityPlaza {
  id: string;
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  /** Colonnaded on all four sides, as a forum is. */
  porticoed: boolean;
}

const RANKED: ReadonlySet<WayClass> = new Set<WayClass>(['artery', 'secondary']);

/**
 * Junctions of the ranked network, clustered and turned into squares.
 *
 * Deterministic and derived: nothing here is hand-placed, so a plaza follows its junction
 * when the overlap resolver moves a monument. A junction is only kept if it stands clear
 * of every monument footprint — the Colosseum already has a precinct and does not need a
 * square driven through it.
 */
/**
 * How many squares the city gets.
 *
 * Sized against the manoeuvre budget rather than chosen: a rank-4 square is 124 × 84 m,
 * which after eroding by a cohort's 17.5 m half-width leaves 89 × 49 m — about 270 cells of
 * the 4 m occupancy grid that a cohort in line can stand in and turn around. Fourteen of
 * them is roughly the district-scale open ground the old scattered plan supplied, gathered
 * into places a formation can actually reach.
 */
const PLAZA_CAP = 14;

export const PLAZAS: CityPlaza[] = (() => {
  const hits: { x: number; z: number; rank: number; rot: number }[] = [];
  const ranked = WAYS.filter((w) => RANKED.has(w.cls));
  const rankOf = (c: WayClass): number => (c === 'artery' ? 2 : 1);
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i];
      const b = ranked[j];
      // A ring and its own monument's approach meet everywhere; skip a ring against a ring.
      if (a.id.startsWith('ring-') && b.id.startsWith('ring-')) continue;
      for (let p = 0; p + 1 < a.path.length; p++) {
        for (let q = 0; q + 1 < b.path.length; q++) {
          const h = segIntersect(a.path[p], a.path[p + 1], b.path[q], b.path[q + 1]);
          if (!h) continue;
          // Orient the square to the bisector of the two ways, so it reads as belonging
          // to the junction rather than to the map axes.
          const ta = Math.atan2(a.path[p + 1].z - a.path[p].z, a.path[p + 1].x - a.path[p].x);
          hits.push({ x: h.x, z: h.z, rank: rankOf(a.cls) + rankOf(b.cls), rot: ta });
        }
      }
    }
  }
  // Cluster: two junctions 60 m apart are one square, not two.
  const clusters: { x: number; z: number; rank: number; rot: number; n: number }[] = [];
  for (const h of hits) {
    const near = clusters.find((c) => Math.sqrt((c.x - h.x) * (c.x - h.x) + (c.z - h.z) * (c.z - h.z)) < 70);
    if (near) {
      near.x = (near.x * near.n + h.x) / (near.n + 1);
      near.z = (near.z * near.n + h.z) / (near.n + 1);
      near.rank = Math.max(near.rank, h.rank);
      near.n++;
    } else {
      clusters.push({ ...h, n: 1 });
    }
  }
  // Biggest junctions first, and a hard cap: a city of squares is not a city either.
  clusters.sort((a, b) => b.rank - a.rank || b.n - a.n || a.x - b.x || a.z - b.z);
  const out: CityPlaza[] = [];
  for (const c of clusters) {
    if (out.length >= PLAZA_CAP) break;
    // Rank 4 is artery × artery: a full forum. Rank 2 is two secondaries: a market square.
    const hw = c.rank >= 4 ? 62 : c.rank >= 3 ? 50 : 38;
    const hd = hw * 0.68;
    const rot = c.rot;
    if (LANDMARKS.some((l) => !l.soft && obbOverlap({ x: c.x, z: c.z, hw, hd, rot }, l, 4))) continue;
    if (c.z < CITY_Z_MIN(c.x) + hd + 8 || c.z > CITY_Z_MAX - hd) continue;
    if (out.some((p) => Math.sqrt((p.x - c.x) * (p.x - c.x) + (p.z - c.z) * (p.z - c.z)) < hw + p.hw + 24)) continue;
    out.push({ id: `forum-${out.length}`, x: c.x, z: c.z, hw, hd, rot, porticoed: c.rank >= 3 });
  }
  return out;
})();

/** Intersection of two 2-D segments, or null when they do not cross. */
function segIntersect(
  a1: { x: number; z: number },
  a2: { x: number; z: number },
  b1: { x: number; z: number },
  b2: { x: number; z: number }
): { x: number; z: number } | null {
  const rx = a2.x - a1.x;
  const rz = a2.z - a1.z;
  const sx = b2.x - b1.x;
  const sz = b2.z - b1.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1.x - a1.x) * sz - (b1.z - a1.z) * sx) / den;
  const u = ((b1.x - a1.x) * rz - (b1.z - a1.z) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1.x + rx * t, z: a1.z + rz * t };
}

/**
 * The whole street network by rank: how many ways of each class and how many kilometres.
 *
 * **`extra` is the district lanes and leaving them out was actively misleading.** The
 * armature is 42 ways and 19 km; the spines and ribs each quarter cuts for itself are
 * several hundred more and the majority of the network by length, so a mix reported from
 * `WAYS` alone said the city had 42 streets in it while the player was looking at a
 * thousand. `CitySystem` passes the generated lanes in, and the number in `stats()` is now
 * the number a plan view can be counted against.
 */
export function wayMix(
  extra: readonly { cls: WayClass; path: readonly { x: number; z: number }[] }[] = []
): { cls: WayClass; count: number; km: number }[] {
  const acc = new Map<WayClass, { count: number; km: number }>();
  const add = (cls: WayClass, path: readonly { x: number; z: number }[]): void => {
    const e = acc.get(cls) ?? { count: 0, km: 0 };
    e.count++;
    for (let i = 0; i + 1 < path.length; i++) {
      e.km += Math.sqrt((path[i + 1].x - path[i].x) * (path[i + 1].x - path[i].x) + (path[i + 1].z - path[i].z) * (path[i + 1].z - path[i].z)) / 1000;
    }
    acc.set(cls, e);
  };
  for (const w of WAYS) add(w.cls, w.path);
  for (const l of extra) add(l.cls, l.path);
  return (['artery', 'secondary', 'local', 'vicus'] as WayClass[])
    .filter((c) => acc.has(c))
    .map((cls) => ({ cls, count: acc.get(cls)!.count, km: +acc.get(cls)!.km.toFixed(2) }));
}
