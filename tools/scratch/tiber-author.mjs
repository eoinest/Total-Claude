#!/usr/bin/env node
/**
 * **Author `src/terrain/tiberSurvey.ts` from the digitisation.**
 *
 * Inputs, all produced by the other `tiber-*.mjs` scripts and none of them from the engine:
 *   `tiber-course.json`    the centreline, as the least-cost path through the water on the
 *                          AGEA 2012 orthophoto plus three WMS tiles fetched this pass.
 *   `tiber-ancient.json`   the channel width, off Lanciani's inked channel, binned by northing.
 *   `tiber-island.json`    the Tiber Island, measured as the bar between the two arms.
 *
 * Output is in **survey metres**, east and north of the Temple of Jupiter OM, at a fixed 25 m of
 * course length. `topography.ts` projects it. The point of the split is that the survey table can
 * be regenerated when the projection changes and cannot rot against it, which is what the twelve
 * transcribed world-metre knots did.
 *
 * ## The northern cut, and why there is one
 *
 * The plate-true course is authored from the plate's southern limit north to **z = -300**
 * (survey n 4416, latitude 41.9322). Three measurements set that line, and all three are printed
 * by `tiber-cut.mjs`:
 *
 *  1. **The course stops being a function of z at z = -472.** Everything downstream of
 *     `riverCentreX` assumes x = f(z); the real Tiber doubles back northward through the Pons
 *     Milvius reach, so between z -325 and z -472 there are two channels on one row.
 *  2. **It runs through the attacker's deployment box.** `DEPLOY_GROUND.north` is x -175..855,
 *     z -326..-66, and -255..935 / -406..14 with its feather. **189 course nodes — 0.76 km of
 *     channel — lie inside it.** A river through the Juthungi's start line is not a map, it is a
 *     bug report.
 *  3. **It crosses the Via Flaminia unbridged.** At z -472 the channel centre is at x +5 and
 *     `roadCentreX(-472)` is x -8.5. The map models no bridge there, so the assault would ford
 *     the Tiber 830 world metres north of the Porta Flaminia.
 *
 * All three are consequences of `KZ` = 0.35, not of the river: at that depth scale the map's
 * 2 800 m of z spans 8 000 real metres of the Tiber valley, which contains the Milvian Bridge and
 * two large meanders. `KZ` was settled in Phase 1 and is out of this pass's scope.
 *
 * North of the cut the channel continues on the **measured local bearing at the cut**, eased to
 * due north over 400 world metres of z. That is a fabrication and it is named as one. It was
 * chosen over the two alternatives because it is the only one that does not reverse the sign of
 * the curvature at the join — continuing on the *mean* bearing of the reach below the cut would
 * bend the river west where the real one bends east, which is precisely the fault this pass
 * exists to fix, and it would be invisible in any residual.
 *
 *   node tools/scratch/tiber-author.mjs
 */
import fs from 'node:fs';
import { worldOf, surveyOf, KX, KZ, HALF_EXTENT } from './tiber-plate.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const CUT_Z = Number(arg('cutz', -300));
const EASE_Z = Number(arg('ease', 400));
const STEP_M = Number(arg('step', 25));
const OUT = arg('out', 'src/terrain/tiberSurvey.ts');

// ---------------------------------------------------------------- the plate-true course
const C = JSON.parse(fs.readFileSync('tools/scratch/tiber-course.json', 'utf8'));
let course = C.course.map(([e, n]) => ({ e, n, ...worldOf(e, n) }));
if (course[0].z < course[course.length - 1].z) course.reverse();   // south (high z) first

// clip: keep from the south end (past the map edge, for the LUT tail) up to the cut
const SOUTH_KEEP_Z = HALF_EXTENT + 260;
const kept = [];
for (const p of course) {
  if (p.z > SOUTH_KEEP_Z) continue;
  if (p.z < CUT_Z) break;
  kept.push(p);
}
console.error(`plate-true course kept: ${kept.length} nodes, world z ${kept[0].z.toFixed(0)} .. ${kept[kept.length - 1].z.toFixed(0)}`);

