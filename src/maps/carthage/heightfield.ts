import { Rng } from '../../util/rand';
import { blurField, hydraulicErode } from '../../terrain/erosion';
import { fbm, gnoise, ridged, sstep, warpedFbm } from '../../terrain/noise';
import { FIELD_RES, FIELD_SPACING, sampleBilinear, type TerrainData } from '../../terrain/heightfield';
import {
  BYRSA_SUMMIT,
  BYRSA_X,
  BYRSA_Z,
  HALF_EXTENT,
  ROAD_HALF_WIDTH,
  SEGUIAS,
  WADI_HALF_WIDTH,
  WALL_BENCH_HALF,
  WALL_X_MAX,
  WALL_X_MIN,
  arianaEdgeX,
  battleCoreMask,
  carthageWallZ,
  coastZ,
  lakeEdgeX,
  punicDeployMask,
  regionalLand,
  roadCentreX,
  romanDeployMask,
  seguiaDistance,
  softGround,
  taeniaNess,
  wadiInfluence,
  wadiProfile,
  wadiZ,
} from './topography';

/**
 * Builds the heightfield for the isthmus of Carthage, spring 146 BC. Built to
 * `docs/CARTHAGE.md` §2 and §3.
 *
 * Same five-stage pipeline as the other two maps — analytic macro form, droplet erosion on a
 * 1025² working grid, Catmull-Rom upsample to 2049², human marks at full resolution, control
 * texture from the erosion by-products — and it has to be, because `TerrainData` is what the
 * clipmap, the splat material, the grass and the scatter all read. What differs is where the
 * budget goes, and three stages are unlike anything the other maps do:
 *
 *  - **A bench under the wall line.** §3.1: at Rome the wall stands on a 22–34 m rise and an
 *    attacker climbs 175 m of slope under fire; the Carthaginian isthmus is a flat neck and
 *    the wall carries all of its defence in stone. The bench is *not* a rise — it levels the
 *    footing without raising it, because the flatness is the design. It is a gameplay
 *    requirement: `buildWall` levels each bay to the ground under it, so unbenched terrain
 *    gives neighbouring bays differing by metres, and `Siege.layOutGarrison` walks one
 *    continuous run of stations along the walkway. A 3 m step between bays is a cliff in the
 *    middle of the garrison.
 *  - **Erosion is confined to the two hills.** There is no drainage network to find on a
 *    coastal neck two metres above a lagoon, and a droplet on a salt pan pits it.
 *  - **Nothing may dig near water, and the shore must plunge.** See `SHORE_SCARP_DEPTH` in
 *    `topography.ts`: the pathfinder marks a cell impassable above gradient 0.62, and that
 *    scarp is the only thing on this map stopping an army walking into the Gulf of Tunis.
 *
 * The control texture's four channels carry the meanings the shader contract fixes, but on
 * this coast in April they describe different things — see stage 5.
 */

/** Working grid for the expensive noise and erosion stages. Matches the other two maps. */
const WORK_RES = 1025;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Catmull-Rom weights for the halfway sample of a 2× upsample. */
const UP_A = -1 / 16;
const UP_B = 9 / 16;

/**
 * Weight of the two hills, for the relief octaves and the erosion mask.
 *
 * Deliberately wider than the hills' own footprints so their skirts get gullies too, and
 * `max`ed rather than summed for the same reason `regionalLand` maxes the hills themselves.
 */
const uplandWeight = (x: number, z: number): number => {
  const byrsa = Math.exp(-Math.pow(Math.hypot((x - BYRSA_X) / 230, (z - BYRSA_Z) / 145), 2));
  const djedid = Math.exp(-Math.pow(Math.hypot((x - 210) / 260, (z - 1037) / 175), 2));
  return Math.max(byrsa, djedid * 0.85);
};

/**
 * 1 on firm dry ground, 0 at a water's edge or on a salt margin.
 *
 * Every subtractive mark on this map is multiplied by it, and it is a shared helper rather
 * than three local expressions because the reason is shared: near the water the ground sits
 * under two metres, so a 1.6 m channel or a 0.7 m detail octave puts it through the datum —
 * and below the datum, on a map with no water surface, is a hole the splat has no material
 * for and the pathfinder reads as a beach.
 */
const dryLand = (x: number, z: number): number => {
  const nearLake = 1 - sstep(0, 280, x - lakeEdgeX(z));
  const nearCoast = 1 - sstep(0, 220, coastZ(x) - z);
  const nearAriana = 1 - sstep(0, 240, arianaEdgeX(z) - x);
  return 1 - Math.max(nearLake, Math.max(nearCoast, nearAriana));
};

