#!/usr/bin/env node
/**
 * A war elephant's death, its crew, and what the field looks like afterwards — from a
 * camera that is actually looking at the animal.
 *
 * Every elephant figure recorded in this workstream so far was taken with the camera parked
 * where the squadron *deployed*. By the time an animal dies the fight is a hundred metres
 * away, so those frames photograph empty grass and those draw counts are counts of a frame
 * with no elephant in it. This probe never parks: it re-aims on the animal's own coordinates
 * at every shot, at a bearing derived from the heading it died on.
 *
 * It runs the shipped Carthaginian field battle. The one thing it stages is *which* animal
 * dies and *when*, because the alternative is a poll that reports the fall already half over.
 *
 * Arms:
 *   fall     the collapse at eight marks, close camera, side-on, with the instance buffers
 *            read at each one
 *   crew     where the mahout and the three tower men are, counted out of the soldier tier's
 *            own position buffer within a radius of the carcass
 *   after    the same body sixty seconds later, and the field around it
 *   draws    an interleaved A/B at four cameras that all contain a carcass: the whole
 *            elephant tier visible against hidden, which is the total cost of every animal
 *            alive and dead in that frame
 *   part     a Roman cohort ordered straight over the body, and how close they get
 *
 *   node tools/probe-elefield.mjs --port=5691 --out=screenshots/elefield
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5691);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/elefield');
const JSON_OUT = args.get('json') ?? null;

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1500))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) { console.error('vite did not start'); process.exit(1); }
}
console.log(`server: ${base}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(`pageerror: ${e.message}`); console.error('PAGE ERROR:', e.message); });
page.on('console', (m) => {
  if (m.type() === 'error') { errors.push(`console: ${m.text()}`); console.error('CONSOLE:', m.text()); }
});

await page.goto(`${base}/?harness=1&quality=ultra&enemy=carthage`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });
console.log('ready');

// The HUD, the same way `shoot.mjs` does it: DOM plus the world-space overlay group.
await page.addStyleTag({
  content: '#hud-root, #loading, #menu-root { display: none !important; visibility: hidden !important; }',
});
await page.evaluate(() => {
  const hud = window.__game?.engine?.context?.tryGet?.('hud') ?? window.__game?.engine?.ctx?.tryGet?.('hud');
  if (hud && hud.overlay) hud.overlay.visible = false;
});

fs.mkdirSync(OUT, { recursive: true });
const shot = async (name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };
const report = { errors };

/**
 * Aim at a point, at a bearing, and render one frame.
 *
 * `yaw` is a compass bearing the camera *looks along*: `RTSCamera.place` puts the eye at
 * `focus - (sin yaw, cos yaw) * r`. `zoom` is the rig's own 0-1, and its distance curve is
 * `3.2 * (620/3.2)^smoothstep(zoom)` — 0.35 is 14 m, 0.42 is 22 m, 0.55 is 66 m, 0.78 is
 * 330 m. Those four are the close-up, the shoulder, the company view and the strategic map.
 */
const aim = async (x, z, zoom, yaw) => page.evaluate(({ x, z, zoom, yaw }) => {
  window.__game.setCamera(x, z, zoom, yaw);
  window.__game.engine.advance(0.017, 17);
}, { x, z, zoom, yaw });

