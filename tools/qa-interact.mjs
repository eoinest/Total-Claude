#!/usr/bin/env node
/**
 * QA: real mouse and keyboard interaction against the integrated build.
 *
 * Every check drives a genuine Playwright input event at real screen coordinates (no
 * calling controller methods directly) and then asserts on observable state in
 * `window.__game.battle`, `engine.time` or the event bus. Anything that changes nothing
 * measurable is reported as a failure.
 *
 * Usage: node tools/qa-interact.mjs [--port=5224] [--json=path] [--shots=dir]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5224);
const JSON_OUT = args.get('json') ?? null;
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const W = 1600, H = 900;

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(// autoplay=0 leaves Rome under player control, which is the whole point of an
  // interaction test; the harness default hands both armies to the AI.
  `${base}/?harness=1&autoplay=0&quality=high&w=${W}&h=${H}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });

// Event tape + world→screen projection, installed once.
await page.evaluate(() => {
  const g = window.__game;
  window.__tape = [];
  for (const k of ['selectionChanged', 'orderIssued', 'abilityActivated', 'battleEnded', 'cameraShake']) {
    g.engine.events.on(k, (p) => window.__tape.push({
      k, at: +g.simTime().toFixed(2), wall: Math.round(performance.now()),
      p: JSON.parse(JSON.stringify(p ?? {}, (_, v) => (v === undefined ? '<undefined>' : Number.isNaN(v) ? '<NaN>' : v))),
    }));
  }
  /**
   * `src/ai/Orders.ts` and `src/sim/AutoEngage.ts` also emit `orderIssued`, for BOTH
   * factions, so the newest event on the bus is usually not the player's. Match on the
   * exact unit set the player had selected.
   */
  window.__ordersFor = (n, ids) => window.__tape
    .slice(n)
    .filter((e) => e.k === 'orderIssued' &&
      e.p.unitIds.length === ids.length && ids.every((i) => e.p.unitIds.includes(i)));
  window.__allOrders = (n) => window.__tape.slice(n).filter((e) => e.k === 'orderIssued');
  window.__selection = () => {
    const t = window.__tape.filter((e) => e.k === 'selectionChanged').pop();
    return t ? t.p.unitIds : [];
  };
  // `import('three')` does not resolve inside page.evaluate (no vite import map), so borrow
  // a Vector3 instance off the camera rather than constructing one.
  const v = g.engine.context.camera.position.clone();
  /** World point → CSS pixels in the canvas, or null if behind the camera. */
  window.__project = (x, y, z) => {
    v.set(x, y, z).project(g.engine.context.camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * g.engine.context.viewW, y: (-v.y * 0.5 + 0.5) * g.engine.context.viewH };
  };
  /** Screen position of a unit's anchor, lifted 1 m so it is not buried in the ground. */
  window.__unitScreen = (id) => {
    const u = g.battle.unitById(id);
    if (!u) return null;
    return window.__project(u.x, g.battle.groundAt(u.x, u.z) + 1, u.z);
  };
  window.__tapeMark = () => window.__tape.length;
  window.__tapeSince = (n) => window.__tape.slice(n);
  window.__unit = (id) => {
    const u = g.battle.unitById(id);
    if (!u) return null;
    return {
      id: u.id, typeId: u.typeId, faction: u.faction, alive: u.alive, order: u.order,
      x: +u.x.toFixed(2), z: +u.z.toFixed(2), facing: +u.facing.toFixed(4),
      width: u.width, formationId: u.formationId, targetUnitId: u.targetUnitId,
      waypoints: u.waypoints.length, destroyed: u.destroyed,
      targetX: +u.targetX.toFixed(2), targetZ: +u.targetZ.toFixed(2),
      targetFacing: +u.targetFacing.toFixed(4),
      running: u.running, engaged: u.engaged, morale: Math.round(u.morale),
    };
  };
});

const results = [];
let failed = 0;
const ORDER = ['Hold', 'MoveTo', 'AttackMove', 'AttackUnit', 'Withdraw', 'Rout', 'Garrison'];

