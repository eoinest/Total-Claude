#!/usr/bin/env node
/**
 * Drive the full-scale Carthage storm to a decision, and time it.
 *
 * The thing no agent had done: `probe-siegehud` gave up at t+451 after 35 minutes with the
 * storm undecided. This uses the renderless fast-forward, which is the same battle by hash.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5788);
const CAP = Number(args.get('cap') ?? 2400);
const CHUNK = Number(args.get('chunk') ?? 20);
const Q = args.get('quality') ?? 'high';
const load = () => { try { const m = execFileSync('uptime', { encoding: 'utf8' }).match(/load averages?:\s*([\d.]+)/); return m ? +m[1] : null; } catch { return null; } };
const url = `http://127.0.0.1:${PORT}/?menu=0&map=carthage&scenario=assault&autoplay=1&quality=${Q}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
console.log(`url: ${url}   load ${load()}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await page.evaluate(() => window.__game.engine.stop());
console.log('men:', await page.evaluate(() => window.__game.battle.units.reduce((a, u) => a + u.alive, 0)));
const t0 = Date.now();
let last = '';
for (let t = CHUNK; t <= CAP; t += CHUNK) {
  await page.evaluate((s) => window.__game.fastForward(s), CHUNK);
  const s = await page.evaluate(() => {
    const g = window.__game, e = g.engine, b = g.battle;
    const flow = e.context.tryGet('battleFlow');
    const o = flow?.objective ?? null;
    let alive = 0; const p = b.pool;
    for (let i = 0; i < p.count; i++) if (p.aliveAt(i)) alive++;
    return { t: +g.simTime().toFixed(0), alive, strength: { ...b.strength }, over: !!flow?.over,
      phase: flow?.phase ?? null, winner: flow?.winner ?? null,
      storm: o?.stormOnWall ?? null, hold: o?.stormHolding ?? null, held: o?.heldFor ?? null,
      inside: o?.stormInside ?? null, gar: o?.garrisonOnWall ?? null };
  });
  const key = `${s.phase}|${s.hold}|${Math.round((s.held ?? 0) / 5)}`;
  if (key !== last || t % 100 === 0) {
    last = key;
    console.log(`  t+${String(s.t).padStart(4)}  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s wall`
      + `  alive ${s.alive}  R ${s.strength[0]} C ${s.strength[2]}  onWall ${s.storm}/${s.gar}`
      + `  holding ${s.hold} for ${(s.held ?? 0).toFixed(0)}s  inside ${s.inside}  phase ${s.phase}`);
  }
  if (s.over) {
    console.log(`\nDECIDED at t+${s.t} after ${((Date.now() - t0) / 1000).toFixed(1)}s of wall clock`
      + `  =>  ${(s.t / ((Date.now() - t0) / 1000)).toFixed(2)}x realtime   winner ${s.winner}  phase ${s.phase}`);
    break;
  }
  if (t >= CAP) console.log(`\nundecided at the t+${CAP} cap after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
console.log('load after:', load());
if (errors.length) console.log('ERRORS:', errors.slice(0, 5));
await browser.close();
