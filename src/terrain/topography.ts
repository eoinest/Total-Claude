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

import type { DeployGround } from '../maps/types';
// `./noise` imports nothing at all, so this closes no cycle — see the note above `romeWallZ`
// about which way the dependency between this file and `city/rome/` runs.
import { sstep } from './noise';
// The Tiber's own survey, in survey metres. Imports nothing, so this closes no cycle.
import { TIBER_ISLAND, TIBER_SURVEY } from './tiberSurvey';

/** Battlefield half-size in metres. Part of the public terrain contract. */
export const HALF_EXTENT = 1400;

/** Tiber low-water surface. Everything else is measured against this. */
export const WATER_LEVEL = 5.0;

/** Datum height of the flood plain at the origin, before the gentle regional tilt. */
export const PLAIN_LEVEL = 12.2;

/**
 * **Nominal** half-width of the open water, in world metres. The real thing is
 * `riverHalfWidthAt(z)`, which is measured off Lanciani per reach and projected.
 *
 * It was **47**, and 47 was wrong in a way worth recording, because it is the same fault as
 * `x = f(z)` wearing different clothes. The Tiber at Rome runs 90-100 real metres between banks
 * and 47 was that half, in *world* metres, 1:1 — a cross-section held at true scale, which
 * `MAP-METHOD.md` rule 4 endorses. But **a constant world half-width is a variable real width**,
 * because `KX` = 0.443 and `KZ` = 0.35 are not equal: measured against the georeferenced plate,
 * a 94-world-metre channel covers **212 real metres** where the Tiber runs north-south, **269**
 * where it runs east-west, and 292.6 as the plan harness read it across the bend. Against a plate
 * whose channel is 100.8 m. The representation could not express a river of one width.
 *
 * So the width is authored in real metres and projected like a position — see
 * `realToWorldHalf` — and this constant is the median of the result, kept for the callers that
 * want one number: the wall bench's water exclusion in `heightfield.ts` and `probe-ground`'s
 * channel count. **Anything that cares about the channel's actual width must call
 * `riverHalfWidthAt`.**
 *
 * 20.6 is the median; the range is 14.0 to 22.5, narrow where the channel runs east-west because
 * that is where its perpendicular is compressed by `KZ` rather than `KX`.
 */
export const RIVER_HALF_WIDTH = 20.6;

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
 * **The Tiber, as the plates give it. §15 task 1, re-surveyed.**
 *
 * The course is not held here. It is `src/terrain/tiberSurvey.ts` — 451 stations in *survey*
 * metres at 25 m of course length, digitised off the AGEA 2012 orthophoto and cross-checked
 * against Lanciani — and this file projects it through `worldOf`. That split is the point: what
 * it replaces was twelve latitude/longitude knots transcribed into world metres *inside this
 * file*, which had to be re-typed by hand every time `KZ` moved.
 *
 * ## What was wrong, in one number
 *
 * The old table's error was reported as **0.1 world metres** and the report was honest. It
 * measured the transcribed world-metre knots against `worldOf` of the same twelve latitudes and
 * longitudes: the arithmetic of the projection, not the position of the river. Measured against
 * the plate instead (`tools/scratch/tiber-knotcheck.mjs`), **one of the twelve control points
 * stood on water.** Median distance from the traced channel 115 survey metres, worst 1 166.
 *
 * And between the points it was worse than at the points. The spline was a Fritsch–Carlson
 * limited cubic Hermite through knots 700 m apart. That limiter zeroes the tangent at a data
 * extremum, which is right for monotone data and wrong for a meander sampled coarsely, because
 * the real extremum lies *between* knots. Zeroing it flattens the curve at the knot and forces
 * the curvature to reverse either side of it. **The curve passed through all twelve of its
 * control points and bowed into the Campus Martius instead of around it**, which is what the
 * owner saw and what no residual against those points could ever have shown.
 *
 * ## What is here now
 *
 * - `tiberPath()` — the survey projected, ~450 world-metre nodes. Curvature is carried by data at
 *   25 m spacing; nothing is interpolated into existence.
 * - `RIVER_FIELD` — a **signed distance field** to that polyline, 8 m over the map plus a 200 m
 *   margin. `riverOffset` is a bilinear sample of it.
 *
 *   The field replaces `(x - riverCentreX(z)) * riverPerpScale(z)`, which is the perpendicular
 *   distance to the *infinite straight line* tangent to the channel on that row. Exact for a
 *   straight reach, badly wrong at a bend — and the Tiber at Rome is mostly bend. At the Tiber
 *   Island the channel runs at 79 degrees to the z axis, so that expression scaled a 400 m
 *   horizontal offset down to 78 m and called the far side of the Campus Martius "in the river".
 *   **That is the mechanism behind buildings standing in water**, and a distance field removes it
 *   by construction rather than by tuning a radius.
 * - `riverHalfWidthAt` — the channel's half-width, which varies: 37 m in the Campus Martius bend,
 *   50 m below the Capitol where the Ripa's harbour reach begins.
 * - `islandMask` — the Tiber Island as a bar standing out of the channel, so the Insula Tiberina
 *   stands on ground rather than in water.
 *
 * The tables are built lazily on first use rather than at module load, because building them
 * needs `worldOf`, which is declared further down this file after `GATE_X`. Nothing calls a river
 * function during module initialisation — `GATE_X` is the fixed point of
 * `roadCentreX(crestZAt(x))`, and neither of those touches water — so "lazily" costs one branch
 * and buys the survey being held in survey metres.
 */

const RIVER_ROW_STEP = 4;
const RIVER_ROW_LO = -(HALF_EXTENT + 220);
const RIVER_ROW_HI = HALF_EXTENT + 220;
const RIVER_ROW_N = Math.round((RIVER_ROW_HI - RIVER_ROW_LO) / RIVER_ROW_STEP) + 1;

const FIELD_STEP = 8;
const FIELD_HALF = HALF_EXTENT + 200;
const FIELD_N = Math.round((2 * FIELD_HALF) / FIELD_STEP) + 1;
/** Beyond this the field saturates. `riverInfluence` reaches 266 m, so 320 is clear of it. */
const FIELD_REACH = 320;

interface RiverTables {
  /** World-metre polyline, x and z interleaved, south (high z) to north (low z). */
  path: Float64Array;
  /** Channel centre x per 4 m row of z. */
  centre: Float64Array;
  /** dx/dz per row. */
  slope: Float64Array;
  /** Channel half-width per row, measured perpendicular to the flow. */
  half: Float64Array;
  /** x of the west and east banks per row, solved against the field. */
  bankW: Float64Array;
  bankE: Float64Array;
  /**
   * **Unsigned** perpendicular distance to the centreline, clamped at `FIELD_REACH`.
   *
   * It was signed, and that was a bug worth keeping the note for: unstamped cells hold the
   * initial `+FIELD_REACH`, so on the west side of the river the stamped band ended at
   * `-319.9` against an unstamped `+320` neighbour, and **bilinear interpolation across that
   * pair crosses zero** — a phantom channel ring 320 m out. `tools/probe-tiber.mjs` found three
   * buildings sitting in it, 578 m from the real water, with the model insisting the ground
   * there was 12.5 m above the river. Storing the magnitude and taking the sign from
   * `x - centreX(z)` cannot produce a spurious crossing, and the sign is exact wherever the
   * channel is a function of z, which over this map it is by construction.
   */
  field: Float32Array;
}

let riverTables: RiverTables | null = null;

/**
 * How much of a real-metre cross-section survives projection. 1 = the channel is exactly as wide,
 * relative to the city around it, as the real Tiber. `1 / KX` = 2.257 restores the true-scale
 * cross-section rule 4 asks for, at the cost of a channel that reads 2.26x wide on a plan.
 */
const RIVER_WIDTH_SCALE = 1;

