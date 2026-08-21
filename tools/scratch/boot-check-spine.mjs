import { chromium } from 'playwright';
const PORT = process.argv[2];
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
let bad = 0;
for (const map of ['campus-martius', 'carthage']) {
  for (const scenario of ['assault', 'field']) {
    const tok = Buffer.from(JSON.stringify({ map, scenario })).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = []; const cons = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    p.on('console', (m) => { if (m.type() === 'error') cons.push(m.text()); });
    await p.goto(`http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=high&scenario=${scenario}&battle=${tok}`,
      { waitUntil: 'domcontentloaded', timeout: 120000 });
    await p.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });
    await p.evaluate(() => window.__game.fastForward(20));
    const n = await p.evaluate(() => {
      const s = window.__game.battle.elevation ?? window.__game.battle.siege;
      const w = s ? s.wallReport() : null;
      return { pool: window.__game.battle.pool.count, stations: w ? w.stations : null,
        reachable: w ? `${w.reachable}/${w.runs}` : null };
    });
    console.log(`${map}/${scenario}: pool ${n.pool}, stations ${n.stations}, reachable ${n.reachable}, `
      + `pageerrors ${errs.length}, console errors ${cons.length}`);
    for (const e of errs) console.log('   PAGEERROR ' + e);
    for (const c of cons.slice(0, 5)) console.log('   CONSOLE ' + c);
    bad += errs.length + cons.length;
    await p.close();
  }
}
await b.close();
console.log(bad === 0 ? 'BOOT CLEAN' : `BOOT ${bad} PROBLEM(S)`);
process.exitCode = bad === 0 ? 0 : 1;
