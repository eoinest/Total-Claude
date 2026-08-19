#!/usr/bin/env node
/**
 * Every opening through a city curtain, and what fills it.
 *
 * Written because `tools/probe-solid.mjs --case=gates` cannot answer the question on
 * Carthage since the ditch was cut. That probe starts its ray 16 m outside the wall at
 * `groundAt(start) + h`, and 16 m out is *in the ditch* — the bed is ~4 m below the
 * footing — so at h = 1.0 the ray flies under the plinth, under the walled-up passage and
 * out the far side, and reports "mesh CLEAR" for masonry that is standing. The classic
 * "a number that cannot be true given its neighbour": `porta-uticensis` read CLEAR at
 * every height while its obstacle box stopped a man at 11.25 m.
 *
 * Here every ray is flown at the *opening's own* ground height, which is what a man
 * walking through the opening would be at. Terrain is not in the cast set — only baked
 * city chunks — so flying over a trench costs nothing.
 *
 *   node tools/scratch/pn-openings.mjs --port=5392 --map=carthage --json=out.json
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5392);
const MAP = args.get('map') ?? 'carthage';
const JSON_OUT = args.get('json') ?? null;
const base = `http://127.0.0.1:${PORT}`;

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) return true; }
    catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

let server = null;
if (!(await waitForServer(base, 1500))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await waitForServer(base, 120000))) { console.error('vite did not start'); process.exit(1); }
}

const battle = Buffer.from(JSON.stringify({
  map: MAP, opponent: MAP === 'carthage' ? 2 : 0, unitSize: 'ultra',
  quality: 'high', difficulty: 'hard', seed: 4265438264,
})).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `${base}/?harness=1&quality=high&w=960&h=540&scenario=assault&battle=${battle}`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { const t = m.text(); if (/section faults|unpierced|stray|\[city:/.test(t)) logs.push(t); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 600000 });

const three = await page.evaluate(async () => {
  const src = await (await fetch('/src/city/CitySystem.ts')).text();
  const m = src.match(/from\s*["']([^"']*three[^"']*)["']/);
  const T = await import(/* @vite-ignore */ m[1]);
  window.__THREE_Raycaster = T.Raycaster; window.__THREE_Vector3 = T.Vector3;
  return { revision: T.REVISION };
});
console.log(`# pn-openings — map ${MAP}, three r${three.revision}, ${base}`);

const HELPERS = `
window.__pn = (() => {
  const g = window.__game, b = g.battle;
  const city = g.engine.context.tryGet('city');
  const RE = /^(wall-\\d+|gate-door|gate-wreck|postern-door[\\w-]*|gatehouse[\\w-]*|tower[\\w-]*)-lod0$/;
  const gather = () => {
    const out = [];
    city.root.traverse((n) => {
      if (!n.isMesh || !n.parent) return;
      const p = n.parent.name || '';
      if (!RE.test(p)) return;
      if (/^(gate|postern)-(door|wreck)[\\w-]*-lod0$/.test(p) && !n.parent.visible) return;
      n.updateWorldMatrix(true, false);
      if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
      const bb = n.geometry.boundingBox.clone().applyMatrix4(n.matrixWorld);
      out.push({ mesh: n, minX: bb.min.x, maxX: bb.max.x, minZ: bb.min.z, maxZ: bb.max.z });
    });
    return out;
  };
  let M = null; const meshes = () => (M ||= gather());
  const RC = new window.__THREE_Raycaster();
  const OR = new window.__THREE_Vector3(), DR = new window.__THREE_Vector3();
  const cast = (ox, oy, oz, dx, dy, dz, far) => {
    const L = Math.hypot(dx, dy, dz) || 1;
    OR.set(ox, oy, oz); DR.set(dx / L, dy / L, dz / L);
    RC.set(OR, DR); RC.near = 0; RC.far = far;
    const ax = ox, az = oz, bx = ox + (dx / L) * far, bz = oz + (dz / L) * far;
    const loX = Math.min(ax, bx) - 1, hiX = Math.max(ax, bx) + 1;
    const loZ = Math.min(az, bz) - 1, hiZ = Math.max(az, bz) + 1;
    const c = [];
    for (const m of meshes()) {
      if (m.maxX < loX || m.minX > hiX || m.maxZ < loZ || m.minZ > hiZ) continue;
      c.push(m.mesh);
    }
    if (!c.length) return [];
    return RC.intersectObjects(c, false).map((h) => ({ d: +h.distance.toFixed(3),
      name: (h.object.parent && h.object.parent.name) || '?' }));
  };
  return { city, b, cast, meshCount: () => meshes().length,
    boxBlocked: (x, z, y) => b.masonry.blocked(x, z, y, 0.42) };
})();
`;
await page.evaluate((s) => { new Function(s)(); }, HELPERS);