function buildRiverTables(): RiverTables {
  const m = TIBER_SURVEY.length;
  /** Real half-width at survey row `i` -> perpendicular half-width in world metres. */
  const realToWorldHalf = (rHalf: number, i: number): number => {
    const a = TIBER_SURVEY[Math.max(0, i - 1)];
    const b = TIBER_SURVEY[Math.min(TIBER_SURVEY.length - 1, i + 1)];
    const de = b[0] - a[0];
    const dn = b[1] - a[1];
    const L = Math.hypot(de, dn) || 1;
    const te = de / L;
    const tn = dn / L;
    return (rHalf * RIVER_WIDTH_SCALE * KX * KZ) / Math.hypot(KX * te, KZ * tn);
  };
  const path = new Float64Array(m * 2);
  for (let i = 0; i < m; i++) {
    const w = worldOf(TIBER_SURVEY[i][0], TIBER_SURVEY[i][1]);
    path[i * 2] = w.x;
    path[i * 2 + 1] = w.z;
  }

  // --- centre, half width and slope, per row of z ---------------------------------------
  const centre = new Float64Array(RIVER_ROW_N);
  const half = new Float64Array(RIVER_ROW_N);
  const filled = new Uint8Array(RIVER_ROW_N);
  const rowOf = (z: number): number => (z - RIVER_ROW_LO) / RIVER_ROW_STEP;
  for (let i = 0; i + 1 < m; i++) {
    const x0 = path[i * 2];
    const z0 = path[i * 2 + 1];
    const x1 = path[i * 2 + 2];
    const z1 = path[i * 2 + 3];
    if (z0 === z1) continue;
    // **The width is authored in real metres and projected, not copied across.**
    //
    // A half-width stored in *world* metres is a *variable* real width, because the projection
    // compresses x by `KX` and z by `KZ` and those are not equal: `RIVER_HALF_WIDTH = 47` world
    // metres is 212 real metres of channel where the Tiber runs north-south and 269 where it
    // runs east-west. Measured against the plate the drawn channel came out **292.6 real metres
    // against 100.8**. The same class of fault as `x = f(z)`: the representation could not
    // express the thing.
    //
    // For a real perpendicular offset `r` on a reach whose real unit tangent is `(te, tn)`, the
    // perpendicular distance in world metres works out at `r·KX·KZ / hypot(KX·te, KZ·tn)`. It
    // reduces to `r·KX` on a north-south reach and `r·KZ` on an east-west one, which is what it
    // should: the perpendicular is east-west in the first case and north-south in the second.
    //
    // **This overrides `MAP-METHOD.md` rule 4 — "positions compress, cross-sections do not" —
    // and the override is deliberate.** Rule 4 exists so that a 6 m wall is not drawn 2.7 m
    // thick and a man does not step over a road. Nothing on this map crosses the Tiber: the
    // assault is on the north front, no unit fords the channel, and the one crossing that exists
    // is the shoal at `FORD_Z`, which `riverProfile` widens 1.85x and shallows to 0.65 m in its
    // own right. What the Tiber's width *is* on this map is a plan-view feature graded against
    // Lanciani. `RIVER_WIDTH_SCALE` is the one number to change if a scenario is ever written
    // that crosses it; at `1 / KX` = 2.257 the channel is a true-scale cross-section again.
    const h0 = realToWorldHalf(TIBER_SURVEY[i][2] * 0.5, i);
    const h1 = realToWorldHalf(TIBER_SURVEY[i + 1][2] * 0.5, i + 1);
    const a = Math.max(0, Math.ceil(rowOf(Math.min(z0, z1))));
    const b = Math.min(RIVER_ROW_N - 1, Math.floor(rowOf(Math.max(z0, z1))));
    for (let r = a; r <= b; r++) {
      const t = (RIVER_ROW_LO + r * RIVER_ROW_STEP - z0) / (z1 - z0);
      centre[r] = x0 + (x1 - x0) * t;
      half[r] = h0 + (h1 - h0) * t;
      filled[r] = 1;
    }
  }
  // Rows past either end of the polyline hold the nearest end's values. The survey runs 120 m
  // beyond both map edges, so this only ever fills the field's own margin.
  for (let r = 1; r < RIVER_ROW_N; r++) {
    if (!filled[r] && filled[r - 1]) { centre[r] = centre[r - 1]; half[r] = half[r - 1]; filled[r] = 2; }
  }
  for (let r = RIVER_ROW_N - 2; r >= 0; r--) {
    if (!filled[r] && filled[r + 1]) { centre[r] = centre[r + 1]; half[r] = half[r + 1]; filled[r] = 2; }
  }
  const slope = new Float64Array(RIVER_ROW_N);
  for (let r = 0; r < RIVER_ROW_N; r++) {
    const a = Math.max(0, r - 1);
    const b = Math.min(RIVER_ROW_N - 1, r + 1);
    slope[r] = (centre[b] - centre[a]) / ((b - a) * RIVER_ROW_STEP);
  }

  // --- the signed distance field ---------------------------------------------------------
  const field = new Float32Array(FIELD_N * FIELD_N).fill(FIELD_REACH);
  const best = new Float32Array(FIELD_N * FIELD_N).fill(FIELD_REACH);
  const cellOf = (v: number): number => (v + FIELD_HALF) / FIELD_STEP;
  for (let i = 0; i + 1 < m; i++) {
    const ax = path[i * 2];
    const az = path[i * 2 + 1];
    const dx = path[i * 2 + 2] - ax;
    const dz = path[i * 2 + 3] - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-12) continue;
    const i0 = Math.max(0, Math.floor(cellOf(Math.min(ax, ax + dx) - FIELD_REACH)));
    const i1 = Math.min(FIELD_N - 1, Math.ceil(cellOf(Math.max(ax, ax + dx) + FIELD_REACH)));
    const j0 = Math.max(0, Math.floor(cellOf(Math.min(az, az + dz) - FIELD_REACH)));
    const j1 = Math.min(FIELD_N - 1, Math.ceil(cellOf(Math.max(az, az + dz) + FIELD_REACH)));
    for (let j = j0; j <= j1; j++) {
      const pz = -FIELD_HALF + j * FIELD_STEP;
      const row = j * FIELD_N;
      for (let k = i0; k <= i1; k++) {
        const px = -FIELD_HALF + k * FIELD_STEP;
        let t = ((px - ax) * dx + (pz - az) * dz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - (ax + dx * t);
        const qz = pz - (az + dz * t);
        const d = Math.sqrt(qx * qx + qz * qz);
        if (d >= best[row + k]) continue;
        best[row + k] = d;
        field[row + k] = d;
      }
    }
  }

  // --- the banks, solved against the field ------------------------------------------------
  const sampleF = (x: number, z: number, cx: number): number => {
    let fx = (x + FIELD_HALF) / FIELD_STEP;
    let fz = (z + FIELD_HALF) / FIELD_STEP;
    fx = fx < 0 ? 0 : fx > FIELD_N - 1.001 ? FIELD_N - 1.001 : fx;
    fz = fz < 0 ? 0 : fz > FIELD_N - 1.001 ? FIELD_N - 1.001 : fz;
    const i = fx | 0;
    const j = fz | 0;
    const u = fx - i;
    const v = fz - j;
    const r0 = j * FIELD_N + i;
    const r1 = r0 + FIELD_N;
    const mag = (field[r0] * (1 - u) + field[r0 + 1] * u) * (1 - v)
      + (field[r1] * (1 - u) + field[r1 + 1] * u) * v;
    return x < cx ? -mag : mag;
  };
  const bankW = new Float64Array(RIVER_ROW_N);
  const bankE = new Float64Array(RIVER_ROW_N);
  for (let r = 0; r < RIVER_ROW_N; r++) {
    const z = RIVER_ROW_LO + r * RIVER_ROW_STEP;
    const cx = centre[r];
    const want = half[r];
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      let x = cx;
      let prev = sampleF(cx, z, cx) * side;
      let hit = cx + side * want;
      for (let d = FIELD_STEP; d <= 1000; d += FIELD_STEP) {
        const nx = cx + side * d;
        const cur = sampleF(nx, z, cx) * side;
        if (cur >= want) {
          hit = x + (nx - x) * ((want - prev) / (cur - prev || 1));
          break;
        }
        x = nx;
        prev = cur;
        hit = nx;
      }
      if (side < 0) bankW[r] = hit; else bankE[r] = hit;
    }
  }

  return { path, centre, slope, half, bankW, bankE, field };
}

