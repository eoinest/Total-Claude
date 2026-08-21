// scratch: does the Aurelian gate actually get blown, and by when? Video-studio pass.
import { chromium } from 'playwright';

const PORT = process.argv[2] ?? '5209';
const TOKEN = process.argv[3] ?? '';
const base = `http://127.0.0.1:${PORT}`;
const b = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
const url = `${base}/?harness=1&quality=medium&w=960&h=540&map=campus-martius&scenario=assault&enemy=juthungi`
  + (TOKEN ? `&battle=${TOKEN}` : '');
console.log(url.slice(0, 160));
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
await p.evaluate(() => window.__game.engine.stop());
console.log('boot', JSON.stringify(await p.evaluate(() => {
  const g = window.__game;
  return { units: g.battle.units.length, men: g.battle.pool.count, gate: g.battle.siege.gateReport() };
})).slice(0, 500));
for (const t of [60, 120, 180, 240, 300]) {
  console.log(JSON.stringify(await p.evaluate((tt) => {
    const g = window.__game;
    while (g.simTime() < tt) g.engine.advance(1 / 30, 1000 / 30, { render: false });
    const gr = g.battle.siege.gateReport();
    const er = g.battle.siege.engineReport();
    return {
      t: +g.simTime().toFixed(1), blows: gr.blows, open: gr.open, shut: gr.shutAtStart,
      breached: gr.breached, ramBlows: er.ramBlows, ladders: er.ladders, crossed: er.laddersCrossed,
      gates: gr.gates.map((x) => `${x.id}:${x.blows}${x.open ? '/open' : ''}`).join(' '),
    };
  }, t)));
}
await b.close();
