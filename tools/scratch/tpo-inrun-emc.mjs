/** Read-only isolation: a traverse inside one run, and a traverse across runs. */
import { argsOf, boot, fast, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const { browser, page, errs } = await boot({
  port: Number(A.get('port') ?? 5613), map: 'carthage',
  out: path.join(ROOT, 'screenshots/tpo'), label: 'tpo-inrun',
});
await page.click('.dep-begin'); await page.waitForTimeout(600);
await fast(page, 290);

const map = await page.evaluate(() => {
  const s = window.__siege(); const u = window.__game.battle.unitById(14);
  const here = s.stationNear(u.x, u.z);
  const run = s.sRun[here];
  // Every station on this unit's own run, and the bays it covers.
  let lo = -1, hi = -1;
  for (let i = 0; i < s.nStations; i++) if (s.sRun[i] === run) { if (lo < 0) lo = i; hi = i; }
  return { here, run, lo, hi, bayLo: s.sBay[lo], bayHi: s.sBay[hi],
    x: +u.x.toFixed(1), z: +u.z.toFixed(1),
    loXZ: [+s.sx[lo].toFixed(1), +s.sz[lo].toFixed(1)],
    hiXZ: [+s.sx[hi].toFixed(1), +s.sz[hi].toFixed(1)] };
});
console.log('own run:', JSON.stringify(map));

for (const which of ['far end of the same run', 'a connected run three bays away']) {
  const st = await page.evaluate(([m, inRun]) => {
    const s = window.__siege();
    if (inRun) return Math.abs(m.hi - m.here) > Math.abs(m.lo - m.here) ? m.hi : m.lo;
    // first station of a different, connected run
    for (let i = 0; i < s.nStations; i++) {
      if (s.sRun[i] !== m.run && s.traverseOfferAt(14, s.sx[i], s.sz[i]).ok) return i;
    }
    return -1;
  }, [map, which.includes('same run')]);
  const r = await page.evaluate((station) => {
    const s = window.__siege(); const u = window.__game.battle.unitById(14);
    const ok = s.moveAlongWall(u, s.sx[station], s.sz[station]);
    return { station, destRun: s.sRun[station], destBay: s.sBay[station], ok,
      at: [+u.x.toFixed(1), +u.z.toFixed(1)] };
  }, st);
  const t0 = await page.evaluate(() => window.__wallState(14));
  await fast(page, 4);
  const t1 = await page.evaluate(() => ({ ws: window.__wallState(14), u: window.__u(14) }));
  await fast(page, 40);
  const t2 = await page.evaluate(() => ({ ws: window.__wallState(14), u: window.__u(14) }));
  console.log(`\n--- ${which}: ${JSON.stringify(r)}`);
  console.log('  at the call :', JSON.stringify({ goal: t0.goal, destRun: t0.destRun, runs: t0.runs }));
  const f = (t) => ({ goal: t.ws.goal, age: t.ws.planAge, runs: t.ws.runs, stuck: t.ws.stuck,
    onWall: t.ws.onWall, onLink: t.ws.onLink, onGround: t.ws.onGround,
    at: [t.u.x, t.u.z], alive: t.u.alive });
  console.log('  +4 s        :', JSON.stringify(f(t1)));
  console.log('  +44 s       :', JSON.stringify(f(t2)));
}
console.log('\npageerrors', errs.length);
await browser.close();
