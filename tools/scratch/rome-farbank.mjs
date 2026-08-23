#!/usr/bin/env node
/**
 * **How much of the far bank is fabric, and what it costs.** The Transtiberim pass's own ruler.
 *
 * `tools/scratch/rome-blockcheck.mjs` grades the whole block plan and is the instrument this
 * one defers to; it cannot be run on this tree under `--experimental-strip-types` because
 * `src/city/build.ts` uses a TypeScript parameter property, which strip-only mode refuses. So
 * this loads the *same shipped modules* through Vite's own SSR loader — the resolver and the
 * evaluation order the browser gets — and grades `cityPlan()` itself. Nothing here
 * re-implements anything in `src/`; `MAP-METHOD.md` rule 6.
 *
 * It answers three questions and no others:
 *
 *  1. **How much of Regio XIV's city ground is fabric?** City ground is z behind the wall
 *     crest, sampled on the same 8 m grid `probe-fabric` G19 uses. "Fabric" is a cell standing
 *     inside the buildable inset of a face the plan calls a block.
 *  2. **Where are the blocks?** Per region: count, inset area, and that share.
 *  3. **What does the armature cost?** Way count and kilometres by rank, and the graph's own
 *     cross-lane total.
 *
 *   node tools/scratch/rome-farbank.mjs
 *   node tools/scratch/rome-farbank.mjs --json=path.json
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const ROOT = resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const h = argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : d;
};

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
});
// Survey first: `src/city/rome` has an import cycle whose entry point decides which binding is
// uninitialised. This is the order the app itself takes.
await server.ssrLoadModule('/src/city/rome/survey.ts');
const topo = await server.ssrLoadModule('/src/terrain/topography.ts');
const regionsM = await server.ssrLoadModule('/src/city/rome/regions.ts');
const waysM = await server.ssrLoadModule('/src/city/rome/ways.ts');
const layoutM = await server.ssrLoadModule('/src/city/rome/layout.ts');
const fabricM = await server.ssrLoadModule('/src/city/rome/fabric.ts');

const { HALF_EXTENT, romeWallZ, worldOf } = topo;
const { REGIONS, regionAt, assertRegionPartition } = regionsM;
const { ROME_WAYS } = waysM;
const { WAY_WIDTH } = layoutM;
const { cityPlan } = fabricM;

const t0 = Date.now();
const plan = cityPlan();
const planMs = Date.now() - t0;

// ---- the armature -------------------------------------------------------
const byRank = new Map();
let totalKm = 0;
for (const w of ROME_WAYS) {
  let m = 0;
  for (let i = 0; i + 1 < w.path.length; i++) {
    const a = worldOf(w.path[i][0], w.path[i][1]);
    const b = worldOf(w.path[i + 1][0], w.path[i + 1][1]);
    m += Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
  }
  const r = byRank.get(w.cls) ?? { n: 0, km: 0 };
  r.n++; r.km += m / 1000;
  byRank.set(w.cls, r);
  totalKm += m / 1000;
}

// ---- blocks by region ----------------------------------------------------
const perRegion = new Map();
for (const r of REGIONS) {
  perRegion.set(r.id, { id: r.id, num: r.numeral, blocks: 0, field: 0, other: 0, insetM2: 0, faceM2: 0 });
}
for (const b of plan.blocks) {
  const s = perRegion.get(b.region.id);
  if (!s) continue;
  if (b.kind === 'block') { s.blocks++; s.insetM2 += b.insetAreaM2; s.faceM2 += b.face.areaM2; }
  else if (b.kind === 'field') s.field++;
  else s.other++;
}

// ---- the 8 m sweep behind the crest --------------------------------------
const STEP = 8;
const cellM2 = STEP * STEP;
const blockRings = plan.blocks.filter((b) => b.kind === 'block' && b.inset.length >= 3);
// Bucket the insets on a coarse grid so the point test is not cells x blocks.
const BK = 128;
const bucket = new Map();
const bbOf = new Map();
for (const b of blockRings) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of b.inset) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  bbOf.set(b, { x0, x1, z0, z1 });
  for (let iz = Math.floor(z0 / BK); iz <= Math.floor(z1 / BK); iz++) {
    for (let ix = Math.floor(x0 / BK); ix <= Math.floor(x1 / BK); ix++) {
      const k = `${ix},${iz}`;
      const l = bucket.get(k); if (l) l.push(b); else bucket.set(k, [b]);
    }
  }
}
const inRing = (p, x, z) => {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i].z > z) !== (p[j].z > z)) {
      const t = (z - p[i].z) / (p[j].z - p[i].z);
      if (x < p[i].x + t * (p[j].x - p[i].x)) inside = !inside;
    }
  }
  return inside;
};
/**
 * Which block's buildable inset a point stands in, or `null`.
 *
 * **It returns the block and not a boolean, and that is not tidiness.** The first version
 * answered "is this cell inside a block", reported the Ager Vaticanus at 46.7 % and
 * Transtiberim at 25 %, and was wrong in the way that matters: a *horti* block is 8 % roof and
 * an insula block is 60–72 %, so counting both as "fabric" says the imperial gardens are twice
 * as built as the quarter. `MAP-METHOD.md` rule 6 — the instrument has to be able to tell the
 * difference between the two things it is adding up.
 */
