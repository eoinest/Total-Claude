/**
 * Shared rig for the playability pass: boot through the real menu, drive real input.
 *
 * ## Two things in here had never once worked, and neither could say so
 *
 * **The end of a battle was looked for on selectors the product does not render.** `__hud`
 * polled `.result, .verdict, .battle-end, .endcard` and the run scripts polled
 * `.endcard, .result, .verdict, .battle-result, .result-sheet, .outcome`. The panel is
 * **`.rs-panel`**, with `.rs-verdict` / `.rs-reason` inside it (`src/ui/BattleFlow.ts`), so
 * none of the nine matched and **no playability run in this project's history had ever seen a
 * battle finish.** `pl-runA` looped 24 × 25 s looking for it and reported nothing wrong,
 * because nothing in this directory asserted anything.
 *
 * **The clock was advanced on a schedule the engine documents as a different battle.**
 * `fast()` called `advance(sec, 166)`. `src/core/Engine.ts` says in its own comment that
 * 166 ms runs a different *number of ticks* for the same elapsed time — 901 against 900 at
 * t+30 — so every figure this rig has ever printed came off a run nothing else can reproduce.
 * `Engine.advanceTicks(n, stepMs)` exists precisely so a driver can be bit-comparable, and it
 * is what this now uses.
 *
 * Both are the same failure one layer down from the one the `boot` comment below is about: a
 * check that cannot fail. So this file now carries `ledger()`/`ck()` — **a claim is only made
 * by asserting it** — and `mustEnd()`, which fails a run that never saw a verdict.
 *
 * ## Converged deliberately with `tools/judge/jg-lib.mjs`
 *
 * That rig was written fresh for the gameplay judge against these same two faults and is the
 * better instrument: it asserts everything, it drives by ticks, and it reads the HUD by the
 * real class names. `ledger`, `ck`, `secTicks`, `ended` and the tick-driven fast-forward here
 * are deliberately the *same design and the same names*, so the two do not drift while both
 * exist — and when `tools/judge/` lands on `main`, **delete this rig and point its callers at
 * that one** rather than maintaining two drivers for one menu. The one thing that must not
 * happen is a third.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootThroughMenu, ensureServer } from '../lib/menu-boot.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../..');
/** `src/core/Time.ts` fixed step. */
export const TICK_HZ = 30;
export const secTicks = (s) => Math.round(s * TICK_HZ);

export function argsOf() {
  return new Map(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1'];
  }));
}

