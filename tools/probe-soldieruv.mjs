#!/usr/bin/env node
/**
 * UV probe for the soldier mesh — texel density and tile seams, measured per triangle.
 *
 * Two defects live in the UV attribute and neither is visible in a battle screenshot at
 * 20 px a man, which is how both survived every blind round this project has run:
 *
 *   1. **Reversed tile columns.** A tile repeat used to be `(s * repeat) % 1` evaluated per
 *      vertex, and a modulo between two vertices does not wrap the surface between them: it
 *      runs the whole tile backwards, compressed into one segment's width. Every closed ring
 *      had at least one — `tube`, `revolve` and `sweep` all close with `(s + 1) % segments`
 *      and reuse vertex 0, whose u is the tile's *start*. This probe finds them by asking
 *      whether a triangle's UV area per unit of world area is wildly out of line with the
 *      median for its own piece. A reversed column is 5-15x, and it is close to pure energy
 *      at the 1 px band — the one octave where our models separate from Rome II's.
 *
 *   2. **Texel density**, which the handoff records as failing in both directions at once.
 *      Reported here as texels per metre using the atlas's real pixel size, so a 26 mm eye
 *      box carrying a whole 128 px tile (4,900 tx/m) and a 1 m torso carrying one (128 tx/m)
 *      are visible as the two ends of the same table rather than as a vague complaint.
 *
 * It runs the shipped `buildSoldierGeometry` in the browser, so it measures the builder
 * rather than a re-implementation of it.
 *
 * Usage:
 *   node tools/probe-soldieruv.mjs --port=5302
 *   node tools/probe-soldieruv.mjs --port=5302 --lod=1 --faction=1 --json=out.json
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5302);
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * Atlas pixels — a **fallback**, overwritten from the live module before use.
 *
 * These were hard-coded at 1024 x 1536 with a comment saying they "must agree with
 * `atlas.ts`; a mismatch only scales the table". The sheet then went to 2048 x 1536 and this
 * file did not, so every texel-density figure it printed would have been half the truth, with
 * no error, because a scaled table still looks like a table. Two files that must agree with
 * only one of them a source of truth is the arrangement that also let the emblem grid drift.
 * Take the number from the module that owns it.
 */
let ATLAS_W = 2048;
let ATLAS_H = 1536;

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) {
  console.error(`No dev server on ${PORT}. A probe that silently falls back to a stale dist/`);
  console.error('has reported 5/12 on a tree that scored 12/12 — start a server and pass --port.');
  process.exit(2);
}
console.log(`probe-soldieruv — live server on ${PORT}\n`);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 180000 });

const live = await page.evaluate(async () => {
  const a = await import('/src/units/atlas.ts');
  return { w: a.ATLAS_W, h: a.ATLAS_H };
});
if (!Number.isFinite(live.w) || !Number.isFinite(live.h)) {
  console.error('atlas.ts did not export ATLAS_W/ATLAS_H; refusing to guess the sheet size.');
  process.exit(2);
}
if (live.w !== ATLAS_W || live.h !== ATLAS_H) {
  console.log(`atlas is ${live.w}x${live.h}, this file's fallback said ${ATLAS_W}x${ATLAS_H} — using the live one\n`);
}
ATLAS_W = live.w;
ATLAS_H = live.h;

const out = await page.evaluate(async ({ aw, ah }) => {
  const mesh = await import('/src/units/soldierMesh.ts');
  const result = { arms: [] };

  for (const faction of [0, 1]) {
    for (const lod of [0, 1, 2]) {
      const geo = mesh.buildSoldierGeometry(faction, lod);
      const pos = geo.getAttribute('position');
      const uv = geo.getAttribute('uv');
      const pt = geo.getAttribute('aPieceTint');
      const idx = geo.getIndex();

      /** piece -> { tris, ratios[] } where ratio = uv-texels^2 per world m^2. */
      const per = new Map();
      for (let t = 0; t < idx.count; t += 3) {
        const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
        const p = pt.getX(i0);
        // World area.
        const e1 = [pos.getX(i1) - pos.getX(i0), pos.getY(i1) - pos.getY(i0), pos.getZ(i1) - pos.getZ(i0)];
        const e2 = [pos.getX(i2) - pos.getX(i0), pos.getY(i2) - pos.getY(i0), pos.getZ(i2) - pos.getZ(i0)];
        const cx = e1[1] * e2[2] - e1[2] * e2[1];
        const cy = e1[2] * e2[0] - e1[0] * e2[2];
        const cz = e1[0] * e2[1] - e1[1] * e2[0];
        const wa = 0.5 * Math.hypot(cx, cy, cz);
        // UV area in texels.
        const du1 = (uv.getX(i1) - uv.getX(i0)) * aw, dv1 = (uv.getY(i1) - uv.getY(i0)) * ah;
        const du2 = (uv.getX(i2) - uv.getX(i0)) * aw, dv2 = (uv.getY(i2) - uv.getY(i0)) * ah;
        const ta = 0.5 * Math.abs(du1 * dv2 - du2 * dv1);
        if (wa < 1e-9) continue;
        let a = per.get(p);
        if (!a) { a = { piece: p, tris: 0, d: [] }; per.set(p, a); }
        a.tris++;
        // texels per metre, isotropic equivalent.
        a.d.push(Math.sqrt(ta / wa));
      }

      /**
       * Stretch, not an outlier count.
       *
       * The first version of this probe counted triangles above 4x their own piece's median
       * density, and that number went *up* across a fix that halved every affected maximum —
       * because a piece bundles many primitives (the skull lathe, two hand boxes and two eye
       * boxes are all `Piece.Head`) so the median it is measured against moves too. The
       * ratio of the worst triangle to the median is an absolute statement about the same
       * surface and does not have that failure mode: a seam column is the whole tile across
       * one segment's width, so it lands at `segments` times its neighbours.
       */
      const pct = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
      let total = 0;
      let uvArea = 0;
      const pieces = [];
      for (const a of per.values()) {
        const m = pct(a.d, 0.5);
        total += a.tris;
        for (const v of a.d) uvArea += v * v;
        pieces.push({
          piece: a.piece, tris: a.tris,
          medianTexelsPerM: m,
          maxTexelsPerM: Math.max(...a.d),
          p99TexelsPerM: pct(a.d, 0.99),
          stretch: m > 0 ? Math.max(...a.d) / m : 0,
        });
      }
      pieces.sort((x, y) => y.stretch - x.stretch);
      const dens = pieces.filter((p) => p.tris >= 8).map((p) => p.medianTexelsPerM).sort((x, y) => x - y);
      result.arms.push({
        faction, lod,
        vertices: pos.count,
        triangles: idx.count / 3,
        totalTris: total,
        /** Sum over triangles of (texels/m)^2 — the total texture the mesh asks for. */
        uvLoad: uvArea,
        worstStretch: Math.max(...pieces.map((p) => p.stretch)),
        meanStretch: pieces.reduce((s, p) => s + p.stretch, 0) / pieces.length,
        densitySpread: dens.length ? dens[dens.length - 1] / dens[0] : 0,
        densityMin: dens[0] ?? 0,
        densityMax: dens[dens.length - 1] ?? 0,
        pieces,
      });
      geo.dispose();
    }
  }
  return result;
}, { aw: ATLAS_W, ah: ATLAS_H });

