#!/usr/bin/env node
/**
 * The ground judge's monument instrument: **is a monument the shape of itself, is it standing
 * on ground that exists, and is it standing in the river?**
 *
 *   node tools/scratch/judge-monuments.mjs --port=5972 --out=/tmp/mon.json
 *
 * Written for pass 2 of `docs/CITY-GROUND-JUDGE.md`, to adjudicate three claims made by
 * `e/city/rome-landmarks` that nothing in the tree measures:
 *
 *  1. **Isotropy (rubric H8).** Every monument's drawn height over its drawn plan, against the
 *     real published ratio. `w`/`d` come from `CitySystem.getObstacles()` — the boxes the
 *     *simulation* collides with — and `h` from a `THREE.Raycaster` dropped on an 11 x 11 grid
 *     inside the footprint with **one datum at the monument's own centre**, which is
 *     `judge-fabric.mjs`'s method and is there for the reasons recorded in its comment (a
 *     single centre ray falls through the Colosseum's arena and reports the sand). The
 *     published ratios in `REAL` below are typed in from the literature, not read from
 *     `survey.ts`.
 *
 *  2. **The +Z edge.** A monument's true reach along **world z** is
 *     `|hw·sin(rot)| + |hd·cos(rot)|`, not its half-depth in its own frame. The heightfield
 *     stops at `HALF_EXTENT`. Reported per monument for the collision box AND for the drawn
 *     stone, plus a ray dropped past the edge to ask whether any ground is there at all.
 *
 *  3. **Water.** `terrain.heightAt` against `terrain.waterLevel` at the monument's centre and
 *     over its footprint, so "in the river" is a measurement rather than a look.
 *
 * And one thing for the gate adjudication: **every monument pair's clearance, tagged with
 * whether the two rows declare themselves one `complex`.** `probe-fabric` G8 prints only the
 * class minimum, so the claim "all of them are inside a declared complex" cannot be checked
 * from its output. This prints the whole population.
 *
 * `LANDMARKS` is imported from `/src/city/rome/layout.ts` for **names, `complex`, `planScale`
 * and `heightScale` only** — the declared values, which are the defendant. Every number this
 * file grades is read off the obstacle set, the scene graph or the terrain.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { ensureServer, bootThroughMenu } from '../lib/menu-boot.mjs';
import { launchBrowser } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : ['@pos', a];
}));
const PORT = Number(args.get('port') ?? 5972);
const OUT = args.get('out') ?? '/tmp/judge-monuments.json';
const TAG = args.get('tag') ?? 'tree';
if (PORT === 5173) { console.error('not 5173'); process.exit(1); }

/**
 * Published dimensions and heights, typed in from the literature so this file's ruler is
 * outside the thing it measures. `len` x `wid` in real metres, `h` the real height of the
 * thing a person looking at it would call its height. Rows with `h: null` are graded on plan
 * fidelity only.
 *
 * Sources are `docs/ROME-FABRIC.md` §4.1's own citations, which are Platner & Ashby, Coarelli,
 * Claridge and Packer — quoted here rather than imported, per `MAP-METHOD.md` rule 6.
 */
