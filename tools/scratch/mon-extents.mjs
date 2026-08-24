#!/usr/bin/env node
/**
 * mon-extents — every monument's DRAWN stone against the box the game collides with,
 * outside the browser, in about a second.
 *
 * `probe-fabric` G12, G13a and G14 are the gate and this is not it. This is the fast
 * instrument `MAP-METHOD.md` rule 29 asks for: it imports the shipped `buildLandmarks()`
 * and the shipped `LANDMARKS`, runs the real geometry builders into a real `Batch`, and
 * reports, per monument:
 *
 *   - the reserved collision box, exactly as `buildLandmarks` publishes it (`hw/PRECINCT`);
 *   - the drawn extents in the monument's own frame, from the vertices that will be
 *     rasterised;
 *   - the ratio of the two, on the long and the short axis, which is G14's quantity;
 *   - the drawn long dimension over the row's published `len`, which is G13a's quantity;
 *   - the drawn aspect against the published aspect, which is G12's quantity.
 *
 * **Attribution is exact, not by radius.** `buildLandmarks` calls `batch.setUvOrigin(m.x,
 * 0, m.z)` immediately before each `buildLandmark`, so the vertices a monument emits are
 * exactly the ones pushed between two of those calls. This wraps `setUvOrigin` and records
 * a per-stream watermark at each one. `probe-fabric` cannot do that — it reads a baked
 * scene where the call boundaries are gone, so it attributes by nearest centre inside 1.6x
 * the reach — and the two numbers agreeing is therefore worth something. Where they
 * disagree, the probe is the gate and this says which monument's stone the probe gave to
 * somebody else.
 *
 *   node --experimental-strip-types --import ./tools/lib/ts-resolve.mjs \
 *     tools/scratch/mon-extents.mjs [--json=path] [--only=id,id]
 */
// Primed in dependency order; `src/city/rome` has cycles Node's evaluation order does not
// tolerate. Same preamble as `rome-blockcheck.mjs`, and for the same reason.
import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';

import fs from 'node:fs';
import process from 'node:process';
import { Batch } from '../../src/city/build.ts';
import { buildLandmarks } from '../../src/city/rome/monuments.ts';
import { LANDMARKS, PRECINCT } from '../../src/city/rome/layout.ts';
import { ROME } from '../../src/city/rome/survey.ts';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit === undefined ? d : hit.slice(k.length + 3);
};
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const JSON_OUT = arg('json', '');

/**
 * The terrain, stubbed FLAT, and that is a deliberate limitation rather than an oversight.
 *
 * These builders take `heightAt` only to found themselves on the ground — the substructure
 * plinth, the mound, the Castra's crest solve. A flat ground therefore changes a monument's
 * Y and its plinth depth and leaves its PLAN alone, which is the only thing measured here.
 * The one row this is wrong for is `castra-praetoria`, whose `buildCastra` reads the crest,
 * and its plan is still set by `(m.hw * 2) / PRECINCT`. Anything Y is reported as `yMax`
 * and is not graded.
 */
const FLAT = 8;
const heightAt = () => FLAT;

// A `CityMaterials` stand-in. `Batch` needs `worldSize` for the UV scale, which does not
// move a vertex, and `get` only when baking meshes, which this never does.
const mats = { worldSize: () => 4, get: () => undefined };

const batch = new Batch(mats, undefined, false);

/**
 * The watermark trick. `streams` and `pos`/`vCount` are TypeScript-private, which is a
 * compile-time claim only; at runtime they are ordinary fields, and reading them here is
 * cheaper and far more exact than re-deriving attribution from geometry.
 */
const streamsOf = () => batch.streams;
const marks = [];
const realSetUvOrigin = batch.setUvOrigin.bind(batch);
batch.setUvOrigin = (x, y, z) => {
  const at = new Map();
  for (const [k, st] of streamsOf()) at.set(k, st.vertexCount);
  marks.push({ x, z, at });
  realSetUvOrigin(x, y, z);
};

