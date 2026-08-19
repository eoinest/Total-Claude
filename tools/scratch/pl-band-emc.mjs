/** Does the box the cursor ray hits overlap the band `wallTargetAt` accepts? */
import { argsOf, boot, fast, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const MAP = A.get('map') ?? 'carthage';
const { browser, page } = await boot({ port: Number(A.get('port') ?? 5431), map: MAP, out: path.join(ROOT, 'screenshots/playability'), label: 'band' });
await page.click('.dep-begin'); await page.waitForTimeout(400);
await fast(page, 4);
const res = await page.evaluate(() => {
  const c = window.__ctl(), s = window.__siege(), city = window.__city();
  const bays = city.getGarrisonBays();
  const sol = c.pickSolids;
  const rows = [];
  for (const b of bays) {
    if (!b.garrisonable) continue;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    let best = null, bd = 1e9;
    for (const o of sol) { const d = Math.hypot(o.x - cx, o.z - cz); if (d < bd) { bd = d; best = o; } }
    if (!best || bd > 20) continue;
    // Sample offsets along the bay's outward normal from the bay line.
    const line = [];
    for (let off = -5; off <= 6; off += 0.5) {
      const x = cx + b.nx * off, z = cz + b.nz * off;
      line.push([+off.toFixed(1), s.wallTargetAt(x, z) >= 0 ? 1 : 0]);
    }
    const ok = line.filter(l => l[1]).map(l => l[0]);
    // The box's near and far faces along the same normal.
    const boxOffNear = ((best.x - b.towerHalf * 0) - cx) * b.nx + (best.z - cz) * b.nz;
    rows.push({ i: b.index, outerOff: +b.outerOff.toFixed(2), innerOff: +b.innerOff.toFixed(2),
      boxOff: +boxOffNear.toFixed(2), boxHd: +best.hd.toFixed(2), boxTopY: +best.topY.toFixed(2), walkY: +b.walkY.toFixed(2),
      accept: ok.length ? `${Math.min(...ok)}..${Math.max(...ok)}` : 'none',
      faceOff: +(boxOffNear + best.hd).toFixed(2) });
  }
  return { n: sol.length, rows: rows.slice(0, 70) };
});
console.log('pick solids', res.n);
console.log('bay  outerOff innerOff | boxCentreOff boxHalfD boxFace | accepted band | walkY boxTopY');
for (const r of res.rows) console.log(`${String(r.i).padStart(3)}  ${String(r.outerOff).padStart(6)} ${String(r.innerOff).padStart(7)} | ${String(r.boxOff).padStart(9)} ${String(r.boxHd).padStart(6)} ${String(r.faceOff).padStart(6)} | ${r.accept.padStart(12)} | ${r.walkY} ${r.boxTopY}`);
await browser.close();
