/**
 * rome-landmarks — the Phase 2 instrument: merges, authored footprints, and the floor.
 *
 * `tools/scratch/rome-frame.mjs` settled the *frame* (Phase 0/1) and proposed the merges and
 * the authored-footprint floor on paper. This grades the **authored file**: it reads whatever
 * `src/city/rome/survey.ts` actually says and reports what that layout does, with every
 * monument frozen at `worldOf(e, n)` — no resolver, by construction.
 *
 * Three questions, three modes.
 *
 *  `--realgaps`   Which survey rows are **physically continuous built fabric**? Measured on
 *                 the published plan at the published bearing in **real metres**, with no
 *                 projection, no `PRECINCT` and no plan scale involved. A pair whose real
 *                 footprints interpenetrate is not two buildings with a street between them;
 *                 it is one complex the survey has modelled as two boxes, and merging it is a
 *                 *correction*. This is the merge evidence, and it is arithmetic from
 *                 published dimensions rather than an appeal to taste.
 *
 *  `--floorsweep` With the merges applied, how high can the authored footprint floor go before
 *                 a pair conflicts? Reproduces and extends `ROME-FABRIC.md` §7.8's table.
 *
 *  `--audit`      Read each row's authored `draw` scale out of `survey.ts` and report the
 *                 conflicts, the minimum clear gap, and every departure from 1.00 beside the
 *                 real published dimension it departs from. This is the mode that grades the
 *                 shipped file, so it is the one that must stay green.
 *
 * Pure node. The projection and the box arithmetic are **re-implemented from their own
 * inputs** rather than imported, for `rome-frame.mjs`'s stated reason: an instrument that
 * imports the thing it grades can only restate it. The survey is text-parsed under the same
 * strict discipline — a row this cannot read is a fault, not a skip.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit === undefined ? d : hit.slice(k.length + 3);
};

// ---------------------------------------------------------------------------
// The projection, re-derived (see rome-frame.mjs's header for why it is not imported)
// ---------------------------------------------------------------------------

const HALF_EXTENT = 1400;
const CITY_Z_MAX = HALF_EXTENT - 26;
const roadCentreX = (z) => 20 + 34 * Math.sin((z + 300) * 0.0018519) - 18 * Math.sin((z + 900) * 0.0033333);
const riseToeZ = (x) => 330 + 52 * Math.sin(x * 0.00476) + 26 * Math.sin(x * 0.01053 + 2.1);
const crestZAt = (x) => riseToeZ(x) + 175;
const GATE_X = (() => {
  let x = 20;
  for (let i = 0; i < 6; i++) x = roadCentreX(crestZAt(x));
  return Math.round(x * 10) / 10;
})();
const GATE_Z = crestZAt(GATE_X);
const PF_E = -497;
const PF_N = 2045;
const KX = 0.443;
const KZ = +arg('kz', '0.35');
const X0 = GATE_X - KX * PF_E;
const Z0 = GATE_Z + KZ * PF_N;
const worldOf = (e, n) => ({ x: X0 + KX * e, z: Z0 - KZ * n });

const PRECINCT = 1.07;
const STREET_GAP = 7;

// ---------------------------------------------------------------------------
// The survey, text-parsed
// ---------------------------------------------------------------------------

const SURVEY_SRC = readFileSync(resolve(ROOT, 'src/city/rome/survey.ts'), 'utf8');

function parseSurvey(src) {
  const start = src.indexOf('export const ROME: readonly RomeMonument[] = [');
  if (start < 0) throw new Error('rome-landmarks: could not find the ROME table');
  const end = src.indexOf('\n];', start);
  const body = src.slice(start, end);
  const marks = [];
  const idRe = /^ {4}id: '([^']+)',$/gm;
  let im;
  while ((im = idRe.exec(body)) !== null) marks.push({ id: im[1], at: im.index });
  const rows = [];
  for (let k = 0; k < marks.length; k++) {
    const chunk = body.slice(marks[k].at, k + 1 < marks.length ? marks[k + 1].at : body.length);
    const geom = /\n\s*e: (-?[\d.]+), n: (-?[\d.]+), len: (-?[\d.]+), wid: (-?[\d.]+), bearing: (-?[\d.]+),/.exec(chunk);
    if (!geom) throw new Error(`rome-landmarks: row ${marks[k].id} has no e/n/len/wid/bearing line`);
    const nameM = /\n\s*name: (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(chunk);
    const citeAt = chunk.indexOf('cite:');
    const flags = chunk.slice(geom.index, citeAt < 0 ? chunk.length : citeAt);
    const drawM = /\bdraw: ([\d.]+)/.exec(flags);
    rows.push({
      id: marks[k].id,
      name: (nameM ? (nameM[1] ?? nameM[2]) : marks[k].id).replace(/\\'/g, "'"),
      e: +geom[1], n: +geom[2], len: +geom[3], wid: +geom[4], bearing: +geom[5],
      axis: /axis: 'z'/.test(flags) ? 'z' : 'x',
      soft: /\bsoft: true/.test(flags),
      farBank: /\bfarBank: true/.test(flags),
      onRiver: /\bonRiver: true/.test(flags),
      offMapEast: /\boffMapEast: true/.test(flags),
      atWall: +((/\batWall: ([\d.]+)/.exec(flags) ?? [])[1] ?? 0),
      drawMax: +((/\bdrawMax: ([\d.]+)/.exec(flags) ?? [])[1] ?? 1),
      draw: drawM ? +drawM[1] : null,
      complex: (/\bcomplex: '([^']+)'/.exec(flags) ?? [])[1] ?? null,
    });
  }
  const declared = (body.match(/^ {4}id: '/gm) || []).length;
  if (rows.length !== declared) {
    throw new Error(`rome-landmarks: parsed ${rows.length} rows but the table declares ${declared}`);
  }
  return rows;
}

const ROME = parseSurvey(SURVEY_SRC);

// ---------------------------------------------------------------------------
// Oriented-box arithmetic
// ---------------------------------------------------------------------------

const boxAxes = (rot) => [
  [Math.cos(rot), -Math.sin(rot)],
  [Math.sin(rot), Math.cos(rot)],
];

function satGap(a, b) {
  const axes = [...boxAxes(a.rot), ...boxAxes(b.rot)];
  let best = -Infinity;
  for (const [ux, uz] of axes) {
    const proj = (r) => {
      const [ax, az] = boxAxes(r.rot)[0];
      const [bx, bz] = boxAxes(r.rot)[1];
      return Math.abs(r.hw * (ax * ux + az * uz)) + Math.abs(r.hd * (bx * ux + bz * uz));
    };
    best = Math.max(best, Math.abs((b.x - a.x) * ux + (b.z - a.z) * uz) - proj(a) - proj(b));
  }
  return best;
}

/**
 * **The real city, in real metres.** A published plan at its published bearing, in the survey
 * frame, with the *north* axis playing the part of world +Z. No projection is applied, so this
 * says what the buildings did on the ground and nothing about the game.
 *
 * The bearing convention is the survey's: degrees clockwise from north for the long axis
 * (`axis: 'x'`), or the direction faced standing at the front looking in (`axis: 'z'`), which
 * is the same line. In an (east, north) frame a bearing `b` points along `(sin b, cos b)`, and
 * `len` always runs along it.
 */
