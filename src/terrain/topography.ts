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
 * The Tiber's course, as the survey gives it — `docs/ROME.md` §3.2 and §15 task 1.
 *
 * Twelve points from above the Pons Milvius to below the Aventine, in world metres,
 * projected from latitude and longitude through the affine map in `city/rome/survey.ts`.
 * They are stored already projected because the dependency only runs one way: `survey.ts`
 * solves `GATE_X` as the fixed point of `roadCentreX(crestZAt(x))` and derives the
 * projection's origin from it, so `survey.ts` imports this file and this file cannot import
 * `survey.ts`. **`tools/scratch/probe-rometransect.mjs --only=tiber` is what stops that
 * transcription rotting**: it starts from the latitude and longitude, runs them through
 * `worldOf` in the running page, and fails if this table has drifted.
 *
 *     41.9450 12.4600   41.9352 12.4670   41.9270 12.4700   41.9200 12.4712
 *     41.9130 12.4718   41.9052 12.4723   41.9013 12.4665   41.8965 12.4640
 *     41.8930 12.4700   41.8905 12.4778   41.8820 12.4760   41.8700 12.4720
 *
 * **What this replaces, and how wrong it was.** The channel was
 * `-760 + 130 sin(0.0023256 z) + 50 sin(0.0060606 z + 1.3)` — an almost-straight
 * north-south trench oscillating between x -620 and x -690 that fitted nothing. Measured
 * against these same twelve points at `66b220b` it was **250 to 776 world metres too far
 * west at every one of them**, and the six hundred and ninety metres between the modelled
 * bank and the real one are the invented ground the Aurelian curtain was standing on
 * (§3.2, §4.1). `rome.ts` already half-knew: `FAR_BANK` exists *because* "the terrain's
 * Tiber is a fixed two-term meander that does not agree with a scaled real one".
 *
 * **It is not a sinusoid and must not be forced into one.** Two of these segments run at
 * 66 and 78 degrees to the z axis — the Pons Aelius bend and the great bend past the
 * Campus Martius to the Tiber Island — which no sum of sines in z can hold. §3.2 asks for
 * a spline through the points, sampled into a lookup, and says it is cheaper than three
 * sine terms as well as being the honest shape.
 */
export const TIBER_PATH: readonly number[] = [
  -526.37, -311.51,
  -269.43, -69.73,
  -159.31, 132.58,
  -115.26, 305.27,
  -93.24, 477.97,
  -74.89, 670.41,
  -287.78, 766.63,
  -379.54, 885.05,
  -159.31, 971.40,
  127.00, 1033.08,
  60.93, 1242.78,
  -85.90, 1538.84,
];

/**
 * Mean bearing of the whole surveyed course, dx/dz, and the bearing the channel runs out
 * on past either end of the survey.
 *
 * The last surveyed segment at the north end runs at **1.063**, which is the Tor di Quinto
 * meander seen through a projection that compresses north-south twice as hard as
 * east-west. Extended at that bearing the Tiber leaves the *west* edge of the map at
 * z -1216 and the north-west quarter of the battlefield is dry, which is both wrong and
 * ugly; the ford at `FORD_Z = -520` would sit at x -747 with nothing north of it. Past the
 * last surveyed point the course is not surveyed, so it runs out on the mean bearing of
 * everything that is — 440 m of x over 1,851 m of z — eased in over `TIBER_RUNOUT_BLEND`
 * so there is no kink at the join.
 */
const TIBER_MEAN_SLOPE = 0.238;
const TIBER_RUNOUT_BLEND = 150;

/**
 * The sampled lookup, and why the spline is evaluated once rather than per call.
 *
 * `riverCentreX` is asked for a value about four million times during a terrain build and
 * once per pixel of ground shader; a twelve-knot search plus a cubic is more than either
 * wants, and the shader mirror in `TOPO_GLSL` needs a table anyway. 4 m is a quarter of
 * the heightfield's own 1.37 m sample in the direction the channel is straightest and is
 * finer than the 15 m cut bank the profile draws.
 */
const RIVER_LUT_STEP = 4;
const RIVER_LUT_Z0 = -HALF_EXTENT - 200;
const RIVER_LUT_N = Math.round((2 * HALF_EXTENT + 400) / RIVER_LUT_STEP) + 1;

/**
 * Cubic Hermite through the survey, with Catmull-Rom tangents limited to the local secants.
 *
 * Plain Catmull-Rom overshoots where the bearing reverses, and this course reverses twice
 * inside 300 m of z — at the Pons Aelius bend the tangent flips from +0.095 to -2.213 — so
 * an unlimited spline puts the channel a hundred metres outside the survey between two
 * points that bracket it. The Fritsch-Carlson limiter is the standard cure: zero the
 * tangent at a reversal, and otherwise cap it at three times the smaller neighbouring
 * secant. The result passes through all twelve points and stays inside their hull.
 */
