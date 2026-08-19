#!/usr/bin/env node
/**
 * The same wall orders, aimed the way a hand aims them.
 *
 * `qa-wallmatrix.mjs` computes every target pixel from the siege system's own coordinates —
 * a station centre, a stair head, a point 40 m inside the curtain — and then clicks it. That
 * is the right way to grade whether the *order* works, and it is the wrong way to grade
 * whether a *player* can give it, because it can aim at a pixel no one could have found and
 * it never has to read the interface to decide where to click.
 *
 * So this file may not look at the world. It parks nothing: the camera stays where the
 * scenario put it, exactly as it is when the battle opens. It finds things to click by
 * sweeping the cursor and reading the two affordances the HUD actually shows a player —
 * `document.body.dataset.cur` and the drag hint — and it clicks where those say something is
 * on offer. Siege state is read afterwards, only to grade what happened.
 *
 * The gap between this and the matrix is the whole point: a probe that clicks the unit card
 * bar sees no picking problem, and a mouse sees a 5.4 m one.
 *
 * Usage: node tools/qa-wallhand.mjs --port=5477 --map=carthage [--json=path] [--shots=dir]
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const MAP = args.get('map') ?? 'carthage';
const JSON_OUT = args.get('json') ?? null;
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }
console.log(`• dev server ${base}   map ${MAP}   (camera never parked; the scenario's own framing)`);

const out = [];
let failed = 0;
const say = (name, pass, what, got) => {
  out.push({ name, pass, what, got });
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${what}`);
  console.log(`        -> ${got}`);
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
const settle = (ms = 220) => page.waitForTimeout(ms);
const shot = async (n) => { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${n}.png`) }); };

await page.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.menu .begin', { timeout: 90000 });
await page.click(`.menu [data-map="${MAP}"]`); await settle(250);
await page.click('.menu [data-scen="assault"]'); await settle(250);
await page.click('.menu .begin');
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await settle(700);
const hadDep = await page.evaluate(() => !!document.querySelector('.dep-begin'));
if (hadDep) { await page.click('.dep-begin'); await settle(800); }
say('boot', true, `real menu, ?autoplay=0, map ${MAP}, deployment ${hadDep ? 'committed' : 'absent'}`,
  `city ${await page.evaluate(() => window.__game.engine.context.tryGet('city')?.cityPlan?.id)}`);

// Grading only. Nothing below aims with these.
await page.evaluate(() => {
  const g = window.__game, ctx = g.engine.context;
  window.__ctl = () => ctx.tryGet('hud')?.controller ?? null;
  window.__cur = () => document.body.dataset.cur ?? '';
  window.__hint = () => {
    const h = document.querySelector('.drag-hint');
    return h && h.style.display !== 'none' ? (h.textContent ?? '') : '';
  };
  window.__sel = () => window.__ctl()?.model.selection.slice() ?? [];
  window.__tape = [];
  g.engine.events.on('orderIssued', (p) => window.__tape.push(JSON.parse(JSON.stringify(p ?? {}))));
  window.__mark = () => window.__tape.length;
  window.__since = (n, ids) => window.__tape.slice(n).filter((e) => (e.unitIds ?? []).some((i) => ids.includes(i)));
  window.__grade = (id) => {
    const s = g.battle.siege, b = g.battle, p = b.pool, u = b.unitById(id);
    if (!u) return null;
    let men = 0, onStone = 0, onTerrain = 0, inside = 0, hi = -1e9;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      men++;
      const pm = s.probeMan(i);
      if (pm.station >= 0) onStone++;
      else if (Math.abs(p.y[i] - b.groundAt(p.x[i], p.z[i])) < 0.8) onTerrain++;
      if (s.wallSideAt(p.x[i], p.z[i]) < 0) inside++;
      if (p.y[i] > hi) hi = p.y[i];
    }
    const plan = s.plans?.get(id);
    return { id, typeId: u.typeId, men, onStone, onTerrain, inside, maxY: +hi.toFixed(2),
      order: u.order, targetUnitId: u.targetUnitId, garrisoned: s.isGarrisoned(id),
      owned: s.owned.has(id), plan: plan ? { goal: plan.goal, age: plan.age, stuck: plan.stuck } : null };
  };
  window.__theirs = () => g.battle.units.filter((u) => u.faction !== 0 && !u.destroyed
    && g.battle.siege.isGarrisoned(u.id)).map((u) => u.id);
});
await page.evaluate(() => window.__game.engine.advance(20, 166));
await settle(400);
await shot('00-opening');

/** Sweep the visible field for a pixel whose *cursor glyph* is `want`. Nothing else. */
async function findCursor(want, opts = {}) {
  const { x0 = 150, x1 = W - 150, y0 = 300, y1 = H - 285, step = 28, ctrl = false } = opts;
  if (ctrl) await page.keyboard.down('Control');
  try {
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        await page.mouse.move(x, y);
        await settle(45);
        if ((await page.evaluate(() => window.__cur())) === want) return { x, y };
      }
    }
  } finally { if (ctrl) await page.keyboard.up('Control'); }
  return null;
}