// ---------------------------------------------------------------------------
// Pick an animal in the middle of the elephant line and let the battle carry it forward.
// ---------------------------------------------------------------------------
const pick = await page.evaluate(() => {
  const g = window.__game;
  const b = g.battle;
  // 24 s: long enough that the line is moving and the screen has been passed, short enough
  // that nothing has died yet, so the animal we kill is killed at a time we chose.
  g.engine.advance(24, 166);
  const units = b.units.filter((u) => u.typeId === 'war-elephants' && !u.destroyed);
  const all = units.flatMap((u) => u.members).filter((i) => b.pool.aliveAt(i));

  /*
   * Kill one standing in the open.
   *
   * The first run of this probe killed the animal under an olive, and the close camera
   * photographed the inside of the canopy — a framing failure, but one that would have been
   * read as "the carcass is not there". `ScatterField` names its trees `veg-<species>`, so
   * their instance matrices are on the scene and the clearance is a measurement rather than
   * a hope. Billboards are excluded: they are the distant tier of the same trees.
   */
  const trees = [];
  g.engine.ctx.scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.name.startsWith('veg-') || o.name === 'veg-billboards') return;
    const m = new Float32Array(16);
    for (let k = 0; k < o.count; k++) {
      m.set(o.instanceMatrix.array.subarray(k * 16, k * 16 + 16));
      trees.push([m[12], m[14]]);
    }
  });
  const clearance = (i) => {
    let best = Infinity;
    for (const [tx, tz] of trees) {
      const d = Math.hypot(tx - b.pool.x[i], tz - b.pool.z[i]);
      if (d < best) best = d;
    }
    return best;
  };
  let i = all[0]; let bestClear = -1;
  for (const cand of all) {
    const c = clearance(cand);
    if (c > bestClear) { bestClear = c; i = cand; }
  }
  return {
    victim: i,
    animals: all.length,
    trees: trees.length,
    clearance: Number.isFinite(bestClear) ? +bestClear.toFixed(1) : null,
    x: +b.pool.x[i].toFixed(2), z: +b.pool.z[i].toFixed(2), y: +b.pool.y[i].toFixed(2),
    facing: +b.pool.facing[i].toFixed(4),
    simTime: +g.simTime().toFixed(1),
  };
});
console.log(`victim slot ${pick.victim} of ${pick.animals} at (${pick.x}, ${pick.z}) `
  + `facing ${pick.facing}, t=${pick.simTime}s, ${pick.clearance} m from the nearest of `
  + `${pick.trees} trees`);
report.pick = pick;

// Side-on from the flank it rolls onto (`CREW_FALL_SIDE = +1`, the animal's right), so the
// crew are thrown toward the lens and the roll crosses the frame rather than facing it.
const sideYaw = pick.facing - Math.PI / 2;