const tables = (): RiverTables => (riverTables ??= buildRiverTables());

/** The projected course, x and z interleaved. For probes and the plan view; not a hot path. */
export const tiberPath = (): Float64Array => tables().path;

const sampleRow = (table: Float64Array, z: number): number => {
  let f = (z - RIVER_ROW_LO) / RIVER_ROW_STEP;
  f = f < 0 ? 0 : f > RIVER_ROW_N - 1.001 ? RIVER_ROW_N - 1.001 : f;
  const i = f | 0;
  return table[i] + (table[i + 1] - table[i]) * (f - i);
};

/**
 * Centreline of the Tiber as a function of z, off the survey.
 *
 * Well defined because the authored polyline is monotone in z over the whole map — and the
 * northern cut at z −300 is placed where it is partly *because* the real river stops being a
 * function of z 172 m further north, at the Pons Milvius. `tiber-author.mjs` prints the check.
 */
export const riverCentreX = (z: number): number => sampleRow(tables().centre, z);

/**
 * The channel's half-width at this z, in metres, measured perpendicular to the flow.
 *
 * Off Lanciani's inked channel, binned by northing in 400 m bins and Gaussian-smoothed. It is a
 * **trend, not detail**: the two independent width measurements available — Lanciani's ink and
 * the orthophoto's gated water — correlate at **r = 0.037** over 264 paired stations, so neither
 * resolves the width at a station, and a station-by-station profile would be structure no source
 * can see. What they agree on is the scale (median 86 m) and the long trend, which is what this
 * carries: narrowest through the Campus Martius bend, widest below the Capitol.
 */
export const riverHalfWidthAt = (z: number): number => sampleRow(tables().half, z);

/**
 * Local channel bearing as dx/dz. Still used to decide which bank is the cut bank, and by callers
 * that want a row-wise scale. **It is no longer used to compute a distance** — that was the fault
 * (see the head of this section) and `riverOffset` now reads the field.
 */
export const riverCurvature = (z: number): number => sampleRow(tables().slope, z);

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
 * The base and amplitudes were chosen so the global minimum is z = 252 — still true, at
 * x −343 — which keeps the slope clear of the Roman deployment box. An earlier version
 * bottomed out at z = 156 and put a 45° hillside inside the parade ground.
 *
 * **The clearance is now 3.1 m and it used to be 74.9, and the reason is §15 task 14.** The
 * sentence above said the box "reaches z 255 and holds the bolt-throwers at z 246"; it reaches
 * **z 270** and holds them at **z 262.5**, and it has done for two passes. What matters is not
 * the global minimum but the minimum *over the box's own x range*, and task 14 widened that
 * range east: over x −45…455 the toe never came below **z 344.9**, and over x −45…805 it reaches
 * **z 273.1 at x 805**, the box's new south-east corner. Nothing is over
 * `ROUGH_SLOPE_IMPASSABLE` there — the worst slope measured anywhere across that edge is 0.285,
 * the worst under any Roman man is 0.074, and at z 270 the rise itself has not started — but the
 * margin is now 3 m of x-wobble rather than seventy.
 *
 * **So this is the constraint on ever deepening the defender's box**, which §15 task 14 wants
 * (`hz` 120 → 150, for the twelve-man scorpio battery standing at mask 0.024). At `hz` 150 the
 * south edge is z 300, which is **26.9 m past the toe** at x 805: a corner of parade ground
 * flattened into the side of the Pincian. Deepening the box and widening it east are not
 * independent decisions, and this expression is where they meet.
 */
export const riseToeZ = (x: number): number =>
  330 + 52 * Math.sin(x * 0.00476) + 26 * Math.sin(x * 0.01053 + 2.1);

/**
 * How far the ground rises onto the hills at a given x, in metres above the plain.
 *
 * **The seven-band staircase of `docs/ROME.md` §3.5**, which replaced two Gaussian
 * shoulders. `CARTHAGE.md` says *"At Rome the wall stands on a hill. At Carthage it stands
 * on nothing"*, and §3.1 shows that is true of the eastern two thirds of this circuit and
 * false of the western third — the third the map is named after. The Campus Martius is a
 * Tiber flood plain and the Aurelian wall crosses it dead flat from the river to the foot
 * of the Pincian; the shipped Gaussians put a 22-34 m rise under every bay of it, so the
 * one stretch with no terrain advantage at all — which is precisely why a besieger goes for
 * it, and precisely why §4.7 leaves it unfinished — was the best-defended ground on the map.
 *
 *     x            stretch                       rise    note
 *     +2 … +100    river angle, Porta Flaminia    0      flat; the defence is 6.5 m of brick
 *     +100 … +187  the Campus neck                0 → 2  the ground just begins to lift
 *     +187 … +446  the Muro Torto                 2 → 38 36 m over 259 m, 1:7.2 built
 *     +446 … +620  the Pincian crest             38 → 43 a garden terrace
 *     +620 … +790  the Vallis Sallustiana        43 → 23 20 m over 170 m, 1:8.5
 *     +790 … +1050 the east shoulder             23 → 36 onto the Quirinal's northern spur
 *     +1050 … +1335 the Castra Praetoria         36 → 38 a made platform
 *
 * §3.5's table overlaps once: the Campus neck is written "+100 … +250 | 0 → 2" and the Muro
 * Torto "+187 … +446 | 2 → 38", and both claim x 187…250. The Muro Torto row is the one
 * with arithmetic attached to it, so its start is taken as the precise figure and the
 * neck's end as the loose one; `tools/scratch/probe-rometransect.mjs` records the same
 * reading, and the two would have to be changed together.
 *
 * West of the river angle there is no rise at all — that is the ager Vaticanus and Trans
 * Tiberim, flat plain outside the circuit (§6.6), and the Janiculum comes from a monument's
 * own mound rather than from here. East of the Castra the platform simply continues.
 */
const RELIEF_BANDS: readonly number[] = [
  2, 0, 100, 0, 187, 2, 446, 38, 620, 43, 790, 23, 1050, 36, 1335, 38,
];

/**
 * Radius over which each corner of the staircase is rounded, in metres of x.
 *
 * A piecewise-linear profile has a crease at every knot, and the wall's bench is graded to
 * this function, so a crease here is a crease in the ground the curtain stands on. Adding
 * the exact moving average of the corner over ±R rounds it into a C¹ parabola: the
 * correction is `(sRight - sLeft)·(R - |x - knot|)² / 4R`, which is the analytic mean and
 * therefore costs no shape anywhere else. At 16 m the largest departure from the published
 * table is **0.67 m**, at the Vallis Sallustiana's lip, against the ±1.5 m the acceptance
 * allows; the shortest band is 87 m, so the windows never overlap.
 */
const RELIEF_ROUND = 16;

