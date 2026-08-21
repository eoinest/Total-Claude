import { chromium } from 'playwright';
const PORT = process.argv[2];
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader'] });
let bad = 0;
for (const q of [{ map: '', name: 'campus-martius' }, { map: '&map=carthage', name: 'carthage' }]) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
  p.on('requestfailed', (r) => errs.push('requestfailed: ' + r.url()));
  await p.goto(`http://127.0.0.1:${PORT}/?harness=1&autoplay=1&quality=high&scenario=assault${q.map}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  await p.evaluate(() => window.__game.fastForward(45));
  await p.evaluate(() => window.__game.advance(0.5));
  const st = await p.evaluate(() => ({ t: window.__game.simTime(), men: window.__game.battle.pool.count,
    units: window.__game.battle.units.filter(u => !u.destroyed).length }));
  console.log(`${q.name}: t+${st.t.toFixed(1)}s  ${st.men} men  ${st.units} units  errors ${errs.length}`);
  for (const e of errs) { console.log('   ' + e); bad++; }
  await p.close();
}
await b.close();
process.exit(bad ? 1 : 0);
