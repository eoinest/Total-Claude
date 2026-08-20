#!/usr/bin/env node
/**
 * Geometry probe for the soldier mesh — measured, not argued.
 *
 * ---------------------------------------------------------------------------------------
 * A self-consistent check can never fail, and this one did not, for twenty-three rounds
 * ---------------------------------------------------------------------------------------
 *
 * The original probe asked one question — *do the shading normals agree with the triangle
 * winding?* — and reported **0 disagreements on the skull, every time, while the skull was
 * inside out**. The reason is structural, not a tuning error: `MeshBuilder.quadFacing`
 * derives the winding *from* the normals. It reads the four corner normals, compares them
 * with the candidate winding, and reverses the order if they disagree. So the two agree by
 * construction. Asking whether they agree is asking whether `quadFacing` ran.
 *
 * `revolve` takes its normal from the profile tangent as `(-dy, dr)`, which points outward
 * only while y *descends* down the point list. A profile written jaw-first gets inward
 * normals, `quadFacing` faithfully derives inward winding to match, `side: FrontSide` culls
 * the near half of the surface, and the probe says everything is fine. On the skull that
 * meant a camera in front of a man saw through his face to the inside of the back of his own
 * head, with every helmet bowl, hair dome and beard between the two winning the depth test.
 * Three rounds of blind grading, forty-two judgements, and the most repeated single tell was
 * "the face is a flat painted plane, the nose neither occludes nor casts".
 *
 * **So every check below that can fail compares against something outside the mesh's own
 * opinion of itself.** In order:
 *
 *   1. **Outwardness** (the gate). Weld the vertices by position, split the mesh into
 *      connected components, and for each component measure the area-weighted mean cosine
 *      between the *winding* normal of each triangle and the direction from the component's
 *      own centroid out to that triangle. The reference is the shape's own geometry; the
 *      shading normals are never consulted. A shell wound outward scores positive, an
 *      inside-out one scores negative, and no amount of agreement between two derived
 *      quantities can fake it. Components, not pieces: `Piece.Head` is head *and* arms *and*
 *      hands, so a per-piece centroid sits in the man's chest and the statistic is
 *      meaningless — which is why the old probe's `nrm.out`/`wind.out` columns existed,
 *      were computed, and gated nothing.
 *
 *   2. **Can a man's face be seen from in front of him?** The one question the head's whole
 *      history turns on, asked directly: of the triangles carrying the `Mat.Face` tile, how
 *      many have a winding normal with a positive component along +Z. On a face that faces
 *      forward this is nearly all of them. On the shipped mesh of 2026-08-07 it was none.
 *
 *   2b. **Not** a rendered `FrontSide`-versus-`DoubleSide` differential, which was the other
 *      obvious external check and was tried first. Flipping `material.side` needs
 *      `needsUpdate`, `needsUpdate` throws the compiled program away, and `LightingSystem`
 *      re-patches soldier materials on a sixteen-frame timer — so the *baseline* arm moves
 *      213,300 pixels of a head plate on a mesh the outwardness gate has just passed clean.
 *      The confound is larger than the signal. Recorded here so nobody spends the hour twice.
 *
 *   3. Normals versus winding — **kept, and demoted**. It cannot catch an inverted lathe,
 *      but it does catch a hand-written `quad`/`tri` call that bypassed `quadFacing`, which
 *      is a real and different bug. It is reported as a self-consistency note, not a gate.
 *
 *   4. **Where is each piece in space?** The shield boss is placed by a rotated matrix and a
 *      signed axial offset, and "is the umbo in front of the board" is a question about two
 *      numbers that are eight lines apart in different coordinate systems.
 *
 * All of it runs the real `buildSoldierGeometry` in the browser through the dev server, so it
 * measures the shipped builder rather than a re-implementation of it, and it sweeps **both
 * factions and all three LODs** — the coarse head at LOD2 carries most of the army in most
 * frames and had its own copy of the inside-out lathe for as long as the fine one did.
 *
 * Exit code 1 if any component fails the outwardness gate or the face cannot be seen.
 *
 * Usage:
 *   node tools/probe-soldiermesh.mjs --port=5199
 *   node tools/probe-soldiermesh.mjs --port=5199 --piece=24     # one piece, verbose
 *   node tools/probe-soldiermesh.mjs --port=5199 --lod=0 --faction=0
 */

