#!/usr/bin/env node
/**
 * QA: can the *player* put a unit on the wall, order it along, and get it down again.
 *
 * `tools/probe-walltraffic.mjs` emits `orderIssued` itself, so it grades everything from
 * `Siege.interceptOrders` inward and is blind to the half in front of it — the pick. This
 * file starts one step earlier: it moves a real mouse over the parapet, reads what
 * `SelectionController` resolved, and only then right-clicks. Nothing here calls a siege
 * verb and nothing here emits an event.
 *
 * The path is the owner's: no `?harness=1`, the real menu, BEGIN BATTLE, the deployment
 * plaque, BEGIN BATTLE again, then play.
 *
 * Usage: node tools/qa-wallorder.mjs --port=5411 [--shots=dir] [--json=path]
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
const PORT = Number(args.get('port') ?? 5411);
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const JSON_OUT = args.get('json') ?? null;
/**
 * Which map, and therefore which side of the wall the player is on.
 *
 * `campus-martius` puts Rome on the parapet, so an ascent order is given from inside the
 * city and up the defenders' own stairs. `carthage` puts Rome in the siege train, and every
 * order about the wall is then given from the field — which is a different code path and
 * the one the owner is describing.
 */
const MAP = args.get('map') ?? 'campus-martius';
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;

const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) {
  console.error(`no dev server at ${base} — a probe falling through to dist/ measures a build`);
  process.exit(2);
}
console.log(`• dev server ${base}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });

const results = [];
let failed = 0;
const record = (name, pass, what, changed, note = '') => {
  results.push({ name, pass, what, changed, note });
  if (!pass) failed++;
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name.padEnd(26)} ${what}`);
  console.log(`        -> ${changed}${note ? `  [${note}]` : ''}`);
};

/** Read-only instrumentation. Nothing here drives the game. */
const INSTALL = () => {
  const g = window.__game;
  window.__tape = [];
  for (const k of ['selectionChanged', 'orderIssued']) {
    g.engine.events.on(k, (p) => window.__tape.push({ k, p: JSON.parse(JSON.stringify(p ?? {})) }));
  }
  const ctx = g.engine.context;
  window.__ctl = () => {
    const hud = ctx.tryGet('hud');
    return hud ? hud.controller : null;
  };
  const v = new (ctx.camera.position.constructor)();
  window.__project = (x, y, z) => {
    v.set(x, y, z).project(ctx.camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * ctx.viewW, y: (-v.y * 0.5 + 0.5) * ctx.viewH, depth: v.z };
  };
  window.__unit = (id) => {
    const u = g.battle.unitById(id);
    if (!u) return null;
    const p = g.battle.pool;
    let n = 0, sy = 0, hi = -1e9, lo = 1e9;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      n++; sy += p.y[i];
      if (p.y[i] > hi) hi = p.y[i];
      if (p.y[i] < lo) lo = p.y[i];
    }
    return {
      id: u.id, typeId: u.typeId, alive: u.alive, order: u.order,
      x: +u.x.toFixed(2), z: +u.z.toFixed(2), men: n,
      meanY: n ? +(sy / n).toFixed(3) : 0, maxY: n ? +hi.toFixed(3) : 0,
      minY: n ? +lo.toFixed(3) : 0,
      garrisoned: g.battle.siege.isGarrisoned(u.id),
      owned: g.battle.siege.owned ? g.battle.siege.owned.has(u.id) : null,
      plan: g.battle.siege.plans && g.battle.siege.plans.has(u.id)
        ? (() => { const q = g.battle.siege.plans.get(u.id);
          return { goal: q.goal, destStation: q.destStation, destRun: q.destRun,
            stair: q.stair, age: q.age, stuck: q.stuck, gx: +q.gx.toFixed(1), gz: +q.gz.toFixed(1) }; })()
        : null,
    };
  };
  window.__hovered = () => {
    const c = window.__ctl();
    return c ? c.model.hoveredId : -2;
  };
  window.__selected = () => {
    const c = window.__ctl();
    return c ? c.model.selection.slice() : [];
  };
  window.__view = (id) => {
    const c = window.__ctl();
    const v = c ? c.model.view(id) : null;
    return v ? { id: v.id, own: v.own, cx: +v.cx.toFixed(2), cy: +v.cy.toFixed(2),
      cz: +v.cz.toFixed(2), standY: +v.standY.toFixed(2), frontage: v.frontage,
      destroyed: v.destroyed } : null;
  };
  window.__cursorState = () => {
    const c = window.__ctl();
    if (!c) return null;
    return {
      hoveredId: c.model.hoveredId,
      selection: c.model.selection.slice(),
      groundValid: c.groundValid, groundX: +c.groundX.toFixed(2), groundZ: +c.groundZ.toFixed(2),
      solidValid: c.solidValid, solidX: +c.solidX.toFixed(2), solidZ: +c.solidZ.toFixed(2),
      solidY: +c.solidY.toFixed(2),
      wallValid: c.wallValid, wallX: +c.wallX.toFixed(2), wallZ: +c.wallZ.toFixed(2),
      wallY: +c.wallY.toFixed(2),
      orderValid: c.orderValid, orderX: +c.orderX.toFixed(2), orderZ: +c.orderZ.toFixed(2),
      hasProbe: !!c.wallProbe,
      hintText: (document.querySelector('.drag-hint')?.textContent ?? ''),
      hintShown: (() => { const h = document.querySelector('.drag-hint');
        return !!h && h.style.display !== 'none'; })(),
    };
  };
};

