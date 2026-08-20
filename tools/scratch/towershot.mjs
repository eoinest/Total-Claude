#!/usr/bin/env node
/** Scratch: photograph a file of men crossing a tower, both maps. */
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5407);
const OUT = args.get('out') ?? 'screenshots/towerpass';
const base = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });

async function shoot(map, tag) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`${base}/?harness=1&autoplay=0&quality=high&w=1280&h=720&scenario=assault${map ? `&map=${map}` : ''}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 150000 });
  const info = await page.evaluate(() => {
    const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
    const city = g.engine.context.get('city');
    g.engine.stop();
    g.advance(2);
    const step = () => g.engine.advance(1 / 30, 1000 / 30);
    const bays = city.getGarrisonBays();
    const mid = (q) => ({ x: (q.x0 + q.x1) * 0.5, z: (q.z0 + q.z1) * 0.5 });
    const gate = bays.find((q) => q.isGate) ?? bays[Math.floor(bays.length / 2)];
    const gc = mid(gate);
    let u = null, far = -1;
    for (const q of b.units) {
      if (q.destroyed || q.alive < 20 || !s.isGarrisoned(q.id) || s.plans.has(q.id)) continue;
      const d = Math.hypot(q.x - gc.x, q.z - gc.z);
      if (d > far) { far = d; u = q; }
    }
    if (!u) return { fail: 'no garrison' };
    let here = 0, bd = Infinity;
    for (let k = 0; k < bays.length; k++) {
      const c = mid(bays[k]); const d = (c.x - u.x) ** 2 + (c.z - u.z) ** 2;
      if (d < bd) { bd = d; here = k; }
    }
    const away = here > bays.indexOf(gate) ? 1 : -1;
    let target = null;
    for (const off of [away * 4, away * 3, -away * 4, -away * 3]) {
      const q = bays[here + off];
      if (q && q.garrisonable) { target = q; break; }
    }
    const c = mid(target);
    g.engine.events.emit('orderIssued', { unitIds: [u.id], kind: 'move', x: c.x, z: c.z });
    // Run until somebody is actually on a tower pass, then park.
    let onLinkAt = -1, cx = 0, cz = 0, cy = 0;
    for (let n = 0; n < 90 * 30; n++) {
      step();
      let k = -1;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        if (s.crossOf[i] !== -1 && s.linkOf[i] >= 0 && s.links[s.linkOf[i]].kind === 0) { k = i; break; }
      }
      if (k >= 0) { onLinkAt = n / 30; cx = p.x[k]; cy = p.y[k]; cz = p.z[k]; break; }
    }
    // A few more ticks so a file has formed behind him.
    for (let n = 0; n < 60; n++) step();
    let onLink = 0;
    for (const i of u.members) if (p.aliveAt(i) && s.crossOf[i] !== -1) onLink++;
    return { unitId: u.id, onLinkAt, cx, cy, cz, onLink, alive: u.alive };
  });
  if (info.fail) { await page.close(); return { ...info, errs }; }
  await page.addStyleTag({ content: '#hud-root, #loading, #menu-root { display: none !important; }' });
  await page.evaluate(() => {
    const hud = window.__game?.engine?.context?.tryGet?.('hud');
    if (hud && hud.overlay) hud.overlay.visible = false;
  });
  // Three framings around the crossing point, with the focus pinned at walkway height so
  // the RTS rig does not float it back down to the terrain between frames.
  const nrm = await page.evaluate(([x, z]) => {
    const city = window.__game.engine.context.get('city');
    const bays = city.getGarrisonBays();
    let best = bays[0], bd = Infinity;
    for (const q of bays) {
      const mx = (q.x0 + q.x1) * 0.5, mz = (q.z0 + q.z1) * 0.5;
      const d = (mx - x) ** 2 + (mz - z) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    return { nx: best.nx, nz: best.nz };
  }, [info.cx, info.cz]);
  // Camera stands on the city side (eye = focus - dir * r, so dir = outward normal).
  const cityYaw = Math.atan2(nrm.nx, nrm.nz);
  const shots = [
    { name: 'along', zoom: 0.45, yaw: cityYaw + 1.05, dy: -1.5 },
    { name: 'oblique', zoom: 0.45, yaw: cityYaw - 1.05, dy: -1.5 },
    { name: 'city', zoom: 0.44, yaw: cityYaw, dy: -1.5 },
  ];
  for (const sh of shots) {
    await page.evaluate(([x, z, y, zoom, yaw]) => {
      const rig = window.__game.engine.rig;
      if (!rig.__oldH) rig.__oldH = rig.heightAt;
      rig.heightAt = () => y;
      window.__game.setCamera(x, z, zoom, yaw);
      for (let k = 0; k < 6; k++) window.__game.engine.advance(0, 16);
    }, [info.cx, info.cz, info.cy + sh.dy, sh.zoom, sh.yaw]);
    await page.screenshot({ path: `${OUT}/${tag}-${sh.name}.png` });
  }
  await page.close();
  return { ...info, errs };
}

console.log('ROME', JSON.stringify(await shoot('', 'rome')));
console.log('CARTHAGE', JSON.stringify(await shoot('carthage', 'carthage')));
await browser.close();
