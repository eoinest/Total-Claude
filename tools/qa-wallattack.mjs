#!/usr/bin/env node
/**
 * QA: can the player attack men standing on a parapet — and is ordinary ground picking
 * still what it was.
 *
 * Two halves, and the second is the guard rail. A previous attempt at solid picking was
 * reverted because it collapsed every ground click onto one box 42-92 m from where the
 * player pointed, so any change to the pick has to prove, with numbers, that a click on
 * open ground still lands where it is aimed.
 *
 * Everything here is a real pointer event: no `orderIssued` is emitted by this file and no
 * siege verb is called.
 *
 * Usage: node tools/qa-wallattack.mjs --port=5477 --map=carthage [--json=path] [--shots=dir]
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const MAP = args.get('map') ?? 'carthage';
const JSON_OUT = args.get('json') ?? null;
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;

const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }
console.log(`• dev server ${base}   map ${MAP}`);

const results = [];
let failed = 0;
const record = (name, pass, what, changed, note = '') => {
  results.push({ name, pass, what, changed, note });
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ${what}`);
  console.log(`        -> ${changed}${note ? `  [${note}]` : ''}`);
};

const INSTALL = () => {
  const g = window.__game, ctx = g.engine.context;
  window.__tape = [];
  g.engine.events.on('orderIssued', (p) => window.__tape.push(JSON.parse(JSON.stringify(p ?? {}))));
  window.__mark = () => window.__tape.length;
  window.__ordersFor = (n, ids) => window.__tape.slice(n)
    .filter((e) => (e.unitIds ?? []).some((i) => ids.includes(i)));
  window.__ctl = () => ctx.tryGet('hud')?.controller ?? null;
  const V = new (ctx.camera.position.constructor)();
  window.__project = (x, y, z) => {
    V.set(x, y, z).project(ctx.camera);
    if (V.z > 1) return null;
    return { x: (V.x * 0.5 + 0.5) * ctx.viewW, y: (-V.y * 0.5 + 0.5) * ctx.viewH };
  };
  /** The men's own centroid on screen — where a player aims, not a lifted anchor. */
  window.__aim = (id) => {
    const c = window.__ctl(), v = c ? c.model.view(id) : null;
    if (!v) return null;
    const p = g.battle.pool;
    let n = 0, sx = 0, sz = 0, sy = 0;
    for (const i of v.unit.members) { if (!p.aliveAt(i)) continue; n++; sx += p.x[i]; sz += p.z[i]; sy += p.y[i]; }
    return n ? window.__project(sx / n, sy / n + 0.9, sz / n) : null;
  };
  /** The centre of a unit's banner plaque, in CSS pixels, or null. */
  window.__bannerPx = (id) => {
    const hud = ctx.tryGet('hud');
    const b = hud?.banners?.items?.find((k) => k.view.id === id && k.hit);
    return b ? { x: (b.hx0 + b.hx1) / 2, y: (b.hy0 + b.hy1) / 2, w: b.hx1 - b.hx0, h: b.hy1 - b.hy0 } : null;
  };
  window.__hovered = () => window.__ctl()?.model.hoveredId ?? -2;
  window.__selected = () => window.__ctl()?.model.selection.slice() ?? [];
  window.__overUi = () => { const c = window.__ctl(); return c && c.ptr ? !!c.ptr.overUi : null; };
  window.__cursor = () => {
    const c = window.__ctl();
    if (!c) return null;
    return {
      kind: c.cursor, hoveredId: c.model.hoveredId, selection: c.model.selection.slice(),
      groundValid: c.groundValid, groundX: +c.groundX.toFixed(2), groundZ: +c.groundZ.toFixed(2),
      solidValid: c.solidValid, solidX: +c.solidX.toFixed(2), solidY: +c.solidY.toFixed(2),
      solidZ: +c.solidZ.toFixed(2),
      wallValid: c.wallValid, wallX: +c.wallX.toFixed(2), wallZ: +c.wallZ.toFixed(2),
      orderValid: c.orderValid, orderX: +c.orderX.toFixed(2), orderZ: +c.orderZ.toFixed(2),
      hint: document.querySelector('.drag-hint')?.textContent ?? '',
      hintShown: (() => { const h = document.querySelector('.drag-hint'); return !!h && h.style.display !== 'none'; })(),
      dragTarget: c.dragTarget,
    };
  };
  window.__unitInfo = (id) => {
    const s = g.battle.siege, u = g.battle.unitById(id);
    if (!u) return null;
    return { id, typeId: u.typeId, faction: u.faction, alive: u.alive, order: u.order,
      targetUnitId: u.targetUnitId, x: +u.x.toFixed(1), z: +u.z.toFixed(1),
      garrisoned: s.isGarrisoned(id), side: s.wallSideAt(u.x, u.z) };
  };
  window.__units = () => g.battle.units.filter((u) => !u.destroyed).map((u) => window.__unitInfo(u.id));
  window.__groundAt = (x, z) => g.battle.groundAt(x, z);
  /**
   * An independent answer to "what ground is under this pixel".
   *
   * Deliberately not `picking.screenToGround`: that is the thing under test, and grading a
   * function against itself is how this project has shipped a silent no-op before. This is a
   * plain forward march in half-metre steps with a linear refinement, which is slow, obvious
   * and shares no code with the fixed-point iteration the product uses.
   */
  window.__marchGround = (px, py) => {
    const c = ctx.camera;
    const ndcX = (px / ctx.viewW) * 2 - 1, ndcY = -(py / ctx.viewH) * 2 + 1;
    const v = new (c.position.constructor)(ndcX, ndcY, 0.5).unproject(c);
    const o = c.position;
    let dx = v.x - o.x, dy = v.y - o.y, dz = v.z - o.z;
    const len = Math.hypot(dx, dy, dz);
    dx /= len; dy /= len; dz /= len;
    let prev = o.y - g.battle.groundAt(o.x, o.z);
    for (let t = 0.5; t < 4200; t += 0.5) {
      const x = o.x + dx * t, y = o.y + dy * t, z = o.z + dz * t;
      const h = y - g.battle.groundAt(x, z);
      if (h <= 0) {
        const f = prev / (prev - h);
        const tt = t - 0.5 + f * 0.5;
        return { x: o.x + dx * tt, z: o.z + dz * tt, t: tt };
      }
      prev = h;
    }
    return null;
  };
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
const settle = (ms = 280) => page.waitForTimeout(ms);
const shot = async (n) => { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${n}.png`) }); };

await page.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.menu .begin', { timeout: 60000 });
await page.click(`.menu [data-map="${MAP}"]`); await settle(220);
await page.click('.menu [data-scen="assault"]'); await settle(220);
await page.click('.menu .begin');
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await page.evaluate(INSTALL);
await settle(500);
if (await page.evaluate(() => !!document.querySelector('.dep-begin'))) { await page.click('.dep-begin'); await settle(700); }
const city = await page.evaluate(() => window.__game.engine.context.tryGet('city')?.cityPlan?.id ?? null);
record('boot', city === (MAP === 'carthage' ? 'carthage' : 'rome'),
  `BEGIN BATTLE in the real menu with map ${MAP}`, `city plan ${city}`);
await page.evaluate(() => window.__game.engine.advance(20, 166));
await settle(300);

async function dismissResults() {
  const upNow = await page.evaluate(() => {
    const r = document.querySelector('.results');
    return !!r && r.style.display !== 'none' && r.classList.contains('open');
  });
  if (upNow) { await page.click('.rs-close'); await settle(400); }
}

const ON = (p) => p && p.x > 120 && p.x < W - 120 && p.y > 250 && p.y < H - 280;
async function frameOn(pts, yaw, zooms = [0.26, 0.34, 0.42, 0.52, 0.64, 0.78]) {
  for (const y of [yaw, yaw + Math.PI]) {
    for (const zoom of zooms) {
      await page.evaluate(([list, z, yy]) => {
        let cx = 0, cz = 0; for (const p of list) { cx += p.x; cz += p.z; }
        window.__game.setCamera(cx / list.length, cz / list.length, z, yy);
      }, [pts, zoom, y]);
      await settle(300);
      const out = await page.evaluate((list) => list.map((p) => window.__project(p.x, p.y, p.z)), pts);
      if (out.every(ON)) return { out, zoom, yaw: y };
    }
  }
  return { out: null };
}
async function hoverUnit(id) {
  const px = await page.evaluate((u) => window.__aim(u), id);
  if (!px) return { at: null, px: null };
  for (const r of [0, 9, 18, 30, 44, 60, 80, 105]) {
    const dirs = r === 0 ? 1 : 12;
    for (let a = 0; a < dirs; a++) {
      const x = px.x + Math.cos((a * Math.PI * 2) / dirs) * r;
      const y = px.y + Math.sin((a * Math.PI * 2) / dirs) * r;
      if (x < 4 || y < 4 || x > W - 4 || y > H - 4) continue;
      await page.mouse.move(x, y); await settle(70);
      const q = await page.evaluate(() => ({ h: window.__hovered(), ui: window.__overUi() }));
      if (!q.ui && q.h === id) return { at: { x, y, r }, px };
    }
  }
  return { at: null, px };
}
async function selectUnit(id) {
  const h = await hoverUnit(id);
  if (!h.at) return { ok: false, why: `never hovered ${id}` };
  await page.mouse.click(h.at.x, h.at.y); await settle(260);
  const sel = await page.evaluate(() => window.__selected());
  return { ok: sel.length === 1 && sel[0] === id, sel, at: h.at };
}
/** Right-click at a pixel, capturing the drag-time cursor and hint. */
async function rightClick(pt, ids) {
  await page.mouse.move(pt.x, pt.y); await settle(300);
  const before = await page.evaluate(() => window.__cursor());
  const mark = await page.evaluate(() => window.__mark());
  await page.mouse.down({ button: 'right' }); await settle(170);
  const held = await page.evaluate(() => window.__cursor());
  await page.mouse.up({ button: 'right' }); await settle(320);
  const ord = await page.evaluate(([m, i]) => window.__ordersFor(m, i), [mark, ids]);
  return { before, held, order: ord.length ? ord[ord.length - 1] : null, all: ord };
}

const units = await page.evaluate(() => window.__units());
const PLAYER = 0;
const foes = units.filter((u) => u.faction !== PLAYER && u.garrisoned);
const mine = units.filter((u) => u.faction === PLAYER && !u.garrisoned && u.alive > 60);
console.log(`  ${foes.length} enemy units on the parapet, ${mine.length} of the player's on the ground`);

// ---------------------------------------------------------------------------
// G0 — ordinary ground picking, BEFORE anything else touches the cursor
// ---------------------------------------------------------------------------
/**
 * Six spread-out clicks on open ground, from one camera. The reverted attempt collapsed
 * all six onto one point 42-92 m from the pointer; this measures the same thing the same
 * way so a regression cannot hide.
 */
async function groundPicking(tag) {
  /*
   * Twelve pixels spread across the canvas, from one camera, graded against an independent
   * ray march of the same heightfield.
   *
   * Two numbers, and the second is the one that matters. The reverted attempt did not make
   * each click a little wrong — it made every click the *same* answer, 42-92 m from the
   * pointer, because the eye stood inside an insula whose `topY` was the 1e4 sentinel. So
   * this reports the error per pixel *and* the spread between the twelve answers: a collapse
   * takes the spread to nearly zero even if some individual error looks tolerable.
   */
  const centre = await page.evaluate(() => {
    const g = window.__game;
    const u = g.battle.units.find((v) => v.faction === 0 && !v.destroyed);
    return { x: u.x, z: u.z - 30 };
  });
  await page.evaluate(([c]) => window.__game.setCamera(c.x, c.z, 0.42, Math.PI), [centre]);
  await settle(450);
  const px = [];
  for (const fy of [0.36, 0.50, 0.64]) for (const fx of [0.18, 0.38, 0.62, 0.82]) {
    px.push({ x: Math.round(fx * W), y: Math.round(fy * H) });
  }
  const rows = [];
  for (const p of px) {
    const truth = await page.evaluate((q) => window.__marchGround(q.x, q.y), p);
    if (!truth) continue;
    await page.mouse.move(p.x, p.y);
    await settle(150);
    const c = await page.evaluate(() => window.__cursor());
    if (c.hoveredId >= 0) continue;   // a unit under the cursor is a different question
    rows.push({
      px: p,
      truth: { x: +truth.x.toFixed(2), z: +truth.z.toFixed(2) },
      ground: { x: c.groundX, z: c.groundZ },
      order: { x: c.orderX, z: c.orderZ },
      solidValid: c.solidValid, wallValid: c.wallValid,
      errGround: +Math.hypot(c.groundX - truth.x, c.groundZ - truth.z).toFixed(2),
      errOrder: +Math.hypot(c.orderX - truth.x, c.orderZ - truth.z).toFixed(2),
    });
  }
  const eg = rows.map((r) => r.errGround).sort((a, b) => a - b);
  const eo = rows.filter((r) => !r.solidValid).map((r) => r.errOrder).sort((a, b) => a - b);
  let spread = 0;
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    spread = Math.max(spread, Math.hypot(rows[i].order.x - rows[j].order.x, rows[i].order.z - rows[j].order.z));
  }
  const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : NaN);
  const pass = rows.length >= 8 && eg[eg.length - 1] < 1.5
    && (eo.length === 0 || eo[eo.length - 1] < 1.5) && spread > 150;
  record(`ground picking ${tag}`, pass,
    `${rows.length} pixels spread across the canvas from one camera, each graded against an `
    + `independent half-metre ray march of the heightfield`,
    `ground answer: median ${med(eg)} m, worst ${eg[eg.length - 1]} m. Order point on the `
    + `${eo.length} pixels with no solid in front: median ${med(eo)} m, worst `
    + `${eo.length ? eo[eo.length - 1] : 'n/a'} m. The answers span ${spread.toFixed(1)} m of `
    + `ground — a collapse onto one box would put this near 0. A solid stood in front of `
    + `${rows.filter((r) => r.solidValid).length} of them.`);
  return { rows, errGround: eg, errOrder: eo, spread };
}
const gp0 = await groundPicking('(this build)');

