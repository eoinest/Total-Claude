#!/usr/bin/env node
/** Is the opened gate a usable route, decoupled from any AI? Ask the pathfinder directly. */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5411);
const MAP = process.argv.find((a) => a.startsWith('--map='))?.slice(6) ?? 'campus-martius';
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&w=640&h=360&scenario=assault&map=${MAP}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
const out = await page.evaluate(async () => {
  const g = window.__game, b = g.battle, s = b.siege;
  g.engine.stop();
  const city = g.engine.context.get('city');
  const nav = g.engine.context.get('pathfinding');
  const gd = city.getGateDoor();
  const rep = [];
  const probe = (label) => {
    const ax = gd.x + gd.nx * 40, az = gd.z + gd.nz * 40;   // 40 m outside
    const bx = gd.x - gd.nx * 45, bz = gd.z - gd.nz * 45;   // 45 m inside
    const axis = [];
    for (let t = 30; t >= -30; t -= 5) {
      const x = gd.x + gd.nx * t, z = gd.z + gd.nz * t;
      axis.push(`${t > 0 ? '+' : ''}${t}:${nav.grid.blockedAt(x, z) ? 'B' : '.'}${nav.grid.tight[nav.grid.cellAt(x, z)] ? 'T' : '.'}${nav.grid.clearanceAt(x, z).toFixed(1)}`);
    }
    const clf = {};
    for (const r of [0.5, 2.2, 5, 8, 11]) clf[r] = +nav.clearLineFraction(ax, az, bx, bz, r).toFixed(3);
    const drc = {};
    for (const r of [0.5, 2.2, 5, 8, 11]) drc[r] = nav.directRouteClear(ax, az, bx, bz, r);
    rep.push({ label, gateOpen: s.gateReport().open,
      blocksMovement: city.blocksMovement(ax, az, bx, bz), axis, clearLineFraction: clf, directRouteClear: drc });
  };
  while (g.simTime() < 205) g.engine.advance(1 / 30, 1000 / 30);
  probe('t=205 (gate SHUT)');
  while (g.simTime() < 235) g.engine.advance(1 / 30, 1000 / 30);
  probe('t=235 (gate OPEN)');
  // Now ask A* for an actual route through it, at several footprint radii.
  const ax = gd.x + gd.nx * 40, az = gd.z + gd.nz * 40;
  const bx = gd.x - gd.nx * 45, bz = gd.z - gd.nz * 45;
  const paths = [];
  let key = 900000;
  for (const r of [0.5, 2.2, 5, 8, 11]) {
    const k = key++;
    nav.clearPath(k);
    nav.requestPath(k, ax, az, bx, bz, r, r, 3);
    for (let i = 0; i < 400; i++) g.engine.advance(1 / 30, 1000 / 30);
    const p = nav.pathFor(k);
    let crosses = false, minAlong = 1e9;
    if (p && p.n >= 2) {
      for (let i = 0; i < p.n; i++) {
        const al = (p.pts[i * 2] - gd.x) * gd.nx + (p.pts[i * 2 + 1] - gd.z) * gd.nz;
        if (al < minAlong) minAlong = al;
        if (al < -14) crosses = true;
      }
    }
    paths.push({ radius: r, got: !!p, n: p ? p.n : 0, ok: p ? p.ok : null,
      goal: p ? `${p.goalX.toFixed(0)},${p.goalZ.toFixed(0)}` : '-',
      deepestAlong: minAlong === 1e9 ? null : +minAlong.toFixed(1), reachesInside: crosses });
  }
  // Footprints of the real attacker cohorts.
  const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction ?? 0;
  const fps = [];
  const ai = g.engine.context.tryGet('tacticalAI');
  for (const u of b.units) {
    if (u.faction === defender || u.alive <= 0) continue;
    fps.push({ id: u.id, t: u.typeId, n: u.alive, form: u.formationId, width: u.width });
  }
  return { gd: { x: +gd.x.toFixed(1), z: +gd.z.toFixed(1), nx: +gd.nx.toFixed(3), nz: +gd.nz.toFixed(3) }, rep, paths, fps };
});
console.log('gateDoor', JSON.stringify(out.gd));
for (const r of out.rep) {
  console.log(`\n--- ${r.label}  gateOpen=${r.gateOpen}  blocksMovement(out->in)=${r.blocksMovement}`);
  console.log('  axis (metres along outward normal; B=blocked T=tight clearance):');
  console.log('   ' + r.axis.join(' '));
  console.log('  clearLineFraction by radius:', JSON.stringify(r.clearLineFraction));
  console.log('  directRouteClear  by radius:', JSON.stringify(r.directRouteClear));
}
console.log('\n--- A* routes through the open gate (40 m outside -> 45 m inside) ---');
for (const p of out.paths) console.log('  ', JSON.stringify(p));
console.log('\n--- attacker cohort formations ---');
for (const f of out.fps) console.log('  ', JSON.stringify(f));
await browser.close();