function record(name, pass, what, changed, note = '') {
  results.push({ name, pass, what, changed, note });
  if (!pass) failed++;
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name.padEnd(26)} ${what}`);
  console.log(`        → ${changed}${note ? `  [${note}]` : ''}`);
}

/** Settle: let the rAF loop process the input edge and the sim react. */
const settle = async (ms = 350) => page.waitForTimeout(ms);

// Move a little so the sim is not in its first frame, and give the AI time to deploy.
await page.evaluate(() => window.__game.advance(6));
await settle(400);

// ---------------------------------------------------------------------------
// 1. click-select a unit
// ---------------------------------------------------------------------------
// Pick a Roman infantry unit whose anchor projects inside the frame and is not behind a
// HUD panel; frame it with the camera first so the click has something to hit.
const target = await page.evaluate(() => {
  const g = window.__game;
  const u = g.battle.units.find((v) => v.faction === 0 && !v.destroyed && v.alive > 100);
  g.setCamera(u.x, u.z, 0.34, u.facing + Math.PI);
  g.advance(0.4);
  return { id: u.id, typeId: u.typeId };
});
await settle(400);
let mark = await page.evaluate(() => window.__tapeMark());
let pos = await page.evaluate((id) => window.__unitScreen(id), target.id);
if (!pos) { record('click-select', false, 'unit anchor did not project on screen', 'n/a'); }
else {
  await page.mouse.move(pos.x, pos.y);
  await settle(200);
  await page.mouse.click(pos.x, pos.y);
  await settle(350);
  const tape = await page.evaluate((n) => window.__tapeSince(n), mark);
  const sel = tape.filter((e) => e.k === 'selectionChanged').pop();
  const ok = !!sel && sel.p.unitIds.length === 1 && sel.p.unitIds[0] === target.id;
  record('click-select', ok,
    `left-click at (${Math.round(pos.x)},${Math.round(pos.y)}) on unit ${target.id} (${target.typeId})`,
    sel ? `selectionChanged → [${sel.p.unitIds.join(',')}]` : 'no selectionChanged event');
}

// ---------------------------------------------------------------------------
// 2. marquee-select
// ---------------------------------------------------------------------------
// Build the box from where Roman units actually project, rather than guessing fractions of
// the viewport — a hardcoded box photographs empty grass as reliably as a hardcoded camera.
const box = await page.evaluate(() => {
  const g = window.__game;
  const own = g.battle.units.filter((v) => v.faction === 0 && !v.destroyed && v.alive > 50);
  let sx = 0, sz = 0;
  for (const u of own) { sx += u.x; sz += u.z; }
  g.setCamera(sx / own.length, sz / own.length, 0.70, Math.PI);
  g.advance(0.5);
  const pts = [];
  for (const u of own) {
    const p = window.__project(u.x, g.battle.groundAt(u.x, u.z) + 1, u.z);
    if (p && p.x > 8 && p.x < g.engine.context.viewW - 8 && p.y > 8 && p.y < g.engine.context.viewH - 8) {
      pts.push({ id: u.id, ...p });
    }
  }
  pts.sort((a, b) => a.x - b.x);
  // A box around the middle 5 units that are on screen.
  const take = pts.slice(0, Math.min(5, pts.length));
  if (take.length < 2) return null;
  const pad = 26;
  return {
    ids: take.map((p) => p.id),
    x0: Math.min(...take.map((p) => p.x)) - pad, y0: Math.min(...take.map((p) => p.y)) - pad,
    x1: Math.max(...take.map((p) => p.x)) + pad, y1: Math.max(...take.map((p) => p.y)) + pad,
    onScreen: pts.length,
  };
});
await settle(400);
mark = await page.evaluate(() => window.__tapeMark());
if (!box) record('marquee-select', false, 'no Roman unit anchors projected on screen to box around', 'n/a');
else {
  await page.mouse.move(box.x0, box.y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box.x0 + (box.x1 - box.x0) * i / 10, box.y0 + (box.y1 - box.y0) * i / 10);
    await page.waitForTimeout(30);
  }
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'marquee.png') });
  await page.mouse.up();
  await settle(400);
  const tape = await page.evaluate((n) => window.__tapeSince(n), mark);
  const sel = tape.filter((e) => e.k === 'selectionChanged').pop();
  const ok = !!sel && sel.p.unitIds.length > 1;
  record('marquee-select', ok,
    `left-drag ${Math.round(box.x0)},${Math.round(box.y0)} → ${Math.round(box.x1)},${Math.round(box.y1)}, ` +
    `a box drawn round ${box.ids.length} projected unit anchors (${box.onScreen} on screen)`,
    sel ? `selectionChanged → ${sel.p.unitIds.length} units [${sel.p.unitIds.join(',')}]` : 'no selectionChanged event',
    ok ? '' : `expected to catch at least ${box.ids.join(',')}`);
}

// ---------------------------------------------------------------------------
// 3. double-click selects all of a type
// ---------------------------------------------------------------------------
const dbl = await page.evaluate(() => {
  const g = window.__game;
  const u = g.battle.units.find((v) => v.faction === 0 && !v.destroyed && v.alive > 100);
  const sameType = g.battle.units.filter((v) => v.typeId === u.typeId && !v.destroyed).length;
  g.setCamera(u.x, u.z, 0.34, u.facing + Math.PI);
  g.advance(0.4);
  return { id: u.id, typeId: u.typeId, sameType };
});
await settle(400);
mark = await page.evaluate(() => window.__tapeMark());
pos = await page.evaluate((id) => window.__unitScreen(id), dbl.id);
if (!pos) record('double-click type', false, 'anchor did not project', 'n/a');
else {
  await page.mouse.move(pos.x, pos.y);
  await settle(150);
  await page.mouse.dblclick(pos.x, pos.y, { delay: 40 });
  await settle(400);
  const tape = await page.evaluate((n) => window.__tapeSince(n), mark);
  const sel = tape.filter((e) => e.k === 'selectionChanged').pop();
  const ok = !!sel && sel.p.unitIds.length === dbl.sameType && sel.p.unitIds.length > 1;
  record('double-click type', ok,
    `double-click unit ${dbl.id} (${dbl.typeId}); ${dbl.sameType} of that type alive`,
    sel ? `selectionChanged → ${sel.p.unitIds.length} units` : 'no selectionChanged event',
    ok ? '' : `expected ${dbl.sameType}`);
}

// ---------------------------------------------------------------------------
// 4. right-click to move
// ---------------------------------------------------------------------------
{
  // Single selection, then a short right-click on empty ground behind the unit.
  const setup = await page.evaluate(() => {
    const g = window.__game;
    const u = g.battle.units.find((v) => v.faction === 0 && !v.destroyed && v.alive > 100);
    g.setCamera(u.x, u.z + 40, 0.5, Math.PI);
    g.advance(0.4);
    return { id: u.id };
  });
  await settle(350);
  pos = await page.evaluate((id) => window.__unitScreen(id), setup.id);
  await page.mouse.click(pos.x, pos.y);
  await settle(350);
  const before = await page.evaluate((id) => window.__unit(id), setup.id);
  mark = await page.evaluate(() => window.__tapeMark());
  // A point ~45 m behind the unit, projected.
  const dest = await page.evaluate((id) => {
    const g = window.__game;
    const u = g.battle.unitById(id);
    return window.__project(u.x + 20, g.battle.groundAt(u.x + 20, u.z + 55), u.z + 55);
  }, setup.id);
  await page.mouse.move(dest.x, dest.y);
  await settle(250);
  // Two attempts, reported separately. An instant click puts `pressed` and `released` in the
  // same engine frame; `SelectionController.handleRight` only issues an order when
  // `p.released && this.dragging`, and `dragging` is set on `pressed`, so whether a
  // zero-duration right-click registers depends on whether Input reports both edges in one
  // frame. A held press cannot lose the gesture.
  let ord = null, how = '';
  for (const holdMs of [0, 140]) {
    mark = await page.evaluate(() => window.__tapeMark());
    await page.mouse.down({ button: 'right' });
    if (holdMs) await page.waitForTimeout(holdMs);
    await page.mouse.up({ button: 'right' });
    await settle(500);
    const got = await page.evaluate(({ n, ids }) => window.__ordersFor(n, ids), { n: mark, ids: [setup.id] });
    const move = got.filter((e) => e.p.kind === 'move' || e.p.kind === 'attackMove').pop();
    how += `${holdMs === 0 ? 'instant right-click' : '140 ms held right-click'}: ` +
      `${move ? `orderIssued ${move.p.kind}` : 'NO order'}${holdMs === 0 ? '; ' : ''}`;
    if (move && !ord) ord = move;
    if (ord) break;
  }
  const after = await page.evaluate((id) => window.__unit(id), setup.id);
  const moved = Math.hypot(after.targetX - before.targetX, after.targetZ - before.targetZ);
  const ok = !!ord && (ord.p.kind === 'move' || ord.p.kind === 'attackMove') && moved > 5;
  record('right-click move', ok,
    `right-click empty ground at (${Math.round(dest.x)},${Math.round(dest.y)}) with unit ${setup.id} selected ` +
    `— ${how}`,
    ord ? `orderIssued kind=${ord.p.kind} to (${Math.round(ord.p.x)},${Math.round(ord.p.z)}); unit.order ` +
      `${ORDER[before.order]}→${ORDER[after.order]}, unit.target (${before.targetX},${before.targetZ})→` +
      `(${after.targetX},${after.targetZ}) = ${moved.toFixed(1)} m` : 'no orderIssued event for that unit');

  // ---- 4b. does the player's order survive? ----
  // `installAI` in src/main.ts passes no `commanded` list, so GeneralAI/TacticalAI default
  // to commanding BOTH factions — including the player's. Measure whether the order holds.
  const playerTarget = { x: after.targetX, z: after.targetZ };
  const persist = await page.evaluate(async ({ id, n, want }) => {
    const g = window.__game;
    const out = [];
    for (let s = 1; s <= 10; s++) {
      g.advance(1);
      const u = g.battle.unitById(id);
      out.push({ s, dx: +Math.hypot(u.targetX - want.x, u.targetZ - want.z).toFixed(1), order: u.order });
    }
    const foreign = window.__tape.slice(n).filter((e) => e.k === 'orderIssued' && e.p.unitIds.includes(id));
    return { out, foreign: foreign.map((e) => ({ at: e.at, kind: e.p.kind, ids: e.p.unitIds.length })) };
  }, { id: setup.id, n: mark, want: playerTarget });
  const drifted = persist.out.find((o) => o.dx > 12);
  record('player order survives AI', !drifted,
    `after the move order, advance 10 s and watch unit ${setup.id}'s target`,
    drifted
      ? `AI overrode it after ~${drifted.s}s: target drifted ${drifted.dx} m from the ordered point ` +
        `(${persist.foreign.length} orderIssued events touched this unit: ` +
        `${persist.foreign.map((f) => `t+${f.at} ${f.kind}`).join(', ')})`
      : `target held within 12 m for 10 s (${persist.foreign.length} orderIssued events touched this unit)`);
}

