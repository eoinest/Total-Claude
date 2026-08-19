import { chromium } from 'playwright';
const PORT = process.argv.includes('--port') ? 0 : 5473;
const base = `http://127.0.0.1:${PORT || 5473}`;
const map = process.env.MAP ?? 'carthage';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
await p.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.menu .begin', { timeout: 60000 });
await p.click(`.menu [data-map="${map}"]`); await p.waitForTimeout(220);
await p.click('.menu [data-scen="assault"]'); await p.waitForTimeout(220);
await p.click('.menu .begin');
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await p.waitForTimeout(600);
if (await p.evaluate(() => !!document.querySelector('.dep-begin'))) { await p.click('.dep-begin'); await p.waitForTimeout(700); }
const info = await p.evaluate(() => {
  const g = window.__game;
  const s = g.battle.siege;
  return {
    ready: g.ready, units: g.battle.units.length,
    hasSiegeHint: !!document.querySelector('.siege-hint'),
    hasMachineOrderAt: typeof s.machineOrderAt === 'function',
    rams: s.ramReport().map(r => ({ id: r.id, kind: r.kind, gateId: r.gateId, state: r.state, x: Math.round(r.x), z: Math.round(r.z) })),
    gates: s.gateReport().gates.map(x => `${x.id} open=${x.open}`),
    towers: s.towerReport().length,
  };
});
console.log(JSON.stringify(info, null, 1));
console.log('errors:', errs.slice(0,5));
await b.close();
