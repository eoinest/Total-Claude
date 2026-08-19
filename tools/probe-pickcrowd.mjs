#!/usr/bin/env node
/**
 * What fraction of a unit's own drawn crowd actually selects it?
 *
 * Two arms of one question, and both were reported from the seat rather than from a probe,
 * because every probe in this repo that clicks a unit clicks its *card*.
 *
 *  - `--phase=deploy` — during the pre-battle phase. `BattleSystem.levelOf` is written only
 *    inside `fixedUpdate`, which the paused deployment never runs, so `model.standY` is 0 for
 *    every unit on the board and the elevated pick cannot fire at all.
 *  - `--phase=play` — in play, on the ground. The camera looks down at about 18 degrees, so a
 *    ray through a man's chest meets the terrain several metres behind him, and the pick was
 *    tested against that terrain point.
 *
 * The measure is the same in both: park a camera on one unit, sweep a grid of pixels over the
 * men the renderer drew, and count how many resolve to that unit through
 * `SelectionController`'s own hover answer. Nothing here clicks a card.
 *
 * Usage: node tools/probe-pickcrowd.mjs --port=5477 [--map=carthage] [--phase=play|deploy]
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const MAP = args.get('map') ?? 'carthage';
const PHASE = args.get('phase') ?? 'play';
const JSON_OUT = args.get('json') ?? null;
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }
console.log(`• ${base}   map ${MAP}   phase ${PHASE}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
const settle = (ms = 200) => page.waitForTimeout(ms);

await page.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.menu .begin', { timeout: 90000 });
await page.click(`.menu [data-map="${MAP}"]`); await settle(250);
await page.click('.menu [data-scen="assault"]'); await settle(250);
await page.click('.menu .begin');
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await settle(700);
const hasDep = await page.evaluate(() => !!document.querySelector('.dep-begin'));
if (PHASE !== 'deploy') {
  if (hasDep) { await page.click('.dep-begin'); await settle(800); }
  await page.evaluate(() => window.__game.engine.advance(20, 166));
  await settle(400);
} else if (!hasDep) {
  console.error('  this build opened no deployment phase');
  await browser.close(); process.exit(2);
}

await page.evaluate(() => {
  const g = window.__game, ctx = g.engine.context;
  window.__ctl = () => ctx.tryGet('hud')?.controller ?? null;
  window.__hovered = () => window.__ctl()?.model.hoveredId ?? -2;
  window.__overUi = () => { const c = window.__ctl(); return c && c.ptr ? !!c.ptr.overUi : null; };
  const V = new (ctx.camera.position.constructor)();
  window.__proj = (x, y, z) => { V.set(x, y, z).project(ctx.camera);
    if (V.z > 1) return null;
    return { x: (V.x * 0.5 + 0.5) * ctx.viewW, y: (-V.y * 0.5 + 0.5) * ctx.viewH }; };
  /**
   * The men the renderer drew, projected. Not the anchor and not the footprint — the actual
   * living soldiers, which is the only crowd a player can see and aim at.
   */
  window.__crowd = (id) => {
    const u = g.battle.unitById(id), p = g.battle.pool;
    if (!u) return null;
    const pts = [];
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      const q = window.__proj(p.x[i], p.y[i] + 0.9, p.z[i]);
      if (q) pts.push(q);
    }
    return pts;
  };
  window.__view = (id) => {
    const v = window.__ctl()?.model.view(id);
    return v ? { standY: +v.standY.toFixed(2), cy: +v.cy.toFixed(2),
      elevated: v.standY - v.cy > 2.5 } : null;
  };
  window.__pick = (want) => {
    const s = g.battle.siege;
    const out = [];
    for (const u of g.battle.units) {
      if (u.destroyed || u.faction !== 0 || u.alive < 10) continue;
      const on = s.isGarrisoned(u.id);
      if (want === 'wall' ? !on : on) continue;
      out.push({ id: u.id, typeId: u.typeId, alive: u.alive, x: u.x, z: u.z });
    }
    return out;
  };
});

// On the wall for the deployment arm — that is the case that was dead — and on the ground
// for the play arm, which is where the depth error lives.
const want = PHASE === 'deploy' ? 'wall' : 'ground';
const cands = await page.evaluate((w) => window.__pick(w), want);
if (!cands.length) { console.error(`  no player unit ${want === 'wall' ? 'on the wall' : 'on the ground'}`); await browser.close(); process.exit(2); }
const rows = [];
for (const u of cands.slice(0, 3)) {
  /*
   * Focus on the men, not the unit anchor. A garrison's anchor is the midpoint of its front
   * rank at ground level while its men stand eight metres up on the walk, so a camera parked
   * on the anchor projects the crowd out of the band and the probe reports 0/0 — which is
   * indistinguishable from the defect it is trying to measure.
   */
  const at = await page.evaluate((id) => {
    const g = window.__game, uu = g.battle.unitById(id), p = g.battle.pool;
    let n = 0, sx = 0, sz = 0;
    for (const i of uu.members) { if (!p.aliveAt(i)) continue; n++; sx += p.x[i]; sz += p.z[i]; }
    return n ? { x: sx / n, z: sz / n } : { x: uu.x, z: uu.z };
  }, u.id);
  await page.evaluate(([c]) => window.__game.setCamera(c.x, c.z, 0.42, Math.PI), [at]);
  await settle(450);
  const view = await page.evaluate((id) => window.__view(id), u.id);
  const crowd = await page.evaluate((id) => window.__crowd(id), u.id);
  const vis = crowd.filter((p) => p.x > 20 && p.x < W - 20 && p.y > 70 && p.y < H - 130);
  if (vis.length < 6) { rows.push({ id: u.id, typeId: u.typeId, n: 0, hit: 0, note: 'crowd off screen' }); continue; }
  // Every eighth drawn man, so the sample is the crowd itself rather than a box around it.
  let n = 0, hit = 0, ui = 0;
  for (let k = 0; k < vis.length; k += Math.max(1, Math.floor(vis.length / 40))) {
    const p = vis[k];
    await page.mouse.move(p.x, p.y);
    await settle(45);
    const q = await page.evaluate(() => ({ h: window.__hovered(), ui: window.__overUi() }));
    if (q.ui) { ui++; continue; }
    n++;
    if (q.h === u.id) hit++;
  }
  rows.push({ id: u.id, typeId: u.typeId, alive: u.alive, standY: view?.standY, cy: view?.cy,
    elevated: view?.elevated, n, hit, ui, pct: n ? +(100 * hit / n).toFixed(1) : 0 });
  console.log(`  ${String(u.typeId).padEnd(20)} ${String(hit).padStart(3)}/${String(n).padEnd(3)} `
    + `pixels on its own drawn men select it (${n ? (100 * hit / n).toFixed(1) : 0}%)  `
    + `standY ${view?.standY} cy ${view?.cy} elevated ${view?.elevated}`);
}
const tot = rows.reduce((a, r) => ({ n: a.n + (r.n ?? 0), hit: a.hit + (r.hit ?? 0) }), { n: 0, hit: 0 });
console.log(`  TOTAL ${tot.hit}/${tot.n} (${tot.n ? (100 * tot.hit / tot.n).toFixed(1) : 0}%)`);
console.log(`  page errors: ${errs.length ? errs.slice(0, 3).join(' | ') : 'none'}`);
if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ MAP, PHASE, rows, tot }, null, 1));
await browser.close();
