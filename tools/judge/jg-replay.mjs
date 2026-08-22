/**
 * THE ONE MULTIPLAYER FEATURE THAT SHIPS — record a battle, watch it, take it over.
 *
 * Judged as a *player* feature rather than as a determinism gate (`tools/qa-replay.mjs`
 * already grades the bits). The questions here are: can I get a token without a console; does
 * the playback tell me it is a playback; does "take command from here" hand me an army I can
 * actually give orders to; and does the game notice if what I do next diverges.
 */
import { argsOf, boot, ledger, shot, dump, ff, ended, aim, hover, rightClick, selectHard,
  ROOT } from './jg-lib.mjs';
import { chromium } from 'playwright';
import path from 'node:path';

const A = argsOf();
const SEED = Number(A.get('seed') ?? 4265438264);
const MAP = A.get('map') ?? 'carthage';
const PORT = Number(A.get('port') ?? 5911);
const REC = Number(A.get('rec') ?? 90);
const FROM = Number(A.get('from') ?? 45);
const OUT = path.join(ROOT, 'screenshots/judge/replay');
const L = ledger('the replay record');

let browser, page, base;
try {
  // ------------------------------------------------------------ 1. record one
  const r = await boot({ port: PORT, map: MAP, scenario: 'assault', tier: 'ultra',
    out: OUT, label: 'rp', seed: SEED });
  ({ browser, page } = r); base = r.base;
  await page.mouse.move(800, 760); await page.waitForTimeout(300);
  await page.click('.dep-begin'); await page.waitForTimeout(600);

  // give a couple of real orders so the record has something in it that is mine
  await ff(page, 30);
  const cs = (await page.evaluate(() => window.__units(0))).filter(u => /legio-cohort/.test(u.type));
  let given = 0;
  for (const c of cs.slice(0, 2)) {
    const s = await selectHard(page, c.id, { zoom: 0.45 });
    if (!s.ok) continue;
    const p = await aim(page, c.x, 1.6, c.z - 70, { zoom: 0.45 });
    if (!p) continue;
    await rightClick(page, p, { hold: 300 });
    given++;
  }
  L.say(`gave ${given} real orders before recording the token`);
  await ff(page, REC - 30);
  const tRec = await page.evaluate(() => Math.round(window.__game.simTime() * 10) / 10);

  const tok = await page.evaluate(async () => {
    try { return await window.__game.replay.token(); } catch (e) { return 'ERR ' + e.message; }
  });
  L.ck('a token can be got mid-battle', typeof tok === 'string' && tok.length > 100 && !tok.startsWith('ERR'),
    'a base64url string', typeof tok === 'string' ? `${tok.length} chars${tok.startsWith('ERR') ? ' — ' + tok : ''}` : typeof tok);
  const rec = await page.evaluate(() => { try { const r = window.__game.replay.record();
    return { v: r.v, ev: r.ev?.length, mk: r.mk?.length, tk: r.tk, q: r.q, dp: r.dp }; } catch (e) { return 'ERR ' + e.message; } });
  L.say(`record at t+${tRec}: ${JSON.stringify(rec)}`);
  L.ck('the record carries the orders I gave', (rec?.ev ?? 0) > 0, '>0 events', rec?.ev);

  // the end-card buttons — do they exist where a player would look for them?
  L.say('\n--- the buttons a player would use ---');
  await ff(page, 200);
  const e = await ended(page);
  const hud = await page.evaluate(() => window.__HUD());
  L.say(`battle ended: ${JSON.stringify(e)}`);
  L.say(`end-card buttons: ${JSON.stringify(hud.result?.buttons)}`);
  L.ck('the end card offers Save replay and Copy replay link',
    (hud.result?.buttons ?? []).some(b => /save replay/i.test(b)) && (hud.result?.buttons ?? []).some(b => /copy replay/i.test(b)),
    'both buttons', JSON.stringify(hud.result?.buttons));
  // and does the button actually produce the same kind of thing?
  const tok2 = await page.evaluate(async () => { try { return await window.__game.replay.token(); } catch (x) { return 'ERR'; } });
  L.ck('a token is still obtainable from the end card', typeof tok2 === 'string' && tok2.length > 100,
    'a token', typeof tok2 === 'string' ? `${tok2.length} chars` : tok2);
  await shot(page, OUT, 'rp-01-endcard');
  await browser.close(); browser = null;

  // ------------------------------------------------------- 2. watch it back
  L.say('\n=== WATCHING IT BACK ===');
  const b2 = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
  const p2 = await b2.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const perr = [], cerr = [];
  p2.on('pageerror', x => { perr.push(String(x)); console.log('  !! PAGEERROR', String(x).slice(0, 200)); });
  p2.on('console', m => { if (m.type() === 'error') { cerr.push(m.text()); console.log('  !! CONSOLE', m.text().slice(0, 200)); } });
  const url = `${base}/?replay=${tok2}&from=${FROM.toFixed(6)}`;
  L.say(`URL length: ${url.length} chars`);
  await p2.goto(url, { waitUntil: 'domcontentloaded' });
  const gotReady = await p2.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 })
    .then(() => true).catch(() => false);
  L.ck('a replay URL boots', gotReady, 'ready', gotReady);
  if (gotReady) {
    await p2.waitForTimeout(1500);
    const menu = await p2.$('.menu-sheet');
    L.ck('a replay skips the menu', !menu, 'no menu sheet', menu ? 'the menu is up' : 'no menu');
    const bar = await p2.evaluate(() => {
      const b = document.querySelector('.rp-bar, [class*="rp-"]');
      const btn = document.querySelector('.rp-take');
      return { present: !!b, text: b ? b.textContent.replace(/\s+/g, ' ').trim() : null,
        classes: b ? b.className : null, takeButton: !!btn,
        takeText: btn ? btn.textContent.trim() : null };
    });
    L.say(`the replay bar: ${JSON.stringify(bar)}`);
    L.ck('the playback says it is a playback', bar.present, 'a replay strip on screen', bar.present ? bar.text : 'nothing');
    L.ck('there is a TAKE COMMAND button', bar.takeButton, 'a .rp-take button', bar.takeButton ? bar.takeText : 'absent');
    await p2.screenshot({ path: path.join(OUT, 'rp-02-playback.png') });

    // let it run to the takeover point
    await p2.evaluate((n) => window.__game.advanceTicks(n, 1000 / 60), Math.round(FROM * 30) + 60);
    await p2.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const bar2 = await p2.evaluate(() => {
      const b = document.querySelector('.rp-bar, [class*="rp-"]');
      return { text: b ? b.textContent.replace(/\s+/g, ' ').trim() : null, classes: b ? b.className : null,
        mode: window.__game.replay?.mode ?? null, diverged: window.__game.replay?.divergedAt ?? null };
    });
    L.say(`past t+${FROM}: ${JSON.stringify(bar2)}`);
    L.ck('the army is handed over at the ?from= point', bar2.mode === 'commanded',
      "mode 'commanded'", bar2.mode);
    L.ck('the strip says the army is mine now', /yours|command/i.test(bar2.text ?? ''),
      'a badge saying so', bar2.text);
    await p2.screenshot({ path: path.join(OUT, 'rp-03-taken.png') });

    // can I actually give an order now?
    await p2.evaluate(() => {
      const g = window.__game, ctx = g.engine.context;
      const V = new (ctx.camera.position.constructor)();
      window.__P = (x, y, z) => { V.set(x, y, z).project(ctx.camera); if (V.z > 1) return null;
        return { x: (V.x * 0.5 + 0.5) * ctx.viewW, y: (-V.y * 0.5 + 0.5) * ctx.viewH, z: V.z }; };
      window.__ctl = () => { const h = ctx.tryGet('hud'); return h ? h.controller : null; };
      window.__sel = () => { const c = window.__ctl(); return c ? c.model.selection.slice() : null; };
      window.__cur = () => { const c = window.__ctl(); const h = document.querySelector('.drag-hint');
        return { cursor: document.body.dataset.cur ?? '', hint: h && h.style.display !== 'none' ? h.textContent.trim() : '',
          hovered: c ? c.model.hoveredId : -2, sel: c ? c.model.selection.slice() : [] }; };
      window.__u = (id) => { const u = g.battle.unitById(id); if (!u) return null;
        const p = g.battle.pool; let n = 0, sy = 0;
        for (const i of u.members) { if (p.hp[i] <= 0) continue; n++; sy += p.y[i]; }
        return { id: u.id, type: u.typeId, faction: u.faction, alive: u.alive, order: u.order,
          x: Math.round(u.x * 100) / 100, z: Math.round(u.z * 100) / 100, meanY: n ? sy / n : null, n }; };
      window.__units = (f) => g.battle.units.filter(u => f === undefined || u.faction === f).map(u => window.__u(u.id));
      window.__box = (id) => { const u = g.battle.unitById(id), p = g.battle.pool;
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, n = 0;
        for (const i of u.members) { if (p.hp[i] <= 0) continue;
          for (const q of [window.__P(p.x[i], p.y[i], p.z[i]), window.__P(p.x[i], p.y[i] + 1.7, p.z[i])]) {
            if (!q) continue; n++; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); } }
        return { n, x0, x1, y0, y1 }; };
    });
    const c = (await p2.evaluate(() => window.__units(0))).filter(u => /cohort/.test(u.type) && u.alive > 20)[0];
    if (!c) L.ck('there is a unit of mine left to order', false, 'one', 'none');
    else {
      const s = await selectHard(p2, c.id, { zoom: 0.45 });
      L.ck('a unit can be selected after taking command', s.ok, 'selectable', s.ok ? 'yes' : (s.why ?? 'wrong unit'));
      if (s.ok) {
        const pt = await aim(p2, c.x, 1.6, c.z - 60, { zoom: 0.45 });
        const b4 = await p2.evaluate(i => window.__u(i), c.id);
        if (pt) {
          const dur = await rightClick(p2, pt, { hold: 350 });
          L.say(`  order after takeover: hint ${JSON.stringify(dur.hint)} cursor=${dur.cursor}`);
          await p2.evaluate((n) => window.__game.advanceTicks(n, 1000 / 60), 30 * 40);
          const af = await p2.evaluate(i => window.__u(i), c.id);
          const moved = Math.hypot(af.x - b4.x, af.z - b4.z);
          L.say(`  40 s later moved ${moved.toFixed(0)} m (x${b4.x}->${af.x} z${b4.z}->${af.z})`);
          L.ck('an order given after taking command is obeyed', moved > 10, '>10 m', `${moved.toFixed(0)} m`);
          const st = await p2.evaluate(() => ({ mode: window.__game.replay?.mode, div: window.__game.replay?.divergedAt,
            bar: document.querySelector('.rp-bar, [class*="rp-"]')?.textContent?.replace(/\s+/g, ' ').trim() }));
          L.say(`  replay state after my order: ${JSON.stringify(st)}`);
          L.ck('taking over is not reported as a divergence', st.div == null || st.div === -1,
            'no divergedAt', st.div);
        }
      }
    }
    await p2.screenshot({ path: path.join(OUT, 'rp-04-commanded.png') });
    L.ck('no page errors during playback', perr.length === 0, 0, perr.length);
    L.ck('no console errors during playback', cerr.length === 0, 0, cerr.length);
    if (cerr.length) L.say(`console: ${JSON.stringify(cerr.slice(0, 6))}`);
  }
  await b2.close();
  await dump(OUT, 'replay', { rows: L.rows, log: L.log, tokenChars: tok2?.length ?? 0 });
} catch (e) {
  L.ck('ran without throwing', false, 'no throw', String(e).slice(0, 400));
} finally { if (browser) await browser.close(); }
L.summary();
