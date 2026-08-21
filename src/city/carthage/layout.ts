import {
  BYRSA_FOOTPRINT, BYRSA_SUMMIT, BYRSA_X, BYRSA_Z,
} from '../../maps/carthage/topography';
import type { WayClass } from '../layout';
import {
  buildLineZAt, CIRCUIT_GATES, CIRCUIT_X_MAX, CIRCUIT_X_MIN, circuitZAt, shoreZAt,
} from './circuit';

/**
 * The plan of Carthage, spring 146 BC, built to `docs/CARTHAGE.md`.
 *
 * ## Order of operations, which is the whole point of this file
 *
 * Rome's great roads ran 73-91% of their length through solid masonry. Not because the roads
 * were wrong or the monuments were wrong, but because an overlap resolver moved monuments a
 * mean of 45 m *after* the viae had been projected, and nothing re-ran the streets.
 *
 * Carthage removes the step that caused it:
 *
 *   1. **The circuit is fixed** (`circuit.ts`) and nothing moves it.
 *   2. **Monuments are authored at final coordinates** and there is **no resolver**. If two
 *      overlap, that is a bug in the constants below, fixed by editing a number here — not
 *      at runtime, where the fix would invalidate everything computed before it.
 *   3. **Ways are projected against those final positions** and deflect round them at
 *      authoring time, because the positions cannot subsequently change.
 *   4. **Housing is cut last** into what is left, snapped to the cubit module.
 *   5. **Assertions run over the built result**, not over the intent — `assertions.ts`.
 *
 * ## Three departures from the spec's survey, and why
 *
 * The spec's §2.5 projects real survey positions through `KN = 0.45`, `KE = 0.22`, but §2.4
 * exempts the harbour basins and the open squares from that compression because a projected
 * 325 m cothon is a 146 × 72 m ellipse and a projected agora is a corridor. Those two rules
 * are not jointly satisfiable at the surveyed centres: the cothon (x −670) and the
 * rectangular basin (x −540) are 130 world m apart, and a 325 m circle plus a 400 m
 * rectangle need 362 m of separation. The spec's own §2.4 says to record a third case here
 * rather than quietly bend the projection, so:
 *
 * 1. **Basin centres are separated at true scale, not projected scale.** The real centres are
 *    289 m apart north-south, and 289 m is what they get. Cothon → x −930, rectangular
 *    harbour → x −540. Their *relationship* (cothon south of the rectangular basin, both west
 *    of the Byrsa, forum between the harbours and the hill) is exactly the survey's.
 * 2. **The rectangular basin is 320 × 150 m of water, not 400 × 150.** The sources run
 *    300-400; Stager's excavation is usually reported at the low end. 320 is what fits
 *    between the cothon and the forum with a quay belt on both sides, and the difference is
 *    inside the disagreement between the sources.
 * 3. **The forum moves east to x −230 from the spec's −290.** §7.6 already flags its position
 *    as debated and says it was put at −290 "for room"; −230 is the room that is actually
 *    available once the basins are at true scale, and it lengthens the three streets to the
 *    Byrsa rather than shortening them.
 */

// ---------------------------------------------------------------------------
// The Punic cubit, and why the fabric is authored in it
// ---------------------------------------------------------------------------

/**
 * §7.3, and the single most useful thing in the archaeology.
 *
 * The Byrsa quarter's excavation plan dimensions its blocks in cubits, not metres: 30 deep by
 * 60 along the street, subdivided into five plots of 12 × 30. A generator that snaps to that
 * module produces a Carthaginian street front **by construction** — which is a far better
 * foundation than placing buildings and then resolving the overlaps, because there are no
 * overlaps to resolve.
 */
export const CUBIT = 0.515;
/** 30 × 60 cubits = 15.45 × 30.9 m. The insula. */
export const INSULA_DEPTH_CUBITS = 30;
export const INSULA_FACE_CUBITS = 60;
/** Five plots of 12 × 30 cubits per block face. */
export const PLOT_FACE_CUBITS = 12;
export const PLOTS_PER_BLOCK = 5;

export const INSULA_DEPTH = INSULA_DEPTH_CUBITS * CUBIT;
export const INSULA_FACE = INSULA_FACE_CUBITS * CUBIT;
export const PLOT_FACE = PLOT_FACE_CUBITS * CUBIT;

/** §7.3: 2.8 m of clear storey plus 0.4 m of floor. */
export const STOREY_H = 3.2;

// ---------------------------------------------------------------------------
// Monuments — final positions, no resolver
// ---------------------------------------------------------------------------

export type MonumentKind =
  | 'byrsa' | 'forum' | 'cothon' | 'harbour' | 'tophet'
  | 'stoa' | 'temple' | 'cistern' | 'warehouse' | 'quay-fort';

export interface Monument {
  id: string;
  name: string;
  kind: MonumentKind;
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  /** Extra margin reserved round the footprint for steps, precinct paving and a ring road. */
  clear: number;
  /** False for anything a man may walk across — a paved forum, a quay, a precinct. */
  solid: boolean;
}

/**
 * The Byrsa. §5, and §5.1a for the one place the projection is overridden.
 *
 * The hill's *world* footprint is set from the gradient we want, not from the projection.
 * Run the real 700 × 550 m hill through `KN`/`KE` and the relief comes out at 1:1.7 — a 30°
 * cliff on which the three streets are unbuildable and the terraces interpenetrate. 340 × 200
 * world metres puts the built south-east face at 170 m of run for 45 m of rise, 1:3.8, which
 * is 1.8× steeper than the real 1:7 and is a slope three stepped streets can climb.
 *
 * **The hill itself is the heightfield's** — `topography.ts` publishes `byrsaGroundAt`,
 * `BYRSA_FOOTPRINT` and `BYRSA_SUMMIT`, grades to the same 1:3.8 and fails the build past
 * 1:2.5. What is left here is what stands *on* it: the revetted platform, the enceinte and
 * the summit plateau the temple sits on. The footprint and the position are taken from the
 * terrain rather than restated, because two Byrsas that disagree is the bug this workstream
 * keeps finding in other people's files.
 */
