#!/usr/bin/env node
/**
 * Reproduce the reported "~0.1x realtime" exactly as `probe-siegehud.mjs` measures it:
 * `?menu=0&map=carthage&scenario=assault&autoplay=1&quality=high`, 1600x900, and a loop of
 * `window.__game.advance(20)` with a 180 ms settle and a state read between steps.
 *
 * Times each step separately so the degradation curve is visible rather than an average.
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5788);
const LIMIT = Number(args.get('limit') ?? 460);
const STEP = Number(args.get('step') ?? 20);
const BOOT = args.get('boot') ?? 'menu0';       // menu0 | harness
const Q = args.get('quality') ?? 'high';
const HUD = args.get('hud') ?? 'on';            // off = display:none the HUD root
const SETTLE = Number(args.get('settle') ?? 180);
const W = Number(args.get('w') ?? 1600), H = Number(args.get('h') ?? 900);
const ADAPT = args.get('adaptive') ?? null;   // 'off'
const STEPMS = Number(args.get('stepms') ?? 0);  // 0 = __game.advance default (1000/60)
const base = `http://127.0.0.1:${PORT}`;
const url = BOOT === 'harness'
  ? `${base}/?harness=1&autoplay=1&w=${W}&h=${H}&map=carthage&scenario=assault&quality=${Q}`
  : `${base}/?menu=0&map=carthage&scenario=assault&autoplay=1&quality=${Q}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
console.log('url:', url, ' hud:', HUD);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await page.waitForTimeout(1500);
if (ADAPT === 'off') await page.evaluate(() => { window.__game.engine.adaptiveQuality.enabled = false; });
if (HUD === 'off') await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
const boot = await page.evaluate(() => {
  const b = window.__game.battle, e = window.__game.engine;
  return { units: b.units.length, men: b.units.reduce((a, u) => a + u.alive, 0), scale: b.unitSizeScale,
    tier: e.quality.tier, poolCap: window.__game.battle.pool.capacity, adaptive: e.adaptiveQuality.enabled,
    drawing: [e.renderer.domElement.width, e.renderer.domElement.height] };
});
console.log('boot:', JSON.stringify(boot));
// Time each advance separately, with the same in-page split Engine already records.
await page.evaluate(() => {
  const e = window.__game.engine;
  const orig = e.frame.bind(e);
  window.__acc = { n: 0, sim: 0, rnd: 0, total: 0, worst: 0 };
  e.frame = (nowMs) => {
    const t = performance.now(); orig(nowMs); const d = performance.now() - t;
    const a = window.__acc; a.n++; a.total += d; a.sim += e.lastSimMs; a.rnd += e.lastRenderMs;
    if (d > a.worst) a.worst = d;
  };
});
console.log('  t     wall(s)  rate   frames  ms/frame  sim%  rnd%  worst   onWall  alive  scale press');
for (let t = 0; t < LIMIT; t += STEP) {
  await page.evaluate(() => { const a = window.__acc; a.n = a.sim = a.rnd = a.total = a.worst = 0; });
  const w0 = Date.now();
  await page.evaluate(([s, ms]) => (ms ? window.__game.engine.advance(s, ms) : window.__game.advance(s)), [STEP, STEPMS]);
  const wall = (Date.now() - w0) / 1000;
  await page.waitForTimeout(SETTLE);
  const s = await page.evaluate(() => {
    const g = window.__game, e = g.engine, b = g.battle, sg = b.siege, p = b.pool;
    let onWall = 0, alive = 0;
    for (let i = 0; i < p.count; i++) { if (!p.aliveAt(i)) continue; alive++; if (sg.crossOf[i] === -1 && sg.stationOf[i] >= 0) onWall++; }
    const flow = e.context.tryGet('battleFlow');
    return { t: +g.simTime().toFixed(0), onWall, alive, acc: { ...window.__acc },
      scale: +e.quality.renderScale.toFixed(2), press: +(e.adaptiveQuality.state().pressure ?? 0).toFixed(2),
      obj: flow?.objective ? { storm: flow.objective.stormOnWall, gar: flow.objective.garrisonOnWall } : null,
      over: !!flow?.over };
  });
  const a = s.acc;
  console.log(`t+${String(s.t).padStart(4)}  ${wall.toFixed(1).padStart(6)}  ${(STEP / wall).toFixed(3)}x  ${String(a.n).padStart(6)}`
    + `  ${(a.total / Math.max(1, a.n)).toFixed(2).padStart(8)}  ${(a.sim / Math.max(1, a.total) * 100).toFixed(0).padStart(4)}`
    + `  ${(a.rnd / Math.max(1, a.total) * 100).toFixed(0).padStart(4)}  ${a.worst.toFixed(0).padStart(5)}`
    + `  ${String(s.obj ? s.obj.storm : s.onWall).padStart(6)}  ${String(s.alive).padStart(5)}  ${s.scale} ${s.press}`);
  if (s.over) { console.log('battle over'); break; }
}
if (errors.length) console.log('ERRORS:', errors.slice(0, 8));
await browser.close();
