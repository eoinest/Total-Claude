#!/usr/bin/env node
/**
 * `rome-frame.mjs` — settle Rome's frame on paper, before a line of engine code moves.
 *
 * `docs/ROME-FABRIC.md` §5, Phase 0: *"Write `tools/scratch/rome-frame.mjs`: project all 34
 * survey rows plus the 14 circuit waypoints at a swept `KZ`, and report the off-map set, the
 * conflicting-pair count under the §4.1 merges, the Campus Martius band depth, and the
 * projected cross-street pitch."* And, at the end of §6: *"`tools/scratch/rome-frame.mjs` in
 * Phase 0 is the checked-in version and should reproduce every table in §4.5. If it does not,
 * this document is wrong and the script is right."*
 *
 * So this script's job is to be the thing that can call the design document wrong. It therefore
 * **re-implements the projection from its own inputs** — the two anchors, the metres-per-degree
 * constants, and the fixed point of `roadCentreX ∘ crestZAt` — instead of importing
 * `terrain/topography.ts`. It **parses** `src/city/rome/survey.ts` for the monument rows rather
 * than restating them, because the table is the artefact under test and a restated copy grades
 * itself (`ROME-FABRIC.md` §2.5, `MAP-METHOD.md` rule 6).
 *
 * Usage:
 *   node tools/scratch/rome-frame.mjs                 all tables
 *   node tools/scratch/rome-frame.mjs --kz=0.35       one KZ in detail, with the row-by-row z
 *   node tools/scratch/rome-frame.mjs --json          machine-readable
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit === undefined ? d : hit.slice(k.length + 3);
};
const JSON_OUT = argv.includes('--json');

// ---------------------------------------------------------------------------
// 1. The frame, re-derived rather than imported
// ---------------------------------------------------------------------------

/** `terrain/TerrainSystem.ts:HALF_EXTENT` — the heightfield's own bound. */
const HALF_EXTENT = 1400;
/** `survey.ts:CITY_Z_MAX` — the deepest z any city geometry may occupy. */
const CITY_Z_MAX = HALF_EXTENT - 26;

/** `topography.ts:roadCentreX` — the Via Flaminia's centreline. */
const roadCentreX = (z) =>
  20 + 34 * Math.sin((z + 300) * 0.0018519) - 18 * Math.sin((z + 900) * 0.0033333);
/** `topography.ts:riseToeZ` and `RISE_RUN`. */
const riseToeZ = (x) => 330 + 52 * Math.sin(x * 0.00476) + 26 * Math.sin(x * 0.01053 + 2.1);
const RISE_RUN = 175;
const crestZAt = (x) => riseToeZ(x) + RISE_RUN;

/**
 * `GATE_X` is the fixed point of `roadCentreX(crestZAt(x))`: the gate is where the Via
 * Flaminia crosses the brow. **Neither anchor depends on `KX` or on `KZ`**, which is the
 * property the whole recommendation rests on — see the invariance note below.
 */
const GATE_X = (() => {
  let x = 20;
  for (let i = 0; i < 6; i++) x = roadCentreX(crestZAt(x));
  return Math.round(x * 10) / 10;
})();
const GATE_Z = crestZAt(GATE_X);

/** The Porta Flaminia in the survey frame: Piazza del Popolo. */
const PF_E = -497;
const PF_N = 2045;
/** WGS84 to survey metres at 41.89 N, as `survey.ts` states them. */
const MLAT = 111132;
const MLON = 82857;
const LAT0 = 41.8925;
const LON0 = 12.4823;

const KX = 0.443;
const projector = (kx, kz) => {
  const X0 = GATE_X - kx * PF_E;
  const Z0 = GATE_Z + kz * PF_N;
  return { X0, Z0, of: (e, n) => ({ x: X0 + kx * e, z: Z0 - kz * n }) };
};
const latlon = (lat, lon) => ({ e: (lon - LON0) * MLON, n: (lat - LAT0) * MLAT });

// ---------------------------------------------------------------------------
// 2. The survey, parsed out of the source
// ---------------------------------------------------------------------------

const SURVEY_SRC = readFileSync(resolve(ROOT, 'src/city/rome/survey.ts'), 'utf8');

