import { Rng } from '../util/rand';
import { blurField, hydraulicErode } from './erosion';
import { fbm, ridged, sstep, warpedFbm, gnoise } from './noise';
import {
  AGGER_HALF_WIDTH,
  DITCH_OFFSET,
  HALF_EXTENT,
  PLAIN_LEVEL,
  QUARRIES,
  RISE_RUN,
  ROAD_HALF_WIDTH,
  WATER_LEVEL,
  battleCoreMask,
  germanDeployMask,
  regionalPlain,
  riseAmplitude,
  riseToeZ,
  riverCentreX,
  riverInfluence,
  riverProfile,
  roadCentreX,
  romanDeployMask,
  streamDistance,
} from './topography';

/**
 * Builds the heightfield for the Campus Martius and the northern approach to Rome.
 *
 * Pipeline:
 *   1. Analytic macro form (plain, river valley, city rise) plus layered fBm, evaluated
 *      on a 1025² working grid.
 *   2. Droplet hydraulic erosion on that grid — this is what turns noise into landscape.
 *   3. 2× Catmull-Rom upsample to 2049² (1.37 m/sample) and a fine detail octave, so a
 *      camera at eye level has real relief under it rather than a smooth interpolation.
 *   4. Human marks carved at full resolution: the Tiber's exact channel profile, the
 *      Via Flaminia's graded agger and ditches, field boundaries, hillside terraces,
 *      quarry workings and the Petronia Amnis.
 *   5. Deployment zones flattened onto the regional plane so formations stay intact.
 *
 * The erosion by-products (water volume, material removed, material deposited) become
 * the control texture the ground material splats with — free, and far more convincing
 * than picking materials from height and slope alone.
 */

/** Working grid for the expensive noise + erosion stages. */
const WORK_RES = 1025;
/** Final heightfield resolution: 2049² over 2800 m is 1.367 m per sample. */
export const FIELD_RES = 2049;
export const FIELD_SPACING = (HALF_EXTENT * 2) / (FIELD_RES - 1);

