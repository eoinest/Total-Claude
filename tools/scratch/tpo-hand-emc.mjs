/**
 * The hand pass: a docked tower's party, commanded with a real mouse through the real menu.
 *
 * The owner's two sentences, tested in his order. *They should be able to be moved around
 * freely* — send the gang along the parapet. *And attack other units on top of the wall* —
 * right-click a defender standing on the stone. Everything below is a real pointer event on
 * a page booted at `?autoplay=0` through the menu; nothing here calls a siege verb and
 * nothing emits `orderIssued`.
 *
 * Run `--label=before` against the base SHA and `--label=after` against the fix. The acts are
 * ordered so the positive test happens while the gang is still eighty men: by the time the
 * levy has closed on them they are routing, and a rout is not a measurement of the order
 * layer.
 *
 *   node tools/scratch/tpo-hand-emc.mjs --port=5613 --label=after
 */
import { argsOf, boot, shot, dump, fast, hover, leftClick, aim,
  selectHard, wallPixel, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';

const A = argsOf();
const PORT = Number(A.get('port') ?? 5613);
const LABEL = A.get('label') ?? 'before';
const OUT = path.join(ROOT, 'screenshots/tower-party', LABEL);
const CREW = Number(A.get('crew') ?? 14);
const RAMPDOWN = Number(A.get('rampdown') ?? 15);

const log = [];
const out = {};
const say = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(s); log.push(s);
};

const { browser, page, errs, cerrs } = await boot({ port: PORT, map: 'carthage', out: OUT, label: LABEL });
await installDiag(page);

await page.evaluate(() => {
  const txt = (sel) => {
    const e = document.querySelector(sel);
    return e && e.style.display !== 'none' ? (e.textContent ?? '') : '';
  };
  /** Both hint layers and both cursor attributes, in one read. */
  window.__cur2 = () => {
    const c = window.__ctl(); const s = window.__siege();
    return {
      cur: document.body.dataset.cur ?? '',
      siegecur: document.body.dataset.siegecur ?? '',
      dragHint: txt('.drag-hint'),
      siegeHint: txt('.siege-hint'),
      hovered: c ? c.model.hoveredId : -2,
      sel: c ? c.model.selection.slice() : [],
      wallValid: c ? c.wallValid : null,
      wallX: c ? +c.wallX.toFixed(2) : null,
      wallZ: c ? +c.wallZ.toFixed(2) : null,
      // Where the order will actually be *sent*, and whether the sim reads that as wall.
      orderX: c ? +c.orderX.toFixed(2) : null,
      orderZ: c ? +c.orderZ.toFixed(2) : null,
      orderIsWall: c && s ? s.wallTargetAt(c.orderX, c.orderZ) >= 0 : null,
    };
  };
  window.__ask = (id, x, z) => {
    const s = window.__siege(); if (!s) return null;
    return {
      machineOrderAt: s.machineOrderAt(id, x, z),
      machineDestinationOf: s.machineDestinationOf(id),
      escaladeOfferAt: s.escaladeOfferAt(id, x, z),
      traverseOfferAt: s.traverseOfferAt ? s.traverseOfferAt(id, x, z) : 'n/a',
      crewStatus: s.crewStatusOf ? s.crewStatusOf(id) : 'n/a',
      wallState: s.unitWallState(id),
      garrisoned: s.isGarrisoned(id),
      owns: s.ownsUnit(id),
    };
  };
  window.__towers = () => {
    const s = window.__siege(); const raw = s.towers ?? [];
    return s.towerReport().map((t, i) => ({ id: t.id, state: t.state, docked: t.docked,
      crossed: t.crossed, queued: t.queued, unitId: raw[i]?.unitId ?? null,
      x: +t.x.toFixed(1), z: +t.z.toFixed(1) }));
  };
  window.__tape = [];
  window.__game.engine.events.on('orderIssued', (p) =>
    window.__tape.push(JSON.parse(JSON.stringify(p ?? {}))));
  window.__mark = () => window.__tape.length;
  window.__since = (n, id) => window.__tape.slice(n)
    .filter((e) => (e.unitIds ?? []).includes(id));
});

