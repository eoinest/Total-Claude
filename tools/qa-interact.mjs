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
  /**
   * Where to put the cursor so `SelectionController.pickUnit` resolves this unit.
   *
   * **Not the unit anchor, and not lifted.** This used to project `u.x, groundAt + 1, u.z`,
   * and both halves of that were wrong. The anchor is the midpoint of the *front rank*, not
   * the centre of the block the pick tests; and the metre of lift puts the pixel above the
   * men — measured at ~48 px at some zooms — so `right-click move` and `right-click attack`
   * read as failing against a product that works. Proven three ways in one session and
   * recorded in `docs/HANDOFF.md` as a harness fault.
   *
   * The point below is exactly the one the controller tests: `picking.footprintOf`'s block
   * centre, at the level the men are standing on. A unit on a wall walk is tested on a plane
   * at `standY + MAN_MID_Y` instead, so it is projected there — one function, both cases,
   * mirroring one function in the product.
   */
  window.__unitScreen = (id) => {
    const u = g.battle.unitById(id);
    if (!u) return null;
    const p = g.battle.pool;
    let n = 0, sy = 0;
    for (const i of u.members) { if (!p.aliveAt(i)) continue; n++; sy += p.y[i]; }
    const ranks = Math.max(1, Math.ceil(Math.max(1, u.alive) / Math.max(1, u.width)));
    const depth = Math.max(1.4, (ranks - 1) * u.spacingZ + 1.3);
    const cx = u.x - Math.sin(u.facing) * depth * 0.5;
    const cz = u.z - Math.cos(u.facing) * depth * 0.5;
    const cy = g.battle.groundAt(cx, cz);
    const standY = n ? sy / n : cy;
    const elevated = standY - cy > 2.5;
    return window.__project(cx, elevated ? standY + 0.9 : cy, cz);
  };
  /** HUD-clear screen points, the ones farthest from any unit anchor first. */
  window.__spotCandidates = () => {
    const g = window.__game;
    const W = g.engine.context.viewW, H = g.engine.context.viewH;
    const rects = Array.from(document.querySelectorAll('#hud-root .interactive'))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    const anchors = [];
    for (const v of g.battle.units) {
      if (v.destroyed) continue;
      const p = window.__project(v.x, g.battle.groundAt(v.x, v.z) + 1, v.z);
      if (p) anchors.push(p);
    }
    const out = [];
    for (let fy = 0.1; fy <= 0.76; fy += 0.06) {
      for (let fx = 0.1; fx <= 0.64; fx += 0.06) {
        const p = { x: Math.round(W * fx), y: Math.round(H * fy) };
        if (rects.some((r) => p.x >= r.left - 10 && p.x <= r.right + 10 && p.y >= r.top - 10 && p.y <= r.bottom + 10)) continue;
        // The press has to reach the canvas, or `overUi` swallows it and nothing turns.
        const hit = document.elementFromPoint(p.x, p.y);
        if (!hit || hit.id !== 'viewport') continue;
        let d = 9999;
        for (const a of anchors) d = Math.min(d, Math.hypot(a.x - p.x, a.y - p.y));
        out.push({ x: p.x, y: p.y, clear: Math.round(d) });
      }
    }
    out.sort((a, b) => b.clear - a.clear);
    return out.slice(0, 10);
  };
  window.__hovered = () => {
    const hud = window.__game.engine.context.tryGet('hud');
    return hud ? hud.hoveredUnitId : -2;
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
/** Shortest signed angle between two headings, so a yaw delta across the pi seam is honest. */
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const readYaw = (p = page) => p.evaluate(() => +window.__game.engine.rig.yaw.toFixed(4));

/**
 * A point the game itself reports as empty: candidates are HUD-clear by geometry, then the
 * cursor is parked on each and the HUD asked what it picked. Nothing else can prove that a
 * press is landing on bare ground rather than on a cohort's footprint slack.
 */
const bareSpot = async () => {
  const cands = await page.evaluate(() => window.__spotCandidates());
  for (const c of cands) {
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(140);
    if (await page.evaluate(() => window.__hovered()) < 0) return c;
  }
  return null;
};

/** A unit the HUD confirms is under the cursor, re-projected now because the sim is running. */
const pickableUnit = async (exclude = []) => {
  const cands = await page.evaluate((skip) => {
    const g = window.__game;
    const W = g.engine.context.viewW, H = g.engine.context.viewH;
    const out = [];
    for (const v of g.battle.units) {
      if (v.destroyed || v.faction !== 0 || v.alive < 50 || skip.includes(v.id)) continue;
      const p = window.__unitScreen(v.id);
      if (!p || p.x < 70 || p.x > W - 70 || p.y < 70 || p.y > H - 190) continue;
      const hit = document.elementFromPoint(p.x, p.y);
      if (!hit || hit.id !== 'viewport') continue;
      out.push({ id: v.id, x: Math.round(p.x), y: Math.round(p.y) });
    }
    return out.slice(0, 8);
  }, exclude);
  for (const c of cands) {
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(150);
    if (await page.evaluate(() => window.__hovered()) === c.id) return c;
  }
  return null;
};

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
  // 140 ms, not 40: `Input` reports one press edge per frame, and a contended frame here runs
  // 90 ms, so both click pairs used to land in one frame and read as a single click.
  await page.mouse.dblclick(pos.x, pos.y, { delay: 140 });
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
    // Focus the unit itself, not 40 m behind it. The old framing put its anchor at y 231 —
    // high in the frame, under the enlarged top bar — and pushed every world-space
    // destination candidate off the bottom of the viewport (one projected to y 1471).
    g.setCamera(u.x, u.z, 0.42, Math.PI);
    g.advance(0.4);
    return { id: u.id };
  });
  await settle(350);
  pos = await page.evaluate((id) => window.__unitScreen(id), setup.id);
  await page.mouse.click(pos.x, pos.y);
  await settle(350);
  /*
   * Assert the selection before ordering.
   *
   * `handleRight` does nothing at all with an empty selection, so a click that missed makes
   * the *next* check report "no orderIssued" — a right-click failure for a selection
   * failure, one step removed from its cause. One retry on the controller's own hover
   * answer, then say which of the two actually broke.
   */
  let selOk = (await page.evaluate(() => window.__selection())).includes(setup.id);
  if (!selOk) {
    for (const [dx, dy] of [[0, 12], [0, -12], [18, 0], [-18, 0], [0, 26], [0, -26]]) {
      await page.mouse.move(pos.x + dx, pos.y + dy);
      await settle(120);
      if ((await page.evaluate(() => window.__game.engine.context.tryGet('hud')?.controller?.model.hoveredId ?? -1)) !== setup.id) continue;
      await page.mouse.click(pos.x + dx, pos.y + dy);
      await settle(280);
      selOk = (await page.evaluate(() => window.__selection())).includes(setup.id);
      if (selOk) { pos = { x: pos.x + dx, y: pos.y + dy }; break; }
    }
  }
  record('select before ordering', selOk,
    `left-click unit ${setup.id} at (${Math.round(pos.x)},${Math.round(pos.y)}) — the block centre `
    + `at the men's own level, not the anchor lifted a metre`,
    `selection [${(await page.evaluate(() => window.__selection())).join(',')}]`);
  const before = await page.evaluate((id) => window.__unit(id), setup.id);
  mark = await page.evaluate(() => window.__tapeMark());
  /*
   * A destination clear of the HUD, of the viewport edges, and of every unit on screen.
   *
   * `right-click move` and `right-click attack` were red for a long stretch, and the cause was
   * neither the pre-battle menu nor the HUD scale — both of those were investigated and both
   * were wrong. It was the pick geometry: the cursor ray was intersected with the ground while
   * a click actually lands on a man whose chest is about a metre up, so from anywhere but the
   * unit's face the overshoot fell outside the formation footprint, and the slack it had to
   * fall inside collapsed to 13 cm at close zoom. `screenPick`'s solid hit and the pick slack
   * floor are the two halves of that; if either regresses, these two go red together.
   *
   * The framing work below is kept anyway, because it fixes a real fragility even though it
   * does not fix the failure. The check used to use one fixed world offset of (+20, +55), which
   * projected to 1561,706 — underneath the 217 px minimap once the default HUD scale went to
   * 1.35, where `Input.uiCapture` suppresses world clicks by design. So the check was one HUD
   * tweak away from failing for a second, entirely different reason on top of the first.
   */
  const dest = await page.evaluate((id) => {
    const g = window.__game;
    const u = g.battle.unitById(id);
    const rects = Array.from(document.querySelectorAll('#hud-root .interactive'))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    // Screen positions of every unit that could intercept the click. A right-click *on* a
    // unit is a target order, not a move, so "empty ground" has to mean empty on screen too —
    // the first version of this only avoided the HUD and picked a point 8 px from the selected
    // cohort's own anchor, which issued no move order and looked like a broken right-click.
    const anchors = [];
    for (const v of g.battle.units) {
      if (v.destroyed) continue;
      const p = window.__project(v.x, g.battle.groundAt(v.x, v.z) + 1, v.z);
      if (p) anchors.push(p);
    }
    const clear = (p) => {
      if (!p) return false;
      const m = 24;
      if (p.x < m || p.y < m || p.x > g.engine.context.viewW - m || p.y > g.engine.context.viewH - m) return false;
      if (rects.some((r) => p.x >= r.left - 8 && p.x <= r.right + 8 && p.y >= r.top - 8 && p.y <= r.bottom + 8)) return false;
      return !anchors.some((a) => Math.hypot(a.x - p.x, a.y - p.y) < 90);
    };
    /*
     * Offsets are in SCREEN pixels from the unit's own anchor, not in world metres.
     *
     * World-space offsets are the wrong tool here: how far 55 m of ground travels on screen
     * depends on the zoom, the pitch and the terrain under it, so a fixed metre offset landed
     * on a HUD panel at one HUD scale and 471 px below the bottom of the window at another.
     * A screen offset is by construction on screen, and because the camera looks down at the
     * ground, a point below the unit is always ground in front of it.
     */
    const self = window.__project(u.x, g.battle.groundAt(u.x, u.z) + 1, u.z);
    if (!self) return null;
    /*
     * Upward first: a cohort faces the enemy at -Z and the camera looks along -Z too, so the
     * unit's own nine ranks extend *toward* the camera, downward on screen, while above the
     * anchor is the open ground between the two armies. The 90 px anchor test cannot separate
     * those on its own, because it measures distance to a unit's centre and a 320-man cohort is
     * wider and deeper than 90 px at this zoom.
     *
     * Tried as a fix for the failure above and it was not one — the order is still not issued
     * at a point 183 px clear of the formation. Kept because aiming at open ground is the right
     * thing for the check to do regardless.
     */
    const px = [
      [0, -170], [0, -220], [-160, -140], [160, -140], [-240, -70], [240, -70], [0, -270],
      [-300, 0], [300, 0], [0, 200], [-200, 180], [200, 180],
    ];
    for (const [dx, dy] of px) {
      const p = { x: self.x + dx, y: self.y + dy };
      if (clear(p)) return p;
    }
    return null;
  }, setup.id);
  // Fail loudly rather than carry on and misattribute the result: everything after this
  // point assumes a usable ground point, and eight candidate offsets covering both sides and
  // three depths should always find one. If none does, the framing is wrong, not the game.
  if (!dest) throw new Error('qa-interact: no HUD-clear ground point found behind the unit');
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
  const yaw0 = await readYaw();
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
  // The same gesture, measured on the camera. Right-drag once turned the view whenever the
  // selection happened to be empty, so one drag meant two things depending on hidden state.
  const yaw1 = await readYaw();
  record('right-drag holds yaw', Math.abs(wrapPi(yaw1 - yaw0)) < 0.01,
    'measure the camera yaw across that same right-button drag',
    `yaw ${yaw0} → ${yaw1} (${Math.abs(wrapPi(yaw1 - yaw0)).toFixed(4)} rad)`);
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