const out = buildLandmarks(heightAt, 'rome');
// Only the monument bands. `aqueducts`, `road-tombs` and `far-hills` set one origin each
// and are not monuments; they are built anyway so the marker sequence is the real one.
const monChunks = out.chunks.filter((c) => /^monuments-/.test(c.name));
const others = out.chunks.filter((c) => !/^monuments-/.test(c.name));

/**
 * Rebuild the member order exactly as `buildLandmarks` does, so marker k is landmark k.
 * Derived from `LANDMARKS` and the chunk's own centre rather than assumed: if the banding
 * ever changes shape this throws instead of silently mis-attributing.
 */
for (const c of monChunks) c.build(batch, 2);
const monMarks = marks.slice();
/**
 * The last monument's END watermark, taken HERE and not after the other chunks.
 *
 * Taken at the end of the run it swept `aqueducts`, `road-tombs` and `far-hills` into
 * whichever landmark the last band visited last, and reported the Janiculum 6,799 m across.
 * A range measured to "the end of the array" is a range with no upper bound; this is the
 * bound. The other chunks are built afterwards anyway, so that a stream this needs is not
 * created for the first time by one of them.
 */
const endAt = new Map();
for (const [k, st] of streamsOf()) endAt.set(k, st.vertexCount);
for (const c of others) c.build(batch, 2);

// Every landmark, in the order the bands visit them, matched to its marker by position.
const zs = LANDMARKS.map((l) => l.z).sort((a, b) => a - b);
const q = (t) => zs[Math.min(zs.length - 1, Math.floor(t * zs.length))];
const bands = [
  { name: 'monuments-a', from: -1e9, to: q(0.5) },
  { name: 'monuments-c', from: q(0.5), to: q(0.75) },
  { name: 'monuments-d', from: q(0.75), to: 1e9 },
];
const visited = [];
for (const b of bands) for (const l of LANDMARKS) if (l.z >= b.from && l.z < b.to) visited.push(l);

if (visited.length !== monMarks.length) {
  throw new Error(`mon-extents: ${visited.length} landmarks but ${monMarks.length} monument markers — the banding changed shape`);
}
for (let i = 0; i < visited.length; i++) {
  if (Math.abs(visited[i].x - monMarks[i].x) > 1e-6 || Math.abs(visited[i].z - monMarks[i].z) > 1e-6) {
    throw new Error(`mon-extents: marker ${i} is at (${monMarks[i].x}, ${monMarks[i].z}) and landmark ${visited[i].id} is at (${visited[i].x}, ${visited[i].z})`);
  }
}

// The published survey row, by id, for the ratios that need a real dimension.
const SURVEY = new Map(ROME.map((r) => [r.id, r]));

