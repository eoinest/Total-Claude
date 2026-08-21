#!/usr/bin/env node
/**
 * Can you stand on the wall? — the diagnosis and regression arm of the wall-walk camera.
 *
 * The owner's report is that at full zoom-in the camera walks at a soldier's eye line, and
 * that this should also work on top of a wall. It does not, and the reason is one query:
 * `RTSCamera.place()` resolves the eye's height from `heightAt`, which is the bare-earth
 * heightfield. So it reads the ground at the *foot* of the wall and parks the eye 1.7 m above
 * that, twenty-five metres under the walkway the focus is standing on.
 *
 * This probe never re-derives that. It reads the running game:
 *
 *   1. `city.getGarrisonBays()`   — where the walkway is, per bay, from the builder.
 *   2. `terrain.heightAt`         — what the camera is currently asking.
 *   3. `city.walkableTopAt`       — what it should be asking, where that exists yet.
 *   4. `engine.rig.camera.position` after a real `setCamera` + a real frame — what the
 *      camera actually did, which is the only statement that cannot be argued with.
 *
 * (4) is the check on (1)-(3): a fix that satisfies the surface query and still points the
 * camera into the masonry would pass the first three.
 *
 * Stations: the open curtain, a stair foot/mid/head, a tower centre, the gatehouse crown,
 * and — on Carthage — a traverse of the ditch. Named, so a before/after pair is the same
 * frame.
 *
 * Usage:
 *   node tools/probe-walleye.mjs --port=5347 --map=rome
 *   node tools/probe-walleye.mjs --port=5347 --map=carthage --json=/tmp/we-carthage.json
 *
 * Requires a dev server you started yourself on `--port`. It does not start one; the
 * provenance line is the check.
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));

const PORT = Number(args.get('port') ?? 5347);
const MAP = args.get('map') ?? 'rome';
const SCENARIO = args.get('scenario') ?? 'assault';
const JSON_OUT = args.get('json') ?? null;
const TIMEOUT = Number(args.get('timeout') ?? 240000);
const base = `http://127.0.0.1:${PORT}`;

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `${base}/?harness=1&quality=high&autoplay=0&scenario=${SCENARIO}`
  + `&w=640&h=400&battle=${token}`;

const served = await fetch(`${base}/src/core/RTSCamera.ts`).then((r) => r.text()).catch(() => '');
if (!served) {
  console.error(`FATAL: nothing served at ${base}/src/core/RTSCamera.ts — is vite up on ${PORT}?`);
  process.exit(2);
}
const arm = served.includes('walkableTopAt') ? 'AFTER' : 'BEFORE';
console.log(`source:      ${base}`);
console.log(`served tree: ${arm} arm (${served.length} bytes of src/core/RTSCamera.ts)`);
console.log(`url:         ${url}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: TIMEOUT });
} catch {
  console.error('FATAL: __game.ready never became true');
  await browser.close();
  process.exit(3);
}

const out = await page.evaluate(async () => {
  const g = window.__game;
  const eng = g.engine;
  const ctx = eng.context;
  const city = ctx.tryGet('city');
  const terrain = ctx.tryGet('terrain');
  const rig = eng.rig;
  const hAt = (x, z) => terrain.heightAt(x, z);
  const wAt = typeof city?.walkableTopAt === 'function'
    ? (x, z) => city.walkableTopAt(x, z) : null;
  const mAt = typeof city?.masonryTopAt === 'function'
    ? (x, z) => city.masonryTopAt(x, z) : null;

  const bays = city ? [...city.getGarrisonBays()] : [];
  const stairs = city ? [...city.getWallStairs()] : [];
  const gb = city?.getGateBlock ? city.getGateBlock() : null;

  /** One real frame at the parked camera, so `place()` has actually run against `update`. */
  const frame = () => { eng.advance(1 / 60, 1000 / 60, { render: false }); };

  /** Park the camera and report where the eye ended up. */
  const station = (name, x, z, zoom, yaw) => {
    g.setCamera(x, z, zoom, yaw);
    // Two frames: `jumpTo` is immediate, but `update` re-derives focus.y and re-places.
    frame(); frame();
    const p = rig.camera.position;
    const f = rig.focus;
    const dir = rig.camera.getWorldDirection(new (Object.getPrototypeOf(p).constructor)());
    return {
      name, x, z, zoom, yaw,
      terrainY: hAt(x, z),
      masonryY: mAt ? mAt(x, z) : null,
      walkY: wAt ? wAt(x, z) : null,
      focusY: f.y,
      eyeY: p.y, eyeX: p.x, eyeZ: p.z,
      pitchDeg: (Math.asin(-dir.y) * 180) / Math.PI,
      terrainAtEye: hAt(p.x, p.z),
      walkAtEye: wAt ? wAt(p.x, p.z) : null,
    };
  };

  const stations = [];
  const notes = [];

  // ---- the open curtain: mid-bay, on the walkway centreline ----------------
  const walkable = bays.filter((b) => b.walkable && !b.isGate);
  const pick = walkable[Math.floor(walkable.length * 0.5)] ?? bays[0];
  if (pick) {
    const t = pick.length * 0.5;
    const cx = pick.x0 + pick.dx * t;
    const cz = pick.z0 + pick.dz * t;
    notes.push(`curtain bay ${pick.index} stage=${pick.stage} walkY=${pick.walkY.toFixed(2)} `
      + `groundY=${pick.groundY.toFixed(2)} halfT=${pick.halfThickness.toFixed(2)} `
      + `parapetInner=${pick.parapetInner.toFixed(2)} crestY=${pick.crestY.toFixed(2)}`);
    // Look ALONG the run and ACROSS it: the eye sits 3.2 m behind the focus at zoom 0, so
    // which way it faces decides whether the eye is on stone or over the void.
    const along = Math.atan2(-pick.dx, -pick.dz);
    stations.push(station('curtain-along', cx, cz, 0, along));
    stations.push(station('curtain-across', cx, cz, 0, along + Math.PI / 2));
    stations.push(station('curtain-mid', cx, cz, 0.35, along));
    // A traverse across the walkway, from 6 m outboard to 6 m inboard.
    for (const off of [-6, -3.2, -1.6, -0.8, 0, 0.8, 1.6, 3.2, 6]) {
      stations.push(station(`curtain-off${off}`, cx + pick.nx * off, cz + pick.nz * off, 0, along));
    }
  }

  // ---- a stair -------------------------------------------------------------
  const st = stairs[Math.floor(stairs.length * 0.5)];
  if (st) {
    notes.push(`stair bay ${st.bay} foot=(${st.footX.toFixed(1)},${st.footZ.toFixed(1)},`
      + `${st.footY.toFixed(2)}) head=(${st.headX.toFixed(1)},${st.headZ.toFixed(1)},`
      + `${st.headY.toFixed(2)}) top=(${st.topX.toFixed(1)},${st.topZ.toFixed(1)},`
      + `${st.topY.toFixed(2)}) run=${st.run.toFixed(1)} rise=${st.rise.toFixed(2)} `
      + `width=${st.width.toFixed(2)} side=${st.side}`);
    const yawUp = Math.atan2(-st.dx, -st.dz);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const x = st.footX + (st.headX - st.footX) * f;
      const z = st.footZ + (st.headZ - st.footZ) * f;
      const s = station(`stair-${f}`, x, z, 0, yawUp);
      s.rakeY = st.footY + st.rise * f;
      stations.push(s);
    }
    stations.push(station('stair-top', st.topX, st.topZ, 0, yawUp));
  }

  // ---- a tower centre ------------------------------------------------------
  const tower = bays.find((b) => b.hasTower && b.walkable && b.index > 0
    && bays[b.index - 1]?.walkable);
  if (tower) {
    const prev = bays[tower.index - 1];
    notes.push(`tower at bay ${tower.index} x0=(${tower.x0.toFixed(1)},${tower.z0.toFixed(1)}) `
      + `towerHalf=${tower.towerHalf.toFixed(2)} passLoY=${tower.passLoY.toFixed(2)} `
      + `passHiY=${tower.passHiY.toFixed(2)} prev.walkY=${prev.walkY.toFixed(2)} `
      + `this.walkY=${tower.walkY.toFixed(2)} pass=[${tower.passInner.toFixed(2)},`
      + `${tower.passOuter.toFixed(2)}]`);
    const along = Math.atan2(-tower.dx, -tower.dz);
    const mid = (tower.passInner + tower.passOuter) * 0.5;
    for (const d of [-8, -4, -1, 0, 1, 4, 8]) {
      const x = tower.x0 + tower.dx * d + tower.nx * mid;
      const z = tower.z0 + tower.dz * d + tower.nz * mid;
      stations.push(station(`tower${d}`, x, z, 0, along));
    }
  }

  // ---- the gatehouse crown -------------------------------------------------
  if (gb) {
    notes.push(`gateBlock (${gb.x.toFixed(1)},${gb.z.toFixed(1)}) halfRun=${gb.halfRun.toFixed(2)} `
      + `halfDepth=${gb.halfDepth.toFixed(2)} topY=${gb.topY.toFixed(2)} `
      + `sillY=${gb.sillY.toFixed(2)} parapet=[${gb.parapetInner.toFixed(2)},`
      + `${gb.parapetOuter.toFixed(2)}] cityward=${gb.crenelledCityward}`);
    const along = Math.atan2(-gb.dx, -gb.dz);
    for (const d of [0, 6, 12]) {
      stations.push(station(`gate+${d}`, gb.x + gb.dx * d, gb.z + gb.dz * d, 0, along));
    }
    stations.push(station('gate-off2', gb.x + gb.nx * 2, gb.z + gb.nz * 2, 0, along));
  }

  // ---- the ditch -----------------------------------------------------------
  const ditch = city?.getDitch ? city.getDitch() : null;
  if (ditch) {
    notes.push(`ditch width=${ditch.width} depth=${ditch.depth} offset=${ditch.offset} `
      + `built=${ditch.built} path=${ditch.path?.length ?? 0}pts`);
  }
  // Traverse the terrain in z at the curtain's x, out to 60 m fieldward — this finds the
  // ditch whether or not the city publishes a record for it.
  const traverse = [];
  if (pick) {
    const t = pick.length * 0.5;
    const cx = pick.x0 + pick.dx * t;
    const cz = pick.z0 + pick.dz * t;
    for (let d = 0; d <= 80; d += 2) {
      const x = cx + pick.nx * d;
      const z = cz + pick.nz * d;
      traverse.push({ d, y: hAt(x, z), walk: wAt ? wAt(x, z) : null });
    }
    // Park the camera at the deepest point of the traverse and at the lip, at eye level.
    let deep = traverse[0];
    for (const p of traverse) if (p.d > 6 && p.y < deep.y) deep = p;
    const along = Math.atan2(-pick.dx, -pick.dz);
    for (const d of [deep.d - 12, deep.d - 6, deep.d, deep.d + 6, deep.d + 12]) {
      if (d < 0) continue;
      stations.push(station(`ditch${d}`, cx + pick.nx * d, cz + pick.nz * d, 0, along));
    }
    notes.push(`traverse deepest at d=${deep.d} y=${deep.y.toFixed(2)}`);
  }

  // ---- the gate passage: a camera marching through the arch ----------------
  if (gb) {
    const outward = Math.atan2(gb.nx, gb.nz);
    for (const d of [-14, -7, 0, 7, 14]) {
      stations.push(station(`arch${d}`, gb.x + gb.nx * d, gb.z + gb.nz * d, 0, outward));
    }
  }

  /**
   * Where the driver should hold a key down, and which one.
   *
   * Resolved in here off the wall's own geometry — the bay this run picked, the stair it
   * picked — rather than written down outside, so a moved wall moves the walk with it. `KeyW`
   * pans the focus along +(sin yaw, cos yaw), so `atan2(nx, nz)` walks it straight out over
   * the fieldward parapet and a yaw along the run walks it down the curtain.
   */
  const walkPlan = [];
  if (pick) {
    const wt = pick.length * 0.5;
    const wx = pick.x0 + pick.dx * wt;
    const wz = pick.z0 + pick.dz * wt;
    const outYaw = Math.atan2(pick.nx, pick.nz);
    const alongYaw = Math.atan2(pick.dx, pick.dz);
    walkPlan.push({
      name: 'off-the-parapet', x: wx, z: wz, yaw: outYaw, key: 'KeyW', frames: 150,
      why: 'from the walkway centreline out over the fieldward lip — the cliff',
    });
    walkPlan.push({
      name: 'along-the-curtain', x: wx, z: wz, yaw: alongYaw, key: 'KeyW', frames: 150,
      why: 'down the wall-walk, across whatever joints fall in 27 m of pan',
    });
    walkPlan.push({
      name: 'into-the-ditch', x: wx + pick.nx * 44, z: wz + pick.nz * 44,
      yaw: outYaw + Math.PI, key: 'KeyW', frames: 240,
      why: 'the earth, which must read exactly as it did before',
    });
  }
  if (st) {
    walkPlan.push({
      name: 'up-the-stair', x: st.footX, z: st.footZ,
      yaw: Math.atan2(st.headX - st.footX, st.headZ - st.footZ), key: 'KeyW', frames: 240,
      why: 'foot to head, which the rate bound must not touch',
    });
  }
  if (gb) {
    // Straight through the arch, from 26 m out in the field to 26 m inside the city. The
    // gatehouse has two surfaces stacked in one footprint and this is the lower one.
    walkPlan.push({
      name: 'through-the-arch',
      x: gb.x + gb.nx * 26, z: gb.z + gb.nz * 26,
      yaw: Math.atan2(-gb.nx, -gb.nz), key: 'KeyW', frames: 300,
      why: 'the carriageway, which must not answer with the roof over it',
    });
  }
  if (tower) {
    const mid = (tower.passInner + tower.passOuter) * 0.5;
    walkPlan.push({
      name: 'through-the-tower',
      x: tower.x0 + tower.dx * -14 + tower.nx * mid,
      z: tower.z0 + tower.dz * -14 + tower.nz * mid,
      yaw: Math.atan2(tower.dx, tower.dz), key: 'KeyW', frames: 220,
      why: 'the step between two walks, ramped across the footprint',
    });
  }

  return {
    map: (ctx.tryGet('terrain')?.map?.id) ?? 'unknown',
    bays: bays.length,
    walkableBays: bays.filter((b) => b.walkable).length,
    stairs: stairs.length,
    hasWalkableTopAt: wAt !== null,
    notes, stations, traverse, walkPlan,
    stageCounts: bays.reduce((a, b) => (a[b.stage] = (a[b.stage] ?? 0) + 1, a), {}),
  };
});