const REAL = {
  colosseum: { len: 189, wid: 156, h: 48.5, note: 'Flavian Amphitheatre, attic cornice' },
  pantheon: { len: 84, wid: 58, h: 43.4, note: 'rotunda + portico; 43.4 m to the oculus' },
  'mausoleum-augustus': { len: 87, wid: 87, h: 45, note: 'c. 45 m to the crowning statue' },
  'theatre-marcellus': { len: 130, wid: 115, h: 32.6, note: 'three-order façade' },
  'mausoleum-hadrian': { len: 64, wid: 64, h: 21, note: 'drum only' },
  'temple-jupiter': { len: 63, wid: 53, h: 30, note: 'podium to ridge, Capitoline temple' },
  'castra-praetoria': { len: 400, wid: 377, h: 8, note: 'curtain of the Praetorian camp' },
  'baths-trajan': { len: 230, wid: 170, h: 30, note: 'bathing block vaults' },
  'baths-nero': { len: 190, wid: 140, h: 25, note: null },
  'basilica-ulpia': { len: 130, wid: 55, h: 25, note: 'nave clerestory' },
  'trajan-column': { len: 18, wid: 18, h: 38, note: 'pedestal + shaft + statue' },
  'ara-pacis': { len: 11.6, wid: 10.6, h: 6, note: 'precinct wall' },
  'theatre-pompey': { len: 160, wid: 140, h: 30, note: 'cavea' },
  'stadium-domitian': { len: 275, wid: 106, h: 20, note: null },
  'forum-romanum': { len: 200, wid: 90, h: 15, note: 'the square, not a building' },
  'imperial-fora': { len: 250, wid: 100, h: 20, note: null },
  'baths-agrippa': { len: 120, wid: 100, h: 25, note: null },
  'baths-titus': { len: 120, wid: 105, h: 25, note: null },
  'ludus-magnus': { len: 135, wid: 100, h: 15, note: null },
  'trajan-market': { len: 120, wid: 70, h: 35, note: 'six storeys up the Quirinal cut' },
  'porticus-octaviae': { len: 132, wid: 119, h: 15, note: 'quadriportico colonnade' },
  'porticus-pompei': { len: 180, wid: 135, h: 15, note: null },
  'temple-isis': { len: 200, wid: 50, h: 20, note: 'Iseum + Serapeum' },
  'temple-serapis': { len: 135, wid: 98, h: 30, note: null },
  tabularium: { len: 73, wid: 34, h: 25, note: 'substructure + two storeys' },
  'largo-argentina': { len: 90, wid: 60, h: 15, note: 'the four republican temples' },
};

const { base, server } = await ensureServer({
  port: PORT, root: ROOT, cacheDir: `/tmp/tc-jg2/.vite-p${PORT}`,
});

/*
 * `launchBrowser` — `tools/lib/browser-budget.mjs`, 22 Aug 2026. A judge is a long run and a
 * judge loop is several of them; on the day this landed twelve agents each opening one browser
 * put the machine at load average 160 on 16 cores. The four GPU flags that were listed here are
 * the default `GPU_ARGS` now, so only the two specific to a screenshot rig are passed.
 */