/** Everything the driver reads, installed once after boot. Reads only; never orders. */
const INSTALL = () => {
  const g = window.__game, ctx = g.engine.context;
  const V = new (ctx.camera.position.constructor)();
  window.__P = (x, y, z) => {
    V.set(x, y, z).project(ctx.camera);
    if (V.z > 1) return null;
    return { x: (V.x * 0.5 + 0.5) * ctx.viewW, y: (-V.y * 0.5 + 0.5) * ctx.viewH, z: V.z };
  };
  window.__ctl = () => { const h = ctx.tryGet('hud'); return h ? h.controller : null; };
  window.__siege = () => g.battle.siege ?? null;
  window.__city = () => ctx.tryGet('city');
  window.__cur = () => {
    const c = window.__ctl();
    const hint = document.querySelector('.drag-hint');
    return {
      cursor: document.body.dataset.cur ?? '',
      hint: hint && hint.style.display !== 'none' ? hint.textContent : '',
      hintShown: !!(hint && hint.style.display === 'block'),
      hovered: c ? c.model.hoveredId : -2,
      sel: c ? c.model.selection.slice() : [],
      wallValid: c ? c.wallValid : null,
      wallX: c ? +c.wallX.toFixed(2) : null,
      wallZ: c ? +c.wallZ.toFixed(2) : null,
      wallY: c ? +c.wallY.toFixed(2) : null,
      orderX: c ? +c.orderX.toFixed(2) : null,
      orderZ: c ? +c.orderZ.toFixed(2) : null,
      solidY: c ? +c.solidY.toFixed(2) : null,
      overUi: c ? c.ptr.overUi : null,
      px: c ? Math.round(c.ptr.x) : null, py: c ? Math.round(c.ptr.y) : null,
      groundValid: c ? c.groundValid : null,
      solidValid: c ? c.solidValid : null,
    };
  };
  /** A unit's summary, including where its men actually stand. */
  window.__u = (id) => {
    const u = g.battle.unitById(id); if (!u) return null;
    const p = g.battle.pool; let n = 0, sy = 0, hi = -1e9, lo = 1e9, elev = 0;
    for (const i of u.members) {
      if (p.hp[i] <= 0) continue;
      n++; sy += p.y[i]; hi = Math.max(hi, p.y[i]); lo = Math.min(lo, p.y[i]);
      if (g.battle.elevated && g.battle.elevated[i]) elev++;
    }
    return {
      id: u.id, type: u.typeId, faction: u.faction, alive: u.alive, order: u.order,
      x: +u.x.toFixed(1), z: +u.z.toFixed(1), morale: +u.morale.toFixed(0),
      kills: u.kills, destroyed: u.destroyed, routing: u.order === 9 || u.routTimer > 0,
      meanY: n ? +(sy / n).toFixed(2) : null, hiY: n ? +hi.toFixed(2) : null, loY: n ? +lo.toFixed(2) : null,
      elevated: elev, n,
    };
  };
  window.__units = (f) => g.battle.units.filter(u => (f === undefined || u.faction === f))
    .map(u => window.__u(u.id));
  /** Men of a unit above a height, and their z spread — "are they on the wall". */
  window.__above = (id, y) => {
    const u = g.battle.unitById(id); if (!u) return null;
    const p = g.battle.pool; let n = 0, up = 0;
    for (const i of u.members) { if (p.hp[i] <= 0) continue; n++; if (p.y[i] > y) up++; }
    return { n, up };
  };
  window.__bays = () => {
    const c = window.__city(); if (!c || !c.getGarrisonBays) return [];
    return c.getGarrisonBays().map(b => ({
      i: b.index, cx: +((b.x0 + b.x1) / 2).toFixed(2), cz: +((b.z0 + b.z1) / 2).toFixed(2),
      walkY: +b.walkY.toFixed(3), crestY: +b.crestY.toFixed(2), groundY: +b.groundY.toFixed(2),
      nx: +b.nx.toFixed(2), nz: +b.nz.toFixed(2), garr: !!b.garrisonable, gate: !!b.isGate,
      innerOff: +b.innerOff.toFixed(2), outerOff: +b.outerOff.toFixed(2), len: +b.length.toFixed(1),
    }));
  };
  const safe = (f) => { try { return f(); } catch (e) { return 'ERR ' + e.message; } };
  window.__reports = () => {
    const s = window.__siege(), c = window.__city();
    return {
      t: +g.simTime().toFixed(1),
      towers: safe(() => s?.towerReport?.() ?? null),
      engines: safe(() => s?.engineReport?.() ?? null),
      ram: safe(() => s?.ramReport?.() ?? null),
      breach: safe(() => s?.breachReport?.() ?? null),
      gate: safe(() => s?.gateReport?.() ?? null),
      wall: safe(() => s?.wallReport?.() ?? null),
      stats: safe(() => s?.stats?.() ?? null),
      gates: safe(() => c?.getGates?.() ?? null),
      strength: { ...g.battle.strength },
    };
  };
  window.__wallState = (id) => safe(() => window.__siege()?.unitWallState?.(id) ?? null);
  window.__hud = () => ({
    /*
     * `.rs-panel`, which is the class the product renders. This read
     * `.result, .verdict, .battle-end, .endcard` and therefore read `''` at the end of every
     * battle ever driven by this rig. See the file header.
     */
    banner: document.querySelector('.rs-panel')?.textContent?.replace(/\s+/g, ' ').slice(0, 600) ?? '',
    verdict: document.querySelector('.rs-verdict')?.textContent?.trim() ?? '',
    reason: document.querySelector('.rs-reason')?.textContent?.trim() ?? '',
    top: document.querySelector('.topbar, .top')?.textContent?.replace(/\s+/g, ' ').slice(0, 300) ?? '',
    feed: Array.from(document.querySelectorAll('.feed-row, .ev-row, .feed li')).slice(-8).map(e => e.textContent.replace(/\s+/g, ' ')),
    cmd: document.querySelector('.cmd')?.textContent?.replace(/\s+/g, ' ').slice(0, 300) ?? '',
  });
};

