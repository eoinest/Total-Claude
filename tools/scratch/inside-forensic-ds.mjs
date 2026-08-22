#!/usr/bin/env node
/**
 * Are the men `censusWall` counts as "inside the city" actually inside the city?
 *
 * Both Juthungi wins in the 12-seed campaign came through `stormInside >= BREAK_IN`, and one
 * of them fired at t+857 in a battle where nothing had stood on the parapet since t+219, no
 * ladder had been crossed since t+80, the gate was never breached and no wall was ever
 * broken. Sixty-two men cannot be inside a city they never entered, so either they got in by
 * a route the reports do not show or the census is counting something else.
 *
 * `BattleFlow.censusWall` attributes each man to a bay by
 *
 *     k = clamp(round((x - w.x0) / w.pitch), 0, last)
 *
 * and then measures his depth against *that* bay's normal. The clamp is the thing worth
 * suspecting: a man off either end of the curtain in x is attributed to the first or last
 * bay whatever his real position, and a routing unit that runs round the end of the wall
 * would be measured against a bay a kilometre away.
 *
 * This replays the winning seed, stops where the census crosses the threshold, and prints
 * every counted man's real position beside the bay he was charged to — so the answer is a
 * table of coordinates rather than an argument.
 *
 *   node tools/scratch/inside-forensic-ds.mjs --port=5449 --seed=745024802 --until=880
 */

import { chromium } from 'playwright';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from '../lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const PORT = Number(args.get('port') ?? 5449);
const SEED = Number(args.get('seed') ?? 745024802);
const UNTIL = Number(args.get('until') ?? 880);
const TRACK_ONLY = args.has('trackonly');
const MAP = args.get('map') ?? 'campus-martius';

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: 'assault', quality: 'high', seed: SEED }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
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
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
  console.log(`• started vite pid ${server.pid} on ${PORT}`);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.goto(`${base}/?harness=1&w=480&h=270&quality=high&scenario=assault&autoplay=1&battle=${token}`,
  { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
await page.evaluate(() => window.__game.engine.stop());

const probe = () => page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const b = window.__game.battle;
  const flow = ctx.get('battleFlow');
  const w = flow.wall;
  const o = flow.objective ?? {};
  if (!w) return { t: ctx.time.simTime, inside: 0, men: [] };
  const p = b.pool;
  const last = w.mx.length - 1;
  const men = [];
  for (let i = 0; i < p.count; i++) {
    if (p.faction[i] !== w.storm || b.elevated[i] !== 0 || !p.aliveAt(i)) continue;
    const kRaw = Math.round((p.x[i] - w.x0) / w.pitch);
    const k = Math.max(0, Math.min(last, kRaw));
    const depth = (p.x[i] - w.mx[k]) * w.nx[k] + (p.z[i] - w.mz[k]) * w.nz[k];
    if (depth >= -14) continue;
    const u = b.unitById(p.unitId[i]);
    men.push({
      x: +p.x[i].toFixed(1), z: +p.z[i].toFixed(1),
      kRaw, k, clamped: kRaw !== k,
      bayX: +w.mx[k].toFixed(1), bayZ: +w.mz[k].toFixed(1),
      depth: +depth.toFixed(1),
      unit: u ? u.typeId : '?', order: u ? u.order : -1,
    });
  }
  return {
    t: +ctx.time.simTime.toFixed(0),
    inside: o.stormInside ?? 0,
    onWall: o.stormOnWall ?? 0,
    garrison: o.garrisonOnWall ?? 0,
    wallX0: +w.x0.toFixed(1), pitch: +w.pitch.toFixed(2), bays: w.mx.length,
    result: flow.result ? `${flow.result.victor}/${flow.result.reason}@${flow.result.at.toFixed(0)}` : null,
    men,
  };
});

