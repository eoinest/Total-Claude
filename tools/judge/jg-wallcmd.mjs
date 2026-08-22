/**
 * COMMANDING A UNIT WHOSE MEN ARE ON STONE — the owner's report and the judge's §3 cell,
 * measured from the same mouse.
 *
 * The owner: *"still having some issues controling units that have scaled a wall once they
 * are on the wall. they get disconnected from their banner that allows me to control them.
 * and then they just generally just generally dont follow any instructions"*.
 *
 * The judge, playing through the real menu:
 *
 *     cohort 10 ON THE WALL   ->  escalade-party 16 ON THE WALL
 *         cursor=default   hovered=16   wallValid=false   hint=""
 *         30 s later: moved 0.0 m, order 6->6
 *
 * This is the reproduction, and it prints every input the cursor's decision is made from
 * rather than only its output — the selection, `wallValid`, `solidValid`, the intent, the
 * banner's own hit box, and the order bus. A cursor that offers nothing has exactly one
 * cause per pixel and the point of this file is to name it rather than infer it.
 *
 * **Aim at the men on the stone, not at the unit's mean.** The first cut aimed at
 * `meanY` over every living man, and for an escalade party with 62 of 83 still on the
 * rungs that is six metres below the walk and outside the masonry — so the ray met nothing,
 * `wallValid` was false honestly, and the measurement was of the instrument. Everything
 * here aims at the median position of the men who have `elevated` set.
 *
 *   node tools/judge/jg-wallcmd.mjs --port=5942 --map=campus-martius --seed=4265438264
 *   node tools/judge/jg-wallcmd.mjs --port=5942 --map=carthage        # the player storms
 */