function buildRiverLut(): { x: Float64Array; s: Float64Array } {
  const n = TIBER_PATH.length / 2;
  const kx = new Float64Array(n);
  const kz = new Float64Array(n);
  for (let i = 0; i < n; i++) { kx[i] = TIBER_PATH[i * 2]; kz[i] = TIBER_PATH[i * 2 + 1]; }
  const sec = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) sec[i] = (kx[i + 1] - kx[i]) / (kz[i + 1] - kz[i]);
  const m = new Float64Array(n);
  m[0] = sec[0];
  m[n - 1] = sec[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (sec[i - 1] * sec[i] <= 0) { m[i] = 0; continue; }
    const t = (kx[i + 1] - kx[i - 1]) / (kz[i + 1] - kz[i - 1]);
    const cap = 3 * Math.min(Math.abs(sec[i - 1]), Math.abs(sec[i]));
    m[i] = Math.sign(t) * Math.min(Math.abs(t), cap);
  }

  const x = new Float64Array(RIVER_LUT_N);
  const s = new Float64Array(RIVER_LUT_N);
  let seg = 0;
  for (let k = 0; k < RIVER_LUT_N; k++) {
    const z = RIVER_LUT_Z0 + k * RIVER_LUT_STEP;
    if (z <= kz[0]) {
      // Run-out north: integrate the eased bearing back from the first survey point.
      let px = kx[0];
      let slope = m[0];
      for (let w = kz[0]; w > z; w -= 1) {
        const e = Math.min(1, (kz[0] - w) / TIBER_RUNOUT_BLEND);
        slope = m[0] + (TIBER_MEAN_SLOPE - m[0]) * (e * e * (3 - 2 * e));
        px -= slope * Math.min(1, w - z);
      }
      x[k] = px;
      s[k] = slope;
      continue;
    }
    if (z >= kz[n - 1]) {
      let px = kx[n - 1];
      let slope = m[n - 1];
      for (let w = kz[n - 1]; w < z; w += 1) {
        const e = Math.min(1, (w - kz[n - 1]) / TIBER_RUNOUT_BLEND);
        slope = m[n - 1] + (TIBER_MEAN_SLOPE - m[n - 1]) * (e * e * (3 - 2 * e));
        px += slope * Math.min(1, z - w);
      }
      x[k] = px;
      s[k] = slope;
      continue;
    }
    while (seg < n - 2 && kz[seg + 1] < z) seg++;
    const h = kz[seg + 1] - kz[seg];
    const t = (z - kz[seg]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    x[k] = (2 * t3 - 3 * t2 + 1) * kx[seg] + (t3 - 2 * t2 + t) * h * m[seg]
      + (-2 * t3 + 3 * t2) * kx[seg + 1] + (t3 - t2) * h * m[seg + 1];
    s[k] = ((6 * t2 - 6 * t) * kx[seg] + (3 * t2 - 4 * t + 1) * h * m[seg]
      + (-6 * t2 + 6 * t) * kx[seg + 1] + (3 * t2 - 2 * t) * h * m[seg + 1]) / h;
  }
  return { x, s };
}

const RIVER_LUT = buildRiverLut();

const sampleRiver = (table: Float64Array, z: number): number => {
  const f = (z - RIVER_LUT_Z0) / RIVER_LUT_STEP;
  const i = f <= 0 ? 0 : f >= RIVER_LUT_N - 1 ? RIVER_LUT_N - 2 : Math.floor(f);
  const t = f - i < 0 ? 0 : f - i > 1 ? 1 : f - i;
  return table[i] + (table[i + 1] - table[i]) * t;
};

/** Centreline of the Tiber as a function of z, off the survey. §3.2. */
export const riverCentreX = (z: number): number => sampleRiver(RIVER_LUT.x, z);

/**
 * Local channel bearing as dx/dz, used to decide which bank is the cut bank and to turn a
 * horizontal offset into a perpendicular one. Kept under its old name because
 * `riverProfile` reads it for exactly the same purpose it always did.
 */
export const riverCurvature = (z: number): number => sampleRiver(RIVER_LUT.s, z);

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
 * Depth scale. The heightfield ends at z = 1400 and the wall crest reaches z = 583, so
 * there are about 940 m of city depth for Rome's 3,545 m from the Porta Flaminia to the
 * Baths of Caracalla. 0.222 is the largest value that fits Caracalla inside the map with
 * its precinct clear of the edge.
 */
export const KZ = 0.222;

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
 * Centre of both deployment grounds in x, and how far they reach either side of it.
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

