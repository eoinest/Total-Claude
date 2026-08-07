#!/usr/bin/env node
/** Who calls `sendToWall`, and with what. One question, one run. */
import { chromium } from 'playwright';
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) ?? '--port=5391').split('=')[1]);
const MAP = (process.argv.find((a) => a.startsWith('--map=')) ?? '--map=').split('=')[1];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&scenario=assault&autoplay=1&quality=low${MAP ? `&map=${MAP}` : ''}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
await page.evaluate(`
window.__as = (() => {
  const g = window.__game, b = g.battle, s = b.siege;
  g.engine.stop();
  const log = [];
  const lastOrder = new Map();
  g.engine.events.on('orderIssued', (o) => {
    for (const id of (o.unitIds ?? [])) lastOrder.set(id, { kind: o.kind, x: o.x, z: o.z, t: g.engine.time.simTime });
  });
  const orig = s.sendToWall.bind(s);
  s.sendToWall = (u, x, z) => {
    log.push({
      t: +g.engine.time.simTime.toFixed(1), id: u.id, f: u.faction,
      ax: +x.toFixed(1), az: +z.toFixed(1),
      order: u.order, tx: +u.targetX.toFixed(1), tz: +u.targetZ.toFixed(1),
      matchesTarget: Math.hypot(x - u.targetX, z - u.targetZ) < 0.01,
      last: lastOrder.get(u.id) ?? null,
    });
    return orig(u, x, z);
  };
  return { log, run: (sec) => g.engine.advance(sec, 166) };
})();
`);
await page.evaluate('window.__as.run(260)');
const log = await page.evaluate('window.__as.log');
console.log(`sendToWall calls: ${log.length}`);
for (const r of log.slice(0, 30)) console.log(JSON.stringify(r));
await browser.close();
