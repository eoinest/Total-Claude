#!/usr/bin/env node
/**
 * `fr-headgeom` — the three head numbers the face/round-three reconciliation turns on,
 * measured off the shipped `buildSoldierGeometry` rather than read off the source.
 *
 * 1. **Winding against the outward radial.** Not against the shading normal — `quadFacing`
 *    derives the winding *from* the normal, so the two can never disagree and a probe that
 *    compares them cannot fail. The head is a lathe about a known axis, so "outward" has an
 *    external definition: the horizontal vector from that axis to the triangle's centroid.
 *    Reported over the **face arc** (the `Mat.Face` tile) and over the back arc separately,
 *    because the defect this exists to catch culled exactly one of the two.
 *
 * 2. **The lateral silhouette.** Half-width per profile ring, taken as the largest |x| the
 *    skull reaches in a thin y band — which is what a camera in front of the man sees as his
 *    outline. Excursion brow-to-chin as a percentage of the half-width at the parietal, and
 *    the number of slope-sign changes down that edge. A lathe with a taper on it scores one
 *    monotone slope and a few per cent; a skull with a zygomatic arch and a jaw angle does
 *    not.
 *
 * 3. **Triangle counts**, per faction per LOD, so a change to the head can be handed to the
 *    performance work as a number rather than an impression.
 *
 * Usage: node tools/scratch/fr-headgeom.mjs --port=5911 [--json=/tmp/x.json]
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5911);
const JSON_OUT = args.get('json') ?? null;
const BASE = `http://127.0.0.1:${PORT}`;

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 300000 });

const out = await page.evaluate(async () => {
  const mesh = await import('/src/units/soldierMesh.ts');
  const atlas = await import('/src/units/atlas.ts');
  const rig = await import('/src/anim/rig.ts');

  const faceRect = atlas.matUv(atlas.Mat.Face);
  const skinRect = atlas.matUv(atlas.Mat.Skin);
  const headZ = rig.MAN_RIG.restT[rig.MB.head * 3 + 2];
  const headY = rig.MAN_RIG.restT[rig.MB.head * 3 + 1];

  /** Is a UV inside a tile rect, with a texel of slack for the inset? */
  const inRect = (u, v, r) => u >= r.u0 - 2e-3 && u <= r.u1 + 2e-3 && v >= r.v0 - 2e-3 && v <= r.v1 + 2e-3;

  const measure = (faction, lod) => {
    const geo = mesh.buildSoldierGeometry(faction, lod);
    const pos = geo.getAttribute('position');
    const uvA = geo.getAttribute('uv');
    const pt = geo.getAttribute('aPieceTint');
    const idx = geo.getIndex();
    const tris = idx.count / 3;

    // --- 1. winding vs outward radial, over the two arcs of the skull ------------------
    const arcs = {
      face: { n: 0, inward: 0, dot: 0 },
      back: { n: 0, inward: 0, dot: 0 },
    };
    // --- 2. lateral silhouette: largest |x| per y, over skull triangles ----------------
    //
    // By **edge crossing**, not by binning the vertices. A lathe only has vertices at its
    // own ring heights, so binning leaves most rows empty and fills them from whatever else
    // happens to be at that height — on the first version of this probe the nose's own tube
    // rings, 19 mm wide, landed between the skull's and the "silhouette" dropped to 19 mm
    // five times on the way down the cheek. Interpolating along every triangle edge that
    // crosses the sample plane is what the rasteriser does and is the only honest answer.
    const BINS = 260, Y0 = -0.10, Y1 = 0.16;
    const half = new Float64Array(BINS).fill(-1);
    const span = (Y1 - Y0) / BINS;
    const cross = (p, q) => {
      const ya = p[1] - headY, yb = q[1] - headY;
      if (ya === yb) return;
      const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
      let b0 = Math.ceil(((lo - Y0) / span) - 0.5);
      const b1 = Math.floor(((hi - Y0) / span) - 0.5);
      if (b0 < 0) b0 = 0;
      for (let bi = b0; bi <= Math.min(b1, BINS - 1); bi++) {
        const y = Y0 + (bi + 0.5) * span;
        const t = (y - ya) / (yb - ya);
        if (t < 0 || t > 1) continue;
        const x = Math.abs(p[0] + (q[0] - p[0]) * t);
        if (x > half[bi]) half[bi] = x;
      }
    };

    const g = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)];
    for (let t = 0; t < idx.count; t += 3) {
      const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
      if (pt.getX(i0) !== 0) continue;                   // Piece.Head only (head + arms + hands)
      const a = g(i0), b = g(i1), c = g(i2);
      const cy = (a[1] + b[1] + c[1]) / 3 - headY;
      // The skull's own y band, relative to the head bone. Arms and hands are far below it.
      if (cy < -0.10 || cy > 0.16) continue;
      const u0 = uvA.getX(i0), v0 = uvA.getY(i0);
      const isFace = inRect(u0, v0, faceRect);
      const isSkin = inRect(u0, v0, skinRect);
      if (!isFace && !isSkin) continue;

      // Outward radial from the lathe's own axis (x = 0, z = headZ).
      const cx = (a[0] + b[0] + c[0]) / 3;
      const cz = (a[2] + b[2] + c[2]) / 3 - headZ;
      const rl = Math.hypot(cx, cz);
      if (rl > 1e-4) {
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const w = [
          e1[1] * e2[2] - e1[2] * e2[1],
          e1[2] * e2[0] - e1[0] * e2[2],
          e1[0] * e2[1] - e1[1] * e2[0],
        ];
        const wl = Math.hypot(w[0], w[1], w[2]);
        if (wl > 1e-14) {
          const d = (w[0] * cx + w[2] * cz) / (wl * rl);
          const k = isFace ? arcs.face : arcs.back;
          k.n++; k.dot += d; if (d < 0) k.inward++;
        }
      }

      // Silhouette: the outline a camera in front of the man sees is the extreme |x|.
      cross(a, b); cross(b, c); cross(c, a);
    }

    const at = (y) => {
      const bi = Math.round((y - Y0) / span - 0.5);
      for (let k = 0; k < 8; k++) {
        if (bi - k >= 0 && half[bi - k] > 0) return half[bi - k];
        if (bi + k < BINS && half[bi + k] > 0) return half[bi + k];
      }
      return 0;
    };

    // Brow (BROW_Y = 0.054) down to the chin (-0.072), which is the band a grader looks at.
    const edge = [];
    for (let bi = 0; bi < BINS; bi++) {
      const y = Y0 + (bi + 0.5) * span;
      if (y < -0.072 || y > 0.054) continue;
      if (half[bi] > 0) edge.push([y, half[bi]]);
    }
    // Five-tap smooth: one aliased ring must not be able to manufacture an inflection.
    const sm = edge.map((_, i) => {
      let s = 0, c = 0;
      for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < edge.length) { s += edge[j][1]; c++; } }
      return s / c;
    });
    const parietal = at(0.048);
    const jaw = at(-0.055);
    const p2p = sm.length ? Math.max(...sm) - Math.min(...sm) : 0;
    // Slope-sign changes down the edge, on the smoothed series, ignoring flat runs.
    let signs = 0, prev = 0;
    for (let i = 1; i < sm.length; i++) {
      const d = sm[i] - sm[i - 1];
      if (Math.abs(d) < 2e-5) continue;
      const s = Math.sign(d);
      if (prev !== 0 && s !== prev) signs++;
      prev = s;
    }
    return {
      faction, lod, tris,
      face: arcs.face, back: arcs.back,
      parietalMm: parietal * 1000, jawMm: jaw * 1000,
      excursionPct: parietal > 0 ? (p2p / parietal) * 100 : 0,
      slopeSignChanges: signs,
      edgeRows: sm.length,
    };
  };

  const rows = [];
  for (const f of [0, 1]) for (const l of [0, 1, 2]) rows.push(measure(f, l));
  return { rows, headZ, headY };
});