/**
 * Does the curtain stop anything, and where does it not?
 *
 * `CitySystem.blocksMovement(x1,z1,x2,z2)` is the segment test the crowd solver and the
 * order layer use, and `NavGrid.blockedAt` is what the pathfinder refuses. This walks the
 * whole circuit at 5 m and asks both of a short segment straddling the wall line, so a hole
 * shows up as a run of x where a horse may simply ride through.
 */
{
  const gaps = await page.evaluate(() => {
    const ctx = window.__game.engine.context;
    const city = ctx.get('city');
    const nav = ctx.tryGet('pathfinding');
    const samples = city.getCircuitSamples(5);
    const zAt = (x) => {
      if (x <= samples[0].x) return samples[0].z;
      const last = samples[samples.length - 1];
      if (x >= last.x) return last.z;
      let i = 0;
      while (i < samples.length - 2 && samples[i + 1].x < x) i++;
      const t = (x - samples[i].x) / (samples[i + 1].x - samples[i].x || 1);
      return samples[i].z + (samples[i + 1].z - samples[i].z) * t;
    };
    const open = [];
    let scanned = 0;
    for (let x = samples[0].x; x <= samples[samples.length - 1].x; x += 5) {
      const cz = zAt(x);
      scanned++;
      const blocked = city.blocksMovement(x, cz - 14, x, cz + 14);
      const navBlocked = nav ? nav.grid.blockedAt(x, cz) : null;
      if (!blocked) open.push({ x: +x.toFixed(0), z: +cz.toFixed(0), navBlocked });
    }
    return { scanned, open, x0: samples[0].x, x1: samples[samples.length - 1].x };
  });
  console.log(
    `\ncurtain crossing test: ${gaps.scanned} stations from x ${gaps.x0.toFixed(0)} to ` +
      `${gaps.x1.toFixed(0)}; ${gaps.open.length} where a 28 m segment straight through the ` +
      'wall line is NOT blocked',
  );
  // Collapse into runs.
  let runStart = null;
  let prev = null;
  const runs = [];
  for (const g of gaps.open) {
    if (runStart === null) { runStart = g.x; }
    else if (g.x - prev > 5.5) { runs.push([runStart, prev]); runStart = g.x; }
    prev = g.x;
  }
  if (runStart !== null) runs.push([runStart, prev]);
  for (const [a, b] of runs) {
    const nb = gaps.open.filter((g) => g.x >= a && g.x <= b && g.navBlocked).length;
    const n = gaps.open.filter((g) => g.x >= a && g.x <= b).length;
    console.log(`   open x ${a} .. ${b}  (${(b - a + 5)} m, ${nb}/${n} of them still refused by the nav grid)`);
  }
  // What kind of bay stands where the gaps are? Rome's circuit is a building site and
  // `BayStage` says which stretches are finished; a hole in a 'gap' bay is the design.
  const stages = await page.evaluate(() => {
    const city = window.__game.engine.context.get('city');
    return city.getGarrisonBays().map((b) => ({
      i: b.index, x0: +b.x0.toFixed(0), x1: +b.x1.toFixed(0), stage: b.stage,
      walkable: b.walkable, garrisonable: b.garrisonable, isGate: b.isGate,
    }));
  });
  console.log('  bays covering the open runs:');
  for (const b of stages) {
    const hits = [[-551, -536], [369, 389], [404, 424]].some(([a, c]) => b.x1 >= a && b.x0 <= c);
    if (hits) {
      console.log(
        `   bay ${String(b.i).padStart(2)}  x ${String(b.x0).padStart(6)}..${String(b.x1).padStart(6)}  ` +
          `stage ${b.stage.padEnd(11)} walkable=${b.walkable} garrisonable=${b.garrisonable}`,
      );
    }
  }
  const byStage = new Map();
  for (const b of stages) byStage.set(b.stage, (byStage.get(b.stage) ?? 0) + 1);
  console.log(`  whole circuit by stage: ${JSON.stringify([...byStage])}`);
  console.log('');
}

