/**
 * The ground of Carthage, 146 BC, as analytic functions.
 *
 * The frame is the **isthmus**, looking north-east up the peninsula at the land walls. That
 * is not an arbitrary crop; it is the only crop the battle has. Appian (Punica 95) gives the
 * isthmus as twenty-five stades — about 4.6 km — and says a triple wall ran across it. Our
 * playable field is 2.8 km. So on this map **the sea is off the edge on both flanks, and
 * that is geographically correct rather than a dodge**: standing at Scipio's siege line you
 * could not see both shores at once either.
 *
 * What is on the field, from the besieger's camp forward:
 *
 *  - **The isthmus plain**, 4–18 m above the sea, rising gently toward the city. Parched
 *    stubble and esparto in high summer, cut by a dry wadi and by the irrigation channels
 *    of a countryside Mago wrote a treatise about.
 *  - **The Lake of Tunis** to the left (−X). A shallow brackish lagoon whose margin in
 *    August is a salt pan — near-white crust over grey-violet mud. The single most
 *    distinctive surface on any of this project's maps.
 *  - **The Gulf of Tunis** to the right (+X). Pale shell-sand beach behind a low dune belt.
 *  - **The triple wall**, across the frame at z ≈ 430. `carthageWallZ` publishes its line so
 *    the wall geometry, the glacis keep-out and the terrain bench all agree about where it
 *    runs. The terrain grades a mild bench under it, because a curtain whose bays step three
 *    metres between neighbours is a curtain nobody can garrison.
 *  - **The Megara** behind it: the great walled suburb of orchards, market gardens, hedges
 *    and ditches that Appian says broke up Scipio's advance more effectively than the
 *    defenders did.
 *  - **The Byrsa**, the citadel hill, ~62 m above the sea with the temple of Eshmoun on top.
 *    It is the reason this map has a skyline: from the siege lines the city is not a wall
 *    with a flat town behind it, it is a wall with a hill behind it.
 *  - **Bordj Djedid**, the lower second rise north-east of the Byrsa where the great
 *    cisterns stand.
 *
 * **There is no open water surface on this map.** `RiverWater` is a ribbon built along the
 * Tiber's centreline and generalising it is a `src/terrain/` change this workstream does not
 * own; more to the point, neither shore is inside the field. The ground falls to a little
 * over the datum at both x edges and the clipmap's `farHeight` carries it out flat from
 * there, so the horizon on both flanks is a pale sheet at sea level — which is what a lagoon
 * and a gulf look like from two kilometres inland through August haze.
 *
 * Every function here is pure and allocation-free. The handful the ground shader also needs
 * are mirrored in `CARTHAGE_TOPO_GLSL`; keep the two in step or the splat will paint the
 * beach where the scatter plants olives.
 */

import { HALF_EXTENT } from '../../terrain/topography';

export { HALF_EXTENT };

/** Mean sea level. The Mediterranean is tideless enough that one number will do. */
export const SEA_LEVEL = 0;