await browser.close();

const NAMES = {
  0: 'Head+arms', 1: 'HairShort', 2: 'HairLong', 3: 'Beard', 4: 'HelmGallic', 5: 'HelmRidge',
  6: 'HelmCoolus', 7: 'HelmSpangen', 8: 'HelmFur', 9: 'CrestTransverse', 10: 'CrestLongitudinal',
  11: 'CrestPlume', 12: 'CrestHorns', 13: 'Tunic', 14: 'Focale', 15: 'TorsoBare',
  16: 'Segmentata', 17: 'Mail', 18: 'Scale', 19: 'Leather', 20: 'LegsBare', 21: 'Trousers',
  22: 'Boots', 23: 'Cloak', 24: 'ShieldScutum', 25: 'ShieldOval', 26: 'ShieldRound',
  27: 'Sword', 28: 'Spear', 29: 'Axe', 30: 'Bow', 31: 'Quiver', 32: 'Pilum',
  33: 'JavelinBundle', 34: 'Torc', 35: 'SwordSheathed', 36: 'HelmAttic', 37: 'HelmIberian',
  38: 'ShieldHoplon', 39: 'ShieldCaetra', 40: 'Falcata', 41: 'Sling', 42: 'SlingPouch',
  43: 'ArmourLinen', 44: 'Greaves',
};

console.log('faction lod   verts    tris   worst stretch   mean stretch   density spread');
console.log('-'.repeat(76));
for (const a of out.arms) {
  console.log(
    `${a.faction === 0 ? 'Rome  ' : 'Germ  '}  ${a.lod}  ${String(a.vertices).padStart(6)}  ${String(a.triangles).padStart(6)}   ${a.worstStretch.toFixed(1).padStart(11)}   ${a.meanStretch.toFixed(2).padStart(12)}   ${a.densityMin.toFixed(0)}..${a.densityMax.toFixed(0)} (${a.densitySpread.toFixed(1)}x)`
  );
}

// Detail for Rome LOD0, which is what the isolated-model deck photographs.
const r0 = out.arms.find((a) => a.faction === 0 && a.lod === 0);
console.log('\nRome LOD0 by piece — worst UV stretch first');
console.log('piece                 tris   median tx/m    p99 tx/m    max tx/m   stretch');
console.log('-'.repeat(74));
for (const p of r0.pieces.slice(0, 22)) {
  console.log(
    `${String(NAMES[p.piece] ?? p.piece).padEnd(20)} ${String(p.tris).padStart(5)}   ${p.medianTexelsPerM.toFixed(0).padStart(9)}   ${p.p99TexelsPerM.toFixed(0).padStart(9)}   ${p.maxTexelsPerM.toFixed(0).padStart(9)}   ${p.stretch.toFixed(1).padStart(6)}`
  );
}
console.log('-'.repeat(74));
console.log(`Rome LOD0  worst stretch ${r0.worstStretch.toFixed(1)}x   mean ${r0.meanStretch.toFixed(2)}x   uvLoad ${(r0.uvLoad / 1e6).toFixed(2)}M`);
console.log(`texel density across pieces >= 8 tris: ${r0.densityMin.toFixed(0)} .. ${r0.densityMax.toFixed(0)} tx/m (${r0.densitySpread.toFixed(1)}x)`);

if (args.has('json')) {
  writeFileSync(args.get('json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n→ ${args.get('json')}`);
}
if (errors.length) {
  console.error(`\n${errors.length} page error(s):`);
  for (const e of [...new Set(errors)].slice(0, 8)) console.error(`  ${e}`);
}
process.exit(0);
