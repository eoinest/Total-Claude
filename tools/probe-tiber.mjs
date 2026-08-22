#!/usr/bin/env node
/**
 * **Is the Tiber the right shape?** — and not "does it pass through its own control points".
 *
 * ## Why this exists
 *
 * `ROME-FABRIC.md` §7.3 reported the Tiber's worst survey error as **0.1 world metres**, and the
 * owner then looked at the map and said the river was bending the wrong way. Both were true.
 * `probe-rometransect --only=tiber` compares the engine's transcribed knot table against
 * `worldOf` of the *same twelve latitudes and longitudes*: it measures the projection's
 * arithmetic and cannot see whether a latitude and longitude is in the river, nor what the curve
 * does between two of them. **A curve can pass through the right control points and still bend
 * the wrong way, and a residual against those points cannot tell you.**
 *
 * So this probe never compares the river against anything the engine produced. It has two
 * external rulers and reports against both:
 *
 *  - **`BRIDGES`** — sixteen modern bridge midpoints in WGS84. A bridge midpoint is on the
 *    channel centreline by construction, so this control needs no ink-reading judgement at all.
 *    Transcribed independently of, and agreeing with, `tools/judge/control.mjs` on
 *    `e/judge/rome-plan`; two transcriptions of the same fact agreeing costs nothing and
 *    disagreeing would be a finding.
 *  - **`tools/scratch/tiber-course.json`** — 4 476 nodes traced as the least-cost path through
 *    gated water on the AGEA 2012 orthophoto, cross-checked against Lanciani's inked channel to
 *    a median 2.6 survey metres. Denser, and the source the engine's survey was authored from,
 *    so it grades the *authoring* rather than the digitising.
 *
 * ## What it measures
 *
 *  1. **Lateral departure** of the engine's channel from each ruler, at 25 m of northing:
 *     median and worst, in survey (real) metres and in world metres.
 *  2. **Swing**, and the swing ratio. Over a stated band of northing, how far east and west does
 *     the channel move? A river bending 21 % as far as the real one has a small mean error and
 *     is the wrong shape, which is exactly the failure mode this file exists for.
 *  3. **The sign of curvature**, station by station. An inverted bend can have a small mean
 *     error; it cannot have the right sign.
 *  4. **The drawn channel's width across a row**, against the width it declares. The old model
 *     was `x = f(z)` plus a row-wise scale, and at 75.9 degrees off the z axis it drew the Tiber
 *     385 world metres wide in x where it declared 94.
 *  5. **Everything standing in water** — monuments and insulae together, tested against the
 *     *drawn* channel and against the ground the terrain actually returns, never against the
 *     bare `RIVER_HALF_WIDTH`. The judge's first in-water test used the bare constant and
 *     undercounted by 76 %.
 *
 *   node tools/probe-tiber.mjs --port=5931
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5931);
const MAP = args.get('map') ?? 'campus-martius';
const SCENARIO = args.get('scenario') ?? 'assault';
const JSON_OUT = args.get('json') ?? '';

/**
 * Sixteen bridge midpoints, WGS84. A bridge midpoint lies on the channel centreline whatever the
 * bank has done since, and the nineteenth-century embankments narrowed the Tiber roughly
 * symmetrically, so this is the ancient centreline to within a few tens of metres — an order of
 * magnitude under the departures being measured.
 */
const BRIDGES = [
  ['Ponte Milvio', 41.9351, 12.4667], ['Ponte Duca d Aosta', 41.9296, 12.4691],
  ['Ponte Risorgimento', 41.9203, 12.4707], ['Ponte Matteotti', 41.9146, 12.4726],
  ['Ponte Regina Margherita', 41.9109, 12.4741], ['Ponte Cavour', 41.9060, 12.4741],
  ['Ponte Umberto I', 41.9020, 12.4715], ['Ponte Sant Angelo', 41.9017, 12.4665],
  ['Ponte Vittorio Emanuele II', 41.8977, 12.4650], ['Ponte Mazzini', 41.8945, 12.4663],
  ['Ponte Sisto', 41.8930, 12.4700], ['Ponte Garibaldi', 41.8918, 12.4749],
  ['Ponte Fabricio', 41.8917, 12.4779], ['Ponte Palatino', 41.8894, 12.4788],
  ['Ponte Sublicio', 41.8829, 12.4757], ['Ponte Testaccio', 41.8748, 12.4713],
];
const LAT0 = 41.8925;
const LON0 = 12.4823;
const MLAT = 111320;
const MLON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const bridgeEN = BRIDGES.map(([id, la, lo]) => ({ id, e: (lo - LON0) * MLON, n: (la - LAT0) * MLAT }));