/** Parse `ROME`'s rows. Deliberately strict: a row this cannot read is a fault, not a skip. */
function parseSurvey(src) {
  const start = src.indexOf('export const ROME: readonly RomeMonument[] = [');
  if (start < 0) throw new Error('rome-frame: could not find the ROME table');
  const end = src.indexOf('\n];', start);
  const body = src.slice(start, end);
  // Slice the table at each row's `id:` line, so a row is read whole and nothing can be
  // silently skipped by a quoting variation in a later field (`name: "Trajan's Column"`).
  const marks = [];
  const idRe = /^ {4}id: '([^']+)',$/gm;
  let im;
  while ((im = idRe.exec(body)) !== null) marks.push({ id: im[1], at: im.index });
  const rows = [];
  for (let k = 0; k < marks.length; k++) {
    const chunk = body.slice(marks[k].at, k + 1 < marks.length ? marks[k + 1].at : body.length);
    const geom = /\n\s*e: (-?[\d.]+), n: (-?[\d.]+), len: (-?[\d.]+), wid: (-?[\d.]+), bearing: (-?[\d.]+),/.exec(chunk);
    if (!geom) throw new Error(`rome-frame: row ${marks[k].id} has no e/n/len/wid/bearing line`);
    const nameM = /\n\s*name: (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(chunk);
    // Flags live between the geometry line and the `cite:` field.
    const citeAt = chunk.indexOf('cite:');
    const flags = chunk.slice(geom.index, citeAt < 0 ? chunk.length : citeAt);
    rows.push({
      id: marks[k].id,
      name: (nameM ? (nameM[1] ?? nameM[2]) : marks[k].id).replace(/\\'/g, "'"),
      e: +geom[1],
      n: +geom[2],
      len: +geom[3],
      wid: +geom[4],
      bearing: +geom[5],
      axis: /axis: 'z'/.test(flags) ? 'z' : 'x',
      soft: /\bsoft: true/.test(flags),
      farBank: /\bfarBank: true/.test(flags),
      onRiver: /\bonRiver: true/.test(flags),
      offMapEast: /\boffMapEast: true/.test(flags),
    });
  }
  // Count the `id:` keys in the table so a row the parser silently dropped is caught.
  const declared = (body.match(/^ {4}id: '/gm) || []).length;
  if (rows.length !== declared) {
    throw new Error(`rome-frame: parsed ${rows.length} rows but the table declares ${declared}`);
  }
  return rows;
}

const ROME = parseSurvey(SURVEY_SRC);

/** `topography.ts:ROME_CIRCUIT_SURVEY`, parsed under the same discipline. */
function parseCircuit() {
  const src = readFileSync(resolve(ROOT, 'src/terrain/topography.ts'), 'utf8');
  const start = src.indexOf('export const ROME_CIRCUIT_SURVEY');
  const end = src.indexOf('\n];', start);
  const body = src.slice(start, end);
  const out = [];
  const re = /\{ id: '([^']+)', e: (-?[\d.]+), n: (-?[\d.]+) \}/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push({ id: m[1], e: +m[2], n: +m[3] });
  return out;
}
const CIRCUIT = parseCircuit();

// ---------------------------------------------------------------------------
// 3. §4.1's five merges
// ---------------------------------------------------------------------------

/**
 * `ROME-FABRIC.md` §4.5 "What remodel means concretely". Each merge is a correction to the
 * survey: in every one of these five cases the survey models a nested or abutting complex
 * as free-standing boxes, so the boxes overlap in reality too.
 */
const MERGES = [
  {
    id: 'imperial-fora',
    name: 'Imperial fora',
    absorbs: ['imperial-fora', 'basilica-ulpia', 'trajan-column', 'trajan-market'],
    plan: [380, 230],
  },
  { id: 'capitolium', name: 'Capitolium', absorbs: ['temple-jupiter', 'tabularium'], plan: [120, 90] },
  { id: 'agrippan', name: 'Agrippan complex', absorbs: ['pantheon', 'baths-agrippa'], plan: [200, 110] },
  {
    id: 'octavia-marcellus',
    name: 'Octavia-Marcellus',
    absorbs: ['porticus-octaviae', 'theatre-marcellus'],
    plan: [230, 150],
  },
  { id: 'oppian-baths', name: 'Oppian baths', absorbs: ['baths-titus', 'baths-trajan'], plan: [300, 200] },
];

/**
 * **A sixth merge, proposed by the absorption test rather than by the document.** `--merge6`.
 *
 * `--absorb` finds three pairs that no per-monument footprint can clear, and one of them —
 * the Agrippan complex against the Baths of Nero — is an **east–west** conflict, so `KZ` cannot
 * help and `KX` is at its ceiling. Their real centres are 125 m apart in `e` and 3 m in `n`;
 * that is 55 world metres, and two footprints even at a third of plan need 69. The Thermae
 * Neronianae stood immediately between the Stadium of Domitian and the Pantheon and abutted
 * Agrippa's baths, which is §4.1's own criterion for a merge: *"the survey models a nested or
 * abutting complex as free-standing boxes."* So this is the same correction as the other five
 * and it is offered to phase 2 as a measurement, not applied here.
 */
const MERGE_6 = {
  id: 'agrippan',
  name: 'Agrippan complex + Thermae Neronianae',
  absorbs: ['pantheon', 'baths-agrippa', 'baths-nero'],
  plan: [330, 130],
};
if (argv.includes('--merge6')) {
  MERGES[2] = MERGE_6;
}

/** Apply the merges: centroid of the absorbed rows, and §4.5's published merged plan. */
function merged(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const eaten = new Set();
  const out = [];
  for (const mg of MERGES) {
    const parts = mg.absorbs.map((id) => byId.get(id)).filter(Boolean);
    if (parts.length === 0) continue;
    for (const p of parts) eaten.add(p.id);
    const e = parts.reduce((s, p) => s + p.e, 0) / parts.length;
    const n = parts.reduce((s, p) => s + p.n, 0) / parts.length;
    const anchor = byId.get(mg.absorbs[0]);
    out.push({
      id: mg.id,
      name: mg.name,
      e,
      n,
      len: mg.plan[0],
      wid: mg.plan[1],
      bearing: anchor.bearing,
      axis: 'x',
      soft: false,
      farBank: false,
      onRiver: false,
      offMapEast: false,
      mergedFrom: mg.absorbs,
    });
  }
  for (const r of rows) if (!eaten.has(r.id)) out.push(r);
  return out;
}

// ---------------------------------------------------------------------------
// 4. Conflicting pairs — §2.2's rule, on oriented boxes
// ---------------------------------------------------------------------------

const PRECINCT = 1.07;
const STREET_GAP = 7;

/**
 * Separating-axis clearance between two oriented rectangles: the **largest** separation over
 * the four candidate axes, because a pair is separated as soon as one axis separates it.
 * Negative means interpenetrating; the sign convention matches `ROME-FABRIC.md` §2.2's table.
 *
 * The candidate axes are the four face normals, and they are built from **direction vectors**
 * rather than from angles, because this engine's `makeRotationY(r)` maps local +X to world
 * `(cos r, -sin r)` and local +Z to `(sin r, cos r)` — so a box's own axes are at angles `-r`
 * and `-r + pi/2`, not `r` and `r + pi/2`. Getting that sign wrong tests two axes the boxes do
 * not have, which inflates the overlap count; it did, by thirteen pairs, on the first run of
 * this script.
 */
const boxAxes = (r) => [
  [Math.cos(r.rot), -Math.sin(r.rot)],
  [Math.sin(r.rot), Math.cos(r.rot)],
];

function satGap(a, b) {
  const axes = [...boxAxes(a), ...boxAxes(b)];
  let best = -Infinity;
  for (const [ux, uz] of axes) {
    const proj = (r) => {
      const [ax, az] = boxAxes(r)[0];
      const [bx, bz] = boxAxes(r)[1];
      return Math.abs(r.hw * (ax * ux + az * uz)) + Math.abs(r.hd * (bx * ux + bz * uz));
    };
    best = Math.max(best, Math.abs((b.x - a.x) * ux + (b.z - a.z) * uz) - proj(a) - proj(b));
  }
  return best;
}

/** `survey.ts:worldRot`, with the anisotropy ratio passed in so `ROT_RATIO` can be tested. */
const worldRot = (bearingDeg, axis, kz, ratio) => {
  const th = (bearingDeg * Math.PI) / 180;
  const dx = kz * ratio * Math.sin(th);
  const dz = -kz * Math.cos(th);
  return axis === 'x' ? -Math.atan2(dz, dx) : Math.atan2(dx, dz);
};

/** Reserve every masonry monument at exactly `worldOf(e, n)` — no resolver, by construction. */
function reserve(rows, kz, planScale, rotRatio) {
  const P = projector(KX, kz);
  return rows
    .filter((r) => !r.soft)
    .map((r) => {
      const w = P.of(r.e, r.n);
      const alongZ = r.axis === 'z';
      return {
        id: r.id,
        x: w.x,
        z: w.z,
        rot: worldRot(r.bearing, r.axis, kz, rotRatio),
        hw: (alongZ ? r.wid : r.len) * 0.5 * PRECINCT * planScale,
        hd: (alongZ ? r.len : r.wid) * 0.5 * PRECINCT * planScale,
        /**
         * **The footprint has to be clear of the edge, not just the centre**, which is what
         * `topography.ts:KZ`'s own docstring means by *"the largest value that fits Caracalla
         * inside the map with its precinct clear of the edge"*. A centre test disagrees with
         * `ROME-FABRIC.md` §4.5's off-map sets at `KZ` 0.30 and 0.38; this one reproduces them.
         * The bound is `HALF_EXTENT`, the heightfield's own edge, and not `CITY_Z_MAX` — the
         * 26 m inset is a *fabric* margin and a backdrop monument may stand in it.
         */
        onMap:
          w.z + (alongZ ? r.len : r.wid) * 0.5 * PRECINCT * planScale <= HALF_EXTENT,
        centreOnMap: w.z <= CITY_Z_MAX,
      };
    });
}

function conflicts(boxes) {
  const on = boxes.filter((b) => b.onMap);
  const out = [];
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const g = satGap(on[i], on[j]);
      if (g < STREET_GAP) out.push({ a: on[i].id, b: on[j].id, gap: g });
    }
  }
  return out.sort((p, q) => p.gap - q.gap);
}

