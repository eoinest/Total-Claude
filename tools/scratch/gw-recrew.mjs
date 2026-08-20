#!/usr/bin/env node
/** When the ram goes derelict, who could have taken it, and how far away were they? */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5411);
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&w=640&h=360&scenario=assault&map=campus-martius`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
const out = await page.evaluate(async () => {
  const g = window.__game, b = g.battle, s = b.siege;
  g.engine.stop();
  const rows = [];
  let firstDerelict = null; let lastGood = null;
  for (let t = 5; t <= 340; t += 5) {
    while (g.simTime() < t - 1e-6) g.engine.advance(1 / 30, 1000 / 30);
    const rep = null;
    const gate = s.gateReport();
    const crew = b.units.find((u) => /ram-crew/.test(u.typeId));
    // The machine has no published position, so use the crew standing on it while it works.
    const r0 = crew && crew.alive > 0 && crew.order !== 5 ? { state: crew.order, x: crew.x, z: crew.z, wreck: false } : lastGood;
    if (crew && crew.alive > 0 && crew.order !== 5) lastGood = { state: crew.order, x: crew.x, z: crew.z, wreck: false };
    const row = { t, blows: gate.blows, open: gate.open,
      crew: crew ? { n: crew.alive, o: crew.order, mor: Math.round(crew.morale) } : null,
      ram: r0 ? { st: r0.state, x: Math.round(r0.x), z: Math.round(r0.z), wreck: !!r0.wreck } : null };
    rows.push(row);
    // The moment the crew is gone or routing, measure the re-crew field.
    const derelict = crew && (crew.alive === 0 || crew.order === 5);
    if (derelict && !firstDerelict && r0) {
      const cands = [];
      for (const u of b.units) {
        if (u.destroyed || u.alive === 0) continue;
        if (crew && u.faction !== crew.faction) continue;
        if (u.id === crew.id) continue;
        const d = Math.hypot(u.x - r0.x, u.z - r0.z);
        cands.push({ id: u.id, t: u.typeId, n: u.alive, o: u.order, mor: Math.round(u.morale),
          d: +d.toFixed(1), eligible: u.order !== 5 && !u.contactLock });
      }
      cands.sort((a, b2) => a.d - b2.d);
      firstDerelict = { t, blows: gate.blows, ram: { x: Math.round(r0.x), z: Math.round(r0.z) }, cands };
    }
  }
  return { rows, firstDerelict };
});
console.log('t   blows open  crew(n/order/morale)      ram(state,x,z)');
for (const r of out.rows) {
  if (r.t % 20 !== 0 && !(r.t >= 195 && r.t <= 245)) continue;
  console.log(`${String(r.t).padStart(3)} ${String(r.blows).padStart(5)} ${r.open ? 'Y' : 'n'}    ${r.crew ? `${String(r.crew.n).padStart(3)}/${r.crew.o}/${String(r.crew.mor).padStart(3)}` : '-'}                 ${r.ram ? `${r.ram.st},${r.ram.x},${r.ram.z}${r.ram.wreck ? ',WRECK' : ''}` : '-'}`);
}
if (out.firstDerelict) {
  const f = out.firstDerelict;
  console.log(`\n=== ram derelict at t+${f.t}, ${f.blows} of 26 blows, ram at (${f.ram.x}, ${f.ram.z}) ===`);
  console.log('RECREW_RADIUS is 95 m. Candidates by distance:');
  for (const c of f.cands.slice(0, 10)) {
    console.log(`  ${c.d < 95 ? 'IN ' : 'OUT'} ${String(c.d).padStart(7)} m  #${c.id} ${c.t} n=${c.n} order=${c.o} morale=${c.mor} eligible=${c.eligible}`);
  }
  const inR = f.cands.filter((c) => c.d < 95 && c.eligible);
  console.log(`\n  eligible within 95 m: ${inR.length}`);
  const nearestEligible = f.cands.find((c) => c.eligible);
  console.log(`  nearest eligible of any distance: ${nearestEligible ? `#${nearestEligible.id} ${nearestEligible.t} at ${nearestEligible.d} m (${nearestEligible.n} men)` : 'none'}`);
}
await browser.close();
