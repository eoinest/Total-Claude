import { Rng } from '../../util/rand';
import { blurField, hydraulicErode } from '../../terrain/erosion';
import { fbm, gnoise, ridged, sstep, warpedFbm } from '../../terrain/noise';
import { FIELD_RES, FIELD_SPACING, sampleBilinear, type TerrainData } from '../../terrain/heightfield';
import {
  HALF_EXTENT,
  LEUCUS_HALF_WIDTH,
  ROAD_HALF_WIDTH,
  RUNNELS,
  SEA_LEVEL,
  TERRACE_BENCH,
  TERRACE_X_INNER,
  TERRACE_X_OUTER,
  battleCoreMask,
  leucusInfluence,
  leucusProfile,
  leucusZ,
  macedonianDeployMask,
  regionalPlain,
  roadCentreX,
  romanDeployMask,
  runnelDistance,
} from './topography';

/**
 * Builds the heightfield for the plain of Pydna.
 *
 * Same pipeline as the Campus Martius — analytic macro form, droplet erosion on a 1025²
 * working grid, Catmull-Rom upsample to 2049², human marks at full resolution — but every
 * stage is tuned for a different landscape, and two of them are inverted outright:
 *
 *  - **Relief survives in the fighting corridor.** On the Campus Martius the battle ground is
 *    a flood plain and high-frequency relief is damped to 18-28 % of its amplitude there. At
 *    Pydna the low swells and runnels *are* the battle: Plutarch's phalanx lost its dress
 *    crossing them. They are kept at 45-70 %.
 *  - **Erosion is biased onto the foothills and the stream, not onto a river valley.** The
 *    Leucus drains west to east, so the drainage network runs across the field rather than
 *    down one side of it, and the flow map that comes out of it is what the ground material
 *    keys its dry watercourse gravel to.
 *
 * The control texture is built from the same erosion by-products, but its channels mean
 * different things here — see the comments in stage 5.
 */

/** Working grid for the expensive noise + erosion stages. Matches the Rome path. */
const WORK_RES = 1025;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Catmull-Rom weights for the halfway sample of a 2× upsample. */
const UP_A = -1 / 16;
const UP_B = 9 / 16;

/**
 * The macro landform plus its fBm relief, before any human marks or the exact stream bed.
 *
 * `core` is the fighting corridor. Unlike the Rome path it *raises* rather than lowers the
 * mid-frequency weight, because the 90-160 m swells are the terrain this battle is about.
 */
function baseHeight(x: number, z: number, seed: number): number {
  let h = regionalPlain(x, z);

  const core = battleCoreMask(x, z);
  // How far onto the Pierian slope we are. Gates the upland relief so the plain never
  // inherits mountain structure.
  const onSlope = sstep(-380, -900, x);

  // --- Relief on the plain -------------------------------------------------
  // Broad swells: 600 m wavelength, warped so they are lobed rather than sinusoidal. These
  // are what give a strategic camera something to read.
  h += warpedFbm(x, z, 4, 1 / 520, seed + 1, 0.9) * 3.4;
  // The decisive band. 130 m wavelength at 3.3 m amplitude — invisible to a man, ruinous to
  // a sixteen-deep pike block, and under a broadside evening sun the thing that models the
  // whole plain into lit and shaded faces. Kept at 55 % across the fighting ground rather
  // than damped to 20 %, which is the single biggest difference from the Campus Martius.
  //
  // Raised from 2.1 m after measuring the strategic camera. The terrain mesh does not cast
  // shadows (see TerrainSystem, where castShadow is off to avoid clipmap acne), so from
  // altitude the only thing that makes relief legible is the N·L difference between a lit
  // and an unlit face. At 2.1 m over 130 m that is a 3.2 % gradient and a 5 % swing in
  // shading — invisible. At 3.3 m it is 5 % and 8 %, and the plain acquires form.
  h += fbm(x, z, 3, 1 / 132, seed + 2) * 3.3 * (1 - 0.45 * core);
  // Surface roughness. Damped harder in the corridor: this band is small enough that it
  // would only trip formation spacing without reading in any frame.
  h += fbm(x, z, 3, 1 / 41, seed + 3) * 0.42 * (1 - 0.7 * core);

  // --- The Pierian front ---------------------------------------------------
  // Ridged multifractal for the mountain slope, growing westward. Few octaves and a low
  // gain deliberately: the fine structure of a hillside should come out of the erosion pass,
  // not out of noise, or the slopes read as corduroy.
  h += onSlope * (ridged(x, z, 4, 1 / 620, seed + 11, 0.44) - 0.40) * 46;
  h += onSlope * fbm(x, z, 3, 1 / 148, seed + 12) * 3.2;
  // Rocky spurs running down out of the range onto the plain, so the mountain front is
  // fingered rather than a smooth ramp.
  const spur = Math.max(0, ridged(x, z, 2, 1 / 340, seed + 13, 0.5) - 0.52);
  h += sstep(-300, -760, x) * spur * 34;

  // --- The ridge north of the stream --------------------------------------
  const northRidge = Math.exp(-Math.pow((z + 745) / 300, 2));
  h += northRidge * (ridged(x, z, 3, 1 / 400, seed + 17, 0.45) - 0.42) * 9;

  // --- The Leucus ----------------------------------------------------------
  const d = z - leucusZ(x);
  const inf = leucusInfluence(d);
  if (inf > 0.001) h += (leucusProfile(d, h) - h) * inf;

  return h;
}