// ---------------------------------------------------------------------------
// 5. The tables
// ---------------------------------------------------------------------------

const KZ_SWEEP = [0.222, 0.26, 0.3, 0.35, 0.38, 0.413];
const PS_SWEEP = [0.65, 0.8, 1.0];
const report = { gateX: GATE_X, gateZ: GATE_Z, kx: KX, rows: ROME.length, circuit: CIRCUIT.length };

const say = (...a) => {
  if (!JSON_OUT) console.log(...a);
};

say('\n=== rome-frame: the frame, re-derived ===');
say(`GATE_X = ${GATE_X.toFixed(4)}   GATE_Z = ${GATE_Z.toFixed(4)}   (fixed point of roadCentreX of crestZAt)`);
say(`survey rows parsed: ${ROME.length}    circuit waypoints: ${CIRCUIT.length}`);

// --- invariance of the two anchors under KX and KZ -------------------------
say('\n--- anchor invariance: neither GATE_X nor GATE_Z contains KX or KZ ---');
say('  roadCentreX and crestZAt are functions of x and z alone; the fixed point is therefore');
say(`  independent of the projection. GATE_Z = ${GATE_Z.toFixed(3)} at every KZ, so the approach`);
say(`  distance from the German box (z -196) is ${(GATE_Z + 196).toFixed(1)} m at every KZ.`);
report.approach = GATE_Z + 196;

