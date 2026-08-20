#!/usr/bin/env node
/** Escalade throughput and the rout precondition, sampled over the assault. */
import { chromium } from 'playwright';
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const PORT = Number(arg('port', 5487));
const MAP = arg('map', '');
const LABEL = arg('label', 'run');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&scenario=assault&autoplay=1&quality=low${MAP ? `&map=${MAP}` : ''}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
const r = await page.evaluate(`(() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  g.engine.stop();
  const F = 1/30, tick = () => g.engine.advance(F, 1000/30);
  const rows = [];
  for (let t = 0; t <= 60; t += 2) {
    while (g.engine.time.simTime < t) tick();
    const banks = new Map();
    for (const l of s.ladders) { const a = banks.get(l.unitId) ?? []; a.push(l); banks.set(l.unitId, a); }
    const out = [];
    for (const [uid, group] of banks) {
      const u = b.unitById(uid); if (!u) continue;
      let foot = 0, wall = 0, climb = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        if (s.stationOf[i] >= 0) { wall++; continue; }
        if (s.crossOf[i] !== -1) { climb++; continue; }
        for (const l of group) if (Math.hypot(p.x[i]-l.x, p.z[i]-l.z) < 25) { foot++; break; }
      }
      out.push([uid, foot, climb, wall, s.isGarrisoned(uid)?1:0, u.order, u.alive]);
    }
    const crossed = s.ladders.reduce((a,l)=>a+l.crossed,0);
    rows.push({ t: +g.engine.time.simTime.toFixed(0), crossed, banks: out });
  }
  return rows;
})()`);
console.log(`--- ${LABEL} (pageerrors ${errs.length}) ---`);
console.log('t   crossed   [uid foot climb wall garr order alive] per bank');
for (const row of r) console.log(String(row.t).padStart(3), String(row.crossed).padStart(5), '  ', row.banks.map(x=>x.join('/')).join('  '));
await browser.close();
