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
 * **The Aurelian circuit's line, and the only definition of it.** §14.5, §15 task 2.
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
 * So the wall's line now has its own name, and the heightfield's bench (`buildTerrain`
 * stage 4d), `city/rome/circuit.ts`'s `wallCrestZ` and `fitWallPath`, `ScatterField`'s
 * glacis clearance and `campusMartius.ts`'s scatter exclusion all read this one function.
 *
 * **Its body is still the terrain's crest, and that is deliberate.** §15 task 3 authors the
 * circuit from the fourteen surveyed waypoints of §2.5 and lays 36 bays at a 37.03 m pitch
 * from x +2; doing that here would collide with it. What this pass buys task 3 is that the
 * change is one function body: move the line and the bench, the masonry, the glacis and the
 * keep-out all move with it, instead of task 3 having to find them. The measured gap it
 * will close is large — the surveyed circuit rises smoothly from z 538 at the Tiber to
 * z 633 at the Castra's north-east angle, while this wanders between z 437 and z 561, up to
 * **157 m** apart at x +868.
 */
export const romeWallZ = (x: number): number =>
  crestZAt(x < -HALF_EXTENT ? -HALF_EXTENT : x > HALF_EXTENT ? HALF_EXTENT : x);

/**
 * Height of the crest of the city rise at a given x — the terrain's own brow.
 *
 * **No longer the wall's line**; that is `romeWallZ`. This is what the name says, and what
 * the projection needs: `survey.ts` solves the Porta Flaminia as the fixed point of
 * `roadCentreX(crestZAt(x))`, because the gate has to be where the Via Flaminia crosses the
 * brow, and the whole affine map's origin is derived from the answer. Anything that wants
 * to know where the *wall* is must ask `romeWallZ`.
 */
export const crestZAt = (x: number): number => riseToeZ(x) + RISE_RUN;

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
 * **What this does not do, and it is the loudest finding of this pass.** These masks flatten
 * ground, exclude vegetation and paint the trodden channel of the control texture. They do
 * **not** place anybody: `sim/scenario.ts`'s field deployment lays both lines out at fixed x
 * about zero — `centred(n, 64)`, `flanking(n, lineHalf + 50, 52)` — and knows nothing about
 * them. So §3.2's own remedy names the wrong mechanism, and moving these boxes leaves the
 * shipped field order of battle exactly where it was: with the Tiber on the survey, the
 * Roman left wing and both urban cohorts stand on the *far* bank and the westernmost line
 * cohort straddles the channel. That is §15 task 8's to size, it is a change to the shipped
 * battle rather than to the ground, and it is measured and reported rather than made here.
 */
export const DEPLOY_AXIS_X = 205;

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
 */
export const germanDeployMask = (x: number, z: number): number =>
  rectMask(x, z, DEPLOY_AXIS_X, -196, 380, 130, 80);
export const romanDeployMask = (x: number, z: number): number =>
  rectMask(x, z, DEPLOY_AXIS_X, 150, 250, 120, 80);

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
const WALL_RIVER_CLEAR = 12;

export const WALL_X_MIN = (() => {
  let x = 0;
  for (let i = 0; i < 6; i++) x = riverBankX(romeWallZ(x), 1) + WALL_RIVER_CLEAR;
  return Math.round(x);
})();

/**
 * East end: the Castra Praetoria. Aurelian took the camp's own north and east walls into the
 * circuit, so the curtain does not stop in open country — it runs into the Praetorian
 * barracks. §4.1 records that x 1150 is the camp's *north-west* angle and that the circuit
 * therefore ends exactly where the incorporated fort begins; §15 task 3 carries it on to the
 * north-east angle at x +1335. Unchanged here.
 */
export const WALL_X_MAX = 1150;

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
