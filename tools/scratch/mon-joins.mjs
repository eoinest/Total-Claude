#!/usr/bin/env node
/**
 * mon-joins — a complex declaration graded in BOTH frames at once, in about a second.
 *
 * `probe-fabric` G8, G8c and G8d all turn on one relation — is this pair *joined*? — and the
 * two instruments that can answer it disagree by construction, because they ask it in
 * different frames:
 *
 *   - `assertComplexJoined` asks it of the **published plans in real metres**, at the
 *     published bearing, with no projection involved. That is the archaeology.
 *   - `probe-fabric` G8c/G8d ask it of the **world boxes** `buildLandmarks` publishes, which
 *     carry `PRECINCT` and the row's authored `draw`. That is the ground the game collides
 *     with.
 *
 * `MAP-METHOD.md` rule 25 — a measurement in a compressed frame needs both frames, or a
 * sentence saying which one it is. Reported as one number, "the Theatre of Pompey is 17.36 m
 * from its own porticus" sends somebody to move a monument that is already at zero
 * displacement against the plate. Reported as two, it says what it is: **−1.2 m in real
 * metres and +17.36 in world metres**, so the pair is joined in Rome and detached in the
 * projection, and the thing at fault is neither box but the ratio between them.
 *
 * Prints, per declared complex: the real components, the world components, and every pair's
 * gap in both frames. Then the cross-complex pairs under `STREET_GAP`, which is what a
 * narrowing would have to pay for.
 *
 *   node --experimental-strip-types --import ./tools/lib/ts-resolve.mjs \
 *     tools/scratch/mon-joins.mjs [--what-if=id:complex,...]
 *
 * `--what-if` re-declares complexes without editing the survey, so the cost of a narrowing
 * can be read before it is authored. `--what-if=colosseum:,ludus-magnus:` dissolves two rows.
 */
import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';

import process from 'node:process';
import { LANDMARKS, PRECINCT, STREET_GAP } from '../../src/city/rome/layout.ts';
import { ROME } from '../../src/city/rome/survey.ts';
import { ABUT_DEPTH } from '../../src/city/rome/assertions.ts';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit === undefined ? d : hit.slice(k.length + 3);
};
/** The probe's own abutment bound, which is the one G8c and G8d gate on. */
const ABUT = 2.5;
/** `assertions.ts:REAL_STREET` — the width below which two real plans are one building. */
const REAL_STREET = 12;

/**
 * `--draw=id:value,...` — a hypothetical authored plan scale, without editing the survey.
 *
 * The one lever a joint has that is not the monument's centre. A centre is a plate control
 * and moving it moves Rome's pin; `draw` is an authored departure that the survey row already
 * records beside the real dimension it departs from, so it is the cheap side of the trade.
 */
const DRAW_IF = new Map(
  (arg('draw', '') || '')
    .split(',')
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      return [s.slice(0, i), Number(s.slice(i + 1))];
    })
);

const WHAT_IF = new Map(
  (arg('what-if', '') || '')
    .split(',')
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      return [s.slice(0, i), s.slice(i + 1)];
    })
);

/**
 * Separating-axis gap between two oriented rectangles: negative is penetration depth.
 *
 * Written here rather than imported for `probe-fabric`'s stated reason — an instrument that
 * borrows the defendant's arithmetic restates the defendant's answer — and because the two
 * frames need the same ruler or the comparison this file exists for is meaningless.
 *
 * **The handedness is `src/city/layout.ts:axisU`'s and not the textbook's, and the first
 * draft of this file got it wrong.** `makeRotationY(r)` sends local +X to
 * `(cos r, −sin r)` — `MAP-METHOD.md` rule 24 — so a box's long axis points along **−rot**,
 * and writing `(cos, +sin)` mirrors every rotated rectangle about its own centre. That is
 * invisible on an axis-aligned box and silently inverts the rest: it read the Porticus
 * Octaviae 32.6 real metres from the Theatre of Marcellus, which abuts it, and the Basilica
 * Ulpia 27.3 m *inside* Trajan's Column, which stands 8 m off it. `assertions.ts:boxOf`
 * carries the same warning about the same sign, made independently three times now.
 */