// ---------------------------------------------------------------------------
// 13. camera gestures: every mouse route to the camera, on the real input path
// ---------------------------------------------------------------------------
/*
 * Mouse-only, and every check drives a real Playwright event at real screen coordinates.
 * The shipped routes are: middle drag pans, right drag turns *unless* an order drag has
 * claimed the button (`RTSCamera.suppressDrag`), the screen edge pans, the minimap plate
 * jumps and drags the focus, and the minimap compass turns.
 *
 * The bare-ground checks lean on `bareSpot()`, which is the only honest way to find a point
 * that presses on nothing: geometry says which candidates clear the HUD, and then the cursor
 * is parked on each and the HUD is asked what it picked. A point 200 px from every unit
 * anchor can still be inside a cohort's footprint slack, and a check that assumes otherwise
 * fails for a reason that has nothing to do with what it is testing.
 */
{
  const rig = () => page.evaluate(() => {
    const r = window.__game.engine.rig;
    return { x: +r.focus.x.toFixed(2), z: +r.focus.z.toFixed(2), yaw: +r.yaw.toFixed(4) };
  });
  const selNow = () => page.evaluate(() => window.__selection());

  // ---- 13a. framing: this block needs open ground and two units on screen at once ----
  await page.evaluate(() => {
    const g = window.__game;
    const own = g.battle.units.filter((v) => v.faction === 0 && !v.destroyed && v.alive > 50);
    let sx = 0, sz = 0;
    for (const u of own) { sx += u.x; sz += u.z; }
    g.setCamera(sx / own.length, sz / own.length, 0.66, Math.PI);
    g.advance(0.5);
  });
  await settle(450);

  // ---- 13b. a plain click still selects, and a plain click on bare ground still clears ----
  // Re-picked rather than reusing a stale anchor: the sim is running and units march.
  const again = await pickableUnit();
  if (!again) record('plain left click selects', false, 'no Roman unit was pickable on screen', 'n/a');
  else {
    await page.mouse.click(again.x, again.y);
    await settle(500);
    const on = await selNow();
    record('plain left click selects', on.length === 1 && on[0] === again.id,
      `click unit ${again.id} at ${again.x},${again.y} with no travel`,
      `selection → [${on.join(',')}]`);
    const bare = await bareSpot();
    if (!bare) record('plain left click clears', false, 'no bare spot for a clearing click', 'n/a');
    else {
      const h0 = await rig();
      await page.mouse.click(bare.x, bare.y);
      await settle(500);
      const off = await selNow();
      const h1 = await rig();
      record('plain left click clears', on.length > 0 && off.length === 0 && Math.abs(wrapPi(h1.yaw - h0.yaw)) < 0.01,
        `click bare ground at ${bare.x},${bare.y} with no travel`,
        `selection [${on.join(',')}] → [${off.join(',')}]; yaw ${h0.yaw} → ${h1.yaw}`);
    }
  }

  // Mid-field and a known heading, so no result is really the focus clamp at the map edge.
  await page.evaluate(() => { window.__game.setCamera(0, 0, 0.55, Math.PI); window.__game.advance(0.4); });
  await settle(400);

  // ---- 13c. middle drag pans the focus, and must not turn the view ----
  // The first frame of the drag is the one that used to be wrong: `Input` derived every
  // button's delta from one shared cursor position, so the press frame reported however far
  // the mouse had travelled *before* it. This drag is preceded by a 300 px cursor move for
  // exactly that reason — a regression here shows up as an overshoot on the pan.
  const cx = Math.round(W * 0.5), cy = Math.round(H * 0.45);
  await page.mouse.move(cx - 300, cy);
  await page.mouse.move(cx, cy);
  await settle(200);
  const a0 = await rig();
  await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 12; i++) { await page.mouse.move(cx + i * 25, cy); await page.waitForTimeout(30); }
  await page.mouse.up({ button: 'middle' });
  await settle(700);
  const a1 = await rig();
  const turn = Math.abs(wrapPi(a1.yaw - a0.yaw));
  const slid = Math.hypot(a1.x - a0.x, a1.z - a0.z);
  record('middle drag pans', slid > 10,
    `middle-button drag 300 px to the right across the canvas from ${cx},${cy}, after a ` +
    '300 px cursor move with no button held',
    `focus (${a0.x},${a0.z}) → (${a1.x},${a1.z}), moved ${slid.toFixed(2)} m`);
  record('middle drag never turns', turn < 0.01,
    'the same drag, measured on the camera yaw instead of the focus',
    `yaw ${a0.yaw} → ${a1.yaw} (${turn.toFixed(4)} rad)`);
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'middle-drag-pan.png') });

  // ---- 13d. right drag with nothing selected turns the view ----
  // With a selection it is the frontage gesture and `suppressDrag` holds the camera off it;
  // that arm is checked in block 6. This is the other half of the same switch.
  await page.evaluate(() => { window.__game.setCamera(0, 0, 0.55, Math.PI); window.__game.advance(0.4); });
  await settle(400);
  const clearSpot = await bareSpot();
  if (clearSpot) { await page.mouse.click(clearSpot.x, clearSpot.y); await settle(400); }
  const emptySel = await selNow();
  const b0 = await rig();
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 12; i++) { await page.mouse.move(cx + i * 25, cy); await page.waitForTimeout(30); }
  await page.mouse.up({ button: 'right' });
  await settle(700);
  const b1 = await rig();
  record('right drag empty turns', emptySel.length === 0 && Math.abs(wrapPi(b1.yaw - b0.yaw)) > 0.5,
    `right-button drag 300 px with the selection cleared to [${emptySel.join(',')}]`,
    `yaw ${b0.yaw} → ${b1.yaw} (${wrapPi(b1.yaw - b0.yaw).toFixed(4)} rad)`);

  // ---- 13e. screen-edge pan ----
  // A panel under the cursor takes the canvas hover away, so the point must clear every one.
  const edge = await page.evaluate(() => {
    const rects = Array.from(document.querySelectorAll('#hud-root .interactive'))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    const clear = (p) => !rects.some((r) =>
      p.x >= r.left - 6 && p.x <= r.right + 6 && p.y >= r.top - 6 && p.y <= r.bottom + 6);
    const h = window.innerHeight, w = window.innerWidth;
    for (const f of [0.5, 0.4, 0.6, 0.32, 0.68]) {
      for (const x of [2, w - 3]) {
        const p = { x, y: Math.round(h * f) };
        if (clear(p)) return { ...p, side: x < 10 ? 'left' : 'right' };
      }
    }
    return null;
  });
  if (!edge) record('screen-edge pan', false, 'no HUD-clear point on either vertical screen edge', 'n/a');
  else {
    const c0 = await rig();
    await page.mouse.move(edge.x, edge.y);
    await settle(900);
    const c1 = await rig();
    // Back to the middle, or the camera keeps panning through every later check.
    await page.mouse.move(cx, cy);
    await settle(400);
    const moved = Math.hypot(c1.x - c0.x, c1.z - c0.z);
    record('screen-edge pan', moved > 10,
      `hold the cursor at the ${edge.side} screen edge (${edge.x},${edge.y}) for 900 ms`,
      `focus (${c0.x},${c0.z}) → (${c1.x},${c1.z}), moved ${moved.toFixed(1)} m; yaw ${c0.yaw} → ${c1.yaw}`);
  }

  // ---- 13f. minimap drag ----
  const mm = await page.evaluate(() => {
    const c = document.querySelector('#hud-root .minimap canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (!mm) record('minimap drag', false, 'no minimap canvas in the DOM', 'n/a');
  else {
    const from = { x: mm.x + mm.w * 0.3, y: mm.y + mm.h * 0.3 };
    const to = { x: mm.x + mm.w * 0.72, y: mm.y + mm.h * 0.72 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await settle(250);
    const d0 = await rig();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8);
      await page.waitForTimeout(30);
    }
    await settle(250);
    const d1 = await rig();
    await page.mouse.up();
    await settle(300);
    // Measured from the press, which is the click route covered above, so this is the drag.
    const dragged = Math.hypot(d1.x - d0.x, d1.z - d0.z);
    record('minimap drag', dragged > 20,
      `press the minimap plate at 30%,30% and drag to 72%,72% of its ${Math.round(mm.w)}×${Math.round(mm.h)} box`,
      `focus after the press (${d0.x},${d0.z}) → (${d1.x},${d1.z}) at the end of the drag, ` +
      `moved ${dragged.toFixed(1)} m while held`);
  }

  // ---- 13g. the harness contract tools/shoot.mjs grades every other lane through ----
  // `#loading` is read from the served markup, not the live DOM: `src/main.ts` removes the
  // node once the game is ready, and shoot.mjs only ever names it in an injected CSS rule.
  const harness = await page.evaluate(async () => {
    const g = window.__game;
    const src = await fetch('/').then((r) => r.text()).catch(() => '');
    const before = { x: +g.engine.rig.focus.x.toFixed(2), yaw: +g.engine.rig.yaw.toFixed(4) };
    g.setCamera(-120, 260, 0.5, 1.1);
    g.advance(0.2);
    const r = g.engine.rig;
    return {
      hud: !!document.getElementById('hud-root'),
      loadingId: /id=["']loading["']/.test(src),
      loadingLive: !!document.getElementById('loading'),
      setCamera: typeof g.setCamera === 'function',
      before,
      after: { x: +r.focus.x.toFixed(2), z: +r.focus.z.toFixed(2), zoom: +r.zoom.toFixed(4), yaw: +r.yaw.toFixed(4) },
    };
  });
  const took = harness.after.x === -120 && harness.after.z === 260 && Math.abs(harness.after.yaw - 1.1) < 0.001;
  record('harness camera contract', harness.hud && harness.loadingId && harness.setCamera && took,
    'check #hud-root and the #loading id, then drive setCamera(-120, 260, 0.5, 1.1)',
    `#hud-root ${harness.hud}, #loading declared ${harness.loadingId} (still in the DOM: ` +
    `${harness.loadingLive}), setCamera ${harness.setCamera}; focus x ${harness.before.x} → ` +
    `${harness.after.x}, z ${harness.after.z}, zoom ${harness.after.zoom}, ` +
    `yaw ${harness.before.yaw} → ${harness.after.yaw}`);
}

// ---------------------------------------------------------------------------
// 14. the card bar selects
// ---------------------------------------------------------------------------
{
  const selNow = () => page.evaluate(() => window.__selection());
  const before = await selNow();
  const card = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#hud-root .cardbar .card:not(.mini)'));
    const c = cards[Math.min(2, cards.length - 1)];
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), n: cards.length };
  });
  if (!card) record('unit card selects', false, 'no unit cards in the card bar', 'n/a');
  else {
    await page.mouse.click(card.x, card.y);
    await settle(500);
    const one = await selNow();
    record('unit card selects', one.length === 1,
      `click unit card 3 of ${card.n} at ${card.x},${card.y} with no key held`,
      `selection [${before.join(',')}] → [${one.join(',')}]`);
  }
}