/** The dense plate trace, if it is present. Gitignored inputs are optional by design. */
let traceEN = null;
try {
  traceEN = JSON.parse(fs.readFileSync('tools/scratch/tiber-course.json', 'utf8')).course
    .map(([e, n]) => ({ e, n }));
} catch { /* the digitisation is a scratch artefact; the bridges alone still grade the shape */ }

/** x of a polyline at a given northing, by linear interpolation between the bracketing nodes. */
const eAtN = (poly, n) => {
  let best = null;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1];
    if ((a.n - n) * (b.n - n) > 0) continue;
    const t = (n - a.n) / ((b.n - a.n) || 1);
    const e = a.e + (b.e - a.e) * t;
    // Where the course doubles back there can be several crossings; keep the last, which walking
    // downstream is the one the map's single-valued channel corresponds to.
    best = e;
  }
  return best;
};

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(
  `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=high&scenario=${SCENARIO}&battle=${token}`,
  { waitUntil: 'domcontentloaded', timeout: 120000 }
);
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 240000 });

const out = await page.evaluate(async ({ bridgeEN, traceEN }) => {
  const topo = await import('/src/terrain/topography.ts');
  const g = window.__game;
  const terrain = g.engine.ctx.get('terrain');
  const { KX, KZ, worldOf, HALF_EXTENT, WATER_LEVEL, RIVER_HALF_WIDTH } = topo;
  const surveyOf = (x, z) => {
    const o = worldOf(0, 0);
    return { e: (x - o.x) / KX, n: (o.z - z) / KZ };
  };

  // ---------------------------------------------------------------- 1. departure and swing
  const sampleBand = (poly, nLo, nHi, step) => {
    const rows = [];
    for (let n = nLo; n <= nHi; n += step) {
      const ref = poly ? eAtN(poly, n) : null;
      if (ref === null || ref === undefined) continue;
      const z = worldOf(0, n).z;
      const x = topo.riverCentreX(z);
      const eng = surveyOf(x, z).e;
      rows.push({ n, ref, eng, dE: eng - ref });
    }
    return rows;
  };
  const eAtN = (poly, n) => {
    let best = null;
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i], b = poly[i + 1];
      if ((a.n - n) * (b.n - n) > 0) continue;
      best = a.e + (b.e - a.e) * ((n - a.n) / ((b.n - a.n) || 1));
    }
    return best;
  };
  const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN);
  const stats = (rows) => {
    const a = rows.map((r) => Math.abs(r.dE)).sort((x, y) => x - y);
    return {
      n: rows.length,
      medianM: +q(a, 0.5).toFixed(1),
      p90M: +q(a, 0.9).toFixed(1),
      maxM: +(a[a.length - 1] ?? NaN).toFixed(1),
      medianWorldM: +(q(a, 0.5) * KX).toFixed(1),
      maxWorldM: +((a[a.length - 1] ?? NaN) * KX).toFixed(1),
    };
  };
  const swing = (rows, key) => {
    let lo = Infinity, hi = -Infinity;
    for (const r of rows) { lo = Math.min(lo, r[key]); hi = Math.max(hi, r[key]); }
    return hi - lo;
  };

  /** The band of northing beside the assaulted front, and the whole reach inside the map. */
  const BANDS = {
    front: [1200, 2042],
    city: [-400, 2042],
    map: [-440, 4400],
  };
  const departure = {};
  for (const [name, [a, b]] of Object.entries(BANDS)) {
    const rt = traceEN ? sampleBand(traceEN, a, b, 25) : [];
    departure[name] = {
      band: [a, b],
      vsTrace: rt.length ? { ...stats(rt), swingPlateM: +swing(rt, 'ref').toFixed(1), swingEngineM: +swing(rt, 'eng').toFixed(1), swingRatio: +(swing(rt, 'eng') / (swing(rt, 'ref') || 1)).toFixed(3) } : null,
    };
  }

  /**
   * **The bridges are a point control, not a shape control, and must be used as one.**
   *
   * Interpolating sixteen bridges by northing and comparing row by row measures the engine
   * against the *chords* between them, and over the 842 m band beside the assaulted front there
   * are only two bridges in the list — so the "plate" it compares to is a straight line across
   * the very bend being graded. That reported a 75 m median departure and a 1.435 swing ratio on
   * a channel that is within 2.4 m of the dense trace. **A sparse control interpolated into a
   * shape is the same fault as a spline through twelve knots, one level up**, and it is worth
   * naming because it nearly became this probe's headline number.
   *
   * Used properly, a bridge midpoint is an exact point on the centreline. So: the perpendicular
   * distance from each bridge to the engine's channel *as a curve*.
   */
  const engineCurve = [];
  for (let n = -600; n <= 4600; n += 10) {
    const z = worldOf(0, n).z;
    engineCurve.push({ e: surveyOf(topo.riverCentreX(z), z).e, n });
  }
  const pointToCurve = (p, poly) => {
    let best = Infinity;
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i], b = poly[i + 1];
      const de = b.e - a.e, dn = b.n - a.n, L2 = de * de + dn * dn || 1;
      let t = ((p.e - a.e) * de + (p.n - a.n) * dn) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(p.e - (a.e + de * t), p.n - (a.n + dn * t));
      if (d < best) best = d;
    }
    return best;
  };
  const bridges = bridgeEN.map((b) => ({
    id: b.id, n: +b.n.toFixed(0),
    onMap: b.n >= -440 && b.n <= 4400,
    dM: +pointToCurve(b, engineCurve).toFixed(1),
    dTraceM: traceEN ? +pointToCurve(b, traceEN).toFixed(1) : null,
  }));

  // ---------------------------------------------------------------- 2. sign of curvature
  /**
   * The second difference of e against n, on both curves, at the same stations. An inverted bend
   * has a small mean error and the wrong sign, which is the whole point of testing this.
   * Stations whose curvature is under `FLAT` on either curve are counted separately rather than
   * scored: the sign of a straight reach is noise.
   */
  const curvature = (poly, band, step) => {
    const rows = sampleBand(poly, band[0], band[1], step);
    const out = [];
    for (let i = 1; i + 1 < rows.length; i++) {
      out.push({
        n: rows[i].n,
        kRef: (rows[i - 1].ref - 2 * rows[i].ref + rows[i + 1].ref) / (step * step),
        kEng: (rows[i - 1].eng - 2 * rows[i].eng + rows[i + 1].eng) / (step * step),
      });
    }
    return out;
  };
  const FLAT = 1e-4;   // 1 m of sagitta over a 100 m chord
  const signTest = (poly, band) => {
    const c = curvature(poly, band, 100);
    let agree = 0, disagree = 0, flat = 0;
    const inverted = [];
    for (const r of c) {
      if (Math.abs(r.kRef) < FLAT || Math.abs(r.kEng) < FLAT) { flat++; continue; }
      if (Math.sign(r.kRef) === Math.sign(r.kEng)) agree++;
      else { disagree++; inverted.push(+r.n.toFixed(0)); }
    }
    return { stations: c.length, agree, disagree, flat, invertedAtN: inverted };
  };
  // Curvature is a *shape* question, so it is graded against the dense trace only. The sixteen
  // bridges cannot answer it: their chords have no curvature of their own to compare against.
  const sign = traceEN ? {
    front: signTest(traceEN, BANDS.front),
    city: signTest(traceEN, BANDS.city),
    map: signTest(traceEN, BANDS.map),
  } : {};

  // ---------------------------------------------------------------- 3. the drawn channel
  /**
   * How wide is the water the map actually draws, measured across a row? The declared width is
   * `2 * riverHalfWidthAt(z)` perpendicular; the drawn width across a row is legitimately wider
   * where the channel runs oblique, by `1 / cos(angle)`. What is *not* legitimate is the drawn
   * width exceeding that.
   */
  const widthRows = [];
  for (let z = -1380; z <= 1380; z += 20) {
    const cx = topo.riverCentreX(z);
    // The CONTIGUOUS wet run containing the centre. Taking the min and max wet x across the row
    // instead reported 638 m of "channel" on a reach running 3 degrees off the z axis, because
    // it was picking up disconnected low ground — the flood terrace and the Petronia's marsh —
    // hundreds of metres away. That is a real thing to know about and it is not the channel.
    let lo = null, hi = null;
    if (terrain.heightAt(cx, z) <= WATER_LEVEL) {
      lo = cx; hi = cx;
      for (let x = cx; x >= cx - 700; x -= 2) { if (terrain.heightAt(x, z) > WATER_LEVEL) break; lo = x; }
      for (let x = cx; x <= cx + 700; x += 2) { if (terrain.heightAt(x, z) > WATER_LEVEL) break; hi = x; }
    }
    const perp = topo.riverPerpScale(z);
    widthRows.push({
      z,
      wetSpanM: lo === null ? 0 : +(hi - lo).toFixed(1),
      declaredPerpM: +(2 * topo.riverHalfWidthAt(z)).toFixed(1),
      // The ford widens the channel by design: `riverProfile` takes the half-width up by 85 %
      // over the shoal, so the expectation has to know about it or the ford reads as a fault.
      expectedRowM: +((2 * topo.riverHalfWidthAt(z) * (1 + topo.fordFactor(z) * 0.85)) / perp).toFixed(1),
      angleDeg: +((Math.atan2(Math.abs(topo.riverCurvature(z)), 1) * 180) / Math.PI).toFixed(1),
    });
  }
  const excess = widthRows
    .filter((r) => r.wetSpanM > 0)
    .map((r) => ({ ...r, ratio: +(r.wetSpanM / (r.expectedRowM || 1)).toFixed(2) }))
    .sort((a, b) => b.ratio - a.ratio);

  // ------------------------------------------------------- 3a. the channel's width in REAL metres
  /**
   * The number the plate can be compared with. Walk the *real* perpendicular at a station,
   * project each sample, ask the terrain, and report where the water stops — in survey metres.
   * Measuring the wet span across a world-space row and calling it metres is what let a
   * 94-world-metre channel be reported as agreeing with a 100.8 real-metre plate reading while
   * actually covering 292.6 real metres of it.
   */
  const realWidths = [];
  for (let n = -400; n <= 2400; n += 40) {
    const ref = traceEN ? eAtN(traceEN, n) : null;
    if (ref === null || ref === undefined) continue;
    const before = traceEN ? eAtN(traceEN, n - 60) : ref;
    const after = traceEN ? eAtN(traceEN, n + 60) : ref;
    if (before === null || after === null) continue;
    const te = (after - before) / (Math.hypot(after - before, 120) || 1);
    const tn = 120 / (Math.hypot(after - before, 120) || 1);
    const pe = -tn, pn = te;
    const wetAt = (r) => {
      const w = worldOf(ref + pe * r, n + pn * r);
      return terrain.heightAt(w.x, w.z) <= WATER_LEVEL;
    };
    if (!wetAt(0)) continue;
    let lo = 0, hi = 0;
    for (let r = 0; r >= -400; r -= 2) { if (!wetAt(r)) break; lo = r; }
    for (let r = 0; r <= 400; r += 2) { if (!wetAt(r)) break; hi = r; }
    realWidths.push({ n, realWidthM: +(hi - lo).toFixed(1) });
  }
  const rw = realWidths.map((r) => r.realWidthM).sort((a, b) => a - b);

  // ---------------------------------------------------------------- 3b. the wall's west end
  /**
   * The Aurelian circuit's west end was solved from the *old* river:
   * `WALL_X_MIN = riverBankX(romeWallZ(x), +1) + 12`. The river has moved, so this reports the
   * new clearance rather than adjusting either. The circuit is another agent's ground.
   */
  let wallWest = null;
  {
    const xMin = topo.WALL_X_MIN ?? null;
    if (xMin !== null) {
      const zw = topo.romeWallZ(xMin);
      wallWest = {
        wallXMin: +xMin.toFixed(2), wallZ: +zw.toFixed(1),
        eastBankX: +topo.riverBankX(zw, 1).toFixed(1),
        clearanceM: +(xMin - topo.riverBankX(zw, 1)).toFixed(1),
        offsetAtWallEnd: +topo.riverOffset(xMin, zw).toFixed(1),
        halfWidthThere: +topo.riverHalfWidthAt(zw).toFixed(1),
        // What the circuit's own solving rule would give now, for comparison. WALL_X_MIN was
        // fixed as `riverBankX(romeWallZ(x), +1) + 12`; the river has moved, so re-solving it is
        // a measurement of the conflict and not a proposal — the circuit is another pass's.
        resolvedXMin: (() => {
          let x = 0;
          for (let i = 0; i < 12; i++) x = topo.riverBankX(topo.romeWallZ(x), 1) + 12;
          return +x.toFixed(1);
        })(),
      };
    }
  }

  // ---------------------------------------------------------------- 4. anything standing in water
  const city = g.engine.ctx.tryGet('city');
  const solids = city ? city.getObstacles() : [];
  let landmarkIds = new Set();
  let landmarkAt = () => null;
  let landmarkSurveyed = () => null;
  try {
    const layout = await import('/src/city/rome/layout.ts');
    landmarkIds = new Set(layout.LANDMARKS.map((l) => l.id));
    // `CitySystem` publishes monument footprints without their ids, so a monument in the water
    // is anonymous unless it is matched back by position. Nearest landmark within 60 m.
    // Where the survey *puts* a landmark, before `resolveOverlaps` displaces it. A monument in
    // the water is a different finding depending on which of the two is wet.
    // `layout.LANDMARKS` carries the position AFTER `resolveOverlaps` has moved it, so the raw
    // survey row is the only way to tell "the survey put a monument in the river" apart from
    // "the solver pushed one in". `resolveOverlaps` is phase 2's to delete; the survey is not.
    const survey = await import('/src/city/rome/survey.ts');
    landmarkSurveyed = (id) => {
      const r = survey.ROME.find((q) => q.id === id);
      return r ? worldOf(r.e, r.n) : null;
    };
    landmarkAt = (x, z) => {
      let best = null, bd = 60;
      for (const l of layout.LANDMARKS) {
        const d = Math.hypot(l.x - x, l.z - z);
        if (d < bd) { bd = d; best = l.id; }
      }
      return best;
    };
  } catch { /* the fabric may not publish landmarks on every map */ }
  const wet = [];
  for (const o of solids) {
    const hw = o.hw ?? o.halfWidth ?? 0;
    const hd = o.hd ?? o.halfDepth ?? 0;
    if (!Number.isFinite(hw) || !Number.isFinite(hd) || (hw === 0 && hd === 0)) continue;
    const rot = o.rot ?? 0;
    let below = 0, inChannel = 0, n = 0;
    let centreBelow = false;
    for (const su of [-1, 0, 1]) {
      for (const sv of [-1, 0, 1]) {
        const x = o.x + Math.cos(rot) * hw * su + Math.sin(rot) * hd * sv;
        const z = o.z + -Math.sin(rot) * hw * su + Math.cos(rot) * hd * sv;
        n++;
        if (terrain.heightAt(x, z) <= WATER_LEVEL) { below++; if (su === 0 && sv === 0) centreBelow = true; }
        // The DRAWN channel: the distance field against the local half-width. Not the bare
        // RIVER_HALF_WIDTH, which is the constant the map declares and not the water it draws.
        if (Math.abs(topo.riverOffset(x, z)) < topo.riverHalfWidthAt(z)) inChannel++;
      }
    }
    // Re-evaluate the fabric's own filter predicate on the published box, so that a solid the
    // gate flags can be attributed: either the filter's model disagrees with the terrain, or the
    // solid never went through the filter at all.
    let modelWet = false, modelMin = Infinity;
    {
      const ah = Math.abs(hw * Math.cos(rot)) + Math.abs(hd * Math.sin(rot));
      const ad = Math.abs(hw * Math.sin(rot)) + Math.abs(hd * Math.cos(rot));
      for (const su of [-1, 0, 1]) for (const sv of [-1, 0, 1]) {
        const x = o.x + ah * su, z = o.z + ad * sv;
        if (topo.islandMask(x, z) > 0.4) continue;
        const d = topo.riverOffset(x, z);
        const inf = topo.riverInfluence(d, z);
        if (inf <= 0.001) continue;
        const plain = topo.regionalPlain(x, z);
        const gm = plain + (topo.riverProfile(d, z, plain) - plain) * inf;
        modelMin = Math.min(modelMin, gm);
        if (gm < WATER_LEVEL + 2.8) modelWet = true;
      }
    }
    if (below || inChannel) {
      wet.push({
        id: o.id ?? (o.kind === 'monument' ? (landmarkAt(o.x, o.z) ?? '(monument)') : o.kind ? `(${o.kind})` : '(insula)'),
        kind: o.kind ?? null,
        landmark: landmarkIds.has(o.id),
        x: +o.x.toFixed(1), z: +o.z.toFixed(1), hw: +hw.toFixed(1), hd: +hd.toFixed(1),
        below, inChannel, n, centreBelow,
        modelWet, modelMin: Number.isFinite(modelMin) ? +modelMin.toFixed(2) : null,
        surveyedDry: (() => {
          const sp = o.kind === 'monument' ? landmarkSurveyed(landmarkAt(o.x, o.z)) : null;
          if (!sp) return null;
          const ah = Math.abs(hw * Math.cos(rot)) + Math.abs(hd * Math.sin(rot));
          const ad = Math.abs(hw * Math.sin(rot)) + Math.abs(hd * Math.cos(rot));
          let anyWet = false;
          for (const su of [-1, 0, 1]) for (const sv of [-1, 0, 1]) {
            if (terrain.heightAt(sp.x + ah * su, sp.z + ad * sv) <= WATER_LEVEL) anyWet = true;
          }
          return { movedM: +Math.hypot(sp.x - o.x, sp.z - o.z).toFixed(1), wetAtSurveyed: anyWet };
        })(),
      });
    }
  }

  /**
   * For every solid the water gate flags, the smallest **eastward** shift of its surveyed row
   * that would take all nine samples out of the water. The brief for this pass is explicit that
   * a landmark the river displaces is a finding and not a fix, so this is the finding, with the
   * number attached.
   */
  for (const w of wet) {
    if (w.kind !== 'monument') continue;
    let need = null;
    for (let dx = 0; dx <= 400; dx += 5) {
      const o = solids.find((q) => Math.abs(q.x - w.x) < 0.5 && Math.abs(q.z - w.z) < 0.5);
      if (!o) break;
      const hw = o.hw ?? 0, hd = o.hd ?? 0, rot = o.rot ?? 0;
      const ah = Math.abs(hw * Math.cos(rot)) + Math.abs(hd * Math.sin(rot));
      const ad = Math.abs(hw * Math.sin(rot)) + Math.abs(hd * Math.cos(rot));
      let anyWet = false;
      for (const su of [-1, 0, 1]) for (const sv of [-1, 0, 1]) {
        if (terrain.heightAt(o.x + dx + ah * su, o.z + ad * sv) <= WATER_LEVEL) anyWet = true;
      }
      if (!anyWet) { need = dx; break; }
    }
    w.eastShiftWorldM = need;
    w.eastShiftRealM = need === null ? null : +(need / KX).toFixed(0);
  }

  return {
    waterLevel: WATER_LEVEL, riverHalfWidthNominal: RIVER_HALF_WIDTH,
    halfExtent: HALF_EXTENT, kx: KX, kz: KZ,
    departure, sign, bridges, wallWest,
    realWidth: rw.length ? {
      stations: rw.length,
      p10: +q(rw, 0.1).toFixed(1), median: +q(rw, 0.5).toFixed(1), p90: +q(rw, 0.9).toFixed(1),
      min: +rw[0].toFixed(1), max: +rw[rw.length - 1].toFixed(1),
    } : null,
    apex: (() => {
      // Where the great western bow turns. The plate's apex and the engine's must be at the same
      // northing, not merely the same amplitude: a bow of the right size in the wrong place still
      // reads wrong, and the swing ratio alone cannot see it.
      const band = [300, 1400];
      let engBest = null, refBest = null;
      for (let n = band[0]; n <= band[1]; n += 10) {
        const ref = traceEN ? eAtN(traceEN, n) : null;
        if (ref === null || ref === undefined) continue;
        const zz = worldOf(0, n).z;
        const eng = surveyOf(topo.riverCentreX(zz), zz).e;
        if (!engBest || eng < engBest.e) engBest = { n, e: eng };
        if (!refBest || ref < refBest.e) refBest = { n, e: ref };
      }
      return engBest && refBest
        ? { plateN: refBest.n, plateE: +refBest.e.toFixed(0), engineN: engBest.n, engineE: +engBest.e.toFixed(0), dN: engBest.n - refBest.n, dE: +(engBest.e - refBest.e).toFixed(0) }
        : null;
    })(),
    width: {
      worstRows: excess.slice(0, 6),
      medianRatio: +(excess.length ? excess[excess.length >> 1].ratio : NaN).toFixed(2),
      maxWetSpanM: excess.length ? excess.reduce((m, r) => Math.max(m, r.wetSpanM), 0) : 0,
    },
    inWater: {
      solids: solids.length,
      any: wet.length,
      wholly: wet.filter((w) => w.below === w.n).length,
      centreInWater: wet.filter((w) => w.centreBelow).length,
      inDrawnChannel: wet.filter((w) => w.inChannel > 0).length,
      monuments: wet.filter((w) => w.landmark).map((w) => w.id),
      byKind: Object.fromEntries(Object.entries(wet.reduce((m, w) => { const k = w.kind ?? 'insula'; m[k] = (m[k] ?? 0) + 1; return m; }, {}))),
      worst: wet.sort((a, b) => b.below - a.below || b.inChannel - a.inChannel).slice(0, 10),
    },
  };
}, { bridgeEN, traceEN });
await browser.close();

