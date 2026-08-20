#!/usr/bin/env node
/** Why does nobody walk through the arch? Nav state + who is ordered where. */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5411);
const MAP = process.argv.find((a) => a.startsWith('--map='))?.slice(6) ?? 'campus-martius';
const UNTIL = Number(process.argv.find((a) => a.startsWith('--until='))?.slice(8) ?? 300);
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&w=640&h=360&scenario=assault&map=${MAP}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
const out = await page.evaluate(async (until) => {
  const g = window.__game, b = g.battle, s = b.siege;
  g.engine.stop();
  const city = g.engine.context.get('city');
  const gd = city.getGateDoor();
  const gate0 = city.getGates()[0];
  const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction ?? 0;
  const nav = g.engine.context.tryGet ? g.engine.context.tryGet('pathfinding') : null;
  // Which way is the city? Use the mean of the city's own building obstacles.
  let cx = 0, cz = 0, nb = 0;
  const obs = city.getObstacles ? city.getObstacles() : [];
  for (const o of obs) { if (o.kind === 'building' || o.kind === 'insula') { cx += o.x; cz += o.z; nb++; } }
  const centre = nb > 0 ? { x: cx / nb, z: cz / nb, n: nb } : null;
  const centreAlong = centre ? (centre.x - gd.x) * gd.nx + (centre.z - gd.z) * gd.nz : null;
  const snap = () => {
    const p = b.pool;
    const gate = s.gateReport();
    // nav probe across the door plane
    const bm = city.blocksMovement(gd.x + gd.nx * 12, gd.z + gd.nz * 12, gd.x - gd.nx * 12, gd.z - gd.nz * 12);
    let aliveAtk = 0, routing = 0, through = 0, hi = 0, out40 = 0;
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (st === 10 || st === 11 || p.faction[i] === defender) continue;
      aliveAtk++;
      if (st === 12) routing++;
      const dx = p.x[i] - gd.x, dz = p.z[i] - gd.z;
      const along = dx * gd.nx + dz * gd.nz;
      const lat = Math.abs(dx * gd.dx + dz * gd.dz);
      if (lat > 16) continue;
      if (along < 0) { if (p.y[i] > gd.y + 2.5) hi++; else through++; }
      else if (along < 40) out40++;
    }
    // Attacker units and where they are ordered
    const units = [];
    for (const u of b.units) {
      if (u.faction === defender || u.alive <= 0) continue;
      const tAlong = (u.targetX - gd.x) * gd.nx + (u.targetZ - gd.z) * gd.nz;
      const uAlong = (u.x - gd.x) * gd.nx + (u.z - gd.z) * gd.nz;
      units.push({ id: u.id, t: u.typeId, n: u.alive, o: u.order,
        x: +u.x.toFixed(0), z: +u.z.toFixed(0), tx: +u.targetX.toFixed(0), tz: +u.targetZ.toFixed(0),
        uAlong: +uAlong.toFixed(0), tAlong: +tAlong.toFixed(0), mor: +u.morale.toFixed(2) });
    }
    const insideTargets = units.filter((u) => u.tAlong < 0).length;
    return { t: +g.simTime().toFixed(0), open: gate.open, blows: gate.blows, bm,
      aliveAtk, routing, through, hi, out40, insideTargets, units };
  };
  const rows = [];
  for (let t = 200; t <= until; t += 20) {
    while (g.simTime() < t - 1e-6) g.engine.advance(1 / 30, 1000 / 30);
    rows.push(snap());
  }
  return { gd: { x: +gd.x.toFixed(1), z: +gd.z.toFixed(1), y: +gd.y.toFixed(1), nx: +gd.nx.toFixed(3), nz: +gd.nz.toFixed(3), dx: +gd.dx.toFixed(3), dz: +gd.dz.toFixed(3), halfWidth: gd.halfWidth },
    gate0: { id: gate0.id, x: +gate0.x.toFixed(1), z: +gate0.z.toFixed(1), open: gate0.open, facing: gate0.facing },
    centre, centreAlong: centreAlong === null ? null : +centreAlong.toFixed(1),
    navStats: nav && nav.stats ? { ...nav.stats } : null, rows };
}, UNTIL);
console.log('gateDoor  ', JSON.stringify(out.gd));
console.log('gate0     ', JSON.stringify(out.gate0));
console.log('cityCentre', JSON.stringify(out.centre), 'centreAlong=', out.centreAlong,
  '=>', out.centreAlong < 0 ? 'NEGATIVE along IS the city (instrument sign OK)' : 'POSITIVE along is the city (INSTRUMENT SIGN INVERTED)');
console.log('navStats  ', JSON.stringify(out.navStats));
console.log('');
console.log('t    open blows bmBlocked aliveAtk rout through hiWalk out40 unitsTargetedInside');
for (const r of out.rows) {
  console.log(`${String(r.t).padStart(4)} ${r.open ? 'Y' : 'n'}    ${String(r.blows).padStart(3)}   ${r.bm ? 'BLOCKED' : 'open   '}   ${String(r.aliveAtk).padStart(5)} ${String(r.routing).padStart(5)} ${String(r.through).padStart(6)} ${String(r.hi).padStart(5)} ${String(r.out40).padStart(5)}   ${r.insideTargets}`);
}
console.log('\n--- attacker units at t=240 ---');
const r240 = out.rows.find((r) => r.t >= 240) ?? out.rows[out.rows.length - 1];
for (const u of r240.units) console.log(JSON.stringify(u));
await browser.close();