// monotone in z?
let rev = 0, worstRev = 0;
for (let i = 1; i < kept.length; i++) {
  const d = kept[i].z - kept[i - 1].z;
  if (d > 0) { rev++; worstRev = Math.max(worstRev, d); }
}
console.error(`z-monotonicity over the kept reach: ${rev} non-decreasing steps, worst ${worstRev.toFixed(2)} m`
  + (rev === 0 ? '  (strictly monotone)' : '  <-- must be tiny, or x = f(z) is not well defined'));

// ---------------------------------------------------------------- the northern continuation
/**
 * Local bearing at the cut: dx/dz over the 150 world metres of z below it. Then ease the slope
 * to zero over EASE_Z metres with a smoothstep, and run straight north to the map's edge.
 */
const cutPt = kept[kept.length - 1];
const below = kept.find((p) => p.z <= cutPt.z + 150) ?? kept[kept.length - 2];
const slope0 = (cutPt.x - below.x) / (cutPt.z - below.z);
console.error(`cut at world z ${cutPt.z.toFixed(1)} x ${cutPt.x.toFixed(1)} (survey e ${cutPt.e.toFixed(0)} n ${cutPt.n.toFixed(0)}),`
  + ` local dx/dz over the 150 m below = ${slope0.toFixed(3)}`);
const NORTH_EDGE = -(HALF_EXTENT + 120);
const cont = [];
{
  let x = cutPt.x;
  for (let z = cutPt.z - 2; z >= NORTH_EDGE; z -= 2) {
    const t = Math.min(1, (cutPt.z - z) / EASE_Z);
    const s = slope0 * (1 - t * t * (3 - 2 * t));
    x -= s * 2;
    cont.push({ x, z, ...surveyOf(x, z) });
  }
}
console.error(`continuation: ${cont.length} nodes to z ${NORTH_EDGE}, ending at x ${cont[cont.length - 1].x.toFixed(0)}`);

const full = [...kept, ...cont];

// ---------------------------------------------------------------- resample at STEP_M of course
const resample = (poly, step) => {
  const out = [poly[0]]; let carry = 0;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1];
    const L = Math.hypot(b.e - a.e, b.n - a.n);
    if (L < 1e-9) continue;
    let t = step - carry;
    while (t <= L) { out.push({ e: a.e + (b.e - a.e) * (t / L), n: a.n + (b.n - a.n) * (t / L) }); t += step; }
    carry = L - (t - step);
  }
  out.push(poly[poly.length - 1]);
  return out;
};
const smoothP = (poly, win) => poly.map((_, i) => {
  let e = 0, n = 0, k = 0;
  for (let j = -win; j <= win; j++) {
    const q = poly[Math.max(0, Math.min(poly.length - 1, i + j))];
    const w = 1 - Math.abs(j) / (win + 1);
    e += q.e * w; n += q.n * w; k += w;
  }
  return { e: e / k, n: n / k };
});
/**
 * A 3-node triangular smooth at 25 m spacing, i.e. a 75 m window. The path comes off a 3.42 m
 * lattice and carries its staircase; 75 m is a quarter of the tightest real bend radius on this
 * reach (about 300 m), so it removes the lattice and cannot remove a bend.
 */