/**
 * Where does the cavalry cross the curtain?
 *
 * The men the census calls "inside" at t+40 are all `juthungi-riders`, and they deploy
 * 178 m *outside*. So they crossed a wall in forty seconds. This walks the first two
 * minutes at 5 s and prints each horse unit's anchor beside the wall's own z at that x, so
 * the crossing shows up as a sign change rather than as an inference.
 */
{
  console.log('\nrider track — z of the unit against the wall line at its own x');
  console.log('     t   unit          x        z    wallZ    depth  alive  order');
  for (let t = 0; t <= 120; t += 5) {
    const rows = await page.evaluate(() => {
      const ctx = window.__game.engine.context;
      const b = window.__game.battle;
      const flow = ctx.get('battleFlow');
      const w = flow.wall;
      // Null until the first tick with units: `findWall` runs from the census, not from init.
      if (!w) return [];
      const last = w.mx.length - 1;
      const out = [];
      for (const u of b.units) {
        if (!/riders|equites/.test(u.typeId)) continue;
        const k = Math.max(0, Math.min(last, Math.round((u.x - w.x0) / w.pitch)));
        const depth = (u.x - w.mx[k]) * w.nx[k] + (u.z - w.mz[k]) * w.nz[k];
        out.push({
          t: +ctx.time.simTime.toFixed(0), id: u.id, type: u.typeId,
          x: +u.x.toFixed(1), z: +u.z.toFixed(1),
          wallZ: +w.mz[k].toFixed(1), depth: +depth.toFixed(1),
          alive: u.alive, order: u.order,
        });
      }
      return out;
    });
    for (const r of rows) {
      console.log(
        `  ${String(r.t).padStart(4)}   #${String(r.id).padEnd(4)} ${String(r.x).padStart(8)} ` +
          `${String(r.z).padStart(8)} ${String(r.wallZ).padStart(8)} ${String(r.depth).padStart(8)} ` +
          `${String(r.alive).padStart(6)} ${String(r.order).padStart(6)}`,
      );
    }
    await page.evaluate(() => window.__game.engine.advance(5, 166));
  }
  console.log('');
}

if (TRACK_ONLY) { await browser.close(); if (server) server.kill('SIGTERM'); process.exit(0); }
console.log(`seed ${SEED}, advancing to ${UNTIL}s…`);
let last = null;
for (let t = 0; t < UNTIL; t += 20) {
  await page.evaluate(() => window.__game.engine.advance(20, 166));
  const s = await probe();
  last = s;
  if (s.inside >= 20 || s.result) {
    console.log(`\nt=${s.t}  inside=${s.inside} onWall=${s.onWall} garrison=${s.garrison} result=${s.result}`);
    console.log(`wall: x0 ${s.wallX0}, pitch ${s.pitch}, ${s.bays} bays -> x ${s.wallX0} .. ${(s.wallX0 + s.pitch * (s.bays - 1)).toFixed(0)}`);
    const clamped = s.men.filter((m) => m.clamped);
    console.log(`counted ${s.men.length} men, of which ${clamped.length} were attributed to a bay by the clamp`);
    const byUnit = new Map();
    for (const m of s.men) byUnit.set(m.unit, (byUnit.get(m.unit) ?? 0) + 1);
    console.log(`by unit type: ${JSON.stringify([...byUnit])}`);
    console.log('  first 20 counted men:');
    console.log('       x        z   kRaw    k  clamped     bayX     bayZ   depth  unit');
    for (const m of s.men.slice(0, 20)) {
      console.log(
        `  ${String(m.x).padStart(7)} ${String(m.z).padStart(8)} ${String(m.kRaw).padStart(6)} ` +
          `${String(m.k).padStart(4)} ${String(m.clamped).padStart(8)} ${String(m.bayX).padStart(8)} ` +
          `${String(m.bayZ).padStart(8)} ${String(m.depth).padStart(7)}  ${m.unit}`,
      );
    }
    if (s.result) break;
  }
}
if (last && last.inside < 20 && !last.result) {
  console.log(`\nnever crossed 20 inside; last t=${last.t} inside=${last.inside}`);
}

await browser.close();
if (server) { server.kill('SIGTERM'); console.log(`• killed vite pid ${server.pid}`); }