export const BYRSA = {
  /** The survey origin. §2.5. */
  x: BYRSA_X,
  z: BYRSA_Z,
  /**
   * World footprint at the 20 m contour, from the terrain. §5.1a — overridden, not projected.
   *
   * An earlier revision of this file carried 170 × **118**, widening z from the spec's 100 so
   * that the west face came out at 1:2.0 against the summit plateau rather than 1:1.6, under
   * §5.1's cap of 1:2 on the north and west slopes. That was a correction to a *synthesised*
   * hill and it no longer applies: the terrain's hill does not fall from the plateau edge to
   * the 20 m contour and stop, it runs on into a skirt out to r = 1.4 (so 140 m in z) before
   * meeting the plain, which is a gentler west face than 118 ever bought. The number is
   * recorded here rather than dropped because the reasoning behind it is still the reasoning
   * anyone should apply if `BYRSA_FOOTPRINT` is ever changed.
   */
  baseHw: BYRSA_FOOTPRINT.hw,
  baseHd: BYRSA_FOOTPRINT.hd,
  /**
   * The revetted citadel platform: the part of the hill that is masonry rather than slope.
   *
   * Everything outside it is the Hannibalic quarter's terraced housing, which is where §7.1's
   * insulae go — they are *on* the hill, not beside it.
   */
  citadelHw: 78,
  citadelHd: 48,
  /**
   * Punic summit plateau, 250 × 180 real at the hill's own world-to-real ratio. The Romans
   * cut several metres off the top for their forum platform, so the Punic summit was higher
   * and smaller than what stands there today.
   */
  summitHw: 58,
  summitHd: 28,
  /**
   * Relief above the lower town, metres. §3.3: summit 60 a.s.l., lower town 12-18.
   * **Not compressed** — §2.4, and this is the number the rule exists for.
   *
   * Reported, not used: the citadel is dimensioned off `byrsaGroundAt` now, so nothing adds
   * this to a terrain height. Kept because it is the figure §5.1a's whole argument turns on
   * and `assertSurveyElevations` grades the built hill against it.
   */
  relief: BYRSA_SUMMIT - 15,
  /** §5.2: 4.5 m high, 2.5 m thick, one gate on the side the three streets arrive from. */
  enceinteHeight: 4.5,
  enceinteThickness: 2.5,
} as const;

/** §6.2. Both basins at true scale; see departure 1 in the header for the centres. */
export const COTHON = {
  x: -930,
  z: 1000,
  /** 325 m outer diameter [ARCH] Hurst. */
  outerR: 162.5,
  /** 125 m admiralty island [ARCH] Hurst, British Mission. */
  islandR: 62.5,
  /** §6.4 [GAME], flagged loudly in the spec: no evidence, built because it is the best
   *  chokepoint on the map and the alternative is an unreachable island. On the north side. */
  causewayWidth: 4,
} as const;

export const MERCHANT_HARBOUR = {
  x: -540,
  z: 1010,
  /** 320 × 150 m of water. See departure 2. Long axis north-south, which here is x. */
  hw: 160,
  hd: 75,
  /** §6.2 [ARCH]: 15 m west and north, 25 m east against the city. */
  quayWest: 15,
  quayEast: 25,
  /** Appian's 70 ft, closable with iron chains. */
  entranceWidth: 21,
} as const;

/** §7.6: 120 × 80 world metres of open paving. World dimensions, not projected. */
export const FORUM = { x: -230, z: 1005, hw: 60, hd: 40 } as const;