/** One right-click, held long enough to read the hint, then released. */
const order = async (id, pt) => {
  const mark = await page.evaluate(() => window.__mark());
  await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(60);
  await page.mouse.down({ button: 'right' }); await page.waitForTimeout(420);
  const held = await page.evaluate(() => window.__cur2());
  await page.mouse.up({ button: 'right' }); await page.waitForTimeout(220);
  const sent = await page.evaluate(([n, i]) => window.__since(n, i), [mark, id]);
  return { held, sent };
};
const brief = (h) => ({ cur: h.cur, siegecur: h.siegecur, drag: h.dragHint, siege: h.siegeHint });

await page.mouse.move(800, 720); await page.waitForTimeout(200);
const bays = await page.evaluate(() => window.__bays());
const bayNear = (x, z) => bays.filter((b) => b.garr)
  .reduce((best, b) => (Math.hypot(b.cx - x, b.cz - z) < Math.hypot(best.cx - x, best.cz - z) ? b : best));
await page.click('.dep-begin'); await page.waitForTimeout(700);

// ============================================================== act 0
say(`\n=== 0  the ramp is down and the gang is still on the grass at the foot of it`);
await fast(page, 200);
say('towers t+200:', await page.evaluate(() => window.__towers()));
{
  const s0 = await selectHard(page, RAMPDOWN, { zoom: 0.5 });
  say(`select gang ${RAMPDOWN}:`, s0.ok ? 'OK' : `FAILED ${s0.why}`);
  const me = await page.evaluate((i) => window.__u(i), RAMPDOWN);
  const b = bayNear(me.x, me.z);
  const t = bays.find((x) => x.i === b.i + 2 && x.garr) ?? b;
  say('their bay / the bay two along:', b.i, t.i);
  const wp = await wallPixel(page, t, { side: 1, zoom: 0.62 });
  if (s0.ok && wp.p) {
    await hover(page, wp.p);
    const h = await page.evaluate(() => window.__cur2());
    say('HOVER  ', brief(h));
    say('HOVER  sim says:', await page.evaluate(([i, x, z]) => window.__ask(i, x, z), [RAMPDOWN, h.wallX, h.wallZ]));
    await shot(page, OUT, `${LABEL}-00-ramp-down`);
    out.act0 = { hover: h };
  } else say('no wall pixel — could not aim');
}

await fast(page, 90);
say('towers t+290:', await page.evaluate(() => window.__towers()));
say(`gang ${CREW}:`, await page.evaluate((i) => window.__u(i), CREW));
say(`gang ${CREW} wall state:`, await page.evaluate((i) => window.__wallState(i), CREW));
await shot(page, OUT, `${LABEL}-01-on-the-wall`);

const me0 = await page.evaluate((i) => window.__u(i), CREW);
const ownBay = bayNear(me0.x, me0.z);
say('the bay they are standing on:', ownBay.i);
const reach = await page.evaluate(([i, list]) => list.map((b) => {
  const s = window.__siege();
  const o = s.traverseOfferAt ? s.traverseOfferAt(i, b.cx, b.cz) : null;
  return { i: b.i, ok: o ? o.ok : null, why: o ? o.refusal : null };
}), [CREW, bays.filter((b) => b.garr && Math.abs(b.i - ownBay.i) <= 6 && b.i !== ownBay.i)]);
say('traverseOfferAt around them:', reach);

// ============================================================== act 1
say(`\n=== 1  MOVE, to a bay the walk does reach`);
const good = reach.filter((r) => r.ok).sort((a, b) =>
  Math.abs(a.i - ownBay.i) - Math.abs(b.i - ownBay.i))[0];
