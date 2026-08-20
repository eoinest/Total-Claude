#!/usr/bin/env node
/** A determined commander: re-issue the order inside every second. Does the route deliver? */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5411);
const NARROW = process.argv.includes('--narrow');
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&w=640&h=360&scenario=assault&map=campus-martius`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
const out = await page.evaluate(async (NARROW) => {
  const g = window.__game, b = g.battle, s = b.siege, ctx = g.engine.context;
  g.engine.stop();
  const city = ctx.get('city');
  const gd = city.getGateDoor();
  const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction ?? 0;
  while (g.simTime() < 230) g.engine.advance(1 / 30, 1000 / 30);
  const tx = gd.x - gd.nx * 45, tz = gd.z - gd.nz * 45;
  const ids = b.units.filter((u) => /juthungi-warband/.test(u.typeId) && u.alive > 40).map((u) => u.id);
  const issue = () => {
    for (const id of ids) {
      const u = b.unitById(id);
      if (!u || u.alive <= 0) continue;
      if (NARROW && u.formationId !== 'column' && u.formationId !== 'testudo') {
        ctx.events.emit('orderIssued', { unitIds: [id], kind: 'formation', formationId: 'column' });
      }
      ctx.events.emit('orderIssued', { unitIds: [id], kind: 'move', x: tx, z: tz, facing: 0, running: true });
    }
  };
  const rows = [];
  let nextIssue = 230;
  for (let t = 230; t <= 440; t += 1) {
    if (t >= nextIssue) { issue(); nextIssue = t + 1; }
    while (g.simTime() < t - 1e-6) g.engine.advance(1 / 30, 1000 / 30);
    if (t % 15 !== 0) continue;
    const p = b.pool;
    let inside = 0, aliveHost = 0, atGate = 0, deepest = 1e9;
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (st === 10 || st === 11 || p.faction[i] === defender) continue;
      const dx = p.x[i] - gd.x, dz = p.z[i] - gd.z;
      const along = dx * gd.nx + dz * gd.nz;
      const lat = Math.abs(dx * gd.dx + dz * gd.dz);
      aliveHost++;
      if (along < deepest) deepest = along;
      if (along < -14 && b.elevated[i] === 0) inside++;
      if (lat <= 16 && along >= 0 && along < 40) atGate++;
    }
    const us = ids.map((id) => { const u = b.unitById(id);
      return u ? `${id}:${u.alive}:o${u.order}:${u.formationId.slice(0,4)}:wp${u.waypoints.length}:${Math.round(u.x)},${Math.round(u.z)}` : `${id}:gone`; });
    rows.push({ t, inside, aliveHost, atGate, deepest: +deepest.toFixed(0), us });
  }
  return { ids, aim: { x: +tx.toFixed(1), z: +tz.toFixed(1) }, rows };
}, NARROW);
console.log('narrow-formation mode:', NARROW, ' aim', JSON.stringify(out.aim), ' units', JSON.stringify(out.ids));
console.log('\nt     insideStreet  aliveHost  atGate  deepestAlong');
for (const r of out.rows) {
  console.log(`${String(r.t).padStart(4)}  ${String(r.inside).padStart(9)}  ${String(r.aliveHost).padStart(9)}  ${String(r.atGate).padStart(6)}  ${String(r.deepest).padStart(6)}`);
}
console.log('\nlast unit states:'); for (const u of out.rows[out.rows.length - 1].us) console.log('  ', u);
await browser.close();