// ---------------------------------------------------------------------------- report
const say = (s = '') => process.stdout.write(s + '\n');
say('probe-tiber — the river\'s shape against the plate, never against its own control points');
say('');
say(`  map ${MAP}/${SCENARIO}   KX ${out.kx}  KZ ${out.kz}  WATER_LEVEL ${out.waterLevel}`);
say('');
say('  DEPARTURE from the plate, in survey (real) metres and world metres');
say('  band            ruler      n   median    p90     max   | median   max  (world)');
for (const [name, d] of Object.entries(out.departure)) {
  const s = d.vsTrace;
  if (!s) continue;
  say(`  ${(name + ' ' + d.band.join('..')).padEnd(16)}${'trace'.padEnd(9)}${String(s.n).padStart(4)}`
    + `${s.medianM.toFixed(1).padStart(9)}${s.p90M.toFixed(1).padStart(7)}${s.maxM.toFixed(1).padStart(8)}   |`
    + `${s.medianWorldM.toFixed(1).padStart(7)}${s.maxWorldM.toFixed(1).padStart(7)}`);
}
say('');
say('  THE SIXTEEN BRIDGES — each midpoint is a point on the centreline; distance to the engine curve');
say('  bridge                        n   to engine   to plate trace');
for (const b of out.bridges) {
  say(`  ${b.id.padEnd(28)}${String(b.n).padStart(5)}${(b.dM.toFixed(1) + ' m').padStart(11)}`
    + `${b.dTraceM === null ? '' : (b.dTraceM.toFixed(1) + ' m').padStart(16)}${b.onMap ? '' : '   (off map)'}`);
}
{
  const on = out.bridges.filter((b) => b.onMap).map((b) => b.dM).sort((a, b) => a - b);
  if (on.length) {
    say(`  on-map bridges: median ${on[on.length >> 1].toFixed(1)} m, worst ${on[on.length - 1].toFixed(1)} m`
      + ` (${(on[on.length - 1] * out.kx).toFixed(1)} world m)`);
  }
}
say('');
say('  SWING — how far the channel moves east-west across the band. A ratio near 1.0 is the target.');
for (const [name, d] of Object.entries(out.departure)) {
  const s = d.vsTrace;
  if (!s) continue;
  say(`  ${(name + ' vs trace').padEnd(24)} plate ${s.swingPlateM.toFixed(0).padStart(5)} m   engine ${s.swingEngineM.toFixed(0).padStart(5)} m   ratio ${s.swingRatio.toFixed(3)}`);
}
say('');
say('  SIGN OF CURVATURE — an inverted bend has a small mean error and the wrong sign.');
for (const [name, s] of Object.entries(out.sign)) {
  if (!s) continue;
  say(`  ${name.padEnd(14)} ${String(s.agree).padStart(3)} agree  ${String(s.disagree).padStart(3)} INVERTED  ${String(s.flat).padStart(3)} too flat to score`
    + (s.invertedAtN.length ? `   at n ${s.invertedAtN.slice(0, 12).join(', ')}` : ''));
}
say('');
if (out.realWidth) {
  say('  THE CHANNEL\'S WIDTH IN REAL METRES — the number the plate can be compared with');
  say(`  ${out.realWidth.stations} stations: p10 ${out.realWidth.p10}  median ${out.realWidth.median}`
    + `  p90 ${out.realWidth.p90}  min ${out.realWidth.min}  max ${out.realWidth.max} real m`
    + '   (Lanciani\'s inked channel: median 86, p10 50, p90 116)');
  say('');
}
if (out.apex) {
  say('  THE BOW\'S APEX — a bow of the right size in the wrong place still reads wrong');
  say(`  plate: westernmost at n ${out.apex.plateN}, e ${out.apex.plateE};  engine: n ${out.apex.engineN}, e ${out.apex.engineE}`
    + `  -> ${out.apex.dN > 0 ? '+' : ''}${out.apex.dN} m of northing, ${out.apex.dE > 0 ? '+' : ''}${out.apex.dE} m of easting`);
  say('');
}
say('  THE DRAWN CHANNEL vs the width it declares');
say('  (a row grazing the inside of a tight bend legitimately exceeds half/cos; the median is the');
say('   number that matters, and the two rows over 1.9 are the Tiber Island bend and the ford.)');
say(`  median  drawn / expected-across-a-row = ${out.width.medianRatio}   widest wet row ${out.width.maxWetSpanM} world m`);
say('     z   angle   declared(perp)  expected(row)   drawn(row)   ratio');
for (const r of out.width.worstRows) {
  say(`  ${String(r.z).padStart(5)}${r.angleDeg.toFixed(1).padStart(8)}${r.declaredPerpM.toFixed(0).padStart(15)}`
    + `${r.expectedRowM.toFixed(0).padStart(15)}${r.wetSpanM.toFixed(0).padStart(13)}${r.ratio.toFixed(2).padStart(8)}`);
}
say('');
if (out.wallWest) {
  say('  THE CIRCUIT\'S WEST END against the re-surveyed river');
  say(`  WALL_X_MIN ${out.wallWest.wallXMin} at z ${out.wallWest.wallZ};  east bank now x ${out.wallWest.eastBankX};`
    + `  clearance ${out.wallWest.clearanceM} world m  (offset ${out.wallWest.offsetAtWallEnd} against a half-width of ${out.wallWest.halfWidthThere})`);
  say('');
}
say('  IN WATER — measured against the drawn channel and the ground, never the bare constant');
say(`  ${out.inWater.solids} solids: ${out.inWater.wholly} wholly submerged, ${out.inWater.centreInWater} with their`
  + ` centre in water — those two are the gate.`);