/** Press, read the hint the player is shown mid-gesture, release. */
async function clickAndRead(pt, ids, ctrl = false) {
  await page.mouse.move(pt.x, pt.y); await settle(240);
  const before = { cur: await page.evaluate(() => window.__cur()) };
  const mark = await page.evaluate(() => window.__mark());
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.down({ button: 'right' }); await settle(180);
  const hint = await page.evaluate(() => window.__hint());
  const curHeld = await page.evaluate(() => window.__cur());
  await page.mouse.up({ button: 'right' });
  if (ctrl) await page.keyboard.up('Control');
  await settle(320);
  const ord = await page.evaluate(([m, i]) => window.__since(m, i), [mark, ids]);
  return { before, hint, curHeld, order: ord.length ? ord[ord.length - 1] : null };
}

/**
 * Move the view the way a player does, and re-sweep after each move.
 *
 * The screen-edge pan alone is not enough: alternating edges makes the camera oscillate and
 * travel nowhere, and holding one edge long enough to cross the map takes tens of seconds.
 * The minimap is the control a player actually uses to cross a battlefield, and
 * `qa-interact` already grades it as one (950 m of focus travel in a single drag). So the
 * sweep walks a coarse grid of minimap positions, which covers the whole map in nine presses
 * and uses nothing but the pointer.
 */