export const MONUMENTS: readonly Monument[] = [
  // ---- the harbours ------------------------------------------------------
  {
    id: 'cothon', name: 'The Circular Harbour', kind: 'cothon',
    x: COTHON.x, z: COTHON.z, hw: COTHON.outerR + 20, hd: COTHON.outerR + 20, rot: 0,
    clear: 8, solid: false,
  },
  {
    id: 'merchant-harbour', name: 'The Merchant Harbour', kind: 'harbour',
    x: MERCHANT_HARBOUR.x, z: MERCHANT_HARBOUR.z,
    hw: MERCHANT_HARBOUR.hw + MERCHANT_HARBOUR.quayWest + 6,
    hd: MERCHANT_HARBOUR.hd + MERCHANT_HARBOUR.quayEast + 6, rot: 0,
    clear: 6, solid: false,
  },
  // §6.4: the Roman quay-fort, 60 × 20 m, 16 m to its fighting deck, on the captured quay of
  // the rectangular harbour. An attacker asset, pre-placed: 4,000 men shooting down onto a
  // 16 m rampart from level with it.
  {
    // On the waterfront east of the two moles, not on the quay itself: a 60 × 20 m fort will
    // not share a 25 m quay belt with the 10 m quay road, and putting it there was 8% of
    // `via-navalis` running through solid masonry.
    id: 'quay-fort', name: 'The Roman Quay-Fort', kind: 'quay-fort',
    x: -250, z: 1120, hw: 30, hd: 10, rot: 0, clear: 6, solid: true,
  },
  // ---- the tophet --------------------------------------------------------
  // §2.5: e −71, n −1645 → x = 0.45·(−1645) = −740, z = 945 + 0.22·(−71) = 929. The prior
  // entry here (x −1150, z 950) was ~410 m off this and did not derive from those e/n at all —
  // found and corrected in the D3 landmark audit. Note for the harbour workstream: at this x
  // the tophet sits *between* the two harbours (cothon x −930, merchant harbour x −540), not
  // south of both as the old comment claimed — that reading only held against the harbours'
  // surveyed x of −670, before departure 1 above moved the cothon to −930. Not re-moved here,
  // since the cothon's position is its own deliberate, documented call.
  {
    id: 'tophet', name: 'The Tophet of Salammbô', kind: 'tophet',
    x: -740, z: 929, hw: 62, hd: 44, rot: 0.06, clear: 10, solid: false,
  },
  // ---- the forum and its edges -------------------------------------------
  {
    id: 'forum', name: 'The Forum', kind: 'forum',
    x: FORUM.x, z: FORUM.z, hw: FORUM.hw, hd: FORUM.hd, rot: 0, clear: 10, solid: false,
  },
  {
    id: 'stoa-seaward', name: 'The Seaward Stoa', kind: 'stoa',
    x: FORUM.x, z: FORUM.z + FORUM.hd + 8, hw: FORUM.hw - 4, hd: 7, rot: 0, clear: 3, solid: true,
  },
  {
    id: 'stoa-landward', name: 'The Landward Stoa', kind: 'stoa',
    x: FORUM.x, z: FORUM.z - FORUM.hd - 8, hw: FORUM.hw - 4, hd: 7, rot: 0, clear: 3, solid: true,
  },
  // ---- the harbour quarter -----------------------------------------------
  // On the **landward** side of the merchant basin, not the seaward one. The first revision
  // put them at z 1128, which is where the two moles either side of the 21 m sea entrance
  // stand — a 34 m interpenetration that the overlap check named as soon as it was told to
  // print the pair rather than only the count.
  {
    id: 'horrea-north', name: 'The Harbour Warehouses', kind: 'warehouse',
    x: -540, z: 878, hw: 120, hd: 18, rot: 0, clear: 5, solid: true,
  },
  {
    id: 'temple-sea', name: 'The Temple by the Sea', kind: 'temple',
    x: 150, z: 1245, hw: 22, hd: 32, rot: 0, clear: 8, solid: true,
  },
  // ---- the citadel -------------------------------------------------------
  // Only the revetted platform, not the hill. The hill's slope carries the Hannibalic
  // quarter's terraced housing and the three stepped streets, all of which are walkable
  // ground; reserving the whole 340 × 236 m footprint would delete the fight §5.3 is about.
  {
    id: 'byrsa', name: 'The Byrsa', kind: 'byrsa',
    x: BYRSA.x, z: BYRSA.z, hw: BYRSA.citadelHw, hd: BYRSA.citadelHd, rot: 0,
    clear: 10, solid: true,
  },
  // ---- cisterns ----------------------------------------------------------
  // La Malga is inside the wall west of the Byrsa: §2.5 puts it at (x +100, z 788). The
  // surviving cisterns there are Roman, but Punic Carthage was cistern-fed to a fault — every
  // excavated house has one — and public reservoirs are the right idiom.
  {
    id: 'cisterns-malga', name: 'The La Malga Cisterns', kind: 'cistern',
    x: 100, z: 788, hw: 58, hd: 20, rot: 0.03, clear: 7, solid: true,
  },
  {
    id: 'cisterns-south', name: 'The Southern Cisterns', kind: 'cistern',
    x: -560, z: 780, hw: 44, hd: 17, rot: -0.02, clear: 7, solid: true,
  },
];

// ---------------------------------------------------------------------------
// The street armature
// ---------------------------------------------------------------------------

/**
 * §7.2. **This is where the analogy to Rome breaks, and it breaks hard.**
 *
 * Rome runs 42 / 24 / 14 / 8 m, and `rome/layout.ts` concedes in its own comment that a real
 * Roman *via* is about 4.8 m and 42 is a compromise so a 35 m cohort can move. Carthage has
 * no equivalent of even the honest end of that: the widest street anywhere in the excavated
 * Punic city is 9 m and the literature calls it exceptional. The ordinary Punic street is
 * 3-7 m.
 *
 * **The consequence is the map's infantry mechanic and it must be designed for, not around.**
 * A cohort in line is ~35 m. It fits on a processional street and nowhere else. Everywhere
 * else the attacker is in column at 4-7 m frontage or he is not moving.
 */
export const PUNIC_WAY_WIDTH: Readonly<Record<WayClass, number>> = {
  /** Processional, 20 m [GAME] — two only: the gate-to-forum road and the forum's frontage. */
  artery: 20,
  /** Arterial, 12 m [GAME], anchored on the attested 9 m sea-gate street and rounded up. */
  secondary: 12,
  /** Local, 7 m [ARCH], the top of Lancel's 5-7 m band. */
  local: 7,
  /** Lane, 4 m [ARCH], near the Magon quarter's 3 m. A formation cannot use it. */
  vicus: 4,
};

/** §7.1: stepped streets on the Byrsa are 6 m [ARCH] — Rue II measures 7.5, Rue III 5.4. */
export const STEPPED_STREET_WIDTH = 6;

