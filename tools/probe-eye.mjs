#!/usr/bin/env node
/**
 * probe-eye — **the ground under a city, and the first three metres above it.**
 *
 * `docs/VISUAL-RUBRIC.md` §H is the only category scored from a standing man's eye, and it
 * is the category both maps do worst on. It has had no instrument. `probe-fabric` grades the
 * *plan* — footprints, clearances, published dimensions, the road graph — and by its own
 * headnote it never looks at the terrain at all; `probe-ground` photographs the terrain and
 * is a reporter, not a gate. So the two things a man actually stands on and looks at, the
 * landform under the fabric and the bottom three metres of the frontage, were between them
 * ungated. `docs/ROME-RENDERS.md` says it in one line: *"Nothing in `probe-fabric` looks at
 * terrain under the fabric."*
 *
 * This is that gate. Six checks, and every ruler is outside the thing being checked, which
 * is `MAP-METHOD.md` rule 6 and the rule this project breaks most often.
 *
 * ============================================================================
 * WHAT EACH CHECK COMPARES AGAINST
 * ============================================================================
 *
 *  E1  **Published spot heights, typed into this file with the place named.** Not
 *      `topography.ts`'s `PLAIN_LEVEL`, not `floodplainMask`, not the polyline that shaped
 *      the ground — those are the inputs to the thing being measured. `SPOTS` below is
 *      metres above sea level at named piazze and summits in Rome, and the comparison is
 *      **datum-free**: every station is differenced against the median of the flood-plain
 *      stations, so the engine never has to agree with sea level, only with the *relief*.
 *
 *  E2  **The same table, read as a shape.** A landform with a published length and a
 *      published width must have that plan aspect in the built world. This is here because
 *      the project has now made the same mistake twice — the Janiculum is authored
 *      `len: 520, wid: 240` and its keep-out is `addCircle(x, z, moundRadius * 1.02)`, a
 *      circle of radius 234.6 m standing for a hill whose semi-minor axis is 96.4 m — and
 *      because a radius is exactly what a floodplain mask could have been written as. The
 *      measurement is external in the strongest available sense: it does not read the
 *      mound's own geometry, it measures **the hole the mound leaves in the fabric**, by
 *      bearing, off the built solids. A circular keep-out gives an aspect of 1.00 whatever
 *      the survey says.
 *
 *  E3  **Two producers.** The heightfield and the building generator never see each other:
 *      one publishes `heightAt`, the other reads it once per plot and lays a flat footprint.
 *      So the relief *across a building's own footprint* is a disagreement between two
 *      independent things and neither can hide it. A building on 3 m of relief either floats
 *      at one corner or is buried at another, and that is the single most visible terrain
 *      fault at 1.75 m.
 *
 *  E4  **A published gradient.** Roman urban streets are graded; the steepest named street
 *      in Rome, the Clivus Capitolinus, runs at about 1:6, and an ordinary *vicus* rarely
 *      exceeds 1:10. A flood-plain street runs at nothing. The ruler is those figures, and
 *      the samples are taken along the *drawn* carriageway rather than the planned one.
 *
 *  E5  **The geometry, scanned.** H7 says *"count openings per 10 m of frontage at eye
 *      level"* and nothing has ever counted them. This does, and it does it without asking
 *      the generator anything: it takes a solid's own face plane, collects every city
 *      triangle lying **in** that plane, unions their spans along a scanline at 1.6 m, and
 *      calls the gaps openings. A generator that intends a door and draws a flat wall scores
 *      zero here, which is the point — `VISUAL-RUBRIC.md`'s critic instruction 5 says the
 *      same thing about frames.
 *
 *  E6  **The exclusions, counted and named.** Rule 16. Every station, face and solid this
 *      probe declines to grade is counted, printed by name or coordinate, and gated on the
 *      count, so a seventh excluded row fails rather than joining a category.
 *
 * ============================================================================
 * USAGE
 * ============================================================================
 *
 *   TC_NO_HMR=1 node tools/probe-eye.mjs --map=campus-martius --port=5961
 *   TC_NO_HMR=1 node tools/probe-eye.mjs --map=carthage       --port=5961
 *   ... --json=out.json     write the full record
 *
 * Exit 0 if every declared check passes, 1 otherwise. Like `probe-fabric` it returns a
 * verdict rather than a report, and like `probe-fabric` it is expected to fail on a city
 * that is not finished.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5961);
const MAP = args.get('map') ?? 'campus-martius';
const TIER = args.get('quality') ?? 'ultra';
const JSON_OUT = args.get('json');

// ---------------------------------------------------------------------------
// THE RULERS. Literal published figures, one citation per row.
// ---------------------------------------------------------------------------

/**
 * Spot heights in Rome, **metres above sea level**, at positions in the survey frame whose
 * origin is the Capitolium (41.8925 N, 12.4823 E) — `src/city/rome/survey.ts`'s own datum.
 *
 * `e` and `n` are derived from WGS84 by the local tangent plane at that latitude
 * (1° lat = 111 132 m, 1° lon = 82 833 m at 41.8925 N) and are stated to the metre because
 * that is the precision a piazza has, not because the piazza is a point.
 *
 * The elevations are the standard published figures for these places. They are **modern**
 * ground level; the ancient surface of the Campus Martius lay 3–5 m below it, and the hills
 * are within a metre of their ancient summits because nobody raises a hill. That systematic
 * offset is why E1 is graded on *differences* against the flood-plain median rather than on
 * absolute height — the offset cancels, and what is left is the relief, which is the thing
 * the eye reads and the thing this pass changed.
 *
 * `kind`: `plain` rows are inside the Tiber flood plain and must be flat with respect to one
 * another; `hill` rows are on the Pincian, Quirinal or Capitoline and must still stand up.
 */