// --- KX's ceiling ---------------------------------------------------------
say('\n--- KX ceiling (§4.5): west end = 72 - 158*KX, east end = 72 + 2850*KX ---');
say('   KX     west     east   verdict');
report.kxCeiling = [];
for (const kx of [0.443, 0.466, 0.5]) {
  const P = projector(kx, 0.35);
  const w = P.of(-655, 2006).x;
  const e = P.of(2353, 1578).x;
  const verdict =
    e > HALF_EXTENT
      ? 'OFF THE MAP'
      : e > HALF_EXTENT - 5
        ? 'exactly on the edge'
        : `fits, ${(HALF_EXTENT - e).toFixed(0)} m of headroom`;
  say(`  ${kx.toFixed(3)}  ${w.toFixed(1).padStart(7)}  ${e.toFixed(1).padStart(7)}   ${verdict}`);
  report.kxCeiling.push({ kx, west: w, east: e, verdict });
}

// --- the KZ sweep ---------------------------------------------------------
const MERGED = merged(ROME);
say(`\n--- the KZ sweep. ${ROME.length} survey rows; ${MERGED.length} after §4.1's five merges ---`);
say('   KZ   aniso   south n   on-map   off-map monuments');
report.kzSweep = [];
for (const kz of KZ_SWEEP) {
  const P = projector(KX, kz);
  const boxes = reserve(MERGED, kz, 0.65, 1.45);
  const off = boxes.filter((b) => !b.onMap).map((b) => b.id);
  const offSoft = MERGED.filter((r) => r.soft)
    .filter((r) => P.of(r.e, r.n).z > CITY_Z_MAX)
    .map((r) => r.id);
  const southN = (P.Z0 - CITY_Z_MAX) / kz;
  const row = { kz, aniso: KX / kz, southN, onMap: boxes.length - off.length, off, offSoft };
  report.kzSweep.push(row);
  say(
    `  ${kz.toFixed(3)}  ${(KX / kz).toFixed(2)}x  ${southN.toFixed(0).padStart(8)}  ${row.onMap
      .toString()
      .padStart(6)}   ${off.join(', ') || '-'}${offSoft.length ? `  (soft: ${offSoft.join(', ')})` : ''}`
  );
}

// --- conflicting pairs ----------------------------------------------------
say(`\n--- conflicting pairs: reserved boxes closer than STREET_GAP = ${STREET_GAP} m, merges applied ---`);
say('   KZ   on-map   PS 0.65   PS 0.80   PS 1.00');
report.conflicts = [];
for (const kz of KZ_SWEEP) {
  const cols = PS_SWEEP.map((ps) => conflicts(reserve(MERGED, kz, ps, 1.45)).length);
  const onMap = reserve(MERGED, kz, 0.65, 1.45).filter((b) => b.onMap).length;
  report.conflicts.push({ kz, onMap, ps: Object.fromEntries(PS_SWEEP.map((p, i) => [p, cols[i]])) });
  say(`  ${kz.toFixed(3)}  ${onMap.toString().padStart(6)}  ${cols.map((c) => c.toString().padStart(8)).join('  ')}`);
}

// --- unmerged control, so the merges' own contribution is visible ---------
{
  const un65 = conflicts(reserve(ROME, 0.222, 0.65, 1.45)).length;
  const mg65 = conflicts(reserve(MERGED, 0.222, 0.65, 1.45)).length;
  say(`\n  control, KZ 0.222 PS 0.65: ${un65} conflicts unmerged -> ${mg65} merged (§4.5 says 34 -> 22)`);
  report.mergeControl = { unmerged: un65, merged: mg65 };
}