const browser = await launchBrowser({
  label: 'judge-monuments', port: PORT, root: ROOT,
  args: ['--enable-gpu-rasterization', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));

await bootThroughMenu(page, {
  base, map: 'campus-martius', scenario: 'assault', tier: 'ultra',
  query: 'autoplay=0&quality=ultra',
});

const out = await page.evaluate(async ({ REAL }) => {
  const THREE = await import(/* @vite-ignore */ '/node_modules/three/build/three.module.js');
  const g = window.__game;
  const ctx = g.engine.context ?? g.engine.ctx;
  const city = ctx.get('city');
  const terrain = ctx.get('terrain');
  const scene = g.engine.scene;
  const obs = city.getObstacles();
  const notes = [];

  // Declared plan — the defendant. Names, complex membership, and the two scale fields.
  let plan = null;
  let HALF = 1400;
  try {
    const L = await import(/* @vite-ignore */ '/src/city/rome/layout.ts');
    plan = L.LANDMARKS.map((l) => ({
      id: l.id, name: l.name, x: l.x, z: l.z, rot: l.rot, hw: l.hw, hd: l.hd,
      planScale: l.planScale ?? 1, heightScale: l.heightScale ?? 1, complex: l.complex ?? null,
      soft: !!l.soft, where: l.where, mound: l.mound ?? null,
    }));
    const T = await import(/* @vite-ignore */ '/src/terrain/topography.ts');
    HALF = T.HALF_EXTENT;
  } catch (e) { notes.push(`plan import failed: ${e && e.message}`); }

  const roots = [];
  const skip = /soldier|unit|banner|sky|cloud|grass|water|dust|proj|corpse|debris/i;
  scene.traverse((o) => { o.updateMatrixWorld?.(false); });
  for (const c of scene.children) if (!skip.test(c.name ?? '')) roots.push(c);

  const rc = new THREE.Raycaster();
  const dirV = new THREE.Vector3();
  const orgV = new THREE.Vector3();
  const shoot = (ox, oy, oz, dx, dy, dz, far) => {
    orgV.set(ox, oy, oz);
    dirV.set(dx, dy, dz).normalize();
    rc.set(orgV, dirV);
    rc.far = far;
    const hits = rc.intersectObjects(roots, true);
    for (const h of hits) {
      if (h.distance < 0.05) continue;
      let n = h.object, name = n.name ?? '';
      while (n && !name) { n = n.parent; name = n?.name ?? ''; }
      return { d: h.distance, y: h.point.y, name };
    }
    return null;
  };
  const H = (x, z) => terrain.heightAt(x, z);
  const WATER = terrain.waterLevel ?? -1e9;

  // ---- monument obstacle boxes, attributed to a declared placement by reach --------------
  const owners = (plan ?? []).map((p) => ({ ...p, reach: Math.hypot(p.hw, p.hd) }));
  const ownerAt = (x, z) => {
    let best = null, bs = Infinity;
    for (const q of owners) {
      const s2 = ((q.x - x) ** 2 + (q.z - z) ** 2) / (q.reach * q.reach || 1);
      if (s2 < bs) { bs = s2; best = q; }
    }
    return best;
  };

  const monBoxes = [];
  obs.forEach((o, i) => {
    if (o.kind !== 'monument') return;
    const own = ownerAt(o.x, o.z);
    monBoxes.push({ i, o, id: own ? own.id : `mon#${i}` });
  });

  // ---- drawn stone extents, by owner, from the city geometry -----------------------------
  const stone = new Map(); // id -> { zMax, yMax, n }
  {
    const acc = (id) => {
      let e = stone.get(id);
      if (!e) { e = { zMax: -1e9, zMin: 1e9, yMax: -1e9, n: 0 }; stone.set(id, e); }
      return e;
    };
    // Same read as `probe-fabric`: raw `position` off the baked chunk (already world space),
    // full-detail level only, no shadow proxies, and a vertex further than 1.6x the
    // claimant's own reserved circumradius is left **unclaimed** rather than folded into
    // somebody else's dimensions.
    const cityRoot = scene.getObjectByName('city');
    let meshes = 0;
    let unclaimed = 0;
    const groups = [];
    (cityRoot ?? scene).traverse((n) => {
      if (!n.isMesh) return;
      const gname = n.parent ? n.parent.name : '';
      if (!/-lod0$/.test(gname)) return;
      if (/-shadow$/.test(n.name || '')) return;
      if (!/^monuments(-|$)/.test(gname)) return;
      const pos = n.geometry && n.geometry.attributes && n.geometry.attributes.position;
      if (!pos) return;
      meshes++;
      if (!groups.includes(gname)) groups.push(gname);
      const arr = pos.array;
      for (let k = 0; k + 2 < arr.length; k += 3) {
        const x = arr[k], y = arr[k + 1], z = arr[k + 2];
        let best = null, bs = Infinity;
        for (const q of owners) {
          const s2 = ((q.x - x) ** 2 + (q.z - z) ** 2) / (q.reach * q.reach || 1);
          if (s2 < bs) { bs = s2; best = q; }
        }
        if (!best || Math.sqrt(bs) > 1.6) { unclaimed++; continue; }
        const e = acc(best.id);
        if (z > e.zMax) e.zMax = z;
        if (z < e.zMin) e.zMin = z;
        if (y > e.yMax) e.yMax = y;
        e.n++;
      }
    });
    notes.push(`monument meshes ${meshes} in [${groups.join(', ')}], vertices left unclaimed ${unclaimed}`);
  }

  // ---- per-monument measurement ----------------------------------------------------------
  const rows = [];
  for (const p of owners) {
    const box = monBoxes.find((b) => b.id === p.id);
    const o = box ? box.o : null;
    const w = o ? 2 * o.hw : null;
    const d = o ? 2 * o.hd : null;
    const rot = o ? o.rot : p.rot;

    // grid-max height, one datum at the centre
    const datum = H(p.x, p.z);
    let top = -Infinity, miss = 0, n = 0;
    if (o) {
      const c = Math.cos(rot), sn = Math.sin(rot);
      for (let i = 0; i < 11; i++) {
        for (let j = 0; j < 11; j++) {
          const lu = ((i / 10) * 2 - 1) * o.hw * 0.9;
          const lv = ((j / 10) * 2 - 1) * o.hd * 0.9;
          const px = p.x + lu * c + lv * sn;
          const pz = p.z - lu * sn + lv * c;
          n++;
          const hit = shoot(px, datum + 260, pz, 0, -1, 0, 320);
          if (!hit) { miss++; continue; }
          if (hit.y > top) top = hit.y;
        }
      }
    }
    const h = Number.isFinite(top) ? +(top - datum).toFixed(1) : null;

    // world +z reach of the collision box
    const reachZ = o ? Math.abs(o.hw * Math.sin(rot)) + Math.abs(o.hd * Math.cos(rot)) : null;
    const boxZMax = o ? +(p.z + reachZ).toFixed(1) : null;
    const st = stone.get(p.id) ?? null;

    // water
    const inWater = datum < WATER;
    let wetCorners = 0;
    if (o) {
      const c = Math.cos(rot), sn = Math.sin(rot);
      for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const px = p.x + su * o.hw * c + sv * o.hd * sn;
        const pz = p.z - su * o.hw * sn + sv * o.hd * c;
        if (H(px, pz) < WATER) wetCorners++;
      }
    }

    // is there ground past the box's own south edge?
    let groundAtZMax = null;
    if (boxZMax !== null) {
      const gy = H(p.x, Math.min(boxZMax, 1e4));
      groundAtZMax = +gy.toFixed(2);
    }

    const real = REAL[p.id] ?? null;
    const drawnLong = w === null ? null : Math.max(w, d);
    const drawnShort = w === null ? null : Math.min(w, d);
    // The obstacle box carries PRECINCT 1.07; divide it back out to compare with published.
    const PRE = 1.07;
    rows.push({
      id: p.id, name: p.name, x: +p.x.toFixed(1), z: +p.z.toFixed(1),
      rotDeg: +((rot * 180) / Math.PI).toFixed(1),
      complex: p.complex, soft: p.soft, where: p.where, mound: p.mound,
      declared: { planScale: +p.planScale.toFixed(3), heightScale: +p.heightScale.toFixed(3) },
      box: { w: w === null ? null : +w.toFixed(1), d: d === null ? null : +d.toFixed(1) },
      drawnHeight: h,
      real,
      // measured fraction of published plan, PRECINCT divided out
      measuredPlanFrac: real && drawnLong !== null
        ? +((drawnLong / PRE) / Math.max(real.len, real.wid)).toFixed(3) : null,
      measuredHeightFrac: real && real.h && h !== null ? +(h / real.h).toFixed(3) : null,
      realHOverW: real && real.h ? +(real.h / Math.max(real.len, real.wid)).toFixed(3) : null,
      builtHOverW: h !== null && drawnLong ? +(h / drawnLong).toFixed(3) : null,
      edge: {
        boxZMax, reachZ: reachZ === null ? null : +reachZ.toFixed(1),
        overBoxM: boxZMax === null ? null : +(boxZMax - HALF).toFixed(1),
        stoneZMax: st ? +st.zMax.toFixed(1) : null,
        overStoneM: st ? +(st.zMax - HALF).toFixed(1) : null,
        groundYAtBoxZMax: groundAtZMax,
      },
      /**
       * **The drawn height by a second, independent method: the largest `y` among this
       * monument's own vertices, above the same datum.** No rays.
       *
       * It fails differently from `drawnHeight` above, which is a grid-max raycast: that one can
       * be fooled by a neighbour's stone overhanging the box or by a slope inside it (measured:
       * the Castra Praetoria's grid hits the Aurelian curtain behind it, and the Capitol's hits
       * its own 59 m mound inside a 39 m box), while this one can only be fooled by attribution.
       * **Where the two agree the reading is safe and where they disagree it is not** —
       * `CITY-GROUND-JUDGE.md` §1 records three answers for one building and §10.4.1 wanted this
       * field and did not have it, because the first version of this file computed `st.yMax` and
       * forgot to emit it.
       */
      stoneYMax: st ? +st.yMax.toFixed(1) : null,
      stoneHeight: st ? +(st.yMax - datum).toFixed(1) : null,
      water: { datumY: +datum.toFixed(2), waterLevel: +WATER.toFixed(2), centreWet: inWater, wetCorners },
      stoneSamples: st ? st.n : 0,
    });
  }

  // ---- pairwise clearance, tagged by complex ---------------------------------------------
  /**
   * The oriented box as four world points, in **`probe-fabric.mjs`'s own `obPoly` convention**:
   * `u = (cos·hw, sin·hw)`, `v = (−sin·hd, cos·hd)`.
   *
   * **The first version of this function had the sign of `u.z` inverted**, which mirrors every
   * *rotated* box about its own centre and is completely invisible on an axis-aligned one. It
   * reported the Basilica Ulpia and Trajan's Column interpenetrating by 13.6 m where the city's
   * own `assertNoFootprintOverlaps` reported 1.0 m. `ROME-FABRIC.md` §8.8 records the identical
   * error, in the identical place, made by the branch this file was written to grade — so the
   * fault was on the record before it was made again. With the convention corrected the two
   * computations agree to 0.05 m.
   */
  const poly = (o) => {
    const c = Math.cos(o.rot), s = Math.sin(o.rot);
    const ux = c * o.hw, uz = s * o.hw;
    const vx = -s * o.hd, vz = c * o.hd;
    return [
      { x: o.x - ux - vx, z: o.z - uz - vz },
      { x: o.x + ux - vx, z: o.z + uz - vz },
      { x: o.x + ux + vx, z: o.z + uz + vz },
      { x: o.x - ux + vx, z: o.z - uz + vz },
    ];
  };
  // Separating-axis gap / penetration depth on two convex quads. Positive = clear gap.
  const sat = (A, B) => {
    const axes = [];
    for (const P of [A, B]) {
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        const ex = b.x - a.x, ez = b.z - a.z;
        const l = Math.hypot(ex, ez) || 1;
        axes.push({ x: -ez / l, z: ex / l });
      }
    }
    let maxSep = -Infinity, minOverlap = Infinity;
    for (const ax of axes) {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const p of A) { const t = p.x * ax.x + p.z * ax.z; if (t < a0) a0 = t; if (t > a1) a1 = t; }
      for (const p of B) { const t = p.x * ax.x + p.z * ax.z; if (t < b0) b0 = t; if (t > b1) b1 = t; }
      const sep = Math.max(a0 - b1, b0 - a1);      // > 0 means separated on this axis
      if (sep > maxSep) maxSep = sep;
      const ov = Math.min(a1, b1) - Math.max(a0, b0);
      if (ov < minOverlap) minOverlap = ov;
    }
    return maxSep > 0 ? maxSep : -minOverlap;      // + gap, − penetration depth
  };

  const pairs = [];
  for (let i = 0; i < monBoxes.length; i++) {
    for (let j = i + 1; j < monBoxes.length; j++) {
      const A = monBoxes[i], B = monBoxes[j];
      if (A.id === B.id) continue;
      const pa = owners.find((q) => q.id === A.id);
      const pb = owners.find((q) => q.id === B.id);
      if (!pa || !pb) continue;
      if (pa.soft || pb.soft) continue;
      if (Math.hypot(A.o.x - B.o.x, A.o.z - B.o.z) > 400) continue;
      const v = sat(poly(A.o), poly(B.o));
      if (v > 60) continue;
      pairs.push({
        a: A.id, b: B.id, m: +v.toFixed(2),
        sameComplex: pa.complex !== null && pa.complex === pb.complex,
        complex: pa.complex === pb.complex ? pa.complex : `${pa.complex}|${pb.complex}`,
      });
    }
  }
  pairs.sort((p, q) => p.m - q.m);

  return {
    tag: null, cityId: city.stats().id, halfExtent: HALF, waterLevel: +WATER.toFixed(2),
    monumentBoxes: monBoxes.length, rows, pairs, notes,
  };
}, { REAL });