const SPOTS = [
  // ---- the flood plain -----------------------------------------------------
  { id: 'popolo', kind: 'plain', e: -497, n: 2045, asl: 15, where: "Piazza del Popolo, inside the Porta Flaminia. survey.ts's own PORTA_FLAMINIA anchor." },
  { id: 'ripetta', kind: 'plain', e: -654, n: 1300, asl: 11, where: 'Porto di Ripetta, the Tiber bank in the Campus Martius bend.' },
  { id: 'colonna', kind: 'plain', e: -215, n: 900, asl: 17, where: 'Piazza Colonna, on the line of the Via Lata.' },
  { id: 'pantheon', kind: 'plain', e: -447, n: 679, asl: 13, where: "Piazza della Rotonda. The Hadrianic pavement is at 13.4 m a.s.l.; the Augustan one 1.9 m below it." },
  { id: 'navona', kind: 'plain', e: -762, n: 744, asl: 13, where: "Piazza Navona, the arena floor of the Stadium of Domitian." },
  { id: 'campo', kind: 'plain', e: -836, n: 344, asl: 14, where: "Campo de' Fiori, over the cavea of the Theatre of Pompey." },
  { id: 'venezia', kind: 'plain', e: -40, n: 378, asl: 17, where: "Piazza Venezia, the plain's southern end at the Capitoline's north foot." },
  { id: 'spagna', kind: 'plain', e: 0, n: 1478, asl: 19, where: 'Piazza di Spagna, at the foot of the Pincian scarp.' },
  { id: 'trevi', kind: 'plain', e: 83, n: 933, asl: 22, where: "Fontana di Trevi, at the Quirinal's west foot. The plain's eastern limit." },
  // ---- the hills -----------------------------------------------------------
  { id: 'capitol', kind: 'hill', e: 0, n: 0, asl: 46, where: 'The Capitolium, the south summit of the Capitoline.' },
  { id: 'trinita', kind: 'hill', e: 41, n: 1500, asl: 50, where: 'Trinità dei Monti, the Pincian crest 130 m above the Spanish Steps.' },
  { id: 'quirinale', kind: 'hill', e: 422, n: 789, asl: 61, where: 'Palazzo del Quirinale — the highest of the seven hills.' },
];

/**
 * Landforms with a published length and width, for E2.
 *
 * One row, and one row is enough: the Janiculum is the only mound the frame keeps that has
 * a published plan, and it is the one the project has drawn as a circle twice.
 */
const LANDFORMS = [
  {
    id: 'janiculum',
    e: -1300, n: 260,
    lenM: 520, widM: 240, bearingDeg: 12,
    where: 'The Janiculum ridge above Trans Tiberim. `survey.ts` authors it 520 x 240 at 12 deg; '
      + '`city/plan.ts` reserves it with addCircle(moundRadius * 1.02) = r 234.6 m.',
  },
];

/** The steepest named street in Rome. Clivus Capitolinus, roughly 1:6. */
const MAX_STREET_GRADE = 0.17;
/** An ordinary urban vicus. Above this a street needs steps, and Rome's did. */
const TYPICAL_STREET_GRADE = 0.10;

/**
 * How much relief a *flood plain* may carry over a 120 m window before it stops being one.
 *
 * The Campus Martius falls about 6 m over its whole 1.3 km from the Pincian foot to the
 * river — a 0.5 % regional grade — and carries no relief above that except the river's own
 * terrace. 2.5 m over 120 m is 2 %, four times the regional figure, which leaves room for
 * the broad swells a real alluvial plain has and none for a hill.
 */
const PLAIN_RELIEF_M = 2.5;

/** Openings per 10 m of street frontage, at 1.6 m. Ostia's Via di Diana runs about 2.5. */
const H7_TARGET_PER_10M = 1.2;

async function main() {
  const { base, server } = await startVite({ port: PORT, root: ROOT, label: 'probe-eye' });
  const browser = await launchBrowser({ label: 'probe-eye', port: PORT, root: ROOT });
  let code = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const log = [];
    page.on('pageerror', (e) => log.push(`PAGEERROR ${e.message}`));
    await page.goto(
      `${base}/?harness=1&map=${MAP}&scenario=assault&quality=${TIER}&w=1280&h=720`,
      { waitUntil: 'domcontentloaded', timeout: 240000 }
    );
    await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });

    const out = await page.evaluate(measure, { SPOTS, LANDFORMS, MAP, PLAIN_RELIEF_M, MAX_STREET_GRADE, TYPICAL_STREET_GRADE, H7_TARGET_PER_10M });
    code = report(out, log);
    if (JSON_OUT) writeFileSync(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 1));
  } finally {
    await browser.close();
    await server?.close?.();
  }
  process.exit(code);
}

// ===========================================================================
// IN THE PAGE
// ===========================================================================

