import { Rng } from '../../util/rand';
import { blurField, hydraulicErode } from '../../terrain/erosion';
import { fbm, gnoise, ridged, sstep, warpedFbm } from '../../terrain/noise';
import { FIELD_RES, FIELD_SPACING, sampleBilinear, type TerrainData } from '../../terrain/heightfield';
import {
  BYRSA_X,
  BYRSA_Z,
  HALF_EXTENT,
  ROAD_HALF_WIDTH,
  SEA_LEVEL,
  SEGUIAS,
  WADI_HALF_WIDTH,
  WALL_BENCH_HALF,
  battleCoreMask,
  carthageWallZ,
  gulfEdgeX,
  lagoonEdgeX,
  punicDeployMask,
  regionalLand,
  roadCentreX,
  romanDeployMask,
  seguiaDistance,
  wadiInfluence,
  wadiProfile,
  wadiZ,
} from './topography';

/**
 * Builds the heightfield for the isthmus of Carthage.
 *
 * Same five-stage pipeline as the other two maps — analytic macro form, droplet erosion on a
 * 1025² working grid, Catmull-Rom upsample to 2049², human marks at full resolution, control
 * texture from the erosion by-products — and it has to be, because `TerrainData` is what the
 * clipmap, the splat material, the grass and the scatter all read. What differs is where the
 * budget goes:
 *
 *  - **Erosion is aimed at the two hills and nowhere else.** The isthmus is a coastal plain
 *    two metres above a lagoon; there is no drainage network on it to find, and droplets
 *    spent there would only add noise nobody can see. The Byrsa and Bordj Djedid are the
 *    whole relief of this map, and gullied flanks are what make a 40 m hill read as a
 *    landform instead of as a bump.
 *  - **A bench is graded under the wall line.** No other map needs this. Carthage's curtain
 *    runs 2.8 km across the frame and `buildWall` levels each bay to its own ground, so
 *    unbenched terrain gives a curtain that steps by metres between neighbouring bays — which
 *    is not merely ugly, it breaks the garrison: `Siege.layOutGarrison` walks a continuous
 *    run along the walkway and a 3 m step between bays is a cliff in the middle of it.
 *  - **The shores are protected from the erosion pass.** A hydraulic droplet on a dead-flat
 *    sabkha at 0.9 m deposits its load into a puddle, and the salt pan comes out pitted.
 *
 * The control texture's four channels carry the same meanings the shader contract fixes, but
 * on a North African coast in August they describe different things — see stage 5.
 */

/** Working grid for the expensive noise and erosion stages. Matches the other two maps. */
const WORK_RES = 1025;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Catmull-Rom weights for the halfway sample of a 2× upsample. */
const UP_A = -1 / 16;
const UP_B = 9 / 16;

/**
 * How much of the mainland's own relief survives on the two hills, and how little on the
 * plain. Separated out because it is read twice: once to add relief and once to decide where
 * the erosion pass is allowed to work.
 */
const uplandWeight = (x: number, z: number): number => {
  const byrsa = Math.exp(-Math.pow(Math.hypot((x - BYRSA_X) / 320, (z - BYRSA_Z) / 400), 2));
  const djedid = Math.exp(-Math.pow(Math.hypot((x - 615) / 330, (z - 1195) / 265), 2));
  return Math.max(byrsa, djedid * 0.8);
};

/**
 * 1 on the dry crown of the isthmus, 0 at either water's edge.
 *
 * Every subtractive mark on this map is multiplied by it. Nothing may cut into a shore: a
 * sabkha is flat by definition, a beach berm's structure comes from the shore terms rather
 * than from noise, and — the reason it is a shared helper rather than three local
 * expressions — the ground there sits under a metre, so a channel 1.6 m deep or a detail
 * octave of 0.7 m puts it through the datum, and this map has no water surface to hide that.
 */
