/**
 * CAN ROME BE HELD AT ALL? — the best defence the menu will let me build.
 *
 * "Victory condition A never fires because the garrison is too strong" is the standing
 * explanation. From the chair the opposite looks true: the storm never *holds* anything, and
 * the city falls to sixty men who have broken. This tests the explanation directly by making
 * the garrison as strong as the game permits and seeing whether that changes anything.
 *
 * The deployment offers 12 of 20 units and 8,926 men of unused pool, so a player who wants to
 * survive has an obvious first move: spend it. This presses ADD UNITS and the `+` on every row
 * until the game refuses, places nothing by hand (the auto-placement is the game's own), and
 * runs it to the verdict against the shipped 12-unit arm on the same seed.
 */
import { argsOf, boot, ledger, shot, dump, ff, ended, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const SEED = Number(A.get('seed') ?? 4265438264);
const PORT = Number(A.get('port') ?? 5911);
const TILL = Number(A.get('till') ?? 900);
const OUT = path.join(ROOT, 'screenshots/judge/tryhard');
const L = ledger('can Rome be held?');

let browser, page;
try {
  const r = await boot({ port: PORT, map: 'campus-martius', scenario: 'assault', tier: 'ultra',
    out: OUT, label: 'th', seed: SEED });
  ({ browser, page } = r);
  await page.mouse.move(800, 780); await page.waitForTimeout(400);
  const HUD = () => page.evaluate(() => window.__HUD());
  const TR = () => page.evaluate(() => window.__TRUTH());

  const before = await HUD();
  L.say(`shipped: ${before.deploy?.tally}  rows ${JSON.stringify(before.deploy?.rows)}`);

  // --- spend the pool, the way a player would: ADD UNITS, then + until refused
  await page.click('.dep-add'); await page.waitForTimeout(400);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.dep-row')).map(r => ({
    unit: r.dataset.unit, count: r.querySelector('.dep-count')?.textContent,
    addOff: r.querySelector('[data-d="1"]')?.disabled })));
  L.say(`palette after ADD UNITS: ${JSON.stringify(rows)}`);
  await shot(page, OUT, 'th-01-palette');

  let added = 0;
  // round-robin so no one type eats the whole allowance, prefer the cohorts that can fight
  const order = ['legio-cohort', 'ballistarii', 'wall-slingers', 'carroballista'];
  for (let pass = 0; pass < 12 && added < 8; pass++) {
    for (const type of order) {
      if (added >= 8) break;
      const ok = await page.evaluate((t) => {
        const row = document.querySelector(`.dep-row[data-unit="${t}"]`);
        if (!row) return 'no row';
        const b = row.querySelector('[data-d="1"]');
        if (!b || b.disabled) return 'refused';
        b.click(); return 'clicked';
      }, type);
      if (ok === 'clicked') { added++; await page.waitForTimeout(160); }
      else if (pass === 0) L.say(`  ${type}: ${ok}`);
    }
  }
  await page.waitForTimeout(400);
  const after = await HUD();
  L.say(`after adding ${added}: ${after.deploy?.tally}  rows ${JSON.stringify(after.deploy?.rows)}`);
  L.say(`the note the panel gives: ${JSON.stringify(after.deploy?.note)}`);
  L.ck('the eight spare unit slots can be spent', added >= 6, '>=6 units added', added);
  const mine = await page.evaluate(() => window.__units(0));
  const men = mine.reduce((a, u) => a + u.alive, 0);
  L.say(`my garrison is now ${mine.length} units / ${men} men (shipped: 12 / 1154)`);
  L.ck('the reinforced garrison is materially bigger', men > 1500, '>1500 men', men);
  await shot(page, OUT, 'th-02-reinforced');

  await page.click('.dep-begin'); await page.waitForTimeout(800);
  let verdict = null, peak = { onWall: 0, holding: 0, inside: 0 };
  for (let t = 0; t < TILL; t += 20) {
    await ff(page, 20);
    const s = await page.evaluate(() => { const tr = window.__TRUTH(), h = window.__HUD();
      return { t: tr.t, o: tr.objective, sg: tr.siege, phase: h.phase, adv: h.adv,
        men: h.blocks.map(b => `${b.name} ${b.men} ${b.loss}`), res: tr.flowResult }; });
    if (s.o) { peak.onWall = Math.max(peak.onWall, s.o.stormOnWall);
      peak.holding = Math.max(peak.holding, s.o.stormHolding);
      peak.inside = Math.max(peak.inside, s.o.stormInside); }
    L.say(`  t+${s.t} [${s.phase}] adv="${s.adv}" onWall=${s.o?.stormOnWall} holding=${s.o?.stormHolding} garr=${s.o?.garrisonOnWall} inside=${s.o?.stormInside} gate=${s.sg?.gate?.blows} ${s.men.join(' | ')}`);
    const e = await ended(page);
    if (e) { verdict = e; L.say(`\n*** RESULT at t+${s.t}: ${JSON.stringify(e)} ***`); break; }
  }
  const tr = await TR();
  L.say(`arbiter: ${JSON.stringify(tr.flowResult)}`);
  L.say(`peaks: ${JSON.stringify(peak)}`);
  await shot(page, OUT, 'th-99-result');
  /*
   * The shipped 12-unit garrison loses on 12 of 12 seeds at t+103-121. The question is whether
   * a garrison half again as large changes that, because if it does not then "the garrison is
   * too strong" cannot be the explanation for condition A never firing.
   */
  L.ck('a reinforced Rome survives past the point the shipped one dies (t+121)',
    (tr.flowResult?.at ?? 0) > 121, '>t+121', Math.round(tr.flowResult?.at ?? 0));
  L.ck('a reinforced Rome holds the city', tr.flowResult?.victor === 0,
    'victor Rome (0)', tr.flowResult?.victor);
  L.ck('a bigger garrison makes the storm hold less parapet', peak.holding === 0,
    'stormHolding still 0 (so garrison size is not what blocks condition A)', peak.holding);
  await dump(OUT, 'tryhard', { seed: SEED, added, men, units: mine.length, peak,
    result: tr.flowResult, rows: L.rows, log: L.log });
} catch (e) { L.ck('ran without throwing', false, 'no throw', String(e).slice(0, 400)); }
finally { if (browser) await browser.close(); }
L.summary();