function realBox(r) {
  const th = (r.bearing * Math.PI) / 180;
  const long = { e: Math.sin(th), n: Math.cos(th) };
  // Express in an (x = e, z = -n) frame so `satGap` can be reused unchanged: the engine's
  // rotation maps local +X to (cos rot, -sin rot), so rot = atan2(-long.n, long.e).
  // In the (x = e, z = -n) frame the long axis points at (long.e, -long.n), and `boxAxes`
  // returns (cos rot, -sin rot) for the first axis — so `rot = atan2(long.n, long.e)`.
  // **The sign here is load-bearing and was wrong once.** `atan2(-long.n, long.e)` mirrors
  // every box in n, which is invisible on an axis-aligned building and silently inverts the
  // geometry of every rotated one: it reported the Basilica Ulpia and Trajan's Column
  // interpenetrating by 27.3 m when they are 8.2 m apart. Checked against a hand-computed
  // separation before this table was trusted, and that check is why the number is right.
  const rot = Math.atan2(long.n, long.e);
  return { id: r.id, name: r.name, x: r.e, z: -r.n, rot, hw: r.len * 0.5, hd: r.wid * 0.5 };
}

const say = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// --realgaps: the merge evidence
// ---------------------------------------------------------------------------

if (argv.includes('--realgaps')) {
  say('\n=== the real city: published plans at published bearings, in REAL metres ===');
  say('No projection, no PRECINCT, no plan scale. A negative gap means the two published');
  say('footprints interpenetrate on the ground, so the survey models one complex as two boxes.');
  say('');
  const boxes = ROME.map(realBox);
  const pairs = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const g = satGap(boxes[i], boxes[j]);
      if (g < 60) pairs.push({ a: boxes[i], b: boxes[j], gap: g });
    }
  }
  pairs.sort((p, q) => p.gap - q.gap);
  say('  real gap |         | a                              | b');
  say('  ---------+---------+--------------------------------+--------------------------------');
  for (const p of pairs) {
    const tag = p.gap < 0 ? 'OVERLAP' : p.gap < 12 ? 'abuts  ' : '       ';
    say(`  ${p.gap.toFixed(1).padStart(7)}m | ${tag} | ${p.a.name.padEnd(30)} | ${p.b.name}`);
  }
  say(`\n  ${pairs.filter((p) => p.gap < 0).length} pairs interpenetrate in real metres`);
  say(`  ${pairs.filter((p) => p.gap >= 0 && p.gap < 12).length} more are closer than a 12 m street`);
}

// ---------------------------------------------------------------------------
// The world layout, frozen — and the floor sweep
// ---------------------------------------------------------------------------

/**
 * `survey.ts:worldRot`. The old fitted `ROT_RATIO` is gone; this is `worldOf`'s linear part
 * applied to a direction vector, which is what a bearing correction is.
 */
const worldRot = (bearingDeg, axis) => {
  const th = (bearingDeg * Math.PI) / 180;
  const dx = KX * Math.sin(th);
  const dz = -KZ * Math.cos(th);
  return axis === 'x' ? -Math.atan2(dz, dx) : Math.atan2(dx, dz);
};

/**
 * **Party walls, not streets: what a merge actually licenses.**
 *
 * `ROME-FABRIC.md` §4.5 proposes merging five nested complexes by replacing each set of rows
 * with one box carrying the merged precinct's published dimension. That buys room, and it costs
 * three things this phase cannot pay: the Pantheon's dome, the Temple of Jupiter's podium and
 * the Theatre of Marcellus's cavea all stop being drawn, because `monuments.ts` dispatches its
 * builders on the row id; and `probe-fabric`'s G11 gates twelve hardcoded ids, four of which
 * are absorbed by those five merges, so the merge would fail the gate it is meant to pass.
 *
 * So a merge here is a **declaration about the ground between two rows, not a replacement of
 * them.** Rows carrying the same `complex` keep their own id, builder, bearing and published
 * dimension, and what changes is the clearance the layout owes between them: `PARTY_GAP`
 * instead of `STREET_GAP`. That is the historically true statement — the Basilica Ulpia does
 * not stand across a street from Trajan's Forum, it stands *in* it — and it is the whole of
 * what §4.5 was reaching for, because the 7 m street between nested structures is the entire
 * reason the projection cannot host them.
 */
const PARTY_GAP = 0.35;

/**
 * **How deep two structures in one complex may interpenetrate before it is a fault.**
 *
 * Not an allowance invented here: it is `probe-fabric.mjs`'s own `ABUT_DEPTH_M = 2.5`, the depth
 * below which the gate classes an intersection as a joint in one structure rather than two
 * buildings inside each other. Sitting just inside it means a licensed abutment is licensed by
 * the external instrument too, rather than only by this file's opinion of itself.
 *
 * It is needed because several of Rome's monuments are **round buildings modelled as
 * rectangles**, and a rectangle's corners are empty. The Theatre of Marcellus is a 129.8 m
 * circle; the Porticus Octaviae's south range stands tangent to it; their two *rectangles*
 * therefore overlap at the corner while the two *buildings* have a street between them. The
 * same is true of the Colosseum's ellipse and the Ludus Magnus. Forcing those corners apart
 * would shrink two correct buildings to fix an artefact of the collision primitive.
 */