const out = await page.evaluate(() => {
  const P = window.__pn, city = P.city, b = P.b;
  const res = { meshCount: P.meshCount(), openings: [], bands: null, bays: [] };

  // ---- per-opening: what fills it -----------------------------------------
  for (const gate of city.getGates()) {
    const ox = Math.sin(gate.facing), oz = Math.cos(gate.facing);
    // Along the run, for the lateral offsets.
    const tx = -oz, tz = ox;
    const gy = b.groundAt(gate.x, gate.z);
    // Rays at the OPENING's own ground, not the far ground.
    const heights = [0.6, 1.2, 1.8, 2.4, 3.2, 4.2, 5.5];
    const lats = [-2.0, -1.0, 0, 1.0, 2.0];
    let cast = 0, stopped = 0;
    const hitNames = {};
    let minStop = Infinity, maxClearH = null;
    for (const h of heights) {
      for (const lt of lats) {
        const sx = gate.x + ox * 16 + tx * lt, sz = gate.z + oz * 16 + tz * lt;
        const hits = P.cast(sx, gy + h, sz, -ox, 0, -oz, 34);
        cast++;
        if (hits.length) {
          stopped++;
          hitNames[hits[0].name] = (hitNames[hits[0].name] || 0) + 1;
          if (hits[0].d < minStop) minStop = hits[0].d;
        } else if (maxClearH === null || h > maxClearH) maxClearH = h;
      }
    }
    // Obstacle boxes and the raster, across the full thickness.
    let boxStop = null, rasterStop = null;
    for (let t = 0; t <= 34; t += 0.25) {
      const x = gate.x + ox * (16 - t), z = gate.z + oz * (16 - t);
      if (boxStop === null && P.boxBlocked(x, z, gy)) boxStop = +t.toFixed(2);
      if (rasterStop === null && city.blocksMovement(x, z, x, z)) rasterStop = +t.toFixed(2);
      if (boxStop !== null && rasterStop !== null) break;
    }
    const segBlocked = city.blocksMovement(
      gate.x + ox * 16, gate.z + oz * 16, gate.x - ox * 16, gate.z - oz * 16);
    res.openings.push({
      id: gate.id, open: gate.open, x: +gate.x.toFixed(1), z: +gate.z.toFixed(1),
      groundY: +gy.toFixed(2),
      raysCast: cast, raysStopped: stopped,
      solidFrac: +(stopped / cast).toFixed(3),
      minStop: Number.isFinite(minStop) ? +minStop.toFixed(2) : null,
      highestClearRay: maxClearH,
      hits: hitNames, boxStop, rasterStop, segBlocked,
      masonryTop: (() => { const t = city.masonryTopAt(gate.x, gate.z); return Number.isFinite(t) ? +t.toFixed(2) : null; })(),
    });
  }

  // ---- circuit band scan, SIEGE.md §2.8 method ----------------------------
  // 32 m segment driven straight through the wall line every 2 m.
  const bays = city.getGarrisonBays();
  const samples = [];
  for (const bay of bays) {
    const len = Math.hypot(bay.x1 - bay.x0, bay.z1 - bay.z0);
    const n = Math.max(1, Math.round(len / 2));
    for (let k = 0; k < n; k++) {
      const t = (k / n) * len;
      const cx = bay.x0 + bay.dx * t, cz = bay.z0 + bay.dz * t;
      const blocked = city.blocksMovement(
        cx + bay.nx * 16, cz + bay.nz * 16, cx - bay.nx * 16, cz - bay.nz * 16);
      samples.push({ x: +cx.toFixed(1), z: +cz.toFixed(1), bay: bay.index, stage: bay.stage, blocked });
    }
  }
  samples.sort((p, q) => p.x - q.x);
  const bandsList = [];
  let cur = null;
  for (const s of samples) {
    if (!s.blocked) {
      if (!cur) cur = { x0: s.x, x1: s.x, bays: new Set([s.bay]), stages: new Set([s.stage]), n: 0 };
      cur.x1 = s.x; cur.bays.add(s.bay); cur.stages.add(s.stage); cur.n++;
    } else if (cur) { bandsList.push(cur); cur = null; }
  }
  if (cur) bandsList.push(cur);
  res.bands = {
    samples: samples.length,
    open: samples.filter((s) => !s.blocked).length,
    list: bandsList.map((bd) => ({
      x0: bd.x0, x1: bd.x1, width: +(bd.x1 - bd.x0).toFixed(1), samples: bd.n,
      bays: [...bd.bays], stages: [...bd.stages],
    })),
  };

  // ---- the bay each gate lands in, for the "cut past the end" fault -------
  for (const gate of city.getGates()) {
    if (gate.id.startsWith('postern')) continue;
    for (const bay of bays) {
      const len = Math.hypot(bay.x1 - bay.x0, bay.z1 - bay.z0);
      const at = (gate.x - bay.x0) * bay.dx + (gate.z - bay.z0) * bay.dz;
      if (at < -1 || at > len + 1) continue;
      res.bays.push({
        gate: gate.id, bay: bay.index, x0: +bay.x0.toFixed(2), x1: +bay.x1.toFixed(2),
        len: +len.toFixed(3), at: +at.toFixed(3),
        overhangEnd: +(at + 2.6 - (len - 0.5)).toFixed(3),
        overhangStart: +(0.5 - (at - 2.6)).toFixed(3),
      });
    }
  }
  return res;
});

