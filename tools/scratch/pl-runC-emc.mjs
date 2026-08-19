/** RUN C — storm Carthage properly: every cohort committed, by hand, to the verdict. */
import { argsOf, boot, shot, dump, fast, hover, rightClick, cam, aim, wallPixel, installDiag, selectHard, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const L = 'runC';
const log = [];
const say = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); log.push(s); };
const { browser, page, errs } = await boot({ port: Number(A.get('port') ?? 5431), map: 'carthage', out: OUT, label: L });
await installDiag(page);
const flush = () => dump(OUT, `${L}-log`, { log, errs });
await page.mouse.move(800, 700); await page.waitForTimeout(300);
say('deployment help line:', await page.evaluate(() => document.querySelector('.dep-help')?.textContent.replace(/\s+/g, ' ')));
await page.click('.dep-add'); await page.waitForTimeout(300);
say('ADD UNITS palette:', await page.evaluate(() => Array.from(document.querySelectorAll('.dep-row')).map(r => `${r.dataset.unit}=${r.querySelector('.dep-count').textContent}${r.querySelector('[data-d="1"]').disabled ? '[+off]' : '[+on]'}`)));
await shot(page, OUT, `${L}-0-palette`);
await page.click('.dep-add'); await page.waitForTimeout(200);
await page.click('.dep-begin'); await page.waitForTimeout(500);
await fast(page, 4);
const bays = await page.evaluate(() => window.__bays());
const cards = await page.evaluate(() => Array.from(document.querySelectorAll('.cardbar .card:not(.mini)')).map((c) => {
  const r = c.getBoundingClientRect();
  return { name: c.querySelector('.card-name')?.textContent, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}));
say('cards:', cards.map(c => c.name).join(' | '));
const byName = (re) => cards.filter(c => re.test(c.name ?? ''));
const pickCard = async (c) => { await page.mouse.click(c.x, c.y); await page.waitForTimeout(220); return (await page.evaluate(() => window.__cur().sel))[0]; };

// The ladder banks stand where the escalade parties were deployed.
const esc = (await page.evaluate(() => window.__units(0))).filter(u => u.type === 'legio-escalade');
say('ladder parties at x', esc.map(u => u.x));
const nearestBay = (x) => bays.filter(b => b.garr).sort((p, q) => Math.abs(p.cx - x) - Math.abs(q.cx - x))[0];
const targets = esc.map(u => nearestBay(u.x));
say('bays with a ladder bank against them:', targets.map(b => `${b.i}@x${b.cx}`));

try {
// Commit all six cohorts, two per ladder bank on the near pair.
const cohCards = byName(/Legionary Cohort/);
say(`\n=== committing ${cohCards.length} cohorts`);
for (let i = 0; i < cohCards.length; i++) {
  const id = await pickCard(cohCards[i]);
  const b = targets[i % targets.length];
  const wp = await wallPixel(page, b, { side: 1, zoom: 0.62 });
  if (!wp.p) { say(`  cohort ${id} -> bay ${b.i}: no pixel offers a wall order`); continue; }
  const d = await rightClick(page, wp.p, { hold: 300 });
  say(`  cohort ${id} -> bay ${b.i} (x ${b.cx}): hint ${JSON.stringify(d.hint)} cursor ${d.cursor}`);
}
await shot(page, OUT, `${L}-1-committed`);
await flush();

say('\n=== the storm');
let up = [];
for (let k = 0; k < 40; k++) {
  await fast(page, 25);
  const r = await page.evaluate(() => window.__reports());
  up = await page.evaluate(() => window.__units(0).filter(u => u.elevated > 2).map(u => ({ id: u.id, t: u.type.replace('legio-', ''), e: u.elevated, a: u.alive })));
  const foeUp = await page.evaluate(() => window.__units(2).reduce((n, u) => n + u.elevated, 0));
  say(`t+${r.t}  R=${r.strength[0]} C=${r.strength[2]}  gate=${r.engines.gateHp.toFixed(2)} breachBays=${r.breach.bays.length} ladders=${r.engines.laddersCrossed} towers=${r.towers.map(t => t.crossed).join('/')}  mineUp=${JSON.stringify(up)} foeUp=${foeUp}`);
  if (k === 8 || k === 20) await shot(page, OUT, `${L}-2-${Math.round(r.t)}s`);
  const done = await page.evaluate(() => { const e = document.querySelector('.results.open, .endcard, .rs-verdict'); return e ? e.textContent.replace(/\s+/g, ' ').slice(0, 300) : null; });
  if (done) { say(`RESULT at t+${r.t}: ${done}`); break; }
  if (k > 6 && up.length >= 2 && k % 8 === 0) {
    // take a stretch with whoever is up, and fight for it
    const m = up.sort((a, b) => b.e - a.e)[0];
    const s = await selectHard(page, m.id, { zoom: 0.6 });
    if (s.ok) {
      const foe = (await page.evaluate(() => window.__units(2))).filter(u => u.elevated > 5).sort((a, b) => Math.abs(a.x - 0) - Math.abs(b.x - 0))[0];
      if (foe) {
        const fp = await aim(page, foe.x, foe.meanY + 0.9, foe.z, { zoom: 0.6 });
        if (fp) { const d = await rightClick(page, fp, { hold: 300 }); say(`  ordered ${m.id} onto ${foe.id}: ${JSON.stringify(d.hint)} / ${d.cursor}`); }
      }
    } else say(`  could not select my own men on the wall (${m.id}): ${s.why}`);
  }
  await flush();
}
await page.waitForTimeout(600);
await shot(page, OUT, `${L}-3-end`);
say('final:', await page.evaluate(() => window.__hud()).then(h => h.top.slice(0, 200)));
say('results element:', await page.evaluate(() => { const e = document.querySelector('.results'); return e ? `${e.className}: ${e.textContent.replace(/\s+/g, ' ').slice(0, 500)}` : 'none'; }));
} catch (e) { say('!! THREW', String(e).slice(0, 300)); }
await flush();
say('errs', errs.length);
await browser.close();