/* eslint-disable */
async function measure({ SPOTS, LANDFORMS, MAP, PLAIN_RELIEF_M, MAX_STREET_GRADE, TYPICAL_STREET_GRADE, H7_TARGET_PER_10M }) {
  const eng = window.__game.engine;
  const ctx = eng.context ?? eng.ctx;
  const city = ctx.get('city');
  const rig = eng.rig;
  const h = (x, z) => rig.heightAt(x, z);

  const q = (arr, p) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  };
  const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : +v.toFixed(2));

  // ------------------------------------------------------------------
  // The projection, read off the running map rather than transcribed.
  // ------------------------------------------------------------------
  const isRome = MAP === 'campus-martius';
  let worldOf = null;
  let riverDistance = () => 1e9;
  if (isRome) {
    /*
     * The projection and the river, imported from the running tree — `probe-fabric` does the
     * same at its line 2334 and for the same reason.
     *
     * **This is not the ruler and it must not be mistaken for one.** `worldOf` answers "where
     * on this map is Piazza Navona", which is a question about the map's frame, not about
     * the ground; the ruler is `SPOTS`, which is a table of heights in metres above sea
     * level and knows nothing about this file. Reading the projection here is exactly as
     * external as reading `heightAt`: both are outputs of the thing being measured, and the
     * comparison is against neither.
     *
     * The river is imported for one purpose only, which is to *exclude* stations standing in
     * the modelled channel. Those exclusions are counted and named by E6.
     */
    const topo = await import('/src/terrain/topography.ts');
    worldOf = topo.worldOf;
    riverDistance = (x, z) => Math.abs(topo.riverOffset(x, z));
  }

  const excluded = [];
  const result = { map: MAP, checks: [] };

  // ==================================================================
  // E1  the flood plain is flat, and the hills stand up
  // ==================================================================
  const stations = [];
  if (isRome) {
    for (const s of SPOTS) {
      const w = worldOf(s.e, s.n);
      const y = h(w.x, w.z);
      const dRiver = riverDistance(w.x, w.z);
      // The engine's channel is a re-survey of the real one and does not land on every real
      // bank to the metre. A station inside the modelled valley is measuring the river's
      // cross-section, not the plain, so it is excluded — and counted.
      if (dRiver < 130) {
        excluded.push({ check: 'E1', id: s.id, why: `inside the modelled Tiber valley, ${dRiver.toFixed(0)} m from the centreline` });
        continue;
      }
      stations.push({ ...s, x: r2(w.x), z: r2(w.z), y: r2(y), dRiver: r2(dRiver) });
    }
    /*
     * **E1d, and it has to run first, because it decides which stations E1a and E1b may
     * grade at all.**
     *
     * `KX` is 0.443. The Pincian's west scarp rises 31 m between Piazza di Spagna and
     * Trinità dei Monti, which are 41 real metres apart — so in this frame they are **18.2
     * world metres apart and demand a gradient of 1.58**, against the engine's own
     * `ROUGH_SLOPE_IMPASSABLE` of 0.625 and a heightfield sampled at 1.37 m and smoothed by
     * erosion and a 16 m corner rounding. No heightfield in this projection can put both
     * stations where the sources put them; the representation cannot say the thing.
     *
     * That is `MAP-METHOD.md` rule 21's question asked of a landform rather than of a river,
     * and the answer is the finding. So the pair is reported as a **frame limitation** with
     * its computed gradient, both members are excluded from E1a and E1b, and the exclusion
     * is counted and named by E6. This is a correction and not an exemption in the sense
     * rule 18 demands: it adds a relation — the projected gradient between two published
     * points — it costs a check of its own that can fail, and invoking it takes on the
     * obligation of printing the number that invoked it.
     */
    const IMPASSABLE = 0.625;
    const steepPairs = [];
    for (let i = 0; i < stations.length; i++) {
      for (let j = i + 1; j < stations.length; j++) {
        const a = stations[i]; const b = stations[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < 1) continue;
        const grade = Math.abs(a.asl - b.asl) / d;
        if (grade > IMPASSABLE) steepPairs.push({ a: a.id, b: b.id, worldM: r2(d), grade: r2(grade) });
      }
    }
    const unresolvable = new Set();
    for (const p of steepPairs) { unresolvable.add(p.a); unresolvable.add(p.b); }
    for (const id of unresolvable) {
      excluded.push({ check: 'E1-frame', id, why: 'the projected gradient to a neighbouring published station exceeds ROUGH_SLOPE_IMPASSABLE; the frame cannot carry both' });
    }
    result.checks.push({
      id: 'E1d',
      title: 'the frame can carry the relief the sources publish',
      ok: steepPairs.length === 0,
      value: steepPairs.length
        ? steepPairs.map((p) => `${p.a}-${p.b}: ${p.grade} over ${p.worldM} world m`).join('; ')
        : `no pair over ${IMPASSABLE} across ${stations.length} station(s)`,
      target: `no pair of published stations projects to a gradient above ROUGH_SLOPE_IMPASSABLE (${IMPASSABLE}). KX ${'0.443'} compresses east-west, so a real scarp becomes a cliff`,
      rows: steepPairs,
    });

    const plain = stations.filter((s) => s.kind === 'plain' && !unresolvable.has(s.id));
    const aslMed = q(plain.map((s) => s.asl), 0.5);
    const yMed = q(plain.map((s) => s.y), 0.5);
    for (const s of stations) {
      s.unresolvable = unresolvable.has(s.id) || undefined;
      s.aslRel = r2(s.asl - aslMed);
      s.yRel = r2(s.y - yMed);
      s.err = r2(s.yRel - s.aslRel);
    }
    const plainErrs = plain.map((s) => Math.abs(s.err));
    const worstPlain = plain.slice().sort((a, b) => Math.abs(b.err) - Math.abs(a.err))[0];
    result.checks.push({
      id: 'E1a',
      title: 'the flood plain stands at its published relief',
      ok: plainErrs.every((e) => e <= 4),
      value: `worst ${worstPlain ? Math.abs(worstPlain.err).toFixed(1) : 'n/a'} m at ${worstPlain?.id}; median ${q(plainErrs, 0.5)?.toFixed(1)} m over ${plain.length} station(s)`,
      target: 'every flood-plain station within 4 m of its published height, differenced against the flood-plain median',
      rows: plain,
      datum: { aslMedian: aslMed, engineMedian: yMed, impliedOffset: r2(yMed - aslMed) },
    });
    const hills = stations.filter((s) => s.kind === 'hill' && !unresolvable.has(s.id));
    for (const s of hills) s.frac = s.aslRel ? r2(s.yRel / s.aslRel) : null;
    result.checks.push({
      id: 'E1b',
      title: 'the hills the frame keeps still stand up',
      ok: hills.every((s) => s.frac !== null && s.frac >= 0.6 && s.frac <= 1.6),
      value: hills.map((s) => `${s.id} ${s.yRel} m built / ${s.aslRel} m published = ${s.frac}x`).join('; '),
      target: 'built rise over the plain within 0.6-1.6x the published rise, at every hill summit',
      rows: hills,
    });
  }

  // ==================================================================
  // E1c  local relief inside the flood plain
  // ==================================================================
  if (isRome) {
    // The sample region is the plain **as the published spot heights define it**, not as the
    // mask that shaped it does: the convex hull of the `plain` rows, shrunk 40 m so no sample
    // sits on the scarp. Nothing here reads `floodplainMask`.
    const pts = SPOTS.filter((s) => s.kind === 'plain').map((s) => worldOf(s.e, s.n));
    /*
     * The **convex hull** of the plain stations, not their bounding box. The first draft used
     * a box and it reported 15.3 m of median relief on a flood plain, because the box's
     * north-east corner is the Pincian and its east edge is the Quirinal's lower slope. A box
     * around nine points scattered across a bend in a river is not the bend in the river.
     * Shrunk toward the centroid by 6 % so no sample sits exactly on a station's own scarp.
     */
    const hullIn = pts.map((p) => ({ x: p.x, z: p.z }));
    hullIn.sort((a, b) => (a.x - b.x) || (a.z - b.z));
    const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
    const lower = [];
    for (const p of hullIn) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = hullIn.length - 1; i >= 0; i--) {
      const p = hullIn[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    /*
     * **A window statistic needs its window inside the region.** The first draft shrank the
     * hull 6 % toward its centroid, which is not an erosion: the two eastern vertices are
     * Piazza di Spagna and the Trevi, both of which sit *on* the toe of the scarp by
     * construction, so a 120 m window centred a few metres inside the boundary reached
     * sixty metres up the Pincian and reported it as flood-plain relief. Requiring every
     * sample to stand `WIN` metres clear of every hull edge is the honest form, and it is
     * the same reason `probe-fabric` measures a clearance to an edge rather than to a centre.
     */
    const WIN = 60;
    const edgeDist = (x, z) => {
      let best = Infinity;
      for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
        const a = hull[i]; const b = hull[j];
        const vx = b.x - a.x; const vz = b.z - a.z;
        const L2 = vx * vx + vz * vz;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / L2)) : 0;
        const d = Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t));
        if (d < best) best = d;
      }
      return best;
    };
    const inHull = (x, z) => {
      let inside = false;
      for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
        const a = hull[i]; const b = hull[j];
        if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
      }
      return inside && edgeDist(x, z) >= WIN;
    };
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minZ = Math.min(...pts.map((p) => p.z));
    const maxZ = Math.max(...pts.map((p) => p.z));
    const STEP = 15;
    const grid = new Map();
    for (let z = minZ; z <= maxZ; z += STEP) {
      for (let x = minX; x <= maxX; x += STEP) {
        if (!inHull(x, z)) continue;
        if (riverDistance(x, z) < 130) continue;
        grid.set(`${Math.round(x)},${Math.round(z)}`, h(x, z));
      }
    }
    const reliefs = [];
    let worst = { v: -1, x: 0, z: 0 };
    for (const [k, v] of grid) {
      const [x, z] = k.split(',').map(Number);
      let mn = v; let mx = v; let n = 0;
      for (let dz = -60; dz <= 60; dz += STEP) {
        for (let dx = -60; dx <= 60; dx += STEP) {
          const u = grid.get(`${Math.round(x + dx)},${Math.round(z + dz)}`);
          if (u === undefined) continue;
          if (u < mn) mn = u;
          if (u > mx) mx = u;
          n++;
        }
      }
      if (n < 60) continue;
      reliefs.push(mx - mn);
      if (mx - mn > worst.v) worst = { v: mx - mn, x, z };
    }
    result.checks.push({
      id: 'E1c',
      title: 'the flood plain carries no relief a flood plain would not',
      ok: reliefs.length > 0 && q(reliefs, 0.95) <= PLAIN_RELIEF_M,
      value: `median ${r2(q(reliefs, 0.5))} m, p95 ${r2(q(reliefs, 0.95))} m, worst ${r2(worst.v)} m at (${worst.x}, ${worst.z}) over ${reliefs.length} station(s)`,
      target: `95th percentile of max-min over a 120 m window at or under ${PLAIN_RELIEF_M} m`,
      note: `sampled inside the convex hull of the ${pts.length} published flood-plain stations, eroded by the ${WIN} m window radius; ${grid.size} station(s) after the river exclusion`,
    });
  }

  // ==================================================================
  // E2  a landform with a published length and width has that plan aspect
  // ==================================================================
  const obstacles = (city.getObstacles ? city.getObstacles() : []) || [];
  if (isRome && obstacles.length) {
    for (const L of LANDFORMS) {
      // The mound's actual centre, from the city's own landmark list — a position, not a
      // shape, and the shape is what is being graded.
      const lms = (city.getLandmarks ? city.getLandmarks() : []) || [];
      const lm = lms.find((m) => m.id === L.id);
      if (!lm) {
        excluded.push({ check: 'E2', id: L.id, why: 'not present in the built city' });
        continue;
      }
      const cx = lm.x; const cz = lm.z;
      // Nearest built solid on each of 24 bearings. A keep-out shaped like the hill gives a
      // radius that varies with bearing by the hill's aspect; a circular one does not.
      const BEARINGS = 24;
      const reach = [];
      for (let b = 0; b < BEARINGS; b++) {
        const a = (b / BEARINGS) * Math.PI * 2;
        const ux = Math.cos(a); const uz = Math.sin(a);
        let best = Infinity;
        for (const o of obstacles) {
          const dx = o.x - cx; const dz = o.z - cz;
          const along = dx * ux + dz * uz;
          if (along <= 0) continue;
          const off = Math.abs(-dx * uz + dz * ux);
          const halfSpan = Math.hypot(o.hw ?? 0, o.hd ?? 0);
          if (off > halfSpan + 18) continue;
          if (along < best) best = along;
        }
        if (Number.isFinite(best)) reach.push({ deg: r2((a * 180) / Math.PI), m: r2(best) });
      }
      const rs = reach.map((r) => r.m).filter((v) => v !== null);
      const rmax = Math.max(...rs);
      const rmin = Math.min(...rs);
      const builtAspect = rmin > 0 ? rmax / rmin : null;
      const publishedAspect = L.lenM / L.widM;
      result.checks.push({
        id: 'E2',
        title: `${L.id}: the ground it reserves has the plan shape the survey publishes`,
        ok: builtAspect !== null && builtAspect >= publishedAspect * 0.6,
        value: `reserved reach ${r2(rmin)}-${r2(rmax)} m over ${rs.length} bearings = aspect ${r2(builtAspect)}; published ${L.lenM} x ${L.widM} = ${r2(publishedAspect)}`,
        target: `built aspect at least 0.6x the published ${r2(publishedAspect)}; a circular keep-out reads 1.00 whatever the survey says`,
        note: L.where,
        rows: reach,
      });
    }
  }

  // ==================================================================
  // E3  terrain relief across a building's own footprint
  // ==================================================================
  {
    const rows = [];
    for (const o of obstacles) {
      if (!(o.hw > 0) || !(o.hd > 0)) continue;
      if (o.hw > 60 || o.hd > 60) continue; // monuments have substructures; this is the fabric
      const c = Math.cos(o.rot ?? 0); const s = Math.sin(o.rot ?? 0);
      let mn = Infinity; let mx = -Infinity;
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
        const px = o.x + u * o.hw * c + v * o.hd * s;
        const pz = o.z - u * o.hw * s + v * o.hd * c;
        const y = h(px, pz);
        if (y < mn) mn = y;
        if (y > mx) mx = y;
      }
      rows.push({ x: r2(o.x), z: r2(o.z), relief: r2(mx - mn) });
    }
    const vals = rows.map((r) => r.relief);
    rows.sort((a, b) => b.relief - a.relief);
    result.checks.push({
      id: 'E3',
      title: 'no building stands on more relief than its own plinth can absorb',
      ok: vals.length > 0 && q(vals, 0.95) <= 1.0 && Math.max(...vals) <= 3.0,
      value: `median ${r2(q(vals, 0.5))} m, p95 ${r2(q(vals, 0.95))} m, worst ${r2(vals.length ? Math.max(...vals) : 0)} m over ${vals.length} solid(s)`,
      target: 'p95 at or under 1.0 m and worst at or under 3.0 m of terrain fall across a footprint',
      rows: rows.slice(0, 12),
    });
  }

  // ==================================================================
  // E4  the drawn streets are graded
  // ==================================================================
  {
    const lanes = (city.getLanes ? city.getLanes() : []) || [];
    const grades = [];
    let worst = { g: -1, at: null };
    let n = 0;
    for (const l of lanes) {
      const p = l.path || l.pts || null;
      if (!p || p.length < 2) continue;
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1]; const b = p[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 4) continue;
        const steps = Math.max(1, Math.floor(len / 6));
        for (let k = 0; k < steps; k++) {
          const t0 = k / steps; const t1 = (k + 1) / steps;
          const x0 = a.x + (b.x - a.x) * t0; const z0 = a.z + (b.z - a.z) * t0;
          const x1 = a.x + (b.x - a.x) * t1; const z1 = a.z + (b.z - a.z) * t1;
          const run = Math.hypot(x1 - x0, z1 - z0);
          if (run < 1) continue;
          const g = Math.abs(h(x1, z1) - h(x0, z0)) / run;
          grades.push(g);
          n++;
          if (g > worst.g) worst = { g, at: { x: r2(x0), z: r2(z0) } };
        }
      }
    }
    const over = grades.filter((g) => g > MAX_STREET_GRADE).length;
    result.checks.push({
      id: 'E4',
      title: 'no street is steeper than the steepest street Rome had',
      ok: n > 0 && over / Math.max(1, n) <= 0.01,
      value: `median ${r2(q(grades, 0.5) * 100)} %, p95 ${r2(q(grades, 0.95) * 100)} %, worst ${r2(worst.g * 100)} % at (${worst.at?.x}, ${worst.at?.z}); ${over} of ${n} samples over ${(MAX_STREET_GRADE * 100).toFixed(0)} %`,
      target: `at most 1 % of 6 m samples steeper than the Clivus Capitolinus at ${(MAX_STREET_GRADE * 100).toFixed(0)} % (a vicus is ${(TYPICAL_STREET_GRADE * 100).toFixed(0)} %)`,
    });
  }

  // ==================================================================
  // E5  openings per 10 m of frontage, at 1.6 m
  // ==================================================================
  {
    // Every triangle under the `city` root, binned on a 24 m lattice so a face only has to
    // look at its own neighbourhood.
    const root = eng.scene.getObjectByName('city') || eng.scene.getObjectByName('city-root');
    const BIN = 24;
    const bins = new Map();
    let triCount = 0;
    const pushTri = (ax, ay, az, bx, by, bz, cx2, cy, cz2) => {
      const mx = (ax + bx + cx2) / 3; const mz = (az + bz + cz2) / 3;
      const k = `${Math.floor(mx / BIN)},${Math.floor(mz / BIN)}`;
      let arr = bins.get(k);
      if (!arr) { arr = []; bins.set(k, arr); }
      arr.push([ax, ay, az, bx, by, bz, cx2, cy, cz2]);
      triCount++;
    };
    if (root) {
      root.traverse((n) => {
        if (!n.isMesh || !n.visible || !n.geometry) return;
        const name = (n.name || '') + '|' + (n.parent?.name || '');
        // Only the ordinary fabric. Monuments, the wall and the ways are graded elsewhere
        // and a monument's blank plinth is a different finding (`CITY-GROUND-JUDGE` 10.7.3).
        if (!/city-|district|fabric/.test(name)) return;
        const pos = n.geometry.getAttribute('position');
        const idx = n.geometry.getIndex();
        if (!pos) return;
        n.updateWorldMatrix(true, false);
        const m = n.matrixWorld.elements;
        const tx = (i) => {
          const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
          return [
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          ];
        };
        const cnt = idx ? idx.count : pos.count;
        for (let i = 0; i < cnt; i += 3) {
          const ia = idx ? idx.getX(i) : i;
          const ib = idx ? idx.getX(i + 1) : i + 1;
          const ic = idx ? idx.getX(i + 2) : i + 2;
          const A = tx(ia); const B = tx(ib); const C = tx(ic);
          // Only near-vertical triangles can be a frontage.
          const maxY = Math.max(A[1], B[1], C[1]);
          const minY = Math.min(A[1], B[1], C[1]);
          if (maxY - minY < 0.25) continue;
          pushTri(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
        }
      });
    }

    const faces = [];
    // Sample up to 240 solids, evenly through the list, so the count is stable across runs
    // and does not depend on a random draw.
    const cand = obstacles.filter((o) => o.hw > 3 && o.hd > 3 && o.hw < 60 && o.hd < 60);
    const stride = Math.max(1, Math.floor(cand.length / 240));
    for (let i = 0; i < cand.length; i += stride) {
      const o = cand[i];
      const c = Math.cos(o.rot ?? 0); const s = Math.sin(o.rot ?? 0);
      const g = h(o.x, o.z);
      for (const [axis, sign] of [[0, -1], [0, 1], [1, -1], [1, 1]]) {
        const half = axis === 0 ? o.hd : o.hw;
        const run = axis === 0 ? o.hw : o.hd;
        if (run * 2 < 5) continue;
        // Centre of the face, and the two unit vectors: along the face, and outward.
        const lu = axis === 0 ? [c, -s] : [s, c];        // local +x or +z in world
        const lo = axis === 0 ? [s, c] : [c, -s];
        const fx = o.x + sign * half * lo[0];
        const fz = o.z + sign * half * lo[1];
        // Is anything standing right outside this face? If so it is a party wall or a
        // courtyard and it is not street frontage. Rule 16: counted, not silently dropped.
        let blocked = false;
        for (const p of cand) {
          if (p === o) continue;
          const dx = p.x - fx; const dz = p.z - fz;
          // Outward distance to the neighbour's NEAR face, and the lateral offset ALONG this
          // face. The first draft wrote the lateral term as `-dx*lu[1] + dz*lu[0]`, which is
          // algebraically the outward normal again, so `off` and `d` were the same number
          // and the test had no lateral limit at all: any solid anywhere in Rome whose
          // centre happened to project into a 2.15 m slab blocked the face. 947 of 1,156
          // faces were excluded by it.
          // The neighbour's OBB support along each direction, not its bounding circle.
          const pc = Math.cos(p.rot ?? 0); const ps = Math.sin(p.rot ?? 0);
          const a1 = [pc, -ps]; const a2 = [ps, pc];
          const nx = sign * lo[0]; const nz = sign * lo[1];
          const supN = (p.hw ?? 0) * Math.abs(nx * a1[0] + nz * a1[1]) + (p.hd ?? 0) * Math.abs(nx * a2[0] + nz * a2[1]);
          const supL = (p.hw ?? 0) * Math.abs(lu[0] * a1[0] + lu[1] * a1[1]) + (p.hd ?? 0) * Math.abs(lu[0] * a2[0] + lu[1] * a2[1]);
          const d = dx * nx + dz * nz - supN;
          if (d < -supN * 2 || d > 2.2) continue;
          const off = Math.abs(dx * lu[0] + dz * lu[1]);
          if (off < run + supL) { blocked = true; break; }
        }
        if (blocked) { excluded.push({ check: 'E5-party', id: `${r2(o.x)},${r2(o.z)}`, why: 'face abuts another solid inside 2.2 m: a party wall, not frontage' }); continue; }
        faces.push({ o, fx, fz, lu, lo, sign, run, g });
      }
    }

    const perFace = [];
    const Y = 1.6;
    for (const f of faces) {
      const y = f.g + Y;
      const bx = Math.floor(f.fx / BIN); const bz = Math.floor(f.fz / BIN);
      /*
       * **Find the wall plane; do not assume it.** The first draft took the obstacle's own
       * OBB face as the plane and required every vertex within 12 cm of it, and 1,064 of
       * 1,156 faces came back "not resolvable" — because `MAP-METHOD.md` rule 11 is true
       * here too: the footprint the game collides with and the stone the player sees are
       * two objects, and on this map they differ by tens of centimetres.
       *
       * So the plane is *measured*: collect every near-vertical triangle within 1.5 m of the
       * nominal face that crosses the scanline, take the **modal** outward offset in 5 cm
       * bins, and call that the wall. Anything 15 cm or more behind it is a reveal, a door
       * void or an arch soffit — that is, an opening.
       */
      const near = [];
      for (let ddz = -1; ddz <= 1; ddz++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          const arr = bins.get(`${bx + ddx},${bz + ddz}`);
          if (!arr) continue;
          for (const t of arr) {
            const ys = [t[1], t[4], t[7]];
            if (Math.min(...ys) > y || Math.max(...ys) < y) continue;
            const d = [0, 1, 2].map((k) => (t[k * 3] - f.fx) * f.sign * f.lo[0] + (t[k * 3 + 2] - f.fz) * f.sign * f.lo[1]);
            if (Math.abs(d[0]) > 1.5 || Math.abs(d[1]) > 1.5 || Math.abs(d[2]) > 1.5) continue;
            const us = [0, 1, 2].map((k) => (t[k * 3] - f.fx) * f.lu[0] + (t[k * 3 + 2] - f.fz) * f.lu[1]);
            if (Math.min(...us) > f.run || Math.max(...us) < -f.run) continue;
            near.push({ t, d, us, ys });
          }
        }
      }
      if (!near.length) { excluded.push({ check: 'E5-unresolved', id: `${r2(f.o.x)},${r2(f.o.z)}`, why: 'no city triangle within 1.5 m of this face at 1.6 m' }); continue; }
      const hist = new Map();
      for (const nt of near) {
        const dm = (nt.d[0] + nt.d[1] + nt.d[2]) / 3;
        const k = Math.round(dm / 0.05);
        hist.set(k, (hist.get(k) ?? 0) + 1);
      }
      let bestK = 0; let bestN = -1;
      for (const [k, n2] of hist) if (n2 > bestN) { bestN = n2; bestK = k; }
      const plane = bestK * 0.05;
      const spans = [];
      {
        {
          for (const nt of near) {
            const t = nt.t; const d = nt.d; const ys = nt.ys;
            // In the measured wall plane, within 15 cm. Anything behind it is an opening.
            if (Math.abs(d[0] - plane) > 0.15 || Math.abs(d[1] - plane) > 0.15 || Math.abs(d[2] - plane) > 0.15) continue;
            // Span along the face at height y.
            const us = nt.us;
            const hits = [];
            for (let k = 0; k < 3; k++) {
              const k2 = (k + 1) % 3;
              const y0 = ys[k]; const y1 = ys[k2];
              if ((y0 - y) * (y1 - y) > 0) continue;
              if (y0 === y1) { hits.push(us[k], us[k2]); continue; }
              const tt = (y - y0) / (y1 - y0);
              hits.push(us[k] + (us[k2] - us[k]) * tt);
            }
            if (hits.length < 2) continue;
            spans.push([Math.min(...hits), Math.max(...hits)]);
          }
        }
      }
      if (!spans.length) { excluded.push({ check: 'E5-unresolved', id: `${r2(f.o.x)},${r2(f.o.z)}`, why: 'no triangle in the measured wall plane at 1.6 m' }); continue; }
      // Union the covered spans over the face's own run, then measure the gaps.
      spans.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const s of spans) {
        const last = merged[merged.length - 1];
        if (last && s[0] <= last[1] + 0.02) last[1] = Math.max(last[1], s[1]);
        else merged.push([s[0], s[1]]);
      }
      const u0 = -f.run + 0.25; const u1 = f.run - 0.25;
      let openings = 0;
      let cursor = u0;
      for (const [a, b] of merged) {
        if (b < u0 || a > u1) continue;
        const gap = Math.min(a, u1) - cursor;
        if (gap >= 0.6 && gap <= 6.0) openings++;
        cursor = Math.max(cursor, Math.min(b, u1));
      }
      if (u1 - cursor >= 0.6 && u1 - cursor <= 6.0) openings++;
      const lenM = (u1 - u0);
      if (lenM < 4) continue;
      perFace.push({ x: r2(f.o.x), z: r2(f.o.z), lenM: r2(lenM), openings, per10: r2((openings / lenM) * 10) });
    }
    const totalLen = perFace.reduce((a, b) => a + b.lenM, 0);
    const totalOpen = perFace.reduce((a, b) => a + b.openings, 0);
    const per10 = totalLen > 0 ? (totalOpen / totalLen) * 10 : 0;
    const blank = perFace.filter((f) => f.openings === 0).length;
    result.checks.push({
      id: 'E5',
      title: 'the ground floor is inhabited: openings per 10 m of street frontage at 1.6 m',
      // Coverage is part of the check, not a footnote (rule 13). A measurement that stops
      // covering its population must fail rather than shrink: 120 faces and 1,200 m of
      // frontage is about a tenth of Rome's street wall and is enough for the rate to mean
      // something.
      ok: perFace.length >= 120 && totalLen >= 1200
        && per10 >= H7_TARGET_PER_10M && blank / Math.max(1, perFace.length) <= 0.35,
      value: `${r2(per10)} per 10 m over ${r2(totalLen)} m of frontage on ${perFace.length} face(s); ${totalOpen} opening(s); ${blank} face(s) (${r2((100 * blank) / Math.max(1, perFace.length))} %) with none at all`,
      target: `at least ${H7_TARGET_PER_10M} per 10 m over at least 120 face(s) and 1,200 m, and at most 35 % of street faces blank. Ostia's Via di Diana runs about 2.5`,
      note: `${triCount} city triangle(s) binned; ${faces.length} candidate face(s)`,
      faces: perFace.length,
    });
  }

  // ==================================================================
  // E6  the exclusions
  // ==================================================================
  /*
   * Rule 16, and rule 13 before it: an exclusion is a claim. Three things are gated, not one.
   *
   *  - **The categories are declared here.** A new reason is a FAIL, so a future edit cannot
   *    quietly widen an exclusion by inventing a category for the rows it is failing on.
   *  - **Each category has its own cap**, in the units that make sense for it, so a
   *    measurement that stops covering its population fails instead of shrinking.
   *  - **The names are printed every run**, so the reader can see which rows went.
   */
  const DECLARED = {
    E1: { cap: 4, of: SPOTS.length, why: 'a spot height standing inside the modelled Tiber valley measures the channel, not the plain' },
    'E1-frame': { cap: 4, of: SPOTS.length, why: 'a station the projection cannot carry, named by E1d with its gradient' },
    E2: { cap: 1, of: LANDFORMS.length, why: 'a landform the frame does not keep' },
    // A terraced city is mostly party wall — that is what a terrace is — so this cap is
    // loose on purpose and does its work through E5's own coverage floor rather than here.
    'E5-party': { cap: 0.85, of: null, why: 'a face abutting another solid: a party wall, and blank by design' },
    'E5-unresolved': { cap: 0.20, of: null, why: 'a face whose wall plane could not be measured. This one is a defect in the probe if it grows' },
  };
  const byCheck = {};
  for (const e of excluded) (byCheck[e.check] ||= []).push(e);
  const e5Faces = (byCheck['E5-party']?.length ?? 0) + (byCheck['E5-unresolved']?.length ?? 0) + (result.checks.find((c) => c.id === 'E5')?.faces ?? 0);
  const breaches = [];
  for (const [k, v] of Object.entries(byCheck)) {
    const d = DECLARED[k];
    if (!d) { breaches.push(`${k} is not a declared category`); continue; }
    const n = v.length;
    if (d.of !== null) { if (n > d.cap) breaches.push(`${k} ${n} over its cap of ${d.cap} of ${d.of}`); continue; }
    const frac = n / Math.max(1, e5Faces);
    if (frac > d.cap) breaches.push(`${k} ${n} = ${(frac * 100).toFixed(0)} % of ${e5Faces} face(s), over its cap of ${(d.cap * 100).toFixed(0)} %`);
  }
  result.checks.push({
    id: 'E6',
    title: 'every exclusion is a declared category, inside its own cap, and named',
    ok: breaches.length === 0,
    value: (Object.entries(byCheck).map(([k, v]) => `${k}: ${v.length}`).join('; ') || 'none')
      + (breaches.length ? ` -- ${breaches.join('; ')}` : ''),
    target: Object.entries(DECLARED).map(([k, d]) => `${k} <= ${d.of !== null ? d.cap : `${(d.cap * 100).toFixed(0)} %`}`).join(', '),
    rows: excluded.slice(0, 20),
  });

  result.excludedCount = excluded.length;
  return result;
}
/* eslint-enable */

function report(out, log) {
  const pad = (s, n) => String(s).padEnd(n);
  let fails = 0;
  console.log(`\nprobe-eye — ${out.map}\n`);
  for (const c of out.checks) {
    if (!c.ok) fails++;
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${pad(c.id, 5)} ${c.title}`);
    console.log(`             ${c.value}`);
    console.log(`             [target] ${c.target}`);
    if (c.note) console.log(`             [note] ${c.note}`);
    if (c.datum) console.log(`             [datum] published median ${c.datum.aslMedian} m a.s.l. against engine median ${c.datum.engineMedian}; offset ${c.datum.impliedOffset} m`);
    console.log('');
  }
  console.log(`  VERDICT  ${out.checks.length - fails}/${out.checks.length}  ${fails ? 'FAIL' : 'PASS'}\n`);
  for (const l of log) console.log(`  ${l}`);
  return fails ? 1 : 0;
}

await main();
