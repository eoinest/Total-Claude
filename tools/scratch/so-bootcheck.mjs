/**
 * A real boot of both maps through the real menu, with every console message kept.
 *
 * A typecheck is not proof of life: `tsc` cannot see a missing runtime method behind `?.`,
 * an ESM binding error or a temporal dead zone, and three commits were once stacked on a
 * tree that white-screened. So this loads the page, clicks BEGIN BATTLE like a player,
 * waits on `window.__game.ready`, runs the clock, and reports **every** console message and
 * page error rather than only errors — a warning that appears on one map and not the other
 * is the shape of a half-wired integration.
 */
import { chromium } from 'playwright';
const base = `http://127.0.0.1:${process.env.PORT ?? 5473}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
let bad = 0;
for (const map of ['campus-martius', 'carthage']) {
  const p = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errors = [], warns = [], logs = [];
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    const t = m.type();
    if (t === 'error') errors.push(`console.error: ${m.text()}`);
    else if (t === 'warning') warns.push(m.text());
    else logs.push(m.text());
  });
  const t0 = Date.now();
  await p.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.menu .begin', { timeout: 60000 });
  await p.click(`.menu [data-map="${map}"]`); await p.waitForTimeout(220);
  await p.click('.menu [data-scen="assault"]'); await p.waitForTimeout(220);
  await p.click('.menu .begin');
  await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  await p.waitForTimeout(600);
  if (await p.evaluate(() => !!document.querySelector('.dep-begin'))) {
    await p.click('.dep-begin'); await p.waitForTimeout(800);
  }
  // Run the clock: a page that boots and then throws on the first tick is still dead.
  await p.evaluate(() => window.__game.engine.advance(30, 166));
  const st = await p.evaluate(() => {
    const g = window.__game, s = g.battle.siege;
    return { ready: g.ready, units: g.battle.units.length,
      men: g.battle.pool.count, sim: +g.engine.context.time.simTime.toFixed(1),
      draws: g.engine.renderer.info.render.calls,
      hint: !!document.querySelector('.siege-hint'),
      verbs: ['machineOrderAt', 'machineDestinationOf', 'requestMachineOrder', 'escaladeOfferAt']
        .filter((k) => typeof s[k] !== 'function'),
      gates: s.gateReport().gates.filter((x) => !x.id.startsWith('postern')).map((x) => x.id),
      towers: s.towerReport().length };
  });
  const ok = st.ready && errors.length === 0 && st.verbs.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${map.padEnd(15)} ready=${st.ready} in ${((Date.now()-t0)/1000).toFixed(1)}s  `
    + `${st.units} units / ${st.men} men, sim t+${st.sim}, ${st.draws} draws`);
  console.log(`        gates [${st.gates.join(', ')}], ${st.towers} towers, .siege-hint present=${st.hint}`
    + `, missing verbs [${st.verbs.join(',')}]`);
  console.log(`        pageerror/console.error: ${errors.length ? errors.slice(0,5).join(' | ') : 'none'}`);
  console.log(`        console.warning: ${warns.length ? warns.slice(0,4).join(' | ') : 'none'} (${warns.length} total)`);
  await p.close();
}
console.log(bad === 0 ? '\nBOTH MAPS BOOT CLEAN' : `\n${bad} MAP(S) FAILED`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