// --- the chosen frame, in detail ------------------------------------------
const KZ_PICK = +arg('kz', '0.35');
say(`\n=== the chosen frame: KZ = ${KZ_PICK} ===`);
{
  const P = projector(KX, KZ_PICK);
  const boxes = reserve(MERGED, KZ_PICK, 0.65, 1.45);
  const cf = conflicts(boxes);
  const gate = P.of(PF_E, PF_N);
  const cap = boxes.find((b) => b.id === 'capitolium');
  const depth = cap.z - gate.z;
  say(
    `  Z0 = ${P.Z0.toFixed(3)}   anisotropy ${(KX / KZ_PICK).toFixed(3)}x   south edge at survey n ${(
      (P.Z0 - CITY_Z_MAX) /
      KZ_PICK
    ).toFixed(0)}`
  );
  say(`  approach: German box z -196 -> Porta Flaminia z ${gate.z.toFixed(2)} = ${(gate.z + 196).toFixed(1)} m`);
  say(`  Campus Martius band depth, Porta Flaminia -> Capitolium: ${depth.toFixed(1)} world m`);
  say(
    `  projected cross-street pitch, real 50-90 m: ${(50 * KZ_PICK).toFixed(1)} - ${(90 * KZ_PICK).toFixed(
      1
    )} world m  (median 70 -> ${(70 * KZ_PICK).toFixed(1)})`
  );
  say(
    `  front: x ${P.of(-655, 2006).x.toFixed(2)} -> ${P.of(2353, 1578).x.toFixed(2)} = ${(
      P.of(2353, 1578).x - P.of(-655, 2006).x
    ).toFixed(2)} world m`
  );
  say(`  conflicting pairs at PS 0.65: ${cf.length}`);
  for (const c of cf) say(`     ${c.gap.toFixed(1).padStart(8)} m   ${c.a} / ${c.b}`);
  report.chosen = {
    kz: KZ_PICK,
    Z0: P.Z0,
    aniso: KX / KZ_PICK,
    approach: gate.z + 196,
    bandDepth: depth,
    pitch: [50 * KZ_PICK, 90 * KZ_PICK],
    conflicts: cf,
  };

  // Bearing correction: at 1.27x is ROT_RATIO still doing anything?
  say(`\n  --- worldRot: does the bearing correction still matter at ${(KX / KZ_PICK).toFixed(2)}x? ---`);
  let worstRot = 0;
  let worstId = '';
  for (const r of MERGED.filter((x) => !x.soft)) {
    const a = worldRot(r.bearing, r.axis, KZ_PICK, 1.45);
    const b = worldRot(r.bearing, r.axis, KZ_PICK, KX / KZ_PICK);
    const d = Math.abs(((a - b) * 180) / Math.PI);
    if (d > worstRot) {
      worstRot = d;
      worstId = r.id;
    }
  }
  say(`  ROT_RATIO 1.45 vs the true ${(KX / KZ_PICK).toFixed(3)}: worst bearing difference ${worstRot.toFixed(2)} deg (${worstId})`);
  report.chosen.rotRatioWorstDeg = worstRot;
}

// --- circuit waypoints, both KZ -------------------------------------------
say('\n--- the fourteen circuit waypoints ---');
say(`  id                      e      n        x    z@0.222    z@${KZ_PICK}`);
{
  const A = projector(KX, 0.222);
  const B = projector(KX, KZ_PICK);
  report.circuitRows = [];
  for (const p of CIRCUIT) {
    const a = A.of(p.e, p.n);
    const b = B.of(p.e, p.n);
    say(
      `  ${p.id.padEnd(20)} ${p.e.toString().padStart(6)} ${p.n.toString().padStart(6)}  ${a.x
        .toFixed(1)
        .padStart(7)}  ${a.z.toFixed(1).padStart(8)}  ${b.z.toFixed(1).padStart(8)}`
    );
    report.circuitRows.push({ id: p.id, e: p.e, n: p.n, x: a.x, z222: a.z, zPick: b.z });
  }
  const front = CIRCUIT.slice(0, 12);
  const xs = front.map((p) => A.of(p.e, p.n).x);
  const mono = xs.every((v, i) => i === 0 || v > xs[i - 1]);
  const span = xs[xs.length - 1] - xs[0];
  say(`  front monotone in x: ${mono}   span ${span.toFixed(2)} m   pitch over 36 bays ${(span / 36).toFixed(3)} m`);
  report.front = { monotone: mono, span, pitch: span / 36, west: xs[0], east: xs[xs.length - 1] };
}

// --- the Tiber, re-projected ----------------------------------------------
say('\n--- the Tiber: the twelve surveyed points, re-projected ---');
const TIBER_LL = [
  [41.945, 12.46],
  [41.9352, 12.467],
  [41.927, 12.47],
  [41.92, 12.4712],
  [41.913, 12.4718],
  [41.9052, 12.4723],
  [41.9013, 12.4665],
  [41.8965, 12.464],
  [41.893, 12.47],
  [41.8905, 12.4778],
  [41.882, 12.476],
  [41.87, 12.472],
];
{
  const A = projector(KX, 0.222);
  const B = projector(KX, KZ_PICK);
  const old = [];
  const neu = [];
  for (const [la, lo] of TIBER_LL) {
    const { e, n } = latlon(la, lo);
    old.push(A.of(e, n));
    neu.push(B.of(e, n));
  }
  say(`  #    x        z@0.222     z@${KZ_PICK}`);
  for (let i = 0; i < old.length; i++) {
    say(
      `  ${(i + 1).toString().padStart(2)}  ${old[i].x.toFixed(2).padStart(9)}  ${old[i].z
        .toFixed(2)
        .padStart(9)}  ${neu[i].z.toFixed(2).padStart(9)}`
    );
  }
  const slope = (pts) => (pts[pts.length - 1].x - pts[0].x) / (pts[pts.length - 1].z - pts[0].z);
  const seg = (pts, i, j) => (pts[j].x - pts[i].x) / (pts[j].z - pts[i].z);
  say(`  mean slope dx/dz: ${slope(old).toFixed(4)} at 0.222 -> ${slope(neu).toFixed(4)} at ${KZ_PICK}`);
  say(`  first segment (north runout): ${seg(old, 0, 1).toFixed(4)} -> ${seg(neu, 0, 1).toFixed(4)}`);
  say(`  last  segment (south runout): ${seg(old, 10, 11).toFixed(4)} -> ${seg(neu, 10, 11).toFixed(4)}`);
  report.tiber = {
    old,
    neu,
    meanSlopeOld: slope(old),
    meanSlopeNew: slope(neu),
    firstSegNew: seg(neu, 0, 1),
    lastSegNew: seg(neu, 10, 11),
  };
  say(`\n  TIBER_PATH at KZ = ${KZ_PICK}, ready to paste:`);
  for (let i = 0; i < neu.length; i++) say(`  ${neu[i].x.toFixed(2)}, ${neu[i].z.toFixed(2)},`);
}

