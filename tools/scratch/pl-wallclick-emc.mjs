/** From the player's own camera, how much of the wall answers to a right-click? */
import { argsOf, boot, cam, shot, proj, aim, fast, selectUnit, leftClick, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const MAP = A.get('map') ?? 'carthage';
const SIDE = A.get('side') === 'in' ? -1 : 1;
const FOCUSDY = Number(A.get('dy') ?? 0);
const OUT = path.join(ROOT, 'screenshots/playability');
const { browser, page } = await boot({ port: Number(A.get('port') ?? 5431), map: MAP, out: OUT, label: `wc-${MAP}` });
await page.mouse.move(800, 700); await page.waitForTimeout(300);
await page.click('.dep-begin'); await page.waitForTimeout(400);
await fast(page, 4);
await page.evaluate(() => {
  window.__diag = () => {
    const c = window.__ctl(), s = window.__siege();
    return { st: c.storming, wv: c.wallValid, sv: c.solidValid, sy: +c.solidY.toFixed(2),
      sx: +c.solidX.toFixed(2), sz: +c.solidZ.toFixed(2), ta: s.wallTargetAt(c.solidX, c.solidZ),
      cur: document.body.dataset.cur, sel: c.model.selection.length, hov: c.model.hoveredId };
  };
  window.__solidsNear = (x, z, r) => window.__ctl().pickSolids.filter(o => Math.hypot(o.x - x, o.z - z) < r)
    .map(o => ({ x: +o.x.toFixed(1), z: +o.z.toFixed(1), hw: +o.hw.toFixed(2), hd: +o.hd.toFixed(2), rot: +o.rot.toFixed(2), topY: +o.topY.toFixed(2), baseY: +(o.baseY ?? 0).toFixed(2) }));
});
const bays = await page.evaluate(() => window.__bays());
const garr = bays.filter(b => b.garr);
const mid = garr[Math.floor(garr.length / 2)];
const b = bays.find(x => Math.abs(x.cx - mid.cx) < 16) ?? mid;
console.log('map', MAP, 'bay', JSON.stringify(b));
console.log('solids within 25 m of the bay:', JSON.stringify(await page.evaluate(([x, z]) => window.__solidsNear(x, z, 25), [b.cx, b.cz])));

// Pick the unit a player would use: nearest own unit that is not on the wall, else any own unit.
const own = await page.evaluate(() => window.__units(0));
const cand = own.filter(u => u.alive > 20).sort((p, q) => Math.abs(p.x - b.cx) - Math.abs(q.x - b.cx));
let chosen = null;
for (const u of cand.slice(0, 4)) {
  const r = await selectUnit(page, u.id, { zoom: 0.55 });
  console.log('  try select', u.id, u.type, r.ok ? 'OK' : `FAILED sel=${JSON.stringify(r.sel)}`);
  if (r.ok) { chosen = u; break; }
}
if (!chosen) { console.log('!! could not select anything'); await browser.close(); process.exit(0); }
console.log('selected', chosen.id, chosen.type, 'storming=', (await page.evaluate(() => window.__diag())).st);

for (const [name, zoom] of [['close 0.42', 0.42], ['battle 0.52', 0.52], ['wide 0.66', 0.66]]) {
  // Frame the parapet in the middle of the screen, clear of the HUD, from the player's side.
  const anchor = await aim(page, b.cx, b.walkY, b.cz + b.nz * 3.5 * SIDE, { zoom, yaw: SIDE > 0 ? 0 : Math.PI, wy: 430 });
  if (!anchor) { console.log(`${name}: could not frame the bay`); continue; }
  const box = await page.evaluate(([cx, cz, nx, nz, walk, crest, grd, len, side]) => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, n = 0;
    for (const alo of [-len / 2, 0, len / 2]) for (const off of [3.5 * side, 4.5 * side, 0]) for (const y of [grd + 1, (grd + walk) / 2, walk, crest]) {
      const p = window.__P(cx - nz * alo + nx * off, y, cz + nx * alo + nz * off);
      if (!p) continue; n++; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    return { n, x0, x1, y0, y1 };
  }, [b.cx, b.cz, b.nx, b.nz, b.walkY, b.crestY, b.groundY, b.len, SIDE]);
  let hits = 0, tot = 0, kinds = {}, ui = 0;
  const lines = [];
  for (let j = 0; j < 9; j++) {
    const y = Math.round(box.y0 + (box.y1 - box.y0) * j / 8);
    let row = '';
    for (let i = 0; i < 13; i++) {
      const x = Math.round(box.x0 + (box.x1 - box.x0) * i / 12);
      if (x < 4 || x > 1596 || y < 4 || y > 896) { row += ' '; continue; }
      await page.mouse.move(x, y); await page.waitForTimeout(38);
      const d = await page.evaluate(() => ({ ...window.__diag(), ui: window.__cur().overUi }));
      tot++; kinds[d.cur] = (kinds[d.cur] ?? 0) + 1; if (d.ui) ui++;
      if (d.ui) row += 'U'; else if (d.wv) { row += 'W'; hits++; } else row += d.sv ? (d.ta >= 0 ? 't' : '.') : '_';
    }
    lines.push(`  y=${String(y).padStart(4)} ${row}`);
  }
  console.log(`${name}: wall box x ${Math.round(box.x0)}..${Math.round(box.x1)} y ${Math.round(box.y0)}..${Math.round(box.y1)}`);
  for (const l of lines) console.log(l);
  console.log(`  wallValid ${hits}/${tot}   over-HUD ${ui}   cursors ${JSON.stringify(kinds)}`);
  await shot(page, OUT, `wc-${MAP}-${SIDE > 0 ? 'out' : 'in'}-${name.replace(/[ .]/g, '')}`);
}
await browser.close();
