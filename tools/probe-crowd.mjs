#!/usr/bin/env node
/**
 * Crowd-variation probe.
 *
 * Twenty rounds of blind critique have converged on "one mesh, one pose, one heading, no
 * animation offset between any two of them". That sentence names four different defects
 * with four different fixes, and three of them would be invisible to code review — the
 * variation can exist in `kit.ts`, be resolved correctly, and still not reach the vertex
 * shader. So this reads the numbers the renderer *actually uploaded*, out of the
 * `InstancedBufferAttribute` backing stores, after a real frame has been drawn.
 *
 * It does not recompute what the values ought to be. That distinction is the whole point:
 * this project has already shipped 24 green assertions sitting on a visibly broken ladder
 * because the probe computed the answer analytically instead of reading the matrix the
 * renderer wrote.
 *
 * Instances are grouped back to units by nearest unit centroid, because the tier buffers are
 * a flat run across every unit of one faction at one LOD and carry no unit id.
 *
 * Reported per unit, for the things a critic's eye actually integrates over a rank:
 *
 *   kit        distinct (maskLo, maskHi) pairs — how many genuinely different men
 *   scale      distinct statures, and their spread
 *   yaw        distinct headings, and their circular spread in degrees
 *   phase      distinct animation phases, plus circular concentration R of the gait phase.
 *              R near 1 is lockstep; R near 0 is fully spread. The precedent here is that
 *              phase was already spread at 0.006-0.13 while *cadence* was identical, so
 *              phase alone is not the measurement — see `rate` below.
 *   cadence    distinct clip playback rates. Three distinct cadences among 320 men is what
 *              lockstep marching actually was, and it read as a phase problem for weeks.
 *   emblem     distinct shield devices
 *   tunic      distinct tunic colours, quantised to 1/256 per channel
 *   metal      distinct packed metal values (class + polish)
 *
 *   node tools/probe-crowd.mjs --port=5621 --shot=romanline
 */

import { chromium } from 'playwright';
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
const PORT = Number(args.get('port') ?? 5621);
const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);
const JSON_OUT = args.get('json') ?? null;

/**
 * Camera positions pinned from a real `shoot.mjs` report, exactly as `probe-perf-ab.mjs`
 * does it. Measuring crowd variation from the default camera is worthless: at t+12 with the
 * rig where it starts, every man on the field resolves to LOD2, so the probe reports the
 * coarse eight-group silhouette mask and calls it the man's kit. The graded frames are shot
 * from these positions and these are the tiers a critic actually sees.
 */
const SHOTS = {
  romanline: { x: -100, z: 128, zoom: 0.36, yaw: Math.PI * 1.42, at: 2 },
  raking: { x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72, at: 2 },
  clash: { x: 15, z: -17, zoom: 0.30, yaw: -1.92, at: 78 },
  melee: { x: -28, z: -37, zoom: 0.30, yaw: -1.79, at: 94 },
  germanhorde: { x: -100, z: 60, zoom: 0.36, yaw: Math.PI * 0.42, at: 2 },
  wide: { x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82, at: 2 },
};
const SHOT = String(args.get('shot') ?? 'romanline');
if (!SHOTS[SHOT]) throw new Error(`unknown shot ${SHOT}; have ${Object.keys(SHOTS).join(',')}`);
const CAM = SHOTS[SHOT];
const AT = Number(args.get('at') ?? CAM.at);

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let server = null;
const base = `http://127.0.0.1:${PORT}`;
const alreadyUp = await waitForServer(base, 1200);
console.log(alreadyUp
  ? `[probe-crowd] using LIVE dev server already listening on ${PORT}`
  : `[probe-crowd] starting our own vite on ${PORT}`);
if (!alreadyUp) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.setDefaultTimeout(180000);
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });
await page.evaluate((t) => window.__game.advance(t), AT);
// Park the camera, then render one real frame so the LOD selection and the instance
// buffers reflect this viewpoint rather than the rig's opening position.
await page.evaluate((c) => window.__game.setCamera(c.x, c.z, c.zoom, c.yaw), CAM);
await page.evaluate(() => window.__game.advance(1 / 30));
await new Promise((r) => setTimeout(r, 600));

