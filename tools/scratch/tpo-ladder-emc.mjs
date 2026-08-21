/**
 * A ladder party told to storm, by hand, while its ladders are still standing empty.
 *
 * The old report: *"every machine crew — ram, tower party, ladder party — is offered 'Storm
 * the wall here', the order is emitted, and `Siege.escalade` discards it at `crewsAMachine`."*
 * This is that, from the player's seat.
 */
import { argsOf, boot, shot, dump, fast, hover, selectHard, wallPixel, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const LABEL = A.get('label') ?? 'before';
const OUT = path.join(ROOT, 'screenshots/tower-party', LABEL);
const T = Number(A.get('t') ?? 60);
const log = [];
const say = (...a) => { const s = a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); log.push(s); };

const { browser, page, errs, cerrs } = await boot({
  port: Number(A.get('port') ?? 5613), map: 'carthage', out: OUT, label: `${LABEL}-ladder` });
await installDiag(page);
await page.evaluate(() => {
  const txt = (s) => { const e = document.querySelector(s); return e && e.style.display !== 'none' ? (e.textContent ?? '') : ''; };
  window.__cur2 = () => { const c = window.__ctl(); return {
    cur: document.body.dataset.cur ?? '', siegecur: document.body.dataset.siegecur ?? '',
    dragHint: txt('.drag-hint'), siegeHint: txt('.siege-hint'),
    wallX: c ? +c.wallX.toFixed(2) : null, wallZ: c ? +c.wallZ.toFixed(2) : null }; };
  window.__ask = (id, x, z) => { const s = window.__siege(); return {
    escaladeOfferAt: s.escaladeOfferAt(id, x, z),
    crewStatus: s.crewStatusOf ? s.crewStatusOf(id) : 'n/a',
    machineOrderAt: s.machineOrderAt(id, x, z),
    wallState: s.unitWallState(id), owns: s.ownsUnit(id) }; };
  window.__ladders = () => (window.__siege().ladders ?? []).map((l, i) =>
    ({ i, unitId: l.unitId, station: l.station, boarders: l.boarders.slice(), crossed: l.crossed }));
  window.__tape = [];
  window.__game.engine.events.on('orderIssued', (p) => window.__tape.push(JSON.parse(JSON.stringify(p ?? {}))));
  window.__mark = () => window.__tape.length;
  window.__since = (n, id) => window.__tape.slice(n).filter((e) => (e.unitIds ?? []).includes(id));
});
await page.mouse.move(800, 720); await page.waitForTimeout(200);
const bays = await page.evaluate(() => window.__bays());
await page.click('.dep-begin'); await page.waitForTimeout(700);
await fast(page, T);

const ladders = await page.evaluate(() => window.__ladders());
say(`t+${T} ladders:`, ladders);
const owners = [...new Set(ladders.map((l) => l.unitId))];
const units = await page.evaluate((ids) => ids.map((i) => window.__u(i)), owners);
say('their parties:', units);
const party = units.find((u) => u && u.alive > 5 && !u.destroyed);
const res = {};
if (!party) { say('NO LIVING LADDER PARTY'); }
else {
  const bayNear = (x, z) => bays.filter((b) => b.garr)
    .reduce((best, b) => (Math.hypot(b.cx - x, b.cz - z) < Math.hypot(best.cx - x, best.cz - z) ? b : best));
  const pb = bayNear(party.x, party.z);
  say(`party ${party.id} (${party.type}, ${party.alive} men) stands off bay ${pb.i}`);
  const s = await selectHard(page, party.id, { zoom: 0.5 });
  say('select:', s.ok ? `OK (${s.easy ? 'first click' : `hunted ${s.answering}/${s.probes} px`})` : `FAILED ${s.why}`);
  const wp = await wallPixel(page, pb, { side: 1, zoom: 0.62 });
  say(`bay ${pb.i}: ${wp.hit}/${wp.tried} pixels read as a wall order`);
  if (s.ok && wp.p) {
    await hover(page, wp.p);
    const h = await page.evaluate(() => window.__cur2());
    say('HOVER  ', { cur: h.cur, siegecur: h.siegecur, drag: h.dragHint, siege: h.siegeHint });
    say('HOVER  sim says:', await page.evaluate(([i, x, z]) => window.__ask(i, x, z), [party.id, h.wallX, h.wallZ]));
    await shot(page, OUT, `${LABEL}-L1-hover`);
    const mark = await page.evaluate(() => window.__mark());
    await page.mouse.move(wp.p.x, wp.p.y); await page.waitForTimeout(60);
    await page.mouse.down({ button: 'right' }); await page.waitForTimeout(420);
    const held = await page.evaluate(() => window.__cur2());
    say('HELD   ', { cur: held.cur, siegecur: held.siegecur, drag: held.dragHint, siege: held.siegeHint });
    await shot(page, OUT, `${LABEL}-L2-held`);
    await page.mouse.up({ button: 'right' }); await page.waitForTimeout(220);
    say('CLICK  order:', await page.evaluate(([n, i]) => window.__since(n, i), [mark, party.id]));
    const w0 = await page.evaluate((i) => window.__wallState(i), party.id);
    const l0 = await page.evaluate(() => window.__ladders());
    await fast(page, 150);
    const w1 = await page.evaluate((i) => window.__wallState(i), party.id);
    const u1 = await page.evaluate((i) => window.__u(i), party.id);
    say('party wall state at the click:', w0);
    say('party wall state 150 s later :', w1);
    say('party 150 s later            :', u1);
    say('ladders at the click / after :', l0.map((l) => l.crossed), (await page.evaluate(() => window.__ladders())).map((l) => l.crossed));
    Object.assign(res, { party: party.id, bay: pb.i, hover: h, held, w0, w1, u1 });
    await shot(page, OUT, `${LABEL}-L3-after`);
  }
}
say(`\npageerrors: ${errs.length}  consoleerrors: ${cerrs.length}`);
await dump(OUT, `${LABEL}-ladder-log`, { log, ...res, errs, cerrs });
await browser.close();
