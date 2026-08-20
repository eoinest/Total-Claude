#!/usr/bin/env node
/** Does anyone actually come through the arch after the gate goes, and when? */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5219);
const MAP = process.argv.find((a) => a.startsWith('--map='))?.slice(6) ?? 'campus-martius';
const ENEMY = process.argv.find((a) => a.startsWith('--enemy='))?.slice(8) ?? '';
const UNTIL = Number(process.argv.find((a) => a.startsWith('--until='))?.slice(8) ?? 340);
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`${base}/?harness=1&quality=ultra&w=640&h=360&scenario=assault&map=${MAP}${ENEMY ? `&enemy=${ENEMY}` : ''}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
const out = await page.evaluate(async (until) => {
  const g = window.__game, b = g.battle, s = b.siege;
  g.engine.stop();
  const city = g.engine.context.get('city');
  const gd = city.getGateDoor();
  const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction ?? 0;
  const near = () => {
    const p = b.pool;
    let through = 0, outside30 = 0, hiThrough = 0;
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (st === 11 || st === 10 || p.faction[i] === defender) continue;
      const dx = p.x[i] - gd.x, dz = p.z[i] - gd.z;
      const along = dx * gd.nx + dz * gd.nz;      // + is outside
      const lat = Math.abs(dx * gd.dx + dz * gd.dz);
      if (lat > 16) continue;
      if (along < 0) { if (p.y[i] > gd.y + 2.5) hiThrough++; else through++; }
      else if (along < 40) outside30++;
    }
    return { through, outside30, hiThrough };
  };
  const rows = [];
  for (let t = 200; t <= until; t += 5) {
    while (g.simTime() < t - 1e-6) g.engine.advance(1 / 30, 1000 / 30);
    const gate = s.gateReport();
    rows.push({ t: +g.simTime().toFixed(0), open: gate.open, breached: gate.breached,
      blows: gate.blows, ...near() });
  }
  return { gd: { x: +gd.x.toFixed(1), z: +gd.z.toFixed(1), y: +gd.y.toFixed(1),
    nx: +gd.nx.toFixed(3), nz: +gd.nz.toFixed(3), halfWidth: gd.halfWidth, height: gd.height }, rows };
}, UNTIL);
console.log('gateDoor', JSON.stringify(out.gd));
console.log('t     open br blows  through  onWallOverArch  outside<40m');
for (const r of out.rows) {
  console.log(`${String(r.t).padStart(4)}  ${r.open ? 'Y' : 'n'}    ${r.breached ? 'Y' : 'n'}  ${String(r.blows).padStart(3)}   ${String(r.through).padStart(5)}   ${String(r.hiThrough).padStart(8)}   ${String(r.outside30).padStart(6)}`);
}
await browser.close();