/**
 * The transitions, with a real key held down through the real `update`.
 *
 * The station table above parks the camera and asks where it went, which cannot see the thing
 * the owner's report is actually about — what the *transition* looks like. `input.key()` reads
 * live keyboard state, so holding a key here and advancing the fixed step a frame at a time is
 * the player's own code path and not a second copy of the pan.
 */
const walks = [];
for (const w of out.walkPlan ?? []) {
  await page.evaluate((p) => {
    window.__game.setCamera(p.x, p.z, 0, p.yaw);
    window.__game.engine.advance(1 / 60, 1000 / 60, { render: false });
    window.__game.engine.advance(1 / 60, 1000 / 60, { render: false });
  }, w);
  await page.keyboard.down(w.key);
  const rows = await page.evaluate((p) => {
    const g = window.__game;
    const rig = g.engine.rig;
    const terrain = g.engine.context.tryGet('terrain');
    const city = g.engine.context.tryGet('city');
    const r = [];
    for (let i = 0; i < p.frames; i++) {
      g.engine.advance(1 / 60, 1000 / 60, { render: false });
      const q = rig.camera.position;
      r.push({
        i,
        x: +rig.focus.x.toFixed(2), z: +rig.focus.z.toFixed(2),
        focusY: +rig.focus.y.toFixed(3), eyeY: +q.y.toFixed(3),
        terrain: +terrain.heightAt(rig.focus.x, rig.focus.z).toFixed(3),
        walk: city && typeof city.walkableTopAt === 'function'
          ? city.walkableTopAt(rig.focus.x, rig.focus.z) : null,
      });
    }
    return r;
  }, w);
  await page.keyboard.up(w.key);
  walks.push({ ...w, rows });
}

