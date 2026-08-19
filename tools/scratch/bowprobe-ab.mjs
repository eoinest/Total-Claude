#!/usr/bin/env node
/**
 * Archer-bow probe. Measures, per faction and LOD:
 *   - total triangles / vertices
 *   - Piece.WeaponBow (30) triangles / vertices / AABB
 *   - a stable hash of the LOD2 buffers, so "LOD2 unchanged" is proven, not asserted
 * Plus the drawBow pose's hand separation, which is where a bowstring's nock has to be.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5241);
const BASE = `http://127.0.0.1:${PORT}`;

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }
console.log(`bowprobe — live server on ${PORT}`);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 180000 });

const out = await page.evaluate(async () => {
  const mesh = await import('/src/units/soldierMesh.ts');
  const { MAN_RIG, MB } = await import('/src/anim/rig.ts');
  const { MAN_CLIP_SET } = await import('/src/anim/clips.ts');
  const { sampleGlobals } = await import('/src/anim/pose.ts');

  const fnv = (arr) => {
    let h = 0x811c9dc5 >>> 0;
    const dv = new DataView(new ArrayBuffer(4));
    for (let i = 0; i < arr.length; i++) {
      dv.setFloat32(0, arr[i], true);
      for (let b = 0; b < 4; b++) { h ^= dv.getUint8(b); h = Math.imul(h, 0x01000193) >>> 0; }
    }
    return h.toString(16).padStart(8, '0');
  };
  const fnvI = (arr) => {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < arr.length; i++) {
      let v = arr[i] >>> 0;
      for (let b = 0; b < 4; b++) { h ^= (v >>> (b * 8)) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
    }
    return h.toString(16).padStart(8, '0');
  };

  const BOW = 30;
  const rows = [];
  for (const f of [0, 1, 2]) {
    for (const lod of [0, 1, 2]) {
      const geo = mesh.buildSoldierGeometry(f, lod);
      const pos = geo.getAttribute('position');
      const pt = geo.getAttribute('aPieceTint');
      const idx = geo.getIndex();
      const tris = idx.count / 3;
      let bowTris = 0;
      const bb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
      const bowVerts = new Set();
      for (let t = 0; t < idx.count; t += 3) {
        const i0 = idx.getX(t);
        if (pt.getX(i0) !== BOW) continue;
        bowTris++;
        for (const i of [i0, idx.getX(t + 1), idx.getX(t + 2)]) {
          bowVerts.add(i);
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z;
          if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
        }
      }
      const hashes = {};
      for (const name of Object.keys(geo.attributes).sort()) {
        const a = geo.attributes[name];
        if (a.isInstancedBufferAttribute) continue;
        hashes[name] = fnv(a.array);
      }
      hashes.index = fnvI(idx.array);
      rows.push({
        faction: f, lod, tris, verts: pos.count, bowTris,
        bowVerts: bowVerts.size,
        bowBox: bowTris ? bb.map((v) => Number(v.toFixed(4))) : null,
        hashes,
      });
      geo.dispose();
    }
  }

  // drawBow pose: where the two hands are, in the posed world the bow socket lives in.
  const clip = MAN_CLIP_SET.clips[MAN_CLIP_SET.index('drawBow')];
  const q = new Float32Array(MAN_RIG.boneCount * 4);
  const t3 = new Float32Array(MAN_RIG.boneCount * 3);
  const poses = {};
  for (const time of [0.0, 0.3, 0.6, 0.9]) {
    sampleGlobals(MAN_RIG, clip, time, q, t3);
    const g = (b) => [t3[b * 3], t3[b * 3 + 1], t3[b * 3 + 2]].map((v) => Number(v.toFixed(4)));
    const hL = g(MB.handL), hR = g(MB.handR);
    poses[time] = {
      handL: hL, handR: hR, head: g(MB.head),
      rMinusL: [hR[0] - hL[0], hR[1] - hL[1], hR[2] - hL[2]].map((v) => Number(v.toFixed(4))),
      dist: Number(Math.hypot(hR[0] - hL[0], hR[1] - hL[1], hR[2] - hL[2]).toFixed(4)),
    };
  }
  return { rows, poses };
});

await browser.close();
if (errors.length) { console.log('ERRORS:'); for (const e of errors) console.log('  ' + e); }
console.log(JSON.stringify(out, null, 1));