const line = resample(smoothP(resample(full, STEP_M), 3), STEP_M);
console.error(`authored polyline: ${line.length} nodes at ${STEP_M} m`);
{
  const wz = line.map((p) => worldOf(p.e, p.n).z);
  let bad = 0, worst = 0;
  for (let i = 1; i < wz.length; i++) if (wz[i] >= wz[i - 1]) { bad++; worst = Math.max(worst, wz[i] - wz[i - 1]); }
  console.error(`authored line z-monotonicity: ${bad} non-decreasing steps, worst ${worst.toFixed(3)} world m`);
  // lateral departure of the authored line from the raw plate course, which is the cost of the
  // 75 m smooth and the 25 m resample
  const raw = kept;
  const dist = (q) => {
    let best = Infinity;
    for (let i = 0; i + 1 < raw.length; i++) {
      const a = raw[i], b = raw[i + 1];
      const de = b.e - a.e, dn = b.n - a.n, L2 = de * de + dn * dn || 1;
      let t = ((q.e - a.e) * de + (q.n - a.n) * dn) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(q.e - (a.e + de * t), q.n - (a.n + dn * t));
      if (d < best) best = d;
    }
    return best;
  };
  const ds = line.filter((p) => worldOf(p.e, p.n).z >= CUT_Z + 30).map(dist).sort((a, b) => a - b);
  console.error(`authored line vs the raw plate course: median ${ds[ds.length >> 1].toFixed(2)} m, p99 ${ds[Math.floor(ds.length * 0.99)].toFixed(2)} m, max ${ds[ds.length - 1].toFixed(2)} survey m`);
}

// ---------------------------------------------------------------- the width profile
/**
 * The width comes off Lanciani, binned by northing and smoothed. It is *not* carried station by
 * station: the two independent width measurements — Lanciani's inked channel and the orthophoto's
 * gated water — correlate at **r = 0.037** over 264 paired stations, so neither resolves the width
 * at a station and pretending otherwise would be inventing detail. What they do agree on is the
 * scale and the long trend: 400 m bins hold 8 to 59 samples each and move coherently from 72 m in
 * the Campus Martius bend to 108 m below the Capitol, which is the Ripa's harbour reach and is
 * expected to be wider.
 */
const A = JSON.parse(fs.readFileSync('tools/scratch/tiber-ancient.json', 'utf8')).rows;
const BIN = 400;
const bins = new Map();
for (const r of A) {
  const b = Math.round(r.n / BIN) * BIN;
  if (!bins.has(b)) bins.set(b, []);
  bins.get(b).push(r.width);
}
const binMed = [...bins.entries()]
  .filter(([, v]) => v.length >= 6)
  .map(([n, v]) => ({ n, w: v.slice().sort((a, b) => a - b)[v.length >> 1], k: v.length }))
  .sort((a, b) => a.n - b.n);
console.error('Lanciani width bins (n, median m, samples):');
console.error('  ' + binMed.map((b) => `${b.n}:${b.w.toFixed(0)}(${b.k})`).join(' '));
const CLAMP = [70, 112];
const widthAt = (n) => {
  // Gaussian-weighted mean of the bin medians, sigma 500 m, weighted by sample count.
  let s = 0, w = 0;
  for (const b of binMed) {
    const g = Math.exp(-(((n - b.n) / 300) ** 2)) * Math.sqrt(b.k);
    s += b.w * g; w += g;
  }
  const v = w > 0 ? s / w : 90;
  return Math.min(CLAMP[1], Math.max(CLAMP[0], v));
};

// ---------------------------------------------------------------- island
const IS = JSON.parse(fs.readFileSync('tools/scratch/tiber-island.json', 'utf8'));

// ---------------------------------------------------------------- emit
const rows = line.map((p) => [+p.e.toFixed(1), +p.n.toFixed(1), +widthAt(p.n).toFixed(1)]);
const plateNodes = line.filter((p) => worldOf(p.e, p.n).z >= CUT_Z).length;
const w0 = worldOf(rows[0][0], rows[0][1]);
const wN = worldOf(rows[rows.length - 1][0], rows[rows.length - 1][1]);

