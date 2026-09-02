#!/usr/bin/env node
/**
 * mon-trespass — whose stone is standing in whose footprint, with the emitter named.
 *
 * `probe-fabric` G15 asks *"is one monument's drawn stone inside another monument's
 * footprint?"* and on Rome it cannot answer it, for a reason that is structural rather than
 * a bug. Rome merges its monuments into three depth bands, so the baked scene has no call
 * boundaries left in it and the probe attributes every vertex to **the nearest centre
 * normalised by reach**. That rule systematically hands a small monument's own stone to a
 * large neighbour: the Stadium of Domitian's reach is 211 m and the Baths of Nero's is 66, so
 * a bath vertex on the side facing the stadium scores better against the stadium than against
 * the building it belongs to — and G15 then reports *"stadium-domitian into baths-nero,
 * 12.07 m deep"* about stone that never left the baths.
 *
 * `buildLandmarks` calls `setUvOrigin(m.x, 0, m.z)` immediately before each `buildLandmark`,
 * so the vertices a monument emits are exactly the ones pushed between two of those calls —
 * `tools/scratch/mon-extents.mjs`'s watermark, reused here. With the emitter known, the
 * question G15 wants to ask can be asked exactly:
 *
 *   for every monument A and every vertex A emits, is that vertex inside monument B's
 *   published box, for some B != A?
 *
 * and the answer distinguishes a real trespass from an attribution artefact. Both are printed:
 * the exact reading, and the nearest-centre reading the probe is stuck with, so the gap
 * between them is a number rather than an argument.
 *
 *   node --experimental-strip-types --import ./tools/lib/ts-resolve.mjs \
 *     tools/scratch/mon-trespass.mjs [--pad=0]
 *
 * `--pad` erodes every box by that many metres before testing, as G15 does (0.5 m), so a
 * vertex sitting exactly on a shared face is not counted as being through it.
 */
import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';

import process from 'node:process';
import { Batch } from '../../src/city/build.ts';
import { buildLandmarks } from '../../src/city/rome/monuments.ts';
import { LANDMARKS, PRECINCT } from '../../src/city/rome/layout.ts';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit === undefined ? d : hit.slice(k.length + 3);
};
const PAD = Number(arg('pad', '0.5'));

const mats = { worldSize: () => 4, get: () => undefined };
const batch = new Batch(mats, undefined, false);
const marks = [];
const realSetUvOrigin = batch.setUvOrigin.bind(batch);
batch.setUvOrigin = (x, y, z) => {
  const at = new Map();
  for (const [k, st] of batch.streams) at.set(k, st.vertexCount);
  marks.push({ x, z, at });
  realSetUvOrigin(x, y, z);
};

const out = buildLandmarks(() => 8, 'rome');
const monChunks = out.chunks.filter((c) => /^monuments-/.test(c.name));
const others = out.chunks.filter((c) => !/^monuments-/.test(c.name));
for (const c of monChunks) c.build(batch, 2);
// Snapshot BEFORE the aqueduct, tomb and far-hill chunks add their own origins: those are not
// monuments and each sets one marker. `mon-extents.mjs` does the same, and for the same reason.
const monMarks = marks.slice();
const endAt = new Map();
for (const [k, st] of batch.streams) endAt.set(k, st.vertexCount);
for (const c of others) c.build(batch, 2);

const zs = LANDMARKS.map((l) => l.z).sort((a, b) => a - b);
const q = (t) => zs[Math.min(zs.length - 1, Math.floor(t * zs.length))];
const bands = [
  { from: -1e9, to: q(0.5) },
  { from: q(0.5), to: q(0.75) },
  { from: q(0.75), to: 1e9 },
];
const visited = [];
for (const b of bands) for (const l of LANDMARKS) if (l.z >= b.from && l.z < b.to) visited.push(l);
if (visited.length !== monMarks.length) {
  throw new Error(`mon-trespass: ${visited.length} landmarks but ${monMarks.length} markers`);
}

