#!/usr/bin/env node
/**
 * The owner's clock: boot the full-scale storm on a player's page and let the real rAF loop
 * run, untouched, sampling once a wall second. No `advance` anywhere — `advance` renders
 * 60 frames per sim second with nothing pacing it, so its wall clock is a statement about
 * the harness, not about play.
 *
 * Reports, per sample: sim seconds gained per wall second (the headline), fps, the frame
 * split p50/p90, men of the storming side actually standing on the parapet, and what the
 * adaptive controller is doing.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5788);
const BOOT = args.get('boot') ?? 'menu0';
const Q = args.get('quality') ?? 'high';
const W = Number(args.get('w') ?? 1600), H = Number(args.get('h') ?? 900);
const UNTIL = Number(args.get('until') ?? 460);       // sim seconds
const MAXWALL = Number(args.get('maxwall') ?? 1800);  // wall-second budget
const EVERY = Number(args.get('every') ?? 10);        // wall seconds per sample
const ADAPT = args.get('adaptive') ?? null;           // 'off'
const JSON_OUT = args.get('json') ?? null;
const base = `http://127.0.0.1:${PORT}`;
const url = BOOT === 'harness'
  ? `${base}/?harness=1&autoplay=1&w=${W}&h=${H}&map=carthage&scenario=assault&quality=${Q}`
  : `${base}/?menu=0&map=carthage&scenario=assault&autoplay=1&quality=${Q}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
console.log('url:', url);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
if (ADAPT === 'off') await page.evaluate(() => { window.__game.engine.adaptiveQuality.enabled = false; });
console.log('boot:', JSON.stringify(await page.evaluate(() => {
  const b = window.__game.battle, e = window.__game.engine;
  return { men: b.units.reduce((a, u) => a + u.alive, 0), units: b.units.length, tier: e.quality.tier,
    adaptive: e.adaptiveQuality.enabled, drawing: [e.renderer.domElement.width, e.renderer.domElement.height] };
})));
await page.evaluate(() => {
  const e = window.__game.engine;
  const orig = e.frame.bind(e);
  const p = { t: [], sim: [], rnd: [], simTime: 0 };
  window.__live = p;
  e.frame = (nowMs) => {
    const a = performance.now(); orig(nowMs); const d = performance.now() - a;
    p.t.push(d); p.sim.push(e.lastSimMs); p.rnd.push(e.lastRenderMs);
  };
});
const st = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y);
  const q = (f) => +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(2);
  return { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +s[s.length - 1].toFixed(1) }; };
const samples = [];
const wall0 = Date.now();
let lastSim = await page.evaluate(() => window.__game.simTime());
let lastWall = Date.now();
console.log('wall(s)  simT   rate    fps  totP50 totP90  simP50 rndP50   stormWall garWall inside  alive  scale press  advQ');
while (true) {
  await page.waitForTimeout(EVERY * 1000);
  const s = await page.evaluate(() => {
    const g = window.__game, e = g.engine, b = g.battle, p = window.__live;
    const t = p.t.slice(), sim = p.sim.slice(), rnd = p.rnd.slice();
    p.t.length = 0; p.sim.length = 0; p.rnd.length = 0;
    const flow = e.context.tryGet('battleFlow');
    const o = flow?.objective ?? null;
    let alive = 0; const pool = b.pool;
    for (let i = 0; i < pool.count; i++) if (pool.aliveAt(i)) alive++;
    const ad = e.adaptiveQuality.state();
    return { simTime: g.simTime(), t, sim, rnd, alive,
      storm: o?.stormOnWall ?? null, gar: o?.garrisonOnWall ?? null, inside: o?.stormInside ?? null,
      held: o?.stormHolding ?? null, over: !!flow?.over,
      scale: +e.quality.renderScale.toFixed(2), press: +(ad.pressure ?? 0).toFixed(2), advP90: +(ad.p90 ?? 0).toFixed(1) };
  });
  const nowWall = Date.now();
  const dW = (nowWall - lastWall) / 1000, dS = s.simTime - lastSim;
  lastWall = nowWall; lastSim = s.simTime;
  const T = st(s.t), S = st(s.sim), R = st(s.rnd);
  samples.push({ wall: +((nowWall - wall0) / 1000).toFixed(1), simTime: +s.simTime.toFixed(1), rate: +(dS / dW).toFixed(3),
    fps: +(s.t.length / dW).toFixed(1), total: T, simMs: S, rndMs: R, storm: s.storm, gar: s.gar,
    inside: s.inside, held: s.held, alive: s.alive, scale: s.scale, press: s.press });
  console.log(`${String(((nowWall - wall0) / 1000).toFixed(0)).padStart(6)}  ${s.simTime.toFixed(0).padStart(4)}  ${(dS / dW).toFixed(3)}x  ${(s.t.length / dW).toFixed(1).padStart(5)}`
    + `  ${String(T.p50).padStart(6)} ${String(T.p90).padStart(6)}  ${String(S.p50).padStart(6)} ${String(R.p50).padStart(6)}`
    + `  ${String(s.storm).padStart(9)} ${String(s.gar).padStart(7)} ${String(s.inside).padStart(6)}  ${String(s.alive).padStart(5)}  ${s.scale}  ${s.press}  ${s.advP90}`);
  if (s.simTime >= UNTIL || s.over || (nowWall - wall0) / 1000 > MAXWALL) {
    console.log(s.over ? 'battle over' : s.simTime >= UNTIL ? 'reached sim target' : 'wall budget exhausted');
    break;
  }
}
console.log(`TOTAL: ${((Date.now() - wall0) / 1000).toFixed(1)}s wall to sim t+${lastSim.toFixed(0)}  => ${(lastSim / ((Date.now() - wall0) / 1000)).toFixed(3)}x overall`);
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify({ url, boot: BOOT, quality: Q, w: W, h: H, samples, errors }, null, 1));
if (errors.length) console.log('ERRORS:', errors.slice(0, 8));
await browser.close();