/**
 * Boot through the real menu.
 *
 * The click sequence now comes from `tools/lib/menu-boot.mjs`, shared with
 * `tools/qa-replay.mjs`. It used to be written out here, and it had been broken since
 * `8534b23` on 20 August put a **front door** in front of the setup sheet: `menu.css` hides
 * `.menu-setup` while `.menu` is `at-home`, and `?autoplay=0` does not name a battle, so
 * `startStep` opens on the front door and `[data-map=…]` was never visible to be clicked.
 * None of the six scripts in this directory asserts anything, so all six went on producing
 * narrative logs about a menu they could not reach. That is the argument for the shared file.
 *
 * It also starts a server if there is none, which this never did — it assumed one on `port`.
 */
export async function boot({ port, map, tier = 'high', out, size = 'default', label }) {
  await mkdir(out, { recursive: true });
  const { base } = await ensureServer({ port, root: ROOT });
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errs = [], cerrs = [];
  page.on('pageerror', e => { errs.push(String(e)); console.log('  !! PAGEERROR', String(e).slice(0, 240)); });
  page.on('console', m => { if (m.type() === 'error') { cerrs.push(m.text()); console.log('  !! CONSOLE', m.text().slice(0, 240)); } });

  const t0 = Date.now();
  await bootThroughMenu(page, {
    base,
    map,
    scenario: 'assault',
    tier,
    size: size === 'default' ? undefined : size,
    onSetup: (p) => p.screenshot({ path: path.join(out, `${label}-00-menu.png`) }),
  });
  const bootS = (Date.now() - t0) / 1000;
  await page.waitForTimeout(1200);
  await page.evaluate(INSTALL);
  return { browser, page, errs, cerrs, bootS };
}