const rows = [];
for (let i = 0; i < visited.length; i++) {
  const l = visited[i];
  if (ONLY.length && !ONLY.includes(l.id)) continue;
  const from = monMarks[i].at;
  const to = i + 1 < monMarks.length ? monMarks[i + 1].at : endAt;
  const cs = Math.cos(l.rot);
  const sn = Math.sin(l.rot);
  const us = [];
  const vs = [];
  let yMax = -Infinity;
  let yMin = Infinity;
  let n = 0;
  for (const [k, st] of streamsOf()) {
    const a = from.get(k) ?? 0;
    const b = to.get(k) ?? st.vertexCount;
    const pos = st.pos;
    for (let vi = a; vi < b; vi++) {
      const x = pos[vi * 3];
      const y = pos[vi * 3 + 1];
      const z = pos[vi * 3 + 2];
      const dx = x - l.x;
      const dz = z - l.z;
      us.push(dx * cs + dz * sn);
      vs.push(-dx * sn + dz * cs);
      if (y > yMax) yMax = y;
      if (y < yMin) yMin = y;
      n++;
    }
  }
  if (!n) {
    rows.push({ id: l.id, name: l.name, verts: 0, note: 'no geometry' });
    continue;
  }
  us.sort((a, b) => a - b);
  vs.sort((a, b) => a - b);
  const u0 = us[0];
  const u1 = us[us.length - 1];
  const v0 = vs[0];
  const v1 = vs[vs.length - 1];
  /**
   * **The gate's own reading, kept beside the true one, because they are different
   * questions and the difference is a finding.**
   *
   * `probe-fabric` takes the 0.5/99.5 percentile of the vertices rather than the extremes,
   * so that one stray vertex cannot set a dimension. That is right for a stray. It is not
   * right for a *plate*: the Iseum's substructure is a 200 x 50 m floor slab carrying about
   * two dozen vertices, and the temple standing on it carries several thousand, so the
   * percentile discards the slab entirely and G13a reads the Iseum at 59.6 m of its
   * published 200. Both numbers are true and they mean different things — `pctLong` is the
   * ARCHITECTURE the eye reads, `drawnLong` is every square metre of stone the ground
   * carries — so both are printed and the gap between them is the column to look at.
   */
  const pct = (arr, t) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(t * (arr.length - 1))))];
  const pu = pct(us, 0.995) - pct(us, 0.005);
  const pv = pct(vs, 0.995) - pct(vs, 0.005);
  // The box `buildLandmarks` actually publishes.
  const boxW = (l.hw / PRECINCT) * 2;
  const boxD = (l.hd / PRECINCT) * 2;
  const drawnU = u1 - u0;
  const drawnV = v1 - v0;
  const boxLong = Math.max(boxW, boxD);
  const boxShort = Math.min(boxW, boxD);
  const dLong = Math.max(drawnU, drawnV);
  const dShort = Math.min(drawnU, drawnV);
  const pLong = Math.max(pu, pv);
  const pShort = Math.min(pu, pv);
  const s = SURVEY.get(l.id) ?? null;
  const r3 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
  const r2 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  rows.push({
    id: l.id,
    name: l.name,
    soft: !!l.soft,
    verts: n,
    planScale: r3(l.planScale),
    // The box, in world metres.
    boxLongM: r2(boxLong),
    boxShortM: r2(boxShort),
    // The stone, in world metres.
    drawnLongM: r2(dLong),
    drawnShortM: r2(dShort),
    pctLongM: r2(pLong),
    pctShortM: r2(pShort),
    pctOverBoxLong: r3(pLong / boxLong),
    pctOverBoxShort: r3(pShort / boxShort),
    pctOverPublished: s ? r3(pLong / s.len) : null,
    pctAspect: r3(pLong / pShort),
    pctAspectErr: s ? r3(Math.abs(pLong / pShort - s.len / s.wid) / (s.len / s.wid)) : null,
    /** How much of the stone the percentile throws away. A plate, if it is large. */
    plateGapM: r2(dLong - pLong),
    // G14's quantity, both axes. > 1 + BOX_VS_STONE_TOL (1.15) is a fault.
    stoneOverBoxLong: r3(dLong / boxLong),
    stoneOverBoxShort: r3(dShort / boxShort),
    overhangM: r2(Math.max(dLong - boxLong, dShort - boxShort) / 2),
    // What the builder is drawing in ITS OWN frame, which is the number to compare against
    // the literal in the `switch`.
    localLongM: r2(dLong / l.planScale),
    localShortM: r2(dShort / l.planScale),
    // and what `(m.hw * 2) / PRECINCT` would hand it.
    localBoxLongM: r2(boxLong / l.planScale),
    localBoxShortM: r2(boxShort / l.planScale),
    publishedLenM: s ? s.len : null,
    publishedWidM: s ? s.wid : null,
    // G13a's quantity.
    drawnOverPublished: s ? r3(dLong / s.len) : null,
    // G12's quantity.
    drawnAspect: r3(dLong / dShort),
    publishedAspect: s ? r3(s.len / s.wid) : null,
    aspectErr: s ? r3(Math.abs(dLong / dShort - s.len / s.wid) / (s.len / s.wid)) : null,
    yMaxM: r2(yMax),
    yMinM: r2(yMin),
  });
}

rows.sort((a, b) => (b.pctOverBoxShort ?? -1) - (a.pctOverBoxShort ?? -1));

