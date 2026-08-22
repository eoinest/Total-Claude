#!/usr/bin/env node
/**
 * The ground-level judge's instrument: what the city measures **at the height of a man**.
 *
 *   node tools/scratch/judge-fabric.mjs --map=campus-martius --port=5901 --out=/tmp/rome.json
 *   node tools/scratch/judge-fabric.mjs --map=carthage       --port=5901 --out=/tmp/carth.json
 *
 * Not a plan checker. The plan diagnostic and `probe-fabric` already grade the layout from
 * above, and a second judge is grading positions against the plates. This measures the three
 * things that decide whether a frame taken from *inside* the city reads as a city, and it
 * measures each one against something outside the generator:
 *
 *   1. **Is the way in solid?** Walk the gate bay's own inward normal in 5 m steps and ask, at
 *      every step, whether a standing man is inside a solid — tested against
 *      `CitySystem.getObstacles()`, the oriented boxes the *simulation* collides with, not
 *      against the street plan. A processional way a man cannot walk down is not a way, and
 *      this says so from the man's point of view rather than the road's.
 *
 *   2. **Enclosure — H/W.** From each clear station, a `THREE.Raycaster` is fired left and
 *      right against the **built scene graph**, and then straight down from 220 m above
 *      whatever it hit, to find the height of that frontage. So `W` is the distance between
 *      the two things a man can see and `H` is the height of the triangles that were actually
 *      submitted — not a declared footprint and not a floor count. `H/W` is the ratio that
 *      decides whether a gap between buildings reads as a street: a real ancient city street
 *      runs about 1.0–3.0, a modern suburban road under 0.3, open ground undefined. Nothing
 *      else on this project measures it and it is the number that separates a street from a
 *      gap between objects.
 *
 *   3. **Density, sampled the way a man meets it.** A few hundred random points inside the
 *      walled ground; for each open one, the distance to the nearest built thing in four
 *      directions. The median of that is "how far can you stand from a building in this city",
 *      which is a density statement in metres rather than in per-cent-of-ground.
 *
 * `THREE` is imported into the page a second time from `/node_modules/three/build/…` rather
 * than reached for on the app's own module scope, which the app does not export. A raycaster
 * from a second instance works on the scene's objects because `Raycaster` dispatches to each
 * object's own `raycast` method; only the `Ray` maths comes from this copy.
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

const MAP = args.get('map') ?? 'campus-martius';
const PORT = Number(args.get('port') ?? 5901);
const OUT = args.get('out') ?? `/tmp/judge-fabric-${MAP}.json`;
const SAMPLES = Number(args.get('samples') ?? 400);
if (PORT === 5173) { console.error('not 5173'); process.exit(1); }

const { base, server } = await ensureServer({
  port: PORT, root: ROOT, cacheDir: `/tmp/tc-judge/.vite-p${PORT}`,
});

/*
 * `launchBrowser` — `tools/lib/browser-budget.mjs`, 22 Aug 2026. A judge is a long run and a
 * judge loop is several of them; on the day this landed twelve agents each opening one browser
 * put the machine at load average 160 on 16 cores. The four GPU flags that were listed here are
 * the default `GPU_ARGS` now, so only the two specific to a screenshot rig are passed.
 */