export const riseAmplitude = (x: number): number => {
  const n = RELIEF_BANDS.length / 2;
  const x0 = RELIEF_BANDS[0];
  const xN = RELIEF_BANDS[(n - 1) * 2];
  let y: number;
  if (x <= x0) y = RELIEF_BANDS[1];
  else if (x >= xN) y = RELIEF_BANDS[(n - 1) * 2 + 1];
  else {
    y = RELIEF_BANDS[1];
    for (let i = 1; i < n; i++) {
      const a = RELIEF_BANDS[(i - 1) * 2];
      const b = RELIEF_BANDS[i * 2];
      if (x > b) continue;
      const ya = RELIEF_BANDS[(i - 1) * 2 + 1];
      const yb = RELIEF_BANDS[i * 2 + 1];
      y = ya + ((yb - ya) * (x - a)) / (b - a);
      break;
    }
  }
  // Round every corner, the two ends included: outside the table the profile is level, so
  // the anchors are corners too.
  for (let i = 0; i < n; i++) {
    const c = RELIEF_BANDS[i * 2];
    const d = x - c;
    if (d <= -RELIEF_ROUND || d >= RELIEF_ROUND) continue;
    const yl = i > 0 ? RELIEF_BANDS[(i - 1) * 2 + 1] : RELIEF_BANDS[1];
    const yc = RELIEF_BANDS[i * 2 + 1];
    const yr = i < n - 1 ? RELIEF_BANDS[(i + 1) * 2 + 1] : yc;
    const sL = i > 0 ? (yc - yl) / (c - RELIEF_BANDS[(i - 1) * 2]) : 0;
    const sR = i < n - 1 ? (yr - yc) / (RELIEF_BANDS[(i + 1) * 2] - c) : 0;
    const w = RELIEF_ROUND - (d < 0 ? -d : d);
    y += ((sR - sL) * w * w) / (4 * RELIEF_ROUND);
  }
  return y;
};

/** Length of the slope from toe to crest. Short enough to read as a hill front. */
export const RISE_RUN = 175;

/**
 * Height of the crest of the city rise at a given x — the terrain's own brow.
 *
 * **Not the wall's line**; that is `romeWallZ`. This is what the name says, and what the
 * projection needs: `GATE_X` below is the fixed point of `roadCentreX(crestZAt(x))`, because
 * the gate has to be where the Via Flaminia crosses the brow, and the whole affine map's
 * origin is derived from the answer. Anything that wants to know where the *wall* is must
 * ask `romeWallZ`.
 */
export const crestZAt = (x: number): number => riseToeZ(x) + RISE_RUN;

// ---------------------------------------------------------------------------
// The projection, and the circuit it puts on the ground — §2.3, §2.5, §4.2
// ---------------------------------------------------------------------------

/**
 * **The survey projection lives here now, and that is §15 task 3's first move.**
 *
 * It was in `city/rome/survey.ts`, and `probe-rometransect.mjs`'s own header explains why
 * that cost something: *"`terrain/topography.ts` cannot import `city/rome/survey.ts` … The
 * river's polyline therefore has to be stored in `topography.ts` already projected, in world
 * metres, which is exactly the kind of transcription that rots."* Task 3 needs a **second**
 * projected polyline — the circuit — read by the wall's line, the heightfield's bench, the
 * scatter's glacis and the city's northern limit, and transcribing that one as well would be
 * the same fault twice.
 *
 * Nothing about the projection needed `survey.ts`: `GATE_X` is the fixed point of
 * `roadCentreX(crestZAt(x))` and both of those are in this file. So the whole affine map
 * moves down here and `survey.ts` re-exports it. One definition, and `worldOf` is now
 * available to the terrain, which is what lets the circuit be authored in survey metres
 * instead of copied in world metres. `KX`, `KZ` and the anchors are unchanged to the digit.
 */
export const GATE_X = (() => {
  let x = 20;
  for (let i = 0; i < 6; i++) x = roadCentreX(crestZAt(x));
  return Math.round(x * 10) / 10;
})();
export const GATE_Z = crestZAt(GATE_X);

/** Real position of the Porta Flaminia in the survey frame: Piazza del Popolo. */
const PORTA_FLAMINIA_E = -497;
const PORTA_FLAMINIA_N = 2045;

/**
 * East–west scale. From the Porta Flaminia to the west wall of the Castra Praetoria is
 * 2,436 real metres, and the world curtain runs 1,078 m from the gate to its east end,
 * so the scale is fixed by the two anchors rather than chosen: 1078 / 2436 = 0.443.
 */
export const KX = 0.443;

/**
 * Depth scale. **0.35, and the constraint that produced it is a fabric, not a monument.**
 *
 * It was **0.222**, and that number was *"the largest value that fits Caracalla inside the map
 * with its precinct clear of the edge"* — the Baths of Caracalla being 3,545 real metres south
 * of the Porta Flaminia and the heightfield being 940 m deep behind the crest. That is a real
 * constraint honestly stated, and it was the wrong constraint. `docs/ROME-FABRIC.md` §4.3 and
 * §4.5 are the measurement that replaced it:
 *
 *  - Real cross-street pitch in the Campus Martius is **50–90 m**. At `KZ` = 0.222 that
 *    projects to **11.1–20.0 world m**, and a true-depth insula needs `INSULA_DEPTH_MAX` 22 m
 *    plus two frontages — about **30 m**. **A true-scale insula did not fit between two
 *    projected cross-streets at any point in the range.** Any generator deriving blocks from
 *    projected streets was therefore forced to drop two cross-streets in three and stand one
 *    22 m building in a 60 m gap, which is the blobs-between-voids the owner objected to,
 *    arrived at honestly. At 0.35 the pitch is **17.5–31.5 m** and a street front is possible.
 *  - The Campus Martius — the 700 world metres behind the gate the assault comes through, where
 *    the battle's second act happens — went from **450 world metres** of depth holding 2,117
 *    real metres of the densest monumental quarter in the ancient world to **709**, +58 %.
 *  - Anisotropy against `KX` falls from **2.00×** to **1.266×**.
 *  - Conflicting monument pairs, footprints at 0.65 and the five §4.1 complexes merged, fall
 *    from **22** to **13**, each one now a named authored exception rather than a solve.
 *
 * **What it costs, and the cost was accepted in writing before it was taken.** Five monuments
 * and one ridge fall past the +Z edge and are not drawn: the Palatine, the Circus Maximus, the
 * Aventine temples, the Baths of Caracalla, the Caelian villas, and the Janiculum ridge. All
 * are 700–800 world metres behind the wall, in `ROME.md` §6.1's backdrop zone, and none is
 * fought over. The Colosseum, the Ludus Magnus, the Oppian baths, the Forum Romanum, the
 * Capitolium, the Theatre of Marcellus and the Tiber Island all survive. See
 * `offMapSouth` in `city/rome/layout.ts` for the predicate that drops them, and
 * `ROME-FABRIC.md` §1.2 for why holding all of Rome was the thing that could not work:
 * *"Carthage did not model Carthage."*
 *
 * **`KX` is not changing and cannot.** The front runs from the Tiber angle at `e` −655 to the
 * Castra's north-east angle at `e` +2353, and the east end lands at `72 + 2850·KX`: 1334.5 at
 * 0.443, 1400.1 at 0.466. There is 65 m of headroom on a 2,800 m map and nothing to win.
 *
 * **Neither anchor moves with this.** `GATE_X` is the fixed point of
 * `roadCentreX(crestZAt(x))` and `GATE_Z = crestZAt(GATE_X)`; both are functions of x and z
 * alone and contain no `KZ`, so the 725.7 m approach from the attacker's box to the gate is
 * unchanged, and so are the front's length, its 36 bays and their 37.015 m pitch.
 *
 * Reproduce every number above with `node tools/scratch/rome-frame.mjs`, which re-derives the
 * projection from the two anchors rather than importing it from here.
 */
export const KZ = 0.35;

const X0 = GATE_X - KX * PORTA_FLAMINIA_E;
const Z0 = GATE_Z + KZ * PORTA_FLAMINIA_N;

/** Project survey metres to battlefield metres. §2.3. */
export const worldOf = (e: number, n: number): { x: number; z: number } => ({
  x: X0 + KX * e,
  z: Z0 - KZ * n,
});

/**
 * **The Aurelian circuit, as the fourteen surveyed waypoints of §2.5.** §4.2, §15 task 3.
 *
 * Metres east and north of the Temple of Jupiter Optimus Maximus, in the order the wall
 * runs: the Tiber angle, the Porta Flaminia, three points along the Muro Torto, the
 * Posterula Pinciana, the two lips of the Vallis Sallustiana with the Porta Salaria between
 * them, the Porta Nomentana, and the Castra Praetoria's three angles, whence the circuit
 * turns south and leaves the map on the line to the Porta Tiburtina.
 *
 * §4.2: *"Author the circuit as a polyline in the survey frame and project it, the way every
 * monument is already authored, rather than as `crestZAt(x)`. Getting Rome's circuit wrong
 * should then require getting the survey wrong."* Held in **survey** metres and projected
 * below rather than stored in world metres, because the survey is the thing with a source.
 */