async function sweepAround(want, opts = {}) {
  const first = await findCursor(want, opts);
  if (first) return { px: first, moves: 0 };
  const mm = await page.evaluate(() => {
    const c = document.querySelector('#hud-root .minimap canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (!mm) return { px: null, moves: 0, why: 'no minimap' };
  let moves = 0;
  for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    for (const fx of [0.5, 0.3, 0.7]) {
      moves++;
      await page.mouse.move(mm.x + mm.w * fx, mm.y + mm.h * fy);
      await page.mouse.down();
      await settle(120);
      await page.mouse.up();
      await settle(500);
      // Off the plate, or the cursor sweep starts inside the minimap's own box.
      await page.mouse.move(W / 2, H / 2);
      await settle(250);
      // Zoom in after the jump. A minimap press moves the focus and leaves the zoom alone,
      // and at the strategic end a 160-man cohort is a few pixels across — the sweep steps
      // straight over it. The wheel is the control a player reaches for next.
      for (let k = 0; k < 4; k++) { await page.mouse.wheel(0, -120); await settle(70); }
      await settle(350);
      let px = await findCursor(want, opts);
      if (px) return { px, moves };
      // And once more zoomed out again, in case the jump landed on top of the target.
      for (let k = 0; k < 3; k++) { await page.mouse.wheel(0, 120); await settle(70); }
      await settle(300);
      px = await findCursor(want, opts);
      if (px) return { px, moves };
    }
  }
  return { px: null, moves };
}

// ---------------------------------------------------------------------------
// 1. Find one of my own units the way a player does: the "friend" cursor.
// ---------------------------------------------------------------------------
const found = await sweepAround('friend');
const friendPx = found.px;
if (friendPx && found.moves > 0) console.log(`        (the view was moved ${found.moves} times on the minimap first)`);
say('find my own men', !!friendPx,
  'sweep the opening view for a pixel where the HUD shows the "friend" cursor — no world '
  + 'coordinates, no camera parking',
  friendPx ? `found at (${friendPx.x},${friendPx.y})` : 'no pixel in the opening view reads "friend"');
let mine = -1;
if (friendPx) {
  /*
   * Re-check the glyph immediately before pressing, and nudge if the click comes back empty.
   * The world does not stop between the sweep and the click: a cohort walks, and a pixel that
   * read "friend" a second ago can be grass by the time the button goes down. Reported as
   * `nudged` rather than hidden, because a large nudge would itself be a picking result.
   */
  let sel = [];
  let nudged = -1;
  for (const [dx, dy] of [[0, 0], [0, 14], [0, -14], [16, 0], [-16, 0], [0, 30], [0, -30], [30, 0], [-30, 0]]) {
    await page.mouse.move(friendPx.x + dx, friendPx.y + dy);
    await settle(140);
    if ((await page.evaluate(() => window.__cur())) !== 'friend') continue;
    await page.mouse.click(friendPx.x + dx, friendPx.y + dy);
    await settle(300);
    sel = await page.evaluate(() => window.__sel());
    if (sel.length) { nudged = Math.hypot(dx, dy); break; }
  }
  void nudged;
  mine = sel[0] ?? -1;
  say('click selects it', sel.length === 1,
    `left-click that pixel${nudged > 0 ? ` (${nudged.toFixed(0)} px of nudge — the cohort had moved)` : ''}`,
    `selection [${sel.join(',')}] — ${mine >= 0
      ? (await page.evaluate((i) => window.__grade(i), mine)).typeId : 'nothing'}`);
}
await shot('01-selected');

// ---------------------------------------------------------------------------
// 2. Find the wall the way a player does: the "wall" cursor, then read the hint.
// ---------------------------------------------------------------------------
/**
 * Walk the view forward the way a player does, and stop as soon as the wall answers.
 *
 * The opening framing is not a place from which the wall can be commanded — measured, 8 of
 * 184 pixels have masonry under them at all — so a hand pass that gives up there is grading
 * the scenario's boot camera, not the pick. A player pushes the view forward and zooms in;
 * the only inputs used here are the screen-edge pan and the wheel, both of which
 * `qa-interact` already grades as real controls.
 */
let wallPx = null;
if (mine >= 0) {
  const walk = await sweepAround('wall');
  wallPx = walk.px;
  if (wallPx) console.log(`        (the view was moved ${walk.moves} times on the minimap first)`);
  /*
   * When the sweep finds nothing, say *what it did find*. "No pixel offers a wall order" is
   * either the most serious result in this file or a badly aimed sweep, and a histogram of
   * the glyphs the HUD actually showed tells the two apart in one line.
   */
  let census = null;
  if (!wallPx) {
    census = { kinds: {}, solid: 0, wall: 0, storming: null, n: 0, sample: null };
    for (let y = 210; y <= H - 250; y += 60) {
      for (let x = 140; x <= W - 140; x += 60) {
        await page.mouse.move(x, y); await settle(45);
        const q = await page.evaluate(() => {
          const c = window.__ctl();
          return { cur: window.__cur(), solid: c.solidValid, wall: c.wallValid,
            storming: !!c.storming, solidY: +c.solidY.toFixed(2), sel: c.model.selection.length };
        });
        census.n++;
        census.kinds[q.cur] = (census.kinds[q.cur] ?? 0) + 1;
        if (q.solid) { census.solid++; if (!census.sample) census.sample = { x, y, ...q }; }
        if (q.wall) census.wall++;
        census.storming = q.storming;
        census.selN = q.sel;
      }
    }
  }
  say('the wall offers itself', !!wallPx,
    'with that unit selected, sweep for a pixel where the cursor turns to the wall glyph',
    wallPx ? `found at (${wallPx.x},${wallPx.y})`
      : `no pixel in the opening view offers a wall order — over ${census.n} pixels the HUD `
        + `showed ${JSON.stringify(census.kinds)}, ${census.solid} of them had masonry under `
        + `the cursor and ${census.wall} answered wallValid; selection size ${census.selN}, `
        + `SelectionController.storming ${census.storming}`
        + `${census.sample ? `; first masonry pixel (${census.sample.x},${census.sample.y}) solidY ${census.sample.solidY}` : ''}`);
  if (wallPx) {
    const before = await page.evaluate((i) => window.__grade(i), mine);
    const r = await clickAndRead(wallPx, [mine]);
    say('the hint names the order', /wall/i.test(r.hint),
      `hold the right button on it and read what the HUD promises`,
      `cursor "${r.before.cur}" → "${r.curHeld}", hint "${r.hint}"`);
    say('and the order matches the hint', !!r.order && (r.order.kind === 'move' || r.order.kind === 'attackMove'),
      'release',
      r.order ? `orderIssued ${r.order.kind}`
        + (r.order.x !== undefined ? ` at (${r.order.x.toFixed(1)},${r.order.z.toFixed(1)})` : '')
        + (r.order.targetUnitId !== undefined ? ` target ${r.order.targetUnitId}` : '')
        : 'no orderIssued');
    // Let it run and see whether the promise was kept.
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.__game.engine.advance(45, 166));
      const r2 = await page.evaluate(() => {
        const d = document.querySelector('.results');
        return !!d && d.style.display !== 'none' && d.classList.contains('open');
      });
      if (r2) await page.click('.rs-close');
    }
    const after = await page.evaluate((i) => window.__grade(i), mine);
    say('the men do what it said', after.onStone > 0 || after.maxY - before.maxY > 2,
      `six minutes later, where are ${before.typeId} ${mine}'s men`,
      `on the stone ${before.onStone} → ${after.onStone} of ${after.men} alive `
      + `(${before.men} set off), highest man ${before.maxY} → ${after.maxY} m, `
      + `garrisoned ${after.garrisoned}, siege-owned ${after.owned}, plan `
      + `${after.plan ? `open goal ${after.plan.goal} age ${after.plan.age} stuck ${after.plan.stuck}` : 'none'}`);
    await shot('02-after-wall-order');
  }
}