await browser.close();

console.log(`\nmap=${out.map} bays=${out.bays} walkable=${out.walkableBays} stairs=${out.stairs}`);
console.log(`stages: ${JSON.stringify(out.stageCounts)}`);
console.log(`city.walkableTopAt present: ${out.hasWalkableTopAt}`);
for (const n of out.notes) console.log(`  ${n}`);

const f = (v) => (v === null || v === undefined ? '     -'
  : !Number.isFinite(v) ? (v > 0 ? '   +inf' : '   -inf') : v.toFixed(2).padStart(7));
console.log('\nstation            terrain  masonry     walk    focus      eye  eye-walk   pitch');
for (const s of out.stations) {
  // The number that matters: how far the eye is above the surface the focus is standing on.
  const surf = Number.isFinite(s.walkY) ? Math.max(s.walkY, s.terrainY) : s.terrainY;
  const above = s.eyeY - surf;
  console.log(`${s.name.padEnd(16)} ${f(s.terrainY)} ${f(s.masonryY)} ${f(s.walkY)} `
    + `${f(s.focusY)} ${f(s.eyeY)} ${f(above)} ${f(s.pitchDeg)}`);
}
console.log('\nditch traverse (fieldward from the curtain centreline):');
console.log(out.traverse.map((p) => `${p.d}:${p.y.toFixed(1)}`).join(' '));

