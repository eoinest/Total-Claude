#!/usr/bin/env node
/** Order one healthy cohort through the open gate. Does it arrive? */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5411);
const MAP = process.argv.find((a) => a.startsWith('--map='))?.slice(6) ?? 'campus-martius';
const DEPTH = Number(process.argv.find((a) => a.startsWith('--depth='))?.slice(8) ?? 45);
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&w=640&h=360&scenario=assault&map=${MAP}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
const out = await page.evaluate(async (DEPTH) => {
  const g = window.__game, b = g.battle, s = b.siege;
  g.engine.stop();
  const city = g.engine.context.get('city');
  const gd = city.getGateDoor();
  const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction ?? 0;
  // Run to just after the gate opens.
  while (g.simTime() < 230) g.engine.advance(1 / 30, 1000 / 30);
  const gate = s.gateReport();
  // Aim DEPTH metres cityward of the door centre, on the door axis.
  const tx = gd.x - gd.nx * DEPTH, tz = gd.z - gd.nz * DEPTH;
  // Pick the healthiest attacker foot cohort nearest the gate axis.
  let best = null, bestScore = -1e9;
  for (const u of b.units) {
    if (u.faction === defender || u.alive < 40 || u.morale < 20) continue;
    if (/onager|ram-|tower-|escala/.test(u.typeId)) continue;
    const lat = Math.abs((u.x - gd.x) * gd.dx + (u.z - gd.z) * gd.dz);
    const sc = u.alive - lat * 2;
    if (sc > bestScore) { bestScore = sc; best = u; }
  }
  if (!best) return { err: 'no candidate unit' };
  const pick = { id: best.id, t: best.typeId, n: best.alive, x: +best.x.toFixed(0), z: +best.z.toFixed(0), mor: +best.morale.toFixed(0) };
  // Order it exactly the way the mouse and the AI both do.
  g.engine.context.events.emit('orderIssued', {
    unitIds: [best.id], kind: 'move', x: tx, z: tz, facing: 0, running: true,
  });
  const rows = [];
  for (let t = 230; t <= 420; t += 10) {
    while (g.simTime() < t - 1e-6) g.engine.advance(1 / 30, 1000 / 30);
    const p = b.pool;
    const u = b.unitById(pick.id);
    let mine = 0, mineIn = 0, mineDead = 0, allIn = 0;
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (p.faction[i] === defender) continue;
      const dx = p.x[i] - gd.x, dz = p.z[i] - gd.z;
      const along = dx * gd.nx + dz * gd.nz;
      const lat = Math.abs(dx * gd.dx + dz * gd.dz);
      const isMine = u && u.members.includes(i);
      if (st === 10 || st === 11) { if (isMine) mineDead++; continue; }
      if (isMine) { mine++; if (along < -14) mineIn++; }
      if (along < -14 && b.elevated[i] === 0) allIn++;
    }
    const obj = b.flow ? null : null;
    rows.push({ t: +g.simTime().toFixed(0), n: u ? u.alive : 0, o: u ? u.order : -1,
      ux: u ? +u.x.toFixed(0) : 0, uz: u ? +u.z.toFixed(0) : 0,
      tx: u ? +u.targetX.toFixed(0) : 0, tz: u ? +u.targetZ.toFixed(0) : 0,
      mor: u ? +u.morale.toFixed(0) : 0, mine, mineIn, mineDead, allIn });
  }
  return { gateOpenAt230: gate.open, aim: { x: +tx.toFixed(1), z: +tz.toFixed(1) }, pick, rows };
}, DEPTH);
if (out.err) { console.log('ERR', out.err); } else {
  console.log('gateOpen@230', out.gateOpenAt230, ' aimPoint', JSON.stringify(out.aim));
  console.log('ordered unit', JSON.stringify(out.pick));
  console.log('\nt    alive ord  unitXZ        targetXZ      mor  cohortAlive cohortInside cohortDead  allAttackersInside(street)');
  for (const r of out.rows) {
    console.log(`${String(r.t).padStart(4)} ${String(r.n).padStart(5)} ${String(r.o).padStart(3)}  (${String(r.ux).padStart(4)},${String(r.uz).padStart(4)})   (${String(r.tx).padStart(4)},${String(r.tz).padStart(4)})  ${String(r.mor).padStart(3)}  ${String(r.mine).padStart(10)} ${String(r.mineIn).padStart(12)} ${String(r.mineDead).padStart(10)}  ${String(r.allIn).padStart(6)}`);
  }
}
await browser.close();