// ---------------------------------------------------------------------------
// 5. right-click an enemy to attack
// ---------------------------------------------------------------------------
{
  const setup = await page.evaluate(() => {
    const g = window.__game;
    const mine = g.battle.units.find((v) => v.faction === 0 && !v.destroyed && v.alive > 100);
    // Nearest live *enemy* unit — faction 1 only.
    let foe = null, best = Infinity;
    for (const v of g.battle.units) {
      if (v.faction !== 1 || v.destroyed || v.alive <= 0) continue;
      const d = Math.hypot(v.x - mine.x, v.z - mine.z);
      if (d < best) { best = d; foe = v; }
    }
    // Frame both so both anchors project on screen and are pickable. Widen until they do:
    // a fixed zoom put one of the two off-canvas as the armies closed.
    const W = g.engine.context.viewW, H = g.engine.context.viewH;
    const inside = (p) => p && p.x > 40 && p.x < W - 40 && p.y > 40 && p.y < H - 140;
    let zoom = 0.5;
    for (const z of [0.5, 0.6, 0.7, 0.8, 0.88]) {
      g.setCamera((mine.x + foe.x) / 2, (mine.z + foe.z) / 2, z, Math.PI);
      g.advance(0.4);
      zoom = z;
      if (inside(window.__unitScreen(mine.id)) && inside(window.__unitScreen(foe.id))) break;
    }
    return { mine: mine.id, foe: foe.id, foeType: foe.typeId, dist: Math.round(best), zoom };
  });
  await settle(400);
  pos = await page.evaluate((id) => window.__unitScreen(id), setup.mine);
  if (!pos) { record('right-click attack', false, `unit ${setup.mine} anchor never projected on screen (zoom ${setup.zoom})`, 'n/a'); }
  else {
  await page.mouse.click(pos.x, pos.y);
  await settle(400);
  const selNow = await page.evaluate(() => window.__selection());
  const before = await page.evaluate((id) => window.__unit(id), setup.mine);
  mark = await page.evaluate(() => window.__tapeMark());
  const fp = await page.evaluate((id) => window.__unitScreen(id), setup.foe);
  if (!fp) { record('right-click attack', false, `enemy unit ${setup.foe} anchor never projected on screen`, 'n/a'); }
  else {
  await page.mouse.move(fp.x, fp.y);
  await settle(300);
  // The cursor must read "attack" before the click, else the pick missed the enemy.
  const cursor = await page.evaluate(() => document.body.dataset.cur);
  await page.mouse.click(fp.x, fp.y, { button: 'right' });
  await settle(600);
  const mine2 = await page.evaluate(({ n, ids }) => window.__ordersFor(n, ids), { n: mark, ids: selNow });
  const ord = mine2.filter((e) => e.p.kind === 'attack').pop() ?? mine2.pop();
  const after = await page.evaluate((id) => window.__unit(id), setup.mine);
  const ok = !!ord && ord.p.kind === 'attack' && ord.p.targetUnitId === setup.foe && after.targetUnitId === setup.foe;
  record('right-click attack', ok,
    `right-click enemy unit ${setup.foe} (${setup.foeType}, ${setup.dist} m away) with unit ${setup.mine} ` +
    `selected; cursor read "${cursor}"`,
    ord ? `orderIssued kind=${ord.p.kind} target=${ord.p.targetUnitId}; unit.order ` +
      `${ORDER[before.order]}→${ORDER[after.order]} targetUnitId ${before.targetUnitId}→${after.targetUnitId}`
      : `no orderIssued event for selection [${selNow.join(',')}]`);
  }
  }
}