function obbGap(a, b) {
  const radius = (o, ax, az) => o.hw * Math.abs(Math.cos(o.rot) * ax - Math.sin(o.rot) * az)
    + o.hd * Math.abs(Math.sin(o.rot) * ax + Math.cos(o.rot) * az);
  const axes = [];
  for (const o of [a, b]) {
    axes.push({ x: Math.cos(o.rot), z: -Math.sin(o.rot) });
    axes.push({ x: Math.sin(o.rot), z: Math.cos(o.rot) });
  }
  let worst = -Infinity;
  for (const ax of axes) {
    const d = Math.abs((b.x - a.x) * ax.x + (b.z - a.z) * ax.z);
    const sep = d - radius(a, ax.x, ax.z) - radius(b, ax.x, ax.z);
    if (sep > worst) worst = sep;
  }
  return worst;
}

/**
 * The world box `buildLandmarks` publishes, divided by PRECINCT so it is the building, with
 * `--draw` applied as a pure rescale about the row's own centre.
 */
const worldBox = (l, drawNow) => {
  const s = drawNow === undefined ? 1 : drawNow / (surveyDraw(l.id) ?? 1);
  return { x: l.x, z: l.z, hw: (l.hw / PRECINCT) * s, hd: (l.hd / PRECINCT) * s, rot: l.rot };
};
/**
 * The published plan at the published bearing, in an `(x = e, z = -n)` frame.
 * `assertions.ts:boxOf`, to the sign, and its comment explains why the sign matters.
 */
const realBox = (m) => {
  const th = (m.bearing * Math.PI) / 180;
  return { x: m.e, z: -m.n, hw: m.len * 0.5, hd: m.wid * 0.5, rot: Math.atan2(Math.cos(th), Math.sin(th)) };
};

const surveyOf = new Map(ROME.map((r) => [r.id, r]));
const surveyDraw = (id) => surveyOf.get(id)?.draw ?? 1;
const drawNowOf = (id) => (DRAW_IF.has(id) ? DRAW_IF.get(id) : surveyDraw(id));
const complexOf = (id) => (WHAT_IF.has(id) ? (WHAT_IF.get(id) || undefined) : surveyOf.get(id)?.complex);

const structs = LANDMARKS.filter((l) => !l.soft);
const rows = structs.map((l) => ({
  id: l.id,
  name: l.name,
  complex: complexOf(l.id),
  world: worldBox(l, drawNowOf(l.id)),
  drawNow: drawNowOf(l.id),
  real: surveyOf.has(l.id) ? realBox(surveyOf.get(l.id)) : null,
}));

const pairs = [];
for (let i = 0; i < rows.length; i++) {
  for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i];
    const b = rows[j];
    pairs.push({
      a, b,
      world: obbGap(a.world, b.world),
      real: a.real && b.real ? obbGap(a.real, b.real) : null,
      same: a.complex !== undefined && a.complex === b.complex,
    });
  }
}

const r2 = (v) => (v === null ? '   -  ' : v.toFixed(2).padStart(7));
const pad = (s, w) => String(s).padEnd(w);

/** Connected components of a member list under a gap predicate. */
function pieces(members, ok) {
  const parent = members.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (!ok(members[i], members[j])) continue;
      parent[find(i)] = find(j);
    }
  }
  const g = new Map();
  for (let i = 0; i < members.length; i++) {
    const r = find(i);
    g.set(r, [...(g.get(r) ?? []), members[i].id]);
  }
  return [...g.values()].sort((a, b) => b.length - a.length);
}

const gapOf = new Map();
for (const p of pairs) {
  gapOf.set(`${p.a.id}|${p.b.id}`, p);
  gapOf.set(`${p.b.id}|${p.a.id}`, p);
}
const look = (a, b) => gapOf.get(`${a.id}|${b.id}`);