// --- the insula arithmetic that decides §4.3 ------------------------------
say('\n--- §4.3 insula arithmetic: does a true-depth insula fit between two cross-streets? ---');
{
  const INSULA_DEPTH_MAX = 22;
  const FRONTAGE = 4;
  const need = INSULA_DEPTH_MAX + 2 * FRONTAGE;
  say(`  an insula at true depth needs ${INSULA_DEPTH_MAX} m + 2 x ${FRONTAGE} m frontage = ${need} world m`);
  report.insula = [];
  for (const kz of KZ_SWEEP) {
    const lo = 50 * kz;
    const hi = 90 * kz;
    const med = 70 * kz;
    const frac = Math.max(0, Math.min(1, (hi - need) / (hi - lo)));
    say(
      `  KZ ${kz.toFixed(3)}: pitch ${lo.toFixed(1)}-${hi.toFixed(1)} m (median ${med.toFixed(
        1
      )}) -> fits over ${(frac * 100).toFixed(0)} % of the range`
    );
    report.insula.push({ kz, lo, hi, med, fitFraction: frac });
  }
}

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));

// ---------------------------------------------------------------------------
// 6. --absorb: can `resolveOverlaps` be deleted without the overlaps coming back?
// ---------------------------------------------------------------------------

/**
 * **The question the fabric gate raised, answered on paper before phase 2 spends a day on it.**
 *
 * `tools/probe-fabric.mjs` measured the real fault: on the *shipped* city there are zero
 * intersecting monument pairs, because `resolveOverlaps` displaces monuments a mean of 65.3 m
 * and a worst of 167.7 m to get there. The owner's *"the footprint of where the buildings are is
 * completely wrong… everything is completely off"* is a description of that displacement, not of
 * overlap. So deleting the resolver is the fix — and the risk is obvious: delete it and the
 * projected intersections come back as real ones.
 *
 * Two properties have to hold **at the same time**, and the code has never managed both:
 *
 *   1. every monument centre is exactly `worldOf(e, n)` — nothing moved;
 *   2. no two reserved footprints are closer than `STREET_GAP` — nothing overlaps.
 *
 * This mode holds (1) by construction — no monument is ever moved — and buys (2) with the only
 * currency §4.5 leaves: a **per-monument authored footprint**, declared in the survey beside the
 * real dimension it departs from. It reports the departure per monument, so phase 2 starts from
 * a solved seed rather than from a search, and so a reader can see exactly which buildings the
 * map is shrinking and by how much.
 *
 * The rule it follows is §4.5's: *"seeded at 0.65 of the real plan and adjusted only where the
 * probe says a pair conflicts."* Greedy, worst pair first, and it never shrinks a monument that
 * is not in a conflict. `FLOOR` is the point below which a building stops being the building —
 * a Colosseum under about a third of plan is a tower, which is §4.5's own argument against the
 * uniform 0.232 — and anything that hits it is reported as unsolved rather than shrunk past it.
 */