const dryLand = (x: number, z: number): number =>
  1 - Math.max(
    1 - sstep(0, 300, x - lagoonEdgeX(z)),
    1 - sstep(0, 200, gulfEdgeX(z) - x),
  );

/** The macro landform plus its fBm relief, before any human marks or the exact wadi bed. */
function baseHeight(x: number, z: number, seed: number): number {
  let h = regionalLand(x, z);

  const core = battleCoreMask(x, z);
  const upland = uplandWeight(x, z);
  const dry = dryLand(x, z);

  // --- Relief on the isthmus ------------------------------------------------
  // Broad swells at a 560 m wavelength, warped so they are lobed rather than sinusoidal.
  // Small: 2.2 m, against Pydna's 3.4. This is a marine terrace on a coastal plain, not a
  // piedmont, and the flatness is why an isthmus is where a wall gets built.
  h += warpedFbm(x, z, 4, 1 / 560, seed + 1, 0.9) * 2.2 * dry;
  // The band that reads. 145 m wavelength at 2.4 m — invisible to a man, and under a low
  // African sun the thing that models the plain into lit and shaded faces. Damped to 38 % in
  // the fighting corridor, between Pydna's 55 % and the Campus Martius' 20 %.
  h += fbm(x, z, 3, 1 / 145, seed + 2) * 2.4 * dry * (1 - 0.62 * core);
  // Surface roughness. Damped hard in the corridor: at this scale it would only trip
  // formation spacing without reading in any frame.
  h += fbm(x, z, 3, 1 / 38, seed + 3) * 0.38 * dry * (1 - 0.7 * core);

  // --- The two hills --------------------------------------------------------
  // Ridged multifractal on the Byrsa and Bordj Djedid only. Few octaves and a low gain: the
  // fine structure of a hillside should come out of the erosion pass, not out of noise, or
  // the slopes read as corduroy. These are calcarenite hills — soft marine sandstone — so
  // they weather to rounded shoulders with steep gullied noses, which is what the pass gives.
  //
  // The offset is 0.46 rather than a nominal 0.5 and the amplitude 15 rather than 26. Both
  // were set by measuring the built field, not by taste: `uplandWeight` peaks at the summit
  // and so does a ridged multifractal, so the two *add* there instead of averaging, and at
  // the first amplitude the Byrsa came out at 76.5 m against a real hill of 60.
  h += upland * (ridged(x, z, 4, 1 / 340, seed + 11, 0.44) - 0.46) * 15;
  h += upland * fbm(x, z, 3, 1 / 96, seed + 12) * 2.4;

  // --- The wadi -------------------------------------------------------------
  // Tapered off by `dry`, so the channel loses itself as it reaches the salt pan. That is
  // what a wadi entering a sabkha does — it spreads into a delta of fines and stops being a
  // channel — and it is also load-bearing: cutting 1.6 m into ground the shore terms hold at
  // 0.9 m puts the bed below the datum, and there is no water surface on this map to fill it.
  const d = z - wadiZ(x);
  const inf = wadiInfluence(d) * dry;
  if (inf > 0.001) h += (wadiProfile(d, h) - h) * inf;

  return h;
}

/**
 * Floor the field just clear of the datum, smoothly.
 *
 * The last line of defence, and it is needed because the shore terms are not the only thing
 * that can dig: the detail octave adds ±0.7 m on a slope, the erosion pass moves material,
 * and a channel cut near a shore compounds with both. A hard `Math.max` would leave a visible
 * shelf wherever it bit; a softplus never quite reaches the floor and is smooth in its first
 * derivative, so the pan simply stops descending instead of hitting a plate.
 *
 * Costs about 0.1 m of lift on genuinely low ground and nothing measurable above 1.5 m.
 */
