/**
 * The topography of the Campus Martius, 271 AD, as analytic functions.
 *
 * Geography being modelled (elevations are metres above the Tiber's low-water datum,
 * which is roughly modern m.a.s.l. for this reach of the river):
 *
 *   - The Campus Martius itself is an alluvial flood plain sitting about 12–13 m above
 *     the river, dead flat by the standards of Rome. This is where both armies form up.
 *   - The Tiber comes down the western side in a meandering channel about 95 m wide and
 *     4–5 m deep, with a cut bank on the outside of each bend and a sand-and-gravel
 *     point bar on the inside. A flood terrace ("prata", water meadow) sits two or three
 *     metres above the water before the ground steps up to the plain proper.
 *   - South-east the ground climbs 25–35 m onto the Pincian and Quirinal, which is where
 *     Aurelian's wall runs. Between the two shoulders is the saddle the Via Flaminia
 *     climbs to reach the Porta Flaminia, so the crest deliberately dips near x = 0.
 *   - The Petronia Amnis drains the Quirinal north-west across the plain into the Tiber.
 *   - The Via Flaminia runs due north from the gate on a cambered agger with flanking
 *     drainage ditches.
 *
 * Every function here is pure and allocation-free. Several are mirrored in GLSL (see
 * `TOPO_GLSL`) so the ground material can evaluate road and river masks per pixel
 * instead of reading a blurry control texture — keep the two in step.
 */

/** Battlefield half-size in metres. Part of the public terrain contract. */
export const HALF_EXTENT = 1400;

/** Tiber low-water surface. Everything else is measured against this. */
export const WATER_LEVEL = 5.0;

/** Datum height of the flood plain at the origin, before the gentle regional tilt. */
export const PLAIN_LEVEL = 12.2;

/** Half-width of the open water. The Tiber at Rome runs 90–100 m between banks. */
export const RIVER_HALF_WIDTH = 47;

/** Carriageway half-width of a consular road: 4.6 m of paving between kerbs. */
export const ROAD_HALF_WIDTH = 2.3;
/** Outer half-width of the agger (embankment) the paving sits on. */
export const AGGER_HALF_WIDTH = 5.4;
/** Centre-to-centre distance out to the flanking drainage ditches. */
export const DITCH_OFFSET = 8.6;

/** Ford across the Tiber: a gravel shoal where the channel widens and shallows. */
export const FORD_Z = -520;
export const FORD_SIGMA = 78;

/**
 * Centreline of the Tiber as a function of z. Two incommensurate sine terms give a
 * meander train that never repeats over the 2.8 km of map.
 */
export const riverCentreX = (z: number): number =>
  -760 + 130 * Math.sin(z * 0.0023256) + 50 * Math.sin(z * 0.0060606 + 1.3);

/** Local channel bearing, used to decide which bank is the cut bank. */
export const riverCurvature = (z: number): number =>
  130 * 0.0023256 * Math.cos(z * 0.0023256) + 50 * 0.0060606 * Math.cos(z * 0.0060606 + 1.3);

/**
 * Centreline of the Via Flaminia. Roman surveyors drove long straight alignments but
 * shifted them between fixed points, so this is nearly straight with two long, lazy
 * deviations rather than a smooth curve.
 */
export const roadCentreX = (z: number): number =>
  20 + 34 * Math.sin((z + 300) * 0.0018519) - 18 * Math.sin((z + 900) * 0.0033333);

/**
 * Where the toe of the city slope sits, per x. Wobbling it produces spurs and
 * re-entrants along the hill front.
 *
 * The base and amplitudes are chosen so the minimum is z = 252, which keeps the slope
 * clear of the Roman deployment box (which reaches z = 255 and holds the bolt-throwers
 * at z = 246). An earlier version bottomed out at z = 156 and put a 45° hillside inside
 * the parade ground.
 */
export const riseToeZ = (x: number): number =>
  330 + 52 * Math.sin(x * 0.00476) + 26 * Math.sin(x * 0.01053 + 2.1);

/**
 * How far the ground rises onto the hills at a given x, in metres above the plain.
 * Two shoulders — the Pincian to the west, the Quirinal to the east — with the
 * Porta Flaminia saddle between them.
 */