function absorb(rows, kz, seed, floor) {
  const scale = new Map(rows.filter((r) => !r.soft).map((r) => [r.id, seed]));
  const build = () => {
    const P = projector(KX, kz);
    return rows
      .filter((r) => !r.soft)
      .map((r) => {
        const w = P.of(r.e, r.n);
        const alongZ = r.axis === 'z';
        const s = scale.get(r.id);
        const hd = (alongZ ? r.len : r.wid) * 0.5 * PRECINCT * s;
        return {
          id: r.id,
          x: w.x,
          z: w.z,
          rot: worldRot(r.bearing, r.axis, kz, 1.45),
          hw: (alongZ ? r.wid : r.len) * 0.5 * PRECINCT * s,
          hd,
          onMap: w.z + hd <= HALF_EXTENT,
        };
      });
  };
  let cf = conflicts(build());
  let guard = 0;
  const stuck = new Set();
  while (cf.length > 0 && guard++ < 20000) {
    // Worst pair first: the deepest interpenetration is the one that most constrains the rest.
    const worst = cf[0];
    /**
     * **Shrink the larger of the pair, not both.** Shrinking both cascades: a monument that is
     * only incidentally in a conflict loses plan for a neighbour's crowding, then conflicts with
     * *its* neighbour at the smaller size, and the whole quarter walks down to the floor. Taking
     * the larger footprint each time puts the cost where the area is, which is also the honest
     * place for it — a 380 x 230 m complex has more to give than a 90 x 60 m precinct.
     */
    const area = (id) => {
      const r = rows.find((q) => q.id === id);
      return r.len * r.wid * scale.get(id) * scale.get(id);
    };
    const bigger = area(worst.a) >= area(worst.b) ? worst.a : worst.b;
    const smaller = bigger === worst.a ? worst.b : worst.a;
    let moved = false;
    for (const id of [bigger, smaller]) {
      const s = scale.get(id);
      if (s > floor + 1e-9) {
        scale.set(id, Math.max(floor, s * 0.98));
        moved = true;
        break;
      }
    }
    if (!moved) {
      stuck.add(`${worst.a} / ${worst.b}`);
      // Both are on the floor: this pair cannot be absorbed by footprint alone. Drop it from
      // consideration so the rest can still be solved, and report it.
      const before = cf.length;
      cf = cf.filter((c) => !(c.a === worst.a && c.b === worst.b));
      if (cf.length === before) break;
      continue;
    }
    cf = conflicts(build()).filter((c) => !stuck.has(`${c.a} / ${c.b}`));
  }
  const final = build();
  return {
    scale,
    stuck: [...stuck],
    conflicts: conflicts(final),
    departures: [...scale.entries()]
      .filter(([, s]) => Math.abs(s - seed) > 1e-6)
      .sort((a, b) => a[1] - b[1]),
    onMap: final.filter((b) => b.onMap).length,
  };
}

if (argv.includes('--absorb')) {
  const SEED = +arg('seed', '0.65');
  const FLOOR = +arg('floor', '0.33');
  say(`\n=== --absorb: nothing moves, and nothing overlaps, at KZ = ${KZ_PICK} ===`);
  say(`  seed ${SEED}, floor ${FLOOR}, merges applied, every centre frozen at worldOf(e, n)`);
  const a = absorb(MERGED, KZ_PICK, SEED, FLOOR);
  say(`  on-map monuments: ${a.onMap}`);
  const inter = a.conflicts.filter((c) => c.gap < 0);
  const minGap = a.conflicts.length ? a.conflicts[0].gap : Infinity;
  say(`  INTERSECTING pairs (gap < 0): ${inter.length}`);
  say(`  pairs under the ${STREET_GAP} m street but not intersecting: ${a.conflicts.length - inter.length}`);
  say(`  minimum clear gap over every on-map pair: ${Number.isFinite(minGap) ? minGap.toFixed(1) : '>= 7'} m`);
  for (const c of a.conflicts) say(`     ${c.gap.toFixed(1).padStart(8)} m   ${c.a} / ${c.b}`);
  say(`  pairs that could not be absorbed at the floor: ${a.stuck.length}${a.stuck.length ? ` — ${a.stuck.join('; ')}` : ''}`);
  say(`\n  authored footprint departures from the ${SEED} seed (${a.departures.length} of ${a.scale.size}):`);
  for (const [id, s] of a.departures) {
    const row = MERGED.find((r) => r.id === id);
    say(
      `     ${id.padEnd(22)} ${s.toFixed(3)}  (${((1 - s / SEED) * 100).toFixed(0)} % under the seed)` +
        `   real ${row.len} x ${row.wid} m  ->  drawn ${(row.len * s).toFixed(0)} x ${(row.wid * s).toFixed(0)} m`
    );
  }
  const unchanged = a.scale.size - a.departures.length;
  say(`\n  ${unchanged} monument(s) keep the seed unchanged.`);
  report.absorb = {
    seed: SEED,
    floor: FLOOR,
    conflicts: a.conflicts,
    stuck: a.stuck,
    departures: a.departures.map(([id, s]) => ({ id, scale: +s.toFixed(4) })),
  };
}

// ---------------------------------------------------------------------------
// 7. --table: the survey in CARTHAGE.md §2.5's format
// ---------------------------------------------------------------------------

/**
 * **The six Campus Martius monuments `ROME-FABRIC.md` §4.1 lists as missing from the tree.**
 *
 * §4.1 publishes them as **world x/z at `KZ` = 0.222**, because the gazetteer they come from is
 * authored on the Pantheon's rotunda and is independent of `survey.ts`. It also gives the
 * instruction that matters: *"the x/z above must be back-converted to `e`/`n` before use, so
 * that they project like every other row instead of being hand-typed world coordinates — which
 * is Carthage's mistake (§1.3)… a hand-typed world coordinate cannot be re-projected when `KZ`
 * changes, and `KZ` is changing."*
 *
 * `KZ` has now changed, so the back-conversion is done here rather than deferred: `e` and `n`
 * are recovered by inverting `worldOf` **at the `KZ` those coordinates were published under**,
 * and the table then re-projects them at the current one like every other row. The published
 * world pair is kept beside the recovered survey pair so the arithmetic is checkable.
 *
 * These are **not** added to `survey.ts` by phase 1. Phase 2 adds them, with the `cite` field
 * each row needs, after each has been checked against a plate.
 */