out.tag = TAG;
out.errors = errs;
await writeFile(OUT, JSON.stringify(out, null, 1));

// ---------------------------------------------------------------------------
const r = out.rows.filter((e) => !e.soft);
console.log(`\n== ${out.cityId} [${TAG}] ==  ${out.monumentBoxes} monument boxes, HALF_EXTENT ${out.halfExtent}, water ${out.waterLevel}`);

console.log(`\nISOTROPY — drawn height over drawn plan, against the published ratio.`);
console.log(`  h(A) is the grid-max raycast, h(B) the vertex maximum. Where they disagree, neither is safe.`);
console.log(`  ${'monument'.padEnd(22)} ${'draw'.padStart(5)} ${'drawY'.padStart(5)} ${'box w x d'.padStart(14)} ${'h(A)'.padStart(6)} ${'h(B)'.padStart(6)} ${'anisoA'.padStart(7)} ${'anisoB'.padStart(7)}`);
for (const e of r) {
  if (!e.real || !e.real.h) continue;
  const L = e.box.w === null ? null : Math.max(e.box.w, e.box.d);
  const realR = e.real.h / Math.max(e.real.len, e.real.wid);
  const aA = e.drawnHeight && L ? (e.drawnHeight / L / realR).toFixed(2) : '-';
  const aB = e.stoneHeight && L ? (e.stoneHeight / L / realR).toFixed(2) : '-';
  console.log(`  ${e.name.slice(0, 22).padEnd(22)} ${String(e.declared.planScale).padStart(5)} ${String(e.declared.heightScale).padStart(5)} `
    + `${`${e.box.w} x ${e.box.d}`.padStart(14)} ${String(e.drawnHeight).padStart(6)} ${String(e.stoneHeight).padStart(6)} ${String(aA).padStart(7)} ${String(aB).padStart(7)}`);
}