say('nearest reachable bay:', good ? good.i : 'NONE');
if (good) {
  const gb = bays.find((b) => b.i === good.i);
  const s1 = await selectHard(page, CREW, { zoom: 0.5 });
  say('select the gang:', s1.ok ? `OK (${s1.easy ? 'first click' : `hunted ${s1.answering}/${s1.probes} px`})` : `FAILED ${s1.why}`);
  const wp = await wallPixel(page, gb, { side: 1, zoom: 0.62 });
  say(`bay ${gb.i}: ${wp.hit}/${wp.tried} probed pixels read as a wall order`);
  if (s1.ok && wp.p) {
    await hover(page, wp.p);
    const h = await page.evaluate(() => window.__cur2());
    say('HOVER  ', brief(h), 'order point is wall:', h.orderIsWall);
    await shot(page, OUT, `${LABEL}-02-hover-reachable`);
    const { held, sent } = await order(CREW, wp.p);
    say('HELD   ', brief(held));
    say('CLICK  order:', sent);
    await shot(page, OUT, `${LABEL}-03-ordered`);
    const w0 = await page.evaluate((i) => window.__wallState(i), CREW);
    await fast(page, 3);
    const w1 = await page.evaluate((i) => window.__wallState(i), CREW);
    const u1 = await page.evaluate((i) => window.__u(i), CREW);
    await fast(page, 45);
    const w2 = await page.evaluate((i) => window.__wallState(i), CREW);
    const u2 = await page.evaluate((i) => window.__u(i), CREW);
    say('wall state at the click :', w0);
    say('wall state 3 s later    :', w1);
    say('wall state 48 s later   :', w2);
    say('they moved:', { from: [u1.x, u1.z], to: [u2.x, u2.z],
      metres: +Math.hypot(u2.x - u1.x, u2.z - u1.z).toFixed(1),
      alive: [u1.alive, u2.alive], order: [u1.order, u2.order] });
    out.act1 = { bay: gb.i, hover: h, held, sent, w0, w1, w2, u1, u2 };
    await shot(page, OUT, `${LABEL}-04-traversed`);
  }
}

// ============================================================== act 2
say(`\n=== 2  MOVE, to a bay the walk does NOT reach — the refusal the player must read`);
const bad = reach.filter((r) => r.ok === false).sort((a, b) =>
  Math.abs(a.i - ownBay.i) - Math.abs(b.i - ownBay.i))[0];
say('nearest unreachable bay:', bad ? `${bad.i} (${bad.why})` : 'NONE');
if (bad) {
  const bb = bays.find((b) => b.i === bad.i);
  const s2 = await selectHard(page, CREW, { zoom: 0.5 });
  const wp = await wallPixel(page, bb, { side: 1, zoom: 0.62 });
  if (s2.ok && wp.p) {
    await hover(page, wp.p);
    const h = await page.evaluate(() => window.__cur2());
    say('HOVER  ', brief(h));
    say('HOVER  sim says:', await page.evaluate(([i, x, z]) => window.__ask(i, x, z), [CREW, h.wallX, h.wallZ]));
    await shot(page, OUT, `${LABEL}-05-hover-unreachable`);
    const { held, sent } = await order(CREW, wp.p);
    say('HELD   ', brief(held));
    say('CLICK  order:', sent);
    await fast(page, 5);
    say('wall state 5 s later:', await page.evaluate((i) => window.__wallState(i), CREW));
    out.act2 = { bay: bb.i, hover: h, held, sent };
    await shot(page, OUT, `${LABEL}-06-refused`);
  } else say(`could not aim at bay ${bad.i}: select ${s2.ok}, pixel ${!!wp.p}`);
}

// ============================================================== act 3
say(`\n=== 3  ATTACK a defender standing on the same wall`);
const me1 = await page.evaluate((i) => window.__u(i), CREW);
const foes = await page.evaluate(() => {
  const s = window.__siege(); const g = window.__game;
  return g.battle.units.filter((u) => u.faction !== 0 && !u.destroyed && u.alive > 0)
    .map((u) => ({ ...window.__u(u.id), ws: s.unitWallState(u.id) }))
    .filter((u) => u.ws.onWall > 0);
});
foes.sort((a, b) => Math.hypot(a.x - me1.x, a.z - me1.z) - Math.hypot(b.x - me1.x, b.z - me1.z));
say('nearest defenders on the stone:', foes.slice(0, 3).map((f) => ({ id: f.id, type: f.type,
  alive: f.alive, d: +Math.hypot(f.x - me1.x, f.z - me1.z).toFixed(1) })));
