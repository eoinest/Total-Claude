#!/usr/bin/env node
/**
 * Geometry probe for the soldier mesh — measured, not argued.
 *
 * Two questions this answers that no screenshot can, and that reasoning about the source got
 * wrong twice in one session:
 *
 *   1. **Do the shading normals agree with the triangle winding?** A lathe writes its normals
 *      from the profile tangent and its triangles from the ring order, and nothing in the code
 *      ties the two together. If they disagree, the surface is lit inside-out: a helmet bowl
 *      samples the ground where it should sample the sky and reads as flat cream instead of
 *      metal. Backface culling would not catch it, because culling uses winding and shading
 *      uses the attribute.
 *   2. **Where is each piece in space?** The shield boss is placed by a rotated matrix and a
 *      signed axial offset, and "is the umbo in front of the board" is a question about two
 *      numbers that are eight lines apart in different coordinate systems.
 *
 * It runs the real `buildSoldierGeometry` in the browser through the dev server, so it
 * measures the shipped builder rather than a re-implementation of it.
 *
 * Usage:
 *   node tools/probe-soldiermesh.mjs --port=5199
 *   node tools/probe-soldiermesh.mjs --port=5199 --piece=24     # one piece, verbose
 */

import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5199);
const ONLY = args.has('piece') ? Number(args.get('piece')) : -1;
const BASE = `http://127.0.0.1:${PORT}`;

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) {
  console.error(`No dev server on ${PORT}. Start one and pass --port; a probe that silently`);
  console.error('falls back to a stale build has reported 5/12 on a tree that scored 12/12.');
  process.exit(2);
}
console.log(`probe-soldiermesh — live server on ${PORT}`);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 180000 });

const out = await page.evaluate(async ({ only }) => {
  const mesh = await import('/src/units/soldierMesh.ts');
  const geo = mesh.buildSoldierGeometry(0, 0); // Faction.Rome, LOD0

  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const pt = geo.getAttribute('aPieceTint');
  const idx = geo.getIndex();
  if (!idx) return { error: 'geometry is not indexed' };

  /** Per-piece accumulator. */
  const acc = new Map();
  const get = (p) => {
    let a = acc.get(p);
    if (!a) {
      a = {
        piece: p, tris: 0, agree: 0, disagree: 0, degenerate: 0,
        min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9], dotSum: 0,
        // Second pass: how each of the two candidate normals sits against the outward
        // direction from the piece's own centroid. On a broadly convex piece the *correct*
        // one is positive. Without this the probe can only say the two disagree, not which
        // one is wrong — and "the winding is wrong" and "the normals are wrong" are opposite
        // bugs with opposite fixes.
        cen: [0, 0, 0], nOut: 0, wOut: 0, tri: [],
      };
      acc.set(p, a);
    }
    return a;
  };

  const ax = [0, 0, 0], bx = [0, 0, 0], cx = [0, 0, 0];
  const rd = (arr, i) => { arr[0] = pos.getX(i); arr[1] = pos.getY(i); arr[2] = pos.getZ(i); };

  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
    const p = pt.getX(i0);
    if (only >= 0 && p !== only) continue;
    const a = get(p);
    a.tris++;
    rd(ax, i0); rd(bx, i1); rd(cx, i2);
    for (let k = 0; k < 3; k++) {
      const v = [ax[k], bx[k], cx[k]];
      for (const q of v) { if (q < a.min[k]) a.min[k] = q; if (q > a.max[k]) a.max[k] = q; }
    }
    // Winding normal.
    const e1 = [bx[0] - ax[0], bx[1] - ax[1], bx[2] - ax[2]];
    const e2 = [cx[0] - ax[0], cx[1] - ax[1], cx[2] - ax[2]];
    const w = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const wl = Math.hypot(w[0], w[1], w[2]);
    if (wl < 1e-12) { a.degenerate++; continue; }
    // Mean attribute normal of the three corners.
    const nx = (nrm.getX(i0) + nrm.getX(i1) + nrm.getX(i2)) / 3;
    const ny = (nrm.getY(i0) + nrm.getY(i1) + nrm.getY(i2)) / 3;
    const nz = (nrm.getZ(i0) + nrm.getZ(i1) + nrm.getZ(i2)) / 3;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-9) { a.degenerate++; continue; }
    const d = (w[0] * nx + w[1] * ny + w[2] * nz) / (wl * nl);
    a.dotSum += d;
    if (d >= 0) a.agree++; else a.disagree++;
    a.tri.push([
      (ax[0] + bx[0] + cx[0]) / 3, (ax[1] + bx[1] + cx[1]) / 3, (ax[2] + bx[2] + cx[2]) / 3,
      nx / nl, ny / nl, nz / nl, w[0] / wl, w[1] / wl, w[2] / wl,
    ]);
  }

  // Outward test, per piece.
  for (const a of acc.values()) {
    if (!a.tri.length) continue;
    const c = [0, 0, 0];
    for (const t of a.tri) { c[0] += t[0]; c[1] += t[1]; c[2] += t[2]; }
    c[0] /= a.tri.length; c[1] /= a.tri.length; c[2] /= a.tri.length;
    a.cen = c.map((v) => Number(v.toFixed(4)));
    let n = 0, w = 0, used = 0;
    for (const t of a.tri) {
      const v = [t[0] - c[0], t[1] - c[1], t[2] - c[2]];
      const l = Math.hypot(v[0], v[1], v[2]);
      // Skip triangles sitting essentially at the centroid: "outward" is undefined there.
      if (l < 1e-4) continue;
      used++;
      n += (t[3] * v[0] + t[4] * v[1] + t[5] * v[2]) / l;
      w += (t[6] * v[0] + t[7] * v[1] + t[8] * v[2]) / l;
    }
    a.nOut = used ? n / used : 0;
    a.wOut = used ? w / used : 0;
    a.tri = undefined;
  }

  return {
    totalTris: idx.count / 3,
    pieces: [...acc.values()].map((a) => ({
      ...a,
      meanDot: a.tris ? a.dotSum / a.tris : 0,
      min: a.min.map((v) => Number(v.toFixed(4))),
      max: a.max.map((v) => Number(v.toFixed(4))),
    })).sort((x, y) => y.disagree - x.disagree),
  };
}, { only: ONLY });