/** Soft edge on every deployment box, in metres. */
const DEPLOY_FEATHER = 80;

/**
 * Where the armies form up. Terrain inside these boxes is flattened onto the regional
 * plane so that a 40-man-wide cohort cannot be broken in half by a hillock, they carry
 * the trampled-ground channel of the control texture, and vegetation is excluded from
 * them so no tree stands inside a formation.
 *
 * Half-widths were 490 m, sized against a Roman line of eight cohorts on 70 m centres with
 * urban cohorts refusing both flanks at ±320 m and the cavalry wings out at ±450. §3.2
 * takes the attacker's to 380; the defender's is 250 because it stands where the funnel has
 * already closed. See `DEPLOY_AXIS_X`.
 *
 * **This is now data, and the masks are derived from it**, because `sim/scenario.ts` reads it
 * too — see `maps/types.ts`'s `DeployGround`. The paragraph above about the field order of
 * battle knowing nothing about these boxes was true when it was written and is not any more.
 *
 * **The line is wider than the ground, and that is a real finding rather than a rounding.**
 * At `DEFAULT_CONFIG` and the `high` tier the Roman line measures **684 m** across its own
 * men and the box is **500 m**; the Juthungi host measures 783 m against 760 m. Rome's box was
 * narrowed to ±250 to clear the funnel, and nothing checked it against the army that has to
 * stand in it. Whoever sizes §15 task 14 has to choose between a narrower Roman frontage and a
 * box that reaches further east — the east is open plain out to x 700 and dry — and it is a
 * change to the shipped battle either way. Until then the line overhangs its ground to the
 * east, which is grass, rather than to the west, which is the Tiber.
 */
export const DEPLOY_GROUND = {
  axisX: DEPLOY_AXIS_X,
  north: { cx: DEPLOY_AXIS_X, cz: -196, hx: 380, hz: 130 },
  south: { cx: DEPLOY_AXIS_X, cz: 150, hx: 250, hz: 120 },
} as const satisfies DeployGround;

export const germanDeployMask = (x: number, z: number): number =>
  rectMask(x, z, DEPLOY_GROUND.north.cx, DEPLOY_GROUND.north.cz,
    DEPLOY_GROUND.north.hx, DEPLOY_GROUND.north.hz, DEPLOY_FEATHER);
export const romanDeployMask = (x: number, z: number): number =>
  rectMask(x, z, DEPLOY_GROUND.south.cx, DEPLOY_GROUND.south.cz,
    DEPLOY_GROUND.south.hx, DEPLOY_GROUND.south.hz, DEPLOY_FEATHER);

/** The whole fighting corridor. High-frequency relief is damped here, swells are kept. */
export const battleCoreMask = (x: number, z: number): number =>
  rectMask(x, z, 0, -30, 540, 360, 170);

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
 * `riverProfile` and `riverInfluence` both take a *cross-channel* distance, and every
 * caller has one thing to hand: `x - riverCentreX(z)`, measured along a row of the
 * heightfield. Those are the same number only where the channel runs due north-south. The
 * old two-sine meander never exceeded 31 degrees off the z axis so the difference was under
 * a sixth and nobody noticed; the surveyed course runs at **78 degrees** through the great
 * bend past the Campus Martius, where an unscaled offset draws the Tiber **twenty metres
 * wide** instead of ninety-four — a ninety-four metre river crossed at 78 degrees really
 * does occupy 447 m of a constant-z row, and the Insula Tiberina, which `layout.ts` places
 * *on* the centreline at 270 m long, would have stuck out of both banks.
 *
 * For a locally straight reach this is exact: the perpendicular distance from a point to
 * the line `x = c + s·z` is `|x - c(z)| / hypot(1, s)`.
 */
export const riverPerpScale = (z: number): number => 1 / Math.hypot(1, riverCurvature(z));

/** Signed cross-channel offset from the Tiber centreline, in metres (negative = west). */
export const riverOffset = (x: number, z: number): number =>
  (x - riverCentreX(z)) * riverPerpScale(z);

/**
 * The channel's banks in *x* at a given z — what a caller working along a row needs.
 *
 * Not `riverCentreX(z) ± RIVER_HALF_WIDTH`: that is the half-width measured across the
 * channel, and a row of constant z cuts a slanted channel obliquely. `EAST_BANK`,
 * `FAR_BANK` and the wall's west anchor all ask this question and all three used to answer
 * it with the perpendicular half-width, which on the surveyed course is out by up to 4.7x.
 */
export const riverBankX = (z: number, side: number): number =>
  riverCentreX(z) + (side * RIVER_HALF_WIDTH) / riverPerpScale(z);

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