// ---------------------------------------------------------------------------
// G1 — hover an enemy on the parapet from the field, with a storming cohort selected
// ---------------------------------------------------------------------------
let g1 = null;
if (foes.length && mine.length) {
  // Nearest enemy garrison to one of the player's ground cohorts.
  let best = null;
  for (const m of mine) for (const f of foes) {
    const d = Math.hypot(m.x - f.x, m.z - f.z);
    if (!best || d < best.d) best = { d, m, f };
  }
  const mPt = await page.evaluate((id) => {
    const c = window.__ctl(), v = c.model.view(id);
    return { x: v.cx, y: v.cy, z: v.cz };
  }, best.m.id);
  const fPt = await page.evaluate((id) => {
    const c = window.__ctl(), v = c.model.view(id);
    return { x: v.cx, y: v.standY + 0.9, z: v.cz };
  }, best.f.id);
  const fr = await frameOn([mPt, fPt], Math.atan2(mPt.x - fPt.x, mPt.z - fPt.z));
  if (!fr.out) record('frame the two', false, 'show a storming cohort and an enemy garrison at once', 'gave up');
  else {
    const sel = await selectUnit(best.m.id);
    record('select the storming cohort', sel.ok,
      `left-click on ${best.m.typeId} ${best.m.id} on the ground outside the wall`,
      `selection [${(sel.sel ?? []).join(',')}]`);
    const hv = await hoverUnit(best.f.id);
    record('hover the garrison', !!hv.at,
      `move the cursor onto ${best.f.typeId} ${best.f.id}, standing on the parapet`,
      hv.at ? `hoveredId ${best.f.id} at (${hv.at.x | 0},${hv.at.y | 0}), ${hv.at.r} px off the men's own centroid`
        : `never resolved; the men project to ${JSON.stringify(hv.px)}`);
    await shot('g1-hover-garrison');
    if (hv.at) {
      const rc = await rightClick(hv.at, [best.m.id]);
      g1 = { attacker: best.m, defender: best.f, ...rc };
      const attacked = rc.order && rc.order.kind === 'attack' && rc.order.targetUnitId === best.f.id;
      // Unmodified, the wall order still wins — and the readout has to say which order the
      // player is about to give and how to give the other one.
      const honest = !attacked && rc.before.kind === 'wall'
        && /Ctrl: attack/.test(rc.held.hint ?? '');
      record('the cursor tells the truth over a garrison', honest,
        `unmodified right-click on the garrison's men: the wall order is meant to win, and the `
        + `cursor and hint must say so rather than promising an attack`,
        `cursor "${rc.before.kind}" (was "attack" before this change), hint "${rc.held.hint}"`);
      const stormed = rc.order && rc.order.kind === 'move' && rc.order.x !== undefined
        && Math.hypot(rc.order.x - best.f.x, rc.order.z - best.f.z) < 40;
      record('the wall order still wins unmodified', !!stormed && !attacked,
        `right-click on the garrison's own men with a cohort selected — storming a defended `
        + `bay must keep working, so the plain click is still the wall order`,
        rc.order ? `orderIssued kind=${rc.order.kind}`
          + (rc.order.targetUnitId !== undefined ? ` targetUnitId=${rc.order.targetUnitId}` : '')
          + (rc.order.x !== undefined ? ` at (${rc.order.x.toFixed(1)},${rc.order.z.toFixed(1)})` : '')
          : 'no orderIssued at all');
      // The deliberate override: the same pixel, with ctrl down.
      await page.keyboard.down('Control');
      const rcC = await rightClick(hv.at, [best.m.id]);
      await page.keyboard.up('Control');
      const ctrlAttack = rcC.order && rcC.order.kind === 'attack' && rcC.order.targetUnitId === best.f.id;
      record('ctrl attacks a unit on the wall', !!ctrlAttack,
        `the same pixel with Ctrl held — cursor read "${rcC.before.kind}", hint "${rcC.held.hint}", `
        + `drag target ${rcC.held.dragTarget}`,
        rcC.order ? `orderIssued kind=${rcC.order.kind}`
          + (rcC.order.targetUnitId !== undefined ? ` targetUnitId=${rcC.order.targetUnitId}` : '')
          + (rcC.order.x !== undefined ? ` at (${rcC.order.x.toFixed(1)},${rcC.order.z.toFixed(1)})` : '')
          : 'no orderIssued at all');
      g1 = { ...g1, ctrl: rcC };
      // What the sim then did with it.
      await page.evaluate(() => window.__game.engine.advance(2, 166));
      const after = await page.evaluate((id) => window.__unitInfo(id), best.m.id);
      record('the sim took the attack', after.targetUnitId === best.f.id,
        `two seconds after the Ctrl right-click, what is ${best.m.typeId} ${best.m.id} doing`,
        `order ${after.order}, targetUnitId ${after.targetUnitId} (wanted ${best.f.id})`);
    }
    // And the banner, which is the one pixel of an enemy that is never masonry.
    const bpx = await page.evaluate((id) => window.__bannerPx(id), best.f.id);
    if (!bpx) record('attack via the banner', false, 'the garrison has no hit-testable banner plaque', 'n/a');
    else {
      await page.mouse.move(bpx.x, bpx.y); await settle(260);
      const hb = await page.evaluate(() => window.__hovered());
      const rc2 = await rightClick({ x: bpx.x, y: bpx.y }, [best.m.id]);
      const ok2 = rc2.order && rc2.order.kind === 'attack' && rc2.order.targetUnitId === best.f.id;
      record('attack via the banner', !!ok2,
        `right-click the garrison's banner plaque at (${bpx.x | 0},${bpx.y | 0}), ${Math.round(bpx.w)}x${Math.round(bpx.h)} px `
        + `— hovered ${hb}, cursor "${rc2.before.kind}", wallValid ${rc2.before.wallValid}`,
        rc2.order ? `orderIssued kind=${rc2.order.kind}`
          + (rc2.order.targetUnitId !== undefined ? ` targetUnitId=${rc2.order.targetUnitId}` : '')
          : 'no orderIssued at all');
      g1 = { ...g1, banner: { px: bpx, hovered: hb, ...rc2 } };
    }
  }
}