// ---------------------------------------------------------------------------
// 6. right-click-drag sets frontage and facing
// ---------------------------------------------------------------------------
{
  const setup = await page.evaluate(() => {
    const g = window.__game;
    const u = g.battle.units.find((v) => v.faction === 0 && !v.destroyed && v.alive > 100);
    // Wide enough that a 140 m line fits inside the frame with room to spare; the previous
    // 0.62 put both drag ends off-canvas (x = -15 and 1626 in a 1600 px viewport).
    g.setCamera(u.x, u.z + 45, 0.80, Math.PI);
    g.advance(0.5);
    return { id: u.id };
  });
  await settle(400);
  pos = await page.evaluate((id) => window.__unitScreen(id), setup.id);
  await page.mouse.click(pos.x, pos.y);
  await settle(400);
  const selFront = await page.evaluate(() => window.__selection());
  const before = await page.evaluate((id) => window.__unit(id), setup.id);
  mark = await page.evaluate(() => window.__tapeMark());
  // Drag across ~140 m of ground, perpendicular to the unit's facing, shrinking the span
  // until both ends land comfortably inside the canvas.
  const ends = await page.evaluate((id) => {
    const g = window.__game;
    const u = g.battle.unitById(id);
    const W = g.engine.context.viewW, H = g.engine.context.viewH;
    const inside = (p) => p && p.x > 60 && p.x < W - 60 && p.y > 60 && p.y < H - 120;
    for (const half of [70, 55, 42, 30, 22]) {
      const a = window.__project(u.x - half, g.battle.groundAt(u.x - half, u.z + 70), u.z + 70);
      const b = window.__project(u.x + half, g.battle.groundAt(u.x + half, u.z + 70), u.z + 70);
      if (inside(a) && inside(b)) return { a, b, metres: half * 2 };
    }
    return null;
  }, setup.id);
  if (!ends) { record('right-drag frontage', false, 'could not fit a frontage line inside the canvas', 'n/a'); }
  else {
  await page.mouse.move(ends.a.x, ends.a.y);
  await settle(150);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(ends.a.x + (ends.b.x - ends.a.x) * i / 10, ends.a.y + (ends.b.y - ends.a.y) * i / 10);
    await page.waitForTimeout(30);
  }
  await settle(200);
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'frontage-drag.png') });
  await page.mouse.up({ button: 'right' });
  await settle(500);
  const mine3 = await page.evaluate(({ n, ids }) => window.__ordersFor(n, ids), { n: mark, ids: selFront });
  const ord = mine3.pop();
  const after = await page.evaluate((id) => window.__unit(id), setup.id);
  const widthChanged = after.width !== before.width;
  const gotWidth = !!ord && typeof ord.p.width === 'number';
  const gotFacing = !!ord && typeof ord.p.facing === 'number';
  const facingChanged = Math.abs(after.targetFacing - before.targetFacing) > 0.05;
  const ok = gotWidth && gotFacing && widthChanged && facingChanged;
  record('right-drag frontage', ok,
    `right-button drag ${Math.round(ends.a.x)},${Math.round(ends.a.y)} → ${Math.round(ends.b.x)},${Math.round(ends.b.y)} ` +
    `(~${ends.metres} m of ground) with unit ${setup.id} selected`,
    ord ? `orderIssued kind=${ord.p.kind} width=${ord.p.width} facing=${ord.p.facing}; ` +
      `unit.width ${before.width}→${after.width}, unit.targetFacing ${before.targetFacing}→${after.targetFacing}`
      : `no orderIssued event for selection [${selFront.join(',')}]`,
    ok ? '' : `width carried=${gotWidth} facing carried=${gotFacing} unit.width changed=${widthChanged} ` +
      `targetFacing changed=${facingChanged}`);
  }
}

