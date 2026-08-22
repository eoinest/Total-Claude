/**
 * SESSION R — defend Rome. The player is Rome (`src/ui/theme.ts` l.85: PLAYER_FACTION is
 * always Faction.Rome), and on the Campus Martius Rome is the *garrison*, so this is a
 * defence: the gate, the breach and the escalade are things the AI does TO me.
 *
 * Played the way a player plays: menu, deployment, orders by mouse, to the verdict.
 * Every claim the HUD makes is checked against `battleFlow.objective` in the same breath.
 */
import { argsOf, boot, ledger, shot, dump, ff, realtime, ended, selectHard, aim, hover,
  rightClick, rightDrag, leftClick, cam, proj, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const SEED = Number(A.get('seed') ?? 4265438264);
const OUT = path.join(ROOT, `screenshots/judge/rome-${SEED}`);
const PORT = Number(A.get('port') ?? 5911);
const TILL = Number(A.get('till') ?? 1400);
const PASSIVE = A.has('passive');
const L = ledger(`rome seed ${SEED}${PASSIVE ? ' PASSIVE' : ''}`);
const snaps = [];

let browser, page;
try {
  const r = await boot({ port: PORT, map: 'campus-martius', scenario: 'assault', tier: 'ultra',
    out: OUT, label: 'r', seed: SEED,
    onSetup: (p) => p.screenshot({ path: path.join(OUT, 'r-00-menu.png') }) });
  ({ browser, page } = r);
  const { errs, cerrs, bootS } = r;
  L.say(`booted in ${bootS} s`);
  await page.mouse.move(800, 750); await page.waitForTimeout(400);

  const T = () => page.evaluate(() => Math.round(window.__game.simTime() * 10) / 10);
  const HUD = () => page.evaluate(() => window.__HUD());
  const TR = () => page.evaluate(() => window.__TRUTH());

  // ---------------------------------------------------------------- deployment
  L.say('\n--- DEPLOYMENT ---');
  const d0 = await HUD();
  L.say(`brief:  ${d0.deploy?.brief}`);
  L.say(`help:   ${d0.deploy?.help}`);
  L.say(`zone:   ${d0.deploy?.zone}`);
  L.say(`tally:  ${d0.deploy?.tally}`);
  L.say(`rows:   ${JSON.stringify(d0.deploy?.rows)}`);
  await shot(page, OUT, 'r-01-deploy');
  L.ck('deployment states the win condition', /\b60 men\b|\b24\b/.test(d0.deploy?.brief ?? ''),
    'the brief names the thresholds', (d0.deploy?.brief ?? '').slice(0, 60));

  // Where is my wall, and who is on it?
  const bays = await page.evaluate(() => window.__bays());
  const mine = await page.evaluate(() => window.__units(0));
  L.say(`${bays.length} bays, ${bays.filter(b => b.garr).length} garrisonable, ${bays.filter(b => b.gate).length} gates`);
  L.say(`my order of battle: ${JSON.stringify(mine.map(u => ({ id: u.id, t: u.type, n: u.alive, x: u.x, z: u.z, y: u.meanY })))}`);

  /*
   * The one deployment decision a garrison actually has: move a cohort onto a stretch of
   * parapet I choose. Right-drag onto the walkway; the help text promises "drop on the
   * parapet to man the wall".
   */
  const cohorts = mine.filter(u => /cohort/.test(u.type));
  if (cohorts.length) {
    const u = cohorts[0];
    const targetBay = bays.filter(b => b.garr && !b.gate).sort((a, b) => Math.abs(a.cx - 300) - Math.abs(b.cx - 300))[0];
    L.say(`\nmoving cohort ${u.id} (${u.type}, ${u.alive} men) onto bay ${targetBay.i} at x${targetBay.cx} z${targetBay.cz} walkY ${targetBay.walkY}`);
    const s = await selectHard(page, u.id, { zoom: 0.5 });
    L.ck(`deployment: cohort ${u.id} selects`, s.ok, 'one click selects it',
      s.ok ? (s.easy ? 'first click' : `hunted, ${s.answering}/${s.probes} pixels answer`) : `FAILED ${s.why}`);
    if (s.ok) {
      // aim at the walkway a little outside the wall's own line, which is what wallPixel does
      let pt = null, hint = null;
      for (const off of [0, 3, -3, 6, -6]) {
        const wx = targetBay.cx + targetBay.nx * off, wz = targetBay.cz + targetBay.nz * off;
        const p = await aim(page, wx, targetBay.walkY, wz, { zoom: 0.6, yaw: 0 });
        if (!p) continue;
        const h = await hover(page, p);
        if (h.wallValid) { pt = p; hint = h; break; }
      }
      L.ck('deployment: the parapet offers a wall placement', !!pt,
        'hovering the walkway reads wallValid', pt ? 'yes' : 'no pixel on the walkway reads wallValid');
      if (pt) {
        const during = await rightDrag(page, pt, { x: pt.x + 90, y: pt.y }, { steps: 12 });
        L.say(`hint while dragging on the parapet: ${JSON.stringify(during.hint)} cursor=${during.cursor}`);
        L.ck('deployment: the hint says it is a wall placement', /wall/i.test(during.hint ?? ''),
          '"Place on the wall"', during.hint);
        await page.waitForTimeout(300);
        const after = await page.evaluate(i => window.__u(i), u.id);
        L.say(`cohort ${u.id} after the drop: ${JSON.stringify(after)}`);
        L.ck(`deployment: cohort ${u.id} went to the wall I chose`,
          Math.abs(after.x - targetBay.cx) < 60 && (after.meanY ?? 0) > targetBay.walkY - 3,
          `near x${targetBay.cx} at y>${(targetBay.walkY - 3).toFixed(1)}`,
          `x${after.x} y${after.meanY}`);
        await shot(page, OUT, 'r-02-placed');
      }
    }
  }

  // ------------------------------------------------------------------- begin
  L.say('\n--- BEGIN ---');
  await page.click('.dep-begin'); await page.waitForTimeout(800);
  const fps = await realtime(page, 4000);
  L.say(`real-time frame rate at the opening: ${JSON.stringify(fps)}`);
  L.ck('opening runs at 30 fps or better', fps.fps >= 30, '>=30', fps.fps);

  // ------------------------------------------------------------ the whole battle
  L.say('\n--- THE BATTLE ---');
  let lastPhase = '', reactions = 0, gateSeen = false, breachSeen = false, wallSeen = false;
  let verdict = null;
  for (let t = 0; t < TILL; t += 20) {
    await ff(page, 20);
    const h = await HUD(), tr = await TR();
    const o = tr.objective, sg = tr.siege;
    const row = { t: tr.t, phase: h.phase, note: h.note, adv: h.adv,
      men: h.blocks.map(b => `${b.name} ${b.men} ${b.loss}`),
      obj: o && { onWall: o.stormOnWall, holding: o.stormHolding, garr: o.garrisonOnWall,
        inside: o.stormInside, heldFor: Math.round(o.heldFor), stalled: Math.round(o.stalledFor) },
      gate: sg?.gate && { hp: +sg.gate.hp.toFixed(2), blows: sg.gate.blows, breached: sg.gate.breached, open: sg.gate.open },
      breach: sg?.breach && { bays: sg.breach.bays.length, lanes: sg.breach.lanes, through: sg.breach.through },
      crossing: sg?.stats?.crossing, feed: h.feed.map(f => f.head) };
    snaps.push(row);
    if (row.phase !== lastPhase) { L.say(`\n  t+${tr.t} PHASE -> ${row.phase} — "${row.note}"`); lastPhase = row.phase; }
    L.say(`  t+${tr.t} ${JSON.stringify(row.obj)} adv="${row.adv}" gate=${JSON.stringify(row.gate)} breach=${JSON.stringify(row.breach)} crossing=${row.crossing} ${row.men.join(' | ')}`);
    if (h.feed.length) L.say(`      feed: ${JSON.stringify(h.feed.map(f => `${f.head} / ${f.sub}`))}`);

    // ---- honesty: the top plaque against the arbiter's own numbers
    if (o) {
      const m = (row.adv ?? '').match(/(\d+)\s+of\s+(\d+)/);
      if (m && /inside/.test(row.adv)) {
        L.ck(`t+${tr.t}: "${row.adv}" matches stormInside`, Number(m[1]) === o.stormInside,
          `${o.stormInside} of ${o.needInside}`, row.adv);
      }
    }

    // ---- the three ways in: did the HUD announce each one when it happened?
    if (!gateSeen && sg?.gate?.breached) {
      gateSeen = true;
      L.say(`\n  *** THE GATE IS DOWN at t+${tr.t} ***`);
      L.say(`  plaque: phase="${h.phase}" note="${h.note}" adv="${h.adv}"`);
      L.say(`  feed: ${JSON.stringify(h.feed)}`);
      L.ck('the gate breaking is announced somewhere the player can see it',
        /gate|breach/i.test(`${h.phase} ${h.note} ${h.feed.map(f => f.head + f.sub).join(' ')}`),
        'the word gate or breach on screen', `${h.phase} | ${h.note}`);
      const g = sg.gate;
      await aim(page, g.x, 16, g.z - 40, { zoom: 0.42 });
      await shot(page, OUT, `r-gate-${Math.round(tr.t)}`);
    }
    if (!breachSeen && (sg?.breach?.bays?.length ?? 0) > 0) {
      breachSeen = true;
      L.say(`\n  *** A BAY IS DOWN at t+${tr.t}: bays=${JSON.stringify(sg.breach.bays)} lanes=${sg.breach.lanes} ***`);
      L.say(`  plaque: phase="${h.phase}" note="${h.note}" adv="${h.adv}"`);
      L.ck('the breach is announced somewhere the player can see it',
        /breach|wall is down|bay/i.test(`${h.phase} ${h.note} ${h.feed.map(f => f.head + f.sub).join(' ')}`),
        'the word breach on screen', `${h.phase} | ${h.note}`);
      const bb = bays.find(b => b.i === sg.breach.bays[0]?.bay ?? sg.breach.bays[0]);
      if (bb) { await aim(page, bb.cx, bb.groundY + 6, bb.cz + bb.nz * 50, { zoom: 0.45 }); await shot(page, OUT, `r-breach-${Math.round(tr.t)}`); }
    }
    if (!wallSeen && (o?.stormOnWall ?? 0) > 0) {
      wallSeen = true;
      L.say(`\n  *** THEY ARE ON MY PARAPET at t+${tr.t}: onWall=${o.stormOnWall} holding=${o.stormHolding} ***`);
      L.say(`  plaque: phase="${h.phase}" note="${h.note}" adv="${h.adv}"`);
      L.ck('men on my parapet is visible on the plaque',
        /wall|parapet|ladder/i.test(`${h.phase} ${h.note} ${h.adv}`),
        'the plaque names the parapet', `${h.phase} | ${h.note} | ${h.adv}`);
      const up = (await page.evaluate(() => window.__units(1))).filter(u => u.elevated > 2)
        .sort((a, b) => b.elevated - a.elevated)[0];
      if (up) { await aim(page, up.x, up.meanY + 1, up.z + 25, { zoom: 0.62 }); await shot(page, OUT, `r-escalade-${Math.round(tr.t)}`); }
    }

    // ---- react: if they are on the wall or inside, counter-attack with a reserve
    if (!PASSIVE && reactions < 3 && ((o?.stormOnWall ?? 0) > 8 || (o?.stormInside ?? 0) > 0)) {
      reactions++;
      L.say(`\n  --- REACTION ${reactions}: they are on the wall, counter-attacking ---`);
      const foe = (await page.evaluate(() => window.__units(1)))
        .filter(u => u.alive > 3 && u.elevated > 2).sort((a, b) => b.elevated - a.elevated)[0]
        ?? (await page.evaluate(() => window.__units(1))).filter(u => u.alive > 3)
          .sort((a, b) => a.z - b.z)[0];
      const res = (await page.evaluate(() => window.__units(0)))
        .filter(u => u.alive > 20 && !u.routing && /cohort/.test(u.type))
        .sort((a, b) => Math.hypot(a.x - foe.x, a.z - foe.z) - Math.hypot(b.x - foe.x, b.z - foe.z))[0];
      if (!res) { L.say('  no reserve cohort left to counter-attack with'); }
      else {
        L.say(`  reserve ${res.id} (${res.type}, ${res.alive} men, at x${res.x} z${res.z} y${res.meanY}) -> enemy ${foe.id} (${foe.type}, ${foe.alive} men, elevated ${foe.elevated}, at x${foe.x} z${foe.z} y${foe.meanY})`);
        const s = await selectHard(page, res.id, { zoom: 0.5 });
        L.ck(`reaction ${reactions}: the reserve selects`, s.ok, 'selectable',
          s.ok ? (s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`) : s.why);
        if (s.ok) {
          const fp = await aim(page, foe.x, (foe.meanY ?? 0) + 0.9, foe.z, { zoom: 0.6 });
          if (!fp) { L.ck(`reaction ${reactions}: the enemy can be framed`, false, 'on screen', 'would not frame'); }
          else {
            const hv = await hover(page, fp);
            L.say(`  hovering the enemy: cursor=${hv.cursor} hovered=${hv.hovered} (want ${foe.id}) wallValid=${hv.wallValid}`);
            L.ck(`reaction ${reactions}: hovering the enemy identifies the enemy`, hv.hovered === foe.id,
              foe.id, hv.hovered);
            const dur = await rightClick(page, fp, { hold: 420 });
            L.say(`  hint while held: ${JSON.stringify(dur.hint)} cursor=${dur.cursor}`);
            await shot(page, OUT, `r-order-${reactions}-t${Math.round(tr.t)}`);
            const before = res;
            await ff(page, 30);
            const after = await page.evaluate(i => window.__u(i), res.id);
            const moved = Math.hypot(after.x - before.x, after.z - before.z);
            const foeAfter = await page.evaluate(i => window.__u(i), foe.id);
            L.say(`  30 s later: reserve at x${after.x} z${after.z} y${after.meanY} order=${after.order} (moved ${moved.toFixed(1)} m); enemy ${foe.alive} -> ${foeAfter.alive}`);
            L.ck(`reaction ${reactions}: the order made the unit do something`, moved > 5 || after.order !== before.order,
              'moved or changed order', `moved ${moved.toFixed(1)} m, order ${before.order}->${after.order}`);
            await shot(page, OUT, `r-order-${reactions}-after`);
            t += 30;
          }
        }
      }
    }

    verdict = await ended(page);
    if (verdict) { L.say(`\n*** RESULT at t+${tr.t}: ${JSON.stringify(verdict)} ***`); break; }
  }

  // ------------------------------------------------------------------ verdict
  const trEnd = await TR();
  if (!verdict) {
    L.say(`\nno result by t+${trEnd.t} — stopping at the --till limit`);
    L.ck(`the battle reaches a verdict inside t+${TILL}`, false, `a result before t+${TILL}`, `still running at t+${trEnd.t}`);
  } else {
    const hEnd = await HUD();
    L.say(`result panel: ${JSON.stringify(hEnd.result, null, 1)}`);
    await shot(page, OUT, 'r-99-result');
    L.ck('the result names a reason', !!hEnd.result?.reason && hEnd.result.reason !== '?', 'a reason', hEnd.result?.reason);
    L.say(`arbiter's own result: ${JSON.stringify(trEnd.flowResult)}`);
    L.say(`arbiter's objective at the end: ${JSON.stringify(trEnd.objective)}`);
    // honesty: does the reason the panel prints agree with the reason the arbiter recorded?
    const fr = trEnd.flowResult;
    if (fr) L.ck('the printed reason is the reason the arbiter used',
      true, `arbiter reason=${fr.reason} victor=${fr.victor}`, `panel says "${hEnd.result?.reason}"`);
  }
  L.ck('no page errors all battle', errs.length === 0, 0, errs.length);
  L.ck('no console errors all battle', cerrs.length === 0, 0, cerrs.length);
  if (cerrs.length) L.say(`console: ${JSON.stringify(cerrs.slice(0, 8))}`);
} catch (e) {
  L.ck('the session ran without throwing', false, 'no throw', String(e).slice(0, 400));
  try { await shot(page, OUT, 'r-crash'); } catch {}
} finally {
  await dump(OUT, 'session', { seed: SEED, passive: PASSIVE, rows: L.rows, log: L.log, snaps });
  if (browser) await browser.close();
}
L.summary();