/** Local smoothstep. Duplicated from `terrain/noise` so this module stays dependency-free. */
const sstepLocal = (edge0: number, edge1: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// The two shorelines
// ---------------------------------------------------------------------------

/**
 * Where the Lake of Tunis begins, as an x for each z. Negative: it is the left flank.
 *
 * Bows *into* the map toward the south, because the lagoon's north-eastern lobe reaches
 * furthest inland where the isthmus is narrowest — which is the whole reason the isthmus is
 * narrowest there. Pushed to −1120 at its nearest so a besieger's left wing at x −490 still
 * has 600 m of dry ground to form up on: this is a battlefield before it is a coastline.
 */
export const lagoonEdgeX = (z: number): number =>
  -1215 + 105 * Math.sin((z + 640) * 0.00121) + 44 * Math.sin((z - 380) * 0.00287 + 0.7);

/** Where the Gulf of Tunis begins. Positive: the right flank, and the open sea. */
export const gulfEdgeX = (z: number): number =>
  1240 - 86 * Math.sin((z - 210) * 0.00098) - 38 * Math.sin((z + 700) * 0.00243 - 1.1);

/**
 * Width of the fall from the crown of the isthmus down to each shore.
 *
 * The lagoon side is the wider ramp — a lagoon margin is a sabkha, hundreds of metres of
 * dead-flat salt pan — and the gulf side is the shorter one, because a wave-cut coast backed
 * by a dune belt drops in a couple of hundred metres.
 */
const LAGOON_RAMP = 380;
const GULF_RAMP = 250;

/** How much of the crown's height survives at the water's edge. Not zero: a beach has a berm. */
const SHORE_RESIDUAL = 0.055;

// ---------------------------------------------------------------------------
// The line of the land wall
// ---------------------------------------------------------------------------

/**
 * Centreline of the triple wall, as a z for each x.
 *
 * **This is the contract between the terrain and the wall geometry.** `src/city/carthage/`
 * builds its curtain along this line; the terrain grades a bench under it; the vegetation
 * scatter clears a glacis outside it and leaves everything inside to the city. Three
 * consumers, one function, so none of them can drift.
 *
 * Nearly straight and very slightly bowed outward at the centre, which is what a wall built
 * to the shortest crossing of an isthmus looks like. **The bow must stay shallow**: bays are
 * indexed arithmetically in x by `CitySystem.bayAt`, so the run has to be a function of x
 * with a bounded slope, not a curve that doubles back.
 */
export const carthageWallZ = (x: number): number =>
  432 - 22 * Math.cos(x * 0.00105) - 7 * Math.sin(x * 0.00231 + 0.4);

/**
 * Half-width of the graded bench the terrain lays under the wall.
 *
 * 34 m carries the 9 m curtain (Appian's thirty feet), its towers, the wall-walk's footing
 * and the military road immediately behind it. Wider than that and the bench reads as a
 * ledge cut across the landscape; narrower and the curtain's outer face steps.
 */
export const WALL_BENCH_HALF = 34;

/**
 * How far out from the wall the ground is cleared and kept clear.
 *
 * A besieged city clears its glacis: everything within bowshot of the curtain is felled and
 * demolished so nothing gives cover and nothing hides a mine. 40 m rather than the Campus
 * Martius' 30 because Carthage's countryside is orchard, and an olive at 30 m from a 13.5 m
 * wall still puts its crown level with the parapet.
 */
export const WALL_CLEAR_OUT = 40;

// ---------------------------------------------------------------------------
// The two hills
// ---------------------------------------------------------------------------

/** Centre of the Byrsa, and how far it stands above the Megara terrace behind the wall. */
export const BYRSA_X = 95;
export const BYRSA_Z = 985;
/**
 * 34 m above the Megara terrace, which puts the summit at 57–65 m above the sea once the
 * hill's own relief is on it.
 *
 * The real Byrsa is about 60 m and the temple of Eshmoun on top of it was reached by sixty
 * steps. It is the single most important number on this map: it is what makes the city read
 * as a citadel rather than as a town wall, and from the siege lines at z −190 an object 34 m
 * up at 1,175 m subtends 1.7°, which is a genuine skyline.
 *
 * **It was 40 and that was wrong, and the heightfield's own datum check is what said so.**
 * The ridged-multifractal relief laid on the hills in `baseHeight` peaks where `uplandWeight`
 * peaks — which is the summit — so the two add rather than average and the field came out at
 * 76.5 m. Sizing the analytic hill against the *measured* maximum rather than against the
 * intended one is the only way to hit a real height; the noise is not a perturbation here,
 * it is a fifth of the landform.
 */
export const BYRSA_RISE = 34;
/** Half-axes of the hill's footprint, x then z. Long axis up the peninsula. */
const BYRSA_HW = 255;
const BYRSA_HD = 335;

/** Bordj Djedid: the lower rise north-east of the Byrsa, where the great cisterns are. */
const DJEDID_X = 615;
const DJEDID_Z = 1195;
const DJEDID_RISE = 17;

/**
 * A rounded flat-topped hill.
 *
 * Flat-topped rather than Gaussian, because the Byrsa carried a temple precinct, a forum and
 * a quarter of housing on its summit and a Gaussian gives nowhere to put them. `inner` is the
 * fraction of the radius that stays level.
 */
const knoll = (
  x: number, z: number, cx: number, cz: number, hw: number, hd: number, rise: number,
  inner = 0.32,
): number => {
  const r = Math.hypot((x - cx) / hw, (z - cz) / hd);
  return rise * (1 - sstepLocal(inner, 1.1, r));
};

// ---------------------------------------------------------------------------
// The regional surface
// ---------------------------------------------------------------------------

/**
 * The isthmus, its two shores and the two hills, with no relief at all.
 *
 * This is the plane the deployment boxes are flattened onto and the surface the wall bench is
 * cut from, so it must be smooth and it must be gentle across both armies' frontage. Over the
 * ±490 m the lines occupy at z −196 it falls 0.9 m — one in a thousand, which is level ground
 * by any standard a formation can feel.
 */
export const regionalLand = (x: number, z: number): number => {
  // 1. The spine, as a function of z alone. The mainland end of the isthmus is barely above
  //    the lagoon; the ground climbs to the wall and then again onto the Megara terrace.
  let crown = 4.2 + 12.6 * sstepLocal(-1400, 300, z);
  crown += 6.4 * sstepLocal(300, 940, z);

  // 2. Cross-section. The crown is scaled down to a residual at each shore rather than having
  //    a fall subtracted from it, so the land meets the water at the same height whatever the
  //    spine is doing — which is what a coastline is.
  const dLagoon = x - lagoonEdgeX(z);
  const dGulf = gulfEdgeX(z) - x;
  const toLagoon = 1 - sstepLocal(0, LAGOON_RAMP, dLagoon);
  const toGulf = 1 - sstepLocal(0, GULF_RAMP, dGulf);
  const shore = Math.max(toLagoon, toGulf);
  let h = crown * (1 - (1 - SHORE_RESIDUAL) * shore);

  // 3. The dune belt behind the gulf beach: a ridge of blown shell sand peaking halfway up
  //    the ramp, 4.4 m at its crest (`0.25 * 17.6`, since `t(1−t)` maxes at a quarter). This
  //    is what hides the sea from the isthmus, and it is why this map can have a coast
  //    without a water surface.
  h += toGulf * (1 - toGulf) * 17.6;

  // 4. The sabkha. Dead flat and just clear of the datum, so the splat rules always have
  //    ground to paint and never a hole with no material for it.
  h = h * (1 - toLagoon) + Math.max(h, 0.55) * toLagoon;

  // 5. The citadel and its neighbour.
  h += knoll(x, z, BYRSA_X, BYRSA_Z, BYRSA_HW, BYRSA_HD, BYRSA_RISE, 0.3);
  h += knoll(x, z, DJEDID_X, DJEDID_Z, 285, 215, DJEDID_RISE, 0.34);

  return h;
};

// ---------------------------------------------------------------------------
// The wadi
// ---------------------------------------------------------------------------

/**
 * Centreline of the seasonal wadi draining the isthmus westward into the lagoon.
 *
 * A z for each x, because it runs across the field rather than along it — the opposite of the
 * Tiber and the same as Pydna's Leucus. Placed at z ≈ −470, which is 280 m behind the
 * besiegers' line: from the opening camera it is the horizontal band *behind* the enemy camp,
 * which gives the middle distance a line to read and the frame a third depth layer. Through
 * the fighting ground it would only mean every clash happens in a ditch.
 */
export const wadiZ = (x: number): number =>
  -472 + 96 * Math.sin((x + 380) * 0.00112) + 39 * Math.sin((x - 540) * 0.00259 + 1.4);

/** Half-width of the gravel bed. A North African wadi is wide, shallow and dry ten months a year. */
export const WADI_HALF_WIDTH = 19;

/**
 * Cross-section: a broad flat-floored trough with low banks of its own spoil.
 *
 * 1.6 m of incision. Deeper would be a wall across the southern third of the field for
 * anything the AI tries to route through it, and a wadi on a coastal plain does not cut deep
 * — it braids wide.
 */
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

// ---------------------------------------------------------------------------
// The irrigation channels
// ---------------------------------------------------------------------------

/**
 * The seguias: shallow irrigation channels crossing the isthmus, as (z-offset, skew) pairs.
 *
 * Punic North Africa was intensively irrigated — Mago's twenty-eight books on agriculture
 * were the one thing the Senate ordered translated out of the city's libraries before it
 * burned — and a worked coastal plain is cut with channels every couple of hundred metres.
 *
 * They are deliberately tiny, 0.35–0.6 m and 7–12 m wide. A man steps over one. What they do
 * is optical: under a low sun a 0.5 m channel throws a shadow line clean across the frame,
 * and four of them at 200 m spacing give the flattest part of the map its only relief.
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
  // A dug channel wanders far less than a watercourse, but it is not ruled: a hand-cut
  // seguia follows the contour and a mathematically straight one is unmistakably machined.
  const wander = 9 * Math.sin(x * 0.0041 + i * 1.7) + 3.5 * Math.sin(x * 0.0113 + i * 2.4);
  return z - (s.z0 + x * s.skew + wander);
};

// ---------------------------------------------------------------------------
// Human landscape
// ---------------------------------------------------------------------------

/**
 * The road from Tunes across the isthmus to the gate.
 *
 * Aimed at x = 0 at the wall line, because that is where a gate on the shortest crossing
 * belongs and it is the default the city plan is written against. Behind the wall it is the
 * city's business; in front of it, it is the axis the ram comes up.
 */
export const roadCentreX = (z: number): number => {
  const t = sstepLocal(-1350, 400, z);
  return (1 - t) * (-268 + 64 * Math.sin((z + 900) * 0.00181));
};

/** Half-width of the metalled way. A Punic trunk road, wider than a Macedonian farm track. */
export const ROAD_HALF_WIDTH = 4.6;

/**
 * Where the market gardens and orchards are.
 *
 * A closed-form sum of sines rather than fBm or a texture, for the same reason Pydna's grove
 * field is: **the ground shader and the vegetation scatter must agree about this to the
 * metre.** The shader sweeps the earth bare under a garden and the scatter plants the trees;
 * if they disagree the map grows olives out of stubble and sweeps bare rings in the open
 * field, which is worse than having neither effect. A texture lookup cannot be mirrored on
 * the CPU and fBm is too expensive per pixel; this is a dozen ALU in GLSL and exact in both.
 *
 * Blocks at roughly 300, 190 and 420 m — smaller than Pydna's groves, because these are
 * irrigated market gardens supplying a city of a quarter of a million people, not dryland
 * olive holdings. Returns about 0.5 ± 0.52.
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
 * On this map the "attacker" box at z −196 is Scipio's siege line on the isthmus and the
 * "defender" box at z +150 is the ground inside the glacis where Hasdrubal's field force
 * stood out from the wall. That is also the historical arrangement.
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

/**
 * The fighting corridor: high-frequency relief damped, broad form kept.
 *
 * Damped at 0.62, between the Campus Martius' 0.72–0.82 and Pydna's 0.55. The seguias are cut
 * after this and masked away from it, so what it flattens is noise rather than landscape.
 */
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
const float CAR_LAGOON_RAMP = ${LAGOON_RAMP.toFixed(1)};
const float CAR_GULF_RAMP = ${GULF_RAMP.toFixed(1)};

float carLagoonEdgeX(float z) {
  return -1215.0 + 105.0 * sin((z + 640.0) * 0.00121) + 44.0 * sin((z - 380.0) * 0.00287 + 0.7);
}
float carGulfEdgeX(float z) {
  return 1240.0 - 86.0 * sin((z - 210.0) * 0.00098) - 38.0 * sin((z + 700.0) * 0.00243 - 1.1);
}
float carWadiZ(float x) {
  return -472.0 + 96.0 * sin((x + 380.0) * 0.00112) + 39.0 * sin((x - 540.0) * 0.00259 + 1.4);
}
float carRoadCentreX(float z) {
  float t = smoothstep(-1350.0, 400.0, z);
  return (1.0 - t) * (-268.0 + 64.0 * sin((z + 900.0) * 0.00181));
}
float carWallZ(float x) {
  return 432.0 - 22.0 * cos(x * 0.00105) - 7.0 * sin(x * 0.00231 + 0.4);
}
// Must stay the same shape as gardenField above — see its comment.
float carGardenField(vec2 p) {
  return 0.5
       + 0.23 * sin(p.x * 0.01041 - 0.6) * cos(p.y * 0.00893 + 2.1)
       + 0.16 * sin(p.x * 0.00612 + 1.4) * cos(p.y * 0.00517 - 1.3)
       + 0.10 * sin((p.x - p.y * 0.8) * 0.01611 + 0.35)
       + 0.07 * cos((p.x + p.y) * 0.02417 - 2.2);
}
/** 1 at the lagoon's edge, 0 a ramp-width inland. The salt pan lives on this. */
float carLagoonNess(vec2 p) {
  return 1.0 - smoothstep(0.0, CAR_LAGOON_RAMP, p.x - carLagoonEdgeX(p.y));
}
/** 1 at the gulf's edge, 0 a ramp-width inland. The beach and the dunes live on this. */
float carGulfNess(vec2 p) {
  return 1.0 - smoothstep(0.0, CAR_GULF_RAMP, carGulfEdgeX(p.y) - p.x);
}
`;