export interface TerrainData {
  heights: Float32Array;
  res: number;
  spacing: number;
  minHeight: number;
  maxHeight: number;
  /** RGBA8: R wetness, G bedrock exposure, B trampling, A silt. */
  control: Uint8Array;
  controlRes: number;
  /** Wall-clock milliseconds spent generating, for the boot log. */
  buildMs: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The macro landform plus its fBm relief, without any human marks or the exact river
 * cross-section. `core` damps high-frequency relief in the fighting corridor.
 */
function baseHeight(x: number, z: number, seed: number): number {
  const plain = regionalPlain(x, z);
  const toe = riseToeZ(x);
  const amp = riseAmplitude(x);

  // The slope up onto the Pincian and Quirinal. `onHill` also gates the hill relief so
  // the flood plain never inherits upland structure.
  const onHill = sstep(toe - 40, toe + RISE_RUN, z);
  let h = plain + amp * sstep(toe, toe + RISE_RUN, z);

  // Behind the crest the ground keeps climbing gently into the city's hills.
  const behind = sstep(toe + RISE_RUN, toe + RISE_RUN + 640, z);
  h += behind * 13;

  // The bluff across the river bend to the north-east (Monti Parioli).
  const north = sstep(-620, -1180, z) * sstep(-150, 520, x);
  h += north * 21;

  const core = battleCoreMask(x, z);

  // --- Relief -------------------------------------------------------------
  // Broad swells survive in the fighting corridor because they read beautifully in
  // raking light and cost formations nothing; the short wavelengths are damped there.
  h += warpedFbm(x, z, 4, 1 / 540, seed + 1, 0.85) * 2.6 * (1 - 0.45 * core);
  h += fbm(x, z, 4, 1 / 150, seed + 2) * 0.95 * (1 - 0.72 * core);
  h += fbm(x, z, 3, 1 / 46, seed + 3) * 0.34 * (1 - 0.82 * core);

  // Upland relief: ridged multifractal, kept modest along the wall crest so the city
  // agent has a coherent platform, growing into real hills further back. Few octaves
  // and a low gain on purpose — the fine structure of a hillside should come from the
  // erosion pass, not from noise, or the slopes read as corduroy.
  const crestBand = sstep(toe + RISE_RUN - 30, toe + RISE_RUN + 420, z);
  const ridgeAmp = 6.5 + 21 * crestBand;
  h += onHill * (ridged(x, z, 4, 1 / 560, seed + 11, 0.42) - 0.40) * ridgeAmp;
  h += onHill * fbm(x, z, 3, 1 / 135, seed + 12) * 1.5;
  h += north * (ridged(x, z, 3, 1 / 420, seed + 13, 0.45) - 0.42) * 14;

  // --- Tiber valley -------------------------------------------------------
  const d = x - riverCentreX(z);
  const inf = riverInfluence(d, z);
  if (inf > 0.001) {
    h += (riverProfile(d, z, h) - h) * inf;
  }
  return h;
}

/** Catmull-Rom weights for the halfway sample of a 2× upsample. */
const UP_A = -1 / 16;
const UP_B = 9 / 16;

export function buildTerrain(seedLabel = 'campus-martius-271'): TerrainData {
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
  // 2. Erosion. Particles are biased onto the sloping ground: spending the budget on
  //    the dead-flat plain would only add noise nobody can see.
  // ---------------------------------------------------------------------
  const hillRegion = (i: number, j: number): number => {
    const x = -HALF_EXTENT + i * wspacing;
    const z = -HALF_EXTENT + j * wspacing;
    const toe = riseToeZ(x);
    const onHill = sstep(toe - 130, toe + 60, z);
    const north = sstep(-560, -1000, z) * sstep(-200, 480, x);
    const bank = 1 - sstep(60, 210, Math.abs(x - riverCentreX(z)));
    return Math.max(onHill, Math.max(north, bank * 0.7));
  };
  const maps = hydraulicErode(work, wres, rng.fork('erode'), hillRegion);

  // ---------------------------------------------------------------------
  // 3. Upsample to the final grid, then add a fine octave weighted by local slope so
  //    steep ground gets surface texture and the plain stays walkable.
  // ---------------------------------------------------------------------
  const res = FIELD_RES;
  const spacing = FIELD_SPACING;
  const heights = new Float32Array(res * res);

  // Horizontal pass into a (res × wres) intermediate, then vertical into `heights`.
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
          midRow[jp2 * res + i]
        );
      }
    }
  }

  // Fine detail. Slope is read from the just-upsampled field, so the extra roughness
  // lands on banks, gullies and hillsides rather than on the parade ground.
  const detailSeed = seed + 31;
  for (let j = 1; j < res - 1; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    for (let i = 1; i < res - 1; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const gx = (heights[row + i + 1] - heights[row + i - 1]) / (2 * spacing);
      const gz = (heights[row + res + i] - heights[row - res + i]) / (2 * spacing);
      const slope = clamp01(Math.hypot(gx, gz));
      const n = gnoise(wx * 0.038, wz * 0.038, detailSeed) * 0.62 + gnoise(wx * 0.11, wz * 0.11, detailSeed + 7) * 0.38;
      heights[row + i] += n * (0.13 + 0.5 * slope);
    }
  }

  // ---------------------------------------------------------------------
  // 4. Human marks and the exact river channel, at full resolution.
  // ---------------------------------------------------------------------
  // Per-row / per-column caches: these are trigonometric and would otherwise be
  // evaluated 4.2 million times each.
  const rowRiverX = new Float32Array(res);
  const rowRoadX = new Float32Array(res);
  const colToe = new Float32Array(res);
  const colRise = new Float32Array(res);
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    rowRiverX[j] = riverCentreX(wz);
    rowRoadX[j] = roadCentreX(wz);
    const wx = -HALF_EXTENT + j * spacing;
    colToe[j] = riseToeZ(wx);
    colRise[j] = riseAmplitude(wx);
  }

  // -- 4a. Re-impose the Tiber's cross-section. Erosion and the upsample both smear the
  //        channel; the water surface needs a clean bed and a crisp cut bank.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    const cx = rowRiverX[j];
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const d = wx - cx;
      if (Math.abs(d) > 270) continue;
      const inf = riverInfluence(d, wz);
      if (inf < 0.002) continue;
      const h = heights[row + i];
      const prof = riverProfile(d, wz, h);
      // Inside the wetted channel the profile wins outright; on the banks a little of
      // the eroded relief is left so the banks are not glassy.
      const strength = Math.abs(d) < 62 ? 1 : 0.82;
      heights[row + i] = h + (prof - h) * inf * strength;
    }
  }

  // -- 4b. Deployment zones onto the regional plane.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    if (wz < -340 || wz > 320) continue;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const m = Math.max(germanDeployMask(wx, wz), romanDeployMask(wx, wz));
      if (m < 0.002) continue;
      const target = regionalPlain(wx, wz);
      // 0.9 rather than 1.0: a trace of relief keeps the ground from looking milled,
      // while the residual mean gradient stays around 1% — invisible to a formation.
      heights[row + i] += (target - heights[row + i]) * m * 0.9;
    }
  }

  // -- 4c. Hillside terraces. Height quantisation is exactly what a farmer building
  //        contour terraces does: pick a bench height and cut and fill to it.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    if (wz < 120) continue;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const toe = colToe[i];
      // Only the lower, gentler part of the slope was worth terracing.
      const band = sstep(toe - 30, toe + 40, wz) * (1 - sstep(toe + 110, toe + 200, wz));
      if (band < 0.02) continue;
      // Not every hillside is cultivated — and terraces only appear in blocks, so the
      // mask has to be patchy or the whole hill front turns into contour corduroy.
      const cultivated = sstep(0.42, 0.68, fbm(wx, wz, 2, 1 / 260, seed + 51) * 0.5 + 0.5);
      const m = band * cultivated;
      if (m < 0.02) continue;
      const h = heights[row + i];
      const bench = 1.15; // riser height of a dry-stone agricultural terrace
      heights[row + i] = h + (Math.round(h / bench) * bench - h) * m * 0.4;
    }
  }

  // -- 4d. Quarry workings: a flat floor, a steep back wall, a spoil heap downhill.
  for (const q of QUARRIES) {
    const gi = Math.round((q.x + HALF_EXTENT) / spacing);
    const gj = Math.round((q.z + HALF_EXTENT) / spacing);
    const ground = heights[gj * res + gi];
    const floorH = ground - q.depth;
    const i0 = Math.max(0, gi - Math.ceil((q.radius * 2.2) / spacing));
    const i1 = Math.min(res - 1, gi + Math.ceil((q.radius * 2.2) / spacing));
    const j0 = Math.max(0, gj - Math.ceil((q.radius * 2.2) / spacing));
    const j1 = Math.min(res - 1, gj + Math.ceil((q.radius * 2.2) / spacing));
    for (let j = j0; j <= j1; j++) {
      const wz = -HALF_EXTENT + j * spacing;
      const row = j * res;
      for (let i = i0; i <= i1; i++) {
        const wx = -HALF_EXTENT + i * spacing;
        // Elliptical, and lobed by noise so it does not read as a crater.
        const dx = (wx - q.x) / q.radius;
        const dz = (wz - q.z) / (q.radius * 0.78);
        const dr = Math.hypot(dx, dz) * (1 + 0.16 * gnoise(wx * 0.03, wz * 0.03, seed + 61));
        const cut = 1 - sstep(0.62, 1.0, dr);
        if (cut > 0.002) {
          const h = heights[row + i];
          heights[row + i] = h + (Math.min(h, floorH) - h) * cut;
        }
        // Spoil tip on the low side of the working.
        const heap = Math.exp(-Math.pow((dr - 1.34) / 0.24, 2)) * sstep(0.1, 0.7, -dz);
        heights[row + i] += heap * 2.6;
      }
    }
  }

  // -- 4e. The Petronia Amnis, draining the Quirinal into the Tiber.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    if (wz < -190 || wz > 400) continue;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      if (wx < -840 || wx > 250) continue;
      const d = streamDistance(wx, wz);
      if (d > 22) continue;
      // A shallow, incised gully with a soft berm of spoil on either lip. Where the
      // stream crosses a deployment ground it is reduced to a swale: a 1.5 m gully
      // through a cohort's frontage would break the line.
      const trench = 1 - sstep(3.2, 13, d);
      const wobble = 0.85 + 0.3 * gnoise(wx * 0.05, wz * 0.05, seed + 71);
      const deploy = Math.max(germanDeployMask(wx, wz), romanDeployMask(wx, wz));
      heights[row + i] -= trench * (1.55 - 1.0 * deploy) * wobble;
      heights[row + i] += Math.exp(-Math.pow((d - 15) / 5.5, 2)) * 0.22;
    }
  }

  // -- 4f. Field boundaries. Roman surveyors laid out the ager on a grid that ignores
  //        the compass, so this lattice sits a few degrees off the world axes.
  const FIELD_ANGLE = 0.213;
  const fa = Math.cos(FIELD_ANGLE);
  const fb = Math.sin(FIELD_ANGLE);
  const FIELD_PERIOD = 94; // roughly two actus, a plausible plot width
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      // Not in the channel, not on the hills, not where the armies stand.
      const toe = colToe[i];
      let m = 1 - sstep(toe - 90, toe - 10, wz);
      m *= sstep(150, 250, Math.abs(wx - rowRiverX[j]));
      m *= 1 - Math.max(germanDeployMask(wx, wz), romanDeployMask(wx, wz));
      m *= 1 - sstep(26, 12, Math.abs(wx - rowRoadX[j]));
      if (m < 0.02) continue;
      const u = wx * fa - wz * fb;
      const v = wx * fb + wz * fa;
      const du = Math.abs(((u % FIELD_PERIOD) + FIELD_PERIOD * 1.5) % FIELD_PERIOD - FIELD_PERIOD * 0.5);
      const dv = Math.abs(((v % FIELD_PERIOD) + FIELD_PERIOD * 1.5) % FIELD_PERIOD - FIELD_PERIOD * 0.5);
      // Some boundaries have been ploughed out; vary them along their length.
      const liveU = sstep(0.3, 0.62, fbm(u * 0.02, v * 0.09, 2, 1, seed + 81) * 0.5 + 0.5);
      const liveV = sstep(0.3, 0.62, fbm(u * 0.09, v * 0.02, 2, 1, seed + 82) * 0.5 + 0.5);
      const bank =
        Math.exp(-Math.pow(du / 2.1, 2)) * liveU + Math.exp(-Math.pow(dv / 2.1, 2)) * liveV;
      heights[row + i] += Math.min(bank, 1.2) * 0.3 * m;
    }
  }

  // -- 4g. The Via Flaminia. Roman engineers graded the alignment, so the road is
  //        smoothed along its length before the camber and ditches are cut.
  const roadProfile = new Float32Array(res);
  for (let j = 0; j < res; j++) {
    roadProfile[j] = sampleBilinear(heights, res, spacing, rowRoadX[j], -HALF_EXTENT + j * spacing);
  }
  smooth1D(roadProfile, 24);
  smooth1D(roadProfile, 24);
  for (let j = 0; j < res; j++) {
    const row = j * res;
    const cx = rowRoadX[j];
    const base = roadProfile[j];
    const i0 = Math.max(0, Math.floor((cx - 34 + HALF_EXTENT) / spacing));
    const i1 = Math.min(res - 1, Math.ceil((cx + 34 + HALF_EXTENT) / spacing));
    const wz = -HALF_EXTENT + j * spacing;
    const deploy = Math.max(germanDeployMask(cx, wz), romanDeployMask(cx, wz));
    for (let i = i0; i <= i1; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const d = Math.abs(wx - cx);
      const w = 1 - sstep(AGGER_HALF_WIDTH + 3, AGGER_HALF_WIDTH + 24, d);
      if (w < 0.002) continue;
      // Crown 0.28 m above the kerb over 2.3 m — a 12% camber, as surveyed on
      // surviving stretches of consular road, shedding water into the fossae.
      const crown = 0.5 - 0.22 * sstep(0, ROAD_HALF_WIDTH, d);
      const shoulder = -0.28 * sstep(ROAD_HALF_WIDTH, AGGER_HALF_WIDTH, d);
      // Ditches are cut shallower where the armies deploy so nothing trips a formation.
      const ditch = -Math.exp(-Math.pow((d - DITCH_OFFSET) / 2.4, 2)) * (0.5 - 0.34 * deploy);
      const target = base + crown + shoulder + ditch;
      heights[row + i] += (target - heights[row + i]) * w * 0.94;
    }
  }

  // ---------------------------------------------------------------------
  // 5. Control texture from the erosion by-products plus analytic masks.
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
    const cx = riverCentreX(wz);
    const rx = roadCentreX(wz);
    for (let i = 0; i < wres; i++) {
      const wx = -HALF_EXTENT + i * wspacing;
      const k = j * wres + i;
      const h = sampleBilinear(heights, res, spacing, wx, wz);

      // Wetness: drainage lines, the flood terrace, the stream, and low ground. The
      // "low ground" term must be tight: the Campus Martius sits only seven metres above
      // the Tiber, so a generous range floods the entire parade ground with mud.
      let wet = clamp01(Math.log1p((flow[k] / flowMax) * 90) / Math.log(91)) * 0.8;
      wet = Math.max(wet, 1 - sstep(1.2, 4.2, h - WATER_LEVEL));
      const dStream = wz > -220 && wz < 420 && wx > -860 && wx < 270 ? streamDistance(wx, wz) : 999;
      wet = Math.max(wet, (1 - sstep(4, 22, dStream)) * 0.85);
      wet *= 0.5 + 0.5 * (0.5 + 0.5 * gnoise(wx * 0.006, wz * 0.006, seed + 91));

      // Bedrock: where particles scoured, plus the quarry faces.
      let bare = clamp01((rock[k] / rockMax) * 3.4);
      for (const q of QUARRIES) {
        const dr = Math.hypot((wx - q.x) / q.radius, (wz - q.z) / (q.radius * 0.78));
        bare = Math.max(bare, 1 - sstep(0.7, 1.15, dr));
      }

      // Trampling: the deployment grounds and the verges of the road, plus the track
      // down to the ford.
      // Broken up by two noise scales: an unmodulated mask reads as a soft rectangle
      // painted on the field, which is the single most obvious "video game" tell.
      const churn =
        0.34 +
        0.44 * (0.5 + 0.5 * gnoise(wx * 0.009, wz * 0.009, seed + 92)) +
        0.3 * (0.5 + 0.5 * gnoise(wx * 0.038, wz * 0.038, seed + 93));
      // 0.34 rather than 0.72: the deployment boxes now reach ±490 m to cover the widened
      // frontage, and at the old strength that turned the whole battlefield into a sheet
      // of bare trodden earth — measured at eye level in the Roman line it was chocolate
      // mud from foreground to horizon. Real Rome II frames keep a sward growing between
      // the ranks and break it with trodden scrapes, not the reverse. Combat wear on top
      // of this is `vfx/GroundDamage`'s job, and it accumulates where men actually fight
      // rather than everywhere they might stand.
      let tramp = Math.max(germanDeployMask(wx, wz), romanDeployMask(wx, wz)) * 0.34 * churn;
      tramp = Math.max(tramp, (1 - sstep(AGGER_HALF_WIDTH, AGGER_HALF_WIDTH + 9, Math.abs(wx - rx))) * 0.8);
      const fordTrack = (1 - sstep(9, 30, Math.abs(wz + 520))) * (1 - sstep(90, 320, Math.abs(wx - cx)));
      tramp = Math.max(tramp, fordTrack * 0.75 * churn);

      const siltV = clamp01((silt[k] / siltMax) * 4.0);

      control[k * 4] = (clamp01(wet) * 255) | 0;
      control[k * 4 + 1] = (clamp01(bare) * 255) | 0;
      control[k * 4 + 2] = (clamp01(tramp) * 255) | 0;
      control[k * 4 + 3] = (siltV * 255) | 0;
    }
  }

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (v < minHeight) minHeight = v;
    if (v > maxHeight) maxHeight = v;
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

/** Bilinear sample of a square field. Shared by the build stages. */
export function sampleBilinear(
  data: Float32Array,
  res: number,
  spacing: number,
  x: number,
  z: number
): number {
  const fx = (x + HALF_EXTENT) / spacing;
  const fz = (z + HALF_EXTENT) / spacing;
  let i0 = Math.floor(fx);
  let j0 = Math.floor(fz);
  i0 = i0 < 0 ? 0 : i0 > res - 2 ? res - 2 : i0;
  j0 = j0 < 0 ? 0 : j0 > res - 2 ? res - 2 : j0;
  const tx = clamp01(fx - i0);
  const tz = clamp01(fz - j0);
  const a = data[j0 * res + i0];
  const b = data[j0 * res + i0 + 1];
  const c = data[(j0 + 1) * res + i0];
  const d = data[(j0 + 1) * res + i0 + 1];
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * tz;
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

/** Height of the plain used as the datum for anything that must sit level. */
export const PLAIN_DATUM = PLAIN_LEVEL;