const ABUT_DEPTH = +arg('abut', '2.4');

/**
 * The complexes, **read out of `survey.ts` rather than restated here.**
 *
 * This is the one place the instrument deliberately does not duplicate its subject. Everywhere
 * else — the projection, the box arithmetic, the georeference — a restatement is what lets this
 * file call the source wrong. A complex is not like that: it is not a derived quantity that can
 * be independently computed, it is an authored claim about the city, and the only useful thing
 * to do with it is check what it implies. A second copy here could only ever disagree with the
 * source by going stale, and then this file would grade a set of merges nobody shipped.
 *
 * The claim itself is checkable, and `--realgaps` is where it is checked: every complex must be
 * a set whose published plans interpenetrate or abut **in real metres, with no projection
 * involved**. That test does not read `complex` at all.
 */
const COMPLEX = Object.fromEntries(ROME.filter((r) => r.complex).map((r) => [r.id, r.complex]));

const CITY_Z_MAX_ = HALF_EXTENT - 26;

/** Rows the +Z edge takes off this map. The centre test — see `reserve`'s `onMap` for why. */
const offMap = (r) => !r.farBank && !r.onRiver && worldOf(r.e, r.n).z > CITY_Z_MAX_;

const complexOf = (id) => COMPLEX[id] ?? null;
const sameComplex = (a, b) => {
  const ca = complexOf(a);
  return ca !== null && ca === complexOf(b);
};

/** Reserve every masonry monument at exactly `worldOf(e, n)`. No resolver, by construction. */
function reserve(rows, scaleOf) {
  return rows
    .filter((r) => !r.soft)
    .map((r) => {
      const w = worldOf(r.e, r.n);
      const alongZ = r.axis === 'z';
      const s = scaleOf(r);
      const hw = (alongZ ? r.wid : r.len) * 0.5 * PRECINCT * s;
      const hd = (alongZ ? r.len : r.wid) * 0.5 * PRECINCT * s;
      return {
        id: r.id,
        name: r.name,
        x: w.x,
        z: w.z,
        rot: worldRot(r.bearing, r.axis),
        hw,
        hd,
        scale: s,
        real: { len: r.len, wid: r.wid },
        /**
         * **Membership is the centre, and the edge is a separate constraint on `draw`.**
         *
         * `rome-frame.mjs` tested the footprint — `w.z + hd <= HALF_EXTENT` — and that was right
         * while every monument shared one plan scale. With `draw` authored per row it becomes
         * circular: membership would depend on a footprint that is chosen after membership, so a
         * monument could be deleted from the map for the crime of being drawn at its real size.
         *
         * The centre test has no such loop, and at `KZ` = 0.35 it returns **exactly** the same
         * five monuments the owner agreed to lose — Palatine, Circus Maximus, Aventine, Baths of
         * Caracalla, Caelian. (It disagrees with the footprint test at `KZ` 0.30 and 0.38, per
         * ROME-FABRIC.md 7.7 item 2, which is why the two are recorded as different tests rather
         * than as one test with a tolerance.)
         *
         * What the footprint test was really protecting against — a building hanging over the
         * edge of the ground — is now `edgeReach` below, measured on the **true oriented box**
         * instead of the local half-depth.
         */
        onMap: w.z <= CITY_Z_MAX,
        /**
         * How far south the drawn footprint actually reaches, in world metres.
         *
         * `|hw·sin(rot)| + |hd·cos(rot)|` — the box's extent along world +Z, which for a rotated
         * monument is not its half-depth. The Colosseum is 189 × 156 turned 115°, so its true
         * reach is 1.42x its local half-depth, and at the old uniform 0.65 its south corner stood
         * at z 1412 against a heightfield that stops at 1400.
         */
        edgeReach: w.z + Math.abs(hw * Math.sin(worldRot(r.bearing, r.axis))) +
          Math.abs(hd * Math.cos(worldRot(r.bearing, r.axis))),
        /** The northernmost world z the drawn footprint reaches. */
        northReach: w.z - Math.abs(hw * Math.sin(worldRot(r.bearing, r.axis))) -
          Math.abs(hd * Math.cos(worldRot(r.bearing, r.axis))),
        atWall: r.atWall,
      };
    });
}

function conflicts(boxes) {
  const on = boxes.filter((b) => b.onMap);
  const out = [];
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const need = sameComplex(on[i].id, on[j].id) ? -ABUT_DEPTH : STREET_GAP;
      const g = satGap(on[i], on[j]);
      if (g < need) out.push({ a: on[i].id, b: on[j].id, gap: g, need });
    }
  }
  return out.sort((p, q) => p.gap - p.need - (q.gap - q.need));
}

/**
 * **Max-min, then raise.** The allocation that decides every monument's authored footprint.
 *
 * `rome-frame.mjs`'s 7.8 solve was greedy: take the worst pair, shrink the larger member by a
 * couple of per cent, repeat. That is the obvious algorithm and it is the wrong one, because the
 * quantity that matters is **the smallest monument on the map**, and a greedy that always charges
 * the larger member drives one row into the ground to spare its neighbour. Run on this survey it
 * settles the Basilica Ulpia at 0.20 — a 130 m basilica drawn 26 m long — while the forum it
 * stands in keeps 0.47, when both could stand at 0.46.
 *
 * So the allocation is done in two passes, and neither is greedy.
 *
 *  1. **Max-min.** Binary-search the largest *uniform* scale at which no pair is short of what it
 *     is owed. Uniform is the fair allocation: it is the largest achievable value of the minimum,
 *     so no row can be raised without pushing another below it. **This number is the authored
 *     floor** and it is the honest headline — every monument on the map is at least this much of
 *     itself.
 *  2. **Raise.** Then, largest real plan first, lift each row as high as it will go without
 *     creating a fault. This cannot lower the floor, since the floor is where everybody starts,
 *     and it recovers full published plan for every monument that is not actually crowded.
 *     Largest first because a big monument is what a player sees from across the Campus Martius.
 *
 * Deterministic: fixed order, fixed bisection count, no randomness.
 */
