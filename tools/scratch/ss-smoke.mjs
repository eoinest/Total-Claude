#!/usr/bin/env node
/** siege-scale smoke: boot the Carthage assault, report order of battle and a t+0 frame split. */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5788);
const AT = Number(args.get('at') ?? 0);
const url = `http://localhost:${PORT}/?harness=1&autoplay=1&w=1920&h=1080`
  + `&map=carthage&enemy=carthage&scenario=assault&quality=ultra`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
console.log('url:', url);
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const boot = await page.evaluate(() => {
  const g = window.__game, e = g.engine, b = g.battle;
  const keys = Object.keys(b);
  return {
    tier: e.quality.tier, maxSoldiers: e.quality.maxSoldiers,
    strength: b.strength, simTime: g.simTime(),
    systems: e.systems.map((s) => s.name),
    battleKeys: keys.slice(0, 80),
  };
});
console.log('tier', boot.tier, 'maxSoldiers', boot.maxSoldiers, 'simTime', boot.simTime);
console.log('strength', JSON.stringify(boot.strength), 'total', Object.values(boot.strength ?? {}).reduce((a, b) => a + b, 0));
console.log('systems:', boot.systems.join(' '));
console.log('battle keys:', boot.battleKeys.join(' '));
if (AT > 0) {
  const w0 = Date.now();
  await page.evaluate((t) => window.__game.advance(t), AT);
  console.log(`advance(${AT}) took ${((Date.now() - w0) / 1000).toFixed(1)}s wall  => ${(AT / ((Date.now() - w0) / 1000)).toFixed(3)}x`);
}
// Real-time window: 6 s of rAF, record sim advance and phase split.
const res = await page.evaluate(async () => {
  const e = window.__game.engine;
  const orig = e.frame.bind(e);
  const systems = e.systems;
  const names = systems.map((s) => s.name);
  const nS = names.length;
  const sumFix = new Float64Array(nS), sumUpd = new Float64Array(nS), sumPre = new Float64Array(nS);
  let accFix = 0, accUpd = 0, accPre = 0, accRnd = 0, ticks = 0;
  const unwrap = [];
  systems.forEach((s, i) => {
    if (s.fixedUpdate) { const f = s.fixedUpdate.bind(s); unwrap.push(() => { s.fixedUpdate = f; });
      s.fixedUpdate = (dt, ctx) => { const t = performance.now(); f(dt, ctx); const d = performance.now() - t; accFix += d; sumFix[i] += d; }; }
    if (s.update) { const f = s.update.bind(s); unwrap.push(() => { s.update = f; });
      s.update = (dt, ctx) => { const t = performance.now(); f(dt, ctx); const d = performance.now() - t; accUpd += d; sumUpd[i] += d; }; }
    if (s.preRender) { const f = s.preRender.bind(s); unwrap.push(() => { s.preRender = f; });
      s.preRender = (ctx) => { const t = performance.now(); f(ctx); const d = performance.now() - t; accPre += d; sumPre[i] += d; }; }
  });
  if (e.renderOverride) { const ro = e.renderOverride; unwrap.push(() => { e.renderOverride = ro; });
    e.renderOverride = (ctx) => { const t = performance.now(); ro(ctx); accRnd += performance.now() - t; }; }
  const frames = [];
  e.frame = (nowMs) => { const t = performance.now(); orig(nowMs); frames.push([performance.now() - t, e.time.ticksThisFrame, accFix, accUpd, accPre, accRnd]); accFix = accUpd = accPre = accRnd = 0; };
  const simA = e.time.simTime, wallA = performance.now();
  await new Promise((r) => setTimeout(r, 8000));
  const simB = e.time.simTime, wallB = performance.now();
  e.frame = orig; unwrap.forEach((u) => u());
  const totals = frames.map((f) => f[0]);
  const st = (a) => { const s = [...a].sort((x, y) => x - y); const q = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))]; return { n: s.length, p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
  const sum = (k) => frames.reduce((a, f) => a + f[k], 0);
  ticks = frames.reduce((a, f) => a + f[1], 0);
  const per = names.map((n, i) => [n, +(sumFix[i]).toFixed(1), +(sumUpd[i]).toFixed(1), +(sumPre[i]).toFixed(1)]);
  per.sort((a, b) => (b[1] + b[2] + b[3]) - (a[1] + a[2] + a[3]));
  return {
    simRate: (simB - simA) / ((wallB - wallA) / 1000), frames: frames.length, ticks,
    wallMs: +(wallB - wallA).toFixed(0), simAdv: +(simB - simA).toFixed(2),
    total: st(totals), fixedTotalMs: +sum(2).toFixed(0), updTotalMs: +sum(3).toFixed(0),
    preTotalMs: +sum(4).toFixed(0), rndTotalMs: +sum(5).toFixed(0),
    msPerTick: +(sum(2) / Math.max(1, ticks)).toFixed(2),
    per: per.slice(0, 14),
  };
});
console.log(JSON.stringify(res, null, 1));
if (errors.length) console.log('ERRORS:', errors.slice(0, 10));
await browser.close();
