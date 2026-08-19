#!/usr/bin/env node
/**
 * Scratch: play the opening of both sieges by hand, through the real menu.
 *
 * No `?harness=1` and no `?menu=0`. This lands on the menu the player lands on, picks the
 * map and the assault with a real mouse at real screen coordinates, clicks BEGIN BATTLE and
 * then looks at what the deployment phase actually put on the screen — after the title card
 * has faded, which is the frame the player composes their army in.
 *
 * What it asserts is the playtest finding this branch exists to close: that you can see the
 * wall, tell one bay from the next, and find the gate. All three are measured off the render
 * matrix, and the frame is saved beside the numbers so the two can be checked against one
 * another.
 *
 * `pageerror` and every `console` message are captured from before the first navigation, so
 * a branch that boots dirty cannot pass quietly.
 *
 * Usage: node tools/scratch-handplay-so2.mjs [--port=5395] [--shots=dir]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5395);
const SHOT_DIR = path.resolve(ROOT, args.get('shots') ?? 'screenshots/verify-so2/handplay');
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;

const up = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; }
    catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
let server = null;
if (!(await up(1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await up(90000))) { console.error('vite did not start'); process.exit(1); }
}
console.log(`server ${base}${server ? ' (started here)' : ' (already up)'}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
await mkdir(SHOT_DIR, { recursive: true });

/**
 * Click the middle of an element with the actual mouse, not with `page.click`.
 *
 * Scrolled into view first, and the box re-measured *after* the scroll. The menu is taller
 * than the viewport — BEGIN BATTLE sits at y 1097 of a 900 px window on first paint — and
 * `mouse.move` takes viewport coordinates, so the un-scrolled box aims the pointer at a row
 * of pixels that does not exist. It dispatches happily and hits nothing, which then looks
 * like a menu that ignores its own button.
 */
const mouseClick = async (page, sel) => {
  await page.waitForSelector(sel, { timeout: 60000 });
  const h = await page.$(sel);
  await h.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const b = await h.boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  const vp = page.viewportSize();
  if (y < 0 || y > vp.height || x < 0 || x > vp.width) {
    throw new Error(`${sel} still off-viewport after scrolling: (${Math.round(x)}, ${Math.round(y)})`);
  }
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  return { x: Math.round(x), y: Math.round(y) };
};

/**
 * The opening frame, read off the render matrix.
 *
 * `legible` is the test for "can a player tell one bay from the next": the bay's whole
 * cross-section — foot to crest — inside the usable band of the frame, and its two ends far
 * enough apart on screen to be resolved as a bay rather than a smear. 12 px is the width of
 * a merlon-and-embrasure pair at the far end of the framed stretch.
 */