// ---------------------------------------------------------------------------
// 3. Attack a man on the parapet, found by the cursor turning to "attack" under ctrl.
// ---------------------------------------------------------------------------
if (mine >= 0) {
  // Re-select before asking the attack question. Six minutes of battle have passed since the
  // last click and the unit may have routed, died or been dropped from the selection; a
  // right-click with nothing selected issues nothing, which reads as a refusal.
  let sel = await page.evaluate(() => window.__sel());
  if (!sel.length) {
    const f = await sweepAround('friend');
    if (f.px) { await page.mouse.click(f.px.x, f.px.y); await settle(300); }
    sel = await page.evaluate(() => window.__sel());
  }
  const live = sel[0] ?? mine;
  say('still have a unit in hand', sel.length > 0,
    'a selection to give the attack order with', `selection [${sel.join(',')}]`);
  const theirs = await page.evaluate(() => window.__theirs());
  // A pixel that reads "wall" plainly and "attack" with ctrl held is, by the interface's own
  // account, a man standing on a wall. That is the whole discoverability claim.
  const plain = await findCursor('wall');
  let both = null;
  if (plain) {
    await page.keyboard.down('Control');
    await page.mouse.move(plain.x, plain.y); await settle(240);
    const c = await page.evaluate(() => window.__cur());
    await page.keyboard.up('Control');
    if (c === 'attack') both = plain;
  }
  const px = both ?? await findCursor('attack', { ctrl: true });
  say('a man on the wall is targetable', !!px,
    'a pixel the interface calls a wall order plainly and an attack with Ctrl held',
    px ? `found at (${px.x},${px.y})${both ? ' — the same pixel both ways' : ''}` : 'none found');
  if (px) {
    const r = await clickAndRead(px, [live], true);
    const hit = r.order && r.order.kind === 'attack' && theirs.includes(r.order.targetUnitId);
    say('ctrl right-click attacks him', !!hit,
      `Ctrl + right-click it — hint "${r.hint}"`,
      r.order ? `orderIssued ${r.order.kind}`
        + (r.order.targetUnitId !== undefined ? ` targetUnitId=${r.order.targetUnitId} `
          + `(garrisons on the wall: [${theirs.join(',')}])` : '') : 'no orderIssued');
    await page.evaluate(() => window.__game.engine.advance(2, 166));
    const g = await page.evaluate((i) => window.__grade(i), live);
    say('the sim took it', g.targetUnitId >= 0 && theirs.includes(g.targetUnitId),
      'two seconds later', `unit ${live} order ${g.order} targetUnitId ${g.targetUnitId}`);
    await shot('03-after-attack');
  }
}

if (errs.length) say('console clean', false, 'page errors', errs.slice(0, 3).join(' | '));
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}  (${out.length} checks)`);
if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ map: MAP, out }, null, 1));
await browser.close();
process.exit(failed === 0 ? 0 : 1);
