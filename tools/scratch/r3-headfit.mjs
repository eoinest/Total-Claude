#!/usr/bin/env node
/**
 * `r3-headfit` — the head, measured off the built geometry rather than off a render.
 *
 * A rendered head plate answers "does this look like a head", which is the question that
 * matters, and answers it badly: the light, the tile and the framing all move under you, and
 * two of the three complaints round three has to close ("the silhouette is a straight vertical
 * edge", "no cheekbone, no chin") are statements about **shape**, which a photograph measures
 * only through whatever the sun happened to be doing.
 *
 * So this runs the shipped `buildSoldierGeometry` in the browser and reads the vertices.
 *
 * Four reports:
 *
 *   1. **Silhouette profile.** Half-width and half-depth of the skull, per 4 mm slab of
 *      height, in millimetres, beside the anthropometric target for a 1.75 m man. Plus the
 *      scale-free statistic the round is judged on: the **excursion** of the lateral edge
 *      between brow and chin as a percentage of the head's own maximum half-width, and the
 *      count of sign changes in its slope. A lathe has one sign change (it only ever narrows);
 *      a skull has three — in at the temple, out at the zygomatic, in at the jaw.
 *
 *   2. **Helmet clearance.** Every helmet bowl is a lathe over the same skull, and the skull
 *      just got deeper. For each helmet piece, the minimum signed gap between the bowl and the
 *      skull surface underneath it, and where it occurs. Negative is a head through a hat.
 *
 *   3. **Nose projection.** Each nose ring's front surface against the skull's own front at
 *      that height — the measurement the last two passes each got wrong in a different way,
 *      the first by taking it against the origin and the second by quoting a ring centre as
 *      if it were a surface.
 *
 *   4. **Triangles**, per piece and per tier, because the head is 6 % of a man and the frame
 *      has a budget.
 *
 * Usage:
 *   node tools/scratch/r3-headfit.mjs --port=5231
 *   node tools/scratch/r3-headfit.mjs --port=5231 --faction=1 --json=/tmp/r3-headfit.json
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5231);
const FACTION = Number(args.get('faction') ?? 0);
const JSONOUT = args.get('json') ?? null;
const BASE = `http://127.0.0.1:${PORT}`;

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 300000 });

const out = await page.evaluate(async ({ faction }) => {
  const mesh = await import('/src/units/soldierMesh.ts');
  const kit = await import('/src/units/kit.ts');
  const rig = await import('/src/anim/rig.ts');
  const P = kit.Piece;
  const MB = rig.MB;
  const headY = rig.MAN_RIG.restT[MB.head * 3 + 1];
  /*
   * The head bone is not on the model's z axis, and the first version of this probe reported
   * an occiput 102 mm deep because of it. Everything on the head is built through
   * `makeTranslation(0, headY, headZ)`, so a depth read straight off `position.z` carries
   * `headZ` added at the front and subtracted at the back — a 34 mm asymmetry, invented by
   * the measurement, on the one axis the measurement exists to report.
   */
  const headZ = rig.MAN_RIG.restT[MB.head * 3 + 2];

  /**
   * Skull, nose and neck are all `Piece.Head` — the piece tag is set once and stays live
   * through the neck, the arms and the hands, so it cannot separate them. The **bind** can:
   * the skull and the nose are `setBone(MB.head)` with weight 1 on one bone, the neck is
   * `setBone(MB.neck, MB.chest, 0.6)`, and the arms are on arm bones. Within what is left,
   * the nose is the tube — no ring of it reaches 30 mm off the midline, and no ring of the
   * skull is narrower than that below the crown.
   */
  const scan = (lod) => {
    const geo = mesh.buildSoldierGeometry(faction, lod);
    const pos = geo.getAttribute('position');
    const pt = geo.getAttribute('aPieceTint');
    const sk = geo.getAttribute('aSkin');
    const idx = geo.getIndex();
    const tris = new Map();
    for (let t = 0; t < idx.count; t += 3) {
      const p = pt.getX(idx.getX(t));
      tris.set(p, (tris.get(p) ?? 0) + 1);
    }
    const SLAB = 0.002;
    /** Twelve 30-degree sectors of the ring, so a hat is compared to the head under it. */
    const AZ = 12;
    const azBucket = (x, z) => {
      const a = Math.atan2(z, x);
      return Math.min(AZ - 1, Math.max(0, Math.floor(((a + Math.PI) / (Math.PI * 2)) * AZ)));
    };
    const raw = new Map();      // slab -> skull envelope, head-bone only
    const hairRaw = new Map();  // slab -> hair envelope
    const bowls = new Map();    // piece -> slab -> radius
    for (let i = 0; i < pos.count; i++) {
      const piece = pt.getX(i);
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i) - headZ;
      const ly = y - headY;
      if (ly < -0.12 || ly > 0.22) continue;
      const key = Math.round(ly / SLAB);
      const isHair = piece === P.HairShort || piece === P.HairLong;
      if (piece === P.Head || isHair) {
        if (sk.getX(i) !== MB.head || sk.getY(i) !== MB.head) continue;   // neck, arms, hands
        // ...and the neck tube's top node, which names `MB.head` as its bone but is built in
        // model space with no head matrix, so subtracting `headZ` from it invents a 45 mm
        // front-to-back asymmetry that is purely the measurement's.
        if (Math.abs(ly + 0.04) < 1e-4) continue;
        const bag = isHair ? hairRaw : raw;
        let s = bag.get(key);
        if (!s) bag.set(key, s = { y: key * SLAB, w: 0, zf: -9, zb: -9, n: 0, r: new Array(AZ).fill(0) });
        s.n++;
        if (Math.abs(x) > s.w) s.w = Math.abs(x);
        if (z > s.zf) s.zf = z;
        if (-z > s.zb) s.zb = -z;
        const b = azBucket(x, z);
        const rr = Math.hypot(x, z);
        if (rr > s.r[b]) s.r[b] = rr;
      } else if (piece >= P.HelmGallic && piece <= P.HelmSpangen) {
        let s = bowls.get(piece);
        if (!s) bowls.set(piece, s = new Map());
        const cur = s.get(key) ?? { y: key * SLAB, r: new Array(AZ).fill(0) };
        const rr = Math.hypot(x, z);
        const b = azBucket(x, z);
        if (rr > cur.r[b]) cur.r[b] = rr;
        s.set(key, cur);
      }
    }
    const all = [...raw.values()].sort((a, b) => b.y - a.y);
    const skull = all.filter((s) => s.w > 0.030 || s.y > 0.130);
    const nose = all.filter((s) => s.w <= 0.030 && s.y <= 0.130);
    const hair = [...hairRaw.values()].sort((a, b) => b.y - a.y);
    return {
      lod,
      tris: [...tris.entries()],
      skull, nose, hair,
      bowls: [...bowls.entries()].map(([p, m]) => [p, [...m.values()].sort((a, b) => b.y - a.y)]),
    };
  };
  const pieceNames = Object.fromEntries(
    Object.entries(P).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k])
  );
  return { lod0: scan(0), lod1: scan(1), pieceNames, headY, headZ };
}, { faction: FACTION });