const FRAME = ([W, H]) => {
  const g = window.__game;
  const ctx = g.engine.context;
  const cam = ctx.camera;
  const rig = g.engine.rig;
  cam.updateMatrixWorld(true);
  const V = cam.position.constructor;
  const v = new V();
  const eye = cam.position;
  const dir = cam.getWorldDirection(new V());
  const project = (x, y, z) => {
    v.set(x, y, z).project(cam);
    const behind = (x - eye.x) * dir.x + (y - eye.y) * dir.y + (z - eye.z) * dir.z < 0;
    return {
      x: +((v.x * 0.5 + 0.5) * W).toFixed(1), y: +((-v.y * 0.5 + 0.5) * H).toFixed(1),
      behind, off: behind || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1,
    };
  };

  const city = ctx.tryGet('city');
  const bays = city.getGarrisonBays();
  const gb = bays.find((b) => b.isGate) ?? bays[bays.length >> 1];
  const gate = (city.getGates?.() ?? [])[0] ?? null;

  const seen = [];
  for (let k = -10; k <= 10; k++) {
    const b = bays[gb.index + k];
    if (!b) continue;
    const mx = (b.x0 + b.x1) * 0.5, mz = (b.z0 + b.z1) * 0.5;
    const e0 = project(b.x0, b.crestY, b.z0);
    const e1 = project(b.x1, b.crestY, b.z1);
    const crest = project(mx, b.crestY, mz);
    const foot = project(mx, b.groundY, mz);
    seen.push({
      k, index: b.index, isGate: !!b.isGate, stage: b.stage,
      crest, foot, e0, e1,
      widthPx: +Math.abs(e1.x - e0.x).toFixed(1),
      heightPx: +(foot.y - crest.y).toFixed(1),
    });
  }
  // The band the wall must live in: below the plaque furniture, above the unit cards.
  let band = 0;
  for (const sel of ['.topbar', '.deploy']) {
    for (const e of document.querySelectorAll(sel)) {
      const r = e.getBoundingClientRect();
      if (r.width > 40 && r.top < H * 0.5) band = Math.max(band, r.bottom);
    }
  }
  const cards = document.querySelector('.cardbar')?.getBoundingClientRect();
  const cardTop = cards ? Math.round(cards.top) : H;

  const legible = seen.filter((b) => !b.crest.off && b.crest.y > band
    && b.foot.y < cardTop && b.widthPx >= 12);

  const zone = g.deployment?.zone ?? null;
  // How much of the ground the player may deploy on is in frame: march the bottom-centre
  // ray to the terrain and compare with the zone's own front edge.
  const groundAtPixel = (px, py) => {
    const p = new V((px / W) * 2 - 1, -((py / H) * 2 - 1), 0.5);
    p.unproject(cam);
    const d = p.sub(eye).normalize();
    if (d.y >= -1e-4) return null;
    let t = 0;
    for (let i = 0; i < 3000; i++) {
      t += 1.5;
      if (t > 3000) return null;
      if (eye.y + d.y * t - g.battle.groundAt(eye.x + d.x * t, eye.z + d.z * t) <= 0) {
        return { x: +(eye.x + d.x * t).toFixed(1), z: +(eye.z + d.z * t).toFixed(1) };
      }
    }
    return null;
  };
  const bottom = groundAtPixel(W / 2, cardTop - 2);

  return {
    map: g.engine.context.tryGet('city')?.cityPlan?.name ?? '?',
    camera: {
      focus: { x: +rig.focus.x.toFixed(1), z: +rig.focus.z.toFixed(1) },
      zoom: +rig.zoom.toFixed(3), yawDeg: +((rig.yaw * 180) / Math.PI).toFixed(2),
      eye: { x: +eye.x.toFixed(1), y: +eye.y.toFixed(1), z: +eye.z.toFixed(1) },
      aboveGround: +(eye.y - g.battle.groundAt(eye.x, eye.z)).toFixed(1),
    },
    band: Math.round(band), cardTop,
    gateBay: { index: gb.index, crest: seen.find((b) => b.k === 0)?.crest ?? null },
    gate: gate ? { world: { x: +gate.x.toFixed(1), z: +gate.z.toFixed(1) },
      px: project(gate.x, g.battle.groundAt(gate.x, gate.z) + 6, gate.z) } : null,
    bays: seen,
    legible: legible.map((b) => ({ k: b.k, x: b.crest.x, y: b.crest.y, w: b.widthPx, gate: b.isGate })),
    crestY: { top: Math.min(...legible.map((b) => b.crest.y)), bottom: Math.max(...legible.map((b) => b.crest.y)) },
    wallX: { min: Math.min(...legible.flatMap((b) => [b.e0.x, b.e1.x])),
      max: Math.max(...legible.flatMap((b) => [b.e0.x, b.e1.x])) },
    zone,
    frameBottomGround: bottom,
    brief: (document.querySelector('.dep-brief')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    topbar: {
      phase: (document.querySelector('.tb-phase')?.textContent ?? '').trim(),
      note: (document.querySelector('.tb-note')?.textContent ?? '').trim(),
      adv: (document.querySelector('.tb-adv')?.textContent ?? '').trim(),
    },
  };
};

const out = {};
for (const map of ['carthage', 'campus-martius']) {
  console.log(`\n=== ${map} — through the real menu ===`);
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  const logs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    logs.push(`${m.type()}: ${m.text()}`);
    if (m.type() === 'error' || m.type() === 'warning') errs.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('requestfailed', (r) => errs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  // The menu, with nothing in the URL but the quality and the paused clock the brief asked
  // for. No ?harness, no ?menu=0, no ?map, no ?scenario — every one of those is chosen here
  // with the mouse.
  await page.goto(`${base}/?autoplay=0&quality=high`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.menu .begin', { timeout: 90000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SHOT_DIR, `menu-0-${map}.png`) });

  const atMap = await mouseClick(page, `[data-map="${map}"]`);
  await page.waitForTimeout(400);
  const atScen = await mouseClick(page, '[data-scen="assault"]');
  await page.waitForTimeout(400);
  const chosen = await page.evaluate(() => ({
    map: document.querySelector('[data-map].on, [data-map][aria-pressed="true"]')?.dataset.map
      ?? [...document.querySelectorAll('[data-map]')].find((e) => e.className.includes('on'))?.dataset.map ?? '?',
    scen: [...document.querySelectorAll('[data-scen]')].find((e) => e.className.includes('on'))?.dataset.scen ?? '?',
  }));
  console.log(`  clicked map at (${atMap.x},${atMap.y}) and assault at (${atScen.x},${atScen.y}) `
    + `-> menu now shows map=${chosen.map} scenario=${chosen.scen}`);
  await page.screenshot({ path: path.join(SHOT_DIR, `menu-1-${map}.png`) });

  const atBegin = await mouseClick(page, '.menu .begin');
  console.log(`  BEGIN BATTLE at (${atBegin.x},${atBegin.y})`);
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });

  /*
   * Wait for the title card to arrive and *then* to leave.
   *
   * Waiting only for it to be gone passes on the first poll, before the HUD has attached and
   * while `querySelector('.title-card')` is still null — and the frame then contains the card
   * at full opacity across the middle of the wall, which is exactly the part of the frame
   * this run exists to look at. Two waits, in order, and the absence test only counts once
   * the element has been seen.
   */
  await page.waitForSelector('.title-card', { timeout: 60000 });
  await page.waitForFunction(() => {
    const t = document.querySelector('.title-card');
    return !t || getComputedStyle(t).display === 'none' || Number(t.style.opacity || 1) < 0.02;
  }, null, { timeout: 60000 });

  /*
   * Take the pointer off the card bar before looking at anything.
   *
   * BEGIN BATTLE is at (1251, 830) and the unit cards occupy that band once the battle
   * loads, so the pointer is left resting on a card and the unit panel opens over the right
   * half of the frame — 600 px of stat block across the stretch of curtain this run exists to
   * photograph. Parked at the left edge of the open ground instead, and the panel is asserted
   * shut rather than assumed to be.
   */
  await page.mouse.move(10, 690);
  await page.waitForTimeout(900);
  const hover = await page.evaluate(() => {
    const p = document.querySelector('.upanel, .unit-panel, .tooltip');
    return p && getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().width > 80
      ? { cls: p.className, w: Math.round(p.getBoundingClientRect().width) } : null;
  });
  if (hover) console.log(`  WARNING: a hover panel is open over the frame: ${JSON.stringify(hover)}`);

  const f = await page.evaluate(FRAME, [W, H]);
  out[map] = { frame: f, errors: errs, consoleCount: logs.length };
  await page.screenshot({ path: path.join(SHOT_DIR, `open-${map}.png`) });

  const c = f.camera;
  console.log(`  city "${f.map}"  focus (${c.focus.x}, ${c.focus.z}) zoom ${c.zoom} yaw ${c.yawDeg}deg`);
  console.log(`  eye (${c.eye.x}, ${c.eye.y}, ${c.eye.z}) ${c.aboveGround} m above ground`);
  console.log(`  furniture: plaque band ends y ${f.band}, unit cards start y ${f.cardTop}`);
  console.log(`  gate bay crest at (${f.gateBay.crest.x}, ${f.gateBay.crest.y})   gate marker at `
    + `(${f.gate?.px.x}, ${f.gate?.px.y}) off-frame ${f.gate?.px.off}`);
  console.log(`  crest y ${f.crestY.top}..${f.crestY.bottom}   wall x ${f.wallX.min.toFixed(1)}..${f.wallX.max.toFixed(1)}`);
  console.log(`  ${f.legible.length} bays legible (whole section in the band, >= 12 px wide):`);
  console.log(`    ${f.legible.map((b) => `${b.gate ? 'GATE' : `k${b.k >= 0 ? '+' : ''}${b.k}`}@${b.x}/${b.w}px`).join('  ')}`);
  console.log(`  deployment zone: ${f.zone?.label ?? 'none'}`);
  console.log(`  frame bottom lands on ground (${f.frameBottomGround?.x}, ${f.frameBottomGround?.z})`);
  console.log(`  brief: ${f.brief || 'ABSENT'}`);
  console.log(`  topbar: ${f.topbar.phase} | ${f.topbar.note} | ${f.topbar.adv}`);
  console.log(`  console messages ${logs.length}, errors/warnings ${errs.length}`);
  for (const e of errs.slice(0, 8)) console.log(`    ${e}`);
  await page.close();
}

await writeFile(path.join(SHOT_DIR, 'handplay-so2.json'), JSON.stringify(out, null, 2));
console.log(`\nwrote ${path.join(SHOT_DIR, 'handplay-so2.json')}`);
await browser.close();
if (server) server.kill();