for (const w of walks) {
  const rows = w.rows;
  let worstRise = 0;
  let worstFall = 0;
  for (let i = 1; i < rows.length; i++) {
    const v = (rows[i].eyeY - rows[i - 1].eyeY) * 60;
    if (v > worstRise) worstRise = v;
    if (v < worstFall) worstFall = v;
  }
  const span = Math.hypot(rows.at(-1).x - rows[0].x, rows.at(-1).z - rows[0].z);
  console.log(`\nwalk ${w.name} — ${w.why}`);
  console.log(`  ${rows.length} frames, ${span.toFixed(1)} m of pan, `
    + `eye rate max +${worstRise.toFixed(1)} / ${worstFall.toFixed(1)} m/s`);
  console.log('    f    focus.x  focus.z   terrain     walk    focusY      eye  eye-surf');
  const every = Math.max(1, Math.round(rows.length / 16));
  for (let i = 0; i < rows.length; i += every) {
    const r = rows[i];
    const surf = Number.isFinite(r.walk) && r.walk > r.terrain ? r.walk : r.terrain;
    console.log(`  ${String(r.i).padStart(3)} ${f(r.x)} ${f(r.z)} ${f(r.terrain)} `
      + `${f(r.walk)} ${f(r.focusY)} ${f(r.eyeY)} ${f(r.eyeY - surf)}`);
  }
}

if (errors.length) {
  console.log(`\n${errors.length} page error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
}
if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({ ...out, walks, errors }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
process.exit(errors.length ? 1 : 0);
