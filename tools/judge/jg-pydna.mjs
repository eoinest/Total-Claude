/**
 * SESSION P — the field battle at Pydna. No wall, so no objective: this is decided by
 * cohesion, and it is the one map where the player's manoeuvre is the whole game.
 *
 * Rome is out-numbered 3,772 to 4,860 and out-fronted 684 m to 783 m, so the interesting
 * question is whether the game lets a player answer that: refuse a flank, time a reserve,
 * counter-charge with the horse. Three arms:
 *
 *   --arm=passive   no orders at all. What does the shipped deployment do on its own?
 *   --arm=play      hold the line, commit the praetorians into the first break, and send the
 *                   equites round a flank. The orders a player would actually give.
 *   --arm=blunder   play it badly on purpose — everything forward at once, cavalry into
 *                   spears — and see whether the game explains why I lost.
 */
import { argsOf, boot, ledger, shot, dump, ff, realtime, ended, aim, hover, rightClick,
  rightDrag, leftClick, boxSelect, selectHard, cam, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const SEED = Number(A.get('seed') ?? 4265438264);
const ARM = A.get('arm') ?? 'play';
const PORT = Number(A.get('port') ?? 5911);
const TILL = Number(A.get('till') ?? 1400);
const OUT = path.join(ROOT, `screenshots/judge/pydna-${ARM}-${SEED}`);
const L = ledger(`pydna ${ARM} seed ${SEED}`);
const snaps = [];

let browser, page;
try {
  const r = await boot({ port: PORT, map: 'pydna', scenario: 'field', tier: 'ultra',
    out: OUT, label: 'p', seed: SEED,
    onSetup: (p) => p.screenshot({ path: path.join(OUT, 'p-00-menu.png') }) });
  ({ browser, page } = r);
  await page.mouse.move(800, 760); await page.waitForTimeout(400);
  const HUD = () => page.evaluate(() => window.__HUD());
  const TR = () => page.evaluate(() => window.__TRUTH());

  const d0 = await HUD();
  L.say(`title: ${d0.deploy?.title}`);
  L.say(`brief: ${d0.deploy?.brief}`);
  L.say(`help:  ${d0.deploy?.help}`);
  L.say(`tally: ${d0.deploy?.tally}`);
  L.say(`rows:  ${JSON.stringify(d0.deploy?.rows)}`);
  L.ck('a field battle gets a brief telling me how to win it', !!d0.deploy?.brief,
    'some sentence', d0.deploy?.brief ?? '(null — nothing at all)');
  L.say(`banners at t+0: ${JSON.stringify(d0.banner)}`);
  await shot(page, OUT, 'p-01-deploy');
  const mine = await page.evaluate(() => window.__units(0));
  const foe = await page.evaluate(() => window.__units(1));
  L.say(`Rome: ${JSON.stringify(mine.map(u => ({ id: u.id, t: u.type, n: u.alive, x: Math.round(u.x), z: Math.round(u.z) })))}`);
  L.say(`Foe:  ${JSON.stringify(foe.map(u => ({ id: u.id, t: u.type, n: u.alive, x: Math.round(u.x), z: Math.round(u.z) })))}`);

  await page.click('.dep-begin'); await page.waitForTimeout(800);
  const fps = await realtime(page, 4000);
  L.say(`real-time frame rate at the opening: ${JSON.stringify(fps)}`);
  L.ck('opening runs at 30 fps or better', fps.fps >= 30, '>=30', fps.fps);

  // ------------------------------------------------- the blunder, given at once
  if (ARM === 'blunder') {
    L.say('\n--- BLUNDER: everything forward, horse into the spearmen ---');
    await page.keyboard.press('f'); await page.waitForTimeout(300);
    const sel = await page.evaluate(() => window.__sel());
    L.say(`F selected ${sel?.length ?? 0} units`);
    L.ck('F selects the whole army', (sel?.length ?? 0) >= 10, '>=10 units', sel?.length ?? 0);
    const spear = foe.filter(u => /spear/.test(u.type))[0] ?? foe[0];
    const p = await aim(page, spear.x, 1.6, spear.z, { zoom: 0.32 });
    if (p) {
      const dur = await rightClick(page, p, { hold: 420 });
      L.say(`whole army ordered at ${spear.type}: hint ${JSON.stringify(dur.hint)} cursor=${dur.cursor}`);
      await shot(page, OUT, 'p-blunder-order');
    } else L.say('could not frame the enemy line');
  }

  let firstContact = null, committed = false, flanked = false, verdict = null;
  let lowPoint = null;
  for (let t = 0; t < TILL; t += 20) {
    await ff(page, 20);
    const one = await page.evaluate(() => {
      const h = window.__HUD(), tr = window.__TRUTH();
      return { h, tr };
    });
    const h = one.h, tr = one.tr;
    const row = { t: tr.t, phase: h.phase, note: h.note, adv: h.adv,
      men: h.blocks.map(b => `${b.name} ${b.men} ${b.loss}`),
      per: tr.per, feed: h.feed.map(f => f.head) };
    snaps.push(row);
    L.say(`  t+${tr.t} [${row.phase}] "${row.note}" adv="${row.adv}" ${row.men.join(' | ')} routing R${tr.per[0]?.routing ?? 0}/${tr.per[0]?.units} F${tr.per[1]?.routing ?? 0}/${tr.per[1]?.units}`);
    if (h.feed.length) L.say(`      feed: ${JSON.stringify(h.feed.map(f => `${f.head} — ${f.sub}`))}`);

    const casR = (tr.per[0]?.alive ?? 0), casF = (tr.per[1]?.alive ?? 0);
    if (firstContact === null && (3772 - casR) + (4860 - casF) > 40) {
      firstContact = tr.t;
      L.say(`\n  *** THE LINES HAVE MET at t+${tr.t} ***`);
      L.ck('the clash is announced somewhere', /clash|met|contact|melee/i.test(`${h.phase} ${h.note} ${h.feed.map(f => f.head).join(' ')}`),
        'the plaque or feed says the lines met', `${h.phase} | ${h.note} | ${h.feed.map(f => f.head).join(', ')}`);
      const mid = await page.evaluate(() => { const u = window.__units(0).filter(x => /legio-cohort/.test(x.type));
        return u.length ? { x: u.reduce((a, b) => a + b.x, 0) / u.length, z: u.reduce((a, b) => a + b.z, 0) / u.length } : null; });
      if (mid) { await aim(page, mid.x, 3, mid.z - 60, { zoom: 0.36 }); await shot(page, OUT, `p-contact-t${Math.round(tr.t)}`); }
    }

    // ------------------------------------------------- the player's two moves
    if (ARM === 'play' && firstContact !== null && !committed && tr.t > firstContact + 60) {
      committed = true;
      L.say('\n  --- ORDER: commit the praetorian reserve into the worst of the line ---');
      const worst = (await page.evaluate(() => window.__units(0)))
        .filter(u => /legio-cohort/.test(u.type) && u.alive > 0)
        .sort((a, b) => a.morale - b.morale)[0];
      const pra = (await page.evaluate(() => window.__units(0))).filter(u => /praetorian/.test(u.type));
      L.say(`  weakest cohort: ${worst.id} morale ${worst.morale} at x${worst.x} z${worst.z}`);
      for (const u of pra) {
        const s = await selectHard(page, u.id, { zoom: 0.4 });
        L.ck(`the praetorian reserve ${u.id} selects`, s.ok, 'selectable', s.ok ? (s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`) : (s.why ?? 'wrong unit'));
        if (!s.ok) continue;
        const p = await aim(page, worst.x, 1.6, worst.z - 12, { zoom: 0.4 });
        if (!p) { L.say('  could not frame the gap'); continue; }
        const dur = await rightDrag(page, p, { x: p.x + 110, y: p.y }, { steps: 12 });
        L.say(`  reserve ${u.id} -> the gap: hint ${JSON.stringify(dur.hint)} cursor=${dur.cursor}`);
        L.ck(`the reserve order reports its frontage`, /frontage|per rank/.test(dur.hint ?? ''),
          'a frontage in metres and men per rank', dur.hint || '(nothing)');
        const b4 = await page.evaluate(i => window.__u(i), u.id);
        await ff(page, 40);
        const af = await page.evaluate(i => window.__u(i), u.id);
        const moved = Math.hypot(af.x - b4.x, af.z - b4.z);
        L.say(`  40 s later: moved ${moved.toFixed(0)} m to x${af.x} z${af.z}, order ${b4.order}->${af.order}`);
        L.ck(`the reserve ${u.id} actually marched`, moved > 15, '>15 m in 40 s', `${moved.toFixed(0)} m`);
        t += 40;
      }
      await shot(page, OUT, 'p-reserve-committed');
    }
    if (ARM === 'play' && committed && !flanked) {
      flanked = true;
      L.say('\n  --- ORDER: the horse round the flank, into the enemy\'s rear ---');
      const eq = (await page.evaluate(() => window.__units(0))).filter(u => /equites/.test(u.type) && u.alive > 20);
      const target = (await page.evaluate(() => window.__units(1)))
        .filter(u => /skirmish|rider|archer/.test(u.type) && u.alive > 20)
        .sort((a, b) => Math.abs(b.x) - Math.abs(a.x))[0]
        ?? (await page.evaluate(() => window.__units(1))).sort((a, b) => Math.abs(b.x) - Math.abs(a.x))[0];
      L.say(`  target on the wing: ${target.id} ${target.type} ${target.alive} men at x${target.x} z${target.z}`);
      for (const u of eq.slice(0, 2)) {
        const s = await selectHard(page, u.id, { zoom: 0.42 });
        L.ck(`squadron ${u.id} selects`, s.ok, 'selectable', s.ok ? 'yes' : (s.why ?? 'wrong unit'));
        if (!s.ok) continue;
        const p = await aim(page, target.x, 2.0, target.z, { zoom: 0.42 });
        if (!p) continue;
        const hv = await hover(page, p);
        L.say(`  hovering the enemy squadron: cursor=${hv.cursor} hovered=${hv.hovered} (want ${target.id})`);
        L.ck(`hovering an enemy unit in the open names it`, hv.hovered === target.id, target.id, hv.hovered);
        const dur = await rightClick(page, p, { hold: 420 });
        L.say(`  order: hint ${JSON.stringify(dur.hint)} cursor=${dur.cursor}`);
        L.ck('the attack hint names the target', /attack/i.test(dur.hint ?? ''), 'a hint containing "attack"', dur.hint || '(nothing)');
        const b4 = await page.evaluate(i => window.__u(i), u.id);
        const t4 = await page.evaluate(i => window.__u(i), target.id);
        await ff(page, 50);
        const af = await page.evaluate(i => window.__u(i), u.id);
        const ta = await page.evaluate(i => window.__u(i), target.id);
        L.say(`  50 s later: squadron moved ${Math.hypot(af.x - b4.x, af.z - b4.z).toFixed(0)} m, kills ${b4.kills}->${af.kills}; target ${t4.alive}->${ta.alive} morale ${t4.morale}->${ta.morale}`);
        L.ck(`the cavalry charge did damage`, af.kills > b4.kills || ta.alive < t4.alive,
          'kills or casualties on the target', `kills +${af.kills - b4.kills}, target -${t4.alive - ta.alive}`);
        t += 50;
      }
      await shot(page, OUT, 'p-cavalry-charge');
    }

    if (lowPoint === null && (tr.per[0]?.routing ?? 0) >= 3) {
      lowPoint = tr.t;
      L.say(`\n  *** THREE OF MY UNITS ARE ROUTING at t+${tr.t} ***`);
      L.say(`  plaque: [${h.phase}] "${h.note}" adv="${h.adv}"`);
      L.ck('the plaque tells me my line is breaking',
        /break|rout|giving|losing|advantage/i.test(`${h.phase} ${h.note} ${h.adv}`),
        'the plaque says something about it', `${h.phase} | ${h.note} | ${h.adv}`);
    }

    verdict = await ended(page);
    if (verdict) { L.say(`\n*** RESULT at t+${tr.t}: ${JSON.stringify(verdict)} ***`); break; }
    if (t % 200 === 0) { await shot(page, OUT, `p-t${Math.round(tr.t)}`); }
  }

  const trEnd = await TR();
  if (verdict) {
    const hEnd = await HUD();
    L.say(`result panel: ${JSON.stringify(hEnd.result, null, 1)}`);
    await shot(page, OUT, 'p-99-result');
    L.say(`arbiter: ${JSON.stringify(trEnd.flowResult)}`);
    L.ck('the result explains why, not just who',
      !!hEnd.result?.reason && hEnd.result.reason.length > 12, 'a sentence', hEnd.result?.reason);
  } else {
    L.ck(`a verdict inside t+${TILL}`, false, `a result before t+${TILL}`, `still running at t+${trEnd.t}`);
    L.say(`state at the cap: ${JSON.stringify(trEnd.per)} strength ${JSON.stringify(trEnd.strength)}`);
  }
  L.say(`first contact at t+${firstContact}`);
  L.ck('no page errors', r.errs.length === 0, 0, r.errs.length);
  L.ck('no console errors', r.cerrs.length === 0, 0, r.cerrs.length);
  if (r.cerrs.length) L.say(`console: ${JSON.stringify(r.cerrs.slice(0, 6))}`);
} catch (e) {
  L.ck('ran without throwing', false, 'no throw', String(e).slice(0, 400));
  try { await shot(page, OUT, 'p-crash'); } catch {}
} finally {
  await dump(OUT, 'session', { seed: SEED, arm: ARM, rows: L.rows, log: L.log, snaps });
  if (browser) await browser.close();
}
L.summary();
