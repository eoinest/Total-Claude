/** Does the cursor tell a player which opening the ram has resolved to? Real mouse. */
import { argsOf, boot, shot, dump, fast, hover, aim, selectHard, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/gate-postern');
const log = []; let page, browser, errs, cerrs;
const say = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); log.push(s); };

({ browser, page, errs, cerrs } = await boot({ port: Number(A.get('port') ?? 5411), map: 'carthage', out: OUT, label: 'postern' }));
await installDiag(page);
await page.evaluate(() => {
  const city = window.__game.engine.context.get('city');
  window.__gates = () => city.getGates().map(g => ({ id: g.id, x: g.x, z: g.z, open: g.open, facing: g.facing }));
});
const gs = await page.evaluate(() => window.__gates());
say('gates at deployment:', JSON.stringify(gs.map(g => `${g.id}:${g.open ? 'open' : 'SHUT'}`)));
const byrsa = gs.find(g => g.id === 'porta-byrsae');
const posterns = gs.filter(g => /postern/.test(g.id))
  .map(g => ({ ...g, d: Math.hypot(g.x - byrsa.x, g.z - byrsa.z) })).sort((a, b) => a.d - b.d);
say('nearest posterns to porta-byrsae:', JSON.stringify(posterns.slice(0, 3).map(g => `${g.id} ${g.d.toFixed(1)}m`)));
await page.click('.dep-begin'); await page.waitForTimeout(700);
await fast(page, 3);

const units = await page.evaluate(() => window.__units(0));
const ram = units.find(u => /ram-crew/.test(u.type) && u.alive > 0);
const s = await selectHard(page, ram.id, { zoom: 0.5 });
say(`select ram #${ram.id}:`, s.ok ? 'OK' : `FAILED ${s.why}`);
if (!s.ok) { await browser.close(); process.exit(1); }

// Walk the click west along the wall and read what the cursor says it will break.
const p0 = posterns[0];
const ux = (p0.x - byrsa.x) / p0.d, uz = (p0.z - byrsa.z) / p0.d;   // toward the nearest postern
say(`\noffset  clickXZ            cursor hint`);
for (const off of [0, 10, 20, 24, 26, 28, 32, 40, 52]) {
  const cx = byrsa.x + ux * off, cz = byrsa.z + uz * off;
  const pt = await aim(page, cx, 20, cz - 4, { zoom: 0.6 });
  if (!pt) { say(`${String(off).padStart(5)}m  (would not frame)`); continue; }
  const h = await hover(page, pt, 4);
  const hint = await page.evaluate(() => { const e = document.querySelector('.siege-hint');
    return e && e.style.display !== 'none' ? e.textContent : '(none)'; });
  say(`${String(off).padStart(5)}m  (${cx.toFixed(0).padStart(5)},${cz.toFixed(0).padStart(4)})  ${JSON.stringify(hint)}  cursor=${h.cursor}`);
}
await shot(page, OUT, 'postern-hint');
say('\npageerrors:', errs.length);
await dump(OUT, 'postern-log', { log, errs, cerrs });
await browser.close();