/** The macro landform plus its fBm relief, before any human marks or the exact wadi bed. */
function baseHeight(x: number, z: number, seed: number): number {
  let h = regionalLand(x, z);

  const core = battleCoreMask(x, z);
  const upland = uplandWeight(x, z);
  const dry = dryLand(x, z);

  // --- Relief on the isthmus ------------------------------------------------
  // Broad swells at a 560 m wavelength, warped so they are lobed rather than sinusoidal.
  // 2.0 m, against Pydna's 3.4: this is a marine terrace on a coastal neck, and the flatness
  // is the whole reason a wall got built across it (§3.1).
  h += warpedFbm(x, z, 4, 1 / 560, seed + 1, 0.9) * 2.0 * dry;
  // The band that reads. 145 m at 2.2 m — invisible to a man, and under a 20° sun the thing
  // that models the plain into lit and shaded faces. Damped to 38 % in the fighting corridor.
  h += fbm(x, z, 3, 1 / 145, seed + 2) * 2.2 * dry * (1 - 0.62 * core);
  // Surface roughness, damped hard in the corridor: at this scale it would trip formation
  // spacing without reading in any frame.
  h += fbm(x, z, 3, 1 / 38, seed + 3) * 0.36 * dry * (1 - 0.7 * core);

  // --- The two hills --------------------------------------------------------
  // Ridged multifractal on the Byrsa and Bordj Djedid only. Few octaves and a low gain: the
  // fine structure of a hillside comes out of the erosion pass, not out of noise, or the
  // slopes read as corduroy. These are calcarenite hills — soft marine sandstone — so they
  // weather to rounded shoulders with steep gullied noses, which is what the pass gives.
  //
  // **Weighted by `flank`, not by `upland`, and that is the whole trick.** `upland` peaks at
  // the summit and so does a ridged multifractal, so the two do not average there, they add —
  // and whichever way the noise happens to fall, the published summit height is the one number
  // on this hill that must survive. Weighted at `4u(1−u)` the relief is zero at the centre,
  // zero far away, and full at mid-flank, which is also where gullies belong on a hill that
  // weathers from its own drainage. Both errors have now been made and measured: at
  // `upland × 26` the Byrsa came out 16 m over its published 60, and at `upland × 9` it came
  // out 9 m under. Size hill relief against the measured field, never against the intent.
  const flank = 4 * upland * (1 - upland);
  h += flank * (ridged(x, z, 4, 1 / 300, seed + 11, 0.44) - 0.46) * 11;
  h += flank * fbm(x, z, 3, 1 / 90, seed + 12) * 2.2;

  // --- The wadi -------------------------------------------------------------
  // Tapered by `dry`, so the channel loses itself as it reaches the lake margin. That is what
  // a wadi entering a sabkha does — it spreads into a delta of fines and stops being a
  // channel — and it keeps the bed off the datum.
  const d = z - wadiZ(x);
  const inf = wadiInfluence(d) * dry;
  if (inf > 0.001) h += (wadiProfile(d, h) - h) * inf;

  return h;
}

/**
 * Floor the *dry land* just clear of the datum, smoothly — and leave the water alone.
 *
 * The floor is needed because the shore terms are not the only thing that can dig: the detail
 * octave adds ±0.7 m on a slope, the erosion pass moves material, and a channel cut near a
 * margin compounds with both. A hard `Math.max` would leave a visible shelf wherever it bit;
 * a softplus never quite reaches the floor and is smooth in its first derivative, so the pan
 * simply stops descending instead of hitting a plate.
 *
 * It is applied by *how dry the ground is*, not everywhere, because this map deliberately has
 * ground below the datum — the sea, and the scarp that keeps an army out of it.
 */
