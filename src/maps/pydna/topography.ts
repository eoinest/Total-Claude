/**
 * The topography of the plain of Pydna, 22 June 168 BC, as analytic functions.
 *
 * Geography being modelled (metres above mean sea level; the Thermaic Gulf lies east,
 * beyond the map edge, and is deliberately never shown — see the note on the shore below):
 *
 *   - The Pierian coastal plain, running down from the foothills of the Pierian range in
 *     the west to the Thermaic Gulf in the east at a little over one per cent. Level enough
 *     for a Macedonian phalanx to keep its dress, which is exactly why Perseus offered
 *     battle here and why Aemilius Paullus did not want it.
 *   - Low swells and shallow dry runnels crossing that plain. Plutarch's account turns on
 *     them: the phalanx advanced over broken ground, its line opened, and the maniples went
 *     into the gaps. They are 1.5-3 m of relief on a 90-160 m wavelength — nothing a man
 *     notices and everything a sixteen-deep pike block does.
 *   - The Leucus, a small stream draining the range eastward across the plain. On the
 *     summer solstice it is a dry braided bed of pale gravel with a string of standing
 *     pools, which is what it is modelled as: cobbles and shingle, no water surface.
 *   - The Pierian foothills rising west of x = -500, and the spur of Mount Olocrus in the
 *     south-west under which the Roman camp stood.
 *   - A low ridge north of the stream, on the road up to Pydna town.
 *
 * **There is no coastline on this map and no open water anywhere on it.** The plain tilts
 * toward a gulf that sits past the eastern boundary; the lowest ground on the field is
 * still 13 m above the sea. That is geographically honest and it is also a deliberate
 * scoping decision: the Rome II reference set contains no beach, no marsh and no
 * battle-scale water at all, so a map built around any of them could not be judged against
 * it.
 *
 * Every function here is pure and allocation-free. Several are mirrored in GLSL (see
 * `PYDNA_TOPO_GLSL`) so the ground material can evaluate the stream bed per pixel instead of
 * reading a blurry control texture — keep the two in step.
 */

import type { DeployGround } from '../types';

import { HALF_EXTENT } from '../../terrain/topography';

export { HALF_EXTENT };

/**
 * Nominal datum. Nothing on this map is under water, so this exists only to satisfy the
 * shared terrain contract and to give the height-keyed splat rules an origin; it is mean sea
 * level, and the lowest ground on the field sits 13 m above it.
 */
export const SEA_LEVEL = 0;

/** Height of the plain at the eastern boundary, where the ground runs on toward the gulf. */
const EAST_EDGE_HEIGHT = 13.5;

/** Fall of the coastal plain, metres per metre. Surveyed Pierian plain runs 1.0-1.3 %. */
const PLAIN_GRADIENT = 0.011;

/**
 * Regional surface: the plain, the Pierian foothills and the Olocrus spur, with no relief.
 *
 * This is the plane the deployment boxes are flattened onto, so it has to be smooth and it
 * has to be gentle across the frontage. Across the ±490 m the armies occupy it falls 10.8 m,
 * a 1.1 % grade — a fall of one in ninety, which no formation can feel but which gives the
 * whole field a single consistent aspect for the light to rake down.
 */
export const regionalPlain = (x: number, z: number): number => {
  // Distance inland from the eastern boundary.
  const inland = HALF_EXTENT - x;
  let h = EAST_EDGE_HEIGHT + inland * PLAIN_GRADIENT;

  // The Pierian range. Steepens west of x = -500 and keeps climbing off the map edge, so
  // the western third reads as the toe of a mountain front rather than as a hill on a plain.
  h += 132 * sstepLocal(-470, -1400, x);
  // Second, higher term beyond the boundary of the playable area: the ground the clipmap
  // shows past ±1400 m needs somewhere to go, and a range that stops dead at the map edge
  // is the most obvious possible tell.
  h += 96 * sstepLocal(-1150, -2600, x);

  // Mount Olocrus: the spur in the south-west under which the Roman camp stood. Gaussian in
  // x, ramped in z, so it closes the south-western corner of the frame without intruding on
  // the fighting ground.
  const olocrus = Math.exp(-Math.pow((x + 1010) / 690, 2)) * sstepLocal(60, 980, z);
  h += olocrus * 84;

  // The low ridge north of the stream carrying the road up to Pydna town. Broad and modest:
  // it is the horizon line behind the Macedonian army, not a feature anyone fights over.
  const ridge = Math.exp(-Math.pow((z + 745) / 300, 2)) * (1 - sstepLocal(560, 1250, x));
  h += ridge * 16.5;

  return h;
};