const sample = async () => page.evaluate(({ v }) => {
  const g = window.__game;
  const p = g.battle.pool;
  const rs = g.engine.ctx.tryGet('unitRender');
  const scene = g.engine.ctx.scene;
  let ele = 0; let eleVis = null;
  scene.traverse((o) => {
    if (o.isMesh && o.name === 'war-elephants') { eleVis = o.visible; ele = o.visible ? o.geometry.instanceCount : 0; }
  });
  // The crew: soldier instances written this frame within 5 m of the animal, out of the
  // tier's own position buffer. Four men ride it, so four is the number to see at every
  // stage — on the animal, in the air, and lying beside it.
  const tiers = rs ? rs.soldierTiers.flat() : [];
  let near = 0;
  let lowest = Infinity;
  for (const t of tiers) {
    const buf = t.buf;
    for (let n = 0; n < buf.count; n++) {
      const dx = buf.pos[n * 3] - p.x[v];
      const dz = buf.pos[n * 3 + 2] - p.z[v];
      if (dx * dx + dz * dz < 25) { near++; lowest = Math.min(lowest, buf.pos[n * 3 + 1] - p.y[v]); }
    }
  }
  /*
   * How far the drawn heading has swung away from the one the sim holds, in degrees.
   *
   * `partCarcasses` builds its capsule on `pool.facing`, so any difference here is the drawn
   * body lying at an angle to the obstacle men are pushed out of. Recomputed exactly the way
   * `preRender` does, including the death-direction turn, so this reads zero only if the
   * animal really is exempt from it.
   */
  const wrap = (r) => { let d = r % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  let drawn = g.battle.renderFacing(v, 1);
  const onEle = g.battle.ridesElephantAt(v);
  if (!onEle && (p.state[v] === 10 || p.state[v] === 11) && (p.deathDirX[v] !== 0 || p.deathDirZ[v] !== 0)) {
    const target = Math.atan2(-p.deathDirX[v], -p.deathDirZ[v]);
    drawn += wrap(target - drawn) * Math.min(1, p.animTime[v] * 2.5);
  }
  return {
    ele, eleVis,
    state: p.state[v],
    animTime: +p.animTime[v].toFixed(3),
    eleDeath: rs && rs.eleDeath ? +rs.eleDeath[v].toFixed(3) : -1,
    clip: rs?.probeElephant ? (rs.probeElephant(v)?.clip ?? -1) : -2,
    crewNear: near,
    crewLowestDy: Number.isFinite(lowest) ? +lowest.toFixed(2) : null,
    turnDeg: +(wrap(drawn - p.facing[v]) * 180 / Math.PI).toFixed(1),
    x: +p.x[v].toFixed(3), z: +p.z[v].toFixed(3),
    calls: g.engine.renderer.info.render.calls,
  };
}, { v: pick.victim });

// ---------------------------------------------------------------------------
// 1. The fall.
// ---------------------------------------------------------------------------
await aim(pick.x, pick.z, 0.35, sideYaw);
await shot('f0-alive');
const alive = await sample();

const killed = await page.evaluate(({ v }) => {
  const b = window.__game.battle;
  const p = b.pool;
  // A killing blow from the Roman side, so the death direction is the one the fight came from.
  b.damage(v, 1e6, p.x[v], p.z[v] - 6, -1);
  return { state: p.state[v] };
}, { pick, v: pick.victim });
void killed;

const fall = [{ t: 0, ...(await sample()) }];
await shot('f1-t000');
const marks = [0.20, 0.50, 0.90, 1.30, 1.80, 2.60, 4.00];
let acc = 0;
for (const m of marks) {
  const dt = m - acc; acc = m;
  await page.evaluate((s) => window.__game.engine.advance(s, 33), dt);
  // Re-aim every shot: the animal's own coordinates, never a parked camera.
  const at = await page.evaluate(({ v }) => {
    const p = window.__game.battle.pool;
    return { x: p.x[v], z: p.z[v] };
  }, { v: pick.victim });
  await aim(at.x, at.z, 0.35, sideYaw);
  fall.push({ t: m, ...(await sample()) });
  await shot(`f${fall.length}-t${String(Math.round(m * 100)).padStart(3, '0')}`);
}
report.alive = alive;
report.fall = fall;
console.log('\n=== THE FALL (close camera, side-on) ===');
const line = (label, r) => console.log(`${label.padStart(5)}  ${String(r.ele).padStart(6)} `
  + `${String(r.state).padStart(5)} ${String(r.animTime).padStart(5)} ${String(r.eleDeath).padStart(8)} `
  + `${String(r.clip).padStart(4)} ${String(r.crewNear).padStart(8)} `
  + `${String(r.crewLowestDy).padStart(9)} ${String(r.turnDeg).padStart(7)} `
  + `${String(r.slid ?? 0).padStart(6)} ${String(r.calls).padStart(5)}`);
console.log('   t  eleInst state animT eleDeath clip crewNear crewLowDy turnDeg  slid draws');
line('alive', alive);
const x0 = fall[0].x; const z0 = fall[0].z;
for (const r of fall) {
  r.slid = +Math.hypot(r.x - x0, r.z - z0).toFixed(2);
  line(String(r.t), r);
}

// ---------------------------------------------------------------------------
// 2. Where the crew ended up, in the animal's own frame.
// ---------------------------------------------------------------------------
report.crew = await page.evaluate(({ v }) => {
  const g = window.__game;
  const p = g.battle.pool;
  const rs = g.engine.ctx.tryGet('unitRender');
  const f = p.facing[v];
  const sinF = Math.sin(f); const cosF = Math.cos(f);
  const out = [];
  for (const t of rs.soldierTiers.flat()) {
    const buf = t.buf;
    for (let n = 0; n < buf.count; n++) {
      const dx = buf.pos[n * 3] - p.x[v];
      const dy = buf.pos[n * 3 + 1] - p.y[v];
      const dz = buf.pos[n * 3 + 2] - p.z[v];
      if (dx * dx + dz * dz > 36) continue;
      // Into the animal's frame: +along is its nose, +side is its right.
      const along = dx * sinF + dz * cosF;
      const side = dx * cosF - dz * sinF;
      const q = n * 4;
      out.push({
        along: +along.toFixed(2), side: +side.toFixed(2), dy: +dy.toFixed(2),
        tipped: +(1 - Math.abs(buf.quat[q + 3])).toFixed(3),
      });
    }
  }
  out.sort((a, b) => a.side - b.side);
  return out;
}, { v: pick.victim });
console.log(`\ncrew and neighbours within 6 m of the body: ${report.crew.length}`);
for (const c of report.crew) {
  console.log(`  along ${String(c.along).padStart(6)}  side ${String(c.side).padStart(6)}  `
    + `dy ${String(c.dy).padStart(6)}  tipped ${c.tipped}`);
}
await aim(pick.x, pick.z, 0.30, sideYaw);
await shot('g0-crew-close');
await aim(pick.x, pick.z, 0.30, sideYaw + Math.PI);
await shot('g1-crew-reverse');

// ---------------------------------------------------------------------------
// 3. A minute later.
// ---------------------------------------------------------------------------
await page.evaluate(() => { window.__game.engine.advance(60, 166); });
const after = await page.evaluate(({ v }) => {
  const g = window.__game;
  const b = g.battle;
  const p = b.pool;
  const carc = [...(b.elephantCarcasses ?? [])];
  return {
    simTime: +g.simTime().toFixed(1),
    carcasses: carc.length,
    victimState: p.state[v],
    victimMoved: +Math.hypot(p.x[v] - window.__pickX, p.z[v] - window.__pickZ).toFixed(3),
    x: +p.x[v].toFixed(2), z: +p.z[v].toFixed(2),
  };
}, { v: pick.victim });
report.after = { ...after, driftFromDeath: +Math.hypot(after.x - pick.x, after.z - pick.z).toFixed(3) };
console.log(`\n=== SIXTY SECONDS LATER (t=${after.simTime}s) ===`);
console.log(`carcasses on the field ${after.carcasses}; the filmed body is state ${after.victimState} `
  + `and has moved ${report.after.driftFromDeath} m from where it fell`);

for (const [name, zoom] of [['h0-body-close', 0.35], ['h1-body-shoulder', 0.44], ['h2-field', 0.58], ['h3-strategic', 0.74]]) {
  await aim(after.x, after.z, zoom, sideYaw);
  await shot(name);
}

// ---------------------------------------------------------------------------
// 4. Draw calls, interleaved, at cameras that contain the body.
// ---------------------------------------------------------------------------
/**
 * Take the animals out of the frame, honestly.
 *
 * Setting `mesh.visible = false` is a **silent no-op** here and the first version of this
 * probe reported "0 draws for the whole tier" at four cameras because of it:
 * `UnitRenderSystem.flush` assigns `t.mesh.visible = n > 0` from the instance count on every
 * frame, so the flag is restored before anything is drawn. That is the same trap
 * `shoot.mjs`'s bench mode documents. The arm that actually runs suppresses the *emission* —
 * `pushElephant` becomes a no-op on the instance, the tier's count stays at zero, and `flush`
 * itself hides the mesh. `delete` puts the prototype method back.
 */
const setEleDrawn = async (on) => page.evaluate((v) => {
  const rs = window.__game.engine.ctx.tryGet('unitRender');
  if (v) delete rs.pushElephant;
  else rs.pushElephant = function noElephant() {};
  window.__game.engine.advance(0.017, 17);
}, on);

const CAMS = [
  { name: 'close', zoom: 0.35 },
  { name: 'shoulder', zoom: 0.44 },
  { name: 'field', zoom: 0.58 },
  { name: 'strategic', zoom: 0.74 },
];
report.draws = [];
for (const c of CAMS) {
  await aim(after.x, after.z, c.zoom, sideYaw);
  const on = await page.evaluate(() => {
    const g = window.__game;
    const r = g.engine.renderer.info.render;
    const scene = g.engine.ctx.scene;
    let inst = 0;
    scene.traverse((o) => { if (o.isMesh && o.name === 'war-elephants' && o.visible) inst = o.geometry.instanceCount; });
    return { calls: r.calls, tris: r.triangles, inst };
  });
  await setEleDrawn(false);
  const off = await page.evaluate(() => {
    const r = window.__game.engine.renderer.info.render;
    const scene = window.__game.engine.ctx.scene;
    let vis = null;
    scene.traverse((o) => { if (o.isMesh && o.name === 'war-elephants') vis = o.visible; });
    return { calls: r.calls, tris: r.triangles, vis };
  });
  await setEleDrawn(true);
  const back = await page.evaluate(() => {
    const r = window.__game.engine.renderer.info.render;
    return { calls: r.calls };
  });
  report.draws.push({
    camera: c.name, zoom: c.zoom, animalsInFrame: on.inst,
    withAnimals: on.calls, withoutAnimals: off.calls, restored: back.calls,
    elephantCost: on.calls - off.calls, meshHiddenInOffArm: off.vis === false,
    trisWith: on.tris, trisWithout: off.tris,
  });
  console.log(`${c.name.padEnd(10)} zoom ${c.zoom}  animals in frame ${String(on.inst).padStart(2)}  `
    + `draws ${on.calls} with / ${off.calls} without (mesh hidden: ${off.vis === false}) / `
    + `${back.calls} restored  = ${on.calls - off.calls} for the whole tier`);
}

// ---------------------------------------------------------------------------
// 5. Men over the body.
// ---------------------------------------------------------------------------
const part = await page.evaluate(async ({ v }) => {
  const g = window.__game;
  const b = g.battle;
  const p = b.pool;
  const { UnitOrder } = await import('/src/sim/types.ts');
  /*
   * Stage this one, because the un-staged version measured nothing.
   *
   * Ordering the nearest Roman cohort over the body and watching is not a test: the tactical
   * AI re-plans every few ticks and took the order straight back off it, and the closest any
   * man came in a minute was ten metres. The claim under test is "a man cannot stand inside
   * four tonnes of dead animal", so put a whole century on a collision course with it and
   * hold them there. The AI is stubbed only for this arm and only after every other
   * measurement in this run is finished.
   */
  for (const name of ['tactical-ai', 'general-ai', 'battleFlow', 'autoEngage', 'morale']) {
    const sys = g.engine.ctx.tryGet(name);
    if (sys && sys.fixedUpdate) sys.fixedUpdate = () => {};
  }
  const bx = p.x[v]; const bz = p.z[v];
  let best = null; let bestD = Infinity;
  for (const u of b.units) {
    if (u.destroyed || u.alive === 0 || u.faction !== 0) continue;
    const i = u.members.find((m) => p.aliveAt(m));
    if (i === undefined) continue;
    const d = Math.hypot(p.x[i] - bx, p.z[i] - bz);
    if (d < bestD) { bestD = d; best = u; }
  }
  if (!best) return { error: 'no roman unit' };
  // Form them up 22 m short of the body, in ranks square to it, and send them straight over.
  const alive = best.members.filter((m) => p.aliveAt(m));
  const heading = 0;
  const width = 20;
  const pitch = 0.86;
  for (let k = 0; k < alive.length; k++) {
    const i = alive[k];
    const file = (k % width) - (width - 1) / 2;
    const rank = Math.floor(k / width);
    p.x[i] = bx + file * pitch;
    p.z[i] = bz - 22 - rank * pitch;
    p.px[i] = p.x[i]; p.pz[i] = p.z[i];
    p.y[i] = b.groundAt(p.x[i], p.z[i]);
    p.facing[i] = heading; p.prevFacing[i] = heading;
  }
  best.order = UnitOrder.MoveTo;
  best.facing = heading;
  best.targetX = bx;
  best.targetZ = bz + 26;
  best.running = false;
  best.waypoints.length = 0;
  return {
    unit: String(best.name ?? best.id), alive: alive.length,
    formedAt: 22, throughTo: 26,
  };
}, { v: pick.victim });
console.log(`\n"${part.unit}" (${part.alive} men) formed 22 m short of the body and ordered `
  + 'straight over it');
report.part = part;

const capsule = async () => page.evaluate(({ v }) => {
  const b = window.__game.battle;
  const p = b.pool;
  const HALF = 1.05; const RAD = 1.30; const SOLDIER_R = 0.30;
  const size = 0.9 + p.variant[v] * 0.2;
  const half = HALF * size; const rad = RAD * size;
  const ax = Math.sin(p.facing[v]) * half;
  const az = Math.cos(p.facing[v]) * half;
  let nearest = Infinity; let inside = 0; let within5 = 0;
  for (let j = 0; j < p.count; j++) {
    if (!p.aliveAt(j)) continue;
    if (b.ridesElephantAt(j)) continue;
    const rx = p.x[j] - p.x[v]; const rz = p.z[j] - p.z[v];
    const len2 = ax * ax + az * az;
    const t = len2 > 1e-9 ? Math.max(-1, Math.min(1, (rx * ax + rz * az) / len2)) : 0;
    const dx = rx - ax * t; const dz = rz - az * t;
    const d = Math.hypot(dx, dz) - rad - SOLDIER_R;
    if (d < nearest) nearest = d;
    if (d < 0) inside++;
    if (d < 5) within5++;
  }
  return {
    nearest: Number.isFinite(nearest) ? +nearest.toFixed(3) : null,
    inside, within5, simTime: +window.__game.simTime().toFixed(1),
  };
}, { v: pick.victim });

report.march = [await capsule()];
let step = 0;
for (const s of [3, 3, 3, 3, 4, 4, 5, 5, 10, 10]) {
  await page.evaluate((sec) => window.__game.engine.advance(sec, 166), s);
  report.march.push(await capsule());
  step++;
  if (step === 4 || step === 6 || step === 8) {
    await aim(after.x, after.z, 0.40, sideYaw);
    await shot(`i${step}-march-side`);
    await aim(after.x, after.z, 0.44, sideYaw + Math.PI / 2);
    await shot(`i${step}-march-along`);
  }
}
console.log('\n=== A COHORT ORDERED OVER THE BODY ===');
console.log('  t   nearest(m)  menInsideBody  menWithin5m');
for (const r of report.march) {
  console.log(`${String(r.simTime).padStart(6)} ${String(r.nearest).padStart(11)} `
    + `${String(r.inside).padStart(14)} ${String(r.within5).padStart(12)}`);
}
const worstInside = Math.max(...report.march.map((r) => r.inside));
const closest = Math.min(...report.march.map((r) => r.nearest ?? Infinity));
report.partVerdict = { worstInside, closest: +closest.toFixed(3) };
console.log(`closest any living man came to the body's surface: ${closest.toFixed(3)} m; `
  + `most men ever standing inside it: ${worstInside}`);
await aim(after.x, after.z, 0.40, sideYaw);
await shot('i9-march-final');
await aim(after.x, after.z, 0.52, sideYaw);
await shot('i9-march-wide');

report.errors = errors;
console.log(errors.length ? `\npage errors: ${errors.length}` : '\nno page errors');
if (JSON_OUT) fs.writeFileSync(path.resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
console.log(`frames in ${OUT}`);

await browser.close();
if (server) server.kill('SIGTERM');