import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5199);
const ONLY = args.has('piece') ? Number(args.get('piece')) : -1;
/** Restrict the sweep. Absent means every faction and every LOD, which is the point. */
const LODS = args.has('lod') ? [Number(args.get('lod'))] : [0, 1, 2];
const FACTIONS = args.has('faction') ? [Number(args.get('faction'))] : [0, 1];
/**
 * Outwardness below this fails the build.
 *
 * Zero is the score of a flat sheet, whose triangles' winding normals are perpendicular to
 * every direction out of its own centroid; a cloak or a shield face lands there honestly and
 * must not be failed. An inside-out lathe is not near zero — the coarse head measured -0.94
 * and the fine skull -0.65 — so the bar sits well clear of both.
 */
const FAIL_AT = -0.15;
/** Components smaller than this are slivers and their centroid is noise. */
const MIN_TRIS = 6;
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

const out = await page.evaluate(async ({ only, lods, factions, minTris }) => {
  const mesh = await import('/src/units/soldierMesh.ts');
  const atlas = await import('/src/units/atlas.ts');
  const faceRect = atlas.matUv(atlas.Mat.Face);

  /** Is a UV inside a tile rect, with a texel of slack for the 3-px inset? */
  const inRect = (u, v, r) => u >= r.u0 - 2e-3 && u <= r.u1 + 2e-3 && v >= r.v0 - 2e-3 && v <= r.v1 + 2e-3;

  const one = (faction, lod) => {
    const geo = mesh.buildSoldierGeometry(faction, lod);
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const uvA = geo.getAttribute('uv');
    const pt = geo.getAttribute('aPieceTint');
    const idx = geo.getIndex();
    if (!idx) return { error: 'geometry is not indexed' };
    const nTri = idx.count / 3;

    // ---- weld by position ------------------------------------------------------------
    //
    // Two `revolve` calls that share a ring — the skull's face arc and its back arc, say —
    // emit separate vertices at identical positions. Welding is what makes them one shell,
    // and one shell is what makes "outward from its own centroid" mean anything.
    const weld = new Map();
    const wid = new Int32Array(pos.count);
    const Q = 1e5;
    for (let i = 0; i < pos.count; i++) {
      const k = `${Math.round(pos.getX(i) * Q)},${Math.round(pos.getY(i) * Q)},${Math.round(pos.getZ(i) * Q)}`;
      let w = weld.get(k);
      if (w === undefined) { w = weld.size; weld.set(k, w); }
      wid[i] = w;
    }

    // ---- connected components over shared welded vertices -----------------------------
    const parent = new Int32Array(nTri);
    for (let t = 0; t < nTri; t++) parent[t] = t;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const owner = new Map();
    for (let t = 0; t < nTri; t++) {
      for (let k = 0; k < 3; k++) {
        const v = wid[idx.getX(t * 3 + k)];
        const o = owner.get(v);
        if (o === undefined) owner.set(v, t); else union(t, o);
      }
    }

    // ---- per-triangle facts, gathered once --------------------------------------------
    const tri = new Array(nTri);
    let selfDisagree = 0, selfTested = 0;
    let faceTris = 0, faceForward = 0, faceZsum = 0;
    for (let t = 0; t < nTri; t++) {
      const i0 = idx.getX(t * 3), i1 = idx.getX(t * 3 + 1), i2 = idx.getX(t * 3 + 2);
      const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
      const e1 = [pos.getX(i1) - ax, pos.getY(i1) - ay, pos.getZ(i1) - az];
      const e2 = [pos.getX(i2) - ax, pos.getY(i2) - ay, pos.getZ(i2) - az];
      const w = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const wl = Math.hypot(w[0], w[1], w[2]);
      const c = [
        (ax + pos.getX(i1) + pos.getX(i2)) / 3,
        (ay + pos.getY(i1) + pos.getY(i2)) / 3,
        (az + pos.getZ(i1) + pos.getZ(i2)) / 3,
      ];
      tri[t] = { p: pt.getX(i0), w, wl, c, root: -1 };

      // (3) self-consistency, kept as a note.
      if (wl > 1e-14) {
        const nx = (nrm.getX(i0) + nrm.getX(i1) + nrm.getX(i2)) / 3;
        const ny = (nrm.getY(i0) + nrm.getY(i1) + nrm.getY(i2)) / 3;
        const nz = (nrm.getZ(i0) + nrm.getZ(i1) + nrm.getZ(i2)) / 3;
        const nl = Math.hypot(nx, ny, nz);
        if (nl > 1e-9) {
          selfTested++;
          if ((w[0] * nx + w[1] * ny + w[2] * nz) / (wl * nl) < 0) selfDisagree++;
        }
      }

      // (2) can the face be seen from in front? The man faces +Z.
      if (inRect(uvA.getX(i0), uvA.getY(i0), faceRect) && wl > 1e-14) {
        faceTris++;
        const z = w[2] / wl;
        faceZsum += z;
        if (z > 0) faceForward++;
      }
    }

    // ---- (1) outwardness, per component ------------------------------------------------
    const comps = new Map();
    for (let t = 0; t < nTri; t++) {
      const r = find(t);
      let g = comps.get(r);
      if (!g) { g = { tris: [], area2: 0 }; comps.set(r, g); }
      g.tris.push(t);
      g.area2 += tri[t].wl;
    }
    const rows = [];
    for (const g of comps.values()) {
      if (g.tris.length < minTris) continue;
      // Area-weighted centroid, so a dense pole ring does not drag it.
      const c0 = [0, 0, 0];
      let wsum = 0;
      for (const t of g.tris) { const T = tri[t]; c0[0] += T.c[0] * T.wl; c0[1] += T.c[1] * T.wl; c0[2] += T.c[2] * T.wl; wsum += T.wl; }
      if (wsum < 1e-12) continue;
      c0[0] /= wsum; c0[1] /= wsum; c0[2] /= wsum;
      let num = 0, den = 0;
      const pieces = new Map();
      const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
      for (const t of g.tris) {
        const T = tri[t];
        pieces.set(T.p, (pieces.get(T.p) ?? 0) + 1);
        for (let k = 0; k < 3; k++) { if (T.c[k] < min[k]) min[k] = T.c[k]; if (T.c[k] > max[k]) max[k] = T.c[k]; }
        const d = [T.c[0] - c0[0], T.c[1] - c0[1], T.c[2] - c0[2]];
        const dl = Math.hypot(d[0], d[1], d[2]);
        if (dl < 1e-6 || T.wl < 1e-14) continue;
        num += (T.w[0] * d[0] + T.w[1] * d[1] + T.w[2] * d[2]) / dl;
        den += T.wl;
      }
      let piece = -1, best = -1;
      for (const [k, n] of pieces) if (n > best) { best = n; piece = k; }
      rows.push({
        piece, tris: g.tris.length, out: den > 0 ? num / den : 0,
        cen: c0.map((v) => Number(v.toFixed(4))),
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((v) => Number(v.toFixed(3))),
      });
    }
    rows.sort((a, b) => a.out - b.out);

    // ---- (4) piece placement, unchanged in spirit ---------------------------------------
    const place = new Map();
    for (let t = 0; t < nTri; t++) {
      const T = tri[t];
      if (only >= 0 && T.p !== only) continue;
      let a = place.get(T.p);
      if (!a) { a = { piece: T.p, tris: 0, min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] }; place.set(T.p, a); }
      a.tris++;
      for (let k = 0; k < 3; k++) { if (T.c[k] < a.min[k]) a.min[k] = T.c[k]; if (T.c[k] > a.max[k]) a.max[k] = T.c[k]; }
    }

    return {
      faction, lod, totalTris: nTri, components: rows,
      selfDisagree, selfTested,
      face: { tris: faceTris, forward: faceForward, meanZ: faceTris ? faceZsum / faceTris : 0 },
      pieces: [...place.values()].map((a) => ({
        ...a,
        min: a.min.map((v) => Number(v.toFixed(4))),
        max: a.max.map((v) => Number(v.toFixed(4))),
      })).sort((x, y) => x.piece - y.piece),
    };
  };

  const runs = [];
  for (const f of factions) for (const l of lods) runs.push(one(f, l));
  return { runs };
}, { only: ONLY, lods: LODS, factions: FACTIONS, minTris: MIN_TRIS });

