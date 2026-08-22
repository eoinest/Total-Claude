/**
 * SESSION C — storm Carthage. Here Rome is the besieger, so this is the map where the three
 * ways in are the *player's* choice, and the map the owner thinks came out better than Rome.
 *
 * The question is whether choosing between them is a real decision. So this plays the choice
 * deliberately: hold the host, wait for the ram to open the Porta Byrsae at t+220, and put a
 * column through it — the comparison the docs claim is 2-3 men at a gate against 412 at a
 * breach. Then storm a bay with a ladder against it and compare. Then re-aim a tower, which
 * is the one machine order a player gives that has a cost.
 *
 *   --arm=commit   hold the host, then commit it through the gate the ram opens  (default)
 *   --arm=passive  give no orders at all: does the storm win on its own?
 *   --arm=escalade go over the wall instead, and never use the gate
 */
import { argsOf, boot, ledger, shot, dump, ff, realtime, ended, aim, hover, rightClick,
  rightDrag, leftClick, selectHard, cam, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const SEED = Number(A.get('seed') ?? 4265438264);
const ARM = A.get('arm') ?? 'commit';
const PORT = Number(A.get('port') ?? 5911);
const TILL = Number(A.get('till') ?? 1200);
const OUT = path.join(ROOT, `screenshots/judge/carthage-${ARM}-${SEED}`);
const L = ledger(`carthage ${ARM} seed ${SEED}`);
const snaps = [];

let browser, page;
try {
  const r = await boot({ port: PORT, map: 'carthage', scenario: 'assault', tier: 'ultra',
    out: OUT, label: 'c', seed: SEED,
    onSetup: (p) => p.screenshot({ path: path.join(OUT, 'c-00-menu.png') }) });
  ({ browser, page } = r);
  await page.mouse.move(800, 760); await page.waitForTimeout(400);
  const T = () => page.evaluate(() => Math.round(window.__game.simTime() * 10) / 10);
  const HUD = () => page.evaluate(() => window.__HUD());
  const TR = () => page.evaluate(() => window.__TRUTH());

  const d0 = await HUD();
  L.say(`brief: ${d0.deploy?.brief}`);
  L.say(`help:  ${d0.deploy?.help}`);
  L.say(`tally: ${d0.deploy?.tally}`);
  L.say(`rows:  ${JSON.stringify(d0.deploy?.rows)}`);
  L.ck('the besieger\'s brief does not tell me to man a parapet I do not have',
    !/parapet to man the wall/.test(d0.deploy?.help ?? ''), 'no parapet instruction',
    /parapet to man the wall/.test(d0.deploy?.help ?? '') ? 'it does' : 'it does not');
  await shot(page, OUT, 'c-01-deploy');
  const bays = await page.evaluate(() => window.__bays());
  const mine0 = await page.evaluate(() => window.__units(0));
  L.say(`my train: ${JSON.stringify(mine0.map(u => ({ id: u.id, t: u.type, n: u.alive, x: u.x, z: u.z })))}`);
  const gates0 = (await TR()).siege?.gate?.gates ?? [];
  L.say(`gates: ${JSON.stringify(gates0.map(g => ({ id: g.id, x: Math.round(g.x), z: Math.round(g.z), open: g.open })))}`);

  await page.click('.dep-begin'); await page.waitForTimeout(800);
  const fps = await realtime(page, 4000);
  L.say(`real-time frame rate at the opening: ${JSON.stringify(fps)}`);
  L.ck('opening runs at 30 fps or better', fps.fps >= 30, '>=30', fps.fps);

  const host = () => page.evaluate(() => window.__units(0).filter(u => /legio-cohort/.test(u.type) && u.alive > 20));
  let gateDone = false, storming = false, committed = 0, towerOrdered = false;
  let verdict = null;

  for (let t = 0; t < TILL; t += 20) {
    await ff(page, 20);
    const h = await HUD(), tr = await TR();
    const o = tr.objective, sg = tr.siege;
    const row = { t: tr.t, phase: h.phase, note: h.note, adv: h.adv,
      obj: o && { onWall: o.stormOnWall, holding: o.stormHolding, garr: o.garrisonOnWall,
        inside: o.stormInside, heldFor: Math.round(o.heldFor), stalled: Math.round(o.stalledFor) },
      gate: sg?.gate && { hp: +sg.gate.hp.toFixed(2), blows: sg.gate.blows, breached: sg.gate.breached },
      towers: sg?.towers?.map?.(x => `${x.state}:${x.crossed ?? '?'}`),
      crossing: sg?.stats?.crossing, men: h.blocks.map(b => `${b.name} ${b.men} ${b.loss}`) };
    snaps.push(row);
    L.say(`  t+${tr.t} [${row.phase}] "${row.note}" adv="${row.adv}" ${JSON.stringify(row.obj)} gate=${JSON.stringify(row.gate)} towers=${JSON.stringify(row.towers)} crossing=${row.crossing} ${row.men.join(' | ')}`);
    if (h.feed.length) L.say(`      feed: ${JSON.stringify(h.feed.map(f => f.head))}`);

    // honesty on the plaque
    if (o) {
      const m = (row.adv ?? '').match(/^(\d+) of (\d+) inside/);
      if (m) L.ck(`t+${tr.t}: the plaque's inside count is the arbiter's`, Number(m[1]) === o.stormInside,
        o.stormInside, m[1]);
      const w = (row.adv ?? '').match(/^(\d+) (?:of 24 on a cleared stretch|men hold a stretch)/);
      if (w) L.ck(`t+${tr.t}: the plaque's holding count is the arbiter's`, Number(w[1]) === o.stormHolding,
        o.stormHolding, w[1]);
    }

    // ---- ARM: re-aim a tower once, early, and read the refusal vocabulary
    if (ARM !== 'passive' && !towerOrdered && tr.t > 25) {
      towerOrdered = true;
      L.say('\n  --- ORDER: send a siege tower to a bay I choose ---');
      const party = (await page.evaluate(() => window.__units(0))).find(u => /tower-party/.test(u.type));
      const s = await selectHard(page, party.id, { zoom: 0.5 });
      L.say(`  select tower party ${party.id}: ${s.ok ? (s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`) : `FAILED ${s.why} sel=${JSON.stringify(s.sel)}`}`);
      L.ck('a tower party can be selected', s.ok, 'selectable', s.ok ? 'yes' : (s.why ?? 'wrong unit'));
      if (s.ok) {
        const tgt = bays.filter(b => b.garr && !b.gate).sort((a, b) => Math.abs(a.cx - 250) - Math.abs(b.cx - 250))[0];
        let pt = null;
        for (const off of [4, 0, 8, -4, 12]) {
          const p = await aim(page, tgt.cx + tgt.nx * off, tgt.walkY, tgt.cz + tgt.nz * off, { zoom: 0.6 });
          if (!p) continue;
          const hv = await hover(page, p);
          if (hv.wallValid || /roll|tower|storm/i.test(hv.hint ?? '')) { pt = p; break; }
        }
        L.ck('the bay I want the tower at can be aimed at', !!pt, 'a pixel that offers something', pt ? 'yes' : 'nothing offered anywhere on it');
        if (pt) {
          const dur = await rightClick(page, pt, { hold: 500 });
          L.say(`  hint: ${JSON.stringify(dur.hint)} cursor=${dur.cursor}`);
          L.ck('the tower order tells me the cost before I commit',
            /\bm\b.*\d+:\d\d|\d+ m/.test(dur.hint ?? ''), 'a distance and a time in the hint', dur.hint || '(nothing)');
          await shot(page, OUT, 'c-tower-order');
          const before = (await TR()).siege?.towers;
          await ff(page, 40);
          const after = (await TR()).siege?.towers;
          L.say(`  towers before: ${JSON.stringify(before?.map(x => ({ st: x.state, x: Math.round(x.x), z: Math.round(x.z) })))}`);
          L.say(`  towers after:  ${JSON.stringify(after?.map(x => ({ st: x.state, x: Math.round(x.x), z: Math.round(x.z) })))}`);
          t += 40;
        }
      }
    }

    // ---- the gate opens: is it a way in?
    if (sg?.gate?.breached && !gateDone) {
      gateDone = true;
      L.say(`\n  *** THE PORTA BYRSAE IS OPEN at t+${tr.t} ***`);
      L.say(`  plaque: [${h.phase}] "${h.note}" adv="${h.adv}"`);
      L.ck('the gate opening is announced on screen',
        /gate|breach/i.test(`${h.phase} ${h.note} ${h.feed.map(f => f.head + f.sub).join(' ')}`),
        'the word gate or breach', `${h.phase} | ${h.note}`);
      const g = sg.gate;
      await aim(page, g.x, 14, g.z - 55, { zoom: 0.38 });
      await shot(page, OUT, `c-gate-open-t${Math.round(tr.t)}`);
      if (ARM === 'commit') {
        L.say('\n  --- ORDER: put the host through the gate ---');
        const cs = (await host()).sort((a, b) => Math.abs(a.x - g.x) - Math.abs(b.x - g.x)).slice(0, 3);
        const insideX = g.x, insideZ = g.z - 45; // cityward of the gate
        const gy = await page.evaluate(([x, z]) => window.__game.battle.groundAt(x, z), [insideX, insideZ]);
        for (const c of cs) {
          const s = await selectHard(page, c.id, { zoom: 0.5 });
          if (!s.ok) { L.say(`  cohort ${c.id} would not select (${s.why ?? 'wrong unit'})`); continue; }
          const p = await aim(page, insideX, gy, insideZ, { zoom: 0.5 });
          if (!p) { L.say('  could not frame a point inside the gate'); continue; }
          const hv = await hover(page, p);
          const dur = await rightClick(page, p, { hold: 420 });
          L.say(`  cohort ${c.id} -> inside the gate: cursor=${hv.cursor} hint=${JSON.stringify(dur.hint)}`);
          committed++;
        }
        L.ck('a column can be ordered through the gate the ram opened', committed > 0,
          '>0 cohorts ordered', committed);
        await shot(page, OUT, 'c-gate-column-ordered');
        const i0 = (await TR()).objective?.stormInside ?? 0;
        await ff(page, 120);
        const i1 = (await TR()).objective?.stormInside ?? 0;
        L.say(`  120 s after the order: inside ${i0} -> ${i1}`);
        L.ck('men actually flow through the open gate', i1 > i0 + 10,
          `stormInside up by more than 10 from ${i0}`, i1);
        await aim(page, g.x, 14, g.z - 55, { zoom: 0.38 });
        await shot(page, OUT, 'c-gate-flow');
        t += 120;
      }
    }

    // ---- the escalade arm: storm a bay with a ladder against it
    if (ARM === 'escalade' && !storming && tr.t > 60) {
      storming = true;
      L.say('\n  --- ORDER: storm the wall over a ladder ---');
      const c = (await host())[0];
      const s = await selectHard(page, c.id, { zoom: 0.5 });
      L.ck('a line cohort selects', s.ok, 'selectable', s.ok ? 'yes' : (s.why ?? 'wrong unit'));
      if (s.ok) {
        const lad = (await page.evaluate(() => window.__units(0))).filter(u => /escalade/.test(u.type))[0];
        const b = bays.reduce((a, x) => Math.abs(x.cx - lad.x) < Math.abs(a.cx - lad.x) ? x : a);
        let pt = null, hv = null;
        for (const off of [3, 0, 6, -3, 9]) {
          const p = await aim(page, b.cx + b.nx * off, b.walkY, b.cz + b.nz * off, { zoom: 0.6 });
          if (!p) continue;
          hv = await hover(page, p);
          if (hv.wallValid) { pt = p; break; }
        }
        L.ck('a bay with a ladder on it offers a storm order', !!pt, 'wallValid', pt ? 'yes' : 'no');
        if (pt) {
          const dur = await rightClick(page, pt, { hold: 500 });
          L.say(`  hint: ${JSON.stringify(dur.hint)} cursor=${dur.cursor}`);
          L.ck('the storm hint says "storm the wall"', /storm the wall/i.test(dur.hint ?? ''),
            '"Storm the wall here"', dur.hint || '(nothing)');
          await shot(page, OUT, 'c-storm-order');
          const w0 = (await TR()).objective?.stormOnWall ?? 0;
          await ff(page, 120);
          const w1 = (await TR()).objective?.stormOnWall ?? 0;
          L.say(`  120 s after: on the wall ${w0} -> ${w1}`);
          L.ck('a stormed bay puts men on the parapet', w1 > w0, `more than ${w0}`, w1);
          await shot(page, OUT, 'c-storm-after');
          t += 120;
        }
      }
    }

    verdict = await ended(page);
    if (verdict) { L.say(`\n*** RESULT at t+${tr.t}: ${JSON.stringify(verdict)} ***`); break; }
  }

  const trEnd = await TR();
  if (verdict) {
    const hEnd = await HUD();
    L.say(`result panel: ${JSON.stringify(hEnd.result, null, 1)}`);
    await shot(page, OUT, 'c-99-result');
    L.say(`arbiter: ${JSON.stringify(trEnd.flowResult)}`);
    L.say(`objective at the end: ${JSON.stringify(trEnd.objective)}`);
    // The one honesty check the Rome session failed: does the card's sentence match which
    // condition fired?
    const o = trEnd.objective;
    if (trEnd.flowResult?.reason === 'objective' && o) {
      const carried = (o.heldFor ?? 0) >= 19;
      const brokeIn = (o.stormInside ?? 0) >= 60;
      const says = (hEnd.result?.flavour ?? []).join(' ');
      L.say(`  which condition fired: ${carried ? 'A, the parapet was held' : brokeIn ? 'B, sixty men got inside' : 'neither is satisfied at the end'}`);
      L.ck('the card\'s sentence names the condition that actually fired',
        carried ? /wall was carried/.test(says) : /inside|streets|gate|through/i.test(says),
        carried ? '"the wall was carried"' : 'a sentence about getting inside',
        says.slice(0, 120));
    }
  } else {
    L.ck(`a verdict inside t+${TILL}`, false, `a result before t+${TILL}`, `still running at t+${trEnd.t}`);
  }
  L.ck('no page errors', r.errs.length === 0, 0, r.errs.length);
  L.ck('no console errors', r.cerrs.length === 0, 0, r.cerrs.length);
  if (r.cerrs.length) L.say(`console: ${JSON.stringify(r.cerrs.slice(0, 6))}`);
} catch (e) {
  L.ck('the session ran without throwing', false, 'no throw', String(e).slice(0, 400));
  try { await shot(page, OUT, 'c-crash'); } catch {}
} finally {
  await dump(OUT, 'session', { seed: SEED, arm: ARM, rows: L.rows, log: L.log, snaps });
  if (browser) await browser.close();
}
L.summary();
