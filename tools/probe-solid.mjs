#!/usr/bin/env node
/**
 * Probe: is the masonry a player can see the same masonry a man collides with?
 *
 * The player's report is "units can just pass through the walls". That sentence has at
 * least three different mechanisms behind it and they need different fixes, so this probe
 * refuses to answer it with one number. It measures **three independent views of the same
 * stone** and reports where they disagree:
 *
 *   mesh    what is drawn — a raycast across the curtain against the baked city meshes.
 *   boxes   what a man collides with — `CitySystem.getObstacles()` through the sim's own
 *           `ObstacleField`, honouring `topY` exactly as `integrate` does.
 *   raster  what the pathfinder routes around — `CitySystem.blocksMovement()`.
 *
 * A hole in all three is a designed opening. A hole in `boxes` and `raster` but not in
 * `mesh` is a man walking through stone that is standing there — which is precisely what
 * "passing through the wall" looks like from the player's seat, and it is invisible to
 * every man-tick counter in this repo because those all measure against `boxes`.
 *
 * Cases:
 *   gates    every gate and postern, cast along its own axis. Where does the ray stop?
 *   curtain  the whole circuit at 1 m, all three views, disagreements listed.
 *   walk     the case matrix — field cohort, far-side order with the gate shut, rout,
 *            garrison, cavalry, siege engine — each ordered across the wall and each
 *            reported separately in man-ticks inside masonry per thousand.
 *
 * Usage:
 *   node tools/probe-solid.mjs --port=5251 [--map=carthage] [--case=gates|curtain|walk|all]
 *                              [--seconds=45] [--json=path]
 */

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5251);
const MAP = args.get('map') ?? '';
const CASE = args.get('case') ?? 'all';
const SECONDS = Number(args.get('seconds') ?? 45);
const SCENARIO = args.get('scenario') ?? 'assault';
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
const preexisting = await waitForServer(base, 1500);
if (!preexisting) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await waitForServer(base, 60000))) { console.error('vite did not start'); process.exit(1); }
}

/* Which tree answered? Same fingerprint discipline as probe-melee — several vite servers
 * run on this machine and a probe pointed at the wrong one is worth nothing. */
let served = '', live = false;
try {
  const r = await fetch(`${base}/src/city/CitySystem.ts`, { signal: AbortSignal.timeout(4000) });
  live = r.ok; served = await r.text();
} catch { /* leave false */ }
const MARKERS = ['pushWallBox', 'stairSolid', 'masonryTopAt', 'pushWallFamily', 'assertGatePassages'];
let localSrc = '';
try { localSrc = await readFile(path.join(ROOT, 'src/city/CitySystem.ts'), 'utf8'); } catch { /* */ }
const disagree = MARKERS.filter((m) => served.includes(m) !== localSrc.includes(m));
let rev = '?', dirty = '?';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  const st = execSync('git status --porcelain src/city src/sim', { cwd: ROOT }).toString().trim();
  dirty = st ? `${st.split('\n').length} file(s) modified` : 'clean';
} catch { /* */ }
console.log(
  `# probe-solid — server ${base} (${preexisting ? 'pre-existing' : 'started here'})\n` +
  `#   git ${rev}, src/city+src/sim ${dirty}, map ${MAP || 'rome'}, scenario ${SCENARIO}\n` +
  `#   live source: ${live ? 'YES' : 'NO — STALE BUILD, RESULTS ARE MEANINGLESS'}` +
  `   fingerprint: ${live && !disagree.length ? 'MATCHES this tree' : 'MISMATCH [' + disagree.join(',') + ']'}`
);
if (!live || disagree.length) process.exitCode = 2;

