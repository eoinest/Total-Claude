import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5473';
const map = process.env.MAP ?? 'carthage';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.menu .begin', { timeout: 60000 });
await p.click(`.menu [data-map="${map}"]`); await p.waitForTimeout(220);
await p.click('.menu [data-scen="assault"]'); await p.waitForTimeout(220);
await p.click('.menu .begin');
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await p.waitForTimeout(500);
const dep = await p.evaluate(() => !!document.querySelector('.dep-begin'));
const before = await p.evaluate(() => {
  const s = window.__game.battle.siege;
  return { rams: s.ramReport().map(r=>({id:r.id,unitId:r.unitId,crewAlive:r.crewAlive})),
    towers: s.towers.map(t=>({id:t.id,unitId:t.unitId})),
    units: window.__game.battle.units.length };
});
if (dep) { await p.click('.dep-begin'); await p.waitForTimeout(800); }
const after = await p.evaluate(() => {
  const g = window.__game, s = g.battle.siege;
  return { rams: s.ramReport().map(r=>({id:r.id,unitId:r.unitId,crewAlive:r.crewAlive,
      resolves: !!g.battle.unitById(r.unitId)})),
    towers: s.towers.map(t=>({id:t.id,unitId:t.unitId,resolves:!!g.battle.unitById(t.unitId)})),
    units: g.battle.units.length,
    ids: g.battle.units.map(u=>u.id).slice(0,40) };
});
await p.evaluate(() => window.__game.engine.advance(20,166));
const t20 = await p.evaluate(() => {
  const g = window.__game, s = g.battle.siege;
  return s.ramReport().map(r=>({id:r.id,unitId:r.unitId,resolves:!!g.battle.unitById(r.unitId),crewAlive:r.crewAlive}));
});
console.log('deployment plaque present:', dep);
console.log('before dep-begin:', JSON.stringify(before));
console.log('after  dep-begin:', JSON.stringify(after));
console.log('t+20 rams:', JSON.stringify(t20));
console.log('errors:', errs.slice(0,3));
await b.close();