const FLOOR = 0.25;
const FLOOR_KNEE = 0.35;
const softFloor = (h: number, dry: number): number => {
  if (dry <= 0.001) return h;
  const t = h - FLOOR;
  // Past six knees the softplus is the identity to within a float epsilon, and `exp` of a
  // large argument is an overflow waiting to happen in the one place it is called 4.2 M times.
  const floored = t > FLOOR_KNEE * 6 ? h : FLOOR + FLOOR_KNEE * Math.log1p(Math.exp(t / FLOOR_KNEE));
  return h + (floored - h) * dry;
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
    // Flanks, not summits, for the same reason the relief octaves use `flank`: droplets take
    // material off the highest ground first, and the Byrsa's published 60 m is the number
    // this map exists to put on the skyline. Measured — with `uplandWeight` here the summit
    // came out at 48.8 m, eleven metres of citadel eroded away. It is also the right
    // landscape: gullies belong on a hillside, and the Byrsa's summit carried a built temple
    // platform that no drainage ever crossed.
    const u = uplandWeight(x, z);
    const flank = 4 * u * (1 - u);
    // Nothing near water, whatever else says so: a droplet on a salt pan pits it, and a
    // droplet on the scarp would grade the one slope holding an army back from the sea.
    return Math.max(flank, bank * 0.7) * clamp01(dryLand(x, z));
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
      // Lower baseline than Pydna's 0.17: half this map is worked garden soil, salt pan and
      // beaten siege ground, all of which really are smooth. The slope term still roughens
      // the two hills.
      //
      // Suppressed on the scarp. A 0.7 m wobble on a 0.79 gradient is nothing to look at and
      // everything to the pathfinder, which samples the gradient over 7 m and would find
      // walkable notches in the one slope keeping an army out of the sea.
      const onScarp = sstep(0.45, 0.72, slope);
      heights[row + i] += n * (0.12 + 0.6 * slope) * (1 - onScarp);
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
      const wx = -HALF_EXTENT + i * spacing;
      const d = wz - colWadiZ[i];
      if (Math.abs(d) > 90) continue;
      const inf = wadiInfluence(d) * clamp01(dryLand(wx, wz));
      if (inf < 0.002) continue;
      const h = heights[row + i];
      const prof = wadiProfile(d, h);
      const strength = Math.abs(d) < WADI_HALF_WIDTH ? 1 : 0.8;
      heights[row + i] = h + (prof - h) * inf * strength;
      // Bars in the braid: a dry bed is not a flat floor, it is shingle islands with dry
      // channels between them.
      if (Math.abs(d) < WADI_HALF_WIDTH * 1.4) {
        const bar = gnoise(wx * 0.06, wz * 0.13, seed + 41);
        heights[row + i] += bar * 0.4 * inf;
      }
    }
  }

  // -- 4b. The irrigation channels. Cut before the deployment flattening, which is then
  //        masked away from them, so the boxes do not erase the one thing giving the flattest
  //        ground on any of the three maps a shadow line.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    if (wz < -420 || wz > 460) continue;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      // Nobody digs an irrigation channel into a salt pan, and cutting one there would take
      // the ground under the datum.
      const dry = clamp01(dryLand(wx, wz));
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
  //        Pydna — the swells are 2.2 m rather than 3.3 and the battle does not turn on them
  //        — and more to gain: this is ground a Roman army camped on and levelled for three
  //        years, and ground an army has levelled *is* flat.
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

  // -- 4d. **The bench under the wall line.** See the header. Smoothed along its own length
  //        rather than flattened to a constant: the wall should still fall 121 m of z from
  //        the Ariana anchor to the lake anchor and rise a little with the ground under it,
  //        it should just do both evenly.
  const benchProfile = new Float32Array(res);
  for (let i = 0; i < res; i++) {
    const wx = -HALF_EXTENT + i * spacing;
    benchProfile[i] = sampleBilinear(heights, res, spacing, wx, carthageWallZ(wx));
  }
  smooth1D(benchProfile, 26);
  for (let i = 0; i < res; i++) {
    const wx = -HALF_EXTENT + i * spacing;
    // Only where the wall actually stands. Past its anchors the line is a mathematical
    // extension into water, and benching there would flatten the scarp.
    if (wx < WALL_X_MIN - 60 || wx > WALL_X_MAX + 60) continue;
    const ends = sstep(WALL_X_MIN - 60, WALL_X_MIN + 40, wx)
      * (1 - sstep(WALL_X_MAX - 40, WALL_X_MAX + 60, wx));
    const cz = carthageWallZ(wx);
    const base = benchProfile[i];
    const j0 = Math.max(0, Math.floor((cz - WALL_BENCH_HALF * 2.2 + HALF_EXTENT) / spacing));
    const j1 = Math.min(res - 1, Math.ceil((cz + WALL_BENCH_HALF * 2.2 + HALF_EXTENT) / spacing));
    for (let j = j0; j <= j1; j++) {
      const wz = -HALF_EXTENT + j * spacing;
      const d = Math.abs(wz - cz);
      const w = (1 - sstep(WALL_BENCH_HALF, WALL_BENCH_HALF * 2.1, d)) * ends;
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
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    const cx = rowRoadX[j];
    const base = roadProfile[j];
    const i0 = Math.max(0, Math.floor((cx - 20 + HALF_EXTENT) / spacing));
    const i1 = Math.min(res - 1, Math.ceil((cx + 20 + HALF_EXTENT) / spacing));
    for (let i = i0; i <= i1; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const d = Math.abs(wx - cx);
      const w = (1 - sstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 9, d)) * clamp01(dryLand(wx, wz));
      if (w < 0.002) continue;
      const target = base + 0.22 * (1 - sstep(0, ROAD_HALF_WIDTH, d));
      heights[row + i] += (target - heights[row + i]) * w * 0.75;
    }
  }

  // -- 4f. Floor the dry land just clear of the datum. Last, because every stage above it can
  //        dig, and weighted by dryness so the sea and its scarp survive. See `softFloor`.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      heights[row + i] = softFloor(heights[row + i], clamp01(dryLand(wx, wz)));
    }
  }

  // ---------------------------------------------------------------------
  // 5. Control texture.
  //
  //    Same four channels as the other maps, because the shader contract is shared. On this
  //    coast at the end of April they mean:
  //      R  water: the wadi bed, the irrigation channels and the gardens they feed — which is
  //         the only reason a city of a quarter of a million people could stand here
  //      G  bedrock: calcarenite scoured bare on the two hills and on the wave-cut coast
  //      B  trodden *and soft*: the siege lines, the road, the glacis — and, at the top of
  //         the range, the sabkha margins where a wheel sinks (§3.4). One channel carries
  //         both because a beaten surface and a soft one are the same thing to the splat
  //         rules (bare, no sward) and because there is no fifth channel; `softGround` is
  //         published separately for anything that needs the mechanic rather than the look.
  //      A  evaporite and fines: the salt crust of the two pans and the shell sand of the
  //         beach, which is what the shores are painted from
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
      const soft = softGround(wx, wz);

      // Water. Tighter even than Pydna's: this is the end of a North African dry season, the
      // wadi is dry, and the only reliably damp ground is the bottom of a channel someone is
      // paying to keep flowing.
      let wet = clamp01(Math.log1p((flow[k] / flowMax) * 48) / Math.log(49)) * 0.4;
      const dWadi = Math.abs(wz - wadiZ(wx));
      wet = Math.max(wet, (1 - sstep(WADI_HALF_WIDTH, 46, dWadi)) * 0.62);
      for (let r = 0; r < SEGUIAS.length; r++) {
        const d = Math.abs(seguiaDistance(r, wx, wz));
        wet = Math.max(wet, (1 - sstep(SEGUIAS[r].width * 0.5, SEGUIAS[r].width * 2.6, d)) * 0.72);
      }
      wet *= 0.6 + 0.4 * (0.5 + 0.5 * gnoise(wx * 0.0061, wz * 0.0061, seed + 91));

      // Bedrock: scoured hillside, and the wave-cut platform where the gulf has stripped the
      // dune belt back to the calcarenite under it.
      let bare = clamp01((rock[k] / rockMax) * 3.0);
      bare = Math.max(bare, uplandWeight(wx, wz)
        * sstep(0.14, 0.42, slopeOfWork(work, wres, wspacing, i, j)) * 0.9);

      // Trodden, and soft. Three years of siege lines on the isthmus is the heaviest
      // trampling on any map in this project.
      const churn =
        0.34 +
        0.44 * (0.5 + 0.5 * gnoise(wx * 0.0095, wz * 0.0095, seed + 92)) +
        0.3 * (0.5 + 0.5 * gnoise(wx * 0.04, wz * 0.04, seed + 93));
      let tramp = Math.max(romanDeployMask(wx, wz), punicDeployMask(wx, wz)) * 0.42 * churn;
      tramp = Math.max(tramp, (1 - sstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 8, Math.abs(wx - rx))) * 0.88);
      // The cleared glacis, swept and beaten by every working party in the siege.
      const glacis = 1 - sstep(20, 150, Math.abs(wz - carthageWallZ(wx)));
      tramp = Math.max(tramp, glacis * 0.6 * churn);
      // The sabkha margins occupy the top of the range, above anything trampling can reach,
      // so a consumer that wants only the soft ground can threshold this channel at 0.8.
      if (soft > 0.35) tramp = Math.max(tramp, 0.8 + 0.2 * soft);

      // Evaporite and fines: the two salt pans, the beach, the Taenia's sand and the fans at
      // the foot of the Byrsa. This is the channel that makes the map look like North Africa.
      let fines = clamp01((silt[k] / siltMax) * 3.4);
      fines = Math.max(fines, soft * 0.95);
      fines = Math.max(fines, taeniaNess(wx, wz) * 0.9);
      fines = Math.max(fines, (1 - sstep(0, 240, coastZ(wx) - wz)) * 0.85);
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

  assertSurveyElevations(heights, res, spacing);

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

