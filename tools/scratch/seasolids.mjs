#!/usr/bin/env node
/**
 * Carthage's half of the water sweep: what each candidate repair costs, in metres, for the
 * two monuments G22 finds standing in the sea.
 *
 * The Rome side is `riverbudge.mjs`, which can call the analytic ground straight out of
 * `topography.ts`. Carthage has no analytic ground — its terrain is a *baked* heightfield
 * built by `src/maps/carthage/heightfield.ts` — so this builds the field and samples it with
 * the same bilinear filter `TerrainSystem.heightAt` uses. That filter is twenty lines and is
 * copied here rather than imported, because importing it means constructing a `TerrainSystem`,
 * which wants THREE and a scene; the copy is a sweep tool's convenience and every number it
 * produces is confirmed in the browser by `probe-fabric` G22 against the real `heightAt`.
 *
 * **Both rows have since been moved and both now read `wet 0 m2, CLEARS` at the top of their
 * block.** That is the tool working, not the tool going stale: the sweep is what chose where
 * they went, and the "as built" line is the receipt. `temple-sea` went to (100, 1150) — the
 * least-relief dry seat inside 120 m that also keeps every way's belt and every monument's
 * clearance, because the nearest dry seat is on a 28-36 % bluff that would float its seaward
 * end 13 m in the air — and `quay-fort` went 27 m landward to z 1093. Run it again after any
 * change to `heightfield.ts` and the two "as built" lines say whether they still stand on land.
 *
 *   node --experimental-transform-types --import ./tools/lib/ts-resolve.mjs \
 *        tools/scratch/seasolids.mjs
 */
import { buildCarthageTerrain } from '../../src/maps/carthage/heightfield.ts';
import {
  MONUMENTS as CARTHAGE_LANDMARKS, PUNIC_WAYS, PUNIC_FRONTAGE,
} from '../../src/city/carthage/layout.ts';
import { HALF_EXTENT } from '../../src/terrain/topography.ts';

const SEA = 0;
const field = buildCarthageTerrain();

/** `TerrainSystem.heightAt`, copied. See the header. */
const heightAt = (x, z) => {
  const { heights: h, res, spacing } = field;
  const fx = (x + HALF_EXTENT) / spacing;
  const fz = (z + HALF_EXTENT) / spacing;
  let i0 = fx | 0;
  let j0 = fz | 0;
  if (i0 < 0) i0 = 0; else if (i0 > res - 2) i0 = res - 2;
  if (j0 < 0) j0 = 0; else if (j0 > res - 2) j0 = res - 2;
  let tx = fx - i0; let tz = fz - j0;
  tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
  tz = tz < 0 ? 0 : tz > 1 ? 1 : tz;
  const r0 = j0 * res + i0;
  const r1 = r0 + res;
  const top = h[r0] + (h[r0 + 1] - h[r0]) * tx;
  const bot = h[r1] + (h[r1 + 1] - h[r1]) * tx;
  return top + (bot - top) * tz;
};

/** G22's own raster: cell centres, 2 m pitch, wet AREA rather than a sample count. */
const STEP = 2;
function scan(x, z, hw, hd, rot) {
  const c = Math.cos(rot); const s = Math.sin(rot);
  const nu = Math.max(1, Math.round((2 * hw) / STEP));
  const nv = Math.max(1, Math.round((2 * hd) / STEP));
  let wet = 0; let worst = Infinity; let best = -Infinity;
  for (let iu = 0; iu < nu; iu++) {
    const u = -hw + (iu + 0.5) * (2 * hw / nu);
    for (let iv = 0; iv < nv; iv++) {
      const v = -hd + (iv + 0.5) * (2 * hd / nv);
      const g = heightAt(x + u * c - v * s, z + u * s + v * c);
      if (g <= SEA) wet++;
      if (g < worst) worst = g;
      if (g > best) best = g;
    }
  }
  const cell = (2 * hw / nu) * (2 * hd / nv);
  return {
    wetM2: wet * cell, wetFrac: wet / (nu * nv), worst, best, relief: best - worst,
    centre: heightAt(x, z),
  };
}

