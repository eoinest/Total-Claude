/**
 * DO ORDERS DO WHAT I MEANT? — Rome, from the defending chair.
 *
 * Each case is: frame the thing, sweep the pixels its men are drawn on, read what the game
 * says a click there will do, click, and then watch for 40 s to see whether it did it.
 *
 * The distinction that matters and that a narrative log cannot make: an order the game
 * *refuses out loud* is fine — the player learns. An order the game *accepts silently* and
 * then does not carry out is the worst outcome available, because the player has no way to
 * tell it from a slow one.
 */
import { argsOf, boot, ledger, shot, dump, ff, aim, hover, rightClick, rightDrag, leftClick,
  selectHard, cam, proj, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const SEED = Number(A.get('seed') ?? 4265438264);
const PORT = Number(A.get('port') ?? 5911);
const OUT = path.join(ROOT, 'screenshots/judge/orders-rome');
const L = ledger('orders, Rome garrison');

/** Sweep the pixels a unit's men are drawn on and report what the cursor says about each. */
async function sweep(page, id, label) {
  const box = await page.evaluate(i => window.__box(i), id);
  if (!box || !isFinite(box.x0)) return { probes: 0, mine: 0, answering: 0, other: {}, box: null };
  let probes = 0, answering = 0, first = null; const other = {};
  const curs = {};
  for (let j = 0; j <= 6; j++) {
    const y = Math.round(box.y0 + (box.y1 - box.y0) * j / 6);
    for (let i = 0; i <= 8; i++) {
      const x = Math.round(box.x0 + (box.x1 - box.x0) * i / 8);
      if (x < 4 || x > 1596 || y < 110 || y > 780) continue;
      await page.mouse.move(x, y); await page.waitForTimeout(28);
      const h = await page.evaluate(() => window.__cur());
      probes++; curs[h.cursor] = (curs[h.cursor] ?? 0) + 1;
      if (h.hovered === id) { answering++; if (!first) first = { x, y }; }
      else if (h.hovered >= 0) other[h.hovered] = (other[h.hovered] ?? 0) + 1;
    }
  }
  L.say(`  sweep ${label} (unit ${id}): ${answering}/${probes} pixels name it; other units named: ${JSON.stringify(other)}; cursors ${JSON.stringify(curs)}`);
  return { probes, answering, first, other, curs, box };
}

let browser, page;
try {
  const r = await boot({ port: PORT, map: 'campus-martius', scenario: 'assault', tier: 'ultra',
    out: OUT, label: 'o', seed: SEED });
  ({ browser, page } = r);
  await page.mouse.move(800, 760); await page.waitForTimeout(400);
  const bays = await page.evaluate(() => window.__bays());
  await page.click('.dep-begin'); await page.waitForTimeout(700);
  const T = () => page.evaluate(() => Math.round(window.__game.simTime() * 10) / 10);

  // Let the storm arrive so there is something to fight over.
  await ff(page, 55);
  L.say(`\n=== t+${await T()}: the escalade is on the wall ===`);
  const foes = (await page.evaluate(() => window.__units(1))).filter(u => u.elevated > 4 && u.alive > 8)
    .sort((a, b) => b.elevated - a.elevated);
  L.say(`enemy units with men on my parapet: ${JSON.stringify(foes.map(u => ({ id: u.id, t: u.type, n: u.alive, up: u.elevated, x: u.x, z: u.z, y: u.meanY })))}`);
  const mineWall = (await page.evaluate(() => window.__units(0))).filter(u => u.elevated > 4);
  L.say(`my units on the parapet: ${JSON.stringify(mineWall.map(u => ({ id: u.id, t: u.type, n: u.alive, up: u.elevated, x: u.x, y: u.meanY })))}`);

  // ------------------------------------------------------------------ CASE 1
  // Attack an enemy standing on my wall. This is the single most obvious order a defender
  // gives, and it is the one I could not make land in the full playthrough.
  L.say('\n--- CASE 1: attack an enemy standing on my parapet ---');
  const foe = foes[0];
  if (!foe) { L.ck('case 1: there is an enemy on the parapet to attack', false, 'one', 'none'); }
  else {
    const me = mineWall.filter(u => /cohort/.test(u.type))[0]
      ?? mineWall.sort((a, b) => Math.abs(a.x - foe.x) - Math.abs(b.x - foe.x))[0];
    L.say(`attacker: ${me.id} ${me.type} ${me.alive} men at x${me.x} y${me.meanY}`);
    L.say(`target:   ${foe.id} ${foe.type} ${foe.alive} men at x${foe.x} y${foe.meanY}, ${foe.elevated} on the stone`);
    const s = await selectHard(page, me.id, { zoom: 0.55 });
    L.ck('case 1: my own unit on the wall selects', s.ok, 'selectable', s.ok ? (s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`) : s.why);
    if (s.ok) {
      await aim(page, foe.x, (foe.meanY ?? 0) + 0.9, foe.z, { zoom: 0.62 });
      const sw = await sweep(page, foe.id, 'the enemy on my parapet');
      L.ck('case 1: some pixel of the enemy answers with the enemy', sw.answering > 0,
        '>0 of the enemy\'s own pixels name him', `${sw.answering}/${sw.probes}`);
      const pt = sw.first ?? await aim(page, foe.x, (foe.meanY ?? 0) + 0.9, foe.z, { zoom: 0.62 });
      if (pt) {
        const hv = await hover(page, pt);
        L.say(`  cursor over the enemy: ${JSON.stringify(hv)}`);
        const dur = await rightClick(page, pt, { hold: 450 });
        L.say(`  the hint the game showed me: ${JSON.stringify(dur.hint)} (cursor ${dur.cursor})`);
        L.ck('case 1: the hint says "attack"', /attack/i.test(dur.hint ?? ''),
          'a hint containing "attack"', dur.hint || '(nothing)');
        await shot(page, OUT, 'c1-attack-order');
        const b4 = await page.evaluate(i => window.__u(i), me.id);
        const f4 = await page.evaluate(i => window.__u(i), foe.id);
        await ff(page, 40);
        const af = await page.evaluate(i => window.__u(i), me.id);
        const fa = await page.evaluate(i => window.__u(i), foe.id);
        const moved = Math.hypot(af.x - b4.x, af.z - b4.z);
        L.say(`  40 s later: mine x${b4.x}->${af.x} z${b4.z}->${af.z} (${moved.toFixed(1)} m) order ${b4.order}->${af.order} kills ${b4.kills}->${af.kills}; enemy ${f4.alive}->${fa.alive}`);
        L.ck('case 1: the order produced motion toward the enemy or kills',
          moved > 6 || af.kills > b4.kills, 'moved >6 m or scored kills',
          `moved ${moved.toFixed(1)} m, kills +${af.kills - b4.kills}`);
        await shot(page, OUT, 'c1-attack-after');
      }
    }
  }

  // ------------------------------------------------------------------ CASE 2
  // Walk a cohort along my own wall to a bay I pick. `Siege.moveAlongWall` is supposed to
  // refuse a run the wall does not join; a positive hint followed by nothing is the failure.
  L.say('\n--- CASE 2: traverse along my own wall to a bay I choose ---');
  const walker = (await page.evaluate(() => window.__units(0)))
    .filter(u => u.elevated > 20 && u.alive > 40).sort((a, b) => b.alive - a.alive)[0];
  if (!walker) L.ck('case 2: I have a unit on the wall to walk', false, 'one', 'none');
  else {
    L.say(`walker: ${walker.id} ${walker.type} ${walker.alive} men at x${walker.x} y${walker.meanY}`);
    const here = bays.reduce((a, b) => Math.abs(b.cx - walker.x) < Math.abs(a.cx - walker.x) ? b : a);
    // a bay four along, well inside the same stretch of curtain
    const cands = bays.filter(b => b.garr && !b.gate && Math.abs(b.cx - walker.x) > 100 && Math.abs(b.cx - walker.x) < 260)
      .sort((a, b) => Math.abs(a.cx - walker.x) - Math.abs(b.cx - walker.x));
    const to = cands[0];
    L.say(`from bay ${here.i} (x${here.cx} walkY ${here.walkY}) to bay ${to.i} (x${to.cx} walkY ${to.walkY}) — ${Math.abs(to.cx - here.cx).toFixed(0)} m along the wall`);
    const s = await selectHard(page, walker.id, { zoom: 0.55 });
    L.ck('case 2: the walker selects', s.ok, 'selectable', s.ok ? 'yes' : s.why);
    if (s.ok) {
      let pt = null;
      for (const off of [0, 4, -4, 8, -8, 12]) {
        const p = await aim(page, to.cx + to.nx * off, to.walkY, to.cz + to.nz * off, { zoom: 0.6 });
        if (!p) continue;
        const h = await hover(page, p);
        if (h.wallValid) { pt = p; break; }
      }
      L.ck('case 2: the destination bay reads as a wall target', !!pt, 'wallValid somewhere on it', pt ? 'yes' : 'no pixel on it reads wallValid');
      if (pt) {
        const dur = await rightClick(page, pt, { hold: 450 });
        L.say(`  hint: ${JSON.stringify(dur.hint)} cursor=${dur.cursor}`);
        const positive = /along the wall|onto the wall|up the wall|down off/i.test(dur.hint ?? '');
        const refusal = /no way|broken|cannot|nothing to/i.test(dur.hint ?? '');
        L.say(`  the game ${refusal ? 'REFUSED out loud' : positive ? 'ACCEPTED' : 'said something else'}`);
        await shot(page, OUT, 'c2-traverse-order');
        const b4 = await page.evaluate(i => window.__u(i), walker.id);
        const st4 = await page.evaluate(i => window.__wallState(i), walker.id);
        await ff(page, 60);
        const af = await page.evaluate(i => window.__u(i), walker.id);
        const st5 = await page.evaluate(i => window.__wallState(i), walker.id);
        const along = Math.abs(af.x - b4.x);
        const want = Math.abs(to.cx - b4.x);
        L.say(`  60 s later: x${b4.x} -> ${af.x} (target x${to.cx}); closed ${along.toFixed(0)} of ${want.toFixed(0)} m`);
        L.say(`  wall state before: ${JSON.stringify(st4)}`);
        L.say(`  wall state after:  ${JSON.stringify(st5)}`);
        if (!refusal) {
          L.ck('case 2: an accepted traverse actually moves the unit',
            along > Math.min(30, want * 0.25), `>${Math.min(30, want * 0.25).toFixed(0)} m of progress in 60 s`,
            `${along.toFixed(0)} m`);
        }
        await shot(page, OUT, 'c2-traverse-after');
      }
    }
  }

  // ------------------------------------------------------------------ CASE 3
  // Bring a wall unit down into the city and send it back up. Two orders that must both work
  // for a garrison to plug a break-in.
  L.say('\n--- CASE 3: down off the wall, then back up ---');
  const diver = (await page.evaluate(() => window.__units(0)))
    .filter(u => u.elevated > 20 && u.alive > 40).sort((a, b) => b.alive - a.alive)[0];
  if (diver) {
    const b = bays.reduce((a, c) => Math.abs(c.cx - diver.x) < Math.abs(a.cx - diver.x) ? c : a);
    const inX = b.cx - b.nx * 40, inZ = b.cz - b.nz * 40;
    const gy = await page.evaluate(([x, z]) => window.__game.battle.groundAt(x, z), [inX, inZ]);
    const s = await selectHard(page, diver.id, { zoom: 0.55 });
    L.ck('case 3: the unit selects', s.ok, 'selectable', s.ok ? 'yes' : s.why);
    if (s.ok) {
      const p = await aim(page, inX, gy, inZ, { zoom: 0.6 });
      L.ck('case 3: a street inside the wall can be framed and aimed at', !!p, 'a pixel', p ? 'yes' : 'no');
      if (p) {
        const dur = await rightClick(page, p, { hold: 450 });
        L.say(`  hint over the street: ${JSON.stringify(dur.hint)} cursor=${dur.cursor}`);
        const b4 = await page.evaluate(i => window.__u(i), diver.id);
        await ff(page, 70);
        const af = await page.evaluate(i => window.__u(i), diver.id);
        L.say(`  70 s later: y ${b4.meanY} -> ${af.meanY}, elevated ${b4.elevated} -> ${af.elevated}, at x${af.x} z${af.z}`);
        L.ck('case 3: the unit came down off the wall', af.elevated < b4.elevated * 0.5,
          `fewer than half of ${b4.elevated} still elevated`, af.elevated);
        await shot(page, OUT, 'c3-descended');
        // back up
        let up = null;
        for (const off of [0, 4, -4, 8, -8]) {
          const q = await aim(page, b.cx + b.nx * off, b.walkY, b.cz + b.nz * off, { zoom: 0.6 });
          if (!q) continue;
          const h = await hover(page, q);
          if (h.wallValid) { up = q; break; }
        }
        if (!up) L.ck('case 3: the wall can be aimed at from inside', false, 'a wallValid pixel', 'none');
        else {
          const d2 = await rightClick(page, up, { hold: 450 });
          L.say(`  hint back at the wall: ${JSON.stringify(d2.hint)} cursor=${d2.cursor}`);
          await ff(page, 80);
          const back = await page.evaluate(i => window.__u(i), diver.id);
          L.say(`  80 s later: y ${af.meanY} -> ${back.meanY}, elevated ${af.elevated} -> ${back.elevated}`);
          L.ck('case 3: the unit went back up onto the wall', back.elevated > Math.max(8, af.elevated + 8),
            `more than ${Math.max(8, af.elevated + 8)} elevated`, back.elevated);
          await shot(page, OUT, 'c3-reascended');
        }
      }
    }
  }

  // ------------------------------------------------------------------ CASE 4
  // Halt. The one order whose whole job is to be instant.
  L.say('\n--- CASE 4: halt ---');
  const anyone = (await page.evaluate(() => window.__units(0))).filter(u => u.alive > 20)[0];
  if (anyone) {
    const s = await selectHard(page, anyone.id, { zoom: 0.55 });
    if (s.ok) {
      await page.keyboard.press('h'); await page.waitForTimeout(200);
      const b4 = await page.evaluate(i => window.__u(i), anyone.id);
      await ff(page, 12);
      const af = await page.evaluate(i => window.__u(i), anyone.id);
      const moved = Math.hypot(af.x - b4.x, af.z - b4.z);
      L.say(`  H pressed; order ${b4.order} -> ${af.order}; moved ${moved.toFixed(1)} m in 12 s`);
      L.ck('case 4: H stops the unit', moved < 6, '<6 m of drift', `${moved.toFixed(1)} m`);
    }
  }

  L.ck('no page errors', r.errs.length === 0, 0, r.errs.length);
  L.ck('no console errors', r.cerrs.length === 0, 0, r.cerrs.length);
  if (r.cerrs.length) L.say(`console: ${JSON.stringify(r.cerrs.slice(0, 6))}`);
} catch (e) {
  L.ck('the session ran without throwing', false, 'no throw', String(e).slice(0, 400));
  try { await shot(page, OUT, 'o-crash'); } catch {}
} finally {
  await dump(OUT, 'orders', { seed: SEED, rows: L.rows, log: L.log });
  if (browser) await browser.close();
}
L.summary();