export const ROME_CIRCUIT_SURVEY: readonly { id: string; e: number; n: number }[] = [
  { id: 'tiber-angle', e: -655, n: 2006 },
  { id: 'porta-flaminia', e: -497, n: 2045 },
  { id: 'muro-torto-west', e: -273, n: 2039 },
  { id: 'muro-torto-mid', e: -8, n: 1995 },
  { id: 'muro-torto-east', e: 273, n: 1928 },
  { id: 'posterula-pinciana', e: 530, n: 1789 },
  { id: 'sallustiana-west', e: 762, n: 1784 },
  { id: 'porta-salaria', e: 1036, n: 1784 },
  { id: 'sallustiana-east', e: 1301, n: 1756 },
  { id: 'porta-nomentana', e: 1831, n: 1784 },
  { id: 'castra-nw', e: 1931, n: 1711 },
  { id: 'castra-ne', e: 2353, n: 1578 },
  // The east return. Not part of the land front and deliberately not part of `romeWallZ`:
  // the circuit turns south here and a wall that runs in z cannot be a function of x, which
  // is §4.6's whole argument for why neither return carries bays. Published so §15 task 9
  // has the line without re-deriving it.
  { id: 'castra-se', e: 2295, n: 1256 },
  { id: 'porta-tiburtina', e: 2709, n: 333 },
];

/** The same fourteen in world metres. */
export const ROME_CIRCUIT: readonly { id: string; x: number; z: number }[] =
  ROME_CIRCUIT_SURVEY.map((p) => ({ id: p.id, ...worldOf(p.e, p.n) }));

/**
 * The land front: the twelve waypoints from the Tiber angle to the Castra's north-east
 * angle, which is the stretch that carries bays and the stretch `romeWallZ` interpolates.
 *
 * Monotone in x by construction — x runs +2.0, 72.0, 171.2, 288.6, 413.1, 527.0, 629.7,
 * 751.1, 868.5, 1103.3, 1147.6, 1334.6 — which is what lets the wall be indexed
 * arithmetically in x at all (§2.1, constraint 1).
 */
export const ROME_FRONT = ROME_CIRCUIT.slice(0, 12);

/**
 * **The Aurelian circuit's line, and the only definition of it.** §14.5, §15 tasks 2 and 3.
 *
 * `docs/ROME.md` §14.5 records the fault this export exists to close: `cityPlan.ts` found
 * Carthage's wall line in three places — the terrain's quadratic, `circuit.ts`'s bowed
 * interpolation and the wall builder's own — agreeing at three anchors and 25 m apart at
 * mid-span, which is wider than the bench they were all supposed to stand on. Rome's
 * version of the same fault was quieter and worse: there was no wall line at all, only
 * `crestZAt`, the *terrain's* crest, which the heightfield used to shape a hill, the wall
 * builder used to lay masonry, the scatter used to clear a glacis and the fabric used to
 * decide where the city starts. Four meanings, one function, and nothing to change when
 * any one of them had to move.
 *
 * Task 2 gave the line its own name with the terrain's crest still inside it. **Task 3 puts
 * the survey inside it**, and every consumer moved with it because there is only the one:
 * the heightfield's bench (`buildTerrain` stage 4d), `city/rome/circuit.ts`'s `wallCrestZ`
 * and `fitWallPath`, `ScatterField`'s glacis clearance, `campusMartius.ts`'s scatter
 * exclusion and `survey.ts`'s `CITY_Z_MIN`.
 *
 * **The gap it closed was 157 m.** The surveyed circuit rises smoothly from z 538.4 at the
 * Tiber to z 633.4 at the Castra's north-east angle; `crestZAt` wanders between z 437 and
 * z 561 and was 157 m north of the survey at x +868. Rome's wall now stands where Rome's
 * wall stands, and the ground it stands on is graded to it rather than to a sine wave.
 *
 * **Do not bow it** (§4.2). Carthage's 25 m sagitta exists because a 4.4 km straight reads
 * as an extruded rectangle; this line has its own kinks from the ground, and adding a bow on
 * top would invent a curvature the archaeology contradicts.
 */
export const romeWallZ = (x: number): number => {
  const p = ROME_FRONT;
  if (x <= p[0].x) return p[0].z;
  const last = p[p.length - 1];
  if (x >= last.x) return last.z;
  for (let i = 1; i < p.length; i++) {
    if (x > p[i].x) continue;
    const a = p[i - 1];
    const b = p[i];
    return a.z + ((b.z - a.z) * (x - a.x)) / (b.x - a.x);
  }
  return last.z;
};

/**
 * Ground level under the wall's footing — the profile §3.5 publishes, and the elevation the
 * heightfield's bench is graded to.
 *
 * §3.5: *"`crestHeightAt(x)` is the city agent's contract for where the wall's footing sits
 * and it must be re-derived from the new profile in the same call the heightfield grades
 * the bench with, or half the circuit stands off its footing."* At `66b220b` it had **no
 * readers at all** outside this file — a live-looking contract nothing had ever signed.
 * `buildTerrain` stage 4d now grades to exactly this, so the two cannot disagree.
 */
export const crestHeightAt = (x: number): number =>
  regionalPlain(x, romeWallZ(x)) + riseAmplitude(x);

/**
 * Half-width of the graded bench the terrain lays under the wall, metres.
 *
 * **40 m, and it is Carthage's number on purpose** (`maps/carthage/topography.ts`), whose
 * comment says Rome "needs no equivalent because its curtain stands on a natural crest".
 * That was measured and it is false: §4.1's source audit found that *Rome's heightfield
 * cuts no bench at all*, that `buildWall` levels each bay to whatever ground it finds, and
 * that this is the mechanism behind a **28.39 m** worst bay-to-bay `walkY` step and a
 * 26-metre cliff inside twenty world metres at the west end. 40 m carries the 6 m curtain,
 * the 3.5 m tower projection and the pomerium's movement corridor with a working margin,
 * and it is the width the acceptance in §15 task 2 is written against.
 */