const FLOOR = 0.25;
const FLOOR_KNEE = 0.35;
const softFloor = (h: number): number => {
  const t = h - FLOOR;
  // Past six knees the softplus is the identity to within a float epsilon, and `exp` of a
  // large argument is an overflow waiting to happen in the one place it is called 4.2 M times.
  if (t > FLOOR_KNEE * 6) return h;
  return FLOOR + FLOOR_KNEE * Math.log1p(Math.exp(t / FLOOR_KNEE));
};

export function buildCarthageTerrain(seedLabel = 'carthage-146bc'): TerrainData {
  const t0 = performance.now();
  const rng = new Rng(seedLabel);
  const seed = rng.getState() & 0xffff;

  // ---------------------------------------------------------------------
  // 1. Base form on the working grid
  // ---------------------------------------------------------------------
  const wres = WORK_RES;
  const wspacing = (HALF_EXTENT * 2) / (wres - 1);
  const work = new Float32Array(wres * wres);
  for (let j = 0; j < wres; j++) {
    const wz = -HALF_EXTENT + j * wspacing;
    const row = j * wres;
    for (let i = 0; i < wres; i++) {
      work[row + i] = baseHeight(-HALF_EXTENT + i * wspacing, wz, seed);
    }
  }

  // ---------------------------------------------------------------------
  // 2. Erosion, confined to the hills and the wadi's banks.
  // ---------------------------------------------------------------------
  const hillRegion = (i: number, j: number): number => {
    const x = -HALF_EXTENT + i * wspacing;
    const z = -HALF_EXTENT + j * wspacing;
    const bank = 1 - sstep(34, 170, Math.abs(z - wadiZ(x)));
    // Nothing at either shore, whatever else says so: a droplet on a salt pan pits it.
    const shore = Math.max(
      1 - sstep(0, 340, x - lagoonEdgeX(z)),
      1 - sstep(0, 240, gulfEdgeX(z) - x),
    );
    return Math.max(uplandWeight(x, z), bank * 0.7) * (1 - shore);
  };
  const maps = hydraulicErode(work, wres, rng.fork('erode'), hillRegion, {
    // Soft calcarenite in a semi-arid climate: rare violent storms that cut hard and dump
    // their load as coarse fans the moment the gradient breaks. High capacity, high erode
    // rate, and a deposit rate to match so the fans actually build.
    inertia: 0.038,
    capacity: 4.2,
    erodeRate: 0.4,
    depositRate: 0.38,
    hillBias: 0.78,
  });

  // ---------------------------------------------------------------------
  // 3. Upsample to the final grid, then a fine octave weighted by local slope.
  // ---------------------------------------------------------------------
  const res = FIELD_RES;
  const spacing = FIELD_SPACING;
  const heights = new Float32Array(res * res);

  const midRow = new Float32Array(res * wres);
  const cr = (a: number, b: number, c: number, d: number): number =>
    UP_A * a + UP_B * b + UP_B * c + UP_A * d;
  for (let j = 0; j < wres; j++) {
    const src = j * wres;
    const dst = j * res;
    for (let i = 0; i < wres; i++) {
      midRow[dst + i * 2] = work[src + i];
      if (i * 2 + 1 < res) {
        const im1 = i > 0 ? i - 1 : 0;
        const ip1 = i + 1 < wres ? i + 1 : wres - 1;
        const ip2 = i + 2 < wres ? i + 2 : wres - 1;
        midRow[dst + i * 2 + 1] = cr(work[src + im1], work[src + i], work[src + ip1], work[src + ip2]);
      }
    }
  }
  for (let j = 0; j < wres; j++) {
    const jm1 = j > 0 ? j - 1 : 0;
    const jp1 = j + 1 < wres ? j + 1 : wres - 1;
    const jp2 = j + 2 < wres ? j + 2 : wres - 1;
    const dstA = j * 2 * res;
    const dstB = (j * 2 + 1) * res;
    for (let i = 0; i < res; i++) {
      heights[dstA + i] = midRow[j * res + i];
      if (j * 2 + 1 < res) {
        heights[dstB + i] = cr(
          midRow[jm1 * res + i],
          midRow[j * res + i],
          midRow[jp1 * res + i],
          midRow[jp2 * res + i],
        );
      }
    }
  }

  const detailSeed = seed + 31;
  for (let j = 1; j < res - 1; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    for (let i = 1; i < res - 1; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const gx = (heights[row + i + 1] - heights[row + i - 1]) / (2 * spacing);
      const gz = (heights[row + res + i] - heights[row - res + i]) / (2 * spacing);
      const slope = clamp01(Math.hypot(gx, gz));
      const n =
        gnoise(wx * 0.036, wz * 0.036, detailSeed) * 0.62 +
        gnoise(wx * 0.105, wz * 0.105, detailSeed + 7) * 0.38;
      // Lower baseline than Pydna's 0.17: half this map is worked garden soil and salt pan,
      // both of which really are smooth, and the slope term still roughens the hills.
      heights[row + i] += n * (0.12 + 0.6 * slope);
    }
  }

  // ---------------------------------------------------------------------
  // 4. Human marks and the exact wadi bed, at full resolution.
  // ---------------------------------------------------------------------
  const rowRoadX = new Float32Array(res);
  const colWadiZ = new Float32Array(res);
  for (let k = 0; k < res; k++) {
    rowRoadX[k] = roadCentreX(-HALF_EXTENT + k * spacing);
    colWadiZ[k] = wadiZ(-HALF_EXTENT + k * spacing);
  }

  // -- 4a. Re-impose the wadi. Erosion and the upsample both smear the bed, and the braided
  //        gravel the splat rules paint needs a clean flat floor to sit in.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const d = wz - colWadiZ[i];
      if (Math.abs(d) > 90) continue;
      const inf = wadiInfluence(d) * dryLand(-HALF_EXTENT + i * spacing, wz);
      if (inf < 0.002) continue;
      const h = heights[row + i];
      const prof = wadiProfile(d, h);
      const strength = Math.abs(d) < WADI_HALF_WIDTH ? 1 : 0.8;
      heights[row + i] = h + (prof - h) * inf * strength;
      // Bars in the braid: a dry bed is not a flat floor, it is shingle islands with dry
      // channels between them.
      if (Math.abs(d) < WADI_HALF_WIDTH * 1.4) {
        const bar = gnoise(-HALF_EXTENT + i * spacing * 0.06, wz * 0.13, seed + 41);
        heights[row + i] += bar * 0.4 * inf;
      }
    }
  }

  // -- 4b. The irrigation channels. Cut before the deployment flattening, which is then
  //        masked away from them, so the boxes do not erase the one thing giving the flattest
  //        part of the map a shadow line.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    if (wz < -420 || wz > 400) continue;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      // Nobody digs an irrigation channel into a salt pan or a dune, and cutting one there
      // would take the ground under the datum.
      const dry = dryLand(wx, wz);
      if (dry < 0.02) continue;
      for (let k = 0; k < SEGUIAS.length; k++) {
        const s = SEGUIAS[k];
        const d = Math.abs(seguiaDistance(k, wx, wz));
        if (d > s.width * 2.2) continue;
        const cut = (1 - sstep(s.width * 0.5, s.width * 1.5, d)) * dry;
        if (cut < 0.004) continue;
        // A dug channel is far more even along its length than a watercourse, but a hand-cut
        // one silts and is redug in patches, so it is not uniform either.
        const vary = 0.74 + 0.36 * (0.5 + 0.5 * gnoise(wx * 0.0062, wz * 0.0062, seed + 51 + k));
        heights[row + i] -= cut * s.depth * vary;
        // The spoil bank on the downhill lip, which is where the channel's own dredgings go.
        heights[row + i] += Math.exp(-Math.pow((d - s.width * 1.4) / (s.width * 0.45), 2)) * 0.12;
      }
    }
  }

  // -- 4c. Deployment zones onto the regional plane.
  //
  //        0.8, between Rome's 0.9 and Pydna's 0.72. There is less to preserve here than at
  //        Pydna — the swells are 2.4 m rather than 3.3 and the battle does not turn on them
  //        — and more to gain: this is where a Roman siege line stood for three years, and
  //        ground an army has camped on and levelled *is* flat.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    if (wz < -350 || wz > 300) continue;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const m = Math.max(romanDeployMask(wx, wz), punicDeployMask(wx, wz));
      if (m < 0.002) continue;
      const target = regionalLand(wx, wz);
      heights[row + i] += (target - heights[row + i]) * m * 0.8;
    }
  }

  // -- 4d. **The bench under the wall line.**
  //
  //        This is the one stage no other map has, and it is a gameplay requirement rather
  //        than an aesthetic one. `buildWall` levels each bay to the ground under it, so an
  //        ungraded coastal plain with 2.4 m swells at a 145 m wavelength gives neighbouring
  //        bays that differ by two or three metres — and `Siege.layOutGarrison` walks one
  //        continuous run of stations along the walkway, so a 3 m step between bays is a
  //        cliff in the middle of the garrison. Real curtain walls are built on a graded
  //        footing for exactly this reason.
  //
  //        Smoothed along its own length rather than flattened to a constant: the wall should
  //        still climb toward the Byrsa end, it should just do it evenly.
  const benchProfile = new Float32Array(res);
  for (let i = 0; i < res; i++) {
    const wx = -HALF_EXTENT + i * spacing;
    benchProfile[i] = sampleBilinear(heights, res, spacing, wx, carthageWallZ(wx));
  }
  smooth1D(benchProfile, 26);
  for (let i = 0; i < res; i++) {
    const wx = -HALF_EXTENT + i * spacing;
    const cz = carthageWallZ(wx);
    const base = benchProfile[i];
    const j0 = Math.max(0, Math.floor((cz - WALL_BENCH_HALF * 2.2 + HALF_EXTENT) / spacing));
    const j1 = Math.min(res - 1, Math.ceil((cz + WALL_BENCH_HALF * 2.2 + HALF_EXTENT) / spacing));
    for (let j = j0; j <= j1; j++) {
      const wz = -HALF_EXTENT + j * spacing;
      const d = Math.abs(wz - cz);
      const w = 1 - sstep(WALL_BENCH_HALF, WALL_BENCH_HALF * 2.1, d);
      if (w < 0.002) continue;
      const k = j * res + i;
      heights[k] += (base - heights[k]) * w * 0.92;
    }
  }

  // -- 4e. The road from Tunes. A metalled Punic trunk road: graded and slightly crowned,
  //        unlike Pydna's worn cart track, but not the 1.1 m agger of a consular via.
  const roadProfile = new Float32Array(res);
  for (let j = 0; j < res; j++) {
    roadProfile[j] = sampleBilinear(heights, res, spacing, rowRoadX[j], -HALF_EXTENT + j * spacing);
  }
  smooth1D(roadProfile, 18);
  for (let j = 0; j < res; j++) {
    const row = j * res;
    const cx = rowRoadX[j];
    const base = roadProfile[j];
    const i0 = Math.max(0, Math.floor((cx - 20 + HALF_EXTENT) / spacing));
    const i1 = Math.min(res - 1, Math.ceil((cx + 20 + HALF_EXTENT) / spacing));
    for (let i = i0; i <= i1; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const d = Math.abs(wx - cx);
      const w = 1 - sstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 9, d);
      if (w < 0.002) continue;
      const target = base + 0.22 * (1 - sstep(0, ROAD_HALF_WIDTH, d));
      heights[row + i] += (target - heights[row + i]) * w * 0.75;
    }
  }

  // -- 4f. Floor the whole field just clear of the datum. Last, because every stage above it
  //        can dig. See `softFloor`.
  for (let k = 0; k < heights.length; k++) heights[k] = softFloor(heights[k]);

  // ---------------------------------------------------------------------
  // 5. Control texture.
  //
  //    Same four channels as the other maps, because the shader contract is shared. On a
  //    North African coast at the end of a dry summer they mean:
  //      R  water: the wadi bed, the irrigation channels, and the gardens they feed — which
  //         is the only green on this map and the only reason a city of a quarter of a
  //         million people could stand here
  //      G  bedrock: calcarenite scoured bare on the hills and on the wave-cut coast
  //      B  trodden: the siege lines, the road, the tracks to the water
  //      A  evaporite and fines: the salt crust of the sabkha and the shell sand of the
  //         beach, which is what the two shores are painted from
  // ---------------------------------------------------------------------
  const flow = blurField(maps.flow, wres, 2);
  const rock = blurField(maps.eroded, wres, 2);
  const silt = blurField(maps.deposited, wres, 2);
  let flowMax = 1e-6;
  let rockMax = 1e-6;
  let siltMax = 1e-6;
  for (let i = 0; i < flow.length; i++) {
    if (flow[i] > flowMax) flowMax = flow[i];
    if (rock[i] > rockMax) rockMax = rock[i];
    if (silt[i] > siltMax) siltMax = silt[i];
  }

  const control = new Uint8Array(wres * wres * 4);
  for (let j = 0; j < wres; j++) {
    const wz = -HALF_EXTENT + j * wspacing;
    for (let i = 0; i < wres; i++) {
      const wx = -HALF_EXTENT + i * wspacing;
      const k = j * wres + i;
      const rx = roadCentreX(wz);
      const toLagoon = 1 - sstep(0, 340, wx - lagoonEdgeX(wz));
      const toGulf = 1 - sstep(0, 240, gulfEdgeX(wz) - wx);

      // Water. Tighter even than Pydna's: this is August in Africa, the wadi is dry, and the
      // only reliably damp ground on the field is the bottom of a channel someone is paying
      // to keep flowing.
      let wet = clamp01(Math.log1p((flow[k] / flowMax) * 48) / Math.log(49)) * 0.4;
      const dWadi = Math.abs(wz - wadiZ(wx));
      wet = Math.max(wet, (1 - sstep(WADI_HALF_WIDTH, 46, dWadi)) * 0.62);
      for (let r = 0; r < SEGUIAS.length; r++) {
        const d = Math.abs(seguiaDistance(r, wx, wz));
        wet = Math.max(wet, (1 - sstep(SEGUIAS[r].width * 0.5, SEGUIAS[r].width * 2.6, d)) * 0.72);
      }
      wet *= 0.6 + 0.4 * (0.5 + 0.5 * gnoise(wx * 0.0061, wz * 0.0061, seed + 91));

      // Bedrock: scoured hillside, and the wave-cut platform where the gulf has stripped the
      // dune belt back to the calcarenite it sits on.
      let bare = clamp01((rock[k] / rockMax) * 3.0);
      bare = Math.max(bare, uplandWeight(wx, wz) * sstep(0.14, 0.42, slopeOfWork(work, wres, wspacing, i, j)) * 0.9);
      bare = Math.max(bare, toGulf * clamp01(gnoise(wz * 0.011, 0, seed + 94) * 1.6) * 0.5);

      // Trodden. Three years of siege lines on the isthmus is the heaviest trampling on any
      // map in this project, and it is held at 0.42 rather than Rome's 0.34 for that reason.
      const churn =
        0.34 +
        0.44 * (0.5 + 0.5 * gnoise(wx * 0.0095, wz * 0.0095, seed + 92)) +
        0.3 * (0.5 + 0.5 * gnoise(wx * 0.04, wz * 0.04, seed + 93));
      let tramp = Math.max(romanDeployMask(wx, wz), punicDeployMask(wx, wz)) * 0.42 * churn;
      tramp = Math.max(tramp, (1 - sstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 8, Math.abs(wx - rx))) * 0.88);
      // The strip immediately outside the wall is the cleared glacis: swept, beaten and
      // walked over by every working party in the siege.
      const glacis = 1 - sstep(20, 130, Math.abs(wz - carthageWallZ(wx)));
      tramp = Math.max(tramp, glacis * 0.55 * churn);

      // Evaporite and fines. This is the channel that makes the map look like North Africa:
      // the salt pan on the left, the shell beach on the right, and the fans at the foot of
      // the Byrsa in between.
      let fines = clamp01((silt[k] / siltMax) * 3.4);
      fines = Math.max(fines, toLagoon * 0.95);
      fines = Math.max(fines, toGulf * 0.85);
      fines = Math.max(fines, (1 - sstep(WADI_HALF_WIDTH * 1.5, 48, dWadi)) * 0.7);

      control[k * 4] = (clamp01(wet) * 255) | 0;
      control[k * 4 + 1] = (clamp01(bare) * 255) | 0;
      control[k * 4 + 2] = (clamp01(tramp) * 255) | 0;
      control[k * 4 + 3] = (clamp01(fines) * 255) | 0;
    }
  }

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (v < minHeight) minHeight = v;
    if (v > maxHeight) maxHeight = v;
  }
  /**
   * Nothing may go under the datum, and nothing may tower over the Byrsa. Both bounds are
   * checked because both have already been wrong once and neither is visible in a typecheck.
   *
   * There is no water surface on this map, so ground below sea level is a hole the splat
   * rules have no material for. Four things defend the floor — the shore terms in
   * `regionalLand`, the erosion mask, the `dryLand` taper on the wadi and the channels, and
   * `softFloor` — and the first build had three of them and still came out at −2.93 m.
   *
   * The ceiling is the Byrsa. The real hill is about 60 m; the first build put it at 76.5
   * because the ridged relief peaks exactly where the analytic hill does. 70 is the line.
   */
  if (minHeight < SEA_LEVEL + 0.15) {
    console.warn(
      `[carthage] lowest ground is ${minHeight.toFixed(2)} m, at or below the datum — ` +
        'the shore terms, the erosion mask or the dryLand taper have drifted',
    );
  }
  if (maxHeight > 70) {
    console.warn(
      `[carthage] the Byrsa reaches ${maxHeight.toFixed(1)} m against a real hill of ~60 — ` +
        'BYRSA_RISE and the upland ridged amplitude add at the summit, they do not average',
    );
  }

  return {
    heights,
    res,
    spacing,
    minHeight,
    maxHeight,
    control,
    controlRes: wres,
    buildMs: performance.now() - t0,
  };
}

/** Slope of the working grid at a cell, 0 flat .. 1 vertical. Central difference, clamped. */
function slopeOfWork(
  work: Float32Array, wres: number, wspacing: number, i: number, j: number,
): number {
  const im = i > 0 ? i - 1 : 0;
  const ip = i < wres - 1 ? i + 1 : wres - 1;
  const jm = j > 0 ? j - 1 : 0;
  const jp = j < wres - 1 ? j + 1 : wres - 1;
  const gx = (work[j * wres + ip] - work[j * wres + im]) / ((ip - im) * wspacing);
  const gz = (work[jp * wres + i] - work[jm * wres + i]) / ((jp - jm) * wspacing);
  const m = Math.hypot(gx, gz);
  return m > 1 ? 1 : m;
}

/** In-place box smoothing of a 1-D profile, used to grade the road and the wall bench. */
function smooth1D(a: Float32Array, radius: number): void {
  const n = a.length;
  const tmp = new Float32Array(n);
  const w = radius * 2 + 1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const x = i + k;
      s += a[x < 0 ? 0 : x >= n ? n - 1 : x];
    }
    tmp[i] = s / w;
  }
  a.set(tmp);
}