/**
 * Frontage margin kept clear beyond the carriageway. Punic thresholds, not Roman porticoes.
 *
 * **The two upper ranks are sized on the body that has to use them, and they were not.**
 * A cohort in line is 35 m at the sim's 0.72 m pitch and a column is 16 m; `probe-carthage`
 * floods the city at exactly those two radii. With frontage at 3.5 and 2.5 the reserved
 * bands were 27 m and 17 m — so the arterial rank cleared a 16 m column by **one metre** and
 * the processional rank did not clear a cohort at all.
 *
 * It went unnoticed while the fabric was thin, because a formation could cut across whatever
 * ground had not been built on. Filling the housing in removed that: with the same frontages
 * and 765 blocks instead of 423, a cohort seeded at the stormed gate reached **0.9 hectares** —
 * out of the gate and nowhere. That is not "the attacker is in column, permanently" (§8.6),
 * which is the design; it is a gate that leads nowhere, which is a bug.
 *
 * So the reserved band, not the carriageway, is what changes: **40 m on the processional rank
 * and 22 m on the arterial**. The road ranks themselves are untouched at 20 / 12 / 7 / 4 —
 * §7.2's numbers stand, the paving a player sees is the same width, and the extra is
 * threshold, setback and awning ground, which a Punic street front had. §7.2 already calls
 * the 20 m rank "the game's minimum for a formed unit … stated as a compromise"; this is what
 * finishes the compromise, and it buys the one thing Appian's geography needs — a route from
 * the Porta Byrsae down the Tunis road to the forum and on along the harbour road, wide
 * enough for a formed body the whole way.
 *
 * The cost is measured and it is the trade this file is willing to make: 1.2 km of
 * processional and 5.4 km of arterial way, so about 4 ha of roof.
 */
export const PUNIC_FRONTAGE: Readonly<Record<WayClass, number>> = {
  /** 20 + 2 × 10 = 40 m reserved: a 35 m cohort with 2.5 m of play either side. */
  artery: 10,
  /** 12 + 2 × 5 = 22 m reserved: a 16 m column with 3 m either side. */
  secondary: 5,
  /** A 7 m local street takes a file and a laden mule. Unchanged, and it is meant to bind. */
  local: 1.4,
  vicus: 0.8,
};

export interface PunicWay {
  id: string;
  cls: WayClass;
  width: number;
  paved: boolean;
  /** Stepped streets cannot take wheels or engines and break a formation's coherence. */
  stepped?: boolean;
  path: { x: number; z: number }[];
}

const pt = (x: number, z: number): { x: number; z: number } => ({ x, z });

/** Cityward offset of the military way's centreline from the circuit line. §7.5's 35 m. */
const MILITARY_WAY_OFFSET = 20;

/**
 * The nearest *solid* monument containing a point, or null.
 *
 * **Solid only, and the first revision's bug is the argument.** Testing every monument sent
 * `via-navalis` off the merchant harbour's own quay — the quay belt is inside the harbour's
 * reserved rectangle, and the quay is exactly where a harbour road belongs. A road across a
 * forum, along a quay or through a precinct is a road doing its job; a road through a
 * cistern block is not.
 */
function insideMonument(x: number, z: number, pad = 0): Monument | null {
  for (const m of MONUMENTS) {
    if (!m.solid) continue;
    const cs = Math.cos(m.rot);
    const sn = Math.sin(m.rot);
    const dx = x - m.x;
    const dz = z - m.z;
    if (Math.abs(dx * cs + dz * sn) <= m.hw + m.clear + pad
      && Math.abs(-dx * sn + dz * cs) <= m.hd + m.clear + pad) return m;
  }
  return null;
}

/**
 * Deflect a path's vertices out of any monument they land in.
 *
 * **Endpoints included, which the first revision got wrong.** Skipping them let
 * `via-navalis` start inside the naval harbour and score 47% of its length through solid,
 * which is precisely the Roman failure this plan exists to avoid — arriving by a different
 * route, but arriving.
 */
function deflect(path: { x: number; z: number }[], pad = 2): { x: number; z: number }[] {
  return path.map((p) => {
    const hit = insideMonument(p.x, p.z, pad);
    if (!hit) return p;
    const cs = Math.cos(hit.rot);
    const sn = Math.sin(hit.rot);
    const dx = p.x - hit.x;
    const dz = p.z - hit.z;
    const u = dx * cs + dz * sn;
    const v = -dx * sn + dz * cs;
    const needU = hit.hw + hit.clear + pad - Math.abs(u);
    const needV = hit.hd + hit.clear + pad - Math.abs(v);
    const su = u >= 0 ? 1 : -1;
    const sv = v >= 0 ? 1 : -1;
    if (needU < needV) {
      const nu = u + su * needU;
      return pt(hit.x + nu * cs - v * sn, hit.z + nu * sn + v * cs);
    }
    const nv = v + sv * needV;
    return pt(hit.x + u * cs - nv * sn, hit.z + u * sn + nv * cs);
  });
}

/** Where the three streets meet the citadel: the enceinte's landward (−x) gate. §5.2. */
export const BYRSA_GATE = { x: BYRSA.x - BYRSA.summitHw - 4, z: BYRSA.z } as const;

/**
 * The named armature.
 *
 * Ten ways. Rome carries twenty-two on a comparable frontage because it is a city of
 * monumental viae; Carthage's monumental network was smaller and its grain much finer, and
 * the fine grain is generated per-quarter on the cubit module in `fabric.ts`.
 */