const line = (label, r) =>
  `${label.padEnd(18)} wet ${r.wetM2.toFixed(0).padStart(6)} m2 (${(r.wetFrac * 100).toFixed(0).padStart(3)}%)`
  + `  worst ${r.worst.toFixed(2).padStart(6)}  centre ${r.centre.toFixed(2).padStart(6)}`
  + `  ${r.wetM2 <= 4 ? 'CLEARS' : ''}`;

for (const id of ['temple-sea', 'quay-fort']) {
  const m = CARTHAGE_LANDMARKS.find((l) => l.id === id);
  console.log(`\n=== ${id} — G22's gate is 4 m2 of wet plan, sea at ${SEA} m ===`);
  console.log(`  as built: (${m.x}, ${m.z}) ${2 * m.hw} x ${2 * m.hd} m, rot ${m.rot}`);
  console.log(`  ${line('as built', scan(m.x, m.z, m.hw, m.hd, m.rot))}`);
  console.log('  landward (-z), plan and x unchanged:');
  for (const dz of [-10, -20, -30, -40, -50, -60, -70, -80, -100, -120]) {
    console.log(`     ${line(`dz ${dz}`, scan(m.x, m.z + dz, m.hw, m.hd, m.rot))}`);
  }
  console.log('  along the shore (+/-x), plan and z unchanged:');
  for (const dx of [-120, -80, -40, 40, 80, 120]) {
    console.log(`     ${line(`dx ${dx}`, scan(m.x + dx, m.z, m.hw, m.hd, m.rot))}`);
  }
}