await browser.close();

if (out.error) { console.error(out.error); process.exit(1); }

const NAMES = {
  0: 'Head+arms', 1: 'HairShort', 2: 'HairLong', 3: 'Beard', 4: 'HelmGallic', 5: 'HelmRidge',
  6: 'HelmCoolus', 7: 'HelmSpangen', 8: 'HelmFur', 9: 'CrestTransverse', 10: 'CrestLongitudinal',
  11: 'CrestPlume', 12: 'CrestHorns', 13: 'Tunic', 14: 'Focale', 15: 'TorsoBare',
  16: 'Segmentata', 17: 'Mail', 18: 'Scale', 19: 'Leather', 20: 'LegsBare', 21: 'Trousers',
  22: 'Boots', 23: 'Cloak', 24: 'ShieldScutum', 25: 'ShieldOval', 26: 'ShieldRound',
  27: 'Sword', 28: 'Spear', 29: 'Axe', 30: 'Bow', 31: 'Quiver', 32: 'Pilum',
  33: 'JavelinBundle', 34: 'Torc', 35: 'SwordSheathed',
};

console.log(`\ntotal triangles (Rome, LOD0): ${out.totalTris}\n`);
console.log('piece                 tris  disagree  meanDot   nrm.out   wind.out   verdict');
console.log('-'.repeat(78));
let bad = 0;
for (const p of out.pieces) {
  // Which of the two is wrong is decided by the outward test, not by the disagreement.
  let verdict = 'ok';
  if (p.disagree > p.agree) verdict = p.nOut < 0 && p.wOut > 0 ? 'NORMALS INVERTED'
    : p.wOut < 0 && p.nOut > 0 ? 'WINDING INVERTED' : 'both/unclear';
  else if (p.disagree) verdict = 'mixed';
  if (p.disagree > p.agree) bad += p.tris;
  console.log(
    `${String(NAMES[p.piece] ?? p.piece).padEnd(20)} ${String(p.tris).padStart(5)} ${String(p.disagree).padStart(9)}   ${p.meanDot.toFixed(3).padStart(6)}   ${p.nOut.toFixed(3).padStart(7)}   ${p.wOut.toFixed(3).padStart(8)}   ${verdict}`
  );
}
console.log('-'.repeat(74));
console.log(`triangles whose shading normal opposes their own winding: ${bad} / ${out.totalTris} (${(100 * bad / out.totalTris).toFixed(1)}%)`);
if (errors.length) {
  console.error(`\n${errors.length} page error(s):`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.error(`  ${e}`);
}
