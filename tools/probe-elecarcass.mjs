#!/usr/bin/env node
/**
 * A war elephant dying in a battle nobody set up, and the field a minute later.
 *
 * The predecessor's `probe-elephantdeath.mjs` kills a squadron standing on empty ground with
 * every AI subsystem stubbed out. That is the right instrument for "is the animal in the
 * instance buffer", and it is the wrong one for "does this read as a death", because the
 * thing the player watches is an animal that walked into a Roman line and was killed there.
 * So this one runs the shipped Carthaginian field battle, lets the AI fight it, waits for the
 * first animal to die of its own accord, and films that.
 *
 * Four things it measures that a synthetic setup cannot:
 *
 *   1. **The death tick, in a real battle.** Elephant instances, crew instances and the
 *      collapse playhead across the fall, at frame resolution, on an animal killed by Romans.
 *   2. **Draw calls with the camera on the animals.** Every previous elephant figure in this
 *      workstream was taken with the camera parked where the squadron was *deployed*; by the
 *      time anything dies the fight is 100 m away and the carcasses are off screen, so the
 *      count measured a frame with no elephants in it. Every camera here is aimed at a body.
 *   3. **The settled pose against the ground it lies on**, by running the death clip's own
 *      forward kinematics in the page and reading every bone's world height at the last
 *      frame. Nothing may hang under the terrain and nothing may float.
 *   4. **Whether the field still has bodies in it a minute later**, and whether the living
 *      are standing inside them.
 *
 *   node tools/probe-elecarcass.mjs --port=5691 --out=screenshots/elecarcass
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5691);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/elecarcass');
const JSON_OUT = args.get('json') ?? null;
const HUNT_MAX = Number(args.get('hunt') ?? 240);

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
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
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

// The shipped Punic field battle: Rome against Carthage on the default map, both under AI.
await page.goto(`${base}/?harness=1&quality=ultra&enemy=carthage&hud=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });
console.log('ready');

fs.mkdirSync(OUT, { recursive: true });
const shot = async (name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };

const report = { errors };

// ---------------------------------------------------------------------------
// 1. The settled pose against the ground, from the clip's own kinematics.
// ---------------------------------------------------------------------------
report.pose = await page.evaluate(async () => {
  const { ELEPHANT_CLIP_SET } = await import('/src/anim/elephantClips.ts');
  const { frameGlobals } = await import('/src/anim/pose.ts');
  const rig = ELEPHANT_CLIP_SET.rig;
  const n = rig.boneCount;
  const q = new Float32Array(n * 4);
  const t = new Float32Array(n * 3);
  const clip = ELEPHANT_CLIP_SET.clips.find((c) => c.name === 'death');
  const read = (f) => {
    frameGlobals(rig, clip, f, q, t);
    let lo = Infinity; let hi = -Infinity; let loBone = -1; let hiBone = -1;
    const ys = [];
    for (let b = 0; b < n; b++) {
      const y = t[b * 3 + 1];
      ys.push({ bone: rig.names ? rig.names[b] : b, y: +y.toFixed(3) });
      if (y < lo) { lo = y; loBone = b; }
      if (y > hi) { hi = y; hiBone = b; }
    }
    return {
      frame: f,
      lowest: +lo.toFixed(3),
      lowestBone: rig.names ? rig.names[loBone] : loBone,
      highest: +hi.toFixed(3),
      highestBone: rig.names ? rig.names[hiBone] : hiBone,
      under: ys.filter((e) => e.y < -0.02),
      all: ys,
    };
  };
  const first = read(0);
  const last = read(clip.frames - 1);
  return {
    frames: clip.frames, duration: clip.duration,
    standing: { lowest: first.lowest, highest: first.highest, highestBone: first.highestBone },
    settled: {
      lowest: last.lowest, lowestBone: last.lowestBone,
      highest: last.highest, highestBone: last.highestBone,
      bonesUnderGround: last.under,
    },
  };
});
console.log(`death clip: ${report.pose.frames} frames / ${report.pose.duration}s`);
console.log(`settled: lowest bone ${report.pose.settled.lowest} m (${report.pose.settled.lowestBone}), `
  + `highest ${report.pose.settled.highest} m (${report.pose.settled.highestBone}), `
  + `under ground: ${report.pose.settled.bonesUnderGround.length}`);

// ---------------------------------------------------------------------------
// 2. Find the elephants, then let the battle run until one of them dies.
// ---------------------------------------------------------------------------
const roster = await page.evaluate(() => {
  const b = window.__game.battle;
  const units = b.units.filter((u) => u.typeId === 'war-elephants' && !u.destroyed);
  return {
    units: units.map((u) => ({ id: u.id, name: u.name, members: [...u.members] })),
    animals: units.reduce((a, u) => a + u.members.length, 0),
    totalMen: b.pool.count,
  };
});
console.log(`${roster.units.length} elephant units, ${roster.animals} animals, pool ${roster.totalMen}`);
report.roster = { units: roster.units.length, animals: roster.animals, pool: roster.totalMen };

const members = roster.units.flatMap((u) => u.members);

// Hunt at 0.5 s granularity: fine enough to catch the tick, coarse enough to reach the melee.
const hunt = await page.evaluate(async ({ members, maxT }) => {
  const g = window.__game;
  const p = g.battle.pool;
  const t0 = g.simTime();
  let victim = -1;
  let at = 0;
  while (g.simTime() - t0 < maxT) {
    g.engine.advance(0.5, 166);
    for (const i of members) {
      // 10 = Dying. The first animal to take a killing blow of its own accord.
      if (p.state[i] === 10) { victim = i; at = g.simTime() - t0; break; }
    }
    if (victim >= 0) break;
  }
  if (victim < 0) return { victim: -1, at: g.simTime() - t0 };
  return {
    victim, at: +at.toFixed(2),
    x: +p.x[victim].toFixed(2), z: +p.z[victim].toFixed(2), y: +p.y[victim].toFixed(2),
    facing: +p.facing[victim].toFixed(3),
    alive: members.filter((i) => p.aliveAt(i)).length,
  };
}, { members, maxT: HUNT_MAX });

if (hunt.victim < 0) {
  console.error(`no elephant died within ${HUNT_MAX}s of battle`);
  report.hunt = hunt;
} else {
  console.log(`first natural elephant death at t+${hunt.at}s, slot ${hunt.victim} `
    + `at (${hunt.x}, ${hunt.z}) facing ${hunt.facing}`);
  report.hunt = hunt;
}

// ---------------------------------------------------------------------------
// 3. Film the collapse, camera on the animal, from the side it falls onto.
// ---------------------------------------------------------------------------
const park = async (x, z, zoom, yaw) => page.evaluate(({ x, z, zoom, yaw }) => {
  window.__game.setCamera(x, z, zoom, yaw);
  // One rendered frame at the new pose, with no sim time in it worth speaking of.
  window.__game.engine.advance(0.017, 17);
}, { x, z, zoom, yaw });

const drawsNow = async () => page.evaluate(() => {
  const g = window.__game;
  const r = g.engine.renderer.info.render;
  return { calls: r.calls, triangles: r.triangles };
});

const eleInstances = async () => page.evaluate(() => {
  const scene = window.__game.engine.ctx.scene;
  let ele = 0; let eleVis = null; let men = 0;
  scene.traverse((o) => {
    if (!o.isMesh || !o.name) return;
    if (o.name === 'war-elephants') { eleVis = o.visible; ele = o.visible ? o.geometry.instanceCount : 0; }
    if (o.name.startsWith('soldiers-') && o.visible) men += o.geometry.instanceCount;
  });
  return { ele, eleVis, men };
});

if (hunt.victim >= 0) {
  // Camera on the animal's right flank — the side the clip rolls it onto — at ~24 m.
  const camYaw = hunt.facing - Math.PI / 2;
  await park(hunt.x, hunt.z, 0.42, camYaw);
  await shot('d0-hit');

  const marks = [0.20, 0.40, 0.70, 1.10, 1.60, 2.60, 4.00, 8.00];
  const fall = [await page.evaluate(({ v }) => {
    const g = window.__game;
    const p = g.battle.pool;
    const rs = g.engine.ctx.tryGet('unitRender');
    const scene = g.engine.ctx.scene;
    let ele = 0;
    scene.traverse((o) => { if (o.isMesh && o.name === 'war-elephants' && o.visible) ele = o.geometry.instanceCount; });
    return {
      t: 0, ele, state: p.state[v], animTime: +p.animTime[v].toFixed(3),
      clip: rs?.probeElephant ? (rs.probeElephant(v)?.clip ?? -1) : -2,
      backY: rs?.probeElephant ? +(rs.probeElephant(v)?.backY ?? -1).toFixed(2) : -2,
      y: +p.y[v].toFixed(2),
      calls: g.engine.renderer.info.render.calls,
    };
  }, { v: hunt.victim })];

  let acc = 0;
  for (const m of marks) {
    const dt = m - acc; acc = m;
    const row = await page.evaluate(({ v, dt, t }) => {
      const g = window.__game;
      g.engine.advance(dt, 33);
      const p = g.battle.pool;
      const rs = g.engine.ctx.tryGet('unitRender');
      const scene = g.engine.ctx.scene;
      let ele = 0;
      scene.traverse((o) => { if (o.isMesh && o.name === 'war-elephants' && o.visible) ele = o.geometry.instanceCount; });
      return {
        t, ele, state: p.state[v], animTime: +p.animTime[v].toFixed(3),
        clip: rs?.probeElephant ? (rs.probeElephant(v)?.clip ?? -1) : -2,
        backY: rs?.probeElephant ? +(rs.probeElephant(v)?.backY ?? -1).toFixed(2) : -2,
        y: +p.y[v].toFixed(2),
        calls: g.engine.renderer.info.render.calls,
      };
    }, { v: hunt.victim, dt, t: m });
    fall.push(row);
    await shot(`d${fall.length}-t${String(Math.round(m * 100)).padStart(3, '0')}`);
  }
  report.fall = fall;
  console.log('\n=== THE FALL, camera on the animal ===');
  console.log('  t   eleInst state animT clip  backY   y   draws');
  for (const r of fall) {
    console.log(`${String(r.t).padStart(5)} ${String(r.ele).padStart(7)} ${String(r.state).padStart(5)} `
      + `${String(r.animTime).padStart(5)} ${String(r.clip).padStart(4)} ${String(r.backY).padStart(6)} `
      + `${String(r.y).padStart(5)} ${String(r.calls).padStart(6)}`);
  }
}

// ---------------------------------------------------------------------------
// 4. The field a minute later.
// ---------------------------------------------------------------------------
await page.evaluate(() => { window.__game.engine.advance(60, 166); });

const field = await page.evaluate(({ members }) => {
  const g = window.__game;
  const b = g.battle;
  const p = b.pool;
  const carc = [...(b.elephantCarcasses ?? [])];
  const dead = members.filter((i) => !p.aliveAt(i));
  // Centroid of the bodies, so the field cameras frame where the fighting was.
  let cx = 0; let cz = 0;
  for (const i of carc) { cx += p.x[i]; cz += p.z[i]; }
  if (carc.length) { cx /= carc.length; cz /= carc.length; }
  // How deep into a carcass does the nearest living man stand? Capsule distance, the same
  // geometry `BattleSystem.partCarcasses` pushes him out of, so a negative figure is a man
  // standing inside four tonnes of dead animal.
  const HALF = 1.05; const RAD = 1.30; const SOLDIER_R = 0.30;
  let worstPenetration = 0;
  let nearest = Infinity;
  let within8 = 0;
  for (const e of carc) {
    if (p.state[e] !== 11) continue;
    const size = 0.9 + p.variant[e] * 0.2;
    const half = HALF * size; const rad = RAD * size;
    const ax = Math.sin(p.facing[e]) * half;
    const az = Math.cos(p.facing[e]) * half;
    for (let j = 0; j < p.count; j++) {
      if (!p.aliveAt(j)) continue;
      if (b.ridesElephantAt(j)) continue;
      const rx = p.x[j] - p.x[e];
      const rz = p.z[j] - p.z[e];
      const len2 = ax * ax + az * az;
      const t = len2 > 1e-9 ? Math.max(-1, Math.min(1, (rx * ax + rz * az) / len2)) : 0;
      const dx = rx - ax * t; const dz = rz - az * t;
      const d = Math.hypot(dx, dz) - rad - SOLDIER_R;
      if (d < nearest) nearest = d;
      if (d < worstPenetration) worstPenetration = d;
      if (d < 8) within8++;
    }
  }
  return {
    simTime: +g.simTime().toFixed(1),
    carcasses: carc.length,
    elephantsDead: dead.length,
    elephantsAlive: members.length - dead.length,
    centre: { x: +cx.toFixed(1), z: +cz.toFixed(1) },
    nearestLivingToCarcassSurface: Number.isFinite(nearest) ? +nearest.toFixed(2) : null,
    worstPenetration: +worstPenetration.toFixed(2),
    livingWithin8m: within8,
    settledCount: carc.filter((i) => p.state[i] === 11).length,
    bodies: carc.map((i) => ({
      i, x: +p.x[i].toFixed(1), z: +p.z[i].toFixed(1), y: +p.y[i].toFixed(2),
      state: p.state[i], facing: +p.facing[i].toFixed(2),
    })),
  };
}, { members });
report.field = field;
console.log(`\n=== FIELD AT t+${field.simTime}s ===`);
console.log(`carcasses ${field.carcasses} (settled ${field.settledCount}), `
  + `elephants dead ${field.elephantsDead} / alive ${field.elephantsAlive}`);
console.log(`nearest living man to a carcass surface: ${field.nearestLivingToCarcassSurface} m `
  + `(worst penetration ${field.worstPenetration} m), ${field.livingWithin8m} men within 8 m`);

// Cameras that are actually looking at the bodies.
const cams = [
  { name: 'e0-carcass-close', zoom: 0.42 },
  { name: 'e1-carcass-mid', zoom: 0.55 },
  { name: 'e2-carcass-field', zoom: 0.66 },
  { name: 'e3-carcass-strategic', zoom: 0.78 },
];
report.draws = [];
if (field.carcasses > 0) {
  for (const c of cams) {
    await park(field.centre.x, field.centre.z, c.zoom, Math.PI * 0.25);
    const d = await drawsNow();
    const inst = await eleInstances();
    report.draws.push({ ...c, ...d, ...inst });
    await shot(c.name);
    console.log(`${c.name.padEnd(22)} zoom ${c.zoom}  draws ${String(d.calls).padStart(4)}  `
      + `tris ${(d.triangles / 1e6).toFixed(2)}M  elephant instances ${inst.ele}`);
  }
  // And one from the opposite bearing, because a draw count is a function of what is behind
  // the subject as much as of the subject.
  await park(field.centre.x, field.centre.z, 0.55, Math.PI * 1.25);
  const d = await drawsNow();
  const inst = await eleInstances();
  report.draws.push({ name: 'e4-carcass-mid-reverse', zoom: 0.55, ...d, ...inst });
  await shot('e4-carcass-mid-reverse');
  console.log(`e4-carcass-mid-reverse zoom 0.55  draws ${d.calls}  elephant instances ${inst.ele}`);
}

report.errors = errors;
console.log(errors.length ? `\npage errors: ${errors.length}` : '\nno page errors');
if (JSON_OUT) fs.writeFileSync(path.resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
console.log(`frames in ${OUT}`);

await browser.close();
if (server) server.kill('SIGTERM');