// ---------------------------------------------------------------------------
// G2 — both on the parapet: one of the player's units on the wall, an enemy beside it
// ---------------------------------------------------------------------------
let g2 = null;
{
  /*
   * A lodgement takes time. The escalade parties are the ladders' own crews and go up under
   * `musterOwned` with no order from anybody, so this just lets the assault happen — up to
   * six minutes, stopping the moment both sides have men on the same stonework.
   */
  for (let i = 0; i < 8; i++) {
    const q = await page.evaluate(() => {
      const u = window.__units();
      return { mine: u.filter((v) => v.faction === 0 && v.garrisoned && v.alive > 20).length,
        foe: u.filter((v) => v.faction !== 0 && v.garrisoned && v.alive > 20).length };
    });
    if (q.mine > 0 && q.foe > 0) break;
    await page.evaluate(() => window.__game.engine.advance(45, 166));
    await dismissResults();
  }
  const u2 = await page.evaluate(() => window.__units());
  const mineOnWall = u2.filter((u) => u.faction === PLAYER && u.garrisoned && u.alive > 20);
  const foesOnWall = u2.filter((u) => u.faction !== PLAYER && u.garrisoned && u.alive > 20);
  if (mineOnWall.length && foesOnWall.length) {
    let best = null;
    for (const m of mineOnWall) for (const f of foesOnWall) {
      const d = Math.hypot(m.x - f.x, m.z - f.z);
      if (!best || d < best.d) best = { d, m, f };
    }
    const mPt = await page.evaluate((id) => { const v = window.__ctl().model.view(id);
      return { x: v.cx, y: v.standY + 0.9, z: v.cz }; }, best.m.id);
    const fPt = await page.evaluate((id) => { const v = window.__ctl().model.view(id);
      return { x: v.cx, y: v.standY + 0.9, z: v.cz }; }, best.f.id);
    const fr = await frameOn([mPt, fPt], Math.atan2(mPt.x - fPt.x, mPt.z - fPt.z));
    if (fr.out) {
      const sel = await selectUnit(best.m.id);
      const hv = await hoverUnit(best.f.id);
      if (sel.ok && hv.at) {
        const rc = await rightClick(hv.at, [best.m.id]);
        g2 = { attacker: best.m, defender: best.f, ...rc };
        const attacked = rc.order && rc.order.kind === 'attack' && rc.order.targetUnitId === best.f.id;
        record('attack along the parapet', !!attacked,
          `${best.m.typeId} ${best.m.id} is on the wall ${best.d.toFixed(0)} m from ${best.f.typeId} `
          + `${best.f.id}; right-click the enemy — cursor "${rc.before.kind}", hint "${rc.held.hint}"`,
          rc.order ? `orderIssued kind=${rc.order.kind}`
            + (rc.order.targetUnitId !== undefined ? ` targetUnitId=${rc.order.targetUnitId}` : '')
            + (rc.order.x !== undefined ? ` at (${rc.order.x.toFixed(1)},${rc.order.z.toFixed(1)})` : '')
            : 'no orderIssued at all');
      } else {
        record('attack along the parapet', false,
          `select ${best.m.id} on the wall and hover ${best.f.id}`,
          `select ${sel.ok}, hover ${!!hv.at}`);
      }
    } else record('attack along the parapet', false, 'frame two units on the same wall', 'gave up');
  } else {
    record('attack along the parapet', false,
      'a player unit and an enemy unit both standing on the wall',
      `player on the wall ${mineOnWall.length}, enemy on the wall ${foesOnWall.length} — `
      + 'no lodgement had formed by this point in the battle');
  }
}

// ---------------------------------------------------------------------------
// ground picking again, last, as a drift check
// ---------------------------------------------------------------------------
await dismissResults();
const gp1 = await groundPicking('(re-taken last)');

if (errs.length) record('console clean', false, 'page errors', errs.slice(0, 3).join(' | '));
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}  (${results.length} checks)`);
if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT),
  JSON.stringify({ map: MAP, results, gp0, gp1, g1, g2, units }, null, 1));
await browser.close();
process.exit(failed === 0 ? 0 : 1);