export const WALL_BENCH_HALF = 40;

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
 * The axis the two lines face each other along, and the west edge both boxes are solved from.
 *
 * **It is no longer either box's centre.** It was, while both boxes were ±h about it; §15
 * task 14 widened them east and left their west edges alone, so each box now carries its own
 * `cx` and this is what `DeployGround.axisX` has always meant — the battle's axis, not a
 * rectangle's midpoint. Everything below is about where the *west* edges came from, and none
 * of it has changed: `−175` north and `−45` south are still `205 − 380` and `205 − 250`.
 *
 * **Both boxes had to move east, and the distance is measured rather than chosen.** §3.2:
 * *"`germanDeployMask`'s 490 m half-width no longer fits between the corrected river and the
 * eastern high ground at z -196 and must come in to about ±380 m about x +40 … Do not
 * attempt this change without also moving the deployment box; a cohort deployed in the
 * Tiber is the failure mode."*
 *
 * ±380 about +40 is not enough, and the reason is that the boxes are 240-260 m deep while
 * the approach is a funnel (§3.2's second consequence). The binding constraint is not the
 * channel at a box's centre latitude but its closest approach anywhere inside it, which is
 * always at the box's *southern* edge. Measured on the built heightfield by
 * `tools/scratch/probe-rometransect.mjs --only=funnel`, east edge of standing water:
 *
 *     German box   z -326 … -66     water ends at  -456 … -198
 *     Roman box    z   30 …  270    water ends at  -144 …  -68
 *
 * So at ±380 about +40 the German box would hold 142 m of open water along its south edge
 * and the Roman box 272 m. One axis at **+205** clears the German box's worst row by 23 m
 * at §3.2's full ±380; the Roman box stands 240 m deeper into the funnel and has to be
 * narrower to clear its own, which is the map's own argument rather than a compromise —
 * *"there is one good way to bring a mass at this gate, and the defender knows it."*
 *
 * **What this used to not do, and it was the loudest finding of the pass that moved it.** These
 * masks flatten ground, exclude vegetation and paint the trodden channel of the control
 * texture. They did **not** place anybody: `sim/scenario.ts`'s field deployment laid both lines
 * out at fixed x about zero — `centred(n, 64)`, `flanking(n, lineHalf + 50, 52)` — and knew
 * nothing about them. So §3.2's own remedy named the wrong mechanism, and moving these boxes
 * left the shipped field order of battle exactly where it was: 747 of 8,632 men in the Tiber
 * and 412 dry on the far bank, measured by `tools/probe-ground.mjs`.
 *
 * **Closed.** `DEPLOY_GROUND` below is the seam, and `standOnDeploymentGround` in
 * `sim/scenario.ts` is the reader. The reference to "§15 task 8" that stood here was a slip for
 * **task 14**, which is where the order of battle lives; task 8 is the building site.
 */
export const DEPLOY_AXIS_X = 205;

/**
 * Soft edge on every deployment box, in metres.
 *
 * Published on each box as `DeployBox.feather` rather than kept private here, because
 * `sim/scenario.ts` insets by it — see `DEPLOY_GROUND` and `standOnDeploymentGround`.
 */
const DEPLOY_FEATHER = 80;

/**
 * Where the armies form up. Terrain inside these boxes is flattened onto the regional
 * plane so that a 40-man-wide cohort cannot be broken in half by a hillock, they carry
 * the trampled-ground channel of the control texture, and vegetation is excluded from
 * them so no tree stands inside a formation.
 *
 * Half-widths were 490 m, sized against a Roman line of eight cohorts on 70 m centres with
 * urban cohorts refusing both flanks at ±320 m and the cavalry wings out at ±450. §3.2
 * takes the attacker's to 380; the defender's was 250 because it stands where the funnel has
 * already closed. See `DEPLOY_AXIS_X`.
 *
 * **This is now data, and the masks are derived from it**, because `sim/scenario.ts` reads it
 * too — see `maps/types.ts`'s `DeployGround`. The paragraph above about the field order of
 * battle knowing nothing about these boxes was true when it was written and is not any more.
 *
 * ---
 *
 * **§15 task 14's reserved half, decided: the boxes are widened east and the frontages are
 * not touched.** The finding that opened it stands and is worth keeping in front of whoever
 * reads this next — at `DEFAULT_CONFIG` on the `high` tier the Roman line measures **684 m**
 * across its own men against a **500 m** box and the Juthungi host **783 m** against 760, and
 * **562 Roman and 182 Juthungi men stood outside their own box**, all but 14 of them east. The
 * owner's decision was *"battle lines should fit their deployment boxes. I would recommend
 * widening boxes east."*
 *
 * **Three numbers moved and each one is derived rather than chosen.**
 *
 *  1. **Neither west edge moves**, and that is the constraint everything else is solved
 *     against. `cx − hx` is still −175 north and −45 south, the two lines task 1 measured
 *     against the funnel's standing water: at their worst rows the boxes clear it by 23 m,
 *     and a box that grew symmetrically would take the defender's edge from −45 to −225 and
 *     put a quarter of the parade ground in the Tiber. Widening east is not a preference here,
 *     it is the only direction with ground in it.
 *  2. **Each east edge stands one feather beyond the outermost man**, so the whole line is
 *     inside the mask's full-strength core rather than on its soft edge — the band the
 *     heightfield only fractionally flattens and the scatter does not clear at all (its own
 *     threshold is 0.12, which the feather does not reach until 17 m in). With the placement
 *     rule below insetting by the same feather, the outermost men stand at x 719.3 (Rome) and
 *     770.9 (the host), so the cores must reach 725 and 775 and the rectangles 805 and 855.
 *     Rounding the half-widths to 425 and 515 lands them there with 5.7 m and 4.1 m to spare.
 *  3. **The battle stands 80 m further east than it did** — one feather — because
 *     `standOnDeploymentGround` anchors the line's west end to the box and now insets by the
 *     feather when it does. That is where the 14 men outside to the *west* came from: the rule
 *     used to park the outermost file exactly on the contour where the mask reaches zero.
 *
 * Measured on the built heightfield by `tools/probe-ground.mjs --quality=high`: men outside
 * their own box 562/182 → **0/0**, in water 0 → 0, on the far bank 0 → 0, over
 * `ROUGH_SLOPE_IMPASSABLE` 0 → 0, trees within 4 m of a man 1/4 → 0/0.
 *
 * **What is *not* fixed, with its number, because it will otherwise be rediscovered.** The
 * defender's box is under-sized in **depth**, not only in width: at `hz` 120 about z 150 its
 * full-strength core is z 110…190 and the Roman line is 141 m deep, so the twelve-man scorpio
 * battery at z 262.5 stands where the mask reads **0.024** — inside the box by the arithmetic
 * and on ground that is 2 % flattened and never cleared of trees. It passes the acceptance
 * (the threshold is 0.02) by 22 %, and it is the weakest reading under any man on the map.
 * The fix is `hz` 120 → about 150, which is 30 m of box at each end in z, and it was left alone
 * deliberately — because deepening the box and widening it east are not independent decisions,
 * and widening it east is the one that was made. See `riseToeZ`: over the box's old x range the
 * hill toe never came below z 344.9, over the new one it reaches **z 273.1 at x 805**, so the
 * z 270 south edge now clears it by 3.1 m and at `hz` 150 would stand 26.9 m *past* it. It would
 * also bring the south edge within 17 m of the quarry at (724, 328).
 */
export const DEPLOY_GROUND = {
  axisX: DEPLOY_AXIS_X,
  north: { cx: 340, cz: -196, hx: 515, hz: 130, feather: DEPLOY_FEATHER },
  south: { cx: 380, cz: 150, hx: 425, hz: 120, feather: DEPLOY_FEATHER },
} as const satisfies DeployGround;

export const germanDeployMask = (x: number, z: number): number =>
  rectMask(x, z, DEPLOY_GROUND.north.cx, DEPLOY_GROUND.north.cz,
    DEPLOY_GROUND.north.hx, DEPLOY_GROUND.north.hz, DEPLOY_GROUND.north.feather);
export const romanDeployMask = (x: number, z: number): number =>
  rectMask(x, z, DEPLOY_GROUND.south.cx, DEPLOY_GROUND.south.cz,
    DEPLOY_GROUND.south.hx, DEPLOY_GROUND.south.hz, DEPLOY_GROUND.south.feather);

/**
 * The whole fighting corridor. High-frequency relief is damped here, swells are kept.
 *
 * **Moved east with the boxes, and it had to be.** It was `(0, −30, 540, 360)` — centred on
 * x 0 with a 540 m half-width, which was right while the battle formed up about the road and
 * wrong from the moment task 1 pushed the deployment 271 m east. At `5338249` the host's right
 * wing stood at x 691 and the corridor ended at 540, so the wing that decides the flank was
 * outside the fighting corridor entirely and fighting over undamped 46 m and 150 m relief.
 *
 * The west edge stays at −540: it covers the river angle, the Porta Flaminia and the west end
 * of the circuit, and nothing about the army asks it to move. The east edge is the outermost
 * man plus one feather — 770.9 + 170 = 941 — rounded to a half-width of 745 about the
 * deployment axis, which puts the rectangle at −540 … 950 and the fully-damped core at
 * −370 … 780. The corridor is the one number here that is *not* a deployment box, so it is
 * written against the axis rather than against either box's edge.
 */
export const battleCoreMask = (x: number, z: number): number =>
  rectMask(x, z, DEPLOY_AXIS_X, -30, 745, 360, 170);

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

/**
 * Horizontal-to-perpendicular scale for the channel at this z, in (0, 1].
 *
 * **Kept, and no longer used for distance.** It is `1 / hypot(1, dx/dz)`: the factor that turns
 * an offset measured along a row into a perpendicular one, *for the infinite straight line
 * tangent to the channel at that row*. That approximation is exact on a straight reach and
 * badly wrong at a bend, and it was the whole distance model until this pass. `riverOffset` now
 * reads a signed distance field instead. This survives because `heightfield.ts` still wants a
 * cheap per-row scale for its early-out, and because the number itself is meaningful.
 */
export const riverPerpScale = (z: number): number => {
  const s = riverCurvature(z);
  return 1 / Math.sqrt(1 + s * s);
};

/**
 * **Signed perpendicular distance from the Tiber's centreline**, in metres, negative west.
 *
 * A bilinear sample of the signed distance field built at the head of this file: 8 m over the
 * map plus a 200 m margin, saturating at +/-320 m, which is clear of `riverInfluence`'s 266 m
 * reach. Exact everywhere including at bends, which the expression it replaces
 * — `(x - riverCentreX(z)) * riverPerpScale(z)` — was not.
 *
 * How wrong the old one was, measured on the surveyed course: at the Tiber Island the channel
 * runs at 79 degrees to the z axis, so `riverPerpScale` is 0.19 and a point 400 m east along
 * that row was reported as 78 m from the water. **Sixty of 1 259 city solids stood under
 * `WATER_LEVEL` and nothing in the engine could see why.**
 */
export const riverOffset = (x: number, z: number): number => {
  const t = tables();
  const f = t.field;
  let fx = (x + FIELD_HALF) / FIELD_STEP;
  let fz = (z + FIELD_HALF) / FIELD_STEP;
  fx = fx < 0 ? 0 : fx > FIELD_N - 1.001 ? FIELD_N - 1.001 : fx;
  fz = fz < 0 ? 0 : fz > FIELD_N - 1.001 ? FIELD_N - 1.001 : fz;
  const i = fx | 0;
  const j = fz | 0;
  const u = fx - i;
  const v = fz - j;
  const r0 = j * FIELD_N + i;
  const r1 = r0 + FIELD_N;
  const mag = (f[r0] * (1 - u) + f[r0 + 1] * u) * (1 - v)
    + (f[r1] * (1 - u) + f[r1 + 1] * u) * v;
  // The magnitude comes from the field and the sign from the row table. See `RiverTables.field`.
  return x < sampleRow(t.centre, z) ? -mag : mag;
};

/**
 * The channel's banks in *x* at a given z — what a caller working along a row needs.
 *
 * Solved against the distance field at build time, per 4 m row: march out from the centre until
 * the field reaches the local half-width, and interpolate. `EAST_BANK`, `FAR_BANK`, the wall's
 * west anchor and the plan view all ask this question, and they used to answer it with
 * `centre ± half / perpScale`, which is the straight-line approximation and is out by up to 4.7x
 * on this course.
 */
export const riverBankX = (z: number, side: number): number =>
  sampleRow(side < 0 ? tables().bankW : tables().bankE, z);

/**
 * **The Tiber Island, as a bar standing out of the channel.**
 *
 * Returns 1 on the island's crown, 0 in open water, with a smooth shoulder. The test is done in
 * the *survey* frame, where the island is an ellipse of its published 270 x 67 m at bearing 121
 * degrees; projecting an ellipse through an anisotropic map does not carry its axes across, so
 * un-projecting the query point is both simpler and exact.
 *
 * The island's dimensions are `city/rome/survey.ts`'s cited row, checked against the plate this
 * pass rather than trusted: measured length 308 m and width 108 m off the orthophoto, which
 * become 273 and 73 once the 35 m the water gate erodes off a channel is subtracted — the same
 * 35 m by which the main channel's two independent width measurements differ. Both within 10 %
 * of the published 270 x 67.
 */
const ISLAND_RAD = (TIBER_ISLAND.bearingDeg * Math.PI) / 180;
const ISLAND_SIN = Math.sin(ISLAND_RAD);
const ISLAND_COS = Math.cos(ISLAND_RAD);
export const islandMask = (x: number, z: number): number => {
  const e = (x - X0) / KX;
  const n = (Z0 - z) / KZ;
  const de = e - TIBER_ISLAND.e;
  const dn = n - TIBER_ISLAND.n;
  const u = (de * ISLAND_SIN + dn * ISLAND_COS) / (TIBER_ISLAND.lengthM * 0.5);
  const v = (de * ISLAND_COS - dn * ISLAND_SIN) / (TIBER_ISLAND.widthM * 0.5);
  return 1 - sstep(0.74, 1.0, Math.hypot(u, v));
};

/** Height of the island's crown, metres. Travertine and tufa; it has never been flooded out. */
export const ISLAND_TOP = WATER_LEVEL + TIBER_ISLAND.riseM;

/**
 * Clear ground the wall's west end keeps between itself and the Tiber's east bank, metres.
 *
 * **12 m, and the number is set by closure rather than by taste.** §4.1: *"the historical
 * wall terminated at the river with a tower rather than running masonry into water"*, and
 * `works.ts` already draws that tower — a 15.2 m brick drum with a towpath postern, footed
 * 4.5 m below the flood line. At 12 m of clearance the drum's west face reaches the water's
 * edge and the circuit's west end is shut; at any more it does not, and there is a dry
 * corridor round the end of the Aurelian Wall.
 *
 * Measured: with the drum blocking and the clearance at 42 m, `probe-nav --only=connectivity`
 * walks a 4.4 m body from the attacker's side to (0, 553) — inside the circuit, round the
 * west end, along 30 m of flood terrace. §3.2's third consequence is *"the west flank closes
 * for free"*, and that is true of the *river*; it is not true of the 42 m between the river
 * and the wall.
 *
 * **The 42 m is worth keeping as a cross-check even though it is not used.** §2.5 puts the
 * circuit's north-west angle at **x +2.2**, and solving `x = riverBankX(romeWallZ(x), +1) + 42`
 * lands on **x +1** — so the surveyed circuit and the surveyed river, projected independently
 * through the same affine map, agree to a metre about where the wall meets the water. That is
 * the check that says both tables are right. §15 task 3 sets the anchor from the circuit
 * polyline and §15 task 9 builds §4.6's river wall down the left bank, which is what closes
 * this properly; until then the terminus does it.
 */
export const WALL_RIVER_CLEAR = 12;

/**
 * West end: the surveyed north-west angle on the Tiber's left bank, x +2.0. §2.5, §4.2.
 *
 * **It was solved from the river and is now read off the circuit**, which is the change
 * §15 task 3 asks for — *"lay 36 bays at a 37.03 m x-pitch from x +2"* — and the two do not
 * agree. `riverBankX(romeWallZ(x), 1) + WALL_RIVER_CLEAR` converges on **x −26.6**, so the
 * curtain used to begin **28.6 world metres west of the point the survey puts its angle at**,
 * and the comment above `WALL_RIVER_CLEAR` claimed the two agreed "to a metre". They do not:
 * the circuit's angle and the Tiber's channel are two independently projected surveys and at
 * this latitude they are **40.5 m** apart, the angle standing that far east of the modelled
 * east bank.
 *
 * The survey wins, because task 3's acceptance is written against it and because the bay
 * grid has to start somewhere the wall is. What that leaves is the 40.5 m of dry bank
 * between the angle and the water, which the terminus drum alone no longer spans — see
 * `works.ts`'s river-wall stub, the first thirty metres of §4.6's west return, built early
 * for exactly this reason.
 */
export const WALL_X_MIN = ROME_FRONT[0].x;

/**
 * East end: the Castra Praetoria's **north-east** angle, x +1334.6. §2.5, §4.6, §4.7.
 *
 * It was 1150, which §4.1 records is the camp's *north-west* angle — *"the circuit therefore
 * ends exactly where the incorporated fort begins, and the two walls Aurelian actually used
 * are both past the end of it"*. Lanciani counts 1,050 m of the camp's own wall as circuit,
 * the second largest single reuse on the whole 19 km, and this carries the modelled front
 * across its north face to the corner where it turns south and leaves the map.
 */
export const WALL_X_MAX = ROME_FRONT[ROME_FRONT.length - 1].x;

/**
 * The modelled front, end to end: **1,332.5 world metres.** §2.5.
 *
 * Against today's `WALL_X_MAX − WALL_X_MIN` of 1,781 on the shipped circuit — *"the front is
 * 448 world metres shorter and every metre of the difference is fiction that becomes river.
 * That saving is what pays for two extra gates, the Muro Torto, the Castra Praetoria and two
 * returns inside the same draw budget."*
 *
 * Lives here beside the two anchors rather than in `city/rome/circuit.ts`, where it used to,
 * so that `rome/layout.ts` and `rome/assertions.ts` can have it without importing the wall
 * builder — which is what would otherwise close a cycle now that the builder reads its own
 * assertions.
 */
export const WALL_LENGTH = WALL_X_MAX - WALL_X_MIN;

// ---------------------------------------------------------------------------
// The Muro Torto — §4.5, §15 task 4
// ---------------------------------------------------------------------------

/**
 * The Muro Torto: where it stands, how tall it is, and how far the hill is banked against
 * the back of it. **[MOD]** Lanciani 1897, 72–74; Cozza 1992.
 *
 * Published here rather than in `city/rome/` because half of it is a heightfield edit and
 * half of it is masonry, and §14.1's whole lesson is that a request that crosses that seam
 * with two copies of the dimensions is how Carthage published a ditch nobody dug. One
 * record: `heightfield.ts` stage 4d2 banks the earth, `city/rome/section.ts` stands the wall
 * on it, and `assertRomeSection` grades the joint between them at every boot.
 *
 * **`height` is 13.32 m and not §4.5's 15, and the reason is measured.** §4.5 says the height
 * is *"not established in metres"* — Cozza's elevations are in *ARID* 20 (1992) and are not
 * online — and instructs *"Build 15 m and say it is chosen."* 15 puts bays 5 and 6 at a
 * 15.0 m rise above their own ground, and `probe-siege`'s storm-ability check refuses any bay
 * within five of the gate that rises past 14 m: on the redesigned circuit the gate is bay 1
 * and the first two garrisonable bays either side of it *are* the Muro Torto's. 13.32 m is
 * **45 *pedes*** at §4.3b's 0.296 m module — on the five-*pes* grid the rest of this wall is
 * laid out on, 1.56× the curtain's 8.55 m to the merlon tops, and inside the envelope. It is
 * still by a long way the tallest thing on the northern front.
 */
export const MURO_TORTO = {
  /** §4.5: x +187 … +446, bays 5–11 at the 37.0 m pitch. */
  x0: 187,
  x1: 446,
  /** Height of the mass from its footing to the wall-walk on its crest. */
  height: 13.32,
  /**
   * How far the hillside is banked against the city face before it reaches crest level.
   *
   * 46 m gives 1:3.45, just gentler than the **1:3.2** §2.4a computes for the Pincian's own
   * north scarp under this projection, and well inside `ROUGH_SLOPE_IMPASSABLE` (1:1.6) and
   * `Pathfinding`'s 0.62 gradient refusal. This is the number that makes §4.5's central claim
   * true in the representation that acts on it: *"it needs no stairs, because a man walks
   * onto it off the Pincian's own hillside."*
   */
  bank: 46,
  /** How far the raised terrace runs back before the hill falls away into the city. */
  terrace: 120,
  /** Length of the fall from the terrace back to the natural ground behind it. */
  backslope: 150,
  /** How far the bank tapers out past each end of the stretch, in x. */
  taper: 44,
} as const;

/**
 * How much earth is banked against the inner face of the Muro Torto at this point, metres.
 *
 * Zero everywhere else on the map, zero on the field side of the wall line, and zero inside
 * the wall's own half-thickness so the transect §15 task 2 is graded on — `heightAt` along
 * the published circuit — reads §3.5's table unchanged. `heightfield.ts` applies it after the
 * bench; nothing else may.
 */
export const muroTortoBank = (x: number, z: number): number => {
  const m = MURO_TORTO;
  if (x < m.x0 - m.taper || x > m.x1 + m.taper) return 0;
  const ends = sstep(m.x0 - m.taper, m.x0, x) * (1 - sstep(m.x1, m.x1 + m.taper, x));
  if (ends < 1e-3) return 0;
  // Cityward distance from the inner face of the curtain. 3.0 m is `HALF_T`; kept as a
  // literal because `city/` may not be imported here and the two are asserted equal at boot.
  const d = z - romeWallZ(x) - 3.0;
  if (d <= 0) return 0;
  const up = sstep(0, m.bank, d);
  const down = 1 - sstep(m.bank + m.terrace, m.bank + m.terrace + m.backslope, d);
  return m.height * ends * up * down;
};

/**
 * Absolute height the terrace behind the Muro Torto is graded to, at full strength.
 *
 * The bank is applied as a **target**, not as an addition, for the same reason the bench
 * under the wall is: added relief follows the natural ground, and the natural ground here is
 * ridged multifractal with metres in it. A man steps onto the crest off this terrace, so what
 * matters is the difference between it and a `walkY` quantised to 0.55 m increments — and
 * eight per cent of survivng relief (the bench's own figure, which keeps it a graded platform
 * rather than a milled one) is the whole error budget the apron gets.
 */
export const muroTortoTopAt = (x: number): number => crestHeightAt(x) + MURO_TORTO.height;

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
  // while the inside of the bend silts up into a bar. side is the cut-bank side.
  const side = riverCurvature(z) > 0 ? 1 : -1;
  const onCutBank = d * side > 0;

  // The half-width is now measured off Lanciani per reach rather than being one constant:
  // 37 m through the Campus Martius bend, 50 m below the Capitol. `RIVER_HALF_WIDTH` survives
  // as the nominal figure for callers that want one number.
  const half = riverHalfWidthAt(z) * (1 + ford * 0.85); // the shoal is a wide, braided crossing
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
 * GLSL mirror of the functions the ground material needs per pixel.
 *
 * Injected into the terrain fragment shader. Constants are duplicated on purpose: uploading
 * them as uniforms would cost more than it saves and this keeps the shader readable. If you
 * change a centreline above, change it here too.
 *
 * **The Tiber's mirror is gone, and it is gone rather than re-fitted.** §15 task 1 asks for
 * the river mirror to be "re-fit or table-drive[n]", so the first thing this pass did was
 * find out who calls it. Nobody does: at `66b220b`, `grep -rn 'topoRiverCentreX|topoFord'
 * src` returns their own declarations and nothing else, and the only symbol in this block a
 * shader ever reads is `topoRoadCentreX`, at `TerrainMaterial.ts:328` and through
 * `grassRoadCentreX`. So there was a two-sine copy of the channel compiled into every
 * terrain program, unreachable, and already 250-776 world metres away from the survey.
 *
 * Re-fitting it was the other option and it is worse. The surveyed course is not a closed
 * form — two of its segments run at 66 and 78 degrees to the z axis — so the mirror would
 * have to be a const array of a hundred and forty floats resampled off `RIVER_LUT`, in
 * every terrain shader, for a function nothing calls. **A dead mirror that agrees is still
 * a claim the next reader will believe.** If a map ever does want a per-pixel channel, the
 * table to emit is `RIVER_LUT.x` and the sampler to emit is `sampleRiver`, both above, and
 * generating it from them is the only way it can stay in step.
 */
export const TOPO_GLSL = /* glsl */ `
const float TOPO_ROAD_HALF = ${ROAD_HALF_WIDTH.toFixed(3)};
const float TOPO_AGGER_HALF = ${AGGER_HALF_WIDTH.toFixed(3)};

float topoRoadCentreX(float z) {
  return 20.0 + 34.0 * sin((z + 300.0) * 0.0018519) - 18.0 * sin((z + 900.0) * 0.0033333);
}
`;