/** Local smoothstep. Duplicated from `terrain/noise` so this module stays dependency-free. */
function sstepLocal(edge0: number, edge1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// The Leucus
// ---------------------------------------------------------------------------

/**
 * Centreline of the Leucus as a function of x: it drains the range eastward, so its course
 * is a function of easting rather than northing — the opposite of the Tiber's.
 *
 * Placed so it crosses the centre of the map at z ≈ -430, which is 240 m beyond the
 * Macedonian line. That is deliberate composition as much as geography: from the opening
 * camera behind the Roman position the stream and its plane trees are the horizontal band
 * *behind* the enemy army, which is what gives the middle distance a readable line and the
 * frame a third depth layer. Put through the fighting ground instead it would only mean
 * every clash happens in a ditch.
 */
export const leucusZ = (x: number): number =>
  -430 + 128 * Math.sin((x + 250) * 0.00108) + 46 * Math.sin((x - 620) * 0.00262 + 1.15);

/** Half-width of the braided gravel bed. Small: this is a torrent stream, dry in June. */
export const LEUCUS_HALF_WIDTH = 15;

/**
 * Cross-section of the stream: a shallow flat-floored trough with low shingle banks.
 *
 * 1.9 m of incision, not the Tiber's 4.6. A Macedonian summer stream cuts a wide shallow
 * braid, not a channel — and a deep one here would be a wall across the northern third of
 * the field for anything the AI tries to route through it.
 */
export const leucusProfile = (d: number, plainH: number): number => {
  const ad = Math.abs(d);
  const floor = plainH - 1.9;
  // Flat bed out to the half-width, then a bank running out over 26 m into the plain.
  const toBank = Math.min(1, Math.max(0, (ad - LEUCUS_HALF_WIDTH) / 26));
  const s = toBank * toBank * (3 - 2 * toBank);
  return floor + (plainH - floor) * s;
};

/** 1 inside the stream's zone of influence, 0 on the untouched plain. */
export const leucusInfluence = (d: number): number => {
  const t = 1 - Math.min(1, Math.max(0, (Math.abs(d) - 46) / 30));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// The runnels that broke the phalanx
// ---------------------------------------------------------------------------

/**
 * Shallow dry tributaries crossing the fighting corridor, as (x-offset, amplitude) pairs.
 *
 * These are the historically decisive terrain on this field and they are deliberately tiny:
 * 0.4-0.8 m deep and 9-16 m wide. A man walks through one without breaking step. A
 * sixteen-deep pike block crossing one at an angle loses its dress, and at Pydna that was
 * the battle. They also do real visual work — under a broadside sun a 0.6 m runnel throws a
 * 1 m shadow line clean across the frame, which is worth more relief than its depth suggests.
 */
export const RUNNELS: readonly { z0: number; skew: number; depth: number; width: number }[] = [
  { z0: -108, skew: 0.052, depth: 0.62, width: 13 },
  { z0: 34, skew: -0.038, depth: 0.48, width: 10 },
  { z0: 196, skew: 0.067, depth: 0.74, width: 15 },
  { z0: -262, skew: -0.024, depth: 0.55, width: 11 },
];

/** Signed cross-runnel distance for runnel `i` at a point, in metres. */
export const runnelDistance = (i: number, x: number, z: number): number => {
  const r = RUNNELS[i];
  // Each runnel is a shallow arc, not a straight line: a ruled ditch across a plain is the
  // clearest possible sign that a computer drew it.
  const wander = 17 * Math.sin(x * 0.0037 + i * 2.1) + 7 * Math.sin(x * 0.0094 + i * 1.3);
  return z - (r.z0 + x * r.skew + wander);
};

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Where the armies form up.
 *
 * The centres are fixed by `src/sim/scenario.ts`, which hardcodes `germZ = -190` and
 * `romanZ = 130` and is not owned by this workstream — so a map moves the world under the
 * armies rather than the armies over the world. These match `topography.ts`'s boxes exactly,
 * for that reason and no other.
 *
 * At Pydna the "attacker" box is the Macedonian phalanx and the "defender" box the Roman
 * legions, which is also the historical arrangement: Perseus' line advanced, Paullus' gave
 * ground and then went into the gaps.
 */
/** Soft edge on every deployment box, in metres. Published on the box; see `DeployBox`. */
const DEPLOY_FEATHER = 80;

const rectMask = (
  x: number,
  z: number,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  feather: number,
): number => {
  const dx = 1 - Math.min(1, Math.max(0, (Math.abs(x - cx) - (hx - feather)) / feather));
  const dz = 1 - Math.min(1, Math.max(0, (Math.abs(z - cz) - (hz - feather)) / feather));
  return dx * dx * (3 - 2 * dx) * (dz * dz * (3 - 2 * dz));
};

/**
 * The two boxes as data, with the masks derived from them.
 *
 * `sim/scenario.ts` forms its lines up on this. See `maps/types.ts`'s `DeployGround`.
 *
 * The battle's axis is 0 and the southern box carries its own 10 m offset, which is how it has
 * always been drawn and is not the axis the two lines face each other along. Keeping the 10 m
 * on the box rather than promoting it to `axisX` is what leaves this map's field battle exactly
 * where it was.
 *
 * `feather` is published on the box because `standOnDeploymentGround` insets by it. Nothing
 * about Pydna changes: 490 m of half-width against a line that reaches 342 m either side of
 * the axis leaves the west rule slack by 138 m even on the offset southern box, and the inset
 * spends 80 of it, so the shift here is still exactly 0.
 */
export const DEPLOY_GROUND = {
  axisX: 0,
  north: { cx: 0, cz: -196, hx: 490, hz: 130, feather: DEPLOY_FEATHER },
  south: { cx: 10, cz: 150, hx: 490, hz: 120, feather: DEPLOY_FEATHER },
} as const satisfies DeployGround;

export const macedonianDeployMask = (x: number, z: number): number =>
  rectMask(x, z, DEPLOY_GROUND.north.cx, DEPLOY_GROUND.north.cz,
    DEPLOY_GROUND.north.hx, DEPLOY_GROUND.north.hz, DEPLOY_GROUND.north.feather);
export const romanDeployMask = (x: number, z: number): number =>
  rectMask(x, z, DEPLOY_GROUND.south.cx, DEPLOY_GROUND.south.cz,
    DEPLOY_GROUND.south.hx, DEPLOY_GROUND.south.hz, DEPLOY_GROUND.south.feather);

/**
 * The fighting corridor. High-frequency relief is damped here and the broad swells kept.
 *
 * Damped *less* than on the Campus Martius (0.55 against 0.72-0.82), because on this field
 * the low relief is the point: it is what the account of the battle turns on, and it is what
 * a broadside evening sun reads off the ground.
 */
export const battleCoreMask = (x: number, z: number): number =>
  rectMask(x, z, 0, -30, 540, 360, 170);

// ---------------------------------------------------------------------------
// Human landscape
// ---------------------------------------------------------------------------

/**
 * The road from Pydna town down the coast, running roughly north-south across the eastern
 * side of the field. A packed-earth country road, not a paved consular one: Macedonia in 168
 * BC had the Via Egnatia not yet built for another twenty years.
 */
export const roadCentreX = (z: number): number =>
  660 + 96 * Math.sin((z + 420) * 0.00152) - 42 * Math.sin((z - 300) * 0.00301);

/** Half-width of the worn track. */
export const ROAD_HALF_WIDTH = 3.4;

/**
 * Olive terraces on the lower slopes of the Pierian foothills.
 *
 * Real Mediterranean hill agriculture is terraced, and a terraced hillside under a raking
 * sun is a line of horizontal shadow bands that reads instantly as worked land. Confined to
 * the western slope between these bounds, and patchy within it.
 */
export const TERRACE_X_OUTER = -1180;
export const TERRACE_X_INNER = -520;
/** Riser height of a dry-stone olive terrace on this coast. */
export const TERRACE_BENCH = 1.35;

/**
 * Where the olive groves are.
 *
 * Deliberately a closed-form sum of four sine products rather than fBm or a noise texture,
 * because **the ground material and the vegetation scatter must agree about this to the
 * metre**. The shader sweeps the earth bare under a grove and the scatter plants the trees;
 * if the two disagree, the map grows olives out of pasture and sweeps bare rings in the open
 * field, which is worse than having neither effect. A texture lookup cannot be mirrored on
 * the CPU and an fBm is too expensive per pixel; this is a dozen ALU in GLSL and exact in
 * both.
 *
 * The four terms give blocks at roughly 430, 260, 340 and 150 m, which is the real size
 * range of a Mediterranean grove holding. Returns about 0.5 ± 0.55.
 */
export const groveField = (x: number, z: number): number =>
  0.5 +
  0.24 * Math.sin(x * 0.00731 + 1.7) * Math.cos(z * 0.00611 - 0.4) +
  0.17 * Math.sin(x * 0.01427 - 2.3) * Math.cos(z * 0.01193 + 1.9) +
  0.11 * Math.sin((x + z) * 0.00933 + 0.8) +
  0.08 * Math.cos((x - z * 1.31) * 0.02051 - 1.2);

/**
 * GLSL mirror of the handful of functions the ground material needs per pixel. Injected into
 * the terrain fragment shader. Constants are duplicated on purpose: uploading them as
 * uniforms would cost more than it saves. If you change a centreline above, change it here.
 */
export const PYDNA_TOPO_GLSL = /* glsl */ `
const float PYD_LEUCUS_HALF = ${LEUCUS_HALF_WIDTH.toFixed(3)};
const float PYD_ROAD_HALF = ${ROAD_HALF_WIDTH.toFixed(3)};

float pydLeucusZ(float x) {
  return -430.0 + 128.0 * sin((x + 250.0) * 0.00108) + 46.0 * sin((x - 620.0) * 0.00262 + 1.15);
}
float pydRoadCentreX(float z) {
  return 660.0 + 96.0 * sin((z + 420.0) * 0.00152) - 42.0 * sin((z - 300.0) * 0.00301);
}
// Must stay bit-for-bit the same shape as \groveField\ above — see its comment.
float pydGroveField(vec2 p) {
  return 0.5
       + 0.24 * sin(p.x * 0.00731 + 1.7) * cos(p.y * 0.00611 - 0.4)
       + 0.17 * sin(p.x * 0.01427 - 2.3) * cos(p.y * 0.01193 + 1.9)
       + 0.11 * sin((p.x + p.y) * 0.00933 + 0.8)
       + 0.08 * cos((p.x - p.y * 1.31) * 0.02051 - 1.2);
}
`;