const foe = foes[0];
if (foe) {
  const s3 = await selectHard(page, CREW, { zoom: 0.5 });
  say('select the gang:', s3.ok ? 'OK' : `FAILED ${s3.why}`);
  const p = await aim(page, foe.x, (foe.meanY ?? 0) + 0.4, foe.z, { zoom: 0.55 });
  if (s3.ok && p) {
    await hover(page, p);
    const h = await page.evaluate(() => window.__cur2());
    say('HOVER  over defender', foe.id, brief(h), 'hovered:', h.hovered);
    await shot(page, OUT, `${LABEL}-07-hover-foe`);
    const { held, sent } = await order(CREW, p);
    say('HELD   ', brief(held));
    say('CLICK  order:', sent);
    const u0 = await page.evaluate((i) => window.__u(i), CREW);
    const f0 = await page.evaluate((i) => window.__u(i), foe.id);
    await fast(page, 45);
    const u1 = await page.evaluate((i) => window.__u(i), CREW);
    const f1 = await page.evaluate((i) => window.__u(i), foe.id);
    say('gang  before / 45 s after:', { kills: [u0.kills, u1.kills], alive: [u0.alive, u1.alive] });
    say('foe   before / 45 s after:', { alive: [f0.alive, f1.alive] });
    out.act3 = { foe: foe.id, hover: h, held, sent, u0, u1, f0, f1 };
    await shot(page, OUT, `${LABEL}-08-attacking`);
  } else say('could not frame the defender');
}

// ============================================================== act 4
say(`\n=== 4  a LADDER PARTY told to storm — the order the old report says is discarded`);
const parties = await page.evaluate(() => {
  const g = window.__game, s = window.__siege();
  const owners = new Set((s.ladders ?? []).map((l) => l.unitId));
  return g.battle.units.filter((u) => u.faction === 0 && !u.destroyed && u.alive > 0
    && (owners.has(u.id) || String(u.typeId).includes('escalade')))
    .map((u) => ({ ...window.__u(u.id), ws: s.unitWallState(u.id), owns: s.ownsUnit(u.id) }));
});
say('own ladder parties:', parties.map((p) => ({ id: p.id, type: p.type, alive: p.alive,
  onWall: p.ws.onWall, onGround: p.ws.onGround })));
const party = parties.filter((p) => p.ws.onWall === 0 && p.alive > 5)[0] ?? parties[0];
if (party) {
  const pb = bayNear(party.x, party.z);
  say(`party ${party.id} (${party.type}) stands off bay ${pb.i}`);
  const s4 = await selectHard(page, party.id, { zoom: 0.5 });
  say('select:', s4.ok ? 'OK' : `FAILED ${s4.why}`);
  const wp = await wallPixel(page, pb, { side: 1, zoom: 0.62 });
  if (s4.ok && wp.p) {
    await hover(page, wp.p);
    const h = await page.evaluate(() => window.__cur2());
    say('HOVER  ', brief(h));
    say('HOVER  sim says:', await page.evaluate(([i, x, z]) => window.__ask(i, x, z), [party.id, h.wallX, h.wallZ]));
    await shot(page, OUT, `${LABEL}-09-hover-ladder`);
    const { held, sent } = await order(party.id, wp.p);
    say('HELD   ', brief(held));
    say('CLICK  order:', sent);
    const p0 = await page.evaluate((i) => window.__wallState(i), party.id);
    await fast(page, 120);
    const p1 = await page.evaluate((i) => window.__wallState(i), party.id);
    say('party wall state at the click:', p0);
    say('party wall state 120 s later :', p1);
    out.act4 = { id: party.id, bay: pb.i, hover: h, held, sent, p0, p1 };
    await shot(page, OUT, `${LABEL}-10-ladder`);
  } else say(`could not aim: select ${s4.ok}, pixel ${!!wp.p}`);
}

say(`\npageerrors: ${errs.length}  consoleerrors: ${cerrs.length}`);
await dump(OUT, `${LABEL}-log`, { log, ...out, errs, cerrs });
await browser.close();
