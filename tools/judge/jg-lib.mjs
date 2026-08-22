/**
 * The gameplay judge's rig.
 *
 * Written fresh rather than reusing `tools/scratch/pl-lib-emc.mjs` for two measured reasons:
 *
 *  1. `pl-lib-emc.mjs:fast()` advances with `advance(sec, 166)`. `src/core/Engine.ts` says in
 *     its own comment that a 166 ms step runs a *different number of ticks* than 1000/60 at
 *     the same elapsed time (901 vs 900 at t+30) and therefore is a different battle. Every
 *     number the playability pass printed is off a run nothing else can reproduce. This rig
 *     fast-forwards with `advanceTicks(n, 1000/60)`, which the engine documents as the one
 *     entry point that is bit-comparable.
 *
 *  2. `pl-lib-emc.mjs:__hud()` looks for `.result, .verdict, .battle-end, .endcard` and the
 *     run scripts poll `.endcard, .result, .verdict, .battle-result, .result-sheet, .outcome`.
 *     The result panel is `.rs-panel` with `.rs-verdict` / `.rs-reason` (src/ui/BattleFlow.ts
 *     l.480-500). None of those six selectors matches it, so no playability run has ever seen
 *     a battle end. That is the same silent-no-assert failure the rig's own header warns about,
 *     one layer down.
 *
 * Everything here asserts. `ck()` records a pass/fail with expected and actual, and a run that
 * ends with a failed check says so in its last line.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootThroughMenu, ensureServer } from '../lib/menu-boot.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const TICK_HZ = 30;                       // src/core/Time.ts fixed step
export const secTicks = (s) => Math.round(s * TICK_HZ);

export function argsOf() {
  return new Map(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1'];
  }));
}

/* ------------------------------------------------------------------ verdicts */