say(`  ${out.inWater.any} have an edge sample in the wetted band, which is what a waterfront is; each is named below.`);
say(`  by kind: ${JSON.stringify(out.inWater.byKind)}`);
if (out.inWater.monuments.length) say(`  monuments in water: ${out.inWater.monuments.join(', ')}`);
for (const w of out.inWater.worst.slice(0, 8)) {
  say(`    ${w.id.padEnd(18)} x ${String(w.x).padStart(7)} z ${String(w.z).padStart(7)}  ${w.hw} x ${w.hd}`
    + `  edge samples wet ${w.below}/${w.n}, in the drawn channel ${w.inChannel}`
    + (w.eastShiftRealM != null ? `   [dry after an eastward shift of ${w.eastShiftRealM} real m]` : '')
    + (w.surveyedDry ? `   [solver moved it ${w.surveyedDry.movedM} m; at its SURVEYED position it is ${w.surveyedDry.wetAtSurveyed ? 'still wet' : 'dry'}]` : ''));
}
say('');
const fail = [];
if (out.inWater.wholly > 0) fail.push(`${out.inWater.wholly} solid(s) wholly submerged`);
if (out.inWater.centreInWater > 0) fail.push(`${out.inWater.centreInWater} solid(s) with their centre in water`);
if (out.sign.front && out.sign.front.disagree > 0) fail.push(`${out.sign.front.disagree} inverted curvature station(s) on the front`);
const fr = out.departure.front?.vsTrace;
if (fr && (fr.swingRatio < 0.7 || fr.swingRatio > 1.4)) fail.push(`front swing ratio ${fr.swingRatio}`);
if (out.width.medianRatio > 1.6) fail.push(`drawn channel ${out.width.medianRatio}x wider than it should be across a row`);
say(fail.length ? `  FAIL — ${fail.join('; ')}` : '  PASS — nothing stands in water, the bend has the right sign, the channel is the right width');

if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1)); say(`  wrote ${JSON_OUT}`); }
process.exit(fail.length ? 1 : 0);