const out = await page.evaluate(() => {
  const g = window.__game;
  const ur = g.engine.context.get('unitRender');
  const battle = g.battle;

  // Unit centroids, so a flat tier run can be split back into units.
  const units = [];
  for (const u of battle.units) {
    if (!u.alive) continue;
    let sx = 0, sz = 0, n = 0;
    const p = battle.pool;
    for (let i = 0; i < p.count; i++) {
      if (p.unitId[i] !== u.id || p.hp[i] <= 0) continue;
      sx += p.x[i]; sz += p.z[i]; n++;
    }
    if (n === 0) continue;
    units.push({
      id: u.id, typeId: u.typeId, faction: u.faction,
      cx: sx / n, cz: sz / n, live: n,
      inst: [],
    });
  }

  const tiers = [];
  ur.soldierTiers.forEach((row, faction) => {
    row.forEach((t, lod) => {
      tiers.push({ faction, lod, t });
    });
  });

  let totalInstances = 0;
  const lodCount = [0, 0, 0];
  for (const { faction, lod, t } of tiers) {
    const b = t.buf;
    lodCount[lod] += b.count;
    totalInstances += b.count;
    for (let n = 0; n < b.count; n++) {
      const x = b.pos[n * 3], z = b.pos[n * 3 + 2];
      // Nearest unit centroid of the same faction.
      let best = -1, bestD = Infinity;
      for (let k = 0; k < units.length; k++) {
        if (units[k].faction !== faction) continue;
        const dx = units[k].cx - x, dz = units[k].cz - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best < 0) continue;
      units[best].inst.push({
        lod,
        yaw: b.orient[n * 4], scale: b.orient[n * 4 + 1],
        lean: b.orient[n * 4 + 2], grime: b.orient[n * 4 + 3],
        r0: b.animA[n * 4], r1: b.animA[n * 4 + 1], frac: b.animA[n * 4 + 2],
        blend: b.animA[n * 4 + 3],
        variant: b.animB[n * 4 + 3],
        kitLo: b.kit[n * 2], kitHi: b.kit[n * 2 + 1],
        tr: b.col0[n * 4], tg: b.col0[n * 4 + 1], tb: b.col0[n * 4 + 2],
        emblem: b.col0[n * 4 + 3],
        metal: b.col1[n * 4 + 3],
        quat: b.quat[n * 4 + 3],
      });
    }
  }

  // The animation rate is CPU-side state, not an attribute: `rateMul` is what divides the
  // clip clock per man. Read it directly, keyed by soldier, because the cadence defect is
  // invisible in the uploaded phase.
  const rateByUnit = {};
  const heightByUnit = {};
  {
    const p = battle.pool;
    for (let i = 0; i < p.count; i++) {
      if (p.hp[i] <= 0) continue;
      const uid = p.unitId[i];
      (rateByUnit[uid] ||= []).push(ur.rateMul ? ur.rateMul[i] : -1);
      (heightByUnit[uid] ||= []).push(ur.heightMul ? ur.heightMul[i] : -1);
    }
  }

  const q = (v, n) => Math.round(v * n) / n;
  const rows = units.map((u) => {
    const inst = u.inst;
    if (inst.length === 0) return null;
    const uniq = (f) => new Set(inst.map(f)).size;
    // Circular concentration of the gait phase. r0 is a row index into the anim texture, so
    // (r0 + frac) modulo the clip length is the phase; without the clip length here, use the
    // fractional part of the row itself plus frac, which preserves spread.
    const phases = inst.map((i) => (i.r0 + i.frac));
    const span = Math.max(...phases) - Math.min(...phases) || 1;
    let sc = 0, ss = 0;
    for (const p of phases) {
      const a = ((p - Math.min(...phases)) / span) * Math.PI * 2;
      sc += Math.cos(a); ss += Math.sin(a);
    }
    const R = Math.hypot(sc, ss) / phases.length;
    const yaws = inst.map((i) => i.yaw);
    let yc = 0, ys = 0;
    for (const a of yaws) { yc += Math.cos(a); ys += Math.sin(a); }
    const yawR = Math.hypot(yc, ys) / yaws.length;
    const scales = inst.map((i) => i.scale);
    const rates = (rateByUnit[u.id] || []).filter((v) => v > 0);
    return {
      id: u.id, typeId: u.typeId, faction: u.faction, n: inst.length, live: u.live,
      lods: [0, 1, 2].map((l) => inst.filter((i) => i.lod === l).length),
      kit: uniq((i) => `${i.kitLo}|${i.kitHi}`),
      scale: uniq((i) => q(i.scale, 1000)),
      scaleMin: Math.min(...scales), scaleMax: Math.max(...scales),
      yaw: uniq((i) => q(i.yaw, 1000)),
      yawR: +yawR.toFixed(4),
      yawSdDeg: +(Math.sqrt(Math.max(0, -2 * Math.log(Math.max(1e-9, yawR)))) * 180 / Math.PI).toFixed(2),
      phase: uniq((i) => q(i.r0 + i.frac, 100)),
      phaseR: +R.toFixed(4),
      clipRows: uniq((i) => i.r0),
      cadence: new Set(rates.map((v) => q(v, 1000))).size,
      cadenceMin: rates.length ? +Math.min(...rates).toFixed(3) : 0,
      cadenceMax: rates.length ? +Math.max(...rates).toFixed(3) : 0,
      emblem: uniq((i) => i.emblem),
      tunic: uniq((i) => `${q(i.tr, 256)},${q(i.tg, 256)},${q(i.tb, 256)}`),
      metal: uniq((i) => q(i.metal, 1000)),
      variant: uniq((i) => q(i.variant, 10000)),
      grime: uniq((i) => q(i.grime, 100)),
    };
  }).filter(Boolean);

  return { totalInstances, lodCount, rows };
});