function faultsAt(rows, scaleOf) {
  const boxes = reserve(rows, scaleOf);
  const on = boxes.filter((b) => b.onMap);
  const out = [];
  // The +Z edge is a constraint on the footprint, not a reason to delete a monument.
  for (const b of on) {
    if (b.edgeReach > HALF_EXTENT) {
      out.push({ a: b.id, b: '+Z edge', gap: HALF_EXTENT - b.edgeReach, need: 0, same: false, short: b.edgeReach - HALF_EXTENT });
    }
  }
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const same = sameComplex(on[i].id, on[j].id);
      const need = same ? -ABUT_DEPTH : STREET_GAP;
      const g = satGap(on[i], on[j]);
      if (g < need) out.push({ a: on[i].id, b: on[j].id, gap: g, need, same, short: need - g });
    }
  }
  return out.sort((p, q) => q.short - p.short);
}

function absorb(rows, seed) {
  const scale = new Map(rows.filter((r) => !r.soft).map((r) => [r.id, seed]));
  const scaleOf = (r) => (r.soft ? 1 : scale.get(r.id));

  let lo = 0.05;
  let hi = seed;
  const setAll = (v) => {
    for (const r of rows) if (!r.soft) scale.set(r.id, Math.min(v, r.drawMax));
  };
  const clears = () => faultsAt(rows, scaleOf).length === 0;
  setAll(hi);
  if (!clears()) {
    for (let k = 0; k < 34; k++) {
      const mid = (lo + hi) * 0.5;
      setAll(mid);
      if (clears()) lo = mid;
      else hi = mid;
    }
  } else {
    lo = hi;
  }
  const floor = Math.floor(lo * 1000) / 1000;
  // What binds the floor? Report the pair that faults just above it, because "the floor is
  // 0.282" is not actionable and "the floor is 0.282 and the Pantheon is what holds it there"
  // is: it names the next thing to correct.
  setAll(floor + 0.006);
  const binding = faultsAt(rows, scaleOf).slice(0, 4);
  setAll(floor);

  /**
   * The raise pass, run **to a fixed point** rather than once.
   *
   * One sweep is order-dependent in a way that matters: a monument raised early takes room its
   * neighbour then cannot have, and a monument raised late is boxed in by neighbours that took
   * theirs first. Repeating until nothing moves removes most of that — a row that could not be
   * raised on pass 1 gets another go once the pass-1 winners have stopped growing — and it
   * terminates because every step is a raise and every raise is bounded by `seed`.
   *
   * The order within a pass is **longest published dimension first**, not largest area. Area
   * favours a 400 m barracks pressed against the map's east edge, where nothing is looking;
   * length favours the buildings that make a skyline. The Colosseum is the case that decided it.
   */
  const order = rows.filter((r) => !r.soft).sort((a, b) => Math.max(b.len, b.wid) - Math.max(a.len, a.wid));
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const r of order) {
      const before = scale.get(r.id);
      const ceiling = Math.min(seed, r.drawMax);
      if (before >= ceiling - 1e-9) continue;
      scale.set(r.id, ceiling);
      if (clears()) {
        moved = true;
        continue;
      }
      let lo2 = before;
      let hi2 = ceiling;
      for (let k = 0; k < 22; k++) {
        const mid = (lo2 + hi2) * 0.5;
        scale.set(r.id, mid);
        if (clears()) lo2 = mid;
        else hi2 = mid;
      }
      const got = Math.floor(lo2 * 1000) / 1000;
      if (got > before + 1e-9) moved = true;
      scale.set(r.id, got);
    }
    if (!moved) break;
  }

  const boxes = reserve(rows, scaleOf);
  const all = faultsAt(rows, scaleOf);
  const on = boxes.filter((b) => b.onMap);
  let minGap = Infinity;
  let minPair = '';
  let worstOwed = Infinity;
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const g = satGap(on[i], on[j]);
      const need = sameComplex(on[i].id, on[j].id) ? -ABUT_DEPTH : STREET_GAP;
      if (g - need < worstOwed) {
        worstOwed = g - need;
        minPair = `${on[i].id} / ${on[j].id}`;
      }
      if (g < minGap) minGap = g;
    }
  }
  return {
    scale,
    floor,
    binding,
    intersecting: all.filter((c) => !c.same),
    abutting: all.filter((c) => c.same),
    minGap,
    minPair,
    worstOwed,
    onMap: on.length,
    boxes,
  };
}

if (argv.includes('--why')) {
  const id = arg('why', 'colosseum');
  const at = +arg('at', '0.6');
  const base = absorb(ROME, 1.0);
  base.scale.set(id, at);
  const scaleOf = (r) => (r.soft ? 1 : base.scale.get(r.id));
  say(`\nwith ${id} at ${at}, holding every other row at its allocated value:`);
  const f = faultsAt(ROME, scaleOf);
  if (!f.length) say('  no faults');
  for (const c of f) say(`  ${c.same ? 'ABUT  ' : 'STREET'} ${c.a} / ${c.b}: gap ${c.gap.toFixed(1)}, short by ${c.short.toFixed(1)}`);
}