// ---------------------------------------------------------------------------
// 7. formation button
// ---------------------------------------------------------------------------
// Re-establish a known single selection with a real click first: the command panel's
// buttons are meaningless without one, and an earlier step may have cleared it.
async function reselect() {
  // Pick a *pristine* unit — one the earlier frontage test has not stretched to 147 men per
  // rank — and retry: the pick is a footprint hit test, and a reforming unit can miss.
  let last = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const s = await page.evaluate((zoom) => {
      const g = window.__game;
      const own = g.battle.units.filter((v) => v.faction === 0 && !v.destroyed && v.alive > 100);
      const u = own.find((v) => v.width <= 60) ?? own[0];
      g.setCamera(u.x, u.z, zoom, u.facing + Math.PI);
      g.advance(0.5);
      return { id: u.id, width: u.width, formationId: u.formationId };
    }, 0.30 + attempt * 0.06);
    await settle(450);
    const p = await page.evaluate((id) => window.__unitScreen(id), s.id);
    if (!p) continue;
    await page.mouse.move(p.x, p.y);
    await settle(200);
    await page.mouse.click(p.x, p.y);
    await settle(500);
    last = await page.evaluate(() => window.__selection());
    if (last.length > 0) return { id: s.id, selection: last, attempt };
  }
  return { id: -1, selection: last, attempt: 4 };
}