const pad = (s, n) => String(s).padStart(n);
console.log(`\ninstances uploaded: ${out.totalInstances}   LOD0 ${out.lodCount[0]}  LOD1 ${out.lodCount[1]}  LOD2 ${out.lodCount[2]}`);
console.log('\nDistinct values per unit, read from the uploaded instance buffers:');
console.log('  unit                 n  kit scale  yawσ°  phase  R      rows cad  embl tunic metal');
for (const r of out.rows) {
  console.log(
    `  ${String(r.typeId).slice(0, 18).padEnd(18)} ${pad(r.n, 4)} ${pad(r.kit, 4)} ${pad(r.scale, 5)} ` +
    `${pad(r.yawSdDeg, 6)} ${pad(r.phase, 6)} ${pad(r.phaseR.toFixed(3), 6)} ${pad(r.clipRows, 4)} ` +
    `${pad(r.cadence, 3)}  ${pad(r.emblem, 4)} ${pad(r.tunic, 5)} ${pad(r.metal, 5)}`
  );
}

// The headline numbers: the ratio of distinct men to men, per axis, over the whole field.
const agg = (k) => out.rows.reduce((a, r) => a + r[k], 0);
const n = agg('n');
console.log(`\ntotals over ${out.rows.length} units, ${n} instances`);
for (const k of ['kit', 'scale', 'yaw', 'phase', 'cadence', 'emblem', 'tunic', 'metal', 'variant', 'grime']) {
  console.log(`  ${k.padEnd(9)} ${pad(agg(k), 6)} distinct   ${pad((agg(k) / n * 100).toFixed(1), 6)}% of instances`);
}
const worstPhase = out.rows.slice().sort((a, b) => b.phaseR - a.phaseR)[0];
if (worstPhase) {
  console.log(`\nmost synchronised unit: ${worstPhase.typeId} R=${worstPhase.phaseR} over ${worstPhase.n} men, ${worstPhase.cadence} distinct cadences`);
}

if (JSON_OUT) {
  const fs = await import('node:fs');
  fs.writeFileSync(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

await browser.close();
if (server) server.kill();