const blockAt = (x, z) => {
  const l = bucket.get(`${Math.floor(x / BK)},${Math.floor(z / BK)}`);
  if (!l) return null;
  for (const b of l) {
    const bb = bbOf.get(b);
    if (x < bb.x0 || x > bb.x1 || z < bb.z0 || z > bb.z1) continue;
    if (inRing(b.inset, x, z)) return b;
  }
  return null;
};
const onBlock = (x, z) => blockAt(x, z) !== null;

const sweep = new Map();
let cells = 0; let onFab = 0;
for (let z = -HALF_EXTENT + STEP / 2; z < HALF_EXTENT; z += STEP) {
  for (let x = -HALF_EXTENT + STEP / 2; x < HALF_EXTENT; x += STEP) {
    if (z < romeWallZ(x)) continue;           // outside the curtain: not a region's job
    cells++;
    const reg = regionAt(x, z);
    const s = sweep.get(reg.id) ?? { cells: 0, fab: 0 };
    s.cells++;
    if (onBlock(x, z)) { s.fab++; onFab++; }
    sweep.set(reg.id, s);
  }
}

// ---- report --------------------------------------------------------------
const say = (...a) => console.log(...a);
say(`cityPlan() in ${planMs} ms`);
say(`partition ok=${assertRegionPartition().ok}`);
say('');
say('=== the authored armature ===');
for (const [cls, r] of [...byRank].sort()) {
  say(`  ${cls.padEnd(10)} ${String(r.n).padStart(3)} ways  ${r.km.toFixed(2)} km  (${WAY_WIDTH[cls]} m wide)`);
}
say(`  TOTAL      ${String(ROME_WAYS.length).padStart(3)} ways  ${totalKm.toFixed(2)} km`);
say('');
const g = plan.report;
say('=== the graph ===');
say(`  nodes ${g.graph.nodes}  edges ${g.graph.edges}  faces ${g.graph.faces}  pruned stubs ${g.graph.prunedStubs}`);
say(`  cross-lanes ${g.crossLanes} (${g.crossLaneKm.toFixed(2)} km)`);
say(`  blocks ${g.blocks}  plazas ${g.plazas}  pomerium ${g.pomerium}  field ${g.field}  horti ${g.hortiBlocks}`);
say('  rejects:');
for (const r of g.rejects) say(`    ${String(r.n).padStart(4)}  ${r.reason}`);
say('');
say('=== per regio: blocks, and the 8 m sweep behind the crest ===');
say('  regio                           blocks   inset ha   cityGround ha   onFabric   share');
const rows = [];
for (const r of REGIONS) {
  const s = perRegion.get(r.id);
  const w = sweep.get(r.id) ?? { cells: 0, fab: 0 };
  const groundHa = (w.cells * cellM2) / 1e4;
  const share = w.cells ? w.fab / w.cells : 0;
  rows.push({
    id: r.id, numeral: r.numeral, blocks: s.blocks, fieldFaces: s.field,
    insetHa: +(s.insetM2 / 1e4).toFixed(2), groundHa: +groundHa.toFixed(1),
    fabCells: w.fab, cells: w.cells, share: +share.toFixed(4),
  });
  say(`  ${(r.numeral + ' ' + r.id).padEnd(32)}${String(s.blocks).padStart(5)}  `
    + `${(s.insetM2 / 1e4).toFixed(2).padStart(9)}  ${groundHa.toFixed(1).padStart(13)}  `
    + `${String(w.fab).padStart(8)}  ${(100 * share).toFixed(1).padStart(6)} %`);
}
const totalGroundHa = (cells * cellM2) / 1e4;
say(`  ${'ALL'.padEnd(32)}${String(g.blocks).padStart(5)}  ${'-'.padStart(9)}  `
  + `${totalGroundHa.toFixed(1).padStart(13)}  ${String(onFab).padStart(8)}  `
  + `${((100 * onFab) / cells).toFixed(1).padStart(6)} %`);