{
  // Before re-selecting: with nothing selected, does the command panel still show buttons?
  // A live-looking button that issues nothing is worse than no button.
  const stale = await page.evaluate(() => {
    const sel = window.__selection();
    const forms = document.querySelectorAll('#hud-root .btnrow.forms .ob.fb').length;
    const abils = document.querySelectorAll('#hud-root .btnrow.abils .ob.ab').length;
    const panel = document.querySelector('#hud-root .cmd, #hud-root .command');
    return { sel, forms, abils, panelDisplay: panel ? getComputedStyle(panel).display : null };
  });
  if (stale.sel.length === 0 && (stale.forms > 0 || stale.abils > 0)) {
    record('command panel gating', false,
      'read the command panel with an empty selection',
      `${stale.forms} formation and ${stale.abils} ability buttons still rendered and clickable ` +
      `with selection []; panel display "${stale.panelDisplay}"`);
  } else {
    record('command panel gating', true, 'read the command panel with the current selection',
      `selection [${stale.sel.join(',')}], ${stale.forms} formation / ${stale.abils} ability buttons`);
  }

  const re = await reselect();
  const before = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#hud-root .btnrow.forms .ob.fb')];
    return { n: btns.length, titles: btns.map((b) => b.title) };
  });
  mark = await page.evaluate(() => window.__tapeMark());
  const selIds = re.selection;
  const uBefore = selIds.length ? await page.evaluate((id) => window.__unit(id), selIds[0]) : null;
  let ok = false, changed = `no formation buttons rendered (selection [${selIds.join(',')}])`;
  let want = null;
  if (selIds.length === 0) changed = 'selection was empty after a click-select — cannot test the panel';
  else if (before.n > 0) {
    // Resolve which button to press at click time, by the unit's *current* formation, not by
    // index: `buildButtons` rebuilds the row on every selection change, so an index read a
    // frame earlier can point at a different button, and re-issuing the formation the unit
    // is already in legitimately changes nothing.
    want = await page.evaluate((cur) => {
      const btns = [...document.querySelectorAll('#hud-root .btnrow.forms .ob.fb')];
      for (let i = 0; i < btns.length; i++) {
        const name = (btns[i].querySelector('.ob-lab')?.textContent ?? '').trim().toLowerCase();
        if (name && name !== cur) return { idx: i, name, title: btns[i].title.split('—')[0].trim() };
      }
      return null;
    }, uBefore.formationId);
    if (!want) changed = `every formation button is the unit's current formation (${uBefore.formationId})`;
    else {
    // Pause first. The AI commands Rome too and re-issues formation orders constantly, so
    // on a running clock it is impossible to tell the player's order from the AI's. Paused,
    // `fixedUpdate` does not run and the only possible emitter is this click.
    await page.evaluate(() => { window.__game.engine.time.paused = true; });
    mark = await page.evaluate(() => window.__tapeMark());
    await page.click(`#hud-root .btnrow.forms .ob.fb >> nth=${want.idx}`);
    await settle(600);
    const tape = await page.evaluate((n) => window.__tapeSince(n), mark);
    const all = tape.filter((e) => e.k === 'orderIssued' && e.p.kind === 'formation');
    const ord = all.filter((e) => e.p.unitIds.includes(selIds[0])).pop();
    // `applyOrder` is a synchronous event handler, so read the unit while still paused:
    // that separates "the sim never applied it" from "the AI reverted it".
    const whilePaused = await page.evaluate((id) => window.__game.battle.unitById(id).formationId, selIds[0]);
    // Then unpause and sample every 0.08 s for 2 s, recording who issues what.
    const trace = await page.evaluate(async (id) => {
      const g = window.__game;
      const seen = [];
      const off = g.engine.events.on('orderIssued', (o) => {
        if (o.kind === 'formation' && o.unitIds.includes(id)) seen.push(`${o.formation}@${g.simTime().toFixed(2)}`);
      });
      g.engine.time.paused = false;
      const out = [];
      for (let i = 0; i < 25; i++) { g.advance(0.08); out.push(g.battle.unitById(id).formationId); }
      off?.();
      return { formations: out, reissued: seen };
    }, selIds[0]);
    await settle(300);
    const uAfter = selIds.length ? await page.evaluate((id) => window.__unit(id), selIds[0]) : null;
    const applied = whilePaused === want.name;
    ok = !!ord && ord.p.formation === want.name && applied && uAfter.formationId === want.name;
    changed = all.length
      ? `emitted ${all.map((e) => `${e.p.formation}→[${e.p.unitIds.join(',')}]`).join(', ')}; ` +
        `unit.formationId while still paused = "${whilePaused}" (sim ${applied ? 'DID' : 'did NOT'} apply it); ` +
        `over the next 2 s of sim: ${[...new Set(trace.formations)].join(' → ')}` +
        (trace.reissued.length ? `; re-issued by another system: ${trace.reissued.join(', ')}` : '; nobody re-issued') +
        ` (wanted "${want.name}")`
      : 'no orderIssued(formation) event at all while paused';
    }
  }
  record('formation button', ok,
    want
      ? `click the "${want.title}" formation button (index ${want.idx} of ${before.n}) with unit ` +
        `${selIds[0]} selected, currently in "${uBefore?.formationId}"`
      : `command panel showed ${before.n} formation buttons`,
    changed);
}