const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
const settle = (ms = 300) => page.waitForTimeout(ms);
const shot = async (n) => { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${n}.png`) }); };

// ---------------------------------------------------------------------------
// The owner's path in
// ---------------------------------------------------------------------------
console.log(`\n— the real menu, ?autoplay=0, no ?harness, map ${MAP}`);
await page.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.menu .begin', { timeout: 60000 });
// Real buttons in the real menu, in the order a player would press them: the battlefield
// first, because picking a map re-labels the scenario row and can take the assault away.
await page.click(`.menu [data-map="${MAP}"]`);
await settle(220);
await page.click('.menu [data-scen="assault"]');
await settle(220);
const picked = await page.evaluate(() => {
  const on = (sel) => [...document.querySelectorAll(sel)]
    .filter((b) => b.classList.contains('on') || b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.dataset.map ?? b.dataset.scen);
  return { map: on('.menu [data-map]'), scen: on('.menu [data-scen]') };
});
console.log(`  menu now reads map ${JSON.stringify(picked.map)}, scenario ${JSON.stringify(picked.scen)}`);
await page.click('.menu .begin');
let ready = true;
try { await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 }); }
catch { ready = false; }
record('boot', ready, 'BEGIN BATTLE in the real menu',
  ready ? 'window.__game.ready === true' : 'never became ready', errs.slice(0, 2).join(' | '));
if (!ready) { await browser.close(); process.exit(1); }
await page.evaluate(INSTALL);
await settle(600);

// Commit the deployment phase if this build opened one.
const hadDeploy = await page.evaluate(() => !!document.querySelector('.dep-begin'));
if (hadDeploy) {
  await page.click('.dep-begin');
  await settle(700);
}
const inPlay = await page.evaluate(() => ({
  paused: window.__game.engine.time.paused,
  dep: window.__game.deployment ? window.__game.deployment.active : null,
  scenario: window.__game.battle.units.length,
}));
record('in-play', !inPlay.paused, `deployment ${hadDeploy ? 'committed' : 'absent'}`,
  `clock paused ${inPlay.paused}, deployment.active ${inPlay.dep}, ${inPlay.scenario} units`);

// Let the assault develop a little so the world is the one the owner sees.
await page.evaluate(() => window.__game.engine.advance(20));
await settle(400);

// ---------------------------------------------------------------------------
// Choose a cohort on the ground inside the city, and a parapet to send it to
// ---------------------------------------------------------------------------
const plan = await page.evaluate(() => {
  const g = window.__game;
  const city = g.engine.context.get('city');
  const s = g.battle.siege;
  const stairs = city.getWallStairs();
  const bays = city.getGarrisonBays();
  const rep = s.report ? s.report() : null;
  // `s.towers` rather than `towerReport()`: the report is the render-side view and carries
  // neither the station nor the crew, and both are the question here. `private` is a
  // compile-time word.
  const twr = s.towers ?? [];
  /**
   * Which side of the wall the player's ordinary infantry is on, and therefore what an
   * ascent order even means. Asked of the sim rather than assumed from the map, because
   * that is the same question `Siege.interceptOrders` asks before it decides.
   */
  const cands = g.battle.units.filter((u) => u.faction === 0 && !u.destroyed && u.alive > 40
    && !s.isGarrisoned(u.id) && !s.owned.has(u.id));
  if (cands.length === 0 || stairs.length === 0) return { fail: 'no candidates' };

  // The point on the parapet to aim at, and the unit to aim it with.
  let best = null;
  for (const u of cands) {
    for (const st of stairs) {
      const d = Math.hypot(st.footX - u.x, st.footZ - u.z);
      if (!best || d < best.d) best = { d, u, st };
    }
  }
  // On the storming side there are no friendly stairs, so aim at the bay a ladder or a
  // tower is already working — which is precisely the stretch the owner would click.
  const escalades = [
    ...twr.map((t) => ({ kind: 'tower', x: t.x, z: t.z, station: t.station })),
    ...(s.ladders ?? []).map((l) => ({ kind: 'ladder', x: l.x, z: l.z, station: l.station })),
  ];
  const side = (u) => {
    // Signed side, straight from the geometry the sim uses.
    const st = s.stationNear(u.x, u.z);
    if (st < 0) return 0;
    return (u.x - s.sx[st]) * s.snx[st] + (u.z - s.sz[st]) * s.snz[st] < 0 ? -1 : 1;
  };
  const stormSide = side(best.u);
  let aim = null;
  if (stormSide === 1 && escalades.length > 0) {
    // Nearest machine to the nearest candidate, and the walk position of its bay.
    let m = null;
    for (const u of cands) {
      for (const e of escalades) {
        const d = Math.hypot(e.x - u.x, e.z - u.z);
        if (!m || d < m.d) m = { d, u, e };
      }
    }
    const st = m.e.station;
    aim = {
      via: m.e.kind, unit: m.u, walk: Math.round(m.d),
      x: s.sx[st], y: s.sy[st] + 0.1, z: s.sz[st], station: st,
    };
  }
  const st = best.st;
  const bay = bays[st.bay];
  const chosen = aim ? aim.unit : best.u;
  return {
    side: stormSide,
    via: aim ? aim.via : 'stair',
    unit: { id: chosen.id, typeId: chosen.typeId, x: chosen.x, z: chosen.z, alive: chosen.alive },
    walk: aim ? aim.walk : Math.round(best.d),
    aim: aim ? { x: +aim.x.toFixed(2), y: +aim.y.toFixed(2), z: +aim.z.toFixed(2), station: aim.station } : null,
    engines: { towers: twr.length, ladders: (s.ladders ?? []).length, breach: rep ? rep.lanes : null },
    // Who can climb what, before any change: every unit that owns a machine.
    owners: {
      towers: twr.map((t) => { const u = g.battle.unitById(t.unitId); return u ? u.typeId : null; }),
      ladders: (s.ladders ?? []).map((l) => { const u = g.battle.unitById(l.unitId); return u ? u.typeId : null; }),
    },
    stair: {
      bay: st.bay, width: +st.width.toFixed(2), side: st.side, rise: +st.rise.toFixed(2),
      foot: [+st.footX.toFixed(1), +st.footY.toFixed(2), +st.footZ.toFixed(1)],
      head: [+st.headX.toFixed(1), +st.headY.toFixed(2), +st.headZ.toFixed(1)],
      top: [+st.topX.toFixed(1), +st.topY.toFixed(2), +st.topZ.toFixed(1)],
      n: [+st.nx.toFixed(3), +st.nz.toFixed(3)],
    },
    bay: bay ? { x0: +bay.x0.toFixed(1), x1: +bay.x1.toFixed(1), walkY: +bay.walkY.toFixed(2),
      walkable: bay.walkable, crestY: +bay.crestY.toFixed(2) } : null,
    stationAtTop: s.wallTargetAt(st.topX, st.topZ),
    stationAtAim: aim ? s.wallTargetAt(aim.x, aim.z) : -1,
  };
});
if (plan.fail) { record('plan', false, 'pick a cohort and a stretch of wall', plan.fail); }
console.log(`\n  cohort ${plan.unit?.id} (${plan.unit?.typeId}, ${plan.unit?.alive} men) at `
  + `(${plan.unit?.x.toFixed(0)}, ${plan.unit?.z.toFixed(0)}) — side ${plan.side > 0 ? 'FIELD (storming)' : 'CITY (garrison)'}`);
console.log(`  route offered: ${plan.via}, ${plan.walk} m away`);
console.log(`  engines: ${plan.engines.towers} towers (${plan.owners.towers.join(', ')}), `
  + `${plan.engines.ladders} ladders (${[...new Set(plan.owners.ladders)].join(', ')})`);
console.log(`  nearest flight: bay ${plan.stair?.bay}, foot ${plan.stair?.foot}, top ${plan.stair?.top}`);
console.log(`  siege stations: at stair top ${plan.stationAtTop}, at aim ${plan.stationAtAim}`);
record('station-at-target', plan.via === 'stair' ? plan.stationAtTop >= 0 : plan.stationAtAim >= 0,
  'Siege.wallTargetAt() at the point the order will name, in plan',
  `stair top -> ${plan.stationAtTop}, aim -> ${plan.stationAtAim}`);

// ---------------------------------------------------------------------------
// Frame both, select the cohort with a real left-click
// ---------------------------------------------------------------------------
async function frame(pts, yaw, zooms = [0.30, 0.40, 0.50, 0.62, 0.74, 0.86]) {
  for (const zoom of zooms) {
    await page.evaluate(([list, z, y]) => {
      let cx = 0, cz = 0;
      for (const p of list) { cx += p.x; cz += p.z; }
      window.__game.setCamera(cx / list.length, cz / list.length, z, y);
    }, [pts, zoom, yaw]);
    await settle(360);
    const out = await page.evaluate((list) => list.map((p) => window.__project(p.x, p.y, p.z)), pts);
    if (out.every((p) => p && p.x > 70 && p.x < 1530 && p.y > 210 && p.y < 660)) return { out, zoom };
  }
  return { out: null, zoom: -1 };
}

const u = plan.unit, st = plan.stair;
// From inside, the top of the stairs. From the field, the stretch of parapet a machine is
// already leaning on — in both cases the stone the owner would click.
const target = plan.aim
  ? { x: plan.aim.x, y: plan.aim.y, z: plan.aim.z }
  : { x: st.top[0], y: st.top[1] + 0.15, z: st.top[2] };
// Exactly the heightfield, no lift: `pickUnit` tests the *ground* ray against the
// footprint, so a lifted projection aims the ray metres past the men.
const unitPt = await page.evaluate((p) => ({ x: p.x, y: window.__game.battle.groundAt(p.x, p.z), z: p.z }),
  { x: u.x, z: u.z });
// Look at the wall from whichever side the player's men are standing on, so the walk is
// presented to the camera rather than hidden behind the parapet.
const yaw = plan.side > 0
  ? Math.atan2(st.n[0], st.n[1]) + Math.PI
  : Math.atan2(-st.n[0], -st.n[1]) + Math.PI;
const framed = await frame([unitPt, target], yaw);
if (!framed.out) {
  record('frame', false, 'park a camera showing the cohort and the stair head together', 'gave up');
} else {
  console.log(`  camera zoom ${framed.zoom}, yaw ${yaw.toFixed(2)}`);
}
const [pxUnit, pxTop] = framed.out ?? [null, null];
await shot('01-framed');

/**
 * Hover until the cursor is actually over the cohort, then click.
 *
 * A hard-coded pixel that photographs empty grass fails the same way a broken feature
 * does, and this file exists to tell those two apart. The spiral is only ever a few
 * metres wide; if it has to walk far, that is itself reported.
 */
let hoverAt = null;
outer: for (const r of [0, 12, 26, 44, 68]) {
  for (const a of r === 0 ? [0] : [0, 1, 2, 3, 4, 5, 6, 7]) {
    const px = pxUnit.x + Math.cos((a * Math.PI) / 4) * r;
    const py = pxUnit.y + Math.sin((a * Math.PI) / 4) * r;
    await page.mouse.move(px, py);
    await settle(120);
    if ((await page.evaluate(() => window.__hovered())) === u.id) { hoverAt = { x: px, y: py, r }; break outer; }
  }
}
record('hover-unit', !!hoverAt, `move the cursor over cohort ${u.id}`,
  hoverAt ? `hoveredId ${u.id} at screen (${hoverAt.x | 0}, ${hoverAt.y | 0}), ${hoverAt.r} px off the projected centroid`
    : `never hovered; projected centroid (${pxUnit.x | 0}, ${pxUnit.y | 0}), `
      + `view ${JSON.stringify(await page.evaluate((id) => window.__view(id), u.id))}`);
if (hoverAt) await page.mouse.click(hoverAt.x, hoverAt.y);
await settle(320);
const sel = await page.evaluate(() => window.__selected());
record('select', sel.length === 1 && sel[0] === u.id,
  `left-click on cohort ${u.id} at screen (${(hoverAt ?? pxUnit).x | 0}, ${(hoverAt ?? pxUnit).y | 0})`,
  `selection [${sel.join(',')}]`);

// ---------------------------------------------------------------------------
// THE QUESTION: hover the parapet. What did the pick resolve?
// ---------------------------------------------------------------------------
await page.mouse.move(pxTop.x, pxTop.y);
await settle(360);
const cur = await page.evaluate(() => window.__cursorState());
await shot('02-hover-parapet');
console.log('\n  cursor over the stair head:');
console.log(`    ground   ${cur.groundValid} (${cur.groundX}, ${cur.groundZ})`);
console.log(`    solid    ${cur.solidValid} (${cur.solidX}, ${cur.solidZ}) y ${cur.solidY}`);
console.log(`    WALL     ${cur.wallValid} (${cur.wallX}, ${cur.wallZ}) y ${cur.wallY}`);
console.log(`    order    ${cur.orderValid} (${cur.orderX}, ${cur.orderZ})`);
console.log(`    probe    ${cur.hasProbe}   hint "${cur.hintText}" shown ${cur.hintShown}`);
console.log(`    sel      [${cur.selection.join(',')}]  hovered ${cur.hoveredId}`);
record('probe-wired', cur.hasProbe, 'HudSystem hands SelectionController a wall probe',
  `controller.wallProbe ${cur.hasProbe ? 'present' : 'NULL'}`);
record('pick-resolves-parapet', cur.wallValid,
  `mouse over the stair head at screen (${pxTop.x | 0}, ${pxTop.y | 0}), world (${target.x}, ${target.z})`,
  cur.wallValid
    ? `wallValid, wall point (${cur.wallX}, ${cur.wallZ}) at y ${cur.wallY}`
    : `wallValid FALSE — solid ${cur.solidValid} y ${cur.solidY}, order point (${cur.orderX}, ${cur.orderZ})`);

// ---------------------------------------------------------------------------
// Right-click, and follow the order all the way to men climbing
// ---------------------------------------------------------------------------
const before = await page.evaluate((id) => window.__unit(id), u.id);
// Mark the tape: `ai/Orders.ts` emits `orderIssued` too, so "the last event" is very
// often the enemy's and reads as a wildly wrong click.
const mark = await page.evaluate(() => window.__tape.length);
await page.mouse.click(pxTop.x, pxTop.y, { button: 'right' });
await settle(360);
const evt = await page.evaluate(([m, id]) => {
  const t = window.__tape.slice(m).filter(
    (e) => e.k === 'orderIssued' && (e.p.unitIds ?? []).includes(id)).pop();
  return t ? t.p : null;
}, [mark, u.id]);
record('order-carries-parapet', !!evt && evt.kind === 'move'
  && Math.hypot(evt.x - target.x, evt.z - target.z) < 6,
  'right-click on the stair head emits orderIssued',
  evt ? `kind ${evt.kind} at (${(evt.x ?? 0).toFixed(1)}, ${(evt.z ?? 0).toFixed(1)}) — `
    + `${Math.hypot((evt.x ?? 0) - target.x, (evt.z ?? 0) - target.z).toFixed(1)} m from the clicked stone`
    : 'no orderIssued at all');

// Let one tick land, then look for a plan.
await page.evaluate(() => window.__game.engine.advance(0.4));
const justAfter = await page.evaluate((id) => window.__unit(id), u.id);
record('siege-took-the-order', !!justAfter.plan,
  'Siege.interceptOrders converts it into a wall plan',
  justAfter.plan
    ? `goal ${justAfter.plan.goal} dest station ${justAfter.plan.destStation} run ${justAfter.plan.destRun} stair ${justAfter.plan.stair}`
    : `no plan; order ${justAfter.order}, garrisoned ${justAfter.garrisoned}, owned ${justAfter.owned}`);

const marks = [];
for (const s of [10, 20, 30, 40, 50, 60, 75, 90]) {
  await page.evaluate((sec) => window.__game.engine.advance(sec), s === 10 ? 10 : 10);
  const m = await page.evaluate((id) => window.__unit(id), u.id);
  marks.push({ t: s, meanY: m.meanY, maxY: m.maxY, men: m.men, garrisoned: m.garrisoned,
    plan: m.plan ? m.plan.goal : null, age: m.plan ? m.plan.age : null });
}
await shot('03-after-ascent');
const last = marks[marks.length - 1];
console.log('\n  ascent trace (sim seconds after the click):');
for (const m of marks) {
  console.log(`    t+${String(m.t).padStart(3)}  meanY ${m.meanY.toFixed(2)}  maxY ${m.maxY.toFixed(2)}`
    + `  men ${m.men}  garrisoned ${m.garrisoned}  plan ${m.plan}  age ${m.age}`);
}
const rise = last.meanY - before.meanY;
record('men-actually-climb', rise > 2.0,
  `cohort ${u.id} ordered onto the parapet (via ${plan.via}) by right-click alone`,
  `mean man height ${before.meanY.toFixed(2)} -> ${last.meanY.toFixed(2)} m (+${rise.toFixed(2)}), `
  + `max ${last.maxY.toFixed(2)}, garrisoned ${last.garrisoned}`);

if (errs.length) record('console-clean', false, 'page errors', errs.slice(0, 3).join(' | '));

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}  (${results.length} checks)`);
if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT),
    JSON.stringify({ results, plan, cursor: cur, event: evt, marks, before }, null, 2));
}
await browser.close();
process.exit(failed === 0 ? 0 : 1);
