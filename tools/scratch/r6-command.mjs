// The wall under the player's hand: a cohort selected, and the cursor over the masonry.
//
// Driven the way `tools/qa-wallhand.mjs` drives it — no `?harness=1`, no siege verb called
// directly, a real left-click to select and a real mouse move to raise the hint — because the
// claim is about what a player can do with a mouse, and an API call cannot photograph that.
//
//   node r6-command.mjs --port=5399 --out=DIR --tag=after --map=carthage --at=150
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.TC_ROOT ?? process.cwd();
const arg = (k, d) => {
  const a = process.argv.find((s) => s.startsWith(`--${k}=`));
  return a === undefined ? d : a.slice(k.length + 3);
};
const PORT = Number(arg('port', 5399));
const OUT = path.resolve(arg('out', '/tmp/r6shots/command'));
const TAG = arg('tag', 'after');
const MAP = arg('map', 'carthage');
const AT = Number(arg('at', 150));
const W = 1600, H = 900;

const wait = async (u, ms) => {
  const d = Date.now() + ms;
  while (Date.now() < d) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
const base = `http://127.0.0.1:${PORT}`;
let srv = null;
if (!(await wait(base, 1000))) {
  srv = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await wait(base, 120000))) throw new Error('no vite');
}
await mkdir(OUT, { recursive: true });
console.log(`server ${base} root ${ROOT}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
// `autoplay=0` leaves Rome under the player, which is the whole point: the selection and the
// cursor only exist for a side nobody else is commanding. `deploy=0` skips straight to the
// fight, because a deployment phase has no wall to point at yet.
await page.goto(`${base}/?menu=0&map=${MAP}&scenario=assault&autoplay=0&deploy=0&quality=high`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
await page.waitForTimeout(1500);
await page.addStyleTag({ content: '.hud-perf, .title-card { display: none !important; }' });

// Run the storm forward, then stop the clock so the pixel that was picked is still the pixel
// that gets clicked. Men walk; a hover measured against a moving target is a coin toss.
await page.evaluate((at) => { const g = window.__game; while (g.simTime() < at) g.advance(1); }, AT);
await page.evaluate(() => { window.__game.engine.time.paused = true; });
await page.waitForTimeout(400);

const placed = await page.evaluate(() => {
  const g = window.__game;
  const b = g.battle, s = b.siege, p = b.pool;
  // The player's own unit with the most men standing on stone.
  let best = null, bestN = 0;
  for (const u of b.units) {
    if (u.destroyed || u.alive === 0 || u.faction !== 0) continue;
    let n = 0, sx = 0, sy = 0, sz = 0, st = -1;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      const pm = s.probeMan(i);
      if (pm.station < 0) continue;
      n++; sx += p.x[i]; sy += p.y[i]; sz += p.z[i]; st = pm.station;
    }
    if (n > bestN) { bestN = n; best = { u, n, x: sx / n, y: sy / n, z: sz / n, station: st }; }
  }
  if (!best) return { fail: 'nobody of ours is on the stone' };
  const bays = g.engine.context.tryGet('city').getGarrisonBays();
  const mid = (b) => ({ x: (b.x0 + b.x1) * 0.5, z: (b.z0 + b.z1) * 0.5 });
  let bi = 0;
  for (let i = 1; i < bays.length; i++) {
    const a = mid(bays[i]), c = mid(bays[bi]);
    if (Math.hypot(a.x - best.x, a.z - best.z) < Math.hypot(c.x - best.x, c.z - best.z)) bi = i;
  }
  /*
   * Stand ON the walk a few bays short of the men and look down it.
   *
   * Standing off the *face* — the first thing tried here — put the eye 16 m out from the gate
   * bay at the rig's own pitch, which is inside the gatehouse: the frame came back as two
   * towers and no soldier, and nothing could be picked because nothing was on the screen.
   * `tools/probe-siege.mjs`'s `walkway` camera is the one that works for men on a parapet,
   * and this is it: `lift: walk + 1.4`, a hand's breadth off the face, yaw resolved at the
   * men rather than written down.
   */
  /*
   * Not any bay: every fifth finished bay carries a covered gallery over the walk
   * (`bay.index % 5 === 1` in `wall.ts`). `tools/probe-siege.mjs` records the same trap and
   * the same symptom — its first walkway frame was 1920x1080 of roof tiles — and this file
   * reproduced it exactly: offset -3 landed on bay 16, and 16 % 5 is 1.
   */
  let camBay = null;
  for (const d of [-2, -4, 2, 4, -3, 3, -5, 5, -6, 6]) {
    const b = bays[bi + d];
    if (!b || b.index % 5 === 1) continue;
    camBay = b; break;
  }
  if (!camBay) return { fail: 'no ungalleried bay within six of the men' };
  const cm = mid(camBay);
  const rig = g.engine.rig;
  rig.__saved = rig.heightAt;
  const y = camBay.walkY + 1.4;
  rig.heightAt = () => y;
  const fx = cm.x + camBay.nx * 0.2, fz = cm.z + camBay.nz * 0.2;
  const yaw = Math.atan2(best.x - fx, best.z - fz);
  g.setCamera(fx, fz, 0.17, yaw);
  return { unitId: best.u.id, typeId: best.u.typeId, onStone: best.n, alive: best.u.alive,
    bay: bays[bi].index, camBay: camBay.index, walkY: +camBay.walkY.toFixed(2),
    men: { x: best.x, y: best.y, z: best.z } };
});
console.log('placed', JSON.stringify(placed));
if (placed.fail) { await page.screenshot({ path: path.join(OUT, `${TAG}-${MAP}-FAILED.png`) }); process.exit(3); }
await page.waitForTimeout(900);

/** World point -> screen pixel, off the live camera matrices. */
const px = async (pt) => page.evaluate(([p, w, h]) => {
  const cam = window.__game.engine.rig.camera;
  cam.updateMatrixWorld(true);
  const V = cam.position.constructor;
  const v = new V(p.x, p.y, p.z).project(cam);
  return { x: Math.round(((v.x + 1) / 2) * w), y: Math.round(((1 - v.y) / 2) * h), z: v.z };
}, [pt, W, H]);

// --- select: sweep for the "friend" glyph and left-click it -----------------
//
// Not a projected world point. `qa-wallhand.mjs` makes the same choice for the same reason:
// projecting a man's own coordinate and clicking it aims at a pixel no player could have
// found, and it silently misses whenever the pick radius and the drawn body disagree — which
// is the defect `probe-pickcrowd` exists to measure. Sweeping for the glyph the HUD is
// actually showing clicks where the interface says something is on offer.
const readSel = () => page.evaluate(() => {
  const h = window.__game.engine.context.tryGet('hud');
  return (h && h.model && h.model.selection ? h.model.selection.slice() : []);
});
let sel = [];
let clickedAt = null;
outer:
for (let y = 180; y <= H - 250; y += 22) {
  for (let x = 120; x <= W - 120; x += 22) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(40);
    const cur = await page.evaluate(() => document.body.dataset.cur ?? '');
    if (cur !== 'friend') continue;
    await page.mouse.click(x, y);
    await page.waitForTimeout(260);
    sel = await readSel();
    if (!sel.length) continue;
    /*
     * And it has to be a unit that is *on the wall*.
     *
     * The first pass took whatever the sweep hit first and came back with a carroballista
     * standing in the street: the frame then showed the interface refusing a wall order to an
     * engine, which is a true thing about the product and not the thing this frame is for.
     */
    const onStone = await page.evaluate((id) => {
      const g = window.__game, b = g.battle, p = b.pool, s = b.siege;
      const u = b.unitById(id);
      if (!u) return 0;
      let n = 0;
      for (const i of u.members) if (p.aliveAt(i) && s.probeMan(i).station >= 0) n++;
      return n;
    }, sel[0]);
    if (onStone <= 0) { sel = []; continue; }
    clickedAt = { x, y, onStone }; break outer;
  }
}
console.log('selection', JSON.stringify(sel), 'clicked', JSON.stringify(clickedAt));

/*
 * --- hover the masonry, and hold the right button so the promise is on the screen ---
 *
 * Two affordances, and only one of them is a cursor. `body[data-cur='wall']` is a CSS cursor
 * and a screenshot does not contain the pointer, so the glyph cannot be photographed at all;
 * what *can* be is what the glyph is a label for. `SelectionController.drawWallTarget` marks
 * the stretch of parapet the order would fill, in the world, sized off the selected unit's
 * own headcount — and holding the right button raises `.drag-hint`, which says in words what
 * the release will do. Both are in the frame; the pointer is at the marker's centre.
 *
 * The button is never released. This file photographs the offer, it does not issue the order.
 */
let shown = null;
const sweep = [];
for (let y = 180; y <= H - 250 && !shown; y += 22) {
  for (let x = 120; x <= W - 120; x += 22) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(40);
    const cur = await page.evaluate(() => document.body.dataset.cur ?? '');
    sweep.push(cur);
    if (cur !== 'wall') continue;
    await page.waitForTimeout(200);
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(260);
    const q = await page.evaluate(() => {
      const h = document.querySelector('.drag-hint');
      const vis = h && getComputedStyle(h).display !== 'none';
      const sh = document.querySelector('.siege-hint');
      const svis = sh && getComputedStyle(sh).display !== 'none';
      const c = window.__game.engine.context.tryGet('hud');
      return {
        cur: document.body.dataset.cur ?? '',
        hint: vis ? (h.textContent ?? '').trim() : '',
        tone: vis ? (h.dataset.tone ?? '') : '',
        siegeHint: svis ? (sh.textContent ?? '').trim() : '',
        siegeTone: svis ? (sh.dataset.tone ?? '') : '',
        selection: c && c.model ? c.model.selection.slice() : [],
      };
    });
    // An accepted order, not a refusal. Both are worth having in a QA log and only one of
    // them is a picture of the wall being commanded.
    if (q.hint && q.tone !== 'refuse' && q.siegeTone !== 'refuse') { shown = { x, y, ...q }; break; }
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(120);
  }
}
console.log('hint', JSON.stringify(shown));
if (!shown) {
  const census = {};
  for (const k of sweep) census[k] = (census[k] ?? 0) + 1;
  console.log('no wall hint anywhere; cursor census', JSON.stringify(census));
}
await page.waitForTimeout(250);
const file = path.join(OUT, `${TAG}-${MAP}-command.png`);
await page.screenshot({ path: file });
await writeFile(path.join(OUT, `${TAG}-${MAP}.json`),
  JSON.stringify({ placed, sel, clickedAt, shown, errors: errs.slice(0, 5) }, null, 2));
console.log(`-> ${file}  errors ${errs.length}`, errs.slice(0, 3));
await browser.close();
if (srv) srv.kill('SIGTERM');