export function ledger(label) {
  const rows = [], log = [];
  const say = (...a) => {
    const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    console.log(s); log.push(s);
  };
  /** ck(name, ok, expected, actual) — the only way a claim gets made in this rig. */
  const ck = (name, ok, expected, actual) => {
    rows.push({ name, ok: !!ok, expected, actual });
    say(`  [${ok ? 'PASS' : 'FAIL'}] ${name}  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    return !!ok;
  };
  const summary = () => {
    const bad = rows.filter(r => !r.ok);
    say(`\n${label}: ${rows.length - bad.length}/${rows.length} checks passed`);
    for (const b of bad) say(`  FAILED: ${b.name}  expected=${JSON.stringify(b.expected)} actual=${JSON.stringify(b.actual)}`);
    return bad.length;
  };
  return { say, ck, rows, log, summary };
}

/* ------------------------------------------------------------------- reading */

/**
 * Everything the *player* can read, by the real class names, plus the sim state behind it.
 * The point of this pair is honesty grading: HUD text on one side, ground truth on the other.
 */
const INSTALL = () => {
  const g = window.__game, ctx = g.engine.context;
  const V = new (ctx.camera.position.constructor)();
  const t2 = (n) => Math.round(n * 100) / 100;
  const safe = (f) => { try { return f(); } catch (e) { return 'ERR ' + e.message; } };
  const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
  const all = (sel) => Array.from(document.querySelectorAll(sel));

  window.__P = (x, y, z) => {
    V.set(x, y, z).project(ctx.camera);
    if (V.z > 1) return null;
    return { x: (V.x * 0.5 + 0.5) * ctx.viewW, y: (-V.y * 0.5 + 0.5) * ctx.viewH, z: V.z };
  };
  window.__ctl = () => { const h = ctx.tryGet('hud'); return h ? h.controller : null; };
  window.__siege = () => g.battle.siege ?? null;
  window.__city = () => ctx.tryGet('city');

  /** THE HUD, as text. Nothing derived; only what is on screen. */
  window.__HUD = () => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05; };
    const rs = document.querySelector('.rs-panel');
    return {
      // top bar: the phase, the clock, the balance of the two armies
      phase: txt('.tb-phase'), speed: txt('.tb-speed'), clock: txt('.tb-clock'),
      blocks: all('.tb-block').map(b => ({
        name: b.querySelector('.tb-name')?.textContent?.trim() ?? null,
        men: b.querySelector('.tb-men')?.textContent?.trim() ?? null,
        units: b.querySelector('.tb-units')?.textContent?.trim() ?? null,
        loss: b.querySelector('.tb-loss')?.textContent?.trim() ?? null,
        line: b.querySelector('.tb-line')?.textContent?.trim() ?? null,
      })),
      adv: txt('.tb-adv'), note: txt('.tb-note'), mid: txt('.tb-mid'),
      // the objective / advantage strip, whatever it turns out to be
      topAll: txt('.tb-head') ?? txt('.topbar'),
      // the feed, newest last
      feed: all('.note').filter(vis).map(n => ({
        head: n.querySelector('.note-head')?.textContent?.trim() ?? '',
        sub: n.querySelector('.note-sub')?.textContent?.trim() ?? '',
        n: n.querySelector('.note-n')?.textContent?.trim() ?? '',
        tone: /\bgood\b/.test(n.className) ? 'good' : /\bbad\b/.test(n.className) ? 'bad' : 'plain',
      })),
      // selection: the command panel
      cmd: document.querySelector('.cmd-grid, .cmd-name') ? {
        name: txt('.cmd-name'), native: txt('.cmd-native'), order: txt('.cmd-order'),
        state: txt('.cmd-state'), nums: txt('.cmd-nums'), mor: txt('.cmd-mor'),
        buttons: all('.btnrow button').map(b => ({ t: (b.textContent || b.title || '').trim().slice(0, 24), off: b.disabled, on: /\bon\b|\bactive\b|\bsel\b/.test(b.className) })),
      } : null,
      cards: all('.card-name').map(e => e.textContent.trim()),
      // the drag hint and the cursor: does the game say what a click will do
      hint: (() => { const h = document.querySelector('.drag-hint'); return h && vis(h) ? h.textContent.replace(/\s+/g, ' ').trim() : null; })(),
      cursor: document.body.dataset.cur ?? '',
      // banners
      banner: all('.bnr-plate').filter(vis).map(b => b.textContent.replace(/\s+/g, ' ').trim()).slice(0, 8),
      // the result panel, if any
      result: rs ? {
        verdict: txt('.rs-verdict'), reason: txt('.rs-reason'), clock: txt('.rs-clock'),
        flavour: all('.rs-flavour').map(e => e.textContent.replace(/\s+/g, ' ').trim()),
        cols: all('.rs-col').map(c => ({ f: c.dataset.f, txt: c.textContent.replace(/\s+/g, ' ').trim().slice(0, 260) })),
        honours: txt('.rs-honours')?.slice(0, 900) ?? null,
        buttons: all('.rs-foot button').map(b => b.textContent.trim()),
      } : null,
      // objectives panel, whatever class it has — search by content
      objectiveish: all('div,section,aside').filter(e => e.children.length < 14 && /objectiv|victor|defeat|condition|hold |breach/i.test(e.className)).map(e => ({ c: e.className, t: e.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) })).slice(0, 6),
      deploy: document.querySelector('.dep-panel, .dep-title') ? {
        title: txt('.dep-title'), step: txt('.dep-step'), zone: txt('.dep-zone'),
        help: txt('.dep-help'), note: txt('.dep-note'), tally: txt('.dep-tally'), brief: txt('.dep-brief'),
        rows: all('.dep-row').map(r => `${r.dataset.unit}=${r.querySelector('.dep-count')?.textContent}`),
      } : null,
    };
  };

  /** Ground truth. */
  window.__TRUTH = () => {
    const b = g.battle;
    const per = {};
    for (const u of b.units) { const f = u.faction; (per[f] ??= { units: 0, alive: 0, routing: 0, dead: 0 });
      per[f].units++; per[f].alive += u.alive; if (u.destroyed) per[f].dead++;
      if (u.order === 9 || u.routTimer > 0) per[f].routing++; }
    return {
      t: t2(g.simTime()), tick: g.engine.time.tick,
      strength: { ...b.strength }, per,
      flowResult: safe(() => ctx.tryGet('battleFlow')?.result ?? null),
      /** The arbiter's own published objective — the numbers the HUD claims to be printing. */
      objective: safe(() => { const o = ctx.tryGet('battleFlow')?.objective; return o ? { ...o } : null; }),
      hashes: safe(() => g.hashes()),
      siege: safe(() => { const s = window.__siege(); if (!s) return null; return {
        gate: s.gateReport?.(), breach: s.breachReport?.(), stats: s.stats?.(),
        towers: s.towerReport?.(), engines: s.engineReport?.(), ram: s.ramReport?.(), wall: s.wallReport?.(),
      }; }),
    };
  };

  window.__u = (id) => {
    const u = g.battle.unitById(id); if (!u) return null;
    const p = g.battle.pool; let n = 0, sy = 0, elev = 0;
    for (const i of u.members) { if (p.hp[i] <= 0) continue; n++; sy += p.y[i];
      if (g.battle.elevated && g.battle.elevated[i]) elev++; }
    return { id: u.id, type: u.typeId, faction: u.faction, alive: u.alive, order: u.order,
      x: t2(u.x), z: t2(u.z), morale: Math.round(u.morale), kills: u.kills, destroyed: u.destroyed,
      routing: u.order === 9 || u.routTimer > 0, meanY: n ? t2(sy / n) : null, elevated: elev, n };
  };
  window.__units = (f) => g.battle.units.filter(u => f === undefined || u.faction === f).map(u => window.__u(u.id));
  window.__sel = () => { const c = window.__ctl(); return c ? c.model.selection.slice() : null; };
  window.__cur = () => { const c = window.__ctl(); const h = document.querySelector('.drag-hint');
    return { cursor: document.body.dataset.cur ?? '', hint: h && h.style.display !== 'none' ? h.textContent.replace(/\s+/g,' ').trim() : '',
      hovered: c ? c.model.hoveredId : -2, sel: c ? c.model.selection.slice() : [],
      wallValid: c ? c.wallValid : null, groundValid: c ? c.groundValid : null, solidValid: c ? c.solidValid : null,
      overUi: c ? c.ptr.overUi : null, storming: c ? c.storming : null,
      solidY: c ? t2(c.solidY) : null, orderX: c ? t2(c.orderX) : null, orderZ: c ? t2(c.orderZ) : null }; };
  window.__bays = () => { const c = window.__city(); if (!c || !c.getGarrisonBays) return [];
    return c.getGarrisonBays().map(b => ({ i: b.index, cx: t2((b.x0+b.x1)/2), cz: t2((b.z0+b.z1)/2),
      walkY: t2(b.walkY), crestY: t2(b.crestY), groundY: t2(b.groundY), nx: t2(b.nx), nz: t2(b.nz),
      garr: !!b.garrisonable, gate: !!b.isGate, len: t2(b.length) })); };
  window.__wallState = (id) => safe(() => window.__siege()?.unitWallState?.(id) ?? null);
  window.__box = (id) => { const u = g.battle.unitById(id), p = g.battle.pool;
    let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9,n=0;
    for (const i of u.members) { if (p.hp[i] <= 0) continue;
      for (const q of [window.__P(p.x[i],p.y[i],p.z[i]), window.__P(p.x[i],p.y[i]+1.7,p.z[i])]) {
        if (!q) continue; n++; x0=Math.min(x0,q.x); x1=Math.max(x1,q.x); y0=Math.min(y0,q.y); y1=Math.max(y1,q.y); } }
    return { n, x0, x1, y0, y1 }; };
  /** Real-time fps over `ms`, with the rAF loop actually running. */
  window.__fps = (ms) => new Promise((res) => {
    let n = 0; const t0 = performance.now(); const worst = [];
    let last = t0;
    const step = (t) => { n++; worst.push(t - last); last = t;
      if (t - t0 < ms) requestAnimationFrame(step);
      else { worst.sort((a,b)=>b-a); res({ fps: Math.round(n / ((t - t0)/1000) * 10)/10, n,
        worstMs: Math.round(worst[0]), p95Ms: Math.round(worst[Math.floor(worst.length*0.05)]),
        medMs: Math.round(worst[Math.floor(worst.length*0.5)]) }); } };
    requestAnimationFrame(step);
  });
};

/* ------------------------------------------------------------------ the boot */

export async function boot({ port, map, scenario = 'assault', tier = 'ultra', size, out, label,
  query = 'autoplay=0', seed, onSetup, viewport = { width: 1600, height: 900 } }) {
  await mkdir(out, { recursive: true });
  const { base } = await ensureServer({ port, root: ROOT, cacheDir: process.env.TC_VITE_CACHE_DIR });
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars',
      '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errs = [], cerrs = [];
  page.on('pageerror', e => { errs.push(String(e)); console.log('  !! PAGEERROR', String(e).slice(0, 300)); });
  page.on('console', m => { if (m.type() === 'error') { cerrs.push(m.text()); console.log('  !! CONSOLE', m.text().slice(0, 300)); } });
  const t0 = Date.now();
  /*
   * The seed is a menu field, not a URL parameter (`src/ui/MainMenu.ts` l.562, l.659) — so a
   * judge who wants seed N has to type it the way a player does, and dispatch `change`, which
   * is the event the handler listens for.
   */
  const setup = async (p) => {
    if (seed !== undefined) {
      await p.fill('.menu .seed', String(seed));
      await p.evaluate(() => document.querySelector('.menu .seed')
        .dispatchEvent(new Event('change', { bubbles: true })));
      await p.waitForTimeout(200);
      const got = await p.evaluate(() => document.querySelector('.menu .seed').value);
      if (String(got) !== String(seed)) throw new Error(`seed field would not take ${seed}, reads ${got}`);
    }
    if (onSetup) await onSetup(p);
  };
  await bootThroughMenu(page, { base, map, scenario, tier, size, query, onSetup: setup });
  const bootS = Math.round((Date.now() - t0) / 100) / 10;
  await page.waitForTimeout(1500);
  await page.evaluate(INSTALL);
  return { browser, page, errs, cerrs, bootS, base };
}

/* ---------------------------------------------------------------- driving it */

/** Fast-forward by ticks, the only comparable schedule. Renders nothing. */
export async function ff(page, seconds, chunkS = 12) {
  let done = 0;
  while (done < seconds) {
    const s = Math.min(chunkS, seconds - done);
    await page.evaluate((n) => window.__game.advanceTicks(n, 1000 / 60), secTicks(s));
    done += s;
    await page.waitForTimeout(20);
  }
  // draw one real frame so a screenshot after this is not stale
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(() => ({ t: Math.round(window.__game.simTime() * 10) / 10, tick: window.__game.engine.time.tick }));
}

/** Let real time run for `ms` at whatever speed the game is set to. Returns fps. */
export const realtime = (page, ms) => page.evaluate((m) => window.__fps(m), ms);

export const shot = (page, out, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
export const dump = (out, name, obj) => writeFile(path.join(out, `${name}.json`), JSON.stringify(obj, null, 1));

export async function hover(page, pt, settle = 4) {
  await page.mouse.move(pt.x, pt.y);
  for (let i = 0; i < settle; i++) await page.waitForTimeout(45);
  return page.evaluate(() => window.__cur());
}
export async function rightClick(page, pt, { hold = 300 } = {}) {
  await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(70);
  await page.mouse.down({ button: 'right' }); await page.waitForTimeout(hold);
  const during = await page.evaluate(() => window.__cur());
  await page.mouse.up({ button: 'right' }); await page.waitForTimeout(120);
  return during;
}
export async function rightDrag(page, a, b, { steps = 12 } = {}) {
  await page.mouse.move(a.x, a.y); await page.waitForTimeout(60);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= steps; i++) { await page.mouse.move(a.x + (b.x-a.x)*i/steps, a.y + (b.y-a.y)*i/steps); await page.waitForTimeout(22); }
  await page.waitForTimeout(140);
  const during = await page.evaluate(() => window.__cur());
  await page.mouse.up({ button: 'right' }); await page.waitForTimeout(140);
  return during;
}
export async function leftClick(page, pt, mods = []) {
  await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(60);
  await page.mouse.click(pt.x, pt.y, { button: 'left', modifiers: mods });
  await page.waitForTimeout(140);
}
export async function boxSelect(page, a, b) {
  await page.mouse.move(a.x, a.y); await page.mouse.down({ button: 'left' });
  for (let i = 1; i <= 10; i++) { await page.mouse.move(a.x + (b.x-a.x)*i/10, a.y + (b.y-a.y)*i/10); await page.waitForTimeout(20); }
  await page.mouse.up({ button: 'left' }); await page.waitForTimeout(150);
  return page.evaluate(() => window.__sel());
}

export const cam = (page, x, z, zoom, yaw) => page.evaluate(([a,b,c,d]) => window.__game.setCamera(a,b,c,d), [x,z,zoom,yaw]);
export const proj = (page, x, y, z) => page.evaluate(([a,b,c]) => window.__P(a,b,c), [x,y,z]);

export async function aim(page, x, y, z, { zoom = 0.55, yaw = 0, wx = 800, wy = 430, tol = 60 } = {}) {
  let best = null;
  for (const dz of [0,-25,25,-50,50,-90,90,-140,140,-200,-300,300]) {
    await cam(page, x, z + dz, zoom, yaw); await page.waitForTimeout(180);
    const p = await proj(page, x, y, z); if (!p) continue;
    const on = p.x > 130 && p.x < 1470 && p.y > 130 && p.y < 700;
    const cost = Math.hypot(p.x - wx, p.y - wy) + (on ? 0 : 6000);
    if (!best || cost < best.cost) best = { cost, p, dz };
    if (on && cost < tol) break;
  }
  if (!best) return null;
  await cam(page, x, z + best.dz, zoom, yaw); await page.waitForTimeout(250);
  const p = await proj(page, x, y, z);
  return p && p.x > 4 && p.x < 1596 && p.y > 4 && p.y < 896 ? p : null;
}

/** Click a unit's men. Reports how hard it was, which is itself a playability number. */
export async function selectHard(page, id, { zoom = 0.55, yaw = 0, back = 0 } = {}) {
  const u = await page.evaluate(i => window.__u(i), id);
  if (!u || u.alive === 0) return { ok: false, why: 'gone', clicks: 0 };
  const p0 = await aim(page, u.x, (u.meanY ?? 0) + 0.4, u.z + back, { zoom, yaw });
  let clicks = 0;
  if (p0) { await leftClick(page, p0); clicks++;
    const s = await page.evaluate(() => window.__sel());
    if (s && s.length === 1 && s[0] === id) return { ok: true, clicks, p: p0, easy: true }; }
  const box = await page.evaluate(i => window.__box(i), id);
  if (!box || !isFinite(box.x0)) return { ok: false, why: 'not drawn', clicks };
  let probes = 0, answering = 0, first = null;
  for (let j = 0; j <= 8; j++) { const y = Math.round(box.y0 + (box.y1-box.y0)*j/8);
    for (let i = 0; i <= 10; i++) { const x = Math.round(box.x0 + (box.x1-box.x0)*i/10);
      if (x < 4 || x > 1596 || y < 110 || y > 760) continue;
      await page.mouse.move(x, y); await page.waitForTimeout(30);
      const h = await page.evaluate(() => window.__cur()); probes++;
      if (h.hovered === id) { answering++; if (!first) first = { x, y }; } } }
  if (!first) return { ok: false, why: 'no pixel answers', clicks, probes, answering, box };
  await leftClick(page, first); clicks++;
  const s = await page.evaluate(() => window.__sel());
  return { ok: s && s.length === 1 && s[0] === id, clicks, p: first, probes, answering, box, easy: false };
}

/** Has the battle ended? Uses the class the product actually renders. */
export const ended = (page) => page.evaluate(() => {
  const rs = document.querySelector('.rs-panel');
  return rs ? { verdict: rs.querySelector('.rs-verdict')?.textContent?.trim() ?? '?',
    reason: rs.querySelector('.rs-reason')?.textContent?.trim() ?? '?' } : null;
});
