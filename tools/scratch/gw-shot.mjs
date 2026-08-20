#!/usr/bin/env node
/** The gate mouth 30 s after it opens: as shipped, and with the reserved storm order given. */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5411);
const ARM = process.argv.find((a) => a.startsWith('--arm='))?.slice(6) ?? 'shipped';
const AFTER = Number(process.argv.find((a) => a.startsWith('--after='))?.slice(8) ?? 30);
const OUT = '/private/tmp/tc-gateway/screenshots/gate-mouth';
await mkdir(OUT, { recursive: true });
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&w=1280&h=720&scenario=assault&map=campus-martius`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
const info = await page.evaluate(async ([ARM, AFTER]) => {
  const g = window.__game, b = g.battle, s = b.siege, ctx = g.engine.context;
  g.engine.stop();
  const city = ctx.get('city');
  const gd = city.getGateDoor();
  // Advance to the moment the leaves give way.
  let tOpen = -1;
  for (let t = 190; t <= 260; t += 1) {
    while (g.simTime() < t - 1e-6) g.engine.advance(1 / 30, 1000 / 30);
    if (s.gateReport().open) { tOpen = t; break; }
  }
  const tx = gd.x - gd.nx * 45, tz = gd.z - gd.nz * 45;
  const ids = b.units.filter((u) => /juthungi-warband/.test(u.typeId) && u.alive > 40).map((u) => u.id);
  // Run 30 s past the opening; in the "ordered" arm, keep the order live.
  for (let t = tOpen; t <= tOpen + AFTER; t += 1) {
    if (ARM === 'ordered') for (const id of ids) {
      ctx.events.emit('orderIssued', { unitIds: [id], kind: 'move', x: tx, z: tz, facing: 0, running: true });
    }
    while (g.simTime() < t - 1e-6) g.engine.advance(1 / 30, 1000 / 30);
  }
  const p = b.pool;
  const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction ?? 0;
  let inside = 0;
  for (let i = 0; i < p.count; i++) {
    const st = p.state[i];
    if (st === 10 || st === 11 || p.faction[i] === defender) continue;
    const along = (p.x[i] - gd.x) * gd.nx + (p.z[i] - gd.z) * gd.nz;
    if (along < -14 && b.elevated[i] === 0) inside++;
  }
  // Look at the arch from inside the city, back down the carriageway toward the field.
  g.setCamera(gd.x, gd.z + 30, 0.045, Math.PI);
  return { tOpen, t: +g.simTime().toFixed(0), inside, gd: { x: +gd.x.toFixed(1), z: +gd.z.toFixed(1) } };
}, [ARM, AFTER]);
await page.waitForTimeout(1400);
await page.screenshot({ path: `${OUT}/rome-gate-mouth-${ARM}-t${AFTER}.png` });
console.log(ARM, 'after', AFTER, JSON.stringify(info));
await browser.close();