const browser = await launchBrowser({
  label: 'judge-fabric', port: PORT, root: ROOT,
  args: ['--enable-gpu-rasterization', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));

await bootThroughMenu(page, {
  base, map: MAP, scenario: 'assault', tier: 'ultra',
  query: 'autoplay=0&quality=ultra',
});

const out = await page.evaluate(async ({ SAMPLES }) => {
  const THREE = await import(/* @vite-ignore */ '/node_modules/three/build/three.module.js');
  const g = window.__game;
  const city = g.engine.context.tryGet('city');
  const terrain = g.engine.context.tryGet('terrain');
  const scene = g.engine.scene ?? g.engine.renderer?.__scene ?? null;
  const obs = city.getObstacles();
  const bays = city.getGarrisonBays();
  const gateBay = bays.find((b) => b.isGate) ?? bays[0];
  const stats = city.stats();

  // Root to raycast against. The soldiers and the sky are excluded by name so a man standing
  // in the street is not reported as a building.
  const roots = [];
  const skip = /soldier|unit|banner|sky|cloud|grass|water|dust|proj|corpse|debris/i;
  const src = scene ?? g.engine.scene;
  src.traverse((o) => { /* touch, to force matrices */ o.updateMatrixWorld?.(false); });
  for (const c of src.children) if (!skip.test(c.name ?? '')) roots.push(c);

  const rc = new THREE.Raycaster();
  rc.far = 400;
  const dirV = new THREE.Vector3();
  const orgV = new THREE.Vector3();

  /** First hit along a direction, or null. Terrain is reported separately from built work. */
  const shoot = (ox, oy, oz, dx, dy, dz, far) => {
    orgV.set(ox, oy, oz);
    dirV.set(dx, dy, dz).normalize();
    rc.set(orgV, dirV);
    rc.far = far;
    const hits = rc.intersectObjects(roots, true);
    for (const h of hits) {
      if (h.distance < 0.05) continue;
      // Name the chunk family the hit came from, walking up to the named ancestor.
      let n = h.object, name = n.name ?? '';
      while (n && !name) { n = n.parent; name = n?.name ?? ''; }
      return { d: h.distance, y: h.point.y, name };
    }
    return null;
  };

  const H = (x, z) => terrain.heightAt(x, z);

  /** Height of built work above the ground at (x, z): a ray dropped from 220 m. */
  const roofAt = (x, z) => {
    const gy = H(x, z);
    const hit = shoot(x, gy + 220, z, 0, -1, 0, 260);
    if (!hit) return null;
    const h = hit.y - gy;
    return h > 0.5 ? { h: +h.toFixed(1), name: hit.name } : null;
  };

  // The gate's own frame.
  const gx = (gateBay.x0 + gateBay.x1) / 2;
  const gz = (gateBay.z0 + gateBay.z1) / 2;
  const rl = Math.hypot(gateBay.x1 - gateBay.x0, gateBay.z1 - gateBay.z0);
  const rdx = (gateBay.x1 - gateBay.x0) / rl, rdz = (gateBay.z1 - gateBay.z0) / rl;
  let nx = -rdz, nz = rdx;
  {
    let side = 0;
    for (const o of obs) {
      if (o.kind !== 'building') continue;
      side += ((o.x - gx) * nx + (o.z - gz) * nz) > 0 ? 1 : -1;
    }
    if (side > 0) { nx = -nx; nz = -nz; }   // +n points away from the fabric
  }

  const insideBox = (o, x, z) => {
    const c = Math.cos(-o.rot), s = Math.sin(-o.rot);
    const px = x - o.x, pz = z - o.z;
    const u = px * c - pz * s, v = px * s + pz * c;
    return Math.abs(u) <= o.hw && Math.abs(v) <= o.hd;
  };
  const solidAt = (x, z) => {
    for (const o of obs) {
      if (o.kind === 'wall' || o.kind === 'tower' || o.kind === 'gate') continue;
      if (Math.abs(x - o.x) > o.hw + o.hd || Math.abs(z - o.z) > o.hw + o.hd) continue;
      if (insideBox(o, x, z)) return o;
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // 1 + 2. The walk in from the gate, on the gate's own axis.
  // ---------------------------------------------------------------------------
  const walk = [];
  for (let s = 0; s <= 700; s += 5) {
    const x = gx - nx * s, z = gz - nz * s;
    const gy = H(x, z);
    const hit = solidAt(x, z);
    const rec = { s, x: +x.toFixed(1), z: +z.toFixed(1), y: +gy.toFixed(2) };
    if (hit) {
      rec.solid = { kind: hit.kind, cx: +hit.x.toFixed(0), cz: +hit.z.toFixed(0) };
      const r = roofAt(x, z);
      if (r) rec.solid.h = r.h;
    } else {
      const eye = gy + 1.75;
      const L = shoot(x, eye, z, -rdx, 0, -rdz, 250);
      const R = shoot(x, eye, z, rdx, 0, rdz, 250);
      const lr = L ? roofAt(x - rdx * (L.d + 1.5), z - rdz * (L.d + 1.5)) : null;
      const rr = R ? roofAt(x + rdx * (R.d + 1.5), z + rdz * (R.d + 1.5)) : null;
      rec.left = L ? { d: +L.d.toFixed(0), h: lr ? lr.h : null, name: L.name } : null;
      rec.right = R ? { d: +R.d.toFixed(0), h: rr ? rr.h : null, name: R.name } : null;
      if (L && R && lr && rr) {
        const w = L.d + R.d;
        rec.w = +w.toFixed(0);
        rec.hOverW = +(((lr.h + rr.h) / 2) / w).toFixed(2);
      }
    }
    walk.push(rec);
  }

  // ---------------------------------------------------------------------------
  // 3. Density and enclosure, sampled over the walled ground.
  // ---------------------------------------------------------------------------
  // The sample box is the ground behind the wall on this map's own axis: from 40 m inside the
  // gate bay to 700 m inside, and the full run of the curtain that carries fabric.
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296); };
  const samples = [];
  let insideSolid = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const t = (rnd() * 2 - 1) * 500;               // along the curtain
    const u = 40 + rnd() * 660;                    // into the city
    const x = gx + rdx * t - nx * u;
    const z = gz + rdz * t - nz * u;
    if (Math.abs(x) > 1350 || Math.abs(z) > 1350) continue;
    if (solidAt(x, z)) { insideSolid++; continue; }
    const gy = H(x, z);
    if (gy < (terrain.waterLevel ?? -1e9)) continue;
    const eye = gy + 1.75;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const ds = [];
    for (const [ax, az] of dirs) {
      const h = shoot(x, eye, z, ax, 0, az, 300);
      ds.push(h ? h.d : null);
    }
    const near = ds.filter((d) => d !== null);
    samples.push({
      x: +x.toFixed(0), z: +z.toFixed(0),
      nearest: near.length ? +Math.min(...near).toFixed(0) : null,
      // The narrower opposed pair is the street the man is standing in, if he is in one.
      wEW: (ds[0] !== null && ds[1] !== null) ? +(ds[0] + ds[1]).toFixed(0) : null,
      wNS: (ds[2] !== null && ds[3] !== null) ? +(ds[2] + ds[3]).toFixed(0) : null,
    });
  }

  return {
    cityId: stats.id,
    gate: { x: +gx.toFixed(1), z: +gz.toFixed(1), nx: +nx.toFixed(4), nz: +nz.toFixed(4) },
    counts: {
      obstacles: obs.length,
      buildings: obs.filter((o) => o.kind === 'building').length,
      monuments: obs.filter((o) => o.kind === 'monument').length,
      bays: bays.length,
    },
    cityStats: {
      wayInsideMonument: stats.wayInsideMonument, waySamples: stats.waySamples,
      fabricOverlaps: stats.fabricOverlaps, footprintOverlaps: stats.footprintOverlaps,
      ways: stats.ways,
    },
    walk,
    samples,
    insideSolidSamples: insideSolid,
    /*
     * Monument heights are the **maximum over a grid inside the footprint**, with the datum
     * taken at the monument's own centre.
     *
     * Two earlier versions of this were wrong and both are worth recording, because each
     * produced a plausible number that would have been published.
     *
     *  - **A single ray dropped on the centre** falls through the arena of the Colosseum, the
     *    orchestra of the Theatre of Pompey and the palaestra of every bath and reports the
     *    sanded floor. The Flavian Amphitheatre measured **9.2 m** that way, a fifth of its
     *    real 48.5.
     *  - **A ring at 0.72 of each half-extent**, with the datum re-sampled at each ring point,
     *    reported the same building at **89 m** — nearly double its real height — because the
     *    datum moved with the ray and the ground under the ring is not the ground under the
     *    building.
     *
     * So: an 11 x 11 grid inside 0.9 of the footprint, the maximum hit, and **one** datum for
     * the whole monument. `open` is the fraction of the grid that hit nothing at all, which is
     * how a court, an arena or a peristyle shows up as itself rather than as a short building.
     */
    monuments: obs.filter((o) => o.kind === 'monument')
      .map((o) => {
        const datum = H(o.x, o.z);
        const c = Math.cos(o.rot), sn = Math.sin(o.rot);
        let top = -Infinity, miss = 0, n = 0;
        for (let i = 0; i < 11; i++) {
          for (let j = 0; j < 11; j++) {
            const lu = ((i / 10) * 2 - 1) * o.hw * 0.9;
            const lv = ((j / 10) * 2 - 1) * o.hd * 0.9;
            const px = o.x + lu * c + lv * sn;
            const pz = o.z - lu * sn + lv * c;
            n++;
            const hit = shoot(px, datum + 240, pz, 0, -1, 0, 300);
            if (!hit) { miss++; continue; }
            if (hit.y > top) top = hit.y;
          }
        }
        return {
          x: +o.x.toFixed(0), z: +o.z.toFixed(0),
          w: +(2 * o.hw).toFixed(1), d: +(2 * o.hd).toFixed(1),
          h: Number.isFinite(top) ? +(top - datum).toFixed(1) : null,
          open: +(miss / n).toFixed(2),
        };
      })
      .sort((a, b) => b.w * b.d - a.w * a.d).slice(0, 40),
  };
}, { SAMPLES });