export const PUNIC_WAYS: readonly PunicWay[] = (() => {
  const ways: PunicWay[] = [];

  // 1. The military way behind the main wall. §7.5. Arterial, not processional: 35 m of
  //    clear ground with a 12 m metalled strip down it is what a relief column uses, and
  //    the rest is where a counter-attack forms up.
  {
    const path: { x: number; z: number }[] = [];
    for (let x = CIRCUIT_X_MIN + 12; x <= CIRCUIT_X_MAX - 12; x += 70) {
      path.push(pt(x, circuitZAt(x) + MILITARY_WAY_OFFSET));
    }
    ways.push({ id: 'via-sagularis', cls: 'secondary', width: PUNIC_WAY_WIDTH.secondary, paved: false, path });
  }

  // 2. The Tunis road: Porta Byrsae straight to the forum. §4.5 — the only gate a ram can
  //    reach across firm ground, and therefore the axis the whole isthmus assault is about.
  //    Processional, 20 m: the game's minimum for a formed unit, stated as a compromise
  //    exactly as Rome's 42 is.
  ways.push({
    id: 'via-tunetana', cls: 'artery', width: PUNIC_WAY_WIDTH.artery, paved: true,
    path: deflect([
      pt(0, circuitZAt(0) - 10),
      pt(0, buildLineZAt(0) + 6),
      pt(-20, 660),
      pt(-60, 800),
      pt(-120, 920),
      pt(FORUM.x, FORUM.z - FORUM.hd - 22),
    ]),
  });

  // 3. The harbour road: the forum to the cothon. §7.6 — the stretch Scipio covered between
  //    taking the ring of the circular harbour and taking the forum. Processional, because
  //    it is the one other place on the map two formed bodies can meet.
  ways.push({
    id: 'via-portus', cls: 'artery', width: PUNIC_WAY_WIDTH.artery, paved: true,
    path: deflect([
      pt(FORUM.x - FORUM.hw - 16, FORUM.z),
      pt(-350, 958),
      // South of the merchant basin's water, on open ground behind its landward quay.
      pt(-440, 916),
      pt(-620, 906),
      pt(-760, 888),
      // Onto the cothon's ring quay — between the outer basin wall at r 162.5 and the quay's
      // outer edge at r 182.5. Running at any smaller radius would put the road through the
      // ship sheds, which are geometry and not solids and would therefore not be caught.
      pt(-880, 840),
      pt(COTHON.x, COTHON.z - COTHON.outerR - 10),
    ]),
  });

  // 4. The Taenia road: Porta Maritima down to the harbour quarter. The route Scipio actually
  //    used — cheap to reach, and everything past it is street fighting. §8.3.
  //
  //    **It starts at the gate the wall actually built, not at the one the spec drew.** §4.5
  //    puts the Porta Maritima at x ≈ −760; `carthageWall.ts` places its gatehouses on bay
  //    centres 90 m inside the anchors and lands it at −560. A road that began 200 m from its
  //    own gate is the same class of error as a way projected against a monument that then
  //    moved, which is what this plan's order of operations exists to prevent.
  {
    const gx = CIRCUIT_GATES.find((g) => g.id === 'porta-maritima')!.x;
    ways.push({
      id: 'via-taeniae', cls: 'secondary', width: PUNIC_WAY_WIDTH.secondary, paved: false,
      path: deflect([
        pt(gx, circuitZAt(gx) - 8),
        pt(gx, buildLineZAt(gx) + 6),
        pt(gx - 60, 700),
        pt(-860, 800),
        pt(-900, 830),
      ]),
    });
  }

  // 5. The Utica road: Porta Uticensis into the Megara's gardens. §8.9 — a different battle
  //    behind a different gate.
  ways.push({
    id: 'via-uticensis', cls: 'secondary', width: PUNIC_WAY_WIDTH.secondary, paved: false,
    path: deflect([
      pt(560, circuitZAt(560) - 8),
      pt(560, buildLineZAt(560) + 6),
      pt(540, 660),
      pt(470, 800),
      pt(360, 900),
      pt(240, 960),
      pt(120, 990),
      pt(BYRSA.x + BYRSA.baseHw + 22, 1010),
    ]),
  });

  // 6. The ring at the Byrsa's foot. Arterial: this is where a besieger who has taken the
  //    lower town fights, and where the terraced housing revets against the hill.
  {
    const path: { x: number; z: number }[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      path.push(pt(
        BYRSA.x + Math.cos(a) * (BYRSA.baseHw + 18),
        BYRSA.z + Math.sin(a) * (BYRSA.baseHd + 18)
      ));
    }
    ways.push({ id: 'via-circa-byrsam', cls: 'secondary', width: PUNIC_WAY_WIDTH.secondary, paved: false, path });
  }

  // 7-9. **The three streets from the forum to the Byrsa.** Appian: six days and nights, both
  //      sides lined with six-storey houses, Romans crossing roof to roof on planks. They run
  //      up the hill's south-east face, predominantly in +x, which is the map's *less*
  //      compressed axis. 6 m and stepped: even the real 14% could not be walked in
  //      formation and the built 26% certainly cannot, so a cohort arrives at the top as a mob.
  {
    const zOff = [-42, 0, 44];
    for (let i = 0; i < 3; i++) {
      ways.push({
        id: `via-ad-byrsam-${i + 1}`, cls: 'local', width: STEPPED_STREET_WIDTH, paved: false,
        stepped: true,
        path: [
          pt(FORUM.x + FORUM.hw + 6, FORUM.z + zOff[i]),
          pt(-140, BYRSA.z + zOff[i] * 0.8),
          pt(BYRSA.x - BYRSA.baseHw + 20, BYRSA.z + zOff[i] * 0.5),
          // Stop at the citadel's reserved edge. The enceinte gate and the sixty steps take
          // over from here, and a street that ran on into the platform would be a street
          // through 45 m of masonry.
          pt(BYRSA.x - BYRSA.citadelHw - 13, BYRSA.z + zOff[i] * 0.18),
        ],
      });
    }
  }

  // 10. The sea-gate street. §4.5 [ARCH]: a 9 m street runs to the Magon-quarter sea gate at
  //     (x +150, z 1200) — one of the few things archaeology found that Appian does not
  //     mention, and the widest attested street in the Punic city.
  ways.push({
    id: 'via-portae-maris', cls: 'secondary', width: 9, paved: true,
    path: deflect([
      pt(150, 1200), pt(150, 1120), pt(120, 1050), pt(BYRSA.x + BYRSA.baseHw + 20, 1010),
    ]),
  });

  // 11. The inner lateral street, 110 m behind the circuit and parallel to it.
  /**
   * **The second street a formation can use across the whole city, and the map had one.**
   *
   * Measured with `probe-carthage`: filling the housing in took a 16 m column from 160 to
   * 136 hectares of reachable walled ground, and the cause was structural rather than
   * incidental. A column needs 16 m of clear width; the fabric's own network is 7 m locals
   * and 4 m lanes by construction (§7.2, and that is the map's infantry mechanic), so the
   * only ground a column can cross is a named way or open plain. Filling the plain therefore
   * removes its network, and the eleven named ways ran mostly *into* the city rather than
   * across it.
   *
   * `via-sagularis` is the lateral street behind the wall; this is the one 110 m further in,
   * which is what any walled city has — a back street serving the quarters the military way
   * only skirts. It runs the circuit's own curve at a fixed offset, so it stays parallel to
   * the wall for its whole 1.8 km rather than diverging at the ends the way a straight line
   * would on a wall that leans 121 m.
   *
   * [GAME], like every other rank above `local`; §7.2's evidence stops at 9 m.
   */
  {
    const path: { x: number; z: number }[] = [];
    for (let x = CIRCUIT_X_MIN + 90; x <= CIRCUIT_X_MAX - 110; x += 60) {
      path.push(pt(x, circuitZAt(x) + 110));
    }
    ways.push({
      id: 'via-interior', cls: 'secondary', width: PUNIC_WAY_WIDTH.secondary, paved: false,
      path: deflect(path),
    });
  }

  // 12. The shore road, north from the sea gate to the Bordj Djedid quarter.
  /**
   * **Added because a quarter with no named way through it is unreachable by a formation.**
   *
   * Filling the coastal strip with housing (`magon-shore`, `bordj-djedid`) cost a 16 m column
   * 12 hectares of reachable walled ground, and the cause was not the houses — it was that
   * the only streets there were the fabric's own 7 m locals and 4 m lanes, neither of which
   * admits a column. Deleting the housing bought the reach back; so does one road, at about a
   * hectare of roof instead of six, which is the better trade and is the reason this way
   * exists.
   *
   * It is also the road the archaeology implies. §4.6 records an excavated seaward rampart
   * running "between the Bay of Kram and Bordj Djedid" — a wall on the shore has a way behind
   * it — and §4.5's attested sea gate at (x +150, z 1200) is where this begins, so the chain
   * from the Porta Uticensis runs Utica road → sea-gate street → shore road → Bordj Djedid
   * without a formation ever having to use a 7 m street.
   */
  ways.push({
    id: 'via-litoralis', cls: 'secondary', width: PUNIC_WAY_WIDTH.secondary, paved: false,
    path: deflect([
      pt(150, 1200), pt(330, 1240), pt(520, 1288), pt(720, 1330), pt(900, 1372),
    ]),
  });

  // 13. The quay circuit round the merchant harbour, joining the warehouses and the quay-fort.
  /**
   * The quay circuit, laid **on** the harbour's quay belts rather than deflected off them.
   *
   * §6.2 gives 15 m of quay west and north and 25 m east; a 10 m carriageway with its kerbs
   * fits the 15 m belts with 2.5 m either side. The centrelines are computed from the same
   * constants `harbour.ts` builds the paving from, so the two cannot drift apart.
   */
  {
    const mh = MERCHANT_HARBOUR;
    const westX = mh.x - mh.hw - mh.quayWest * 0.5;
    const eastX = mh.x + mh.hw + mh.quayWest * 0.5;
    const seaZ = mh.z + mh.hd + mh.quayEast * 0.5;
    const landZ = mh.z - mh.hd - mh.quayWest * 0.5;
    ways.push({
      id: 'via-navalis', cls: 'secondary', width: 10, paved: true,
      path: [
        pt(eastX, landZ), pt(eastX, seaZ), pt(westX, seaZ), pt(westX, landZ), pt(eastX, landZ),
      ],
    });
  }

  return ways;
})();

