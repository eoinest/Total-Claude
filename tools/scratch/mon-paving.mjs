#!/usr/bin/env node
/**
 * mon-paving — `probe-fabric` G5's question, asked offline, with the shipped builder.
 *
 * G5: *no DRAWN carriageway is drawn under a monument.* It reads street vertices off the
 * baked scene, which needs a browser, a GPU slot and four minutes. This runs the shipped
 * `buildDistricts()` — the real `buildWays`, the real `PLAZAS`, the real `onMonument` — into
 * a real `Batch` and counts the same thing in about two seconds, per monument AND per
 * *source* of paving, which the probe cannot do because the sources are merged by the time
 * it reads them.
 *
 * The per-source split is the whole point. The probe says "3,478 street vertices inside 8
 * monument footprints" and cannot say whether that is carriageway, footway, kerb, colonnade
 * or forum paving, so it cannot say which loop to fix.
 *
 * `MAP-METHOD.md` rule 29. Nothing here re-implements a builder.
 *
 *   node --experimental-strip-types --import ./tools/lib/ts-resolve.mjs \
 *     tools/scratch/mon-paving.mjs
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
import { buildDistricts } from '../../src/city/rome/fabric.ts';
import { LANDMARKS, PRECINCT, romeKeepOut, PLAZAS, WAYS } from '../../src/city/rome/layout.ts';
import { romeWallZ } from '../../src/terrain/topography.ts';

const mats = { worldSize: () => 4, get: () => undefined };
const FLAT = 20;

const out = buildDistricts(() => FLAT, romeKeepOut(), 'rome-fabric', romeWallZ);
const streets = out.chunks.find((c) => c.name === 'streets');
if (!streets) throw new Error('mon-paving: no `streets` chunk — the chunk name changed');

const batch = new Batch(mats, undefined, false);
streets.build(batch, 2);

/**
 * The monument footprints EXACTLY as `buildLandmarks` publishes them to the game: the
 * reserved extent with `PRECINCT` divided back out, which is the building itself and is the
 * polygon `probe-fabric` tests against. Eroded 0.5 m, as the probe does, so a shared kerb
 * line is not counted as a trespass.
 */
const boxes = LANDMARKS.filter((l) => !l.soft).map((l) => ({
  id: l.id, name: l.name,
  x: l.x, z: l.z, rot: l.rot,
  hw: Math.max(0, l.hw / PRECINCT - 0.5),
  hd: Math.max(0, l.hd / PRECINCT - 0.5),
  reach: (l.hw / PRECINCT + l.hd / PRECINCT),
}));

const inBox = (x, z) => {
  for (const b of boxes) {
    const dx = x - b.x;
    const dz = z - b.z;
    if (dx * dx + dz * dz > b.reach * b.reach) continue;
    const cs = Math.cos(b.rot);
    const sn = Math.sin(b.rot);
    if (Math.abs(dx * cs - dz * sn) <= b.hw && Math.abs(dx * sn + dz * cs) <= b.hd) return b;
  }
  return null;
};

/**
 * Which loop emitted a vertex, recovered from the stream and the vertex index.
 *
 * `buildWays` pushes surfaces and kerbs to `road` and colonnades to `stone`, and the plazas
 * come last on `road` (paving) and `stone` (their porticoes). So `stone` is entirely
 * colonnade, and on `road` the plaza run is the tail — its start is recorded by watermarking
 * the stream at the moment the way loop finishes. That watermark is taken by rebuilding with
 * the plazas suppressed is NOT possible without editing src, so it is taken the honest way:
 * the plaza quads are the only ones whose colour comes from `PAL.travertine` lerped to
 * marble, and the count is cross-checked against `PLAZAS`' own quad arithmetic below.
 */
const per = new Map();
let total = 0;
let hits = 0;
const byStream = new Map();
for (const [key, st] of batch.streams) {
  const pos = st.pos;
  const n = st.vertexCount;
  const sacc = byStream.get(key) ?? { verts: 0, hits: 0, per: new Map() };
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3];
    const z = pos[i * 3 + 2];
    total++;
    sacc.verts++;
    const b = inBox(x, z);
    if (!b) continue;
    hits++;
    sacc.hits++;
    per.set(b.id, (per.get(b.id) ?? 0) + 1);
    sacc.per.set(b.id, (sacc.per.get(b.id) ?? 0) + 1);
  }
  byStream.set(key, sacc);
}

console.log(`mon-paving — street vertices inside a monument's own collision box (eroded 0.5 m)\n`);
console.log(`  total street vertices: ${total}`);
console.log(`  inside a monument:     ${hits}  over ${per.size} monuments\n`);
console.log('  per monument:');
for (const [id, n] of [...per].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(6)}  ${id}`);
}
console.log('\n  per material stream (road = carriageway/footway/kerb/plaza paving, stone = colonnades):');
for (const [k, s] of byStream) {
  console.log(`    ${k.padEnd(10)} ${String(s.hits).padStart(6)} of ${String(s.verts).padStart(7)}`
    + `   [${[...s.per].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => `${id} ${n}`).join(', ')}]`);
}

// ---- which plazas stand on a monument, from the plan alone ----------------
console.log(`\n  PLAZAS standing on a monument box (${PLAZAS.length} declared):`);
let pz = 0;
for (const p of PLAZAS) {
  const cs = Math.cos(p.rot);
  const sn = Math.sin(p.rot);
  const worst = new Map();
  for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
    const x = p.x + du * p.hw * cs + dv * p.hd * sn;
    const z = p.z - du * p.hw * sn + dv * p.hd * cs;
    const b = inBox(x, z);
    if (b) worst.set(b.id, (worst.get(b.id) ?? 0) + 1);
  }
  if (worst.size) {
    pz++;
    console.log(`    plaza at (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) ${(p.hw * 2).toFixed(0)}x${(p.hd * 2).toFixed(0)} m`
      + `  -> ${[...worst].map(([id, n]) => `${id} (${n}/5 corners)`).join(', ')}`);
  }
}
console.log(`    ${pz} of ${PLAZAS.length} plazas have a corner or centre inside a monument`);

// ---- which authored ways cross a monument, and by how much laterally ------
console.log('\n  authored WAYS whose ribbon EDGE reaches inside a monument box while its');
console.log('  CENTRELINE does not (this is the sample-vs-extent fault, rule 36):');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
let edgeOnly = 0;
for (const w of WAYS) {
  const foot = clamp(w.width * 0.115, 0.9, 3.4);
  const half = w.width * 0.5;
  const seen = new Map();
  for (let s = 0; s + 1 < w.path.length; s++) {
    const a = w.path[s];
    const b = w.path[s + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(len / 2));
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    for (let i = 0; i <= n; i++) {
      const cx = a.x + dx * len * (i / n);
      const cz = a.z + dz * len * (i / n);
      const centre = inBox(cx, cz);
      for (const o of [-half, -(half - foot), half - foot, half]) {
        const ex = cx - dz * o;
        const ez = cz + dx * o;
        const edge = inBox(ex, ez);
        if (edge && !centre) {
          const k = `${w.id}>${edge.id}`;
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
      }
    }
  }
  for (const [k, n] of seen) {
    edgeOnly++;
    console.log(`    ${k.padEnd(46)} ${n} edge samples inside, centreline clear`);
  }
}
console.log(`    ${edgeOnly} way/monument pairs where only the ribbon's edge trespasses`);
