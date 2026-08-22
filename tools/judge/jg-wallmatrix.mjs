/**
 * THE WALL, ORDER BY ORDER — where the game refuses honestly and where it accepts and stalls.
 *
 * A garrison's whole game is moving men along a parapet and down behind a break-in. In one
 * playthrough a right-click on my own curtain 106 m away produced the hint "Along the wall"
 * and 1.1 m of movement in 30 s; in another, one bay further on, it produced the honest
 * refusal "No way along the wall to bay 5 — the walk is broken in between". Those are
 * different behaviours and only one of them is acceptable, so this maps the whole wall:
 *
 *  1. For every one of my wall units, for every garrisonable bay, what does the cursor offer?
 *     Tabulated as: accepted / refused-out-loud / nothing offered.
 *  2. Then it *takes* three accepted orders and watches whether they are carried out.
 *  3. And it asks what a point on my own street inside the wall offers, because a defender
 *     who cannot order a cohort into their own city has no answer to a break-in.
 */
import { argsOf, boot, ledger, shot, dump, ff, aim, hover, rightClick, leftClick,
  selectHard, cam, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const SEED = Number(A.get('seed') ?? 4265438264);
const PORT = Number(A.get('port') ?? 5911);
const MAP = A.get('map') ?? 'campus-martius';
const AT = Number(A.get('at') ?? 40);
const OUT = path.join(ROOT, `screenshots/judge/wall-${MAP}`);
const L = ledger(`the wall, order by order — ${MAP}`);

/** Find a pixel on a bay's walk that the game will read as a wall target, and the hint there. */
async function offerAt(page, b) {
  for (const off of [3, 0, 6, -3, 9, -6, 12]) {
    for (const dy of [0, 0.7, -0.7]) {
      const p = await aim(page, b.cx + b.nx * off, b.walkY + dy, b.cz + b.nz * off, { zoom: 0.6 });
      if (!p) continue;
      const h = await hover(page, p);
      if (h.wallValid || (h.hint && h.hint.length)) return { p, h };
    }
  }
  return { p: null, h: null };
}

let browser, page;
try {
  const r = await boot({ port: PORT, map: MAP, scenario: 'assault', tier: 'ultra',
    out: OUT, label: 'w', seed: SEED });
  ({ browser, page } = r);
  await page.mouse.move(800, 760); await page.waitForTimeout(400);
  const bays = await page.evaluate(() => window.__bays());
  await page.click('.dep-begin'); await page.waitForTimeout(700);
  await ff(page, AT);
  const T = await page.evaluate(() => Math.round(window.__game.simTime() * 10) / 10);
  L.say(`t+${T}`);

  const mine = (await page.evaluate(() => window.__units(0))).filter(u => u.elevated > 10 && u.alive > 20);
  L.say(`my units on the wall: ${JSON.stringify(mine.map(u => ({ id: u.id, t: u.type, n: u.alive, x: u.x, y: u.meanY, up: u.elevated })))}`);
  const garr = bays.filter(b => b.garr);
  L.say(`${garr.length} garrisonable bays: ${JSON.stringify(garr.map(b => `${b.i}@x${Math.round(b.cx)}/y${b.walkY}`))}`);

  // ---------------------------------------------------------------- 1. the matrix
  L.say('\n=== 1. WHAT IS OFFERED, unit x bay ===');
  const matrix = [], accepted = [];
  // Two units, one at each end of my garrison, against every bay — 2 x 32 is already 64 aims.
  const actors = [mine[0], mine[Math.floor(mine.length / 2)], mine[mine.length - 1]].filter(Boolean);
  for (const u of actors) {
    const s = await selectHard(page, u.id, { zoom: 0.55 });
    if (!s.ok) { L.say(`  unit ${u.id}: WOULD NOT SELECT (${s.why ?? 'wrong unit: ' + JSON.stringify(s.sel)})`); continue; }
    const home = garr.reduce((a, b) => Math.abs(b.cx - u.x) < Math.abs(a.cx - u.x) ? b : a);
    L.say(`\n  --- unit ${u.id} (${u.type}, ${u.alive} men) standing on bay ${home.i} at x${u.x} y${u.meanY} ---`);
    let nAcc = 0, nRef = 0, nNone = 0;
    for (const b of garr) {
      if (b.i === home.i) continue;
      const { p, h } = await offerAt(page, b);
      if (!p) { nNone++; matrix.push({ unit: u.id, bay: b.i, offered: 'nothing framed' }); continue; }
      /*
       * Classify on the **cursor**, not the hint.
       *
       * The first version of this matrix classified on `.drag-hint`, and got "0 accepted" for
       * every unit. `showHint` is only ever called from the drag branch of
       * `SelectionController.update` — a hover has no hint by construction — so it was reading
       * an element that is `display:none` until the button is down and calling the silence a
       * refusal. The cursor *is* live on hover (`updateCursor`), and `wall` / `refuse` /
       * `attack` / `default` is exactly the four-way answer wanted.
       */
      const hint = h.hint ?? '';
      const refused = h.cursor === 'refuse';
      const positive = h.cursor === 'wall';
      const kind = refused ? 'REFUSED' : positive ? 'ACCEPTED' : h.cursor === 'attack' ? 'attack (men in the way)' : 'nothing offered';
      if (refused) nRef++; else if (positive) { nAcc++; accepted.push({ unit: u.id, bay: b.i, p, dist: Math.abs(b.cx - u.x) }); }
      else nNone++;
      matrix.push({ unit: u.id, bay: b.i, dx: Math.round(b.cx - u.x), kind, hint, cursor: h.cursor, wallValid: h.wallValid });
      L.say(`    bay ${String(b.i).padStart(2)} (${String(Math.round(b.cx - u.x)).padStart(5)} m, walkY ${String(b.walkY).padStart(5)}): ${kind.padEnd(15)} cur=${(h.cursor || '-').padEnd(8)} wv=${h.wallValid} "${hint}"`);
    }
    L.say(`  unit ${u.id}: ${nAcc} bays accepted, ${nRef} refused out loud, ${nNone} offered nothing`);
    L.ck(`unit ${u.id}: the wall offers it somewhere to go`, nAcc > 0, '>0 bays accepted', nAcc);
  }

  // ---------------------------------------------------------- 2. take the orders
  L.say('\n=== 2. DO THE ACCEPTED ORDERS HAPPEN? ===');
  const tries = accepted.sort((a, b) => b.dist - a.dist).slice(0, 2)
    .concat(accepted.sort((a, b) => a.dist - b.dist).slice(0, 2));
  const seen = new Set();
  for (const a of tries) {
    const key = `${a.unit}:${a.bay}`; if (seen.has(key)) continue; seen.add(key);
    const b = garr.find(x => x.i === a.bay);
    const s = await selectHard(page, a.unit, { zoom: 0.55 });
    if (!s.ok) { L.say(`  unit ${a.unit} would not re-select`); continue; }
    const { p, h } = await offerAt(page, b);
    if (!p) { L.say(`  bay ${a.bay} no longer offers anything`); continue; }
    const dur = await rightClick(page, p, { hold: 450 });
    const b4 = await page.evaluate(i => window.__u(i), a.unit);
    const st4 = await page.evaluate(i => window.__wallState(i), a.unit);
    await ff(page, 60);
    const af = await page.evaluate(i => window.__u(i), a.unit);
    const st5 = await page.evaluate(i => window.__wallState(i), a.unit);
    const want = Math.abs(b.cx - b4.x), got = Math.abs(af.x - b4.x);
    L.say(`\n  unit ${a.unit} -> bay ${a.bay} (${want.toFixed(0)} m away): hint ${JSON.stringify(dur.hint)}`);
    L.say(`    60 s later x${b4.x} -> ${af.x}; closed ${got.toFixed(0)} of ${want.toFixed(0)} m`);
    L.say(`    wall state: goal ${st4?.goal}->${st5?.goal}, destRun ${st4?.destRun}->${st5?.destRun}, planAge ${st4?.planAge}->${st5?.planAge}, stuck ${st4?.stuck}->${st5?.stuck}, runs ${JSON.stringify(st4?.runs)}->${JSON.stringify(st5?.runs)}`);
    L.ck(`an accepted order to bay ${a.bay} (${want.toFixed(0)} m) is carried out`,
      got > Math.min(25, want * 0.3), `>${Math.min(25, want * 0.3).toFixed(0)} m of progress in 60 s`, `${got.toFixed(0)} m`);
    await shot(page, OUT, `w-order-${a.unit}-${a.bay}`);
  }

  // ------------------------------------------------------ 3. my own streets
  L.say('\n=== 3. CAN I ORDER A COHORT INTO MY OWN CITY? ===');
  const home = garr[Math.floor(garr.length / 2)];
  const probes = [];
  for (const d of [20, 30, 45, 60, 90, 130, 180]) {
    const x = home.cx - home.nx * d, z = home.cz - home.nz * d;
    const gy = await page.evaluate(([a, b]) => window.__game.battle.groundAt(a, b), [x, z]);
    const p = await aim(page, x, gy, z, { zoom: 0.55 });
    if (!p) { probes.push({ d, offered: 'not framed' }); L.say(`  ${d} m inside: could not frame it`); continue; }
    const h = await hover(page, p);
    probes.push({ d, cursor: h.cursor, hint: h.hint, groundValid: h.groundValid, solidValid: h.solidValid, wallValid: h.wallValid });
    L.say(`  ${String(d).padStart(3)} m inside bay ${home.i}: cur=${(h.cursor || '-').padEnd(8)} groundValid=${h.groundValid} solidValid=${h.solidValid} wallValid=${h.wallValid} hint="${h.hint}"`);
  }
  const anyGround = probes.filter(p => p.groundValid).length;
  L.ck('somewhere inside my own wall reads as ordinary ground I can send men to',
    anyGround > 0, '>0 of the 7 points inside', `${anyGround}/7`);
  await shot(page, OUT, 'w-inside');

  // and actually send someone there
  const target = probes.find(p => p.groundValid) ?? null;
  if (target) {
    const u = mine[Math.floor(mine.length / 2)];
    const s = await selectHard(page, u.id, { zoom: 0.55 });
    if (s.ok) {
      const x = home.cx - home.nx * target.d, z = home.cz - home.nz * target.d;
      const gy = await page.evaluate(([a, b]) => window.__game.battle.groundAt(a, b), [x, z]);
      const p = await aim(page, x, gy, z, { zoom: 0.55 });
      const dur = await rightClick(page, p, { hold: 450 });
      L.say(`  ordering unit ${u.id} ${target.d} m inside: hint ${JSON.stringify(dur.hint)}`);
      const b4 = await page.evaluate(i => window.__u(i), u.id);
      await ff(page, 80);
      const af = await page.evaluate(i => window.__u(i), u.id);
      L.say(`  80 s later: y ${b4.meanY} -> ${af.meanY}, elevated ${b4.elevated} -> ${af.elevated}, at x${af.x} z${af.z} (target x${x.toFixed(0)} z${z.toFixed(0)})`);
      L.ck('a wall unit ordered into the city gets down off the wall',
        af.elevated < Math.max(4, b4.elevated * 0.4), `fewer than 40% of ${b4.elevated} still up`, af.elevated);
      await shot(page, OUT, 'w-descended');
    }
  }

  L.ck('no page errors', r.errs.length === 0, 0, r.errs.length);
  L.ck('no console errors', r.cerrs.length === 0, 0, r.cerrs.length);
  if (r.cerrs.length) L.say(`console: ${JSON.stringify(r.cerrs.slice(0, 6))}`);
  await dump(OUT, 'matrix', { seed: SEED, map: MAP, at: AT, matrix, probes, rows: L.rows, log: L.log });
} catch (e) {
  L.ck('the session ran without throwing', false, 'no throw', String(e).slice(0, 400));
  try { await shot(page, OUT, 'w-crash'); } catch {}
} finally { if (browser) await browser.close(); }
L.summary();