/**
 * The published box, eroded, in the PLAN convention — `src/city/layout.ts:axisU` sends local
 * +X to `(cos r, -sin r)`, so world -> local is `u = dx*cos - dz*sin`. `LANDMARKS.rot` is a
 * plan rotation; `CitySystem:occRot` negates it at the sim boundary and `probe-fabric` reads
 * the negated one, which is the same rectangle written the other way round.
 */
const boxes = LANDMARKS.filter((l) => !l.soft).map((l) => ({
  id: l.id, name: l.name, x: l.x, z: l.z, rot: l.rot,
  hw: Math.max(0, l.hw / PRECINCT - PAD),
  hd: Math.max(0, l.hd / PRECINCT - PAD),
  reach: Math.hypot(l.hw, l.hd),
}));
const inBox = (b, x, z) => {
  const dx = x - b.x;
  const dz = z - b.z;
  const c = Math.cos(b.rot);
  const s = Math.sin(b.rot);
  return Math.abs(dx * c - dz * s) <= b.hw && Math.abs(dx * s + dz * c) <= b.hd;
};

/** `probe-fabric`'s rule, reproduced so the two readings can be compared on one run. */
const nearestOwner = (x, z) => {
  let best = null;
  let bs = Infinity;
  for (const b of boxes) {
    const s2 = ((b.x - x) ** 2 + (b.z - z) ** 2) / (b.reach * b.reach);
    if (s2 < bs) { bs = s2; best = b; }
  }
  return bs <= 1.6 * 1.6 ? best : null;
};

const exact = new Map();
const byProximity = new Map();
let verts = 0;
let stolen = 0;
for (let i = 0; i < visited.length; i++) {
  const l = visited[i];
  if (l.soft) continue;
  const from = monMarks[i].at;
  const to = i + 1 < monMarks.length ? monMarks[i + 1].at : endAt;
  for (const [k, st] of batch.streams) {
    const a = from.get(k) ?? 0;
    const b = to.get(k) ?? st.vertexCount;
    for (let vi = a; vi < b; vi++) {
      const x = st.pos[vi * 3];
      const z = st.pos[vi * 3 + 2];
      verts++;
      const near = nearestOwner(x, z);
      if (near && near.id !== l.id) stolen++;
      for (const bx of boxes) {
        if (bx.id === l.id) continue;
        if (!inBox(bx, x, z)) continue;
        // The exact reading: this vertex was EMITTED by `l` and stands inside `bx`.
        const ke = `${l.id}>${bx.id}`;
        exact.set(ke, (exact.get(ke) ?? 0) + 1);
        // The probe's reading: it would credit the vertex to whoever is nearest by reach.
        const owner = near ? near.id : l.id;
        if (owner !== bx.id) {
          const kp = `${owner}>${bx.id}`;
          byProximity.set(kp, (byProximity.get(kp) ?? 0) + 1);
        }
      }
    }
  }
}

const pad = (s, w) => String(s).padEnd(w);
console.log('mon-trespass — a monument\'s own stone inside another monument\'s footprint\n');
console.log(`  ${verts} monument vertices, ${boxes.length} published boxes eroded by ${PAD} m`);
console.log(`  ${stolen} vertices (${((stolen / verts) * 100).toFixed(1)} %) would be credited to a`
  + ' monument that did not emit them by the nearest-centre rule the probe has to use\n');

const show = (m, title) => {
  const rows = [...m].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n);
  console.log(`${title}: ${rows.length} pair(s), ${rows.reduce((s, r) => s + r.n, 0)} vertices`);
  for (const r of rows) console.log(`   ${pad(r.k, 46)} ${r.n}`);
  if (!rows.length) console.log('   (none)');
  console.log('');
};
show(exact, 'EXACT, by emitter watermark — the answer G15 wants');
show(byProximity, "BY PROXIMITY, the probe's own rule — what G15 can actually see");
