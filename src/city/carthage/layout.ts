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
 * `topography.ts` already does exactly this at Rome, where `RISE_RUN = 175` is a chosen world
 * number and not a projected one.
 */
export const BYRSA = {
  /** The survey origin. §2.5. */
  x: 0,
  z: 945,
  /**
   * World footprint at the 20 m contour. §5.1a — overridden, not projected.
   *
   * 340 in x is the spec's figure. **236 in z rather than its 200**, and the reason is the
   * spec's own cap: §5.1 says the north and west slopes must stay at 1:2 or shallower so
   * they remain climbable in loose order. At 200 the west face is 100 m of run for 45 m of
   * rise, 1:2.2 measured to the centre but 1:1.6 measured to the summit plateau's real edge —
   * a scarp, not a slope. 236 puts it at 1:2.0 against the plateau. The x face is unchanged.
   */
  baseHw: 170,
  baseHd: 118,
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
   */
  relief: 45,
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
  // Real position (e −71, n −1645) is south of both harbours, on the Taenia side.
  {
    id: 'tophet', name: 'The Tophet of Salammbô', kind: 'tophet',
    x: -1150, z: 950, hw: 62, hd: 44, rot: 0.06, clear: 10, solid: false,
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
 * Rome runs 42 / 24 / 14 / 8 m, and `layout.ts` concedes in its own comment that a real
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

/** Frontage margin kept clear beyond the carriageway. Punic thresholds, not Roman porticoes. */
export const PUNIC_FRONTAGE: Readonly<Record<WayClass, number>> = {
  artery: 3.5,
  secondary: 2.5,
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
  ways.push({
    id: 'via-taeniae', cls: 'secondary', width: PUNIC_WAY_WIDTH.secondary, paved: false,
    path: deflect([
      pt(-760, circuitZAt(-760) - 8),
      pt(-760, buildLineZAt(-760) + 6),
      pt(-800, 700),
      pt(-860, 800),
      pt(-900, 830),
    ]),
  });

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

  // 11. The quay circuit round the merchant harbour, joining the warehouses and the quay-fort.
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
  {
    id: 'megara-north', name: 'The Megara, northern gardens', kind: 'megara',
    x: 760, z: 690, hw: 330, hd: 190, rot: 0.02, density: 0.34, storeys: 1.4, fray: 0.5,
    grid: 0.02, bays: 1, blockFace: 58, blockDepth: 42,
  },
  {
    id: 'megara-central', name: 'The Megara, orchards', kind: 'megara',
    x: 400, z: 700, hw: 240, hd: 205, rot: -0.02, density: 0.32, storeys: 1.4, fray: 0.5,
    grid: -0.02, bays: 1, blockFace: 52, blockDepth: 44,
  },
  {
    id: 'megara-east', name: 'The Megara, the eastern estates', kind: 'megara',
    x: 720, z: 1060, hw: 300, hd: 150, rot: 0.01, density: 0.26, storeys: 1.5, fray: 0.55,
    grid: 0.01, bays: 1, blockFace: 66, blockDepth: 48,
  },
  {
    id: 'quarter-north', name: 'The northern quarter', kind: 'insulae',
    x: 220, z: 655, hw: 180, hd: 150, rot: 0.02, density: 0.84, storeys: 3.6, fray: 0.26,
    grid: 0.02, bays: 1,
  },
  {
    id: 'quarter-inner', name: 'The inner quarter', kind: 'insulae',
    x: -300, z: 665, hw: 300, hd: 165, rot: -0.02, density: 0.86, storeys: 3.8, fray: 0.24,
    grid: -0.02, bays: 1,
  },
  {
    id: 'quarter-west', name: 'The western quarter', kind: 'insulae',
    x: -680, z: 700, hw: 250, hd: 205, rot: 0.03, density: 0.84, storeys: 3.4, fray: 0.28,
    grid: 0.03, bays: 1,
  },
  {
    id: 'quarter-lower', name: 'The lower town', kind: 'insulae',
    x: -430, z: 990, hw: 130, hd: 92, rot: 0, density: 0.88, storeys: 4.2, fray: 0.2,
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
  {
    id: 'hannibal-quarter', name: 'The Hannibalic Quarter', kind: 'terrace',
    x: -126, z: 1018, hw: 44, hd: 46, rot: 0, density: 0.94, storeys: 4.6, fray: 0.06,
    grid: 0, bays: 1,
  },
  /** The tall ranges hard on the kerb of the three streets. Appian's six storeys. */
  {
    id: 'byrsa-approach', name: 'The Byrsa approach', kind: 'terrace',
    x: -128, z: 898, hw: 42, hd: 44, rot: 0, density: 0.92, storeys: 6, fray: 0.05,
    grid: 0, bays: 1,
  },
  {
    id: 'byrsa-foot', name: 'The foot of the Byrsa', kind: 'terrace',
    x: -250, z: 872, hw: 96, hd: 62, rot: 0, density: 0.9, storeys: 5.2, fray: 0.12,
    grid: 0, bays: 1,
  },
  {
    id: 'quarter-east-byrsa', name: 'The quarter east of the Byrsa', kind: 'insulae',
    x: 250, z: 930, hw: 130, hd: 105, rot: 0.01, density: 0.86, storeys: 3.6, fray: 0.22,
    grid: 0.01, bays: 1,
  },
  {
    id: 'quarter-salammbo', name: 'The Salammbô shore', kind: 'insulae',
    x: -820, z: 1150, hw: 130, hd: 70, rot: 0.02, density: 0.7, storeys: 2.4, fray: 0.34,
    grid: 0.02, bays: 1,
  },
  /** §7.3: the Magon quarter and the harbour district, 2-4 storeys, workshops and stores. */
  {
    id: 'magon-quarter', name: 'The Magon Quarter', kind: 'insulae',
    x: 150, z: 1120, hw: 140, hd: 76, rot: 0.03, density: 0.74, storeys: 2.8, fray: 0.3,
    grid: 0.03, bays: 1,
  },
  {
    id: 'harbourside', name: 'The harbour quarter', kind: 'harbourside',
    x: -290, z: 1090, hw: 100, hd: 44, rot: 0, density: 0.7, storeys: 2.6, fray: 0.3,
    grid: 0, bays: 3,
  },
  {
    id: 'tophet-quarter', name: 'The Salammbô quarter', kind: 'insulae',
    x: -1080, z: 790, hw: 220, hd: 165, rot: 0.02, density: 0.7, storeys: 2.6, fray: 0.32,
    grid: 0.02, bays: 1,
  },
];

export { CIRCUIT_GATES, CIRCUIT_X_MAX, CIRCUIT_X_MIN, buildLineZAt, circuitZAt, shoreZAt };