export const shot = (page, out, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
export const dump = (out, name, obj) => writeFile(path.join(out, `${name}.json`), JSON.stringify(obj, null, 1));

/**
 * Advance the sim fast, in chunks, letting the page breathe between them.
 *
 * **By ticks, at 1000/60.** This called `advance(sec, 166)`, and `Engine.advance`'s own
 * comment says a 166 ms step runs a different number of ticks for the same elapsed time than
 * 1000/60 does — 901 against 900 at t+30 — which makes it a different battle from the one any
 * other tool in this repository measures. `advanceTicks(n, stepMs)` was added so a driver
 * could be bit-comparable and this is the call it was added for.
 *
 * The seconds-in / seconds-out signature is unchanged, so the eight scripts that import this
 * keep working; what changed is that the number they print is now reproducible.
 */
export async function fast(page, seconds, chunk = 10) {
  let done = 0;
  while (done < seconds) {
    const s = Math.min(chunk, seconds - done);
    await page.evaluate((n) => window.__game.advanceTicks(n, 1000 / 60), secTicks(s));
    done += s;
    await page.waitForTimeout(30);
  }
  return page.evaluate(() => +window.__game.simTime().toFixed(1));
}

/* ------------------------------------------------------------------ verdicts */

/**
 * Has the battle ended? Reads the class the product renders, and nothing else.
 *
 * Returns `{ verdict, reason }` or `null`. Every "did it finish" test in this directory goes
 * through here now, so there is one selector to be wrong rather than nine.
 */
export const ended = (page) => page.evaluate(() => {
  const rs = document.querySelector('.rs-panel');
  return rs ? {
    verdict: rs.querySelector('.rs-verdict')?.textContent?.trim() ?? '?',
    reason: rs.querySelector('.rs-reason')?.textContent?.trim() ?? '?',
  } : null;
});

/**
 * A run that proves nothing has to say so in its last line.
 *
 * The same shape and the same names as `tools/judge/jg-lib.mjs:ledger` — see the file header
 * on why that is deliberate. `ck(name, ok, expected, actual)` is the only way a claim gets
 * made; `summary()` returns the number of failures so a caller can set an exit code.
 */
export function ledger(label) {
  const rows = [], log = [];
  const say = (...a) => {
    const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    console.log(s); log.push(s);
  };
  const ck = (name, ok, expected, actual) => {
    rows.push({ name, ok: !!ok, expected, actual });
    say(`  [${ok ? 'PASS' : 'FAIL'}] ${name}  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    return !!ok;
  };
  const summary = () => {
    const bad = rows.filter(r => !r.ok);
    say(`\n${label}: ${rows.length - bad.length}/${rows.length} checks passed`);
    for (const b of bad) say(`  FAILED: ${b.name}  expected=${JSON.stringify(b.expected)} actual=${JSON.stringify(b.actual)}`);
    if (rows.length === 0) say(`${label}: NOTHING WAS ASSERTED — this run proves nothing.`);
    return bad.length + (rows.length === 0 ? 1 : 0);
  };
  return { say, ck, rows, log, summary };
}

/**
 * Run the clock on until the battle ends, and **assert that it did**.
 *
 * This is the check the whole directory was missing. Every one of these scripts had a loop
 * that looked for a result panel, could never find one, and finished with a cheerful log —
 * so "the rig ran" and "the rig saw a battle" were indistinguishable for two days. A driver
 * that never reaches a verdict is not a slow driver, it is a broken one, and it now fails.
 */
export async function mustEnd(page, L, { until = 1600, step = 20, label = 'the battle' } = {}) {
  let seen = null, t = await page.evaluate(() => +window.__game.simTime().toFixed(1));
  while (t < until && !seen) {
    await fast(page, step);
    t = await page.evaluate(() => +window.__game.simTime().toFixed(1));
    seen = await ended(page);
  }
  L.ck(`${label} reaches a verdict`, !!seen, 'a .rs-panel with a verdict', seen ?? `nothing by t+${t}`);
  if (seen) L.say(`  verdict at t+${t}: ${seen.verdict} — ${seen.reason}`);
  return { end: seen, t };
}

/** Move the mouse to a screen point and report what the cursor says it will do. */
export async function hover(page, pt, settle = 3) {
  await page.mouse.move(pt.x, pt.y);
  for (let i = 0; i < settle; i++) await page.waitForTimeout(40);
  return page.evaluate(() => window.__cur());
}

/** Real right-click order. Press, hold (so the hint shows), read it, release. */
export async function rightClick(page, pt, { hold = 220 } = {}) {
  await page.mouse.move(pt.x, pt.y);
  await page.waitForTimeout(60);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(hold);
  const during = await page.evaluate(() => window.__cur());
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(80);
  return during;
}

/** Real right-drag: press at a, drag to b, release. Returns the hint at the end of the drag. */
export async function rightDrag(page, a, b, { steps = 10 } = {}) {
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(50);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(120);
  const during = await page.evaluate(() => window.__cur());
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(100);
  return during;
}

export async function leftClick(page, pt, mods = []) {
  await page.mouse.move(pt.x, pt.y);
  await page.waitForTimeout(50);
  await page.mouse.click(pt.x, pt.y, { button: 'left', modifiers: mods });
  await page.waitForTimeout(120);
}

export const cam = (page, x, z, zoom, yaw) => page.evaluate(([a, b, c, d]) =>
  window.__game.setCamera(a, b, c, d), [x, z, zoom, yaw]);

/** Project a world point; returns null if behind the camera or well off screen. */
export const proj = (page, x, y, z) => page.evaluate(([a, b, c]) => window.__P(a, b, c), [x, y, z]);

/**
 * Park the camera so a world point lands where we want it on screen, then return that point.
 * Solves the 2x2 screen jacobian rather than guessing which way yaw points.
 */
export async function aim(page, x, y, z, { zoom = 0.55, yaw = 0, wx = 800, wy = 430, tol = 60 } = {}) {
  let best = null;
  for (const dz of [0, -25, 25, -50, 50, -90, 90, -140, 140, -200]) {
    await cam(page, x, z + dz, zoom, yaw);
    await page.waitForTimeout(190);
    const p = await proj(page, x, y, z);
    if (!p) continue;
    const on = p.x > 130 && p.x < 1470 && p.y > 130 && p.y < 700;
    const cost = Math.hypot(p.x - wx, p.y - wy) + (on ? 0 : 6000);
    if (!best || cost < best.cost) best = { cost, p, dz };
    if (on && cost < tol) break;
  }
  if (!best) return null;
  await cam(page, x, z + best.dz, zoom, yaw);
  await page.waitForTimeout(260);
  const p = await proj(page, x, y, z);
  return p && p.x > 4 && p.x < 1596 && p.y > 4 && p.y < 896 ? p : null;
}

/** Select a unit by clicking its men, framing the camera first. Returns what got selected. */
export async function selectUnit(page, id, opts = {}) {
  const u = await page.evaluate((i) => window.__u(i), id);
  if (!u) return { ok: false, why: 'no unit' };
  const p = await aim(page, u.x, (u.meanY ?? 0) + 0.4, u.z, opts);
  if (!p) return { ok: false, why: 'offscreen' };
  const h = await hover(page, p);
  await leftClick(page, p);
  const cur = await page.evaluate(() => window.__cur());
  return { ok: cur.sel.length === 1 && cur.sel[0] === id, sel: cur.sel, hoverCursor: h.cursor, hovered: h.hovered, p };
}

/** Install the diagnostic readers the play scripts use. Call once after boot. */
export const installDiag = (page) => page.evaluate(() => {
  window.__diag = () => {
    const c = window.__ctl(), s = window.__siege();
    return { st: c.storming, wv: c.wallValid, sv: c.solidValid, sy: +c.solidY.toFixed(2),
      sx: +c.solidX.toFixed(2), sz: +c.solidZ.toFixed(2), ta: s ? s.wallTargetAt(c.solidX, c.solidZ) : null,
      cur: document.body.dataset.cur, sel: c.model.selection.slice(), hov: c.model.hoveredId,
      ui: c.ptr.overUi };
  };
  window.__box = (id) => {
    const g = window.__game, u = g.battle.unitById(id), p = g.battle.pool;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, n = 0;
    for (const i of u.members) { if (p.hp[i] <= 0) continue;
      for (const q of [window.__P(p.x[i], p.y[i], p.z[i]), window.__P(p.x[i], p.y[i] + 1.7, p.z[i])]) {
        if (!q) continue; n++; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); } }
    return { n, x0, x1, y0, y1 };
  };
});

/** Find a pixel on a bay that the game will read as a wall order, or null. Returns {p, tried, hit}. */
export async function wallPixel(page, b, { side = 1, zoom = 0.6 } = {}) {
  const yaw = side > 0 ? 0 : Math.PI;
  const anchor = await aim(page, b.cx, b.walkY, b.cz + b.nz * 4 * side, { zoom, yaw, wy: 430 });
  if (!anchor) return { p: null, tried: 0, hit: 0 };
  let tried = 0, hit = 0, first = null;
  for (const dy of [-0.6, 0, 0.6, -1.4, 1.2]) {
    for (const along of [0, -6, 6, -11, 11]) {
      const wx = b.cx - b.nz * along + b.nx * 4 * side;
      const wz = b.cz + b.nx * along + b.nz * 4 * side;
      const q = await page.evaluate(([a, y, c]) => window.__P(a, y, c), [wx, b.walkY + dy, wz]);
      if (!q || q.x < 40 || q.x > 1560 || q.y < 110 || q.y > 700) continue;
      await page.mouse.move(q.x, q.y); await page.waitForTimeout(45);
      const d = await page.evaluate(() => window.__diag());
      tried++;
      if (d.wv && !d.ui) { hit++; if (!first) first = q; }
    }
    if (first) break;
  }
  return { p: first, tried, hit };
}

/**
 * Select a unit the way a determined player would: click its anchor, and if that does
 * nothing, hunt over the pixels its men are actually drawn on. Reports how hard it was.
 */
export async function selectHard(page, id, { zoom = 0.55, yaw = 0, back = 0 } = {}) {
  const u = await page.evaluate((i) => window.__u(i), id);
  if (!u || u.alive === 0) return { ok: false, why: 'gone', clicks: 0 };
  const p0 = await aim(page, u.x, (u.meanY ?? 0) + 0.4, u.z + back, { zoom, yaw });
  let clicks = 0;
  if (p0) {
    await leftClick(page, p0); clicks++;
    const cur = await page.evaluate(() => window.__cur());
    if (cur.sel.length === 1 && cur.sel[0] === id) return { ok: true, clicks, p: p0, easy: true };
  }
  const box = await page.evaluate((i) => window.__box(i), id);
  if (!box || !isFinite(box.x0)) return { ok: false, why: 'not drawn', clicks };
  let probes = 0, answering = 0, first = null;
  for (let j = 0; j <= 8; j++) {
    const y = Math.round(box.y0 + (box.y1 - box.y0) * j / 8);
    for (let i = 0; i <= 10; i++) {
      const x = Math.round(box.x0 + (box.x1 - box.x0) * i / 10);
      if (x < 4 || x > 1596 || y < 110 || y > 760) continue;
      await page.mouse.move(x, y); await page.waitForTimeout(32);
      const h = await page.evaluate(() => window.__cur());
      probes++;
      if (h.hovered === id) { answering++; if (!first) first = { x, y }; }
    }
  }
  if (!first) return { ok: false, why: 'no pixel answers', clicks, probes, answering, box };
  await leftClick(page, first); clicks++;
  const cur = await page.evaluate(() => window.__cur());
  return { ok: cur.sel.length === 1 && cur.sel[0] === id, clicks, p: first, probes, answering, box, easy: false };
}