if (argv.includes('--floorsweep')) {
  const seed = +arg('seed', '1.0');
  const r = absorb(ROME, seed);
  const complexes = new Set(ROME.filter((q) => q.complex).map((q) => q.complex));
  say('\n=== the authored footprint allocation ===');
  say(`every centre frozen at worldOf(e, n); ${ROME.filter((q) => q.complex).length} rows in ${complexes.size} complexes; seed ${seed}`);
  say(`\n  THE AUTHORED FLOOR: ${r.floor.toFixed(3)} — the largest uniform scale at which no pair is short`);
  say(`  ${r.onMap} on-map masonry rows; ${r.intersecting.length} street faults, ${r.abutting.length} abutment faults`);
  say(`  worst pair: ${r.minPair}, ${r.worstOwed.toFixed(1)} m against what it is owed`);
  say('  what holds the floor there (the pairs that fault just above it):');
  for (const c of r.binding) say(`    ${c.same ? 'ABUT  ' : 'STREET'} ${c.a} / ${c.b}: short by ${c.short.toFixed(1)} m`);
  const full = [...r.scale.values()].filter((sc) => sc >= seed - 1e-9).length;
  say(`  ${full} of ${r.scale.size} rows drawn at FULL published plan`);
  say('\n  row                      | draw  | real plan       | drawn');
  say('  -------------------------+-------+-----------------+----------------');
  for (const q of [...ROME].sort((a, b) => (r.scale.get(a.id) ?? 9) - (r.scale.get(b.id) ?? 9))) {
    const sc = r.scale.get(q.id);
    if (sc === undefined) continue;
    say(
      `  ${q.id.padEnd(24)} | ${sc.toFixed(3)} | ${`${q.len} x ${q.wid} m`.padEnd(15)} | ${(q.len * sc).toFixed(0)} x ${(q.wid * sc).toFixed(0)} m`
    );
  }
  if (r.intersecting.length + r.abutting.length) {
    say('\n  faults:');
    for (const c of [...r.intersecting, ...r.abutting]) {
      say(`    ${c.same ? 'ABUT  ' : 'STREET'} ${c.a.padEnd(20)} / ${c.b.padEnd(20)} gap ${c.gap.toFixed(1)} m, short by ${c.short.toFixed(1)} m`);
    }
  }
}

// ---------------------------------------------------------------------------
// --audit: grade the shipped survey
// ---------------------------------------------------------------------------

/**
 * **The regression instrument for this phase, and the one that has to stay green.**
 *
 * `--floorsweep` *proposes* an allocation; this reads the one `survey.ts` actually ships and
 * reports what it does. The difference matters: the proposal is an argument and the audit is a
 * measurement, and it is the measurement that will catch the next person who nudges a coordinate
 * or adds a row without re-running anything.
 *
 * Exits non-zero on a fault, so it can sit in a pre-merge gate.
 */
if (argv.includes('--audit')) {
  const scaleOf = (r) => (r.soft ? 1 : (r.draw ?? 1));
  const boxes = reserve(ROME, scaleOf);
  const on = boxes.filter((b) => b.onMap);
  const faults = faultsAt(ROME, scaleOf);
  const drawn = ROME.filter((r) => !r.soft && (r.draw ?? 1) < 0.999);
  /**
   * Two different limits, reported apart, because collapsing them into one "floor" hides which
   * lever is binding. **The authored floor** is the smallest scale the *conflict solve* imposed —
   * the answer to "how big can every monument be and still clear its neighbours". A row carrying
   * a `drawMax` is not limited by a neighbour at all: it is limited by the +Z edge or the curtain,
   * which are facts about the frame rather than about crowding, and averaging the two would let a
   * frame problem masquerade as a packing problem.
   */
  const capped = ROME.filter((r) => !r.soft && r.drawMax < 1);
  const floor = Math.min(...ROME.filter((r) => !r.soft && r.drawMax >= 1).map((r) => r.draw ?? 1));
  say('\n=== audit: the survey as shipped ===');
  say(`  ${ROME.length} survey rows, ${on.length} on-map masonry footprints, every centre at worldOf(e, n)`);
  say(`  authored floor as shipped: ${floor.toFixed(3)} (the smallest scale the conflict solve imposed)`);
  for (const r of capped) {
    say(`  capped by the frame, not by a neighbour: ${r.id} at drawMax ${r.drawMax} -> ${(r.len * r.draw).toFixed(0)} x ${(r.wid * r.draw).toFixed(0)} m`);
  }
  say(`  ${ROME.length - drawn.length - ROME.filter((r) => r.soft).length} masonry rows at full published plan, ${drawn.length} with an authored departure`);
  const complexes = new Map();
  for (const r of ROME) if (r.complex) complexes.set(r.complex, [...(complexes.get(r.complex) ?? []), r.id]);
  say(`\n  ${complexes.size} complexes:`);
  for (const [c, ids] of complexes) say(`    ${c.padEnd(18)} ${ids.join(', ')}`);
  say('\n  departures from full published plan:');
  for (const r of [...drawn].sort((a, b) => (a.draw ?? 1) - (b.draw ?? 1))) {
    say(
      `    ${r.id.padEnd(22)} ${(r.draw ?? 1).toFixed(3)}  ${`${r.len} x ${r.wid} m`.padEnd(14)} -> ${(r.len * r.draw).toFixed(0)} x ${(r.wid * r.draw).toFixed(0)} m`
    );
  }
  /**
   * **Inverted spatial relations: the number that outranks metres.**
   *
   * The plan judge's sharpest finding was not that monuments were far from their plate
   * positions — it was that **18 of the 184 relations the plate asserts had flipped**. The
   * Pantheon was no longer north of the Theatre of Pompey; the Baths of Agrippa were no longer
   * west of the Capitol. A monument 200 m off but on the correct side of its neighbour still
   * reads as Rome; one that has swapped sides does not, at any distance.
   *
   * This counts them, and it is worth being precise about what it can and cannot prove.
   * `worldOf` is `x = X0 + KX·e`, `z = Z0 − KZ·n` with `KX`, `KZ` > 0, so it is **strictly
   * monotone in both axes**: it cannot invert a relation. With every centre frozen at
   * `worldOf(e, n)` the count is therefore zero *by construction* and this is a proof, not a
   * measurement — which is exactly why it is worth printing. The eighteen inversions were the
   * resolver's, and nothing else in the placement path can produce one.
   *
   * The rows that could still invert are the ones `worldOf` does not place: `farBank` and
   * `onRiver` take their x from the terrain's channel. Those are counted separately and are the
   * only rows where this can ever be non-zero again — which makes it the check to watch while
   * the Tiber is being re-surveyed.
   */
  const DEADBAND = 12;
  let inverted = 0;
  let riverInverted = 0;
  let relations = 0;
  const placed = ROME.filter((r) => !offMap(r));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const wa = worldOf(a.e, a.n);
      const wb = worldOf(b.e, b.n);
      const river = a.farBank || a.onRiver || b.farBank || b.onRiver;
      if (Math.abs(a.e - b.e) > DEADBAND) {
        relations++;
        if (Math.sign(a.e - b.e) !== Math.sign(wa.x - wb.x)) river ? riverInverted++ : inverted++;
      }
      if (Math.abs(a.n - b.n) > DEADBAND) {
        relations++;
        if (Math.sign(a.n - b.n) !== -Math.sign(wa.z - wb.z)) river ? riverInverted++ : inverted++;
      }
    }
  }
  say(`\n  spatial relations the survey asserts between placed rows: ${relations}`);
  say(`  inverted by the placement: ${inverted}  (river-placed rows, counted apart: ${riverInverted})`);

  let minGap = Infinity;
  let minPair = '';
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const g = satGap(on[i], on[j]);
      if (g < minGap && !sameComplex(on[i].id, on[j].id)) {
        minGap = g;
        minPair = `${on[i].id} / ${on[j].id}`;
      }
    }
  }
  say(`\n  minimum clear gap between monuments in different complexes: ${minGap.toFixed(1)} m (${minPair})`);
  say(`  target: >= ${STREET_GAP} m`);
  if (faults.length) {
    say(`\n  ${faults.length} FAULT(S):`);
    for (const c of faults) {
      say(`    ${c.same ? 'ABUT  ' : 'STREET'} ${c.a} / ${c.b}: gap ${c.gap.toFixed(1)} m, short by ${c.short.toFixed(1)} m`);
    }
    process.exitCode = 1;
  } else {
    say('\n  PASS — every pair meets what it is owed, with nothing moved from its surveyed position.');
  }
}