const encodeConfig = (c) => Buffer.from(JSON.stringify(c)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mapToken = MAP ? '&battle=' + encodeConfig({
  map: MAP, ...(MAP === 'carthage' ? { opponent: 2 } : {}),
  unitSize: 'ultra', quality: 'high', difficulty: 'hard', seed: 4265438264,
}) : '';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const url = `${base}/?harness=1&quality=high&w=960&h=540&scenario=${SCENARIO}${mapToken}`;
console.log(`• loading ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });

// ---------------------------------------------------------------------------
// Page-side helpers.
// ---------------------------------------------------------------------------
const HELPERS = `
window.__ps = (() => {
  const g = window.__game;
  const b = g.battle;
  const ctx = g.engine.context;
  const city = ctx.tryGet('city');
  const THREE = window.__game.THREE || null;

  /**
   * Every baked city mesh at full detail, plus whichever of the two gate-leaf chunks is
   * actually on screen.
   *
   * LOD matters here and the choice is deliberate. The curtain is gathered at lod0 always,
   * because a distance-culled bay is not a hole in the wall; the gate leaves are gathered
   * by \`visible\`, because exactly one of the intact pair and the wreck is on screen at a
   * time and gathering both would fill a broken carriageway with an intact door. This is
   * the same rule probe-wall arrived at after its gather silently stopped seeing the
   * leaves and reported a 4 m hole that was really a hole in the instrument.
   */
  const RE = /^(wall-\\d+|gate-door|gate-wreck|postern-door-\\d+|gatehouse[\\w-]*|tower[\\w-]*)-lod0$/;
  const gatherMeshes = () => {
    const out = [];
    const root = city.root;
    root.traverse((n) => {
      if (!n.isMesh || !n.parent) return;
      const p = n.parent.name || '';
      if (!RE.test(p)) return;
      // Exactly one of the intact leaves and the wreck is on screen; gathering both would
      // fill a broken carriageway with an intact door.
      if (/^(gate-(door|wreck)|postern-door-\\d+)-lod0$/.test(p) && !n.parent.visible) return;
      n.updateWorldMatrix(true, false);
      if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
      const bb = n.geometry.boundingBox.clone().applyMatrix4(n.matrixWorld);
      out.push({ mesh: n, minX: bb.min.x, maxX: bb.max.x, minZ: bb.min.z, maxZ: bb.max.z });
    });
    return out;
  };

  let MESHES = null;
  const meshes = () => (MESHES ||= gatherMeshes());
  const invalidateMeshes = () => { MESHES = null; };

  const RC = new window.__THREE_Raycaster();
  const OR = new window.__THREE_Vector3();
  const DR = new window.__THREE_Vector3();

  /**
   * Hits along a world ray against the wall meshes, nearest first.
   *
   * The candidate set is narrowed by world bounding box before the raycast. A wall chunk
   * carries 28,000 triangles and there are seven of them, so casting the whole circuit at
   * every sample would be four hundred seconds of triangle tests for an answer that only
   * ever involves the one chunk the sample stands in.
   */
  const cast = (ox, oy, oz, dx, dy, dz, far) => {
    const L = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / L, uz = dz / L;
    OR.set(ox, oy, oz); DR.set(ux, dy / L, uz);
    RC.set(OR, DR); RC.near = 0; RC.far = far;
    const ax = ox, az = oz, bx = ox + ux * far, bz = oz + uz * far;
    const loX = Math.min(ax, bx) - 1, hiX = Math.max(ax, bx) + 1;
    const loZ = Math.min(az, bz) - 1, hiZ = Math.max(az, bz) + 1;
    const cands = [];
    for (const m of meshes()) {
      if (m.maxX < loX || m.minX > hiX || m.maxZ < loZ || m.minZ > hiZ) continue;
      cands.push(m.mesh);
    }
    if (!cands.length) return [];
    const hits = RC.intersectObjects(cands, false);
    return hits.map((h) => ({
      d: +h.distance.toFixed(3),
      name: (h.object.parent && h.object.parent.name) || h.object.name || '?',
      mat: (h.object.material && h.object.material.name) || '',
    }));
  };

  const SOLDIER_RADIUS = 0.42;
  const TOP_SLACK = 0.4;

  /** Does the sim's own obstacle field stop a body at (x,z) standing at y? */
  const boxBlocked = (x, z, y) => b.masonry.blocked(x, z, y, SOLDIER_RADIUS);
  const boxAt = (x, z, y) => {
    const i = b.masonry.solidAt(x, z, y, SOLDIER_RADIUS);
    return i < 0 ? null : b.masonry.items ? b.masonry.items[i] : { i };
  };

  return {
    invalidateMeshes,
    meshCount: () => meshes().length,
    cast,
    boxBlocked,
    city, battle: b, ctx,
    SOLDIER_RADIUS, TOP_SLACK,
  };
})();
`;

/*
 * Three's classes are not on `window` and `import('three')` does not resolve inside
 * `page.evaluate` — there is no import map there. Import it by the *same URL* vite handed
 * the app, pulled out of a transformed source file rather than guessed, so this is the
 * identical module record the scene was built with.
 */
const three = await page.evaluate(async () => {
  const src = await (await fetch('/src/city/CitySystem.ts')).text();
  const m = src.match(/from\s*["']([^"']*three[^"']*)["']/);
  if (!m) return { ok: false, why: 'no three specifier in the transformed CitySystem.ts' };
  const T = await import(/* @vite-ignore */ m[1]);
  if (!T.Raycaster) return { ok: false, why: 'module has no Raycaster' };
  window.__THREE_Raycaster = T.Raycaster;
  window.__THREE_Vector3 = T.Vector3;
  return { ok: true, revision: T.REVISION, spec: m[1] };
});
if (!three.ok) { console.error(`REFUSED: ${three.why}`); await browser.close(); process.exit(2); }
console.log(`• three r${three.revision} via ${three.spec}`);
await page.evaluate((src) => { new Function(src)(); }, HELPERS);

const out = { url, map: MAP || 'rome', scenario: SCENARIO, rev };

// ---------------------------------------------------------------------------
// gates — cast along every gate and postern axis
// ---------------------------------------------------------------------------
if (CASE === 'gates' || CASE === 'all') {
  out.gates = await page.evaluate(() => {
    const ps = window.__ps;
    const city = ps.city, b = ps.battle;
    const res = [];
    for (const gate of city.getGates()) {
      // `facing` points out of the city, so the outward unit vector is (sin, cos).
      const ox = Math.sin(gate.facing), oz = Math.cos(gate.facing);
      const gy = b.groundAt(gate.x, gate.z);
      const rows = [];
      for (const h of [1.0, 1.7, 3.0]) {
        const sx = gate.x + ox * 16, sz = gate.z + oz * 16;
        /*
         * `h` is measured off the **opening's own ground**, not off the ground 16 m out.
         *
         * It was `groundAt(sx, sz) + h`, and once Carthage's ditch was actually cut that
         * became a probe that measures the ditch. 16 m out is inside a 20 m trench whose bed
         * is 6 m down, so at h = 1.0 the ray started about four metres below the wall's
         * footing and flew clean under the plinth, under the walled-up carriageway and out
         * the far side. It reported `porta-uticensis` and `porta-maritima` as **mesh CLEAR
         * at every height** while both of those gates' obstacle boxes stopped a man at
         * 11.25 m: a number that cannot be true given its neighbour.
         *
         * The tell that settled it was `postern-62`. At x +908 it is the one opening on the
         * circuit past the end of the ditch, and it was also the only one whose ray hit
         * anything. The rest of the frontage was measuring a trench.
         *
         * Casting from above the terrain costs nothing here: the set is city meshes only,
         * and there is no ground in it to fly over.
         */
        const sy = gy + h;
        const hits = ps.cast(sx, sy, sz, -ox, 0, -oz, 32);
        // Where the boxes and the raster say the crossing is stopped.
        let boxStop = null, rasterStop = null;
        for (let t = 0; t <= 32; t += 0.25) {
          const x = sx - ox * t, z = sz - oz * t;
          const y = b.groundAt(x, z);
          if (boxStop === null && ps.boxBlocked(x, z, y)) boxStop = +t.toFixed(2);
          if (rasterStop === null && city.blocksMovement(x, z, x, z)) rasterStop = +t.toFixed(2);
          if (boxStop !== null && rasterStop !== null) break;
        }
        let alt = null;
        for (let t = 0; t <= 32; t += 0.25) {
          const x = sx - ox * t, z = sz - oz * t;
          if (b.masonry.blocked(x, z, b.groundAt(x, z), 0.42)) { alt = +t.toFixed(2); break; }
        }
        rows.push({
          h, meshHits: hits.slice(0, 6), meshStop: hits.length ? hits[0].d : null,
          boxStop, rasterStop, alt,
        });
      }
      res.push({
        id: gate.id, open: gate.open, x: +gate.x.toFixed(1), z: +gate.z.toFixed(1),
        groundY: +gy.toFixed(2), rows,
      });
    }
    return res;
  });
}

// ---------------------------------------------------------------------------
// curtain — three views of the whole circuit at 1 m
// ---------------------------------------------------------------------------
if (CASE === 'curtain' || CASE === 'all') {
  out.curtain = await page.evaluate(() => {
    const ps = window.__ps;
    const city = ps.city, b = ps.battle;
    const bays = city.getGarrisonBays();
    const STEP = 1.0;
    const rows = [];
    let n = 0, meshOpen = 0, boxOpen = 0, rasterOpen = 0, ghost = 0, phantom = 0;
    for (const bay of bays) {
      const len = Math.hypot(bay.x1 - bay.x0, bay.z1 - bay.z0);
      const dx = (bay.x1 - bay.x0) / len, dz = (bay.z1 - bay.z0) / len;
      const nx = bay.nx, nz = bay.nz;      // outward normal
      const steps = Math.max(1, Math.round(len / STEP));
      for (let k = 0; k <= steps; k++) {
        const t = (k / steps) * len;
        const cx = bay.x0 + dx * t, cz = bay.z0 + dz * t;
        const gy = b.groundAt(cx, cz);
        // Ray from 12 m outside to 12 m inside, at chest height on the outside ground.
        const sx = cx + nx * 12, sz = cz + nz * 12;
        // Chest height on the wall's **own** ground, for the reason the gates case above
        // gives at length: 12 m out is the inner slope of the ditch, and a ray launched from
        // there passes under the footing and reports the curtain as undrawn. It listed the
        // whole of `porta-uticensis` as a phantom — "not drawn, but solid" — with a metre and
        // a half of tufa standing in it.
        const sy = gy + 1.5;
        const hits = ps.cast(sx, sy, sz, -nx, 0, -nz, 24);
        const mesh = hits.length > 0;
        let box = false, raster = false;
        for (let s = -12; s <= 12; s += 0.25) {
          const x = cx + nx * s, z = cz + nz * s;
          if (!box && ps.boxBlocked(x, z, gy)) box = true;
          if (!raster && city.blocksMovement(x, z, x, z)) raster = true;
          if (box && raster) break;
        }
        n++;
        if (!mesh) meshOpen++;
        if (!box) boxOpen++;
        if (!raster) rasterOpen++;
        // ghost: drawn solid, but a man walks through it.
        if (mesh && !box) { ghost++; rows.push({ kind: 'ghost', bay: bay.index, x: +cx.toFixed(1), z: +cz.toFixed(1), mesh, box, raster, hit: hits[0] || null }); }
        // phantom: nothing drawn, but a man is stopped.
        else if (!mesh && box) { phantom++; if (rows.length < 400) rows.push({ kind: 'phantom', bay: bay.index, x: +cx.toFixed(1), z: +cz.toFixed(1), mesh, box, raster }); }
        else if (!mesh && !box && rows.length < 400) rows.push({ kind: 'open', bay: bay.index, x: +cx.toFixed(1), z: +cz.toFixed(1), mesh, box, raster });
      }
    }
    return {
      samples: n, meshOpen, boxOpen, rasterOpen, ghost, phantom,
      ghostPct: +(ghost / n * 100).toFixed(2),
      rows: rows.slice(0, 250),
    };
  });
}

if (CASE === 'walk' || CASE === 'all') {
  const WALK = await readFile(path.join(ROOT, 'tools/scratch/solid-walk.js'), 'utf8').catch(() => null);
  if (WALK) {
    await page.evaluate((src) => { new Function(src)(); }, WALK);
    out.walk = await page.evaluate((s) => window.__psWalk(s), SECONDS);
  }
}

out.errors = errors.slice(0, 10);
if (JSON_OUT) await writeFile(path.join(ROOT, JSON_OUT), JSON.stringify(out, null, 1));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (out.gates) {
  console.log(`\n## gates and posterns — where a ray along the axis stops (${out.map})`);
  for (const g of out.gates) {
    console.log(`  ${g.id}  open=${g.open}  (${g.x}, ${g.z})`);
    for (const r of g.rows) {
      const m = r.meshStop === null ? 'CLEAR' : `${r.meshStop} m ${r.meshHits[0].name}`;
      console.log(`    h=${r.h}m  mesh ${m.padEnd(34)} boxes ${r.boxStop === null ? 'CLEAR' : r.boxStop + ' m'}   raster ${r.rasterStop === null ? 'CLEAR' : r.rasterStop + ' m'}   alt ${r.alt === null ? 'CLEAR' : r.alt + ' m'}`);
    }
  }
}
if (out.curtain) {
  const c = out.curtain;
  console.log(`\n## curtain — ${c.samples} samples at 1 m`);
  console.log(`   drawn open        ${c.meshOpen}`);
  console.log(`   boxes open        ${c.boxOpen}`);
  console.log(`   raster open       ${c.rasterOpen}`);
  console.log(`   GHOST (drawn solid, walked through)  ${c.ghost}  (${c.ghostPct}%)`);
  console.log(`   phantom (not drawn, but solid)       ${c.phantom}`);
  const byKind = {};
  for (const r of c.rows) (byKind[r.kind] ||= []).push(r);
  for (const k of Object.keys(byKind)) {
    console.log(`   ${k}: ${byKind[k].length} listed`);
    for (const r of byKind[k].slice(0, 24)) {
      console.log(`     bay ${String(r.bay).padStart(2)} @ (${r.x}, ${r.z})` +
        (r.hit ? `  first mesh ${r.hit.name} at ${r.hit.d} m` : ''));
    }
  }
}
if (out.walk) {
  const w = out.walk;
  console.log(`\n## walk — ${w.city}, ${w.seconds} s after a 20 s warm-up, ${w.unitsOrdered} units ordered across`);
  console.log('   class      units   man-ticks   inWall/1000  clean/1000  boxWall/1000  boxCity/1000  elev-in-wall  worst m');
  for (const [k, v] of Object.entries(w.rows)) {
    console.log(`   ${k.padEnd(10)} ${String(v.units).padStart(4)} ${String(v.manTicks).padStart(11)} ` +
      `${String(v.inWallPerMille).padStart(12)} ${String(v.inWallCleanPerMille).padStart(11)} ${String(v.boxWallPerMille).padStart(13)} ` +
      `${String(v.boxCityPerMille).padStart(13)} ${String(v.elevatedInWallManTicks).padStart(13)} ` +
      `${String(v.worstDepth).padStart(8)}` + (v.cleanDeepest ? `  clean-deepest bay ${v.cleanDeepest.bay} (${v.cleanDeepest.x}, ${v.cleanDeepest.z}) ${v.cleanWorstDepth} m` : ''));
  }
  console.log(`   crossings of the wall plane: ${w.crossings.total}, off any legitimate way ${w.crossings.offWay}` +
    ` (never-elevated ${w.crossings.offWayClean || 0})` +
    ` (${w.crossings.total ? (w.crossings.offWay / w.crossings.total * 100).toFixed(1) : 0}%)`);
  const seen = {};
  for (const c of w.crossings.where) seen[c.bay + ' ' + c.stage] = (seen[c.bay + ' ' + c.stage] || 0) + 1;
  console.log(`   where (first 30): ${JSON.stringify(seen)}`);
  console.log(`   units that got inside: ${w.unitsInside}, of which off any legitimate way: ${w.unitsInsideOffWay}`);
  for (const a of w.arrivals) {
    if (!a.inside) continue;
    console.log(`     #${a.id} ${a.typeId} (${a.cls}) start (${a.startX},${a.startZ}) -> (${a.nowX},${a.nowZ}) wall z ${a.wallZ} bay ${a.bay} through=${a.through}`);
  }
}
if (errors.length) console.log('\n! page errors: ' + errors.slice(0, 5).join(' | '));

await browser.close();
if (server) server.kill();