// ---------------------------------------------------------------------------
// Quarters
// ---------------------------------------------------------------------------

export type QuarterKind = 'megara' | 'insulae' | 'terrace' | 'harbourside';

export interface Quarter {
  id: string;
  name: string;
  kind: QuarterKind;
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  /** 0..1 how tightly packed. */
  density: number;
  /** Mean storeys. §7.3: 4-6 in the city, six on the three streets, 2-4 by the harbour. */
  storeys: number;
  fray: number;
  /** Grid bearing, radians, relative to the quarter's own frame. */
  grid: number;
  /**
   * Bays of `INSULA_FACE` along the street per block. 1 is the excavated module; the
   * harbour quarter's warehouse ranges take 2 and 3.
   */
  bays: number;
  /**
   * Block size override, metres, for anything that is not a Punic insula.
   *
   * **The Megara needs this and the first revision did not have it.** §7.7 puts its field
   * enclosures on a 40-70 m grid; built out of 30.9 × 15.45 m insulae the garden suburb came
   * out looking like a housing estate in the plan view, which is the opposite of what it is
   * for. Everything residential leaves this undefined and gets the cubit module.
   */
  blockFace?: number;
  blockDepth?: number;
}

/**
 * The quarters.
 *
 * §7.7's Megara is first and is the single most gameplay-relevant entry. The northern half of
 * the walled area — x +250 to +1100, z 520 to 1000 — was not streets and insulae but market
 * gardens, orchards, hedges, ditches and scattered villas. Scipio broke into it by night in
 * 147 and the Romans found the enclosures harder going than the wall.
 *
 * It earns its place three times over: an attacker over the north end of the wall arrives in
 * a chequerboard where a formation cannot hold its line; it gives a formation coming off a
 * stair somewhere to *be* without giving it somewhere to march; and it is scatter and low
 * walls rather than buildings, so it costs almost nothing.
 */