// ---------------------------------------------------------------------------
// 8. ability button
// ---------------------------------------------------------------------------
{
  const re = await reselect();
  const info = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#hud-root .btnrow.abils .ob.ab')];
    return { n: btns.length, titles: btns.map((b) => b.title), disabled: btns.map((b) => b.disabled || b.classList.contains('cd')) };
  });
  mark = await page.evaluate(() => window.__tapeMark());
  let ok = false, changed = `no ability buttons rendered (selection [${re.selection.join(',')}])`;
  if (re.selection.length === 0) changed = 'selection was empty after a click-select — cannot test the panel';
  else if (info.n > 0) {
    await page.click('#hud-root .btnrow.abils .ob.ab >> nth=0');
    await settle(900);
    const tape = await page.evaluate((n) => window.__tapeSince(n), mark);
    const ord = tape.filter((e) => e.k === 'orderIssued' && e.p.kind === 'ability' &&
      e.p.unitIds.includes(re.selection[0])).pop();
    const act = tape.filter((e) => e.k === 'abilityActivated' && e.p.unitId === re.selection[0]).pop();
    ok = !!ord && !!act && act.p.active === true;
    changed = ord
      ? `orderIssued kind=ability ability=${ord.p.ability} units=[${ord.p.unitIds.join(',')}]; ` +
        (act ? `abilityActivated unit=${act.p.unitId} ability=${act.p.ability} active=${act.p.active}`
             : 'NO abilityActivated came back from the sim')
      : `no orderIssued(ability) for unit ${re.selection[0]}`;
  }
  record('ability button', ok,
    `click ability button 1 of ${info.n} ("${info.titles[0] ?? '-'}") with unit ${re.selection[0]} selected`,
    changed);
}

// ---------------------------------------------------------------------------
// 9. speed keys 1 / 2 / 3 / Space
// ---------------------------------------------------------------------------
{
  const readClock = () => page.evaluate(() => {
    const t = window.__game.engine.time;
    return { speed: t.gameSpeed, paused: t.paused };
  });
  const steps = [];
  for (const [key, want] of [['Digit2', 2], ['Digit3', 4], ['Digit1', 1]]) {
    await page.mouse.move(W * 0.5, H * 0.45);
    await page.keyboard.press(key);
    await settle(300);
    const c = await readClock();
    steps.push({ key, want, got: c.speed, paused: c.paused });
  }
  await page.keyboard.press('Space');
  await settle(300);
  const p1 = await readClock();
  const tA = await page.evaluate(() => window.__game.simTime());
  await settle(500);
  const tB = await page.evaluate(() => window.__game.simTime());
  await page.keyboard.press('Space');
  await settle(300);
  const p2 = await readClock();
  const bad = steps.filter((s) => s.got !== s.want);
  const ok = bad.length === 0 && p1.paused === true && p2.paused === false && Math.abs(tB - tA) < 0.05;
  record('speed keys 1/2/3', bad.length === 0,
    'press Digit2, Digit3, Digit1 over the canvas',
    steps.map((s) => `${s.key}→${s.got}x (want ${s.want}x)`).join(', '));
  record('Space pause', p1.paused === true && p2.paused === false && Math.abs(tB - tA) < 0.05,
    'press Space, wait 500 ms, press Space',
    `paused ${p1.paused} then ${p2.paused}; simTime froze at ${tA.toFixed(2)}→${tB.toFixed(2)}`);
  if (!ok) { /* individual records already carry the failure */ }
}