// ---------------------------------------------------------------------------
// --plate: the georeferenced Lanciani plate, cropped in survey metres
// ---------------------------------------------------------------------------

/**
 * `src/city/overlay.ts:LANCIANI_1901`, restated rather than imported — the same reason
 * `tools/scratch/rome-plate-overlay.mjs` restates it: this is an instrument and `overlay.ts`
 * is one of the things it grades. If the affine in the source drifts, this measures it as
 * wrong instead of measuring it as itself.
 *
 * Unlike `rome-plate-overlay.mjs` this mode needs **no browser and no dev server**: it draws
 * the survey's own published plans, which are text, onto the plate, which is a raster. That
 * makes it fast enough to iterate a position or a bearing against the plate in seconds, which
 * is what authoring thirty-odd rows against a plate actually requires.
 */
const LANCIANI = {
  file: 'reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png',
  widthPx: 4096,
  heightPx: 2734,
  ex: 1.70846149, ey: 0.05015993, e0: -3538.9517,
  nx: 0.05027504, ny: -1.71190121, n0: 2244.571,
  credit: 'Lanciani, Forma Urbis Romae (1893-1901), georectified by SITAR / SSABAP-RM (CC BY-SA 4.0)',
};

/** Survey metres -> plate pixels: the inverse of `overlay.ts`'s published pixel -> survey. */
const INV = (() => {
  const { ex, ey, nx, ny, e0, n0 } = LANCIANI;
  const det = ex * ny - ey * nx;
  return (e, n) => {
    const de = e - e0;
    const dn = n - n0;
    return { px: (de * ny - ey * dn) / det, py: (ex * dn - de * nx) / det };
  };
})();

const M_PER_PX = Math.hypot(LANCIANI.ex, LANCIANI.nx);