const xiv = rows.find((r) => r.numeral === 'XIV');
say('');
say(`Regio XIV is ${((100 * xiv.cells) / cells).toFixed(1)} % of the map's city ground, `
  + `and ${(100 * xiv.share).toFixed(1)} % of that ground is fabric.`);

// ---- Regio XIV by survey northing, because it is four different places ----
const Z0 = worldOf(0, 0).z;
const KZ = Z0 - worldOf(0, 1).z;
const nOf = (z) => (Z0 - z) / KZ;
const BANDS = [
  [-500, 300, 'Transtiberim proper and the Ripa'],
  [300, 900, 'the Janiculum north slope and the Prata Quinctia'],
  [900, 1400, 'the Gardens of Agrippina and the Pons Aelius'],
  [1400, 2200, 'the Ager Vaticanus'],
];
const bandStat = BANDS.map(() => ({ cells: 0, fab: 0, horti: 0 }));
for (let z = -HALF_EXTENT + STEP / 2; z < HALF_EXTENT; z += STEP) {
  for (let x = -HALF_EXTENT + STEP / 2; x < HALF_EXTENT; x += STEP) {
    if (z < romeWallZ(x)) continue;
    if (regionAt(x, z).numeral !== 'XIV') continue;
    const n = nOf(z);
    for (let i = 0; i < BANDS.length; i++) {
      if (n >= BANDS[i][0] && n < BANDS[i][1]) {
        bandStat[i].cells++;
        const b = blockAt(x, z);
        if (b) { bandStat[i].fab++; if (b.horti) bandStat[i].horti++; }
      }
    }
  }
}
say('');
say('=== Regio XIV by survey northing: how much is inside a block, and what kind ===');
for (let i = 0; i < BANDS.length; i++) {
  const b = bandStat[i];
  const built = b.fab - b.horti;
  say(`  n ${String(BANDS[i][0]).padStart(5)}..${String(BANDS[i][1]).padStart(5)}  `
    + `${((b.cells * cellM2) / 1e4).toFixed(1).padStart(6)} ha   in a block `
    + `${(b.cells ? (100 * b.fab) / b.cells : 0).toFixed(1).padStart(5)} %   of which insula `
    + `${(b.cells ? (100 * built) / b.cells : 0).toFixed(1).padStart(5)} %  horti `
    + `${(b.cells ? (100 * b.horti) / b.cells : 0).toFixed(1).padStart(5)} %   ${BANDS[i][2]}`);
}
{
  const t = bandStat.reduce((a, b) => ({ cells: a.cells + b.cells, fab: a.fab + b.fab, horti: a.horti + b.horti }), { cells: 0, fab: 0, horti: 0 });
  say(`  ${'ALL of Regio XIV'.padStart(19)}  ${((t.cells * cellM2) / 1e4).toFixed(1).padStart(6)} ha   in a block `
    + `${((100 * t.fab) / t.cells).toFixed(1).padStart(5)} %   of which insula `
    + `${((100 * (t.fab - t.horti)) / t.cells).toFixed(1).padStart(5)} %  horti `
    + `${((100 * t.horti) / t.cells).toFixed(1).padStart(5)} %`);
}