/** Piecewise-linear silhouette from a slab list, in the field named. */
const curve = (slabs, field) => {
  const pts = slabs.map((s) => [s.y, s[field]]).sort((a, b) => b[0] - a[0]);
  return (y) => {
    // Above the crown there is no head, so a bowl there clears everything. Returning the
    // topmost sample instead reported the ridge helmet's own apex as a zero-gap collision
    // with a head 20 mm below it.
    if (y > pts[0][0]) return null;
    for (let i = 1; i < pts.length; i++) {
      if (y >= pts[i][0]) {
        const f = (y - pts[i][0]) / (pts[i - 1][0] - pts[i][0]);
        return pts[i][1] + (pts[i - 1][1] - pts[i][1]) * f;
      }
    }
    return null;   // below the chin: there is no head here
  };
};

// ---------------------------------------------------------------------------
// 1. Silhouette
// ---------------------------------------------------------------------------
const mm = (v) => (v * 1000).toFixed(1);
/** Anthropometric half-breadth for a 1.75 m man, metres above the head bone -> metres. */
const TARGET_W = [[0.052, 0.076], [0.012, 0.0695], [-0.048, 0.053], [-0.072, 0.026]];
console.log(`\nr3-headfit — faction ${FACTION}, head bone at y=${(out.headY).toFixed(3)} z=${(out.headZ).toFixed(4)}\n`);
console.log('LOD0 skull, by 4 mm slab:');
console.log('   y(mm)   halfW   halfZfront  halfZback   depth/width');
const sl = out.lod0.skull;
for (const s of sl) {
  console.log(
    `  ${(s.y * 1000).toFixed(0).padStart(6)}  ${mm(s.w).padStart(6)}  ` +
    `${mm(s.zf).padStart(10)}  ${mm(s.zb).padStart(9)}   ${((s.zf + s.zb) / (2 * s.w)).toFixed(2)}`
  );
}
// The statistic: excursion of the lateral edge from brow to chin.
const band = sl.filter((s) => s.y <= 0.060 && s.y >= -0.070).sort((a, b) => b.y - a.y);
const wmax = Math.max(...band.map((s) => s.w));
const wmin = Math.min(...band.map((s) => s.w));
let signs = 0;
for (let i = 2; i < band.length; i++) {
  const d0 = band[i - 1].w - band[i - 2].w;
  const d1 = band[i].w - band[i - 1].w;
  if (d0 * d1 < -1e-9) signs++;
}
console.log(`\n  brow-to-chin half-width:  max ${mm(wmax)} mm, min ${mm(wmin)} mm`);
console.log(`  EXCURSION                 ${(((wmax - wmin) / wmax) * 100).toFixed(1)} % of max half-width`);
console.log(`  slope sign changes        ${signs}   (a lathe that only narrows has 0-1; a skull has 3)`);
const cheek = sl.find((s) => Math.abs(s.y - 0.012) < 0.003);
if (cheek) console.log(`  depth/width at the cheek  ${((cheek.zf + cheek.zb) / (2 * cheek.w)).toFixed(2)}   (a man is 1.40; a lathe is 1.00)`);
for (const [ty, tw] of TARGET_W) {
  const got = sl.find((s) => Math.abs(s.y - ty) < 0.003);
  if (got) console.log(`  at y=${(ty * 1000).toFixed(0).padStart(4)} mm: half-width ${mm(got.w)} mm against a target of ${mm(tw)} mm`);
}