await browser.close();

const F = ['Rome', 'Germanic'];
console.log('\nfr-headgeom — winding, silhouette and triangles off the shipped builder\n');
console.log('faction   lod   tris   face-arc tris  inward  meanDot | back-arc tris inward meanDot');
console.log('-'.repeat(96));
for (const r of out.rows) {
  const fd = r.face.n ? r.face.dot / r.face.n : 0;
  const bd = r.back.n ? r.back.dot / r.back.n : 0;
  console.log(
    `${F[r.faction].padEnd(9)} ${r.lod}  ${String(r.tris).padStart(5)}   ` +
    `${String(r.face.n).padStart(11)}  ${String(r.face.inward).padStart(6)}  ${fd.toFixed(3).padStart(6)} | ` +
    `${String(r.back.n).padStart(9)} ${String(r.back.inward).padStart(6)} ${bd.toFixed(3).padStart(7)}`
  );
}
console.log('\nfaction   lod   half-width parietal / jaw (mm)   excursion brow->chin   slope-sign changes');
console.log('-'.repeat(96));
for (const r of out.rows) {
  console.log(
    `${F[r.faction].padEnd(9)} ${r.lod}   ${r.parietalMm.toFixed(1).padStart(8)} / ${r.jawMm.toFixed(1).padEnd(8)}        ` +
    `${r.excursionPct.toFixed(1).padStart(6)} %             ${r.slopeSignChanges}   (${r.edgeRows} rows)`
  );
}
const tot = (f) => out.rows.filter((r) => r.faction === f).map((r) => `LOD${r.lod} ${r.tris}`).join('  ');
console.log(`\nRome:     ${tot(0)}`);
console.log(`Germanic: ${tot(1)}`);
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify(out, null, 2));
if (errors.length) console.log(`\npage errors:\n  ${[...new Set(errors)].slice(0, 6).join('\n  ')}`);