if (argv.includes('--plate')) {
  const sharp = (await import('sharp')).default;
  const { existsSync, mkdirSync } = await import('node:fs');
  // The AGEA 2012 orthophoto is pixel-registered to the same affine (`overlay.ts` gives both
  // plans identical coefficients), so `--aerial` is the control on the plate itself: the
  // Pantheon, the Mausoleum of Augustus and the Colosseum are all still standing, so if the
  // photograph and the plate disagree about where they are, the disagreement is Lanciani's.
  const AERIAL = 'reference/rome-plans/agea-2012-ortofoto-EPSG3004-2307658_4638583_2314671_4643263-4096px.jpg';
  const plate = resolve(ROOT, argv.includes('--aerial') ? AERIAL : LANCIANI.file);
  if (!existsSync(plate)) {
    console.error(`no plate at ${plate}. reference/ is gitignored; symlink it into the worktree.`);
    process.exit(2);
  }
  const bx = { e0: +arg('e0', '-1800'), e1: +arg('e1', '2500'), n0: +arg('n0', '-1600'), n1: +arg('n1', '2150') };
  const zoom = +arg('zoom', '1');
  const only = arg('only', '');
  const ids = only ? new Set(only.split(',')) : null;
  const cs = [INV(bx.e0, bx.n0), INV(bx.e0, bx.n1), INV(bx.e1, bx.n0), INV(bx.e1, bx.n1)];
  const x0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c.px))));
  const y0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c.py))));
  const x1 = Math.min(LANCIANI.widthPx, Math.ceil(Math.max(...cs.map((c) => c.px))));
  const y1 = Math.min(LANCIANI.heightPx, Math.ceil(Math.max(...cs.map((c) => c.py))));
  const cw = x1 - x0;
  const ch = y1 - y0;
  const P = (e, n) => {
    const p = INV(e, n);
    return { x: (p.px - x0) * zoom, y: (p.py - y0) * zoom };
  };
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(cw * zoom)}" height="${Math.round(ch * zoom)}">`];
  const line = (a, b, stroke, w, dash) =>
    parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
  const text = (p, s, fill, size) =>
    parts.push(`<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" fill="${fill}" font-family="Helvetica,Arial" font-size="${size.toFixed(1)}" font-weight="bold" paint-order="stroke" stroke="#fff" stroke-width="${(size / 4).toFixed(1)}">${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
  const G = +arg('grid', '200');
  for (let e = Math.ceil(bx.e0 / G) * G; e <= bx.e1; e += G) {
    line(P(e, bx.n0), P(e, bx.n1), '#0aa', 0.7, '5 8');
    text(P(e, bx.n1 - 14), `e${e}`, '#066', 11 * zoom);
  }
  for (let n = Math.ceil(bx.n0 / G) * G; n <= bx.n1; n += G) {
    line(P(bx.e0, n), P(bx.e1, n), '#0aa', 0.7, '5 8');
    text(P(bx.e0 + 6, n), `n${n}`, '#066', 11 * zoom);
  }
  for (const r of ROME) {
    if (ids && !ids.has(r.id)) continue;
    const th = (r.bearing * Math.PI) / 180;
    const ax = { e: Math.sin(th), n: Math.cos(th) };
    const bv = { e: Math.cos(th), n: -Math.sin(th) };
    const rect = (k) =>
      [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([s, t]) =>
        P(
          r.e + ax.e * r.len * 0.5 * k * s + bv.e * r.wid * 0.5 * k * t,
          r.n + ax.n * r.len * 0.5 * k * s + bv.n * r.wid * 0.5 * k * t
        )
      );
    const col = r.soft ? '#0a0' : '#d00';
    /**
     * Two rectangles per row, and the pair is the point of the picture.
     *
     * **Red** is the monument's real published plan at its real bearing, on its real coordinate.
     * If the red box does not sit on its own inked plan, the survey is wrong about *where the
     * building is*, and that is the fault to fix first — no amount of resizing helps a monument
     * that is in the wrong place.
     *
     * **Blue** is what the game actually draws: `len x wid` scaled by the row's authored `draw`,
     * about the same centre. The gap between the two rectangles is the compression the frame
     * costs, monument by monument, and it is the thing the owner asked to see rather than have
     * implied by a constant. Where there is no blue box, the row is drawn at full plan.
     */
    parts.push(
      `<polygon points="${rect(1).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="${(2 * zoom).toFixed(1)}"/>`
    );
    if (r.draw !== null && r.draw < 0.999) {
      parts.push(
        `<polygon points="${rect(r.draw).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="#04a" fill-opacity="0.20" stroke="#04a" stroke-width="${(1.6 * zoom).toFixed(1)}"/>`
      );
    }
    const pts = rect(1);
    // A tick along the long axis at the +len end, so the bearing is readable, not just the box.
    const head = P(r.e + ax.e * r.len * 0.5, r.n + ax.n * r.len * 0.5);
    const c = P(r.e, r.n);
    line(c, head, col, 1.2 * zoom, '4 4');
    // A crosshair rather than a blob, so the survey's own centre can be read against the
    // grid to a few metres. `--bare` drops the id labels, which at a 25 m grid cover the
    // very ink they are labelling.
    const arm = 7 * zoom;
    line({ x: c.x - arm, y: c.y }, { x: c.x + arm, y: c.y }, col, 1.6 * zoom);
    line({ x: c.x, y: c.y - arm }, { x: c.x, y: c.y + arm }, col, 1.6 * zoom);
    if (!argv.includes('--bare')) text({ x: c.x + 4 * zoom, y: c.y - 4 * zoom }, r.id, col, 12 * zoom);
  }
  const sb = (500 / M_PER_PX) * zoom;
  parts.push(`<rect x="8" y="${(ch * zoom - 36).toFixed(0)}" width="${(sb + 12).toFixed(0)}" height="28" fill="#fff" fill-opacity="0.85"/>`);
  parts.push(`<line x1="14" y1="${(ch * zoom - 14).toFixed(0)}" x2="${(14 + sb).toFixed(0)}" y2="${(ch * zoom - 14).toFixed(0)}" stroke="#000" stroke-width="3"/>`);
  text({ x: 16, y: ch * zoom - 21 }, `500 real m  (${M_PER_PX.toFixed(3)} m/px)`, '#000', 11);
  parts.push('</svg>');
  const out = resolve(ROOT, arg('out', 'screenshots/rome-landmarks/plate.png'));
  mkdirSync(dirname(out), { recursive: true });
  let img = sharp(plate, { limitInputPixels: false }).extract({ left: x0, top: y0, width: cw, height: ch });
  if (zoom !== 1) img = img.resize(Math.round(cw * zoom), Math.round(ch * zoom), { kernel: 'lanczos3' });
  await img.composite([{ input: Buffer.from(parts.join('\n')) }]).png().toFile(out);
  say(`wrote ${out}  ${Math.round(cw * zoom)} x ${Math.round(ch * zoom)}  window e ${bx.e0}..${bx.e1} n ${bx.n0}..${bx.n1}`);
  say(LANCIANI.credit);
}

// ---------------------------------------------------------------------------
// --grain: the plate's own ink orientation, per monument
// ---------------------------------------------------------------------------

/**
 * **Bearings, measured off the plate instead of eyeballed.**
 *
 * Roman monumental building is rectilinear, so the dominant edge direction of the ink inside a
 * monument's footprint *is* that monument's orientation, modulo 90°. This measures it with a
 * structure tensor over the image gradient, which has three properties that matter here:
 *
 *  - it is **translation-invariant**, so it is unaffected by any residual georeference offset
 *    — the one thing a position reading off this plate cannot be trusted about;
 *  - it needs no digitising and no identification, only a window;
 *  - it is a *measurement*, so it can disagree with the survey and be right, which is what
 *    `MAP-METHOD.md` rule 6 asks of an instrument.
 *
 * The tensor is accumulated over gradient vectors, which are **normal** to edges, and the
 * eigenvector of the *smaller* eigenvalue is therefore the dominant edge direction. Angles are
 * doubled before averaging (`J = sum(gx^2 - gy^2, 2 gx gy)`) because an edge direction is
 * defined modulo 180°, and then folded to modulo 90° because a rectangle's two axes are
 * indistinguishable from ink alone — so what this reports is a monument's **grid**, and which
 * of the two axes carries `len` is still a decision the survey has to make.
 *
 * `coh` is the tensor's coherence, `(l1 - l2) / (l1 + l2)`: 1 is a perfectly aligned grid and 0
 * is isotropic noise. **A low-coherence row is not evidence** — it means the window holds no
 * legible rectilinear ink (an empty quarter, a hill, a river) and the survey's own bearing
 * stands. The report prints it so a reader can tell a measurement from a shrug.
 */