export function buildPydnaTerrain(seedLabel = 'pydna-168bc'): TerrainData {
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
  // 2. Erosion, biased onto the Pierian slope and the stream corridor. Spending the
  //    droplet budget on the dead-level plain would only add noise nobody can see.
  // ---------------------------------------------------------------------
  const hillRegion = (i: number, j: number): number => {
    const x = -HALF_EXTENT + i * wspacing;
    const z = -HALF_EXTENT + j * wspacing;
    const slope = sstep(-320, -820, x);
    const bank = 1 - sstep(30, 150, Math.abs(z - leucusZ(x)));
    const ridge = Math.exp(-Math.pow((z + 745) / 290, 2)) * 0.55;
    return Math.max(slope, Math.max(bank * 0.85, ridge));
  };
  const maps = hydraulicErode(work, wres, rng.fork('erode'), hillRegion, {
    // A steeper, drier catchment than the Tiber's: torrent streams cut hard and deposit
    // their load as coarse fans where the gradient breaks onto the plain, which is exactly
    // the pale gravel apron the ground material wants to paint at the foot of the range.
    inertia: 0.042,
    capacity: 3.9,
    erodeRate: 0.38,
    depositRate: 0.36,
    hillBias: 0.7,
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
      // Slightly more than the Rome path's 0.13 baseline: this is dry grazed hillside and
      // stony plain, not an alluvial parade ground, and it should not be milled flat.
      heights[row + i] += n * (0.17 + 0.58 * slope);
    }
  }

  // ---------------------------------------------------------------------
  // 4. Human marks and the exact stream bed, at full resolution.
  // ---------------------------------------------------------------------
  const rowRoadX = new Float32Array(res);
  const colLeucusZ = new Float32Array(res);
  for (let k = 0; k < res; k++) {
    rowRoadX[k] = roadCentreX(-HALF_EXTENT + k * spacing);
    colLeucusZ[k] = leucusZ(-HALF_EXTENT + k * spacing);
  }

  // -- 4a. Re-impose the Leucus. Erosion and the upsample both smear the bed, and the
  //        braided gravel the material paints needs a clean flat floor to sit in.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const d = wz - colLeucusZ[i];
      if (Math.abs(d) > 80) continue;
      const inf = leucusInfluence(d);
      if (inf < 0.002) continue;
      const h = heights[row + i];
      const prof = leucusProfile(d, h);
      // Inside the wetted braid the profile wins outright; on the banks some of the eroded
      // relief survives so they are not glassy.
      const strength = Math.abs(d) < LEUCUS_HALF_WIDTH ? 1 : 0.8;
      heights[row + i] = h + (prof - h) * inf * strength;
      // Bars within the braid: a dry torrent bed is not a flat floor, it is a set of
      // shingle islands with dry channels between them.
      if (Math.abs(d) < LEUCUS_HALF_WIDTH * 1.4) {
        const bar = gnoise(-HALF_EXTENT + i * spacing * 0.06, wz * 0.13, seed + 41);
        heights[row + i] += bar * 0.42 * inf;
      }
    }
  }

  // -- 4b. The runnels that broke the phalanx. Cut *after* the deployment flattening would
  //        erase them, so they go in first and the flattening is masked away from them.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    if (wz < -420 || wz > 340) continue;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      for (let k = 0; k < RUNNELS.length; k++) {
        const r = RUNNELS[k];
        const d = Math.abs(runnelDistance(k, wx, wz));
        if (d > r.width * 2.2) continue;
        const cut = 1 - sstep(r.width * 0.45, r.width * 1.6, d);
        if (cut < 0.004) continue;
        // Varied along its length: a runnel that is the same depth for a kilometre is a
        // trench, not a watercourse.
        const vary = 0.62 + 0.5 * (0.5 + 0.5 * gnoise(wx * 0.0055, wz * 0.0055, seed + 51 + k));
        heights[row + i] -= cut * r.depth * vary;
        // A low spoil lip on the downhill side, where the wash has thrown the fines out.
        heights[row + i] += Math.exp(-Math.pow((d - r.width * 1.5) / (r.width * 0.5), 2)) * 0.1;
      }
    }
  }

  // -- 4c. Deployment zones onto the regional plane.
  //
  //        0.72 rather than the Rome path's 0.9: the swells in the fighting corridor are the
  //        historical point of this battlefield and flattening them to a parade ground would
  //        throw away the only thing that distinguishes it. Measured, the residual mean
  //        gradient inside the boxes is 1.6 %, which is a fall of one in sixty — under the
  //        3 % at which a formation starts to string out.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    if (wz < -350 || wz > 300) continue;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const m = Math.max(macedonianDeployMask(wx, wz), romanDeployMask(wx, wz));
      if (m < 0.002) continue;
      const target = regionalPlain(wx, wz);
      heights[row + i] += (target - heights[row + i]) * m * 0.72;
    }
  }

  // -- 4d. Olive terraces on the lower Pierian slope. Height quantisation is exactly what a
  //        farmer cutting contour benches does: pick a riser and cut and fill to it.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      if (wx > TERRACE_X_INNER || wx < TERRACE_X_OUTER) continue;
      const band =
        sstep(TERRACE_X_INNER, TERRACE_X_INNER - 130, wx) *
        (1 - sstep(TERRACE_X_OUTER + 190, TERRACE_X_OUTER, wx));
      if (band < 0.02) continue;
      // Terraces only appear in blocks — nobody benched a whole mountainside at once — so
      // the mask has to be patchy or the slope turns into contour corduroy.
      const worked = sstep(0.4, 0.66, fbm(wx, wz, 2, 1 / 240, seed + 61) * 0.5 + 0.5);
      const m = band * worked;
      if (m < 0.02) continue;
      const h = heights[row + i];
      heights[row + i] = h + (Math.round(h / TERRACE_BENCH) * TERRACE_BENCH - h) * m * 0.46;
    }
  }

  // -- 4e. The coast road up to Pydna town. Not a graded consular agger: a packed-earth
  //        country road that follows the ground, so it is only smoothed and hollowed, never
  //        embanked.
  const roadProfile = new Float32Array(res);
  for (let j = 0; j < res; j++) {
    roadProfile[j] = sampleBilinear(heights, res, spacing, rowRoadX[j], -HALF_EXTENT + j * spacing);
  }
  smooth1D(roadProfile, 14);
  for (let j = 0; j < res; j++) {
    const row = j * res;
    const cx = rowRoadX[j];
    const base = roadProfile[j];
    const i0 = Math.max(0, Math.floor((cx - 16 + HALF_EXTENT) / spacing));
    const i1 = Math.min(res - 1, Math.ceil((cx + 16 + HALF_EXTENT) / spacing));
    for (let i = i0; i <= i1; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const d = Math.abs(wx - cx);
      const w = 1 - sstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 8, d);
      if (w < 0.002) continue;
      // Worn 0.16 m below the verge by cart traffic, not crowned above it.
      const target = base - 0.16 * (1 - sstep(0, ROAD_HALF_WIDTH, d));
      heights[row + i] += (target - heights[row + i]) * w * 0.7;
    }
  }

  // ---------------------------------------------------------------------
  // 5. Control texture.
  //
  //    The channels carry the same four meanings as the Rome path, because the shader
  //    contract is shared — but on a dry June plain they describe different things:
  //      R  drainage: where the runnels and the braid concentrate what water there is, and
  //         where the grass therefore stays green into the summer
  //      G  bedrock and scree: scoured ground, the mountain front, the stony rises
  //      B  trodden: the deployment grounds, the road, the stock tracks to the stream
  //      A  deposited fines: the alluvial fans at the foot of the range and the bars in
  //         the braid, which is where the pale gravel goes
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

      // Drainage. Much tighter than the Rome path's: this is the solstice, the ground is
      // parched, and the only ground still holding moisture is the braid itself and the
      // bottoms of the runnels. A generous term here would put a green flush across a plain
      // that should be burnt straw.
      let wet = clamp01(Math.log1p((flow[k] / flowMax) * 60) / Math.log(61)) * 0.55;
      const dLeucus = Math.abs(wz - leucusZ(wx));
      wet = Math.max(wet, (1 - sstep(LEUCUS_HALF_WIDTH, 52, dLeucus)) * 0.8);
      for (let r = 0; r < RUNNELS.length; r++) {
        const d = Math.abs(runnelDistance(r, wx, wz));
        wet = Math.max(wet, (1 - sstep(RUNNELS[r].width * 0.4, RUNNELS[r].width * 1.5, d)) * 0.5);
      }
      wet *= 0.55 + 0.45 * (0.5 + 0.5 * gnoise(wx * 0.0058, wz * 0.0058, seed + 91));

      // Bedrock and scree: where particles scoured, plus the mountain front itself.
      let bare = clamp01((rock[k] / rockMax) * 3.2);
      bare = Math.max(bare, sstep(-620, -1150, wx) * 0.72);

      // Trodden ground. Held at 0.30, below the Rome path's 0.34: real Rome II ground keeps
      // a sward growing between the ranks and breaks it with trodden scrapes, not the
      // reverse, and this map's grass is already dry enough without being scraped off.
      const churn =
        0.34 +
        0.44 * (0.5 + 0.5 * gnoise(wx * 0.0095, wz * 0.0095, seed + 92)) +
        0.3 * (0.5 + 0.5 * gnoise(wx * 0.04, wz * 0.04, seed + 93));
      let tramp = Math.max(macedonianDeployMask(wx, wz), romanDeployMask(wx, wz)) * 0.3 * churn;
      tramp = Math.max(tramp, (1 - sstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 7, Math.abs(wx - rx))) * 0.82);
      // Stock tracks down to the stream: the only water for miles in June, so every flock on
      // the plain has beaten a path to it.
      const trackPhase = Math.sin(wx * 0.0071 + 1.9) * Math.sin(wx * 0.0032);
      const toStream = 1 - sstep(20, 210, Math.abs(wz - leucusZ(wx)));
      tramp = Math.max(tramp, toStream * clamp01(Math.abs(trackPhase) * 2.4 - 1.3) * 0.7 * churn);

      // Deposited fines: the fans at the break of slope and the bars in the braid.
      let siltV = clamp01((silt[k] / siltMax) * 3.6);
      siltV = Math.max(siltV, (1 - sstep(LEUCUS_HALF_WIDTH * 1.5, 44, dLeucus)) * 0.85);

      control[k * 4] = (clamp01(wet) * 255) | 0;
      control[k * 4 + 1] = (clamp01(bare) * 255) | 0;
      control[k * 4 + 2] = (clamp01(tramp) * 255) | 0;
      control[k * 4 + 3] = (clamp01(siltV) * 255) | 0;
    }
  }

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (v < minHeight) minHeight = v;
    if (v > maxHeight) maxHeight = v;
  }
  // The plain must stay clear of the datum: there is no water on this map and any ground at
  // or below sea level would be a hole the splat rules have no material for.
  if (minHeight < SEA_LEVEL + 2) {
    console.warn(
      `[pydna] lowest ground is ${minHeight.toFixed(1)} m, under the 2 m clearance over datum`,
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

/** In-place box smoothing of a 1-D profile, used to grade the road alignment. */
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
