/**
 * RECON — boot each map through the real menu, and check the rig before trusting it.
 *
 * Nothing here plays. It answers: does the front door work, does the setup sheet take a seed,
 * does the game reach `ready`, how long does that take, what does the HUD say at t+0, what
 * does the sim say at t+0, and what is the real-time frame rate with the rAF loop running.
 */
import { argsOf, boot, ledger, shot, dump, ff, realtime, ended, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/judge');
const PORT = Number(A.get('port') ?? 5911);
const MAPS = (A.get('maps') ?? 'campus-martius,carthage,pydna').split(',');
const SEED = Number(A.get('seed') ?? 4265438264);
const L = ledger('recon');

for (const map of MAPS) {
  const scen = map === 'pydna' ? 'field' : 'assault';
  L.say(`\n================ ${map} / ${scen} / seed ${SEED} ================`);
  let browser;
  try {
    const r = await boot({ port: PORT, map, scenario: scen, tier: 'ultra', out: OUT,
      label: `rc-${map}`, seed: SEED,
      onSetup: (p) => p.screenshot({ path: path.join(OUT, `rc-${map}-0-menu.png`) }) });
    browser = r.browser;
    const { page, errs, cerrs, bootS } = r;
    L.ck(`${map}: reached ready`, true, 'ready', 'ready');
    L.ck(`${map}: boot under 90 s`, bootS < 90, '<90 s', `${bootS} s`);
    await page.mouse.move(800, 700); await page.waitForTimeout(400);

    const cfg = await page.evaluate(() => { const b = window.__game.battle;
      return { seed: b.seed ?? b.cfg?.seed ?? null, map: b.cfg?.map ?? null, scen: b.cfg?.scenario ?? null,
        diff: b.cfg?.difficulty ?? null, q: b.cfg?.quality ?? null }; });
    L.say(`  config as the sim sees it: ${JSON.stringify(cfg)}`);
    L.ck(`${map}: the seed I typed is the seed that runs`, String(cfg.seed) === String(SEED), SEED, cfg.seed);
    L.ck(`${map}: the scenario I clicked is the scenario that runs`, cfg.scen === scen, scen, cfg.scen);

    const hud0 = await page.evaluate(() => window.__HUD());
    const tr0 = await page.evaluate(() => window.__TRUTH());
    await dump(OUT, `rc-${map}-hud0`, hud0);
    await dump(OUT, `rc-${map}-truth0`, tr0);
    L.say(`  t+0 HUD phase=${JSON.stringify(hud0.phase)} deploy=${hud0.deploy ? 'yes' : 'no'}`);
    L.say(`  t+0 blocks: ${JSON.stringify(hud0.blocks)}`);
    L.say(`  t+0 strength: ${JSON.stringify(tr0.strength)}  per-faction ${JSON.stringify(tr0.per)}`);
    L.say(`  t+0 feed: ${JSON.stringify(hud0.feed)}`);
    if (hud0.deploy) L.say(`  t+0 deployment: ${JSON.stringify(hud0.deploy)}`);
    await shot(page, OUT, `rc-${map}-1-t0`);

    // real-time frame rate, before anything is ordered, with the whole army on screen
    const fps0 = await realtime(page, 3000);
    L.say(`  real-time at t+0: ${JSON.stringify(fps0)}`);
    L.ck(`${map}: playable frame rate at t+0 (>=30 fps)`, fps0.fps >= 30, '>=30 fps', `${fps0.fps} fps`);

    // begin, if there is a deployment phase
    if (await page.$('.dep-begin')) {
      await page.click('.dep-begin'); await page.waitForTimeout(700);
      L.say('  pressed BEGIN on the deployment panel');
    }
    const fps1 = await realtime(page, 4000);
    L.say(`  real-time once the battle is live: ${JSON.stringify(fps1)}`);
    L.ck(`${map}: playable frame rate in battle (>=30 fps)`, fps1.fps >= 30, '>=30 fps', `${fps1.fps} fps`);

    const t = await ff(page, 20);
    const hud1 = await page.evaluate(() => window.__HUD());
    const tr1 = await page.evaluate(() => window.__TRUTH());
    L.say(`  at ${JSON.stringify(t)}: phase=${JSON.stringify(hud1.phase)} adv=${JSON.stringify(hud1.adv)}`);
    L.say(`  blocks: ${JSON.stringify(hud1.blocks)}`);
    L.say(`  feed: ${JSON.stringify(hud1.feed.map(f => f.head))}`);
    L.say(`  siege at t+20: ${JSON.stringify(tr1.siege && { gate: tr1.siege.gate, breach: tr1.siege.breach, stats: tr1.siege.stats })}`);
    await dump(OUT, `rc-${map}-hud20`, hud1);
    await dump(OUT, `rc-${map}-truth20`, tr1);
    await shot(page, OUT, `rc-${map}-2-t20`);

    L.ck(`${map}: no page errors`, errs.length === 0, 0, errs.length);
    L.ck(`${map}: no console errors`, cerrs.length === 0, 0, cerrs.length);
    if (cerrs.length) L.say(`  console: ${JSON.stringify(cerrs.slice(0, 6))}`);
    if (errs.length) L.say(`  pageerrors: ${JSON.stringify(errs.slice(0, 6))}`);
  } catch (e) {
    L.ck(`${map}: booted at all`, false, 'boot', String(e).slice(0, 300));
  } finally { if (browser) await browser.close(); }
}
const bad = L.summary();
await dump(OUT, 'recon-log', { rows: L.rows, log: L.log });
process.exit(bad ? 1 : 0);
