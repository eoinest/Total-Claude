/**
 * The ground of Carthage, spring 146 BC, as analytic functions.
 *
 * Built to `docs/CARTHAGE.md`. Section references below are to that document; where this file
 * departs from it, the departure is named and argued at the point it happens.
 *
 * ---------------------------------------------------------------------------
 * THE FRAME (§2.2)
 * ---------------------------------------------------------------------------
 *
 *     map −Z = true WEST   the isthmus, the only land approach, where the attacker deploys
 *     map +Z = true EAST   the Gulf of Tunis; the defender's back is to the sea
 *     map +X = true NORTH  the Sebkhet Ariana, a salt pan
 *     map −X = true SOUTH  the Lake of Tunis, and the Taenia running along it
 *
 * Rome's map has −Z = north. This one is rotated 90° anticlockwise from that and has to be:
 * `scenario.ts` deploys the attacker at z −190 and Carthage can only be attacked from the
 * west. Both ends of the land wall die on water, so there is no flank march on this map.
 *
 * **One consequence has to be stated because it cannot be fixed here.** `SiteAstronomy` gives
 * `atmosphere.ts` a latitude and a declination and it computes a true compass bearing for the
 * sun — but the engine plants bearing 0 at map −Z, which on this map is west, not north. So
 * the sun's *elevation* and the shape of its arc are physically right and its *compass
 * direction* is 90° out. Nothing in a rendered frame can tell: there is no compass, no shadow
 * of a known-oriented object, and the only thing that matters optically is that the sun is
 * broadside to the ±Z viewing axis, which at the default hour it is (map bearing 272.6°).
 * Fixing it properly needs a bearing offset on `SiteAstronomy`, which is `src/render/`.
 *
 * ---------------------------------------------------------------------------
 * THE PROJECTION (§2.3, §2.4)
 * ---------------------------------------------------------------------------
 *
 * Positions are authored in real metres from the summit of the Byrsa and projected. Getting
 * Carthage wrong should require getting the survey wrong, which is how `rome.ts` works.
 *
 *     x = KN · n              KN = 0.45   across the map, true north
 *     z = Z0 + KE · e         KE = 0.22   into the map, true east,  Z0 = 945
 *
 * **Positions compress. Cross-sections do not.** Every position, the length of the wall along
 * its own line, and the plan of the harbours go through the projection. Wall height and
 * thickness, ditch depth, tower footprint and spacing, street widths and storey heights do
 * not — they are true metres in world space.
 *
 * And a third category, which is where the rule bites: **anything whose *slope* matters
 * cannot take a compressed run against an uncompressed height.** There is exactly one such
 * thing in this file and it is the Byrsa; see `BYRSA_HW`.
 */

import { HALF_EXTENT } from '../../terrain/topography';

export { HALF_EXTENT };