export const QUARTERS: readonly Quarter[] = [
  /**
   * **The Megara stops at z 1010, and that is §7.7 rather than a taste.**
   *
   * §7.7 puts the garden suburb at "x +250 to +1100, **z 520 to 1000**". The first revision
   * ran `megara-east` out to z 1210, and with `megara-north` beside it the three garden
   * quarters claimed **51.9 of the city's 120.8 buildable hectares** — 43 % of it — at about
   * 13 % roof. A land census is what found this: the strip beyond z 1010 is the **coast**,
   * not the gardens. §2.5 surveys the Bordj Djedid shore at (x +250, z 1106); §4.6 records
   * the excavated seaward rampart running "between the Bay of Kram and Bordj Djedid"; §7.1
   * puts the Magon quarter on the seafront with 3 m streets and one exceptional 9 m street to
   * its sea gate. So the coastal strip carries housing, and `magon-shore` and `bordj-djedid`
   * below are that strip.
   *
   * Note what is deliberately *not* going on the ridge. §3.3 labels it "Odeon / north ridge",
   * and a previous revision of `topography.ts` told future agents the ridge "carried the Odeon
   * on its summit". **The Odeon of Carthage is Severan, c. AD 200** — three hundred and fifty
   * years after this map's moment. The ridge gets Punic houses and no concert hall.
   */
  {
    id: 'megara-north', name: 'The Megara, northern gardens', kind: 'megara',
    x: 850, z: 700, hw: 240, hd: 205, rot: 0.02, density: 0.34, storeys: 1.4, fray: 0.5,
    grid: 0.02, bays: 1, blockFace: 58, blockDepth: 42,
  },
  {
    id: 'megara-central', name: 'The Megara, orchards', kind: 'megara',
    x: 470, z: 700, hw: 170, hd: 205, rot: -0.02, density: 0.32, storeys: 1.4, fray: 0.5,
    grid: -0.02, bays: 1, blockFace: 52, blockDepth: 44,
  },
  {
    id: 'megara-east', name: 'The Megara, the eastern estates', kind: 'megara',
    x: 730, z: 1000, hw: 300, hd: 105, rot: 0.01, density: 0.26, storeys: 1.5, fray: 0.55,
    grid: 0.01, bays: 1, blockFace: 66, blockDepth: 48,
  },
  {
    id: 'quarter-north', name: 'The northern quarter', kind: 'insulae',
    x: 175, z: 715, hw: 170, hd: 155, rot: 0.02, density: 0.84, storeys: 3.6, fray: 0.26,
    grid: 0.02, bays: 1,
  },
  /**
   * The inner quarter, and the general correction the census forced on all four of these.
   *
   * A quarter is authored as a rectangle and the buildable land is a band between the
   * military way and the shore whose near edge moves 60 m with x and steps to 70 m deep over
   * every stair apron. Four quarters were centred **on the pomerium's edge** rather than
   * inside it, so a third of their candidate rows fell in the reserved strip and were
   * refused: `quarter-inner` lost 73, `quarter-west` 85, `quarter-north` 28. Moving the
   * centres cityward and trimming `hd` to match costs no ground — the ground was never
   * available — and it stops the rejection ledger being dominated by a boundary that is
   * doing its job.
   */
  {
    id: 'quarter-inner', name: 'The inner quarter', kind: 'insulae',
    x: -310, z: 712, hw: 300, hd: 128, rot: -0.02, density: 0.86, storeys: 3.8, fray: 0.24,
    grid: -0.02, bays: 1,
  },
  {
    id: 'quarter-west', name: 'The western quarter', kind: 'insulae',
    x: -700, z: 790, hw: 250, hd: 150, rot: 0.03, density: 0.84, storeys: 3.4, fray: 0.28,
    grid: 0.03, bays: 1,
  },
  /**
   * The lower town, moved off the merchant basin.
   *
   * At (−430, 990) with `hd` 92 it stood inside x −700..−380, z 935..1085, which is the
   * water: **34 of its 56 candidate cells drowned** and the densest quarter on the map built
   * three houses. The basin was authored first and the quarter was never authored against it.
   */
  {
    id: 'quarter-lower', name: 'The lower town', kind: 'insulae',
    x: -325, z: 950, hw: 105, hd: 92, rot: 0, density: 0.88, storeys: 4.2, fray: 0.2,
    grid: 0, bays: 1,
  },
  /**
   * The Hannibalic quarter on the Byrsa's south-east slope. §7.1, §5.2.
   *
   * The best-documented Punic urbanism there is and the signature of this city's grain: an
   * orthogonal grid of 15.5 × 31 m insulae on beaten-earth streets of 5-7 m, the long axis
   * along the contour so each block steps down one terrace to the next, houses about a small
   * courtyard with a cistern under it. Under it — literally, in the stratigraphy — are
   * metalworkers' workshops, so the lower part of the slope is industry, not housing.
   */
  /**
   * **These three were 88 × 92 m and their own streets deleted them.**
   *
   * `hannibal-quarter` placed **0 blocks of 8 candidate cells**, seven refused by the
   * keep-out; `byrsa-approach` placed **0 of 6**, all six refused by the keep-out. Between
   * them they carry the two things this map is for — Lancel's excavated grid and Appian's six
   * days up the three streets — and neither existed in the built city.
   *
   * The cause is arithmetic, not taste. Three stepped streets 6 m wide reserve 8.8 m each
   * with their frontage; `via-circa-byrsam` reserves 17 m; the citadel reserves 88 × 58 m. A
   * quarter two bays wide and four rows deep has eight cells and every one of them touches
   * something. Enlarging them does not weaken the reservations — the streets still cut
   * exactly where they cut — it gives the lattice enough cells that the strips *between* the
   * streets survive. Which is the thing Appian describes: houses lining the streets on both
   * sides, not a district with streets through it.
   */
  {
    id: 'hannibal-quarter', name: 'The Hannibalic Quarter', kind: 'terrace',
    x: -150, z: 1032, hw: 92, hd: 72, rot: 0, density: 0.94, storeys: 4.6, fray: 0.06,
    grid: 0, bays: 1,
  },
  /** The tall ranges hard on the kerb of the three streets. Appian's six storeys. */
  {
    id: 'byrsa-approach', name: 'The Byrsa approach', kind: 'terrace',
    x: -148, z: 900, hw: 74, hd: 70, rot: 0, density: 0.92, storeys: 6, fray: 0.05,
    grid: 0, bays: 1,
  },
  {
    id: 'byrsa-foot', name: 'The foot of the Byrsa', kind: 'terrace',
    x: -320, z: 900, hw: 88, hd: 78, rot: 0, density: 0.9, storeys: 5.2, fray: 0.12,
    grid: 0, bays: 1,
  },
  {
    id: 'quarter-east-byrsa', name: 'The quarter east of the Byrsa', kind: 'insulae',
    x: 262, z: 935, hw: 158, hd: 125, rot: 0.01, density: 0.86, storeys: 3.6, fray: 0.22,
    grid: 0.01, bays: 1,
  },
  /**
   * §7.3: the Magon quarter and the harbour district, 2-4 storeys, workshops and stores.
   *
   * §4.5 [ARCH] puts the sea gate at (x +150, z 1200) with a 9 m street running to it — the
   * widest attested street in the Punic city and one of the few things archaeology found that
   * Appian does not mention. The quarter is sized so that street runs through fabric rather
   * than across open ground.
   */
  {
    id: 'magon-quarter', name: 'The Magon Quarter', kind: 'insulae',
    x: 140, z: 1120, hw: 170, hd: 96, rot: 0.03, density: 0.78, storeys: 2.8, fray: 0.3,
    grid: 0.03, bays: 1,
  },
  /**
   * The seafront north of the Magon quarter, running up to the Bordj Djedid shore.
   *
   * The land census found **12.7 unclaimed hectares inside the build line and nearly all of
   * it here** — a coastal triangle from x +250 to the map's north-east that no quarter
   * touched and the Megara's fray happened to overlap. §2.5 surveys Bordj Djedid at
   * (x +250, z 1106) and the coast leaves the map at (x +540, z 1331), so this is the strip
   * between the gardens and the sea. 3 storeys: it is a shore quarter, not the Byrsa.
   */
  {
    id: 'magon-shore', name: 'The seafront north of the Magon Quarter', kind: 'insulae',
    x: 375, z: 1190, hw: 195, hd: 120, rot: 0.02, density: 0.78, storeys: 2.8, fray: 0.3,
    grid: 0.02, bays: 1,
  },
  {
    id: 'bordj-djedid', name: 'The Bordj Djedid shore', kind: 'insulae',
    x: 770, z: 1245, hw: 270, hd: 150, rot: 0.02, density: 0.72, storeys: 2.6, fray: 0.34,
    grid: 0.02, bays: 1,
  },
  {
    id: 'harbourside', name: 'The harbour quarter', kind: 'harbourside',
    x: -285, z: 1075, hw: 125, hd: 58, rot: 0, density: 0.74, storeys: 2.6, fray: 0.3,
    grid: 0, bays: 2,
  },
  /**
   * Salammbô — the Tophet's own district, on the Taenia between the lake and the harbours.
   *
   * A second entry, `quarter-salammbo` "The Salammbô shore", used to stand at (−820, 1150)
   * and built **nothing**: `shoreZAt(−820)` is 1069, so the whole quarter lay in the Gulf of
   * Tunis and all 34 of its in-mask cells were refused as out of bounds. It has been retired
   * rather than moved, because there is no room for it — the cothon's reserved circle runs
   * x −1112..−748 and the merchant basin x −700..−380, so between the harbours and the sea
   * there is quay and water and nothing else. The name belongs to this quarter, which is
   * where the Tophet is.
   */
  {
    id: 'tophet-quarter', name: 'The Salammbô quarter', kind: 'insulae',
    x: -1190, z: 800, hw: 155, hd: 150, rot: 0.02, density: 0.7, storeys: 2.6, fray: 0.32,
    grid: 0.02, bays: 1,
  },
];

export { CIRCUIT_GATES, CIRCUIT_X_MAX, CIRCUIT_X_MIN, buildLineZAt, circuitZAt, shoreZAt };
