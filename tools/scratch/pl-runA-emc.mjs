/**
 * RUN A — storm Carthage as Rome. Menu to verdict, every order a real click.
 *
 * Asserts, now, and the one thing it asserts hardest is that a battle finished: see
 * `pl-lib-emc.mjs` on why nine invented selectors meant no run in this directory had ever
 * reached a verdict. A narrative log is not a result.
 */
import { argsOf, boot, shot, dump, fast, hover, rightClick, rightDrag, leftClick, cam, proj, aim,
  selectHard, wallPixel, installDiag, ledger, mustEnd, ended, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const L_ = 'runA';
const L = ledger('run A — the storm of Carthage');
const log = L.log; let page, browser, errs, cerrs;
const say = L.say;
const flush = () => dump(OUT, `${L_}-log`, { log, errs, cerrs, rows: L.rows });
const T = async () => page.evaluate(() => +window.__game.simTime().toFixed(1));
const step = async (n, w) => { say(`\n=== ${n}  t+${await T()}s  ${w}`); await flush(); };
const rep = () => page.evaluate(() => window.__reports());
const brief = (r) => `R=${r.strength[0]} C=${r.strength[2]} gateHp=${r.engines.gateHp.toFixed(2)} blows=${r.engines.ramBlows} ladders=${r.engines.laddersCrossed} towers=${r.towers.map(t => `${t.state}:${t.crossed}`).join(',')}`;

({ browser, page, errs, cerrs } = await boot({ port: Number(A.get('port') ?? 5431), map: 'carthage', out: OUT, label: L_ }));
await installDiag(page);
await page.mouse.move(800, 700); await page.waitForTimeout(300);
let bays;
try {
bays = await page.evaluate(() => window.__bays());
await step('1', 'deployment: begin');
await page.click('.dep-begin'); await page.waitForTimeout(700);
await fast(page, 3);

// --- 2. the tower, sent where I want it
await step('2', 'select a tower party and send its tower to bay 27');
let s = await selectHard(page, 14, { zoom: 0.5 });
say('select tower party 14:', s.ok ? `OK (${s.easy ? 'first click' : `hunted, ${s.answering}/${s.probes} pixels answer`})` : `FAILED ${s.why} ${s.answering}/${s.probes}`);
if (s.ok) {
  const b = bays.find(x => x.i === 27);
  const wp = await wallPixel(page, b, { side: 1, zoom: 0.62 });
  say(`bay 27: ${wp.hit}/${wp.tried} probed pixels give a wall order`, wp.p ? `-> clicking ${JSON.stringify(wp.p)}` : '-> NO WALL ORDER AVAILABLE');
  await shot(page, OUT, `${L_}-2a-bay27`);
  if (wp.p) {
    const h = await hover(page, wp.p);
    say('cursor before I commit:', { cursor: h.cursor, hovered: h.hovered });
    const d = await rightClick(page, wp.p, { hold: 450 });
    say('hint while held:', JSON.stringify(d.hint), 'cursor', d.cursor);
    await shot(page, OUT, `${L_}-2b-held`);
    await page.waitForTimeout(400);
    const r = await rep();
    say('tower 0 after the order:', { x: +r.towers[0].x.toFixed(1), z: +r.towers[0].z.toFixed(1), st: r.towers[0].state, walkY: r.towers[0].walkY });
  }
}
await flush();

// --- 3. the ram
await step('3', 'select the ram crew and send it at a gate I choose');
s = await selectHard(page, 22, { zoom: 0.5 });
say('select ram crew 22:', s.ok ? `OK (${s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`})` : `FAILED ${s.why}`);
if (s.ok) {
  const g = (await rep()).gates.find(x => x.id === 'porta-uticensis');
  const pg = await aim(page, g.x, 20, g.z - 4, { zoom: 0.6 });
  if (pg) {
    const d = await rightClick(page, pg, { hold: 400 });
    say('right-click the far gate; hint =', JSON.stringify(d.hint), 'cursor', d.cursor);
  } else say('the far gate would not frame');
  await page.waitForTimeout(300);
  say('ram:', (await rep()).ram.map(r => ({ st: r.state, x: +r.x.toFixed(1), z: +r.z.toFixed(1), dist: r.distFromTarget })));
}
await flush();

// --- 4. a line cohort ordered to storm
await step('4', 'a plain line cohort ordered onto the wall');
s = await selectHard(page, 29, { zoom: 0.5 });
say('select cohort 29:', s.ok ? `OK (${s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`})` : `FAILED ${s.why}`);
const b33 = bays.find(x => x.i === 33);
if (s.ok) {
  const wp = await wallPixel(page, b33, { side: 1, zoom: 0.62 });
  say(`bay 33: ${wp.hit}/${wp.tried} pixels answer`);
  if (wp.p) {
    const d = await rightClick(page, wp.p, { hold: 450 });
    say('hint:', JSON.stringify(d.hint), 'cursor', d.cursor);
    await shot(page, OUT, `${L_}-4a-storm`);
    await page.waitForTimeout(300);
    say('wall state of 29:', await page.evaluate(() => window.__wallState(29)));
  }
}
await flush();

// --- 5. run the assault, watching for anyone who gets up
await step('5', 'let the storm run');
let r = await rep();
say(`t+${r.t}  ${brief(r)}`);
let onWallId = -1;
for (let k = 0; k < 20; k++) {
  await fast(page, 20);
  r = await rep();
  const up = await page.evaluate(() => window.__units(0).filter(u => u.elevated > 3).map(u => ({ id: u.id, t: u.type, e: u.elevated, a: u.alive })));
  say(`t+${r.t}  ${brief(r)}  up=${JSON.stringify(up)}`);
  if (up.length && onWallId < 0) onWallId = up.sort((a, b) => b.e - a.e)[0].id;
  if (k % 5 === 4) await shot(page, OUT, `${L_}-5-${Math.round(r.t)}s`);
  // `.rs-panel`, via `ended` — the only selector in this directory that matches anything.
  const done = await ended(page);
  if (done) { say(`a result screen appeared: ${done.verdict} — ${done.reason}`); break; }
  if (onWallId >= 0 && k >= 9) break;
}
await flush();

// --- 6. take a stretch: traverse, then fight for it
await step('6', `men on the wall: unit ${onWallId}`);
if (onWallId >= 0) {
  s = await selectHard(page, onWallId, { zoom: 0.55 });
  say('select the men on the wall:', s.ok ? `OK (${s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`})` : `FAILED ${s.why}`);
  await shot(page, OUT, `${L_}-6a-onwall`);
  if (s.ok) {
    const st = await page.evaluate((i) => window.__wallState(i), onWallId);
    say('wall state:', st);
    const b = bays.find(x => x.i === 36);
    const wp = await wallPixel(page, b, { side: 1, zoom: 0.62 });
    say(`traverse to bay 36: ${wp.hit}/${wp.tried} pixels answer`);
    if (wp.p) {
      const d = await rightClick(page, wp.p, { hold: 450 });
      say('hint:', JSON.stringify(d.hint), 'cursor', d.cursor);
      await fast(page, 40);
      say('after 40 s:', await page.evaluate((i) => window.__wallState(i), onWallId), await page.evaluate((i) => window.__u(i), onWallId));
      await shot(page, OUT, `${L_}-6b-traversed`);
    }
    // fight for the wall
    await step('7', 'attack the men standing on the wall');
    const foe = (await page.evaluate(() => window.__units(2))).filter(u => u.elevated > 5 && u.alive > 5);
    say('garrison units still on the wall:', foe.map(u => ({ id: u.id, t: u.type, a: u.alive, x: u.x })));
    if (foe.length) {
      const f = foe.sort((a, b) => Math.abs(a.x - 37) - Math.abs(b.x - 37))[0];
      const fp = await aim(page, f.x, f.meanY + 0.9, f.z, { zoom: 0.55 });
      if (fp) {
        const h = await hover(page, fp);
        say('hovering the enemy on the parapet:', { cursor: h.cursor, hovered: h.hovered, want: f.id });
        const d = await rightClick(page, fp, { hold: 450 });
        say('hint:', JSON.stringify(d.hint), 'cursor', d.cursor);
        await shot(page, OUT, `${L_}-7a-attack`);
        await fast(page, 40);
        say('40 s later, foe:', await page.evaluate((i) => window.__u(i), f.id), 'mine:', await page.evaluate((i) => window.__u(i), onWallId));
        await shot(page, OUT, `${L_}-7b-fight`);
      }
    }
    // down into the city
    await step('8', 'take the men down into the city');
    const b31 = bays.find(x => x.i === 31);
    const inX = b31.cx - b31.nx * 30, inZ = b31.cz - b31.nz * 30;
    const gy = await page.evaluate(([x, z]) => window.__game.battle.groundAt(x, z), [inX, inZ]);
    const pin = await aim(page, inX, gy, inZ, { zoom: 0.6 });
    if (pin) {
      const d = await rightClick(page, pin, { hold: 450 });
      say('hint over the street:', JSON.stringify(d.hint), 'cursor', d.cursor);
      await fast(page, 50);
      say('after 50 s:', await page.evaluate((i) => window.__u(i), onWallId), await page.evaluate((i) => window.__wallState(i), onWallId));
      await shot(page, OUT, `${L_}-8-descend`);
    } else say('could not frame a street inside the city');
  }
} else say('nobody of mine ever got onto the wall');
await flush();

// --- 9. to the verdict
await step('9', 'run to the verdict');
/*
 * `mustEnd` rather than a loop over invented class names.
 *
 * This loop used to poll `.endcard, .result, .verdict, .battle-result, .result-sheet,
 * .outcome`, none of which the product renders, and then fell through to a class-name sweep
 * that printed whatever it found. So it always finished, always logged, and had never once
 * seen a battle end. The one selector is `.rs-panel` and it lives in `pl-lib` now.
 */
const fin = await mustEnd(page, L, { until: 1600, step: 25, label: 'the storm of Carthage' });
r = await rep();
say(`t+${r.t}  ${brief(r)}`);
say('final HUD:', await page.evaluate(() => window.__hud()));
await shot(page, OUT, `${L_}-9-end`);
if (fin.end) say('result text:', await page.evaluate(() => window.__hud().banner));
} catch (e) { L.ck('the session ran without throwing', false, 'no throw', String(e).slice(0, 400)); try { await shot(page, OUT, `${L_}-crash`); } catch {} }
L.ck('no page errors', errs.length === 0, 0, errs.length);
await flush();
await browser.close();
process.exitCode = L.summary() > 0 ? 1 : 0;