// ---- the plan, drawn, because a percentage cannot show a hole's shape ----
const png = arg('png', '');
if (png) {
  const sharp = (await import('sharp')).default;
  const PX = 1400 / HALF_EXTENT;             // 0.5 px per world metre: the whole map at 1400 px
  const W = Math.round(2 * HALF_EXTENT * PX);
  const P = (x, z) => `${((x + HALF_EXTENT) * PX).toFixed(1)},${((z + HALF_EXTENT) * PX).toFixed(1)}`;
  const s = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}">`,
    `<rect width="${W}" height="${W}" fill="#f4f1e8"/>`];
  // Regio XIV, so the ground under discussion is visible as a shape
  const xivPoly = REGIONS.find((r) => r.numeral === 'XIV');
  s.push(`<polygon points="${xivPoly.poly.map((p) => P(p.x, p.z)).join(' ')}" fill="#e8eef4" stroke="#89a" stroke-width="1"/>`);
  // the ground behind the crest: everything below the wall line
  const crest = [];
  for (let x = -HALF_EXTENT; x <= HALF_EXTENT; x += 20) crest.push(P(x, romeWallZ(x)));
  s.push(`<polyline points="${crest.join(' ')}" fill="none" stroke="#a33" stroke-width="2"/>`);
  // the blocks
  for (const b of plan.blocks) {
    if (b.inset.length < 3) continue;
    const fill = b.kind === 'block' ? (b.horti ? '#9ab87a' : '#3d3a33') : b.kind === 'plaza' ? '#d8cfae' : '#eee';
    s.push(`<polygon points="${b.inset.map((p) => P(p.x, p.z)).join(' ')}" fill="${fill}"/>`);
  }
  // the river, from the same stations the graph uses
  const riv = [];
  for (const [e, n] of (await server.ssrLoadModule('/src/terrain/tiberSurvey.ts')).TIBER_SURVEY) {
    const w = worldOf(e, n);
    if (Math.abs(w.x) > HALF_EXTENT + 200 || Math.abs(w.z) > HALF_EXTENT + 200) continue;
    riv.push(P(w.x, w.z));
  }
  s.push(`<polyline points="${riv.join(' ')}" fill="none" stroke="#4a7fb5" stroke-width="4" opacity="0.7"/>`);
  // the authored armature
  for (const w of ROME_WAYS) {
    const pts = w.path.map(([e, n]) => { const p = worldOf(e, n); return P(p.x, p.z); });
    const col = w.cls === 'artery' ? '#c0007a' : w.cls === 'secondary' ? '#d00000' : '#e07000';
    s.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2.4"/>`);
    const m = w.path[Math.floor(w.path.length / 2)];
    const mp = worldOf(m[0], m[1]);
    s.push(`<text x="${((mp.x + HALF_EXTENT) * PX).toFixed(0)}" y="${((mp.z + HALF_EXTENT) * PX).toFixed(0)}" `
      + `fill="${col}" font-family="Helvetica" font-size="11" paint-order="stroke" stroke="#fff" stroke-width="2.5">${w.id}</text>`);
  }
  // a world-metre grid, so a reader can put a number on anything in the picture
  for (let x = -1200; x <= 1200; x += 200) {
    s.push(`<line x1="${((x + HALF_EXTENT) * PX).toFixed(1)}" y1="0" x2="${((x + HALF_EXTENT) * PX).toFixed(1)}" y2="${W}" stroke="#0aa" stroke-width="0.6" stroke-dasharray="4 8"/>`);
    s.push(`<text x="${((x + HALF_EXTENT) * PX + 3).toFixed(0)}" y="14" fill="#066" font-family="Helvetica" font-size="11">x${x}</text>`);
  }
  for (let z = -1200; z <= 1200; z += 200) {
    s.push(`<line x1="0" y1="${((z + HALF_EXTENT) * PX).toFixed(1)}" x2="${W}" y2="${((z + HALF_EXTENT) * PX).toFixed(1)}" stroke="#0aa" stroke-width="0.6" stroke-dasharray="4 8"/>`);
    s.push(`<text x="3" y="${((z + HALF_EXTENT) * PX - 3).toFixed(0)}" fill="#066" font-family="Helvetica" font-size="11">z${z} / n${nOf(z).toFixed(0)}</text>`);
  }
  s.push('</svg>');
  const file = resolve(ROOT, png);
  await sharp(Buffer.from(s.join('\n'))).png().toFile(file);
  say(`wrote ${png}  ${W} x ${W}  (1 px = ${(1 / PX).toFixed(1)} world m)`);
}

const out = arg('json', '');
if (out) {
  writeFileSync(resolve(ROOT, out), `${JSON.stringify({
    planMs, ways: ROME_WAYS.length, totalKm: +totalKm.toFixed(3),
    byRank: Object.fromEntries([...byRank].map(([k, v]) => [k, { n: v.n, km: +v.km.toFixed(3) }])),
    graph: g.graph, crossLanes: g.crossLanes, crossLaneKm: +g.crossLaneKm.toFixed(2),
    blocks: g.blocks, field: g.field, hortiBlocks: g.hortiBlocks,
    cityGroundCells: cells, onFabricCells: onFab, regions: rows,
  }, null, 1)}\n`);
  say(`wrote ${out}`);
}
await server.close();