out.errors = errs;
await writeFile(OUT, JSON.stringify(out, null, 1));

const med = (a) => { const s = a.filter((v) => v !== null && v !== undefined).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (a, p) => { const s = a.filter((v) => v !== null && v !== undefined).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

const w = out.walk;
const blocked = w.filter((r) => r.solid);
const enc = w.filter((r) => r.hOverW !== undefined && r.hOverW !== null);
console.log(`\n== ${out.cityId} ==  ${out.counts.buildings} building solids, ${out.counts.monuments} monuments`);
console.log(`gate (${out.gate.x}, ${out.gate.z})   ways in a monument: ${out.cityStats.wayInsideMonument}/${out.cityStats.waySamples}`);
console.log(`\nTHE WALK IN, on the gate's own axis, 0..700 m in 5 m steps (${w.length} stations)`);
console.log(`  standing inside a solid       ${blocked.length}/${w.length}  (${(100 * blocked.length / w.length).toFixed(0)}%)`);
const runs = [];
for (const r of blocked) {
  const last = runs[runs.length - 1];
  if (last && r.s - last.to <= 5) { last.to = r.s; }
  else runs.push({ from: r.s, to: r.s, what: r.solid });
}
for (const r of runs) console.log(`    ${String(r.from).padStart(3)}–${String(r.to).padStart(3)} m in   ${r.what.kind.padEnd(9)} ${r.what.h ?? '?'} m high at (${r.what.cx}, ${r.what.cz})`);
console.log(`  frontage on both sides at     ${enc.length}/${w.length} stations`);
if (enc.length) {
  console.log(`    gap between frontages       p25 ${pct(enc.map((r) => r.w), 0.25)} m   median ${med(enc.map((r) => r.w))} m   p75 ${pct(enc.map((r) => r.w), 0.75)} m`);
  console.log(`    H/W                         p25 ${pct(enc.map((r) => r.hOverW), 0.25)}   median ${med(enc.map((r) => r.hOverW))}   p75 ${pct(enc.map((r) => r.hOverW), 0.75)}`);
}
const S = out.samples;
console.log(`\nRANDOM OPEN POINTS in the walled ground (${S.length} clear of ${S.length + out.insideSolidSamples} tried)`);
console.log(`  distance to the nearest built thing   p10 ${pct(S.map((s) => s.nearest), 0.1)} m   median ${med(S.map((s) => s.nearest))} m   p90 ${pct(S.map((s) => s.nearest), 0.9)} m`);
const narrow = S.map((s) => {
  const a = [s.wEW, s.wNS].filter((v) => v !== null);
  return a.length ? Math.min(...a) : null;
}).filter((v) => v !== null);
console.log(`  narrower opposed gap                  p10 ${pct(narrow, 0.1)} m   median ${med(narrow)} m   p90 ${pct(narrow, 0.9)} m`);
console.log(`\nMONUMENTS as built (world m), largest plan first:`);
for (const m of out.monuments.slice(0, 14)) console.log(`  ${String(m.w).padStart(6)} x ${String(m.d).padStart(6)}  h ${String(m.h ?? '?').padStart(5)}  open ${String(m.open).padStart(4)}   at (${m.x}, ${m.z})`);
console.log(`\n→ ${OUT}`);
if (errs.length) console.log(`! ${errs.length} page error(s): ${errs.slice(0, 3).join(' | ')}`);

await browser.close();
if (server) server.kill('SIGTERM');
