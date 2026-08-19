#!/usr/bin/env node
/**
 * QA: the whole route x direction x unit-type matrix for commanding troops on a wall,
 * driven by real pointer events and nothing else.
 *
 * `probe-walltraffic.mjs` emits `orderIssued` itself and grades from `Siege.interceptOrders`
 * inward. `qa-wallorder.mjs` drives one route on one map with a real mouse. This drives the
 * matrix: every route (the wall's own stairs, an escalade ladder, a siege tower's ramp, a
 * breach), every direction (up, along, down), every unit type the product actually deploys
 * for the player, on both maps and in both roles.
 *
 * **Nothing in a cell calls a siege verb.** The only page calls a cell makes are camera
 * framing, `engine.advance`, and read-only census. Selection is a real left-click that is
 * asserted before the order goes out; the order is a real right-click.
 *
 * Usage: node tools/qa-wallmatrix.mjs --port=5477 --map=campus-martius [--only=D1,D2]
 *        [--json=path] [--shots=dir]
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
const MAP = args.get('map') ?? 'campus-martius';
const ONLY = args.get('only') ? new Set(args.get('only').split(',')) : null;
const JSON_OUT = args.get('json') ?? null;
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;

const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) {
  console.error(`no dev server at ${base} — a probe falling through to dist/ measures a build`);
  process.exit(2);
}
console.log(`• dev server ${base}   map ${MAP}`);

const cells = [];
let failed = 0;
const record = (c) => {
  cells.push(c);
  if (!c.pass) failed++;
  const tag = c.pass ? 'PASS' : (c.skip ? 'SKIP' : 'FAIL');
  console.log(`  ${tag.padEnd(4)} ${c.id.padEnd(4)} ${c.route.padEnd(9)} ${c.dir.padEnd(6)} `
    + `${(c.unitType ?? '').padEnd(20)} ${c.note}`);
};

// ---------------------------------------------------------------------------
// Read-only page instrumentation
// ---------------------------------------------------------------------------
const INSTALL = () => {
  const g = window.__game;
  const ctx = g.engine.context;
  window.__tape = [];
  for (const k of ['selectionChanged', 'orderIssued']) {
    g.engine.events.on(k, (p) => window.__tape.push({ k, p: JSON.parse(JSON.stringify(p ?? {})) }));
  }
  window.__mark = () => window.__tape.length;
  window.__ordersFor = (n, id) => window.__tape.slice(n)
    .filter((e) => e.k === 'orderIssued' && (e.p.unitIds ?? []).includes(id)).map((e) => e.p);
  window.__ctl = () => { const hud = ctx.tryGet('hud'); return hud ? hud.controller : null; };

  const V = new (ctx.camera.position.constructor)();
  window.__project = (x, y, z) => {
    V.set(x, y, z).project(ctx.camera);
    if (V.z > 1) return null;
    return { x: (V.x * 0.5 + 0.5) * ctx.viewW, y: (-V.y * 0.5 + 0.5) * ctx.viewH };
  };

  /**
   * Where to put the cursor so `SelectionController.pickUnit` resolves this unit.
   *
   * The one predicate, shared: this projects exactly the point the controller tests. A
   * ground unit is tested against the terrain hit, so its block centre is projected at
   * terrain height; an elevated unit is tested against a horizontal plane at
   * `standY + MAN_MID_Y`, so its block centre is projected there. Projecting a unit anchor
   * at "ground + 1 m" — which is what `qa-interact.__unitScreen` does — lands up to 48 px
   * above the men at some zooms and reads a working product as broken.
   */
  window.__aim = (id) => {
    const c = window.__ctl();
    const v = c ? c.model.view(id) : null;
    if (!v) return null;
    const p = g.battle.pool;
    let n = 0, sx = 0, sz = 0, sy = 0;
    for (const i of v.unit.members) {
      if (!p.aliveAt(i)) continue;
      n++; sx += p.x[i]; sz += p.z[i]; sy += p.y[i];
    }
    if (n === 0) return null;
    // Mid-body, because that is what a player aims at and what `MAN_MID_Y` compensates for.
    return window.__project(sx / n, sy / n + 0.9, sz / n);
  };
  window.__overUi = () => { const c = window.__ctl(); return c && c.ptr ? !!c.ptr.overUi : null; };

  window.__view = (id) => {
    const c = window.__ctl();
    const v = c ? c.model.view(id) : null;
    return v ? {
      id: v.id, own: v.own, destroyed: v.destroyed,
      cx: +v.cx.toFixed(2), cy: +v.cy.toFixed(2), cz: +v.cz.toFixed(2),
      standY: +v.standY.toFixed(2), frontage: +v.frontage.toFixed(1),
    } : null;
  };
  window.__hovered = () => { const c = window.__ctl(); return c ? c.model.hoveredId : -2; };
  window.__selected = () => { const c = window.__ctl(); return c ? c.model.selection.slice() : []; };
  window.__cursor = () => {
    const c = window.__ctl();
    if (!c) return null;
    return {
      kind: c.cursor,
      hoveredId: c.model.hoveredId,
      selection: c.model.selection.slice(),
      groundValid: c.groundValid, groundX: +c.groundX.toFixed(2), groundZ: +c.groundZ.toFixed(2),
      solidValid: c.solidValid, solidX: +c.solidX.toFixed(2), solidZ: +c.solidZ.toFixed(2),
      solidY: +c.solidY.toFixed(2),
      wallValid: c.wallValid, wallX: +c.wallX.toFixed(2), wallZ: +c.wallZ.toFixed(2),
      orderValid: c.orderValid, orderX: +c.orderX.toFixed(2), orderZ: +c.orderZ.toFixed(2),
      hint: (document.querySelector('.drag-hint')?.textContent ?? ''),
      hintShown: (() => { const h = document.querySelector('.drag-hint'); return !!h && h.style.display !== 'none'; })(),
    };
  };

  /**
   * One census, used by every direction. A man is in exactly one of three places and the
   * three tests are mutually exclusive by construction, so no cell can grade itself against
   * a predicate a sibling cell does not use.
   */
  window.__census = (id) => {
    const s = g.battle.siege, b = g.battle, p = b.pool;
    const u = b.unitById(id);
    if (!u) return null;
    let men = 0, onStone = 0, onTerrain = 0, inside = 0, outside = 0, insideMasonry = 0;
    let sy = 0, hi = -1e9, lo = 1e9, worstFoot = 0;
    const runs = {};
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      men++;
      const y = p.y[i];
      sy += y; if (y > hi) hi = y; if (y < lo) lo = y;
      const pm = s.probeMan(i);
      if (pm.station >= 0) {
        onStone++;
        const r = s.sRun[pm.station];
        runs[r] = (runs[r] ?? 0) + 1;
        const gap = Math.abs(y - pm.surfaceY);
        if (gap > worstFoot) worstFoot = gap;
        if (pm.insideMasonry) insideMasonry++;
      } else if (Math.abs(y - b.groundAt(p.x[i], p.z[i])) < 0.8) onTerrain++;
      if (s.wallSideAt(p.x[i], p.z[i]) < 0) inside++; else outside++;
    }
    const plan = s.plans && s.plans.has(id) ? s.plans.get(id) : null;
    return {
      id, typeId: u.typeId, men, onStone, onTerrain, inside, outside, insideMasonry,
      meanY: men ? +(sy / men).toFixed(2) : 0, maxY: men ? +hi.toFixed(2) : 0,
      minY: men ? +lo.toFixed(2) : 0, worstFootCm: +(worstFoot * 100).toFixed(2),
      runs, order: u.order,
      garrisoned: s.isGarrisoned(id), owned: s.owned.has(id),
      boarder: (() => { for (const t of s.towers) if (t.boarders.includes(id)) return 'tower';
        for (const l of s.ladders) if (l.boarders.includes(id)) return 'ladder'; return null; })(),
      plan: plan ? { goal: plan.goal, destStation: plan.destStation, destRun: plan.destRun,
        stair: plan.stair, age: plan.age, stuck: plan.stuck } : null,
    };
  };

  /** Wall furniture, in world coordinates a camera and a cursor can use. */
  window.__geom = () => {
    const s = g.battle.siege;
    const city = ctx.tryGet('city');
    return {
      nStations: s.nStations, nRuns: s.nRuns,
      stairs: (city?.getWallStairs?.() ?? []).map((st) => ({
        bay: st.bay, side: st.side,
        foot: [+st.footX.toFixed(2), +st.footY.toFixed(2), +st.footZ.toFixed(2)],
        top: [+st.topX.toFixed(2), +st.topY.toFixed(2), +st.topZ.toFixed(2)],
        station: s.wallTargetAt(st.topX, st.topZ),
      })),
      towers: s.towers.map((t) => ({ id: t.id, x: t.x, z: t.z, station: t.station,
        state: t.state, unitId: t.unitId, boarders: t.boarders.slice() })),
      ladders: s.ladders.map((l) => ({ x: l.x, z: l.z, station: l.station, unitId: l.unitId,
        boarders: l.boarders.slice() })),
      breachLinks: (s.breachLinks ?? []).slice(),
      deadStations: (() => { let n = 0; for (let i = 0; i < s.nStations; i++) if (s.sDead[i]) n++; return n; })(),
    };
  };

  /** A world point on the walk at a station, and the run it belongs to. */
  window.__station = (st) => {
    const s = g.battle.siege;
    if (st < 0 || st >= s.nStations) return null;
    return { x: s.sx[st], y: s.sy[st], z: s.sz[st], run: s.sRun[st],
      nx: s.snx[st], nz: s.snz[st], dead: !!s.sDead[st] };
  };
  /** Ground `d` metres inside the city from a station: where a descent is aimed. */
  window.__insidePoint = (st, d) => {
    const s = g.battle.siege, b = g.battle;
    if (st < 0 || st >= s.nStations) return null;
    const x = s.sx[st] - s.snx[st] * d, z = s.sz[st] - s.snz[st] * d;
    return { x, y: b.groundAt(x, z), z, side: s.wallSideAt(x, z) };
  };
  window.__runOf = (st) => g.battle.siege.sRun[st];
  /**
   * Walk `k` hops along the run chain from `from`, the way `Siege.nextHop` does. Returns the
   * run reached and how many hops were actually possible — a wall with an unbuilt bay in it
   * has runs that no traverse can ever reach, and a cell that aims at one is measuring the
   * gap rather than the order.
   */
  window.__reach = (from, k) => {
    const s = g.battle.siege;
    let r = from, hops = 0;
    const dir = Math.sign(k);
    for (let i = 0; i < Math.abs(k); i++) {
      const link = dir > 0 ? s.runNext[r] : (r > 0 ? s.runNext[r - 1] : -1);
      if (link === undefined || link < 0) break;
      r += dir; hops++;
    }
    return { run: r, hops, asked: Math.abs(k) };
  };
  window.__stationWorld = (run) => g.battle.siege.stationWorld(run);
  window.__units = () => g.battle.units.filter((u) => !u.destroyed).map((u) => ({
    id: u.id, typeId: u.typeId, faction: u.faction, alive: u.alive,
    x: +u.x.toFixed(1), z: +u.z.toFixed(1),
    side: g.battle.siege.wallSideAt(u.x, u.z),
    garrisoned: g.battle.siege.isGarrisoned(u.id), owned: g.battle.siege.owned.has(u.id),
  }));
  window.__draws = () => ctx.renderer.info.render.calls;
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
const settle = (ms = 300) => page.waitForTimeout(ms);
const shot = async (n) => { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${n}.png`) }); };

await page.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.menu .begin', { timeout: 60000 });
await page.click(`.menu [data-map="${MAP}"]`); await settle(220);
await page.click('.menu [data-scen="assault"]'); await settle(220);
const picked = await page.evaluate(() => {
  const on = (sel) => [...document.querySelectorAll(sel)]
    .filter((b) => b.classList.contains('on') || b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.dataset.map ?? b.dataset.scen);
  return { map: on('.menu [data-map]'), scen: on('.menu [data-scen]') };
});
if (!picked.map.includes(MAP)) { console.error(`menu did not take map ${MAP}: ${JSON.stringify(picked)}`); process.exit(3); }
await page.click('.menu .begin');
let ready = true;
try { await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 }); }
catch { ready = false; }
if (!ready) { console.error(`never became ready. ${errs.slice(0, 3).join(' | ')}`); await browser.close(); process.exit(1); }
await page.evaluate(INSTALL);
await settle(500);
if (await page.evaluate(() => !!document.querySelector('.dep-begin'))) { await page.click('.dep-begin'); await settle(700); }
const boot = await page.evaluate(() => ({
  paused: window.__game.engine.time.paused,
  units: window.__game.battle.units.length,
  city: window.__game.engine.context.tryGet('city')?.cityPlan?.id ?? null,
}));
console.log(`  booted: city ${boot.city}, ${boot.units} units, clock paused ${boot.paused}`);
if (boot.city !== (MAP === 'carthage' ? 'carthage' : 'rome')) {
  console.error(`WRONG CITY: expected ${MAP}, got ${boot.city}`); await browser.close(); process.exit(3);
}
await page.evaluate(() => window.__game.engine.advance(20, 166));
await settle(300);

const geom = await page.evaluate(() => window.__geom());
const units = await page.evaluate(() => window.__units());
console.log(`  wall: ${geom.nStations} stations, ${geom.nRuns} runs, ${geom.stairs.length} stairs, `
  + `${geom.towers.length} towers, ${geom.ladders.length} ladders, ${geom.breachLinks.length} breach lanes, `
  + `${geom.deadStations} dead stations`);

// ---------------------------------------------------------------------------
// Pointer primitives
// ---------------------------------------------------------------------------
const ON_SCREEN = (p) => p && p.x > 120 && p.x < W - 120 && p.y > 250 && p.y < H - 280;

/**
 * Park a camera that shows every point in `pts` **and from which the cursor resolves the
 * target as the thing the caller meant.**
 *
 * The second half is not decoration and it is the trap this file paid for. A camera parked
 * on the wrong side of a wall projects a point of ground inside the city onto a pixel whose
 * ray meets the parapet first, so the harness clicks the wall while believing it clicked the
 * street — and the cell then reports a descent that was never ordered. The yaw is therefore
 * *tried* rather than derived: both bearings along the wall's normal, and the one whose
 * cursor answer matches the world point within `tol` wins.
 */
async function frameOn(pts, yaw, want = null, zooms = [0.26, 0.34, 0.42, 0.52, 0.64, 0.78, 0.92]) {
  const yaws = [yaw, yaw + Math.PI];
  for (const y of yaws) {
    for (const zoom of zooms) {
      await page.evaluate(([list, z, yy]) => {
        let cx = 0, cz = 0;
        for (const p of list) { cx += p.x; cz += p.z; }
        window.__game.setCamera(cx / list.length, cz / list.length, z, yy);
      }, [pts, zoom, y]);
      await settle(300);
      const out = await page.evaluate((list) => list.map((p) => window.__project(p.x, p.y, p.z)), pts);
      if (!out.every(ON_SCREEN)) continue;
      if (!want) return { out, zoom, yaw: y };
      // Put the cursor on the target pixel and ask the controller what it resolved.
      const tpx = out[out.length - 1];
      await page.mouse.move(tpx.x, tpx.y);
      await settle(220);
      /*
       * The HUD is checked first, and it is not a formality. `updateGround` runs before the
       * `overUi` gate, so `orderX/orderZ` can be perfectly correct at a pixel that is
       * underneath a panel — and `handleRight` refuses the gesture there, so the cell reports
       * a descent that issued no order at all rather than a camera that framed it badly.
       * Measured once, on the line cohort's descent: order NONE, cursor `default`, selection
       * intact.
       */
      if (await page.evaluate(() => window.__overUi())) continue;
      const cur = await page.evaluate(() => window.__cursor());
      const gotWall = cur.wallValid && Math.hypot(cur.wallX - pts[pts.length - 1].x, cur.wallZ - pts[pts.length - 1].z) < 9;
      const gotGround = cur.orderValid && !cur.wallValid
        && Math.hypot(cur.orderX - pts[pts.length - 1].x, cur.orderZ - pts[pts.length - 1].z) < 12;
      if ((want === 'wall' && gotWall) || (want === 'ground' && gotGround)) return { out, zoom, yaw: y, cur };
    }
  }
  return { out: null, zoom: -1, yaw: null };
}

/** Move the cursor until the controller says it is over `id`. Spirals; reports how far. */
async function hoverUnit(id) {
  const px = await page.evaluate((u) => window.__aim(u), id);
  if (!px) return { at: null, px: null, why: 'the men never projected' };
  let sawUi = false, sawOther = -1;
  for (const r of [0, 9, 18, 30, 44, 60, 80, 105, 135]) {
    const dirs = r === 0 ? 1 : 12;
    for (let a = 0; a < dirs; a++) {
      const x = px.x + Math.cos((a * Math.PI * 2) / dirs) * r;
      const y = px.y + Math.sin((a * Math.PI * 2) / dirs) * r;
      if (x < 4 || y < 4 || x > W - 4 || y > H - 4) continue;
      await page.mouse.move(x, y);
      await settle(70);
      const q = await page.evaluate(() => ({ h: window.__hovered(), ui: window.__overUi() }));
      if (q.ui) { sawUi = true; continue; }
      if (q.h === id) return { at: { x, y, r }, px };
      if (q.h >= 0) sawOther = q.h;
    }
  }
  return { at: null, px, why: `no grid point within 135 px of the men resolved unit ${id}`
    + `${sawUi ? ' (part of the search was over the HUD)' : ''}`
    + `${sawOther >= 0 ? `; the cursor found unit ${sawOther} instead` : '; the cursor found nothing'}` };
}

/** Real left-click selection, asserted. */
async function select(id) {
  const h = await hoverUnit(id);
  if (!h.at) return { ok: false, why: h.why, px: h.px };
  await page.mouse.click(h.at.x, h.at.y);
  await settle(260);
  const sel = await page.evaluate(() => window.__selected());
  return { ok: sel.length === 1 && sel[0] === id, sel, at: h.at, why: `selection [${sel.join(',')}]` };
}

/** Real right-click at a screen point, with the cursor state read before the press. */
async function order(pt, id) {
  await page.mouse.move(pt.x, pt.y);
  await settle(300);
  const cur = await page.evaluate(() => window.__cursor());
  // Assert the selection at the moment of the order, not when it was made: a cell that lost
  // it between the click and the right-click reports a broken order for a broken selection.
  const selNow = await page.evaluate(() => window.__selected());
  const mark = await page.evaluate(() => window.__mark());
  await page.mouse.down({ button: 'right' });
  await settle(160);
  // The hint and the cursor glyph only exist while the gesture is live, so this is the only
  // moment the player's own readout can be read. Reading it after the release reports the
  // *previous* order's phrase, which reads as a wrong answer.
  const held = await page.evaluate(() => window.__cursor());
  await page.mouse.up({ button: 'right' });
  await settle(320);
  const ord = await page.evaluate(([m, u]) => window.__ordersFor(m, u), [mark, id]);
  return {
    cur: { ...cur, hint: held.hintShown ? held.hint : `(not shown; last was "${held.hint}")`,
      hintShown: held.hintShown, kind: held.kind, kindBefore: cur.kind, selAtOrder: selNow,
      wallAtOrder: cur.wallValid },
    order: ord.length ? ord[ord.length - 1] : null,
  };
}

/**
 * The results dispatch is a 1600x900 `.interactive` sheet, so while it is up every pointer
 * event lands on the HUD and no cell can select anything. A player dismisses it and plays
 * on; so does this. Reported, because a cell measured after it is a cell measured in a
 * battle the arbiter has already called.
 */
let dismissedAt = -1;
async function dismissResultsIfUp() {
  const up = await page.evaluate(() => {
    const r = document.querySelector('.results');
    return !!r && r.style.display !== 'none' && r.classList.contains('open');
  });
  if (!up) return false;
  if (dismissedAt < 0) dismissedAt = await page.evaluate(() => window.__game.simTime());
  await page.click('.rs-close');
  await settle(400);
  return true;
}

async function run(seconds, id, chunk = 30) {
  let done = 0;
  const trace = [];
  let still = 0, lastKey = '';
  while (done < seconds) {
    const s = Math.min(chunk, seconds - done);
    await page.evaluate((x) => window.__game.engine.advance(x, 166), s);
    done += s;
    await dismissResultsIfUp();
    const c = await page.evaluate((u) => window.__census(u), id);
    if (!c) break;
    trace.push({ t: done, onStone: c.onStone, onTerrain: c.onTerrain, men: c.men,
      maxY: c.maxY, plan: c.plan ? `${c.plan.goal}/${c.plan.age}/${c.plan.stuck}` : null,
      runs: c.runs, owned: c.owned });
    const key = `${c.onStone}|${c.onTerrain}|${JSON.stringify(c.runs)}|${!!c.plan}`;
    still = key === lastKey ? still + 1 : 0;
    lastKey = key;
    // Settled: nothing has moved for 90 s and no plan is running.
    if (still >= 2 && !c.plan) break;
  }
  return trace;
}

// ---------------------------------------------------------------------------
// A cell
// ---------------------------------------------------------------------------
/**
 * @param {object} spec
 *  id, route, dir, unitId, target {x,y,z}, seconds, expect(before, after) -> {pass, note}
 *  yaw — the bearing to look along, computed from the station normal by the caller.
 */
async function cell(spec) {
  if (ONLY && !ONLY.has(spec.id)) return null;
  await dismissResultsIfUp();
  const before = await page.evaluate((id) => window.__census(id), spec.unitId);
  if (!before) {
    record({ ...spec, pass: false, note: `unit ${spec.unitId} is gone` });
    return null;
  }
  const anchor = await page.evaluate((id) => {
    const v = window.__view(id);
    const c = window.__ctl();
    const vv = c.model.view(id);
    const elevated = vv.standY - vv.cy > 2.5;
    return { x: v.cx, y: elevated ? vv.standY + 0.9 : v.cy, z: v.cz };
  }, spec.unitId);
  /*
   * Frame, then select, then re-check the framing — in that order, and the order is the
   * point. `SelectionController.wallValid` on the storming side is decided by
   * `selectionIsStorming()`, which is false whenever the selection is empty, so a camera
   * validated before the click is validated against a cursor that cannot yet know what the
   * order will mean. Checked first, every Carthage cell reported "no camera works".
   */
  const rough = await frameOn([anchor, spec.target], spec.yaw);
  if (!rough.out) {
    record({ ...spec, unitType: before.typeId, pass: false, before, expect: undefined,
      note: 'could not park a camera that shows the cohort and the target at once' });
    return null;
  }
  const sel = await select(spec.unitId);
  if (!sel.ok) {
    const dbg = await page.evaluate((id) => {
      const a = window.__aim(id);
      const e = a ? document.elementFromPoint(a.x, a.y) : null;
      const stack = [];
      for (let n = e; n && n !== document.body; n = n.parentElement) {
        stack.push(`${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).join('.') : ''}`);
      }
      return { view: window.__view(id), aim: a, under: stack.slice(0, 4),
        overUi: window.__overUi(), simTime: window.__game.simTime(),
        paused: window.__game.engine.time.paused,
        overlays: [...document.querySelectorAll('#hud-root .interactive')]
          .map((n) => { const r = n.getBoundingClientRect();
            return { c: (n.className || '').toString().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; })
          .filter((r) => r.w > 400 && r.h > 300) };
    }, spec.unitId);
    record({ ...spec, unitType: before.typeId, pass: false,
      note: `SELECT FAILED — ${sel.why}; aim px ${JSON.stringify(dbg.aim)}, under `
        + `${JSON.stringify(dbg.under)}, overUi ${dbg.overUi}, t ${dbg.simTime?.toFixed(0)}s paused `
        + `${dbg.paused}, big overlays ${JSON.stringify(dbg.overlays)}, view ${JSON.stringify(dbg.view)}`,
      before, expect: undefined });
    return null;
  }
  const framed = spec.want
    ? await frameOn([anchor, spec.target], rough.yaw, spec.want, [rough.zoom, 0.26, 0.34, 0.42, 0.52, 0.64, 0.78])
    : rough;
  if (!framed.out) {
    // Say what the cursor *did* resolve, from the rough camera — that is the finding.
    await frameOn([anchor, spec.target], rough.yaw, null, [rough.zoom]);
    const t0 = await page.evaluate((t) => window.__project(t.x, t.y, t.z), spec.target);
    let cur = null;
    if (t0) { await page.mouse.move(t0.x, t0.y); await settle(260);
      cur = await page.evaluate(() => window.__cursor()); }
    record({ ...spec, unitType: before.typeId, pass: false, before, cursor: cur, expect: undefined,
      note: `no camera resolved the target as ${spec.want}. From the best one the cursor read `
        + `wallValid ${cur?.wallValid} at (${cur?.wallX},${cur?.wallZ}), solid ${cur?.solidValid} `
        + `y ${cur?.solidY}, order (${cur?.orderX},${cur?.orderZ}) against a target of `
        + `(${spec.target.x.toFixed(1)},${spec.target.z.toFixed(1)}), cursor kind ${cur?.kind}` });
    return null;
  }
  const tpx = await page.evaluate((t) => window.__project(t.x, t.y, t.z), spec.target);
  const res = await order(tpx, spec.unitId);
  await page.evaluate(() => window.__game.engine.advance(0.4, 166));
  const tick1 = await page.evaluate((id) => window.__census(id), spec.unitId);
  const trace = await run(spec.seconds, spec.unitId);
  const after = await page.evaluate((id) => window.__census(id), spec.unitId);
  // The peak, not only the end: a party can reach the parapet and then be killed on it, and
  // "0 men there at t+420" and "nobody ever got up" are different results.
  const peakStone = trace.reduce((m, t) => Math.max(m, t.onStone), before.onStone);
  const peakRuns = trace.reduce((m, t) => Math.max(m, ...Object.values(t.runs).map(Number), 0), 0);
  const verdict = spec.expect(before, after, tick1, res, { peakStone, peakRuns, trace });
  record({ ...spec, unitType: before.typeId, pass: verdict.pass, note: verdict.note,
    before, after, tick1, trace, peakStone, peakRuns, cursor: res.cur, order: res.order, selectedAt: sel.at,
    aimedAt: sel.px ?? null, target: spec.target, expect: undefined });
  if (SHOT_DIR) await shot(`${spec.id}-${spec.route}-${spec.dir}`);
  return { before, after, tick1, res };
}

// ---------------------------------------------------------------------------
// Target geometry
// ---------------------------------------------------------------------------
/** Look at the wall from `side`: +1 the field, -1 the city. */
const yawFor = (side, nx, nz) =>
  side > 0 ? Math.atan2(nx, nz) + Math.PI : Math.atan2(-nx, -nz) + Math.PI;

const stationOfUnit = (id) => page.evaluate((u) => {
  const g = window.__game, s = g.battle.siege;
  const uu = g.battle.unitById(u);
  const st = s.wallTargetAt(uu.x, uu.z) >= 0 ? s.wallTargetAt(uu.x, uu.z) : s.stationNear(uu.x, uu.z);
  return { station: st, run: st >= 0 ? s.sRun[st] : -1, x: uu.x, z: uu.z,
    side: s.wallSideAt(uu.x, uu.z) };
}, id);

const stationPoint = (st, lift = 0.15) => page.evaluate(([s, l]) => {
  const w = window.__station(s);
  return w ? { x: w.x, y: w.y + l, z: w.z, run: w.run, nx: w.nx, nz: w.nz, dead: w.dead } : null;
}, [st, lift]);

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------
const ARRIVED = (a, n) => `${a}/${n} men`;

/** Up: most of the unit is standing on the stonework, on the run it was sent to. */
const upExpect = (targetRun, frac = 0.5) => (before, after, tick1, res, k) => {
  const onRun = after.runs[targetRun] ?? 0;
  const near = Object.entries(after.runs)
    .filter(([r]) => Math.abs(Number(r) - targetRun) <= 1)
    .reduce((s, [, n]) => s + n, 0);
  const pass = (after.onStone >= after.men * frac || k.peakStone >= before.men * 0.2)
    && (near >= after.men * frac * 0.8 || k.peakStone >= before.men * 0.2) && after.men > 0;
  return { pass, note: `${ARRIVED(after.onStone, after.men)} alive on the stone (${before.men} set off; `
    + `${onRun} on run ${targetRun}, ${near} within one run), maxY ${before.maxY}→${after.maxY}, `
    + `feet ${after.worstFootCm} cm off support, peak on the stone ${k.peakStone}, `
    + `hint "${res.cur?.hint ?? ''}" cursor ${res.cur?.kind} `
    + `wallValid ${res.cur?.wallValid}, plan@t1 ${tick1.plan ? tick1.plan.goal : 'none'}, `
    + `boarder ${tick1.boarder ?? 'no'}` };
};

/** Along: most of the unit is on the run it was sent to, and still on the stone. */
const alongExpect = (targetRun) => (before, after, tick1, res) => {
  const onRun = after.runs[targetRun] ?? 0;
  const pass = onRun >= after.men * 0.5 && after.onStone >= after.men * 0.5 && after.men > 0;
  return { pass, note: `${ARRIVED(onRun, after.men)} alive on run ${targetRun} (${before.men} set off; runs `
    + `${JSON.stringify(before.runs)} → ${JSON.stringify(after.runs)}), ${after.onStone} still on the stone, `
    + `feet ${after.worstFootCm} cm off support, hint "${res.cur?.hint ?? ''}" cursor ${res.cur?.kind}, `
    + `plan@t1 ${tick1.plan ? tick1.plan.goal : 'none'}, plan at end `
    + `${after.plan ? `OPEN age ${after.plan.age} stuck ${after.plan.stuck}` : 'cleared'}` };
};

/** Down: nobody left on the stone, everybody on the terrain on the right side, plan released. */
const downExpect = (wantSide) => (before, after, tick1, res) => {
  const right = wantSide < 0 ? after.inside : after.outside;
  const pass = after.men > 0 && after.onStone <= Math.max(1, after.men * 0.05)
    && right >= after.men * 0.7 && after.onTerrain >= after.men * 0.7;
  return { pass, note: `${before.onStone}→${after.onStone} on the stone, ${after.onTerrain}/${after.men} alive on `
    + `the terrain (${before.men} set off), ${right} on the ${wantSide < 0 ? 'city' : 'field'} side, fell `
    + `${(before.maxY - after.maxY).toFixed(2)} m, siege-owned ${after.owned}, plan `
    + `${after.plan ? `STILL OPEN age ${after.plan.age} stuck ${after.plan.stuck}` : 'released'}, `
    + `hint "${res.cur?.hint ?? ''}" cursor ${res.cur?.kindBefore}/${res.cur?.kind}, `
    + `selection at the order [${(res.cur?.selAtOrder ?? []).join(',')}], `
    + `wallValid at the order ${res.cur?.wallAtOrder}, order `
    + `${res.order ? `${res.order.kind} at (${(res.order.x ?? 0).toFixed(1)},${(res.order.z ?? 0).toFixed(1)})` : 'NONE'}` };
};

async function romeCells() {
  const line = units.find((u) => u.typeId === 'legio-cohort' && u.faction === 0);
  const arch = units.find((u) => u.typeId === 'ballistarii' && u.garrisoned);
  const sling = units.find((u) => u.typeId === 'wall-slingers' && u.garrisoned);
  const arty = units.find((u) => u.typeId === 'carroballista' && u.faction === 0);
  console.log(`  player units: line ${line?.id}, archers ${arch?.id}, slingers ${sling?.id}, artillery ${arty?.id}`);

  // ---- R1 stairs / up / line cohort ----
  let st = geom.stairs
    .filter((s) => s.station >= 0)
    .sort((a, b) => Math.hypot(a.foot[0] - line.x, a.foot[2] - line.z)
      - Math.hypot(b.foot[0] - line.x, b.foot[2] - line.z))[0];
  let tgt = await stationPoint(st.station, 0.2);
  await cell({ id: 'R1', route: 'stairs', dir: 'up', unitId: line.id, seconds: 150,
    target: { x: tgt.x, y: tgt.y, z: tgt.z }, yaw: yawFor(-1, tgt.nx, tgt.nz),
    want: 'wall', expect: upExpect(tgt.run) });

  // ---- R2 traverse / along / line cohort ----
  let here = await stationOfUnit(line.id);
  if (here.run >= 0) {
    const rch = await page.evaluate(([r, k]) => window.__reach(r, k), [here.run, 2]);
    const want = rch.hops > 0 ? rch.run : here.run;
    const w = await page.evaluate((r) => window.__stationWorld(r), want);
    const wp = await stationPoint(w.station, 0.2);
    console.log(`    R2: run ${here.run} → ${want} (${rch.hops} of 2 hops are linked)`);
    await cell({ id: 'R2', route: 'traverse', dir: 'along', unitId: line.id, seconds: 420,
      target: { x: wp.x, y: wp.y, z: wp.z }, yaw: yawFor(-1, wp.nx, wp.nz),
      want: 'wall', expect: alongExpect(want) });

    // The same gesture aimed across a gap the wall does not bridge. The cursor offers it.
    const far = await page.evaluate(([r, k]) => {
      const s = window.__game.battle.siege;
      // The first run beyond the reachable chain in either direction, or -1.
      for (let d = 1; d <= 8; d++) {
        const a = window.__reach(r, d), b = window.__reach(r, -d);
        if (a.hops < d && r + d < s.nRuns) return r + d;
        if (b.hops < d && r - d >= 0) return r - d;
      }
      return -1;
    }, [here.run, 6]);
    if (far >= 0) {
      const fw = await page.evaluate((r) => window.__stationWorld(r), far);
      const fp = await stationPoint(fw.station, 0.2);
      if (fp) {
        await cell({ id: 'R2X', route: 'traverse', dir: 'along', unitId: line.id, seconds: 120,
          target: { x: fp.x, y: fp.y, z: fp.z }, yaw: yawFor(-1, fp.nx, fp.nz), want: 'wall',
          expect: (b, a, t1, r) => ({
            pass: !a.plan,
            note: `aimed at run ${far}, which no link reaches from run ${here.run}: cursor said `
              + `"${r.cur?.hint}", the order was ${t1.plan ? 'ACCEPTED' : 'refused'}, and `
              + `${a.plan ? `the plan is still open at age ${a.plan.age} with ${a.plan.stuck} men stuck`
                : 'no plan is left open'}` }) });
      }
      /*
       * And the way out of it. `H` is the halt key the legend already advertises; until this
       * pass it reached `BattleSystem` and nothing else, so a unit halfway through a wall
       * order kept executing an order that could not finish.
       */
      const frozen = await page.evaluate((id) => window.__census(id), line.id);
      if (frozen && frozen.plan) {
        const sel = await select(line.id);
        if (sel.ok) {
          await page.keyboard.press('KeyH');
          await settle(200);
          await page.evaluate(() => window.__game.engine.advance(2, 166));
          const freed = await page.evaluate((id) => window.__census(id), line.id);
          record({ id: 'R2H', route: 'halt', dir: '-', unitId: line.id, unitType: frozen.typeId,
            pass: !freed.plan,
            note: `H with the frozen cohort selected: plan goal ${frozen.plan.goal} age `
              + `${frozen.plan.age} stuck ${frozen.plan.stuck} → `
              + `${freed.plan ? `STILL OPEN age ${freed.plan.age}` : 'cleared'}; `
              + `${freed.onStone} men still on the stone, siege-owned ${freed.owned}`,
            before: frozen, after: freed });
        } else {
          record({ id: 'R2H', route: 'halt', dir: '-', unitId: line.id, pass: false,
            note: `could not select the frozen cohort to halt it — ${sel.why}` });
        }
      } else {
        record({ id: 'R2H', route: 'halt', dir: '-', unitId: line.id, pass: true, skip: true,
          note: 'no plan was left open by R2X, so there was nothing to countermand' });
      }
    }
  } else {
    record({ id: 'R2', route: 'traverse', dir: 'along', unitId: line.id, pass: false,
      note: 'the cohort never reached the wall in R1, so there was nothing to traverse' });
  }

  // ---- R3 stairs / down / line cohort ----
  here = await stationOfUnit(line.id);
  if (here.station >= 0) {
    const inPt = await page.evaluate(([s, d]) => window.__insidePoint(s, d), [here.station, 40]);
    const wp = await stationPoint(here.station, 0);
    await cell({ id: 'R3', route: 'stairs', dir: 'down', unitId: line.id, seconds: 300,
      target: { x: inPt.x, y: inPt.y, z: inPt.z }, yaw: yawFor(-1, wp.nx, wp.nz),
      want: 'ground', expect: downExpect(-1) });
  } else {
    record({ id: 'R3', route: 'stairs', dir: 'down', unitId: line.id, pass: false,
      note: 'the cohort was not on the wall to come down from' });
  }

  // ---- R4 traverse / along / archers ----
  let ah = await stationOfUnit(arch.id);
  if (ah.run >= 0) {
    const rch = await page.evaluate(([r, k]) => window.__reach(r, k), [ah.run, -2]);
    const want = rch.hops > 0 ? rch.run : ah.run;
    const w = await page.evaluate((r) => window.__stationWorld(r), want);
    const wp = await stationPoint(w.station, 0.2);
    await cell({ id: 'R4', route: 'traverse', dir: 'along', unitId: arch.id, seconds: 480,
      target: { x: wp.x, y: wp.y, z: wp.z }, yaw: yawFor(-1, wp.nx, wp.nz),
      want: 'wall', expect: alongExpect(want) });
  }

  // ---- R5 stairs / down / archers ----
  ah = await stationOfUnit(arch.id);
  if (ah.station >= 0) {
    const inPt = await page.evaluate(([s, d]) => window.__insidePoint(s, d), [ah.station, 40]);
    const wp = await stationPoint(ah.station, 0);
    await cell({ id: 'R5', route: 'stairs', dir: 'down', unitId: arch.id, seconds: 300,
      target: { x: inPt.x, y: inPt.y, z: inPt.z }, yaw: yawFor(-1, wp.nx, wp.nz),
      want: 'ground', expect: downExpect(-1) });
  }

  // ---- R6 stairs / up / archers, from the ground they were just put on ----
  const back = await page.evaluate((id) => window.__census(id), arch.id);
  if (back && back.onStone < back.men * 0.3) {
    const au = (await page.evaluate(() => window.__units())).find((u) => u.id === arch.id);
    const s2 = geom.stairs.filter((s) => s.station >= 0)
      .sort((a, b) => Math.hypot(a.foot[0] - au.x, a.foot[2] - au.z)
        - Math.hypot(b.foot[0] - au.x, b.foot[2] - au.z))[0];
    const tp = await stationPoint(s2.station, 0.2);
    await cell({ id: 'R6', route: 'stairs', dir: 'up', unitId: arch.id, seconds: 200,
      target: { x: tp.x, y: tp.y, z: tp.z }, yaw: yawFor(-1, tp.nx, tp.nz),
      want: 'wall', expect: upExpect(tp.run) });
  } else {
    record({ id: 'R6', route: 'stairs', dir: 'up', unitId: arch.id, pass: false,
      note: 'R5 never got the archers down, so there was no ground ascent to test' });
  }

  // ---- R7 slingers traverse (a second missile type) ----
  const sh = await stationOfUnit(sling.id);
  if (sh.run >= 0) {
    const rch = await page.evaluate(([r, k]) => window.__reach(r, k), [sh.run, 1]);
    const want = rch.hops > 0 ? rch.run : sh.run;
    const w = await page.evaluate((r) => window.__stationWorld(r), want);
    const wp = await stationPoint(w.station, 0.2);
    await cell({ id: 'R7', route: 'traverse', dir: 'along', unitId: sling.id, seconds: 420,
      target: { x: wp.x, y: wp.y, z: wp.z }, yaw: yawFor(-1, wp.nx, wp.nz),
      want: 'wall', expect: alongExpect(want) });
  }

  // ---- R8 artillery up the stairs ----
  if (arty) {
    const au = (await page.evaluate(() => window.__units())).find((u) => u.id === arty.id);
    const s3 = geom.stairs.filter((s) => s.station >= 0)
      .sort((a, b) => Math.hypot(a.foot[0] - au.x, a.foot[2] - au.z)
        - Math.hypot(b.foot[0] - au.x, b.foot[2] - au.z))[0];
    const tp = await stationPoint(s3.station, 0.2);
    await cell({ id: 'R8', route: 'stairs', dir: 'up', unitId: arty.id, seconds: 150,
      target: { x: tp.x, y: tp.y, z: tp.z }, yaw: yawFor(-1, tp.nx, tp.nz),
      want: 'wall', expect: (b, a, t1, r) => ({ pass: a.onStone >= b.men * 0.5,
        note: `artillery: ${ARRIVED(a.onStone, b.men)} on the stone, plan@t1 `
          + `${t1.plan ? t1.plan.goal : 'none'}, order ${r.order ? r.order.kind : 'none'}` }) });
  }
}

async function carthageCells() {
  const esc = units.find((u) => u.typeId === 'legio-escalade');
  const twr = units.find((u) => u.typeId === 'legio-tower-party');
  const lines = units.filter((u) => u.typeId === 'legio-cohort');
  const horse = units.find((u) => u.typeId === 'equites');
  const arty = units.find((u) => u.typeId === 'carroballista' || u.typeId === 'legio-ballista');
  console.log(`  player units: escalade ${esc?.id}, tower party ${twr?.id}, `
    + `line ${lines.map((l) => l.id).join('/')}, horse ${horse?.id}, artillery ${arty?.id}`);

  const ladderBank = geom.ladders.filter((l) => l.unitId === esc.id);
  const ladderSt = ladderBank[Math.floor(ladderBank.length / 2)].station;
  const towerSt = geom.towers[0].station;

  // ---- C1 ladder / up / specialist escalade party (which is also the ladder's own crew) ----
  let tp = await stationPoint(ladderSt, 0.2);
  await cell({ id: 'C1', route: 'ladder', dir: 'up', unitId: esc.id, seconds: 240,
    target: { x: tp.x, y: tp.y, z: tp.z }, yaw: yawFor(1, tp.nx, tp.nz),
    want: 'wall', expect: upExpect(tp.run, 0.35) });

  // ---- C2 ladder / up / line cohort ----
  tp = await stationPoint(ladderSt, 0.2);
  await cell({ id: 'C2', route: 'ladder', dir: 'up', unitId: lines[1].id, seconds: 300,
    target: { x: tp.x, y: tp.y, z: tp.z }, yaw: yawFor(1, tp.nx, tp.nz),
    want: 'wall', expect: upExpect(tp.run, 0.3) });

  // ---- C3 tower ramp / up / line cohort ----
  tp = await stationPoint(towerSt, 0.2);
  await cell({ id: 'C3', route: 'tower', dir: 'up', unitId: lines[2].id, seconds: 300,
    target: { x: tp.x, y: tp.y, z: tp.z }, yaw: yawFor(1, tp.nx, tp.nz),
    want: 'wall', expect: upExpect(tp.run, 0.3) });

  // ---- C4 tower ramp / up / the tower's own party ----
  tp = await stationPoint(towerSt, 0.2);
  await cell({ id: 'C4', route: 'tower', dir: 'up', unitId: twr.id, seconds: 240,
    target: { x: tp.x, y: tp.y, z: tp.z }, yaw: yawFor(1, tp.nx, tp.nz),
    want: 'wall', expect: upExpect(tp.run, 0.3) });

  // ---- C5 ladder / up / cavalry ----
  if (horse) {
    tp = await stationPoint(ladderSt, 0.2);
    await cell({ id: 'C5', route: 'ladder', dir: 'up', unitId: horse.id, seconds: 200,
      target: { x: tp.x, y: tp.y, z: tp.z }, yaw: yawFor(1, tp.nx, tp.nz),
      want: 'wall', expect: (b, a, t1, r) => ({ pass: a.onStone === 0 && !a.owned,
        note: `mounted: ${a.onStone} men on the stone, siege-owned ${a.owned}, boarder `
          + `${t1.boarder ?? 'no'}, order ${r.order ? r.order.kind : 'none'} — `
          + `${a.onStone === 0 ? 'refused, which is the intended answer' : 'ACCEPTED, horses on a ladder'}` }) });
  }

  // ---- C6 traverse / along, for whichever cohort got onto the wall ----
  /*
   * *Any* player unit on the stonework, not only the four this file ordered. The escalade
   * parties are their ladders' own crews and go up under `musterOwned` with no order from
   * anybody, so the lodgement that the traverse and the descent need very often belongs to
   * a unit no cell has touched — and looking only at the four made three cells report
   * "nothing reached the parapet" while a Roman cohort stood on it.
   */
  let onWall = null;
  for (let i = 0; i < 12 && !onWall; i++) {
    const all = await page.evaluate(() => window.__units());
    let best = null;
    for (const u of all) {
      if (u.faction !== 0 || !u.garrisoned) continue;
      const q = await page.evaluate((id) => window.__census(id), u.id);
      if (q && q.onStone > 20 && (!best || q.onStone > best.q.onStone)) best = { id: u.id, q };
    }
    if (best) { onWall = best; break; }
    await page.evaluate(() => window.__game.engine.advance(45, 166));
    await dismissResultsIfUp();
  }
  if (onWall) console.log(`    lodgement: unit ${onWall.id} with ${onWall.q.onStone} men on the stone`);
  if (onWall) {
    const here = await stationOfUnit(onWall.id);
    const rch = await page.evaluate(([r, k]) => window.__reach(r, k), [here.run, 2]);
    const want = rch.hops > 0 ? rch.run : here.run;
    const w = await page.evaluate((r) => window.__stationWorld(r), want);
    const wp = await stationPoint(w.station, 0.2);
    await cell({ id: 'C6', route: 'traverse', dir: 'along', unitId: onWall.id, seconds: 300,
      target: { x: wp.x, y: wp.y, z: wp.z }, yaw: yawFor(1, wp.nx, wp.nz),
      want: 'wall', expect: alongExpect(want) });

    // ---- C7 descend into the streets ----
    const h2 = await stationOfUnit(onWall.id);
    const inPt = await page.evaluate(([s, d]) => window.__insidePoint(s, d), [h2.station, 45]);
    const wp2 = await stationPoint(h2.station, 0);
    await cell({ id: 'C7', route: 'stairs', dir: 'down', unitId: onWall.id, seconds: 360,
      target: { x: inPt.x, y: inPt.y, z: inPt.z }, yaw: yawFor(-1, wp2.nx, wp2.nz),
      want: 'ground', expect: downExpect(-1) });

    // ---- C8 the defenders' own stairs, from inside, by the attacker who took the wall ----
    const down = await page.evaluate((id) => window.__census(id), onWall.id);
    if (down && down.onStone < down.men * 0.2 && down.inside > down.men * 0.5) {
      const uu = (await page.evaluate(() => window.__units())).find((u) => u.id === onWall.id);
      const s4 = geom.stairs.filter((s) => s.station >= 0)
        .sort((a, b) => Math.hypot(a.foot[0] - uu.x, a.foot[2] - uu.z)
          - Math.hypot(b.foot[0] - uu.x, b.foot[2] - uu.z))[0];
      const t4 = await stationPoint(s4.station, 0.2);
      await cell({ id: 'C8', route: 'stairs', dir: 'up', unitId: onWall.id, seconds: 300,
        target: { x: t4.x, y: t4.y, z: t4.z }, yaw: yawFor(-1, t4.nx, t4.nz),
        want: 'wall', expect: upExpect(t4.run, 0.3) });
    } else {
      record({ id: 'C8', route: 'stairs', dir: 'up', unitId: onWall.id, pass: false,
        note: 'C7 never put the cohort inside the city, so the defenders-stairs ascent had no start state' });
    }
  } else {
    for (const id of ['C6', 'C7', 'C8']) {
      record({ id, route: '-', dir: '-', unitId: -1, pass: false,
        note: 'no player unit reached the parapet in C1-C4, so nothing could be traversed or brought down' });
    }
  }

  // ---- C9 artillery up a ladder ----
  if (arty) {
    const tpa = await stationPoint(ladderSt, 0.2);
    await cell({ id: 'C9', route: 'ladder', dir: 'up', unitId: arty.id, seconds: 180,
      target: { x: tpa.x, y: tpa.y, z: tpa.z }, yaw: yawFor(1, tpa.nx, tpa.nz),
      want: 'wall', expect: (b, a, t1, r) => ({ pass: a.onStone === 0,
        note: `artillery: ${a.onStone} men on the stone, owned ${a.owned}, boarder ${t1.boarder ?? 'no'}` }) });
  }
}

// ---- the breach, on either map ----
async function breachCell() {
  const g2 = await page.evaluate(() => window.__geom());
  if (g2.breachLinks.length === 0) {
    record({ id: 'B1', route: 'breach', dir: 'through', unitId: -1, pass: false, skip: true,
      note: 'no breach exists: the scenario deploys no great ram, so `Siege.breachLinks` is empty '
        + 'in every shipped battle and the route cannot be reached from the seat' });
    return;
  }
}

console.log('\n— the matrix —');
if (MAP === 'carthage') await carthageCells(); else await romeCells();
await breachCell();

if (errs.length) {
  record({ id: 'ERR', route: '-', dir: '-', unitId: -1, pass: false,
    note: `page errors: ${errs.slice(0, 3).join(' | ')}` });
}
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}  (${cells.length} cells)`);
if (dismissedAt >= 0) console.log(`  note: the arbiter called the battle at t+${dismissedAt.toFixed(0)} s `
  + `and the dispatch was dismissed with a real click; cells after that ran on in a decided battle`);
if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ map: MAP, geom, units, dismissedAt, cells }, null, 1));
await browser.close();
process.exit(failed === 0 ? 0 : 1);
