#!/usr/bin/env node
/**
 * Is the right button broken, or is the left click that precedes it missing?
 *
 * `tools/qa-interact.mjs` scores `right-click move` and `right-click attack` red on `main`
 * and on two independent branches. This differences the two possible causes in **one
 * session**, at the harness's own camera, with the harness's own gesture:
 *
 *   arm A  select exactly as `qa-interact` does — project the unit's anchor at
 *          `groundAt + 1` and click once, with no check that anything was selected — then
 *          right-click empty ground.
 *   arm B  select by hovering until `model.hoveredId` is actually the unit, then the
 *          identical right-click at the identical pixel.
 *   arm C  clear the selection and right-click the same pixel again, to show what "no
 *          order" looks like when there is nothing to order.
 */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5412);
const base = `http://127.0.0.1:${PORT}`;
const W = 1600, H = 900;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}/?harness=1&autoplay=0&quality=high&w=${W}&h=${H}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context;
  window.__tape = [];
  g.engine.events.on('orderIssued', (p) => window.__tape.push(JSON.parse(JSON.stringify(p))));
  const v = ctx.camera.position.clone();
  window.__project = (x, y, z) => {
    v.set(x, y, z).project(ctx.camera);
    return v.z > 1 ? null : { x: (v.x * 0.5 + 0.5) * ctx.viewW, y: (-v.y * 0.5 + 0.5) * ctx.viewH };
  };
  window.__ctl = () => ctx.tryGet('hud').controller;
  window.__sel = () => window.__ctl().model.selection.slice();
  window.__hov = () => window.__ctl().model.hoveredId;
  // Exactly `qa-interact`'s `__unitScreen`: the anchor lifted one metre.
  window.__naive = (id) => {
    const u = g.battle.unitById(id);
    return window.__project(u.x, g.battle.groundAt(u.x, u.z) + 1, u.z);
  };
  // The same anchor with no lift, which is what `pickUnit` actually tests the ground ray against.
  window.__flat = (id) => {
    const u = g.battle.unitById(id);
    return window.__project(u.x, g.battle.groundAt(u.x, u.z), u.z);
  };
});
const settle = (ms = 320) => page.waitForTimeout(ms);

// `qa-interact`'s own framing for check 4, to the digit.
const setup = await page.evaluate(() => {
  const g = window.__game;
  const u = g.battle.units.find((v) => v.faction === 0 && !v.destroyed && v.alive > 100);
  g.setCamera(u.x, u.z, 0.42, Math.PI);
  g.advance(0.4);
  return { id: u.id, typeId: u.typeId, x: u.x, z: u.z };
});
await settle(400);

const naive = await page.evaluate((id) => window.__naive(id), setup.id);
const flat = await page.evaluate((id) => window.__flat(id), setup.id);
console.log(`unit ${setup.id} (${setup.typeId}) at camera zoom 0.42`);
console.log(`  anchor projected at +1 m lift: (${naive.x.toFixed(0)}, ${naive.y.toFixed(0)})`);
console.log(`  anchor projected flat:         (${flat.x.toFixed(0)}, ${flat.y.toFixed(0)})`);
console.log(`  the two differ by ${Math.hypot(naive.x - flat.x, naive.y - flat.y).toFixed(1)} px`);

// A destination clear of everything, well below the unit on screen.
const dest = { x: Math.round(flat.x), y: Math.round(Math.max(240, flat.y - 190)) };

/**
 * The harness's own gesture: move, settle, down, up. Returns *this unit's* move order.
 *
 * Filtered by unit id, and that is not a nicety. `?autoplay=0` leaves the Juthungi on the
 * AI and `ai/Orders.ts` emits `orderIssued` through the same event, so "the last move order
 * on the tape" is very often the enemy's — which made the first run of this file report an
 * order for an arm with nothing selected, at a point 300 m from the click.
 */
async function rightClick(at, id) {
  await page.mouse.move(at.x, at.y);
  await settle(250);
  const n = await page.evaluate(() => window.__tape.length);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await settle(450);
  return page.evaluate(([k, u]) => window.__tape.slice(k).filter(
    (e) => (e.kind === 'move' || e.kind === 'attackMove') && (e.unitIds ?? []).includes(u)
  ).pop() ?? null, [n, id]);
}

// ---- arm A: select the way the harness does, and do not check ----
await page.evaluate(() => window.__ctl().clear(window.__game.engine.context));
await settle(200);
await page.mouse.move(naive.x, naive.y);
await settle(200);
const hovA = await page.evaluate(() => window.__hov());
await page.mouse.click(naive.x, naive.y);
await settle(350);
const selA = await page.evaluate(() => window.__sel());
const ordA = await rightClick(dest, setup.id);
console.log(`\nA  harness select (+1 m lift, unverified)`);
console.log(`     hoveredId under that pixel: ${hovA}`);
console.log(`     selection after the click:  [${selA.join(',')}]`);
console.log(`     right-click on empty ground: ${ordA ? `orderIssued kind=${ordA.kind} at (${ordA.x.toFixed(1)}, ${ordA.z.toFixed(1)})` : 'NO order'}`);

// ---- arm B: hover until the cursor is really on the men, then the same gesture ----
await page.evaluate(() => window.__ctl().clear(window.__game.engine.context));
await settle(200);
let at = null;
outer: for (const r of [0, 10, 22, 38, 58, 84]) {
  for (const a of r === 0 ? [0] : [0, 1, 2, 3, 4, 5, 6, 7]) {
    const x = flat.x + Math.cos((a * Math.PI) / 4) * r;
    const y = flat.y + Math.sin((a * Math.PI) / 4) * r;
    await page.mouse.move(x, y);
    await settle(110);
    if ((await page.evaluate(() => window.__hov())) === setup.id) { at = { x, y, r }; break outer; }
  }
}
if (at) await page.mouse.click(at.x, at.y);
await settle(350);
const selB = await page.evaluate(() => window.__sel());
const ordB = await rightClick(dest, setup.id);
console.log(`\nB  hover-verified select, identical right-click at the identical pixel`);
console.log(`     hovered at (${at ? `${at.x.toFixed(0)}, ${at.y.toFixed(0)}` : 'never'})`
  + `${at ? `, ${at.r} px off the flat projection` : ''}`);
console.log(`     selection after the click:  [${selB.join(',')}]`);
console.log(`     right-click on empty ground: ${ordB ? `orderIssued kind=${ordB.kind} at (${ordB.x.toFixed(1)}, ${ordB.z.toFixed(1)})` : 'NO order'}`);

// ---- arm C: nothing selected, same pixel ----
await page.evaluate(() => window.__ctl().clear(window.__game.engine.context));
await settle(250);
const ordC = await rightClick(dest, setup.id);
console.log(`\nC  empty selection, identical right-click at the identical pixel`);
console.log(`     right-click on empty ground: ${ordC ? `orderIssued kind=${ordC.kind}` : 'NO order'}`);

console.log(`\nverdict: ${ordB && !ordC ? 'the right button issues orders; "NO order" is an empty selection'
  : ordB ? 'inconclusive — arm C also ordered' : 'the right button really does not issue an order'}`);
await browser.close();