out.map = MAP;
out.logs = logs;
out.errors = errors;

console.log(`# meshes in cast set: ${out.meshCount}`);
console.log('\n## openings — what fills each one');
console.log('  id                 open   solid%  minStop  boxStop  rastStop  segBlk  topY   first hits');
for (const o of out.openings) {
  console.log(
    `  ${o.id.padEnd(18)} ${String(o.open).padEnd(6)} ` +
    `${(o.solidFrac * 100).toFixed(0).padStart(5)}% ` +
    `${String(o.minStop ?? '—').padStart(8)} ${String(o.boxStop ?? '—').padStart(8)} ` +
    `${String(o.rasterStop ?? '—').padStart(9)} ${String(o.segBlocked).padStart(7)} ` +
    `${String(o.masonryTop ?? '—').padStart(6)}  ${Object.entries(o.hits).map(([k, v]) => `${k}×${v}`).join(' ')}`
  );
}
console.log(`\n## blocksMovement bands — ${out.bands.open}/${out.bands.samples} samples open, ${out.bands.list.length} bands`);
for (const bd of out.bands.list) {
  console.log(`  x ${String(bd.x0).padStart(8)} … ${String(bd.x1).padStart(8)}  ${String(bd.width).padStart(5)} m  bays ${bd.bays.join(',')}  stage ${bd.stages.join(',')}`);
}
if (out.bays.length) {
  console.log('\n## gate axis vs its bay (overhang > 0 means "cut past the end")');
  for (const bb of out.bays) {
    console.log(`  ${bb.gate.padEnd(18)} bay ${String(bb.bay).padStart(3)}  len ${bb.len}  at ${bb.at}  overhang end ${bb.overhangEnd}  start ${bb.overhangStart}`);
  }
}
if (out.logs.length) { console.log('\n## build console'); for (const l of out.logs) console.log(`  ${l}`); }
if (out.errors.length) { console.log('\n## PAGE ERRORS'); for (const e of out.errors) console.log(`  ${e}`); }

if (JSON_OUT) await writeFile(path.join(ROOT, JSON_OUT), JSON.stringify(out, null, 1));
await browser.close();
if (server) server.kill('SIGTERM');
process.exit(out.errors.length ? 3 : 0);