await browser.close();

const NAMES = {
  0: 'Head+arms', 1: 'HairShort', 2: 'HairLong', 3: 'Beard', 4: 'HelmGallic', 5: 'HelmRidge',
  6: 'HelmCoolus', 7: 'HelmSpangen', 8: 'HelmFur', 9: 'CrestTransverse', 10: 'CrestLongitudinal',
  11: 'CrestPlume', 12: 'CrestHorns', 13: 'Tunic', 14: 'Focale', 15: 'TorsoBare',
  16: 'Segmentata', 17: 'Mail', 18: 'Scale', 19: 'Leather', 20: 'LegsBare', 21: 'Trousers',
  22: 'Boots', 23: 'Cloak', 24: 'ShieldScutum', 25: 'ShieldOval', 26: 'ShieldRound',
  27: 'Sword', 28: 'Spear', 29: 'Axe', 30: 'Bow', 31: 'Quiver', 32: 'Pilum',
  33: 'JavelinBundle', 34: 'Torc', 35: 'SwordSheathed',
};
/** LOD2 is built by `buildFarGeometry` and has its own three-value piece enum. */
const COARSE = { 0: 'coarse Body', 1: 'coarse Kit', 2: 'coarse Shield' };
const FACTION = ['Rome', 'Germanic'];
const nameOf = (p, lod) => (lod === 2 ? COARSE[p] ?? `coarse ${p}` : NAMES[p] ?? String(p));

