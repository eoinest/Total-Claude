#!/usr/bin/env node
/** Order timeline for every attacker unit, plus where the near-gate crowd goes. */
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
  const gd = city.getGateDoor();
  const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction ?? 0;
  const ON = ['Hold', 'MoveTo', 'AtkMv', 'AtkU', 'Withd', 'Rout', 'Garr'];
  const rows = [];
  // Track the fate of the men who are near the gate at t=200.
  let cohort = null;
  for (let t = 60; t <= 320; t += 20) {
    while (g.simTime() < t - 1e-6) g.engine.advance(1 / 30, 1000 / 30);
    const p = b.pool;
    if (t === 200) {
      cohort = [];
      for (let i = 0; i < p.count; i++) {
        const st = p.state[i];
        if (st === 10 || st === 11 || p.faction[i] === defender) continue;
        const dx = p.x[i] - gd.x, dz = p.z[i] - gd.z;
        const along = dx * gd.nx + dz * gd.nz;
        const lat = Math.abs(dx * gd.dx + dz * gd.dz);
        if (lat <= 16 && along >= 0 && along < 40) cohort.push(i);
      }
    }
    let fate = null;
    if (cohort) {
      let dead = 0, alive = 0, rout = 0, inside = 0, still = 0;
      for (const i of cohort) {
        const st = p.state[i];
        if (st === 10 || st === 11) { dead++; continue; }
        alive++;
        if (st === 12) rout++;
        const dx = p.x[i] - gd.x, dz = p.z[i] - gd.z;
        const along = dx * gd.nx + dz * gd.nz;
        const lat = Math.abs(dx * gd.dx + dz * gd.dz);
        if (along < 0) inside++;
        else if (lat <= 16 && along < 40) still++;
      }
      fate = { n: cohort.length, dead, alive, rout, inside, still };
    }
    const us = [];
    for (const u of b.units) {
      if (u.faction === defender) continue;
      us.push(`${u.id}:${u.typeId.slice(0, 6)}:${u.alive}:${ON[u.order]}:${Math.round(u.morale)}`);
    }
    rows.push({ t: +g.simTime().toFixed(0), open: s.gateReport().open, fate, us });
  }
  return rows;
});
for (const r of out) {
  console.log(`\n=== t=${r.t} gateOpen=${r.open ? 'Y' : 'n'}${r.fate ? `  gateCrowd(t200 cohort n=${r.fate.n}): dead=${r.fate.dead} alive=${r.fate.alive} routing=${r.fate.rout} inside=${r.fate.inside} stillAtGate=${r.fate.still}` : ''}`);
  console.log('   ' + r.us.join('  '));
}
await browser.close();