const pad = (s, w) => String(s).padEnd(w);
const num = (s, w) => String(s === null || s === undefined ? '-' : s).padStart(w);
console.log('mon-extents — drawn stone vs the collision box, per monument (world metres)\n');
console.log(`${pad('id', 20)}${num('box L', 8)}${num('box S', 8)}${num('all L', 8)}${num('pct L', 8)}${num('plate', 7)}${num('/boxL', 7)}${num('/boxS', 7)}${num('p/boxL', 7)}${num('p/boxS', 7)}${num('p/pub', 7)}${num('pAspE', 7)}`);
console.log('-'.repeat(102));
for (const r of rows) {
  if (!r.verts) { console.log(`${pad(r.id, 20)}  (no geometry)`); continue; }
  // The gate's own limbs, computed on the gate's own percentile reading.
  const bad14 = Math.max(r.pctOverBoxLong, r.pctOverBoxShort) > 1.15;
  const bad13 = r.pctOverPublished !== null && r.pctOverPublished < 0.45;
  const bad12 = r.pctAspectErr !== null && r.pctAspectErr > 0.25;
  console.log(
    `${pad(r.id, 20)}${num(r.boxLongM, 8)}${num(r.boxShortM, 8)}${num(r.drawnLongM, 8)}${num(r.pctLongM, 8)}${num(r.plateGapM, 7)}`
    + `${num(r.stoneOverBoxLong, 7)}${num(r.stoneOverBoxShort, 7)}${num(r.pctOverBoxLong, 7)}${num(r.pctOverBoxShort, 7)}${num(r.pctOverPublished, 7)}${num(r.pctAspectErr, 7)}`
    + `${bad14 ? '  G14' : ''}${bad13 ? '  G13a' : ''}${bad12 ? '  G12' : ''}`
  );
}
console.log('\nlocal frame — what each builder is drawing vs what `(m.hw * 2) / PRECINCT` would hand it');
console.log(`${pad('id', 20)}${num('draws L', 9)}${num('draws S', 9)}${num('box L', 9)}${num('box S', 9)}${num('pub len', 9)}${num('pub wid', 9)}`);
console.log('-'.repeat(74));
for (const r of [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
  if (!r.verts) continue;
  console.log(`${pad(r.id, 20)}${num(r.localLongM, 9)}${num(r.localShortM, 9)}${num(r.localBoxLongM, 9)}${num(r.localBoxShortM, 9)}${num(r.publishedLenM, 9)}${num(r.publishedWidM, 9)}`);
}

const g14 = rows.filter((r) => r.verts && Math.max(r.pctOverBoxLong, r.pctOverBoxShort) > 1.15 && !r.soft);
const g13 = rows.filter((r) => r.verts && r.pctOverPublished !== null && r.pctOverPublished < 0.45 && !r.soft);
const g12 = rows.filter((r) => r.verts && r.pctAspectErr !== null && r.pctAspectErr > 0.25 && !r.soft);
const g14all = rows.filter((r) => r.verts && Math.max(r.stoneOverBoxLong, r.stoneOverBoxShort) > 1.15 && !r.soft);
console.log(`\nG14-shaped, on the gate's percentile: ${g14.length} [${g14.map((r) => `${r.id} ${r.overhangM} m`).join('; ')}]`);
console.log(`G14-shaped, on EVERY vertex:            ${g14all.length} [${g14all.map((r) => `${r.id}`).join('; ')}]`);
console.log(`G13a-shaped: ${g13.length} [${g13.map((r) => `${r.id} ${r.pctOverPublished}`).join('; ')}]`);
console.log(`G12-shaped: ${g12.length} [${g12.map((r) => `${r.id} ${r.pctAspect} vs ${r.publishedAspect}`).join('; ')}]`);
const plates = rows.filter((r) => r.verts && r.plateGapM > 5).sort((a, b) => b.plateGapM - a.plateGapM);
console.log(`\nstone the percentile discards (a plate, an apron or a mound), > 5 m: ${plates.length}`);
for (const r of plates) console.log(`   ${pad(r.id, 20)} all ${num(r.drawnLongM, 8)} m  vs pct ${num(r.pctLongM, 8)} m  — ${num(r.plateGapM, 7)} m of stone the gate cannot see`);

if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ rows }, null, 1));