if (argv.includes('--grain')) {
  const sharp = (await import('sharp')).default;
  const { existsSync } = await import('node:fs');
  const plate = resolve(ROOT, LANCIANI.file);
  if (!existsSync(plate)) {
    console.error(`no plate at ${plate}. reference/ is gitignored; symlink it into the worktree.`);
    process.exit(2);
  }
  // Greyscale the whole raster once; per-monument windows are then slices of one buffer.
  const { data, info } = await sharp(plate, { limitInputPixels: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const C = info.channels;
  /**
   * **Only the black ink votes.** The Lanciani plate is a two-colour document: black for the
   * ancient remains Lanciani surveyed, red for the nineteenth-century city drawn over them as
   * a locator. The red carries a strong grid of its own — modern Rome's streets — and it is
   * exactly the wrong grid, so a tensor over the whole raster measures Umbertine Rome and
   * calls it Roman. This keeps a pixel only where it is dark AND near-neutral: dark rules out
   * paper, neutral rules out the red wash and the red line work.
   */
  const ink = new Uint8Array(W * H);
  for (let i = 0, p2 = 0; i < W * H; i++, p2 += C) {
    const r = data[p2];
    const g = data[p2 + 1];
    const b = data[p2 + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    ink[i] = mx < 165 && mx - mn < 42 ? 255 - mx : 0;
  }
  const at = (x, y) => ink[y * W + x];
  const only = arg('only', '');
  const ids = only ? new Set(only.split(',')) : null;
  // Pad the window a little: a monument's own precinct wall is part of its grid, and the
  // survey's footprint is sometimes smaller than the ink it is meant to cover.
  const PAD = +arg('pad', '1.0');
  say('\n=== plate ink orientation per monument (structure tensor on the Lanciani raster) ===');
  say('grid = dominant edge direction mod 90 deg. coh = coherence, 0 noise .. 1 a perfect grid.');
  say('A row with coh < 0.15 carries no legible rectilinear ink and is NOT evidence.\n');
  say('  monument                     | survey bearing | plate grid | delta | coh   | px');
  say('  -----------------------------+----------------+------------+-------+-------+------');
  const out = [];
  for (const r of ROME) {
    if (ids && !ids.has(r.id)) continue;
    const half = Math.max(r.len, r.wid) * 0.5 * PAD;
    const cs = [
      INV(r.e - half, r.n - half), INV(r.e - half, r.n + half),
      INV(r.e + half, r.n - half), INV(r.e + half, r.n + half),
    ];
    const x0 = Math.max(1, Math.floor(Math.min(...cs.map((c) => c.px))));
    const y0 = Math.max(1, Math.floor(Math.min(...cs.map((c) => c.py))));
    const x1 = Math.min(W - 2, Math.ceil(Math.max(...cs.map((c) => c.px))));
    const y1 = Math.min(H - 2, Math.ceil(Math.max(...cs.map((c) => c.py))));
    let jxx = 0;
    let jxy = 0;
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // Sobel, on the greyscale. Ink is dark, so the sign is irrelevant to a tensor.
        const gx =
          at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
          at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
        const gy =
          at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
          at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
        const m2 = gx * gx + gy * gy;
        // Only real edges vote. Paper grain and the plate's red wash are below this.
        if (m2 < 3600) continue;
        jxx += gx * gx - gy * gy;
        jxy += 2 * gx * gy;
        n++;
      }
    }
    if (n === 0) {
      say(`  ${r.id.padEnd(28)} | ${String(r.bearing).padStart(14)} |          - |     - |     - | ${n}`);
      continue;
    }
    const mag = Math.hypot(jxx, jxy) / n;
    // Mean gradient energy, for the coherence denominator.
    let energy = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const gx =
          at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
          at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
        const gy =
          at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
          at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
        const m2 = gx * gx + gy * gy;
        if (m2 < 3600) continue;
        energy += m2;
      }
    }
    const coh = energy / n === 0 ? 0 : mag / (energy / n);
    // Gradient direction of maximum variance, in pixel space.
    const gradAng = 0.5 * Math.atan2(jxy, jxx);
    // Edges are normal to gradients: add 90 deg.
    const edgePx = gradAng + Math.PI / 2;
    /**
     * Pixel space is not survey space: the plate's affine carries a 0.0294 shear (EPSG:3004's
     * grid convergence at Rome's longitude) and a y-down axis. Push a unit edge vector through
     * the affine's linear part to get the direction in survey (e, n), then convert to a compass
     * bearing, which is clockwise from north.
     */
    const dpx = Math.cos(edgePx);
    const dpy = Math.sin(edgePx);
    const de = LANCIANI.ex * dpx + LANCIANI.ey * dpy;
    const dn = LANCIANI.nx * dpx + LANCIANI.ny * dpy;
    let grid = (Math.atan2(de, dn) * 180) / Math.PI;
    grid = ((grid % 90) + 90) % 90;
    const surv = ((r.bearing % 90) + 90) % 90;
    // Signed difference on a 90 deg circle.
    let d = grid - surv;
    while (d > 45) d -= 90;
    while (d < -45) d += 90;
    out.push({ id: r.id, bearing: r.bearing, grid, delta: d, coh, n });
    const flag = coh < 0.15 ? ' (no ink)' : Math.abs(d) > 12 ? '  <-- OFF' : '';
    say(
      `  ${r.id.padEnd(28)} | ${String(r.bearing).padStart(14)} | ${grid.toFixed(1).padStart(10)} | ${d.toFixed(1).padStart(5)} | ${coh.toFixed(3)} | ${String(n).padStart(5)}${flag}`
    );
  }
  const solid = out.filter((o) => o.coh >= 0.15);
  const bad = solid.filter((o) => Math.abs(o.delta) > 12);
  say(`\n  ${solid.length} rows carry legible ink; ${bad.length} of them are more than 12 deg off the plate's grid.`);
  if (bad.length) say(`  off: ${bad.map((o) => `${o.id} ${o.delta > 0 ? '+' : ''}${o.delta.toFixed(0)}`).join(', ')}`);
}

export { ROME, worldOf, satGap, realBox, boxAxes, KX, KZ, X0, Z0, HALF_EXTENT, PRECINCT, STREET_GAP, GATE_X, GATE_Z, INV, M_PER_PX, arg, argv, say };