console.log(`\nTHE +Z EDGE — how far past ${out.halfExtent} the box and the stone reach`);
for (const e of r.slice().sort((a, b) => (b.edge.overBoxM ?? -1e9) - (a.edge.overBoxM ?? -1e9)).slice(0, 8)) {
  console.log(`  ${e.name.slice(0, 26).padEnd(26)} box zMax ${String(e.edge.boxZMax).padStart(7)} (${e.edge.overBoxM > 0 ? '+' : ''}${e.edge.overBoxM})   stone zMax ${String(e.edge.stoneZMax).padStart(7)} (${e.edge.overStoneM === null ? '-' : (e.edge.overStoneM > 0 ? '+' : '') + e.edge.overStoneM})`);
}

console.log(`\nWATER — monuments whose centre or corners are below ${out.waterLevel}`);
for (const e of out.rows) {
  if (!e.water.centreWet && e.water.wetCorners === 0) continue;
  console.log(`  ${e.name.slice(0, 26).padEnd(26)} datum ${e.water.datumY}  centreWet ${e.water.centreWet}  wet corners ${e.water.wetCorners}/4  at (${e.x}, ${e.z})`);
}

console.log(`\nMONUMENT PAIRS under 60 m, + = clear gap, − = interpenetration`);
console.log(`  ${'gap m'.padStart(8)}  ${'same complex'.padStart(12)}  pair`);
for (const p of out.pairs.slice(0, 30)) {
  console.log(`  ${String(p.m).padStart(8)}  ${String(p.sameComplex).padStart(12)}  ${p.a} / ${p.b}   [${p.complex}]`);
}
const bad = out.pairs.filter((p) => !p.sameComplex && p.m < 7);
const inC = out.pairs.filter((p) => p.sameComplex);
console.log(`\n  pairs under 7 m NOT in one complex: ${bad.length}`);
for (const p of bad) console.log(`    ${p.m} m  ${p.a} / ${p.b}`);
console.log(`  pairs in one complex: ${inC.length}; of those, gap in (2.5, 7) m — neither a street nor a joint: `
  + inC.filter((p) => p.m > 2.5 && p.m < 7).length);
for (const p of inC.filter((q) => q.m > 2.5 && q.m < 7)) console.log(`    ${p.m} m  ${p.a} / ${p.b}  [${p.complex}]`);
if (out.errors.length) console.log(`\npage errors: ${out.errors.length}\n  ${out.errors.slice(0, 5).join('\n  ')}`);
console.log(`\nwrote ${OUT}`);

await browser.close();
if (server) server.kill('SIGTERM');
process.exit(0);