const body = `/**
 * **The Tiber, digitised off the plates — the survey, in survey metres.**
 *
 * ${rows.length} stations at ${STEP_M} m of course length, east and north of the Temple of Jupiter
 * Optimus Maximus (41.8925 N, 12.4823 E), each with the channel's width there. \`topography.ts\`
 * projects them through \`worldOf\`; nothing in this file is in world metres, so a change to \`KX\`
 * or \`KZ\` cannot leave it stale. **That is the whole reason it is a separate file**: what it
 * replaces was twelve knots transcribed into world metres inside \`topography.ts\`, and the
 * transcription had to be re-done by hand every time the projection moved.
 *
 * ## What replaced what, and how wrong the old table was
 *
 * The twelve knots were a list of latitudes and longitudes. \`ROME-FABRIC.md\` §7.3 reported the
 * Tiber's "worst survey error" as **0.1 world metres**, and that number was honest and useless:
 * \`probe-rometransect --only=tiber\` compares the transcribed world-metre table against
 * \`worldOf\` of *the same twelve latitudes and longitudes*. It measures the projection's
 * arithmetic. It cannot see whether a latitude and longitude is in the river.
 *
 * Measured this pass against the AGEA 2012 orthophoto, in the plate's own frame
 * (\`tools/scratch/tiber-knotcheck.mjs\`):
 *
 * | knot | lat, lon | on water? | distance to the traced channel |
 * |---|---|---|---|
 * | 1 | 41.9450 12.4600 | land | **1 166 m** (433 world m) |
 * | 2 | 41.9352 12.4670 | land | 63 m |
 * | 3 | 41.9270 12.4700 | land | **605 m** (219 world m) |
 * | 4 | 41.9200 12.4712 | land | 62 m |
 * | 5 | 41.9130 12.4718 | land | 54 m |
 * | 6 | 41.9052 12.4723 | land | 169 m |
 * | 7 | 41.9013 12.4665 | land | 85 m |
 * | 8 | 41.8965 12.4640 | land | 115 m |
 * | 9 | 41.8930 12.4700 | **water** | 5 m |
 * | 10 | 41.8905 12.4778 | land | 80 m |
 * | 11 | 41.8820 12.4760 | land | 152 m |
 * | 12 | 41.8700 12.4720 | off plate | 153 m |
 *
 * **One of the twelve control points stood on the river.** Median distance 115 survey metres,
 * 49 world metres. So the curve did not merely bend the wrong way between the right points; the
 * points were wrong too, and no check the project had could see either fault, because every one
 * of them compared the river against its own control points.
 *
 * ## Where the numbers come from
 *
 * - **Course**: the least-cost path through gated water on the AGEA 2012 orthophoto
 *   (\`tools/scratch/tiber-course.mjs\`). Cost is 1 + 26/(1+t) inside water, t being the distance
 *   to the nearest bank, and 3000 on land, so the path holds mid-channel, crosses a bridge deck
 *   because it must, and does not short-cut a meander's neck. Of 4 476 nodes over 17.9 km, 263
 *   stand on land in 39 runs and the longest land run is 75 m — one bridge deck.
 * - **Cross-checked against Lanciani**, which is a different survey of a different century of the
 *   same river: the midpoint of Lanciani's two inked bank lines sits a **median 2.6 survey metres**
 *   (1.1 world metres) from the orthophoto course over 354 stations. Two independent sources, one
 *   answer.
 * - **Width**: Lanciani's inked channel, binned by northing in 400 m bins and Gaussian-smoothed,
 *   clamped to ${CLAMP[0]}-${CLAMP[1]} m. Median 86 m. The orthophoto's own width measurement is
 *   35 m narrower because the roughness gate erodes the bank and the *muraglioni* shadow the
 *   water, and the two correlate at r = 0.037 station by station — so the width is carried as a
 *   long trend and not as detail neither source can see.
 * - **Coverage**: the repo's plate spans survey n -2436..+2450; three tiles fetched this pass from
 *   the same WMS, layer, CRS and licence as \`ASSETS.md\` item 8 carry it to n +8180.
 *
 * ## The northern cut — the one fabrication, named
 *
 * Plate-true from the south edge to **world z ${CUT_Z}** (survey n ${cutPt.n.toFixed(0)}, latitude
 * ${(41.8925 + cutPt.n / 111320).toFixed(4)}) — the first ${plateNodes} of ${rows.length} rows.
 * North of that the channel continues on the measured local bearing at the cut,
 * **dx/dz = ${slope0.toFixed(3)}**, eased to due north over ${EASE_Z} world metres of z, reaching
 * x ${cont[cont.length - 1].x.toFixed(0)} at the map's north edge.
 *
 * **The plate says something else and it cannot be shipped.** North of the cut the real Tiber
 * turns east through the Pons Milvius reach: it stops being a function of z at z -472, it puts
 * 0.76 km of channel inside the attacker's deployment box (x -175..855, z -326..-66 plus an 80 m
 * feather), and it crosses the Via Flaminia at z -472 where the map models no bridge. All three
 * follow from \`KZ\` = 0.35 — at that depth scale the map's 2 800 m of z spans 8 000 real metres of
 * the Tiber valley — and \`KZ\` was settled in Phase 1.
 *
 * The easing was chosen so that the curvature does not change sign at the join. Continuing on the
 * *mean* bearing of the reach below the cut reads better as a number and bends the river west
 * where the real one bends east, and no residual would show it. That is the fault this whole pass
 * was called to fix, one level up.
 *
 * Regenerate with \`node tools/scratch/tiber-author.mjs\`.
 */

/** \`[e, n, channelWidth]\` per station, ${STEP_M} m apart along the course, north to south. */
export const TIBER_SURVEY: readonly (readonly [number, number, number])[] = [
${rows.map((r) => `  [${r[0]}, ${r[1]}, ${r[2]}],`).join('\n')}
];

/**
 * How many leading rows are plate-true. The rest are the continuation described above, and
 * \`assertTiber\` prints the split so it cannot quietly grow.
 */
export const TIBER_PLATE_ROWS = ${rows.length - plateNodes === 0 ? rows.length : plateNodes};

/**
 * **The Tiber Island.** Position, size and bearing from \`city/rome/survey.ts\`'s cited row, which
 * this pass checked against the plate rather than trusting:
 *
 * - measured length **${IS.surveyLengthM.toFixed(0)} m** against the published 270;
 * - measured width **${IS.surveyWidthMedianM.toFixed(0)} m**, which is ${(IS.surveyWidthMedianM - 67).toFixed(0)} m
 *   wider than the published 67 and agrees with it once the 35 m the gate erodes off a channel
 *   is taken off — the same 35 m the main channel's two width measurements differ by;
 * - measured centre ${IS.latlon[0]}, ${IS.latlon[1]}, which is 108 m west of the survey row's
 *   41.89080, 12.47790. The run of "bar" stations that produced it runs onto the shoal above the
 *   island's prow, which is why the *published* centre is used and the measurement is the check.
 *
 * The island is drawn as a bar standing out of the channel, so that the Insula Tiberina stands on
 * ground rather than in water.
 */
export const TIBER_ISLAND = {
  /** Survey metres east and north of the Capitol. \`city/rome/survey.ts\`, cited. */
  e: -365,
  n: -189,
  /** Real plan, metres. */
  lengthM: 270,
  widthM: 67,
  /** Bearing of the long axis, degrees east of north, in the *survey* frame. */
  bearingDeg: 121,
  /** Height of the island's crown above \`WATER_LEVEL\`, metres. Travertine, and it never floods. */
  riseM: 6.5,
} as const;
`;

fs.writeFileSync(OUT, body);
console.error(`wrote ${OUT}: ${rows.length} rows, ${plateNodes} plate-true`);
console.error(`world z ${w0.z.toFixed(0)} (south) .. ${wN.z.toFixed(0)} (north)`);
const ws = rows.map((r) => r[2]).sort((a, b) => a - b);
console.error(`authored width: min ${ws[0].toFixed(1)} median ${ws[ws.length >> 1].toFixed(1)} max ${ws[ws.length - 1].toFixed(1)} m`);