let failures = 0;
for (const r of out.runs) {
  if (r.error) { console.error(r.error); failures++; continue; }
  const tag = `${FACTION[r.faction] ?? r.faction} LOD${r.lod}`;
  console.log(`\n${'='.repeat(78)}\n${tag} — ${r.totalTris} triangles, ${r.components.length} welded components\n${'='.repeat(78)}`);

  // 1. Outwardness.
  const bad = r.components.filter((c) => c.out < FAIL_AT);
  const flat = r.components.filter((c) => c.out >= FAIL_AT && c.out < 0.10);
  console.log('\n(1) outwardness — winding against the direction out of the component\'s own centroid');
  console.log('    component (piece)          tris   outward   extent (m)            verdict');
  console.log('    ' + '-'.repeat(74));
  const show = [...bad, ...flat.slice(0, 3), ...r.components.filter((c) => c.out >= 0.10).slice(-3)];
  for (const c of show) {
    const verdict = c.out < FAIL_AT ? '*** INSIDE OUT ***' : c.out < 0.10 ? 'flat/open — ok' : 'ok';
    console.log(
      `    ${nameOf(c.piece, r.lod).padEnd(24)} ${String(c.tris).padStart(5)}   ${c.out.toFixed(3).padStart(7)}   ` +
      `${c.size.join(' x ').padEnd(20)}  ${verdict}`
    );
  }
  if (bad.length) {
    failures += bad.length;
    console.log(`    ${bad.length} component(s) wound inside out — \`side: FrontSide\` culls their near half.`);
  } else {
    console.log(`    all ${r.components.length} components wound outward (worst ${r.components[0].out.toFixed(3)}).`);
  }

  // 2. The face.
  const f = r.face;
  console.log('\n(2) the face, from in front of the man');
  if (!f.tris) {
    console.log(`    no \`Mat.Face\` triangles at this LOD.`);
  } else {
    const pct = (100 * f.forward) / f.tris;
    const ok = pct > 80;
    if (!ok) failures++;
    console.log(
      `    ${f.forward} of ${f.tris} face triangles wind towards +Z (${pct.toFixed(1)} %), mean z ${f.meanZ.toFixed(3)}` +
      `   ${ok ? 'ok' : '*** THE FACE IS FACING AWAY ***'}`
    );
  }

  // 3. Self-consistency, demoted.
  console.log('\n(3) shading normal versus its own winding (a note, not a gate — `quadFacing` derives one from the other)');
  console.log(`    ${r.selfDisagree} / ${r.selfTested} triangles disagree.`);
}

// 4. Placement, only when a piece was asked for.
if (ONLY >= 0) {
  console.log('\n(4) placement');
  for (const r of out.runs) {
    for (const p of r.pieces) {
      console.log(`    ${FACTION[r.faction]} LOD${r.lod} ${nameOf(p.piece, r.lod).padEnd(20)} ${String(p.tris).padStart(5)} tris   min ${p.min.join(', ')}   max ${p.max.join(', ')}`);
    }
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log(failures ? `FAIL — ${failures} finding(s).` : 'PASS — every component wound outward, and every face faces forward.');
if (errors.length) {
  console.error(`\n${errors.length} page error(s):`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.error(`  ${e}`);
}
process.exit(failures ? 1 : 0);