const MISSING = [
  {
    id: 'saepta-iulia', name: 'Saepta Iulia', x222: 212, z222: 870, len: 310, wid: 120,
    plan: 'enclosure c. 310 x 120; pier hall 400 x 60, piers 1.70 m sq. at 4 m centres',
    src: 'Severan Plan; Platner-Ashby. The largest omission: 3.7 ha of colonnaded hall on the Via Lata, on the gate axis',
  },
  {
    id: 'porticus-pompei', name: 'Porticus Pompei', x222: 10, z222: 914, len: 180, wid: 135,
    plan: '180 x 135, four rows of columns, a double grove of plane trees',
    src: 'Severan Plan. Undamaged in 271 while the theatre beside it is a burnt ruin from 247',
  },
  {
    id: 'porticus-divorum', name: 'Porticus Divorum', x222: 226, z222: 890, len: 200, wid: 55,
    plan: 'c. 200 x 55, thirty-plus columns a side', src: 'Regionaries',
  },
  {
    id: 'diribitorium', name: 'Diribitorium', x222: 208, z222: 905, len: 60, wid: 60,
    plan: 'roof beams 30 m — the largest single-roofed building in Rome',
    src: 'Regionaries. A roofless shell for 191 years, since the fire of 80',
  },
  {
    id: 'circus-flaminius', name: 'Circus Flaminius', x222: 98, z222: 1003, len: 260, wid: 100,
    plan: 'c. 260 x 100 — and not a circus: no stands, no barrier',
    src: 'Regionaries. A paved, encroached piazza; the only large open ground inside the walls on the south half of the map',
  },
  {
    id: 'theatre-balbus', name: 'Theatre of Balbus / Crypta Balbi', x222: 105, z222: 959, len: 95, wid: 95,
    plan: 'cavea c. 95 m; complex c. 1 ha',
    src: 'Sear (2006). The one excavated lived-in quarter on this map',
  },
  {
    id: 'hadrianeum', name: 'Hadrianeum', x222: 185, z222: 798, len: 100, wid: 60,
    plan: 'eleven columns 15 m high, 1.44 m dia.; precinct [?]',
    src: 'Standing today. Precinct dimension UNVERIFIED — measure off the Kiepert metric bar before use',
  },
];

if (argv.includes('--table')) {
  const P = projector(KX, KZ_PICK);
  const A = projector(KX, 0.222);
  const placedOff = new Set(
    reserve(MERGED, KZ_PICK, 0.65, 1.45)
      .filter((b) => !b.onMap)
      .map((b) => b.id)
  );
  // A merged row's absence stands for each of its parts.
  const offParts = new Set();
  for (const id of placedOff) {
    const mg = MERGES.find((m) => m.id === id);
    if (mg) for (const p of mg.absorbs) offParts.add(p);
    else offParts.add(id);
  }
  say('\n| feature | e | n | x | z | real plan, m | source |');
  say('|---|---:|---:|---:|---:|---|---|');
  for (const p of CIRCUIT) {
    const w = P.of(p.e, p.n);
    say(
      `| circuit: ${p.id} | ${p.e} | ${p.n} | **${w.x.toFixed(0)}** | **${w.z.toFixed(0)}** | — ` +
        '| ROME_CIRCUIT_SURVEY; Lanciani georef |'
    );
  }
  say('');
  say('| monument | e | n | x | z | real plan, m | source |');
  say('|---|---:|---:|---:|---:|---|---|');
  for (const r of ROME) {
    const w = P.of(r.e, r.n);
    const off = offParts.has(r.id) ? ' [OFF MAP]' : '';
    say(
      `| ${r.name}${off} | ${r.e} | ${r.n} | **${w.x.toFixed(0)}** | **${w.z.toFixed(0)}** ` +
        `| ${r.len} x ${r.wid}${r.axis === 'z' ? ' (long axis z)' : ''}, bearing ${r.bearing} deg ` +
        '| survey.ts cite |'
    );
  }
  say('');
  say('| missing monument | pub x@0.222 | z@0.222 | rec. e | rec. n | x | z | real plan, m | source |');
  say('|---|---:|---:|---:|---:|---:|---:|---|---|');
  for (const m of MISSING) {
    const e = (m.x222 - A.X0) / KX;
    const n = (A.Z0 - m.z222) / 0.222;
    const w = P.of(e, n);
    say(
      `| ${m.name} | ${m.x222} | ${m.z222} | ${e.toFixed(0)} | ${n.toFixed(0)} ` +
        `| **${w.x.toFixed(0)}** | **${w.z.toFixed(0)}** | ${m.plan} | ${m.src} |`
    );
  }
  report.table = {
    missing: MISSING.map((m) => {
      const e = (m.x222 - A.X0) / KX;
      const n = (A.Z0 - m.z222) / 0.222;
      return { ...m, e: +e.toFixed(1), n: +n.toFixed(1), ...P.of(e, n) };
    }),
  };
}