import { argsOf, boot, ledger, shot, dump, ff, aim, hover, rightClick,
  leftClick, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const SEED = Number(A.get('seed') ?? 4265438264);
const PORT = Number(A.get('port') ?? 5942);
const MAP = A.get('map') ?? 'campus-martius';
const TILL = Number(A.get('till') ?? 400);
const OUT = path.join(ROOT, `screenshots/judge/wallcmd-${MAP}`);
const L = ledger(`commanding on stone — ${MAP}`);

/** Page-side helpers. Installed by source so every column is read in one synchronous turn. */
const HELPERS = () => {
  const g = window.__game;
  const ctx0 = g.engine.context;
  const med = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
  const t2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

  /** Median position of the men of `id` who are standing on stone, and how many there are. */
  window.__stone = (id) => {
    const u = g.battle.unitById(id); if (!u) return null;
    const p = g.battle.pool, e = g.battle.elevated;
    const xs = [], ys = [], zs = [];
    for (const i of u.members) {
      if (p.hp[i] <= 0 || !e || !e[i]) continue;
      xs.push(p.x[i]); ys.push(p.y[i]); zs.push(p.z[i]);
    }
    return { n: xs.length, x: t2(med(xs)), y: t2(med(ys)), z: t2(med(zs)) };
  };

  /** The plaque the player clicks: is it on screen, and does the hit test answer for it? */
  window.__plate = (id) => {
    const h = ctx0.tryGet('hud'), c = h ? h.controller : null;
    const b = document.querySelector(`.bnr[data-unit="${id}"]`);
    if (!b) return { present: false };
    const r = b.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    return { present: true, off: b.classList.contains('off'),
      opacity: b.style.opacity, x: cx, y: cy, w: Math.round(r.width),
      onScreen: cx > 0 && cx < ctx0.viewW && cy > 0 && cy < ctx0.viewH,
      hit: c && c.bannerAt ? c.bannerAt(cx, cy) : -2 };
  };

  /** Where the 3D standard is planted, against where the men actually are. */
  window.__standard = (id) => {
    const vfx = ctx0.tryGet('vfx');
    if (!vfx || !vfx.standardOf) return null;
    const V = new (ctx0.camera.position.constructor)();
    return vfx.standardOf(id, V) ? { x: t2(V.x), y: t2(V.y), z: t2(V.z) } : null;
  };

  /** Everything the cursor's decision is made from. */
  window.__PROBE = (selId, tgtId) => {
    const h = ctx0.tryGet('hud'), c = h ? h.controller : null;
    const s = g.battle.siege ?? null;
    const el = document.querySelector('.drag-hint');
    const view = (id) => { const m = c ? c.model.view(id) : null; return m
      ? { standY: t2(m.standY), cy: t2(m.cy), own: m.own, destroyed: m.destroyed } : null; };
    const u = (id) => { const v = g.battle.unitById(id); if (!v) return null;
      return { id, order: v.order, target: v.targetUnitId, x: t2(v.x), z: t2(v.z),
        alive: v.alive, kills: v.kills }; };
    return {
      cursor: document.body.dataset.cur ?? '',
      hint: el && el.style.display !== 'none' ? el.textContent.replace(/\s+/g, ' ').trim() : '',
      hovered: c ? c.model.hoveredId : -2,
      sel: c ? c.model.selection.slice() : null,
      wallValid: c ? c.wallValid : null,
      solidValid: c ? c.solidValid : null,
      groundValid: c ? c.groundValid : null,
      overBanner: c ? c.overBanner : null,
      overUi: c ? c.ptr.overUi : null,
      storming: c ? c.storming : null,
      onWallCount: c ? c.onWallCount : null,
      traverseRefusal: c ? c.traverseRefusal : null,
      intent: c && c.wallIntent ? (c.wallIntent() ?? 'null') : 'no controller',
      hostile: c && c.hostileUnder ? c.hostileUnder(c.model.hoveredId) : 'n/a',
      selView: selId >= 0 ? view(selId) : null,
      tgtView: tgtId >= 0 ? view(tgtId) : null,
      selUnit: selId >= 0 ? u(selId) : null,
      tgtUnit: tgtId >= 0 ? u(tgtId) : null,
      sim: s ? {
        selGarrisoned: selId >= 0 ? s.isGarrisoned(selId) : null,
        selWall: selId >= 0 ? s.unitWallState(selId) : null,
        tgtWall: tgtId >= 0 ? s.unitWallState(tgtId) : null,
      } : null,
      events: window.__EV ? window.__EV.splice(0) : [],
    };
  };

  /** Latch the order bus, so a refusal that never fires is visible as an empty list. */
  window.__EV = [];
  ctx0.events.on('orderIssued', (e) => window.__EV.push({ k: 'issued', kind: e.kind,
    ids: e.unitIds.slice(), x: t2(e.x), z: t2(e.z),
    target: e.targetUnitId ?? null, src: e.source ?? null }));
  ctx0.events.on('orderRefused', (e) => window.__EV.push({ k: 'refused', ...e }));
};

/** Who is standing on stone right now, from the sim rather than from a guess. */
const ONSTONE = () => {
  const g = window.__game, s = g.battle.siege;
  if (!s) return [];
  return g.battle.units.filter((u) => !u.destroyed && u.alive > 0).map((u) => {
    const w = s.unitWallState(u.id);
    return { id: u.id, t: u.typeId, f: u.faction, alive: u.alive,
      onWall: w.onWall, onGround: w.onGround, onLink: w.onLink,
      runs: w.runs, goal: w.goal, garr: s.isGarrisoned(u.id) };
  }).filter((r) => r.onWall > 0 || r.onLink > 0);
};

/** How many pixels over a unit's own drawn men answer with that unit's id. */
async function answerRate(page, id) {
  const box = await page.evaluate((i) => window.__box(i), id);
  if (!box || !isFinite(box.x0)) return { probes: 0, answering: 0, first: null };
  let probes = 0, answering = 0, first = null;
  for (let j = 0; j <= 6; j++) {
    const y = Math.round(box.y0 + (box.y1 - box.y0) * j / 6);
    for (let i = 0; i <= 8; i++) {
      const x = Math.round(box.x0 + (box.x1 - box.x0) * i / 8);
      if (x < 6 || x > 1594 || y < 110 || y > 760) continue;
      await page.mouse.move(x, y); await page.waitForTimeout(22);
      const h = await page.evaluate(() => window.__cur());
      probes++;
      if (h.hovered === id) { answering++; if (!first) first = { x, y }; }
    }
  }
  return { probes, answering, first, box };
}

let browser, page;
try {
  const r = await boot({ port: PORT, map: MAP, scenario: 'assault', tier: 'ultra',
    out: OUT, label: 'wc', seed: SEED });
  ({ browser, page } = r);
  await page.mouse.move(800, 770); await page.waitForTimeout(400);
  await page.click('.dep-begin'); await page.waitForTimeout(700);
  await page.evaluate((src) => {
    // eslint-disable-next-line no-eval
    (0, eval)(`(${src})`)();
  }, HELPERS.toString());

  // ---------------------------------------------------------- 1. wait for a lodgement
  // Sampled every 5 s: a lodgement lasts minutes, so 5 s cannot step over one.
  let t = 0, stone = [];
  while (t < TILL) {
    await ff(page, 5); t += 5;
    stone = await page.evaluate(ONSTONE);
    if (stone.some((s) => s.f !== 0 && s.onWall >= 8) && stone.some((s) => s.f === 0 && s.onWall >= 10)) break;
  }
  const T = await page.evaluate(() => Math.round(window.__game.simTime() * 10) / 10);
  L.say(`t+${T}: on the stone — ${JSON.stringify(stone)}`);
  const enemy = stone.filter((s) => s.f !== 0 && s.onWall >= 8).sort((a, b) => b.onWall - a.onWall);
  const mine = stone.filter((s) => s.f === 0 && s.onWall >= 10);
  L.ck('somebody of mine is on the wall', mine.length > 0, '>0', mine.length);
  L.ck('an enemy has a lodgement on the wall', enemy.length > 0, '>0', enemy.length);
  if (!mine.length || !enemy.length) throw new Error('no wall-on-wall pairing to test');

  // ------------------------------------ 2. survey: can each unit on stone be got hold of?
  L.say('\n=== 2. CAN I GET HOLD OF THEM? one camera per unit, its own drawn men ===');
  const survey = [];
  for (const s of stone) {
    const st = await page.evaluate((i) => window.__stone(i), s.id);
    if (!st || st.n === 0) continue;
    const p = await aim(page, st.x, st.y + 1.0, st.z, { zoom: 0.55 });
    if (!p) { L.say(`  unit ${s.id}: could not frame its men on the stone`); continue; }
    const rate = await answerRate(page, s.id);
    const plate = await page.evaluate((i) => window.__plate(i), s.id);
    const std = await page.evaluate((i) => window.__standard(i), s.id);
    const row = { id: s.id, f: s.f, type: s.t, onWall: s.onWall, onLink: s.onLink,
      menY: st.y, probes: rate.probes, answering: rate.answering,
      pct: rate.probes ? Math.round(rate.answering / rate.probes * 100) : 0,
      plate, standard: std, standardDropM: std ? Math.round((st.y - std.y) * 10) / 10 : null };
    survey.push(row);
    L.say(`  unit ${String(s.id).padStart(2)} f${s.f} ${s.t.padEnd(15)} men y${String(st.y).padStart(6)}`
      + `  pick ${String(rate.answering).padStart(2)}/${rate.probes} (${row.pct}%)`
      + `  plate ${plate.present ? (plate.off ? 'HIDDEN ' : 'shown  ') : 'ABSENT '}`
      + `hit=${plate.hit}  standard ${std ? `y${std.y} (${row.standardDropM} m below the men)` : 'none'}`);
  }
  const mineRows = survey.filter((s) => s.f === 0);
  const blind = mineRows.filter((s) => s.pct === 0);
  L.ck('every unit of mine on the wall answers the cursor somewhere on its own men',
    blind.length === 0, '0 blind units', `${blind.length} of ${mineRows.length}: ${JSON.stringify(blind.map((b) => b.id))}`);
  const lostPlate = survey.filter((s) => s.plate.present && (s.plate.off || s.plate.hit !== s.id));
  L.ck('every unit on the wall has a banner the player can click',
    lostPlate.length === 0, '0 without a usable plaque',
    `${lostPlate.length}: ${JSON.stringify(lostPlate.map((b) => ({ id: b.id, off: b.plate.off, hit: b.plate.hit })))}`);
  const sunk = survey.filter((s) => s.standardDropM !== null && s.standardDropM > 2);
  L.ck('every standard is planted with its own men, not in the ground under them',
    sunk.length === 0, '0 sunk standards',
    `${sunk.length}: ${JSON.stringify(sunk.map((b) => `${b.id}:${b.standardDropM}m`))}`);

  // ------------------------------------ 3. the pairing: mine on the wall, theirs on the wall
  L.say('\n=== 3. MINE ON THE WALL -> THEIRS ON THE WALL ===');
  const tgt = enemy[0];
  const ts = await page.evaluate((i) => window.__stone(i), tgt.id);
  const cands = [];
  for (const m of mine) {
    const s2 = await page.evaluate((i) => window.__stone(i), m.id);
    if (s2 && s2.n > 0) cands.push({ id: m.id, ...s2, d: Math.hypot(s2.x - ts.x, s2.z - ts.z) });
  }
  cands.sort((a, b) => a.d - b.d);
  const me = cands[0];
  L.say(`mine ${me.id} at x${me.x} z${me.z} y${me.y}  ->  theirs ${tgt.id} at x${ts.x} z${ts.z} y${ts.y}`
    + `   ${me.d.toFixed(0)} m apart`);

  // Select mine by the surest handle there is, then confirm from the model.
  const mp = await aim(page, me.x, me.y + 1.0, me.z, { zoom: 0.55 });
  const rate = await answerRate(page, me.id);
  if (rate.first) await leftClick(page, rate.first);
  else if (mp) await leftClick(page, mp);
  let st0 = await page.evaluate(([a, b]) => window.__PROBE(a, b), [me.id, tgt.id]);
  L.ck('the unit I am about to give an order to is selected', (st0.sel ?? []).includes(me.id),
    `[${me.id}]`, JSON.stringify(st0.sel));

  // Aim at their men on the stone and hold still: no fast-forward between here and the click.
  const tp = await aim(page, ts.x, ts.y + 1.0, ts.z, { zoom: 0.55 });
  L.ck('the enemy on the wall can be framed', !!tp, 'a screen point', tp);
  if (tp) {
    await hover(page, tp);
    const st = await page.evaluate(([a, b]) => window.__PROBE(a, b), [me.id, tgt.id]);
    L.say(`\nHOVER: cursor=${st.cursor} hovered=${st.hovered} hostile=${st.hostile} intent=${st.intent}`);
    L.say(`  wallValid=${st.wallValid} solidValid=${st.solidValid} groundValid=${st.groundValid}`
      + ` sel=${JSON.stringify(st.sel)} overBanner=${st.overBanner} onWallCount=${st.onWallCount}`
      + ` traverseRefusal="${st.traverseRefusal}" hint="${st.hint}"`);
    L.say(`  my view ${JSON.stringify(st.selView)}   their view ${JSON.stringify(st.tgtView)}`);
    L.ck('the cursor says something about an enemy standing on my own wall',
      st.cursor !== 'default' || st.hint !== '', 'attack / wall / refuse, or words', st.cursor);
    await shot(page, OUT, 'wc-hover-enemy');

    const before = st.selUnit;
    const dur = await rightClick(page, tp, { hold: 380 });
    L.say(`\nRIGHT-CLICK: during cursor=${dur.cursor} hint="${dur.hint}" hovered=${dur.hovered}`);
    await page.waitForTimeout(250);
    const st2 = await page.evaluate(([a, b]) => window.__PROBE(a, b), [me.id, tgt.id]);
    const local = st2.events.filter((e) => e.src !== 'ai');
    L.say(`  what went out: ${JSON.stringify(local)}`);
    L.ck('the order that went out is the order the cursor promised',
      local.some((e) => e.kind === 'attack') || local.some((e) => e.k === 'refused'),
      'an attack, or a refusal', JSON.stringify(local.map((e) => e.kind ?? e.refusal)));

    await ff(page, 30);
    const st3 = await page.evaluate(([a, b]) => window.__PROBE(a, b), [me.id, tgt.id]);
    const moved = Math.hypot(st3.selUnit.x - before.x, st3.selUnit.z - before.z);
    L.say(`  30 s later: moved ${moved.toFixed(1)} m, order ${before.order}->${st3.selUnit.order},`
      + ` kills ${before.kills}->${st3.selUnit.kills}, their alive ${before ? tgt.alive : '?'}->${st3.tgtUnit.alive}`);
    L.say(`  my wall state: ${JSON.stringify(st3.sim.selWall)}`);
    L.ck('an order aimed at an enemy on my wall does not walk my men off it',
      (st3.sim.selWall.onGround + st3.sim.selWall.onLink) < st3.sim.selWall.onWall * 0.25,
      'the garrison stays up there',
      `onWall ${st3.sim.selWall.onWall}, onLink ${st3.sim.selWall.onLink}, onGround ${st3.sim.selWall.onGround}, goal ${st3.sim.selWall.goal}`);
    L.ck('an order against an enemy on the wall is carried out or refused out loud',
      st3.selUnit.kills > before.kills || st2.events.some((e) => e.k === 'refused'),
      'blood, or a refusal', `kills +${st3.selUnit.kills - before.kills}, `
        + `refusals ${st2.events.filter((e) => e.k === 'refused').length}`);
    await shot(page, OUT, 'wc-after-order');
  }

  L.ck('no page errors', r.errs.length === 0, 0, r.errs.length);
  L.ck('no console errors', r.cerrs.length === 0, 0, r.cerrs.length);
  if (r.cerrs.length) L.say(`console: ${JSON.stringify(r.cerrs.slice(0, 6))}`);
  await dump(OUT, 'wallcmd', { seed: SEED, map: MAP, t: T, stone, survey, rows: L.rows, log: L.log });
} catch (e) {
  L.ck('the session ran without throwing', false, 'no throw', String(e).slice(0, 500));
  try { await shot(page, OUT, 'wc-crash'); } catch { /* nothing to photograph */ }
} finally { if (browser) await browser.close(); }
process.exit(L.summary() ? 1 : 0);