// ---------------------------------------------------------------------------
// Starting through the pre-battle menu
// ---------------------------------------------------------------------------
/*
 * Every check above loads with `?harness=1`, which skips the menu — so none of them could
 * see either of the two bugs that shipping the menu introduced, and a player found both in
 * the first minute:
 *
 *   1. `#menu-root` is full-screen, fixed and above the canvas, and kept `pointer-events:
 *      auto` after the menu closed, so the empty container swallowed every click, drag and
 *      wheel for the rest of the session. The keyboard still worked, because key events are
 *      not hit-tested, which is exactly how it was reported.
 *   2. The browser fires `pointerenter` on the canvas the moment that overlay is removed,
 *      while `Input.mouseX/mouseY` were still their initial 0,0 — the top-left *corner* — so
 *      the camera edge-panned on its own from (0, 120) to (-319, 9) in under three seconds
 *      with the cursor sitting still in the middle of the screen.
 *
 * So this runs the real path a player takes: no harness flag, press Begin, then drive the
 * mouse. A separate page, because the flags differ from the rest of the file.
 */
{
  const mp = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  mp.on('pageerror', (e) => consoleErrors.push(`pageerror(menu): ${e.message}`));
  mp.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`menu: ${m.text()}`); });
  await mp.goto(`${base}/?autoplay=0&quality=high`, { waitUntil: 'domcontentloaded' });

  const sawMenu = await mp.waitForSelector('.menu.in', { timeout: 60000 }).then(() => true).catch(() => false);
  record('menu appears', sawMenu, 'load with no harness flag and wait for the front door',
    sawMenu ? 'the menu rendered and faded in' : 'no .menu.in appeared');

  if (sawMenu) {
    // The menu opens on the front door now — battle, documentation, model viewer — and the
    // setup screen is one click in. No `?menu=battle` here on purpose: this block exists to
    // prove the pointer works on the path a player actually takes, and that path starts at
    // the front door.
    await mp.click('.menu-home .dest-battle');
    await mp.waitForSelector('.menu .begin', { timeout: 60000 });
    await mp.click('.begin');
    await mp.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
    // Long enough for the intro fade to finish and the menu node to be removed.
    await mp.waitForTimeout(2600);

    const layer = await mp.evaluate(() => {
      const mr = document.getElementById('menu-root');
      const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      return {
        pe: getComputedStyle(mr).pointerEvents,
        kids: mr.children.length,
        at: hit ? `${hit.tagName.toLowerCase()}${hit.id ? '#' + hit.id : ''}` : 'nothing',
      };
    });
    record('menu releases the pointer', layer.at === 'canvas#viewport',
      'after Begin, ask the browser what is under the centre of the screen',
      `#menu-root pointer-events:${layer.pe}, ${layer.kids} children, elementFromPoint → ${layer.at}`);

    // The camera must sit still when nothing is touching it.
    const drift = await mp.evaluate(async () => {
      const r = window.__game.engine.rig;
      const a = { x: r.focus.x, z: r.focus.z };
      await new Promise((res) => setTimeout(res, 2000));
      return { a, b: { x: r.focus.x, z: r.focus.z } };
    });
    const d = Math.hypot(drift.b.x - drift.a.x, drift.b.z - drift.a.z);
    record('camera holds still', d < 2,
      'leave the mouse untouched for 2 s after the menu closes',
      `focus moved ${d.toFixed(1)} m — (${drift.a.x.toFixed(0)},${drift.a.z.toFixed(0)}) → (${drift.b.x.toFixed(0)},${drift.b.z.toFixed(0)})`);

    const rig = () => mp.evaluate(() => {
      const r = window.__game.engine.rig;
      return {
        zoom: +r.zoom.toFixed(4), yaw: +r.yaw.toFixed(4),
        x: +r.focus.x.toFixed(2), z: +r.focus.z.toFixed(2),
      };
    });

    const z0 = await rig();
    await mp.mouse.move(W * 0.5, H * 0.5);
    for (let i = 0; i < 6; i++) { await mp.mouse.wheel(0, 240); await mp.waitForTimeout(60); }
    await mp.waitForTimeout(700);
    const z1 = await rig();
    record('wheel zooms after menu', z1.zoom !== z0.zoom, 'six wheel notches over the canvas',
      `zoom ${z0.zoom} → ${z1.zoom}`);

    // Middle drag on the field, on the real player path rather than behind `?harness=1`.
    await mp.mouse.move(W * 0.5, H * 0.45);
    await mp.mouse.down({ button: 'middle' });
    for (let i = 1; i <= 12; i++) { await mp.mouse.move(W * 0.5 + i * 25, H * 0.45); await mp.waitForTimeout(30); }
    await mp.mouse.up({ button: 'middle' });
    await mp.waitForTimeout(700);
    const zm = await rig();
    record('middle drag pans after menu', Math.hypot(zm.x - z1.x, zm.z - z1.z) > 10,
      'middle-button drag 300 px right across the canvas',
      `focus (${z1.x},${z1.z}) → (${zm.x},${zm.z}), ` +
      `moved ${Math.hypot(zm.x - z1.x, zm.z - z1.z).toFixed(1)} m`);

    // The right button is also the order button, so the compass is a second route to yaw
    // that never has to ask what is selected.
    const rose = await mp.evaluate(() => {
      const el = document.querySelector('#hud-root .mm-compass');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!rose) record('compass drag rotates after menu', false, 'no .mm-compass in the DOM', 'n/a');
    else {
      await mp.mouse.move(rose.x, rose.y);
      await mp.mouse.down();
      for (let i = 1; i <= 10; i++) await mp.mouse.move(rose.x + i * 12, rose.y);
      await mp.mouse.up();
      await mp.waitForTimeout(700);
      const z2 = await rig();
      record('compass drag rotates after menu', z2.yaw !== zm.yaw, 'drag the minimap compass 120 px across',
        `yaw ${zm.yaw} → ${z2.yaw}`);
    }

    const selCount = async () => mp.evaluate(() => {
      const t = document.querySelector('.hud-perf')?.textContent ?? '';
      return Number(t.match(/sel (\d+)/)?.[1] ?? -1);
    });
    /*
     * Frame a unit, then click it. `setCamera` is the harness hook, not an input path, so the
     * click itself is still a real one at real coordinates.
     *
     * **The projection is the one `SelectionController.pickUnit` tests, and it used to be a
     * second copy of the wrong one.** This block carried its own inline `u.x, groundAt + 1,
     * u.z` — the unit *anchor*, lifted a metre — which is the anchor at the midpoint of the
     * front rank rather than the centre of the block, at a height above the men's own level.
     * Fixing `window.__unitScreen` did not fix this, because this page never called it: the
     * check went red the moment the product's pick started testing the men's mid-body plane
     * instead of the terrain point 5.4 m behind them. One projection, in one place.
     */
    const spot = await mp.evaluate(() => {
      const g = window.__game;
      const u = g.battle.units.find((v) => v.faction === 0 && !v.destroyed && v.alive > 100);
      g.setCamera(u.x, u.z, 0.34, u.facing + Math.PI);
      g.advance(0.4);
      const cam = g.engine.context.camera;
      const p = g.battle.pool;
      let n = 0, sy = 0;
      for (const i of u.members) { if (!p.aliveAt(i)) continue; n++; sy += p.y[i]; }
      const ranks = Math.max(1, Math.ceil(Math.max(1, u.alive) / Math.max(1, u.width)));
      const depth = Math.max(1.4, (ranks - 1) * u.spacingZ + 1.3);
      const cx = u.x - Math.sin(u.facing) * depth * 0.5;
      const cz = u.z - Math.cos(u.facing) * depth * 0.5;
      const cy = g.battle.groundAt(cx, cz);
      const standY = n ? sy / n : cy;
      const v = cam.position.clone();
      v.set(cx, (standY - cy > 2.5 ? standY : cy) + 0.9, cz).project(cam);
      if (v.z > 1) return null;
      return {
        px: (v.x * 0.5 + 0.5) * g.engine.context.viewW,
        py: (-v.y * 0.5 + 0.5) * g.engine.context.viewH,
      };
    });
    if (!spot) {
      record('click selects after menu', false, 'frame a Roman cohort and click it',
        'the unit anchor never projected in front of the camera');
    } else {
      const s0 = await selCount();
      await mp.mouse.click(spot.px, spot.py);
      await mp.waitForTimeout(500);
      const s1 = await selCount();
      record('click selects after menu', s1 > 0,
        `click a framed Roman cohort at ${spot.px.toFixed(0)},${spot.py.toFixed(0)}`,
        `selected ${s0} → ${s1}`);
    }
  }
  if (SHOT_DIR) await mp.screenshot({ path: path.join(SHOT_DIR, 'after-menu.png') });
  await mp.close();
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} interactions passed`);
if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s):`);
  for (const e of [...new Set(consoleErrors)].slice(0, 12)) console.log(`  ${e}`);
}
if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ results, consoleErrors: [...new Set(consoleErrors)] }, null, 2));
await browser.close();
if (server) server.kill('SIGTERM');
process.exit(failed || consoleErrors.length ? 1 : 0);