/**
 * Grade the built field against `docs/CARTHAGE.md` §3.3 and §2.5, and say so out loud.
 *
 * **This is here because a survey that is not checked is a comment.** The whole point of §2.3
 * is that Carthage should be wrong only if the survey is wrong — and the survey reaches the
 * screen through five stages of noise, erosion, upsampling, benching and flooring, any one of
 * which can move a number by ten metres. A first pass at the Byrsa came out 16 m over its
 * published height because the hill's analytic form and its ridged relief both peak at the
 * summit and add there; nothing but a measurement would have caught that, and nothing did
 * until this ran.
 *
 * Warnings rather than throws, deliberately. A map that is 3 m out somewhere is still a map
 * the other three workstreams can build against, and a throw at module init is the failure
 * mode this project has already shipped three times.
 */
function assertSurveyElevations(heights: Float32Array, res: number, spacing: number): void {
  const at = (x: number, z: number): number => sampleBilinear(heights, res, spacing, x, z);
  /** [name, x, z, low, high] — the bounds are §3.3's, widened only by the noise amplitude. */
  const CHECKS: readonly [string, number, number, number, number][] = [
    ['Byrsa summit', BYRSA_X, BYRSA_Z, BYRSA_SUMMIT - 4, BYRSA_SUMMIT + 4],
    ['Odeon / north ridge', 210, 1037, 38, 52],
    ['lower town, W of the Byrsa', -180, 1000, 10, 20],
    ['harbour district', -600, 978, 1, 8],
    ['wall ground line, mid-span', 0, 527, 9, 16],
    // Inboard of the anchors, not at them. §3.3 gives the wall's ground line as 10–14 and
    // §2.2 says both its ends die on water; those cannot both hold at the last metre, and the
    // wall necessarily walks down to the waterline at each end. So the level is checked where
    // the wall stands on the isthmus and the *descent* is checked separately below.
    ['wall ground line, 700 m north', 700, 498, 6, 16],
    ['wall ground line, 700 m south', -700, 585, 6, 16],
    ['isthmus spine, at the siege line', 0, -196, 8, 15],
    ['Sebkhet Ariana', 1250, 300, -0.5, 2.5],
    ['Taenia crown', -1270, 200, 1.5, 7.5],
    ['open sea, beyond the coast', 400, 1330, -12, -4],
    ['head of the Lake of Tunis', -1060, 615, -12, -3],
  ];
  const bad: string[] = [];
  for (const [name, x, z, lo, hi] of CHECKS) {
    const h = at(x, z);
    if (!(h >= lo && h <= hi)) bad.push(`${name} ${h.toFixed(1)} m (want ${lo}..${hi})`);
  }
  if (bad.length) {
    console.warn(`[carthage] ${bad.length} survey elevation(s) off docs/CARTHAGE.md §3.3: ${bad.join('; ')}`);
  }

  /**
   * And the one thing §5.1a exists to prevent: a Byrsa you cannot walk up.
   *
   * The approach face runs in +x from the forum flat at x −290 to the summit at x 0
   * (§5.3), and it has to take three stepped streets and terraced housing. The spec's
   * override targets 1:3.8. Anything past 1:2.5 is a cliff and the fabric workstream will
   * discover it as unbuildable geometry rather than as a number.
   */
  /**
   * Both ends of the land wall must die on water (§2.2) — there is no flank march on this
   * map, and that claim is a *terrain* claim before it is a wall claim. If either anchor
   * stands on dry ground the whole tactical shape of the map changes and nothing else would
   * report it.
   */
  for (const [name, x, z] of [
    ['north anchor, Sebkhet Ariana', WALL_X_MAX + 130, carthageWallZ(WALL_X_MAX + 130)],
    ['south anchor, Lake of Tunis', WALL_X_MIN - 90, carthageWallZ(WALL_X_MIN - 90)],
  ] as const) {
    const h = at(x, z);
    if (h > 2.5) {
      console.warn(
        `[carthage] the wall's ${name} stands on ${h.toFixed(1)} m of dry ground — §2.2 says ` +
          'both ends die on water and the map has no flank march because of it'
      );
    }
  }

  const faceRun = 170;
  const rise = at(BYRSA_X, BYRSA_Z) - at(BYRSA_X - faceRun, BYRSA_Z);
  const grad = rise / faceRun;
  if (grad > 0.4) {
    console.warn(
      `[carthage] the Byrsa's approach face is 1:${(1 / grad).toFixed(1)} — §5.1a overrides the ` +
        'projection precisely so it is not a cliff; three stepped streets cannot climb this'
    );
  }
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