export const riseAmplitude = (x: number): number => {
  // Gaussian shoulders. Widths are chosen so the two hills merge into one mass at
  // their outer edges rather than standing as isolated cones.
  const pincian = 31 * Math.exp(-Math.pow((x + 300) / 430, 2));
  const quirinal = 34 * Math.exp(-Math.pow((x - 360) / 500, 2));
  const outerWest = 22 * Math.exp(-Math.pow((x + 1050) / 520, 2));
  const outerEast = 26 * Math.exp(-Math.pow((x - 1120) / 560, 2));
  // The gate saddle: the road has to get through, so cut the crest down here.
  const saddle = 13 * Math.exp(-Math.pow((x - 20) / 155, 2));
  return Math.max(pincian, quirinal, outerWest, outerEast) - saddle;
};

/** Length of the slope from toe to crest. Short enough to read as a hill front. */
export const RISE_RUN = 175;

/**
 * Height of the crest of the city rise at a given x — the line the Aurelian Wall
 * follows. Exported for the city agent: `crestZAt` gives a coherent, near-flat
 * platform to build on and `crestHeightAt` the elevation there.
 */
export const crestZAt = (x: number): number => riseToeZ(x) + RISE_RUN;
export const crestHeightAt = (x: number): number =>
  regionalPlain(x, crestZAt(x)) + riseAmplitude(x);

/** Very gentle regional tilt of the flood plain: it drains west and north to the river. */
export const regionalPlain = (x: number, z: number): number =>
  PLAIN_LEVEL + x * 0.0020 + z * 0.0026;

/** Squared-distance-free rectangle mask with smooth edges, 1 inside. */
const rectMask = (
  x: number,
  z: number,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  feather: number
): number => {
  const dx = 1 - Math.min(1, Math.max(0, (Math.abs(x - cx) - (hx - feather)) / feather));
  const dz = 1 - Math.min(1, Math.max(0, (Math.abs(z - cz) - (hz - feather)) / feather));
  return dx * dx * (3 - 2 * dx) * (dz * dz * (3 - 2 * dz));
};

/**
 * Where the armies form up. Terrain inside these boxes is flattened onto the regional
 * plane so that a 40-man-wide cohort cannot be broken in half by a hillock.
 * Bounds cover the full deployment from `sim/scenario.ts` plus the cavalry wings.
 */
export const germanDeployMask = (x: number, z: number): number =>
  rectMask(x, z, 0, -196, 300, 118, 70);
export const romanDeployMask = (x: number, z: number): number =>
  rectMask(x, z, 10, 150, 275, 105, 60);

/** The whole fighting corridor. High-frequency relief is damped here, swells are kept. */
export const battleCoreMask = (x: number, z: number): number =>
  rectMask(x, z, 0, -30, 380, 340, 150);

/** Quarry workings: tufa and travertine were cut from the hill flanks outside the city. */
export const QUARRIES: readonly { x: number; z: number; radius: number; depth: number }[] = [
  { x: -668, z: 236, radius: 66, depth: 7.5 },
  { x: 724, z: 328, radius: 58, depth: 6.2 },
];

/**
 * The Petronia Amnis, drawn as a polyline from the spring line on the Quirinal to its
 * confluence with the Tiber. Flattened pairs so the distance test stays allocation-free.
 */
export const STREAM_PATH: readonly number[] = [
  150, 330, 96, 258, 20, 210, -78, 176, -186, 132, -300, 92, -420, 46, -540, -10, -650, -60, -742, -96,
];