// ---------------------------------------------------------------------------
// 10. F3 AI debug overlay
// ---------------------------------------------------------------------------
{
  const readAi = () => page.evaluate(() => {
    const d = window.__game.engine.context.tryGet('ai-debug');
    if (!d) return { found: false };
    // The overlay's own visibility flag if it publishes one, else the scene group's.
    const keys = Object.keys(d);
    const vis = d.enabled ?? d.visible ?? d.on ?? null;
    let groupVisible = null, groupChildren = null;
    for (const k of keys) {
      const v = d[k];
      if (v && typeof v === 'object' && 'isObject3D' in v && v.isObject3D) {
        groupVisible = v.visible; groupChildren = v.children.length;
      }
    }
    return { found: true, name: d.name, keys, vis, groupVisible, groupChildren };
  });
  const b = await readAi();
  await page.mouse.move(W * 0.5, H * 0.45);
  await page.keyboard.press('F3');
  await settle(500);
  const a = await readAi();
  const ok = b.found && (a.vis !== b.vis || a.groupVisible !== b.groupVisible || a.groupChildren !== b.groupChildren);
  record('F3 AI debug overlay', ok, 'press F3 over the canvas',
    b.found ? `ai-debug enabled ${JSON.stringify(b.vis)}→${JSON.stringify(a.vis)}, ` +
      `group visible ${b.groupVisible}→${a.groupVisible}, children ${b.groupChildren}→${a.groupChildren}`
      : 'no subsystem named "ai-debug"');
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'f3-overlay.png') });
  await page.keyboard.press('F3');
  await settle(300);
}

// ---------------------------------------------------------------------------
// 11. L performance overlay
// ---------------------------------------------------------------------------
{
  const readPerf = () => page.evaluate(() => {
    const e = document.querySelector('#hud-root .hud-perf');
    if (!e) return { found: false };
    return { found: true, display: getComputedStyle(e).display, text: (e.textContent ?? '').slice(0, 90) };
  });
  const b = await readPerf();
  await page.mouse.move(W * 0.5, H * 0.45);
  await page.keyboard.press('KeyL');
  await settle(400);
  const m = await readPerf();
  await page.keyboard.press('KeyL');
  await settle(400);
  const a = await readPerf();
  const ok = b.found && m.display !== b.display && a.display === b.display;
  record('L perf overlay', ok, 'press L twice over the canvas',
    b.found ? `.hud-perf display "${b.display}" → "${m.display}" → "${a.display}"; text: "${a.text}"`
      : 'no .hud-perf element in the DOM');
}

// ---------------------------------------------------------------------------
// 12. minimap click
// ---------------------------------------------------------------------------
{
  const box = await page.evaluate(() => {
    const c = document.querySelector('#hud-root .minimap canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const camBefore = await page.evaluate(() => {
    const r = window.__game.engine.rig;
    return { x: +r.focus.x.toFixed(2), z: +r.focus.z.toFixed(2) };
  }).catch(() => null);
  let ok = false, changed = 'no minimap canvas in the DOM';
  if (box && camBefore) {
    // Click well away from the current centre so any movement is unambiguous.
    const cx = box.x + box.w * 0.25, cy = box.y + box.h * 0.25;
    await page.mouse.click(cx, cy);
    await settle(900);
    const camAfter = await page.evaluate(() => {
      const r = window.__game.engine.rig;
      return { x: +r.focus.x.toFixed(2), z: +r.focus.z.toFixed(2) };
    });
    const d = Math.hypot(camAfter.x - camBefore.x, camAfter.z - camBefore.z);
    ok = d > 20;
    changed = `camera focus (${camBefore.x},${camBefore.z}) → (${camAfter.x},${camAfter.z}), moved ${d.toFixed(1)} m`;
  }
  record('minimap click', ok, box ? `click minimap canvas at 25%,25% of its ${Math.round(box.w)}×${Math.round(box.h)} box` : 'n/a', changed);
}

if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'hud-final.png') });

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} interactions passed`);
if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s):`);
  for (const e of [...new Set(consoleErrors)].slice(0, 12)) console.log(`  ${e}`);
}
if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ results, consoleErrors: [...new Set(consoleErrors)] }, null, 2));
await browser.close();
if (server) server.kill('SIGTERM');
process.exit(failed || consoleErrors.length ? 1 : 0);