// Where the shoreline actually is on the two transects, so a move can be read off it.
for (const [id, x] of [['temple-sea', 150], ['quay-fort', -250]]) {
  const zs = [];
  for (let z = 1300; z > 900; z -= 2) if (heightAt(x, z) > SEA) { zs.push(z); break; }
  console.log(`\nshoreline on the ${id} transect (x ${x}): first dry z going landward = ${zs[0]}`
    + `, ground there ${heightAt(x, zs[0]).toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
// The landward move, costed against the things that already stand there.
//
// Clearing the water is not enough on its own: G4/G5 fail a monument in a carriageway and
// G8/G9 fail one that has eaten its neighbour's street, so a repair that trades a water fault
// for a street fault has not repaired anything. This walks z landward one metre at a time and
// reports the FIRST z at which the plan is dry AND keeps its declared clearance from every
// other monument and every way's reserved belt.
// ---------------------------------------------------------------------------
const segDist = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax; const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  const qx = ax + dx * t; const qz = az + dz * t;
  return Math.sqrt((px - qx) * (px - qx) + (pz - qz) * (pz - qz));
};
/** Closest approach of an axis-aligned-in-its-own-frame box's perimeter samples to a polyline. */
const wayGap = (m, x, z) => {
  let worst = Infinity; let who = '';
  for (const w of PUNIC_WAYS) {
    const belt = w.width * 0.5 + PUNIC_FRONTAGE[w.cls];
    for (let i = 1; i < w.path.length; i++) {
      const a = w.path[i - 1]; const b = w.path[i];
      // sample the box on a 2 m grid; the belt is what the way reserves either side
      const c = Math.cos(m.rot); const s = Math.sin(m.rot);
      for (let u = -m.hw; u <= m.hw; u += 4) {
        for (let v = -m.hd; v <= m.hd; v += 4) {
          const d = segDist(x + u * c - v * s, z + u * s + v * c, a.x, a.z, b.x, b.z) - belt;
          if (d < worst) { worst = d; who = w.id; }
        }
      }
    }
  }
  return { gap: worst, who };
};
const monGap = (m, x, z) => {
  let worst = Infinity; let who = '';
  for (const o of CARTHAGE_LANDMARKS) {
    if (o.id === m.id) continue;
    const need = Math.max(m.clear, o.clear);
    const dx = Math.max(0, Math.abs(x - o.x) - (m.hw + o.hw));
    const dz = Math.max(0, Math.abs(z - o.z) - (m.hd + o.hd));
    const d = Math.sqrt(dx * dx + dz * dz) - need;
    if (d < worst) { worst = d; who = o.id; }
  }
  return { gap: worst, who };
};

console.log('\n=== the first landward z that is dry AND keeps every clearance ===');
for (const id of ['temple-sea', 'quay-fort']) {
  const m = CARTHAGE_LANDMARKS.find((l) => l.id === id);
  let first = null;
  for (let dz = 0; dz >= -220; dz -= 1) {
    const z = m.z + dz;
    const r = scan(m.x, z, m.hw, m.hd, m.rot);
    if (r.wetM2 > 4) continue;
    const w = wayGap(m, m.x, z);
    const o = monGap(m, m.x, z);
    if (w.gap < 0 || o.gap < 0) continue;
    first = { dz, z, r, w, o };
    break;
  }
  if (!first) { console.log(`  ${id}: no dry, clear z inside 220 m landward`); continue; }
  console.log(`  ${id}: dz ${first.dz} -> z ${first.z}; wet ${first.r.wetM2.toFixed(0)} m2,`
    + ` worst ground ${first.r.worst.toFixed(2)} m, centre ${first.r.centre.toFixed(2)} m;`
    + ` nearest way ${first.w.who} +${first.w.gap.toFixed(1)} m past its belt;`
    + ` nearest monument ${first.o.who} +${first.o.gap.toFixed(1)} m past its clearance`);
  for (const extra of [-4, -8, -12, -20]) {
    const z = first.z + extra;
    const r = scan(m.x, z, m.hw, m.hd, m.rot);
    const w = wayGap(m, m.x, z);
    const o = monGap(m, m.x, z);
    console.log(`      z ${z}: wet ${r.wetM2.toFixed(0)} m2, worst ${r.worst.toFixed(2)},`
      + ` way ${w.who} ${w.gap.toFixed(1)}, mon ${o.who} ${o.gap.toFixed(1)}`);
  }
}

// ---------------------------------------------------------------------------
// The Temple by the Sea needs a 2D search: its landward transect at x 150 is blocked.
// Prints the nearest dry-and-clear seat by total displacement, and what binds when there
// is none on the straight line inland.
// ---------------------------------------------------------------------------
{
  const m = CARTHAGE_LANDMARKS.find((l) => l.id === 'temple-sea');
  const cands = [];
  for (let dx = -300; dx <= 300; dx += 10) {
    for (let dz = -260; dz <= 40; dz += 10) {
      const x = m.x + dx; const z = m.z + dz;
      const r = scan(x, z, m.hw, m.hd, m.rot);
      if (r.wetM2 > 4) continue;
      const w = wayGap(m, x, z); const o = monGap(m, x, z);
      if (w.gap < 0 || o.gap < 0) continue;
      cands.push({ dx, dz, x, z, d: Math.sqrt(dx * dx + dz * dz), r, w, o });
    }
  }
  cands.sort((a, b) => a.d - b.d);
  console.log(`\n=== temple-sea, 2D: ${cands.length} dry-and-clear seats on a 10 m lattice ===`);
  for (const c of cands.slice(0, 6)) {
    console.log(`  (${c.x}, ${c.z})  moved ${c.d.toFixed(0)} m  worst ${c.r.worst.toFixed(2)}`
      + `  relief ${c.r.relief.toFixed(1)}  centre ${c.r.centre.toFixed(2)}`
      + `  way ${c.w.who} +${c.w.gap.toFixed(1)}  mon ${c.o.who} +${c.o.gap.toFixed(1)}`);
  }
  // A temple wants a level podium. The 64 m plan on this coast crosses the shore escarpment,
  // so sort the same set by RELIEF under the plan and print the flattest near seats.
  const flat = [...cands].sort((a, b) => a.r.relief - b.r.relief);
  console.log('  flattest seats anywhere in the search box, with their displacement:');
  for (const c of flat.slice(0, 12)) {
    console.log(`  (${c.x}, ${c.z})  moved ${c.d.toFixed(0)} m  worst ${c.r.worst.toFixed(2)}`
      + `  relief ${c.r.relief.toFixed(1)}  centre ${c.r.centre.toFixed(2)}`
      + `  way ${c.w.who} +${c.w.gap.toFixed(1)}  mon ${c.o.who} +${c.o.gap.toFixed(1)}`);
  }
  console.log('  a 2 m lattice on the bluff, plan unchanged, sorted by relief:');
  {
    const fine = [];
    for (let x = 60; x <= 200; x += 5) {
      for (let z = 1150; z <= 1200; z += 2) {
        const r = scan(x, z, m.hw, m.hd, m.rot);
        if (r.wetM2 > 4) continue;
        const w = wayGap(m, x, z); const o = monGap(m, x, z);
        if (w.gap < 0 || o.gap < 0) continue;
        fine.push({ x, z, r, w, o, d: Math.hypot(x - m.x, z - m.z) });
      }
    }
    fine.sort((a, b) => a.r.relief - b.r.relief);
    for (const c of fine.slice(0, 8)) {
      console.log(`     (${c.x}, ${c.z}) moved ${c.d.toFixed(0)} m  relief ${c.r.relief.toFixed(1)}`
        + `  worst ${c.r.worst.toFixed(2)}  centre ${c.r.centre.toFixed(2)}`
        + `  way ${c.w.who} +${c.w.gap.toFixed(1)}  mon ${c.o.who} +${c.o.gap.toFixed(1)}`);
    }
  }
  console.log('  the coast profile the seat has to sit on, x 110, z 1130..1210:');
  for (let z = 1210; z >= 1130; z -= 10) {
    console.log(`     z ${z}: ${heightAt(110, z).toFixed(2)} m`);
  }
  console.log('  flattest seats with x <= 0 — the harbour shore rather than the north bluff:');
  for (const c of [...cands].filter((q) => q.x <= 20).sort((a, b) => a.r.relief - b.r.relief).slice(0, 8)) {
    console.log(`  (${c.x}, ${c.z})  moved ${c.d.toFixed(0)} m  worst ${c.r.worst.toFixed(2)}`
      + `  relief ${c.r.relief.toFixed(1)}  centre ${c.r.centre.toFixed(2)}`
      + `  way ${c.w.who} +${c.w.gap.toFixed(1)}  mon ${c.o.who} +${c.o.gap.toFixed(1)}`);
  }
  // The 64 m axis currently runs in z, which on this coast is straight up the escarpment.
  // Turning it to run along the contour is free — a temple's long axis is a choice, not a
  // published dimension — so sweep the seat again with the plan quarter-turned.
  console.log('  the same seats with the long axis turned along the shore (hw/hd swapped):');
  for (const [x, z] of [[110, 1165], [100, 1165], [110, 1175], [120, 1175], [130, 1185], [110, 1185]]) {
    const r = scan(x, z, m.hd, m.hw, m.rot);
    const w = wayGap({ ...m, hw: m.hd, hd: m.hw }, x, z);
    const o = monGap({ ...m, hw: m.hd, hd: m.hw }, x, z);
    console.log(`     (${x}, ${z})  wet ${r.wetM2.toFixed(0)} m2  worst ${r.worst.toFixed(2)}`
      + `  relief ${r.relief.toFixed(1)}  centre ${r.centre.toFixed(2)}`
      + `  way ${w.who} ${w.gap.toFixed(1)}  mon ${o.who} ${o.gap.toFixed(1)}`);
  }
  console.log('  relief under every Carthage monument as it stands, for scale:');
  for (const o of CARTHAGE_LANDMARKS) {
    const r = scan(o.x, o.z, o.hw, o.hd, o.rot);
    console.log(`     ${o.id.padEnd(18)} relief ${r.relief.toFixed(1).padStart(5)} m over`
      + ` ${(2 * o.hw).toFixed(0)} x ${(2 * o.hd).toFixed(0)} m, worst ${r.worst.toFixed(2)}`);
  }
  console.log('  what binds on the x 150 transect:');
  for (let dz = -40; dz >= -160; dz -= 20) {
    const z = m.z + dz;
    const r = scan(m.x, z, m.hw, m.hd, m.rot);
    const w = wayGap(m, m.x, z); const o = monGap(m, m.x, z);
    console.log(`     z ${z}: wet ${r.wetM2.toFixed(0)} worst ${r.worst.toFixed(2)}`
      + `  way ${w.who} ${w.gap.toFixed(1)}  mon ${o.who} ${o.gap.toFixed(1)}`);
  }
}