/** Squared distance from (x, z) to the stream polyline, and the parametric position along it. */
export const streamDistance = (x: number, z: number): number => {
  let best = Infinity;
  for (let i = 0; i + 3 < STREAM_PATH.length; i += 2) {
    const ax = STREAM_PATH[i];
    const az = STREAM_PATH[i + 1];
    const bx = STREAM_PATH[i + 2];
    const bz = STREAM_PATH[i + 3];
    const abx = bx - ax;
    const abz = bz - az;
    const len2 = abx * abx + abz * abz;
    let t = ((x - ax) * abx + (z - az) * abz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + abx * t);
    const dz = z - (az + abz * t);
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
};

/** Signed cross-channel offset from the Tiber centreline, in metres (negative = west). */
export const riverOffset = (x: number, z: number): number => x - riverCentreX(z);

/** How much the ford shallows the channel at this z: 1 on the shoal, 0 away from it. */
export const fordFactor = (z: number): number =>
  Math.exp(-Math.pow((z - FORD_Z) / FORD_SIGMA, 2));

/**
 * Cross-section of the Tiber valley: returns the ground height for a point `d` metres
 * from the centreline. Handles channel, point bar, cut bank, flood terrace and the
 * step up to the plain, and shallows out over the ford.
 */
export const riverProfile = (d: number, z: number, plainH: number): number => {
  const ford = fordFactor(z);
  const ad = Math.abs(d);

  // The current runs fastest round the outside of a bend, so that bank is undercut
  // while the inside of the bend silts up into a bar. `side` is the cut-bank side.
  const side = riverCurvature(z) > 0 ? 1 : -1;
  const onCutBank = d * side > 0;

  const half = RIVER_HALF_WIDTH * (1 + ford * 0.85); // the shoal is a wide, braided crossing
  const depth = 4.6 - ford * 3.95; // 4.6 m in the reach, 0.65 m over the ford
  const thalweg = WATER_LEVEL - depth;

  // Channel floor: a parabola whose deepest point is pushed a quarter-width toward
  // the cut bank, which is where a real meander's thalweg sits.
  const u = Math.max(-1, Math.min(1, d / half));
  const uDeep = side * 0.25;
  const t = Math.min(1, Math.abs(u - uDeep) / (1 + Math.abs(uDeep)));
  const floor = thalweg + depth * t * t;

  // Cut banks are short and steep; point bars run out gently into sand.
  const bankRun = onCutBank ? 15 : 82;
  const terraceH = WATER_LEVEL + (onCutBank ? 2.8 : 0.8) - ford * 0.55;
  const terraceOuter = onCutBank ? 112 : 156;
  const stepRun = onCutBank ? 26 : 44;

  let h = floor;
  const toBank = Math.min(1, Math.max(0, (ad - half) / bankRun));
  const sb = toBank * toBank * (3 - 2 * toBank);
  h += (terraceH - h) * sb;
  const toPlain = Math.min(1, Math.max(0, (ad - terraceOuter) / stepRun));
  const sp = toPlain * toPlain * (3 - 2 * toPlain);
  return h + (plainH - h) * sp;
};

/** 1 inside the river valley's zone of influence, 0 on the untouched plain. */
export const riverInfluence = (d: number, z: number): number => {
  const outer = 200 + fordFactor(z) * 60;
  const t = 1 - Math.min(1, Math.max(0, (Math.abs(d) - outer) / 66));
  return t * t * (3 - 2 * t);
};

/**
 * GLSL mirror of the handful of functions the ground material needs per pixel.
 * Injected into the terrain fragment shader. Constants are duplicated on purpose:
 * uploading them as uniforms would cost more than it saves and this keeps the shader
 * readable. If you change a centreline above, change it here too.
 */
export const TOPO_GLSL = /* glsl */ `
const float TOPO_WATER_LEVEL = ${WATER_LEVEL.toFixed(3)};
const float TOPO_RIVER_HALF = ${RIVER_HALF_WIDTH.toFixed(3)};
const float TOPO_ROAD_HALF = ${ROAD_HALF_WIDTH.toFixed(3)};
const float TOPO_AGGER_HALF = ${AGGER_HALF_WIDTH.toFixed(3)};

float topoRiverCentreX(float z) {
  return -760.0 + 130.0 * sin(z * 0.0023256) + 50.0 * sin(z * 0.0060606 + 1.3);
}
float topoRoadCentreX(float z) {
  return 20.0 + 34.0 * sin((z + 300.0) * 0.0018519) - 18.0 * sin((z + 900.0) * 0.0033333);
}
float topoFord(float z) {
  float t = (z - ${FORD_Z.toFixed(1)}) / ${FORD_SIGMA.toFixed(1)};
  return exp(-t * t);
}
`;