const byComplex = new Map();
for (const r of rows) {
  if (r.complex === undefined) continue;
  byComplex.set(r.complex, [...(byComplex.get(r.complex) ?? []), r]);
}

console.log('mon-joins — a declared complex in both frames\n');
console.log(`  real:  published plans, published bearings, REAL metres. One piece at <= ${REAL_STREET} m.`);
console.log(`  world: the boxes buildLandmarks publishes (hw / PRECINCT). One piece at <= ${ABUT} m.`);
console.log(`  ABUT_DEPTH in src is ${ABUT_DEPTH} m; the gate's is ${ABUT} m.\n`);

let realBroken = 0;
let worldBroken = 0;
for (const [id, members] of [...byComplex].sort()) {
  const pr = pieces(members, (a, b) => look(a, b).real !== null && look(a, b).real <= REAL_STREET);
  const pw = pieces(members, (a, b) => look(a, b).world <= ABUT);
  if (pr.length > 1) realBroken++;
  if (pw.length > 1) worldBroken++;
  const verdict = pr.length === 1 && pw.length === 1 ? 'OK'
    : pr.length === 1 ? 'WORLD ONLY — real Rome joins it and the projection does not'
      : pw.length === 1 ? 'REAL ONLY — the projection joins what Rome did not'
        : 'BROKEN IN BOTH — the declaration is wrong about the city';
  console.log(`${pad(id, 20)} ${members.length} rows | real ${pr.length}p, world ${pw.length}p  ->  ${verdict}`);
  console.log(`${' '.repeat(22)}real  [${pr.map((g) => g.join('+')).join(' | ')}]`);
  console.log(`${' '.repeat(22)}world [${pw.map((g) => g.join('+')).join(' | ')}]`);
  const inC = pairs.filter((p) => p.a.complex === id && p.b.complex === id)
    .sort((x, y) => (x.real ?? 1e9) - (y.real ?? 1e9));
  for (const p of inC) {
    const tag = p.real !== null && p.real <= REAL_STREET
      ? (p.world <= ABUT ? '' : '   <-- joined in Rome, detached in the projection')
      : (p.world <= ABUT ? '   <-- joined by the projection only' : '');
    console.log(`${' '.repeat(24)}${pad(`${p.a.id} / ${p.b.id}`, 42)} real ${r2(p.real)}   world ${r2(p.world)}${tag}`);
  }
  console.log('');
}

console.log(`${realBroken} of ${byComplex.size} complexes are in pieces in REAL metres — the declaration is wrong`);
console.log(`${worldBroken} of ${byComplex.size} complexes are in pieces in WORLD metres — G8d's reading\n`);

const cross = pairs.filter((p) => !p.same);
const short = cross.filter((p) => p.world < STREET_GAP).sort((x, y) => x.world - y.world);
console.log(`cross-complex pairs short of the ${STREET_GAP} m street (G8's population): ${short.length} of ${cross.length}`);
for (const p of short) {
  console.log(`   ${pad(`${p.a.id} / ${p.b.id}`, 42)} real ${r2(p.real)}   world ${r2(p.world)}`);
}
const inNoMans = pairs.filter((p) => p.same && p.world > ABUT && p.world < STREET_GAP)
  .sort((x, y) => x.world - y.world);
console.log(`\nin-complex pairs in the (${ABUT}, ${STREET_GAP}) m no-man's-land (G8c's population): ${inNoMans.length}`);
for (const p of inNoMans) {
  console.log(`   ${pad(`${p.a.id} / ${p.b.id}`, 42)} real ${r2(p.real)}   world ${r2(p.world)}`);
}