// ---------------------------------------------------------------------------
// 2. Helmet clearance
// ---------------------------------------------------------------------------
console.log('\nhelmet clearance (bowl radius minus the outer of skull and hair, same height):');
const skullW = curve(sl, 'w');
const skullF = curve(sl, 'zf');
const skullB = curve(sl, 'zb');
const hairW = curve(out.lod0.hair, 'w');
const hairF = curve(out.lod0.hair, 'zf');
const hairB = curve(out.lod0.hair, 'zb');
/**
 * What a bowl actually has to clear is the **outer** of skull and hair, not the skull.
 * Every man in this game wears hair, and the hair cap is 7 to 9 mm proud of the skull all
 * the way round, so a bowl sized to the skull is a bowl with a hair dome coming out of it —
 * which is what the elevated plate shows and what nobody had measured.
 */
const skullMax = (y) => {
  const a = skullW(y), b = skullF(y), c = skullB(y);
  const ha = hairW(y), hb = hairF(y), hc = hairB(y);
  const s = (a === null || b === null || c === null) ? -9 : Math.max(a, b, c);
  const h = (ha === null || hb === null || hc === null) ? -9 : Math.max(ha, hb, hc);
  const m = Math.max(s, h);
  return m < 0 ? null : m;
};
const crown = Math.max(...sl.map((s) => s.y), ...out.lod0.hair.map((s) => s.y));
const envBucket = (y, b) => {
  const pick = (slabs) => {
    const pts = slabs.map((s) => [s.y, s.r[b]]).filter((q) => q[1] > 0).sort((p, q) => q[0] - p[0]);
    if (!pts.length || y > pts[0][0] || y < pts[pts.length - 1][0]) return null;
    for (let i = 1; i < pts.length; i++) {
      if (y >= pts[i][0]) {
        const f = (y - pts[i][0]) / (pts[i - 1][0] - pts[i][0]);
        return pts[i][1] + (pts[i - 1][1] - pts[i][1]) * f;
      }
    }
    return null;
  };
  const a = pick(sl), h = pick(out.lod0.hair);
  const m = Math.max(a ?? -9, h ?? -9);
  return m < 0 ? null : m;
};
for (const [piece, rings] of out.lod0.bowls) {
  let worst = { gap: 1e9, y: 0, b: 0 };
  const apex = Math.max(...rings.map((r) => r.y));
  for (const r of rings) {
    for (let b = 0; b < r.r.length; b++) {
      if (r.r[b] <= 0) continue;
      const e = envBucket(r.y, b);
      if (e === null) continue;
      const gap = r.r[b] - e;
      if (gap < worst.gap) worst = { gap, y: r.y, b };
    }
  }
  const name = out.pieceNames[piece] ?? piece;
  const flag = worst.gap < 0 ? '  <-- SKULL THROUGH HAT' : worst.gap < 0.002 ? '  <-- tight' : '';
  const over = crown - apex;
  console.log(
    `  ${String(name).padEnd(14)} min gap ${mm(worst.gap).padStart(7)} mm at y=${(worst.y * 1000).toFixed(0).padStart(4)} mm, sector ${worst.b}${flag}` +
    (over > 0.001 ? `   [crown stands ${mm(over)} mm above the bowl apex]` : '')
  );
}

// ---------------------------------------------------------------------------
// 3. Nose projection
// ---------------------------------------------------------------------------
console.log('\nnose, front surface against the skull front at the same height:');
for (const c of out.lod0.nose) {
  const sf = skullF(c.y);
  if (sf === null) continue;
  console.log(`  y=${(c.y * 1000).toFixed(0).padStart(4)} mm   nose front ${mm(c.zf).padStart(6)}   skull front ${mm(sf).padStart(6)}   proud ${mm(c.zf - sf).padStart(6)} mm   half-width ${mm(c.w)} mm`);
}

// ---------------------------------------------------------------------------
// 4. Triangles
// ---------------------------------------------------------------------------
for (const tier of [out.lod0, out.lod1]) {
  const total = tier.tris.reduce((a, [, n]) => a + n, 0);
  const head = tier.tris.filter(([p]) => {
    const n = out.pieceNames[p] ?? '';
    return n === 'Head' || n.startsWith('Hair') || n === 'Beard' || n.startsWith('Helm') || n === 'Cap';
  }).reduce((a, [, n]) => a + n, 0);
  console.log(`\nLOD${tier.lod}: ${total} triangles total, ${head} on the head and what is on it (${((head / total) * 100).toFixed(1)} %)`);
}

if (JSONOUT) { await writeFile(JSONOUT, JSON.stringify(out, null, 1)); console.log(`\njson -> ${JSONOUT}`); }
if (errors.length) console.log(`\npage errors:\n  ${errors.slice(0, 5).join('\n  ')}`);
await browser.close();