/** Local smoothstep. Duplicated from `terrain/noise` so this module stays dependency-free. */
const sstepLocal = (edge0: number, edge1: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// The survey
// ---------------------------------------------------------------------------

/** Metres north per world x. §2.3. */
export const KN = 0.45;
/** Metres east per world z. §2.3 — the same value as Rome's `KZ`, so depth reads alike. */
export const KE = 0.22;
/** World z of the survey origin: the summit of the Byrsa. */
export const Z0 = 945;

/**
 * Project a survey position — metres east and north of the Byrsa summit — into world space.
 *
 * Exported because the wall and the fabric must use the *same* projection or the city will
 * not join up. Author a position as `worldOf(e, n)`; never write an x or a z by hand.
 */
export const worldOf = (e: number, n: number): { x: number; z: number } => ({
  x: KN * n,
  z: Z0 + KE * e,
});

/**
 * Sea level. Everything on this map is measured from it and the two lagoons sit on it.
 *
 * **There is no water surface mesh.** `RiverWater` is a ribbon built along the Tiber's
 * centreline and generalising it is a `src/terrain/` change. Water on this map is *terrain
 * below the datum, painted by the splat rules* — layers 3 and 4 in `ground.ts`. That is free
 * (no draw call, no reflection pass) and it is legible from any camera the battle uses,
 * because the nearest open water is 700 m beyond the wall and behind a 60 m hill.
 *
 * **What that means for the sim, which is the part nobody may assume.** Nothing in the
 * simulation knows what water is. A man will walk into the Gulf of Tunis unless something
 * stops him, and the two things that can are: a slope the pathfinder refuses
 * (`SLOPE_IMPASSABLE = 0.62` over its 7 m cell, so a 9 m fall in 14 m), or an obstacle box
 * from the city plan. `SHORE_SCARP` below is the first. The harbour basins are the second and
 * they belong to whoever builds the quays — a basin is a hole in the ground here, not a
 * fluid, and it must be published as `getObstacles()` boxes standing at quay level or units
 * will march across the naval harbour.
 */
export const SEA_LEVEL = 0;

// ---------------------------------------------------------------------------
// The three waters
// ---------------------------------------------------------------------------

/**
 * The east coast: the z at which the Gulf of Tunis begins, for each x. §3.6.
 *
 * A quadratic through the surveyed shore polyline. Residual against the seven published
 * points is under 45 m at the worst (x −540) and under 20 m over most of the span, which is
 * inside the ±400 m the spec allows itself for anything on this coast — and the points are
 * themselves modern shore, where the harbour quarter has prograded since antiquity.
 */
export const coastZ = (x: number): number => 1176 + 0.225 * x + 0.00006 * x * x;

/**
 * The Lake of Tunis: the x below which there is water, for each z. §2.2, §3.5.
 *
 * Anchored on the two surveyed points — the head of the lake at the wall's south anchor
 * (x −968, z 615) and its north shore at (x −1080, z 813) — and running on south-west out of
 * the map. The wall's south end dies here.
 */
export const lakeEdgeX = (z: number): number => {
  // A *finger*, not a coast running the whole −X edge. The lake reaches its furthest inland
  // at the wall's latitude and pulls back to the map edge north and south of it, which is
  // both the real shape of the lagoon's head and what leaves the attacker room: at the
  // deployment box (z −196, x ±490) there must be no water at all, or an army half-forms up
  // in a lake.
  const head = sstepLocal(250, 600, z) * (1 - sstepLocal(760, 1080, z));
  return -1400 + 432 * head + 26 * Math.sin((z + 300) * 0.00214) * head;
};

/**
 * The Sebkhet Ariana: the x above which the salt pan begins, for each z. §2.2, §3.3.
 *
 * **Not open water.** A seasonal evaporite pan at 0 to +1 m, dry crust in spring, walkable by
 * infantry and impossible for anything wheeled (§3.4). So it is *land* as far as the
 * pathfinder is concerned and it is a barrier only to the siege train, which is exactly the
 * decision §3.4 wants handed to the attacker. Its south edge is the surveyed (x +1103,
 * z 549); it opens out northward and eastward behind the wall's north anchor.
 */
export const arianaEdgeX = (z: number): number =>
  1096 + 140 * sstepLocal(700, 1150, z) - 52 * Math.sin((z - 200) * 0.00187);

/**
 * The Taenia — the sand tongue between the lake and the sea. §3.5.
 *
 * Appian's *ribbon*, the route Censorinus assaulted along in 149, and the map's second axis
 * of attack. It re-emerges as dry land *inside* the water mask on the −X side: a low sandy
 * bar 220 world metres wide running from the −X/−Z corner up in +z to the harbour district.
 *
 * Returns 1 on the crown of the bar and 0 off it.
 */
export const TAENIA_HALF = 150;
export const taeniaX = (z: number): number =>
  -1270 + 58 * Math.sin((z + 250) * 0.00171) + 22 * Math.sin((z - 600) * 0.0039);
export const taeniaNess = (x: number, z: number): number => {
  // Only between the map's south-west corner and the harbours: north of z 1000 the bar has
  // joined the city and there is no tongue any more.
  const along = sstepLocal(-680, -420, z) * (1 - sstepLocal(940, 1080, z));
  return along * (1 - sstepLocal(TAENIA_HALF * 0.6, TAENIA_HALF, Math.abs(x - taeniaX(z))));
};

/**
 * How far below the datum open water goes at the shore, and over what run.
 *
 * **This is a gameplay number, not a bathymetric one, and it is the only thing on the map
 * stopping an army walking into the Gulf of Tunis.** `Pathfinding` marks a cell impassable
 * above gradient 0.62 measured over its 7 m cell — a 9 m fall in 14 m — and nothing else in
 * the sim knows what water is. So the shore plunges 9.5 m in 12: steeper than a real
 * prograding sand coast, right for the wave-cut calcarenite at Bordj Djedid, and the
 * difference between a besieged city and an open beach.
 *
 * The Lake of Tunis gets the same treatment for the same reason and it is a franker fiction
 * there: the real lagoon is barely a metre deep and its margin is walkable salt marsh. The
 * marsh is modelled (see `LAKE_MARSH`); the drop past it is a wall the player must not be
 * able to walk round.
 */
const SHORE_SCARP_DEPTH = 9.5;
const SHORE_SCARP_RUN = 12;
/**
  * Width of walkable salt marsh inside the lake's edge, before the scarp.
  *
  * 35 m, not the 90 it started at. At 90 the marsh swallowed the whole head of the lake: the
  * gap between the lake's edge and the Taenia bar is only about 130 world metres at the wall's
  * latitude, so a 90 m marsh either side left no open water at all and the "head of the Lake
  * of Tunis" the wall's south anchor is supposed to die on measured **+0.8 m of walkable
  * ground**. The survey check caught it; nothing in a frame would have, because a salt marsh
  * and a salt lagoon look identical from a kilometre away and only the pathfinder can tell
  * the difference.
  */
const LAKE_MARSH = 35;

// ---------------------------------------------------------------------------
// The line of the land wall
// ---------------------------------------------------------------------------

/**
 * Centreline of the triple wall, as a z for each x. §4.1, §2.5.
 *
 * **This is the contract between the terrain and the wall geometry.**
 * `src/city/carthage/wall.ts` builds along it, the terrain grades a bench under it, the
 * scatter clears its glacis outside it, and the splat rules paint the killing ground. Four
 * consumers, one function, so none of them can drift.
 *
 * The quadratic passes exactly through the three surveyed anchors of §2.5 — the north anchor
 * on the Sebkhet Ariana (x +1013, z 494), the crossing at the Byrsa's latitude (x 0, z 527)
 * and the south anchor at the head of the Lake of Tunis (x −968, z 615). It is not
 * archaeologically located: §9 lists the line as reconstructed to ±400 real metres, so it may
 * be moved for play — but move it *here*, not in the wall builder, or four consumers
 * disagree.
 *
 * **The slope must stay bounded and the run must stay a function of x**, because
 * `CitySystem.bayAt` indexes bays arithmetically in x. Over the modelled span the line rises
 * 121 m across 1,981 m of x, a 6 % skew, which costs a bay 2 m of length at the ends.
 */
export const carthageWallZ = (x: number): number => 527 - 0.06241 * x + 2.945e-5 * x * x;

/** The wall's two anchors in x. Beyond them the land wall does not exist. §2.5. */
export const WALL_X_MIN = -968;
export const WALL_X_MAX = 1013;

/**
 * Half-width of the graded bench the terrain lays under the wall.
 *
 * 40 m carries the 9.1 m main wall, the middle wall, the earth rampart behind it and the
 * military way (§4.2) — the whole 30–35 m of defensive depth plus a working margin. Rome
 * needs no equivalent because its curtain stands on a natural crest; **Carthage's stands on
 * nothing (§3.1) and that flatness is the design**, so the bench levels the wall's footing
 * without raising it.
 */
export const WALL_BENCH_HALF = 40;

/**
 * How far out from the wall the ground is cleared and kept clear.
 *
 * A besieged city fells everything within bowshot. 50 m rather than the Campus Martius' 30
 * because this glacis has to hold a 20 m ditch as well, and because Carthage's countryside is
 * orchard: an olive at 30 m from a 16 m wall still puts its crown near the parapet.
 */
export const WALL_CLEAR_OUT = 50;

// ---------------------------------------------------------------------------
// The Byrsa
// ---------------------------------------------------------------------------

/** The survey origin, so the citadel sits at the middle of the map's x. §2.5. */
export const BYRSA_X = 0;
export const BYRSA_Z = Z0;

/** Summit, metres above the sea. §5.1 — published values run 50/57/60; the spec takes 60. */
export const BYRSA_SUMMIT = 60;

/**
 * **The one place the projection is overridden, and the arithmetic that says so.** §5.1a.
 *
 * Heights are not compressed and positions are, so every slope on this map comes out steeper
 * than it was. On the Byrsa that stops being a stylistic issue and becomes a bug:
 *
 *     real footprint at the 20 m contour   700 m E–W  ×  550 m N–S
 *     through the projection               0.22·700 = 154 m in z, 0.45·550 = 248 m in x
 *     relief, uncompressed                 45 m
 *     gradient into z                      45 / 77  = 1:1.7  (30°)
 *     gradient across x                    45 / 124 = 1:2.8  (20°)
 *     the real gradients                             1:7.8  and  1:6.1
 *
 * A 30° face is a cliff. The three stepped streets of §5.3 would be unbuildable, the terraced
 * housing would interpenetrate, and the six days it took to fight up them would be six days
 * of climbing a wall.
 *
 * So the footprint is set from the gradient we want rather than from the projection: **340 m
 * in x by 200 m in z at the 20 m contour**, giving 170 world metres of run for 45 m of rise
 * on the approach face — 1:3.8. That is 1.8× steeper than the real hill, which is the same
 * order of distortion Rome already accepts on its own rise, where `RISE_RUN = 175` is
 * likewise a chosen world number and not a projected one.
 *
 * **The 45 m is not compressed and must never be.** It is the reason the hill is here.
 */
const BYRSA_HW = 170;
const BYRSA_HD = 100;

/**
 * The Punic summit plateau, before the Romans cut several metres off it to lay the forum.
 *
 * 250 × 180 real metres (§5.1) through the projection: 55 m in z by 81 m in x. The plateau
 * *is* a position and a footprint, so unlike the slope it takes the projection honestly.
 */
const BYRSA_PLATEAU_HW = (0.45 * 180) / 2;
const BYRSA_PLATEAU_HD = (0.22 * 250) / 2;

/** Bordj Djedid: the Odeon ridge north-east of the citadel. §2.5, §3.3 — 40–50 m. */
const DJEDID_X = 210;
const DJEDID_Z = 1037;
const DJEDID_TOP = 45;

/**
 * An elliptical hill with a level top.
 *
 * Flat-topped rather than Gaussian because both of this map's hills carried buildings on
 * their summits — a temple precinct and a citadel enceinte on one, the Odeon on the other —
 * and a Gaussian leaves nowhere to put them. Returns an absolute height, or `-Infinity`
 * outside the hill's skirt so callers can `Math.max` hills together rather than summing
 * them: the Byrsa and Bordj Djedid overlap in plan, and summing would give a 105 m mountain.
 */
const hill = (
  x: number, z: number,
  cx: number, cz: number, hw: number, hd: number,
  plateauHw: number, plateauHd: number,
  top: number, skirtH: number,
): number => {
  const r = Math.hypot((x - cx) / hw, (z - cz) / hd);
  // Radius at which the plateau ends, in the same normalised units. The two axes give
  // slightly different answers; take the mean, which is what an ellipse of a different aspect
  // inscribed in this one comes to.
  const rPlateau = (plateauHw / hw + plateauHd / hd) * 0.5;
  if (r <= rPlateau) return top;
  // Down the face to the 20 m contour at r = 1, then out into a skirt that meets the
  // surrounding ground by r = 1.4 so the hill has a toe rather than an edge.
  if (r <= 1) return top + (20 - top) * sstepLocal(rPlateau, 1, r);
  /**
   * **Past the skirt this must return −Infinity, not the surrounding height.**
   *
   * It returned `skirtH` — which is `Math.max(h, 8)` — and the caller `Math.max`es hills into
   * the ground, so every point on the map more than 1.4 hill-radii from either summit came
   * back at 8 m: the Gulf of Tunis, the Lake of Tunis, the Sebkhet Ariana and the Taenia all
   * measured *exactly* 8.0, which is the shape of a number that cannot be true rather than a
   * value that is merely wrong. The whole sea was a plateau. `assertSurveyElevations` caught
   * it on the first run; nothing else would have, because from a battle camera at the wall it
   * looks like a hazy flat horizon either way.
   */
  if (r >= 1.4) return -Infinity;
  return 20 + (skirtH - 20) * sstepLocal(1, 1.4, r);
};

// ---------------------------------------------------------------------------
// The regional surface
// ---------------------------------------------------------------------------

/**
 * The isthmus, the city terrace, the two hills, the three waters — with no relief at all.
 *
 * The elevations are §3.3's table and they are checked at build time by
 * `assertSurveyElevations` in `heightfield.ts`, so a change here that moves the Byrsa or
 * drowns the harbours reports itself on the run that makes it rather than in a screenshot
 * three days later.
 *
 * This is the plane the deployment boxes flatten onto and the surface the wall bench is cut
 * from, so it has to be smooth and it has to be gentle across the attacker's frontage. Across
 * the ±490 m the siege line occupies at z −196 it falls 1.4 m — one in seven hundred.
 */
export const regionalLand = (x: number, z: number): number => {
  // 1. Longitudinal profile along the spine of the peninsula, west to east. §3.3.
  //    A low sandy neck outside the wall crowning at 12; the wall's own ground line at 10–14;
  //    the lower town behind it stepping up to 17.
  let crown = 6.5 + 5.8 * sstepLocal(-1400, 340, z);
  crown += 4.6 * sstepLocal(480, 830, z);

  // 2. Cross-profile inside the city: the harbour flat.
  //    The two basins sit at x −540 and −670 and the whole harbour district and the Taenia
  //    are 2–6 m (§3.3), against a lower town of 12–18 four hundred metres away. So the
  //    terrace falls away southward behind the wall, which is also why the harbours are where
  //    they are.
  const behindWall = sstepLocal(carthageWallZ(x) - 30, carthageWallZ(x) + 150, z);
  crown -= behindWall * 12.4 * sstepLocal(-250, -650, x);

  // 3. The two shores and the salt pan.
  const dLake = x - lakeEdgeX(z);
  const dCoast = coastZ(x) - z;
  const dAriana = arianaEdgeX(z) - x;
  // Ramp down to the water over a few hundred metres, as a scale on the crown so the land
  // meets the sea at the same height whatever the spine is doing.
  const toLake = 1 - sstepLocal(0, 300, dLake);
  const toCoast = 1 - sstepLocal(0, 220, dCoast);
  const toAriana = 1 - sstepLocal(0, 260, dAriana);
  const shore = Math.max(toLake, Math.max(toCoast, toAriana));
  let h = crown * (1 - 0.94 * shore);

  // 4. The scarp. Past the edge the ground plunges, and it plunges because the pathfinder has
  //    no other way to know that the sea is not a field. See `SHORE_SCARP_DEPTH`.
  //    The lake gets a strip of walkable salt marsh first: its margin really is marsh, the
  //    Taenia route runs along it, and dropping a cliff straight into a lagoon a metre deep
  //    would be a worse lie than the scarp already is.
  const intoLake = Math.max(0, -dLake - LAKE_MARSH);
  const intoCoast = Math.max(0, -dCoast);
  const into = Math.max(intoLake, intoCoast);
  if (into > 0) {
    h -= SHORE_SCARP_DEPTH * sstepLocal(0, SHORE_SCARP_RUN, into);
  }
  // The Ariana is a pan, not a sea: it flattens at the datum and stays walkable. §3.3.
  if (dAriana < 0) h = h * (1 - toAriana) + 0.6 * toAriana;

  // 5. The Taenia rises back out of the lake as a sand bar. §3.5.
  const tae = taeniaNess(x, z);
  if (tae > 0) h = Math.max(h, -0.5 + 4.2 * tae);

  // 6. The two hills, combined with `max` and not summed — they overlap in plan.
  const surrounding = Math.max(h, 8);
  h = Math.max(h, hill(x, z, BYRSA_X, BYRSA_Z, BYRSA_HW, BYRSA_HD,
    BYRSA_PLATEAU_HW, BYRSA_PLATEAU_HD, BYRSA_SUMMIT, surrounding));
  h = Math.max(h, hill(x, z, DJEDID_X, DJEDID_Z, 200, 130, 70, 40, DJEDID_TOP, surrounding));

  return h;
};

/**
 * How soft the ground is, 0 firm .. 1 impassable to anything wheeled. §3.4.
 *
 * Within roughly 300 real metres of either lagoon the ground is sabkha margin, salt marsh and
 * silt. The consequence is the best single decision this map hands the attacker on turn one:
 * **rams, towers and heavy artillery must go up the middle of the isthmus, where the wall is
 * strongest and where the defender knows they must come.** Infantry can still work the
 * margins.
 *
 * Published here and baked into the control texture's blue channel alongside trampling, so
 * that whoever implements the engine-placement rule reads one function rather than
 * re-deriving a margin. Nothing consumes it as a *mechanic* yet — §12 lists the soft-ground
 * rule as cross-cutting and unowned — but the terrain and the splat already honour it, so the
 * ground the player is being told is soft is the ground that looks soft.
 */
export const softGround = (x: number, z: number): number => {
  const nearLake = 1 - sstepLocal(0, 300, x - lakeEdgeX(z));
  const nearAriana = 1 - sstepLocal(0, 300, arianaEdgeX(z) - x);
  const onTaenia = taeniaNess(x, z) * 0.55;
  return Math.min(1, Math.max(Math.max(nearLake, nearAriana), onTaenia));
};

// ---------------------------------------------------------------------------
// Water in the countryside
// ---------------------------------------------------------------------------

/**
 * Centreline of the seasonal wadi draining the isthmus into the Lake of Tunis.
 *
 * A z for each x, running across the field rather than along it. Placed at z ≈ −430, which is
 * 240 m behind the siege line: from the opening camera it is the horizontal band *behind* the
 * Roman camp, which gives the middle distance a line and the frame a third depth layer. Cut
 * through the fighting ground it would only mean every clash happens in a ditch.
 */
export const wadiZ = (x: number): number =>
  -434 + 92 * Math.sin((x + 380) * 0.00112) + 37 * Math.sin((x - 540) * 0.00259 + 1.4);

/** Half-width of the gravel bed. A North African wadi is wide, shallow and dry most of the year. */
export const WADI_HALF_WIDTH = 19;

/** Cross-section: a broad flat-floored trough. 1.6 m, not the Tiber's 4.6. */
export const wadiProfile = (d: number, plainH: number): number => {
  const ad = Math.abs(d);
  const floor = plainH - 1.6;
  const toBank = Math.min(1, Math.max(0, (ad - WADI_HALF_WIDTH) / 30));
  const s = toBank * toBank * (3 - 2 * toBank);
  return floor + (plainH - floor) * s;
};

/** 1 inside the wadi's zone of influence, 0 on the untouched plain. */
export const wadiInfluence = (d: number): number => {
  const t = 1 - Math.min(1, Math.max(0, (Math.abs(d) - 52) / 34));
  return t * t * (3 - 2 * t);
};

/**
 * The seguias: irrigation channels crossing the isthmus, as (z-offset, skew) pairs.
 *
 * Punic North Africa was the most intensively irrigated coast in the western Mediterranean —
 * Mago's twenty-eight books on agriculture were the one thing the Senate ordered translated
 * out of the city's libraries before it burned — and a worked coastal plain is cut with
 * channels every couple of hundred metres.
 *
 * Deliberately tiny: 0.35–0.6 m deep, 7–12 m wide. A man steps over one. What they do is
 * optical — under a 20° sun a 0.5 m channel throws a metre of shadow line clean across the
 * frame, and four of them give the flattest ground on any of the three maps its only relief.
 */
export const SEGUIAS: readonly { z0: number; skew: number; depth: number; width: number }[] = [
  { z0: -62, skew: 0.041, depth: 0.52, width: 11 },
  { z0: 138, skew: -0.029, depth: 0.4, width: 8 },
  { z0: -252, skew: 0.055, depth: 0.6, width: 12 },
  { z0: 296, skew: -0.017, depth: 0.36, width: 7 },
];

/** Signed cross-channel distance for channel `i` at a point, in metres. */
export const seguiaDistance = (i: number, x: number, z: number): number => {
  const s = SEGUIAS[i];
  // A dug channel wanders far less than a watercourse, but it is not ruled: a hand-cut seguia
  // follows the contour, and a mathematically straight one is unmistakably machined.
  const wander = 9 * Math.sin(x * 0.0041 + i * 1.7) + 3.5 * Math.sin(x * 0.0113 + i * 2.4);
  return z - (s.z0 + x * s.skew + wander);
};

// ---------------------------------------------------------------------------
// Human landscape
// ---------------------------------------------------------------------------

/**
 * The road from Utica and Tunes across the isthmus to the central gate.
 *
 * Aimed at x = 0 at the wall line, which is where §4.5's central gate sits and where the
 * projection puts the Byrsa's own meridian. In front of the wall it is the axis the ram comes
 * up; behind it, it is the city's business.
 */
export const roadCentreX = (z: number): number => {
  const t = sstepLocal(-1350, 470, z);
  return (1 - t) * (-268 + 64 * Math.sin((z + 900) * 0.00181));
};

/** Half-width of the metalled way. A Punic trunk road, wider than a Macedonian cart track. */
export const ROAD_HALF_WIDTH = 4.6;

/**
 * Where the market gardens and orchards are.
 *
 * A closed-form sum of sines rather than fBm or a texture, because **the ground shader and
 * the vegetation scatter must agree about this to the metre.** The shader sweeps the earth
 * bare under a garden and the scatter plants the trees; if they disagree the map grows olives
 * out of stubble and sweeps bare rings in the open field, which is worse than having neither
 * effect. A texture lookup cannot be mirrored on the CPU and fBm is too expensive per pixel;
 * this is a dozen ALU in GLSL and exact in both.
 *
 * Blocks at roughly 300, 190 and 420 m — smaller than Pydna's dryland olive holdings, because
 * these are irrigated market gardens feeding a city of a quarter of a million. Returns about
 * 0.5 ± 0.52.
 */
export const gardenField = (x: number, z: number): number =>
  0.5 +
  0.23 * Math.sin(x * 0.01041 - 0.6) * Math.cos(z * 0.00893 + 2.1) +
  0.16 * Math.sin(x * 0.00612 + 1.4) * Math.cos(z * 0.00517 - 1.3) +
  0.1 * Math.sin((x - z * 0.8) * 0.01611 + 0.35) +
  0.07 * Math.cos((x + z) * 0.02417 - 2.2);

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Where the armies form up.
 *
 * The centres are fixed by `src/sim/scenario.ts`, which hardcodes `germZ = -190` and
 * `romanZ = 130`, so a map moves the world under the armies rather than the armies over the
 * world. These match the other two maps' boxes for exactly that reason and no other.
 *
 * On this map the box at z −196 is Scipio's siege line on the isthmus and the box at z +150
 * is the ground inside the glacis where Hasdrubal's field force formed up outside the wall.
 * The wall crest at mid-span is z 527, so the attacker has **~640 m of approach** from his own
 * line to the ditch lip — against Rome's ~620. The two maps read at the same tempo.
 */
const rectMask = (
  x: number, z: number, cx: number, cz: number, hx: number, hz: number, feather: number,
): number => {
  const dx = 1 - Math.min(1, Math.max(0, (Math.abs(x - cx) - (hx - feather)) / feather));
  const dz = 1 - Math.min(1, Math.max(0, (Math.abs(z - cz) - (hz - feather)) / feather));
  return dx * dx * (3 - 2 * dx) * (dz * dz * (3 - 2 * dz));
};

export const romanDeployMask = (x: number, z: number): number =>
  rectMask(x, z, 0, -196, 490, 130, 80);
export const punicDeployMask = (x: number, z: number): number =>
  rectMask(x, z, 0, 150, 490, 120, 80);

/** The fighting corridor: high-frequency relief damped, broad form kept. */
export const battleCoreMask = (x: number, z: number): number =>
  rectMask(x, z, 0, -20, 540, 380, 170);

// ---------------------------------------------------------------------------
// GLSL mirror
// ---------------------------------------------------------------------------

/**
 * The functions the ground material needs per pixel, in GLSL. Injected into the terrain
 * fragment shader. Constants are duplicated on purpose — uploading them as uniforms would
 * cost more than it saves. **If you change a centreline above, change it here.**
 */
export const CARTHAGE_TOPO_GLSL = /* glsl */ `
const float CAR_WADI_HALF = ${WADI_HALF_WIDTH.toFixed(3)};
const float CAR_ROAD_HALF = ${ROAD_HALF_WIDTH.toFixed(3)};
const float CAR_TAENIA_HALF = ${TAENIA_HALF.toFixed(1)};

float carCoastZ(float x)  { return 1176.0 + 0.225 * x + 0.00006 * x * x; }
float carLakeEdgeX(float z) {
  float head = smoothstep(250.0, 600.0, z) * (1.0 - smoothstep(760.0, 1080.0, z));
  return -1400.0 + 432.0 * head + 26.0 * sin((z + 300.0) * 0.00214) * head;
}
float carArianaEdgeX(float z) {
  return 1096.0 + 140.0 * smoothstep(700.0, 1150.0, z) - 52.0 * sin((z - 200.0) * 0.00187);
}
float carTaeniaX(float z) {
  return -1270.0 + 58.0 * sin((z + 250.0) * 0.00171) + 22.0 * sin((z - 600.0) * 0.0039);
}
float carTaeniaNess(vec2 p) {
  float along = smoothstep(-680.0, -420.0, p.y) * (1.0 - smoothstep(940.0, 1080.0, p.y));
  return along * (1.0 - smoothstep(CAR_TAENIA_HALF * 0.6, CAR_TAENIA_HALF,
                                   abs(p.x - carTaeniaX(p.y))));
}
float carWadiZ(float x) {
  return -434.0 + 92.0 * sin((x + 380.0) * 0.00112) + 37.0 * sin((x - 540.0) * 0.00259 + 1.4);
}
float carRoadCentreX(float z) {
  float t = smoothstep(-1350.0, 470.0, z);
  return (1.0 - t) * (-268.0 + 64.0 * sin((z + 900.0) * 0.00181));
}
float carWallZ(float x) { return 527.0 - 0.06241 * x + 2.945e-5 * x * x; }
/** Soft sabkha margin, 0 firm .. 1 impassable to wheels. Mirrors \`softGround\`. */
float carSoftGround(vec2 p) {
  float nearLake = 1.0 - smoothstep(0.0, 300.0, p.x - carLakeEdgeX(p.y));
  float nearAriana = 1.0 - smoothstep(0.0, 300.0, carArianaEdgeX(p.y) - p.x);
  return min(1.0, max(max(nearLake, nearAriana), carTaeniaNess(p) * 0.55));
}
// Must stay the same shape as gardenField above — see its comment.
float carGardenField(vec2 p) {
  return 0.5
       + 0.23 * sin(p.x * 0.01041 - 0.6) * cos(p.y * 0.00893 + 2.1)
       + 0.16 * sin(p.x * 0.00612 + 1.4) * cos(p.y * 0.00517 - 1.3)
       + 0.10 * sin((p.x - p.y * 0.8) * 0.01611 + 0.35)
       + 0.07 * cos((p.x + p.y) * 0.02417 - 2.2);
}
`;