/**
 * `--solve` — the bill for a narrowing, in the units the survey pays it in.
 *
 * `survey.ts:RomeMonument.complex` says the repair is owed and names its cost: *"narrowing a
 * complex makes its former members owe each other a 7 m projected street, which re-opens the
 * allocation"*. This computes that allocation instead of asserting it is hard. For each pair
 * that a narrowing puts short of `STREET_GAP`, it solves for the `draw` the wider-drawn member
 * would need, holding its centre — because the centre is a plate control and the `draw` is not.
 *
 * The member to shrink is chosen by **how far past the frame it is already spending**, not by
 * which is bigger. `PRECINCT * draw` is the rate at which a row's footprint shrinks; `KX` and
 * `KZ` are the rate at which the ground under it does. A row drawn at more than the frame's own
 * compression along the line to its neighbour is eating that neighbour's street by arithmetic,
 * and it is the one that should give the metre back.
 */
if (argv.includes('--solve')) {
  const KX = 0.443;
  const KZ = 0.35;
  /** `r` is one of `rows`, so its already-divided world box is `r.world`. */
  const boxWith = (r, draw) => {
    const s = draw / r.drawNow;
    return { x: r.world.x, z: r.world.z, hw: r.world.hw * s, hd: r.world.hd * s, rot: r.world.rot };
  };
  const short2 = pairs.filter((p) => !p.same && p.world < STREET_GAP)
    .sort((x, y) => x.world - y.world);
  console.log(`\n=== --solve: ${short2.length} cross-complex pair(s) short of ${STREET_GAP} world metres ===`);
  console.log('The frame spends KX 0.443 east-west and KZ 0.35 north-south; a row spends PRECINCT * draw.\n');
  for (const p of short2) {
    const dx = Math.abs(p.b.world.x - p.a.world.x);
    const dz = Math.abs(p.b.world.z - p.a.world.z);
    const k = dx >= dz ? KX : KZ;
    const rate = (r) => PRECINCT * r.drawNow;
    const over = (r) => rate(r) / k;
    const pick = over(p.a) >= over(p.b) ? p.a : p.b;
    const other = pick === p.a ? p.b : p.a;
    const cur = pick.drawNow;
    // Stepped down rather than bisected: the gap is monotone in `draw` but the survey writes
    // `draw` to three places, so the answer wanted is the largest one on that grid.
    let ans = null;
    for (let d = cur; d > 0.05; d -= 0.0005) {
      if (obbGap(boxWith(pick, d), other.world) >= STREET_GAP + 0.05) { ans = Math.round(d * 1000) / 1000; break; }
    }
    console.log(`   ${pad(`${p.a.id} / ${p.b.id}`, 42)} world ${r2(p.world)} (real ${r2(p.real)}), ${dx >= dz ? 'E-W' : 'N-S'}, frame k=${k}`);
    console.log(`${' '.repeat(6)}${pad(p.a.id, 22)} draw ${p.a.drawNow.toFixed(3)}  spends ${rate(p.a).toFixed(3)} = ${over(p.a).toFixed(2)}x the frame`);
    console.log(`${' '.repeat(6)}${pad(p.b.id, 22)} draw ${p.b.drawNow.toFixed(3)}  spends ${rate(p.b).toFixed(3)} = ${over(p.b).toFixed(2)}x the frame`);
    console.log(`${' '.repeat(6)}-> shrink ${pick.id} from ${cur.toFixed(3)} to ${ans === null ? 'NO SOLUTION' : ans.toFixed(3)}`);
  }
}

/**
 * The pairs real Rome joins and the projection does not, over the WHOLE survey rather than
 * only inside a declaration — because a complex that was never declared cannot be reported
 * as broken, and rule 16 says an absent population has to be printed too.
 */
const realJoinedAll = pairs.filter((p) => p.real !== null && p.real <= REAL_STREET)
  .sort((x, y) => x.real - y.real);
console.log(`\nEVERY pair Rome joins at <= ${REAL_STREET} real metres, declared or not: ${realJoinedAll.length}`);
for (const p of realJoinedAll) {
  console.log(`   ${pad(`${p.a.id} / ${p.b.id}`, 42)} real ${r2(p.real)}   world ${r2(p.world)}`
    + `   ${p.same ? `declared ${p.a.complex}` : 'NOT DECLARED'}`);
}
