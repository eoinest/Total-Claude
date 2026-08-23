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
import { argsOf, boot, ledger, shot, dump, ff, aim, cam, hover, rightClick,
  leftClick, boxSelect, selectHard, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const SEED = Number(A.get('seed') ?? 4265438264);
const PORT = Number(A.get('port') ?? 5942);
const MAP = A.get('map') ?? 'campus-martius';
const TILL = Number(A.get('till') ?? 400);
/** Skip the two arms that kill the lodgement, so §5 measures a live one. */
const SKIP_ORDERS = A.has('skiporders');
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
    /*
     * The **plate**, not the root. `.bnr` is transformed `translate(-50%,-100%)` so its
     * bottom sits on the anchor and its box extends upward by the whole height of the staff
     * — measured, 405 px at battle zoom. Its centre is therefore twenty metres of world
     * above the men and lands under the top bar, which is how a first attempt at this test
     * read "the plaque is not clickable" about a plaque that is perfectly clickable. The
     * thing a player aims at is the plate at the bottom of that box.
     */
    const pl = b.querySelector('.bnr-plate') ?? b;
    const r = pl.getBoundingClientRect();
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
      /** What the pick is scoring against, so a wrong answer can be arithmetic and not a guess. */
      mpp: t2(ctx0.rig.metresPerPixel(ctx0.viewH) * 7),
      sim: s ? {
        selGarrisoned: selId >= 0 ? s.isGarrisoned(selId) : null,
        selWall: selId >= 0 ? s.unitWallState(selId) : null,
        tgtWall: tgtId >= 0 ? s.unitWallState(tgtId) : null,
        selFile: selId >= 0 && s.wallFileOf ? s.wallFileOf(selId) : 'no wallFileOf',
        tgtFile: tgtId >= 0 && s.wallFileOf ? s.wallFileOf(tgtId) : 'no wallFileOf',
        /** The sim's own answer, which is what `interceptOrders` acts on. */
        assaultOffer: selId >= 0 && tgtId >= 0 && s.wallAssaultOfferAt
          ? s.wallAssaultOfferAt(selId, tgtId) : 'no wallAssaultOfferAt',
        probeHasFileOf: !!(c && c.wallProbe && c.wallProbe.fileOf),
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

/**
 * Put a unit's plaque somewhere the mouse can reach it, and say where.
 *
 * The plaque is not where the men are: `.bnr` is transformed `translate(-50%, -100%)` and
 * anchored on the *plaque plane*, so at battle zoom it floats hundreds of pixels above the
 * crowd and lands under the top bar — or off the top of the frame entirely — from any camera
 * that frames the men comfortably. Two readings of "the plaque is not clickable" in this file
 * were about that and not about the product. So the camera is walked along the wall until the
 * plate itself is in the band the pointer can use, and the band is stated: clear of the top
 * bar at 140 px and clear of the card bar at 700.
 */
async function framePlate(page, at, id) {
  for (const dz of [0, -25, 25, -50, 50, -90, 90, -140, 140]) {
    for (const zoom of [0.55, 0.42, 0.7]) {
      await cam(page, at.x, at.z + dz, zoom, 0);
      await page.waitForTimeout(200);
      const q = await page.evaluate((i) => window.__plate(i), id);
      if (q.present && !q.off && q.x > 40 && q.x < 1560 && q.y > 140 && q.y < 700) return q;
    }
  }
  return null;
}

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
    /*
     * `standardOf` reports the *top of the staff*, which is `CLOTH_TOP` = 2.38 m above the
     * anchor the standard is planted on. So a healthy reading is the men's feet plus about
     * 2.4 m; anything below their feet means the staff is inside the masonry under them.
     */
    const row = { id: s.id, f: s.f, type: s.t, onWall: s.onWall, onLink: s.onLink,
      menY: st.y, probes: rate.probes, answering: rate.answering,
      pct: rate.probes ? Math.round(rate.answering / rate.probes * 100) : 0,
      plate, standard: std, staffTopAboveFeet: std ? Math.round((std.y - st.y) * 10) / 10 : null };
    survey.push(row);
    L.say(`  unit ${String(s.id).padStart(2)} f${s.f} ${s.t.padEnd(15)} men y${String(st.y).padStart(6)}`
      + `  pick ${String(rate.answering).padStart(2)}/${rate.probes} (${row.pct}%)`
      + `  plate ${plate.present ? (plate.off ? 'HIDDEN ' : 'shown  ') : 'ABSENT '}`
      + `hit=${plate.hit}  staff top ${std ? `y${std.y} = ${row.staffTopAboveFeet} m above their feet` : 'none'}`);
  }
  const mineRows = survey.filter((s) => s.f === 0);
  const blind = mineRows.filter((s) => s.pct === 0);
  L.ck('every unit of mine on the wall answers the cursor somewhere on its own men',
    blind.length === 0, '0 blind units', `${blind.length} of ${mineRows.length}: ${JSON.stringify(blind.map((b) => b.id))}`);
  const lostPlate = survey.filter((s) => s.plate.present && (s.plate.off || s.plate.hit !== s.id));
  L.ck('every unit on the wall has a banner the player can click',
    lostPlate.length === 0, '0 without a usable plaque',
    `${lostPlate.length}: ${JSON.stringify(lostPlate.map((b) => ({ id: b.id, off: b.plate.off, hit: b.plate.hit })))}`);
  const sunk = survey.filter((s) => s.staffTopAboveFeet !== null
    && (s.staffTopAboveFeet < 0 || s.staffTopAboveFeet > 5));
  L.ck('every standard is planted with its own men, not in the ground under them',
    sunk.length === 0, '0 staffs outside 0-5 m above the men\'s feet',
    `${sunk.length}: ${JSON.stringify(sunk.map((b) => `${b.id}:${b.staffTopAboveFeet}m`))}`);
  const pick = mineRows.map((s) => s.pct);
  L.say(`  pick rate over my own men: ${JSON.stringify(pick)}  mean `
    + `${Math.round(pick.reduce((a, b) => a + b, 0) / Math.max(1, pick.length))}%`);

  /*
   * And the marquee, because that is the other half of "selectable" and it reads the same
   * box. A drag thrown over a cohort's own men on the parapet has to catch it.
   */
  {
    const m0 = mineRows[0];
    const st0 = await page.evaluate((i) => window.__stone(i), m0.id);
    await aim(page, st0.x, st0.y + 1.0, st0.z, { zoom: 0.55 });
    const b0 = await page.evaluate((i) => window.__box(i), m0.id);
    if (b0 && isFinite(b0.x0)) {
      const sel = await boxSelect(page,
        { x: Math.max(8, Math.round(b0.x0) - 10), y: Math.max(120, Math.round(b0.y0) - 10) },
        { x: Math.min(1592, Math.round(b0.x1) + 10), y: Math.min(740, Math.round(b0.y1) + 10) });
      L.ck(`a marquee over unit ${m0.id}'s men on the parapet catches it`,
        (sel ?? []).includes(m0.id), `includes ${m0.id}`, JSON.stringify(sel));
    }
  }

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

  /*
   * The two order-taking arms, which are also the two that destroy what they measure.
   *
   * §3 and §4 kill most of a lodgement — measured, 83 men down to 15 in 75 s — and by the
   * time §5 asks the sim who is standing on the wall the honest answer is "nobody", so
   * `wallAssaultOfferAt` returns `noWall` and three checks fail about a target this file
   * had itself removed. `--skiporders` runs the survey and the naming test against a fresh
   * lodgement instead; both runs are needed and neither is the whole picture.
   */
  const far = cands.filter((c) => c.d > 25).sort((a, bb) => a.d - bb.d)[0];
  if (!SKIP_ORDERS) {
    // Select mine the way a player does — men first, plaque if the men will not answer.
    const grab = await selectHard(page, me.id, { zoom: 0.55 });
    const st0 = await page.evaluate(([a, b]) => window.__PROBE(a, b), [me.id, tgt.id]);
    L.ck('the unit I am about to give an order to is selected', (st0.sel ?? []).includes(me.id),
      `[${me.id}]`, `${JSON.stringify(st0.sel)} after ${grab.clicks} click(s)`
        + `${grab.viaPlate ? ' (via the plaque)' : ''}`);

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
      L.say(`  slack=${st.mpp}  probeHasFileOf=${st.sim.probeHasFileOf}`);
      L.say(`  my file    ${JSON.stringify(st.sim.selFile)}`);
      L.say(`  their file ${JSON.stringify(st.sim.tgtFile)}`);
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
      L.say(`  the sim's own offer: ${JSON.stringify(st2.sim.assaultOffer)}`);
      /*
       * Either answer is honest here and the pixel decides which. My cohort and their lodgement
       * are standing on the same stone, so both boxes contain the cursor and both are the same
       * size to within a metre; whichever the pick returns, the order has to be one that
       * reaches them — `attack` on the unit, or the traverse onto the stone they are on.
       * §5 tests the route that is *not* a coin flip.
       */
      L.ck('the order that went out is the order the cursor promised',
        local.some((e) => e.kind === 'attack')
          || local.some((e) => e.k === 'refused')
          || (st.cursor === 'wall' && local.some((e) => e.kind === 'move')),
        'an attack, a refusal, or the traverse the cursor offered',
        `cursor ${st.cursor} -> ${JSON.stringify(local.map((e) => e.kind ?? e.refusal))}`);

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

    /*
     * ------------------------------------------------------- 4. AT A DISTANCE
     *
     * The pairing above is a melee already in progress: my men and theirs are interpenetrated
     * on the same stations, both boxes contain the cursor, and whichever answers, the traverse
     * that follows lands on the enemy anyway. That is not a test of the verb — it is a test of
     * a fight that was going to happen.
     *
     * This is the verb. A cohort of mine standing on a *different run* from the lodgement,
     * pointed at the lodgement's men. There are exactly two acceptable answers and the whole
     * of requirement 3 is that one of them happens: the file walks the wall and fights, or the
     * game says why it will not.
     */
    L.say('\n=== 4. AT A DISTANCE — a cohort on another run, sent at the lodgement ===');
    if (!far) {
      L.say('  no unit of mine is more than 25 m from the lodgement; nothing to test here');
    } else {
      const g4 = await selectHard(page, far.id, { zoom: 0.55 });
      void g4;
      const sel4 = await page.evaluate(() => window.__sel());
      L.ck(`unit ${far.id}, ${far.d.toFixed(0)} m along the wall, can be selected`,
        (sel4 ?? []).includes(far.id), `[${far.id}]`, JSON.stringify(sel4));
      const tp2 = await aim(page, ts.x, ts.y + 1.0, ts.z, { zoom: 0.55 });
      if (tp2 && (sel4 ?? []).includes(far.id)) {
        await hover(page, tp2);
        const h4 = await page.evaluate(([a, bb]) => window.__PROBE(a, bb), [far.id, tgt.id]);
        L.say(`  hover: cursor=${h4.cursor} hovered=${h4.hovered} hostile=${h4.hostile}`
          + ` intent=${h4.intent} wallValid=${h4.wallValid}`);
        /*
         * Two units on one stretch of stone are two claims on every pixel between them, and
         * when they are interlocked in a melee the claims are the same size to within a metre
         * — measured here, my cohort's file halfW 12.46 against the lodgement's 10.93, centres
         * 0.8 m apart. No tie-break on geometry can separate those honestly, and the game's own
         * answer to "pick one unit out of a pile" is the plaque, which §5 tests. What this cell
         * must not accept is *nothing*: the cursor has to offer an order that reaches them.
         */
        L.ck('the cursor offers an order that reaches the enemy on the wall',
          (h4.hovered === tgt.id && (h4.cursor === 'attack' || h4.cursor === 'refuse'))
            || (h4.cursor === 'wall' && h4.intent === 'traverse'),
          'attack / refuse on them, or a traverse onto their stone',
          `hovered ${h4.hovered}, cursor ${h4.cursor}, intent ${h4.intent}`);
        const b4 = h4.selUnit;
        await rightClick(page, tp2, { hold: 380 });
        await page.waitForTimeout(250);
        const e4 = await page.evaluate(([a, bb]) => window.__PROBE(a, bb), [far.id, tgt.id]);
        const mine4 = e4.events.filter((ev) => ev.src !== 'ai');
        L.say(`  what went out: ${JSON.stringify(mine4)}`);
        L.say(`  the sim's own offer: ${JSON.stringify(e4.sim.assaultOffer)}`);
        L.say(`  wall state now: ${JSON.stringify(e4.sim.selWall)}`);
        const refused = mine4.some((ev) => ev.k === 'refused');
        L.ck('the order opens a plan that reaches them, or is refused out loud',
          e4.sim.selWall.goal === 'assault' || e4.sim.selWall.goal === 'traverse' || refused,
          'goal assault or traverse, or an orderRefused',
          `goal ${e4.sim.selWall.goal}, refusals ${refused}`);
        await ff(page, 45);
        const a4 = await page.evaluate(([a, bb]) => window.__PROBE(a, bb), [far.id, tgt.id]);
        const closed = far.d - Math.hypot(a4.selUnit.x - ts.x, a4.selUnit.z - ts.z);
        L.say(`  45 s later: closed ${closed.toFixed(0)} of ${far.d.toFixed(0)} m,`
          + ` kills ${b4.kills}->${a4.selUnit.kills}, their alive ${e4.tgtUnit.alive}->${a4.tgtUnit.alive}`);
        L.say(`  wall state: ${JSON.stringify(a4.sim.selWall)}`);
        L.ck('an assault accepted at a distance actually closes on them',
          refused || closed > Math.min(20, far.d * 0.4) || a4.selUnit.kills > b4.kills,
          refused ? 'refused, so nothing to close' : `>${Math.min(20, far.d * 0.4).toFixed(0)} m or blood`,
          `${closed.toFixed(0)} m, kills +${a4.selUnit.kills - b4.kills}`);
        await shot(page, OUT, 'wc-assault-distance');
      }
    }

    /*
     * -------------------------------------------- 5. BY THE PLAQUE, AND THE REFUSAL
     *
     * Two units on one stretch of stone are two claims on every pixel between them, and this
     * game already has an answer to that: `src/ui/Banners.ts` — *"the banner is the thing a
     * player aims at to pick a unit out of a melee"* — and `pickUnit` tests the plaque before
     * it tests the ground. So the plaque is the route to "attack **them**", and
     * `hostileUnder` names it as one of the three ways an attack beats a wall order.
     *
     * Then the refusal. Rome's circuit is four disconnected components (runs 0-1, 2-18, 19-24,
     * 25-44), so a cohort on run 0 has no walk to a lodgement on run 2 however short the line
     * between them looks. There is exactly one acceptable answer and it is a sentence.
     */
  }
  L.say('\n=== 5. BY THE PLAQUE, AND THE REFUSAL ===');
  {
    /*
     * A **live** lodgement, re-read now rather than reused from §3.
     *
     * The first version of this section kept pointing at unit 17, and by the time it got
     * there §3 and §4 had killed 65 of its 83 men and driven the survivors back onto the
     * rungs — `wallFileOf` null, so `wallAssaultOfferAt` answered `noWall`, which is the
     * correct answer to "attack those men on the wall" about men who are not on the wall.
     * Three failures in a row, all of them the fixture measuring a target it had itself
     * destroyed. This asks the sim who is on the stone *now*.
     */
    const now5 = await page.evaluate(ONSTONE);
    const live = now5.filter((x) => x.f !== 0 && x.onWall >= 5).sort((a, bb) => bb.onWall - a.onWall)[0];
    if (!live) { L.say('  no enemy is on the stone any more; nothing to point at'); }
    else if (live.id !== tgt.id) {
      L.say(`  the lodgement of §3 is off the stone; pointing at unit ${live.id} instead`
        + ` (${live.onWall} men up)`);
    }
    if (live) { tgt.id = live.id; tgt.runs = live.runs; }
    const ts2 = live ? await page.evaluate((i) => window.__stone(i), live.id) : null;
    if (ts2) { ts.x = ts2.x; ts.y = ts2.y; ts.z = ts2.z; }
    /*
     * The refusal first, and the order matters.
     *
     * The assault below works — measured, 42 of them down to 15 in 40 s — and that is
     * exactly why it cannot run first: it clears the lodgement off the stone, and
     * `wallAssaultOfferAt` then correctly answers `noWall` about men who are no longer on
     * the wall. Two runs of this file reported "no refusal" about a target the file had
     * itself killed.
     */
    // The refusal: a cohort on a component of the circuit the lodgement is not on.
    const other = !live ? null : (await Promise.all(mine.map(async (m) => {
      const st = await page.evaluate((i) => window.__stone(i), m.id);
      const w = stone.find((x) => x.id === m.id);
      return { id: m.id, run: w.runs[0], ...st };
    }))).find((c) => c.run <= 1 && (tgt.runs?.[0] ?? 2) > 1);
    if (!other) { L.say('  no unit of mine on a severed component; the refusal is untested here'); }
    else {
      const g6 = await selectHard(page, other.id, { zoom: 0.55 });
      const plate2 = await framePlate(page, ts, tgt.id);
      L.say(`  selected ${other.id} on run ${other.run} (${g6.ok ? 'ok' : g6.why});`
        + ` their plaque ${JSON.stringify(plate2)}`);
      if (g6.ok && plate2) {
        await hover(page, { x: plate2.x, y: plate2.y });
        const h6 = await page.evaluate(([a, bb]) => window.__PROBE(a, bb), [other.id, tgt.id]);
        L.say(`  cursor=${h6.cursor} hovered=${h6.hovered} hint="${h6.hint}"`);
        await rightClick(page, { x: plate2.x, y: plate2.y }, { hold: 420 });
        await page.waitForTimeout(250);
        const e6 = await page.evaluate(([a, bb]) => window.__PROBE(a, bb), [other.id, tgt.id]);
        const mine6 = e6.events.filter((ev) => ev.src !== 'ai');
        L.say(`  what went out: ${JSON.stringify(mine6)}`);
        L.say(`  the sim's own offer: ${JSON.stringify(e6.sim.assaultOffer)}`);
        L.say(`  their file: ${JSON.stringify(e6.sim.tgtFile)}`);
        L.ck('an attack across a severed walk is refused out loud, with a reason',
          mine6.some((ev) => ev.k === 'refused' && ev.refusal === 'noRoute'),
          "an orderRefused carrying 'noRoute'",
          JSON.stringify(mine6.filter((ev) => ev.k === 'refused')));
        L.ck('and the cursor said so before the click',
          h6.cursor === 'refuse', 'refuse', `${h6.cursor} (hovered ${h6.hovered})`);
      }
    }

    const actor = far ?? me;
    const g5 = await selectHard(page, actor.id, { zoom: 0.55 });
    /*
     * Frame the *target* before reading its plaque, and this is the instrument's own bug
     * caught by its own output. `selectHard` leaves the camera on the unit it just picked
     * up; read from there, unit 17's plaque sat at screen y 24 — **under the top bar** — so
     * `ptr.overUi` was true, `pickUnit` returned -1, `model.hoveredId` stayed stale at the
     * actor's own id and the right-click emitted nothing. Every one of those readings was
     * about where the camera was pointing and none of them was about the product.
     */
    const plate = live ? await framePlate(page, ts, tgt.id) : null;
    L.say(`  selected ${actor.id} (${g5.ok ? 'ok' : g5.why}); their plaque ${JSON.stringify(plate)}`);
    if (live) {
      L.ck('an enemy on the wall has a plaque the mouse can reach', !!plate,
        'a plate in the clickable band', plate ? `${plate.x},${plate.y}` : 'nowhere from any camera');
    }
    if (g5.ok && plate && plate.hit === tgt.id) {
      await hover(page, { x: plate.x, y: plate.y });
      const h5 = await page.evaluate(([a, bb]) => window.__PROBE(a, bb), [actor.id, tgt.id]);
      L.say(`  over their plaque: cursor=${h5.cursor} hovered=${h5.hovered} hostile=${h5.hostile}`
        + ` overBanner=${h5.overBanner}`);
      L.ck('their own plaque names them',
        h5.hovered === tgt.id, tgt.id, h5.hovered);
      const b5 = h5.selUnit;
      await rightClick(page, { x: plate.x, y: plate.y }, { hold: 380 });
      await page.waitForTimeout(250);
      const e5 = await page.evaluate(([a, bb]) => window.__PROBE(a, bb), [actor.id, tgt.id]);
      const mine5 = e5.events.filter((ev) => ev.src !== 'ai');
      L.say(`  what went out: ${JSON.stringify(mine5)}`);
      L.say(`  the sim's own offer: ${JSON.stringify(e5.sim.assaultOffer)}`);
      L.say(`  wall state: ${JSON.stringify(e5.sim.selWall)}`);
      L.ck('right-clicking an enemy plaque on the wall is an attack order',
        mine5.some((ev) => ev.kind === 'attack'), 'kind attack', JSON.stringify(mine5.map((ev) => ev.kind ?? ev.refusal)));
      L.ck('and the simulation takes it as an assault along the wall, or refuses it out loud',
        e5.sim.selWall.goal === 'assault' || mine5.some((ev) => ev.k === 'refused'),
        'goal assault, or an orderRefused',
        `goal ${e5.sim.selWall.goal}, refusals ${JSON.stringify(mine5.filter((ev) => ev.k === 'refused'))}`);
      await ff(page, 40);
      const a5 = await page.evaluate(([a, bb]) => window.__PROBE(a, bb), [actor.id, tgt.id]);
      L.say(`  40 s later: kills ${b5.kills}->${a5.selUnit.kills}, their alive`
        + ` ${e5.tgtUnit.alive}->${a5.tgtUnit ? a5.tgtUnit.alive : 'gone'},`
        + ` wall ${JSON.stringify(a5.sim.selWall)}`);
      await shot(page, OUT, 'wc-plaque-assault');
    } else {
      L.say('  their plaque is not a usable target from this camera; nothing to test');
    }

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
